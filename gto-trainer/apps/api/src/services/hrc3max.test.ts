import { describe, expect, test } from "bun:test";
import { chartFor, siteFor, snapRung, walk3max, type HrcNode } from "./hrc3max";
import { buildPreflopTokens3max } from "../feed/buildSolutionUrl/buildSolutionUrl";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/** Minimal 3-handed hand: seats 1=BTN, 2=SB, 3=BB, hero on the button. */
const hand3 = (over: Partial<ParsedHand> = {}): ParsedHand => ({
  handId: 1,
  heroSeatId: 1,
  heroCards: ["As", "Ks"],
  board: [],
  street: "preflop",
  actions: [
    { seatId: 2, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 3, hero: false, type: "post-bb", amount: 1, street: "preflop" },
  ],
  liveSeats: [1, 2, 3],
  committed: {},
  potByStreet: {},
  positions: { 1: "BTN", 2: "SB", 3: "BB" },
  stacks: { 1: 100, 2: 100, 3: 100 },
  currentNode: {
    street: "preflop",
    toActSeatId: 1,
    toActIsHero: true,
    pot: 1.5,
    toCall: 1,
    legalActions: [],
    complete: false,
  },
  ended: false,
  ...over,
});

describe("siteFor", () => {
  test("$1/$2 → ign200, $2.50/$5 → ign500, unknown defaults to ign200", () => {
    expect(siteFor(200)).toBe("ign200");
    expect(siteFor(500)).toBe("ign500");
    expect(siteFor(undefined)).toBe("ign200");
    expect(siteFor(null)).toBe("ign200");
    expect(siteFor(50)).toBe("ign200"); // small stakes → nearest solved rake
    expect(siteFor(1000)).toBe("ign500"); // big → the deep-rake model
  });
});

describe("snapRung", () => {
  test("snaps to the solved ladder incl. the sparse deep band", () => {
    expect(snapRung(97)).toBe(95);
    expect(snapRung(98)).toBe(100);
    expect(snapRung(113)).toBe(110);
    expect(snapRung(119)).toBe(125);
    expect(snapRung(300)).toBe(150);
    expect(snapRung(11)).toBe(20);
  });
});

describe("chartFor", () => {
  test("even stacks collapse to the _eq chart", () => {
    const c = chartFor(hand3(), "BTN");
    expect(c.id).toBe("ign200_3maxasym_D100_s100_eq");
    expect(c.note).toBeNull();
  });

  test("one short stack names the short seat; big stack capped to mid", () => {
    const c = chartFor(hand3({ stacks: { 1: 148, 2: 41, 3: 102 } }), "BTN");
    // sorted 41 <= 102 <= 148 → cap 148 to 102: D=100, s=40, short seat SB
    expect(c.id).toBe("ign200_3maxasym_D100_s40_sb");
    expect(c.shortSeat).toBe("SB");
  });

  test("(40,40,100)-style states reduce to the even chart at the short depth", () => {
    const c = chartFor(hand3({ stacks: { 1: 100, 2: 40, 3: 40 } }), "BTN");
    expect(c.id).toBe("ign200_3maxasym_D40_s40_eq");
  });

  test("stake picks the site", () => {
    const c = chartFor(hand3({ bbCents: 500, stacks: { 1: 60, 2: 100, 3: 100 } }), "BTN");
    expect(c.id).toBe("ign500_3maxasym_D100_s60_btn");
  });

  test("missing stacks fall back to the even chart at hero depth, noted", () => {
    const c = chartFor(hand3({ stacks: { 1: 75 } }), "BTN");
    expect(c.id).toBe("ign200_3maxasym_D75_s75_eq");
    expect(c.note).toContain("stacks unreadable");
    const none = chartFor(hand3({ stacks: undefined }), "BTN");
    expect(none.id).toBe("ign200_3maxasym_D100_s100_eq");
  });
});

describe("buildPreflopTokens3max", () => {
  test("BTN first-in pends at the root — no phantom folds", () => {
    expect(buildPreflopTokens3max(hand3(), "BTN")).toEqual([]);
  });

  test("BTN open, SB fold → hero BB pends after two tokens", () => {
    const h = hand3({
      heroSeatId: 3,
      actions: [
        { seatId: 2, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
        { seatId: 3, hero: true, type: "post-bb", amount: 1, street: "preflop" },
        { seatId: 1, hero: false, type: "raise", amount: 2.5, street: "preflop" },
        { seatId: 2, hero: false, type: "fold", street: "preflop" },
      ],
      currentNode: { street: "preflop", toActSeatId: 3, toActIsHero: true, pot: 4, toCall: 1.5, legalActions: [], complete: false },
    });
    expect(buildPreflopTokens3max(h, "BB")).toEqual(["R2.5", "F"]);
  });
});

// ---- walk3max against a stub tree ------------------------------------------

const NODES: Record<string, HrcNode> = {
  "": {
    pos: "BTN",
    terminal: false,
    actions: [
      { action: "Fold", token: "F" },
      { action: "Limp", token: "C" },
      { action: "Raise 2.5", token: "R2.5" },
      { action: "All-in", token: "R100" },
    ],
    cells: [],
  },
  "R2.5": {
    pos: "SB",
    terminal: false,
    actions: [
      { action: "Fold", token: "F" },
      { action: "Call", token: "C" },
      { action: "Raise 9", token: "R9" },
    ],
    cells: [],
  },
  "R2.5-F": {
    pos: "BB",
    terminal: false,
    actions: [
      { action: "Fold", token: "F" },
      { action: "Call", token: "C" },
      { action: "Raise 10", token: "R10" },
    ],
    cells: [{ hand: "AKs", actions: { Fold: 0, Call: 30, "Raise 10": 70 } }],
  },
  F: { pos: "SB", terminal: false, actions: [{ action: "Fold", token: "F" }], cells: [] },
  "R2.5-F-F": { pos: null, terminal: true, actions: [], cells: [] },
  R100: {
    pos: "SB",
    terminal: false,
    actions: [
      { action: "Fold", token: "F" },
      { action: "Call", token: "C" },
    ],
    cells: [],
  },
};

const stub = async (line: string) => NODES[line] ?? null;

describe("walk3max", () => {
  test("exact line walks to hero's node", async () => {
    const w = await walk3max(["R2.5", "F"], stub);
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.node.pos).toBe("BB");
  });

  test("off-tree size snaps log-nearest and is reported", async () => {
    const w = await walk3max(["R2.3", "F"], stub);
    expect(w.ok).toBe(true);
    if (w.ok) {
      expect(w.tokens).toEqual(["R2.5", "F"]);
      expect(w.repaired).toEqual([{ index: 0, from: "R2.3", to: "R2.5" }]);
    }
  });

  test("RAI maps to the node's largest aggressive size", async () => {
    const w = await walk3max(["RAI"], stub);
    expect(w.ok).toBe(true);
    if (w.ok) {
      expect(w.tokens).toEqual(["R100"]);
      expect(w.repaired).toEqual([{ index: 0, from: "RAI", to: "R100" }]);
    }
  });

  test("continuing past a terminal fails loudly", async () => {
    const w = await walk3max(["R2.5", "F", "F", "C"], stub);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toContain("terminal");
  });

  test("a dead server is unreachable, not a chart miss", async () => {
    const w = await walk3max(["R2.5"], async () => "unreachable");
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.unreachable).toBe(true);
  });

  test("far off-tree size refuses to snap", async () => {
    // 30bb open vs offered 2.5/100: log-dist to both > τ
    const w = await walk3max(["R30"], stub);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toContain("too far");
  });
});
