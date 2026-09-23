# Register the three services that keep the Poker Wrapper's back end up, as logon tasks for the current user.
# Each restarts itself if it dies and comes back after a reboot. Names carry the Windows user (setup\channel.ps1
# $TaskNames), so a second account on the same laptop gets its own and never replaces anyone else's:
#
#   PokerWrapper API - <user>          .claude\study-api.ps1     the study API + dashboard on :2000
#   PokerWrapper Charts - <user>       .claude\chart-server.ps1  the HRC chart server on :8777
#   PokerWrapper GTO Wizard - <user>   scripts\gtow_watchdog.ps1 keeps the GTO Wizard session (Chrome, CDP :9222) up
#
#   powershell -ExecutionPolicy Bypass -File setup\install_tasks.ps1 [-Start] [-Uninstall] [-BothGtowAccounts]
param([switch]$Start, [switch]$Uninstall, [switch]$BothGtowAccounts)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'channel.ps1')

function Register-Hidden([string]$name, [string]$script, [string]$extra = '') {
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless $env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"$extra"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "  registered $name -> $script$extra"
}

$tasks = @(
  @{ name = $TaskNames.api;    script = Join-Path $root '.claude\study-api.ps1';     extra = '' },
  @{ name = $TaskNames.charts; script = Join-Path $root '.claude\chart-server.ps1';  extra = '' },
  @{ name = $TaskNames.gtow;   script = Join-Path $root 'scripts\gtow_watchdog.ps1'; extra = $(if ($BothGtowAccounts) { '' } else { ' -Only primary' }) }
)

# an install from before per-user names registered StudyAPI / ChartServer / GtowWatchdog: remove those, but ONLY
# the ones whose action runs a script in THIS folder (the owner's dev tasks point at the source checkout)
foreach ($old in $LegacyTaskNames) {
  $t = Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
  if ($t -and (($t.Actions | ForEach-Object { $_.Arguments }) -join ' ') -like "*$root\*") {
    Stop-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $old -Confirm:$false
    Write-Host "  removed the old task $old (it ran this install)"
  }
}

if ($Uninstall) {
  foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskName $t.name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $t.name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t.name -Confirm:$false
      Write-Host "  unregistered $($t.name)"
    }
  }
  exit 0
}
foreach ($t in $tasks) {
  if (-not (Test-Path $t.script)) { throw "missing $($t.script)" }
  Register-Hidden $t.name $t.script $t.extra
}
if ($Start) { foreach ($t in $tasks) { Start-ScheduledTask -TaskName $t.name }; Write-Host "  started all three" }
