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
  const view = t.boardView(tracked, { byId: { a: { displayTitle: '甲' }, b: { displayTitle: '乙' } } }, 20000, 10000)
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
  assert.deepEqual(Array.from(plugin.inject).sort(), ['sessions', 'sidebarRight', 'sidebarRightTabs', 'slots', 'uiSession', 'uiWorkspace'])
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
