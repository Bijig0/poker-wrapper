import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

/**
 * Hand2Note-style per-hand facts from one archived hand (wrapper hands.db
 * `data` blob, already normalized to a ParsedHand). Pure — the dashboard
 * routes aggregate these into VPIP/PFR/3Bet/WTSD, bb/100 and session tables.
 *
 * Amount semantics follow the wrapper's capture: bet/raise/all-in amounts are
 * the seat's street TOTAL ("raises to"), call amounts are the TOP-UP added.
 */

export interface HandSummary {
  heroPos: string | null;
  tableSeats: number;
  finalStreet: string;
  sawFlop: boolean;
  heroFolded: boolean;
  /** Won without showdown (every villain folded). */
  heroWonUncontested: boolean;
  wentToShowdown: boolean;
  /** Everything hero put in across the hand (bb, incl. blinds). */
  heroInvestedBb: number;
  /** Total final pot (bb, all seats). */
  potBb: number;
  /** VPIP: hero voluntarily put money in preflop (call/raise, not blinds). */
  vpip: boolean;
  /** PFR: hero raised preflop. */
  pfr: boolean;
  /** Hero raised over an existing preflop raise. */
  threeBet: boolean;
  /** Hero had the chance to 3-bet (faced a preflop raise, hadn't raised yet). */
  threeBetOpp: boolean;
  /** Any player open-limped preflop (first voluntary action a call). */
  limpedPot: boolean;
  /** Streets on which hero took a voluntary action. */
  heroStreets: string[];
}

const STREETS = ["preflop", "flop", "turn", "river"] as const;

export function summarizeHand(hand: ParsedHand, heroFoldedFlag?: boolean, heroWonFlag?: boolean): HandSummary {
  const heroPos = hand.positions[hand.heroSeatId] ?? null;
  const tableSeats = new Set([
    ...Object.keys(hand.positions).map(Number),
    ...hand.liveSeats,
    hand.heroSeatId,
  ]).size;

  // street-total replay (raise-to for wagers, top-up for calls, posts add)
  const totals: Record<string, Record<number, number>> = {};
  for (const st of STREETS) totals[st] = {};
  for (const a of hand.actions) {
    const t = totals[a.street] ?? (totals[a.street] = {});
    const amt = a.amount ?? 0;
    if (a.type === "post-sb" || a.type === "post-bb") t[a.seatId] = (t[a.seatId] ?? 0) + amt;
    else if (a.type === "call") t[a.seatId] = (t[a.seatId] ?? 0) + amt;
    else if (a.type === "bet" || a.type === "raise" || a.type === "all-in") t[a.seatId] = amt;
  }
  let potBb = 0;
  let heroInvestedBb = 0;
  for (const st of STREETS) {
    for (const [seat, v] of Object.entries(totals[st]!)) {
      potBb += v;
      if (Number(seat) === hand.heroSeatId) heroInvestedBb += v;
    }
  }

  const pre = hand.actions.filter((a) => a.street === "preflop" && a.type !== "post-sb" && a.type !== "post-bb");
  const heroPre = pre.filter((a) => a.hero);
  const vpip = heroPre.some((a) => a.type === "call" || a.type === "bet" || a.type === "raise" || a.type === "all-in");
  const pfr = heroPre.some((a) => a.type === "raise" || a.type === "bet" || a.type === "all-in");
  let raisesBeforeHero = 0;
  let threeBet = false;
  let threeBetOpp = false;
  for (const a of pre) {
    if (a.hero) {
      if (raisesBeforeHero >= 1) {
        threeBetOpp = true;
        if (a.type === "raise" || a.type === "all-in") threeBet = true;
      }
    }
    if (!a.hero && (a.type === "raise" || a.type === "bet" || a.type === "all-in")) raisesBeforeHero++;
  }
  const firstVoluntary = pre.find((a) => a.type !== "fold");
  const limpedPot = firstVoluntary?.type === "call";

  const heroFolded = heroFoldedFlag ?? hand.actions.some((a) => a.hero && a.type === "fold");
  const folded = new Set(hand.actions.filter((a) => a.type === "fold").map((a) => (a.hero ? -1 : a.seatId)));
  const villains = hand.liveSeats.filter((s) => s !== hand.heroSeatId);
  const heroWonUncontested =
    heroWonFlag ?? (!heroFolded && villains.length > 0 && villains.every((s) => folded.has(s)));

  const sawFlop = hand.board.length >= 3 && !heroFoldedBefore(hand, "flop");
  // NOTE: no `hand.ended` condition — the wrapper archives showdown hands
  // with ended=false (its flag means folded-or-uncontested, not hand-over).
  const wentToShowdown = hand.board.length >= 5 && !heroFolded && !heroWonUncontested;

  return {
    heroPos,
    tableSeats,
    finalStreet: hand.street,
    sawFlop,
    heroFolded,
    heroWonUncontested,
    wentToShowdown,
    heroInvestedBb: Math.round(heroInvestedBb * 100) / 100,
    potBb: Math.round(potBb * 100) / 100,
    vpip,
    pfr,
    threeBet,
    threeBetOpp,
    limpedPot,
    heroStreets: STREETS.filter((st) =>
      hand.actions.some((a) => a.hero && a.street === st && a.type !== "post-sb" && a.type !== "post-bb")
    ),
  };
}

/** Did hero fold strictly before reaching `street`? */
function heroFoldedBefore(hand: ParsedHand, street: (typeof STREETS)[number]): boolean {
  const target = STREETS.indexOf(street);
  return hand.actions.some(
    (a) => a.hero && a.type === "fold" && STREETS.indexOf(a.street as (typeof STREETS)[number]) < target
  );
}
