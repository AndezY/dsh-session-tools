/**
 * dsh-session-tools / core —— 纯 Node 侧实现（零外部依赖）。
 *
 * 职责：
 *   · 定位 DSH_HOME 下的会话日志、投影缓存；
 *   · 解压 session.vND.jsonl.zstd（多 zstd frame 拼接）并解析事件；
 *   · 从事件里推出该会话生成的文件（present 交付物 + 文件工具写入）；
 *   · 计划（plan）与执行（delete）删除，全部路径先校验再落盘。
 *
 * 这里不依赖 cordis，脚本可以直接 import 做离线验证。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

/** 会话日志文件名：session.v4.jsonl.zstd / session.v5.jsonl … */
const LOG_NAME_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 文件工具名 → 参数里的路径字段。 */
const PATH_TOOLS = {
  write: ['file_path'],
  edit: ['file_path'],
  'str-replace-editor': ['path', 'file_path'],
  str_replace_editor: ['path', 'file_path'],
  fs: ['path', 'file_path'],
}

// ---------------------------------------------------------------- 路径

/** DSH_HOME（host 进程环境变量优先，退回 ~/.dsh）。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

export function projCacheRoot() {
  return path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

/** 回收站根：`<DSH_HOME>/trash/<时间戳>-<sessionId>/`。 */
export function trashRoot() {
  return path.join(dshHome(), 'trash')
}

/** 默认回收站保留天数。 */
export const TRASH_KEEP_DAYS = 7

/**
 * 猜一个文件是不是被别的程序独占（Windows 上 Office / 预览窗格常见）。
 *
 * 判定顺序：只读文件不算被占用（它本来就写不了）；能写但 `r+` 打不开，
 * 基本就是共享冲突（EBUSY/EPERM/EACCES）——这种文件 rm 会失败。
 * @param {string} file
 * @returns {boolean}
 */
export function probeLocked(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK)
  } catch {
    return false
  }
  let fd = null
  try {
    fd = fs.openSync(file, 'r+')
    return false
  } catch (error) {
    const code = error && error.code
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** target 是否落在 root 之内（Windows 大小写不敏感）。 */
export function withinRoot(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string') return false
  const t = path.resolve(target).toLowerCase().replace(/[\\/]+$/, '')
  const r = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '')
  if (t === r) return false // 目标等于根目录本身：绝不删
  return t.startsWith(r + path.sep) || t.startsWith(r + '/')
}

export function isAbsoluteLike(p) {
  return typeof p === 'string' && (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p))
}

/** 相对路径按会话 cwd 展开。 */
export function resolveAgainst(p, cwd) {
  if (typeof p !== 'string' || p.trim() === '') return null
  const raw = p.trim().replace(/^"|"$/g, '')
  if (isAbsoluteLike(raw)) return path.normalize(raw)
  if (typeof cwd === 'string' && cwd !== '') return path.normalize(path.join(cwd, raw))
  return null
}

/** 产物是否允许删除：在 cwd 内，或在用户主目录内；永不落在 DSH_HOME 里。 */
export function artifactDeletable(target, cwd) {
  if (typeof target !== 'string' || target === '') return false
  if (withinRoot(target, dshHome()) || path.resolve(target).toLowerCase() === path.resolve(dshHome()).toLowerCase()) return false
  const roots = []
  if (typeof cwd === 'string' && cwd !== '') roots.push(cwd)
  roots.push(os.homedir())
  return roots.some((root) => {
    const t = path.resolve(target).toLowerCase()
    const r = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '')
    return t === r ? false : t.startsWith(r + path.sep) || t.startsWith(r + '/')
  })
}

// ---------------------------------------------------------------- 日志解码

function frameAt(buf, start, end) {
  try {
    return zlib.zstdDecompressSync(buf.subarray(start, end))
  } catch {
    return null
  }
}

/**
 * 读出会话日志文本。
 *
 * 磁盘格式是多个 zstd frame 首尾相接（每次 append 落一个 frame），
 * 单次 zstdDecompressSync 只吐第一帧，所以按 magic 切分后逐帧解压；
 * 切分点若落在压缩载荷内部（伪 magic），该切片会解压失败，此时用
 * “切到文件尾”（zstd 解码器只吃一帧）重试，保证不丢帧。
 */
export function readLogText(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return ''
  }
  if (!/\.zstd$/i.test(file)) return buf.toString('utf8')

  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i)
    }
  }
  if (starts.length === 0) return buf.toString('utf8')

  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]
    const next = k + 1 < starts.length ? starts[k + 1] : buf.length
    const out = frameAt(buf, start, next) || frameAt(buf, start, buf.length)
    if (out) parts.push(out)
  }
  if (parts.length === 0) return ''
  return Buffer.concat(parts).toString('utf8')
}

/** 解析事件数组；尾部半行（进程被杀时可能出现）忽略。 */
export function readEvents(file) {
  const text = readLogText(file)
  const events = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      events.push(JSON.parse(t))
    } catch {
      /* torn line */
    }
  }
  return events
}

// ---------------------------------------------------------------- 会话枚举

function safeStat(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/**
 * 列出磁盘上所有会话。
 * @returns {Array<{sessionId:string,workspaceKey:string,dir:string,logFile:string|null,bytes:number,mtimeMs:number}>}
 */
export function listSessions() {
  const root = sessionsRoot()
  const rows = []
  let groups = []
  try {
    groups = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return rows
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(root, group.name)
    let children = []
    try {
      children = fs.readdirSync(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const dir = path.join(groupDir, child.name)
      const row = describeSessionDir(dir, group.name, child.name)
      if (row) rows.push(row)
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return rows
}

function describeSessionDir(dir, workspaceKey, sessionId) {
  const stat = safeStat(dir)
  if (!stat || !stat.isDirectory()) return null
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  let logFile = null
  let bytes = 0
  for (const name of names) {
    if (!LOG_NAME_RE.test(name)) continue
    const full = path.join(dir, name)
    const st = safeStat(full)
    if (!st || !st.isFile()) continue
    bytes += st.size
    if (logFile === null) logFile = full
  }
  return { sessionId, workspaceKey, dir, logFile, bytes, mtimeMs: stat.mtimeMs }
}

/** 一个会话在磁盘上的全部落点。 */
export function sessionRecord(sessionId) {
  const safeId = sanitizeId(sessionId)
  if (safeId === null) return null
  const sessions = listSessions().filter((row) => row.sessionId === safeId)
  const cacheFile = path.join(projCacheRoot(), safeId + '.json')
  const cacheStat = safeStat(cacheFile)
  return {
    sessionId: safeId,
    dirs: sessions.map((row) => row.dir),
    logFiles: sessions.map((row) => row.logFile).filter(Boolean),
    logBytes: sessions.reduce((sum, row) => sum + row.bytes, 0),
    cache: cacheStat && cacheStat.isFile() ? { path: cacheFile, bytes: cacheStat.size } : null,
  }
}

/** 只接受 session-xxx 形态的 id，挡住路径穿越。 */
export function sanitizeId(sessionId) {
  if (typeof sessionId !== 'string') return null
  const id = sessionId.trim()
  if (id === '' || id.length > 200) return null
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(id)) return null
  if (id === '.' || id === '..') return null
  return id
}

// ---------------------------------------------------------------- 产物

function parseArgs(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 从会话事件推出 cwd 与产物清单。
 * 来源：deliverables/presented 事件 + write/edit/str_replace_editor/present 工具调用参数。
 */
export function collectArtifacts(events) {
  let cwd = ''
  const born = new Map() // lower-path -> { path, sources:Set<string> }

  const add = (rawPath, source) => {
    const resolved = resolveAgainst(rawPath, cwd)
    if (!resolved) return
    const key = resolved.toLowerCase()
    const hit = born.get(key)
    if (hit) {
      hit.sources.add(source)
      return
    }
    born.set(key, { path: resolved, sources: new Set([source]) })
  }

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (typeof ev.cwd === 'string' && ev.cwd !== '' && cwd === '') cwd = ev.cwd
    if (ev.type === 'deliverables/presented') {
      const files = ev.data && Array.isArray(ev.data.files) ? ev.data.files : []
      for (const item of files) add(item && item.path ? item.path : item, 'presented')
      continue
    }
    if (ev.type !== 'tool/call') continue
    const name = ev.data && ev.data.name
    const args = parseArgs(ev.data && ev.data.arguments)
    if (!args) continue
    if (name === 'present' && Array.isArray(args.files)) {
      for (const item of args.files) add(item && item.path ? item.path : item, 'presented')
      continue
    }
    const fields = PATH_TOOLS[name]
    if (!fields) continue
    for (const field of fields) {
      if (typeof args[field] === 'string') {
        add(args[field], name === 'str_replace_editor' || name === 'str-replace-editor' ? 'edit' : name)
        break
      }
    }
  }

  const list = []
  for (const item of born.values()) {
    const st = safeStat(item.path)
    list.push({
      path: item.path,
      sources: [...item.sources],
      exists: Boolean(st && st.isFile()),
      bytes: st && st.isFile() ? st.size : 0,
      deletable: artifactDeletable(item.path, cwd),
    })
  }
  list.sort((a, b) => a.path.localeCompare(b.path))
  return { cwd, artifacts: list }
}

// ---------------------------------------------------------------- 计划

/**
 * 只读计划：会话记录 + 生成文件。
 * @param {string} sessionId
 * @returns {object|null}
 */
export function planDeletion(sessionId) {
  const record = sessionRecord(sessionId)
  if (!record) return null
  let events = []
  let cwd = ''
  let title = ''
  for (const file of record.logFiles) {
    const parsed = readEvents(file)
    if (parsed.length === 0) continue
    events = events.concat(parsed)
    for (const ev of parsed) {
      if (typeof ev.cwd === 'string' && ev.cwd !== '' && cwd === '') cwd = ev.cwd
      if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && title === '') title = ev.data.title
    }
  }
  const collected = collectArtifacts(events)
  if (cwd === '') cwd = collected.cwd
  const existing = collected.artifacts.filter((item) => item.exists)
  const kept = existing.filter((item) => item.deletable)
  const skipped = existing.filter((item) => !item.deletable)
  const skipReason = (target) => (withinRoot(target, dshHome()) ? 'inside-dsh-home' : 'outside-scope')
  return {
    sessionId: record.sessionId,
    title,
    cwd,
    events: events.length,
    log: { files: record.logFiles.map((file) => ({ path: file, bytes: safeStat(file)?.size ?? 0 })), bytes: record.logBytes },
    cache: record.cache,
    dirs: record.dirs,
    artifacts: kept.map((item) => ({
      path: item.path,
      bytes: item.bytes,
      sources: item.sources,
      // 被别的程序独占的文件，rm 会失败；客户端据此提前提示并默认保留。
      locked: probeLocked(item.path),
    })),
    skipped: skipped.map((item) => ({ path: item.path, reason: skipReason(item.path) })),
    totals: {
      artifactFiles: kept.length,
      artifactBytes: kept.reduce((sum, item) => sum + item.bytes, 0),
      logBytes: record.logBytes,
      cacheBytes: record.cache ? record.cache.bytes : 0,
    },
  }
}

// ---------------------------------------------------------------- 删除

/**
 * 把客户端传来的“要保留的路径”收敛成一个可比较的集合。
 *
 * 只做减法：集合里的路径只会让某个产物被跳过，永远不会让某个路径进入删除名单
 * （删除名单始终来自 host 侧重算出来的 plan），所以伪造 keep 不能越权。
 * @param {unknown} raw
 * @returns {Set<string>} 小写化、已解析的绝对路径集合
 */
export function keepSet(raw) {
  const set = new Set()
  if (!Array.isArray(raw)) return set
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    try {
      set.add(path.resolve(text).toLowerCase())
    } catch {
      /* 坏路径直接忽略 */
    }
  }
  return set
}

/** 把会话标题压成安全的目录名。 */
function safeSegment(text, fallback) {
  const raw = typeof text === 'string' ? text.trim() : ''
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim()
  return cleaned === '' ? fallback : cleaned
}

function uniquePath(target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(dir, base + ' (' + String(i) + ')' + ext)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, base + '-' + String(Date.now()) + ext)
}

/** 桌面目录：Windows 优先 `~/Desktop`，没有就退回主目录。 */
export function desktopRoot() {
  const desk = path.join(os.homedir(), 'Desktop')
  try {
    if (fs.statSync(desk).isDirectory()) return desk
  } catch {
    /* 没有桌面目录（被重定向/精简系统）就用主目录 */
  }
  return os.homedir()
}

/**
 * 导出目录的父目录：默认桌面，`DSH_SESSION_TOOLS_EXPORT_DIR` 可以覆盖
 * （测试和"桌面被重定向"的机器都靠它）。
 */
export function exportRoot() {
  const env = process.env.DSH_SESSION_TOOLS_EXPORT_DIR
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim())
  return desktopRoot()
}

/**
 * 把“要保留”的文件复制到导出目录，保留原有的 cwd 内相对结构。
 * @returns {{dir:string, files:Array<{from:string,to:string,bytes:number}>, failed:object[]}}
 */
function exportFiles(files, plan, title) {
  const stamp = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const suffix = String(stamp.getFullYear()) + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds())
  const base = path.join(exportRoot(), '会话导出-' + safeSegment(title, plan.sessionId))
  let dir = base
  if (fs.existsSync(dir)) dir = base + '-' + suffix
  const out = { dir, files: [], failed: [] }
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) {
    try {
      let rel = path.basename(file.path)
      if (typeof plan.cwd === 'string' && plan.cwd !== '') {
        const candidate = path.relative(plan.cwd, file.path)
        if (candidate !== '' && !candidate.startsWith('..') && !path.isAbsolute(candidate)) rel = candidate
      }
      const target = uniquePath(path.join(dir, rel))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(file.path, target)
      out.files.push({ from: file.path, to: target, bytes: Number(file.bytes) || 0 })
    } catch (error) {
      out.failed.push({ path: file.path, error: String(error && error.message ? error.message : error) })
    }
  }
  return out
}

/**
 * 开一个回收站批次：`<DSH_HOME>/trash/<时间戳>-<sessionId>/`。
 *
 * 产物放 `files/`，会话记录（日志目录 + 投影缓存）放 `session/`，两者同一个批次，
 * 这样一次「撤销」能把文件和会话记录一起搬回去——纯文字会话没有产物，靠的就是后者。
 * @returns {{token:string, dir:string, filesDir:string, sessionDir:string,
 *   files:Array<{original:string,trashed:string,bytes:number}>,
 *   record:{dirs:Array<{from:string,to:string}>, cache:{from:string,to:string}|null}}}
 */
function openTrashBatch(plan) {
  const stamp = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const token = String(stamp.getFullYear()) + pad(stamp.getMonth() + 1) + pad(stamp.getDate())
    + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds())
    + '-' + plan.sessionId
  const dir = path.join(trashRoot(), token)
  const filesDir = path.join(dir, 'files')
  const sessionDir = path.join(dir, 'session')
  fs.mkdirSync(filesDir, { recursive: true })
  return { token, dir, filesDir, sessionDir, files: [], record: { dirs: [], cache: null } }
}

/** 把一个文件搬进批次（`rename` 优先，跨盘退回复制+删）。 */
function moveFileIntoBatch(batch, file, plan) {
  let rel = path.basename(file.path)
  if (plan && typeof plan.cwd === 'string' && plan.cwd !== '') {
    const candidate = path.relative(plan.cwd, file.path)
    if (candidate !== '' && !candidate.startsWith('..') && !path.isAbsolute(candidate)) rel = candidate
  }
  const target = uniquePath(path.join(batch.filesDir, rel))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.renameSync(file.path, target)
  } catch {
    fs.copyFileSync(file.path, target)
    fs.rmSync(file.path, { force: true })
  }
  return target
}

/** 批量搬产物；单条失败不拖累其余。 */
function moveFilesIntoBatch(batch, files, plan) {
  const out = { files: [], failed: [] }
  for (const file of files) {
    try {
      const target = moveFileIntoBatch(batch, file, plan)
      const row = { original: file.path, trashed: target, bytes: Number(file.bytes) || 0 }
      out.files.push(row)
      batch.files.push(row)
    } catch (error) {
      out.failed.push({ path: file.path, error: String(error && error.message ? error.message : error) })
    }
  }
  return out
}

/** 搬一个单文件（投影缓存用），失败返回 null 让调用方回退成真删。 */
function moveFileIntoBatchSingle(batch, file) {
  try {
    const target = uniquePath(path.join(batch.sessionDir, 'cache', path.basename(file)))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(file, target)
    return target
  } catch {
    try {
      const target = uniquePath(path.join(batch.sessionDir, 'cache', path.basename(file)))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(file, target)
      fs.rmSync(file, { force: true })
      return target
    } catch {
      return null
    }
  }
}

/** 把一个会话日志目录搬进批次，保留 `<workspaceKey>/<sessionId>` 结构。 */
function moveRecordDirIntoBatch(batch, dir) {
  try {
    const rel = path.relative(sessionsRoot(), dir)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    const target = path.join(batch.sessionDir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(dir, target)
    return target
  } catch {
    return null
  }
}

/** 写 manifest：撤销就靠它。 */
function writeTrashManifest(batch, plan) {
  const manifest = {
    unit: { name: 'dsh-session-tools-trash', version: 2 },
    sessionId: plan.sessionId,
    title: plan.title,
    cwd: plan.cwd,
    createdAt: new Date().toISOString(),
    files: batch.files,
    record: { dirs: batch.record.dirs, cache: batch.record.cache },
  }
  try {
    fs.writeFileSync(path.join(batch.dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  } catch {
    /* manifest 写失败不影响文件已经在回收站里这件事，只是不能自动还原 */
  }
}

/**
 * 执行删除：产物 → 投影缓存 → 会话日志目录。
 * 路径全部在 host 侧重算并校验，客户端只传 sessionId、开关、“保留清单”和处理方式。
 *
 * @param {{sessionId:string, deleteArtifacts?:boolean, keep?:string[],
 *   keepMode?:'stay'|'export', trash?:boolean}} input
 */
export function deleteSession(input) {
  const sessionId = sanitizeId(input && input.sessionId)
  if (!sessionId) return { ok: false, error: 'invalid session id' }
  const plan = planDeletion(sessionId)
  if (!plan) return { ok: false, error: 'invalid session id' }
  const keep = keepSet(input && input.keep)
  const useTrash = Boolean(input && input.trash)
  const exportMode = Boolean(input && input.keepMode === 'export')

  const result = {
    ok: true,
    sessionId,
    artifacts: {
      removed: [], kept: [], exported: [], trashed: [], failed: [],
      bytes: 0, keptBytes: 0, exportedBytes: 0, trashedBytes: 0,
      exportDir: null, trashDir: null, trashToken: null,
    },
    cache: null,
    // trashed：会话记录（日志目录 / 投影缓存）被搬进回收站而不是删掉
    logs: { removed: [], trashed: [], failed: [], bytes: 0, trashBytes: 0 },
    skipped: plan.skipped,
  }

  // 回收站批次：产物和会话记录共用同一个目录，撤销时才能一起还原。
  const batch = useTrash ? openTrashBatch(plan) : null
  if (batch) {
    result.artifacts.trashDir = batch.dir
    result.artifacts.trashToken = batch.token
    result.logs.trashDir = batch.dir
    result.logs.trashToken = batch.token
  }

  if (input && input.deleteArtifacts) {
    const keptFiles = []
    const doomed = []
    for (const item of plan.artifacts) {
      if (!artifactDeletable(item.path, plan.cwd)) continue
      if (keep.size > 0 && keep.has(path.resolve(item.path).toLowerCase())) keptFiles.push(item)
      else doomed.push(item)
    }

    // 保留：原地不动，或先复制到桌面导出目录（复制成功才删原文件）
    if (keptFiles.length > 0 && exportMode) {
      const out = exportFiles(keptFiles, plan, plan.title)
      result.artifacts.exportDir = out.dir
      for (const row of out.files) {
        result.artifacts.exported.push(row.to)
        result.artifacts.exportedBytes += row.bytes
        result.artifacts.kept.push(row.from)
        result.artifacts.keptBytes += row.bytes
        try {
          fs.rmSync(row.from, { force: true })
          result.artifacts.removed.push(row.from)
          result.artifacts.bytes += row.bytes
          pruneEmptyParents(row.from, plan.cwd)
        } catch (error) {
          result.artifacts.failed.push({ path: row.from, error: String(error && error.message ? error.message : error) })
        }
      }
      for (const row of out.failed) result.artifacts.failed.push(row)
    } else {
      for (const item of keptFiles) {
        result.artifacts.kept.push(item.path)
        result.artifacts.keptBytes += Number(item.bytes) || 0
      }
    }

    if (doomed.length > 0 && batch) {
      const moved = moveFilesIntoBatch(batch, doomed, plan)
      for (const row of moved.files) {
        result.artifacts.trashed.push(row.original)
        result.artifacts.trashedBytes += row.bytes
        pruneEmptyParents(row.original, plan.cwd)
      }
      for (const row of moved.failed) result.artifacts.failed.push(row)
    } else {
      for (const item of doomed) {
        try {
          const st = safeStat(item.path)
          if (!st || !st.isFile()) continue
          fs.rmSync(item.path, { force: true })
          result.artifacts.removed.push(item.path)
          result.artifacts.bytes += st.size
          pruneEmptyParents(item.path, plan.cwd)
        } catch (error) {
          result.artifacts.failed.push({ path: item.path, error: String(error && error.message ? error.message : error) })
        }
      }
    }
  }

  if (plan.cache) {
    if (batch) {
      const moved = moveFileIntoBatchSingle(batch, plan.cache.path)
      if (moved) {
        result.cache = { path: plan.cache.path, bytes: plan.cache.bytes, removed: true, trashed: true }
        batch.record.cache = { from: plan.cache.path, to: moved }
        result.logs.trashBytes += Number(plan.cache.bytes) || 0
      } else {
        try {
          if (fs.existsSync(plan.cache.path)) fs.rmSync(plan.cache.path, { force: true })
          result.cache = { path: plan.cache.path, bytes: plan.cache.bytes, removed: true }
        } catch (error) {
          result.cache = { path: plan.cache.path, removed: false, error: String(error && error.message ? error.message : error) }
        }
      }
    } else {
      try {
        if (fs.existsSync(plan.cache.path)) fs.rmSync(plan.cache.path, { force: true })
        result.cache = { path: plan.cache.path, bytes: plan.cache.bytes, removed: true }
      } catch (error) {
        result.cache = { path: plan.cache.path, removed: false, error: String(error && error.message ? error.message : error) }
      }
    }
  }

  for (const dir of plan.dirs) {
    if (!withinRoot(dir, sessionsRoot())) continue
    const st = safeStat(dir)
    if (!st || !st.isDirectory()) continue
    let bytes = 0
    try {
      bytes = plan.log.files.filter((file) => file.path.toLowerCase().startsWith(dir.toLowerCase())).reduce((sum, file) => sum + file.bytes, 0)
    } catch {
      bytes = 0
    }

    if (batch) {
      const target = moveRecordDirIntoBatch(batch, dir)
      if (target) {
        batch.record.dirs.push({ from: dir, to: target })
        result.logs.trashed.push(dir)
        result.logs.trashBytes += bytes
        pruneEmptyParents(dir, sessionsRoot())
        continue
      }
      result.logs.failed.push({ path: dir, error: 'could not move the session record into the recycle bin' })
      continue
    }

    try {
      fs.rmSync(dir, { recursive: true, force: true })
      result.logs.removed.push(dir)
      result.logs.bytes += bytes
      pruneEmptyParents(dir, sessionsRoot())
    } catch (error) {
      result.logs.failed.push({ path: dir, error: String(error && error.message ? error.message : error) })
    }
  }

  if (batch) {
    writeTrashManifest(batch, plan)
    // 一个文件都没搬进去（既无产物也无日志）：别留空壳目录
    if (batch.record.dirs.length === 0 && batch.record.cache === null && batch.files.length === 0) {
      try { fs.rmSync(batch.dir, { recursive: true, force: true }) } catch { /* ignore */ }
      result.artifacts.trashDir = null
      result.artifacts.trashToken = null
      result.logs.trashDir = null
      result.logs.trashToken = null
    }
  }

  result.ok = result.logs.failed.length === 0
  return result
}

// ---------------------------------------------------------------- 回收站

/** 校验一个回收站 token，返回目录；不合法返回 null。 */
function resolveTrashDir(token) {
  if (typeof token !== 'string') return null
  const text = token.trim()
  if (text === '' || text.length > 200) return null
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(text)) return null
  if (text === '.' || text === '..') return null
  const dir = path.join(trashRoot(), text)
  if (!withinRoot(dir, trashRoot())) return null
  return dir
}

/** 递归量一个目录占多少字节（失败就当 0）。 */
function dirBytes(target) {
  let total = 0
  let entries = []
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) total += dirBytes(full)
    else total += safeStat(full)?.size ?? 0
  }
  return total
}

/** 列出回收站里的批次（新的在前），带体积和"是否含会话记录"。 */
export function listTrash() {
  const root = trashRoot()
  const rows = []
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return rows
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const st = safeStat(dir)
    let manifest = null
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    } catch {
      manifest = null
    }
    const record = manifest && manifest.record && typeof manifest.record === 'object' ? manifest.record : null
    const recordDirs = record && Array.isArray(record.dirs) ? record.dirs.length : 0
    rows.push({
      token: entry.name,
      dir,
      createdAt: manifest && manifest.createdAt ? manifest.createdAt : (st ? new Date(st.mtimeMs).toISOString() : ''),
      mtimeMs: st ? st.mtimeMs : 0,
      sessionId: manifest && manifest.sessionId ? manifest.sessionId : '',
      title: manifest && manifest.title ? manifest.title : '',
      files: manifest && Array.isArray(manifest.files) ? manifest.files.length : 0,
      bytes: dirBytes(dir),
      // 有没有把会话记录（日志目录 / 投影缓存）也搬进来
      hasRecord: recordDirs > 0,
      hasCache: Boolean(record && record.cache),
    })
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return rows
}

/**
 * 彻底删掉回收站里的某一批（用户主动"清空这一批"时用）。
 * @param {string} token
 * @returns {{ok:boolean, token?:string, bytes?:number, error?:string}}
 */
export function purgeTrashEntry(token) {
  const dir = resolveTrashDir(token)
  if (!dir) return { ok: false, error: 'invalid trash token' }
  const st = safeStat(dir)
  if (!st || !st.isDirectory()) return { ok: false, error: 'trash entry not found' }
  const bytes = dirBytes(dir)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true, token: String(token).trim(), bytes }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/**
 * 从回收站还原一批产物，**以及**（如果当时连会话记录一起搬进来了）会话日志目录与投影缓存。
 *
 * 文件目标位置已存在时改成 `名字 (2).ext`，不覆盖任何东西；会话记录目录不这么做——
 * 同名目录存在就跳过并记为 conflict，因为合并两份 session 日志没有意义。
 * @param {string} token 回收站批次
 * @returns {{ok:boolean, token:string, restored:string[], conflicts:object[], failed:object[],
 *   sessionId:string|null, cwd:string, recordRestored:boolean, cacheRestored:boolean}}
 */
export function restoreTrash(token) {
  const dir = resolveTrashDir(token)
  if (!dir) return { ok: false, error: 'invalid trash token' }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return { ok: false, error: 'trash manifest is missing or unreadable' }
  }
  const files = manifest && Array.isArray(manifest.files) ? manifest.files : []
  const cwd = typeof manifest.cwd === 'string' ? manifest.cwd : ''
  const record = manifest && manifest.record && typeof manifest.record === 'object' ? manifest.record : null
  const recordDirs = record && Array.isArray(record.dirs) ? record.dirs : []
  const recordCache = record && record.cache && typeof record.cache === 'object' ? record.cache : null
  const sessionId = manifest && typeof manifest.sessionId === 'string' && manifest.sessionId !== '' ? manifest.sessionId : null

  const result = {
    ok: true,
    token,
    restored: [],
    conflicts: [],
    failed: [],
    sessionId,
    cwd,
    recordRestored: false,
    cacheRestored: false,
  }

  // 1) 会话记录：按原路径搬回去（必须先于文件，避免文件父目录先被建出来）
  for (const row of recordDirs) {
    const from = row && typeof row.from === 'string' ? row.from : ''
    const to = row && typeof row.to === 'string' ? row.to : ''
    if (from === '' || to === '') continue
    if (!withinRoot(from, sessionsRoot())) {
      result.failed.push({ path: from, error: 'outside-scope' })
      continue
    }
    if (!fs.existsSync(to)) {
      result.failed.push({ path: from, error: 'trash copy is gone' })
      continue
    }
    if (fs.existsSync(from)) {
      result.conflicts.push({ path: from, restoredAs: null, reason: 'session record already exists' })
      continue
    }
    try {
      fs.mkdirSync(path.dirname(from), { recursive: true })
      fs.renameSync(to, from)
      result.recordRestored = true
    } catch (error) {
      result.failed.push({ path: from, error: String(error && error.message ? error.message : error) })
    }
  }

  if (recordCache) {
    const from = typeof recordCache.from === 'string' ? recordCache.from : ''
    const to = typeof recordCache.to === 'string' ? recordCache.to : ''
    if (from !== '' && to !== '' && fs.existsSync(to)) {
      try {
        fs.mkdirSync(path.dirname(from), { recursive: true })
        const target = fs.existsSync(from) ? uniquePath(from) : from
        fs.renameSync(to, target)
        result.cacheRestored = true
      } catch (error) {
        result.failed.push({ path: from, error: String(error && error.message ? error.message : error) })
      }
    }
  }

  // 2) 产物文件
  for (const row of files) {
    const original = row && typeof row.original === 'string' ? row.original : ''
    const trashed = row && typeof row.trashed === 'string' ? row.trashed : ''
    if (original === '' || trashed === '') continue
    if (!artifactDeletable(original, cwd)) {
      result.failed.push({ path: original, error: 'outside-scope' })
      continue
    }
    if (!fs.existsSync(trashed)) {
      result.failed.push({ path: original, error: 'trash copy is gone' })
      continue
    }
    try {
      fs.mkdirSync(path.dirname(original), { recursive: true })
      let target = original
      if (fs.existsSync(target)) {
        target = uniquePath(target)
        result.conflicts.push({ path: original, restoredAs: target })
      }
      fs.renameSync(trashed, target)
      result.restored.push(target)
    } catch (error) {
      result.failed.push({ path: original, error: String(error && error.message ? error.message : error) })
    }
  }

  // 全部还原干净就把批次目录也收掉
  try {
    const left = fs.readdirSync(dir)
    const onlyManifest = left.length === 1 && left[0] === 'manifest.json'
    const onlyEmptyDirs = left.every((name) => name === 'manifest.json' || name === 'files' || name === 'session')
    if (onlyManifest || (onlyEmptyDirs && left.length > 0 && left.length <= 3)) {
      const empties = ['files', 'session'].every((name) => {
        const sub = path.join(dir, name)
        return !fs.existsSync(sub) || fs.readdirSync(sub).length === 0
      })
      if (onlyManifest || empties) fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    /* ignore */
  }
  result.ok = result.failed.length === 0
  return result
}

/**
 * 清掉超过保留期的回收站批次（插件启动时跑一次）。
 * @param {number} days 保留天数，默认 {@link TRASH_KEEP_DAYS}
 */
export function purgeTrash(days) {
  const keepDays = Number.isFinite(days) && days >= 0 ? days : TRASH_KEEP_DAYS
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
  const root = trashRoot()
  const result = { removed: [], kept: 0, bytes: 0, errors: [] }
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const st = safeStat(dir)
    if (!st) continue
    if (st.mtimeMs > cutoff) {
      result.kept += 1
      continue
    }
    let bytes = 0
    try {
      const walk = (target) => {
        for (const child of fs.readdirSync(target, { withFileTypes: true })) {
          const full = path.join(target, child.name)
          if (child.isDirectory()) walk(full)
          else bytes += (safeStat(full)?.size ?? 0)
        }
      }
      walk(dir)
      fs.rmSync(dir, { recursive: true, force: true })
      result.removed.push(dir)
      result.bytes += bytes
    } catch (error) {
      result.errors.push({ path: dir, error: String(error && error.message ? error.message : error) })
    }
  }
  return result
}

/** 删文件后顺手收掉空目录，但绝不越过 stopAt。 */
function pruneEmptyParents(target, stopAt) {
  if (typeof stopAt !== 'string' || stopAt === '') return
  let dir = path.dirname(target)
  for (let guard = 0; guard < 8; guard += 1) {
    if (!withinRoot(dir, stopAt)) return
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }
    if (entries.length > 0) return
    try {
      fs.rmdirSync(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}
