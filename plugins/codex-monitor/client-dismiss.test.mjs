import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
const running = { sessionId: 'running', status: 'running', title: 'dirty run', observedAt: '2026-10-24T06:58:18.717Z' }
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props))
  return [tree, ...tree.children.flatMap(nodes)]
}

function mountBoard(status = 200) {
  const slots = []; const effects = []; const requests = []; const intervals = new Set(); const listeners = new Set()
  let index = 0; let dirty = false; let tree; let definition; let generation = 0; let finish
  let current = { ...running }
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() } },
    useState(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = initial; return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; dirty = true }] },
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
  const response = (body, code = 200) => ({ status: code, ok: code < 400, async json() { return body } })
  runInNewContext(source, {
    URL, AbortController, document: { body: {}, visibilityState: 'visible' },
    window: {
      __ModuleLoader__: { load(value) { definition = value } }, setTimeout, clearTimeout,
      setInterval(fn) { intervals.add(fn); return fn }, clearInterval(fn) { intervals.delete(fn) },
      addEventListener(_name, fn) { listeners.add(fn) }, removeEventListener(_name, fn) { listeners.delete(fn) }
    },
    fetch(path, init) {
      requests.push({ path, body: init.body ? JSON.parse(init.body) : null })
      if (path.endsWith('/dismiss-running')) return new Promise(resolve => {
        finish = () => {
          if (status === 200) current = { ...current, status: 'record' }
          if (status === 409) current = { ...current, observedAt: '2026-10-24T07:00:00.000Z' }
          resolve(response(status === 200 ? { dismissed: true } : { error: 'server rejected removal' }, status))
        }
      })
      if (path.endsWith('/refresh')) { generation++; return Promise.resolve(response({ accepted: true })) }
      assert.equal(path, '/codex-monitor/sessions')
      return Promise.resolve(response({ sessions: [current], generatedAt: String(generation), refreshing: false, health: { index: 'ok', records: 'ok' } }))
    }
  })
  const client = definition.factory(name => name === 'react' ? React : name === 'react-dom' ? { createPortal: node => node } : {})
  const render = () => { index = 0; dirty = false; tree = client.BoardPanel({ onClose() {} }) }
  render()
  return {
    requests, client,
    get tree() { return tree },
    async flush() {
      for (let round = 0; round < 20; round++) {
        if (dirty) render()
        while (effects.length) effects.shift()()
        await new Promise(resolve => setImmediate(resolve))
        if (!dirty && !effects.length) break
      }
    },
    button(label = '移除会话') { return nodes(tree).find(node => node.type === 'button' && node.children.includes(label)) },
    finish() { assert.ok(finish); finish(); finish = null },
    dispose() {
      finish?.()
      slots.forEach(slot => slot?.cleanup?.())
      assert.equal(intervals.size, 0)
      assert.equal(listeners.size, 0)
    }
  }
}

test('only running cards offer removal; a missing turn identity disables it', () => {
  const board = mountBoard()
  try {
    for (const status of ['record', 'turn_completed', 'unknown']) {
      const card = board.client.SessionCard({ session: { ...running, status } })
      assert.equal(nodes(card).some(node => node.children.includes('移除会话')), false)
    }
    const card = board.client.SessionCard({ session: { ...running, observedAt: null } })
    assert.equal(nodes(card).find(node => node.children.includes('移除会话')).props.disabled, true)
  } finally { board.dispose() }
})

test('click sends the exact observed turn once and moves the card after success', { timeout: 5000 }, async () => {
  const board = mountBoard()
  try {
    await board.flush()
    const click = board.button().props.onClick
    click(); click()
    await board.flush()
    assert.equal(board.button('移除中…').props.disabled, true)
    assert.deepEqual(board.requests.filter(r => r.path.endsWith('/dismiss-running')), [{
      path: '/codex-monitor/dismiss-running', body: { sessionId: running.sessionId, observedAt: running.observedAt }
    }])
    board.finish(); await board.flush()
    assert.equal(board.button(), undefined)
    assert.ok(nodes(board.tree).some(node => node.children.includes('已移出运行中，历史记录保留')))
    assert.equal(nodes(board.tree).filter(node => node.type === 'article').length, 1)
  } finally { board.dispose() }
})

test('a changed turn is refreshed without retrying removal; the newer run stays visible', { timeout: 5000 }, async () => {
  const board = mountBoard(409)
  try {
    await board.flush(); board.button().props.onClick(); await board.flush()
    board.finish(); await board.flush()
    assert.equal(board.button().props.disabled, false)
    assert.equal(board.requests.filter(r => r.path.endsWith('/dismiss-running')).length, 1)
    assert.ok(board.requests.some(r => r.path.endsWith('/refresh') && r.body.sessionId === running.sessionId))
    assert.ok(nodes(board.tree).some(node => node.props.className === 'cdm-metaError' && node.children.some(text => String(text).includes('未移除'))))
  } finally { board.dispose() }
})

test('server failure keeps the card and restores the action without reporting success', { timeout: 5000 }, async () => {
  const board = mountBoard(500)
  try {
    await board.flush(); board.button().props.onClick(); await board.flush()
    board.finish(); await board.flush()
    assert.equal(board.button().props.disabled, false)
    assert.ok(nodes(board.tree).some(node => node.props.className === 'cdm-metaError'))
    assert.equal(nodes(board.tree).some(node => node.children.includes('已移出运行中，历史记录保留')), false)
  } finally { board.dispose() }
})
