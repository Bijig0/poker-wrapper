# Start the GTO Wizard AI solve chain on the Zenbook:
#   1. GTO Wizard (app.gtowizard.com) in a dedicated Chrome profile with CDP on 9222 (the API sniffs its auth token)
#   2. gto-trainer API on port 2000 (Bun/Hono; serves the analysis app's
#      "GTO Wizard · AI custom solve" source and /api/ai-solve)
# Safe to re-run: skips anything already up; restarts the Chrome profile if it is running without the debug port.
# (The GTO Wizard desktop app was dropped 2026-10-13: Chrome is the only client - see scripts/start_gtow_chrome.ps1.)

$cdpUp = $false
try { $null = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9222/json/version' -TimeoutSec 2; $cdpUp = $true } catch {}
if ($cdpUp) {
    Write-Host 'GTO Wizard CDP already up on 9222'
} else {
    & (Join-Path $PSScriptRoot 'start_gtow_chrome.ps1') -Force
}

$apiUp = $false
try { $null = Invoke-WebRequest -UseBasicParsing 'http://localhost:2000/' -TimeoutSec 2; $apiUp = $true } catch {}
if ($apiUp) {
    Write-Host 'gto-trainer API already up on 2000'
} else {
    # THE SAME ENVIRONMENT AS EVERY OTHER API START (2026-09-25 audit): config\env.ps1 resolves bun, the NL25 pool-exploit
    # overlay (EXPLOIT_CHART / POOL_MODEL), POKER_DATA_DIR and everything in config\local.env (TRUST_GUARD_ALL,
    # GTOW_POLL_MS …). This script used to hard-code node-v24.18.0, set the overlay itself and skip local.env, so an
    # API started here answered differently from the one the StudyAPI task starts.
    . "$PSScriptRoot\..\config\env.ps1"
    Start-Process -WorkingDirectory "$PSScriptRoot\..\gto-trainer\apps\api" -FilePath $env:BUN -ArgumentList 'run', 'index.ts' -WindowStyle Minimized
    Write-Host "started gto-trainer API on 2000 (exploit overlay: $(if ($env:EXPLOIT_CHART) {'ARMED'} else {'off'}))"
}
