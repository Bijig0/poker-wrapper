# One place that says where everything is (2026-09-22 cleanup).
#
# Every launcher used to hard-code this machine: C:\Users\Brady\poker, the node-v24.18.0 ZIP install's bun.exe,
# Python312, the aof-model venv, the NL25 exploit/pool files. This resolves the same things from WHERE THE REPO
# IS plus what is installed, and lets config\local.env (machine-local, untracked; template = local.env.example)
# override any of them.
#
#   . "$PSScriptRoot\..\config\env.ps1"            # PowerShell launchers: dot-source it
#   config\env.ps1 -EmitCmd                          # cmd launchers: prints `set "K=V"` lines to eval
#
# After it runs: $env:POKER_ROOT, $env:BUN, $env:PYTHON, $env:EXPLOIT_CHART, $env:POOL_MODEL (when the files
# exist), $env:HRC_UI_DOC_CACHE_MAX, and a PATH that has bun, node, Python and Git on it.
param([switch]$EmitCmd)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:POKER_ROOT = $root

# 1. config\local.env: KEY=VALUE lines; blank values and #-comments are ignored; a value already in the
#    environment wins (so a caller can still override one launch).
$local = Join-Path $PSScriptRoot 'local.env'
if (Test-Path $local) {
  foreach ($line in Get-Content $local) {
    $l = ($line -replace '\s+#.*$', '').Trim()
    if (-not $l -or $l.StartsWith('#') -or $l -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
    $k = $Matches[1]; $v = $Matches[2].Trim().Trim('"')
    if ($v -and -not [Environment]::GetEnvironmentVariable($k, 'Process')) { Set-Item "env:$k" $v }
  }
}

function First-Existing([string[]]$paths) { foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return (Resolve-Path $p).Path } }; return $null }
function Newest-Match([string]$pattern) {
  $hit = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
  if ($hit) { return $hit.FullName } else { return $null }
}

# 2. Bun: config / PATH / the ZIP-installed Node's bundled bun / npm global / bun's own installer
if (-not $env:BUN) {
  $onPath = (Get-Command bun.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  $env:BUN = First-Existing @(
    $onPath,
    (Newest-Match "$env:LOCALAPPDATA\Programs\node-v*\node_modules\bun\bin\bun.exe"),
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\bun.exe",
    "$env:APPDATA\npm\node_modules\bun\bin\bun.exe",
    "$env:USERPROFILE\.bun\bin\bun.exe")
}
# 3. Python: the repo's venv (the chart server runs in it; the Poker Wrapper is TypeScript since 2026-09-24)
if (-not $env:PYTHON) { $env:PYTHON = First-Existing @("$root\aof-model\.venv\Scripts\python.exe") }
# 4. the data files the API arms at start (see .claude\study-api.ps1 for why they matter)
if (-not $env:EXPLOIT_CHART) { $env:EXPLOIT_CHART = First-Existing @("$root\analysis\pipeline\limp_study\exploit_ranges_nl25.json") }
if (-not $env:POOL_MODEL)    { $env:POOL_MODEL    = First-Existing @("$root\analysis\pipeline\limp_study\pool_model_nl25.json") }
if (-not $env:HRC_UI_DOC_CACHE_MAX) { $env:HRC_UI_DOC_CACHE_MAX = '6' }

# 5. PATH: a scheduled task starts with almost nothing on it, and the API's children (box relays, the
#    converter's python, unzip, ssh, rclone) resolve their tools from the worker's PATH
$nodeDir = if ($env:NODE_DIR) { $env:NODE_DIR } else { Newest-Match "$env:LOCALAPPDATA\Programs\node-v*-win-x64" }
$pyHome = $null
if ($env:PYTHON) {
  $cfg = Join-Path (Split-Path (Split-Path $env:PYTHON)) 'pyvenv.cfg'
  if (Test-Path $cfg) { $pyHome = ((Get-Content $cfg | Where-Object { $_ -match '^home\s*=' }) -replace '^home\s*=\s*', '').Trim() }
}
$gitDir = if ($env:GIT_DIR_WIN) { $env:GIT_DIR_WIN } else { First-Existing @("$env:ProgramFiles\Git", "$env:LOCALAPPDATA\Programs\Git") }
$extra = @(
  $(if ($env:BUN) { Split-Path $env:BUN }), "$env:APPDATA\npm", $nodeDir,
  $pyHome, $(if ($pyHome) { Join-Path $pyHome 'Scripts' }),
  $(if ($gitDir) { "$gitDir\cmd" }), $(if ($gitDir) { "$gitDir\usr\bin" }), $(if ($gitDir) { "$gitDir\bin" }),
  "$env:SystemRoot\System32\OpenSSH",
  "$env:LOCALAPPDATA\Microsoft\WinGet\Links"   # winget's bun.exe / rclone.exe shims (the chart server calls bare rclone)
) | Where-Object { $_ -and (Test-Path $_) }
$have = $env:Path -split ';'
$env:Path = ((@($extra | Where-Object { $have -notcontains $_ }) + $have) | Where-Object { $_ }) -join ';'

if ($EmitCmd) {
  foreach ($k in 'POKER_ROOT', 'BUN', 'PYTHON', 'EXPLOIT_CHART', 'POOL_MODEL', 'HRC_UI_DOC_CACHE_MAX', 'CP_HERO', 'Path') {
    $v = [Environment]::GetEnvironmentVariable($k, 'Process')
    if ($v) { "set `"$k=$v`"" }
  }
}
