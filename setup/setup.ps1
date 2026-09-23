# Poker Wrapper — setup for a new Windows laptop (player mode). Run via setup\setup.cmd (double-click).
#
# Safe to run again: every step checks first and only does what is missing. What it does:
#   1. tools        Python 3.12, Bun, rclone, Google Chrome, Brave (winget)
#   2. downloads    rclone remote "r2" (the owner's key: PokerWrapper-key.txt next to the folder, else pasted):
#                   chart bodies, data and UPDATES come from it
#   3. data         the data parts this version expects (setup\channel.ps1): a zip next to the folder, else downloaded
#   4. python       aof-model\.venv from aof-model\requirements.txt
#   5. api          bun install (the study API's packages)
#   6. config       config\local.env: player mode, one GTO Wizard account, your CoinPoker name
#   7. services     scheduled tasks "PokerWrapper API / Charts / GTO Wizard - <user>" (:2000, :8777, GTO Wizard)
#   8. shortcut     "Poker Wrapper" on the desktop
#   9. check        setup\doctor.ps1
# What it cannot do for you (INSTALL.md walks through them): sign in to GTO Wizard, create your Ignition profile,
# install and sign in to CoinPoker.
param(
  [string]$DataZip = '',         # path to PokerWrapper-data-*.zip (default: look next to this folder)
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
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') +
              ";$env:LOCALAPPDATA\Microsoft\WinGet\Links"
}

Write-Host "Poker Wrapper setup — $root" -ForegroundColor White

# ---------------------------------------------------------------- 1. tools
Step 1 'Tools (Python 3.12, Bun, rclone, Chrome, Brave)'
$tools = @(
  @{ id = 'Python.Python.3.12'; test = { (& py -3.12 -c "print(1)" 2>$null) -eq '1' }; name = 'Python 3.12' },
  @{ id = 'Oven-sh.Bun';        test = { [bool](Get-Command bun -ErrorAction SilentlyContinue) }; name = 'Bun' },
  @{ id = 'Rclone.Rclone';      test = { [bool](Get-Command rclone -ErrorAction SilentlyContinue) }; name = 'rclone' },
  @{ id = 'Google.Chrome';      test = { (Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") -or (Test-Path "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") }; name = 'Google Chrome (GTO Wizard runs in it)' },
  @{ id = 'Brave.Brave';        test = { (Test-Path "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe") -or (Test-Path "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe") }; name = 'Brave (the Ignition table + the panel)' }
)
Refresh-Path
foreach ($t in $tools) {
  if (& $t.test) { Ok $t.name; continue }
  if ($SkipTools) { Bad "$($t.name) is not installed (skipped: -SkipTools)"; continue }
  Todo "installing $($t.name) ..."
  & winget install --id $t.id --exact --silent --accept-source-agreements --accept-package-agreements --scope user 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { & winget install --id $t.id --exact --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null }
  Refresh-Path
  if (& $t.test) { Ok "$($t.name) installed" } else { Bad "$($t.name) did not install — install it by hand (winget install $($t.id)) and run setup again" }
}

# ---------------------------------------------------------------- 2. chart + update downloads (R2)
Step 2 'Downloads: charts + updates (rclone remote "r2")'
$rclone = (Get-Command rclone -ErrorAction SilentlyContinue).Source
if (-not $rclone) { Bad 'rclone not found' }
else {
  $remotes = & $rclone listremotes 2>$null
  # a key FILE handed over with the zip (PokerWrapper-key.txt, rclone "key = value" lines) is used as-is: nothing
  # to paste. Looked for next to the PokerWrapper folder, inside it, and in Downloads.
  $keyFile = @((Join-Path (Split-Path $root) 'PokerWrapper-key.txt'), (Join-Path $root 'PokerWrapper-key.txt'),
               (Join-Path $env:USERPROFILE 'Downloads\PokerWrapper-key.txt')) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($remotes -match '^r2:$') { Ok 'remote r2 already configured' }
  elseif ($keyFile) {
    $kv = @(Get-Content $keyFile | Where-Object { $_ -match '^\s*([a-z_]+)\s*=\s*(\S.*)$' -and $Matches[1] -ne 'type' } |
            ForEach-Object { $null = $_ -match '^\s*([a-z_]+)\s*=\s*(\S.*)$'; "$($Matches[1])=$($Matches[2].Trim())" })
    & $rclone config create r2 s3 @kv --non-interactive | Out-Null
    Ok "download key read from $keyFile"
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
  if ((& $rclone listremotes 2>$null) -match '^r2:$') {
    $probe = & $rclone lsjson --stat 'r2:poker-solve-db/hrc-ui/hrc_hu_cp200a_d100_o2_5_3b9.json.gz' 2>&1   # one object: ~1 s
    # must come back a FILE: on R2 a key that cannot see the object can answer a phantom directory, exit 0
    if ($LASTEXITCODE -eq 0 -and (($probe -join '') -match '"IsDir":\s*false')) { Ok 'the chart bucket is readable' } else { Bad "cannot read r2:poker-solve-db/hrc-ui — check the key ($probe)" }
  }
}

# ---------------------------------------------------------------- 3. data
Step 3 'Data (6-max preflop DB, MES turn data)'
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
    & tar.exe -xf $DataZip -C (Split-Path $root)
    if ($LASTEXITCODE -eq 0 -and (Test-Path $sqlite)) { Ok 'data unpacked' } else { Bad "could not unpack $DataZip" }
  } else { Bad 'data not found — run setup again after step 2 is green, or put the data zip next to the PokerWrapper folder' }
}

# ---------------------------------------------------------------- 4. python
Step 4 'Python environment (aof-model\.venv)'
$venvPy = Join-Path $root 'aof-model\.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  Todo 'creating the venv ...'
  & py -3.12 -m venv (Join-Path $root 'aof-model\.venv')
}
if (Test-Path $venvPy) {
  & $venvPy -m pip install --disable-pip-version-check -q -r (Join-Path $root 'aof-model\requirements.txt')
  if ($LASTEXITCODE -eq 0) { Ok 'packages installed' } else { Bad 'pip install failed (see above)' }
} else { Bad 'the venv could not be created (is Python 3.12 installed?)' }

# ---------------------------------------------------------------- 5. api packages
Step 5 'Study API packages (bun install)'
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\bun.exe" }
if (Test-Path $bun) {
  Push-Location (Join-Path $root 'gto-trainer')
  try {
    & $bun install --frozen-lockfile 2>&1 | Select-Object -Last 2 | ForEach-Object { "    $_" }
    # prove every import resolves: a half-written bun cache entry installs "fine" and then the API cannot start
    # (seen 2026-09-22: zod@4.4.3 without its v4/ folder). On a miss, wipe the cache + node_modules and reinstall once.
    $probe = Join-Path $env:TEMP 'pokerwrapper-resolve-check.js'
    # the wrapper (apps\wrapper, a workspace of the same install) is probed the same way
    & $bun build apps\api\index.ts --target=bun --outfile $probe 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { & $bun build apps\wrapper\src\main.ts --target=bun --outfile $probe 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) {
      Todo 'a package came down incomplete; clearing the package cache and reinstalling ...'
      & $bun pm cache rm 2>&1 | Out-Null
      Remove-Item -Recurse -Force node_modules, apps\api\node_modules, apps\wrapper\node_modules -ErrorAction SilentlyContinue
      & $bun install --frozen-lockfile 2>&1 | Select-Object -Last 2 | ForEach-Object { "    $_" }
      & $bun build apps\api\index.ts --target=bun --outfile $probe 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { & $bun build apps\wrapper\src\main.ts --target=bun --outfile $probe 2>&1 | Out-Null }
    }
    $resolved = ($LASTEXITCODE -eq 0)
    Remove-Item $probe -ErrorAction SilentlyContinue
  } finally { Pop-Location }
  if ($resolved) { Ok 'installed (every import resolves)' } else { Bad 'bun install did not produce a working API (see above)' }
} else { Bad 'bun not found' }

# ---------------------------------------------------------------- 6. config
Step 6 'Settings (config\local.env)'
$local = Join-Path $root 'config\local.env'
if (-not (Test-Path $local)) { Copy-Item (Join-Path $root 'config\local.env.example') $local }
$cfg = Get-Content $local
function Set-Cfg($key, $value) {
  $script:cfg = @($script:cfg | Where-Object { $_ -notmatch "^\s*$key\s*=" }) + "$key=$value"
}
$has = { param($k) [bool]($cfg | Where-Object { $_ -match "^\s*$k\s*=\s*\S" }) }
Set-Cfg 'PLAYER_MODE' '1'          # this install: answers + your own sessions and hands; no solve fleet
Set-Cfg 'GTOW_SECONDARY' '0'       # one GTO Wizard account (the main one); heads-up solves use it too
# no CoinPoker name to ask for: the reader learns it from the client's own log (sites/cp_feed.py);
# CP_HERO in local.env still pins it if that ever guesses wrong
[IO.File]::WriteAllLines($local, [string[]]$cfg)   # no BOM: the wrapper and env.ps1 read it too
Ok "written: PLAYER_MODE=1, GTOW_SECONDARY=0$(if (& $has 'CP_HERO') { ', CP_HERO set' })"

# ---------------------------------------------------------------- 7. services
Step 7 'Services (study API, chart server, GTO Wizard watchdog)'
if ($SkipTasks) { Todo 'skipped (-SkipTasks)' }
else {
  # never re-point an existing install's services at this folder without asking
  $existing = Get-ScheduledTask -TaskName $TaskNames.api -ErrorAction SilentlyContinue
  $elsewhere = $existing -and ($existing.Actions.Arguments -notmatch [regex]::Escape($root))
  $go = $true
  if ($elsewhere) {
    Todo "this Windows user already runs a Poker Wrapper from ANOTHER folder: $($existing.Actions.Arguments)"
    $go = (Ask 'Replace it with this install? (y/N)' 'N') -match '^[yY]'
  }
  if ($go) {
    # open the GTO Wizard window VISIBLE first (a no-op when it is already up), so the sign-in page is in
    # front of them; the watchdog would otherwise start it minimised
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\start_gtow_chrome.ps1') -Foreground
    Todo 'a Chrome window opened on GTO Wizard: sign in there and leave it open (INSTALL.md step 3)'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install_tasks.ps1') -Start
    Ok 'registered and started (they start by themselves at every logon)'
  } else { Bad 'services not registered (kept the existing install)' }
}

# ---------------------------------------------------------------- 8. shortcut
Step 8 'Desktop shortcut'
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
if ($SkipShortcut) {
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

# ---------------------------------------------------------------- 9. check
Step 9 'Check'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'doctor.ps1')
Write-Host ""
if ($fail.Count) {
  Write-Host "Setup finished with $($fail.Count) problem(s) above — fix them and run setup again (it skips what is done)." -ForegroundColor Red
} else {
  Write-Host 'Setup finished. Next: INSTALL.md steps 3-5 (sign in to GTO Wizard, your poker accounts), then open "Poker Wrapper".' -ForegroundColor Green
}
