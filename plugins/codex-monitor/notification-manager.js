import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createCompletionNotifications, completionToast, completionMarkdown } from './notifications.js'

const CHANNEL_LABELS = { weixin: '微信', feishu: '飞书', qq: 'QQ', telegram: 'Telegram', dingtalk: '钉钉', wecom: '企业微信' }
const IM_ERRORS = {
  'bot-not-connected': '机器人未连接，请在 IM 机器人设置中恢复连接',
  'unknown-bot': '机器人已移除，请重新选择',
  'unknown-target': '接收目标已移除，请重新选择',
  'target-rejected': '平台拒绝接收目标，请检查 IM 设置',
  'delivery-failed': 'IM 发送失败，请查看机器人最近消息错误；微信可先给机器人发一条消息再测试',
  'send-result-unknown': 'IM 发送结果未确认，请先检查手机是否收到，避免重复发送',
  cancelled: 'IM 通知已取消'
}

function imErrorMessage(error) {
  let cause = error
  let rejected = false
  let providerCode = null
  for (let depth = 0; cause && depth < 6; depth++, cause = cause.cause) {
    rejected ||= cause.code === 'send-rejected'
    const code = String(cause.providerCode ?? '')
    if (/^[A-Za-z0-9._-]{1,32}$/.test(code)) providerCode = code
  }
  // Preserve the structured platform rejection without exposing a nested
  // request URL, recipient route, token, or arbitrary provider response body.
  if (rejected) return `IM 平台拒绝发送${providerCode ? `（错误码 ${providerCode}）` : ''}；请查看机器人最近消息错误。微信接收者可先发一条消息，再手动测试。`
  return IM_ERRORS[error.code] || error.message || 'IM 发送失败'
}

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['windowsEnabled', 'imEnabled', 'botId', 'targetId'].includes(key))
    || typeof value.windowsEnabled !== 'boolean' || typeof value.imEnabled !== 'boolean'
    || typeof value.botId !== 'string' || typeof value.targetId !== 'string'
    || (value.botId && !/^[A-Za-z0-9_-]{1,128}$/.test(value.botId))
    || (value.targetId && !/^[A-Za-z0-9._:@-]{1,128}$/.test(value.targetId))
    || (value.imEnabled && (!value.botId || !value.targetId))) {
    throw Object.assign(new Error('通知设置无效；启用 IM 时必须选择机器人和接收目标'), { status: 400 })
  }
  return { windowsEnabled: value.windowsEnabled, imEnabled: value.imEnabled, botId: value.botId, targetId: value.targetId }
}

// Bound discovery and delivery, and propagate timeout/unload cancellation to IM.
async function withDeadline(operation, parentSignal, timeoutMs) {
  const controller = new AbortController()
  const cancel = () => controller.abort(parentSignal?.reason || new Error('IM 通知已取消'))
  if (parentSignal?.aborted) cancel()
  parentSignal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('IM 请求超时，结果可能未确认，请勿连续重发')), timeoutMs)
  let rejectOnAbort
  try {
    return await Promise.race([
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal) }),
      new Promise((_resolve, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
        if (controller.signal.aborted) rejectOnAbort()
      })
    ])
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', rejectOnAbort)
  }
}

export async function createNotificationManager(options = {}) {
  const directory = options.directory || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'codex-monitor')
  const settingsFile = join(directory, 'notification-settings.json')
  const windowsSupported = (options.platform || process.platform) === 'win32'
  const timeoutMs = options.timeoutMs ?? 10_000
  const lifetime = new AbortController()
  let settings = { windowsEnabled: process.env.CODEX_MONITOR_NOTIFICATIONS !== '0', imEnabled: false, botId: '', targetId: '' }
  let settingsError = null
  try {
    settings = validateSettings(JSON.parse(await readFile(settingsFile, 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT') settingsError = '通知设置读取失败，请打开通知设置重新保存'
  }
  let imService = null
  let im = null
  let disposed = false
  let changes = Promise.resolve()
  const completionCache = new Map()
  let windows = makeWindows()

  async function payloadFor(session, { signal }, markdown = false) {
    const key = `${session.sessionId}:${session.observedAt}`
    if (!completionCache.has(key)) {
      const pending = withDeadline((readSignal) => options.readCompletion?.(session, { signal: readSignal }), lifetime.signal, options.detailTimeoutMs ?? 5000)
        .catch(() => null)
      completionCache.set(key, pending)
      while (completionCache.size > 8) completionCache.delete(completionCache.keys().next().value)
    }
    const details = await withDeadline(() => completionCache.get(key), signal, options.detailTimeoutMs ?? 5000).catch(() => null) || {}
    signal.throwIfAborted()
    const payload = completionToast(session, details)
    return markdown ? { ...payload, markdown: completionMarkdown(session, details) } : payload
  }

  function makeWindows() {
    return createCompletionNotifications({
      platform: options.platform, startedAt: options.startedAt, logger: options.logger,
      enabled: settings.windowsEnabled, file: join(directory, 'notification-history.json'), send: options.sendWindows,
      createPayload: (session, options) => payloadFor(session, options)
    })
  }

  function makeIm() {
    if (!imService || !settings.imEnabled) return null
    const service = imService
    const { botId, targetId } = settings
    const targetKey = createHash('sha256').update(`${botId}:${targetId}`).digest('hex').slice(0, 24)
    return createCompletionNotifications({
      supported: true, enabled: true, channelName: 'IM', startedAt: options.startedAt, logger: options.logger,
      file: join(directory, `notification-history-im-${targetKey}.json`),
      startFile: join(directory, `notification-history-im-start-${targetKey}.json`),
      createPayload: (session, options) => payloadFor(session, options, true),
      testPayload: { title: '会话看板 · 测试通知', body: 'IM 完成通知已接通。之后新的正常完成轮次会自动提醒。', tag: 'codex-test' },
      async send(payload, { signal }) {
        try {
          const text = payload.markdown || `${payload.title}\n${payload.body}`
          // IM owns channel-specific splitting. Allow bounded time for several
          // chunks without retrying a possibly partially delivered notification.
          const deliveryTimeoutMs = options.timeoutMs ?? Math.max(10000, Math.min(60000, Math.ceil(Array.from(text).length / 1800) * 5000))
          const result = await withDeadline((sendSignal) => service.send(botId, targetId, text, { signal: sendSignal, format: payload.markdown ? 'markdown' : 'plain' }), signal, deliveryTimeoutMs)
          if (result?.sent !== true) throw new Error('IM 未确认接收通知')
        } catch (error) {
          throw new Error(imErrorMessage(error))
        }
      }
    })
  }

  function enqueue(operation) {
    const result = changes.then(() => {
      if (disposed) throw new Error('通知服务已关闭')
      return operation()
    })
    changes = result.catch(() => {})
    return result
  }

  async function targets() {
    const service = imService
    if (!service) return []
    return withDeadline(async (signal) => {
      const bots = await service.listBots()
      const groups = await Promise.all(bots.map(async (bot) => {
        const saved = await service.listTargets(bot.botId)
        signal.throwIfAborted()
        // Platform routes and credentials stay in IM; the board only needs aliases.
        return saved.map((target) => ({ botId: bot.botId, targetId: target.targetId,
          label: `${CHANNEL_LABELS[bot.channel] || bot.channel} · ${target.name || target.targetId}` }))
      }))
      return groups.flat()
    }, lifetime.signal, timeoutMs)
  }

  function snapshot() {
    const windowsState = windows.snapshot()
    const imState = im?.snapshot() || { pending: 0, lastSentAt: null, lastError: null }
    const channels = {
      windows: { ...windowsState, enabled: settings.windowsEnabled && windowsSupported },
      im: { ...imState, supported: Boolean(imService), enabled: settings.imEnabled,
        configured: Boolean(settings.botId && settings.targetId),
        lastError: imState.lastError || (settings.imEnabled && !imService ? 'IM 插件服务暂不可用' : null) }
    }
    return { supported: windowsSupported || Boolean(imService), enabled: channels.windows.enabled || channels.im.enabled,
      pending: windowsState.pending + imState.pending, settings: { ...settings }, settingsError, channels }
  }

  return {
    snapshot,
    observe(session) { if (!disposed) { windows.observe(session); im?.observe(session) } },
    async configuration() { return { ...snapshot(), targets: await targets() } },
    setImService(service) {
      return enqueue(async () => {
        if (imService === service) return
        await im?.close()
        imService = service
        im = makeIm()
      })
    },
    configure(value) {
      return enqueue(async () => {
        const next = validateSettings(value)
        if (next.imEnabled) {
          if (!imService) throw Object.assign(new Error('IM 插件服务暂不可用'), { status: 503 })
          const saved = await targets()
          if (!saved.some((target) => target.botId === next.botId && target.targetId === next.targetId)) {
            throw Object.assign(new Error('接收目标不存在，请先在 IM 机器人设置中保存目标'), { status: 400 })
          }
        }
        const temporary = `${settingsFile}.${process.pid}-${process.hrtime.bigint()}.tmp`
        await mkdir(directory, { recursive: true })
        try {
          await writeFile(temporary, JSON.stringify(next) + '\n', { encoding: 'utf8', flag: 'wx' })
          await rename(temporary, settingsFile)
        } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error }) }
        const windowsChanged = settings.windowsEnabled !== next.windowsEnabled
        const imChanged = settings.imEnabled !== next.imEnabled || settings.botId !== next.botId || settings.targetId !== next.targetId
        if (windowsChanged) await windows.close()
        if (imChanged) await im?.close()
        settings = next
        settingsError = null
        if (windowsChanged) windows = makeWindows()
        if (imChanged) im = makeIm()
        return snapshot()
      })
    },
    async test() {
      await changes
      if (disposed) throw Object.assign(new Error('通知服务已关闭'), { status: 503 })
      const selected = []
      if (settings.windowsEnabled && windowsSupported) selected.push(['windows', windows])
      if (settings.imEnabled) selected.push(['im', im])
      if (!selected.length) throw Object.assign(new Error('请先开启至少一个可用的通知渠道'), { status: 400 })
      const results = await Promise.all(selected.map(async ([channel, sender]) => {
        try {
          if (!sender) throw new Error('IM 插件服务暂不可用')
          await sender.test()
          return { channel, sent: true }
        } catch (error) {
          return { channel, sent: false, error: String(error.message).slice(0, 240) }
        }
      }))
      return { accepted: results.every((result) => result.sent), results }
    },
    async waitForIdle() { await changes; await Promise.all([windows.waitForIdle(), im?.waitForIdle()]) },
    async close() {
      disposed = true
      lifetime.abort()
      await Promise.all([windows.close(), im?.close()])
      await changes
      // A settings update already in flight may have replaced a sender.
      await Promise.all([windows.close(), im?.close()])
      completionCache.clear()
    }
  }
}
