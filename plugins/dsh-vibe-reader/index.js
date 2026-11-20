/**
 * 闲庭 · Vibe Reader 宿主端（M1 阅读器 + M2 入藏；书童 M4 才接 ctx.llm）。
 *
 * - GET  api/vibe-reader/library  书卷列表、偶遇卡片、state、书库目录
 * - POST api/vibe-reader/volume   { id } → 整卷（含各节原文、注释、译文）
 * - POST api/vibe-reader/state    { op, ... } → 新的 state（进度、背诵等级、出卡记录、设置）
 * - 工具 vibe_reader 与 skill vibe-reader-engraver（刻书匠，M2）：清洗、逐字校验原文后入藏
 *
 * 书卷只读：内置 seeds/ 与书库目录（默认 ~/.dsh/vibe-reader/library/）合并，同 id 以书库为准。
 * 面板只写 ~/.dsh/vibe-reader/state.json；书卷只由 vibe_reader import 在校验通过后写入书库目录。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCorpus } from './lib/corpus.js'
import { createLibrary, createStateStore, OpError, resolverFor } from './lib/store.js'
import { createToolService, TOOL_NAME, toolDescription, toolParameters } from './lib/tool.js'

export const name = 'vibe-reader'
export const inject = []

const MAX_BODY = 8000
const SEEDS = fileURLToPath(new URL('./seeds/', import.meta.url))
const SKILL_FILE = fileURLToPath(new URL('./skills/vibe-reader-engraver/SKILL.md', import.meta.url))

export async function bundledSkill() {
  const content = await readFile(SKILL_FILE, 'utf8')
  return {
    name: 'vibe-reader-engraver',
    description: /^description:\s*(.+)\s*$/m.exec(content)?.[1] || '刻书匠',
    content,
    path: SKILL_FILE,
    source: 'runtime',
    provider: 'dsh-vibe-reader'
  }
}

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
    corpusDir: join(dataDir, 'cache', 'corpus'),
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
  const library = createLibrary([
    { origin: 'builtin', dir: paths.seedsDir },
    { origin: 'library', dir: paths.libraryDir }
  ])
  const handlers = createHandlers({ library, state: createStateStore(paths.stateFile) })
  const routes = [
    ['/api/vibe-reader/library', ['GET'], handlers.library],
    ['/api/vibe-reader/volume', ['POST'], handlers.volume],
    ['/api/vibe-reader/state', ['POST'], handlers.state]
  ]
  // Optional services: the panel needs HTTP; the tool and skill work without it (e.g. headless).
  const withConnection = (callback) => (ctx.inject ? ctx.inject(['connection'], callback) : callback(ctx))
  withConnection((httpCtx) => {
    for (const [path, methods, fetch] of routes) {
      httpCtx.effect(() => httpCtx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }), 'vibe-reader: ' + path)
    }
  })

  // Optional: the 刻书匠 tool and skill. The tool is visible in every session, so its description stays short.
  const ctextKey = (typeof config?.ctextApiKey === 'string' && config.ctextApiKey.trim()) || process.env.CTEXT_API_KEY || ''
  const corpus = createCorpus({ cacheDir: paths.corpusDir, ctextKey })
  const tool = createToolService({ library, libraryDir: paths.libraryDir, corpus })
  ctx.inject?.(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: TOOL_NAME,
      description: toolDescription,
      parameters: toolParameters,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args) => tool.execute(args)
    })
  })
  ctx.inject?.(['skills'], async (skillCtx) => {
    skillCtx.skills.register(await bundledSkill())
  })
}
