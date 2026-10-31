import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
let definition
runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), { URL, window: { __ModuleLoader__: { load(value) { definition = value } } } })
const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }) }
const client = definition.factory((name) => name === 'react' ? React : {})
function flatten(node) { return !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(flatten)] }

test('markdown links reject executable and local-file URLs', () => {
  for (const value of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,test', '//example.com']) assert.equal(client.safeLink(value), null)
  assert.equal(client.safeLink('https://example.com/path'), 'https://example.com/path')
})
test('markdown safely renders text, code fences, lists and headings without raw HTML', () => {
  const tree = client.MarkdownText({ text: '# Heading\n\n**bold** and `code`\n\n- one\n- two\n\n```js\n<script>alert(1)</script>\n```\n\n[site](https://example.com)' })
  const nodes = flatten(tree)
  for (const type of ['h1', 'strong', 'code', 'ul', 'li', 'pre', 'a']) assert.ok(nodes.some((item) => item.type === type), type)
  assert.ok(nodes.every((item) => !item.props.dangerouslySetInnerHTML))
  assert.ok(nodes.find((item) => item.type === 'a').props.rel.includes('noopener'))
})
test('all card states can preview while running cards remain unreviewable', () => {
  for (const status of ['running', 'turn_completed', 'unknown']) {
    const session = { sessionId: 'one', title: 'title', status }
    let opened
    const nodes = flatten(client.SessionCard({ session, onPreview(value) { opened = value } }))
    const button = nodes.find((node) => node.type === 'button' && node.children.includes('查看会话'))
    assert.ok(button)
    button.props.onClick()
    assert.equal(opened, session)
    assert.equal(nodes.some((node) => node.type === 'button' && node.children.includes('审核完成')), status === 'turn_completed')
  }
})
