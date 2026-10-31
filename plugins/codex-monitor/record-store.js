import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function defaultFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'codex-monitor', 'running-history.json')
}

function normalizeDocument(value) {
  const rows = Array.isArray(value?.sessions) ? value.sessions : []
  const sessions = new Map()
  for (const row of rows) {
    const sessionId = typeof row?.sessionId === 'string' ? row.sessionId.trim() : ''
    if (!sessionId || sessions.has(sessionId)) continue
    const recordedAt = typeof row.recordedAt === 'string' ? row.recordedAt.trim() : ''
    if (!recordedAt) continue
    sessions.set(sessionId, recordedAt)
  }
  const dismissedRuns = new Map()
  for (const row of Array.isArray(value?.dismissedRuns) ? value.dismissedRuns : []) {
    if (typeof row?.sessionId === 'string' && typeof row.observedAt === 'string' && row.observedAt) {
      dismissedRuns.set(row.sessionId, row.observedAt)
    }
  }
  return { sessions, dismissedRuns }
}

async function readDocument(file) {
  try {
    const raw = await readFile(file, 'utf8')
    if (!raw.trim()) return normalizeDocument({})
    return normalizeDocument(JSON.parse(raw))
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeDocument({})
    if (error instanceof SyntaxError) throw new Error('运行记录文件不是合法 JSON')
    throw error
  }
}

async function writeAtomic(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}-${process.hrtime.bigint()}.tmp`
  const document = {
    version: 1,
    sessions: [...state.sessions].map(([sessionId, recordedAt]) => ({ sessionId, recordedAt })),
    ...(state.dismissedRuns.size ? { dismissedRuns: [...state.dismissedRuns].map(([sessionId, observedAt]) => ({ sessionId, observedAt })) } : {})
  }
  await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  try {
    await rename(temp, file)
  } catch {
    await copyFile(temp, file)
    await unlink(temp).catch(() => {})
  }
}

export function createRecordStore(options = {}) {
  const file = options.file || defaultFile()
  const now = options.now || (() => new Date().toISOString())
  let queue = Promise.resolve()

  function locked(operation) {
    const run = queue.then(operation, operation)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    file,
    list: () => locked(async () => (await readDocument(file)).sessions),
    readState: () => locked(() => readDocument(file)),
    remember: (sessionId) => locked(async () => {
      const state = await readDocument(file)
      const { sessions } = state
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, now())
        await writeAtomic(file, state)
      }
      return new Map(sessions)
    }),
    remove: (sessionId) => locked(async () => {
      const state = await readDocument(file)
      const { sessions } = state
      const removed = sessions.delete(sessionId)
      if (removed) await writeAtomic(file, state)
      return removed
    }),
    removeMany: (sessionIds) => locked(async () => {
      const state = await readDocument(file)
      const { sessions } = state
      let removed = 0
      for (const sessionId of sessionIds) {
        if (sessions.delete(sessionId)) removed += 1
      }
      if (removed > 0) await writeAtomic(file, state)
      return removed
    }),
    dismissRunning: (sessionId, observedAt) => locked(async () => {
      const state = await readDocument(file)
      state.sessions.delete(sessionId)
      state.dismissedRuns.set(sessionId, observedAt)
      await writeAtomic(file, state)
      return state.dismissedRuns
    })
  }
}
