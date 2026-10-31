import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNotificationManager } from './notification-manager.js'
import { startedNotification, completionMarkdown } from './notifications.js'
import { createWireSummary, consumeWire, codeSession } from './kimi-source.js'
import { createClaudeSummary, consumeClaude, claudeSession } from './claude-source.js'
import { parseDshSession } from './dsh-source.js'

const boot = '2026-10-28T00:00:00.000Z'
const at = (seconds) => new Date(Date.parse(boot) + seconds * 1000).toISOString()
const id = '019d0000-0000-7000-8000-000000000031'
const settings = { windowsEnabled: true, imEnabled: true, botId: 'bot_test', targetId: 'phone' }
const running = (extra = {}) => ({ sessionId: id, title: '修复菜单', source: 'app', model: 'gpt-6.1-sol', reasoningEffort: 'max', status: 'running', lifecycleEvent: 'task_started', observedAt: at(10), ...extra })
const completed = (extra = {}) => running({ status: 'turn_completed', lifecycleEvent: 'task_complete', observedAt: at(20), ...extra })

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kanban-start-'))
  const imSent = []; const windowsSent = []
  const saved = { ...settings, ...options.saved }
  await writeFile(join(directory, 'notification-settings.json'), JSON.stringify(saved))
  const service = {
    listBots: async () => [{ botId: 'bot_test', channel: 'telegram' }],
    listTargets: async () => [{ targetId: 'phone' }, { targetId: 'other' }],
    async send(...args) { imSent.push(args); return { sent: true } }, ...options.service
  }
  const manager = await createNotificationManager({ directory, platform: 'win32', startedAt: boot,
    sendWindows: async (payload) => windowsSent.push(payload), ...options.manager })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.setImService(service)
  return { manager, directory, service, saved, imSent, windowsSent }
}

test('start goes only to IM once; completion retains both channels, Markdown and folded answer', { timeout: 5000 }, async (t) => {
  let detailReads = 0
  const f = await fixture(t, { manager: { readCompletion: async () => {
    detailReads++; return { durationMs: 10000, turnTokens: 1234, finalReply: '**完成**\n\n```js\nconst ok = true\n```' }
  } } })
  const observed = running()
  f.manager.observe(observed); f.manager.observe(observed)
  observed.title = 'MUTATED'
  await f.manager.waitForIdle()
  assert.equal(detailReads, 0); assert.equal(f.windowsSent.length, 0); assert.equal(f.imSent.length, 1)
  assert.match(f.imSent[0][2], /^\*\*Codex 开始执行\*\*/)
  assert.match(f.imSent[0][2], /修复菜单/); assert.doesNotMatch(f.imSent[0][2], /MUTATED|最终回复|执行时长|Token/)
  assert.equal(f.imSent[0][3].format, 'markdown')
  f.manager.observe(running()); f.manager.observe(completed()); f.manager.observe(completed())
  await f.manager.waitForIdle()
  assert.equal(detailReads, 1); assert.equal(f.windowsSent.length, 1); assert.equal(f.imSent.length, 2)
  assert.match(f.imSent[1][2], /Token：约 1,234（本轮）\n\n⟦details:最终回复（约 \d+ 字）⟧\n\n\*\*完成\*\*/)
  assert.ok(f.imSent[1][2].endsWith('\n\n⟦/details⟧'))
  const files = await readdir(f.directory)
  const startHistory = JSON.parse(await readFile(join(f.directory, files.find((name) => name.startsWith('notification-history-im-start-'))), 'utf8'))
  assert.deepEqual(startHistory.sessions, [{ sessionId: id, startedAt: at(10) }])
  const endHistory = JSON.parse(await readFile(join(f.directory, files.find((name) => /^notification-history-im-[a-f0-9]+\.json$/.test(name))), 'utf8'))
  assert.deepEqual(endHistory.sessions, [{ sessionId: id, completedAt: at(20) }])
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'notification-settings.json'), 'utf8')), f.saved)
})

test('recreating a sender preserves start dedup and allows the next turn', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  f.manager.observe(running()); await f.manager.waitForIdle(); await f.manager.close()
  const next = await createNotificationManager({ directory: f.directory, platform: 'win32', startedAt: boot, sendWindows: async () => {} })
  t.after(() => next.close())
  await next.setImService(f.service)
  next.observe(running()); next.observe(running({ observedAt: at(5) })); await next.waitForIdle()
  assert.equal(f.imSent.length, 1)
  // No need to observe the intervening completion to identify the next start.
  next.observe(running({ observedAt: at(30) })); await next.waitForIdle()
  assert.equal(f.imSent.length, 2)
})

test('history, uncertain status, absent start, invalid IDs and interrupted turns produce no start notification', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  for (const extra of [{ observedAt: boot }, { observedAt: at(-1) }, { observedAt: null }, { status: 'unknown' },
    { statusUncertain: true }, { lifecycleEvent: null }, { sessionId: 'bad' }, { turnStartedAt: null },
    { turnStartedAt: at(-1), observedAt: at(10) }]) f.manager.observe(running(extra))
  f.manager.observe(completed({ lifecycleEvent: 'turn_aborted' }))
  await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 0); assert.equal(f.windowsSent.length, 0)
  assert.deepEqual(await readdir(f.directory), ['notification-settings.json'])
})

test('completion without an observed running state does not invent a late start notification', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  f.manager.observe(completed()); f.manager.observe(running())
  await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 1); assert.match(f.imSent[0][2], /轮次已完成/)
  assert.equal(f.windowsSent.length, 1)
})

test('IM disabled or disconnected stays silent; tests do not emit synthetic start messages', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { saved: { imEnabled: false } })
  f.manager.observe(running()); await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 0); assert.equal(f.windowsSent.length, 0)
  await f.manager.configure(settings)
  await f.manager.setImService(null)
  f.manager.observe(running()); await f.manager.waitForIdle(); assert.equal(f.imSent.length, 0)
  await f.manager.setImService(f.service)
  await f.manager.test()
  assert.equal(f.imSent.length, 1); assert.match(f.imSent[0][2], /测试通知/)
  assert.equal((await readdir(f.directory)).some((name) => name.includes('history')), false)
})

test('newly enabled IM ignores work that started before the sender was enabled', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { manager: { startedAt: undefined } })
  f.manager.observe(running({ observedAt: new Date(Date.now() - 60000).toISOString() }))
  await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 0)
})

test('start failures are not retried and do not suppress the later completion', { timeout: 5000 }, async (t) => {
  let calls = 0
  const f = await fixture(t, { service: { async send(_bot, _target, text) {
    calls++
    if (text.includes('开始执行')) throw Object.assign(new Error('offline'), { code: 'bot-not-connected' })
    return { sent: true }
  } } })
  f.manager.observe(running()); await f.manager.waitForIdle()
  assert.match(f.manager.snapshot().channels.im.lastError, /未连接/)
  f.manager.observe(running()); f.manager.observe(completed()); await f.manager.waitForIdle()
  assert.equal(calls, 2); assert.equal(f.windowsSent.length, 1)
  assert.equal(f.manager.snapshot().channels.im.lastError, null)
})

test('start and completion use one IM queue; unload cancels start and discards queued completion', { timeout: 5000 }, async (t) => {
  let began; let signal; let calls = 0
  const ready = new Promise((resolve) => { began = resolve })
  const f = await fixture(t, { service: { send(_bot, _target, _text, options) {
    calls++; signal = options.signal; began(); return new Promise(() => {})
  } } })
  f.manager.observe(running()); f.manager.observe(completed()); await ready
  await f.manager.close()
  assert.equal(calls, 1); assert.equal(signal.aborted, true); assert.equal(f.manager.snapshot().pending, 0)
})

test('Kimi multiple start records and refreshes produce one start per actual turn', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  const summary = createWireSummary()
  const row = () => codeSession({ id: 'session_test', title: 'Kimi 任务' }, {}, summary)
  for (const [index, type] of ['prompt.accepted', 'turn.prompt', 'turn.started'].entries()) {
    consumeWire(summary, { type, time: at(index + 10), promptId: 'first' })
    f.manager.observe(row())
  }
  await f.manager.waitForIdle()
  assert.equal(row().turnStartedAt, at(10)); assert.equal(f.imSent.length, 1)
  consumeWire(summary, { type: 'prompt.completed', time: at(20), reason: 'completed' })
  consumeWire(summary, { type: 'prompt.accepted', time: at(30), promptId: 'second' })
  f.manager.observe(row()); await f.manager.waitForIdle()
  assert.equal(row().turnStartedAt, at(30)); assert.equal(f.imSent.length, 2)
})

test('Claude heartbeat and permission transitions retain the same prompt start; next prompt notifies', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  const summary = createClaudeSummary('session_test')
  consumeClaude(summary, { type: 'user', uuid: 'first', timestamp: at(10), message: { content: '开始任务' } })
  for (const [index, status] of ['working', 'waiting_for_permission', 'busy'].entries()) {
    const row = claudeSession(summary, { status, statusUpdatedAt: at(11 + index) })
    assert.equal(row.turnStartedAt, at(10)); f.manager.observe(row)
  }
  await f.manager.waitForIdle(); assert.equal(f.imSent.length, 1)
  consumeClaude(summary, { type: 'user', uuid: 'second', timestamp: at(30), message: { content: '继续下一轮' } })
  f.manager.observe(claudeSession(summary, { status: 'working', statusUpdatedAt: at(31) }))
  await f.manager.waitForIdle(); assert.equal(f.imSent.length, 2)
  const noPrompt = claudeSession(createClaudeSummary('no_prompt'), { status: 'working', statusUpdatedAt: at(40) })
  f.manager.observe(noPrompt); await f.manager.waitForIdle(); assert.equal(f.imSent.length, 2)
})

test('DSH starts notify using the existing raw turn/start fact', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  const row = parseDshSession({ id: 'session_test', createdAt: boot }, [{ type: 'turn/start', time: at(10), data: {} }])
  f.manager.observe(row); f.manager.observe(row); await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 1); assert.match(f.imSent[0][2], /DSH 开始执行/)
})

test('brief start Markdown escapes metadata, omits missing model and preserves completion fold markers', () => {
  const payload = startedNotification(running({ title: '*任务* [x](y)', model: '', reasoningEffort: '' }))
  assert.ok(payload.markdown.includes('\\*任务\\* \\[x\\]\\(y\\)'))
  assert.doesNotMatch(payload.markdown, /未记录|undefined|Token/)
  assert.ok(payload.markdown.length < 100)
  const completedText = completionMarkdown(completed(), { finalReply: '**已完成**' })
  assert.ok(completedText.includes('\n\n⟦details:最终回复（约 7 字）⟧\n\n**已完成**\n\n⟦/details⟧'))
})
