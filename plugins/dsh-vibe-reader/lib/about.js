/**
 * 知人论世：作者小传与作品背景（spec §7.2）。都不是原文，不进指纹，也不进背诵。
 *
 *   书库/authors/<姓名>.md       作者小传，按姓名供所有书卷共用（李白只写一份）
 *   书库/backgrounds/<卷id>.md   作品背景；组诗可再按节写 `## 篇名 {#s2}`
 *
 * 作者文件：frontmatter（name 必填，dynasty、life、cbdb、source）＋ 若干 `- 标签：内容` 要点 ＋ 小传段落。
 * 背景文件：frontmatter（volume 必填，source）＋ 全卷背景段落 ＋ 可选的各节背景。
 */
import { parseFrontmatter } from './volume.js'

export const AUTHOR_NAME = /^[\p{Script=Han}·]{1,12}$/u
export const LIMITS = Object.freeze({ facts: 8, fact: 80, bio: 700, background: 900, sectionBackground: 500 })
const FACT = /^-\s*([^：:]{1,8})[：:]\s*(.+)$/u
const HEADING = /^##\s+(.*?)\s*\{#([A-Za-z0-9_-]+)\}\s*$/
const length = (paragraphs) => paragraphs.reduce((sum, text) => sum + Array.from(text).length, 0)

/** Blank-line separated paragraphs (lines inside a paragraph are joined). */
function paragraphsOf(lines) {
  const out = []
  let current = []
  for (const line of lines) {
    if (line.trim()) current.push(line.trim())
    else if (current.length) {
      out.push(current.join(''))
      current = []
    }
  }
  if (current.length) out.push(current.join(''))
  return out
}

/** Parse one author file. Errors block saving; the reader skips files with errors. */
export function parseAuthor(source, fileName = '') {
  const { data, bodyStart, lines, errors } = parseFrontmatter(String(source || ''))
  const warnings = []
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (!name) errors.push('缺少 name（作者姓名）')
  else if (!AUTHOR_NAME.test(name)) errors.push(`name「${name}」应为 1～12 个汉字（可含 ·）`)
  if (fileName && name && fileName.replace(/\.md$/, '') !== name) warnings.push(`文件名 ${fileName} 与 name「${name}」不一致`)
  const facts = []
  const rest = []
  for (const line of lines.slice(bodyStart)) {
    const fact = FACT.exec(line.trim())
    if (fact) facts.push({ label: fact[1].trim(), value: fact[2].trim() })
    else if (line.trim().startsWith('#')) errors.push(`作者文件里不要用标题：「${line.trim()}」`)
    else rest.push(line)
  }
  const bio = paragraphsOf(rest)
  if (!bio.length) errors.push('缺少小传正文')
  if (facts.length > LIMITS.facts) errors.push(`要点最多 ${LIMITS.facts} 条，现有 ${facts.length} 条`)
  for (const fact of facts) if (Array.from(fact.value).length > LIMITS.fact) errors.push(`要点「${fact.label}」超过 ${LIMITS.fact} 字`)
  if (length(bio) > LIMITS.bio) errors.push(`小传超过 ${LIMITS.bio} 字（现 ${length(bio)} 字），请精简`)
  return {
    name,
    dynasty: typeof data.dynasty === 'string' ? data.dynasty.trim() : '',
    life: typeof data.life === 'string' ? data.life.trim() : '',
    cbdb: data.cbdb === undefined || data.cbdb === null ? '' : String(data.cbdb).trim(),
    source: typeof data.source === 'string' ? data.source.trim() : '',
    facts,
    bio,
    errors,
    warnings
  }
}

/** Parse one background file: whole-volume paragraphs plus optional per-section blocks. */
export function parseBackground(source, fileName = '') {
  const { data, bodyStart, lines, errors } = parseFrontmatter(String(source || ''))
  const warnings = []
  const volume = typeof data.volume === 'string' ? data.volume.trim() : ''
  if (!volume) errors.push('缺少 volume（书卷 id）')
  if (fileName && volume && fileName.replace(/\.md$/, '') !== volume) warnings.push(`文件名 ${fileName} 与 volume「${volume}」不一致`)
  const head = []
  const sections = {}
  let current = null
  for (const line of lines.slice(bodyStart)) {
    const heading = HEADING.exec(line.trim())
    if (heading) {
      if (sections[heading[2]]) errors.push(`节 {#${heading[2]}} 重复`)
      current = { title: heading[1], lines: [] }
      sections[heading[2]] = current
    } else if (line.trim().startsWith('#')) errors.push(`节标题要写成「## 篇名 {#s1}」：「${line.trim()}」`)
    else (current ? current.lines : head).push(line)
  }
  const text = paragraphsOf(head)
  const bySection = {}
  for (const [id, block] of Object.entries(sections)) {
    const paragraphs = paragraphsOf(block.lines)
    if (!paragraphs.length) errors.push(`节 {#${id}} 没有背景内容`)
    if (length(paragraphs) > LIMITS.sectionBackground) errors.push(`节 {#${id}} 的背景超过 ${LIMITS.sectionBackground} 字`)
    bySection[id] = { title: block.title, text: paragraphs }
  }
  if (!text.length && !Object.keys(bySection).length) errors.push('缺少背景内容')
  if (length(text) > LIMITS.background) errors.push(`全卷背景超过 ${LIMITS.background} 字（现 ${length(text)} 字），请精简`)
  return { volume, source: typeof data.source === 'string' ? data.source.trim() : '', text, sections: bySection, errors, warnings }
}

/** 「唐 · 杜甫」→ { dynasty: '唐', name: '杜甫' }; a bare name keeps the fallback dynasty. */
export function splitAuthorLabel(label, fallbackDynasty = '') {
  const parts = String(label || '').split(/[·・]/).map((part) => part.trim()).filter(Boolean)
  if (parts.length >= 2) return { dynasty: parts[0], name: parts.slice(1).join('·') }
  return { dynasty: fallbackDynasty, name: parts[0] || '' }
}

/** Pick the author entry for a name, preferring the same dynasty when several share it. */
export function findAuthor(authors, name, dynasty = '') {
  const same = (authors || []).filter((author) => author.name === name && !author.errors?.length)
  if (same.length <= 1) return same[0] || null
  const core = (value) => String(value || '').replace(/^[南北东西前后]/, '')
  return same.find((author) => core(author.dynasty) === core(dynasty)) || same[0]
}
