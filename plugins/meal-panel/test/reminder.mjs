import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLunchReminder } from '../reminder.js'
import { apply } from '../index.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'meal-reminder-test-'))
let serial = 0
const at = text => Date.parse(`${text}+08:00`)
function fixture() {
  const directory = path.join(root, String(serial++))
  const state = {
    directory,
    time: at('2026-10-27T08:29:00'), user: 'A', settings: { botId: 'bot', targetId: 'target' },
    sends: [], calls: 0, cleared: 0, failRead: false, failConfig: false, result: { sent: true },
    alter: () => {}, gate: null,
  }
  state.im = { async send(...args) { state.sends.push(args); if (state.sendError) throw new Error('secret'); return state.result } }
  state.make = (extra = {}) => createLunchReminder({
    home: root, directory, now: () => state.time,
    setInterval: fn => { state.timer = fn; return 1 }, clearInterval: () => { state.cleared++ },
    getUsername: () => state.user, getIm: () => state.im,
    readConfig: async () => { if (state.failConfig) throw new Error('secret'); return state.settings },
    panelPayload: async month => {
      state.calls++
      if (state.failRead) throw new Error('secret')
      if (state.gate) await state.gate
      const date = new Date(state.time + 8 * 3600_000).toISOString().slice(0, 10)
      const panel = { configured: true, username: state.user, today: date, month,
        serverTime: new Date(state.time).toISOString(), presence: 'IN_OFFICE',
        days: [{ date, presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', presence: 'IN_OFFICE', choice: 'UNSELECTED', locked: false, deadline: `${date}T09:30:00+08:00` }] }] }
      state.alter(panel)
      return panel
    }, ...extra,
  })
  return state
}
try {
  {
    const f = fixture(), r = f.make()
    assert.equal(await r.tick(), 'outside-window')
    f.time = at('2026-10-27T08:30:00')
    assert.equal(await r.tick(), 'sent')
    assert.equal(f.sends.length, 1)
    assert.deepEqual(f.sends[0].slice(0, 2), ['bot', 'target'])
    assert.equal(await r.tick(), 'already-attempted')
    const files = await readdir(f.directory)
    assert.match(files[0], /^[a-f0-9]{64}\.attempt$/)
    assert.equal(await readFile(path.join(f.directory, files[0]), 'utf8'), '')
    r.dispose(); r.dispose(); assert.equal(f.cleared, 1); assert.equal(await r.tick(), 'disposed')
  }
  {
    const f = fixture(); f.time = at('2026-10-27T08:30:00.001')
    const r = f.make(); assert.equal(await r.tick(), 'outside-window')
    f.time = at('2026-10-28T08:30:00'); assert.equal(await r.tick(), 'sent'); r.dispose()
  }
  for (const change of [
    p => { p.presence = 'OUT_OF_OFFICE' }, p => { p.days[0].presence = 'OUT_OF_OFFICE' },
    p => { p.days[0].meals[0].presence = 'OUT_OF_OFFICE' }, p => { p.days[0].meals[0].choice = 'ORDERED' },
    p => { p.days[0].meals[0].choice = 'DECLINED' }, p => { p.days[0].meals[0].locked = true },
    p => { delete p.days[0].meals[0].locked }, p => { p.days[0].meals[0].deadline = 'invalid' },
    p => { p.days[0].meals[0].deadline = p.serverTime }, p => { p.today = '2026-10-26' },
    p => { p.username = 'B' }, p => { p.serverTime = 'invalid' },
  ]) {
    const f = fixture(), r = f.make(); f.alter = change; f.time = at('2026-10-27T08:30:00')
    assert.equal(await r.tick(), 'ineligible'); assert.equal(f.sends.length, 0); r.dispose()
  }
  {
    const f = fixture(), r = f.make(); f.time = at('2026-10-27T08:30:00')
    f.im = null; assert.equal(await r.tick(), 'unavailable')
    f.im = { async send(...args) { f.sends.push(args); return { sent: true } } }
    f.failConfig = true; assert.equal(await r.tick(), 'unavailable'); f.failConfig = false
    f.failRead = true; assert.equal(await r.tick(), 'unavailable'); f.failRead = false
    assert.equal(await r.tick(), 'sent'); r.dispose()
  }
  {
    const f = fixture(), r = f.make(); f.time = at('2026-10-27T08:30:00')
    f.alter = p => { if (f.calls === 2) p.days[0].meals[0].choice = 'ORDERED' }
    assert.equal(await r.tick(), 'ineligible'); assert.equal(f.sends.length, 0); r.dispose()
  }
  {
    const f = fixture(); let configReads = 0
    const r = f.make({ readConfig: async () => { configReads++; if (configReads === 2) f.settings = { botId: 'bot', targetId: 'new-target' }; return f.settings } })
    f.time = at('2026-10-27T08:30:00')
    assert.equal(await r.tick(), 'unavailable'); assert.equal(f.sends.length, 0)
    assert.equal(await r.tick(), 'sent'); assert.equal(f.sends[0][1], 'new-target'); r.dispose()
  }
  {
    const f = fixture(), r = f.make(); f.time = at('2026-10-27T08:30:00')
    f.alter = p => { p.serverTime = '2026-10-27T08:29:59+08:00' }
    assert.equal(await r.tick(), 'ineligible'); assert.equal(f.sends.length, 0); r.dispose()
  }
  for (const error of [true, false]) {
    const f = fixture(), r = f.make(); f.time = at('2026-10-27T08:30:00')
    f.sendError = error; f.result = { sent: false }
    assert.equal(await r.tick(), 'send-uncertain'); assert.equal(await r.tick(), 'already-attempted')
    assert.equal(f.sends.length, 1); r.dispose()
  }
  {
    const f = fixture(), r = f.make(); f.time = at('2026-10-27T08:30:00')
    let release; f.gate = new Promise(resolve => { release = resolve })
    const a = r.tick(), b = r.tick(); assert.equal(a, b)
    await Promise.resolve(); await Promise.resolve(); f.user = 'B'; release()
    assert.equal(await a, 'ineligible'); assert.equal(f.sends.length, 0); r.dispose()
  }
  {
    const f = fixture(), r1 = f.make(), r2 = f.make(); f.time = at('2026-10-27T08:30:00')
    const results = await Promise.all([r1.tick(), r2.tick()])
    assert.deepEqual(results.sort(), ['already-attempted', 'sent']); assert.equal(f.sends.length, 1)
    r1.dispose(); r2.dispose()
    f.time = at('2026-10-27T08:29:00'); const restarted = f.make()
    f.time = at('2026-10-27T08:31:00'); assert.equal(await restarted.tick(), 'already-attempted')
    f.user = 'B'; assert.equal(await restarted.tick(), 'sent')
    f.settings = { botId: 'bot', targetId: 'another' }; assert.equal(await restarted.tick(), 'already-attempted')
    f.time = at('2026-10-28T08:30:00'); assert.equal(await restarted.tick(), 'sent')
    assert.equal(f.sends.length, 3); restarted.dispose()
  }
  {
    const f = fixture(), r = f.make(); f.time = at('2026-10-27T08:30:00')
    let release; f.gate = new Promise(resolve => { release = resolve }); const pending = r.tick()
    await Promise.resolve(); await Promise.resolve(); r.dispose(); release()
    assert.equal(await pending, 'ineligible'); assert.equal(f.sends.length, 0)
  }
  {
    const f = fixture(), r = f.make(); f.time = at('2026-10-27T08:30:00')
    let started
    const sending = new Promise(resolve => { started = resolve })
    f.im = { send: async () => { started(); return new Promise(() => {}) } }
    const pending = r.tick()
    await sending
    r.dispose()
    assert.equal(await pending, 'send-uncertain')
  }
  {
    const home = path.join(root, 'settings-home'); await mkdir(path.join(home, 'codex-monitor'), { recursive: true })
    await writeFile(path.join(home, 'codex-monitor', 'notification-settings.json'), JSON.stringify({ botId: 'stored-bot', targetId: 'stored-target', imEnabled: false }))
    const f = fixture(), r = f.make({ home, readConfig: undefined }); f.time = at('2026-10-27T08:30:00')
    assert.equal(await r.tick(), 'sent'); assert.deepEqual(f.sends[0].slice(0, 2), ['stored-bot', 'stored-target']); r.dispose()
  }
  {
    const f = fixture(), r = f.make(); f.time = at('2026-10-27T08:30:00')
    f.alter = p => { p.serverTime = '2026-10-27T09:30:01+08:00'; f.time += 2000 }
    assert.equal(await r.tick(), 'ineligible'); assert.equal(f.sends.length, 0); r.dispose()
  }
  {
    // Each child has its own scheduler and mock IM; only the attempt directory is shared.
    const directory = path.join(root, 'processes')
    const moduleFile = fileURLToPath(new URL('../reminder.js', import.meta.url))
    const source = `
      import { pathToFileURL } from 'node:url';
      const { createLunchReminder } = await import(pathToFileURL(process.argv[1]).href);
      let now = Date.parse('2026-10-27T08:29:00+08:00');
      const r = createLunchReminder({ directory: process.argv[2], now: () => now,
        setInterval: () => 1, clearInterval: () => {}, getUsername: () => 'A',
        getIm: () => im, readConfig: async () => ({ botId: 'bot', targetId: 'target' }),
        panelPayload: async () => ({ configured: true, username: 'A', today: '2026-10-27',
          serverTime: '2026-10-27T08:30:00+08:00', presence: 'IN_OFFICE',
          days: [{ date: '2026-10-27', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH',
            choice: 'UNSELECTED', locked: false, deadline: '2026-10-27T09:30:00+08:00' }] }] }) });
      const im = { send: async () => ({ sent: true }) }; now = Date.parse('2026-10-27T08:30:00+08:00');
      const result = await r.tick(); r.dispose(); process.exitCode = result === 'sent' ? 0 : result === 'already-attempted' ? 2 : 3;
    `
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, moduleFile, directory], { stdio: 'ignore' })
      child.on('error', reject); child.on('exit', code => resolve(code))
    })
    assert.deepEqual((await Promise.all([run(), run()])).sort(), [0, 2])
  }
  {
    const integrationHome = path.join(root, 'host-integration')
    await mkdir(path.join(integrationHome, 'codex-monitor'), { recursive: true })
    await writeFile(path.join(integrationHome, 'codex-monitor', 'notification-settings.json'), JSON.stringify({ botId: 'bot', targetId: 'target' }))
    const originalHome = process.env.DSH_HOME, originalNow = Date.now, originalFetch = globalThis.fetch
    const originalInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval
    let time = at('2026-10-27T08:29:00'), timer, notify
    const sent = new Promise(resolve => { notify = resolve })
    const cleanups = []
    try {
      process.env.DSH_HOME = integrationHome
      Date.now = () => time
      globalThis.setInterval = fn => { timer = fn; return { unref() {} } }
      globalThis.clearInterval = () => {}
      globalThis.fetch = async url => {
        const login = String(url).includes('/auth/user/login')
        const data = login ? { username: 'A', role: 'USER' } : {
          month: '2026-10', today: '2026-10-27', serverTime: '2026-10-27T08:30:00+08:00', presence: 'IN_OFFICE',
          days: [{ date: '2026-10-27', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', choice: 'UNSELECTED', locked: false, deadline: '2026-10-27T08:45:00+08:00' }] }],
        }
        return { ok: true, status: 200, headers: { getSetCookie: () => login ? ['SESSION=mock'] : [], get: () => null }, json: async () => ({ code: 200, data }) }
      }
      const im = { send: async (...args) => { notify(args); return { sent: true } } }
      const ctx = {
        webServer: { register: () => () => {} },
        effect: setup => cleanups.push(setup()),
        inject: (_services, setup) => setup({ dshIm: im, effect: fn => cleanups.push(fn()) }),
      }
      apply(ctx, { username: 'A', baseUrl: 'http://example.invalid' })
      assert.equal(typeof timer, 'function')
      time = at('2026-10-27T08:30:00'); timer()
      const args = await Promise.race([sent, new Promise((_, reject) => setTimeout(() => reject(new Error('宿主提醒未触发')), 3000))])
      assert.deepEqual(args.slice(0, 2), ['bot', 'target'])
      assert.match(args[2], /午餐/)
    } finally {
      cleanups.reverse().forEach(cleanup => cleanup?.())
      if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome
      Date.now = originalNow; globalThis.fetch = originalFetch
      globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval
    }
  }
  console.log('PASS: simulated timing, accounts, atomic claims, eligibility, offline recovery, restart, host wiring and disposal')
} finally {
  await rm(root, { recursive: true, force: true })
}
