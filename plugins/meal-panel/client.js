window.__ModuleLoader__.load({
  id: '@local/dsh-meal-panel',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    const API = '/meal/api'
    const OPEN_SITE_PATH = '/user/calendar'
    const STORE_KEY = 'meal.panel.expanded'

    /* ---------------------------------------------------------------- */
    /* locale                                                            */
    /* ---------------------------------------------------------------- */

    const ZH = {
      title: '饭否',
      refresh: '刷新',
      openSite: '打开饭点页面',
      expand: '展开报餐面板',
      collapse: '收起报餐面板',
      lunch: '午餐',
      dinner: '晚餐',
      lunchShort: '午',
      dinnerShort: '晚',
      ordered: '已订餐',
      declined: '不订餐',
      unselected: '未选择',
      orderedShort: '已订',
      declinedShort: '不订',
      unselectedShort: '未选',
      notApplicable: '—',
      orderAction: '订',
      declineAction: '不订',
      inOffice: '在公司就餐',
      outOffice: '不在公司就餐',
      inShort: '在公司',
      outShort: '不在公司',
      notJoined: '无需登记',
      leaveConfirm: '切换到「不在公司就餐」会清除未锁定的选择，已锁定的保留。',
      confirm: '确认',
      cancel: '取消',
      deadline: '{time} 截止',
      closesAt: '{times} 截止',
      lockedHint: '已截止，无法修改',
      lockedShort: '已截止',
      closedAll: '两餐均已截止',
      advanceLocked: '提前锁定',
      leftMinutes: '还剩 {n} 分钟',
      leftHours: '还剩 {n} 小时',
      leftHoursMinutes: '还剩 {h} 小时 {m} 分',
      leftDays: '还剩 {n} 天',
      saved: '已保存',
      saving: '保存中…',
      loadFailed: '加载失败',
      retry: '重试',
      changeUser: '更换用户名',
      setupTitle: '连接饭点',
      setupHint: '填写管理员登记的用户名，无需密码',
      setupPlaceholder: '用户名',
      setupSubmit: '连接',
      setupRequired: '请先填写用户名',
      connected: '已连接',
      notInOfficeDay: '本日不在公司就餐',
      noApplicableDay: '本日无需登记',
      pickDate: '选择日期',
      today: '今天',
      lunchReminder: '午餐未报',
      lunchReminderHint: '今天午餐尚未报餐，请在截止前选择',
      weekdays: '日一二三四五六',
      weekdayFormat: '周{ch}',
      loading: '加载中…',
      offline: '连接失败',
    }

    const EN = {
      title: 'Meals',
      refresh: 'Refresh',
      openSite: 'Open meal site',
      expand: 'Expand meal panel',
      collapse: 'Collapse meal panel',
      lunch: 'Lunch',
      dinner: 'Dinner',
      lunchShort: 'L',
      dinnerShort: 'D',
      ordered: 'Ordered',
      declined: 'Skipped',
      unselected: 'Not chosen',
      orderedShort: '✓',
      declinedShort: '−',
      unselectedShort: '!',
      notApplicable: '—',
      orderAction: 'Order',
      declineAction: 'Skip',
      inOffice: 'Dining in',
      outOffice: 'Not dining in',
      inShort: 'In office',
      outShort: 'Away',
      notJoined: 'Nothing to register',
      leaveConfirm: 'Switching to "Not dining in" clears unlocked choices; locked meals stay.',
      confirm: 'Confirm',
      cancel: 'Cancel',
      deadline: 'closes {time}',
      closesAt: 'closes {times}',
      lockedHint: 'Closed, no changes',
      lockedShort: 'Closed',
      closedAll: 'Both meals closed',
      advanceLocked: 'Locked early',
      leftMinutes: '{n} min left',
      leftHours: '{n} h left',
      leftHoursMinutes: '{h} h {m} min left',
      leftDays: '{n} d left',
      saved: 'Saved',
      saving: 'Saving…',
      loadFailed: 'Could not load',
      retry: 'Retry',
      changeUser: 'Change username',
      setupTitle: 'Connect canteen',
      setupHint: 'Enter the username your admin registered; no password needed',
      setupPlaceholder: 'Username',
      setupSubmit: 'Connect',
      setupRequired: 'Enter a username first',
      connected: 'Connected',
      notInOfficeDay: 'Not in the office this day',
      noApplicableDay: 'No registration needed',
      pickDate: 'Pick a day',
      today: 'Today',
      lunchReminder: 'Lunch needed',
      lunchReminderHint: 'Choose today’s lunch before the deadline',
      weekdays: 'SMTWTFS',
      weekdayFormat: '{ch}',
      loading: 'Loading…',
      offline: 'Cannot connect',
    }

    function makeTranslate(ctx) {
      const locale = ctx.get ? ctx.get('locale') : undefined
      let bound
      if (locale && typeof locale.register === 'function') {
        try {
          locale.register('meal', 'zh', ZH)
          locale.register('meal', 'en', EN)
        } catch {
          // Registration is best-effort; the fallback below still renders.
        }
        try {
          bound = locale.bind('meal')
        } catch {
          bound = undefined
        }
      }
      return (key, vars) => {
        let text
        if (bound) {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value.length > 0 && value !== key) text = value
          } catch {
            // fall through
          }
        }
        if (text === undefined) text = ZH[key] ?? key
        if (vars) {
          for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
        }
        return text
      }
    }

    /* ---------------------------------------------------------------- */
    /* helpers                                                           */
    /* ---------------------------------------------------------------- */

    async function api(path, options) {
      const body = options?.body
      let response
      try {
        response = await fetch(`${API}${path}`, {
          method: options?.method ?? 'GET',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store',
        })
      } catch {
        throw new Error('OFFLINE')
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('BAD_RESPONSE')
      }
      if (!payload || payload.ok !== true) {
        const error = new Error(payload?.error?.message || 'REQUEST_FAILED')
        error.code = payload?.error?.code
        error.status = response.status
        throw error
      }
      return payload.value
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** The canteen service runs on Asia/Shanghai (UTC+8); it has no DST. */
    const SERVICE_OFFSET_MS = 8 * 3600 * 1000

    /** Calendar date of one instant on the service's clock. */
    function serviceDate(instantMs) {
      const date = new Date(instantMs + SERVICE_OFFSET_MS)
      return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
    }

    /** Wall clock of a deadline on the service's clock, so it matches the site. */
    function hhmm(iso) {
      const stamp = Date.parse(iso)
      if (!Number.isFinite(stamp)) return ''
      const date = new Date(stamp + SERVICE_OFFSET_MS)
      return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
    }

    function weekdayOf(date) {
      const value = new Date(`${date}T12:00:00`)
      return Number.isNaN(value.getTime()) ? -1 : value.getDay()
    }

    function weekdayName(date, t) {
      const index = weekdayOf(date)
      return index < 0 ? '' : t('weekdayFormat', { ch: t('weekdays')[index] })
    }

    function monthDayOf(date) {
      if (typeof date !== 'string' || date.length < 10) return ''
      return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`
    }

    function mealOf(day, meal) {
      const list = Array.isArray(day?.meals) ? day.meals : []
      return list.find(entry => entry?.meal === meal) ?? null
    }

    function isLocked(entry, now) {
      if (!entry) return true
      if (entry.locked === true) return true
      const deadline = Date.parse(entry.deadline)
      return Number.isFinite(deadline) ? now >= deadline : false
    }

    function needsLunchReminder(panel, todayDay, now) {
      if (!Number.isFinite(now) || !panel?.today || panel.today !== serviceDate(now)) return false
      const shifted = new Date(now + SERVICE_OFFSET_MS)
      if (shifted.getUTCHours() * 60 + shifted.getUTCMinutes() < 8 * 60 + 30) return false
      const lunch = mealOf(todayDay, 'LUNCH')
      if (panel.presence !== 'IN_OFFICE' || todayDay?.presence !== 'IN_OFFICE' || lunch?.choice !== 'UNSELECTED') return false
      if (lunch.presence != null && lunch.presence !== 'IN_OFFICE') return false
      const deadline = batchTime(lunch.deadline)
      return lunch.locked === false && Number.isFinite(deadline) && now < deadline
    }

    function choiceLabel(choice, t) {
      if (choice === 'ORDERED') return t('ordered')
      if (choice === 'DECLINED') return t('declined')
      if (choice === 'UNSELECTED') return t('unselected')
      return t('notApplicable')
    }

    function stateClass(choice) {
      return `is-${String(choice || 'NOT_APPLICABLE').toLowerCase()}`
    }

    function remainingText(deadline, now, t) {
      const ms = Date.parse(deadline)
      if (!Number.isFinite(ms) || ms <= now) return ''
      const minutes = Math.round((ms - now) / 60000)
      if (minutes < 60) return t('leftMinutes', { n: Math.max(minutes, 1) })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) {
        const rest = minutes % 60
        return rest === 0 ? t('leftHours', { n: hours }) : t('leftHoursMinutes', { h: hours, m: rest })
      }
      return t('leftDays', { n: Math.floor(hours / 24) })
    }

    function dayHint(day, now, t) {
      if (!day) return ''
      if (day.presence !== 'IN_OFFICE') {
        return day.presence === 'OUT_OF_OFFICE' ? t('notInOfficeDay') : t('noApplicableDay')
      }
      const lunch = mealOf(day, 'LUNCH')
      const dinner = mealOf(day, 'DINNER')
      const visible = [lunch, dinner].filter(Boolean)
      if (visible.length === 0) return ''
      const open = visible.filter(entry => !isLocked(entry, now))
      if (open.length === 0) return t('closedAll')
      const times = visible.map(entry => hhmm(entry.deadline)).filter(Boolean).join(' / ')
      const nearest = open
        .map(entry => Date.parse(entry.deadline))
        .filter(stamp => Number.isFinite(stamp))
        .sort((a, b) => a - b)[0]
      const remain = nearest ? remainingText(new Date(nearest).toISOString(), now, t) : ''
      return remain ? `${t('closesAt', { times })} · ${remain}` : t('closesAt', { times })
    }

    function readExpanded() {
      try {
        return localStorage.getItem(STORE_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeExpanded(value) {
      try {
        localStorage.setItem(STORE_KEY, value ? '1' : '0')
      } catch {
        // A private-mode write failure only costs the remembered state.
      }
    }

    /* ---------------------------------------------------------------- */
    /* styles                                                            */
    /* ---------------------------------------------------------------- */

    const CSS = `
.mb-root{position:relative;flex:1 1 0%;min-width:0;max-width:100%;box-sizing:border-box;font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.35}
.mb-root,.mb-root *{box-sizing:border-box}
.mb-bar{display:flex;align-items:center;gap:0;width:100%;min-width:0;min-height:36px;padding:0 7px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dcu-sidebar-primary,var(--dsw-alias-label-primary));font-family:inherit;font-size:14px;cursor:pointer;text-align:left;overflow:hidden}
.mb-bar:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mb-bar-mark{display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;margin-right:10px}
.mb-bar-mark svg{transform:translateX(1px)}
.mb-bar-title{flex:none;font-weight:400;color:inherit}
.mb-bar-spacer{flex:1;min-width:0}
.mb-bar-chevron{flex:none;display:flex;color:var(--dsw-alias-label-tertiary)}
.mb-chips{display:flex;align-items:center;gap:0;min-width:0;overflow:hidden}
.mb-chip{flex:none;white-space:nowrap;font-size:14px;font-weight:400;color:inherit}
.mb-chip.is-ordered{font-weight:700}
.mb-reminder{flex:none;display:inline-flex;align-items:center;gap:4px;margin-left:9px;padding:2px 6px;border-radius:999px;background:rgba(220,76,54,.12);color:var(--dsw-alias-state-error-primary,#b72d27);font-size:10px;font-weight:600;line-height:1.4;white-space:nowrap}
.mb-reminder::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor}
.mb-card .mb-reminder{margin:5px 0 0}
.mb-card{margin-bottom:8px;padding:6px 7px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.mb-popover{position:fixed;z-index:1000;overflow-y:auto;overscroll-behavior:contain;margin:0;box-sizing:border-box;font-family:var(--dsw-font-family);font-size:12px;line-height:1.35;color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.16))}
.mb-popover *{box-sizing:border-box}
.mb-head{display:flex;align-items:center;gap:3px;min-width:0;overflow:hidden}
.mb-title{flex:none;font-size:12px;font-weight:600;letter-spacing:.02em}
.mb-date{flex:0 1 auto;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mb-spacer{flex:1 1 0%;min-width:0}
.mb-icon{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.mb-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mb-icon:disabled{opacity:.5;cursor:default}
.mb-icon svg{display:block}
.mb-presence{display:inline-flex;align-items:center;gap:3px;height:19px;padding:0 4px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:10px;cursor:pointer;flex:0 1 auto;min-width:0;max-width:62px}
.mb-presence:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mb-presence:disabled{opacity:.55;cursor:default}
.mb-dot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.mb-dot.is-in{background:var(--dsw-alias-state-success-primary)}
.mb-dot.is-out{background:var(--dsw-alias-state-warn-primary)}
.mb-presence-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mb-rows{margin-top:6px;display:flex;flex-direction:column;gap:4px}
.mb-row{display:flex;align-items:center;gap:4px;height:23px;min-width:0}
.mb-row.is-idle{opacity:.72}
.mb-row-name{flex:none;width:24px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.mb-row-state{flex:1;min-width:0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mb-row-state.is-ordered{color:var(--dsw-alias-state-success-primary)}
.mb-row-state.is-unselected{color:var(--dsw-alias-state-warn-primary)}
.mb-row-state.is-declined{color:var(--dsw-alias-label-tertiary)}
.mb-lock{display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);flex:none;margin-right:2px}
.mb-seg{display:flex;gap:3px;flex:none}
.mb-mini{width:34px;height:19px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:10px;cursor:pointer}
.mb-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mb-mini.is-on.is-order{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);font-weight:600}
.mb-mini.is-on.is-decline{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}
.mb-mini:disabled{opacity:.5;cursor:default}
.mb-hint{margin-top:4px;font-size:9.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mb-hint.is-warn{color:var(--dsw-alias-state-warn-primary)}
.mb-days{display:flex;gap:3px;margin-top:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:1px}
.mb-days::-webkit-scrollbar{display:none}
.mb-day{flex:none;width:31px;padding:2px 0 3px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:9px;line-height:1.2;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:1px}
.mb-day:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mb-day.is-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mb-day-num{font-size:10px;font-weight:600;color:inherit}
.mb-day-dots{display:flex;gap:2px}
.mb-day-dot{width:3px;height:3px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.mb-day-dot.is-ordered{background:var(--dsw-alias-state-success-primary)}
.mb-day-dot.is-unselected{background:var(--dsw-alias-state-warn-primary)}
.mb-day-dot.is-declined{background:var(--dsw-alias-label-tertiary)}
.mb-toast{margin-top:4px;font-size:10px;line-height:1.35}
.mb-toast.is-ok{color:var(--dsw-alias-state-success-primary)}
.mb-toast.is-err{color:var(--dsw-alias-state-error-primary)}
.mb-confirm{margin-top:5px;padding:5px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:9.5px;color:var(--dsw-alias-label-secondary);line-height:1.4}
.mb-actions{display:flex;gap:4px;margin-top:5px}
.mb-btn{flex:1;height:21px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:10.5px;cursor:pointer}
.mb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mb-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);font-weight:600}
.mb-btn:disabled{opacity:.55;cursor:default}
.mb-input{width:100%;box-sizing:border-box;height:24px;margin-top:5px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11px}
.mb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.mb-error{margin-top:4px;font-size:10px;color:var(--dsw-alias-state-error-primary);line-height:1.4}
.mb-skeleton{height:30px;border-radius:7px;background:var(--dsw-alias-bg-layer-2)}
`

    /* ---------------------------------------------------------------- */
    /* icons                                                             */
    /* ---------------------------------------------------------------- */

    function SpoonIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M12 2.5c-3.4 0-5.7 2.5-5.7 5.5 0 2.5 1.7 4.4 4.2 4.9V20a1.5 1.5 0 0 0 3 0v-7.1c2.5-.5 4.2-2.4 4.2-4.9 0-3-2.3-5.5-5.7-5.5Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }))
    }

// Insert inside the client factory; render h(BatchPanel, {panel, onBusy, onRefresh})
// and include BATCH_CSS with the existing client style. No standalone module exports.
const BATCH_CSS = `
.mb-batch{margin-top:7px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-primary)}
.mb-batch button,.mb-batch input{font:inherit}.mb-batch button{cursor:pointer;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:3px 5px}.mb-batch button:disabled{opacity:.5;cursor:default}
.mb-batch-toggle{width:100%;text-align:left;font-weight:600}.mb-batch-fields{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:5px 0}.mb-batch-fields label{min-width:0;color:var(--dsw-alias-label-secondary)}.mb-batch-fields input{display:block;width:100%;min-width:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:3px}
.mb-batch-shortcuts,.mb-batch-actions,.mb-batch-meals{display:flex;gap:4px;flex-wrap:wrap;margin:5px 0}.mb-batch-meals label,.mb-batch-option{display:flex;align-items:center;gap:3px}.mb-batch-option{align-items:flex-start}.mb-batch-status{margin:5px 0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}.mb-batch-error{color:var(--dsw-alias-state-error-primary)}
.mb-batch-list{max-height:190px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:5px}.mb-batch-row{display:grid;grid-template-columns:auto 1fr;gap:4px;padding:4px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}.mb-batch-row:last-child{border-bottom:0}.mb-batch-row input{align-self:start}.mb-batch-row small{display:block;color:var(--dsw-alias-label-secondary)}.mb-batch-source{font-size:9px;color:var(--dsw-alias-label-tertiary);margin-top:5px}
`

const BATCH_HOLIDAYS_2026 = [
  ['2026-01-01','2026-01-03','元旦'], ['2026-02-15','2026-02-23','春节'],
  ['2026-04-04','2026-04-06','清明节'], ['2026-05-01','2026-05-05','劳动节'],
  ['2026-06-19','2026-06-21','端午节'], ['2026-09-25','2026-09-27','中秋节'],
  ['2026-10-01','2026-10-07','国庆节'],
]
const BATCH_MAKEUP_2026 = new Set(['2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10'])
const BATCH_DAY_MS = 86400000
function batchStamp(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请选择有效日期')
  const stamp = Date.parse(date + 'T00:00:00Z')
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) throw new Error('日期无效')
  return stamp
}
function batchDates(start, end) {
  const first = batchStamp(start), last = batchStamp(end)
  if (last < first) throw new Error('结束日期不能早于开始日期')
  if ((last - first) / BATCH_DAY_MS >= 93) throw new Error('一次最多选择 93 天')
  const dates = []
  for (let n = first; n <= last; n += BATCH_DAY_MS) {
    const date = new Date(n).toISOString().slice(0, 10)
    if (!date.startsWith('2026-')) throw new Error('仅收录 2026 年官方节假日安排，其他年份请先更新日历数据')
    dates.push(date)
  }
  return dates
}
function batchDayInfo(date) {
  const day = new Date(batchStamp(date)).getUTCDay()
  if (!date.startsWith('2026-')) throw new Error('该年份节假日数据未收录')
  const holiday = BATCH_HOLIDAYS_2026.find(([start, end]) => date >= start && date <= end)
  const makeup = BATCH_MAKEUP_2026.has(date)
  return { workday: makeup || (!holiday && day !== 0 && day !== 6), label: makeup ? '调休补班' : holiday ? holiday[2] : day === 0 || day === 6 ? '周末' : '工作日', weekday: '周' + '日一二三四五六'[day] }
}
function batchTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return NaN
  const text = value.replace(' ', 'T')
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : text + '+08:00')
}
function batchEligibility(date, meal, value, replaceDeclined) {
  const info = batchDayInfo(date)
  if (!info.workday) return { eligible: false, reason: info.label }
  if (!value || !Array.isArray(value.days) || !/^\d{4}-\d{2}-\d{2}$/.test(value.today || '')) throw new Error('日历数据不完整，请刷新后重试')
  if (date < value.today) return { eligible: false, reason: '历史日期' }
  const day = value.days.find(item => item?.date === date)
  const entry = mealOf(day, meal)
  if (!entry) return { eligible: false, reason: '网站未提供该餐次' }
  if (entry.choice === 'ORDERED') return { eligible: false, reason: '已订餐' }
  if (value.presence !== 'IN_OFFICE' || day?.presence !== 'IN_OFFICE' || (entry.presence != null && entry.presence !== 'IN_OFFICE')) return { eligible: false, reason: '不在公司或无需登记' }
  const now = batchTime(value.serverTime), deadline = batchTime(entry.deadline)
  if (!Number.isFinite(now) || !Number.isFinite(deadline) || typeof entry.locked !== 'boolean') throw new Error('网站时间或锁定状态异常，请刷新后重试')
  if (isLocked({ ...entry, deadline: new Date(deadline).toISOString() }, now)) return { eligible: false, reason: '已截止或锁定' }
  if (entry.choice === 'DECLINED' && !replaceDeclined) return { eligible: false, reason: '保留原有不订餐' }
  if (!['UNSELECTED', 'DECLINED'].includes(entry.choice)) return { eligible: false, reason: '餐次状态无法识别' }
  return { eligible: true, reason: entry.choice === 'DECLINED' ? '不订餐 → 订餐' : '可订餐' }
}
async function batchHealth(identity) {
  const health = await api('/health')
  if (!health?.username || !health?.baseUrl) throw new Error('请先连接饭点账号')
  if (health.batchAccountGuard !== true) throw new Error('请重启 DeepSeek Harness 以启用批量订餐')
  if (identity && (health.username !== identity.username || health.baseUrl !== identity.baseUrl)) throw new Error('饭点账号或服务地址已变化，请重新预览')
  return { username: health.username, baseUrl: health.baseUrl }
}
async function batchCalendar(month, identity) {
  const value = await api('/panel?month=' + encodeURIComponent(month))
  if (!value?.configured || value.username !== identity.username || value.baseUrl !== identity.baseUrl || value.month !== month) throw new Error('账号或日历月份不一致，请重新预览')
  if (value.profile?.username && value.profile.username !== identity.username) throw new Error('登录账号不一致，请重新预览')
  return value
}
function BatchPanel({ panel, parentBusy, onBusy, onRefresh }) {
  const initial = panel?.today || serviceDate(Date.now())
  const [open, setOpen] = useState(false)
  const [start, setStart] = useState(initial)
  const [end, setEnd] = useState(() => {
    const y = Number(initial.slice(0,4)), m = Number(initial.slice(5,7))
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0,10)
  })
  const [lunch, setLunch] = useState(true)
  const [dinner, setDinner] = useState(false)
  const [replace, setReplace] = useState(false)
  const [rows, setRows] = useState([])
  const [identity, setIdentity] = useState(null)
  const [status, setStatus] = useState('选择日期和餐次，预览后确认。')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const stop = useRef(false)
  const mounted = useRef(true)
  const working = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop.current = true } }, [])
  const tell = (text, failed = false) => { if (mounted.current) { setStatus(text); setError(failed) } }
  const invalidate = () => { setRows([]); setIdentity(null); setDone(false); tell('设置已更改，请重新预览。') }
  const changeRange = kind => {
    const today = panel?.today || serviceDate(Date.now())
    const year = Number(today.slice(0,4)), month = Number(today.slice(5,7))
    const iso = n => new Date(n).toISOString().slice(0,10)
    setStart(kind === 'next' ? iso(Date.UTC(year, month, 1)) : today)
    setEnd(kind === 'week' ? iso(batchStamp(today) + 6 * BATCH_DAY_MS) : iso(Date.UTC(year, month + (kind === 'next' ? 1 : 0), 0)))
    invalidate()
  }
  const updateRow = (key, patch) => { if (mounted.current) setRows(old => old.map(row => row.key === key ? { ...row, ...patch } : row)) }
  const preview = async () => {
    if (working.current || parentBusy) return
    working.current = true; setBusy(true); onBusy?.(true); setRows([]); setIdentity(null); setDone(false)
    try {
      const dates = batchDates(start, end)
      const meals = [lunch && 'LUNCH', dinner && 'DINNER'].filter(Boolean)
      if (!meals.length) throw new Error('请至少选择一个餐次')
      const who = await batchHealth()
      if (who.username !== panel?.username || who.baseUrl !== panel?.baseUrl) throw new Error('账号已变化，请刷新面板')
      const calendars = new Map()
      for (const month of new Set(dates.map(date => date.slice(0, 7)))) {
        await batchHealth(who)
        calendars.set(month, await batchCalendar(month, who))
      }
      await batchHealth(who)
      const next = dates.flatMap(date => meals.map(meal => {
        const info = batchDayInfo(date), result = batchEligibility(date, meal, calendars.get(date.slice(0,7)), replace)
        return { key: date + '/' + meal, date, meal, ...info, ...result, selected: result.eligible, result: '' }
      }))
      if (!mounted.current) return
      setRows(next); setIdentity(who)
      tell(`账号：${who.username}；工作日 ${new Set(next.filter(row => row.workday).map(row => row.date)).size} 天，可订 ${next.filter(row => row.selected).length} 餐。请逐项核对。`)
    } catch (failure) { tell(failure?.message || '预览失败', true) }
    finally { working.current = false; if (mounted.current) setBusy(false); onBusy?.(false) }
  }
  const submit = async () => {
    if (working.current || parentBusy || !identity || done) return
    const chosen = rows.filter(row => row.eligible && row.selected)
    if (!chosen.length) return
    if (!navigator.locks?.request) { tell('当前浏览器不支持跨标签任务锁，无法安全提交。', true); return }
    working.current = true; stop.current = false; setBusy(true); onBusy?.(true)
    let started = false
    try {
      await navigator.locks.request('dsh-meal-batch', { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new Error('另一个标签页正在批量点餐，请稍后重试')
        started = true
        tell(`正在为 ${identity.username} 逐餐提交；可停止后续。`)
        let failed = '', successes = 0, skipped = 0, attempted = 0
        for (const row of chosen) {
          if (stop.current || failed) { updateRow(row.key, { result: '未执行', reason: failed ? '前一餐异常，后续已停止' : '已停止' }); continue }
          try {
            await batchHealth(identity)
            const fresh = await batchCalendar(row.date.slice(0,7), identity)
            const current = batchEligibility(row.date, row.meal, fresh, replace)
            if (!current.eligible) { skipped++; updateRow(row.key, { result: '跳过', reason: current.reason }); continue }
            await batchHealth(identity)
            if (stop.current) { updateRow(row.key, { result: '未执行', reason: '已停止' }); continue }
            updateRow(row.key, { result: '提交中', reason: '' }); attempted++
            try {
              const result = await api('/selection', { method: 'POST', body: { date: row.date, meal: row.meal, choice: 'ORDERED', expectedUsername: identity.username } })
              if (result?.day?.date !== row.date || mealOf(result.day, row.meal)?.choice !== 'ORDERED') throw new Error('提交响应未确认订餐')
              successes++; updateRow(row.key, { result: '成功', reason: '已订餐' })
            } catch (failure) {
              let confirmed = false
              try {
                await batchHealth(identity)
                const after = await batchCalendar(row.date.slice(0,7), identity)
                const isOrdered = mealOf(after.days.find(day => day.date === row.date), row.meal)?.choice === 'ORDERED'
                await batchHealth(identity)
                confirmed = isOrdered
              } catch { /* result remains uncertain */ }
              if (confirmed) { successes++; updateRow(row.key, { result: '成功', reason: '提交异常，已通过日历核验' }) }
              else updateRow(row.key, { result: '待核对', reason: '提交异常，无法确认；请到日历核对' })
              failed = (failure?.message || '提交异常') + '；后续已停止，请核对并重新预览'
            }
          } catch (failure) { failed = failure?.message || '读取失败'; updateRow(row.key, { result: '失败', reason: failed }) }
        }
        tell(`成功 ${successes} 餐，跳过 ${skipped} 餐，已尝试提交 ${attempted} 餐。${failed || (stop.current ? '已停止后续。' : '执行完成。')}`, Boolean(failed))
      })
    } catch (failure) { tell(failure?.message || '执行失败', true) }
    finally {
      working.current = false
      if (mounted.current) { setBusy(false); if (started) setDone(true) }
      onBusy?.(false)
      if (started) { try { await onRefresh?.() } catch { /* results remain visible */ } }
    }
  }
  const chosenCount = rows.filter(row => row.eligible && row.selected).length
  return h('section', { className: 'mb-batch', 'aria-label': '批量工作日订餐' },
    h('button', { type:'button', className:'mb-batch-toggle', 'aria-expanded':open, disabled:busy || parentBusy, onClick:() => setOpen(!open) }, open ? '▾ 批量工作日订餐' : '▸ 批量工作日订餐'),
    open ? h(React.Fragment, null,
      h('div', { className:'mb-batch-fields' },
        h('label', null, '开始日期', h('input', { type:'date', value:start, disabled:busy, onChange:e => { setStart(e.target.value); invalidate() } })),
        h('label', null, '结束日期', h('input', { type:'date', value:end, disabled:busy, onChange:e => { setEnd(e.target.value); invalidate() } }))),
      h('div', { className:'mb-batch-shortcuts' }, ...[['本月剩余','month'],['下个月','next'],['未来7天','week']].map(([label, kind]) => h('button', { key:kind, type:'button', disabled:busy, onClick:() => changeRange(kind) }, label))),
      h('div', { className:'mb-batch-meals' },
        h('label', null, h('input', { type:'checkbox', checked:lunch, disabled:busy, onChange:e => { setLunch(e.target.checked); invalidate() } }), '午餐'),
        h('label', null, h('input', { type:'checkbox', checked:dinner, disabled:busy, onChange:e => { setDinner(e.target.checked); invalidate() } }), '晚餐')),
      h('label', { className:'mb-batch-option' }, h('input', { type:'checkbox', checked:replace, disabled:busy, onChange:e => { setReplace(e.target.checked); invalidate() } }), '将已选“不订餐”改为订餐'),
      h('div', { className:'mb-batch-actions' }, h('button', { type:'button', disabled:busy || parentBusy, onClick:() => void preview() }, '预览工作日与餐次'),
        h('button', { type:'button', disabled:busy || parentBusy || done || !identity || !chosenCount, onClick:() => void submit() }, `确认订餐 · ${chosenCount} 餐`),
        busy && identity ? h('button', { type:'button', onClick:() => { stop.current = true; tell('已请求停止，当前请求完成并核对后停止。') } }, '停止后续') : null),
      h('div', { className:'mb-batch-status' + (error ? ' mb-batch-error' : ''), role:'status', 'aria-live':'polite' }, status),
      rows.length ? h('div', { className:'mb-batch-list', 'aria-label':'逐餐预览与结果' }, ...rows.map(row => h('label', { className:'mb-batch-row', key:row.key },
        h('input', { type:'checkbox', checked:row.selected, disabled:busy || done || !row.eligible, 'aria-label':`${row.date} ${row.meal === 'LUNCH' ? '午餐' : '晚餐'}`, onChange:e => updateRow(row.key, { selected:e.target.checked }) }),
        h('span', null, `${row.date} ${row.weekday} · ${row.meal === 'LUNCH' ? '午餐' : '晚餐'} · ${row.label}`, h('small', null, `${row.result ? row.result + ' · ' : ''}${row.reason}`))))) : null,
      h('div', { className:'mb-batch-source' }, '仅含 2026 年官方节假日及调休；最多 93 天。请保持页面开启。')) : null)
}


    function RefreshIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M13.2 6.4a5.4 5.4 0 1 0 .3 3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M13.6 2.9v3.6h-3.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function OpenIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M9.2 2.6h4.2v4.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M13.1 2.9 7.5 8.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M12.4 9.4v3.2a.8.8 0 0 1-.8.8H3.4a.8.8 0 0 1-.8-.8V4.4a.8.8 0 0 1 .8-.8h3.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function LockIcon() {
      return h('svg', { width: 8, height: 8, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 2.4, y: 5.2, width: 7.2, height: 5, rx: 1.2, stroke: 'currentColor', strokeWidth: 1.1 }),
        h('path', { d: 'M4.2 5.2V4a1.8 1.8 0 1 1 3.6 0v1.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }))
    }

    function ChevronIcon({ up }) {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    /* ---------------------------------------------------------------- */
    /* pieces                                                            */
    /* ---------------------------------------------------------------- */

    function SummaryChip({ meal, day, t }) {
      const entry = mealOf(day, meal)
      const choice = entry?.choice ?? 'NOT_APPLICABLE'
      const short = meal === 'LUNCH' ? t('lunchShort') : t('dinnerShort')
      const label = choiceLabel(choice, t)
      return h('span', { className: `mb-chip ${stateClass(choice)}`, title: `${short} ${label}`, 'aria-label': `${short} ${label}` }, short)
    }

    function MealRow({ meal, day, now, busy, t, onPick }) {
      const entry = mealOf(day, meal)
      const active = day?.presence === 'IN_OFFICE'
      const locked = isLocked(entry, now)
      const choice = entry?.choice ?? 'NOT_APPLICABLE'
      const disabled = busy || locked || !active

      return h('div', { className: `mb-row${active ? '' : ' is-idle'}` },
        h('span', { className: 'mb-row-name' }, t(meal === 'LUNCH' ? 'lunchShort' : 'dinnerShort')),
        locked ? h('span', { className: 'mb-lock', title: t('lockedShort') }, h(LockIcon)) : null,
        h('span', { className: `mb-row-state ${stateClass(choice)}` }, choiceLabel(choice, t)),
        h('span', { className: 'mb-seg' },
          h('button', {
            type: 'button',
            className: `mb-mini is-order${choice === 'ORDERED' ? ' is-on' : ''}`,
            'aria-pressed': choice === 'ORDERED',
            'aria-label': `${t(meal === 'LUNCH' ? 'lunch' : 'dinner')} ${t('orderAction')}`,
            disabled,
            onClick: () => onPick(meal, 'ORDERED'),
          }, t('orderAction')),
          h('button', {
            type: 'button',
            className: `mb-mini is-decline${choice === 'DECLINED' ? ' is-on' : ''}`,
            'aria-pressed': choice === 'DECLINED',
            'aria-label': `${t(meal === 'LUNCH' ? 'lunch' : 'dinner')} ${t('declineAction')}`,
            disabled,
            onClick: () => onPick(meal, 'DECLINED'),
          }, t('declineAction'))))
    }

    /* ---------------------------------------------------------------- */
    /* panel                                                             */
    /* ---------------------------------------------------------------- */

    function MealPanelBody({ t }) {
      const [panel, setPanel] = useState(null)
      const [selected, setSelected] = useState('')
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [draftName, setDraftName] = useState('')
      const [setupMode, setSetupMode] = useState(false)
      const [confirmLeave, setConfirmLeave] = useState(false)
      const [expanded, setExpanded] = useState(readExpanded)
      const [popoverBox, setPopoverBox] = useState(null)
      const barRef = useRef(null)
      const [, setTick] = useState(0)
      const clockOffset = useRef(0)
      const monthRef = useRef('')
      const rolloverRef = useRef({ date: '', at: 0 })
      const batchBusyRef = useRef(false)
      const loadGeneration = useRef(0)
      const setBatchBusy = useCallback(value => {
        batchBusyRef.current = value
        if (value) loadGeneration.current++
        setBusy(value)
      }, [])

      const applyPanel = useCallback(value => {
        if (!value || typeof value !== 'object') return
        setPanel(value)
        if (typeof value.serverTime === 'string') {
          const stamp = batchTime(value.serverTime)
          if (Number.isFinite(stamp)) clockOffset.current = stamp - Date.now()
        }
        setSelected(prev => {
          const days = Array.isArray(value.days) ? value.days : []
          if (prev && days.some(day => day?.date === prev)) {
            monthRef.current = prev.slice(0, 7)
            return prev
          }
          const next = value.today || days[0]?.date || ''
          monthRef.current = next ? next.slice(0, 7) : ''
          return next
        })
      }, [])

      const load = useCallback(async (month, options) => {
        if (batchBusyRef.current) return
        const generation = ++loadGeneration.current
        const silent = options?.silent === true
        if (!silent) setLoading(true)
        setError('')
        try {
          const query = month ? `?month=${encodeURIComponent(month)}` : ''
          const value = await api(`/panel${query}`)
          if (generation === loadGeneration.current && !batchBusyRef.current) applyPanel(value)
        } catch (failure) {
          if (generation !== loadGeneration.current || batchBusyRef.current) return
          const message = failure?.message === 'OFFLINE'
            ? t('offline')
            : failure?.message || t('loadFailed')
          if (silent) setToast({ kind: 'err', text: message })
          else setError(message)
        } finally {
          if (!silent) setLoading(false)
        }
      }, [applyPanel, t])

      useEffect(() => { void load() }, [load])

      useEffect(() => {
        const id = setInterval(() => {
          if (document.hidden) return
          void load(monthRef.current, { silent: true })
        }, 60_000)
        const onFocus = () => { void load(monthRef.current, { silent: true }) }
        window.addEventListener('focus', onFocus)
        return () => {
          clearInterval(id)
          window.removeEventListener('focus', onFocus)
        }
      }, [load])

      useEffect(() => {
        const id = setInterval(() => setTick(value => value + 1), 30_000)
        return () => clearInterval(id)
      }, [])

      // Follow the service's calendar: when its clock crosses midnight the
      // summary must switch to the new day without waiting for a manual refresh.
      const serviceToday = panel?.today ?? ''
      useEffect(() => {
        if (!serviceToday) return
        const check = () => {
          const expected = serviceDate(Date.now() + clockOffset.current)
          if (expected === serviceToday) return
          const stamp = Date.now()
          const last = rolloverRef.current
          if (last.date === expected && stamp - last.at < 60_000) return
          rolloverRef.current = { date: expected, at: stamp }
          monthRef.current = expected.slice(0, 7)
          setSelected(expected)
          void load(expected.slice(0, 7), { silent: true })
        }
        check()
        const id = setInterval(check, 30_000)
        return () => clearInterval(id)
      }, [serviceToday, load])

      useEffect(() => {
        if (!toast) return
        const id = setTimeout(() => setToast(null), 2800)
        return () => clearTimeout(id)
      }, [toast])

      const now = Date.now() + clockOffset.current
      const days = Array.isArray(panel?.days) ? panel.days : []
      const day = days.find(entry => entry?.date === selected) ?? null
      const today = panel?.today ?? ''
      const todayDay = days.find(entry => entry?.date === today) ?? null
      const lunchReminder = needsLunchReminder(panel, todayDay, now)
      const upcoming = useMemo(() => days.filter(entry => entry?.date >= today).slice(0, 7), [days, today])

      const toggleExpanded = useCallback(() => {
        const next = !expanded
        writeExpanded(next)
        setExpanded(next)
        if (!next && panel?.today) {
          // The collapsed row always speaks about today; make the expanded
          // panel open on the same day instead of a stale selection.
          monthRef.current = panel.today.slice(0, 7)
          setSelected(panel.today)
        }
      }, [expanded, panel?.today])

      const mergeDay = useCallback(nextDay => {
        if (!nextDay?.date) return
        setPanel(prev => {
          if (!prev) return prev
          return {
            ...prev,
            days: (prev.days ?? []).map(entry => entry?.date === nextDay.date ? { ...entry, ...nextDay } : entry),
          }
        })
      }, [])

      const pick = useCallback(async (meal, choice) => {
        if (busy || !selected) return
        setBusy(true)
        try {
          const value = await api('/selection', { method: 'POST', body: { date: selected, meal, choice } })
          mergeDay(value?.day)
          setToast({ kind: 'ok', text: t('saved') })
        } catch (failure) {
          setToast({ kind: 'err', text: failure?.message || t('loadFailed') })
          void load(monthRef.current, { silent: true })
        } finally {
          setBusy(false)
        }
      }, [busy, selected, mergeDay, t, load])

      const setPresence = useCallback(async presence => {
        setBusy(true)
        try {
          await api('/presence', { method: 'POST', body: { presence } })
          setConfirmLeave(false)
          setToast({ kind: 'ok', text: presence === 'IN_OFFICE' ? t('inOffice') : t('outOffice') })
          await load(monthRef.current, { silent: true })
        } catch (failure) {
          setToast({ kind: 'err', text: failure?.message || t('loadFailed') })
        } finally {
          setBusy(false)
        }
      }, [load, t])

      const submitName = useCallback(async () => {
        const username = draftName.trim()
        if (!username) {
          setToast({ kind: 'err', text: t('setupRequired') })
          return
        }
        setBusy(true)
        setError('')
        try {
          applyPanel(await api('/login', { method: 'POST', body: { username } }))
          setSetupMode(false)
          setToast({ kind: 'ok', text: t('connected') })
        } catch (failure) {
          setError(failure?.message || t('loadFailed'))
        } finally {
          setBusy(false)
        }
      }, [draftName, applyPanel, t])

      useLayoutEffect(() => {
        if (!expanded || !barRef.current) {
          setPopoverBox(null)
          return
        }
        const update = () => {
          const rect = barRef.current?.getBoundingClientRect()
          if (!rect) return
          setPopoverBox({ left: rect.left, width: rect.width, bottom: Math.max(0, window.innerHeight - rect.top + 4), maxHeight: Math.max(0, rect.top - 8) })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
        observer?.observe(barRef.current)
        return () => {
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', update, true)
          observer?.disconnect()
        }
      }, [expanded, setupMode, panel?.configured, Boolean(panel), loading, error])

      const dateLabel = day ? `${monthDayOf(day.date)} ${weekdayName(day.date, t)}` : ''
      const needsSetup = setupMode || panel?.configured === false

      const refreshButton = onRefresh => h('button', {
        type: 'button',
        className: 'mb-icon',
        title: t('refresh'),
        'aria-label': t('refresh'),
        disabled: loading,
        onClick: onRefresh,
      }, h(RefreshIcon))

      const openButton = h('button', {
        type: 'button',
        className: 'mb-icon',
        title: t('openSite'),
        'aria-label': t('openSite'),
        onClick: () => window.open(`${panel?.baseUrl ?? ''}${OPEN_SITE_PATH}`, '_blank', 'noopener,noreferrer'),
      }, h(OpenIcon))

      /* ---- setup / first-run ---- */

      if (needsSetup) {
        return h('div', { className: 'mb-root' },
          h('style', null, CSS),
          h('div', { className: 'mb-card' },
            h('div', { className: 'mb-head' },
              h('span', { className: 'mb-title' }, t('setupTitle')),
              h('span', { className: 'mb-spacer' }),
              panel && panel.configured !== false
                ? h('button', {
                  type: 'button',
                  className: 'mb-icon',
                  title: t('collapse'),
                  'aria-label': t('collapse'),
                  onClick: () => { setSetupMode(false); toggleExpanded() },
                }, h(ChevronIcon, { up: true }))
                : null),
            h('div', { className: 'mb-hint' }, t('setupHint')),
            h('input', {
              className: 'mb-input',
              value: draftName,
              placeholder: t('setupPlaceholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: event => setDraftName(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter') void submitName() },
            }),
            h('div', { className: 'mb-actions' },
              h('button', { type: 'button', className: 'mb-btn is-primary', disabled: busy, onClick: () => void submitName() },
                busy ? t('saving') : t('setupSubmit'))),
            error ? h('div', { className: 'mb-error' }, error) : null))
      }

      /* ---- loading ---- */

      if (loading && !panel) {
        return h('div', { className: 'mb-root' },
          h('style', null, CSS),
          h('div', { className: 'mb-skeleton' }))
      }

      /* ---- hard error ---- */

      if (error && !panel) {
        return h('div', { className: 'mb-root' },
          h('style', null, CSS),
          h('div', { className: 'mb-card' },
            h('div', { className: 'mb-head' },
              h('span', { className: 'mb-title' }, t('title')),
              h('span', { className: 'mb-spacer' }),
              refreshButton(() => void load(monthRef.current))),
            h('div', { className: 'mb-error' }, error),
            h('div', { className: 'mb-actions' },
              h('button', { type: 'button', className: 'mb-btn', onClick: () => { setError(''); void load(monthRef.current) } }, t('retry')),
              h('button', { type: 'button', className: 'mb-btn', onClick: () => { setError(''); setSetupMode(true) } }, t('changeUser')))))
      }

      /* ---- persistent summary row ---- */

      const summaryBar = h('button', {
        ref: barRef,
        type: 'button',
        className: `mb-bar${todayDay ? '' : ' is-empty'}`,
        title: `${today ? `${monthDayOf(today)} ${weekdayName(today, t)} · ${t('today')}` : t('title')} · ${t(expanded ? 'collapse' : 'expand')}`,
        'aria-expanded': expanded,
        disabled: busy,
        onClick: toggleExpanded,
      },
        h('span', { className: 'mb-bar-mark' }, h(SpoonIcon)),
        h('span', { className: 'mb-bar-title' }, t('title')),
        h('span', { className: 'mb-chips' },
          h(SummaryChip, { meal: 'LUNCH', day: todayDay, t }),
          h(SummaryChip, { meal: 'DINNER', day: todayDay, t })),
        lunchReminder ? h('span', { className: 'mb-reminder', title: t('lunchReminderHint'), role: 'status' }, t('lunchReminder')) : null,
        h('span', { className: 'mb-bar-spacer' }),
        error ? h('span', { className: 'mb-chip is-unselected', title: error }, '!') : null,
        h('span', { className: 'mb-bar-chevron' }, h(ChevronIcon, { up: expanded })))

      if (!expanded) {
        return h('div', { className: 'mb-root' }, h('style', null, CSS), summaryBar)
      }

      /* ---- expanded panel ---- */

      return h('div', { className: 'mb-root' },
        h('style', null, CSS + BATCH_CSS),
        summaryBar,
        popoverBox && document.body ? createPortal(h('div', { className: 'mb-card mb-popover', style: popoverBox },
          h('div', { className: 'mb-head' },
            h('span', { className: 'mb-title' }, t('title')),
            dateLabel ? h('span', { className: 'mb-date' }, dateLabel) : null,
            h('span', { className: 'mb-spacer' }),
            h('button', {
              type: 'button',
              className: 'mb-presence',
              title: panel?.profile?.departmentName
                ? `${t('inOffice')} · ${panel.profile.departmentName}`
                : t('inOffice'),
              disabled: busy,
              onClick: () => {
                if (panel?.presence === 'IN_OFFICE') setConfirmLeave(true)
                else void setPresence('IN_OFFICE')
              },
            },
              h('span', { className: `mb-dot${panel?.presence === 'IN_OFFICE' ? ' is-in' : panel?.presence === 'OUT_OF_OFFICE' ? ' is-out' : ''}` }),
              h('span', { className: 'mb-presence-text' },
                panel?.presence === 'IN_OFFICE' ? t('inShort') : panel?.presence === 'OUT_OF_OFFICE' ? t('outShort') : t('notJoined'))),
            refreshButton(() => void load(monthRef.current, { silent: true })),
            openButton),
          lunchReminder ? h('div', { className: 'mb-reminder', role: 'status', title: t('lunchReminderHint') }, t('lunchReminder')) : null,
          confirmLeave
            ? h('div', { className: 'mb-confirm' },
              h('div', null, t('leaveConfirm')),
              h('div', { className: 'mb-actions' },
                h('button', { type: 'button', className: 'mb-btn is-primary', disabled: busy, onClick: () => void setPresence('OUT_OF_OFFICE') }, t('confirm')),
                h('button', { type: 'button', className: 'mb-btn', disabled: busy, onClick: () => setConfirmLeave(false) }, t('cancel'))))
            : null,
          h('div', { className: 'mb-rows' },
            h(MealRow, { meal: 'LUNCH', day, now, busy, t, onPick: pick }),
            h(MealRow, { meal: 'DINNER', day, now, busy, t, onPick: pick })),
          h('div', { className: `mb-hint${day && day.presence === 'IN_OFFICE' && dayHint(day, now, t) === t('closedAll') ? ' is-warn' : ''}` },
            dayHint(day, now, t)),
          upcoming.length > 1
            ? h('div', { className: 'mb-days', role: 'group', 'aria-label': t('pickDate') },
              ...upcoming.map(entry => {
                const lunch = mealOf(entry, 'LUNCH')
                const dinner = mealOf(entry, 'DINNER')
                return h('button', {
                  key: entry.date,
                  type: 'button',
                  className: `mb-day${entry.date === selected ? ' is-on' : ''}`,
                  title: `${monthDayOf(entry.date)} ${weekdayName(entry.date, t)}`,
                  'aria-pressed': entry.date === selected,
                  disabled: busy,
                  onClick: () => {
                    setSelected(entry.date)
                    monthRef.current = entry.date.slice(0, 7)
                    if (panel && panel.month !== entry.date.slice(0, 7)) void load(entry.date.slice(0, 7), { silent: true })
                  },
                },
                  h('span', null, entry.date === today ? t('today') : weekdayName(entry.date, t)),
                  h('span', { className: 'mb-day-num' }, Number(entry.date.slice(8, 10))),
                  h('span', { className: 'mb-day-dots' },
                    h('span', { className: `mb-day-dot ${stateClass(lunch?.choice)}` }),
                    h('span', { className: `mb-day-dot ${stateClass(dinner?.choice)}` })))
              }))
            : null,
          h(BatchPanel, { panel, parentBusy: busy, onBusy: setBatchBusy, onRefresh: () => load(monthRef.current, { silent: true }) }),
          toast ? h('div', { className: `mb-toast is-${toast.kind}` }, toast.text) : null), document.body) : null)
    }

    function MealPanel(props) {
      if (props.wide === false) return null
      return h(MealPanelBody, { t: props.t })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = makeTranslate(ctx)

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'meal-panel',
          order: 50,
          label: () => t('title'),
        }, props => h(MealPanel, { ...props, t })))
      },
    }
  },
})
