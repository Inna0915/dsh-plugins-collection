import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionSource } from './multi-session-source.js'
import { createClaudeSummary, consumeClaude, claudeSession, createClaudeSource } from './claude-source.js'
import { claudeMessage } from './provider-conversation.js'
import { validSessionId, sessionProvider } from './session-common.js'
import { parseDshSession, createDshSource } from './dsh-source.js'
import { createMonitor } from './monitor.js'
import { createRecordStore } from './record-store.js'
import { createCompletionNotifications, completionToast } from './notifications.js'

const uuid = '019d0000-0000-7000-8000-000000000031'
const at = '2026-10-25T01:00:00.000Z'
const later = '2026-10-25T01:01:00.000Z'
const end = '2026-10-25T01:02:00.000Z'
function row(id, extra = {}) { return { sessionId: id, title: 'same title', source: 'cli', status: 'turn_completed', observedAt: later, updatedAt: later, lifecycleEvent: 'turn_completed', ...extra } }
function source(rows) { return { queryAll: async () => rows, querySession: async (id) => rows.find((r) => r.sessionId === id) || null, readConversation: async (id, cursor) => ({ sessionId: id, cursor, messages: [] }) } }
function aggregate(options = {}) { return createSessionSource({ codexSource: source([]), kimiSource: source([]), claudeSource: source([]), ...options }) }

test('四个来源共享原始 ID 时互不覆盖，保留旧 Codex UUID，预览和查询定向路由', async () => {
  const ids = [uuid, `dsh:${uuid}`, `kimi:${uuid}`, `claude:${uuid}`]
  const all = aggregate({ codexSource: source([row(ids[0])]), dshSource: source([row(ids[1])]), kimiSource: source([row(ids[2])]), claudeSource: source([row(ids[3])]) })
  const result = await all.queryDefault()
  assert.equal(result.sessions.length, 4)
  assert.deepEqual(new Set(result.sessions.map((r) => r.provider)), new Set(['codex', 'dsh', 'kimi', 'claude']))
  for (const id of ids) { assert.equal((await all.querySession(id)).sessionId, id); assert.equal((await all.readConversation(id, 'cursor')).cursor, 'cursor') }
  assert.equal(sessionProvider('kimi-cli:legacy'), 'kimi')
  for (const id of ['../../private', 'kimi:../../private', 'dsh:C:\\secret', 'other:one', 'claude:x/y', 'dsh:']) {
    assert.equal(validSessionId(id), false)
    await assert.rejects(all.querySession(id), /格式无效/)
  }
})

test('来源失败保留可确认的占位，其余来源正常；恢复后清除降级；定向失败不伪装删除', async () => {
  let broken = false
  const kimi = { ...source([row('kimi:one')]), async queryAll() { if (broken) throw new Error('locked'); return [row('kimi:one')] }, async querySession() { throw new Error('locked') } }
  const all = aggregate({ kimiSource: kimi, dshSource: source([row('dsh:one')]) })
  await all.queryDefault(); broken = true
  const current = await all.queryDefault()
  assert.equal(current.sessions.find((r) => r.sessionId === 'kimi:one').status, 'unknown')
  assert.equal(current.sessions.find((r) => r.sessionId === 'kimi:one').lifecycleEvent, null)
  assert.equal(all.health().kimi.status, 'degraded')
  assert.equal(current.sessions.find((r) => r.sessionId === 'dsh:one').status, 'turn_completed')
  await assert.rejects(all.querySession('kimi:one'), /locked/)
  broken = false; await all.queryDefault(); assert.equal(all.health().kimi.status, 'ok')
})

test('每个来源独立保留最近记录，额外运行会话不被大量其他来源挤掉', async () => {
  const kimi = Array.from({ length: 40 }, (_, i) => row(`kimi:s${i}`, { updatedAt: new Date(Date.parse(at) + i * 1000).toISOString(), status: i === 0 ? 'running' : 'turn_completed' }))
  const all = aggregate({ kimiSource: source(kimi), dshSource: source([row('dsh:one')]), perProviderLimit: 3 })
  const result = await all.queryDefault()
  assert.equal(result.sessions.length, 5)
  assert.ok(result.sessions.some((r) => r.sessionId === 'kimi:s0'))
  assert.ok(result.sessions.some((r) => r.sessionId === 'dsh:one'))
})

test('DSH 未接入时不阻塞其他来源，服务卸载也不会把旧运行状态继续当成运行中', async () => {
  const all = aggregate({ codexSource: source([row(uuid)]) })
  assert.equal((await all.queryDefault()).sessions.length, 1)
  await assert.rejects(all.querySession('dsh:one'), /暂不可用/)
  all.setDshContext({ sessions: { get: () => ({ seq: 1 }) }, sessionQuery: {
    listSessions: async () => [{ header: { id: 'one' } }], readSession: async () => ({ session: { id: 'one' }, events: [{ type: 'turn/start', time: at }] })
  } })
  assert.equal((await all.queryDefault()).sessions.find((r) => r.sessionId === 'dsh:one').status, 'running')
  all.setDshContext(null)
  assert.equal((await all.queryDefault()).sessions.find((r) => r.sessionId === 'dsh:one').status, 'unknown')
})

test('DSH 中断不生成完成通知，持久化的未结束历史不伪装活跃', async () => {
  const header = { id: 'test' }
  const events = [{ type: 'turn/start', time: at }, { type: 'turn/end', time: later, data: { reason: { kind: 'aborted' } } }]
  assert.equal(parseDshSession(header, events).lifecycleEvent, 'turn_aborted')
  const dsh = createDshSource({ sessions: { get: () => null }, sessionQuery: { listSessions: async () => [{ header }], readSession: async () => ({ session: header, events: events.slice(0, 1) }) } })
  assert.equal((await dsh.queryAll())[0].status, 'unknown')
  assert.equal(parseDshSession({ ...header, parentSession: 'parent' }, events), null)
})

test('Claude 只统计主会话用户输入，按 API 消息去重 usage，工具调用不等于轮次结束', () => {
  const summary = createClaudeSummary(uuid)
  const assistant = { type: 'assistant', sessionId: uuid, timestamp: later, message: { id: 'm1', model: 'claude-model', stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Shell', input: { command: 'pwd' } }] } }
  consumeClaude(summary, { type: 'user', uuid: 'u1', timestamp: at, message: { content: 'question' } })
  consumeClaude(summary, assistant); consumeClaude(summary, assistant)
  consumeClaude(summary, { type: 'user', uuid: 'tool', timestamp: later, message: { content: [{ type: 'tool_result', content: 'output' }] } })
  consumeClaude(summary, { ...assistant, isSidechain: true, message: { ...assistant.message, id: 'child', usage: { input_tokens: 9999 } } })
  assert.equal(claudeSession(summary).status, 'unknown')
  assert.equal(claudeSession(summary, { status: 'working', statusUpdatedAt: later }).status, 'running')
  const finished = { ...assistant, timestamp: end, message: { ...assistant.message, id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }] } }
  consumeClaude(summary, finished)
  const result = claudeSession(summary, { status: 'idle', statusUpdatedAt: end, entrypoint: 'claude-vscode' })
  assert.equal(result.status, 'turn_completed'); assert.equal(result.tokensUsed, 70)
  assert.equal(result.questionCount, 1); assert.equal(result.source, 'claude-vscode')
  assert.equal(result.contextWindowTokens, null)
  consumeClaude(summary, { type: 'user', timestamp: end, uuid: 'aborted', message: { content: '[Request interrupted by user]' } })
  assert.equal(summary.lifecycleEvent, 'turn_aborted'); assert.equal(summary.prompts.size, 1)
})

test('Claude 预览排除内部请求和子智能体，思考与工具仍折叠', () => {
  assert.equal(claudeMessage({ type: 'api-request-blob', message: { content: 'secret policy' } }), null)
  assert.equal(claudeMessage({ type: 'assistant', isSidechain: true, message: { content: 'child' } }), null)
  const result = claudeMessage({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'notes' }, { type: 'text', text: 'answer' }, { type: 'tool_use', name: 'Shell', input: { command: 'pwd' } }] } })
  assert.equal(result.text, 'answer'); assert.deepEqual(result.details.map((d) => d.kind), ['thought', 'tool'])
})

test('Claude 文件读取支持续写刷新和分页，不扫描 subagents，不访问凭据或配置', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-source-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const project = join(home, 'projects', 'work')
  await mkdir(join(project, 'subagents'), { recursive: true })
  await mkdir(join(home, 'sessions'), { recursive: true })
  const file = join(project, `${uuid}.jsonl`)
  const config = join(home, 'settings.json'); await writeFile(config, 'DO NOT READ OR MODIFY')
  const events = Array.from({ length: 35 }, (_, i) => ({ type: 'user', uuid: `u${i}`, sessionId: uuid, timestamp: at, message: { content: `prompt ${i}` } }))
  const serialize = () => events.map(JSON.stringify).join('\n') + '\n'
  await writeFile(file, serialize()); await writeFile(join(project, 'subagents', `${uuid}.jsonl`), 'invalid')
  await writeFile(join(home, 'sessions', '99.json'), JSON.stringify({ pid: 99, sessionId: uuid, status: 'working', statusUpdatedAt: later }))
  const source = createClaudeSource({ claudeHome: home, isAlive: () => false })
  assert.equal((await source.queryAll()).length, 1)
  assert.equal((await source.querySession(`claude:${uuid}`)).status, 'unknown')
  const first = await source.readConversation(`claude:${uuid}`)
  assert.equal(first.messages.length, 30)
  const second = await source.readConversation(`claude:${uuid}`, first.nextCursor)
  assert.equal(second.messages.length, 5)
  events.push({ type: 'assistant', timestamp: end, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })
  await writeFile(file, serialize())
  assert.equal((await source.querySession(`claude:${uuid}`)).status, 'turn_completed')
  assert.equal(await readFile(config, 'utf8'), 'DO NOT READ OR MODIFY')
})

test('多来源运行和待审核可共存，审核只移除指定来源的记录', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'multi-records-'))
  const records = createRecordStore({ file: join(directory, 'records.json') })
  const rows = [row(uuid, { status: 'running', lifecycleEvent: 'turn_started' }), row(`kimi:${uuid}`, { status: 'running', lifecycleEvent: 'turn_started' }), row(`dsh:${uuid}`, { status: 'running', lifecycleEvent: 'turn_started' })]
  const monitor = createMonitor({ queryDefault: async () => ({ sessions: rows }), querySession: async (id) => rows.find((r) => r.sessionId === id) }, { recordStore: records })
  t.after(async () => { monitor.close(); await monitor.waitForIdle(); await rm(directory, { recursive: true, force: true }) })
  monitor.requestDefault(); await monitor.waitForIdle()
  rows[1] = row(`kimi:${uuid}`, { observedAt: end }); rows[2] = row(`dsh:${uuid}`, { observedAt: end })
  monitor.requestDefault(); await monitor.waitForIdle()
  await monitor.reviewCompleted(`kimi:${uuid}`)
  const saved = await records.list()
  assert.equal(saved.has(uuid), true); assert.equal(saved.has(`kimi:${uuid}`), false); assert.equal(saved.has(`dsh:${uuid}`), true)
  const result = await monitor.reviewAllCompleted([uuid, `dsh:${uuid}`])
  assert.deepEqual(result.skippedIds, [uuid]); assert.deepEqual(result.reviewedIds, [`dsh:${uuid}`])
})

test('四来源完成通知正确标注来源并独立持久化，历史和中断不通知', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'multi-notifications-'))
  const sent = []
  const notifications = createCompletionNotifications({ supported: true, startedAt: at, file: join(directory, 'history.json'), send: async (payload) => sent.push(payload) })
  t.after(async () => { await notifications.close(); await rm(directory, { recursive: true, force: true }) })
  for (const id of [uuid, `dsh:${uuid}`, `kimi:${uuid}`, `claude:${uuid}`]) { notifications.observe(row(id)); notifications.observe(row(id)) }
  notifications.observe(row('kimi:cancelled', { lifecycleEvent: 'turn_aborted' }))
  notifications.observe(row('dsh:history', { observedAt: at }))
  await notifications.waitForIdle()
  assert.equal(notifications.snapshot().lastError, null)
  assert.deepEqual(new Set(sent.map((payload) => payload.title)), new Set(['Codex 轮次已完成', 'DSH 轮次已完成', 'Kimi 轮次已完成', 'Claude 轮次已完成']))
  assert.equal(new Set(sent.map((payload) => payload.tag)).size, 4)
  assert.equal(JSON.parse(await readFile(join(directory, 'history.json'), 'utf8')).sessions.length, 4)
  assert.match(completionToast(row(`claude:${uuid}`, { source: 'claude-vscode' })).body, /Claude · VS Code/)
})

test('单条审核重新核对来源，已重新运行的会话不会被审核掉', async (t) => {
  const records = new Map([['claude:test', at]])
  let latest = row('claude:test')
  const monitor = createMonitor({ queryDefault: async () => ({ sessions: [latest] }), querySession: async () => latest }, { recordStore: {
    list: async () => new Map(records), remove: async (id) => records.delete(id)
  } })
  t.after(() => monitor.close())
  monitor.requestDefault(); await monitor.waitForIdle()
  latest = row('claude:test', { status: 'running', observedAt: end })
  await assert.rejects(monitor.reviewCompleted('claude:test'), /新轮次/)
  assert.equal(records.has('claude:test'), true)
})

test('卸载会等待读取及运行记录写入完成，不留下后台刷新', async () => {
  let finishRead; let began
  const reading = new Promise((resolve) => { began = resolve })
  const source = { queryDefault: () => { began(); return new Promise((resolve) => { finishRead = resolve }) } }
  const monitor = createMonitor(source)
  monitor.requestDefault(); await reading
  let closed = false
  const closing = monitor.close().then(() => { closed = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, false)
  finishRead({ sessions: [] }); await closing
  assert.equal(closed, true)
  assert.equal(monitor.snapshot().refreshing, false)
})

test('Claude 续写只读取新增记录，结果与整份重读一致；改写或截断时整份重读', async (t) => {
  const { appendFile, open: openFile } = await import('node:fs/promises')
  const home = await mkdtemp(join(tmpdir(), 'claude-incremental-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const project = join(home, 'projects', 'work')
  await mkdir(project, { recursive: true })
  const file = join(project, `${uuid}.jsonl`)
  const line = (value) => JSON.stringify(value) + '\n'
  const prompt = (i, time = at) => ({ type: 'user', uuid: `u${i}`, sessionId: uuid, timestamp: time, message: { content: `第 ${i} 个问题：中文多字节 ✓` } })
  const answer = (id, time, stop = 'end_turn') => ({ type: 'assistant', sessionId: uuid, timestamp: time,
    message: { id, model: 'claude-test', stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: '好的' }] } })
  const live = createClaudeSource({ claudeHome: home, isAlive: () => false })
  const fresh = async () => createClaudeSource({ claudeHome: home, isAlive: () => false }).querySession(`claude:${uuid}`)
  const current = () => live.querySession(`claude:${uuid}`)

  await writeFile(file, line(prompt(1)) + line(answer('m1', later)))
  assert.equal((await current()).questionCount, 1)

  // 已读取部分被同长度空白覆盖：增量读取不再解析前缀，整份重读会少一个问题。
  const original = await readFile(file)
  const firstLength = original.indexOf(10)
  const handle = await openFile(file, 'r+')
  try { await handle.write(Buffer.alloc(firstLength, 0x20), 0, firstLength, 0) } finally { await handle.close() }
  await appendFile(file, line(prompt(2, end)))
  assert.equal((await current()).questionCount, 2, '前缀不应被重新解析')
  assert.equal((await fresh()).questionCount, 1)
  await writeFile(file, original); await appendFile(file, line(prompt(2, end)))

  // 未换行的最后一条：完整 JSON 计入结果，补上换行后不重复计入；残缺 JSON 忽略，补全后计入一次。
  await appendFile(file, JSON.stringify(answer('m2', end)))
  assert.deepEqual(await current(), await fresh())
  assert.equal((await current()).status, 'turn_completed')
  await appendFile(file, '\n' + JSON.stringify(prompt(3, end)).slice(0, 20))
  assert.deepEqual(await current(), await fresh())
  assert.equal((await current()).questionCount, 2)
  await appendFile(file, JSON.stringify(prompt(3, end)).slice(20) + '\r\n')
  assert.deepEqual(await current(), await fresh())
  assert.equal((await current()).questionCount, 3)
  assert.equal((await current()).tokensUsed, 30)

  // 文件被改写（前缀变化）或截断：回到整份重读。
  await writeFile(file, line(prompt(9)) + line(prompt(8)) + line(prompt(7)) + line(prompt(6)) + line(answer('m9', end)))
  assert.deepEqual(await current(), await fresh())
  assert.equal((await current()).questionCount, 4)
  await writeFile(file, line(prompt(5)))
  assert.deepEqual(await current(), await fresh())
  assert.equal((await current()).questionCount, 1)
})
