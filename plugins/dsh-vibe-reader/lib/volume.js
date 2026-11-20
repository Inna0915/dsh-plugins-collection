/**
 * 书卷解析：Markdown（frontmatter + `## 标题 {#id}` 分节）→ 结构化书卷。
 *
 * 规则见 plans/2026-11-20-vibe-reader/spec.md §5.2：
 * - 节下 `> 键：值` 是节信息（脉络、作者）；
 * - 普通段落是原文，`==…==` 只标名句；
 * - `- 【词】读音：释义` 是注释；
 * - `译：` 开头的段落是译文；
 * - 原文指纹 = 去掉标题、节信息、注释、译文、`==` 和所有空白后的正文 sha256。
 */
import { createHash } from 'node:crypto'

export const KINDS = Object.freeze(['poem', 'prose', 'article'])
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const SECTION_ID = /^[A-Za-z0-9][\w-]{0,39}$/
const SECTION = /^##\s+(.*?)\s*(?:\{#([^}]*)\})?\s*$/
const NOTE = /^-\s*【([^】]+)】\s*(.*)$/
// 读音只允许拼音字母、声调、空格和间隔号；不满足就整段当释义。
const READING = /^([a-zA-ZāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüÜ][a-zA-ZāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüÜ\s·'-]*?)\s*[：:]\s*(.+)$/
const META_KEYS = Object.freeze({ 脉络: 'guide', 作者: 'author' })

function unquote(value) {
  const match = /^(['"])(.*)\1$/.exec(value)
  return match ? match[2] : value
}

function stripComment(value) {
  let quote = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value
}

function scalar(raw) {
  const value = stripComment(raw.trim())
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((item) => unquote(item.trim())).filter(Boolean)
  }
  return unquote(value)
}

/** Minimal YAML subset: `key: value`, inline arrays, booleans, quoted strings, trailing comments. */
export function parseFrontmatter(source) {
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { data: {}, bodyStart: 0, lines, errors: ['缺少 frontmatter（首行应为 ---）'] }
  const data = {}
  const errors = []
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '---') return { data, bodyStart: index + 1, lines, errors }
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!match) {
      errors.push(`frontmatter 第 ${index + 1} 行无法解析`)
      continue
    }
    data[match[1]] = scalar(match[2])
  }
  return { data, bodyStart: lines.length, lines, errors: [...errors, 'frontmatter 没有结束的 ---'] }
}

/** Split one paragraph into plain text and quote ranges marked with `==…==`. */
export function parseQuotes(raw) {
  const parts = raw.split('==')
  if (parts.length % 2 === 0) return { text: parts.join(''), quotes: [], error: '名句标记 == 不成对' }
  let text = ''
  const quotes = []
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      if (part.includes('\n')) quotes.push({ start: text.length, end: text.length + part.length, text: part, multiline: true })
      else quotes.push({ start: text.length, end: text.length + part.length, text: part })
    }
    text += part
  })
  return { text, quotes }
}

export function normalizeText(text) {
  return text.normalize('NFC').replace(/\s+/gu, '')
}

export function fingerprintOf(sections) {
  const body = sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.text)).join('')
  return 'sha256:' + createHash('sha256').update(normalizeText(body), 'utf8').digest('hex')
}

function parseNote(line) {
  const match = NOTE.exec(line.trim())
  if (!match) return null
  const word = match[1].trim()
  const rest = match[2].trim()
  const withReading = READING.exec(rest)
  if (withReading) return { word, reading: withReading[1].trim(), gloss: withReading[2].trim() }
  return { word, gloss: rest.replace(/^[：:]\s*/, '') }
}

function blocksOf(lines, start, end) {
  const blocks = []
  let current = null
  for (let index = start; index < end; index++) {
    const line = lines[index]
    if (!line.trim()) {
      current = null
      continue
    }
    if (!current) {
      current = { line: index + 1, lines: [] }
      blocks.push(current)
    }
    current.lines.push(line.trim())
  }
  return blocks
}

function parseSection(header, lines, start, end, kind, errors, warnings) {
  const section = { id: header.id, title: header.title, line: header.line, meta: {}, paragraphs: [], notes: [], translation: '' }
  const translation = []
  for (const block of blocksOf(lines, start, end)) {
    const first = block.lines[0]
    if (first.startsWith('<!--')) continue
    if (first.startsWith('>')) {
      for (const line of block.lines) {
        const match = /^>\s*([^：:]+)[：:]\s*(.*)$/.exec(line)
        if (!match) {
          warnings.push(`第 ${block.line} 行：节信息应写成「> 键：值」`)
          continue
        }
        const key = META_KEYS[match[1].trim()] || match[1].trim()
        section.meta[key] = match[2].trim()
      }
    } else if (/^-(\s|【)/.test(first)) {
      // Any list block is a note list; original text never starts with a list marker.
      block.lines.forEach((line, offset) => {
        const note = parseNote(line)
        if (note) section.notes.push(note)
        else errors.push(`第 ${block.line + offset} 行：注释应写成「- 【词】读音：释义」`)
      })
    } else if (/^译[：:]/.test(first)) {
      translation.push(block.lines.join('').replace(/^译[：:]\s*/, ''))
    } else {
      const raw = block.lines.join(kind === 'poem' ? '\n' : '')
      const paragraph = parseQuotes(raw)
      if (paragraph.error) errors.push(`第 ${block.line} 行：${paragraph.error}`)
      if (paragraph.quotes.some((quote) => quote.multiline)) errors.push(`第 ${block.line} 行：名句不能跨行`)
      section.paragraphs.push({ text: paragraph.text, quotes: paragraph.quotes.map(({ start, end, text }) => ({ start, end, text })) })
    }
  }
  section.translation = translation.join('\n')
  if (!section.paragraphs.length) errors.push(`第 ${header.line} 行：节「${header.title}」没有原文`)
  const body = section.title + section.paragraphs.map((paragraph) => paragraph.text).join('')
  for (const note of section.notes) {
    if (!body.includes(note.word)) warnings.push(`节 ${header.id}：注释词「${note.word}」不在标题和原文中`)
  }
  return section
}

function verifiedOf(value) {
  if (value === true || value === 'true') return true
  if (value === 'corpus') return 'corpus'
  return false
}

/**
 * Parse one volume file.
 * @param {string} source - file content.
 * @param {string} [fileName] - for error messages and id fallback checks.
 */
export function parseVolume(source, fileName = '') {
  const { data, bodyStart, lines, errors } = parseFrontmatter(source.replace(/^﻿/, ''))
  const warnings = []
  const kind = KINDS.includes(data.kind) ? data.kind : null
  if (!kind) errors.push(`kind 应为 ${KINDS.join(' / ')}`)
  const id = typeof data.id === 'string' ? data.id : ''
  if (!ID.test(id)) errors.push('id 应为小写字母、数字和连字符')
  if (typeof data.title !== 'string' || !data.title.trim()) errors.push('缺少 title')

  const headers = []
  for (let index = bodyStart; index < lines.length; index++) {
    const line = lines[index]
    if (line.startsWith('## ')) {
      const match = SECTION.exec(line)
      const sectionId = match?.[2]?.trim()
      if (!sectionId) errors.push(`第 ${index + 1} 行：节标题缺少 {#id}`)
      else if (!SECTION_ID.test(sectionId)) errors.push(`第 ${index + 1} 行：节 id「${sectionId}」只能用字母、数字、下划线和连字符`)
      headers.push({ id: sectionId || `line-${index + 1}`, title: match?.[1]?.trim() || '', line: index + 1, index })
    } else if (!headers.length && line.trim() && !line.startsWith('# ') && !line.trim().startsWith('<!--')) {
      errors.push(`第 ${index + 1} 行：第一个节标题之前不能有正文`)
    }
  }
  if (!headers.length) errors.push('没有任何节（## 标题 {#id}）')

  const seen = new Set()
  const sections = headers.map((header, position) => {
    if (seen.has(header.id)) errors.push(`第 ${header.line} 行：节 id「${header.id}」重复`)
    seen.add(header.id)
    const end = position + 1 < headers.length ? headers[position + 1].index : lines.length
    return parseSection(header, lines, header.index + 1, end, kind || 'prose', errors, warnings)
  })

  const actualFingerprint = fingerprintOf(sections)
  const declared = typeof data.fingerprint === 'string' && data.fingerprint.startsWith('sha256:') ? data.fingerprint : ''
  const integrity = !declared ? 'missing' : declared === actualFingerprint ? 'ok' : 'mismatch'
  const verified = verifiedOf(data.verified)
  return {
    id,
    file: fileName,
    title: typeof data.title === 'string' ? data.title.trim() : '',
    author: typeof data.author === 'string' ? data.author : '',
    dynasty: typeof data.dynasty === 'string' ? data.dynasty : '',
    kind: kind || 'prose',
    source: typeof data.source === 'string' ? data.source : '',
    edition: typeof data.edition === 'string' ? data.edition : '',
    verified,
    color: typeof data.color === 'string' ? data.color : '',
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    fingerprint: declared,
    actualFingerprint,
    integrity,
    recitable: errors.length === 0 && integrity === 'ok' && verified !== false,
    sections,
    errors,
    warnings
  }
}

/** Summary row for the library list (no section bodies). */
export function summarize(volume) {
  const { sections, ...rest } = volume
  return {
    ...rest,
    sectionCount: sections.length,
    sectionIds: sections.map((section) => section.id),
    sectionList: sections.map((section) => ({ id: section.id, title: section.title, author: section.meta.author || '' }))
  }
}

/**
 * Encounter cards: whole short poems and every `==…==` quote.
 * Only volumes without parse errors contribute; recitability rides along.
 */
export function cardsOf(volume) {
  if (volume.errors.length) return []
  const cards = []
  for (const section of volume.sections) {
    const author = section.meta.author || [volume.dynasty, volume.author].filter(Boolean).join(' · ')
    if (volume.kind === 'poem') {
      cards.push({
        key: `${volume.id}#${section.id}`,
        kind: 'poem',
        volumeId: volume.id,
        sectionId: section.id,
        title: section.title,
        author,
        text: section.paragraphs.map((paragraph) => paragraph.text).join('\n'),
        recitable: volume.recitable
      })
    }
    for (const paragraph of section.paragraphs) {
      for (const quote of paragraph.quotes) {
        cards.push({
          key: `${volume.id}#${section.id}#${quote.text}`,
          kind: 'quote',
          volumeId: volume.id,
          sectionId: section.id,
          title: volume.kind === 'poem' ? section.title : volume.title,
          author,
          text: quote.text,
          recitable: volume.recitable
        })
      }
    }
  }
  return cards
}
