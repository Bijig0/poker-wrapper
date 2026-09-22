import { Database } from "bun:sqlite";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, LIMP, MES_HANDOFF, HRC_API, REPO, loadLedger, evaluate, type LedgerConfig } from "./ledger";
import { isBackgroundOwner } from "./backgroundLock";
/** The checkout of hrc-api whose Windows driver carries the Run-Nash refinement (8 commits ahead of this repo's hrc-api). */
export const HRC_API_ZENBOOK = process.env.HRC_API_ZENBOOK ?? "C:/Users/Brady/poker-zenbook/hrc-api";

/**
 * The ORCHESTRATOR — runs a config's recipe as a job, one at a time per lane,
 * with the log kept on disk, so a solve is always started from the ledger's
 * definition and never from a shell with the wrong env in it.
 *
 * Lanes: "scripts" (python pipeline, serial), "hrc-zenbook" (HRC on this
 * machine — the job WRITES the plan + runner queue and opens HRC Runner; the
 * solve itself runs there), "fleet" (Hetzner — the job writes the runbook;
 * boxes are provisioned by hand from it). A job is a list of steps; a step
 * is a command in a cwd with an env; the first failing step fails the job.
 */

// the interpreters this machine runs the recipes with; env overrides for a Linux deployment (PY=python3 BASH=bash BUN=bun)
export const PY = process.env.PY ?? "C:\\Users\\Brady\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";
export const BASH = process.env.BASH ?? "C:/Program Files/Git/bin/bash.exe"; // forward slashes: Bun.spawn accepts them and nothing can eat a backslash
export const BUN = process.env.BUN ?? "C:\\Users\\Brady\\AppData\\Local\\Programs\\node-v24.18.0-win-x64\\node_modules\\bun\\bin\\bun.exe";
const LOG_DIR = join(DATA_DIR, "jobs");

/**
 * Windows: a child process inherits this server's LISTENING socket handle. When the API worker restarts (bun --watch)
 * the box runners it spawned keep port 2000 bound but never accept — the new worker cannot bind and every request
 * hangs (seen 2026-09-09). So at module load, before the server binds, any runner left over from a previous worker
 * is killed; the orchestrator re-queues its job and the fresh runner ATTACHES to the box's run without losing anything.
 */
if (process.platform === "win32") {
  try {
    // fire-and-forget: WMI on this laptop sometimes takes minutes and spawnSync's timeout is not honoured on Windows —
    // a synchronous sweep then blocks the whole boot (the API never listened for 10+ min, 2026-09-12). The leftover
    // runners die a moment later either way; the keeper re-queues their jobs.
    Bun.spawn(["powershell", "-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { $_.CommandLine -like '*scripts?boxJob.ts*' -or $_.CommandLine -like '*scripts?linuxShardJob.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { stdout: "ignore", stderr: "ignore" });
  } catch { /* best effort */ }
}

export interface Step { label: string; cmd: string[]; cwd: string; env?: Record<string, string> }
export interface JobRow { id: number; config: string; recipe: string; lane: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; created: number; started: number | null; ended: number | null; exitCode: number | null; logPath: string; note: string | null; steps: Step[]; waitInputs: boolean }

const DDL = `CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, config TEXT, recipe TEXT, lane TEXT, status TEXT NOT NULL,
  created INTEGER, started INTEGER, ended INTEGER, exit_code INTEGER, log_path TEXT, note TEXT, steps_json TEXT
)`;

/** Recipes: what a config's kind actually runs. Env from the config wins. */
export interface Recipe { lane: string; steps: Step[]; note: string; fanout?: { lane: string; steps: Step[]; note: string }[] }
/** Per-run options for the hrc-box recipe: restrict the fan-out to some boxes (by label) and add runner args per box
 *  (e.g. a box joining a run in progress: `--shard 0/1 --order reverse` so it works the tail while the others work the head). */
export interface RunOpts { boxes?: string[]; argsByBox?: Record<string, string[]> }
/** The 6-max plan for a config: where it is written and the generator step that writes it (args from the config's env). */
export function sixMaxPlan(c: LedgerConfig): { api: string; planDir: string; gen: Step } {
  const env = { ...(c.env ?? {}) };
  const api = env.HRC_API ?? HRC_API_ZENBOOK;
  const planDir = join(api, "solves", "sixmax_grid", c.id);
  // the heads-up SnG grid: same plan layout and box fan-out, a different generator (the depth ladder, antes and the
  // level-1 small blind come from the published turbo structure inside genHuSngPlan.ts, not from the config's env)
  if (c.kind === "preflop-grid-hu") {
    return { api, planDir, gen: { label: "write the HU SnG plan", cmd: [BUN, "run", join(api, "scripts", "genHuSngPlan.ts"), "--out", join(planDir, "plan_6max.json"), "--name", c.id], cwd: api, env } };
  }
  const args = ["--sites", env.SITES ?? "ign200", "--out", planDir, "--name", c.id];
  if (env.DEPTHS) args.push("--depths", env.DEPTHS);
  if (env.OPENS) args.push("--opens", env.OPENS);
  if (env.GRID === "off") args.push("--grid", "off");
  if (env.ASYM) args.push("--asym", env.ASYM);
  // explicit per-seat stack vectors (the miss-queue patch charts): solves/sixmax_grid/<config>/states.json
  if (env.STATES) args.push("--states", env.STATES);
  if (env.LEAN === "1") args.push("--lean");
  if (env.REFINE_MULT) args.push("--refine-mult", env.REFINE_MULT);
  return { api, planDir, gen: { label: "write the 6-max plan + runner queue", cmd: [BUN, "run", join(api, "scripts", "genSixMaxPlan.ts"), ...args], cwd: api, env } };
}

/** The 3-max grid's plan (Brady, 2026-09-19). Same layout as the 6-max one, a different generator:
 *  genThreeMaxAsymPlan.ts emits ONE rich tree per stack state with every open size in its level-1 menu,
 *  which is why a 3-max chart id carries no open size. Every job it writes now carries a refineMin —
 *  the original generation had none, which is what boxJob.ts's guard refuses and what measured 1.03
 *  bb/hand of exploitability. */
export function threeMaxPlan(c: LedgerConfig): { api: string; planDir: string; gen: Step } {
  const env = { ...(c.env ?? {}) };
  const api = env.HRC_API ?? HRC_API_ZENBOOK;
  const planDir = join(api, "solves", "threemax_asym", c.id);
  const args = ["--sites", env.SITES ?? env.CASH_SITE ?? "ign200", "--out", planDir, "--name", c.id];
  if (env.GEN) args.push("--gen", env.GEN);
  if (env.DEPTHS) args.push("--depths", env.DEPTHS);
  if (env.SHORTS) args.push("--shorts", env.SHORTS);
  if (env.STATES) args.push("--states", env.STATES);
  if (env.SEATS) args.push("--seats", env.SEATS);
  if (env.OPENS) args.push("--opens", env.OPENS);
  if (env.REFINE_MULT) args.push("--refine-mult", env.REFINE_MULT);
  return { api, planDir, gen: { label: "write the 3-max plan + runner queue", cmd: [BUN, "run", join(api, "scripts", "genThreeMaxAsymPlan.ts"), ...args], cwd: api, env } };
}

export function recipeFor(c: LedgerConfig, ro: RunOpts = {}): Recipe | null {
  const env = { ...(c.env ?? {}) };
  switch (c.recipe) {
    case "pool-model":
      // villain_freqs.json is measured from the hand corpus, not from a chart: only the base (unsuffixed) build refreshes it
      return { lane: "scripts", note: "build_pool_model.py → poolEvTables" + (env.OUT_SUFFIX ? "" : " → villain_freqs"), steps: [
        { label: "pool model", cmd: [PY, "build_pool_model.py"], cwd: LIMP, env },
        // hero's postflop EV per hand class vs the pool's ranges: 11 matchup families × 14 flops, range-vs-range in GTO Wizard AI
        // (the exploit accountant and the winrate ladder read pool_ev_tables<suffix>.json — without it the exploit step cannot run)
        { label: "postflop EV tables (GTOW range-vs-range, 11 families × 14 flops)", cmd: [BUN, "run", join(REPO, "gto-trainer", "apps", "api", "src", "scripts", "poolEvTables.ts")], cwd: join(REPO, "gto-trainer", "apps", "api"), env },
        ...(env.OUT_SUFFIX ? [] : [{ label: "villain frequencies", cmd: [PY, "build_villain_freqs.py"], cwd: LIMP, env }]),
      ] };
    case "exploit-export":
      return { lane: "scripts", note: "export the exploit ranges, re-run the ladder and the strategy matrix", steps: [
        { label: "export exploit ranges", cmd: [PY, "export_exploit_ranges.py"], cwd: LIMP, env },
        { label: "winrate ladder", cmd: [PY, "backtest_study_answers.py"], cwd: LIMP, env },
        { label: "strategy matrix", cmd: [PY, "strategy_matrix.py"], cwd: LIMP, env },
      ] };
    case "mes-build":
      return { lane: "scripts", note: "compile the locked runs into mes_postflop.json (stamped) and re-price the reach", steps: [
        { label: "build MES artifact", cmd: [PY, "build_mes_study.py"], cwd: MES_HANDOFF, env },
        { label: "reach value", cmd: [PY, "mes_reach_value.py", "--out", join(DATA_DIR, "mes_reach_value.json")], cwd: LIMP, env },
      ] };
    case "mes-fleet": {
      // the whole MES re-solve for one preflop layer: specs → bundle → boxes → solve → archive/pull/install
      const tag = env.FLEET_TAG ?? c.id.replace(/^mes-/, "");
      const suffix = env.SPEC_SUFFIX ?? `_${tag}`;
      const exploit = env.EXPLOIT_RANGES ?? join(LIMP, "exploit_ranges.json");
      const pool = env.POOL_MODEL ?? join(LIMP, "pool_model_v4.json");
      const fleet = (phase: string) => ({ label: `fleet ${phase}`, cmd: [BASH, join(MES_HANDOFF, "fleet_ledger.sh"), tag, suffix, phase], cwd: MES_HANDOFF, env });
      return { lane: "fleet", note: "make_specs → bundle → create 4 boxes → launch → finish (archive to R2, delete boxes, pull, build mes_postflop.json)", steps: [
        { label: "family specs", cmd: [PY, "make_specs.py", "--exploit", exploit, "--pool", pool, "--suffix", suffix, "--shards", "4"], cwd: MES_HANDOFF, env },
        fleet("bundle"), fleet("create"), fleet("launch"), fleet("finish"),
      ] };
    }
    case "hrc-box": {
      // plan from the ledger, then ONE job per box: each box solves its shard inside its desktop session
      // (boxJob.ts: parity guard → ship → start → poll → pull → parse), so the lanes are the boxes.
      const allBoxes: { label: string; host: string }[] = (loadLedger() as any).boxes?.["hrc-box"] ?? [];
      const boxes = ro.boxes?.length ? allBoxes.filter((b) => ro.boxes!.includes(b.label)) : allBoxes;
      if (!boxes.length) return null;
      const planDir = join(HRC_API, "solves", "threemax_asym", "ledger", c.id);
      const write: Step = { label: "write the HRC plan from the ledger", cmd: [BUN, "run", join(HRC_API, "scripts", "ledgerPlan.ts"), c.id, planDir], cwd: HRC_API, env };
      const n = boxes.length;
      const fanout = boxes.map((b, i) => ({
        lane: `hrc-box:${b.label}`, note: `${b.label} · shard ${i + 1}/${n}`,
        steps: [write, { label: `solve shard ${i + 1}/${n} on ${b.label}`, cwd: HRC_API_ZENBOOK,
          cmd: [BUN, "run", join(HRC_API_ZENBOOK, "scripts", "boxJob.ts"), join(planDir, "plan.json"), b.host, "--out", join(HRC_API_ZENBOOK, "solves", "threemax_asym"), "--shard", `${i}/${n}`, "--name", c.id, ...(ro.argsByBox?.[b.label] ?? [])],
          env: { ...env, HRC_CONVERTER: join(REPO, "analysis", "pipeline", "solve", "hrc_to_preflop.py") } }],
      }));
      return { lane: fanout[0]!.lane, steps: fanout[0]!.steps, note: `HRC on ${n} box(es): parity guard, ship, solve, pull, parse`, fanout };
    }
    case "hrc-plan": {
      // write the plan + runner queue for THIS config, then open HRC Runner on it
      const planDir = join(HRC_API, "solves", "threemax_asym", "ledger", c.id);
      return { lane: "hrc-zenbook", note: "writes the HRC plan + runner queue for this config and opens HRC Runner on it; the solve runs there", steps: [
        { label: "write plan + queue", cmd: [BUN, "run", join(HRC_API, "scripts", "ledgerPlan.ts"), c.id, planDir], cwd: HRC_API, env },
        { label: "open HRC Runner", cmd: ["cmd", "/c", "start", "", "C:\\Users\\Brady\\Desktop\\HRC Runner.cmd", join(planDir, "queue.json")], cwd: HRC_API, env },
      ] };
    }
    case "hrc-plan-6max": {
      // the 6-max grid on this machine: the generator writes the plan + the HRC Runner queue from its own
      // depth-scaled size menus (poker-zenbook/hrc-api/scripts/genSixMaxPlan.ts — the checkout whose Windows
      // driver has the Run-Nash refinement step); the solves run in HRC Runner, pilot first.
      const { api, planDir, gen } = sixMaxPlan(c);
      return { lane: "hrc-zenbook", note: `writes the 6-max plan + runner queue for ${c.id} and opens HRC Runner on it; the solves run there, pilot first`, steps: [
        gen,
        { label: "open HRC Runner", cmd: ["cmd", "/c", "start", "", "C:\\Users\\Brady\\Desktop\\HRC Runner.cmd", join(planDir, "queue_6max.json")], cwd: api, env },
      ] };
    }
    case "hrc-box-6max": {
      // the 6-max grid across EVERY HRC machine: the Vultr Windows boxes + the Zenbook (host "local") run boxJob.ts,
      // the Hetzner Linux boxes run linuxShardJob.ts (ship the shard, hand the runner to the box keeper, pull + parse);
      // one job per machine, each solving shard i/n of the same plan — the two runners split the plan with the same rule.
      const allWin: { label: string; host: string }[] = (loadLedger() as any).boxes?.["hrc-box"] ?? [];
      const allLin: { label: string; host: string; plan?: string }[] = (loadLedger() as any).boxes?.["hrc-linux"] ?? [];
      const win = ro.boxes?.length ? allWin.filter((b) => ro.boxes!.includes(b.label)) : allWin;
      const lin = ro.boxes?.length ? allLin.filter((b) => ro.boxes!.includes(b.label)) : allLin;
      const n = win.length + lin.length;
      if (!n) return null;
      const { planDir, gen } = sixMaxPlan(c);
      const conv = { ...env, HRC_CONVERTER: join(REPO, "analysis", "pipeline", "solve", "hrc_to_preflop.py") };
      const fanout = [
        ...win.map((b, i) => ({
          lane: `hrc-box:${b.label}`, note: `${b.label} · shard ${i + 1}/${n}`,
          steps: [gen, { label: `solve shard ${i + 1}/${n} on ${b.label}`, cwd: HRC_API_ZENBOOK,
            cmd: [BUN, "run", join(HRC_API_ZENBOOK, "scripts", "boxJob.ts"), join(planDir, "plan_6max.json"), b.host, "--out", planDir, "--shard", `${i}/${n}`, "--name", c.id, "--no-pull", ...(env.REMOTE_OUT ? ["--remote-out", env.REMOTE_OUT] : []), ...(ro.argsByBox?.[b.label] ?? [])],
            env: conv }],
        })),
        ...lin.map((b, k) => { const i = win.length + k; return {
          lane: `hrc-linux:${b.label}`, note: `${b.label} · shard ${i + 1}/${n} (Linux)`,
          steps: [gen, { label: `solve shard ${i + 1}/${n} on ${b.label} (Linux)`, cwd: HRC_API_ZENBOOK,
            cmd: [BUN, "run", join(HRC_API_ZENBOOK, "scripts", "linuxShardJob.ts"), join(planDir, "plan_6max.json"), b.label, b.host, "--shard", `${i}/${n}`, "--out", planDir, "--name", c.id, "--ledger", join(DATA_DIR, "ledger.json"), "--remote-dir", `solves/sixmax_grid/${c.id}`, ...(ro.argsByBox?.[b.label] ?? [])],
            env: conv }],
        }; }),
      ];
      return { lane: fanout[0]!.lane, steps: fanout[0]!.steps, note: `6-max trees on ${n} machine(s) (${win.length} Windows, ${lin.length} Linux): ship, solve, pull, parse`, fanout };
    }
    case "hrc-box-3max": {
      // the 3-max grid across the HRC fleet, the same dual fan-out hrc-box-6max uses: the Windows boxes run
      // boxJob.ts, the Hetzner Linux boxes run linuxShardJob.ts, each solving shard i/n of one plan. The only
      // differences from the 6-max case are the generator and the plan's filename (plan_3max.json).
      const allWin: { label: string; host: string }[] = (loadLedger() as any).boxes?.["hrc-box"] ?? [];
      const allLin: { label: string; host: string }[] = (loadLedger() as any).boxes?.["hrc-linux"] ?? [];
      const win = ro.boxes?.length ? allWin.filter((b) => ro.boxes!.includes(b.label)) : allWin;
      const lin = ro.boxes?.length ? allLin.filter((b) => ro.boxes!.includes(b.label)) : allLin;
      const n = win.length + lin.length;
      if (!n) return null;
      const { planDir, gen } = threeMaxPlan(c);
      const plan = join(planDir, "plan_3max.json");
      const conv = { ...env, HRC_CONVERTER: join(REPO, "analysis", "pipeline", "solve", "hrc_to_preflop.py") };
      const fanout = [
        ...win.map((b, i) => ({
          lane: `hrc-box:${b.label}`, note: `${b.label} · shard ${i + 1}/${n}`,
          steps: [gen, { label: `solve shard ${i + 1}/${n} on ${b.label}`, cwd: HRC_API_ZENBOOK,
            cmd: [BUN, "run", join(HRC_API_ZENBOOK, "scripts", "boxJob.ts"), plan, b.host, "--out", planDir, "--shard", `${i}/${n}`, "--name", c.id, "--no-pull", ...(ro.argsByBox?.[b.label] ?? [])],
            env: conv }],
        })),
        ...lin.map((b, k) => { const i = win.length + k; return {
          lane: `hrc-linux:${b.label}`, note: `${b.label} · shard ${i + 1}/${n} (Linux)`,
          steps: [gen, { label: `solve shard ${i + 1}/${n} on ${b.label} (Linux)`, cwd: HRC_API_ZENBOOK,
            cmd: [BUN, "run", join(HRC_API_ZENBOOK, "scripts", "linuxShardJob.ts"), plan, b.label, b.host, "--shard", `${i}/${n}`, "--out", planDir, "--name", c.id, "--ledger", join(DATA_DIR, "ledger.json"), "--remote-dir", `solves/threemax_asym/${c.id}`, ...(ro.argsByBox?.[b.label] ?? [])],
            env: conv }],
        }; }),
      ];
      return { lane: fanout[0]!.lane, steps: fanout[0]!.steps, note: `3-max rich trees on ${n} machine(s) (${win.length} Windows, ${lin.length} Linux): ship, solve, pull, parse`, fanout };
    }
    default:
      return null;
  }
}

class Jobs {
  private db: Database | null = null;
  private running: Map<string, { id: number; proc: ReturnType<typeof Bun.spawn> | null; pid?: number; cancel: boolean; step: number; stepStarted: number }> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  private open(): Database {
    if (this.db) return this.db;
    mkdirSync(LOG_DIR, { recursive: true });
    this.db = new Database(join(DATA_DIR, "jobs.sqlite"));
    // Wait for a writer to finish instead of throwing SQLITE_BUSY the instant the lock is held.
    // Without it a momentary lock on one statement threw `database is locked` out of a 3-second
    // setInterval and killed the whole process — dashboard, poller, keeper and job dispatcher with
    // it (seen in data/jobs/api.log at jobs.ts:187, 2026-09-14).
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode=WAL"); this.db.exec(DDL);
    try { this.db.exec("ALTER TABLE jobs ADD COLUMN wait_inputs INTEGER DEFAULT 0"); } catch { /* already there */ }
    // the detached step's pid and which step it is on: what lets a restart ADOPT a driver that outlived us
    try { this.db.exec("ALTER TABLE jobs ADD COLUMN pid INTEGER"); } catch { /* already there */ }
    try { this.db.exec("ALTER TABLE jobs ADD COLUMN step INTEGER DEFAULT 0"); } catch { /* already there */ }
    // NB: reconciling what a dead process left "running" used to happen HERE, on every db open. It is
    // now reconcile(), called once from start() — opening the database is a read path too (list/get),
    // and a stray statement on it is what threw `database is locked` out of the dispatch timer.
    return this.db;
  }
  /** The dispatch tick NEVER throws out of its timer: an uncaught error in a setInterval callback
   *  takes the whole process down, and on 2026-09-14 a transient `database is locked` on the re-queue
   *  UPDATE did exactly that — killing the dashboard, the study poller, the token keeper and the box
   *  keeper along with the dispatcher. A tick that fails is logged and retried 3 seconds later. */
  start(): void {
    if (!this.timer) {
      try { this.reconcile(); } catch (e) { console.error(`[jobs] reconcile failed: ${(e as Error)?.stack ?? String(e)}`); }
    }
    if (!this.timer) this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { console.error(`[jobs] dispatch tick failed (retrying in 3 s): ${(e as Error)?.stack ?? String(e)}`); }
    }, 3000);
  }

  /** Is `pid` still the detached step we launched? Alive, and still a cmd/bun process (a bare
   *  process.kill(pid, 0) would be fooled by pid reuse). Same reasoning as services/backgroundLock.ts. */
  private aliveStep(pid: number): boolean {
    if (!(pid > 0)) return false;
    try { process.kill(pid, 0); } catch (e: any) { if (e?.code !== "EPERM") return false; }
    try {
      const r = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { stdout: "pipe", stderr: "ignore" });
      const out = r.stdout.toString().toLowerCase();
      if (!out.includes(String(pid))) return false;
      return out.includes("cmd.exe") || out.includes("bun.exe") || out.includes("conhost.exe");
    } catch { return true; } // no tasklist (non-Windows): trust process.kill
  }

  /**
   * What the LAST process left behind, settled once at start().
   *
   * ADOPT, DO NOT RESPAWN. The steps are detached on purpose (ShellExecute, no inherited handles), so a
   * box driver outlives the API that started it and keeps shipping, polling and pulling. Blindly
   * re-queueing such a job started a SECOND driver against the same box: two processes registering the
   * same HRCJob task and writing the same zip and charts.json.gz. So: if the recorded pid is still
   * alive, take the job back over — the .cmd appends "--- step exited N" to the job log itself, so
   * re-attaching is just resuming the poll on that log.
   *
   * Only when no driver is left does the job go back to the queue, which is safe and is the point: HRC
   * keeps solving on the box regardless, and a fresh driver skips every job whose zip is already there.
   *
   * (Until 2026-09-14 the re-queue matched `recipe='hrc-box'` only, so the 6-max fleet — recipe
   * `hrc-box-6max` — fell through to the "everything else is failed" line on EVERY restart: 199 failed
   * rows, and a live run that had to be re-queued by hand or by the box keeper.)
   */
  private reconcile(): void {
    const db = this.open();
    const rows = db.query<any, []>("SELECT * FROM jobs WHERE status='running'").all();
    for (const r of rows) {
     // PER ROW, fault-isolated: settling one job must never abandon the others. On 2026-09-14 an
     // EBUSY from the note below threw out of this loop after the FIRST row and left six jobs stuck
     // in `running` with no process and no in-memory state - invisible to the dispatcher, which only
     // ever looks at `queued`. The fleet sat idle until they were re-queued by hand.
     try {
        const j = this.rowOf(r);
        const pid = Number(r.pid) || 0;
        const step = Number(r.step) || 0;
        if (this.aliveStep(pid)) {
          const state = { id: j.id, proc: null as ReturnType<typeof Bun.spawn> | null, pid, cancel: false, step, stepStarted: Date.now() };
          this.running.set(j.lane, state);
          db.query("UPDATE jobs SET note=COALESCE(note,'') || ? WHERE id=?").run(` [adopted: driver pid ${pid} outlived the api restart]`, j.id);
          // best effort: the adopted driver still holds this log open for append, and Windows
          // answers EBUSY rather than sharing it. The note is a nicety; the adoption is what matters.
          try { appendFileSync(j.logPath, `
=== the api restarted; re-attached to this step (pid ${pid}) rather than starting a second driver
`); } catch { /* held by the driver */ }
          void this.execFrom(j, state, step, pid);
          continue;
        }
        if (j.recipe.startsWith("hrc-box")) {
          db.query("UPDATE jobs SET status='queued', started=NULL, pid=NULL, note=COALESCE(note,'') || ' [re-queued: api restarted and no driver was left]' WHERE id=?").run(j.id);
        } else {
          db.query("UPDATE jobs SET status='failed', ended=?, pid=NULL, note=COALESCE(note,'') || ' [api restarted mid-job]' WHERE id=?").run(Date.now(), j.id);
        }
     } catch (e) {
       console.error(`[jobs] reconcile: job #${r.id} could not be settled (left as it was): ${(e as Error)?.stack ?? String(e)}`);
     }
    }
  }

  private rowOf(r: any): JobRow {
    return { id: r.id, config: r.config, recipe: r.recipe, lane: r.lane, status: r.status, created: r.created, started: r.started, ended: r.ended, exitCode: r.exit_code, logPath: r.log_path, note: r.note, steps: JSON.parse(r.steps_json || "[]"), waitInputs: !!r.wait_inputs };
  }
  list(limit = 50): JobRow[] { return this.open().query<any, [number]>("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit).map((r) => this.rowOf(r)); }
  get(id: number): JobRow | null { const r = this.open().query<any, [number]>("SELECT * FROM jobs WHERE id=?").get(id); return r ? this.rowOf(r) : null; }

  /** Are all of a config's inputs done right now? (re-checked at start for chained jobs) */
  private inputsNotReady(c: LedgerConfig): string[] {
    const ev = evaluate();
    return c.inputs.map((id) => ev.configs.find((x) => x.id === id)).filter((x) => x && x.effective !== "done").map((x) => `${x!.label} (${x!.effective})`);
  }
  enqueue(configId: string, opts: { chain?: boolean } & RunOpts = {}): { ok: true; job: JobRow } | { ok: false; error: string } {
    const c = loadLedger().configs.find((x) => x.id === configId);
    if (!c) return { ok: false, error: `no config ${configId}` };
    const rec = recipeFor(c, opts);
    if (!rec) return { ok: false, error: `config ${configId} has no runnable recipe (runner: ${c.runner}) — it is run by hand from its runbook` };
    // dependency gate: a config runs only when everything it is built from is done. A chained job
    // ("run everything") is queued anyway and WAITS in the queue until its inputs are done.
    const notReady = this.inputsNotReady(c);
    if (notReady.length && !opts.chain) return { ok: false, error: `inputs not done yet: ${notReady.join("; ")} — run those first` };
    const db = this.open();
    const parts = rec.fanout ?? [{ lane: rec.lane, steps: rec.steps, note: rec.note }];
    // one live job per (config, lane): a box can be added to a run in progress without touching the other lanes
    for (const part of parts) {
      const dup = db.query<any, [string, string]>("SELECT id FROM jobs WHERE config=? AND lane=? AND status IN ('queued','running')").get(configId, part.lane);
      if (dup) return { ok: false, error: `config ${configId} already has job #${dup.id} queued or running on ${part.lane}` };
    }
    let first: JobRow | null = null;
    for (const part of parts) {
      const logPath = join(LOG_DIR, `${Date.now()}_${configId}_${part.lane.replace(/[^a-z0-9-]/gi, "_")}.log`);
      writeFileSync(logPath, `# job for ${configId} (${c.recipe}) lane ${part.lane} queued ${new Date().toISOString()}\n`);
      const r = db.query("INSERT INTO jobs (config, recipe, lane, status, created, log_path, note, steps_json, wait_inputs) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(configId, c.recipe ?? "", part.lane, "queued", Date.now(), logPath, notReady.length ? `${part.note} — waiting for: ${notReady.join("; ")}` : part.note, JSON.stringify(part.steps), opts.chain ? 1 : 0);
      first ??= this.get(Number(r.lastInsertRowid))!;
    }
    return { ok: true, job: first! };
  }
  cancel(id: number): boolean {
    const j = this.get(id); if (!j) return false;
    if (j.status === "queued") { this.open().query("UPDATE jobs SET status='cancelled', ended=? WHERE id=?").run(Date.now(), id); return true; }
    const run = this.running.get(j.lane);
    if (run && run.id === id) { run.cancel = true; try { run.proc?.kill(); if (run.pid) Bun.spawnSync(["taskkill", "/PID", String(run.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch { /* ignore */ } return true; }
    return false;
  }
  /** For a running job: the step it is on (0-based), how many there are, and when that step started. */
  live(id: number): { step: number; steps: number; label: string; stepStarted: number } | null {
    for (const st of this.running.values()) if (st.id === id) { const j = this.get(id); if (!j) return null; return { step: st.step, steps: j.steps.length, label: j.steps[st.step]?.label ?? "", stepStarted: st.stepStarted }; }
    return null;
  }
  logTail(id: number, lines = 200): string {
    const j = this.get(id); if (!j) return "";
    try { const t = readFileSyncSafe(j.logPath); const arr = t.split("\n"); return arr.slice(-lines).join("\n"); } catch { return ""; }
  }

  private tick(): void {
    // `this.running` is a per-process Map, so "one job per lane" only holds inside one process: two
    // API instances both see the same queued row and both spawn a runner for it, interleaving their
    // output into one log file. Only the background-lock owner dispatches. (services/backgroundLock.ts)
    if (!isBackgroundOwner()) return;
    const db = this.open();
    const lanes = new Set<string>(["scripts", "hrc-zenbook", "fleet"]);
    for (const r of db.query<any, []>("SELECT DISTINCT lane FROM jobs WHERE status='queued'").all()) lanes.add(String(r.lane));
    for (const lane of lanes) {
      if (this.running.has(lane)) continue;
      for (const r of db.query<any, [string]>("SELECT * FROM jobs WHERE status='queued' AND lane=? ORDER BY id").all(lane)) {
        const j = this.rowOf(r);
        if (j.waitInputs) {
          const c = loadLedger().configs.find((x) => x.id === j.config);
          const notReady = c ? this.inputsNotReady(c) : [];
          if (notReady.length) continue; // still waiting — leave it queued, try the next one in this lane
        }
        void this.run(j); break;
      }
    }
  }
  /**
   * Run one step WITHOUT making it a child that inherits this server's handles. A Bun.spawn child on Windows inherits the
   * listening socket, and once the API worker restarts the port stays "in use" until every such child exits (2026-09-09:
   * every request hung). So the step is written to a small .cmd file and launched through Start-Process (ShellExecute,
   * no handle inheritance); it appends its own output and "--- step exited N" to the job log, which we poll.
   */
  private async runStepDetached(j: JobRow, i: number, step: Step, state: { pid?: number; cancel: boolean }, log: (s: string) => void, adoptPid?: number): Promise<number> {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    // ADOPTED FIRST, before anything is written: this step is already running from before the restart.
    // Its cmd.exe is still executing the .cmd below and reads that file incrementally as it goes, so
    // rewriting it here would corrupt a running driver. Nothing is written and nothing is launched —
    // we only watch the job log for the "--- step exited N" marker the .cmd appends itself. If the
    // driver disappears without ever writing one, say so with -2: an hrc-box job then goes back to the
    // queue rather than being called failed, and a fresh driver resumes what the box has solved.
    if (adoptPid) {
      state.pid = adoptPid;
      const from = (() => { try { return require("node:fs").statSync(j.logPath).size; } catch { return 0; } })();
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const m = readFileSyncSafe(j.logPath).slice(from).match(/^--- step exited (-?\d+)/m);
        if (m) return Number(m[1]);
        if (state.cancel) { try { Bun.spawnSync(["taskkill", "/PID", String(adoptPid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch { /* ignore */ } log("\n--- step cancelled\n"); return -1; }
        if (!this.aliveStep(adoptPid)) { log(`\n!!! the adopted driver (pid ${adoptPid}) is gone and never wrote an exit marker\n`); return -2; }
      }
    }
    const env = { PYTHONIOENCODING: "utf-8", ...(step.env ?? {}) };
    const cmdFile = `${j.logPath}.step${i + 1}.cmd`;
    const lines = ["@echo off", ...Object.entries(env).map(([k, v]) => `set ${k}=${v}`), `cd /d ${q(step.cwd)}`,
      `${step.cmd.map((a, k) => (k === 0 || /[\s"&|<>^]/.test(a) ? q(a) : a)).join(" ")} >> ${q(j.logPath)} 2>&1`,
      `echo --- step exited %errorlevel% >> ${q(j.logPath)}`];
    writeFileSync(cmdFile, lines.join("\r\n") + "\r\n");
    const startLen = (() => { try { return require("node:fs").statSync(j.logPath).size; } catch { return 0; } })();
    const ps = `$p = Start-Process -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c', '"${cmdFile.replace(/'/g, "''")}"' -WindowStyle Hidden -PassThru; $p.Id`;
    const launcher = Bun.spawn(["powershell", "-NoProfile", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe" });
    const [out, lcode] = await Promise.all([new Response(launcher.stdout).text(), launcher.exited]);
    const pid = Number(out.trim().split("\n").pop());
    if (lcode !== 0 || !(pid > 0)) { log(`\n!!! could not launch the step: ${out}\n`); return 1; }
    state.pid = pid;
    // persist it: a restart adopts this driver instead of starting a rival one against the same box
    this.open().query("UPDATE jobs SET pid=?, step=? WHERE id=?").run(pid, i, j.id);
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const tail = readFileSyncSafe(j.logPath).slice(startLen);
      const m = tail.match(/^--- step exited (-?\d+)/m);
      if (m) return Number(m[1]);
      if (state.cancel) { try { Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch { /* ignore */ } log("\n--- step cancelled\n"); return -1; }
    }
  }

  private async run(j: JobRow): Promise<void> {
    const state = { id: j.id, proc: null as ReturnType<typeof Bun.spawn> | null, pid: undefined as number | undefined, cancel: false, step: 0, stepStarted: Date.now() };
    this.running.set(j.lane, state);
    this.open().query("UPDATE jobs SET status='running', started=?, pid=NULL, step=0 WHERE id=?").run(Date.now(), j.id);
    await this.execFrom(j, state, 0, undefined);
  }

  /** Walk the steps from `fromStep`. `adoptPid` means that first step is ALREADY running from before an
   *  api restart: it is watched, not launched (see reconcile()). Everything after it runs normally. */
  private async execFrom(j: JobRow, state: { id: number; proc: ReturnType<typeof Bun.spawn> | null; pid?: number; cancel: boolean; step: number; stepStarted: number }, fromStep: number, adoptPid?: number): Promise<void> {
    const db = this.open();
    const log = (s: string) => appendFileSync(j.logPath, s);
    let code = 0;
    try {
      for (let i = fromStep; i < j.steps.length; i++) {
        const step = j.steps[i]!;
        if (state.cancel) { code = -1; break; }
        state.step = i; state.stepStarted = Date.now();
        db.query("UPDATE jobs SET step=? WHERE id=?").run(i, j.id);
        const adopt = i === fromStep ? adoptPid : undefined;
        if (!adopt) log(`\n=== step ${i + 1}/${j.steps.length}: ${step.label}\n$ ${step.cmd.join(" ")}\n  (cwd ${step.cwd}${step.env && Object.keys(step.env).length ? ` · env ${JSON.stringify(step.env)}` : ""})\n`);
        code = await this.runStepDetached(j, i, step, state, log, adopt);
        if (code !== 0) break;
      }
    } catch (e) {
      log(`\n!!! ${String(e)}\n`); code = code || 1;
    }
    // -2 is "the adopted driver vanished": for a box job that is a re-queue, not a failure — the box
    // kept solving, and the next driver picks up whatever is left.
    if (code === -2 && j.recipe.startsWith("hrc-box")) {
      db.query("UPDATE jobs SET status='queued', started=NULL, pid=NULL, note=COALESCE(note,'') || ' [re-queued: the adopted driver vanished]' WHERE id=?").run(j.id);
      log(`\n=== job re-queued (the adopted driver vanished; the box keeps its solved work)\n`);
      this.running.delete(j.lane);
      return;
    }
    const status = state.cancel ? "cancelled" : code === 0 ? "done" : "failed";
    db.query("UPDATE jobs SET status=?, ended=?, exit_code=?, pid=NULL WHERE id=?").run(status, Date.now(), code, j.id);
    log(`\n=== job ${status} (${new Date().toISOString()})\n`);
    this.running.delete(j.lane);
  }
}

function readFileSyncSafe(p: string): string { try { return require("node:fs").readFileSync(p, "utf-8"); } catch { return ""; } }

export const jobs = new Jobs();
export { REPO };
