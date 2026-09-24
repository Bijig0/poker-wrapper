import { describe, expect, it } from "bun:test";
import { captureFaults, repairDeadSmallBlind, repairPostflopRotation, rotationFor } from "./repairPostflopRotation";
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

describe("repairDeadSmallBlind", () => {
  const pre = (positions: Record<number, string>, actions: ParsedAction[]): ParsedHand =>
    ({ ...hand(positions, actions), street: "preflop", board: [],
       currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 1, toCall: 1, legalActions: [], complete: false } }) as ParsedHand;

  it("relabels hand 732: the BB poster was called SB, the seat after it BB", () => {
    const h = pre({ 2: "SB", 3: "BB", 4: "HJ", 5: "CO", 6: "BTN" }, [act(2, "post-bb", "preflop", 1), act(3, "fold", "preflop")]);
    const r = repairDeadSmallBlind(h);
    expect(r.note).toMatch(/DEAD SMALL BLIND/);
    expect(r.hand.positions).toEqual({ 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" });
    expect(captureFaults(r.hand)).toEqual([]);
    expect(h.positions[2]).toBe("SB");   // the input is not mutated
  });

  it("relabels a 4-seat and a 3-seat table the same way", () => {
    const four = pre({ 1: "BTN", 3: "SB", 4: "BB", 5: "CO" }, [act(3, "post-bb", "preflop", 1)]);
    expect(repairDeadSmallBlind(four).hand.positions).toEqual({ 1: "BTN", 3: "BB", 4: "HJ", 5: "CO" });
    const three = pre({ 1: "BTN", 3: "SB", 4: "BB" }, [act(3, "post-bb", "preflop", 1)]);
    expect(repairDeadSmallBlind(three).hand.positions).toEqual({ 1: "BTN", 3: "BB", 4: "CO" });
  });

  it("leaves a hand with both blinds posted alone", () => {
    const h = pre({ 2: "SB", 3: "BB", 4: "HJ", 5: "CO", 6: "BTN" }, [act(2, "post-sb", "preflop", 0.5), act(3, "post-bb", "preflop", 1)]);
    expect(repairDeadSmallBlind(h)).toEqual({ hand: h, note: null });
  });

  it("leaves a BB post from a seat not labelled SB alone (hand 718: a new player's post from the button)", () => {
    const h = pre({ 1: "SB", 2: "BB", 4: "BTN" }, [act(4, "post-bb", "preflop", 1), act(1, "fold", "preflop")]);
    expect(repairDeadSmallBlind(h).note).toBeNull();
    expect(captureFaults(h)).toContain("BTN posted the big blind");
  });
});

// -------------------------------------------------------------------------------------------------------------
// PREFLOP ROTATION + UNLABELLED ACTORS + PREFLOP BETS (2026-09-23 hardening pass). Fixtures are archived hands
// (ignition-study-wrapper/data/hands.db dbIds), so each case is a capture that actually happened.
// -------------------------------------------------------------------------------------------------------------
const pre = (positions: Record<number, string>, actions: ParsedAction[], live?: number[]): ParsedHand => ({
  ...hand(positions, actions, live), board: [], street: "preflop",
  currentNode: { street: "preflop", toActSeatId: null, toActIsHero: true, pot: 0, toCall: 1, legalActions: [], complete: false },
}) as ParsedHand;
const rot = (h: ParsedHand) => captureFaults(h).filter((f) => /out of rotation|no position label|bet preflop/.test(f));

describe("captureFaults — preflop rotation", () => {
  it("dbId 583: the SB folds before anyone acted, then the BTN raises — the SB was facing nothing", () => {
    const h = pre({ 4: "SB", 5: "BB", 6: "UTG", 1: "HJ", 2: "CO", 3: "BTN" }, [
      act(4, "post-sb", "preflop", 0.4), act(5, "post-bb", "preflop", 1), act(4, "fold", "preflop"),
      act(3, "raise", "preflop", 6), act(6, "fold", "preflop"), act(2, "call", "preflop", 4.6), act(1, "fold", "preflop"),
    ]);
    expect(rot(h).some((f) => f.includes("SB acted before") && f.includes("out of rotation"))).toBe(true);
  });

  it("dbId 557: the SB BETS preflop after the CO folded — a preflop bet is not a poker action", () => {
    const h = pre({ 3: "SB", 4: "BB", 5: "UTG", 6: "HJ", 1: "CO", 2: "BTN" }, [
      act(3, "post-sb", "preflop", 0.4), act(4, "post-bb", "preflop", 1), act(1, "fold", "preflop"), act(3, "bet", "preflop", 1.4),
    ]);
    expect(rot(h).some((f) => f.includes("bet preflop"))).toBe(true);
  });

  it("a MISSED fold is not a fault: UTG never acts, HJ folds, CO folds, BTN raises (dbId 417)", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(4, "fold", "preflop"), act(5, "fold", "preflop"),
      act(6, "raise", "preflop", 2.5), act(1, "fold", "preflop"), act(2, "call", "preflop", 1.5),
    ]);
    expect(rot(h)).toEqual([]);
  });

  it("a LATE fold is not a fault: UTG's fold filed after everyone else's (dbId 283)", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.4), act(2, "post-bb", "preflop", 1), act(4, "fold", "preflop"), act(5, "fold", "preflop"),
      act(1, "fold", "preflop"), act(2, "fold", "preflop"), act(3, "fold", "preflop"),
    ]);
    expect(rot(h)).toEqual([]);
  });

  it("a skipped seat that later puts chips in IS a fault (HJ raised before UTG, who then calls)", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(4, "raise", "preflop", 2.5), act(3, "call", "preflop", 2.5),
    ]);
    expect(rot(h).some((f) => f.includes("HJ acted before UTG"))).toBe(true);
  });

  it("a seat acting after it folded is a fault", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(3, "fold", "preflop"), act(4, "raise", "preflop", 2.5),
      act(5, "fold", "preflop"), act(6, "fold", "preflop"), act(1, "fold", "preflop"), act(2, "fold", "preflop"), act(3, "call", "preflop", 2.5),
    ]);
    expect(rot(h).some((f) => f.includes("after folding"))).toBe(true);
  });

  it("a clean 3-bet pot with the action coming back around is not a fault", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(3, "raise", "preflop", 2.5), act(4, "fold", "preflop"),
      act(5, "fold", "preflop"), act(6, "raise", "preflop", 8), act(1, "fold", "preflop"), act(2, "fold", "preflop"), act(3, "call", "preflop", 8),
    ]);
    expect(rot(h)).toEqual([]);
  });

  it("heads-up: the dealer (SB) acts first preflop", () => {
    const h = pre({ 1: "SB", 2: "BB" }, [act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(1, "raise", "preflop", 2.5), act(2, "call", "preflop", 1.5)]);
    expect(rot(h)).toEqual([]);
  });

  it("a dead-small-blind hand relabelled from the post (BB, mids, BTN — no SB) anchors on its BB", () => {
    const raw = pre({ 2: "SB", 3: "BB", 4: "UTG", 5: "HJ", 6: "BTN" }, [
      act(2, "post-bb", "preflop", 1), act(4, "fold", "preflop"), act(5, "fold", "preflop"), act(6, "raise", "preflop", 2.5), act(2, "call", "preflop", 1.5),
    ]);
    const fixed = repairDeadSmallBlind(raw).hand;
    expect(fixed.positions[2]).toBe("BB");
    expect(rot(fixed)).toEqual([]);
  });

  it("an unlabelled actor is a fault (dbId 688: two dealt seats acted with no position label)", () => {
    const h = pre({ 6: "SB", 1: "BB" }, [
      act(6, "post-sb", "preflop", 0.5), act(1, "post-bb", "preflop", 1), act(4, "fold", "preflop"), act(5, "raise", "preflop", 2.5),
    ], [1, 4, 5, 6]);
    const f = rot(h);
    expect(f.some((x) => x.includes("seat 4 acted"))).toBe(true);
    expect(f.some((x) => x.includes("seat 5 acted"))).toBe(true);
  });
});

describe("repairPreflopFoldOrder", () => {
  const { repairPreflopFoldOrder } = require("./repairPostflopRotation");
  const seq = (h: ParsedHand) => h.actions.filter((a) => a.street === "preflop").map((a) => `${h.positions[a.seatId]}:${a.type}`);

  it("dbId 734: UTG's and HJ's late folds move back in front of the CO limp", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(5, "call", "preflop", 1), act(3, "fold", "preflop"),
      act(4, "fold", "preflop"), act(6, "raise", "preflop", 4.5), act(1, "fold", "preflop"),
    ]);
    const r = repairPreflopFoldOrder(h);
    expect(r.note).toContain("UTG, HJ");
    expect(seq(r.hand)).toEqual(["SB:post-sb", "BB:post-bb", "UTG:fold", "HJ:fold", "CO:call", "BTN:raise", "SB:fold"]);
    expect(captureFaults(r.hand).filter((f) => /out of rotation/.test(f))).toEqual([]);
  });

  it("dbId 283: a fold filed last goes first", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.4), act(2, "post-bb", "preflop", 1), act(4, "fold", "preflop"), act(5, "fold", "preflop"),
      act(1, "fold", "preflop"), act(2, "fold", "preflop"), act(3, "fold", "preflop"),
    ]);
    const r = repairPreflopFoldOrder(h);
    expect(seq(r.hand).slice(2)).toEqual(["UTG:fold", "HJ:fold", "CO:fold", "SB:fold", "BB:fold"]);
  });

  it("leaves a clean line alone (same object, no note)", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(3, "fold", "preflop"), act(4, "raise", "preflop", 2.5),
      act(5, "fold", "preflop"), act(6, "call", "preflop", 2.5), act(1, "fold", "preflop"),
    ]);
    const r = repairPreflopFoldOrder(h);
    expect(r.note).toBeNull();
    expect(r.hand).toBe(h);
  });

  it("never moves chips: a skipped seat that later calls stops the repair and stays a fault", () => {
    const h = pre({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }, [
      act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1), act(4, "raise", "preflop", 2.5), act(3, "call", "preflop", 2.5),
    ]);
    const r = repairPreflopFoldOrder(h);
    expect(r.note).toBeNull();
    expect(captureFaults(h).some((f) => f.includes("HJ acted before UTG"))).toBe(true);
  });

  it("dbId 583 stays a fault: the SB's fold is not late, it is impossible", () => {
    const h = pre({ 4: "SB", 5: "BB", 6: "UTG", 1: "HJ", 2: "CO", 3: "BTN" }, [
      act(4, "post-sb", "preflop", 0.4), act(5, "post-bb", "preflop", 1), act(4, "fold", "preflop"),
      act(3, "raise", "preflop", 6), act(6, "fold", "preflop"), act(2, "call", "preflop", 4.6), act(1, "fold", "preflop"),
    ]);
    const r = repairPreflopFoldOrder(h);
    // UTG's fold is pulled in front of the SB's, but the SB fold before the BTN raise remains and is still flagged
    expect(captureFaults(r.hand).some((f) => /out of rotation/.test(f))).toBe(true);
  });
});

describe("captureFaults — the line must price hero's decision (CoinPoker hand 140706500001)", () => {
  // heads-up table: seat 2 = hero, the dealer (SB, in position postflop); seat 1 = BB
  const pre = [
    { seatId: 2, hero: true, type: "post-sb", street: "preflop", amount: 0.4 },
    act(1, "post-bb", "preflop", 1),
    { seatId: 2, hero: true, type: "raise", street: "preflop", amount: 2.48 },
    act(1, "raise", "preflop", 10.52),
    { seatId: 2, hero: true, type: "call", street: "preflop", amount: 8.04 },
  ] as ParsedAction[];
  // pot = the table's closed-round pot: 21.44 = 2 x 10.52 + the CoinPoker antes. A fixture with another preflop line
  // passes its own (the pot ledger in lostActionFaults reads it).
  const hu = (actions: ParsedAction[], toCall: number, positions: Record<number, string> = { 2: "SB", 1: "BB" }, heroSeatId = 2, pot = 21.44): ParsedHand => ({
    handId: 1, heroSeatId, heroCards: ["8c", "7c"], board: ["4c", "6d", "5s"], street: "flop", actions,
    liveSeats: Object.keys(positions).map(Number), committed: {}, potByStreet: {}, positions,
    currentNode: { street: "flop", toActSeatId: heroSeatId, toActIsHero: true, pot, toCall, legalActions: [], complete: false },
    ended: false,
  }) as ParsedHand;

  it("names the lost bet: the table says hero faces 21.44bb, the captured flop has no bet", () => {
    const f = captureFaults(hu(pre, 21.44));
    expect(f.some((x) => /hero facing 21.44bb on the flop, but no bet or raise on the flop was captured/.test(x))).toBe(true);
    expect(f.some((x) => /BB acts first on the flop heads-up, but no flop action of theirs was captured/.test(x))).toBe(true);
  });

  it("is silent once the villain's bet is in the line (the reader fix)", () => {
    expect(captureFaults(hu([...pre, act(1, "bet", "flop", 21.44)], 21.44))).toEqual([]);
  });

  it("names a lost CHECK — nothing to call, so only the seating can tell", () => {
    const f = captureFaults(hu(pre, 0));
    expect(f).toEqual(["BB acts first on the flop heads-up, but no flop action of theirs was captured before hero's decision"]);
    expect(captureFaults(hu([...pre, act(1, "check", "flop")], 0))).toEqual([]);
  });

  it("is silent when hero is out of position and first to act", () => {
    const pre2 = [
      act(2, "post-sb", "preflop", 0.5), { seatId: 1, hero: true, type: "post-bb", street: "preflop", amount: 1 },
      act(2, "raise", "preflop", 2.5), { seatId: 1, hero: true, type: "call", street: "preflop", amount: 1.5 },
    ] as ParsedAction[];
    expect(captureFaults(hu(pre2, 0, { 2: "SB", 1: "BB" }, 1, 5))).toEqual([]);
  });

  it("blind versus blind at a full table: the SB acts first, so hero in the BB needs the SB's action", () => {
    const pos = { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" };
    const bvb = [
      act(1, "post-sb", "preflop", 0.5), { seatId: 2, hero: true, type: "post-bb", street: "preflop", amount: 1 },
      act(3, "fold", "preflop"), act(4, "fold", "preflop"), act(5, "fold", "preflop"), act(6, "fold", "preflop"),
      act(1, "call", "preflop", 0.5), { seatId: 2, hero: true, type: "check", street: "preflop" },
    ] as ParsedAction[];
    const h = (actions: ParsedAction[]) => ({ ...hu(actions, 0, pos, 2, 2), liveSeats: [1, 2, 3, 4, 5, 6] }) as ParsedHand;
    expect(captureFaults(h(bvb))[0]).toMatch(/SB acts first on the flop heads-up/);
    expect(captureFaults(h([...bvb, act(1, "check", "flop")]))).toEqual([]);
  });
});
