import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validSessionId, sessionProvider, PROVIDER_LABELS } from './session-common.js'

const COMPLETED_EVENTS = new Set(['task_complete', 'turn_completed', 'turn/completed'])
const STARTED_EVENTS = new Set(['task_started', 'turn_started', 'turn/started'])

function cleanText(value, limit) {
  return Array.from(String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, limit).join('')
}

function cleanError(error) {
  return cleanText(error instanceof Error ? error.message : error, 500)
    .replace(/([A-Z]:\\[^\s"']+)/gi, '[local path]').slice(0, 240)
}

function completionSummary(session, details = {}) {
  const provider = PROVIDER_LABELS[sessionProvider(session.sessionId)] || 'Codex'
  const source = { app: 'Codex App', codex_app: 'Codex App', 'codex-app': 'Codex App', vscode: 'VS Code', cli: 'CLI', dsh: 'DSH', 'kimi-vscode': 'Kimi · VS Code', 'kimi-cli': 'Kimi · CLI', 'kimi-desktop': 'Kimi · Desktop', 'kimi-unknown': 'Kimi', 'claude-vscode': 'Claude · VS Code', 'claude-cli': 'Claude · CLI', claude: 'Claude' }[String(session.source || '').toLowerCase()] || cleanText(session.source, 40) || provider
  const duration = typeof details.durationMs === 'number' && details.durationMs >= 0 ? formatDuration(details.durationMs) : '未记录'
  const model = cleanText(details.model || session.model, 160) || '未记录'
  const effort = cleanText(details.reasoningEffort || session.reasoningEffort, 40) || '未记录'
  const turnTokens = typeof details.turnTokens === 'number' && details.turnTokens >= 0 ? details.turnTokens : null
  const cumulative = typeof session.tokensUsed === 'number' && session.tokensUsed >= 0 ? session.tokensUsed : null
  const count = turnTokens ?? cumulative
  const tokens = count === null ? '未记录' : `约 ${Math.round(count).toLocaleString('en-US')}（${turnTokens === null ? '会话累计，非本轮' : '本轮'}）`
  return { provider, source, duration, model, effort, tokens, title: cleanText(session.title, 160) || '未命名会话' }
}

function formatDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60)
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', `${seconds % 60} 秒`].filter(Boolean).join(' ')
}

function markdownText(value) { return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&') }

export function startedNotification(session) {
  const summary = completionSummary(session)
  const metadata = [summary.source, cleanText(session.model, 160), cleanText(session.reasoningEffort, 40)].filter(Boolean)
  return {
    title: `${summary.provider} 开始执行`,
    body: `${summary.title}\n${metadata.join(' · ')}`,
    markdown: `**${summary.provider} 开始执行**\n\n${markdownText(summary.title)}\n\n${metadata.map(markdownText).join(' · ')}`
  }
}

export function completionToast(session, details = {}) {
  const summary = completionSummary(session, details)
  const reply = cleanText(details.finalReply, 140)
  return {
    title: `${summary.provider} 轮次已完成`,
    body: `${summary.title}\n${summary.source} · ${summary.duration}\n${summary.model} · ${summary.effort} · Token ${summary.tokens}\n${reply || '请打开会话看板查看最终回复'}`,
    tag: createHash('sha256').update(`${session.sessionId}:${session.observedAt}`).digest('hex').slice(0, 16)
  }
}

export function completionMarkdown(session, details = {}) {
  const summary = completionSummary(session, details)
  let reply = String(details.finalReply || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  if (details.replyTruncated) {
    // Close a cut code fence so the truncation notice remains readable.
    let fence = null
    for (const line of reply.split('\n')) {
      const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (!match) continue
      if (!fence) fence = match[1]
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null
    }
    if (fence) reply += `\n${fence}`
    reply += '\n\n（回复过长，仅展示前 24,000 字符；完整内容请查看会话。）'
  }
  const answer = reply || '未读取到本轮最终回复，请打开会话查看。'
  const answerLength = Array.from(answer).length
  // IM 适配层把这对标记渲染成默认收起的折叠块（dsh-im 的 Telegram 通道会还原为
  // <details>），未识别标记的渠道只会把它当普通文字。空行必须保留：紧贴上面的
  // 列表项时，折叠块会被并入列表，Telegram 侧整条消息解析失败。
  return [
    `## ${summary.provider} 轮次已完成`, '', `**${markdownText(summary.title)}**`, '',
    `- 来源：${markdownText(summary.source)}`,
    `- 执行时长：${summary.duration}`,
    `- 执行模型：${markdownText(summary.model)}`,
    `- 思考强度：${markdownText(summary.effort)}`,
    `- Token：${summary.tokens}`, '',
    // summary 是静态文本：展开后无法改成“收起”，客户端自带箭头提示，
    // 所以这里只写字数，不写“点击展开”。
    `⟦details:最终回复（约 ${answerLength} 字）⟧`, '',
    answer, '',
    '⟦/details⟧'
  ].join('\n')
}

function terminateOwnedProcess(child) {
  if (!child.pid) {
    child.kill()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 5000
    })
    killer.once('error', () => { child.kill() })
    killer.once('close', (code) => {
      if (code !== 0) child.kill()
      resolve()
    })
  })
}

export function sendWindowsToast(payload, options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') return Promise.reject(new Error('完成通知仅支持 Windows'))
  const signal = options.signal
  if (signal?.aborted) return Promise.reject(new Error('通知已取消'))
  const launch = options.spawn || spawn
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    // WinRT runs in this helper; terminate only its owned process tree on cancellation.
    const child = launch(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./windows-toast.ps1', import.meta.url))], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let failure = null
    let stderr = ''
    let stdout = ''
    let stopping = null
    const stop = (reason) => {
      failure ||= new Error(reason)
      stopping ||= terminateOwnedProcess(child)
    }
    const abort = () => {
      stop('通知已取消')
    }
    const timeout = setTimeout(() => {
      stop('Windows 通知发送超时')
    }, options.timeoutMs ?? 10_000)
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(0, 1024) })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 2048) })
    child.stdin.on('error', (error) => { failure ||= error })
    child.on('error', (error) => { failure = error })
    child.once('close', async (code) => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (stopping) await stopping
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(stderr || `Windows 通知发送失败 (${code})`))
      try {
        if (JSON.parse(stdout).accepted !== true) throw new Error('Windows 未确认接收通知')
        resolve({ accepted: true })
      } catch (error) {
        reject(error)
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdin.end(JSON.stringify(payload))
  })
}

async function readHistory(file, timeField = 'completedAt') {
  try {
    const document = JSON.parse(await readFile(file, 'utf8'))
    if (document.version !== 1 || !Array.isArray(document.sessions)) throw new Error('通知去重记录格式无效')
    return new Map(document.sessions
      .filter((row) => validSessionId(row?.sessionId) && Number.isFinite(Date.parse(row[timeField])))
      .map((row) => [row.sessionId, Date.parse(row[timeField])]))
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
}

async function saveHistory(file, history, timeField = 'completedAt') {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}-${process.hrtime.bigint()}.tmp`
  const sessions = [...history].sort((left, right) => right[1] - left[1]).slice(0, 1000)
    .map(([sessionId, eventAt]) => ({ sessionId, [timeField]: new Date(eventAt).toISOString() }))
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, sessions }) + '\n', { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error })
  }
}

export function createCompletionNotifications(options = {}) {
  const supported = options.supported ?? (options.platform || process.platform) === 'win32'
  const enabled = supported && (options.enabled ?? process.env.CODEX_MONITOR_NOTIFICATIONS !== '0')
  const startedAt = Date.parse(options.startedAt || new Date().toISOString())
  const file = options.file || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'codex-monitor', 'notification-history.json')
  const sender = options.send || sendWindowsToast
  const controller = new AbortController()
  const pending = new Set()
  const handled = new Map()
  const startedHandled = new Map()
  let queue = Promise.resolve()
  let disposed = false
  let lastSentAt = null
  let lastError = null

  function report(error) {
    if (disposed) return
    const message = cleanError(error)
    if (message !== lastError) options.logger?.warn?.(`[codex-monitor] ${options.channelName || 'Windows'} 通知：${message}`)
    lastError = message
  }

  async function send(payload) {
    if (disposed) throw new Error('通知已取消')
    await sender(payload, { signal: controller.signal })
    lastSentAt = new Date().toISOString()
    lastError = null
  }

  function observe(session) {
    if (!enabled || disposed) return
    // Start delivery is opt-in for IM. Use a stable turn start when a source's
    // observedAt tracks finer events such as prompt acceptance or permission waits.
    const isStart = Boolean(options.startFile) && session.status === 'running'
      && session.statusUncertain !== true && STARTED_EVENTS.has(session.lifecycleEvent)
    const isComplete = session.status === 'turn_completed' && COMPLETED_EVENTS.has(session.lifecycleEvent)
    if (!isStart && !isComplete) return
    const eventAt = Date.parse(isStart && 'turnStartedAt' in session ? session.turnStartedAt : session.observedAt)
    if (!validSessionId(session.sessionId) || !Number.isFinite(eventAt) || eventAt <= startedAt) return
    const eventHandled = isStart ? startedHandled : handled
    if ((eventHandled.get(session.sessionId) || 0) >= eventAt) return
    const key = `${isStart ? 'start' : 'complete'}:${session.sessionId}:${eventAt}`
    if (pending.has(key)) return
    pending.add(key)
    const observed = { ...session }
    const historyFile = isStart ? options.startFile : file
    const timeField = isStart ? 'startedAt' : 'completedAt'
    queue = queue.then(async () => {
      if (disposed) return
      if (isStart && (handled.get(observed.sessionId) || 0) >= eventAt) return
      const history = await readHistory(historyFile, timeField)
      if ((history.get(observed.sessionId) || 0) >= eventAt) {
        eventHandled.set(observed.sessionId, history.get(observed.sessionId))
        return
      }
      history.set(observed.sessionId, eventAt)
      // Claim before dispatch: a crash, repeated poll, or failed OS delivery
      // must not produce an endless stream of notifications for the same turn.
      await saveHistory(historyFile, history, timeField)
      eventHandled.set(observed.sessionId, eventAt)
      const payload = isStart ? startedNotification(observed)
        : options.createPayload ? await options.createPayload(observed, { signal: controller.signal }) : completionToast(observed)
      await send(payload)
    }).catch(report).finally(() => pending.delete(key))
  }

  function test() {
    if (!supported || disposed) return Promise.reject(Object.assign(new Error(`${options.channelName || 'Windows'} 通知不可用`), { status: 503 }))
    const result = queue.then(() => send(options.testPayload || { title: '会话看板 · 测试通知', body: 'Windows 完成通知已接通。之后新的正常完成轮次会自动提醒。', tag: 'codex-test' }))
    queue = result.catch(report)
    return result
  }

  return {
    observe,
    test,
    snapshot: () => ({ supported, enabled, pending: pending.size, lastSentAt, lastError }),
    waitForIdle: () => queue,
    close: () => {
      disposed = true
      controller.abort()
      return queue
    }
  }
}
