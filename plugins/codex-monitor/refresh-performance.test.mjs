import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshSource } from './dsh-source.js'

function fixture() {
  const headers = Array.from({ length: 62 }, (_, i) => ({ id: `session-${i}`, createdAt: 1000 + i }))
  const revisions = new Map(headers.map((header) => [header.id, 'one']))
  let identity = Symbol('persistence')
  let alive = null
  const calls = { list: 0, stat: 0, observe: 0, dispose: 0, legacy: 0 }
  const ctx = {
    // Deliberately create a fresh service wrapper on every call, as Contexts can.
    get: () => ({ identity, async list() { calls.list++; return headers.map((header) => ({ header, revision: revisions.get(header.id) })) },
      async stat(id) { calls.stat++; return { header: headers.find((header) => header.id === id), revision: revisions.get(id) } } }),
    sessions: { list: () => alive ? [alive] : [], get: (id) => alive?.id === id ? alive : null },
    sessionQuery: {
      async listSessions() { calls.legacy++; throw new Error('unexpected full corpus query') },
      async readSession() { calls.legacy++; throw new Error('unexpected full corpus replay') },
      async observeSession(id, options) {
        assert.equal(options.projectionMode, 'none')
        calls.observe++
        const live = ctx.sessions.get(id)
        return { header: headers.find((header) => header.id === id), revision: revisions.get(id), source: live ? 'live' : 'prepared',
          cursor: live ? live.seq - 1 : 1,
          events: [{ type: live ? 'turn/start' : 'turn/end', time: '2026-10-25T07:00:00Z', data: { reason: { kind: 'completed' } } }],
          [Symbol.dispose]() { calls.dispose++ } }
      }
    }
  }
  return { ctx, calls, revisions, replace() { identity = Symbol('replacement') }, live(value) { alive = value ? { id: headers[0].id, header: headers[0], seq: value } : null } }
}

test('62 条 DSH 会话首次只列目录一次；未变更刷新不逐条 stat、不重读日志，服务代理不破坏缓存', async () => {
  const f = fixture(); const source = createDshSource(f.ctx)
  assert.equal((await source.queryAll()).length, 62)
  assert.deepEqual(f.calls, { list: 1, stat: 0, observe: 62, dispose: 62, legacy: 0 })
  await source.queryAll(); await source.queryAll()
  assert.deepEqual(f.calls, { list: 3, stat: 0, observe: 62, dispose: 62, legacy: 0 })
  f.revisions.set('session-3', 'two')
  await source.queryAll()
  assert.equal(f.calls.observe, 63)
  assert.equal(f.calls.dispose, 63)
  f.replace(); await source.queryAll()
  assert.equal(f.calls.observe, 125)
})

test('DSH 实时轮次 seq 改变、进入或退出实时状态时重新读取；定向审核仍核对最新 revision', async () => {
  const f = fixture(); const source = createDshSource(f.ctx)
  await source.queryAll(); f.live(2)
  assert.equal((await source.queryAll()).find((row) => row.nativeSessionId === 'session-0').status, 'running')
  assert.equal(f.calls.observe, 63)
  f.live(3); await source.queryAll(); assert.equal(f.calls.observe, 64)
  f.live(null)
  assert.equal((await source.queryAll()).find((row) => row.nativeSessionId === 'session-0').status, 'turn_completed')
  f.revisions.set('session-0', 'new revision')
  await source.querySession('dsh:session-0')
  assert.equal(f.calls.stat, 1)
  assert.equal(f.calls.observe, 66)
})

test('DSH 投影或解析失败仍释放 observation，错误不缓存为正常会话', async () => {
  const f = fixture(); const source = createDshSource(f.ctx)
  f.ctx.sessionQuery.observeSession = async () => ({ header: { id: 'session-0' },
    get events() { throw new Error('corrupt') }, [Symbol.dispose]() { f.calls.dispose++ } })
  assert.equal((await source.queryAll()).length, 0)
  assert.equal(source.health().status, 'degraded')
  assert.equal(f.calls.dispose, 62)
})
