import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')

test('侧栏宽窄入口切换同一个主页面，不创建弹窗；卸载清除页面、入口和样式', () => {
  let definition
  const styles = new Set()
  const registrations = new Map()
  const cleanups = []
  const selected = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } }
  }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    document: {
      createElement(tag) {
        assert.equal(tag, 'style')
        return { dataset: {}, remove() { styles.delete(this) } }
      },
      head: { appendChild(style) { styles.add(style) } }
    }
  })
  const client = definition.factory((name) => {
    if (name === 'react') return React
    assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives')
    return {}
  })
  const ctx = {
    layout: { selectPanel(id) { selected.push(id) } },
    effect(effect) { cleanups.push(effect()) },
    slots: {
      inject(_name, install) { cleanups.push(install()) },
      register(options, component) {
        assert.equal(registrations.has(options.name), false)
        registrations.set(options.name, { options, component })
        return () => registrations.delete(options.name)
      }
    }
  }
  assert.deepEqual(Array.from(client.inject), ['slots', 'layout'])
  client.apply(ctx)
  try {
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
    assert.equal(registrations.size, 2)
  } finally {
    cleanups.reverse().forEach((dispose) => dispose())
    assert.equal(styles.size, 0)
    assert.equal(registrations.size, 0)
  }
})
