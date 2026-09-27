# Publish a Poker Wrapper update to your friends — OWNER side (this repo). Double-click setup\publish.cmd, the
# "Publish Poker Wrapper update" desktop shortcut, or press "Publish" on the setup page's friend-release bar.
#
# 1. shows what is published and what changed since (setup\buildPackage.ts --status)
# 2. asks for a line of notes (friends see it on their "Update available" bar)
# 3. buildPackage.ts --publish: the regression gate first (refuses on red), then the release + the Windows installer
#    (PokerWrapperSetup-<version>.exe, Inno Setup), upload, move latest.json
# Their Poker Wrapper sees it within 30 minutes (or at once on its setup page); they press "Update now".
param([string]$Notes = '', [switch]$SkipGate)
$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# the packager and its gate are TypeScript (2026-09-24); config\env.ps1 finds the Bun the launchers run
. (Join-Path $root 'config\env.ps1')
$bun = $env:BUN
$bp = Join-Path $root 'setup\buildPackage.ts'
function Done([int]$c) { Write-Host ''; Read-Host '  Press Enter to close' | Out-Null; exit $c }

Write-Host 'Poker Wrapper — publish an update' -ForegroundColor White
if (-not (Test-Path (Join-Path $root '.git'))) { Write-Host '  this is an installed copy, not the source checkout - nothing to publish from here' -ForegroundColor Red; Done 1 }
Write-Host ''
& $bun $bp --status
Write-Host ''
if (-not $Notes) { $Notes = Read-Host '  What changed? One line your friends will see (blank = cancel)' }
if (-not $Notes) { Write-Host '  cancelled' -ForegroundColor Yellow; Done 0 }
Write-Host ''
Write-Host '  running the regression gate, then building and uploading (a few minutes; data parts only if they changed) ...' -ForegroundColor Cyan
$pargs = @($bp, '--publish', '--notes', $Notes)
if ($SkipGate) { $pargs += '--skip-gate' }
& $bun @pargs
if ($LASTEXITCODE -eq 0) { Write-Host ''; Write-Host '  published - your friends get the "Update available" bar.' -ForegroundColor Green; Done 0 }
Write-Host ''
Write-Host '  NOT published (see above). Fix the red check and run this again.' -ForegroundColor Red
Done 1
