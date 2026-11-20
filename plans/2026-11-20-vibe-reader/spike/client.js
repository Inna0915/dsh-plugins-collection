window.__ModuleLoader__.load({
  id: 'dsh-vibe-reader-spike',
  factory(require) {
    const { createElement: h, useEffect, useState, useSyncExternalStore } = require('react')
    const kind = 'vibe-reader-spike'
    const tabId = 'dsh-vibe-reader-spike/probe'
    const askApi = 'api/vibe-reader-spike/ask'
    const READ_AFTER_MS = 8000
    const MAIN_DONE_HOLD_MS = 60000
    const MAX_EVENTS = 30
    const toneLabels = {
      idle: '空闲',
      waiting: '等待中',
      'reading-window': '可读',
      done: '有会话已完成',
      'needs-you': '有会话需要你'
    }
    const pendingLabels = { approval: '审批', 'plan-review': '计划确认', question: '提问' }
    const eventLabels = { 'turn-start': '开始', 'seen-running': '已在运行', 'turn-end': '结束', 'needs-you': '需要你', carry: '探针跟到' }
    const styles = '.vr-spike{display:grid;gap:10px;align-content:start;padding:14px;height:100%;overflow:auto;box-sizing:border-box;font-size:12.5px}.vr-spike h2,.vr-spike h3,.vr-spike h4,.vr-spike p{margin:0}.vr-spike h2{font-size:16px}.vr-spike h3{font-size:13px}.vr-spike h4{font-size:12px;opacity:.8;font-weight:600}.vr-spike small{opacity:.7}.vr-spike .vr-badge{display:inline-block;padding:3px 8px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 30%,transparent)}.vr-spike .vr-reading-window{background:color-mix(in srgb,#68a691 28%,transparent)}.vr-spike .vr-needs-you{background:color-mix(in srgb,#c3272b 28%,transparent)}.vr-spike .vr-done{background:color-mix(in srgb,#eacd76 35%,transparent)}.vr-spike button{border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;padding:5px 8px;cursor:pointer}.vr-spike button:disabled{opacity:.55;cursor:default}.vr-spike pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11.5px;padding:8px;border-radius:6px;background:color-mix(in srgb,currentColor 6%,transparent)}.vr-spike ol,.vr-spike ul{margin:0;padding-left:18px;display:grid;gap:2px}.vr-spike ul{list-style:none;padding:0;gap:4px}.vr-spike .vr-row{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;padding:4px 8px}.vr-spike .vr-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vr-spike .vr-meta{flex:none;opacity:.7;font-size:11.5px}.vr-spike details summary{cursor:pointer}'

    /** Pure: fold one sessionStatus snapshot into per-session turn tracking. */
    function track(previous, snapshot, now) {
      const next = new Map()
      const events = []
      for (const [id, status] of snapshot) {
        const before = previous.get(id)
        const running = status?.running === true
        const pendingKind = status?.pendingInteraction ? String(status.pendingInteraction.kind || 'unknown') : undefined
        let since = before?.since
        let finishedAt = before?.finishedAt
        let lastMs = before?.lastMs
        if (running && !before?.running) {
          since = now
          events.push({ id, type: before ? 'turn-start' : 'seen-running', at: now })
        }
        if (!running && before?.running) {
          finishedAt = now
          lastMs = now - before.since
          events.push({ id, type: 'turn-end', at: now, ms: lastMs })
          since = undefined
        }
        if (pendingKind && !before?.pendingKind) events.push({ id, type: 'needs-you', at: now, kind: pendingKind })
        next.set(id, { running, pendingKind, since, finishedAt, lastMs, completionUnread: Boolean(status?.completionUnread) })
      }
      return { next, events }
    }

    /** Session list row, when the host catalog knows it. */
    function rowOf(list, id) {
      return list?.byId?.[id]
    }

    function titleOf(list, id) {
      const row = rowOf(list, id)
      return row?.displayTitle || row?.title || '未命名会话 ' + String(id).slice(-6)
    }

    /**
     * Pure: one board-wide view over every top-level session, independent of
     * which session hosts the panel. Subagent and blank rows are left out.
     * A session in the main view never gets completionUnread from the host, so
     * its own observed stop counts as done for a short hold.
     */
    function boardView(tracked, list, now, readAfterMs = READ_AFTER_MS) {
      const needsYou = []
      const done = []
      const running = []
      let topLevel = 0
      for (const [id, entry] of tracked) {
        const row = rowOf(list, id)
        if (row && (row.origin === 'subagent' || row.parentId || row.blank)) continue
        topLevel++
        const isMain = (row?.retainedBy?.mainView ?? 0) > 0
        const item = { id, title: titleOf(list, id), isMain, since: entry.since, finishedAt: entry.finishedAt, lastMs: entry.lastMs, pendingKind: entry.pendingKind }
        if (entry.pendingKind) {
          needsYou.push(item)
        } else if (entry.running) {
          running.push(item)
        } else if (entry.completionUnread || (isMain && entry.finishedAt !== undefined && now - entry.finishedAt < MAIN_DONE_HOLD_MS)) {
          done.push(item)
        }
      }
      running.sort((a, b) => (a.since ?? now) - (b.since ?? now))
      done.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      const longestMs = running.length ? now - (running[0].since ?? now) : 0
      const tone = needsYou.length ? 'needs-you'
        : done.length ? 'done'
          : running.length ? (longestMs >= readAfterMs ? 'reading-window' : 'waiting')
            : 'idle'
      return { tone, needsYou, done, running, longestMs, topLevel, total: tracked.size }
    }

    /** Subscribe once per plugin so turn events are captured even while the pane is hidden. */
    function createTracker(source, clock = Date.now) {
      const listeners = new Set()
      let value = { sessions: new Map(), events: [], available: Boolean(source) }
      function update() {
        const { next, events } = track(value.sessions, source.getSnapshot(), clock())
        value = { sessions: next, events: events.length ? [...events.reverse(), ...value.events].slice(0, MAX_EVENTS) : value.events, available: true }
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

    /**
     * The right sidebar keeps one layout per session, so a tab opened in one
     * session is absent from the next. Carry the panel over only when it was
     * visible in the session being left (the user was reading); otherwise
     * leave the arriving session's sidebar alone. `mounted` changes before
     * React renders the switch, so the leaving pane's visibility is still
     * current when the subscriber runs.
     */
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

    const emptyStore = { getSnapshot: () => undefined, subscribe: () => () => {} }

    async function requestAsk(body) {
      const response = await fetch(askApi, body ? {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      } : undefined)
      return response.json()
    }

    function clockText(at) {
      return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
    }

    function durationText(ms) {
      const seconds = Math.max(0, Math.round(ms / 1000))
      if (seconds < 60) return seconds + ' 秒'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒'
      return Math.floor(minutes / 60) + ' 时 ' + String(minutes % 60).padStart(2, '0') + ' 分'
    }

    function ProbeIcon() {
      return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('path', { d: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Zm0 13a3 3 0 0 1 3-3h11M9 8h6' }))
    }

    function apply(ctx) {
      const source = ctx.uiSession?.sessionStatus
      const listStore = ctx.sessions?.list ?? emptyStore
      const tracker = createTracker(source)
      ctx.effect(() => tracker.start(), 'vibe-reader-spike: session status')

      // Follow the user across sessions (see createFollower).
      // sessionId -> true while the pane is visible there, or the time it was hidden.
      // A short grace covers hosts that unmount the leaving pane before announcing the switch.
      const visibleIn = new Map()
      const HIDDEN_GRACE_MS = 1500
      function wasVisible(sessionId) {
        const value = visibleIn.get(sessionId)
        return value === true || (typeof value === 'number' && Date.now() - value < HIDDEN_GRACE_MS)
      }
      const follow = { enabled: true, carried: [] }
      const followListeners = new Set()
      function notifyFollow() { for (const listener of followListeners) listener() }
      function openIn(sessionId, attempt = 0) {
        try {
          ctx.sidebarRight.openTab(kind)
          follow.carried = [{ id: sessionId, at: Date.now() }, ...follow.carried].slice(0, MAX_EVENTS)
          notifyFollow()
        } catch (error) {
          // The arriving session's store is minted during its first render; retry once on the next frame.
          if (attempt === 0) requestAnimationFrame(() => { if (ctx.sidebarRight.mounted.getSnapshot() === sessionId) openIn(sessionId, 1) })
          else console.warn('[vibe-reader-spike] carry-over failed', error)
        }
      }
      if (ctx.sidebarRight?.mounted) {
        const startFollow = createFollower({
          mounted: ctx.sidebarRight.mounted,
          isVisible: wasVisible,
          enabled: () => follow.enabled,
          open: openIn,
          schedule: (task) => setTimeout(task, 0)
        })
        ctx.effect(() => startFollow(), 'vibe-reader-spike: follow sessions')
      }
      const followStore = {
        subscribe(listener) { followListeners.add(listener); return () => followListeners.delete(listener) },
        getSnapshot: () => follow.carried
      }

      function openSession(id) {
        try { ctx.uiWorkspace?.openSession(id) } catch (error) { console.warn('[vibe-reader-spike] openSession failed', error) }
      }

      function SessionRows({ items, meta }) {
        return h('ul', null, ...items.map(item => h('li', { key: item.id },
          h('button', { type: 'button', className: 'vr-row', title: item.title + '\n' + item.id, onClick: () => openSession(item.id) },
            h('span', { className: 'vr-title' }, item.title + (item.isMain ? '（主视图）' : '')),
            h('span', { className: 'vr-meta' }, meta(item))))))
      }

      function ProbePane({ sessionId, useTabInfo }) {
        const { tab } = useTabInfo()
        const snapshot = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot)
        const list = useSyncExternalStore(listStore.subscribe, listStore.getSnapshot)
        const carried = useSyncExternalStore(followStore.subscribe, followStore.getSnapshot)
        const [followOn, setFollowOn] = useState(follow.enabled)

        useEffect(() => {
          if (!tab.visible || !sessionId) return
          visibleIn.set(sessionId, true)
          return () => { visibleIn.set(sessionId, Date.now()) }
        }, [tab.visible, sessionId])
        const [now, setNow] = useState(Date.now())
        const [diagnostics, setDiagnostics] = useState(null)
        const [answer, setAnswer] = useState(null)
        const [busy, setBusy] = useState(false)

        useEffect(() => {
          if (!tab.visible) return
          const timer = setInterval(() => setNow(Date.now()), 1000)
          return () => clearInterval(timer)
        }, [tab.visible])

        useEffect(() => {
          if (!tab.visible) return
          requestAsk(null).then(setDiagnostics, error => setDiagnostics({ error: String(error) }))
        }, [tab.visible])

        const view = boardView(snapshot.sessions, list, now)

        async function askOnce() {
          setBusy(true)
          setAnswer(null)
          const started = Date.now()
          try {
            setAnswer({ ...(await requestAsk({})), clientMs: Date.now() - started })
          } catch (error) {
            setAnswer({ ok: false, failure: { code: 'CLIENT', message: String(error) } })
          } finally {
            setBusy(false)
          }
        }

        return h('section', { className: 'vr-spike', 'aria-label': '闲庭探针' },
          h('style', null, styles),
          h('h2', null, '闲庭 · 探针'),
          h('small', null, '验证三件事：前端能否看到全部会话的运行状态；面板能否跟着你切换会话；后端能否单次调用 ctx.llm。'),
          h('h3', null, '一、全部会话'),
          snapshot.available
            ? h('p', null, h('span', { className: 'vr-badge vr-' + view.tone }, toneLabels[view.tone]),
              h('small', null, '  需要你 ' + view.needsYou.length + ' · 已完成 ' + view.done.length + ' · 运行中 ' + view.running.length +
                (view.running.length ? '（最久 ' + durationText(view.longestMs) + '）' : '')))
            : h('p', null, '宿主未提供 ctx.uiSession.sessionStatus，无法观察运行状态。'),
          view.needsYou.length ? h('h4', null, '需要你处理') : null,
          view.needsYou.length ? h(SessionRows, { items: view.needsYou, meta: item => pendingLabels[item.pendingKind] || item.pendingKind }) : null,
          view.done.length ? h('h4', null, '已完成，待查看') : null,
          view.done.length ? h(SessionRows, {
            items: view.done,
            meta: item => [item.finishedAt !== undefined ? durationText(now - item.finishedAt) + '前' : '', item.lastMs !== undefined ? '用时 ' + durationText(item.lastMs) : ''].filter(Boolean).join(' · ') || '未读'
          }) : null,
          view.running.length ? h('h4', null, '运行中') : null,
          view.running.length ? h(SessionRows, { items: view.running, meta: item => item.since !== undefined ? '已运行 ' + durationText(now - item.since) : '' }) : null,
          h('p', null, h('small', null, '点击条目跳到该会话。共 ' + view.total + ' 个会话，顶层 ' + view.topLevel + ' 个；可读阈值 ' + READ_AFTER_MS / 1000 + ' 秒' +
            (list ? '' : '；未拿到会话列表，标题不可用') + '。')),
          h('h3', null, '二、切换会话'),
          h('label', null,
            h('input', { type: 'checkbox', checked: followOn, onChange: (event) => { follow.enabled = event.target.checked; setFollowOn(follow.enabled) } }),
            ' 正在看探针时切换会话，自动在新会话里打开它'),
          h('small', null, '右侧栏按会话各存一份布局。跟随记录：' +
            (carried.length ? carried.slice(0, 3).map(item => clockText(item.at) + ' ' + titleOf(list, item.id)).join('；') : '还没有')),
          h('details', null,
            h('summary', null, '事件日志（' + snapshot.events.length + '）'),
            snapshot.events.length
              ? h('ol', { reversed: true },
                ...snapshot.events.map((event, index) => h('li', { key: index },
                  clockText(event.at) + '  ' + (eventLabels[event.type] || event.type) + '  ' + titleOf(list, event.id) +
                  (event.ms !== undefined ? '  用时 ' + durationText(event.ms) : '') +
                  (event.kind ? '  ' + (pendingLabels[event.kind] || event.kind) : ''))))
              : h('small', null, '在任一会话发一条消息，这里会出现开始 / 结束记录。')),
          h('h3', null, '三、后端 ctx.llm 单次调用'),
          h('pre', null, diagnostics ? JSON.stringify(diagnostics, null, 2) : '读取诊断中…'),
          h('button', { type: 'button', disabled: busy, onClick: () => void askOnce() }, busy ? '调用中…' : '试问书童（会调用一次模型）'),
          answer ? h('pre', null, JSON.stringify(answer, null, 2)) : null
        )
      }

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: tabId,
        kind,
        title: () => '闲庭探针',
        keepMounted: true,
        guide: [{ id: kind, order: 37, title: () => '闲庭探针', description: () => '全部会话状态与 ctx.llm 验证', icon: ProbeIcon }]
      }), 'vibe-reader-spike: tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tabId }, ProbePane)
      ), 'vibe-reader-spike: body')
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiSession', 'sessions', 'uiWorkspace'],
      apply,
      __test: { track, boardView, createTracker, createFollower }
    }
  }
})
