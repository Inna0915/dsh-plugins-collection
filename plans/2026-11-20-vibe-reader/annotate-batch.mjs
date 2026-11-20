// Annotate library volumes in bulk: one headless DSH turn per volume ("给《X》加注"),
// the agent follows skill vibe-reader-engraver and writes back with import keepOriginal,
// so the original text cannot change.
//
// Isolation: sessions live in a throwaway DSH_HOME (copy of the headless profile config);
// only the plugin's library points at the real library. The agent runs read-only with no
// approvals, so the import tool is its only way to write. The gateway key is read from
// ~/.dsh/.env into the children's memory and never written.
//
//   node annotate-batch.mjs <id>...            annotate these volumes
//   node annotate-batch.mjs --unannotated      every library volume tagged 小学/初中/高中 that still lacks a translation in any section
//                                              (corpus imports may carry a few inline notes, so notes alone do not mean annotated)
//   options: --jobs 3  --effort high  --keep
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createLibrary } from '../../plugins/dsh-vibe-reader/lib/store.js'
import { parseVolume } from '../../plugins/dsh-vibe-reader/lib/volume.js'
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
const library = createLibrary([{ origin: 'builtin', dir: paths.seedsDir }, { origin: 'library', dir: paths.libraryDir }])
const noteCount = (volume) => volume.sections.reduce((sum, section) => sum + section.notes.length, 0)

async function pick() {
  const snapshot = await library.scan()
  if (argv.includes('--unannotated')) {
    return [...snapshot.volumes.values()].filter((volume) => volume.origin === 'library' && !volume.errors.length &&
      (volume.tags || []).some((tag) => ['小学', '初中', '高中'].includes(tag)) && !volume.sections.every((section) => section.translation))
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

const runId = 'vr-annotate-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const runDir = join(here, '.task-tmp', runId)
const fakeHome = join(tmpdir(), runId + '-dsh-home')
mkdirSync(runDir, { recursive: true })
for (const file of ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml']) {
  const from = join(REAL_HOME, 'profiles', 'headless', file)
  if (existsSync(from)) cpSync(from, join(fakeHome, 'profiles', 'headless', file))
}
const env = { ...process.env, ...readEnvFile(join(REAL_HOME, '.env')), DSH_HOME: fakeHome }
const children = new Set()

function annotate(volume) {
  const dir = join(runDir, volume.id)
  mkdirSync(dir, { recursive: true })
  const overlay = join(dir, 'overlay.patch.json')
  writeFileSync(overlay, JSON.stringify([
    { insert: [{ id: 'vibe-reader', name: pathToFileURL(plugin).href, config: { libraryRoot: paths.libraryDir } }] },
    { id: 'agent-default-model', config: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: dir } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { defaultPreset: 'read-only', presets: { 'read-only': { sandbox: 'read-only', approval: 'never' } } } }
  ]))
  const prompt = `给闲庭书卷《${volume.title}》（id：${volume.id}）加注：改节标题，补脉络、注释、译文、名句和配色。原文以书库里那一卷为准，用 import 的 keepOriginal 写回，不要改动正文。\n`
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
      const imports = [...text.matchAll(/"tool":"vibe_reader","input":\{"action":"import"/g)].length
      resolve({ id: volume.id, title: volume.title, code, timedOut, imports, seconds: Math.round((Date.now() - started) / 1000) })
    })
  })
}

async function check(result, before) {
  const after = parseVolume(readFileSync(before.path, 'utf8'))
  const translated = after.sections.every((section) => section.translation)
  return {
    ...result,
    ok: after.integrity === 'ok' && after.actualFingerprint === before.actualFingerprint && noteCount(after) > 0 && translated,
    notes: noteCount(after),
    sections: after.sections.length,
    translated,
    color: after.color || '',
    sameOriginal: after.actualFingerprint === before.actualFingerprint,
    verified: after.verified
  }
}

const results = []
try {
  const volumes = (await pick()).filter((volume) => {
    if (volume.missing) results.push({ id: volume.id, ok: false, reason: '书库里没有这一卷' })
    return !volume.missing
  })
  console.log(`待加注 ${volumes.length} 卷，并发 ${JOBS}，模型 ${MODEL} · ${EFFORT}`)
  const queue = [...volumes]
  async function worker() {
    while (queue.length) {
      const volume = queue.shift()
      const result = await check(await annotate(volume), volume)
      results.push(result)
      writeFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 2))
      console.log(`${result.ok ? '✓' : '✗'} ${result.title}  ${result.notes} 注 · ${result.sections} 节 · ${result.translated ? '有译文' : '缺译文'}${result.color ? ' · ' + result.color : ''} · ${result.seconds}s${result.timedOut ? ' · 超时' : ''}${result.sameOriginal ? '' : ' · 原文指纹变了！'}  [${results.length}/${volumes.length}]`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, volumes.length) }, worker))
} finally {
  for (const child of children) killTree(child.pid)
  rmSync(fakeHome, { recursive: true, force: true })
  console.log(`完成：成功 ${results.filter((r) => r.ok).length}，失败 ${results.filter((r) => !r.ok).length}。记录：${join(runDir, 'results.json')}`)
  if (!keep && results.every((r) => r.ok)) rmSync(runDir, { recursive: true, force: true })
}
