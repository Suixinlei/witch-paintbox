[CmdletBinding()]
param(
    [string]$RepoRoot = (Join-Path $PSScriptRoot '../../../..'),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$taskName = 'Witch Paintbox Local Service'
$taskPath = '\'
$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'WitchPaintbox'))
$serviceEnv = Join-Path $installRoot 'service.env'
$probe = Join-Path $PSScriptRoot 'probe-server.mjs'

function Get-Listener {
    Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4783 -State Listen -ErrorAction SilentlyContinue
}

function Wait-Listener([bool]$Present, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $listener = Get-Listener
        if ([bool]$listener -eq $Present) { return $listener }
        Start-Sleep -Milliseconds 400
    } while ((Get-Date) -lt $deadline)
    throw "端口 4783 未在 $Seconds 秒内达到预期状态。"
}

function Invoke-Pnpm([string]$Directory, [string[]]$Arguments) {
    Push-Location -LiteralPath $Directory
    try {
        & pnpm @Arguments | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') 失败。" }
    } finally { Pop-Location }
}

function Get-Snapshot([string]$Mode, [string]$Release) {
    $snapshot = & $node "--env-file=$serviceEnv" $probe $Mode $Release
    if ($LASTEXITCODE -ne 0) { throw '服务接口检查未通过。' }
    $snapshot | ConvertFrom-Json
}

function Assert-ServiceProcess([int]$ProcessId, [string]$Entry) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
    if (-not $process.CommandLine -or $process.CommandLine.IndexOf($Entry, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw '4783 的监听进程与预期的计划任务入口不匹配。'
    }
}

function Test-SameAction($Left, $Right) {
    $Left.Arguments -eq $Right.Arguments -and $Left.Execute -eq $Right.Execute -and
        $Left.WorkingDirectory -eq $Right.WorkingDirectory
}

if (-not (Test-Path -LiteralPath $serviceEnv -PathType Leaf)) { throw '找不到现有 service.env。' }
$task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath
if ($task.Actions.Count -ne 1) { throw '计划任务的启动方式已变化，请先核对。' }
$previous = $task.Actions[0]
$node = $previous.Execute
$current = [IO.Path]::GetFullPath($previous.WorkingDirectory)
if ((Split-Path -Leaf $node) -ne 'node.exe' -or -not (Test-Path -LiteralPath $node -PathType Leaf) -or
    -not $current.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw '计划任务与本机的魔女画匣部署不匹配。'
}
$envFlag = '--env-file="{0}"' -f $serviceEnv
$newLayout = Join-Path $current 'packages/server/index.mjs'
$entries = @($newLayout, (Join-Path $current 'service/index.mjs'))
$currentEntry = $entries | Where-Object {
    (Test-Path -LiteralPath $_ -PathType Leaf) -and $previous.Arguments -eq ('{0} "{1}"' -f $envFlag, $_)
} | Select-Object -First 1
if (-not $currentEntry) { throw '计划任务的入口或环境文件已变化，请先核对。' }
$before = Get-Listener
if (-not $before) { throw '未找到正在监听 4783 的服务，需先排查当前服务。' }
Assert-ServiceProcess $before.OwningProcess $currentEntry
if (-not $Apply) {
    $mode = if ($currentEntry -eq $newLayout) { 'full' } else { 'baseline' }
    $snapshot = Get-Snapshot $mode $current
    [pscustomobject]@{ Status='healthy'; PID=$before.OwningProcess; Idle=$snapshot.idle
        Images=$snapshot.history; LatestImageVerified=$snapshot.latestImageVerified; Address='http://127.0.0.1:4783' }
    return
}

$lease = [IO.File]::Open((Join-Path $installRoot 'deployment.lock'),
    [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $repo = (Resolve-Path -LiteralPath $RepoRoot).Path
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $release = Join-Path $installRoot ('app-monorepo-' + $stamp)
    Invoke-Pnpm $repo @('install','--frozen-lockfile')
    Invoke-Pnpm $repo @('--filter','@witch-paintbox/plugin-sifang','build')
    Invoke-Pnpm $repo @('test:service')
    $files = @('package.json','pnpm-workspace.yaml','pnpm-lock.yaml','packages/plugin-risu/package.json',
        'packages/plugin-sifang/package.json','packages/plugin-sifang/manifest.json','packages/plugin-sifang/style.css')
    $files += Get-ChildItem -LiteralPath (Join-Path $repo 'packages/server') -File | Where-Object {
        $_.Extension -in '.mjs','.js','.html','.css' -or $_.Name -eq 'package.json'
    } | ForEach-Object { 'packages/server/' + $_.Name }
    foreach ($path in $files) {
        $target = Join-Path $release $path
        $null = New-Item -ItemType Directory -Force (Split-Path -Parent $target)
        Copy-Item -LiteralPath (Join-Path $repo $path) -Destination $target
    }
    $plugin = Join-Path $repo 'packages/plugin-sifang'
    Copy-Item -LiteralPath (Join-Path $plugin 'dist'), (Join-Path $plugin 'pet') -Destination (Join-Path $release 'packages/plugin-sifang') -Recurse
    Invoke-Pnpm $release @('--filter','@witch-paintbox/server...','install','--prod','--frozen-lockfile')
    & $node $probe smoke $release | Out-Host
    if ($LASTEXITCODE -ne 0) { throw '候选服务预检失败，计划任务仍使用原版本。' }

    $baseline = Get-Snapshot 'baseline' $current
    $deadline = (Get-Date).AddSeconds(25)
    while (-not $baseline.idle -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $baseline = Get-Snapshot 'baseline' $current
    }
    if (-not $baseline.idle) { throw '规划或出图队列仍有任务，服务继续运行。' }
    if ((Get-Listener).OwningProcess -ne $before.OwningProcess) { throw '部署期间监听进程已变化，请重新检查。' }
    $currentAction = (Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath).Actions[0]
    if (-not (Test-SameAction $currentAction $previous)) { throw '部署期间计划任务已变化，请重新检查。' }

    $entry = Join-Path $release 'packages/server/index.mjs'
    $action = New-ScheduledTaskAction -Execute $node -Argument ('{0} "{1}"' -f $envFlag, $entry) -WorkingDirectory $release
    try {
        $null = Set-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $action
        Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath
        $null = Wait-Listener $false 10
        Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath
        $listener = Wait-Listener $true 40
        if ($listener.OwningProcess -eq $before.OwningProcess) { throw '服务仍使用原进程。' }
        Assert-ServiceProcess $listener.OwningProcess $entry
        $live = Get-Snapshot 'full' $release
        if ($live.revision -ne $baseline.revision -or $live.history -lt $baseline.history -or $live.risuDigest -ne $baseline.risuDigest) {
            throw '重启后的配置、图片历史或 Risu 偏好与重启前不一致。'
        }
        [pscustomobject]@{ Status='updated'; OldPID=$before.OwningProcess; NewPID=$listener.OwningProcess
            Images=$live.history; LatestImageVerified=$live.latestImageVerified; Address='http://127.0.0.1:4783'; Release=$release }
    } catch {
        $failure = $_.Exception.Message
        try {
            $registered = (Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath).Actions[0]
            $stillOriginal = Test-SameAction $registered $previous
            if (-not $stillOriginal -and -not (Test-SameAction $registered $action)) {
                throw '计划任务出现了其他变更，请人工检查。'
            }
            $unchanged = $stillOriginal -and (Get-Listener).OwningProcess -eq $before.OwningProcess
            if (-not $unchanged) {
                Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
                if (-not $stillOriginal) {
                    $null = Set-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $previous
                }
                $null = Wait-Listener $false 10
                Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath
            }
            $restored = Wait-Listener $true 40
            Assert-ServiceProcess $restored.OwningProcess $currentEntry
            $null = Get-Snapshot 'baseline' $current
        } catch { throw "新版部署失败且回退未通过。部署错误：$failure。回退错误：$($_.Exception.Message)" }
        if ($unchanged) { throw "新版部署失败，原服务仍在运行并通过接口检查。原因：$failure" }
        throw "新版部署失败，原版本已恢复并通过接口检查。原因：$failure"
    }
} finally { $lease.Dispose() }
