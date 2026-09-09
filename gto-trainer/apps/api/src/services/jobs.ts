import { Database } from "bun:sqlite";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, LIMP, MES_HANDOFF, HRC_API, REPO, loadLedger, evaluate, type LedgerConfig } from "./ledger";
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
    Bun.spawnSync(["powershell", "-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { $_.CommandLine -like '*scripts?boxJob.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { stdout: "ignore", stderr: "ignore", timeout: 15000 });
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
      // the 6-max grid: the generator writes the whole plan + the HRC Runner queue from its own
      // depth-scaled size menus (see hrc-api/scripts/genSixMaxPlan.ts); the solve runs in HRC Runner.
      // It lives in the poker-zenbook checkout of hrc-api — the one whose Windows driver has the
      // Run-Nash refinement step (not merged into this repo's hrc-api yet).
      const api = env.HRC_API ?? HRC_API_ZENBOOK;
      const sites = env.SITES ?? "ign200,ign25";
      return { lane: "hrc-zenbook", note: `writes the 6-max plan + runner queue (sites ${sites}) and opens HRC Runner on it; the solves run there, pilot first`, steps: [
        { label: "write plan + queue", cmd: [BUN, "run", join(api, "scripts", "genSixMaxPlan.ts"), "--sites", sites], cwd: api, env },
        { label: "open HRC Runner", cmd: ["cmd", "/c", "start", "", "C:\Users\Brady\Desktop\HRC Runner.cmd", join(api, "solves", "sixmax_grid", "queue_6max.json")], cwd: api, env },
      ] };
    }
    default:
      return null;
  }
}

class Jobs {
  private db: Database | null = null;
  private running: Map<string, { id: number; proc: ReturnType<typeof Bun.spawn> | null; cancel: boolean; step: number; stepStarted: number }> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  private open(): Database {
    if (this.db) return this.db;
    mkdirSync(LOG_DIR, { recursive: true });
    this.db = new Database(join(DATA_DIR, "jobs.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL"); this.db.exec(DDL);
    try { this.db.exec("ALTER TABLE jobs ADD COLUMN wait_inputs INTEGER DEFAULT 0"); } catch { /* already there */ }
    // anything left "running" by a dead process: an HRC box job goes back to the queue — the box keeps solving on its own
    // and boxJob.ts resumes (waits for the box, pulls what is solved there, solves only the rest); everything else is failed
    this.db.query("UPDATE jobs SET status='queued', started=NULL, note=COALESCE(note,'') || ' [re-queued: api restarted mid-job]' WHERE status='running' AND recipe='hrc-box'").run();
    this.db.query("UPDATE jobs SET status='failed', ended=?, note=COALESCE(note,'') || ' [api restarted mid-job]' WHERE status='running'").run(Date.now());
    return this.db;
  }
  start(): void { if (!this.timer) this.timer = setInterval(() => this.tick(), 3000); }

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
    if (run && run.id === id) { run.cancel = true; try { run.proc?.kill(); } catch { /* ignore */ } return true; }
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
  private async run(j: JobRow): Promise<void> {
    const db = this.open();
    const state = { id: j.id, proc: null as ReturnType<typeof Bun.spawn> | null, cancel: false, step: 0, stepStarted: Date.now() };
    this.running.set(j.lane, state);
    db.query("UPDATE jobs SET status='running', started=? WHERE id=?").run(Date.now(), j.id);
    const log = (s: string) => appendFileSync(j.logPath, s);
    let code = 0;
    try {
      for (const [i, step] of j.steps.entries()) {
        if (state.cancel) { code = -1; break; }
        state.step = i; state.stepStarted = Date.now();
        log(`\n=== step ${i + 1}/${j.steps.length}: ${step.label}\n$ ${step.cmd.join(" ")}\n  (cwd ${step.cwd}${step.env && Object.keys(step.env).length ? ` · env ${JSON.stringify(step.env)}` : ""})\n`);
        const proc = Bun.spawn(step.cmd, { cwd: step.cwd, env: { ...process.env, PYTHONIOENCODING: "utf-8", ...(step.env ?? {}) }, stdout: "pipe", stderr: "pipe" });
        state.proc = proc;
        const pump = async (stream: ReadableStream<Uint8Array> | null) => { if (!stream) return; const reader = stream.getReader(); const dec = new TextDecoder(); for (;;) { const { done, value } = await reader.read(); if (done) break; log(dec.decode(value)); } };
        await Promise.all([pump(proc.stdout as any), pump(proc.stderr as any)]);
        code = await proc.exited;
        log(`\n--- step exited ${code}\n`);
        if (code !== 0) break;
      }
    } catch (e) {
      log(`\n!!! ${String(e)}\n`); code = code || 1;
    }
    const status = state.cancel ? "cancelled" : code === 0 ? "done" : "failed";
    db.query("UPDATE jobs SET status=?, ended=?, exit_code=? WHERE id=?").run(status, Date.now(), code, j.id);
    log(`\n=== job ${status} (${new Date().toISOString()})\n`);
    this.running.delete(j.lane);
  }
}

function readFileSyncSafe(p: string): string { try { return require("node:fs").readFileSync(p, "utf-8"); } catch { return ""; } }

export const jobs = new Jobs();
export { REPO };
