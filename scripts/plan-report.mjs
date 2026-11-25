/**
 * 只读预演：打印某个会话的删除计划（不落盘、不删任何东西）。
 *
 * node scripts/plan-report.mjs                     # 全部会话，只给汇总
 * node scripts/plan-report.mjs session-xxxx        # 指定会话，列出产物
 */
import process from 'node:process'
import { listSessions, planDeletion } from '../lib/core.js'

const target = process.argv[2]

function human(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

const rows = listSessions()
if (rows.length === 0) {
  console.log('no sessions on disk')
  process.exit(0)
}

if (target) {
  const plan = planDeletion(target)
  if (!plan) {
    console.log('invalid session id:', target)
    process.exit(1)
  }
  console.log('session :', plan.sessionId)
  console.log('title   :', plan.title || '(none)')
  console.log('cwd     :', plan.cwd)
  console.log('events  :', plan.events)
  console.log('logs    :', plan.log.files.length, 'file(s),', human(plan.totals.logBytes))
  console.log('cache   :', plan.cache ? human(plan.cache.bytes) : '(none)')
  console.log('products:', plan.artifacts.length, 'file(s),', human(plan.totals.artifactBytes))
  for (const item of plan.artifacts) console.log('   -', item.path, '|', human(item.bytes), '|', item.sources.join(','))
  if (plan.skipped.length > 0) {
    console.log('skipped :', plan.skipped.length)
    for (const item of plan.skipped) console.log('   !', item.reason.padEnd(15), item.path)
  }
  process.exit(0)
}

for (const row of rows) {
  const plan = planDeletion(row.sessionId)
  console.log(
    row.sessionId,
    '|',
    human(row.bytes).padStart(8),
    '| products:',
    String(plan ? plan.artifacts.length : 0).padStart(4),
    '|',
    plan && plan.title ? plan.title.slice(0, 40) : '(no title)',
  )
}
