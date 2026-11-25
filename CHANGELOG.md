# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.5.5

- **回收站有了界面**：侧栏页脚常驻「回收站」按钮，列出每个批次的时间、会话标题、体积、
  是否含会话记录；每行可「还原」「打开文件夹」「彻底删除」（二次确认）。
- 新增 host ops：`trash` 返回 `root` / `entries` / `totals`（含字节数、`hasRecord`、`hasCache`）、
  `purgeEntry` 彻底删除单批、`openTrash` 在文件管理器里打开回收站。
- `listTrash()` 现在会量出每批占用字节并标出是否包含会话记录。

## 0.5.4

- 仓库化：补齐 `repository` / `bugs` / `homepage` 元数据、`CHANGELOG.md` 与 `.gitignore`，
  支持 `dsh plugin add github:<owner>/dsh-session-tools` 直接从仓库安装。
- 文档：README 增加截图、安装三法（插件市场 / 一键安装器 / 手动）与平台支持说明。

## 0.5.3

- **纯文字会话也能进回收站**：会话没有产物时，日志目录与投影缓存一起搬进
  `<DSH_HOME>/trash/<时间戳>-<sessionId>/session/`，撤销时按 manifest 原路还原，
  并通过 `workspaceRegistry.attachSession()` 重新挂回原工作区。
- 删除确认框的「回收站」与「导出」选项不再要求存在产物。
- 结果页明确提示"会话记录已移入回收站，可整条还原"。

## 0.5.2

- 许可证改为 **MIT**（此前误标为保留所有权利），保留作者署名。
- 署名落到四处：插件对话框底部、安装器输出、`package.json`、`ping` 接口。

## 0.5.1

- 修正版本号与安装器输出；`ping` 增加 `author` 字段。

## 0.5.0

- 新增：回收站 + 撤销（7 天）、按目录分组与三态勾选、批量删除、导出到桌面、
  删除前占用预检、预览增强（固定卡片 / 图片缩放 / Markdown 渲染）。

## 0.4.0

- 新增：悬停预览、打开 / 在文件夹中显示、路径过滤、只看交付物、失败项展示。

## 0.3.0

- 新增：产物逐条勾选保留（`keep` 只能做减法）、`plan.caps` 能力协商（新客户端 + 旧宿主安全降级）。

## 0.2.0

- 修复：删除后侧栏残留灰色"已归档"空壳、点开报 ENOENT。
  改为通过 `workspaceRegistry` 摘掉 `sessionIds` / `archivedSessionIds` / `pinnedSessionIds`，
  删除后广播 `api-session/removed`；启动时自愈孤儿账目。

## 0.1.0

- 首个版本：会话删除 + 产物清理（`plan` / `delete`），删除前先归档。
