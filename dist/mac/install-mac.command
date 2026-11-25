#!/bin/bash
# dsh-session-tools —— macOS 安装器（原创作者 Weilong · MIT）
#
# 双击即可运行；也可以 sudo 之外直接跑：
#   bash install-mac.command            # 安装 / 升级
#   bash install-mac.command --status   # 只看状态
#   bash install-mac.command --uninstall
#
# 它只动 ~/.dsh 里的三处：plugins/、profiles/<profile>/package.json、
# profiles/<profile>/node_modules/。会话数据一个都不碰。

set -u
PLUGIN_NAME="dsh-session-tools"
VERSION_FALLBACK="0.5.3"
ACTION="install"

for arg in "$@"; do
  case "$arg" in
    --status) ACTION="status" ;;
    --uninstall) ACTION="uninstall" ;;
    --install) ACTION="install" ;;
    --help|-h)
      printf '用法: bash install-mac.command [--install|--status|--uninstall]\n'
      exit 0
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    \033[32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*"; }
bad() { printf '    \033[31m%s\033[0m\n' "$*"; }
fails=0

# ---------------------------------------------------------------- 定位
HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$HERE/$PLUGIN_NAME"

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

if [ ! -d "$DSH_HOME_DIR" ]; then
  bad "没找到 DSH_HOME：$DSH_HOME_DIR"
  say "  先启动一次 DeepSeek Harness，让它把目录建出来，再回来跑这个脚本。"
  exit 2
fi

find_profile() {
  local root="$DSH_HOME_DIR/profiles"
  if [ ! -d "$root" ]; then return 1; fi
  if [ -f "$root/desktop/package.json" ]; then echo "$root/desktop"; return 0; fi
  for dir in "$root"/*; do
    if [ -f "$dir/package.json" ] && grep -q '"bundles"' "$dir/package.json" 2>/dev/null; then
      echo "$dir"
      return 0
    fi
  done
  return 1
}

PROFILE_DIR="$(find_profile)" || true
if [ -z "${PROFILE_DIR:-}" ] && [ "$ACTION" != "status" ]; then
  bad "在 $DSH_HOME_DIR/profiles 里没找到带 dsh.profile.bundles 的 profile"
  say "  先启动一次 DeepSeek Harness 再来。"
  exit 2
fi

find_node() {
  local n
  for n in "$DSH_HOME_DIR"/dsh-runtimes/*/dependencies/node/bin/node; do
    if [ -x "$n" ]; then echo "$n"; return 0; fi
  done
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  return 1
}
find_pnpm() {
  local p
  for p in "$DSH_HOME_DIR"/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.cjs; do
    if [ -f "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}

NODE_BIN="$(find_node)" || true
PNPM_CJS="$(find_pnpm)" || true

read_version() {
  local manifest="$1/package.json"
  if [ -f "$manifest" ]; then
    "$NODE_BIN" -e 'const m=require(process.argv[1]);console.log(m.version||"?")' "$manifest" 2>/dev/null || echo "?"
  else
    echo "-"
  fi
}

print_status() {
  step "路径"
  ok "DSH_HOME : $DSH_HOME_DIR"
  ok "profile  : ${PROFILE_DIR:-<未找到>}"

  step "源码"
  if [ -d "$DSH_HOME_DIR/plugins/$PLUGIN_NAME" ]; then
    ok "已安装 $(read_version "$DSH_HOME_DIR/plugins/$PLUGIN_NAME")  ->  $DSH_HOME_DIR/plugins/$PLUGIN_NAME"
  else
    warn "没有：$DSH_HOME_DIR/plugins/$PLUGIN_NAME"
  fi

  step "profile 里的安装副本"
  if [ -d "$PROFILE_DIR/node_modules/$PLUGIN_NAME" ]; then
    local miss=""
    for f in package.json client.js cordis.patch.yml lib/index.js lib/core.js lib/registry.js lib/inspect.js; do
      [ -f "$PROFILE_DIR/node_modules/$PLUGIN_NAME/$f" ] || miss="$miss $f"
    done
    if [ -z "$miss" ]; then ok "文件齐全 -> $PROFILE_DIR/node_modules/$PLUGIN_NAME"; else bad "缺文件：$miss"; fi
  else
    warn "没有：$PROFILE_DIR/node_modules/$PLUGIN_NAME"
  fi

  step "加载器登记"
  if [ -f "$PROFILE_DIR/package.json" ]; then
    "$NODE_BIN" - "$PROFILE_DIR/package.json" "$PLUGIN_NAME" <<'NODE'
const fs = require('fs')
const [file, name] = process.argv.slice(2)
const m = JSON.parse(fs.readFileSync(file, 'utf8'))
const bundles = (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || []
console.log('    bundles 里有 ' + name + ': ' + (bundles.includes(name) ? 'yes' : 'no'))
console.log('    依赖登记: ' + ((m.dependencies || {})[name] || '<无>'))
NODE
  fi
}

# ---------------------------------------------------------------- 卸载
if [ "$ACTION" = "uninstall" ]; then
  step "1/3 检查 DeepSeek Harness 是否在运行"
  if pgrep -f "DeepSeek Harness" >/dev/null 2>&1; then
    bad "DeepSeek Harness 正在运行：请先退出（⌘Q）再卸载。"
    exit 3
  fi
  ok "没有占用"

  step "2/3 从 profile 里摘掉"
  if [ -n "${PROFILE_DIR:-}" ]; then
    rm -rf "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
    ok "已删 node_modules/$PLUGIN_NAME"
    "$NODE_BIN" "$HERE/patch-manifest.mjs" "$PROFILE_DIR/package.json" "$PLUGIN_NAME" remove \
      && ok "package.json 已清理（备份见同目录 .bak-*）"
  fi

  step "3/3 清掉源码目录"
  rm -rf "$DSH_HOME_DIR/plugins/$PLUGIN_NAME"
  ok "已删 plugins/$PLUGIN_NAME"

  say ""
  say "卸载完成。会话数据一个都没动。重新打开 DeepSeek Harness 生效。"
  exit 0
fi

# ---------------------------------------------------------------- 安装
if [ "$ACTION" = "status" ]; then
  if [ -z "${NODE_BIN:-}" ]; then
    bad "找不到 node（DSH 自带运行时和系统 PATH 里都没有）"
    exit 2
  fi
  print_status
  exit 0
fi

step "1/6 检查 DeepSeek Harness 是否在运行"
if pgrep -f "DeepSeek Harness" >/dev/null 2>&1; then
  warn "DeepSeek Harness 正在运行，安装时要改 node_modules，建议先退出。"
  printf '    退出后按回车继续（Ctrl+C 取消）'
  read -r _
fi
ok "继续"

step "2/6 解包"
if [ ! -f "$PAYLOAD/package.json" ]; then
  bad "找不到插件内容：$PAYLOAD"
  say "  请把 install-mac.command 和 $PLUGIN_NAME 文件夹放在同一层目录里。"
  exit 2
fi
if [ -z "${NODE_BIN:-}" ]; then
  bad "找不到 node（DSH 自带运行时和系统 PATH 里都没有），无法改 package.json"
  exit 2
fi
PLUGIN_VERSION="$(read_version "$PAYLOAD")"
ok "$PLUGIN_NAME $PLUGIN_VERSION（原创作者 Weilong）"

step "3/6 放进 plugins 目录"
mkdir -p "$DSH_HOME_DIR/plugins"
rm -rf "$DSH_HOME_DIR/plugins/$PLUGIN_NAME"
cp -R "$PAYLOAD" "$DSH_HOME_DIR/plugins/$PLUGIN_NAME"
ok "$DSH_HOME_DIR/plugins/$PLUGIN_NAME"

step "4/6 写 profile 的 package.json（依赖 + bundles 条目）"
BACKUP="$("$NODE_BIN" "$HERE/patch-manifest.mjs" "$PROFILE_DIR/package.json" "$PLUGIN_NAME" add)" || {
  bad "改写 package.json 失败"
  exit 4
}
ok "已登记到 $PROFILE_DIR/package.json"
ok "原文件备份：$BACKUP"

step "5/6 装进 profile 的 node_modules"
used_pnpm=0
if [ -n "${PNPM_CJS:-}" ] || command -v pnpm >/dev/null 2>&1; then
  if [ -n "${PNPM_CJS:-}" ]; then
    ok "用 DSH 自带的 pnpm：$PNPM_CJS"
    PNPM_CMD=("$NODE_BIN" "$PNPM_CJS")
  else
    ok "用系统 pnpm：$(command -v pnpm)"
    PNPM_CMD=("$(command -v pnpm)")
  fi
  for args in "install --offline --ignore-scripts --reporter=append-only" \
              "install --prefer-offline --ignore-scripts --reporter=append-only" \
              "install --ignore-scripts --reporter=append-only"; do
    ( cd "$PROFILE_DIR" && "${PNPM_CMD[@]}" $args ) && { used_pnpm=1; break; }
    warn "这一次 pnpm 没成功，换参数再试…"
  done
else
  warn "没找到 pnpm，走复制安装（插件零外部依赖，复制就够用）"
fi

if [ "$used_pnpm" -eq 1 ] && [ -f "$PROFILE_DIR/node_modules/$PLUGIN_NAME/lib/index.js" ]; then
  ok "pnpm 已落盘：$PROFILE_DIR/node_modules/$PLUGIN_NAME"
else
  mkdir -p "$PROFILE_DIR/node_modules"
  rm -rf "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
  cp -R "$PAYLOAD" "$PROFILE_DIR/node_modules/$PLUGIN_NAME"
  ok "直接复制到 $PROFILE_DIR/node_modules/$PLUGIN_NAME"
fi

step "6/6 校验"
miss=""
for f in package.json client.js cordis.patch.yml lib/index.js lib/core.js lib/registry.js lib/inspect.js; do
  [ -f "$PROFILE_DIR/node_modules/$PLUGIN_NAME/$f" ] || miss="$miss $f"
done
if [ -z "$miss" ]; then ok "node_modules 里的文件齐全"; else bad "缺文件：$miss"; fails=$((fails + 1)); fi

"$NODE_BIN" - "$PROFILE_DIR/package.json" "$PLUGIN_NAME" <<'NODE' || fails=$((fails + 1))
const fs = require('fs')
const [file, name] = process.argv.slice(2)
const m = JSON.parse(fs.readFileSync(file, 'utf8'))
const bundles = (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || []
const dep = (m.dependencies || {})[name]
if (!bundles.includes(name)) { console.log('    \x1b[31m✗ bundles 里没有 ' + name + '\x1b[0m'); process.exit(1) }
console.log('    \x1b[32m✓\x1b[0m bundles 里已经有 ' + name)
if (!dep) { console.log('    \x1b[31m✗ 依赖没登记\x1b[0m'); process.exit(1) }
console.log('    \x1b[32m✓\x1b[0m 依赖已登记：' + dep)
NODE

say ""
if [ "$fails" -eq 0 ]; then
  printf '\033[32m安装完成。\033[0m\n'
  say "接下来：重新打开 DeepSeek Harness（⌘Q 完全退出再开）。"
  say "侧栏会话行右侧的「…」里会多两行：「删除会话…」和「批量删除会话…」。"
  say ""
  say "想确认插件已加载，终端里跑："
  say "  curl -s -X POST http://127.0.0.1:19387/session-tools/api -H 'content-type: application/json' -d '{\"op\":\"ping\"}'"
  say "  返回里 version 应该是 $PLUGIN_VERSION，author 是 Weilong。"
else
  printf '\033[31m安装过程中有 %s 处失败，见上面的红字。\033[0m\n' "$fails"
fi
exit "$fails"
