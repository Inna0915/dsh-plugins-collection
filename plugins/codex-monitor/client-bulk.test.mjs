import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
let registration
runInNewContext(source, { window: { __ModuleLoader__: { load: (value) => { registration = value } } } })
const { reviewSelectedSessions } = registration.factory(() => ({}))

test('客户端优先使用批量接口，不在服务错误后重复提交单条审核', async () => {
  const calls = []
  const result = await reviewSelectedSessions(['one', 'one'], async (path, options) => {
    calls.push({ path, ids: [...options.body.sessionIds] })
    return { reviewedCount: 1 }
  })
  assert.equal(result.reviewedCount, 1)
  assert.deepEqual(calls, [{ path: '/codex-monitor/review-all', ids: ['one'] }])
  let attempts = 0
  await assert.rejects(reviewSelectedSessions(['one'], async () => { attempts++; throw Object.assign(new Error('failed'), { status: 500 }) }), /failed/)
  assert.equal(attempts, 1)
})

test('旧宿主缓存兼容：刷新后只审核所选待审核记录，跳过运行中并报告部分失败', async () => {
  let generation = 0
  const reviewed = []
  const send = async (path, options) => {
    if (path.endsWith('/review-all')) throw Object.assign(new Error('not available'), { status: 405 })
    if (path.endsWith('/refresh')) { generation++; return { accepted: true } }
    if (path.endsWith('/sessions')) return {
      generatedAt: String(generation), refreshing: false, health: { index: 'ok', records: 'ok' },
      sessions: [
        { sessionId: 'pending', status: 'turn_completed' }, { sessionId: 'running', status: 'running' },
        { sessionId: 'hidden', status: 'turn_completed' }, { sessionId: 'failed', status: 'turn_completed' }
      ]
    }
    if (path.endsWith('/review-completed')) {
      if (options.body.sessionId === 'failed') throw Object.assign(new Error('disk full'), { status: 500 })
      reviewed.push(options.body.sessionId)
      return { reviewed: true }
    }
    throw new Error('unexpected route')
  }
  const result = await reviewSelectedSessions(['pending', 'running', 'failed'], send)
  assert.deepEqual(reviewed, ['pending'])
  assert.equal(result.reviewedCount, 1)
  assert.equal(result.skippedIds[0], 'running')
  assert.equal(result.failures[0].sessionId, 'failed')
  assert.equal(generation, 1)
})
