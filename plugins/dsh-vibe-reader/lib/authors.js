/**
 * 作者事实来源（spec §7.2）：CBDB 结构化事实、chinese-poetry 作者小传、维基百科摘要。
 * 只拿事实给 Agent 写小传；维基百科为 CC BY-SA，只作核对，不照抄。
 * 请求里只有历史人物姓名。结果缓存在本机：CBDB 与 chinese-poetry 永久，维基百科 30 天。
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadT2S } from './clean.js'

const CBDB = 'https://cbdb.fas.harvard.edu/cbdbapi/person.php'
const RAW = 'https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/'
const WIKI = 'https://zh.wikipedia.org/api/rest_v1/page/summary/'
const USER_AGENT = 'dsh-vibe-reader (local reading plugin)'
const WIKI_TTL_MS = 30 * 24 * 3600 * 1000
// chinese-poetry author files by dynasty; 全唐诗/authors.song.json holds the 全宋诗 poets.
const POETRY_AUTHORS = {
  tang: { file: '全唐诗/authors.tang.json', label: '全唐诗作者小传', traditional: true, bio: (item) => item.desc },
  songci: { file: '宋词/author.song.json', label: '宋词作者小传', traditional: false, bio: (item) => item.description || item.short_description },
  songshi: { file: '全唐诗/authors.song.json', label: '全宋诗作者小传', traditional: true, bio: (item) => item.desc }
}
const arr = (value) => (Array.isArray(value) ? value : value ? [value] : [])
const core = (dynasty) => String(dynasty || '').replace(/^[南北东西前后]/, '')

async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.tmp'
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, file)
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_')
}

/** Summarize one CBDB person (strings already simplified by `t`). */
export function cbdbPerson(person, t = (text) => text) {
  const basic = person.BasicInfo || {}
  const s = (value) => t(String(value ?? '').trim())
  const year = (value) => (Number(value) > 0 ? Number(value) : null)
  const birth = year(basic.YearBirth)
  const death = year(basic.YearDeath)
  const uniq = (list) => [...new Set(list.filter(Boolean))]
  const postings = arr(person.PersonPostings?.Posting)
    .map((item) => ({ year: year(item.FirstYear), office: s(item.OfficeName), place: s(item.AddrName).replace(/^\[未[详詳]\]$/, '') }))
    .filter((item) => item.office)
  const dated = postings.filter((item) => item.year).sort((a, b) => a.year - b.year)
  const associations = arr(person.PersonSocialAssociation?.Association)
    .map((item) => ({ year: year(item.Year), relation: s(item.AssocName), name: s(item.AssocPersonName) }))
    .filter((item) => item.name && !/^未[详詳]$/.test(item.name))
  return {
    id: s(basic.PersonId),
    name: s(basic.ChName),
    dynasty: s(basic.Dynasty),
    life: birth || death ? `${birth || '?'}—${death || '?'}` : '',
    aliases: uniq(arr(person.PersonAliases?.Alias).map((item) => `${s(item.AliasType)} ${s(item.AliasName)}`.trim())),
    places: uniq(arr(person.PersonAddresses?.Address).map((item) => `${s(item.AddrType).replace(/\(.*?\)/g, '')} ${s(item.AddrName)}`.trim())),
    entries: uniq(arr(person.PersonEntryInfo?.Entry).map((item) => [year(item.RuShiYear), s(item.EntryCode || item.EntryType)].filter(Boolean).join(' '))),
    status: uniq(arr(person.PersonSocialStatus?.SocialStatus).map((item) => s(item.StatusName))),
    postings: { count: postings.length, dated: dated.slice(0, 30), undated: postings.filter((item) => !item.year).slice(0, 10).map((item) => item.office) },
    kin: uniq(arr(person.PersonKinshipInfo?.Kinship).map((item) => `${s(item.KinRelName)} ${s(item.KinPersonName)}`.trim())).slice(0, 12),
    associations: { count: associations.length, sample: associations.sort((a, b) => (a.year || 9999) - (b.year || 9999)).slice(0, 15) },
    texts: uniq(arr(person.PersonTexts?.Text).map((item) => s(item.TextName))).slice(0, 10),
    sources: uniq(arr(person.PersonSources?.Source).map((item) => s(item.Source))).slice(0, 6),
    url: basic.PersonId ? `${CBDB}?id=${encodeURIComponent(basic.PersonId)}` : ''
  }
}

/** Choose the person matching the dynasty; candidates are returned so the Agent can tell the user when it is unsure. */
export function pickPerson(people, dynasty = '') {
  if (!people.length) return { person: null, ambiguous: false }
  const matching = dynasty ? people.filter((person) => core(person.dynasty) === core(dynasty) || person.dynasty.includes(core(dynasty))) : people
  const pool = matching.length ? matching : people
  const best = [...pool].sort((a, b) => b.postings.count + b.associations.count - (a.postings.count + a.associations.count))[0]
  return { person: best, ambiguous: pool.length > 1 }
}

/**
 * @param {{ cacheDir: string, fetchImpl?: typeof fetch, t2s?: (text: string) => string, now?: () => number }} options
 */
export function createAuthorSource({ cacheDir, fetchImpl = fetch, t2s, now = Date.now }) {
  const poetryIndexes = new Map()
  const convert = async () => t2s || (await loadT2S().catch(() => (text) => text))

  async function cached(file, maxAgeMs, load) {
    const info = await stat(file).catch(() => null)
    if (info && (!maxAgeMs || now() - info.mtimeMs < maxAgeMs)) return readFile(file, 'utf8')
    const text = await load()
    await atomicWrite(file, text)
    return text
  }

  async function get(url, headers = {}) {
    const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(60_000) })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
  }

  async function cbdb(name, dynasty) {
    const text = await cached(join(cacheDir, 'cbdb', safeName(name) + '.json'), 0, async () => (await get(`${CBDB}?name=${encodeURIComponent(name)}&o=json`)) || '{}')
    const data = JSON.parse(text || '{}')
    const t = await convert()
    const people = arr(data?.Package?.PersonAuthority?.PersonInfo?.Person).map((person) => cbdbPerson(person, t))
    const { person, ambiguous } = pickPerson(people, dynasty)
    return {
      person,
      candidates: ambiguous ? people.map((item) => ({ id: item.id, dynasty: item.dynasty, life: item.life, places: item.places.slice(0, 2) })) : []
    }
  }

  async function poetryIndex(key) {
    if (!poetryIndexes.has(key)) {
      const spec = POETRY_AUTHORS[key]
      poetryIndexes.set(key, (async () => {
        const text = await cached(join(cacheDir, 'chinese-poetry', spec.file.replace('/', '__')), 0, async () => {
          const body = await get(RAW + spec.file.split('/').map(encodeURIComponent).join('/'))
          if (!body) throw new Error(`下载 ${spec.label} 失败`)
          return body
        })
        const t = spec.traditional ? await convert() : (value) => value
        const index = new Map()
        for (const item of JSON.parse(text)) {
          const bio = String(spec.bio(item) || '').replace(/^-+/, '').trim()
          const name = t(String(item.name || '').trim())
          if (name && bio && !index.has(name)) index.set(name, t(bio))
        }
        return index
      })().catch((error) => {
        poetryIndexes.delete(key)
        throw error
      }))
    }
    return poetryIndexes.get(key)
  }

  async function poetry(name, dynasty) {
    const keys = core(dynasty) === '宋' ? ['songci', 'songshi'] : ['唐', '五代'].includes(core(dynasty)) || !dynasty ? ['tang'] : []
    for (const key of keys) {
      const bio = (await poetryIndex(key)).get(name)
      if (bio) return { collection: POETRY_AUTHORS[key].label, bio: bio.slice(0, 1200) }
    }
    return null
  }

  async function wiki(name) {
    const text = await cached(join(cacheDir, 'wikipedia', safeName(name) + '.json'), WIKI_TTL_MS, async () => (await get(WIKI + encodeURIComponent(name), { 'accept-language': 'zh-cn' })) || '{}')
    const data = JSON.parse(text || '{}')
    if (!data.extract || data.type === 'disambiguation') return null
    return { title: data.title, extract: String(data.extract).slice(0, 400), url: data.content_urls?.desktop?.page || '', license: 'CC BY-SA，只作核对，不要照抄原句' }
  }

  return {
    /** Facts about one author from every source; a failing source becomes a warning. */
    async lookup(name, dynasty = '') {
      const warnings = []
      const settle = async (label, task) => {
        try { return await task() } catch (error) {
          warnings.push(`${label}暂时取不到：${error instanceof Error ? error.message : String(error)}`)
          return null
        }
      }
      const [fromCbdb, fromPoetry, fromWiki] = await Promise.all([
        settle('CBDB ', () => cbdb(name, dynasty)),
        settle('chinese-poetry 作者小传', () => poetry(name, dynasty)),
        settle('维基百科摘要', () => wiki(name))
      ])
      if (fromCbdb && !fromCbdb.person) warnings.push(`CBDB 里没有「${name}」`)
      if (fromCbdb?.candidates.length) warnings.push(`CBDB 有 ${fromCbdb.candidates.length} 位同名人物，已按朝代选了最可能的一位；拿不准请核对 candidates`)
      return { cbdb: fromCbdb?.person || null, candidates: fromCbdb?.candidates || [], poetry: fromPoetry, wiki: fromWiki, warnings }
    }
  }
}
