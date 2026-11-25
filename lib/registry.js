/**
 * dsh-session-tools / registry —— 会话在 DSH 注册表里的“账目”清理。
 *
 * 为什么需要这一层：
 *   DSH 的侧栏列表不是“扫目录”得来的。会话要先在
 *   `<DSH_HOME>/storages/workspace.json` 里被记账，才会出现在列表里：
 *
 *     · tables.workspaces[<ws>].sessionIds —— 工作区成员，权威显示顺序
 *     · global.archivedSessionIds          —— 归档集合（侧栏灰行 + 阻断后续回合）
 *     · global.pinnedSessionIds            —— 置顶集合
 *
 *   只把日志目录删掉，这三处账目还在，于是侧栏会留一条“灰掉的空壳”；
 *   点进去宿主再去读已被删掉的 session.vN.jsonl.zstd，就是那个 ENOENT。
 *
 * 因此这里直接操作宿主里的 workspaceRegistry 服务（同一个进程、同一份
 * 内存 + 同一份磁盘状态），而不是去改 workspace.json 文本——后者会被宿主
 * 下一次写状态时整份覆盖回去。
 */
import { sanitizeId } from './core.js'

function errorText(error) {
  return String(error && error.message ? error.message : error)
}

/**
 * 取 workspaceRegistry；插件没装/还没就绪时返回 null，调用方按“无账目可清”处理。
 * @param {object} ctx cordis 上下文
 */
export function resolveRegistry(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null
  try {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return null
    return registry
  } catch {
    return null
  }
}

/** 一个 workspace 实体在结果里的标识（实体有 id，接口文档里叫 workspaceId）。 */
function workspaceKey(entity) {
  if (!entity) return ''
  if (typeof entity.id === 'string') return entity.id
  if (typeof entity.workspaceId === 'string') return entity.workspaceId
  if (typeof entity.path === 'string') return entity.path
  return ''
}

function idsOf(list) {
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []
}

/**
 * 把一个会话从注册表的三处账目里彻底摘掉。
 *
 * 顺序：先摘工作区成员，再取消归档、取消置顶。任何一步失败都记进 errors，
 * 不影响其余步骤——目标是把能摘的都摘掉，而不是全有或全无。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} sessionId 会话 id
 * @returns {Promise<{available:boolean,detached:string[],unarchived:boolean,unpinned:boolean,errors:string[]}>}
 */
export async function purgeSessionAccounting(ctx, sessionId) {
  const id = sanitizeId(sessionId)
  const result = { available: false, detached: [], unarchived: false, unpinned: false, errors: [] }
  const registry = resolveRegistry(ctx)
  if (!registry || id === null) return result
  result.available = true

  let entities = []
  try {
    entities = registry.list() || []
  } catch (error) {
    result.errors.push('list: ' + errorText(error))
  }
  for (const entity of entities) {
    try {
      if (!idsOf(entity.sessionIds).includes(id)) continue
      await entity.detachSession(id)
      result.detached.push(workspaceKey(entity))
    } catch (error) {
      result.errors.push('detach ' + workspaceKey(entity) + ': ' + errorText(error))
    }
  }

  try {
    if (idsOf(registry.archivedSessionIds).includes(id)) {
      await registry.unarchiveSession(id)
      result.unarchived = true
    }
  } catch (error) {
    result.errors.push('unarchive: ' + errorText(error))
  }

  try {
    if (idsOf(registry.pinnedSessionIds).includes(id)) {
      await registry.unpinSession(id)
      result.unpinned = true
    }
  } catch (error) {
    result.errors.push('unpin: ' + errorText(error))
  }

  return result
}

/**
 * 清掉注册表里指向“已经不存在的会话”的账目（自愈）。
 *
 * 触发场景：之前的版本删了日志目录却留下 sessionIds / archivedSessionIds，
 * 侧栏就会一直挂着一条打不开的灰行。这里只用注册表自己的
 * `sessionKnown()` 判定（活会话 + 持久化头），判不出来的一个都不动。
 *
 * @param {object} ctx cordis 上下文
 * @param {{limit?:number}} [options] 单次最多处理多少条，默认 200
 * @returns {Promise<{available:boolean,checked:number,kept:number,removed:object[],errors:string[]}>}
 */
export async function sweepOrphans(ctx, options) {
  const limit = options && Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200
  const result = { available: false, checked: 0, kept: 0, removed: [], errors: [] }
  const registry = resolveRegistry(ctx)
  if (!registry) return result
  result.available = true

  const candidates = new Set()
  try {
    for (const entity of registry.list() || []) for (const id of idsOf(entity.sessionIds)) candidates.add(id)
  } catch (error) {
    result.errors.push('list: ' + errorText(error))
  }
  for (const id of idsOf(registry.archivedSessionIds)) candidates.add(id)
  for (const id of idsOf(registry.pinnedSessionIds)) candidates.add(id)

  for (const id of candidates) {
    if (result.checked >= limit) break
    result.checked += 1
    let known = true
    try {
      known = Boolean(await registry.sessionKnown(id))
    } catch (error) {
      result.errors.push('known ' + id + ': ' + errorText(error))
      continue
    }
    if (known) {
      result.kept += 1
      continue
    }
    const purge = await purgeSessionAccounting(ctx, id)
    result.removed.push({ sessionId: id, detached: purge.detached, unarchived: purge.unarchived, unpinned: purge.unpinned, errors: purge.errors })
  }

  return result
}
