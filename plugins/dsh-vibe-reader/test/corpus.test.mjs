import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { COLLECTIONS, CorpusError, createCorpus, splitAuthor } from '../lib/corpus.js'
import { parseVolume } from '../lib/volume.js'

const fixture = JSON.parse(await readFile(new URL('./fixtures/chinese-poetry-sample.json', import.meta.url), 'utf8'))
const seed = async (id) => parseVolume(await readFile(new URL(`../seeds/${id}.md`, import.meta.url), 'utf8'))

const guwen = { content: [{ title: '卷', content: ['yueyanglou-ji', 'qian-chibi-fu'].map((id) => ({ chapter: fixture.volumes[id].title, author: fixture.volumes[id].author, paragraphs: fixture.volumes[id].paragraphs })) }] }
const longLines = Array.from({ length: 20 }, (_, index) => `第${index + 1}句兮。`)

/** Fake chinese-poetry + ctext over the fixture. Every other file is an empty collection. */
function fakeFetch({ files = {}, ctext = {} } = {}) {
  const calls = []
  const data = {
    '蒙学/guwenguanzhi.json': guwen,
    '全唐诗/唐诗三百首.json': fixture.volumes['tangshi-liushou'].poems,
    '宋词/宋词三百首.json': [
      { rhythmic: '念奴娇', author: '姜夔', paragraphs: ['闹红一舸。'] },
      { rhythmic: '念奴娇', author: '辛弃疾', paragraphs: ['野棠花落。'] },
      { rhythmic: '江神子・江城子', author: '苏轼', paragraphs: ['十年生死两茫茫。'] }
    ],
    '诗经/shijing.json': [{ title: '七月', chapter: '国风', section: '豳风', content: Array.from({ length: 7 }, (_, index) => `第${index + 1}章。`) }],
    '楚辞/chuci.json': [{ title: '离骚', section: '离骚', author: '屈原', content: longLines }],
    '蒙学/qianjiashi.json': { content: [{ type: '五言绝句', content: [{ chapter: '春眠', author: '（唐）孟浩然', paragraphs: ['春眠不覺曉，處處聞啼鳥。', '夜來風雨聲，花落知多少。'] }] }] },
    '四书五经/daxue.json': { chapter: '大學', paragraphs: ['大學之道，在明明德。'] },
    '四书五经/zhongyong.json': { chapter: '中庸', paragraphs: ['天命之謂性。'] },
    ...files
  }
  const fetchImpl = async (url) => {
    const href = String(url)
    calls.push(href)
    if (href.startsWith('https://api.ctext.org/')) {
      const parsed = new URL(href)
      const fn = parsed.pathname.slice(1)
      const reply = typeof ctext[fn] === 'function' ? ctext[fn](parsed.searchParams) : ctext[fn]
      return new Response(JSON.stringify(reply ?? { error: { code: 'ERR_UNKNOWN', description: 'no fake' } }))
    }
    const file = decodeURIComponent(href.split('/master/')[1])
    return new Response(JSON.stringify(data[file] ?? []))
  }
  return { fetchImpl, calls }
}

async function withCorpus(options, task) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'vibe-reader-corpus-'))
  const fake = fakeFetch(options)
  try {
    return await task(createCorpus({ cacheDir, fetchImpl: fake.fetchImpl, ctextKey: options.ctextKey }), fake, cacheDir)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
}

test('splitAuthor handles both corpus styles', () => {
  assert.deepEqual(splitAuthor('宋代：范仲淹 '), ['宋', '范仲淹'])
  assert.deepEqual(splitAuthor('（唐）孟浩然'), ['唐', '孟浩然'])
  assert.deepEqual(splitAuthor('李白'), ['', '李白'])
})

test('search → draft: 岳阳楼记 from 古文观止 carries the seed fingerprint', () => withCorpus({}, async (corpus) => {
  const result = await corpus.search({ query: '岳阳楼记' })
  assert.equal(result.hits[0].title, '岳阳楼记')
  assert.equal(result.hits[0].author, '范仲淹')
  assert.equal(result.hits[0].collection, '古文观止')
  assert.ok(!result.searched.includes('全唐诗'), 'deep collections are not searched by default')
  const draft = await corpus.draft({ refs: [result.hits[0].ref], id: 'yueyanglou-ji' })
  const volume = parseVolume(draft.markdown)
  assert.deepEqual(volume.errors, [])
  assert.equal(volume.integrity, 'ok')
  assert.equal(volume.actualFingerprint, (await seed('yueyanglou-ji')).actualFingerprint)
  assert.equal(volume.sections[0].title, '第 1 段')
  assert.deepEqual(volume.sections[0].notes, [{ word: '具', gloss: '通“俱”' }])
  assert.match(draft.markdown, /^fingerprint: sha256:[0-9a-f]{64}$/m)
  assert.equal(draft.original.replace(/\s/g, ''), volume.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join('').replace(/\s/g, ''))
}))

test('search by a famous line finds the poem with an excerpt; authors narrow; titles rank first', () => withCorpus({}, async (corpus) => {
  const byLine = await corpus.search({ query: '欲穷千里目' })
  assert.equal(byLine.hits[0].title, '登鹳雀楼')
  assert.equal(byLine.hits[0].match, 'text')
  assert.match(byLine.hits[0].excerpt, /欲穷千里目/)
  const qianjia = await corpus.search({ query: '春眠不觉晓' })
  assert.deepEqual(qianjia.hits.map((hit) => hit.collection).sort(), ['千家诗', '唐诗三百首'])
  const byAuthor = await corpus.search({ query: '春望', author: '杜甫' })
  assert.equal(byAuthor.hits.length, 1)
  assert.equal(byAuthor.hits[0].match, 'title')
  assert.equal((await corpus.search({ author: '杜甫' })).total, 2)
}))

test('词牌 prefix and unified dots; ambiguous names list every author', () => withCorpus({}, async (corpus) => {
  const ci = await corpus.search({ query: '念奴娇·赤壁怀古' })
  assert.deepEqual(ci.hits.map((hit) => hit.author), ['姜夔', '辛弃疾'], 'the corpus row is titled only by its 词牌')
  assert.equal((await corpus.search({ query: '江神子·江城子' })).hits[0].author, '苏轼')
  const none = await corpus.search({ query: '满江红' })
  assert.equal(none.hits.length, 0)
  assert.match(none.hint, /deep: true/)
}))

test('drafts split long poems and many stanzas; multi-poem volumes need a title', () => withCorpus({}, async (corpus) => {
  const [lisao] = (await corpus.search({ query: '离骚' })).hits
  const long = parseVolume((await corpus.draft({ refs: [lisao.ref], id: 'lisao' })).markdown)
  assert.deepEqual(long.sections.map((section) => section.title), ['离骚 · 1', '离骚 · 2', '离骚 · 3'])
  assert.equal(long.sections[0].paragraphs[0].text.split('\n').length, 8)
  assert.equal(long.sections[0].meta.author, '战国 · 屈原')
  const [qiyue] = (await corpus.search({ query: '七月', collections: ['shijing'] })).hits
  const stanzas = parseVolume((await corpus.draft({ refs: [qiyue.ref], id: 'qiyue' })).markdown)
  assert.deepEqual(stanzas.sections.map((section) => section.paragraphs.length), [4, 3])
  assert.equal(stanzas.sections[0].meta['出处'], '国风 · 豳风')
  const two = (await corpus.search({ author: '杜甫' })).hits.map((hit) => hit.ref)
  await assert.rejects(corpus.draft({ refs: two, id: 'du' }), /volumeTitle/)
  const volume = parseVolume((await corpus.draft({ refs: two, id: 'du', volumeTitle: '杜诗两首' })).markdown)
  assert.equal(volume.author, '杜甫')
  await assert.rejects(corpus.draft({ refs: [two[0], (await corpus.search({ query: '岳阳楼记' })).hits[0].ref], id: 'mix', volumeTitle: 'x' }), /不能合成一卷/)
  await assert.rejects(corpus.draft({ refs: two, id: 'Bad Id' }), CorpusError)
}))

test('deep collections download only on request, then come from the cache', () => withCorpus({}, async (corpus, fake, cacheDir) => {
  await corpus.search({ query: '岳阳楼记' })
  const before = fake.calls.length
  assert.ok(!fake.calls.some((url) => url.includes('poet.tang.')))
  await corpus.search({ query: '岳阳楼记', deep: true })
  const deepCalls = fake.calls.slice(before)
  assert.equal(deepCalls.filter((url) => url.includes('poet.tang.')).length, COLLECTIONS.quantangshi.files.length)
  assert.ok(deepCalls.some((url) => url.includes('ci.song.2019y')))
  const again = createCorpus({ cacheDir, fetchImpl: fake.fetchImpl })
  const count = fake.calls.length
  await again.search({ query: '岳阳楼记', deep: true })
  assert.equal(fake.calls.length, count, 'second instance reads the cache')
}))

test('ctext: title search without a key; gettext needs a key; directories list chapters', async () => {
  const ctext = {
    searchtexts: (params) => ({ books: [{ title: params.get('title') === '出师表' ? '前出师表' : '?', urn: 'ctp:wb712772' }] }),
    gettext: (params) => params.get('apikey')
      ? (params.get('urn') === 'ctp:analects' ? { title: '论语', subsections: ['ctp:analects/xue-er'] } : { title: '前出师表', fulltext: ['先帝创业未半而中道崩殂。', '臣本布衣。'] })
      : { error: { code: 'ERR_REQUIRES_AUTHENTICATION', description: 'auth' } }
  }
  await withCorpus({ ctext }, async (corpus, fake) => {
    const result = await corpus.search({ query: '出师表', ctext: true })
    assert.deepEqual(result.ctext, [{ ref: 'ctext:ctp:wb712772', collection: 'ctext', title: '前出师表', needsKey: true }])
    assert.ok(fake.calls.some((url) => url.includes('remap=gb')))
    await assert.rejects(corpus.draft({ refs: ['ctext:ctp:wb712772'], id: 'chushi-biao' }), (error) => error.code === 'CTEXT_AUTH' && /API key/.test(error.message))
  })
  await withCorpus({ ctext, ctextKey: 'k' }, async (corpus) => {
    const draft = await corpus.draft({ refs: ['ctext:ctp:wb712772'], id: 'chushi-biao' })
    const volume = parseVolume(draft.markdown)
    assert.deepEqual(volume.errors, [])
    assert.equal(volume.sections.length, 2)
    assert.equal(volume.source, 'ctext:ctp:wb712772')
    await assert.rejects(corpus.draft({ refs: ['ctext:ctp:analects'], id: 'lunyu' }), (error) => error.chapters?.[0] === 'ctext:ctp:analects/xue-er')
  })
})

test('蒙学: 千字文 phrases pair into couplets, 弟子规 spaces become commas, chapters become sections', async () => {
  const { pairPhrases, spacedLine } = await import('../lib/corpus.js')
  assert.deepEqual(pairPhrases(['天地玄黃', '宇宙洪荒', '日月盈昃']), ['天地玄黃，宇宙洪荒。', '日月盈昃。'])
  assert.equal(spacedLine('弟子規 聖人訓 首孝弟 次謹信'), '弟子規，聖人訓，首孝弟，次謹信。')
  const phrases = Array.from({ length: 40 }, (_, index) => '天地玄黃宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏'.slice((index % 6) * 4, (index % 6) * 4 + 4) || '閏餘成歲')
  const files = {
    '蒙学/qianziwen.json': { title: '千字文', author: '周興嗣', paragraphs: phrases },
    '蒙学/dizigui.json': { title: '弟子規', author: '李毓秀', content: [{ chapter: '總敘', paragraphs: ['弟子規 聖人訓 首孝弟 次謹信'] }, { chapter: '入則孝', paragraphs: ['父母呼 應勿緩 父母命 行勿懶'] }] },
    '蒙学/shenglvqimeng.json': { title: '聲律啓蒙', content: [{ title: '上卷', content: [{ chapter: '一 東', paragraphs: ['雲對雨，雪對風。', '沿對革，異對同。'] }] }] }
  }
  await withCorpus({ files }, async (corpus) => {
    const [qianzi] = (await corpus.search({ query: '千字文', collections: ['mengxue'] })).hits
    assert.equal(qianzi.author, '周兴嗣')
    const draft = await corpus.draft({ refs: [qianzi.ref], id: 'qianzi-wen' })
    const volume = parseVolume(draft.markdown)
    assert.deepEqual(volume.errors, [])
    assert.equal(volume.kind, 'poem')
    assert.deepEqual(volume.sections.map((section) => section.paragraphs[0].text.split('\n').length), [8, 8, 4], '20 couplets → 8 + 8 + 4')
    assert.equal(volume.sections[0].paragraphs[0].text.split('\n')[0], '天地玄黄，宇宙洪荒。')
    assert.match(draft.report.warnings.join(), /补「，」「。」/)
    const di = parseVolume((await corpus.draft({ refs: [(await corpus.search({ query: '弟子规' })).hits[0].ref], id: 'dizigui' })).markdown)
    assert.deepEqual(di.sections.map((section) => section.title), ['总叙', '入则孝'])
    assert.equal(di.sections[1].paragraphs[0].text, '父母呼，应勿缓，父母命，行勿懒。')
    const [dong] = (await corpus.search({ query: '声律启蒙' })).hits
    assert.equal(dong.title, '声律启蒙·一东')
    assert.equal(parseVolume((await corpus.draft({ refs: [dong.ref], id: 'shenglv-dong' })).markdown).kind, 'prose')
  })
})
