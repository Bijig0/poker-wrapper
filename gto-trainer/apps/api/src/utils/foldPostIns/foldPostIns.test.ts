import { describe, expect, it } from "bun:test";
import { foldPostIns, postInNote, deadPostsBb } from "./foldPostIns";
import { normalizeHand } from "../../feed/normalizeHand/normalizeHand";
import { shapeOf } from "../../services/gtowAiPreflop";
import type { ParsedAction } from "../../feed/parsePanelFeed/parsePanelFeed";

const act = (seatId: number, type: string, amount?: number, street = "preflop", hero = false): ParsedAction =>
  ({ seatId, hero, type, street, ...(amount != null ? { amount } : {}) }) as ParsedAction;

// hand 4920414446 (56o, 2026-09-25) as the wrapper exports it once post-ins are recorded: HJ (1) and CO (2) post 1bb
// each, UTG (6) folds, both posters check their option, SB (4) folds, hero BB (5) to act
const HAND_937 = [
  act(4, "post-sb", 0.4), act(5, "post-bb", 1), act(1, "post", 1), act(2, "post", 1),
  act(6, "fold"), act(1, "check"), act(2, "check"), act(4, "fold"),
];

describe("foldPostIns", () => {
  it("reads a poster's option-check as a limp and takes the post out of the line (hand 4920414446)", () => {
    const { actions, postIns } = foldPostIns(HAND_937);
    expect(actions.map((a) => `${a.seatId}:${a.type}${a.amount != null ? ` ${a.amount}` : ""}`)).toEqual([
      "4:post-sb 0.4", "5:post-bb 1", "6:fold", "1:call 1", "2:call 1", "4:fold",
    ]);
    expect(postIns).toEqual([
      { seatId: 1, hero: false, amount: 1, readAs: "limp" },
      { seatId: 2, hero: false, amount: 1, readAs: "limp" },
    ]);
  });

  it("carries a live post into the poster's call — chips unchanged (hand 4920414607, the 8bb CO's 0.4bb post)", () => {
    const { actions, postIns } = foldPostIns([
      act(5, "post-sb", 0.4), act(6, "post-bb", 1), act(3, "post", 0.4),
      act(1, "call", 1), act(2, "raise", 4), act(3, "call", 3.6), act(4, "fold"),
    ]);
    expect(actions.find((a) => a.seatId === 3)).toMatchObject({ type: "call", amount: 4 });
    expect(postIns[0]!.readAs).toBe("call");
  });

  // Brady 2026-09-25: "a post becomes a limp if before us, a call if the person calls, a raise if they raise"
  it("UTG opens 2.5 and the HJ poster calls: the HJ reads as an ordinary cold-caller of 2.5", () => {
    const { actions, postIns } = foldPostIns([
      act(4, "post-sb", 0.5), act(5, "post-bb", 1), act(1, "post", 1),
      act(6, "raise", 2.5), act(1, "call", 1.5), act(2, "fold"),
    ]);
    expect(actions.map((a) => `${a.seatId}:${a.type}${a.amount != null ? ` ${a.amount}` : ""}`))
      .toEqual(["4:post-sb 0.5", "5:post-bb 1", "6:raise 2.5", "1:call 2.5", "2:fold"]);
    expect(postIns[0]!.readAs).toBe("call");
  });

  it("leaves a raise total alone, keeps a folder's fold, and a poster yet to act stays pending", () => {
    const raise = foldPostIns([act(4, "post-sb", 0.5), act(5, "post-bb", 1), act(1, "post", 1), act(6, "fold"), act(1, "raise", 3.5)]);
    expect(raise.actions.at(-1)).toMatchObject({ type: "raise", amount: 3.5 });
    const fold = foldPostIns([act(4, "post-sb", 0.5), act(5, "post-bb", 1), act(1, "post", 1), act(6, "raise", 2.5), act(1, "fold")]);
    expect(fold.actions.at(-1)).toMatchObject({ type: "fold" });
    expect(fold.postIns[0]!.readAs).toBe("fold");
    const pending = foldPostIns([act(4, "post-sb", 0.5), act(5, "post-bb", 1), act(1, "post", 1), act(6, "fold")]);
    expect(pending.actions.some((a) => a.type === "post")).toBe(false);
    expect(pending.postIns[0]!.readAs).toBe("pending");
  });

  it("never touches a hand without posts, nor a poster's postflop actions", () => {
    const plain = [act(4, "post-sb", 0.5), act(5, "post-bb", 1), act(1, "check", undefined, "flop")];
    expect(foldPostIns(plain).actions).toBe(plain);
    const later = foldPostIns([...HAND_937, act(5, "check"), act(5, "check", undefined, "flop"), act(1, "check", undefined, "flop")]);
    expect(later.actions.filter((a) => a.street === "flop").map((a) => a.type)).toEqual(["check", "check"]);
  });

  // round 2 (harness post-in, seed 8): the HJ posts 1bb and folds to hero's open; the flop pot was 1bb short of the
  // table's — the dead post is in the middle, and no token carries it
  it("deadPostsBb: a folded poster's post is dead money in the pot; a carried post is not counted twice", () => {
    const folded = foldPostIns([act(4, "post-sb", 0.5), act(5, "post-bb", 1), act(1, "post", 1), act(6, "raise", 2.5), act(1, "fold")]);
    expect(deadPostsBb(folded.postIns)).toBe(1);
    expect(deadPostsBb(foldPostIns(HAND_937).postIns)).toBe(0);            // two limps: the posts ride on the calls
    expect(deadPostsBb(undefined)).toBe(0);
    expect(postInNote(folded.postIns, { 1: "HJ" })).toContain("HJ posted 1bb and folded, 1bb left in the pot as dead money");
  });

  it("says it is an approximation", () => {
    const note = postInNote(foldPostIns(HAND_937).postIns, { 1: "HJ", 2: "CO" })!;
    expect(note).toContain("POSTED IN (approximation)");
    expect(note).toContain("HJ posted 1bb and checked his option — read as a LIMP");
  });
});

describe("normalizeHand with post-ins", () => {
  const raw = {
    handId: 19, clientHandId: "4920414446", heroSeatId: 5, heroCards: ["5♥", "6♠"], board: [], street: "preflop",
    actions: HAND_937.map((a) => ({ seatId: a.seatId, hero: a.seatId === 5, type: a.type, street: a.street, ...(a.amount != null ? { amount: a.amount } : {}) })),
    liveSeats: [1, 2, 4, 5, 6], committed: {}, potByStreet: {},
    positions: { 4: "SB", 5: "BB", 6: "UTG", 1: "HJ", 2: "CO", 3: "BTN" },
    stacks: { 1: 29, 2: 99, 3: 8, 4: 93.8, 5: 98.6, 6: 125 },
    currentNode: { street: "preflop", toActSeatId: 5, toActIsHero: true, pot: 3.4, toCall: 0, legalActions: [], complete: false },
    ended: false,
  };

  it("accepts the post type and hands every consumer an ordinary line", () => {
    const { hand } = normalizeHand(raw);
    expect(hand.actions.some((a) => (a.type as string) === "post")).toBe(false);
    expect(hand.postIns?.map((p) => p.readAs)).toEqual(["limp", "limp"]);
  });

  // the same hand's BTN (seat 3) was sitting out: labelled by the wrapper, never dealt, never acted
  it("builds the AI tree without a seat that was not dealt (hand 937's phantom 100bb BTN)", () => {
    const { hand } = normalizeHand(raw);
    const shape = shapeOf(hand, "BB");
    if ("error" in shape) throw new Error(shape.error);
    expect(shape.n).toBe(5);
    expect(Object.values(shape.seatOf)).not.toContain(3);
    // a FOLDED seat is still dealt, and a source that sends only unfolded seats in liveSeats must not lose it
    const { hand: h2 } = normalizeHand({ ...raw, liveSeats: [1, 2, 5] });
    const s2 = shapeOf(h2, "BB");
    if ("error" in s2) throw new Error(s2.error);
    expect(Object.values(s2.seatOf).sort()).toEqual([1, 2, 4, 5, 6]);
  });
});
