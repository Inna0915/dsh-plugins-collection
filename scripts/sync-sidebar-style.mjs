// Write shared/sidebar.css into every plugin that draws in the left sidebar.
//
//   node scripts/sync-sidebar-style.mjs           update the marked string in each consumer
//   node scripts/sync-sidebar-style.mjs --check   exit 1 when any consumer is out of date
//
// Each consumer keeps its own copy (so removing one plugin never strips another's styles),
// written between the markers  /* @sidebar-style */ "…" /* @sidebar-style-end */  as a JS string.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CONSUMERS = [
  'plugins/dsh-project-package/src/client/index.jsx',
  'plugins/codex-monitor/client.js',
  'plugins/jira-flow/src/client/dsh.tsx',
  'plugins/dsh-vibe-reader/client.js',
  'plugins/meal-panel/client.js',
  'plugins/dsh-sidebar-recents/src/client/styles.js'
]
const MARKER = /\/\* @sidebar-style \*\/[\s\S]*?\/\* @sidebar-style-end \*\//g

/** Comments out, whitespace collapsed; spaces inside calc() and values are kept. */
export function minify(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*\n\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*([{};])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim()
}

const css = minify(await readFile(join(root, 'shared', 'sidebar.css'), 'utf8'))
const block = `/* @sidebar-style */ ${JSON.stringify(css)} /* @sidebar-style-end */`
const check = process.argv.includes('--check')
const stale = []
for (const relative of CONSUMERS) {
  const file = join(root, relative)
  const source = await readFile(file, 'utf8')
  const count = (source.match(MARKER) || []).length
  if (count !== 1) {
    stale.push(`${relative}：应有且只有一处 /* @sidebar-style */ 标记，现有 ${count} 处`)
    continue
  }
  const next = source.replace(MARKER, block)
  if (next === source) continue
  if (check) stale.push(`${relative}：未同步`)
  else {
    await writeFile(file, next, 'utf8')
    console.log('已同步', relative)
  }
}
if (stale.length) {
  console.error(stale.join('\n'))
  process.exitCode = 1
} else if (check) console.log(`左栏共用样式：${CONSUMERS.length} 个插件均已同步`)
