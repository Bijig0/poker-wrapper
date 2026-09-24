/**
 * The range-level oracle's own checks, on toy walks and a toy chart — pure, no charts, no network (plain `bun test`).
 */
import { describe, expect, test } from "bun:test";
import { explainsSeat, layer1, layer2Postflop, layer2Preflop, truthLine, postflopTokenMismatch } from "./rangeOracle";
import type { RawNode, RecordedRangeWalk, WalkStep } from "../../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildRangeArray } from "../../utils/buildRangeArray/buildRangeArray";
import { classWeightsToSpec } from "../../utils/reconstructFlopRanges/reconstructFlopRanges";

const N = (pos: string, actions: [string, string][], cells: Record<string, Record<string, number>>): RawNode =>
  ({ pos, terminal: false, actions: actions.map(([action, token]) => ({ action, token })), cells: Object.entries(cells).map(([hand, a]) => ({ hand, actions: a })) });
// 5-handed toy: HJ opens, CO calls, the rest fold
const OPEN: [string, string][] = [["Fold", "F"], ["Raise 2.5", "R2.5"], ["All-in", "R100"]];
const TREE: Record<string, RawNode> = {
  "": N("UTG", OPEN, {}),
  "F": N("HJ", OPEN, { AA: { "Raise 2.5": 100 }, KK: { "Raise 2.5": 50, "All-in": 50 } }),
  "F-R2.5": N("CO", [["Fold", "F"], ["Call", "C"], ["Raise 8", "R8"]], { QQ: { Call: 100 }, AKo: { Call: 40, "Raise 8": 60 } }),
  "F-R2.5-C": N("BTN", [["Fold", "F"]], {}), "F-R2.5-C-F": N("SB", [["Fold", "F"]], {}), "F-R2.5-C-F-F": N("BB", [["Fold", "F"], ["Call", "C"]], {}),
  "F-R2.5-C-F-F-F": { pos: null, terminal: true, actions: [], cells: [] },
};
const get = async (l: string) => TREE[l] ?? null;
const DEALT = ["HJ", "CO", "BTN", "SB", "BB"];
const TRUTH = truthLine([
  { street: 0, seat: 1, type: "raise", amount: 2.5 }, { street: 0, seat: 2, type: "call", amount: 2.5 },
  { street: 0, seat: 3, type: "fold" }, { street: 0, seat: 4, type: "fold" }, { street: 0, seat: 5, type: "fold" },
], (s) => DEALT[s - 1]!);
const HJ = { AA: 1, KK: 0.5 }, CO = { QQ: 1, AKo: 0.4 };
const step = (line: string, pos: string, token: string, label: string, rangeIn: Record<string, number> | null, rangeOut: Record<string, number> | null, labels = [label]): WalkStep =>
  ({ line, node: TREE[line]!, pos, token, rawToken: token, label, labels, rangeIn, rangeOut });
const goodWalk = (): RecordedRangeWalk => ({
  tokens: ["F", "R2.5", "C", "F", "F", "F"], heroPos: "CO",
  steps: [step("", "UTG", "F", "Fold", null, null), step("F", "HJ", "R2.5", "Raise 2.5", null, HJ), step("F-R2.5", "CO", "C", "Call", null, CO)],
  result: { ok: true, ranges: { HJ, CO } },
});
const dry = (ranges: { HJ: Record<string, number>; CO: Record<string, number> } = { HJ, CO }) => ({
  ranges: ranges as Record<string, Record<string, number>>, flopSeats: ["HJ", "CO"],
  trees: [{ kind: null, heroSeat: "ip", seats: [{ pos: "HJ", range: buildRangeArray(classWeightsToSpec(ranges.HJ)) }, { pos: "CO", range: buildRangeArray(classWeightsToSpec(ranges.CO)) }] }],
});
const base = { truth: TRUTH, heroPos: "CO", heroCards: ["Qh", "Qd"] as [string, string], note: "" };

describe("truthLine", () => {
  test("posts dropped; an all-in that raises is A, one that does not is a call", () => {
    const t = truthLine([{ street: 0, seat: 1, type: "post-sb", amount: 0.5 }, { street: 0, seat: 2, type: "raise", amount: 2.5 },
      { street: 0, seat: 3, type: "all-in", amount: 2 }, { street: 0, seat: 4, type: "all-in", amount: 20 }, { street: 1, seat: 2, type: "bet", amount: 3 }], (s) => `S${s}`);
    expect(t).toEqual([{ pos: "S2", kind: "R", to: 2.5 }, { pos: "S3", kind: "C" }, { pos: "S4", kind: "A", to: 20 }]);
  });
});

describe("layer 1 — invariants", () => {
  test("a clean walk passes", async () => {
    expect(await layer1({ ...base, dry: dry(), walks: [goodWalk()], get })).toEqual([]);
  });
  test("hero's combo at weight 0 in the tree's array", async () => {
    const f = await layer1({ ...base, heroCards: ["7h", "2d"], dry: dry(), walks: [goodWalk()], get });
    expect(f.map((x) => x.kind)).toContain("hero-combo-zero");
  });
  test("a range that grew at a seat's own decision", async () => {
    const w = goodWalk();
    w.steps[2] = step("F-R2.5", "CO", "C", "Call", { QQ: 0.5 }, CO);
    const f = await layer1({ ...base, dry: dry(), walks: [w], get });
    expect(f.map((x) => x.kind)).toContain("range-widened");
  });
  test("a range no walk produced", async () => {
    const f = await layer1({ ...base, dry: dry({ HJ, CO: { QQ: 1 } }), walks: [goodWalk()], get });
    expect(f.map((x) => x.kind)).toContain("range-provenance");
  });
  test("a walk whose weights the chart's own frequencies do not give", async () => {
    const bad = { QQ: 1, AKo: 0.5 };
    const w = goodWalk(); w.steps[2] = step("F-R2.5", "CO", "C", "Call", null, bad); w.result = { ok: true, ranges: { HJ, CO: bad } };
    const f = await layer1({ ...base, dry: dry({ HJ, CO: bad }), walks: [w], get });
    expect(f.map((x) => x.kind)).toContain("range-product");
  });
  test("a call conditioned on the all-in (a call for less read as a jam)", async () => {
    const w = goodWalk(); w.steps[2] = step("F-R2.5", "CO", "R100", "All-in", null, CO);
    const f = await layer1({ ...base, dry: dry(), walks: [w], get: null });
    expect(f.map((x) => x.kind)).toContain("jam-on-raise");
  });
  test("a raise conditioned on a call", async () => {
    const w = goodWalk(); w.steps[1] = step("F", "HJ", "C", "Call", null, HJ);
    const f = await layer1({ ...base, dry: dry(), walks: [w], get: null });
    expect(f.map((x) => x.kind)).toContain("step-action-mismatch");
  });
  test("a size past τ, and a snapped size the note does not name", async () => {
    const far = truthLine([{ street: 0, seat: 1, type: "raise", amount: 4 }, { street: 0, seat: 2, type: "call", amount: 4 }], (s) => DEALT[s - 1]!);
    expect((await layer1({ ...base, truth: far, dry: dry(), walks: [goodWalk()], get: null })).map((x) => x.kind)).toContain("size-past-tolerance");
    const near = truthLine([{ street: 0, seat: 1, type: "raise", amount: 2.6 }, { street: 0, seat: 2, type: "call", amount: 2.6 }], (s) => DEALT[s - 1]!);
    expect((await layer1({ ...base, truth: near, dry: dry(), walks: [goodWalk()], get: null })).map((x) => x.kind)).toContain("size-snap-unreported");
    expect(await layer1({ ...base, truth: near, note: "PREFLOP SIZES SNAPPED onto the chart: HJ's 2.6bb read as 2.5bb", dry: dry(), walks: [goodWalk()], get: null })).toEqual([]);
  });
  test("a tree seat built with another seat's array", async () => {
    const d = dry(); d.trees[0]!.seats[1]!.range = d.trees[0]!.seats[0]!.range;
    const f = await layer1({ ...base, heroCards: ["Ah", "Ad"], dry: d, walks: [goodWalk()], get });
    expect(f.map((x) => x.kind)).toContain("tree-range-mismatch");
  });
});

describe("layer 2 — the reference walk", () => {
  test("the same ranges: nothing", async () => {
    const r = await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "CO", note: "", dry: dry(), get });
    expect(r.findings).toEqual([]);
  });
  test("a seat's range off the reference, unexplained, is a finding; explained for that seat only", async () => {
    const off = { HJ, CO: { QQ: 1, AKo: 0.1 } };
    expect((await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "HJ", note: "", dry: dry(off), get })).findings[0]?.kind).toBe("range-mismatch");
    // a fit that names another seat does not excuse CO
    expect((await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "HJ", note: "LINE FITTED FOR THE RANGES: HJ with BTN folded", dry: dry(off), get })).findings[0]?.kind).toBe("range-mismatch");
    const ok = await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "HJ", note: "… (CO with BTN folded)", dry: dry(off), get });
    expect(ok.findings).toEqual([]);
    expect(ok.explained).toBe(true);
  });
  test("a preflop answer at the reference's node passes; another node is a finding unless an approximation is named", async () => {
    const t = TRUTH.slice(0, 1);
    expect((await layer2Preflop({ truth: t, dealt: DEALT, heroPos: "CO", note: "", line: "F-R2.5", get })).findings).toEqual([]);
    expect((await layer2Preflop({ truth: t, dealt: DEALT, heroPos: "CO", note: "", line: "F-R100", get })).findings[0]?.kind).toBe("preflop-node-mismatch");
    expect((await layer2Preflop({ truth: t, dealt: DEALT, heroPos: "CO", note: "CALLER CAP: …", line: "F-R100", get })).findings).toEqual([]);
  });
});

describe("explainsSeat", () => {
  test("a fit or a borrow names the seat; hero's own line approximations excuse hero only; another chart excuses all", () => {
    expect(explainsSeat("… (BB with BTN folded, HJ with BTN+SB folded)", "HJ", false)).toBe(true);
    expect(explainsSeat("… (BB with BTN folded)", "HJ", false)).toBe(false);
    expect(explainsSeat("RANGE SHORTCUT: SB's call at \"F-R2.5-C\" is not in the tree (caller cap)", "SB", false)).toBe(true);
    expect(explainsSeat("CHART KEPT: …", "BB", true)).toBe(true);
    expect(explainsSeat("CHART KEPT: …", "BB", false)).toBe(false);
    expect(explainsSeat("no ign200_6max_D100_o3 tree in the set — ranges from ign200_6max_D100_o2_5", "CO", false)).toBe(true);
    expect(explainsSeat("hero's decision was read on a line fitted to the tree (CO's call folded out), and these ranges are read on that line", "HJ", false)).toBe(true);
  });
});

describe("postflopTokenMismatch — the postflop line as sent", () => {
  const acts = [{ street: 0, seat: 1, type: "raise", amount: 2.5 }, { street: 0, seat: 2, type: "call", amount: 2.5 },
    { street: 1, seat: 2, type: "bet", amount: 3.3 }, { street: 1, seat: 1, type: "all-in", amount: 2 }, { street: 1, seat: 3, type: "raise", amount: 10 }];
  const posOf = (s: number) => ["", "HJ", "CO", "BTN"][s]!;
  test("the dealt line, sizes exact, an all-in for less as C", () => {
    expect(postflopTokenMismatch(acts, 5, posOf, { streets: [["R3.3", "C", "R10"]], streetSeats: [["CO", "HJ", "BTN"]] })).toBeNull();
  });
  test("a size, a token or a seat off the dealt line is named", () => {
    expect(postflopTokenMismatch(acts, 5, posOf, { streets: [["R3.3", "RAI", "R10"]] })).toContain("dealt R3.3-C-R10, sent R3.3-RAI-R10");
    expect(postflopTokenMismatch(acts, 5, posOf, { streets: [["R3", "C", "R10"]] })).toContain("sent R3-C-R10");
    expect(postflopTokenMismatch(acts, 5, posOf, { streets: [["R3.3", "C", "R10"]], streetSeats: [["HJ", "CO", "BTN"]] })).toContain("token 1 is CO's, sent as HJ's");
  });
});
