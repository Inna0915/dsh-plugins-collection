/**
 * 闲庭 · Vibe Reader 宿主端（M1：阅读器，不接 AI）。
 *
 * - GET  api/vibe-reader/library  书卷列表、偶遇卡片、state、书库目录
 * - POST api/vibe-reader/volume   { id } → 整卷（含各节原文、注释、译文）
 * - POST api/vibe-reader/state    { op, ... } → 新的 state（进度、背诵等级、出卡记录、设置）
 *
 * 书卷只读：内置 seeds/ 与书库目录（默认 ~/.dsh/vibe-reader/library/）合并，同 id 以书库为准。
 * 只写 ~/.dsh/vibe-reader/state.json。
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLibrary, createStateStore, OpError, resolverFor } from './lib/store.js'

export const name = 'vibe-reader'
export const inject = ['connection']

const MAX_BODY = 8000
const SEEDS = fileURLToPath(new URL('./seeds/', import.meta.url))

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

async function readJson(request) {
  const body = await request.text()
  if (body.length > MAX_BODY) return { error: json({ error: '请求过大' }, 413) }
  try {
    const value = JSON.parse(body || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: json({ error: '请求格式无效' }, 400) }
  } catch {
    return { error: json({ error: '请求格式无效' }, 400) }
  }
}

export function resolvePaths(config = {}, env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = join(home, 'vibe-reader')
  const custom = typeof config.libraryRoot === 'string' && config.libraryRoot.trim()
  return {
    stateFile: join(dataDir, 'state.json'),
    libraryDir: custom && isAbsolute(custom.trim()) ? custom.trim() : join(dataDir, 'library'),
    seedsDir: SEEDS
  }
}

/** Route handlers, separated from ctx for tests. */
export function createHandlers({ library, state, log = console }) {
  async function guard(task) {
    try {
      return await task()
    } catch (error) {
      if (error instanceof OpError) return json({ error: error.message }, 400)
      log.warn?.('[vibe-reader]', error)
      return json({ error: '读取或保存书库数据失败，请检查本机文件' }, 500)
    }
  }

  return {
    library: () => guard(async () => {
      const [snapshot, current] = await Promise.all([library.scan(), state.read()])
      return json({ roots: snapshot.roots, volumes: snapshot.list, cards: snapshot.cards, state: current, recovered: state.recovered() })
    }),
    volume: (request) => guard(async () => {
      const { value, error } = await readJson(request)
      if (error) return error
      const snapshot = await library.scan()
      const volume = typeof value.id === 'string' ? snapshot.volumes.get(value.id) : undefined
      if (!volume) return json({ error: '没有这一卷' }, 404)
      return json({ volume })
    }),
    state: (request) => guard(async () => {
      const { value, error } = await readJson(request)
      if (error) return error
      const snapshot = await library.scan()
      return json({ state: await state.update(value, resolverFor(snapshot)) })
    })
  }
}

export function apply(ctx, config) {
  const paths = resolvePaths(config)
  const handlers = createHandlers({
    library: createLibrary([
      { origin: 'builtin', dir: paths.seedsDir },
      { origin: 'library', dir: paths.libraryDir }
    ]),
    state: createStateStore(paths.stateFile)
  })
  const routes = [
    ['/api/vibe-reader/library', ['GET'], handlers.library],
    ['/api/vibe-reader/volume', ['POST'], handlers.volume],
    ['/api/vibe-reader/state', ['POST'], handlers.state]
  ]
  for (const [path, methods, fetch] of routes) {
    ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }), 'vibe-reader: ' + path)
  }
}
