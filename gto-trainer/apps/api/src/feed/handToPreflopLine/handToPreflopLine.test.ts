import { describe, expect, it } from "bun:test";
import { parsePanelFeed, type PanelRow } from "../parsePanelFeed/parsePanelFeed";
import { handToPreflopLine } from "./handToPreflopLine";

const rows = (lines: [PanelRow["k"], string][]): PanelRow[] =>
  lines.map(([k, t]) => ({ k, t }));

const parse = (r: PanelRow[]) => parsePanelFeed(r).hand!;

describe("handToPreflopLine", () => {
  it("expresses the actions before hero's turn as a walkable line", () => {
    const hand = parse(
      rows([
        ["info", "New hand — you have A♠ 5♣"],
        ["hero", "You post the small blind 0.5 BB"],
        ["act", "Seat 6 (BB) posts the big blind 1 BB"],
        ["act", "Seat 1 (UTG) folds"],
        ["act", "Seat 3 (HJ) raises to 2.5 BB"],
        ["act", "Seat 4 (CO) folds"],
        ["turn", "YOUR TURN — pot 4.5 BB — 2 BB to call"],
      ])
    );
    const out = handToPreflopLine(hand);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // posts excluded; folds and the sized raise in order
    expect(out.line).toEqual([
      { kind: "fold", sizeBb: null, hero: false, seatId: 0, pos: "UTG" },
      { kind: "raise", sizeBb: 2.5, hero: false, seatId: 2, pos: "HJ" },
      { kind: "fold", sizeBb: null, hero: false, seatId: 3, pos: "CO" },
    ]);
    expect(out.heroHand).toBe("As5c");
    expect(out.toCall).toBe(2);
  });

  it("declines when it isn't hero's preflop turn", () => {
    const postflop = parse(
      rows([
        ["info", "New hand — you have A♠ 5♣"],
        ["hero", "You post the small blind 0.5 BB"],
        ["act", "Seat 6 (BB) posts the big blind 1 BB"],
        ["act", "Seat 3 (HJ) raises to 2.5 BB"],
        ["hero", "You call 2.5 BB"],
        ["act", "Seat 6 (BB) folds"],
        ["street", "FLOP  A♦ 7♣ 2♥ — pot 6 BB"],
        ["turn", "YOUR TURN — pot 6 BB"],
      ])
    );
    expect(handToPreflopLine(postflop)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/preflop decision/),
    });

    const villainTurn = parse(
      rows([
        ["info", "New hand — you have A♠ 5♣"],
        ["hero", "You post the small blind 0.5 BB"],
        ["act", "Seat 6 (BB) posts the big blind 1 BB"],
        ["status", "PREFLOP — pot 1.5 BB"],
      ])
    );
    expect(handToPreflopLine(villainTurn).ok).toBe(false);
  });

  it("declines once hero folded", () => {
    const folded = parse(
      rows([
        ["info", "New hand — you have 7♦ 2♣"],
        ["hero", "You post the small blind 0.5 BB"],
        ["act", "Seat 6 (BB) posts the big blind 1 BB"],
        ["act", "Seat 3 (HJ) raises to 2.5 BB"],
        ["hero", "You fold"],
        ["turn", "YOUR TURN — pot 4 BB"],
      ])
    );
    expect(handToPreflopLine(folded)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/folded/),
    });
  });
});
