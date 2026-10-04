/**
 * THE LOCKED HEADS-UP TREE'S PLAN (2026-10-04) — the pure half of the preflop last resort on a NODE-LOCKED tree
 * (services/gtowAiPreflop.solveLockedLastResort; the request is scripts/_probePreflopNodeLock.ts).
 *
 * WHY. The last resort plays hero against the last raise heads-up. Until now the raiser's range there was whatever a
 * heads-up blind does: GTO Wizard ignores `players[].range` on a preflop tree, so a forced bet "with his range given"
 * read hero against any two cards. A NODELOCK does impose it: the raiser's raise is an ACTION he takes in the tree,
 * locked to his real range (raise with weight w, the passive action with 1-w), and hero's node behind it is solved
 * against exactly that range (probed: AA only → the node reports 6.0 combos; fractional weights kept).
 *
 * THE TREE, hero and the raiser only:
 *   - SEATED BY POSTFLOP ORDER: the one in position after the flop is the tree's SB (GTO Wizard's heads-up SB is the
 *     button), the other its BB. At a two-handed table the small blind is the button.
 *   - HERO POSTS THE CHIPS HE HAS IN, THE RAISER THE CHIPS HE HAD IN BEFORE HIS LAST RAISE, and the raise is listed as
 *     the raiser's first raise: hero's price and the pot he is offered are the table's.
 *   - RAISER FIRST TO ACT (he is the tree's SB): ONE lock, at the root. HERO FIRST (hero is the SB): both post hero's
 *     chips, hero's root is locked to his call of nothing for every hand, then the raiser's node behind it — two locks.
 *     (GTO Wizard gives the LARGER post to the big blind whoever sent it: a small blind posting more read 0.01 in at
 *     hero's node.) A hero with fewer chips in than the raiser had (he would have to call first) is refused.
 *   - THE POT HERO IS PRICED AT: the chips of players who FOLDED, and a blind still to act (only its post in), as the
 *     tree's `pot`. A player still in the hand by choice (a caller, a limper) is left out with his chips, and named.
 *     `dead: false` leaves the pot empty (the study's comparison).
 *
 * WHAT GTO WIZARD DOES WITH ODD POSTS (probed 2026-10-04, scripts/_probeNodeLockStageA.ts `units` `cap` `levels`
 * `potante` `rakecap`), and what the plan does about it:
 *   - THE LARGER POST UNDER 1 IS RESCALED TO 1, THE STACKS ARE NOT: posts 0.01/0.5 played as 0.02/1, posts 0.25/0.25 as
 *     1/1 (the small blind's "call" of an even post put him at 1). So hero's post — the larger one: he has at least as
 *     much in as the raiser had, or he is the big blind — is never under 1.
 *   - THE 250BB PREFLOP LIMIT IS COUNTED IN THE LARGER POST (stacks 600 over a post of 3: accepted; a penny each at
 *     100 deep: refused). So hero's post is never under the effective stack / LOCK_UNIT_STACKS.
 *   - Both are met by the SHIFT `d`: hero posts d more than he has in, both stacks are d deeper and the raise is d
 *     higher, and the pot is 2d smaller. Hero's price, the pot he is offered and both stacks behind are the table's; the
 *     raiser's own post is inside his raise and changes nothing hero sees. A pot too small to give the 2d back is said
 *     (`potOver`: the tree's pot is that much bigger than the table's).
 *   - `pot` IS AN ANTE PAID FROM CHIPS GTO WIZARD ADDS: a stack of 100 with a pot of 2 reads 101 but 100 is all that can
 *     be bet (a raiser of 4.2 with a pot of 0.4 shoves to 4). So the stacks sent are the table's, and with a pot the
 *     all-in is never flagged (the largest raise is the shove).
 *   - "<N>bb" IS N OF THE LARGEST POST (6bb over 0.5/3 is R18; 13bb over 2.6/1 is R33.8; on a straddled 0.5/1/2 table
 *     6bb is R12); "<N>x" is N times the bet faced. Stacks, posts, `pot` and the rake cap are in our units. The tree's
 *     sizes go through gtowAiPreflop.sizeTo with `unit` (hero's post, the largest), and the raiser's node must name the
 *     raise at its amount or the tree is not used.
 */
import type { ParsedAction, ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";
import { allInCalls } from "../../feed/buildSolutionUrl/buildSolutionUrl";
import { dealtBySeat } from "../archivedHand/archivedHand";
import { dealtCount } from "../dealtSeats/dealtSeats";

/** Postflop acting order, first to last: the later of two players is in position. */
const POSTFLOP = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];
/** Hero's post (the larger) must be at least the effective stack over this (GTO Wizard refuses past 250 of it). */
export const LOCK_UNIT_STACKS = 240;
/** A seat with nothing in posts this (a post of 0 is refused: "Invalid Total Pot"). */
export const PENNY = 0.01;

export type TreeSeat = "SB" | "BB";
export interface LockedPlan {
  ok: true;
  heroSeat: number; raiserSeat: number;
  /** table positions */
  heroPos: string; raiserPos: string;
  /** which tree seat each one is */
  heroTree: TreeSeat; raiserTree: TreeSeat;
  /** hero acts first in the tree (he is the SB): two locks (his check, then the raise) */
  heroFirst: boolean;
  /** the table's chips: hero's in, the raiser's before his last raise, the raise-to total */
  heroIn: number; raiserIn: number; raiseTo: number;
  /** index of the last raise in hand.actions (what the exact tree's reads cut at) */
  raiseIndex: number;
  /** how many raises the table's line has up to and including the last one (1 = an open) */
  raiseLevel: number;
  raiserAllIn: boolean;
  /** the tree's own numbers (the shift applied) */
  posts: Record<TreeSeat, number>;
  stacks: Record<TreeSeat, number>;
  pot: number;
  raiseToTree: number;
  shift: number;
  /** the larger post: the unit a "<N>bb" size is counted in */
  unit: number;
  /** the chips the rule makes dead (folded players' + blinds still to act), and what the tree's pot over-states when
   *  the shift could not be taken back out of it */
  deadBb: number;
  potOver: number;
  /** the players left out: folded (their chips dead), still in by choice (left out with their chips), blinds to act */
  foldedPos: string[]; livePos: string[]; blindsBehindPos: string[]; toActPos: string[];
}
export type LockedPlanOutcome = LockedPlan | { ok: false; reason: string };

const r2 = (x: number) => Math.round(x * 100) / 100;

export function planLockedHeadsUp(hand: ParsedHand, heroPosIn: string | null, opts: { dead?: boolean } = {}): LockedPlanOutcome {
  const no = (reason: string): LockedPlanOutcome => ({ ok: false, reason: `locked tree: ${reason}` });
  const seatOf = (a: ParsedAction) => (a.hero ? hand.heroSeatId : a.seatId);
  const posOf = (seat: number): string | null =>
    (seat === hand.heroSeatId ? heroPosIn ?? hand.positions[seat] : hand.positions[seat])?.toUpperCase() ?? null;
  const heroPos = posOf(hand.heroSeatId);
  if (!heroPos) return no("hero's seat is not known");
  const acts = hand.actions;
  const calls = allInCalls(acts);
  const isRaise = (a: ParsedAction) => a.street === "preflop" && (a.type === "raise" || a.type === "bet" || (a.type === "all-in" && !calls.has(a)));
  let raiseIndex = -1;
  acts.forEach((a, i) => { if (isRaise(a)) raiseIndex = i; });
  if (raiseIndex < 0) return no("nobody has raised");
  const raise = acts[raiseIndex]!;
  const raiserSeat = seatOf(raise);
  if (raiserSeat === hand.heroSeatId) return no("the last raise is hero's own");
  if (acts.some((a, i) => i > raiseIndex && a.street === "preflop" && seatOf(a) === hand.heroSeatId)) return no("hero has acted since the last raise");
  const raiserPos = posOf(raiserSeat);
  if (!raiserPos) return no("the raiser's seat is not known");
  const raiseLevel = acts.slice(0, raiseIndex + 1).filter(isRaise).length;

  // every seat's chips, before the raise and now (a post / raise / bet / all-in is the seat's total; a call adds)
  const putIn = (upTo: number): Map<number, number> => {
    const m = new Map<number, number>();
    acts.slice(0, upTo).forEach((a) => {
      if (a.street !== "preflop") return;
      const amt = Number(a.amount ?? 0);
      if (!Number.isFinite(amt) || amt <= 0) return;
      const s = seatOf(a);
      if (a.type === "call") m.set(s, (m.get(s) ?? 0) + amt);
      else if (a.type === "post-sb" || a.type === "post-bb" || a.type === "raise" || a.type === "bet" || a.type === "all-in") m.set(s, Math.max(m.get(s) ?? 0, amt));
    });
    return m;
  };
  const before = putIn(raiseIndex);
  const now = putIn(acts.length);
  const heroIn = r2(now.get(hand.heroSeatId) ?? 0);
  const raiserIn = r2(before.get(raiserSeat) ?? 0);
  const raiseTo = r2(now.get(raiserSeat) ?? Number(raise.amount ?? 0));
  if (!(raiseTo > heroIn)) return no(`the raise to ${raiseTo}bb is not more than hero's ${heroIn}bb`);

  // the others: folded (dead), a blind with only its post (still to act: dead), anyone else with chips (live, left out)
  const others = [...new Set([...Object.keys(hand.positions).map(Number), ...acts.filter((a) => a.street === "preflop").map(seatOf)])]
    .filter((s) => s !== hand.heroSeatId && s !== raiserSeat);
  const foldedPos: string[] = [], livePos: string[] = [], blindsBehindPos: string[] = [], toActPos: string[] = [];
  let deadBb = 0;
  for (const s of others) {
    const mine = acts.filter((a) => a.street === "preflop" && seatOf(a) === s);
    const p = posOf(s) ?? `seat ${s}`;
    const chips = now.get(s) ?? 0;
    if (mine.some((a) => a.type === "fold")) { foldedPos.push(p); deadBb += chips; continue; }
    const voluntary = mine.filter((a) => !/^post/.test(a.type));
    if (!voluntary.length) {
      if (chips > 0) { blindsBehindPos.push(p); deadBb += chips; }
      else if (hand.liveSeats?.includes(s) !== false) toActPos.push(p);
      continue;
    }
    livePos.push(p);
  }
  deadBb = r2(deadBb);

  // seating: postflop order; heads-up the small blind is the button
  const headsUp = dealtCount(hand, heroPosIn) <= 2;
  const ipIndex = (p: string) => (headsUp ? (p === "SB" || p === "BTN" ? 1 : 0) : POSTFLOP.indexOf(p));
  if (!headsUp && (ipIndex(heroPos) < 0 || ipIndex(raiserPos) < 0)) return no(`positions outside the 6-max set (${heroPos}, ${raiserPos})`);
  const heroIP = ipIndex(heroPos) > ipIndex(raiserPos);
  const heroTree: TreeSeat = heroIP ? "SB" : "BB";
  const raiserTree: TreeSeat = heroIP ? "BB" : "SB";
  const heroFirst = heroTree === "SB";
  if (heroFirst && heroIn + 1e-9 < raiserIn) return no(`hero acts first in the tree with less in (${heroIn}bb) than the raiser had (${raiserIn}bb) — he would have to call first`);

  const dealt = dealtBySeat(hand);
  const heroStack = dealt[hand.heroSeatId], raiserStack = dealt[raiserSeat];
  if (!(heroStack! > 0) || !(raiserStack! > 0)) return no("a stack as dealt is not known");
  const raiserAllIn = raiseTo >= raiserStack! - 0.01 || raise.type === "all-in";
  const eff = Math.min(heroStack!, raiserStack!);
  // the shift (the module header): hero's post at least 1 and at least eff / LOCK_UNIT_STACKS
  const shift = Math.max(0, Math.ceil((Math.max(1, eff / LOCK_UNIT_STACKS) - heroIn) * 100) / 100);
  const dead = opts.dead === false ? 0 : deadBb;
  const pot = r2(Math.max(0, dead - 2 * shift));
  const potOver = r2(Math.max(0, 2 * shift - dead));
  const heroPost = r2(heroIn + shift);
  // hero first (the tree's SB): the raiser posts what hero does — GTO Wizard gives the larger post to the big blind
  // whoever sent it (hero's node read 0.01 in after posts of 1/0.01), and with posts even hero's call costs nothing
  const posts = { [heroTree]: heroPost, [raiserTree]: heroFirst ? heroPost : Math.max(PENNY, Math.min(raiserIn, heroPost)) } as Record<TreeSeat, number>;
  const stacks = { [heroTree]: r2(heroStack! + shift), [raiserTree]: r2(raiserStack! + shift) } as Record<TreeSeat, number>;
  const unit = Math.max(posts.SB, posts.BB);
  return {
    ok: true, heroSeat: hand.heroSeatId, raiserSeat, heroPos, raiserPos, heroTree, raiserTree, heroFirst,
    heroIn, raiserIn, raiseTo, raiseIndex, raiseLevel, raiserAllIn,
    posts, stacks, pot, raiseToTree: r2(raiseTo + shift), shift, unit, deadBb, potOver,
    foldedPos, livePos, blindsBehindPos, toActPos,
  };
}
