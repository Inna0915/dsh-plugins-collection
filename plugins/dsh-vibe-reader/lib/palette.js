/**
 * 中国传统色（zhongguose.com 526 色）。书卷 frontmatter 的 color 只能取这里的色名，
 * HEX 由色表提供（spec §6.2）。
 */
import { readFileSync } from 'node:fs'

const data = JSON.parse(readFileSync(new URL('../data/zhongguose.json', import.meta.url), 'utf8'))

export const PALETTE = Object.freeze(data.colors)
export const PALETTE_SOURCE = data.source
const byName = new Map(PALETTE.map((color) => [color.name, color]))
export const FAMILIES = Object.freeze([...new Set(PALETTE.map((color) => color.family))])
export const SEASONS = Object.freeze([...new Set(PALETTE.map((color) => color.season))])

export function colorOf(name) {
  return typeof name === 'string' ? byName.get(name.trim()) : undefined
}

/** Names sharing a character with the unknown one, e.g. 苍翠 → 翠绿、翠蓝… */
export function suggestColors(name, limit = 8) {
  const chars = new Set(Array.from(String(name || '')).filter((char) => /\p{Script=Han}/u.test(char)))
  return PALETTE.filter((color) => Array.from(color.name).some((char) => chars.has(char))).slice(0, limit).map((color) => color.name)
}

/**
 * Filter the palette for picking a volume color. Mid luminance reads well as an
 * accent on both light and dark themes, so `accent: true` keeps 0.08–0.35.
 */
export function listColors({ family, season, query, accent = false } = {}) {
  return PALETTE.filter((color) =>
    (!family || color.family === family) &&
    (!season || color.season === season) &&
    (!query || color.name.includes(query)) &&
    (!accent || (color.luminance > 0.08 && color.luminance < 0.35))
  ).map(({ name, hex, family: f, season: s, tone }) => ({ name, hex, family: f, season: s, tone }))
}
