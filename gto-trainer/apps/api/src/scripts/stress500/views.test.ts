import { describe, expect, test } from "bun:test";
import { COMBOS, comboIndex } from "../../utils/comboIndex/comboIndex";
import { CB_ACTOR_MAX, CB_MIN_W, CB_MIN_W_WIDE, CB_OTHER_MAX, comboDetail, comboRowsOf, liveCombos } from "./views";

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
