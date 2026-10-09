# Drives scripts\supervisor_lib.ps1 the way a supervisor does, against a FAKE checkout (-Root: a copy of config\env.ps1,
# a local.env, a stand-in supervisor script), and ends with the self-replace in -DryRun: the helper only says what it
# would do. Run by supervisorLib.test.ts; never touches a live supervisor, task or port. Prints KEY=value lines.
param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Lib)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SupBaseEnv = [Environment]::GetEnvironmentVariables('Process')
. (Join-Path $Root 'config\env.ps1')
. $Lib
$log = Join-Path $Root 'sup.log'
$jobs = Join-Path $Root 'gto-trainer\apps\api\data\jobs'
$local = Join-Path $Root 'config\local.env'
$fake = Join-Path $Root 'fake-supervisor.ps1'
$req = Join-Path $jobs 'supervisor-api.replace.json'
function Ask { Set-Content -LiteralPath $req -Value ('{"supervisorPid": ' + $PID + ', "why": "study-api.ps1 changed", "by": "test"}') }

Start-SupervisorState -Name 'api' -BaseEnv $SupBaseEnv -CodeFiles @($fake) -Reread -PortVars @('PORT') -LogFile $log -Keep @{ POKER_SUPERVISOR = "$PID" }
"A1=$env:GTOW_POLL_MS|$env:PORT|$($env:POKER_SUPERVISOR -eq "$PID")"

# local.env edited: the next start reads it, although env.ps1 lets a value already in the environment win
Set-Content -LiteralPath $local -Value 'GTOW_POLL_MS=900'
Update-SupervisorConfig
"A2=$env:GTOW_POLL_MS|$env:PORT|$($env:POKER_SUPERVISOR -eq "$PID")"
Copy-Item (Join-Path $jobs 'supervisor-api.json') (Join-Path $Root 'stamp-after-env.json')

# the port moves: refused, the old environment kept, the stamp says needsReplace
Set-Content -LiteralPath $local -Value "GTOW_POLL_MS=901`r`nPORT_OFFSET=10"
Update-SupervisorConfig
"A3=$env:GTOW_POLL_MS|$env:PORT"
Copy-Item (Join-Path $jobs 'supervisor-api.json') (Join-Path $Root 'stamp-after-port.json')

# a request in this supervisor's first 2 minutes is refused (loop guard)
Ask
"R1=$([bool](Get-SupervisorReplaceRequest -ExitCode 3))|$(Test-Path $req)"
$SupervisorState.StartedAt = (Get-Date).AddMinutes(-10)
# exit 3 with no request file: a plain relaunch
"R2=$([bool](Get-SupervisorReplaceRequest -ExitCode 3))"
# a script that would not parse: refused, recorded in the stamp
Set-Content -LiteralPath $fake -Value 'function {'
Ask
"R3=$([bool](Get-SupervisorReplaceRequest -ExitCode 3))"
Copy-Item (Join-Path $jobs 'supervisor-api.json') (Join-Path $Root 'stamp-refused.json')
Set-Content -LiteralPath $fake -Value '# fixed'

# taken, and the self-replace in dry run
Ask
$r = Get-SupervisorReplaceRequest -ExitCode 3
"R4=$($r.why)|$(Test-Path $req)"
$h = Invoke-SupervisorReplace -Request $r -DryRun
$null = $h.Handle
$null = $h.WaitForExit(90000)
"H=$($h.ExitCode)"
"A4=$env:GTOW_POLL_MS|$([bool]$env:POKER_SUPERVISOR_REPLACED)"
