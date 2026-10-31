import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, relative, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { readJsonlPage, previewError } from './conversation.js'
import { kimiMessage } from './provider-conversation.js'
import { readCompletionFile } from './completion-details.js'

import { iso, text, validSessionId } from './session-common.js'
export { iso, text } from './session-common.js'

export function canonicalId(value) {
  return String(value || '').replace(/^(session_|session-|ses_)/, '').toLowerCase()
}

function inside(root, path) {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith('..\\') && !suffix.startsWith('../') && !isAbsolute(suffix)
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function scanLines(path, visit) {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  let malformed = 0
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { malformed += 1; continue }
      visit(row)
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return malformed
}

export function sourceLabel(state, wire = {}) {
  const explicit = state.clientType || state.client?.platform || state.originator || wire.clientType
  if (typeof explicit === 'string') {
    if (/vscode|vs.?code/i.test(explicit)) return 'kimi-vscode'
    if (/cli|terminal|tui/i.test(explicit)) return 'kimi-cli'
    if (/desktop/i.test(explicit)) return 'kimi-desktop'
  }
  if (state.custom?.vscode_legacy_approval) return 'kimi-vscode'
  if (state.custom?.imported_from_kimi_cli) return 'kimi-cli'
  return 'kimi-unknown'
}

export function createWireSummary() {
  return {
    model: '', modelAlias: '', modelProvider: '', reasoningEffort: '',
    tokensUsed: null, contextUsedTokens: null, contextWindowTokens: null,
    contextObservedAt: null, updatedAt: null, lifecycleAt: null, turnStartedAt: null, status: 'unknown',
    statusReason: '没有记录可识别的轮次结束状态', firstPrompt: '', acceptedCount: 0,
    turnPromptCount: 0, contextUserCount: 0, legacyPromptCount: 0, promptIds: new Set(),
    clientType: '', legacyUsageIds: new Set(), parseErrors: 0, lifecycleEvent: null
  }
}

function usage(summary, value, time) {
  if (!value || typeof value !== 'object') return
  const inputKeys = ['inputOther', 'inputCacheRead', 'inputCacheCreation', 'input_other', 'input_cache_read', 'input_cache_creation']
  const inputParts = inputKeys.map((key) => value[key]).filter((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0)
  const input = inputParts.length ? inputParts.reduce((sum, part) => sum + part, 0) : value.inputTokens
  const output = value.output ?? value.outputTokens
  if (Number.isFinite(input) && input >= 0) {
    summary.contextUsedTokens = input
    summary.contextObservedAt = time
  }
  if (Number.isFinite(input) || Number.isFinite(output)) {
    summary.tokensUsed = (summary.tokensUsed || 0) + (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
  }
}

function lifecycle(summary, status, time, reason, event = status === 'running' ? 'turn_started' : null) {
  if (time && (!summary.lifecycleAt || time >= summary.lifecycleAt)) {
    if (status === 'running' && summary.status !== 'running') summary.turnStartedAt = time
    summary.status = status
    summary.lifecycleAt = time
    summary.statusReason = reason
    summary.lifecycleEvent = event
  }
}

export function consumeWire(summary, row) {
  if (row.agentId && row.agentId !== 'main') return
  const time = iso(row.time ?? row.timestamp ?? row.created_at)
  if (time && (!summary.updatedAt || time > summary.updatedAt)) summary.updatedAt = time
  const type = row.type
  if (type === 'metadata') summary.clientType = row.clientType || row.client?.platform || row.originator || ''
  if (type === 'llm.request' || type === 'profile.bind' || type === 'config.update') {
    if (row.kind && row.kind !== 'loop') return
    if (typeof row.model === 'string') summary.model = row.model
    if (typeof row.modelAlias === 'string') summary.modelAlias = row.modelAlias
    if (typeof row.provider === 'string') summary.modelProvider = row.provider
    if (typeof row.thinkingEffort === 'string') summary.reasoningEffort = row.thinkingEffort
  }
  if (type === 'prompt.accepted') {
    if (!row.promptId || !summary.promptIds.has(row.promptId)) summary.acceptedCount += 1
    if (row.promptId) summary.promptIds.add(row.promptId)
    if (!summary.firstPrompt) summary.firstPrompt = text(row.content || row.prompt)
    lifecycle(summary, 'running', time, 'Kimi 已接受新一轮输入')
  }
  if (type === 'turn.prompt') {
    summary.turnPromptCount += 1
    if (!summary.firstPrompt) summary.firstPrompt = text(row.prompt || row.content || row.userInput)
    lifecycle(summary, 'running', time, 'Kimi 轮次正在执行')
  }
  if (type === 'turn.started' || type === 'turn.begin') lifecycle(summary, 'running', time, 'Kimi 轮次正在执行')
  if (type === 'turn.ended' || type === 'prompt.completed') {
    lifecycle(summary, 'turn_completed', time, row.reason === 'completed' ? 'Kimi 最新轮次已完成' : `Kimi 最新轮次已结束（${text(row.reason || '结束', 60)}）`, row.reason === 'completed' ? 'turn_completed' : 'turn_aborted')
  }
  if (type === 'turn.cancel') lifecycle(summary, 'turn_completed', time, 'Kimi 最新轮次已取消', 'turn_aborted')
  if (type === 'context.append_message' && row.message?.role === 'user') summary.contextUserCount += 1
  if (type === 'context.append_loop_event' && row.event?.type === 'step.end' && ['stop', 'end_turn'].includes(row.event.finishReason)) {
    lifecycle(summary, 'turn_completed', time, 'Kimi 已记录最终回复结束', 'turn_completed')
  }
  if (type === 'usage.record' && (!row.usageScope || row.usageScope === 'turn')) usage(summary, row.usage, time)
  if (type === 'token_counting.measured' && Number.isFinite(row.tokens)) {
    // This is the measured post-response context. Prefer the latest request's
    // input-token usage above when it is available.
    if (summary.contextUsedTokens === null) summary.contextUsedTokens = row.tokens
  }
  const message = row.message
  if (message?.type === 'TurnBegin') {
    summary.legacyPromptCount += 1
    if (!summary.firstPrompt) summary.firstPrompt = text(message.payload?.user_input)
    lifecycle(summary, 'running', time, 'Kimi CLI 轮次正在执行')
  }
  if (message?.type === 'TurnEnd') lifecycle(summary, 'turn_completed', time, 'Kimi CLI 最新轮次已结束')
  if (message?.type === 'StatusUpdate') {
    const payload = message.payload || {}
    if (!payload.message_id || !summary.legacyUsageIds.has(payload.message_id)) {
      usage(summary, payload.token_usage, time)
      if (payload.message_id) summary.legacyUsageIds.add(payload.message_id)
    }
  }
}

export function parseModelWindows(config) {
  const windows = new Map()
  let alias = null
  let model = null
  let size = null
  const save = () => {
    if (alias && Number.isFinite(size) && size > 0) {
      windows.set(alias, size)
      if (model) windows.set(model, size)
    }
  }
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      save()
      const match = line.match(/^\s*\[models\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/)
      alias = match ? (match[1] || match[2] || match[3]) : null
      model = null
      size = null
    } else if (alias) {
      const modelMatch = line.match(/^\s*model\s*=\s*["']([^"']+)["']/)
      const sizeMatch = line.match(/^\s*max_context_size\s*=\s*([0-9_]+)/)
      if (modelMatch) model = modelMatch[1]
      if (sizeMatch) size = Number(sizeMatch[1].replaceAll('_', ''))
    }
  }
  save()
  return windows
}

export function codeSession(state, entry, summary, windows = new Map()) {
  const identifier = state.id || entry.sessionId || basename(entry.sessionDir)
  const createdAt = iso(state.createdAt) || summary.updatedAt
  const updatedAt = [iso(state.updatedAt), summary.updatedAt, createdAt].filter(Boolean).sort().at(-1) || null
  let status = summary.status
  let reason = summary.statusReason
  if (!summary.lifecycleAt && state.lastTurnReason) {
    status = 'turn_completed'
    reason = `Kimi 会话记录的轮次结果：${text(state.lastTurnReason, 60)}`
  }
  return {
    sessionId: `kimi:${identifier}`, nativeSessionId: identifier, provider: 'kimi', title: text(state.title || summary.firstPrompt || state.lastPrompt) || '未命名 Kimi 会话',
    cwd: state.cwd || state.workDir || entry.workDir || '', source: sourceLabel(state, summary),
    modelProvider: summary.modelProvider || '', model: summary.model || summary.modelAlias || '',
    reasoningEffort: summary.reasoningEffort || '', tokensUsed: summary.tokensUsed,
    questionCount: summary.acceptedCount || summary.turnPromptCount || summary.legacyPromptCount || summary.contextUserCount || null,
    createdAt, updatedAt, status, statusReason: reason, statusSource: 'kimi-session',
    observedAt: summary.lifecycleAt || iso(state.updatedAt), lifecycleEvent: summary.lifecycleEvent, contextUsedTokens: summary.contextUsedTokens,
    turnStartedAt: summary.turnStartedAt,
    contextWindowTokens: windows.get(summary.modelAlias) || windows.get(summary.model) || null,
    contextObservedAt: summary.contextObservedAt,
    sourceDetail: sourceLabel(state, summary) === 'kimi-unknown' ? '该会话未记录启动客户端，不能可靠区分 CLI 与编辑器' : ''
  }
}

export function createCodeSource(options = {}) {
  const codeHome = options.codeHome || process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')
  const legacyHome = options.legacyHome || process.env.KIMI_HOME || join(homedir(), '.kimi')
  const caches = new Map()
  const conversationFiles = new Map()
  let sourceStatus = { status: 'loading', count: 0 }

  async function readWire(path) {
    let info
    try { info = await stat(path) } catch (error) { if (error.code === 'ENOENT') return createWireSummary(); throw error }
    const key = `${info.size}:${info.mtimeMs}`
    if (caches.get(path)?.key === key) return caches.get(path).summary
    if (info.size > 128 * 1024 * 1024) throw new Error('Kimi 单个会话日志超过 128 MiB，未加载')
    const summary = createWireSummary()
    summary.parseErrors = await scanLines(path, (row) => consumeWire(summary, row))
    caches.set(path, { key, summary })
    return summary
  }

  async function entries() {
    const rows = new Map()
    const deleted = new Set()
    try {
      await scanLines(join(codeHome, 'session_index.jsonl'), (entry) => {
        if (!entry.sessionId) return
        if (entry.deleted) { rows.delete(entry.sessionId); deleted.add(entry.sessionId); return }
        deleted.delete(entry.sessionId)
        if (entry.sessionDir && inside(join(codeHome, 'sessions'), entry.sessionDir)) rows.set(entry.sessionId, entry)
      })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const workspace of await directories(join(codeHome, 'sessions'))) {
      for (const id of await directories(join(codeHome, 'sessions', workspace))) {
        if (!rows.has(id) && !deleted.has(id)) rows.set(id, { sessionId: id, sessionDir: join(codeHome, 'sessions', workspace, id) })
      }
    }
    return [...rows.values()]
  }

  async function queryAll() {
    const rows = []
    const seen = new Set()
    const failures = []
    const nextFiles = new Map()
    let windows = new Map()
    try { windows = parseModelWindows(await readFile(join(codeHome, 'config.toml'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') failures.push('Kimi 模型配置读取失败') }
    const allEntries = await entries()
    for (const entry of allEntries) {
      try {
        const state = await json(join(entry.sessionDir, 'state.json'))
        seen.add(canonicalId(state.id || entry.sessionId))
        if (state.custom?.kimi_cli_session_id) seen.add(canonicalId(state.custom.kimi_cli_session_id))
        if (state.archived || state.custom?.archived || state.custom?.parent_session_id) continue
        let summary = await readWire(join(entry.sessionDir, 'agents', 'main', 'wire.jsonl'))
        const legacyPath = state.custom?.kimi_cli_source_path
        if (!summary.lifecycleAt && state.custom?.imported_from_kimi_cli && typeof legacyPath === 'string'
          && inside(join(legacyHome, 'sessions'), legacyPath)) {
          const legacy = await readWire(join(legacyPath, 'wire.jsonl'))
          if (legacy.lifecycleAt) {
            summary = { ...summary, ...legacy, contextUserCount: summary.contextUserCount }
            if (legacy.status === 'running' && iso(state.custom.imported_at) > legacy.updatedAt) {
              summary.status = 'unknown'
              summary.statusReason = '迁移前的旧会话缺少结束事件，无法确认运行状态'
            }
          }
        }
        if (!state.title && !state.lastPrompt && !summary.firstPrompt && !summary.updatedAt) continue
        const session = codeSession(state, entry, summary, windows)
        if (!validSessionId(session.sessionId)) continue
        rows.push(session)
        nextFiles.set(session.sessionId, [{ filePath: join(entry.sessionDir, 'agents', 'main', 'wire.jsonl') }])
      } catch (error) {
        if (error.code !== 'ENOENT') failures.push('有 Kimi Code 会话暂时无法读取')
      }
    }
    let workDirs = []
    try { workDirs = (await json(join(legacyHome, 'kimi.json'))).work_dirs || [] } catch (error) { if (error.code !== 'ENOENT') failures.push('旧版 Kimi 工作区索引读取失败') }
    const cwdByBucket = new Map(workDirs.filter((item) => typeof item.path === 'string').map((item) => [createHash('md5').update(item.path).digest('hex'), item.path]))
    for (const bucket of await directories(join(legacyHome, 'sessions'))) {
      for (const id of await directories(join(legacyHome, 'sessions', bucket))) {
        if (seen.has(canonicalId(id))) continue
        const dir = join(legacyHome, 'sessions', bucket, id)
        try {
          const summary = await readWire(join(dir, 'wire.jsonl'))
          if (!summary.firstPrompt) {
            let users = 0
            await scanLines(join(dir, 'context.jsonl'), (message) => {
              if (message.role === 'user') { users += 1; if (!summary.firstPrompt) summary.firstPrompt = text(message.content) }
            })
            summary.contextUserCount = users
          }
          if (!summary.firstPrompt) continue
          const contextInfo = await stat(join(dir, 'context.jsonl')).catch(() => null)
          const session = codeSession({ title: summary.firstPrompt, custom: { imported_from_kimi_cli: true }, updatedAt: summary.updatedAt || contextInfo?.mtime.toISOString() }, { sessionId: id, sessionDir: dir, workDir: cwdByBucket.get(bucket) || '' }, summary)
          session.sessionId = `kimi-cli:${id}`
          if (!validSessionId(session.sessionId)) continue
          rows.push(session)
          nextFiles.set(session.sessionId, [{ filePath: join(dir, 'context.jsonl'), format: 'legacy' }])
        } catch (error) { if (error.code !== 'ENOENT') failures.push('有旧版 Kimi CLI 会话暂时无法读取') }
      }
    }
    sourceStatus = { status: failures.length ? 'degraded' : rows.length ? 'ok' : 'empty', count: rows.length, errors: [...new Set(failures)] }
    conversationFiles.clear()
    for (const [id, files] of nextFiles) conversationFiles.set(id, files)
    const usedPaths = new Set([...nextFiles.values()].flat().map((file) => file.filePath))
    for (const path of caches.keys()) if (!usedPaths.has(path)) caches.delete(path)
    return rows
  }

  return {
    queryAll, health: () => sourceStatus,
    async readCompletion(session, options) {
      const file = conversationFiles.get(session.sessionId)?.find((file) => file.format !== 'legacy')
      return file ? readCompletionFile(file.filePath, session, options) : null
    },
    querySession: async (sessionId) => {
      const rows = await queryAll()
      const found = rows.find((row) => row.sessionId === sessionId)
      if (!found && sourceStatus.status === 'degraded') throw new Error('Kimi 会话源暂时无法读取')
      return found || null
    },
    readConversation: async (sessionId, cursor) => {
      if (!conversationFiles.has(sessionId)) await queryAll()
      const files = conversationFiles.get(sessionId)
      if (!files) throw previewError('未找到该会话，可能已归档或删除', 404)
      try { return await readJsonlPage(sessionId, files, kimiMessage, cursor) }
      catch (error) { if (error.code === 'ENOENT') throw previewError('会话日志已移动或删除', 404); throw error }
    }
  }
}
