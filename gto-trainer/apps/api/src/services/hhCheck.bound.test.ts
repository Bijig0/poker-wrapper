import { describe, expect, test } from "bun:test";
import type { Enriched } from "../routes/dashboard";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { faithful4920544353, record4920544353 } from "../utils/ignitionHh/fixtures";
import { HhCheckStore, MAX_ENQUEUE_PER_TICK, freshCheck, tick, type CheckerDeps } from "./hhCheck";

// THE QUEUE IS BOUNDED (2026-10-09): "check rows ×3844 5.2 s" every 10 s in the live session's [stall] lines was one
// store.get per finished hand per tick. Now the checked set is read once, at most MAX_ENQUEUE_PER_TICK new hands are
// read a tick, and they are saved in one transaction.
const T0 = 1_790_000_000_000;
const hand = (dbId: number, id: string): Enriched =>
  ({ dbId, clientHandId: id, playedAt: T0, hand: { ...faithful4920544353, clientHandId: id } as ParsedHand } as Partial<Enriched> as Enriched);

describe("hhCheck tick, bounded", () => {
  const setup = (n: number) => {
    const hands = Array.from({ length: n }, (_, i) => hand(10 + i, String(4_930_000_000 + i)));
    const store = new HhCheckStore(":memory:");
    const counts = { get: 0, save: 0, saveMany: 0, reads: 0, idsQueries: 0 };
    const origGet = store.get.bind(store), origSave = store.save.bind(store), origMany = store.saveMany.bind(store);
    store.get = (id) => { counts.get++; return origGet(id); };
    store.save = (c) => { counts.save++; origSave(c); };
    store.saveMany = (cs) => { counts.saveMany++; origMany(cs); };
    const deps: CheckerDeps = {
      store,
      fetchRecord: async () => ({ ok: false, reason: "unreachable", error: "test: no client" }),
      findArchived: (id) => { counts.reads++; return hands.find((h) => h.clientHandId === id) ?? null; },
      doneAfter: () => { throw new Error("the ids pass is given"); },
      newDoneIds: (rowid) => { counts.idsQueries++; return hands.filter((h) => h.dbId > rowid).map((h) => h.clientHandId!); },
      lastRowid: () => 5,
      now: () => T0,
    };
    return { hands, store, counts, deps };
  };

  test("at most MAX_ENQUEUE_PER_TICK new hands a tick, saved in ONE transaction; no per-hand lookup", async () => {
    const { store, counts, deps } = setup(60);
    await tick(deps, 0);                                   // sets the cutoff
    await tick(deps, 0);
    expect(counts.reads).toBe(MAX_ENQUEUE_PER_TICK);
    expect(counts.saveMany).toBe(1);
    expect(counts.get).toBe(0);
    expect(store.checkedIds().size).toBe(MAX_ENQUEUE_PER_TICK);
    await tick(deps, 0);
    await tick(deps, 0);
    expect(store.checkedIds().size).toBe(60);
    await tick(deps, 0);                                   // nothing new: no read, nothing saved
    expect(counts.reads).toBe(60);
    expect(counts.get).toBe(0);
  });

  test("the checked set follows saves made after it was read", async () => {
    const { store } = setup(0);
    expect(store.checkedIds().size).toBe(0);
    store.save(freshCheck(hand(7, "4920544353"), T0));
    expect(store.checkedIds().has("4920544353")).toBe(true);
    expect(new HhCheckStore(":memory:").checkedIds().size).toBe(0);
  });

  test("a finished hand that cannot be read is not read again every tick", async () => {
    const { counts, deps } = setup(3);
    deps.findArchived = (id) => { counts.reads++; return id.endsWith("1") ? null : null; };
    await tick(deps, 0);
    await tick(deps, 0);
    await tick(deps, 0);
    expect(counts.reads).toBe(3);
  });

  test("due attempts are capped by maxAttempts", async () => {
    const { counts, deps } = setup(10);
    let fetches = 0;
    deps.fetchRecord = async () => { fetches++; return { ok: true, body: record4920544353, fetchedAt: null, cached: false }; };
    await tick(deps, 2);
    await tick(deps, 2);
    expect(fetches).toBe(2);
    expect(counts.saveMany).toBe(1);
  });
});
