import { describe, expect, it } from "bun:test";
import { livePreflopNodeView, shapeOf, type AiPreflopShape } from "./gtowAiPreflop";
import type { AiPreflopPin } from "./preflopPin";
import { COMBOS, comboIndex } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE LIVE PREFLOP NODE FROM ITS PIN (2026-09-30): the side panel's "ranges at this node" for an on-demand AI preflop
 * answer. From the pin's solution and codes alone: every seat's range arriving at hero's node — conditioned on what it
 * did, whole for a seat yet to act, gone for a fold — and hero's strategy there, in classGrid's shape.
 */

const arr = (fill: number | ((i: number) => number)) => COMBOS.map((_, i) => (typeof fill === "number" ? fill : fill(i)));
const node = (actor: string, actions: { code: string; strategy: number[]; allin?: boolean }[]) => ({
  data: {
    game: { players: [{ position: actor, is_hero: true }] },
    action_solutions: actions.map((a) => ({ action: { code: a.code, type: ({ R: "RAISE", C: "CALL", F: "FOLD", X: "CHECK" } as Record<string, string>)[a.code[0]!] ?? a.code, betsize: a.code.slice(1), allin: !!a.allin }, strategy: a.strategy })),
  },
});

/** 3-handed, BTN opens 2.5, SB folds, hero (BB) to act. */
const hand3: ParsedHand = {
  handId: 1, clientHandId: "t", bbCents: 200, heroSeatId: 6, heroCards: ["Kh", "Qd"], board: [], street: "preflop",
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 5, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
  ],
  liveSeats: [1, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "SB", 5: "BTN", 6: "BB" }, stacks: { 1: 100, 5: 97.5, 6: 99 },
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 4, toCall: 1.5, legalActions: [], complete: false }, ended: false,
};

describe("livePreflopNodeView", () => {
  it("every seat's range at hero's node, hero's strategy, a folded seat gone", async () => {
    const shape = shapeOf(hand3, null);
    if ("error" in shape) throw new Error(shape.error);
    const btn = shape.apiOf["BTN"]!, sb = shape.apiOf["SB"]!, bb = shape.apiOf["BB"]!;
    const kq = comboIndex("Kh", "Qd"), aa = comboIndex("As", "Ad");
    const nodes: Record<string, any> = {
      // root: BTN raises 2.5 with half of everything, folds the rest
      "": node(btn, [{ code: "R2.5", strategy: arr(0.5) }, { code: "F", strategy: arr(0.5) }]),
      // SB folds everything
      "R2.5": node(sb, [{ code: "F", strategy: arr(1) }, { code: "C", strategy: arr(0) }]),
      // hero's node: BB calls with KQ, jams with AA, folds the rest
      "R2.5-F": node(bb, [
        { code: "C", strategy: arr((i) => (i === kq ? 1 : 0)) },
        { code: "R99", strategy: arr((i) => (i === aa ? 1 : 0)), allin: true },
        { code: "F", strategy: arr((i) => (i === kq || i === aa ? 0 : 1)) },
      ]),
    };
    const pin: AiPreflopPin = {
      piece: "gtow-ai-preflop", handKey: "t", rawTokens: ["R2.5", "F"], codes: ["R2.5", "F"], heroPos: "BB", actionIndex: 4, at: 0,
      solId: "sol-1", shape: shape as AiPreflopShape, id: "gtow-ai · 3-handed", reduced: null, warm: null,
    };
    const v = await livePreflopNodeView(pin, ["Kh", "Qd"], async (ln) => nodes[ln] ?? { error: `no node ${ln}` });
    if (!v.ok) throw new Error(v.reason);
    expect(v.source).toBe("gtow-ai-preflop");
    expect(v.street).toBe("preflop");
    expect(v.line).toBe("R2.5-F");
    expect(v.heroCards).toEqual(["Kh", "Qd"]);
    // hero: BB, the whole range arriving (nothing conditioned it yet), its strategy by class
    expect(v.hero?.pos).toBe("BB");
    expect(v.hero?.actions).toEqual(["Call", "All-in", "Fold"]);
    const kqo = v.hero!.strategy!["KQo"]!;
    expect(kqo.w).toBe(12);
    expect(kqo.acts[0]).toBe(1);            // one combo of KQo calls (KhQd)
    expect(kqo.acts[2]).toBe(11);           // the other eleven fold
    expect(v.hero!.strategy!["AA"]!.acts[1]).toBe(1);   // AsAd jams
    expect(v.hero!.range["KQo"]!.w).toBe(12);
    // opponents: the BTN with its opening range (half of every class), the SB gone
    expect(v.opponents.map((o) => o.pos)).toEqual(["BTN"]);
    expect(v.opponents[0]!.range["AA"]!.w).toBe(3);
    expect(v.opponents[0]!.range["72o"]!.w).toBe(6);
    expect(v.opponents[0]!.stack).toBe(shape.stacks[btn]!);
  });

  it("first to act: nobody has conditioned anything — every opponent arrives whole", async () => {
    const hand: ParsedHand = { ...hand3, actions: hand3.actions.slice(0, 2), heroSeatId: 5, heroCards: ["Ah", "Kd"],
      currentNode: { ...hand3.currentNode, toActSeatId: 5, toCall: 1 } };
    const shape = shapeOf(hand, null);
    if ("error" in shape) throw new Error(shape.error);
    const btn = shape.apiOf["BTN"]!;
    const nodes: Record<string, any> = { "": node(btn, [{ code: "R2.5", strategy: arr(0.3) }, { code: "F", strategy: arr(0.7) }]) };
    const pin: AiPreflopPin = {
      piece: "gtow-ai-preflop", handKey: "t", rawTokens: [], codes: [], heroPos: "BTN", actionIndex: 2, at: 0,
      solId: "sol-1", shape: shape as AiPreflopShape, id: "gtow-ai · 3-handed", reduced: null, warm: null,
    };
    const v = await livePreflopNodeView(pin, ["Ah", "Kd"], async (ln) => nodes[ln] ?? { error: `no node ${ln}` });
    if (!v.ok) throw new Error(v.reason);
    expect(v.line).toBe("");
    expect(v.hero?.pos).toBe("BTN");
    expect(v.opponents.map((o) => o.pos).sort()).toEqual(["BB", "SB"]);
    for (const o of v.opponents) expect(o.range["AA"]!.w).toBe(6);   // whole
    expect(v.hero!.strategy!["AKo"]!.acts[0]).toBeCloseTo(3.6, 3);    // 12 combos × 0.3 raise
  });

  it("a node the tree cannot serve is a failure that says which", async () => {
    const shape = shapeOf(hand3, null);
    if ("error" in shape) throw new Error(shape.error);
    const pin: AiPreflopPin = {
      piece: "gtow-ai-preflop", handKey: "t", rawTokens: ["R2.5", "F"], codes: ["R2.5", "F"], heroPos: "BB", actionIndex: 4, at: 0,
      solId: "sol-1", shape: shape as AiPreflopShape, id: "gtow-ai · 3-handed", reduced: null, warm: null,
    };
    const v = await livePreflopNodeView(pin, [], async () => ({ error: "NODE_DOES_NOT_EXIST" }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("NODE_DOES_NOT_EXIST");
  });
});
