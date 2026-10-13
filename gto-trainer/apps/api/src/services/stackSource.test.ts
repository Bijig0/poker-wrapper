/**
 * A STACK THE TABLE DID NOT CONFIRM IS SAID, NOT SILENT (services/stackSource, 2026-10-14 — the answer-path audit's
 * finding 1): the chart picker and the GTO Wizard AI shape name every seat they built on a screen reading or the 100bb
 * default, and the hand's `startStacksSource` tells a carried figure from the seat's own frame.
 */
import { describe, expect, test } from "bun:test";
import { STACK_NOT_CONFIRMED_CODE, STACK_NOT_CONFIRMED_TAG, stackHow, stackNotConfirmedNote, stackNotConfirmedReason, unconfirmedStacks } from "./stackSource";
import { departureForCode, departureForWarning } from "./approximations";
import { chartFor6max } from "./hrc6max";
import { shapeOf } from "./gtowAiPreflop";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/** Hand 4923624883 at hero's first decision (the HJ, seat 3, first in): the blinds have posted — their frames are exact
 *  — and every other seat is the screen's reading; the HJ's own reads 77.4 (the previous hand's end), dealt 149.2. */
const base = {
  handId: 20, clientHandId: "4923624883", bbCents: 200, heroSeatId: 3, heroCards: ["Ac", "8c"], liveSeats: [1, 2, 3, 4, 6],
  committed: { 1: 0.5, 2: 1 }, potByStreet: {}, positions: { 1: "SB", 2: "BB", 3: "HJ", 4: "CO", 6: "BTN" },
  stacks: { 1: 53.9, 2: 34.2, 3: 77.4, 4: 100, 6: 211.8 }, ended: false, board: [], street: "preflop",
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 2, hero: false, type: "post-bb", amount: 1, street: "preflop" },
  ],
  currentNode: { street: "preflop", toActSeatId: 3, toActIsHero: true, pot: 0, toCall: 1, legalActions: [], complete: false },
} as const;
const hand = (extra: Partial<ParsedHand> = {}): ParsedHand => ({ ...base, ...extra } as unknown as ParsedHand);

/** the wrapper's export before 2026-10-14: the blinds only */
const ACTED = { startStacks: { 1: 54.4, 2: 35.2 }, startStacksSource: { 1: "frame", 2: "frame" } } as const;
/** the wrapper's export since: every dealt seat, the rest carried from the previous hand's result (the HJ's 149.2) */
const CARRIED = {
  startStacks: { 1: 54.4, 2: 35.2, 3: 149.2, 4: 100, 6: 219.2 },
  startStacksSource: { 1: "frame", 2: "frame", 3: "result", 4: "buy", 6: "result" },
} as const;

describe("stackHow / unconfirmedStacks", () => {
  test("a seat's own frame, a carried figure, the screen, the default", () => {
    const h = hand(CARRIED as any);
    expect(stackHow(h, 1)).toBe("frame");
    expect(stackHow(h, 3)).toBe("carried");
    expect(stackHow(hand(ACTED as any), 3)).toBe("screen");
    expect(stackHow(hand({ ...ACTED, stacks: { 1: 53.9, 2: 34.2 } } as any), 3)).toBe("default");
    // an export without the source map (an older wrapper, CoinPoker): every covered seat reads as its own frame
    expect(stackHow(hand({ startStacks: { 3: 149.2 } }), 3)).toBe("frame");
  });

  test("the note names each unconfirmed seat with the figure used; the reason carries the code", () => {
    const list = unconfirmedStacks(hand({ ...ACTED, stacks: { 1: 53.9, 2: 34.2, 3: 77.4 } } as any),
      [{ pos: "HJ", seat: 3, bb: 77.4 }, { pos: "BTN", seat: 6, bb: null }, { pos: "SB", seat: 1, bb: 54.4 }]);
    expect(list).toEqual([{ pos: "HJ", seat: 3, bb: 77.4, how: "screen" }, { pos: "BTN", seat: 6, bb: null, how: "default" }]);
    const note = stackNotConfirmedNote(list)!;
    expect(note.startsWith(`${STACK_NOT_CONFIRMED_TAG} HJ 77.4bb off the screen, BTN unreadable, taken as 100bb`)).toBe(true);
    expect(stackNotConfirmedReason(list)).toMatchObject({ v: "failed", code: STACK_NOT_CONFIRMED_CODE });
    expect(stackNotConfirmedNote([])).toBeNull();
    expect(stackNotConfirmedReason([])).toBeNull();
  });

  test("the register knows the code and the warning", () => {
    expect(departureForCode(STACK_NOT_CONFIRMED_CODE)?.id).toBe("stack-not-confirmed");
    expect(departureForWarning("STACK NOT CONFIRMED")?.id).toBe("stack-not-confirmed");
  });
});

describe("the 6-max chart picker", () => {
  test("hero's screen reading at his first decision is flagged — the rung is what the reading says, as before", () => {
    const c = chartFor6max(hand(ACTED as any), "HJ", ["F"]);
    expect(c.unconfirmed).toEqual([{ pos: "HJ", seat: 3, bb: 77.4, how: "screen" }, { pos: "BTN", seat: 6, bb: 211.8, how: "screen" }]);
    expect(c.note).toContain("STACK NOT CONFIRMED: HJ 77.4bb off the screen, BTN 211.8bb off the screen");
    expect(c.id).toBe("ign200_6max_D75_o2_5");
  });

  test("with every dealt seat carried from the table nothing is flagged, and the rung is the dealt one", () => {
    const c = chartFor6max(hand(CARRIED as any), "HJ", ["F"]);
    expect(c.unconfirmed).toBeUndefined();
    expect(c.note ?? "").not.toContain("STACK NOT CONFIRMED");
    // withStartStacks is the live path's job; here the dealt stacks are read straight (the pinned form)
    expect(chartFor6max(hand(CARRIED as any), "HJ", ["F"], { 1: 54.4, 2: 35.2, 3: 149.2, 4: 100, 6: 219.2 }).id).toBe("ign200_6max_D150_o2_5");
  });

  test("pinned dealt stacks (a later street's read of the preflop pin) are never flagged", () => {
    const c = chartFor6max(hand(ACTED as any), "HJ", ["F"], { 1: 54.4, 2: 35.2, 3: 149.2, 4: 100, 6: 219.2 });
    expect(c.unconfirmed).toBeUndefined();
  });

  test("hero unreadable: the 100bb default is flagged as such", () => {
    const c = chartFor6max(hand({ ...ACTED, stacks: { 1: 53.9, 2: 34.2, 6: 211.8 } } as any), "HJ", ["F"]);
    expect(c.unconfirmed?.[0]).toEqual({ pos: "HJ", seat: 3, bb: null, how: "default" });
    expect(c.note).toContain("HJ unreadable, taken as 100bb");
  });
});

describe("the GTO Wizard AI preflop shape", () => {
  const shape = (h: ParsedHand, dealt?: Record<number, number>) => {
    const s = shapeOf(h, "HJ", 0, undefined, dealt);
    if ("error" in s) throw new Error(s.error);
    return s;
  };
  test("every seat the tree holds that the table did not confirm, the default among them", () => {
    const s = shape(hand({ ...ACTED, stacks: { 1: 53.9, 2: 34.2, 3: 77.4, 6: 211.8 } } as any));
    expect(s.unconfirmed).toEqual([
      { pos: "HJ", seat: 3, bb: 77.4, how: "screen" }, { pos: "CO", seat: 4, bb: null, how: "default" }, { pos: "BTN", seat: 6, bb: 211.8, how: "screen" },
    ]);
    expect(s.stacks.CO).toBe(100);
  });
  test("nothing flagged with the full export, nor on a rebuild from a logged tree", () => {
    expect(shape(hand(CARRIED as any)).unconfirmed).toBeUndefined();
    expect(shape(hand(ACTED as any), { 1: 54.4, 2: 35.2, 3: 149.2, 4: 100, 6: 219.2 }).unconfirmed).toBeUndefined();
  });
});

describe("normalizeHand", () => {
  test("keeps the source map for the seats startStacks holds, drops the rest", () => {
    const h = normalizeHand({ ...base, ...CARRIED, startStacksSource: { ...CARRIED.startStacksSource, 5: "result", 4: "guess" } }).hand;
    expect(h.startStacksSource).toEqual({ 1: "frame", 2: "frame", 3: "result", 6: "result" });
    expect(normalizeHand({ ...base, ...ACTED, startStacksSource: undefined }).hand.startStacksSource).toBeUndefined();
    expect(normalizeHand({ ...base, startStacksSource: { 1: "frame" } }).hand.startStacksSource).toBeUndefined();
  });
});
