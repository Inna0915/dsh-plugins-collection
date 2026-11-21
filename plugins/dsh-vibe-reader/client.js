window.__ModuleLoader__.load({
  id: 'dsh-vibe-reader',
  factory(require) {
    const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = require('react')
    let primitives = null
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') || null } catch { primitives = null }
    const kind = 'vibe-reader'
    const tabId = 'dsh-vibe-reader/reader'
    const MAIN_ID = 'dsh-vibe-reader'
    const NAME = '闲庭信步'
    const MAIN_WIDE_MIN = 1150 // px: below this the main area uses the sidebar arrangement
    const api = { library: 'api/vibe-reader/library', volume: 'api/vibe-reader/volume', state: 'api/vibe-reader/state', markVerified: 'api/vibe-reader/mark-verified' }
    const MAX_LEVEL = 5
    const MAIN_DONE_HOLD_MS = 60000
    const PROGRESS_DELAY_MS = 500
    const REFRESH_POLL_MS = 15000
    const HIDDEN_GRACE_MS = 1500
    const GLOSS_INLINE_MAX = 24
    const HAN = /\p{Script=Han}/u
    const levelHints = ['全文', '每 5 字隐 1 字', '每 3 字隐 1 字', '只留每句首字', '只留标点和分段', '全部隐藏']
    const pendingLabels = { approval: '审批', 'plan-review': '计划确认', question: '提问' }
    const verifiedLabels = { true: '人工核对', corpus: '已对照语料', false: '未核对' }
    // 会话看板 = plugin codex-monitor: its sessions route, main panel id and client module id.
    const BOARD = { sessions: '/codex-monitor/sessions', panel: 'codex-monitor', module: 'codex-monitor' }
    const BOARD_POLL_MS = 5000
    const BOARD_MISSING_RETRY_MS = 60000
    const BOARD_TIMEOUT_MS = 15000
    const AGENTS = { codex: 'Codex', dsh: 'DSH', kimi: 'Kimi', claude: 'Claude', agy: 'Antigravity' }
    const AGENT_CLIENTS = { app: '桌面应用', codex_app: '桌面应用', 'kimi-desktop': '桌面应用', vscode: 'VS Code', 'kimi-vscode': 'VS Code', 'claude-vscode': 'VS Code', cli: 'CLI', 'kimi-cli': 'CLI', 'claude-cli': 'CLI', 'agy-cli': 'CLI', exec: 'Exec', 'agy-hub': 'agy Hub' }

    // ---------------------------------------------------------------- pure: Agent status (verified in the spike)

    /** Fold one sessionStatus snapshot into per-session turn tracking. */
    function track(previous, snapshot, now) {
      const next = new Map()
      for (const [id, status] of snapshot) {
        const before = previous.get(id)
        const running = status?.running === true
        let since = before?.since
        let finishedAt = before?.finishedAt
        let lastMs = before?.lastMs
        if (running && !before?.running) since = now
        if (!running && before?.running) {
          finishedAt = now
          lastMs = now - before.since
          since = undefined
        }
        next.set(id, {
          running,
          pendingKind: status?.pendingInteraction ? String(status.pendingInteraction.kind || 'unknown') : undefined,
          since,
          finishedAt,
          lastMs,
          completionUnread: Boolean(status?.completionUnread)
        })
      }
      return next
    }

    function titleOf(list, id) {
      const row = list?.byId?.[id]
      return row?.displayTitle || row?.title || '未命名会话 ' + String(id).slice(-6)
    }

    /** Board-wide view over every top-level session (spec §4.6). */
    function boardView(tracked, list, now) {
      const needsYou = []
      const done = []
      const running = []
      for (const [id, entry] of tracked) {
        const row = list?.byId?.[id]
        if (row && (row.origin === 'subagent' || row.parentId || row.blank)) continue
        const isMain = (row?.retainedBy?.mainView ?? 0) > 0
        const item = { id, title: titleOf(list, id), isMain, since: entry.since, finishedAt: entry.finishedAt, lastMs: entry.lastMs, pendingKind: entry.pendingKind }
        if (entry.pendingKind) needsYou.push(item)
        else if (entry.running) running.push(item)
        else if (entry.completionUnread || (isMain && entry.finishedAt !== undefined && now - entry.finishedAt < MAIN_DONE_HOLD_MS)) done.push(item)
      }
      running.sort((a, b) => (a.since ?? now) - (b.since ?? now))
      done.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      const tone = needsYou.length ? 'needs-you' : done.length ? 'done' : running.length ? 'waiting' : 'idle'
      return { tone, needsYou, done, running }
    }

    // ---------------------------------------------------------------- pure: 会话看板 running sessions (any agent)

    function agentOf(session) {
      if (session.provider) return String(session.provider)
      const prefix = String(session.sessionId || '').split(':')[0]
      return prefix === 'kimi-cli' ? 'kimi' : AGENTS[prefix] ? prefix : 'codex'
    }

    /** When the current turn started: the board's turnStartedAt, else the running status's observedAt. */
    function turnStartOf(session) {
      const at = Date.parse(session.turnStartedAt || session.observedAt || '')
      return Number.isFinite(at) ? at : undefined
    }

    function agentMetaOf(session) {
      const folder = String(session.cwd || '').split(/[\\/]/).filter(Boolean).pop()
      const model = [session.model, session.reasoningEffort].filter(Boolean).join(' ')
      return [AGENTS[agentOf(session)] || agentOf(session), AGENT_CLIENTS[String(session.source || '').toLowerCase()], folder, model].filter(Boolean).join(' · ')
    }

    /** The 会话看板's running sessions, in the shape StatusChip reads from boardView. */
    function agentBoardView(feed) {
      const running = (feed?.payload?.sessions || []).filter((session) => session?.status === 'running').map((session) => ({
        id: String(session.sessionId),
        title: session.title || '未命名会话',
        agent: agentOf(session),
        meta: agentMetaOf(session),
        cwd: session.cwd || '',
        since: turnStartOf(session)
      }))
      running.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))
      return { tone: running.length ? 'waiting' : 'idle', needsYou: [], done: [], running, board: true }
    }

    async function defaultBoardRequest() {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(BOARD_TIMEOUT_MS) : undefined
      const response = await fetch(BOARD.sessions, { cache: 'no-store', headers: { accept: 'application/json' }, signal })
      const data = await response.json().catch(() => null)
      if (!data || !Array.isArray(data.sessions)) {
        // 404, or the app shell answering an unknown path: the board is not installed here.
        if (response.ok || response.status === 404) return null
        throw new Error('会话看板暂不可用（HTTP ' + response.status + '）')
      }
      if (!response.ok) throw new Error(data.health?.lastError || data.error || '会话看板暂不可用')
      return data
    }

    /**
     * Poll the 会话看板 while any pane shows the reader. `request` resolves the
     * snapshot, or null when the board is not installed (then the reader falls
     * back to DSH's own sessions and checks again only once a minute).
     */
    function createBoardFeed({ request = defaultBoardRequest, clock = Date.now, every = (task, ms) => setInterval(task, ms), stop = (timer) => clearInterval(timer), isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden' } = {}) {
      const listeners = new Set()
      let value = { status: 'idle', payload: null, error: '', at: 0 }
      let holders = 0
      let timer = null
      let loading = false
      function set(next) {
        value = next
        for (const listener of listeners) listener()
      }
      async function poll() {
        if (loading || isHidden()) return
        if (value.status === 'missing' && clock() - value.at < BOARD_MISSING_RETRY_MS) return
        loading = true
        try {
          const payload = await request()
          set({ status: payload ? 'ok' : 'missing', payload: payload || null, error: '', at: clock() })
        } catch (error) {
          set({ status: 'error', payload: value.payload, error: error instanceof Error ? error.message : String(error), at: clock() })
        } finally {
          loading = false
        }
      }
      return {
        retain() {
          holders++
          if (holders === 1) {
            poll()
            timer = every(poll, BOARD_POLL_MS)
          }
          let released = false
          return () => {
            if (released) return
            released = true
            holders--
            if (!holders) {
              stop(timer)
              timer = null
            }
          }
        },
        poll,
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }

    function createTracker(source, clock = Date.now) {
      const listeners = new Set()
      let value = new Map()
      function update() {
        value = track(value, source.getSnapshot(), clock())
        for (const listener of listeners) listener()
      }
      return {
        start() {
          if (!source) return () => {}
          update()
          return source.subscribe(update)
        },
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }

    /** Call `onEnd` whenever any tracked session stops running (an Agent turn ended somewhere). */
    function watchTurnEnds(tracker, onEnd) {
      let running = new Set()
      return tracker.subscribe(() => {
        const now = new Set([...tracker.getSnapshot()].filter(([, entry]) => entry.running).map(([id]) => id))
        const ended = [...running].some((id) => !now.has(id))
        running = now
        if (ended) onEnd()
      })
    }

    /** Carry the panel into the next session only when it was visible in the one being left (spec §4.1). */
    function createFollower({ mounted, isVisible, enabled, open, schedule }) {
      let previous = mounted.getSnapshot()
      let reading = false
      return function start() {
        return mounted.subscribe(() => {
          const next = mounted.getSnapshot()
          if (next === previous) return
          if (previous !== undefined) reading = isVisible(previous)
          previous = next
          if (next === undefined || !reading || !enabled()) return
          schedule(() => {
            if (mounted.getSnapshot() === next) open(next)
          })
        })
      }
    }

    // ---------------------------------------------------------------- pure: reading and recitation

    /**
     * Recitation mask (spec §4.5). Punctuation and paragraphing stay in L0–L4;
     * L5 folds each paragraph. `round` rotates which characters L1/L2 hide.
     */
    function maskParagraphs(paragraphs, level, round = 0) {
      let han = 0
      const out = paragraphs.map((text) => {
        let previousIsHan = false
        return Array.from(text, (ch) => {
          const isHan = HAN.test(ch)
          let hidden = false
          if (isHan) {
            const initial = !previousIsHan
            if (level === 1) hidden = (han + round) % 5 === 4
            else if (level === 2) hidden = (han + round) % 3 === 2
            else if (level === 3) hidden = !initial
            else if (level >= 4) hidden = true
            han++
          }
          if (!/\s/.test(ch) || ch === '\n') previousIsHan = isHan
          return { ch, han: isHan, hidden }
        })
      })
      return { folded: level >= 5, paragraphs: out, hanCount: han }
    }

    /** First non-overlapping occurrence of each note word, scanning paragraphs in order. */
    function sectionGlosses(section) {
      const result = section.paragraphs.map(() => [])
      for (const note of section.notes) {
        for (let index = 0; index < section.paragraphs.length; index++) {
          const text = section.paragraphs[index].text
          let from = 0
          let found = -1
          while ((found = text.indexOf(note.word, from)) !== -1) {
            const end = found + note.word.length
            if (!result[index].some((match) => found < match.end && end > match.start)) break
            from = found + 1
          }
          if (found !== -1) {
            result[index].push({ start: found, end: found + note.word.length, note })
            break
          }
        }
      }
      for (const list of result) list.sort((a, b) => a.start - b.start)
      return result
    }

    /** Split a paragraph into spans by quote and gloss boundaries. */
    function textPieces(text, quotes, glosses) {
      const cuts = new Set([0, text.length])
      for (const range of [...quotes, ...glosses]) {
        cuts.add(range.start)
        cuts.add(range.end)
      }
      const points = [...cuts].sort((a, b) => a - b)
      const pieces = []
      for (let index = 0; index + 1 < points.length; index++) {
        const start = points[index]
        const end = points[index + 1]
        if (start === end) continue
        const gloss = glosses.find((item) => start >= item.start && end <= item.end)
        pieces.push({
          text: text.slice(start, end),
          quote: quotes.some((quote) => start >= quote.start && end <= quote.end),
          noted: Boolean(gloss),
          gloss,
          whole: Boolean(gloss) && gloss.start === start && gloss.end === end,
          glossesAfter: glosses.filter((item) => item.end === end)
        })
      }
      return pieces
    }

    const GLOSS_MODES = ['inline', 'below', 'tap']
    const GLOSS_LABELS = { inline: '夹注', below: '句下', tap: '点词' }

    /**
     * Default note layout for a volume: 句下 for poems and dense notes (more
     * than one per 12 characters), 夹注 for sparse prose. A choice saved for
     * the volume wins; the old showGloss=false setting maps to 点词.
     */
    function glossModeFor(volume, state) {
      const saved = state?.volumes?.[volume.id]?.glossMode
      if (GLOSS_MODES.includes(saved)) return saved
      if (state?.settings?.showGloss === false) return 'tap'
      if (volume.kind === 'poem') return 'below'
      const notes = volume.sections.reduce((sum, section) => sum + section.notes.length, 0)
      const chars = volume.sections.reduce((sum, section) => sum + section.paragraphs.reduce((n, paragraph) => n + Array.from(paragraph.text.replace(/[\p{P}\s]/gu, '')).length, 0), 0)
      return chars && notes / chars > 1 / 12 ? 'below' : 'inline'
    }

    /** Split a paragraph into its lines with the quotes and glosses that start on each line, offsets made line-local. */
    function lineUnits(paragraph, glosses) {
      const units = []
      let start = 0
      for (const text of paragraph.text.split('\n')) {
        const end = start + text.length
        const local = (range) => ({ ...range, start: Math.max(range.start, start) - start, end: Math.min(range.end, end) - start })
        units.push({
          text,
          quotes: paragraph.quotes.filter((quote) => quote.start < end && quote.end > start).map(local),
          glosses: glosses.filter((gloss) => gloss.start >= start && gloss.start < end).map(local)
        })
        start = end + 1
      }
      return units
    }

    /** Notes whose word is not matched in the section's text (sectionGlosses places each note at most once). */
    function notesOutsideText(section) {
      const placed = new Set(sectionGlosses(section).flat().map((gloss) => gloss.note))
      return section.notes.filter((note) => !placed.has(note))
    }

    /** Per-character readings when the syllable count matches the word, else null (shown in the note instead). */
    function rubyOf(note) {
      if (!note?.reading) return null
      const syllables = note.reading.trim().split(/\s+/)
      return syllables.length === Array.from(note.word).length ? syllables : null
    }

    const LEADING_PUNCT = /^[，。；：、？！”’」』）》…—]+/u

    /**
     * Group each glossed word with its gloss and any punctuation that follows,
     * so a wide 双行夹注 never pushes 「。」 to the start of the next line.
     */
    function renderPlan(pieces) {
      const plan = []
      let skip = 0
      pieces.forEach((piece, index) => {
        const text = piece.text.slice(skip)
        skip = 0
        if (!text) return
        const item = { text, quote: piece.quote, noted: piece.noted, glosses: piece.glossesAfter, tail: null }
        if (piece.glossesAfter.length && pieces[index + 1]) {
          const lead = LEADING_PUNCT.exec(pieces[index + 1].text)?.[0] || ''
          if (lead) {
            item.tail = { text: lead, quote: pieces[index + 1].quote }
            skip = lead.length
          }
        }
        plan.push(item)
      })
      return plan
    }

    function glossText(note) {
      return note.reading ? note.reading + ' ' + note.gloss : note.gloss
    }

    /** Two lines of a 双行夹注: reading over gloss when short enough, else the text split in half. */
    function glossLines(note) {
      const gloss = Array.from(note.gloss)
      if (note.reading && gloss.length <= 14) return [note.reading, note.gloss]
      const chars = Array.from(glossText(note))
      if (chars.length <= 6) return [chars.join(''), '']
      const half = Math.ceil(chars.length / 2)
      return [chars.slice(0, half).join(''), chars.slice(half).join('')]
    }

    /** Weighted pick: 1 / (1 + times shown); never the same card twice in a row. */
    function pickCard(cards, resurface, lastKey, random = Math.random) {
      const pool = cards.length > 1 ? cards.filter((card) => card.key !== lastKey) : cards
      if (!pool.length) return null
      const weights = pool.map((card) => 1 / (1 + (resurface?.[card.key]?.shown || 0)))
      let roll = random() * weights.reduce((sum, weight) => sum + weight, 0)
      for (let index = 0; index < pool.length; index++) {
        roll -= weights[index]
        if (roll < 0) return pool[index]
      }
      return pool[pool.length - 1]
    }

    const NUMERALS = ['零', '壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖']

    /** 1 → 壹, 11 → 拾壹, 25 → 貳拾伍, 105 → 壹佰零伍（繁体大写，用于节序）。 */
    function toNumeral(n) {
      if (!Number.isInteger(n) || n <= 0 || n >= 1000) return String(n)
      if (n < 10) return NUMERALS[n]
      if (n < 100) {
        const tens = Math.floor(n / 10)
        return (tens === 1 ? '' : NUMERALS[tens]) + '拾' + (n % 10 ? NUMERALS[n % 10] : '')
      }
      const rest = n % 100
      return NUMERALS[Math.floor(n / 100)] + '佰' + (rest === 0 ? '' : rest < 10 ? '零' + NUMERALS[rest] : (rest < 20 ? '壹' : '') + toNumeral(rest))
    }

    const SHELF_FILTERS = [['all', '全部'], ['poem', '诗词'], ['prose', '文章'], ['reciting', '背诵中'], ['unread', '未读']]
    const LEVEL_TAGS = ['小学', '初中', '高中', '蒙学']

    /** Tags worth a filter chip: 学段 first, then any tag on at least two volumes, most used first. */
    function shelfTags(rows, limit = 10) {
      const counts = new Map()
      for (const row of rows) for (const tag of new Set(row.tags || [])) counts.set(tag, (counts.get(tag) || 0) + 1)
      const levels = LEVEL_TAGS.filter((tag) => counts.has(tag))
      const others = [...counts].filter(([tag, count]) => count >= 2 && !LEVEL_TAGS.includes(tag)).sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
      return [...levels, ...others].slice(0, limit)
    }

    /**
     * Shelf rows: recently read first (newest first), then the rest in library
     * order. The query matches title, author, dynasty and tags, and also each
     * section's title and poem author — those hits are listed so a click opens
     * that section directly.
     */
    function shelfItems(rows, state, query = '', filter = 'all', tag = '') {
      const q = String(query).trim()
      const items = rows.filter((row) => row.id).map((row, order) => {
        const progress = state?.volumes?.[row.id]
        const at = progress?.lastSection ? (row.sectionIds || []).indexOf(progress.lastSection) : -1
        const reciting = (row.sectionIds || []).some((id) => (state?.cards?.[row.id + '#' + id]?.level || 0) > 0)
        const own = !q || [row.title, row.author, row.dynasty, ...(row.tags || [])].some((value) => String(value || '').includes(q))
        const sections = q ? (row.sectionList || []).map((section, index) => ({ ...section, position: index + 1 })).filter((section) => section.title.includes(q) || section.author.includes(q)) : []
        return { row, order, readAt: progress?.readAt || '', position: at >= 0 ? at + 1 : 0, total: row.sectionCount || 0, reciting, own, sections }
      }).filter((item) => (item.own || item.sections.length) && (
        filter === 'all' ||
        (filter === 'poem' && item.row.kind === 'poem') ||
        (filter === 'prose' && item.row.kind !== 'poem') ||
        (filter === 'reciting' && item.reciting) ||
        (filter === 'unread' && !item.readAt)
      ) && (!tag || (item.row.tags || []).includes(tag)))
      return {
        recent: items.filter((item) => item.readAt).sort((a, b) => b.readAt.localeCompare(a.readAt)),
        unread: items.filter((item) => !item.readAt).sort((a, b) => a.order - b.order)
      }
    }

    function fitsVertical(text) {
      const lines = text.split('\n')
      return lines.length <= 8 && lines.every((line) => Array.from(line).length <= 14)
    }

    /** Client mirror of the host's state transitions, for optimistic display only. */
    function optimistic(state, op) {
      if (!state) return state
      const next = structuredClone(state)
      if (op.op === 'view') next.ui.view = op.view
      else if (op.op === 'progress') {
        next.ui.volume = op.volumeId
        next.volumes[op.volumeId] = { ...(next.volumes[op.volumeId] || {}), lastSection: op.sectionId, readAt: new Date().toISOString() }
      } else if (op.op === 'settings') next.settings = { ...next.settings, ...op.patch }
      else if (op.op === 'gloss') next.volumes[op.volumeId] = { ...(next.volumes[op.volumeId] || {}), glossMode: op.mode }
      else if (op.op === 'level') next.cards[op.key] = { ...(next.cards[op.key] || {}), level: op.level }
      else if (op.op === 'rate') {
        const level = next.cards[op.key]?.level || 0
        const delta = { remembered: 1, fuzzy: 0, forgot: -1 }[op.rating] || 0
        next.cards[op.key] = { ...(next.cards[op.key] || {}), level: Math.min(MAX_LEVEL, Math.max(0, level + delta)) }
      } else if (op.op === 'seen') {
        const entry = next.resurface[op.key] || {}
        next.resurface[op.key] = { ...entry, shown: (entry.shown || 0) + 1 }
      }
      return next
    }

    // ---------------------------------------------------------------- shared store (one per plugin, all panes)

    async function defaultRequest(path, body) {
      const response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || '书库服务暂不可用')
      return data
    }

    /**
     * Library, state and loaded volumes shared by every pane. State ops are
     * sent in order; each response is the host's truth with still-unsent or
     * in-flight ops re-applied on top, so the display never steps backwards.
     * Progress is debounced and flushed before any other op.
     */
    function createAppStore({ request = defaultRequest, schedule = setTimeout, cancel = clearTimeout } = {}) {
      const listeners = new Set()
      let value = { status: 'idle', error: '', notice: '', library: null, state: null, volumes: {}, encounterKey: null }
      let base = null
      const pending = []
      let chain = Promise.resolve()
      let progressTimer = null
      let progressOp = null
      let loadedAt = 0
      // Every state op bumps this. A library response that was requested before an op
      // carries a state snapshot that may predate it, so it must not replace the newer base.
      let opsSent = 0
      let loading = null

      function set(patch) {
        value = { ...value, ...patch }
        for (const listener of listeners) listener()
      }
      function display() {
        const shown = pending.reduce((state, entry) => optimistic(state, entry.op), base)
        return progressOp ? optimistic(shown, progressOp) : shown
      }

      function enqueue(op) {
        const entry = { op }
        opsSent++
        pending.push(entry)
        set({ state: display() })
        chain = chain.then(async () => {
          try {
            const result = await request(api.state, op)
            base = result.state
          } catch (error) {
            set({ notice: error.message })
          } finally {
            pending.splice(pending.indexOf(entry), 1)
            set({ state: display() })
          }
        })
        return chain
      }

      function flush() {
        if (!progressOp) return chain
        cancel(progressTimer)
        const op = progressOp
        progressOp = null
        progressTimer = null
        return enqueue(op)
      }

      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        load() {
          // One reload at a time; several panes and timers may ask together.
          if (!loading) loading = this.reload().finally(() => { loading = null })
          return loading
        },
        async reload() {
          const before = value.library ? new Set(value.library.volumes.map((row) => row.id)) : null
          set({ status: value.library ? value.status : 'loading', error: '', refreshing: Boolean(value.library) })
          try {
            await flush()
            await chain
            const sentBefore = opsSent
            const data = await request(api.library)
            // Ops sent while the library was loading already returned a newer state; keep it.
            if (opsSent === sentBefore) base = data.state
            const revisions = new Map(data.volumes.map((row) => [row.id, row.revision]))
            const volumes = Object.fromEntries(Object.entries(value.volumes).filter(([id, entry]) => entry.status === 'ready' && entry.volume.revision === revisions.get(id)))
            loadedAt = Date.now()
            const added = before ? data.volumes.filter((row) => row.id && !row.errors?.length && !before.has(row.id)).map((row) => ({ id: row.id, title: row.title, firstSection: row.sectionIds?.[0] })) : []
            set({
              status: 'ready',
              refreshing: false,
              added: added.length ? [...(value.added || []).filter((item) => !added.some((next) => next.id === item.id)), ...added] : (value.added || []),
              library: data,
              volumes,
              state: display(),
              notice: data.recovered ? 'state.json 无法解析，已另存为 ' + data.recovered + '，进度从头开始' : value.notice
            })
          } catch (error) {
            loadedAt = Date.now() // do not retry every second
            set({ status: value.library ? 'ready' : 'error', error: error.message, refreshing: false, notice: value.library ? '重新读取书库失败：' + error.message : value.notice })
          }
        },
        dismissAdded(id) {
          set({ added: id ? (value.added || []).filter((item) => item.id !== id) : [] })
        },
        async ensureVolume(id) {
          const current = value.volumes[id]
          if (!id || current?.status === 'ready' || current?.status === 'loading') return
          set({ volumes: { ...value.volumes, [id]: { status: 'loading' } } })
          try {
            const { volume } = await request(api.volume, { id })
            set({ volumes: { ...value.volumes, [id]: { status: 'ready', volume } } })
          } catch (error) {
            set({ volumes: { ...value.volumes, [id]: { status: 'error', error: error.message } } })
          }
        },
        send(op) {
          flush()
          return enqueue(op)
        },
        progress(volumeId, sectionId) {
          progressOp = { op: 'progress', volumeId, sectionId }
          set({ state: display() })
          cancel(progressTimer)
          progressTimer = schedule(flush, PROGRESS_DELAY_MS)
        },
        flush,
        /** Reload when shown again, at most every few seconds (several panes may become visible together). */
        refreshIfStale(maxAgeMs = 3000) {
          if (loading || Date.now() - loadedAt < maxAgeMs) return
          this.load()
        },
        setEncounter(key) {
          set({ encounterKey: key })
        },
        /** Pick a card only if none is showing; panes in other sessions share the result. */
        autoPick(picker) {
          if (value.encounterKey || !value.library) return
          const card = picker()
          if (!card) return
          set({ encounterKey: card.key })
          this.send({ op: 'seen', key: card.key })
        },
        /** Ask the host to set verified: true on a library volume, then reload so recitation unlocks. */
        async markVerified(id) {
          await request(api.markVerified, { id })
          await this.load()
        },
        dismissNotice() {
          set({ notice: '' })
        }
      }
    }

    // ---------------------------------------------------------------- view helpers

    const styles = `
.vr{--vr-cinnabar:color-mix(in srgb,#c3272b 82%,currentColor);--vr-line:color-mix(in srgb,currentColor 14%,transparent);--vr-soft:color-mix(in srgb,currentColor 6%,transparent);display:flex;flex-direction:column;height:100%;box-sizing:border-box;font-size:calc(13px*var(--vr-scale,1));overflow:hidden}
.vr *{box-sizing:border-box}
.vr button,.vr select,.vr input{font:inherit;color:inherit}
.vr button{border:1px solid var(--vr-line);background:transparent;border-radius:6px;padding:3px 8px;cursor:pointer;line-height:1.5}
.vr button:hover{background:var(--vr-soft)}
.vr button:disabled{opacity:.5;cursor:default}
.vr button[aria-pressed=true]{background:color-mix(in srgb,currentColor 12%,transparent)}
.vr-head{display:grid;gap:6px;padding:10px 12px 8px;border-bottom:1px solid var(--vr-line)}
.vr-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.vr-grow{flex:1;min-width:0}
.vr-seg{display:inline-flex;border:1px solid var(--vr-line);border-radius:7px;overflow:hidden}
.vr-seg button{border:0;border-radius:0;padding:3px 10px}
.vr-chip{border-radius:999px!important;padding:2px 10px!important;font-size:calc(12px*var(--vr-scale,1));white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.vr-tone-needs-you{background:color-mix(in srgb,#c3272b 26%,transparent)!important}
.vr-tone-done{background:color-mix(in srgb,#e9c46a 32%,transparent)!important}
.vr-tone-idle,.vr-tone-waiting{opacity:.75}
.vr-pop{display:grid;gap:6px;padding:8px;border:1px solid var(--vr-line);border-radius:8px;background:var(--vr-soft)}
.vr-pop h4{margin:2px 0 0;font-size:calc(12px*var(--vr-scale,1));opacity:.75}
.vr-pop ul{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.vr-session{display:flex!important;gap:8px;width:100%;text-align:left;align-items:baseline}
.vr-session span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vr-session span:last-child{flex:none;opacity:.7;font-size:calc(11.5px*var(--vr-scale,1))}
.vr-body{flex:1;overflow:auto;padding:12px 14px 18px;display:grid;gap:12px;align-content:start}
.vr-muted{opacity:.65}
.vr-small{font-size:calc(11.5px*var(--vr-scale,1))}
.vr-notice{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:6px;background:color-mix(in srgb,#e9c46a 22%,transparent)}
.vr-text{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;font-size:calc(15.5px*var(--vr-scale,1));line-height:1.95;letter-spacing:.02em}
.vr-text p{margin:0 0 .6em}
.vr-quote{color:var(--vr-accent,color-mix(in srgb,#b8862b 85%,currentColor))}
.vr-para{margin:0 0 .7em}
.vr-line p{margin:0}
.vr-mode-below .vr-line p{line-height:2.3}
.vr-mode-below ruby rt{font-size:.48em;color:var(--vr-cinnabar);letter-spacing:0;font-family:system-ui,sans-serif}
.vr-under{text-decoration:underline dotted color-mix(in srgb,var(--vr-cinnabar) 55%,transparent);text-underline-offset:5px}
.vr-tap{cursor:pointer;text-decoration:underline dotted color-mix(in srgb,var(--vr-cinnabar) 70%,transparent);text-underline-offset:5px;border-radius:2px}
.vr-tap.vr-open{background:color-mix(in srgb,var(--vr-cinnabar) 10%,transparent)}
.vr-notes-row{display:flex;flex-wrap:wrap;gap:1px 12px;margin:1px 0 8px;font-size:calc(11.5px*var(--vr-scale,1));line-height:1.55;letter-spacing:0;opacity:.85}
.vr-bn b{color:var(--vr-cinnabar);font-weight:600;margin-right:2px}
.vr-noted{text-decoration:underline dotted color-mix(in srgb,var(--vr-cinnabar) 70%,transparent);text-underline-offset:4px}
.vr-keep{white-space:nowrap}
.vr-gloss{white-space:normal;display:inline-flex;flex-direction:column;vertical-align:middle;font-size:calc(9.5px*var(--vr-scale,1));line-height:1.15;color:var(--vr-cinnabar);margin:0 2px;letter-spacing:0;font-family:inherit;cursor:pointer;max-width:12em}
.vr-gloss.vr-open{display:inline;font-size:calc(11px*var(--vr-scale,1));vertical-align:baseline}
.vr-title{margin:0;font-size:calc(17px*var(--vr-scale,1));font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif}
.vr-guide{margin:0;padding:4px 8px;border-left:2px solid var(--vr-line);opacity:.8;font-size:calc(12.5px*var(--vr-scale,1))}
.vr-body:focus{outline:none}
.vr-volhead{display:flex!important;align-items:center;gap:8px;width:100%;border:0!important;padding:2px 0!important;text-align:left;background:transparent!important}
.vr-spine{flex:none;width:4px;align-self:stretch;min-height:20px;border-radius:2px;background:var(--vr-accent,color-mix(in srgb,currentColor 22%,transparent))}
.vr-voltitle{flex:none;max-width:60%;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;font-size:calc(17px*var(--vr-scale,1));font-weight:600;color:var(--vr-accent,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-volmeta{flex:1;min-width:0;font-size:calc(12px*var(--vr-scale,1));opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-volswitch{flex:none;font-size:calc(11.5px*var(--vr-scale,1));opacity:.6;border:1px solid var(--vr-line);border-radius:999px;padding:1px 9px}
.vr-volhead:hover .vr-volswitch,.vr-volhead[aria-expanded=true] .vr-volswitch{opacity:1}
.vr-shelf{display:grid;gap:2px}
.vr-shelf-label{font-size:calc(11.5px*var(--vr-scale,1));opacity:.55;margin:10px 0 2px 2px}
.vr-shelf-row{display:flex!important;align-items:stretch;gap:10px;width:100%;text-align:left;border:0!important;padding:7px 8px!important}
.vr-shelf-row[aria-current=true]{background:var(--vr-soft)}
.vr-shelf-main{flex:1;min-width:0;display:grid;gap:1px}
.vr-shelf-title{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;font-size:calc(14.5px*var(--vr-scale,1));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-shelf-row[aria-current=true] .vr-shelf-title{font-weight:600}
.vr-shelf-meta{font-size:calc(11.5px*var(--vr-scale,1));opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-shelf-side{flex:none;display:grid;justify-items:end;align-content:center;gap:1px;font-size:calc(11.5px*var(--vr-scale,1));opacity:.75;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif}
.vr-shelf-side em{font-style:normal;color:var(--vr-cinnabar);font-size:calc(11px*var(--vr-scale,1))}
.vr-search{width:100%;border:1px solid var(--vr-line);border-radius:6px;background:transparent;padding:5px 8px;margin-bottom:2px}
.vr-cells{display:flex;gap:4px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin;padding:2px 1px 4px}
.vr-cells button{flex:none;min-width:calc(26px*var(--vr-scale,1));height:calc(26px*var(--vr-scale,1));padding:0 5px;border-radius:5px;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;font-size:calc(13px*var(--vr-scale,1));line-height:1}
.vr-cells button[aria-current=true]{border:1.5px solid var(--vr-accent,currentColor)!important;color:var(--vr-accent,inherit);font-weight:700}
.vr-cells button{position:relative}
.vr-cells button[data-level]::after{content:"";position:absolute;left:4px;bottom:2px;height:2px;width:calc((100% - 8px) * var(--lv));border-radius:1px;background:color-mix(in srgb,var(--vr-accent,#5a9e7c) 80%,transparent)}
.vr-filters{gap:4px}
.vr-filters button{border-radius:999px!important;padding:1px 10px!important;font-size:calc(12px*var(--vr-scale,1))}
.vr-tags button{font-size:calc(11.5px*var(--vr-scale,1));padding:0 9px!important;opacity:.85}
.vr-tags button[aria-pressed=true]{opacity:1}
.vr-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font-size:calc(10.5px*var(--vr-scale,1));line-height:1.6;border:1px solid var(--vr-line);opacity:.9}
.vr-shelf-group{display:grid}
.vr-shelf-hits{display:flex;flex-wrap:wrap;gap:4px;padding:0 8px 6px 22px;font-size:calc(12px*var(--vr-scale,1))}
.vr-shelf-hits button{padding:1px 8px!important;border-radius:999px!important;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif}
.vr-head-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.vr-head-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.vr-dim{opacity:.45;cursor:pointer;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;font-size:calc(13px*var(--vr-scale,1));border:0!important;text-align:left;padding:2px 0!important;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-dim:hover{opacity:.75;background:transparent!important}
.vr-trans{margin:0;padding:8px 10px;border-radius:6px;background:var(--vr-soft);font-size:calc(13px*var(--vr-scale,1));line-height:1.75}
.vr-notes{font-size:calc(12.5px*var(--vr-scale,1))}
.vr-notes ul{margin:6px 0 0;padding-left:16px;display:grid;gap:3px}
.vr-notes b{color:var(--vr-cinnabar);font-weight:600}
.vr-card{display:grid;gap:10px;justify-items:center;text-align:center;padding:18px 12px;border:1px solid var(--vr-line);border-radius:10px}
.vr-vertical{writing-mode:vertical-rl;text-orientation:upright;max-height:calc(300px*var(--vr-scale,1));margin:0 auto;text-align:start}
.vr-hidden{cursor:pointer;user-select:none;color:color-mix(in srgb,currentColor 38%,transparent);border-radius:2px}
.vr-hidden.vr-shown{color:inherit;background:color-mix(in srgb,#5a9e7c 18%,transparent)}
.vr-fold{display:block;width:100%;text-align:left;padding:8px!important;margin-bottom:6px;opacity:.7}
.vr-levels button{min-width:30px}
.vr-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:space-between}
.vr-rate button{min-width:52px}
.vr-error{color:var(--vr-cinnabar)}
.vr-refresh{font-size:calc(14px*var(--vr-scale,1));line-height:1.3}
.vr-spinning{animation:vr-spin .8s linear infinite}
@keyframes vr-spin{to{transform:rotate(360deg)}}
.vr-added{flex-wrap:wrap;align-items:center}
.vr-added button{padding:1px 8px}
.vr-accent .vr-title{color:var(--vr-accent)}
.vr-accent .vr-guide{border-left-color:var(--vr-accent)}
.vr-card.vr-accent{border-top:3px solid var(--vr-accent)}


.vr-sheet{display:grid;gap:10px;margin-top:4px;padding:10px 2px 4px;border-top:1px solid var(--vr-line)}
.vr-sheet h4{margin:0;font-size:calc(12px*var(--vr-scale,1));font-weight:600;opacity:.6}
.vr-sheet ul{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.vr-sheet-row{display:grid;grid-template-columns:4em minmax(0,1fr);gap:10px;align-items:center}
.vr-sheet-label{font-size:calc(12px*var(--vr-scale,1));opacity:.6}
.vr-sheet-hint{font-size:calc(11.5px*var(--vr-scale,1));opacity:.6;line-height:1.5}
.vr-switch{position:relative;flex:none;width:2.4em;height:1.4em;padding:0!important;border:0!important;border-radius:999px!important;background:color-mix(in srgb,currentColor 20%,transparent)!important;transition:background .15s}
.vr-switch::after{content:"";position:absolute;top:.2em;left:.2em;width:1em;height:1em;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}
.vr-switch[aria-checked=true]{background:#5a9e7c!important}
.vr-switch[aria-checked=true]::after{left:1.2em}
.vr-path{font-size:calc(11px*var(--vr-scale,1));opacity:.5;user-select:text;word-break:break-all}
.vr-session-list button{border-color:transparent!important;background:transparent}
.vr-session-list .vr-link{background:transparent!important;padding:0 2px!important;font-size:calc(12px*var(--vr-scale,1));opacity:.7}
.vr-session-list .vr-link:hover{opacity:1}
.vr-agent{display:grid!important;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;text-align:left;padding:5px 8px!important}
.vr-agent-logo{display:grid;place-items:center;width:calc(22px*var(--vr-scale,1));height:calc(22px*var(--vr-scale,1));border-radius:6px;overflow:hidden;background:color-mix(in srgb,currentColor 8%,transparent);font-size:calc(11px*var(--vr-scale,1));font-weight:600}
.vr-agent-logo.vr-has-logo{background:transparent}
.vr-agent-logo img{width:100%;height:100%;object-fit:contain}
.vr-agent-text{display:grid;min-width:0}
.vr-agent-title,.vr-agent-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vr-agent-meta{font-size:calc(11px*var(--vr-scale,1));opacity:.6}
.vr-agent-time{font-size:calc(11.5px*var(--vr-scale,1));opacity:.65;font-variant-numeric:tabular-nums}
.vr:fullscreen{background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
.vr-main{--vr-column:calc(760px*var(--vr-scale,1));--vr-rail:calc(320px*var(--vr-scale,1));--vr-gap:40px;--vr-gutter:max(24px,calc((100% - var(--vr-column))/2))}
.vr-wide{--vr-gutter:max(24px,calc((100% - var(--vr-column) - var(--vr-gap) - var(--vr-rail))/2))}
.vr-main .vr-head{padding:14px var(--vr-gutter) 10px}
.vr-main:not(.vr-wide)>.vr-body{padding:20px var(--vr-gutter) 48px}
.vr-main-wrap{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) var(--vr-rail);column-gap:var(--vr-gap);padding:0 var(--vr-gutter)}
.vr-main-wrap>.vr-body{min-height:0;overflow:auto;padding:24px 6px 56px 0}
.vr-rail{display:flex;flex-direction:column;gap:18px;min-height:0;padding:20px 0 14px 20px;border-left:1px solid var(--vr-line)}
.vr-rail>*{flex:none}
.vr-rail .vr-sheet{margin-top:0;padding-top:0;border-top:0}
.vr-rail-shelf{flex:1 1 auto!important;min-height:0;display:flex;flex-direction:column}
.vr-rail .vr-shelf{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px}
.vr-rail .vr-shelf-list{flex:1;min-height:0;overflow:auto;margin-right:-8px;padding-right:8px}
.vr-rail .vr-agents{max-height:38%;overflow:auto;padding-top:12px;border-top:1px solid var(--vr-line)}
.vr-shelf-list{display:grid;gap:2px;align-content:start}
.vr-about{border:1px solid var(--vr-line);border-radius:8px;padding:0 10px}
.vr-about>summary{display:flex;gap:10px;align-items:baseline;padding:7px 0;cursor:pointer;list-style:none;font-size:calc(12.5px*var(--vr-scale,1))}
.vr-about>summary::-webkit-details-marker{display:none}
.vr-about>summary::before{content:"▸";opacity:.5;font-size:.85em}
.vr-about[open]>summary::before{content:"▾"}
.vr-about-tag{flex:none;font-weight:600;letter-spacing:.1em}
.vr-accent .vr-about-tag{color:var(--vr-accent)}
.vr-about-lead{min-width:0;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vr-about-body{display:grid;gap:12px;padding:2px 0 10px}
.vr-about-row{display:grid;grid-template-columns:2.6em minmax(0,1fr);gap:8px}
.vr-about-label{font-size:calc(12px*var(--vr-scale,1));opacity:.55;padding-top:.15em}
.vr-about-text{display:grid;gap:6px;font-size:calc(13.5px*var(--vr-scale,1));line-height:1.8}
.vr-about-text p{margin:0}
.vr-about-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;margin:0;font-size:calc(12.5px*var(--vr-scale,1))}
.vr-about-facts dt{opacity:.55}
.vr-about-facts dd{margin:0}
.vr-about-source{margin:0;font-size:calc(11px*var(--vr-scale,1));opacity:.5}
.vr-main-title{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;font-size:calc(16px*var(--vr-scale,1));font-weight:600;letter-spacing:.25em;margin-right:8px}
`

    // Left-sidebar entry: shared/sidebar.css (synced by scripts/sync-sidebar-style.mjs; edit there, not here).
    const SIDEBAR_CSS = /* @sidebar-style */ ":root{--dshx-label-inset: 10px;--dshx-row-inset: 12px;--dshx-footer-inset: 2px;--dshx-icon-box: 18px;--dshx-icon-gap: 10px;--dshx-row-height: 38px;--dshx-rail-size: 36px}[data-slot=\"sidebar.footer.action\"]:has(> .dshx-entry){display: flex !important;flex-direction: column;align-items: stretch;gap: 3px;width: 100%;min-width: 0}.dshx-entry{box-sizing: border-box;display: flex;align-items: center;gap: var(--dshx-icon-gap);width: 100%;min-width: 0;min-height: var(--dshx-row-height);margin: 0;padding: 0 calc(var(--dshx-row-inset) - var(--dshx-footer-inset));border: 0;border-radius: var(--dsw-radius-lg, 16px);background: transparent;color: var(--ink-2, var(--dsw-alias-label-secondary));font: inherit;font-size: var(--fs-strong, 14px);font-weight: 500;line-height: 22px;text-align: left;cursor: pointer;transition: background-color .14s ease, color .14s ease}.dshx-entry:hover{background: var(--hover, var(--dsw-alias-interactive-bg-hover));color: var(--ink, var(--dsw-alias-label-primary))}.dshx-entry:active{transform: translateY(1px)}.dshx-entry:focus-visible{outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));outline-offset: -2px}.dshx-entry[aria-current=\"page\"]{background: var(--accent-tint, var(--dsw-alias-interactive-bg-hover));color: var(--primary, var(--dsw-alias-state-business-primary, currentColor))}.dshx-entry-icon{display: inline-flex;flex: none;align-items: center;justify-content: center;width: var(--dshx-icon-box);height: var(--dshx-icon-box)}.dshx-entry-icon svg{width: 16px;height: 16px}.dshx-entry-label{min-width: 0;overflow: hidden;text-overflow: ellipsis;white-space: nowrap}.dshx-entry.dshx-rail{width: var(--dshx-rail-size);height: var(--dshx-rail-size);min-height: var(--dshx-rail-size);padding: 0;justify-content: center;align-self: center}" /* @sidebar-style-end */

    function durationText(ms) {
      const seconds = Math.max(0, Math.round(ms / 1000))
      if (seconds < 60) return seconds + ' 秒'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒'
      return Math.floor(minutes / 60) + ' 时 ' + String(minutes % 60).padStart(2, '0') + ' 分'
    }

    function lines(text) {
      const parts = text.split('\n')
      return parts.flatMap((part, index) => index ? [h('br', { key: 'br' + index }), part] : [part])
    }

    function BookIcon({ size = 17 } = {}) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('path', { d: 'M4 5.5C6.5 4 9.5 4 12 6c2.5-2 5.5-2 8-.5V19c-2.5-1.5-5.5-1.5-8 .5-2.5-2-5.5-2-8-.5V5.5Zm8 .5v13.5' }))
    }

    function Gloss({ note, open, onToggle }) {
      const text = glossText(note)
      const compact = note.reading && Array.from(note.gloss).length <= 14
      if (open || (!compact && Array.from(text).length > GLOSS_INLINE_MAX)) {
        return h('span', { className: 'vr-gloss vr-open', role: 'button', tabIndex: 0, title: '收起注释', onClick: onToggle },
          open ? '（' + text + '）' : '（' + Array.from(text).slice(0, GLOSS_INLINE_MAX - 2).join('') + '…）')
      }
      const [top, bottom] = glossLines(note)
      return h('span', { className: 'vr-gloss', role: 'button', tabIndex: 0, title: text, onClick: onToggle },
        h('span', null, top),
        bottom ? h('span', null, bottom) : null)
    }

    function NoteLine({ items }) {
      if (!items.length) return null
      return h('div', { className: 'vr-notes-row' }, ...items.map(({ note, ruby }) => h('span', { key: note.word, className: 'vr-bn' },
        h('b', null, note.word), (note.reading && !ruby ? ' ' + note.reading : '') + '：' + note.gloss)))
    }

    function Word({ piece, mode, open, onToggle }) {
      const className = [piece.quote && 'vr-quote', mode === 'tap' && 'vr-tap', mode === 'tap' && open && 'vr-open', mode === 'below' && 'vr-under'].filter(Boolean).join(' ') || undefined
      const ruby = mode === 'below' && piece.whole ? rubyOf(piece.gloss.note) : null
      const content = ruby
        ? h('ruby', null, ...Array.from(piece.text).flatMap((char, index) => [char, h('rt', { key: index }, ruby[index])]))
        : piece.text
      return mode === 'tap'
        ? h('span', { className, role: 'button', tabIndex: 0, title: '点击看注释', onClick: onToggle, onKeyDown: (event) => { if (event.key === 'Enter') onToggle() } }, content)
        : h('span', { className }, content)
    }

    function SectionText({ section, mode = 'inline' }) {
      const glosses = useMemo(() => sectionGlosses(section), [section])
      const [openNotes, setOpenNotes] = useState(() => new Set())
      function toggle(word) {
        const next = new Set(openNotes)
        if (next.has(word)) next.delete(word)
        else next.add(word)
        setOpenNotes(next)
      }
      if (mode !== 'inline') {
        return h('div', { className: 'vr-text vr-mode-' + mode }, ...section.paragraphs.map((paragraph, index) =>
          h('div', { key: index, className: 'vr-para' }, ...lineUnits(paragraph, glosses[index]).map((unit, lineIndex) => {
            const pieces = textPieces(unit.text, unit.quotes, unit.glosses)
            const shown = unit.glosses.filter((gloss) => mode === 'below' || openNotes.has(gloss.note.word))
            return h('div', { key: lineIndex, className: 'vr-line' },
              h('p', null, ...pieces.map((piece, pieceIndex) => piece.noted
                ? h(Word, { key: pieceIndex, piece, mode, open: openNotes.has(piece.gloss.note.word), onToggle: () => toggle(piece.gloss.note.word) })
                : h('span', { key: pieceIndex, className: piece.quote ? 'vr-quote' : undefined }, piece.text))),
              h(NoteLine, { items: shown.map((gloss) => ({ note: gloss.note, ruby: mode === 'below' && gloss.end - gloss.start === gloss.note.word.length ? rubyOf(gloss.note) : null })) }))
          }))))
      }
      return h('div', { className: 'vr-text' }, ...section.paragraphs.map((paragraph, index) => {
        const plan = renderPlan(textPieces(paragraph.text, paragraph.quotes, glosses[index]))
        return h('p', { key: index }, ...plan.map((item, itemIndex) => {
          const text = h('span', { key: 't', className: [item.quote && 'vr-quote', item.noted && 'vr-noted'].filter(Boolean).join(' ') || undefined }, ...lines(item.text))
          if (!item.glosses.length) return h('span', { key: itemIndex }, text)
          return h('span', { key: itemIndex, className: 'vr-keep' }, text,
            ...item.glosses.map((gloss) => h(Gloss, { key: 'g' + gloss.start + gloss.note.word, note: gloss.note, open: openNotes.has(gloss.note.word), onToggle: () => toggle(gloss.note.word) })),
            item.tail ? h('span', { key: 'tail', className: item.tail.quote ? 'vr-quote' : undefined }, item.tail.text) : null)
        }))
      }))
    }

    function Recite({ cardKey, paragraphs, level, recitable, onLevel, onRate, onExit }) {
      const [round, setRound] = useState(0)
      const [revealed, setRevealed] = useState(() => new Set())
      const [unfolded, setUnfolded] = useState(() => new Set())
      const masked = useMemo(() => maskParagraphs(paragraphs, level, round), [paragraphs, level, round])
      useEffect(() => {
        setRevealed(new Set())
        setUnfolded(new Set())
      }, [cardKey, level, round])

      function flip(key) {
        const next = new Set(revealed)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        setRevealed(next)
      }
      function showAll(show) {
        if (!show) {
          setRevealed(new Set())
          setUnfolded(new Set())
          return
        }
        const keys = new Set()
        masked.paragraphs.forEach((tokens, p) => tokens.forEach((token, i) => { if (token.hidden) keys.add(p + ':' + i) }))
        setRevealed(keys)
        setUnfolded(new Set(masked.paragraphs.map((_, p) => p)))
      }
      function rate(rating) {
        onRate(rating)
        setRound(round + 1)
      }

      return h('div', { className: 'vr-pop' },
        h('div', { className: 'vr-row vr-levels', role: 'group', 'aria-label': '背诵等级' },
          ...Array.from({ length: MAX_LEVEL + 1 }, (_, value) => h('button', {
            key: value, type: 'button', 'aria-pressed': value === level, title: levelHints[value], onClick: () => onLevel(value)
          }, 'L' + value)),
          h('span', { className: 'vr-small vr-muted' }, levelHints[level])),
        h('div', { className: 'vr-text' }, ...masked.paragraphs.map((tokens, p) => {
          if (masked.folded && !unfolded.has(p)) {
            return h('button', { key: p, type: 'button', className: 'vr-fold', onClick: () => setUnfolded(new Set([...unfolded, p])) }, '第 ' + (p + 1) + ' 段 · 点击显示提示')
          }
          return h('p', { key: p }, ...tokens.map((token, i) => {
            if (token.ch === '\n') return h('br', { key: i })
            if (!token.hidden) return token.ch
            const key = p + ':' + i
            const shown = revealed.has(key)
            return h('span', { key: i, className: 'vr-hidden' + (shown ? ' vr-shown' : ''), role: 'button', tabIndex: 0, 'aria-label': shown ? token.ch : '隐藏的字', onClick: () => flip(key) }, shown ? token.ch : '□')
          }))
        })),
        h('div', { className: 'vr-actions' },
          h('div', { className: 'vr-row' },
            level === 1 || level === 2 ? h('button', { type: 'button', onClick: () => setRound(round + 1) }, '换一批') : null,
            h('button', { type: 'button', onClick: () => showAll(true) }, '全显'),
            h('button', { type: 'button', onClick: () => showAll(false) }, '全隐'),
            h('button', { type: 'button', onClick: onExit }, '退出试背')),
          recitable
            ? h('div', { className: 'vr-row vr-rate', role: 'group', 'aria-label': '自评' },
              h('button', { type: 'button', title: '降一级', onClick: () => rate('forgot') }, '忘了'),
              h('button', { type: 'button', title: '等级不变', onClick: () => rate('fuzzy') }, '模糊'),
              h('button', { type: 'button', title: '升一级', onClick: () => rate('remembered') }, '记得'))
            : null))
    }

    function volumeBadge(row) {
      if (row.errors?.length) return '有错误'
      if (row.integrity === 'mismatch') return '原文已改动'
      if (!row.recitable) return verifiedLabels[String(row.verified)] || '未核对'
      return ''
    }

    // ---------------------------------------------------------------- views

    /** 「只能阅读」提示；书库里未核对的书卷可由用户确认已核对（只改 frontmatter 的 verified）。 */
    function Unverified({ app, volume }) {
      const [step, setStep] = useState('idle')
      const [error, setError] = useState('')
      const canMark = volume.origin === 'library' && volume.integrity === 'ok' && volume.verified === false
      async function mark() {
        setStep('busy')
        setError('')
        try {
          await app.markVerified(volume.id)
          setStep('done')
        } catch (failure) {
          setError(failure.message)
          setStep('confirm')
        }
      }
      return h('div', { className: 'vr-small vr-muted vr-row' },
        h('span', { className: 'vr-grow' }, '这一卷' + (volume.integrity === 'mismatch' ? '原文指纹不一致' : '还未核对') + '，只能阅读，不能背诵。'),
        canMark && step === 'idle' ? h('button', { type: 'button', onClick: () => setStep('confirm') }, '我已核对') : null,
        canMark && step !== 'idle' && step !== 'done' ? h('span', { className: 'vr-row' },
          h('span', null, '已逐字核对原文？'),
          h('button', { type: 'button', disabled: step === 'busy', onClick: () => void mark() }, '确认'),
          h('button', { type: 'button', disabled: step === 'busy', onClick: () => setStep('idle') }, '取消')) : null,
        error ? h('span', { className: 'vr-error' }, error) : null)
    }

    function Shelf({ rows, state, currentId, onPick, onClose, autoFocus = true }) {
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [tag, setTag] = useState('')
      const { recent, unread } = shelfItems(rows, state, query, filter, tag)
      const tags = shelfTags(rows)
      const first = [...recent, ...unread].find((item) => !item.row.errors.length)
      const many = rows.filter((row) => row.id).length > 6
      const row = (item) => {
        const badge = volumeBadge(item.row)
        const hits = item.sections.slice(0, 4)
        const volumeButton = h('button', {
          key: item.row.id, type: 'button', className: 'vr-shelf-row', 'aria-current': item.row.id === currentId,
          disabled: item.row.errors.length > 0, title: item.row.errors.length ? item.row.errors.join('；') : undefined,
          onClick: () => onPick(item.row)
        },
        h('span', { className: 'vr-spine', style: item.row.colorHex ? { background: item.row.colorHex } : undefined }),
        h('span', { className: 'vr-shelf-main' },
          h('span', { className: 'vr-shelf-title' }, item.row.title || item.row.file),
          h('span', { className: 'vr-shelf-meta' }, [item.row.dynasty, item.row.author].filter(Boolean).join(' · ') || ' ',
            ...(item.row.tags || []).filter((value) => LEVEL_TAGS.includes(value)).map((value) => h('span', { key: value, className: 'vr-tag' }, value)))),
        h('span', { className: 'vr-shelf-side' },
          h('span', null, item.position ? '读到 ' + toNumeral(item.position) + '／' + toNumeral(item.total) : toNumeral(item.total) + ' 节'),
          badge ? h('em', null, badge) : null))
        if (!hits.length) return volumeButton
        return h('div', { key: item.row.id, className: 'vr-shelf-group' }, volumeButton,
          h('div', { className: 'vr-shelf-hits' },
            ...hits.map((section) => h('button', { key: section.id, type: 'button', disabled: item.row.errors.length > 0, onClick: () => onPick(item.row, section.id) },
              toNumeral(section.position) + '　' + section.title + (section.author && section.author.includes(query.trim()) ? ' · ' + section.author : ''))),
            item.sections.length > hits.length ? h('span', { className: 'vr-muted' }, '另有 ' + (item.sections.length - hits.length) + ' 节') : null))
      }
      function enter() {
        if (!first) return
        const hit = first.own ? null : first.sections[0]
        onPick(first.row, hit?.id)
      }
      return h('div', { className: 'vr-shelf', onKeyDown: (event) => { if (event.key === 'Escape') onClose() } },
        h('input', {
          className: 'vr-search', type: 'search', placeholder: '搜书名、作者、篇名、标签，回车打开', autoFocus, value: query,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') enter() }
        }),
        many ? h('div', { className: 'vr-row vr-filters', role: 'group', 'aria-label': '筛选' },
          ...SHELF_FILTERS.map(([value, label]) => h('button', { key: value, type: 'button', 'aria-pressed': filter === value, onClick: () => setFilter(value) }, label))) : null,
        many && tags.length ? h('div', { className: 'vr-row vr-filters vr-tags', role: 'group', 'aria-label': '标签' },
          ...tags.map((value) => h('button', { key: value, type: 'button', 'aria-pressed': tag === value, title: tag === value ? '取消标签筛选' : '只看「' + value + '」', onClick: () => setTag(tag === value ? '' : value) }, value))) : null,
        h('div', { className: 'vr-shelf-list' },
          recent.length ? h('div', { className: 'vr-shelf-label' }, '最近读过') : null,
          ...recent.map(row),
          unread.length ? h('div', { className: 'vr-shelf-label' }, recent.length ? '未读' : '全部书卷') : null,
          ...unread.map(row),
          !recent.length && !unread.length ? h('p', { className: 'vr-muted vr-small' }, query || filter !== 'all' ? '没有匹配的书卷。语料里的篇目可以在任一会话里用刻书匠入藏。' : '书库里还没有书卷。在任一会话里用刻书匠（vibe-reader-engraver）入藏。') : null))
    }

    /**
     * 知人论世 for the section on screen: the section's own author (组诗) or the volume's, and the
     * section's background when the volume has per-section ones, else the volume background.
     */
    function aboutFor(library, row, section) {
      // Last segment = name (「魏晋 · 西晋 · 李密」→ 李密), as lib/about.js splitAuthorLabel; the volume
      // author field may carry a period too (author: 西晋·李密).
      const split = (label) => String(label || '').split(/[·・]/).map((part) => part.trim()).filter(Boolean)
      const parts = split(section?.meta?.author).length ? split(section?.meta?.author) : split(row?.author)
      const name = parts[parts.length - 1] || ''
      const dynasty = parts.length >= 2 ? parts.slice(0, -1).join('·') : row?.dynasty || ''
      const core = (value) => String(value || '').replace(/^[南北东西前后]/, '')
      const pool = (library?.authors || []).filter((author) => author.name === name && !author.errors?.length)
      const author = pool.find((entry) => core(entry.dynasty) === core(dynasty)) || pool[0] || null
      const entry = library?.backgrounds?.[row?.id]
      const usable = entry && !entry.errors?.length ? entry : null
      const own = usable?.sections?.[section?.id]?.text
      return { author, background: own?.length ? own : usable?.text || [], source: usable?.source || '' }
    }

    function AboutBlock({ about, open, onToggle }) {
      const { author, background } = about
      if (!author && !background.length) return null
      const courtesy = (author?.facts.find((fact) => /字|号/.test(fact.label))?.value || '').split(/[；;]/)[0]
      const lead = [author ? author.name + (author.life ? '（' + author.life + '）' : '') + (courtesy ? '　' + courtesy : '') : '', background.length ? '写作背景' : ''].filter(Boolean).join(' · ')
      const sources = [author?.source ? '小传据 ' + author.source : '', about.source ? '背景据 ' + about.source : ''].filter(Boolean).join('；')
      return h('details', { className: 'vr-about', open, onToggle: (event) => { if (event.currentTarget.open !== open) onToggle(event.currentTarget.open) } },
        h('summary', null, h('span', { className: 'vr-about-tag' }, '知人论世'), h('span', { className: 'vr-about-lead' }, lead)),
        h('div', { className: 'vr-about-body' },
          author ? h('div', { className: 'vr-about-row' }, h('span', { className: 'vr-about-label' }, '作者'),
            h('div', { className: 'vr-about-text' },
              author.facts.length ? h('dl', { className: 'vr-about-facts' }, ...author.facts.flatMap((fact, index) => [h('dt', { key: 'k' + index }, fact.label), h('dd', { key: 'v' + index }, fact.value)])) : null,
              ...author.bio.map((paragraph, index) => h('p', { key: index }, paragraph)))) : null,
          background.length ? h('div', { className: 'vr-about-row' }, h('span', { className: 'vr-about-label' }, '背景'),
            h('div', { className: 'vr-about-text' }, ...background.map((paragraph, index) => h('p', { key: index }, paragraph)))) : null,
          sources ? h('p', { className: 'vr-about-source' }, sources) : null))
    }

    /** 「唐 · 白居易」vs「唐·白居易」: spacing and the middle dot do not make a different author. */
    function sameAuthor(a, b) {
      const key = (text) => String(text || '').replace(/[\s·・]/g, '')
      return Boolean(key(b)) && key(a) === key(b)
    }

    function StudyView({ app, snapshot, shelfInRail = false }) {
      const { library, state } = snapshot
      const rows = library.volumes
      const volumeId = state.ui.volume && rows.some((row) => row.id === state.ui.volume) ? state.ui.volume : rows.find((row) => !row.errors.length)?.id
      const entry = volumeId ? snapshot.volumes[volumeId] : undefined
      const [reciting, setReciting] = useState(false)
      // First visit (no volume chosen yet): start on the shelf.
      const [shelfOpenState, setShelfOpen] = useState(!state.ui.volume || !volumeId)
      const shelfOpen = shelfInRail ? false : shelfOpenState
      const cellsRef = useRef(null)
      useEffect(() => { if (volumeId && !entry) app.ensureVolume(volumeId) }, [volumeId, entry])

      const volume = entry?.volume
      const sections = volume?.sections || []
      const savedSection = state.volumes[volumeId]?.lastSection
      const index = Math.max(0, sections.findIndex((section) => section.id === savedSection))
      const section = sections[index]
      useEffect(() => {
        setReciting(false)
      }, [volumeId, section?.id])
      const showTranslation = state.settings.translationOpen !== false
      useEffect(() => {
        cellsRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      }, [volumeId, index, shelfOpen])

      function go(target) {
        if (!sections[target]) return
        app.progress(volumeId, sections[target].id)
      }
      const cardKey = volume && section ? volume.id + '#' + section.id : ''
      const glossMode = volume ? glossModeFor(volume, state) : 'inline'
      // 句下 already shows the notes found in the text; the list keeps only the rest (e.g. notes on the title).
      const listedNotes = !section ? [] : glossMode === 'below' ? notesOutsideText(section) : section.notes

      const currentRow = rows.find((row) => row.id === volumeId)
      const accent = volume?.colorHex || currentRow?.colorHex
      function pick(row, sectionId) {
        app.progress(row.id, sectionId || state.volumes[row.id]?.lastSection || row.sectionIds?.[0] || 's1')
        setShelfOpen(false)
      }
      function onKeyDown(event) {
        if (shelfOpen || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return
        if (event.key === 'ArrowLeft') go(index - 1)
        else if (event.key === 'ArrowRight') go(index + 1)
      }
      const headParts = [
        h('span', { key: 'spine', className: 'vr-spine' }),
        h('span', { key: 'title', className: 'vr-voltitle' }, (state.ui.volume && currentRow?.title) || '选一卷'),
        h('span', { key: 'meta', className: 'vr-volmeta' }, state.ui.volume ? [currentRow?.dynasty, currentRow?.author].filter(Boolean).join(' · ') : '')
      ]
      const head = shelfInRail
        ? h('div', { className: 'vr-volhead' }, ...headParts)
        : h('button', { type: 'button', className: 'vr-volhead', 'aria-expanded': shelfOpen, title: '切换书卷', onClick: () => setShelfOpen(!shelfOpen) },
          ...headParts, h('span', { className: 'vr-volswitch' }, shelfOpen ? '收起' : '书架'))
      // No volume chosen yet (or the chosen one is gone): point at the rail instead of silently opening the first.
      if (shelfInRail && !(state.ui.volume && rows.some((row) => row.id === state.ui.volume))) {
        return h('div', { className: 'vr-body' }, h('p', { className: 'vr-muted' }, rows.length ? '从右侧书架选一卷。' : '书库里还没有书卷。在任一会话里用刻书匠（vibe-reader-engraver）入藏。'))
      }
      if (shelfOpen || !volumeId) {
        return h('div', { className: 'vr-body' + (accent ? ' vr-accent' : ''), style: accent ? { '--vr-accent': accent } : undefined },
          head,
          h(Shelf, { rows, state, currentId: volumeId, onPick: pick, onClose: () => setShelfOpen(false) }))
      }
      return h('div', { className: 'vr-body' + (accent ? ' vr-accent' : ''), style: accent ? { '--vr-accent': accent } : undefined, tabIndex: -1, onKeyDown },
        head,
        entry?.status === 'loading' || (volumeId && !entry) ? h('p', { className: 'vr-muted' }, '展卷中…') : null,
        entry?.status === 'error' ? h('p', { className: 'vr-error' }, entry.error) : null,
        volume?.errors?.length ? h('div', { className: 'vr-notice' }, h('span', null, '这一卷有格式错误，暂不能阅读：' + volume.errors.join('；'))) : null,
        volume && !volume.errors.length && volume.integrity === 'mismatch' ? h('div', { className: 'vr-notice' }, h('span', null, '原文与入藏时的指纹不一致，可能被改动过。已暂停背诵，核对后用 scripts/fingerprint.mjs --write 更新指纹。')) : null,
        section && !volume.errors.length ? [
          h('div', { key: 'cells', className: 'vr-row' },
            h('div', { ref: cellsRef, className: 'vr-cells vr-grow', role: 'group', 'aria-label': '各节（← → 翻节）' }, ...sections.map((item, position) => {
              const level = state.cards[volume.id + '#' + item.id]?.level || 0
              return h('button', {
                key: item.id, type: 'button', title: '第' + toNumeral(position + 1) + '節 · ' + item.title + (level ? ' · 背诵 L' + level : ''), 'aria-current': position === index,
                'data-level': level || undefined,
                style: level ? { '--lv': level / MAX_LEVEL } : undefined,
                onClick: () => go(position)
              }, toNumeral(position + 1))
            }))),
          h(AboutBlock, { key: 'about', about: aboutFor(library, currentRow, section), open: state.settings.aboutOpen === true, onToggle: (open) => app.send({ op: 'settings', patch: { aboutOpen: open } }) }),
          index > 0 ? h('button', { key: 'prev', type: 'button', className: 'vr-dim', onClick: () => go(index - 1) }, '↑ ' + sections[index - 1].title + '　' + sections[index - 1].paragraphs[0].text.replace(/\n/g, ' ')) : null,
          h('h3', { key: 'title', className: 'vr-title' }, section.title,
            section.meta.author && sameAuthor(section.meta.author, [currentRow?.dynasty, currentRow?.author].filter(Boolean).join(' · ')) === false
              ? h('span', { className: 'vr-small vr-muted' }, '　' + section.meta.author) : null),
          section.meta.guide ? h('p', { key: 'guide', className: 'vr-guide' }, section.meta.guide) : null,
          reciting
            ? h(Recite, {
              key: 'recite',
              cardKey,
              paragraphs: section.paragraphs.map((paragraph) => paragraph.text),
              level: state.cards[cardKey]?.level || 0,
              recitable: volume.recitable,
              onLevel: (level) => app.send({ op: 'level', key: cardKey, level }),
              onRate: (rating) => app.send({ op: 'rate', key: cardKey, rating }),
              onExit: () => setReciting(false)
            })
            : h(SectionText, { key: 'text-' + cardKey + '-' + glossMode, section, mode: glossMode }),
          !reciting && showTranslation && section.translation ? h('p', { key: 'trans', className: 'vr-trans' }, section.translation) : null,
          !reciting && listedNotes.length ? h('details', {
            key: 'notes-' + cardKey, className: 'vr-notes', open: state.settings.notesOpen !== false,
            onToggle: (event) => {
              const open = event.currentTarget.open
              if (open !== (state.settings.notesOpen !== false)) app.send({ op: 'settings', patch: { notesOpen: open } })
            }
          },
            h('summary', null, (glossMode === 'below' ? '其余注释（' : '本节注释（') + listedNotes.length + '）'),
            h('ul', null, ...listedNotes.map((note) => h('li', { key: note.word }, h('b', null, note.word), note.reading ? ' ' + note.reading : '', '：' + note.gloss)))) : null,
          h('div', { key: 'actions', className: 'vr-actions' },
            h('div', { className: 'vr-row' },
              h('button', { type: 'button', disabled: index === 0, onClick: () => go(index - 1) }, '‹ 上一节'),
              h('button', { type: 'button', disabled: index >= sections.length - 1, onClick: () => go(index + 1) }, '下一节 ›')),
            h('div', { className: 'vr-row' },
              !reciting && section.translation ? h('button', { type: 'button', 'aria-pressed': showTranslation, title: showTranslation ? '收起译文' : '展开译文', onClick: () => app.send({ op: 'settings', patch: { translationOpen: !showTranslation } }) }, '译') : null,
              !reciting && section.notes.length ? h('button', {
                type: 'button', title: '注释显示：' + GLOSS_LABELS[glossMode] + '（点击切换：夹注 → 句下 → 点词）',
                onClick: () => app.send({ op: 'gloss', volumeId: volume.id, sectionId: section.id, mode: GLOSS_MODES[(GLOSS_MODES.indexOf(glossMode) + 1) % GLOSS_MODES.length] })
              }, GLOSS_LABELS[glossMode]) : null,
              !reciting && volume.recitable ? h('button', { type: 'button', onClick: () => setReciting(true) }, '试背') : null)),
          !volume.recitable && !volume.errors.length ? h(Unverified, { key: 'locked', app, volume }) : null,
          index < sections.length - 1 ? h('button', { key: 'next', type: 'button', className: 'vr-dim', onClick: () => go(index + 1) }, '↓ ' + sections[index + 1].title + '　' + sections[index + 1].paragraphs[0].text.replace(/\n/g, ' ')) : null
        ] : null)
    }

    function EncounterView({ app, snapshot }) {
      const { library, state, encounterKey } = snapshot
      const cards = library.cards
      const card = cards.find((item) => item.key === encounterKey) || null
      const [reciting, setReciting] = useState(false)
      useEffect(() => {
        if (!card && cards.length) app.autoPick(() => pickCard(cards, state.resurface, null))
      }, [card, cards.length])
      useEffect(() => { setReciting(false) }, [encounterKey])

      function next() {
        const picked = pickCard(cards, state.resurface, encounterKey)
        if (!picked) return
        app.setEncounter(picked.key)
        app.send({ op: 'seen', key: picked.key })
      }
      if (!cards.length) return h('div', { className: 'vr-body' }, h('p', { className: 'vr-muted' }, '书库里还没有卡片：诗卷的每一首、文章里的每个名句（==…==）都会成为偶遇卡。'))
      if (!card) return h('div', { className: 'vr-body' }, h('p', { className: 'vr-muted' }, '翻卡中…'))

      const vertical = card.kind === 'poem' && state.settings.vertical && fitsVertical(card.text)
      const level = state.cards[card.key]?.level || 0
      const accent = library.volumes.find((row) => row.id === card.volumeId)?.colorHex
      return h('div', { className: 'vr-body' },
        h('div', { className: 'vr-card' + (accent ? ' vr-accent' : ''), style: accent ? { '--vr-accent': accent } : undefined },
          h('div', { className: 'vr-small vr-muted' }, card.kind === 'poem' ? '诗' : '名句', level ? ' · L' + level : ''),
          reciting
            ? h('div', { style: { width: '100%', textAlign: 'left' } }, h(Recite, {
              cardKey: card.key,
              paragraphs: card.text.split('\n\n'),
              level,
              recitable: card.recitable,
              onLevel: (value) => app.send({ op: 'level', key: card.key, level: value }),
              onRate: (rating) => app.send({ op: 'rate', key: card.key, rating }),
              onExit: () => setReciting(false)
            }))
            : h('div', { className: 'vr-text' + (vertical ? ' vr-vertical' : '') }, ...lines(card.text)),
          h('div', { className: 'vr-small vr-muted' }, card.kind === 'poem' ? '《' + card.title + '》 ' + card.author : '——《' + card.title + '》 ' + card.author)),
        h('div', { className: 'vr-actions' },
          h('div', { className: 'vr-row' },
            !reciting && card.recitable ? h('button', { type: 'button', onClick: () => setReciting(true) }, '试背') : null,
            h('button', {
              type: 'button',
              onClick: () => {
                app.progress(card.volumeId, card.sectionId)
                app.send({ op: 'view', view: 'study' })
              }
            }, '在修业中打开'),
            card.kind === 'poem' && fitsVertical(card.text) ? h('button', { type: 'button', 'aria-pressed': state.settings.vertical, onClick: () => app.send({ op: 'settings', patch: { vertical: !state.settings.vertical } }) }, '竖排') : null),
          h('button', { type: 'button', onClick: next }, '下一张 ›')))
    }

    function StatusChip({ view, open, onToggle }) {
      const text = view.tone === 'needs-you' ? view.needsYou.length + ' 个会话在等你'
        : view.tone === 'done' ? view.done.length + ' 个会话已完成'
            : view.tone === 'waiting' ? '运行中 ' + view.running.length
              : '空闲'
      return h('button', { type: 'button', className: 'vr-chip vr-tone-' + view.tone, 'aria-expanded': open, title: (view.board ? '会话看板里正在执行的会话' : '全部会话的状态') + (open ? '，点击收起' : '，点击展开'), onClick: onToggle }, text)
    }

    // The 会话看板 client module carries the official agent logos (embedded data URIs); reuse them when it is loaded.
    let boardModule = null
    let boardModuleTriedAt = -Infinity
    function boardLogos() {
      if (!boardModule && Date.now() - boardModuleTriedAt > 30000) {
        boardModuleTriedAt = Date.now()
        try { boardModule = require(BOARD.module) || null } catch { boardModule = null }
      }
      return boardModule?.AGENT_LOGOS || null
    }

    function AgentLogo({ agent }) {
      const src = boardLogos()?.[agent]
      return h('span', { className: 'vr-agent-logo vr-agent-' + agent + (src ? ' vr-has-logo' : ''), 'aria-hidden': true },
        src ? h('img', { src, alt: '', draggable: false }) : (AGENTS[agent] || 'Agent').charAt(0))
    }

    /** Running sessions from the 会话看板: logo, task title, agent · client · project, running time. */
    function AgentPanel({ view, feed, now, openBoard }) {
      const loading = feed.status === 'idle'
      return h('div', { className: 'vr-sheet vr-session-list vr-agents' },
        h('div', { className: 'vr-row' },
          h('h4', null, loading ? '会话看板' : '会话看板 · 运行中 ' + view.running.length),
          h('span', { className: 'vr-grow' }),
          h('button', { type: 'button', className: 'vr-link', title: '切到会话看板', onClick: openBoard }, '打开看板 ›')),
        feed.status === 'error' ? h('span', { className: 'vr-small vr-muted', title: feed.error }, '暂时读不到会话看板，正在重试') : null,
        loading ? h('span', { className: 'vr-small vr-muted' }, '正在读取…')
          : !view.running.length && feed.status === 'ok' ? h('span', { className: 'vr-small vr-muted' }, '没有正在执行的会话。') : null,
        view.running.length ? h('ul', null, ...view.running.map((item) => h('li', { key: item.id },
          h('button', { type: 'button', className: 'vr-agent', title: item.title + (item.cwd ? '\n' + item.cwd : '') + '\n点击切到会话看板', onClick: openBoard },
            h(AgentLogo, { agent: item.agent }),
            h('span', { className: 'vr-agent-text' },
              h('span', { className: 'vr-agent-title' }, item.title),
              h('span', { className: 'vr-agent-meta' }, item.meta)),
            h('span', { className: 'vr-agent-time' }, item.since !== undefined ? durationText(now - item.since) : ''))))) : null)
    }

    function StatusPanel({ view, now, openSession }) {
      const group = (title, items, meta) => items.length ? [
        h('h4', { key: title + '-h' }, title),
        h('ul', { key: title + '-l' }, ...items.map((item) => h('li', { key: item.id },
          h('button', { type: 'button', className: 'vr-session', title: item.title, onClick: () => openSession(item.id) },
            h('span', null, item.title + (item.isMain ? '（主视图）' : '')),
            h('span', null, meta(item))))))
      ] : []
      const rows = [
        ...group('需要你处理', view.needsYou, (item) => pendingLabels[item.pendingKind] || item.pendingKind),
        ...group('已完成，待查看', view.done, (item) => [item.finishedAt !== undefined ? durationText(now - item.finishedAt) + '前' : '', item.lastMs !== undefined ? '用时 ' + durationText(item.lastMs) : ''].filter(Boolean).join(' · ') || '未读'),
        ...group('运行中', view.running, (item) => item.since !== undefined ? '已运行 ' + durationText(now - item.since) : '')
      ]
      return h('div', { className: 'vr-sheet vr-session-list' }, ...(rows.length ? rows : [h('span', { key: 'none', className: 'vr-muted vr-small' }, '没有运行中、需要你或刚完成的会话。')]),
        h('span', { className: 'vr-small vr-muted' }, '点一条跳到那个会话；正在读时，阅读器会跟过去。'))
    }

    const FONT_SCALES = [[0.9, '小'], [1, '标准'], [1.15, '大'], [1.3, '更大'], [1.5, '特大']]

    function SheetRow({ label, children }) {
      return h('div', { className: 'vr-sheet-row' }, h('span', { className: 'vr-sheet-label' }, label), h('div', { className: 'vr-row' }, ...[].concat(children)))
    }

    function SettingsPanel({ app, snapshot }) {
      const { state, library } = snapshot
      const settings = state.settings
      const set = (patch) => app.send({ op: 'settings', patch })
      const scale = settings.fontScale || 1
      const builtin = library.volumes.filter((row) => row.origin === 'builtin').length
      const mine = library.volumes.filter((row) => row.origin === 'library').length
      const mineRoot = library.roots.find((root) => root.origin === 'library')
      return h('div', { className: 'vr-sheet', role: 'group', 'aria-label': '设置' },
        h(SheetRow, { label: '字号' },
          h('div', { className: 'vr-seg', role: 'group', 'aria-label': '字号' }, ...FONT_SCALES.map(([value, label]) => h('button', {
            key: value, type: 'button', 'aria-pressed': Math.abs(scale - value) < 0.01, title: Math.round(value * 100) + '%', onClick: () => set({ fontScale: value })
          }, label)))),
        h(SheetRow, { label: '跟随' }, [
          h('button', { key: 's', type: 'button', role: 'switch', className: 'vr-switch', 'aria-checked': settings.followSessions, 'aria-label': '切换会话时带上阅读器', onClick: () => set({ followSessions: !settings.followSessions }) }),
          h('span', { key: 'h', className: 'vr-sheet-hint' }, '正在读时切换会话，阅读器跟过去')
        ]),
        h(SheetRow, { label: '书库' },
          h('div', { style: { display: 'grid', gap: '2px', minWidth: 0 } },
            h('span', null, '内置 ' + builtin + ' 卷 · 我的书库 ' + mine + ' 卷'),
            mineRoot ? h('span', { className: 'vr-path', title: mineRoot.dir }, mineRoot.exists ? mineRoot.dir : mineRoot.dir + '（尚未创建）') : null)))
    }

    // ---------------------------------------------------------------- plugin

    function apply(ctx) {
      const app = createAppStore()
      const tracker = createTracker(ctx.uiSession?.sessionStatus)
      ctx.effect(() => tracker.start(), 'vibe-reader: session status')
      const listStore = ctx.sessions?.list ?? { getSnapshot: () => undefined, subscribe: () => () => {} }
      const boardFeed = createBoardFeed()

      // sessionId -> true while visible there, or the time it was hidden (grace for hosts that unmount first).
      const visibleIn = new Map()
      function wasVisible(sessionId) {
        const value = visibleIn.get(sessionId)
        return value === true || (typeof value === 'number' && Date.now() - value < HIDDEN_GRACE_MS)
      }
      function openIn(sessionId, attempt = 0) {
        try {
          ctx.sidebarRight.openTab(kind)
        } catch (error) {
          if (attempt === 0) requestAnimationFrame(() => { if (ctx.sidebarRight.mounted.getSnapshot() === sessionId) openIn(sessionId, 1) })
          else console.warn('[vibe-reader] carry-over failed', error)
        }
      }
      if (ctx.sidebarRight?.mounted) {
        const startFollow = createFollower({
          mounted: ctx.sidebarRight.mounted,
          isVisible: wasVisible,
          enabled: () => app.getSnapshot().state?.settings?.followSessions !== false,
          open: openIn,
          schedule: (task) => setTimeout(task, 0)
        })
        ctx.effect(() => startFollow(), 'vibe-reader: follow sessions')
      }
      ctx.effect(() => () => { app.flush() }, 'vibe-reader: flush progress')

      // 入藏 happens inside an Agent turn: reread the library shortly after any turn ends.
      ctx.effect(() => {
        let timer = null
        const stop = watchTurnEnds(tracker, () => {
          if (!app.getSnapshot().library) return
          clearTimeout(timer)
          timer = setTimeout(() => app.refreshIfStale(0), 800)
        })
        return () => {
          stop()
          clearTimeout(timer)
        }
      }, 'vibe-reader: refresh after agent turns')

      function openSession(id) {
        try { ctx.uiWorkspace?.openSession(id) } catch (error) { console.warn('[vibe-reader] openSession failed', error) }
      }

      function openBoard() {
        try { ctx.layout.selectPanel(BOARD.panel) } catch (error) { console.warn('[vibe-reader] open 会话看板 failed', error) }
      }

      function openMain() {
        try { ctx.layout.selectPanel(MAIN_ID) } catch (error) { console.warn('[vibe-reader] open main panel failed', error) }
      }

      /** Right sidebar tab: one per session, visible while it is the shown tab. */
      function ReaderPane({ sessionId, useTabInfo }) {
        const { tab } = useTabInfo()
        return h(ReaderView, { sessionId, visible: tab.visible })
      }

      /** Main area (left sidebar entry): mounted only while selected; wide centred column, can go fullscreen. */
      function MainPane() {
        return h(ReaderView, { visible: true, main: true })
      }

      function ReaderView({ sessionId, visible, main = false }) {
        const tab = { visible }
        const root = useRef(null)
        const [fullscreen, setFullscreen] = useState(false)
        // Wide main area: shelf and panels in a right rail. Narrower: same arrangement as the sidebar tab.
        const [wide, setWide] = useState(true)
        useEffect(() => {
          if (!main || typeof ResizeObserver === 'undefined' || !root.current) return
          const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= MAIN_WIDE_MIN))
          observer.observe(root.current)
          return () => observer.disconnect()
        }, [main])
        const rail = main && wide
        useEffect(() => {
          if (!main || typeof document === 'undefined') return
          const sync = () => setFullscreen(Boolean(root.current) && document.fullscreenElement === root.current)
          document.addEventListener('fullscreenchange', sync)
          return () => document.removeEventListener('fullscreenchange', sync)
        }, [main])
        const canFullscreen = main && typeof document !== 'undefined' && document.fullscreenEnabled !== false
        function toggleFullscreen() {
          try {
            const done = document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen()
            done?.catch?.((error) => console.warn('[vibe-reader] fullscreen failed', error))
          } catch (error) {
            console.warn('[vibe-reader] fullscreen failed', error)
          }
        }
        const snapshot = useSyncExternalStore(app.subscribe, app.getSnapshot)
        const tracked = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot)
        const list = useSyncExternalStore(listStore.subscribe, listStore.getSnapshot)
        const feed = useSyncExternalStore(boardFeed.subscribe, boardFeed.getSnapshot)
        const [now, setNow] = useState(Date.now())
        // The session list starts open and folds from the chip; settings open on their own from ⚙.
        const [sessionsOpen, setSessionsOpen] = useState(true)
        const [settingsOpen, setSettingsOpen] = useState(false)

        useEffect(() => {
          if (!tab.visible || !sessionId) return
          visibleIn.set(sessionId, true)
          return () => { visibleIn.set(sessionId, Date.now()) }
        }, [tab.visible, sessionId])
        useEffect(() => tab.visible ? boardFeed.retain() : undefined, [tab.visible])
        useEffect(() => {
          if (!tab.visible) {
            app.flush()
            return
          }
          app.refreshIfStale()
          const timer = setInterval(() => {
            setNow(Date.now())
            app.refreshIfStale(REFRESH_POLL_MS) // picks up edits made outside DSH, e.g. in Obsidian
          }, 1000)
          return () => clearInterval(timer)
        }, [tab.visible])

        // With the 会话看板 installed, status means its running sessions (every agent); otherwise DSH's own.
        const view = feed.status === 'missing' ? boardView(tracked, list, now) : agentBoardView(feed)
        const current = snapshot.state?.ui?.view || 'encounter'
        const panels = [
          settingsOpen && snapshot.state ? h(SettingsPanel, { key: 'settings', app, snapshot }) : null,
          sessionsOpen ? (view.board ? h(AgentPanel, { key: 'sessions', view, feed, now, openBoard }) : h(StatusPanel, { key: 'sessions', view, now, openSession })) : null
        ].filter(Boolean)
        const body = snapshot.status === 'error'
          ? h('div', { className: 'vr-body' }, h('p', { className: 'vr-error' }, snapshot.error), h('button', { type: 'button', onClick: () => app.load() }, '重试'))
          : !snapshot.library || !snapshot.state
            ? h('div', { className: 'vr-body' }, h('p', { className: 'vr-muted' }, '取书中…'))
            : current === 'study'
              ? h(StudyView, { app, snapshot, shelfInRail: rail })
              : h(EncounterView, { app, snapshot })
        function pickFromRail(row, sectionId) {
          app.progress(row.id, sectionId || snapshot.state.volumes[row.id]?.lastSection || row.sectionIds?.[0] || 's1')
          if (current !== 'study') app.send({ op: 'view', view: 'study' })
        }
        const railShelf = rail && snapshot.library && snapshot.state
          ? h('div', { key: 'shelf', className: 'vr-rail-shelf' }, h(Shelf, { rows: snapshot.library.volumes, state: snapshot.state, currentId: current === 'study' ? snapshot.state.ui.volume : null, onPick: pickFromRail, onClose: () => {}, autoFocus: false }))
          : null

        return h('section', { ref: root, className: main ? (rail ? 'vr vr-main vr-wide' : 'vr vr-main') : 'vr', 'aria-label': NAME, style: { '--vr-scale': snapshot.state?.settings?.fontScale || 1 } },
          h('style', null, styles),
          h('div', { className: 'vr-head' },
            h('div', { className: 'vr-row' },
              main ? h('span', { className: 'vr-main-title' }, NAME) : null,
              h('div', { className: 'vr-seg', role: 'group', 'aria-label': '视图' },
                h('button', { type: 'button', 'aria-pressed': current === 'encounter', disabled: !snapshot.state, onClick: () => app.send({ op: 'view', view: 'encounter' }) }, '偶遇'),
                h('button', { type: 'button', 'aria-pressed': current === 'study', disabled: !snapshot.state, onClick: () => app.send({ op: 'view', view: 'study' }) }, '修业')),
              h('span', { className: 'vr-grow' }),
              h(StatusChip, { view, open: sessionsOpen, onToggle: () => setSessionsOpen(!sessionsOpen) }),
              h('button', { type: 'button', className: 'vr-refresh' + (snapshot.refreshing ? ' vr-spinning' : ''), title: '重新读取书库', 'aria-label': '重新读取书库', disabled: !snapshot.library || snapshot.refreshing, onClick: () => app.load() }, '↻'),
              canFullscreen ? h('button', { type: 'button', title: fullscreen ? '退出全屏（Esc）' : '全屏阅读', 'aria-label': fullscreen ? '退出全屏' : '全屏阅读', 'aria-pressed': fullscreen, onClick: toggleFullscreen }, '⛶') : null,
              h('button', { type: 'button', title: '设置', 'aria-expanded': settingsOpen, disabled: !snapshot.state, onClick: () => setSettingsOpen(!settingsOpen) }, '⚙')),
            (snapshot.added || []).length ? h('div', { className: 'vr-notice vr-small vr-added' },
              h('span', null, '新入藏：'),
              ...snapshot.added.map((item) => h('button', {
                key: item.id, type: 'button', title: '在修业中打开',
                onClick: () => {
                  app.progress(item.id, item.firstSection || 's1')
                  app.send({ op: 'view', view: 'study' })
                  app.dismissAdded(item.id)
                }
              }, '《' + item.title + '》')),
              h('span', { className: 'vr-grow' }),
              h('button', { type: 'button', onClick: () => app.dismissAdded() }, '知道了')) : null,
            rail ? null : panels,
            snapshot.notice ? h('div', { className: 'vr-notice vr-small' }, h('span', { className: 'vr-grow' }, snapshot.notice), h('button', { type: 'button', onClick: app.dismissNotice }, '知道了')) : null),
          rail
            ? h('div', { className: 'vr-main-wrap' }, body, h('aside', { className: 'vr-rail', 'aria-label': '书架、会话与设置' },
              settingsOpen && snapshot.state ? h(SettingsPanel, { key: 'settings', app, snapshot }) : null,
              railShelf,
              sessionsOpen ? (view.board ? h(AgentPanel, { key: 'sessions', view, feed, now, openBoard }) : h(StatusPanel, { key: 'sessions', view, now, openSession })) : null))
            : body)
      }

      /** Open 闲庭 in the on-screen session; when it is already the visible tab, collapse the column instead. */
      function toggleReader() {
        try {
          const active = ctx.sidebarRight.active()
          if (active?.kind === kind && ctx.sidebarRight.isExpanded()) ctx.sidebarRight.hide(active.id)
          else ctx.sidebarRight.openTab(kind)
        } catch (error) {
          console.warn('[vibe-reader] toggle failed', error)
        }
      }

      function HeaderButton() {
        const label = NAME + '：读一则古诗文'
        if (primitives?.Button) {
          return h(primitives.Button, { size: 'sm', 'aria-label': label, title: label, onClick: toggleReader }, h(BookIcon))
        }
        return h('button', { type: 'button', className: 'vr-head-btn', 'aria-label': label, title: label, onClick: toggleReader }, h('style', null, styles), h(BookIcon))
      }

      /** Left sidebar footer entry, next to 会话看板 / 任务看板: opens 闲庭信步 in the main area, highlighted while open. */
      function SidebarEntry(props) {
        const wide = props.wide === true
        const active = typeof props.usePanelInfo === 'function' ? props.usePanelInfo((info) => info?.activePanelId === MAIN_ID) : false
        return h('button', { type: 'button', className: wide ? 'dshx-entry' : 'dshx-entry dshx-rail', title: wide ? undefined : NAME, 'aria-label': '打开' + NAME, 'aria-current': active ? 'page' : undefined, onClick: openMain },
          h('span', { className: 'dshx-entry-icon' }, h(BookIcon, { size: 16 })), wide ? h('span', { className: 'dshx-entry-label' }, NAME) : null)
      }

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const style = document.createElement('style')
        style.dataset.dshxSidebar = 'dsh-vibe-reader'
        style.textContent = SIDEBAR_CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'vibe-reader: sidebar entry style')
      ctx.effect(() => ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: MAIN_ID, id: MAIN_ID, label: NAME }, MainPane)
      ), 'vibe-reader: main panel')
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'vibe-reader', order: 40, label: NAME }, SidebarEntry)
      ), 'vibe-reader: sidebar entry')

      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'vibe-reader' }, HeaderButton)
      ), 'vibe-reader: header button')

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: tabId,
        kind,
        title: () => NAME,
        keepMounted: true,
        guide: [{ id: kind, order: 36, title: () => NAME, description: () => '间隙读一则古诗文', icon: BookIcon }]
      }), 'vibe-reader: tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tabId }, ReaderPane)
      ), 'vibe-reader: body')
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiSession', 'sessions', 'uiWorkspace', 'layout'],
      apply,
      __test: { track, boardView, agentBoardView, createBoardFeed, createTracker, sameAuthor, aboutFor, createFollower, maskParagraphs, sectionGlosses, textPieces, renderPlan, glossLines, pickCard, fitsVertical, optimistic, createAppStore, toNumeral, shelfItems, shelfTags, glossModeFor, lineUnits, rubyOf, notesOutsideText, watchTurnEnds, views: { StudyView, Shelf, EncounterView, StatusChip, StatusPanel, AgentPanel, SettingsPanel, AboutBlock, Recite, SectionText } }
    }
  }
})
