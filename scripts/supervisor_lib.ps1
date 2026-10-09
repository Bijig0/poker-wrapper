# What every supervisor does about its OWN config (2026-10-10). Dot-sourced by .claude\study-api.ps1,
# .claude\chart-server.ps1 and scripts\gtow_watchdog.ps1 right after config\env.ps1.
#
# Until now a supervisor read its script, config\env.ps1 and config\local.env ONCE, at start: a local.env edit sat
# unread until someone restarted the supervisor by hand, and the setup page said "BEHIND THE DISK ... restart the
# supervisor" until they did. Now (stamp protocol 2, the TypeScript side is gto-trainer\apps\api\src\services\
# supervisorRestart.ts):
#
#   RE-READ BEFORE EVERY WORKER START (API + chart server: Update-SupervisorConfig). config\env.ps1 lets a value already
#   in the environment win, so a plain second dot-source would change nothing: the environment is put back to what the
#   task handed over (the snapshot taken before the first env.ps1) and env.ps1 runs again. THE PORT IS NOT RE-READ: a
#   PORT_OFFSET / PORT / HRC_UI_PORT change is refused (the old environment is put back) and marked `needsReplace` in
#   the stamp - the probes, the straggler sweep and the wrapper all know the old port, so only a fresh supervisor may
#   move it.
#
#   SELF-REPLACE ON REQUEST (all three). The worker (or, for the watchdog, the API) writes the request file
#   data\jobs\supervisor-<name>.replace.json when the supervisor's script / its lib changed, a port moved, or (watchdog)
#   anything in its stamp changed - and only when no poker session is live. The FILE is the signal (an API / chart
#   worker also exits 3, for the log). Get-SupervisorReplaceRequest checks it after every worker exit (the watchdog:
#   every minute); Invoke-SupervisorReplace puts the environment back to the task's, spawns scripts\
#   supervisor_replace.ps1 detached and returns - the caller then EXITS 0 at once. The helper waits for this process
#   and its headless console to be gone, then Start-ScheduledTask (a clean exit takes the console with it, so the task
#   is free to start again), and falls back to clearing an orphaned headless console + spawning the script directly.
#   The new supervisor's "another supervisor is already running" guard (command line / mutex) still protects against
#   two; the helper's own command line never names the supervisor's script, so the guard does not mistake it for one.
#
#   GUARDS: the worker side asks at most once per supervisor every 5 min, after the change is quiet, with the worker
#   up >= 60 s, never during a session; this side refuses a request in its own first 2 minutes, and refuses (records
#   `refused` in the stamp, keeps running) when its script, this lib, config\env.ps1 or the helper does not parse.
#
# THE TASK-SCHEDULER TRAP: after a Stop-Process of a supervisor's powershell, its headless conhost.exe can linger
# (parent = the task engine, no children) and the task then refuses a new instance (MultipleInstances IgnoreNew,
# LastTaskResult 0x800710E0) while it reads "Running". Stop that conhost (it has no children) and start the task again.
# A clean exit (exit 0, which is what a self-replace does) takes the conhost with it.

$script:SupLibPath = $PSCommandPath
$script:SupHelper = Join-Path $PSScriptRoot 'supervisor_replace.ps1'
$script:SupProtocol = 2
# setup\channel.ps1 $TaskNames - the scheduled tasks setup\install_tasks.ps1 registers
$script:SupTaskNames = @{ api = "PokerWrapper API - $env:USERNAME"; charts = "PokerWrapper Charts - $env:USERNAME"; gtow = "PokerWrapper GTO Wizard - $env:USERNAME" }
# ONE state variable, named so no supervisor can share it: PowerShell names are case-insensitive, and a lib variable
# called $Sup overwrote study-api.ps1's / chart-server.ps1's $sup (their log path) - caught in the sandbox run
$script:SupervisorState = $null

function Write-SupLog([string]$m) {
  if ($script:SupervisorState -and $script:SupervisorState.LogFile) { try { Add-Content -LiteralPath $script:SupervisorState.LogFile -Value "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] $m" } catch { } }
}

function Get-SupFileHash([string]$path) {
  if ($path -and (Test-Path -LiteralPath $path)) { try { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() } catch { } }
  return 'absent'
}

function Get-SupFullPath([string]$path) { return [IO.Path]::GetFullPath($path) }

# local.env's keys the way config\env.ps1 reads them (first line for a key wins, blank values ignored) -> the first 16 hex
# of sha256(value). Only these hashes go in the stamp, never the values (services/supervisorRestart.ts localEnvKeyHashes).
function Get-LocalEnvKeyHashes([string]$path) {
  $out = [ordered]@{}
  if (-not ($path -and (Test-Path -LiteralPath $path))) { return $out }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($line in Get-Content -LiteralPath $path) {
      $l = ($line -replace '\s+#.*$', '').Trim()
      if (-not $l -or $l.StartsWith('#') -or $l -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
      $k = $Matches[1]; $v = $Matches[2].Trim().Trim('"')
      if (-not $v -or $out.Contains($k)) { continue }
      $out[$k] = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($v)) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)
    }
  } finally { $sha.Dispose() }
  return $out
}

function Restore-SupEnv($snap) {
  $now = [Environment]::GetEnvironmentVariables('Process')
  foreach ($k in @($now.Keys)) { if (-not $snap.ContainsKey($k)) { try { [Environment]::SetEnvironmentVariable([string]$k, $null, 'Process') } catch { } } }
  foreach ($k in @($snap.Keys)) { try { [Environment]::SetEnvironmentVariable([string]$k, [string]$snap[$k], 'Process') } catch { } }
}

function Get-SupEnvHashes {
  $h = [ordered]@{}
  foreach ($f in @($script:SupervisorState.EnvPs1, $script:SupervisorState.LocalEnv)) { $h[$f] = Get-SupFileHash $f }
  return $h
}

function Write-SupStamp {
  try {
    $s = $script:SupervisorState
    if (-not (Test-Path -LiteralPath $s.JobsDir)) { New-Item -ItemType Directory -Force -Path $s.JobsDir | Out-Null }
    $files = [ordered]@{}
    foreach ($k in $s.CodeHashes.Keys) { $files[$k] = $s.CodeHashes[$k] }
    foreach ($k in $s.EnvHashes.Keys) { $files[$k] = $s.EnvHashes[$k] }
    $stamp = [ordered]@{
      name = $s.Name; pid = $PID; startedAt = $s.StartedAt.ToString('yyyy-MM-ddTHH:mm:ss'); envReadAt = $s.EnvReadAt.ToString('yyyy-MM-ddTHH:mm:ss')
      protocol = $script:SupProtocol; task = $s.TaskName; files = $files
      reread = [string[]]$(if ($s.Reread) { @($s.EnvPs1, $s.LocalEnv) } else { @() })
      envKeys = $s.EnvKeys; needsReplace = $s.NeedsReplace; refused = $s.Refused
    }
    # WriteAllText = UTF-8 without a BOM (Out-File in PowerShell 5.1 would add one)
    [IO.File]::WriteAllText((Join-Path $s.JobsDir "supervisor-$($s.Name).json"), ($stamp | ConvertTo-Json -Depth 5))
  } catch { Write-SupLog "could not write the start stamp: $($_.Exception.Message)" }
}

# Call once, after config\env.ps1, where the old Write-SupervisorStamp call was. -BaseEnv = the environment captured
# BEFORE config\env.ps1 ran. -Keep = variables this supervisor sets for its worker (put back after every re-read).
function Start-SupervisorState {
  param(
    [Parameter(Mandatory)][ValidateSet('api', 'charts', 'gtow')][string]$Name,
    [Parameter(Mandatory)]$BaseEnv,
    [string[]]$CodeFiles = @(),
    [switch]$Reread,
    [string[]]$PortVars = @(),
    [string]$LogFile,
    [hashtable]$Keep = @{},
    [scriptblock]$AfterRead = $null,
    [string]$RelaunchArgs = '',
    [string]$JobsDir = ''
  )
  $base = @{}
  foreach ($k in @($BaseEnv.Keys)) { if ([string]$k -ne 'POKER_SUPERVISOR_REPLACED') { $base[[string]$k] = [string]$BaseEnv[$k] } }
  $code = [ordered]@{}
  foreach ($f in (@($CodeFiles) + @($script:SupLibPath) | Where-Object { $_ })) { $p = Get-SupFullPath $f; $code[$p] = Get-SupFileHash $p }
  $ports = @{}
  foreach ($v in $PortVars) { $ports[$v] = [Environment]::GetEnvironmentVariable($v, 'Process') }
  $script:SupervisorState = @{
    Name = $Name; BaseEnv = $base; CodeHashes = $code; Reread = [bool]$Reread; PortVars = $PortVars; Ports = $ports
    LogFile = $LogFile; Keep = $Keep; AfterRead = $AfterRead; RelaunchArgs = $RelaunchArgs
    JobsDir = $(if ($JobsDir) { $JobsDir } else { Join-Path $env:POKER_ROOT 'gto-trainer\apps\api\data\jobs' })
    EnvPs1 = Get-SupFullPath (Join-Path $env:POKER_ROOT 'config\env.ps1'); LocalEnv = Get-SupFullPath (Join-Path $env:POKER_ROOT 'config\local.env')
    TaskName = $script:SupTaskNames[$Name]; StartedAt = Get-Date; EnvReadAt = Get-Date
    NeedsReplace = $null; Refused = $null; EnvHashes = $null; EnvKeys = $null
  }
  # what env.ps1 + local.env were when they were read just now (the caller dot-sourced env.ps1 a moment ago)
  $script:SupervisorState.EnvHashes = Get-SupEnvHashes
  $script:SupervisorState.EnvKeys = Get-LocalEnvKeyHashes $script:SupervisorState.LocalEnv
  foreach ($k in $Keep.Keys) { Set-Item "env:$k" ([string]$Keep[$k]) }
  $replaced = [Environment]::GetEnvironmentVariable('POKER_SUPERVISOR_REPLACED', 'Process')
  if ($replaced) {
    Write-SupLog "supervisor started (pid $PID) after a self-replace: $replaced"
    [Environment]::SetEnvironmentVariable('POKER_SUPERVISOR_REPLACED', $null, 'Process')
  }
  # a request left for an earlier supervisor is satisfied by this fresh start: it read the disk as it is now
  $req = Join-Path $script:SupervisorState.JobsDir "supervisor-$Name.replace.json"
  if (Test-Path -LiteralPath $req) { Remove-Item -LiteralPath $req -Force -ErrorAction SilentlyContinue; Write-SupLog "removed a restart request left for an earlier supervisor" }
  Write-SupStamp
}

# Before every worker start (API + chart server): re-read config\env.ps1 + config\local.env when either changed.
function Update-SupervisorConfig {
  $s = $script:SupervisorState
  if (-not $s -or -not $s.Reread) { return }
  $h = Get-SupEnvHashes
  $same = $true
  foreach ($k in $h.Keys) { if ($h[$k] -ne $s.EnvHashes[$k]) { $same = $false } }
  if ($same) { return }
  $keys = Get-LocalEnvKeyHashes $s.LocalEnv
  $prev = [Environment]::GetEnvironmentVariables('Process')
  $errs = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($s.EnvPs1, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count) {
    $why = "config\env.ps1 does not parse: $($errs[0].Message) (line $($errs[0].Extent.StartLineNumber)) - kept the config read before"
    if ($s.Refused.why -ne $why) { Write-SupLog "config re-read REFUSED: $why" }
    $s.Refused = [ordered]@{ why = $why; files = $h }
    Write-SupStamp
    return
  }
  Restore-SupEnv $s.BaseEnv
  try { . $s.EnvPs1 } catch {
    Restore-SupEnv $prev
    $why = "config\env.ps1 failed: $($_.Exception.Message -replace '\s+', ' ') - kept the config read before"
    if ($s.Refused.why -ne $why) { Write-SupLog "config re-read REFUSED: $why" }
    $s.Refused = [ordered]@{ why = $why; files = $h }
    Write-SupStamp
    return
  }
  $moved = @(foreach ($v in $s.PortVars) {
    $now = [Environment]::GetEnvironmentVariable($v, 'Process')
    if ($now -ne $s.Ports[$v]) { "$v $($s.Ports[$v]) -> $now" }
  })
  if ($moved.Count) {
    Restore-SupEnv $prev
    $why = "the port moved ($($moved -join ', ')) - only a fresh supervisor may serve it"
    if ($s.NeedsReplace -ne $why) { Write-SupLog "config re-read: $why; this worker starts on the old config, the supervisor replaces itself when no session is live" }
    $s.NeedsReplace = $why
    Write-SupStamp
    return
  }
  foreach ($k in $s.Keep.Keys) { Set-Item "env:$k" ([string]$s.Keep[$k]) }
  if ($s.AfterRead) { & $s.AfterRead }
  $files = @($h.Keys | Where-Object { $h[$_] -ne $s.EnvHashes[$_] } | ForEach-Object { Split-Path $_ -Leaf })
  $changedKeys = @(@($keys.Keys) + @($s.EnvKeys.Keys) | Select-Object -Unique | Where-Object { $keys[$_] -ne $s.EnvKeys[$_] } | Sort-Object)
  Write-SupLog "config re-read before this start: $($files -join ', ') changed$(if ($changedKeys.Count) { " (local.env keys: $($changedKeys -join ', '))" })"
  $s.EnvHashes = $h; $s.EnvKeys = $keys; $s.NeedsReplace = $null; $s.Refused = $null; $s.EnvReadAt = Get-Date
  Write-SupStamp
}

# Does every file a fresh supervisor would read parse? null = yes, else why not.
function Test-SupervisorParse {
  foreach ($f in (@($script:SupervisorState.CodeHashes.Keys) + @($script:SupervisorState.EnvPs1, $script:SupHelper))) {
    if (-not (Test-Path -LiteralPath $f)) { return "$f is missing" }
    $errs = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs)
    if ($errs -and $errs.Count) { return "$(Split-Path $f -Leaf) does not parse: $($errs[0].Message) (line $($errs[0].Extent.StartLineNumber))" }
  }
  return $null
}

# After a worker exit (the watchdog: every minute): the request to replace this supervisor, or $null.
function Get-SupervisorReplaceRequest {
  param($ExitCode = $null, [int]$MinUptimeSec = 120)
  $s = $script:SupervisorState
  if (-not $s) { return $null }
  $file = Join-Path $s.JobsDir "supervisor-$($s.Name).replace.json"
  if (-not (Test-Path -LiteralPath $file)) {
    if ("$ExitCode" -eq '3') { Write-SupLog "worker exited 3 but left no request file - a plain relaunch" }
    return $null
  }
  $r = $null
  try { $r = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { }
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  if (-not $r) { Write-SupLog "unreadable restart request removed"; return $null }
  if ($r.supervisorPid -and [int]$r.supervisorPid -ne $PID) { Write-SupLog "restart request for pid $($r.supervisorPid), not this one (pid $PID) - removed"; return $null }
  $up = [int]((Get-Date) - $s.StartedAt).TotalSeconds
  if ($up -lt $MinUptimeSec) { Write-SupLog "self-replace REFUSED ($($r.why)): this supervisor started only $up s ago (loop guard, $MinUptimeSec s)"; return $null }
  $bad = Test-SupervisorParse
  if ($bad) {
    Write-SupLog "self-replace REFUSED ($($r.why)): $bad - the old supervisor keeps running; fix the file"
    $all = [ordered]@{}
    foreach ($k in $s.CodeHashes.Keys) { $all[$k] = Get-SupFileHash $k }
    foreach ($k in $s.EnvHashes.Keys) { $all[$k] = Get-SupFileHash $k }
    $all[(Get-SupFullPath $script:SupHelper)] = Get-SupFileHash $script:SupHelper
    $s.Refused = [ordered]@{ why = "a fresh supervisor would not start: $bad"; files = $all }
    Write-SupStamp
    return $null
  }
  return $r
}

# Hand over to scripts\supervisor_replace.ps1; returns the helper's process, and the CALLER then exits 0 at once (the
# helper waits for that). $null = the helper could not be started: the environment is as it was, keep supervising.
# -DryRun: the helper only says what it would do (and this process is expected to carry on - tests).
function Invoke-SupervisorReplace {
  param([Parameter(Mandatory)]$Request, [switch]$DryRun)
  $s = $script:SupervisorState
  $why = "$($Request.why)"
  Write-SupLog "supervisor replacing itself: $why (asked by $($Request.by))$(if ($DryRun) { ' [DRY RUN]' })"
  $console = 0
  try {
    $me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($parent -and $parent.Name -eq 'conhost.exe') { $console = [int]$parent.ProcessId }
  } catch { }
  # the helper and the supervisor it starts get the environment the task handed over: env.ps1 lets a value already in
  # the environment win, so a child of this process would otherwise keep every local.env value this one read
  $prev = [Environment]::GetEnvironmentVariables('Process')
  if (-not $DryRun) { Restore-SupEnv $s.BaseEnv }
  $env:POKER_SUPERVISOR_REPLACED = "$why (replaced pid $PID)"
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$script:SupHelper`"",
         '-Name', $s.Name, '-OldPid', "$PID", '-OldConsolePid', "$console", '-TaskName', "`"$($s.TaskName)`"",
         '-LogFile', "`"$($s.LogFile)`"", '-JobsDir', "`"$($s.JobsDir)`"")
  if ($s.RelaunchArgs) { $a += @('-RelaunchArgsB64', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s.RelaunchArgs))) }
  if ($DryRun) { $a += '-DryRun' }
  try {
    $h = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $a -WindowStyle Hidden -PassThru
    Write-SupLog "replace helper started (pid $($h.Id)); this supervisor (pid $PID$(if ($console) { ", console $console" })) $(if ($DryRun) { 'carries on [DRY RUN]' } else { 'exits now' })"
    return $h
  } catch {
    Write-SupLog "could not start the replace helper: $($_.Exception.Message) - this supervisor keeps running"
    Restore-SupEnv $prev
    return $null
  } finally {
    [Environment]::SetEnvironmentVariable('POKER_SUPERVISOR_REPLACED', $null, 'Process')
  }
}
