import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createMonitor } from './monitor.js'
import { createRecordStore } from './record-store.js'
import { createSessionSource, readLatestLifecycleEvent } from './session-source.js'

test('客户端保留卡片右侧时间但不显示活动文字', async () => {
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(client, /function formatTime\(value\)/)
  assert.match(client, /className: "cdm-time" }, formatTime\(session\.updatedAt\)/)
  assert.doesNotMatch(client, /"活动 " \+ formatTime\(session\.updatedAt\)/)
})

test('客户端使用待审核作为 turn_completed 泳道名称', async () => {
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(client, /key: "turn_completed", label: "待审核"/)
  assert.doesNotMatch(client, /label: "已完成"/)
})

test('客户端按可审核性分流异常会话，并在所有泳道展示上下文', async () => {
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /key: "unknown"/)
  assert.match(client, /item\.reviewable === true \? "turn_completed" : "record"/)
  assert.match(client, /abnormal \? "异常 · " \+ title : title/)
  assert.match(client, /React\.createElement\("span", \{ className: "cdm-reasonText", title: contextUsageTitle\(session\) \}, contextLabel\)/)
  assert.doesNotMatch(client, /const showContext/)
  assert.doesNotMatch(client, /cdm-reasonTimeOnly/)
})

test('客户端在 tokens_used 后展示累计提问次数', async () => {
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  const tokenIndex = client.indexOf('tokenLabel ? React.createElement')
  const questionIndex = client.indexOf('questionLabel ? React.createElement')
  assert.ok(tokenIndex >= 0)
  assert.ok(questionIndex > tokenIndex)
  assert.match(client, /questionCount\.toLocaleString\(\) \+ " times"/)
  assert.match(client, /return "Context " \+ formatContextTokenCount\(used\)/)
  assert.match(client, /return "Context unknown"/)
  assert.doesNotMatch(client, /return "上下文 /)
  assert.match(client, /Codex · DSH · Kimi · Claude/)
  assert.doesNotMatch(client, /最多 100 条/)
})

test('客户端等待异步刷新完成而不是固定延时读取', async () => {
  const client = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  assert.match(client, /const POLL_MS = 5000/)
  assert.match(client, /const REFRESH_POLL_MS = 200/)
  assert.match(client, /next && !next\.refreshing && next\.generatedAt !== previousGeneratedAt/)
  assert.match(client, /waitForRefresh\(previousGeneratedAt, \(\) => mountedRef\.current\)/)
  assert.match(client, /\.cdm-refreshGlyph\{display:block;line-height:1;transform-origin:center\}/)
  assert.match(client, /key: refreshPulse/)
  assert.match(client, /refreshActive \|\| refreshing \? " cdm-spin" : ""/)
  assert.match(client, /}, 900\);/)
  assert.doesNotMatch(client, /setTimeout\(\(\) => load\(true\), 220\)/)
})

test('宿主加载日志文案正确', async () => {
  const index = await readFile(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(index, /\[codex-monitor\] 宿主已加载/)
  assert.doesNotMatch(index, /宿主半已加载/)
})

async function requestFixture(body) {
  const script = `
    import { createServer } from 'node:http'
    import { apply } from './index.js'
    const effects = []
    const routes = new Map()
    const ctx = {
      logger: { info() {} },
      webServer: { register(options) { routes.set(options.path, options.handler); return () => {} } },
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') effects.push(cleanup) }
    }
    apply(ctx)
    const server = createServer((req, res) => routes.get(req.url)?.(req, res) || res.end())
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port
      const response = await fetch('http://127.0.0.1:' + port + '/codex-monitor/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)}
      })
      process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }))
      server.close(() => { effects.forEach((cleanup) => cleanup()); process.exit(0) })
    })
  `
  const child = spawn(process.execPath, ['--input-type=module'], {
    cwd: new URL('.', import.meta.url),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin.end(script)
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const exitCode = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString('utf8'))
  return JSON.parse(Buffer.concat(stdout).toString('utf8'))
}

async function routeFixture(path, body) {
  const script = `
    import { createServer } from 'node:http'
    import { apply } from './index.js'
    const effects = []
    const routes = new Map()
    const ctx = {
      logger: { info() {} },
      webServer: { register(options) { routes.set(options.path, options.handler); return () => {} } },
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') effects.push(cleanup) }
    }
    apply(ctx)
    const server = createServer((req, res) => routes.get(req.url)?.(req, res) || res.end())
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port
      const response = await fetch('http://127.0.0.1:' + port + ${JSON.stringify(path)}, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))}
      })
      process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }))
      server.close(() => { effects.forEach((cleanup) => cleanup()); process.exit(0) })
    })
  `
  const child = spawn(process.execPath, ['--input-type=module'], {
    cwd: new URL('.', import.meta.url),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin.end(script)
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const exitCode = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString('utf8'))
  return JSON.parse(Buffer.concat(stdout).toString('utf8'))
}

function lifecycle(type, timestamp = '2026-09-01T00:00:00.000Z') {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type } })
}

function sessionMeta(originator, source = 'vscode') {
  return JSON.stringify({
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { originator, source }
  })
}

function historySessionMeta(id, options = {}) {
  const payload = {
    id,
    session_id: id,
    originator: 'codex_vscode',
    source: 'vscode'
  }
  if (options.historyBaseThreadId) {
    payload.history_base = {
      thread_id: options.historyBaseThreadId,
      end_ordinal_exclusive: options.historyBaseEndOrdinalExclusive
    }
  }
  if (options.forkedFromId) {
    payload.forked_from_id = options.forkedFromId
    payload.forked_from_ordinal_exclusive = options.forkedFromOrdinalExclusive
  }
  return JSON.stringify({
    ordinal: options.ordinal || 0,
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'session_meta',
    payload
  })
}

function rolloutUserMessage(text, ordinal) {
  const record = {
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }]
    }
  }
  if (ordinal !== undefined) record.ordinal = ordinal
  return JSON.stringify(record)
}

function tokenCount(inputTokens = 149_878, modelContextWindow = 258_400, timestamp = '2026-09-01T00:00:01.000Z') {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: inputTokens },
        model_context_window: modelContextWindow
      }
    }
  })
}

async function fixture(options = {}) {
  const includeExtendedModelFields = options.includeExtendedModelFields !== false
  const root = await mkdtemp(join(tmpdir(), 'codex-monitor-'))
  const databasePath = join(root, 'state_5.sqlite')
  const historyDatabasePath = join(root, 'thread_history_1.sqlite')
  const database = new DatabaseSync(databasePath)
  const historyDatabase = new DatabaseSync(historyDatabasePath)
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      ${includeExtendedModelFields ? 'model_provider TEXT, reasoning_effort TEXT, tokens_used INTEGER,' : ''}
      model TEXT,
      thread_source TEXT,
      recency_at INTEGER NOT NULL
    )
  `)
  historyDatabase.exec(`
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL
    );
    CREATE INDEX idx_thread_items_user_messages
      ON thread_items(thread_id, rollout_ordinal)
      WHERE item_type = 'userMessage';
    CREATE TABLE thread_realtime_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    );
  `)
  const insertQuestion = historyDatabase.prepare(`
    INSERT INTO thread_items (thread_id, rollout_ordinal, item_type, item_id)
    VALUES (?, ?, 'userMessage', ?)
  `)
  const insert = database.prepare(includeExtendedModelFields ? `
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived, model_provider, model, reasoning_effort, tokens_used, thread_source, recency_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ` : `
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived, model, thread_source, recency_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const now = Math.floor(Date.now() / 1000)
  async function add(id, ageDays, event, options = {}) {
    const path = join(root, `${id}.jsonl`)
    if (event) {
      const lines = []
      if (options.originator) lines.push(sessionMeta(options.originator, options.source || 'vscode'))
      lines.push(lifecycle(event), tokenCount(options.contextUsedTokens, options.contextWindowTokens))
      await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
    }
    const values = [id, path, now - ageDays * 86400, now - ageDays * 86400, options.source || 'vscode', options.cwd || 'M:\\work', options.title || id, options.archived ? 1 : 0]
    if (includeExtendedModelFields) values.push(options.modelProvider || 'openai')
    values.push(options.model || 'gpt-test')
    if (includeExtendedModelFields) values.push(options.reasoningEffort || 'xhigh', options.tokensUsed ?? 1_617_253)
    values.push(options.threadSource || 'user', now - ageDays * 86400)
    insert.run(...values)
    for (let index = 0; index < (options.questionCount || 0); index += 1) {
      insertQuestion.run(id, index + 1, `${id}-question-${index + 1}`)
    }
    return path
  }
  return {
    root,
    databasePath,
    historyDatabasePath,
    database,
    historyDatabase,
    add,
    close: async () => { database.close(); historyDatabase.close(); await rm(root, { recursive: true, force: true }) }
  }
}

test('逆向扫描返回最新生命周期事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-monitor-tail-'))
  try {
    const path = join(root, 'rollout.jsonl')
    const noise = Array.from({ length: 5000 }, (_, index) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', index } }))
    await writeFile(path, [sessionMeta('Codex Desktop'), lifecycle('task_started'), ...noise, lifecycle('task_complete', '2026-09-01T00:03:00.000Z'), lifecycle('task_started', '2026-09-01T00:04:00.000Z'), tokenCount(149_878, 258_400, '2026-09-01T00:04:01.000Z')].join('\n') + '\n', 'utf8')
    const result = await readLatestLifecycleEvent(path, { initialBytes: 4096 })
    assert.equal(result.event, 'task_started')
    assert.equal(result.observedAt, '2026-09-01T00:04:00.000Z')
    assert.equal(result.contextUsedTokens, 149_878)
    assert.equal(result.contextWindowTokens, 258_400)
    assert.equal(result.contextObservedAt, '2026-09-01T00:04:01.000Z')
    assert.equal(result.originator, 'Codex Desktop')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('默认查询限制最近 7 天并排除归档、子 Agent 和旧会话', async () => {
  const data = await fixture()
  try {
    await data.add('recent-running', 1, 'task_started', {
      title: 'Recent running',
      modelProvider: 'custom',
      reasoningEffort: 'max',
      tokensUsed: 1_617_253,
      questionCount: 3
    })
    await data.add('recent-complete', 2, 'task_complete', { title: 'Recent complete' })
    await data.add('old', 8, 'task_complete')
    await data.add('archived', 1, 'task_complete', { archived: true })
    await data.add('subagent', 1, 'task_started', { threadSource: 'subagent' })
    const source = createSessionSource({ databasePath: data.databasePath, historyDatabasePath: data.historyDatabasePath, days: 7, limit: 30 })
    const result = await source.queryDefault()
    assert.deepEqual(result.sessions.map((item) => item.sessionId), ['recent-running', 'recent-complete'])
    assert.equal(result.sessions[0].status, 'running')
    assert.equal(result.sessions[0].modelProvider, 'custom')
    assert.equal(result.sessions[0].model, 'gpt-test')
    assert.equal(result.sessions[0].reasoningEffort, 'max')
    assert.equal(result.sessions[0].tokensUsed, 1_617_253)
    assert.equal(result.sessions[0].questionCount, 3)
    assert.equal(result.sessions[0].contextUsedTokens, 149_878)
    assert.equal(result.sessions[0].contextWindowTokens, 258_400)
    assert.equal(result.sessions[1].modelProvider, 'openai')
    assert.equal(result.sessions[1].reasoningEffort, 'xhigh')
    assert.equal(result.sessions[1].status, 'turn_completed')
  } finally {
    await data.close()
  }
})

test('累计提问次数汇总分页窗口、fork 继承和实时项', async () => {
  const data = await fixture()
  const parentId = '019d0000-0000-7000-8000-000000000100'
  const childId = '019d0000-0000-7000-8000-000000000200'
  const firstContinuationId = '019d0000-0000-7000-8000-000000000201'
  const currentWindowId = '019d0000-0000-7000-8000-000000000202'
  try {
    await data.add(childId, 1, 'task_complete', { title: 'Paginated fork' })
    const parentPath = join(data.root, `rollout-2026-09-01T00-00-00-${parentId}.jsonl`)
    const childPath = join(data.root, `rollout-2026-09-01T01-00-00-${childId}.jsonl`)
    const firstContinuationPath = join(data.root, `rollout-2026-09-01T02-00-00-${childId}_${firstContinuationId}.jsonl`)
    const currentPath = join(data.root, `rollout-2026-09-01T03-00-00-${childId}_${currentWindowId}.jsonl`)
    await Promise.all([
      writeFile(parentPath, `${historySessionMeta(parentId)}\n${lifecycle('task_complete')}\n`, 'utf8'),
      writeFile(childPath, `${historySessionMeta(childId, {
        ordinal: 10,
        historyBaseThreadId: parentId,
        historyBaseEndOrdinalExclusive: 10,
        forkedFromId: parentId,
        forkedFromOrdinalExclusive: 10
      })}\n${lifecycle('task_complete')}\n`, 'utf8'),
      writeFile(firstContinuationPath, `${historySessionMeta(childId, {
        ordinal: 20,
        historyBaseThreadId: childId,
        historyBaseEndOrdinalExclusive: 20,
        forkedFromId: parentId,
        forkedFromOrdinalExclusive: 10
      })}\n${lifecycle('task_complete')}\n`, 'utf8'),
      writeFile(currentPath, `${historySessionMeta(childId, {
        ordinal: 30,
        historyBaseThreadId: firstContinuationId,
        historyBaseEndOrdinalExclusive: 30,
        forkedFromId: parentId,
        forkedFromOrdinalExclusive: 10
      })}\n${lifecycle('task_complete')}\n`, 'utf8')
    ])
    data.database.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(currentPath, childId)

    const insert = data.historyDatabase.prepare(`
      INSERT INTO thread_items (thread_id, rollout_ordinal, item_type, item_id)
      VALUES (?, ?, 'userMessage', ?)
    `)
    for (const [threadId, ordinals] of [
      [parentId, [1, 5, 12]],
      [childId, [11, 12, 13]],
      [firstContinuationId, [21, 22, 23, 24]],
      [currentWindowId, [31, 32, 33, 34, 35]]
    ]) {
      for (const ordinal of ordinals) insert.run(threadId, ordinal, `${threadId}-${ordinal}`)
    }
    data.historyDatabase.prepare(`
      INSERT INTO thread_realtime_items (thread_id, item_id, rollout_ordinal, item_type)
      VALUES (?, ?, ?, 'userMessage'), (?, ?, ?, 'userMessage')
    `).run(
      currentWindowId, `${currentWindowId}-31`, 31,
      currentWindowId, `${currentWindowId}-live`, 36
    )

    const source = createSessionSource({
      codexHome: data.root,
      databasePath: data.databasePath,
      historyDatabasePath: data.historyDatabasePath
    })
    const result = await source.querySession(childId)

    assert.equal(result.questionCount, 15)
  } finally {
    await data.close()
  }
})

test('历史投影尚未生成时从 rollout 恢复提问次数并排除注入上下文', async () => {
  const data = await fixture()
  const sessionId = '019d0000-0000-7000-8000-000000000300'
  try {
    const rolloutPath = await data.add(sessionId, 1, 'task_started', { title: 'Legacy without projection' })
    await writeFile(rolloutPath, [
      historySessionMeta(sessionId),
      rolloutUserMessage('<environment_context>runtime context</environment_context>'),
      rolloutUserMessage('<recommended_plugins>plugins</recommended_plugins>\n<environment_context>runtime context</environment_context>'),
      rolloutUserMessage('# AGENTS.md instructions for M:\\work\n<environment_context>runtime context</environment_context>'),
      rolloutUserMessage('第一个真实问题'),
      rolloutUserMessage('第二个真实问题'),
      rolloutUserMessage('第三个真实问题'),
      rolloutUserMessage('第四个真实问题'),
      lifecycle('task_started')
    ].join('\n') + '\n', 'utf8')

    const source = createSessionSource({
      codexHome: data.root,
      databasePath: data.databasePath,
      historyDatabasePath: data.historyDatabasePath
    })
    const result = await source.querySession(sessionId)

    assert.equal(result.questionCount, 4)
  } finally {
    await data.close()
  }
})

test('旧索引缺少扩展模型字段时兼容为空', async () => {
  const data = await fixture({ includeExtendedModelFields: false })
  try {
    await data.add('legacy', 1, 'task_complete')
    const source = createSessionSource({
      databasePath: data.databasePath,
      historyDatabasePath: join(data.root, 'missing-history.sqlite')
    })
    const result = await source.queryDefault()
    assert.equal(result.sessions[0].modelProvider, null)
    assert.equal(result.sessions[0].model, 'gpt-test')
    assert.equal(result.sessions[0].reasoningEffort, null)
    assert.equal(result.sessions[0].tokensUsed, null)
    assert.equal(result.sessions[0].questionCount, null)
  } finally {
    await data.close()
  }
})

test('rollout originator 优先于 source 区分 Codex Desktop、VS Code 和 CLI', async () => {
  const data = await fixture()
  try {
    await data.add('desktop', 1, 'task_complete', { source: 'vscode', originator: 'Codex Desktop' })
    await data.add('vscode', 1, 'task_complete', { source: 'vscode', originator: 'codex_vscode' })
    await data.add('cli', 1, 'task_complete', { source: 'vscode', originator: 'codex-tui' })
    await data.add('fallback', 1, 'task_complete', { source: 'vscode' })
    const source = createSessionSource({ databasePath: data.databasePath })
    const result = await source.queryDefault()
    const sessions = new Map(result.sessions.map((item) => [item.sessionId, item]))
    assert.equal(sessions.get('desktop').source, 'app')
    assert.equal(sessions.get('vscode').source, 'vscode')
    assert.equal(sessions.get('cli').source, 'cli')
    assert.equal(sessions.get('fallback').source, 'vscode')
  } finally {
    await data.close()
  }
})

test('定向查询不受 7 天窗口限制', async () => {
  const data = await fixture()
  try {
    await data.add('old-session', 30, 'task_started', { title: 'Old running' })
    const source = createSessionSource({ databasePath: data.databasePath, days: 7, limit: 100 })
    const session = await source.querySession('old-session')
    assert.equal(session.sessionId, 'old-session')
    assert.equal(session.status, 'running')
  } finally {
    await data.close()
  }
})

test('默认查询最多返回 30 条并按最近活动倒序', async () => {
  const data = await fixture()
  try {
    for (let index = 0; index < 105; index += 1) {
      await data.add(`session-${String(index).padStart(3, '0')}`, index / 1000, 'task_complete')
    }
    const source = createSessionSource({ databasePath: data.databasePath, historyDatabasePath: data.historyDatabasePath, days: 7, limit: 100 })
    const result = await source.queryDefault()
    assert.equal(result.sessions.length, 30)
    assert.equal(result.sessions[0].sessionId, 'session-000')
    assert.equal(result.sessions.at(-1).sessionId, 'session-029')
  } finally {
    await data.close()
  }
})

test('缺失 rollout 降级为内部 unknown 且不影响其他会话', async () => {
  const data = await fixture()
  try {
    await data.add('healthy', 1, 'task_complete')
    await data.add('missing', 1, null)
    const source = createSessionSource({ databasePath: data.databasePath })
    const result = await source.queryDefault()
    const missing = result.sessions.find((item) => item.sessionId === 'missing')
    assert.equal(missing.status, 'unknown')
    assert.equal(missing.statusReason, 'rollout 文件不存在')
    assert.equal(missing.contextUsedTokens, null)
    assert.equal(missing.contextWindowTokens, null)
    assert.equal(result.sessions.find((item) => item.sessionId === 'healthy').status, 'turn_completed')
  } finally {
    await data.close()
  }
})

test('运行记录以 JSON 持久化且重复记录保留首次时间', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-monitor-records-'))
  try {
    const file = join(root, 'running-history.json')
    let stamp = '2026-09-01T01:00:00.000Z'
    const store = createRecordStore({ file, now: () => stamp })
    await store.remember('session-a')
    stamp = '2026-09-01T02:00:00.000Z'
    await store.remember('session-a')
    await store.remember('session-b')

    const document = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(document.version, 1)
    assert.deepEqual(document.sessions, [
      { sessionId: 'session-a', recordedAt: '2026-09-01T01:00:00.000Z' },
      { sessionId: 'session-b', recordedAt: '2026-09-01T02:00:00.000Z' }
    ])

    assert.equal(await store.remove('session-a'), true)
    assert.equal(await store.remove('session-a'), false)
    assert.deepEqual([...(await store.list()).keys()], ['session-b'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('运行记录损坏时保留快照且只降级记录健康状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-monitor-record-health-'))
  try {
    const file = join(root, 'running-history.json')
    const sessionId = '019d0000-0000-7000-8000-000000000000'
    const source = {
      querySession: async () => ({ sessionId, status: 'turn_completed' }),
      queryDefault: async () => ({
        queriedAt: '2026-09-01T01:00:00.000Z',
        sessions: [{
          sessionId,
          title: 'Record health',
          status: 'turn_completed',
          statusReason: '当前轮次已结束',
          updatedAt: '2026-09-01T01:00:00.000Z'
        }]
      })
    }
    const store = createRecordStore({ file })
    const monitor = createMonitor(source, { recordStore: store })

    monitor.requestDefault()
    await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'record')

    await writeFile(file, '{invalid', 'utf8')
    monitor.requestDefault()
    await monitor.waitForIdle()

    const snapshot = monitor.snapshot()
    assert.equal(snapshot.sessions[0].status, 'record')
    assert.equal(snapshot.health.index, 'ok')
    assert.equal(snapshot.health.records, 'degraded')
    assert.match(snapshot.health.lastError, /运行记录文件不是合法 JSON/)

    const reviewStore = {
      list: async () => new Map([[sessionId, '2026-09-01T00:30:00.000Z']]),
      remember: async () => new Map([[sessionId, '2026-09-01T00:30:00.000Z']]),
      remove: async () => { throw new Error('运行记录不可写') }
    }
    const reviewMonitor = createMonitor(source, { recordStore: reviewStore })
    reviewMonitor.requestDefault()
    await reviewMonitor.waitForIdle()
    assert.equal(reviewMonitor.snapshot().sessions[0].status, 'turn_completed')
    await assert.rejects(() => reviewMonitor.reviewCompleted(sessionId), /运行记录不可写/)
    const reviewSnapshot = reviewMonitor.snapshot()
    assert.equal(reviewSnapshot.sessions[0].status, 'turn_completed')
    assert.equal(reviewSnapshot.health.index, 'ok')
    assert.equal(reviewSnapshot.health.records, 'degraded')
    assert.match(reviewSnapshot.health.lastError, /运行记录不可写/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('默认完成会话保持记录，任意定向刷新建立记录并可审核', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-monitor-lifecycle-'))
  try {
    const sessionId = '019d0000-0000-7000-8000-000000000001'
    const file = join(root, 'running-history.json')
    let rawStatus = 'turn_completed'
    const session = () => ({
      sessionId,
      title: 'Lifecycle session',
      updatedAt: '2026-09-01T01:00:00.000Z',
      status: rawStatus,
      statusReason: rawStatus === 'running' ? '最新轮次已开始' : '最新轮次已经结束'
    })
    const source = {
      queryDefault: async () => ({ sessions: [session()], queriedAt: '2026-09-01T01:00:00.000Z' }),
      querySession: async () => session()
    }
    const recordStore = createRecordStore({ file, now: () => '2026-09-01T01:01:00.000Z' })
    const monitor = createMonitor(source, { recordStore })

    monitor.requestDefault()
    await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'record')
    await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })

    monitor.requestSession(sessionId)
    await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'turn_completed')
    assert.equal((await recordStore.list()).has(sessionId), true)

    const reviewedCompleted = await monitor.reviewCompleted(sessionId)
    assert.equal(reviewedCompleted.status, 'record')
    assert.equal((await recordStore.list()).has(sessionId), false)

    rawStatus = 'unknown'
    monitor.requestSession(sessionId)
    await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'unknown')
    assert.equal(monitor.snapshot().sessions[0].reviewable, true)
    assert.equal(monitor.snapshot().health.rollout, 'degraded')
    assert.equal((await recordStore.list()).has(sessionId), true)

    const reviewedUnknown = await monitor.reviewCompleted(sessionId)
    assert.equal(reviewedUnknown.status, 'unknown')
    assert.equal(reviewedUnknown.reviewable, false)
    assert.equal(monitor.snapshot().health.rollout, 'degraded')
    assert.equal((await recordStore.list()).has(sessionId), false)

    rawStatus = 'running'
    monitor.requestSession(sessionId)
    await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'running')
    assert.equal((await recordStore.list()).has(sessionId), true)
    monitor.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('首次默认刷新发现 running 立即建立记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-monitor-default-transition-'))
  try {
    const sessionId = 'default-transition'
    const rawStatus = 'running'
    const source = {
      queryDefault: async () => ({ sessions: [{ sessionId, status: rawStatus }] }),
      querySession: async () => null
    }
    const recordStore = createRecordStore({
      file: join(root, 'running-history.json'),
      now: () => '2026-09-01T03:00:00.000Z'
    })
    const monitor = createMonitor(source, { recordStore })

    monitor.requestDefault()
    await monitor.waitForIdle()
    assert.equal(monitor.snapshot().sessions[0].status, 'running')
    assert.equal((await recordStore.list()).has(sessionId), true)
    monitor.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('内部 unknown 按运行记录决定是否可审核', async () => {
  const sessionId = 'unknown-session'
  const records = new Map([[sessionId, '2026-09-01T01:00:00.000Z']])
  const recordStore = {
    list: async () => new Map(records),
    remember: async () => { throw new Error('不应写入') },
    remove: async (id) => records.delete(id)
  }
  const source = {
    queryDefault: async () => ({ sessions: [{ sessionId, status: 'unknown', statusReason: '读取失败' }] }),
    querySession: async () => null
  }
  const monitor = createMonitor(source, { recordStore })
  monitor.requestDefault()
  await monitor.waitForIdle()
  assert.equal(monitor.snapshot().sessions[0].status, 'unknown')
  assert.equal(monitor.snapshot().sessions[0].reviewable, true)
  assert.equal(monitor.snapshot().health.rollout, 'degraded')

  const reviewed = await monitor.reviewCompleted(sessionId)
  assert.equal(reviewed.status, 'unknown')
  assert.equal(reviewed.reviewable, false)
  assert.equal(reviewed.recordedAt, null)
  assert.equal(records.has(sessionId), false)
  monitor.close()
})

test('定向刷新查不到会话也持久化并立即生成异常占位卡', async () => {
  const sessionId = '019d0000-0000-7000-8000-000000000020'
  const recordedAt = '2026-09-01T04:00:00.000Z'
  const records = new Map()
  const recordStore = {
    list: async () => new Map(records),
    remember: async (id) => {
      if (!records.has(id)) records.set(id, recordedAt)
      return new Map(records)
    },
    remove: async (id) => records.delete(id)
  }
  const source = {
    queryDefault: async () => ({ sessions: [] }),
    querySession: async () => null
  }
  const monitor = createMonitor(source, { recordStore })

  monitor.requestSession(sessionId)
  await monitor.waitForIdle()

  const placeholder = monitor.snapshot().sessions[0]
  assert.equal(records.has(sessionId), true)
  assert.equal(placeholder.sessionId, sessionId)
  assert.equal(placeholder.status, 'unknown')
  assert.equal(placeholder.recordOnly, true)
  assert.equal(placeholder.reviewable, true)
  assert.equal(placeholder.recordedAt, recordedAt)
  assert.equal(monitor.snapshot().health.rollout, 'degraded')

  assert.equal(await monitor.reviewCompleted(sessionId), null)
  assert.equal(records.has(sessionId), false)
  assert.equal(monitor.snapshot().health.rollout, 'ok')
  monitor.close()
})

test('定向刷新可加入默认窗口外会话，默认刷新不会删除它', async () => {
  const defaultSession = { sessionId: 'recent', updatedAt: '2026-09-01T00:00:00Z', status: 'turn_completed', rolloutPath: 'C:\\private\\rollout.jsonl', historyMode: 'paginated' }
  const oldSession = { sessionId: 'old', updatedAt: '2026-08-01T00:00:00Z', status: 'running' }
  let defaultCalls = 0
  const source = {
    queryDefault: async () => { defaultCalls += 1; return { sessions: [defaultSession], queriedAt: new Date().toISOString() } },
    querySession: async (id) => id === 'old' ? oldSession : null
  }
  const monitor = createMonitor(source)
  monitor.requestDefault()
  await monitor.waitForIdle()
  monitor.requestSession('old')
  await monitor.waitForIdle()
  monitor.requestDefault()
  await monitor.waitForIdle()
  assert.equal(defaultCalls, 2)
  assert.deepEqual(monitor.snapshot().sessions.map((item) => item.sessionId), ['recent', 'old'])
  assert.equal('rolloutPath' in monitor.snapshot().sessions[0], false)
  assert.equal('historyMode' in monitor.snapshot().sessions[0], false)
  monitor.close()
})

test('默认刷新补查窗口外运行记录并恢复真实会话', async () => {
  const sessionId = '019d0000-0000-7000-8000-000000000010'
  const recordedAt = '2026-08-01T00:00:00.000Z'
  const queriedIds = []
  const source = {
    queryDefault: async () => ({ sessions: [], queriedAt: '2026-09-01T00:00:00.000Z' }),
    querySession: async (id) => {
      queriedIds.push(id)
      return {
        sessionId: id,
        title: '窗口外已完成会话',
        updatedAt: recordedAt,
        status: 'turn_completed',
        statusReason: '当前轮次已结束'
      }
    }
  }
  const recordStore = {
    list: async () => new Map([[sessionId, recordedAt]]),
    remember: async () => { throw new Error('不应写入') },
    remove: async () => false
  }
  const monitor = createMonitor(source, { recordStore })

  monitor.requestDefault()
  await monitor.waitForIdle()

  assert.deepEqual(queriedIds, [sessionId])
  assert.deepEqual(monitor.snapshot().sessions.map((item) => ({
    sessionId: item.sessionId,
    title: item.title,
    status: item.status
  })), [{ sessionId, title: '窗口外已完成会话', status: 'turn_completed' }])
  monitor.close()
})

test('窗口外补查得到 unknown 时 rollout 健康状态降级', async () => {
  const sessionId = '019d0000-0000-7000-8000-000000000021'
  const recordedAt = '2026-08-01T00:00:00.000Z'
  const source = {
    queryDefault: async () => ({ sessions: [], queriedAt: '2026-09-01T00:00:00.000Z' }),
    querySession: async () => ({
      sessionId,
      status: 'unknown',
      statusReason: 'rollout 文件读取失败',
      updatedAt: recordedAt
    })
  }
  const recordStore = {
    list: async () => new Map([[sessionId, recordedAt]]),
    remember: async () => { throw new Error('不应写入') },
    remove: async () => false
  }
  const monitor = createMonitor(source, { recordStore })

  monitor.requestDefault()
  await monitor.waitForIdle()

  const session = monitor.snapshot().sessions[0]
  assert.equal(session.status, 'unknown')
  assert.equal(session.reviewable, true)
  assert.equal(monitor.snapshot().health.rollout, 'degraded')
  monitor.close()
})

test('状态源找不到运行记录时显示未知会话并可审核移除', async () => {
  const sessionId = '019d0000-0000-7000-8000-000000000011'
  const recordedAt = '2026-08-01T00:00:00.000Z'
  const records = new Map([[sessionId, recordedAt]])
  const source = {
    queryDefault: async () => ({ sessions: [], queriedAt: '2026-09-01T00:00:00.000Z' }),
    querySession: async () => null
  }
  const recordStore = {
    list: async () => new Map(records),
    remember: async () => { throw new Error('不应写入') },
    remove: async (id) => records.delete(id)
  }
  const monitor = createMonitor(source, { recordStore })

  monitor.requestDefault()
  await monitor.waitForIdle()

  const placeholder = monitor.snapshot().sessions[0]
  assert.equal(placeholder.sessionId, sessionId)
  assert.equal(placeholder.title, '未知会话')
  assert.equal(placeholder.status, 'unknown')
  assert.equal(placeholder.recordOnly, true)
  assert.equal(placeholder.reviewable, true)
  assert.equal(placeholder.recordedAt, recordedAt)
  assert.match(placeholder.statusReason, /可审核完成以移除运行记录/)
  assert.equal(monitor.snapshot().health.rollout, 'degraded')

  const reviewed = await monitor.reviewCompleted(sessionId)
  assert.equal(reviewed, null)
  assert.equal(records.has(sessionId), false)
  assert.deepEqual(monitor.snapshot().sessions, [])
  assert.equal(monitor.snapshot().health.rollout, 'ok')
  monitor.close()
})

test('重复默认刷新请求合并为一个查询任务', async () => {
  let calls = 0
  let release
  const source = {
    queryDefault: () => new Promise((resolve) => { calls += 1; release = () => resolve({ sessions: [], queriedAt: new Date().toISOString() }) }),
    querySession: async () => null
  }
  const monitor = createMonitor(source)
  monitor.requestDefault()
  monitor.requestDefault()
  monitor.requestDefault()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  release()
  await monitor.waitForIdle()
  assert.equal(calls, 1)
  monitor.close()
})

test('刷新接口拒绝非字符串 sessionId', async () => {
  const result = await requestFixture(JSON.stringify({ sessionId: 123 }))
  assert.equal(result.status, 400)
  assert.equal(result.body.error, 'sessionId 必须是字符串')
})

test('刷新接口拒绝超过 128 KiB 的请求体', async () => {
  const result = await requestFixture(JSON.stringify({ padding: 'x'.repeat(129 * 1024) }))
  assert.equal(result.status, 413)
  assert.equal(result.body.error, '请求体过大')
})

test('审核接口拒绝无效 sessionId', async () => {
  const result = await routeFixture('/codex-monitor/review-completed', { sessionId: 123 })
  assert.equal(result.status, 400)
  assert.equal(result.body.error, 'sessionId 格式无效')
})

test('测试通知接口拒绝自定义通知内容', async () => {
  const result = await routeFixture('/codex-monitor/notifications/test', { title: '不可注入自定义通知' })
  assert.equal(result.status, 400)
  assert.equal(result.body.error, '测试通知不接受自定义内容')
})

test('全部审核接口拒绝无效选择和未知字段，空选择不会审核其它会话', async () => {
  const invalid = await routeFixture('/codex-monitor/review-all', { sessionIds: ['invalid'] })
  assert.equal(invalid.status, 400)
  const unknown = await routeFixture('/codex-monitor/review-all', { sessionIds: [], force: true })
  assert.equal(unknown.status, 400)
  const empty = await routeFixture('/codex-monitor/review-all', { sessionIds: [] })
  assert.equal(empty.status, 200)
  assert.equal(empty.body.reviewedCount, 0)
  assert.deepEqual(empty.body.reviewedIds, [])
})
