# Poker Wrapper — "is everything set up?" Run any time: setup\doctor.cmd (or powershell -File setup\doctor.ps1).
# Read-only: it checks and says what to do; it changes nothing. A screenshot of its output is the best thing to
# send whoever is helping you.
param([int]$ApiPort = 2000, [int]$ChartPort = 8777)
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
$env:Path += ";$env:LOCALAPPDATA\Microsoft\WinGet\Links"

Write-Host "Poker Wrapper — checklist ($root)" -ForegroundColor White
Write-Host ""
Write-Host " Installed" -ForegroundColor Cyan
$venv = Join-Path $root 'aof-model\.venv\Scripts\python.exe'
Row (Test-Path $venv) 'Python environment' $(if (Test-Path $venv) { & $venv --version } else { 'missing' }) 'run setup\setup.cmd'
$bun = Get-Command bun; Row ([bool]$bun) 'Bun' $(if ($bun) { "v$(& $bun.Source --version)" } else { 'missing' }) 'run setup\setup.cmd'
$rc = Get-Command rclone; Row ([bool]$rc) 'rclone' $(if ($rc) { 'installed' } else { 'missing' }) 'run setup\setup.cmd'
$chrome = (Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") -or (Test-Path "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
Row $chrome 'Google Chrome' $(if ($chrome) { 'installed' } else { 'missing' }) 'run setup\setup.cmd'
$brave = (Test-Path "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe") -or (Test-Path "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe")
Row $brave 'Brave' $(if ($brave) { 'installed' } else { 'missing' }) 'run setup\setup.cmd'
$api_mods = Test-Path (Join-Path $root 'gto-trainer\apps\api\node_modules\hono')
Row $api_mods 'Study API packages' $(if ($api_mods) { 'installed' } else { 'missing' }) 'run setup\setup.cmd'

Write-Host ""
Write-Host " Version" -ForegroundColor Cyan
. (Join-Path $PSScriptRoot 'channel.ps1')
$inst = Get-Installed $root
if (-not $inst) { Write-Host ("  [..] {0,-34} {1}" -f 'Installed version', '(source checkout — updates come from git)') }
else {
  $rel = Get-Release
  $upd = if (-not $rel) { 'update channel unreadable (check the download key)' } elseif ($rel.version -gt $inst.version) { "update waiting: $($rel.version) - double-click setup\update.cmd" } else { 'up to date' }
  Write-Host ("  [..] {0,-34} {1}  ({2})" -f 'Installed version', $inst.version, $upd) -ForegroundColor $(if ($rel -and $rel.version -gt $inst.version) { 'Yellow' } else { 'Gray' })
  $haveData = Get-InstalledData $root
  $dataOk = -not @($inst.data.PSObject.Properties | Where-Object { $haveData[$_.Name] -ne $_.Value }).Count
  Row $dataOk 'Data matches this version' $(if ($dataOk) { ($inst.data.PSObject.Properties | ForEach-Object { "$($_.Name) $($_.Value)" }) -join ', ' } else { 'a data part is missing or old' }) 'run setup\setup.cmd (it fetches the missing part)'
}

Write-Host ""
Write-Host " Data" -ForegroundColor Cyan
$sqlite = Join-Path $root 'gto-trainer\apps\api\data\hrc6max-preflop.sqlite'
Row (Test-Path $sqlite) '6-max preflop charts' $(if (Test-Path $sqlite) { "$([math]::Round((Get-Item $sqlite).Length / 1GB, 1)) GB" } else { 'missing' }) 'put PokerWrapper-data-*.zip next to the folder and run setup'
$metas = @(Get-ChildItem (Join-Path $root 'analysis\pipeline\solve\exploit_ui\solutions') -Filter *.meta.json).Count
Row ($metas -gt 1000) 'Chart index' "$metas charts" 'put PokerWrapper-data-*.zip next to the folder and run setup'
$turn = @(Get-ChildItem (Join-Path $root 'gto-trainer\apps\api\data\mes_turn')).Count
Row ($turn -gt 0) 'MES turn data' "$turn files" 'put PokerWrapper-data-*.zip next to the folder and run setup'
$r2 = $false
# one known chart, stat only (~1 s; a listing of this folder takes 30 s+)
# must come back a FILE: on R2 a key that cannot see the object (or a missing one) can answer a phantom directory, exit 0
if ($rc) { $st = & $rc.Source lsjson --stat 'r2:poker-solve-db/hrc-ui/hrc_hu_cp200a_d100_o2_5_3b9.json.gz' 2>$null; $r2 = ($LASTEXITCODE -eq 0) -and (($st -join '') -match '"IsDir":\s*false') }
Row $r2 'Chart downloads (R2, read-only)' $(if ($r2) { 'the chart bucket is readable' } else { 'not configured or key rejected' }) 'run setup\setup.cmd and paste the read-only key'

Write-Host ""
Write-Host " Settings" -ForegroundColor Cyan
$local = Join-Path $root 'config\local.env'
$cfg = if (Test-Path $local) { Get-Content $local } else { @() }
$pm = [bool]($cfg -match '^\s*PLAYER_MODE\s*=\s*1')
Row $pm 'Player mode' $(if ($pm) { 'on' } else { 'off' }) 'run setup\setup.cmd'
$hero = ($cfg | Where-Object { $_ -match '^\s*CP_HERO\s*=\s*\S' }) -replace '^\s*CP_HERO\s*=\s*', ''
Write-Host ("  [..] {0,-34} {1}" -f 'CoinPoker name', $(if ($hero) { $hero } else { '(not set — only needed for CoinPoker)' }))

Write-Host ""
Write-Host " Running" -ForegroundColor Cyan
foreach ($t in 'StudyAPI', 'ChartServer', 'GtowWatchdog') {
  $st = (Get-ScheduledTask -TaskName $t).State
  Row ($st -eq 'Running') "service $t" $(if ($st) { "$st" } else { 'not registered' }) "run setup\setup.cmd (or: Start-ScheduledTask $t)"
}
$cfgApi = Get-Json "http://127.0.0.1:$ApiPort/api/dashboard/config"
Row ([bool]$cfgApi) "study API on :$ApiPort" $(if ($cfgApi) { "up$(if ($cfgApi.playerMode) { ', player mode' })" } else { 'not answering' }) 'wait a minute after logon; if it stays down, restart the laptop or: Start-ScheduledTask StudyAPI'
$sol = Get-Json "http://127.0.0.1:$ChartPort/api/solutions" 20
Row ([bool]$sol) "chart server on :$ChartPort" $(if ($sol) { "up, $(@($sol).Count) charts" } else { 'not answering' }) 'Start-ScheduledTask ChartServer'
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
$prof = Join-Path $root 'ignition-study-wrapper\data\profiles.json'
$hasProf = (Test-Path $prof) -and ((Get-Content $prof -Raw) -match '"email"')
Write-Host ("  [..] {0,-34} {1}" -f 'Ignition sign-in profile', $(if ($hasProf) { 'saved' } else { '(none yet — add one on the setup page: Profiles…)' }))

Write-Host ""
if ($bad) { Write-Host "$bad thing(s) to fix above." -ForegroundColor Red } else { Write-Host 'Everything is up. Open "Poker Wrapper" from the desktop.' -ForegroundColor Green }
