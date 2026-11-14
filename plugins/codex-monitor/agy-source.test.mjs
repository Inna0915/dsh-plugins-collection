import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgySource, agyTime, workspacePath, chunkEvents, STEP } from './agy-source.js'
import { createSessionSource } from './multi-session-source.js'
import { createMonitor } from './monitor.js'
import { createCompletionNotifications, completionToast } from './notifications.js'
import { validSessionId, sessionProvider } from './session-common.js'

const MAIN = '75fdb0cd-bd55-4c29-9dd7-5dc6848d5290'
const IDLE = '06427b50-d199-4585-a230-c9ba01216cbc'
const CANCELLED = 'ceb6667b-ed88-4f21-a1fa-854dfe8b0c42'
const CHILD = 'aa6717c7-361e-468a-8f2d-2a7db971b49a'
const ARCHIVED = '723c149d-5111-4a07-a90b-844905dc33bc'
const CLI = '8022c4d9-5572-4339-8eb5-1808089465c9'

// Mirrors the agy 1.5.x layout: summary index, FTS content shadow table, per-conversation trajectories, hub registrations.
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agy-source-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'conversations')); await mkdir(join(home, 'daemon'))
  const summary = new DatabaseSync(join(home, 'conversation_summaries.db'))
  summary.exec(`create table conversation_summaries (conversation_id text primary key, title text not null default '', preview text not null default '',
    step_count integer not null default 0, last_modified_time datetime not null, workspace_uris text not null, status text not null default '',
    source text not null default '', project_id text not null default '', agent_name text not null default '', parent_conversation_id text,
    nesting_depth integer, battle_id text, winning_conversation_id text, not_fully_idle numeric, killed numeric,
    last_user_input_time datetime, last_user_input_step_index integer, app_data_dir text, raw_summary blob, group_id text);
    create table conversations_fts_content (id integer primary key, c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14);`)
  const insert = summary.prepare(`insert into conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
    status, source, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_user_input_time)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const workspace = '["file:///d%3A/dev/code/demo-project"]'
  insert.run(MAIN, 'Sample Code Review', '', 5, '2026-11-14 05:53:25.4819020+00:00', workspace, 'CASCADE_RUN_STATUS_RUNNING', '', '', '', 0, 1, 0, '2026-11-14 05:33:24.7902663+00:00')
  insert.run(IDLE, 'Sample Progress Summary', '', 5, '2026-11-14 03:36:28.4341984+00:00', workspace, 'CASCADE_RUN_STATUS_IDLE', '', '', '', 0, 0, 0, '2026-11-14 03:33:08.866125+00:00')
  insert.run(CANCELLED, 'Sample Migration Check', '', 3, '2026-11-13 10:12:19.4642355+00:00', workspace, 'CASCADE_RUN_STATUS_IDLE', '', '', '', 0, 0, 0, '2026-11-13 10:04:03.5996986+00:00')
  insert.run(CHILD, 'reviewer', '', 2, '2026-11-14 05:50:00+00:00', workspace, 'CASCADE_RUN_STATUS_RUNNING', '', 'code_reviewer', MAIN, 1, 1, 0, '2026-11-14 05:40:00+00:00')
  insert.run(ARCHIVED, 'Archived', '', 2, '2026-11-13 03:02:09+00:00', workspace, 'CASCADE_RUN_STATUS_IDLE', '', '', '', 0, 0, 0, '2026-11-13 03:01:14+00:00')
  insert.run(CLI, '', '示例文档复核', 2, '2026-08-20 02:05:27+00:00', '[]', 'CASCADE_RUN_STATUS_IDLE', 'CORTEX_TRAJECTORY_SOURCE_CLI', '', '', 0, 0, 0, '2026-08-20 02:00:00+00:00')
  const fts = summary.prepare('insert into conversations_fts_content (c0, c1, c2, c3, c5, c7, c8, c9, c13, c14) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const user = '汇总示例项目进度\n只读取文档目录\n'
  const agent = '先看看目录\n\n已生成进度摘要。\n'
  const offsets = (body, steps) => {
    const parts = body.split('\n').slice(0, steps.length); let at = 0
    return JSON.stringify(steps.map((step, index) => { const pair = [step, at]; at += Buffer.byteLength(parts[index]) + 1; return pair }))
  }
  fts.run(IDLE, -1, 0, 0, 5, 0, '', '', '', '')
  fts.run(IDLE, 0, 0, 4, 0, 0, Buffer.from(offsets(user, [0, 3])), Buffer.from(offsets(agent, [1, 2, 4])), user, agent)
  fts.run(ARCHIVED, -1, 0, 0, 2, 1, '', '', '', '')
  summary.close()
  const trajectory = (id, steps) => {
    const db = new DatabaseSync(join(home, 'conversations', `${id}.db`))
    db.exec('create table steps (idx integer primary key, step_type integer not null default 0, status integer not null default 0, error_details blob)')
    const add = db.prepare('insert into steps (idx, step_type, status) values (?, ?, ?)')
    steps.forEach(([type, status], index) => add.run(index, type, status))
    db.close()
  }
  trajectory(MAIN, [[STEP.userInput, 3], [STEP.response, 3], [132, 3], [132, 3], [132, STEP.running]])
  trajectory(IDLE, [[STEP.userInput, 3], [STEP.response, 3], [132, 3], [STEP.userInput, 3], [STEP.response, 3]])
  trajectory(CANCELLED, [[STEP.userInput, 3], [STEP.response, 3], [132, STEP.cancelled]])
  await writeFile(join(home, 'daemon', 'hub_64389.json'), JSON.stringify({ pid: 4242, httpPort: 64389, csrfToken: 'never-read-by-tests' }))
  return home
}

function rename(home, id, title, modified) {
  const db = new DatabaseSync(join(home, 'conversation_summaries.db'))
  db.prepare('update conversation_summaries set title = ?, last_modified_time = ? where conversation_id = ?').run(title, modified, id)
  db.close()
}

test('agy 时间、工作区和分步文本解析', () => {
  assert.equal(agyTime('2026-11-14 03:36:28.4341984+00:00'), '2026-11-14T03:36:28.434Z')
  assert.equal(agyTime(''), null)
  assert.match(workspacePath('["file:///d%3A/dev/code/demo-project"]'), /^d:[\\/]dev[\\/]code[\\/]demo-project$/i)
  assert.equal(workspacePath('not json'), '')
  const body = '汇总示例项目进度\n只看文档\n'
  assert.deepEqual(chunkEvents('[[0,0],[11,25]]', body, 'user').map((event) => [event.seq, event.text]), [[0, '汇总示例项目进度'], [11, '只看文档']])
  assert.deepEqual(chunkEvents('[[1,0],[4,1]]', '\nfinal', 'assistant').map((event) => event.seq), [4])
  assert.deepEqual(chunkEvents('broken', body, 'user'), [])
})

test('agy 主会话：存活 hub 时运行中，进程不在时待确认；完成、中断按最后一步判断；排除子代理和归档', async (t) => {
  const home = await fixture(t)
  let alive = true
  const source = createAgySource({ agyHome: home, isAlive: (pid) => alive && pid === 4242 })
  const rows = new Map((await source.queryAll()).map((row) => [row.nativeSessionId, row]))
  assert.deepEqual(new Set(rows.keys()), new Set([MAIN, IDLE, CANCELLED, CLI]))
  const running = rows.get(MAIN)
  assert.equal(running.sessionId, `agy:${MAIN}`)
  assert.equal(running.status, 'running')
  assert.equal(running.lifecycleEvent, 'turn_started')
  assert.equal(running.turnStartedAt, '2026-11-14T05:33:24.790Z')
  assert.equal(running.source, 'agy-hub')
  assert.match(running.cwd, /demo-project$/)
  assert.equal(running.questionCount, 1)
  const done = rows.get(IDLE)
  assert.equal(done.status, 'turn_completed')
  assert.equal(done.lifecycleEvent, 'turn_completed')
  assert.equal(done.observedAt, '2026-11-14T03:36:28.434Z')
  assert.equal(done.questionCount, 2)
  assert.equal(rows.get(CANCELLED).lifecycleEvent, 'turn_aborted')
  const cli = rows.get(CLI)
  assert.equal(cli.source, 'agy-cli')
  assert.equal(cli.title, '示例文档复核')
  assert.equal(cli.statusSource, 'agy-summary')
  assert.equal(cli.lifecycleEvent, 'turn_completed')
  assert.equal(source.health().status, 'ok')
  alive = false
  const stale = await source.querySession(`agy:${MAIN}`)
  assert.equal(stale.status, 'unknown')
  assert.equal(stale.statusUncertain, true)
  assert.match(stale.statusReason, /没有存活的 agy 进程/)
  assert.equal(await source.querySession(`agy:${CHILD}`), null)
  assert.equal(await source.querySession(`agy:${ARCHIVED}`), null)
})

test('agy 改名不重复完成时间，新一轮开始后才更新', async (t) => {
  const home = await fixture(t)
  const source = createAgySource({ agyHome: home, isAlive: () => false })
  const first = await source.querySession(`agy:${IDLE}`)
  rename(home, IDLE, 'Renamed', '2026-11-14 04:00:00+00:00')
  const renamed = await source.querySession(`agy:${IDLE}`)
  assert.equal(renamed.title, 'Renamed')
  assert.equal(renamed.observedAt, first.observedAt)
  const db = new DatabaseSync(join(home, 'conversation_summaries.db'))
  db.prepare("update conversation_summaries set step_count = 7, last_user_input_time = '2026-11-14 04:10:00+00:00', last_modified_time = '2026-11-14 04:12:00+00:00' where conversation_id = ?").run(IDLE)
  db.close()
  assert.equal((await source.querySession(`agy:${IDLE}`)).observedAt, '2026-11-14T04:12:00.000Z')
})

test('agy 预览按步骤还原提问与回复，完成详情只取本轮最终回复', async (t) => {
  const home = await fixture(t)
  const source = createAgySource({ agyHome: home, isAlive: () => false })
  const page = await source.readConversation(`agy:${IDLE}`, null)
  assert.deepEqual(page.messages.map((item) => [item.role, item.text]), [
    ['user', '汇总示例项目进度'], ['assistant', '先看看目录'], ['user', '只读取文档目录'], ['assistant', '已生成进度摘要。']])
  assert.match(page.warnings.join(), /工具调用暂不展示/)
  const empty = await source.readConversation(`agy:${CANCELLED}`, null)
  assert.equal(empty.messages.length, 0)
  assert.match(empty.warnings.join(), /尚未.*建立文字索引/)
  await assert.rejects(source.readConversation('agy:not-a-uuid', null), /未找到/)
  const session = await source.querySession(`agy:${IDLE}`)
  const details = await source.readCompletion(session, { retryDelayMs: 1 })
  assert.equal(details.finalReply, '已生成进度摘要。')
  assert.equal(details.durationMs, Date.parse('2026-11-14T03:36:28.434Z') - Date.parse('2026-11-14T03:33:08.866Z'))
  assert.equal(details.turnTokens, null)
})

test('agy 接入看板：ID 校验、来源路由、完成通知标注 Antigravity，中断不通知', async (t) => {
  assert.equal(validSessionId(`agy:${MAIN}`), true)
  assert.equal(sessionProvider(`agy:${MAIN}`), 'agy')
  assert.equal(validSessionId('agy:../../secret'), false)
  const home = await fixture(t)
  const empty = { queryAll: async () => [] }
  const sessions = createSessionSource({ codexSource: empty, kimiSource: empty, claudeSource: empty,
    agySource: createAgySource({ agyHome: home, isAlive: () => true }) })
  const monitor = createMonitor(sessions)
  t.after(() => monitor.close())
  monitor.requestDefault(); await monitor.waitForIdle()
  const board = monitor.snapshot().sessions.filter((row) => row.provider === 'agy')
  assert.equal(board.find((row) => row.nativeSessionId === MAIN).status, 'running')
  assert.equal(sessions.health().agy.status, 'ok')
  assert.equal((await sessions.readConversation(`agy:${IDLE}`, null)).messages.length, 4)

  const directory = await mkdtemp(join(tmpdir(), 'agy-notifications-'))
  const sent = []
  const startedAt = '2026-11-14T00:00:00.000Z'
  const notifications = createCompletionNotifications({ supported: true, startedAt, file: join(directory, 'history.json'), send: async (payload) => sent.push(payload) })
  t.after(async () => { await notifications.close(); await rm(directory, { recursive: true, force: true }) })
  const rows = await createAgySource({ agyHome: home, isAlive: () => true }).queryAll()
  for (const row of rows) { notifications.observe(row); notifications.observe(row) }
  await notifications.waitForIdle()
  assert.deepEqual(sent.map((payload) => payload.title), ['Antigravity 轮次已完成'])
  assert.equal(JSON.parse(await readFile(join(directory, 'history.json'), 'utf8')).sessions.length, 1)
  assert.match(completionToast(rows.find((row) => row.nativeSessionId === IDLE)).body, /Antigravity · Hub/)
})
