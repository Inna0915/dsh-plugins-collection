import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)] }

function mountPreview(replies) {
  const slots = []; const pendingEffects = []; const requests = []; const copied = []
  let index = 0; let dirty = false; let tree; let definition; let closed = 0
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]))
  const effect = (fn, deps) => {
    const slot = index++
    if (!same(slots[slot]?.deps, deps)) {
      const previous = slots[slot]
      slots[slot] = { deps, cleanup: previous?.cleanup }
      pendingEffects.push(() => { previous?.cleanup?.(); slots[slot].cleanup = fn() })
    }
  }
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      if (props?.ref && !props.ref.current) props.ref.current = { scrollHeight: 2000, scrollTop: 0, focus() {} }
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = initial; return [slots[slot], (next) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; dirty = true }] },
    useRef(initial) { const slot = index++; return slots[slot] ||= { current: initial } },
    useCallback(fn, deps) { const slot = index++; if (!same(slots[slot]?.deps, deps)) slots[slot] = { fn, deps }; return slots[slot].fn },
    useEffect: effect, useLayoutEffect: effect
  }
  const session = { sessionId: 'test', source: 'cli', title: 'preview' }
  runInNewContext(source, {
    URL, AbortController, document: { activeElement: { focus() {} } }, navigator: { clipboard: { async writeText(text) { copied.push(text) } } },
    window: { __ModuleLoader__: { load(value) { definition = value } }, setTimeout, clearTimeout },
    fetch(path, init) {
      requests.push({ path, init, body: JSON.parse(init.body) })
      const reply = replies.shift()
      if (reply === 'pending') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }))
      return Promise.resolve({ status: reply.status || 200, ok: !reply.status || reply.status < 400, async json() { return reply.body || reply } })
    }
  })
  const client = definition.factory((name) => name === 'react' ? React : {})
  const render = () => { index = 0; dirty = false; tree = client.ConversationPreview({ session, onClose() { closed++ } }); return tree }
  render()
  return {
    requests, copied,
    get closed() { return closed },
    get tree() { return tree },
    async flush() {
      for (let round = 0; round < 12; round++) {
        if (dirty) render()
        while (pendingEffects.length) pendingEffects.shift()()
        await new Promise((resolve) => setImmediate(resolve))
        if (!dirty && !pendingEffects.length) break
      }
    },
    button(label) { const button = nodes(tree).find((node) => node.type === 'button' && node.children.includes(label)); assert.ok(button, label); return button },
    dispose() { slots.forEach((slot) => slot?.cleanup?.()) }
  }
}

const record = (id, kind = 'message') => ({ id, role: kind === 'tool' ? 'tool' : 'assistant', kind, text: `body ${id}`, label: 'Shell' })

test('opening reads only this session, paginates older messages and copies text without reviewing', async () => {
  const harness = mountPreview([
    { messages: [record('new'), record('tool', 'tool')], nextCursor: 'older', warnings: [] },
    { messages: [record('old')], nextCursor: null, warnings: [] }
  ])
  try {
    assert.equal(harness.requests.length, 0)
    await harness.flush()
    assert.equal(harness.requests[0].body.sessionId, 'test')
    assert.equal(harness.requests[0].body.cursor, null)
    assert.equal(nodes(harness.tree).find((node) => node.type === 'details').props.open, undefined)
    await harness.button('加载更早记录').props.onClick()
    await harness.flush()
    assert.equal(harness.requests[1].body.cursor, 'older')
    assert.equal(nodes(harness.tree).filter((node) => node.type === 'article').length, 3)
    await harness.button('复制').props.onClick()
    assert.deepEqual(harness.copied, ['body old'])
    assert.ok(harness.requests.every((request) => request.path.endsWith('/conversation')))
  } finally { harness.dispose() }
})

test('closing aborts pending request and Escape only closes the preview', async () => {
  const harness = mountPreview(['pending'])
  try {
    await harness.flush()
    const dialog = nodes(harness.tree).find((node) => node.props.role === 'dialog')
    let stopped = false
    dialog.props.onKeyDown({ key: 'Escape', stopPropagation() { stopped = true } })
    assert.equal(stopped, true)
    assert.equal(harness.closed, 1)
    harness.dispose()
    assert.equal(harness.requests[0].init.signal.aborted, true)
    await harness.flush()
  } finally { harness.dispose() }
})

test('old host errors explain restarting and retry can recover', async () => {
  const harness = mountPreview([{ status: 405, body: {} }, { messages: [record('recovered')], nextCursor: null, warnings: [] }])
  try {
    await harness.flush()
    assert.ok(nodes(harness.tree).some((node) => node.props.role === 'alert' && node.children.some((child) => typeof child === 'string' && child.includes('重启'))))
    await harness.button('重试').props.onClick()
    await harness.flush()
    assert.equal(nodes(harness.tree).filter((node) => node.type === 'article').length, 1)
  } finally { harness.dispose() }
})
