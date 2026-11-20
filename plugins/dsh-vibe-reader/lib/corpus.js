/**
 * 语料：chinese-poetry（下载后本地缓存）与 ctext（搜索免认证，取正文需 API key）。
 * search 找篇目，draft 生成书卷草稿（清洗、繁转简、抽出括注），供刻书匠补注后 import。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanParagraphs, loadT2S } from './clean.js'
import { yamlValue } from './importer.js'
import { fingerprintOf } from './volume.js'

const RAW = 'https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/'
const CTEXT = 'https://api.ctext.org/'
const LONG_POEM_LINES = 16
const POEM_CHUNK = 8
const STANZA_CHUNK = 4

export class CorpusError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'CorpusError'
    Object.assign(this, extra)
  }
}

function range(prefix, from, to, step, extra = []) {
  const files = []
  for (let n = from; n <= to; n += step) files.push(`${prefix}${n}.json`)
  return [...files, ...extra]
}

/** 「宋代：范仲淹」「（唐）孟浩然」→ [朝代, 作者] */
export function splitAuthor(value = '') {
  const text = String(value).trim()
  const colon = /^([^：:]+?)代?\s*[：:]\s*(.+)$/.exec(text)
  if (colon) return [colon[1].replace(/代$/, ''), colon[2].trim()]
  const paren = /^[（(]([^）)]+)[）)]\s*(.+)$/.exec(text)
  if (paren) return [paren[1], paren[2].trim()]
  return ['', text]
}

/** 千字文：语料每条是一个无标点的四字句，两句一联补「，」「。」。 */
export function pairPhrases(phrases) {
  const lines = []
  for (let index = 0; index < phrases.length; index += 2) {
    lines.push(phrases[index + 1] === undefined ? phrases[index] + '。' : `${phrases[index]}，${phrases[index + 1]}。`)
  }
  return lines
}

/** 弟子规：语料用空格分隔三字句，换成「，」并以「。」收尾（否则清洗时空格被删，句子会连在一起）。 */
export function spacedLine(line) {
  return String(line).trim().split(/\s+/).join('，') + '。'
}

const flat = (chapters) => chapters.flatMap((chapter) => chapter.lines)

/** 蒙学韵文：一联一行，按篇章分节。 */
function mengxueVerse(data, file) {
  if (!data || Array.isArray(data)) return []
  const name = file.split('/').pop()
  const base = { author: data.author || '佚名', layout: 'chapters' }
  if (name === 'qianziwen.json') {
    const chapters = [{ title: '千字文', lines: pairPhrases(data.paragraphs) }]
    return [{ ...base, title: '千字文', dynasty: '南朝梁', chapters, paragraphs: flat(chapters), note: '语料无标点，已按四字一句、两句一联补「，」「。」' }]
  }
  if (name.startsWith('sanzijing')) {
    const chapters = [{ title: '三字经', lines: data.paragraphs }]
    return [{ ...base, title: `三字經（${data.tags || ''}）`, dynasty: '宋', chapters, paragraphs: flat(chapters) }]
  }
  if (name === 'dizigui.json') {
    const chapters = data.content.map((chapter) => ({ title: chapter.chapter, lines: chapter.paragraphs.map(spacedLine) }))
    return [{ ...base, title: data.title, dynasty: '清', chapters, paragraphs: flat(chapters), note: '语料用空格分隔三字句，已换成「，」并以「。」收尾' }]
  }
  if (name === 'zengguangxianwen.json') {
    const chapters = data.content.map((chapter) => ({ title: chapter.chapter, lines: chapter.paragraphs }))
    return [{ ...base, title: data.title, dynasty: '明', chapters, paragraphs: flat(chapters) }]
  }
  const chapters = [{ title: data.title, lines: data.paragraphs }]
  return [{ ...base, title: data.title, dynasty: name === 'zhuzijiaxun.json' ? '明末清初' : '北宋', chapters, paragraphs: flat(chapters) }]
}

/** 蒙学骈文：声律启蒙按韵、幼学琼林按门类各成一篇，一段一节。 */
function mengxueProse(data) {
  if (!data || !Array.isArray(data.content)) return []
  return data.content.flatMap((volume) => volume.content || []).map((chapter) => ({
    title: `${data.title}·${String(chapter.chapter).replace(/^[一二三四五六七八九十]+\s*/, (match) => match.trim())}`,
    author: data.title.includes('聲律') ? '車萬育' : '程登吉',
    dynasty: '清',
    paragraphs: chapter.paragraphs,
    layout: 'sections'
  }))
}

const poem = (dynasty, titleKey = 'title', linesKey = 'paragraphs') => (data) => data.map((item) => ({
  title: item[titleKey] || item.title, author: item.author || '', dynasty, paragraphs: item[linesKey], layout: 'lines'
}))

export const COLLECTIONS = {
  guwenguanzhi: {
    label: '古文观止', tier: 'core', traditional: true, kind: 'prose', files: ['蒙学/guwenguanzhi.json'],
    items: (data) => data.content.flatMap((volume) => volume.content).map((item) => {
      const [dynasty, author] = splitAuthor(item.author)
      return { title: item.chapter, author, dynasty, paragraphs: item.paragraphs, layout: 'sections' }
    })
  },
  tang300: { label: '唐诗三百首', tier: 'core', traditional: true, kind: 'poem', files: ['全唐诗/唐诗三百首.json'], items: poem('唐') },
  songci300: { label: '宋词三百首', tier: 'core', traditional: false, kind: 'poem', files: ['宋词/宋词三百首.json'], items: poem('宋', 'rhythmic') },
  shijing: {
    label: '诗经', tier: 'core', traditional: false, kind: 'poem', files: ['诗经/shijing.json'],
    items: (data) => data.map((item) => ({ title: item.title, author: '佚名', dynasty: '先秦', group: [item.chapter, item.section].filter(Boolean).join(' · '), paragraphs: item.content, layout: 'stanzas' }))
  },
  qianjiashi: {
    label: '千家诗', tier: 'core', traditional: true, kind: 'poem', files: ['蒙学/qianjiashi.json'],
    items: (data) => data.content.flatMap((group) => group.content).map((item) => {
      const [dynasty, author] = splitAuthor(item.author)
      return { title: item.chapter, author, dynasty, paragraphs: item.paragraphs, layout: 'lines' }
    })
  },
  lunyu: {
    label: '论语', tier: 'core', traditional: false, kind: 'prose', files: ['论语/lunyu.json'],
    items: (data) => data.map((item) => ({ title: '论语·' + item.chapter, author: '', dynasty: '春秋', paragraphs: item.paragraphs, layout: 'sections' }))
  },
  sishu: {
    label: '大学 · 中庸 · 孟子', tier: 'core', traditional: true, kind: 'prose', files: ['四书五经/daxue.json', '四书五经/zhongyong.json', '四书五经/mengzi.json'],
    items: (data, file) => (Array.isArray(data) ? data : [data]).map((item) => ({
      title: file.includes('mengzi') ? '孟子·' + item.chapter : item.chapter, author: '', dynasty: '先秦', paragraphs: item.paragraphs, layout: 'sections'
    }))
  },
  chuci: {
    label: '楚辞', tier: 'core', traditional: false, kind: 'poem', files: ['楚辞/chuci.json'],
    items: (data) => data.map((item) => ({
      title: item.title, author: item.author || '', dynasty: ['屈原', '宋玉', '景差'].includes(item.author) ? '战国' : '', group: item.section && item.section !== item.title ? item.section : '', paragraphs: item.content, layout: 'lines'
    }))
  },
  nalan: { label: '纳兰性德词', tier: 'core', traditional: false, kind: 'poem', files: ['纳兰性德/纳兰性德诗集.json'], items: poem('清', 'title', 'para') },
  mengxue: {
    label: '蒙学', tier: 'core', traditional: true, kind: 'poem',
    files: ['蒙学/qianziwen.json', '蒙学/sanzijing-new.json', '蒙学/sanzijing-traditional.json', '蒙学/dizigui.json', '蒙学/zengguangxianwen.json', '蒙学/zhuzijiaxun.json', '蒙学/baijiaxing.json'],
    items: mengxueVerse
  },
  mengxueProse: { label: '蒙学（骈文）', tier: 'core', traditional: true, kind: 'prose', files: ['蒙学/shenglvqimeng.json', '蒙学/youxueqionglin.json'], items: mengxueProse },
  quantangshi: { label: '全唐诗', tier: 'deep', traditional: true, kind: 'poem', files: range('全唐诗/poet.tang.', 0, 57000, 1000), items: poem('唐') },
  quansongci: { label: '全宋词', tier: 'deep', traditional: false, kind: 'poem', files: range('宋词/ci.song.', 0, 21000, 1000, ['宋词/ci.song.2019y.json']), items: poem('宋', 'rhythmic') },
  yuanqu: { label: '元曲', tier: 'deep', traditional: false, kind: 'poem', files: ['元曲/yuanqu.json'], items: poem('元') },
  // 全宋诗约 25 万首、104 MB：只在 collections 里点名时才下载和搜索，不随 deep 加载进内存。
  quansongshi: { label: '全宋诗', tier: 'huge', traditional: true, kind: 'poem', files: range('全唐诗/poet.song.', 0, 254000, 1000), items: poem('宋') }
}

export const dots = (text) => String(text || '').replace(/[・•‧∙·]/g, '·').replace(/\s+/g, '')
const bare = (text) => String(text || '').replace(/[\p{P}\p{S}\s]/gu, '')
const identity = (text) => text

async function atomicWrite(file, text) {
  await mkdir(join(file, '..'), { recursive: true })
  const temporary = file + '.tmp'
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, file)
}

/**
 * @param {{ cacheDir: string, fetchImpl?: typeof fetch, ctextKey?: string, log?: (message: string) => void }} options
 */
export function createCorpus({ cacheDir, fetchImpl = fetch, ctextKey = '', log = () => {} }) {
  const indexes = new Map()

  async function loadFile(name, file, refresh) {
    const target = join(cacheDir, name, file.split('/').pop())
    let text = refresh ? null : await readFile(target, 'utf8').catch(() => null)
    if (!text) {
      log(`下载 ${COLLECTIONS[name].label}：${file}`)
      const response = await fetchImpl(RAW + file.split('/').map(encodeURIComponent).join('/'), { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new CorpusError(`下载 ${COLLECTIONS[name].label} 失败（${file}）：HTTP ${response.status}`)
      text = await response.text()
      await atomicWrite(target, text)
    }
    return JSON.parse(text)
  }

  /** Load (downloading once) and index one collection; entries carry simplified title, author and text. */
  function index(name, { refresh = false } = {}) {
    if (!refresh && indexes.has(name)) return indexes.get(name)
    const collection = COLLECTIONS[name]
    if (!collection) return Promise.reject(new CorpusError(`未知集子 ${name}；可选：${Object.keys(COLLECTIONS).join('、')}`))
    const job = (async () => {
      const convert = collection.traditional ? await loadT2S() : identity
      const entries = []
      for (const file of collection.files) {
        const data = await loadFile(name, file, refresh)
        for (const item of collection.items(data, file)) {
          if (!Array.isArray(item.paragraphs) || !item.paragraphs.length) continue
          const text = convert(item.paragraphs.join('\n'))
          entries.push({
            ref: `${name}:${entries.length}`,
            name,
            file,
            item,
            title: convert(item.title || ''),
            author: convert(item.author || ''),
            dynasty: item.dynasty || '',
            text,
            bareText: bare(text)
          })
        }
      }
      return entries
    })()
    indexes.set(name, job)
    job.catch(() => indexes.delete(name))
    return job
  }

  async function ctextFetch(fn, params) {
    const url = new URL(CTEXT + fn)
    for (const [key, value] of Object.entries({ ...params, remap: 'gb', if: 'zh', ...(ctextKey ? { apikey: ctextKey } : {}) })) url.searchParams.set(key, value)
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
    const data = await response.json().catch(() => ({}))
    if (data.error) {
      if (data.error.code === 'ERR_REQUIRES_AUTHENTICATION') {
        throw new CorpusError('ctext 取正文需要 API key（ctext.org 订阅）。在插件配置 ctextApiKey 或环境变量 CTEXT_API_KEY 里设置；也可以请用户直接粘贴原文。', { code: 'CTEXT_AUTH' })
      }
      throw new CorpusError(`ctext 返回错误：${data.error.description || data.error.code}`)
    }
    if (!response.ok) throw new CorpusError(`ctext 请求失败：HTTP ${response.status}`)
    return data
  }

  function hitOf(entry, match, query) {
    const lines = entry.text.split('\n')
    const hit = {
      ref: entry.ref,
      collection: COLLECTIONS[entry.name].label,
      title: entry.title,
      author: entry.author,
      dynasty: entry.dynasty,
      paragraphs: entry.item.paragraphs.length,
      chars: Array.from(entry.bareText).length,
      preview: lines.slice(0, 2).join(' ').slice(0, 48),
      match
    }
    if (match === 'text') {
      const at = entry.text.indexOf(query)
      if (at >= 0) hit.excerpt = entry.text.slice(Math.max(0, at - 12), at + query.length + 12).replace(/\n/g, ' ')
    }
    return hit
  }

  /**
   * Search titles (exact > prefix > contains > 词牌 prefix) and, for 4+ characters,
   * full text. Core collections by default; `deep` adds 全唐诗、全宋词、元曲; `ctext`
   * adds ctext title search.
   */
  async function search({ query = '', author = '', collections, deep = false, ctext = false, limit = 12 } = {}) {
    const q = dots(query)
    const wantedAuthor = String(author || '').trim()
    if (!q && !wantedAuthor) throw new CorpusError('请提供标题、名句或作者')
    const names = Array.isArray(collections) && collections.length
      ? collections.filter((name) => name !== 'ctext')
      : Object.keys(COLLECTIONS).filter((name) => COLLECTIONS[name].tier === 'core' || (deep && COLLECTIONS[name].tier === 'deep'))
    for (const name of names) if (!COLLECTIONS[name]) throw new CorpusError(`未知集子 ${name}`)
    const qBare = bare(q)
    const scored = []
    for (const [order, name] of names.entries()) {
      for (const entry of await index(name)) {
        if (wantedAuthor && !entry.author.includes(wantedAuthor)) continue
        const title = dots(entry.title)
        let score = 0
        let match = 'title'
        if (!q) score = 10
        else if (title === q) score = 100
        else if (title.startsWith(q)) score = 80
        else if (title.includes(q)) score = 60
        else if (title.length >= 2 && q.startsWith(title)) score = 50
        else if (qBare.length >= 4 && entry.bareText.includes(qBare)) {
          score = entry.bareText.startsWith(qBare) ? 40 : 30
          match = 'text'
        }
        if (score) scored.push({ score, order, entry, match })
      }
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order)
    const hits = scored.slice(0, limit).map(({ entry, match }) => hitOf(entry, match, q))
    const result = { hits, total: scored.length, searched: names.map((name) => COLLECTIONS[name].label) }
    if (ctext || collections?.includes('ctext')) {
      try {
        const data = q ? await ctextFetch('searchtexts', { title: q }) : { books: [] }
        result.ctext = (data.books || []).slice(0, limit).map((book) => ({ ref: 'ctext:' + book.urn, collection: 'ctext', title: book.title, needsKey: !ctextKey }))
      } catch (error) {
        result.ctextError = error.message
      }
    }
    if (!hits.length && !deep && !collections?.length) result.hint = '常用集子里没有，可加 deep: true 搜全唐诗、全宋词、元曲（首次需下载约 36 MB），先秦两汉典籍可加 ctext: true'
    return result
  }

  async function get(ref) {
    if (typeof ref !== 'string') throw new CorpusError('ref 无效')
    if (ref.startsWith('ctext:')) {
      const urn = ref.slice(6)
      const data = await ctextFetch('gettext', { urn })
      if (!Array.isArray(data.fulltext) || !data.fulltext.length) {
        throw new CorpusError(`ctext ${urn} 是目录，没有正文；请从下列章节里选一个再 draft`, { chapters: (data.subsections || []).slice(0, 80).map((urnOf) => 'ctext:' + urnOf) })
      }
      return {
        collection: { label: 'ctext', traditional: false, kind: 'prose' },
        source: 'ctext:' + urn,
        item: { title: data.title || urn, author: '', dynasty: '', paragraphs: data.fulltext, layout: 'sections' }
      }
    }
    const [name, position] = ref.split(':')
    const entries = await index(name)
    const entry = entries[Number(position)]
    if (!entry || entry.ref !== ref) throw new CorpusError(`找不到 ${ref}，请重新 search`)
    return { collection: COLLECTIONS[name], source: `chinese-poetry/${entry.file}`, item: entry.item }
  }

  return { search, get, index, draft: (options) => buildDraft(options, get) }
}

function chunk(list, size) {
  const out = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}

/**
 * Build a draft volume from corpus refs. Prose: one section per paragraph
 * (placeholder titles). Poems: one section per poem, long poems split every
 * 8 lines (4 stanzas for 诗经). Inline notes become notes; no translation.
 */
export async function buildDraft({ refs, id, volumeTitle }, get) {
  if (!Array.isArray(refs) || !refs.length) throw new CorpusError('请提供 refs')
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new CorpusError('id 应为小写拼音加连字符，如 loushi-ming')
  const picked = []
  for (const ref of refs) picked.push(await get(ref))
  const kinds = new Set(picked.map((entry) => entry.collection.kind))
  if (kinds.size > 1) throw new CorpusError('诗词和文章不能合成一卷')
  const kind = [...kinds][0]
  const sections = []
  const originalParts = []
  const report = { notes: 0, spaces: 0, punctuation: 0, quotes: 0, pairs: new Map(), warnings: [] }
  for (const { collection, item } of picked) {
    const convert = collection.traditional ? await loadT2S() : identity
    const cleaned = await cleanParagraphs(item.paragraphs, { traditional: collection.traditional })
    for (const key of ['notes', 'spaces', 'punctuation', 'quotes']) report[key] += cleaned.report[key]
    for (const pair of cleaned.report.pairs) report.pairs.set(pair.from + pair.to, (report.pairs.get(pair.from + pair.to) || 0) + pair.count)
    report.warnings.push(...cleaned.report.warnings.map((warning) => (picked.length > 1 ? `${convert(item.title)}：${warning}` : warning)))
    const title = convert(item.title)
    const author = convert(item.author)
    const meta = kind === 'poem' ? [`> 作者：${[item.dynasty, author].filter(Boolean).join(' · ') || '佚名'}`, ...(item.group ? [`> 出处：${item.group}`] : [])] : []
    if (item.note) report.warnings.push(`${title}：${item.note}`)
    if (item.layout === 'chapters') {
      const lines = cleaned.paragraphs.map((paragraph) => paragraph.text)
      const total = item.chapters.reduce((sum, chapter) => sum + chapter.lines.length, 0)
      if (lines.length !== total) throw new CorpusError(`${title} 清洗后行数变了（${total} → ${lines.length}），请检查语料`)
      let cursor = 0
      for (const chapter of item.chapters) {
        const part = lines.slice(cursor, cursor + chapter.lines.length)
        cursor += chapter.lines.length
        const chapterTitle = convert(chapter.title)
        const groups = chunk(part, part.length > LONG_POEM_LINES ? POEM_CHUNK : part.length)
        groups.forEach((group, index) => {
          sections.push({
            title: groups.length > 1 ? `${chapterTitle} · ${index + 1}` : chapterTitle,
            meta: sections.length === 0 ? meta : [],
            paragraphs: [group.join('\n')],
            notes: []
          })
          originalParts.push(group.join('\n'))
        })
      }
      continue
    }
    if (item.layout === 'sections') {
      cleaned.paragraphs.forEach((paragraph, index) => {
        sections.push({ title: `第 ${index + 1} 段`, meta: [], paragraphs: [paragraph.text], notes: paragraph.notes })
        originalParts.push(paragraph.text)
      })
      continue
    }
    const groups = item.layout === 'stanzas'
      ? chunk(cleaned.paragraphs, cleaned.paragraphs.length > STANZA_CHUNK + 2 ? STANZA_CHUNK : cleaned.paragraphs.length).map((part) => part.map((paragraph) => paragraph.text))
      : chunk(cleaned.paragraphs, cleaned.paragraphs.length > LONG_POEM_LINES ? POEM_CHUNK : cleaned.paragraphs.length).map((part) => [part.map((paragraph) => paragraph.text).join('\n')])
    const notes = cleaned.paragraphs.flatMap((paragraph) => paragraph.notes)
    groups.forEach((paragraphs, index) => {
      sections.push({
        title: groups.length > 1 ? `${title} · ${index + 1}` : title,
        meta: index === 0 ? meta : [],
        paragraphs,
        notes: index === 0 ? notes : []
      })
      originalParts.push(...paragraphs)
    })
  }
  const first = picked[0]
  const single = picked.length === 1
  const convertFirst = first.collection.traditional ? await loadT2S() : identity
  const authors = [...new Set(await Promise.all(picked.map(async (entry) => (entry.collection.traditional ? (await loadT2S())(entry.item.author) : entry.item.author))))]
  const title = volumeTitle || (single ? convertFirst(first.item.title) : '')
  if (!title) throw new CorpusError('多篇合成一卷时请提供 volumeTitle')
  const labels = [...new Set(picked.map((entry) => entry.collection.label))]
  const head = {
    id,
    title,
    author: authors.length === 1 ? authors[0] : '多家',
    dynasty: [...new Set(picked.map((entry) => entry.item.dynasty).filter(Boolean))].join('、'),
    kind,
    source: [...new Set(picked.map((entry) => entry.source))].join('、'),
    edition: labels.map((label) => label === 'ctext' ? 'ctext（简体映射）' : `${label}（chinese-poetry${picked.find((entry) => entry.collection.label === label).collection.traditional ? ' 繁体本转简' : ''}）`).join('、'),
    verified: 'corpus',
    fingerprint: fingerprintOf(sections.map((section) => ({ paragraphs: section.paragraphs.map((text) => ({ text })) })))
  }
  const lines = ['---', ...Object.entries(head).filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${yamlValue(String(value))}`), `tags: [${labels.join(', ')}]`, '---', '']
  sections.forEach((section, index) => {
    lines.push(`## ${section.title} {#s${index + 1}}`, ...section.meta, '')
    for (const paragraph of section.paragraphs) lines.push(paragraph, '')
    if (section.notes.length) lines.push(...section.notes.map((note) => `- 【${note.word}】${note.gloss}`), '')
  })
  return {
    markdown: lines.join('\n').replace(/\n+$/, '\n'),
    original: originalParts.join('\n\n'),
    sections: sections.length,
    chars: Array.from(bare(originalParts.join(''))).length,
    report: { ...report, pairs: [...report.pairs].map(([key, count]) => ({ from: Array.from(key)[0], to: Array.from(key)[1], count })).sort((a, b) => b.count - a.count) }
  }
}
