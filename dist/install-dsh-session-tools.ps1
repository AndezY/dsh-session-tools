<#
  dsh-session-tools 安装器（Windows PowerShell 5.1 可用）

  做四件事：
    1. 把插件源码放进 <DSH_HOME>\plugins\dsh-session-tools
    2. 在 profile 的 package.json 里加依赖 + dsh.profile.bundles 条目（先备份）
    3. 用 DSH 自带的 node/pnpm 跑 pnpm install；没有 pnpm 就退化成直接复制到
       <PROFILE>\node_modules\dsh-session-tools（包里零外部依赖，复制即可用）
    4. 校验文件齐全，打印下一步

  用法：
    powershell -ExecutionPolicy Bypass -File install-dsh-session-tools.ps1 -Package <安装包.cmd 或 .zip>
    powershell -ExecutionPolicy Bypass -File install-dsh-session-tools.ps1 -Action status
    powershell -ExecutionPolicy Bypass -File install-dsh-session-tools.ps1 -Action uninstall

  可选：
    -DshHome <路径>    指定 DSH_HOME（默认读 $env:DSH_HOME，再退回 %USERPROFILE%\.dsh）
    -ProfileName <名字> 指定 profile（默认 desktop，找不到就扫描带 dsh.profile.bundles 的那个）
    -NoPnpm            跳过 pnpm，直接用复制安装
    -Force             不检查 DSH 是否在运行
    -Yes               所有确认自动回答“是”
#>
[CmdletBinding()]
param(
    [string]$Package = '',
    [string]$Action = '',
    [string]$DshHome = '',
    [string]$ProfileName = '',
    [switch]$NoPnpm,
    [switch]$Force,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-session-tools'
$DepSpec = 'file:../../plugins/dsh-session-tools'
$script:failures = 0

# 安装包里的 .cmd 会把控制台切到 UTF-8；这里同步一下输出编码，中文才不乱码。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

# ---------------------------------------------------------------- 输出

function Say { param([string]$Text) Write-Host $Text }
function Step { param([string]$Text) Write-Host ''; Write-Host ('==> ' + $Text) -ForegroundColor Cyan }
function Ok { param([string]$Text) Write-Host ('    ' + $Text) -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host ('    ' + $Text) -ForegroundColor Yellow }
function Bad { param([string]$Text) Write-Host ('    ' + $Text) -ForegroundColor Red; $script:failures = $script:failures + 1 }

# ---------------------------------------------------------------- 定位

function Resolve-DshHome {
    param([string]$Given)
    $candidates = New-Object System.Collections.ArrayList
    if ($Given) { [void]$candidates.Add($Given) }
    if ($env:DSH_HOME) { [void]$candidates.Add($env:DSH_HOME) }
    if ($env:USERPROFILE) { [void]$candidates.Add((Join-Path $env:USERPROFILE '.dsh')) }
    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        $full = [IO.Path]::GetFullPath($candidate)
        if (Test-Path -LiteralPath $full) { return $full }
    }
    return $null
}

function Resolve-ProfileDir {
    param([string]$DshHomePath, [string]$Given)
    $root = Join-Path $DshHomePath 'profiles'
    if ($Given) {
        if (Test-Path -LiteralPath $Given) { return [IO.Path]::GetFullPath($Given) }
        $joined = Join-Path $root $Given
        if (Test-Path -LiteralPath $joined) { return [IO.Path]::GetFullPath($joined) }
        throw "找不到 profile：$Given"
    }
    if (-not (Test-Path -LiteralPath $root)) {
        throw "profile 目录不存在：$root —— 先启动一次 DeepSeek Harness，让它把 profile 建出来"
    }
    $desktop = Join-Path $root 'desktop'
    if (Test-Path -LiteralPath (Join-Path $desktop 'package.json')) { return $desktop }
    foreach ($dir in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {
        $pkg = Join-Path $dir.FullName 'package.json'
        if (-not (Test-Path -LiteralPath $pkg)) { continue }
        $text = [IO.File]::ReadAllText($pkg)
        if ($text -match '"bundles"') { return $dir.FullName }
    }
    throw "在 $root 里没找到带 dsh.profile.bundles 的 profile"
}

function Get-DshProcesses {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' })
}

function Wait-ForDshExit {
    param([switch]$Skip)
    if ($Skip) { return $true }
    if ((Get-DshProcesses).Count -eq 0) { return $true }
    Warn 'DeepSeek Harness 正在运行，它会把 node_modules 锁住。'
    Say  '    请在右下角托盘图标上右键 -> 退出，完全关掉它。'
    $deadline = (Get-Date).AddSeconds(240)
    while ((Get-Date) -lt $deadline) {
        Read-Host '    关掉之后按回车继续（Ctrl+C 取消）' | Out-Null
        if ((Get-DshProcesses).Count -eq 0) { return $true }
        Warn '它还在运行，再多等一会儿。'
    }
    return $false
}

function Find-PnpmRuntime {
    param([string]$DshHomePath)
    $node = $null
    $pnpm = $null
    $runtimes = Join-Path $DshHomePath 'dsh-runtimes'
    if (Test-Path -LiteralPath $runtimes) {
        foreach ($dir in Get-ChildItem -LiteralPath $runtimes -Directory -ErrorAction SilentlyContinue) {
            $n = Join-Path $dir.FullName 'dependencies\node\bin\node.exe'
            $p = Join-Path $dir.FullName 'dependencies\pnpm\bin\pnpm.cjs'
            if (-not $node -and (Test-Path -LiteralPath $n)) { $node = $n }
            if (-not $pnpm -and (Test-Path -LiteralPath $p)) { $pnpm = $p }
        }
    }
    if (-not $node) {
        $found = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($found) { $node = $found.Source }
    }
    if (-not $node -or -not $pnpm) { return $null }
    return @{ node = $node; pnpm = $pnpm }
}

# ---------------------------------------------------------------- 解包

function Expand-PluginPayload {
    param([string]$PackagePath)
    if (-not $PackagePath) { throw '没给安装包路径（-Package）' }
    if (-not (Test-Path -LiteralPath $PackagePath)) { throw "安装包不存在：$PackagePath" }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('dsh-st-payload-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    if ($PackagePath -match '\.zip$') {
        Expand-Archive -LiteralPath $PackagePath -DestinationPath $tmp -Force
    } else {
        $text = [IO.File]::ReadAllText($PackagePath, [Text.Encoding]::UTF8)
        $match = [regex]::Match($text, '(?s)#@@ZIP@@\s*(.*?)\s*#@@ENDZIP@@')
        if (-not $match.Success) { throw '安装包里找不到插件数据段（文件可能被截断或被杀软改过）' }
        $bytes = [Convert]::FromBase64String(($match.Groups[1].Value -replace '\s', ''))
        $zipPath = Join-Path $tmp 'payload.zip'
        [IO.File]::WriteAllBytes($zipPath, $bytes)
        Expand-Archive -LiteralPath $zipPath -DestinationPath $tmp -Force
    }
    $root = Join-Path $tmp $PluginName
    if (Test-Path -LiteralPath (Join-Path $root 'package.json')) { return $root }
    foreach ($dir in Get-ChildItem -LiteralPath $tmp -Directory -Recurse -ErrorAction SilentlyContinue) {
        if (Test-Path -LiteralPath (Join-Path $dir.FullName 'package.json')) {
            $probe = Join-Path $dir.FullName 'package.json'
            if (([IO.File]::ReadAllText($probe)) -match '"name"\s*:\s*"dsh-session-tools"') { return $dir.FullName }
        }
    }
    throw '解包后没找到 dsh-session-tools 目录'
}

# ---------------------------------------------------------------- manifest

function Read-Manifest {
    param([string]$Path)
    return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Write-Manifest {
    param([string]$Path, $Manifest)
    # PowerShell 5.1 的 ConvertTo-Json 会输出 4 空格 + 键值对齐的怪格式，
    # 这里用自家的小序列化器，写成干净的两空格 JSON，免得看着像被谁糟蹋过。
    $json = Format-Json -Value $Manifest -Indent 0
    [IO.File]::WriteAllText($Path, $json + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Format-Json {
    param($Value, [int]$Indent = 0)
    $pad = ' ' * $Indent
    $inner = ' ' * ($Indent + 2)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [string]) { return (ConvertTo-Json -InputObject ([string]$Value) -Compress) }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) { return ([string]$Value) }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) { $items += (Format-Json -Value $item -Indent ($Indent + 2)) }
        if ($items.Count -eq 0) { return '[]' }
        $body = ($items | ForEach-Object { $inner + $_ }) -join ",`r`n"
        return "[`r`n" + $body + "`r`n" + $pad + "]"
    }
    $props = @($Value.PSObject.Properties | Where-Object { $_.MemberType -eq 'NoteProperty' })
    if ($props.Count -eq 0) { return '{}' }
    $lines = @()
    foreach ($prop in $props) {
        $key = ConvertTo-Json -InputObject ([string]$prop.Name) -Compress
        $lines += ($inner + $key + ': ' + (Format-Json -Value $prop.Value -Indent ($Indent + 2)))
    }
    return "{`r`n" + ($lines -join ",`r`n") + "`r`n" + $pad + "}"
}

function Backup-File {
    param([string]$Path)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = $Path + '.bak-' + $stamp
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    return $backup
}

function Add-BundleEntry {
    param([string]$ProfileDir)
    $pkgPath = Join-Path $ProfileDir 'package.json'
    $backup = Backup-File -Path $pkgPath
    $manifest = Read-Manifest -Path $pkgPath

    if (-not $manifest.PSObject.Properties['dependencies']) {
        $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object psobject) -Force
    }
    $manifest.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $DepSpec -Force

    if (-not $manifest.PSObject.Properties['dsh']) {
        $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object psobject) -Force
    }
    if (-not $manifest.dsh.PSObject.Properties['profile']) {
        $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object psobject) -Force
    }
    if (-not $manifest.dsh.profile.PSObject.Properties['bundles']) {
        $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
    }
    $bundles = @($manifest.dsh.profile.bundles)
    if (-not ($bundles -contains $PluginName)) { $bundles = $bundles + $PluginName }
    $manifest.dsh.profile.bundles = $bundles

    Write-Manifest -Path $pkgPath -Manifest $manifest
    return $backup
}

function Remove-BundleEntry {
    param([string]$ProfileDir)
    $pkgPath = Join-Path $ProfileDir 'package.json'
    if (-not (Test-Path -LiteralPath $pkgPath)) { return $null }
    $backup = Backup-File -Path $pkgPath
    $manifest = Read-Manifest -Path $pkgPath

    if ($manifest.PSObject.Properties['dependencies'] -and $manifest.dependencies.PSObject.Properties[$PluginName]) {
        $manifest.dependencies.PSObject.Properties.Remove($PluginName)
    }
    if ($manifest.PSObject.Properties['dsh'] -and $manifest.dsh.PSObject.Properties['profile'] -and $manifest.dsh.profile.PSObject.Properties['bundles']) {
        $kept = @()
        foreach ($name in @($manifest.dsh.profile.bundles)) {
            if ($name -ne $PluginName) { $kept = $kept + $name }
        }
        $manifest.dsh.profile.bundles = $kept
    }

    Write-Manifest -Path $pkgPath -Manifest $manifest
    return $backup
}

# ---------------------------------------------------------------- 落盘

function Install-PluginSource {
    param([string]$PluginRoot, [string]$DshHomePath)
    $pluginsDir = Join-Path $DshHomePath 'plugins'
    New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
    $dest = Join-Path $pluginsDir $PluginName
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    Copy-Item -LiteralPath $PluginRoot -Destination $dest -Recurse -Force
    return $dest
}

function Install-PluginCopy {
    param([string]$PluginRoot, [string]$ProfileDir)
    $nodeModules = Join-Path $ProfileDir 'node_modules'
    New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null
    $dest = Join-Path $nodeModules $PluginName
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    Copy-Item -LiteralPath $PluginRoot -Destination $dest -Recurse -Force
    return $dest
}

function Invoke-PnpmInstall {
    param([string]$ProfileDir, $Runtime)
    $attempts = @(
        @('install', '--offline', '--ignore-scripts', '--reporter=append-only'),
        @('install', '--prefer-offline', '--ignore-scripts', '--reporter=append-only'),
        @('install', '--ignore-scripts', '--reporter=append-only')
    )
    foreach ($argv in $attempts) {
        Push-Location -LiteralPath $ProfileDir
        $code = 1
        try {
            & $Runtime.node $Runtime.pnpm @argv 2>&1 | ForEach-Object { Write-Host ('      ' + [string]$_) }
            $code = $LASTEXITCODE
        } catch {
            Warn ('pnpm 调用异常：' + $_.Exception.Message)
            $code = 1
        } finally {
            Pop-Location
        }
        if ($code -eq 0) { return $true }
        Warn ('这一次 pnpm install 没成功（exit ' + $code + '），换参数再试…')
    }
    return $false
}

function Get-MissingFiles {
    param([string]$PluginDir)
    $needed = @('package.json', 'client.js', 'cordis.patch.yml', 'lib\index.js', 'lib\core.js', 'lib\registry.js')
    $missing = @()
    foreach ($rel in $needed) {
        if (-not (Test-Path -LiteralPath (Join-Path $PluginDir $rel))) { $missing = $missing + $rel }
    }
    return $missing
}

# ---------------------------------------------------------------- 三条流程

function Invoke-Install {
    param([string]$DshHomePath, [string]$ProfileDir, [string]$PackagePath)

    Step '1/6 检查 DeepSeek Harness 是否已退出'
    $skipCheck = ($Force -or ($env:DSH_SESSION_TOOLS_FORCE -eq '1'))
    if (-not (Wait-ForDshExit -Skip:$skipCheck)) {
        Bad 'DSH 还在运行，装到一半会被文件锁打断。请退出后重新双击安装。'
        return 1
    }
    Ok '没有进程占用'

    Step '2/6 解包插件'
    $pluginRoot = Expand-PluginPayload -PackagePath $PackagePath
    $version = '?'
    $author = 'Weilong'
    try {
        $m = Read-Manifest -Path (Join-Path $pluginRoot 'package.json')
        $version = $m.version
        if ($m.author -is [string]) { $author = $m.author }
        elseif ($m.author -and $m.author.name) { $author = $m.author.name }
    } catch { }
    Ok ('dsh-session-tools ' + $version + '（原创作者 ' + $author + '）')

    Step '3/6 放进 plugins 目录'
    $sourceDir = Install-PluginSource -PluginRoot $pluginRoot -DshHomePath $DshHomePath
    Ok $sourceDir

    Step '4/6 写 profile 的 package.json（依赖 + bundles 条目）'
    $backup = Add-BundleEntry -ProfileDir $ProfileDir
    Ok ('已登记到 ' + (Join-Path $ProfileDir 'package.json'))
    Ok ('原文件备份：' + (Split-Path -Leaf $backup))

    Step '5/6 装进 profile 的 node_modules'
    $runtime = $null
    if (-not $NoPnpm) { $runtime = Find-PnpmRuntime -DshHomePath $DshHomePath }
    $usedPnpm = $false
    if ($runtime) {
        Ok ('用 DSH 自带的 pnpm：' + $runtime.pnpm)
        $usedPnpm = Invoke-PnpmInstall -ProfileDir $ProfileDir -Runtime $runtime
    } elseif ($NoPnpm) {
        Warn '按参数跳过 pnpm'
    } else {
        Warn '没找到 DSH 自带的 node/pnpm，走复制安装（这个插件零外部依赖，复制就够用）'
    }
    $nodeModulesDir = Join-Path $ProfileDir ('node_modules\' + $PluginName)
    if (-not $usedPnpm -or (Get-MissingFiles -PluginDir $nodeModulesDir).Count -gt 0) {
        $nodeModulesDir = Install-PluginCopy -PluginRoot $pluginRoot -ProfileDir $ProfileDir
        Ok ('直接复制到 ' + $nodeModulesDir)
    } else {
        Ok ('pnpm 已落盘：' + $nodeModulesDir)
    }

    Step '6/6 校验'
    $missing = Get-MissingFiles -PluginDir $nodeModulesDir
    if ($missing.Count -gt 0) {
        Bad ('缺文件：' + ($missing -join ', '))
    } else {
        Ok 'node_modules 里的文件齐全'
    }
    $manifest = Read-Manifest -Path (Join-Path $ProfileDir 'package.json')
    if ($manifest.dsh.profile.bundles -contains $PluginName) {
        Ok 'bundles 里已经有 dsh-session-tools'
    } else {
        Bad 'bundles 里没有 dsh-session-tools，加载器不会加载它'
    }
    if ($manifest.dependencies.PSObject.Properties[$PluginName]) {
        Ok ('依赖已登记：' + $manifest.dependencies.$PluginName)
    } else {
        Bad 'package.json 里没有登记依赖'
    }

    try { Remove-Item -LiteralPath (Split-Path -Parent $pluginRoot) -Recurse -Force } catch { }

    Say ''
    if ($script:failures -eq 0) {
        Write-Host '安装完成。' -ForegroundColor Green
        Say '接下来：打开 DeepSeek Harness（如果刚退出过，重新启动即可）。'
        Say '侧栏任意会话行右侧的 “…” 菜单里会多一行 “删除会话…”。'
        Say ''
        Say '想确认插件已加载，可在终端跑：'
        Say '  Invoke-WebRequest http://127.0.0.1:19387/session-tools/api -Method POST -Body ''{"op":"ping"}'' -ContentType ''application/json'''
        Say '  返回里 version 应该是 0.2.0，registry 是 True。'
    } else {
        Write-Host ('安装过程中有 ' + $script:failures + ' 处失败，见上面的红字。') -ForegroundColor Red
        Say '可以把整个窗口截图发给插件作者。'
    }
    return $script:failures
}

function Invoke-Uninstall {
    param([string]$DshHomePath, [string]$ProfileDir)

    Step '1/3 检查 DeepSeek Harness 是否已退出'
    $skip = ($Force -or $env:DSH_SESSION_TOOLS_FORCE -eq '1')
    if (-not (Wait-ForDshExit -Skip:$skip)) { Bad 'DSH 还在运行，先退出再卸载。'; return 1 }
    Ok '没有进程占用'

    Step '2/3 从 profile 里摘掉'
    $nodeModulesDir = Join-Path $ProfileDir ('node_modules\' + $PluginName)
    if (Test-Path -LiteralPath $nodeModulesDir) {
        Remove-Item -LiteralPath $nodeModulesDir -Recurse -Force
        Ok ('已删 ' + $nodeModulesDir)
    } else {
        Warn 'node_modules 里没有它'
    }
    $backup = Remove-BundleEntry -ProfileDir $ProfileDir
    if ($backup) { Ok ('package.json 已清理，备份：' + (Split-Path -Leaf $backup)) }

    Step '3/3 清掉源码目录'
    $sourceDir = Join-Path (Join-Path $DshHomePath 'plugins') $PluginName
    if (Test-Path -LiteralPath $sourceDir) {
        Remove-Item -LiteralPath $sourceDir -Recurse -Force
        Ok ('已删 ' + $sourceDir)
    } else {
        Warn 'plugins 目录里没有它'
    }

    Say ''
    Write-Host '卸载完成。会话数据一个都没动，只有插件本身没了。' -ForegroundColor Green
    Say '重新启动 DeepSeek Harness 生效。'
    return $script:failures
}

function Invoke-Status {
    param([string]$DshHomePath, [string]$ProfileDir)

    Step '路径'
    Ok ('DSH_HOME     : ' + $DshHomePath)
    Ok ('profile      : ' + $ProfileDir)

    Step '源码'
    $sourceDir = Join-Path (Join-Path $DshHomePath 'plugins') $PluginName
    if (Test-Path -LiteralPath $sourceDir) {
        $version = '?'
        try { $version = (Read-Manifest -Path (Join-Path $sourceDir 'package.json')).version } catch { }
        Ok ('已安装 ' + $version + '（原创作者 Weilong）-> ' + $sourceDir)
    } else {
        Warn '没有：' + $sourceDir
    }

    Step 'profile 里的安装副本'
    $nodeModulesDir = Join-Path $ProfileDir ('node_modules\' + $PluginName)
    if (Test-Path -LiteralPath $nodeModulesDir) {
        $missing = Get-MissingFiles -PluginDir $nodeModulesDir
        if ($missing.Count -eq 0) { Ok ('文件齐全 -> ' + $nodeModulesDir) }
        else { Bad ('缺文件：' + ($missing -join ', ')) }
    } else {
        Warn '没有：' + $nodeModulesDir
    }

    Step '加载器登记'
    $pkgPath = Join-Path $ProfileDir 'package.json'
    if (Test-Path -LiteralPath $pkgPath) {
        $manifest = Read-Manifest -Path $pkgPath
        if ($manifest.PSObject.Properties['dsh'] -and $manifest.dsh.PSObject.Properties['profile'] -and (@($manifest.dsh.profile.bundles) -contains $PluginName)) {
            Ok 'bundles 里有 dsh-session-tools'
        } else {
            Warn 'bundles 里没有 dsh-session-tools'
        }
        if ($manifest.PSObject.Properties['dependencies'] -and $manifest.dependencies.PSObject.Properties[$PluginName]) {
            Ok ('依赖：' + $manifest.dependencies.$PluginName)
        } else {
            Warn 'dependencies 里没有它'
        }
    }

    return $script:failures
}

# ---------------------------------------------------------------- 入口

try {
    Write-Host ''
    Write-Host '  dsh-session-tools 安装器' -ForegroundColor White
    Write-Host '  DSH 会话删除插件（真删除，不是归档）' -ForegroundColor DarkGray

    if (-not $Action) {
        Write-Host ''
        Say '  1) 安装 / 升级'
        Say '  2) 卸载'
        Say '  3) 只看状态'
        Say '  其它任意键退出'
        Write-Host ''
        $pick = Read-Host '  选择'
        switch ($pick) {
            '1' { $Action = 'install' }
            '2' { $Action = 'uninstall' }
            '3' { $Action = 'status' }
            default { Say '  什么都没做。'; exit 0 }
        }
    }

    $homePath = Resolve-DshHome -Given $DshHome
    if (-not $homePath) {
        Write-Host ''
        Bad '没找到 DSH_HOME（默认 %USERPROFILE%\.dsh）。'
        Say '  先启动一次 DeepSeek Harness，或手动指定：-DshHome "D:\path\to\.dsh"'
        exit 2
    }
    $profileDir = $null
    try {
        $profileDir = Resolve-ProfileDir -DshHomePath $homePath -Given $ProfileName
    } catch {
        if ($Action -ne 'install') { throw }
        Bad $_.Exception.Message
        exit 2
    }

    $code = 0
    if ($Action -eq 'install') { $code = Invoke-Install -DshHomePath $homePath -ProfileDir $profileDir -PackagePath $Package }
    elseif ($Action -eq 'uninstall') { $code = Invoke-Uninstall -DshHomePath $homePath -ProfileDir $profileDir }
    else { $code = Invoke-Status -DshHomePath $homePath -ProfileDir $profileDir }

    exit $code
} catch {
    Write-Host ''
    Write-Host ('安装器自身出错：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 9
}
