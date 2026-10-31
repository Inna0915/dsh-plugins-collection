export const name = 'codex-monitor'
export const inject = ['webServer']
import { validSessionId } from './session-common.js'

const REFRESH_INTERVAL_MS = 10_000

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

function sanitizeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/([A-Z]:\\[^\s"']+)/gi, '[local path]')
    .slice(0, 300)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', (chunk) => {
      if (rejected) return
      size += chunk.length
      if (size > 128 * 1024) {
        rejected = true
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
      if (size === 0) return resolve({})
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
        resolve(body)
      } catch (error) {
        reject(Object.assign(error, { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// 跨站页面可以不经 CORS 预检向本机发送 text/plain 的 POST；写接口只接受 JSON，
// 且浏览器带 Origin 时必须与 Host 同源。命令行等非浏览器调用不带 Origin，不受影响。
function sameSiteWriteError(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null
  const headers = req.headers || {}
  if (headers.origin !== undefined) {
    let sameHost = false
    try { sameHost = new URL(headers.origin).host === headers.host } catch {}
    if (!sameHost) return { status: 403, error: '拒绝跨站请求' }
  }
  if (!/^application\/json\b/i.test(String(headers['content-type'] || ''))) {
    return { status: 415, error: '请求必须是 application/json' }
  }
  return null
}

function register(ctx, path, handler) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const rejected = sameSiteWriteError(req)
      if (rejected) return sendJson(res, rejected.status, { ok: false, error: rejected.error })
      try {
        await handler(req, res)
      } catch (error) {
        if (res.headersSent) return
        sendJson(res, Number(error?.status) || 500, { ok: false, error: sanitizeError(error) })
      }
    }
  }), `codex-monitor: ${path}`)
}

async function createRuntime(ctx) {
  const [{ createSessionSource, defaults }, { createMonitor }, { createRecordStore }, { createNotificationManager }] = await Promise.all([
    import('./multi-session-source.js'),
    import('./monitor.js'),
    import('./record-store.js'),
    import('./notification-manager.js')
  ])
  const source = createSessionSource()
  const recordStore = createRecordStore()
  const notifications = await createNotificationManager({ logger: ctx.logger, readCompletion: source.readCompletion })
  const monitor = createMonitor(source, { ...defaults, recordStore, trackCompletedTurns: true, onSessionObserved: notifications.observe })
  monitor.requestDefault()
  return { source, recordStore, monitor, notifications }
}

export function apply(ctx) {
  ctx.logger.info('[codex-monitor] 宿主已加载')
  const runtimePromise = createRuntime(ctx).catch((error) => ({ error }))
  ctx.inject?.(['sessionQuery', 'sessions'], (sessionCtx) => {
    sessionCtx.effect(() => {
      let active = true
      runtimePromise.then(async (runtime) => {
        if (!active || runtime.error) return
        runtime.source.setDshContext(sessionCtx)
        await runtime.monitor.waitForIdle()
        if (active) runtime.monitor.requestDefault()
      }).catch((error) => ctx.logger.warn('[codex-monitor] DSH 会话接入失败：' + sanitizeError(error)))
      return async () => {
        active = false
        const runtime = await runtimePromise
        runtime.source?.setDshContext(null)
        runtime.monitor?.requestDefault()
      }
    }, 'codex-monitor: optional DSH session source')
  })
  // IM is optional: removing it must not unload the board or Windows notifications.
  ctx.inject?.(['dshIm'], (imCtx) => {
    imCtx.effect(() => {
      let active = true
      runtimePromise.then((runtime) => {
        if (active && !runtime.error) return runtime.notifications.setImService(imCtx.dshIm)
      }).catch((error) => ctx.logger.warn('[codex-monitor] IM 接入失败：' + sanitizeError(error)))
      return async () => {
        active = false
        const runtime = await runtimePromise
        await runtime.notifications?.setImService(null).catch(() => {})
      }
    }, 'codex-monitor: optional IM notifications')
  })

  register(ctx, '/codex-monitor/sessions', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const runtime = await runtimePromise
    if (runtime.error) {
      return sendJson(res, 503, {
        sessions: [],
        generatedAt: null,
        refreshing: false,
        window: { days: 7, limit: 30 },
        health: { index: 'degraded', rollout: 'degraded', records: 'degraded', lastError: sanitizeError(runtime.error) }
      })
    }
    sendJson(res, 200, { ...runtime.monitor.snapshot(), notifications: runtime.notifications.snapshot() })
  })

  register(ctx, '/codex-monitor/notifications/test', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    if (Object.keys(body).length > 0) return sendJson(res, 400, { ok: false, error: '测试通知不接受自定义内容' })
    const runtime = await runtimePromise
    if (runtime.error) return sendJson(res, 503, { ok: false, error: sanitizeError(runtime.error) })
    sendJson(res, 200, await runtime.notifications.test())
  })

  register(ctx, '/codex-monitor/notifications/settings', async (req, res) => {
    if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const runtime = await runtimePromise
    if (runtime.error) return sendJson(res, 503, { ok: false, error: sanitizeError(runtime.error) })
    if (req.method === 'GET') return sendJson(res, 200, await runtime.notifications.configuration())
    sendJson(res, 200, await runtime.notifications.configure(await readJsonBody(req)))
  })

  register(ctx, '/codex-monitor/refresh', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    const unknown = Object.keys(body).filter((key) => key !== 'sessionId')
    if (unknown.length > 0) return sendJson(res, 400, { ok: false, error: '请求包含未知字段' })
    if (Object.hasOwn(body, 'sessionId') && typeof body.sessionId !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'sessionId 必须是字符串' })
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId && !validSessionId(sessionId)) {
      return sendJson(res, 400, { ok: false, error: 'sessionId 格式无效' })
    }
    const runtime = await runtimePromise
    if (runtime.error) return sendJson(res, 503, { ok: false, error: sanitizeError(runtime.error) })
    if (sessionId) runtime.monitor.requestSession(sessionId)
    else runtime.monitor.requestDefault()
    sendJson(res, 202, { accepted: true, scope: sessionId ? 'session' : 'default' })
  })

  register(ctx, '/codex-monitor/dismiss-running', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    if (Object.keys(body).some((key) => !['sessionId', 'observedAt'].includes(key))
      || !validSessionId(body.sessionId)
      || typeof body.observedAt !== 'string' || !Number.isFinite(Date.parse(body.observedAt))) {
      return sendJson(res, 400, { ok: false, error: '必须提供会话 ID 和已确认中断轮次的 observedAt' })
    }
    const runtime = await runtimePromise
    if (runtime.error) return sendJson(res, 503, { ok: false, error: sanitizeError(runtime.error) })
    sendJson(res, 200, { dismissed: true, session: await runtime.monitor.dismissRunning(body.sessionId, body.observedAt) })
  })

  register(ctx, '/codex-monitor/review-completed', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    const unknown = Object.keys(body).filter((key) => key !== 'sessionId')
    if (unknown.length > 0) return sendJson(res, 400, { ok: false, error: '请求包含未知字段' })
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!validSessionId(sessionId)) {
      return sendJson(res, 400, { ok: false, error: 'sessionId 格式无效' })
    }
    const runtime = await runtimePromise
    if (runtime.error) return sendJson(res, 503, { ok: false, error: sanitizeError(runtime.error) })
    const session = await runtime.monitor.reviewCompleted(sessionId)
    sendJson(res, 200, { reviewed: true, session })
  })

  register(ctx, '/codex-monitor/review-all', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    const unknown = Object.keys(body).filter((key) => key !== 'sessionIds')
    if (unknown.length > 0 || !Array.isArray(body.sessionIds) || body.sessionIds.length > 1000
      || body.sessionIds.some((id) => !validSessionId(id))) {
      return sendJson(res, 400, { ok: false, error: 'sessionIds 必须是有效会话 ID 数组（最多 1000 条）' })
    }
    const runtime = await runtimePromise
    if (runtime.error) return sendJson(res, 503, { ok: false, error: sanitizeError(runtime.error) })
    sendJson(res, 200, await runtime.monitor.reviewAllCompleted(body.sessionIds))
  })


  register(ctx, '/codex-monitor/conversation', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    if (Object.keys(body).some((key) => !['sessionId', 'cursor'].includes(key))
      || !validSessionId(body.sessionId)
      || (body.cursor != null && (typeof body.cursor !== 'string' || body.cursor.length > 1024))) {
      return sendJson(res, 400, { ok: false, error: '会话 ID 或分页参数无效' })
    }
    const runtime = await runtimePromise
    if (runtime.error) return sendJson(res, 503, { ok: false, error: sanitizeError(runtime.error) })
    sendJson(res, 200, await runtime.source.readConversation(body.sessionId, body.cursor))
  })

  const timer = setInterval(async () => {
    const runtime = await runtimePromise
    if (!runtime.error) runtime.monitor.requestDefault()
  }, REFRESH_INTERVAL_MS)
  timer.unref?.()
  ctx.effect(() => async () => {
    clearInterval(timer)
    const runtime = await runtimePromise
    await runtime.monitor?.close()
    await runtime.notifications?.close()
  }, 'codex-monitor: refresh timer')
}
