const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i
const EXTERNAL_ID = /^(dsh|kimi|kimi-cli|claude|agy):[A-Za-z0-9_-]{1,100}$/

export function validSessionId(value) {
  return typeof value === 'string' && (CODEX_ID.test(value) || EXTERNAL_ID.test(value))
}

export function sessionProvider(sessionId) {
  if (CODEX_ID.test(sessionId || '')) return 'codex'
  const prefix = EXTERNAL_ID.exec(sessionId || '')?.[1]
  return prefix === 'kimi-cli' ? 'kimi' : prefix || null
}

export const PROVIDER_LABELS = Object.freeze({ codex: 'Codex', dsh: 'DSH', kimi: 'Kimi', claude: 'Claude', agy: 'Antigravity' })

export function iso(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = typeof value === 'number' ? value : Number.NaN
  const date = new Date(Number.isFinite(numeric) ? (numeric < 100000000000 ? numeric * 1000 : numeric) : value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function text(value, limit = 240) {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ').slice(0, limit)
  if (Array.isArray(value)) return text(value.filter((part) => part?.type === 'text').map((part) => part.text || '').join(' '), limit)
  return ''
}
