import { createSessionSource as createCodexSource } from './session-source.js'
import { createCodeSource } from './kimi-source.js'
import { createDshSource } from './dsh-source.js'
import { createClaudeSource } from './claude-source.js'
import { createAgySource } from './agy-source.js'
import { sessionProvider, validSessionId, PROVIDER_LABELS } from './session-common.js'
import { previewError } from './conversation.js'
import { performance } from 'node:perf_hooks'

export const defaults = Object.freeze({ days: null, limit: 120 })

export function createSessionSource(options = {}) {
  const providers = {
    codex: options.codexSource || createCodexSource(options.codex),
    dsh: options.dshSource || null,
    kimi: options.kimiSource || createCodeSource(options.kimi),
    claude: options.claudeSource || createClaudeSource(options.claude),
    agy: options.agySource || createAgySource(options.agy)
  }
  const perProviderLimit = options.perProviderLimit || 30
  const previous = new Map()
  let health = Object.fromEntries(Object.keys(providers).map((key) => [key, { status: 'loading', count: 0, errors: [] }]))
  let pending = null

  function degradedRows(key, rows, reason) {
    return rows.map((row) => ({ ...row, status: 'unknown', statusUncertain: false, lifecycleEvent: null, observedAt: null,
      statusSource: 'source-unavailable', statusReason: `${PROVIDER_LABELS[key]} 会话源暂时不可用：${reason}` }))
  }

  async function readProvider(key) {
    const started = performance.now()
    const source = providers[key]
    if (!source) {
      health[key] = { status: 'unavailable', count: 0, errors: ['宿主会话服务尚未连接'] }
      return degradedRows(key, previous.get(key) || [], '等待服务恢复')
    }
    try {
      const result = source.queryAll ? await source.queryAll() : (await source.queryDefault()).sessions
      // A provider removed during the read must not republish its old observations.
      if (providers[key] !== source) return []
      const rows = result.filter((row) => validSessionId(row.sessionId) && sessionProvider(row.sessionId) === key)
        .map((row) => ({ ...row, provider: key, nativeSessionId: row.nativeSessionId || (key === 'codex' ? row.sessionId : row.sessionId.slice(row.sessionId.indexOf(':') + 1)) }))
      const sourceHealth = source.health?.() || { status: rows.length ? 'ok' : 'empty', count: rows.length, errors: [] }
      health[key] = { ...sourceHealth, count: rows.length, durationMs: Math.round(performance.now() - started) }
      if (sourceHealth.status === 'degraded') {
        const present = new Set(rows.map((row) => row.sessionId))
        rows.push(...degradedRows(key, (previous.get(key) || []).filter((row) => !present.has(row.sessionId)), '部分会话读取失败'))
      }
      previous.set(key, rows)
      return rows
    } catch {
      health[key] = { status: 'degraded', count: 0, durationMs: Math.round(performance.now() - started), errors: [`${PROVIDER_LABELS[key]} 会话源读取失败`] }
      return degradedRows(key, previous.get(key) || [], '读取失败，保留上次会话供确认')
    }
  }

  function selected(sessionId) {
    if (!validSessionId(sessionId)) throw previewError('会话 ID 格式无效')
    const key = sessionProvider(sessionId)
    if (!providers[key]) throw previewError(`${PROVIDER_LABELS[key]} 会话服务暂不可用`, 503)
    return providers[key]
  }

  return {
    setDshContext(ctx) { providers.dsh = ctx ? createDshSource(ctx) : null; health.dsh = { status: ctx ? 'loading' : 'unavailable', count: 0, errors: [] } },
    health: () => structuredClone(health),
    queryDefault() {
      if (pending) return pending
      pending = (async () => {
        const groups = await Promise.all(Object.keys(providers).map(readProvider))
        const sessions = groups.flatMap((rows) => {
          const sorted = rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
          const selected = new Map(sorted.slice(0, perProviderLimit).map((row) => [row.sessionId, row]))
          for (const row of sorted) if (row.status === 'running') selected.set(row.sessionId, row)
          return [...selected.values()]
        }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        return { sessions, queriedAt: new Date().toISOString(), window: { ...defaults, perProviderLimit } }
      })().finally(() => { pending = null })
      return pending
    },
    async querySession(sessionId) {
      const source = selected(sessionId)
      const row = await source.querySession(sessionId)
      return row ? { ...row, provider: sessionProvider(sessionId) } : null
    },
    readConversation: (sessionId, cursor) => selected(sessionId).readConversation(sessionId, cursor),
    readCompletion: (session, options) => selected(session.sessionId).readCompletion?.(session, options)
  }
}
