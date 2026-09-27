# Poker Wrapper — update to the latest release (or any published version). Double-click setup\update.cmd, or press
# "Update now" on the setup page's banner.
#
#   powershell -ExecutionPolicy Bypass -File setup\update.ps1              ask, then update
#   ... -Check                  only say whether an update is waiting (exit 10 = yes, 0 = up to date, 1 = cannot tell)
#   ... -Version 2026.09.23.1722    install that version (rolling back is just naming an older one)
#   ... -Yes                    do not ask      -Relaunch   reopen the Poker Wrapper when done
#
# What it does: refuses while a session is running; closes the Poker Wrapper; stops the three services; replaces
# only the files that changed (and removes files the new version dropped); fetches any data part that changed;
# then runs setup (packages, settings, services, checklist) and restarts everything.
# What it never touches: config\local.env, your hands and sessions (the data folders), sign-ins, the venv.
param([string]$Version = '', [switch]$Check, [switch]$Yes, [switch]$Relaunch, [switch]$Force,
      # testing a second install on a machine that runs a live one: other ports, and leave the scheduled tasks alone
      [int]$ApiPort = 2000, [int]$ChartPort = 8777, [int]$PanelPort = 7700, [switch]$SkipTasks,
      [string]$WrapperArgs = '')   # extra wrapper arguments for -Relaunch (a non-default instance: --panel-port N --cdp-port N)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'channel.ps1')
function Say($m, $c = 'Gray') { Write-Host "  $m" -ForegroundColor $c }
function Finish([int]$code) {
  if ($Relaunch) { Start-Wrapper }
  # a one-press update (-Yes) closes its window on success; on a failure it stays up so the message is read
  if (-not $Check -and (-not $Yes -or $code -ne 0)) { Write-Host ''; Read-Host '  Press Enter to close' | Out-Null }
  exit $code
}
function Start-Wrapper {
  # the wrapper, hidden — what the desktop shortcut runs
  $vbs = Join-Path $root 'ignition-study-wrapper\run-wrapper.vbs'
  if (Test-Path $vbs) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList "`"$vbs`" $WrapperArgs" -WorkingDirectory (Split-Path $vbs)
    Say 'reopened the Poker Wrapper' Green
  }
}

# the owner's source checkout updates from git, never from a release zip
if ((Test-Path (Join-Path $root '.git')) -and -not $Force) {
  Say "this folder is the source checkout ($root) — releases are published FROM it, not installed into it." Yellow
  exit 1
}

Write-Host 'Poker Wrapper — update' -ForegroundColor White
$inst = Get-Installed $root
$rel = Get-Release $Version
if (-not $rel) {
  Say "cannot read the update channel ($Channel$(if ($Version) { " version $Version" })) — is the internet up? Is the download key set (setup step 2)?" Red
  if ($Check) { exit 1 } else { Finish 1 }
}
$haveData = Get-InstalledData $root
$dataBehind = @($rel.data.PSObject.Properties | Where-Object { $haveData[$_.Name] -ne $_.Value.version } | ForEach-Object { $_.Name })
$codeBehind = (-not $inst) -or ($inst.version -ne $rel.version)
Say "installed: $(if ($inst) { $inst.version } else { '(unknown)' })   $(if ($Version) { 'requested' } else { 'latest' }): $($rel.version)"
if ($rel.notes) { Say "what's new: $($rel.notes)" Cyan }
if ($Check) { if ($codeBehind -or $dataBehind.Count) { Say 'an update is waiting' Yellow; exit 10 } else { Say 'up to date' Green; exit 0 } }
if (-not $codeBehind -and -not $dataBehind.Count -and -not $Force) { Say 'already up to date' Green; Finish 0 }

# 1. never in the middle of a session
$sess = $null
try { $sess = Invoke-RestMethod "http://127.0.0.1:$PanelPort/session" -TimeoutSec 5 } catch { }
if ($sess -and $sess.current) {
  Say 'a session is running — end it on the panel first, then update.' Red
  Finish 2
}
if (-not $Yes) {
  $mb = [math]::Round($rel.code.bytes / 1MB, 1)
  $dmb = ($dataBehind | ForEach-Object { $rel.data.$_.bytes } | Measure-Object -Sum).Sum
  $a = Read-Host "  Download $mb MB$(if ($dataBehind.Count) { " + $([math]::Round($dmb / 1MB)) MB of data" }) and update now? (Y/n)"
  if ($a -match '^[nN]') { Say 'cancelled'; Finish 0 }
}

# 2. the code zip, verified, unpacked beside the install
$zip = Get-ChannelFile "$Channel/releases/$($rel.version)/$($rel.code.file)" $rel.code.file $rel.code.sha256 $rel.code.bytes
if (-not $zip) { Say 'the download failed or did not match its checksum — nothing was changed. Try again.' Red; Finish 1 }
$stage = Join-Path $env:TEMP "pokerwrapper-update-$($rel.version)"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null
& "$env:SystemRoot\System32\tar.exe" -xf $zip -C $stage   # Windows' bsdtar: Git's GNU tar cannot read a zip
$new = Get-Installed (Join-Path $stage 'PokerWrapper')
if ($LASTEXITCODE -ne 0 -or -not $new) { Say 'could not unpack the update — nothing was changed.' Red; Finish 1 }

# 3. stop what runs from this folder: the wrapper, then the three services (their supervisors, then the servers)
Say 'closing the Poker Wrapper and stopping the services ...'
try { $null = Invoke-RestMethod "http://127.0.0.1:$PanelPort/quit" -Method Post -TimeoutSec 5 } catch { }
# this user's tasks, plus the pre-2026.09.23 names (their scripts are this folder's; the kill below is folder-scoped too)
if (-not $SkipTasks) { foreach ($t in @($TaskNames.Values) + $LegacyTaskNames) { $x = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue; if ($x -and (($x.Actions | ForEach-Object { $_.Arguments }) -join ' ') -like "*$root\*") { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } } }
$mine = [regex]::Escape($root)
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match $mine -and
  ($_.CommandLine -match 'study-api\.ps1|chart-server\.ps1|gtow_watchdog\.ps1|run-study\.pyw|run-tables\.pyw|apps\\wrapper\\src\\main\.ts|charts\\chartServer\.ts|wrapper\.cmd')
} | ForEach-Object { & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }
foreach ($port in $ApiPort, $ChartPort) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { & taskkill /PID $_.OwningProcess /T /F 2>&1 | Out-Null }
}
Start-Sleep -Seconds 2

# 4. apply: copy what changed, remove what the new version dropped. Compared manifest to manifest (a file the old
#    version never listed, or one missing on disk, is copied too).
$old = @{}
if ($inst -and $inst.files) { $inst.files.PSObject.Properties | ForEach-Object { $old[$_.Name] = $_.Value } }
$copied = 0; $removed = 0; $failed = @()
foreach ($f in $new.files.PSObject.Properties) {
  $dst = Join-Path $root $f.Name
  if ($old[$f.Name] -eq $f.Value -and (Test-Path -LiteralPath $dst)) { continue }
  $src = Join-Path $stage "PokerWrapper\$($f.Name)"
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
    $copied++
  } catch { $failed += $f.Name }
}
$keep = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($f in $new.files.PSObject.Properties) { [void]$keep.Add($f.Name) }
foreach ($k in @($old.Keys)) {
  if (-not $keep.Contains($k)) {
    $p = Join-Path $root $k
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; $removed++ }
  }
}
if ($failed.Count) {
  Say "$($failed.Count) file(s) could not be replaced (in use?): $($failed[0..4] -join ', ') — close everything and run update again." Red
  Finish 1
}
Copy-Item (Join-Path $stage 'PokerWrapper\VERSION.json') (Join-Path $root 'VERSION.json') -Force
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
Say "code: $copied file(s) updated, $removed removed -> $($new.version)" Green

# 5. everything else is setup's job (it is safe to re-run): data parts for this version, packages, settings,
#    services (restarted), the checklist
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup.ps1') -SkipTools -SkipShortcut -NoPrompt $(if ($SkipTasks) { '-SkipTasks' })
Write-Host ''
Say "updated to $($new.version)." Green
Finish 0
