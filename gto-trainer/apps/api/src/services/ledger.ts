import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getCatalog } from "./chartCatalog";
import { mesPostflopInfo } from "./mesPostflop";

/**
 * The LEDGER — the one place that says what a format is, what a solve config
 * is, what each config was built FROM, and what it produced.
 *
 * data/ledger.json is the source of truth (git-tracked, hand-reviewable).
 * This module reads it, fingerprints the artifacts on disk, and evaluates
 * every config:
 *   done     the artifact exists and no input has changed since it was built
 *   stale    the artifact exists but an input moved after it — re-run needed
 *   planned  no artifact yet
 * plus a time/cost estimate per config and per plan (a plan is an ordered
 * chain of configs with a critical path). The job runner (services/jobs.ts)
 * executes a config's recipe; the Sources cards read their formats from here.
 */

export const DATA_DIR = join(import.meta.dir, "..", "..", "data");
export const REPO = resolve(DATA_DIR, "..", "..", "..", "..");
export const LIMP = join(REPO, "analysis", "pipeline", "limp_study");
export const MES_HANDOFF = join(LIMP, "mes_handoff");
export const HRC_API = join(REPO, "hrc-api");

export interface LedgerFormat { id: string; label: string; site: string; seats: number; stake: string; blinds?: string; rake: { pct: number; capBb: number } | null; depths: number[]; note?: string }
export interface LedgerConfig {
  id: string; kind: string; label: string; format: string; tree?: string; inputs: string[]; produces: string[];
  runner: "hrc-zenbook" | "hrc-box" | "scripts" | "fleet" | "manual"; cost: { jobs: number; minPerJob: number; eurPerJob?: number };
  status: "done" | "planned" | "blocked"; artifact?: string; recipe?: string; env?: Record<string, string>; note?: string;
  /** rungs override for a grid config (else the format's depths) */ depths?: number[];
  /** hand-written WORK lines for kinds the code cannot enumerate */ work?: { what: string; how: string; minutes: number; solves?: number }[];
  blockedWhy?: string; locks?: { pos: string; size: number | "limp"; rangeKey: string }[];
  /** preflop-grid-asym: repo-relative path of the uneven-stack state list ({states:[{deep, short, shortSeat}]}) */ states?: string;
  /** site tag override for the chart ids (else ign<stake>) */ site?: string;
  /** charts this config will never produce, with the reason - a solver that refuses to build a tree would otherwise
   *  hold the config at "planned" for ever and block everything downstream of it. Excluded from expectedChartIds, so
   *  the set can be complete WITHOUT them, and shown as a known gap rather than silently dropped. */
  skipCharts?: { id: string; why: string }[];
  /** machines running this config side by side (else machines[runner]) — e.g. the 6-max grid spans the Windows AND Linux HRC boxes */ lanes?: number;
  /** restrict the box fan-out to these labels (Brady, 2026-09-19: "the 7 boxes on vultr + hetzner, not locally" —
   *  the Zenbook runs the live study tool, the wrapper, the API and the chart server, so it must not also solve).
   *  Empty/absent = every box the ledger lists for the runner. Passed through to the recipe as RunOpts.boxes. */
  boxes?: string[];
}

/**
 * The chart ids an HRC config is expected to put in the catalog — the same id formula as hrc-api/scripts/ledgerPlan.ts
 * (even rungs, × locks for a locked-root config, or the uneven-stack states). A config is done only when EVERY one is there;
 * a "charts:<prefix>" produce alone would call a 22-rung set done as soon as the first chart of the family landed.
 */
/** The configs the box fan-out solves (recipe hrc-box-6max): the 6-seat trees and the heads-up SnG grid share one plan
 *  layout (solves/sixmax_grid/<config>/plan_6max.json), one keeper pull, one progress page. Only the generator differs. */
export const BOX_GRID_KINDS = ["preflop-grid-6max", "preflop-grid-hu"];
export const isBoxGrid = (c: { kind: string }) => BOX_GRID_KINDS.includes(c.kind);
export function boxGridDir(c: LedgerConfig): string { return join(c.env?.HRC_API ?? process.env.HRC_API_ZENBOOK ?? "C:/Users/Brady/poker-zenbook/hrc-api", "solves", "sixmax_grid", c.id); }

/**
 * The 3-max trees a box-run config solves, read from the plan the generator writes.
 *
 * THE PLAN IS THE TRUTH (2026-09-20). A `preflop-grid` config fell through to the even `_D<d>_s<d>_eq` ladder below,
 * which is right for the Zenbook's own even grid and wrong for anything the 3-max box recipe runs: the resolve
 * proposal's pilot solves `_D100_s50_btn` and friends, so the keeper's id set never contained them and every finished
 * zip was skipped - three boxes solved for six hours and nothing reached the catalog. genThreeMaxAsymPlan writes
 * plan_3max.json on every job from the config's own env, so its ids are exactly what this config will produce.
 */
export function threeMaxChartIds(c: LedgerConfig): string[] {
  const dir = join(c.env?.HRC_API ?? process.env.HRC_API_ZENBOOK ?? "C:/Users/Brady/poker-zenbook/hrc-api", "solves", "threemax_asym", c.id);
  try {
    return (JSON.parse(readFileSync(join(dir, "plan_3max.json"), "utf-8")) as { id: string }[]).map((j) => j.id);
  } catch {
    return [];   // before the first job the plan does not exist yet; the next tick has it
  }
}

export function expectedChartIds(c: LedgerConfig, fmt: LedgerFormat | null | undefined): string[] {
  const skip = new Set((c.skipCharts ?? []).map((x) => x.id));
  const drop = (ids: string[]) => (skip.size ? ids.filter((id) => !skip.has(id)) : ids);
  if (!fmt || !["preflop-grid", "preflop-grid-asym", ...BOX_GRID_KINDS, "locked-root"].includes(c.kind)) return [];
  if (!["hrc-box", "hrc-plan", "hrc-zenbook"].includes(c.runner) && c.recipe !== "hrc-box" && c.recipe !== "hrc-plan") return [];
  if (isBoxGrid(c)) return drop(sixMaxChartIds(c, fmt));
  if (c.recipe === "hrc-box-3max") return drop(threeMaxChartIds(c));
  const num = (n: number | string) => String(n).replace(".", "_");
  const site = c.site ?? `ign${String(fmt.stake).replace(/^NL/i, "")}`;
  const seats = (fmt.seats ?? 3) === 6 ? "6max" : (fmt.seats ?? 3) === 4 ? "4max" : "3max";
  const gen = c.kind === "locked-root" ? `${seats}lock` : seats === "4max" ? "4max" : "3maxasym2ci";
  if (c.kind === "preflop-grid-asym") {
    if (!c.states) return [];
    try { return drop((JSON.parse(readFileSync(resolve(REPO, c.states), "utf-8")).states as { deep: number; short: number; shortSeat: string }[]).map((s) => `${site}_${gen}_D${num(s.deep)}_s${num(s.short)}_${s.shortSeat}`)); } catch { return []; }
  }
  const depths: number[] = (c.depths && c.depths.length) ? c.depths : fmt.depths.length ? fmt.depths : [100];
  const locks: ({ pos: string; size: number | "limp" } | null)[] = c.kind === "locked-root" ? (c.locks ?? []) : [null];
  return drop(depths.flatMap((D) => locks.map((lk) => `${site}_${gen}_D${num(D)}_s${num(D)}_eq${lk ? (lk.size === "limp" ? `_${lk.pos}limp` : `_${lk.pos}${num(lk.size)}x`) : ""}`)));
}
/** The 6-seat trees the generator (poker-zenbook/hrc-api/scripts/genSixMaxPlan.ts) writes for a config — the same
 *  ids, in the same order (open-major for the even grid; short depth × open × seat for the uneven states), so the
 *  ledger's hand-written WORK lines slice them by their `solves` counts. Driven by the config's env:
 *  SITES · DEPTHS · OPENS · GRID=off · ASYM="deep=100;shorts=30,50;opens=2.5,3;seats=all". */
export const SIX_MAX_SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
export function sixMaxAsym(c: LedgerConfig): { deep: number; shorts: number[]; opens: string[]; seats: string[] } | null {
  const a = c.env?.ASYM; if (!a) return null;
  const kv = Object.fromEntries(a.split(";").map((p) => p.split("=").map((x) => x.trim()) as [string, string]));
  return { deep: Number(kv.deep ?? 100), shorts: (kv.shorts ?? "30,50").split(",").map(Number), opens: (kv.opens ?? "2.5,3").split(",").map((s) => s.trim()),
    seats: !kv.seats || kv.seats === "all" ? SIX_MAX_SEATS : kv.seats.split(",").map((s) => s.trim().toUpperCase()) };
}
export function sixMaxChartIds(c: LedgerConfig, fmt: LedgerFormat | null | undefined): string[] {
  // the heads-up SnG grid: its ids are whatever genHuSngPlan.ts wrote (depth ladder × open × 3-bet menu), in plan order —
  // the hand-written WORK lines slice them by depth band, so the plan file is the one source of that order
  if (c.kind === "preflop-grid-hu") {
    try { return (JSON.parse(readFileSync(join(boxGridDir(c), "plan_6max.json"), "utf-8")) as { id: string }[]).map((j) => j.id); } catch { return []; }
  }
  const num = (n: number | string) => String(n).replace(".", "_");
  const env = c.env ?? {};
  const site = c.site ?? env.SITES?.split(",")[0]?.trim() ?? `ign${String(fmt?.stake ?? "").replace(/^NL/i, "")}`;
  const ids: string[] = [];
  // patch charts: one tree per explicit stack vector, ids taken straight from the states file the queue writes
  if (env.STATES) {
    try {
      const api = c.env?.HRC_API ?? process.env.HRC_API_ZENBOOK ?? "C:/Users/Brady/poker-zenbook/hrc-api";
      const st = JSON.parse(readFileSync(join(api, env.STATES), "utf-8")) as { id: string }[];
      ids.push(...st.map((x) => x.id));
    } catch { /* not written yet */ }
  }
  if (env.GRID !== "off") {
    const depths: number[] = env.DEPTHS ? env.DEPTHS.split(",").map(Number) : (c.depths && c.depths.length) ? c.depths : fmt?.depths?.length ? fmt.depths : [100];
    const opens = (env.OPENS ?? "2.5,3,2,3.5,limp").split(",").map((s) => s.trim());
    for (const o of opens) for (const D of depths) ids.push(`${site}_6max_D${num(D)}_o${o === "limp" ? "limp" : num(o)}`);
  }
  const asym = sixMaxAsym(c);
  if (asym) for (const short of asym.shorts) for (const o of asym.opens) for (const seat of asym.seats) ids.push(`${site}_6max_D${num(asym.deep)}_s${num(short)}_${seat}_o${o === "limp" ? "limp" : num(o)}`);
  return ids;
}
export interface Ledger {
  _note?: string; formats: LedgerFormat[]; trees: Record<string, any>; configs: LedgerConfig[];
  sources: Record<string, string[]>; plans: { id: string; label: string; why: string; steps: string[]; parallel?: string[][] }[];
  proposals?: { id: string; run: string; why: string; steps: string[]; input?: string[]; output?: string[]; check?: string[]; approved: { at: string } | null }[];
}

const PATH = join(DATA_DIR, "ledger.json");
let cache: { mtimeMs: number; value: Ledger } | null = null;
export function loadLedger(): Ledger {
  const st = statSync(PATH);
  if (cache && cache.mtimeMs === st.mtimeMs) return cache.value;
  const value = JSON.parse(readFileSync(PATH, "utf-8")) as Ledger;
  cache = { mtimeMs: st.mtimeMs, value };
  return value;
}

export interface Fingerprint { key: string; path: string; exists: boolean; sha256: string | null; mtimeMs: number | null; bytes: number | null; meta?: Record<string, unknown> }
function fp(key: string, path: string, meta?: Record<string, unknown>): Fingerprint {
  try {
    const st = statSync(path);
    const sha = st.size < 64 * 1024 * 1024 ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16) : null;
    return { key, path, exists: true, sha256: sha, mtimeMs: st.mtimeMs, bytes: st.size, meta };
  } catch {
    return { key, path, exists: false, sha256: null, mtimeMs: null, bytes: null, meta };
  }
}

/** Every artifact the ledger's configs can point at, fingerprinted now. */
export function artifacts(): Record<string, Fingerprint> {
  const out: Record<string, Fingerprint> = {};
  const exploitPath = process.env.EXPLOIT_CHART ?? join(LIMP, "exploit_ranges.json");
  out["exploit"] = fp("exploit", exploitPath);
  try { const e = JSON.parse(readFileSync(exploitPath, "utf-8")); out["exploit"].meta = { chart: e.chart, nodes: Object.keys(e.choices ?? {}).length, ranges: Object.keys(e.ranges ?? {}).length }; } catch { /* none */ }
  const poolPath = process.env.POOL_MODEL ?? join(LIMP, "pool_model_v4.json");
  out["pool-model"] = fp("pool-model", poolPath);
  try { const p = JSON.parse(readFileSync(poolPath, "utf-8")); out["pool-model"].meta = { chart: p.chart, decisions: Object.values(p.n ?? {}).reduce((s: number, x: any) => s + (Number(x) || 0), 0) }; } catch { /* none */ }
  out["villain-freqs"] = fp("villain-freqs", join(LIMP, "villain_freqs.json"));
  const mes = mesPostflopInfo();
  out["mes"] = fp("mes", mes.path, { families: mes.families.length, boards: mes.families.reduce((s, f) => s + f.boards.length, 0), built: mes.meta?.built_at ?? null, inputs: mes.families[0]?.inputs ?? null });
  out["resolved-charts"] = fp("resolved-charts", join(DATA_DIR, "resolved-charts.json"));
  out["strategy-matrix"] = fp("strategy-matrix", join(DATA_DIR, "strategy_matrix.json"));
  out["winrate-ladder"] = fp("winrate-ladder", join(DATA_DIR, "winrate_ladder.json"));
  // chart families come from the catalog: "charts:<prefix>" produces resolve to a count
  const cat = getCatalog();
  const byPrefix: Record<string, number> = {};
  for (const e of cat.entries as any[]) { const m = String(e.id).match(/^([a-z0-9]+_(?:3max|4max|6max)[a-z0-9]*)/i); if (m) byPrefix[m[1]!] = (byPrefix[m[1]!] ?? 0) + 1; }
  for (const [prefix, n] of Object.entries(byPrefix)) out[`charts:${prefix}`] = { key: `charts:${prefix}`, path: "catalog", exists: n > 0, sha256: null, mtimeMs: null, bytes: null, meta: { charts: n } };
  return out;
}

export interface EvaluatedConfig extends LedgerConfig {
  formatLabel: string; effective: "done" | "stale" | "planned" | "blocked" | "missing"; staleWhy: string[]; artifactFp: Fingerprint | null;
  producesFound: { key: string; found: boolean; detail: string }[]; estimate: { minutes: number; wallMinutes: number; eur: number; runner: string };
  dependents: string[];
}

function estimateOf(c: LedgerConfig): EvaluatedConfig["estimate"] {
  const minutes = c.cost.jobs * c.cost.minPerJob;
  const lanes = Math.max(1, Number(c.lanes ?? (loadLedger() as any).machines?.[c.runner] ?? (c.runner === "fleet" ? 4 : 1)));
  // jobs run one per machine, side by side: wall-clock = rounds × minutes per job
  const wall = Math.ceil(c.cost.jobs / lanes) * c.cost.minPerJob;
  const eur = c.cost.eurPerJob ? Math.round(c.cost.jobs * c.cost.eurPerJob * 100) / 100 : 0;
  return { minutes, wallMinutes: wall, eur, runner: c.runner };
}

export function evaluate() {
  const L = loadLedger();
  const A = artifacts();
  const byId = new Map(L.configs.map((c) => [c.id, c]));
  const fpOf = (c: LedgerConfig): Fingerprint | null => (c.artifact ? A[c.artifact] ?? null : null);
  let catIds = new Set<string>();
  try { catIds = new Set((getCatalog().entries as any[]).map((e) => String(e.id))); } catch { /* catalog unavailable */ }
  const configs: EvaluatedConfig[] = L.configs.map((c) => {
    const f = L.formats.find((x) => x.id === c.format);
    const artifactFp = fpOf(c);
    const producesFound = c.produces.map((p) => {
      if (p.startsWith("charts:")) {
        // per-chart: every id this config is expected to solve must be in the catalog
        const want = expectedChartIds(c, f);
        if (want.length && c.env?.PASS2 === "1") {
          // a second refinement pass re-solves ids the catalog already has: done = re-solved charts pulled into ITS plan dir
          const dir = join(c.env?.HRC_API ?? process.env.HRC_API_ZENBOOK ?? "C:/Users/Brady/poker-zenbook/hrc-api", "solves", "sixmax_grid", c.id);
          let prog: Record<string, any> = {}; try { prog = JSON.parse(readFileSync(join(dir, "progress.json"), "utf-8")); } catch { /* none yet */ }
          const have = want.filter((id) => prog[id] || existsSync(join(dir, `${id}.charts.json.gz`))).length;
          return { key: p, found: have === want.length, detail: `${have} of ${want.length} charts re-solved (second pass)` };
        }
        if (want.length) { const have = want.filter((id) => catIds.has(id)).length; return { key: p, found: have === want.length, detail: `${have} of ${want.length} charts in the catalog` }; }
        const a = A[p]; return { key: p, found: !!a?.exists, detail: a?.exists ? `${a.meta?.charts} charts in the catalog` : "no charts with this prefix" };
      }
      if (p.startsWith("path:")) { const ex2 = existsSync(p.slice(5)); return { key: p.slice(5).replace(/^.*[\\/]/, ""), found: ex2, detail: ex2 ? p.slice(5) : "not on disk" }; }
      const path = p.startsWith("mes_") ? join(DATA_DIR, p) : join(LIMP, p);
      const ex = existsSync(path);
      return { key: p, found: ex, detail: ex ? path : "not on disk" };
    });
    // a planned MES config's artifact path is the SAME file the previous generation wrote: it only counts as
    // produced when the stamp inside says it was solved against this config's own exploit file
    if (c.status !== "done" && c.artifact === "mes" && c.env?.EXPLOIT_RANGES) {
      const want = fp("want", c.env.EXPLOIT_RANGES).sha256;
      const have = (A["mes"]?.meta?.inputs as any)?.exploit_ranges?.sha256 ?? null;
      for (const p of producesFound) if (p.key === "mes_postflop.json") { p.found = !!want && have === want; p.detail = p.found ? p.detail : `on disk, but stamped with exploit_ranges ${have ?? "?"} — not this config's (${want ?? "file missing"})`; }
    }
    const staleWhy: string[] = [];
    let effective: EvaluatedConfig["effective"] = c.status;
    if (c.status === "done") {
      if (producesFound.length && producesFound.every((p) => !p.found)) effective = "missing";
      // an input that moved after the artifact was built makes it stale
      const built = artifactFp?.mtimeMs ?? null;
      for (const inId of c.inputs) {
        const inC = byId.get(inId); if (!inC) continue;
        const inFp = fpOf(inC);
        if (built != null && inFp?.mtimeMs != null && inFp.mtimeMs > built + 60_000) staleWhy.push(`${inC.label} changed ${new Date(inFp.mtimeMs).toISOString().slice(0, 16)}, after this was built ${new Date(built).toISOString().slice(0, 16)}`);
      }
      // MES carries its own stamp of the exploit/pool files it was solved against
      if (c.artifact === "mes") {
        const st = (A["mes"]?.meta?.inputs ?? null) as any;
        const exSha = A["exploit"]?.sha256, pmSha = A["pool-model"]?.sha256;
        if (st?.exploit_ranges?.sha256 && exSha && st.exploit_ranges.sha256 !== exSha) staleWhy.push(`solved against exploit_ranges ${st.exploit_ranges.sha256}, live file is ${exSha}`);
        if (st?.pool_model?.sha256 && pmSha && st.pool_model.sha256 !== pmSha) staleWhy.push(`solved against pool_model ${st.pool_model.sha256}, live file is ${pmSha}`);
      }
      if (staleWhy.length && effective === "done") effective = "stale";
    }
    // (locked-root charts run on the boxes since 2026-09-09: hrcLock.ts sets the opener's root through the bridge)
    // a planned config whose every artifact is already on disk is done (e.g. a run finished outside the queue)
    if (c.status === "planned" && producesFound.length && producesFound.every((x) => x.found) && c.kind !== "cutover") effective = "done";
    return { ...c, formatLabel: f?.label ?? c.format, effective, staleWhy, artifactFp, producesFound, estimate: estimateOf(c), dependents: L.configs.filter((o) => o.inputs.includes(c.id)).map((o) => o.id) };
  });
  const cById = new Map(configs.map((c) => [c.id, c]));
  const plans = L.plans.map((p) => {
    const steps = p.steps.map((id) => cById.get(id)).filter((x): x is EvaluatedConfig => !!x);
    const par = new Set((p.parallel ?? []).flat());
    let serial = 0, parallelMax = 0, eur = 0;
    for (const s of steps) { eur += s.estimate.eur; if (par.has(s.id)) parallelMax = Math.max(parallelMax, s.estimate.wallMinutes); else serial += s.estimate.wallMinutes; }
    const remaining = steps.filter((s) => s.effective !== "done");
    return { ...p, steps, totalWallMinutes: serial + parallelMax, totalEur: Math.round(eur * 100) / 100, remaining: remaining.length, next: remaining[0]?.id ?? null };
  });
  return { formats: L.formats, trees: L.trees, configs, plans, sources: L.sources, artifacts: A, note: L._note };
}

/**
 * How much of a solve config's chart set has actually landed in the catalog.
 *
 * The cheap half of `evaluate()`: no artifact fingerprinting, no hashing — just
 * "of the ids this config is expected to solve, how many exist". A strategy
 * whose preflop piece is still being solved reads this to decide whether it can
 * be played at all, and its Sources card reads it to say how far the run is.
 */
export function chartsLanded(configIds: string[]): {
  have: number; want: number; complete: boolean;
  perConfig: { id: string; label: string; have: number; want: number }[];
} {
  const L = loadLedger();
  let catIds = new Set<string>();
  try { catIds = new Set((getCatalog().entries as any[]).map((e) => String(e.id))); } catch { /* catalog unavailable */ }
  const perConfig = configIds.map((id) => {
    const c = L.configs.find((x) => x.id === id);
    if (!c) return { id, label: id, have: 0, want: 0 };
    const want = expectedChartIds(c, L.formats.find((f) => f.id === c.format));
    return { id, label: c.label, have: want.filter((w) => catIds.has(w)).length, want: want.length };
  });
  const have = perConfig.reduce((s, x) => s + x.have, 0);
  const want = perConfig.reduce((s, x) => s + x.want, 0);
  return { have, want, complete: want > 0 && have === want, perConfig };
}

/** Formats for a Sources card, from the ledger's source→format map. */
export function formatsForSource(cardId: string): LedgerFormat[] {
  const L = loadLedger();
  return (L.sources[cardId] ?? []).map((id) => L.formats.find((f) => f.id === id)).filter((f): f is LedgerFormat => !!f);
}
