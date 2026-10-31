import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const OFFSET = 8 * 60 * 60 * 1000
const START = (8 * 60 + 30) * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

function serviceDate(ms) {
  return new Date(ms + OFFSET).toISOString().slice(0, 10)
}

function serviceMidnight(ms) {
  return Math.floor((ms + OFFSET) / DAY) * DAY - OFFSET
}

function serviceTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return NaN
  const text = value.replace(' ', 'T')
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}+08:00`)
}

async function readNotificationSettings(home) {
  return JSON.parse(await readFile(path.join(home, 'codex-monitor', 'notification-settings.json'), 'utf8'))
}

// An empty, synced marker is the durable attempt record. Never remove a marker:
// after a crash or uncertain send, retrying could produce duplicate messages.
async function claim(directory, username, date) {
  const digest = createHash('sha256').update(JSON.stringify([username, date])).digest('hex')
  await mkdir(directory, { recursive: true })
  let handle
  try {
    handle = await open(path.join(directory, `${digest}.attempt`), 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try { await handle.sync() } finally { await handle.close() }
  return true
}

async function sendWithTimeout(im, botId, targetId, lifetime) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  lifetime.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 10_000)
  let onAbort
  try {
    return await Promise.race([
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return im.send(botId, targetId, '午餐尚未选择，请在截止前到饭点完成登记。', { signal: controller.signal, format: 'plain' }) }),
      new Promise((_, reject) => {
        onAbort = () => reject(new Error('cancelled'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (lifetime.aborted || controller.signal.aborted) { controller.abort(); onAbort() }
      }),
    ])
  } finally {
    clearTimeout(timer)
    lifetime.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Start a Host-lifetime reminder. panelPayload(month), getUsername(), getIm(),
 * and readConfig() are injected; the latter defaults to the board settings.
 * now()/setInterval()/clearInterval() can be injected for deterministic tests.
 * No error contents are logged: providers may include credentials in errors.
 */
export function createLunchReminder(options) {
  const home = options.home ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  const directory = options.directory ?? path.join(home, 'meal-panel', 'lunch-reminder-attempts')
  const now = options.now ?? Date.now
  const setTimer = options.setInterval ?? globalThis.setInterval
  const clearTimer = options.clearInterval ?? globalThis.clearInterval
  const readConfig = options.readConfig ?? (() => readNotificationSettings(home))
  const startedAt = now()
  const lifetime = new AbortController()
  let disposed = false
  let active = null
  let cacheDate = ''
  const attempted = new Set()
  const expiredUsers = new Set()

  async function check() {
    if (disposed) return 'disposed'
    const start = now()
    const midnight = serviceMidnight(start)
    const boundary = midnight + START
    if (!Number.isFinite(start) || start < boundary || startedAt > boundary) return 'outside-window'
    const date = serviceDate(start)
    if (date !== cacheDate) { cacheDate = date; attempted.clear(); expiredUsers.clear() }
    const username = options.getUsername()?.trim()
    if (!username) return 'unavailable'
    if (expiredUsers.has(username)) return 'outside-window'
    const im = options.getIm()
    if (!im || typeof im.send !== 'function') return 'unavailable'
    const settings = await readConfig()
    const botId = typeof settings?.botId === 'string' ? settings.botId.trim() : ''
    const targetId = typeof settings?.targetId === 'string' ? settings.targetId.trim() : ''
    if (!botId || !targetId || disposed) return 'unavailable'
    const attemptKey = JSON.stringify([username, date])
    if (attempted.has(attemptKey)) return 'already-attempted'

    async function readEligible() {
      const panel = await options.panelPayload(date.slice(0, 7))
      const afterRead = now()
      const serverTime = serviceTime(panel?.serverTime)
      const day = panel?.days?.find?.(item => item?.date === date)
      const lunch = day?.meals?.find?.(item => item?.meal === 'LUNCH')
      const deadline = serviceTime(lunch?.deadline)
      if (!Number.isFinite(serverTime) || panel?.today !== date || panel?.username !== username ||
          (panel?.profile?.username && panel.profile.username !== username) || panel?.configured !== true ||
          serviceDate(serverTime) !== date || serverTime < boundary) return null
      if ((Number.isFinite(deadline) && serverTime >= deadline) ||
          panel.presence === 'OUT_OF_OFFICE' || day?.presence === 'OUT_OF_OFFICE' ||
          lunch?.choice === 'ORDERED' || lunch?.choice === 'DECLINED') expiredUsers.add(username)
      if (!Number.isFinite(deadline) || serverTime >= deadline || panel.presence !== 'IN_OFFICE' ||
          day?.presence !== 'IN_OFFICE' || (lunch?.presence != null && lunch.presence !== 'IN_OFFICE') ||
          lunch?.choice !== 'UNSELECTED' || lunch?.locked !== false) return null
      return { serverTime, deadline, afterRead }
    }
    let snapshot = await readEligible()
    if (!snapshot) return 'ineligible'

    function stillEligible() {
      const current = now()
      const estimatedServer = snapshot.serverTime + Math.max(0, current - snapshot.afterRead)
      return !disposed && Number.isFinite(current) && current >= boundary && serviceDate(current) === date &&
        serviceDate(estimatedServer) === date && estimatedServer >= boundary && estimatedServer < snapshot.deadline &&
        options.getUsername()?.trim() === username && options.getIm() === im
    }
    if (!stillEligible()) return 'ineligible'
    snapshot = await readEligible()
    if (!snapshot || !stillEligible()) return 'ineligible'
    const currentSettings = await readConfig()
    if (currentSettings?.botId?.trim() !== botId || currentSettings?.targetId?.trim() !== targetId || !stillEligible()) return 'unavailable'
    const claimed = await claim(directory, username, date)
    attempted.add(attemptKey)
    if (!claimed) return 'already-attempted'
    // If the account changes or the deadline passes during the claim, do not send.
    // Retaining the claim is intentional: it is safer than a duplicate after a crash.
    const finalSettings = await readConfig()
    if (finalSettings?.botId?.trim() !== botId || finalSettings?.targetId?.trim() !== targetId || !stillEligible()) return 'ineligible'
    try {
      const result = await sendWithTimeout(im, botId, targetId, lifetime.signal)
      return result?.sent === true ? 'sent' : 'send-uncertain'
    } catch {
      return 'send-uncertain'
    }
  }

  function tick() {
    if (disposed) return Promise.resolve('disposed')
    if (active) return active
    active = check().catch(() => 'unavailable').finally(() => { active = null })
    return active
  }
  const timer = setTimer(() => { void tick() }, options.intervalMs ?? 30_000)
  timer?.unref?.()
  if (startedAt === serviceMidnight(startedAt) + START) void tick()
  return {
    tick,
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer(timer)
      lifetime.abort()
    },
  }
}
