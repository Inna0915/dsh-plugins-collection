import { iso, text, validSessionId } from './session-common.js'
import { pageEvents, previewError } from './conversation.js'
import { dshMessage } from './provider-conversation.js'
import { completionDetails } from './completion-details.js'

export function parseDshSession(header, events) {
  if (!header || !validSessionId(`dsh:${header.id}`) || header.parentSession || (header.delegationDepth || 0) > 0) return null
  let title = ''; let firstPrompt = ''; let modelProvider = ''; let model = ''; let reasoningEffort = ''
  let contextWindowTokens = null; let contextUsedTokens = null; let contextObservedAt = null; let tokensUsed = null
  let status = 'unknown'; let statusReason = '没有记录可识别的轮次状态'; let observedAt = null; let lifecycleEvent = null
  let updatedAt = iso(header.createdAt)
  const prompts = new Set()
  for (const event of events) {
    const data = event.data || {}
    const timestamp = iso(event.time)
    if (timestamp && (!updatedAt || timestamp > updatedAt)) updatedAt = timestamp
    if (event.type === 'session/title') title = text(data.title)
    if (event.type === 'model/selection' || event.type === 'request/context') {
      if (typeof data.provider === 'string') modelProvider = data.provider
      if (typeof data.model === 'string') model = data.model
      if (typeof data.reasoningEffort === 'string') reasoningEffort = data.reasoningEffort
      if (Number.isFinite(data.contextWindow)) contextWindowTokens = data.contextWindow
    }
    if (event.type === 'request/header' && typeof data.header?.config?.reasoningEffort === 'string') reasoningEffort = data.header.config.reasoningEffort
    if (event.type === 'user/message' && data.source?.kind === 'user') {
      prompts.add(data.id || data.source.rpcId || event.seq)
      if (!firstPrompt) firstPrompt = text(data.content)
    }
    if (event.type === 'turn/start') {
      status = 'running'; statusReason = 'DSH 轮次已开始，尚未记录结束'; observedAt = timestamp; lifecycleEvent = 'turn_started'
    }
    if (event.type === 'turn/end') {
      status = 'turn_completed'
      const reason = data.reason?.kind
      statusReason = reason === 'completed' ? 'DSH 最新轮次已完成' : `DSH 最新轮次已结束（${text(reason || '结果未记录', 60)}）`
      observedAt = timestamp
      lifecycleEvent = reason === 'completed' ? 'turn_completed' : 'turn_aborted'
    }
    if (event.type === 'assistant/message' && data.usage) {
      const usage = data.usage
      const total = usage.totalTokens ?? ((usage.inputTokens || 0) + (usage.outputTokens || 0))
      if (Number.isFinite(total)) tokensUsed = (tokensUsed || 0) + total
      if (Number.isFinite(usage.inputTokens)) { contextUsedTokens = usage.inputTokens; contextObservedAt = timestamp }
    }
  }
  return {
    sessionId: `dsh:${header.id}`, nativeSessionId: header.id, provider: 'dsh', source: 'dsh',
    title: title || firstPrompt || '未命名 DSH 会话', cwd: header.cwd || '',
    modelProvider, model, reasoningEffort, tokensUsed, questionCount: prompts.size || null,
    createdAt: iso(header.createdAt), updatedAt, status, statusReason, statusUncertain: status === 'unknown',
    statusSource: 'dsh-session', observedAt, lifecycleEvent,
    contextUsedTokens, contextWindowTokens, contextObservedAt
  }
}

export function createDshSource(ctx) {
  const cache = new Map()
  let sourceStatus = { status: 'loading', count: 0, errors: [] }
  async function queryOne(id, header, snapshot, persistence = ctx.get?.('sessionPersistence')) {
    const live = ctx.sessions.get(id)
    if (header?.parentSession || (header?.delegationDepth || 0) > 0) return null
    // Cordis may wrap a service in different Context proxies. Its public
    // identity remains stable until the persistence provider is replaced.
    const persistenceIdentity = persistence?.identity ?? persistence
    let key = live ? `live:${live.seq}` : null
    if (!live && (snapshot || persistence?.stat)) {
      const info = snapshot || await persistence.stat(id)
      if (info) key = `stored:${JSON.stringify(info.revision)}`
    }
    const saved = cache.get(id)
    if (key && saved?.key === key && saved.persistenceIdentity === persistenceIdentity) return saved.session
    let session
    let observedLive = Boolean(live)
    let readPersistedEvents = false
    try {
      if (!live && typeof persistence?.open === 'function') {
        // SessionQuery repairs cold transcripts with synthetic interrupted
        // turn/end events. Another Host/CLI may still be writing this session;
        // monitor lifecycle facts from the read-only persistence handle instead.
        const handle = await persistence.open(id, 'read')
        try {
          const raw = await handle.read(0)
          session = parseDshSession(handle.header, raw.events)
          readPersistedEvents = true
        } finally { await handle.close() }
      } else if (typeof ctx.sessionQuery.observeSession === 'function') {
        // Unlike readSession(), this public API does not list the entire
        // persistence corpus again for each card. Do not retain raw events.
        const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
        try {
          session = parseDshSession(observation.header, observation.events)
          observedLive = observation.source === 'live'
          if (observedLive && Number.isInteger(observation.cursor)) key = `live:${observation.cursor + 1}`
          else if (observation.revision !== undefined) key = `stored:${JSON.stringify(observation.revision)}`
        } finally { observation[Symbol.dispose]() }
      } else {
        const raw = await ctx.sessionQuery.readSession(id)
        session = parseDshSession(raw.session, raw.events)
      }
    }
    catch (error) {
      if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error.name === 'SessionPersistenceNotFoundError') return null
      throw error
    }
    if (session?.status === 'running' && !observedLive) {
      session = readPersistedEvents
        ? { ...session, statusReason: '外部 DSH 会话已开始，原始日志尚未记录轮次结束' }
        : { ...session, status: 'unknown', statusUncertain: true, lifecycleEvent: null, statusReason: '持久化日志缺少结束事件，当前宿主未加载此会话，运行状态待确认' }
    }
    if (key) cache.set(id, { key, persistenceIdentity, session })
    return session
  }

  async function listRecords(persistence) {
    if (typeof persistence?.list !== 'function' || typeof ctx.sessions.list !== 'function') return ctx.sessionQuery.listSessions()
    // One listing supplies revisions for every stored session; avoid an
    // individual stat() scan for each unchanged card.
    const stored = await persistence.list()
    const records = new Map(stored.map((snapshot) => [snapshot.header.id, { header: snapshot.header, snapshot }]))
    for (const live of ctx.sessions.list()) records.set(live.id, { header: live.header })
    return [...records.values()]
  }
  return {
    async queryAll() {
      const persistence = ctx.get?.('sessionPersistence')
      const records = await listRecords(persistence)
      const currentIds = new Set(records.map((record) => record.header.id))
      for (const id of cache.keys()) if (!currentIds.has(id)) cache.delete(id)
      const rows = []; let failures = 0
      for (let offset = 0; offset < records.length; offset += 4) {
        await Promise.all(records.slice(offset, offset + 4).map(async ({ header, snapshot }) => {
          try { const session = await queryOne(header.id, header, snapshot, persistence); if (session) rows.push(session) }
          catch { failures++ }
        }))
      }
      sourceStatus = { status: failures ? 'degraded' : rows.length ? 'ok' : 'empty', count: rows.length, errors: failures ? [`${failures} 条 DSH 会话暂时无法读取`] : [] }
      return rows
    },
    querySession: (sessionId) => queryOne(sessionId.slice(4)),
    health: () => sourceStatus,
    async readCompletion(session, options = {}) {
      options.signal?.throwIfAborted()
      const id = session.sessionId.slice(4)
      const persistence = ctx.get?.('sessionPersistence')
      if (!ctx.sessions.get(id) && typeof persistence?.open === 'function') {
        const handle = await persistence.open(id, 'read')
        try {
          const raw = await handle.read(0)
          options.signal?.throwIfAborted()
          return completionDetails(raw.events, session, { completeFile: true })
        } finally { await handle.close() }
      }
      if (typeof ctx.sessionQuery.observeSession === 'function') {
        const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
        try {
          options.signal?.throwIfAborted()
          return completionDetails(observation.events, session, { completeFile: true })
        } finally { observation[Symbol.dispose]() }
      }
      const raw = await ctx.sessionQuery.readSession(id)
      options.signal?.throwIfAborted()
      return completionDetails(raw.events, session, { completeFile: true })
    },
    async readConversation(sessionId, cursor) {
      const raw = await ctx.sessionQuery.readSession(sessionId.slice(4))
      if (!parseDshSession(raw.session, raw.events)) throw previewError('未找到该 DSH 主会话', 404)
      return pageEvents(sessionId, raw.events, dshMessage, cursor)
    }
  }
}
