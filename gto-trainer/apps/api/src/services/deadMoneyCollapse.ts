/**
 * THE DEAD-MONEY COLLAPSE (2026-10-05, Brady after hand 4922578344: "do NOT use heads up last resort it is a terrible
 * model"). multiwayCollapse reduces a 4+ seat street to three by GHOSTING a villain who committed nothing on it or
 * MERGING two adjacent villains that commit once a street. Once two villains have chips in on the street (bet-call-
 * call, bet-raise-call, a bet that was raised and then folded) neither primitive applies and nothing was left but the
 * heads-up last resort: hero against the last aggressor, everyone else dead money — on 4922578344 it played 88 against
 * a 17.4bb raiser and never saw the 82bb small blind who had called him.
 *
 * DEAD MONEY: a villain may leave the street with his chips on it moved into the pot the street starts with. The
 * street is then walked by the seats kept, as they played it (multiwayReroot.replayWithout repairs a call left with
 * nothing to call). Hero's node is priced exactly — the same pot, the same amount to call — what is approximate is the
 * line before it: the dropped seat's chips are in the pot from the street's first action instead of arriving
 * mid-street, so the kept seats' earlier wagers face a bigger pot than they did.
 *
 * WHO IS KEPT: hero; the villain holding the street's level (the wager hero faces — dropping him would change the
 * price); then one more villain still in, every choice of him a plan of its own — blended (fold as often as the most
 * folding tree, wager as often as the least wagering one), so no single dropped opponent decides the answer. A seat that
 * folded on the street always leaves, his chips dead. Plans are ordered by what the kept villain can still put against
 * hero (his chips on the street + his stack, capped at hero's): the first plan defines the answer's menu.
 * Measured on 4922578344 (2 trees, the live flop ranges): keep the SB → 88 FOLD 99.99%, keep the CO → FOLD 99.99%; the
 * heads-up last resort had said ALLIN 17.4.
 */
import { chipsAfter, contestedChips, streetChips, streetFromTokens, type Act } from "../utils/tableMoney/tableMoney";
import type { CollapsePlan, CollapseSeat, Picked, SeatTok } from "./multiwayCollapse";

export interface DeadMoneyPlan extends CollapsePlan {
  /** chips the dropped seats put in on this street (what the kept seats can contest of them): added to the tree's
   *  starting pot */
  dead: number;
  /** the dropped seats with chips on the street, and how many */
  deadBy: Record<string, number>;
  /** kept seats whose CALL of a dropped seat's wager is the tree's wager (replayKept) */
  tookOver: string[];
  /** every villain but one has folded: the tree is the heads-up spot itself, not an approximation of hero's opponents */
  headsUp: boolean;
  /** kept seats' own chips moved into the starting pot by a cut (replayKept): off their stacks, into the pot */
  preload: Record<string, number>;
  /** how many times the street was cut (0 = walked from its first action) */
  cuts: number;
}

/**
 * A STREET AS THE KEPT SEATS PLAYED IT, EVERY CHIP WHERE IT WAS (2026-10-05). Dropping a seat drops his tokens; what
 * the kept seats did stays, with one rewrite: a kept seat that CALLED a level only a dropped seat had made puts those
 * chips in as a wager of his own in the tree (the first such caller "takes over" the dropped wager — "SB bets 4, hero
 * calls, CO raises to 14, SB folds" is "hero bets 4, CO raises to 14"). Plain removal (multiwayReroot.replayWithout)
 * turned that call into a check and hero met a 14 bet with 4 of his own gone from the pot: the price at hero's node
 * was wrong. With the takeover every kept seat has exactly its chips on the street at every node, so the pot at hero's
 * node (the dropped seats' chips are the tree's starting dead money) and hero's amount to call are the table's.
 * What it changes is the CALLER's action: his range is read as a bettor's there.
 *
 * THE TREE'S ROUND CLOSES BEFORE A DROPPED SEAT REOPENS IT (fuzz + review, 2026-10-05): the kept seats checked around,
 * or bet and called, and only then did a dropped seat bet or raise. The tree's street would be over there and the rest
 * of the line could not be walked. It is CUT: every kept seat's chips so far (they have all matched — or are all in)
 * go into the pot the tree starts with and come off their stacks (`preload`), and the tree's street starts again at
 * the reopening, its wagers counted from that level (`base`); the kept seats that sit before the next kept actor in the
 * rotation check in front of him. Every chip is still where it was and hero's price is the table's; what is lost is the
 * kept seats' actions before the cut as range information. A seat all in (its chips at its stack) has acted.
 * `order` = the seats in postflop order (default: the order they first act in).
 */
export function replayKept(acts: Act<string>[], toks: string[], kept: ReadonlySet<string>, capOf: (p: string) => number | null | undefined,
    order?: readonly string[], startBase = 0): { toks: string[]; seats: string[]; tookOver: string[]; preload: Record<string, number>; cuts: number; shifts: number; closed: false; lostFold: boolean } {
  const rot = order?.length ? [...order] : [...new Set(acts.map((x) => x.seat))];
  const out: string[] = [], seats: string[] = [], tookOver: string[] = [];
  const put = new Map<string, number>(), treePut = new Map<string, number>();
  // `startBase` (planDeadMoney's last mode): every kept seat's first `startBase` chips are in the starting pot — the
  // dropped seats' opening levels, when every kept seat went past them
  const preload: Record<string, number> = {};
  if (startBase > 0) for (const p of kept) preload[p] = startBase;
  let level = 0, treeLevel = 0, base = startBase, cuts = 0, shifts = 0;
  // THE TREE'S MINIMUM RAISE (stress-500 brief_D-001 / brief_I-003, 2026-10-05): a wager in the tree must raise by at
  // least the last raise's increment (a bet by 1bb), unless it is the seat's all-in — GTO Wizard offers nothing else.
  // A takeover of a dropped seat's INCOMPLETE all-in raise ("SB jams 15, UTG jams 22, CO calls 22" kept without
  // UTG: the CO "raising" 15 to 22) is no legal raise: the seat CALLS the tree's level and the rest of his chips go
  // into the starting pot, off his stack (`preload`, as a cut does) — every chip still where it was.
  let lastInc = 1;
  // each incomplete increment moved to the pot, at the real level it was made: every kept seat whose chips go past
  // that level moves the same amount (a caller of it, and a raiser over it — or hero's price would differ from the
  // holder's by it). They outlive a cut: a seat that passes the level after it still owes its share
  const layers: { at: number; amt: number; done: Set<string> }[] = [];
  const inTree = new Set(kept);
  const cap = (p: string) => (capOf(p) ?? Infinity) - (preload[p] ?? 0);
  const allIn = (p: string) => (treePut.get(p) ?? 0) >= cap(p) - 0.005;
  let actedSince = new Set<string>();
  const roundOver = () => inTree.size > 0 && [...inTree].every((p) => allIn(p) || (actedSince.has(p) && (treePut.get(p) ?? 0) >= treeLevel - 0.005));
  const r = (x: number) => Math.round(x * 100) / 100;
  // the cut, when the next kept action comes after the tree's round has closed — before that action is priced. Only
  // seats still in move chips (inTree): a KEPT seat that folded with chips in before a cut would lose them — no caller
  // keeps a folded seat (planDeadMoney keeps seats still in, the takeover groups seats live at the street)
  // a KEPT seat that folded before a cut: the cut would drop his fold and his chips, and the tree would deal him back in
  // (reachable since planDeadMoney may keep a folder) — flagged, and such a replay is never used
  let lostFold = false;
  const maybeCut = (seat: string) => {
    if (out.length && roundOver()) {
      if ([...kept].some((p) => !inTree.has(p))) lostFold = true;
      // the cut: the kept seats' chips so far are the tree's starting pot, the round starts again here
      for (const p of inTree) { const x = treePut.get(p) ?? 0; if (x > 0) preload[p] = r((preload[p] ?? 0) + x); }
      base = r(base + treeLevel); cuts++;
      out.length = 0; seats.length = 0; treePut.clear(); treeLevel = 0; lastInc = 1; actedSince = new Set();
      for (const p of rot) {
        if (p === seat) break;
        if (inTree.has(p) && cap(p) > 0.005) { out.push("X"); seats.push(p); actedSince.add(p); }
      }
    }
  };
  const emit = (seat: string, tok: string) => { out.push(tok); seats.push(seat); actedSince.add(seat); };
  acts.forEach((a, i) => {
    if (a.kind === "fold") {
      if (kept.has(a.seat)) { maybeCut(a.seat); emit(a.seat, "F"); inTree.delete(a.seat); }
      return;
    }
    const mine = put.get(a.seat) ?? 0;
    const to = chipsAfter(a, mine, level, capOf(a.seat));
    put.set(a.seat, to);
    level = Math.max(level, to);
    if (!kept.has(a.seat)) return;
    if (a.kind === "check") { maybeCut(a.seat); emit(a.seat, "X"); return; }
    // FIRST, WITHOUT CUTTING: an action that puts nothing more in the tree, or only an incomplete increment, is
    // settled in the round as it stands (stress-500 brief_I-003: the BB's last call of a 7 increment had cut the
    // street and wiped the line to "BB X") — a cut is for a wager the closed round cannot hold
    // a layer [at - amt, at]: his share is the part of it his chips reach — all of it past `at`, part of it for an
    // all-in that ends inside it (review 4: all-or-nothing left such an all-in above the level its callers showed)
    const share = (L: { at: number; amt: number }) => Math.max(0, Math.min(to, L.at) - (L.at - L.amt));
    const layerAdd = (): number => layers.reduce((s2, L) => s2 + (!L.done.has(a.seat) ? share(L) : 0), 0);
    const takeLayers = () => { for (const L of layers) if (!L.done.has(a.seat) && share(L) > 0.005) { preload[a.seat] = r((preload[a.seat] ?? 0) + share(L)); L.done.add(a.seat); } };
    {
      const rel0 = r(to - (preload[a.seat] ?? 0) - layerAdd());
      const mineT = treePut.get(a.seat) ?? 0;
      // a call that puts nothing more in the tree (its level is what he has in: an increment moved): a check when he
      // has not acted this round, nothing when he has
      // (or, under a `startBase`, a wager that does not reach past it: his chips are in the starting pot already)
      if (rel0 <= mineT + 0.005 && (a.kind === "call" || a.kind === "allin" || a.kind === "raise")) {
        takeLayers();
        if (!actedSince.has(a.seat)) emit(a.seat, "X");
        return;
      }
      if (rel0 > treeLevel + 0.005 && rel0 < cap(a.seat) - layerAdd() - 0.005 && rel0 - treeLevel < lastInc - 0.005) {
        // no legal raise in the tree (an incomplete all-in raise taken over, or a raise its increment no longer
        // reaches): he calls the tree's level, the rest into the starting pot
        takeLayers();
        const amt = r(rel0 - treeLevel);
        preload[a.seat] = r((preload[a.seat] ?? 0) + amt); shifts++;
        layers.push({ at: to, amt, done: new Set([a.seat]) });
        // in the tree: a call of its level, a check when there is nothing to call and he has not acted this round
        if (mineT < treeLevel - 0.005) { emit(a.seat, "C"); treePut.set(a.seat, treeLevel); }
        else if (!actedSince.has(a.seat)) emit(a.seat, "X");
        return;
      }
    }
    maybeCut(a.seat);
    takeLayers();
    // his chips in the tree: his total on the street less what a cut or an incomplete raise put in the pot for him
    const rel = r(to - (preload[a.seat] ?? 0));
    if (a.kind === "call" && rel > treeLevel + 0.005) {
      // the level he called was a dropped seat's: in the tree it is his own wager (his all-in when it is his stack)
      emit(a.seat, rel >= cap(a.seat) - 0.005 ? "RAI" : `R${rel}`); tookOver.push(a.seat);
      lastInc = Math.max(lastInc, r(rel - treeLevel));
      treePut.set(a.seat, rel); treeLevel = rel; actedSince = new Set([a.seat]); return;
    }
    if (rel <= (treePut.get(a.seat) ?? 0) + 0.005 && (a.kind === "call" || a.kind === "allin")) {
      if (!actedSince.has(a.seat)) emit(a.seat, "X");
      return;
    }
    // after a cut the tree counts from the cut's level: a wager's amount is re-expressed (an all-in included) — but an
    // all-in that does not reach the level is a CALL for less (review 3, 2026-10-05: "R7" over a 45 threw in the walk)
    const allInCall = a.kind === "allin" && rel <= treeLevel + 0.005;
    const moved = (preload[a.seat] ?? 0) > 0;
    emit(a.seat, allInCall && (base > 0 || moved) ? "C"
      : (base > 0 || moved) && a.kind !== "call" ? (rel >= cap(a.seat) - 0.005 ? "RAI" : `R${rel}`) : toks[i]!);
    treePut.set(a.seat, rel);
    if (rel > treeLevel + 0.005) { lastInc = Math.max(lastInc, r(rel - treeLevel)); treeLevel = rel; actedSince = new Set([a.seat]); }
  });
  return { toks: out, seats, tookOver, preload, cuts, shifts, closed: false, lostFold };
}

/**
 * CAN THE WALK PLAY THESE STREETS (2026-10-05, stress-500 brief_D-001): every street legal in the rotation of the
 * walk's seats — each token by the seat whose turn it is, no check facing a bet, no raise under the level — and CLOSED
 * at its end; a seat all in stays out of later streets. `capAt(i)` = each seat's stack entering street i. The reason
 * when not, else null. (A coverGroups walk whose dropped seats were ALL IN on an earlier street — "HJ jams 9.18, BTN
 * calls, SB raises 28.33…" without HJ and SB — loses the levels the kept seats called, and its street closed early:
 * "street closed but more actions follow" on a hand that is fine.) `endsWith`: the last street is a decision street —
 * open, that seat to act (a dead-money plan's current street).
 */
export function walkPlays(order: readonly string[], keep: readonly string[], streets: string[][], seats: string[][],
    capAt: (i: number) => (p: string) => number | null | undefined, endsWith?: string): string | null {
  const rot = order.filter((p) => keep.includes(p));
  const out = new Set<string>(), allIn = new Set<string>();
  for (let i = 0; i < streets.length; i++) {
    const cap = (p: string) => capAt(i)(p) ?? Infinity;
    const put: Record<string, number> = {};
    let level = 0, acted = new Set<string>(), at = 0, lastInc = 1;
    const next = (k0: number) => { for (let k = 0; k < rot.length; k++) { const p = rot[(k0 + k) % rot.length]!; if (!out.has(p) && !allIn.has(p)) return { p, k: (k0 + k) % rot.length }; } return null; };
    const live = () => rot.filter((p) => !out.has(p) && !allIn.has(p));
    const closed = () => live().every((p) => acted.has(p) && (put[p] ?? 0) >= level - 0.005);
    const toks = streets[i]!, who = seats[i]!;
    for (let j = 0; j < toks.length; j++) {
      const t = toks[j]!, p = who[j]!;
      if (j > 0 && closed()) return `street ${i}: closed before ${p}:${t}`;
      const nx = next(at);
      if (!nx || nx.p !== p) return `street ${i}: ${p}:${t} out of turn (${nx?.p ?? "nobody"} to act)`;
      const mine = put[p] ?? 0;
      if (t === "F") out.add(p);
      else if (t === "X") { if (level > mine + 0.005) return `street ${i}: ${p} checks facing a bet`; }
      else {
        // cap(p) = his stack entering the street = all he can have in on it
        const to = t === "C" ? Math.min(level, cap(p)) : t === "RAI" ? cap(p) : Math.min(parseFloat(t.slice(1)), cap(p));
        if (t !== "C" && to <= level + 0.005 && to < cap(p) - 0.005) return `street ${i}: ${p}:${t} is no raise over ${level}`;
        // GTO Wizard's minimum raise: the last increment (a bet: 1bb), unless it is the seat's all-in
        if (t !== "C" && to > level + 0.005 && to < cap(p) - 0.005 && to - level < lastInc - 0.005) return `street ${i}: ${p}:${t} raises by less than the minimum (${lastInc})`;
        if (to < mine - 0.005) return `street ${i}: ${p}:${t} takes chips back`;
        put[p] = to;
        if (to > level + 0.005) { if (to - level >= lastInc - 0.005) lastInc = to - level; level = to; acted = new Set(); }
        if (to >= cap(p) - 0.005) allIn.add(p);
      }
      acted.add(p); at = nx.k + 1;
    }
    if (endsWith != null && i === streets.length - 1) {
      // the decision street: still open, and the seat to act is the one deciding
      if (toks.length && closed()) return `street ${i}: closed before ${endsWith}'s decision`;
      const nx = next(at);
      if (!nx || nx.p !== endsWith) return `street ${i}: ${nx?.p ?? "nobody"} is to act, not ${endsWith}`;
      continue;
    }
    if (rot.filter((p) => !out.has(p)).length >= 2 && live().length >= 1 && !closed()) return `street ${i}: does not close`;
  }
  return null;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export interface DeadMoneyArgs {
  /** the seats still in entering this street, in postflop order, with their ranges entering it */
  seats: CollapseSeat[];
  heroPos: string;
  /** this street's tokens up to hero's node */
  street: SeatTok[];
  /** the table's all-in amounts beside the tokens */
  amounts?: (number | null)[] | null;
  /** each seat's stack behind entering this street (null = unknown) */
  behind: (pos: string) => number | null | undefined;
  /** the most plans to return (each is a cloud walk) */
  max?: number;
}

/** Every dead-money collapse of the street to at most three seats, best first; `why` when there is none. */
export function planDeadMoney(a: DeadMoneyArgs): { plans: DeadMoneyPlan[]; why: string | null } {
  const max = a.max ?? 3;
  const toks = a.street.map((t) => t.tok), who = a.street.map((t) => t.seat);
  const unpriced: number[] = [];
  const acts = streetFromTokens(toks, who, a.amounts ?? null, unpriced);
  if (unpriced.length) return { plans: [], why: "a wager on this street has no amount on the capture — the dead money cannot be priced" };
  let sc: ReturnType<typeof streetChips<string>>;
  try { sc = streetChips(acts, a.behind); } catch (e) { return { plans: [], why: `this street's money cannot be priced: ${(e as Error).message}` }; }
  const putOf = (p: string) => sc.put.get(p) ?? 0;
  if (!a.seats.some((s) => s.pos === a.heroPos)) return { plans: [], why: "hero is not among the seats" };
  if (sc.folded.has(a.heroPos)) return { plans: [], why: "hero has folded" };
  const live = a.seats.filter((s) => s.pos !== a.heroPos && !sc.folded.has(s.pos));
  if (!live.length) return { plans: [], why: "no villain is left in" };
  // THE SWITCH (experiments register): DEAD_MONEY_COLLAPSE=off turns off the multi-villain collapse — the spot is then
  // refused; heads-up after folds is the hand itself and stays on
  if (live.length > 1 && process.env.DEAD_MONEY_COLLAPSE === "off") return { plans: [], why: "the dead-money collapse is off (DEAD_MONEY_COLLAPSE=off)" };
  // the villain holding the level hero faces: the last one to wager to it
  let holder: string | null = null;
  if (sc.level > putOf(a.heroPos) + 0.005) {
    for (const x of acts) if ((x.kind === "raise" || x.kind === "allin") && x.seat !== a.heroPos && !sc.folded.has(x.seat) && putOf(x.seat) >= sc.level - 0.005) holder = x.seat;
    if (!holder) return { plans: [], why: "hero faces a wager but no villain still in holds it" };
  }
  const heroCap = (a.behind(a.heroPos) ?? Infinity) as number;
  /** what villain p can still put against hero: his chips on the street and his stack, capped at hero's */
  const risk = (p: string) => Math.min(putOf(p) + ((a.behind(p) ?? Infinity) as number), heroCap);
  const others = live.filter((s) => s.pos !== holder).sort((x, y) => risk(y.pos) - risk(x.pos));
  const need = Math.max(0, 3 - 1 - (holder ? 1 : 0));
  const picks: string[][] = others.length <= need ? [others.map((s) => s.pos)] : choose(others.map((s) => s.pos), need);
  const plans: DeadMoneyPlan[] = [];
  const tryKept = (extra: string[], startBase = 0) => {
    const kept = new Set([a.heroPos, ...(holder ? [holder] : []), ...extra]);
    const seats = a.seats.filter((s) => kept.has(s.pos));
    if (seats.length < 2) return;
    const c = contestedChips(sc.put, { contesting: [...kept], folded: sc.folded, capOf: a.behind, hero: a.heroPos });
    const deadBy: Record<string, number> = {};
    for (const s of a.seats) if (!kept.has(s.pos) && (c.bySeat.get(s.pos) ?? 0) > 0) deadBy[s.pos] = r2(c.bySeat.get(s.pos)!);
    const fixed = replayKept(acts, toks, kept, a.behind, a.seats.map((s) => s.pos), startBase);
    if (fixed.lostFold) return;
    // HERO'S PRICE MUST BE THE TABLE'S (2026-10-05): an incomplete raise moved into the pot for some seats and not for
    // hero would show him a cheaper call — such a plan is not taken (the plan keeping the incomplete raiser plays it)
    const tableCall = Math.min(sc.level, (a.behind(a.heroPos) ?? Infinity) as number) - putOf(a.heroPos);
    if (Math.abs(treeCallOf(fixed, a.heroPos, (p) => (a.behind(p) ?? Infinity) as number) - tableCall) > 0.02) return;
    // AND THE TREE CAN WALK IT (review 4): the seats in rotation, GTO Wizard's minimum raises, the street open with hero
    // to act — a plan that would not walk is never handed on (it would only cost a cloud walk and a refusal)
    const order = a.seats.map((s) => s.pos);
    const keepOrd = order.filter((p) => kept.has(p));
    if (walkPlays(order, keepOrd, [fixed.toks], [fixed.seats], () => (p) => ((a.behind(p) ?? Infinity) as number) - (fixed.preload[p] ?? 0), a.heroPos) != null) return;
    // a seat kept although he folded (the fallback below): his line is walked, fold included — the tree is not heads-up
    const keptFolder = extra.some((p) => sc.folded.has(p));
    const headsUp = live.length === 1 && !keptFolder;
    const dropped = a.seats.filter((s) => !kept.has(s.pos)).map((s) =>
      `${sc.folded.has(s.pos) ? (putOf(s.pos) > 0 ? (headsUp ? "folded" : "dead") : "fold") : putOf(s.pos) > 0 ? "dead" : "ghost"}:${s.pos}`);
    plans.push({
      kind: `${headsUp ? `heads-up: ${dropped.join(" + ")}` : dropped.join(" + ") || "exact"}${fixed.cuts ? " (street cut)" : ""}${fixed.shifts ? " (incomplete raise)" : ""}`, seats, heroIdx: seats.findIndex((s) => s.pos === a.heroPos),
      streets: [fixed.toks.map((tok, i) => ({ tok, seat: fixed.seats[i]! }))],
      steps: dropped.length, ghostOnly: false,
      dead: r2(Object.values(deadBy).reduce((s, x) => s + x, 0)), deadBy, tookOver: fixed.tookOver, headsUp,
      preload: fixed.preload, cuts: fixed.cuts,
    });
    if (startBase > 0) plans[plans.length - 1]!.kind += ` (opening ${startBase} in the pot)`;
  };
  for (const extra of picks) tryKept(extra);
  // NO PLAN PRICES HERO EXACTLY (review 4, 2026-10-05: "CO bets 1.86, SB raises 11.14, BB calls, HJ raises 20.61, CO
  // folds" — without the CO, the SB's raise is a bet of 11.14 and the HJ's legal 9.47 re-raise falls under the tree's
  // minimum; moving chips to the pot cannot fix hero's price): keep a seat that put chips in and FOLDED instead — the
  // tree plays his wager and his fold exactly as they were, and a live seat left out is dead money
  if (!plans.length) {
    const folders = a.seats.filter((s) => s.pos !== a.heroPos && s.pos !== holder && sc.folded.has(s.pos) && putOf(s.pos) > 0).map((s) => s.pos);
    const pool = [...others.map((s) => s.pos), ...folders];
    if (folders.length && need > 0) for (const extra of choose(pool, Math.min(need, pool.length))) if (extra.some((p) => folders.includes(p))) tryKept(extra);
  }
  // A CHAIN OF MIN-RAISES (review 4: "SB 1.75, BB 3.5, HJ 5.25, CO calls, BTN 7, SB and BB fold"): the kept seats'
  // raises are legal only over the dropped seats' levels. When every kept seat still in went past such a level, the
  // level goes into the pot for each of them alike (hero's price unchanged) and the kept raises keep their real
  // increments over it — the highest such level that walks
  if (!plans.length) {
    const levels = [...new Set(acts.filter((x) => (x.kind === "raise" || x.kind === "allin") && x.seat !== a.heroPos).map((x) => x.to ?? 0))]
      .filter((x) => x > 0).sort((x, y) => y - x);
    // the third seat from the live villains, else from the seats that folded with chips in (as above)
    const folders = a.seats.filter((s) => s.pos !== a.heroPos && s.pos !== holder && sc.folded.has(s.pos) && putOf(s.pos) > 0).map((s) => s.pos);
    const pool = [...others.map((s) => s.pos), ...folders];
    const sets = need > 0 ? [...picks, ...choose(pool, Math.min(need, pool.length)).filter((x) => x.some((p) => folders.includes(p)))] : picks;
    for (const L of levels) {
      for (const extra of sets) {
        const kept = [a.heroPos, ...(holder ? [holder] : []), ...extra];
        if (kept.every((p) => putOf(p) >= L - 0.005)) tryKept(extra, L);
      }
      if (plans.length) break;
    }
  }
  if (!plans.length) return { plans: [], why: "no seat set holds hero and a villain" };
  return { plans: plans.slice(0, max), why: null };
}

/** Hero's amount to call at the end of a replayed street, in the tree: the tree's level (capped at his tree stack) less
 *  his tree chips — each seat's stack less its preload, an all-in its whole tree stack. */
function treeCallOf(r: { toks: string[]; seats: string[]; preload: Record<string, number> }, hero: string, capOf: (p: string) => number): number {
  const cap = (p: string) => capOf(p) - (r.preload[p] ?? 0);
  const put: Record<string, number> = {};
  let level = 0;
  r.toks.forEach((t, i) => {
    const p = r.seats[i]!;
    if (t === "X" || t === "F") return;
    const to = t === "C" ? Math.min(level, cap(p)) : t === "RAI" ? cap(p) : Math.min(parseFloat(t.slice(1)), cap(p));
    put[p] = to; level = Math.max(level, to);
  });
  return Math.min(level, cap(hero)) - (put[hero] ?? 0);
}

/** k-subsets of xs, in xs order (xs is short: the villains still in) */
function choose(xs: string[], k: number): string[][] {
  if (k === 0) return [[]];
  const out: string[][] = [];
  const rec = (start: number, acc: string[]) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < xs.length; i++) { acc.push(xs[i]!); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

/** The policy: one plan answers alone, several are blended (by action class, see menuByClass). */
export function pickDeadMoney(plans: DeadMoneyPlan[]): Picked | null {
  if (!plans.length) return null;
  if (plans.length === 1) {
    const p = plans[0]!;
    if (p.headsUp) return { plans, mode: "single", why: `HEADS-UP: every other villain has folded — the tree is hero against ${p.seats.find((s) => s.pos !== p.seats[p.heroIdx]!.pos)?.pos}, the folded seats' chips on this street in the pot` };
    return { plans, mode: "single", why: p.steps ? `${p.kind}: the seats left are the tree, the dropped seats' chips on this street dead money` : "the seats left are the tree" };
  }
  return { plans, mode: "blend", why: `${plans.length} dead-money collapses blended, each keeping hero, the wager hero faces and a different villain still in (fold at the most folding one's frequency, wager at the least wagering one's)` };
}

/**
 * THE MENUS OF DEAD-MONEY TREES DIFFER (each tree's pot and stacks are its own, so its sizes and its all-in are): an
 * action is re-expressed on the reference menu BY CLASS — fold to fold, check to check, call to call, an ALL-IN to the
 * reference's all-in, any other wager to the reference's non-all-in wager nearest in size (the reference's all-in only
 * when it has no other). Returns each action's reference code; null when the reference has nothing of that class.
 * Review 2026-10-05: keying the all-in on "the biggest wager" mapped a tree's plain R20 onto the reference's shove.
 */
export interface MenuAction { code: string; allIn: boolean }
export const menuAction = (code: string, displayName?: string | null): MenuAction =>
  ({ code, allIn: code === "RAI" || /all[ -]?in/i.test(String(displayName ?? "")) });
export function menuByClass(ref: MenuAction[], mine: MenuAction[]): (string | null)[] {
  const size = (c: string) => { const m = /^[BR]([\d.]+)$/.exec(c); return m ? parseFloat(m[1]!) : NaN; };
  const isWager = (x: MenuAction) => x.allIn || /^(B|R)/.test(x.code);
  const refAllIn = ref.find((x) => x.allIn)?.code ?? null;
  const refSized = ref.filter((x) => isWager(x) && !x.allIn).map((x) => x.code);
  return mine.map((x) => {
    if (!isWager(x)) return ref.some((r) => r.code === x.code) ? x.code : null;
    if (x.allIn) return refAllIn ?? (refSized.length ? refSized.reduce((b, c) => (size(c) > size(b) ? c : b)) : null);
    if (!refSized.length) return refAllIn;
    const n = size(x.code);
    return refSized.reduce((b, c) => (Math.abs(size(c) - n) < Math.abs(size(b) - n) ? c : b));
  });
}
