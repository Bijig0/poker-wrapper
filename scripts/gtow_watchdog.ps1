# GTO Wizard watchdog: keep EVERY session drivable, permanently.
#
# The failure it exists for, observed six times in one week: GTO Wizard's
# updater relaunches the app WITHOUT --remote-debugging-port, silently dropping
# CDP. Every "GTOW died" and every "No access token" batch failure was this.
# The updater also parks a modal update dialog that blocks the app from loading
# until dismissed. Nothing else auto-starts these clients, so before this ran as
# a scheduled task a reboot left GTO Wizard AI dead until someone noticed.
#
# TWO SESSIONS (services/gtowSessions.ts):
#   primary   - Ultra, app.gtowizard.com in a dedicated Chrome profile, CDP 9222.
#               The only plan whose AI solves multiway trees.
#   secondary - Elite, the "Secondary GTO Wizard" desktop build, CDP 9223.
#               Heads-up AI only, but a separate daily allowance — so it takes
#               every heads-up solve and spares the primary's quota.
# They are watched independently: one being down must never restart the other.
#
# THE RULE THAT MATTERS: a client sitting on its ACTIVATION or LOGIN screen is
# waiting for a human, and restarting it cannot help — it would just throw away
# whatever is half-typed, every 60 seconds, forever. Those are reported and left
# alone. Only a client that is unreachable, or reachable with no app page and no
# human gate, gets restarted.
#
# Run headless:  powershell -WindowStyle Hidden -File gtow_watchdog.ps1
# Install as a logon task: scripts/install_gtow_watchdog.ps1
# Stop:          kill the PID it prints (or stored by the caller).

param(
    # Watch only these (default: both). e.g. -Only primary
    [string[]]$Only
)

$ErrorActionPreference = 'Continue'

# The scheduled task runs this HEADLESS (conhost --headless), so Write-Output
# goes nowhere. Everything it says is therefore also appended to a log, next to
# the StudyAPI supervisor's, which is the only way to answer "why did GTO
# Wizard go away at 4am" after the fact.
$logFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'gto-trainer\apps\api\data\jobs\gtow_watchdog.log'
try { $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) -ErrorAction SilentlyContinue } catch {}
function Say([string]$m) {
    Write-Output $m
    try { Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] $m" -ErrorAction SilentlyContinue } catch {}
}

# ONE WATCHDOG. Stop-ScheduledTask does not reliably end a running instance
# (three study-api.ps1 supervisors were found alive on 2026-09-14 for exactly
# this reason), and two of these would fight each other: both would see the
# same client mid-restart as "not drivable" and kill it again.
#
# A NAMED MUTEX, not a command-line scan. The obvious guard — look for another
# powershell whose CommandLine mentions "gtow_watchdog" — also matches any
# ad-hoc `Get-CimInstance ... -match 'gtow_watchdog'` someone runs to CHECK on
# the watchdog, because that query's own command line contains the string. The
# watchdog then saw the person looking at it as a rival and exited, silently,
# with code 0 (caught 2026-09-21: the task reported success and nothing ran).
$mutex = New-Object System.Threading.Mutex($false, 'Global\PokerGtowWatchdog')
try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
if (-not $held) {
    Say 'gtow watchdog already running - exiting'
    exit 0
}

function Get-Targets([int]$port) {
    try { return (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json/list" -TimeoutSec 5).Content | ConvertFrom-Json }
    catch { return $null }
}
# Only PAGE targets count. A CDP target list also carries service workers, and
# https://app.gtowizard.com/service-worker.js matches the hostname while being
# no evidence at all that a usable page is loaded — it made a client sitting on
# /login read as drivable (caught live 2026-09-21).
# The human gates: the activation-code screen and GTO Wizard's own sign-in page.
$HUMAN_GATE = 'activate\.html|/login|/auth|/signin'

# Drivable = a SIGNED-IN app.gtowizard page is loaded. That page's authenticated
# traffic is the only thing the API can sniff a bearer token from.
#
# The exclusion is load-bearing: app.gtowizard.com/login is an app.gtowizard URL
# too, so a bare hostname match calls a client that is sitting at the sign-in
# screen "drivable" and reports it healthy forever, while it holds no token and
# answers nothing (caught live 2026-09-21, right after the activation code was
# entered and the app landed on /login).
function Test-Drivable([int]$port) {
    $t = Get-Targets $port
    if ($null -eq $t) { return $false }
    return @($t | Where-Object { $_.type -eq 'page' -and $_.url -match 'app\.gtowizard' -and $_.url -notmatch $HUMAN_GATE }).Count -gt 0
}
# Alive but parked on a human gate (activation code, sign-in).
function Test-NeedsHuman([int]$port) {
    $t = Get-Targets $port
    if ($null -eq $t) { return $false }
    return @($t | Where-Object { $_.type -eq 'page' -and $_.url -match $HUMAN_GATE }).Count -gt 0
}

$scriptDir = $PSScriptRoot

# ---- primary: an Electron build if one is installed, else the Chrome profile --
# $env:GTOW_CLIENT_PATH pins a build. Match on the FULL PATH: Windows names a
# process after its exe, so two installs called "GTO Wizard.exe" are
# indistinguishable by name and this loop KILLS what it matches.
$primaryExe = $env:GTOW_CLIENT_PATH
if (-not $primaryExe) {
    foreach ($c in @('C:\Program Files\GTO Wizard\GTO Wizard.exe',
                     'C:\Program Files\Chinese GTO Wizard\Chinese GTO Wizard.exe')) {
        if (Test-Path -LiteralPath $c) { $primaryExe = $c; break }
    }
}
$primaryPort = if ($env:GTOW_CDP_PORT) { [int]$env:GTOW_CDP_PORT } else { 9222 }
$chromeProfile = if ($env:GTOW_CHROME_PROFILE) { $env:GTOW_CHROME_PROFILE } else { "$env:LOCALAPPDATA\gtow-cdp-profile" }

if ($primaryExe) {
    $primaryName = [IO.Path]::GetFileNameWithoutExtension($primaryExe)
    $primaryProcs = { Get-Process -Name $primaryName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $primaryExe } }.GetNewClosure()
    # Kill first: the whole point is that the running instance lost its debug
    # port, and Windows will not apply new args to a live process. The two
    # script-backed starts below do their own killing (-Force), so only this
    # branch needs it here.
    $primaryStart = {
        Get-Process -Name $primaryName -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $primaryExe } |
            Stop-Process -Force -Confirm:$false -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        Start-Process -FilePath $primaryExe -ArgumentList "--remote-debugging-port=$primaryPort" -WindowStyle Minimized
    }.GetNewClosure()
    $primaryLabel = $primaryExe
} else {
    # NEVER match chrome.exe by name: that is Brady's entire browser, and this
    # loop kills what it matches. The dedicated --user-data-dir is the only safe
    # discriminator (verified: 2 of 31 chrome processes matched, 29 spared).
    $primaryProcs = {
        Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like "*--user-data-dir=$chromeProfile*" } |
            ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    }.GetNewClosure()
    $primaryStart = { & (Join-Path $scriptDir 'start_gtow_chrome.ps1') -Force | Out-Null }.GetNewClosure()
    $primaryLabel = "chrome dedicated profile ($chromeProfile)"
}

# ---- secondary: the Elite desktop build on its own port --------------------
$secondaryExe = $env:GTOW_SECONDARY_PATH
if (-not $secondaryExe) {
    foreach ($c in @("$env:USERPROFILE\Secondary GTO Wizard\Secondary GTO Wizard.exe",
                     'C:\Program Files\Secondary GTO Wizard\Secondary GTO Wizard.exe')) {
        if (Test-Path -LiteralPath $c) { $secondaryExe = $c; break }
    }
}
$secondaryPort = if ($env:GTOW_SECONDARY_CDP_PORT) { [int]$env:GTOW_SECONDARY_CDP_PORT } else { 9223 }

$sessions = @()
$sessions += [pscustomobject]@{
    Id = 'primary'; Label = $primaryLabel; Port = $primaryPort
    Procs = $primaryProcs; Start = $primaryStart; Miss = 0; Human = $false
}
if ($secondaryExe) {
    $secName = [IO.Path]::GetFileNameWithoutExtension($secondaryExe)
    $sessions += [pscustomobject]@{
        Id = 'secondary'; Label = $secondaryExe; Port = $secondaryPort
        Procs = { Get-Process -Name $secName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $secondaryExe } }.GetNewClosure()
        Start = { & (Join-Path $scriptDir 'start_gtow_secondary.ps1') -Force | Out-Null }.GetNewClosure()
        Miss = 0; Human = $false
    }
} else {
    Say "no Secondary GTO Wizard installed - watching the primary only"
}

if ($Only) { $sessions = $sessions | Where-Object { $Only -contains $_.Id } }

Say "gtow watchdog up (pid $PID) - watching: $(($sessions | ForEach-Object { "$($_.Id)@$($_.Port)" }) -join ', ')"
foreach ($s in $sessions) { Say "  $($s.Id): $($s.Label)" }

# Startup is SLOW: after an update the app sits on activate.html and cycles
# renderers for ~4 minutes before app.gtowizard appears. The original 90s grace
# killed it mid-startup every time - a permanent kill-loop that cost an
# overnight audit run (2026-08-27). Grace is 8 minutes, and two consecutive
# failed probes are required before killing anything, so a single slow or flaky
# poll never triggers a restart.
while ($true) {
    foreach ($s in $sessions) {
        $stamp = Get-Date -Format HH:mm:ss
        if (Test-Drivable $s.Port) {
            if ($s.Miss -gt 0 -or $s.Human) { Say "$stamp [$($s.Id)] back" }
            $s.Miss = 0; $s.Human = $false
            continue
        }
        if (Test-NeedsHuman $s.Port) {
            # A human gate is not a fault to restart out of. Say it once, then
            # stay quiet until it changes.
            if (-not $s.Human) { Say "$stamp [$($s.Id)] waiting for a human - activation code or sign-in in its window. NOT restarting." }
            $s.Human = $true; $s.Miss = 0
            continue
        }
        $s.Human = $false
        $s.Miss++
        if ($s.Miss -lt 2) { Say "$stamp [$($s.Id)] probe failed (1/2) - waiting"; continue }

        Say "$stamp [$($s.Id)] not drivable - restarting with CDP flag"
        & $s.Start
        for ($i = 0; $i -lt 96; $i++) {          # up to 8 minutes
            Start-Sleep -Seconds 5
            $dlg = & $s.Procs | Where-Object { $_.MainWindowTitle -match '更新|update' }
            if ($dlg) { $null = $dlg.CloseMainWindow() }
            if (Test-Drivable $s.Port) { Say "$(Get-Date -Format HH:mm:ss) [$($s.Id)] back after $($i * 5)s"; break }
            if (Test-NeedsHuman $s.Port) {
                Say "$(Get-Date -Format HH:mm:ss) [$($s.Id)] came up on its activation/login screen - needs a human"
                $s.Human = $true
                break
            }
        }
        $s.Miss = 0
    }
    Start-Sleep -Seconds 60
}
