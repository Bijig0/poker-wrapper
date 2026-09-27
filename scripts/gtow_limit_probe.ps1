# Supervisor for the GTO Wizard limit probe (gto-trainer/apps/api/src/scripts/gtowLimitProbe.ts), 2026-09-26.
#
# The probe runs for about a day and resumes from its state file, so this only has to keep it alive: run it, and
# if it exits before both accounts are finished (done / stopped) and before any alarm, start it again 30 s later.
# Why it exists: two probe runs launched straight from a tool shell died silently mid-request (no crash, no exit
# line) - a scheduled task under this loop does not depend on any shell staying open.
#
#   powershell scripts/gtow_limit_probe.ps1 -Install   # register the one-off task GtowLimitProbe and start it
#   powershell scripts/gtow_limit_probe.ps1 -Uninstall # stop and remove the task (the probe's state is kept)
#   (the task itself runs this file with no switch)

param([switch]$Install, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'GtowLimitProbe'
$api = (Resolve-Path (Join-Path $PSScriptRoot '..\gto-trainer\apps\api')).Path
$stateFile = Join-Path $api 'data\jobs\gtow_limit_probe.state.json'
$logFile = Join-Path $api 'data\jobs\gtow_limit_probe.log'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "unregistered $TaskName"
    } else { Write-Host "$TaskName is not registered" }
    Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object { $_.CommandLine -like '*gtowLimitProbe.ts*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "stopped probe pid $($_.ProcessId)" }
    exit 0
}

if ($Install) {
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
        -Argument "--headless $env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "registered and started $TaskName -> $PSCommandPath"
    exit 0
}

function Log($msg) {
    $line = "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))Z [supervisor] $msg"
    [System.IO.File]::AppendAllText($logFile, "$line`n")
}

function Finished {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $false }
    try { $s = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { return $false }
    if ($s.alarm) { return $true }
    $terminal = @('done', 'stopped')
    return ($terminal -contains $s.accts.secondary.phase) -and ($terminal -contains $s.accts.primary.phase)
}

# one supervisor at a time
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\PokerGtowLimitProbe', [ref]$created)
if (-not $created) { exit 0 }

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = "$env:LOCALAPPDATA\Programs\node-v24.18.0-win-x64\node_modules\bun\bin\bun.exe" }

Log "started (pid $PID), bun $bun"
$runs = 0
while (-not (Finished)) {
    $runs++
    $t0 = Get-Date
    & cmd.exe /c "cd /d `"$api`" && `"$bun`" src\scripts\gtowLimitProbe.ts >> data\jobs\gtow_limit_probe.out 2>&1"
    $code = $LASTEXITCODE
    $mins = [Math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
    if (Finished) { Log "probe exited (code $code) after $mins min - both accounts finished"; break }
    Log "probe exited (code $code) after $mins min before finishing - restarting in 30 s (run $runs)"
    Start-Sleep -Seconds 30
}
Log "done"
$mutex.ReleaseMutex()
