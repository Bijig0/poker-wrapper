/** Hand 4920544353 (NL5, 2026-09-25): Ignition's record, and the hand as the reader archived it — with a rabbit-hunt
 *  river card (Qc) and a phantom fold by the pot winner (the last action). Test data only. */
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";
import record from "./hh_4920544353.fixture.json";
import record36936 from "./hh_4923636936.fixture.json";
import record27084 from "./hh_4923627084.fixture.json";
import record79384 from "./hh_4922279384.fixture.json";

export const record4920544353: unknown = record;

export const archived4920544353: ParsedHand = {
  handId: 12, clientHandId: "4920544353", bbCents: 5, heroSeatId: 5, heroCards: ["Kd", "Jh"],
  board: ["6s", "8h", "Ks", "Qh", "Qc"], street: "river", liveSeats: [1, 2, 3, 4, 5, 6],
  committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" },
  startStacks: { 1: 52.4, 2: 34, 3: 104.4, 4: 226.6, 5: 100, 6: 34.2 },
  stacks: { 1: 49.8, 2: 30.4, 3: 104.4, 4: 226.6, 5: 87.4, 6: 51.6 },
  currentNode: { street: "river", toActSeatId: null, toActIsHero: false, pot: 31.4, toCall: 0, legalActions: [], complete: true },
  ended: true,
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 2, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: true, type: "raise", amount: 2.6, street: "preflop" },
    { seatId: 6, hero: false, type: "call", amount: 2.6, street: "preflop" },
    { seatId: 1, hero: false, type: "call", amount: 2.2, street: "preflop" },
    { seatId: 2, hero: false, type: "call", amount: 1.6, street: "preflop" },
    { seatId: 1, hero: false, type: "check", street: "flop" },
    { seatId: 2, hero: false, type: "bet", amount: 1, street: "flop" },
    { seatId: 5, hero: true, type: "call", amount: 1, street: "flop" },
    { seatId: 6, hero: false, type: "raise", amount: 10, street: "flop" },
    { seatId: 1, hero: false, type: "fold", street: "flop" },
    { seatId: 2, hero: false, type: "fold", street: "flop" },
    { seatId: 5, hero: true, type: "call", amount: 9, street: "flop" },
    { seatId: 5, hero: true, type: "check", street: "turn" },
    { seatId: 6, hero: false, type: "all-in", amount: 21.6, street: "turn" },
    { seatId: 5, hero: true, type: "fold", street: "turn" },
    { seatId: 6, hero: false, type: "fold", street: "turn" },
  ],
};

/** The same hand as a faithful capture would have it: no rabbit card, no phantom fold. */
export const faithful4920544353: ParsedHand = {
  ...archived4920544353, board: archived4920544353.board.slice(0, 4), actions: archived4920544353.actions.slice(0, 18),
};

const node = (street: ParsedHand["street"], pot: number): ParsedHand["currentNode"] =>
  ({ street, toActSeatId: null, toActIsHero: false, pot, toCall: 0, legalActions: [], complete: true });
const SIX: Record<number, string> = { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" };

/** Hand 4923636936 (NL5, 2026-10-09; the 2026-10-14 audit, finding 5): hero in the BB (seat 2) was folded by the
 *  SITE'S clock — Ignition's "Folds (timeout)" — and our record has no row for it: it ends at the SB's fold. UTG
 *  raised to 7.4bb, every other seat folded. The checker read "actions 3-7 missing" while every one was present. */
export const record4923636936: unknown = record36936;
export const archived4923636936: ParsedHand = {
  handId: 1, clientHandId: "4923636936", bbCents: 5, heroSeatId: 2, heroCards: ["4h", "9c"], board: [], street: "preflop",
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: SIX,
  startStacks: { 1: 40.4, 2: 101, 3: 107, 4: 109.2, 5: 100, 6: 115 },
  currentNode: node("preflop", 8.8), ended: true,
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 2, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 3, hero: false, type: "raise", amount: 7.4, street: "preflop" },
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: false, type: "fold", street: "preflop" },
    { seatId: 6, hero: false, type: "fold", street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
  ],
};

/** Hand 4923627084 (NL5, 2026-10-09; finding 5): UTG+2 (seat 3) POSTED IN 1bb, UTG raised to 4bb, seat 3 called 3bb
 *  more. As the reader archives it (utils/foldPostIns): the post leaves the line and his call carries it — "call
 *  4bb", `postIns` readAs "call". The checker paired Ignition's post with that call and reported the call missing. */
export const record4923627084: unknown = record27084;
export const archived4923627084: ParsedHand = {
  handId: 2, clientHandId: "4923627084", bbCents: 5, heroSeatId: 5, heroCards: ["Ac", "5s"], board: ["4d", "5c", "9d", "Qh"], street: "turn",
  liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
  startStacks: { 1: 100, 2: 55, 3: 100, 4: 101.8, 5: 100.2, 6: 31 },
  postIns: [{ seatId: 3, hero: false, amount: 1, readAs: "call" }],
  currentNode: node("turn", 52.8), ended: true,
  actions: [
    { seatId: 5, hero: true, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 1, hero: false, type: "raise", amount: 4, street: "preflop" },
    { seatId: 2, hero: false, type: "call", amount: 4, street: "preflop" },
    { seatId: 3, hero: false, type: "call", amount: 4, street: "preflop" },   // 3bb + the 1bb post
    { seatId: 4, hero: false, type: "fold", street: "preflop" },
    { seatId: 5, hero: true, type: "fold", street: "preflop" },
    { seatId: 6, hero: false, type: "call", amount: 3, street: "preflop" },
    { seatId: 6, hero: false, type: "check", street: "flop" },
    { seatId: 1, hero: false, type: "check", street: "flop" },
    { seatId: 2, hero: false, type: "check", street: "flop" },
    { seatId: 3, hero: false, type: "bet", amount: 7.8, street: "flop" },
    { seatId: 6, hero: false, type: "fold", street: "flop" },
    { seatId: 1, hero: false, type: "call", amount: 7.8, street: "flop" },
    { seatId: 2, hero: false, type: "raise", amount: 15.6, street: "flop" },
    { seatId: 3, hero: false, type: "call", amount: 7.8, street: "flop" },
    { seatId: 1, hero: false, type: "fold", street: "flop" },
    { seatId: 2, hero: false, type: "all-in", amount: 35.4, street: "turn" },
    { seatId: 3, hero: false, type: "fold", street: "turn" },
  ],
};

/** Hand 4922279384 (NL5, 2026-10-04; finding 5): on the river the BTN (seat 6) raised to 40.4bb and then shoved the
 *  59.2bb he had left — Ignition "All-in $2.96" (the chips added), ours "all-in 99.6" (his street total). Hero
 *  (UTG, seat 4) had folded the flop. The SB's "All-in(raise) $4.99" is 99.8bb, a raise-to total on both sides. */
export const record4922279384: unknown = record79384;
export const archived4922279384: ParsedHand = {
  handId: 3, clientHandId: "4922279384", bbCents: 5, heroSeatId: 4, heroCards: ["9h", "Ad"], board: ["2s", "3c", "Qc", "7h", "Jc"], street: "river",
  liveSeats: [2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 2: "SB", 3: "BB", 4: "UTG", 5: "CO", 6: "BTN" },
  startStacks: { 2: 106.4, 3: 27, 4: 159, 5: 15.4, 6: 106.2 },
  currentNode: node("river", 205.2), ended: true,
  actions: [
    { seatId: 2, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 3, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 4, hero: true, type: "raise", amount: 2.6, street: "preflop" },
    { seatId: 5, hero: false, type: "fold", street: "preflop" },
    { seatId: 6, hero: false, type: "call", amount: 2.6, street: "preflop" },
    { seatId: 2, hero: false, type: "call", amount: 2.2, street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 2, hero: false, type: "bet", amount: 4, street: "flop" },
    { seatId: 4, hero: true, type: "fold", street: "flop" },
    { seatId: 6, hero: false, type: "call", amount: 4, street: "flop" },
    { seatId: 2, hero: false, type: "check", street: "turn" },
    { seatId: 6, hero: false, type: "check", street: "turn" },
    { seatId: 2, hero: false, type: "bet", amount: 20.2, street: "river" },
    { seatId: 6, hero: false, type: "raise", amount: 40.4, street: "river" },
    { seatId: 2, hero: false, type: "raise", amount: 99.8, street: "river" },
    { seatId: 6, hero: false, type: "all-in", amount: 99.6, street: "river" },
  ],
};
