# Token source without an Electron client: run app.gtowizard.com in a DEDICATED
# Chrome profile with CDP on, so the API can sniff its bearer token the same way
# it used to sniff the desktop client's.
#
# Why a dedicated --user-data-dir: Chrome refuses --remote-debugging-port on a
# profile that is already running, so we cannot reuse Brady's everyday profile
# while he has Chrome open. A separate profile also means this window's cookies
# are ours alone — logging in here does not touch his main browsing session.
#
# SAFETY: every process lookup below matches on the --user-data-dir, never on
# "chrome.exe". Killing by name would take down his entire browser.
#
# First run: the profile is empty, so log in to GTO Wizard once in the window
# that opens. The session persists in that profile across restarts.
#
#   powershell scripts/start_gtow_chrome.ps1            # start (no-op if healthy)
#   powershell scripts/start_gtow_chrome.ps1 -Force     # kill + relaunch
#   powershell scripts/start_gtow_chrome.ps1 -Foreground # visible window (to log in)

param(
    [switch]$Force,
    [switch]$Foreground
)

$port    = if ($env:GTOW_CDP_PORT) { $env:GTOW_CDP_PORT } else { 9222 }
$profile = if ($env:GTOW_CHROME_PROFILE) { $env:GTOW_CHROME_PROFILE } else { "$env:LOCALAPPDATA\gtow-cdp-profile" }
$url     = 'https://app.gtowizard.com/'

$chrome = $null
foreach ($c in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)) { if (Test-Path -LiteralPath $c) { $chrome = $c; break } }
if (-not $chrome) { Write-Error 'chrome.exe not found'; exit 1 }

# Our instance only: match the dedicated profile dir on the command line.
function Get-GtowChrome {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*--user-data-dir=$profile*" }
}

function Test-GtowTarget {
    try {
        $t = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json/list" -TimeoutSec 5).Content | ConvertFrom-Json
        return @($t | Where-Object { $_.url -match 'app\.gtowizard' }).Count -gt 0
    } catch { return $false }
}

if (-not $Force -and (Test-GtowTarget)) {
    Write-Host "GTO Wizard already drivable on CDP $port (profile: $profile)"
    exit 0
}

$existing = @(Get-GtowChrome)
if ($existing) {
    Write-Host "stopping $($existing.Count) chrome process(es) in the CDP profile"
    $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
}

if (-not (Test-Path -LiteralPath $profile)) {
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    Write-Host "created profile dir $profile - you must log in once in the window that opens"
    $Foreground = $true
}

$chromeArgs = @(
    "--user-data-dir=$profile"
    "--remote-debugging-port=$port"
    # Chrome rejects CDP websockets carrying an unexpected Origin header unless
    # this is set. Safe here: the profile is dedicated and the port is loopback.
    '--remote-allow-origins=*'
    '--no-first-run'
    '--no-default-browser-check'
    '--disable-features=ChromeWhatsNewUI'
    $url
)
$style = if ($Foreground) { 'Normal' } else { 'Minimized' }
Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle $style
Write-Host "launched chrome (CDP $port, profile $profile, $style)"

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Test-GtowTarget) { Write-Host "app.gtowizard target up after $($i * 2)s"; exit 0 }
}
Write-Warning "chrome started but no app.gtowizard CDP target after 60s - if this is a fresh profile, log in first (-Foreground)"
exit 2
