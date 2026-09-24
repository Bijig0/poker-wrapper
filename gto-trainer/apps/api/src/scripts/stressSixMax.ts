/**
 * stressSixMax — can the Ignition NL200 6-max ring strategy actually answer the hard spots?
 *
 * WHY (2026-09-21, Brady: "stress test our current system … to ensure it's able to answer these
 * all well … I don't care how it's answered, via our charts or a mixture of GTO Wizard AI or
 * whatever, as long as we get an accurate answer for that node"). Every other harness we have
 * tests ONE piece: sixmaxBacktest walks the charts, gtowPoolCheck sends one tree, the replay
 * sweeps re-ask spots we happened to play. None of them asks the question that matters — given a
 * genuinely awkward node, does the WHOLE cascade produce a usable answer?
 *
 * So this builds synthetic tables and asks the live entry point, `fastSolve(hand, heroPos,
 * { strategyId: "ign200-ring-6max-equilibrium" })` — the same call the study poller makes. Chart,
 * AI preflop, AI postflop chain, collapse, blend, every borrow and snap: whatever the cascade does
 * for a real hand it does here, and it spends real GTO Wizard cloud solves doing it.
 *
 * THREE FAMILIES, because they fail for different reasons:
 *   limp      limped and iso-raised pots — the class the 2026-09-21 AA hand died in
 *   preflop   4-bets, 5-bets, squeezes, cold 4-bets, off-tree sizes, short/deep, thinned tables
 *   multiway  4- and 5-way postflop, where GTO Wizard's trees hold three seats and ours collapse
 *
 * GRADING. Each spot carries a COMPLEXITY score built from what actually makes a node hard for us
 * (see `complexity`) — limpers past the first, raise levels, off-tree sizes, stack spread, field
 * size, street depth. Each ANSWER is then graded:
 *
 *   clean       answered, and nothing in the chain had to approximate
 *   approx      answered, but a named approximation fired (snap past τ, caller borrow, collapse,
 *               chart fallback) — usable, and the warning says what it cost
 *   degenerate  answered, but the mix is not believable (no decision, frequencies that do not sum,
 *               hero's class missing from the tree)
 *   FAILED      no answer at all — the list Brady asked for
 *
 * The distinction between `approx` and `FAILED` is the whole point: an approximation we can name
 * and price is fine, a silent hole is not.
 *
 * IT DRIVES THE RUNNING API, not an in-process fastSolve. Two reasons, and the first one bit:
 * GTO Wizard's DevTools endpoint serves ONE client at a time, so a second process sniffing for a
 * token fights the API's own keeper and loses — the first run of this harness recorded two
 * failures that were only "primary: no token". Going through POST /api/fast-solver also means the
 * spots take exactly the path a live decision takes, warm token pool and all.
 *
 *   bun src/scripts/stressSixMax.ts                     # everything
 *   bun src/scripts/stressSixMax.ts --only limp         # one family
 *   bun src/scripts/stressSixMax.ts --id multi-15       # one spot (or a comma-separated list)
 *   bun src/scripts/stressSixMax.ts --out stress.json   # machine-readable too
 *   bun src/scripts/stressSixMax.ts --api http://127.0.0.1:2000
 */
import { writeFileSync } from "node:fs";
import type { FastSolveResult } from "../services/fastSolve";
import type { ParsedHand, ParsedAction, Street } from "../feed/parsePanelFeed/parsePanelFeed";

const STRATEGY = "ign200-ring-6max-equilibrium";
const ORDER = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
type Pos = (typeof ORDER)[number];

const arg = (k: string, d?: string) => { const i = Bun.argv.indexOf(k); return i >= 0 ? Bun.argv[i + 1] : d; };

// --------------------------------------------------------------------------- the spec

/** f = fold · c = call/complete · x = check · r = raise/bet TO this total (bb, street-relative) */
type Act = [Pos, "f" | "c" | "x" | "r", number?];

interface SpotSpec {
  id: string;
  family: "limp" | "preflop" | "multiway" | "esoteric";
  /** what makes this one hard — printed next to the grade */
  note: string;
  /** every seat dealt in, with its starting stack in bb; seats omitted are not at the table */
  stacks: Partial<Record<Pos, number>>;
  hero: Pos;
  cards: [string, string];
  /** preflop actions after the blinds, in order */
  pre: Act[];
  /** flop / turn / river cards, when the spot is postflop */
  board?: string[];
  /** postflop actions per street, in order, up to hero's pending decision */
  flop?: Act[];
  turn?: Act[];
  river?: Act[];
}

// --------------------------------------------------------------------------- the table

/**
 * Build the ParsedHand the live path would have seen.
 *
 * The two fields worth getting right, because everything downstream reads them: `committed` is
 * what a seat has put in ON THE CURRENT STREET and `stacks` is what it has BEHIND — the AI preflop
 * shape adds them back together to recover the starting stack, and the chart picker reads stacks as
 * dealt. A raise's `amount` is the TOTAL it makes it, a call's is the INCREMENT, which is what
 * buildPreflopTokens and lineOf both expect.
 */
function buildHand(s: SpotSpec): { hand: ParsedHand; heroPos: Pos } {
  // A FIXTURE THAT DEALS ONE CARD TWICE IS A BUG IN THIS FILE, NOT A SPOT (2026-09-24, multi-07): the API now
  // refuses it as a capture fault, but that reads like a strategy hole in the report. Fail loudly here first.
  {
    const dealt = [s.cards[0], s.cards[1], ...(s.board ?? [])];
    const twice = dealt.find((c, i) => dealt.indexOf(c) !== i);
    if (twice) throw new Error(`${s.id}: fixture deals ${twice} twice (hero ${s.cards.join("")}, board ${(s.board ?? []).join(" ") || "none"})`);
  }
  const seats = ORDER.filter((p) => s.stacks[p] != null);
  const seatId: Record<string, number> = {};
  seats.forEach((p, i) => { seatId[p] = i + 1; });
  const positions: Record<number, string> = {};
  for (const p of seats) positions[seatId[p]!] = p;

  const behind: Record<number, number> = {};
  for (const p of seats) behind[seatId[p]!] = s.stacks[p]!;
  const actions: ParsedAction[] = [];
  const folded = new Set<number>();
  const potByStreet: Partial<Record<Street, number>> = {};

  // --- blinds ---
  const post = (p: Pos, type: "post-sb" | "post-bb", amt: number) => {
    const id = seatId[p];
    if (id == null) return;
    behind[id]! -= amt;
    actions.push({ seatId: id, hero: p === s.hero, type, amount: amt, street: "preflop" });
  };
  let invested: Record<number, number> = {};
  const put = (id: number, amt: number) => { invested[id] = (invested[id] ?? 0) + amt; };
  if (seatId.SB != null) { post("SB", "post-sb", 0.5); put(seatId.SB, 0.5); }
  if (seatId.BB != null) { post("BB", "post-bb", 1); put(seatId.BB, 1); }

  // --- one street of action ---
  const play = (street: Street, acts: Act[]) => {
    for (const [pos, t, to] of acts) {
      const id = seatId[pos];
      if (id == null) throw new Error(`${s.id}: ${pos} is not at the table`);
      const have = invested[id] ?? 0;
      const high = Math.max(0, ...Object.values(invested));
      if (t === "f") { folded.add(id); actions.push({ seatId: id, hero: pos === s.hero, type: "fold", street }); continue; }
      if (t === "x") { actions.push({ seatId: id, hero: pos === s.hero, type: "check", street }); continue; }
      if (t === "c") {
        const inc = Math.min(high - have, behind[id]!);
        behind[id]! -= inc; put(id, inc);
        actions.push({ seatId: id, hero: pos === s.hero, type: "call", amount: Math.round(inc * 100) / 100, street });
        continue;
      }
      const total = to!;
      const inc = Math.min(total - have, behind[id]!);
      behind[id]! -= inc; put(id, inc);
      actions.push({ seatId: id, hero: pos === s.hero, type: street === "preflop" ? "raise" : have > 0 || high > 0 ? "raise" : "bet", amount: total, street });
    }
  };

  play("preflop", s.pre);
  let street: Street = "preflop";
  if (s.board?.length) {
    potByStreet.preflop = Object.values(invested).reduce((a, b) => a + b, 0);
    invested = {};
    street = "flop";
    if (s.flop) play("flop", s.flop);
    if ((s.board.length >= 4)) {
      potByStreet.flop = (potByStreet.flop ?? 0) + Object.values(invested).reduce((a, b) => a + b, 0);
      invested = {}; street = "turn";
      if (s.turn) play("turn", s.turn);
    }
    if (s.board.length >= 5) {
      potByStreet.turn = (potByStreet.turn ?? 0) + Object.values(invested).reduce((a, b) => a + b, 0);
      invested = {}; street = "river";
      if (s.river) play("river", s.river);
    }
  }

  const streetIn = Object.values(invested).reduce((a, b) => a + b, 0);
  const priorPot = Object.values(potByStreet).reduce((a, b) => a + (b ?? 0), 0);
  const heroId = seatId[s.hero]!;
  const high = Math.max(0, ...Object.values(invested));
  const committed: Record<number, number> = {};
  for (const p of seats) committed[seatId[p]!] = invested[seatId[p]!] ?? 0;

  const hand: ParsedHand = {
    handId: 1,
    clientHandId: `stress-${s.id}`,
    bbCents: 200,
    heroSeatId: heroId,
    heroCards: [s.cards[0], s.cards[1]],
    board: s.board ?? [],
    street,
    actions,
    liveSeats: seats.map((p) => seatId[p]!).filter((id) => !folded.has(id)),
    committed,
    potByStreet,
    positions,
    stacks: behind,
    currentNode: {
      street,
      toActSeatId: heroId,
      toActIsHero: true,
      pot: Math.round((priorPot + streetIn) * 100) / 100,
      toCall: Math.round(Math.max(0, high - (invested[heroId] ?? 0)) * 100) / 100,
      legalActions: [],
      complete: false,
    },
    ended: false,
  };
  return { hand, heroPos: s.hero };
}

// --------------------------------------------------------------------------- complexity

const ON_TREE_OPENS = [2, 2.2, 2.5, 3, 3.5, 4, 5];

/**
 * How hard this node is FOR US — not how hard it is to play.
 *
 * Every term is a thing that has actually cost us an answer: limpers past the first (GTO Wizard's
 * tree stops at one, ours at two), raise depth (4-bet and 5-bet nodes are the thin end of every
 * tree), sizes off the solved menu, stack spread and extremes (the uneven set and the ladder ends),
 * field size postflop (three is all a GTOW tree holds), and street depth (each one is another
 * cloud solve that has to land in time).
 */
function complexity(s: SpotSpec): { score: number; band: string; drivers: string[] } {
  const d: string[] = [];
  let n = 0;
  const seats = ORDER.filter((p) => s.stacks[p] != null);
  if (seats.length < 6) { n += 6 - seats.length; d.push(`${seats.length}-handed`); }

  const limps = s.pre.filter(([p, t], i) =>
    t === "c" && p !== "SB" && p !== "BB" && !s.pre.slice(0, i).some(([, tt]) => tt === "r")).length;
  if (limps >= 1) { n += 1; d.push(`${limps} limper${limps === 1 ? "" : "s"}`); }
  if (limps >= 2) { n += 2 * (limps - 1); d.push("past GTOW's one-limper ceiling"); }

  const raises = s.pre.filter(([, t]) => t === "r");
  if (raises.length >= 2) { n += 2 * (raises.length - 1); d.push(`${raises.length} raises (to the ${["", "", "3-bet", "4-bet", "5-bet", "6-bet"][raises.length] ?? "nth"})`); }
  const offTree = raises.filter(([, , to], i) => i === 0 && to != null && !ON_TREE_OPENS.includes(to));
  if (offTree.length) { n += 2; d.push(`off-menu open ${offTree[0]![2]}x`); }

  const stacks = seats.map((p) => s.stacks[p]!);
  const spread = Math.max(...stacks) - Math.min(...stacks);
  if (spread >= 25) { n += 2; d.push(`stack spread ${spread}bb`); }
  if (Math.min(...stacks) < 40) { n += 2; d.push(`${Math.min(...stacks)}bb short stack`); }
  if (Math.max(...stacks) > 150) { n += 2; d.push(`${Math.max(...stacks)}bb — past the ladder`); }

  if (s.board?.length) {
    const live = seats.length - s.pre.filter(([, t]) => t === "f").length;
    if (live >= 4) { n += (live - 3) * 3; d.push(`${live}-way flop`); }
    const streets = s.board.length - 2;
    if (streets > 1) { n += streets - 1; d.push(`${["", "flop", "turn", "river"][streets]}`); }
    const postRaises = [...(s.flop ?? []), ...(s.turn ?? []), ...(s.river ?? [])].filter(([, t]) => t === "r").length;
    if (postRaises >= 2) { n += 2; d.push("raised postflop"); }
  }
  const band = n <= 3 ? "routine" : n <= 6 ? "awkward" : n <= 10 ? "hard" : "brutal";
  return { score: n, band, drivers: d };
}

// --------------------------------------------------------------------------- the spots

const S: SpotSpec[] = [
  // ======================= LIMPED AND ISO-RAISED POTS =======================
  { id: "limp-01", family: "limp", note: "one limper, hero isolates, BB 3-bets him",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ah", "Qd"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "r", 4], ["BTN", "f"], ["SB", "f"], ["BB", "r", 13], ["UTG", "f"]] },

  { id: "limp-02", family: "limp", note: "TWO limpers in front — past GTO Wizard's tree, inside ours",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ks", "Js"],
    pre: [["UTG", "c"], ["HJ", "c"]] },

  { id: "limp-03", family: "limp", note: "THREE limpers — past our own limp tree too",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ad", "Ts"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"]] },

  { id: "limp-04", family: "limp", note: "THE 2026-09-21 hand: limp-limp, hero isos, a limper 3-bets to 21",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["As", "Ah"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 4], ["BTN", "f"], ["SB", "f"], ["BB", "f"], ["UTG", "c"], ["HJ", "r", 21]] },

  { id: "limp-05", family: "limp", note: "four limpers to hero in the BB with the option",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Qc", "9c"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "c"]] },

  { id: "limp-06", family: "limp", note: "limp, iso, squeeze — hero in the SB behind all three",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Ah", "Ks"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "r", 3.5], ["BTN", "r", 12]] },

  { id: "limp-07", family: "limp", note: "limp-3-bet: hero raises over a limp, the limper comes back over the top",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "HJ", cards: ["Kd", "Kc"],
    pre: [["UTG", "c"], ["HJ", "r", 3], ["CO", "f"], ["BTN", "c"], ["SB", "f"], ["BB", "f"], ["UTG", "r", 14]] },

  { id: "limp-08", family: "limp", note: "SB completes into hero's BB option — two limpers already in",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["7h", "2d"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "f"], ["BTN", "c"], ["SB", "c"]] },

  { id: "limp-09", family: "limp", note: "limped pot at 40bb — a short rung AND a limp tree",
    stacks: { UTG: 40, HJ: 40, CO: 40, BTN: 40, SB: 40, BB: 40 }, hero: "BTN", cards: ["Ac", "8c"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "f"]] },

  { id: "limp-10", family: "limp", note: "limped pot at 150bb — the top of the ladder, where limp trees stop",
    stacks: { UTG: 150, HJ: 150, CO: 150, BTN: 150, SB: 150, BB: 150 }, hero: "SB", cards: ["Js", "Jd"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "f"], ["BTN", "f"]] },

  { id: "limp-11", family: "limp", note: "off-menu iso size (5.5x) over a limp",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ac", "Jh"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "f"], ["BTN", "r", 5.5], ["SB", "f"]] },

  { id: "limp-12", family: "limp", note: "two limpers, a raise, and a cold 4-bet to 20 — hero in the BB",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Kh", "Kd"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "f"], ["BTN", "r", 6], ["SB", "r", 20]] },

  { id: "limp-13", family: "limp", note: "limped pot at uneven stacks — the uneven set has no limp tree",
    stacks: { UTG: 30, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Td", "Th"],
    pre: [["UTG", "c"], ["HJ", "c"]] },

  { id: "limp-14", family: "limp", note: "limper jams over hero's iso for 38bb",
    stacks: { UTG: 38, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Qs", "Qh"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "f"], ["BTN", "r", 4], ["SB", "f"], ["BB", "f"], ["UTG", "r", 38]] },

  // THE MISATTRIBUTION PROBE (2026-09-22). In the limp chart's post-iso rotation a CALL skips the seats
  // between the caller and the limpers, so at "C-C-R5-F-C" the tree names UTG as the actor when the table
  // says BB. Hero here IS the BB: if the answer comes back with pos=UTG, the chart handed him another
  // seat's strategy with no warning — which is worse than a miss, and the AI preflop path guards against
  // exactly this ("the walked line puts SB on the clock, not hero") while the chart path does not.
  { id: "limp-15", family: "limp", note: "hero BB facing an iso the SB called — the chart's rotation names UTG here",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ad", "Qh"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "f"], ["SB", "c"]] },

  // Does the AI fallback cover the guarded class? It allows ONE limper, so a single-limper iso pot
  // should still get an answer even though the chart node is not hero's. Two limpers should not.
  { id: "limp-16", family: "limp", note: "ONE limper + iso the SB called, hero BB — chart rotation is wrong, can the AI cover it?",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ad", "Qh"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "r", 5], ["BTN", "f"], ["SB", "c"]] },

  // ============================ DEAD SMALL BLIND (2026-09-23, hand 732) ============================
  // The SB seat emptied between hands: five dealt, no SB post, the pot is the big blind alone. No chart has this
  // shape (is6Handed wants BTN/SB/BB), so the AI piece answers with the SB as a penny ghost — graded approx
  // ("dead SB modelled"), and the seat must be hero's. The harness builds these with no SB in `stacks`.
  { id: "deadsb-01", family: "preflop", note: "dead SB: hero HJ first in after UTG folds (hand 732, T9o)",
    stacks: { UTG: 96, HJ: 101.5, CO: 151, BTN: 100, BB: 99 }, hero: "HJ", cards: ["Ts", "9c"],
    pre: [["UTG", "f"]] },

  { id: "deadsb-02", family: "preflop", note: "dead SB: hero BB facing a BTN open — the ghost must not take a turn between BTN and BB",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, BB: 100 }, hero: "BB", cards: ["Ad", "Qh"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "f"], ["BTN", "r", 2.5]] },

  { id: "deadsb-03", family: "preflop", note: "dead SB at a 4-seat table: hero BTN first in",
    stacks: { HJ: 100, CO: 100, BTN: 100, BB: 100 }, hero: "BTN", cards: ["Kc", "8d"],
    pre: [["HJ", "f"], ["CO", "f"]] },

  // ============================ THE REFUSAL CLASS (2026-09-23) ============================
  // Lines the line fit cannot repair: every extra limper/caller raises later, or a size no limp tree can snap.
  // Before the LAST RESORT these were the only preflop blanks; now they answer heads-up vs the last aggressor.
  { id: "refuse-01", family: "esoteric", note: "three limpers who ALL raise later; hero BTN with AA facing CO's limp-5-bet jam",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ah", "Ad"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "r", 5], ["SB", "f"], ["BB", "f"], ["UTG", "r", 15], ["HJ", "r", 35], ["CO", "r", 100]] },

  { id: "refuse-02", family: "esoteric", note: "three limpers, two raise later; a 35bb 4-bet the limp tree (jam-only 4-bets) cannot snap; hero BTN QQ",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Qh", "Qd"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "r", 5], ["SB", "f"], ["BB", "f"], ["UTG", "r", 15], ["HJ", "r", 35], ["CO", "f"]] },

  { id: "refuse-03", family: "esoteric", note: "three cold-callers who all raise later; hero SB with KK facing two jams",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Kh", "Kd"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "r", 12], ["BB", "f"], ["UTG", "f"], ["HJ", "r", 30], ["CO", "r", 100], ["BTN", "r", 100]] },

  // ============================ COMPLEX PREFLOP ============================
  { id: "pre-01", family: "preflop", note: "hero faces a 4-bet",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ad", "Kd"],
    pre: [["UTG", "r", 2.5], ["HJ", "f"], ["CO", "r", 9], ["BTN", "f"], ["SB", "f"], ["BB", "f"], ["UTG", "r", 22]] },

  { id: "pre-02", family: "preflop", note: "hero faces a 5-bet jam",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Qd", "Qc"],
    pre: [["UTG", "r", 2.5], ["HJ", "f"], ["CO", "f"], ["BTN", "r", 9], ["SB", "f"], ["BB", "f"], ["UTG", "r", 22], ["BTN", "r", 50], ["UTG", "r", 100]] },

  { id: "pre-03", family: "preflop", note: "squeeze spot: open + two cold callers in front of hero",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ah", "Qs"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"]] },

  { id: "pre-04", family: "preflop", note: "THREE cold callers in front of hero — past the trees' caller cap",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["9s", "9d"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"], ["BTN", "c"]] },

  { id: "pre-05", family: "preflop", note: "cold 4-bet: hero faces an open and a 3-bet, both in front",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Ac", "Kh"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "r", 2.5], ["BTN", "r", 9]] },

  { id: "pre-06", family: "preflop", note: "off-menu open (2.7x)",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Kc", "Qh"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "f"], ["BTN", "r", 2.7], ["SB", "f"]] },

  { id: "pre-07", family: "preflop", note: "off-menu 3-bet (13.5 over a 2.5x)",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ts", "Tc"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "r", 2.5], ["BTN", "r", 13.5], ["SB", "f"], ["BB", "f"]] },

  { id: "pre-08", family: "preflop", note: "hero is 22bb — well below the busy rungs",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 22, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ah", "Jc"],
    pre: [["UTG", "r", 2.5], ["HJ", "f"], ["CO", "f"]] },

  { id: "pre-09", family: "preflop", note: "200bb — past the top of the solved ladder",
    stacks: { UTG: 200, HJ: 200, CO: 200, BTN: 200, SB: 200, BB: 200 }, hero: "BB", cards: ["As", "Kc"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "f"], ["BTN", "r", 3], ["SB", "f"]] },

  { id: "pre-10", family: "preflop", note: "three different short stacks at once",
    stacks: { UTG: 25, HJ: 40, CO: 62, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ac", "Qc"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "f"]] },

  { id: "pre-11", family: "preflop", note: "a 38bb stack jams over an open, hero behind",
    stacks: { UTG: 100, HJ: 100, CO: 38, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Qh", "Qd"],
    pre: [["UTG", "r", 2.5], ["HJ", "f"], ["CO", "r", 38]] },

  { id: "pre-12", family: "preflop", note: "a jam AND a caller in front of hero",
    stacks: { UTG: 100, HJ: 18, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ad", "Qh"],
    pre: [["UTG", "r", 2.5], ["HJ", "r", 18], ["CO", "c"]] },

  { id: "pre-13", family: "preflop", note: "table thinned to 5 seats, off-menu open",
    stacks: { HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Jh", "Td"],
    pre: [["HJ", "f"], ["CO", "r", 2.8], ["BTN", "f"], ["SB", "f"]] },

  { id: "pre-14", family: "preflop", note: "table thinned to 4 seats, 3-bet pot",
    stacks: { CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ks", "Qd"],
    pre: [["CO", "r", 2.5], ["BTN", "r", 8], ["SB", "f"], ["BB", "r", 24], ["CO", "f"]] },

  { id: "pre-15", family: "preflop", note: "table thinned to 3 seats — outside the 6-max charts entirely",
    stacks: { BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ah", "5h"],
    pre: [["BTN", "r", 2.5], ["SB", "r", 10]] },

  { id: "pre-16", family: "preflop", note: "heads-up — the AI preflop piece's own corner",
    stacks: { SB: 68, BB: 195 }, hero: "BB", cards: ["Ac", "As"],
    pre: [["SB", "r", 3]] },

  { id: "pre-17", family: "preflop", note: "deep 150bb 4-bet pot at uneven stacks",
    stacks: { UTG: 150, HJ: 150, CO: 150, BTN: 90, SB: 150, BB: 150 }, hero: "BTN", cards: ["Ad", "Ks"],
    pre: [["UTG", "r", 3], ["HJ", "f"], ["CO", "r", 10], ["BTN", "r", 26], ["SB", "f"], ["BB", "f"], ["UTG", "f"], ["CO", "r", 60]] },

  // ===================== THE RE-KEY + BORROW TARGETS (2026-09-22) =====================
  // The 6-max charts filed every node past a maxactive forced fold one token short, and those nodes are
  // concentrated exactly here: open, calls, a squeeze, and whoever acts next. Each of these either answered
  // from ANOTHER SEAT'S node before the fix, or had no node at all.
  { id: "sq-01", family: "preflop", note: "BB facing open + two calls + SB squeeze — hero is the would-be 5th entrant (forced fold in the tree)",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Qd", "Qs"],
    pre: [["UTG", "f"], ["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "r", 7.5]] },

  { id: "sq-02", family: "preflop", note: "the OPENER facing a squeeze after the BB folds — the node that was filed under the BB's line",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "HJ", cards: ["Ah", "Kd"],
    pre: [["UTG", "f"], ["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "r", 7.5], ["BB", "f"]] },

  { id: "sq-03", family: "preflop", note: "a cold-caller facing the squeeze after the opener folds — two levels past the forced fold",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["8s", "8c"],
    pre: [["UTG", "f"], ["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "r", 7.5], ["BB", "f"], ["HJ", "f"]] },

  { id: "sq-04", family: "preflop", note: "squeeze, opener 4-bets, back to a caller — deep in the re-keyed subtree",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ks", "Kh"],
    pre: [["UTG", "f"], ["HJ", "r", 2.5], ["CO", "c"], ["BTN", "c"], ["SB", "r", 7.5], ["BB", "f"], ["HJ", "r", 23]] },

  { id: "sq-05", family: "preflop", note: "open + one call + squeeze — only four entrants, never affected; the control",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "HJ", cards: ["Ah", "Kd"],
    pre: [["UTG", "f"], ["HJ", "r", 2.5], ["CO", "c"], ["BTN", "f"], ["SB", "r", 9], ["BB", "f"]] },

  { id: "limp-17", family: "limp", note: "two limpers, iso, SB calls, BB folds — the limper now acts on a re-keyed node",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "UTG", cards: ["Jc", "Jd"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "f"], ["SB", "c"], ["BB", "f"]] },
  { id: "hu-01", family: "preflop", note: "table thinned to TWO seats: hero SB/BTN first in",
    stacks: { SB: 100, BB: 100 }, hero: "SB", cards: ["Kd", "9s"], pre: [] },
  { id: "hu-02", family: "preflop", note: "table thinned to TWO seats: hero BB facing the SB's 2.5bb open (the 2026-09-21 table-shape miss)",
    stacks: { SB: 100, BB: 100 }, hero: "BB", cards: ["Qh", "8h"], pre: [["SB", "r", 2.5]] },
  { id: "three-01", family: "preflop", note: "THREE seats in the 6-max ring: hero BTN first in",
    stacks: { BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["As", "7d"], pre: [] },
  { id: "three-02", family: "preflop", note: "THREE seats: hero SB facing a BTN open",
    stacks: { BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Jc", "Tc"], pre: [["BTN", "r", 2.5]] },
  { id: "three-03", family: "preflop", note: "THREE seats: hero BB vs an SB complete after the BTN folds",
    stacks: { BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["9h", "6h"], pre: [["BTN", "f"], ["SB", "c"]] },
  { id: "three-04", family: "preflop", note: "THREE seats, uneven: BTN 40bb opens, SB 3-bets, hero BB",
    stacks: { BTN: 40, SB: 100, BB: 100 }, hero: "BB", cards: ["Ah", "Qd"], pre: [["BTN", "r", 2.5], ["SB", "r", 11]] },
  { id: "lrr-21", family: "esoteric", note: "the 2026-09-21 size-too-far miss: two limps, hero isos to 4, first limper calls, second limper limp-reraises to 21",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ks", "Qs"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 4], ["BTN", "f"], ["SB", "f"], ["BB", "f"], ["UTG", "c"], ["HJ", "r", 21]] },
  { id: "h443-a", family: "preflop", note: "hand 443: CO opens, SB flats, BB min-3-bets to 4 — hero CO facing it (4-handed, BTN folded)",
    stacks: { CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ac", "Qc"],
    pre: [["CO", "r", 2.5], ["BTN", "f"], ["SB", "c"], ["BB", "r", 4]] },
  { id: "h443-b", family: "preflop", note: "hand 443: ... hero 4-bets 9.2, SB folds, BB 5-bets to 14.4 — the line GTO Wizard called NODE_DOES_NOT_EXIST 276 times",
    stacks: { CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ac", "Qc"],
    pre: [["CO", "r", 2.5], ["BTN", "f"], ["SB", "c"], ["BB", "r", 4], ["CO", "r", 9.2], ["SB", "f"], ["BB", "r", 14.4]] },
  { id: "limp-18", family: "limp", note: "hero SB facing two limps, no raise — the SB's complete decision, LOCKED in the full pool tree: must read the pilot",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Kd", "Kc"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "c"], ["BTN", "c"]] },
  { id: "limp-19", family: "limp", note: "hero BTN facing two limps — the over-limp decision, locked in BOTH pool trees: equilibrium chart, then the trust guard",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["7d", "6d"],
    pre: [["UTG", "f"], ["HJ", "c"], ["CO", "c"]] },
  { id: "limp-20", family: "limp", note: "hero SB completed behind a limp, BB isos — the SB's node facing the iso is NOT locked: full pool tree",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Qh", "Jh"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "f"], ["BTN", "c"], ["SB", "c"], ["BB", "r", 5], ["BTN", "f"]] },

  // ================== ESOTERIC LIMP / ISO SPOTS (2026-09-22, Brady: "create the weirdest most complex limp
  // iso spots ... ensure that with the system we've built it is strong enough to answer it"). Built past every
  // cap on purpose: the trees hold two limpers and two callers, GTO Wizard AI one of each, maxactive four
  // entrants. Each note says which wall it hits. Pool fact they lean on: limp-reraises run 3-4x the iso.
  { id: "eso-01", family: "esoteric", note: "FIVE limpers (SB completes), hero BB with the option: 3 past the limp cap, 5 entrants",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ad", "Kc"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "c"]] },
  { id: "eso-02", family: "esoteric", note: "three limpers, BTN isos, both blinds call, first limper calls: next limper faces a 5-entrant iso",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "HJ", cards: ["7s", "7h"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "r", 6], ["SB", "c"], ["BB", "c"], ["UTG", "c"]] },
  { id: "eso-03", family: "esoteric", note: "limp, limp, iso, overcall, SB calls, BB SQUEEZES over the limped iso: first limper to act",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "UTG", cards: ["Qh", "Qd"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "c"], ["SB", "c"], ["BB", "r", 24]] },
  { id: "eso-04", family: "esoteric", note: "limp, limp, iso, first limper LIMP-RERAISES, iso 4-bets: second limper to act",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "HJ", cards: ["Ac", "Ks"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "f"], ["SB", "f"], ["BB", "f"], ["UTG", "r", 18]] },
  { id: "eso-05", family: "esoteric", note: "limp-reraise faced BY THE ISO RAISER (the pool's 3-4x limp-reraise)",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Jc", "Jh"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "r", 5], ["BTN", "f"], ["SB", "f"], ["BB", "f"], ["UTG", "r", 18]] },
  { id: "eso-06", family: "esoteric", note: "four limpers then the SB isos BIG (8bb), BB calls: hero the first limper",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "UTG", cards: ["9s", "9d"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "r", 8], ["BB", "c"]] },
  { id: "eso-07", family: "esoteric", note: "limp, iso, THREE cold-callers: BB closes as the would-be 5th entrant and the 3rd caller",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ts", "9s"],
    pre: [["UTG", "c"], ["HJ", "r", 4], ["CO", "c"], ["BTN", "c"], ["SB", "c"]] },
  { id: "eso-08", family: "esoteric", note: "short limper (30bb) limp-JAMS over the iso after a caller: the caller to act",
    stacks: { UTG: 30, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ah", "Qh"],
    pre: [["UTG", "c"], ["HJ", "r", 4.5], ["CO", "c"], ["BTN", "f"], ["SB", "f"], ["BB", "f"], ["UTG", "r", 30], ["HJ", "c"]] },
  { id: "eso-09", family: "esoteric", note: "three limpers, OFF-MENU iso (8.5bb), two callers: a limper to act",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "HJ", cards: ["Kd", "Qd"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "r", 8.5], ["SB", "c"], ["BB", "c"], ["UTG", "f"]] },
  { id: "eso-10", family: "esoteric", note: "limp, overlimp, SB completes, BB raises from the option: the limpers respond",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "HJ", cards: ["As", "5s"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "f"], ["BTN", "f"], ["SB", "c"], ["BB", "r", 6], ["UTG", "c"]] },
  { id: "eso-11", family: "esoteric", note: "three limpers at 150bb: there is NO 150bb limp tree at all",
    stacks: { UTG: 150, HJ: 150, CO: 150, BTN: 150, SB: 150, BB: 150 }, hero: "BTN", cards: ["Ac", "Jc"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"]] },
  { id: "eso-12", family: "esoteric", note: "two limpers + iso + overcall at 125bb: no 125bb limp tree either",
    stacks: { UTG: 125, HJ: 125, CO: 125, BTN: 125, SB: 125, BB: 125 }, hero: "SB", cards: ["Kh", "Kc"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "c"]] },
  { id: "eso-13", family: "esoteric", note: "uneven table (UTG 40, CO 70): two limpers, iso, a caller; the uneven set has NO limp trees",
    stacks: { UTG: 40, HJ: 100, CO: 70, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["8h", "8c"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "c"], ["SB", "f"]] },
  { id: "eso-14", family: "esoteric", note: "limp, iso, 3-bet, cold 4-bet, then a LIMPER jams: the iso raiser to act",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Ad", "Ah"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "r", 17], ["SB", "r", 38], ["BB", "f"], ["UTG", "r", 100], ["HJ", "f"]] },
  // ---- the one refused postflop shape: 4-way, every villain paid on the flop, hero between (RE-ROOT, 2026-09-22) ----
  { id: "eso-p6", family: "esoteric", note: "4-way TURN: SB bet the flop, hero (BB) and both others called; SB checks the turn — no collapse from the flop, re-rooted at the turn",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Kh", "Qh"],
    pre: [["UTG", "r", 2.5], ["HJ", "f"], ["CO", "c"], ["BTN", "f"], ["SB", "c"], ["BB", "c"]],
    board: ["Kd", "8s", "4h", "2c"], flop: [["SB", "r", 4], ["BB", "c"], ["UTG", "c"], ["CO", "c"]], turn: [["SB", "x"]] },
  { id: "eso-p7", family: "esoteric", note: "4-way RIVER facing a bet: flop bet + 3 calls, turn checked through, SB bets the river — re-rooted at the river",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ac", "Jc"],
    pre: [["UTG", "r", 2.5], ["HJ", "f"], ["CO", "c"], ["BTN", "f"], ["SB", "c"], ["BB", "c"]],
    board: ["Jd", "7s", "3h", "2c", "9d"], flop: [["SB", "r", 4], ["BB", "c"], ["UTG", "c"], ["CO", "c"]],
    turn: [["SB", "x"], ["BB", "x"], ["UTG", "x"], ["CO", "x"]], river: [["SB", "r", 12]] },

  // ---- postflop out of those pots ----
  { id: "eso-p1", family: "esoteric", note: "FLOP of a 3-limper iso pot, blinds call: 5-way, hero the iso raiser facing a bet and a call",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ah", "Kh"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "r", 6], ["SB", "c"], ["BB", "c"], ["UTG", "c"], ["HJ", "f"], ["CO", "c"]],
    board: ["Kc", "8h", "3h"], flop: [["SB", "x"], ["BB", "r", 8], ["UTG", "f"], ["CO", "c"]] },
  { id: "eso-p2", family: "esoteric", note: "FLOP of a limp-reraised pot, heads-up: the limp-reraiser leads",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Qs", "Qc"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "r", 5], ["BTN", "f"], ["SB", "f"], ["BB", "f"], ["UTG", "r", 18], ["CO", "c"]],
    board: ["Jd", "7s", "2c"], flop: [["UTG", "r", 12]] },
  { id: "eso-p3", family: "esoteric", note: "FLOP of a 4-limper pot, SB completes, BB checks: 6-way limped flop checked to hero last",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["6h", "5h"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]],
    board: ["7h", "4s", "2d"], flop: [["SB", "x"], ["BB", "x"], ["UTG", "x"], ["HJ", "x"], ["CO", "x"]] },
  { id: "eso-p4", family: "esoteric", note: "TURN of a 2-limper iso pot with a caller: 4-way, hero a limper facing the iso's barrel",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "UTG", cards: ["Td", "9d"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "c"], ["SB", "f"], ["BB", "f"], ["UTG", "c"], ["HJ", "c"]],
    board: ["Jd", "8c", "3d", "2h"], flop: [["UTG", "x"], ["HJ", "x"], ["CO", "r", 7], ["BTN", "f"], ["UTG", "c"], ["HJ", "c"]], turn: [["UTG", "x"], ["HJ", "x"], ["CO", "r", 18]] },
  { id: "eso-p5", family: "esoteric", note: "FLOP at 125bb of a limped pot: no 125bb limp tree for the arrival ranges",
    stacks: { UTG: 125, HJ: 125, CO: 125, BTN: 125, SB: 125, BB: 125 }, hero: "BB", cards: ["Kd", "Js"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "c"], ["BTN", "f"], ["SB", "f"], ["BB", "x"]],
    board: ["Ks", "Tc", "5h"], flop: [] },

  // ========================= 4- AND 5-WAY POSTFLOP =========================
  { id: "multi-01", family: "multiway", note: "4-way limped flop, hero in the BB, first to act",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Kh", "9h"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "c"], ["BTN", "c"], ["SB", "f"], ["BB", "x"]],
    board: ["Kd", "9c", "4s"], flop: [] },

  { id: "multi-02", family: "multiway", note: "5-way limped flop, hero in the BB facing a bet and two calls",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ts", "8s"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "f"], ["BB", "x"]],
    board: ["9s", "7d", "2c"], flop: [["BB", "x"], ["UTG", "r", 3], ["HJ", "c"], ["CO", "f"], ["BTN", "c"]] },

  { id: "multi-03", family: "multiway", note: "4-way raised pot, hero on the button in position",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ad", "Kc"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "f"], ["BB", "c"]],
    board: ["Ah", "8d", "3c"], flop: [["BB", "x"], ["UTG", "r", 4], ["HJ", "c"]] },

  { id: "multi-04", family: "multiway", note: "4-way flop, hero facing a bet AND a raise",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Qs", "Qd"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "f"], ["BB", "c"]],
    board: ["Jh", "7s", "2d"], flop: [["BB", "r", 4], ["UTG", "f"], ["HJ", "r", 14]] },

  { id: "multi-05", family: "multiway", note: "5-way raised pot, hero in the blinds out of position",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ac", "Qh"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "f"], ["BB", "c"]],
    board: ["Qc", "9d", "5h"], flop: [] },

  { id: "multi-06", family: "multiway", note: "4-way TURN after a checked flop",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Jc", "Jd"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "r", 4], ["BTN", "c"], ["SB", "f"], ["BB", "c"], ["UTG", "c"]],
    board: ["8h", "5c", "2d", "Js"], flop: [["BB", "x"], ["UTG", "x"], ["CO", "x"], ["BTN", "x"]], turn: [["BB", "x"], ["UTG", "r", 6]] },

  // 2026-09-24: this fixture dealt hero Th on a board holding Th, and the answer was an all-zero mix graded
  // "degenerate" for three runs before anyone read the cards. buildHand now refuses a card dealt twice.
  { id: "multi-07", family: "multiway", note: "4-way RIVER where all four paid on the flop — nothing ghostable, nothing mergeable",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ad", "Td"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "f"], ["BB", "c"]],
    board: ["Th", "6d", "3s", "Qc", "2h"],
    flop: [["BB", "x"], ["UTG", "r", 5], ["HJ", "c"], ["BTN", "c"], ["BB", "c"]],
    turn: [["BB", "x"], ["UTG", "x"], ["HJ", "x"], ["BTN", "x"]],
    river: [["BB", "r", 12], ["UTG", "f"], ["HJ", "c"]] },

  { id: "multi-08", family: "multiway", note: "6-way limped flop (everyone in), hero last to act — a shape the collapse cannot reduce",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BTN", cards: ["Ah", "6h"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]],
    board: ["Kh", "9h", "4s"], flop: [["SB", "x"], ["BB", "r", 3], ["UTG", "c"], ["HJ", "f"], ["CO", "c"]] },

  { id: "multi-09", family: "multiway", note: "4-way flop at uneven stacks, one seat short",
    stacks: { UTG: 35, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "CO", cards: ["Kd", "Qd"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"], ["BTN", "f"], ["SB", "f"], ["BB", "c"]],
    board: ["Kc", "7h", "3d"], flop: [["BB", "x"], ["UTG", "r", 5], ["HJ", "c"]] },

  { id: "multi-10", family: "multiway", note: "4-way flop out of a LIMPED pot with an iso behind",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["9d", "9c"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "f"], ["SB", "c"], ["BB", "f"], ["UTG", "c"], ["HJ", "c"]],
    board: ["9h", "6s", "2c"], flop: [] },

  // ---- ISOLATING THE LIMPED-MULTIWAY BOUNDARY (2026-09-22, Brady: "I think I have seen the system
  // actually answer limped multiway spots"). He is right, and multi-10 was too small a sample to name a
  // whole class from. These three vary ONE thing at a time against multi-10 (2 limpers + iso + 2 callers,
  // 4-way) so the report can say where the line actually falls instead of "limped multiway".
  { id: "multi-17", family: "multiway", note: "ONE limper + iso + 2 cold callers, 4-way flop — is the blocker the LIMPER count?",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["9d", "9c"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "r", 5], ["BTN", "c"], ["SB", "c"], ["BB", "f"], ["UTG", "c"]],
    board: ["9h", "6s", "2c"], flop: [] },

  { id: "multi-18", family: "multiway", note: "TWO limpers + iso + ONE caller, 3-way flop — is the blocker the CALLER count?",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["9d", "9c"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "r", 5], ["BTN", "f"], ["SB", "c"], ["BB", "f"], ["UTG", "f"], ["HJ", "f"]],
    board: ["9h", "6s", "2c"], flop: [] },

  { id: "multi-19", family: "multiway", note: "TWO limpers, NO iso — a plain 4-way limped flop (the everyday case)",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["9d", "9c"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "f"], ["BTN", "c"], ["SB", "f"], ["BB", "x"]],
    board: ["9h", "6s", "2c"], flop: [] },

  // ---- IS THE LIMPED-POT "ALWAYS CHECK" THE COLLAPSE, OR THE TREE? (2026-09-22) ----
  // Every 4-way limped answer checks ~100% of range, two pair included. The blend is ruled out (each collapse
  // alone checks 99.9%). These are 3-WAY limped pots — no collapse at all, a direct GTO Wizard 3-player solve —
  // with the same hand and board as multi-01, so any difference is the collapse and any sameness is the tree.
  { id: "cmp-01", family: "multiway", note: "3-way limped pot, BB first to act, K9 two pair on K94 — NO collapse (compare multi-01)",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Kh", "9h"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "c"], ["BTN", "f"], ["SB", "f"], ["BB", "x"]],
    board: ["Kd", "9c", "4s"], flop: [] },

  { id: "cmp-02", family: "multiway", note: "3-way limped pot, SB completes, SB first to act with top set — NO collapse",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Kh", "Ks"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "f"], ["BTN", "f"], ["SB", "c"], ["BB", "x"]],
    board: ["Kd", "9c", "4s"], flop: [] },

  { id: "cmp-03", family: "multiway", note: "HEADS-UP limped pot (SB completes, BB checks), SB first to act, top set — the simplest tree",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Kh", "Ks"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "f"], ["BTN", "f"], ["SB", "c"], ["BB", "x"]],
    board: ["Kd", "9c", "4s"], flop: [] },

  { id: "cmp-04", family: "multiway", note: "HEADS-UP: one limper, BB checks, BB first to act with K9 two pair on K94 — cmp-01 minus a player",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Kh", "9h"],
    pre: [["UTG", "c"], ["HJ", "f"], ["CO", "f"], ["BTN", "f"], ["SB", "f"], ["BB", "x"]],
    board: ["Kd", "9c", "4s"], flop: [] },

  { id: "multi-11", family: "multiway", note: "6-way limped flop, hero facing a bet and a call — also beyond the collapse",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: [" Js".trim(), "Th"],
    pre: [["UTG", "c"], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]],
    board: ["Qd", "9c", "3h"], flop: [["BB", "x"], ["UTG", "r", 4], ["HJ", "c"], ["CO", "f"], ["BTN", "c"]] },

  { id: "multi-12", family: "multiway", note: "4-way turn, deep 150bb, all four paid the flop — the same refusal",
    stacks: { UTG: 150, HJ: 150, CO: 150, BTN: 150, SB: 150, BB: 150 }, hero: "HJ", cards: ["Ac", "Jd"],
    pre: [["UTG", "r", 3], ["HJ", "c"], ["CO", "c"], ["BTN", "f"], ["SB", "f"], ["BB", "c"]],
    board: ["Jh", "8c", "4d", "2s"], flop: [["BB", "x"], ["UTG", "r", 6], ["HJ", "c"], ["CO", "c"], ["BB", "c"]], turn: [["BB", "x"], ["UTG", "r", 18]] },

  { id: "multi-13", family: "multiway", note: "4-way flop, hero first to act into three",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Ah", "Ad"],
    pre: [["UTG", "r", 2.5], ["HJ", "c"], ["CO", "c"], ["BTN", "f"], ["SB", "c"], ["BB", "f"]],
    board: ["8s", "5d", "2h"], flop: [] },

  { id: "multi-14", family: "multiway", note: "5-way, off-menu preflop size AND a 5-way flop",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Kc", "Jc"],
    pre: [["UTG", "r", 2.7], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "f"], ["BB", "c"]],
    board: ["Jd", "7c", "5s"], flop: [] },

  // THE REFUSED POSTFLOP SHAPE (2026-09-23): every villain committed this street, hero wedged between them, no collapse
  // legal. Answered by the postflop last resort (hero vs the last aggressor, the rest as dead money).
  { id: "multi-17", family: "multiway", note: "4-way limped flop, everyone commits, hero BB between: the shape that used to be refused",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Jh", "Th"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]],
    board: ["Jd", "8c", "3s"], flop: [["SB", "r", 2], ["BB", "c"], ["CO", "r", 7], ["BTN", "c"], ["SB", "c"]] },

  { id: "multi-18", family: "multiway", note: "4-way limped pot, flop checks through, TURN everyone commits, hero BB between: the re-root fails too, the last resort answers",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Kd", "Qd"],
    pre: [["UTG", "f"], ["HJ", "f"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "x"]],
    board: ["Kc", "7h", "2s", "2d"], flop: [["SB", "x"], ["BB", "x"], ["CO", "x"], ["BTN", "x"]], turn: [["SB", "r", 3], ["BB", "c"], ["CO", "r", 10], ["BTN", "c"], ["SB", "c"]] },

  // THE 2026-09-21 SEAT-CAP REGRESSION. These are the only spots that exercise the path that was broken:
  // the CHART must fail preflop (so the cascade falls to the GTO Wizard AI preflop tree) AND four or more
  // must reach the flop (so the arrival ranges have to carry more seats than a solver tree holds). An
  // on-menu 6-max spot never gets there — recon6max answers it and that path was already at six seats.
  { id: "multi-15", family: "multiway", note: "AI-preflop path + 4-way flop: an 11bb open is >2x off the chart's menu, so the chart refuses and the AI builds the exact tree",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "BB", cards: ["Ac", "Kd"],
    pre: [["UTG", "r", 11], ["HJ", "c"], ["CO", "c"], ["BTN", "f"], ["SB", "f"], ["BB", "c"]],
    board: ["Kh", "8d", "3c"], flop: [] },

  { id: "multi-16", family: "multiway", note: "AI-preflop path + 5-way flop, hero facing a bet — the same cap, one seat deeper",
    stacks: { UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }, hero: "SB", cards: ["Qh", "Qd"],
    pre: [["UTG", "r", 11], ["HJ", "c"], ["CO", "c"], ["BTN", "c"], ["SB", "c"], ["BB", "f"]],
    board: ["Qc", "7h", "2d"], flop: [["SB", "x"], ["UTG", "r", 18], ["HJ", "c"]] },
];

// --------------------------------------------------------------------------- grading

/** Named approximations the chain announces in its warning text. */
const APPROX_MARKERS: [RegExp, string][] = [
  [/OFF-TREE SIZE/i, "size snapped past τ"],
  [/CALLER CAP/i, "caller borrowed"],
  [/LINE FITTED/i, "line fitted"],
  [/snapped to the tree's sizes/i, "size snapped (clean)"],
  [/collapsed to three/i, "field collapsed to 3"],
  [/RE-ROOTED/i, "re-rooted"],
  [/blended \d+ collapses/i, "collapses blended"],
  [/borrowed/i, "range borrowed"],
  [/answered from/i, "chart fallback"],
  [/dead SB approximated/i, "dead SB modelled"],
  [/past the .*rung|beyond/i, "past the ladder"],
  [/POSTFLOP LAST RESORT/i, "postflop last resort (hero vs aggressor)"],
  [/LAST RESORT/i, "last resort (hero vs aggressor)"],
  [/GTO Wizard AI preflop/i, "answered by AI preflop"],
];

type Grade = "clean" | "approx" | "degenerate" | "FAILED";

function grade(r: FastSolveResult, heroPos: string): { grade: Grade; why: string; flags: string[] } {
  if (!r.ok) return { grade: "FAILED", why: r.reason, flags: [] };
  const flags = APPROX_MARKERS.filter(([re]) => re.test(r.warning ?? "")).map(([, name]) => name);
  const sum = r.actions.reduce((s, a) => s + a.frequency, 0);
  // THE ANSWER MUST BE HERO'S. A mix can be perfectly believable and still belong to another seat — the
  // limp charts' post-iso rotation did exactly that on 2026-09-22 and this grader called it "clean",
  // which is how it survived a 45-spot run unnoticed. Check the seat before anything else.
  if (r.pos && String(r.pos).toUpperCase() !== heroPos.toUpperCase()) {
    return { grade: "degenerate", why: `answered from ${r.pos}'s node, but hero is ${heroPos} — WRONG SEAT`, flags };
  }
  if (!r.actions.length) return { grade: "degenerate", why: "the node offered no actions", flags };
  // notInRange before "no decision": a not-in-range answer has no decision by construction, and the old order
  // reported multi-07's all-zero mix as "actions but no decision rolled" — true, but not the cause.
  if (r.notInRange) return { grade: "degenerate", why: `equilibrium never reaches this node with ${r.heroClass}`, flags };
  if (!r.decision) return { grade: "degenerate", why: "actions but no decision rolled", flags };
  if (r.actions.every((a) => a.frequency <= 0)) return { grade: "degenerate", why: "every action at 0% — an all-zero mix", flags };
  if (sum < 95 || sum > 105) return { grade: "degenerate", why: `frequencies sum to ${sum.toFixed(1)}, not 100`, flags };
  // "answered by AI preflop" is not an approximation — it is the fallback piece doing its job.
  const real = flags.filter((f) => f !== "answered by AI preflop");
  return { grade: real.length ? "approx" : "clean", why: r.decision.action, flags };
}

// --------------------------------------------------------------------------- run

interface Row {
  id: string; family: string; note: string; score: number; band: string; drivers: string[];
  ok: boolean; grade: Grade; why: string; flags: string[];
  source?: string; tier?: string; pick?: string; mix?: string; ms: number;
  gametype?: string; line?: string; warning?: string | null;
}

/**
 * Ask the running API. `heroPos` is passed explicitly because a synthetic hand has no blind-post
 * history for seats that folded pre-blind, and `strategyId` because this harness declares no
 * session — without it the cascade would pick a different preflop piece entirely.
 */
async function solveVia(api: string, hand: ParsedHand, heroPos: Pos, timeoutMs = 180_000): Promise<FastSolveResult> {
  let res: Response;
  try {
    res = await fetch(`${api}/api/fast-solver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hand, heroPos, strategyId: STRATEGY, origin: "adhoc" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `harness: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || !body?.ok) return { ok: false, reason: `api ${res.status}: ${body?.error ?? "no body"}` };
  if (body.deferred) return { ok: false, reason: `the API says it is not hero's turn: ${body.deferred}` };
  if (!body.solution) return { ok: false, reason: "the API returned no solution object" };
  return body.solution as FastSolveResult;
}

async function main() {
  const only = arg("--only");
  const out = arg("--out");
  const api = arg("--api", "http://127.0.0.1:2000")!;
  const ids = (arg("--id") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const spots = S.filter((s) => (!only || s.family === only) && (!ids.length || ids.includes(s.id)));

  // The API owns the token pool and its keeper; ask it what it has rather than
  // sniffing ourselves (a second sniffer fights it for the one DevTools socket).
  let pool = "unknown";
  try {
    const g = (await (await fetch(`${api}/api/dashboard/gtow-status`, { signal: AbortSignal.timeout(8000) })).json()) as any;
    pool = g.text ?? "unknown";
  } catch { /* the run still works off the charts */ }
  console.log(`API ${api} · GTO Wizard pool: ${pool}`);
  console.log(`${spots.length} spots · strategy ${STRATEGY}
`);

  const rows: Row[] = [];
  for (const s of spots) {
    const cx = complexity(s);
    const t0 = Date.now();
    let r: FastSolveResult;
    try {
      const { hand, heroPos } = buildHand(s);
      r = await solveVia(api, hand, heroPos);
      // A "no token" failure is the pool being cold, not a hole in the strategy —
      // give the keeper one tick and ask again before calling it a miss.
      if (!r.ok && /no token|no GTO Wizard session/i.test(r.reason)) {
        await new Promise((res) => setTimeout(res, 8000));
        r = await solveVia(api, hand, heroPos);
      }
    } catch (e) {
      r = { ok: false, reason: `harness threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    const ms = Date.now() - t0;
    const g = grade(r, s.hero);
    const row: Row = {
      id: s.id, family: s.family, note: s.note, score: cx.score, band: cx.band, drivers: cx.drivers,
      ok: r.ok, grade: g.grade, why: g.why, flags: g.flags, ms,
      ...(r.ok
        ? { source: r.source, tier: r.tier, pick: r.decision?.action,
            mix: r.actions.map((a) => `${a.action} ${a.frequency.toFixed(1)}`).join(" / "),
            gametype: r.gametype, line: r.line, warning: r.warning ?? null }
        : { line: r.line, gametype: r.gametype }),
    };
    rows.push(row);
    const mark = g.grade === "clean" ? "OK  " : g.grade === "approx" ? "APX " : g.grade === "degenerate" ? "DEG " : "FAIL";
    console.log(
      `${mark} ${s.id.padEnd(9)} cx ${String(cx.score).padStart(2)} ${cx.band.padEnd(8)} ${String(ms).padStart(6)}ms  ` +
      `${(row.pick ?? "—").padEnd(12)} ${(row.tier ?? "").padEnd(12)} ${(row.gametype ?? "").padEnd(32)} ${g.grade === "clean" ? "" : g.why.slice(0, 130)}`
    );
    if (g.flags.length) console.log(`     ${g.flags.join(" · ")}`);
  }

  // ---- report ----
  const by = (g: Grade) => rows.filter((r) => r.grade === g);
  console.log("\n" + "=".repeat(100));
  console.log(`clean ${by("clean").length} · approx ${by("approx").length} · degenerate ${by("degenerate").length} · FAILED ${by("FAILED").length}   (of ${rows.length})`);
  for (const fam of ["limp", "preflop", "multiway", "esoteric"]) {
    const f = rows.filter((r) => r.family === fam);
    if (!f.length) continue;
    const answered = f.filter((r) => r.grade === "clean" || r.grade === "approx").length;
    const p50 = f.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(f.length / 2)];
    console.log(`  ${fam.padEnd(9)} ${answered}/${f.length} answered · p50 ${p50}ms · slowest ${Math.max(...f.map((r) => r.ms))}ms · mean complexity ${(f.reduce((s, r) => s + r.score, 0) / f.length).toFixed(1)}`);
  }
  // Complexity is only a useful grade if it PREDICTS something — print the answer rate per band.
  console.log("\nby complexity band:");
  for (const band of ["routine", "awkward", "hard", "brutal"]) {
    const f = rows.filter((r) => r.band === band);
    if (!f.length) continue;
    const answered = f.filter((r) => r.grade === "clean" || r.grade === "approx").length;
    const clean = f.filter((r) => r.grade === "clean").length;
    console.log(`  ${band.padEnd(8)} ${answered}/${f.length} answered · ${clean} of them with no approximation at all`);
  }
  const bad = [...by("FAILED"), ...by("degenerate")];
  if (bad.length) {
    console.log("\nSPOTS TO REVIEW:");
    for (const r of bad) {
      console.log(`  ${r.id}  [cx ${r.score} ${r.band}]  ${r.note}`);
      console.log(`     ${r.grade}: ${r.why}`);
      if (r.line) console.log(`     line ${r.line}${r.gametype ? ` · ${r.gametype}` : ""}`);
    }
  } else {
    console.log("\nNothing failed.");
  }
  const tier: Record<string, number> = {};
  for (const r of rows) if (r.tier) tier[r.tier] = (tier[r.tier] ?? 0) + 1;
  console.log(`\nanswered by: ${Object.entries(tier).map(([k, n]) => `${k} ${n}`).join(" · ")}`);

  if (out) { writeFileSync(out, JSON.stringify({ generatedAt: Date.now(), api, rows }, null, 2)); console.log(`\nwrote ${out}`); }
  process.exit(0);
}

await main();
