// M2 end-to-end check: boot the DSH headless CLI with dsh-vibe-reader inserted and
// ask one agent turn to 入藏 a short poem through skill vibe-reader-engraver + tool vibe_reader.
//
// Isolation (same as spike/run-headless-selftest.mjs): a throwaway DSH_HOME with a copy of
// the headless profile config only; the gateway key is read from ~/.dsh/.env into the
// child's environment in memory and never written. Nothing lands in the real library.
// Usage: node m2-headless-import.mjs [--scenario paste|search] [--keep]
//   paste  (default) the prompt carries the full original text
//   search the prompt only names the work; the agent must find it in the corpus
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseVolume } from '../../plugins/dsh-vibe-reader/lib/volume.js'
import { createCorpus } from '../../plugins/dsh-vibe-reader/lib/corpus.js'
import { colorOf } from '../../plugins/dsh-vibe-reader/lib/palette.js'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..', '..', 'plugins', 'dsh-vibe-reader', 'index.js')
const keep = process.argv.includes('--keep')
const scenario = process.argv.includes('--scenario') ? process.argv[process.argv.indexOf('--scenario') + 1] : 'paste'
const DSH_CLI = process.env.DSH_CLI || 'C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js'
const REAL_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROVIDER = 'magpie'
const MODEL = 'workbuddy/deepseek-v4.1-flash'
const TIMEOUT_MS = 300_000
const ORIGINAL = '朝辞白帝彩云间，千里江陵一日还。\n两岸猿声啼不住，轻舟已过万重山。'
const SCENARIOS = {
  paste: {
    id: 'zaofa-baidicheng',
    prompt: `请用 skill vibe-reader-engraver（刻书匠）把下面这首诗入藏闲庭，书卷 id 用 zaofa-baidicheng。原文我已经核对过。作者：唐 · 李白，题目：早发白帝城。

原文：
${ORIGINAL}
`,
    expected: async () => ORIGINAL
  },
  search: {
    id: 'loushi-ming',
    prompt: '用刻书匠把刘禹锡的《陋室铭》入藏闲庭，书卷 id 用 loushi-ming。\n',
    // The agent's copy must equal what the corpus yields for this work.
    expected: async (home) => (await createCorpus({ cacheDir: join(home, 'vibe-reader', 'cache', 'corpus') }).draft({ refs: ['guwenguanzhi:116'], id: 'loushi-ming' })).original
  }
}
const run = SCENARIOS[scenario]
if (!run) throw new Error('scenario 只能是 paste 或 search')
const PROMPT = run.prompt

const runId = 'vr-m2-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const runDir = join(here, '.task-tmp', runId)
const fakeHome = join(tmpdir(), runId + '-dsh-home')
const overlay = join(runDir, 'overlay.patch.json')
mkdirSync(runDir, { recursive: true })

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

let child
let exitCode = null
let timedOut = false
try {
  for (const file of ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml']) {
    const from = join(REAL_HOME, 'profiles', 'headless', file)
    if (existsSync(from)) cpSync(from, join(fakeHome, 'profiles', 'headless', file))
  }
  writeFileSync(overlay, JSON.stringify([
    { insert: [{ id: 'vibe-reader', name: pathToFileURL(plugin).href, config: {} }] },
    { id: 'agent-default-model', config: { provider: PROVIDER, model: MODEL, reasoningEffort: 'off' } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: runDir } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { defaultPreset: 'read-only', presets: { 'read-only': { sandbox: 'read-only', approval: 'never' } } } }
  ], null, 2))

  const env = { ...process.env, ...readEnvFile(join(REAL_HOME, '.env')), DSH_HOME: fakeHome }
  child = spawn(process.execPath, [DSH_CLI, '--profile', 'headless', '--patch', overlay, '--json', '-'], {
    cwd: runDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })
  const out = []
  const err = []
  child.stdout.on('data', (data) => out.push(data))
  child.stderr.on('data', (data) => err.push(data))
  child.stdin.end(PROMPT)
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, TIMEOUT_MS)
  exitCode = await new Promise((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  writeFileSync(join(runDir, 'events.jsonl'), Buffer.concat(out))
  writeFileSync(join(runDir, 'stderr.log'), Buffer.concat(err))

  const text = Buffer.concat(out).toString('utf8')
  const toolCalls = [...text.matchAll(/"tool":"vibe_reader","input":\{"action":"(\w+)"/g)].map((match) => match[1])
  const skillMentioned = text.includes('vibe-reader-engraver')
  const libraryDir = join(fakeHome, 'vibe-reader', 'library')
  const files = existsSync(libraryDir) ? readdirSync(libraryDir) : []
  let volume = null
  if (files.includes(run.id + '.md')) {
    const markdown = readFileSync(join(libraryDir, run.id + '.md'), 'utf8')
    writeFileSync(join(runDir, run.id + '.md'), markdown)
    const expected = await run.expected(fakeHome)
    const parsed = parseVolume(markdown)
    volume = {
      errors: parsed.errors,
      warnings: parsed.warnings,
      integrity: parsed.integrity,
      verified: parsed.verified,
      source: parsed.source,
      color: parsed.color ? `${parsed.color} ${colorOf(parsed.color)?.hex || '不在色表'}` : null,
      recitable: parsed.recitable,
      sections: parsed.sections.map((section) => ({ id: section.id, title: section.title, meta: section.meta, notes: section.notes.length, quotes: section.paragraphs.flatMap((p) => p.quotes.map((q) => q.text)), translation: Boolean(section.translation) })),
      originalExact: parsed.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join('').replace(/\s/g, '') === expected.replace(/\s/g, '')
    }
  }
  const finals = text.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const lastText = [...finals].reverse().find((event) => typeof event.text === 'string')?.text || ''
  console.log(JSON.stringify({ runId, scenario, exitCode, timedOut, toolCalls, skillMentioned, files, volume, lastText: lastText.slice(0, 400), stderrTail: Buffer.concat(err).toString('utf8').slice(-800) }, null, 2))
} finally {
  if (child && exitCode === null) killTree(child.pid)
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(overlay, { force: true })
  if (!keep) {
    rmSync(runDir, { recursive: true, force: true })
    try { rmdirSync(dirname(runDir)) } catch { /* other runs kept */ }
  }
}
