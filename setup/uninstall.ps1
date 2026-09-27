# Stop everything THIS install runs — and, without -StopOnly, unregister its services. The installer runs it:
#   -StopOnly   before copying files over an existing install (an upgrade or a repair): the running bun.exe and
#               supervisors hold files it has to replace. Exit 2 = a session is running (the installer says so and stops).
#   (no switch) from the uninstaller: the same, then the three scheduled tasks and the GTO Wizard window go too.
# Only ever touches processes and tasks that belong to THIS folder: on a machine that also runs a source checkout (the
# owner's dev tasks StudyAPI / ChartServer, a live wrapper on :7700) none of those are this install's, so none are stopped.
param([switch]$StopOnly, [int]$PanelPort = 7700)
$ErrorActionPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'channel.ps1')
$mine = [regex]::Escape($root)
function Mine($procId) { $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId").CommandLine; return ($c -and $c -match $mine) }

# 1. the wrapper on the panel port, if it is this install's: never mid-session; otherwise ask it to close
$holder = Get-NetTCPConnection -LocalPort $PanelPort -State Listen | Select-Object -First 1
if ($holder -and (Mine $holder.OwningProcess)) {
  $sess = $null
  try { $sess = Invoke-RestMethod "http://127.0.0.1:$PanelPort/session" -TimeoutSec 5 } catch { }
  if ($StopOnly -and $sess -and $sess.current) { Write-Host 'a Poker Wrapper session is running - end it first'; exit 2 }
  try { $null = Invoke-RestMethod "http://127.0.0.1:$PanelPort/quit" -Method Post -TimeoutSec 5 } catch { }
}

# 2. this user's three services — only when they run this folder's scripts
$ownsGtow = $false
foreach ($t in @($TaskNames.Values)) {
  $x = Get-ScheduledTask -TaskName $t
  if ($x -and (($x.Actions | ForEach-Object { $_.Arguments }) -join ' ') -like "*$root\*") {
    if ($t -eq $TaskNames.gtow) { $ownsGtow = $true }
    Stop-ScheduledTask -TaskName $t
    if (-not $StopOnly) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; Write-Host "removed $t" }
  }
}

# 3. whatever still runs from this folder: the supervisors, then the servers and the wrapper (each with its tree).
#    By NAME as well as folder: the uninstaller's own temp copy carries this folder on its command line (/SECONDPHASE=)
Start-Sleep -Seconds 1
$ours = 'powershell.exe', 'cmd.exe', 'bun.exe', 'wscript.exe', 'rclone.exe'
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $ours -contains $_.Name -and $_.CommandLine -and $_.CommandLine -match $mine } |
  Sort-Object { if ($_.Name -eq 'powershell.exe') { 0 } else { 1 } } |
  ForEach-Object { & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }

# 4. uninstall only: the GTO Wizard window (its own Chrome profile, matched by that profile — never Chrome by name) —
#    and only when THIS install's watchdog kept it: the profile folder is the same default for every install on the
#    machine, so a test copy (/NOSERVICES) or a second install must never close the one the owner's stack reads
if (-not $StopOnly -and $ownsGtow) {
  $profile = if ($env:GTOW_CHROME_PROFILE) { $env:GTOW_CHROME_PROFILE } else { "$env:LOCALAPPDATA\gtow-cdp-profile" }
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*--user-data-dir=$profile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
Start-Sleep -Seconds 1
exit 0
