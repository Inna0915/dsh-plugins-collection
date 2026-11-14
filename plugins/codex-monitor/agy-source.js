import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { iso, text } from './session-common.js'
import { message, pageEvents, previewError } from './conversation.js'

// Google Antigravity (`agy`) keeps a summary index plus one SQLite trajectory per
// conversation under ~/.gemini/antigravity. Everything here is read-only: no hub
// API calls, no CSRF token use, no writes to the client's data directory.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUNNING = 'CASCADE_RUN_STATUS_RUNNING'
const IDLE = 'CASCADE_RUN_STATUS_IDLE'
const CLI_SOURCE = 'CORTEX_TRAJECTORY_SOURCE_CLI'
// Step facts observed in agy 1.5.x trajectories.
export const STEP = Object.freeze({ userInput: 14, response: 15, running: 2, done: 3, cancelled: 6 })
const MAX_REPLY = 24000
const OPEN = { readOnly: true, timeout: 1000 }

/** agy stores `2026-11-14 05:53:25.4819020+00:00`; Date needs `T` and at most milliseconds. */
export function agyTime(value) {
  if (typeof value !== 'string' || !value) return null
  const normalized = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')
  return iso(normalized)
}

export function workspacePath(uris) {
  let list = []
  try { list = JSON.parse(uris || '[]') } catch { return '' }
  const first = Array.isArray(list) ? list.find((item) => typeof item === 'string' && item) : null
  if (!first) return ''
  try { return first.startsWith('file:') ? fileURLToPath(first) : first }
  catch { return decodeURIComponent(first.replace(/^file:\/+/, '')) }
}

/**
 * Map one summary row to a kanban session.
 * @param row conversation_summaries row
 * @param detail last-step facts from the conversation database, or null when it is not stored locally
 * @param hubAlive whether any agy hub process registered for this data directory is still alive
 * @param completedAt stable completion time for the current turn (see createAgySource)
 */
export function agySession(row, detail, hubAlive, completedAt = null) {
  const id = row.conversation_id
  const updatedAt = agyTime(row.last_modified_time)
  const turnStartedAt = agyTime(row.last_user_input_time)
  const runningFlag = row.status === RUNNING || Number(row.not_fully_idle) === 1
  let status; let lifecycleEvent = null; let observedAt = updatedAt; let statusReason
  if (runningFlag && hubAlive) {
    status = 'running'; lifecycleEvent = 'turn_started'; observedAt = turnStartedAt || updatedAt
    statusReason = 'Antigravity 记录为执行中'
  } else if (runningFlag) {
    status = 'unknown'
    statusReason = 'Antigravity 记录为执行中，但没有存活的 agy 进程，可能已异常退出'
  } else if (row.status === IDLE) {
    status = 'turn_completed'; observedAt = completedAt || updatedAt
    if (Number(row.killed) === 1 || detail?.lastStatus === STEP.cancelled) {
      lifecycleEvent = 'turn_aborted'; statusReason = 'Antigravity 最新轮次已中断'
    } else if (detail && !(detail.lastType === STEP.response && detail.lastStatus === STEP.done)) {
      // Idle without a finished reply as the last step: stopped, not a normal completion.
      lifecycleEvent = 'turn_aborted'; statusReason = 'Antigravity 已停止，最后一步不是完成的回复'
    } else {
      lifecycleEvent = 'turn_completed'; statusReason = 'Antigravity 已记录本轮回复完成'
    }
  } else {
    status = 'unknown'; statusReason = `Antigravity 状态未识别：${text(row.status, 60) || '空'}`
  }
  return {
    sessionId: `agy:${id}`, nativeSessionId: id, provider: 'agy',
    source: row.source === CLI_SOURCE ? 'agy-cli' : 'agy-hub',
    title: text(row.title) || text(row.preview) || '未命名 Antigravity 会话', cwd: workspacePath(row.workspace_uris),
    modelProvider: '', model: '', reasoningEffort: '', tokensUsed: null,
    questionCount: detail?.questions || null, contextUsedTokens: null, contextWindowTokens: null, contextObservedAt: null,
    createdAt: null, updatedAt, observedAt, status, lifecycleEvent, statusReason,
    statusUncertain: status === 'unknown', turnStartedAt,
    statusSource: detail ? 'agy-summary-and-trajectory' : 'agy-summary'
  }
}

/** Split one FTS chunk into per-step texts using agy's `[[step, byteOffset], ...]` maps. */
export function chunkEvents(offsets, body, role) {
  let pairs = []
  try { pairs = JSON.parse(Buffer.isBuffer(offsets) || offsets instanceof Uint8Array ? Buffer.from(offsets).toString('utf8') : String(offsets || '[]')) }
  catch { return [] }
  if (!Array.isArray(pairs)) return []
  const bytes = Buffer.from(String(body || ''), 'utf8')
  const events = []
  pairs.forEach((pair, index) => {
    const [step, start] = Array.isArray(pair) ? pair : []
    if (!Number.isSafeInteger(step) || !Number.isSafeInteger(start) || start < 0 || start > bytes.length) return
    const next = pairs[index + 1]?.[1]
    const end = Number.isSafeInteger(next) && next >= start && next <= bytes.length ? next : bytes.length
    const value = bytes.subarray(start, end).toString('utf8').trim()
    if (value) events.push({ seq: step, role, text: value })
  })
  return events
}

export function createAgySource(options = {}) {
  const home = options.agyHome || join(homedir(), '.gemini', 'antigravity')
  const summaryPath = join(home, 'conversation_summaries.db')
  const isAlive = options.isAlive || ((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  const details = new Map()
  const completions = new Map()
  let sourceStatus = { status: 'loading', count: 0, errors: [] }

  async function hubAlive() {
    let files = []
    try { files = await readdir(join(home, 'daemon'), { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
    for (const file of files) {
      if (!file.isFile() || !/^hub_\d+\.json$/.test(file.name)) continue
      try {
        const path = join(home, 'daemon', file.name)
        if ((await stat(path)).size > 16 * 1024) continue
        const pid = JSON.parse(await readFile(path, 'utf8'))?.pid
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return true
      } catch { /* A hub can remove or rewrite its registration while starting or exiting. */ }
    }
    return false
  }

  function withSummary(read) {
    const db = new DatabaseSync(summaryPath, OPEN)
    try { return read(db) } finally { db.close() }
  }

  const SUMMARY_COLUMNS = `conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, source,
    not_fully_idle, killed, last_user_input_time`
  // Sub-agent conversations carry a parent and an agent name; the board shows main conversations only.
  const MAIN = `parent_conversation_id = '' and agent_name = '' and nesting_depth = 0`

  function archivedIds(db) {
    try { return new Set(db.prepare('select c0 id from conversations_fts_content where c1 = -1 and c7 = 1').all().map((row) => row.id)) }
    catch { return new Set() }
  }

  function readDetail(row) {
    const key = `${row.last_modified_time}|${row.step_count}|${row.status}`
    const cached = details.get(row.conversation_id)
    if (cached?.key === key) return cached.value
    const path = join(home, 'conversations', `${row.conversation_id}.db`)
    let value = null
    if (existsSync(path)) {
      const db = new DatabaseSync(path, OPEN)
      try {
        const last = db.prepare('select step_type, status from steps order by idx desc limit 1').get()
        const { questions } = db.prepare(`select count(*) questions from steps where step_type = ${STEP.userInput}`).get()
        value = { lastType: last?.step_type ?? null, lastStatus: last?.status ?? null, questions: Number(questions) || 0 }
      } finally { db.close() }
    }
    details.set(row.conversation_id, { key, value })
    return value
  }

  // last_modified_time can move without a new turn (for example a rename). Keep the
  // first completion time seen for the same turn so notifications are not repeated.
  function completionTime(row) {
    if (row.status !== IDLE) { completions.delete(row.conversation_id); return null }
    const turn = `${row.last_user_input_time}|${row.step_count}`
    const known = completions.get(row.conversation_id)
    if (known?.turn === turn) return known.at
    const at = agyTime(row.last_modified_time)
    completions.set(row.conversation_id, { turn, at })
    return at
  }

  function toSession(row, alive) {
    let detail = null; let failed = false
    try { detail = readDetail(row) } catch { failed = true }
    return { session: agySession(row, detail, alive, completionTime(row)), failed }
  }

  function textEvents(db, id) {
    const rows = db.prepare(`select c1 chunk, cast(c8 as text) userOffsets, cast(c9 as text) agentOffsets, c13 userBody, c14 agentBody
      from conversations_fts_content where c0 = ? and c1 >= 0 order by c1`).all(id)
    const events = rows.flatMap((row) => [...chunkEvents(row.userOffsets, row.userBody, 'user'), ...chunkEvents(row.agentOffsets, row.agentBody, 'assistant')])
    const indexed = db.prepare('select c5 steps from conversations_fts_content where c0 = ? and c1 = -1').get(id)
    return { events: events.sort((a, b) => a.seq - b.seq || (a.role === 'user' ? -1 : 1)), indexedSteps: Number(indexed?.steps) || 0 }
  }

  return {
    async queryAll() {
      if (!existsSync(summaryPath)) { sourceStatus = { status: 'empty', count: 0, errors: [] }; return [] }
      const rows = withSummary((db) => {
        const archived = archivedIds(db)
        return db.prepare(`select ${SUMMARY_COLUMNS} from conversation_summaries where ${MAIN} order by last_modified_time desc`).all()
          .filter((row) => UUID.test(row.conversation_id) && !archived.has(row.conversation_id))
      })
      // Read liveness after the index so a hub that exits meanwhile is not reported as running.
      const alive = await hubAlive()
      let failures = 0
      const sessions = rows.map((row) => { const result = toSession(row, alive); if (result.failed) failures++; return result.session })
      const present = new Set(rows.map((row) => row.conversation_id))
      for (const id of details.keys()) if (!present.has(id)) details.delete(id)
      for (const id of completions.keys()) if (!present.has(id)) completions.delete(id)
      sourceStatus = { status: failures ? 'degraded' : sessions.length ? 'ok' : 'empty', count: sessions.length,
        errors: failures ? [`${failures} 条 Antigravity 会话详情暂时无法读取`] : [] }
      return sessions
    },
    async querySession(sessionId) {
      const id = sessionId.slice(4)
      if (!UUID.test(id) || !existsSync(summaryPath)) return null
      const row = withSummary((db) => archivedIds(db).has(id) ? null
        : db.prepare(`select ${SUMMARY_COLUMNS} from conversation_summaries where conversation_id = ? and ${MAIN}`).get(id))
      return row ? toSession(row, await hubAlive()).session : null
    },
    health: () => sourceStatus,
    async readConversation(sessionId, cursor) {
      const id = sessionId.slice(4)
      if (!UUID.test(id) || !existsSync(summaryPath)) throw previewError('未找到该 Antigravity 会话', 404)
      const { events } = withSummary((db) => textEvents(db, id))
      const page = pageEvents(sessionId, events, (event) => message(event.role, event.text), cursor)
      const warnings = ['Antigravity 预览仅显示提问与文字回复，工具调用暂不展示']
      if (!events.length) warnings.push('Antigravity 尚未为该会话建立文字索引')
      return { ...page, warnings }
    },
    async readCompletion(session, options = {}) {
      options.signal?.throwIfAborted()
      const id = session.sessionId.slice(4)
      if (!UUID.test(id) || !existsSync(summaryPath)) return null
      const read = () => withSummary((db) => {
        const indexed = textEvents(db, id)
        const summary = db.prepare('select step_count from conversation_summaries where conversation_id = ?').get(id)
        return { ...indexed, steps: Number(summary?.step_count) || 0 }
      })
      let result = read()
      // agy flushes its text index around the idle transition; wait briefly once if it lags.
      if (result.indexedSteps < result.steps) {
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1500))
        options.signal?.throwIfAborted()
        result = read()
      }
      const lastUser = result.events.findLast((event) => event.role === 'user')?.seq ?? -1
      const reply = result.events.findLast((event) => event.role === 'assistant' && event.seq > lastUser)?.text || ''
      const characters = Array.from(reply)
      const durationMs = Date.parse(session.observedAt) - Date.parse(session.turnStartedAt)
      return { model: '', reasoningEffort: '', durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
        turnTokens: null, finalReply: characters.slice(0, MAX_REPLY).join(''), replyTruncated: characters.length > MAX_REPLY }
    }
  }
}
