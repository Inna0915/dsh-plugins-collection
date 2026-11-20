// 计算书卷的原文指纹；加 --write 时把结果写回 frontmatter 的 fingerprint 行。
// 用法：node scripts/fingerprint.mjs <书卷.md>... [--write]
// 只在你确认原文无误后再 --write：指纹的意义是「这份原文是我核对过的那一份」。
import { readFileSync, writeFileSync } from 'node:fs'
import { parseVolume } from '../lib/volume.js'

const write = process.argv.includes('--write')
const files = process.argv.slice(2).filter((arg) => arg !== '--write')
if (!files.length) {
  console.error('用法：node scripts/fingerprint.mjs <书卷.md>... [--write]')
  process.exit(2)
}
let failed = false
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const volume = parseVolume(source, file)
  if (volume.errors.length) {
    failed = true
    console.error(`${file}: 有 ${volume.errors.length} 个错误，未计算\n  ${volume.errors.join('\n  ')}`)
    continue
  }
  for (const warning of volume.warnings) console.warn(`${file}: ${warning}`)
  const state = volume.integrity === 'ok' ? '一致' : volume.integrity === 'missing' ? '未登记' : '不一致'
  console.log(`${file}: ${volume.actualFingerprint}（frontmatter ${state}）`)
  if (write && volume.integrity !== 'ok') {
    const updated = /^fingerprint:.*$/m.test(source)
      ? source.replace(/^fingerprint:.*$/m, `fingerprint: ${volume.actualFingerprint}`)
      : source.replace(/^---\r?\n/, `---\nfingerprint: ${volume.actualFingerprint}\n`)
    writeFileSync(file, updated, 'utf8')
    console.log(`  已写入`)
  }
}
process.exit(failed ? 1 : 0)
