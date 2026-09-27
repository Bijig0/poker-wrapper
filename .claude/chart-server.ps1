# ChartServer supervisor (scheduled task "PokerWrapper Charts - <user>", at logon): keeps the chart server on :8777 alive.
#
# Until 2026-09-22 this was the one piece of the live chain nothing restarted: it was started by hand and a crash or a
# reboot quietly took every 3-handed chart answer (and the CoinPoker heads-up strategy) with it until someone noticed.
# Same shape as .claude\study-api.ps1:
#   - one supervisor only (a second exits)
#   - runs the TypeScript chart server (gto-trainer\apps\api\src\charts\chartServer.ts) with config\env.ps1's Bun
#   - restarts 10 s after an exit; a server that is alive but stops answering for 3 probes is killed and restarted
#   - backs off when boots keep failing, and writes WHY (the server log's tail) into its own log
. (Join-Path $PSScriptRoot '..\config\env.ps1')
# NORMAL PRIORITY (2026-09-26): a scheduled task starts at BelowNormal (Task Scheduler's default priority 7) and every
# child inherits it, so on a busy machine this live-answer service lost the CPU to everything else (the study API's
# 0.2 s reads took 3-4 s, its event loop stalled for seconds with nothing heavy running). Raise this supervisor to
# Normal before it starts anything; its children inherit that.
try { (Get-Process -Id $PID).PriorityClass = 'Normal' } catch { }
$logDir = Join-Path $env:POKER_ROOT 'gto-trainer\apps\api\data\jobs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$sup = Join-Path $logDir 'chart-server-supervisor.log'
$out = Join-Path $logDir 'chart-server.log'
$port = if ($env:HRC_UI_PORT) { [int]$env:HRC_UI_PORT } else { 8777 }
function Log($m) { Add-Content -Path $sup -Value "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] $m" }

$others = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'chart-server\.ps1' })
if ($others.Count) { Log "another supervisor is already running (pid $($others.ProcessId -join ', ')) - this one (pid $PID) exits"; exit 0 }
$server = Join-Path $env:POKER_ROOT 'gto-trainer\apps\api\src\charts\chartServer.ts'
if (-not ($env:BUN -and (Test-Path $server))) { Log "no Bun (config\env.ps1) or no $server - cannot start the chart server"; exit 1 }
Log "supervisor started (pid $PID) - $env:BUN, cache $env:HRC_UI_DOC_CACHE_MAX trees, port $port"
$fastFails = 0
while ($true) {
  # a server already on the port (started by hand) is left alone: watch it instead of fighting it
  $startedAt = Get-Date   # lifetime counts from launch, so a crash during boot reads as a boot failure
  $holder = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($holder) {
    $p = Get-Process -Id $holder.OwningProcess -ErrorAction SilentlyContinue
    Log "port $port already served by $($p.Name)#$($p.Id) - watching it"
  } else {
    $run = "`"`"$env:BUN`" `"$server`" >> `"$out`" 2>&1`""
    $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -WindowStyle Hidden -PassThru -ArgumentList '/c', $run
    Log "server started (cmd pid $($p.Id))"
    for ($i = 0; $i -lt 20 -and -not $p.HasExited; $i++) { Start-Sleep -Seconds 1 }
  }
  $fails = 0
  while ($p -and -not $p.HasExited) {
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/solutions" -UseBasicParsing -TimeoutSec 20
      if ($fails -gt 0) { Log "probe ok again after $fails failure(s)" }
      $fails = 0
    } catch {
      $fails++
      Log "probe failed ($fails/3): $($_.Exception.Message -replace '\s+', ' ')"
    }
    if ($fails -ge 3) {
      Log "server hung (3 probes) - killing pid $($p.Id) and its tree"
      & taskkill /PID $p.Id /T /F | Out-Null
      break
    }
    Start-Sleep -Seconds 30
  }
  $lived = [int]((Get-Date) - $startedAt).TotalSeconds
  Log "server gone after $lived s"
  if ($lived -lt 15) { $fastFails++ } else { $fastFails = 0 }
  $wait = 10
  if ($fastFails -ge 3) {
    $wait = [Math]::Min(300, 20 * ($fastFails - 2))
    $tail = ((Get-Content $out -Tail 200 -ErrorAction SilentlyContinue) | Where-Object { $_.Trim() } | Select-Object -Last 5) -join ' | '
    Log "BOOT FAILING: $fastFails in a row died inside 15 s - next try in $wait s. log tail: $tail"
  }
  Start-Sleep -Seconds $wait
}
