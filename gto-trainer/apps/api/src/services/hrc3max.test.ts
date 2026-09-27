import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chartFor, resetChartPins, setIgn25Ids, siteFor, snapRung, walk3max, type HrcNode } from "./hrc3max";
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

// every fixture shares handId 1 — a chart pinned by one test must not leak into the next
beforeEach(() => resetChartPins());

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
  // These assert the CANONICAL-STATE maths: which rung, which short seat, which site.
  // Which GENERATION then answers is a separate layer (v2ciId swaps in the re-solved
  // even chart at every rung listed in data/resolved-charts.json), and leaving it on
  // made these tests depend on a data file — three of them went red the day the ign200
  // re-solve landed, asserting an id the picker had stopped returning months earlier.
  const resolvedWas = process.env.RESOLVED_OFF;
  beforeAll(() => { process.env.RESOLVED_OFF = "1"; });
  afterAll(() => { if (resolvedWas == null) delete process.env.RESOLVED_OFF; else process.env.RESOLVED_OFF = resolvedWas; });

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
  // hero's node after a 3-bet — the shape of the real 2026-09-21 miss (AA in
  // the CO facing a 21bb 3-bet with only 12.5 in the tree)
  "R2.5-R9": {
    pos: "BTN",
    terminal: false,
    actions: [
      { action: "Fold", token: "F" },
      { action: "Call", token: "C" },
      { action: "All-in", token: "R100" },
    ],
    cells: [{ hand: "AA", actions: { Fold: 0, Call: 11, "All-in": 89 } }],
  },
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
      expect(w.repaired).toEqual([{ index: 0, from: "R2.3", to: "R2.5", logDist: expect.closeTo(0.083, 3), far: false }]);
    }
  });

  test("RAI maps to the node's largest aggressive size", async () => {
    const w = await walk3max(["RAI"], stub);
    expect(w.ok).toBe(true);
    if (w.ok) {
      expect(w.tokens).toEqual(["R100"]);
      expect(w.repaired).toEqual([{ index: 0, from: "RAI", to: "R100", logDist: 0, far: false }]);
    }
  });

  test("continuing past a terminal fails loudly", async () => {
    const w = await walk3max(["R2.5", "F", "F", "C"], stub);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toContain("terminal");
  });

  // 2026-09-25 (A9dd): a terminal the CHART ends says so, after the unchanged phrase answerLog's needles match on
  test("a pruned terminal keeps the refusal phrase and names the gap", async () => {
    const pruned = async (line: string) =>
      line === "R2.5-C" ? { pos: "SB", terminal: true, pruned: "reach" as const, actions: [], cells: [] } : stub(line);
    const past = await walk3max(["R2.5", "C", "F"], pruned);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toStartWith("line continues past a terminal (pruned: HRC never exported");
    const at = await walk3max(["R2.5", "C"], pruned);
    expect(at.ok).toBe(false);
    if (!at.ok) expect(at.reason).toStartWith("line ends on a terminal — no pending decision (pruned:");
    const plain = await walk3max(["R2.5", "F", "F", "C"], stub);
    if (!plain.ok) expect(plain.reason).toBe("line continues past a terminal");
  });

  test("a dead server is unreachable, not a chart miss", async () => {
    const w = await walk3max(["R2.5"], async () => "unreachable");
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.unreachable).toBe(true);
  });

  // 2026-09-21: this used to REFUSE, and the spot went unanswered — AA in the
  // CO facing a 21bb 3-bet with 12.5 the nearest tree size (log-dist 0.52),
  // while the tree's own node said All-in 88.9% / Call 11.1%. Past τ a snap is
  // no longer clean, but it still beats no answer; the answer says so and the
  // miss queue files the size.
  test("a size past τ but under 2x snaps anyway, flagged far", async () => {
    const w = await walk3max(["R2.5", "R15"], stub);   // 15 vs the node's 9 — log-dist 0.51
    expect(w.ok).toBe(true);
    if (w.ok) {
      expect(w.tokens).toEqual(["R2.5", "R9"]);
      expect(w.repaired).toEqual([{ index: 1, from: "R15", to: "R9", logDist: expect.closeTo(0.511, 3), far: true }]);
      expect(w.node.cells.find((c) => c.hand === "AA")?.actions["All-in"]).toBe(89);
    }
  });

  test("a size more than 2x from the nearest still refuses", async () => {
    // 30bb open vs offered 2.5/100: nearest is 2.5x away — past the point
    // where the snapped node still resembles the spot
    const w = await walk3max(["R30"], stub);
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toContain("more than 2x away");
  });
});

describe("chartFor — one chart per hand (hand 4917810302, 2026-09-12)", () => {
  // BTN 74bb (hero), SB 103bb, BB 146bb at the deal: deep pair snaps to 105,
  // BTN short at 75.
  const dealt = () => hand3({
    clientHandId: "4917810302",
    positions: { 1: "BB", 2: "BTN", 3: "SB" },
    heroSeatId: 2,
    stacks: { 1: 145, 2: 73.5, 3: 102.6 },
    committed: { 1: 1, 2: 0.5, 3: 0 },   // blinds posted: dealt stacks are behind + in the pot
  });

  test("the first full reading is pinned and reused for the rest of the hand", () => {
    resetChartPins();
    const first = chartFor(dealt(), "BTN");
    expect(first.depth).toBe(105);
    expect(first.shortDepth).toBe(75);
    expect(first.shortSeat).toBe("BTN");
    // facing the jam: hero 48 behind + 26 in, SB 0 behind + 101.8 in, BB folded with 1 in
    const later = chartFor(hand3({
      clientHandId: "4917810302", positions: { 1: "BB", 2: "BTN", 3: "SB" }, heroSeatId: 2,
      stacks: { 1: 142.2, 2: 48, 3: 0 }, committed: { 1: 1, 2: 26, 3: 101.8 },
    }), "BTN");
    expect(later.id).toBe(first.id);
    expect(later.depth).toBe(105);
    expect(later.note).toBe(first.note);
  });

  test("an all-in villain (0 behind) is a known stack, not an unreadable seat", () => {
    resetChartPins();
    const jam = hand3({
      clientHandId: "unpinned-jam", positions: { 1: "BB", 2: "BTN", 3: "SB" }, heroSeatId: 2,
      stacks: { 1: 142.2, 2: 48, 3: 0 }, committed: { 1: 1, 2: 26, 3: 101.8 },
    });
    const c = chartFor(jam, "BTN");
    expect(c.note ?? "").not.toContain("unreadable");
    // dealt stacks: BTN 74, SB 101.8, BB 143.2 → short BTN 75, deep pair 100
    expect(c.shortSeat).toBe("BTN");
    expect(c.shortDepth).toBe(75);
    expect(c.depth).toBe(100);
  });

  test("a guessed chart (missing seat) is never pinned — the next full reading wins", () => {
    resetChartPins();
    const partial = hand3({ clientHandId: "partial-1", stacks: { 1: 75 } });
    expect(chartFor(partial, "BTN").note).toContain("unreadable");
    const full = hand3({ clientHandId: "partial-1", stacks: { 1: 100, 2: 40, 3: 100 } });
    expect(chartFor(full, "BTN").shortSeat).toBe("SB");
  });

  test("hands are keyed by the site's hand id, so two hands never share a pin", () => {
    resetChartPins();
    const a = chartFor(hand3({ clientHandId: "A", stacks: { 1: 100, 2: 100, 3: 100 } }), "BTN");
    const b = chartFor(hand3({ clientHandId: "B", stacks: { 1: 100, 2: 40, 3: 100 } }), "BTN");
    expect(a.shortSeat).toBe("EQ");
    expect(b.shortSeat).toBe("SB");
  });
});

// ---- NL25 routing (ledger cutover-nl25, 2026-09-14) -------------------------
// The stake we actually play has its own grid, solved at the NL25 rake (5% /
// cap 4bb). Before this the router could only name ign200/ign500, so every NL25
// answer came from the 1bb-cap grid.
describe("siteFor / snapRung at NL25", () => {
  test("routes the NL25 Zone stake to its own rake set", () => {
    expect(siteFor(25)).toBe("ign25");
    expect(siteFor(10)).toBe("ign25");
    expect(siteFor(50)).toBe("ign200");    // NL50 stays on ign200 until verified
    expect(siteFor(200)).toBe("ign200");
  });
  test("keeps the two deeper rungs the NL25 grid solved", () => {
    expect(snapRung(200, "ign25")).toBe(200);
    expect(snapRung(170, "ign25")).toBe(175);
    expect(snapRung(200, "ign200")).toBe(150);   // the NL200 ladder still tops out at 150
  });
});

describe("chartFor at NL25", () => {
  // the solved uneven NL25 states, as the chart index lists them (D100: s30 solved, s25 never)
  beforeAll(() => setIgn25Ids(["ign25_3maxasym2ci_D100_s30_btn", "ign25_3maxasym2ci_D100_s30_sb", "ign25_3maxasym2ci_D100_s100_eq"]));
  afterAll(() => setIgn25Ids(null));
  test("names an ign25 chart, in the one generation that set has", () => {
    const c = chartFor(hand3({ bbCents: 25 }), "BTN");
    expect(c.site).toBe("ign25");
    expect(c.id).toBe("ign25_3maxasym2ci_D100_s100_eq");
  });
  test("uses the real uneven chart when that state was solved", () => {
    const c = chartFor(hand3({ bbCents: 25, stacks: { 1: 30, 2: 100, 3: 100 } }), "BTN");
    expect(c.id).toBe("ign25_3maxasym2ci_D100_s30_btn");
    expect(c.shortSeat).toBe("BTN");
  });
  test("falls back to the even chart when the uneven state was never solved", () => {
    // the uneven grid is traffic-ranked: s25 was never solved at D100
    const c = chartFor(hand3({ bbCents: 25, stacks: { 1: 100, 2: 100, 3: 25 } }), "BTN");
    expect(c.id).toBe("ign25_3maxasym2ci_D100_s100_eq");
    expect(c.note).toContain("asymmetry approximated");
  });
});

// BORROW AT THE WALK (2026-09-22). A villain's third limp is past the tree's flats cap, so the node at
// "C-C" offers no C. With borrowCaller the walk folds the EARLIEST other limper and reads the same seat's
// call one limper fewer — accepted only when that donor node is the same seat and offers the call.
describe("walk3max borrowCaller", () => {
  const n = (pos: string, toks: string[], terminal = false) =>
    ({ pos, terminal, actions: toks.map((t) => ({ action: t, token: t })), cells: [] });
  const TREE: Record<string, any> = {
    "": n("UTG", ["F", "C", "R2.5"]),
    "C": n("HJ", ["F", "C", "R2.5"]),
    "C-C": n("CO", ["F", "R2.5"]),          // the third limp is not in the tree
    "F": n("HJ", ["F", "C", "R2.5"]),
    "F-C": n("CO", ["F", "C", "R2.5"]),     // the donor: same seat, one limper fewer, offers C
    "F-C-C": n("BTN", ["F", "C", "R2.5"]),  // hero's node
  };
  const get = async (l: string) => TREE[l] ?? null;

  test("without the option a third limp still ends the walk", async () => {
    const w = await walk3max(["C", "C", "C"], get);
    expect(w.ok).toBe(false);
  });

  test("with it, the earliest limp is folded and the walk reaches hero", async () => {
    const w = await walk3max(["C", "C", "C"], get, { borrowCaller: true });
    expect(w.ok).toBe(true);
    if (w.ok) {
      expect(w.tokens).toEqual(["F", "C", "C"]);
      expect(w.node.pos).toBe("BTN");
      expect(w.repaired).toEqual([{ index: 0, from: "C", to: "F", logDist: 0, far: false, borrowed: "UTG" }]);
    }
  });

  test("a donor node that belongs to another seat is refused, not read", async () => {
    const bad: Record<string, any> = { ...TREE, "F-C": n("BTN", ["F", "C"]) };
    const w = await walk3max(["C", "C", "C"], async (l) => bad[l] ?? null, { borrowCaller: true });
    expect(w.ok).toBe(false);
  });
});
