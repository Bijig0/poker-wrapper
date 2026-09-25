import { describe, expect, test } from "bun:test";
import type { Enriched } from "../routes/dashboard";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { archived4920544353, faithful4920544353, record4920544353 } from "../utils/ignitionHh/fixtures";
import { HhCheckStore, RETRY_DELAYS_MS, UNREACHABLE_RETRY_MS, freshCheck, nextCheck, tick, type CheckerDeps } from "./hhCheck";
import type { RecordResult } from "./ignitionRecord";

const T0 = 1_790_000_000_000;
const enriched = (dbId: number, hand: ParsedHand): Enriched =>
  ({ dbId, clientHandId: hand.clientHandId!, playedAt: T0, hand } as Partial<Enriched> as Enriched);
const pending = freshCheck(enriched(7, archived4920544353), T0);

describe("nextCheck", () => {
  test("a comparison settles the check: whole-hand verdict, and whether it held up to hero's last action", () => {
    const d = [{ kind: "action-extra" as const, field: "x", ours: "a", ignition: "—" }];
    expect(nextCheck(pending, { kind: "compared", diffs: [], through: [] }, T0)).toMatchObject({ status: "match", throughOk: true, nextAt: null });
    expect(nextCheck(pending, { kind: "compared", diffs: d, through: [] }, T0)).toMatchObject({ status: "mismatch", throughOk: true });
    expect(nextCheck(pending, { kind: "compared", diffs: d, through: d }, T0)).toMatchObject({ status: "mismatch", throughOk: false });
  });

  test("not found is retried on the schedule, then given up on", () => {
    const miss = { ok: false as const, reason: "not-found" as const, error: "no hand history" };
    const once = nextCheck(pending, miss, T0);
    expect(once).toMatchObject({ status: "pending", tries: 1, nextAt: T0 + RETRY_DELAYS_MS[1]! });
    const last = Array.from({ length: RETRY_DELAYS_MS.length }).reduce<typeof pending>((c) => nextCheck(c, miss, T0), pending);
    expect(last).toMatchObject({ status: "unavailable", nextAt: null });
  });

  test("an unreachable client costs no try", () => {
    const down = nextCheck(pending, { ok: false, reason: "unreachable", error: "client closed" }, T0);
    expect(down).toMatchObject({ status: "pending", tries: 0, nextAt: T0 + UNREACHABLE_RETRY_MS, error: "client closed" });
  });
});

describe("tick", () => {
  const depsFor = (hands: Enriched[], record: RecordResult, lastRowid = 5): CheckerDeps => ({
    store: new HhCheckStore(":memory:"),
    fetchRecord: async () => record,
    findArchived: (id) => hands.findLast((h) => h.clientHandId === id) ?? null,
    archivedAfter: (rowid) => hands.filter((h) => h.dbId > rowid),
    lastRowid: () => lastRowid,
    now: () => T0,
  });
  const found: RecordResult = { ok: true, body: record4920544353, fetchedAt: null, cached: false };

  test("the first pass only marks where 'from here on' starts", async () => {
    const deps = depsFor([enriched(3, faithful4920544353)], found);
    await tick(deps);
    expect(deps.store.meta("afterRowid")).toBe("5");
    expect(deps.store.get("4920544353")).toBeNull();
  });

  test("a hand archived after that is compared with Ignition's record and the verdict kept", async () => {
    const deps = depsFor([enriched(6, archived4920544353)], found);
    await tick(deps);
    await tick(deps);
    expect(deps.store.get("4920544353")).toMatchObject({
      dbId: 6, status: "mismatch", throughOk: true, tries: 1,
      diffs: [{ kind: "board-extra" }, { kind: "action-extra", oursAt: 18 }],
    });
    expect(deps.store.meta("afterRowid")).toBe("6");
  });

  test("a record Ignition does not have yet stays pending for the next try", async () => {
    const deps = depsFor([enriched(6, faithful4920544353)], { ok: false, reason: "not-found", error: "no hand history" });
    await tick(deps);
    await tick(deps);
    expect(deps.store.get("4920544353")).toMatchObject({ status: "pending", tries: 1, nextAt: T0 + RETRY_DELAYS_MS[1]! });
  });
});
