# StudyAPI supervisor (scheduled task "StudyAPI", at logon): keeps the study dashboard API on :2000 alive.
#   - runs `bun index.ts` (NO --watch: a --watch worker crash leaves the watcher alive and hides the failure)
#   - restarts it 10 s after it exits
#   - HANG WATCHDOG (2026-09-12): a worker that is alive and LISTENING but never answers (event loop wedged - seen
#     for 30+ min while every request timed out; the plain restart loop cannot see that) is killed after three
#     failed GET / probes 30 s apart, then relaunched. Detached relays/steps the worker started are not in its
#     process tree (ShellExecute launches), so they survive the kill and re-attach to the boxes' runs.
$root = 'C:\Users\Brady\poker\gto-trainer\apps\api'
$sup = Join-Path $root 'data\jobs\supervisor.log'
# the scheduled task's PATH has no bun (the npm shim lives in Roaming\npm): use the binary the orchestrator uses
$bun = 'C:\Users\Brady\AppData\Local\Programs\node-v24.18.0-win-x64\node_modules\bun\bin\bun.exe'
function Log($m) { Add-Content -Path $sup -Value "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] $m" }

Log "supervisor started (pid $PID)"
while ($true) {
  $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/c', "`"cd /d $root && `"$bun`" index.ts >> data\jobs\api.log 2>&1`"" -WindowStyle Hidden -PassThru
  Log "worker tree started (cmd pid $($p.Id))"
  Start-Sleep -Seconds 30
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
  Log "worker gone (exit $(if ($p.HasExited) { $p.ExitCode } else { 'killed' })) - restart in 10 s"
  Start-Sleep -Seconds 10
}
