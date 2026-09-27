# Study API supervisor (scheduled task "PokerWrapper API - <user>", at logon): keeps the study API + dashboard on :2000 alive.
#   - runs `bun index.ts` (NO --watch: a --watch worker crash leaves the watcher alive and hides the failure)
#   - restarts it 10 s after it exits
#   - HANG WATCHDOG (2026-09-12): a worker that is alive and LISTENING but never answers (event loop wedged - seen
#     for 30+ min while every request timed out; the plain restart loop cannot see that) is killed after three
#     failed GET / probes 30 s apart, then relaunched.
# WHERE EVERYTHING IS comes from config\env.ps1 (2026-09-22): the root from this script's own location, Bun / Node /
# Git auto-detected (or pinned in config\local.env), and a PATH with all of them on it. The scheduled task's PATH has
# no bun (the npm shim lives in Roaming\npm), and the worker's children (rclone, git) resolve their tools from the
# worker's PATH, so it gets the same PATH an interactive shell has.
. (Join-Path $PSScriptRoot '..\config\env.ps1')
# NORMAL PRIORITY (2026-09-26): a scheduled task starts at BelowNormal (Task Scheduler's default priority 7) and every
# child inherits it, so on a busy machine this live-answer service lost the CPU to everything else (the study API's
# 0.2 s reads took 3-4 s, its event loop stalled for seconds with nothing heavy running). Raise this supervisor to
# Normal before it starts anything; its children inherit that.
try { (Get-Process -Id $PID).PriorityClass = 'Normal' } catch { }
$root = Join-Path $env:POKER_ROOT 'gto-trainer\apps\api'
$sup = Join-Path $root 'data\jobs\supervisor.log'
$api = Join-Path $root 'data\jobs\api.log'   # the worker's stdout+stderr: where a failed boot says why
$bun = $env:BUN
$env:Path = "$env:Path;" + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
# EXPLOIT_CHART arms the pool-exploit preflop overlay. services/fastSolve.ts reads it
# ONCE per process, so a worker started without it serves the equilibrium chart for
# every preflop answer, services/strategies.ts marks the 25NL Zone Exploit strategy
# `unavailable`, and the wrapper's setup page refuses to start a session in it
# ("Blocked: 3-handed Zone 25NL preflop exploit charts armed"). Nothing errors - the
# exploit layer is just silently gone. Set on every start since 2026-09-14; config\env.ps1
# now supplies it (default gto-trainer\apps\api\data\pool\exploit_ranges_nl25.json).
# NL25 cutover 2026-09-14: the _nl25 exports are fit to ign25_3maxasym2ci (5% / cap 4bb, the rake we actually
# play). The old exploit_ranges.json / pool_model_v4.json are the NL200-rake generation.
# POOL_MODEL names the opponent model the API reports and checks drift against
# (services/strategies.ts, routes/sources.ts) - also from config\env.ps1.
function Log($m) { Add-Content -Path $sup -Value "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] $m" }

# ONE SUPERVISOR (2026-09-14). Found three of these running at once: the logon task's, plus two more
# from later Start-ScheduledTask calls - Stop-ScheduledTask had not actually ended the old instance.
# Harmless while they only restarted a dead worker, but NOT harmless with the straggler sweep below:
# each supervisor would kill whatever was on :2000 before starting its own worker, so they would
# take turns killing each other's and the API would never stay up. Exit rather than join the fight.
$others = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'study-api\.ps1' })
if ($others.Count) {
  Log "another supervisor is already running (pid $($others.ProcessId -join ', ')) - this one (pid $PID) exits"
  exit 0
}

# consecutive workers that died before they could serve anything
$fastFails = 0
# Tells the worker it is supervised, so the dashboard's "restart to pick up the
# update" button knows a clean exit actually comes back here (services/buildStamp.ts).
# A hand-started worker has no such parent and the dashboard offers the command instead.
$env:STUDY_API_SUPERVISOR = $PID
Log "supervisor started (pid $PID) - exploit overlay $(if ($env:EXPLOIT_CHART) { 'ARMED' } else { 'OFF (exploit_ranges_nl25.json missing)' })"
while ($true) {
  # STRAGGLER SWEEP BEFORE EVERY START (2026-09-14). This used to run only in the hang path below,
  # so anything already on :2000 - a worker started by hand, or one this supervisor lost track of -
  # simply kept running alongside the new one. index.ts sets reusePort:true (box runners inherit the
  # listening socket, so a strict bind would fail after a straggler child), which means the second
  # bind succeeds SILENTLY: on 2026-09-13 a hand-started worker and this supervisor's worker both ran
  # for 14 h, each with its own study poller, job dispatcher and box keeper, and their box-keeper
  # cleanups deleted each other's half-written solves. The API's own data\background.lock now stops
  # the second process doing background work, but two workers is still not a state worth keeping:
  # this supervisor owns :2000, so clear it first and start from one process.
  Get-NetTCPConnection -LocalPort 2000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $o = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($o -and $o.Name -eq 'bun') {
      Log "straggler on :2000 before start - killing bun pid $($o.Id) (started $($o.StartTime))"
      # /T so the cmd.exe wrapper and any bun worker child go too, not just the one holding the socket
      & taskkill /PID $o.Id /T /F 2>&1 | Out-Null
    }
  }
  $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/c', "`"cd /d $root && `"$bun`" index.ts >> data\jobs\api.log 2>&1`"" -WindowStyle Hidden -PassThru
  $startedAt = Get-Date
  Log "worker tree started (cmd pid $($p.Id))"
  # Give it 30 s to come up, but NOTICE an early exit instead of sleeping through it: the old blind
  # Start-Sleep 30 made every failed boot look like a 30-second lifetime, so "never started" and
  # "died while working" were indistinguishable in this log (2026-09-14).
  for ($i = 0; $i -lt 30 -and -not $p.HasExited; $i++) { Start-Sleep -Seconds 1 }
  $fails = 0
  while (-not $p.HasExited) {
    try {
      $null = Invoke-WebRequest -Uri 'http://127.0.0.1:2000/' -UseBasicParsing -TimeoutSec 20
      if ($fails -gt 0) { Log "probe ok again after $fails failure(s)" }
      $fails = 0
    } catch {
      $fails++
      Log "probe failed ($fails/3): $($_.Exception.Message -replace '\s+', ' ')"
    }
    if ($fails -ge 3) {
      Log "worker hung (3 probes, 60 s+ without an answer) - killing cmd pid $($p.Id) and its tree"
      & taskkill /PID $p.Id /T /F | Out-Null
      # anything else still holding :2000 (an inherited listener in a straggler) would make the new worker unreachable
      Start-Sleep -Seconds 3
      Get-NetTCPConnection -LocalPort 2000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        $o = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        if ($o -and $o.Name -eq 'bun') { Log "killing straggler bun pid $($o.Id) still listening on :2000"; Stop-Process -Id $o.Id -Force -ErrorAction SilentlyContinue }
      }
      break
    }
    Start-Sleep -Seconds 30
  }
  $lived = [int]((Get-Date) - $startedAt).TotalSeconds
  $code = if ($p.HasExited) { $p.ExitCode } else { 'killed' }
  # WHAT DID IT LEAVE BEHIND (2026-09-14). This log recorded an exit code and nothing else, so 34
  # kills of a HEALTHY worker (exit -1, lifetimes of 1 min to 2 h) could not be told apart from a
  # crash, and nothing recorded who killed it. The straggler sweep above is the prime suspect: a
  # second supervisor clears :2000 before starting its own worker, and the two then take turns
  # killing each other's. Record the port holder and any rival supervisor at the moment of death.
  $holder = ''
  Get-NetTCPConnection -LocalPort 2000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $o = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($o) { $holder += " $($o.Name)#$($o.Id)" }
  }
  if (-not $holder) { $holder = ' nothing' }
  $rivals = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'study-api' -and $_.CommandLine -match '-File' })
  Log "worker gone (exit $code) after $lived s - :2000 held by$holder - rival supervisors: $($rivals.Count)"

  # BOOT-FAILURE BACKOFF (2026-09-14). A worker that never lives 15 s is not failing under load, it
  # is failing to START, and retrying every 10 s can never fix that: one syntax error in a service
  # file failed 46 boots in a row while the reason sat unread in api.log. Slow down, and put the
  # reason in THIS log, which is the one that gets read when the API will not stay up.
  if ($lived -lt 15) { $fastFails++ } else { $fastFails = 0 }
  $wait = 10
  if ($fastFails -ge 3) {
    $wait = [Math]::Min(300, 20 * ($fastFails - 2))
    $tail = ((Get-Content $api -Tail 400 -ErrorAction SilentlyContinue) |
      Where-Object { $_ -notmatch '^(<--|-->)' -and $_.Trim() } | Select-Object -Last 6) -join ' | '
    Log "BOOT FAILING: $fastFails workers in a row died inside 15 s - next try in $wait s. api.log tail: $tail"
  }
  Log "restart in $wait s"
  Start-Sleep -Seconds $wait
}
