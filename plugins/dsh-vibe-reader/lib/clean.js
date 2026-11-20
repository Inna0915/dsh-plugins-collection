/**
 * 语料清洗（spec §6.1）：抽出括号夹注、删除汉字间空白、半角句读转全角、繁转简。
 * 输出清洗后的段落和一份变更报告，报告里的繁简对应表供人工核对。
 */

export class CleanError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'CleanError'
  }
}

const HAN = /\p{Script=Han}/u
const CJK_NEAR = /[\p{Script=Han}，。；：？！、“”‘’「」『』《》（）…—]/u
const HALF_TO_FULL = { '?': '？', '!': '！', ',': '，', ';': '；', ':': '：' }
const NOTE_ENTRY = /^(\S+?)\s+([^\s：:]+)\s*[：:]\s*(.+)$/u
/** 整段只是编者注（如古文观止《烛之武退秦师》末尾的「（選自《左傳》）」），不属于原文。 */
const SOURCE_NOTE = /^[（(][^（）()]*[選选節节录錄出]自[^（）()]*[）)]$/u

/** 繁转简不会处理的常见异体字（实测 opencc-js t→cn）。只报告，不改原文。 */
export const VARIANTS = Object.freeze({ 崐: '昆', 茍: '苟', 猨: '猿', 桮: '杯', 胷: '胸', 鬭: '斗', 菓: '果', 竝: '并', 鴈: '雁', 麤: '粗', 甯: '宁' })

let converter

/** Lazily load opencc-js (t → cn). Missing package only disables traditional input. */
export async function loadT2S() {
  if (!converter) {
    converter = import('opencc-js/t2cn')
      .then(({ Converter }) => Converter({ from: 't', to: 'cn' }))
      .catch((error) => {
        converter = undefined
        throw new CleanError('繁转简需要 opencc-js：请在插件目录运行 npm install', error)
      })
  }
  return converter
}

function glossOf(relation, value) {
  const target = value.trim()
  if (['通', '同', '一作', '又作', '亦作'].includes(relation)) return `${relation}“${target}”`
  return `${relation}：${target}`
}

/**
 * Pull chinese-poetry style inline notes such as `(具 通：俱)` or
 * `(隐曜 一作：隐耀；淫雨 通：霪雨)` out of a paragraph. Only half-width
 * parentheses are treated as notes; a group that does not parse stays in
 * place and is reported.
 */
export function extractInlineNotes(text) {
  const notes = []
  const warnings = []
  const cleaned = text.replace(/\(([^()]*)\)/g, (whole, inner) => {
    const entries = inner.split(/[；;]/).map((entry) => entry.trim()).filter(Boolean)
    const parsed = entries.map((entry) => NOTE_ENTRY.exec(entry))
    if (!entries.length || parsed.some((match) => !match)) {
      warnings.push(`无法识别的括注「${whole}」，已保留在原文中，请人工处理`)
      return whole
    }
    for (const [, word, relation, value] of parsed) notes.push({ word, gloss: glossOf(relation, value) })
    return ''
  })
  return { text: cleaned, notes, warnings }
}

function fixPunctuation(text) {
  let count = 0
  const chars = Array.from(text)
  for (let index = 0; index < chars.length; index++) {
    const full = HALF_TO_FULL[chars[index]]
    if (!full) continue
    const near = CJK_NEAR.test(chars[index - 1] || '') || CJK_NEAR.test(chars[index + 1] || '') || index === chars.length - 1
    if (near) {
      chars[index] = full
      count++
    }
  }
  let quotes = 0
  const joined = chars.join('').replace(/"([^"\n]*)"/g, (_, inner) => {
    quotes++
    return '“' + inner + '”'
  })
  return { text: joined, punctuation: count, quotes }
}

function pairsOf(before, after) {
  const a = Array.from(before)
  const b = Array.from(after)
  if (a.length !== b.length) return null
  const pairs = new Map()
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) pairs.set(a[index] + b[index], (pairs.get(a[index] + b[index]) || 0) + 1)
  }
  return pairs
}

/**
 * Clean corpus paragraphs.
 * @param {string[]} paragraphs - raw paragraphs (one per poem line or prose paragraph).
 * @param {{ traditional?: boolean, t2s?: (text: string) => string }} options
 * @returns {Promise<{ paragraphs: { text: string, notes: { word: string, gloss: string }[] }[], report: object }>}
 */
export async function cleanParagraphs(paragraphs, { traditional = false, t2s } = {}) {
  const convert = traditional ? (t2s || await loadT2S()) : (text) => text
  const report = { notes: 0, spaces: 0, punctuation: 0, quotes: 0, pairs: [], variants: [], warnings: [] }
  const variants = new Map()
  const pairs = new Map()
  let lengthChanged = false
  const out = []
  for (const raw of paragraphs) {
    if (typeof raw !== 'string') throw new CleanError('段落必须是文本')
    if (SOURCE_NOTE.test(raw.trim())) {
      report.warnings.push(`删去编者注「${raw.trim()}」（不属于原文）`)
      continue
    }
    const extracted = extractInlineNotes(raw)
    report.notes += extracted.notes.length
    report.warnings.push(...extracted.warnings)
    const spaces = (extracted.text.match(/\s/g) || []).length
    report.spaces += spaces
    const fixed = fixPunctuation(extracted.text.replace(/\s+/g, ''))
    report.punctuation += fixed.punctuation
    report.quotes += fixed.quotes
    const text = convert(fixed.text)
    const changed = pairsOf(fixed.text, text)
    if (changed) for (const [key, count] of changed) pairs.set(key, (pairs.get(key) || 0) + count)
    else lengthChanged = true
    if (!text) continue
    for (const char of text) if (VARIANTS[char]) variants.set(char, (variants.get(char) || 0) + 1)
    out.push({
      text,
      notes: extracted.notes.map((note) => ({ word: convert(note.word), gloss: convert(note.gloss) }))
    })
  }
  report.pairs = [...pairs].map(([key, count]) => {
    const [from, to] = Array.from(key)
    return { from, to, count }
  }).sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))
  report.variants = [...variants].map(([char, count]) => ({ char, common: VARIANTS[char], count }))
  if (report.variants.length) {
    report.warnings.push('原文用了异体字：' + report.variants.map((item) => `${item.char}（通行作「${item.common}」）${item.count > 1 ? '×' + item.count : ''}`).join('、') + '。原文未改动；要不要改用通行字，请问用户（改用就请用户粘贴他要的版本）')
  }
  if (lengthChanged) report.warnings.push('繁转简改变了某段的字数（词组转换），繁简对应表不完整，请对照原文核对')
  const nonHan = out.some((paragraph) => !HAN.test(paragraph.text))
  if (nonHan) report.warnings.push('有段落不含汉字，请确认是否为正文')
  return { paragraphs: out, report }
}
