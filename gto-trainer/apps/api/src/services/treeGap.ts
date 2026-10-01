/**
 * HOW FAR IS THE TABLE FROM THE TREE THAT ANSWERED IT? (2026-10-01, hand 4921874909: an 80bb BTN read on the 70bb
 * short chart because the 80bb tree had not landed.)
 *
 * Raise SIZES have a bound (utils/snapToken: past τ the chart refuses and the exact GTO Wizard tree answers). STACKS
 * have none: a short seat reads its nearest rung, everyone else is taken as 100bb, a tree that has not landed falls
 * to a neighbour. This measures the stack distance of every 6-max chart answer so a bound can be chosen from data.
 *
 * LOG ONLY. Nothing is routed on it. The measurement rides on the answer's path (answers.path → $.treeGap) and
 * scripts/treeGapReport.ts reads it back — and rebuilds it for the answers logged before it existed.
 *
 * THE MEASURE IS THE EFFECTIVE STACK, AS A RATIO:
 *   - per opponent STILL IN THE HAND: min(hero, opponent) at the table against min(hero, opponent) in the chart.
 *     A 242bb CO against a 100bb hero is a 100bb spot in both — distance 0; a folded seat counts for nothing.
 *   - as a ratio (max/min ≥ 1), not a bb gap: 20bb off is a different tree at 25bb and noise at 150bb. This is the
 *     same scale the size snap uses (ln of the ratio).
 *   - WHO the opponent is rides along (`role`): the raiser hero faces, a caller already in the pot, or a seat still
 *     to act behind. Measured 2026-10-01 over 1,603 answers: the worst of ALL live seats is past 1.25x on 42% of
 *     them, mostly a few-bb stack waiting in the blinds — a huge ratio on very little money. So the answer carries
 *     two numbers: `stack` (worst of every live seat) and `pot` (worst of the seats already in the pot), plus the
 *     gap in bb, and the audit decides which of them predicts lost EV.
 */
import { SEATS6, type Seat6 } from "./hrc6max";

/** Provisional bound the log-only verdict is judged at (ratio of effective stacks). The raw ratio is what is logged;
 *  any other bound can be read off the same rows. To be replaced by the audit's number (scripts/stackSnapAudit.ts). */
export const STACK_GAP_TAU = 1.25;

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

export interface TreeGap {
  v: 1;
  /** the chart that answered */
  chart: string;
  /** hero's stack at the table / in the chart */
  hero: { real: number; chart: number };
  /** every opponent still in the hand, worst first */
  seats: SeatGap[];
  /** the worst of `seats` — null when no opponent's stack was readable */
  stack: SeatGap | null;
  /** the worst of the seats ALREADY IN THE POT (raiser and callers) — null when hero is first in */
  pot: SeatGap | null;
  /** the largest raise-size snap on the walked line (borrowed callers and all-ins left out) — null when none */
  size: { from: string; to: string; ratio: number } | null;
  /** set when the picker's first choice had not landed: what the worst ratio WOULD have been on it. The difference
   *  between `stack.ratio` and this is the part a solved tree closes; the rest is the grid's own coarseness. */
  wanted?: { chart: string; ratio: number | null };
  /** LOG ONLY: would a stack bound of `tau` have sent this decision to the exact tree — judged on `pot` when anyone
   *  is in the pot, else on `stack` (hero first in: every opponent is behind him) */
  gate: { tau: number; wouldRoute: boolean };
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

/**
 * The gap between the table and the chart that answered. null when it cannot be measured: an id shape this does not
 * know, or hero's own stack unreadable.
 *   byPos    the stacks AS DEALT by position (hrc6max.dealtByPos)
 *   folded   the seats out of the hand at hero's decision (hrc6max.replayTokens6 on the RAW tokens — a caller the
 *            line fit folded out of the tree is still at the table)
 *   aggressor / after  the last raiser and the seats still to act behind hero (replayTokens6) — each seat's role;
 *            with neither given every seat reads "behind"
 *   repaired the walk's size snaps
 *   wantedId the picker's first choice, when another tree answered
 */
export function treeGap6(a: {
  chartId: string; byPos: Partial<Record<Seat6, number>>; hero: string | null; folded: ReadonlySet<string>;
  aggressor?: string | null; after?: readonly string[];
  repaired?: { from: string; to: string; logDist: number; borrowed?: string }[]; wantedId?: string | null; tau?: number;
}): TreeGap | null {
  const hero = String(a.hero ?? "").toUpperCase() as Seat6;
  const stacks = chartStacks6(a.chartId);
  const heroReal = Number(a.byPos[hero] ?? NaN);
  if (!stacks || !SEATS6.includes(hero) || !(heroReal > 0)) return null;
  const seats = seatGaps(stacks, a.byPos, hero, a.folded, a.aggressor, a.after);
  const stack = seats[0] ?? null, pot = seats.find((s) => s.role !== "behind") ?? null;
  const snap = (a.repaired ?? []).filter((r) => !r.borrowed && r.logDist > 0).sort((x, y) => y.logDist - x.logDist)[0];
  const tau = a.tau ?? STACK_GAP_TAU;
  const out: TreeGap = {
    v: 1, chart: a.chartId, hero: { real: Math.round(heroReal * 100) / 100, chart: stacks[hero] }, seats, stack, pot,
    size: snap ? { from: snap.from, to: snap.to, ratio: Math.round(Math.exp(snap.logDist) * 1000) / 1000 } : null,
    gate: { tau, wouldRoute: ((pot ?? stack)?.ratio ?? 1) > tau },
  };
  if (a.wantedId && a.wantedId !== a.chartId) {
    const w = chartStacks6(a.wantedId);
    const ws = w ? seatGaps(w, a.byPos, hero, a.folded, a.aggressor, a.after) : [];
    out.wanted = { chart: a.wantedId, ratio: w ? (ws.find((s) => s.role !== "behind") ?? ws[0])?.ratio ?? null : null };
  }
  return out;
}
