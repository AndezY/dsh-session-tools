/**
 * 路由层自测：伪造 cordis ctx，把 host 插件挂在真 HTTP server 上跑一遍。
 *
 * node test/route-test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dst-route-home-'))
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dst-route-ws-'))
process.env.DSH_HOME = tmpHome

const sessionId = 'session-route-aaaa-bbbb-cccc-dddddddddddd'
const sessionDir = path.join(tmpHome, 'sessions', '--tmp--', sessionId)
fs.mkdirSync(sessionDir, { recursive: true })
const target = path.join(wsDir, 'out', 'report.md')
const keepFile = path.join(wsDir, 'out', 'keep-me.md')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, 'x'.repeat(2048))
fs.writeFileSync(keepFile, 'y'.repeat(512))

const events = [
  { type: 'session', version: 4, id: sessionId, cwd: wsDir },
  { type: 'session/title', seq: 1, data: { title: '路由自测' } },
  { type: 'tool/call', seq: 2, data: { name: 'write', arguments: JSON.stringify({ file_path: target, content: 'x' }) } },
  { type: 'tool/call', seq: 3, data: { name: 'write', arguments: JSON.stringify({ file_path: keepFile, content: 'y' }) } },
]
fs.writeFileSync(
  path.join(sessionDir, 'session.v4.jsonl.zstd'),
  Buffer.concat(events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')))),
)

const plugin = await import('../lib/index.js')

// 会话"活在宿主里"的假象：sessions.get(id) 一直返回对象，模拟主面板/文档页占着它
const liveSessions = new Map()
const fakeAgent = {
  status: 'running',
  cancelled: 0,
  disposed: 0,
  cancel() { this.cancelled += 1 },
  dispose() { this.disposed += 1 },
}
const fakeSessions = {
  get: (id) => liveSessions.get(id),
  detach: (id) => { liveSessions.delete(id) },
}
let captured = null
const ctx = {
  effect: (fn) => fn(),
  get: (name) => (name === 'sessions' ? fakeSessions : name === 'agents' ? { get: () => fakeAgent } : undefined),
  webServer: {
    register: (spec, label) => {
      captured = { spec, label }
      return () => {}
    },
  },
}
plugin.apply(ctx)
assert.ok(captured, 'route registered')
assert.equal(captured.spec.path, '/session-tools/api')
assert.equal(captured.spec.kind, 'exact')
console.log('route registered:', captured.label)

const server = http.createServer((req, res) => captured.spec.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = 'http://127.0.0.1:' + port + '/session-tools/api'

const call = async (payload, init) => {
  const res = await fetch(url, Object.assign({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, init || {}))
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  return { status: res.status, data }
}

// ping
const ping = await call({ op: 'ping' })
assert.equal(ping.status, 200)
assert.equal(ping.data.ok, true)
console.log('ping ok, home =', ping.data.home)

// 405
const getRes = await fetch(url, { method: 'GET' })
assert.equal(getRes.status, 405)
console.log('GET rejected with 405')

// list
const list = await call({ op: 'list' })
assert.equal(list.status, 200)
assert.ok(list.data.sessions.some((row) => row.sessionId === sessionId))
console.log('list ok:', list.data.sessions.length, 'session(s)')

// plan
const plan = await call({ op: 'plan', sessionId })
assert.equal(plan.data.ok, true)
assert.equal(plan.data.plan.title, '路由自测')
assert.equal(plan.data.plan.artifacts.length, 2)
assert.equal(plan.data.plan.caps.keep, true, 'plan advertises the keep capability')
console.log('plan ok:', JSON.stringify(plan.data.plan.totals))

// preview：只认该会话自己的产物
const pv = await call({ op: 'preview', sessionId, path: keepFile })
assert.equal(pv.data.ok, true, JSON.stringify(pv.data))
assert.equal(pv.data.kind, 'text', 'text preview over HTTP')
assert.ok(String(pv.data.text).startsWith('yyy'), 'text body present')

const pvBad = await call({ op: 'preview', sessionId, path: 'C:/Windows/win.ini' })
assert.equal(pvBad.data.ok, false)
assert.equal(pvBad.data.error, 'not an artifact of this session')
console.log('preview ok: 自己的产物可预览，路径外的一律拒绝')

// open：同样只认 plan 里的路径（拒绝路径不会真的拉起程序）
const openBad = await call({ op: 'open', sessionId, path: 'C:/Windows/system32/cmd.exe' })
assert.equal(openBad.data.ok, false)
assert.equal(openBad.data.error, 'not an artifact of this session')
console.log('open ok: 越界路径被拒')
// list：registry 缺席时 registered 为 null（“不知道”），不能误判成已摘
const listRes = await call({ op: 'list' })
assert.equal(listRes.data.ok, true)
assert.ok(Array.isArray(listRes.data.sessions) && listRes.data.sessions.length > 0, 'sessions listed')
assert.ok(listRes.data.sessions.every((row) => row.registered === null || typeof row.registered === 'boolean'), 'registered flag present')
console.log('list ok: 带 registered 标记（无 registry 时为 null）')
// trash：列出批次（带体积 / 是否含会话记录），非法 token 一律拒绝
const trashList = await call({ op: 'trash' })
assert.equal(trashList.data.ok, true)
assert.ok(Array.isArray(trashList.data.entries), 'entries array')
assert.ok(typeof trashList.data.root === 'string' && trashList.data.root !== '', 'root reported')
assert.ok(trashList.data.totals && typeof trashList.data.totals.bytes === 'number', 'totals reported')

const purgeBad = await call({ op: 'purgeEntry', token: '../etc' })
assert.equal(purgeBad.data.ok, false)
const openBad2 = await call({ op: 'openTrash', token: '../etc' })
assert.equal(openBad2.data.ok, false)
console.log('trash ops ok: 列表带 totals，越界 token 被拒')
// purgeEntry：回收站里“彻底删除一批”要真能删掉（之前只测了非法 token）
const purgeSid = 'session-route-purge-9999-8888-777766665555'
const purgeSessionDir = path.join(tmpHome, 'sessions', '--tmp--', purgeSid)
fs.mkdirSync(purgeSessionDir, { recursive: true })
fs.writeFileSync(
  path.join(purgeSessionDir, 'session.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: purgeSid, cwd: wsDir }) + '\n', 'utf8')),
)
const trashed = await call({ op: 'delete', sessionId: purgeSid, deleteArtifacts: false, trash: true })
assert.equal(trashed.data.ok, true, JSON.stringify(trashed.data))
const token = trashed.data.logs && trashed.data.logs.trashToken
assert.ok(token, 'trash token issued')
const listedBefore = await call({ op: 'trash' })
assert.ok(listedBefore.data.entries.some((row) => row.token === token), 'batch listed')
const purged = await call({ op: 'purgeEntry', token })
assert.equal(purged.data.ok, true, JSON.stringify(purged.data))
assert.ok(purged.data.bytes >= 0, 'bytes reported')
const listedAfter = await call({ op: 'trash' })
assert.equal(listedAfter.data.entries.some((row) => row.token === token), false, 'batch gone from the listing')
console.log('purgeEntry ok: 一批从列表到磁盘都被清掉')

const caps = await call({ op: 'ping' })
assert.equal(caps.data.caps.purge, true, 'host advertises purge')
assert.equal(caps.data.caps.force, true, 'host advertises force')
console.log('caps ok: purge / force 都对外声明，界面才能按能力放按钮')
// restore 并发去重 + 幂等：连点两次不能变成"失败"
{
  const sid = 'session-route-twice-1357-2468-000011112222'
  const dir = path.join(tmpHome, 'sessions', '--tmp--', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: sid, cwd: wsDir }) + '\n')))
  const del = await call({ op: 'delete', sessionId: sid, deleteArtifacts: false, trash: true })
  const token = del.data.logs && del.data.logs.trashToken
  assert.ok(token, 'token issued')

  // 同时打两枪（用户连点就是这种形状）
  const [a, b] = await Promise.all([
    call({ op: 'restore', token }),
    call({ op: 'restore', token }),
  ])
  assert.equal(a.data.ok, true, 'first ok: ' + JSON.stringify(a.data.error || ''))
  assert.equal(b.data.ok, true, 'second ok: ' + JSON.stringify(b.data.error || ''))
  assert.ok(b.data.deduped === true || b.data.recordRestored === true || b.data.alreadyGone === true, 'second call deduped or already-restored')
  assert.ok(fs.existsSync(dir), 'record is back on disk')

  // 再来一次（顺序调用）：还是成功
  const again = await call({ op: 'restore', token })
  assert.equal(again.data.ok, true, 'third call stays idempotent: ' + JSON.stringify(again.data.error || ''))
  console.log('restore ok: 并发/重复调用都不再报失败')
}

// force：会话还挂在宿主里 → 普通删除报 still-live，强制删除照删不误
const forceSessionId = 'session-route-force-1111-2222-333333333333'
const forceDir = path.join(tmpHome, 'sessions', '--tmp--', forceSessionId)
fs.mkdirSync(forceDir, { recursive: true })
fs.writeFileSync(
  path.join(forceDir, 'session.v4.jsonl.zstd'),
  zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: forceSessionId, cwd: wsDir }) + '\n', 'utf8')),
)
liveSessions.set(forceSessionId, { id: forceSessionId })
const stillLive = await call({ op: 'delete', sessionId: forceSessionId, deleteArtifacts: false })
assert.equal(stillLive.data.ok, false, 'plain delete refuses a live session')
assert.equal(stillLive.data.code, 'still-live', 'still-live is reported to the client')
assert.ok(fs.existsSync(forceDir), 'files untouched when the session is still live')

const forced = await call({ op: 'delete', sessionId: forceSessionId, deleteArtifacts: false, force: true, trash: true })
assert.equal(forced.data.ok, true, JSON.stringify(forced.data))
assert.equal(forced.data.forced, true, 'forced flag reported')
assert.ok(forced.data.stop && forced.data.stop.cancelled === true, 'running turn cancelled first')
assert.ok(forced.data.hardStop && Array.isArray(forced.data.hardStop.attempts), 'hard stop attempts recorded')
assert.ok(!fs.existsSync(forceDir), 'session directory gone despite being live')
console.log('force delete ok: still-live 被拦、force 照删、硬拆有记录')
// 未知 op
const bogus = await call({ op: 'nope' })
assert.equal(bogus.data.ok, false)
console.log('unknown op rejected:', bogus.data.error)

// 非法 id
const bad = await call({ op: 'plan', sessionId: '../etc' })
assert.equal(bad.data.ok, false)
console.log('bad id rejected:', bad.data.error)

// delete（这个假 ctx 没有 workspaceRegistry / sessions / emit：删除必须照旧可用）
// keep 里点名的那一个要留下来，其余照删。
const del = await call({ op: 'delete', sessionId, deleteArtifacts: true, keep: [keepFile] })
assert.equal(del.data.ok, true, JSON.stringify(del.data))
assert.equal(del.data.accounting.available, false, 'no registry in this ctx')
assert.equal(del.data.released, true, 'not live, nothing to wait for')
assert.deepEqual(del.data.artifacts.kept, [keepFile], 'named file kept')
assert.ok(!fs.existsSync(target), 'unticked artifact removed')
assert.ok(fs.existsSync(keepFile), 'ticked artifact survives')
assert.ok(!fs.existsSync(sessionDir), 'session dir removed')
assert.equal(del.data.artifacts.keptBytes, 512, 'kept bytes reported')
console.log('delete ok:', JSON.stringify({
  logs: del.data.logs.removed.length,
  artifacts: del.data.artifacts.removed.length,
}))

// sweep：没有注册表时是个安全空转
const sweep = await call({ op: 'sweep' })
assert.equal(sweep.data.ok, true)
assert.equal(sweep.data.sweep.available, false)
console.log('sweep no-op without a registry')

// 越权 Origin（非回环 socket 不好造，至少验证同源通过）
const originOk = await call({ op: 'ping' }, { headers: { 'content-type': 'application/json', origin: url.replace('/session-tools/api', '') } })
assert.equal(originOk.status, 200)
console.log('same-origin accepted')

// ---------------------------------------------------------------- 带注册表的 ctx
// 确认 delete 会：摘掉工作区成员 → 删文件 → 广播 api-session/removed
const sessionId2 = 'session-route-eeee-ffff-0000-111111111111'
const sessionDir2 = path.join(tmpHome, 'sessions', '--tmp--', sessionId2)
fs.mkdirSync(sessionDir2, { recursive: true })
fs.writeFileSync(
  path.join(sessionDir2, 'session.v4.jsonl.zstd'),
  Buffer.concat([{ type: 'session', version: 4, id: sessionId2, cwd: wsDir }].map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')))),
)

const detached = []
const emitted = []
const registryStub = {
  archivedSessionIds: [],
  pinnedSessionIds: [],
  list: () => [{
    id: 'ws-registry',
    path: wsDir,
    sessionIds: [sessionId2],
    detachSession: async (id) => { detached.push(id) },
  }],
  sessionKnown: async () => false,
  unarchiveSession: async () => {},
  unpinSession: async () => {},
}
let captured2 = null
const ctx2 = {
  effect: (fn) => fn(),
  webServer: { register: (spec, label) => { captured2 = { spec, label }; return () => {} } },
  get: (name) => {
    if (name === 'workspaceRegistry') return registryStub
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    return undefined
  },
  parallel: async () => {},
  emit: (event, payload) => emitted.push([event, payload]),
}
plugin.apply(ctx2)
assert.ok(captured2, 'second route registered')
const server2 = http.createServer((req, res) => captured2.spec.handler(req, res))
await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
const url2 = 'http://127.0.0.1:' + server2.address().port + '/session-tools/api'
const call2 = async (payload) => {
  const res = await fetch(url2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  return JSON.parse(await res.text())
}

const ping2 = await call2({ op: 'ping' })
assert.equal(ping2.registry, true, 'ping reports the registry')

const del2 = await call2({ op: 'delete', sessionId: sessionId2, deleteArtifacts: false })
assert.equal(del2.ok, true, JSON.stringify(del2))
assert.equal(del2.accounting.available, true)
assert.deepEqual(del2.accounting.detached, ['ws-registry'])
assert.deepEqual(detached, [sessionId2], 'workspace accounting purged')
assert.ok(!fs.existsSync(sessionDir2), 'session dir removed with a registry present')
assert.deepEqual(emitted, [['api-session/removed', sessionId2]], 'client removal broadcast')
console.log('delete with registry ok: accounting purged + api-session/removed emitted')
server2.close()

server.close()
fs.rmSync(tmpHome, { recursive: true, force: true })
fs.rmSync(wsDir, { recursive: true, force: true })
console.log('\nROUTE SELF-TESTS PASSED')
