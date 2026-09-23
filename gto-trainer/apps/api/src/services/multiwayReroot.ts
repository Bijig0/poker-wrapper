/**
 * RE-ROOT A 4+ WAY SPOT AT THE CURRENT STREET (2026-09-22, Brady: "let's try solve for it").
 *
 * services/multiwayCollapse.ts collapses a 4-6 seat pot to the three seats GTO Wizard solves, by GHOSTING a villain
 * who has committed nothing on the walked streets or MERGING two adjacent villains. Walked from the flop, a villain
 * who bet or called on the flop can never be ghosted — his chips are in a street the tree has to play — so a 4-way
 * TURN where every villain put chips in on the flop and hero sits between them had no legal collapse and was refused.
 *
 * Nothing forces the walk to start at the flop. The chain solves each street as its own tree anyway (aiChain), so:
 *   1. MONEY: replay the earlier streets with every seat — pot and stack entering the current street are exact.
 *   2. RANGES entering the current street, narrowed through the earlier streets. No tree holds four seats there
 *      either, so each range comes from a THREE-seat walk of the earlier streets (aiChain walkThrough) that keeps
 *      hero, every seat that BET or RAISED there (dropping one would leave calls with nothing to call), and the
 *      villain whose range it is. The callers left out of a walk are the approximation: that walk plays as if they
 *      had folded. The fewest walks that cover every villain are used.
 *   3. COLLAPSE the current street alone (planCollapses on its tokens): a villain who has only checked, or not acted
 *      yet, THIS street can be ghosted again, his earlier chips now plain pot.
 * Refused only when the current street itself leaves nothing collapsible, or the earlier streets had more
 * aggressors than a three-seat walk can hold.
 */
import { solveAiChain, type AiChainSpec } from "./aiChain";
import { planCollapses, pickCollapses, type Picked, type SeatTok } from "./multiwayCollapse";

type SeatSpec = Pick<AiChainSpec, "oopPos" | "ipPos" | "oopRange" | "ipRange" | "midPos" | "midRange" | "heroSeat">;

export interface RerootArgs {
  /** seats reaching the flop, in postflop order */
  ordered: string[];
  heroPos: string;
  /** a seat's 1326 range entering the flop */
  arr: (pos: string) => number[];
  /** tokens per street up to and including the current one; seats parallel */
  streets: string[][];
  streetSeats: string[][];
  flopPot: number;
  flopStack: number;
  board: string;
  heroComboIdx: number | null;
  rake: AiChainSpec["rake"] | null;
  specOf: (three: { pos: string; range: number[] }[], heroIdx: number) => SeatSpec;
}

export type RerootResult =
  | { ok: true; picked: Picked; first: 1 | 2; pot: number; stack: number; walks: number; left: string }
  | { ok: false; why: string };

/** Pot and stack entering street `first`, and who folded before it — every seat counted, nothing collapsed. */
export function moneyThrough(streets: string[][], seats: string[][], flopPot: number, flopStack: number, first: number) {
  let pot = flopPot;
  let stack = flopStack;
  const folded = new Set<string>();
  const aggressors = new Set<string>();
  for (let i = 0; i < first; i++) {
    let level = 0;
    const put: Record<string, number> = {};
    streets[i]!.forEach((tok, j) => {
      const seat = seats[i]![j]!;
      if (tok === "F") folded.add(seat);
      else if (tok === "C") put[seat] = Math.min(level, stack);
      else if (tok === "RAI") { put[seat] = stack; level = stack; aggressors.add(seat); }
      else if (/^R[\d.]+$/.test(tok)) { const to = Math.min(parseFloat(tok.slice(1)), stack); put[seat] = to; level = to; aggressors.add(seat); }
    });
    pot += Object.values(put).reduce((a, b) => a + b, 0);
    stack -= level;
  }
  return { pot: Math.round(pot * 100) / 100, stack: Math.round(stack * 100) / 100, folded, aggressors };
}

/** The fewest 3-seat groups — each: hero + every earlier aggressor + villains — that together contain every villain. */
export function coverGroups(live: string[], hero: string, aggressors: Set<string>): string[][] | null {
  const must = [hero, ...live.filter((p) => p !== hero && aggressors.has(p))];
  if (must.length > 3) return null;
  const rest = live.filter((p) => !must.includes(p));
  const room = 3 - must.length;
  if (!rest.length) return [must];
  if (room === 0) return null;   // callers to cover and no seat left for them
  const groups: string[][] = [];
  for (let i = 0; i < rest.length; i += room) groups.push([...must, ...rest.slice(i, i + room)]);
  // pad a short last group with already-covered callers so every walk is a three-seat tree
  const last = groups[groups.length - 1]!;
  for (const p of rest) { if (last.length >= 3) break; if (!last.includes(p)) last.push(p); }
  return groups;
}

export async function rerootCollapse(a: RerootArgs): Promise<RerootResult> {
  const first = a.streets.length - 1;
  if (first < 1 || first > 2) return { ok: false, why: "nothing to re-root on the flop" };
  const m = moneyThrough(a.streets, a.streetSeats, a.flopPot, a.flopStack, first);
  if (m.stack <= 0.5) return { ok: false, why: "the earlier streets put everyone (near) all-in" };
  const order = (xs: string[]) => a.ordered.filter((p) => xs.includes(p));
  const live = a.ordered.filter((p) => !m.folded.has(p));
  if (!live.includes(a.heroPos)) return { ok: false, why: "hero folded earlier" };

  // ---- 2. narrow each live seat's range through the earlier streets
  const groups = coverGroups(live, a.heroPos, m.aggressors);
  if (!groups) return { ok: false, why: `${[...m.aggressors].join(", ")} all bet or raised earlier — more aggressors than a three-seat walk holds` };
  const ranges: Record<string, number[]> = {};
  const leftOut = new Set<string>();
  for (const g of groups) {
    const keep = order(g);
    const kept = new Set(keep);
    // the earlier streets as this walk plays them: the seats outside it never act (their chips are the approximation)
    const streets: string[][] = [];
    const seats: string[][] = [];
    for (let i = 0; i < first; i++) {
      const t: string[] = [], s: string[] = [];
      a.streets[i]!.forEach((tok, j) => { const who = a.streetSeats[i]![j]!; if (kept.has(who)) { t.push(tok); s.push(who); } else if (!m.folded.has(who)) leftOut.add(who); });
      streets.push(t); seats.push(s);
    }
    const three = keep.map((p) => ({ pos: p, range: a.arr(p) }));
    const heroIdx = keep.indexOf(a.heroPos);
    const spec: AiChainSpec = {
      ...(a.rake ? { rake: a.rake } : {}),
      ...(three.length === 3 ? a.specOf(three, heroIdx) : {
        oopPos: three[0]!.pos, ipPos: three[1]!.pos, oopRange: three[0]!.range, ipRange: three[1]!.range,
        heroSeat: heroIdx === 0 ? "oop" as const : "ip" as const,
      }),
      flopPot: a.flopPot, flopStack: a.flopStack, board: a.board, streets, streetSeats: seats,
      heroComboIdx: a.heroComboIdx, walkThrough: true,
    };
    const r = await solveAiChain(spec);
    if (!r.ok) return { ok: false, why: `narrowing walk ${keep.join("/")}: ${r.why}` };
    for (const [pos, rng] of Object.entries(r.rangesOut ?? {})) if (!ranges[pos]) ranges[pos] = rng;
  }
  for (const p of live) if (!ranges[p]) return { ok: false, why: `no narrowing walk produced ${p}'s range` };

  // ---- 3. collapse the current street on its own
  const cur: SeatTok[][] = [a.streets[first]!.map((tok, j) => ({ tok, seat: a.streetSeats[first]![j]! }))];
  const cSeats = live.map((p) => ({ pos: p, range: ranges[p]! }));
  if (cSeats.length <= 3) {
    return { ok: false, why: "fewer than four seats left — the plain chain answers this, not a re-root" };
  }
  const picked = pickCollapses(planCollapses(cSeats, a.heroPos, cur));
  if (!picked) return { ok: false, why: `on the ${["flop", "turn", "river"][first]} itself every villain has put chips in too — nothing collapses` };
  const covered = [...leftOut].filter((p) => live.includes(p));
  return { ok: true, picked, first: first as 1 | 2, pot: m.pot, stack: m.stack, walks: groups.length,
    left: covered.length ? covered.join(", ") : "none" };
}
