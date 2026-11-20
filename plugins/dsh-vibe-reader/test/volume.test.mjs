import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { cardsOf, fingerprintOf, parseFrontmatter, parseQuotes, parseVolume } from '../lib/volume.js'

const seedsDir = new URL('../seeds/', import.meta.url)

function volumeSource({ frontmatter = {}, body } = {}) {
  const head = { id: 'demo', title: '示例', kind: 'prose', verified: 'true', ...frontmatter }
  const lines = Object.entries(head).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n\n${body ?? '## 一 {#s1}\n> 脉络：导读\n\n甲乙丙，==丁戊==己。\n\n- 【丙】bǐng：天干第三\n- 【己】自己\n\n译：译文。\n'}`
}

test('seeds: every built-in volume parses cleanly and matches its fingerprint', async () => {
  const files = (await readdir(seedsDir)).filter((name) => name.endsWith('.md'))
  assert.equal(files.length, 3)
  for (const file of files) {
    const volume = parseVolume(await readFile(new URL(file, seedsDir), 'utf8'), file)
    assert.deepEqual(volume.errors, [], file)
    assert.deepEqual(volume.warnings, [], file)
    assert.equal(volume.integrity, 'ok', file)
    assert.equal(volume.verified, 'corpus', file)
    assert.equal(volume.recitable, true, file)
  }
})

test('seeds: 岳阳楼记 structure, notes with readings, translation, quotes', async () => {
  const volume = parseVolume(await readFile(new URL('yueyanglou-ji.md', seedsDir), 'utf8'))
  assert.equal(volume.sections.length, 5)
  const [first] = volume.sections
  assert.equal(first.id, 's1')
  assert.equal(first.meta.guide, '滕子京谪守巴陵，一年政通人和，重修岳阳楼，嘱托作记')
  assert.ok(first.paragraphs[0].text.startsWith('庆历四年春，滕子京谪守巴陵郡。'))
  assert.ok(!first.paragraphs[0].text.includes('=='))
  assert.deepEqual(first.paragraphs[0].quotes.map((quote) => quote.text), ['政通人和，百废具兴'])
  assert.deepEqual(first.notes.find((note) => note.word === '具'), { word: '具', reading: 'jù', gloss: '通“俱”，全、都' })
  assert.deepEqual(first.notes.find((note) => note.word === '越明年'), { word: '越明年', gloss: '到了第二年。越，及、到' })
  assert.match(first.translation, /^庆历四年春天/)
  assert.equal(volume.sections[4].paragraphs.length, 2, '落款单独成段')
})

test('seeds: poems keep line breaks and carry per-poem authors', async () => {
  const volume = parseVolume(await readFile(new URL('tangshi-liushou.md', seedsDir), 'utf8'))
  assert.equal(volume.kind, 'poem')
  assert.equal(volume.sections.length, 6)
  assert.equal(volume.sections[0].paragraphs[0].text, '白日依山尽，黄河入海流。\n欲穷千里目，更上一层楼。')
  assert.equal(volume.sections[2].meta.author, '唐 · 杜甫')
  const cards = cardsOf(volume)
  assert.equal(cards.filter((card) => card.kind === 'poem').length, 6)
  const quote = cards.find((card) => card.key === 'tangshi-liushou#s1#欲穷千里目，更上一层楼')
  assert.equal(quote.title, '登鹳雀楼')
  assert.equal(quote.author, '唐 · 王之涣')
})

test('fingerprint ignores whitespace, == marks, notes, translation, titles and guides', () => {
  const base = parseVolume(volumeSource())
  const variant = parseVolume(volumeSource({
    body: '## 改了标题 {#s1}\n> 脉络：换了导读\n\n甲乙 丙，丁戊\n己。\n\n- 【甲】别的注释\n\n译：别的译文。\n'
  }))
  assert.equal(base.actualFingerprint, variant.actualFingerprint)
  const changed = parseVolume(volumeSource({ body: '## 一 {#s1}\n\n甲乙丙，丁戊已。\n' }))
  assert.notEqual(base.actualFingerprint, changed.actualFingerprint, '己→已 must change the fingerprint')
  assert.equal(fingerprintOf([{ paragraphs: [{ text: '甲 乙' }] }]), fingerprintOf([{ paragraphs: [{ text: '甲乙' }] }]))
})

test('integrity: missing, ok, mismatch; recitation needs verified + ok', () => {
  const plain = parseVolume(volumeSource())
  assert.equal(plain.integrity, 'missing')
  assert.equal(plain.recitable, false)
  const ok = parseVolume(volumeSource({ frontmatter: { fingerprint: plain.actualFingerprint } }))
  assert.equal(ok.integrity, 'ok')
  assert.equal(ok.verified, true)
  assert.equal(ok.recitable, true)
  const unverified = parseVolume(volumeSource({ frontmatter: { fingerprint: plain.actualFingerprint, verified: 'false' } }))
  assert.equal(unverified.recitable, false)
  const tampered = parseVolume(volumeSource({ frontmatter: { fingerprint: plain.actualFingerprint }, body: '## 一 {#s1}\n\n甲乙丙，丁戊已。\n' }))
  assert.equal(tampered.integrity, 'mismatch')
  assert.equal(tampered.recitable, false)
})

test('validation: missing id, duplicate ids, unpaired ==, stray text, bad kind', () => {
  assert.match(parseVolume(volumeSource({ body: '## 无编号\n\n正文。\n' })).errors.join(), /缺少 \{#id\}/)
  assert.match(parseVolume(volumeSource({ body: '## 一 {#s1}\n\n甲。\n\n## 二 {#s1}\n\n乙。\n' })).errors.join(), /重复/)
  assert.match(parseVolume(volumeSource({ body: '## 一 {#s1}\n\n甲==乙。\n' })).errors.join(), /不成对/)
  assert.match(parseVolume(volumeSource({ body: '前言\n\n## 一 {#s1}\n\n甲。\n' })).errors.join(), /之前不能有正文/)
  assert.match(parseVolume(volumeSource({ frontmatter: { kind: 'novel' } })).errors.join(), /kind/)
  assert.match(parseVolume(volumeSource({ body: '## 一 {#s1}\n\n- 坏注释\n- 【好】好的\n\n甲好。\n' })).errors.join(), /注释应写成/)
  assert.match(parseVolume('没有 frontmatter').errors.join(), /frontmatter/)
  assert.match(parseVolume(volumeSource({ body: '## 一 {#s1}\n\n- 【丁】不在原文\n\n甲。\n' })).warnings.join(), /不在标题和原文中/)
})

test('frontmatter subset: arrays, comments, quotes, booleans', () => {
  const { data, errors } = parseFrontmatter('---\nid: a  # 注释\ntags: [甲, "乙", 丙]\ntitle: "带 # 号"\nverified: true\n---\n')
  assert.deepEqual(errors, [])
  assert.deepEqual(data, { id: 'a', tags: ['甲', '乙', '丙'], title: '带 # 号', verified: true })
})

test('parseQuotes returns offsets into the cleaned text', () => {
  const { text, quotes } = parseQuotes('甲==乙丙==丁==戊==')
  assert.equal(text, '甲乙丙丁戊')
  assert.deepEqual(quotes, [{ start: 1, end: 3, text: '乙丙' }, { start: 4, end: 5, text: '戊' }])
})
