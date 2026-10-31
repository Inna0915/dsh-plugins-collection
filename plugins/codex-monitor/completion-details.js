import { open } from 'node:fs/promises'
import { contentText } from './conversation.js'
import { iso } from './session-common.js'

const MAX_SCAN = 8 * 1024 * 1024
const MAX_REPLY = 24000
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const sum = (values) => values.some((value) => number(value) !== null)
  ? values.reduce((total, value) => total + (number(value) ?? 0), 0) : null
const sameTime = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b)

function plainContent(value) {
  return typeof value === 'string' ? value : contentText(Array.isArray(value)
    ? value.filter((part) => ['text', 'input_text', 'output_text'].includes(part?.type)) : [])
}

// Only invoked for a new completion, never from the board polling path. Bound
// both I/O and retained text; a missing start produces unknown turn metrics.
export async function readCompletionFile(filePath, session, options = {}) {
  options.signal?.throwIfAborted()
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    const offset = Math.max(0, info.size - MAX_SCAN)
    const buffer = Buffer.alloc(info.size - offset)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    options.signal?.throwIfAborted()
    let body = buffer.subarray(0, bytesRead).toString('utf8')
    if (offset) body = body.includes('\n') ? body.slice(body.indexOf('\n') + 1) : ''
    const rows = body.split('\n').filter((line) => line.trim()).map((line) => {
      try { return JSON.parse(line) } catch { return { type: 'kanban/unreadable' } }
    })
    return completionDetails(rows, session, { completeFile: offset === 0 })
  } finally { await handle.close() }
}

export function completionDetails(rows, session, options = {}) {
  const provider = session.provider || (session.sessionId.includes(':') ? session.sessionId.split(':')[0] : 'codex')
  let startedAt = null; let active = false; let finished = false; let damaged = false
  let model = ''; let effort = ''; let reply = ''; let replyTruncated = false
  let assistantId = null
  let tokens = null; let totalTokens = null; let baseline = null
  const usageById = new Map()
  function start(time, force = false) {
    if (active && !finished && !force) return
    startedAt = time || null; active = true; finished = false; damaged = false
    reply = ''; replyTruncated = false; tokens = null; usageById.clear()
    assistantId = null
    baseline = totalTokens ?? (options.completeFile ? 0 : null)
  }
  function answer(value, append = false) {
    const text = plainContent(value)
    const combined = append ? reply + text : text
    const characters = Array.from(combined)
    replyTruncated = (append && replyTruncated) || characters.length > MAX_REPLY
    reply = characters.slice(0, MAX_REPLY).join('')
  }
  function addUsage(value) { if (number(value) !== null) tokens = (tokens ?? 0) + value }
  function result() {
    const durationMs = Date.parse(session.observedAt) - Date.parse(startedAt)
    return {
      model: model || session.model, reasoningEffort: effort || session.reasoningEffort,
      durationMs: !damaged && active && durationMs >= 0 ? durationMs : null,
      turnTokens: !damaged && active ? tokens : null,
      finalReply: reply, replyTruncated
    }
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (row.type === 'kanban/unreadable') { damaged = true; continue }
    if (row.agentId && row.agentId !== 'main') continue
    const time = iso(row.time ?? row.timestamp ?? row.created_at)
    // Match the observed completion, even if a new turn was appended while queued.
    if (time && Date.parse(time) > Date.parse(session.observedAt)) continue
    let complete = false
    if (provider === 'codex') {
      const value = row.payload || {}
      if (row.type === 'turn_context') {
        model = value.model || model; effort = value.effort || value.reasoning_effort || effort
      }
      if (row.type === 'event_msg') {
        if (['task_started', 'turn_started', 'turn/started'].includes(value.type)) start(time, true)
        if (value.type === 'token_count') {
          const latest = number(value.info?.total_token_usage?.total_tokens)
          if (latest !== null) {
            totalTokens = latest
            tokens = active && baseline !== null && latest >= baseline ? latest - baseline : null
          }
        }
        complete = ['task_complete', 'turn_completed', 'turn/completed'].includes(value.type)
        if (complete && typeof value.last_agent_message === 'string') answer(value.last_agent_message)
      }
      if (row.type === 'response_item' && value.type === 'message' && value.role === 'assistant'
        && (value.phase === 'final_answer' || value.channel === 'final')) answer(value.content)
    } else if (provider === 'dsh') {
      const data = row.data || {}
      if (row.type === 'turn/start') start(time, true)
      if (['model/selection', 'request/context'].includes(row.type)) {
        model = data.model || model; effort = data.reasoningEffort || effort
      }
      if (row.type === 'request/header') effort = data.header?.config?.reasoningEffort || effort
      if (row.type === 'assistant/message') {
        const value = data.message || data
        addUsage(number(data.usage?.totalTokens) ?? sum([data.usage?.inputTokens, data.usage?.outputTokens]))
        const hasCalls = value.toolCalls?.length || value.tool_calls?.length
          || (Array.isArray(value.content) && value.content.some((part) => ['tool_use', 'tool-call', 'tool_call'].includes(part.type)))
        answer(hasCalls ? '' : value.content)
      }
      if (row.type === 'tool/call') answer('')
      complete = row.type === 'turn/end' && data.reason?.kind === 'completed'
    } else if (provider === 'kimi' || provider === 'kimi-cli') {
      if (['prompt.accepted', 'turn.prompt', 'turn.started', 'turn.begin'].includes(row.type)) start(time)
      if (['llm.request', 'profile.bind', 'config.update'].includes(row.type) && (!row.kind || row.kind === 'loop')) {
        model = row.model || model; effort = row.thinkingEffort || effort
      }
      if (row.type === 'usage.record' && (!row.usageScope || row.usageScope === 'turn')) {
        const usage = row.usage || {}
        const input = sum(['inputOther', 'inputCacheRead', 'inputCacheCreation', 'input_other', 'input_cache_read', 'input_cache_creation'].map((key) => usage[key])) ?? number(usage.inputTokens)
        addUsage(sum([input, usage.output ?? usage.outputTokens]))
      }
      if (row.type === 'context.append_message' && row.message?.role === 'assistant') {
        answer(row.message.toolCalls?.length || row.message.tool_calls?.length ? '' : row.message.content)
      }
      if (row.type === 'context.append_loop_event') {
        const event = row.event || {}
        if (['step.begin', 'step.start', 'tool.call'].includes(event.type)) answer('')
        if (event.type === 'content.part' && event.part?.type === 'text') answer(event.part.text, true)
        complete = event.type === 'step.end' && ['stop', 'end_turn'].includes(event.finishReason)
      }
      complete ||= ['turn.ended', 'prompt.completed'].includes(row.type) && row.reason === 'completed'
    } else if (provider === 'claude') {
      if (row.isSidechain || row.isMeta || row.isCompactSummary
        || (row.sessionId && row.sessionId !== session.sessionId.slice(7))) continue
      const value = row.message || {}; const parts = Array.isArray(value.content) ? value.content : []
      if (row.type === 'user' && !row.toolUseResult && !parts.some((part) => part.type === 'tool_result') && plainContent(value.content).trim()) start(time)
      if (row.type === 'assistant') {
        if (value.model && value.model !== '<synthetic>') model = value.model
        effort = row.effort || effort
        if (value.usage && value.id) {
          const input = sum(['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map((key) => value.usage[key]))
          const output = number(value.usage.output_tokens)
          const previous = usageById.get(value.id) || { input: 0, output: 0 }
          if (input !== null || output !== null) {
            usageById.set(value.id, { input: Math.max(previous.input, input ?? 0), output: Math.max(previous.output, output ?? 0) })
            tokens = [...usageById.values()].reduce((total, usage) => total + usage.input + usage.output, 0)
          }
        }
        // Claude can persist separate text blocks under one API message ID.
        // Collect those blocks, but do not mix in an earlier tool step's text.
        if (!value.id || value.id !== assistantId) { answer(''); assistantId = value.id || null }
        const text = plainContent(value.content)
        if (text) {
          if (!reply || text.startsWith(reply)) answer(text)
          else if (!reply.endsWith(text)) answer(`\n\n${text}`, true)
        }
        complete = value.stop_reason === 'end_turn' && Boolean(text.trim())
      }
    }
    if (complete) {
      finished = true
      if (sameTime(time, session.observedAt)) return result()
    }
  }
  // Never substitute a previous or a newer turn's answer when the exact end is missing.
  return null
}
