/**
 * VILLAIN MISTAKE LINES — "off-tree" villain lines (2026-09-27, Brady: "mark when an action is off-tree by some
 * threshold … later on we figure out what the range actually looks like and nodelock"). A villain action the
 * equilibrium almost never takes: hand 4920638634's HJ flop bet was 0.16% of the node, no hand above 0.41%, and worse
 * than checking for every hand (median 0.14bb).
 *
 * THESE FREQUENCIES ARE NOT SOLVER NOISE (correction, 2026-09-27). GTO Wizard's custom solves are QRE — a quantal
 * response equilibrium — since 2025-04-16: every action carries a small, deliberately modelled probability, larger
 * for the hands it costs least. A 0.16% bet is the solver's model of a MISTAKE: which hands make it, and how often.
 * The chain narrows villain's range by exactly that mistake distribution, so the next streets are solved against the
 * hands QRE says would make this mistake — a model, but not the population's. That is why the line is worth
 * flagging: the pool's mistakes are not QRE's. A flag is never a verdict (chainChecks check #3). The lines are logged
 * (services/offTreeLog) with villain's hand when Ignition's history shows it.
 *
 * THE SOFT RANGE (OPTION 3, Brady 2026-10-05; measured and approved 2026-10-06). Narrowing by the QRE strategy leaves
 * "the hands QRE says would make this mistake": a sliver (po_hu-004: UTG 0.29 combos into the turn), and every later
 * street is solved against it. Measured on 2,773 villain actions with the exact GTO Wizard node AND villain's real cards
 * (Ignition's downloaded histories; scripts/research/offtree-ranges): on the 251 actions the solver takes under 20%,
 * the QRE narrowing scores -1.39 bits per action against ignoring the action (it rules out hands real players hold);
 * range x exp(-dEV_h / T) with T = 10% of the pot scores +0.06, pot-relative T beating T in bb in every band. So after
 * an OFF-TREE villain action the chain carries
 *     range(h) x exp(-(EV_best(h) - EV_taken(h)) / (t x pot at the node)),   t = 0.20 (0.10 until the re-fit below)
 * instead of range x strategy (T -> 0 = only the hands for which the action is best; T -> infinity = the range before
 * the action). Off switch OFFTREE_RANGE (soft = carry it · log = compute + record, keep QRE · off = neither), read at
 * every decision; register entry offtree-soft-range (services/approximations).
 *
 * THE DUST FIX (2026-10-06): `maxHand` (the "no hand above 2%" half of the detector) ignores combos under 1% of the
 * seat's top weight — in po_hu-004 Td9d at weight 0.0001 checking 2.3% vetoed the flag. Postflop chain only: the
 * preflop fit (gtowAiPreflop) calls offTreeStats without it and is unchanged.
 *
 * THE POSTFLOP TRIGGER IS THE NODE SHARE ALONE (2026-10-06, Brady's go relayed; scripts/research/offtree-ranges/
 * detector_rules.py). The "no hand above 2%" half kept the QRE sliver wherever one hand took the action a little more
 * often: 111 of the 334 villain nodes under 1% in the traces, 98 of them leaving him under 1.5 combos (stress-500
 * pf_srp-001's turn bet at 0.1%, po_3way-004's flop call at 0.3%). On those nodes with villain's real cards (NL100/200,
 * 17 with the hand in range) the QRE narrowing scored -1.70 bits per action against ignoring the action [-2.78, -0.70]
 * and the soft range +0.01; every looser cut (5%, 10%, 20%) pointed the same way. So the postflop chain fires on share
 * < 1% alone (isOffTreePostflop); OFFTREE_MAX_HAND=0.02 brings the old second condition back. maxHand is still computed
 * and shown. The preflop fit's isOffTree keeps both halves.
 *
 * THE BLEND (2026-10-13, Brady: "lock on … just go for it", after the EV test). The soft range covers the hands real
 * players hold but throws away the action's STRENGTH signal: at the trigger (82 NL100/200 off-tree actions with real
 * cards) real players held two pair+ 14.6% / air 30.5%, the soft range 6.7% / 40.0% (= his range before the action), the
 * QRE sliver 15.6% / 26.5% (shape test, poker-data/audits/offtree-shape-2026-10-13). An EV test then solved hero's node
 * after 95 real heads-up off-tree wagers (poker-data-offtree-ev, 978 requests) with villain's node locked to each range
 * and scored hero's answer against a reference range matching the real cards' hand-category mix: loss % of pot, today's
 * QRE 1.35 [0.94, 1.82], soft 1.85 [1.03, 3.23], BLEND 0.73 [0.54, 0.93] (beats QRE +0.62 [+0.22, +1.10], soft +1.13
 * [+0.39, +2.38]). The blend = OFFTREE_BLEND_W (0.5) x his QRE narrowing + the rest x the soft range, each normalised to
 * one, as a per-combo factor on his range scaled so the most likely hand keeps weight 1 (blendOffTreeRange). Default
 * since 2026-10-13: OFFTREE_RANGE unset = blend (soft / log / off as before), and the mid-street lock ON (OFFTREE_LOCK
 * unset = on), so hero's own answer on the street of the off-tree action is solved against it too.
 *
 * Pure: the chain computes the numbers on the node it already read.
 */

/** the action's share of villain's range at the node, and the most any one hand takes it: both under = off-tree */
export const OFF_TREE_NODE_FREQ = 0.01;
export const OFF_TREE_MAX_HAND = 0.02;
/** a combo under this share of the seat's top weight does not vote in maxHand (the dust fix, postflop chain only) */
export const OFF_TREE_DUST = 0.01;
/** the soft range's temperature as a share of the pot at the node (fitted 2026-10-06; OFFTREE_RANGE_T overrides) */
export const OFF_TREE_SOFT_T = 0.2;

export interface OffTreeStats {
  /** share of villain's range (by weight) that takes the action at this node */
  nodeFreq: number;
  /** the highest frequency any one hand in his range takes it with */
  maxHand: number;
  /** what the action costs him on average (bb): each hand's best action's EV minus the action's EV, range-weighted;
   *  null when the node carries no per-hand EVs */
  evGapBb: number | null;
}

/** What the off-tree range did at an off-tree node (OFFTREE_RANGE = blend, soft or log). */
export interface OffTreeSoft {
  /** blend = the blend carried (default since 2026-10-13) · soft = the soft range carried · log = computed, QRE kept */
  mode: "blend" | "soft" | "log";
  /** the blend's weight on his QRE narrowing (mode blend, and log since 2026-10-13: log computes the blend) */
  w?: number;
  /** the temperature as a share of the pot, and the pot it was taken of (bb) */
  t: number;
  pot: number;
  /** villain's range after the action: today's QRE narrowing and the soft one (combos, as the walk carries them) */
  qreCombos: number;
  softCombos: number | null;
  /** carried into the rest of the hand (mode soft and computable) */
  applied: boolean;
  /** why it was not computable (no per-combo EVs, no pot) */
  why?: string;
  /** a mid-street node lock that made the rest of the street read the soft range (OFFTREE_LOCK=on) */
  lock?: { ok: boolean; solId?: string; why?: string };
}

export interface OffTreeLine extends OffTreeStats {
  street: "flop" | "turn" | "river";
  /** villain's seat (position) and whether he was in position on the street */
  seat: string;
  inPosition: boolean;
  /** the action as GTO Wizard names it (BET / RAISE / CALL / CHECK / FOLD / ALLIN), its code and size (bb) */
  action: string;
  code: string;
  betsize: number | null;
  /** the street's codes before this action, and the pot at the node */
  codes: string[];
  potNode: number;
  /** the soft range at this node (absent with OFFTREE_RANGE=off and on lines logged before 2026-10-06) */
  soft?: OffTreeSoft;
}

type Sol = { strategy?: number[] | null; evs?: number[] | null };

/** The node's numbers for the action taken, from villain's range entering the node (before it is narrowed). `dust`: a
 *  combo under that share of the range's top weight does not count toward maxHand (the postflop chain passes
 *  OFF_TREE_DUST; preflop passes nothing and is unchanged). */
export function offTreeStats(range: number[], sols: Sol[], taken: number, opts: { dust?: number } = {}): OffTreeStats {
  const f = sols[taken]?.strategy ?? [];
  let w = 0, wf = 0, maxHand = 0, gw = 0, gap = 0, evsOk = sols.every((s) => Array.isArray(s.evs) && s.evs.length > 0);
  let top = 0;
  if (opts.dust) for (const x of range) if ((x ?? 0) > top) top = x ?? 0;
  const floor = opts.dust ? opts.dust * top : 0;
  for (let i = 0; i < range.length; i++) {
    const wi = range[i] ?? 0;
    if (!(wi > 0)) continue;
    const fi = f[i] ?? 0;
    w += wi; wf += wi * fi;
    if (fi > maxHand && wi >= floor) maxHand = fi;
    if (evsOk) {
      let best = -Infinity;
      for (const s of sols) { const e = s.evs![i]; if (e != null && Number.isFinite(e) && e > best) best = e; }
      const mine = sols[taken]!.evs![i];
      if (Number.isFinite(best) && mine != null && Number.isFinite(mine)) { gap += wi * (best - mine); gw += wi; }
    }
  }
  return { nodeFreq: w > 0 ? wf / w : 0, maxHand, evGapBb: gw > 0 ? Math.round((gap / gw) * 1000) / 1000 : null };
}

export const isOffTree = (s: OffTreeStats): boolean => s.nodeFreq < OFF_TREE_NODE_FREQ && s.maxHand < OFF_TREE_MAX_HAND;

/** OFFTREE_MAX_HAND, read at every decision: the postflop trigger's "no hand above" cut — unset = none (the node share
 *  alone, since 2026-10-06), a number in (0, 1] = that cut (0.02 = the rule before). */
export function offTreeMaxHand(): number {
  const v = Number(process.env.OFFTREE_MAX_HAND);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : Infinity;
}
/** THE POSTFLOP CHAIN'S TRIGGER: the action is under 1% of his range at the node (and under OFFTREE_MAX_HAND's cut for
 *  every hand, when one is set). The preflop fit keeps isOffTree. */
export const isOffTreePostflop = (s: OffTreeStats): boolean => s.nodeFreq < OFF_TREE_NODE_FREQ && s.maxHand < offTreeMaxHand();

/** OFFTREE_RANGE, read at every decision: blend (unset, since 2026-10-13) = carry the blend · soft = carry the soft range
 *  (the rule 2026-10-06 .. 10-13) · log = compute and record the blend, keep the QRE narrowing · off = neither (the
 *  narrowing of before 2026-10-06). */
export function offTreeRangeMode(): "blend" | "soft" | "log" | "off" {
  const v = String(process.env.OFFTREE_RANGE ?? "blend").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" ? "off" : v === "log" ? "log" : v === "soft" ? "soft" : "blend";
}
/** OFFTREE_BLEND_W, read at every decision: the blend's weight on his QRE narrowing, in [0, 1] (0 = the soft range's
 *  shape, 1 = QRE's); unset or not a number = 0.5, the weight the EV test measured. */
export function offTreeBlendW(): number {
  const raw = process.env.OFFTREE_BLEND_W;
  const v = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5;
}
/** the soft range's temperature as a share of the pot: OFFTREE_RANGE_T when it is a sane number, else 0.20 (pool-soft: 0.20).
 *  T RE-FITTED 2026-10-06 on the trigger itself: with the NL200 pilot (526 heads-up NL200 spots solved on GTO Wizard
 *  from Ignition's downloaded histories, scripts/offtreePilot.ts) the NL100/200 off-tree sample reached 57 actions with
 *  villain's hand in range (81 at share < 1%). T = 10% of the pot scored -0.11 bits/action against ignoring the action
 *  there; 20% -0.01, paired +0.10 [+0.01, +0.19] over 10% (share < 1%: +0.07 [+0.01, +0.14]; < 5%: +0.05 [+0.00,
 *  +0.10]); 30-100% no better than 20% (the curve is flat at the value of ignoring the action). QRE -0.30 / -0.53. */
export function offTreeSoftT(): number {
  const t = Number(process.env.OFFTREE_RANGE_T);
  return Number.isFinite(t) && t > 0 && t < 100 ? t : OFF_TREE_SOFT_T;
}
/** OFFTREE_LOCK: an off-tree villain action with more of the street to read is node-locked so the rest of the street
 *  (hero's node included) is solved against the range carried (the blend). ON unless set off (2026-10-13, after the EV
 *  test: hero's answer on that street is where the blend measured best); each lock is one GTO Wizard POST + its reads. */
export const offTreeLockOn = (): boolean => !/^(off|0|false|no)$/.test(String(process.env.OFFTREE_LOCK ?? "on").trim().toLowerCase());

/**
 * THE SOFT RANGE after an off-tree action: range(h) x exp(-dEV_h / (t x pot)), dEV_h = the hand's best action's EV minus
 * the taken action's (bb, as GTO Wizard reports them); a combo the node plays no strategy for (a board card) is dropped,
 * as the QRE narrowing drops it. `why` instead when the node carries no per-combo EVs for every
 * action or the pot is not positive (the caller keeps the QRE narrowing and says so). Weights stay absolute (combos
 * comparable with the range before), never above the range's own. `factor` = exp(...) per combo, for a node lock.
 */
export function softOffTreeRange(range: number[], sols: Sol[], taken: number, pot: number, t: number):
  { range: number[]; combos: number; factor: number[] } | { why: string } {
  if (!(pot > 0) || !(t > 0)) return { why: `no pot at the node (${pot})` };
  const evs = sols.map((s) => s.evs);
  if (!sols[taken] || !evs.every((e) => Array.isArray(e) && e.length >= range.length)) return { why: "the node carries no per-combo EVs" };
  const T = t * pot;
  const factor = new Array<number>(range.length).fill(0);
  const out = new Array<number>(range.length).fill(0);
  let combos = 0;
  for (let i = 0; i < range.length; i++) {
    const wi = range[i] ?? 0;
    if (!(wi > 0)) continue;
    // a combo the node plays no strategy for is not a hand he can hold there: a board card (GTO Wizard gives it strategy 0
    // and EV 0 for every action, so exp(-0) would keep it whole) — the QRE narrowing drops it, so does this
    let played = 0;
    for (const s of sols) played += s.strategy?.[i] ?? 0;
    if (!(played > 0.5)) continue;
    let best = -Infinity;
    for (const e of evs) { const x = e![i]; if (x != null && Number.isFinite(x) && x > best) best = x; }
    const mine = evs[taken]![i];
    const gap = Number.isFinite(best) && mine != null && Number.isFinite(mine) ? Math.max(0, best - mine) : 0;
    const f = Math.exp(-gap / T);
    factor[i] = f;
    out[i] = wi * f;
    combos += out[i]!;
  }
  if (!(combos > 0)) return { why: "the soft range came out empty" };
  return { range: out, combos, factor };
}

/**
 * THE BLEND after an off-tree action (2026-10-13, the header): w x his QRE narrowing (range x the solver's strategy for the
 * action) + (1 - w) x the soft range, each normalised to one, as a per-combo factor on his range scaled so its largest is 1
 * (the most likely hand keeps his whole weight; never above the range's own). `factor` is what a node lock gives the
 * action (offTreeLock scales by the largest factor anyway). Falls back to the soft range alone when the QRE narrowing is
 * empty, and says why when the soft range is not computable.
 */
export function blendOffTreeRange(range: number[], sols: Sol[], taken: number, pot: number, t: number, w: number):
  { range: number[]; combos: number; factor: number[] } | { why: string } {
  const sr = softOffTreeRange(range, sols, taken, pot, t);
  if ("why" in sr) return sr;
  const strat = sols[taken]?.strategy ?? [];
  const n = range.length;
  const qre = new Array<number>(n).fill(0);
  let qSum = 0;
  // the same combos the soft range keeps (a board card / a hand the node plays no strategy for is not his)
  for (let i = 0; i < n; i++) {
    const x = (range[i] ?? 0) > 0 && (sr.factor[i] ?? 0) > 0 ? (range[i] ?? 0) * Math.max(0, strat[i] ?? 0) : 0;
    qre[i] = x; qSum += x;
  }
  let sSum = 0;
  for (const x of sr.range) sSum += x;
  const wq = qSum > 0 ? Math.min(1, Math.max(0, w)) : 0;
  const factor = new Array<number>(n).fill(0);
  let top = 0;
  for (let i = 0; i < n; i++) {
    const wi = range[i] ?? 0;
    if (!(wi > 0)) continue;
    const mix = wq * (qSum > 0 ? qre[i]! / qSum : 0) + (1 - wq) * (sSum > 0 ? sr.range[i]! / sSum : 0);
    factor[i] = mix / wi;
    if (factor[i]! > top) top = factor[i]!;
  }
  if (!(top > 0)) return { why: "the blend came out empty" };
  const out = new Array<number>(n).fill(0);
  let combos = 0;
  for (let i = 0; i < n; i++) { factor[i] = factor[i]! / top; out[i] = (range[i] ?? 0) * factor[i]!; combos += out[i]!; }
  return { range: out, combos, factor };
}

/** The range an off-tree node CARRIED, rebuilt from what the trace keeps (the node's per-combo strategies and EVs, and
 *  the rule's record): the pages that redraw a walk (routes/dashboard expandTrace, stress500 views) must show the range
 *  the solver was given after the action, not range x QRE. null = the node carried range x strategy (no rule applied). */
export function carriedOffTreeRange(range: number[], sols: Sol[], taken: number, soft: OffTreeSoft | undefined | null): number[] | null {
  if (!soft?.applied) return null;
  const r = soft.mode === "soft"
    ? softOffTreeRange(range, sols, taken, soft.pot, soft.t)
    : blendOffTreeRange(range, sols, taken, soft.pot, soft.t, soft.w ?? 0.5);
  return "why" in r ? null : r.range;
}

/** A NODE LOCK (GTO Wizard's last_node_lock, services/gtowAiPreflop NodeLock) that makes villain's range after the
 *  taken action exactly range x factor: the taken action's frequency per combo = factor / max(factor) (scale-invariant:
 *  hero's answers depend on the shape, and a full-height lock keeps clear of GTO Wizard's ~1e-7 weight floor), the rest
 *  of each hand spread over his other actions in the solver's own proportions (all to his best other action by EV when
 *  the solver gave them nothing). `street` = the street's index from preflop (flop 1); the history is one line per street
 *  from preflop: a flop tree ["", "X-R1.8"], a tree that starts on the turn ["", "", "X-R1.8"] (probed 2026-10-05,
 *  scripts/_probePostflopNodeLock.ts — `["X-R1.8"]` alone is read as a PREFLOP line). */
export function offTreeLock(sols: (Sol & { action?: { code?: unknown } })[], taken: number, factor: number[], street: number, codesBefore: string[]):
  { action_history: string[]; strategy: { action: string; strategy: number[] }[]; hands_locked: boolean[]; previous_nodes_lock_type: "street_all" } {
  let top = 0;
  for (const f of factor) if (f > top) top = f;
  if (!(top > 0)) top = 1;
  const n = factor.length;
  const strategy = sols.map((s) => ({ action: String(s.action?.code ?? ""), strategy: new Array<number>(n).fill(0) }));
  for (let i = 0; i < n; i++) {
    const ft = Math.min(1, (factor[i] ?? 0) / top);
    strategy[taken]!.strategy[i] = ft;
    const rest = 1 - ft;
    if (rest <= 0) continue;
    let tot = 0;
    sols.forEach((s, j) => { if (j !== taken) tot += s.strategy?.[i] ?? 0; });
    if (tot > 0) sols.forEach((s, j) => { if (j !== taken) strategy[j]!.strategy[i] = (rest * (s.strategy?.[i] ?? 0)) / tot; });
    else {
      let bj = -1, bev = -Infinity;
      sols.forEach((s, j) => { const e = s.evs?.[i]; if (j !== taken && e != null && e > bev) { bev = e; bj = j; } });
      if (bj < 0) bj = taken === 0 ? 1 : 0;
      if (strategy[bj]) strategy[bj]!.strategy[i] = rest;
    }
  }
  const history = new Array<string>(street + 1).fill("");
  history[street] = codesBefore.join("-");
  return { action_history: history, strategy, hands_locked: new Array<boolean>(n).fill(true), previous_nodes_lock_type: "street_all" };
}

/** "0.16%" — enough digits for the small numbers this is about */
export const pctOf = (x: number): string => `${(x * 100).toFixed(x < 0.001 ? 3 : x < 0.1 ? 2 : 1)}%`;

/** One line a person reads: "HJ BET 2.6 off-tree — the solver takes it 0.16%, no hand above 0.41%, costs him 0.14bb". */
export const offTreeText = (l: OffTreeLine): string =>
  `${l.seat} ${l.action}${l.betsize != null ? ` ${l.betsize}` : ""} is off-tree — the solver takes it ${pctOf(l.nodeFreq)}, ` +
  `no hand above ${pctOf(l.maxHand)}${l.evGapBb != null ? `, costs him ${l.evGapBb.toFixed(2)}bb on average` : ""}` +
  (l.soft ? ` · ${softText(l.soft)}` : "");

const combosText = (x: number): string => (x >= 10 ? x.toFixed(0) : x >= 0.1 ? x.toFixed(1) : x.toFixed(3));
/** "his range carried as 55 combos instead of QRE's 0.007 (blend: 50% QRE + soft, T = 20% of the 10.4bb pot)" */
export const softText = (s: OffTreeSoft): string => {
  const blend = s.w != null && s.mode !== "soft";
  const tText = `T = ${Math.round(s.t * 1000) / 10}% of the ${Math.round(s.pot * 100) / 100}bb pot`;
  const rule = blend ? `blend: ${Math.round(s.w! * 100)}% QRE + soft, ${tText}` : `soft, ${tText}`;
  return s.softCombos == null ? `${blend ? "blend" : "soft range"} not computable (${s.why ?? "?"}): QRE narrowing kept`
    : `his range ${s.applied ? "carried as" : "would be"} ${combosText(s.softCombos)} combos instead of QRE's ${combosText(s.qreCombos)} ` +
      `(${rule}${s.applied ? "" : "; OFFTREE_RANGE=log, QRE kept"})` +
      (s.lock ? (s.lock.ok ? "; the rest of the street node-locked to it" : `; node lock failed (${s.lock.why ?? "?"}), the rest of the street on the unlocked tree`) : "");
};

const RANKS = "23456789TJQKA";
/** The spot family a pool range would be keyed by: street, the action and who took it, the board's high card. */
export function offTreeFamily(l: Pick<OffTreeLine, "street" | "action" | "inPosition">, board: string): string {
  const cards = board.match(/[2-9TJQKA][cdhs]/gi) ?? [];
  const hi = cards.reduce((m, c) => Math.max(m, RANKS.indexOf(c[0]!.toUpperCase())), -1);
  return `${l.street} · ${l.action.toLowerCase()} ${l.inPosition ? "in position" : "out of position"} · ${hi >= 0 ? RANKS[hi] : "?"}-high board`;
}
