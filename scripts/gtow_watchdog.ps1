# GTO Wizard watchdog: keep EVERY account's client drivable, permanently.
#
# The failure it exists for, observed six times in one week: GTO Wizard's updater relaunches the app WITHOUT
# --remote-debugging-port, silently dropping CDP. Every "GTOW died" and every "No access token" batch failure was this.
# The updater also parks a modal update dialog that blocks the app from loading until dismissed. Nothing else
# auto-starts these clients, so before this ran as a scheduled task a reboot left GTO Wizard AI dead until someone
# noticed.
#
# WHICH ACCOUNTS (2026-09-29): the account registry — gtow-accounts.json in the data root, the dashboard's GTO Wizard
# tab edits it — one row per account: its DevTools port (cdpHost) and how its client is run (client chrome = a Chrome
# profile of its own, or a launcher script `launchHint` under scripts/; the desktop-app client was removed 2026-10-13). The rule is
# services/gtowAccounts.ts launchPlan, the same one the tab's Connect button follows; this script mirrors it. The
# registry is RE-READ EVERY MINUTE: an account added on the tab is watched within a minute, one removed or disabled is
# dropped, and no restart of this task is needed. Accounts are watched independently: one being down must never restart
# another. (No registry file yet = the primary alone, a Chrome profile on 9222, the way the first install starts.)
#
# THE RULE THAT MATTERS: a client sitting on its ACTIVATION or LOGIN screen is waiting for a human, and restarting it
# cannot help — it would just throw away whatever is half-typed, every 60 seconds, forever. Those are reported and left
# alone. Only a client that is unreachable, or reachable with no app page and no human gate, gets restarted.
#
# Run headless:  powershell -WindowStyle Hidden -File gtow_watchdog.ps1
# Install as a logon task: setup/install_tasks.ps1 (task "PokerWrapper GTO Wizard - <user>")
#   -Only primary       watch only these ids (a friend's install: one account)
#   -Once               one pass, then exit      -DryRun   say what would be restarted, restart nothing

param(
    [string[]]$Only,
    [switch]$Once,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
# -Only a,b through `powershell -File` arrives as ONE string "a,b": split it (the task passes one id)
$Only = @($Only | ForEach-Object { "$_" -split ',' } | Where-Object { $_ })
# the environment as the task handed it over, before config\env.ps1 adds anything (a self-replace hands it on)
$SupBaseEnv = [Environment]::GetEnvironmentVariables('Process')
# where everything is: the data root (the registry), the Bun-free PATH additions; the same resolver every launcher uses
. (Join-Path $PSScriptRoot '..\config\env.ps1')
. (Join-Path $PSScriptRoot '..\scripts\supervisor_lib.ps1')
# NORMAL PRIORITY (2026-09-26): a scheduled task starts at BelowNormal (Task Scheduler's default priority 7) and every
# child inherits it, so on a busy machine this live-answer service lost the CPU to everything else (the study API's
# 0.2 s reads took 3-4 s, its event loop stalled for seconds with nothing heavy running). Raise this supervisor to
# Normal before it starts anything; its children inherit that.
try { (Get-Process -Id $PID).PriorityClass = 'Normal' } catch { }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scriptDir = $PSScriptRoot

# The scheduled task runs this HEADLESS (conhost --headless), so Write-Output goes nowhere. Everything it says is
# therefore also appended to a log, next to the API supervisor's, which is the only way to answer "why did GTO
# Wizard go away at 4am" after the fact.
$logFile = Join-Path $root 'gto-trainer\apps\api\data\jobs\gtow_watchdog.log'
try { $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFile) -ErrorAction SilentlyContinue } catch {}
function Say([string]$m) {
    Write-Output $m
    try { Add-Content -LiteralPath $logFile -Value "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] $m" -ErrorAction SilentlyContinue } catch {}
}

# ONE WATCHDOG. Stop-ScheduledTask does not reliably end a running instance (three study-api.ps1 supervisors were found
# alive on 2026-09-14 for exactly this reason), and two of these would fight each other: both would see the same client
# mid-restart as "not drivable" and kill it again.
#
# A NAMED MUTEX, not a command-line scan. The obvious guard — look for another powershell whose CommandLine mentions
# "gtow_watchdog" — also matches any ad-hoc `Get-CimInstance ... -match 'gtow_watchdog'` someone runs to CHECK on the
# watchdog, because that query's own command line contains the string. The watchdog then saw the person looking at it
# as a rival and exited, silently, with code 0 (caught 2026-09-21: the task reported success and nothing ran).
# (-Once and -DryRun are a person checking: they never claim the mutex.)
if (-not $Once -and -not $DryRun) {
    # one watchdog PER INSTALL: the name carries the primary's CDP port (config\env.ps1: GTOW_CDP_PORT = 9222 + PORT_OFFSET),
    # so a second Windows account's install (its own ports) runs its own watchdog beside this one
    $mutex = New-Object System.Threading.Mutex($false, "Global\PokerGtowWatchdog-$(if ($env:GTOW_CDP_PORT) { $env:GTOW_CDP_PORT } else { 9222 })")
    try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) {
        Say 'gtow watchdog already running - exiting'
        exit 0
    }
    # what this watchdog read at start: its script, the lib, config\env.ps1, config\local.env (data\jobs\supervisor-gtow.json).
    # It re-reads nothing: any change to those makes the API write data\jobs\supervisor-gtow.replace.json when no
    # session is live, and the loop below replaces this watchdog (scripts\supervisor_lib.ps1, 2026-10-10). Its children
    # are the GTO Wizard windows: a self-replace never touches them (no /T, no Stop-Process of a child).
    Start-SupervisorState -Name 'gtow' -BaseEnv $SupBaseEnv -CodeFiles @($PSCommandPath) -LogFile $logFile `
      -RelaunchArgs $(if ($Only) { "-Only $($Only -join ',')" } else { '' })
}

function Get-Targets([int]$port) {
    try { return (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json/list" -TimeoutSec 5).Content | ConvertFrom-Json }
    catch { return $null }
}
# Only PAGE targets count. A CDP target list also carries service workers, and https://app.gtowizard.com/service-worker.js
# matches the hostname while being no evidence at all that a usable page is loaded — it made a client sitting on /login
# read as drivable (caught live 2026-09-21).
# The human gates: the activation-code screen and GTO Wizard's own sign-in page.
$HUMAN_GATE = 'activate\.html|/login|/auth|/signin'

# Drivable = a SIGNED-IN app.gtowizard page is loaded. That page's authenticated traffic is the only thing the API can
# sniff a bearer token from. The exclusion is load-bearing: app.gtowizard.com/login is an app.gtowizard URL too, so a
# bare hostname match calls a client that is sitting at the sign-in screen "drivable" and reports it healthy forever,
# while it holds no token and answers nothing (caught live 2026-09-21).
function Test-Drivable([int]$port) {
    $t = Get-Targets $port
    if ($null -eq $t) { return $false }
    return @($t | Where-Object { $_.type -eq 'page' -and $_.url -match 'app\.gtowizard' -and $_.url -notmatch $HUMAN_GATE }).Count -gt 0
}
# Alive but parked on a human gate (activation code, sign-in).
function Test-NeedsHuman([int]$port) {
    $t = Get-Targets $port
    if ($null -eq $t) { return $false }
    return @($t | Where-Object { $_.type -eq 'page' -and $_.url -match $HUMAN_GATE }).Count -gt 0
}

# ---- the registry -> the accounts to watch, each with its port, its launcher and its processes ----------------------
$registryPath = if ($env:GTOW_ACCOUNTS_PATH) { $env:GTOW_ACCOUNTS_PATH }
                elseif ($env:POKER_DATA_DIR) { Join-Path $env:POKER_DATA_DIR 'gtow-accounts.json' }
                else { Join-Path $root 'data\gtow-accounts.json' }

function Read-Accounts {
    $rows = $null
    if (Test-Path -LiteralPath $registryPath) {
        try { $rows = @((Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json).accounts) } catch { Say "registry unreadable ($registryPath): $($_.Exception.Message)"; return $null }
    }
    if ($null -eq $rows) {
        # no registry yet: the first install's shape — the primary alone, a Chrome profile on this install's port (9222 + PORT_OFFSET)
        $rows = @([pscustomobject]@{ id = 'primary'; name = 'Ultra'; cdpHost = "127.0.0.1:$(if ($env:GTOW_CDP_PORT) { $env:GTOW_CDP_PORT } else { 9222 })"; launchHint = 'scripts/start_gtow_chrome.ps1'; client = 'chrome'; profileDir = $null; enabled = $true })
    }
    $out = @()
    foreach ($a in $rows) {
        if ($a.enabled -eq $false) { continue }
        if ($Only -and ($Only -notcontains $a.id)) { continue }
        $m = [regex]::Match([string]$a.cdpHost, ':(\d+)\s*$')
        if (-not $m.Success) { Say "[$($a.id)] no port in cdpHost '$($a.cdpHost)' - not watched"; continue }
        $port = [int]$m.Groups[1].Value
        $profile = if ($a.profileDir) { [string]$a.profileDir } elseif ($a.id -eq 'primary') { "$env:LOCALAPPDATA\gtow-cdp-profile" } else { "$env:LOCALAPPDATA\gtow-cdp-profile-$($a.id)" }
        $script = if ($a.launchHint -and $a.launchHint -match '\.ps1$' -and (Test-Path -LiteralPath (Join-Path $root $a.launchHint))) { Join-Path $root $a.launchHint } else { $null }
        $kind = if ($script) { 'script' } else { 'chrome' }
        $label = if ($kind -eq 'script') { [string]$a.launchHint } else { "chrome profile $profile" }
        $out += [pscustomobject]@{ Id = [string]$a.id; Name = [string]$a.name; Port = $port; Kind = $kind; Script = $script; Profile = $profile; Label = $label }
    }
    return $out
}

# the client's processes (for dismissing the updater's modal): a Chrome profile by its folder
function Get-Procs($s) {
    if ($s.Kind -eq 'chrome') {
        $ids = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -like "*--user-data-dir=$($s.Profile)*" } | ForEach-Object { $_.ProcessId }
        return @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    }
    return @()
}

# bring the client up with the CDP flag — the launchers read the port (and the profile) from the environment, so one
# script serves every account
function Start-Client($s) {
    $env:GTOW_CDP_PORT = "$($s.Port)"; $env:GTOW_CHROME_PROFILE = $s.Profile
    switch ($s.Kind) {
        'script'   { & $s.Script -Force | Out-Null }
        default    { & (Join-Path $scriptDir 'start_gtow_chrome.ps1') -Force | Out-Null }
    }
}

# ---- the loop ---------------------------------------------------------------------------------------------------
# Startup is SLOW: after an update the app sits on activate.html and cycles renderers for ~4 minutes before app.gtowizard
# appears. The original 90s grace killed it mid-startup every time - a permanent kill-loop that cost an overnight audit
# run (2026-08-27). Grace is 8 minutes, and two consecutive failed probes are required before killing anything, so a
# single slow or flaky poll never triggers a restart.
$state = @{}     # id -> @{ Miss; Human }
$watched = ''
Say "gtow watchdog up (pid $PID) - registry $registryPath$(if ($DryRun) { ' (DRY RUN)' })"
while ($true) {
    $sessions = Read-Accounts
    if ($null -ne $sessions) {
        $now = ($sessions | ForEach-Object { "$($_.Id)@$($_.Port)" }) -join ', '
        if ($now -ne $watched) {
            Say "watching: $(if ($now) { $now } else { 'nothing (no enabled accounts)' })"
            foreach ($s in $sessions) { Say "  $($s.Id): $($s.Label)" }
            $watched = $now
        }
        foreach ($s in $sessions) {
            if (-not $state.ContainsKey($s.Id)) { $state[$s.Id] = @{ Miss = 0; Human = $false } }
            $st = $state[$s.Id]
            $stamp = Get-Date -Format HH:mm:ss
            if (Test-Drivable $s.Port) {
                if ($st.Miss -gt 0 -or $st.Human) { Say "$stamp [$($s.Id)] back" }
                $st.Miss = 0; $st.Human = $false
                continue
            }
            if (Test-NeedsHuman $s.Port) {
                # A human gate is not a fault to restart out of. Say it once, then stay quiet until it changes.
                if (-not $st.Human) { Say "$stamp [$($s.Id)] waiting for a human - activation code or sign-in in its window. NOT restarting." }
                $st.Human = $true; $st.Miss = 0
                continue
            }
            $st.Human = $false
            $st.Miss++
            if ($st.Miss -lt 2) { Say "$stamp [$($s.Id)] probe failed (1/2) - waiting"; continue }

            if ($DryRun) { Say "$stamp [$($s.Id)] not drivable - WOULD restart ($($s.Kind): $($s.Label)) on :$($s.Port)"; $st.Miss = 0; continue }
            Say "$stamp [$($s.Id)] not drivable - restarting with CDP flag ($($s.Kind))"
            Start-Client $s
            for ($i = 0; $i -lt 96; $i++) {          # up to 8 minutes
                Start-Sleep -Seconds 5
                $dlg = Get-Procs $s | Where-Object { $_.MainWindowTitle -match '更新|update' }
                if ($dlg) { $null = $dlg.CloseMainWindow() }
                if (Test-Drivable $s.Port) { Say "$(Get-Date -Format HH:mm:ss) [$($s.Id)] back after $($i * 5)s"; break }
                if (Test-NeedsHuman $s.Port) {
                    Say "$(Get-Date -Format HH:mm:ss) [$($s.Id)] came up on its activation/login screen - needs a human"
                    $st.Human = $true
                    break
                }
            }
            $st.Miss = 0
        }
    }
    if ($Once) { break }
    # ASKED TO REPLACE ITSELF (the API wrote the request: this script, the lib, config\env.ps1 or config\local.env changed
    # and no session is live). The helper starts the task again once this process and its console are gone; after a
    # Stop-Process (not this clean exit) the headless conhost can linger and the task refuses a new instance
    # (0x800710E0) - the helper clears such an orphan (no children) or spawns this script directly.
    if (-not $DryRun) {
        $req = Get-SupervisorReplaceRequest
        if ($req -and (Invoke-SupervisorReplace -Request $req)) {
            try { $mutex.ReleaseMutex() } catch { }
            exit 0
        }
    }
    Start-Sleep -Seconds 60
}
