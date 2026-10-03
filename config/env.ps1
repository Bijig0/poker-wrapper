# One place that says where everything is (2026-09-22 cleanup).
#
# Every launcher used to hard-code one machine: the checkout's path, the node-v24.18.0 ZIP install's bun.exe, the
# NL25 exploit/pool files. This resolves the same things from WHERE THE CHECKOUT (or installed copy) IS plus what is
# installed, and lets config\local.env (machine-local, untracked; template = local.env.example) override any of them.
#
#   . "$PSScriptRoot\..\config\env.ps1"            # PowerShell launchers: dot-source it
#   config\env.ps1 -EmitCmd                          # cmd launchers: prints `set "K=V"` lines to eval
#
# After it runs: $env:POKER_ROOT, $env:BUN, $env:EXPLOIT_CHART, $env:POOL_MODEL (when the files exist),
# $env:HRC_UI_DOC_CACHE_MAX, $env:RCLONE_CONFIG (an installed copy's key), and a PATH that has bun, rclone and Git on it.
# No Python anywhere: the wrapper, the API and the chart server are all TypeScript.
param([switch]$EmitCmd)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:POKER_ROOT = $root

# 1. config\local.env: KEY=VALUE lines; blank values and #-comments are ignored; a value already in the
#    environment wins (so a caller can still override one launch).
$local = Join-Path $PSScriptRoot 'local.env'
# every key local.env sets: -EmitCmd hands ALL of them on, not a fixed list (2026-09-25 audit: TRUST_GUARD_ALL and
# GTOW_POLL_MS reached the API only when study-api.ps1 started it, never from dev-api.cmd)
$localKeys = @()
if (Test-Path $local) {
  foreach ($line in Get-Content $local) {
    $l = ($line -replace '\s+#.*$', '').Trim()
    if (-not $l -or $l.StartsWith('#') -or $l -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
    $k = $Matches[1]; $v = $Matches[2].Trim().Trim('"')
    if ($v -and -not [Environment]::GetEnvironmentVariable($k, 'Process')) { Set-Item "env:$k" $v }
    if ($v) { $localKeys += $k }
  }
}

# 1b. PORTS: one setting moves them all. PORT_OFFSET (local.env, default 0) is added to every default; the six explicit
#     names still win for one launch (PORT=2001 for a verify API). The TypeScript twin is gto-trainer\apps\api\src\
#     services\ports.ts — keep the two tables identical. Why: ports are machine-wide, so a second Windows account's
#     install beside this one needs its own set (setup\setup.ps1 picks the offset; 2026-09-30).
$portOffset = 0
if ($env:PORT_OFFSET -match '^\d+$') { $portOffset = [int]$env:PORT_OFFSET }
$portDefaults = [ordered]@{ PORT = 2000; HRC_UI_PORT = 8777; PANEL_PORT = 7700; GTOW_CDP_PORT = 9222; GTOW_SECONDARY_CDP_PORT = 9223; CDP_PORT = 9333 }
foreach ($k in $portDefaults.Keys) {
  if (-not [Environment]::GetEnvironmentVariable($k, 'Process')) { Set-Item "env:$k" ([string]($portDefaults[$k] + $portOffset)) }
}

function First-Existing([string[]]$paths) { foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return (Resolve-Path $p).Path } }; return $null }
function Newest-Match([string]$pattern) {
  $hit = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
  if ($hit) { return $hit.FullName } else { return $null }
}

# 2. Bun: config / the installer's own copy (bin\, 2026-09-27) / PATH / the ZIP-installed Node's bundled bun / npm
#    global / bun's own installer
$binDir = Join-Path $root 'bin'
if (-not $env:BUN) {
  $onPath = (Get-Command bun.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  $env:BUN = First-Existing @(
    "$binDir\bun.exe",
    $onPath,
    (Newest-Match "$env:LOCALAPPDATA\Programs\node-v*\node_modules\bun\bin\bun.exe"),
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\bun.exe",
    "$env:APPDATA\npm\node_modules\bun\bin\bun.exe",
    "$env:USERPROFILE\.bun\bin\bun.exe")
}
# 3. the pool files the API arms at start (see .claude\study-api.ps1 for why they matter) — the chart factory's
#    exports, kept in gto-trainer\apps\api\data\pool (services/repoPaths.ts POOL_DIR)
$pool = Join-Path $root 'gto-trainer\apps\api\data\pool'
if (-not $env:EXPLOIT_CHART) { $env:EXPLOIT_CHART = First-Existing @("$pool\exploit_ranges_nl25.json") }
if (-not $env:POOL_MODEL)    { $env:POOL_MODEL    = First-Existing @("$pool\pool_model_nl25.json") }
if (-not $env:HRC_UI_DOC_CACHE_MAX) { $env:HRC_UI_DOC_CACHE_MAX = '6' }
# the download key of an INSTALLED copy lives with it (config\rclone.conf, written by the installer), never in the
# Windows user's own rclone config — so it goes when the app is uninstalled and never touches anyone else's "r2"
if (-not $env:RCLONE_CONFIG -and (Test-Path (Join-Path $PSScriptRoot 'rclone.conf'))) { $env:RCLONE_CONFIG = Join-Path $PSScriptRoot 'rclone.conf' }

# 4. PATH: a scheduled task starts with almost nothing on it, and the API's and chart server's children (rclone,
#    git for the build stamp) resolve their tools from the worker's PATH
$nodeDir = if ($env:NODE_DIR) { $env:NODE_DIR } else { Newest-Match "$env:LOCALAPPDATA\Programs\node-v*-win-x64" }
$gitDir = if ($env:GIT_DIR_WIN) { $env:GIT_DIR_WIN } else { First-Existing @("$env:ProgramFiles\Git", "$env:LOCALAPPDATA\Programs\Git") }
$extra = @(
  $binDir,   # the installer's bun.exe + rclone.exe (the chart server calls bare rclone)
  $(if ($env:BUN) { Split-Path $env:BUN }), "$env:APPDATA\npm", $nodeDir,
  $(if ($gitDir) { "$gitDir\cmd" }), $(if ($gitDir) { "$gitDir\usr\bin" }), $(if ($gitDir) { "$gitDir\bin" }),
  "$env:SystemRoot\System32\OpenSSH",
  "$env:LOCALAPPDATA\Microsoft\WinGet\Links"   # winget's bun.exe / rclone.exe shims (the chart server calls bare rclone)
) | Where-Object { $_ -and (Test-Path $_) }
$have = $env:Path -split ';'
$env:Path = ((@($extra | Where-Object { $have -notcontains $_ }) + $have) | Where-Object { $_ }) -join ';'

# 5. THE START STAMP (2026-10-03): a supervisor reads its own script, this file and local.env ONCE, at start, so a fix
#    to any of them needs the SUPERVISOR restarted, not its worker - and nothing said so. Each supervisor calls this
#    when it starts; the API compares the hashes with the files on disk (services/liveStatus.ts) and the dashboard
#    banner, the wrapper's setup page and `bun setup\live.ts` say when one is behind.
function Write-SupervisorStamp([string]$Name, [string[]]$Files) {
  try {
    $dir = Join-Path $env:POKER_ROOT 'gto-trainer\apps\api\data\jobs'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $all = @($Files) + @((Join-Path $env:POKER_ROOT 'config\env.ps1'), (Join-Path $env:POKER_ROOT 'config\local.env'))
    $hashes = [ordered]@{}
    foreach ($f in $all) {
      if ($f -and (Test-Path -LiteralPath $f)) {
        $p = (Resolve-Path -LiteralPath $f).Path
        $hashes[$p] = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()
      }
    }
    $stamp = [ordered]@{ name = $Name; pid = $PID; startedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'); files = $hashes }
    # WriteAllText = UTF-8 without a BOM (Out-File in PowerShell 5.1 would add one)
    [IO.File]::WriteAllText((Join-Path $dir "supervisor-$Name.json"), ($stamp | ConvertTo-Json -Depth 4))
  } catch { }
}

if ($EmitCmd) {
  foreach ($k in (@('POKER_ROOT', 'BUN', 'EXPLOIT_CHART', 'POOL_MODEL', 'HRC_UI_DOC_CACHE_MAX', 'CP_HERO', 'POKER_DATA_DIR', 'RCLONE_CONFIG', 'Path') + @($portDefaults.Keys) + $localKeys | Select-Object -Unique)) {
    $v = [Environment]::GetEnvironmentVariable($k, 'Process')
    if ($v) { "set `"$k=$v`"" }
  }
}
