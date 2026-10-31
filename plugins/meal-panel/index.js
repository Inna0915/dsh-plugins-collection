/**
 * Meal panel — Host half.
 *
 * Talks to the canteen ("饭点") HTTP API, keeps the user session cookie alive,
 * and exposes a same-origin JSON surface for the sidebar panel in the Client
 * half. The panel never calls the canteen host directly: the browser page runs
 * on loopback, so every request goes through these routes.
 */
import { promises as fsp, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLunchReminder } from './reminder.js'

/** Hard dependency: the HTTP carrier is how the Client half reaches this file. */
export const inject = ['webServer']

const VERSION = '1.0.0'
const API_PREFIX = '/meal/api'
const DEFAULT_BASE_URL = 'http://172.18.10.59:8081/app'
const SETTINGS_FILE = path.join(os.homedir(), '.dsh', 'meal-panel-settings.json')
const MAX_BODY = 64 * 1024
const REQUEST_TIMEOUT_MS = 12_000
const MONTH_RE = /^\d{4}-\d{2}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MEALS = new Set(['LUNCH', 'DINNER'])
const CHOICES = new Set(['ORDERED', 'DECLINED'])
const PRESENCES = new Set(['IN_OFFICE', 'OUT_OF_OFFICE'])
const SESSION_COOKIE = 'SESSION'

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function httpError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** The canteen service runs on Asia/Shanghai (UTC+8) and has no DST. */
const SERVICE_OFFSET_MS = 8 * 3600 * 1000

/** Current month on the service's calendar, used when the Client omits one. */
function serviceMonth(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input)
  const shifted = new Date(date.getTime() + SERVICE_OFFSET_MS)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

function trimBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const base = raw.length > 0 ? raw : DEFAULT_BASE_URL
  return base.replace(/\/+$/, '')
}

function resolveConfig(raw, stored) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const saved = stored && typeof stored === 'object' ? stored : {}
  const username = typeof saved.username === 'string' && saved.username.trim()
    ? saved.username.trim()
    : (typeof config.username === 'string' ? config.username.trim() : '')
  return {
    baseUrl: trimBaseUrl(saved.baseUrl ?? config.baseUrl),
    username,
  }
}

function readSettingsSync() {
  try {
    // Kept synchronous so the first panel request already sees saved state.
    const text = readFileSync(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeSettings(settings) {
  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true })
  await fsp.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

function cookieHeader(state) {
  if (state.cookies.size === 0) return ''
  return [...state.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

function absorbCookies(state, headers) {
  let list = []
  if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie()
  if (list.length === 0) {
    const single = headers.get('set-cookie')
    if (single) list = [single]
  }
  for (const raw of list) {
    const [pair] = String(raw).split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (value.length === 0) state.cookies.delete(name)
    else state.cookies.set(name, value)
  }
}

function friendlyAuthMessage(state, error) {
  if (String(error?.code) === '1104') {
    return `用户名「${state.cfg.username}」未在饭点登记，请联系管理员`
  }
  return error?.message || '登录失败'
}

/* ------------------------------------------------------------------ */
/* canteen client                                                      */
/* ------------------------------------------------------------------ */

async function callService(state, apiPath, options = {}) {
  const epoch = state.authEpoch ?? 0
  const url = `${state.cfg.baseUrl}/meal-booking${apiPath}`
  const hasBody = options.body !== undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const headers = { accept: 'application/json', 'x-meal-request': '1' }
  if (hasBody) headers['content-type'] = 'application/json'
  const cookie = cookieHeader(state)
  if (cookie) headers.cookie = cookie

  let response
  try {
    response = await fetch(url, {
      method: options.method ?? (hasBody ? 'POST' : 'GET'),
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
  } catch {
    clearTimeout(timer)
    throw httpError(502, 'offline', `无法连接饭点服务（${state.cfg.baseUrl}）`)
  }

  if (epoch !== (state.authEpoch ?? 0)) {
    clearTimeout(timer)
    throw httpError(409, 'account-changed', '饭点账号已变化，请重新操作')
  }
  absorbCookies(state, response.headers)

  let payload
  try {
    payload = await response.json()
  } catch {
    throw httpError(502, 'bad-response', '饭点服务返回了无法解析的内容')
  } finally {
    clearTimeout(timer)
  }
  if (epoch !== (state.authEpoch ?? 0)) throw httpError(409, 'account-changed', '饭点账号已变化，请重新操作')
  if (!response.ok || payload?.success === false || (payload?.code !== undefined && payload.code !== 200)) {
    const status = response.ok ? 400 : response.status
    throw httpError(status, String(payload?.code ?? status), String(payload?.description ?? payload?.message ?? '饭点请求失败'))
  }
  return payload.data
}

async function ensureSession(state, force = false) {
  if (!state.cfg.username) throw httpError(401, 'no-username', '还没有设置饭点用户名')
  if (!force && state.cookies.size > 0) return state.profile
  if (state.loginPromise) return state.loginPromise
  state.loginPromise = (async () => {
    state.authEpoch = (state.authEpoch ?? 0) + 1
    state.cookies.clear()
    let data
    try {
      data = await callService(state, '/auth/user/login', { body: { username: state.cfg.username } })
    } catch (error) {
      error.message = friendlyAuthMessage(state, error)
      throw error
    }
    state.profile = {
      username: typeof data?.username === 'string' ? data.username : state.cfg.username,
      role: data?.role,
      departmentName: data?.user?.departmentName,
    }
    state.loginAt = Date.now()
    return state.profile
  })()
  try {
    return await state.loginPromise
  } finally {
    state.loginPromise = undefined
  }
}

async function authedCall(state, apiPath, options) {
  await ensureSession(state)
  try {
    return await callService(state, apiPath, options)
  } catch (error) {
    if (error.status !== 401) throw error
    await ensureSession(state, true)
    return callService(state, apiPath, options)
  }
}

async function panelPayload(state, month) {
  if (!state.cfg.username) {
    return {
      configured: false,
      baseUrl: state.cfg.baseUrl,
      username: '',
      month: MONTH_RE.test(month ?? '') ? month : serviceMonth(),
      today: '',
      serverTime: new Date().toISOString(),
      presence: 'NOT_APPLICABLE',
      profile: null,
      days: [],
    }
  }
  await ensureSession(state)
  const target = MONTH_RE.test(month ?? '') ? month : serviceMonth()
  const data = await authedCall(state, `/calendar/list?month=${encodeURIComponent(target)}`)
  return {
    configured: true,
    baseUrl: state.cfg.baseUrl,
    username: state.cfg.username,
    month: typeof data?.month === 'string' ? data.month : target,
    today: typeof data?.today === 'string' ? data.today : '',
    serverTime: typeof data?.serverTime === 'string' ? data.serverTime : new Date().toISOString(),
    presence: typeof data?.presence === 'string' ? data.presence : 'NOT_APPLICABLE',
    profile: state.profile ?? null,
    days: Array.isArray(data?.days) ? data.days : [],
  }
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw httpError(413, 'too-large', '请求内容过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'bad-json', '请求不是合法 JSON')
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function validateSelection(body) {
  const date = typeof body?.date === 'string' && DATE_RE.test(body.date) ? body.date : ''
  const meal = typeof body?.meal === 'string' && MEALS.has(body.meal) ? body.meal : ''
  const choice = typeof body?.choice === 'string' && CHOICES.has(body.choice) ? body.choice : ''
  if (!date) throw httpError(400, 'bad-date', '日期无效')
  if (!meal) throw httpError(400, 'bad-meal', '餐次无效')
  if (!choice) throw httpError(400, 'bad-choice', '请选择订餐或不订餐')
  return { date, meal, choice }
}

async function handle(state, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const suffix = pathname.slice(API_PREFIX.length)

  if (suffix === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      value: {
        version: VERSION,
        batchAccountGuard: true,
        baseUrl: state.cfg.baseUrl,
        username: state.cfg.username,
        loggedIn: state.cookies.size > 0,
        loginAt: state.loginAt ?? null,
        settingsFile: SETTINGS_FILE,
      },
    })
  }

  if (suffix === '/panel' && req.method === 'GET') {
    const value = await panelPayload(state, url.searchParams.get('month') ?? '')
    return sendJson(res, 200, { ok: true, value })
  }

  if (suffix === '/login' && req.method === 'POST') {
    const body = await readJson(req)
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    if (!username) throw httpError(400, 'bad-username', '请输入饭点用户名')
    if (username.length > 64) throw httpError(400, 'bad-username', '用户名过长')
    if (state.protectedSelections || state.changingUser || state.loginPromise) {
      throw httpError(409, 'account-busy', '正在处理饭点请求，请稍后更换账号')
    }
    state.changingUser = true
    state.authEpoch = (state.authEpoch ?? 0) + 1
    try {
      const previous = { ...state.cfg }
      state.cfg = { ...state.cfg, username }
      state.cookies.clear()
      state.profile = undefined
      try {
        await ensureSession(state, true)
      } catch (error) {
        state.authEpoch = (state.authEpoch ?? 0) + 1
        state.cfg = previous
        state.cookies.clear()
        state.profile = undefined
        throw error
      }
      await writeSettings({ username, baseUrl: state.cfg.baseUrl })
      const value = await panelPayload(state, typeof body?.month === 'string' ? body.month : '')
      return sendJson(res, 200, { ok: true, value })
    } finally {
      state.changingUser = false
    }
  }

  if (suffix === '/selection' && req.method === 'POST') {
    const request = await readJson(req)
    const body = validateSelection(request)
    if (request.expectedUsername !== undefined) {
      const expected = typeof request.expectedUsername === 'string' ? request.expectedUsername.trim() : ''
      if (!expected || state.changingUser || state.cfg.username !== expected) {
        throw httpError(409, 'account-changed', '饭点账号已变化，请重新预览')
      }
      state.protectedSelections = (state.protectedSelections || 0) + 1
      try {
        await ensureSession(state)
        if (state.cfg.username !== expected || state.profile?.username !== expected) {
          throw httpError(409, 'account-changed', '饭点账号已变化，请重新预览')
        }
        // A failed POST can have taken effect; never replay it automatically.
        const day = await callService(state, '/calendar/selection/update', { body })
        return sendJson(res, 200, { ok: true, value: { day } })
      } finally {
        state.protectedSelections--
      }
    }
    const day = await authedCall(state, '/calendar/selection/update', { body })
    return sendJson(res, 200, { ok: true, value: { day } })
  }

  if (suffix === '/presence' && req.method === 'POST') {
    const body = await readJson(req)
    const presence = typeof body?.presence === 'string' && PRESENCES.has(body.presence) ? body.presence : ''
    if (!presence) throw httpError(400, 'bad-presence', '就餐状态无效')
    const data = await authedCall(state, '/profile/presence/update', { body: { presence } })
    return sendJson(res, 200, {
      ok: true,
      value: { presence: typeof data?.presence === 'string' ? data.presence : presence },
    })
  }

  if (suffix === '/lock' && req.method === 'POST') {
    const body = await readJson(req)
    const date = typeof body?.date === 'string' && DATE_RE.test(body.date) ? body.date : ''
    const meal = typeof body?.meal === 'string' && MEALS.has(body.meal) ? body.meal : ''
    if (!date) throw httpError(400, 'bad-date', '日期无效')
    if (!meal) throw httpError(400, 'bad-meal', '餐次无效')
    const action = body?.enable === true ? 'enable' : 'disable'
    const day = await authedCall(state, `/calendar/lock/${action}`, { body: { date, meal } })
    return sendJson(res, 200, { ok: true, value: { day } })
  }

  return sendJson(res, 404, {
    ok: false,
    error: { code: 'not-found', message: `未知接口 ${req.method} ${pathname}` },
  })
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig, readSettingsSync())
  const state = {
    cfg,
    cookies: new Map(),
    profile: undefined,
    loginAt: undefined,
    loginPromise: undefined,
  }

  let imService = null
  const reminder = createLunchReminder({
    panelPayload: month => panelPayload(state, month),
    getUsername: () => state.cfg.username,
    getIm: () => imService,
  })
  ctx.inject?.(['dshIm'], imCtx => {
    imCtx.effect(() => {
      const service = imCtx.dshIm
      imService = service
      return () => { if (imService === service) imService = null }
    }, 'meal panel optional IM reminders')
  })

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      return handle(state, req, res).catch(error => {
        const status = Number.isInteger(error?.status) ? error.status : 500
        try {
          sendJson(res, status, {
            ok: false,
            error: { code: error?.code ?? 'internal', message: String(error?.message ?? error) },
          })
        } catch {
          // The socket may already be gone; nothing else to do.
        }
      })
    },
  })

  ctx.effect(() => () => {
    reminder.dispose()
    dispose()
    state.cookies.clear()
    state.profile = undefined
  }, 'meal panel routes')
}

/* Test seam: pure helpers stay importable without a Cordis context. */
export const __internals = {
  serviceMonth,
  trimBaseUrl,
  resolveConfig,
  validateSelection,
  panelPayload,
  ensureSession,
  handle,
}
