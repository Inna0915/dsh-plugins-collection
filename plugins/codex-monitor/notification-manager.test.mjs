import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createNotificationManager } from './notification-manager.js'

const startedAt = '2026-10-25T00:00:00.000Z'
const finished = (observedAt = '2026-10-25T00:01:00.000Z') => ({
  sessionId: '019d0000-0000-7000-8000-000000000031', title: '修复测试任务', source: 'app',
  status: 'turn_completed', lifecycleEvent: 'task_complete', observedAt
})
const settings = { windowsEnabled: true, imEnabled: true, botId: 'bot_test', targetId: 'phone' }

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-im-notifications-'))
  const windowsSent = []; const imSent = []
  const service = {
    async listBots() { return [{ botId: 'bot_test', channel: 'weixin' }] },
    async listTargets() { return [{ targetId: 'phone', name: '手机', kind: 'user', route: { toUserId: 'PRIVATE' } }, { targetId: 'other', name: '另一个目标' }] },
    async send(...args) { imSent.push(args); return { sent: true } },
    ...options.service
  }
  if (options.saved) await writeFile(join(directory, 'notification-settings.json'), JSON.stringify(options.saved))
  const manager = await createNotificationManager({ directory, platform: 'win32', startedAt, sendWindows: async (payload) => windowsSent.push(payload), ...options.manager })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.setImService(service)
  return { directory, manager, service, windowsSent, imSent }
}

test('rich completion shares one detail read across channels and sends Markdown through IM', { timeout: 5000 }, async (t) => {
  let reads = 0
  const f = await fixture(t, { saved: settings, manager: { async readCompletion(observed, { signal }) {
    reads++; assert.equal(signal.aborted, false); assert.equal(observed.observedAt, finished().observedAt)
    return { durationMs: 152000, model: 'gpt-6.1-sol', reasoningEffort: 'max', turnTokens: 12345, finalReply: '**修复完成**\n\n```js\nconst ok = true\n```' }
  } } })
  f.manager.observe(finished()); f.manager.observe(finished())
  await f.manager.waitForIdle()
  assert.equal(reads, 1)
  assert.equal(f.imSent[0][3].format, 'markdown')
  assert.match(f.imSent[0][2], /2 分 32 秒/)
  assert.match(f.imSent[0][2], /12,345（本轮）/)
  assert.match(f.imSent[0][2], /\*\*修复完成\*\*/)
  assert.equal(f.windowsSent[0].markdown, undefined)
  assert.match(f.windowsSent[0].body, /gpt-6.1-sol · max/)
  assert.doesNotMatch(JSON.stringify(await f.manager.configuration()), /const ok|修复完成/)
  const history = await readFile(join(f.directory, 'notification-history.json'), 'utf8')
  assert.doesNotMatch(history, /const ok|修复完成/)
  await f.manager.test(); assert.equal(reads, 1)
})

test('detail failure or deadline falls back to labelled totals without blocking either channel', { timeout: 5000 }, async (t) => {
  let readSignal
  const f = await fixture(t, { saved: settings, manager: { detailTimeoutMs: 25, readCompletion(_session, { signal }) {
    readSignal = signal; return new Promise(() => {})
  } } })
  f.manager.observe({ ...finished(), tokensUsed: 50000 })
  await f.manager.waitForIdle()
  assert.equal(readSignal.aborted, true)
  assert.equal(f.windowsSent.length, 1); assert.equal(f.imSent.length, 1)
  assert.match(f.imSent[0][2], /50,000（会话累计，非本轮）/)
  assert.match(f.imSent[0][2], /执行时长：未记录/)
  assert.match(f.imSent[0][2], /未读取到本轮最终回复/)
})

test('unloading during detail read cancels the reader and sends nothing', { timeout: 5000 }, async (t) => {
  let began; let readSignal
  const ready = new Promise((resolve) => { began = resolve })
  const f = await fixture(t, { saved: settings, manager: { readCompletion(_session, { signal }) {
    readSignal = signal; began(); return new Promise(() => {})
  } } })
  f.manager.observe(finished()); await ready; await f.manager.close()
  assert.equal(readSignal.aborted, true)
  assert.equal(f.windowsSent.length, 0); assert.equal(f.imSent.length, 0)
})

test('双渠道完成通知独立去重；重建实例不重发，下一轮继续发送', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  await f.manager.configure(settings)
  f.manager.observe(finished()); f.manager.observe(finished())
  await f.manager.waitForIdle()
  assert.equal(f.windowsSent.length, 1); assert.equal(f.imSent.length, 1)
  assert.equal(f.imSent[0][0], settings.botId); assert.equal(f.imSent[0][1], settings.targetId)
  assert.match(f.imSent[0][2], /## Codex 轮次已完成\n\n\*\*修复测试任务\*\*/)
  assert.match(f.imSent[0][2], /来源：Codex App/)
  assert.equal(f.imSent[0][3].format, 'markdown')
  await f.manager.close()
  const next = await createNotificationManager({ directory: f.directory, platform: 'win32', startedAt, sendWindows: async () => f.windowsSent.push('next') })
  t.after(() => next.close())
  await next.setImService(f.service)
  next.observe(finished()); await next.waitForIdle()
  assert.equal(f.windowsSent.length, 1); assert.equal(f.imSent.length, 1)
  next.observe(finished('2026-10-25T00:02:00.000Z')); await next.waitForIdle()
  assert.equal(f.windowsSent.length, 2); assert.equal(f.imSent.length, 2)
})

test('IM 失败不影响 Windows，重复轮询不重试，测试返回分渠道结果且不改变去重记录', { timeout: 5000 }, async (t) => {
  let calls = 0
  const f = await fixture(t, { service: { async send() { calls++; throw Object.assign(new Error('offline'), { code: 'bot-not-connected' }) } } })
  await f.manager.configure(settings)
  f.manager.observe(finished()); await f.manager.waitForIdle()
  f.manager.observe(finished()); await f.manager.waitForIdle()
  assert.equal(f.windowsSent.length, 1); assert.equal(calls, 1)
  assert.match(f.manager.snapshot().channels.im.lastError, /未连接/)
  assert.equal(f.manager.snapshot().channels.windows.lastError, null)
  const files = (await readdir(f.directory)).filter((file) => file.startsWith('notification-history'))
  const before = await Promise.all(files.map((file) => readFile(join(f.directory, file), 'utf8')))
  const result = await f.manager.test()
  assert.equal(result.accepted, false)
  assert.deepEqual(result.results.map((row) => [row.channel, row.sent]), [['windows', true], ['im', false]])
  assert.deepEqual(await Promise.all(files.map((file) => readFile(join(f.directory, file), 'utf8'))), before)
})

test('Windows 失败不影响 IM；历史 Windows 去重不会吞掉 IM 通知', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { manager: { async sendWindows() { throw new Error('Windows disabled') } } })
  f.manager.observe(finished()); await f.manager.waitForIdle()
  await f.manager.configure(settings)
  f.manager.observe(finished()); await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 1)
  const result = await f.manager.test()
  assert.deepEqual(result.results.map((row) => row.sent), [false, true])
})

test('IM 平台拒绝保留错误码但不泄露底层请求，重复轮询不重试且不影响 Windows', async (t) => {
  let calls = 0
  const rejected = Object.assign(new Error('PRIVATE token=secret recipient=private'), { code: 'send-rejected', providerCode: -2 })
  const f = await fixture(t, { saved: settings, service: { async send() {
    calls++
    throw Object.assign(new Error('delivery-failed'), { code: 'delivery-failed', cause: rejected })
  } } })
  f.manager.observe(finished()); await f.manager.waitForIdle()
  f.manager.observe(finished()); await f.manager.waitForIdle()
  const state = f.manager.snapshot()
  assert.match(state.channels.im.lastError, /平台拒绝发送（错误码 -2）/)
  assert.doesNotMatch(state.channels.im.lastError, /PRIVATE|secret|recipient/)
  assert.equal(calls, 1)
  assert.equal(f.windowsSent.length, 1)
  assert.equal(state.channels.windows.lastError, null)
})

test('非 Windows 可以单独启用 IM；目标变更独立去重，配置不泄露平台路由', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { manager: { platform: 'linux' } })
  await f.manager.configure({ ...settings, windowsEnabled: false })
  f.manager.observe(finished()); await f.manager.waitForIdle()
  assert.equal(f.windowsSent.length, 0); assert.equal(f.imSent.length, 1)
  await f.manager.configure({ ...settings, windowsEnabled: false, targetId: 'other' })
  f.manager.observe(finished()); await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 2); assert.equal(f.imSent[1][1], 'other')
  const config = await f.manager.configuration()
  assert.equal(config.targets[0].label, '微信 · 手机')
  assert.doesNotMatch(JSON.stringify(config), /PRIVATE|toUserId/)
  assert.equal((await f.manager.test()).results.length, 1)
})

test('配置校验拒绝不存在的目标及附加字段，不覆盖已保存设置；双渠道均可关闭', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  await f.manager.configure(settings)
  await assert.rejects(f.manager.configure({ ...settings, targetId: 'missing' }), /不存在/)
  await assert.rejects(f.manager.configure({ ...settings, text: 'injected' }), /无效/)
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'notification-settings.json'), 'utf8')), settings)
  await f.manager.configure({ ...settings, windowsEnabled: false, imEnabled: false })
  f.manager.observe(finished()); await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 0); assert.equal(f.windowsSent.length, 0)
  await assert.rejects(f.manager.test(), /开启/)
})

test('IM 插件卸载不影响 Windows，重新连接可以继续；离线设置可关闭 IM', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { saved: settings })
  await f.manager.setImService(null)
  f.manager.observe(finished()); await f.manager.waitForIdle()
  assert.equal(f.windowsSent.length, 1); assert.equal(f.imSent.length, 0)
  assert.match(f.manager.snapshot().channels.im.lastError, /暂不可用/)
  assert.equal((await f.manager.test()).accepted, false)
  await f.manager.setImService(f.service)
  f.manager.observe(finished('2026-10-25T00:02:00.000Z')); await f.manager.waitForIdle()
  assert.equal(f.imSent.length, 1)
  await f.manager.setImService(null)
  await f.manager.configure({ ...settings, imEnabled: false })
  assert.equal(f.manager.snapshot().channels.im.enabled, false)
})

test('IM 超时有界且传递取消信号，Windows 仍可发送', { timeout: 5000 }, async (t) => {
  let sendSignal
  const f = await fixture(t, { manager: { timeoutMs: 30 }, service: { send(_bot, _target, _text, { signal }) { sendSignal = signal; return new Promise(() => {}) } } })
  await f.manager.configure(settings)
  const result = await f.manager.test()
  assert.equal(sendSignal.aborted, true)
  assert.equal(result.results[0].sent, true)
  assert.match(result.results[1].error, /超时/)
})

test('卸载取消 IM 在途请求，并丢弃等待中的完成通知', { timeout: 5000 }, async (t) => {
  let began; let calls = 0; let sendSignal
  const started = new Promise((resolve) => { began = resolve })
  const f = await fixture(t, { service: { send(_bot, _target, _text, { signal }) { calls++; sendSignal = signal; began(); return new Promise(() => {}) } } })
  await f.manager.configure({ ...settings, windowsEnabled: false })
  f.manager.observe(finished()); f.manager.observe(finished('2026-10-25T00:02:00.000Z'))
  await started
  await f.manager.close()
  assert.equal(sendSignal.aborted, true); assert.equal(calls, 1)
  assert.equal(f.manager.snapshot().pending, 0)
})

test('损坏配置不会阻止看板加载，也不会擅自打开 IM', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { saved: { imEnabled: true } })
  assert.match(f.manager.snapshot().settingsError, /读取失败/)
  assert.equal(f.manager.snapshot().channels.im.enabled, false)
  await f.manager.configure(settings)
  assert.equal(f.manager.snapshot().settingsError, null)
})
