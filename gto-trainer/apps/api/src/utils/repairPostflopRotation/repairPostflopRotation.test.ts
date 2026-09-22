import { describe, expect, it } from "bun:test";
import { captureFaults, repairPostflopRotation, rotationFor } from "./repairPostflopRotation";
import type { ParsedHand, ParsedAction } from "../../feed/parsePanelFeed/parsePanelFeed";

const act = (seatId: number, type: string, street: string, amount?: number): ParsedAction =>
  ({ seatId, hero: false, type, street, ...(amount != null ? { amount } : {}) }) as ParsedAction;

const hand = (positions: Record<number, string>, actions: ParsedAction[], live?: number[]): ParsedHand => ({
  handId: 1, heroSeatId: Object.keys(positions).map(Number)[0]!, heroCards: [], board: ["4c", "7s", "Td"],
  street: "flop", actions, liveSeats: live ?? Object.keys(positions).map(Number), committed: {},
  potByStreet: {}, positions,
  currentNode: { street: "flop", toActSeatId: null, toActIsHero: false, pot: 0, toCall: 0, legalActions: [], complete: false },
  ended: false,
}) as ParsedHand;

describe("rotationFor", () => {
  it("orders by postflop position among the live seats", () => {
    const h = hand({ 1: "CO", 2: "BTN", 3: "SB", 4: "BB", 5: "UTG" }, []);
    expect(rotationFor(h, "flop").map((s) => h.positions[s])).toEqual(["SB", "BB", "UTG", "CO", "BTN"]);
  });

  it("heads-up the dealer acts LAST postflop", () => {
    const h = hand({ 1: "SB", 2: "BB" }, []);
    expect(rotationFor(h, "flop").map((s) => h.positions[s])).toEqual(["BB", "SB"]);
  });

  it("blind-versus-blind at a FULL table still has the SB first (hand 4919480043)", () => {
    // four seats dealt, CO and BTN fold preflop: SB is out of position, not the dealer
    const h = hand({ 1: "BB", 3: "CO", 4: "BTN", 6: "SB" },
      [act(3, "fold", "preflop"), act(4, "fold", "preflop")], [1, 3, 4, 6]);
    expect(rotationFor(h, "flop").map((s) => h.positions[s])).toEqual(["SB", "BB"]);
  });

  it("drops seats that folded on an earlier street", () => {
    const h = hand({ 1: "SB", 2: "BB", 3: "UTG" }, [act(1, "fold", "preflop")]);
    expect(rotationFor(h, "flop").map((s) => h.positions[s])).toEqual(["BB", "UTG"]);
  });
});

describe("repairPostflopRotation", () => {
  it("reorders an all-check street into rotation (hand 4919211085's flop)", () => {
    // captured BB>SB>UTG; postflop order is SB>BB>UTG
    const h = hand({ 1: "UTG", 5: "SB", 6: "BB" },
      [act(6, "check", "flop"), act(5, "check", "flop"), act(1, "check", "flop")]);
    const r = repairPostflopRotation(h);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]!.kind).toBe("reordered-checks");
    expect(r.hand.actions.map((a) => h.positions[a.seatId])).toEqual(["SB", "BB", "UTG"]);
  });

  it("does NOT touch a blind-vs-blind turn where the SB legitimately checks first (hand 4919480043)", () => {
    const h = hand({ 1: "BB", 3: "CO", 4: "BTN", 6: "SB" }, [
      act(3, "fold", "preflop"), act(4, "fold", "preflop"),
      act(6, "check", "turn"), act(1, "bet", "turn", 2.4),
    ], [1, 3, 4, 6]);
    const r = repairPostflopRotation(h);
    expect(r.notes).toHaveLength(0);
  });

  it("drops a leading phantom check by a seat that acts again (hand 4919213506's turn)", () => {
    // captured HJ>BB>HJ on the turn; BB acts first, so HJ's opening check is noise
    const h = hand({ 4: "BB", 6: "HJ" },
      [act(6, "check", "turn"), act(4, "bet", "turn", 3.1), act(6, "call", "turn", 3.1)], [4, 6]);
    const r = repairPostflopRotation(h);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]!.kind).toBe("dropped-phantom-check");
    expect(r.hand.actions.map((a) => `${h.positions[a.seatId]}:${a.type}`)).toEqual(["BB:bet", "HJ:call"]);
  });

  it("leaves a correctly ordered street alone, and returns the same object", () => {
    const h = hand({ 4: "BB", 6: "HJ" },
      [act(4, "check", "flop"), act(6, "check", "flop")], [4, 6]);
    const r = repairPostflopRotation(h);
    expect(r.notes).toHaveLength(0);
    expect(r.hand).toBe(h);
  });

  it("NEVER moves an action that commits chips", () => {
    // BB bets out of turn after UTG — money is involved, so this is left for the rotation check to refuse
    const h = hand({ 1: "UTG", 5: "SB", 6: "BB" },
      [act(6, "bet", "flop", 3), act(5, "call", "flop", 3), act(1, "fold", "flop")]);
    const r = repairPostflopRotation(h);
    expect(r.notes).toHaveLength(0);
    expect(r.hand.actions).toBe(h.actions);
  });

  it("drops the phantom even when truncation hides the checker's later action", () => {
    // hero IS the phantom checker and is on the clock: HJ-check > BB-bet, with HJ's call not captured yet
    const h = hand({ 4: "BB", 6: "HJ" },
      [act(6, "check", "turn"), act(4, "bet", "turn", 2)], [4, 6]);
    const r = repairPostflopRotation(h);
    expect(r.notes).toHaveLength(1);
    expect(r.hand.actions.map((a) => `${h.positions[a.seatId]}:${a.type}`)).toEqual(["BB:bet"]);
  });

  it("keeps a leading check when the seat that should act first does NOT act next", () => {
    // UTG checks out of turn, then CO acts — SB, who should have opened, is nowhere: too unclear to repair
    const h = hand({ 1: "UTG", 3: "CO", 5: "SB" },
      [act(1, "check", "flop"), act(3, "bet", "flop", 2)], [1, 3, 5]);
    const r = repairPostflopRotation(h);
    expect(r.notes).toHaveLength(0);
  });

  it("repairs each street independently", () => {
    const h = hand({ 1: "UTG", 5: "SB", 6: "BB" }, [
      act(6, "check", "flop"), act(5, "check", "flop"), act(1, "check", "flop"),
      act(1, "check", "turn"), act(5, "check", "turn"), act(6, "check", "turn"),
    ]);
    const r = repairPostflopRotation(h);
    expect(r.notes.map((x) => x.street)).toEqual(["flop", "turn"]);
    expect(r.hand.actions.filter((a) => a.street === "turn").map((a) => h.positions[a.seatId]))
      .toEqual(["SB", "BB", "UTG"]);
  });
});

describe("captureFaults", () => {
  it("names a street that reopens after a later one", () => {
    const h = hand({ 1: "SB", 3: "CO" },
      [act(3, "bet", "turn", 2), act(1, "check", "flop")]);
    expect(captureFaults(h)[0]).toMatch(/flop actions appear after turn/);
  });

  it("names a seat acting twice in a row on one street", () => {
    const h = hand({ 1: "SB", 3: "CO" },
      [act(1, "check", "turn"), act(1, "call", "turn", 2)]);
    expect(captureFaults(h)[0]).toMatch(/SB acts twice in a row on the turn/);
  });

  it("names a blind posted by the wrong seat (hand 4919432644)", () => {
    const h = hand({ 3: "SB", 4: "BB" }, [act(3, "post-bb", "preflop", 1)], []);
    expect(captureFaults(h).some((f) => /SB posted the big blind/.test(f))).toBe(true);
  });

  it("is silent on a clean capture", () => {
    const h = hand({ 1: "SB", 2: "BB", 3: "CO" },
      [act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(3, "raise", "preflop", 2.5),
       act(1, "fold", "preflop"), act(2, "call", "preflop", 1.5), act(2, "check", "flop"), act(3, "bet", "flop", 2)]);
    expect(captureFaults(h)).toEqual([]);
  });
});

describe("captureFaults — preflop coverage", () => {
  it("names a seat that reached the flop without a preflop action (hand 4919432609)", () => {
    const h = hand({ 1: "SB", 2: "BB", 5: "BTN" },
      [act(1, "post-sb", "preflop", 0.4), act(2, "post-bb", "preflop", 1), act(5, "bet", "flop", 11)], [1, 2, 5]);
    expect(captureFaults(h).some((f) => /BTN reached the flop with no preflop action/.test(f))).toBe(true);
  });

  it("accepts a blind post as that seat's preflop action", () => {
    const h = hand({ 1: "SB", 2: "BB" },
      [act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(1, "call", "preflop", 0.5),
       act(2, "check", "preflop"), act(2, "check", "flop"), act(1, "check", "flop")], [1, 2]);
    expect(captureFaults(h)).toEqual([]);
  });
});

describe("captureFaults — preflop consecutive actors", () => {
  it("names a seat acting twice running preflop (hand 4919432731)", () => {
    const h = hand({ 3: "BTN", 4: "SB" },
      [act(4, "post-sb", "preflop", 0.4), act(3, "bet", "preflop", 0.6), act(3, "check", "preflop")], []);
    expect(captureFaults(h).some((f) => /BTN acts twice in a row on the preflop/.test(f))).toBe(true);
  });

  it("does not mistake a blind post followed by that seat's action for acting twice", () => {
    const h = hand({ 1: "SB", 2: "BB" },
      [act(1, "post-sb", "preflop", 0.5), act(1, "raise", "preflop", 2.5), act(2, "fold", "preflop")], []);
    expect(captureFaults(h)).toEqual([]);
  });
});

describe("captureFaults — preflop checks", () => {
  it("names a non-BB seat checking preflop (hand 4919432731)", () => {
    const h = hand({ 3: "BTN", 5: "BB" }, [act(3, "check", "preflop")], []);
    expect(captureFaults(h).some((f) => /BTN checked preflop/.test(f))).toBe(true);
  });

  it("allows the big blind to check its option", () => {
    const h = hand({ 1: "SB", 2: "BB" },
      [act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(1, "call", "preflop", 0.5), act(2, "check", "preflop")], []);
    expect(captureFaults(h)).toEqual([]);
  });
});
