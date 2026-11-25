<#
  打安装包：把插件 + 安装器打成“双击即装”的单个 .cmd，外加一个可选的 zip。

  用法（在插件根目录）：
    powershell -ExecutionPolicy Bypass -File dist\build-installer.ps1

  产出（dist\ 下）：
    安装-会话删除插件.cmd        单文件安装器：插件数据段 + 安装器脚本都在里面，双击运行
    dsh-session-tools-<ver>.zip  插件本体（纯 npm 包内容，给喜欢手动装的人）
    dsh-session-tools-<ver>-安装包.zip
                                 上面两个 + 安装说明，整包发给别人
#>
[CmdletBinding()]
param(
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = $PSScriptRoot }
$OutDir = [IO.Path]::GetFullPath($OutDir)

$manifest = [IO.File]::ReadAllText((Join-Path $pluginRoot 'package.json')) | ConvertFrom-Json
$version = $manifest.version

function Say { param([string]$Text) Write-Host $Text }
function Step { param([string]$Text) Write-Host ''; Write-Host ('==> ' + $Text) -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1. 暂存插件内容

Step ('暂存 dsh-session-tools ' + $version)
$stage = Join-Path ([IO.Path]::GetTempPath()) ('dsh-st-build-' + [guid]::NewGuid().ToString('N'))
$stagePlugin = Join-Path $stage 'dsh-session-tools'
New-Item -ItemType Directory -Path (Join-Path $stagePlugin 'lib') -Force | Out-Null

$files = @('package.json', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE')
foreach ($f in $files) { Copy-Item -LiteralPath (Join-Path $pluginRoot $f) -Destination $stagePlugin -Force }
Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'lib') -Filter '*.js' -File |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stagePlugin 'lib') -Force }

$fileCount = (Get-ChildItem -LiteralPath $stagePlugin -Recurse -File | Measure-Object).Count
Say ('  打包 ' + $fileCount + ' 个文件')

# ---------------------------------------------------------------- 2. 插件本体 zip

$pluginZip = Join-Path $OutDir ('dsh-session-tools-' + $version + '.zip')
if (Test-Path -LiteralPath $pluginZip) { Remove-Item -LiteralPath $pluginZip -Force }
Compress-Archive -Path $stagePlugin -DestinationPath $pluginZip -CompressionLevel Optimal
Say ('  ' + (Split-Path -Leaf $pluginZip) + '  ' + [math]::Round((Get-Item $pluginZip).Length / 1KB, 1) + ' KB')

# ---------------------------------------------------------------- 3. 安装器脚本（带 BOM）

Step '准备安装器脚本'
$ps1Source = Join-Path $PSScriptRoot 'install-dsh-session-tools.ps1'
$ps1Text = [IO.File]::ReadAllText($ps1Source, [Text.Encoding]::UTF8)
$ps1Out = Join-Path $OutDir 'install-dsh-session-tools.ps1'
[IO.File]::WriteAllText($ps1Out, $ps1Text, (New-Object System.Text.UTF8Encoding($true)))  # BOM：PowerShell 5.1 靠它认 UTF-8
$ps1Bytes = [IO.File]::ReadAllBytes($ps1Out)
Say ('  install-dsh-session-tools.ps1  ' + $ps1Bytes.Length + ' bytes（UTF-8 BOM）')

# ---------------------------------------------------------------- 4. 单文件 .cmd

Step '生成单文件安装器'
$zipBytes = [IO.File]::ReadAllBytes($pluginZip)
$b64Script = [Convert]::ToBase64String($ps1Bytes)
$b64Zip = [Convert]::ToBase64String($zipBytes)

function Format-Base64 {
    param([string]$Text)
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $Text.Length; $i += 120) {
        $len = [Math]::Min(120, $Text.Length - $i)
        [void]$sb.AppendLine($Text.Substring($i, $len))
    }
    return $sb.ToString().TrimEnd()
}

$header = @'
@echo off
chcp 65001 >nul
setlocal
title dsh-session-tools installer
set "SELF=%~f0"
set "PS1=%TEMP%\dsh-session-tools-install.ps1"

echo.
echo   dsh-session-tools - DSH session delete plugin
echo   ------------------------------------------------
echo.

where powershell >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell not found. This installer needs PowerShell 5.1 or newer.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText($env:SELF,[Text.Encoding]::UTF8); $tag='#@@'+'PS1'+'@@'; $end='#@@'+'ENDPS1'+'@@'; $pattern='(?s)'+[regex]::Escape($tag)+'\s*(.*?)\s*'+[regex]::Escape($end); $m=[regex]::Match($text,$pattern); if(-not $m.Success){Write-Host 'installer payload missing'; exit 2}; $bytes=[Convert]::FromBase64String(($m.Groups[1].Value -replace '\s','')); [IO.File]::WriteAllBytes($env:PS1,$bytes); & powershell -NoProfile -ExecutionPolicy Bypass -File $env:PS1 -Package $env:SELF %*"
set "CODE=%ERRORLEVEL%"

echo.
if "%DSH_SESSION_TOOLS_NO_PAUSE%"=="" pause
exit /b %CODE%

REM ======================================================================
REM  payload: installer script (base64, UTF-8 with BOM)
REM ======================================================================
#@@PS1@@
'@

$footer = @'

REM ======================================================================
REM  payload: plugin package (base64 zip)
REM ======================================================================
#@@ZIP@@
'@

$cmdPath = Join-Path $OutDir '安装-会话删除插件.cmd'
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine($header)
[void]$sb.AppendLine((Format-Base64 -Text $b64Script))
[void]$sb.AppendLine('#@@ENDPS1@@')
[void]$sb.AppendLine($footer)
[void]$sb.AppendLine((Format-Base64 -Text $b64Zip))
[void]$sb.AppendLine('#@@ENDZIP@@')# cmd 按 ANSI/UTF-8 读脚本：正文全是 ASCII，安全
[IO.File]::WriteAllText($cmdPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Say ('  安装-会话删除插件.cmd  ' + [math]::Round((Get-Item $cmdPath).Length / 1KB, 1) + ' KB')

# ---------------------------------------------------------------- 5. 整包 zip

Step '打整包（可选分享用）'
$bundleStage = Join-Path $stage 'bundle'
New-Item -ItemType Directory -Path $bundleStage -Force | Out-Null
$readmeOut = Join-Path $bundleStage '安装说明.txt'
Copy-Item -LiteralPath (Join-Path $pluginRoot 'dist\安装说明.txt') -Destination $readmeOut -Force
Copy-Item -LiteralPath $cmdPath -Destination $bundleStage -Force
Copy-Item -LiteralPath $ps1Out -Destination $bundleStage -Force
Copy-Item -LiteralPath $pluginZip -Destination $bundleStage -Force

$bundleZip = Join-Path $OutDir ('dsh-session-tools-' + $version + '-安装包.zip')
if (Test-Path -LiteralPath $bundleZip) { Remove-Item -LiteralPath $bundleZip -Force }
Compress-Archive -Path (Join-Path $bundleStage '*') -DestinationPath $bundleZip -CompressionLevel Optimal
Say ('  ' + (Split-Path -Leaf $bundleZip) + '  ' + [math]::Round((Get-Item $bundleZip).Length / 1KB, 1) + ' KB')

# ---------------------------------------------------------------- 6. macOS 包

Step '打 macOS 包'
$macStage = Join-Path $stage 'mac'
New-Item -ItemType Directory -Path $macStage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $pluginRoot 'dist\mac\install-mac.command') -Destination $macStage -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot 'dist\mac\patch-manifest.mjs') -Destination $macStage -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot 'dist\mac\README-mac.txt') -Destination $macStage -Force
Copy-Item -LiteralPath $stagePlugin -Destination (Join-Path $macStage 'dsh-session-tools') -Recurse -Force

$macZip = Join-Path $OutDir ('dsh-session-tools-' + $version + '-mac.zip')
if (Test-Path -LiteralPath $macZip) { Remove-Item -LiteralPath $macZip -Force }
Compress-Archive -Path (Join-Path $macStage '*') -DestinationPath $macZip -CompressionLevel Optimal
Say ('  ' + (Split-Path -Leaf $macZip) + '  ' + [math]::Round((Get-Item $macZip).Length / 1KB, 1) + ' KB')
Say '  （macOS 解压后如果 .command 丢了执行位：chmod +x install-mac.command）'

try { Remove-Item -LiteralPath $stage -Recurse -Force } catch { }

# ---------------------------------------------------------------- 7. 同步到 release/ 镜像
# 文件名固定、不带版本号：以后发版只覆盖同名文件，README / 商品页的下载链接永远不用改。

Step '同步到 release/ 镜像（固定文件名）'
$relDir = Join-Path $pluginRoot 'release'
New-Item -ItemType Directory -Path $relDir -Force | Out-Null

$mirrorCmd = Join-Path $relDir 'installer-windows.cmd'
$mirrorMac = Join-Path $relDir 'installer-mac.zip'
$mirrorTar = Join-Path $relDir 'installer-mac.tar.gz'

Copy-Item -LiteralPath $cmdPath -Destination $mirrorCmd -Force
Copy-Item -LiteralPath $macZip -Destination $mirrorMac -Force
Say ('  installer-windows.cmd  ' + [math]::Round((Get-Item $mirrorCmd).Length / 1KB, 1) + ' KB')
Say ('  installer-mac.zip      ' + [math]::Round((Get-Item $mirrorMac).Length / 1KB, 1) + ' KB')

# tar.gz 备用：GitHub 的附件处理器偶尔吃不下 zip，tar 走另一条通道
$tarStage = Join-Path ([IO.Path]::GetTempPath()) ('dsst-tar-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tarStage -Force | Out-Null
try {
  Expand-Archive -LiteralPath $macZip -DestinationPath $tarStage -Force
  if (Test-Path -LiteralPath $mirrorTar) { Remove-Item -LiteralPath $mirrorTar -Force }
  Push-Location $tarStage
  try {
    & tar -czf $mirrorTar . 2>&1 | Out-Null
  } finally {
    Pop-Location
  }
  if (Test-Path -LiteralPath $mirrorTar) {
    Say ('  installer-mac.tar.gz   ' + [math]::Round((Get-Item $mirrorTar).Length / 1KB, 1) + ' KB')
  } else {
    Say '  （tar 不可用，跳过 tar.gz）'
  }
} finally {
  try { Remove-Item -LiteralPath $tarStage -Recurse -Force } catch { }
}

# 版本清单：谁下到的是哪一版、字节数、sha256 都写在这里
$manifest = [ordered]@{
  version   = $version
  builtAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  files     = [ordered]@{}
}
foreach ($name in @('installer-windows.cmd', 'installer-mac.zip', 'installer-mac.tar.gz')) {
  $path = Join-Path $relDir $name
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $manifest.files[$name] = [ordered]@{
    bytes  = (Get-Item $path).Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
  }
}
$manifestPath = Join-Path $relDir 'VERSION.json'
[IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 5) + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
Say ('  VERSION.json -> ' + $version)

Step '完成'
Say ('  输出目录：' + $OutDir)
Say ('  release 镜像：' + $relDir)
Say '  下次发版同样跑这个脚本即可，文件名不变，下载链接不用动。'
