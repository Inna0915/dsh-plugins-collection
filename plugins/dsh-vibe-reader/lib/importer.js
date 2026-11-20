/**
 * 入藏：校验通过才写入书库（spec §6.3）。
 * - 格式：解析器零错误；
 * - 原文：书卷正文与输入原文规范化后逐字一致（source 为 ai 时跳过，并标为 AI 摘编）；
 * - 写入：frontmatter 的 fingerprint / verified / source 由这里决定，原子写入。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseVolume } from './volume.js'
import { colorOf, suggestColors } from './palette.js'
import { checkOriginal } from './verify.js'

export const SOURCES = Object.freeze(['paste', 'corpus', 'ai'])

export function yamlValue(value) {
  if (typeof value === 'boolean') return String(value)
  const text = String(value)
  return /^[\s'"[]|\s#|:\s*$|^$/.test(text) ? JSON.stringify(text) : text
}

/** Set or insert top-level frontmatter keys, leaving every other line untouched. */
export function setFrontmatter(markdown, patch) {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') throw new Error('缺少 frontmatter')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) throw new Error('frontmatter 没有结束的 ---')
  const pending = new Map(Object.entries(patch))
  for (let index = 1; index < end; index++) {
    const key = /^([A-Za-z][\w-]*)\s*:/.exec(lines[index])?.[1]
    if (key && pending.has(key)) {
      lines[index] = `${key}: ${yamlValue(pending.get(key))}`
      pending.delete(key)
    }
  }
  const inserted = [...pending].map(([key, value]) => `${key}: ${yamlValue(value)}`)
  lines.splice(end, 0, ...inserted)
  return lines.join('\n').replace(/\n*$/, '\n')
}

function sourceLabel(source, given) {
  if (source === 'ai') return 'ai'
  if (typeof given === 'string' && given.trim() && given.trim() !== 'ai') return given.trim().slice(0, 200)
  return source === 'corpus' ? '语料' : '用户粘贴'
}

/**
 * Validate and write one volume into the personal library.
 * @param {object} input - { markdown, original, source, verified, overwrite }
 * @param {object} deps - { libraryDir, scan } where scan() returns the library snapshot.
 */
export async function importVolume(rawInput, { libraryDir, scan }) {
  let input = rawInput
  if (typeof input?.markdown !== 'string' || !input.markdown.trim()) return { ok: false, stage: 'input', problems: ['缺少书卷 Markdown'] }
  // 给已有书卷补注释：原文取自书库里那一卷，来源与核对状态照旧，Agent 只能改注释、译文、分节。
  if (input.keepOriginal === true) {
    const id = parseVolume(input.markdown).id
    const existing = id ? (await scan()).volumes.get(id) : undefined
    if (!existing || existing.errors.length) return { ok: false, stage: 'input', problems: [`keepOriginal 需要书库里已有 id 为 ${id || '（空）'} 的书卷`] }
    input = {
      ...input,
      original: existing.sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.text)).join('\n\n'),
      source: existing.verified === 'corpus' ? 'corpus' : existing.source === 'ai' ? 'ai' : 'paste',
      verified: existing.verified === true,
      sourceName: existing.source,
      overwrite: true
    }
  }
  const source = SOURCES.includes(input?.source) ? input.source : 'paste'
  if (input.markdown.length > 1024 * 1024) return { ok: false, stage: 'input', problems: ['书卷超过 1 MB'] }

  const draft = parseVolume(input.markdown)
  if (draft.errors.length) return { ok: false, stage: 'format', problems: draft.errors, warnings: draft.warnings }
  if (draft.color && !colorOf(draft.color)) {
    const near = suggestColors(draft.color)
    return { ok: false, stage: 'format', problems: [`色名「${draft.color}」不在中国传统色色表内（zhongguose.com 526 色）。用 colors 查色名${near.length ? '，近似的有：' + near.join('、') : ''}；也可以去掉 color`] }
  }

  if (source !== 'ai') {
    if (typeof input.original !== 'string' || !input.original.trim()) {
      return { ok: false, stage: 'original', problems: ['缺少原文：粘贴或语料的原文必须一并提供，用来逐字校验'] }
    }
    const check = checkOriginal(input.original, draft)
    if (!check.ok) {
      return {
        ok: false,
        stage: 'original',
        problems: ['书卷正文与原文不一致，未写入。请只改注释、译文、分节，不要改动原文：', ...check.problems],
        hunks: check.hunks,
        more: check.more,
        expectedLength: check.expectedLength,
        actualLength: check.actualLength
      }
    }
  }

  const verified = source === 'corpus' ? 'corpus' : source === 'paste' && input.verified === true ? true : false
  const markdown = setFrontmatter(input.markdown, {
    fingerprint: draft.actualFingerprint,
    verified,
    source: sourceLabel(source, input.sourceName || draft.source)
  })
  const volume = parseVolume(markdown)
  if (volume.errors.length || volume.integrity !== 'ok') {
    return { ok: false, stage: 'format', problems: ['写入前复核失败：' + [...volume.errors, volume.integrity].join('；')] }
  }

  const snapshot = await scan()
  const existing = snapshot.volumes.get(volume.id)
  const ownCopy = existing && existing.origin === 'library' ? existing : null
  if (ownCopy && input.overwrite !== true) {
    return {
      ok: false,
      stage: 'exists',
      problems: [`书库里已有 id 为 ${volume.id} 的书卷（${ownCopy.file}）。确认要替换时传 overwrite: true`]
    }
  }
  const fileName = ownCopy?.file || `${volume.id}.md`
  const file = join(libraryDir, fileName)

  const report = {
    ok: true,
    id: volume.id,
    title: volume.title,
    file,
    fingerprint: volume.actualFingerprint,
    verified,
    source: volume.source,
    sections: volume.sections.length,
    notes: volume.sections.reduce((sum, section) => sum + section.notes.length, 0),
    color: volume.color ? { name: volume.color, hex: colorOf(volume.color).hex } : null,
    warnings: volume.warnings
  }
  if (existing?.origin === 'builtin') report.overrides = '内置书卷（之后以书库里的这份为准）'
  if (ownCopy) {
    report.replaced = ownCopy.file
    report.originalChanged = ownCopy.actualFingerprint !== volume.actualFingerprint
    const kept = new Set(volume.sections.map((section) => section.id))
    report.removedSections = ownCopy.sections.map((section) => section.id).filter((id) => !kept.has(id))
  }

  await mkdir(libraryDir, { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, markdown, 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
  const written = parseVolume(await readFile(file, 'utf8'), fileName)
  if (written.integrity !== 'ok') throw new Error('写入后复核失败：' + file)
  return report
}
