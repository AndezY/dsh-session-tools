dsh-session-tools 0.5.3 —— macOS 安装包
原创作者：Weilong　·　MIT 开源（保留署名即可自由使用、修改、再分发）
==========================================================

这个包里有三样东西：
  install-mac.command    安装器（双击运行）
  patch-manifest.mjs     改 profile/package.json 用的小脚本，安装器自己会调
  dsh-session-tools/     插件本体

--------------------------------------------------------------
先说清楚：没在真机上验证过
--------------------------------------------------------------
插件本体是纯 Node + 浏览器 bundle，代码里没有 Windows 专属逻辑（打开文件那步
已经按 win32 / darwin / linux 分了支），所以在 macOS 上应该能用。
但安装器是我在 Windows 的 Git Bash 里跑通的，**没有在真 Mac 上跑过**。
你装完如果菜单没出现，请把终端输出发给我，我照着修。

基础要求：DeepSeek Harness 桌面端（macOS 版）已装好并至少启动过一次。

--------------------------------------------------------------
怎么装
--------------------------------------------------------------
1. 完全退出 DeepSeek Harness（⌘Q，不是关窗口）。
2. 双击 install-mac.command。
   · 如果 macOS 提示"无法打开，因为来自身份不明的开发者"：
     右键点这个文件 → 打开 → 仍要打开；或者打开"终端"后执行：
       cd <这个文件夹> && bash install-mac.command
   · 如果提示没有执行权限（zip 解压后可能丢）：
       chmod +x install-mac.command
3. 看到「安装完成」后，重新打开 DeepSeek Harness。

安装器只动 ~/.dsh 里的三处：
    plugins/dsh-session-tools/                        插件源码
    profiles/desktop/package.json                     加一条依赖 + 一条 bundles 条目（先备份）
    profiles/desktop/node_modules/dsh-session-tools/ 实际被加载的那份

--------------------------------------------------------------
其它命令
--------------------------------------------------------------
  bash install-mac.command --status      看看装到哪一步了
  bash install-mac.command --uninstall   卸载（会话数据一个都不碰）

校验装好没有：
  curl -s -X POST http://127.0.0.1:19387/session-tools/api \
       -H 'content-type: application/json' -d '{"op":"ping"}'
  返回里 version 应该是 0.5.3，author 是 Weilong。

--------------------------------------------------------------
mac 上已知的差异（不影响使用）
--------------------------------------------------------------
· 「可能被占用」标记基本不会出现：Windows 有强制共享锁，macOS 没有，
  那里探测不到占用是正常的，删除照样能删。
· 「在文件夹中显示」走 Finder 的 open -R。
· 回收站是插件自己的 ~/.dsh/trash/，不是 macOS 的"废纸篓"。
