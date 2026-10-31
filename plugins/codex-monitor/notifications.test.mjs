import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCompletionNotifications, completionToast, sendWindowsToast } from './notifications.js'
import { createMonitor } from './monitor.js'

const sessionId = '019d0000-0000-7000-8000-000000000031'
const startedAt = '2026-10-07T01:00:00.000Z'
const finished = (overrides = {}) => ({ sessionId, title: '修复菜单 & 样式', source: 'vscode', status: 'turn_completed', lifecycleEvent: 'task_complete', observedAt: '2026-10-07T01:01:00.000Z', ...overrides })

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-notifications-'))
  const file = join(directory, 'notification-history.json')
  const sent = []
  const notifications = createCompletionNotifications({ platform: 'win32', startedAt, file, send: async (payload) => sent.push(payload), ...extra })
  t.after(async () => { await notifications.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, file, sent, notifications }
}

test('正常完成只通知一次，新轮次可以再次通知', { timeout: 5000 }, async (t) => {
  const { notifications, sent, file } = await fixture(t)
  notifications.observe(finished({ status: 'running', lifecycleEvent: 'task_started' }))
  notifications.observe(finished())
  notifications.observe(finished())
  await notifications.waitForIdle()
  notifications.observe(finished())
  await notifications.waitForIdle()
  assert.equal(sent.length, 1)
  assert.match(sent[0].body, /修复菜单 & 样式\nVS Code/)
  assert.match(completionToast(finished({ source: 'app' })).body, /Codex App/)
  notifications.observe(finished({ observedAt: '2026-10-07T01:02:00.000Z' }))
  await notifications.waitForIdle()
  assert.equal(sent.length, 2)
  assert.notEqual(sent[0].tag, sent[1].tag)
  const stored = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(stored.sessions, [{ sessionId, completedAt: '2026-10-07T01:02:00.000Z' }])
})

test('启动前历史、中断、未知状态和无效时间不通知', { timeout: 5000 }, async (t) => {
  const { notifications, sent } = await fixture(t)
  for (const session of [finished({ observedAt: startedAt }), finished({ lifecycleEvent: 'turn_aborted' }), finished({ status: 'unknown' }), finished({ observedAt: null }), finished({ lifecycleEvent: undefined }), finished({ sessionId: 'bad' })]) notifications.observe(session)
  await notifications.waitForIdle()
  assert.equal(sent.length, 0)
})

test('持久化去重覆盖重建实例及较旧的结束事实', { timeout: 5000 }, async (t) => {
  const { notifications, sent, file } = await fixture(t)
  notifications.observe(finished())
  await notifications.waitForIdle()
  const next = createCompletionNotifications({ platform: 'win32', file, startedAt, send: async (payload) => sent.push(payload) })
  t.after(() => next.close())
  next.observe(finished())
  next.observe(finished({ observedAt: '2026-10-07T01:00:30.000Z' }))
  await next.waitForIdle()
  assert.equal(sent.length, 1)
})

test('短轮次无需先看见运行态，审核和重复刷新不导致重复通知', { timeout: 5000 }, async (t) => {
  const { notifications, sent } = await fixture(t)
  const source = { queryDefault: async () => ({ sessions: [finished()] }), querySession: async () => finished() }
  const monitor = createMonitor(source, { onSessionObserved: notifications.observe })
  t.after(() => monitor.close())
  monitor.requestDefault()
  await monitor.waitForIdle()
  await notifications.waitForIdle()
  assert.equal(monitor.snapshot().sessions[0].status, 'record')
  assert.equal(sent.length, 1)
  monitor.requestSession(sessionId)
  await monitor.waitForIdle()
  await monitor.reviewCompleted(sessionId)
  monitor.requestDefault()
  await monitor.waitForIdle()
  await notifications.waitForIdle()
  assert.equal(sent.length, 1)
})

test('窗口外运行记录的补查与定向刷新均能通知', { timeout: 5000 }, async (t) => {
  const { notifications, sent } = await fixture(t)
  let current = finished()
  const source = { queryDefault: async () => ({ sessions: [] }), querySession: async () => current }
  const records = new Map([[sessionId, startedAt]])
  const monitor = createMonitor(source, { onSessionObserved: notifications.observe, recordStore: { list: async () => records, remember: async () => records } })
  t.after(() => monitor.close())
  monitor.requestDefault()
  await monitor.waitForIdle()
  await notifications.waitForIdle()
  current = finished({ observedAt: '2026-10-07T01:02:00.000Z' })
  monitor.requestSession(sessionId)
  await monitor.waitForIdle()
  await notifications.waitForIdle()
  assert.equal(sent.length, 2)
})

test('发送失败不破坏会话刷新，也不会每次轮询重复弹窗', { timeout: 5000 }, async (t) => {
  let calls = 0
  const { notifications } = await fixture(t, { send: async () => { calls++; throw new Error('Windows notifications disabled') } })
  const monitor = createMonitor({ queryDefault: async () => ({ sessions: [finished()] }) }, { onSessionObserved: notifications.observe })
  t.after(() => monitor.close())
  monitor.requestDefault()
  await monitor.waitForIdle()
  await notifications.waitForIdle()
  notifications.observe(finished())
  await notifications.waitForIdle()
  assert.equal(calls, 1)
  assert.equal(monitor.snapshot().health.index, 'ok')
  assert.match(notifications.snapshot().lastError, /disabled/)
})

test('去重文件损坏时保留原文件并报告通知错误', { timeout: 5000 }, async (t) => {
  const { notifications, sent, file } = await fixture(t)
  await writeFile(file, '{bad')
  notifications.observe(finished())
  await notifications.waitForIdle()
  assert.equal(sent.length, 0)
  assert.ok(notifications.snapshot().lastError)
  assert.equal(await readFile(file, 'utf8'), '{bad')
})

test('卸载取消当前发送并丢弃排队通知', { timeout: 5000 }, async (t) => {
  let calls = 0
  let began
  const started = new Promise((resolve) => { began = resolve })
  const { notifications } = await fixture(t, { send: (_payload, { signal }) => new Promise((_resolve, reject) => {
    calls++
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    began()
  }) })
  notifications.observe(finished())
  notifications.observe(finished({ observedAt: '2026-10-07T01:02:00.000Z' }))
  await started
  await notifications.close()
  notifications.observe(finished({ observedAt: '2026-10-07T01:03:00.000Z' }))
  assert.equal(calls, 1)
  assert.equal(notifications.snapshot().pending, 0)
})

test('非 Windows 和关闭自动通知不发送；测试通知不修改去重记录', { timeout: 5000 }, async (t) => {
  const disabled = await fixture(t, { enabled: false })
  disabled.notifications.observe(finished())
  await disabled.notifications.waitForIdle()
  assert.equal(disabled.sent.length, 0)
  await disabled.notifications.test()
  assert.match(disabled.sent[0].title, /测试通知/)
  await assert.rejects(readFile(disabled.file), { code: 'ENOENT' })
  const other = await fixture(t, { platform: 'linux' })
  other.notifications.observe(finished())
  await other.notifications.waitForIdle()
  assert.equal(other.sent.length, 0)
  await assert.rejects(other.notifications.test(), /不可用/)
})

function fakeSpawn(onLaunch) {
  return (executable, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdin.end = (text) => { child.input = text }
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)) }
    queueMicrotask(() => onLaunch(child, executable, args, options))
    return child
  }
}

test('Windows sender 只把通知正文写入 stdin，使用隐藏进程', { timeout: 5000 }, async () => {
  const payload = completionToast(finished({ title: '中文 <&> ` $() "' }))
  await sendWindowsToast(payload, { platform: 'win32', spawn: fakeSpawn((child, executable, args, options) => {
    assert.match(executable, /WindowsPowerShell/)
    assert.equal(options.windowsHide, true)
    assert.equal(args.includes(payload.body), false)
    assert.deepEqual(JSON.parse(child.input), payload)
    child.stdout.emit('data', Buffer.from('{"accepted":true}'))
    child.emit('close', 0)
  }) })
})

test('Windows sender 超时和取消均终止自有进程并等待退出', { timeout: 5000 }, async () => {
  let timeoutChild
  await assert.rejects(sendWindowsToast({}, { platform: 'win32', timeoutMs: 20, spawn: fakeSpawn((child) => { timeoutChild = child }) }), /超时/)
  assert.equal(timeoutChild.killed, true)
  const controller = new AbortController()
  let abortedChild
  await assert.rejects(sendWindowsToast({}, { platform: 'win32', signal: controller.signal, spawn: fakeSpawn((child) => { abortedChild = child; controller.abort() }) }), /取消/)
  assert.equal(abortedChild.killed, true)
})

test('Windows sender 拒绝系统错误和伪成功输出', { timeout: 5000 }, async () => {
  await assert.rejects(sendWindowsToast({}, { platform: 'win32', spawn: fakeSpawn((child) => { child.stderr.emit('data', Buffer.from('DisabledForUser')); child.emit('close', 1) }) }), /DisabledForUser/)
  await assert.rejects(sendWindowsToast({}, { platform: 'win32', spawn: fakeSpawn((child) => { child.stdout.emit('data', Buffer.from('{"accepted":false}')); child.emit('close', 0) }) }), /未确认/)
})

test('真实 Windows 超时清理不留下 PowerShell 发送进程', { timeout: 10000, skip: process.platform !== 'win32' }, async () => {
  let helper
  try {
    await assert.rejects(sendWindowsToast({}, {
      timeoutMs: 200,
      spawn: (executable, _args, options) => {
        helper = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'], options)
        return helper
      }
    }), /超时/)
    assert.throws(() => process.kill(helper.pid, 0), { code: 'ESRCH' })
  } finally {
    if (helper && helper.exitCode === null && helper.signalCode === null) helper.kill()
  }
})
