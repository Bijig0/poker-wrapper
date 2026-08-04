import { describe, expect, it } from "bun:test";
import { parsePanelFeed, type PanelRow } from "../parsePanelFeed/parsePanelFeed";
import { handToSpot } from "./handToSpot";

const rows = (lines: [PanelRow["k"], string][]): PanelRow[] =>
  lines.map(([k, t]) => ({ k, t }));

const SRP_FLOP_VILLAIN_TO_ACT = rows([
  ["info", "New hand — you have A♠ 5♣"],
  ["hero", "You post the small blind 0.5 BB"],
  ["act", "Seat 6 (BB) posts the big blind 1 BB"],
  ["act", "Seat 1 (UTG) folds"],
  ["act", "Seat 3 (HJ) raises to 2.5 BB"],
  ["act", "Seat 4 (CO) folds"],
  ["hero", "You call 2.5 BB"],
  ["act", "Seat 6 (BB) folds"],
  ["street", "FLOP  A♦ 7♣ 2♥ — pot 6 BB"],
  ["status", "FLOP — pot 6 BB — Seat 3 (HJ) to act"],
]);

const SRP_FLOP_FACING_BET = rows([
  ["info", "New hand — you have A♠ 5♣"],
  ["hero", "You post the small blind 0.5 BB"],
  ["act", "Seat 6 (BB) posts the big blind 1 BB"],
  ["act", "Seat 1 (UTG) folds"],
  ["act", "Seat 3 (HJ) raises to 2.5 BB"],
  ["act", "Seat 4 (CO) folds"],
  ["hero", "You call 2.5 BB"],
  ["act", "Seat 6 (BB) folds"],
  ["street", "FLOP  A♦ 7♣ 2♥ — pot 6 BB"],
  ["act", "Seat 3 (HJ) bets 3 BB"],
  ["turn", "YOUR TURN — pot 9 BB — 3 BB to call"],
]);

const parse = (r: PanelRow[]) => parsePanelFeed(r).hand!;

describe("handToSpot", () => {
  it("maps the SRP flop spot onto the navigator contract", () => {
    const out = handToSpot(parse(SRP_FLOP_VILLAIN_TO_ACT));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.spot).toMatchObject({
      setId: "6max",
      depth: 100,
      heroSeat: "SB",
      villainSeat: "HJ",
      potType: "SRP",
      board: "Ad 7c 2h",
      heroHand: "As5c",
      street: "flop",
      villainBetPct: null,
      toAct: "villain",
    });
  });

  it("derives the facing-bet size as % of the pot before the bet", () => {
    const out = handToSpot(parse(SRP_FLOP_FACING_BET));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // villain bet 3 into 6 -> 50% pot
    expect(out.spot.villainBetPct).toBe(50);
    expect(out.spot.toAct).toBe("hero");
  });

  it("classifies a 3-bet pot from two preflop raises", () => {
    const threeBet = rows([
      ["info", "New hand — you have K♥ K♦"],
      ["hero", "You post the big blind 1 BB"],
      ["act", "Seat 4 (SB) posts the small blind 0.5 BB"],
      ["act", "Seat 2 (BTN) raises to 2.5 BB"],
      ["act", "Seat 4 (SB) folds"],
      ["hero", "You raise to 11 BB"],
      ["act", "Seat 2 (BTN) calls 8.5 BB"],
      ["street", "FLOP  9♠ 6♦ 2♣ — pot 22.5 BB"],
      ["turn", "YOUR TURN — pot 22.5 BB"],
    ]);
    const out = handToSpot(parse(threeBet));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.spot.potType).toBe("3bet");
    expect(out.spot.heroSeat).toBe("BB");
    expect(out.spot.villainSeat).toBe("BTN");
  });

  it("defers limped pots, 4-bet pots, multiway flops, and preflop decisions", () => {
    const limped = rows([
      ["info", "New hand — you have 7♦ 6♦"],
      ["hero", "You post the small blind 0.5 BB"],
      ["act", "Seat 6 (BB) posts the big blind 1 BB"],
      ["hero", "You call 0.5 BB"],
      ["act", "Seat 6 (BB) checks"],
      ["street", "FLOP  9♠ 6♦ 2♣ — pot 2 BB"],
      ["turn", "YOUR TURN — pot 2 BB"],
    ]);
    expect(handToSpot(parse(limped))).toMatchObject({ ok: false, reason: expect.stringMatching(/Limped/) });

    const multiway = rows([
      ["info", "New hand — you have A♠ 5♣"],
      ["hero", "You post the small blind 0.5 BB"],
      ["act", "Seat 6 (BB) posts the big blind 1 BB"],
      ["act", "Seat 3 (HJ) raises to 2.5 BB"],
      ["hero", "You call 2.5 BB"],
      ["act", "Seat 6 (BB) calls 1.5 BB"],
      ["street", "FLOP  A♦ 7♣ 2♥ — pot 7.5 BB"],
      ["turn", "YOUR TURN — pot 7.5 BB"],
    ]);
    expect(handToSpot(parse(multiway))).toMatchObject({ ok: false, reason: expect.stringMatching(/heads-up only/) });

    const preflop = parse(rows([
      ["info", "New hand — you have A♠ 5♣"],
      ["hero", "You post the small blind 0.5 BB"],
      ["act", "Seat 6 (BB) posts the big blind 1 BB"],
      ["act", "Seat 3 (HJ) raises to 2.5 BB"],
      ["turn", "YOUR TURN — pot 4 BB — 2 BB to call"],
    ]));
    expect(handToSpot(preflop)).toMatchObject({ ok: false, reason: expect.stringMatching(/preflop/) });
  });

  it("needs heroPos when the rows never show hero posting", () => {
    const noPost = rows([
      ["info", "New hand — you have A♠ 5♣"],
      ["act", "Seat 4 (SB) posts the small blind 0.5 BB"],
      ["act", "Seat 6 (BB) posts the big blind 1 BB"],
      ["act", "Seat 6 (BB) folds"],
      ["act", "Seat 4 (SB) raises to 2.5 BB"],
      ["hero", "You call 2.5 BB"],
      ["street", "FLOP  A♦ 7♣ 2♥ — pot 6 BB"],
      ["status", "FLOP — pot 6 BB — Seat 4 (SB) to act"],
    ]);
    expect(handToSpot(parse(noPost))).toMatchObject({ ok: false, reason: expect.stringMatching(/position/i) });
    const withPos = handToSpot(parse(noPost), { heroPos: "BTN" });
    expect(withPos.ok).toBe(true);
    if (withPos.ok) expect(withPos.spot).toMatchObject({ heroSeat: "BTN", villainSeat: "SB" });
  });

  it("derives depth from hero+villain stacks, snapped to library depths", () => {
    const hand = parse(SRP_FLOP_VILLAIN_TO_ACT);
    // hero seat is -1 in row-parsed hands; stacks keyed by seat id
    hand.stacks = { [-1]: 62, 2: 140, 0: 8 }; // hero 62bb, villain (HJ) 140bb, folded UTG 8bb
    const out = handToSpot(hand, { availableDepths: [20, 40, 50, 75, 100, 150, 200] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // effective = min(62, 140) = 62 → nearest library depth 50... no: |62-50|=12, |62-75|=13 → 50
    expect(out.spot.depth).toBe(50);
    // the folded UTG's 8bb stack must NOT drag the depth to 20
  });

  it("prefers an explicit depth over stack derivation", () => {
    const hand = parse(SRP_FLOP_VILLAIN_TO_ACT);
    hand.stacks = { [-1]: 62, 2: 140 };
    const out = handToSpot(hand, { depth: 200 });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.spot.depth).toBe(200);
  });

  it("carries the hand's actual preflop sizes into the spot", () => {
    const srp = handToSpot(parse(SRP_FLOP_VILLAIN_TO_ACT));
    expect(srp.ok).toBe(true);
    if (srp.ok) {
      expect(srp.spot.openSize).toBe(2.5);
      expect(srp.spot.threeBetSize).toBeNull();
    }

    const threeBet = rows([
      ["info", "New hand — you have K♥ K♦"],
      ["hero", "You post the big blind 1 BB"],
      ["act", "Seat 4 (SB) posts the small blind 0.5 BB"],
      ["act", "Seat 2 (BTN) raises to 2.5 BB"],
      ["act", "Seat 4 (SB) folds"],
      ["hero", "You raise to 11 BB"],
      ["act", "Seat 2 (BTN) calls 8.5 BB"],
      ["street", "FLOP  9♠ 6♦ 2♣ — pot 22.5 BB"],
      ["turn", "YOUR TURN — pot 22.5 BB"],
    ]);
    const out = handToSpot(parse(threeBet));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.spot.openSize).toBe(2.5);
      expect(out.spot.threeBetSize).toBe(11);
    }
  });

  it("flags decisions past the flop as walk-the-rest-manually", () => {
    const turnSpot = rows([
      ["info", "New hand — you have A♠ 5♣"],
      ["hero", "You post the small blind 0.5 BB"],
      ["act", "Seat 6 (BB) posts the big blind 1 BB"],
      ["act", "Seat 3 (HJ) raises to 2.5 BB"],
      ["act", "Seat 6 (BB) folds"],
      ["hero", "You call 2.5 BB"],
      ["street", "FLOP  A♦ 7♣ 2♥ — pot 6 BB"],
      ["hero", "You check"],
      ["act", "Seat 3 (HJ) checks"],
      ["street", "TURN  A♦ 7♣ 2♥ T♠ — pot 6 BB"],
      ["turn", "YOUR TURN — pot 6 BB"],
    ]);
    const out = handToSpot(parse(turnSpot));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.spot.street).toBe("turn");
    expect(out.spot.board).toBe("Ad 7c 2h");
    expect(out.spot.fullBoard).toBe("Ad 7c 2h Ts");
    expect(out.notes.join(" ")).toMatch(/TURN/);
  });
});
