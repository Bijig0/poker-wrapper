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
    $env:Path = "$env:APPDATA\npm;$env:LOCALAPPDATA\Programs\node-v24.18.0-win-x64;$env:Path"
    # Pool-exploit overlay: the constrained preflop best-response vs the
    # measured pool (MES +5.2 bb/100 @ NL25 rake, +8.9 @ NL200 vs -7.2/-4.8
    # for the equilibrium mix). The five modeled first-decision shapes answer
    # with the exploit, labeled "pool-exploit-preflop"; everything deeper
    # falls back to the equilibrium chart. Comment out to run pure GTO.
    # NL25 cutover 2026-09-14 (ledger cutover-nl25): the _nl25 exports are fit to
    # ign25_3maxasym2ci (5% / cap 4bb, the rake we actually play). The old
    # exploit_ranges.json / pool_model_v4.json are the NL200-rake generation —
    # 12-28% of hand classes per node differ.
    $exploit = "$PSScriptRoot\..\analysis\pipeline\limp_study\exploit_ranges_nl25.json"
    if (Test-Path $exploit) { $env:EXPLOIT_CHART = (Resolve-Path $exploit).Path }
    $pool = "$PSScriptRoot\..\analysis\pipeline\limp_study\pool_model_nl25.json"
    if (Test-Path $pool) { $env:POOL_MODEL = (Resolve-Path $pool).Path }
    Start-Process -WorkingDirectory "$PSScriptRoot\..\gto-trainer\apps\api" -FilePath 'bun.cmd' -ArgumentList 'run', 'index.ts' -WindowStyle Minimized
    Write-Host "started gto-trainer API on 2000 (exploit overlay: $(if ($env:EXPLOIT_CHART) {'ARMED'} else {'off'}))"
}
