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

if ($EmitCmd) {
  foreach ($k in (@('POKER_ROOT', 'BUN', 'EXPLOIT_CHART', 'POOL_MODEL', 'HRC_UI_DOC_CACHE_MAX', 'CP_HERO', 'POKER_DATA_DIR', 'RCLONE_CONFIG', 'Path') + $localKeys | Select-Object -Unique)) {
    $v = [Environment]::GetEnvironmentVariable($k, 'Process')
    if ($v) { "set `"$k=$v`"" }
  }
}
