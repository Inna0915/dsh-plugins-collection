import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMonitor } from './monitor.js'
import { createRecordStore } from './record-store.js'

const sessionId = '01a11eb4-00e8-7cf2-b055-76405cff7cf8'
const oldTime = '2026-10-09T03:28:25.424Z'

test('清理只针对指定轮次，默认刷新、定向刷新和重启均不重新加入', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-dismiss-'))
  const file = join(directory, 'records.json')
  let session = { sessionId, status: 'running', observedAt: oldTime, title: 'stale turn' }
  const source = { queryDefault: async () => ({ sessions: [session] }), querySession: async () => session }
  const store = createRecordStore({ file })
  let monitor = createMonitor(source, { recordStore: store })
  t.after(async () => { monitor.close(); await rm(directory, { recursive: true, force: true }) })
  monitor.requestDefault(); await monitor.waitForIdle()
  assert.equal((await store.list()).has(sessionId), true)
  const result = await monitor.dismissRunning(sessionId, oldTime)
  assert.equal(result.status, 'record')
  assert.equal((await store.list()).has(sessionId), false)
  monitor.requestDefault(); await monitor.waitForIdle()
  monitor.requestSession(sessionId); await monitor.waitForIdle()
  assert.equal(monitor.snapshot().sessions[0].status, 'record')
  assert.equal((await store.list()).has(sessionId), false)
  monitor.close()
  monitor = createMonitor(source, { recordStore: createRecordStore({ file }) })
  monitor.requestDefault(); await monitor.waitForIdle()
  assert.equal(monitor.snapshot().sessions[0].status, 'record')
  session = { ...session, observedAt: '2026-10-10T07:00:00.000Z' }
  monitor.requestDefault(); await monitor.waitForIdle()
  assert.equal(monitor.snapshot().sessions[0].status, 'running')
  assert.equal((await store.list()).has(sessionId), true)
  await monitor.dismissRunning(sessionId, session.observedAt)
  assert.equal((await store.readState()).dismissedRuns.get(sessionId), session.observedAt)
})

test('新轮次和状态变化时拒绝旧清理请求', async () => {
  let session = { sessionId, status: 'running', observedAt: oldTime }
  const monitor = createMonitor({ queryDefault: async () => ({ sessions: [session] }), querySession: async () => session })
  try {
    monitor.requestDefault(); await monitor.waitForIdle()
    session = { ...session, observedAt: '2026-10-10T07:00:00.000Z' }
    await assert.rejects(monitor.dismissRunning(sessionId, oldTime), { status: 409 })
    monitor.requestDefault(); await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'running')
    session = { ...session, status: 'turn_completed' }
    await assert.rejects(monitor.dismissRunning(sessionId, session.observedAt), { status: 409 })
  } finally { monitor.close() }
})

test('其他会话的记入与审核保留已有清理标记', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-dismiss-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createRecordStore({ file: join(directory, 'records.json') })
  await store.dismissRunning(sessionId, oldTime)
  await store.remember('other')
  await store.removeMany(['other'])
  await store.remember('other-again')
  await store.remove('other-again')
  assert.equal((await store.readState()).dismissedRuns.get(sessionId), oldTime)
})
