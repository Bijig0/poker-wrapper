# Which Australian Mullvad relay + anti-censorship mode gives GTO Wizard answers in time?
#
# Ignition only works through Australia (2026-09-22), and from this ISP the tunnel into Australia is the whole
# cost: Sydney + Shadowsocks read ~290 ms / 20-60% loss, Perth with obfuscation off 243 ms / 25% loss inside the
# tunnel alone, while Singapore (not usable for Ignition) read 23 ms / 0%. Different relays are hosted by
# different companies and reach Indonesia by different routes, so this tries one relay per hosting group.
#
# Stage 1: every relay below with anti-censorship OFF.
# Stage 2: the two best relays from stage 1 with every mode (shadowsocks, quic, udp2tcp, lwo, wireguard-port).
# Per combination: tunnel round trip + loss to the relay (20 pings to 10.64.0.1), netcheck.py (the same gate as
# the preflight), and the Ignition lobby's load time. Ends on the best combination that passes the gate, or
# puts back the settings it started with if none does.
#
# THE VPN RECONNECTS ~40 TIMES: do not run this while seated at a table. ~20-25 minutes.
# Run:  powershell -ExecutionPolicy Bypass -File C:\Users\Brady\poker\ignition-study-wrapper\vpn_sweep.ps1

$ErrorActionPreference = 'Continue'
$mv   = 'C:\Program Files\Mullvad VPN\resources\mullvad.exe'
$py   = 'C:\Users\Brady\poker\aof-model\.venv\Scripts\python.exe'
$nc   = 'C:\Users\Brady\poker\ignition-study-wrapper\netcheck.py'
$out  = Join-Path $PSScriptRoot ("debug\vpn_sweep_{0}.csv" -f (Get-Date -Format 'yyyyMMdd_HHmm'))

$relays = @(
  @('au','per','au-per-wg-301'), @('au','per','au-per-wg-302'),
  @('au','adl','au-adl-wg-301'), @('au','mel','au-mel-wg-401'), @('au','bne','au-bne-wg-301'),
  @('au','syd','au-syd-wg-001'), @('au','syd','au-syd-wg-101'), @('au','syd','au-syd-wg-301'), @('au','syd','au-syd-wg-303')
)
$modes = @('shadowsocks','quic','udp2tcp','lwo','wireguard-port')

# what to put back if nothing passes
$origStatus = (& $mv status -v) -join "`n"
$origMode   = ((& $mv anti-censorship get) | Select-Object -First 1) -replace '^mode:\s*',''
$origRelay  = if ($origStatus -match 'Relay:\s+(\S+)') { $Matches[1] } else { $null }

function Wait-Connected([int]$secs = 45) {
  $t = Get-Date
  Start-Sleep -Seconds 3
  while (((Get-Date) - $t).TotalSeconds -lt $secs) {
    $s = (& $mv status) | Select-Object -First 1
    if ($s -match '^Connected') { Start-Sleep -Seconds 2; return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Measure-Combo($r, $mode) {
  & $mv anti-censorship set mode $mode | Out-Null
  & $mv relay set location $r[0] $r[1] $r[2] | Out-Null
  & $mv reconnect | Out-Null
  $row = [ordered]@{ relay = $r[2]; mode = $mode; connected = $false; tunnelMs = $null; tunnelLost = $null;
                     pass = $false; rttMs = $null; lostOf10 = $null; warmMedMs = $null; warmMaxMs = $null;
                     ignitionS = $null; ignitionHttp = $null; why = '' }
  if (-not (Wait-Connected)) { $row.why = 'did not connect in 45 s'; return [pscustomobject]$row }
  $row.connected = $true
  $p = ping -n 20 -w 1000 10.64.0.1
  $recv = ($p | Select-String 'Received = (\d+)').Matches.Groups[1].Value
  $avg  = ($p | Select-String 'Average = (\d+)ms').Matches.Groups[1].Value
  $row.tunnelLost = 20 - [int]$recv
  if ($avg) { $row.tunnelMs = [int]$avg }
  try {
    $j = (& $py $nc) -join "`n" | ConvertFrom-Json
    $row.pass = [bool]$j.ok; $row.rttMs = $j.rttMs; $row.lostOf10 = $j.lostOf10
    $row.warmMedMs = $j.warmMedMs; $row.warmMaxMs = $j.warmMaxMs; $row.why = ($j.why -join '; ')
  } catch { $row.why = "netcheck failed: $_" }
  $ig = & curl.exe -s -o NUL -m 25 -A 'Mozilla/5.0' -w '%{http_code} %{time_total}' https://www.ignitioncasino.uno/poker-lobby
  $parts = "$ig".Split(' ')
  $row.ignitionHttp = $parts[0]; if ($parts.Count -gt 1) { $row.ignitionS = [math]::Round([double]$parts[1], 1) }
  return [pscustomobject]$row
}

function Show($row) {
  $flag = if ($row.pass) { 'PASS' } elseif (-not $row.connected) { '----' } else { 'fail' }
  '{0}  {1,-15} {2,-14} tunnel {3,4} ms lost {4,2}/20 | gtow rtt {5,4} lost {6}/10 warm {7,5}/{8,5} | ignition {9} {10}s  {11}' -f `
    $flag, $row.relay, $row.mode, $row.tunnelMs, $row.tunnelLost, $row.rttMs, $row.lostOf10, $row.warmMedMs, $row.warmMaxMs,
    $row.ignitionHttp, $row.ignitionS, $row.why
}

"Started with relay $origRelay, anti-censorship $origMode. Results -> $out"
$all = @()
"`n== stage 1: every relay, anti-censorship off"
foreach ($r in $relays) { $row = Measure-Combo $r 'off'; $all += $row; Show $row }

# rank: connected first, then fewest lost, then lowest tunnel round trip
$rank = { param($x) if (-not $x.connected) { 1e9 } else { [int]$x.tunnelLost * 1000 + [int]($x.tunnelMs) } }
$best2 = $all | Where-Object connected | Sort-Object { & $rank $_ } | Select-Object -First 2
"`n== stage 2: every mode on the two best relays ($(($best2.relay) -join ', '))"
foreach ($b in $best2) {
  $r = $relays | Where-Object { $_[2] -eq $b.relay } | Select-Object -First 1
  foreach ($m in $modes) { $row = Measure-Combo $r $m; $all += $row; Show $row }
}

$all | Export-Csv -NoTypeInformation -Path $out
$pass = $all | Where-Object { $_.pass -and $_.ignitionHttp -eq '200' } | Sort-Object { & $rank $_ } | Select-Object -First 1
if ($pass) {
  $r = $relays | Where-Object { $_[2] -eq $pass.relay } | Select-Object -First 1
  & $mv anti-censorship set mode $pass.mode | Out-Null
  & $mv relay set location $r[0] $r[1] $r[2] | Out-Null
  & $mv reconnect | Out-Null; Wait-Connected | Out-Null
  "`nBEST (left on): $($pass.relay) with anti-censorship $($pass.mode)"
  Show $pass
} else {
  & $mv anti-censorship set mode $origMode | Out-Null
  if ($origRelay) { $o = $origRelay.Split('-'); & $mv relay set location $o[0] $o[1] $origRelay | Out-Null }
  & $mv reconnect | Out-Null; Wait-Connected | Out-Null
  "`nNOTHING PASSED the gate - put back $origRelay / $origMode. Full table: $out"
}
