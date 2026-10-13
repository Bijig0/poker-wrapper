/**
 * THE RESIDUE GATE (2026-10-13, Brady approved the design the same day) — a chart answer read behind an action whose
 * exact SIZE is a leftover in the HRC chart goes to the exact GTO Wizard AI preflop tree.
 *
 * Hand 4923399329 (answers row 13446): the CO 3-bet to 9.2bb, the walk snapped it onto ign200_6max_D50_o2_5's R9 — a
 * size the CO uses with 0.14% of his range, while his 3-bets sit on R7.5 (8.18%). The calibration (41 hands against GTO
 * Wizard's EVs, memory residue-routing-calibrated) showed the PREFLOP answer at such a node costs ~0 (≤ 0.05bb), but the
 * FLOP ranges walked off it hand the villain a 1.9-combo sliver instead of his ~104-combo 3-bet range. GTO Wizard's AI
 * preflop tree holds ONE size per level, the size played, so the villain takes his whole action at the real size there,
 * and the flop resumes from that tree through the preflop pin.
 *
 * THE RULE, per action on hero's line before his current decision — every villain's AND hero's own earlier ones — with
 * that player's range rebuilt from his own earlier actions on the chart (169 classes, 6/4/12 combos × the cell's %):
 *   s = the share of his range taking that exact token
 *   a = the share taking that action TYPE at any size (every non-all-in raise together; an all-in counts with the
 *       raises only when the token taken is the all-in)
 *   FIRES when s < 1% AND a ≥ 1% AND a ≥ 5·s.
 * a < 1% is a rare ACTION (a limp, a cold call): not this rule — the pool locks own those (a = s for a call or a limp,
 * so they never fire here). Exemption: hero's chart answer Fold ≥ 99% (costless, and there is no flop).
 *
 * The bake's trust.reach child/parent ratio is NOT a valid share for a player's second action (census 2026-10-13: off by
 * a median 1.5pp) — the ranges are rebuilt exactly, by the same walk check #3 scores villain lines with
 * (fastSolve.scoreChartLine is a view of chartLineShares below).
 *
 * PREFLOP_RESIDUE_GATE=log|live|off, read at every decision, DEFAULT log: log computes the verdict, logs a
 * "[residue-gate] would route …" line and serves the chart exactly as before; live routes through the gap gate's
 * machinery (services/treeGap reason rule "residue", path code preflop:residue-gate); off computes nothing.
 * Register entry: services/approximations.ts "preflop-residue-gate".
 */
import type { HrcNode } from "./hrc3max";

export type ResidueGateMode = "live" | "log" | "off";
export const residueGateMode = (): ResidueGateMode => {
  const v = String(process.env.PREFLOP_RESIDUE_GATE ?? "log").trim().toLowerCase();
  return v === "live" || v === "off" ? v : "log";
};

/** s below this: the size is a leftover of the chart */
export const RESIDUE_SHARE = 0.01;
/** a at or above this: the action itself is a real part of his strategy */
export const RESIDUE_ACTION = 0.01;
/** a at least this many times s: the action lives on another size */
export const RESIDUE_RATIO = 5;
/** hero's chart answer folds at least this often (percent): no route */
export const RESIDUE_FOLD_EXEMPT = 99;

export type ActionType = "fold" | "check" | "call" | "raise" | "allin";
/** One action on the line, as a share of the range its player takes it with. */
export interface LineShare {
  seat: string;
  /** the chart's token taken ("R9") and the node's label for it ("Raise 9") */
  code: string;
  label: string;
  /** the line before the action ("F-R2.5") */
  line: string;
  hero: boolean;
  type: ActionType;
  /** s: the share of his range taking this exact token (0..1) */
  nodeFreq: number;
  /** a: the share taking this action type at any size (0..1) — equal to s for a fold, a check or a call */
  typeFreq: number;
  /** the largest frequency any one class gives the token (0..1) */
  maxHand: number;
}

/** combos a hand class stands for (AA 6, AKs 4, AKo 12) */
export const classCombos = (cls: string): number => (cls.length === 2 ? 6 : cls.endsWith("s") ? 4 : 12);

/** The type of a node action: by its token, the label telling an all-in from a raise. */
export function actionType(a: { action: string; token: string | null }): ActionType {
  const t = String(a.token ?? "").toUpperCase(), l = a.action.toLowerCase();
  if (t === "F" || (!t && /^fold/.test(l))) return "fold";
  if (t === "X" || (!t && /^check/.test(l))) return "check";
  if (t === "C" || (!t && /call|limp|complete/.test(l))) return "call";
  return /all-?in/.test(l) ? "allin" : "raise";
}

/**
 * Every action on `line`, scored against the range its player takes it with (each player's range = his own earlier
 * actions on this chart; the first time he acts, his whole range). Reads the nodes through `get` — the solve hands its
 * walk's own (memoised) getter, so nothing is read twice. `forcedFolds`: a missing node followed by a fold is the
 * trees' maxactive forced fold (hrc3max.walk3max) — stepped over, no decision; without it a missing node is "na" (the
 * historical behaviour check #3's scorer keeps).
 */
export async function chartLineShares(get: (line: string) => Promise<HrcNode | null | "unreachable">, line: string | null | undefined,
    heroPos: string | null, opts: { forcedFolds?: boolean } = {}): Promise<{ lines: LineShare[] } | { na: string }> {
  const tokens = (line ?? "").split("-").filter(Boolean);
  if (!tokens.length) return { lines: [] };
  const hero = (heroPos ?? "").toUpperCase();
  const weights = new Map<string, Map<string, number>>();
  const out: LineShare[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const at = tokens.slice(0, k).join("-");
    const n = await get(at);
    if (!n && opts.forcedFolds && tokens[k] === "F" && at) continue;
    if (!n || n === "unreachable") return { na: `the chart's node '${at || "root"}' could not be read to score the villain lines` };
    if (n.terminal) break;
    const actor = (n.pos ?? "").toUpperCase();
    const act = n.actions.find((a) => a.token === tokens[k]);
    if (!act) return { na: `the chart's node '${at || "root"}' has no '${tokens[k]}' to score` };
    const type = actionType(act);
    // the labels counted in a: the same type at any size; an all-in taken counts every raise with it
    const typeLabels = new Set(n.actions.filter((x) => {
      const t = actionType(x);
      return type === "allin" ? t === "raise" || t === "allin" : t === type;
    }).map((x) => x.action));
    const w = weights.get(actor);
    let tot = 0, took = 0, tookType = 0, maxHand = 0;
    const next = new Map<string, number>();
    for (const c of n.cells) {
      const wc = w ? w.get(c.hand) ?? 0 : 1;
      const f = (c.actions[act.action] ?? 0) / 100;
      next.set(c.hand, wc * f);
      if (!(wc > 0)) continue;
      let ft = 0;
      for (const lab of typeLabels) ft += (c.actions[lab] ?? 0) / 100;
      const comb = classCombos(c.hand) * wc;
      tot += comb; took += comb * f; tookType += comb * ft;
      if (f > maxHand) maxHand = f;
    }
    out.push({ seat: actor, code: tokens[k]!, label: act.action, line: at, hero: !!actor && actor === hero, type,
      nodeFreq: tot > 0 ? took / tot : 0, typeFreq: tot > 0 ? tookType / tot : 0, maxHand });
    weights.set(actor, next);
  }
  return { lines: out };
}

/** The actions on the line the rule fires on: s < 1%, a ≥ 1%, a ≥ 5·s. */
export function residueHits(lines: readonly LineShare[]): LineShare[] {
  return lines.filter((l) => l.nodeFreq < RESIDUE_SHARE && l.typeFreq >= RESIDUE_ACTION && l.typeFreq >= RESIDUE_RATIO * l.nodeFreq);
}

/** What an earlier decision of the hand the rule routed leaves on the hand's preflop pin (services/preflopPin): its
 *  later preflop decisions are routed too, so the hand stays on one tree family; `aiFailed` = the exact tree did not
 *  answer and the CHART answer is pinned — the flop must not silently walk the leftover node (fastSolve arrival). */
export interface ResidueMark {
  /** the decision that was routed: hand.actions.length then, and the capture's tokens up to hero's node */
  at: number;
  rawTokens: string[];
  chart: string;
  seat: string;
  code: string;
  line: string;
  s: number;
  a: number;
  aiFailed?: boolean;
}

/** The residue gate's record on a 6-max chart decision (answers.path → $.treeGap.residue). */
export interface ResidueVerdict {
  mode: ResidueGateMode;
  /** the actions the rule fires on (empty = none) */
  hits: { seat: string; hero: boolean; code: string; label: string; type: ActionType; line: string; s: number; a: number }[];
  /** an earlier decision of this hand was routed by the rule (hand consistency) */
  sticky?: { seat: string; code: string; line: string; at: number; s: number; a: number };
  /** hero's chart answer folds ≥ 99%: no route (only when not sticky) */
  exempt?: "fold";
  /** fire = the rule would route this decision (hits or sticky, not exempt) */
  fire: boolean;
  /** the line could not be scored */
  na?: string;
}

const pc = (x: number) => `${(100 * x).toFixed(2)}%`;
const typeWord = (t: ActionType) => (t === "allin" ? "raises (all-in included)" : t === "raise" ? "raises" : `${t}s`);
/** One hit as a sentence. */
export function residueHitText(h: ResidueVerdict["hits"][number]): string {
  return `the ${h.hero ? "hero's own " : ""}${h.seat}'s ${h.label || h.code} at "${h.line || "root"}" is ${pc(h.s)} of his range while his ${typeWord(h.type)} are ${pc(h.a)} — a size the chart barely uses`;
}

/**
 * The verdict for one decision, pure. `heroFold` = hero's chart Fold % at his node (null = no cell); `sticky` = the
 * mark an earlier decision of this hand left.
 */
export function residueVerdict(a: { mode: ResidueGateMode; shares: { lines: LineShare[] } | { na: string }; heroFold: number | null;
    sticky?: ResidueMark | null }): ResidueVerdict {
  const hits = "lines" in a.shares ? residueHits(a.shares.lines).map((l) => ({ seat: l.seat, hero: l.hero, code: l.code, label: l.label, type: l.type, line: l.line, s: l.nodeFreq, a: l.typeFreq })) : [];
  const sticky = a.sticky ? { seat: a.sticky.seat, code: a.sticky.code, line: a.sticky.line, at: a.sticky.at, s: a.sticky.s, a: a.sticky.a } : undefined;
  // the exemption is for a fresh hit only: a hand an earlier decision moved onto the exact tree stays on it
  const exempt = !sticky && hits.length && a.heroFold != null && a.heroFold >= RESIDUE_FOLD_EXEMPT ? "fold" as const : undefined;
  return { mode: a.mode, hits, ...(sticky ? { sticky } : {}), ...(exempt ? { exempt } : {}), fire: (hits.length > 0 || !!sticky) && !exempt,
    ...("na" in a.shares ? { na: a.shares.na } : {}) };
}

/** A node getter that reads each line once per solve (a failed read — "unreachable" — is not kept). */
export function memoNodes<G extends (line: string) => Promise<HrcNode | null | "unreachable">>(g: G): G {
  const m = new Map<string, Promise<HrcNode | null | "unreachable">>();
  return ((line: string) => {
    let p = m.get(line);
    if (!p) {
      p = g(line);
      m.set(line, p);
      p.then((n) => { if (n === "unreachable") m.delete(line); }, () => m.delete(line));
    }
    return p;
  }) as G;
}
