import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { codeSession, createWireSummary, consumeWire, parseModelWindows, sourceLabel, createCodeSource } from './kimi-source.js'
import { parseDshSession, createDshSource } from './dsh-source.js'


const at = 1790726400000

test('Kimi Code 按真实事件计算状态、提问数和 token，不将 maxTokens 当作上下文窗口', () => {
  const summary = createWireSummary()
  const events = [
    { type: 'prompt.accepted', promptId: 'p1', time: at },
    { type: 'turn.prompt', time: at },
    { type: 'llm.request', provider: 'openai', model: 'k3', modelAlias: 'kimi-code/k3', thinkingEffort: 'max', maxTokens: 123, time: at + 1 },
    { type: 'usage.record', usage: { inputOther: 50, inputCacheRead: 100, inputCacheCreation: 10, output: 20 }, usageScope: 'turn', time: at + 2 },
    { type: 'usage.record', agentId: 'child', usage: { inputOther: 999 }, time: at + 3 },
    { type: 'prompt.completed', reason: 'completed', time: at + 4 }
  ]
  events.forEach((event) => consumeWire(summary, event))
  const windows = parseModelWindows('[models."kimi-code/k3"]\nmodel="k3"\nmax_context_size = 1_048_576\n[providers.test]\napi_key="not-exported"')
  const session = codeSession({ title: 'Example', custom: { vscode_legacy_approval: { yolo: false } } }, { sessionId: 'session_abc', sessionDir: '/sessions/abc' }, summary, windows)
  assert.equal(session.status, 'turn_completed')
  assert.equal(session.questionCount, 1)
  assert.equal(session.tokensUsed, 180)
  assert.equal(session.contextUsedTokens, 160)
  assert.equal(session.contextWindowTokens, 1048576)
  assert.equal(session.source, 'kimi-vscode')
  assert.equal(session.reasoningEffort, 'max')
  consumeWire(summary, { type: 'prompt.accepted', promptId: 'p2', time: at + 5 })
  assert.equal(summary.status, 'running')
  assert.equal(sourceLabel({ custom: { imported_from_kimi_cli: true } }), 'kimi-cli')
  assert.equal(sourceLabel({}), 'kimi-unknown')
  assert.equal(codeSession({}, { sessionId: 'unknown', sessionDir: '/unknown' }, summary).contextWindowTokens, null)
})

test('旧版 Kimi CLI 以 TurnEnd 完成并按消息 ID 去重 token', () => {
  const summary = createWireSummary()
  consumeWire(summary, { timestamp: at / 1000, message: { type: 'TurnBegin', payload: { user_input: 'Hello' } } })
  const update = { timestamp: at / 1000 + 1, message: { type: 'StatusUpdate', payload: { message_id: 'm1', token_usage: { input_other: 1, input_cache_read: 10, output: 3 } } } }
  consumeWire(summary, update); consumeWire(summary, update)
  consumeWire(summary, { timestamp: at / 1000 + 2, message: { type: 'TurnEnd', payload: {} } })
  assert.equal(summary.status, 'turn_completed')
  assert.equal(summary.tokensUsed, 14)
  assert.equal(summary.legacyPromptCount, 1)
})

test('旧版 VS Code 的 end_turn 最终回复结束事件不会误报为运行中', () => {
  const summary = createWireSummary()
  consumeWire(summary, { type: 'turn.prompt', time: at })
  consumeWire(summary, { type: 'context.append_loop_event', event: { type: 'step.end', finishReason: 'end_turn' }, time: at + 1 })
  assert.equal(summary.status, 'turn_completed')
  consumeWire(summary, { type: 'turn.prompt', time: at + 2 })
  assert.equal(summary.status, 'running')
  consumeWire(summary, { type: 'turn.cancel', time: at + 3 })
  assert.equal(summary.status, 'turn_completed')
  assert.match(summary.statusReason, /取消/)
})

test('DSH 包含所有模型的主会话，区分用户输入和注入消息', () => {
  const header = { id: 'dsh-test', cwd: '/work', createdAt: at }
  const events = [
    { type: 'request/context', data: { provider: 'kimi-coding', model: 'k3-256k', contextWindow: 262144 }, time: at },
    { type: 'user/message', data: { id: 'policy', source: { kind: 'user-approval' }, content: 'injected' } },
    { type: 'user/message', data: { id: 'p1', source: { kind: 'user' }, content: 'Explain this' } },
    { type: 'turn/start', data: { turn: 1 }, time: at + 1 },
    { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }, time: at + 2 },
    { type: 'turn/end', data: { reason: { kind: 'completed' } }, time: at + 3 }
  ]
  const session = parseDshSession(header, events)
  assert.equal(session.source, 'dsh')
  assert.equal(session.questionCount, 1)
  assert.equal(session.title, 'Explain this')
  assert.equal(session.tokensUsed, 120)
  assert.equal(session.contextWindowTokens, 262144)
  assert.equal(session.status, 'turn_completed')
  assert.equal(parseDshSession({ ...header, parentSession: 'parent' }, events), null)
  assert.equal(parseDshSession(header, [...events, { type: 'model/selection', data: { provider: 'deepseek', model: 'deepseek-chat' } }]).model, 'deepseek-chat')
})

test('DSH 缓存会随实时 seq 和持久化 revision 变化刷新', async () => {
  let revision = 1
  let reads = 0
  const header = { id: 'cache', createdAt: at }
  const persistence = { stat: async () => ({ revision }) }
  const ctx = {
    get: () => persistence,
    sessions: { get: () => ({ seq: revision }) },
    sessionQuery: {
      listSessions: async () => [{ header }],
      readSession: async () => { reads++; return { session: header, events: [{ type: 'request/context', data: { provider: 'kimi', model: 'k3' } }, { type: revision === 1 ? 'turn/start' : 'turn/end', data: {}, time: at + revision }] } }
    }
  }
  const source = createDshSource(ctx)
  assert.equal((await source.queryAll())[0].status, 'running')
  await source.queryAll(); assert.equal(reads, 1)
  revision = 2
  assert.equal((await source.queryAll())[0].status, 'turn_completed')
  assert.equal(reads, 2)
})

test('读取本地索引：遵守删除标记、排除归档和子会话、CLI 迁移去重、忽略未写完的尾行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kimi-source-'))
  try {
    const codeHome = join(root, 'code'); const legacyHome = join(root, 'legacy')
    const rows = []
    for (const [id, extra] of [['session_old', { custom: { imported_from_kimi_cli: true, kimi_cli_session_id: 'old' } }], ['session_live', { custom: { vscode_legacy_approval: {} } }], ['session_archived', { archived: true }], ['session_deleted', {}], ['session_child', { custom: { parent_session_id: 'parent' } }]]) {
      const dir = join(codeHome, 'sessions', 'workspace', id)
      await mkdir(join(dir, 'agents', 'main'), { recursive: true })
      await writeFile(join(dir, 'state.json'), JSON.stringify({ id, title: id, createdAt: at, ...extra }))
      await writeFile(join(dir, 'agents/main/wire.jsonl'), JSON.stringify({ type: 'prompt.completed', time: at, reason: 'completed' }) + '\n{"type":')
      rows.push({ sessionId: id, sessionDir: dir })
    }
    rows.push({ sessionId: 'session_deleted', deleted: true })
    await writeFile(join(codeHome, 'session_index.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'))
    await mkdir(join(legacyHome, 'sessions/bucket/old'), { recursive: true })
    await writeFile(join(legacyHome, 'sessions/bucket/old/context.jsonl'), JSON.stringify({ role: 'user', content: 'duplicate' }))
    const source = createCodeSource({ codeHome, legacyHome })
    const sessions = await source.queryAll()
    assert.equal(sessions.length, 2)
    assert.deepEqual(new Set(sessions.map((session) => session.source)), new Set(['kimi-cli', 'kimi-vscode']))
    assert.equal(sessions.every((session) => session.status === 'turn_completed'), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

