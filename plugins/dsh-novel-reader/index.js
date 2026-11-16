import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const inject = ['connection']

const sites = new Map([
  ['www.qidian.com', '起点'],
  ['read.qidian.com', '起点'],
  ['m.qidian.com', '起点'],
  ['fanqienovel.com', '番茄'],
  ['www.fanqienovel.com', '番茄'],
  ['m.fanqienovel.com', '番茄']
])

function readingEntry(value) {
  if (!value || !['bookmark', 'note'].includes(value.kind)) return null
  const url = typeof value.url === 'string' && value.url.length <= 2048 ? URL.parse(value.url) : null
  const site = sites.get(url?.hostname)
  if (!site || url.protocol !== 'https:' || url.port || url.username || url.password) return null
  const book = typeof value.book === 'string' ? value.book.trim().slice(0, 120) : ''
  if (!book) return null
  const entry = {
    id: randomUUID(),
    site,
    book,
    chapter: typeof value.chapter === 'string' ? value.chapter.trim().slice(0, 180) : '',
    url: url.origin + url.pathname,
    createdAt: new Date().toISOString()
  }
  if (value.kind === 'bookmark') return entry
  const excerpt = typeof value.excerpt === 'string' ? value.excerpt.trim().slice(0, 600) : ''
  const note = typeof value.note === 'string' ? value.note.trim().slice(0, 4000) : ''
  return excerpt || note ? { ...entry, excerpt, note } : null
}

export function createLibrary(file) {
  let pending = Promise.resolve()
  async function read() {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return { bookmarks: [], notes: [] }
      throw error
    }
  }
  function save(kind, entry) {
    const writing = pending.then(async () => {
      const library = await read()
      if (kind === 'bookmark') {
        library.bookmarks = [entry, ...library.bookmarks.filter(
          (item) => item.site !== entry.site || item.book !== entry.book
        )]
      } else {
        library.notes.unshift(entry)
      }
      await mkdir(dirname(file), { recursive: true })
      const temporary = file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, JSON.stringify(library, null, 2) + '\n', { mode: 0o600 })
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
      return library
    })
    pending = writing.catch(() => {})
    return writing
  }
  return { read, save }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

export function apply(ctx) {
  const library = createLibrary(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'novel-reader', 'library.json'))
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/novel-reader/library',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return json(await library.read())
        const body = await request.text()
        if (body.length > 20000) return json({ error: '笔记请求过大' }, 413)
        let value
        try { value = JSON.parse(body) } catch { return json({ error: '笔记格式无效' }, 400) }
        const entry = readingEntry(value)
        if (!entry) return json({ error: '请提供官方章节链接、书名和要保存的内容' }, 400)
        return json(await library.save(value.kind, entry))
      } catch {
        return json({ error: '读取或保存阅读记录失败，请检查本机数据文件' }, 500)
      }
    }
  }), 'novel-reader: local library')
}
