import { createReadStream } from 'node:fs'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { iso, text } from './session-common.js'
import { contentText, readJsonlPage, previewError } from './conversation.js'
import { claudeMessage } from './provider-conversation.js'
import { readCompletionFile } from './completion-details.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LOG_BYTES = 128 * 1024 * 1024
const FRONTIER_BYTES = 64

export function createClaudeSummary(id) {
  return { id, title: '', customTitle: false, firstPrompt: '', cwd: '', model: '', reasoningEffort: '', entrypoint: '',
    createdAt: null, updatedAt: null, observedAt: null, turnStartedAt: null, status: 'unknown', lifecycleEvent: null,
    statusReason: '没有明确的轮次结束记录', prompts: new Set(), usage: new Map(),
    contextUsedTokens: null, contextObservedAt: null }
}

export function consumeClaude(summary, row) {
  if (row.isSidechain || (row.sessionId && row.sessionId !== summary.id)) return
  const time = iso(row.timestamp)
  if (time) { summary.createdAt ||= time; if (!summary.updatedAt || time > summary.updatedAt) summary.updatedAt = time }
  if (typeof row.cwd === 'string') summary.cwd = row.cwd
  if (typeof row.entrypoint === 'string') summary.entrypoint = row.entrypoint
  if (row.type === 'custom-title' && text(row.customTitle)) { summary.title = text(row.customTitle); summary.customTitle = true }
  if (row.type === 'ai-title' && !summary.customTitle) summary.title = text(row.aiTitle) || summary.title
  const message = row.message || {}
  const parts = Array.isArray(message.content) ? message.content : []
  const isPrompt = row.type === 'user' && !row.isMeta && !row.isCompactSummary && !row.toolUseResult
    && !parts.some((part) => part.type === 'tool_result') && Boolean(contentText(message.content).trim())
  if (isPrompt) {
    summary.firstPrompt ||= text(message.content)
    summary.prompts.add(row.promptId || row.uuid || time)
    summary.status = 'unknown'; summary.observedAt = time; summary.lifecycleEvent = null
    summary.statusReason = '已有新输入，是否仍在执行需结合客户端状态确认'
    const promptText = contentText(message.content).trim()
    if (/^\[Request interrupted by user(?: for tool use)?\]/.test(promptText)) {
      summary.status = 'turn_completed'; summary.lifecycleEvent = 'turn_aborted'; summary.statusReason = 'Claude 最新轮次已中断'
      summary.prompts.delete(row.promptId || row.uuid || time)
    } else {
      summary.turnStartedAt = time
    }
  }
  if (row.type === 'assistant') {
    if (typeof message.model === 'string' && message.model !== '<synthetic>') summary.model = message.model
    if (typeof row.effort === 'string') summary.reasoningEffort = row.effort
    if (message.usage && message.id) {
      const previous = summary.usage.get(message.id) || { input: 0, output: 0 }
      const input = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
        .reduce((total, key) => total + (Number.isFinite(message.usage[key]) ? message.usage[key] : 0), 0)
      const output = Number.isFinite(message.usage.output_tokens) ? message.usage.output_tokens : 0
      // One API message may be persisted once per content block. Count its usage once.
      summary.usage.set(message.id, { input: Math.max(previous.input, input), output: Math.max(previous.output, output) })
      summary.contextUsedTokens = input; summary.contextObservedAt = time
    }
    const hasAnswer = parts.some((part) => part.type === 'text' && part.text?.trim()) || typeof message.content === 'string'
    if (message.stop_reason === 'end_turn' && hasAnswer && time) {
      summary.status = 'turn_completed'; summary.observedAt = time; summary.lifecycleEvent = 'turn_completed'
      summary.statusReason = 'Claude 已记录最终回复结束'
    } else if (parts.length && time && time >= (summary.observedAt || '')) {
      summary.status = 'unknown'; summary.observedAt = time; summary.lifecycleEvent = null
      summary.statusReason = '尚无最终回复结束记录，运行状态待确认'
    }
  }
}

export function claudeSession(summary, live) {
  let { status, observedAt, lifecycleEvent, statusReason } = summary
  const liveAt = iso(live?.statusUpdatedAt || live?.updatedAt)
  // A live process descriptor describes its current state. statusUpdatedAt is
  // the transition time, not a heartbeat; tool logs keep advancing during a turn.
  if (live && liveAt && ['working', 'running', 'busy'].includes(live.status)) {
    status = 'running'; observedAt = liveAt; lifecycleEvent = 'turn_started'; statusReason = 'Claude 客户端记录为处理中'
  } else if (live && liveAt && ['waiting', 'permission', 'waiting_for_permission'].includes(live.status)) {
    status = 'running'; observedAt = liveAt; lifecycleEvent = 'turn_started'; statusReason = 'Claude 客户端正在等待输入或授权'
  }
  const entrypoint = live?.entrypoint || summary.entrypoint
  const source = /vscode/i.test(entrypoint) ? 'claude-vscode' : /cli|terminal|tui/i.test(entrypoint) ? 'claude-cli' : 'claude'
  return {
    sessionId: `claude:${summary.id}`, nativeSessionId: summary.id, provider: 'claude', source,
    title: summary.title || summary.firstPrompt || text(live?.name) || '未命名 Claude 会话', cwd: summary.cwd || live?.cwd || '',
    modelProvider: '', model: summary.model, reasoningEffort: summary.reasoningEffort,
    tokensUsed: summary.usage.size ? [...summary.usage.values()].reduce((total, usage) => total + usage.input + usage.output, 0) : null,
    questionCount: summary.prompts.size || null, contextUsedTokens: summary.contextUsedTokens,
    contextWindowTokens: null, contextObservedAt: summary.contextObservedAt,
    createdAt: summary.createdAt || iso(live?.startedAt), updatedAt: [summary.updatedAt, liveAt, iso(live?.updatedAt)].filter(Boolean).sort().at(-1) || null,
    observedAt, status, lifecycleEvent, statusReason, statusUncertain: status === 'unknown',
    turnStartedAt: summary.turnStartedAt,
    statusSource: live ? 'claude-client-and-log' : 'claude-log'
  }
}

async function directory(path) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

export function createClaudeSource(options = {}) {
  const home = options.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const cache = new Map(); const locations = new Map()
  let sourceStatus = { status: 'loading', count: 0, errors: [] }
  const isAlive = options.isAlive || ((pid) => { try { process.kill(pid, 0); return true } catch { return false } })

  async function liveSessions() {
    const sessions = new Map()
    for (const file of await directory(join(home, 'sessions'))) {
      if (!file.isFile() || !/^\d+\.json$/.test(file.name)) continue
      try {
        const path = join(home, 'sessions', file.name)
        if ((await stat(path)).size > 64 * 1024) continue
        const row = JSON.parse(await readFile(path, 'utf8'))
        if (UUID.test(row.sessionId) && Number.isInteger(row.pid) && row.pid > 0 && row.pid === Number(file.name.slice(0, -5)) && isAlive(row.pid)) sessions.set(row.sessionId, row)
      } catch { /* A process can remove its descriptor while exiting. */ }
    }
    return sessions
  }

  async function locate() {
    const next = new Map()
    for (const project of await directory(join(home, 'projects'))) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue
      const root = join(home, 'projects', project.name)
      for (const file of await directory(root)) {
        if (!file.isFile() || !file.name.endsWith('.jsonl') || !UUID.test(file.name.slice(0, -6))) continue
        const id = file.name.slice(0, -6)
        const path = join(root, file.name)
        const info = await stat(path)
        if (!next.has(id) || next.get(id).mtimeMs < info.mtimeMs) next.set(id, { path, ...info })
      }
    }
    locations.clear()
    for (const [id, file] of next) locations.set(id, file)
    for (const id of cache.keys()) if (!locations.has(id)) cache.delete(id)
  }

  function consumeLine(summary, line, allowPartial = false) {
    if (!line?.trim()) return
    let row
    try { row = JSON.parse(line) }
    catch {
      // The client can still be writing the final unterminated line.
      if (allowPartial) return
      throw new Error('Claude 会话日志包含无法解析的完整记录')
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Claude 会话日志记录格式无效')
    consumeClaude(summary, row)
  }

  // Folds newline-terminated records from `start` into `summary` and returns the
  // byte offset after the last newline plus the unterminated tail, if any.
  async function foldFrom(summary, path, start) {
    const stream = createReadStream(path, { start })
    // Long records (inline images) span many chunks; collect them instead of
    // re-concatenating a growing buffer for every chunk.
    let offset = start; let pending = []; let pendingBytes = 0
    try {
      for await (const chunk of stream) {
        let lineStart = 0
        for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, lineStart)) {
          const piece = chunk.subarray(lineStart, index)
          const line = pending.length ? Buffer.concat([...pending, piece]) : piece
          consumeLine(summary, line.toString('utf8').replace(/\r$/, ''))
          offset += pendingBytes + piece.length + 1
          pending = []; pendingBytes = 0
          lineStart = index + 1
        }
        if (lineStart < chunk.length) { pending.push(chunk.subarray(lineStart)); pendingBytes += chunk.length - lineStart }
      }
    } finally { stream.destroy() }
    return { offset, tail: Buffer.concat(pending).toString('utf8') }
  }

  async function frontierBytes(path, offset) {
    const length = Math.min(FRONTIER_BYTES, offset)
    const bytes = Buffer.alloc(length)
    if (!length) return bytes
    const handle = await open(path, 'r')
    try {
      const { bytesRead } = await handle.read(bytes, 0, length, offset - length)
      return bytes.subarray(0, bytesRead)
    } finally { await handle.close() }
  }

  async function readSummary(id, file) {
    const key = `${file.path}:${file.size}:${file.mtimeMs}`
    const cached = cache.get(id)
    if (cached?.key === key) return cached.result
    if (file.size > MAX_LOG_BYTES) throw new Error('Claude 单个会话日志超过读取上限')
    // Claude appends to the active transcript. Continue from the last complete
    // record when the file is the same one and the bytes before it are unchanged;
    // otherwise (replaced, truncated or rewritten) parse it from the beginning.
    const resume = cached && cached.path === file.path && cached.ino === file.ino && file.size >= cached.offset
      && (await frontierBytes(file.path, cached.offset)).equals(cached.frontier)
    const summary = resume ? cached.summary : createClaudeSummary(id)
    let folded
    try { folded = await foldFrom(summary, file.path, resume ? cached.offset : 0) }
    catch (error) { cache.delete(id); throw error }
    // An unterminated final record may still be in progress. Apply it to a copy
    // so the next read folds the completed line exactly once; the mtime fallback
    // also stays off the folded state.
    let result = summary
    if (folded.tail.trim()) { result = structuredClone(summary); consumeLine(result, folded.tail, true) }
    if (!result.updatedAt) result = { ...result, updatedAt: file.mtime.toISOString() }
    cache.set(id, { key, path: file.path, ino: file.ino, offset: folded.offset,
      frontier: await frontierBytes(file.path, folded.offset), summary, result })
    return result
  }

  return {
    async queryAll() {
      await locate()
      const summaries = []; let failures = 0
      for (const [id, file] of locations) {
        try { summaries.push(await readSummary(id, file)) }
        catch { failures++ }
      }
      // Read current client state after the potentially lengthy transcript scan.
      const live = await liveSessions()
      const rows = summaries.map((summary) => claudeSession(summary, live.get(summary.id)))
      sourceStatus = { status: failures ? 'degraded' : rows.length ? 'ok' : 'empty', count: rows.length, errors: failures ? [`${failures} 条 Claude 会话暂时无法读取`] : [] }
      return rows
    },
    async querySession(sessionId) {
      await locate()
      const id = sessionId.slice(7)
      const file = locations.get(id)
      if (!file) return null
      return claudeSession(await readSummary(id, file), (await liveSessions()).get(id))
    },
    health: () => sourceStatus,
    async readCompletion(session, options) {
      const file = locations.get(session.sessionId.slice(7))
      return file ? readCompletionFile(file.path, session, options) : null
    },
    async readConversation(sessionId, cursor) {
      await locate()
      const file = locations.get(sessionId.slice(7))
      if (!file) throw previewError('未找到该 Claude 主会话', 404)
      return readJsonlPage(sessionId, [{ filePath: file.path, sessionId: sessionId.slice(7) }], claudeMessage, cursor)
    }
  }
}
