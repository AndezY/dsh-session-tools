/**
 * dsh-session-tools / 安装器辅助：把插件登记进 profile 的 package.json。
 *
 * 为什么单独一个 node 脚本而不是 shell 里拼 JSON：
 *   macOS 自带的 bash 3.2 没有顺手的 JSON 工具，`jq` 又未必装。宿主里一定有 node
 *   （DSH 自带的运行时），交给它读改写最稳，也能保住原有字段的顺序。
 *
 * 用法：
 *   node patch-manifest.mjs <package.json 路径> <插件名> add|remove
 * 输出：备份文件路径（add）/ 空（remove）
 */
import fs from 'node:fs'
import path from 'node:path'

const [, , file, name, action] = process.argv

if (!file || !name || (action !== 'add' && action !== 'remove')) {
  console.error('usage: patch-manifest.mjs <package.json> <plugin-name> add|remove')
  process.exit(2)
}

const DEP_SPEC = 'file:../../plugins/' + name

let raw
try {
  raw = fs.readFileSync(file, 'utf8')
} catch (error) {
  console.error('cannot read ' + file + ': ' + String(error && error.message ? error.message : error))
  process.exit(3)
}

let manifest
try {
  manifest = JSON.parse(raw)
} catch (error) {
  console.error('invalid JSON in ' + file + ': ' + String(error && error.message ? error.message : error))
  process.exit(3)
}

const stamp = new Date()
const pad = (n) => String(n).padStart(2, '0')
const backup = file + '.bak-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate())
  + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds())

try {
  fs.copyFileSync(file, backup)
} catch (error) {
  console.error('cannot back up ' + file + ': ' + String(error && error.message ? error.message : error))
  process.exit(4)
}

if (!manifest.dependencies || typeof manifest.dependencies !== 'object') manifest.dependencies = {}
if (!manifest.dsh || typeof manifest.dsh !== 'object') manifest.dsh = {}
if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {}
if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = []

if (action === 'add') {
  manifest.dependencies[name] = DEP_SPEC
  if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
} else {
  delete manifest.dependencies[name]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((item) => item !== name)
}

// 保持两空格缩进 + 结尾换行，和 DSH 自己写出来的样子一致
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

if (action === 'add') {
  console.log(path.basename(backup))
}
