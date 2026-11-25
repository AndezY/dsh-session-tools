/**
 * 预览 / 打开 的离线自测：真文件、真 plan，不碰网络、不真的开程序。
 *
 * node test/inspect-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const { findArtifact, readPreview, openArtifact, normalizePath } = await import('../lib/inspect.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dst-inspect-'))
const pngFile = path.join(dir, 'shot.png')
const pyFile = path.join(dir, 'run.py')
const binFile = path.join(dir, 'blob.bin')
const bigFile = path.join(dir, 'huge.png')
const longText = path.join(dir, 'notes.txt')
const ghostFile = path.join(dir, 'gone.md')
const outside = path.join(dir, '..', 'outside.txt')

// 1x1 透明 PNG
fs.writeFileSync(pngFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
fs.writeFileSync(pyFile, 'print("hi")\n')
fs.writeFileSync(binFile, Buffer.from([0, 1, 2, 3, 0, 255]))
fs.writeFileSync(bigFile, Buffer.alloc(4 * 1024 * 1024 + 1, 7))
fs.writeFileSync(longText, 'x'.repeat(100 * 1024))
fs.writeFileSync(outside, 'not mine')

const plan = {
  artifacts: [
    { path: pngFile, bytes: 68, sources: ['presented'] },
    { path: pyFile, bytes: 12, sources: ['write'] },
    { path: binFile, bytes: 6, sources: ['write'] },
    { path: bigFile, bytes: 4 * 1024 * 1024 + 1, sources: ['write'] },
    { path: longText, bytes: 100 * 1024, sources: ['edit'] },
    { path: ghostFile, bytes: 10, sources: ['write'] },
  ],
}

// ---------------------------------------------------------------- 路径归一
assert.equal(normalizePath('  '), null)
assert.equal(normalizePath(42), null)
assert.equal(normalizePath(pngFile.toUpperCase()), path.resolve(pngFile).toLowerCase())
console.log('normalizePath ok')

// ---------------------------------------------------------------- 找产物
assert.ok(findArtifact(plan, pngFile), 'exact path found')
assert.ok(findArtifact(plan, pngFile.replace(/\\/g, '/')), 'forward slashes accepted')
assert.equal(findArtifact(plan, outside), null, 'file outside the plan is refused')
assert.equal(findArtifact(plan, null), null, 'null path refused')
assert.equal(findArtifact({}, pngFile), null, 'empty plan refuses everything')
console.log('findArtifact ok')

// ---------------------------------------------------------------- 图片预览
const image = readPreview(plan, pngFile)
assert.equal(image.ok, true)
assert.equal(image.kind, 'image')
assert.equal(image.mime, 'image/png')
assert.ok(image.dataUrl.startsWith('data:image/png;base64,'), 'data url built')
assert.equal(image.name, 'shot.png')
console.log('image preview ok:', image.name, image.bytes, 'bytes')

const huge = readPreview(plan, bigFile)
assert.equal(huge.kind, 'image')
assert.equal(huge.dataUrl, undefined, 'oversized image is not inlined')
assert.equal(huge.note, 'too-large')
console.log('oversized image ok: note =', huge.note)

// ---------------------------------------------------------------- 文本预览
const code = readPreview(plan, pyFile)
assert.equal(code.kind, 'text')
assert.ok(code.text.includes('print'), 'text body returned')
assert.equal(code.truncated, false)
console.log('text preview ok:', JSON.stringify(code.text.trim()))

const long = readPreview(plan, longText)
assert.equal(long.kind, 'text')
assert.equal(long.truncated, true, 'long text flagged as truncated')
assert.ok(long.text.length <= 64 * 1024, 'text preview capped')
console.log('long text ok: truncated =', long.truncated)

// ---------------------------------------------------------------- 二进制
const bin = readPreview(plan, binFile)
assert.equal(bin.kind, 'binary')
assert.equal(bin.text, undefined)
console.log('binary preview ok')

// ---------------------------------------------------------------- 拒绝
const notMine = readPreview(plan, outside)
assert.equal(notMine.ok, false)
assert.equal(notMine.error, 'not an artifact of this session')

const gone = readPreview(plan, ghostFile)
assert.equal(gone.ok, false)
assert.equal(gone.error, 'file is gone')
console.log('preview refusals ok:', notMine.error, '|', gone.error)

// ---------------------------------------------------------------- 打开（只验拒绝路径，不真的开程序）
const openOutside = openArtifact(plan, outside, {})
assert.equal(openOutside.ok, false)
assert.equal(openOutside.error, 'not an artifact of this session')

const openGone = openArtifact(plan, ghostFile, { reveal: true })
assert.equal(openGone.ok, false)
assert.equal(openGone.error, 'file is gone')
console.log('open refusals ok:', openOutside.error, '|', openGone.error)

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(outside, { force: true })
console.log('\nINSPECT SELF-TESTS PASSED')
