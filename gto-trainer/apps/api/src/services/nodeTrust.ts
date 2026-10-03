/**
 * nodeTrust — is a chart node one the solver actually TRAINED? (2026-09-23, Brady: "nothing is acceptable if there
 * is a non-answer" — and a confident mix from an untrained node is worse than a non-answer.)
 *
 * HRC samples a node in proportion to how often the strategies reach it. A node reached once in 100,000 hands gets
 * a handful of visits in a 4.8-billion-hand refinement, so both its mix and its per-hand EVs are noise: the BB behind
 * two limps and an SB complete showed a check at −7.8bb in a 4bb pot. Per node, [reach, regret]: reach = the product
 * of the chart's own action frequencies along the line; regret = combo-weighted (best-action EV − EV of the chart's
 * mix) from HRC's EVs, bb per hand (analysis/pipeline/solve/node_trust_core.py).
 *
 * Calibrated on 2026-09-23 against nodes we could judge: raise-chart nodes facing an open 0.002-0.003; SB vs one limp
 * 0.010 (reach 1.9e-3, healthy); BB behind limp + complete 0.026 (2.8e-4, healthy); SB vs two limps 0.056 (1.0e-4,
 * broken: AA limp 84%); BB behind two limps + complete 1.64 (6.8e-6, broken). STARVED = regret > 0.03 or reach < 1e-4.
 *
 * WHERE THE SCORE COMES FROM (2026-10-03, audit finding 6). It used to come only from data/limp_node_trust.json, which
 * node_trust.py writes when someone runs it: 126 of the 234 baked charts were not in it, and a chart or line missing
 * from it was TRUSTED, silently — 70 of 1,092 live chart answers (2026-09-27..10-02) went out unguarded that way. The
 * bake now scores every node with its chart, in the same transaction (build_6max_preflop_db.py; backfill_trust.py for
 * the charts baked before), and this reads the bake (services/hrc6maxDb.trust):
 *   - the chart is scored in the bake       → its baked score; a node with NO ROW is REFUSED ("NO TRUST SCORE"): every
 *                                             decision node is scored with its chart, so a gap is a bug, and the exact
 *                                             tree answers rather than a mix nobody vetted;
 *   - the bake has no scores for the chart  → the old file, exactly as before, plus ONE loud log line per chart per
 *     (an old bake, or the backfill has       process — so the switch from "trusted" to "judged" happens by itself
 *     not reached it yet)                     the moment the backfill scores the chart, with no flag.
 * Once every chart is scored the 70 MB file is never parsed on the API's thread at all.
 *
 * THE LIMP TREES ARE NEVER ANSWERED UNSCORED (2026-10-02/03, the v2 limp re-solve). For an `olimp` chart the file
 * fallback refuses what it cannot score — a chart neither the bake nor the file scores ("UNSCORED CHART"), and a line
 * the file does not hold ("UNSCORED CHART NODE"; the file scores every decision node up to 12 tokens) — where the raise
 * charts still answer unguarded with the loud line above. A fresh limp tree served before anything scored it is exactly
 * the one nobody has checked. arrivalTrust applies the same verdicts to every node a flop-range walk reads.
 */
import { existsSync, readFileSync } from "node:fs";
import { factoryFile } from "./repoPaths";
import { hrc6maxDb } from "./hrc6maxDb";

export const TRUST_REGRET_MAX = 0.03;
export const TRUST_REACH_MIN = 1e-4;
/** For pool-locked trees only: past this the node is broken whatever its reach. */
export const TRUST_REGRET_CATASTROPHIC = 0.3;
export type TrustMap = Record<string, Record<string, [number | null, number]>>;
let cache: { at: number; file: string; map: TrustMap } | null = null;
let injected: TrustMap | null = null;

/** The old file: NODE_TRUST_FILE when set (the mutation harness points a git worktree, which has no data parts, at the
 *  factory's — scripts/mutationHarness.harnessEnv), else the factory's data/limp_node_trust.json. Read per call. */
export const trustFile = (): string => process.env.NODE_TRUST_FILE || factoryFile("limp_node_trust.json");

/** Tests only: judge every chart from this map, as the file would be, and skip the bake (null restores both). */
export function setTrustMap(m: TrustMap | null): void { injected = m; cache = null; }

/** The old file, parsed only when a chart without baked scores is asked about (read per call, like factoryFile). */
function map(): TrustMap {
  if (injected) return injected;
  const now = Date.now();
  const file = trustFile();
  if (cache && cache.file === file && now - cache.at < 10 * 60_000) return cache.map;
  let m: TrustMap = {};
  try { if (existsSync(file)) m = JSON.parse(readFileSync(file, "utf8")); } catch {
    // A READ MID-REWRITE (node_trust.py rewrites the file as trees land) must not empty it: an empty map refuses every
    // limp chart the bake does not score for the whole cache window. Keep the last good map and try again in a minute.
    if (cache && cache.file === file) { cache = { at: now - 9 * 60_000, file, map: cache.map }; return cache.map; }
    m = {};
  }
  cache = { at: now, file, map: m };
  return m;
}

export interface NodeTrust {
  known: boolean; reach: number | null; regret: number | null; starved: boolean; why: string | null;
  /** where the verdict came from: the bake's own scores, the old file, or nowhere (no verdict) */
  from?: "bake" | "file" | null;
}

/** Charts already reported as answering from the file (one line per chart per process, not one per decision). */
const warned = new Set<string>();
const warnFallback = (chartId: string, inFile: boolean): void => {
  if (warned.has(chartId)) return;
  warned.add(chartId);
  console.warn(inFile
    ? `[nodeTrust] ${chartId}: no trust scores in the bake — judged from limp_node_trust.json, and any line it does not ` +
      `score (past its token limit, or a body re-converted since) answers unguarded until backfill_trust.py scores the chart`
    : `[nodeTrust] UNSCORED CHART ANSWERING UNGUARDED: ${chartId} — neither the bake nor limp_node_trust.json scores it, ` +
      `so every node of it answers without the untrained-node guard until backfill_trust.py (or a re-bake) scores it`);
};
const refusedNoRow = new Set<string>();

/** Which charts the guard applies to. The map covers every chart, but the RAISE charts' deep 3-bet/4-bet nodes are
 *  starved by the same bound (94-98% of their nodes) and switching them over to the exact tree is Brady's call —
 *  TRUST_GUARD_ALL=1 widens it; until then only the limp trees are guarded. */
export const guardApplies = (chartId: string): boolean => process.env.TRUST_GUARD_ALL === "1" || /olimp/.test(chartId);
/** The limp trees: never answered from a node nothing has scored (see the module doc). */
const isLimpTree = (chartId: string): boolean => /olimp/.test(chartId);

/** The trust verdict for one chart node; `known:false` when nothing scores the node (no verdict). */
export function nodeTrust(chartId: string, line: string): NodeTrust {
  if (!guardApplies(chartId)) return { known: false, reach: null, regret: null, starved: false, why: null, from: null };
  const baked = injected ? undefined : hrc6maxDb.trust(chartId, line);
  if (baked === null) {
    const key = `${chartId} ${line}`;
    if (!refusedNoRow.has(key)) {
      refusedNoRow.add(key);
      console.warn(`[nodeTrust] NO TRUST SCORE: ${chartId} is scored in the bake but "${line || "root"}" has no row — refused`);
    }
    return { known: true, reach: null, regret: null, starved: true, from: "bake",
      why: `NO TRUST SCORE: ${chartId} is scored in the bake but its node "${line || "root"}" has no score — every decision ` +
        `node is scored with its chart, so this is a bake bug, and an unvetted mix is not served; the exact tree answers instead` };
  }
  let t: [number | null, number] | undefined;
  let from: "bake" | "file" = "bake";
  if (baked) t = [baked.reach, baked.regret];
  else {
    from = "file";
    const chart = map()[chartId];
    if (isLimpTree(chartId)) {
      // A LIMP TREE NOTHING SCORES IS REFUSED (2026-10-02): the raise charts answer unguarded below, a limp tree does not
      if (!chart) {
        return { known: false, reach: null, regret: null, starved: true, from: null,
          why: `UNSCORED CHART: ${chartId} is scored neither in the bake nor in limp_node_trust.json — refused until ` +
            `node_trust.py / backfill_trust.py has scored it; the exact tree answers instead` };
      }
      if (!chart[line]) {
        return { known: false, reach: null, regret: null, starved: true, from: "file",
          why: `UNSCORED CHART NODE: "${line || "root"}" is not in ${chartId}'s trust scores (limp_node_trust.json scores ` +
            `every decision node up to 12 tokens — deeper or absent means unscored), so its mix is unchecked; the exact tree answers instead` };
      }
    } else warnFallback(chartId, !!chart);
    t = chart?.[line];
  }
  if (!t) return { known: false, reach: null, regret: null, starved: false, why: null, from: null };
  const [reach, regret] = t;
  const lowReach = reach != null && reach < TRUST_REACH_MIN;
  // A POOL-LOCKED TREE IS JUDGED BY REACH (2026-09-24). Its locked nodes carry the pool's mix by construction, so
  // their regret measures the pool's leak, not convergence (the SB's complete behind two limps reads 0.21); and its
  // responder nodes sit in bigger pots where a converged mix still spreads over several +EV raise sizes (the BB
  // behind two limps and a complete: 0.06, every option +EV, against 1.64 with a check at −7.8bb in the
  // equilibrium tree). The locks are what train those nodes — reach 1 in 3,400 there against 1 in 147,000 —
  // so reach is the test, with only a catastrophic regret still refusing.
  const pooled = /_pool\d*$|_widex$/.test(chartId);
  const highRegret = regret > (pooled ? TRUST_REGRET_CATASTROPHIC : TRUST_REGRET_MAX);
  if (!lowReach && !highRegret) return { known: true, reach, regret, starved: false, why: null, from };
  const reachTxt = reach != null ? (reach > 0 ? `1 in ${Math.round(1 / reach).toLocaleString()} hands` : "never") : "unknown";
  return { known: true, reach, regret, starved: true, from,
    why: `UNTRAINED CHART NODE: the chart's own play reaches "${line || "root"}" ${reachTxt}` +
      ` and its mix gives up ${regret.toFixed(3)} bb/hand against its own EVs (trained nodes sit near 0.003) — ` +
      `the solver never sampled it, so its mix is noise; the exact tree answers instead` };
}

/** Tests only: forget the one-line-per-chart memory and the file cache. */
export function resetNodeTrustForTests(): void {
  warned.clear();
  refusedNoRow.clear();
  cache = null;
}

/**
 * THE FLOP-ARRIVAL RANGES MUST COME FROM TRUSTED NODES TOO (2026-10-02). A limp chart's flop ranges are the product of
 * every decision on the preflop line — the limpers', the iso-raiser's, the callers' — and until now only hero's own
 * node was ever judged: a closed limped line read its villains' ranges from nodes the solver never trained (or nothing
 * has scored) without a word. `lines` = the tree path before each decision the range walk read (reconstructFlopRanges
 * onStep `line`: real nodes only, forced folds have none). Limp trees only (whatever TRUST_GUARD_ALL says, the raise
 * charts' ranges stay as they were). Returns the first refusal, or null.
 */
export function arrivalTrust(chartId: string, lines: Iterable<string>): (NodeTrust & { line: string }) | null {
  if (!isLimpTree(chartId)) return null;
  for (const line of new Set(lines)) {
    const t = nodeTrust(chartId, line);
    if (t.starved) return { ...t, line };
  }
  return null;
}
