window.__ModuleLoader__.load({
  id: 'dsh-vibe-reader',
  factory(require) {
    const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = require('react')
    let primitives = null
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') || null } catch { primitives = null }
    const kind = 'vibe-reader'
    const tabId = 'dsh-vibe-reader/reader'
    const api = { library: 'api/vibe-reader/library', volume: 'api/vibe-reader/volume', state: 'api/vibe-reader/state' }
    const MAX_LEVEL = 5
    const MAIN_DONE_HOLD_MS = 60000
    const PROGRESS_DELAY_MS = 500
    const HIDDEN_GRACE_MS = 1500
    const GLOSS_INLINE_MAX = 24
    const HAN = /\p{Script=Han}/u
    const levelHints = ['全文', '每 5 字隐 1 字', '每 3 字隐 1 字', '只留每句首字', '只留标点和分段', '全部隐藏']
    const pendingLabels = { approval: '审批', 'plan-review': '计划确认', question: '提问' }
    const verifiedLabels = { true: '人工核对', corpus: '已对照语料', false: '未核对' }

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
    function boardView(tracked, list, now, readAfterMs) {
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
      const longestMs = running.length ? now - (running[0].since ?? now) : 0
      const tone = needsYou.length ? 'needs-you'
        : done.length ? 'done'
          : running.length ? (longestMs >= readAfterMs ? 'reading-window' : 'waiting')
            : 'idle'
      return { tone, needsYou, done, running, longestMs }
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
        pieces.push({
          text: text.slice(start, end),
          quote: quotes.some((quote) => start >= quote.start && end <= quote.end),
          noted: glosses.some((gloss) => start >= gloss.start && end <= gloss.end),
          glossesAfter: glosses.filter((gloss) => gloss.end === end)
        })
      }
      return pieces
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

    /**
     * Shelf rows: recently read first (newest first), then the rest in library
     * order. The query matches title, author, dynasty and tags, and also each
     * section's title and poem author — those hits are listed so a click opens
     * that section directly.
     */
    function shelfItems(rows, state, query = '', filter = 'all') {
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
      ))
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
        async load() {
          set({ status: value.library ? value.status : 'loading', error: '' })
          try {
            await flush()
            await chain
            const data = await request(api.library)
            base = data.state
            const revisions = new Map(data.volumes.map((row) => [row.id, row.revision]))
            const volumes = Object.fromEntries(Object.entries(value.volumes).filter(([id, entry]) => entry.status === 'ready' && entry.volume.revision === revisions.get(id)))
            loadedAt = Date.now()
            set({
              status: 'ready',
              library: data,
              volumes,
              state: display(),
              notice: data.recovered ? 'state.json 无法解析，已另存为 ' + data.recovered + '，进度从头开始' : value.notice
            })
          } catch (error) {
            set({ status: 'error', error: error.message })
          }
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
          if (value.status === 'loading' || Date.now() - loadedAt < maxAgeMs) return
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
        dismissNotice() {
          set({ notice: '' })
        }
      }
    }

    // ---------------------------------------------------------------- view helpers

    const styles = `
.vr{--vr-cinnabar:color-mix(in srgb,#c3272b 82%,currentColor);--vr-line:color-mix(in srgb,currentColor 14%,transparent);--vr-soft:color-mix(in srgb,currentColor 6%,transparent);display:flex;flex-direction:column;height:100%;box-sizing:border-box;font-size:13px;overflow:hidden}
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
.vr-chip{border-radius:999px!important;padding:2px 10px!important;font-size:12px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.vr-tone-needs-you{background:color-mix(in srgb,#c3272b 26%,transparent)!important}
.vr-tone-done{background:color-mix(in srgb,#e9c46a 32%,transparent)!important}
.vr-tone-reading-window{background:color-mix(in srgb,#5a9e7c 26%,transparent)!important}
.vr-tone-idle,.vr-tone-waiting{opacity:.75}
.vr-pop{display:grid;gap:6px;padding:8px;border:1px solid var(--vr-line);border-radius:8px;background:var(--vr-soft)}
.vr-pop h4{margin:2px 0 0;font-size:12px;opacity:.75}
.vr-pop ul{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.vr-session{display:flex!important;gap:8px;width:100%;text-align:left;align-items:baseline}
.vr-session span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vr-session span:last-child{flex:none;opacity:.7;font-size:11.5px}
.vr-body{flex:1;overflow:auto;padding:12px 14px 18px;display:grid;gap:12px;align-content:start}
.vr-muted{opacity:.65}
.vr-small{font-size:11.5px}
.vr-notice{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:6px;background:color-mix(in srgb,#e9c46a 22%,transparent)}
.vr-text{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;font-size:15.5px;line-height:1.95;letter-spacing:.02em}
.vr-text p{margin:0 0 .6em}
.vr-quote{background:color-mix(in srgb,#e9c46a 20%,transparent);border-radius:2px}
.vr-noted{text-decoration:underline dotted color-mix(in srgb,var(--vr-cinnabar) 70%,transparent);text-underline-offset:4px}
.vr-keep{white-space:nowrap}
.vr-gloss{white-space:normal;display:inline-flex;flex-direction:column;vertical-align:middle;font-size:9.5px;line-height:1.15;color:var(--vr-cinnabar);margin:0 2px;letter-spacing:0;font-family:inherit;cursor:pointer;max-width:12em}
.vr-gloss.vr-open{display:inline;font-size:11px;vertical-align:baseline}
.vr-title{margin:0;font-size:17px;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif}
.vr-guide{margin:0;padding:4px 8px;border-left:2px solid var(--vr-line);opacity:.8;font-size:12.5px}
.vr-body:focus{outline:none}
.vr-volhead{display:flex!important;align-items:center;gap:8px;width:100%;border:0!important;padding:2px 0!important;text-align:left;background:transparent!important}
.vr-spine{flex:none;width:4px;align-self:stretch;min-height:20px;border-radius:2px;background:var(--vr-accent,color-mix(in srgb,currentColor 22%,transparent))}
.vr-voltitle{flex:none;max-width:60%;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;font-size:17px;font-weight:600;color:var(--vr-accent,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-volmeta{flex:1;min-width:0;font-size:12px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-volswitch{flex:none;font-size:11.5px;opacity:.6;border:1px solid var(--vr-line);border-radius:999px;padding:1px 9px}
.vr-volhead:hover .vr-volswitch,.vr-volhead[aria-expanded=true] .vr-volswitch{opacity:1}
.vr-shelf{display:grid;gap:2px}
.vr-shelf-label{font-size:11.5px;opacity:.55;margin:10px 0 2px 2px}
.vr-shelf-row{display:flex!important;align-items:stretch;gap:10px;width:100%;text-align:left;border:0!important;padding:7px 8px!important}
.vr-shelf-row[aria-current=true]{background:var(--vr-soft)}
.vr-shelf-main{flex:1;min-width:0;display:grid;gap:1px}
.vr-shelf-title{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-shelf-row[aria-current=true] .vr-shelf-title{font-weight:600}
.vr-shelf-meta{font-size:11.5px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-shelf-side{flex:none;display:grid;justify-items:end;align-content:center;gap:1px;font-size:11.5px;opacity:.75;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif}
.vr-shelf-side em{font-style:normal;color:var(--vr-cinnabar);font-size:11px}
.vr-search{width:100%;border:1px solid var(--vr-line);border-radius:6px;background:transparent;padding:5px 8px;margin-bottom:2px}
.vr-cells{display:flex;gap:4px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin;padding:2px 1px 4px}
.vr-cells button{flex:none;min-width:26px;height:26px;padding:0 5px;border-radius:5px;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;font-size:13px;line-height:1}
.vr-cells button[aria-current=true]{border:1.5px solid var(--vr-accent,currentColor)!important;color:var(--vr-accent,inherit);font-weight:700}
.vr-cells button{position:relative}
.vr-cells button[data-level]::after{content:"";position:absolute;left:4px;bottom:2px;height:2px;width:calc((100% - 8px) * var(--lv));border-radius:1px;background:color-mix(in srgb,var(--vr-accent,#5a9e7c) 80%,transparent)}
.vr-filters{gap:4px}
.vr-filters button{border-radius:999px!important;padding:1px 10px!important;font-size:12px}
.vr-shelf-group{display:grid}
.vr-shelf-hits{display:flex;flex-wrap:wrap;gap:4px;padding:0 8px 6px 22px;font-size:12px}
.vr-shelf-hits button{padding:1px 8px!important;border-radius:999px!important;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif}
.vr-head-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.vr-head-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.vr-dim{opacity:.45;cursor:pointer;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;font-size:13px;border:0!important;text-align:left;padding:2px 0!important;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-dim:hover{opacity:.75;background:transparent!important}
.vr-trans{margin:0;padding:8px 10px;border-radius:6px;background:var(--vr-soft);font-size:13px;line-height:1.75}
.vr-notes{font-size:12.5px}
.vr-notes ul{margin:6px 0 0;padding-left:16px;display:grid;gap:3px}
.vr-notes b{color:var(--vr-cinnabar);font-weight:600}
.vr-card{display:grid;gap:10px;justify-items:center;text-align:center;padding:18px 12px;border:1px solid var(--vr-line);border-radius:10px}
.vr-vertical{writing-mode:vertical-rl;text-orientation:upright;max-height:300px;margin:0 auto;text-align:start}
.vr-hidden{cursor:pointer;user-select:none;color:color-mix(in srgb,currentColor 38%,transparent);border-radius:2px}
.vr-hidden.vr-shown{color:inherit;background:color-mix(in srgb,#5a9e7c 18%,transparent)}
.vr-fold{display:block;width:100%;text-align:left;padding:8px!important;margin-bottom:6px;opacity:.7}
.vr-levels button{min-width:30px}
.vr-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:space-between}
.vr-rate button{min-width:52px}
.vr-error{color:var(--vr-cinnabar)}
.vr-accent .vr-title{color:var(--vr-accent)}
.vr-accent .vr-guide{border-left-color:var(--vr-accent)}
.vr-card.vr-accent{border-top:3px solid var(--vr-accent)}

`

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

    function BookIcon() {
      return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
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

    function SectionText({ section, showGloss }) {
      const glosses = useMemo(() => sectionGlosses(section), [section])
      const [openNotes, setOpenNotes] = useState(() => new Set())
      function toggle(word) {
        const next = new Set(openNotes)
        if (next.has(word)) next.delete(word)
        else next.add(word)
        setOpenNotes(next)
      }
      return h('div', { className: 'vr-text' }, ...section.paragraphs.map((paragraph, index) => {
        const plan = renderPlan(textPieces(paragraph.text, paragraph.quotes, showGloss ? glosses[index] : []))
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

    function Shelf({ rows, state, currentId, onPick, onClose }) {
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const { recent, unread } = shelfItems(rows, state, query, filter)
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
          h('span', { className: 'vr-shelf-meta' }, [item.row.dynasty, item.row.author].filter(Boolean).join(' · ') || ' ')),
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
          className: 'vr-search', type: 'search', placeholder: '搜书名、作者、篇名、标签，回车打开', autoFocus: true, value: query,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') enter() }
        }),
        many ? h('div', { className: 'vr-row vr-filters', role: 'group', 'aria-label': '筛选' },
          ...SHELF_FILTERS.map(([value, label]) => h('button', { key: value, type: 'button', 'aria-pressed': filter === value, onClick: () => setFilter(value) }, label))) : null,
        recent.length ? h('div', { className: 'vr-shelf-label' }, '最近读过') : null,
        ...recent.map(row),
        unread.length ? h('div', { className: 'vr-shelf-label' }, recent.length ? '未读' : '全部书卷') : null,
        ...unread.map(row),
        !recent.length && !unread.length ? h('p', { className: 'vr-muted vr-small' }, query || filter !== 'all' ? '没有匹配的书卷。语料里的篇目可以在任一会话里用刻书匠入藏。' : '书库里还没有书卷。在任一会话里用刻书匠（vibe-reader-engraver）入藏。') : null)
    }

    function StudyView({ app, snapshot }) {
      const { library, state } = snapshot
      const rows = library.volumes
      const volumeId = state.ui.volume && rows.some((row) => row.id === state.ui.volume) ? state.ui.volume : rows.find((row) => !row.errors.length)?.id
      const entry = volumeId ? snapshot.volumes[volumeId] : undefined
      const [reciting, setReciting] = useState(false)
      const [showTranslation, setShowTranslation] = useState(false)
      // First visit (no volume chosen yet): start on the shelf.
      const [shelfOpen, setShelfOpen] = useState(!state.ui.volume || !volumeId)
      const cellsRef = useRef(null)
      useEffect(() => { if (volumeId && !entry) app.ensureVolume(volumeId) }, [volumeId, entry])

      const volume = entry?.volume
      const sections = volume?.sections || []
      const savedSection = state.volumes[volumeId]?.lastSection
      const index = Math.max(0, sections.findIndex((section) => section.id === savedSection))
      const section = sections[index]
      useEffect(() => {
        setReciting(false)
        setShowTranslation(false)
      }, [volumeId, section?.id])
      useEffect(() => {
        cellsRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      }, [volumeId, index, shelfOpen])

      function go(target) {
        if (!sections[target]) return
        app.progress(volumeId, sections[target].id)
      }
      const cardKey = volume && section ? volume.id + '#' + section.id : ''

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
      const head = h('button', { type: 'button', className: 'vr-volhead', 'aria-expanded': shelfOpen, title: '切换书卷', onClick: () => setShelfOpen(!shelfOpen) },
        h('span', { className: 'vr-spine' }),
        h('span', { className: 'vr-voltitle' }, (state.ui.volume && currentRow?.title) || '选一卷'),
        h('span', { className: 'vr-volmeta' }, state.ui.volume ? [currentRow?.dynasty, currentRow?.author].filter(Boolean).join(' · ') : ''),
        h('span', { className: 'vr-volswitch' }, shelfOpen ? '收起' : '书架'))
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
          index > 0 ? h('button', { key: 'prev', type: 'button', className: 'vr-dim', onClick: () => go(index - 1) }, '↑ ' + sections[index - 1].title + '　' + sections[index - 1].paragraphs[0].text.replace(/\n/g, ' ')) : null,
          h('h3', { key: 'title', className: 'vr-title' }, section.title,
            section.meta.author ? h('span', { className: 'vr-small vr-muted' }, '　' + section.meta.author) : null),
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
            : h(SectionText, { key: 'text-' + cardKey, section, showGloss: state.settings.showGloss }),
          !reciting && showTranslation && section.translation ? h('p', { key: 'trans', className: 'vr-trans' }, section.translation) : null,
          !reciting && section.notes.length ? h('details', { key: 'notes', className: 'vr-notes' },
            h('summary', null, '本节注释（' + section.notes.length + '）'),
            h('ul', null, ...section.notes.map((note) => h('li', { key: note.word }, h('b', null, note.word), note.reading ? ' ' + note.reading : '', '：' + note.gloss)))) : null,
          h('div', { key: 'actions', className: 'vr-actions' },
            h('div', { className: 'vr-row' },
              h('button', { type: 'button', disabled: index === 0, onClick: () => go(index - 1) }, '‹ 上一节'),
              h('button', { type: 'button', disabled: index >= sections.length - 1, onClick: () => go(index + 1) }, '下一节 ›')),
            h('div', { className: 'vr-row' },
              !reciting && section.translation ? h('button', { type: 'button', 'aria-pressed': showTranslation, onClick: () => setShowTranslation(!showTranslation) }, '译') : null,
              !reciting ? h('button', { type: 'button', 'aria-pressed': state.settings.showGloss, onClick: () => app.send({ op: 'settings', patch: { showGloss: !state.settings.showGloss } }) }, '注') : null,
              !reciting && volume.recitable ? h('button', { type: 'button', onClick: () => setReciting(true) }, '试背') : null)),
          !volume.recitable && !volume.errors.length ? h('p', { key: 'locked', className: 'vr-small vr-muted' }, '这一卷' + (volume.integrity === 'mismatch' ? '原文指纹不一致' : '还未核对') + '，只能阅读，不能背诵。') : null,
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
          : view.tone === 'reading-window' ? '可以读一则 · 运行中 ' + view.running.length
            : view.tone === 'waiting' ? '运行中 ' + view.running.length
              : '空闲'
      return h('button', { type: 'button', className: 'vr-chip vr-tone-' + view.tone, 'aria-expanded': open, title: '全部会话的状态，点击展开', onClick: onToggle }, text)
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
      return h('div', { className: 'vr-pop' }, ...(rows.length ? rows : [h('span', { key: 'none', className: 'vr-muted vr-small' }, '没有运行中、需要你或刚完成的会话。')]),
        h('span', { className: 'vr-small vr-muted' }, '点一条跳到那个会话；正在读时，阅读器会跟过去。'))
    }

    function SettingsPanel({ app, snapshot }) {
      const { state, library } = snapshot
      const [seconds, setSeconds] = useState(String(state.settings.readAfterSeconds))
      function commitSeconds() {
        const value = Number(seconds)
        if (Number.isInteger(value) && value >= 3 && value <= 600 && value !== state.settings.readAfterSeconds) app.send({ op: 'settings', patch: { readAfterSeconds: value } })
        else setSeconds(String(state.settings.readAfterSeconds))
      }
      const toggle = (key, label) => h('label', { className: 'vr-row' },
        h('input', { type: 'checkbox', checked: state.settings[key], onChange: (event) => app.send({ op: 'settings', patch: { [key]: event.target.checked } }) }), label)
      return h('div', { className: 'vr-pop' },
        toggle('showGloss', '显示夹注'),
        toggle('followSessions', '正在读时切换会话，阅读器跟过去'),
        h('label', { className: 'vr-row' }, 'Agent 运行超过',
          h('input', { type: 'number', min: 3, max: 600, value: seconds, style: { width: '64px' }, onChange: (event) => setSeconds(event.target.value), onBlur: commitSeconds, onKeyDown: (event) => { if (event.key === 'Enter') commitSeconds() } }),
          '秒，提示「可以读一则」'),
        h('div', { className: 'vr-small vr-muted' }, ...library.roots.map((root) => h('div', { key: root.dir }, (root.origin === 'builtin' ? '内置书卷：' : '我的书库：') + root.dir + (root.exists ? '（' + root.files + ' 个文件）' : '（目录不存在，建好后放入 .md 书卷即可）')))),
        h('div', { className: 'vr-row' }, h('button', { type: 'button', onClick: () => app.load() }, '重新读取书库')))
    }

    // ---------------------------------------------------------------- plugin

    function apply(ctx) {
      const app = createAppStore()
      const tracker = createTracker(ctx.uiSession?.sessionStatus)
      ctx.effect(() => tracker.start(), 'vibe-reader: session status')
      const listStore = ctx.sessions?.list ?? { getSnapshot: () => undefined, subscribe: () => () => {} }

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

      function openSession(id) {
        try { ctx.uiWorkspace?.openSession(id) } catch (error) { console.warn('[vibe-reader] openSession failed', error) }
      }

      function ReaderPane({ sessionId, useTabInfo }) {
        const { tab } = useTabInfo()
        const snapshot = useSyncExternalStore(app.subscribe, app.getSnapshot)
        const tracked = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot)
        const list = useSyncExternalStore(listStore.subscribe, listStore.getSnapshot)
        const [now, setNow] = useState(Date.now())
        const [panel, setPanel] = useState(null)

        useEffect(() => {
          if (!tab.visible || !sessionId) return
          visibleIn.set(sessionId, true)
          return () => { visibleIn.set(sessionId, Date.now()) }
        }, [tab.visible, sessionId])
        useEffect(() => {
          if (!tab.visible) {
            app.flush()
            return
          }
          app.refreshIfStale()
          const timer = setInterval(() => setNow(Date.now()), 1000)
          return () => clearInterval(timer)
        }, [tab.visible])

        const readAfterMs = (snapshot.state?.settings?.readAfterSeconds ?? 10) * 1000
        const view = boardView(tracked, list, now, readAfterMs)
        const current = snapshot.state?.ui?.view || 'encounter'
        const togglePanel = (name) => setPanel(panel === name ? null : name)

        return h('section', { className: 'vr', 'aria-label': '闲庭' },
          h('style', null, styles),
          h('div', { className: 'vr-head' },
            h('div', { className: 'vr-row' },
              h('div', { className: 'vr-seg', role: 'group', 'aria-label': '视图' },
                h('button', { type: 'button', 'aria-pressed': current === 'encounter', disabled: !snapshot.state, onClick: () => app.send({ op: 'view', view: 'encounter' }) }, '偶遇'),
                h('button', { type: 'button', 'aria-pressed': current === 'study', disabled: !snapshot.state, onClick: () => app.send({ op: 'view', view: 'study' }) }, '修业')),
              h('span', { className: 'vr-grow' }),
              h(StatusChip, { view, open: panel === 'status', onToggle: () => togglePanel('status') }),
              h('button', { type: 'button', title: '设置', 'aria-expanded': panel === 'settings', disabled: !snapshot.state, onClick: () => togglePanel('settings') }, '⚙')),
            panel === 'status' ? h(StatusPanel, { view, now, openSession }) : null,
            panel === 'settings' && snapshot.state ? h(SettingsPanel, { app, snapshot }) : null,
            snapshot.notice ? h('div', { className: 'vr-notice vr-small' }, h('span', { className: 'vr-grow' }, snapshot.notice), h('button', { type: 'button', onClick: app.dismissNotice }, '知道了')) : null),
          snapshot.status === 'error'
            ? h('div', { className: 'vr-body' }, h('p', { className: 'vr-error' }, snapshot.error), h('button', { type: 'button', onClick: () => app.load() }, '重试'))
            : !snapshot.library || !snapshot.state
              ? h('div', { className: 'vr-body' }, h('p', { className: 'vr-muted' }, '取书中…'))
              : current === 'study'
                ? h(StudyView, { app, snapshot })
                : h(EncounterView, { app, snapshot }))
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
        const label = '闲庭：读一则古诗文'
        if (primitives?.Button) {
          return h(primitives.Button, { size: 'sm', 'aria-label': label, title: label, onClick: toggleReader }, h(BookIcon))
        }
        return h('button', { type: 'button', className: 'vr-head-btn', 'aria-label': label, title: label, onClick: toggleReader }, h('style', null, styles), h(BookIcon))
      }

      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'vibe-reader' }, HeaderButton)
      ), 'vibe-reader: header button')

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: tabId,
        kind,
        title: () => '闲庭',
        keepMounted: true,
        guide: [{ id: kind, order: 36, title: () => '闲庭', description: () => '间隙读一则古诗文', icon: BookIcon }]
      }), 'vibe-reader: tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tabId }, ReaderPane)
      ), 'vibe-reader: body')
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiSession', 'sessions', 'uiWorkspace'],
      apply,
      __test: { track, boardView, createTracker, createFollower, maskParagraphs, sectionGlosses, textPieces, renderPlan, glossLines, pickCard, fitsVertical, optimistic, createAppStore, toNumeral, shelfItems, views: { StudyView, Shelf, EncounterView, StatusChip, StatusPanel, SettingsPanel, Recite, SectionText } }
    }
  }
})
