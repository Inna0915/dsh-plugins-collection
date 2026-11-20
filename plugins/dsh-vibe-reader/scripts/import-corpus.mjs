// 语料命令行（与工具 vibe_reader 的 search / draft 同一套逻辑，见 lib/corpus.js）。
//
//   node scripts/import-corpus.mjs search 陋室铭 [--author 刘禹锡] [--deep] [--ctext]
//   node scripts/import-corpus.mjs draft <ref> [<ref>…] --id 书卷id [--volume-title 卷名] [--out 文件 | --import [--overwrite]]
//   node scripts/import-corpus.mjs prefetch [集子…]          # 预先下载（默认下载全唐诗、全宋词、元曲）
//   node scripts/import-corpus.mjs --list <集子> [--grep 关键词]
//
// 集子见 lib/corpus.js 的 COLLECTIONS。下载缓存在 ~/.dsh/vibe-reader/cache/corpus/。
// draft 的草稿没有注释和译文，可交给刻书匠（skill vibe-reader-engraver）补全后再 import --overwrite。
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLLECTIONS, createCorpus } from '../lib/corpus.js'
import { importVolume } from '../lib/importer.js'
import { createLibrary } from '../lib/store.js'
import { resolvePaths } from '../index.js'

function parseArgs(argv) {
  const args = { positional: [], flags: new Set() }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (['--author', '--id', '--out', '--volume-title', '--grep', '--list'].includes(arg)) args[arg.slice(2)] = argv[++index]
    else if (arg.startsWith('--')) args.flags.add(arg.slice(2))
    else args.positional.push(arg)
  }
  return args
}

const USAGE = `用法：
  node scripts/import-corpus.mjs search <标题或名句> [--author 作者] [--deep] [--ctext]
  node scripts/import-corpus.mjs draft <ref>… --id 书卷id [--volume-title 卷名] [--out 文件 | --import [--overwrite]]
  node scripts/import-corpus.mjs prefetch [集子…]
  node scripts/import-corpus.mjs --list <集子> [--grep 关键词]
集子：${Object.entries(COLLECTIONS).map(([name, c]) => `${name}（${c.label}）`).join('、')}`

async function main(argv) {
  const args = parseArgs(argv)
  const paths = resolvePaths({})
  const corpus = createCorpus({ cacheDir: paths.corpusDir, ctextKey: process.env.CTEXT_API_KEY || '', log: (message) => console.error(message) })
  const [command, ...rest] = args.positional
  if (args.list) {
    const entries = await corpus.index(args.list, { refresh: args.flags.has('refresh') })
    const rows = entries.map((entry) => `${entry.ref}\t${entry.title}\t${entry.author}`).filter((row) => !args.grep || row.includes(args.grep))
    console.log(rows.join('\n'))
    console.error(`${COLLECTIONS[args.list].label}：共 ${entries.length} 篇，列出 ${rows.length} 篇`)
    return 0
  }
  if (command === 'search' && rest.length) {
    const result = await corpus.search({ query: rest.join(' '), author: args.author, deep: args.flags.has('deep'), ctext: args.flags.has('ctext') })
    for (const hit of result.hits) console.log(`${hit.ref}\t${hit.title}\t${hit.author}\t${hit.collection}\t${hit.match === 'text' ? '…' + hit.excerpt + '…' : hit.preview}`)
    for (const hit of result.ctext || []) console.log(`${hit.ref}\t${hit.title}\tctext${hit.needsKey ? '（取正文需 API key）' : ''}`)
    if (result.ctextError) console.error('ctext：' + result.ctextError)
    console.error(`搜了：${result.searched.join('、')}；命中 ${result.total} 篇` + (result.hint ? `\n提示：${result.hint}` : ''))
    return result.hits.length || result.ctext?.length ? 0 : 1
  }
  if (command === 'prefetch') {
    const names = rest.length ? rest : Object.keys(COLLECTIONS).filter((name) => COLLECTIONS[name].tier === 'deep')
    for (const name of names) {
      const entries = await corpus.index(name, { refresh: args.flags.has('refresh') })
      console.error(`${COLLECTIONS[name].label}：${entries.length} 篇`)
    }
    return 0
  }
  if (command === 'draft' && rest.length && args.id) {
    const draft = await corpus.draft({ refs: rest, id: args.id, volumeTitle: args['volume-title'] })
    const pairs = draft.report.pairs.map((pair) => `${pair.from}→${pair.to}${pair.count > 1 ? '×' + pair.count : ''}`).join(' ')
    console.error(`${draft.sections} 节，${draft.chars} 字；抽出括注 ${draft.report.notes} 条，删空白 ${draft.report.spaces} 处，句读转全角 ${draft.report.punctuation} 处`)
    if (pairs) console.error(`繁简对应（请核对）：${pairs}`)
    for (const warning of draft.report.warnings) console.error('警告：' + warning)
    if (args.flags.has('import')) {
      const library = createLibrary([{ origin: 'builtin', dir: paths.seedsDir }, { origin: 'library', dir: paths.libraryDir }])
      const result = await importVolume({ markdown: draft.markdown, original: draft.original, source: 'corpus', overwrite: args.flags.has('overwrite') }, { libraryDir: paths.libraryDir, scan: library.scan })
      console.log(JSON.stringify(result, null, 2))
      return result.ok ? 0 : 1
    }
    if (args.out) {
      await mkdir(dirname(resolve(args.out)), { recursive: true })
      await writeFile(args.out + '.tmp', draft.markdown, 'utf8')
      await rename(args.out + '.tmp', args.out)
      console.error('草稿已写入 ' + args.out)
    } else {
      process.stdout.write(draft.markdown)
    }
    return 0
  }
  console.error(USAGE)
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => {
    console.error(error.message)
    if (error.chapters?.length) console.error('章节：' + error.chapters.join(' '))
    process.exitCode = 1
  })
}
