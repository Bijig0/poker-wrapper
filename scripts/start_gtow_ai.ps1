# Start the GTO Wizard AI solve chain on the Zenbook:
#   1. GTO Wizard desktop client with CDP on 9222 (the API sniffs its auth token)
#   2. gto-trainer API on port 2000 (Bun/Hono; serves the analysis app's
#      "GTO Wizard · AI custom solve" source and /api/ai-solve)
# Safe to re-run: skips anything already up; restarts GTOW if it is running
# without the debug port.

$cdpUp = $false
try { $null = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9222/json/version' -TimeoutSec 2; $cdpUp = $true } catch {}
if ($cdpUp) {
    Write-Host 'GTO Wizard CDP already up on 9222'
} else {
    $procs = Get-Process 'GTO Wizard' -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host 'GTO Wizard running without debug port - restarting it...'
        $procs | ForEach-Object { $null = $_.CloseMainWindow() }
        Start-Sleep -Seconds 3
        Get-Process 'GTO Wizard' -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
        Start-Sleep -Seconds 1
    }
    Start-Process -FilePath 'C:\Program Files\GTO Wizard\GTO Wizard.exe' -ArgumentList '--remote-debugging-port=9222' -WindowStyle Minimized
    Write-Host 'started GTO Wizard with CDP on 9222'
    # Electron ignores the minimized-start hint — minimize explicitly once the
    # window exists. The solver is a background service; stay out of the way.
    Add-Type -Namespace U -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        $w = Get-Process 'GTO Wizard' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
        if ($w) { $w | ForEach-Object { $null = [U.W]::ShowWindow($_.MainWindowHandle, 6) }; break }
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
    $exploit = "$PSScriptRoot\..\analysis\pipeline\limp_study\exploit_ranges.json"
    if (Test-Path $exploit) { $env:EXPLOIT_CHART = (Resolve-Path $exploit).Path }
    Start-Process -WorkingDirectory "$PSScriptRoot\..\gto-trainer\apps\api" -FilePath 'bun.cmd' -ArgumentList 'run', 'index.ts' -WindowStyle Minimized
    Write-Host "started gto-trainer API on 2000 (exploit overlay: $(if ($env:EXPLOIT_CHART) {'ARMED'} else {'off'}))"
}
