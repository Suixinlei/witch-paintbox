param(
    [string]$RisuRoot,
    [switch]$Apply,
    [switch]$PageClosed,
    [string]$Rollback
)
$ErrorActionPreference = 'Stop'
if ($Apply -and $Rollback) { throw 'Choose -Apply or -Rollback, not both.' }
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not $RisuRoot) {
    foreach ($candidate in @((Join-Path $pluginRoot '../../../risu'), (Join-Path $pluginRoot '../risu'), (Join-Path $pluginRoot '../..'))) {
        $candidatePackage = Join-Path $candidate 'package.json'
        if ((Test-Path -LiteralPath $candidatePackage) -and ((Get-Content -LiteralPath $candidatePackage -Raw | ConvertFrom-Json).name -eq 'risuai')) {
            $RisuRoot = [IO.Path]::GetFullPath($candidate)
            break
        }
    }
}
if (-not $RisuRoot) { throw 'Cannot locate Risu checkout; pass -RisuRoot.' }
$bundledNode = Join-Path $RisuRoot '.local/windows-tools/node_modules/node/bin/node.exe'
$nodeExecutable = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
$updateArgs = @('--experimental-strip-types', (Join-Path $PSScriptRoot 'update-local.ts'), '--risu-root', $RisuRoot)
if ($Apply) { $updateArgs += '--apply' }
if ($PageClosed) { $updateArgs += '--page-closed' }
if ($Rollback) { $updateArgs += @('--rollback', $Rollback) }
& $nodeExecutable @updateArgs
if ($LASTEXITCODE -ne 0) { throw "Plugin update stopped (exit $LASTEXITCODE)." }
