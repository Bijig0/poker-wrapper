/**
 * A STRATEGY'S WORK QUEUE (2026-09-22, Brady: "a list of the current approximates, basically our miss queue but
 * specific to the ignition 200NL ring 6-max equilibrium ... details on the specific charts that's needed, how far
 * away from equilibrium we have, and thus the priority").
 *
 * The miss queue (services/missQueue.ts) records every state a chart could not answer exactly, with the chart that
 * WOULD answer it. This groups the strategy's open rows by that chart, so each line of the page is one solve:
 * which chart, what it would fix, how often real hands hit it, how far the answer we gave sits from the spot, and
 * a priority. Stress-harness hands (client ids "stress-…") are left out — they are ours, not the pool's.
 *
 * DISTANCE is reported in the terms that were actually measured. Only the size snap has a measured EV curve (its
 * translation error); everything else says how far the INPUT was moved (a 80bb short stack read as 70bb, one
 * caller folded) and marks the EV cost unmeasured. PRIORITY = real hits × severity, severity 1-3 by kind and
 * gap (the table is in SEVERITY below and printed on the page), so the order is explainable, not a black box.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { missQueue, type MissItem } from "./missQueue";
import type { StrategyCoverage } from "./strategyCoverage";
import { boxKeeper } from "./boxKeeper";

const PLAN_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "poker-zenbook", "hrc-api", "solves", "sixmax_grid");
const SYNTHETIC = /^(stress-|test|fake)/i;

export interface QueueGroup {
  /** the chart that would answer these states exactly */
  chart: string;
  /** what solving it means: a new chart, a size added to an existing one, a wider tree */
  change: string;
  /** the individual changes behind it (sizes to add, states seen) */
  details: string[];
  kinds: string[];
  /** real hands that hit it (stress runs excluded) */
  hits: number;
  lastSeen: number;
  severity: number;
  priority: number;
  /** how far the answer we gave is from the spot */
  distance: string;
  /** a measured EV figure, when one exists for this kind */
  evCost: string | null;
  examples: { hero: string | null; stacks: string; line: string; reason: string }[];
  cmd: string | null;
  /** a plan in `solves` already covers it */
  inFlight: string | null;
}

const logDist = (reason: string) => Number(/log-dist ([\d.]+)/.exec(reason)?.[1] ?? NaN);

/** severity 1-3 and the honest distance text, per miss kind */
function assess(m: MissItem): { severity: number; distance: string; evCost: string | null } {
  const stacks = m.state?.stacksBB ?? {};
  switch (m.kind) {
    case "size-snapped": {
      const d = logDist(m.reason);
      const far = !(d <= 0.4);
      return { severity: far ? 2 : 1, distance: `${m.want ?? "?"} read as ${m.got ?? "?"}${Number.isFinite(d) ? ` (log-dist ${d.toFixed(2)})` : ""}`,
        evCost: far ? "up to 0.5-1.8% of the pot (measured translation error at 1.5-2x)" : "under 0.01% of the pot (measured, clean snap)" };
    }
    case "size-off-tree":
      return { severity: 2, distance: `${m.want ?? "a size"} is more than 2x from the chart's menu — GTO Wizard AI answered instead`, evCost: null };
    case "short-rung-snapped": {
      const seatStack = (stacks as Record<string, number | undefined>)[m.shortSeat];
      const real = seatStack != null ? Math.round(seatStack) : null;
      const gap = real != null ? Math.abs(real - m.shortDepth) : null;
      return { severity: gap != null && gap >= 15 ? 2 : 1,
        distance: real != null ? `short stack ${real}bb read as ${m.shortDepth}bb (${gap}bb off)` : `short stack read as ${m.shortDepth}bb`, evCost: null };
    }
    case "no-limp-uneven": {
      const short = Object.entries(stacks).filter(([, v]) => (v ?? 100) < 85).sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0))[0];
      return { severity: short && (short[1] ?? 100) <= 50 ? 3 : 2,
        distance: short ? `the ${short[0]}'s ${Math.round(short[1] ?? 0)}bb ignored — the even-stack limp chart answered` : "a short stack ignored in a limped pot", evCost: null };
    }
    case "open-not-in-set":
      return { severity: 1, distance: `open ${m.want ?? "?"} read at the nearest solved open`, evCost: null };
    case "beyond-ladder": {
      const deep = Math.max(...Object.values(stacks).map((v) => v ?? 0));
      return { severity: deep >= 200 ? 2 : 1, distance: `${Math.round(deep)}bb deep read as 150bb`, evCost: null };
    }
    case "caller-cap":
    case "past-terminal":
    case "action-not-in-tree":
      return { severity: 2, distance: "the line runs past the chart's caps — read one player lighter (line fit)", evCost: null };
    case "node-missing":
      return { severity: 2, distance: "a node the chart lost — the walk fell to the next piece", evCost: null };
    default:
      return { severity: 1, distance: m.reason.slice(0, 140), evCost: null };
  }
}

/** the chart that would answer the state, what KIND of change that is (the group), and this state's detail */
function neededChart(m: MissItem): { chart: string; change: string; detail: string } {
  if (m.kind === "no-limp-uneven" && m.job?.id) {
    // the suggestion carries the 2.5x-open id of the uneven cell; the chart that answers a limped pot is its limp tree
    return { chart: m.job.id.replace(/_o[\d_]+$/, "_olimp"), change: "new uneven limp chart", detail: m.reason };
  }
  if (m.kind === "short-rung-snapped" && m.job?.id) return { chart: m.job.id, change: "new short-stack rung", detail: String((m.job as any).change ?? m.reason) };
  if (m.kind === "open-not-in-set" && m.job?.id) return { chart: m.job.id, change: "new uneven chart for this open size", detail: m.reason };
  if (m.job?.id) return { chart: m.job.id, change: "new chart", detail: String((m.job as any).change ?? m.reason) };
  if (m.kind === "size-snapped" || m.kind === "size-off-tree") return { chart: m.chart, change: "add raise sizes to the menu", detail: `${m.want ?? "a size"} at ${m.line || "the root"}` };
  if (m.kind === "beyond-ladder") return { chart: m.chart.replace(/_D\d+/, "_D200"), change: "a deeper rung (175-250bb)", detail: m.reason };
  if (m.kind === "node-missing") return { chart: m.chart, change: "re-solve (a node the chart lost)", detail: m.line || m.reason };
  return { chart: m.chart, change: "wider tree (more limpers / callers / players) — needs more memory", detail: (m.state?.tokens ?? []).join("-") || m.line };
}

function planIds(dir: string): { ids: string[]; done: string[] } {
  try {
    const plan = JSON.parse(readFileSync(join(PLAN_ROOT, dir, "plan_6max.json"), "utf8"));
    const ids: string[] = (Array.isArray(plan) ? plan : plan.jobs ?? []).map((j: any) => String(j.id));
    return { ids, done: ids.filter((id) => existsSync(join(PLAN_ROOT, dir, `${id}.charts.json.gz`))) };
  } catch { return { ids: [], done: [] }; }
}

// ---------------------------------------------------------------- the boxes, live
/**
 * HOW LONG A CHART TAKES, from wall times we MEASURED on the 12-vCPU Windows boxes (second pass, 240 min of
 * refinement): limp trees 30bb 1.8 h, 50bb 4.7 h, 75bb 5.9 h, 100bb 9.5 h; raise trees 5.3-7.5 h (5.4 h at 100bb).
 * Refinement is a fixed sample count per minute, so extra minutes past 240 are added at the 100bb limp tree's own
 * ratio (9.5 h for 240 min ≈ 2.4x). Uneven (one short seat) and wider trees have no measurement yet — they take the
 * even tree's time and say so.
 */
export function estimateHours(job: any, box = ""): { hours: number; basis: string } {
  const limp = /olimp/.test(String(job.id)) || job.open === 0;
  const D = Number(job.depth ?? 100);
  const LIMP: Record<number, number> = { 30: 1.8, 50: 4.7, 75: 5.9, 100: 9.5 };
  const linux = /^hrc-l\d/.test(box);
  // uneven (one short seat) raise trees, second pass: median 5.1 h/chart on the Windows boxes, 5.5 h on the Hetzner
  // Linux boxes (grid-6max-nl200-asym-r2/progress.json, gaps between consecutive solvedAt per box)
  const uneven = /_s\d+_/.test(String(job.id));
  let h = limp ? (LIMP[D] ?? 9.5) : uneven ? (linux ? 5.5 : 5.1) : D >= 125 ? 7 : 5.4;
  let basis = limp ? `measured ${D}bb limp tree` : uneven ? `measured uneven raise tree (${linux ? "Linux" : "Windows"} boxes)` : "measured raise tree";
  const extra = Math.max(0, Number(job.refineMin ?? 240) - 240);
  if (extra) { h += (extra / 60) * 2.4; basis += ` + ${extra} min more refinement`; }
  if (job.maxactive || String(job.id).includes("olimp4b") || (limp && uneven)) basis += " (this tree shape not measured yet)";
  return { hours: Math.round(h * 10) / 10, basis };
}

interface QFile { boxes: Record<string, string>; items: { id: string; box: string; ranOn?: string; tier?: number; rank?: number; planDir: string; planFile?: string; shard?: string; status: string; startedAt?: string | null; note?: string }[] }
const TIER_LABEL = ["0 · fixes a no-answer spot", "1 · live-session approximation", "2 · other 6-max", "3 · other"];

function readQueue(): QFile | null {
  try { return JSON.parse(readFileSync(join(PLAN_ROOT, "box_queue.json"), "utf8")); } catch { return null; }
}
function shardJobs(planDir: string, shard?: string, planFile = "plan_6max.json"): any[] {
  try {
    const p = JSON.parse(readFileSync(join(PLAN_ROOT, planDir, planFile), "utf8"));
    const jobs: any[] = Array.isArray(p) ? p : p.jobs ?? [];
    const [i, n] = (shard ?? "0/1").split("/").map(Number);
    return jobs.filter((_, k) => k % n! === i);
  } catch { return []; }
}

/** What every box is solving right now, what follows it, and when each should land. */
export function boxesLive(prefix: string, serves: Record<string, string>) {
  const q = readQueue();
  if (!q) return [];
  let keeper: any = {};
  try { const st: any = boxKeeper.status(); keeper = { ...(st?.linux ?? {}), ...(st?.boxes ?? {}) }; } catch { /* keeper not running: no live phase */ }
  const t0 = Date.now();
  return Object.keys(q.boxes).map((box) => {
    const k = keeper[box] ?? {};
    const onBox = new Set<string>([...(k.zips ?? []), ...(k.sols ?? [])].map((z: any) => String(z.id)));
    const items = q.items.filter((it) => (it.status === "running" ? (it.ranOn ?? it.box) : it.box) === box && it.status !== "done" && it.status !== "failed")
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (a.tier ?? 2) - (b.tier ?? 2) || (b.rank ?? 0) - (a.rank ?? 0));
    let clock = t0;
    let nowSolving: any = null;
    const queue = items.map((it) => {
      const jobs = shardJobs(it.planDir, it.shard, it.planFile);
      const done = jobs.filter((j) => onBox.has(j.id) || existsSync(join(PLAN_ROOT, it.planDir, `${j.id}.charts.json.gz`)));
      const left = jobs.filter((j) => !done.includes(j));
      let hoursLeft = 0;
      for (const j of left) {
        const e = estimateHours(j, box);
        if (k.current === j.id && k.currentSinceMin != null) {
          const rem = Math.max(0.25, e.hours - k.currentSinceMin / 60);
          nowSolving = { chart: j.id, phase: k.currentPhase ?? null, sinceMin: k.currentSinceMin, estHours: e.hours, basis: e.basis,
            finishAt: t0 + rem * 3.6e6, item: it.id };
          hoursLeft += rem;
        } else hoursLeft += e.hours;
      }
      clock += hoursLeft * 3.6e6;
      return { id: it.id, planDir: it.planDir, shard: it.shard ?? null, status: it.status, charts: jobs.length, done: done.length,
        hoursLeft: Math.round(hoursLeft * 10) / 10, finishAt: clock, note: it.note ?? null,
        priority: jobs.length && jobs.every((j) => String(j.id).startsWith(prefix)) ? "6-max NL200 (always first)" : "other",
        tier: it.tier ?? 2, tierLabel: TIER_LABEL[it.tier ?? 2] ?? String(it.tier),
        serves: serves[it.planDir] ?? null };
    });
    return { box, host: q.boxes[box], jobState: k.job ?? null, nowSolving, queue, freeAt: clock };
  });
}

/** items not tied to a box yet ("any" / "any-win"): what is waiting for the next free box, by tier */
export function waitingForABox() {
  const q = readQueue();
  if (!q) return [];
  const byTier = new Map<number, { tier: number; label: string; charts: number; limp: number; hours: number; next: string[] }>();
  for (const it of q.items) {
    if (it.status !== "queued" || (it.box !== "any" && it.box !== "any-win")) continue;
    const t = it.tier ?? 2;
    const g = byTier.get(t) ?? { tier: t, label: TIER_LABEL[t] ?? String(t), charts: 0, limp: 0, hours: 0, next: [] };
    for (const j of shardJobs(it.planDir, it.shard, it.planFile)) {
      g.charts++; if (/olimp/.test(String(j.id))) g.limp++;
      g.hours += estimateHours(j).hours;
      if (g.next.length < 6) g.next.push(`${j.id} (${it.rank ?? 0} hit${it.rank === 1 ? "" : "s"})`);
    }
    byTier.set(t, g);
  }
  return [...byTier.values()].sort((a, b) => a.tier - b.tier).map((g) => ({ ...g, hours: Math.round(g.hours) }));
}

export function workQueue(cov: StrategyCoverage) {
  const prefix = cov.missChartPrefix;
  const solves = (cov.solves ?? []).map((s) => { const p = planIds(s.planDir); return { ...s, charts: p.ids.length, done: p.done.length, ids: p.ids }; });
  const serves: Record<string, string> = {};
  for (const x of cov.solves ?? []) serves[x.planDir] = x.serves;
  const boxes = boxesLive(prefix ?? "ign200_6max", serves);
  if (!prefix) return { groups: [], solves, boxes, excludedSynthetic: 0 };
  const inPlan = new Map<string, string>();
  for (const s of solves) for (const id of s.ids) inPlan.set(id, s.label);

  let excluded = 0;
  const groups = new Map<string, QueueGroup>();
  for (const m of missQueue.list("open")) {
    if (!String(m.chart).startsWith(prefix)) continue;
    const real = m.refs.filter((r) => !SYNTHETIC.test(String(r.clientHandId ?? "")));
    excluded += m.refs.length - real.length;
    const hits = real.length || m.nCorpus || 0;
    if (!hits) continue;
    const need = neededChart(m);
    const a = assess(m);
    const key = `${need.chart}|${need.change}`;
    const g = groups.get(key) ?? {
      chart: need.chart, change: need.change, details: [], kinds: [], hits: 0, lastSeen: 0, severity: 0, priority: 0,
      distance: a.distance, evCost: a.evCost, examples: [], cmd: (m.job && "cmd" in m.job ? m.job.cmd : null) ?? null,
      inFlight: inPlan.get(need.chart) ?? null,
    };
    if (!g.kinds.includes(m.kind)) g.kinds.push(m.kind);
    if (need.detail && !g.details.includes(need.detail)) g.details.push(need.detail);
    g.hits += hits;
    g.lastSeen = Math.max(g.lastSeen, m.lastSeen);
    if (a.severity > g.severity) { g.severity = a.severity; g.distance = a.distance; g.evCost = a.evCost; }
    if (g.examples.length < 3) {
      g.examples.push({
        hero: m.state?.heroPos ?? null,
        stacks: Object.entries(m.state?.stacksBB ?? {}).map(([p, v]) => `${p} ${Math.round(v ?? 0)}`).join(" · "),
        line: (m.state?.tokens ?? []).join("-") || m.line || "root",
        reason: m.reason,
      });
    }
    groups.set(key, g);
  }
  const out = [...groups.values()].map((g) => ({ ...g, priority: g.hits * g.severity }));
  out.sort((a, b) => Number(!!a.inFlight) - Number(!!b.inFlight) || b.priority - a.priority || b.lastSeen - a.lastSeen);
  return { groups: out, solves: solves.map(({ ids, ...s }) => s), boxes, excludedSynthetic: excluded, recent: recentlySolved(prefix.replace(/_$/, "")), waiting: waitingForABox() };
}

// ---------------------------------------------------------------- recently solved
const SOLUTIONS = join(import.meta.dir, "..", "..", "..", "..", "..", "analysis", "pipeline", "solve", "exploit_ui", "solutions");
/** what each plan dir was, in words */
const PASS_LABEL: Record<string, string> = {
  "grid-6max-nl200": "even grid, first pass", "grid-6max-nl200-r2": "even grid, refined pass",
  "grid-6max-nl200-asym": "one short seat, first pass", "grid-6max-nl200-asym-r2": "one short seat, refined pass",
  "grid-6max-nl200-patch": "hand patch", "limp-uneven": "uneven limp charts", "limp-4bet": "limp chart with a named 4-bet",
  "limpfull-test": "maxactive-6 test", "short-rungs-6080": "short stacks 60/80bb", "uneven-opens-2-35": "uneven 2x/3.5x opens",
  "patch-live": "live-approximation patch",
};
/** the chart families the live picker (services/hrc6max.ts chartFor6max) reaches today */
export const LIVE_FAMILIES = [
  /^ign200_6max_D(30|50|75|100|125|150)_o(2|2_5|3|3_5|limp)$/,
  /^ign200_6max_D100_s(30|50|70)_(UTG|HJ|CO|BTN|SB|BB)_o(2_5|3)$/,
];

export interface SolvedChart { id: string; at: number; box: string | null; pass: string; inCatalog: boolean; live: boolean; when: "solved" | "landed" }

/** every chart of this strategy solved in the last `days`, newest first — from the plan dirs' solve records
 *  (progress.json: box + solvedAt), else the landed charts.json.gz file's time. Never the catalog file's time: the
 *  2026-09-22 converter re-export rewrote every catalog file without re-solving anything. */
export function recentlySolved(prefix = "ign200_6max", days = 31): SolvedChart[] {
  const since = Date.now() - days * 86400e3;
  const out: SolvedChart[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(PLAN_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  for (const dir of dirs) {
    let progress: Record<string, any> = {};
    try { progress = JSON.parse(readFileSync(join(PLAN_ROOT, dir, "progress.json"), "utf8")); } catch { /* none yet */ }
    let files: string[] = [];
    try { files = readdirSync(join(PLAN_ROOT, dir)); } catch { continue; }
    const ids = new Set<string>([...Object.keys(progress), ...files.filter((f) => f.endsWith(".charts.json.gz")).map((f) => f.replace(/\.charts\.json\.gz$/, ""))]);
    for (const id of ids) {
      if (!id.startsWith(prefix)) continue;
      const pr = progress[id];
      let at = Number(pr?.solvedAt ?? 0), when: SolvedChart["when"] = "solved";
      if (!at) { try { at = statSync(join(PLAN_ROOT, dir, `${id}.charts.json.gz`)).mtimeMs; when = "landed"; } catch { continue; } }
      if (at < since) continue;
      out.push({ id, at, box: pr?.box ?? null, pass: PASS_LABEL[dir] ?? dir, when,
        inCatalog: existsSync(join(SOLUTIONS, `${id}.json.gz`)), live: LIVE_FAMILIES.some((re) => re.test(id)) });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
