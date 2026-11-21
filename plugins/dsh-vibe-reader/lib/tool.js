/**
 * Agent 工具 vibe_reader（刻书匠用）：list / read / clean / import / verify。
 * 工具对所有会话可见，描述尽量短；失败以 { ok: false, problems } 返回，便于 Agent 修正后重试。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AUTHOR_NAME, parseAuthor, parseBackground } from './about.js'
import { cleanParagraphs, CleanError } from './clean.js'
import { COLLECTIONS, CorpusError } from './corpus.js'
import { FAMILIES, listColors, SEASONS } from './palette.js'
import { importVolume } from './importer.js'

export const TOOL_NAME = 'vibe_reader'
export const toolDescription = '闲庭书库：把古诗词、古文、整本书导入（入库、收录）闲庭阅读插件。search 搜语料；draft 生成草稿；clean 清洗粘贴原文；import 逐字校验后写入；colors 查传统色；list、read、verify 管理书卷；author 查作者事实，save-author、save-background 写知人论世。先读 skill vibe-reader-engraver。'

export const toolParameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['search', 'draft', 'clean', 'import', 'colors', 'list', 'read', 'verify', 'author', 'save-author', 'save-background'] },
    name: { type: 'string', description: 'author：作者姓名，如 范仲淹' },
    dynasty: { type: 'string', description: 'author：朝代，同名时用来区分' },
    query: { type: 'string', description: 'search：标题、词牌或名句（4 字以上会搜全文）' },
    author: { type: 'string', description: 'search：作者，用来缩小范围' },
    collections: { type: 'array', items: { type: 'string', enum: [...Object.keys(COLLECTIONS), 'ctext'] }, description: 'search：只搜这些集子（默认常用集子；quansongshi 全宋诗 104 MB 只在点名时搜）' },
    deep: { type: 'boolean', description: 'search：加搜全唐诗、全宋词、元曲（首次下载约 36 MB）' },
    ctext: { type: 'boolean', description: 'search：加搜 ctext 书目（先秦两汉典籍；取正文需 API key）' },
    refs: { type: 'array', items: { type: 'string' }, description: 'draft：search 返回的 ref，多首诗可合成一卷' },
    volumeTitle: { type: 'string', description: 'draft：多篇合成一卷时的卷名' },
    family: { type: 'string', description: 'colors：色系，如 红、绿、蓝、青、紫、棕、灰' },
    season: { type: 'string', description: 'colors：春、夏、秋、冬' },
    id: { type: 'string', description: 'draft：新书卷 id（小写拼音加连字符）；read、verify、save-background：已有书卷 id' },
    text: { type: 'string', description: 'clean：原文；段落之间空一行，诗句可每句一行' },
    traditional: { type: 'boolean', description: 'clean：原文为繁体时传 true' },
    markdown: { type: 'string', description: 'import：完整书卷 Markdown；save-author：作者文件；save-background：背景文件' },
    original: { type: 'string', description: 'import：用户给的原文或 clean 的输出，用来逐字校验' },
    source: { type: 'string', enum: ['paste', 'corpus', 'ai'], description: 'import：paste 用户粘贴（默认）、corpus 开源语料、ai 无原文的 AI 摘编' },
    verified: { type: 'boolean', description: 'import：仅当用户明确说原文已核对时传 true' },
    overwrite: { type: 'boolean', description: 'import：替换书库里同 id 的书卷；save-author、save-background：替换已有文件' },
    keepOriginal: { type: 'boolean', description: 'import：给书库里已有的书卷补注释、译文时传 true，原文以书库里那一卷为准，不用传 original' }
  },
  required: ['action'],
  additionalProperties: false
}

const MAX_TEXT = 200_000

function summary(volume) {
  return {
    id: volume.id || null,
    file: volume.file,
    origin: volume.origin,
    title: volume.title,
    author: volume.author,
    kind: volume.kind,
    verified: volume.verified,
    integrity: volume.integrity,
    recitable: volume.recitable,
    sections: volume.sections.length,
    errors: volume.errors.length
  }
}

/** Split pasted text into blocks (blank-line separated) of lines. */
export function blocksOf(text) {
  return String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean)).filter((lines) => lines.length)
}

async function writeAbout(file, markdown) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, markdown.replace(/\r\n?/g, '\n').trimEnd() + '\n', 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function createToolService({ library, libraryDir, corpus, t2s, authors }) {
  async function find(id) {
    if (typeof id !== 'string' || !id) return { problem: '缺少 id' }
    const snapshot = await library.scan()
    const volume = snapshot.volumes.get(id)
    return volume ? { volume } : { problem: `没有 id 为 ${id} 的书卷；先用 list 查看` }
  }

  const actions = {
    async search(args) {
      if (!corpus) return { ok: false, problems: ['语料不可用'] }
      const result = await corpus.search({ query: args.query, author: args.author, collections: args.collections, deep: args.deep === true, ctext: args.ctext === true })
      return {
        ok: true,
        ...result,
        next: result.hits.length || result.ctext?.length
          ? '选定后用 draft（refs 填 ref）取得清洗过的原文和草稿；有多个版本时把出处告诉用户'
          : '语料里没有：请用户粘贴完整原文，不要默写'
      }
    },
    async draft(args) {
      if (!corpus) return { ok: false, problems: ['语料不可用'] }
      const draft = await corpus.draft({ refs: args.refs, id: args.id, volumeTitle: args.volumeTitle })
      return {
        ok: true,
        ...draft,
        next: '在 markdown 上改节标题、补脉络、注释、译文、名句和 color，正文一字不改；import 时 original 原样传这里的 original，source 为 corpus'
      }
    },
    async colors(args) {
      const colors = listColors({ family: args.family, season: args.season, query: args.query, accent: true })
      return { ok: true, families: FAMILIES, seasons: SEASONS, count: colors.length, colors, note: '只列适合作强调色的中等明度色；color 只写色名' }
    },
    async list() {
      const snapshot = await library.scan()
      return {
        ok: true,
        libraryDir,
        volumes: snapshot.list.map((row) => ({
          id: row.id || null, file: row.file, origin: row.origin, title: row.title, author: row.author, kind: row.kind,
          verified: row.verified, integrity: row.integrity, recitable: row.recitable, sections: row.sectionCount, errors: row.errors.length
        }))
      }
    },
    async read(args) {
      const { volume, problem } = await find(args.id)
      if (problem) return { ok: false, problems: [problem] }
      return { ok: true, ...summary(volume), markdown: await readFile(volume.path, 'utf8') }
    },
    async clean(args) {
      if (typeof args.text !== 'string' || !args.text.trim()) return { ok: false, problems: ['缺少 text'] }
      if (args.text.length > MAX_TEXT) return { ok: false, problems: ['原文过长，请分卷处理'] }
      const blocks = blocksOf(args.text)
      try {
        const result = await cleanParagraphs(blocks.flat(), { traditional: args.traditional === true, t2s })
        // cleanParagraphs drops lines that clean to nothing; regroup by original block sizes.
        let cursor = 0
        const lines = result.paragraphs
        const cleanedBlocks = []
        if (lines.length === blocks.flat().length) {
          for (const block of blocks) {
            cleanedBlocks.push(lines.slice(cursor, cursor + block.length).map((line) => line.text).join('\n'))
            cursor += block.length
          }
        } else {
          cleanedBlocks.push(...lines.map((line) => line.text))
          result.report.warnings.push('有空行被清掉，段落已按行拆开，请检查分段')
        }
        return {
          ok: true,
          text: cleanedBlocks.join('\n\n'),
          notes: lines.flatMap((line) => line.notes),
          report: result.report,
          next: '核对 report.pairs（繁简对应）和 warnings；把 text 原样作为 import 的 original，正文也照抄 text，只加分节、注释、译文'
        }
      } catch (error) {
        if (error instanceof CleanError) return { ok: false, problems: [error.message] }
        throw error
      }
    },
    async import(args) {
      return importVolume(args, { libraryDir, scan: library.scan })
    },
    async author(args) {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!AUTHOR_NAME.test(name)) return { ok: false, stage: 'input', problems: ['name 应为作者姓名（汉字）'] }
      const snapshot = await library.scan()
      const existing = snapshot.authors.find((author) => author.name === name)
      const facts = authors ? await authors.lookup(name, typeof args.dynasty === 'string' ? args.dynasty.trim() : '') : { cbdb: null, candidates: [], poetry: null, wiki: null, warnings: ['作者事实来源不可用'] }
      return {
        ok: true,
        name,
        existing: existing ? { origin: existing.origin, errors: existing.errors, markdown: await readFile(existing.path, 'utf8') } : null,
        ...facts,
        next: existing && !existing.errors.length
          ? '作者库里已有这位作者；内容妥当就不必重写，直接写背景（save-background）'
          : '据 cbdb 与 poetry 的事实写作者文件（见 skill「知人论世」），用 save-author 保存；wiki 只作核对，不照抄'
      }
    },
    async 'save-author'(args) {
      if (typeof args.markdown !== 'string' || !args.markdown.trim()) return { ok: false, stage: 'input', problems: ['缺少 markdown'] }
      const author = parseAuthor(args.markdown)
      if (author.errors.length) return { ok: false, stage: 'format', problems: author.errors }
      const file = join(libraryDir, 'authors', author.name + '.md')
      if (!args.overwrite && await stat(file).catch(() => null)) return { ok: false, stage: 'exists', problems: [`作者库里已有「${author.name}」；确需替换时加 overwrite: true`] }
      await writeAbout(file, args.markdown)
      const bioChars = Array.from(author.bio.join('')).length
      const warnings = [...author.warnings, ...(bioChars > 320 ? [`小传 ${bioChars} 字，超过建议的 150～300 字；请精简后用 overwrite: true 重存`] : [])]
      return { ok: true, name: author.name, facts: author.facts.length, bioChars, warnings }
    },
    async 'save-background'(args) {
      if (typeof args.markdown !== 'string' || !args.markdown.trim()) return { ok: false, stage: 'input', problems: ['缺少 markdown'] }
      const { volume, problem } = await find(args.id)
      if (problem) return { ok: false, stage: 'input', problems: [problem] }
      const background = parseBackground(args.markdown)
      const problems = [...background.errors]
      if (background.volume && background.volume !== volume.id) problems.push(`volume「${background.volume}」与 id「${volume.id}」不一致`)
      for (const id of Object.keys(background.sections)) if (!volume.sections.some((section) => section.id === id)) problems.push(`书卷 ${volume.id} 没有节 {#${id}}`)
      if (problems.length) return { ok: false, stage: 'format', problems }
      const file = join(libraryDir, 'backgrounds', volume.id + '.md')
      if (!args.overwrite && await stat(file).catch(() => null)) return { ok: false, stage: 'exists', problems: [`《${volume.title}》已有背景；确需替换时加 overwrite: true`] }
      await writeAbout(file, args.markdown)
      const chars = Array.from(background.text.join('')).length
      const long = Object.entries(background.sections).filter(([, block]) => Array.from(block.text.join('')).length > 170).map(([id]) => id)
      const warnings = [...background.warnings, ...(chars > 270 ? [`全卷背景 ${chars} 字，超过建议的 100～250 字；请精简后用 overwrite: true 重存`] : []), ...(long.length ? [`节 ${long.join('、')} 的背景超过建议的 50～150 字`] : [])]
      return { ok: true, id: volume.id, chars, sections: Object.keys(background.sections).length, warnings }
    },
    async verify(args) {
      const { volume, problem } = await find(args.id)
      if (problem) return { ok: false, problems: [problem] }
      return {
        ok: volume.errors.length === 0 && volume.integrity === 'ok',
        ...summary(volume),
        problems: volume.errors,
        warnings: volume.warnings,
        fingerprint: { declared: volume.fingerprint || null, actual: volume.actualFingerprint }
      }
    }
  }

  return {
    async execute(args) {
      const action = actions[args?.action]
      if (!action) return { ok: false, problems: ['action 只能是 search、draft、clean、import、colors、list、read、verify、author、save-author、save-background'] }
      try {
        return await action(args)
      } catch (error) {
        if (error instanceof CorpusError) return { ok: false, problems: [error.message], ...(error.chapters ? { chapters: error.chapters } : {}) }
        throw error
      }
    }
  }
}
