/**
 * HOW FAR IS THE TABLE FROM THE TREE THAT ANSWERED IT — AND WHEN IS THAT TOO FAR? (2026-10-01, hand 4921874909: an 80bb
 * BTN read on the 70bb short chart because the 80bb tree had not landed.)
 *
 * Every 6-max chart answer is measured against the table on two axes — the STACKS the chart was solved at and the
 * raise SIZES its line was snapped onto — and THE GAP GATE (2026-10-02) sends a decision past its bounds to the exact
 * GTO Wizard AI tree instead. The measurement and the gate's verdict ride on the answer's path (answers.path →
 * $.treeGap) whichever piece answers, so the rule can be audited from the log (scripts/gapGateReport.ts).
 *
 * THE BOUNDS ARE MEASURED, not guessed (scripts/stackGapStudy.ts, 2026-10-01/02: 577 exact trees, EV lost at hero's
 * node over his range, the AI tree taken as the truth — poker-data/audits/preflop-gap-report-2026-10-02.txt):
 *   - SIZES cost more at every level of the pot: an open read 1.25x off loses ≤ 0.005 bb (the BB closing the action;
 *     other seats less), a 3-bet 1.15x off ≤ 0.004, a 4-bet 1.10x off ≈ the solver's own noise — and past those the
 *     loss climbs fast (a 3-bet 1.5x off 0.03-0.045, a 4-bet 1.5x off 0.12-0.22). Until now ONE bound, 1.49x
 *     (utils/snapToken SNAP_TAU, calibrated on river translation), held for every level.
 *   - STACKS do not matter on hero's first decision (≤ 0.01 bb up to 2x off, any seat, two seats, hero's own) and DO
 *     once he faces a re-raise or an all-in, where the aggressor's stack is the price of the call: 1.3x off ≈ 0.01,
 *     1.5x 0.03-0.05, 2x 0.07-0.12, past 3x 0.15-0.31.
 *
 * THE MEASURE OF A STACK IS THE EFFECTIVE STACK, AS A RATIO:
 *   - per opponent STILL IN THE HAND: min(hero, opponent) at the table against min(hero, opponent) in the chart.
 *     A 242bb CO against a 100bb hero is a 100bb spot in both — distance 0; a folded seat counts for nothing.
 *   - as a ratio (max/min ≥ 1), not a bb gap: 20bb off is a different tree at 25bb and noise at 150bb. This is the
 *     same scale the size snap uses (ln of the ratio).
 *   - WHO the opponent is rides along (`role`): the raiser hero faces, a caller already in the pot, or a seat still
 *     to act behind.
 */
import { SEATS6, type Seat6 } from "./hrc6max";

/** The stack ratio scripts/treeGapReport.ts tabulates at by default (the first, provisional log-only bound). */
export const STACK_GAP_TAU = 1.25;

/** THE SIZE BOUND BY LEVEL (ratio between the raise as played and the chart size it was read at): the open (or the
 *  iso over limps), the 3-bet, the 4-bet and later. */
export const SIZE_TAU = [1.25, 1.15, 1.1] as const;
/** THE STACK BOUND when hero faces a re-raise or an all-in: the last aggressor's effective stack, table vs chart. */
export const RERAISE_STACK_TAU = 1.3;

/** live = a decision past a bound goes to the exact tree; log = the chart answers and the verdict is only recorded;
 *  off = no verdict. PREFLOP_GAP_GATE in the environment, read at every decision; live when unset. */
export type GapGateMode = "live" | "log" | "off";
export const gapGateMode = (): GapGateMode => {
  const v = String(process.env.PREFLOP_GAP_GATE ?? "live").toLowerCase();
  return v === "log" || v === "off" ? v : "live";
};

export interface SeatGap {
  seat: Seat6;
  /** effective stack against hero at the table / in the chart (bb) */
  real: number;
  chart: number;
  /** max/min of the two, ≥ 1 */
  ratio: number;
  /** |real − chart| in bb: the money the ratio is about */
  bb: number;
  /** raiser = the last aggressor hero faces; in = already called or limped; behind = still to act this orbit */
  role: "raiser" | "in" | "behind";
}

/** One bound a decision is past. */
export interface GapReason {
  rule: "size" | "stack";
  /** which raise of the line: 1 = the open, 2 = the 3-bet, 3 = the 4-bet or later (stack: the raises hero faces) */
  level: number;
  ratio: number;
  tau: number;
  /** the size as played → as read ("R5→R3.5"), or the seat whose stack it is ("BTN 22bb, 50bb in the chart") */
  what: string;
}

export interface TreeGap {
  v: 2;
  /** the chart that answered — or, on a decision the gate sent to the exact tree, the chart that would have */
  chart: string;
  /** hero's stack at the table / in the chart */
  hero: { real: number; chart: number };
  /** every opponent still in the hand, worst first */
  seats: SeatGap[];
  /** the worst of `seats` — null when no opponent's stack was readable */
  stack: SeatGap | null;
  /** the worst of the seats ALREADY IN THE POT (raiser and callers) — null when hero is first in */
  pot: SeatGap | null;
  /** raises in the line hero faces, and whether the last of them is an all-in */
  raises: number;
  allIn: boolean;
  /** the largest raise-size snap on the walked line (borrowed callers and all-ins left out) — null when none */
  size: { from: string; to: string; ratio: number; level: number } | null;
  /** set when the picker's first choice had not landed: what the worst ratio WOULD have been on it. The difference
   *  between `stack.ratio` and this is the part a solved tree closes; the rest is the grid's own coarseness. */
  wanted?: { chart: string; ratio: number | null };
  /** THE GAP GATE's verdict: `route` = past a bound (see `reasons`); under mode "live" the exact tree was asked */
  gate: { mode: GapGateMode; route: boolean; reasons: GapReason[] };
  /** on a decision the gate sent to the exact tree: what the chart would have told hero's hand (the side-by-side the
   *  audit reads), and how the exact tree's answer went — "answered"; "failed" / "timeout" = the chart answered after all */
  routed?: { chartMix: { action: string; frequency: number }[]; ai: "answered" | "failed" | "timeout"; aiWhy?: string; aiMs?: number };
}

const val = (t: string) => Number(t.replace("_", "."));
const all = (bb: number) => Object.fromEntries(SEATS6.map((s) => [s, bb])) as Record<Seat6, number>;

/** The per-seat stacks a 6-max chart was solved at, read off its id. null for an id shape this does not know. */
export function chartStacks6(id: string): Record<Seat6, number> | null {
  const m6 = /^[a-z]+\d+_6max_(.+)$/.exec(id);
  if (!m6) return null;
  const rest = m6[1]!;
  let m: RegExpExecArray | null;
  // patch: P_<SEATnn…|EVEN>_o<open>[size tags] — the named seats, everyone else 100
  if ((m = /^P_(.+?)_o(?:limp|\d)/.exec(rest))) {
    const out = all(100);
    if (m[1] === "EVEN") return out;
    for (const part of m[1]!.split("_")) {
      const s = /^(UTG|HJ|CO|BTN|SB|BB)(\d+)$/.exec(part);
      if (!s) return null;
      out[s[1] as Seat6] = Number(s[2]);
    }
    return out;
  }
  // one short seat: D<deep>_s<short>_<SEAT>_o<open>
  if ((m = /^D(\d+)_s(\d+(?:_5)?)_(UTG|HJ|CO|BTN|SB|BB)_o/.exec(rest))) {
    const out = all(Number(m[1]));
    out[m[3] as Seat6] = val(m[2]!);
    return out;
  }
  // even (raise and limp trees alike): D<depth>_o…
  if ((m = /^D(\d+)_o/.exec(rest))) return all(Number(m[1]));
  return null;
}

const ratioOf = (a: number, b: number) => Math.round((Math.max(a, b) / Math.min(a, b)) * 1000) / 1000;
const isRaise = (t: unknown) => /^R/i.test(String(t ?? ""));

function seatGaps(stacks: Record<Seat6, number>, byPos: Partial<Record<Seat6, number>>, hero: Seat6, folded: ReadonlySet<string>,
                  aggressor?: string | null, after?: readonly string[]): SeatGap[] {
  const heroReal = Number(byPos[hero]);
  const out: SeatGap[] = [];
  for (const seat of SEATS6) {
    const opp = Number(byPos[seat] ?? NaN);
    if (seat === hero || folded.has(seat) || !(opp > 0)) continue;
    const real = Math.min(heroReal, opp), chart = Math.min(stacks[hero], stacks[seat]);
    if (!(real > 0) || !(chart > 0)) continue;
    out.push({ seat, real: Math.round(real * 100) / 100, chart, ratio: ratioOf(real, chart), bb: Math.round(Math.abs(real - chart) * 10) / 10,
      role: seat === aggressor ? "raiser" : !after || after.includes(seat) ? "behind" : "in" });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

/** The bounds a measured decision is past (empty = inside all of them). Pure: the gate's whole rule. */
export function gapReasons(g: Pick<TreeGap, "seats" | "raises" | "allIn">, snaps: { from: string; to: string; ratio: number; level: number }[]): GapReason[] {
  const out: GapReason[] = [];
  for (const s of snaps) {
    const tau = SIZE_TAU[Math.min(Math.max(s.level, 1), SIZE_TAU.length) - 1]!;
    if (s.ratio > tau) out.push({ rule: "size", level: s.level, ratio: s.ratio, tau, what: `${s.from}→${s.to}` });
  }
  // a re-raise or an all-in in front of hero: the aggressor's stack is the price of the call
  const agg = g.seats.find((s) => s.role === "raiser");
  if (agg && (g.raises >= 2 || g.allIn) && agg.ratio > RERAISE_STACK_TAU) {
    out.push({ rule: "stack", level: g.raises, ratio: agg.ratio, tau: RERAISE_STACK_TAU, what: `${agg.seat} ${agg.real}bb, ${agg.chart}bb in the chart` });
  }
  return out;
}

/** The gate's verdict as one sentence, for the answer's note. */
export function gapText(reasons: GapReason[]): string {
  const lv = (n: number) => (n <= 1 ? "open" : n === 2 ? "3-bet" : "4-bet");
  return reasons.map((r) => (r.rule === "size"
    ? `the ${lv(r.level)} ${r.what} is ${r.ratio}x from the chart's size (bound ${r.tau}x)`
    : `facing ${r.level >= 2 ? "a re-raise" : "an all-in"} from the ${r.what} — ${r.ratio}x apart (bound ${r.tau}x)`)).join("; ");
}

/**
 * The gap between the table and the chart, and the gate's verdict on it. null when it cannot be measured: an id
 * shape this does not know, or hero's own stack unreadable.
 *   byPos    the stacks AS DEALT by position (hrc6max.dealtByPos)
 *   folded   the seats out of the hand at hero's decision (hrc6max.replayTokens6 on the RAW tokens — a caller the
 *            line fit folded out of the tree is still at the table)
 *   aggressor / after  the last raiser and the seats still to act behind hero (replayTokens6) — each seat's role;
 *            with neither given every seat reads "behind"
 *   repaired the walk's size snaps, `fitted` the tokens they index (each snap's level = its place among the raises)
 *   rawTokens the line as the table played it (how many raises hero faces; whether the last is an all-in)
 *   wantedId the picker's first choice, when another tree answered
 */
export function treeGap6(a: {
  chartId: string; byPos: Partial<Record<Seat6, number>>; hero: string | null; folded: ReadonlySet<string>;
  aggressor?: string | null; after?: readonly string[];
  repaired?: { index?: number; from: string; to: string; logDist: number; borrowed?: string }[]; fitted?: readonly string[];
  rawTokens?: readonly string[]; wantedId?: string | null; mode?: GapGateMode;
}): TreeGap | null {
  const hero = String(a.hero ?? "").toUpperCase() as Seat6;
  const stacks = chartStacks6(a.chartId);
  const heroReal = Number(a.byPos[hero] ?? NaN);
  if (!stacks || !SEATS6.includes(hero) || !(heroReal > 0)) return null;
  const seats = seatGaps(stacks, a.byPos, hero, a.folded, a.aggressor, a.after);
  const stack = seats[0] ?? null, pot = seats.find((s) => s.role !== "behind") ?? null;
  const snaps = (a.repaired ?? []).filter((r) => !r.borrowed && r.logDist > 0).map((r) => ({
    from: r.from, to: r.to, ratio: Math.round(Math.exp(r.logDist) * 1000) / 1000,
    level: r.index != null && a.fitted ? Math.max(1, a.fitted.slice(0, r.index + 1).filter(isRaise).length) : 1,
  })).sort((x, y) => y.ratio - x.ratio);
  const raised = (a.rawTokens ?? []).filter(isRaise);
  const raises = raised.length, allIn = raises > 0 && String(raised[raises - 1]).toUpperCase() === "RAI";
  const mode = a.mode ?? gapGateMode();
  const reasons = mode === "off" ? [] : gapReasons({ seats, raises, allIn }, snaps);
  const out: TreeGap = {
    v: 2, chart: a.chartId, hero: { real: Math.round(heroReal * 100) / 100, chart: stacks[hero] }, seats, stack, pot, raises, allIn,
    size: snaps[0] ?? null, gate: { mode, route: reasons.length > 0, reasons },
  };
  if (a.wantedId && a.wantedId !== a.chartId) {
    const w = chartStacks6(a.wantedId);
    const ws = w ? seatGaps(w, a.byPos, hero, a.folded, a.aggressor, a.after) : [];
    out.wanted = { chart: a.wantedId, ratio: w ? (ws.find((s) => s.role !== "behind") ?? ws[0])?.ratio ?? null : null };
  }
  return out;
}
