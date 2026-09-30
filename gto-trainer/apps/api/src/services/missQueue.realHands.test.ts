/**
 * THE LIVE MISS QUEUE IS REAL HANDS ONLY (2026-09-26). The mutation harness (hands mh-…) and the post-in matrix
 * (postin-…) call fastSolve in-process with origin "harness"; fastSolve filed every origin but "replay" as "live", and
 * since the central data root those rows land in the one poker.sqlite the box queue reads — 1,299 of them became 606
 * queued HRC solves. Pinned here: who may file (missOriginOf), which hands are ours (isSyntheticHandId / isRealMissRef),
 * that the store refuses a synthetic ref, and that rows filed before the fix are invisible to every reader.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissQueue, isRealMissRef, isSyntheticHandId, isSyntheticMiss, missOriginOf, missQueue } from "./missQueue";
import { chartFor6max } from "./hrc6max";

/** An isolated store per test — never the live queue (left in tmp: Windows will not unlink an open SQLite file). */
const fresh = () => new MissQueue(join(mkdtempSync(join(tmpdir(), "mqreal-")), "mq.sqlite"));

const hand = (bb: number) => ({
  heroSeatId: 1, positions: { 1: "BTN", 2: "SB", 3: "BB", 4: "UTG" },
  stacks: { 1: 100, 2: 100, 3: bb, 4: 100 },
  committed: {}, actions: [], currentNode: { street: "preflop" }, bbCents: 200,
}) as never;
const ref = (clientHandId: string | null, origin: "live" | "replay" | "archive" | "corpus" = "live") =>
  ({ origin, clientHandId, handId: 1, actionIndex: 1, ts: 1 });

describe("missOriginOf — who may file", () => {
  it("files the study poller, its warm-up and a re-solve of an archived hand", () => {
    expect(missOriginOf("live")).toBe("live");
    expect(missOriginOf("warm")).toBe("live");
    expect(missOriginOf("replay")).toBe("replay");
  });
  it("files nothing for a caller answering hands it made up, or one that names no origin", () => {
    for (const o of ["harness", "golden", "stress", "bench", "playthrough", "probe", "adhoc", "", undefined, null])
      expect(missOriginOf(o)).toBeNull();
  });
  it("is not fooled by Object.prototype keys", () => {
    expect(missOriginOf("constructor")).toBeNull();
    expect(missOriginOf("toString")).toBeNull();
  });
});

describe("isSyntheticHandId / isRealMissRef — which hands are ours", () => {
  it("knows every id our own scripts mint", () => {
    for (const id of ["mh-163-short-seat", "mh-2-late-fold", "postin-109540", "stress-eso-02", "stress-limp-13", "depth-smoke-1-2",
      "smoke", "test1", "fake-7", "proof", "gaps", "refusal", "pfgap2", "pfx"])
      expect(isSyntheticHandId(id)).toBe(true);
  });
  it("never flags a poker client's hand number or a missing id", () => {
    for (const id of ["4917810302", "140508800001", 4919311168, null, undefined]) expect(isSyntheticHandId(id)).toBe(false);
  });
  it("a real ref: a real origin and an id none of our scripts made up", () => {
    expect(isRealMissRef(ref("4917810302"))).toBe(true);
    expect(isRealMissRef(ref("4917810302", "replay"))).toBe(true);
    expect(isRealMissRef(ref(null, "corpus"))).toBe(true); // the Zone corpus carries no client id
    expect(isRealMissRef(ref("mh-250-jam"))).toBe(false);
    expect(isRealMissRef(ref("postin-928"))).toBe(false);
    expect(isRealMissRef({ origin: "harness" as never, clientHandId: "4917810302" })).toBe(false);
    expect(isRealMissRef(null)).toBe(false);
  });
  it("a synthetic row is one only our hands hit — not one whose refs a sweep emptied", () => {
    expect(isSyntheticMiss({ refs: [ref("mh-1-base"), ref("postin-3")] })).toBe(true);
    expect(isSyntheticMiss({ refs: [ref("mh-1-base"), ref("4917810302")] })).toBe(false);
    expect(isSyntheticMiss({ refs: [] })).toBe(false);
  });
});

describe("the store", () => {
  it("refuses a synthetic ref even under a real origin", () => {
    const q = fresh();
    const tokens = ["R4"];                                 // 2026-09-30: a 40bb short facing 4x — two gaps the sets still have
    const choice = chartFor6max(hand(40), "BTN", tokens);
    expect(q.observe6max({ choice, hand: hand(40), heroPos: "BTN", tokens, walk: null, ref: ref("mh-163-short-seat") })).toEqual([]);
    expect(q.observe6max({ choice, hand: hand(40), heroPos: "BTN", tokens, walk: null, ref: ref("postin-5") })).toEqual([]);
    expect(q.list("all", { synthetic: true })).toHaveLength(0);
    // the same state from a real hand is written down
    expect(q.observe6max({ choice, hand: hand(40), heroPos: "BTN", tokens, walk: null, ref: ref("4917810302") }).length).toBeGreaterThan(0);
  });

  it("hides rows filed before the fix from every reader, and says how many", () => {
    const q = fresh();
    const tokens = ["R4"];
    const choice = chartFor6max(hand(40), "BTN", tokens);
    q.observe6max({ choice, hand: hand(40), heroPos: "BTN", tokens, walk: null, ref: ref("4917810302") });
    // rewrite them as the pre-fix code left them: one row only the harness hit, one a real hand and the post-in matrix hit
    const db = new Database(q.path);
    const rs = (xs: object[]) => JSON.stringify(xs);
    db.query("UPDATE misses SET refs_json = ?, n = 2, n_live = 2 WHERE kind = 'open-not-in-set'").run(rs([ref("mh-163-short-seat"), { ...ref("mh-22-short-seat"), actionIndex: 2 }]));
    db.query("UPDATE misses SET refs_json = ?, n = 2, n_live = 2 WHERE kind = 'short-rung-snapped'").run(rs([ref("4917810302"), ref("postin-928")]));
    db.close();

    expect(q.list("all").map((m) => m.kind)).toEqual(["short-rung-snapped"]);
    expect(q.list("open").map((m) => m.kind)).toEqual(["short-rung-snapped"]);
    expect(q.list("all", { synthetic: true })).toHaveLength(2);

    const s = q.stats();
    expect(s.synthetic).toBe(1);
    expect(s.total).toBe(1);
    expect(s.byKind).toEqual({ "short-rung-snapped": 1 });

    // the approximations register: the synthetic row is gone, and the mixed row loses the post-in matrix's hit
    const v = q.volumeByKind();
    expect(v["open-not-in-set"]).toBeUndefined();
    expect(v["short-rung-snapped"]).toMatchObject({ rows: 1, live: 1 });
  });
});

// END TO END through fastSolve: needs the 6-max chart bake, which a worktree does not carry (harnessEnv points
// HRC6MAX_DB at the main checkout's) — gated like the harness fixtures (MUTATION_GATE=1, setup/regress.ts).
describe.skipIf(process.env.MUTATION_GATE !== "1")("fastSolve files a chart miss for real hands only", () => {
  let restore: () => void = () => {};
  let fastSolve: typeof import("./fastSolve").fastSolve;
  beforeAll(async () => {
    const h = await import("../scripts/mutationHarness");
    restore = h.harnessEnv();
    ({ fastSolve } = await import("./fastSolve"));
  });
  afterAll(() => restore());

  const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" };
  // CO opens 2x into hero's BTN, the BB has 81bb: the uneven set has no 2x open and no 81bb rung — two PATCH kinds,
  // the ones the chart factory's patch jobs turn into HRC solves
  const spot = (clientHandId: string) => ({
    handId: Number(clientHandId), clientHandId, bbCents: 200, heroSeatId: 4, heroCards: ["Ah", "Kd"], board: [], street: "preflop",
    actions: [
      { seatId: 5, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
      { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
      { seatId: 1, hero: false, type: "fold", street: "preflop" },
      { seatId: 2, hero: false, type: "fold", street: "preflop" },
      { seatId: 3, hero: false, type: "raise", amount: 2, street: "preflop" },
    ],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: { 3: 2, 5: 0.5, 6: 1 }, potByStreet: {}, positions: POS,
    stacks: { 1: 100, 2: 100, 3: 98, 4: 100, 5: 99.5, 6: 80 },
    currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 3.5, toCall: 2, legalActions: [], complete: false },
    ended: false,
  }) as never;
  const filedFor = (id: string) => missQueue.list("all", { synthetic: true }).filter((m) => m.refs.some((r) => r.clientHandId === id));

  it("the harness's decision files nothing — even with an id that looks like a client's", async () => {
    await fastSolve(spot("4999000001"), "BTN", { strategyId: "ign200-ring-6max-equilibrium", origin: "harness" });
    expect(filedFor("4999000001")).toHaveLength(0);
  });
  it("the same decision at the table is written down", async () => {
    await fastSolve(spot("4999000002"), "BTN", { strategyId: "ign200-ring-6max-equilibrium", origin: "live" });
    const rows = filedFor("4999000002");
    expect(rows.map((m) => m.kind)).toEqual(expect.arrayContaining(["open-not-in-set", "short-rung-snapped"]));
    expect(rows.every((m) => m.refs.find((r) => r.clientHandId === "4999000002")!.origin === "live")).toBe(true);
  });
});
