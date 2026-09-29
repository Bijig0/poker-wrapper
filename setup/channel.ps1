# The update channel, shared by setup.ps1, update.ps1, doctor.ps1 and fetch-data.ps1 (dot-source it after setting $root).
#
# Releases live on R2 (the same read-only key the chart server uses), published from the owner's machine by
# setup\buildPackage.ts --publish (--stage: everything but latest.json):
#   <channel>/latest.json                          the current release
#   <channel>/releases/<version>/release.json      every published version (kept, so -Version <v> rolls back)
#   <channel>/releases/<version>/PokerWrapper-code-<version>.zip
#   <channel>/data/PokerWrapper-data-<part>-<hash>.zip   big data parts, versioned by content
# What is installed: VERSION.json at the install root (code version + a sha256 per file + the data parts each STRATEGY
# needs) and config\installed-data.json (which version of each data part is unpacked).
#
# STRATEGY (2026-09-29): an install downloads only the data parts of the strategy it was set up for -
# INSTALL_STRATEGY in config\local.env (the installer's "What will you play?" page; blank = every part). The map is
# VERSION.json's `strategies` (buildPackage.ts), so a new strategy is a release, not a script change.
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

# what a data part leaves on disk - "installed" means this is here, whatever installed-data.json says (2026-09-29: a
# machine without tar.exe unpacked nothing and was stamped installed anyway)
$PartMarker = @{
  preflop6  = 'gto-trainer\apps\api\data\hrc6max-preflop.sqlite'
  mesturn   = 'gto-trainer\apps\api\data\mes_turn'
  nodetrust = 'gto-trainer\apps\api\data\limp_node_trust.json'
  runtime   = 'bin\bun.exe'
}

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

# the strategy this install was set up for (INSTALL_STRATEGY in config\local.env; '' = everything)
function Get-InstallStrategy([string]$Root) {
  if ($env:INSTALL_STRATEGY) { return $env:INSTALL_STRATEGY.Trim() }
  $f = Join-Path $Root 'config\local.env'
  if (Test-Path $f) {
    $m = Get-Content $f | Where-Object { $_ -match '^\s*INSTALL_STRATEGY\s*=\s*\S' } | Select-Object -First 1
    if ($m) { return ($m -replace '^\s*INSTALL_STRATEGY\s*=\s*', '').Trim().Trim('"') }
  }
  return ''
}

# the data parts this install needs: the strategy's list from VERSION.json, else every part the version names
function Get-WantedParts([string]$Root, $Installed) {
  if (-not $Installed -or -not $Installed.data) { return @() }
  $all = @($Installed.data.PSObject.Properties | ForEach-Object { $_.Name })
  $strategy = Get-InstallStrategy $Root
  if ($strategy -and $Installed.strategies -and $Installed.strategies.$strategy -and $Installed.strategies.$strategy.parts) {
    $want = @($Installed.strategies.$strategy.parts | Where-Object { $all -contains $_ })
    if ($all -contains 'runtime' -and $want -notcontains 'runtime') { $want += 'runtime' }
    return $want
  }
  return $all
}

function Get-InstalledData([string]$Root) {
  $h = @{}
  $f = Join-Path $Root 'config\installed-data.json'
  if (Test-Path $f) {
    try { (Get-Content $f -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $h[$_.Name] = $_.Value } } catch { }
  }
  # a data part carries its own stamp (config\parts\<part> = its version, buildPackage.ts, 2026-09-27), so a part that
  # arrived some other way - the installer ships the runtime part (bin\bun.exe, bin\rclone.exe) inside itself - counts
  # as installed without being downloaded again. The stamp wins: it is written by the very unpack that put the files there.
  $stamps = Join-Path $Root 'config\parts'
  if (Test-Path $stamps) {
    Get-ChildItem $stamps -File | ForEach-Object { $v = (Get-Content $_.FullName -Raw).Trim(); if ($v) { $h[$_.Name] = $v } }
  }
  # and a part whose files are gone is not installed, whatever was stamped
  foreach ($p in @($h.Keys)) { if ($PartMarker[$p] -and -not (Test-Path (Join-Path $Root $PartMarker[$p]))) { $h.Remove($p) } }
  return $h
}

function Set-InstalledData([string]$Root, [string]$Part, [string]$Ver) {
  $h = Get-InstalledData $Root
  $h[$Part] = $Ver
  $f = Join-Path $Root 'config\installed-data.json'
  [IO.File]::WriteAllText($f, ($h | ConvertTo-Json))
}

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() }

# UNPACK A PACKAGE ZIP (code or data part) into $Dest. Windows' own tar.exe (bsdtar, fast, ZIP64) when the machine has it
# - Windows 10 1803+ / Server 2019+ - else .NET's ZipArchive, streamed entry by entry (a 5.9 GB entry never sits in
# memory). Entries are "PokerWrapper/<path>"; -Strip drops that top folder so the files land in $Dest itself. Returns
# $true only when every entry landed. (Git's GNU tar, often first on PATH, cannot read a zip: never bare `tar`.)
function Expand-PackageZip([string]$Zip, [string]$Dest, [switch]$Strip) {
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    $args = @('-xf', $Zip, '-C', $Dest); if ($Strip) { $args += '--strip-components', '1' }
    & $tar @args 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-Host "    tar.exe failed (exit $LASTEXITCODE) - unpacking with .NET instead" -ForegroundColor DarkGray
  }
  try {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem -ErrorAction Stop
    $fs = [IO.File]::OpenRead($Zip)
    try {
      $za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Read)
      try {
        foreach ($e in $za.Entries) {
          $rel = $e.FullName -replace '/', '\'
          if ($Strip) { $i = $rel.IndexOf('\'); if ($i -lt 0) { continue }; $rel = $rel.Substring($i + 1) }
          if (-not $rel -or $rel.EndsWith('\')) { continue }
          $out = Join-Path $Dest $rel
          $dir = Split-Path $out -Parent
          if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
          [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $out, $true)
        }
      } finally { $za.Dispose() }
    } finally { $fs.Dispose() }
    return $true
  } catch {
    Write-Host "    unpack failed: $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}

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
  # the installer's window shows the transfer (a 3 GB first download with no movement looks hung); updates stay quiet
  # Out-Host: shown, never RETURNED (rclone prints progress on stdout; without it the caller got the lines + the path)
  if ($ShowDownloadProgress) { & $rc copyto $Remote $dst --progress --stats-one-line --stats 2s | Out-Host }
  else { & $rc copyto $Remote $dst --stats 0 2>&1 | Out-Null }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dst)) { return $null }
  if ($Sha256 -and (Get-Sha256 $dst) -ne $Sha256) { Remove-Item $dst -Force; return $null }
  return $dst
}

# make every data part this install needs present (Get-WantedParts: the strategy's, else all). The expected versions
# come from VERSION.json's "data" map; the file names and hashes from that version's release.json. A zip lying next to
# the installer or the install folder (handed over on a USB stick) is used before anything is downloaded.
# Returns @{ ok = $bool; did = @(parts installed); missing = @(parts that could not be); skipped = @(parts the strategy does not need) }
function Sync-DataParts([string]$Root) {
  $res = @{ ok = $true; did = @(); missing = @(); skipped = @() }
  $inst = Get-Installed $Root
  if (-not $inst -or -not $inst.data) { return $res }
  $want = Get-WantedParts $Root $inst
  $have = Get-InstalledData $Root
  $res.skipped = @($inst.data.PSObject.Properties | Where-Object { $want -notcontains $_.Name } | ForEach-Object { $_.Name })
  $need = @($inst.data.PSObject.Properties | Where-Object { ($want -contains $_.Name) -and ($have[$_.Name] -ne $_.Value) })
  if (-not $need.Count) { return $res }
  $rel = Get-Release $inst.version
  foreach ($p in $need) {
    $part = $p.Name; $ver = $p.Value
    $name = "PokerWrapper-data-$part-$ver.zip"
    $info = if ($rel -and $rel.data) { $rel.data.$part } else { $null }
    # next to the installer (INSTALL_DATA_DIR: setup.ps1 -DataDir, the folder PokerWrapperSetup.exe ran from - a USB stick,
    # C:\Users\Public\PokerWrapper), next to the install folder, inside it; only then the channel
    $dirs = @($env:INSTALL_DATA_DIR, (Split-Path $Root), $Root) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $zip = @($dirs | ForEach-Object { Join-Path $_ $name }) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($zip -and $info -and $info.sha256 -and (Get-Sha256 $zip) -ne $info.sha256) { $zip = $null }
    if (-not $zip -and $info) { $zip = Get-ChannelFile "$Channel/data/$name" $name $info.sha256 $info.bytes }
    if (-not $zip) { $res.ok = $false; $res.missing += $part; continue }
    Write-Host "    unpacking $part ..." -ForegroundColor DarkGray
    # entries are PokerWrapper/<path>: unpacked INTO the install, whatever it is called
    $ok = Expand-PackageZip $zip $Root -Strip
    # installed = the part's files are here AND the zip's own version stamp landed (config\parts\<part>)
    $stamp = Join-Path $Root "config\parts\$part"
    $landed = $ok -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $ver) -and (-not $PartMarker[$part] -or (Test-Path (Join-Path $Root $PartMarker[$part])))
    if ($landed) {
      Set-InstalledData $Root $part $ver; $res.did += $part
      # a downloaded part is unpacked now: its zip (up to 3 GB) is dead weight in the download cache
      if ($zip.StartsWith($Downloads)) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
    }
    else { Write-Host "    $part did NOT unpack (the zip is kept: $zip)" -ForegroundColor Red; $res.ok = $false; $res.missing += $part }
  }
  return $res
}
