import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundledSkill, apply } from '../index.js'
import { importVolume, setFrontmatter } from '../lib/importer.js'
import { createLibrary } from '../lib/store.js'
import { createToolService, blocksOf } from '../lib/tool.js'
import { checkOriginal, diffChars } from '../lib/verify.js'
import { parseVolume } from '../lib/volume.js'

const seedsDir = fileURLToPath(new URL('../seeds/', import.meta.url))
const ORIGINAL = '白日依山尽，黄河入海流。\n欲穷千里目，更上一层楼。'
const DRAFT = `---
id: deng-guanquelou
title: 登鹳雀楼
author: 王之涣
dynasty: 唐
kind: poem
tags: [唐诗]
---

## 登鹳雀楼 {#s1}
> 作者：唐 · 王之涣
> 脉络：登楼所见，由景入理

白日依山尽，黄河入海流。
==欲穷千里目，更上一层楼==。

- 【穷】尽

译：夕阳依山落下，黄河流向大海。想看尽千里风光，就再登上一层楼。
`

async function withLibrary(task) {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-reader-import-'))
  const libraryDir = join(dir, 'library')
  const library = createLibrary([{ origin: 'builtin', dir: seedsDir }, { origin: 'library', dir: libraryDir }])
  try {
    return await task({ dir, libraryDir, library, run: (input) => importVolume(input, { libraryDir, scan: library.scan }) })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('diff and original check describe each difference with context', () => {
  assert.deepEqual(diffChars('百废具兴', '百废俱兴').map((hunk) => [hunk.at, hunk.removed, hunk.added]), [[2, '具', '俱']])
  const volume = parseVolume(DRAFT)
  assert.equal(checkOriginal(ORIGINAL, volume).ok, true, 'whitespace and == are ignored')
  const changed = checkOriginal(ORIGINAL.replace('穷', '尽'), volume)
  assert.equal(changed.ok, false)
  assert.match(changed.problems[0], /第 14 字附近.*原文「尽」，书卷写成「穷」/)
  assert.match(checkOriginal(ORIGINAL + '多', volume).problems[0], /书卷少了「多」/)
})

test('setFrontmatter replaces and inserts keys without touching the rest', () => {
  const out = setFrontmatter('---\nid: a\nverified: true\n---\n\n## x {#s1}\n\n正文\n', { verified: false, fingerprint: 'sha256:ab', source: '用户 #粘贴' })
  assert.equal(out, '---\nid: a\nverified: false\nfingerprint: sha256:ab\nsource: "用户 #粘贴"\n---\n\n## x {#s1}\n\n正文\n')
})

test('acceptance: changing one character of the original is rejected and nothing is written', () => withLibrary(async ({ libraryDir, run }) => {
  const result = await run({ markdown: DRAFT.replace('黄河入海流', '黄河入海留'), original: ORIGINAL })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'original')
  assert.ok(result.problems.some((problem) => /原文「流」，书卷写成「留」/.test(problem)))
  await assert.rejects(readdir(libraryDir), { code: 'ENOENT' })
}))

test('import writes fingerprint, verified and source; paste defaults to unverified', () => withLibrary(async ({ libraryDir, library, run }) => {
  const result = await run({ markdown: DRAFT, original: ORIGINAL })
  assert.equal(result.ok, true)
  assert.equal(result.verified, false)
  assert.equal(result.sections, 1)
  const written = parseVolume(await readFile(join(libraryDir, 'deng-guanquelou.md'), 'utf8'))
  assert.equal(written.integrity, 'ok')
  assert.equal(written.verified, false)
  assert.equal(written.source, '用户粘贴')
  assert.equal(written.recitable, false, 'unverified paste is read-only')
  assert.ok((await library.scan()).cards.some((card) => card.key === 'deng-guanquelou#s1#欲穷千里目，更上一层楼'))
  assert.deepEqual((await readdir(libraryDir)).filter((name) => name.endsWith('.tmp')), [])
}))

test('import: verified only on explicit request for paste; corpus marks corpus; ai skips the original', () => withLibrary(async ({ run }) => {
  assert.equal((await run({ markdown: DRAFT, original: ORIGINAL, verified: true })).verified, true)
  const corpus = await run({ markdown: DRAFT.replace('deng-guanquelou', 'deng-2'), original: ORIGINAL, source: 'corpus', verified: false })
  assert.equal(corpus.verified, 'corpus')
  const ai = await run({ markdown: DRAFT.replace('deng-guanquelou', 'deng-3'), source: 'ai', verified: true })
  assert.equal(ai.ok, true)
  assert.equal(ai.verified, false)
  assert.equal(ai.source, 'ai')
  const missing = await run({ markdown: DRAFT.replace('deng-guanquelou', 'deng-4') })
  assert.equal(missing.stage, 'original')
}))

test('import: existing id needs overwrite; overwrite reports original change and removed sections', () => withLibrary(async ({ run }) => {
  assert.equal((await run({ markdown: DRAFT, original: ORIGINAL })).ok, true)
  const again = await run({ markdown: DRAFT, original: ORIGINAL })
  assert.equal(again.stage, 'exists')
  const twoSections = DRAFT + '\n## 又一节 {#s2}\n\n更上一层。\n'
  const replaced = await run({ markdown: twoSections, original: ORIGINAL + '更上一层。', overwrite: true })
  assert.equal(replaced.ok, true)
  assert.equal(replaced.originalChanged, true)
  assert.deepEqual(replaced.removedSections, [])
  const back = await run({ markdown: DRAFT, original: ORIGINAL, overwrite: true })
  assert.deepEqual(back.removedSections, ['s2'])
}))

test('import: format errors, builtin override', () => withLibrary(async ({ run }) => {
  const broken = await run({ markdown: DRAFT.replace('{#s1}', ''), original: ORIGINAL })
  assert.equal(broken.stage, 'format')
  const seed = await readFile(join(seedsDir, 'tangshi-liushou.md'), 'utf8')
  const seedBody = parseVolume(seed).sections.map((section) => section.paragraphs[0].text).join('\n')
  const override = await run({ markdown: seed, original: seedBody, source: 'corpus' })
  assert.equal(override.ok, true)
  assert.match(override.overrides, /内置/)
}))

test('tool: list, clean, import, read, verify end to end', () => withLibrary(async ({ libraryDir, library }) => {
  const tool = createToolService({ library, libraryDir })
  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.volumes.map((row) => row.id).sort(), ['qian-chibi-fu', 'tangshi-liushou', 'yueyanglou-ji'])

  const cleaned = await tool.execute({ action: 'clean', text: '白日依山盡，黃河入海流。\n欲窮千里目，更上一層樓。', traditional: true })
  assert.equal(cleaned.ok, true)
  assert.equal(cleaned.text, ORIGINAL)
  assert.ok(cleaned.report.pairs.some((pair) => pair.from === '盡' && pair.to === '尽'))

  const imported = await tool.execute({ action: 'import', markdown: DRAFT, original: cleaned.text, source: 'corpus' })
  assert.equal(imported.ok, true)
  const read = await tool.execute({ action: 'read', id: 'deng-guanquelou' })
  assert.match(read.markdown, /^fingerprint: sha256:/m)
  const verified = await tool.execute({ action: 'verify', id: 'deng-guanquelou' })
  assert.equal(verified.ok, true)
  assert.equal(verified.recitable, true)

  assert.equal((await tool.execute({ action: 'read', id: 'nope' })).ok, false)
  assert.equal((await tool.execute({ action: 'explode' })).ok, false)
  assert.equal((await tool.execute({ action: 'clean', text: '' })).ok, false)
}))

test('tool clean keeps blocks and lines; blocksOf splits on blank lines', () => {
  assert.deepEqual(blocksOf('甲，乙。\n丙，丁。\n\n\n戊。\r\n'), [['甲，乙。', '丙，丁。'], ['戊。']])
})

test('apply registers the tool and the skill through optional injects', async () => {
  const injected = {}
  apply({ effect: () => {}, connection: { fetch: { register: () => () => {} } }, inject: (deps, callback) => { injected[deps[0]] = callback } }, {})
  assert.ok(injected.connection, 'HTTP is optional too')
  let tool
  injected.tools({ tools: { register: (value) => { tool = value } } })
  assert.equal(tool.name, 'vibe_reader')
  assert.ok(tool.description.length < 200, 'visible in every session, keep it short')
  assert.deepEqual(tool.parameters.required, ['action'])
  let skill
  await injected.skills({ skills: { register: (value) => { skill = value } } })
  assert.equal(skill.name, 'vibe-reader-engraver')
  assert.equal(skill.provider, 'dsh-vibe-reader')
  assert.match(skill.content, /不得默写原文/)
  assert.deepEqual(skill, await bundledSkill())
})

test('palette: 526 colors, lookup, suggestions, accent filter', async () => {
  const { PALETTE, colorOf, suggestColors, listColors, FAMILIES } = await import('../lib/palette.js')
  assert.equal(PALETTE.length, 526)
  assert.equal(colorOf('晚波蓝').hex, '#648e93')
  assert.equal(colorOf('苍翠'), undefined)
  assert.ok(suggestColors('苍翠').every((name) => name.includes('翠') || name.includes('苍')))
  const greens = listColors({ family: '绿', accent: true })
  assert.ok(greens.length > 10 && greens.every((color) => color.family === '绿'))
  assert.ok(FAMILIES.includes('红'))
})

test('import: color must come from the palette; HEX is reported and scanned', () => withLibrary(async ({ library, run }) => {
  const bad = await run({ markdown: DRAFT.replace('kind: poem', 'kind: poem\ncolor: 苍翠'), original: ORIGINAL })
  assert.equal(bad.stage, 'format')
  assert.match(bad.problems[0], /苍翠.*不在中国传统色色表内.*近似的有：.*翠/)
  const good = await run({ markdown: DRAFT.replace('kind: poem', 'kind: poem\ncolor: 竹绿'), original: ORIGINAL })
  assert.deepEqual(good.color, { name: '竹绿', hex: '#1ba784' })
  const snapshot = await library.scan()
  assert.equal(snapshot.list.find((row) => row.id === 'deng-guanquelou').colorHex, '#1ba784')
  assert.equal(snapshot.list.find((row) => row.id === 'yueyanglou-ji').colorHex, '#648e93', 'seeds carry palette colors')
}))

test('tool: search, draft, colors go through the corpus; corpus errors come back as problems', () => withLibrary(async ({ libraryDir, library }) => {
  const calls = []
  const corpus = {
    search: async (args) => { calls.push(['search', args]); return { hits: [{ ref: 'tang300:0', title: '登鹳雀楼' }], total: 1, searched: ['唐诗三百首'] } },
    draft: async (args) => {
      calls.push(['draft', args])
      if (args.refs[0] === 'ctext:x') { const { CorpusError } = await import('../lib/corpus.js'); throw new CorpusError('ctext 取正文需要 API key', { chapters: ['ctext:x/1'] }) }
      return { markdown: DRAFT, original: ORIGINAL, sections: 1, chars: 20, report: { pairs: [], warnings: [] } }
    }
  }
  const tool = createToolService({ library, libraryDir, corpus })
  const found = await tool.execute({ action: 'search', query: '登鹳雀楼', deep: true })
  assert.equal(found.ok, true)
  assert.equal(found.hits[0].ref, 'tang300:0')
  assert.match(found.next, /draft/)
  assert.deepEqual(calls[0][1], { query: '登鹳雀楼', author: undefined, collections: undefined, deep: true, ctext: false })
  const draft = await tool.execute({ action: 'draft', refs: ['tang300:0'], id: 'deng-guanquelou' })
  assert.equal(draft.ok, true)
  const imported = await tool.execute({ action: 'import', markdown: draft.markdown, original: draft.original, source: 'corpus' })
  assert.equal(imported.verified, 'corpus')
  const failed = await tool.execute({ action: 'draft', refs: ['ctext:x'], id: 'x' })
  assert.deepEqual(failed, { ok: false, problems: ['ctext 取正文需要 API key'], chapters: ['ctext:x/1'] })
  const colors = await tool.execute({ action: 'colors', family: '蓝' })
  assert.ok(colors.colors.length > 5 && colors.colors.every((color) => color.family === '蓝'))
  assert.ok(colors.families.includes('绿'))
}))

test('import keepOriginal: annotate an existing volume; its original, source and verified stay; text edits are refused', () => withLibrary(async ({ libraryDir, run }) => {
  assert.equal((await run({ markdown: DRAFT, original: ORIGINAL, source: 'corpus' })).verified, 'corpus')
  const annotated = DRAFT.replace('- 【穷】尽', '- 【穷】尽，使达到极点\n- 【千里目】看到千里之外的目力')
  const ok = await run({ markdown: annotated, keepOriginal: true })
  assert.equal(ok.ok, true)
  assert.equal(ok.verified, 'corpus', 'corpus status survives')
  assert.equal(ok.notes, 2)
  const written = parseVolume(await readFile(join(libraryDir, 'deng-guanquelou.md'), 'utf8'))
  assert.equal(written.integrity, 'ok')
  const tampered = await run({ markdown: annotated.replace('黄河入海流', '黄河入海留'), keepOriginal: true })
  assert.equal(tampered.stage, 'original')
  const nothing = await run({ markdown: DRAFT.replace('deng-guanquelou', 'never-imported'), keepOriginal: true })
  assert.equal(nothing.stage, 'input')
}))
