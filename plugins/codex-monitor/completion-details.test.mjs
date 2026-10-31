import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { completionDetails, readCompletionFile } from './completion-details.js'
import { completionMarkdown, completionToast } from './notifications.js'
import { createDshSource } from './dsh-source.js'

const base = Date.parse('2026-10-26T00:00:00Z')
const time = (second) => new Date(base + second * 1000).toISOString()
const session = (provider, end = 70) => ({ sessionId: provider === 'codex' ? '019d0000-0000-7000-8000-000000000031' : `${provider}:session-test`, provider, title: '修复 [菜单](x) *完成*', model: 'fallback-model', reasoningEffort: 'high', observedAt: time(end), tokensUsed: 999999 })
const event = (type, second, payload = {}) => ({ type: 'event_msg', timestamp: time(second), payload: { type, ...payload } })
const dsh = (type, second, data = {}) => ({ type, time: base + second * 1000, data })
const kimi = (type, second, extra = {}) => ({ type, time: base + second * 1000, ...extra })
const loop = (type, second, extra = {}) => kimi('context.append_loop_event', second, { event: { type, ...extra } })

test('Codex uses cumulative delta across a completed turn and ignores newer turns and analysis', () => {
  const rows = [
    event('token_count', 0, { info: { total_token_usage: { total_tokens: 1000 } } }),
    event('task_started', 10),
    { type: 'turn_context', timestamp: time(11), payload: { model: 'gpt-6.1-sol', effort: 'max' } },
    { type: 'response_item', timestamp: time(12), payload: { type: 'message', role: 'assistant', channel: 'analysis', content: 'SECRET_THOUGHT' } },
    event('token_count', 60, { info: { total_token_usage: { total_tokens: 2600 } } }),
    event('token_count', 61, { info: { total_token_usage: { total_tokens: 2600 } } }),
    event('task_complete', 70, { last_agent_message: '## 完成\n\n- 已修复' }),
    event('task_started', 80), event('task_complete', 90, { last_agent_message: 'NEW_ANSWER' })
  ]
  const details = completionDetails(rows, session('codex'))
  assert.equal(details.durationMs, 60000); assert.equal(details.turnTokens, 1600)
  assert.equal(details.model, 'gpt-6.1-sol'); assert.equal(details.reasoningEffort, 'max')
  assert.equal(details.finalReply, '## 完成\n\n- 已修复')
  assert.equal(completionDetails(rows, session('codex', 75)), null)
})

test('Codex first turn can use zero baseline only when the whole log was read', () => {
  const rows = [event('task_started', 10), event('token_count', 60, { info: { total_token_usage: { total_tokens: 2600 } } }), event('task_complete', 70)]
  assert.equal(completionDetails(rows, session('codex')).turnTokens, null)
  assert.equal(completionDetails(rows, session('codex'), { completeFile: true }).turnTokens, 2600)
})

test('DSH numeric timestamps, per-turn usage and final answer exclude thought and tool content', () => {
  const rows = [
    dsh('assistant/message', 0, { usage: { totalTokens: 10000 } }), dsh('turn/start', 10),
    dsh('request/context', 11, { model: 'deepseek-v4', reasoningEffort: 'max' }),
    dsh('assistant/message', 15, { usage: { totalTokens: 300 }, message: { content: '准备调用', toolCalls: [{ name: 'bash' }] } }),
    dsh('tool/result', 30, { result: 'SECRET_TOOL' }),
    dsh('assistant/message', 60, { usage: { inputTokens: 700, outputTokens: 50 }, message: { content: [{ type: 'reasoning', text: 'SECRET_THOUGHT' }, { type: 'text', text: '**处理完成**' }] } }),
    dsh('turn/end', 70, { reason: { kind: 'completed' } })
  ]
  const details = completionDetails(rows, session('dsh'))
  assert.equal(details.durationMs, 60000); assert.equal(details.turnTokens, 1050)
  assert.equal(details.finalReply, '**处理完成**'); assert.equal(details.model, 'deepseek-v4')
  assert.equal(completionDetails(rows.slice(0, -1).concat(dsh('turn/end', 70, { reason: { kind: 'interrupted' } })), session('dsh')), null)
})

test('DSH does not present a tool-call preamble as the final answer', () => {
  const rows = [dsh('turn/start', 10), dsh('assistant/message', 15, { message: { content: '运行工具中' } }), dsh('tool/call', 20), dsh('turn/end', 70, { reason: { kind: 'completed' } })]
  assert.equal(completionDetails(rows, session('dsh')).finalReply, '')
})

test('Kimi preserves text chunks of the final step, ignores subagent and think events', () => {
  const rows = [kimi('prompt.accepted', 10), kimi('turn.prompt', 11),
    kimi('llm.request', 12, { model: 'k3.1-pro', thinkingEffort: 'max' }),
    loop('content.part', 13, { part: { type: 'text', text: '准备执行' } }), loop('tool.call', 15),
    loop('step.begin', 20), loop('content.part', 21, { part: { type: 'think', think: 'SECRET_THOUGHT' } }),
    loop('content.part', 30, { part: { type: 'text', text: '## 完成\n' } }), loop('content.part', 40, { part: { type: 'text', text: '已修复' } }),
    kimi('usage.record', 60, { usageScope: 'turn', usage: { inputOther: 100, inputCacheRead: 200, output: 50 } }),
    kimi('usage.record', 62, { agentId: 'child', usage: { output: 9999 } }),
    loop('step.end', 65, { finishReason: 'stop' }), kimi('prompt.completed', 70, { reason: 'completed' })]
  const details = completionDetails(rows, session('kimi'))
  assert.equal(details.durationMs, 60000); assert.equal(details.turnTokens, 350)
  assert.equal(details.finalReply, '## 完成\n已修复'); assert.equal(details.model, 'k3.1-pro')
})

test('Claude counts each API message once with cache tokens and keeps only end_turn text', () => {
  const assistant = (second, message, extra = {}) => ({ type: 'assistant', timestamp: time(second), message, ...extra })
  const rows = [
    { type: 'user', timestamp: time(10), message: { content: '修复问题' } },
    assistant(20, { id: 'm1', model: 'claude-opus', usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 5 }, content: [{ type: 'tool_use', input: 'SECRET_TOOL' }] }),
    assistant(21, { id: 'm1', usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 10 } }),
    { type: 'user', timestamp: time(30), message: { content: [{ type: 'tool_result', content: 'SECRET_TOOL' }] } },
    assistant(70, { id: 'm2', model: 'claude-opus', usage: { input_tokens: 400, output_tokens: 30 }, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'SECRET_THOUGHT' }, { type: 'text', text: '最终结果' }] }, { effort: 'xhigh' })
  ]
  const details = completionDetails(rows, session('claude'))
  assert.equal(details.durationMs, 60000); assert.equal(details.turnTokens, 740)
  assert.equal(details.reasoningEffort, 'xhigh'); assert.equal(details.finalReply, '最终结果')
})

test('missing start or damaged history never invents per-turn duration or usage', () => {
  const rows = [dsh('assistant/message', 60, { usage: { totalTokens: 40 }, message: { content: '最终回复' } }), dsh('turn/end', 70, { reason: { kind: 'completed' } })]
  const details = completionDetails(rows, session('dsh'))
  assert.equal(details.durationMs, null); assert.equal(details.turnTokens, null)
  assert.match(completionMarkdown(session('dsh'), details), /会话累计，非本轮/)
  const damaged = completionDetails([dsh('turn/start', 10), { type: 'kanban/unreadable' }, ...rows], session('dsh'))
  assert.equal(damaged.turnTokens, null); assert.equal(damaged.durationMs, null)
})

test('Claude final answer preserves multiple text blocks of the same message without repeating cumulative updates', () => {
  const rows = [{ type: 'user', timestamp: time(10), message: { content: '修复' } },
    { type: 'assistant', timestamp: time(20), message: { id: 'tool-step', content: '即将调用工具' } },
    { type: 'assistant', timestamp: time(30), message: { id: 'final', content: [{ type: 'text', text: '## 结果' }] } },
    { type: 'assistant', timestamp: time(40), message: { id: 'final', content: [{ type: 'text', text: '## 结果\n已修复' }] } },
    { type: 'assistant', timestamp: time(70), message: { id: 'final', stop_reason: 'end_turn', content: [{ type: 'text', text: '验证通过' }] } }]
  assert.equal(completionDetails(rows, session('claude')).finalReply, '## 结果\n已修复\n\n验证通过')
})

test('file tail limit does not infer a missing cumulative usage baseline', { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-completion-bound-'))
  try {
    const path = join(dir, 'rollout.jsonl')
    const rows = [event('token_count', 0, { info: { total_token_usage: { total_tokens: 1000 } } }),
      { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(9 * 1024 * 1024) } },
      event('task_started', 10), event('token_count', 60, { info: { total_token_usage: { total_tokens: 1200 } } }), event('task_complete', 70, { last_agent_message: '完成' })]
    await writeFile(path, rows.map(JSON.stringify).join('\n'))
    const details = await readCompletionFile(path, session('codex'))
    assert.equal(details.turnTokens, null); assert.equal(details.durationMs, 60000)
    assert.equal(details.finalReply, '完成')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Markdown escapes metadata, preserves reply formatting and repairs truncated fences', () => {
  const details = { durationMs: 3723000, turnTokens: 12345, finalReply: '### 结果\n\n```js\n' + '😀'.repeat(25000) }
  const rows = [event('task_started', 10), event('task_complete', 70, { last_agent_message: details.finalReply })]
  const parsed = completionDetails(rows, session('codex'))
  assert.equal(parsed.replyTruncated, true)
  assert.equal(Array.from(parsed.finalReply).length, 24000)
  const rendered = completionMarkdown(session('codex'), { ...details, ...parsed, durationMs: details.durationMs })
  assert.match(rendered, /1 小时 2 分 3 秒/)
  assert.ok(rendered.includes('\\[菜单\\]\\(x\\) \\*完成\\*'))
  assert.match(rendered, /\n```\n\n（回复过长/)
  assert.ok(completionToast(session('codex'), parsed).body.length < 650)
})

test('on-demand file read matches target completion and respects cancellation', { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-completion-'))
  try {
    const path = join(dir, 'rollout.jsonl')
    await writeFile(path, [event('task_started', 10), event('task_complete', 70, { last_agent_message: '旧完成' }), event('task_started', 80)].map(JSON.stringify).join('\n'))
    assert.equal((await readCompletionFile(path, session('codex'))).finalReply, '旧完成')
    await assert.rejects(readCompletionFile(path, session('codex'), { signal: AbortSignal.abort() }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('DSH completion reads use a read-only handle and always release it', async () => {
  let closed = 0
  const source = createDshSource({ sessions: { get: () => null }, get: () => ({
    async open(id, mode) {
      assert.equal(id, 'session-test'); assert.equal(mode, 'read')
      return { read: async () => ({ events: [dsh('turn/start', 10), dsh('assistant/message', 60, { message: { content: '成功' } }), dsh('turn/end', 70, { reason: { kind: 'completed' } })] }), close: async () => { closed++ } }
    }
  }) })
  assert.equal((await source.readCompletion(session('dsh'))).finalReply, '成功')
  assert.equal(closed, 1)
})
