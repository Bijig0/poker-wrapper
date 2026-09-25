/** Hand 4920544353 (NL5, 2026-09-25): Ignition's record, and the hand as the reader archived it — with a rabbit-hunt
 *  river card (Qc) and a phantom fold by the pot winner (the last action). Test data only. */
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";
import record from "./hh_4920544353.fixture.json";

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
