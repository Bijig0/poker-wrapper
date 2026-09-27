# The update channel, shared by setup.ps1, update.ps1 and doctor.ps1 (dot-source it after setting $root).
#
# Releases live on R2 (the same read-only key the chart server uses), published from the owner's machine by
# setup\buildPackage.ts --publish:
#   <channel>/latest.json                          the current release
#   <channel>/releases/<version>/release.json      every published version (kept, so -Version <v> rolls back)
#   <channel>/releases/<version>/PokerWrapper-code-<version>.zip
#   <channel>/data/PokerWrapper-data-<part>-<hash>.zip   big data parts, versioned by content
# What is installed: VERSION.json at the install root (code version + a sha256 per file) and
# config\installed-data.json (which version of each data part is unpacked).
if (-not $env:PW_CHANNEL -and $root -and (Test-Path (Join-Path $root 'config\local.env'))) {
  # the same override the wrapper sees (the wrapper loads config\local.env at start)
  $m = Get-Content (Join-Path $root 'config\local.env') | Where-Object { $_ -match '^\s*PW_CHANNEL\s*=\s*\S' } | Select-Object -First 1
  if ($m) { $env:PW_CHANNEL = ($m -replace '^\s*PW_CHANNEL\s*=\s*', '').Trim().Trim('"') }
}
$Channel = if ($env:PW_CHANNEL) { $env:PW_CHANNEL } else { 'r2:poker-solve-db/wrapper' }
# an INSTALLED copy (PokerWrapperSetup.exe, 2026-09-27) keeps its download key in config\rclone.conf and its own
# rclone in bin\ (config\env.ps1 says the same to every launcher); a zip install / the source checkout uses the Windows
# user's rclone config and whatever rclone is on PATH
if ($root -and -not $env:RCLONE_CONFIG -and (Test-Path (Join-Path $root 'config\rclone.conf'))) { $env:RCLONE_CONFIG = Join-Path $root 'config\rclone.conf' }
$Downloads = Join-Path $env:LOCALAPPDATA 'PokerWrapper\downloads'

# THE PACKAGE'S SCHEDULED TASKS (2026-09-23). Task names are MACHINE-wide, so they carry the Windows user: a second
# account on the same laptop (a test account, a brother) gets its own three, and none of them can replace the
# owner's dev tasks (StudyAPI / ChartServer / GtowWatchdog, registered from the source checkout).
$TaskNames = [ordered]@{
  api    = "PokerWrapper API - $env:USERNAME"
  charts = "PokerWrapper Charts - $env:USERNAME"
  gtow   = "PokerWrapper GTO Wizard - $env:USERNAME"
}
# names releases before 2026.09.23 used; install_tasks removes them ONLY when they point at this install's folder
$LegacyTaskNames = @('StudyAPI', 'ChartServer', 'GtowWatchdog')

function Find-Rclone {
  if ($root -and (Test-Path (Join-Path $root 'bin\rclone.exe'))) { return (Join-Path $root 'bin\rclone.exe') }
  $c = (Get-Command rclone -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $c -and (Test-Path "$env:LOCALAPPDATA\Microsoft\WinGet\Links\rclone.exe")) { $c = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\rclone.exe" }
  return $c
}

# a release from the channel: the latest, or a named version. $null when the channel cannot be read.
function Get-Release([string]$Version = '') {
  $rc = Find-Rclone
  if (-not $rc) { return $null }
  $src = if ($Version) { "$Channel/releases/$Version/release.json" } else { "$Channel/latest.json" }
  $txt = & $rc cat $src 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $txt) { return $null }
  try { return (($txt -join "`n") | ConvertFrom-Json) } catch { return $null }
}

function Get-Installed([string]$Root) {
  $v = Join-Path $Root 'VERSION.json'
  if (Test-Path $v) { try { return (Get-Content $v -Raw | ConvertFrom-Json) } catch { } }
  return $null
}

function Get-InstalledData([string]$Root) {
  $h = @{}
  $f = Join-Path $Root 'config\installed-data.json'
  if (Test-Path $f) {
    try { (Get-Content $f -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $h[$_.Name] = $_.Value } } catch { }
  }
  # a data part carries its own stamp (config\parts\<part> = its version, buildPackage.ts, 2026-09-27), so a part that
  # arrived some other way — the installer ships the runtime part (bin\bun.exe, bin\rclone.exe) inside itself — counts
  # as installed without being downloaded again. The stamp wins: it is written by the very unpack that put the files there.
  $stamps = Join-Path $Root 'config\parts'
  if (Test-Path $stamps) {
    Get-ChildItem $stamps -File | ForEach-Object { $v = (Get-Content $_.FullName -Raw).Trim(); if ($v) { $h[$_.Name] = $v } }
  }
  return $h
}

function Set-InstalledData([string]$Root, [string]$Part, [string]$Ver) {
  $h = Get-InstalledData $Root
  $h[$Part] = $Ver
  $f = Join-Path $Root 'config\installed-data.json'
  [IO.File]::WriteAllText($f, ($h | ConvertTo-Json))
}

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() }

# a channel file into the download cache, verified. A cached copy with the right hash is reused (so a
# second run, or a rollback, does not download again). Returns the local path or $null.
function Get-ChannelFile([string]$Remote, [string]$Name, [string]$Sha256, [long]$Bytes = 0) {
  New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
  $dst = Join-Path $Downloads $Name
  if ((Test-Path $dst) -and (-not $Sha256 -or (Get-Sha256 $dst) -eq $Sha256)) { return $dst }
  $rc = Find-Rclone
  if (-not $rc) { return $null }
  $mb = if ($Bytes) { " ($([math]::Round($Bytes / 1MB)) MB)" } else { '' }
  Write-Host "    downloading $Name$mb ..." -ForegroundColor DarkGray
  # the installer's window shows the transfer (a 2 GB first download with no movement looks hung); updates stay quiet
  if ($ShowDownloadProgress) { & $rc copyto $Remote $dst --progress --stats-one-line --stats 2s }
  else { & $rc copyto $Remote $dst --stats 0 2>&1 | Out-Null }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dst)) { return $null }
  if ($Sha256 -and (Get-Sha256 $dst) -ne $Sha256) { Remove-Item $dst -Force; return $null }
  return $dst
}

# make every data part the installed code expects present. The expected versions come from VERSION.json's
# "data" map; the file names and hashes from that version's release.json. A zip lying next to the install
# folder (handed over on a USB stick) is used before anything is downloaded.
# Returns @{ ok = $bool; did = @(parts installed); missing = @(parts that could not be) }
function Sync-DataParts([string]$Root) {
  $res = @{ ok = $true; did = @(); missing = @() }
  $inst = Get-Installed $Root
  if (-not $inst -or -not $inst.data) { return $res }
  $have = Get-InstalledData $Root
  $need = @($inst.data.PSObject.Properties | Where-Object { $have[$_.Name] -ne $_.Value })
  if (-not $need.Count) { return $res }
  $rel = Get-Release $inst.version
  foreach ($p in $need) {
    $part = $p.Name; $ver = $p.Value
    $name = "PokerWrapper-data-$part-$ver.zip"
    $info = if ($rel -and $rel.data) { $rel.data.$part } else { $null }
    $zip = @((Join-Path (Split-Path $Root) $name), (Join-Path $Root $name)) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($zip -and $info -and $info.sha256 -and (Get-Sha256 $zip) -ne $info.sha256) { $zip = $null }
    if (-not $zip -and $info) { $zip = Get-ChannelFile "$Channel/data/$name" $name $info.sha256 $info.bytes }
    if (-not $zip) { $res.ok = $false; $res.missing += $part; continue }
    Write-Host "    unpacking $part ..." -ForegroundColor DarkGray
    # entries are PokerWrapper/<path>: strip that top folder and unpack INTO the install, whatever it is called
    # (the installer's folder is ...\Programs\PokerWrapper, a zip install's is wherever it was extracted)
    & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $Root --strip-components 1   # Windows' bsdtar: Git's GNU tar cannot read a zip
    if ($LASTEXITCODE -eq 0) {
      Set-InstalledData $Root $part $ver; $res.did += $part
      # a downloaded part is unpacked now: its zip (up to 3 GB) is dead weight in the download cache
      if ($zip.StartsWith($Downloads)) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
    }
    else { $res.ok = $false; $res.missing += $part }
  }
  return $res
}
