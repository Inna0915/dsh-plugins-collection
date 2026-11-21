import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let plugin
  runInNewContext(source, {
    window: { __ModuleLoader__: { load({ id, factory }) { assert.equal(id, 'dsh-vibe-reader'); plugin = factory(() => ({})) } } },
    Date, Math, structuredClone, setTimeout, clearTimeout, console
  })
  return plugin
}
const plugin = await loadClient()
const t = plugin.__test

function hiddenString(masked) {
  return masked.paragraphs.map((tokens) => tokens.map((token) => token.hidden ? '□' : token.ch).join('')).join('|')
}

test('mask L0–L4: punctuation and paragraphs stay; the right characters hide', () => {
  const text = ['白日依山尽，黄河入海流。', '欲穷千里目，更上一层楼。']
  assert.equal(hiddenString(t.maskParagraphs(text, 0)), text.join('|'))
  assert.equal(hiddenString(t.maskParagraphs(text, 1)), '白日依山□，黄河入海□。|欲穷千里□，更上一层□。')
  assert.equal(hiddenString(t.maskParagraphs(text, 2)), '白日□山尽，□河入□流。|欲□千里□，更上□层楼。')
  assert.equal(hiddenString(t.maskParagraphs(text, 3)), '白□□□□，黄□□□□。|欲□□□□，更□□□□。')
  assert.equal(hiddenString(t.maskParagraphs(text, 4)), '□□□□□，□□□□□。|□□□□□，□□□□□。')
  const l5 = t.maskParagraphs(text, 5)
  assert.equal(l5.folded, true)
  assert.equal(l5.hanCount, 20)
})

test('mask L1 rotates with the round so each attempt hides different characters', () => {
  const text = ['甲乙丙丁戊己庚辛壬癸']
  const first = hiddenString(t.maskParagraphs(text, 1, 0))
  const second = hiddenString(t.maskParagraphs(text, 1, 1))
  assert.notEqual(first, second)
  assert.equal([...first].filter((ch) => ch === '□').length, 2)
})

test('mask L3: sentence starts after punctuation, quotes and line breaks', () => {
  const masked = t.maskParagraphs(['其必曰：“先天下之忧而忧”乎。', '国破山河在，\n城春草木深。'], 3)
  assert.equal(hiddenString(masked), '其□□：“先□□□□□□”乎。|国□□□□，\n城□□□□。')
})

test('glosses: first non-overlapping match, across paragraphs, in reading order', () => {
  const section = {
    paragraphs: [{ text: '举酒属客，诵明月之诗。', quotes: [] }, { text: '举匏樽以相属。', quotes: [] }],
    notes: [{ word: '属客', gloss: '劝酒' }, { word: '属', gloss: '劝' }, { word: '匏樽', reading: 'páo zūn', gloss: '酒器' }, { word: '没有', gloss: 'x' }]
  }
  const glosses = t.sectionGlosses(section)
  assert.deepEqual(Array.from(glosses[0], (g) => [g.start, g.end, g.note.word]), [[2, 4, '属客']])
  assert.deepEqual(Array.from(glosses[1], (g) => [g.start, g.end, g.note.word]), [[1, 3, '匏樽'], [5, 6, '属']])
})

test('textPieces splits by quote and gloss boundaries and places glosses after their word', () => {
  const pieces = t.textPieces('政通人和，百废具兴。', [{ start: 0, end: 9 }], [{ start: 7, end: 8, note: { word: '具' } }])
  assert.deepEqual(Array.from(pieces, (piece) => [piece.text, piece.quote, piece.noted, piece.glossesAfter.length]), [
    ['政通人和，百废', true, false, 0],
    ['具', true, true, 1],
    ['兴', true, false, 0],
    ['。', false, false, 0]
  ])
})

test('glossLines: reading over gloss when short, else halves', () => {
  assert.deepEqual(Array.from(t.glossLines({ reading: 'jù', gloss: '通“俱”，全、都' })), ['jù', '通“俱”，全、都'])
  assert.deepEqual(Array.from(t.glossLines({ gloss: '放晴' })), ['放晴', ''])
  assert.deepEqual(Array.from(t.glossLines({ gloss: '到了第二年。越，及、到' })), ['到了第二年。', '越，及、到'])
})

test('pickCard weights by times shown and never repeats the last card', () => {
  const cards = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
  const resurface = { a: { shown: 9 } }
  assert.equal(t.pickCard(cards, resurface, 'b', () => 0).key, 'a')
  assert.equal(t.pickCard(cards, resurface, 'b', () => 0.5).key, 'c', 'a weighs 0.1, c weighs 1')
  assert.equal(t.pickCard([{ key: 'only' }], {}, 'only', () => 0.3).key, 'only')
  assert.equal(t.pickCard([], {}, null), null)
})

test('fitsVertical: short poems only', () => {
  assert.equal(t.fitsVertical('白日依山尽，黄河入海流。\n欲穷千里目，更上一层楼。'), true)
  assert.equal(t.fitsVertical(Array(9).fill('甲乙').join('\n')), false)
  assert.equal(t.fitsVertical('甲'.repeat(15)), false)
})

function fakeServer() {
  let state = { ui: { view: 'encounter', volume: null }, volumes: {}, cards: {}, resurface: {}, settings: { readAfterSeconds: 10, followSessions: true, showGloss: true, vertical: false } }
  const calls = []
  const gates = []
  return {
    calls,
    gates,
    request: async (path, body) => {
      calls.push([path, body])
      if (path.endsWith('library')) return { volumes: [], cards: [], roots: [], state: structuredClone(state) }
      if (path.endsWith('state')) {
        if (body.fail) throw new Error('写入失败')
        if (body.gate) await new Promise((resolve) => gates.push(resolve))
        state = t.optimistic(state, body)
        return { state: structuredClone(state) }
      }
      throw new Error('unexpected ' + path)
    }
  }
}

function manualTimers() {
  const tasks = new Map()
  let id = 0
  return {
    schedule: (task) => { tasks.set(++id, task); return id },
    cancel: (handle) => { tasks.delete(handle) },
    run() { const all = [...tasks.values()]; tasks.clear(); all.forEach((task) => task()) },
    get size() { return tasks.size }
  }
}

test('app store: progress is debounced, coalesced, and flushed before other ops', async () => {
  const server = fakeServer()
  const timers = manualTimers()
  const app = t.createAppStore({ request: server.request, schedule: timers.schedule, cancel: timers.cancel })
  await app.load()
  assert.equal(app.getSnapshot().status, 'ready')
  app.progress('v', 's1')
  app.progress('v', 's2')
  assert.equal(app.getSnapshot().state.volumes.v.lastSection, 's2', 'shown immediately')
  assert.equal(server.calls.filter(([path]) => path.endsWith('state')).length, 0)
  await app.send({ op: 'view', view: 'study' })
  const ops = server.calls.filter(([path]) => path.endsWith('state')).map(([, body]) => body.op + ':' + (body.sectionId || body.view))
  assert.deepEqual(ops, ['progress:s2', 'view:study'], 'one coalesced progress, sent first')
  assert.equal(timers.size, 0)
  assert.equal(app.getSnapshot().state.ui.view, 'study')
})

test('app store: in-flight ops stay applied on top of earlier responses; failures revert with a notice', async () => {
  const server = fakeServer()
  const timers = manualTimers()
  const app = t.createAppStore({ request: server.request, schedule: timers.schedule, cancel: timers.cancel })
  await app.load()
  const first = app.send({ op: 'settings', patch: { showGloss: false }, gate: true })
  const second = app.send({ op: 'level', key: 'v#s1', level: 3 })
  assert.equal(app.getSnapshot().state.cards['v#s1'].level, 3)
  while (!server.gates.length) await new Promise((resolve) => setTimeout(resolve, 1))
  server.gates[0]()
  await first
  assert.equal(app.getSnapshot().state.settings.showGloss, false)
  assert.equal(app.getSnapshot().state.cards['v#s1'].level, 3, 'second op still shown while in flight')
  await second
  await app.send({ op: 'level', key: 'v#s2', level: 2, fail: true })
  assert.equal(app.getSnapshot().state.cards['v#s2'], undefined, 'failed op reverted')
  assert.equal(app.getSnapshot().notice, '写入失败')
})

test('app store: autoPick picks once even when several panes ask', async () => {
  const server = fakeServer()
  const app = t.createAppStore({ request: server.request })
  await app.load()
  let picks = 0
  const picker = () => { picks++; return { key: 'v#s1' } }
  app.autoPick(picker)
  app.autoPick(picker)
  assert.equal(picks, 1)
  assert.equal(app.getSnapshot().encounterKey, 'v#s1')
})

test('boardView and follower behave as verified in the spike', () => {
  let tracked = t.track(new Map(), new Map([['a', { running: false }], ['b', { running: false }]]), 0)
  tracked = t.track(tracked, new Map([['a', { running: true }], ['b', { running: true, pendingInteraction: { kind: 'approval' } }]]), 1000)
  const view = t.boardView(tracked, { byId: { a: { displayTitle: '甲' }, b: { displayTitle: '乙' } } }, 20000)
  assert.equal(view.tone, 'needs-you')
  assert.equal(view.running[0].title, '甲')

  let value = 's1'
  const listeners = new Set()
  const mounted = { getSnapshot: () => value, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } }
  const opened = []
  const stop = t.createFollower({ mounted, isVisible: (id) => id === 's1', enabled: () => true, open: (id) => opened.push(id), schedule: (task) => task() })()
  value = 's2'
  listeners.forEach((fn) => fn())
  value = 's3'
  listeners.forEach((fn) => fn())
  assert.deepEqual(opened, ['s2'])
  stop()
})

test('apply: registers the tab, needs the verified services, survives a missing sessionStatus', () => {
  assert.deepEqual(Array.from(plugin.inject).sort(), ['layout', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'slots', 'uiSession', 'uiWorkspace'])
  let tab
  const disposers = []
  assert.doesNotThrow(() => plugin.apply({
    effect: (action) => { disposers.push(action()) },
    uiSession: undefined,
    sessions: undefined,
    sidebarRight: undefined,
    uiWorkspace: undefined,
    sidebarRightTabs: { register: (value) => { tab = value } },
    slots: { inject: (_slot, register) => register(), register: () => {} }
  }))
  assert.equal(tab.kind, 'vibe-reader')
  assert.equal(tab.keepMounted, true)
  assert.equal(tab.title(), '闲庭')
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
})

test('renderPlan keeps a glossed word, its gloss and the following punctuation together', () => {
  const pieces = t.textPieces('七月既望，苏子与客', [], [{ start: 2, end: 4, note: { word: '既望' } }])
  const plan = t.renderPlan(pieces)
  assert.deepEqual(Array.from(plan, (item) => [item.text, item.glosses.length, item.tail?.text ?? null]), [
    ['七月', 0, null],
    ['既望', 1, '，'],
    ['苏子与客', 0, null]
  ])
  const end = t.renderPlan(t.textPieces('属予作文以记之。', [], [{ start: 0, end: 1, note: { word: '属' } }]))
  assert.deepEqual(Array.from(end, (item) => [item.text, item.tail?.text ?? null]), [['属', null], ['予作文以记之。', null]])
})

test('app store reload keeps volumes whose file revision did not change', async () => {
  let revision = 'r1'
  let volumeFetches = 0
  const request = async (path, body) => {
    if (path.endsWith('library')) return { volumes: [{ id: 'v', revision }], cards: [], roots: [], state: { ui: {}, volumes: {}, cards: {}, resurface: {}, settings: {} } }
    if (path.endsWith('volume')) { volumeFetches++; return { volume: { id: body.id, revision, sections: [] } } }
    throw new Error(path)
  }
  const app = t.createAppStore({ request })
  await app.load()
  await app.ensureVolume('v')
  await app.load()
  assert.equal(app.getSnapshot().volumes.v.status, 'ready', 'unchanged file stays cached')
  await app.ensureVolume('v')
  assert.equal(volumeFetches, 1)
  revision = 'r2'
  await app.load()
  assert.equal(app.getSnapshot().volumes.v, undefined, 'edited file is fetched again')
  let loads = 0
  const counting = t.createAppStore({ request: async (path, body) => { if (path.endsWith('library')) loads++; return request(path, body) } })
  await counting.load()
  counting.refreshIfStale()
  assert.equal(loads, 1, 'no reload storm when several panes become visible together')
})

test('toNumeral writes traditional uppercase numerals for section order', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(t.toNumeral), ['壹', '貳', '參', '肆', '伍', '陸', '拾'])
  assert.deepEqual([11, 19, 20, 25, 47, 99].map(t.toNumeral), ['拾壹', '拾玖', '貳拾', '貳拾伍', '肆拾柒', '玖拾玖'])
  assert.deepEqual([100, 105, 110, 123].map(t.toNumeral), ['壹佰', '壹佰零伍', '壹佰壹拾', '壹佰貳拾參'])
  assert.equal(t.toNumeral(0), '0')
})

test('shelfItems: recent first (newest first), then library order; search title, author, tags', () => {
  const rows = [
    { id: 'a', title: '岳阳楼记', author: '范仲淹', dynasty: '宋', tags: ['楼记'], sectionIds: ['s1', 's2', 's3'], sectionCount: 3, errors: [] },
    { id: 'b', title: '前赤壁赋', author: '苏轼', dynasty: '宋', tags: [], sectionIds: ['s1', 's2'], sectionCount: 2, errors: [] },
    { id: 'c', title: '唐诗六首', author: '多家', dynasty: '唐', tags: ['唐诗'], sectionIds: ['s1'], sectionCount: 1, errors: [] },
    { file: 'broken.md', errors: ['x'] }
  ]
  const state = { volumes: { a: { lastSection: 's2', readAt: '2026-11-20T01:00:00Z' }, b: { lastSection: 's1', readAt: '2026-11-20T02:00:00Z' } } }
  const { recent, unread } = t.shelfItems(rows, state)
  assert.deepEqual(Array.from(recent, (item) => [item.row.id, item.position, item.total]), [['b', 1, 2], ['a', 2, 3]])
  assert.deepEqual(Array.from(unread, (item) => item.row.id), ['c'], 'rows without an id are left out')
  assert.deepEqual(Array.from(t.shelfItems(rows, state, '苏').recent, (item) => item.row.id), ['b'])
  assert.deepEqual(Array.from(t.shelfItems(rows, state, '唐诗').unread, (item) => item.row.id), ['c'])
  const moved = t.optimistic({ ui: {}, volumes: {}, cards: {}, resurface: {}, settings: {} }, { op: 'progress', volumeId: 'c', sectionId: 's1' })
  assert.ok(moved.volumes.c.readAt, 'opening a volume moves it to 最近读过 at once')
})

test('shelfItems finds poems inside volumes, by title or poem author, and filters', () => {
  const rows = [
    { id: 'tang', title: '唐诗六首', author: '多家', dynasty: '唐', kind: 'poem', tags: [], sectionIds: ['s1', 's2', 's3'], sectionCount: 3, errors: [],
      sectionList: [{ id: 's1', title: '登鹳雀楼', author: '唐 · 王之涣' }, { id: 's2', title: '春晓', author: '唐 · 孟浩然' }, { id: 's3', title: '春望', author: '唐 · 杜甫' }] },
    { id: 'yue', title: '岳阳楼记', author: '范仲淹', dynasty: '宋', kind: 'prose', tags: [], sectionIds: ['s1'], sectionCount: 1, errors: [], sectionList: [{ id: 's1', title: '作记缘由', author: '' }] }
  ]
  const state = { volumes: { yue: { lastSection: 's1', readAt: '2026-11-20T01:00:00Z' } }, cards: { 'tang#s3': { level: 5 } } }
  const byTitle = t.shelfItems(rows, state, '春望')
  assert.deepEqual(Array.from(byTitle.unread, (item) => item.row.id), ['tang'])
  assert.equal(byTitle.unread[0].own, false)
  assert.deepEqual(Array.from(byTitle.unread[0].sections, (section) => [section.id, section.position]), [['s3', 3]])
  assert.deepEqual(Array.from(t.shelfItems(rows, state, '杜甫').unread[0].sections, (section) => section.title), ['春望'])
  assert.deepEqual(Array.from(t.shelfItems(rows, state, '春').unread[0].sections, (section) => section.title), ['春晓', '春望'])
  assert.equal(t.shelfItems(rows, state, '唐诗').unread[0].sections.length, 0, 'a volume-level match lists no sections')
  assert.deepEqual(Array.from(t.shelfItems(rows, state, '', 'reciting').unread, (item) => item.row.id), ['tang'])
  assert.deepEqual(Array.from(t.shelfItems(rows, state, '', 'prose').recent, (item) => item.row.id), ['yue'])
  assert.equal(t.shelfItems(rows, state, '', 'unread').recent.length, 0)
})

test('apply registers a header button that opens the reader, or collapses it when showing', async () => {
  const registered = {}
  const calls = []
  let active = { id: 't1', kind: 'other' }
  let expanded = true
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let withReact
  const fakeReact = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }
  runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) { withReact = factory((name) => (name === 'react' ? fakeReact : undefined)) } } }, Date, Math, structuredClone, setTimeout, clearTimeout, console })
  withReact.apply({
    effect: (action) => action(),
    uiSession: undefined, sessions: undefined, uiWorkspace: undefined,
    sidebarRight: { active: () => active, isExpanded: () => expanded, hide: (id) => calls.push(['hide', id]), openTab: (kind) => calls.push(['open', kind]), mounted: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (slot, register) => register(), register: (meta, component) => { registered[meta.name] = { meta, component }; return () => {} } }
  })
  const header = registered['conversation.session.header.utilities']
  assert.equal(header.meta.id, 'vibe-reader')
  const button = header.component({})
  button.props.onClick()
  active = { id: 't2', kind: 'vibe-reader' }
  button.props.onClick()
  expanded = false
  button.props.onClick()
  assert.deepEqual(calls, [['open', 'vibe-reader'], ['hide', 't2'], ['open', 'vibe-reader']])
})

test('gloss modes: 句下 for poems and dense notes, 夹注 for sparse prose, saved choice wins', () => {
  const section = (text, notes) => ({ paragraphs: [{ text, quotes: [] }], notes })
  const prose = { id: 'p', kind: 'prose', sections: [section('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥', [{ word: '甲', gloss: 'x' }])] }
  const dense = { id: 'd', kind: 'prose', sections: [section('甲乙丙丁戊己庚辛', [{ word: '甲', gloss: 'x' }, { word: '丙', gloss: 'y' }])] }
  const poem = { id: 'q', kind: 'poem', sections: [section('天地玄黄', [])] }
  assert.equal(t.glossModeFor(prose, {}), 'inline')
  assert.equal(t.glossModeFor(dense, {}), 'below')
  assert.equal(t.glossModeFor(poem, {}), 'below')
  assert.equal(t.glossModeFor(poem, { volumes: { q: { glossMode: 'tap' } } }), 'tap')
  assert.equal(t.glossModeFor(prose, { settings: { showGloss: false } }), 'tap')
})

test('lineUnits keeps glosses and quotes on their own line; rubyOf only when syllables match', () => {
  const paragraph = { text: '天地玄黄，宇宙洪荒。\n日月盈昃，辰宿列张。', quotes: [{ start: 0, end: 9 }] }
  const glosses = [{ start: 2, end: 4, note: { word: '玄黄' } }, { start: 13, end: 15, note: { word: '盈昃' } }]
  const units = t.lineUnits(paragraph, glosses)
  assert.equal(units.length, 2)
  assert.deepEqual(Array.from(units[0].glosses, (g) => [g.start, g.end]), [[2, 4]])
  assert.deepEqual(Array.from(units[1].glosses, (g) => [g.start, g.end, g.note.word]), [[2, 4, '盈昃']])
  assert.deepEqual(Array.from(units[0].quotes, (q) => [q.start, q.end]), [[0, 9]])
  assert.equal(units[1].quotes.length, 0)
  assert.deepEqual(Array.from(t.rubyOf({ word: '盈昃', reading: 'yíng zè' })), ['yíng', 'zè'])
  assert.equal(t.rubyOf({ word: '巨阙', reading: 'què' }), null, '1 syllable for 2 characters goes in the note line')
  assert.equal(t.rubyOf({ word: '玄黄', gloss: 'x' }), null)
})

test('watchTurnEnds fires when any session stops running', () => {
  let snapshot = new Map([['a', { running: false }]])
  const listeners = new Set()
  const tracker = { getSnapshot: () => snapshot, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } }
  let ends = 0
  const stop = t.watchTurnEnds(tracker, () => { ends++ })
  const emit = (next) => { snapshot = next; listeners.forEach((fn) => fn()) }
  emit(new Map([['a', { running: true }], ['b', { running: true }]]))
  assert.equal(ends, 0)
  emit(new Map([['a', { running: false }], ['b', { running: true }]]))
  assert.equal(ends, 1)
  emit(new Map([['a', { running: false }], ['b', { running: true }]]))
  assert.equal(ends, 1, 'no repeat without a new stop')
  emit(new Map([['a', { running: false }], ['b', { running: false }]]))
  assert.equal(ends, 2)
  stop()
  assert.equal(listeners.size, 0)
})

test('reload announces newly added volumes until dismissed', async () => {
  let rows = [{ id: 'a', title: '甲', errors: [], sectionIds: ['s1'] }]
  const app = t.createAppStore({ request: async (path) => ({ volumes: rows, cards: [], roots: [], state: { ui: {}, volumes: {}, cards: {}, resurface: {}, settings: {} } }) })
  await app.load()
  assert.equal(app.getSnapshot().added.length, 0, 'nothing is new on the first load')
  rows = [...rows, { id: 'b', title: '乙', errors: [], sectionIds: ['s1', 's2'] }, { id: 'c', title: '坏', errors: ['x'], sectionIds: [] }]
  await app.load()
  assert.deepEqual(Array.from(app.getSnapshot().added, (item) => [item.id, item.title, item.firstSection]), [['b', '乙', 's1']])
  assert.equal(app.getSnapshot().refreshing, false)
  app.dismissAdded('b')
  assert.equal(app.getSnapshot().added.length, 0)
})

test('notesOutsideText keeps only notes that 句下 cannot place in the text', () => {
  const section = { title: '登鹳雀楼', paragraphs: [{ text: '欲穷千里目', quotes: [] }], notes: [{ word: '鹳雀楼', gloss: '楼名' }, { word: '穷', gloss: '尽' }] }
  assert.deepEqual(Array.from(t.notesOutsideText(section), (note) => note.word), ['鹳雀楼'])
})

test('a click during a library reload is not undone by the reload', async () => {
  // Host state as the library endpoint would read it (before the click) vs. after the ops.
  let hostState = { ui: { view: 'encounter', volume: 'a' }, volumes: {}, cards: {}, resurface: {}, settings: {} }
  let releaseLibrary
  let libraryCalls = 0
  const request = async (path, body) => {
    if (path.endsWith('library')) {
      libraryCalls++
      const snapshot = structuredClone(hostState) // read before the click…
      if (libraryCalls > 1) await new Promise((resolve) => { releaseLibrary = resolve }) // …but answered after it
      return { volumes: [{ id: 'a', errors: [], sectionIds: ['s1'] }, { id: 'b', errors: [], sectionIds: ['s1', 's2'] }], cards: [], roots: [], state: snapshot }
    }
    hostState = t.optimistic(hostState, body)
    return { state: structuredClone(hostState) }
  }
  const app = t.createAppStore({ request })
  await app.load()
  const reload = app.load()
  assert.equal(app.load(), reload, 'concurrent loads share one request')
  while (!releaseLibrary) await new Promise((resolve) => setTimeout(resolve, 1))
  // 在修业中打开
  app.progress('b', 's2')
  await app.send({ op: 'view', view: 'study' })
  assert.equal(app.getSnapshot().state.ui.view, 'study')
  releaseLibrary()
  await reload
  assert.equal(app.getSnapshot().state.ui.view, 'study', 'the stale library snapshot must not revert the click')
  assert.equal(app.getSnapshot().state.ui.volume, 'b')
  assert.equal(libraryCalls, 2)
})

test('shelf tags: 学段 first, then tags on two or more volumes; tag filter combines with kind filter', () => {
  const rows = [
    { id: 'a', title: '静夜思', kind: 'poem', tags: ['小学', '古诗词'], sectionIds: ['s1'], sectionCount: 1, errors: [] },
    { id: 'b', title: '咏鹅', kind: 'poem', tags: ['小学', '古诗词'], sectionIds: ['s1'], sectionCount: 1, errors: [] },
    { id: 'c', title: '师说', kind: 'prose', tags: ['高中', '古文'], sectionIds: ['s1'], sectionCount: 1, errors: [] },
    { id: 'd', title: '琵琶行', kind: 'poem', tags: ['高中', '唐诗三百首'], sectionIds: ['s1'], sectionCount: 1, errors: [] }
  ]
  assert.deepEqual(Array.from(t.shelfTags(rows)), ['小学', '高中', '古诗词'], '古文 and 唐诗三百首 appear once only')
  assert.deepEqual(Array.from(t.shelfItems(rows, {}, '', 'all', '高中').unread, (item) => item.row.id), ['c', 'd'])
  assert.deepEqual(Array.from(t.shelfItems(rows, {}, '', 'poem', '高中').unread, (item) => item.row.id), ['d'])
  assert.deepEqual(Array.from(t.shelfItems(rows, {}, '静', 'all', '小学').unread, (item) => item.row.id), ['a'])
})

test('agentBoardView lists only running board sessions, longest first, with agent, client and project', () => {
  const feed = { status: 'ok', payload: { sessions: [
    { sessionId: 'claude:a', provider: 'claude', source: 'claude-vscode', status: 'running', title: '修复登录页', cwd: 'D:\\dev\\shop', turnStartedAt: '2026-11-20T09:58:00Z', observedAt: '2026-11-20T09:59:30Z' },
    { sessionId: 'dsh:b', status: 'running', title: '', observedAt: '2026-11-20T09:50:00Z' },
    { sessionId: '0193-uuid', status: 'turn_completed', title: '已结束', observedAt: '2026-11-20T09:00:00Z' },
    { sessionId: 'kimi-cli:c', source: 'kimi-cli', status: 'running', title: '写周报' },
    { sessionId: 'agy:d', provider: 'agy', source: 'agy-hub', status: 'running', title: '整理文档', cwd: 'D:\\dev\\fms269', model: 'gemini-4-neon', reasoningEffort: 'xhigh', observedAt: '2026-11-20T09:59:00Z' }
  ] } }
  const view = t.agentBoardView(feed)
  assert.equal(view.running.find((item) => item.id === 'agy:d').meta, 'Antigravity · agy Hub · fms269 · gemini-4-neon xhigh', 'model and effort close the line when the board has them')
  view.running.splice(view.running.findIndex((item) => item.id === 'agy:d'), 1)
  assert.deepEqual(Array.from(view.running, (item) => item.id), ['dsh:b', 'claude:a', 'kimi-cli:c'])
  assert.deepEqual(Array.from(view.running, (item) => item.agent), ['dsh', 'claude', 'kimi'])
  assert.equal(view.running[0].title, '未命名会话')
  assert.equal(view.running[1].since, Date.parse('2026-11-20T09:58:00Z'), 'turnStartedAt wins over observedAt')
  assert.equal(view.running[1].meta, 'Claude · VS Code · shop')
  assert.equal(view.running[2].meta, 'Kimi · CLI')
  assert.equal(view.running[2].since, undefined)
  assert.equal(view.tone, 'waiting', 'no 可以读一则: running is just running')
  assert.equal(view.board, true)
  assert.equal(t.agentBoardView({ status: 'idle', payload: null }).tone, 'idle')
})

test('board feed: one poller while retained, a missing board is rechecked once a minute, errors keep the last snapshot', async () => {
  let clock = 0
  const timers = []
  const answers = [{ sessions: [{ sessionId: 'a', status: 'running' }] }, new Error('HTTP 503'), null, { sessions: [] }]
  let calls = 0
  const feed = t.createBoardFeed({
    request: async () => {
      calls++
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next
    },
    clock: () => clock,
    every: (fn) => timers.push(fn),
    stop: (id) => { timers[id - 1] = null },
    isHidden: () => false
  })
  assert.equal(feed.getSnapshot().status, 'idle')
  const release = feed.retain()
  const releaseOther = feed.retain()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(feed.getSnapshot().status, 'ok')
  assert.equal(timers.length, 1, 'one poller however many panes')
  await feed.poll()
  assert.equal(feed.getSnapshot().status, 'error')
  assert.equal(feed.getSnapshot().payload.sessions.length, 1, 'the last good snapshot stays on screen')
  await feed.poll()
  assert.equal(feed.getSnapshot().status, 'missing')
  clock = 30000
  await feed.poll()
  assert.equal(calls, 3, 'no request while a missing board is less than a minute old')
  clock = 61000
  await feed.poll()
  assert.equal(feed.getSnapshot().status, 'ok')
  release()
  release()
  assert.ok(timers[0], 'still retained by the other pane')
  releaseOther()
  assert.equal(timers[0], null)
})

test('AgentPanel: logo from the 会话看板 module, task title and running time; every click opens the board', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let withReact
  const fakeReact = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }
  const modules = { react: fakeReact, 'codex-monitor': { AGENT_LOGOS: { claude: 'data:image/svg+xml;base64,AAAA' } } }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load({ factory }) { withReact = factory((name) => { if (name in modules) return modules[name]; throw new Error('missing ' + name) }) } } },
    Date, Math, structuredClone, setTimeout, clearTimeout, console
  })
  const expand = (node) => {
    if (Array.isArray(node)) return node.flatMap(expand)
    if (node === null || node === undefined || node === false) return []
    if (typeof node !== 'object') return [node]
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return [{ ...node, props: { ...node.props, children: expand(node.props.children) } }]
  }
  const text = (nodes) => nodes.map((node) => typeof node === 'object' ? text(node.props.children) : String(node)).join('')
  const find = (nodes, predicate) => nodes.flatMap((node) => typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...find(node.props.children, predicate)])
  const { AgentPanel } = withReact.__test.views
  const now = Date.parse('2026-11-20T10:00:00Z')
  const feed = { status: 'ok', payload: { sessions: [
    { sessionId: 'claude:a', provider: 'claude', status: 'running', title: '修复登录页', turnStartedAt: '2026-11-20T09:58:00Z' },
    { sessionId: 'agy:b', provider: 'agy', status: 'running', title: '整理文档' }
  ] } }
  const opened = []
  const tree = expand({ type: AgentPanel, props: { view: withReact.__test.agentBoardView(feed), feed, now, openBoard: () => opened.push(1) } })
  const out = text(tree)
  assert.match(out, /会话看板 · 运行中 2/)
  assert.match(out, /修复登录页Claude2 分 00 秒/)
  assert.match(out, /A整理文档Antigravity/, 'a letter stands in when the board has no logo for the agent')
  const images = find(tree, (node) => node.type === 'img')
  assert.equal(images.length, 1)
  assert.equal(images[0].props.src, 'data:image/svg+xml;base64,AAAA')
  for (const button of find(tree, (node) => node.type === 'button')) button.props.onClick()
  assert.equal(opened.length, 3, '打开看板 and both rows')
  const empty = { status: 'ok', payload: { sessions: [] } }
  assert.match(text(expand({ type: AgentPanel, props: { view: withReact.__test.agentBoardView(empty), feed: empty, now, openBoard: () => {} } })), /没有正在执行的会话/)
  const failing = { status: 'error', payload: null, error: 'HTTP 503' }
  assert.match(text(expand({ type: AgentPanel, props: { view: withReact.__test.agentBoardView(failing), feed: failing, now, openBoard: () => {} } })), /暂时读不到会话看板/)
})

test('left sidebar entry opens 闲庭 in the main area; collapsed rail shows only the icon', async () => {
  const registered = {}
  const panels = []
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let withReact
  const fakeReact = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useRef: () => ({ current: null }), useState: (value) => [value, () => {}], useEffect: () => {} }
  runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) { withReact = factory((name) => (name === 'react' ? fakeReact : undefined)) } } }, Date, Math, structuredClone, setTimeout, clearTimeout, console })
  withReact.apply({
    effect: (action) => action(),
    uiSession: undefined, sessions: undefined, uiWorkspace: undefined,
    layout: { selectPanel: (id) => panels.push(id) },
    sidebarRight: { mounted: { getSnapshot: () => undefined, subscribe: () => () => {} } },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (slot, register) => register(), register: (meta, component) => { registered[meta.name] = { meta, component }; return () => {} } }
  })
  const main = registered.main
  assert.equal(main.meta.key, 'dsh-vibe-reader')
  assert.equal(main.meta.id, 'dsh-vibe-reader')
  assert.equal(main.meta.label, '闲庭')
  const entry = registered['sidebar.footer.action']
  assert.equal(entry.meta.label, '闲庭')
  const wide = entry.component({ wide: true })
  assert.equal(wide.props.className, 'vr-trigger')
  assert.equal(wide.props.children.at(-1).props.children[0], '闲庭')
  const rail = entry.component({ wide: false })
  assert.equal(rail.props.className, 'vr-trigger vr-rail')
  assert.equal(rail.props.title, '闲庭')
  assert.equal(rail.props.children.at(-1), null)
  wide.props.onClick()
  assert.deepEqual(panels, ['dsh-vibe-reader'])
})

test('section author is shown only when it differs from the volume author', () => {
  assert.equal(t.sameAuthor('唐 · 白居易', '唐 · 白居易'), true)
  assert.equal(t.sameAuthor('唐·白居易', '唐 · 白居易'), true, 'spacing around the dot does not matter')
  assert.equal(t.sameAuthor('唐 · 杜甫', '唐 · 李白'), false, '组诗 keep each poem author')
  assert.equal(t.sameAuthor('唐 · 杜甫', ''), false, 'a volume without an author never hides it')
})

test('wide main area: the shelf lives in the rail (no autofocus, own scroll box); study points there until a volume is chosen', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let withReact
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (value) => [value, () => {}], useRef: () => ({ current: null }), useEffect: () => {}, useMemo: (fn) => fn()
  }
  runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) { withReact = factory((name) => (name === 'react' ? fakeReact : undefined)) } } }, Date, Math, structuredClone, setTimeout, clearTimeout, console })
  const expand = (node) => {
    if (Array.isArray(node)) return node.flatMap(expand)
    if (node === null || node === undefined || node === false) return []
    if (typeof node !== 'object') return [node]
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return [{ ...node, props: { ...node.props, children: expand(node.props.children) } }]
  }
  const text = (nodes) => nodes.map((node) => typeof node === 'object' ? text(node.props.children) : String(node)).join('')
  const find = (nodes, predicate) => nodes.flatMap((node) => typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...find(node.props.children, predicate)])
  const { Shelf, StudyView } = withReact.__test.views
  const rows = [
    { id: 'pipa', title: '琵琶行', dynasty: '唐', author: '白居易', kind: 'poem', tags: ['高中'], errors: [], sectionCount: 6, sectionIds: ['s1'], sectionList: [] },
    { id: 'qzw', title: '千字文', dynasty: '南朝梁', author: '周兴嗣', kind: 'poem', tags: ['蒙学'], errors: [], sectionCount: 16, sectionIds: ['s1'], sectionList: [] }
  ]
  const state = { ui: { view: 'study', volume: null }, volumes: {}, cards: {}, resurface: {}, settings: {} }
  const shelf = expand({ type: Shelf, props: { rows, state, currentId: null, onPick: () => {}, onClose: () => {}, autoFocus: false } })
  assert.equal(find(shelf, (node) => node.type === 'input')[0].props.autoFocus, false, 'the rail search does not steal focus from the text')
  const list = find(shelf, (node) => node.props.className === 'vr-shelf-list')
  assert.equal(list.length, 1)
  assert.match(text(list), /琵琶行.*千字文/)
  const snapshot = { library: { volumes: rows }, state, volumes: {} }
  const prompt = expand({ type: StudyView, props: { app: { ensureVolume() {}, progress() {} }, snapshot, shelfInRail: true } })
  assert.match(text(prompt), /从右侧书架选一卷/)
  assert.equal(find(prompt, (node) => node.props.className === 'vr-volswitch').length, 0, 'no 书架 toggle beside the title')
  const inline = expand({ type: StudyView, props: { app: { ensureVolume() {}, progress() {} }, snapshot } })
  assert.equal(find(inline, (node) => node.props.className === 'vr-shelf').length, 1, 'sidebar tab: first visit still opens the inline shelf')
})

test('aboutFor: the section author (组诗) or the volume author; per-section background before the volume one', () => {
  const library = {
    authors: [
      { name: '杜甫', dynasty: '唐', facts: [], bio: ['杜甫小传'], errors: [] },
      { name: '范仲淹', dynasty: '宋', facts: [], bio: ['范仲淹小传'], errors: [] },
      { name: '坏文件', dynasty: '唐', facts: [], bio: [], errors: ['缺少小传正文'] }
    ],
    backgrounds: {
      tang: { text: ['六首诗作于不同时期'], sections: { s2: { title: '春望', text: ['至德二载春'] } }, source: '年谱', errors: [] },
      broken: { text: ['x'], sections: {}, errors: ['bad'] }
    }
  }
  const tang = { id: 'tang', author: '', dynasty: '唐' }
  const spring = t.aboutFor(library, tang, { id: 's2', meta: { author: '唐 · 杜甫' } })
  assert.equal(spring.author.name, '杜甫')
  assert.deepEqual(Array.from(spring.background), ['至德二载春'])
  assert.equal(spring.source, '年谱')
  const other = t.aboutFor(library, tang, { id: 's3', meta: { author: '唐 · 李白' } })
  assert.equal(other.author, null, 'no entry for 李白 yet')
  assert.deepEqual(Array.from(other.background), ['六首诗作于不同时期'], 'falls back to the volume background')
  const yue = t.aboutFor(library, { id: 'yue', author: '范仲淹', dynasty: '宋' }, { id: 's1', meta: {} })
  assert.equal(yue.author.name, '范仲淹', 'prose sections use the volume author')
  assert.equal(yue.background.length, 0)
  assert.equal(t.aboutFor(library, { id: 'broken', author: '坏文件' }, { id: 's1', meta: {} }).author, null, 'files with errors are skipped')
  assert.equal(t.aboutFor(library, { id: 'broken', author: '坏文件' }, { id: 's1', meta: {} }).background.length, 0)
})

