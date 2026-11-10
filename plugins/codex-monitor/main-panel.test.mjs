import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')

function loadClient(React, { ctx: services, window, document, fetch } = {}) {
  let definition
  const styles = new Set()
  runInNewContext(source, {
    AbortController, AbortSignal, fetch,
    window: { ...window, __ModuleLoader__: { load(value) { definition = value } } },
    document: {
      createElement(tag) {
        assert.equal(tag, 'style')
        return { dataset: {}, remove() { styles.delete(this) } }
      },
      head: { appendChild(style) { styles.add(style) } },
      ...document
    }
  })
  const client = definition.factory((name) => {
    if (name === 'react') return React
    assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives')
    return {}
  })
  const registrations = new Map()
  const cleanups = []
  const ctx = {
    sidebarRightTabs: { register: () => () => {} },
    ...services,
    effect(effect) {
      const dispose = effect()
      if (dispose) cleanups.push(dispose)
    },
    slots: {
      inject(_name, install) { cleanups.push(install()) },
      register(options, component) {
        assert.equal(registrations.has(options.name), false)
        registrations.set(options.name, { options, component })
        return () => registrations.delete(options.name)
      }
    }
  }
  client.apply(ctx)
  return { client, styles, registrations, dispose: () => cleanups.reverse().forEach((dispose) => dispose()) }
}

const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })

test('主页面与原生右栏分别注册，反复打开时复用当前会话的右栏标签，卸载时清理', () => {
  const selected = []
  const actions = []
  const definitions = new Set()
  const openTabs = [{ sessionId: 'other', kind: 'codex-monitor-running', tabId: 'other-tab' }]
  let expanded = false
  const { client, styles, registrations, dispose } = loadClient({ createElement, useState: () => ['', () => {}] }, {
    ctx: {
      layout: { selectPanel(id) { selected.push(id) } },
      sidebarRightTabs: { register(definition) { definitions.add(definition); return () => definitions.delete(definition) } },
      sidebarRight: {
        mounted: { getSnapshot: () => 'current' },
        openTabs: { getSnapshot: () => openTabs },
        openTab(kind) { actions.push(['open', kind]); openTabs.push({ sessionId: 'current', kind, tabId: 'current-tab' }) },
        isExpanded: () => expanded,
        toggleExpanded() { actions.push(['expand']); expanded = true },
        focus(id) { actions.push(['focus', id]) }
      }
    }
  })
  try {
    assert.deepEqual(Array.from(client.inject), ['slots', 'layout', 'sidebarRight', 'sidebarRightTabs'])
    assert.equal(styles.size, 1)
    const main = registrations.get('main')
    assert.equal(main.component, client.BoardPanel)
    assert.equal(main.options.key, 'codex-monitor')
    assert.equal(main.options.id, main.options.key)
    const entry = registrations.get('sidebar.footer.action')
    for (const wide of [true, false]) {
      const element = entry.component({ wide })
      const button = element.type(element.props)
      assert.equal(button.type, 'button')
      assert.equal(button.props['aria-label'], '打开会话看板')
      assert.equal(button.props['aria-haspopup'], undefined)
      assert.equal(button.props.className, wide ? 'cdm-trigger' : 'cdm-trigger cdm-rail')
      button.props.onClick()
      button.props.onClick()
    }
    assert.deepEqual(selected, Array(4).fill(main.options.key))
    selected.length = 0
    const [definition] = definitions
    assert.equal(definition.title(), '运行中的会话')
    assert.equal(registrations.get('sidebar.right.pane.tab').options.key, definition.id)
    const button = registrations.get('conversation.session.header.actions').component()
    assert.equal(button.props['aria-label'], '在右侧栏打开运行中的会话')
    button.props.onClick()
    expanded = false
    button.props.onClick()
    assert.deepEqual(actions, [['open', definition.kind], ['expand'], ['expand'], ['focus', 'current-tab']])
    assert.deepEqual(selected, [])
  } finally {
    dispose()
    assert.equal(styles.size, 0)
    assert.equal(registrations.size, 0)
    assert.equal(definitions.size, 0)
  }
})

test('右栏只读取运行快照，轮次结束后移除卡片和预览，隐藏后中止轮询', async () => {
  let visible = true
  let next = { generatedAt: 'now', sessions: [
    { sessionId: 'active', status: 'running' },
    { sessionId: 'finished', status: 'turn_completed', reviewable: true },
    { sessionId: 'reviewed', status: 'record', rawStatus: 'running' },
    { sessionId: 'unconfirmed', status: 'unknown' }
  ] }
  const states = []
  let stateIndex = 0
  let dependencies, install, cleanup, interval
  const listeners = new Map()
  const requests = []
  const { client, registrations, dispose } = loadClient({
    createElement,
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = initial
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useEffect(effect, deps) {
      if (dependencies?.[0] === deps[0]) return
      dependencies = deps
      install = () => { cleanup?.(); cleanup = effect() }
    }
  }, {
    window: {
      setTimeout, clearTimeout,
      setInterval(load) { interval = load; return load },
      clearInterval(load) { assert.equal(interval, load); interval = undefined }
    },
    document: {
      visibilityState: 'visible',
      addEventListener(name, load) { listeners.set(name, load) },
      removeEventListener(name, load) { assert.equal(listeners.get(name), load); listeners.delete(name) }
    },
    fetch(path, { method, signal }) {
      requests.push({ path, method, signal })
      if (next) return Promise.resolve({ ok: true, async json() { return next } })
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
  })
  const panel = registrations.get('sidebar.right.pane.tab').component
  const render = () => {
    stateIndex = 0
    const tree = panel({ useTabInfo: () => ({ tab: { visible } }) })
    install?.()
    install = undefined
    return tree
  }
  const nodes = (tree) => tree?.children ? [tree, ...tree.children.flatMap(nodes)] : []
  const cards = (tree) => nodes(tree).filter((node) => node.type === client.SessionCard)
  try {
    render()
    await new Promise((resolve) => setImmediate(resolve))
    const [card] = cards(render())
    assert.deepEqual(cards(render()).map((node) => node.props.session.sessionId), ['active'])
    assert.equal(nodes(client.SessionCard(card.props)).some((node) => node.children.includes('移除会话')), false)
    card.props.onPreview()
    assert.ok(nodes(render()).some((node) => node.type === client.ConversationPreview))

    next = { ...next, sessions: [{ sessionId: 'active', status: 'turn_completed' }] }
    await interval()
    const completed = render()
    assert.equal(cards(completed).length, 0)
    assert.ok(nodes(completed).some((node) => node.children.includes('暂无正在执行的会话')))
    assert.equal(nodes(completed).some((node) => node.type === client.ConversationPreview), false)

    next = null
    const pending = interval()
    visible = false
    render()
    await pending
    assert.equal(interval, undefined)
    assert.equal(listeners.size, 0)
    assert.equal(requests.at(-1).signal.aborted, true)
    assert.deepEqual(requests.map(({ path, method }) => [path, method]), Array(3).fill(['/codex-monitor/sessions', 'GET']))
  } finally {
    cleanup?.()
    dispose()
  }
})
