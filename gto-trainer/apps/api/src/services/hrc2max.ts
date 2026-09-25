import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { dealtBySeat } from "../utils/archivedHand/archivedHand";
import { fetchNode, type GetNode, type HrcNode } from "./hrc3max";

/**
 * Chart picker for the CoinPoker HEADS-UP NL200 set (ledger config `grid-cp200hu`, 137 HRC trees solved
 * 2026-09-17..19 on the box fleet): `hrc_hu_cp200a_d<depth>_o<open>_3b<3-bet>`, SB/BB, blinds 0.5/1, ANTE
 * 0.2bb per player, rake 5% cap 0.9bb no-flop-no-drop, SB limp in every tree.
 *
 * The file name is what strategies.ts looks for: a layer with `seats: 2` is only routable once
 * services/hrc2max.ts exists (the same rule that held the 6-max strategy until hrc6max.ts landed).
 *
 * Why a picker of its own: a heads-up tree is solved with ONE open size and ONE 3-bet size (every other size
 * the table plays is a snap), so a chart is chosen by (depth, open, 3-bet) — the 3-max corpus has no 3-bet
 * axis and the 6-max set no heads-up trees. The line itself needs nothing new: buildPreflopTokensHu builds
 * [SB, BB] tokens (the table's BTN is the tree's SB) and walk3max snaps sizes in log space.
 *
 * Selection is a PREFERENCE LIST (the resolver takes the first chart the server has), and every snap the
 * choice had to make is said in `note`, which rides to the panel.
 */

export const SITE_HU = "cp200a";
/** the structure the set was solved at — the postflop AI solve uses the same numbers */
export const HU_ANTE_BB = 0.2;
export const HU_RAKE = { pct_of_pot: 5, cap_bb: 0.9 } as const;

/** Depth rungs of the set, in bb. */
export const RUNGS_HU = [20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 150];
/** Open sizes solved at a depth (3x only from 50bb). */
export const opensAt = (depth: number): number[] => (depth >= 50 ? [2, 2.5, 3] : [2, 2.5]);
/** 3-bet sizes solved for (depth, open), as the plan generated them (genHuSngPlan CASH mode). */
export function threeBetsAt(depth: number, open: number): number[] {
  if (depth <= 20) return open === 2 ? [5.5, 6.5, 7.5] : [7, 8];
  if (depth <= 30) return open === 2 ? [6.5, 7.5, 8.5] : [8, 9, 10];
  if (open === 2) return [7, 8.5, 10];
  if (open === 2.5) return [9, 10.5, 12.5];
  return [10.5, 13];
}
/** Beyond this the 150bb chart is a guess, not a snap. */
export const LADDER_TOP_HU = 165;
/** the size hero opens with when nothing has been raised yet (the SB decides; the tree he reads is this one) */
export const DEFAULT_OPEN_HU = 2.5;

const num = (n: number) => String(n).replace(".", "_");
const nearest = (xs: number[], v: number) => xs.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
/** sizes compare in log space: 9 vs 10.5 is the same kind of miss as 7 vs 8.2 */
const nearestLog = (xs: number[], v: number) =>
  xs.reduce((a, b) => (Math.abs(Math.log(b / v)) < Math.abs(Math.log(a / v)) ? b : a));

export const chartIdHu = (depth: number, open: number, threeBet: number): string =>
  `hrc_hu_${SITE_HU}_d${depth}_o${num(open)}_3b${num(threeBet)}`;

/** The chart a rung answers an unraised pot from: hero's own open size and the middle 3-bet (chartForHu's pick
 *  before anyone has raised). */
export function defaultChartHu(depth: number): string {
  const threes = threeBetsAt(depth, DEFAULT_OPEN_HU);
  return chartIdHu(depth, DEFAULT_OPEN_HU, threes[Math.floor((threes.length - 1) / 2)]!);
}

/** The rungs either side of `depth` on the ladder (none for a depth that is not a rung). */
export function neighbourRungsHu(depth: number): number[] {
  const i = RUNGS_HU.indexOf(depth);
  return i < 0 ? [] : [RUNGS_HU[i - 1], RUNGS_HU[i + 1]].filter((d): d is number => d != null);
}

export interface ChartHuChoice {
  /** charts to try, best first */
  candidates: string[];
  id: string;
  site: string;
  depth: number;
  open: number;
  threeBet: number;
  /** the stack the rung was chosen for (min of the two stacks as dealt) */
  effective: number | null;
  note: string | null;
  beyondLadder: number | null;
}

/** The open and 3-bet this line is playing under: the first and second raise of the [SB, BB] token line. A
 *  limped pot has no open; its iso-raise is not a 3-bet (every tree carries the limp branch with one iso size). */
export function sizesFromTokens(tokens: string[]): { open: number | null; threeBet: number | null; limped: boolean } {
  const raises: number[] = [];
  let limped = false;
  tokens.forEach((t, i) => {
    const tok = String(t ?? "").trim().toUpperCase();
    if (i === 0 && (tok === "C" || tok === "CALL")) limped = true;
    const m = tok.match(/^R([\d.]+)$/);
    if (m && Number.isFinite(Number(m[1])) && Number(m[1]) > 0) raises.push(Number(m[1]));
  });
  if (limped) return { open: null, threeBet: null, limped };
  return { open: raises[0] ?? null, threeBet: raises[1] ?? null, limped };
}

/**
 * Pick the heads-up chart. The rung is the EFFECTIVE stack (the shorter of the two, as dealt) snapped to the
 * set's depths; the open is the SB's raise snapped to the sizes solved at that depth (2.5x when he has not
 * opened yet — hero opening reads the tree whose size he will use); the 3-bet is the BB's re-raise snapped the
 * same way (the middle size when nobody has 3-bet yet). Fallbacks: the other 3-bet trees, the other opens,
 * then the nearest depths — a limped line lives in every tree, so any chart that exists answers it.
 */
export function chartForHu(hand: ParsedHand, tokens: string[] = [], dealt?: Record<number, number>): ChartHuChoice {
  const notes: string[] = [];
  // `dealt` = the stacks as dealt, read ONCE per hand by the postflop pin (fastSolve.pinPostflop), so the rung —
  // and with it the ranges, and with them GTO Wizard's tree key — cannot drift between streets. Without it each
  // probe reconstructs the stacks afresh from the wrapper's moving readings.
  const stacks = Object.entries(dealt ?? dealtBySeat(hand))
    .filter(([k, v]) => hand.positions?.[Number(k)] != null && Number.isFinite(v) && v > 0).map(([, v]) => v);
  let effective: number | null = stacks.length >= 2 ? Math.min(...stacks) : stacks.length === 1 ? stacks[0]! : null;
  if (effective == null) notes.push("stacks unreadable — taken as 100bb");
  const eff = effective ?? 100;
  const depth = nearest(RUNGS_HU, eff);
  const beyondLadder = eff > LADDER_TOP_HU ? Math.round(eff) : null;
  if (beyondLadder != null) notes.push(`${beyondLadder}bb effective, past the ${RUNGS_HU[RUNGS_HU.length - 1]}bb rung — answered from the ${depth}bb chart`);
  else if (Math.abs(eff - depth) > 5) notes.push(`${Math.round(eff)}bb effective — answered from the ${depth}bb chart`);

  const { open: seenOpen, threeBet: seenThree } = sizesFromTokens(tokens);
  const opens = opensAt(depth);
  const open = seenOpen != null ? nearestLog(opens, seenOpen) : DEFAULT_OPEN_HU;
  if (seenOpen != null && Math.abs(Math.log(open / seenOpen)) > 0.08) notes.push(`the open was ${seenOpen}bb — answered from the ${open}x tree`);
  const threes = threeBetsAt(depth, open);
  const threeBet = seenThree != null ? nearestLog(threes, seenThree) : threes[Math.floor((threes.length - 1) / 2)]!;
  if (seenThree != null && Math.abs(Math.log(threeBet / seenThree)) > 0.08) notes.push(`the 3-bet was to ${seenThree}bb — answered from the ${threeBet}bb 3-bet tree`);

  const cands: string[] = [chartIdHu(depth, open, threeBet)];
  // same depth: the other 3-bet trees of this open, then the other opens
  for (const t of threes.slice().sort((a, b) => Math.abs(Math.log(a / threeBet)) - Math.abs(Math.log(b / threeBet)))) cands.push(chartIdHu(depth, open, t));
  for (const o of opens.slice().sort((a, b) => Math.abs(a - open) - Math.abs(b - open))) {
    const ts = threeBetsAt(depth, o);
    cands.push(chartIdHu(depth, o, nearestLog(ts, threeBet)));
  }
  // nearest depths, same shape
  for (const d of RUNGS_HU.slice().sort((a, b) => Math.abs(a - depth) - Math.abs(b - depth))) {
    if (d === depth) continue;
    const o = nearestLog(opensAt(d), open);
    cands.push(chartIdHu(d, o, nearestLog(threeBetsAt(d, o), threeBet)));
  }
  const candidates = cands.filter((x, i, a) => a.indexOf(x) === i);
  return { candidates, id: candidates[0]!, site: SITE_HU, depth, open, threeBet,
    effective: effective == null ? null : Math.round(effective * 10) / 10, note: notes.join(" · ") || null, beyondLadder };
}

/** The first candidate the chart server actually has. */
export async function resolveChartHu(
  choice: ChartHuChoice,
  get: (source: string, line: string) => Promise<HrcNode | null | "unreachable"> = fetchNode,
): Promise<{ id: string; root: HrcNode; fellBack: boolean } | "unreachable" | null> {
  let sawServer = false;
  for (const id of choice.candidates.slice(0, 12)) {
    const root = await get(id, "");
    if (root === "unreachable") continue;
    sawServer = true;
    if (root) return { id, root, fellBack: id !== choice.candidates[0] };
  }
  return sawServer ? null : "unreachable";
}

/** A GetNode bound to one resolved chart, for walk3max / reconstructFlopRanges. */
export const nodeGetterHu = (id: string): GetNode => (line) => fetchNode(id, line);

/** Is this hand heads-up (exactly two seats dealt)? */
export const isHeadsUp = (hand: ParsedHand): boolean => {
  const seats = new Set(Object.keys(hand.positions ?? {}).map(Number));
  if (hand.heroSeatId != null && hand.heroSeatId >= 0) seats.add(hand.heroSeatId);
  return seats.size === 2;
};
