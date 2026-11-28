window.__ModuleLoader__.load({ id: "dsh-session-tools", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	var react = require("react");
	const h = react.createElement;
	const { useState, useEffect, useCallback } = react;

	const name = "dsh-session-tools";
	const inject = ["slots", "locale"];
	const NS = "session-tools";
	const VERSION = "0.5.15";
	const API = "/session-tools/api";

	let translate = (key) => key;
	function useT() { return translate; }

	/* ------------------------------------------------------------------ 基础 */

	let uiWorkspace = null;
	let sessions = null;
	// 侧栏的"哪条会话属于哪个工作区"存在 workspaces 服务里，跟 sessions 是两个 store。
	// 只刷 sessions 的话，那一行要等你切走再回来才消失。
	let workspaces = null;

	function apiBody(payload, timeoutMs) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs || 30000);
		return fetch(new URL(API, window.location.origin).toString(), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload || {}),
			credentials: "same-origin",
			signal: ctrl.signal,
		}).then(async (res) => {
			const text = await res.text();
			let data = null;
			try { data = text ? JSON.parse(text) : null; } catch { data = null; }
			if (!res.ok) {
				const err = new Error((data && data.error) || ("HTTP " + res.status));
				if (data && data.code) err.code = data.code;
				throw err;
			}
			if (!data || data.ok !== true) {
				const err = new Error((data && data.error) || "request failed");
				if (data && data.code) err.code = data.code;
				throw err;
			}
			return data;
		}).finally(() => clearTimeout(timer));
	}

	function humanBytes(n) {
		const v = Number(n) || 0;
		if (v < 1024) return v + " B";
		if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
		if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
		return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
	}

	function sessionTitle(sessionId, fallback) {
		try {
			if (sessions && sessions.list) {
				const snap = sessions.list.getSnapshot();
				const hit = snap && snap.byId ? snap.byId[sessionId] : null;
				if (hit && typeof hit.displayTitle === "string" && hit.displayTitle !== "") return hit.displayTitle;
			}
		} catch { /* ignore */ }
		return fallback || sessionId;
	}

	/** 当前主面板占着的会话 id（宿主只对 retain 住的会话保留活对象）。 */
	function currentSessionId() {
		try {
			const snap = sessions && sessions.list ? sessions.list.getSnapshot() : null;
			const byId = snap && snap.byId ? snap.byId : null;
			if (!byId) return undefined;
			for (const row of Object.values(byId)) {
				if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id;
			}
		} catch { /* ignore */ }
		return undefined;
	}

	/** 删完立刻把这一行从本地列表摘掉，再拉一次权威列表。 */
	/**
	 * 让侧栏立刻和磁盘对齐。
	 * - workspaces.refreshSnapshot()：工作区成员关系（侧栏那一行属于谁）
	 * - sessions.refresh()：会话列表本身
	 * 只调其中一个，就会出现"删完了但那一行还在，切走再回来才没"。
	 */
	async function refreshLists() {
		try {
			if (workspaces && typeof workspaces.refreshSnapshot === "function") workspaces.refreshSnapshot();
		} catch { /* 版本不同，忽略 */ }
		try {
			if (sessions && typeof sessions.refresh === "function") await sessions.refresh();
		} catch { /* 忽略 */ }
		try {
			if (workspaces && typeof workspaces.refreshSnapshot === "function") workspaces.refreshSnapshot();
		} catch { /* 忽略 */ }
	}

	/**
	 * 删完再补刷两次（0.8s / 2s）。
	 * 宿主那边"放掉会话对象"是异步的：如果它晚一点点才松手，第一次刷新会把它又拉回来，
	 * 于是看起来"删了还在"。补两次基本能追上，不用重启也不用重载窗口。
	 */
	function scheduleLateRefresh() {
		const again = () => { refreshLists().catch(() => {}); };
		setTimeout(again, 800);
		setTimeout(again, 2000);
	}

	async function evictSessionRow(sessionId) {
		try {
			if (sessions && typeof sessions.handleSessionRemoved === "function") sessions.handleSessionRemoved(sessionId);
		} catch { /* ignore */ }
		await refreshLists();
	}

	/* --------------------------------------------------------------- 删除请求状态 */

	let pending = null;
	const watchers = new Set();

	function setPending(next) {
		pending = next;
		for (const fn of [...watchers]) {
			try { fn(pending); } catch { /* ignore */ }
		}
	}

	function usePending() {
		const [value, setValue] = useState(pending);
		useEffect(() => {
			watchers.add(setValue);
			setValue(pending);
			return () => { watchers.delete(setValue); };
		}, []);
		return value;
	}

	function requestDeletion(sessionId, title) {
		setPending({ sessionId, title: title || "" });
	}

	/* ------------------------------------------------------------------ 图标 */

	function TrashIcon({ size }) {
		const s = size || 14;
		return h("svg", {
			width: s, height: s, viewBox: "0 0 16 16", fill: "none",
			stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round",
			"aria-hidden": "true", focusable: "false",
		},
			h("path", { d: "M2.5 4.2h11" }),
			h("path", { d: "M6.3 4.2V3.1c0-.5.4-.9.9-.9h1.6c.5 0 .9.4.9.9v1.1" }),
			h("path", { d: "M3.9 4.2l.6 8.2c0 .6.5 1 1.1 1h4.8c.6 0 1.1-.4 1.1-1l.6-8.2" }),
			h("path", { d: "M6.6 6.6v4.4M9.4 6.6v4.4" }),
		);
	}

	/* -------------------------------------------------------------- 会话菜单项 */

	function DeleteSessionMenuItem(props) {
		const t = useT();
		const sessionId = props && props.sessionId;
		const useMenuOpenState = props && props.useMenuOpenState;
		if (!sessionId) return null;
		return h("button", {
			type: "button",
			role: "menuitem",
			className: "dst-menu-item",
			title: t("menu.deleteSession"),
			onClick: (event) => {
				event.preventDefault();
				event.stopPropagation();
				try { if (typeof useMenuOpenState === "function") useMenuOpenState()[1](false); } catch { /* ignore */ }
				requestDeletion(sessionId, props && props.displayTitle);
			},
			style: {
				display: "flex", alignItems: "center", gap: 8, width: "100%",
				padding: "6px 10px", border: 0, borderRadius: 6,
				background: "transparent", color: "var(--dsw-alias-label-primary, inherit)",
				font: "13px/1.3 inherit", textAlign: "left", cursor: "pointer",
			},
		},
			h(TrashIcon, { size: 14 }),
			h("span", { style: { flex: 1 } }, t("menu.deleteSession")),
		);
	}

	/* ---------------------------------------------------- 批量删除菜单项（v0.5） */

	function StackIcon() {
		return h("svg", {
			width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
			stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round",
			"aria-hidden": "true", focusable: "false",
		},
			h("path", { d: "M2.5 5.2h11" }),
			h("path", { d: "M2.5 8.4h11" }),
			h("path", { d: "M2.5 11.6h7" }),
			h("path", { d: "M11.4 10.4l1.2 1.2 2.1-2.4" }));
	}

	function BatchDeleteMenuItem(props) {
		const t = useT();
		const sessionId = props && props.sessionId;
		const useMenuOpenState = props && props.useMenuOpenState;
		if (!sessionId) return null;
		return h("button", {
			type: "button",
			role: "menuitem",
			className: "dst-menu-item",
			title: t("menu.batchDelete"),
			onClick: (event) => {
				event.preventDefault();
				event.stopPropagation();
				try { if (typeof useMenuOpenState === "function") useMenuOpenState()[1](false); } catch { /* ignore */ }
				requestBatchDelete(sessionId);
			},
			style: {
				display: "flex", alignItems: "center", gap: 8, width: "100%",
				padding: "6px 10px", border: 0, borderRadius: 6,
				background: "transparent", color: "var(--dsw-alias-label-primary, inherit)",
				font: "13px/1.3 inherit", textAlign: "left", cursor: "pointer",
			},
		},
			h(StackIcon),
			h("span", { style: { flex: 1 } }, t("menu.batchDelete")),
		);
	}

	/* ---------------------------------------------------------------- 确认对话框 */

	function Row({ label, value, muted }) {
		return h("div", { className: "dst-row" },
			h("span", { className: "dst-row-label" }, label),
			h("span", { className: "dst-row-value" + (muted ? " muted" : "") }, value));
	}

	/* ------------------------------------------------------- 预览 / 打开 */

	const previewCache = new Map();
	let hoverTimer = null;

	function previewKey(path) { return String(path || "").toLowerCase(); }

	function loadPreview(sessionId, filePath) {
		const key = previewKey(filePath);
		if (previewCache.has(key)) return Promise.resolve(previewCache.get(key));
		return apiBody({ op: "preview", sessionId, path: filePath }, 30000).then((data) => {
			previewCache.set(key, data);
			return data;
		});
	}

	/** 悬停卡片贴在行旁边：右边放不下就翻到左边，纵向夹在视口里。 */
	function cardPosition(rect) {
		const width = 360;
		const height = 320;
		const vw = (typeof window !== "undefined" && window.innerWidth) || 1280;
		const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
		let left = rect.right + 12;
		if (left + width > vw - 12) left = Math.max(12, rect.left - width - 12);
		const top = Math.min(Math.max(12, rect.top - 6), Math.max(12, vh - height - 12));
		return { left: left, top: top, width: width };
	}

	function OpenIcon() {
		return h("svg", {
			width: 13, height: 13, viewBox: "0 0 16 16", fill: "none",
			stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round",
			"aria-hidden": "true", focusable: "false",
		},
			h("path", { d: "M9.5 2.5h4v4" }),
			h("path", { d: "M13.5 2.5L7.5 8.5" }),
			h("path", { d: "M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" }));
	}

	function FolderIcon() {
		return h("svg", {
			width: 13, height: 13, viewBox: "0 0 16 16", fill: "none",
			stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round",
			"aria-hidden": "true", focusable: "false",
		},
			h("path", { d: "M2 4.2c0-.5.4-.9.9-.9h3l1.2 1.3h5c.5 0 .9.4.9.9v6.3c0 .5-.4.9-.9.9H2.9c-.5 0-.9-.4-.9-.9z" }));
	}

	/** 产物来源标签：交付物 / 写入 / 编辑。 */
	function sourceTags(sources, t) {
		const list = Array.isArray(sources) ? sources : [];
		const tags = [];
		if (list.indexOf("presented") !== -1) tags.push(h("span", { key: "p", className: "dst-tag presented" }, t("row.presented")));
		if (list.indexOf("write") !== -1) tags.push(h("span", { key: "w", className: "dst-tag" }, t("row.written")));
		if (list.indexOf("edit") !== -1 || list.indexOf("str-replace-editor") !== -1) tags.push(h("span", { key: "e", className: "dst-tag" }, t("row.edited")));
		return tags;
	}

	/** Markdown 走一个极小的渲染器：先整体转义，再认标题/列表/代码/粗体/行内码。 */
	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function renderMarkdown(source) {
		const lines = String(source || "").split(/\r?\n/)
		const out = []
		let inCode = false
		let inList = false
		const closeList = () => { if (inList) { out.push("</ul>"); inList = false } }
		for (const line of lines) {
			if (/^\s*```/.test(line)) {
				closeList()
				out.push(inCode ? "</code></pre>" : "<pre class=\"dst-md-code\"><code>")
				inCode = !inCode
				continue
			}
			if (inCode) { out.push(escapeHtml(line) + "\n"); continue }
			const heading = /^(#{1,6})\s+(.*)$/.exec(line)
			if (heading) {
				closeList()
				const level = Math.min(6, heading[1].length + 2)
				out.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">")
				continue
			}
			const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line)
			if (bullet) {
				if (!inList) { out.push("<ul>"); inList = true }
				out.push("<li>" + inlineMarkdown(bullet[2]) + "</li>")
				continue
			}
			closeList()
			if (line.trim() === "") { out.push("<p class=\"dst-md-gap\"></p>"); continue }
			out.push("<p>" + inlineMarkdown(line) + "</p>")
		}
		closeList()
		if (inCode) out.push("</code></pre>")
		return out.join("")
	}

	function inlineMarkdown(text) {
		return escapeHtml(text)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
	}

	function isMarkdown(name) { return /\.(md|markdown)$/i.test(String(name || "")); }

	function PreviewBody({ state, t, zoom }) {
		if (!state) return null;
		if (state.loading) return h("div", { className: "dst-preview-note" }, t("preview.loading"));
		if (state.error) return h("div", { className: "dst-preview-note" }, state.error);
		const data = state.data;
		if (!data) return null;
		if (data.kind === "image") {
			if (!data.dataUrl) return h("div", { className: "dst-preview-note" }, t("preview.tooLarge"));
			const scale = typeof zoom === "number" && zoom > 0 ? zoom : 1;
			return h("img", {
				className: "dst-preview-img",
				src: data.dataUrl,
				alt: data.name,
				style: scale === 1 ? undefined : { maxWidth: "none", maxHeight: "none", width: Math.round(scale * 100) + "%" },
			});
		}
		if (data.kind === "text") {
			const raw = String(data.text || "");
			if (isMarkdown(data.name)) {
				return h("div", {
					className: "dst-preview-md",
					dangerouslySetInnerHTML: { __html: renderMarkdown(raw.split(/\r?\n/).slice(0, 60).join("\n")) },
				});
			}
			const lines = raw.split(/\r?\n/).slice(0, 18).join("\n");
			return h("pre", { className: "dst-preview-text" }, lines || "(空文件)");
		}
		if (data.bytes === 0) return h("div", { className: "dst-preview-note" }, t("preview.empty"));
		return h("div", { className: "dst-preview-note" }, t("preview.binary"));
	}

	/* ------------------------------------------------ 按目录分组（v0.5 · 功能 3） */

	/** 把一个绝对路径压成"相对 cwd"的展示名；不在 cwd 里就取末两级。 */
	function shortPath(target, cwd) {
		const text = String(target || "");
		if (typeof cwd === "string" && cwd !== "") {
			const base = cwd.replace(/[\\/]+$/, "");
			const lower = base.toLowerCase();
			if (text.toLowerCase().startsWith(lower)) {
				const rest = text.slice(base.length).replace(/^[\\/]+/, "");
				if (rest !== "") return rest;
			}
		}
		const parts = text.split(/[\\/]+/).filter(Boolean);
		if (parts.length <= 2) return text;
		return parts.slice(-2).join("/");
	}

	function dirKey(target) {
		const text = String(target || "");
		const idx = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
		return idx > 0 ? text.slice(0, idx) : "";
	}

	/** [{dir, label, files:[...]}]，按目录名排序；同一目录内的顺序保持原样。 */
	function groupByDir(files, cwd) {
		const map = new Map();
		for (const item of files) {
			const dir = dirKey(item.path);
			if (!map.has(dir)) map.set(dir, []);
			map.get(dir).push(item);
		}
		const groups = [];
		for (const [dir, list] of map) {
			groups.push({
				dir: dir,
				label: shortPath(dir, cwd) || ".",
				files: list,
				bytes: list.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
			});
		}
		groups.sort((a, b) => a.label.localeCompare(b.label));
		return groups;
	}



	function DeleteSessionDialog() {
		const t = useT();
		const req = usePending();
		const [plan, setPlan] = useState(null);
		const [error, setError] = useState("");
		const [loading, setLoading] = useState(false);
		const [busy, setBusy] = useState(false);
		const [keep, setKeep] = useState({});
		const [done, setDone] = useState(null);
		const [filter, setFilter] = useState("");
		const [onlyPresented, setOnlyPresented] = useState(false);
		const [hover, setHover] = useState(null);
		const [preview, setPreview] = useState(null);
		const [opts, setOpts] = useState({ keepMode: "stay", trash: true, grouped: true });
		const [collapsed, setCollapsed] = useState({});
		const [viewer, setViewer] = useState({ pinned: false, zoom: 1 });
		const [notice, setNotice] = useState({ text: "", busy: false });
		// 放在最后：宿主回 still-live 时才置真，用来显示「强制结束并删除」
		const [forceAvail, setForceAvail] = useState(false);
		const host = useHostInfo();
		const canForce = hostCaps(host, "force");

		const sessionId = req ? req.sessionId : null;

		useEffect(() => {
			if (!sessionId) {
				setPlan(null); setError(""); setDone(null); setBusy(false); setKeep({});
				setFilter(""); setOnlyPresented(false); setHover(null); setPreview(null);
				setCollapsed({}); setViewer({ pinned: false, zoom: 1 }); setNotice({ text: "", busy: false });
				return;
			}
			let alive = true;
			setLoading(true);
			setError("");
			setDone(null);
			setNotice({ text: "", busy: false });
			apiBody({ op: "plan", sessionId })
				.then((data) => {
					if (!alive) return;
					setPlan(data.plan);
					// 预检：可能被其它程序占着的文件默认勾成“保留”，免得确认后一堆删除失败。
					const seed = {};
					for (const item of (data.plan && data.plan.artifacts) || []) {
						if (item.locked === true) seed[String(item.path).toLowerCase()] = true;
					}
					setKeep(seed);
				})
				.catch((err) => { if (alive) setError(String(err && err.message ? err.message : err)); })
				.finally(() => { if (alive) setLoading(false); });
			return () => { alive = false; };
		}, [sessionId]);

		const close = useCallback(() => { if (!busy) setPending(null); }, [busy]);

		useEffect(() => {
			if (!req) return undefined;
			const onKey = (event) => {
				if (event.key === "Escape") { event.stopPropagation(); close(); }
			};
			window.addEventListener("keydown", onKey, true);
			return () => window.removeEventListener("keydown", onKey, true);
		}, [req, close]);

		if (!req) return null;

		const title = req.title || sessionTitle(sessionId, sessionId);
		const artifactFiles = plan ? plan.artifacts || [] : [];
		const totals = plan ? plan.totals || {} : {};
		const recordBytes = (totals.logBytes || 0) + (totals.cacheBytes || 0);

		/* 勾选 = 保留。默认全不勾，也就是维持老行为（产物跟着会话一起删）。 */
		// 新客户端可能被旧宿主（0.2.x，不认 keep）拉着跑：那时候一律不删产物，
		// 免得“以为勾了保留”结果被老代码全删。
		const supportsKeep = Boolean(plan && plan.caps && plan.caps.keep === true);
		const keepKey = (p) => String(p || "").toLowerCase();
		const keptFiles = artifactFiles.filter((item) => keep[keepKey(item.path)] === true);
		const deleteFiles = artifactFiles.filter((item) => keep[keepKey(item.path)] !== true);
		const keptBytes = keptFiles.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
		const deleteBytes = deleteFiles.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
		const toggleKeep = (path) => setKeep((prev) => {
			const key = keepKey(path);
			const next = Object.assign({}, prev);
			if (next[key]) delete next[key];
			else next[key] = true;
			return next;
		});
		const keepAll = () => setKeep(() => {
			const next = {};
			for (const item of artifactFiles) next[keepKey(item.path)] = true;
			return next;
		});
		const keepNone = () => setKeep({});

		/* 过滤只影响“看得见哪些行”，不影响统计与批量按钮（它们永远作用于整个清单）。 */
		const needle = filter.trim().toLowerCase();
		const visibleFiles = artifactFiles.filter((item) => {
			if (onlyPresented && !(Array.isArray(item.sources) ? item.sources : []).includes("presented")) return false;
			if (needle === "") return true;
			return String(item.path || "").toLowerCase().includes(needle);
		});

		const supportsPreview = Boolean(plan && plan.caps && plan.caps.preview === true);
		const supportsOpen = Boolean(plan && plan.caps && plan.caps.open === true);

		const openArtifact = async (item, reveal) => {
			setError("");
			try {
				await apiBody({ op: "open", sessionId, path: item.path, reveal: reveal === true }, 30000);
			} catch (err) {
				setError(t("notice.openFailed").replace("{msg}", String(err && err.message ? err.message : err)));
			}
		};

		const hoverIn = (event, item) => {
			if (!supportsPreview) return;
			const rect = event.currentTarget.getBoundingClientRect();
			const pos = cardPosition(rect);
			if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
			hoverTimer = setTimeout(() => {
				hoverTimer = null;
				const key = previewKey(item.path);
				setHover({ path: item.path, left: pos.left, top: pos.top, width: pos.width });
				if (previewCache.has(key)) setPreview({ path: item.path, data: previewCache.get(key) });
				else {
					setPreview({ path: item.path, loading: true });
					loadPreview(sessionId, item.path)
						.then((data) => setPreview((cur) => (cur && cur.path === item.path ? { path: item.path, data } : cur)))
						.catch((err) => setPreview((cur) => (cur && cur.path === item.path
							? { path: item.path, error: String(err && err.message ? err.message : err) }
							: cur)));
				}
			}, 140);
		};

		const hoverOut = () => {
			if (viewer.pinned) return;
			if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
			setHover(null);
			setPreview(null);
		};

		const supportsTrash = Boolean(plan && plan.caps && plan.caps.trash === true);
		const supportsExport = Boolean(plan && plan.caps && plan.caps.export === true);
		const lockedFiles = artifactFiles.filter((item) => item.locked === true);

		const undoDelete = async (token) => {
			if (!token || notice.busy) return;
			setNotice({ text: "", busy: true });
			try {
				const result = await apiBody({ op: "restore", token }, 60000);
				const count = (result.restored || []).length;
				const rows = [
					(count > 0 && !result.alreadyGone) ? t("undo.done").replace("{n}", String(count)) : t("undo.already"),
					result.recordRestored ? t("trash.recordBack") : "",
					(result.conflicts && result.conflicts.length > 0) ? t("undo.conflicts").replace("{n}", String(result.conflicts.length)) : "",
					(result.failed && result.failed.length > 0) ? t("undo.failed").replace("{n}", String(result.failed.length)) : "",
				].filter(Boolean).join("  ");
				setNotice({ text: rows, busy: false });
			} catch (err) {
				setNotice({ text: t("undo.error").replace("{msg}", String(err && err.message ? err.message : err)), busy: false });
			}
			// 删的时候那一行已经从侧栏摘掉了，还原完要重新拉一次列表才回来
			await refreshLists();
		};

		const confirm = async (force) => {
			if (busy) return;
			const forced = force === true;
			setBusy(true);
			setError("");
			if (forced) setForceAvail(false);
			// 删的就是当前打开的这个会话时：先把主面板让出来，宿主的活对象才会退场，
			// 否则文件被删掉而宿主还攥着它，下一个回合就会写日志失败（ENOENT）。
			const wasCurrent = currentSessionId() === sessionId;
			let clearedPanel = false;
			try {
				if (wasCurrent && uiWorkspace && typeof uiWorkspace.clearMain === "function") {
					try { uiWorkspace.clearMain(); clearedPanel = true; } catch { /* ignore */ }
				}
				const result = await apiBody({
					op: "delete",
					sessionId,
					deleteArtifacts: supportsKeep,
					keep: supportsKeep ? keptFiles.map((item) => item.path) : [],
					keepMode: supportsExport && opts.keepMode === "export" ? "export" : "stay",
					trash: supportsTrash && opts.trash === true,
					waitForRelease: wasCurrent === true && !forced,
					force: forced,
				}, 120000);
				setDone(result);
				await evictSessionRow(sessionId);
				scheduleLateRefresh();
				if (wasCurrent) {
					try { if (uiWorkspace && typeof uiWorkspace.startSession === "function") uiWorkspace.startSession(); } catch { /* ignore */ }
				}
			} catch (err) {
				// 会话还在别处被占着（still-live）就别急着把面板开回去，免得来回打架。
				if (clearedPanel && err && err.code !== "still-live" && uiWorkspace && typeof uiWorkspace.openSession === "function") {
					try { uiWorkspace.openSession(sessionId); } catch { /* ignore */ }
				}
				setError(String(err && err.message ? err.message : err));
				// 宿主说“这个会话还开着”：给一个强制入口，不强求用户先去切换
				setForceAvail(!forced && Boolean(err && err.code === "still-live"));
				// 老宿主不认 force：把它当成"版本没对上"，下面会渲染成重启提示
				setBusy(false);
			}
		};

		const body = [];
		body.push(h("div", { key: "title", className: "dst-title" }, t("dialog.title")));
		body.push(h("div", { key: "session", className: "dst-session" }, title));
		body.push(h("div", { key: "hint", className: "dst-hint" }, t("dialog.hint")));

		if (loading) body.push(h("div", { key: "loading", className: "dst-hint" }, t("dialog.loading")));

		const mismatch = h(HostMismatch, { key: "mismatch", info: host });
		if (mismatch) body.push(mismatch);

		if (plan) {
			body.push(h("div", { key: "card", className: "dst-card" },
				h(Row, { label: t("dialog.record"), value: humanBytes(recordBytes) }),
				h(Row, { label: t("dialog.logs"), value: t("dialog.files").replace("{n}", String((plan.log && plan.log.files.length) || 0)) }),
				h(Row, {
					label: t("dialog.artifacts"),
					value: artifactFiles.length === 0
						? t("dialog.files").replace("{n}", "0")
						: supportsKeep
							? t("dialog.artifactsSummary")
								.replace("{total}", String(artifactFiles.length))
								.replace("{del}", String(deleteFiles.length))
								.replace("{kept}", String(keptFiles.length))
							: t("dialog.oldHostKept").replace("{n}", String(artifactFiles.length)),
					muted: artifactFiles.length > 0 && (deleteFiles.length === 0 || !supportsKeep),
				}),
				artifactFiles.length > 0 && supportsKeep
					? h(Row, {
						label: t("dialog.deleteSize"),
						value: humanBytes(deleteBytes) + (keptFiles.length > 0 ? "  ·  " + t("dialog.keptSize") + " " + humanBytes(keptBytes) : ""),
					})
					: null));

			if (artifactFiles.length > 0 && !supportsKeep) {
				body.push(h("div", { key: "oldhost", className: "dst-warn" },
					t("dialog.oldHost").replace("{n}", String(artifactFiles.length))));
			}

			/* 处理方式（功能 5 / 功能 1）：保留的往哪放、要删的进不进回收站。
			   注意：这里**不再**要求有产物——纯文字会话没有产物，但它整个会话记录
			   也能进回收站（可撤销），所以回收站开关必须一直显示。 */
			const hasArtifacts = artifactFiles.length > 0;

			if (supportsKeep) {
				const optionRows = [];
				if (supportsExport && hasArtifacts) {
					optionRows.push(h("div", { key: "keepmode", className: "dst-opts" },
						h("span", { className: "dst-opts-label" }, t("opt.keepMode")),
						h("label", { className: "dst-radio" },
							h("input", {
								type: "radio", name: "keepMode", checked: opts.keepMode !== "export",
								onChange: () => setOpts((prev) => Object.assign({}, prev, { keepMode: "stay" })),
							}),
							h("span", null, t("opt.keepStay"))),
						h("label", { className: "dst-radio" },
							h("input", {
								type: "radio", name: "keepMode", checked: opts.keepMode === "export",
								onChange: () => setOpts((prev) => Object.assign({}, prev, { keepMode: "export" })),
							}),
							h("span", null, t("opt.keepExport")))));
				}
				if (supportsTrash) {
					optionRows.push(h("div", { key: "trash", className: "dst-opts" },
						h("label", { className: "dst-checkline" },
							h("input", {
								type: "checkbox", checked: opts.trash === true,
								onChange: () => setOpts((prev) => Object.assign({}, prev, { trash: !prev.trash })),
							}),
							h("span", null, hasArtifacts ? t("opt.trash") : t("opt.trashRecord"))),
						h("span", { className: "dst-hint" }, hasArtifacts ? t("opt.trashHint") : t("opt.trashRecordHint"))));
				}
				if (optionRows.length > 0) body.push(h("div", { key: "opts", className: "dst-optbox" }, optionRows));

				if (lockedFiles.length > 0) {
					body.push(h("div", { key: "locked", className: "dst-warn" },
						t("opt.locked").replace("{n}", String(lockedFiles.length))));
				}

				if (hasArtifacts) body.push(h("div", { key: "filters", className: "dst-filters" },
					h("input", {
						key: "q",
						type: "text",
						className: "dst-filter-input",
						placeholder: t("filter.placeholder"),
						value: filter,
						onChange: (event) => setFilter(event.target.value),
					}),
					h("label", { key: "p", className: "dst-checkline" },
						h("input", {
							type: "checkbox",
							checked: onlyPresented,
							onChange: () => setOnlyPresented((v) => !v),
						}),
						h("span", null, t("filter.onlyPresented"))),
					h("label", { key: "g", className: "dst-checkline" },
						h("input", {
							type: "checkbox",
							checked: opts.grouped !== false,
							onChange: () => setOpts((prev) => Object.assign({}, prev, { grouped: prev.grouped === false })),
						}),
						h("span", null, t("filter.grouped")))));
				if (hasArtifacts) body.push(h("div", { key: "listhead", className: "dst-list-head" },
					h("span", { className: "dst-hint" }, t("dialog.keepHint")),
					h("span", { className: "dst-list-actions" },
						h("button", { key: "all", type: "button", className: "dst-mini", onClick: keepAll }, t("dialog.keepAll")),
						h("button", { key: "none", type: "button", className: "dst-mini", onClick: keepNone }, t("dialog.keepNone")))));

				const listCwd = plan.cwd || "";

				const rowNode = (item) => {
					const kept = keep[keepKey(item.path)] === true;
					const active = hover && hover.path === item.path;
					return h("div", {
						key: item.path,
						className: "dst-list-row" + (kept ? " kept" : "") + (active ? " active" : ""),
						title: item.path + (kept ? "  ·  " + t("dialog.kept") : ""),
						onMouseEnter: (event) => hoverIn(event, item),
						onMouseLeave: hoverOut,
						onDoubleClick: () => { if (supportsOpen) openArtifact(item, false); },
					},
						h("input", {
							type: "checkbox",
							checked: kept,
							onChange: () => toggleKeep(item.path),
						}),
						h("span", {
							className: "dst-list-path",
							onClick: () => toggleKeep(item.path),
						}, shortPath(item.path, listCwd)),
						item.locked === true ? h("span", { className: "dst-tag locked", title: t("row.locked") }, t("row.locked")) : null,
						h("span", { className: "dst-list-tags" }, sourceTags(item.sources, t)),
						supportsOpen
							? h("span", { className: "dst-row-actions" },
								h("button", {
									type: "button", className: "dst-icon", title: t("row.open"), "aria-label": t("row.open"),
									onClick: (event) => { event.preventDefault(); event.stopPropagation(); openArtifact(item, false); },
								}, h(OpenIcon)),
								h("button", {
									type: "button", className: "dst-icon", title: t("row.reveal"), "aria-label": t("row.reveal"),
									onClick: (event) => { event.preventDefault(); event.stopPropagation(); openArtifact(item, true); },
								}, h(FolderIcon)))
							: null,
						h("span", { className: "dst-list-size" }, humanBytes(item.bytes)));
				};

				const groups = [];
				if (visibleFiles.length === 0) {
					groups.push(h("div", { key: "empty", className: "dst-hint", style: { padding: "4px 2px" } }, t("filter.empty")));
				} else if (opts.grouped === false) {
					for (const item of visibleFiles.slice(0, 800)) groups.push(rowNode(item));
				} else {
					let shown = 0;
					for (const group of groupByDir(visibleFiles, listCwd)) {
						if (shown >= 800) break;
						const members = group.files.slice(0, 800 - shown);
						shown += members.length;
						const keptInGroup = members.filter((item) => keep[keepKey(item.path)] === true).length;
						const state = keptInGroup === 0 ? "none" : (keptInGroup === members.length ? "all" : "some");
						const isCollapsed = collapsed[group.dir] === true;
						groups.push(h("div", { key: "h:" + group.dir, className: "dst-group" },
							h("button", {
								type: "button",
								className: "dst-group-check " + state,
								title: state === "all" ? t("group.clearAll") : t("group.keepAll"),
								"aria-label": t("group.toggle"),
								onClick: () => setKeep((prev) => {
									const next = Object.assign({}, prev);
									for (const item of members) {
										if (state === "all") delete next[keepKey(item.path)];
										else next[keepKey(item.path)] = true;
									}
									return next;
								}),
							}, state === "all" ? "☑" : state === "some" ? "▣" : "☐"),
							h("button", {
								type: "button",
								className: "dst-group-label",
								onClick: () => setCollapsed((prev) => Object.assign({}, prev, { [group.dir]: !isCollapsed })),
							},
								h("span", { className: "dst-group-arrow" }, isCollapsed ? "▸" : "▾"),
								h("span", { className: "dst-group-dir" }, group.label)),
							h("span", { className: "dst-group-meta" },
								t("group.meta")
									.replace("{n}", String(members.length))
									.replace("{kept}", String(keptInGroup))
									.replace("{size}", humanBytes(group.bytes)))));
						if (!isCollapsed) for (const item of members) groups.push(rowNode(item));
					}
				}

				if (hasArtifacts) body.push(h("div", { key: "list", className: "dst-list" }, groups));
			}

			if (plan.skipped && plan.skipped.length > 0) {
				const inside = plan.skipped.filter((item) => item.reason === "inside-dsh-home").length;
				const outside = plan.skipped.length - inside;
				body.push(h("div", { key: "skipped", className: "dst-hint" },
					t("dialog.skipped")
						.replace("{n}", String(plan.skipped.length))
						.replace("{home}", String(inside))
						.replace("{out}", String(outside))));
			}
		}

		if (done) {
			const trashToken = (done.artifacts && done.artifacts.trashToken) || (done.logs && done.logs.trashToken);
			const exportDir = done.artifacts && done.artifacts.exportDir;
			const trashedCount = ((done.artifacts && done.artifacts.trashed) || []).length;
			const recordTrashed = ((done.logs && done.logs.trashed) || []).length > 0;
			const logTouched = ((done.logs && done.logs.removed) || []).length + ((done.logs && done.logs.trashed) || []).length;

			body.push(h("div", { key: "done", className: "dst-done" },
				t("dialog.done")
					.replace("{logs}", String(logTouched))
					.replace("{files}", String(((done.artifacts && done.artifacts.removed) || []).length))
					.replace("{kept}", String(((done.artifacts && done.artifacts.kept) || []).length))
					.replace("{size}", humanBytes(((done.logs && done.logs.bytes) || 0) + ((done.artifacts && done.artifacts.bytes) || 0)))));

			if (recordTrashed) {
				body.push(h("div", { key: "recordtrash", className: "dst-hint" }, t("done.trashRecord")));
			}

			if (trashedCount > 0 && trashToken) {
				body.push(h("div", { key: "trashinfo", className: "dst-hint" },
					t("done.trash").replace("{n}", String(trashedCount)).replace("{dir}", (done.artifacts && done.artifacts.trashDir) || (done.logs && done.logs.trashDir) || "")));
			}

			if (done.forced) {
				body.push(h("div", { key: "forced", className: "dst-hint" }, t("done.forced")));
			}
			if (done.passes > 1) {
				body.push(h("div", { key: "passes", className: "dst-hint" }, t("done.passes").replace("{n}", String(done.passes))));
			}

			if (exportDir) {
				body.push(h("div", { key: "exportinfo", className: "dst-hint" },
					t("done.export").replace("{dir}", exportDir)));
			}

			const keptList = ((done.artifacts && done.artifacts.kept) || []);
			if (keptList.length > 0) {
				body.push(h("div", { key: "keptlist", className: "dst-hint" },
					t("done.keptList"),
					h("div", { className: "dst-done-list" }, keptList.slice(0, 30).map((p) => h("div", { key: p }, p))),
					keptList.length > 30 ? t("done.keptMore").replace("{n}", String(keptList.length - 30)) : null));
			}

			const failed = []
				.concat(((done.artifacts && done.artifacts.failed) || []).map((row) => row.path + "  ·  " + (row.error || "")))
				.concat(((done.logs && done.logs.failed) || []).map((row) => row.path + "  ·  " + (row.error || "")));
			if (failed.length > 0) {
				body.push(h("div", { key: "failed", className: "dst-error" },
					t("done.failed").replace("{n}", String(failed.length)),
					h("div", { className: "dst-done-list" }, failed.slice(0, 20).map((line) => h("div", { key: line }, line)))));
			}
		}

		if (notice.text) body.push(h("div", { key: "notice", className: "dst-hint" }, notice.text));

		if (error) body.push(h("div", { key: "error", className: "dst-error" }, error));
		if (done && done.pending) {
			body.push(h("div", { key: "pending", className: "dst-warn" }, done.warning || t("done.pending")));
		}
		if (forceAvail && !canForce) {
			body.push(h("div", { key: "forceblocked", className: "dst-hint" }, t("host.forceUnavailable")));
		}

		body.push(h("div", { key: "credit", className: "dst-credit" }, t("credit.line").replace("{v}", VERSION)));

		const ops = [];
		if (done) {
			const token = (done.artifacts && done.artifacts.trashToken) || (done.logs && done.logs.trashToken);
			if (token) {
				ops.push(h("button", {
					key: "undo", type: "button", className: "dst-btn", disabled: notice.busy === true,
					onClick: () => { undoDelete(token); },
				}, notice.busy ? t("undo.running") : t("undo.action")));
			}
			ops.push(h("button", { key: "close", type: "button", className: "dst-btn primary", onClick: () => setPending(null) }, t("dialog.close")));
		} else {
			ops.push(h("button", { key: "cancel", type: "button", className: "dst-btn", onClick: close, disabled: busy }, t("dialog.cancel")));
			// 宿主说“会话还开着”时才出现：不逼用户先去切标签，直接硬停再删
			if (forceAvail) {
				ops.push(h("button", {
					key: "force", type: "button", className: "dst-btn danger",
					onClick: () => confirm(true),
					disabled: busy || !canForce,
					title: canForce ? t("dialog.forceHint") : t("host.staleHint"),
				}, busy ? t("dialog.deleting") : t("dialog.force")));
			}
			ops.push(h("button", {
				key: "ok", type: "button", className: "dst-btn danger", onClick: confirm,
				disabled: busy || loading || !plan,
			}, busy
				? t("dialog.deleting")
				: keptFiles.length > 0
					? t("dialog.confirmKeep").replace("{n}", String(keptFiles.length))
					: t("dialog.confirm")));
		}

		const previewState = preview && hover && preview.path === hover.path ? preview : null;
		const previewIsImage = Boolean(previewState && previewState.data && previewState.data.kind === "image");
		const previewCard = hover
			? h("div", {
				className: "dst-preview" + (viewer.pinned ? " pinned" : ""),
				style: { left: hover.left + "px", top: hover.top + "px", width: (viewer.pinned ? Math.max(hover.width, 420) : hover.width) + "px" },
			},
				h("div", { className: "dst-preview-head" },
					h("span", { className: "dst-preview-name" }, shortPath(hover.path, plan && plan.cwd)),
					h("span", { className: "dst-preview-tools" },
						previewIsImage
							? h("button", {
								type: "button", className: "dst-icon", title: t("preview.zoomOut"), "aria-label": t("preview.zoomOut"),
								onClick: () => setViewer((v) => Object.assign({}, v, { zoom: Math.max(0.5, Math.round((v.zoom - 0.25) * 100) / 100) })),
							}, "−")
							: null,
						previewIsImage
							? h("button", {
								type: "button", className: "dst-icon", title: t("preview.zoomIn"), "aria-label": t("preview.zoomIn"),
								onClick: () => setViewer((v) => Object.assign({}, v, { zoom: Math.min(3, Math.round((v.zoom + 0.25) * 100) / 100) })),
							}, "+")
							: null,
						h("button", {
							type: "button", className: "dst-icon" + (viewer.pinned ? " on" : ""),
							title: viewer.pinned ? t("preview.unpin") : t("preview.pin"),
							"aria-label": t("preview.pin"),
							onClick: () => setViewer((v) => Object.assign({}, v, { pinned: !v.pinned })),
						}, viewer.pinned ? "📌" : "📍"))),
				h("div", { className: "dst-preview-body" },
					h(PreviewBody, { state: previewState, t, zoom: viewer.zoom })))
			: null;

		return h("div", {
			className: "dst-mask",
			role: "dialog",
			"aria-modal": "true",
			onMouseDown: (event) => { if (event.target === event.currentTarget) close(); },
		},
			h("div", { className: "dst-modal" },
				body,
				h("div", { className: "dst-ops" }, ops)),
			previewCard);
	}

	/* ------------------------------------------------- 批量删除（v0.5 · 功能 4） */

	let batchPending = null;
	const batchWatchers = new Set();

	function setBatch(next) {
		batchPending = next;
		for (const fn of [...batchWatchers]) {
			try { fn(batchPending); } catch { /* ignore */ }
		}
	}

	function useBatch() {
		const [value, setValue] = useState(batchPending);
		useEffect(() => {
			batchWatchers.add(setValue);
			setValue(batchPending);
			return () => { batchWatchers.delete(setValue); };
		}, []);
		return value;
	}

	function requestBatchDelete(sessionId) {
		setBatch({
			seedSessionId: sessionId,
			picked: {},
			mode: "trash",
			running: false,
			log: [],
			finished: false,
			caps: null,
		});
	}

	// 磁盘实况（host 的 list）：只用来判断"这条还在不在侧栏账目里"。
	// 侧栏的成员关系是 workspace.json 的账目，账目被摘掉之后目录可能还留在磁盘上，
	// 那种残渣会出现在这里，但不该让人以为侧栏里还有它。
	let hostRowsCache = null;

	function loadHostRows() {
		return apiBody({ op: "list" }, 20000)
			.then((data) => {
				const map = {};
				for (const row of (data && data.sessions) || []) map[row.sessionId] = row;
				hostRowsCache = map;
				return map;
			})
			.catch(() => (hostRowsCache = null));
	}

	function batchCandidates(seedId) {
		let snap = null;
		try { snap = sessions && sessions.list ? sessions.list.getSnapshot() : null; } catch { snap = null; }
		const byId = snap && snap.byId ? snap.byId : {};
		const seed = byId[seedId];
		const cwd = seed && seed.cwd ? seed.cwd : "";
		const rows = [];
		for (const key of Object.keys(byId)) {
			const row = byId[key];
			if (!row) continue;
			if (row.origin === "subagent" || row.blank) continue;
			if (cwd !== "" && row.cwd !== cwd) continue;
			const host = hostRowsCache && hostRowsCache[row.id || key];
			rows.push({
				id: row.id || key,
				title: row.displayTitle || row.title || row.id || key,
				updatedAt: Number(row.updatedAt) || 0,
				archived: row.archived === true,
				// host 说 false = 账目里已经没有了；null/undefined = 不知道，按"在"处理
				residual: Boolean(host && host.registered === false),
			});
		}
		rows.sort((a, b) => b.updatedAt - a.updatedAt);
		return rows;
	}

	function BatchDeleteDialog() {
		const t = useT();
		const req = useBatch();
		const [picked, setPicked] = useState({});
		const [mode, setMode] = useState("trash");
		const [caps, setCaps] = useState(null);
		const [running, setRunning] = useState(false);
		const [log, setLog] = useState([]);
		const [finished, setFinished] = useState(false);
		const [hostTick, setHostTick] = useState(0);
		const [forceable, setForceable] = useState([]);
		const [tokens, setTokens] = useState([]);
		const [undoState, setUndoState] = useState("");

		const seedId = req ? req.seedSessionId : null;

		useEffect(() => {
			if (!req) {
				setPicked({}); setMode("trash"); setCaps(null); setRunning(false); setLog([]); setFinished(false);
				setForceable([]); setTokens([]); setUndoState("");
				return;
			}
			let alive = true;
			apiBody({ op: "ping" }, 15000)
				.then((data) => {
					if (!alive) return;
					const next = data.caps || {};
					setCaps(next);
					if (next.trash !== true) setMode("delete");
				})
				.catch(() => { if (alive) setCaps({}); });
			loadHostRows().then(() => { if (alive) setHostTick((n) => n + 1); });
			return () => { alive = false; };
		}, [req]);

		if (!req) return null;

		const candidates = batchCandidates(seedId);
		const selected = candidates.filter((row) => picked[row.id] === true);
		const toggle = (id) => setPicked((prev) => {
			const next = Object.assign({}, prev);
			if (next[id]) delete next[id];
			else next[id] = true;
			return next;
		});

		const close = () => { if (!running) setBatch(null); };

		// 一批里逐条删：收集失败项（还活着的可以强制）和回收站 token（可以整批撤销）
		const runBatch = async (targets, force) => {
			if (running || targets.length === 0) return;
			setRunning(true);
			const rows = [];
			const live = [];
			const tokens = [];
			for (const row of targets) {
				let ok = true;
				let error = "";
				let code = "";
				try {
					if (currentSessionId() === row.id && uiWorkspace && typeof uiWorkspace.clearMain === "function") {
						try { uiWorkspace.clearMain(); } catch { /* ignore */ }
					}
					const result = await apiBody({
						op: "delete",
						sessionId: row.id,
						deleteArtifacts: mode !== "keep",
						keep: [],
						keepMode: "stay",
						trash: mode === "trash",
						waitForRelease: force !== true,
						force: force === true,
					}, 180000);
					if (result && result.ok === false) {
						ok = false;
						error = result.error || "";
						code = result.code || "";
					} else {
						const token = (result && result.logs && result.logs.trashToken)
							|| (result && result.artifacts && result.artifacts.trashToken);
						if (token) tokens.push(token);
					}
				} catch (err) {
					ok = false;
					error = String(err && err.message ? err.message : err);
					code = (err && err.code) || "";
				}
				if (!ok && code === "still-live") live.push({ id: row.id, title: row.title });
				rows.push({ id: row.id, title: row.title, ok: ok, error: error });
				setLog(rows.slice());
				if (ok) {
					try { if (sessions && typeof sessions.handleSessionRemoved === "function") sessions.handleSessionRemoved(row.id); } catch { /* ignore */ }
				}
			}
			await refreshLists();
			setForceable(live);
			if (tokens.length > 0) setTokens((prev) => prev.concat(tokens));
			setRunning(false);
			setFinished(true);
			scheduleLateRefresh();
		};

		const run = () => runBatch(selected, false);
		const runForce = () => runBatch(forceable, true);

		// 整批撤销：逐条还原本批产生的回收站批次
		const undoBatch = async () => {
			if (running || tokens.length === 0) return;
			setRunning(true);
			setUndoState(t("batch.undoRunning"));
			let done = 0;
			let failed = 0;
			for (const token of tokens) {
				try {
					await apiBody({ op: "restore", token }, 120000);
					done += 1;
				} catch {
					failed += 1;
				}
			}
			setUndoState(failed > 0
				? t("batch.undoPartly").replace("{ok}", String(done)).replace("{bad}", String(failed))
				: t("batch.undoDone").replace("{n}", String(done)));
			setTokens([]);
			await refreshLists();
			setRunning(false);
		};

		const body = [];
		body.push(h("div", { key: "title", className: "dst-title" }, t("batch.title")));
				const residualCount = candidates.filter((row) => row.residual).length;
		body.push(h("div", { key: "hint", className: "dst-hint" }, t("batch.hint").replace("{n}", String(candidates.length))));
		if (residualCount > 0) {
			body.push(h("div", { key: "residual", className: "dst-hint" }, t("batch.residual").replace("{n}", String(residualCount))));
		}

		if (candidates.length === 0) {
			body.push(h("div", { key: "none", className: "dst-hint" }, t("batch.empty")));
		} else {
			body.push(h("div", { key: "list", className: "dst-list dst-batch" },
				candidates.slice(0, 200).map((row) => h("div", {
					key: row.id,
					className: "dst-list-row" + (picked[row.id] ? " kept" : ""),
				},
					h("input", {
						type: "checkbox",
						checked: picked[row.id] === true,
						onChange: () => toggle(row.id),
					}),
					h("span", { className: "dst-list-path", onClick: () => toggle(row.id) },
						row.title,
						row.residual ? h("span", { className: "dst-tag dst-tag-warn" }, t("batch.tagResidual")) : null,
						row.archived ? h("span", { className: "dst-tag" }, t("batch.tagArchived")) : null),
					h("span", { className: "dst-list-size" },
						row.updatedAt > 0 ? new Date(row.updatedAt).toLocaleString() : "")))));

			const trashAllowed = !caps || caps.trash === true;
			body.push(h("div", { key: "modes", className: "dst-opts dst-opts-block" },
				h("span", { className: "dst-opts-label" }, t("batch.artifacts")),
				h("label", { className: "dst-radio" },
					h("input", { type: "radio", name: "batchMode", checked: mode === "trash", disabled: !trashAllowed, onChange: () => setMode("trash") }),
					h("span", null, t("batch.modeTrash"))),
				h("label", { className: "dst-radio" },
					h("input", { type: "radio", name: "batchMode", checked: mode === "delete", onChange: () => setMode("delete") }),
					h("span", null, t("batch.modeDelete"))),
				h("label", { className: "dst-radio" },
					h("input", { type: "radio", name: "batchMode", checked: mode === "keep", onChange: () => setMode("keep") }),
					h("span", null, t("batch.modeKeep")))));
			if (!trashAllowed) body.push(h("div", { key: "nocap", className: "dst-warn" }, t("batch.noTrash")));
		}

		if (log.length > 0) {
			body.push(h("div", { key: "log", className: "dst-list dst-batch-log" }, log.map((row) => h("div", {
				key: row.id,
				className: "dst-list-row" + (row.ok ? " kept" : ""),
			},
				h("span", { className: "dst-list-path" }, row.title),
				h("span", { className: "dst-list-size" }, row.ok ? t("batch.ok") : (row.error || t("batch.fail")))))));
		}

		const failedCount = log.filter((row) => !row.ok).length;
		if (finished) {
			body.push(h("div", { key: "summary", className: failedCount > 0 ? "dst-warn" : "dst-done" },
				t("batch.done").replace("{ok}", String(log.length - failedCount)).replace("{fail}", String(failedCount))));
		}

		// 失败里有"会话还开着"的：给一个强制入口，不用一条条回去处理
		if (forceable.length > 0) {
			body.push(h("div", { key: "forcehint", className: "dst-hint" }, t("batch.forceHint").replace("{n}", String(forceable.length))));
		}
		if (undoState) body.push(h("div", { key: "undo", className: "dst-hint" }, undoState));

		body.push(h("div", { key: "credit", className: "dst-credit" }, t("credit.line").replace("{v}", VERSION)));

		const ops = [];
		ops.push(h("button", { key: "cancel", type: "button", className: "dst-btn", onClick: close, disabled: running }, t("dialog.close")));
		if (tokens.length > 0) {
			ops.push(h("button", {
				key: "undo", type: "button", className: "dst-btn", onClick: undoBatch, disabled: running,
			}, running && undoState ? t("batch.undoRunning") : t("batch.undo").replace("{n}", String(tokens.length))));
		}
		if (forceable.length > 0) {
			ops.push(h("button", {
				key: "force", type: "button", className: "dst-btn danger", onClick: runForce, disabled: running,
			}, t("batch.force").replace("{n}", String(forceable.length))));
		}
		if (!finished) {
			ops.push(h("button", {
				key: "go", type: "button", className: "dst-btn danger", onClick: run,
				disabled: running || selected.length === 0,
			}, running
				? t("batch.running").replace("{done}", String(log.length)).replace("{total}", String(selected.length))
				: t("batch.action").replace("{n}", String(selected.length))));
		}

		return h("div", {
			className: "dst-mask",
			role: "dialog",
			"aria-modal": "true",
			onMouseDown: (event) => { if (event.target === event.currentTarget) close(); },
		},
			h("div", { className: "dst-modal" },
				body,
				h("div", { className: "dst-ops" }, ops)));
	}

	/* ------------------------------------------------- 宿主信息（版本 / 能力） */

	// 界面是磁盘上最新的 client.js，但宿主侧插件是 DSH 启动那一刻加载进内存的。
	// 只刷新窗口不重启进程时，两边版本就会错开：新界面调老宿主的 op 只会得到
	// "unknown op"。所以先 ping 一次，把宿主版本和能力记下来，按能力决定露出哪些按钮。
	let hostInfo = null;
	let hostInfoFlight = null;
	const hostInfoWatchers = new Set();

	function publishHostInfo(next) {
		hostInfo = next;
		for (const fn of [...hostInfoWatchers]) {
			try { fn(hostInfo); } catch { /* ignore */ }
		}
	}

	function loadHostInfo() {
		if (hostInfoFlight) return hostInfoFlight;
		hostInfoFlight = apiBody({ op: "ping" }, 15000)
			.then((data) => {
				publishHostInfo({
					version: String((data && data.version) || ""),
					caps: (data && data.caps) || {},
					reached: true,
				});
			})
			.catch(() => {
				publishHostInfo({ version: "", caps: {}, reached: false });
			})
			.finally(() => { hostInfoFlight = null; });
		return hostInfoFlight;
	}

	function useHostInfo() {
		const [value, setValue] = useState(hostInfo);
		useEffect(() => {
			hostInfoWatchers.add(setValue);
			if (hostInfo) setValue(hostInfo);
			else loadHostInfo();
			return () => { hostInfoWatchers.delete(setValue); };
		}, []);
		return value;
	}

	/**
	 * 宿主能力查询。
	 * 还没拿到（或 ping 不通）时按“支持”处理——把按钮全灰掉只会让人以为坏了；
	 * 真正的旧宿主会正常应答 ping，那时 caps 里就是明确没有，才会置灰。
	 */
	function hostCaps(info, name) {
		if (!info || info.reached !== true) return true;
		return Boolean(info.caps && info.caps[name] === true);
	}

	/**
	 * 宿主和界面对不上时的一条提醒。
	 * 只在两边版本都拿到了、且确实不同的时候才说话。
	 */
	function HostMismatch({ info }) {
		const t = useT();
		if (!info || !info.reached) return null;
		if (!info.version || info.version === VERSION) return null;
		return h("div", { className: "dst-error" },
			t("host.stale")
				.replace("{host}", info.version)
				.replace("{ui}", VERSION));
	}

	/* ------------------------------------------------- 回收站面板（v0.5.5） */

	let trashPending = null;
	const trashWatchers = new Set();

	function setTrash(next) {
		trashPending = next;
		for (const fn of [...trashWatchers]) {
			try { fn(trashPending); } catch { /* ignore */ }
		}
	}

	function useTrash() {
		const [value, setValue] = useState(trashPending);
		useEffect(() => {
			trashWatchers.add(setValue);
			setValue(trashPending);
			return () => { trashWatchers.delete(setValue); };
		}, []);
		return value;
	}

	function openTrashPanel() { setTrash({ open: true }); }

	/* ------------------------------------------------- 手动刷新（侧栏图标 + 页脚按钮） */

	let refreshFlash = "";

	/** 从宿主重新拉一遍会话与工作区列表；顺手给个肉眼可见的反馈。 */
	async function refreshNow(setLabel) {
		const say = (text) => {
			refreshFlash = text;
			if (typeof setLabel === "function") setLabel(text);
		};
		say("…");
		const before = countSidebarRows();
		try {
			await refreshLists();
		} catch { /* 忽略 */ }
		const after = countSidebarRows();
		const delta = before - after;
		say(delta > 0 ? "少了 " + delta + " 条" : (delta < 0 ? "多了 " + (-delta) + " 条" : "已刷新"));
		setTimeout(() => { refreshFlash = ""; if (typeof setLabel === "function") setLabel(""); }, 2200);
	}

	/** 数一下侧栏里现在挂着多少条会话行（只用来给刷新按钮做前后对比）。 */
	function countSidebarRows() {
		try {
			const snap = sessions && sessions.list ? sessions.list.getSnapshot() : null;
			const byId = snap && snap.byId ? snap.byId : {};
			return Object.keys(byId).length;
		} catch {
			return 0;
		}
	}

	/**
	 * 在工作区的搜索图标旁边插一个刷新按钮。
	 * DSH 在那一排没有留 slot，只能贴到搜索按钮后面；用 MutationObserver 跟着 React 的重渲染走，
	 * 组件卸载时连观察器和按钮一起清掉。
	 */
	function useHeaderRefreshButton() {
		useEffect(() => {
			let timer = null;
			let observer = null;
			let flashing = "";
			const mark = "data-dsst-refresh";

			const ensure = () => {
				if (!document.body) return;
				if (document.querySelector("[" + mark + "]")) return;
				const search = [...document.querySelectorAll("button[aria-label]")]
					.find((el) => /搜索|search/i.test(el.getAttribute("aria-label") || ""));
				if (!search || !search.parentElement) return;
				const btn = document.createElement("button");
				btn.setAttribute(mark, "1");
				btn.type = "button";
				btn.className = "dst-header-btn";
				btn.title = "刷新列表（重新从宿主拉一遍会话与工作区）";
				btn.textContent = "⟳";
				btn.style.marginLeft = "2px";
				btn.addEventListener("click", async (event) => {
					event.preventDefault();
					event.stopPropagation();
					btn.textContent = "…";
					await refreshNow();
					btn.textContent = flashing || "✓";
					setTimeout(() => { btn.textContent = "⟳"; }, 1500);
				});
				search.parentElement.insertBefore(btn, search.nextSibling);
			};

			const schedule = () => {
				if (timer) return;
				timer = setTimeout(() => { timer = null; ensure(); }, 400);
			};

			ensure();
			schedule();
			try {
				observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
			} catch { /* 环境不支持就算了 */ }

			return () => {
				if (timer) clearTimeout(timer);
				if (observer) observer.disconnect();
				for (const node of document.querySelectorAll("[" + mark + "]")) node.remove();
			};
		}, []);
	}

	function RefreshActionButton(props) {
		const t = useT();
		const [label, setLabel] = useState("");
		useHeaderRefreshButton();
		const wide = props && props.wide !== false;
		return h("button", {
			type: "button",
			className: "dst-footer-btn",
			title: t("refresh.hint"),
			"aria-label": t("refresh.hint"),
			onClick: (event) => { event.preventDefault(); refreshNow(setLabel); },
		},
			h("span", { className: "dst-refresh-glyph" }, "⟳"),
			wide ? h("span", null, label || t("refresh.list")) : null);
	}

	function TrashActionButton(props) {
		const t = useT();
		const wide = props && props.wide !== false;
		return h("button", {
			type: "button",
			className: "dst-footer-btn",
			title: t("trash.open"),
			"aria-label": t("trash.open"),
			onClick: (event) => {
				event.preventDefault();
				event.stopPropagation();
				openTrashPanel();
			},
		},
			h(BinIcon),
			wide ? h("span", null, t("trash.open")) : null);
	}

	function TrashDialog() {
		const t = useT();
		const req = useTrash();
		const [entries, setEntries] = useState(null);
		const [root, setRoot] = useState("");
		const [totals, setTotals] = useState(null);
		const [busy, setBusy] = useState("");
		const [notice, setNotice] = useState("");
		const [confirmPurge, setConfirmPurge] = useState("");
		// 放在最后：宿主能力（hook 顺序固定，别插在中间）
		const host = useHostInfo();
		const canPurge = hostCaps(host, "purge");

		const load = useCallback(() => {
			setBusy("load");
			apiBody({ op: "trash" }, 30000)
				.then((data) => {
					setEntries(data.entries || []);
					setRoot(data.root || "");
					setTotals(data.totals || null);
				})
				.catch((err) => setNotice(t("trash.loadFailed").replace("{msg}", String(err && err.message ? err.message : err))))
				.finally(() => setBusy(""));
		}, [t]);

		useEffect(() => {
			if (!req) { setEntries(null); setNotice(""); setConfirmPurge(""); setBusy(""); return; }
			load();
		}, [req, load]);

		if (!req) return null;

		const close = () => { if (busy !== "restore") setTrash(null); };

		const restore = async (token) => {
			setBusy("restore");
			setNotice("");
			try {
				const result = await apiBody({ op: "restore", token }, 120000);
				const count = (result.restored || []).length;
				const parts = [(count > 0 && !result.alreadyGone) ? t("undo.done").replace("{n}", String(count)) : t("undo.already")];
				if (result.recordRestored) parts.push(t("trash.recordBack"));
				if (result.conflicts && result.conflicts.length > 0) parts.push(t("undo.conflicts").replace("{n}", String(result.conflicts.length)));
				if (result.failed && result.failed.length > 0) parts.push(t("undo.failed").replace("{n}", String(result.failed.length)));
				setNotice(parts.join("　"));
				await refreshLists();
				load();
			} catch (err) {
				setNotice(t("undo.error").replace("{msg}", String(err && err.message ? err.message : err)));
			} finally {
				setBusy("");
				// 还原会让会话重新出现在侧栏
				await refreshLists();
			}
		};

		const purge = async (token) => {
			if (confirmPurge !== token) { setConfirmPurge(token); return; }
			setBusy("purge");
			setNotice("");
			try {
				await apiBody({ op: "purgeEntry", token }, 60000);
				setConfirmPurge("");
				setNotice(t("trash.purged"));
				load();
			} catch (err) {
				setNotice(t("trash.purgeFailed").replace("{msg}", String(err && err.message ? err.message : err)));
			} finally {
				setBusy("");
			}
		};

		const reveal = async (token) => {
			try {
				await apiBody({ op: "openTrash", token }, 30000);
			} catch (err) {
				setNotice(t("trash.openFailed").replace("{msg}", String(err && err.message ? err.message : err)));
			}
		};

		const body = [];
		body.push(h("div", { key: "title", className: "dst-title" }, t("trash.title")));
		body.push(h("div", { key: "hint", className: "dst-hint" }, t("trash.hint").replace("{days}", "7")));
		const mismatch = h(HostMismatch, { key: "mismatch", info: host });
		if (mismatch) body.push(mismatch);
		if (host && host.reached && host.version && host.version !== VERSION) {
			body.push(h("div", { key: "nopurge", className: "dst-hint" }, t("host.staleHint")));
		}

		if (totals) {
			body.push(h("div", { key: "card", className: "dst-card" },
				h(Row, { label: t("trash.batches"), value: String(totals.batches || 0) }),
				h(Row, { label: t("trash.filesTotal"), value: String(totals.files || 0) }),
				h(Row, { label: t("trash.sizeTotal"), value: humanBytes(totals.bytes || 0) })));
		}

		if (busy === "load" && entries === null) {
			body.push(h("div", { key: "loading", className: "dst-hint" }, t("dialog.loading")));
		}

		if (entries !== null && entries.length === 0) {
			body.push(h("div", { key: "empty", className: "dst-hint" }, t("trash.empty")));
		}

		if (entries && entries.length > 0) {
			body.push(h("div", { key: "list", className: "dst-list dst-trash" },
				entries.map((row) => h("div", { key: row.token, className: "dst-list-row dst-trash-row" },
					h("span", { className: "dst-trash-when" }, row.createdAt ? String(row.createdAt).replace("T", " ").slice(0, 16) : ""),
					h("span", { className: "dst-list-path", title: row.token },
						(row.title || row.sessionId || row.token) + (row.hasRecord ? "　·　" + t("trash.hasRecord") : "")),
					h("span", { className: "dst-trash-size" },
						typeof row.bytes === "number" ? humanBytes(row.bytes) : "—"),
					h("span", { className: "dst-row-actions" },
						h("button", {
							type: "button", className: "dst-mini", disabled: busy === "restore",
							onClick: () => restore(row.token),
						}, t("trash.restore")),
						h("button", {
							type: "button", className: "dst-mini", onClick: () => reveal(row.token),
						}, t("trash.reveal")),
						h("button", {
							type: "button",
							className: "dst-mini danger" + (confirmPurge === row.token && canPurge ? " armed" : ""),
							disabled: busy === "purge" || !canPurge,
							title: canPurge ? t("trash.purge") : t("host.staleHint"),
							onClick: () => purge(row.token),
						}, !canPurge
							? t("trash.purgeUnavailable")
							: confirmPurge === row.token ? t("trash.purgeConfirm") : t("trash.purge")))))));
		}

		if (notice) body.push(h("div", { key: "notice", className: "dst-hint" }, notice));
		body.push(h("div", { key: "credit", className: "dst-credit" }, t("credit.line").replace("{v}", VERSION)));

		const ops = [];
		ops.push(h("button", { key: "folder", type: "button", className: "dst-btn", onClick: () => reveal("") }, t("trash.openFolder")));
		ops.push(h("button", {
			key: "refresh", type: "button", className: "dst-btn", disabled: busy === "load",
			onClick: () => { load(); refreshLists().catch(() => {}); },
		}, t("trash.refresh")));
		ops.push(h("button", { key: "close", type: "button", className: "dst-btn primary", onClick: close }, t("dialog.close")));

		return h("div", {
			className: "dst-mask",
			role: "dialog",
			"aria-modal": "true",
			onMouseDown: (event) => { if (event.target === event.currentTarget) close(); },
		},
			h("div", { className: "dst-modal" },
				body,
				h("div", { className: "dst-ops" }, ops)));
	}

	function BinIcon() {
		return h("svg", {
			width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
			stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round",
			"aria-hidden": "true", focusable: "false",
		},
			h("path", { d: "M2.5 4.2h11" }),
			h("path", { d: "M6.3 4.2V3.1c0-.5.4-.9.9-.9h1.6c.5 0 .9.4.9.9v1.1" }),
			h("path", { d: "M3.9 4.2l.6 8.2c0 .6.5 1 1.1 1h4.8c.6 0 1.1-.4 1.1-1l.6-8.2" }));
	}
	/* ------------------------------------------------------------------ 样式 */

	const CSS = `
.dst-mask{position:fixed;inset:0;z-index:10300;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.55);pointer-events:auto}
.dst-modal{width:min(620px,100%);max-height:min(86vh,760px);display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-primary,#f2f2f2);box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:auto}
.dst-title{font-size:15px;font-weight:600}
.dst-session{font-size:13px;color:var(--dsw-alias-label-secondary,#b9b5ad);word-break:break-all}
.dst-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#b9b5ad)}
.dst-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}
.dst-row{display:flex;gap:12px;font-size:13px}
.dst-row-label{min-width:96px;color:var(--dsw-alias-label-secondary,#b9b5ad)}
.dst-row-value{flex:1;text-align:right;font-variant-numeric:tabular-nums}
.dst-row-value.muted{color:var(--dsw-alias-label-tertiary,#8d8a84)}
.dst-list{max-height:240px;overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:10px;background:rgba(0,0,0,.16);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dst-list-head{display:flex;align-items:center;gap:8px;margin-top:2px}
.dst-list-head .dst-hint{flex:1;min-width:0}
.dst-list-actions{display:flex;gap:6px;flex:none}
.dst-mini{appearance:none;border:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:var(--dsw-alias-label-secondary,#b9b5ad);border-radius:6px;padding:2px 8px;cursor:pointer;font:11.5px/1.4 inherit;font-weight:600}
.dst-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dst-list-row{display:flex;align-items:center;gap:8px;padding:2px 4px;border-radius:4px;cursor:pointer}
.dst-list-row input{flex:none;margin:0;cursor:pointer}
.dst-list-row.kept{background:rgba(90,170,120,.14)}
.dst-list-row.kept .dst-list-path{color:#a9dcb8}
.dst-list-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dst-list-row.active{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2))}
.dst-filters{display:flex;align-items:center;gap:10px;margin-top:2px}
.dst-filter-input{flex:1;min-width:0;box-sizing:border-box;appearance:none;border:1px solid var(--dsw-alias-border-l1,#444);background:rgba(0,0,0,.18);color:inherit;border-radius:8px;padding:5px 9px;font:12px/1.4 inherit;outline:none}
.dst-filter-input:focus{border-color:rgba(150,190,220,.6)}
.dst-checkline{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#b9b5ad);cursor:pointer;flex:none}
.dst-checkline input{margin:0;cursor:pointer}
.dst-list-tags{display:flex;gap:4px;flex:none}
.dst-tag{flex:none;font-size:10px;line-height:1.5;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#474747);color:var(--dsw-alias-label-tertiary,#8d8a84)}
.dst-tag.presented{border-color:rgba(150,190,220,.55);color:#a9c8dd}
.dst-row-actions{display:flex;gap:2px;flex:none;opacity:0;transition:opacity .12s}
.dst-list-row:hover .dst-row-actions,.dst-list-row.active .dst-row-actions{opacity:1}
.dst-icon{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#b9b5ad);border-radius:5px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.dst-icon:hover{background:rgba(127,127,127,.24);color:var(--dsw-alias-label-primary,#f2f2f2)}
.dst-preview{position:fixed;z-index:10400;pointer-events:none;display:flex;flex-direction:column;gap:6px;padding:8px 9px 9px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#161616);box-shadow:0 16px 40px rgba(0,0,0,.5);font-size:11.5px;color:var(--dsw-alias-label-primary,#f2f2f2);max-height:320px;overflow:hidden}
.dst-preview-head{color:var(--dsw-alias-label-secondary,#b9b5ad);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.dst-preview-img{display:block;max-width:100%;max-height:270px;object-fit:contain;border-radius:6px;background:rgba(255,255,255,.04)}
.dst-preview-text{margin:0;max-height:270px;overflow:hidden;white-space:pre-wrap;word-break:break-word;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#cfcbc4)}
.dst-preview-note{padding:4px 2px;color:var(--dsw-alias-label-secondary,#b9b5ad);line-height:1.5}
.dst-done-list{margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.9;max-height:120px;overflow:auto}
.dst-done-list div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-group{display:flex;align-items:center;gap:6px;padding:3px 4px;margin-top:4px;border-radius:4px;background:rgba(127,127,127,.08)}
.dst-group:first-child{margin-top:0}
.dst-group-check{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#cfcbc4);cursor:pointer;font:12px/1 inherit;padding:2px 3px;border-radius:4px;flex:none}
.dst-group-check:hover{background:rgba(127,127,127,.24)}
.dst-group-check.all{color:#a9dcb8}
.dst-group-check.some{color:#e8d29a}
.dst-group-label{appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;display:flex;align-items:center;gap:5px;flex:1;min-width:0;padding:0;font:11.5px/1.5 inherit;text-align:left}
.dst-group-arrow{flex:none;width:10px;color:var(--dsw-alias-label-tertiary,#8d8a84)}
.dst-group-dir{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dst-group-meta{flex:none;color:var(--dsw-alias-label-tertiary,#8d8a84);font-size:10.5px}
.dst-optbox{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:10px;background:rgba(127,127,127,.06)}
.dst-opts{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px}
.dst-opts-block{flex-direction:column;align-items:flex-start;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:10px;background:rgba(127,127,127,.06)}
.dst-opts-label{color:var(--dsw-alias-label-secondary,#b9b5ad);min-width:56px}
.dst-radio{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--dsw-alias-label-primary,#f2f2f2)}
.dst-radio input{margin:0;cursor:pointer}
.dst-tag.locked{border-color:rgba(220,160,90,.6);color:#e8c08a}
.dst-batch{max-height:220px}
.dst-batch-log{max-height:120px}
.dst-preview.pinned{pointer-events:auto;box-shadow:0 20px 48px rgba(0,0,0,.6)}
.dst-preview-head{display:flex;align-items:center;gap:6px}
.dst-preview-name{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#b9b5ad);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.dst-preview-tools{display:flex;gap:2px;flex:none}
.dst-preview-tools .dst-icon{width:18px;height:18px;font-size:12px;line-height:1}
.dst-preview-tools .dst-icon.on{background:rgba(127,127,127,.28);color:var(--dsw-alias-label-primary,#f2f2f2)}
.dst-preview-body{overflow:hidden}
.dst-preview.pinned .dst-preview-body{overflow:auto;max-height:300px}
.dst-preview-md{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#cfcbc4);max-height:270px;overflow:hidden}
.dst-preview-md h1,.dst-preview-md h2,.dst-preview-md h3,.dst-preview-md h4,.dst-preview-md h5,.dst-preview-md h6{margin:6px 0 3px;font-size:12px;color:var(--dsw-alias-label-primary,#f2f2f2)}
.dst-preview-md p{margin:2px 0}
.dst-preview-md ul{margin:2px 0 2px 14px;padding:0}
.dst-preview-md li{margin:0}
.dst-preview-md code{background:rgba(127,127,127,.22);border-radius:3px;padding:0 3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dst-preview-md .dst-md-code{background:rgba(0,0,0,.3);border-radius:5px;padding:5px 6px;margin:4px 0;overflow:hidden;white-space:pre-wrap;word-break:break-word;font-size:10.5px}
.dst-preview-md .dst-md-code code{background:transparent;padding:0}
.dst-preview-md .dst-md-gap{height:5px;margin:0}
.dst-list-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dst-list-size{flex:none;color:var(--dsw-alias-label-tertiary,#8d8a84)}
.dst-toggle{display:flex;gap:8px;align-items:flex-start;font-size:13px;cursor:pointer}
.dst-toggle input{margin-top:2px}
.dst-tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font-size:10.5px;line-height:1.5;background:rgba(127,127,127,.18);color:var(--dsw-alias-label-secondary,#a7a39c);font-weight:600}
.dst-tag-warn{background:rgba(190,120,60,.22);color:#e0a86a}.dst-header-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:13px;line-height:1;cursor:pointer;opacity:.75}
.dst-header-btn:hover{opacity:1;background:rgba(127,127,127,.16)}
.dst-refresh-glyph{display:inline-block;font-size:13px;line-height:1}.dst-footer-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#b9b5ad);border-radius:7px;padding:5px 8px;cursor:pointer;font:12.5px/1.3 inherit}
.dst-footer-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#f2f2f2)}
.dst-trash{max-height:300px}
.dst-trash-row{gap:10px}
.dst-trash-when{flex:none;color:var(--dsw-alias-label-tertiary,#8d8a84);font-size:11px}
.dst-trash-size{flex:none;color:var(--dsw-alias-label-tertiary,#8d8a84);font-size:11px}
.dst-trash-row .dst-row-actions{opacity:1}
.dst-mini.danger{color:#e57373;border-color:#8a2b27}
.dst-mini.danger.armed{background:#b4342f;border-color:#b4342f;color:#fff}
.dst-mini:disabled{opacity:.6;cursor:default}.dst-credit{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8d8a84);text-align:right;letter-spacing:.02em}
.dst-done{padding:8px 10px;border-radius:8px;background:rgba(90,170,120,.16);color:#a9dcb8;font-size:12.5px}
.dst-warn{padding:8px 10px;border-radius:8px;background:rgba(190,160,80,.16);color:#e8d29a;font-size:12.5px;line-height:1.5}
.dst-error{padding:8px 10px;border-radius:8px;background:rgba(190,80,80,.18);color:#f0b5b5;font-size:12.5px;word-break:break-word}
.dst-ops{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.dst-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:inherit;border-radius:8px;padding:7px 14px;cursor:pointer;font:13px/1.2 inherit;font-weight:600}
.dst-btn:hover:not(:disabled){filter:brightness(1.18)}
.dst-btn:disabled{opacity:.6;cursor:default;filter:grayscale(.15)}
.dst-btn.primary{background:#2f6f9e;border-color:#2f6f9e;color:#fff}
.dst-btn.primary:hover:not(:disabled){background:#3a82b6;border-color:#3a82b6;filter:none}
.dst-btn.primary:disabled{background:#2a5f88;border-color:#2a5f88;color:#eaf3f9;opacity:.85}
/* 危险操作要一眼看清：实心红底 + 白字，禁用时保留可读性而不是糊成一片 */
.dst-btn.danger{background:#b4342f;border-color:#b4342f;color:#fff}
.dst-btn.danger:hover:not(:disabled){background:#c93a34;border-color:#c93a34;filter:none}
.dst-btn.danger:disabled{background:#8a2b27;border-color:#8a2b27;color:#f7dedd;opacity:.75}
`;

	/**
	 * 样式只插一次，谁调用都幂等，**卸载时也不删**。
	 * 早先写在组件 effect 里、跟着 componentWillUnmount 一起 remove：
	 * slot 重挂一次就可能把 <style> 带走，界面立刻退回浏览器默认样式
	 * （按钮带黑框、回收站面板没有遮罩）。样式不是生命周期资源，别跟着组件走。
	 */
	function ensureStyles() {
		try {
			if (typeof document === "undefined" || !document.head) return;
			if (document.querySelector("style[data-dsh-session-tools]")) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-dsh-session-tools", "1");
			tag.textContent = CSS;
			document.head.append(tag);
		} catch { /* ignore */ }
	}

	function StyleTag() {
		useEffect(() => { ensureStyles(); }, []);
		return null;
	}

	/* ------------------------------------------------------------------ 词典 */

	const zh = {
		"menu.deleteSession": "删除会话…",
		"dialog.title": "删除会话",
		"dialog.hint": "这是真删除，不是归档：会话记录、投影缓存和该会话生成的文件一起删掉，删完它会从侧栏彻底消失，也不会变成灰色的“已归档”空壳。会话里的附件对象是按内容共享的，不动它。",
		"dialog.loading": "正在读取会话记录…",
		"dialog.record": "会话记录",
		"dialog.logs": "日志",
		"dialog.artifacts": "生成的文件",
		"dialog.files": "{n} 个文件",
		"dialog.kept": "保留",
		"dialog.artifactsSummary": "{total} 个 · 将删除 {del} · 保留 {kept}",
		"dialog.deleteSize": "将释放",
		"dialog.keptSize": "保留",
		"dialog.keepHint": "勾选 = 保留这个文件（不删）；不勾就跟着会话一起删。鼠标停在行上可以预览，双击直接用默认程序打开。",
		"dialog.keepAll": "全部保留",
		"dialog.keepNone": "全部不保留",
		"dialog.listTruncated": "另有 {n} 个文件没列出来，它们会按默认被删除。",
		"dialog.oldHostKept": "全部保留（宿主还是旧版）",
		"dialog.oldHost": "宿主进程还是旧版本，不认“逐条保留”。为免误删，这次只删会话记录，{n} 个生成文件全部留下；重启 DeepSeek Harness 后就能逐条勾选。",
		"dialog.skipped": "另有 {n} 个路径已跳过：{home} 个在 DSH_HOME 内（插件、凭据等基础设施），{out} 个工作目录与主目录之外。",
		"dialog.confirm": "确认删除",
		"dialog.confirmKeep": "删除会话（保留 {n} 个文件）",
		"dialog.cancel": "取消",
		"dialog.close": "关闭",
		"dialog.deleting": "正在删除…",
		"dialog.done": "已删除 {logs} 个日志目录、{files} 个生成文件，保留 {kept} 个，共释放 {size}。",
		"filter.placeholder": "按路径过滤…",
		"filter.onlyPresented": "只看交付物",
		"filter.empty": "没有匹配的文件。",
		"row.open": "打开",
		"row.reveal": "在文件夹中显示",
		"row.presented": "交付物",
		"row.written": "写入",
		"row.edited": "编辑",
		"preview.loading": "读取预览…",
		"preview.tooLarge": "图片太大，点「打开」查看。",
		"preview.binary": "二进制文件，点「打开」用默认程序查看。",
		"preview.empty": "空文件。",
		"notice.openFailed": "打开失败：{msg}",
		"done.keptList": "保留的文件：",
		"done.keptMore": "还有 {n} 个…",
		"done.failed": "有 {n} 个路径没删掉（可能被占用）：",
		"menu.batchDelete": "批量删除会话…",
		"opt.keepMode": "保留的文件",
		"opt.keepStay": "原地留着",
		"opt.keepExport": "复制到桌面导出目录",
		"opt.trash": "删掉的进回收站（7 天内可撤销）",
		"opt.trashHint": "回收站放在 DSH_HOME\\trash，超期会自动清理。",
		"opt.trashRecord": "整个会话记录先进回收站（7 天内可撤销）",
		"opt.trashRecordHint": "这个会话没有生成文件：日志目录和投影缓存会一起搬进回收站，撤销能把整条会话原样捡回来。",
		"opt.locked": "有 {n} 个文件可能正被别的程序占用，已默认勾成“保留”。确认前先关掉打开它们的程序，就能正常删除。",
		"row.locked": "可能被占用",
		"group.meta": "{n} 个 · 保留 {kept} · {size}",
		"group.keepAll": "整个目录勾成保留",
		"group.clearAll": "整个目录取消保留",
		"group.toggle": "展开/收起",
		"filter.grouped": "按目录分组",
		"preview.pin": "固定预览",
		"preview.unpin": "取消固定",
		"preview.zoomIn": "放大",
		"preview.zoomOut": "缩小",
		"done.trash": "已把 {n} 个文件移到回收站：{dir}",
		"done.trashRecord": "会话记录（日志 + 投影缓存）已移入同一个回收站，点「撤销」可以整条还原。",
		"done.export": "保留的文件已复制到：{dir}",
		"undo.action": "撤销（从回收站还原）",
		"undo.running": "正在还原…",
		"undo.done": "已还原 {n} 个文件",
		"undo.conflicts": "{n} 个与现有文件重名，已另存为“名字 (2)”",
		"undo.failed": "{n} 个还原失败",
		"undo.error": "撤销失败：{msg}",
		"batch.title": "批量删除会话",
		"batch.hint": "同一工作目录下有 {n} 个会话。勾选要删的，选好产物怎么处理，然后开始。",
		"batch.empty": "这个工作目录下没有可删的会话。",
		"batch.artifacts": "产物处理",
		"batch.modeTrash": "删掉，进回收站（可撤销）",
		"batch.modeDelete": "删掉，彻底删除",
		"batch.modeKeep": "保留，不碰产物",
		"batch.noTrash": "宿主还在旧版本，没有回收站能力，这里只能彻底删除或保留。",
		"batch.action": "删除 {n} 个会话",
		"batch.running": "正在删除 {done}/{total}…",
		"batch.ok": "已删",
		"batch.fail": "失败",
		"batch.done": "完成：成功 {ok} 个，失败 {fail} 个。",
		"dialog.force": "强制结束并删除",
		"dialog.forceHint": "先取消正在跑的回合，再硬拆宿主里的会话对象，然后删文件。若它还开在别的面板里，那个面板会报读取失败——这属于预期。",
		"done.forced": "该会话当时仍挂在宿主里，已强制结束并删除。",		"done.pending": "这个会话没删干净：宿主里那个对象还活着，把日志又写回来了。完全退出 DSH 再删一次。",
		"done.passes": "宿主把文件写回来了，已经自动重删（共 {n} 轮）。",		"undo.already": "这批已经还原过了（文件都在原处）",		"host.stale": "宿主侧插件是 {host}，界面是 {ui}：两边对不上。DSH 的宿主代码只在进程启动时加载一次——请「完全退出」DSH（不是关窗口）再重新启动。",
		"host.staleHint": "这条需要宿主侧重启后才可用：完全退出 DSH 再启动。",
		"host.forceUnavailable": "宿主侧还是旧版本，不认强制删除。完全退出 DSH 再启动一次就能用。",
		"trash.purgeUnavailable": "需重启",		"batch.residual": "其中 {n} 条是磁盘上的残留：侧栏里已经没有了（删过一次，账目被摘掉），勾上删掉可以顺手清干净。",
		"batch.tagResidual": "残留",
		"batch.tagArchived": "已归档",
		"batch.force": "强制删除失败的 {n} 条",
		"batch.forceHint": "有 {n} 条因为会话还开着没删掉：点「强制删除失败的那几条」，会先结束它们再删。",
		"batch.undo": "撤销这批删除（{n}）",
		"batch.undoRunning": "正在还原…",
		"batch.undoDone": "已还原 {n} 批",
		"batch.undoPartly": "还原 {ok} 批，{bad} 批失败",		"refresh.list": "刷新列表",
		"refresh.hint": "刷新列表：重新从宿主拉一遍会话与工作区（侧栏图标 ⟳ 是同一个功能）",		"trash.open": "回收站",
		"trash.title": "回收站",
		"trash.hint": "删掉的东西（产物文件、会话记录、投影缓存）先放在这里，超 {days} 天自动清理。点「还原」能原路搬回去。",
		"trash.batches": "批次",
		"trash.filesTotal": "文件",
		"trash.sizeTotal": "占用",
		"trash.empty": "回收站是空的。",
		"trash.hasRecord": "含会话记录",
		"trash.restore": "还原",
		"trash.reveal": "打开",
		"trash.purge": "彻底删除",
		"trash.purgeConfirm": "再点一次",
		"trash.openFolder": "打开回收站文件夹",
		"trash.refresh": "刷新",
		"trash.recordBack": "会话记录已还原",
		"trash.purged": "已彻底删除这一批（不可恢复）。",
		"trash.purgeFailed": "删除失败：{msg}",
		"trash.loadFailed": "读取回收站失败：{msg}",
		"trash.openFailed": "打开文件夹失败：{msg}",		"credit.line": "dsh-session-tools {v} · 原创作者 Weilong",
	};

	const en = {
		"menu.deleteSession": "Delete session…",
		"dialog.title": "Delete session",
		"dialog.hint": "This really deletes instead of archiving: the session log, its projection cache, and the files this session produced are removed together, and the row leaves the sidebar for good instead of turning into a grey archived shell. Attachment objects are content-addressed and shared, so they stay.",
		"dialog.loading": "Reading the session log…",
		"dialog.record": "Session record",
		"dialog.logs": "Logs",
		"dialog.artifacts": "Produced files",
		"dialog.files": "{n} file(s)",
		"dialog.kept": "kept",
		"dialog.artifactsSummary": "{total} file(s) · {del} to delete · {kept} kept",
		"dialog.deleteSize": "Frees",
		"dialog.keptSize": "keeps",
		"dialog.keepHint": "Tick a file to keep it; unticked files are deleted with the session. Hover a row for a preview, double-click to open it.",
		"dialog.keepAll": "Keep all",
		"dialog.keepNone": "Keep none",
		"dialog.listTruncated": "{n} more file(s) are not listed; they are deleted by default.",
		"dialog.oldHostKept": "all kept (host is outdated)",
		"dialog.oldHost": "The host process is an older build that does not understand per-file keeps. To avoid data loss this run deletes only the session record and leaves all {n} produced file(s) in place; restart DeepSeek Harness to tick files individually.",
		"dialog.skipped": "{n} more path(s) were skipped: {home} inside DSH_HOME (plugins, credentials, infrastructure) and {out} outside the workspace and home directory.",
		"dialog.confirm": "Delete",
		"dialog.confirmKeep": "Delete (keeping {n} file(s))",
		"dialog.cancel": "Cancel",
		"dialog.close": "Close",
		"dialog.deleting": "Deleting…",
		"dialog.done": "Removed {logs} log director(ies) and {files} produced file(s), kept {kept}, freeing {size}.",
		"filter.placeholder": "Filter by path…",
		"filter.onlyPresented": "Deliverables only",
		"filter.empty": "No matching file.",
		"row.open": "Open",
		"row.reveal": "Show in folder",
		"row.presented": "deliverable",
		"row.written": "written",
		"row.edited": "edited",
		"preview.loading": "Loading preview…",
		"preview.tooLarge": "Image is too large; use Open.",
		"preview.binary": "Binary file; use Open to view it.",
		"preview.empty": "Empty file.",
		"notice.openFailed": "Open failed: {msg}",
		"done.keptList": "Kept files:",
		"done.keptMore": "and {n} more…",
		"done.failed": "{n} path(s) could not be deleted (maybe in use):",
		"menu.batchDelete": "Delete several sessions…",
		"opt.keepMode": "Kept files",
		"opt.keepStay": "leave in place",
		"opt.keepExport": "copy to Desktop export folder",
		"opt.trash": "Move deleted files to the recycle bin (undoable for 7 days)",
		"opt.trashHint": "The trash lives in DSH_HOME\\trash and is purged automatically.",
		"opt.trashRecord": "Move the whole session record to the recycle bin (undoable for 7 days)",
		"opt.trashRecordHint": "This session produced no files: its log folder and projection cache go to the recycle bin together, so undo brings the whole session back.",
		"opt.locked": "{n} file(s) look locked by another program and were pre-ticked as kept. Close them before confirming to delete normally.",
		"row.locked": "maybe locked",
		"group.meta": "{n} file(s) · {kept} kept · {size}",
		"group.keepAll": "Keep the whole folder",
		"group.clearAll": "Unkeep the whole folder",
		"group.toggle": "Expand/collapse",
		"filter.grouped": "Group by folder",
		"preview.pin": "Pin preview",
		"preview.unpin": "Unpin preview",
		"preview.zoomIn": "Zoom in",
		"preview.zoomOut": "Zoom out",
		"done.trash": "{n} file(s) moved to the recycle bin: {dir}",
		"done.trashRecord": "The session record (log + projection cache) went to the same recycle bin; Undo restores it whole.",
		"done.export": "Kept files copied to: {dir}",
		"undo.action": "Undo (restore from recycle bin)",
		"undo.running": "Restoring…",
		"undo.done": "{n} file(s) restored",
		"undo.conflicts": "{n} collided with existing files and were saved as \"name (2)\"",
		"undo.failed": "{n} could not be restored",
		"undo.error": "Undo failed: {msg}",
		"batch.title": "Delete several sessions",
		"batch.hint": "{n} session(s) share this working directory. Tick what to delete, choose how artifacts are handled, then start.",
		"batch.empty": "No deletable session in this working directory.",
		"batch.artifacts": "Artifacts",
		"batch.modeTrash": "delete into the recycle bin (undoable)",
		"batch.modeDelete": "delete permanently",
		"batch.modeKeep": "keep every artifact",
		"batch.noTrash": "The host is an older build without the recycle bin; only permanent delete or keep are available.",
		"batch.action": "Delete {n} session(s)",
		"batch.running": "Deleting {done}/{total}…",
		"batch.ok": "deleted",
		"batch.fail": "failed",
		"batch.done": "Done: {ok} succeeded, {fail} failed.",
		"dialog.force": "Force delete",
		"dialog.forceHint": "Cancels the running turn, tears the live session out of the host, then deletes the files. Any other panel still showing it will fail to read — that is expected.",
		"done.forced": "That session was still live in the host; it was force-stopped and deleted.",		"done.pending": "This session was not fully deleted: the live object wrote its log back. Quit DSH completely and delete it again.",
		"done.passes": "The host wrote the files back, so the delete was retried ({n} passes).",		"undo.already": "Already restored — the files are back in place",		"host.stale": "The host plugin is {host} but this UI is {ui}. DSH loads host code once at process start — quit DSH completely (not just the window) and start it again.",
		"host.staleHint": "Needs a host restart: quit DSH completely, then start it again.",
		"host.forceUnavailable": "The host side is an older build and does not know force delete. Quit DSH completely and start it again.",
		"trash.purgeUnavailable": "Restart needed",		"batch.residual": "{n} of these only exist on disk — they were deleted once and dropped from the sidebar. Ticking them cleans up the leftovers.",
		"batch.tagResidual": "leftover",
		"batch.tagArchived": "archived",
		"batch.force": "Force delete the {n} that failed",
		"batch.forceHint": "{n} could not be deleted because they are still open: use “Force delete” to stop them first.",
		"batch.undo": "Undo this batch ({n})",
		"batch.undoRunning": "Restoring…",
		"batch.undoDone": "Restored {n} batches",
		"batch.undoPartly": "Restored {ok}, {bad} failed",		"refresh.list": "Refresh list",
		"refresh.hint": "Refresh the sidebar from the host (same as the ⟳ icon next to search)",		"trash.open": "Recycle bin",
		"trash.title": "Recycle bin",
		"trash.hint": "Deleted files, session records and caches wait here for {days} days. Restore puts them back where they came from.",
		"trash.batches": "Batches",
		"trash.filesTotal": "Files",
		"trash.sizeTotal": "Size",
		"trash.empty": "The recycle bin is empty.",
		"trash.hasRecord": "includes session record",
		"trash.restore": "Restore",
		"trash.reveal": "Open",
		"trash.purge": "Delete forever",
		"trash.purgeConfirm": "Click again",
		"trash.openFolder": "Open trash folder",
		"trash.refresh": "Refresh",
		"trash.recordBack": "session record restored",
		"trash.purged": "Deleted that batch permanently.",
		"trash.purgeFailed": "Delete failed: {msg}",
		"trash.loadFailed": "Could not read the recycle bin: {msg}",
		"trash.openFailed": "Could not open the folder: {msg}",		"credit.line": "dsh-session-tools {v} · by Weilong",
	};

	/* ------------------------------------------------------------------ 入口 */

	function apply(ctx) {
		ensureStyles();
		ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-session-tools: dictionaries");
		const t = ctx.locale.bind(NS);
		translate = t;

		ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
			name: "sidebar.workspaces.session.menu.item",
			id: "dsh-session-tools.delete",
			order: 500,
			locale: NS,
			inject: () => ({ t }),
		}, DeleteSessionMenuItem));

		ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
			name: "sidebar.workspaces.session.menu.item",
			id: "dsh-session-tools.batch",
			order: 501,
			locale: NS,
			inject: () => ({ t }),
		}, BatchDeleteMenuItem));

		ctx.slots.inject("shell.overlay", () => ctx.slots.register({
			name: "shell.overlay",
			id: "dsh-session-tools.dialog",
			order: 60,
		}, () => h(react.Fragment, null, h(StyleTag), h(DeleteSessionDialog), h(BatchDeleteDialog), h(TrashDialog))));

		// 侧栏页脚常驻入口：回收站随时能看、能还原，不用等删完那一刻
		ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
			name: "sidebar.footer.action",
			id: "dsh-session-tools.refresh",
			order: 40,
			locale: NS,
			inject: () => ({ t }),
		}, RefreshActionButton));

		ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
			name: "sidebar.footer.action",
			id: "dsh-session-tools.trash",
			order: 50,
			locale: NS,
			inject: () => ({ t }),
		}, TrashActionButton));

		try {
			if (typeof ctx.inject === "function") {
				ctx.inject(["uiWorkspace", "sessions", "workspaces"], (host) => {
					uiWorkspace = host.uiWorkspace || null;
					sessions = host.sessions || null;
					workspaces = host.workspaces || null;
				});
			}
		} catch { /* 可选依赖，缺了也能删（只是不自动归档） */ }
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	// 只给自测用：把纯函数挂出来，免得为了测一句文案去抠渲染树。
	apply.__test = { hostCaps, HostMismatch, VERSION };
	return module.exports;
}
});
