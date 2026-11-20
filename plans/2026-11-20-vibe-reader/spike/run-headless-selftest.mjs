// Boot the DSH headless CLI with this spike inserted, let one cheap turn call the
// spike's check tool, and report whether the plugin's own ctx.llm call worked.
//
// Isolation: a throwaway DSH_HOME (copy of ~/.dsh/profiles/headless config only) so no
// test session lands in the real session list. The gateway key is read from ~/.dsh/.env
// into the child's environment in memory and never written to disk.
// Usage: node run-headless-selftest.mjs [--keep]
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const keep = process.argv.includes('--keep')
const DSH_CLI = process.env.DSH_CLI || 'C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js'
const REAL_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROVIDER = 'magpie'
const MODEL = 'workbuddy/deepseek-v4.1-flash'
const TIMEOUT_MS = 180_000

const runId = 'vr-spike-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const runDir = join(here, '.task-tmp', runId)           // ignored by the repo .gitignore
const fakeHome = join(tmpdir(), runId + '-dsh-home')    // outside the repo, removed afterwards
const overlay = join(runDir, 'overlay.patch.json')       // overlay names resolve from the profile scope, so the plugin is given as a file URL
const selfTestFile = join(runDir, 'selftest.json')
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
    { insert: [{ id: 'vibe-reader-spike', name: pathToFileURL(join(here, 'index.js')).href, config: { provider: PROVIDER, model: MODEL } }] },
    { id: 'agent-default-model', config: { provider: PROVIDER, model: MODEL, reasoningEffort: 'off' } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: runDir } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { defaultPreset: 'read-only', presets: { 'read-only': { sandbox: 'read-only', approval: 'never' } } } }
  ], null, 2))

  const secrets = readEnvFile(join(REAL_HOME, '.env'))
  const env = { ...process.env, ...secrets, DSH_HOME: fakeHome, VIBE_READER_SPIKE_SELFTEST: selfTestFile }
  child = spawn(process.execPath, [DSH_CLI, '--profile', 'headless', '--patch', overlay, '--json', '-'], {
    cwd: runDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })
  const out = []
  const err = []
  child.stdout.on('data', (data) => out.push(data))
  child.stderr.on('data', (data) => err.push(data))
  child.stdin.end('请调用工具 vibe_reader_spike_check 一次（无需参数），然后只回复：OK\n')
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, TIMEOUT_MS)
  exitCode = await new Promise((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  writeFileSync(join(runDir, 'events.jsonl'), Buffer.concat(out))
  writeFileSync(join(runDir, 'stderr.log'), Buffer.concat(err))

  const lines = Buffer.concat(out).toString('utf8').split(/\r?\n/).filter(Boolean)
  const types = {}
  let toolSeen = false
  let finalText = ''
  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      types[event.type] = (types[event.type] || 0) + 1
      if (line.includes('vibe_reader_spike_check')) toolSeen = true
      if (typeof event.text === 'string' && /final|result|completed|message/.test(event.type)) finalText = event.text
    } catch { /* non-JSON line */ }
  }
  const selfTest = existsSync(selfTestFile) ? JSON.parse(readFileSync(selfTestFile, 'utf8')) : null
  // Isolation: the spike's system prompt must not appear in any persisted session log,
  // while the turn's own model request does get logged there.
  const logs = readdirSync(fakeHome, { recursive: true }).map(String).filter((file) => /\.jsonl(\.zstd)?$/.test(file))
  const isolation = { sessionLogs: logs.length, spikePromptLogged: false, eventTypes: {} }
  for (const file of logs) {
    const raw = readFileSync(join(fakeHome, file))
    const text = (file.endsWith('.zstd') ? zstdDecompressSync(raw) : raw).toString('utf8')
    if (text.includes('私塾书童')) isolation.spikePromptLogged = true
    for (const line of text.split('\n')) {
      const type = /^\{"type":"([^"]+)"/.exec(line)?.[1]
      if (type) isolation.eventTypes[type] = (isolation.eventTypes[type] || 0) + 1
    }
  }
  console.log(JSON.stringify({
    runId, exitCode, timedOut, toolSeen, eventTypes: types, finalText: finalText.slice(0, 200),
    stderrTail: Buffer.concat(err).toString('utf8').slice(-1200),
    isolation,
    selfTest
  }, null, 2))
} finally {
  if (child && exitCode === null) killTree(child.pid)
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(overlay, { force: true })
  rmSync(join(here, '.cordis'), { recursive: true, force: true })
  if (!keep) {
    rmSync(runDir, { recursive: true, force: true })
    try { rmdirSync(dirname(runDir)) } catch { /* other runs kept */ }
  }
}
