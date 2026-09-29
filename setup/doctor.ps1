# Poker Wrapper — "is everything set up?" Run any time: setup\doctor.cmd (or powershell -File setup\doctor.ps1).
# Read-only: it checks and says what to do; it changes nothing. A screenshot of its output is the best thing to
# send whoever is helping you.
param([int]$ApiPort = 0, [int]$ChartPort = 0)   # 0 = this install's (config\env.ps1: PORT / HRC_UI_PORT, i.e. 2000 / 8777 + PORT_OFFSET)
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bad = 0
function Row([bool]$ok, [string]$what, [string]$detail, [string]$fix = '') {
  if ($ok) { Write-Host ("  [ok] {0,-34} {1}" -f $what, $detail) -ForegroundColor Green }
  else {
    $script:bad++
    Write-Host ("  [!!] {0,-34} {1}" -f $what, $detail) -ForegroundColor Red
    if ($fix) { Write-Host ("       -> {0}" -f $fix) -ForegroundColor Yellow }
  }
}
function Get-Json($url, $timeout = 8) { try { Invoke-RestMethod -Uri $url -TimeoutSec $timeout } catch { $null } }
# where everything is, the way every launcher sees it: the Bun the services run, POKER_DATA_DIR, bin\ (the installer's
# bun + rclone) and the install's own key on PATH
. (Join-Path $root 'config\env.ps1')
$env:Path = "$env:Path;$env:LOCALAPPDATA\Microsoft\WinGet\Links"
. (Join-Path $PSScriptRoot 'channel.ps1')   # also: this install's own download key (config\rclone.conf), when it has one
if (-not $ApiPort) { $ApiPort = [int]$env:PORT }
if (-not $ChartPort) { $ChartPort = [int]$env:HRC_UI_PORT }

Write-Host "Poker Wrapper — checklist ($root)$(if ($env:PORT_OFFSET -match '^[1-9]') { "  [ports +$env:PORT_OFFSET: API :$ApiPort, charts :$ChartPort, panel :$env:PANEL_PORT, GTO Wizard :$env:GTOW_CDP_PORT]" })" -ForegroundColor White
Write-Host ""
Write-Host " Installed" -ForegroundColor Cyan
$bun = $env:BUN; Row ([bool]$bun) 'Bun' $(if ($bun) { "v$(& $bun --version)" } else { 'missing' }) 'run PokerWrapperSetup.exe again (repair)'
$rc = Get-Command rclone; Row ([bool]$rc) 'rclone' $(if ($rc) { 'installed' } else { 'missing' }) 'run PokerWrapperSetup.exe again (repair)'
$chrome = (Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") -or (Test-Path "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
Row $chrome 'Google Chrome' $(if ($chrome) { 'installed' } else { 'missing' }) 'run PokerWrapperSetup.exe again (repair)'
$brave = (Test-Path "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe") -or (Test-Path "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe")
Row $brave 'Brave' $(if ($brave) { 'installed' } else { 'missing' }) 'run PokerWrapperSetup.exe again (repair)'
# shipped in gto-trainer\node_modules (vendored, 2026-09-27) or bun-installed per app (a zip install before that)
$api_mods = (Test-Path (Join-Path $root 'gto-trainer\node_modules\hono')) -or (Test-Path (Join-Path $root 'gto-trainer\apps\api\node_modules\hono'))
Row $api_mods 'Study API packages' $(if ($api_mods) { 'installed' } else { 'missing' }) 'run PokerWrapperSetup.exe again (repair)'

Write-Host ""
Write-Host " Version" -ForegroundColor Cyan
$inst = Get-Installed $root
if (-not $inst) { Write-Host ("  [..] {0,-34} {1}" -f 'Installed version', '(source checkout — updates come from git)') }
else {
  $rel = Get-Release
  $upd = if (-not $rel) { 'update channel unreadable (check the download key)' } elseif ($rel.version -gt $inst.version) { "update waiting: $($rel.version) - press Update now on the Poker Wrapper's setup page" } else { 'up to date' }
  Write-Host ("  [..] {0,-34} {1}  ({2})" -f 'Installed version', $inst.version, $upd) -ForegroundColor $(if ($rel -and $rel.version -gt $inst.version) { 'Yellow' } else { 'Gray' })
  $haveData = Get-InstalledData $root
  $wanted = Get-WantedParts $root $inst   # the strategy's parts only
  $dataOk = -not @($inst.data.PSObject.Properties | Where-Object { ($wanted -contains $_.Name) -and ($haveData[$_.Name] -ne $_.Value) }).Count
  Row $dataOk 'Data matches this version' $(if ($dataOk) { ($inst.data.PSObject.Properties | Where-Object { $wanted -contains $_.Name } | ForEach-Object { "$($_.Name) $($_.Value)" }) -join ', ' } else { 'a data part is missing or old' }) 'run PokerWrapperSetup.exe again (repair) (it fetches the missing part)'
}

Write-Host ""
Write-Host " Data" -ForegroundColor Cyan
$sqlite = Join-Path $root 'gto-trainer\apps\api\data\hrc6max-preflop.sqlite'
Row (Test-Path $sqlite) '6-max preflop charts' $(if (Test-Path $sqlite) { "$([math]::Round((Get-Item $sqlite).Length / 1GB, 1)) GB" } else { 'missing' }) 'put PokerWrapper-data-*.zip next to the folder and run setup'
$metas = @(Get-ChildItem (Join-Path $root 'gto-trainer\apps\api\data\charts') -Filter *.meta.json).Count
Row ($metas -gt 1000) 'Chart index' "$metas charts" 'put PokerWrapper-data-*.zip next to the folder and run setup'
$turn = @(Get-ChildItem (Join-Path $root 'gto-trainer\apps\api\data\mes_turn')).Count
$installedNow = Get-Installed $root
$wantedParts = Get-WantedParts $root $installedNow
if ($installedNow -and ($wantedParts -notcontains 'mesturn')) { Write-Host ("  [..] {0,-34} {1}" -f 'MES turn data', "not part of this install (strategy $(Get-InstallStrategy $root))") }
else { Row ($turn -gt 0) 'MES turn data' "$turn files" 'put PokerWrapper-data-*.zip next to the folder and run setup' }
$r2 = $false
# one known chart, stat only (~1 s; a listing of this folder takes 30 s+)
# must come back a FILE: on R2 a key that cannot see the object (or a missing one) can answer a phantom directory, exit 0
if ($rc) { $st = & $rc.Source lsjson --stat 'r2:poker-solve-db/hrc-ui/hrc_hu_cp200a_d100_o2_5_3b9.json.gz' 2>$null; $r2 = ($LASTEXITCODE -eq 0) -and (($st -join '') -match '"IsDir":\s*false') }
Row $r2 'Chart downloads (R2)' $(if ($r2) { 'the chart bucket is readable' } else { 'not configured or key rejected' }) 'run PokerWrapperSetup.exe again and enter the download key'

Write-Host ""
Write-Host " Settings" -ForegroundColor Cyan
$local = Join-Path $root 'config\local.env'
$cfg = if (Test-Path $local) { Get-Content $local } else { @() }
$hero = ($cfg | Where-Object { $_ -match '^\s*CP_HERO\s*=\s*\S' }) -replace '^\s*CP_HERO\s*=\s*', ''
Write-Host ("  [..] {0,-34} {1}" -f 'CoinPoker name', $(if ($hero) { $hero } else { '(learned from CoinPoker when you sit down)' }))

Write-Host ""
Write-Host " Running" -ForegroundColor Cyan
# this user's per-user tasks whenever they are registered (an install, or a checkout that runs the live stack)
$mine = @($TaskNames.Values | Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue })
foreach ($t in $(if ((Get-Installed $root) -or $mine.Count) { $TaskNames.Values } else { 'StudyAPI', 'ChartServer', 'GtowWatchdog' })) {
  $st = (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue).State
  Row ($st -eq 'Running') "service $t" $(if ($st) { "$st" } else { 'not registered' }) "run PokerWrapperSetup.exe again (repair) (or: Start-ScheduledTask $t)"
}
$cfgApi = Get-Json "http://127.0.0.1:$ApiPort/api/dashboard/config"
Row ([bool]$cfgApi) "study API on :$ApiPort" $(if ($cfgApi) { "up$(if ($cfgApi.playerMode) { ', player mode' })" } else { 'not answering' }) 'wait a minute after logon; if it stays down, restart the laptop (the services start at logon)'
$sol = Get-Json "http://127.0.0.1:$ChartPort/api/solutions" 20
Row ([bool]$sol) "chart server on :$ChartPort" $(if ($sol) { "up, $(@($sol).Count) charts" } else { 'not answering' }) 'restart the laptop (the services start at logon)'
if ($cfgApi) {
  $reg = Get-Json "http://127.0.0.1:$ApiPort/api/dashboard/sources/registry" 20
  $g = $reg.armed.gtow
  Row ([bool]$g.tokenLive) 'GTO Wizard signed in' $(if ($g.tokenLive) { 'live token' } elseif ($g.clientUp) { 'Chrome is up but not signed in' } else { 'not running' }) 'double-click setup\gtow-signin.cmd and sign in to GTO Wizard there'
  $strats = Get-Json "http://127.0.0.1:$ApiPort/api/dashboard/sources/strategies" 20
  foreach ($s in @($strats.strategies)) {
    $ok = $s.status -in 'ok', 'drift'
    Row $ok "strategy: $($s.name)" $(if ($ok) { 'ready' } else { "$($s.status): $(@($s.reasons)[0])" })
  }
}

Write-Host ""
Write-Host " Poker clients" -ForegroundColor Cyan
$cp = Test-Path "$env:ProgramFiles\CoinPoker\CoinPoker.exe"
Write-Host ("  [..] {0,-34} {1}" -f 'CoinPoker client', $(if ($cp) { 'installed' } else { 'not installed (only needed for CoinPoker)' }))
$prof = if ($env:POKER_DATA_DIR) { Join-Path $env:POKER_DATA_DIR 'wrapper\profiles.json' } else { Join-Path $root 'ignition-study-wrapper\data\profiles.json' }
$hasProf = (Test-Path $prof) -and ((Get-Content $prof -Raw) -match '"email"')
Write-Host ("  [..] {0,-34} {1}" -f 'Ignition sign-in profile', $(if ($hasProf) { 'saved' } else { '(none yet — add one on the setup page: Profiles…)' }))

Write-Host ""
if ($bad) { Write-Host "$bad thing(s) to fix above." -ForegroundColor Red } else { Write-Host 'Everything is up. Open "Poker Wrapper" from the desktop.' -ForegroundColor Green }
