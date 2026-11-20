import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, resolvePaths } from '../index.js'

async function boot() {
  const home = await mkdtemp(join(tmpdir(), 'vibe-reader-http-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const routes = new Map()
  const disposers = []
  apply({
    effect: (action) => { disposers.push(action()) },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } }
  }, {})
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  const call = async (path, method = 'GET', body) => {
    const route = routes.get(path)
    assert.ok(route.methods.includes(method), `${path} accepts ${method}`)
    const response = await route.fetch(new Request('http://dsh' + path, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  }
  return {
    home,
    routes,
    call,
    async close() {
      for (const dispose of disposers) dispose?.()
      await rm(home, { recursive: true, force: true })
    }
  }
}

test('paths: default under DSH_HOME, absolute libraryRoot honoured, relative ignored', () => {
  const env = { DSH_HOME: join(tmpdir(), 'h') }
  assert.equal(resolvePaths({}, env).stateFile, join(env.DSH_HOME, 'vibe-reader', 'state.json'))
  assert.equal(resolvePaths({}, env).libraryDir, join(env.DSH_HOME, 'vibe-reader', 'library'))
  assert.equal(resolvePaths({ libraryRoot: 'relative/dir' }, env).libraryDir, join(env.DSH_HOME, 'vibe-reader', 'library'))
  const absolute = join(tmpdir(), 'my-library')
  assert.equal(resolvePaths({ libraryRoot: absolute }, env).libraryDir, absolute)
})

test('http: library, volume, state round trip', async () => {
  const app = await boot()
  try {
    assert.deepEqual([...app.routes.keys()].sort(), ['/api/vibe-reader/library', '/api/vibe-reader/mark-verified', '/api/vibe-reader/state', '/api/vibe-reader/volume'])
    const library = await app.call('/api/vibe-reader/library')
    assert.equal(library.status, 200)
    assert.deepEqual(library.body.volumes.map((row) => row.id).sort(), ['qian-chibi-fu', 'tangshi-liushou', 'yueyanglou-ji'])
    assert.equal(library.body.volumes[0].sections, undefined, 'list rows carry no bodies')
    assert.ok(library.body.cards.length >= 20)
    assert.equal(library.body.state.ui.view, 'encounter')
    assert.equal(library.body.roots[1].exists, false, 'the personal library is optional')

    const volume = await app.call('/api/vibe-reader/volume', 'POST', { id: 'qian-chibi-fu' })
    assert.equal(volume.status, 200)
    assert.equal(volume.body.volume.sections.length, 5)
    assert.equal((await app.call('/api/vibe-reader/volume', 'POST', { id: 'nope' })).status, 404)

    const progress = await app.call('/api/vibe-reader/state', 'POST', { op: 'progress', volumeId: 'qian-chibi-fu', sectionId: 's3' })
    assert.equal(progress.status, 200)
    assert.equal(progress.body.state.volumes['qian-chibi-fu'].lastSection, 's3')
    const saved = JSON.parse(await readFile(join(app.home, 'vibe-reader', 'state.json'), 'utf8'))
    assert.equal(saved.ui.volume, 'qian-chibi-fu')

    const rated = await app.call('/api/vibe-reader/state', 'POST', { op: 'rate', key: 'tangshi-liushou#s1', rating: 'remembered' })
    assert.equal(rated.body.state.cards['tangshi-liushou#s1'].level, 1)

    assert.equal((await app.call('/api/vibe-reader/state', 'POST', { op: 'progress', volumeId: 'qian-chibi-fu', sectionId: 's9' })).status, 400)
    assert.equal((await app.call('/api/vibe-reader/state', 'POST', '{')).status, 400)
    assert.equal((await app.call('/api/vibe-reader/state', 'POST', '[]')).status, 400)
    assert.equal((await app.call('/api/vibe-reader/state', 'POST', 'x'.repeat(9000))).status, 413)

    const gloss = await app.call('/api/vibe-reader/state', 'POST', { op: 'gloss', volumeId: 'yueyanglou-ji', sectionId: 's1', mode: 'below' })
    assert.equal(gloss.body.state.volumes['yueyanglou-ji'].glossMode, 'below')
    assert.equal((await app.call('/api/vibe-reader/state', 'POST', { op: 'gloss', volumeId: 'yueyanglou-ji', sectionId: 's1', mode: 'huge' })).status, 400)

    // mark-verified: library volumes only, frontmatter only
    assert.equal((await app.call('/api/vibe-reader/mark-verified', 'POST', { id: 'yueyanglou-ji' })).status, 400, 'built-in seeds are read-only')
    const { mkdir, writeFile, readFile: read } = await import('node:fs/promises')
    const { readFileSync } = await import('node:fs')
    const seed = readFileSync(new URL('../seeds/tangshi-liushou.md', import.meta.url), 'utf8')
    const mine = seed.replace('id: tangshi-liushou', 'id: mine').replace('verified: corpus', 'verified: false')
    await mkdir(join(app.home, 'vibe-reader', 'library'), { recursive: true })
    await writeFile(join(app.home, 'vibe-reader', 'library', 'mine.md'), mine, 'utf8')
    const marked = await app.call('/api/vibe-reader/mark-verified', 'POST', { id: 'mine' })
    assert.deepEqual(marked.body, { ok: true, verified: true })
    const after = await read(join(app.home, 'vibe-reader', 'library', 'mine.md'), 'utf8')
    assert.equal(after, mine.replace('verified: false', 'verified: true'), 'only the verified line changes')
    const relisted = await app.call('/api/vibe-reader/library')
    assert.equal(relisted.body.volumes.find((row) => row.id === 'mine').recitable, true)
    assert.equal((await app.call('/api/vibe-reader/mark-verified', 'POST', { id: 'nope' })).status, 404)
  } finally {
    await app.close()
  }
  assert.equal(app.routes.size, 0, 'routes are unregistered on dispose')
})
