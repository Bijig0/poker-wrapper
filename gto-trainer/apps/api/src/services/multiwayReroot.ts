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
  /** seats with nothing behind (all-in). Those that went all-in on an EARLIER street never act again. */
  allIn?: Set<string>;
}

export type RerootResult =
  | { ok: true; picked: Picked; first: 1 | 2; pot: number; stack: number; walks: number; left: string; allIn: string[] }
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

/**
 * A street replayed WITHOUT some seats (2026-09-24, sweep side-pot spots). Dropping a seat's tokens can leave the
 * rest meaningless: "HJ bets 4, CO jams, BTN calls, BB calls, HJ calls" without CO has HJ calling nothing, and the
 * walk refused it ("street closed but more actions follow"); "SB jams, BB jams, UTG/HJ/BTN call" without the blinds
 * starts with a call of no bet. Replayed: a call with nothing to call is a CHECK when nobody has bet yet, and is
 * dropped when the caller already matched; a raise no bigger than the current level becomes a call (or nothing).
 */
export function replayWithout(toks: string[], seats: string[]): { toks: string[]; seats: string[] } {
  const out: string[] = [], outSeats: string[] = [];
  const put: Record<string, number> = {};
  let level = 0;
  toks.forEach((tok, j) => {
    const who = seats[j]!;
    const mine = put[who] ?? 0;
    const to = tok === "RAI" ? Infinity : /^R[\d.]+$/.test(tok) ? parseFloat(tok.slice(1)) : null;
    if (tok === "C") {
      if (level === 0) { out.push("X"); outSeats.push(who); return; }
      if (mine >= level) return;
      put[who] = level; out.push("C"); outSeats.push(who); return;
    }
    if (to != null) {
      if (to <= level) { if (mine < level) { put[who] = level; out.push("C"); outSeats.push(who); } return; }
      put[who] = to; level = to; out.push(tok); outSeats.push(who); return;
    }
    out.push(tok); outSeats.push(who);
  });
  return { toks: out, seats: outSeats };
}

export async function rerootCollapse(a: RerootArgs): Promise<RerootResult> {
  const first = a.streets.length - 1;
  if (first < 1 || first > 2) return { ok: false, why: "nothing to re-root on the flop" };
  const m = moneyThrough(a.streets, a.streetSeats, a.flopPot, a.flopStack, first);
  if (m.stack <= 0.5) return { ok: false, why: "the earlier streets put everyone (near) all-in" };
  const order = (xs: string[]) => a.ordered.filter((p) => xs.includes(p));
  // A SEAT ALL-IN FROM AN EARLIER STREET NEVER ACTS AGAIN (2026-09-24, sweep side-pot spots). It needs no seat in a
  // tree: its chips are already in the pot (moneyThrough counts them) and nobody can bet into it. Leaving it out is
  // what lets "CO jammed the flop, three called, turn bet to hero" be ONE exact three-seat tree instead of a
  // heads-up last resort. The cost, said in the answer: hero's equity against its range at showdown is not modelled.
  const curSeats = new Set(a.streetSeats[first] ?? []);
  const allIn = new Set([...(a.allIn ?? [])].filter((p) => p !== a.heroPos && !curSeats.has(p) && !m.folded.has(p)));
  const live = a.ordered.filter((p) => !m.folded.has(p) && !allIn.has(p));
  if (!live.includes(a.heroPos)) return { ok: false, why: "hero folded earlier" };

  // ---- 2. narrow each live seat's range through the earlier streets
  const groups = coverGroups(live, a.heroPos, new Set([...m.aggressors].filter((p) => !allIn.has(p))));
  if (!groups) return { ok: false, why: `${[...m.aggressors].join(", ")} all bet or raised earlier — more aggressors than a three-seat walk holds` };
  // THE DOOM CHECK COMES FIRST (2026-09-24 latency pass). Whether the current street can be collapsed to three
  // seats depends only on its tokens, not on the narrowed ranges — so ask before spending 12-24 s of cloud walks
  // on ranges the last resort would never use (every last-resort turn/river in the sweep paid exactly that).
  const curToks: SeatTok[][] = [a.streets[first]!.map((tok, j) => ({ tok, seat: a.streetSeats[first]![j]! }))];
  const probeSeats = live.map((p) => ({ pos: p, range: a.arr(p) }));
  if (probeSeats.length > 3 && !pickCollapses(planCollapses(probeSeats, a.heroPos, curToks))) {
    return { ok: false, why: `on the ${["flop", "turn", "river"][first]} itself every villain has put chips in too — nothing collapses` };
  }
  if (probeSeats.length <= 3 && (!allIn.size || probeSeats.length !== 3)) {
    return { ok: false, why: "fewer than four seats left — the plain chain answers this, not a re-root" };
  }
  const ranges: Record<string, number[]> = {};
  const leftOut = new Set<string>();
  // THE GROUPS WALK AT ONCE (2026-09-24 latency pass): each narrowing walk is its own cloud tree(s), 5-12 s of
  // waiting on GTO Wizard, and they share nothing but the token — so they are launched together.
  const walkOne = async (g: string[]) => {
    const keep = order(g);
    const kept = new Set(keep);
    // the earlier streets as this walk plays them: the seats outside it never act (their chips are the approximation)
    const streets: string[][] = [];
    const seats: string[][] = [];
    for (let i = 0; i < first; i++) {
      const t: string[] = [], s: string[] = [];
      a.streets[i]!.forEach((tok, j) => { const who = a.streetSeats[i]![j]!; if (kept.has(who)) { t.push(tok); s.push(who); } else if (!m.folded.has(who)) leftOut.add(who); });
      const fixed = replayWithout(t, s);
      streets.push(fixed.toks); seats.push(fixed.seats);
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
    return { keep, r };
  };
  const results = await Promise.all(groups.map(walkOne));
  for (const { keep, r } of results) {
    if (!r.ok) return { ok: false, why: `narrowing walk ${keep.join("/")}: ${r.why}` };
    for (const [pos, rng] of Object.entries(r.rangesOut ?? {})) if (!ranges[pos]) ranges[pos] = rng;
  }
  for (const p of live) if (!ranges[p]) return { ok: false, why: `no narrowing walk produced ${p}'s range` };

  // ---- 3. collapse the current street on its own
  const cur: SeatTok[][] = [a.streets[first]!.map((tok, j) => ({ tok, seat: a.streetSeats[first]![j]! }))];
  const cSeats = live.map((p) => ({ pos: p, range: ranges[p]! }));
  const covered = [...leftOut].filter((p) => live.includes(p));
  if (cSeats.length <= 3) {
    // three or fewer ACTIVE seats only because the all-ins stepped out: that field IS the tree, nothing to collapse
    if (!allIn.size || cSeats.length !== 3) return { ok: false, why: "fewer than four seats left — the plain chain answers this, not a re-root" };
    const heroIdx = cSeats.findIndex((s) => s.pos === a.heroPos);
    const picked: Picked = {
      plans: [{ kind: `all-in left out: ${[...allIn].join("+")}`, seats: cSeats, heroIdx, streets: cur, steps: 0, ghostOnly: true }],
      mode: "single", why: `${[...allIn].join(", ")} all-in since an earlier street — ${cSeats.length} seats still act`,
    };
    return { ok: true, picked, first: first as 1 | 2, pot: m.pot, stack: m.stack, walks: groups.length,
      left: covered.length ? covered.join(", ") : "none", allIn: [...allIn] };
  }
  const picked = pickCollapses(planCollapses(cSeats, a.heroPos, cur));
  if (!picked) return { ok: false, why: `on the ${["flop", "turn", "river"][first]} itself every villain has put chips in too — nothing collapses` };
  return { ok: true, picked, first: first as 1 | 2, pot: m.pot, stack: m.stack, walks: groups.length,
    left: covered.length ? covered.join(", ") : "none", allIn: [...allIn] };
}
