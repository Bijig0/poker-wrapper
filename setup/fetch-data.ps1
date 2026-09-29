# The big read-only data a SOURCE CHECKOUT of this repo needs, from the update channel: the 6-max preflop DB, the MES
# turn files, the node-trust table (the data parts: gitignored, too big for git). An installed copy never needs this -
# its setup fetches the parts its version expects. On the chart factory's own machine the factory's export
# (poker: bun scripts/export_to_wrapper.ts) puts them here instead, fresher than the last release.
#
#   powershell -ExecutionPolicy Bypass -File setup\fetch-data.ps1 [-Force]
#
# Needs a working rclone remote "r2" (the download key). A part already here is skipped unless -Force; the runtime part
# (bin\bun.exe, bin\rclone.exe) is an installed copy's and is skipped.
param([switch]$Force)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'channel.ps1')
$ShowDownloadProgress = $true

$rel = Get-Release
if (-not $rel) { Write-Host "cannot read the update channel ($Channel) - is the rclone remote r2 set up?" -ForegroundColor Red; exit 1 }
$data = Join-Path $root 'gto-trainer\apps\api\data'
# what marks each part as present in a checkout
$marker = @{ preflop6 = 'hrc6max-preflop.sqlite'; mesturn = 'mes_turn'; nodetrust = 'limp_node_trust.json' }
$bad = 0
foreach ($p in $rel.data.PSObject.Properties) {
  $part = $p.Name; $info = $p.Value
  if (-not $marker.ContainsKey($part)) { continue }
  if (-not $Force -and (Test-Path (Join-Path $data $marker[$part]))) { Write-Host "  $part : already here (-Force to replace)"; continue }
  $zip = Get-ChannelFile "$Channel/data/$($info.file)" $info.file $info.sha256 $info.bytes
  if (-not $zip) { Write-Host "  $part : download failed" -ForegroundColor Red; $bad++; continue }
  if (Expand-PackageZip $zip $root -Strip) { Write-Host "  $part : $($info.version) unpacked" -ForegroundColor Green; Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
  else { Write-Host "  $part : could not unpack $zip" -ForegroundColor Red; $bad++ }
}
exit $bad
