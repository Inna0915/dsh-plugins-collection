/**
 * 原文校验（spec §6.3）：书卷里的原文（规范化后）必须与输入原文逐字一致。
 */
import { normalizeText } from './volume.js'

const MAX_HUNKS = 8
const CONTEXT = 8

const MAX_EDITS = 400

/** Myers shortest edit script over two arrays; null when it needs more than `maxD` edits. */
function myers(a, b, maxD) {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxD)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3).fill(-1)
  v[offset + 1] = 0
  const trace = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, offset, n, m)
    }
  }
  return null
}

function backtrack(trace, offset, n, m) {
  const edits = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1
    const prevX = vd[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      edits.push({ op: 'keep' })
    }
    if (d > 0) edits.push(x === prevX ? { op: 'add', a: x, b: prevY } : { op: 'del', a: prevX, b: y })
    x = prevX
    y = prevY
  }
  return edits.reverse()
}

/**
 * Character-level diff as hunks `{ at, removed, added, before, after }`
 * (`at` indexes the expected text). Common prefix and suffix are trimmed
 * first; texts that differ too much come back as one coarse hunk.
 */
export function diffChars(expected, actual) {
  const a = Array.from(expected)
  const b = Array.from(actual)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const edits = myers(midA, midB, MAX_EDITS)
  const hunks = []
  if (!edits) {
    hunks.push({ at: start, removed: midA.join(''), added: midB.join(''), coarse: true })
  } else {
    let current = null
    for (const edit of edits) {
      if (edit.op === 'keep') {
        current = null
        continue
      }
      if (!current) {
        current = { at: start + edit.a, removed: '', added: '' }
        hunks.push(current)
      }
      if (edit.op === 'del') current.removed += midA[edit.a]
      else current.added += midB[edit.b]
    }
  }
  return hunks.map((hunk) => {
    const end = hunk.at + Array.from(hunk.removed).length
    return { ...hunk, before: a.slice(Math.max(0, hunk.at - CONTEXT), hunk.at).join(''), after: a.slice(end, end + CONTEXT).join('') }
  })
}

function clip(text, limit = 40) {
  const chars = Array.from(text)
  return chars.length > limit ? chars.slice(0, limit).join('') + `…（共 ${chars.length} 字）` : text
}

function describe(hunk) {
  if (hunk.coarse) return `第 ${hunk.at + 1} 字起差异太大，无法逐字定位：原文「${clip(hunk.removed)}」，书卷「${clip(hunk.added)}」`
  const where = `第 ${hunk.at + 1} 字附近「${hunk.before}【${hunk.removed || '∅'}】${hunk.after}」`
  if (!hunk.removed) return `${where}：书卷多了「${hunk.added}」`
  if (!hunk.added) return `${where}：书卷少了「${hunk.removed}」`
  return `${where}：原文「${hunk.removed}」，书卷写成「${hunk.added}」`
}

/**
 * Compare the input original with a parsed volume's original text.
 * Whitespace and `==` marks are ignored on both sides.
 */
export function checkOriginal(original, volume) {
  const expected = normalizeText(String(original).replace(/==/g, ''))
  const actual = normalizeText(volume.sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.text)).join(''))
  if (expected === actual) return { ok: true, length: Array.from(expected).length }
  if (!expected) return { ok: false, problems: ['没有提供原文，无法校验'], hunks: [] }
  const hunks = diffChars(expected, actual)
  return {
    ok: false,
    expectedLength: Array.from(expected).length,
    actualLength: Array.from(actual).length,
    hunks: hunks.slice(0, MAX_HUNKS),
    more: Math.max(0, hunks.length - MAX_HUNKS),
    problems: hunks.slice(0, MAX_HUNKS).map(describe)
  }
}
