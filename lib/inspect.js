/**
 * dsh-session-tools / inspect —— 产物预览与"打开"。
 *
 * 两个能力都只对**该会话自己的产物**生效：每次调用都用 sessionId 重算 plan，
 * 再拿 path 去 plan.artifacts 里精确比对。所以客户端给过来的 path 即使被篡改成
 * `C:\\Windows\\System32\\cmd.exe`，也只会得到 `not an artifact of this session`，
 * 既读不到别的文件，也打不开别的程序。
 *
 * 预览走 HTTP 返回 data URL / 文本片段（浏览器不能直接读本地文件），
 * 打开走宿主进程 spawn 系统默认程序（explorer / open / xdg-open）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 图片扩展名 → MIME。只有这些能被浏览器直接渲染。 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

/** 当作纯文本预览的扩展名（其余扩展名按二进制处理，只给"打开"）。 */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.svg',
  '.yml', '.yaml', '.toml', '.ini', '.conf', '.env', '.properties',
  '.py', '.ipynb', '.ps1', '.psm1', '.sh', '.bash', '.bat', '.cmd',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.java', '.kt', '.go', '.rs',
  '.rb', '.php', '.pl', '.lua', '.sql', '.r', '.m', '.swift', '.dart', '.gradle',
])

/** 图片预览上限：超了不塞 data URL，改成提示"用打开看"。 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** 文本预览读多少字节。 */
const MAX_TEXT_BYTES = 64 * 1024
/** 判断"是不是二进制"时先看的字节数。 */
const SNIFF_BYTES = 8 * 1024

/** 把客户端给的路径收敛成可比较的小写绝对路径；坏输入返回 null。 */
export function normalizePath(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  try {
    return path.resolve(text).toLowerCase()
  } catch {
    return null
  }
}

/**
 * 在 plan 的产物清单里精确找一个文件。
 * @param {{artifacts?: Array<{path:string,bytes:number,sources:string[]}>}} plan
 * @param {unknown} rawPath
 * @returns {{path:string,bytes:number,sources:string[]}|null}
 */
export function findArtifact(plan, rawPath) {
  const key = normalizePath(rawPath)
  if (key === null) return null
  const list = plan && Array.isArray(plan.artifacts) ? plan.artifacts : []
  for (const item of list) {
    if (normalizePath(item && item.path) === key) return item
  }
  return null
}

function safeStat(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function looksBinary(buf) {
  const limit = Math.min(buf.length, SNIFF_BYTES)
  for (let i = 0; i < limit; i += 1) if (buf[i] === 0) return true
  return false
}

/**
 * 读一份预览。
 * @returns {{ok:true, kind:'image'|'text'|'binary', name:string, ext:string, bytes:number,
 *   mime:string|null, mtimeMs:number, dataUrl?:string, text?:string, truncated?:boolean, note?:string}
 *   | {ok:false, error:string}}
 */
export function readPreview(plan, rawPath) {
  const hit = findArtifact(plan, rawPath)
  if (!hit) return { ok: false, error: 'not an artifact of this session' }
  const file = hit.path
  const st = safeStat(file)
  if (!st || !st.isFile()) return { ok: false, error: 'file is gone' }

  const name = path.basename(file)
  const ext = path.extname(file).toLowerCase()
  const base = { ok: true, name, ext, bytes: st.size, mtimeMs: st.mtimeMs, mime: null, note: '' }
  const mime = IMAGE_MIME[ext] || null

  if (mime !== null) {
    if (st.size > MAX_IMAGE_BYTES) {
      return { ...base, kind: 'image', mime, note: 'too-large' }
    }
    try {
      const buf = fs.readFileSync(file)
      return { ...base, kind: 'image', mime, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  if (TEXT_EXT.has(ext)) {
    try {
      const fd = fs.openSync(file, 'r')
      const length = Math.min(st.size, MAX_TEXT_BYTES)
      const buf = Buffer.alloc(length)
      let read = 0
      try {
        read = fs.readSync(fd, buf, 0, length, 0)
      } finally {
        fs.closeSync(fd)
      }
      const slice = buf.subarray(0, read)
      if (looksBinary(slice)) return { ...base, kind: 'binary', note: 'binary' }
      return {
        ...base,
        kind: 'text',
        mime: 'text/plain',
        text: slice.toString('utf8'),
        truncated: st.size > read,
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  // 未知扩展名：先嗅一下，像文本就仍然给文本预览
  try {
    const fd = fs.openSync(file, 'r')
    const length = Math.min(st.size, SNIFF_BYTES)
    const buf = Buffer.alloc(length)
    let read = 0
    try {
      read = fs.readSync(fd, buf, 0, length, 0)
    } finally {
      fs.closeSync(fd)
    }
    const slice = buf.subarray(0, read)
    if (!looksBinary(slice) && slice.length > 0) {
      const textLength = Math.min(st.size, MAX_TEXT_BYTES)
      const textBuf = Buffer.alloc(textLength)
      let textRead = 0
      const fd2 = fs.openSync(file, 'r')
      try {
        textRead = fs.readSync(fd2, textBuf, 0, textLength, 0)
      } finally {
        fs.closeSync(fd2)
      }
      return {
        ...base,
        kind: 'text',
        mime: 'text/plain',
        text: textBuf.subarray(0, textRead).toString('utf8'),
        truncated: st.size > textRead,
      }
    }
  } catch {
    /* 落回 binary */
  }
  return { ...base, kind: 'binary', note: 'binary' }
}

/** 平台对应的"打开/定位"实现：返回命令名和逐文件构造的 argv。 */
function openerFor(reveal) {
  const platform = process.platform
  if (platform === 'win32') {
    return { command: 'explorer.exe', args: (file) => [reveal ? '/select,' + file : file] }
  }
  if (platform === 'darwin') {
    return { command: 'open', args: (file) => (reveal ? ['-R', file] : [file]) }
  }
  return { command: 'xdg-open', args: (file) => [reveal ? path.dirname(file) : file] }
}

/**
 * 用系统默认程序打开产物，或在文件管理器里定位它。
 * @param {object} plan
 * @param {unknown} rawPath
 * @param {{reveal?:boolean}} [options]
 * @returns {{ok:true, path:string, reveal:boolean} | {ok:false, error:string}}
 */
export function openArtifact(plan, rawPath, options) {
  const hit = findArtifact(plan, rawPath)
  if (!hit) return { ok: false, error: 'not an artifact of this session' }
  const reveal = Boolean(options && options.reveal)
  const st = safeStat(hit.path)
  if (!st || !st.isFile()) return { ok: false, error: 'file is gone' }

  const opener = openerFor(reveal)
  try {
    // 路径作为单独一个 argv 传进去，不经过 shell，没有拼接注入面。
    const child = spawn(opener.command, opener.args(hit.path), { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, path: hit.path, reveal }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/**
 * 在文件管理器里打开一个目录（回收站浏览用）。
 * 只接受"调用方已经校验过"的绝对路径；这里不再做范围判断。
 * @param {string} target
 * @returns {{ok:true, path:string} | {ok:false, error:string}}
 */
export function revealPath(target) {
  if (typeof target !== 'string' || target.trim() === '') return { ok: false, error: 'invalid path' }
  const st = (() => {
    try { return fs.statSync(target) } catch { return null }
  })()
  if (!st) return { ok: false, error: 'path is gone' }
  const opener = process.platform === 'win32'
    ? { command: 'explorer.exe', args: () => [target] }
    : process.platform === 'darwin'
      ? { command: 'open', args: () => [target] }
      : { command: 'xdg-open', args: () => [target] }
  try {
    const child = spawn(opener.command, opener.args(), { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, path: target }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}