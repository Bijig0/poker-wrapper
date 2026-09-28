/**
 * nodeTrust — is a chart node one the solver actually TRAINED? (2026-09-23, Brady: "nothing is acceptable if there
 * is a non-answer" — and a confident mix from an untrained node is worse than a non-answer.)
 *
 * HRC samples a node in proportion to how often the strategies reach it. A node reached once in 100,000 hands gets
 * a handful of visits in a 4.8-billion-hand refinement, so both its mix and its per-hand EVs are noise: the BB behind
 * two limps and an SB complete showed a check at −7.8bb in a 4bb pot. analysis/pipeline/solve/node_trust.py reads
 * every chart and writes, per node, [reach, regret]: reach = the product of the chart's own action frequencies along
 * the line; regret = combo-weighted (best-action EV − EV of the chart's mix) from HRC's EVs, bb per hand.
 *
 * Calibrated on 2026-09-23 against nodes we could judge: raise-chart nodes facing an open 0.002-0.003; SB vs one limp
 * 0.010 (reach 1.9e-3, healthy); BB behind limp + complete 0.026 (2.8e-4, healthy); SB vs two limps 0.056 (1.0e-4,
 * broken: AA limp 84%); BB behind two limps + complete 1.64 (6.8e-6, broken). STARVED = regret > 0.03 or reach < 1e-4.
 */
import { existsSync, readFileSync } from "node:fs";
import { factoryFile } from "./repoPaths";
import { join } from "node:path";

export const TRUST_REGRET_MAX = 0.03;
export const TRUST_REACH_MIN = 1e-4;
/** For pool-locked trees only: past this the node is broken whatever its reach. */
export const TRUST_REGRET_CATASTROPHIC = 0.3;
const FILE = factoryFile("limp_node_trust.json");

type TrustMap = Record<string, Record<string, [number | null, number]>>;
let cache: { at: number; map: TrustMap } | null = null;

function map(): TrustMap {
  const now = Date.now();
  if (cache && now - cache.at < 10 * 60_000) return cache.map;
  let m: TrustMap = {};
  try { if (existsSync(FILE)) m = JSON.parse(readFileSync(FILE, "utf8")); } catch { m = {}; }
  cache = { at: now, map: m };
  return m;
}

export interface NodeTrust { known: boolean; reach: number | null; regret: number | null; starved: boolean; why: string | null }

/** The trust verdict for one chart node; `known:false` when the chart or the line is not in the map (no verdict). */
/** Which charts the guard applies to. The map covers every chart, but the RAISE charts' deep 3-bet/4-bet nodes are
 *  starved by the same bound (94-98% of their nodes) and switching them over to the exact tree is Brady's call —
 *  TRUST_GUARD_ALL=1 widens it; until then only the limp trees are guarded. */
export const guardApplies = (chartId: string): boolean => process.env.TRUST_GUARD_ALL === "1" || /olimp/.test(chartId);

export function nodeTrust(chartId: string, line: string): NodeTrust {
  if (!guardApplies(chartId)) return { known: false, reach: null, regret: null, starved: false, why: null };
  const t = map()[chartId]?.[line];
  if (!t) return { known: false, reach: null, regret: null, starved: false, why: null };
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
  if (!lowReach && !highRegret) return { known: true, reach, regret, starved: false, why: null };
  const reachTxt = reach != null ? (reach > 0 ? `1 in ${Math.round(1 / reach).toLocaleString()} hands` : "never") : "unknown";
  return { known: true, reach, regret, starved: true,
    why: `UNTRAINED CHART NODE: the chart's own play reaches "${line || "root"}" ${reachTxt}` +
      ` and its mix gives up ${regret.toFixed(3)} bb/hand against its own EVs (trained nodes sit near 0.003) — ` +
      `the solver never sampled it, so its mix is noise; the exact tree answers instead` };
}

