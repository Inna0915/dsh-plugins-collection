import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { apply, askOnce, buildPrompt, resolveRoute, SAMPLE } from './index.js'

function fakeLlm(chunks, seen = {}) {
  return {
    listProviders: () => ['magpie'],
    async prepareCall(config, signal, configure) {
      seen.prepare = config
      const controls = configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'off' }, { id: 'max' }] } })
      const resolved = { provider: config.provider, model: config.model, ...controls }
      return {
        config: resolved,
        async * stream(options) {
          seen.options = options
          for (const chunk of chunks) yield chunk
        }
      }
    }
  }
}

const okChunks = [
  { type: 'block-start', index: 0 },
  { type: 'reasoning-delta', index: 0, text: '思考' },
  { type: 'text-delta', index: 1, text: '具，通"俱"，' },
  { type: 'text-delta', index: 1, text: '全、都。' },
  { type: 'usage', usage: { inputTokens: 80, outputTokens: 12, totalTokens: 92 } },
  { type: 'finish', reason: { kind: 'stop' } }
]

test('askOnce: isolated request-only input, least effort, text-only assembly', async () => {
  const seen = {}
  const result = await askOnce(fakeLlm(okChunks, seen), { provider: 'magpie', model: 'flash', source: 'config' }, SAMPLE)
  assert.equal(result.ok, true)
  assert.equal(result.text, '具，通"俱"，全、都。')
  assert.equal(result.route.reasoningEffort, 'off')
  assert.equal(result.route.maxTokens, 400)
  assert.deepEqual(result.usage, { inputTokens: 80, outputTokens: 12, totalTokens: 92 })
  assert.equal(seen.options.messages.length, 1)
  assert.equal(seen.options.messages[0].role, 'user')
  assert.equal('id' in seen.options.messages[0], false, 'request-only input carries no persistent id')
  assert.ok(Object.isFrozen(seen.options.messages[0].content[0]))
  assert.equal(seen.options.tools, undefined)
  assert.equal(seen.options.sessionId, undefined)
  assert.match(seen.options.system, /书童/)
})

test('askOnce: terminal error finish is reported, not thrown', async () => {
  const failure = { code: 'AUTH', message: 'bad key' }
  const result = await askOnce(fakeLlm([{ type: 'finish', reason: { kind: 'error', failure } }]), { provider: 'p', model: 'm' }, {})
  assert.equal(result.ok, false)
  assert.deepEqual(result.failure, failure)
})

test('resolveRoute: config first, then agentDefaultModel, else null', () => {
  const fallback = { currentSelection: () => ({ provider: 'a', model: 'b', reasoningEffort: 'xhigh' }) }
  assert.deepEqual(resolveRoute({ provider: 'p', model: 'm' }, fallback), { provider: 'p', model: 'm', source: 'config' })
  assert.deepEqual(resolveRoute({}, fallback), { provider: 'a', model: 'b', source: 'agent-default-model' })
  assert.equal(resolveRoute({}, null), null)
})

test('buildPrompt clips user input', () => {
  const prompt = buildPrompt({ title: 'x'.repeat(500), selection: '百废具兴' })
  assert.ok(prompt.includes('《' + 'x'.repeat(60) + '》'))
  assert.ok(prompt.includes('「百废具兴」'))
})

test('apply: no agent tool unless the headless self-test asks for one', () => {
  const previous = process.env.VIBE_READER_SPIKE_SELFTEST
  try {
    delete process.env.VIBE_READER_SPIKE_SELFTEST
    const everyday = {}
    apply({ inject(deps, callback) { everyday[deps[0]] = callback } }, {})
    assert.deepEqual(Object.keys(everyday).sort(), ['agentDefaultModel', 'connection', 'llm'])

    process.env.VIBE_READER_SPIKE_SELFTEST = 'unused-in-this-test.json'
    const selfTest = {}
    let tool
    apply({ inject(deps, callback) { selfTest[deps[0]] = callback } }, {})
    selfTest.tools({ tools: { register: (options) => { tool = options } } })
    assert.equal(tool.name, 'vibe_reader_spike_check')
  } finally {
    if (previous === undefined) delete process.env.VIBE_READER_SPIKE_SELFTEST
    else process.env.VIBE_READER_SPIKE_SELFTEST = previous
  }
})

test('apply: optional services, HTTP route answers GET diagnostics and POST asks', async () => {
  const injected = {}
  let route
  const ctx = {
    inject(deps, callback) { injected[deps[0]] = callback }
  }
  apply(ctx, { provider: 'magpie', model: 'flash' })
  const child = (extra) => ({ effect: (action) => action(), ...extra })
  injected.llm(child({ llm: fakeLlm(okChunks) }))
  injected.connection(child({ connection: { fetch: { register: (options) => { route = options } } } }))
  assert.equal(route.path, '/api/vibe-reader-spike/ask')

  const diag = await (await route.fetch(new Request('http://x/api', { method: 'GET' }))).json()
  assert.equal(diag.llm, true)
  assert.equal(diag.route.source, 'config')

  const answer = await (await route.fetch(new Request('http://x/api', { method: 'POST', body: '{"selection":"百废具兴"}' }))).json()
  assert.equal(answer.ok, true)
  assert.equal(answer.text, '具，通"俱"，全、都。')

  const bad = await route.fetch(new Request('http://x/api', { method: 'POST', body: '{' }))
  assert.equal(bad.status, 400)
})

async function loadClient() {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let plugin
  runInNewContext(source, {
    window: { __ModuleLoader__: { load({ id, factory }) { assert.equal(id, 'dsh-vibe-reader-spike'); plugin = factory(() => ({})) } } },
    Date
  })
  return plugin
}

test('client: track turn start/end/needs-you from sessionStatus snapshots', async () => {
  const { track } = (await loadClient()).__test
  let state = track(new Map(), new Map([['s1', { running: false }]]), 0)
  assert.equal(state.events.length, 0)
  state = track(state.next, new Map([['s1', { running: true }]]), 1000)
  assert.equal(state.events[0].type, 'turn-start')
  state = track(state.next, new Map([['s1', { running: true, pendingInteraction: { kind: 'approval' } }]]), 10000)
  assert.equal(state.events[0].type, 'needs-you')
  assert.equal(state.next.get('s1').pendingKind, 'approval')
  state = track(state.next, new Map([['s1', { running: false }]]), 21000)
  assert.equal(state.events[0].type, 'turn-end')
  assert.equal(state.events[0].ms, 20000)
  assert.equal(state.next.get('s1').lastMs, 20000)
})

function row(id, extra = {}) {
  return { id, displayTitle: '会话' + id, running: false, blank: false, updatedAt: 0, retainedBy: {}, ...extra }
}

test('client: boardView aggregates every top-level session, not the panel session', async () => {
  const { track, boardView } = (await loadClient()).__test
  const list = {
    ids: ['a', 'b', 'c', 'd', 'sub', 'blank'],
    byId: {
      a: row('a', { retainedBy: { mainView: 1 } }),
      b: row('b'),
      c: row('c'),
      d: row('d'),
      sub: row('sub', { origin: 'subagent', parentId: 'b' }),
      blank: row('blank', { blank: true })
    }
  }
  const status = (entries) => new Map(Object.entries(entries))
  let t = track(new Map(), status({ a: { running: false }, b: { running: false }, c: { running: false }, d: { running: false }, sub: { running: false }, blank: { running: false } }), 0)
  t = track(t.next, status({ a: { running: false }, b: { running: true }, c: { running: true }, d: { running: false }, sub: { running: true }, blank: { running: false } }), 1000)

  let view = boardView(t.next, list, 5000)
  assert.equal(view.tone, 'waiting', 'longest run 4 s is under the 8 s threshold')
  assert.deepEqual(Array.from(view.running, (item) => item.id), ['b', 'c'], 'subagent rows are not listed')
  assert.equal(view.topLevel, 4)
  assert.equal(boardView(t.next, list, 9500).tone, 'reading-window')

  t = track(t.next, status({ a: { running: false }, b: { running: true }, c: { running: false, completionUnread: true }, d: { running: true, pendingInteraction: { kind: 'question' } } }), 12000)
  view = boardView(t.next, list, 12000)
  assert.equal(view.tone, 'needs-you')
  assert.equal(view.needsYou[0].id, 'd')
  assert.equal(view.needsYou[0].pendingKind, 'question')
  assert.equal(view.done[0].id, 'c')
  assert.equal(view.done[0].lastMs, 11000)
  assert.equal(view.done[0].title, '会话c')

  t = track(t.next, status({ a: { running: false }, b: { running: true }, c: { running: false }, d: { running: true } }), 13000)
  assert.equal(boardView(t.next, list, 13000).tone, 'reading-window', 'opening c clears its completionUnread')
})

test('client: boardView keeps a short done hold for the main-view session only', async () => {
  const { track, boardView } = (await loadClient()).__test
  const list = { ids: ['a', 'b'], byId: { a: row('a', { retainedBy: { mainView: 1 } }), b: row('b') } }
  let t = track(new Map(), new Map([['a', { running: true }], ['b', { running: true }]]), 0)
  t = track(t.next, new Map([['a', { running: false }], ['b', { running: false }]]), 30000)
  const view = boardView(t.next, list, 40000)
  assert.deepEqual(Array.from(view.done, (item) => item.id), ['a'], 'b has no completionUnread, so the host says it was already seen')
  assert.equal(view.done[0].isMain, true)
  assert.equal(boardView(t.next, list, 30000 + 61000).tone, 'idle')
})

test('client: boardView without a session list still works with fallback titles', async () => {
  const { track, boardView } = (await loadClient()).__test
  const t = track(new Map([['session-123456', { running: false }]]), new Map([['session-123456', { running: true }]]), 0)
  const view = boardView(t.next, undefined, 1000)
  assert.equal(view.running[0].title, '未命名会话 123456')
})

function fakeMounted(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of listeners) fn() },
    listeners
  }
}

test('client: follower carries the panel only when it was visible in the session being left', async () => {
  const { createFollower } = (await loadClient()).__test
  const mounted = fakeMounted('s1')
  const visible = new Set(['s1'])
  const opened = []
  const tasks = []
  let enabled = true
  const stop = createFollower({
    mounted,
    isVisible: (id) => visible.has(id),
    enabled: () => enabled,
    open: (id) => opened.push(id),
    schedule: (task) => tasks.push(task)
  })()

  mounted.set('s2')                      // reading in s1 -> carried to s2
  tasks.splice(0).forEach((task) => task())
  assert.deepEqual(opened, ['s2'])

  visible.clear()                        // s2 shows another tab or the sidebar is collapsed
  mounted.set('s3')
  tasks.splice(0).forEach((task) => task())
  assert.deepEqual(opened, ['s2'], 'not reading -> the arriving sidebar is left alone')

  visible.add('s3')                      // reading in s3, then Settings fills the main column, then s4
  mounted.set(undefined)
  mounted.set('s4')
  tasks.splice(0).forEach((task) => task())
  assert.deepEqual(opened, ['s2', 's4'], 'a global panel in between keeps the reading fact')

  visible.add('s4')
  mounted.set('s5')
  mounted.set('s6')                      // switched again before the deferred open ran
  tasks.splice(0).forEach((task) => task())
  assert.deepEqual(opened, ['s2', 's4'], 'a stale carry-over is dropped')
  // s5 was never visible, so leaving it does not carry either.

  enabled = false
  visible.add('s6')
  mounted.set('s7')
  tasks.splice(0).forEach((task) => task())
  assert.deepEqual(opened, ['s2', 's4'], 'switch off -> no carry-over')

  stop()
  assert.equal(mounted.listeners.size, 0)
})

test('client: tracker subscribes to ctx.uiSession.sessionStatus and registers the tab', async () => {
  const plugin = await loadClient()
  assert.ok(plugin.inject.includes('uiSession'))
  assert.ok(plugin.inject.includes('sessions'))
  assert.ok(plugin.inject.includes('uiWorkspace'))
  assert.ok(plugin.inject.includes('sidebarRight'))
  let snapshot = new Map([['s1', { running: false }]])
  const listeners = new Set()
  const sessionStatus = { getSnapshot: () => snapshot, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } }
  const disposers = []
  let tab
  plugin.apply({
    effect: (action) => { disposers.push(action()) },
    uiSession: { sessionStatus },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } },
    uiWorkspace: { openSession: () => {} },
    sidebarRightTabs: { register: (value) => { tab = value } },
    slots: { inject: (_slot, register) => register(), register: () => {} }
  })
  assert.equal(tab.kind, 'vibe-reader-spike')
  assert.equal(tab.keepMounted, true)
  assert.equal(listeners.size, 1)
  disposers[0]()
  assert.equal(listeners.size, 0, 'unsubscribes on dispose')

  let now = 0
  const tracker = plugin.__test.createTracker(sessionStatus, () => now)
  const stop = tracker.start()
  let notified = 0
  tracker.subscribe(() => { notified++ })
  now = 2000
  snapshot = new Map([['s1', { running: true }]])
  for (const fn of listeners) fn()
  now = 7000
  snapshot = new Map([['s1', { running: false }]])
  for (const fn of listeners) fn()
  assert.equal(notified, 2)
  assert.deepEqual(Array.from(tracker.getSnapshot().events, (event) => event.type), ['turn-end', 'turn-start'])
  assert.equal(tracker.getSnapshot().events[0].ms, 5000)
  stop()
})

test('client: missing sessionStatus degrades without throwing', async () => {
  const plugin = await loadClient()
  assert.doesNotThrow(() => plugin.apply({
    effect: (action) => action(),
    uiSession: undefined,
    sessions: undefined,
    uiWorkspace: undefined,
    sidebarRight: undefined,
    sidebarRightTabs: { register: () => {} },
    slots: { inject: (_slot, register) => register(), register: () => {} }
  }))
})
