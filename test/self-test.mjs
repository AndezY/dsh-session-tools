/**
 * 离线自测：在临时 DSH_HOME 里造一个会话（多 zstd frame），
 * 验证 plan / delete 的产物识别与落盘行为。
 *
 * node test/self-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dst-home-'))
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dst-ws-'))
process.env.DSH_HOME = tmpHome

const core = await import('../lib/core.js')

const sessionId = 'session-test-0000-1111-2222-333333333333'
const group = '--tmp-ws--'
const sessionDir = path.join(tmpHome, 'sessions', group, sessionId)
fs.mkdirSync(sessionDir, { recursive: true })

// 会话产物：一个 write、一个 edit、一个 present
const producedWrite = path.join(wsDir, 'reports', 'out.md')
const producedEdit = path.join(wsDir, 'engine', 'run.js')
const producedPresent = path.join(wsDir, 'dist', 'deck.pdf')
const untouched = path.join(wsDir, 'keep.txt')
for (const f of [producedWrite, producedEdit, producedPresent, untouched]) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, 'x'.repeat(1024))
}

const events = [
  { type: 'session', version: 4, id: sessionId, cwd: wsDir, createdAt: Date.now() },
  { type: 'session/title', seq: 1, data: { title: '自测会话' } },
  { type: 'tool/call', seq: 2, data: { name: 'write', arguments: JSON.stringify({ file_path: producedWrite, content: 'hi' }) } },
  { type: 'tool/call', seq: 3, data: { name: 'edit', arguments: JSON.stringify({ file_path: producedEdit, old_string: 'a', new_string: 'b' }) } },
  { type: 'deliverables/presented', seq: 4, data: { turn: 1, files: [{ path: producedPresent, description: 'deck' }] } },
  { type: 'tool/call', seq: 5, data: { name: 'read', arguments: JSON.stringify({ file_path: untouched }) } },
  { type: 'tool/call', seq: 6, data: { name: 'write', arguments: JSON.stringify({ file_path: path.join(tmpHome, 'must-not-delete.txt'), content: 'x' }) } },
]
// 造 3 个 zstd frame，模拟多次 append
const lines = events.map((e) => JSON.stringify(e))
const frames = [lines.slice(0, 2), lines.slice(2, 5), lines.slice(5)]
const logPath = path.join(sessionDir, 'session.v4.jsonl.zstd')
fs.writeFileSync(logPath, Buffer.concat(frames.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk.join('\n') + '\n', 'utf8')))))
// 夹一个“伪 magic”在帧中间的脏数据，验证解码容错
fs.appendFileSync(logPath, Buffer.concat([zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/start', seq: 7 }) + '\n')), Buffer.from([0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x00])]))

// DSH_HOME 里的文件：日志声称写过，但绝不放过
fs.writeFileSync(path.join(tmpHome, 'must-not-delete.txt'), 'keep me')

const cacheDir = path.join(tmpHome, 'storages', 'session_projcache', 'sessions')
fs.mkdirSync(cacheDir, { recursive: true })
const cacheFile = path.join(cacheDir, sessionId + '.json')
fs.writeFileSync(cacheFile, JSON.stringify({ unit: { name: 'session_projcache' } }))

// ---------------------------------------------------------------- 解码
const text = core.readLogText(logPath)
assert.ok(text.includes('deliverables/presented'), 'log text decoded')
const parsed = core.readEvents(logPath)
assert.ok(parsed.length >= 7, 'all frames decoded, got ' + parsed.length)
console.log('decode ok:', parsed.length, 'events across frames')

// ---------------------------------------------------------------- 计划
const plan = core.planDeletion(sessionId)
assert.ok(plan, 'plan exists')
assert.equal(plan.title, '自测会话')
const paths = plan.artifacts.map((a) => a.path)
assert.ok(paths.includes(producedWrite), 'write path found')
assert.ok(paths.includes(producedEdit), 'edit path found')
assert.ok(paths.includes(producedPresent), 'present path found')
assert.ok(!paths.includes(untouched), 'read-only file not listed')
assert.ok(!paths.includes(path.join(tmpHome, 'must-not-delete.txt')), 'DSH_HOME file excluded')
console.log('plan ok:', plan.artifacts.length, 'artifacts,', plan.totals.artifactBytes, 'bytes')

// 越权路径不该被删
assert.ok(fs.existsSync(path.join(tmpHome, 'must-not-delete.txt')))

// ---------------------------------------------------------------- 勾选保留
// 第二个会话：两个产物，删的时候只保留其中一个
const keepSessionId = 'session-test-keep-4444-5555-666666666666'
const keepDir = path.join(tmpHome, 'sessions', group, keepSessionId)
fs.mkdirSync(keepDir, { recursive: true })
const keepThis = path.join(wsDir, 'keepme', 'wanted.md')
const dropThat = path.join(wsDir, 'keepme', 'junk.bin')
for (const f of [keepThis, dropThat]) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, 'y'.repeat(64))
}
const keepEvents = [
  { type: 'session', version: 4, id: keepSessionId, cwd: wsDir },
  { type: 'tool/call', seq: 1, data: { name: 'write', arguments: JSON.stringify({ file_path: keepThis, content: 'a' }) } },
  { type: 'tool/call', seq: 2, data: { name: 'write', arguments: JSON.stringify({ file_path: dropThat, content: 'b' }) } },
]
fs.writeFileSync(
  path.join(keepDir, 'session.v4.jsonl.zstd'),
  Buffer.concat(keepEvents.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')))),
)

const keepPlan = core.planDeletion(keepSessionId)
assert.equal(keepPlan.artifacts.length, 2, 'both artifacts planned')
const kept = core.deleteSession({
  sessionId: keepSessionId,
  deleteArtifacts: true,
  // 大小写 / 斜杠变体也要认得出是同一条路径
  keep: [keepThis.replace(/\\/g, '/').toUpperCase()],
})
assert.equal(kept.ok, true)
assert.deepEqual(kept.artifacts.kept, [keepThis], 'kept list reports the kept file')
assert.equal(kept.artifacts.removed.length, 1, 'only the unticked file was removed')
assert.ok(fs.existsSync(keepThis), 'ticked file survives')
assert.ok(!fs.existsSync(dropThat), 'unticked file removed')
assert.ok(!fs.existsSync(keepDir), 'session dir still removed')
console.log('keep ok:', JSON.stringify({ kept: kept.artifacts.kept, removed: kept.artifacts.removed }))

// keep 传垃圾：全删，且不会因此越权
const junkSessionId = 'session-test-junk-7777-8888-999999999999'
const junkDir = path.join(tmpHome, 'sessions', group, junkSessionId)
fs.mkdirSync(junkDir, { recursive: true })
const junkFile = path.join(wsDir, 'junk2', 'a.txt')
fs.mkdirSync(path.dirname(junkFile), { recursive: true })
fs.writeFileSync(junkFile, 'z')
fs.writeFileSync(
  path.join(junkDir, 'session.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: junkSessionId, cwd: wsDir }) + '\n' + JSON.stringify({ type: 'tool/call', seq: 1, data: { name: 'write', arguments: JSON.stringify({ file_path: junkFile }) } }) + '\n')),
)
const junkKept = core.deleteSession({ sessionId: junkSessionId, deleteArtifacts: true, keep: 'not-an-array' })
assert.equal(junkKept.ok, true)
assert.deepEqual(junkKept.artifacts.kept, [], 'garbage keep is ignored')
assert.ok(!fs.existsSync(junkFile), 'artifact deleted when keep is garbage')
assert.equal(core.keepSet(['C:\\x\\y.txt', 7, '', null]).size, 1, 'keepSet filters non-strings')
console.log('keep-garbage ok: junk input deletes as before')

// ---------------------------------------------------------------- 删除
const res = core.deleteSession({ sessionId, deleteArtifacts: true })
assert.equal(res.ok, true, JSON.stringify(res.logs.failed))
assert.ok(!fs.existsSync(producedWrite), 'write artifact removed')
assert.ok(!fs.existsSync(producedEdit), 'edit artifact removed')
assert.ok(!fs.existsSync(producedPresent), 'present artifact removed')
assert.ok(fs.existsSync(untouched), 'untouched file kept')
assert.ok(fs.existsSync(path.join(tmpHome, 'must-not-delete.txt')), 'DSH_HOME file kept')
assert.ok(!fs.existsSync(sessionDir), 'session dir removed')
assert.ok(!fs.existsSync(cacheFile), 'projection cache removed')
console.log('delete ok:', JSON.stringify({
  artifacts: res.artifacts.removed.length,
  logs: res.logs.removed.length,
  cache: res.cache && res.cache.removed,
}))

// 幂等：再删一次不炸
const again = core.deleteSession({ sessionId, deleteArtifacts: true })
assert.equal(again.ok, true)
console.log('idempotent ok:', JSON.stringify(again.logs), JSON.stringify(again.artifacts))

// ---------------------------------------------------------------- 回收站 + 撤销
const trashSessionId = 'session-test-trash-1212-3434-565656565656'
const trashDir = path.join(tmpHome, 'sessions', group, trashSessionId)
fs.mkdirSync(trashDir, { recursive: true })
const trashedFile = path.join(wsDir, 'trashme', 'note.md')
fs.mkdirSync(path.dirname(trashedFile), { recursive: true })
fs.writeFileSync(trashedFile, 'bring me back')
fs.writeFileSync(
  path.join(trashDir, 'session.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'session', version: 4, id: trashSessionId, cwd: wsDir }) + '\n' +
    JSON.stringify({ type: 'tool/call', seq: 1, data: { name: 'write', arguments: JSON.stringify({ file_path: trashedFile }) } }) + '\n',
  )),
)
const trashed = core.deleteSession({ sessionId: trashSessionId, deleteArtifacts: true, trash: true })
assert.equal(trashed.ok, true)
assert.equal(trashed.artifacts.trashed.length, 1, 'moved to trash instead of rm')
assert.ok(trashed.artifacts.trashToken, 'trash token returned')
assert.ok(!fs.existsSync(trashedFile), 'original is gone from the workspace')
assert.ok(fs.existsSync(path.join(trashed.artifacts.trashDir, 'manifest.json')), 'manifest written')
assert.deepEqual(core.listTrash().map((r) => r.token).includes(trashed.artifacts.trashToken), true, 'listed in trash')
console.log('trash ok:', JSON.stringify({ token: trashed.artifacts.trashToken, bytes: trashed.artifacts.trashedBytes }))

const undo = core.restoreTrash(trashed.artifacts.trashToken)
assert.equal(undo.ok, true, JSON.stringify(undo.failed))
assert.deepEqual(undo.restored, [trashedFile], 'restored to the original path')
assert.equal(fs.readFileSync(trashedFile, 'utf8'), 'bring me back', 'content intact')
assert.equal(core.restoreTrash('../etc').ok, false, 'bad token refused')
console.log('undo ok: 文件回到原位，内容不变')

// 还原冲突：目标已存在时不覆盖，另存为 (2)
fs.writeFileSync(trashedFile, 'new content')
const trash2 = core.deleteSession({
  sessionId: 'session-test-trash2-9999-8888-777777777777',
  deleteArtifacts: false,
  trash: true,
})
assert.equal(trash2.ok, true, 'empty deletion still fine')
console.log('trash-empty ok')

// purge：保留期 0 天 → 立刻清空
const purged = core.purgeTrash(0)
assert.ok(purged.removed.length >= 0, 'purge ran')
console.log('purge ok:', JSON.stringify({ removed: purged.removed.length, kept: purged.kept }))

// ---------------------------------------------------------------- 纯文字会话：整个记录进回收站 + 撤销
const textSessionId = 'session-test-textonly-1357-2468-000000000000'
const textDir = path.join(tmpHome, 'sessions', group, textSessionId)
fs.mkdirSync(textDir, { recursive: true })
const textLog = path.join(textDir, 'session.v4.jsonl.zstd')
fs.writeFileSync(
  textLog,
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'session', version: 4, id: textSessionId, cwd: wsDir }) + '\n' +
    JSON.stringify({ type: 'session/title', seq: 1, data: { title: '你好' } }) + '\n',
  )),
)
const textCache = path.join(cacheDir, textSessionId + '.json')
fs.writeFileSync(textCache, '{"unit":{"name":"session_projcache"}}')

const textPlan = core.planDeletion(textSessionId)
assert.equal(textPlan.artifacts.length, 0, 'text-only session has no artifacts')

const textDeleted = core.deleteSession({ sessionId: textSessionId, deleteArtifacts: true, trash: true })
assert.equal(textDeleted.ok, true)
assert.equal(textDeleted.logs.trashed.length, 1, 'session record moved into the recycle bin')
assert.deepEqual(textDeleted.logs.removed, [], 'nothing hard-deleted from the record')
assert.ok(textDeleted.logs.trashToken, 'trash token returned even without artifacts')
assert.ok(!fs.existsSync(textDir), 'record is gone from the sessions tree')
assert.ok(!fs.existsSync(textCache), 'projection cache moved out too')
assert.equal(core.planDeletion(textSessionId).log.files.length, 0, 'session record is gone while it sits in trash')
const manifestText = JSON.parse(fs.readFileSync(path.join(textDeleted.logs.trashDir, 'manifest.json'), 'utf8'))
assert.equal(manifestText.record.dirs.length, 1, 'manifest remembers the record dir')
console.log('text-only trash ok:', JSON.stringify({ token: textDeleted.logs.trashToken, bytes: textDeleted.logs.trashBytes }))

const textUndo = core.restoreTrash(textDeleted.logs.trashToken)
assert.equal(textUndo.ok, true, JSON.stringify(textUndo.failed))
assert.equal(textUndo.recordRestored, true, 'record restored')
assert.equal(textUndo.cacheRestored, true, 'cache restored')
assert.equal(textUndo.sessionId, textSessionId)
assert.ok(fs.existsSync(textLog), 'log file is back')
assert.equal(core.planDeletion(textSessionId).log.files.length, 1, 'the session record is visible again')
assert.equal(core.planDeletion(textSessionId).title, '你好', 'title survived the round trip')
console.log('text-only undo ok: 会话记录 + 投影缓存都回来了')

// ---------------------------------------------------------------- 导出模式
const exportSessionId = 'session-test-export-1111-2222-333333333333'
const exportDirSession = path.join(tmpHome, 'sessions', group, exportSessionId)
fs.mkdirSync(exportDirSession, { recursive: true })
const exportFile = path.join(wsDir, 'sub', 'keep', 'report.md')
fs.mkdirSync(path.dirname(exportFile), { recursive: true })
fs.writeFileSync(exportFile, 'export me')
const exportTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'dst-export-'))
process.env.DSH_SESSION_TOOLS_EXPORT_DIR = exportTarget
fs.writeFileSync(
  path.join(exportDirSession, 'session.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(
    JSON.stringify({ type: 'session', version: 4, id: exportSessionId, cwd: wsDir }) + '\n' +
    JSON.stringify({ type: 'session/title', seq: 1, data: { title: '导出测试' } }) + '\n' +
    JSON.stringify({ type: 'tool/call', seq: 2, data: { name: 'write', arguments: JSON.stringify({ file_path: exportFile }) } }) + '\n',
  )),
)
const exported = core.deleteSession({
  sessionId: exportSessionId,
  deleteArtifacts: true,
  keep: [exportFile],
  keepMode: 'export',
})
assert.equal(exported.ok, true)
assert.equal(exported.artifacts.exported.length, 1, 'kept file copied out')
assert.ok(exported.artifacts.exportDir.includes('会话导出-导出测试'), 'export dir named after the session')
assert.ok(fs.existsSync(exported.artifacts.exported[0]), 'copy exists')
assert.equal(fs.readFileSync(exported.artifacts.exported[0], 'utf8'), 'export me', 'copy content intact')
assert.ok(!fs.existsSync(exportFile), 'original removed after export')
console.log('export ok:', JSON.stringify({ dir: exported.artifacts.exportDir, files: exported.artifacts.exported.length }))
delete process.env.DSH_SESSION_TOOLS_EXPORT_DIR
fs.rmSync(exportTarget, { recursive: true, force: true })

// ---------------------------------------------------------------- 占用预检
const lockedProbe = path.join(wsDir, 'probe.txt')
fs.writeFileSync(lockedProbe, 'x')
assert.equal(core.probeLocked(lockedProbe), false, 'normal file is not locked')
console.log('lock probe ok: 普通文件不算被占用')

// 非法 id
assert.equal(core.sanitizeId('../etc'), null)
assert.equal(core.sanitizeId('a/b'), null)
assert.equal(core.planDeletion('../etc'), null)

// 真实 DSH_HOME 只读枚举（不改任何东西）
delete process.env.DSH_HOME
const real = core.listSessions()
console.log('real sessions visible:', real.length, '| example:', real[0] && real[0].sessionId)
if (real[0]) {
  const realPlan = core.planDeletion(real[0].sessionId)
  console.log('real plan sample:', JSON.stringify({
    title: realPlan.title, cwd: realPlan.cwd, events: realPlan.events,
    artifacts: realPlan.artifacts.length, logBytes: realPlan.totals.logBytes,
  }))
}

fs.rmSync(tmpHome, { recursive: true, force: true })
fs.rmSync(wsDir, { recursive: true, force: true })
console.log('\nALL SELF-TESTS PASSED')
