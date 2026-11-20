import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyOp, createLibrary, createStateStore, defaultState, normalizeState, OpError, resolverFor } from '../lib/store.js'

const seedsDir = fileURLToPath(new URL('../seeds/', import.meta.url))
const now = new Date('2026-11-20T03:00:00Z')

async function withTemp(task) {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-reader-test-'))
  try {
    return await task(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('applyOp: progress, view, settings', () => {
  let state = applyOp(defaultState(), { op: 'progress', volumeId: 'v', sectionId: 's2' }, now)
  assert.deepEqual(state.volumes.v, { lastSection: 's2', readAt: now.toISOString() })
  assert.equal(state.ui.volume, 'v')
  state = applyOp(state, { op: 'view', view: 'study' }, now)
  assert.equal(state.ui.view, 'study')
  state = applyOp(state, { op: 'settings', patch: { readAfterSeconds: 20, showGloss: false } }, now)
  assert.equal(state.settings.readAfterSeconds, 20)
  assert.equal(state.settings.showGloss, false)
  assert.throws(() => applyOp(state, { op: 'settings', patch: { readAfterSeconds: 1 } }, now), OpError)
  assert.throws(() => applyOp(state, { op: 'settings', patch: { libraryRoot: 'C:/x' } }, now), /不支持的设置/)
  assert.throws(() => applyOp(state, { op: 'view', view: 'x' }, now), OpError)
  assert.throws(() => applyOp(state, { op: 'nope' }, now), /不支持的操作/)
})

test('applyOp: rating moves the level within 0..5 and counts lapses', () => {
  let state = defaultState()
  const rate = (rating) => { state = applyOp(state, { op: 'rate', key: 'v#s1', rating }, now) }
  rate('forgot')
  assert.equal(state.cards['v#s1'].level, 0)
  assert.equal(state.cards['v#s1'].lapses, 1)
  for (let i = 0; i < 7; i++) rate('remembered')
  assert.equal(state.cards['v#s1'].level, 5)
  rate('fuzzy')
  assert.equal(state.cards['v#s1'].level, 5)
  rate('forgot')
  assert.equal(state.cards['v#s1'].level, 4)
  assert.equal(state.cards['v#s1'].reviews, 10)
  assert.throws(() => applyOp(state, { op: 'rate', key: 'v#s1', rating: 'great' }, now), /记得、模糊或忘了/)
  assert.throws(() => applyOp(state, { op: 'rate', key: 'bad key', rating: 'fuzzy' }, now), /卡片标识无效/)
  const locked = () => ({ exists: true, recitable: false })
  assert.throws(() => applyOp(state, { op: 'rate', key: 'v#s1', rating: 'fuzzy' }, now, locked), /只能阅读/)
})

test('applyOp: level and seen; input state is not mutated', () => {
  const before = defaultState()
  const after = applyOp(before, { op: 'level', key: 'v#s1#名句', level: 3 }, now)
  assert.equal(after.cards['v#s1#名句'].level, 3)
  assert.deepEqual(before.cards, {})
  const seen = applyOp(applyOp(after, { op: 'seen', key: 'v#s1' }, now), { op: 'seen', key: 'v#s1' }, now)
  assert.deepEqual(seen.resurface['v#s1'], { shown: 2, lastShown: '2026-11-20' })
  assert.throws(() => applyOp(after, { op: 'level', key: 'v#s1', level: 6 }, now), /等级/)
  assert.throws(() => applyOp(after, { op: 'seen', key: 'v#x' }, now, () => ({ exists: false })), /没有这张卡/)
})

test('normalizeState keeps hand-edited files usable', () => {
  const state = normalizeState({ ui: { view: 'weird' }, settings: { readAfterSeconds: 'x', showGloss: false }, extra: 1 })
  assert.equal(state.ui.view, 'encounter')
  assert.equal(state.settings.readAfterSeconds, 10)
  assert.equal(state.settings.showGloss, false)
  assert.equal(state.extra, 1)
})

test('state store: serialized writes lose nothing; corrupt file is moved aside', () => withTemp(async (dir) => {
  const file = join(dir, 'vibe-reader', 'state.json')
  const store = createStateStore(file, { clock: () => now })
  await Promise.all(Array.from({ length: 20 }, () => store.update({ op: 'seen', key: 'v#s1' })))
  assert.equal(JSON.parse(await readFile(file, 'utf8')).resurface['v#s1'].shown, 20)
  assert.deepEqual((await readdir(join(dir, 'vibe-reader'))).filter((name) => name.endsWith('.tmp')), [])

  await writeFile(file, '{ broken', 'utf8')
  const fresh = await store.read()
  assert.deepEqual(fresh.resurface, {})
  assert.ok(store.recovered())
  const names = await readdir(join(dir, 'vibe-reader'))
  assert.ok(names.some((name) => name.startsWith('state.corrupt-')), 'the broken file is kept for the user')
  assert.equal(await readFile(join(dir, 'vibe-reader', names.find((name) => name.startsWith('state.corrupt-'))), 'utf8'), '{ broken')
}))

test('library: built-in seeds, override by id, broken files listed, notes ignored', () => withTemp(async (dir) => {
  const mine = join(dir, 'library')
  await mkdir(mine)
  await cp(join(seedsDir, 'yueyanglou-ji.md'), join(mine, 'my-copy.md'))
  await writeFile(join(mine, 'broken.md'), '---\nid: broken\ntitle: 坏\nkind: prose\n---\n正文在节外\n', 'utf8')
  await writeFile(join(mine, 'yueyanglou-ji.notes.md'), '## s1\n眉批\n', 'utf8')
  await writeFile(join(mine, 'readme.txt'), 'not a volume', 'utf8')
  const library = createLibrary([{ origin: 'builtin', dir: seedsDir }, { origin: 'library', dir: mine }, { origin: 'library', dir: join(dir, 'missing') }])
  const snapshot = await library.scan()
  assert.deepEqual(snapshot.roots.map((root) => [root.origin, root.exists]), [['builtin', true], ['library', true], ['library', false]])
  assert.equal(snapshot.list.length, 4, '3 seeds with one overridden + broken')
  const yue = snapshot.list.find((row) => row.id === 'yueyanglou-ji')
  assert.equal(yue.origin, 'library')
  assert.equal(yue.overrides, 'builtin')
  assert.equal(snapshot.list.find((row) => row.id === 'broken').errors.length > 0, true)
  assert.equal(snapshot.cards.some((card) => card.volumeId === 'broken'), false)
  assert.ok(snapshot.cards.some((card) => card.key === 'qian-chibi-fu#s1#清风徐来，水波不兴'))

  const resolve = resolverFor(snapshot)
  assert.deepEqual(resolve('qian-chibi-fu#s4'), { exists: true, kind: 'section', recitable: true })
  assert.deepEqual(resolve('qian-chibi-fu#s1#清风徐来，水波不兴'), { exists: true, kind: 'quote', recitable: true })
  assert.deepEqual(resolve('qian-chibi-fu#s1#没有这句'), { exists: false })
  assert.deepEqual(resolve('qian-chibi-fu#s9'), { exists: false })
  assert.deepEqual(resolve('broken#s1'), { exists: false })
}))

test('settings: translation and note list default open and can be turned off', () => {
  const state = defaultState()
  assert.equal(state.settings.translationOpen, true)
  assert.equal(state.settings.notesOpen, true)
  const next = applyOp(state, { op: 'settings', patch: { translationOpen: false, notesOpen: false } }, now)
  assert.equal(next.settings.translationOpen, false)
  assert.equal(next.settings.notesOpen, false)
  assert.equal(normalizeState({ settings: {} }).settings.translationOpen, true, 'older state files get the new defaults')
})
