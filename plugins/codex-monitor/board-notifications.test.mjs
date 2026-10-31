import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(process.env.CODEX_MONITOR_TEST_CLIENT_FILE || new URL('./client.js', import.meta.url), 'utf8')
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)] }

function mountBoard({ supported = true, testStatus = 200, testResults, channels, sessions = [] } = {}) {
  const slots = []; const effects = []; const requests = []; const intervals = new Set(); const listeners = new Set()
  let index = 0; let dirty = false; let tree; let definition; let generation = 0; let resolveTest
  let notificationSettings = { windowsEnabled: true, imEnabled: false, botId: '', targetId: '' }
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]))
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() } },
    useState(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = initial; return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; dirty = true }] },
    useRef(initial) { const slot = index++; return slots[slot] ||= { current: initial } },
    useCallback(fn, deps) { const slot = index++; if (!same(slots[slot]?.deps, deps)) slots[slot] = { fn, deps }; return slots[slot].fn },
    useEffect(fn, deps) {
      const slot = index++
      if (!same(slots[slot]?.deps, deps)) {
        const previous = slots[slot]; slots[slot] = { deps, cleanup: previous?.cleanup }
        effects.push(() => { previous?.cleanup?.(); slots[slot].cleanup = fn() })
      }
    }
  }
  const response = (body, status = 200) => ({ status, ok: status < 400, async json() { return body } })
  runInNewContext(source, {
    URL, AbortController, document: { body: {}, visibilityState: 'visible' },
    window: {
      __ModuleLoader__: { load(value) { definition = value } }, setTimeout, clearTimeout,
      setInterval(fn) { intervals.add(fn); return fn }, clearInterval(fn) { intervals.delete(fn) },
      addEventListener(_name, fn) { listeners.add(fn) }, removeEventListener(_name, fn) { listeners.delete(fn) }
    },
    fetch(path, init) {
      requests.push({ path, init })
      if (path.endsWith('/notifications/test')) return new Promise((resolve) => { resolveTest = () => resolve(response(testStatus === 200 ? { accepted: true, results: testResults || [{ channel: 'windows', sent: true }] } : { error: 'notification unavailable' }, testStatus)) })
      if (path.endsWith('/notifications/settings')) {
        if (init?.method === 'POST') notificationSettings = JSON.parse(init.body)
        return Promise.resolve(response({ supported: true, enabled: true, settings: notificationSettings, channels, targets: [{ botId: 'bot_test', targetId: 'phone', label: '微信 · 手机' }] }))
      }
      if (path.endsWith('/refresh')) { generation++; return Promise.resolve(response({ accepted: true }, 202)) }
      assert.equal(path, '/codex-monitor/sessions')
      return Promise.resolve(response({ sessions, generatedAt: `2026-10-07T01:0${generation}:00Z`, refreshing: false, health: { index: 'ok', rollout: 'ok', records: 'ok' }, notifications: { supported, enabled: supported, lastError: null, channels } }))
    }
  })
  const client = definition.factory((name) => name === 'react' ? React : name === 'react-dom' ? { createPortal(node) { return node } } : {})
  const props = { onClose() {} }
  const render = () => { index = 0; dirty = false; tree = client.BoardPanel(props); return tree }
  render()
  return {
    requests, intervals, listeners,
    get tree() { return tree },
    async flush() {
      for (let round = 0; round < 12; round++) {
        if (dirty) render()
        while (effects.length) effects.shift()()
        await new Promise((resolve) => setImmediate(resolve))
        if (!dirty && !effects.length) break
      }
    },
    button() { return nodes(tree).find((node) => node.type === 'button' && node.props['aria-label'] === '发送测试通知') },
    finishTest() { assert.ok(resolveTest); resolveTest() },
    dispose() { slots.forEach((slot) => slot?.cleanup?.()) }
  }
}

test('通知服务已开启时完整看板能够加载，测试通知显示忙碌和成功状态', { timeout: 5000 }, async () => {
  const board = mountBoard()
  try {
    await board.flush()
    assert.equal(board.tree.type, 'section')
    assert.equal(board.tree.props['aria-labelledby'], 'cdm-title')
    assert.equal(nodes(board.tree).some((node) => node.props.role === 'dialog'), false)
    assert.ok(nodes(board.tree).some((node) => node.type === 'main'))
    assert.equal(board.button().props.disabled, false)
    board.button().props.onClick()
    await board.flush()
    assert.equal(board.button().props.disabled, true)
    assert.ok(board.button().children.includes('发送中…'))
    board.finishTest()
    await board.flush()
    assert.equal(board.button().props.disabled, false)
    assert.ok(nodes(board.tree).some((node) => node.props.role === 'status' && node.children.includes('Windows：已提交')))
    assert.equal(board.requests.filter((request) => request.path.endsWith('/notifications/test')).length, 1)
  } finally {
    board.dispose()
    assert.equal(board.intervals.size, 0)
    assert.equal(board.listeners.size, 0)
  }
})

test('通知失败仍保留看板和可重试按钮', { timeout: 5000 }, async () => {
  const board = mountBoard({ testStatus: 500 })
  try {
    await board.flush()
    board.button().props.onClick()
    await board.flush()
    board.finishTest()
    await board.flush()
    assert.equal(board.button().props.disabled, false)
    assert.ok(nodes(board.tree).some((node) => node.type === 'main'))
    assert.ok(nodes(board.tree).some((node) => node.props.className === 'cdm-metaError'))
  } finally { board.dispose() }
})

test('未支持 Windows 通知时看板仍正常加载', { timeout: 5000 }, async () => {
  const board = mountBoard({ supported: false })
  try {
    await board.flush()
    assert.equal(board.button(), undefined)
    assert.ok(nodes(board.tree).some((node) => node.type === 'main'))
  } finally { board.dispose() }
})

test('主页面没有关闭按钮或全局 Escape 处理；Escape 只关闭会话预览', { timeout: 5000 }, async () => {
  const session = { sessionId: 'codex:preview', provider: 'codex', status: 'record', title: '预览' }
  const board = mountBoard({ sessions: [session] })
  const preview = () => nodes(board.tree).find((node) => typeof node.type === 'function' && node.type.name === 'ConversationPreview')
  try {
    await board.flush()
    assert.equal(board.listeners.size, 0)
    assert.equal(nodes(board.tree).some((node) => node.props['aria-label'] === '关闭会话看板'), false)
    assert.equal(nodes(board.tree).some((node) => node.props.className === 'cdm-mask' || node.props.className === 'cdm-overlay'), false)
    nodes(board.tree).find((node) => typeof node.type === 'function' && node.type.name === 'Lane').props.onPreview(session)
    await board.flush()
    assert.equal(preview().props.session.sessionId, session.sessionId)
    assert.equal(board.listeners.size, 1)
    board.listeners.forEach((listener) => listener({ key: 'Escape' }))
    await board.flush()
    assert.equal(preview(), undefined)
    assert.equal(board.listeners.size, 0)
    assert.equal(board.tree.props.className, 'cdm-panel')
    assert.equal(board.intervals.size, 1)
  } finally { board.dispose() }
  assert.equal(board.intervals.size, 0)
})

test('双渠道部分失败展示各自结果，保持测试按钮可用', { timeout: 5000 }, async () => {
  const board = mountBoard({ testResults: [{ channel: 'windows', sent: true }, { channel: 'im', sent: false, error: '机器人未连接' }], channels: {
    windows: { enabled: true }, im: { enabled: true, lastError: '机器人未连接' }
  } })
  try {
    await board.flush()
    assert.ok(nodes(board.tree).some((node) => node.children.includes('IM 通知异常')))
    assert.ok(nodes(board.tree).some((node) => node.props.className === 'cdm-metaError' && node.children.includes('IM：机器人未连接')))
    board.button().props.onClick(); await board.flush(); board.finishTest(); await board.flush()
    assert.ok(nodes(board.tree).some((node) => node.props.role === 'status' && node.children.includes('Windows：已提交；IM：失败')))
    assert.ok(nodes(board.tree).some((node) => node.props.className === 'cdm-metaError' && node.children.includes('IM：机器人未连接')))
    assert.equal(board.button().props.disabled, false)
  } finally { board.dispose() }
})

test('看板可以选择目标并保存独立通知开关', { timeout: 5000 }, async () => {
  const board = mountBoard()
  try {
    await board.flush()
    nodes(board.tree).find((node) => node.type === 'button' && node.children.includes('通知设置')).props.onClick()
    await board.flush()
    const group = () => nodes(board.tree).find((node) => node.props['aria-label'] === '通知设置')
    const inputs = nodes(group()).filter((node) => node.type === 'input')
    inputs[0].props.onChange({ target: { checked: false } }); inputs[1].props.onChange({ target: { checked: true } })
    nodes(group()).find((node) => node.type === 'select').props.onChange({ target: { value: 'bot_test/phone' } })
    await board.flush()
    nodes(group()).find((node) => node.type === 'button').props.onClick()
    await board.flush()
    const save = board.requests.find((request) => request.path.endsWith('/notifications/settings') && request.init.method === 'POST')
    assert.deepEqual(JSON.parse(save.init.body), { windowsEnabled: false, imEnabled: true, botId: 'bot_test', targetId: 'phone' })
    assert.equal(group(), undefined)
    assert.ok(nodes(board.tree).some((node) => node.children.includes('通知设置已保存')))
  } finally { board.dispose() }
})

test('客户端筛选只展示指定来源，切换客户端清除旧的子来源筛选', { timeout: 5000 }, async () => {
  const board = mountBoard({ sessions: [
    { sessionId: 'dsh:one', provider: 'dsh', source: 'dsh', status: 'record', title: 'DSH' },
    { sessionId: 'kimi:one', provider: 'kimi', source: 'kimi-vscode', status: 'turn_completed', title: 'Kimi' },
    { sessionId: 'claude:one', provider: 'claude', source: 'claude-vscode', status: 'record', title: 'Claude' }
  ] })
  const select = (label) => nodes(board.tree).find((node) => node.type === 'select' && node.props['aria-label'] === label)
  const visibleIds = () => nodes(board.tree).filter((node) => typeof node.type === 'function' && node.type.name === 'Lane').flatMap((node) => node.props.sessions.map((session) => session.sessionId))
  try {
    await board.flush()
    assert.equal(visibleIds().length, 3)
    select('按客户端筛选').props.onChange({ target: { value: 'kimi' } }); await board.flush()
    assert.deepEqual(visibleIds(), ['kimi:one'])
    select('按来源筛选').props.onChange({ target: { value: 'kimi-vscode' } }); await board.flush()
    select('按客户端筛选').props.onChange({ target: { value: 'claude' } }); await board.flush()
    assert.equal(select('按来源筛选').props.value, '')
    assert.deepEqual(visibleIds(), ['claude:one'])
  } finally { board.dispose() }
})
