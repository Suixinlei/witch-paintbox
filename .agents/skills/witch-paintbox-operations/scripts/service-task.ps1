[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Get', 'Export', 'Stop', 'UseKeepalive', 'Restore', 'Start')][string]$Mode,
    [string]$BackupPath,
    [string]$KeepalivePath,
    [string]$Distro = 'Ubuntu',
    [string]$UserName,
    [string]$TaskName = 'Witch Paintbox Local Service'
)
# Windows side of the WSL2 service deployment: the one scheduled task that is still a Windows concern.
# update-server.mjs calls this through powershell.exe. Get prints JSON; every other mode prints one word.
$ErrorActionPreference = 'Stop'
$taskPath = '\'

function Get-Listener { Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 4783 -State Listen -ErrorAction SilentlyContinue }
function Wait-Listener([bool]$Present, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $listener = Get-Listener
        if ([bool]$listener -eq $Present) { return $listener }
        Start-Sleep -Milliseconds 400
    } while ((Get-Date) -lt $deadline)
    throw "Port 4783 did not reach the expected state within $Seconds seconds."
}

try {
    switch ($Mode) {
        'Get' {
            $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $taskPath
            $listener = Get-Listener
            [pscustomobject]@{
                State = "$($task.State)"
                ListenerPid = $(if ($listener) { $listener[0].OwningProcess } else { 0 })
                ListenerImage = $(if ($listener) { (Get-Process -Id $listener[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName } else { '' })
                Actions = @($task.Actions | ForEach-Object {
                    [pscustomobject]@{ Execute = $_.Execute; Arguments = $_.Arguments; WorkingDirectory = $_.WorkingDirectory }
                })
            } | ConvertTo-Json -Depth 4 -Compress
        }
        'Export' {
            Export-ScheduledTask -TaskName $TaskName -TaskPath $taskPath | Set-Content -LiteralPath $BackupPath -Encoding Unicode
            'exported'
        }
        'Stop' {
            Stop-ScheduledTask -TaskName $TaskName -TaskPath $taskPath
            $null = Wait-Listener $false 15
            'stopped'
        }
        'UseKeepalive' {
            # A headless console: the task keeps its interactive sign-in trigger, so without this the
            # keep-alive would put a console window on the desktop.
            $arguments = @('--headless', "$env:SystemRoot\System32\wsl.exe", '-d', $Distro, '-u', $UserName, '--exec', $KeepalivePath) -join ' '
            $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument $arguments -WorkingDirectory $env:USERPROFILE
            $null = Set-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Action $action
            'keepalive'
        }
        'Restore' {
            $xml = Get-Content -LiteralPath $BackupPath -Raw
            $null = Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -Xml $xml -Force
            'restored'
        }
        'Start' {
            Start-ScheduledTask -TaskName $TaskName -TaskPath $taskPath
            'started'
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
