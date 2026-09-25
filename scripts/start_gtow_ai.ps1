# Start the GTO Wizard AI solve chain on the Zenbook:
#   1. GTO Wizard desktop client with CDP on 9222 (the API sniffs its auth token)
#   2. gto-trainer API on port 2000 (Bun/Hono; serves the analysis app's
#      "GTO Wizard · AI custom solve" source and /api/ai-solve)
# Safe to re-run: skips anything already up; restarts GTOW if it is running
# without the debug port.

# Which client to drive. The Chinese regional build was renamed (folder AND exe)
# to "Chinese GTO Wizard" on 2026-09-18, because Windows names a process after
# its exe — two installs called "GTO Wizard.exe" are indistinguishable to
# Get-Process, so a restart here would quit whichever one happened to be open.
# $env:GTOW_CLIENT_PATH pins a build; otherwise the international one wins.
$gtowExe = $env:GTOW_CLIENT_PATH
if (-not $gtowExe) {
    foreach ($c in @('C:\Program Files\GTO Wizard\GTO Wizard.exe',
                     'C:\Program Files\Chinese GTO Wizard\Chinese GTO Wizard.exe')) {
        if (Test-Path -LiteralPath $c) { $gtowExe = $c; break }
    }
}
# No desktop build installed? GTO Wizard ships none of their own (their official
# "install on PC" is a PWA), so fall back to app.gtowizard.com in a dedicated
# Chrome profile — see scripts/start_gtow_chrome.ps1.
$useChrome = -not $gtowExe
if ($useChrome) {
    Write-Host 'client: no desktop build - using the dedicated-profile Chrome fallback'
} else {
    $gtowName = [IO.Path]::GetFileNameWithoutExtension($gtowExe)
    function Get-GtowProcs { Get-Process -Name $gtowName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $gtowExe } }
    Write-Host "client: $gtowExe"
}

$cdpUp = $false
try { $null = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9222/json/version' -TimeoutSec 2; $cdpUp = $true } catch {}
if ($cdpUp) {
    Write-Host 'GTO Wizard CDP already up on 9222'
} else {
  if ($useChrome) {
    & (Join-Path $PSScriptRoot 'start_gtow_chrome.ps1') -Force
  } else {
    $procs = Get-GtowProcs
    if ($procs) {
        Write-Host 'GTO Wizard running without debug port - restarting it...'
        $procs | ForEach-Object { $null = $_.CloseMainWindow() }
        Start-Sleep -Seconds 3
        Get-GtowProcs | Stop-Process -Force -Confirm:$false
        Start-Sleep -Seconds 1
    }
    Start-Process -FilePath $gtowExe -ArgumentList '--remote-debugging-port=9222' -WindowStyle Minimized
    Write-Host 'started GTO Wizard with CDP on 9222'
    # Electron ignores the minimized-start hint — minimize explicitly once the
    # window exists. The solver is a background service; stay out of the way.
    Add-Type -Namespace U -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        $w = Get-GtowProcs | Where-Object { $_.MainWindowHandle -ne 0 }
        if ($w) { $w | ForEach-Object { $null = [U.W]::ShowWindow($_.MainWindowHandle, 6) }; break }
    }
  }
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
