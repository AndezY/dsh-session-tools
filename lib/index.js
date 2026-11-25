/**
 * dsh-session-tools —— 会话删除（含该会话生成的全部产物）。
 *
 * Host 半侧做三件事：
 *   1. 在 webServer 上挂一条包私有 HTTP 路由 `POST /session-tools/api`；
 *   2. 把 core.js 的计划/删除能力暴露成 `plan` / `delete` / `list` / `sweep` 几个 op；
 *   3. 删除前后处理“宿主侧还活着的东西”：停掉运行中的回合、等客户端放开引用、
 *      把会话从 workspaceRegistry 的账目里摘掉、最后补一条 api-session/removed。
 *
 * 为什么第 3 步必须在这里做：
 *   侧栏列表的成员关系来自 `workspace.json`（sessionIds / archivedSessionIds /
 *   pinnedSessionIds）。只删日志目录 → 账目还在 → 侧栏留一条灰掉的空壳，
 *   点开读不到 session.vND.jsonl.zstd 就是 ENOENT。而 workspace.json 由宿主的
 *   workspaceRegistry 持有，直接改文件会被下一次状态写入整份覆盖，所以走服务。
 *
 * 为什么走 webServer 而不是 typert/@Remote：本插件刻意保持零外部依赖，
 * 且删除是本机文件操作，跑在 host 进程里最直接；跨源请求由 Origin/Host
 * 校验挡住（同源 POST 才放行）。
 */
import {
  dshHome,
  listSessions,
  planDeletion,
  deleteSession,
  listTrash,
  purgeTrash,
  purgeTrashEntry,
  restoreTrash,
  sanitizeId,
  sessionsRoot,
  trashRoot,
  withinRoot,
  TRASH_KEEP_DAYS,
} from './core.js'
import path from 'node:path'
import { purgeSessionAccounting, sweepOrphans, resolveRegistry } from './registry.js'
import { openArtifact, readPreview, revealPath } from './inspect.js'

export const name = 'dsh-session-tools'
export const inject = ['webServer']

const ROUTE = '/session-tools/api'
const MAX_BODY = 256 * 1024
/** 等客户端放开主视图引用（宿主里那个会话退场）的上限。 */
const RELEASE_WAIT_MS = 5000
const RELEASE_POLL_MS = 100

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * 本机回环一律放行；非回环要求 Origin 与 Host 同源。
 * 桌面端 Origin 常见 app:// / null，Host 仍是 127.0.0.1:port。
 */
function originAllowed(request) {
  const remote = request.socket && request.socket.remoteAddress ? String(request.socket.remoteAddress) : ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const host = typeof request.headers.host === 'string' ? request.headers.host : ''
  const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
  const origin = request.headers.origin
  if (loopback) return true
  if (hostLocal) {
    if (origin === undefined || origin === '' || origin === 'null') return true
    if (typeof origin === 'string' && /^app:/i.test(origin)) return true
    try {
      const parsed = new URL(origin)
      if (parsed.host === host || parsed.host === '') return true
    } catch {
      /* fall through */
    }
  }
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

// ------------------------------------------------------------ 宿主侧服务

function service(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 宿主里是否还有一个活着的会话对象（被某个视图 retain 住就会活着）。 */
function liveSession(ctx, sessionId) {
  const sessions = service(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  try {
    return sessions.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * 停掉该会话正在进行的工作：先按用户的“停止”语义取消当前回合，
 * 再把 workspace/session-stop 广播给其它 provider（子智能体 / 后台任务 / 定时）。
 */
async function stopSessionWork(ctx, sessionId) {
  const result = { cancelled: false, stopped: false }
  const agents = service(ctx, 'agents')
  try {
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent && agent.status === 'running' && typeof agent.cancel === 'function') {
      agent.cancel({ kind: 'user' })
      result.cancelled = true
    }
  } catch {
    /* 停不下来也不阻塞删除流程，后面会用超时兜底 */
  }
  try {
    if (ctx && typeof ctx.parallel === 'function') {
      await ctx.parallel('workspace/session-stop', { sessionId })
      result.stopped = true
    }
  } catch {
    /* 没有 provider 或某个 provider 抛错：忽略 */
  }
  return result
}

/** 等宿主把会话从内存里放掉（客户端 clearMain / release 之后会异步发生）。 */
async function waitDetached(ctx, sessionId, timeoutMs) {
  const started = Date.now()
  for (;;) {
    if (liveSession(ctx, sessionId) === undefined) return true
    if (Date.now() - started >= timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS))
  }
}

async function handleOp(ctx, request) {
  const op = request && typeof request.op === 'string' ? request.op : ''
  if (op === 'ping') {
    return {
      ok: true,
      home: dshHome(),
      sessionsRoot: sessionsRoot(),
      version: '0.5.5',
      // 署名：谁探测这个接口都能看到原创作者。
      author: 'Weilong',
      registry: resolveRegistry(ctx) !== null,
      caps: { keep: true, preview: true, open: true, trash: true, export: true, batch: true, lock: true },
    }
  }
  if (op === 'list') {
    const rows = listSessions().map((row) => ({
      sessionId: row.sessionId,
      workspaceKey: row.workspaceKey,
      bytes: row.bytes,
      mtimeMs: row.mtimeMs,
    }))
    return { ok: true, sessions: rows }
  }
  if (op === 'plan') {
    const plan = planDeletion(request.sessionId)
    if (!plan) return { ok: false, error: 'invalid session id' }
    // caps 让客户端知道这个 host 支不支持“逐条勾选保留”。老 host 不带这个字段，
    // 客户端据此退回保守行为：不发 keep（老代码会忽略它而全删），干脆什么产物都不删。
    plan.caps = {
      keep: true, preview: true, open: true,
      trash: true, export: true, batch: true, lock: true,
      version: '0.5.5',
    }
    return { ok: true, plan, registry: resolveRegistry(ctx) !== null }
  }
  if (op === 'preview') {
    const plan = planDeletion(request.sessionId)
    if (!plan) return { ok: false, error: 'invalid session id' }
    return readPreview(plan, request.path)
  }
  if (op === 'open') {
    const plan = planDeletion(request.sessionId)
    if (!plan) return { ok: false, error: 'invalid session id' }
    return openArtifact(plan, request.path, { reveal: request.reveal === true })
  }
  if (op === 'trash') {
    const entries = listTrash()
    return {
      ok: true,
      root: trashRoot(),
      entries,
      totals: {
        batches: entries.length,
        files: entries.reduce((sum, row) => sum + (row.files || 0), 0),
        bytes: entries.reduce((sum, row) => sum + (row.bytes || 0), 0),
      },
    }
  }
  if (op === 'purgeEntry') {
    return purgeTrashEntry(request.token)
  }
  if (op === 'openTrash') {
    const target = request && typeof request.token === 'string' && request.token !== ''
      ? path.join(trashRoot(), request.token)
      : trashRoot()
    if (!withinRoot(target, trashRoot()) && target.toLowerCase() !== trashRoot().toLowerCase()) {
      return { ok: false, error: 'invalid trash token' }
    }
    return revealPath(target)
  }
  if (op === 'restore') {
    const restored = restoreTrash(request.token)
    // 会话记录回来了，但侧栏成员关系是被删时摘掉的：这里补一次重新登记。
    if (restored.ok && restored.recordRestored && typeof restored.sessionId === 'string') {
      restored.attached = await reattachSession(ctx, restored.sessionId)
    }
    return restored
  }
  if (op === 'purgeTrash') {
    return { ok: true, purge: purgeTrash(request.days) }
  }
  if (op === 'sweep') {
    const sweep = await sweepOrphans(ctx)
    return { ok: true, sweep }
  }
  if (op === 'delete') {
    return await deleteAndForget(ctx, request)
  }
  return { ok: false, error: 'unknown op: ' + op }
}

/**
 * 删除一个会话：停工作 → 等引用放开 → 摘注册表账目 → 删文件 → 通知客户端摘行。
 *
 * 账目先摘、文件后删：万一文件删失败，注册表里已经不留悬空引用，会话会作为
 * “未分组”里的普通会话继续存在，用户还可以重试；反过来则会留下打不开的空壳。
 */
async function deleteAndForget(ctx, request) {
  const sessionId = sanitizeId(request && request.sessionId)
  if (!sessionId) return { ok: false, error: 'invalid session id' }
  if (!planDeletion(sessionId)) return { ok: false, error: 'invalid session id' }

  const live = liveSession(ctx, sessionId) !== undefined
  let stop = { cancelled: false, stopped: false }
  let released = true
  if (live) {
    stop = await stopSessionWork(ctx, sessionId)
    const waitMs = request.waitForRelease === false ? 0 : RELEASE_WAIT_MS
    released = await waitDetached(ctx, sessionId, waitMs)
  }
  if (!released) {
    return {
      ok: false,
      code: 'still-live',
      error: '该会话仍在宿主里打开着（主面板或侧栏还占着它）。先切换到别的会话，再回来删除。',
      stop,
    }
  }

  const accounting = await purgeSessionAccounting(ctx, sessionId)
  const result = deleteSession({
    sessionId,
    deleteArtifacts: request.deleteArtifacts === true,
    // 只是“别删这些”：删除名单仍然来自 host 侧重算的 plan，客户端点不出越权。
    keep: Array.isArray(request.keep) ? request.keep : [],
    // 保留的文件：原地留着，还是复制到桌面导出目录（v0.5）
    keepMode: request.keepMode === 'export' ? 'export' : 'stay',
    // 显式要求才走回收站：客户端默认勾上，但 host 侧保持"不传就是真删"的老语义。
    trash: request.trash === true,
  })
  result.accounting = accounting
  result.stop = stop
  result.released = released

  if (result.ok && ctx && typeof ctx.emit === 'function') {
    try {
      ctx.emit('api-session/removed', sessionId)
    } catch {
      /* 没有监听者或转发失败：客户端还有 refresh() 兜底 */
    }
  }
  return result
}

/**
 * 把从回收站还原回来的会话重新挂回它原来的工作区账目。
 *
 * 删的时候我们用 `detachSession` 把它从 `sessionIds` 里摘掉了，还原时日志目录刚回来，
 * 头信息（含 cwd）已经存在，`attachSession` 会自己校验 cwd 是否等于工作区路径。
 * 找不到匹配的工作区就安静地留在"未分组"里——不能因为挂不回去就让还原失败。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<{ok:boolean, workspaceId:string|null, error?:string}>}
 */
async function reattachSession(ctx, sessionId) {
  const registry = resolveRegistry(ctx)
  if (!registry) return { ok: false, workspaceId: null, error: 'no workspace registry' }
  let entities = []
  try {
    entities = registry.list() || []
  } catch (error) {
    return { ok: false, workspaceId: null, error: String(error && error.message ? error.message : error) }
  }
  let lastError = ''
  for (const entity of entities) {
    try {
      if (idsInclude(entity.sessionIds, sessionId)) {
        return { ok: true, workspaceId: String(entity.id || entity.workspaceId || '') }
      }
      await entity.attachSession(sessionId)
      return { ok: true, workspaceId: String(entity.id || entity.workspaceId || '') }
    } catch (error) {
      lastError = String(error && error.message ? error.message : error)
    }
  }
  return { ok: false, workspaceId: null, error: lastError || 'no workspace owns this session' }
}

function idsInclude(list, id) {
  return Array.isArray(list) && list.includes(id)
}

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register(
      {
        kind: 'exact',
        path: ROUTE,
        handler: async (request, response) => {
          if (!originAllowed(request)) {
            sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          try {
            const raw = await readBody(request)
            const payload = raw.trim() === '' ? {} : JSON.parse(raw)
            sendJson(response, 200, await handleOp(ctx, payload))
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      },
      'dsh-session-tools: api',
    )
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-session-tools: route')

  // 启动自愈：历史版本删了日志、却留下注册表账目的会话，在这里一次性摘干净。
  // 延迟一拍，让注册表先跑完自己的 bootstrap（header 索引 / 历史回填）；
  // 注册表还在初始化时报错就隔一会儿重试，最多三轮。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['workspaceRegistry'], (host) => {
        let timer = null
        let attempts = 0
        const run = () => {
          sweepOrphans(host)
            .then((sweep) => {
              const count = Array.isArray(sweep.removed) ? sweep.removed.length : 0
              if (count > 0 && host.logger && typeof host.logger.info === 'function') {
                host.logger.info(`dsh-session-tools: 清掉 ${String(count)} 条指向已删会话的注册表账目`)
              }
              if (sweep.available && sweep.errors.length > 0 && attempts < 3) {
                attempts += 1
                timer = setTimeout(run, 2000)
                if (typeof timer.unref === 'function') timer.unref()
              }
            })
            .catch(() => {
              /* 自愈失败不影响手动删除 */
            })
        }
        timer = setTimeout(run, 1500)
        if (typeof timer.unref === 'function') timer.unref()
        if (typeof host.effect === 'function') {
          host.effect(() => () => clearTimeout(timer), 'dsh-session-tools: orphan sweep timer')
        }
      })
    } catch {
      /* 没有 workspaceRegistry：删除退化成“只删文件 + 尽量摘账目” */
    }
  }

  // 回收站只保留 7 天：启动时清一批，不需要 registry。
  try {
    const timer = setTimeout(() => {
      try {
        purgeTrash(TRASH_KEEP_DAYS)
      } catch {
        /* 清理失败不影响别的 */
      }
    }, 2500)
    if (typeof timer.unref === 'function') timer.unref()
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => clearTimeout(timer), 'dsh-session-tools: trash purge timer')
    }
  } catch {
    /* ignore */
  }
}
