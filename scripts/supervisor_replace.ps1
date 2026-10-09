# Starts a FRESH supervisor after the old one asked to be replaced (scripts\supervisor_lib.ps1 Invoke-SupervisorReplace,
# 2026-10-10). Run detached by the old supervisor, which exits 0 right after starting this; never run by hand on the
# live stack (use -DryRun to see what it would do).
#
#   1. wait for the old supervisor (-OldPid) and its headless console (-OldConsolePid) to be gone - a scheduled task
#      with MultipleInstances IgnoreNew refuses a new instance while either lives;
#   2. Start-ScheduledTask "<its task>" and wait for a new start stamp (data\jobs\supervisor-<name>.json with another
#      pid that is alive);
#   3. if the task is missing, or did not bring one up (refused: LastTaskResult 0x800710E0 - an ORPHANED HEADLESS
#      CONHOST left by an earlier Stop-Process keeps the task "Running"): clear any headless conhost whose command line
#      names the supervisor's script and which has NO children (an orphan; a live supervisor's console has its
#      powershell as a child), try the task once more, and last spawn the script directly
#      (conhost --headless powershell -File <script>, the task's own command) - the GTO Wizard windows are never
#      touched: nothing here stops a powershell, a chrome or a GTO Wizard process.
#
# This script's command line never names the supervisor's script (-Name resolves it), so the new supervisor's "another
# supervisor is already running" guard does not mistake this helper for a rival. Every line goes to the supervisor's
# own log with a [replace] prefix.
param(
  [Parameter(Mandatory)][ValidateSet('api', 'charts', 'gtow')][string]$Name,
  [int]$OldPid = 0,
  [int]$OldConsolePid = 0,
  [string]$TaskName = '',
  [string]$LogFile = '',
  [string]$JobsDir = '',
  [string]$RelaunchArgsB64 = '',
  [int]$WaitSec = 60,
  [int]$StampWaitSec = 60,
  [switch]$DryRun
)
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$rel = @{ api = '.claude\study-api.ps1'; charts = '.claude\chart-server.ps1'; gtow = 'scripts\gtow_watchdog.ps1' }[$Name]
$supScript = Join-Path $root $rel
$leaf = Split-Path $supScript -Leaf
if (-not $JobsDir) { $JobsDir = Join-Path $root 'gto-trainer\apps\api\data\jobs' }
if (-not $LogFile) { $LogFile = Join-Path $JobsDir "supervisor-replace-$Name.log" }
$extra = if ($RelaunchArgsB64) { ' ' + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RelaunchArgsB64)).Trim() } else { '' }
$stampFile = Join-Path $JobsDir "supervisor-$Name.json"
$dry = if ($DryRun) { ' [DRY RUN]' } else { '' }

function Say([string]$m) { try { Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] [replace] $m$dry" } catch { } }
function Alive([int]$id) { return $id -gt 0 -and [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }

# a supervisor of this script that is up now: the start stamp names a live pid other than the old one
function New-Supervisor {
  try { $j = Get-Content -LiteralPath $stampFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return $null }
  if ($j.pid -and [int]$j.pid -ne $OldPid -and (Alive ([int]$j.pid))) { return [int]$j.pid }
  return $null
}
function Wait-NewSupervisor([int]$sec) {
  for ($i = 0; $i -lt $sec; $i++) { $n = New-Supervisor; if ($n) { return $n }; Start-Sleep -Seconds 1 }
  return $null
}
# headless consoles of THIS checkout's script (its full path: the chart factory runs a study-api.ps1 of its own) with
# no children: what an earlier Stop-Process left behind
function Get-OrphanConsoles {
  @(Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and $_.CommandLine -like '*--headless*' -and $_.CommandLine -like "*$supScript*" -and
      -not @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($_.ProcessId)" -ErrorAction SilentlyContinue).Count })
}
# another powershell already running THIS checkout's script (someone started the task meanwhile) - by full path, as
# the supervisors' own guard does: a leaf-name match took the factory's study-api.ps1 for this one (sandbox run)
function Get-RunningSupervisor {
  @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $PID -and $_.ProcessId -ne $OldPid -and $_.CommandLine -like "*$supScript*" })
}
function Start-Task {
  if ($DryRun) { Say "would Start-ScheduledTask '$TaskName'"; return }
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Say "Start-ScheduledTask '$TaskName'" }
  catch { Say "Start-ScheduledTask '$TaskName' failed: $($_.Exception.Message -replace '\s+', ' ')" }
}
function Task-Line {
  try { $i = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop; $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        return "state $($t.State), LastTaskResult 0x$('{0:X8}' -f [uint32]$i.LastTaskResult)" } catch { return 'no task info' }
}

Say "helper (pid $PID) for $Name ($leaf$extra): waiting for the old supervisor pid $OldPid$(if ($OldConsolePid) { " and its console pid $OldConsolePid" }) to exit"
# 1. the old one goes first
if ($DryRun) {
  Say "would wait up to $WaitSec s for pid $OldPid ($(if (Alive $OldPid) { 'alive now' } else { 'gone' }))$(if ($OldConsolePid) { " and console $OldConsolePid ($(if (Alive $OldConsolePid) { 'alive now' } else { 'gone' }))" })"
} else {
  for ($i = 0; $i -lt $WaitSec -and ((Alive $OldPid) -or (Alive $OldConsolePid)); $i++) { Start-Sleep -Seconds 1 }
  if (Alive $OldPid) { Say "the old supervisor (pid $OldPid) is still running after $WaitSec s - not starting another (its guard would refuse it anyway)"; exit 1 }
  if (Alive $OldConsolePid) { Say "the old supervisor's console (pid $OldConsolePid) is still there after $WaitSec s - the task may refuse; going on" }
}

$task = if ($TaskName) { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } else { $null }
# 2. the scheduled task (keeps "Running" meaning what it says)
if ($task) {
  Start-Task
  if (-not $DryRun) {
    $n = Wait-NewSupervisor $StampWaitSec
    if ($n) { Say "new supervisor up (pid $n) via the task - done"; exit 0 }
    Say "the task brought no new supervisor in $StampWaitSec s ($(Task-Line))"
  }
} else {
  Say "no scheduled task '$TaskName' - the supervisor is started directly"
}

# 3. orphaned consoles, the task once more, then the script itself
$orphans = Get-OrphanConsoles
foreach ($o in $orphans) {
  if ($DryRun) { Say "would stop orphaned headless console pid $($o.ProcessId) (no children): $($o.CommandLine)"; continue }
  Say "stopping orphaned headless console pid $($o.ProcessId) (no children) - it keeps the task 'Running'"
  Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($DryRun) {
  Say "orphaned headless consoles of $leaf now: $($orphans.Count)"
  Say "would spawn if the task brings nothing: conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supScript`"$extra"
  exit 0
}
if ($task -and $orphans.Count) {
  Start-Sleep -Seconds 2
  Start-Task
  $n = Wait-NewSupervisor $StampWaitSec
  if ($n) { Say "new supervisor up (pid $n) via the task after clearing the orphaned console - done"; exit 0 }
}
$running = Get-RunningSupervisor
if ($running.Count) {
  Say "a supervisor of $leaf is already running (pid $($running.ProcessId -join ', ')) - leaving it"
  $n = Wait-NewSupervisor 30
  if ($n) { Say "its stamp is up (pid $n) - done" } else { Say "it wrote no stamp in 30 s - look at it" }
  exit 0
}
$psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$cmd = "--headless $psExe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supScript`"$extra"
try {
  $p = Start-Process -FilePath "$env:SystemRoot\System32\conhost.exe" -ArgumentList $cmd -WindowStyle Hidden -PassThru
  Say "spawned the supervisor directly (console pid $($p.Id)): $leaf$extra"
} catch { Say "could not spawn $leaf : $($_.Exception.Message)"; exit 1 }
$n = Wait-NewSupervisor $StampWaitSec
if ($n) { Say "new supervisor up (pid $n), started directly - done (the task reads '$((Task-Line))')"; exit 0 }
Say "NO NEW SUPERVISOR after $StampWaitSec s - start it by hand: Start-ScheduledTask '$TaskName' (CLAUDE.md, 'What is live'); the old one's log is $LogFile"
exit 1
