/**
 * 注册表账目自测：用假 workspaceRegistry 跑 purge / sweep，不碰真磁盘。
 *
 * node test/registry-test.mjs
 */
import assert from 'node:assert/strict'

const { purgeSessionAccounting, sweepOrphans, resolveRegistry } = await import('../lib/registry.js')

function makeRegistry(seed) {
  const calls = []
  const entities = (seed.workspaces || []).map((row) => ({
    id: row.id,
    path: row.path || ('E:/ws/' + row.id),
    sessionIds: [...row.sessionIds],
    async detachSession(sessionId) {
      calls.push('detach:' + row.id + ':' + sessionId)
      this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
    },
  }))
  const registry = {
    calls,
    entities,
    archivedSessionIds: [...(seed.archived || [])],
    pinnedSessionIds: [...(seed.pinned || [])],
    list: () => entities,
    async sessionKnown(id) {
      calls.push('known:' + id)
      return (seed.known || []).includes(id)
    },
    async unarchiveSession(id) {
      calls.push('unarchive:' + id)
      registry.archivedSessionIds = registry.archivedSessionIds.filter((x) => x !== id)
    },
    async unpinSession(id) {
      calls.push('unpin:' + id)
      registry.pinnedSessionIds = registry.pinnedSessionIds.filter((x) => x !== id)
    },
  }
  return registry
}

const ctxWith = (registry) => ({
  get(name) {
    return name === 'workspaceRegistry' ? registry : undefined
  },
})

// --- 没有注册表：不炸，只是 reported unavailable
{
  const none = await purgeSessionAccounting({}, 'session-a')
  assert.equal(none.available, false)
  assert.deepEqual(none.detached, [])
  const sweepNone = await sweepOrphans({})
  assert.equal(sweepNone.available, false)
  assert.equal(sweepNone.checked, 0)
  assert.equal(resolveRegistry(undefined), null)
  console.log('no-registry path ok')
}

// --- 非法 id 不动账目
{
  const registry = makeRegistry({ workspaces: [{ id: 'ws1', sessionIds: ['session-a'] }] })
  const bad = await purgeSessionAccounting(ctxWith(registry), '../etc')
  assert.equal(bad.available, false)
  assert.deepEqual(registry.calls, [])
  console.log('bad id leaves the registry untouched')
}

// --- purge：工作区成员 + 归档 + 置顶 一起摘
{
  const registry = makeRegistry({
    workspaces: [{ id: 'ws1', sessionIds: ['session-a', 'session-b'] }],
    archived: ['session-a'],
    pinned: ['session-a'],
  })
  const result = await purgeSessionAccounting(ctxWith(registry), 'session-a')
  assert.equal(result.available, true)
  assert.deepEqual(result.detached, ['ws1'])
  assert.equal(result.unarchived, true)
  assert.equal(result.unpinned, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(registry.entities[0].sessionIds, ['session-b'])
  assert.deepEqual(registry.archivedSessionIds, [])
  assert.deepEqual(registry.pinnedSessionIds, [])
  console.log('purge ok:', registry.calls.join(' '))
}

// --- sweep：只清“注册表说有、宿主说没有”的会话，活的一个都不碰
{
  const registry = makeRegistry({
    workspaces: [{ id: 'ws1', sessionIds: ['session-alive', 'session-ghost'] }],
    archived: ['session-ghost'],
    pinned: ['session-alive'],
    known: ['session-alive'],
  })
  const sweep = await sweepOrphans(ctxWith(registry))
  assert.equal(sweep.available, true)
  assert.equal(sweep.checked, 2)
  assert.equal(sweep.kept, 1)
  assert.equal(sweep.removed.length, 1)
  assert.equal(sweep.removed[0].sessionId, 'session-ghost')
  assert.deepEqual(registry.entities[0].sessionIds, ['session-alive'])
  assert.deepEqual(registry.archivedSessionIds, [])
  assert.deepEqual(registry.pinnedSessionIds, ['session-alive'])
  console.log('sweep ok: ghost removed, live session kept')
}

// --- sweep 的 limit 生效
{
  const registry = makeRegistry({
    workspaces: [{ id: 'ws1', sessionIds: ['a', 'b', 'c', 'd'] }],
    known: [],
  })
  const sweep = await sweepOrphans(ctxWith(registry), { limit: 2 })
  assert.equal(sweep.checked, 2)
  assert.equal(sweep.removed.length, 2)
  console.log('sweep limit ok')
}

console.log('\nREGISTRY SELF-TESTS PASSED')
