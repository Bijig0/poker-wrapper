# Poker Wrapper — setup (player mode). PokerWrapperSetup.exe runs it after copying the files (-Installer); an update
# runs it again (setup\update.ps1); setup\setup.cmd runs it by hand to repair an install.
#
# Safe to run again: every step checks first and only does what is missing. What it does:
#   1. tools        Bun + rclone (the installer's own copies in bin\, else winget), Google Chrome, Brave (winget, if missing)
#   2. downloads    rclone remote "r2" = the owner's download key: charts, data and UPDATES come through it
#                   installer: -KeyFile (what the key page collected) -> config\rclone.conf, this install's own
#                   zip install: PokerWrapper-key.txt next to the folder, else pasted -> the Windows user's rclone config
#   3. data         the data parts this version expects (setup\channel.ps1): a zip next to the folder, else downloaded
#   4. packages     the study API's and wrapper's packages: shipped in gto-trainer\node_modules (else bun install)
#   5. config       config\local.env: one GTO Wizard account
#   6. services     scheduled tasks "PokerWrapper API / Charts / GTO Wizard - <user>" (:2000, :8777, GTO Wizard)
#   7. shortcuts    "Poker Wrapper" + "Poker Dashboard" on the desktop (the installer makes its own)
#   8. check        setup\doctor.ps1
# What it cannot do for you: sign in to GTO Wizard, create your Ignition profile, install and sign in to CoinPoker.
param(
  [string]$DataZip = '',         # path to PokerWrapper-data-*.zip (default: look next to this folder)
  [string]$KeyFile = '',         # rclone "key = value" lines for remote r2 (the installer's key page); deleted after use
  [switch]$Installer,            # run by PokerWrapperSetup.exe: shortcuts are its job, show download progress
  [switch]$SkipTools,            # tools already installed
  [switch]$SkipTasks,            # do not register scheduled tasks (testing)
  [switch]$SkipShortcut,
  [switch]$NoPrompt              # take defaults, ask nothing (testing)
)
$ErrorActionPreference = 'Continue'   # NOT Stop: PS 5.1 turns any native stderr line (bun's notes, rclone) into a fatal error; every step checks its own result
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$fail = @()
. (Join-Path $PSScriptRoot 'channel.ps1')
$ShowDownloadProgress = [bool]$Installer
if ($Installer) {
  $SkipShortcut = $true; $NoPrompt = $true; $Host.UI.RawUI.WindowTitle = 'Poker Wrapper - finishing setup'
  # what this window said, kept: the file to send when an install went wrong
  try { Start-Transcript -Path (Join-Path $root 'config\setup-install.log') -Force | Out-Null } catch { }
}
$bin = Join-Path $root 'bin'

function Step($n, $what) { Write-Host ""; Write-Host "[$n] $what" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Todo($m) { Write-Host "    ->  $m" -ForegroundColor Yellow }
function Bad($m) { Write-Host "    !!  $m" -ForegroundColor Red; $script:fail += $m }
function Ask($q, $default = '') {
  if ($NoPrompt) { return $default }
  $a = Read-Host "    $q$(if ($default) { " [$default]" })"
  if ($a) { $a } else { $default }
}
function Refresh-Path {
  $env:Path = "$bin;" + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') +
              ";$env:LOCALAPPDATA\Microsoft\WinGet\Links"
}

Write-Host "Poker Wrapper setup — $root" -ForegroundColor White

# ---------------------------------------------------------------- 1. tools
Step 1 'Tools (Bun, rclone, Chrome, Brave)'
$tools = @(
  @{ id = 'Oven-sh.Bun';        test = { [bool](Get-Command bun -ErrorAction SilentlyContinue) }; name = 'Bun' },
  @{ id = 'Rclone.Rclone';      test = { [bool](Get-Command rclone -ErrorAction SilentlyContinue) }; name = 'rclone' },
  @{ id = 'Google.Chrome';      test = { (Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") -or (Test-Path "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") }; name = 'Google Chrome (GTO Wizard runs in it)' },
  @{ id = 'Brave.Brave';        test = { (Test-Path "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe") -or (Test-Path "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe") }; name = 'Brave (the Ignition table + the panel)' }
)
Refresh-Path
foreach ($t in $tools) {
  if (& $t.test) { Ok $t.name; continue }
  if ($SkipTools) { Bad "$($t.name) is not installed (skipped: -SkipTools)"; continue }
  Todo "installing $($t.name) (a window may flash by) ..."
  & winget install --id $t.id --exact --silent --accept-source-agreements --accept-package-agreements --scope user 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { & winget install --id $t.id --exact --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null }
  Refresh-Path
  if (& $t.test) { Ok "$($t.name) installed" } else { Bad "$($t.name) did not install — install it by hand (winget install $($t.id)) and run setup again" }
}

# ---------------------------------------------------------------- 2. chart + update downloads (R2)
Step 2 'Downloads: charts + updates (rclone remote "r2")'
$rclone = Find-Rclone
function Read-KeyLines([string]$path) {
  # rclone "key = value" lines (the [r2] section of an rclone.conf, as PokerWrapper-key.txt is written); type is implied
  @(Get-Content $path | Where-Object { $_ -match '^\s*([a-z_]+)\s*=\s*(\S.*)$' -and $Matches[1] -ne 'type' } |
    ForEach-Object { $null = $_ -match '^\s*([a-z_]+)\s*=\s*(\S.*)$'; "$($Matches[1])=$($Matches[2].Trim())" })
}
if (-not $rclone) { Bad 'rclone not found' }
else {
  if ($KeyFile -and (Test-Path $KeyFile)) {
    # the installer's key page: THIS install's own config (config\rclone.conf; env.ps1 points every launcher at it)
    $env:RCLONE_CONFIG = Join-Path $root 'config\rclone.conf'
    New-Item -ItemType Directory -Force (Split-Path $env:RCLONE_CONFIG) | Out-Null
    $kv = Read-KeyLines $KeyFile
    if ((Test-Path $env:RCLONE_CONFIG) -and ((& $rclone listremotes 2>$null) -match '^r2:$')) { & $rclone config delete r2 2>&1 | Out-Null }
    & $rclone config create r2 s3 @kv --non-interactive | Out-Null
    Remove-Item $KeyFile -Force -ErrorAction SilentlyContinue   # a temp copy holding the secret
    Ok 'download key saved with this install'
  } else {
    $remotes = & $rclone listremotes 2>$null
    # a key FILE handed over with the zip (PokerWrapper-key.txt, rclone "key = value" lines) is used as-is: nothing
    # to paste. Looked for next to the PokerWrapper folder, inside it, and in Downloads.
    $keyTxt = @((Join-Path (Split-Path $root) 'PokerWrapper-key.txt'), (Join-Path $root 'PokerWrapper-key.txt'),
                (Join-Path $env:USERPROFILE 'Downloads\PokerWrapper-key.txt')) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($remotes -match '^r2:$') { Ok 'remote r2 already configured' }
    elseif ($keyTxt) {
      & $rclone config create r2 s3 @(Read-KeyLines $keyTxt) --non-interactive | Out-Null
      Ok "download key read from $keyTxt"
    }
    else {
      Todo 'no PokerWrapper-key.txt found next to the folder — paste the download key instead'
      $keyId = Ask 'Access key ID'
      $secret = Ask 'Secret access key'
      $endpoint = Ask 'Endpoint (https://<account>.r2.cloudflarestorage.com)'
      if ($keyId -and $secret -and $endpoint) {
        & $rclone config create r2 s3 provider=Cloudflare "access_key_id=$keyId" "secret_access_key=$secret" "endpoint=$endpoint" acl=private --non-interactive | Out-Null
      } else { Bad 'no key entered — charts not in the local cache cannot be fetched (run setup again when you have it)' }
    }
  }
  if ((& $rclone listremotes 2>$null) -match '^r2:$') {
    $probe = & $rclone lsjson --stat 'r2:poker-solve-db/hrc-ui/hrc_hu_cp200a_d100_o2_5_3b9.json.gz' 2>&1   # one object: ~1 s
    # must come back a FILE: on R2 a key that cannot see the object can answer a phantom directory, exit 0
    if ($LASTEXITCODE -eq 0 -and (($probe -join '') -match '"IsDir":\s*false')) { Ok 'the chart bucket is readable' } else { Bad "cannot read r2:poker-solve-db/hrc-ui — check the key ($probe)" }
  }
}

# ---------------------------------------------------------------- 3. data
Step 3 'Data (6-max preflop DB, MES turn data, node trust) — about 3 GB to download the first time'
$sqlite = Join-Path $root 'gto-trainer\apps\api\data\hrc6max-preflop.sqlite'
if (Get-Installed $root) {
  # the parts THIS code version expects (VERSION.json), from a zip next to the folder or the update channel
  $sync = Sync-DataParts $root
  if ($sync.ok) { Ok $(if ($sync.did.Count) { "installed: $($sync.did -join ', ')" } else { 'up to date' }) }
  else { Bad "could not get data part(s) $($sync.missing -join ', ') — is the key in step 2 right? Or put the PokerWrapper-data-*.zip files next to the PokerWrapper folder and run setup again" }
} elseif (Test-Path $sqlite) { Ok 'already in place' }
else {
  # a package from before versioned releases: one combined data zip next to the folder
  if (-not $DataZip) {
    $DataZip = @(Get-ChildItem (Split-Path $root) -Filter 'PokerWrapper-data-*.zip' -ErrorAction SilentlyContinue) |
               Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if ($DataZip -and (Test-Path $DataZip)) {
    Todo "unpacking $DataZip (a few minutes) ..."
    & "$env:SystemRoot\System32\tar.exe" -xf $DataZip -C $root --strip-components 1
    if ($LASTEXITCODE -eq 0 -and (Test-Path $sqlite)) { Ok 'data unpacked' } else { Bad "could not unpack $DataZip" }
  } else { Bad 'data not found — run setup again after step 2 is green, or put the data zip next to the PokerWrapper folder' }
}
# THE CHART INDEX MOVED (2026-09-27, the poker-wrapper repo): analysis\pipeline\solve\exploit_ui\solutions ->
# gto-trainer\apps\api\data\charts. An update brings the index files (they are code); the chart bodies cached beside
# the old index are downloads, so they are moved here rather than fetched again, and the emptied old folders go.
$oldCharts = Join-Path $root 'analysis\pipeline\solve\exploit_ui\solutions'
if (Test-Path $oldCharts) {
  $newCharts = Join-Path $root 'gto-trainer\apps\api\data\charts'
  New-Item -ItemType Directory -Force -Path $newCharts | Out-Null
  $moved = 0
  Get-ChildItem $oldCharts -File -Filter '*.json.gz' | ForEach-Object {
    $dst = Join-Path $newCharts $_.Name
    if (-not (Test-Path $dst)) { Move-Item -LiteralPath $_.FullName -Destination $dst; $moved++ }
  }
  Remove-Item -Recurse -Force (Join-Path $root 'analysis') -ErrorAction SilentlyContinue
  Ok "chart cache moved to gto-trainer\apps\api\data\charts ($moved bodies)"
}

# ---------------------------------------------------------------- 4. packages
# (no Python since 2026-09-27: the chart server is TypeScript too — an older install's aof-model\.venv is left alone)
Step 4 'Packages (study API + wrapper)'
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\bun.exe" }
if (Test-Path $bun) {
  Push-Location (Join-Path $root 'gto-trainer')
  try {
    # prove every import resolves: a half-written package installs "fine" and then the API cannot start
    # (seen 2026-09-22: zod@4.4.3 without its v4/ folder). The wrapper (apps\wrapper) is probed the same way.
    $probe = Join-Path $env:TEMP 'pokerwrapper-resolve-check.js'
    function Test-Resolves {
      & $bun build apps\api\index.ts --target=bun --outfile $probe 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { & $bun build apps\wrapper\src\main.ts --target=bun --outfile $probe 2>&1 | Out-Null }
      return ($LASTEXITCODE -eq 0)
    }
    # the package ships its packages (gto-trainer\node_modules, vendored by buildPackage.ts): nothing to download
    $resolved = Test-Resolves
    if ($resolved) { Ok 'every import resolves' }
    else {
      Todo 'installing packages (bun install) ...'
      & $bun install --frozen-lockfile 2>&1 | Select-Object -Last 2 | ForEach-Object { "    $_" }
      $resolved = Test-Resolves
      if (-not $resolved) {
        Todo 'a package came down incomplete; clearing the package cache and reinstalling ...'
        & $bun pm cache rm 2>&1 | Out-Null
        Remove-Item -Recurse -Force apps\api\node_modules, apps\wrapper\node_modules -ErrorAction SilentlyContinue
        & $bun install --frozen-lockfile 2>&1 | Select-Object -Last 2 | ForEach-Object { "    $_" }
        $resolved = Test-Resolves
      }
      if ($resolved) { Ok 'installed (every import resolves)' }
    }
    Remove-Item $probe -ErrorAction SilentlyContinue
  } finally { Pop-Location }
  if (-not $resolved) { Bad 'the study API or the wrapper cannot load its packages (see above)' }
} else { Bad 'bun not found' }

# ---------------------------------------------------------------- 5. config
Step 5 'Settings (config\local.env)'
$local = Join-Path $root 'config\local.env'
if (-not (Test-Path $local)) { Copy-Item (Join-Path $root 'config\local.env.example') $local }
$cfg = Get-Content $local
function Set-Cfg($key, $value) {
  $script:cfg = @($script:cfg | Where-Object { $_ -notmatch "^\s*$key\s*=" }) + "$key=$value"
}
$has = { param($k) [bool]($cfg | Where-Object { $_ -match "^\s*$k\s*=\s*\S" }) }
Set-Cfg 'GTOW_SECONDARY' '0'       # one GTO Wizard account (the main one); heads-up solves use it too
# retired settings (PLAYER_MODE, CHART_SERVER: that is simply how this app is now)
$cfg = @($cfg | Where-Object { $_ -notmatch '^\s*(PLAYER_MODE|CHART_SERVER)\s*=' })
# no CoinPoker name to ask for: the reader learns it from the client's own log (sites/cpFeed.ts);
# CP_HERO in local.env still pins it if that ever guesses wrong
[IO.File]::WriteAllLines($local, [string[]]$cfg)   # no BOM: the wrapper and env.ps1 read it too
Ok "written: GTOW_SECONDARY=0$(if (& $has 'CP_HERO') { ', CP_HERO set' })"

# ---------------------------------------------------------------- 6. services
Step 6 'Services (study API, chart server, GTO Wizard watchdog)'
if ($SkipTasks) { Todo 'skipped (-SkipTasks)' }
else {
  # never re-point an existing install's services at this folder without asking
  $existing = Get-ScheduledTask -TaskName $TaskNames.api -ErrorAction SilentlyContinue
  $elsewhere = $existing -and ($existing.Actions.Arguments -notmatch [regex]::Escape($root))
  $go = $true
  if ($elsewhere) {
    Todo "this Windows user already runs a Poker Wrapper from ANOTHER folder: $($existing.Actions.Arguments)"
    # the installer is the user saying "this one": it replaces the old folder's services (the old folder stays)
    $go = $Installer -or ((Ask 'Replace it with this install? (y/N)' 'N') -match '^[yY]')
  }
  if ($go) {
    # (re)start: a service already running from this folder keeps the OLD code/config until it restarts
    foreach ($t in $TaskNames.Values) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
    # open the GTO Wizard window VISIBLE first (a no-op when it is already up), so the sign-in page is in
    # front of them; the watchdog would otherwise start it minimised
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start_gtow_chrome.ps1') -Foreground
    Todo 'a Chrome window opened on GTO Wizard: sign in there and leave it open'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install_tasks.ps1') -Start
    Ok 'registered and started (they start by themselves at every logon)'
  } else { Bad 'services not registered (kept the existing install)' }
}

# ---------------------------------------------------------------- 7. shortcuts
Step 7 'Shortcuts'
$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Poker Wrapper.lnk'
function Write-WrapperShortcut {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($lnkPath)
  # the wrapper (TypeScript, gto-trainer\apps\wrapper), started hidden by run-wrapper.vbs (log ->
  # ignition-study-wrapper\server.log); ignition-study-wrapper\wrapper.cmd runs it with a console.
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = "`"$(Join-Path $root 'ignition-study-wrapper\run-wrapper.vbs')`""
  $lnk.WorkingDirectory = Join-Path $root 'ignition-study-wrapper'
  $ico = Join-Path $root 'ignition-study-wrapper\ignition-study.ico'
  if (Test-Path $ico) { $lnk.IconLocation = "$ico,0" }
  $lnk.Save()
}
# the dashboard (http://localhost:2000) icon is made ONCE per install, updates included (an update runs -SkipShortcut,
# and older installs never had it) — the marker means a deleted icon stays deleted. The installer makes both icons
# itself (Start menu + desktop) and sets the marker, so an update never adds a second one.
$dashMark = Join-Path $root 'config\dashboard-shortcut.done'
if ($Installer) {
  Set-Content -Path $dashMark -Value (Get-Date -Format 's') -Encoding ASCII
  Ok 'made by the installer (Start menu + desktop)'
} elseif ($SkipShortcut) {
  # an update skips the shortcut — but one made before 2026-09-24 points at the Python wrapper (pythonw
  # run-study.pyw), which is gone, and would open nothing: repoint that one, leave any other alone
  $stale = $false
  if (Test-Path $lnkPath) { $stale = ((New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath).Arguments -match 'run-study\.pyw') }
  if ($stale) { Write-WrapperShortcut; Ok '"Poker Wrapper" shortcut repointed at the new wrapper' } else { Todo 'skipped' }
}
else {
  Write-WrapperShortcut
  Ok '"Poker Wrapper" is on the desktop'
}
if (-not (Test-Path $dashMark)) {
  $url = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Poker Dashboard.url'
  $ico = Join-Path $root 'gto-trainer\study-tool.ico'
  $body = @('[InternetShortcut]', 'URL=http://localhost:2000/')
  if (Test-Path $ico) { $body += @("IconFile=$ico", 'IconIndex=0') }
  Set-Content -Path $url -Value $body -Encoding ASCII
  New-Item -ItemType Directory -Force (Split-Path $dashMark) | Out-Null
  Set-Content -Path $dashMark -Value (Get-Date -Format 's') -Encoding ASCII
  Ok '"Poker Dashboard" is on the desktop (opens http://localhost:2000)'
}

# ---------------------------------------------------------------- 8. check
Step 8 'Check'
& (Join-Path $PSScriptRoot 'doctor.ps1')   # in this process: the installer's transcript keeps the checklist too
Write-Host ""
if ($fail.Count) {
  Write-Host "Setup finished with $($fail.Count) problem(s) above — fix them and run setup again (it skips what is done)." -ForegroundColor Red
  if ($Installer) {
    Write-Host 'To try again later, run PokerWrapperSetup.exe again: it repairs the install and keeps your hands and settings.' -ForegroundColor Yellow
    Read-Host 'Press Enter to close' | Out-Null
  }
  exit 1
}
if ($Installer) {
  Write-Host 'All set. Sign in to GTO Wizard in the Chrome window (once), then open "Poker Wrapper".' -ForegroundColor Green
  Start-Sleep -Seconds 4
} else {
  Write-Host 'Setup finished. Next: sign in to GTO Wizard, add your poker accounts, then open "Poker Wrapper".' -ForegroundColor Green
}
exit 0
