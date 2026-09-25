import { existsSync, appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { expectedChartIds, isBoxGrid, REPO as REPO_ROOT } from "./ledger";
import { join } from "node:path";
import { loadLedger, evaluate } from "./ledger";
import { jobsDir } from "./storePaths";
import { jobs, HRC_API_ZENBOOK, BASH, type JobRow } from "./jobs";
import { isBackgroundOwner, backgroundLockStatus } from "./backgroundLock";
import { asActivity } from "./answerTrace";
import { lastMatch, readRange } from "./fileTail";

/**
 * BOX KEEPER — keeps the HRC boxes solving without a human in the loop (Brady, 2026-09-11:
 * "make sure there isn't significant downtime"). Every few minutes, for every box in the
 * ledger's `boxes["hrc-box"]`, it fixes the outages we have actually had:
 *
 *   HRC not running            → Start-ScheduledTask HRC          (the JVM died mid-batch, twice on hrc-3)
 *   HRC hung: batch silent 5 h → Start-ScheduledTask HRCRestart   (graceful File > Exit + relaunch via the UIA
 *                                                                  driver's own restart-hrc; the longest honest
 *                                                                  tree so far took 4.7 h)
 *   RDP session left attached  → tscon <id> /dest:console         (a blank desktop makes the driver refuse to
 *                                                                  click; only once Brady has been idle 10 min)
 *   a box job failed           → re-queue the same config on the same lane, exponential backoff from 3 min,
 *                                at most 8 tries without progress (a per-chart bug must not loop forever;
 *                                exit 3 = parity refused is never retried)
 *
 * Everything it does is written to data/jobs/box_keeper.log and shown at GET /api/ledger/keeper.
 * The zenbook (host "local") gets the re-queue treatment only — its desktop is Brady's.
 */

const SSH = existsSync("C:/Program Files/Git/usr/bin/ssh.exe") ? "C:/Program Files/Git/usr/bin/ssh.exe" : "ssh";
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "C:/Users/Brady";
const KEY = join(HOME, ".ssh", "id_ed25519");
const TICK_MS = 3 * 60_000;
// Windows: the box log gets a "[lock] n%" / refine line every ~5 min while solving and the longest silent stretch (tree
// build + lock at 150bb) is ~20 min — 45 min without a line while HRCJob says Running = HRC is hung. Was 5 h; Brady
// (2026-09-12): "runs will not be randomly stopped and hang for hours on end".
// 2026-09-13: a 6-max tree keeps the box log silent for the whole 60-min refinement + export, so silence alone is not a hang
// any more — the box's HRC CPU is the tie-breaker (a working JVM is at hundreds of %; a hung one idles).
const STALL_MIN = 90;
// Linux: the shard log only gets a line per finished chart (~40-65 min), so the JVM's CPU is the hang signal there:
// solving = 1000%+ of a core, a wedged/idle JVM sits under 60% — three quiet ticks (9 min) with the runner alive = hung.
const LINUX_STALL_MIN = 120;
const LINUX_QUIET_TICKS = 3;
const CPU_CALM = 60;
/** minutes after a tree's export during which a quiet box is parsing, not hung */
const EXPORT_GRACE_MIN = 25;
/** age in minutes of the newest export this box holds, or null when it holds none */
const recentZipMin = (pr: { zips?: { at: number }[] }): number | null => {
  const ats = (pr.zips ?? []).map((z) => z.at * 1000).filter((t) => t > 0);
  return ats.length ? Math.round((Date.now() - Math.max(...ats)) / 60_000) : null;
};
const RDP_IDLE_MIN = 10;              // move an RDP session to the console only once its user has walked away
const RESTART_COOLDOWN_MS = 30 * 60_000;
const MAX_AUTO_REQUEUE = 8;
const REQUEUE_WINDOW_MS = 48 * 3600_000;
const LOG_PATH = join(jobsDir(), "box_keeper.log");

interface Box { label: string; host: string }
/** A Linux HRC box (hetzner kit, bridge driver): HRC as a systemd unit, one template hand open, a shard runner on `plan`. */
interface LinuxBox { label: string; host: string; plan: string }
/** what the box is solving now + the finished zips it holds (id, unix seconds) — read every tick for the proposal page */
export interface BoxWork { current: string | null; currentSinceMin: number | null; currentPhase: string; zips: { id: string; at: number; size?: number; /** which output dir the zip sits in on the box: "r2" = the second pass, "grid" = the first */ dir?: string }[]; /** Linux: study-UI solutions already converted ON the box (id, unix seconds, bytes) */ sols?: { id: string; at: number; size: number }[] }
export interface LinuxProbe extends BoxWork { at: number; ok: boolean; error?: string; hrc: string; hands: number; runner: number; logAgeMin: number | null; left: number | null; cpuPct: number | null; quietTicks: number; actions: string[] }
export interface Probe extends BoxWork {
  at: number; ok: boolean; error?: string; cpuPct?: number | null;
  hrc: boolean; job: string; logAgeMin: number | null; session: string; sessionId: string | null; idleMin: number | null; restartTask: boolean;
  lastErr: string; actions: string[];
}
interface Attempts { n: number; lastFailedJob: number; gaveUp?: boolean }

const REMOTE_PROBE = `
$p = Get-Process hrc -ErrorAction SilentlyContinue; "hrc=" + [bool]$p
"job=" + (Get-ScheduledTask HRCJob -ErrorAction SilentlyContinue).State
$l = Get-Item C:\\poker\\jobs\\threeMaxGrid.log -ErrorAction SilentlyContinue; "logage=" + $(if ($l) { [int]((Get-Date) - $l.LastWriteTime).TotalMinutes } else { -1 })
"session=" + (((quser 2>$null | Select-String administrator) -replace '\\s+', ' ') -join ' | ')
"restarttask=" + [bool](Get-ScheduledTask HRCRestart -ErrorAction SilentlyContinue)
"lasterr=" + ((Get-Content C:\\poker\\jobs\\threeMaxGrid.log -Tail 8 -ErrorAction SilentlyContinue | Select-String "window not found|not found \\(have:|stopping batch" | Select-Object -Last 1) -replace '\\s+', ' ')
$r = Get-Item C:\\poker\\jobs\\restart_hrc.log -ErrorAction SilentlyContinue; "restartfail=" + $(if ($r -and ((Get-Date) - $r.LastWriteTime).TotalMinutes -lt 40 -and ((Get-Content $r.FullName -Tail 4) -join ' ') -match 'did not quit within') { 'True' } else { 'False' })
"responding=" + $(if ($p) { [bool]($p | Where-Object { $_.Responding }).Count } else { 'True' })
"jobstart=" + $(try { (Get-ScheduledTaskInfo HRCJob -ErrorAction Stop).LastRunTime.ToUniversalTime().ToString('o') } catch { '' })
$t1 = 0; foreach ($x in @($p)) { if ($x) { $t1 += $x.TotalProcessorTime.TotalSeconds } }; Start-Sleep -Seconds 2; $t2 = 0; foreach ($x in @(Get-Process hrc -ErrorAction SilentlyContinue)) { if ($x) { $t2 += $x.TotalProcessorTime.TotalSeconds } }; "cpu=" + [int](($t2 - $t1) / 2 * 100)
"cur=" + (((Get-Content C:\\poker\\jobs\\threeMaxGrid.log -Tail 120 -ErrorAction SilentlyContinue | Select-String "refining (\\S+) for") | Select-Object -Last 1) -replace '\\s+', ' ')
"zips=" + ((Get-ChildItem C:\\poker\\hrc-api\\solves\\threemax_grid\\*.strategies.zip, C:\\poker\\hrc-api\\solves\\sixmax_r2\\*.strategies.zip -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -gt (Get-Date).ToUniversalTime().AddDays(-4) } | ForEach-Object { $_.Name.Replace('.strategies.zip','') + '@' + [int64](($_.LastWriteTimeUtc - (Get-Date '1970-01-01')).TotalSeconds) + '@' + $_.Length + '@' + $(if ($_.DirectoryName -like '*sixmax_r2') { 'r2' } else { 'grid' }) }) -join ',')
`;

/** "id@epoch,id@epoch" → zips; the current tree = the last "refining X" unless X's zip is already there (between trees). */
function parseWork(kv: Record<string, string>, logAgeMin: number | null): BoxWork {
  const parseList = (v: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [id, at, size, dir] = x.split("@"); return { id: id ?? "", at: Number(at), size: size ? Number(size) : undefined, dir: dir || "grid" }; }).filter((z) => z.id && z.at > 0);
  const zips = parseList(kv.zips ?? "");
  const sols = kv.sols !== undefined ? (parseList(kv.sols) as { id: string; at: number; size: number }[]) : undefined;
  const m = (kv.cur ?? "").match(/refining (\S+) for (\d+) min/);
  // the tree being refined is "current" unless its zip already exists FROM THIS RUN (a zip older than the runner's start is a
  // previous pass of the same id — the second refinement pass re-solves ids that already have a first-pass zip on the box)
  const jsEarly = kv.jobstart ? Date.parse(kv.jobstart.trim()) : NaN;
  const zipOfCur = m ? zips.filter((z) => z.id === m[1]).map((z) => z.at * 1000) : [];
  const zipIsFromThisRun = zipOfCur.length > 0 && !(Number.isFinite(jsEarly) && Math.max(...zipOfCur) < jsEarly);
  const cur = m && !zipIsFromThisRun ? m[1]! : null;
  // time on the current tree = since the later of the runner's start and the box's last finished zip OF THE SAME FAMILY
  // (an old 3-max zip on the box says nothing about a 6-max tree); unknown when neither is known
  const fam = cur ? cur.replace(/_D.*$/, "") : "";
  const famZips = zips.filter((z) => fam && z.id.startsWith(fam + "_"));
  const lastZip = famZips.length ? Math.max(...famZips.map((z) => z.at)) * 1000 : null;
  const js = kv.jobstart ? Date.parse(kv.jobstart.trim()) : NaN;
  const start = Math.max(lastZip ?? 0, Number.isFinite(js) ? js : 0) || null;
  const since = cur && start ? Math.round((Date.now() - start) / 60_000) : null;
  void logAgeMin;
  return { current: cur, currentSinceMin: since, currentPhase: m ? `refining for ${m[2]} min` : "", zips, ...(sols ? { sols } : {}) };
}

// the graceful restart, run INSIDE the interactive session (UIA needs the desktop): the driver's own restart-hrc
// closes every editor, File > Exit, relaunches from HRC_EXE and waits for the File menu — never a kill
const RESTART_CMD = [
  "@echo off",
  "rem restart_hrc.cmd - graceful HRC restart via the UIA driver (registered as task HRCRestart by the API's box keeper)",
  "set HRC_DRIVER=win",
  "set HRC_EXE=C:\\poker\\HoldemResources\\hrc.exe",
  "set PATH=C:\\poker\\node;%PATH%",
  "cd /d C:\\poker\\hrc-api",
  "if not exist C:\\poker\\jobs mkdir C:\\poker\\jobs",
  "echo [%date% %time%] restart-hrc >> C:\\poker\\jobs\\restart_hrc.log",
  "C:\\poker\\hrc-venv\\Scripts\\python.exe windows\\uia_drive.py restart-hrc >> C:\\poker\\jobs\\restart_hrc.log 2>&1",
  "echo [%date% %time%] exit %errorlevel% >> C:\\poker\\jobs\\restart_hrc.log",
].join("\r\n");
const ENSURE_RESTART_TASK = `
Set-Content -Path C:\\poker\\restart_hrc.cmd -Encoding ASCII -Value @'
${RESTART_CMD}
'@
$user = "$env:COMPUTERNAME\\Administrator"
$a = New-ScheduledTaskAction -Execute "C:\\poker\\restart_hrc.cmd"
$pr = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName HRCRestart -Action $a -Principal $pr -Settings $s -Force | Out-Null
"registered"
`;

async function ssh(host: string, ps: string, timeoutMs = 45_000): Promise<{ code: number; out: string }> {
  const enc = Buffer.from(ps, "utf16le").toString("base64");
  const proc = Bun.spawn([SSH, "-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=40", "-o", "StrictHostKeyChecking=accept-new", `Administrator@${host}`, `powershell -NoProfile -EncodedCommand ${enc}`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME } });
  const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout as any).text(), new Response(proc.stderr as any).text()]);
  const code = await proc.exited; clearTimeout(killer);
  const errLines = err.split(/\r?\n/).filter((l) => l.trim() && !/post-quantum|store now|openssh\.com\/pq/.test(l));
  return { code, out: out + (code !== 0 && errLines.length ? `\n${errLines.join("\n")}` : "") };
}

// rclone on this machine (WinGet install; the StudyAPI task's PATH does not have it): the newest rclone.exe under WinGet's packages
function findRclone(): string {
  if (process.env.RCLONE) return process.env.RCLONE;
  try {
    const base = "C:/Users/Brady/AppData/Local/Microsoft/WinGet/Packages";
    const hits: string[] = [];
    for (const d of require("node:fs").readdirSync(base)) if (/rclone/i.test(d)) for (const sub of require("node:fs").readdirSync(join(base, d))) { const p = join(base, d, sub, "rclone.exe"); if (existsSync(p)) hits.push(p); }
    if (hits.length) return hits.sort().pop()!;
  } catch { /* fall through */ }
  return "rclone";
}
const RCLONE = findRclone();
/** the chart server's own bucket (exploit_ui/server.py UI_REMOTE): a solution listed from its sidecar, body fetched on demand */
const UI_REMOTE = process.env.HRC_UI_REMOTE ?? "r2:poker-solve-db/hrc-ui";
/** raw HRC exports of the Windows boxes on their way to this machine's parser */
const ZIP_REMOTE = process.env.HRC_6MAX_REMOTE ?? "r2:poker-solve-db/hrc-6max";
/** R2 → a local file (500 KB/s here vs 23 KB/s over ssh); rclone skips an identical file */
async function rcloneTo(remote: string, dest: string, timeoutMs = 1800_000): Promise<boolean> {
  // capped: an uncapped download saturates the laptop's VPN link and the box probes time out (2026-09-13 17:51Z, all seven "unreachable")
  const proc = Bun.spawn([RCLONE, "copyto", "--bwlimit", process.env.RCLONE_BWLIMIT ?? "200k", remote, dest], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME } });
  const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
  const code = await proc.exited; clearTimeout(killer);
  return code === 0 && existsSync(dest);
}
async function sshLinux(host: string, cmd: string, timeoutMs = 90_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([SSH, "-o", "BatchMode=yes", "-o", "ConnectTimeout=40", "-o", "StrictHostKeyChecking=accept-new", `root@${host}`, cmd], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME } });
  const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout as any).text(), new Response(proc.stderr as any).text()]);
  const code = await proc.exited; clearTimeout(killer);
  return { code, out: out + (code !== 0 && err.trim() ? `\n${err.trim()}` : "") };
}

/** " administrator rdp-tcp#2 2 Active 12 9/9/2026 9:14 AM" → { name, id, idleMin }; a disconnected session has no name column. */
function parseSession(line: string): { name: string; id: string | null; idleMin: number | null } {
  const t = line.trim().split(/\s+/);
  if (t.length < 3) return { name: "none", id: null, idleMin: null };
  const nameIdx = t.findIndex((x) => /^(console|rdp-tcp#\d+)$/i.test(x));
  const name = nameIdx >= 0 ? t[nameIdx]!.toLowerCase() : "disconnected";
  const idIdx = nameIdx >= 0 ? nameIdx + 1 : 1;
  const id = /^\d+$/.test(t[idIdx] ?? "") ? t[idIdx]! : null;
  const idle = t[idIdx + 2] ?? "";
  const idleMin = idle === "." || /^none$/i.test(idle) ? 0
    : /^\d+\+\d+:\d+$/.test(idle) ? (() => { const [d, hm] = idle.split("+"); const [h, m] = hm!.split(":"); return Number(d) * 1440 + Number(h) * 60 + Number(m); })()
    : /^\d+:\d+$/.test(idle) ? (() => { const [h, m] = idle.split(":"); return Number(h) * 60 + Number(m); })()
    : /^\d+$/.test(idle) ? Number(idle) : null;
  return { name, id, idleMin };
}

class BoxKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private probes = new Map<string, Probe>();
  /** Windows: consecutive ticks a box has looked stalled (silent log + idle HRC); a restart needs two */
  private winStall = new Map<string, number>();
  private linuxProbes = new Map<string, LinuxProbe>();
  private lastPull = 0;
  private attempts = new Map<string, Attempts>();
  private lastRestart = new Map<string, number>();
  private recent: string[] = [];

  start(): void {
    if (this.timer) return;
    // Two keepers wreck each other's work: they dispatch the same parse to the same Linux box, and
    // each dispatch ends with an unconditional `rm -f <solutions>/<id>.json.gz ...` that lands
    // inside the other's run (2026-09-13: a converter crashed statting the .json.gz it had just
    // written, and sibling runs died on "unzip failed" / "suspiciously small tree (0 nodes)").
    // record() is read-modify-write on progress.json too, so the loser's completions are erased.
    if (!isBackgroundOwner()) { this.log("keeper", "NOT started: another API process owns the background work (see data/background.lock)"); return; }
    mkdirSync(jobsDir(), { recursive: true });
    this.log("keeper", `started: tick ${TICK_MS / 60000} min, stall ${STALL_MIN} min (linux ${LINUX_STALL_MIN} min or ${LINUX_QUIET_TICKS} quiet ticks), rdp idle ${RDP_IDLE_MIN} min, max ${MAX_AUTO_REQUEUE} auto re-queues`);
    setTimeout(() => void asActivity("timer boxKeeper", () => this.tick()), 20_000);
    // a rejected tick must not become an unhandled rejection: see services/jobs.ts start()
    this.timer = setInterval(() => { asActivity("timer boxKeeper", () => this.tick()).catch((e) => this.log("keeper", `tick failed (retrying next tick): ${(e as Error)?.stack ?? String(e)}`)); }, TICK_MS);
  }
  /** `lock` is here so a keeper that is NOT running is visible rather than silent: an instance that
   *  lost the background lock serves HTTP normally and would otherwise look like a healthy keeper
   *  with nothing to report. `running` is the honest answer to "is anything keeping the boxes?". */
  status() {
    return {
      boxes: Object.fromEntries(this.probes), linux: Object.fromEntries(this.linuxProbes),
      attempts: Object.fromEntries(this.attempts), recent: this.recent.slice(-60),
      running: !!this.timer, lock: backgroundLockStatus(),
    };
  }

  private log(who: string, msg: string): void {
    const line = `[${new Date().toISOString().slice(0, 19)}] ${who}: ${msg}`;
    this.recent.push(line); if (this.recent.length > 200) this.recent.shift();
    try { appendFileSync(LOG_PATH, line + "\n"); } catch { /* no log dir yet */ }
  }
  private boxes(): Box[] { return ((loadLedger() as any).boxes?.["hrc-box"] ?? []) as Box[]; }
  private linuxBoxes(): LinuxBox[] { return ((loadLedger() as any).boxes?.["hrc-linux"] ?? []) as LinuxBox[]; }

  private async tick(): Promise<void> {
    // Ownership can be lost after start() (the lock's heartbeat found another process had taken it
    // over because this one was declared dead) — stop touching the boxes the moment that happens.
    if (!isBackgroundOwner()) { if (this.timer) { clearInterval(this.timer); this.timer = null; this.log("keeper", "stopped: the background lock was taken over by another API process"); } return; }
    if (this.busy) return; this.busy = true;
    try {
      const remote = this.boxes().filter((b) => b.host !== "local");
      await Promise.all([...remote.map((b) => this.keepBox(b)), ...this.linuxBoxes().map((b) => this.keepLinuxBox(b))]);
      this.requeueFailed();
      this.pullLinux();
      void this.pullSixMax();
    } catch (e) { this.log("keeper", `tick error: ${String(e).slice(0, 200)}`); }
    finally { this.busy = false; }
  }

  /** 6-max trees: every zip a probe listed on a box that this machine has not parsed yet is pulled into the config's plan
   *  dir and parsed (threeMaxGrid --parse-only → charts.json.gz + the study-UI solution the :8777 catalog indexes), so a
   *  finished tree shows as done within a tick and a later shard job sees it as already solved. progress.json keeps
   *  which box solved it and when. Serialised: one pull at a time, one parse at a time. */
  private pullingSixMax = false;
  /** 6-max results reach this machine through R2, not the ssh link (23 KB/s over the VPN vs 2 MB/s box→R2 and 500 KB/s R2→here):
   *   Linux box: the converted solution + its meta sidecar → r2:poker-solve-db/hrc-ui (the chart server's own bucket: a solution is
   *              listed the moment its sidecar is here and the body is fetched on first open) → the body is also copied here for
   *              the sweep and the pass-2 accounting;
   *   Windows box: the raw zip + config.json → r2:poker-solve-db/hrc-6max → copied here → parsed (converter) into the catalog.
   *  Serialised, one config at a time; progress.json in the plan dir records box + solve time. */
  private async pullSixMax(): Promise<void> {
    if (this.pullingSixMax) return; this.pullingSixMax = true;
    try {
      const L = loadLedger() as any;
      const SOL = join(REPO_ROOT, "analysis", "pipeline", "solve", "exploit_ui", "solutions");
      mkdirSync(SOL, { recursive: true });
      const week = Date.now() - 7 * 86_400_000;
      // A BOX-RUN 3-MAX CONFIG IS IN THIS LOOP TOO (2026-09-20). The resolve proposal's pilot runs on the same
      // hrc-box runner through recipe hrc-box-3max; only its plan layout differs (solves/threemax_asym/<id>/
      // plan_3max.json). Without this the loop never looked at it and every finished zip stayed on the box.
      for (const c of (L.configs as any[]).filter((x) => isBoxGrid(x) || x.recipe === "hrc-box-3max")) {
        const three = c.recipe === "hrc-box-3max";
        const fmt = L.formats.find((f: any) => f.id === c.format);
        const ids = new Set(expectedChartIds(c, fmt));
        const dir = join(c.env?.HRC_API ?? HRC_API_ZENBOOK, "solves", three ? "threemax_asym" : "sixmax_grid", c.id);
        if (!existsSync(dir)) continue;
        const progPath = join(dir, "progress.json");
        let prog: Record<string, any> = {}; try { prog = JSON.parse(readFileSync(progPath, "utf-8")); } catch { /* none */ }
        const record = (id: string, box: string, solvedAt: number) => { prog[id] = { box, solvedAt, pulledAt: Date.now() }; try { writeFileSync(progPath, JSON.stringify(prog, null, 1)); } catch { /* best effort */ } };
        const pass2 = c.env?.PASS2 === "1";
        // WHEN DID THIS PASS START ON THIS LANE (2026-09-14). A second-pass result is told apart from the first
        // pass's by its age, and this used to date the pass from the lane's CURRENTLY RUNNING job. That made every
        // finished chart older than the newest re-queue invisible forever: the API restarted (91 times on 2026-09-13/14),
        // each restart re-queued the relays with a fresh `started`, and five finished second-pass charts were skipped
        // silently on every tick because they predated a job that had only just begun. The line between the passes is
        // where THIS pass first ran on the lane, which never moves forward, so take the earliest job of the config on
        // that lane in the window and accept anything newer - a re-queue no longer disowns what the lane already made.
        // ONLY A JOB THAT RAN DEFINES A WINDOW (2026-09-15). Taking `created` when a job never started was wrong in the
        // one case that mattered: grid-6max-nl200-r2 is gated behind the first pass, so its seven jobs were created on
        // 09-13 14:07 and have never run - and every FIRST-pass chart finished after that timestamp was then accepted as
        // a second-pass result. Ten charts were recorded as refined by a pass that had not solved anything at all, which
        // would have quietly excused a third of the even grid from the refinement it exists for. A config with no
        // started job has no window and accepts nothing.
        const passJobs = pass2 ? jobs.list(300).filter((j) => j.config === c.id && j.created > week && j.started) : [];
        const passStartByLane = new Map<string, number>();
        for (const j of passJobs) {
          const t = j.started!;
          const cur = passStartByLane.get(j.lane);
          if (cur == null || t < cur) passStartByLane.set(j.lane, t);
        }
        const passOk = (lane: string, at: number) => { if (!pass2) return true; const t = passStartByLane.get(lane); return t != null && at * 1000 > t; };

        // ---- Linux: solution + meta → hrc-ui → here ----
        for (const [label, p] of this.linuxProbes.entries()) for (const z0 of p.sols ?? []) {
          // ONE PULL PER CHART PER PASS (2026-09-14). progress.json lives in the CONFIG's own directory, so it already
          // means "this pass pulled this chart" - exempting the second pass from it made every finished chart re-pull on
          // every tick. It showed when two boxes had both solved D150_o2: their solutions differ byte for byte, so each
          // tick saw the local file at the wrong size and downloaded the other box's copy over it, 39 MB each way,
          // for ever. Whoever lands first owns the id; a genuine re-solve replaces it through the plan, not the pull.
          if (!ids.has(z0.id) || prog[z0.id] || !passOk(`hrc-linux:${label}`, z0.at)) continue;
          // THE DIRECTORY IS THE PASS (2026-09-15). Linux shards write each pass into its own config directory under
          // solves/sixmax_grid, so the zip beside a solution says which pass made it - a far better answer than "is it
          // newer than a timestamp", which is what let ten first-pass charts be filed as refinements. When the zip has
          // been cleaned up there is nothing to read and the time window decides, as before.
          // THE ZIP FOR THIS PASS, NOT THE FIRST ONE FOUND (2026-09-16). A chart solved in both passes on the same
          // Linux box has two zips there, one per config directory, and `find` returned the first-pass one - whose
          // directory is not this config's, so the second-pass solution was skipped as foreign. Four refined charts
          // sat unpulled for hours (D30_o2_5, D100_o2, D75_o3_5 on hrc-l3; D50_o3 on hrc-l1) while charts whose first
          // pass had run elsewhere came through fine. Prefer the zip in THIS config's directory; only if none exists
          // does any zip of that id stand in for the time check.
          const zips = (p.zips ?? []).filter((x) => x.id === z0.id);
          const zz = zips.find((x) => x.dir === c.id) ?? zips[0];
          if (pass2 && zz && zz.dir && zz.dir !== c.id) continue;
          const z = { ...z0, at: zz?.at ?? z0.at };
          const solL = join(SOL, `${z.id}.json.gz`), metaL = join(SOL, `${z.id}.meta.json`);
          if (existsSync(solL) && existsSync(metaL) && statSync(solL).size === z.size) { if (pass2 || !prog[z.id]) record(z.id, label, z.at * 1000); continue; }
          const lb = this.linuxBoxes().find((b) => b.label === label); if (!lb) continue;
          const up = await sshLinux(lb.host, `cd /root/analysis/pipeline/solve/exploit_ui/solutions && rclone copyto ${z.id}.json.gz ${UI_REMOTE}/${z.id}.json.gz && rclone copyto ${z.id}.meta.json ${UI_REMOTE}/${z.id}.meta.json && echo UP_OK`, 900_000);
          if (!/UP_OK/.test(up.out)) { this.log(label, `6-max upload of ${z.id} to R2 failed: ${up.out.trim().split("\n").pop()?.slice(0, 120)}`); continue; }
          const ok = (await rcloneTo(`${UI_REMOTE}/${z.id}.meta.json`, metaL)) && (await rcloneTo(`${UI_REMOTE}/${z.id}.json.gz`, solL));
          if (!ok || !existsSync(solL) || statSync(solL).size !== z.size) { this.log(label, `6-max download of ${z.id} from R2 failed or incomplete (retry next tick)`); continue; }
          record(z.id, label, z.at * 1000);
          this.log(label, `6-max ${z.id} → R2 → catalog (${Math.round(z.size / 1e6)} MB)`);
        }

        // ---- Windows: zip + config → hrc-6max → parsed ON A LINUX BOX (converter + fast R2) → solution → hrc-ui → here ----
        // (a 100 MB zip takes this laptop ~20 min to unpack + convert and everything else queued behind it, 2026-09-14)
        const remoteDir = (c.env?.PASS2 === "1" ? (c.env?.REMOTE_OUT ?? "C:/poker/hrc-api/solves/sixmax_r2") : "C:/poker/hrc-api/solves/threemax_grid").replace(/\//g, "\\");
        let plan: any[] = []; try { plan = JSON.parse(readFileSync(join(dir, three ? "plan_3max.json" : "plan_6max.json"), "utf-8")); } catch { /* not generated yet */ }
        const parsers = this.linuxBoxes().filter((b) => this.linuxProbes.get(b.label)?.ok);
        let parserIdx = 0;
        // WHICH PASS MADE THIS ZIP (2026-09-14). Both passes use the same chart ids, so the only thing that tells a
        // second-pass export from a first-pass one on a Windows box is the directory it was written to: the first pass
        // wrote solves\threemax_grid, the second writes solves\sixmax_r2 (boxJob --remote-out). Dating them instead
        // made the keeper try to upload a first-pass zip out of the second pass's directory - "upload of
        // ign200_6max_D50_o2 to R2 failed: UP_False", once per tick, for a file that was never there.
        const wantDir = pass2 ? "r2" : "grid";
        for (const [label, p] of this.probes.entries()) for (const z of p.zips ?? []) {
          if ((z.dir ?? "grid") !== wantDir) continue;
          if (!ids.has(z.id) || !z.size || prog[z.id] || !passOk(`hrc-box:${label}`, z.at)) continue;
          const win = this.boxes().find((b) => b.label === label); if (!win || win.host === "local") continue;
          const job = plan.find((j) => j.id === z.id); if (!job) continue;
          const solL = join(SOL, `${z.id}.json.gz`), metaL = join(SOL, `${z.id}.meta.json`);
          // 1. the Windows box pushes the raw export to R2 (idempotent: rclone skips an unchanged file)
          const up = await ssh(win.host, `$ok = $true; & C:\\poker\\rclone.exe copyto "${remoteDir}\\${z.id}.strategies.zip" ${ZIP_REMOTE}/${z.id}.strategies.zip; if (-not $?) { $ok = $false }; & C:\\poker\\rclone.exe copyto "${remoteDir}\\${z.id}.config.json" ${ZIP_REMOTE}/${z.id}.config.json; if (-not $?) { $ok = $false }; "UP_" + $ok`, 900_000);
          if (!/UP_True/.test(up.out)) { this.log(label, `6-max upload of ${z.id} to R2 failed: ${up.out.trim().split("\n").pop()?.slice(0, 120)}`); continue; }
          // 2. a Linux box downloads it, parses + converts, uploads the solution, and removes its copies (so its own listing stays clean)
          if (!parsers.length) { this.log(label, `6-max ${z.id} is in R2 but no Linux box is reachable to parse it (retry next tick)`); continue; }
          const pb = parsers[parserIdx++ % parsers.length]!;
          const D = `solves/${three ? "threemax_asym" : "sixmax_grid"}/${c.id}`, S = "/root/analysis/pipeline/solve/exploit_ui/solutions";
          // one parse per id per box (an API restart re-issues the command while the previous instance's parse still runs on
          // the box — two converters on one id deleted each other's output, 2026-09-14); the solution stays in the box's dir
          const cmd = `exec 9>/tmp/parse_${z.id}.lock; flock -n 9 || { echo PARSE_BUSY; exit 0; }; cd /root/hrc-api && mkdir -p ${D} && rclone copyto ${ZIP_REMOTE}/${z.id}.strategies.zip ${D}/${z.id}.strategies.zip && rclone copyto ${ZIP_REMOTE}/${z.id}.config.json ${D}/${z.id}.config.json && cat > ${D}/parse.${z.id}.json <<'JSON'
${JSON.stringify([job])}
JSON
export PATH=/root/.bun/bin:$PATH; bun run scripts/threeMaxGrid.ts ${D}/parse.${z.id}.json --parse-only --out ${D} > /tmp/parse_${z.id}.log 2>&1; if [ -s ${S}/${z.id}.json.gz ]; then rclone copyto ${S}/${z.id}.json.gz ${UI_REMOTE}/${z.id}.json.gz && rclone copyto ${S}/${z.id}.meta.json ${UI_REMOTE}/${z.id}.meta.json && echo PARSE_OK; else echo PARSE_FAILED; tail -n 3 /tmp/parse_${z.id}.log; fi; rm -f ${D}/${z.id}.strategies.zip; rm -rf ${D}/${z.id}_extract`;
          const pr = await sshLinux(pb.host, cmd, 45 * 60_000);
          if (/PARSE_BUSY/.test(pr.out)) { this.log(label, `6-max ${z.id}: a parse is already running on ${pb.label} (retry next tick)`); continue; }
          if (!/PARSE_OK/.test(pr.out)) { this.log(label, `6-max parse of ${z.id} on ${pb.label} failed: ${pr.out.trim().split("\n").slice(-2).join(" | ").slice(0, 160)}`); continue; }
          // 3. the finished solution comes here from R2 (small, capped rate)
          const ok = (await rcloneTo(`${UI_REMOTE}/${z.id}.meta.json`, metaL)) && (await rcloneTo(`${UI_REMOTE}/${z.id}.json.gz`, solL));
          if (!ok || !existsSync(solL) || statSync(solL).size === 0) { this.log(label, `6-max download of ${z.id} from R2 failed (retry next tick)`); continue; }
          record(z.id, label, z.at * 1000);
          this.log(label, `6-max ${z.id} → R2 → parsed on ${pb.label} → catalog (${Math.round(z.size / 1e6)} MB zip, ${Math.round(statSync(solL).size / 1e6)} MB solution)`);
        }
      }
    } catch (e) { this.log("keeper", `6-max pull error: ${String(e).slice(0, 200)}`); }
    finally { this.pullingSixMax = false; }
  }

  /** One box: probe, then repair whatever is wrong. */
  private async keepBox(b: Box): Promise<void> {
    const pr: Probe = { at: Date.now(), ok: false, hrc: false, job: "?", logAgeMin: null, session: "?", sessionId: null, idleMin: null, restartTask: false, lastErr: "", actions: [], current: null, currentSinceMin: null, currentPhase: "", zips: [] };
    // A NON-ZERO EXIT IS NOT AN UNREACHABLE BOX (2026-09-14). PowerShell over ssh answers a probe that touched its
    // error stream with a serialised "#< CLIXML" blob and a non-zero code, even though the probe itself ran fine -
    // three Vultr boxes "unreachable" together, twice an hour, each time losing that tick's zips and current tree for
    // no reason. The probe prints zips= last, so its presence means the whole script ran: trust that over the exit
    // code, exactly as the Linux probe already trusts runner=. When it really is missing, try once more before
    // calling the box down, because a single dropped connection is the common case and it costs one ssh to rule out.
    let r = await ssh(b.host, REMOTE_PROBE);
    const probeRan = (x: { out: string }) => x.out.includes("zips=");
    if (r.code !== 0 && !probeRan(r)) r = await ssh(b.host, REMOTE_PROBE);
    if (r.code !== 0 && !probeRan(r)) {
      // a network blip must not make finished charts and the current tree vanish from the page: keep the last good work fields
      const prev = this.probes.get(b.label);
      pr.error = r.out.trim().split("\n").pop()?.slice(0, 160) ?? `ssh exited ${r.code}`;
      if (prev) { pr.current = prev.current; pr.currentSinceMin = prev.currentSinceMin; pr.currentPhase = prev.currentPhase; pr.zips = prev.zips; pr.cpuPct = prev.cpuPct; }
      this.probes.set(b.label, pr); this.log(b.label, `unreachable: ${pr.error}`); return;
    }
    const kv = Object.fromEntries(r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    pr.ok = true; pr.hrc = kv.hrc === "True"; pr.job = kv.job || "none"; pr.restartTask = kv.restarttask === "True"; pr.lastErr = (kv.lasterr ?? "").trim();
    pr.logAgeMin = kv.logage != null && Number(kv.logage) >= 0 ? Number(kv.logage) : null;
    pr.cpuPct = kv.cpu !== undefined && kv.cpu !== "" ? Number(kv.cpu) : null;
    Object.assign(pr, parseWork(kv, pr.logAgeMin));
    const s = parseSession((kv.session ?? "").split(" | ")[0] ?? ""); pr.session = s.name; pr.sessionId = s.id; pr.idleMin = s.idleMin;

    // 0. the graceful-restart task must exist before we can ever need it
    if (!pr.restartTask) { const e = await ssh(b.host, ENSURE_RESTART_TASK); pr.actions.push(`registered HRCRestart (${e.code === 0 ? "ok" : "failed"})`); pr.restartTask = e.code === 0; }
    // 1. desktop not rendering: an attached RDP client (user idle) or a disconnected session → console
    if (s.id && s.name !== "console" && s.name !== "none" && (s.name === "disconnected" || (s.idleMin ?? 0) >= RDP_IDLE_MIN)) {
      const t = await ssh(b.host, `tscon ${s.id} /dest:console 2>&1; "done"`);
      pr.actions.push(`session ${s.name} (idle ${s.idleMin ?? "?"} min) → console (${t.code === 0 ? "ok" : "failed"})`);
    }
    // 2. HRC is not running at all → its logon task brings it back (Pro licence is machine-bound, it comes back licensed)
    if (!pr.hrc) {
      const t = await ssh(b.host, `Start-ScheduledTask HRC; Start-Sleep -Seconds 20; "hrc=" + [bool](Get-Process hrc -ErrorAction SilentlyContinue)`, 60_000);
      pr.actions.push(`HRC was down → Start-ScheduledTask HRC → ${t.out.trim().split("\n").pop()}`);
    }
    if (!(pr.job === "Running" && pr.logAgeMin != null && pr.logAgeMin >= STALL_MIN && !(pr.cpuPct != null && pr.cpuPct >= CPU_CALM))) this.winStall.set(b.label, 0);
    // 3. HRC up, batch says Running, but nothing written for hours → the JVM is hung → graceful restart, at most every 30 min
    else if (pr.job === "Running" && pr.logAgeMin != null && pr.logAgeMin >= STALL_MIN && pr.cpuPct != null && pr.cpuPct >= CPU_CALM) {
      pr.actions.push(`log silent ${pr.logAgeMin} min but HRC is at ${pr.cpuPct}% CPU — a long solve, left alone`);
    }
    // ... and a single idle reading is not enough either: HRC's own node-budget recycle ("recycling HRC to reclaim heap")
    // reads as CPU 0 for a tick — the stall must be seen on two consecutive ticks (6 min) before a restart (hrc-3, 2026-09-13 12:25Z)
    // ... and a box that has just written an export is not hung either: after a tree exports, the runner walks the
    // unzipped tree single-threaded for many minutes, so HRC sits near idle while real work continues (hrc-1 was
    // restarted 2.5 min after a 79 MB export landed, 2026-09-14). A zip newer than EXPORT_GRACE_MIN blocks a restart.
    else if (pr.job === "Running" && pr.logAgeMin != null && pr.logAgeMin >= STALL_MIN && recentZipMin(pr) != null && recentZipMin(pr)! < EXPORT_GRACE_MIN) {
      this.winStall.set(b.label, 0);
      pr.actions.push(`log silent ${pr.logAgeMin} min and HRC idle, but a tree exported ${recentZipMin(pr)} min ago — the runner is parsing it, left alone`);
    }
    else if (pr.job === "Running" && pr.logAgeMin != null && pr.logAgeMin >= STALL_MIN && (this.winStall.get(b.label) ?? 0) < 1) {
      this.winStall.set(b.label, (this.winStall.get(b.label) ?? 0) + 1);
      pr.actions.push(`log silent ${pr.logAgeMin} min and HRC idle (${pr.cpuPct ?? "?"}%) — confirming on the next tick before a restart`);
    }
    else if (pr.job === "Running" && pr.logAgeMin != null && pr.logAgeMin >= STALL_MIN) {
      const last = this.lastRestart.get(b.label) ?? 0;
      if (Date.now() - last > RESTART_COOLDOWN_MS && pr.restartTask) {
        const t = await ssh(b.host, `Start-ScheduledTask HRCRestart; "started"`);
        this.lastRestart.set(b.label, Date.now());
        pr.actions.push(`batch silent ${pr.logAgeMin} min with HRCJob Running → HRCRestart (${t.code === 0 ? "started" : "failed"})`);
      }
    }
    // 4. HRC is up but its window is gone for the driver ("HRC main SWT window not found", "menu item ... not found (have:
    //    [...])") — the batch stops after 2 failures and every re-queue fails the same way (hrc-3, 2026-09-11, for 12 h).
    //    A graceful restart via the UIA driver puts a real window back; the relay's next attempt then goes through.
    //    "stopping batch" counts too: the log's LAST matching line is that one, the FAIL reason sits above it (hrc-1 idled
    //    4 h on 2026-09-12 because only the FAIL text was matched).
    else if (pr.job !== "Running" && /window not found|not found \(have:|stopping batch/.test(pr.lastErr)) {
      const last = this.lastRestart.get(b.label) ?? 0;
      // 4b. the graceful restart already gave up ("HRC did not quit within 90s") or the JVM is Not Responding: it is wedged
      //     (a 4-day-old heap at 20380M/20480M on hrc-1, 2026-09-12) and nothing but a kill brings it back. On these Vultr
      //     boxes a kill + the HRC logon task came back as "HRC Pro" every time (hrc-3 09-11, hrc-2 and hrc-1 09-12) — the
      //     licence is machine-bound. (The zenbook is different: its HRC dropped to Free Mode after a kill — never do this
      //     to a box that is not in ledger boxes["hrc-box"].)
      if (kv.restartfail === "True" || kv.responding === "False") {
        if (Date.now() - last > 10 * 60_000) {
          const t = await ssh(b.host, `Stop-ScheduledTask HRCJob -ErrorAction SilentlyContinue; Stop-Process -Name hrc -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 8; Start-ScheduledTask HRC; Start-Sleep -Seconds 45; "hrc=" + [bool](Get-Process hrc -ErrorAction SilentlyContinue)`, 90_000);
          this.lastRestart.set(b.label, Date.now());
          pr.actions.push(`HRC wedged (graceful restart failed / not responding) → killed + Start-ScheduledTask HRC → ${t.out.trim().split("\n").pop()}`);
        }
      } else if (Date.now() - last > RESTART_COOLDOWN_MS && pr.restartTask) {
        const t = await ssh(b.host, `Start-ScheduledTask HRCRestart; "started"`);
        this.lastRestart.set(b.label, Date.now());
        pr.actions.push(`driver cannot see HRC's window ("${pr.lastErr.slice(0, 90)}") → HRCRestart (${t.code === 0 ? "started" : "failed"})`);
      }
    }
    this.probes.set(b.label, pr);
    for (const a of pr.actions) this.log(b.label, a);
  }

  /** One Linux box: HRC unit up, the bridge's template hand open, the shard runner alive while its plan has work left. */
  private async keepLinuxBox(b: LinuxBox): Promise<void> {
    const prev = this.linuxProbes.get(b.label);
    const pr: LinuxProbe = { at: Date.now(), ok: false, hrc: "?", hands: 0, runner: 0, logAgeMin: null, left: null, cpuPct: null, quietTicks: prev?.quietTicks ?? 0, actions: [], current: null, currentSinceMin: null, currentPhase: "", zips: [] };
    // cpu = the JVM's % of one core over 2 s from /proc (ps pcpu is a lifetime average and useless here)
    const probe = `systemctl is-active hrc; cd /root/hrc-api; echo "runner=$(pgrep -fc '[t]hreeMaxGrid')"; echo "hands=-1"; L2=$(ls -t /tmp/*.log 2>/dev/null | head -1); echo "logage=$( [ -f "$L2" ] && echo $(( ($(date +%s) - $(stat -c %Y "$L2")) / 60 )) || echo -1 )"; echo "jobstart=$(head -1 "$L2" 2>/dev/null | cut -c2-21)"; echo "left=$(python3 -c "import json,os; p=json.load(open('${b.plan}')); d=os.path.dirname('${b.plan}'); print(sum(1 for j in p if not os.path.exists(os.path.join(d, j['id']+'.strategies.zip'))))" 2>/dev/null)"; pids=$(pgrep -f 'java|/opt/hrc/hrc' | tr '\\n' ' '); a=0; for q in $pids; do t=$(awk '{print $14+$15}' /proc/$q/stat 2>/dev/null); a=$((a+\${t:-0})); done; sleep 2; c=0; for q in $pids; do t=$(awk '{print $14+$15}' /proc/$q/stat 2>/dev/null); c=$((c+\${t:-0})); done; echo "cpu=$(( (c-a)*100/$(getconf CLK_TCK)/2 ))"; T=$(python3 -c "import json;print(json.load(open('/root/.hrc-bridge/bridge.json'))['token'])" 2>/dev/null); echo "bridge=$(curl -sf -m 15 -H "X-Hrc-Token: $T" http://127.0.0.1:8791/status >/dev/null 2>&1 && echo up || echo down)"; echo "cur=$(grep -E 'refining (\\S+) for' $L2 2>/dev/null | tail -1)"; echo "zips=$(cd /root/hrc-api/solves/sixmax_grid 2>/dev/null && stat -c '%n@%Y@%s' */*.strategies.zip 2>/dev/null | awk -F@ '{n=$1; sub(/\\.strategies\\.zip$/,"",n); d=n; sub(/\\/.*$/,"",d); sub(/^.*\\//,"",n); print n "@" $2 "@" $3 "@" d}' | paste -sd, -)"; echo "sols=$(cd /root/analysis/pipeline/solve/exploit_ui/solutions 2>/dev/null && stat -c '%n@%Y@%s' *.json.gz 2>/dev/null | sed 's#\\.json\\.gz##' | paste -sd, -)"`;
    const r = await sshLinux(b.host, probe);
    if (r.code !== 0 && !r.out.includes("runner=")) {
      pr.error = r.out.trim().split("\n").pop()?.slice(0, 160) ?? `ssh exited ${r.code}`;
      if (prev) { pr.current = prev.current; pr.currentSinceMin = prev.currentSinceMin; pr.currentPhase = prev.currentPhase; pr.zips = prev.zips; pr.sols = prev.sols; pr.cpuPct = prev.cpuPct; }
      this.linuxProbes.set(b.label, pr); this.log(b.label, `unreachable: ${pr.error}`); return;
    }
    const lines = r.out.split(/\r?\n/).map((l) => l.trim());
    pr.ok = true; pr.hrc = lines[0] ?? "?";
    const kv = Object.fromEntries(lines.filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    pr.runner = Number(kv.runner ?? 0); pr.hands = Number(kv.hands ?? 0); pr.left = kv.left !== undefined && kv.left !== "" ? Number(kv.left) : null;
    // a missing log (no shard started yet on this plan) is "no information", never "silent for 29 million minutes" (2026-09-13)
    pr.logAgeMin = kv.logage !== undefined && Number(kv.logage) >= 0 ? Number(kv.logage) : null;
    pr.cpuPct = kv.cpu !== undefined && kv.cpu !== "" ? Number(kv.cpu) : null;
    Object.assign(pr, parseWork(kv, pr.logAgeMin));
    // quiet = runner alive, log not fresh (a chart just finished also idles the JVM for a minute), JVM under CPU_CALM
    pr.quietTicks = pr.runner > 0 && pr.cpuPct != null && pr.cpuPct < CPU_CALM && (pr.logAgeMin ?? 0) > 5 ? pr.quietTicks + 1 : 0;
    // 0. HRC up but its in-process bridge agent no longer answers on :8791 (seen on l1 and l4 at once, 2026-09-12 20:06Z,
    //    same JVM pid): every lock/refine/export call fails "nothing is answering on port 8791" and the runner exits with
    //    its charts marked FAIL. Re-injecting the agent into the running JVM fixes it in seconds — no restart, no lost hand.
    //    BUT a bridge that is busy is not a bridge that is dead: during a 6-max solve the agent does not answer /status
    //    within the probe's timeout, and re-injecting it mid-solve closes the solve's socket and hands out a NEW token —
    //    every job of the shard then fails "missing or bad X-Hrc-Token" (all four boxes at once, 2026-09-13 10:50Z).
    //    With the runner alive and the JVM working (CPU above CPU_CALM), the bridge is left alone.
    // NO RE-ATTACH WHILE A RUNNER IS ALIVE, whatever the CPU (2026-09-23). A solve has quiet stretches — the wizard's
    // single-threaded tree build, the export, the gap between refinement chunks — and a probe that landed in one read
    // "not solving" and re-attached the agent under it: the new agent's handle table is empty, so the runner's next call
    // failed "no such handle: h9" 80 min into a refinement and the chart restarted from scratch (P_BTN85_BB80_o2_5 on
    // hrc-l2, P_CO130_BTN85_SB120_BB80_o2_5 on hrc-l3; ~3 h lost between them). A bridge that is really dead fails the
    // runner's own calls, the runner exits, and the next tick re-attaches with nothing in flight.
    const solving = pr.runner > 0;
    if (pr.hrc === "active" && kv.bridge === "down" && !solving) {
      const t = await sshLinux(b.host, "HRC_BRIDGE_JAR=/root/hrc-api/bridge/build/hrc-bridge.jar /usr/local/bin/hrc-attach-bridge 2>&1 | tail -1", 120_000);
      pr.actions.push(`bridge agent was not answering -> re-attached: ${t.out.trim().split("\n").pop()?.slice(0, 80)}`);
    } else if (pr.hrc === "active" && kv.bridge === "down") {
      pr.actions.push(`bridge not answering, but the runner is alive and the JVM is at ${pr.cpuPct}% — a solve in progress, left alone`);
    }
    // 1. HRC unit down -> start it (the licence token is on disk; it comes back Pro)
    if (pr.hrc !== "active") { const t = await sshLinux(b.host, "systemctl start hrc; sleep 40; systemctl is-active hrc"); const st = t.out.trim().split("\n").pop() ?? pr.hrc; pr.actions.push(`hrc was ${pr.hrc} -> systemctl start -> ${st}`); pr.hrc = st; pr.hands = 0; }
    // 2. runner alive but HRC hung (JVM idle for 3 ticks, or no chart finished in 2 h) -> recycle HRC and the runner; step 4 relaunches
    const hung = pr.runner > 0 && ((pr.logAgeMin != null && pr.logAgeMin >= LINUX_STALL_MIN && (pr.cpuPct == null || pr.cpuPct < CPU_CALM)) || pr.quietTicks >= LINUX_QUIET_TICKS);
    if (hung) {
      const last = this.lastRestart.get(b.label) ?? 0;
      if (Date.now() - last > RESTART_COOLDOWN_MS) { await sshLinux(b.host, "pkill -f '[t]hreeMaxGrid'; systemctl restart hrc; sleep 40"); this.lastRestart.set(b.label, Date.now()); pr.actions.push(`shard silent ${pr.logAgeMin} min, JVM ${pr.cpuPct}% for ${pr.quietTicks} tick(s) -> HRC + runner recycled`); pr.runner = 0; pr.hands = 0; pr.quietTicks = 0; }
    }
    // 3. (no template hand needed since the mark-II driver: the wizard creates every hand, the bridge solves/exports it)
    // 4. work left but nothing running -> relaunch the shard runner (resumable: solved zips are skipped)
    if (pr.hrc === "active" && pr.runner === 0 && (pr.left ?? 0) > 0) {
      await sshLinux(b.host, `cd /root/hrc-api && (setsid nohup bash hetzner/run_linux_shard.sh ${b.plan} </dev/null >/dev/null 2>&1 &) ; sleep 1; pgrep -fc '[t]hreeMaxGrid'`);
      pr.actions.push(`runner was down with ${pr.left} chart(s) left -> relaunched ${b.plan}`); pr.runner = 1;
    }
    this.linuxProbes.set(b.label, pr);
    for (const a of pr.actions) this.log(b.label, a);
  }

  /** Every 10 min: pull finished zips from the Linux boxes into the ledger's OUT dir and parse them into charts. */
  private pullLinux(): void {
    if (!this.linuxBoxes().length || Date.now() - this.lastPull < 10 * 60_000) return;
    this.lastPull = Date.now();
    // report what the PREVIOUS pull did (its log), then start the next one DETACHED through Start-Process (ShellExecute):
    // a plain Bun.spawn child inherits this worker's listening socket and a minutes-long parse would pin port 2000 across
    // an API reload (the hang of 2026-09-11)
    const logPath = join(HRC_API_ZENBOOK, "solves", "threemax_asym", "linux_pull.log");
    // ONLY WHAT IS NEW (2026-09-14). pull_linux.sh APPENDS to this log forever, so re-reading the whole file every
    // tick reported the same cumulative list again and again - "120 chart(s) pulled + parsed: ign25_3maxasym2ci_..."
    // every 10 min for a day, none of it new, which is exactly the line you scan for when you want to know whether a
    // pull is still moving. Remember how far we have read (on disk, because this worker restarts) and report the tail.
    const markPath = join(jobsDir(), "linux_pull.offset");
    try {
      const size = statSync(logPath).size;
      let from = 0;
      try { const m = Number(readFileSync(markPath, "utf-8").trim()); if (Number.isFinite(m) && m >= 0) from = m; } catch { /* first run */ }
      if (from > size) from = 0;  // the log was rotated or truncated under us
      if (size > from) {
        // only the bytes [from, size): the mark below says we read exactly that far (reading the whole file to slice
        // it also re-reported anything appended between the stat and the read)
        const fresh = readRange(logPath, from, size).text;
        const pulled = fresh.split(/\r?\n/).filter((l) => l.startsWith("pulled ")).map((l) => l.split(" ")[1]);
        if (pulled.length) this.log("linux-pull", `${pulled.length} new chart(s) pulled + parsed: ${pulled.join(", ")}`);
        writeFileSync(markPath, String(size));
      }
    } catch { /* no log yet */ }
    try {
      // MSYS bash started hidden with no console never got past its own startup (2026-09-12: 12 copies, 19 h old, no
      // children, no log) — give it a console through cmd.exe exactly like jobs.ts launches its steps. pull_linux.sh is
      // single-flight (lock dir), so a pull that is still parsing is not doubled.
      const win = (p: string) => p.replace(/\//g, "\\");
      const cmdFile = join(jobsDir(), "linux_pull.cmd");
      writeFileSync(cmdFile, `@echo off\r\ncd /d "${win(HRC_API_ZENBOOK)}"\r\n"${win(BASH)}" hetzner/pull_linux.sh >> "${win(logPath)}" 2>&1\r\n`);
      Bun.spawn(["powershell", "-NoProfile", "-Command",
        `Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c','"${win(cmdFile)}"'`],
        { stdout: "ignore", stderr: "ignore" });
    } catch (e) { this.log("linux-pull", `failed to start: ${String(e).slice(0, 160)}`); }
  }


  /** A failed box job whose config still has work: queue it again on the same lane, with backoff and a cap. */
  private requeueFailed(): void {
    const now = Date.now();
    // the 3-max box relays AND the 6-max shard jobs (Windows boxJob + Linux linuxShardJob lanes) — 2026-09-13: the 6-max
    // jobs were never auto re-queued because only recipe "hrc-box" was considered
    const all = jobs.list(300).filter((j) => j.recipe === "hrc-box" || j.recipe === "hrc-box-6max");
    // ONLY WHEN A FAILED JOB GETS THAT FAR (2026-09-26). evaluate() rebuilds the chart catalog once its 60 s TTL has
    // run out — ~2,100 sidecars parsed, 0.4 s offline and 1.1-1.3 s on the loaded box — and this tick comes every
    // 3 min, so it always found the catalog stale: the keeper's "1088 ms open: timer boxKeeper (43.4 s)" stall at the
    // end of every tick. Almost every tick has no failed job to look at and never needs it.
    let ev: ReturnType<typeof evaluate> | null = null;
    // a job waiting for its inputs (a chained second pass) does not make the lane busy — 2026-09-13: the 14 waiting
    // second-pass jobs made every lane look busy and no failed first-pass job was ever re-queued
    const busyLanes = new Set(all.filter((j) => j.status === "running" || (j.status === "queued" && !j.waitInputs)).map((j) => j.lane));
    const knownLanes = new Set([
      ...this.boxes().filter((b) => b.host !== "local").map((b) => `hrc-box:${b.label}`),
      ...this.linuxBoxes().map((b) => `hrc-linux:${b.label}`),
    ]);
    // the newest job per config+lane, whatever its status: a failure is only "the current state" when nothing came after it.
    // A NEWER cancelled job is a human's decision (2026-09-12: after an API restart the keeper re-queued five whole-plan
    // jobs that had just been cancelled by hand for overlapping the 4-box shards — the attempts map is in memory only).
    const newest = new Map<string, number>();
    for (const j of all) { const k = `${j.config}|${j.lane}`; if (!newest.has(k)) newest.set(k, j.id); } // list is newest first
    for (const j of all) {                       // newest first
      if (j.status !== "failed" || !j.ended || now - j.ended > REQUEUE_WINDOW_MS) continue;
      const key = `${j.config}|${j.lane}`;
      if (newest.get(key) !== j.id) continue;    // something newer exists for this config+lane (re-queued, done, or cancelled by hand)
      if (busyLanes.has(j.lane)) continue;        // the lane is doing something — nothing to fix
      // the lane's box is no longer in the ledger (the Zenbook was dropped from hrc-box on 2026-09-13): its old
      // failures are history, not work to revive — re-queueing them just fails again until the retry cap
      if (!knownLanes.has(j.lane)) continue;
      if (j.exitCode === 3) continue;             // parity refused: deterministic, a human must look
      if ((ev ??= evaluate()).configs.find((c) => c.id === j.config)?.effective === "done") continue;
      const st = this.attempts.get(key) ?? { n: 0, lastFailedJob: 0 };
      if (st.lastFailedJob === j.id) continue;    // we already re-queued after this failure; wait for the new job's verdict
      if (progressOf(j) > 0) st.n = 0;            // the last try solved something: it is not a loop, start the count over
      if (st.n >= MAX_AUTO_REQUEUE) { if (!st.gaveUp) { st.gaveUp = true; this.attempts.set(key, st); this.log(j.lane, `GAVE UP on ${j.config}: ${MAX_AUTO_REQUEUE} re-queues without progress — needs a human`); } continue; }
      const backoffMs = Math.min(60, 3 * 2 ** st.n) * 60_000;
      if (now - j.ended < backoffMs) continue;
      const box = j.lane.replace(/^hrc-(box|linux):/, "");
      const r = jobs.enqueue(j.config, { boxes: [box], argsByBox: { [box]: extraArgsOf(j) } });
      if (r.ok) { st.n++; st.lastFailedJob = j.id; st.gaveUp = false; this.attempts.set(key, st); this.log(j.lane, `job #${j.id} (${j.config}) failed at ${new Date(j.ended).toISOString().slice(11, 16)}Z → re-queued as #${r.job.id} (auto try ${st.n}/${MAX_AUTO_REQUEUE}, backoff was ${backoffMs / 60000} min)`); }
      else this.log(j.lane, `re-queue of ${j.config} refused: ${r.error}`);
    }
  }
}

/** charts the failed relay did pull+parse ("done: 2/76 pulled+parsed") — progress means the failure is not a loop.
 *  The LAST such line, read from the end of the log rather than the whole of it. */
function progressOf(j: JobRow): number {
  try { const m = lastMatch(j.logPath, /done: (\d+)\/\d+ pulled\+parsed/g); return m ? Number(m[1]) : 0; } catch { return 0; }
}
/** the runner args the failed job was started with (after `--name <config>`), e.g. ["--order","reverse"] */
function extraArgsOf(j: JobRow): string[] {
  const step = j.steps.find((s) => s.cmd.some((x) => /(boxJob|linuxShardJob)\.ts$/.test(x)));
  if (!step) return [];
  const i = step.cmd.indexOf("--name");
  let extra = i >= 0 ? step.cmd.slice(i + 2) : [];
  // the ORIGINAL shard sits before --name in the 6-max fan-out: carry it explicitly (both runners take the LAST --shard),
  // else a re-queued lane walks the whole plan and every re-queued box solves the same trees (2026-09-13 18:00Z)
  const si = step.cmd.indexOf("--shard");
  if (si >= 0 && !extra.includes("--shard")) extra = [...extra, "--shard", step.cmd[si + 1]!];
  // a re-queue is a one-box fan-out (--shard 0/1): carry the ORIGINAL shard so a member of a 4-box run keeps its quarter
  // instead of walking the whole plan against the other three (boxJob: the last --shard wins). Seen 2026-09-12 (#118).
  const s = step.cmd.indexOf("--shard");
  return s >= 0 && !extra.includes("--shard") ? ["--shard", step.cmd[s + 1]!, ...extra] : extra;
}

export const boxKeeper = new BoxKeeper();
