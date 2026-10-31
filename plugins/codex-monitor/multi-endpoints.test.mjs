import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

test('宿主可选 DSH 接入贯通列表、预览和审核接口，拒绝跨路径 ID', { timeout: 15000 }, async () => {
  const routes = new Map(); const cleanup = []
  const previousHome = process.env.DSH_HOME
  const previousNotifications = process.env.CODEX_MONITOR_NOTIFICATIONS
  const home = await mkdtemp(join(tmpdir(), 'multi-endpoints-'))
  process.env.DSH_HOME = home
  process.env.CODEX_MONITOR_NOTIFICATIONS = '0'
  const header = { id: 'endpoint-test', createdAt: Date.now() - 5000 }
  const events = [{ type: 'turn/start', time: Date.now() - 1000, data: {} }, { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: 'question' } }]
  const ctx = {
    logger: { info() {}, warn() {} }, sessions: { get: () => ({ seq: events.length }) },
    sessionQuery: { listSessions: async () => [{ header }], readSession: async () => ({ session: header, events }) },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    effect(setup) { const close = setup(); if (typeof close === 'function') cleanup.push(close) },
    inject(dependencies, activate) { if (dependencies.includes('sessionQuery')) activate(ctx) }
  }
  async function call(path, body, method = 'POST') {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { 'content-type': 'application/json' }
    let status; let result
    await routes.get('/codex-monitor/' + path)(req, { writeHead(code) { status = code }, end(json) { result = JSON.parse(json) } })
    return { status, result }
  }
  async function ready(predicate) {
    for (let i = 0; i < 100; i++) {
      const snapshot = (await call('sessions', undefined, 'GET')).result
      if (predicate(snapshot)) return snapshot
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('monitor did not refresh')
  }
  apply(ctx)
  try {
    await ready((snapshot) => snapshot.sessions.some((session) => session.sessionId === 'dsh:endpoint-test'))
    const preview = await call('conversation', { sessionId: 'dsh:endpoint-test' })
    assert.equal(preview.status, 200); assert.equal(preview.result.messages[0].text, 'question')
    assert.equal((await call('review-completed', { sessionId: 'dsh:endpoint-test' })).status, 400)
    assert.equal((await call('conversation', { sessionId: 'dsh:../../config' })).status, 400)
    events.push({ type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
    assert.equal((await call('refresh', { sessionId: 'dsh:endpoint-test' })).status, 202)
    await ready((snapshot) => snapshot.sessions.find((session) => session.sessionId === 'dsh:endpoint-test')?.status === 'turn_completed')
    const reviewed = await call('review-completed', { sessionId: 'dsh:endpoint-test' })
    assert.equal(reviewed.status, 200); assert.equal(reviewed.result.session.status, 'record')
    assert.equal(events.length, 3)
    assert.equal((await call('refresh', { sessionId: 'claude:valid-id' })).status, 202)
    for (const path of ['refresh', 'review-completed', 'conversation', 'dismiss-running']) {
      assert.equal((await call(path, { sessionId: 'kimi:../../secret' })).status, 400)
    }
  } finally {
    for (const close of cleanup.reverse()) await close()
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    if (previousNotifications === undefined) delete process.env.CODEX_MONITOR_NOTIFICATIONS; else process.env.CODEX_MONITOR_NOTIFICATIONS = previousNotifications
    await rm(home, { recursive: true, force: true })
  }
})
