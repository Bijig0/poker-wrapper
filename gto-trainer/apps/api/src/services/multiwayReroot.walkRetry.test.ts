/**
 * THE RE-ROOT'S NARROWING WALKS: RETRY ONCE + THE NOT-NARROWED FALLBACK (2026-10-07, stress-500 po_56way-003).
 * Limped 5-way, the SB bets 1.25 on 3h5s3c and all four call; turn SB x, BB x, hero (UTG, KdQh) to act. No collapse
 * from the flop, so the turn is re-rooted and three walks (SB/BB/UTG, SB/UTG/HJ, SB/UTG/BTN) narrow the ranges entering
 * it. One stalled poll on the SB/UTG/BTN walk used to fail the whole re-root → no answer. The walks are stubbed here
 * (spyOn solveAiChain, scripted per group); everything else is the real planning.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as aiChain from "./aiChain";
import { rerootCollapse, walkFailureIsTransient, type RerootArgs } from "./multiwayReroot";
import { rerootWalkFailedNote, rerootWalkFailedReason } from "./fastSolve";
import { departureForCode, departureForWarning } from "./approximations";

const STALL = "node: AI solve timed out on primary — 1 poll: 0 answered 204 (not solved yet), 1 failed (last: poll request failed: The operation timed out.) (that account may have hit its daily solution limit, or the client lost connection).";
const NO_NODE = "node: spot-solution 400: {\"code\":\"NODE_DOES_NOT_EXIST\"}";

type Reply = { ok: true } | { ok: false; why: string } | { delayMs: number; ok: true };
/** per group ("SB/BB/UTG"), the replies in order; past the end, a success */
let script: Record<string, Reply[]> = {};
const calls: string[] = [];
const NARROW = 0.5;
const spy = spyOn(aiChain, "solveAiChain").mockImplementation((async (spec: any) => {
  const seats = [spec.oopPos, spec.midPos, spec.ipPos].filter(Boolean) as string[];
  const key = seats.join("/");
  calls.push(key);
  const r = script[key]?.shift() ?? { ok: true };
  if ("delayMs" in r) await new Promise((res) => setTimeout(res, r.delayMs));
  if (!r.ok) return { ok: false, why: r.why };
  return { ok: true, data: {}, potNode: 0, stackStreet: 0, line: "", solves: 0, trace: { spec } as any,
    rangesOut: Object.fromEntries(seats.map((p) => [p, new Array(1326).fill(NARROW)])) };
}) as any);
afterAll(() => spy.mockRestore());
afterEach(() => { script = {}; calls.length = 0; delete process.env.REROOT_WALK_FALLBACK; delete process.env.REROOT_RETRY_MIN_MS; });

/** po_56way-003's turn, hero UTG to act after SB x, BB x */
const turn = (o: Partial<RerootArgs> = {}): RerootArgs => ({
  ordered: ["SB", "BB", "UTG", "HJ", "BTN"], heroPos: "UTG", arr: () => new Array(1326).fill(1),
  streets: [["R1.25", "C", "C", "C", "C"], ["X", "X"]],
  streetSeats: [["SB", "BB", "UTG", "HJ", "BTN"], ["SB", "BB"]],
  flopPot: 5, flopStack: 79, board: "3h5s3cTd", heroComboIdx: null, rake: null,
  behind: { SB: 99, BB: 99, UTG: 79, HJ: 99, BTN: 149 },
  specOf: (three, heroIdx) => ({ oopPos: three[0]!.pos, midPos: three[1]!.pos, ipPos: three[2]!.pos, oopRange: three[0]!.range,
    midRange: three[1]!.range, ipRange: three[2]!.range, heroSeat: heroIdx === 0 ? "oop" : heroIdx === 1 ? "mid" : "ip" }),
  deadline: Date.now() + 60_000,
  ...o,
});
/** a seat's range on the re-rooted plans: NARROW (a walk's) or 1 (the flop arrival's) */
const rangeOn = (r: Awaited<ReturnType<typeof rerootCollapse>>, pos: string): number | undefined => {
  if (!r.ok) return undefined;
  for (const pl of r.picked.plans) for (const s of pl.seats) if (s.pos === pos) return s.range[0];
  return undefined;
};

describe("walkFailureIsTransient", () => {
  test.each([
    ["the stress hand's stalled poll (504)", STALL, true],
    ["a 504 whose polls all answered 204", "node: AI solve timed out on secondary — 30 polls: 30 answered 204 (not solved yet), 0 failed (that account may have hit its daily solution limit, or the client lost connection).", true],
    ["a tree create that timed out", "solve: primary: custom-trees The operation timed out.", true],
    ["a 5xx mid-poll", "node: AI solve timed out on primary — 3 polls: 1 answered 204 (not solved yet), 2 failed (last: spot-solution 503: Service Unavailable)", true],
    ["a 502 body on tree create", "solve: custom-trees: <html><head><title>502 Bad Gateway</title></head></html>", true],
    ["a reset socket", "node: primary: ECONNRESET", true],
    ["NODE_DOES_NOT_EXIST", NO_NODE, false],
    ["VALIDATION_ERROR", "node: spot-solution 422: {\"code\":\"VALIDATION_ERROR\"}", false],
    ["a quota wall", "node: spot-solution 429: Request limit exceeded", false],
    ["a lost token", "solve: primary: no access token", false],
    ["an action not offered", "\"C\" not walkable at FLOP#3 (offered: F, RAI)", false],
    ["a capture fault", "street closed but more actions follow (capture corruption?)", false],
    ["a verdict from the solve cache", "node: 400: NODE_DOES_NOT_EXIST (from the solve cache)", false],
    ["anything unrecognised", "empty node mid-walk", false],
  ])("%s", (_name, why, want) => expect(walkFailureIsTransient(why)).toBe(want));
});

describe("rerootCollapse: a narrowing walk that fails", () => {
  test("all walks succeed: three walks, nothing unnarrowed, no failure listed (today's answer)", async () => {
    const r = await rerootCollapse(turn());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.sort()).toEqual(["SB/BB/UTG", "SB/UTG/BTN", "SB/UTG/HJ"]);
    expect(r.walks).toBe(3);
    expect(r.unnarrowed).toBeUndefined();
    expect(r.failedWalks).toBeUndefined();
    expect(r.left).toBe("HJ, BTN, BB");
  });

  test("a transient failure is retried once and the retry's ranges are used", async () => {
    script["SB/UTG/BTN"] = [{ ok: false, why: STALL }];
    const r = await rerootCollapse(turn());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.filter((c) => c === "SB/UTG/BTN").length).toBe(2);
    expect(calls.length).toBe(4);
    expect(r.walks).toBe(3);
    expect(r.unnarrowed).toBeUndefined();
    expect(r.failedWalks).toBeUndefined();
  });

  test("fails twice: its seat enters NOT NARROWED, the others keep their walks' ranges", async () => {
    script["SB/BB/UTG"] = [{ ok: false, why: STALL }, { ok: false, why: STALL }];
    const r = await rerootCollapse(turn());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.length).toBe(4);
    expect(r.walks).toBe(2);
    expect(r.unnarrowed).toEqual(["BB"]);
    expect(r.failedWalks).toEqual([{ group: ["SB", "BB", "UTG"], why: STALL, retry: "retried once, failed again", lost: ["BB"] }]);
    expect(rangeOn(r, "BB")).toBe(1);          // the flop arrival
    expect(rangeOn(r, "SB")).toBe(NARROW);     // held by the other walks
    expect(rangeOn(r, "UTG")).toBe(NARROW);
    // the seats left out of the walks USED (SB/UTG/HJ leaves out BB and BTN, SB/UTG/BTN leaves out BB and HJ)
    expect(r.left).toBe("BB, BTN, HJ");
  });

  test("a final failure (NODE_DOES_NOT_EXIST) is not retried", async () => {
    script["SB/BB/UTG"] = [{ ok: false, why: NO_NODE }];
    const r = await rerootCollapse(turn());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.length).toBe(3);
    expect(r.failedWalks?.[0]?.retry).toBe("not retried: not a transient failure");
    expect(r.unnarrowed).toEqual(["BB"]);
  });

  test("no room before the narrowing deadline: not retried, the seat enters NOT NARROWED", async () => {
    script["SB/BB/UTG"] = [{ ok: false, why: STALL }];
    const r = await rerootCollapse(turn({ deadline: Date.now() + 1_000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.length).toBe(3);
    expect(r.failedWalks?.[0]?.retry).toMatch(/^not retried: \d+\.\d s of the narrowing deadline left$/);
    expect(r.unnarrowed).toEqual(["BB"]);
  });

  test("no deadline given: never retried", async () => {
    script["SB/BB/UTG"] = [{ ok: false, why: STALL }];
    const r = await rerootCollapse(turn({ deadline: undefined }));
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(3);
    if (r.ok) expect(r.failedWalks?.[0]?.retry).toBe("not retried: no narrowing deadline to retry within");
  });

  test("a retry still walking at the deadline is not waited for", async () => {
    process.env.REROOT_RETRY_MIN_MS = "50";
    script["SB/BB/UTG"] = [{ ok: false, why: STALL }, { delayMs: 1_500, ok: true }];
    const t0 = Date.now();
    const r = await rerootCollapse(turn({ deadline: Date.now() + 300 }));
    expect(Date.now() - t0).toBeLessThan(1_200);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.failedWalks?.[0]?.retry).toMatch(/^retried once, still walking at the narrowing deadline/);
    expect(r.unnarrowed).toEqual(["BB"]);
  });

  test("every walk fails: every seat, hero too, enters with the flop-arrival range — still answered, three-handed", async () => {
    for (const g of ["SB/BB/UTG", "SB/UTG/HJ", "SB/UTG/BTN"]) script[g] = [{ ok: false, why: STALL }, { ok: false, why: STALL }];
    const r = await rerootCollapse(turn());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.walks).toBe(0);
    expect(r.failedWalks?.length).toBe(3);
    expect([...(r.unnarrowed ?? [])].sort()).toEqual(["BB", "BTN", "HJ", "SB", "UTG"]);
    expect(r.failedWalks?.[0]?.lost).toEqual(["SB", "BB", "UTG"]);   // the first failed walk lists its seats
    for (const pl of r.picked.plans) for (const s of pl.seats) expect(s.range[0]).toBe(1);
    expect(r.picked.plans[0]!.seats.length).toBe(3);
    expect(r.left).toBe("none");
  });

  test("REROOT_WALK_FALLBACK=off: a failed walk refuses the re-root as before (the retry stays)", async () => {
    process.env.REROOT_WALK_FALLBACK = "off";
    script["SB/UTG/BTN"] = [{ ok: false, why: STALL }, { ok: false, why: STALL }];
    const r = await rerootCollapse(turn());
    expect(calls.length).toBe(4);
    expect(r).toEqual({ ok: false, why: `narrowing walk SB/UTG/BTN: ${STALL}` });
  });
});

describe("the note and the chain-path reason", () => {
  const f1 = { group: ["SB", "UTG", "BTN"], why: STALL, retry: "not retried: 1.2 s of the narrowing deadline left", lost: ["BTN"] };
  test("one failed walk names the walk, why, the retry and the seat", () => {
    const n = rerootWalkFailedNote([f1], "UTG", 2);
    expect(n.startsWith("NARROWING WALK FAILED: SB/UTG/BTN (node: AI solve timed out on primary")).toBe(true);
    expect(n).toContain("; not retried: 1.2 s of the narrowing deadline left) — BTN enters NOT NARROWED, with the flop-arrival range.");
    expect(departureForWarning(n)?.id).toBe("no-legal-collapse");
  });
  test("every walk failed: hero is named", () => {
    const n = rerootWalkFailedNote([{ ...f1, lost: ["SB", "UTG", "BTN"] }], "UTG", 0);
    expect(n).toContain("Every narrowing walk failed: every seat, hero (UTG) too, enters with the flop-arrival range");
  });
  test("the reason is registered", () => {
    const x = rerootWalkFailedReason([f1], "turn");
    expect(x.code).toBe("postflop:reroot-walk-failed");
    expect(x.v).toBe("rebuilt");
    expect(x.text).toContain("BTN not narrowed");
    expect(departureForCode(x.code)?.id).toBe("no-legal-collapse");
  });
});
