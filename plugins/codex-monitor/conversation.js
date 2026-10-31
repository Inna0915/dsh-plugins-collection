import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const PAGE_SIZE = 30
const MAX_TEXT = 24000
const MAX_SCAN = 8 * 1024 * 1024
const MAX_LINE = 1024 * 1024

export function previewError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

export function contentText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return part
    if (['text', 'input_text', 'output_text', 'summary_text'].includes(part?.type)) return part.text || ''
    if (['image', 'input_image', 'image_url', 'audio', 'file'].includes(part?.type)) return '[附件暂不预览]'
    return ''
  }).filter(Boolean).join('\n')
}

export function message(role, content, extra = {}) {
  const body = contentText(content)
  if (!body.trim()) return null
  return { role, kind: 'message', text: body.slice(0, MAX_TEXT), truncated: body.length > MAX_TEXT, ...extra }
}

export function detail(role, name, value, extra = {}) {
  let body = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)
  return message(role, body || '（无文本内容）', { kind: role === 'thought' ? 'thought' : 'tool', label: name, ...extra })
}

export function codexMessage(row) {
  if (row.type !== 'response_item') return null
  const value = row.payload || {}
  const time = row.timestamp || null
  if (value.type === 'message' && ['user', 'assistant'].includes(value.role)) {
    const body = contentText(value.content)
    if (value.role === 'user' && /^(?:<environment_context>|<recommended_plugins>|<external_codex_apps_open_page>|# AGENTS\.md instructions)/.test(body.trim())) return null
    return message(value.role === 'assistant' && value.channel === 'analysis' ? 'thought' : value.role, body, {
      kind: value.channel === 'analysis' ? 'thought' : 'message', time
    })
  }
  if (['function_call', 'custom_tool_call'].includes(value.type)) return detail('tool', value.name || '工具调用', value.arguments ?? value.input, { time })
  if (['function_call_output', 'custom_tool_call_output'].includes(value.type)) return detail('tool', '工具结果', value.output, { time })
  if (value.type === 'reasoning') return message('thought', value.summary, { kind: 'thought', time })
  return null
}

function fingerprint(segments) {
  return createHash('sha256').update(JSON.stringify(segments.map((part) => [part.filePath, part.maxOrdinalExclusive]))).digest('hex').slice(0, 20)
}

export function decodeCursor(cursor, sessionId) {
  if (!cursor) return null
  try {
    if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[\w-]+$/.test(cursor)) throw new Error()
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value.v !== 1 || value.sessionId !== sessionId || !Number.isSafeInteger(value.segment) || value.segment < 0
      || !Number.isSafeInteger(value.before) || value.before < 0) throw new Error()
    return value
  } catch { throw previewError('分页位置无效，请刷新会话') }
}

export function encodeCursor(sessionId, state) {
  return Buffer.from(JSON.stringify({ v: 1, sessionId, ...state })).toString('base64url')
}

// Walk backwards with a bounded buffer. Cursor offsets always refer to complete
// physical lines, so appended records do not shift older pages.
async function* reverseLines(handle, end, budget) {
  let position = end
  let pending = Buffer.alloc(0)
  let lineEnd = end
  let oversized = false
  while (position > 0 && budget.bytes < MAX_SCAN) {
    const start = Math.max(0, position - 65536)
    const buffer = Buffer.allocUnsafe(position - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    if (bytesRead !== buffer.length) throw previewError('会话文件已变化，请刷新后重试', 409)
    budget.bytes += bytesRead
    const block = Buffer.concat([buffer, pending])
    let right = block.length
    for (let index = buffer.length - 1; index >= 0; index--) {
      if (block[index] !== 10) continue
      const lineStart = start + index + 1
      if (lineStart < lineEnd) {
        yield { text: oversized ? null : block.subarray(index + 1, right).toString('utf8'), start: lineStart, end: lineEnd }
      }
      oversized = false
      right = index
      lineEnd = start + index
    }
    pending = block.subarray(0, right)
    if (pending.length > MAX_LINE) { pending = Buffer.alloc(0); oversized = true }
    position = start
    if (position === 0 && lineEnd > 0) yield { text: oversized ? null : pending.toString('utf8'), start: 0, end: lineEnd }
  }
  if (position > 0) yield { text: undefined, start: oversized ? position : lineEnd, end: lineEnd, skipPartial: oversized, budgetReached: true }
}

export async function readJsonlPage(sessionId, segments, parse, cursor, options = {}) {
  const key = fingerprint(segments)
  const state = decodeCursor(cursor, sessionId)
  if (state && (state.key !== key || state.segment >= segments.length)) throw previewError('会话历史已变化，请刷新后重试', 409)
  const messages = []
  const warnings = new Set()
  const budget = { bytes: 0 }
  const limit = Math.max(1, Math.min(options.limit || PAGE_SIZE, PAGE_SIZE))
  let nextCursor = null
  let responseChars = 0
  outer: for (let segment = state?.segment || 0; segment < segments.length; segment++) {
    const part = segments[segment]
    const handle = await open(part.filePath, 'r')
    try {
      const info = await handle.stat()
      const end = segment === state?.segment ? state.before : info.size
      let skipPartial = segment === state?.segment && state.skipPartial === true
      if (end > info.size) throw previewError('会话文件已变化，请刷新后重试', 409)
      for await (const line of reverseLines(handle, end, budget)) {
        if (line.budgetReached) {
          nextCursor = encodeCursor(sessionId, { key, segment, before: line.start, skipPartial: skipPartial || line.skipPartial })
          warnings.add('此页已达读取上限，可继续加载更早记录')
          break outer
        }
        if (skipPartial) { skipPartial = false; continue }
        if (line.text === null) { warnings.add('一条超大记录未展开'); continue }
        if (!line.text.trim()) continue
        let row
        try { row = JSON.parse(line.text) } catch { warnings.add('部分未写完或损坏的记录已跳过'); continue }
        if (part.maxOrdinalExclusive != null && (!Number.isInteger(row.ordinal) || row.ordinal >= part.maxOrdinalExclusive)) continue
        const item = parse(row, part)
        if (!item) continue
        if (messages.length >= limit || responseChars + item.text.length > 300000) {
          nextCursor = encodeCursor(sessionId, { key, segment, before: line.end })
          break outer
        }
        responseChars += item.text.length
        messages.unshift({ ...item, id: `${segment}:${line.start}` })
      }
    } finally { await handle.close() }
  }
  return { sessionId, messages, nextCursor, warnings: [...warnings] }
}

export function pageEvents(sessionId, events, parse, cursor) {
  const state = decodeCursor(cursor, sessionId)
  if (state && (state.key !== 'events' || state.segment !== 0 || state.before > events.length)) throw previewError('会话历史已变化，请刷新后重试', 409)
  const messages = []
  let index = state ? state.before - 1 : events.length - 1
  let scanned = 0
  for (; index >= 0 && messages.length < PAGE_SIZE && scanned < 2000; index--, scanned++) {
    const item = parse(events[index])
    if (item) messages.unshift({ ...item, id: `event:${events[index].seq ?? index}` })
  }
  return { sessionId, messages, nextCursor: index >= 0 ? encodeCursor(sessionId, { key: 'events', segment: 0, before: index + 1 }) : null, warnings: [] }
}
