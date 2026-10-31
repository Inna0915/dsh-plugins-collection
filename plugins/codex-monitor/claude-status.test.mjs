import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createClaudeSummary, consumeClaude, claudeSession, createClaudeSource } from './claude-source.js'
import { parseDshSession } from './dsh-source.js'
import { createSessionSource } from './multi-session-source.js'
import { createMonitor } from './monitor.js'

const id = '019d0000-0000-7000-8000-000000000051'
const start = '2026-10-25T01:00:00.000Z'
const toolAt = '2026-10-25T01:03:00.000Z'
const finish = '2026-10-25T01:04:00.000Z'
const prompt = { type: 'user', timestamp: start, uuid: 'prompt', message: { content: 'work' } }
const tool = { type: 'assistant', timestamp: toolAt, message: { id: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] } }
const answer = { type: 'assistant', timestamp: finish, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }
function workingSummary() {
  const summary = createClaudeSummary(id)
  consumeClaude(summary, prompt); consumeClaude(summary, tool)
  return summary
}
const emptySource = { queryAll: async () => [] }

test('Claude 当前忙碌或等待授权时，后续工具日志不能覆盖客户端状态或改变本轮标识', () => {
  const summary = workingSummary()
  for (const status of ['busy', 'working', 'running', 'waiting_for_permission']) {
    const live = { status, statusUpdatedAt: start, updatedAt: toolAt }
    const session = claudeSession(summary, live)
    assert.equal(session.status, 'running', status)
    assert.equal(session.observedAt, start)
    assert.equal(session.updatedAt, toolAt)
    assert.equal(session.lifecycleEvent, 'turn_started')
  }
})

test('Claude 当前忙碌时不提前通知完成，客户端空闲后才采纳最终回复，空闲本身不伪造完成', () => {
  const summary = workingSummary()
  assert.equal(claudeSession(summary, { status: 'idle', statusUpdatedAt: finish }).status, 'unknown')
  consumeClaude(summary, answer)
  assert.equal(claudeSession(summary, { status: 'busy', statusUpdatedAt: start }).status, 'running')
  const completed = claudeSession(summary, { status: 'idle', statusUpdatedAt: finish })
  assert.equal(completed.status, 'turn_completed')
  assert.equal(completed.lifecycleEvent, 'turn_completed')
  assert.equal(completed.observedAt, finish)
  assert.equal(claudeSession(summary).status, 'turn_completed')
})

test('Claude 从活动描述文件到看板保持运行状态，进程退出后的旧描述文件不再作为运行事实', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-status-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const project = join(home, 'projects', 'work')
  await mkdir(project, { recursive: true }); await mkdir(join(home, 'sessions'))
  const log = join(project, `${id}.jsonl`)
  await writeFile(log, [prompt, tool].map(JSON.stringify).join('\n') + '\n')
  const descriptor = join(home, 'sessions', '99.json')
  await writeFile(descriptor, JSON.stringify({ pid: 99, sessionId: id, status: 'busy', statusUpdatedAt: start }))
  let alive = true
  const claude = createClaudeSource({ claudeHome: home, isAlive: () => alive })
  const source = createSessionSource({ codexSource: emptySource, kimiSource: emptySource, dshSource: emptySource, claudeSource: claude })
  const monitor = createMonitor(source)
  t.after(() => monitor.close())
  monitor.requestDefault(); await monitor.waitForIdle()
  assert.equal(monitor.snapshot().sessions[0].status, 'running')
  assert.equal(monitor.snapshot().health.rollout, 'ok')
  assert.equal((await claude.querySession(`claude:${id}`)).status, 'running')
  alive = false
  monitor.requestDefault(); await monitor.waitForIdle()
  const uncertain = monitor.snapshot().sessions[0]
  assert.equal(uncertain.status, 'unknown')
  assert.equal(uncertain.statusUncertain, true)
  assert.equal(uncertain.reviewable, true)
  assert.equal(monitor.snapshot().health.rollout, 'ok')
  alive = true
  await writeFile(log, [prompt, tool, answer].map(JSON.stringify).join('\n') + '\n')
  await writeFile(descriptor, JSON.stringify({ pid: 99, sessionId: id, status: 'idle', statusUpdatedAt: finish }))
  monitor.requestDefault(); await monitor.waitForIdle()
  assert.equal(monitor.snapshot().sessions[0].status, 'turn_completed')
})

test('有效的 Claude 和 DSH 历史缺少状态事实时标为待确认，不报数据源故障；真正读取失败仍降级', async (t) => {
  const claude = claudeSession(workingSummary())
  const dsh = parseDshSession({ id: 'empty', createdAt: start }, [])
  let failure = false
  const source = createSessionSource({ codexSource: emptySource, kimiSource: emptySource,
    dshSource: { queryAll: async () => [dsh] },
    claudeSource: { queryAll: async () => { if (failure) throw new Error('read failed'); return [claude] } } })
  const monitor = createMonitor(source)
  t.after(() => monitor.close())
  monitor.requestDefault(); await monitor.waitForIdle()
  assert.ok(monitor.snapshot().sessions.every((row) => row.status === 'unknown' && row.statusUncertain === true))
  assert.equal(monitor.snapshot().health.rollout, 'ok')
  failure = true
  monitor.requestDefault(); await monitor.waitForIdle()
  const failed = monitor.snapshot().sessions.find((row) => row.provider === 'claude')
  assert.equal(failed.statusUncertain, false)
  assert.equal(failed.statusSource, 'source-unavailable')
  assert.equal(monitor.snapshot().health.index, 'degraded')
  assert.equal(monitor.snapshot().health.rollout, 'degraded')
  failure = false
  monitor.requestDefault(); await monitor.waitForIdle()
  assert.equal(monitor.snapshot().health.index, 'ok')
  assert.equal(monitor.snapshot().health.rollout, 'ok')
})

test('Claude 忽略正在写入的尾行，但完整记录损坏仍报告读取失败', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-parse-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const project = join(home, 'projects', 'work')
  await mkdir(project, { recursive: true })
  const file = join(project, `${id}.jsonl`)
  const source = createClaudeSource({ claudeHome: home })
  await writeFile(file, JSON.stringify(prompt) + '\n{"type":')
  assert.equal((await source.queryAll())[0].statusUncertain, true)
  assert.equal(source.health().status, 'ok')
  for (const broken of ['{"type":\n', '{bad}\n' + JSON.stringify(tool), 'null\n']) {
    await writeFile(file, JSON.stringify(prompt) + '\n' + broken)
    assert.equal((await source.queryAll()).length, 0)
    assert.equal(source.health().status, 'degraded')
    await assert.rejects(source.querySession(`claude:${id}`), /日志/)
  }
  await writeFile(file, [prompt, answer].map(JSON.stringify).join('\n'))
  assert.equal((await source.queryAll())[0].status, 'turn_completed')
  assert.equal(source.health().status, 'ok')
})

let definition
runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), { URL, window: { __ModuleLoader__: { load(value) { definition = value } } } })
const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }) }
const client = definition.factory((name) => name === 'react' ? React : {})
function flatten(node) { return !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(flatten)] }

test('看板分别显示待确认与异常，缺少上下文上限时仍显示已有输入用量', () => {
  const session = { sessionId: `claude:${id}`, title: 'work', status: 'unknown', statusUncertain: true,
    statusReason: '尚无最终回复结束记录', contextUsedTokens: 197007, contextWindowTokens: null }
  const nodes = flatten(client.SessionCard({ session }))
  const title = nodes.find((node) => node.props.className === 'cdm-cardTitle')
  assert.deepEqual(title.children, ['待确认 · work'])
  assert.equal(title.props.title, session.statusReason)
  const context = nodes.find((node) => node.props.className === 'cdm-reasonText')
  assert.match(context.children[0], /^Context 197K \/ 窗口未知$/)
  assert.match(context.props.title, /197,007/)
  assert.doesNotMatch(context.children[0], /%/)
  const failed = flatten(client.SessionCard({ session: { ...session, statusUncertain: false } }))
  assert.ok(failed.some((node) => node.children.includes('异常 · work')))
})
