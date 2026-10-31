/**
 * Live check against the canteen API through the plugin's own HTTP handler.
 * Run: node test/live.mjs
 * It reads the username from cordis.patch.yml so it never duplicates credentials.
 */
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const patch = readFileSync(path.join(here, '..', 'cordis.patch.yml'), 'utf8')
const username = /username:\s*'([^']*)'/.exec(patch)?.[1] ?? ''
const baseUrl = /baseUrl:\s*'([^']*)'/.exec(patch)?.[1] ?? ''

function mount(config) {
  let handler
  const ctx = {
    webServer: {
      register(options) {
        handler = options.handler
        return () => { handler = undefined }
      },
    },
    effect() { return () => {} },
  }
  apply(ctx, config)
  if (!handler) throw new Error('no handler registered')
  return handler
}

async function call(handler, method, url, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.method = method
  req.url = url
  req.headers = body === undefined ? {} : { 'content-type': 'application/json' }
  const chunks = []
  let status = 0
  const headers = {}
  const res = {
    writeHead(code, extra) { status = code; Object.assign(headers, extra) },
    end(text) { if (text !== undefined) chunks.push(Buffer.from(text)) },
  }
  await handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status, headers, text, json }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const anonHandler = mount({ baseUrl, username: '' })
const anon = await call(anonHandler, 'GET', '/meal/api/panel')
check('panel without username reports unconfigured', anon.status === 200 && anon.json?.value?.configured === false, `status ${anon.status}`)

const handler = mount({ baseUrl, username })
const health = await call(handler, 'GET', '/meal/api/health')
check('health route', health.status === 200 && health.json?.ok === true, health.json?.value?.username)

const panel = await call(handler, 'GET', '/meal/api/panel')
const value = panel.json?.value ?? {}
check('panel loads month data', panel.status === 200 && Array.isArray(value.days) && value.days.length > 0, `today=${value.today} days=${value.days?.length}`)
check('panel reports profile', value.profile?.username === username, value.profile?.departmentName ?? '')
const today = value.days?.find(day => day.date === value.today)
check('today has lunch and dinner', today?.meals?.length === 2, (today?.meals ?? []).map(meal => `${meal.meal}:${meal.choice}`).join(','))

const future = value.days?.find(day => day.date > value.today && day.meals?.some(meal => meal.locked !== true))
if (future) {
  const dinnerBefore = future.meals.find(meal => meal.meal === 'DINNER')
  const flip = dinnerBefore.choice === 'ORDERED' ? 'DECLINED' : 'ORDERED'
  const updated = await call(handler, 'POST', '/meal/api/selection', { date: future.date, meal: 'DINNER', choice: flip })
  check('selection write', updated.status === 200 && updated.json?.value?.day?.meals?.find(m => m.meal === 'DINNER')?.choice === flip, `${future.date} dinner -> ${flip}`)
  const reverted = await call(handler, 'POST', '/meal/api/selection', { date: future.date, meal: 'DINNER', choice: dinnerBefore.choice })
  check('selection revert', reverted.status === 200 && reverted.json?.value?.day?.meals?.find(m => m.meal === 'DINNER')?.choice === dinnerBefore.choice, `restored ${dinnerBefore.choice}`)
} else {
  check('selection write', false, 'no editable future day found')
}

const badMeal = await call(handler, 'POST', '/meal/api/selection', { date: future?.date ?? value.today, meal: 'BRUNCH', choice: 'ORDERED' })
check('invalid meal rejected locally', badMeal.status === 400 && badMeal.json?.error?.code === 'bad-meal', badMeal.json?.error?.message)

// Pick a past day that the service already locked; today may still be open
// (lunch closes at 08:45 and dinner at 13:45 on the service clock).
const lockedMeal = (value.days ?? [])
  .filter(day => day.date <= value.today)
  .flatMap(day => (day.meals ?? []).map(meal => ({ date: day.date, ...meal })))
  .find(meal => meal.locked === true)
if (lockedMeal) {
  const locked = await call(handler, 'POST', '/meal/api/selection', {
    date: lockedMeal.date,
    meal: lockedMeal.meal,
    choice: lockedMeal.choice === 'ORDERED' ? 'DECLINED' : 'ORDERED',
  })
  const lockedError = locked.json?.error ?? {}
  check('locked meal reports server error', locked.status === 400 && /锁定|Closed/i.test(lockedError.message ?? ''), `${lockedMeal.date} ${lockedMeal.meal}: ${lockedError.message}`)
} else {
  check('locked meal reports server error', true, 'no locked meal in range; skipped')
}

const notFound = await call(handler, 'GET', '/meal/api/nope')
check('unknown route', notFound.status === 404)

const failed = results.filter(entry => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
