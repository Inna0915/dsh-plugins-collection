import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import vm from 'node:vm'
import { __internals } from '../index.js'

const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const marker = '    function RefreshIcon() {'
assert.equal(client.split(marker).length, 2)
const source = client.replace(marker, '    globalThis.batchTest = { batchDates, batchRange, batchDayInfo, batchEligibility, needsLunchReminder };\n' + marker)
let factory
const sandbox = { window: { __ModuleLoader__: { load: module => { factory = module.factory } } } }
vm.runInNewContext(source, sandbox)
factory(() => ({ createElement() {} }))
const { batchDates, batchRange, batchDayInfo, batchEligibility, needsLunchReminder } = sandbox.batchTest
const dayForAlert = { date: '2026-10-28', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', presence: 'IN_OFFICE', choice: 'UNSELECTED', locked: false, deadline: '2026-10-28T00:45:00Z' }] }
const panelForAlert = { today: '2026-10-28', presence: 'IN_OFFICE' }
const at = time => Date.parse(`2026-10-28T${time}+08:00`)
assert.equal(needsLunchReminder(panelForAlert, dayForAlert, at('08:29:59')), false)
assert.equal(needsLunchReminder(panelForAlert, dayForAlert, at('08:30:00')), true)
assert.equal(needsLunchReminder(panelForAlert, dayForAlert, at('08:45:00')), false)
for (const choice of ['ORDERED', 'DECLINED']) {
  const day = { ...dayForAlert, meals: [{ ...dayForAlert.meals[0], choice }] }
  assert.equal(needsLunchReminder(panelForAlert, day, at('08:35:00')), false)
}
assert.equal(needsLunchReminder({ ...panelForAlert, presence: 'OUT_OF_OFFICE' }, dayForAlert, at('08:35:00')), false)
assert.equal(batchDates('2026-10-30', '2026-11-02').length, 4)
const plain = value => JSON.parse(JSON.stringify(value))
assert.deepEqual(plain(batchDates('2026-12-31', '2027-01-04')), ['2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04'])
assert.equal(batchDates('2026-01-01', '2026-07-05').length, 186)
assert.throws(() => batchDates('2026-01-01', '2026-07-06'), /186/)
assert.deepEqual(plain(batchRange('month', '2026-11-19', '2027-02-01')), { start: '2026-11-19', end: '2026-11-30' })
assert.deepEqual(plain(batchRange('next', '2026-11-19', '2026-11-19')), { start: '2026-12-01', end: '2026-12-31' })
assert.deepEqual(plain(batchRange('next', '2026-11-19', '2026-12-01')), { start: '2027-01-01', end: '2027-01-31' })
assert.deepEqual(plain(batchRange('next', '2026-11-19', '2027-01-01')), { start: '2027-02-01', end: '2027-02-28' })
assert.deepEqual(plain(batchRange('next', '2026-11-19', '2028-01-01')), { start: '2028-02-01', end: '2028-02-29' })
assert.deepEqual(plain(batchRange('next', '2026-11-19', '2026-09-01')), { start: '2026-12-01', end: '2026-12-31' })
assert.deepEqual(plain(batchRange('week', '2026-11-19', '2027-02-01')), { start: '2026-11-19', end: '2026-11-25' })
assert.deepEqual(plain(batchRange('halfYear', '2026-11-19', '2027-02-01')), { start: '2026-11-19', end: '2027-05-18' })
assert.deepEqual(plain(batchRange('halfYear', '2026-07-01', '2026-07-01')), { start: '2026-07-01', end: '2026-12-31' })
assert.deepEqual(plain(batchRange('halfYear', '2026-08-31', '2026-08-31')), { start: '2026-08-31', end: '2027-02-27' })
assert.equal(batchDates(...Object.values(plain(batchRange('halfYear', '2026-11-19', '2026-11-19')))).length, 181)
assert.deepEqual(plain(batchDayInfo('2026-10-10')), { workday: true, label: '调休补班', weekday: '周六', fallback: false })
assert.deepEqual(plain(batchDayInfo('2026-10-01')), { workday: false, label: '国庆节', weekday: '周四', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-01-01')), { workday: false, label: '元旦', weekday: '周五', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-01-03')), { workday: false, label: '元旦', weekday: '周日', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-01-04')), { workday: true, label: '工作日', weekday: '周一', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-01-31')), { workday: true, label: '调休补班', weekday: '周日', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-02-05')), { workday: false, label: '春节', weekday: '周五', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-02-13')), { workday: false, label: '春节', weekday: '周六', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-02-14')), { workday: true, label: '调休补班', weekday: '周日', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-04-05')), { workday: false, label: '清明节', weekday: '周一', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-05-05')), { workday: false, label: '劳动节', weekday: '周三', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-05-08')), { workday: true, label: '调休补班', weekday: '周六', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-06-09')), { workday: false, label: '端午节', weekday: '周三', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-06-10')), { workday: true, label: '工作日', weekday: '周四', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-09-15')), { workday: false, label: '中秋节', weekday: '周三', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-09-26')), { workday: true, label: '调休补班', weekday: '周日', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-10-01')), { workday: false, label: '国庆节', weekday: '周五', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-10-07')), { workday: false, label: '国庆节', weekday: '周四', fallback: false })
assert.deepEqual(plain(batchDayInfo('2027-10-09')), { workday: true, label: '调休补班', weekday: '周六', fallback: false })
assert.deepEqual(plain(batchDayInfo('2028-01-01')), { workday: false, label: '周末', weekday: '周六', fallback: true })
assert.deepEqual(plain(batchDayInfo('2028-01-02')), { workday: false, label: '周末', weekday: '周日', fallback: true })
assert.deepEqual(plain(batchDayInfo('2028-01-03')), { workday: true, label: '默认工作日', weekday: '周一', fallback: true })
assert.deepEqual(plain(batchDayInfo('2028-01-04')), { workday: true, label: '默认工作日', weekday: '周二', fallback: true })
const calendar = { today: '2026-10-26', serverTime: '2026-10-26T09:00:00+08:00', presence: 'IN_OFFICE', days: [{ date: '2026-10-28', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', presence: 'IN_OFFICE', choice: 'DECLINED', locked: false, deadline: '2026-10-28T00:45:00Z' }] }] }
assert.equal(batchEligibility('2026-10-28', 'LUNCH', calendar, false).eligible, false)
assert.equal(batchEligibility('2026-10-28', 'LUNCH', calendar, true).eligible, true)
calendar.days[0].meals[0].locked = true
assert.equal(batchEligibility('2026-10-28', 'LUNCH', calendar, true).eligible, false)
const calendar2027 = {
  today: '2027-01-01',
  serverTime: '2027-01-01T08:00:00+08:00',
  presence: 'IN_OFFICE',
  days: [
    { date: '2027-01-01', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', presence: 'IN_OFFICE', choice: 'UNSELECTED', locked: false, deadline: '2027-01-01T00:45:00Z' }] },
    { date: '2027-01-31', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', presence: 'IN_OFFICE', choice: 'UNSELECTED', locked: false, deadline: '2027-01-31T00:45:00Z' }] },
    { date: '2027-06-09', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', presence: 'IN_OFFICE', choice: 'UNSELECTED', locked: false, deadline: '2027-06-09T00:45:00Z' }] },
  ],
}
assert.deepEqual(plain(batchEligibility('2027-01-01', 'LUNCH', calendar2027, false)), { eligible: false, reason: '元旦' })
assert.deepEqual(plain(batchEligibility('2027-01-31', 'LUNCH', calendar2027, false)), { eligible: true, reason: '可订餐' })
assert.deepEqual(plain(batchEligibility('2027-06-09', 'LUNCH', calendar2027, false)), { eligible: false, reason: '端午节' })
const calendar2028 = {
  today: '2028-01-01',
  serverTime: '2028-01-01T08:00:00+08:00',
  presence: 'IN_OFFICE',
  days: [
    { date: '2028-01-02', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', presence: 'IN_OFFICE', choice: 'UNSELECTED', locked: false, deadline: '2028-01-02T00:45:00Z' }] },
    { date: '2028-01-03', presence: 'IN_OFFICE', meals: [] },
    { date: '2028-01-04', presence: 'IN_OFFICE', meals: [{ meal: 'LUNCH', presence: 'IN_OFFICE', choice: 'UNSELECTED', locked: false, deadline: '2028-01-04T00:45:00Z' }] },
  ],
}
assert.deepEqual(plain(batchEligibility('2028-01-02', 'LUNCH', calendar2028, false)), { eligible: false, reason: '周末' })
assert.deepEqual(plain(batchEligibility('2028-01-03', 'LUNCH', calendar2028, false)), { eligible: false, reason: '网站未提供该餐次' })
assert.deepEqual(plain(batchEligibility('2028-01-04', 'LUNCH', calendar2028, false)), { eligible: true, reason: '可订餐' })

function request(path, body, headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = '/meal/api/' + path; req.headers = headers
  let result
  const res = { writeHead(status) { this.status = status }, end(text) { result = { status: this.status, body: JSON.parse(text) } } }
  return { req, res, result: () => result }
}
const state = { cfg: { username: '王鹏宏', baseUrl: 'http://test.invalid' }, cookies: new Map([['SESSION', 'stub']]), profile: { username: '王鹏宏' } }
const body = { date: '2026-10-28', meal: 'LUNCH', choice: 'ORDERED', expectedUsername: '王鹏宏' }

// Cross-site writes are rejected before any canteen call.
{
  const guardFetch = globalThis.fetch
  let reached = 0
  globalThis.fetch = async () => { reached++; throw new Error('must not reach canteen') }
  try {
    const crossSite = request('selection', body, { host: '127.0.0.1:3080', origin: 'https://evil.example', 'content-type': 'application/json' })
    await assert.rejects(__internals.handle(state, crossSite.req, crossSite.res), error => error.status === 403)
    const simplePost = request('selection', body, { host: '127.0.0.1:3080', 'content-type': 'text/plain' })
    await assert.rejects(__internals.handle(state, simplePost.req, simplePost.res), error => error.status === 415)
    const nullOrigin = request('presence', { presence: 'IN_OFFICE' }, { host: '127.0.0.1:3080', origin: 'null', 'content-type': 'application/json' })
    await assert.rejects(__internals.handle(state, nullOrigin.req, nullOrigin.res), error => error.status === 403)
    assert.equal(reached, 0)
    // Non-browser callers (no Origin) with JSON stay allowed.
    __internals.assertSameSiteWrite({ headers: { host: '127.0.0.1:3080', 'content-type': 'application/json; charset=utf-8' } })
  } finally { globalThis.fetch = guardFetch }
}

let called = 0, release
let startedResolve
const started = new Promise(resolve => { startedResolve = resolve })
const oldFetch = globalThis.fetch
try {
  globalThis.fetch = async () => { called++; startedResolve(); await new Promise(resolve => { release = resolve }); return { ok: true, status: 200, headers: { getSetCookie: () => [], get: () => null }, json: async () => ({ code: 200, data: { date: body.date } }) } }
  const pending = request('selection', body)
  const task = __internals.handle(state, pending.req, pending.res)
  await started
  const switchAccount = request('login', { username: 'other' })
  await assert.rejects(__internals.handle(state, switchAccount.req, switchAccount.res), error => error.code === 'account-busy')
  release(); await task
  assert.equal(pending.result().status, 200)
  const mismatch = request('selection', { ...body, expectedUsername: 'other' })
  await assert.rejects(__internals.handle(state, mismatch.req, mismatch.res), error => error.code === 'account-changed')
  assert.equal(called, 1)
  globalThis.fetch = async () => { called++; return { ok: false, status: 401, headers: { getSetCookie: () => [], get: () => null }, json: async () => ({ code: 401 }) } }
  const denied = request('selection', body)
  await assert.rejects(__internals.handle(state, denied.req, denied.res), error => error.status === 401)
  assert.equal(called, 2, '401 must not replay POST')
  let releaseOld, signalOld
  const oldStarted = new Promise(resolve => { signalOld = resolve })
  const oldState = { cfg: { username: 'A', baseUrl: 'http://test.invalid' }, cookies: new Map([['SESSION', 'old']]), profile: { username: 'A' }, authEpoch: 1 }
  globalThis.fetch = async () => {
    signalOld()
    await new Promise(resolve => { releaseOld = resolve })
    return { ok: true, status: 200, headers: { getSetCookie: () => ['SESSION=old'], get: () => null }, json: async () => ({ code: 200, data: { days: [] } }) }
  }
  const oldRequest = Readable.from([]); oldRequest.method = 'GET'; oldRequest.url = '/meal/api/panel?month=2026-10'
  const stale = __internals.handle(oldState, oldRequest, { writeHead() {}, end() {} })
  await oldStarted
  oldState.authEpoch++
  oldState.cfg.username = 'B'
  oldState.cookies.set('SESSION', 'new')
  oldState.profile = { username: 'B' }
  releaseOld()
  await assert.rejects(stale, error => error.code === 'account-changed')
  assert.equal(oldState.cookies.get('SESSION'), 'new', 'old response must not overwrite new session')
} finally { globalThis.fetch = oldFetch }
console.log('PASS: workday filtering, date limits, meal eligibility, cross-site write guard, account exclusion and no POST replay')
