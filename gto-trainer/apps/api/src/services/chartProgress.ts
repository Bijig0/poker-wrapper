import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HRC_API, REPO, isBoxGrid, type LedgerConfig } from "./ledger";
import { jobs, HRC_API_ZENBOOK, type JobRow } from "./jobs";
import { boxKeeper } from "./boxKeeper";
import { getCatalog } from "./chartCatalog";

/**
 * CHART PROGRESS — per chart id, what is true right now, from every signal we have:
 *   done     the chart is in the :8777 catalog, or its charts.json(.gz) is on this machine
 *   solved   its strategies.zip is on a box (the keeper's probe listed it) but it has not been pulled + parsed yet
 *   running  a box is refining it now (the keeper's probe read it off the box's log; else a live job's log)
 *   queued   none of the above
 * plus a measured time estimate for a config's run: charts finished since the run started, over the machines
 * working it → minutes per chart per machine → time left for the rest. The proposal page's WORK lines, the
 * "charts" panel and the progress page all read this, so they never disagree.
 */

export interface ChartState { id: string; state: "done" | "solved" | "running" | "queued"; box?: string; at?: number | null; sinceMin?: number | null; phase?: string }

const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };

/** The 6-max plan dir of a config (plan_6max.json, queue, pulled zips, parsed charts, progress.json). */
export function sixMaxDir(c: LedgerConfig): string { return join(c.env?.HRC_API ?? HRC_API_ZENBOOK, "solves", "sixmax_grid", c.id); }

/** Where a config's chart files can land on this machine, most specific first. */
export function chartDirs(c: LedgerConfig): string[] {
  const dirs: string[] = [];
  if (isBoxGrid(c)) dirs.push(sixMaxDir(c));
  dirs.push(join(HRC_API_ZENBOOK, "solves", "threemax_asym"), join(HRC_API, "solves", "threemax_asym"), join(HRC_API, "solves", "threemax_grid"), join(HRC_API_ZENBOOK, "solves", "threemax_grid"));
  return dirs;
}
const SOLUTIONS = join(REPO, "analysis", "pipeline", "solve", "exploit_ui", "solutions");

/**
 * What one request reads ONCE and every chartStates / runEstimate / boxActivity call of it shares (2026-09-26: the
 * proposals page, polled every few seconds, spent most of its blocked event loop re-reading these per config):
 *   dirs  the file names of each chart dir, instead of an existsSync per id × extension × dir (1,562 ids × up to 12
 *         probes was 0.7 s a poll). Names compare the way the file system does (case-blind on Windows), as existsSync did.
 *   jobs  the newest 300 job rows, instead of 2-3 jobs.list() calls per config, each parsing every row's steps.
 *   cat   the catalog's chart ids.
 * Nothing is cached ACROSS requests: a dir's mtime does not track the chart files landing in it.
 */
export type DirListing = Map<string, Set<string>>;
export interface ProgressScope { dirs: DirListing; jobs?: JobRow[]; cat?: Set<string> }
export const progressScope = (): ProgressScope => ({ dirs: new Map() });
/** jobs.list(n), from the scope's one read when there is one (the list is newest first, so the first n of 300 ARE list(n)) */
function jobRows(n: number, scope?: ProgressScope): JobRow[] {
  if (!scope || n > 300) return jobs.list(n);
  scope.jobs ??= jobs.list(300);
  return scope.jobs.slice(0, n);
}
const nameKey = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
function has(dir: string, name: string, memo: DirListing | undefined): boolean {
  if (!memo) return existsSync(join(dir, name));
  let s = memo.get(dir);
  if (!s) { try { s = new Set(readdirSync(dir).map(nameKey)); } catch { s = new Set(); } memo.set(dir, s); }
  return s.has(nameKey(name));
}
/** Where a chart's file is on this machine, or null. */
export function chartPath(c: LedgerConfig, id: string, memo?: DirListing): string | null {
  for (const ext of [".json.gz", ".json"]) if (has(SOLUTIONS, `${id}${ext}`, memo)) return join(SOLUTIONS, `${id}${ext}`);
  for (const d of chartDirs(c)) for (const ext of [".charts.json.gz", ".charts.json"]) if (has(d, `${id}${ext}`, memo)) return join(d, `${id}${ext}`);
  return null;
}
const mtimeOf = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };
export function chartFile(c: LedgerConfig, id: string, memo?: DirListing): { path: string; mtimeMs: number } | null {
  const p = chartPath(c, id, memo);
  return p ? { path: p, mtimeMs: mtimeOf(p) } : null;
}

function catalogIds(scope?: ProgressScope): Set<string> {
  if (scope?.cat) return scope.cat;
  let ids: Set<string>;
  try { ids = new Set((getCatalog().entries as any[]).map((e) => String(e.id))); } catch { ids = new Set(); }
  if (scope) scope.cat = ids;
  return ids;
}

/** What every live box job of a config is doing right now, read from its log: the chart it is refining, the last one parsed. */
export function boxActivity(configId: string, scope?: ProgressScope): { lane: string; box: string; status: string; solving: string | null; lastDone: string | null; progress: string | null }[] {
  const out: ReturnType<typeof boxActivity> = [];
  for (const j of jobRows(200, scope)) {
    if (j.config !== configId || (j.status !== "running" && j.status !== "queued")) continue;
    const tail = jobs.logTail(j.id, 600).split("\n");
    const last = (re: RegExp) => { for (let i = tail.length - 1; i >= 0; i--) { const m = tail[i]!.match(re); if (m) return m[1] ?? m[0]; } return null; };
    out.push({ lane: j.lane, box: j.lane.split(":").pop()!, status: j.status, solving: last(/refining (\S+) for/), lastDone: last(/\] parsed (\S+):/), progress: last(/box: (\[\d+\/\d+\])/) });
  }
  return out;
}

/** The state of each chart id of a config, now. `scope`: what the request has already read, shared by all its configs. */
export function chartStates(c: LedgerConfig, ids: string[], scope: ProgressScope = progressScope()): ChartState[] {
  const cat = catalogIds(scope);
  const K = boxKeeper.status() as any;
  const probes: [string, any][] = [...Object.entries(K.boxes ?? {}), ...Object.entries(K.linux ?? {})];
  const running = new Map<string, { box: string; sinceMin: number | null; phase: string }>();
  const zips = new Map<string, { box: string; at: number }>();
  for (const [label, p] of probes) {
    for (const z of (p.zips ?? []) as { id: string; at: number }[]) if (!zips.has(z.id) || zips.get(z.id)!.at < z.at) zips.set(z.id, { box: label, at: z.at });
    if (p.current && !zips.has(p.current)) running.set(p.current, { box: label, sinceMin: p.currentSinceMin ?? null, phase: p.currentPhase ?? "refining" });
  }
  for (const a of boxActivity(c.id, scope)) if (a.solving && !running.has(a.solving) && !zips.has(a.solving)) running.set(a.solving, { box: a.box, sinceMin: null, phase: a.progress ?? "refining" });
  const prog = isBoxGrid(c) ? (readJson(join(sixMaxDir(c), "progress.json")) ?? {}) : {};
  // a second refinement pass: the catalog already holds every id (first pass), so done = this pass's own pull / parse,
  // and a zip or a running tree counts only if it is newer than the pass's first job
  const pass2 = c.env?.PASS2 === "1";
  const week = Date.now() - 7 * 86_400_000;
  const passJobs = pass2 ? jobRows(300, scope).filter((j) => j.config === c.id && j.created > week) : [];
  const passStart = pass2 ? Math.min(...passJobs.map((j) => j.started ?? j.created), Infinity) : 0;
  // a second-pass tree is "running" only on a box whose second-pass job is actually running (not waiting for its inputs)
  const passLanes = new Set(passJobs.filter((j) => j.status === "running" && !j.waitInputs).map((j) => j.lane.split(":").pop()));
  return ids.map((id) => {
    if (pass2) {
      const pr = prog[id]; const own = join(sixMaxDir(c), `${id}.charts.json.gz`);
      if (pr || existsSync(own)) { let m = 0; try { m = statSync(own).mtimeMs; } catch { /* no local file */ } return { id, state: "done", box: pr?.box, at: pr?.solvedAt ?? m ?? null }; }
      const z = zips.get(id); if (z && passLanes.has(z.box) && z.at * 1000 > passStart) return { id, state: "solved", box: z.box, at: z.at * 1000 };
      const r = running.get(id); if (r && passLanes.has(r.box)) return { id, state: "running", box: r.box, sinceMin: r.sinceMin, phase: r.phase };
      return { id, state: "queued" };
    }
    // when it landed: the pull record, else the box's zip, else the file's mtime — stat only when the first two are silent
    // (a stat per catalogued chart was most of what was left of the proposals page, 2026-09-26)
    const z = zips.get(id), pr = prog[id];
    const known: number | undefined = pr?.solvedAt ?? (z ? z.at * 1000 : undefined);
    const path = cat.has(id) && known !== undefined ? null : chartPath(c, id, scope.dirs);
    if (cat.has(id) || path) return { id, state: "done", box: pr?.box ?? z?.box, at: known !== undefined ? known : path ? mtimeOf(path) : null };
    if (z) return { id, state: "solved", box: z.box, at: z.at * 1000 };
    const r = running.get(id); if (r) return { id, state: "running", box: r.box, sinceMin: r.sinceMin, phase: r.phase };
    return { id, state: "queued" };
  });
}

const minsStr = (m: number) => (m >= 48 * 60 ? `${(m / 1440).toFixed(1)} days` : m >= 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);

export interface RunEstimate { done: number; solved: number; running: number; total: number; lanes: number; runStart: number | null; measuredMinPerChart: number | null; leftMinutes: number | null; text: string }

/** Measured pace of a config's run. Per machine, a chart's time is the gap between that box's consecutive finished charts
 *  (the first one counted from the run's start); when the boxes are not known (3-max pulls), throughput over the window
 *  from the first to the last finished chart, needing 3+ charts. */
export function runEstimate(c: LedgerConfig, states: ChartState[], lanes: number, scope?: ProgressScope): RunEstimate {
  const total = states.length;
  const done = states.filter((s) => s.state === "done").length, solved = states.filter((s) => s.state === "solved").length, running = states.filter((s) => s.state === "running").length;
  const left = total - done - solved;
  const week = Date.now() - 7 * 86_400_000;
  const js = jobRows(300, scope).filter((j) => j.config === c.id && j.created > week);
  const live = js.some((j) => j.status === "running" || j.status === "queued");
  const runStart = js.length ? Math.min(...js.map((j) => j.started ?? j.created)) : null;
  const finished = states.filter((s) => (s.state === "done" || s.state === "solved") && s.at && runStart && s.at > runStart).sort((a, b) => a.at! - b.at!);
  const n = finished.length;
  const paused = left > 0 && !running && !live ? " · paused — nothing solving now" : "";
  if (!left) return { done, solved, running, total, lanes, runStart, measuredMinPerChart: null, leftMinutes: 0, text: "all charts finished" };
  if (!runStart || !n) {
    return { done, solved, running, total, lanes, runStart, measuredMinPerChart: null, leftMinutes: null,
      text: `no chart finished yet — ${c.cost.minPerJob} min per chart is the ledger's guess (${minsStr(Math.ceil(left / Math.max(1, lanes)) * c.cost.minPerJob)} left on ${lanes} machines)${paused}` };
  }
  let perChart: number | null = null, basis = "";
  const withBox = finished.filter((s) => s.box);
  if (withBox.length) {
    const durations: number[] = [];
    const byBox = new Map<string, number[]>();
    for (const s of withBox) byBox.set(s.box!, [...(byBox.get(s.box!) ?? []), s.at!]);
    for (const ats of byBox.values()) { let prev = runStart; for (const at of ats.sort((a, b) => a - b)) { durations.push((at - prev) / 60_000); prev = at; } }
    perChart = durations.reduce((a, b) => a + b, 0) / durations.length; basis = `${minsStr(perChart)} per chart per machine (${durations.length} timed on ${byBox.size} machine${byBox.size === 1 ? "" : "s"})`;
  } else if (n >= 3) {
    perChart = lanes * (finished[n - 1]!.at! - finished[0]!.at!) / 60_000 / (n - 1); basis = `one every ${minsStr(perChart / lanes)} across ${lanes} machines ≈ ${minsStr(perChart)} per chart per machine`;
  }
  if (perChart == null) return { done, solved, running, total, lanes, runStart, measuredMinPerChart: null, leftMinutes: null, text: `${n} chart${n === 1 ? "" : "s"} finished — the pace is known after a few more${paused}` };
  const leftMinutes = Math.ceil(left / Math.max(1, lanes)) * perChart;
  return { done, solved, running, total, lanes, runStart, measuredMinPerChart: perChart, leftMinutes,
    text: `measured: ${n} chart${n === 1 ? "" : "s"} finished, ${basis} → about ${minsStr(leftMinutes)} left for the ${left} remaining on ${lanes} machines${paused}` };
}
