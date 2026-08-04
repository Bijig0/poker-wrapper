import { describe, expect, it } from "bun:test";
import { parsePanelFeed, type PanelRow } from "../parsePanelFeed/parsePanelFeed";
import { buildSolutionUrl, actionToken, buildPreflopTokens, buildSpotSolutionTokens } from "./buildSolutionUrl";

const rows = (lines: [PanelRow["k"], string][]): PanelRow[] =>
  lines.map(([k, t]) => ({ k, t }));
const parse = (r: PanelRow[]) => parsePanelFeed(r).hand!;

describe("actionToken", () => {
  it("maps each action type to its URL token", () => {
    const mk = (type: string, amount?: number) =>
      actionToken({ seatId: 0, hero: false, type: type as never, amount, street: "flop" });
    expect(mk("post-sb", 0.5)).toBeNull();
    expect(mk("post-bb", 1)).toBeNull();
    expect(mk("fold")).toBe("F");
    expect(mk("check")).toBe("X");
    expect(mk("call", 3)).toBe("C");
    expect(mk("bet", 2)).toBe("R2");
    expect(mk("raise", 2.5)).toBe("R2.5");
    expect(mk("all-in", 97.5)).toBe("RAI");
    expect(mk("bet", 2.5)).toBe("R2.5"); // trailing zero trimmed
  });
});

describe("buildSolutionUrl", () => {
  const FACING_FLOP_BET = parse(
    rows([
      ["info", "New hand — you have K♥ Q♥"],
      ["hero", "You post the small blind 0.5 BB"],
      ["act", "Seat 6 (BB) posts the big blind 1 BB"],
      ["act", "Seat 1 (UTG) folds"],
      ["act", "Seat 2 (CO) folds"],
      ["act", "Seat 3 (BTN) raises to 2.5 BB"],
      ["hero", "You call 2.5 BB"],
      ["act", "Seat 6 (BB) folds"],
      ["street", "FLOP  T♠ 7♥ 2♦ — pot 6 BB"],
      ["hero", "You check"],
      ["act", "Seat 3 (BTN) bets 2 BB"],
      ["turn", "YOUR TURN — pot 8 BB — 2 BB to call"],
    ])
  );

  it("encodes the whole line into one URL, positionally, posts excluded", () => {
    const r = buildSolutionUrl({
      gametype: "Cash6m500zGeneral",
      depth: 100,
      hand: FACING_FLOP_BET,
    });
    expect(r.board).toBe("Ts7h2d");
    // this hand has no HJ seat — the positional builder inserts HJ's fold so
    // BTN's raise lands on BTN, not CO: UTG F, HJ F, CO F, BTN R2.5, hero C, BB F
    expect(r.tokens.preflop).toEqual(["F", "F", "F", "R2.5", "C", "F"]);
    // flop: hero check X, BTN bet 2 → R2
    expect(r.tokens.flop).toEqual(["X", "R2"]);
    const u = new URL(r.url);
    expect(u.pathname).toBe("/solutions");
    expect(u.searchParams.get("preflop_actions")).toBe("F-F-F-R2.5-C-F");
    expect(u.searchParams.get("board")).toBe("Ts7h2d");
    expect(u.searchParams.get("flop_actions")).toBe("X-R2");
    expect(u.searchParams.has("turn_actions")).toBe(false);
  });

  it("buildSpotSolutionTokens splits per-street tokens + board for the spot-solution API", () => {
    const tk = buildSpotSolutionTokens(FACING_FLOP_BET);
    expect(tk.board).toBe("Ts7h2d");
    expect(tk.preflop).toEqual(["F", "F", "F", "R2.5", "C", "F"]);
    expect(tk.flop).toEqual(["X", "R2"]);
    expect(tk.turn).toEqual([]);
    expect(tk.river).toEqual([]);
  });

  it("stops the preflop line at hero's pending seat, leaving it active", () => {
    const heroBbPending = parse(
      rows([
        ["info", "New hand — you have A♠ K♠"],
        ["act", "Seat 4 (SB) posts the small blind 0.5 BB"],
        ["hero", "You post the big blind 1 BB"],
        ["act", "Seat 1 (UTG) folds"],
        ["act", "Seat 2 (HJ) folds"],
        ["act", "Seat 3 (CO) folds"],
        ["act", "Seat 6 (BTN) raises to 2.5 BB"],
        ["act", "Seat 4 (SB) folds"],
        ["turn", "YOUR TURN — pot 4 BB — 1.5 BB to call"],
      ])
    );
    // UTG F, HJ F, CO F, BTN R2.5, SB F, then STOP before hero's BB node
    expect(buildPreflopTokens(heroBbPending)).toEqual(["F", "F", "F", "R2.5", "F"]);
  });

  it("appends 3-bet responses after the opening orbit", () => {
    const threeBet = parse(
      rows([
        ["info", "New hand — you have K♥ K♦"],
        ["hero", "You post the big blind 1 BB"],
        ["act", "Seat 4 (SB) posts the small blind 0.5 BB"],
        ["act", "Seat 1 (UTG) folds"],
        ["act", "Seat 2 (HJ) folds"],
        ["act", "Seat 3 (CO) folds"],
        ["act", "Seat 6 (BTN) raises to 2.5 BB"],
        ["act", "Seat 4 (SB) raises to 11 BB"],
        ["hero", "You fold"],
        ["act", "Seat 6 (BTN) calls 8.5 BB"],
        ["street", "FLOP  9♠ 6♦ 2♣ — pot 23 BB"],
        ["status", "FLOP — pot 23 BB — Seat 4 (SB) to act"],
      ])
    );
    // opening orbit UTG F, HJ F, CO F, BTN R2.5, SB R11, BB(hero) F,
    // then BTN's call in the next orbit
    expect(buildPreflopTokens(threeBet)).toEqual(["F", "F", "F", "R2.5", "R11", "F", "C"]);
  });

  it("needs an explicit heroPos when hero never posts a blind (e.g. BTN)", () => {
    const btnOpensBbCalls = parse(
      rows([
        ["info", "New hand — you have K♥ Q♠"],
        ["act", "Seat 1 (UTG) folds"],
        ["act", "Seat 2 (HJ) folds"],
        ["act", "Seat 3 (CO) folds"],
        ["hero", "You raise to 2.5 BB"],
        ["act", "Seat 5 (SB) folds"],
        ["act", "Seat 6 (BB) calls 2.5 BB"],
        ["street", "FLOP  9♥ 5♠ 2♣ — pot 5.5 BB"],
        ["act", "Seat 6 (BB) checks"],
        ["turn", "YOUR TURN — pot 5.5 BB"],
      ])
    );
    // even without an override, hero's unlabeled raise is consumed in orbit
    // order — the three labeled folds (UTG/HJ/CO) match first, so hero's action
    // lands on the next slot (BTN) as intended. (Previously this desynced into a
    // corrupt 9-token line; the orbit-order fallback now places it correctly.)
    expect(buildPreflopTokens(btnOpensBbCalls)).toEqual([
      "F", "F", "F", "R2.5", "F", "C",
    ]);
    // an explicit heroPos gives the same result, unambiguously
    expect(buildPreflopTokens(btnOpensBbCalls, "BTN")).toEqual([
      "F", "F", "F", "R2.5", "F", "C",
    ]);
    const r = buildSolutionUrl({
      gametype: "Cash6m500zGeneral",
      depth: 100,
      hand: btnOpensBbCalls,
      heroPos: "BTN",
    });
    expect(r.tokens.preflop).toEqual(["F", "F", "F", "R2.5", "F", "C"]);
  });

  it("omits board and street params when there's no board yet", () => {
    const preflopSpot = parse(
      rows([
        ["info", "New hand — you have A♠ K♠"],
        ["hero", "You post the small blind 0.5 BB"],
        ["act", "Seat 6 (BB) posts the big blind 1 BB"],
        ["act", "Seat 3 (BTN) raises to 2.5 BB"],
        ["turn", "YOUR TURN — pot 4 BB — 2 BB to call"],
      ])
    );
    const r = buildSolutionUrl({
      origin: "https://app.gtowizard.com",
      gametype: "Cash6m500zGeneral",
      depth: 100,
      hand: preflopSpot,
    });
    expect(r.board).toBe("");
    // positional: UTG/HJ/CO fold to reach BTN's open, then STOP at hero's SB node
    expect(r.tokens.preflop).toEqual(["F", "F", "F", "R2.5"]);
    const u = new URL(r.url);
    expect(u.searchParams.get("preflop_actions")).toBe("F-F-F-R2.5");
    expect(u.searchParams.has("board")).toBe(false);
    expect(u.searchParams.has("flop_actions")).toBe(false);
  });
});
