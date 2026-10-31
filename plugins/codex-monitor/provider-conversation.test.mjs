import assert from 'node:assert/strict'
import test from 'node:test'
import { kimiMessage, dshMessage } from './provider-conversation.js'

test('Kimi reads user text, streamed responses, imported history and folded tool/thought events', () => {
  const wrap = (event) => ({ type: 'context.append_loop_event', event })
  assert.equal(kimiMessage({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'question' }] } }).text, 'question')
  assert.equal(kimiMessage(wrap({ type: 'content.part', part: { type: 'text', text: 'answer' } })).text, 'answer')
  assert.equal(kimiMessage(wrap({ type: 'content.part', part: { type: 'think', think: 'notes' } })).kind, 'thought')
  assert.equal(kimiMessage(wrap({ type: 'tool.call', name: 'Shell', args: { command: 'ls' } })).label, 'Shell')
  assert.equal(kimiMessage({ type: 'context.append_message', message: { role: 'assistant', content: 'imported answer' } }).text, 'imported answer')
  assert.equal(kimiMessage({ role: 'assistant', content: 'old answer' }, { format: 'legacy' }).text, 'old answer')
  const mixed = kimiMessage({ role: 'assistant', content: 'explanation', tool_calls: [{ function: { name: 'Shell', arguments: 'pwd' } }] }, { format: 'legacy' })
  assert.equal(mixed.text, 'explanation')
  assert.equal(mixed.details[0].kind, 'tool')
  assert.equal(kimiMessage({ type: 'config.update', systemPrompt: 'hidden policy' }), null)
  assert.equal(kimiMessage({ ...wrap({ type: 'content.part', part: { type: 'text', text: 'child output' } }), agentId: 'child' }), null)
})

test('DSH reads nested assistant message content and excludes injected user context', () => {
  assert.equal(dshMessage({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'DSH answer' }] } } }).text, 'DSH answer')
  assert.equal(dshMessage({ type: 'user/message', data: { source: { kind: 'user' }, content: 'hello' } }).text, 'hello')
  assert.equal(dshMessage({ type: 'user/message', data: { source: { kind: 'user-approval' }, content: 'injected' } }), null)
  assert.equal(dshMessage({ type: 'system/message', data: { message: { content: 'policy' } } }), null)
  const response = dshMessage({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }] } } })
  assert.equal(response.text, 'answer')
  assert.equal(response.details[0].kind, 'thought')
  assert.equal(dshMessage({ type: 'tool/call', data: { name: 'Shell', arguments: 'pwd' } }).label, 'Shell')
})
