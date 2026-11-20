/**
 * 本地数据：书库扫描（只读）与 state.json（进度、背诵等级、出卡记录、设置）。
 * 写入一律「临时文件 + 改名」，并按文件串行，参考 novel-reader 的 createLibrary。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { colorOf } from './palette.js'
import { cardsOf, parseVolume, summarize } from './volume.js'

export const MAX_LEVEL = 5
const MAX_VOLUME_BYTES = 2 * 1024 * 1024
const MAX_VOLUME_FILES = 500
const KEY = /^[^\s#][^#]{0,119}(?:#[^#]{1,120}){1,2}$/
const RATINGS = Object.freeze({ remembered: 1, fuzzy: 0, forgot: -1 })

export class OpError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OpError'
  }
}

export function defaultState() {
  return {
    version: 1,
    ui: { view: 'encounter', volume: null },
    volumes: {},
    cards: {},
    resurface: {},
    settings: { readAfterSeconds: 10, followSessions: true, showGloss: true, vertical: false, translationOpen: true, notesOpen: true, fontScale: 1 }
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Merge a loaded file over defaults so older or hand-edited files keep working. */
export function normalizeState(raw) {
  const base = defaultState()
  const value = plainObject(raw)
  const ui = plainObject(value.ui)
  const settings = plainObject(value.settings)
  return {
    ...value,
    version: 1,
    ui: {
      view: ui.view === 'study' ? 'study' : 'encounter',
      volume: typeof ui.volume === 'string' ? ui.volume : null
    },
    volumes: plainObject(value.volumes),
    cards: plainObject(value.cards),
    resurface: plainObject(value.resurface),
    settings: { ...base.settings, ...settingsPatch(settings, true) }
  }
}

function settingsPatch(patch, lenient = false) {
  const out = {}
  for (const [key, value] of Object.entries(plainObject(patch))) {
    if (key === 'readAfterSeconds') {
      if (Number.isInteger(value) && value >= 3 && value <= 600) out[key] = value
      else if (!lenient) throw new OpError('可读阈值应为 3～600 秒的整数')
    } else if (key === 'fontScale') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0.8 && value <= 2) out[key] = Math.round(value * 100) / 100
      else if (!lenient) throw new OpError('字号比例应在 0.8～2 之间')
    } else if (['followSessions', 'showGloss', 'vertical', 'translationOpen', 'notesOpen'].includes(key)) {
      if (typeof value === 'boolean') out[key] = value
      else if (!lenient) throw new OpError(`设置 ${key} 应为开或关`)
    } else if (!lenient) {
      throw new OpError(`不支持的设置：${key}`)
    }
  }
  return out
}

function dayOf(now) {
  return now.toISOString().slice(0, 10)
}

function cardKey(op) {
  if (typeof op.key !== 'string' || !KEY.test(op.key)) throw new OpError('卡片标识无效')
  return op.key
}

/**
 * Pure state transition. `resolve(key)` answers whether a card key names a
 * known section or quote, and whether it may be recited.
 * @returns {object} the next state (the input is not mutated).
 */
export function applyOp(state, op, now, resolve = () => ({ exists: true, recitable: true })) {
  const next = structuredClone(state)
  switch (op?.op) {
    case 'view': {
      if (op.view !== 'encounter' && op.view !== 'study') throw new OpError('视图只能是偶遇或修业')
      next.ui.view = op.view
      return next
    }
    case 'progress': {
      const key = cardKey({ key: `${op.volumeId}#${op.sectionId}` })
      if (!resolve(key).exists) throw new OpError('没有这一卷或这一节')
      next.ui.volume = op.volumeId
      next.volumes[op.volumeId] = { ...plainObject(next.volumes[op.volumeId]), lastSection: op.sectionId, readAt: now.toISOString() }
      return next
    }
    case 'rate': {
      const key = cardKey(op)
      const target = resolve(key)
      if (!target.exists) throw new OpError('没有这张卡')
      if (!target.recitable) throw new OpError('这卷还未核对或原文指纹不一致，只能阅读，不能背诵')
      if (!Object.hasOwn(RATINGS, op.rating)) throw new OpError('自评只能是记得、模糊或忘了')
      const card = plainObject(next.cards[key])
      const level = Number.isInteger(card.level) ? card.level : 0
      next.cards[key] = {
        ...card,
        kind: target.kind || card.kind || 'section',
        level: Math.min(MAX_LEVEL, Math.max(0, level + RATINGS[op.rating])),
        reviews: (card.reviews || 0) + 1,
        lapses: (card.lapses || 0) + (op.rating === 'forgot' ? 1 : 0),
        lastRating: op.rating,
        ratedAt: now.toISOString()
      }
      return next
    }
    case 'level': {
      const key = cardKey(op)
      const target = resolve(key)
      if (!target.exists) throw new OpError('没有这张卡')
      if (!Number.isInteger(op.level) || op.level < 0 || op.level > MAX_LEVEL) throw new OpError(`等级应为 0～${MAX_LEVEL}`)
      next.cards[key] = { ...plainObject(next.cards[key]), kind: target.kind || 'section', level: op.level }
      return next
    }
    case 'seen': {
      const key = cardKey(op)
      if (!resolve(key).exists) throw new OpError('没有这张卡')
      const entry = plainObject(next.resurface[key])
      next.resurface[key] = { shown: (entry.shown || 0) + 1, lastShown: dayOf(now) }
      return next
    }
    case 'gloss': {
      if (!['inline', 'below', 'tap'].includes(op.mode)) throw new OpError('注释显示只能是夹注、句下或点词')
      if (!resolve(cardKey({ key: `${op.volumeId}#${op.sectionId}` })).exists) throw new OpError('没有这一卷')
      next.volumes[op.volumeId] = { ...plainObject(next.volumes[op.volumeId]), glossMode: op.mode }
      return next
    }
    case 'settings': {
      next.settings = { ...next.settings, ...settingsPatch(op.patch) }
      return next
    }
    default:
      throw new OpError('不支持的操作')
  }
}

async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * state.json with serialized read-modify-write. A file that no longer parses
 * is moved aside (never overwritten) and a fresh state starts.
 */
export function createStateStore(file, { clock = () => new Date() } = {}) {
  let pending = Promise.resolve()
  let recovered = null

  async function load() {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return defaultState()
      throw error
    }
    try {
      return normalizeState(JSON.parse(text))
    } catch {
      const backup = file.replace(/\.json$/, '') + '.corrupt-' + clock().toISOString().replace(/[:.]/g, '-') + '.json'
      await rename(file, backup)
      recovered = backup
      return defaultState()
    }
  }

  function serialized(task) {
    const run = pending.then(task)
    pending = run.catch(() => {})
    return run
  }

  return {
    read: () => serialized(load),
    update: (op, resolve) => serialized(async () => {
      const next = applyOp(await load(), op, clock(), resolve)
      await atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
      return next
    }),
    recovered: () => recovered
  }
}

async function listVolumeFiles(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.notes.md') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_VOLUME_FILES)
}

/**
 * Read-only library over ordered roots; a later root overrides an earlier one
 * by volume id (your own library overrides the built-in seeds).
 * Parsed files are cached by mtime and size.
 */
export function createLibrary(roots) {
  const cache = new Map()

  async function readVolume(file, name) {
    const info = await stat(file)
    const cached = cache.get(file)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.volume
    const parsed = info.size > MAX_VOLUME_BYTES
      ? { ...parseVolume('', name), errors: [`文件超过 ${MAX_VOLUME_BYTES / 1024 / 1024} MB`] }
      : parseVolume(await readFile(file, 'utf8'), name)
    const color = colorOf(parsed.color)
    const warnings = parsed.color && !color ? [...parsed.warnings, `色名「${parsed.color}」不在色表内，已忽略`] : parsed.warnings
    const volume = { ...parsed, warnings, colorHex: color?.hex || '', path: file, revision: `${info.mtimeMs}:${info.size}` }
    cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, volume })
    return volume
  }

  async function scan() {
    const byId = new Map()
    const rows = []
    const rootInfo = []
    for (const root of roots) {
      const names = await listVolumeFiles(root.dir)
      rootInfo.push({ origin: root.origin, dir: root.dir, exists: names !== null, files: names?.length ?? 0 })
      const seenHere = new Map()
      for (const name of names || []) {
        let volume = await readVolume(join(root.dir, name), name)
        volume = { ...volume, origin: root.origin }
        if (volume.id && seenHere.has(volume.id)) {
          volume = { ...volume, errors: [...volume.errors, `id 与同目录的 ${seenHere.get(volume.id)} 重复`], recitable: false }
          rows.push(volume)
          continue
        }
        if (volume.id) seenHere.set(volume.id, name)
        if (volume.id && byId.has(volume.id)) {
          const replaced = byId.get(volume.id)
          rows.splice(rows.indexOf(replaced), 1)
          volume = { ...volume, overrides: replaced.origin }
        }
        rows.push(volume)
        // A broken override still wins, so its errors are visible instead of silently falling back.
        if (volume.id) byId.set(volume.id, volume)
      }
    }
    const readable = rows.filter((volume) => volume.id && !volume.errors.length && byId.get(volume.id) === volume)
    return {
      roots: rootInfo,
      volumes: byId,
      list: rows.map(summarize),
      cards: readable.flatMap(cardsOf)
    }
  }

  return { scan }
}

/** Resolve a card key against a scanned library. */
export function resolverFor(snapshot) {
  const cards = new Map(snapshot.cards.map((card) => [card.key, card]))
  return (key) => {
    const [volumeId, sectionId, quote] = key.split('#')
    const volume = snapshot.volumes.get(volumeId)
    if (!volume || volume.errors.length) return { exists: false }
    const section = volume.sections.find((item) => item.id === sectionId)
    if (!section) return { exists: false }
    if (quote === undefined) return { exists: true, kind: 'section', recitable: volume.recitable }
    const card = cards.get(key)
    return card ? { exists: true, kind: 'quote', recitable: volume.recitable } : { exists: false }
  }
}
