import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMonitor } from './monitor.js'
import { createRecordStore } from './record-store.js'

test('批量审核仅处理指定的待审核记录，跳过正在运行和已重新运行的会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bulk-review-'))
  const rows = new Map([
    ['selected', { sessionId: 'selected', status: 'turn_completed' }],
    ['hidden', { sessionId: 'hidden', status: 'turn_completed' }],
    ['running', { sessionId: 'running', status: 'running' }],
    ['resumed', { sessionId: 'resumed', status: 'turn_completed' }],
    ['unreadable', { sessionId: 'unreadable', status: 'turn_completed' }]
  ])
  const recordStore = createRecordStore({ file: join(root, 'running.json') })
  const source = {
    queryDefault: async () => ({ sessions: [...rows.values()] }),
    querySession: async (id) => { if (id === 'unreadable') throw new Error('source unavailable'); return rows.get(id) || null }
  }
  const monitor = createMonitor(source, { recordStore })
  try {
    for (const id of [...rows.keys(), 'missing']) await recordStore.remember(id)
    monitor.requestDefault()
    await monitor.waitForIdle()
    rows.set('resumed', { sessionId: 'resumed', status: 'running' })
    const result = await monitor.reviewAllCompleted(['selected', 'selected', 'missing', 'running', 'resumed', 'unreadable'])
    assert.deepEqual(new Set(result.reviewedIds), new Set(['selected', 'missing']))
    assert.equal(result.reviewedCount, 2)
    assert.deepEqual(new Set(result.skippedIds), new Set(['running', 'resumed']))
    assert.equal(result.failures[0].sessionId, 'unreadable')
    assert.deepEqual(new Set((await recordStore.list()).keys()), new Set(['hidden', 'running', 'resumed', 'unreadable']))
    const snapshot = monitor.snapshot()
    assert.equal(snapshot.sessions.find((row) => row.sessionId === 'selected').status, 'record')
    assert.equal(snapshot.sessions.some((row) => row.sessionId === 'missing'), false)
    assert.equal(snapshot.sessions.find((row) => row.sessionId === 'resumed').status, 'running')
    monitor.requestDefault()
    await monitor.waitForIdle()
    assert.equal((await recordStore.list()).has('selected'), false)
    assert.equal((await monitor.reviewAllCompleted([])).reviewedCount, 0)
  } finally { monitor.close(); await rm(root, { recursive: true, force: true }) }
})

test('批量写入失败时保留待审核记录并报告存储故障', async () => {
  const row = { sessionId: 'pending', status: 'turn_completed' }
  const monitor = createMonitor({ queryDefault: async () => ({ sessions: [row] }), querySession: async () => row }, {
    recordStore: {
      list: async () => new Map([['pending', '2026-09-30T00:00:00Z']]),
      removeMany: async () => { throw new Error('disk full') }
    }
  })
  try {
    monitor.requestDefault()
    await monitor.waitForIdle()
    await assert.rejects(monitor.reviewAllCompleted(['pending']), /disk full/)
    assert.equal(monitor.snapshot().sessions[0].status, 'turn_completed')
    assert.equal(monitor.snapshot().health.records, 'degraded')
  } finally { monitor.close() }
})

test('短轮次在两次轮询之间结束也只登记一次，审核后不会重新进入待审核', async () => {
  let observedAt = '2026-09-29T00:00:00Z'
  const session = () => ({ sessionId: 'short', status: 'turn_completed', observedAt })
  const monitor = createMonitor({ queryDefault: async () => ({ sessions: [session()] }), querySession: async () => session() }, {
    trackCompletedTurns: true, now: () => '2026-09-30T00:00:00Z'
  })
  try {
    monitor.requestDefault(); await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'record')
    observedAt = '2026-09-30T00:00:05Z'
    monitor.requestDefault(); await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'turn_completed')
    await monitor.reviewAllCompleted(['short'])
    monitor.requestDefault(); await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'record')
  } finally { monitor.close() }
})
