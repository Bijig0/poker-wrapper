import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  parsePanelFeed,
  renderPanelRows,
  rowsFromText,
  toShortCard,
  type PanelRow,
  type ParsedHand,
} from "./parsePanelFeed";

// ---------------------------------------------------------------------------
// Fixtures: the worked example from the panel live-feed pipeline doc, verbatim.
// ---------------------------------------------------------------------------

const POLL_1: PanelRow[] = [
  { k: "info", t: "New hand — you have A♠ 5♣" },
  { k: "hero", t: "You post the small blind 0.5 BB" },
  { k: "act", t: "Seat 6 (BB) posts the big blind 1 BB" },
  { k: "status", t: "PREFLOP — pot 1.5 BB" },
];

const POLL_3: PanelRow[] = [
  { k: "info", t: "New hand — you have A♠ 5♣" },
  { k: "hero", t: "You post the small blind 0.5 BB" },
  { k: "act", t: "Seat 6 (BB) posts the big blind 1 BB" },
  { k: "act", t: "Seat 1 (UTG) folds" },
  { k: "act", t: "Seat 3 (HJ) raises to 2.5 BB" },
  { k: "status", t: "PREFLOP — pot 4 BB" },
];

const POLL_4: PanelRow[] = [
  { k: "info", t: "New hand — you have A♠ 5♣" },
  { k: "hero", t: "You post the small blind 0.5 BB" },
  { k: "act", t: "Seat 6 (BB) posts the big blind 1 BB" },
  { k: "act", t: "Seat 1 (UTG) folds" },
  { k: "act", t: "Seat 3 (HJ) raises to 2.5 BB" },
  { k: "act", t: "Seat 4 (CO) folds" },
  { k: "turn", t: "YOUR TURN — pot 4.5 BB — 2 BB to call" },
];

const POLL_5: PanelRow[] = [
  { k: "info", t: "New hand — you have A♠ 5♣" },
  { k: "hero", t: "You post the small blind 0.5 BB" },
  { k: "act", t: "Seat 6 (BB) posts the big blind 1 BB" },
  { k: "act", t: "Seat 1 (UTG) folds" },
  { k: "act", t: "Seat 3 (HJ) raises to 2.5 BB" },
  { k: "act", t: "Seat 4 (CO) folds" },
  { k: "hero", t: "You call 2.5 BB" },
  { k: "act", t: "Seat 6 (BB) folds" },
  { k: "street", t: "FLOP  A♦ 7♣ 2♥ — pot 6 BB" },
  { k: "status", t: "FLOP — pot 6 BB — Seat 3 (HJ) to act" },
];

// POLL 6 = POLL 5 with the BB post re-seated in place (rebuild, not append)
const POLL_6: PanelRow[] = POLL_5.map((r, i) =>
  i === 2 ? { k: "act" as const, t: "Seat 2 (BB) posts the big blind 1 BB" } : r
);

const POLL_7: PanelRow[] = [
  { k: "info", t: "New hand — you have A♠ 5♣" },
  { k: "hero", t: "You post the small blind 0.5 BB" },
  { k: "act", t: "Seat 2 (BB) posts the big blind 1 BB" },
  { k: "act", t: "Seat 1 (UTG) folds" },
  { k: "act", t: "Seat 3 (HJ) raises to 2.5 BB" },
  { k: "act", t: "Seat 4 (CO) folds" },
  { k: "hero", t: "You call 2.5 BB" },
  { k: "act", t: "Seat 6 (BB) folds" },
  { k: "street", t: "FLOP  A♦ 7♣ 2♥ — pot 6 BB" },
  { k: "hero", t: "You bet 3 BB" },
  { k: "act", t: "Seat 3 (HJ) folds" },
  { k: "result", t: "Player 5 wins ($6.00)." },
];

const POLL_8: PanelRow[] = [
  { k: "info", t: "New hand — you have K♥ Q♥" },
  { k: "hero", t: "You post the big blind 1 BB" },
  { k: "act", t: "Seat 4 (SB) posts the small blind 0.5 BB" },
  { k: "status", t: "PREFLOP — pot 1.5 BB" },
];

const ALL_POLLS: [string, PanelRow[]][] = [
  ["poll 1 (blinds)", POLL_1],
  ["poll 3 (open raise)", POLL_3],
  ["poll 4 (hero to act)", POLL_4],
  ["poll 5 (flop dealt)", POLL_5],
  ["poll 6 (in-place correction)", POLL_6],
  ["poll 7 (hand ended)", POLL_7],
  ["poll 8 (next deal)", POLL_8],
];

describe("parsePanelFeed round trip", () => {
  // The strongest property: parse the rows, re-render them, get the byte-
  // identical list back. Everything the feed shows survives the round trip.
  for (const [name, rows] of ALL_POLLS) {
    it(`re-renders ${name} identically`, () => {
      const { hand, warnings } = parsePanelFeed(rows);
      expect(warnings).toEqual([]);
      expect(renderPanelRows(hand)).toEqual(rows);
    });
  }

  it("re-renders the waiting state identically", () => {
    const rows: PanelRow[] = [{ k: "info", t: "Waiting for the next hand…" }];
    const { hand } = parsePanelFeed(rows);
    expect(hand).toBeNull();
    expect(renderPanelRows(hand)).toEqual(rows);
  });
});

describe("parsePanelFeed semantics", () => {
  it("recovers hero cards, actions, and the live node from poll 4", () => {
    const { hand } = parsePanelFeed(POLL_4);
    expect(hand).not.toBeNull();
    expect(hand!.heroCards).toEqual(["As", "5c"]);
    expect(hand!.street).toBe("preflop");
    expect(hand!.positions).toEqual({ 0: "UTG", 2: "HJ", 3: "CO", 5: "BB" });
    expect(hand!.actions).toEqual([
      { seatId: -1, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
      { seatId: 5, hero: false, type: "post-bb", amount: 1, street: "preflop" },
      { seatId: 0, hero: false, type: "fold", street: "preflop" },
      { seatId: 2, hero: false, type: "raise", amount: 2.5, street: "preflop" },
      { seatId: 3, hero: false, type: "fold", street: "preflop" },
    ]);
    expect(hand!.currentNode).toMatchObject({
      toActIsHero: true,
      pot: 4.5,
      toCall: 2,
      complete: false,
    });
    expect(hand!.ended).toBe(false);
  });

  it("recovers the board, per-street pot, and villain-to-act from poll 5", () => {
    const { hand } = parsePanelFeed(POLL_5);
    expect(hand!.board).toEqual(["Ad", "7c", "2h"]);
    expect(hand!.street).toBe("flop");
    expect(hand!.potByStreet).toEqual({ flop: 6 });
    expect(hand!.currentNode).toMatchObject({
      street: "flop",
      toActSeatId: 2,
      toActIsHero: false,
      pot: 6,
    });
    // flop actions landed on the flop street
    expect(hand!.actions.filter((a) => a.street === "flop")).toEqual([]);
  });

  it("applies the poll-6 correction because parsing is stateless", () => {
    const before = parsePanelFeed(POLL_5).hand!;
    const after = parsePanelFeed(POLL_6).hand!;
    expect(before.actions[1]).toMatchObject({ seatId: 5, type: "post-bb" });
    expect(after.actions[1]).toMatchObject({ seatId: 1, type: "post-bb" });
    expect(after.positions[1]).toBe("BB");
  });

  it("marks poll 7 ended with its result and frozen node", () => {
    const { hand } = parsePanelFeed(POLL_7);
    expect(hand!.ended).toBe(true);
    expect(hand!.result).toEqual({ text: "Player 5 wins ($6.00)." });
    expect(hand!.currentNode.complete).toBe(true);
    expect(hand!.actions.filter((a) => a.street === "flop")).toEqual([
      { seatId: -1, hero: true, type: "bet", amount: 3, street: "flop" },
      { seatId: 2, hero: false, type: "fold", street: "flop" },
    ]);
  });
});

describe("rowsFromText (manual hand-history entry)", () => {
  it("classifies pasted plain lines back into the same rows", () => {
    const text = POLL_7.map((r) => r.t).join("\n");
    expect(rowsFromText(text)).toEqual(POLL_7);
  });

  it("parses pasted text to the same hand as the JSON rows", () => {
    const text = POLL_5.map((r) => r.t).join("\n");
    const fromText = parsePanelFeed(rowsFromText(text));
    const fromRows = parsePanelFeed(POLL_5);
    expect(fromText.hand).toEqual(fromRows.hand!);
  });

  it("accepts letter-suit cards in manual input", () => {
    expect(toShortCard("as")).toBe("As");
    expect(toShortCard("A♠")).toBe("As");
    expect(toShortCard("ace of spades")).toBe("As");
  });
});

// ---------------------------------------------------------------------------
// Pin renderPanelRows to the REAL panelFeed from poker/assistive-play. If that
// repo is reachable (sibling checkout or ASSISTIVE_PLAY_DIR), any format drift
// upstream fails here instead of silently breaking ingestion.
// ---------------------------------------------------------------------------

const assistivePlayDir =
  process.env.ASSISTIVE_PLAY_DIR ??
  join(import.meta.dir, "..", "..", "..", "..", "..", "..", "assistive-play");

describe("renderPanelRows matches the real panelFeed", () => {
  const available = existsSync(join(assistivePlayDir, "src/state/hand/panelFeed/panelFeed.ts"));
  const fixture: ParsedHand = {
    handId: 7,
    heroSeatId: 4,
    heroCards: ["As", "5c"],
    board: ["Ad", "7c", "2h"],
    street: "flop",
    actions: [
      { seatId: 4, hero: true, type: "post-sb", amount: 0.5, street: "preflop" },
      { seatId: 5, hero: false, type: "post-bb", amount: 1, street: "preflop" },
      { seatId: 0, hero: false, type: "fold", street: "preflop" },
      { seatId: 2, hero: false, type: "raise", amount: 2.5, street: "preflop" },
      { seatId: 4, hero: true, type: "call", amount: 2.5, street: "preflop" },
      { seatId: 5, hero: false, type: "fold", street: "preflop" },
      { seatId: 4, hero: true, type: "bet", amount: 3, street: "flop" },
    ],
    liveSeats: [2, 4],
    committed: {},
    potByStreet: { flop: 6 },
    positions: { 0: "UTG", 2: "HJ", 4: "SB", 5: "BB" },
    currentNode: {
      street: "flop",
      toActSeatId: 2,
      toActIsHero: false,
      pot: 9,
      toCall: 3,
      legalActions: [],
      complete: false,
    },
    ended: false,
  };

  it.skipIf(!available)("renders a live-shaped Hand identically to assistive-play", async () => {
    const mod = await import(join(assistivePlayDir, "src/state/hand/panelFeed/panelFeed.ts"));
    expect(renderPanelRows(fixture)).toEqual(mod.panelFeed(fixture));
  });

  it.skipIf(!available)("round-trips the real panelFeed output", async () => {
    const mod = await import(join(assistivePlayDir, "src/state/hand/panelFeed/panelFeed.ts"));
    const rows = mod.panelFeed(fixture) as PanelRow[];
    const { hand, warnings } = parsePanelFeed(rows);
    expect(warnings).toEqual([]);
    expect(renderPanelRows(hand)).toEqual(rows);
  });
});
