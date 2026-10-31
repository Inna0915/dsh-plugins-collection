import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { readJsonlPage, codexMessage, previewError } from './conversation.js'
import { readCompletionFile } from './completion-details.js'

const START_EVENTS = new Set(['task_started', 'turn_started', 'turn/started'])
const COMPLETE_EVENTS = new Set(['task_complete', 'turn_completed', 'turn_aborted', 'turn/completed'])
const LIFECYCLE_EVENTS = new Set([...START_EVENTS, ...COMPLETE_EVENTS])
const DEFAULT_DAYS = 7
const DEFAULT_LIMIT = 30
const INITIAL_META_BYTES = 64 * 1024
const MAX_META_BYTES = 4 * 1024 * 1024
const INITIAL_TAIL_BYTES = 256 * 1024
const MAX_SCAN_BYTES = 128 * 1024 * 1024

function unixSecondsToIso(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  const millis = numeric > 100000000000 ? numeric : numeric * 1000
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function compactText(value, maxLength) {
  const line = String(value ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || ''
  if (!line) return null
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line
}

function normalizeTokensUsed(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null
}

function normalizeQuestionCount(value) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
}

function normalizePath(value) {
  const text = String(value ?? '')
  return text.startsWith('\\\\?\\') ? text.slice(4) : text || null
}

function normalizeSource(value) {
  const text = compactText(value, 80)
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && parsed.subagent) return 'subagent'
    } catch {
      return text
    }
  }
  return text
}

function lifecycleFromLine(line) {
  if (!line || line.indexOf('event_msg') < 0) return null
  if (![...LIFECYCLE_EVENTS].some((event) => line.indexOf(event) >= 0)) return null
  try {
    const record = JSON.parse(line)
    if (record?.type !== 'event_msg') return null
    const event = record?.payload?.type
    if (!LIFECYCLE_EVENTS.has(event)) return null
    return {
      event,
      observedAt: typeof record.timestamp === 'string' ? record.timestamp : null
    }
  } catch {
    return null
  }
}

function tokenUsageFromLine(line) {
  if (!line || line.indexOf('event_msg') < 0 || line.indexOf('token_count') < 0) return null
  try {
    const record = JSON.parse(line)
    if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') return null
    const info = record?.payload?.info
    const contextUsedTokens = normalizeTokensUsed(info?.last_token_usage?.input_tokens)
    const contextWindowTokens = normalizeTokensUsed(info?.model_context_window)
    if (contextUsedTokens === null || contextWindowTokens === null || contextWindowTokens <= 0) return null
    return {
      contextUsedTokens,
      contextWindowTokens,
      contextObservedAt: typeof record.timestamp === 'string' ? record.timestamp : null
    }
  } catch {
    return null
  }
}

function normalizeOrdinal(value) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
}

function sessionMetadataFromLine(line) {
  if (!line || line.indexOf('session_meta') < 0) return null
  try {
    const record = JSON.parse(line)
    if (record?.type !== 'session_meta') return null
    const payload = record?.payload || {}
    const sessionId = compactText(payload.id || payload.session_id, 80)
    const historyBaseThreadId = compactText(payload?.history_base?.thread_id, 80)
    return {
      sessionId,
      originator: compactText(payload.originator, 80),
      forkedFromId: compactText(payload.forked_from_id, 80),
      forkedFromOrdinalExclusive: normalizeOrdinal(payload.forked_from_ordinal_exclusive),
      historyBaseThreadId
    }
  } catch {
    return null
  }
}

function sourceFromOriginator(originator, fallback) {
  const normalized = String(originator ?? '').trim().toLowerCase()
  if (normalized === 'codex desktop') return 'app'
  if (normalized === 'codex_vscode') return 'vscode'
  if (normalized === 'codex-tui') return 'cli'
  return fallback
}

async function readSessionMetadata(handle, fileSize, options = {}) {
  const initialBytes = Math.max(4096, Number(options.initialMetaBytes) || INITIAL_META_BYTES)
  const maxBytes = Math.max(initialBytes, Number(options.maxMetaBytes) || MAX_META_BYTES)
  const scanLimit = Math.min(maxBytes, fileSize)
  let bytesToRead = Math.min(initialBytes, fileSize)
  while (bytesToRead > 0) {
    const buffer = Buffer.allocUnsafe(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const lines = text.split('\n')
    const completeLines = bytesToRead < fileSize && !text.endsWith('\n') ? lines.slice(0, -1) : lines
    for (const line of completeLines) {
      const metadata = sessionMetadataFromLine(line.trimEnd())
      if (metadata) return metadata
    }
    if (bytesToRead >= scanLimit) return null
    bytesToRead = Math.min(bytesToRead * 4, scanLimit)
  }
  return null
}

async function readSessionOriginator(handle, fileSize, options = {}) {
  const metadata = await readSessionMetadata(handle, fileSize, options)
  return metadata?.originator || null
}

async function readRolloutMetadata(filePath, options = {}) {
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size === 0) return null
    return await readSessionMetadata(handle, stat.size, options)
  } finally {
    await handle.close()
  }
}

export async function readLatestLifecycleEvent(filePath, options = {}) {
  const initialBytes = Math.max(4096, Number(options.initialBytes) || INITIAL_TAIL_BYTES)
  const maxBytes = Math.max(initialBytes, Number(options.maxBytes) || MAX_SCAN_BYTES)
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size === 0) {
      return {
        event: null,
        observedAt: null,
        contextUsedTokens: null,
        contextWindowTokens: null,
        contextObservedAt: null,
        originator: null,
        scannedBytes: 0
      }
    }

    const originator = await readSessionOriginator(handle, stat.size, options)
    let bytesToRead = Math.min(initialBytes, stat.size)
    const scanLimit = Math.min(maxBytes, stat.size)
    while (true) {
      const offset = stat.size - bytesToRead
      const buffer = Buffer.allocUnsafe(bytesToRead)
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset)
      let text = buffer.subarray(0, bytesRead).toString('utf8')
      if (offset > 0) {
        const firstBreak = text.indexOf('\n')
        text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
      }
      const lines = text.split('\n')
      let lifecycle = null
      let tokenUsage = null
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trimEnd()
        if (!lifecycle) lifecycle = lifecycleFromLine(line)
        if (!tokenUsage) tokenUsage = tokenUsageFromLine(line)
        if (lifecycle && tokenUsage) break
      }
      if ((lifecycle && tokenUsage) || bytesToRead >= scanLimit) {
        return {
          event: lifecycle?.event || null,
          observedAt: lifecycle?.observedAt || null,
          contextUsedTokens: tokenUsage?.contextUsedTokens ?? null,
          contextWindowTokens: tokenUsage?.contextWindowTokens ?? null,
          contextObservedAt: tokenUsage?.contextObservedAt || null,
          originator,
          scannedBytes: bytesToRead
        }
      }
      bytesToRead = Math.min(bytesToRead * 4, scanLimit)
    }
  } finally {
    await handle.close()
  }
}

function eventToStatus(eventResult) {
  if (START_EVENTS.has(eventResult.event)) {
    return {
      status: 'running',
      statusReason: '最新轮次已开始，尚未发现结束事件',
      statusSource: 'rollout',
      lifecycleEvent: eventResult.event,
      observedAt: eventResult.observedAt
    }
  }
  if (COMPLETE_EVENTS.has(eventResult.event)) {
    return {
      status: 'turn_completed',
      statusReason: eventResult.event === 'turn_aborted' ? '最新轮次已中断' : '最新轮次已经结束',
      statusSource: 'rollout',
      lifecycleEvent: eventResult.event,
      observedAt: eventResult.observedAt
    }
  }
  return {
    status: 'unknown',
    statusReason: '未找到可识别的轮次生命周期事件',
    statusSource: 'none',
    observedAt: null
  }
}

function isSubagent(row) {
  const threadSource = String(row.thread_source ?? '').toLowerCase()
  const source = String(row.source ?? '').toLowerCase()
  return threadSource.includes('subagent') || source.includes('"subagent"')
}

function mapRow(row) {
  return {
    sessionId: String(row.id),
    title: compactText(row.name || row.title, 120) || '未命名会话',
    cwd: normalizePath(row.cwd),
    source: normalizeSource(row.source),
    modelProvider: compactText(row.model_provider, 80),
    model: compactText(row.model, 80),
    reasoningEffort: compactText(row.reasoning_effort, 40),
    tokensUsed: normalizeTokensUsed(row.tokens_used),
    questionCount: null,
    historyMode: compactText(row.history_mode, 40),
    rolloutPath: normalizePath(row.rollout_path),
    createdAt: unixSecondsToIso(row.created_at_ms || row.created_at),
    updatedAt: unixSecondsToIso(row.recency_at_ms || row.recency_at || row.updated_at_ms || row.updated_at)
  }
}

function rolloutWindowId(filePath) {
  const match = basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match ? match[1] : null
}

async function indexRolloutDirectory(directory, cache) {
  if (!cache.has(directory)) {
    cache.set(directory, (async () => {
      const result = new Map()
      try {
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
          const windowId = rolloutWindowId(entry.name)
          if (windowId) result.set(windowId, join(directory, entry.name))
        }
      } catch {
        return result
      }
      return result
    })())
  }
  return await cache.get(directory)
}

async function indexRolloutRoots(roots) {
  const result = new Map()
  const pending = [...roots]
  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const windowId = rolloutWindowId(entry.name)
        if (windowId && !result.has(windowId)) result.set(windowId, path)
      }
    }
  }
  return result
}

function createRolloutLocator(stateDatabase, codexHome) {
  const directoryCache = new Map()
  let globalIndexPromise = null
  const indexedPath = stateDatabase.prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1')

  return async function findRolloutPath(threadId, nearPath) {
    const normalizedId = String(threadId || '')
    if (!normalizedId) return null

    const nearDirectory = dirname(nearPath)
    const nearby = await indexRolloutDirectory(nearDirectory, directoryCache)
    if (nearby.has(normalizedId)) return nearby.get(normalizedId)

    const indexed = normalizePath(indexedPath.get(normalizedId)?.rollout_path)
    if (indexed) {
      if (rolloutWindowId(indexed) === normalizedId) return indexed
      const indexedDirectory = await indexRolloutDirectory(dirname(indexed), directoryCache)
      if (indexedDirectory.has(normalizedId)) return indexedDirectory.get(normalizedId)
    }

    if (!globalIndexPromise) {
      globalIndexPromise = indexRolloutRoots([
        join(codexHome, 'sessions'),
        join(codexHome, 'archived_sessions')
      ])
    }
    return (await globalIndexPromise).get(normalizedId) || null
  }
}

async function resolveQuestionLineage(row, findRolloutPath, metadataCache, options = {}) {
  const legacyFallback = () => row.historyMode === 'paginated'
    ? null
    : [{ threadId: row.sessionId, filePath: row.rolloutPath, maxOrdinalExclusive: null }]
  if (!row.rolloutPath) return legacyFallback()
  const seenPaths = new Set()
  const seenSegments = new Set()
  const segments = []
  let filePath = row.rolloutPath
  let activeSessionId = null
  let maxOrdinalExclusive = null
  let previousMetadata = null

  for (let depth = 0; depth < 128; depth += 1) {
    if (seenPaths.has(filePath)) return null
    seenPaths.add(filePath)
    let metadata
    try {
      if (!metadataCache.has(filePath)) {
        metadataCache.set(filePath, await readRolloutMetadata(filePath, options))
      }
      metadata = metadataCache.get(filePath)
    } catch {
      return depth === 0 ? legacyFallback() : null
    }

    if (!metadata?.sessionId) {
      return depth === 0 ? legacyFallback() : null
    }
    if (depth === 0) {
      if (metadata.sessionId !== row.sessionId) return null
      activeSessionId = metadata.sessionId
    } else if (metadata.sessionId !== activeSessionId) {
      if (previousMetadata?.forkedFromId !== metadata.sessionId || previousMetadata.forkedFromOrdinalExclusive === null) {
        return null
      }
      activeSessionId = metadata.sessionId
      maxOrdinalExclusive = previousMetadata.forkedFromOrdinalExclusive
    }

    const threadId = rolloutWindowId(filePath)
    if (!threadId) return null
    const segmentKey = `${threadId}:${maxOrdinalExclusive ?? ''}`
    if (seenSegments.has(segmentKey)) return null
    seenSegments.add(segmentKey)
    segments.push({ threadId, filePath, maxOrdinalExclusive })

    if (!metadata.historyBaseThreadId) return segments
    const priorPath = await findRolloutPath(metadata.historyBaseThreadId, filePath)
    if (!priorPath) return null
    previousMetadata = metadata
    filePath = priorPath
  }
  return null
}

function tableColumns(database, tableName) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
  if (!exists) return null
  return new Set(database.prepare(`PRAGMA table_info(${tableName})`).all().map((item) => item.name))
}

function countQuestionsInSegment(database, segment, itemColumns, realtimeColumns) {
  const hasCutoff = segment.maxOrdinalExclusive !== null
  if (hasCutoff && !itemColumns.has('rollout_ordinal')) return null
  const itemCutoff = hasCutoff ? ' AND rollout_ordinal < ?' : ''
  const canMergeRealtime = itemColumns.has('item_id') && realtimeColumns?.has('thread_id') &&
    realtimeColumns.has('item_type') && realtimeColumns.has('item_id') &&
    (!hasCutoff || realtimeColumns.has('rollout_ordinal'))

  if (canMergeRealtime) {
    const realtimeCutoff = hasCutoff ? ' AND rollout_ordinal < ?' : ''
    const statement = database.prepare(`
      SELECT COUNT(*) AS question_count
      FROM (
        SELECT item_id FROM thread_items
        WHERE item_type = 'userMessage' AND thread_id = ?${itemCutoff}
        UNION
        SELECT item_id FROM thread_realtime_items
        WHERE item_type = 'userMessage' AND thread_id = ?${realtimeCutoff}
      )
    `)
    const params = hasCutoff
      ? [segment.threadId, segment.maxOrdinalExclusive, segment.threadId, segment.maxOrdinalExclusive]
      : [segment.threadId, segment.threadId]
    return Number(statement.get(...params)?.question_count || 0)
  }

  const statement = database.prepare(`
    SELECT COUNT(*) AS question_count
    FROM thread_items
    WHERE item_type = 'userMessage' AND thread_id = ?${itemCutoff}
  `)
  const params = hasCutoff ? [segment.threadId, segment.maxOrdinalExclusive] : [segment.threadId]
  return Number(statement.get(...params)?.question_count || 0)
}

function userMessageText(payload) {
  if (!Array.isArray(payload?.content)) return ''
  return payload.content
    .map((item) => typeof item?.text === 'string' ? item.text : '')
    .join('\n')
}

function isInjectedUserContext(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return false
  return trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<recommended_plugins>') ||
    trimmed.startsWith('# AGENTS.md instructions for ')
}

async function readRolloutQuestionOrdinals(filePath, cache) {
  if (!filePath) return null
  const fileStat = await stat(filePath)
  const cacheKey = `${fileStat.size}:${fileStat.mtimeMs}`
  const cached = cache.get(filePath)
  if (cached?.key === cacheKey) return cached.ordinals

  const ordinals = []
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of lines) {
    if (!line.includes('response_item') || !line.includes('"role":"user"')) continue
    try {
      const record = JSON.parse(line)
      const payload = record?.payload
      if (record?.type !== 'response_item' || payload?.type !== 'message' || payload?.role !== 'user') continue
      if (isInjectedUserContext(userMessageText(payload))) continue
      ordinals.push(normalizeOrdinal(record.ordinal))
    } catch {
      // 忽略未写完或损坏的单行；历史投影仍可作为该窗口的保底来源。
    }
  }
  cache.set(filePath, { key: cacheKey, ordinals })
  return ordinals
}

async function countQuestionsInRollout(segment, cache) {
  try {
    const ordinals = await readRolloutQuestionOrdinals(segment.filePath, cache)
    if (!ordinals) return null
    if (segment.maxOrdinalExclusive === null) return ordinals.length
    if (ordinals.some((ordinal) => ordinal === null)) return null
    return ordinals.filter((ordinal) => ordinal < segment.maxOrdinalExclusive).length
  } catch {
    return null
  }
}

async function queryQuestionCounts(historyDatabasePath, stateDatabasePath, rows, codexHome, metadataCache, rolloutQuestionCache, options = {}) {
  const counts = new Map()
  if (rows.length === 0) return counts
  let stateDatabase = null
  let historyDatabase = null
  try {
    stateDatabase = new DatabaseSync(stateDatabasePath, { readOnly: true })
    const findRolloutPath = createRolloutLocator(stateDatabase, codexHome)
    const lineages = await Promise.all(rows.map(async (row) => ({
      sessionId: row.sessionId,
      segments: await resolveQuestionLineage(row, findRolloutPath, metadataCache, options)
    })))
    let itemColumns = null
    let realtimeColumns = null
    if (historyDatabasePath) {
      try {
        historyDatabase = new DatabaseSync(historyDatabasePath, { readOnly: true })
        itemColumns = tableColumns(historyDatabase, 'thread_items')
        if (!itemColumns?.has('thread_id') || !itemColumns.has('item_type')) itemColumns = null
        realtimeColumns = itemColumns ? tableColumns(historyDatabase, 'thread_realtime_items') : null
      } catch {
        historyDatabase?.close()
        historyDatabase = null
      }
    }

    for (const lineage of lineages) {
      if (!lineage.segments) continue
      let total = 0
      let complete = true
      for (const segment of lineage.segments) {
        const projectedCount = historyDatabase && itemColumns
          ? countQuestionsInSegment(historyDatabase, segment, itemColumns, realtimeColumns)
          : null
        const rolloutCount = projectedCount === null || projectedCount === 0
          ? await countQuestionsInRollout(segment, rolloutQuestionCache)
          : null
        const count = projectedCount === null || projectedCount === 0
          ? rolloutCount ?? projectedCount
          : projectedCount
        if (count === null) {
          complete = false
          break
        }
        total += count
      }
      const count = complete ? normalizeQuestionCount(total) : null
      if (count !== null) counts.set(lineage.sessionId, count)
    }
    return counts
  } catch {
    return counts
  } finally {
    stateDatabase?.close()
    historyDatabase?.close()
  }
}

function columnExpression(columns, name, fallback = 'NULL') {
  return columns.has(name) ? `"${name}"` : `${fallback} AS "${name}"`
}

function queryRows(databasePath, options = {}) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map((item) => item.name))
    for (const required of ['id', 'rollout_path']) {
      if (!columns.has(required)) throw new Error(`Codex threads 表缺少字段：${required}`)
    }

    const selected = [
      'id', 'rollout_path', 'created_at', 'created_at_ms', 'updated_at', 'updated_at_ms',
      'recency_at', 'recency_at_ms', 'source', 'thread_source', 'cwd', 'title', 'name',
      'model_provider', 'model', 'reasoning_effort', 'tokens_used', 'archived', 'history_mode'
    ].map((name) => columnExpression(columns, name))

    const where = []
    const params = {}
    if (columns.has('archived')) where.push('COALESCE(archived, 0) = 0')
    if (columns.has('thread_source')) where.push("(thread_source IS NULL OR lower(thread_source) NOT LIKE '%subagent%')")
    if (options.sessionId) {
      where.push('id = $sessionId')
      params.sessionId = options.sessionId
    } else {
      const recencyColumn = columns.has('recency_at_ms') ? 'recency_at_ms' : columns.has('recency_at') ? 'recency_at' : columns.has('updated_at_ms') ? 'updated_at_ms' : 'updated_at'
      if (!columns.has(recencyColumn)) throw new Error('Codex threads 表缺少最近活动时间字段')
      const milliseconds = recencyColumn.endsWith('_ms')
      params.cutoff = Date.now() - (options.days || DEFAULT_DAYS) * 86400000
      if (!milliseconds) params.cutoff = Math.floor(params.cutoff / 1000)
      where.push(`${recencyColumn} >= $cutoff`)
      const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_LIMIT, DEFAULT_LIMIT))
      params.limit = limit
      const sql = `SELECT ${selected.join(', ')} FROM threads WHERE ${where.join(' AND ')} ORDER BY ${recencyColumn} DESC LIMIT $limit`
      return database.prepare(sql).all(params).filter((row) => !isSubagent(row)).map(mapRow)
    }
    const sql = `SELECT ${selected.join(', ')} FROM threads WHERE ${where.join(' AND ')} LIMIT 1`
    return database.prepare(sql).all(params).filter((row) => !isSubagent(row)).map(mapRow)
  } finally {
    database.close()
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export function createSessionSource(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')
  const databasePath = options.databasePath || join(codexHome, 'state_5.sqlite')
  const historyDatabasePath = options.historyDatabasePath || join(dirname(databasePath), 'thread_history_1.sqlite')
  const days = options.days || DEFAULT_DAYS
  const limit = options.limit || DEFAULT_LIMIT
  const statusCache = new Map()
  const metadataCache = new Map()
  const rolloutQuestionCache = new Map()

  async function calibrate(row) {
    if (!row.rolloutPath) {
      return {
        ...row,
        ...eventToStatus({ event: null }),
        statusReason: '会话索引没有 rollout 路径',
        contextUsedTokens: null,
        contextWindowTokens: null,
        contextObservedAt: null
      }
    }
    try {
      const handle = await open(row.rolloutPath, 'r')
      const stat = await handle.stat()
      await handle.close()
      const cacheKey = `${stat.size}:${stat.mtimeMs}`
      const cached = statusCache.get(row.rolloutPath)
      if (cached?.key === cacheKey) return { ...row, ...cached.status }
      const latest = await readLatestLifecycleEvent(row.rolloutPath, options.scan)
      const status = {
        ...eventToStatus(latest),
        source: sourceFromOriginator(latest.originator, row.source),
        contextUsedTokens: latest.contextUsedTokens,
        contextWindowTokens: latest.contextWindowTokens,
        contextObservedAt: latest.contextObservedAt
      }
      statusCache.set(row.rolloutPath, { key: cacheKey, status })
      return { ...row, ...status }
    } catch (error) {
      return {
        ...row,
        status: 'unknown',
        statusReason: error?.code === 'ENOENT' ? 'rollout 文件不存在' : 'rollout 文件读取失败',
        statusSource: 'none',
        observedAt: null,
        contextUsedTokens: null,
        contextWindowTokens: null,
        contextObservedAt: null
      }
    }
  }

  async function query(queryOptions = {}) {
    const rows = queryRows(databasePath, queryOptions.sessionId
      ? { sessionId: queryOptions.sessionId }
      : { days, limit })
    const questionCounts = await queryQuestionCounts(
      historyDatabasePath,
      databasePath,
      rows,
      codexHome,
      metadataCache,
      rolloutQuestionCache,
      options.meta
    )
    const sessions = await mapWithConcurrency(rows.map((row) => ({
      ...row,
      questionCount: questionCounts.get(row.sessionId) ?? null
    })), 8, calibrate)
    return {
      sessions,
      queriedAt: new Date().toISOString(),
      scope: queryOptions.sessionId ? 'session' : 'default',
      window: { days, limit }
    }
  }

  return {
    databasePath,
    historyDatabasePath,
    async readCompletion(session, options) {
      const row = queryRows(databasePath, { sessionId: session.sessionId })[0]
      return row?.rolloutPath ? readCompletionFile(row.rolloutPath, session, options) : null
    },
    readConversation: async (sessionId, cursor) => {
      const row = queryRows(databasePath, { sessionId })[0]
      if (!row) throw previewError('未找到该会话，可能已归档或删除', 404)
      const database = new DatabaseSync(databasePath, { readOnly: true })
      let segments
      try {
        // Resolve inherited windows with fork cutoffs, without loading bodies.
        segments = await resolveQuestionLineage(row, createRolloutLocator(database, codexHome), new Map())
      } finally { database.close() }
      if (!segments?.length || segments.some((segment) => !segment.filePath)) throw previewError('会话历史暂时不可读', 404)
      try { return await readJsonlPage(sessionId, segments, codexMessage, cursor) }
      catch (error) { if (error.code === 'ENOENT') throw previewError('会话日志已移动或删除', 404); throw error }
    },
    queryDefault: () => query(),
    querySession: async (sessionId) => {
      const result = await query({ sessionId })
      return result.sessions[0] || null
    }
  }
}

export const defaults = Object.freeze({ days: DEFAULT_DAYS, limit: DEFAULT_LIMIT })
