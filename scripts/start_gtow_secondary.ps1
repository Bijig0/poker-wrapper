# Secondary GTO Wizard — the Elite account, on its own debug port.
#
# WHY A SECOND SESSION: the primary (Ultra, app.gtowizard.com in a dedicated
# Chrome profile on CDP 9222 — see start_gtow_chrome.ps1) has a daily browsing
# allowance we keep spending. This desktop build holds a SEPARATE account, so
# every heads-up solve it absorbs is one the primary does not pay for. Elite's
# GTO Wizard AI is heads-up only, so the API keeps multiway trees on the
# primary and sends everything else here first (services/gtowSessions.ts).
#
# PORT 9223, NOT 9222: two CDP clients cannot share a port, and the API looks
# for this session at GTOW_CDP_HOST_SECONDARY (default 127.0.0.1:9223).
#
# SAFETY: every process lookup matches this build's FULL PATH. Windows names a
# process after its exe, so a name-only match could hit another GTO Wizard
# install — and this script kills what it matches.
#
# ACTIVATION: this is the regional build, which asks for an activation code on
# first run and then remembers it (localStorage in %APPDATA%\gto-wizard-desktop).
# Until that code has been entered once, no app.gtowizard page ever appears and
# there is nothing to sniff. The script says so rather than looping.
#
#   powershell scripts/start_gtow_secondary.ps1             # start (no-op if healthy)
#   powershell scripts/start_gtow_secondary.ps1 -Force      # kill + relaunch
#   powershell scripts/start_gtow_secondary.ps1 -Foreground # visible window (to activate/sign in)

param(
    [switch]$Force,
    [switch]$Foreground
)

$port = if ($env:GTOW_SECONDARY_CDP_PORT) { $env:GTOW_SECONDARY_CDP_PORT } else { 9223 }

$exe = $env:GTOW_SECONDARY_PATH
if (-not $exe) {
    foreach ($c in @(
        "$env:USERPROFILE\Secondary GTO Wizard\Secondary GTO Wizard.exe",
        'C:\Program Files\Secondary GTO Wizard\Secondary GTO Wizard.exe',
        'C:\Program Files\Chinese GTO Wizard\Chinese GTO Wizard.exe'
    )) { if (Test-Path -LiteralPath $c) { $exe = $c; break } }
}
if (-not $exe) {
    Write-Error 'Secondary GTO Wizard is not installed (looked in %USERPROFILE% and Program Files). Set GTOW_SECONDARY_PATH to pin a build.'
    exit 1
}

# Full path only — never a bare process name.
function Get-Secondary {
    Get-CimInstance Win32_Process -Filter "Name='$([IO.Path]::GetFileName($exe).Replace("'","''"))'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $exe }
}

function Get-Targets {
    try { return (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json/list" -TimeoutSec 5).Content | ConvertFrom-Json }
    catch { return $null }
}

# Only PAGE targets count. A CDP target list also carries service workers, and
# https://app.gtowizard.com/service-worker.js matches the hostname while being
# no evidence at all that a usable page is loaded — it made a client sitting on
# /login read as drivable (caught live 2026-09-21).
# The human gates: the activation-code screen and GTO Wizard's own sign-in page.
$HUMAN_GATE = 'activate\.html|/login|/auth|/signin'

# Drivable = a SIGNED-IN app.gtowizard page is loaded, which is the only thing
# the API can sniff a bearer token from. /login is an app.gtowizard URL as well,
# so it must be excluded or a client sitting at the sign-in screen reads as
# healthy while holding no token.
function Test-Drivable {
    $t = Get-Targets
    if ($null -eq $t) { return $false }
    return @($t | Where-Object { $_.type -eq 'page' -and $_.url -match 'app\.gtowizard' -and $_.url -notmatch $HUMAN_GATE }).Count -gt 0
}

# Waiting on a HUMAN: the app is alive and answering CDP, but parked on the
# activation code screen (or a login page). Relaunching cannot fix that and
# would throw away whatever is half-typed, so callers must treat this as
# "leave it alone and tell Brady", never as a reason to restart.
function Test-NeedsHuman {
    $t = Get-Targets
    if ($null -eq $t) { return $false }
    return @($t | Where-Object { $_.type -eq 'page' -and $_.url -match $HUMAN_GATE }).Count -gt 0
}

if (-not $Force) {
    if (Test-Drivable) { Write-Host "Secondary GTO Wizard already drivable on CDP $port"; exit 0 }
    if (Test-NeedsHuman) {
        Write-Warning "Secondary GTO Wizard is running on CDP $port but waiting for a human: enter the activation code, or sign in to GTO Wizard, in its window. Not restarting it."
        exit 3
    }
}

$existing = @(Get-Secondary)
if ($existing) {
    Write-Host "stopping $($existing.Count) Secondary GTO Wizard process(es)"
    $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
}

$style = if ($Foreground) { 'Normal' } else { 'Minimized' }
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$port" -WindowStyle $style
Write-Host "launched '$exe' (CDP $port, $style)"

# This build is slow to settle: it cycles renderers through activate.html
# before the app page appears.
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    if (Test-Drivable) { Write-Host "app.gtowizard target up after $($i * 3)s"; exit 0 }
}
if (Test-NeedsHuman) {
    Write-Warning "Secondary GTO Wizard is up on CDP $port but parked on its activation/login screen - enter the activation code, or sign in, in its window (run with -Foreground to see it)."
    exit 3
}
Write-Warning "Secondary GTO Wizard started but no app.gtowizard CDP target after 180s."
exit 2
