import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { cleanParagraphs, extractInlineNotes } from '../lib/clean.js'
import { parseVolume } from '../lib/volume.js'

const fixture = JSON.parse(await readFile(new URL('./fixtures/chinese-poetry-sample.json', import.meta.url), 'utf8'))
const seed = async (id) => parseVolume(await readFile(new URL(`../seeds/${id}.md`, import.meta.url), 'utf8'))
const bodyOf = (volume) => volume.sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.text.replace(/\n/g, '')))

test('inline notes: single, multiple, and unparseable groups', () => {
  assert.deepEqual(extractInlineNotes('屬予作文以記之。(具 通：俱)'), { text: '屬予作文以記之。', notes: [{ word: '具', gloss: '通“俱”' }], warnings: [] })
  assert.deepEqual(extractInlineNotes('感極而悲者矣。(隱曜 一作：隱耀；淫雨 通：霪雨)').notes, [
    { word: '隱曜', gloss: '一作“隱耀”' },
    { word: '淫雨', gloss: '通“霪雨”' }
  ])
  const odd = extractInlineNotes('正文(这不是注释)。')
  assert.equal(odd.text, '正文(这不是注释)。')
  assert.match(odd.warnings[0], /无法识别的括注/)
  assert.equal(extractInlineNotes('全角（括号）不动').text, '全角（括号）不动')
})

test('cleaning: spaces, half-width punctuation, straight quotes; no conversion for simplified input', async () => {
  const { paragraphs, report } = await cleanParagraphs(['月白风 清，如此良夜何?', '遂锡嘉名为"阅江"云,'])
  assert.deepEqual(paragraphs.map((paragraph) => paragraph.text), ['月白风清，如此良夜何？', '遂锡嘉名为“阅江”云，'])
  assert.equal(report.spaces, 1)
  assert.equal(report.punctuation, 2)
  assert.equal(report.quotes, 1)
  assert.deepEqual(report.pairs, [])
})

test('acceptance: 古文观止 articles clean to exactly the built-in seed text', async () => {
  for (const id of ['yueyanglou-ji', 'qian-chibi-fu']) {
    const { paragraphs, report } = await cleanParagraphs(fixture.volumes[id].paragraphs, { traditional: true })
    const volume = await seed(id)
    assert.deepEqual(paragraphs.map((paragraph) => paragraph.text), bodyOf(volume), id)
    assert.deepEqual(report.warnings, [], id)
    assert.ok(report.pairs.length > 50, 'the conversion table is reported for review')
  }
})

test('acceptance: 岳阳楼记 inline notes come out converted and attached to their paragraph', async () => {
  const { paragraphs, report } = await cleanParagraphs(fixture.volumes['yueyanglou-ji'].paragraphs, { traditional: true })
  assert.equal(report.notes, 3)
  assert.deepEqual(paragraphs[0].notes, [{ word: '具', gloss: '通“俱”' }])
  assert.deepEqual(paragraphs[2].notes, [{ word: '隐曜', gloss: '一作“隐耀”' }, { word: '淫雨', gloss: '通“霪雨”' }])
  assert.equal(report.punctuation, 1, '得无异乎? → ？')
})

test('acceptance: 唐诗三百首 poems clean to exactly the built-in seed text', async () => {
  const volume = await seed('tangshi-liushou')
  const poems = fixture.volumes['tangshi-liushou'].poems
  for (const [index, poem] of poems.entries()) {
    const { paragraphs } = await cleanParagraphs(poem.paragraphs, { traditional: true })
    assert.equal(paragraphs.map((paragraph) => paragraph.text).join('\n'), volume.sections[index].paragraphs[0].text, poem.title)
  }
})

test('variant characters that t2s leaves alone are reported, never changed', async () => {
  const { paragraphs, report } = await cleanParagraphs(['金生麗水，玉出崐岡。', '茍不教，性乃遷。'], { traditional: true })
  assert.deepEqual(paragraphs.map((paragraph) => paragraph.text), ['金生丽水，玉出崐冈。', '茍不教，性乃迁。'])
  assert.deepEqual(report.variants, [{ char: '崐', common: '昆', count: 1 }, { char: '茍', common: '苟', count: 1 }])
  assert.match(report.warnings.join(), /崐（通行作「昆」）.*茍（通行作「苟」）.*请问用户/)
})
