import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";
import type { Enriched } from "../routes/dashboard";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { faithful4920544353 } from "../utils/ignitionHh/fixtures";
import { HhCheckStore, MAX_ENQUEUE_PER_TICK, tick, type CheckerDeps } from "./hhCheck";
import { FEED_BY_KEY_MAX, FEED_SQL, FinishedHandsFeed } from "./hhCheckFeed";

// THE FINISHED HANDS, INCREMENTALLY (2026-10-13): every tick asked for every finished hand since the cutoff and read
// each one's row for its client id — [stall] lines of 16-40 s "timer hhCheck (finished ids …)" on 2026-10-12 while the
// machine paged. The feed asks only above its high-water rowid plus the rows it saw in play, from the indexes.
const T0 = 1_790_000_000_000;
const ign = (n: number) => String(4_930_000_000 + n);
const BIG = JSON.stringify({ pad: "x".repeat(6_000) });   // a hand's JSON: past a page, client_hand_id lands on overflow

const setup = () => {
  const db = new Database(":memory:");
  ensureHandsSchema(db);
  const insert = (clientHandId: string | null, status: "live" | "done" = "done"): number =>
    Number(db.query("INSERT INTO hands (data, client_hand_id, status, updated_at) VALUES (?, ?, ?, ?)").run(BIG, clientHandId, status, T0).lastInsertRowid);
  const finish = (rowid: number) => db.query("UPDATE hands SET status = 'done', updated_at = ? WHERE rowid = ?").run(T0, rowid);
  const sqls: string[] = [];
  const spy = new Proxy(db, {
    get(target, k) {
      if (k === "query") return (sql: string) => { sqls.push(sql); return target.query(sql); };
      const v = Reflect.get(target, k);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const feed = new FinishedHandsFeed(() => spy, (id): id is string => !!id && /^\d{10}$/.test(id));
  return { db, insert, finish, feed, sqls };
};

describe("FinishedHandsFeed", () => {
  test("each finished hand after the cutoff once; nothing again when nothing finished", () => {
    const { insert, feed } = setup();
    insert(ign(0));                                         // before the cutoff
    const cutoff = insert(ign(1));
    insert(ign(2)); insert(ign(3));
    expect(feed.take(cutoff)).toEqual([ign(2), ign(3)]);
    expect(feed.take(cutoff)).toEqual([]);
    insert(ign(4));
    expect(feed.take(cutoff)).toEqual([ign(4)]);
    expect(feed.take(cutoff)).toEqual([]);
  });

  test("a hand that finishes AFTER a later-started one (multi-table) is still returned, once", () => {
    const { insert, finish, feed } = setup();
    const a = insert(ign(1), "live");                       // table 1's hand starts first …
    insert(ign(2));                                         // … table 2's starts later and finishes first
    expect(feed.take(0)).toEqual([ign(2)]);
    expect(feed.openRows).toBe(1);
    expect(feed.take(0)).toEqual([]);
    finish(a);
    expect(feed.take(0)).toEqual([ign(1)]);
    expect(feed.openRows).toBe(0);
    expect(feed.take(0)).toEqual([]);
  });

  test("a live row that never finishes stays open (one index probe), a missing rowid is not kept", () => {
    const { db, insert, feed } = setup();
    insert(ign(1), "live");                                 // the wrapper died mid-hand
    const gone = insert(ign(2));
    db.run(`DELETE FROM hands WHERE rowid = ${gone}`);
    insert(ign(3));
    expect(feed.take(0)).toEqual([ign(3)]);
    expect(feed.openRows).toBe(1);
    expect(feed.take(0)).toEqual([]);
  });

  test("only the ids the caller accepts (not CoinPoker's, not a row with no id)", () => {
    const { insert, feed } = setup();
    insert(ign(1)); insert("123456789012345"); insert(null); insert(ign(2));
    expect(feed.take(0)).toEqual([ign(1), ign(2)]);
  });

  test("many rows at once (a process's first call) come from idx_hands_client, the same ids in rowid order", () => {
    const { insert, finish, feed, sqls } = setup();
    const cutoff = insert(ign(0));
    const live = insert(ign(1), "live");
    for (let i = 2; i < FEED_BY_KEY_MAX + 20; i++) insert(i % 7 ? ign(i) : "123456789012345");
    const want = Array.from({ length: FEED_BY_KEY_MAX + 18 }, (_, k) => k + 2).filter((i) => i % 7).map(ign);
    expect(feed.take(cutoff)).toEqual(want);
    expect(sqls).toContain(FEED_SQL.idsIndexed);
    sqls.length = 0;
    finish(live);
    expect(feed.take(cutoff)).toEqual([ign(1)]);           // a few: by primary key
    expect(sqls).not.toContain(FEED_SQL.idsIndexed);
  });

  test("a call that fails part-way moves nothing: the next call returns the same hands", () => {
    const { db, insert, finish } = setup();
    const a = insert(ign(1), "live");
    insert(ign(2));
    let fail = false;
    const flaky = new Proxy(db, {
      get(target, k) {
        if (k === "query") return (sql: string) => { if (fail && sql.includes("client_hand_id")) throw new Error("database is locked"); return target.query(sql); };
        const v = Reflect.get(target, k);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const feed = new FinishedHandsFeed(() => flaky, (id): id is string => !!id);
    fail = true;
    expect(() => feed.take(0)).toThrow("database is locked");
    fail = false;
    expect(feed.take(0)).toEqual([ign(2)]);
    finish(a);
    fail = true;
    expect(() => feed.take(0)).toThrow("database is locked");
    fail = false;
    expect(feed.take(0)).toEqual([ign(1)]);
  });

  test("no database: nothing, and nothing moved", () => {
    let db: Database | null = null;
    const { db: real, insert } = setup();
    insert(ign(1));
    const feed = new FinishedHandsFeed(() => db, (id): id is string => !!id);
    expect(feed.take(0)).toEqual([]);
    db = real;
    expect(feed.take(0)).toEqual([ign(1)]);
  });

  test("which rows are finished is read from the indexes alone (no hand row is read)", () => {
    const { db } = setup();
    const plan = (sql: string) => db.query<{ detail: string }, number[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split("?").length - 1).fill(1)).map((r) => r.detail).join(" | ");
    expect(plan(FEED_SQL.doneIn)).toContain("COVERING INDEX idx_hands_status");
    expect(plan(FEED_SQL.doneOf(3))).toContain("COVERING INDEX idx_hands_status");
    expect(plan(FEED_SQL.idsIndexed)).toContain("COVERING INDEX idx_hands_client");
    expect(plan(FEED_SQL.exists(3))).toContain("INTEGER PRIMARY KEY");
    expect(plan(FEED_SQL.idsOf(3))).toContain("INTEGER PRIMARY KEY");
  });
});

describe("hhCheck tick on the feed", () => {
  const hand = (dbId: number, id: string): Enriched =>
    ({ dbId, clientHandId: id, playedAt: T0, hand: { ...faithful4920544353, clientHandId: id } as ParsedHand } as Partial<Enriched> as Enriched);

  const wire = () => {
    const s = setup();
    const store = new HhCheckStore(":memory:");
    let reads = 0;
    const deps: CheckerDeps = {
      store,
      fetchRecord: async () => ({ ok: false, reason: "unreachable", error: "test: no client" }),
      findArchived: (id) => {
        reads++;
        const r = s.db.query<{ rowid: number }, [string]>("SELECT rowid FROM hands WHERE client_hand_id = ? AND status = 'done'").get(id);
        return r ? hand(r.rowid, id) : null;
      },
      doneAfter: () => { throw new Error("the ids pass is given"); },
      newDoneIds: (cutoff) => s.feed.take(cutoff),
      lastRowid: () => s.db.query<{ m: number | null }, []>("SELECT max(rowid) m FROM hands").get()?.m ?? 0,
      now: () => T0,
    };
    return { ...s, store, deps, reads: () => reads };
  };

  test("hands over a tick's bound wait in memory: every one is checked though the feed returns each once", async () => {
    const { insert, store, deps, reads } = wire();
    await tick(deps, 0);                                    // sets the cutoff (0 rows)
    for (let i = 0; i < 60; i++) insert(ign(i));
    await tick(deps, 0);
    expect(store.checkedIds().size).toBe(MAX_ENQUEUE_PER_TICK);
    expect(store.waiting.size).toBe(60 - MAX_ENQUEUE_PER_TICK);
    await tick(deps, 0);
    await tick(deps, 0);
    expect(store.checkedIds().size).toBe(60);
    expect(store.waiting.size).toBe(0);
    await tick(deps, 0);
    expect(reads()).toBe(60);
  });

  test("multi-table: the earlier-started hand is checked when it finishes", async () => {
    const { insert, finish, store, deps } = wire();
    await tick(deps, 0);
    const a = insert(ign(1), "live");
    insert(ign(2));
    await tick(deps, 0);
    expect([...store.checkedIds()]).toEqual([ign(2)]);
    finish(a);
    await tick(deps, 0);
    expect(store.checkedIds().has(ign(1))).toBe(true);
  });

  test("a restart (a new feed, the same store) checks nothing twice", async () => {
    const { insert, store, deps, db } = wire();
    await tick(deps, 0);
    insert(ign(1)); insert(ign(2));
    await tick(deps, 0);
    let reads = 0;
    const feed2 = new FinishedHandsFeed(() => db, (id): id is string => !!id && /^\d{10}$/.test(id));
    const deps2: CheckerDeps = { ...deps, newDoneIds: (c) => feed2.take(c), findArchived: (id) => { reads++; return deps.findArchived(id); } };
    await tick(deps2, 0);
    expect(reads).toBe(0);
    expect(store.checkedIds().size).toBe(2);
  });
});
