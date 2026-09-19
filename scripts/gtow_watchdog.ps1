# GTO Wizard watchdog: keep the client drivable, permanently.
#
# The failure it exists for, observed six times in one week: GTO Wizard's
# updater relaunches the app WITHOUT --remote-debugging-port, silently
# dropping CDP. Every "GTOW died" and every "No access token" batch failure
# was this. The updater also parks a modal update dialog that blocks the app
# from loading until dismissed.
#
# Loop: every 60s, if 9222 has no app.gtowizard page target, kill whatever
# GTO Wizard is running, relaunch it with the flag, and dismiss the update
# dialog while waiting for the app page to appear.
#
# Run headless:  powershell -WindowStyle Hidden -File gtow_watchdog.ps1
# Stop:          kill the PID it prints (or stored by the caller).

function Test-Gtow {
    try {
        $t = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9222/json/list' -TimeoutSec 5).Content | ConvertFrom-Json
        return @($t | Where-Object { $_.url -match 'app\.gtowizard' }).Count -gt 0
    } catch { return $false }
}

# Which client to watch. The Chinese regional build was renamed (folder AND exe)
# to "Chinese GTO Wizard" on 2026-09-18: Windows names a process after its exe,
# so with both builds installed a name-only Get-Process would kill either one.
# Match on the full path instead. $env:GTOW_CLIENT_PATH pins a build.
$gtowExe = $env:GTOW_CLIENT_PATH
if (-not $gtowExe) {
    foreach ($c in @('C:\Program Files\GTO Wizard\GTO Wizard.exe',
                     'C:\Program Files\Chinese GTO Wizard\Chinese GTO Wizard.exe')) {
        if (Test-Path -LiteralPath $c) { $gtowExe = $c; break }
    }
}
# No desktop build? GTO Wizard ships none of their own (their official "install
# on PC" is a PWA), so watch app.gtowizard.com in a dedicated Chrome profile.
$useChrome = -not $gtowExe
if ($useChrome) {
    $chromeProfile = if ($env:GTOW_CHROME_PROFILE) { $env:GTOW_CHROME_PROFILE } else { "$env:LOCALAPPDATA\gtow-cdp-profile" }
    # NEVER match chrome.exe by name: that is the user's entire browser, and
    # this loop KILLS what it matches. The dedicated --user-data-dir is the
    # only safe discriminator.
    function Get-GtowProcs {
        Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like "*--user-data-dir=$chromeProfile*" } |
            ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    }
    $clientLabel = "chrome dedicated profile ($chromeProfile)"
} else {
    $gtowName = [IO.Path]::GetFileNameWithoutExtension($gtowExe)
    function Get-GtowProcs { Get-Process -Name $gtowName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $gtowExe } }
    $clientLabel = $gtowExe
}

Write-Output "gtow watchdog up (pid $PID) - client: $clientLabel"
# Startup is SLOW: after an update the app sits on activate.html and cycles
# renderers for ~4 minutes before app.gtowizard appears. The original 90s
# grace period killed it mid-startup every time — a permanent kill-loop that
# cost an overnight audit run (2026-08-27). Grace is now 8 minutes, and two
# consecutive failed probes are required before killing anything, so a single
# slow/flaky poll never triggers a restart.
$miss = 0
while ($true) {
    if (Test-Gtow) {
        $miss = 0
    } else {
        $miss++
        if ($miss -lt 2) {
            Write-Output "$(Get-Date -Format HH:mm:ss) GTOW probe failed (1/2) - waiting"
        } else {
            Write-Output "$(Get-Date -Format HH:mm:ss) GTOW not drivable - restarting with CDP flag"
            Get-GtowProcs | Stop-Process -Force -Confirm:$false -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
            if ($useChrome) {
                & (Join-Path $PSScriptRoot 'start_gtow_chrome.ps1') -Force | Out-Null
            } else {
                Start-Process -FilePath $gtowExe -ArgumentList '--remote-debugging-port=9222' -WindowStyle Minimized
            }
            for ($i = 0; $i -lt 96; $i++) {          # up to 8 minutes
                Start-Sleep -Seconds 5
                $dlg = Get-GtowProcs | Where-Object { $_.MainWindowTitle -match '更新|update' }
                if ($dlg) { $null = $dlg.CloseMainWindow() }
                if (Test-Gtow) { Write-Output "$(Get-Date -Format HH:mm:ss) GTOW back after $($i * 5)s"; break }
            }
            $miss = 0
        }
    }
    Start-Sleep -Seconds 60
}
