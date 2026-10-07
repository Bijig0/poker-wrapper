import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { COMBOS, comboIndex } from "../../utils/comboIndex/comboIndex";
import { CB_ACTOR_MAX, CB_MIN_W, CB_MIN_W_WIDE, CB_OTHER_MAX, comboDetail, comboRowsOf, decisionViews, liveCombos, postflopViewsByDecision } from "./views";

/** a 1,326 range with `n` combos at weight w (the first n legal on the board), the rest 0 */
const rangeOf = (n: number, w = 1, board: string[] = []): number[] => {
  const out = new Array(1326).fill(0);
  let k = 0;
  for (let i = 0; i < 1326 && k < n; i++) {
    if (COMBOS[i]!.cards.some((c) => board.includes(c))) continue;
    out[i] = w; k++;
  }
  return out;
};

describe("stress-500 per-combo detail (views.comboDetail)", () => {
  const board = ["Ah", "Jc", "2d"];
  const strategies = [new Array(1326).fill(0.25), new Array(1326).fill(0.75)];
  const evs = [new Array(1326).fill(1.234), new Array(1326).fill(-2)];

  test("board-dead combos are not counted or kept", () => {
    const w = new Array(1326).fill(0);
    w[comboIndex("Ah", "Jh")] = 1;       // blocked by the board's Ah
    w[comboIndex("As", "Js")] = 0.5;
    expect(liveCombos(w, board)).toBe(0.5);
    expect(comboRowsOf(w, board).map((r) => r.hand)).toEqual(["AsJs"]);
  });

  test("a narrow actor keeps every combo's own split and EV; a wide villain stays class level", () => {
    const narrow = comboDetail([{ pos: "BB", w: rangeOf(CB_ACTOR_MAX, 1, board) }], "BB", false, board, strategies, evs);
    expect(narrow.cb?.rows.length).toBe(CB_ACTOR_MAX);
    expect(narrow.cb?.rows[0]).toMatchObject({ s: [0.25, 0.75], ev: [1.23, -2] });
    const wide = comboDetail([{ pos: "BB", w: rangeOf(CB_ACTOR_MAX + 1, 1, board) }], "BB", false, board, strategies, evs);
    expect(wide.cb).toBeNull();
  });

  test("hero's node keeps his combos however wide", () => {
    const d = comboDetail([{ pos: "CO", w: rangeOf(400, 1, board) }], "CO", true, board, strategies, evs);
    expect(d.cb?.rows.length).toBe(400);
  });

  test("a small range keeps everything over the grid floor; a bigger one drops dust under 1% of a combo", () => {
    const thin = rangeOf(1000, 0.001, board);   // 1 combo in all, every combo 0.001
    const t = comboDetail([{ pos: "BB", w: thin }], "BB", false, board, strategies, evs);
    expect(t.cb?.floor).toBe(CB_MIN_W);
    expect(t.cb?.rows.length).toBe(1000);
    const small = rangeOf(5, 1, board);
    small[comboIndex("Ks", "Qs")] = 0.005;      // kept in a 5-combo range
    expect(comboDetail([{ pos: "BB", w: small }], "BB", false, board, strategies, evs).cb?.rows.some((r) => r.hand === "KsQs")).toBe(true);
    const w = rangeOf(10, 1, board);
    w[comboIndex("Ks", "Qs")] = 0.005;          // dust in a 10-combo range
    const n = comboDetail([{ pos: "BB", w }], "BB", false, board, strategies, evs);
    expect(n.cb?.floor).toBe(CB_MIN_W_WIDE);
    expect(n.cb?.rows.some((r) => r.hand === "KsQs")).toBe(false);
  });

  test("the other seats: weights only, up to CB_OTHER_MAX combos", () => {
    const d = comboDetail([
      { pos: "BB", w: rangeOf(500, 1, board) },
      { pos: "SB", w: rangeOf(CB_OTHER_MAX, 1, board) },
      { pos: "BTN", w: rangeOf(CB_OTHER_MAX + 1, 1, board) },
    ], "BB", false, board, strategies, evs);
    expect(d.cb).toBeNull();
    expect(Object.keys(d.cbr ?? {})).toEqual(["SB"]);
    expect(d.cbr!.SB!.rows[0]!.s).toBeUndefined();
  });
});

// ── the blend's trees by decision (2026-10-08) ───────────────────────────────────────────────────────────────────────

const ones = (x = 1) => new Array(1326).fill(x);
const node = (actor: number, codes: string[], acts: [string, number?][], taken: number | null, hero = false) => ({
  si: 0, street: "FLOP", board: "Ac6h8d", codes, actor, potNode: 6, taken, heroNode: hero,
  actions: acts.map(([name, betsize]) => ({ name, betsize, strategy: ones(1 / acts.length), totalFrequency: 1 / acts.length })),
});
const tree = (players: string[], tag: string, nodes: any[]) => ({
  spec: { oopPos: players[0], midPos: players[1], ipPos: players[2], heroSeat: "mid", planTag: tag },
  streets: [{ si: 0, players, rangesIn: players.map(() => ones()) }], nodes,
});
// seats 1 SB, 2 BB (hero), 3 UTG, 4 HJ; flop: 6 SB bet · 7 BB call (decision 7) · 8 UTG raise · 9 HJ call · 10 SB fold · 11 BB (decision 11)
const POS = { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ" };
const ACTS = [
  { seatId: 1, street: "preflop", type: "post-sb" }, { seatId: 2, street: "preflop", type: "post-bb" }, { seatId: 3, street: "preflop", type: "call" },
  { seatId: 4, street: "preflop", type: "call" }, { seatId: 1, street: "preflop", type: "call" }, { seatId: 2, street: "preflop", type: "check", hero: true },
  { seatId: 1, street: "flop", type: "bet" }, { seatId: 2, street: "flop", type: "call", hero: true }, { seatId: 3, street: "flop", type: "raise" },
  { seatId: 4, street: "flop", type: "call" }, { seatId: 1, street: "flop", type: "fold" }, { seatId: 2, street: "flop", type: "call", hero: true },
];
const A = tree(["SB", "BB", "UTG"], "ghost:HJ", [node(0, [], [["CHECK"], ["BET", 2]], 1), node(1, ["B2"], [["FOLD"], ["CALL"]], null, true)]);
const B = tree(["SB", "BB", "HJ"], "ghost:UTG", [node(0, [], [["CHECK"], ["BET", 2]], 1), node(1, ["B2"], [["FOLD"], ["CALL"]], null, true)]);
const C = tree(["SB", "BB", "UTG"], "ghost:HJ", [node(0, [], [["CHECK"], ["BET", 2]], 1), node(1, ["B2"], [["FOLD"], ["CALL"]], 1),
  node(2, ["B2", "C"], [["FOLD"], ["CALL"], ["RAISE", 8]], 2), node(0, ["B2", "C", "R8"], [["FOLD"], ["CALL"]], 0), node(1, ["B2", "C", "R8", "F"], [["FOLD"], ["CALL"]], null, true)]);

describe("stress-500 blend views by decision (views.postflopViewsByDecision)", () => {
  const by = postflopViewsByDecision(ACTS, POS, [{ id: 1, decisionIndex: 7, trace: A }, { id: 2, decisionIndex: 7, trace: B }, { id: 3, decisionIndex: 11, trace: C }]);
  test("a step is drawn from the decision being answered, never a later decision's tree replaying the street", () => {
    expect(by.views[6]!.src).toBe("tree #1 · ghost:HJ");
    expect(by.views[7]!.src).toBe("tree #1 · ghost:HJ");
    expect(by.alts[7]!.map((v) => v.src)).toEqual(["tree #2 · ghost:UTG"]);
    expect(by.views[8]!.src).toBe("tree #3 · ghost:HJ");
    expect(by.views[11]!.src).toBe("tree #3 · ghost:HJ");
  });
  test("a seat no tree holds gets the trees' ranges as an absent view, not nothing", () => {
    expect(by.views[9]!.absent).toMatch(/^HJ is not in this tree/);
    expect(Object.keys(by.views[9]!.ranges).sort()).toEqual(["BB", "SB", "UTG"]);
    expect(by.views[9]!.strat).toBeNull();
  });
  test("a street-cut tree is matched from its decision backwards", () => {
    const D = tree(["SB", "BB", "UTG"], "(street cut)", [node(0, [], [["FOLD"], ["CALL"]], 0), node(1, ["F"], [["FOLD"], ["CALL"]], null, true)]);
    expect(Object.keys(decisionViews(ACTS, POS, { id: 4, decisionIndex: 11, trace: D }) ?? {}).map(Number)).toEqual([10, 11]);
  });
});

// a stored trace of the run (the stress root; skipped where it is absent)
const ROOT = "C:/Users/Brady/poker-data-stress500";
const stored = (id: string) => {
  const h = JSON.parse(readFileSync(`${ROOT}/hands/${id}.json`, "utf8"));
  const db = new Database(`${ROOT}/root/poker.sqlite`, { readonly: true });
  const since = h.startedAt ? Date.parse(h.startedAt) : Date.parse(h.ranAt) - h.ms - 500;
  const rows = db.query("select id, decision_key, ok, trace from solves where client_hand_id = ? and ts >= ? order by ts").all(`stress-s5-${id}`, since) as any[];
  db.close();
  const traces = rows.map((r) => { const k = JSON.parse(r.decision_key); return { id: r.id, decisionIndex: Number(k[k.length - 1]), ok: !!r.ok, trace: JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString()) }; });
  return postflopViewsByDecision(h.hand.actions, h.hand.positions, traces);
};
describe.skipIf(!existsSync(`${ROOT}/root/poker.sqlite`))("stress-500 blend views on stored traces", () => {
  test("brief_A-004 step 9 (hero calls, decision 9): the ghost blend it was answered on, not decision 15's dead-money tree", () => {
    const by = stored("brief_A-004");
    expect(by.views[9]!.src).toMatch(/^tree #8638 /);
    expect(by.alts[9]!.map((v) => v.src.split(" · ")[0])).toEqual(["tree #8639", "tree #8640"]);
  });
  test("po_56way-005 flop: three trees at hero's node, each holding its own villain; the other seats one switch away", () => {
    const by = stored("po_56way-005");
    const opts = [by.views[9]!, ...by.alts[9]!];
    expect(opts.map((v) => v.src.split(" · ")[0])).toEqual(["tree #9148", "tree #9149", "tree #9150"]);
    expect(opts.map((v) => Object.keys(v.ranges).find((p) => !["SB", "BB"].includes(p)))).toEqual(["UTG", "HJ", "CO"]);
    expect(opts.every((v) => v.strat && !v.absent)).toBe(true);
  });
});
