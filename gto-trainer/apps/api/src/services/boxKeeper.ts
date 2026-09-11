import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, loadLedger, evaluate } from "./ledger";
import { jobs, HRC_API_ZENBOOK, BASH, type JobRow } from "./jobs";

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
const STALL_MIN = 5 * 60;             // batch log untouched this long while HRCJob says Running = HRC is hung
const RDP_IDLE_MIN = 10;              // move an RDP session to the console only once its user has walked away
const RESTART_COOLDOWN_MS = 30 * 60_000;
const MAX_AUTO_REQUEUE = 8;
const REQUEUE_WINDOW_MS = 48 * 3600_000;
const LOG_PATH = join(DATA_DIR, "jobs", "box_keeper.log");

interface Box { label: string; host: string }
/** A Linux HRC box (hetzner kit, bridge driver): HRC as a systemd unit, one template hand open, a shard runner on `plan`. */
interface LinuxBox { label: string; host: string; plan: string }
export interface LinuxProbe { at: number; ok: boolean; error?: string; hrc: string; hands: number; runner: number; logAgeMin: number | null; left: number | null; actions: string[] }
export interface Probe {
  at: number; ok: boolean; error?: string;
  hrc: boolean; job: string; logAgeMin: number | null; session: string; sessionId: string | null; idleMin: number | null; restartTask: boolean;
  actions: string[];
}
interface Attempts { n: number; lastFailedJob: number; gaveUp?: boolean }

const REMOTE_PROBE = `
$p = Get-Process hrc -ErrorAction SilentlyContinue; "hrc=" + [bool]$p
"job=" + (Get-ScheduledTask HRCJob -ErrorAction SilentlyContinue).State
$l = Get-Item C:\\poker\\jobs\\threeMaxGrid.log -ErrorAction SilentlyContinue; "logage=" + $(if ($l) { [int]((Get-Date) - $l.LastWriteTime).TotalMinutes } else { -1 })
"session=" + (((quser 2>$null | Select-String administrator) -replace '\\s+', ' ') -join ' | ')
"restarttask=" + [bool](Get-ScheduledTask HRCRestart -ErrorAction SilentlyContinue)
`;

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
  const proc = Bun.spawn([SSH, "-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", `Administrator@${host}`, `powershell -NoProfile -EncodedCommand ${enc}`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME } });
  const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout as any).text(), new Response(proc.stderr as any).text()]);
  const code = await proc.exited; clearTimeout(killer);
  const errLines = err.split(/\r?\n/).filter((l) => l.trim() && !/post-quantum|store now|openssh\.com\/pq/.test(l));
  return { code, out: out + (code !== 0 && errLines.length ? `\n${errLines.join("\n")}` : "") };
}

async function sshLinux(host: string, cmd: string, timeoutMs = 90_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([SSH, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", `root@${host}`, cmd], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME } });
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
  private linuxProbes = new Map<string, LinuxProbe>();
  private lastPull = 0;
  private attempts = new Map<string, Attempts>();
  private lastRestart = new Map<string, number>();
  private recent: string[] = [];

  start(): void {
    if (this.timer) return;
    mkdirSync(join(DATA_DIR, "jobs"), { recursive: true });
    this.log("keeper", `started: tick ${TICK_MS / 60000} min, stall ${STALL_MIN / 60} h, rdp idle ${RDP_IDLE_MIN} min, max ${MAX_AUTO_REQUEUE} auto re-queues`);
    setTimeout(() => void this.tick(), 20_000);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }
  status() { return { boxes: Object.fromEntries(this.probes), linux: Object.fromEntries(this.linuxProbes), attempts: Object.fromEntries(this.attempts), recent: this.recent.slice(-60) }; }

  private log(who: string, msg: string): void {
    const line = `[${new Date().toISOString().slice(0, 19)}] ${who}: ${msg}`;
    this.recent.push(line); if (this.recent.length > 200) this.recent.shift();
    try { appendFileSync(LOG_PATH, line + "\n"); } catch { /* no log dir yet */ }
  }
  private boxes(): Box[] { return ((loadLedger() as any).boxes?.["hrc-box"] ?? []) as Box[]; }
  private linuxBoxes(): LinuxBox[] { return ((loadLedger() as any).boxes?.["hrc-linux"] ?? []) as LinuxBox[]; }

  private async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const remote = this.boxes().filter((b) => b.host !== "local");
      await Promise.all([...remote.map((b) => this.keepBox(b)), ...this.linuxBoxes().map((b) => this.keepLinuxBox(b))]);
      this.requeueFailed();
      this.pullLinux();
    } catch (e) { this.log("keeper", `tick error: ${String(e).slice(0, 200)}`); }
    finally { this.busy = false; }
  }

  /** One box: probe, then repair whatever is wrong. */
  private async keepBox(b: Box): Promise<void> {
    const pr: Probe = { at: Date.now(), ok: false, hrc: false, job: "?", logAgeMin: null, session: "?", sessionId: null, idleMin: null, restartTask: false, actions: [] };
    const r = await ssh(b.host, REMOTE_PROBE);
    if (r.code !== 0) { pr.error = r.out.trim().split("\n").pop()?.slice(0, 160) ?? `ssh exited ${r.code}`; this.probes.set(b.label, pr); this.log(b.label, `unreachable: ${pr.error}`); return; }
    const kv = Object.fromEntries(r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    pr.ok = true; pr.hrc = kv.hrc === "True"; pr.job = kv.job || "none"; pr.restartTask = kv.restarttask === "True";
    pr.logAgeMin = kv.logage != null && Number(kv.logage) >= 0 ? Number(kv.logage) : null;
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
    // 3. HRC up, batch says Running, but nothing written for hours → the JVM is hung → graceful restart, at most every 30 min
    else if (pr.job === "Running" && pr.logAgeMin != null && pr.logAgeMin >= STALL_MIN) {
      const last = this.lastRestart.get(b.label) ?? 0;
      if (Date.now() - last > RESTART_COOLDOWN_MS && pr.restartTask) {
        const t = await ssh(b.host, `Start-ScheduledTask HRCRestart; "started"`);
        this.lastRestart.set(b.label, Date.now());
        pr.actions.push(`batch silent ${pr.logAgeMin} min with HRCJob Running → HRCRestart (${t.code === 0 ? "started" : "failed"})`);
      }
    }
    this.probes.set(b.label, pr);
    for (const a of pr.actions) this.log(b.label, a);
  }

  /** One Linux box: HRC unit up, the bridge's template hand open, the shard runner alive while its plan has work left. */
  private async keepLinuxBox(b: LinuxBox): Promise<void> {
    const pr: LinuxProbe = { at: Date.now(), ok: false, hrc: "?", hands: 0, runner: 0, logAgeMin: null, left: null, actions: [] };
    const probe = `systemctl is-active hrc; cd /root/hrc-api; echo "runner=$(pgrep -fc '[t]hreeMaxGrid')"; echo "hands=-1"; L=/tmp/$(basename ${b.plan} .json).log; echo "logage=$(( ($(date +%s) - $(stat -c %Y $L 2>/dev/null || echo 0)) / 60 ))"; echo "left=$(python3 -c "import json,os; p=json.load(open('${b.plan}')); d=os.path.dirname('${b.plan}'); print(sum(1 for j in p if not os.path.exists(os.path.join(d, j['id']+'.strategies.zip'))))" 2>/dev/null)"`;
    const r = await sshLinux(b.host, probe);
    if (r.code !== 0 && !r.out.includes("runner=")) { pr.error = r.out.trim().split("\n").pop()?.slice(0, 160) ?? `ssh exited ${r.code}`; this.linuxProbes.set(b.label, pr); this.log(b.label, `unreachable: ${pr.error}`); return; }
    const lines = r.out.split(/\r?\n/).map((l) => l.trim());
    pr.ok = true; pr.hrc = lines[0] ?? "?";
    const kv = Object.fromEntries(lines.filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    pr.runner = Number(kv.runner ?? 0); pr.hands = Number(kv.hands ?? 0); pr.left = kv.left !== undefined && kv.left !== "" ? Number(kv.left) : null;
    pr.logAgeMin = kv.logage !== undefined ? Number(kv.logage) : null;
    // 1. HRC unit down -> start it (the licence token is on disk; it comes back Pro)
    if (pr.hrc !== "active") { const t = await sshLinux(b.host, "systemctl start hrc; sleep 40; systemctl is-active hrc"); const st = t.out.trim().split("\n").pop() ?? pr.hrc; pr.actions.push(`hrc was ${pr.hrc} -> systemctl start -> ${st}`); pr.hrc = st; pr.hands = 0; }
    // 2. runner alive but silent for hours -> HRC hung: recycle HRC and let step 4 relaunch the shard
    if (pr.runner > 0 && pr.logAgeMin != null && pr.logAgeMin >= STALL_MIN) {
      const last = this.lastRestart.get(b.label) ?? 0;
      if (Date.now() - last > RESTART_COOLDOWN_MS) { await sshLinux(b.host, "pkill -f '[t]hreeMaxGrid'; systemctl restart hrc; sleep 40"); this.lastRestart.set(b.label, Date.now()); pr.actions.push(`shard silent ${pr.logAgeMin} min -> HRC + runner recycled`); pr.runner = 0; pr.hands = 0; }
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
    try {
      const prev = readFileSync(logPath, "utf-8");
      const pulled = prev.split(/\r?\n/).filter((l) => l.startsWith("pulled ")).map((l) => l.split(" ")[1]);
      if (pulled.length) this.log("linux-pull", `${pulled.length} chart(s) pulled + parsed: ${pulled.join(", ")}`);
    } catch { /* first run */ }
    try {
      Bun.spawn(["powershell", "-NoProfile", "-Command",
        `Start-Process -WindowStyle Hidden -FilePath '${BASH}' -ArgumentList '-c','bash hetzner/pull_linux.sh > solves/threemax_asym/linux_pull.log 2>&1' -WorkingDirectory '${HRC_API_ZENBOOK}'`],
        { stdout: "ignore", stderr: "ignore" });
    } catch (e) { this.log("linux-pull", `failed to start: ${String(e).slice(0, 160)}`); }
  }


  /** A failed box job whose config still has work: queue it again on the same lane, with backoff and a cap. */
  private requeueFailed(): void {
    const now = Date.now();
    const all = jobs.list(300).filter((j) => j.recipe === "hrc-box");
    const ev = evaluate();
    const busyLanes = new Set(all.filter((j) => j.status === "queued" || j.status === "running").map((j) => j.lane));
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
      if (j.exitCode === 3) continue;             // parity refused: deterministic, a human must look
      if (ev.configs.find((c) => c.id === j.config)?.effective === "done") continue;
      const st = this.attempts.get(key) ?? { n: 0, lastFailedJob: 0 };
      if (st.lastFailedJob === j.id) continue;    // we already re-queued after this failure; wait for the new job's verdict
      if (progressOf(j) > 0) st.n = 0;            // the last try solved something: it is not a loop, start the count over
      if (st.n >= MAX_AUTO_REQUEUE) { if (!st.gaveUp) { st.gaveUp = true; this.attempts.set(key, st); this.log(j.lane, `GAVE UP on ${j.config}: ${MAX_AUTO_REQUEUE} re-queues without progress — needs a human`); } continue; }
      const backoffMs = Math.min(60, 3 * 2 ** st.n) * 60_000;
      if (now - j.ended < backoffMs) continue;
      const box = j.lane.replace(/^hrc-box:/, "");
      const r = jobs.enqueue(j.config, { boxes: [box], argsByBox: { [box]: extraArgsOf(j) } });
      if (r.ok) { st.n++; st.lastFailedJob = j.id; st.gaveUp = false; this.attempts.set(key, st); this.log(j.lane, `job #${j.id} (${j.config}) failed at ${new Date(j.ended).toISOString().slice(11, 16)}Z → re-queued as #${r.job.id} (auto try ${st.n}/${MAX_AUTO_REQUEUE}, backoff was ${backoffMs / 60000} min)`); }
      else this.log(j.lane, `re-queue of ${j.config} refused: ${r.error}`);
    }
  }
}

/** charts the failed relay did pull+parse ("done: 2/76 pulled+parsed") — progress means the failure is not a loop */
function progressOf(j: JobRow): number {
  try { const m = readFileSync(j.logPath, "utf-8").match(/done: (\d+)\/\d+ pulled\+parsed/g); return m ? Number(m[m.length - 1]!.match(/(\d+)\//)![1]) : 0; } catch { return 0; }
}
/** the runner args the failed job was started with (after `--name <config>`), e.g. ["--order","reverse"] */
function extraArgsOf(j: JobRow): string[] {
  const step = j.steps.find((s) => s.cmd.some((x) => /boxJob\.ts$/.test(x)));
  if (!step) return [];
  const i = step.cmd.indexOf("--name");
  return i >= 0 ? step.cmd.slice(i + 2) : [];
}

export const boxKeeper = new BoxKeeper();
