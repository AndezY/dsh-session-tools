/**
 * 浏览器半侧自测：用最小 react / ModuleLoader 桩把 client.js 跑起来，
 * 检查槽位注册、菜单项渲染、对话框读取 plan 与确认删除的路径。
 *
 * node test/client-test.mjs
 */
import fs from 'node:fs'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const PLAN = {
  sessionId: 'session-x',
  title: '演示会话',
  cwd: 'E:/ws',
  events: 12,
  log: { files: [{ path: 'C:/u/.dsh/sessions/a/session-x/session.v4.jsonl.zstd', bytes: 4096 }], bytes: 4096 },
  cache: { path: 'C:/u/.dsh/storages/session_projcache/sessions/session-x.json', bytes: 2048 },
  dirs: ['C:/u/.dsh/sessions/a/session-x'],
  artifacts: [
    { path: 'E:/ws/report.md', bytes: 1024, sources: ['presented'] },
    { path: 'E:/ws/run.js', bytes: 512, sources: ['write'], locked: true },
  ],
  skipped: [{ path: 'C:/u/.dsh/plugins/x', reason: 'outside-scope' }],
  totals: { artifactFiles: 2, artifactBytes: 1536, logBytes: 4096, cacheBytes: 2048 },
  caps: { keep: true, preview: true, open: true, trash: true, export: true, batch: true, lock: true },
}

// 老宿主（0.2.x）的 plan：没有 caps，客户端必须退成“一个产物都不删”
const PLAN_OLD_HOST = Object.assign({}, PLAN, { caps: undefined })

// ---- 桩：react / window / document / fetch
// stubState.seq：按 useState 调用顺序依次取值，用来稳定模拟 hooks 状态。
const stubState = { seq: [], index: 0, setters: [] }
const react = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => {
    const i = stubState.index
    stubState.index += 1
    const value = i < stubState.seq.length ? stubState.seq[i] : initial
    const set = (next) => { stubState.setters.push(typeof next === 'function' ? next(value) : next) }
    return [value, set]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}

function resetHooks(seq) {
  stubState.seq = seq || []
  stubState.index = 0
  stubState.setters.length = 0
}

const fetchCalls = []
let failure = null
const fetchStub = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null
  fetchCalls.push({ url: String(url), body })
  if (failure && body && body.op === 'delete') {
    return { ok: true, status: 200, text: async () => JSON.stringify(failure) }
  }
  if (body && body.op === 'ping') {
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, version: '0.5.0', caps: { keep: true, preview: true, open: true, trash: true, export: true, batch: true, lock: true } }) }
  }
  if (body && body.op === 'trash') {
    return {
      ok: true, status: 200, text: async () => JSON.stringify({
        ok: true, root: 'C:/u/.dsh/trash',
        entries: [
          { token: '20260101-000000-session-x', createdAt: '2026-01-01T09:30:00.000Z', sessionId: 'session-x', title: '演示会话', files: 2, bytes: 2048, hasRecord: true },
          { token: '20251231-120000-session-y', createdAt: '2025-12-31T12:00:00.000Z', sessionId: 'session-y', title: '', files: 1, bytes: 512, hasRecord: false },
        ],
        totals: { batches: 2, files: 3, bytes: 2560 },
      }),
    }
  }
  if (body && body.op === 'purgeEntry') {
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, token: body.token, bytes: 512 }) }
  }
  if (body && body.op === 'restore') {
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, restored: ['E:/ws/report.md'], conflicts: [], failed: [] }) }
  }
  const payload = body && body.op === 'delete'
    ? { ok: true, sessionId: 'session-x', logs: { removed: ['C:/u/.dsh/sessions/a/session-x'], failed: [], bytes: 4096 }, artifacts: { removed: ['E:/ws/report.md', 'E:/ws/run.js'], failed: [], bytes: 1536 }, cache: { removed: true }, skipped: [] }
    : { ok: true, plan: PLAN }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}

const registrations = []
let loaded = null

globalThis.window = {
  location: { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/' },
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: {
    load: (entry) => {
      loaded = entry
      entry.exports = entry.factory((name) => {
        if (name === 'react') return react
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}
globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }), head: { append() {} } }
globalThis.fetch = fetchStub

new Function('window', 'document', 'fetch', source)(globalThis.window, globalThis.document, globalThis.fetch)

assert.ok(loaded && loaded.id === 'dsh-session-tools', 'bundle registered under its id')
const exported = loaded.exports
assert.equal(exported.name, 'dsh-session-tools')
assert.deepEqual(exported.inject, ['slots', 'locale'])
assert.equal(typeof exported.apply, 'function')
console.log('bundle ok:', loaded.id, '| inject:', exported.inject.join(','))

// ---- 伪造 ctx
const dicts = []
const removedRows = []
let refreshed = 0
const sessionsStub = {
  list: { getSnapshot: () => ({ ids: [], byId: {} }) },
  handleSessionRemoved: (id) => { removedRows.push(id) },
  refresh: async () => { refreshed += 1 },
}
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => { dicts.push({ ns, dict }); return () => {} },
    bind: (ns) => (key) => {
      const hit = dicts.find((d) => d.ns === ns)
      return (hit && hit.dict.zh && hit.dict.zh[key]) || key
    },
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (meta, component) => { registrations.push({ meta, component }); return () => {} },
  },
  inject: (names, cb) => cb({ uiWorkspace: null, sessions: sessionsStub }),
}

exported.apply(ctx)

const byId = Object.fromEntries(registrations.map((r) => [r.meta.id, r]))
assert.ok(byId['dsh-session-tools.delete'], 'menu item registered')
assert.equal(byId['dsh-session-tools.delete'].meta.name, 'sidebar.workspaces.session.menu.item')
assert.equal(byId['dsh-session-tools.delete'].meta.order, 500)
assert.ok(byId['dsh-session-tools.dialog'], 'dialog registered')
assert.equal(byId['dsh-session-tools.dialog'].meta.name, 'shell.overlay')
assert.ok(byId['dsh-session-tools.trash'], 'recycle bin footer entry registered')
assert.equal(byId['dsh-session-tools.trash'].meta.name, 'sidebar.footer.action')
console.log('slots ok:', registrations.map((r) => r.meta.name + '#' + r.meta.id).join(', '))

/** overlay 注册项 → 里层真实的 DeleteSessionDialog 元素。 */
/** 完整 hooks 序列：req, plan, error, loading, busy, keep, done, filter, onlyPresented, hover, preview */
function seq(opts) {
  const o = opts || {}
  return [
    o.req || request, o.plan || PLAN, o.error || '', false, false,
    o.keep || {}, o.done || null, o.filter || '', o.onlyPresented || false,
    o.hover || null, o.preview || null,
    o.opts || { keepMode: 'stay', trash: true, grouped: true },
    o.collapsed || {},
    o.viewer || { pinned: false, zoom: 1 },
    o.notice || { text: '', busy: false },
  ]
}

function mountDialog(states) {
  resetHooks(states)
  const overlay = byId['dsh-session-tools.dialog'].component({})
  const children = overlay.type === react.Fragment ? overlay.children : [overlay]
  return children.find((child) => child && child.type && child.type.name === 'DeleteSessionDialog')
}

// ---- 菜单项渲染
const menuMeta = byId['dsh-session-tools.delete'].meta
const menuProps = typeof menuMeta.inject === 'function' ? menuMeta.inject({}) : {}
const menuEl = byId['dsh-session-tools.delete'].component(Object.assign({ sessionId: 'session-x' }, menuProps))
assert.ok(menuEl, 'menu item renders')
assert.equal(menuEl.type, 'button')
assert.equal(menuEl.props.role, 'menuitem')
assert.ok(JSON.stringify(menuEl).includes('删除会话'), 'menu label from zh dictionary')
console.log('menu item ok: role=menuitem, label =', menuEl.children[1].children[0])

// 无 sessionId 时不出行
assert.equal(byId['dsh-session-tools.delete'].component(menuProps), null)
console.log('menu item hidden without a session id')

// ---- 关闭态：pending 为空 → 渲染 null
const closed = mountDialog()
assert.equal(closed.type.name, 'DeleteSessionDialog', 'overlay mounts DeleteSessionDialog')
assert.equal(closed.type(closed.props), null, 'dialog closed when no request is pending')
console.log('closed dialog renders nothing')

// ---- 点击菜单项 → pending 写入（模块级状态），重新挂载即打开
menuEl.props.onClick({ preventDefault() {}, stopPropagation() {} })
const afterClick = mountDialog()
const afterClickTree = afterClick.type(afterClick.props)
assert.ok(afterClickTree, '菜单点击后对话框打开')
assert.ok(JSON.stringify(afterClickTree).includes('dst-modal'), 'menus click opens the modal')
console.log('menu click -> 对话框打开')

// ---- 打开态：pending=请求，plan 已返回
const request = { sessionId: 'session-x', title: '演示会话' }
const openEl = mountDialog(seq({}))
const tree = openEl.type(openEl.props)
const json = JSON.stringify(tree)
assert.ok(json.includes('dst-modal'), 'dialog markup present')
assert.ok(json.includes('删除会话'), 'dialog title localized')
assert.ok(json.includes('report.md'), 'artifact list renders produced files')
assert.ok(json.includes('KB') || json.includes('B'), 'sizes rendered')
assert.equal((json.match(/dst-list-row/g) || []).length, 2, 'one row per artifact')
assert.equal((json.match(/dst-list-tags/g) || []).length, 2, 'source tags rendered')
assert.ok(json.includes('交付物'), 'deliverable tag localized')
assert.ok(json.includes('全部保留') && json.includes('全部不保留'), 'bulk keep buttons present')
console.log('dialog ok: 标题 / 记录 / 产物列表（每行一个保留勾选框）都已渲染')

// ---- 确认删除：当前没有主面板占着它 → waitForRelease=false；删完本地摘行 + refresh
const modalEl = tree.children[0]
assert.equal(modalEl.props.className, 'dst-modal')
const opsRow = modalEl.children[modalEl.children.length - 1]
const buttons = Array.isArray(opsRow.children[0]) ? opsRow.children[0] : opsRow.children
const danger = buttons.find((b) => b && b.props && String(b.props.className || '').includes('danger'))
assert.ok(danger, 'confirm button present')
assert.equal(danger.props.disabled, false)
danger.props.onClick()
await new Promise((resolve) => setImmediate(resolve))
const deleteCall = fetchCalls.find((c) => c.body && c.body.op === 'delete')
assert.ok(deleteCall, 'delete op issued on confirm')
assert.equal(deleteCall.body.deleteArtifacts, true)
assert.equal(deleteCall.body.sessionId, 'session-x')
assert.equal(deleteCall.body.waitForRelease, false, 'nothing retained it, so no release wait')
assert.deepEqual(removedRows, ['session-x'], 'row evicted from the local list')
assert.equal(refreshed, 1, 'authoritative list refresh requested')
console.log('confirm -> delete op:', JSON.stringify(deleteCall.body))

// ---- 删的就是当前会话：先让出主面板，再等宿主放开引用
const cleared = []
const started = []
const reopened = []
const currentSessions = {
  list: { getSnapshot: () => ({ ids: ['session-x'], byId: { 'session-x': { id: 'session-x', retainedBy: { mainView: 1 } } } }) },
  handleSessionRemoved: (id) => { removedRows.push(id) },
  refresh: async () => { refreshed += 1 },
}
const uiWorkspaceStub = {
  clearMain: () => { cleared.push('clearMain') },
  startSession: () => { started.push('startSession') },
  openSession: (id) => { reopened.push(id) },
}
const ctxCurrent = Object.assign({}, ctx, { inject: (names, cb) => cb({ uiWorkspace: uiWorkspaceStub, sessions: currentSessions }) })
exported.apply(ctxCurrent)

resetHooks([])
const menuEl2 = byId['dsh-session-tools.delete'].component(Object.assign({ sessionId: 'session-x' }, menuProps))
menuEl2.props.onClick({ preventDefault() {}, stopPropagation() {} })
const currentEl = mountDialog(seq({ req: { sessionId: 'session-x', title: '演示会话' } }))
const currentTree = currentEl.type(currentEl.props)
const currentModal = currentTree.children[0]
const currentOps = currentModal.children[currentModal.children.length - 1]
const currentButtons = Array.isArray(currentOps.children[0]) ? currentOps.children[0] : currentOps.children
currentButtons.find((b) => b && b.props && String(b.props.className || '').includes('danger')).props.onClick()
await new Promise((resolve) => setImmediate(resolve))
const currentCall = fetchCalls[fetchCalls.length - 1]
assert.equal(currentCall.body.op, 'delete')
assert.equal(currentCall.body.waitForRelease, true, 'current session: host must wait for the release')
assert.deepEqual(cleared, ['clearMain'], 'main panel released before deleting')
assert.deepEqual(started, ['startSession'], 'lands on a fresh session afterwards')
console.log('current-session delete ok: clearMain -> delete -> startSession')

// ---- 删除失败：still-live 不抢回面板；其它错误把面板开回去
const clickConfirm = async () => {
  resetHooks([])
  const menu = byId['dsh-session-tools.delete'].component(Object.assign({ sessionId: 'session-x' }, menuProps))
  menu.props.onClick({ preventDefault() {}, stopPropagation() {} })
  const el = mountDialog(seq({ req: { sessionId: 'session-x', title: '演示会话' } }))
  const tree = el.type(el.props)
  const modal = tree.children[0]
  const ops = modal.children[modal.children.length - 1]
  const buttons = Array.isArray(ops.children[0]) ? ops.children[0] : ops.children
  buttons.find((b) => b && b.props && String(b.props.className || '').includes('danger')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
}

failure = { ok: false, code: 'still-live', error: '该会话仍在宿主里打开着' }
await clickConfirm()
assert.deepEqual(reopened, [], 'still-live: the panel is not reopened (it would only bounce)')
console.log('failure path ok: still-live leaves the panel alone')

failure = { ok: false, code: 'boom', error: '磁盘写失败' }
await clickConfirm()
assert.deepEqual(reopened, ['session-x'], 'other failures reopen the session')
console.log('failure path ok: other errors reopen the session')

// ---- 勾选保留：勾上的进 payload.keep，确认按钮上写明保留几个
{
  resetHooks([])
  const menu = byId['dsh-session-tools.delete'].component(Object.assign({ sessionId: 'session-x' }, menuProps))
  menu.props.onClick({ preventDefault() {}, stopPropagation() {} })
  const el = mountDialog(seq({ keep: { 'e:/ws/report.md': true } }))
  const treeWithKeep = el.type(el.props)
  const text = JSON.stringify(treeWithKeep)
  assert.ok(text.includes('保留 1'), 'header counts the kept file')
  assert.ok(text.includes('删除会话（保留 1 个文件）'), 'confirm label names the kept count')
  assert.ok(text.includes('kept'), 'kept row is marked')

  const modal = treeWithKeep.children[0]
  const ops = modal.children[modal.children.length - 1]
  const buttons = Array.isArray(ops.children[0]) ? ops.children[0] : ops.children
  buttons.find((b) => b && b.props && String(b.props.className || '').includes('danger')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const keepCall = fetchCalls[fetchCalls.length - 1]
  assert.equal(keepCall.body.op, 'delete')
  assert.deepEqual(keepCall.body.keep, ['E:/ws/report.md'], 'ticked artifact sent as keep')
  console.log('keep ok: payload.keep =', JSON.stringify(keepCall.body.keep))
}

// ---- 老宿主（plan 里没有 caps）：不认 keep，就一个产物都不删
{
  resetHooks([])
  const menu = byId['dsh-session-tools.delete'].component(Object.assign({ sessionId: 'session-x' }, menuProps))
  menu.props.onClick({ preventDefault() {}, stopPropagation() {} })
  const el = mountDialog(seq({ plan: PLAN_OLD_HOST }))
  const oldTree = el.type(el.props)
  const oldText = JSON.stringify(oldTree)
  assert.equal((oldText.match(/"type":"checkbox"/g) || []).length, 0, 'no keep checkboxes on an outdated host')
  assert.ok(oldText.includes('全部保留'), 'row says files are kept')
  assert.ok(oldText.includes('宿主进程还是旧版本'), 'warning explains why')

  const modal = oldTree.children[0]
  const ops = modal.children[modal.children.length - 1]
  const buttons = Array.isArray(ops.children[0]) ? ops.children[0] : ops.children
  buttons.find((b) => b && b.props && String(b.props.className || '').includes('danger')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const oldCall = fetchCalls[fetchCalls.length - 1]
  assert.equal(oldCall.body.op, 'delete')
  assert.equal(oldCall.body.deleteArtifacts, false, 'outdated host: artifacts are never deleted')
  assert.deepEqual(oldCall.body.keep, [], 'no keep list sent to a host that ignores it')
  console.log('old-host ok: artifacts left untouched until the host restarts')
}

// ---- 完成态：done 已回填
const doneEl = mountDialog(seq({ done: { ok: true, logs: { removed: ['a'], bytes: 4096 }, artifacts: { removed: ['b'], kept: ['c'], bytes: 1536 } } }))
const doneTree = doneEl.type(doneEl.props)
const doneJson = JSON.stringify(doneTree)
assert.ok(doneJson.includes('已删除'), 'success line rendered')
assert.ok(doneJson.includes('保留 1 个'), 'kept count rendered')
assert.ok(doneJson.includes('5.5 KB'), 'freed size rendered: ' + (doneJson.match(/[0-9.]+ (?:B|KB|MB)/g) || []).join(','))
console.log('done state ok: 成功行 + 保留数 + 释放体积')

// ---- 悬停预览：图片走 data URL，文本走 <pre>
{
  const hover = { path: 'E:/ws/report.md', left: 100, top: 80, width: 360 }
  const imagePreview = { path: 'E:/ws/report.md', data: { ok: true, kind: 'image', name: 'report.md', bytes: 2048, dataUrl: 'data:image/png;base64,AAAA' } }
  const el = mountDialog(seq({ hover, preview: imagePreview }))
  const tree = el.type(el.props)
  assert.ok(JSON.stringify(tree).includes('dst-preview'), 'hover card rendered')
  const card = tree.children[1]
  assert.ok(card && String(card.props.className).includes('dst-preview'), 'card sits next to the modal')
  const imgHost = card.children[1].children[0]
  const imgEl = imgHost.type(imgHost.props)
  assert.equal(imgEl.type, 'img', 'image preview renders an <img>')
  assert.ok(String(imgEl.props.src).startsWith('data:image/png'), 'image preview served as a data url')

  const textPreview = { path: 'E:/ws/report.md', data: { ok: true, kind: 'text', name: 'notes.txt', bytes: 20, text: 'hello\nworld' } }
  const el2 = mountDialog(seq({ hover, preview: textPreview }))
  const card2 = el2.type(el2.props).children[1]
  const preHost = card2.children[1].children[0]
  const preEl = preHost.type(preHost.props)
  assert.equal(preEl.type, 'pre', 'plain text preview renders a <pre>')
  assert.ok(String(preEl.props.className).includes('dst-preview-text'), 'text preview class')
  assert.ok(preEl.children[0].includes('hello'), 'text content present')

  // Markdown：.md 走小渲染器，且原文里的标签被转义
  const mdPreview = { path: 'E:/ws/report.md', data: { ok: true, kind: 'text', name: 'readme.md', bytes: 40, text: '# 标题\n**粗** <script>x</script>' } }
  const el3 = mountDialog(seq({ hover, preview: mdPreview }))
  const card3 = el3.type(el3.props).children[1]
  const mdHost = card3.children[1].children[0]
  const mdEl = mdHost.type(mdHost.props)
  assert.equal(mdEl.type, 'div')
  assert.ok(String(mdEl.props.className).includes('dst-preview-md'), 'markdown container')
  const html = mdEl.props.dangerouslySetInnerHTML.__html
  assert.ok(html.includes('<h3>'), 'heading rendered')
  assert.ok(html.includes('<strong>粗</strong>'), 'bold rendered')
  assert.ok(!html.includes('<script>'), 'raw html escaped')
  assert.ok(html.includes('&lt;script&gt;'), 'escaped tag kept as text')
  console.log('preview ok: 图片走 data URL、文本走 <pre>、Markdown 走小渲染器（HTML 已转义）')
}

// ---- 打开 / 在文件夹中显示
{
  const collect = (node, out) => {
    if (!node) return out
    if (Array.isArray(node)) { for (const kid of node) collect(kid, out); return out }
    if (typeof node !== 'object') return out
    if (node.props) out.push(node)
    if (node.children) collect(node.children, out)
    return out
  }
  const el = mountDialog(seq({}))
  const tree = el.type(el.props)
  const icons = collect(tree, []).filter((n) => String(n.props.className || '') === 'dst-icon')
  assert.equal(icons.length, 4, 'two icon buttons per row')

  icons[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolve) => setImmediate(resolve))
  const openCall = fetchCalls[fetchCalls.length - 1]
  assert.equal(openCall.body.op, 'open')
  assert.equal(openCall.body.reveal, false)
  assert.equal(openCall.body.path, 'E:/ws/report.md')

  icons[1].props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolve) => setImmediate(resolve))
  const revealCall = fetchCalls[fetchCalls.length - 1]
  assert.equal(revealCall.body.op, 'open')
  assert.equal(revealCall.body.reveal, true)
  console.log('open ok: 打开 + 在文件夹中显示')
}

// ---- 过滤：只影响可见行，不动统计
{
  const el = mountDialog(seq({ filter: 'run.js' }))
  const text = JSON.stringify(el.type(el.props))
  assert.ok(text.includes('run.js'), 'matching row stays')
  assert.ok(!text.includes('report.md'), 'non-matching row filtered out')
  assert.ok(text.includes('2 个 · 将删除 2'), 'counts still cover the whole list')
  console.log('filter ok: 过滤不影响统计')
}

// ---- 功能 1 / 5：回收站开关与"导出而不是保留"都进 payload
{
  const find = (node, pred, out) => {
    if (!node) return out
    if (Array.isArray(node)) { for (const kid of node) find(kid, pred, out); return out }
    if (typeof node !== 'object') return out
    if (node.props && pred(node)) out.push(node)
    if (node.children) find(node.children, pred, out)
    return out
  }
  const confirmOf = (tree) => find(tree, (n) => String(n.props.className || '').includes('danger'), [])[0]

  const elTrash = mountDialog(seq({}))
  const treeTrash = elTrash.type(elTrash.props)
  const textTrash = JSON.stringify(treeTrash)
  assert.ok(textTrash.includes('原创作者 Weilong'), 'author credit rendered inside the dialog')
assert.ok(textTrash.includes('回收站'), 'trash option rendered')
  assert.ok(textTrash.includes('复制到桌面导出目录'), 'export option rendered')
  confirmOf(treeTrash).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const trashCall = fetchCalls[fetchCalls.length - 1]
  assert.equal(trashCall.body.trash, true, 'trash on by default in the UI')
  assert.equal(trashCall.body.keepMode, 'stay')

  const elNoTrash = mountDialog(seq({ opts: { keepMode: 'stay', trash: false, grouped: true } }))
  confirmOf(elNoTrash.type(elNoTrash.props)).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetchCalls[fetchCalls.length - 1].body.trash, false, 'trash can be switched off')

  const elExport = mountDialog(seq({ opts: { keepMode: 'export', trash: true, grouped: true }, keep: { 'e:/ws/report.md': true } }))
  confirmOf(elExport.type(elExport.props)).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const exportCall = fetchCalls[fetchCalls.length - 1]
  assert.equal(exportCall.body.keepMode, 'export', 'export mode sent')
  assert.deepEqual(exportCall.body.keep, ['E:/ws/report.md'])
  console.log('opts ok: 回收站默认开、可关；导出模式进 payload')
}

// ---- 纯文字会话（0 个产物）也必须能选回收站
{
  const textPlan = Object.assign({}, PLAN, {
    artifacts: [],
    skipped: [],
    totals: { artifactFiles: 0, artifactBytes: 0, logBytes: 4096, cacheBytes: 2048 },
  })
  const el = mountDialog(seq({ plan: textPlan }))
  const tree = el.type(el.props)
  const text = JSON.stringify(tree)
  assert.ok(text.includes('整个会话记录先进回收站'), 'record-level trash option rendered without artifacts')
  assert.ok(text.includes('日志目录和投影缓存会一起搬进回收站'), 'record-level explanation rendered')
  assert.ok(!text.includes('复制到桌面导出目录'), 'export option hidden when there is nothing to export')
  assert.ok(!text.includes('dst-list-row'), 'no artifact list for a text-only session')

  const walk = (node, out) => {
    if (!node) return out
    if (Array.isArray(node)) { for (const kid of node) walk(kid, out); return out }
    if (typeof node !== 'object') return out
    if (node.props) out.push(node)
    if (node.children) walk(node.children, out)
    return out
  }
  const confirm = walk(tree, []).find((n) => n.props && String(n.props.className || '').includes('danger'))
  confirm.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const call = fetchCalls[fetchCalls.length - 1]
  assert.equal(call.body.op, 'delete')
  assert.equal(call.body.trash, true, 'trash flag still sent for a text-only session')
  assert.deepEqual(call.body.keep, [])
  console.log('text-only ok: 0 个产物时也能选回收站')
}

// ---- 功能 6：占用预检的标签与提示
{
  const el = mountDialog(seq({}))
  const text = JSON.stringify(el.type(el.props))
  assert.ok(text.includes('可能被占用'), 'locked tag rendered')
  assert.ok(text.includes('已默认勾成'), 'locked warning explains the default')
  console.log('lock ok: 被占用文件有标签 + 顶部提示')
}

// ---- 功能 3：按目录分组 + 目录级三态勾选
{
  const el = mountDialog(seq({}))
  const tree = el.type(el.props)
  const text = JSON.stringify(tree)
  assert.ok(text.includes('dst-group'), 'groups rendered')
  const collect = (node, out) => {
    if (!node) return out
    if (Array.isArray(node)) { for (const kid of node) collect(kid, out); return out }
    if (typeof node !== 'object') return out
    if (node.props) out.push(node)
    if (node.children) collect(node.children, out)
    return out
  }
  const groupChecks = collect(tree, []).filter((n) => String(n.props.className || '').startsWith('dst-group-check'))
  assert.equal(groupChecks.length, 1, 'one group header for a single folder')
  groupChecks[0].props.onClick()
  const seed = stubState.setters[stubState.setters.length - 1]
  assert.deepEqual(Object.keys(seed).sort(), ['e:/ws/report.md', 'e:/ws/run.js'], 'group click ticks the whole folder')
  console.log('group ok: 目录级勾选一次勾中两条')
}

// ---- 功能 8：固定预览 + 缩放
{
  const hover = { path: 'E:/ws/report.md', left: 20, top: 20, width: 360 }
  const imagePreview = { path: 'E:/ws/report.md', data: { ok: true, kind: 'image', name: 'report.md', bytes: 10, dataUrl: 'data:image/png;base64,AAAA' } }
  const el = mountDialog(seq({ hover, preview: imagePreview, viewer: { pinned: true, zoom: 1.5 } }))
  const tree = el.type(el.props)
  const card = tree.children[1]
  assert.ok(String(card.props.className).includes('pinned'), 'pinned card keeps its own class')
  const host = card.children[1].children[0]
  const img = host.type(host.props)
  assert.equal(img.props.style.width, '150%', 'zoom applied to the image')
  const tools = tree.children[1].children[0].children
  assert.ok(JSON.stringify(tools).includes('取消固定'), 'pin toggle offered')
  console.log('viewer ok: 固定卡片 + 150% 缩放')
}

// ---- 功能 1：撤销按钮（回收站）
{
  const doneState = { ok: true, logs: { removed: ['a'], bytes: 4096 }, artifacts: { removed: [], kept: [], trashed: ['x'], bytes: 0, trashToken: '20260101-000000-session-x', trashDir: 'C:/dsh/trash/20260101-000000-session-x' } }
  const el = mountDialog(seq({ done: doneState }))
  const tree = el.type(el.props)
  const text = JSON.stringify(tree)
  assert.ok(text.includes('撤销（从回收站还原）'), 'undo button rendered')
  assert.ok(text.includes('回收站'), 'trash info line rendered')

  const walk = (node, out) => {
    if (!node) return out
    if (Array.isArray(node)) { for (const kid of node) walk(kid, out); return out }
    if (typeof node !== 'object') return out
    if (node.props) out.push(node)
    if (node.children) walk(node.children, out)
    return out
  }
  const undoBtn = walk(tree, []).find((n) => n.type === 'button' && JSON.stringify(n.children || []).includes('撤销（从回收站还原）'))
  assert.ok(undoBtn, 'undo button found in the tree')
  undoBtn.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const undoCall = fetchCalls[fetchCalls.length - 1]
  assert.equal(undoCall.body.op, 'restore')
  assert.equal(undoCall.body.token, '20260101-000000-session-x')
  console.log('undo ok: 撤销回源到 restore op')
}

// ---- 功能 4：批量删除对话框
{
  const batchSessions = {
    list: {
      getSnapshot: () => ({
        ids: ['s1', 's2'],
        byId: {
          s1: { id: 's1', title: '会话一', cwd: 'E:/ws', updatedAt: 2 },
          s2: { id: 's2', title: '会话二', cwd: 'E:/ws', updatedAt: 1 },
        },
      }),
    },
    handleSessionRemoved: () => {},
    refresh: async () => {},
  }
  exported.apply(Object.assign({}, ctx, { inject: (names, cb) => cb({ uiWorkspace: null, sessions: batchSessions }) }))

  const batchMenu = byId['dsh-session-tools.batch']
  assert.ok(batchMenu, 'batch menu item registered')
  assert.equal(batchMenu.meta.order, 501)
  batchMenu.component(Object.assign({ sessionId: 's1' }, menuProps)).props.onClick({ preventDefault() {}, stopPropagation() {} })

  resetHooks([])
  const overlay = byId['dsh-session-tools.dialog'].component({})
  const children = overlay.type === react.Fragment ? overlay.children : [overlay]
  const batchEl = children.find((child) => child && child.type && child.type.name === 'BatchDeleteDialog')
  assert.ok(batchEl, 'batch dialog mounted in the overlay')
  const batchTree = batchEl.type(Object.assign({}, batchEl.props))
  const batchText = JSON.stringify(batchTree)
  assert.ok(batchText.includes('批量删除会话'), 'batch title')
  assert.ok(batchText.includes('会话一') && batchText.includes('会话二'), 'candidates listed')
  console.log('batch ok: 菜单项 + 候选列表')
}

// ---- 宿主版本对不上：要明确说出来，而不是让人对着按钮发呆
{
  const api = loaded.exports.apply.__test
  assert.ok(api && typeof api.HostMismatch === 'function', 'test hooks exposed')
  const HostMismatch = api.HostMismatch
  assert.equal(api.hostCaps(null, 'purge'), true, 'unknown host counts as capable')
  assert.equal(api.hostCaps({ reached: true, caps: { purge: true } }, 'purge'), true)
  assert.equal(api.hostCaps({ reached: true, caps: {} }, 'purge'), false, 'old host reports no purge capability')

  const stale = HostMismatch({ info: { version: '0.0.1', caps: {}, reached: true } })
  const staleText = JSON.stringify(stale)
  assert.ok(staleText.includes('0.0.1') && staleText.includes(api.VERSION), 'both versions shown')

  const same = HostMismatch({ info: { version: api.VERSION, caps: {}, reached: true } })
  assert.equal(same, null, 'nothing rendered when versions match')

  const unknown = HostMismatch({ info: { version: '', caps: {}, reached: false } })
  assert.equal(unknown, null, 'nothing rendered when the host never answered')
  console.log('host mismatch ok: 版本不同才提示，一致或拿不到就静默')
}

// ---- 强制结束并删除：宿主回 still-live 时给入口，点了带 force 重发
{
  const openDialog = (states) => {
    resetHooks(states)
    const overlay = byId['dsh-session-tools.dialog'].component({})
    const kids = overlay.type === react.Fragment ? overlay.children : [overlay]
    return kids.find((child) => child && child.type && child.type.name === 'DeleteSessionDialog')
  }
  const walk2 = (node, out) => {
    if (!node) return out
    if (Array.isArray(node)) { for (const kid of node) walk2(kid, out); return out }
    if (typeof node !== 'object') return out
    if (node.props) out.push(node)
    if (node.children) walk2(node.children, out)
    return out
  }
  const btnText = (node) => JSON.stringify(node.children || [])

  // forceAvail 是最后一个 hook：先在 seq 末尾塞 true
  const seqForce = [
    { sessionId: 'session-x' }, PLAN, '', false, false, {}, null, '', false, null, null,
    { keepMode: 'stay', trash: true, grouped: true }, {}, { pinned: false, zoom: 1 },
    { text: '', busy: false }, true,
  ]
  const el = openDialog(seqForce)
  const tree = el.type(el.props)
  const buttons = walk2(tree, []).filter((n) => n.type === 'button')
  const forceBtn = buttons.find((b) => btnText(b).includes('强制结束并删除'))
  assert.ok(forceBtn, 'force button appears when the host reported still-live')

  forceBtn.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const call = fetchCalls.filter((c) => c.body && c.body.op === 'delete').pop()
  assert.ok(call, 'delete op issued')
  assert.equal(call.body.force, true, 'force flag sent')
  assert.equal(call.body.waitForRelease, false, 'force path does not wait for release')

  // 默认（宿主没报 still-live）不该出现这个按钮
  const offSeq = [
    { sessionId: 'session-x' }, PLAN, '', false, false, {}, null, '', false, null, null,
    { keepMode: 'stay', trash: true, grouped: true }, {}, { pinned: false, zoom: 1 },
    { text: '', busy: false }, false,
  ]
  const el2 = openDialog(offSeq)
  const tree2 = el2.type(el2.props)
  const hasForce = walk2(tree2, []).filter((n) => n.type === 'button').some((b) => btnText(b).includes('强制结束并删除'))
  assert.equal(hasForce, false, 'force button hidden in the normal path')
  console.log('force ok: still-live 时才出现，点击带 force:true 且不等释放')
}

// ---- 回收站面板：列表、还原、彻底删除
{
  const entries = [
    { token: '20260101-000000-session-x', createdAt: '2026-01-01T09:30:00.000Z', sessionId: 'session-x', title: '演示会话', files: 2, bytes: 2048, hasRecord: true },
    { token: '20251231-120000-session-y', createdAt: '2025-12-31T12:00:00.000Z', sessionId: 'session-y', title: '', files: 1, bytes: 512, hasRecord: false },
  ]
  const totals = { batches: 2, files: 3, bytes: 2560 }

  const mountTrash = (states) => {
    resetHooks(states)
    const overlay = byId['dsh-session-tools.dialog'].component({})
    const kids = overlay.type === react.Fragment ? overlay.children : [overlay]
    return kids.find((child) => child && child.type && child.type.name === 'TrashDialog')
  }
  const walk = (node, out) => {
    if (!node) return out
    if (Array.isArray(node)) { for (const kid of node) walk(kid, out); return out }
    if (typeof node !== 'object') return out
    if (node.props) out.push(node)
    if (node.children) walk(node.children, out)
    return out
  }

  const el = mountTrash([{ open: true }, entries, 'C:/u/.dsh/trash', totals, '', '', ''])
  const tree = el.type(el.props)
  const text = JSON.stringify(tree)
  assert.ok(text.includes('回收站'), 'trash dialog title')
  assert.ok(text.includes('演示会话'), 'batch title listed')
  assert.ok(text.includes('含会话记录'), 'record marker shown for a batch that holds the session log')
  assert.ok(text.includes('2.0 KB') || text.includes('2 KB') || text.includes('2048'), 'batch size shown')
  assert.ok(text.includes('还原') && text.includes('彻底删除'), 'row actions present')

  const buttons = walk(tree, []).filter((n) => n.type === 'button')
  const restoreBtn = buttons.find((b) => JSON.stringify(b.children || []).includes('还原'))
  assert.ok(restoreBtn, 'restore button found')
  restoreBtn.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const restoreCall = fetchCalls.filter((c) => c.body && c.body.op === 'restore').pop()
  assert.ok(restoreCall, 'restore op issued')
  assert.equal(restoreCall.body.token, '20260101-000000-session-x')

  // 第一次点「彻底删除」只是把按钮变成「再点一次」；再点才真的删
  const armedEl = mountTrash([{ open: true }, entries, 'C:/u/.dsh/trash', totals, '', '', '20251231-120000-session-y'])
  const armedTree = armedEl.type(armedEl.props)
  assert.ok(JSON.stringify(armedTree).includes('再点一次'), 'armed state renders the confirm label')
  const purgeBtn = walk(armedTree, []).filter((n) => n.type === 'button')
    .find((b) => JSON.stringify(b.children || []).includes('再点一次'))
  purgeBtn.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const purgeCall = fetchCalls.filter((c) => c.body && c.body.op === 'purgeEntry').pop()
  assert.ok(purgeCall, 'purgeEntry op issued after the second click')
  assert.equal(purgeCall.body.token, '20251231-120000-session-y')
  console.log('trash pane ok: 列表 / 含会话记录标记 / 还原 / 彻底删除需二次确认')
}

// ---- 词典齐备
const dict = dicts.find((d) => d.ns === 'session-tools')
assert.ok(dict && dict.dict.zh && dict.dict.en)
for (const key of Object.keys(dict.dict.zh)) assert.ok(dict.dict.en[key], 'missing en for ' + key)
console.log('dictionaries ok:', Object.keys(dict.dict.zh).length, 'keys, zh + en')

console.log('\nCLIENT SELF-TESTS PASSED')
