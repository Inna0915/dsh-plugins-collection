import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDshSource } from './dsh-source.js'
import { createMonitor } from './monitor.js'
import { createCompletionNotifications } from './notifications.js'

const startedAt = '2026-10-26T05:40:00.000Z'
const turnAt = '2026-10-26T05:47:00.000Z'
const completedAt = '2026-10-26T06:00:00.000Z'
const start = { seq: 0, type: 'turn/start', time: turnAt, data: { turn: 1 } }
const end = kind => ({ seq: 2, type: 'turn/end', time: completedAt, data: { reason: { kind } } })

function fixture() {
  const header = { id: 'session-external', cwd: '/work/external', createdAt: turnAt }
  let events = [start, { seq: 1, type: 'tool/call', time: turnAt, data: {} }]
  let revision = 1
  let live = false
  let failure = false
  const calls = { list: 0, open: 0, read: 0, close: 0, observe: 0 }
  const persistence = {
    identity: Symbol('persistence'),
    async list() { calls.list++; return [{ header, revision }] },
    async stat() { return { header, revision } },
    async open(id, mode) {
      assert.equal(id, header.id)
      assert.equal(mode, 'read', 'monitor must never acquire a writer or repair the log')
      calls.open++
      return { header,
        async read(offset) {
          assert.equal(offset, 0)
          calls.read++
          if (failure) throw new Error('read failed')
          return { events }
        },
        async close() { calls.close++ }
      }
    }
  }
  const ctx = {
    get: () => ({ ...persistence }),
    sessions: { get: () => live ? { seq: 10 } : null, list: () => live ? [{ id: header.id, header }] : [] },
    sessionQuery: {
      async observeSession() {
        calls.observe++
        return { header, events: live ? [start] : [...events, end('interrupted')], source: live ? 'live' : 'prepared', cursor: 9, [Symbol.dispose]() {} }
      }
    }
  }
  return { ctx, calls, persistence, id: `dsh:${header.id}`, source: createDshSource(ctx),
    append(event) { events = [...events, event]; revision++ },
    setLive(value) { live = value }, fail(value) { failure = value }
  }
}

test('其他 DSH Host 仍执行的会话读取真实日志，不消费冷查询伪造的 interrupted 结束事件', async () => {
  const f = fixture()
  const [row] = await f.source.queryAll()
  assert.equal(row.status, 'running')
  assert.equal(row.lifecycleEvent, 'turn_started')
  assert.equal(row.observedAt, turnAt)
  assert.match(row.statusReason, /外部 DSH/)
  assert.deepEqual(f.calls, { list: 1, open: 1, read: 1, close: 1, observe: 0 })
})

test('原始日志未变化复用缓存；真实结束事件落盘后按 revision 刷新', async () => {
  const f = fixture()
  await f.source.queryAll()
  await f.source.queryAll()
  assert.equal(f.calls.read, 1)
  f.append(end('completed'))
  const row = await f.source.querySession(f.id)
  assert.equal(row.status, 'turn_completed')
  assert.equal(row.lifecycleEvent, 'turn_completed')
  assert.equal(row.observedAt, completedAt)
  assert.equal(f.calls.read, 2)
  assert.equal(f.calls.close, 2)
})

test('当前 Host 已加载的实时会话优先于磁盘上的旧结束状态', async () => {
  const f = fixture()
  f.append(end('completed'))
  await f.source.queryAll()
  f.setLive(true)
  assert.equal((await f.source.querySession(f.id)).status, 'running')
  assert.equal(f.calls.open, 1)
  assert.equal(f.calls.observe, 1)
})

test('读取失败关闭只读句柄，不缓存失败；恢复读取后可以显示运行状态', async () => {
  const f = fixture()
  f.fail(true)
  assert.deepEqual(await f.source.queryAll(), [])
  assert.equal(f.source.health().status, 'degraded')
  assert.equal(f.calls.close, 1)
  f.fail(false)
  assert.equal((await f.source.queryAll())[0].status, 'running')
  assert.equal(f.calls.close, 2)
})

test('运行中不能审核，真实正常结束后进入待审核并且只通知一次', { timeout: 5000 }, async () => {
  const f = fixture()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-persisted-status-'))
  const sent = []
  const notifications = createCompletionNotifications({ supported: true, enabled: true, startedAt,
    file: join(directory, 'notifications.json'), send: async payload => sent.push(payload) })
  const source = { queryDefault: async () => ({ sessions: await f.source.queryAll() }), querySession: f.source.querySession }
  const monitor = createMonitor(source, { now: () => startedAt, trackCompletedTurns: true, onSessionObserved: notifications.observe })
  try {
    monitor.requestDefault(); await monitor.waitForIdle(); await notifications.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'running')
    assert.equal(sent.length, 0)
    await assert.rejects(monitor.reviewCompleted(f.id), /仅待审核/)
    f.append(end('completed'))
    monitor.requestDefault(); await monitor.waitForIdle(); await notifications.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'turn_completed')
    assert.equal(sent.length, 1)
    monitor.requestDefault(); await monitor.waitForIdle(); await notifications.waitForIdle()
    assert.equal(sent.length, 1)
  } finally {
    monitor.close()
    await notifications.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('原始日志中的真实中断仍归入待审核，但不伪装成正常完成', async () => {
  const f = fixture()
  f.append(end('interrupted'))
  const row = await f.source.querySession(f.id)
  assert.equal(row.status, 'turn_completed')
  assert.equal(row.lifecycleEvent, 'turn_aborted')
  assert.match(row.statusReason, /interrupted/)
})
