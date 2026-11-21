// 知人论世 in bulk: one headless DSH turn per volume. The agent follows skill vibe-reader-engraver
// (author → save-author when the author is new → save-background); volume files are never touched.
//
// Isolation as in annotate-batch.mjs: sessions live in a throwaway DSH_HOME; only the plugin's
// library and download cache point at the real ones. The agent runs read-only with no approvals,
// so the vibe_reader tool is its only way to write. The gateway key is read from ~/.dsh/.env into
// the children's memory and never written.
//
//   node about-batch.mjs <id>...      these volumes
//   node about-batch.mjs --missing    every readable volume that has no background yet
//   options: --jobs 3  --effort high  --keep
// Needs Node >= 24.9 (the DSH CLI exits silently on older Node); the Desktop Electron works:
//   ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%/Programs/DeepSeek Harness/DeepSeek Harness.exe" about-batch.mjs --missing
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findAuthor, splitAuthorLabel } from '../../plugins/dsh-vibe-reader/lib/about.js'
import { createLibrary } from '../../plugins/dsh-vibe-reader/lib/store.js'
import { resolvePaths } from '../../plugins/dsh-vibe-reader/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..', '..', 'plugins', 'dsh-vibe-reader', 'index.js')
const argv = process.argv.slice(2)
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const JOBS = Number(option('--jobs', 3))
const EFFORT = option('--effort', 'high')
const keep = argv.includes('--keep')
const DSH_CLI = process.env.DSH_CLI || 'C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js'
const REAL_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROVIDER = 'magpie'
const MODEL = 'workbuddy/deepseek-v4.1-flash'
const TIMEOUT_MS = 600_000

const paths = resolvePaths({})
const cacheRoot = join(REAL_HOME, 'vibe-reader', 'cache')
const library = createLibrary([{ origin: 'builtin', dir: paths.seedsDir }, { origin: 'library', dir: paths.libraryDir }])

// Not a person: no author entry, the background tells where the text comes from instead.
const UNKNOWN_AUTHOR = /^(佚名|无名氏|不详|未详|小雅|大雅|国风|周南|召南|颂)$|诗经|乐府|民歌/
// A group: the entry keeps the group's name; facts come from its central figure.
const GROUP_AUTHORS = { 孔子及其弟子: '孔子' }

/** Every person a volume shows: per-section labels (组诗) or the volume author; unknown authors left out. */
function authorsOf(volume) {
  const labels = volume.sections.map((section) => section.meta.author).filter(Boolean)
  const list = labels.length ? labels.map((label) => splitAuthorLabel(label, volume.dynasty)) : [splitAuthorLabel(volume.author, volume.dynasty)]
  return [...new Map(list.filter((item) => item.name && !UNKNOWN_AUTHOR.test(item.name)).map((item) => [item.name, item])).values()]
}

/** How to describe the authors to the agent, special cases spelled out. */
function authorBrief(volume) {
  const people = authorsOf(volume)
  if (!people.length) return '作者不可考（佚名、诗经或民歌），不写作者文件，只写背景，并在背景里交代出处与流传'
  return '先用 author 查作者（' + people.map((item) => GROUP_AUTHORS[item.name]
    ? `「${item.name}」是群体：author 查「${GROUP_AUTHORS[item.name]}」，作者文件 name 写「${item.name}」，写清编纂者与成书`
    : `${item.dynasty} · ${item.name}`).join('、') + '），作者库里没有的写小传并 save-author，已有的不要重写'
}

async function pick() {
  const snapshot = await library.scan()
  const readable = [...snapshot.volumes.values()].filter((volume) => !volume.errors.length)
  if (argv.includes('--missing')) {
    // One volume per new author first, so each author file is written once before parallel runs reuse it.
    const missing = readable.filter((volume) => !snapshot.backgrounds[volume.id])
    const seen = new Set(snapshot.authors.map((author) => author.name))
    const first = []
    const rest = []
    for (const volume of missing) {
      const fresh = authorsOf(volume).some((item) => !seen.has(item.name))
      for (const item of authorsOf(volume)) seen.add(item.name)
      ;(fresh ? first : rest).push(volume)
    }
    return { volumes: [...first, ...rest], phase: first.length }
  }
  const ids = argv.filter((arg, index) => !arg.startsWith('--') && !argv[index - 1]?.startsWith('--'))
  return ids.map((id) => snapshot.volumes.get(id) || { id, missing: true })
}

function readEnvFile(file) {
  const env = {}
  if (!existsSync(file)) return env
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return env
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
}

const runId = 'vr-about-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const runDir = join(here, '.task-tmp', runId)
const fakeHome = join(tmpdir(), runId + '-dsh-home')
mkdirSync(runDir, { recursive: true })
for (const file of ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml']) {
  const from = join(REAL_HOME, 'profiles', 'headless', file)
  if (existsSync(from)) cpSync(from, join(fakeHome, 'profiles', 'headless', file))
}
const env = { ...process.env, ...readEnvFile(join(REAL_HOME, '.env')), DSH_HOME: fakeHome }
const children = new Set()

function run(volume) {
  const dir = join(runDir, volume.id)
  mkdirSync(dir, { recursive: true })
  const overlay = join(dir, 'overlay.patch.json')
  writeFileSync(overlay, JSON.stringify([
    { insert: [{ id: 'vibe-reader', name: pathToFileURL(plugin).href, config: { libraryRoot: paths.libraryDir, cacheRoot } }] },
    { id: 'agent-default-model', config: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: dir } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { defaultPreset: 'read-only', presets: { 'read-only': { sandbox: 'read-only', approval: 'never' } } } }
  ]))
  const prompt = `给闲庭书卷《${volume.title}》（id：${volume.id}）补知人论世：${authorBrief(volume)}；再写写作背景并 save-background${volume.sections.length > 1 && authorsOf(volume).length > 1 ? '（多首成卷，按节写各首背景）' : ''}。可以用 read 看书卷内容，但不要改动书卷本身。\n`
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [DSH_CLI, '--profile', 'headless', '--patch', overlay, '--json', '-'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.add(child)
    const out = []
    const err = []
    child.stdout.on('data', (data) => out.push(data))
    child.stderr.on('data', (data) => err.push(data))
    child.stdin.end(prompt)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      children.delete(child)
      writeFileSync(join(dir, 'events.jsonl'), Buffer.concat(out))
      writeFileSync(join(dir, 'stderr.log'), Buffer.concat(err))
      const text = Buffer.concat(out).toString('utf8')
      const calls = [...text.matchAll(/"tool":"vibe_reader","input":\{"action":"([\w-]+)"/g)].map((match) => match[1])
      resolve({ id: volume.id, title: volume.title, code, timedOut, calls, seconds: Math.round((Date.now() - started) / 1000) })
    })
  })
}

async function check(result, volume) {
  const snapshot = await library.scan()
  const background = snapshot.backgrounds[volume.id]
  const authors = authorsOf(volume).map((item) => ({ ...item, entry: findAuthor(snapshot.authors, item.name, item.dynasty) }))
  const backgroundOk = Boolean(background && !background.errors.length)
  return {
    ...result,
    ok: backgroundOk && authors.every((item) => item.entry),
    background: backgroundOk ? Array.from(background.text.join('')).length + Object.values(background.sections).reduce((sum, block) => sum + Array.from(block.text.join('')).length, 0) : 0,
    backgroundErrors: background?.errors || ['没有背景文件'],
    authors: authors.map((item) => `${item.name}${item.entry ? '' : '（缺）'}`)
  }
}

const results = []
try {
  const picked = await pick()
  const all = Array.isArray(picked) ? picked : picked.volumes
  const volumes = all.filter((volume) => {
    if (volume.missing) results.push({ id: volume.id, ok: false, reason: '书库里没有这一卷' })
    return !volume.missing
  })
  // --missing: phase 1 (a new author each) finishes before phase 2 starts.
  const phases = Array.isArray(picked) ? [volumes] : [volumes.slice(0, picked.phase), volumes.slice(picked.phase)].filter((list) => list.length)
  console.log(`待补知人论世 ${volumes.length} 卷${phases.length > 1 ? `（先 ${phases[0].length} 卷建作者库）` : ''}，并发 ${JOBS}，模型 ${MODEL} · ${EFFORT}`)
  for (const phase of phases) {
    const queue = [...phase]
    async function worker() {
      while (queue.length) {
        const volume = queue.shift()
        const result = await check(await run(volume), volume)
        results.push(result)
        writeFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 2))
        console.log(`${result.ok ? '✓' : '✗'} ${result.title}  背景 ${result.background} 字 · 作者 ${result.authors.join('、')} · ${result.calls.join('→')} · ${result.seconds}s${result.timedOut ? ' · 超时' : ''}  [${results.length}/${volumes.length}]`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(JOBS, phase.length) }, worker))
  }
} finally {
  for (const child of children) killTree(child.pid)
  rmSync(fakeHome, { recursive: true, force: true })
  console.log(`完成：成功 ${results.filter((r) => r.ok).length}，失败 ${results.filter((r) => !r.ok).length}。记录：${join(runDir, 'results.json')}`)
  if (!keep && results.every((r) => r.ok)) rmSync(runDir, { recursive: true, force: true })
}
