import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonlPage, codexMessage, message, pageEvents, encodeCursor } from './conversation.js'

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'preview-'))
  try { await run(join(dir, 'log.jsonl'), dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const parse = (row) => message('user', row.text)
const line = (text, extra = {}) => JSON.stringify({ text, ...extra })

test('reverse pagination preserves UTF-8, chronology and unique IDs while appending', async () => fixture(async (path) => {
  await writeFile(path, Array.from({ length: 75 }, (_, i) => line(`提问😀 ${i}`)).join('\n') + '\n')
  const segments = [{ filePath: path }]
  const latest = await readJsonlPage('one', segments, parse)
  assert.equal(latest.messages.length, 30)
  assert.equal(latest.messages[0].text, '提问😀 45')
  await appendFile(path, line('new') + '\n')
  const middle = await readJsonlPage('one', segments, parse, latest.nextCursor)
  const oldest = await readJsonlPage('one', segments, parse, middle.nextCursor)
  const all = [...oldest.messages, ...middle.messages, ...latest.messages]
  assert.equal(oldest.nextCursor, null)
  assert.equal(new Set(all.map((item) => item.id)).size, 75)
  assert.deepEqual(all.map((item) => item.text), Array.from({ length: 75 }, (_, i) => `提问😀 ${i}`))
}))

test('long lines across read boundaries, incomplete tail and oversized lines remain bounded', async () => fixture(async (path) => {
  await writeFile(path, [line('first'), line('中文😀'.repeat(17000)), line('x'.repeat(1500000)), line('last'), '{"text":'].join('\n'))
  const page = await readJsonlPage('one', [{ filePath: path }], parse)
  assert.equal(page.messages[0].text, 'first')
  assert.equal(page.messages.at(-1).text, 'last')
  assert.equal(page.messages.length, 3)
  assert.equal(page.messages[1].truncated, true)
  assert.ok(page.warnings.length >= 2)
}))

test('fork pagination follows older segments and respects ordinal cutoff', async () => fixture(async (path, dir) => {
  const prior = join(dir, 'prior.jsonl')
  await writeFile(path, line('child', { ordinal: 12 }))
  await writeFile(prior, [line('inherited', { ordinal: 4 }), line('parent later', { ordinal: 12 })].join('\n'))
  const segments = [{ filePath: path }, { filePath: prior, maxOrdinalExclusive: 8 }]
  const first = await readJsonlPage('child', segments, parse, null, { limit: 1 })
  const second = await readJsonlPage('child', segments, parse, first.nextCursor, { limit: 1 })
  assert.deepEqual([...second.messages, ...first.messages].map((item) => item.text), ['inherited', 'child'])
  assert.equal(second.nextCursor, null)
}))

test('a record larger than the scan budget cannot trap pagination on one cursor', async () => fixture(async (path) => {
  await writeFile(path, [line('first'), line('x'.repeat(10 * 1024 * 1024)), line('last')].join('\n'))
  const segments = [{ filePath: path }]
  const first = await readJsonlPage('one', segments, parse)
  const next = await readJsonlPage('one', segments, parse, first.nextCursor)
  assert.deepEqual([...next.messages, ...first.messages].map((item) => item.text), ['first', 'last'])
  assert.equal(next.nextCursor, null)
}))

test('invalid, cross-session, replaced and truncated-file cursors are rejected', async () => fixture(async (path) => {
  await writeFile(path, [line('old'), line('new')].join('\n'))
  const segments = [{ filePath: path }]
  const first = await readJsonlPage('one', segments, parse, null, { limit: 1 })
  await assert.rejects(readJsonlPage('two', segments, parse, first.nextCursor), /分页/)
  await assert.rejects(readJsonlPage('one', segments, parse, '../anything'), /分页/)
  await assert.rejects(readJsonlPage('one', [{ filePath: path, maxOrdinalExclusive: 1 }], parse, first.nextCursor), /历史已变化/)
  await writeFile(path, '')
  await assert.rejects(readJsonlPage('one', segments, parse, first.nextCursor), /文件已变化/)
}))

test('Codex uses canonical response records without duplicating event messages or rendering injected policies', () => {
  assert.equal(codexMessage({ type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate' } }), null)
  assert.equal(codexMessage({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'policy' }] } }), null)
  assert.equal(codexMessage({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\npolicy' }] } }), null)
  assert.equal(codexMessage({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '**done**' }] } }).text, '**done**')
  assert.equal(codexMessage({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: 'pwd' } }).kind, 'tool')
  assert.equal(codexMessage({ type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'thinking' }] } }).kind, 'thought')
})

test('DSH event cursor returns non-overlapping bounded slices', () => {
  const events = Array.from({ length: 65 }, (_, seq) => ({ seq, text: String(seq) }))
  const first = pageEvents('dsh:one', events, parse)
  const second = pageEvents('dsh:one', events, parse, first.nextCursor)
  assert.equal(first.messages[0].text, '35')
  assert.equal(second.messages.at(-1).text, '34')
  assert.throws(() => pageEvents('dsh:one', events, parse, encodeCursor('dsh:one', { key: 'events', segment: 0, before: -1 })), /分页/)
})

test('preview endpoint refuses arbitrary paths, unknown fields and excessive cursors', async () => {
  const { apply } = await import('./index.js')
  const routes = new Map(); const cleanup = []
  const { Readable } = await import('node:stream')
  const name = (await import('./package.json', { with: { type: 'json' } })).default.name
  const ctx = { logger: { info() {} }, webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } }, effect(setup) { cleanup.push(setup()) } }
  apply(ctx)
  try {
    for (const body of [{ sessionId: '../../secret' }, { sessionId: 'anything', path: 'C:/private' }, { sessionId: 'anything', cursor: 'x'.repeat(1025) }]) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'
      let status; let result
      await routes.get(`/${name}/conversation`)(req, { writeHead(value) { status = value }, end(value) { result = JSON.parse(value) } })
      assert.equal(status, 400)
      assert.match(result.error, /无效/)
    }
  } finally { cleanup.filter((item) => typeof item === 'function').reverse().forEach((close) => close()) }
})
