import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findAuthor, parseAuthor, parseBackground, splitAuthorLabel } from '../lib/about.js'
import { cbdbPerson, createAuthorSource, pickPerson } from '../lib/authors.js'
import { createLibrary } from '../lib/store.js'
import { createToolService } from '../lib/tool.js'

const seedsDir = fileURLToPath(new URL('../seeds/', import.meta.url))
const AUTHOR = `---
name: 范仲淹
dynasty: 宋
life: 989—1052
cbdb: 8043
source: CBDB 8043；chinese-poetry 宋词作者小传
---

- 字号：字希文，谥文正
- 籍贯：苏州吴县，祖籍邠州
- 科第：大中祥符八年（1015）进士

北宋政治家、文学家。

主持庆历新政。
`
const BACKGROUND = `---
volume: tangshi-liushou
source: 据作者年谱整理
---

六首诗作于不同时期。

## 春望 {#s2}
至德二载春，杜甫困居长安。
`

async function withLibrary(task) {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-reader-about-'))
  const libraryDir = join(dir, 'library')
  try {
    const library = createLibrary([{ origin: 'builtin', dir: seedsDir }, { origin: 'library', dir: libraryDir }])
    await task({ dir, libraryDir, library })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('author file: facts, bio paragraphs and limits', () => {
  const author = parseAuthor(AUTHOR, '范仲淹.md')
  assert.deepEqual(author.errors, [])
  assert.equal(author.name, '范仲淹')
  assert.equal(author.cbdb, '8043')
  assert.deepEqual(author.facts.map((fact) => fact.label), ['字号', '籍贯', '科第'])
  assert.deepEqual(author.bio, ['北宋政治家、文学家。', '主持庆历新政。'])
  assert.match(parseAuthor(AUTHOR, '别名.md').warnings[0], /文件名/)
  assert.match(parseAuthor('---\nname: 范仲淹\n---\n\n- 字号：希文\n').errors.join(), /缺少小传正文/)
  assert.match(parseAuthor('---\nname: Fan\n---\n\n小传\n').errors.join(), /汉字/)
  assert.match(parseAuthor(`---\nname: 某\n---\n\n${'字'.repeat(701)}\n`).errors.join(), /超过 700 字/)
  assert.match(parseAuthor('---\nname: 某\n---\n\n## 生平\n小传\n').errors.join(), /不要用标题/)
})

test('background file: whole-volume text plus per-section blocks', () => {
  const background = parseBackground(BACKGROUND, 'tangshi-liushou.md')
  assert.deepEqual(background.errors, [])
  assert.deepEqual(background.text, ['六首诗作于不同时期。'])
  assert.deepEqual(background.sections.s2, { title: '春望', text: ['至德二载春，杜甫困居长安。'] })
  assert.match(parseBackground('---\nvolume: x\n---\n').errors.join(), /缺少背景内容/)
  assert.match(parseBackground('---\nvolume: x\n---\n\n# 背景\n文字\n').errors.join(), /## 篇名/)
  assert.deepEqual(splitAuthorLabel('唐 · 杜甫'), { dynasty: '唐', name: '杜甫' })
  assert.deepEqual(splitAuthorLabel('李白', '唐'), { dynasty: '唐', name: '李白' })
  assert.deepEqual(splitAuthorLabel('魏晉 · 西晋 · 李密'), { dynasty: '魏晉·西晋', name: '李密' }, 'the last segment is the name')
  const pool = [{ name: '王某', dynasty: '唐', errors: [] }, { name: '王某', dynasty: '北宋', errors: [] }]
  assert.equal(findAuthor(pool, '王某', '宋').dynasty, '北宋', 'same name: dynasty decides, 北宋 counts as 宋')
})

test('library: authors/ and backgrounds/ are read beside the volumes, never as volumes', async () => {
  await withLibrary(async ({ libraryDir, library }) => {
    await mkdir(join(libraryDir, 'authors'), { recursive: true })
    await mkdir(join(libraryDir, 'backgrounds'), { recursive: true })
    await writeFile(join(libraryDir, 'authors', '范仲淹.md'), AUTHOR)
    await writeFile(join(libraryDir, 'backgrounds', 'tangshi-liushou.md'), BACKGROUND.replace('{#s2}', '{#s99}'))
    const snapshot = await library.scan()
    assert.equal(snapshot.list.length, 3, 'only the three seed volumes')
    assert.equal(snapshot.authors.length, 1)
    assert.equal(snapshot.authors[0].origin, 'library')
    assert.match(snapshot.backgrounds['tangshi-liushou'].warnings.join(), /没有节 \{#s99\}/)
  })
})

test('tool: save-author and save-background validate, refuse to replace without overwrite, and write under the library', async () => {
  await withLibrary(async ({ libraryDir, library }) => {
    const lookups = []
    const authors = { lookup: async (name, dynasty) => { lookups.push([name, dynasty]); return { cbdb: { id: '8043' }, candidates: [], poetry: null, wiki: null, warnings: [] } } }
    const tool = createToolService({ library, libraryDir, authors })
    assert.equal((await tool.execute({ action: 'save-author', markdown: '---\nname: 某\n---\n' })).stage, 'format')
    const saved = await tool.execute({ action: 'save-author', markdown: AUTHOR })
    assert.equal(saved.ok, true)
    assert.equal(saved.facts, 3)
    assert.match(await readFile(join(libraryDir, 'authors', '范仲淹.md'), 'utf8'), /字希文/)
    assert.equal((await tool.execute({ action: 'save-author', markdown: AUTHOR })).stage, 'exists')
    assert.equal((await tool.execute({ action: 'save-author', markdown: AUTHOR, overwrite: true })).ok, true)

    const looked = await tool.execute({ action: 'author', name: '范仲淹', dynasty: '宋' })
    assert.equal(looked.ok, true)
    assert.match(looked.existing.markdown, /字希文/, 'an existing entry comes back so the Agent does not rewrite it')
    assert.deepEqual(lookups, [['范仲淹', '宋']])
    assert.equal((await tool.execute({ action: 'author', name: 'Fan Zhongyan' })).stage, 'input')

    assert.equal((await tool.execute({ action: 'save-background', id: 'nope', markdown: BACKGROUND })).stage, 'input')
    const wrongSection = await tool.execute({ action: 'save-background', id: 'tangshi-liushou', markdown: BACKGROUND.replace('{#s2}', '{#s99}') })
    assert.match(wrongSection.problems.join(), /没有节 \{#s99\}/)
    const mismatch = await tool.execute({ action: 'save-background', id: 'qian-chibi-fu', markdown: BACKGROUND })
    assert.match(mismatch.problems.join(), /不一致/)
    const ok = await tool.execute({ action: 'save-background', id: 'tangshi-liushou', markdown: BACKGROUND })
    assert.equal(ok.ok, true)
    assert.equal(ok.sections, 1)
    const snapshot = await library.scan()
    assert.deepEqual(snapshot.backgrounds['tangshi-liushou'].sections.s2.text, ['至德二载春，杜甫困居长安。'])
    assert.equal((await tool.execute({ action: 'save-background', id: 'tangshi-liushou', markdown: BACKGROUND })).stage, 'exists')
  })
})

test('CBDB person summary: aliases, places, dated postings, simplified by the converter', () => {
  const person = cbdbPerson({
    BasicInfo: { PersonId: '8043', ChName: '范仲淹', YearBirth: '989', YearDeath: '1052', Dynasty: '宋' },
    PersonAliases: { Alias: [{ AliasType: '字', AliasName: '希文' }, { AliasType: '諡號', AliasName: '文正' }] },
    PersonAddresses: { Address: { AddrType: '籍貫(基本地址)', AddrName: '吳縣' } },
    PersonEntryInfo: { Entry: { RuShiYear: '1015', EntryCode: '科舉: 進士(籠統)' } },
    PersonPostings: { Posting: [{ FirstYear: '1046', OfficeName: '知某州軍州事', AddrName: '鄧州' }, { FirstYear: '', OfficeName: '尚書省戶部侍郎', AddrName: '[未詳]' }, { FirstYear: '1028', OfficeName: '三司判官', AddrName: '[未詳]' }] },
    PersonKinshipInfo: { Kinship: [{ KinRelName: '父', KinPersonName: '范墉' }, { KinRelName: '父', KinPersonName: '范墉' }] }
  }, (text) => text.replace('諡號', '谥号').replace('貫', '贯').replace('吳', '吴').replace('縣', '县').replace('鄧', '邓'))
  assert.equal(person.life, '989—1052')
  assert.deepEqual(person.aliases, ['字 希文', '谥号 文正'])
  assert.deepEqual(person.places, ['籍贯 吴县'])
  assert.deepEqual(person.entries, ['1015 科舉: 進士(籠統)'])
  assert.deepEqual(person.postings.dated.map((item) => item.year), [1028, 1046], 'dated postings in order')
  assert.equal(person.postings.dated[1].place, '邓州')
  assert.equal(person.postings.dated[0].place, '', '[未详] becomes empty')
  assert.deepEqual(person.kin, ['父 范墉'], 'duplicates folded')
  const tang = { dynasty: '唐', postings: { count: 1 }, associations: { count: 0 } }
  const song = { dynasty: '宋', postings: { count: 9 }, associations: { count: 0 } }
  assert.equal(pickPerson([tang, song], '北宋').person, song)
  assert.equal(pickPerson([tang, song], '唐').person, tang)
  assert.equal(pickPerson([tang, song], '唐').ambiguous, false)
})

test('author sources: CBDB, chinese-poetry and Wikipedia combined, cached, and a failing source is only a warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-reader-authors-'))
  try {
    const calls = []
    const reply = (status, body) => ({ ok: status === 200, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
    const fetchImpl = async (url) => {
      calls.push(decodeURIComponent(url))
      if (url.includes('cbdbapi')) return reply(200, { Package: { PersonAuthority: { PersonInfo: { Person: { BasicInfo: { PersonId: '8043', ChName: '范仲淹', YearBirth: '989', YearDeath: '1052', Dynasty: '宋' } } } } } })
      if (url.includes('author.song.json')) return reply(200, [{ name: '范仲淹', description: '--(989－1052) 字希文。' }])
      if (url.includes('wikipedia')) return reply(503, 'busy')
      return reply(404, '')
    }
    const source = createAuthorSource({ cacheDir: dir, fetchImpl, t2s: (text) => text })
    const facts = await source.lookup('范仲淹', '宋')
    assert.equal(facts.cbdb.id, '8043')
    assert.equal(facts.poetry.collection, '宋词作者小传')
    assert.equal(facts.poetry.bio, '(989－1052) 字希文。', 'leading dashes removed')
    assert.equal(facts.wiki, null)
    assert.match(facts.warnings.join(), /维基百科摘要暂时取不到：HTTP 503/)
    const before = calls.length
    await createAuthorSource({ cacheDir: dir, fetchImpl, t2s: (text) => text }).lookup('范仲淹', '宋')
    assert.deepEqual(calls.slice(before).map((url) => url.includes('wikipedia')), [true], 'CBDB and chinese-poetry come from the cache; only the failed source is retried')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
