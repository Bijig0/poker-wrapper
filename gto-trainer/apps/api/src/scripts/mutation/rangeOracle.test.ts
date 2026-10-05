/**
 * The range-level oracle's own checks, on toy walks and a toy chart — pure, no charts, no network (plain `bun test`).
 */
import { describe, expect, test } from "bun:test";
import { explainsSeat, layer1, layer2Postflop, layer2Preflop, truthLine, postflopTokenMismatch, repickOf, poolFloorsOf, poolRangeOf } from "./rangeOracle";
import { poolColdCallFloorNote, type ColdCallKey } from "../../services/poolColdCall";
import { poolLimpFloorNote, type PoolLimpKey } from "../../services/poolLimpFloor";
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

/**
 * THE VILLAINS' RANGES RE-PICKED (round 2.1, services/preflopPin.repickVillainRanges): a villain's range read on the
 * exact chart for the line as played is an EXPLAINED difference from the pinned chart's reference only when the note
 * names the re-pick FOR THAT SEAT — and it must then equal the reference walk of the dealt line on the re-picked chart.
 */
describe("the ranges re-pick", () => {
  // the re-picked chart: the same toy line, the CO calls AKo 10% there instead of 40%
  const REPICK: Record<string, RawNode> = { ...TREE, "F-R2.5": N("CO", [["Fold", "F"], ["Call", "C"], ["Raise 8", "R8"]], { QQ: { Call: 100 }, AKo: { Call: 10, "Raise 8": 90 } }) };
  const getFor = (id: string) => async (l: string) => (id === "toy_repick" ? REPICK[l] ?? null : TREE[l] ?? null);
  const CO2 = { QQ: 1, AKo: 0.1 };
  const noteFor = (seats: string) => `PREFLOP RANGES FROM THE PIN: … · RANGES RE-PICKED FOR ${seats}: the pinned chart modelled the BTN as the 70bb short stack and the BTN folded after hero's decision, ` +
    `so read on toy_repick, the chart for the line as played — hero's range stays on toy_pin`;
  const heroHJ = (co: Record<string, number>) => ({ ...dry({ HJ, CO: co }), trees: [{ kind: null, heroSeat: "oop", seats: [{ pos: "HJ", range: buildRangeArray(classWeightsToSpec(HJ)) }, { pos: "CO", range: buildRangeArray(classWeightsToSpec(co)) }] }] });

  test("repickOf reads the seats and the chart; explainsSeat never takes the re-pick's own \"BB: …\" for a borrow", () => {
    expect(repickOf(noteFor("CO, BB"))).toEqual({ seats: ["CO", "BB"], chart: "toy_repick" });
    expect(repickOf("PREFLOP RANGES FROM THE PIN: …")).toBeNull();
    expect(explainsSeat(noteFor("BB"), "BB", false)).toBe(false);
    expect(explainsSeat(`RANGES RE-PICK FELL BACK for BB: toy_repick cannot read it (…) — BB's range stays on toy_pin`, "BB", false)).toBe(false);
  });

  test("a villain on the re-picked chart, named: explained — and only when it is that chart's range", async () => {
    const ok = await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "HJ", note: noteFor("CO"), dry: dry({ HJ, CO: CO2 }), get, getFor });
    expect(ok.findings).toEqual([]);
    expect(ok.explained).toBe(true);
    // named, but the range is neither chart's
    const off = await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "HJ", note: noteFor("CO"), dry: dry({ HJ, CO: { QQ: 1, AKo: 0.25 } }), get, getFor });
    expect(off.findings[0]?.kind).toBe("range-mismatch");
    expect(off.findings[0]?.reason).toContain("re-picked onto toy_repick");
  });

  test("the re-picked chart's range with the re-pick not named for that seat is a finding", async () => {
    const silent = await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "HJ", note: "PREFLOP RANGES FROM THE PIN: …", dry: dry({ HJ, CO: CO2 }), get, getFor });
    expect(silent.findings[0]?.kind).toBe("range-mismatch");
    const other = await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "HJ", note: noteFor("BB"), dry: dry({ HJ, CO: CO2 }), get, getFor });
    expect(other.findings[0]?.kind).toBe("range-mismatch");
    // hero is never re-picked: a note naming hero's seat does not excuse his range
    const heroNamed = await layer2Postflop({ truth: TRUTH, dealt: DEALT, heroPos: "CO", note: noteFor("CO"), dry: dry({ HJ, CO: CO2 }), get, getFor });
    expect(heroNamed.findings[0]?.kind).toBe("range-mismatch");
  });

  test("layer 1 replays a re-picked seat's walk on the re-picked chart", async () => {
    const w = goodWalk(); w.heroPos = "HJ";
    w.steps[2] = step("F-R2.5", "CO", "C", "Call", null, CO2); w.result = { ok: true, ranges: { HJ, CO: CO2 } };
    const o = { ...base, heroPos: "HJ", heroCards: ["Ah", "Ad"] as [string, string], note: noteFor("CO"), dry: heroHJ(CO2), walks: [w], get };
    expect((await layer1(o)).map((x) => x.kind)).toContain("range-product");        // on the pinned chart: not its product
    expect(await layer1({ ...o, getFor: (seat) => (seat === "CO" ? getFor("toy_repick") : null) })).toEqual([]);
  });
});

// THE POOL FLOORS (fastSolve, 2026-10-05): a 3-bet cold-caller the walk left under 1% of hands enters the flop with the
// pool's range (services/poolColdCall), a short limper with the pool's limp range (services/poolLimpFloor) — by design,
// said in the note. The note is built here by the services' own note functions, so a change of its wording fails here.
describe("layer 1 + 2 — the pool floors", () => {
  // HJ opens 2.5, CO (hero) 3-bets to 8, the BTN cold-calls, the blinds and the HJ fold: CO and BTN see the flop
  const TREE3: Record<string, RawNode> = {
    ...TREE,
    "F-R2.5-R8": N("BTN", [["Fold", "F"], ["Call", "C"]], { AKo: { Call: 10 } }),
    "F-R2.5-R8-C": N("SB", [["Fold", "F"]], {}), "F-R2.5-R8-C-F": N("BB", [["Fold", "F"]], {}),
    "F-R2.5-R8-C-F-F": N("HJ", [["Fold", "F"], ["Call", "C"]], { AA: { Call: 100 }, KK: { Call: 100 } }),
    "F-R2.5-R8-C-F-F-F": { pos: null, terminal: true, actions: [], cells: [] },
  };
  const get3 = async (l: string) => TREE3[l] ?? null;
  const DEALT3 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
  const TRUTH3 = truthLine([
    { street: 0, seat: 1, type: "fold" }, { street: 0, seat: 2, type: "raise", amount: 2.5 }, { street: 0, seat: 3, type: "raise", amount: 8 },
    { street: 0, seat: 4, type: "call", amount: 8 }, { street: 0, seat: 5, type: "fold" }, { street: 0, seat: 6, type: "fold" }, { street: 0, seat: 2, type: "fold" },
  ], (s) => DEALT3[s - 1]!);
  const CO3 = { AKo: 0.6 }, BTN0 = { AKo: 0.1 };     // the BTN walked to 1.2 combos: under the floor's 13.26
  const st = (line: string, pos: string, token: string, label: string, rangeIn: Record<string, number> | null, rangeOut: Record<string, number> | null): WalkStep =>
    ({ line, node: TREE3[line]!, pos, token, rawToken: token, label, labels: [label], rangeIn, rangeOut });
  const walk3 = (btn = BTN0): RecordedRangeWalk => ({
    tokens: ["F", "R2.5", "R8", "C", "F", "F", "F"], heroPos: "CO",
    steps: [st("", "UTG", "F", "Fold", null, null), st("F", "HJ", "R2.5", "Raise 2.5", null, HJ), st("F-R2.5", "CO", "R8", "Raise 8", null, CO3),
      st("F-R2.5-R8", "BTN", "C", "Call", null, btn), st("F-R2.5-R8-C", "SB", "F", "Fold", null, null), st("F-R2.5-R8-C-F", "BB", "F", "Fold", null, null),
      st("F-R2.5-R8-C-F-F", "HJ", "F", "Fold", HJ, {})],
    result: { ok: true, ranges: { CO: CO3, BTN: btn } },
  });
  const KEY = "coldcall3b_BTN_80p_large" as ColdCallKey;
  const note = (was = 1.2, key: ColdCallKey = KEY) =>
    `PREFLOP RANGES FROM THE PIN: toy · ${poolColdCallFloorNote([{ pos: "BTN", key, stack: 100, freq: 0.0166, calls: 1092, was, now: 21.98 }], "toy")} · DRY RUN: toy`;
  const pool = poolRangeOf({ kind: "coldcall", key: KEY, was: 0 })!;
  const o3 = (btnInput: Record<string, number>, n = note()) =>
    ({ truth: TRUTH3, heroPos: "CO", heroCards: ["Ah", "Kd"] as [string, string], note: n, dry: { ranges: { CO: CO3, BTN: btnInput }, flopSeats: ["CO", "BTN"] }, walks: [walk3()], get: get3 });

  test("the note's floors, read back from the services' own notes", () => {
    expect(pool && Object.keys(pool).length).toBeGreaterThan(10);
    expect([...poolFloorsOf(note())]).toEqual([["BTN", { kind: "coldcall", key: KEY, was: 1.2 }]]);
    const limp = poolLimpFloorNote([{ pos: "UTG", key: "limp_first_short_le60" as PoolLimpKey, stack: 30, freq: 0.1, n: 500, was: 3.5, now: 120 } as any], "toy");
    expect([...poolFloorsOf(`x · ${limp}`)]).toEqual([["UTG", { kind: "limp", key: "limp_first_short_le60", was: 3.5 }]]);
    expect(poolRangeOf({ kind: "limp", key: "limp_first_short_le60", was: 0 })).not.toBeNull();
  });
  test("the cold-caller floored to the pool range the note names passes both layers", async () => {
    expect(await layer1(o3(pool))).toEqual([]);
    const l2 = await layer2Postflop({ ...o3(pool), dealt: DEALT3, get: get3 });
    expect(l2.findings).toEqual([]);
  });
  test("without the note, the pool range is a range no walk produced", async () => {
    expect((await layer1(o3(pool, "PREFLOP RANGES FROM THE PIN: toy"))).map((x) => x.kind)).toContain("range-provenance");
  });
  test("a floored seat holding anything but the named pool range", async () => {
    const f = await layer1(o3({ ...pool, AA: 0.123 }));
    expect(f.map((x) => x.reason)).toEqual([expect.stringContaining("is not the pool's coldcall3b_BTN_80p_large")]);
  });
  test("the range the floor replaced must be a walk's output, and under 1% of hands", async () => {
    expect((await layer1(o3(pool, note(2.4)))).map((x) => x.reason)).toEqual([expect.stringContaining("before the pool floor (2.4 combos)")]);
    expect((await layer1(o3(pool, note(20)))).map((x) => x.reason)).toEqual([expect.stringContaining("the floor is for under 13.26")]);
  });
  test("the walk behind the floor is still judged: the chart's own product", async () => {
    const w = walk3({ AKo: 0.2 });
    const f = await layer1({ ...o3(pool, note(2.4)), walks: [w] });
    expect(f.map((x) => x.kind)).toEqual(["range-product"]);
  });
  test("a floor for a seat that never cold-called a 3-bet", async () => {
    // the toy 5-handed line: the CO called an open — no 3-bet
    const n = poolColdCallFloorNote([{ pos: "CO", key: "coldcall3b_CO_80p_large" as ColdCallKey, stack: 100, freq: 0.02, calls: 100, was: 4.8, now: 20 }], "toy");
    const coPool = poolRangeOf({ kind: "coldcall", key: "coldcall3b_CO_80p_large", was: 0 })!;
    const f = await layer1({ ...base, note: n, dry: { ranges: { HJ, CO: coPool }, flopSeats: ["HJ", "CO"] }, walks: [goodWalk()], get });
    expect(f.map((x) => x.reason)).toEqual([expect.stringContaining("did not cold-call a 3-bet")]);
  });
});
