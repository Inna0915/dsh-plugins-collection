import { contentText, message, detail } from './conversation.js'

function importedAssistant(value, time) {
  const body = contentText(value.content)
  const calls = value.toolCalls || value.tool_calls || []
  const details = []
  if (value.reasoning_content) details.push(detail('thought', '展开思考记录', value.reasoning_content))
  if (calls.length) details.push(detail('tool', '工具调用', calls))
  if (body) return message('assistant', body, { time, details })
  return details.length ? { ...details[0], time, details: details.slice(1) } : null
}

export function kimiMessage(row, segment = {}) {
  if (segment.format === 'legacy') {
    if (row.role === 'tool') return detail('tool', '工具结果', row.content)
    if (!['user', 'assistant'].includes(row.role)) return null
    return row.role === 'assistant' ? importedAssistant(row, null) : message('user', row.content)
  }
  if (row.agentId && row.agentId !== 'main') return null
  const time = row.time || null
  if (row.type === 'context.append_message') {
    const value = row.message || {}
    if (value.role === 'user') return message('user', value.content, { time })
    // Assistant streaming content is recorded as loop events; imported history
    // also stores complete assistant messages in append_message records.
    if (value.role === 'assistant') return importedAssistant(value, time)
    if (value.role === 'tool') return detail('tool', '工具结果', value.content, { time })
  }
  if (row.type !== 'context.append_loop_event') return null
  const event = row.event || {}
  if (event.type === 'content.part') {
    const part = event.part || {}
    if (part.type === 'think') return message('thought', part.think, { kind: 'thought', time })
    if (part.type === 'text') return message('assistant', part.text, { time })
  }
  if (event.type === 'tool.call') return detail('tool', event.name || '工具调用', event.args, { time })
  if (event.type === 'tool.result') return detail('tool', '工具结果', event.result, { time })
  return null
}

export function dshMessage(event) {
  const value = event.data || {}
  const time = event.time || null
  if (event.type === 'user/message' && value.source?.kind === 'user') return message('user', value.content, { time })
  if (event.type === 'assistant/message') {
    const assistant = value.message || value
    const body = contentText(assistant.content)
    const thought = Array.isArray(assistant.content) ? assistant.content.filter((part) => part.type === 'reasoning').map((part) => part.text || '').join('\n') : ''
    const reasoning = thought ? detail('thought', '展开思考记录', thought, { time }) : null
    return body ? message('assistant', body, { time, details: reasoning ? [reasoning] : [] }) : reasoning
  }
  if (event.type === 'tool/call') return detail('tool', value.name || '工具调用', value.arguments, { time })
  if (event.type === 'tool/result' || event.type === 'tool/message') return detail('tool', value.name || '工具结果', value.result ?? value.message?.content ?? value.content, { time })
  return null
}

export function claudeMessage(row, segment = {}) {
  if (row.isSidechain || row.isMeta || row.isCompactSummary || (row.sessionId && segment.sessionId && row.sessionId !== segment.sessionId)) return null
  if (!['user', 'assistant'].includes(row.type)) return null
  const value = row.message || {}
  const parts = Array.isArray(value.content) ? value.content : []
  const time = row.timestamp || null
  const details = []
  for (const part of parts) {
    if (part.type === 'thinking') details.push(detail('thought', '展开思考记录', part.thinking, { time }))
    if (part.type === 'tool_use') details.push(detail('tool', part.name || '工具调用', part.input, { time }))
    if (part.type === 'tool_result') details.push(detail('tool', '工具结果', contentText(part.content), { time }))
  }
  const body = contentText(value.content)
  if (body.trim()) return message(row.type, body, { time, details: details.filter(Boolean) })
  const present = details.filter(Boolean)
  return present.length ? { ...present[0], details: present.slice(1) } : null
}
