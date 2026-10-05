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
import { effectiveBehind, solveAiChain, type AiChainSpec } from "./aiChain";
import { handFacts } from "./handFacts";
import { withRequestScope } from "./requestScope";
import { contestedChips, effectiveStack, moneyEntering, moneyState, streetChips, streetFromTokens } from "../utils/tableMoney/tableMoney";
import { planCollapses, pickCollapses, type Picked, type SeatTok } from "./multiwayCollapse";
import { pickDeadMoney, planDeadMoney, replayKept, walkPlays } from "./deadMoneyCollapse";
export { walkPlays };

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
  /** each seat's own stack behind entering the flop (fastSolve's seat stacks); absent = the one flopStack for all */
  behind?: Record<string, number>;
  /** the table's all-in amounts beside the tokens (fastSolve streetAmounts), parallel to `streets` */
  amounts?: (number | null)[][];
  /** the hand's key (the last resort's narrowing only): the walks checkpoint under `<key>#lr-narrow` — the next street
   *  of the hand starts from the earlier streets walked — and narrowForLastResort keeps its result per hand */
  memoKey?: string;
}

export type RerootResult =
  | { ok: true; picked: Picked; first: 1 | 2; pot: number; stack: number; walks: number; left: string; allIn: string[];
      /** each live seat's own stack behind entering the re-rooted street (from RerootArgs.behind) */
      behind?: Record<string, number>;
      /** the current street was collapsed with dead money (deadMoneyCollapse): its plans carry `dead` */
      dead?: boolean;
      /** seats whose ranges entering the street are the flop arrival's — no narrowing walk could hold them */
      unnarrowed?: string[] }
  | { ok: false; why: string };

/**
 * THE MONEY ENTERING STREET `first` of a 4+ way line — every seat counted, nothing collapsed (utils/tableMoney): each
 * seat pays out of its OWN stack (2026-09-25, hand 4920544353) — a call capped at what the caller has, an all-in at
 * the table's amount (`amounts`, else the seat's whole stack), an uncalled excess back to its owner (2026-10-03). A seat
 * with no stack reading starts at the field's `flopStack` — the only place that number still caps anyone. `stack` is
 * the effective stack of the seats still in (hero against the deepest villain who has neither folded nor gone all-in).
 * The re-root and the last resort both start from it.
 */
export function moneyThrough(a: Pick<RerootArgs, "ordered" | "heroPos" | "streets" | "streetSeats" | "flopPot" | "flopStack" | "behind" | "amounts">, first: number):
    { pot: number; stack: number; folded: Set<string>; aggressors: Set<string>; allIn: Set<string>; behind: Record<string, number>;
      /** the earlier streets' tokens the model cannot price (a bet with no amount): the money is not the table's */
      unpriced: number } {
  const st0 = moneyState(a.flopPot, a.ordered.map((p) => [p, a.behind?.[p] ?? a.flopStack] as [string, number]));
  const unpriced: number[] = [];
  const st = moneyEntering(st0, a.streets.slice(0, first).map((t, i) => streetFromTokens(t, a.streetSeats[i] ?? [], a.amounts?.[i], unpriced)), first);
  const behind = Object.fromEntries([...st.behind].map(([p, x]) => [p, x ?? a.flopStack]));
  const still = a.ordered.filter((p) => !st.folded.has(p) && (p === a.heroPos || !st.allIn.has(p)));
  return { pot: st.pot, stack: Math.round(effectiveStack(still, a.heroPos, (p) => behind[p]) * 100) / 100, folded: st.folded, aggressors: st.aggressors, allIn: st.allIn, behind, unpriced: unpriced.length };
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
 * A NARROWING GROUP'S EARLIER STREETS BY THE TAKEOVER (2026-10-05, Brady: "Need 100% coverage"). coverGroups keeps
 * every earlier aggressor in every walk — a call with its bettor dropped has nothing to call — so two earlier bettors
 * and a caller left no group at all ("more aggressors than a three-seat walk holds"). With the takeover replay
 * (deadMoneyCollapse.replayKept) a dropped bettor's wager is the first kept caller's own, so any group can walk the
 * earlier streets with every kept seat's chips where they were; the dropped seats' chips (what the group can contest
 * of them) go into the walk's starting pot. Per street; null when a street cannot be walked by the group (a dropped
 * seat's raise reopened betting the group had closed).
 */
export function takeoverStreets(a: Pick<RerootArgs, "ordered" | "heroPos" | "streets" | "streetSeats" | "flopPot" | "flopStack" | "behind" | "amounts">,
    first: number, group: string[]): { streets: string[][]; seats: string[][]; dead: number; preload: Record<string, number> } | null {
  const kept = new Set(group);
  const streets: string[][] = [], seats: string[][] = [];
  let dead = 0;
  let preload: Record<string, number> = {};
  for (let i = 0; i < first; i++) {
    const toks = a.streets[i]!, who = a.streetSeats[i]!;
    const unpriced: number[] = [];
    const acts = streetFromTokens(toks, who, a.amounts?.[i] ?? null, unpriced);
    if (unpriced.length) return null;
    const beh = moneyThrough(a, i).behind;
    const capOf = (p: string) => beh[p];
    const r = replayKept(acts, toks, kept, capOf, a.ordered);
    // a cut that moved chips puts them in the pot the walk STARTS with — only the walk's first street can take it (a
    // check-around cut moves none and walks on any street — review 3)
    const moved = Object.keys(r.preload).length > 0;
    if (moved && i > 0) return null;
    if (moved) preload = r.preload;
    const sc = streetChips(acts, capOf);
    const c = contestedChips(sc.put, { contesting: [...kept].filter((p) => !sc.folded.has(p)), folded: sc.folded, capOf, hero: a.heroPos });
    for (const [p, x] of c.bySeat) if (!kept.has(p)) dead += x;
    streets.push(r.toks); seats.push(r.seats);
  }
  return { streets, seats, dead: Math.round(dead * 100) / 100, preload };
}

/** The fewest groups of hero + up to two live seats, each walkable by the takeover, that hold every villain in
 *  `needed` — groups with more earlier aggressors first (their lines are the least rewritten). `uncovered` = the
 *  villains no walkable group holds; null when nothing is needed or no group walks at all. */
export function takeoverCover(a: Pick<RerootArgs, "ordered" | "heroPos" | "streets" | "streetSeats" | "flopPot" | "flopStack" | "behind" | "amounts">,
    first: number, live: string[], aggressors: Set<string>, needed?: string[]): { groups: string[][]; uncovered: string[] } | null {
  const villains = live.filter((p) => p !== a.heroPos);
  const cands: string[][] = [];
  if (villains.length <= 2) cands.push([a.heroPos, ...villains]);
  else for (let i = 0; i < villains.length; i++) for (let j = i + 1; j < villains.length; j++) cands.push([a.heroPos, villains[i]!, villains[j]!]);
  // walkable: the takeover replays it, and the tree can play what it replays (walkPlays: rotation, minimum raises, closed)
  const capAt = (i: number) => { const b = moneyThrough(a, i).behind; return (p: string) => b[p]; };
  const ok = cands.filter((g) => {
    const t = takeoverStreets(a, first, g);
    if (!t) return false;
    const k = a.ordered.filter((p) => g.includes(p));
    return walkPlays(a.ordered, k, t.streets, t.seats, (i) => (p) => { const c = capAt(i)(p); return c == null ? c : c - (i === 0 ? t.preload[p] ?? 0 : 0); }) == null;
  })
    .sort((x, y) => y.filter((p) => aggressors.has(p)).length - x.filter((p) => aggressors.has(p)).length);
  // the seats whose ranges the current street needs: a seat that folded on it is dead money there, not a range
  const need = new Set(needed ?? villains), out: string[][] = [];
  while (need.size) {
    let best: string[] | null = null, gain = 0;
    for (const g of ok) { const n = g.filter((p) => need.has(p)).length; if (n > gain) { best = g; gain = n; } }
    if (!best) break;
    out.push(best);
    for (const p of best) need.delete(p);
  }
  return out.length ? { groups: out, uncovered: [...need] } : null;
}

/** takeoverCover, all or nothing: the groups when they hold every needed villain, else null. */
export function takeoverGroups(a: Parameters<typeof takeoverCover>[0], first: number, live: string[], aggressors: Set<string>, needed?: string[]): string[][] | null {
  const c = takeoverCover(a, first, live, aggressors, needed);
  return c && !c.uncovered.length ? c.groups : null;
}

/** The earlier streets as a coverGroups narrowing walk plays them: the kept seats' tokens, a dropped seat's removed and
 *  the street repaired by replayWithout (the walks before the takeover existed). */
export function legacyStreets(a: Pick<RerootArgs, "streets" | "streetSeats">, first: number, folded: ReadonlySet<string>, keep: string[]):
    { streets: string[][]; seats: string[][]; leftOut: string[] } {
  const kept = new Set(keep);
  const streets: string[][] = [], seats: string[][] = [], leftOut = new Set<string>();
  for (let i = 0; i < first; i++) {
    const t: string[] = [], s: string[] = [];
    a.streets[i]!.forEach((tok, j) => { const who = a.streetSeats[i]![j]!; if (kept.has(who)) { t.push(tok); s.push(who); } else if (!folded.has(who)) leftOut.add(who); });
    const fixed = replayWithout(t, s);
    streets.push(fixed.toks); seats.push(fixed.seats);
  }
  return { streets, seats, leftOut: [...leftOut] };
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

/**
 * WHO THE NARROWING WALKS (the re-root's step 2, shared with the last resort): the seats still in at street `first`
 * — not folded, not all-in since an earlier street — and the fewest three-seat groups (coverGroups) that hold hero,
 * every earlier aggressor and each of them. `groups` null = more must-seats than a three-seat walk holds.
 */
export function narrowingPlan(a: RerootArgs, first: number, m: ReturnType<typeof moneyThrough>): { allIn: Set<string>; live: string[]; groups: string[][] | null } {
  // A SEAT ALL-IN FROM AN EARLIER STREET NEVER ACTS AGAIN (2026-09-24, sweep side-pot spots). It needs no seat in a
  // tree: its chips are already in the pot (moneyThrough counts them) and nobody can bet into it. Leaving it out is
  // what lets "CO jammed the flop, three called, turn bet to hero" be ONE exact three-seat tree instead of a
  // heads-up last resort. The cost, said in the answer: hero's equity against its range at showdown is not modelled.
  const curSeats = new Set(a.streetSeats[first] ?? []);
  const allIn = new Set([...(a.allIn ?? [])].filter((p) => p !== a.heroPos && !curSeats.has(p) && !m.folded.has(p)));
  const live = a.ordered.filter((p) => !m.folded.has(p) && !allIn.has(p));
  const groups = coverGroups(live, a.heroPos, new Set([...m.aggressors].filter((p) => !allIn.has(p))));
  return { allIn, live, groups };
}

/**
 * THE NARROWING WALKS (the re-root's step 2, shared with the last resort): each group walks the earlier streets
 * 0..first-1 as a three-seat (or two-seat) chain with walkThrough — the seats outside it never act there (their chips
 * are the approximation) — and hands on each seat's range leaving them. The groups walk at once. `ms` is the
 * wall-clock of the slowest, what the narrowing adds to the answer.
 */
export async function narrowThroughEarlier(a: RerootArgs, first: number, m: ReturnType<typeof moneyThrough>, groups: string[][], takeover = false):
    Promise<{ ok: true; ranges: Record<string, number[]>; leftOut: Set<string>; walks: number; ms: number } | { ok: false; why: string; ms: number }> {
  const t0 = Date.now();
  const order = (xs: string[]) => a.ordered.filter((p) => xs.includes(p));
  const ranges: Record<string, number[]> = {};
  const leftOut = new Set<string>();
  // THE GROUPS WALK AT ONCE (2026-09-24 latency pass): each narrowing walk is its own cloud tree(s), 5-12 s of
  // waiting on GTO Wizard, and they share nothing but the token — so they are launched together.
  const walkOne = async (g: string[]) => {
    const keep = order(g);
    const kept = new Set(keep);
    // the earlier streets as this walk plays them: the seats outside it never act (their chips are the approximation)
    let streets: string[][] = [];
    let seats: string[][] = [];
    let deadIn = 0;
    let preload: Record<string, number> = {};
    if (takeover) {
      // the takeover (takeoverStreets): every kept seat's chips where they were, the dropped seats' into the pot (and a
      // cut's kept chips — replayKept — into it too, off their stacks)
      const tk = takeoverStreets(a, first, keep)!;
      streets = tk.streets; seats = tk.seats; deadIn = tk.dead + Object.values(tk.preload).reduce((x, y) => x + y, 0);
      preload = tk.preload;
      for (let i = 0; i < first; i++) for (const who of a.streetSeats[i]!) if (!kept.has(who) && !m.folded.has(who)) leftOut.add(who);
    } else {
      const lg = legacyStreets(a, first, m.folded, keep);
      streets = lg.streets; seats = lg.seats;
      for (const p of lg.leftOut) leftOut.add(p);
    }
    const three = keep.map((p) => ({ pos: p, range: a.arr(p) }));
    const heroIdx = keep.indexOf(a.heroPos);
    // the walk's own seats' stacks: its flop at their effective stack, and each later street at the stack of those left
    const seatStacks = a.behind || Object.keys(preload).length
      ? Object.fromEntries(keep.filter((p) => a.behind?.[p] != null || preload[p] != null)
        .map((p) => [p, Math.round(((a.behind?.[p] ?? a.flopStack) - (preload[p] ?? 0)) * 100) / 100]))
      : undefined;
    const spec: AiChainSpec = {
      ...(a.rake ? { rake: a.rake } : {}),
      ...(three.length === 3 ? a.specOf(three, heroIdx) : {
        oopPos: three[0]!.pos, ipPos: three[1]!.pos, oopRange: three[0]!.range, ipRange: three[1]!.range,
        heroSeat: heroIdx === 0 ? "oop" as const : "ip" as const,
      }),
      // the walk's own seats' effective stack (the field's only where none of theirs is known)
      flopPot: Math.round((a.flopPot + deadIn) * 100) / 100, flopStack: ((e) => (Number.isFinite(e) ? e : a.flopStack))(effectiveBehind(keep, a.heroPos, seatStacks)), board: a.board, streets, streetSeats: seats,
      ...(seatStacks ? { seatStacks } : {}),
      heroComboIdx: a.heroComboIdx, walkThrough: true,
      // the hand's memo (aiChain checkpoints, content-keyed, in this process only — never the hand's persistent facts,
      // review 3): a later street's walk of these streets starts past them
      ...(a.memoKey ? { handKey: `${a.memoKey}#lr-narrow`, checkpointOnly: true } : {}),
    };
    const r = await solveAiChain(spec);
    return { keep, r };
  };
  const results = await Promise.all(groups.map(walkOne));
  for (const { keep, r } of results) {
    if (!r.ok) return { ok: false, why: `narrowing walk ${keep.join("/")}: ${r.why}`, ms: Date.now() - t0 };
    for (const [pos, rng] of Object.entries(r.rangesOut ?? {})) if (!ranges[pos]) ranges[pos] = rng;
  }
  return { ok: true, ranges, leftOut, walks: groups.length, ms: Date.now() - t0 };
}

export async function rerootCollapse(a: RerootArgs): Promise<RerootResult> {
  const first = a.streets.length - 1;
  if (first < 1 || first > 2) return { ok: false, why: "nothing to re-root on the flop" };
  const m = moneyThrough(a, first);
  if (m.unpriced) return { ok: false, why: "a bet or raise on an earlier street has no amount on the capture — its money cannot be priced" };
  if (m.stack <= 0.5) return { ok: false, why: "the earlier streets put everyone (near) all-in" };
  const plan = narrowingPlan(a, first, m);
  const { allIn, live } = plan;
  let groups = plan.groups;
  // A coverGroups walk the tree cannot play (stress-500 brief_D-001: its dropped seats were all in on an earlier street
  // and the levels the kept seats called went with them) — the takeover narrowing instead (walkPlays)
  if (groups) {
    const capAt = (i: number) => { const b = moneyThrough(a, i).behind; return (p: string) => b[p]; };
    if (groups.some((g) => { const k = a.ordered.filter((p) => g.includes(p)); const lg = legacyStreets(a, first, m.folded, k); return walkPlays(a.ordered, k, lg.streets, lg.seats, capAt) != null; })) groups = null;
  }
  if (!live.includes(a.heroPos)) return { ok: false, why: "hero folded earlier" };

  // ---- 2. narrow each live seat's range through the earlier streets
  // more earlier aggressors than one three-seat walk holds: the takeover groups (takeoverCover) instead; a villain no
  // walkable group holds keeps his flop-arrival range — not narrowed by the earlier streets, said in the answer
  let takeover = false;
  let unnarrowed: string[] = [];
  // a seat that folded on the CURRENT street needs no range: the current street drops him (his chips dead money)
  const curFolded = new Set<string>();
  a.streets[first]!.forEach((t, j) => { if (t === "F") curFolded.add(a.streetSeats[first]![j]!); });
  if (!groups) {
    const cov = takeoverCover(a, first, live, new Set([...m.aggressors].filter((p) => !allIn.has(p))),
      live.filter((p) => p !== a.heroPos && !curFolded.has(p)));
    if (cov) { groups = cov.groups; takeover = true; unnarrowed = cov.uncovered; }
  }
  // no three-seat group walks the earlier streets at all: every seat (hero too) enters with its flop-arrival range —
  // the current street is still solved three-handed (Brady: never heads-up behind a spot meant to be three-handed)
  if (!groups) { groups = []; takeover = true; unnarrowed = [...live]; }
  // THE DOOM CHECK COMES FIRST (2026-09-24 latency pass). Whether the current street can be collapsed to three
  // seats depends only on its tokens, not on the narrowed ranges — so ask before spending 12-24 s of cloud walks
  // on ranges the last resort would never use (every last-resort turn/river in the sweep paid exactly that).
  const curToks: SeatTok[][] = [a.streets[first]!.map((tok, j) => ({ tok, seat: a.streetSeats[first]![j]! }))];
  const probeSeats = live.map((p) => ({ pos: p, range: a.arr(p) }));
  // the current street's own chips per seat, for a DEAD-MONEY collapse (deadMoneyCollapse, 2026-10-05): when no seat
  // can be ghosted or merged on it, hero, the wager he faces and each other villain in turn are kept, the dropped
  // seats' chips on this street dead money in the pot it starts with — the heads-up last resort that used to answer
  // here is off (Brady: "do NOT use heads up last resort it is a terrible model")
  const deadOf = (seats: { pos: string; range: number[] }[]) => planDeadMoney({
    seats, heroPos: a.heroPos, street: curToks[0]!, amounts: a.amounts?.[first] ?? null, behind: (p) => m.behind[p],
  });
  // a street where a seat put chips in and then folded: nothing ghosts him, the dead-money collapse drops him
  const committedFold = (() => {
    const put = new Set<string>();
    for (const t of curToks[0]!) { if (t.tok !== "X" && t.tok !== "F") put.add(t.seat); else if (t.tok === "F" && put.has(t.seat)) return true; }
    return false;
  })();
  if (probeSeats.length > 3 && !pickCollapses(planCollapses(probeSeats, a.heroPos, curToks)) && !deadOf(probeSeats).plans.length) {
    return { ok: false, why: `on the ${["flop", "turn", "river"][first]} itself every villain has put chips in too — nothing collapses (${deadOf(probeSeats).why})` };
  }
  if (probeSeats.length < 2) return { ok: false, why: "no villain is left in" };
  // three or fewer seats with a fold after chips on this street: only the dead-money collapse fits — ask before the
  // narrowing walks (review 2026-10-05: they ran even when it could not)
  if (probeSeats.length <= 3 && committedFold && !deadOf(probeSeats).plans.length) {
    return { ok: false, why: `on the ${["flop", "turn", "river"][first]} the seats left cannot be walked (${deadOf(probeSeats).why})` };
  }
  const nr = groups.length ? await narrowThroughEarlier(a, first, m, groups, takeover)
    : { ok: true as const, ranges: {} as Record<string, number[]>, leftOut: new Set<string>(), walks: 0, ms: 0 };
  if (!nr.ok) return { ok: false, why: nr.why };
  const { ranges, leftOut } = nr;
  // review 2026-10-05: a seat that folded on this street, or that no takeover group held, takes his flop-arrival range
  for (const p of live) if (!ranges[p] && (curFolded.has(p) || unnarrowed.includes(p))) ranges[p] = a.arr(p);
  for (const p of live) if (!ranges[p]) return { ok: false, why: `no narrowing walk produced ${p}'s range` };

  // ---- 3. collapse the current street on its own
  const cur: SeatTok[][] = [a.streets[first]!.map((tok, j) => ({ tok, seat: a.streetSeats[first]![j]! }))];
  const cSeats = live.map((p) => ({ pos: p, range: ranges[p]! }));
  const covered = [...leftOut].filter((p) => live.includes(p));
  const base = { first: first as 1 | 2, pot: m.pot, stack: m.stack, walks: groups.length,
    left: covered.length ? covered.join(", ") : "none", allIn: [...allIn], ...(a.behind ? { behind: m.behind } : {}),
    ...(unnarrowed.length ? { unnarrowed } : {}) };
  if (cSeats.length <= 3 && !committedFold) {
    // THREE OR FEWER SEATS STILL ACT — the all-ins stepped out, or the seats that left folded on an earlier street
    // after putting chips in (so no collapse from the flop could drop them): that field IS the tree, re-rooted here
    // (2026-10-05: it used to be refused as "the plain chain answers this", which it had just failed to)
    const heroIdx = cSeats.findIndex((s) => s.pos === a.heroPos);
    const why = allIn.size ? `${[...allIn].join(", ")} all-in since an earlier street — ${cSeats.length} seats still act`
      : `${cSeats.length} seats still act — the rest folded earlier, their chips in the pot`;
    const picked: Picked = {
      plans: [{ kind: allIn.size ? `all-in left out: ${[...allIn].join("+")}` : "re-rooted: the seats still in", seats: cSeats, heroIdx, streets: cur, steps: 0, ghostOnly: true }],
      mode: "single", why,
    };
    return { ok: true, picked, ...base };
  }
  const picked = cSeats.length > 3 ? pickCollapses(planCollapses(cSeats, a.heroPos, cur)) : null;
  if (picked) return { ok: true, picked, ...base };
  const dm = deadOf(cSeats);
  const dp = pickDeadMoney(dm.plans);
  if (!dp) return { ok: false, why: `on the ${["flop", "turn", "river"][first]} itself every villain has put chips in too — nothing collapses (${dm.why})` };
  return { ok: true, picked: dp, ...base, dead: true };
}

/**
 * THE LAST RESORT'S RANGES, NARROWED THROUGH THE EARLIER STREETS (2026-10-03, Brady: "do 1-3"). The last resort plays
 * hero against the last aggressor heads-up at the current street; it used to give both the flop-ARRIVAL ranges, as if
 * nothing had happened on the flop (or turn). This runs the re-root's own narrowing (narrowingPlan + narrowThroughEarlier
 * — the same three-seat walks, no second implementation) for the one group that holds the aggressor (hero is in every
 * group), and hands back hero's and the aggressor's ranges leaving the earlier streets. Nothing to narrow on the flop;
 * a group that cannot be formed or walked is a refusal the caller turns into today's unnarrowed last resort.
 */
type LrNarrowing = { ok: true; hero: number[]; villain: number[]; walks: number; ms: number; group: string[] } | { ok: false; why: string; ms: number };
/** narrowForLastResort's results in flight or done, per hand and input (memoKey set): a re-ask joins, never re-walks */
const lrNarrowMemo = new Map<string, Promise<LrNarrowing>>();
const LR_NARROW_MEMO_MAX = 200;
const hashOf = (x: unknown): string => Bun.hash(JSON.stringify(x)).toString(36);
/** Drop the last resort's narrowing memo (tests). */
export function forgetLrNarrowing(): void { lrNarrowMemo.clear(); }

export function narrowForLastResort(a: RerootArgs, villain: string): Promise<LrNarrowing> {
  if (!a.memoKey) return narrowForLastResortNow(a, villain);
  const first = a.streets.length - 1;
  const key = hashOf([a.memoKey, villain, a.heroPos, first, a.streets.slice(0, first), a.streetSeats.slice(0, first), a.amounts?.slice(0, first) ?? null,
    a.flopPot, a.flopStack, a.behind ?? null, a.board.slice(0, 6 + 2 * first), a.rake ?? null, a.heroComboIdx, a.ordered.map((p) => [p, hashOf(a.arr(p))])]);
  const hit = lrNarrowMemo.get(key);
  if (hit) return hit;
  // THE WALKS' REQUESTS ARE THE HAND'S (review 3): counted on their own scope (the hand, caller tag "lr-narrow" — the
  // ledger's rows carry both) and added to the hand's facts when the walk ends, even after the answer was served
  const memoKey = a.memoKey;
  const p = withRequestScope({ handKey: memoKey, origin: "lr-narrow", street: ["flop", "turn", "river"][first] ?? null }, () => narrowForLastResortNow(a, villain))
    .then(({ value, scope }) => { handFacts.addRequests(memoKey, "lr-narrow", scope.counts); return value; });
  lrNarrowMemo.set(key, p);
  while (lrNarrowMemo.size > LR_NARROW_MEMO_MAX) { const f = lrNarrowMemo.keys().next().value; if (f === undefined) break; lrNarrowMemo.delete(f); }
  // a refusal is not remembered (a 429 now may walk later)
  p.then((r) => { if (!r.ok && lrNarrowMemo.get(key) === p) lrNarrowMemo.delete(key); }, () => { if (lrNarrowMemo.get(key) === p) lrNarrowMemo.delete(key); });
  return p;
}

async function narrowForLastResortNow(a: RerootArgs, villain: string): Promise<LrNarrowing> {
  const first = a.streets.length - 1;
  if (first < 1) return { ok: false, why: "on the flop there is nothing earlier to narrow", ms: 0 };
  const m = moneyThrough(a, first);
  if (m.unpriced) return { ok: false, why: "a bet or raise on an earlier street has no amount on the capture", ms: 0 };
  const { groups } = narrowingPlan(a, first, m);
  if (!groups) return { ok: false, why: `${[...m.aggressors].join(", ")} all bet or raised earlier — more than a three-seat walk holds`, ms: 0 };
  const mine = groups.filter((g) => g.includes(villain)).slice(0, 1);
  if (!mine.length) return { ok: false, why: `${villain} is in no narrowing group`, ms: 0 };
  const nr = await narrowThroughEarlier(a, first, m, mine);
  if (!nr.ok) return nr;
  const hero = nr.ranges[a.heroPos], vil = nr.ranges[villain];
  if (!hero || !vil) return { ok: false, why: `the narrowing walk ${mine[0]!.join("/")} handed on no range for ${!hero ? a.heroPos : villain}`, ms: nr.ms };
  return { ok: true, hero, villain: vil, walks: nr.walks, ms: nr.ms, group: mine[0]! };
}
