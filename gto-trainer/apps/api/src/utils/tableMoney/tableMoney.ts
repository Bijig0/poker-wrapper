/**
 * THE TABLE'S MONEY — ONE MODEL (2026-10-03, Brady: "remove the duplicate function … make it DRY, cut it up into small
 * enough pieces that it becomes functional-ish enough that we can just reuse the code").
 *
 * Before this, a hand's chips were replayed five ways: the chain's street state (aiChain.StreetState), check #5's table
 * side (fastSolve.matchedRound / chipsOn / chipsOnPlan), the flop pot and the flop stacks (tableFlopPot,
 * flopSeatStacks), the re-root's earlier streets (multiwayReroot.moneyThrough) and the last resort's current street
 * (fastSolve.heroVsAggressor). The copies disagreed exactly where it bites: a call all-in for less, an uncalled excess,
 * a seat left out of the tree, an all-in priced at the tree's one stack instead of the table's amount.
 *
 * The cut, smallest piece first — each is pure (no I/O, no clock, no globals), generic over the seat key (a table seat
 * id, a position, a tree index), and composes with the next:
 *
 *   actFromToken / streetFromTokens   the GTO Wizard capture tokens (X / C / F / R<to> / RAI) as table acts, the all-in's
 *                                     amount carried beside its token — tokens only where a caller has nothing else
 *   chipsAfter                        ONE act: the actor's total on the street afterwards (a call capped at what he has,
 *                                     an all-in at the table's amount, else his whole stack behind)
 *   streetChips                       ONE street's acts → each seat's chips in, the level, who folded, who is all-in, who
 *                                     bet or raised
 *   contestedChips                    the chips of a round that can be MATCHED by the seats contesting them: a bet past
 *                                     the most any other contesting seat can put in is uncalled and goes back; a seat
 *                                     that is NOT contesting (left out of a tree) is dead money, counted up to the
 *                                     contesting field's effective stack (what hero can win of it). The full table and a
 *                                     tree's own seats are the same function with a different seat set.
 *   foldStreet / moneyEntering        a street folded into the state (pot, each seat's stack behind, who folded, who is
 *                                     all-in, who was an aggressor); streets 0..k-1 → the state entering street k
 *   deadMoney                         what no act carries: antes, a folded poster's dead post
 *   effectiveStack                    hero against the deepest villain still in
 *
 * A stack that is not known is null: never a cap (an unknown stack cannot make a legal act illegal), never shrinking
 * an effective stack (a missing reading never lowers a tree — 2026-09-25, hand 4920544353).
 */

export type ActKind = "check" | "call" | "fold" | "raise" | "allin";
/** One act at the table: `to` is the seat's total on the street after a raise (bet or raise), or an all-in's amount
 *  when the table showed it (absent: the seat's whole stack behind). */
export interface Act<K> { seat: K; kind: ActKind; to?: number }

const r2 = (x: number): number => Math.round(x * 100) / 100;
const cap0 = (c: number | null | undefined): number => (c != null && Number.isFinite(c) ? c : Infinity);

/** A capture token as a table act ("RAI" with its amount beside it — buildSolutionUrl keeps the literal token). */
export function actFromToken<K>(tok: string, seat: K, amount?: number | null): Act<K> {
  if (tok === "X") return { seat, kind: "check" };
  if (tok === "C") return { seat, kind: "call" };
  if (tok === "F") return { seat, kind: "fold" };
  if (tok === "RAI") return amount != null && Number.isFinite(amount) && amount > 0 ? { seat, kind: "allin", to: amount } : { seat, kind: "allin" };
  if (/^R[\d.]+$/.test(tok)) return { seat, kind: "raise", to: parseFloat(tok.slice(1)) };
  throw new Error(`unknown token "${tok}"`);
}
/** A street's tokens, the seat of each and the all-in amounts beside them, as table acts. */
export function streetFromTokens<K>(toks: readonly string[], seats: readonly K[], amounts?: readonly (number | null | undefined)[] | null): Act<K>[] {
  return toks.map((t, i) => actFromToken(t, seats[i]!, amounts?.[i]));
}

/**
 * The actor's total on the street after ONE act. `mine` = what he had in before it, `level` = the most anyone has in,
 * `cap` = his stack behind entering the street (null = unknown). A call is capped at what he has (all-in for less); a
 * raise at his stack (a wager past it is his all-in); an all-in is the table's amount, else everything he has.
 */
export function chipsAfter(act: { kind: ActKind; to?: number }, mine: number, level: number, cap: number | null | undefined): number {
  const c = cap0(cap);
  switch (act.kind) {
    case "check": case "fold": return mine;
    case "call": return Math.max(mine, Math.min(level, c));
    case "raise": return Math.min(act.to ?? NaN, c);
    case "allin": return Math.min(act.to ?? c, c);
  }
}

export interface StreetChips<K> {
  /** each seat's chips in on the street (seats that put nothing in are absent) */
  put: Map<K, number>;
  /** the most anyone has in */
  level: number;
  folded: Set<K>;
  /** seats with nothing left behind after the street (only those whose stack is known) */
  allIn: Set<K>;
  /** seats that bet or raised (an all-in that raised the level included) */
  aggressors: Set<K>;
}

/** ONE street's acts, each seat paying out of its own stack (`capOf`: its stack behind entering the street). */
export function streetChips<K>(acts: readonly Act<K>[], capOf: (seat: K) => number | null | undefined): StreetChips<K> {
  const put = new Map<K, number>();
  const folded = new Set<K>(), allIn = new Set<K>(), aggressors = new Set<K>();
  let level = 0;
  for (const a of acts) {
    if (a.kind === "fold") { folded.add(a.seat); continue; }
    const mine = put.get(a.seat) ?? 0;
    const to = chipsAfter(a, mine, level, capOf(a.seat));
    if (!Number.isFinite(to)) throw new Error(`${a.kind} with no amount and no stack for ${String(a.seat)}`);
    if (to !== mine || a.kind === "call") put.set(a.seat, to);
    if ((a.kind === "raise" || a.kind === "allin") && to > level + 0.005) aggressors.add(a.seat);
    level = Math.max(level, to);
    const c = capOf(a.seat);
    if (c != null && Number.isFinite(c) && to >= c - 0.005) allIn.add(a.seat);
  }
  return { put, level, folded, allIn, aggressors };
}

/**
 * THE CHIPS OF A ROUND THAT CAN BE MATCHED by the seats contesting them (2026-10-03). A contesting seat's chips count
 * up to the most any OTHER contesting seat can put in — a seat still in: its stack (`capOf`, null = unbounded); a seat
 * that folded: the chips it left — the rest is uncalled and goes back to its owner (heads-up: a 150bb shove into a
 * 50bb stack is a 50bb bet). A seat that is NOT contesting (left out of a collapsed tree, the last resort's other
 * villains) is dead money to the tree: counted up to the contesting field's effective stack — hero against the deepest
 * other contesting seat — which is what hero can win of it (review r2, 2026-10-03: a 4-way shove into a 60bb hero is
 * 200 in the pot he can win, not the table's 260). The full table is `contesting` = every seat in the hand.
 */
export function contestedChips<K>(put: ReadonlyMap<K, number>, o: {
  contesting: Iterable<K>; folded: ReadonlySet<K>; capOf: (seat: K) => number | null | undefined; hero?: K;
}): { sum: number; bySeat: Map<K, number>; returned: { seat: K; bb: number }[] } {
  const named = new Set(o.contesting);
  const contesting = named.size ? named : new Set(put.keys());   // nobody named: everyone who put chips in
  const most = (s: K) => {
    let m = 0;
    for (const t of contesting) {
      if (t === s) continue;
      m = Math.max(m, o.folded.has(t) ? (put.get(t) ?? 0) : cap0(o.capOf(t)));
    }
    return m;
  };
  // the dead money's cap: hero against the deepest other contesting seat still in (no hero named: no cap)
  const deadCap = o.hero != null && contesting.has(o.hero)
    ? Math.min(cap0(o.capOf(o.hero)), Math.max(0, ...[...contesting].filter((t) => t !== o.hero && !o.folded.has(t)).map((t) => cap0(o.capOf(t)))))
    : Infinity;
  const bySeat = new Map<K, number>();
  const returned: { seat: K; bb: number }[] = [];
  let sum = 0;
  for (const [s, c] of put) {
    const got = contesting.has(s) ? Math.min(c, most(s)) : Math.min(c, deadCap);
    bySeat.set(s, got);
    sum += got;
    if (c - got > 0.005) returned.push({ seat: s, bb: r2(c - got) });
  }
  return { sum: r2(sum), bySeat, returned };
}

/** The money entering a street: the pot, each seat's stack behind (null = unknown), and who has left the betting. */
export interface MoneyState<K> {
  pot: number;
  behind: Map<K, number | null>;
  folded: Set<K>;
  allIn: Set<K>;
  aggressors: Set<K>;
}

/** A starting state: the pot and each seat's stack behind (a seat with no reading → null). */
export function moneyState<K>(pot: number, behind: Iterable<[K, number | null | undefined]>): MoneyState<K> {
  return { pot, behind: new Map([...behind].map(([k, v]) => [k, v != null && Number.isFinite(v) ? v : null])), folded: new Set(), allIn: new Set(), aggressors: new Set() };
}

/**
 * ONE STREET FOLDED INTO THE STATE: every seat pays its MATCHED chips (the full table's rule — everyone still in the
 * hand contests) out of its own stack, the pot grows by them, folds / all-ins / aggressors accumulate.
 */
export function foldStreet<K>(st: MoneyState<K>, acts: readonly Act<K>[]): MoneyState<K> {
  const capOf = (k: K) => st.behind.get(k) ?? null;
  const sc = streetChips(acts, capOf);
  const folded = new Set([...st.folded, ...sc.folded]);
  const m = contestedChips(sc.put, { contesting: [...st.behind.keys(), ...sc.put.keys()].filter((k) => !st.folded.has(k)), folded, capOf });
  const behind = new Map(st.behind);
  for (const [k, x] of m.bySeat) { const b = behind.get(k); if (b != null) behind.set(k, r2(Math.max(0, b - x))); }
  const allIn = new Set([...st.allIn, ...[...behind].filter(([k, b]) => b != null && b <= 0.005 && !folded.has(k)).map(([k]) => k)]);
  return { pot: r2(st.pot + m.sum), behind, folded, allIn, aggressors: new Set([...st.aggressors, ...sc.aggressors]) };
}

/** The state entering street `k` (0 = the first street of `streets`): streets 0..k-1 folded in, in order. */
export function moneyEntering<K>(st0: MoneyState<K>, streets: readonly (readonly Act<K>[])[], k: number): MoneyState<K> {
  return streets.slice(0, k).reduce((st, acts) => foldStreet(st, acts), st0);
}

/** What no act carries: the antes, a folded poster's dead post. */
export function deadMoney(a: { antes?: number; deadPosts?: number }): number {
  return r2((a.antes ?? 0) + (a.deadPosts ?? 0));
}

/**
 * THE EFFECTIVE STACK OF THE SEATS IN A TREE (2026-09-25): hero's stack behind against the DEEPEST villain's. A seat
 * whose stack is unknown counts as unbounded, so a missing reading can never shrink a tree — the caller caps the result
 * with the stack it would have used anyway. Infinity when nothing is known.
 */
export function effectiveStack<K>(seats: readonly K[], hero: K, behindOf: (seat: K) => number | null | undefined): number {
  const villains = seats.filter((p) => p !== hero);
  const deepest = villains.length ? Math.max(...villains.map((v) => cap0(behindOf(v)))) : Infinity;
  return Math.min(cap0(behindOf(hero)), deepest);
}
