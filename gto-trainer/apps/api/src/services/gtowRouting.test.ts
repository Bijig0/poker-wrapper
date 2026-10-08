import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GtowLoad, type LoadCounts, type LoadView } from "./gtowLoad";
import { GtowSessions, routeWhy } from "./gtowSessions";

/**
 * LEAST-LOADED ROUTING (2026-10-08, Brady: "rotate through all the accounts we have … split evenly"). A registry of two
 * Elite and three Ultra accounts; the pool reads each account's trailing-hour load from a counter the test controls.
 */
let dir: string;
const prevPath = process.env.GTOW_ACCOUNTS_PATH;
const row = (id: string, name: string, tier: "elite" | "ultra", order: number, preflopOrder: number, port: number) => ({
  id, name, tier, multiway: tier === "ultra", cdpHost: `127.0.0.1:${port}`, launchHint: "", client: "chrome", exe: null, profileDir: null,
  enabled: true, order, preflopOrder, priceMonthly: null, notes: "", probeSolId: null, accountEmail: null, accountId: null,
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gtow-route-"));
  process.env.GTOW_ACCOUNTS_PATH = join(dir, "gtow-accounts.json");
  // today's registry shape plus one more of each: Elites first for postflop, Ultras first for preflop
  writeFileSync(process.env.GTOW_ACCOUNTS_PATH, JSON.stringify({ version: 1, accounts: [
    row("secondary", "Elite 1", "elite", 1, 2, 9223), row("elite-2", "Elite 2", "elite", 2, 3, 9225),
    row("primary", "Ultra", "ultra", 3, 1, 9222), row("ultra-2", "Ultra 2", "ultra", 4, 2, 9224), row("ultra-3", "Ultra 3", "ultra", 5, 2, 9226),
  ] }));
});
afterEach(() => {
  if (prevPath === undefined) delete process.env.GTOW_ACCOUNTS_PATH; else process.env.GTOW_ACCOUNTS_PATH = prevPath;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

/** A counter the test drives: h1 / h24 per account. */
class FakeLoad implements LoadView {
  h1: Record<string, number> = {};
  h24: Record<string, number> = {};
  counts(id: string): LoadCounts { return { h1: this.h1[id] ?? 0, h24: this.h24[id] ?? this.h1[id] ?? 0, pending: 0 }; }
  add(id: string, n: number) { this.h1[id] = (this.h1[id] ?? 0) + n; this.h24[id] = (this.h24[id] ?? 0) + n; }
}
const ELITES = ["secondary", "elite-2"];
const ULTRAS = ["primary", "ultra-2", "ultra-3"];
const ALL = [...ELITES, ...ULTRAS];

describe("balanced routing (GTOW_ROUTE unset)", () => {
  test("heads-up trees spread over all five accounts by load", () => {
    const load = new FakeLoad();
    const pool = new GtowSessions({ load, env: {} });
    const took: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      const id = pool.route({ multiway: false })[0]!;
      took[id] = (took[id] ?? 0) + 1;
      load.add(id, 6);   // a tree's requests
    }
    expect(Object.keys(took).sort()).toEqual([...ALL].sort());
    for (const id of ALL) expect(took[id]).toBe(20);
    // at equal load the preference order breaks the tie: round-robin in it
    expect(new GtowSessions({ load: new FakeLoad(), env: {} }).route({})).toEqual(ALL);
  });

  test("multiway trees go to the Ultras only, spread over the three", () => {
    const load = new FakeLoad();
    const pool = new GtowSessions({ load, env: {} });
    const took: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const order = pool.route({ multiway: true });
      expect(order.every((x) => ULTRAS.includes(x))).toBe(true);
      took[order[0]!] = (took[order[0]!] ?? 0) + 1;
      load.add(order[0]!, 8);
    }
    expect(took).toEqual({ primary: 10, "ultra-2": 10, "ultra-3": 10 });
  });

  test("self-correcting: while the Ultras carry multiway work, heads-up work leans on the Elites", () => {
    const load = new FakeLoad();
    const pool = new GtowSessions({ load, env: {} });
    const hu: Record<string, number> = {};
    for (let i = 0; i < 60; i++) {
      const mw = pool.route({ multiway: true })[0]!; load.add(mw, 6);          // one three-way tree …
      const h = pool.route({})[0]!; load.add(h, 6); hu[h] = (hu[h] ?? 0) + 1;   // … and one heads-up tree
    }
    const elites = ELITES.reduce((n, x) => n + (hu[x] ?? 0), 0);
    expect(elites).toBeGreaterThan(40);   // 2 of 5 accounts would be 24 by count alone
    const totals = ALL.map((x) => load.h1[x] ?? 0);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(6);   // every account within one tree
  });

  test("preflop work: the Ultras by load, then the Elites (heads-up preflop only) as the last resort", () => {
    const load = new FakeLoad();
    load.add("primary", 300); load.add("ultra-2", 100); load.add("ultra-3", 200); load.add("secondary", 0);
    const pool = new GtowSessions({ load, env: {} });
    expect(pool.route({ preflop: true })).toEqual(["ultra-2", "ultra-3", "primary", "secondary", "elite-2"]);
    expect(pool.route({ preflop: true, multiway: true })).toEqual(["ultra-2", "ultra-3", "primary"]);
  });

  test("an account past its hour budget takes work only when every other one is past it too", () => {
    const load = new FakeLoad();
    const pool = new GtowSessions({ load, env: { GTOW_HOUR_BUDGET: "1800" } });
    load.add("secondary", 1800);
    for (const x of ALL.filter((y) => y !== "secondary")) load.add(x, 1500);
    expect(pool.route({}).at(-1)).toBe("secondary");
    expect(pool.route({})[0]).not.toBe("secondary");
    // all past it: still routable (never dark), least loaded first
    for (const x of ALL.filter((y) => y !== "secondary")) load.add(x, 400);   // 1900 each
    const order = pool.route({});
    expect(order.length).toBe(5);
    expect(order[0]).toBe("secondary");
    const ex = pool.explainRoute({});
    expect(ex.overBudget.sort()).toEqual([...ALL].sort());
    expect(routeWhy("secondary", ex, order)).toMatch(/^budget \(every capable account is past a soft budget/);
  });

  test("the day budget moves an account to the end the same way", () => {
    const load = new FakeLoad();
    load.h1 = { secondary: 10 };
    load.h24 = { secondary: 5000 };
    const pool = new GtowSessions({ load, env: { GTOW_DAY_BUDGET: "5000" } });
    expect(pool.route({}).at(-1)).toBe("secondary");
  });

  test("a walled account never takes work while another can (it is only in the last-ditch list)", () => {
    const load = new FakeLoad();
    load.add("primary", 0);
    for (const x of ALL.filter((y) => y !== "primary")) load.add(x, 1000);
    const pool = new GtowSessions({ load, env: {} });
    expect(pool.route({})[0]).toBe("primary");
    pool.noteFailure("primary", 429, '{"detail":"Request limit exceeded"}');
    expect(pool.route({})).not.toContain("primary");
    expect(pool.route({ multiway: true })).toEqual(["ultra-2", "ultra-3"]);
    expect(pool.routeIgnoringBlocks({})[0]).toBe("primary");
  });

  test("the allowlist and a disabled account filter exactly as before", () => {
    const pool = new GtowSessions({ load: new FakeLoad(), env: {} });
    pool.setAllow(["primary", "secondary"]);
    expect(pool.route({})).toEqual(["secondary", "primary"]);
    expect(pool.route({ multiway: true })).toEqual(["primary"]);
  });

  test("the [gtow-route] reason: least-loaded, with each account's trailing hour", () => {
    const load = new FakeLoad();
    load.add("primary", 50); load.add("secondary", 10);
    const pool = new GtowSessions({ load, env: {} });
    const ex = pool.explainRoute({});
    expect(routeWhy(ex.ids[0]!, ex, ex.ids)).toMatch(/^least-loaded; trailing hour: elite-2 0\/h/);
    expect(routeWhy("primary", ex, ex.ids, ["elite-2: no token"])).toMatch(/^fallback \(elite-2: no token\)/);
  });
});

describe("priority routing (GTOW_ROUTE=priority) = the old order, whatever the load", () => {
  test("postflop by `order`, preflop by `preflopOrder`, multiway capable only", () => {
    const load = new FakeLoad();
    load.add("secondary", 2000); load.add("elite-2", 900);
    const pool = new GtowSessions({ load, env: { GTOW_ROUTE: "priority" } });
    expect(pool.route({})).toEqual(ALL);
    expect(pool.route({ multiway: true })).toEqual(ULTRAS);
    // preflopOrder 1 primary, then 2s in registry order (secondary, ultra-2, ultra-3), then elite-2 (3)
    expect(pool.route({ preflop: true })).toEqual(["primary", "secondary", "ultra-2", "ultra-3", "elite-2"]);
    // and a pool with no counter is the same order in balanced mode for postflop (every load 0)
    expect(new GtowSessions({ env: {} }).route({})).toEqual(ALL);
  });
});

describe("the load counter (services/gtowLoad)", () => {
  test("seeds once from the ledger, counts its own writes at once, syncs other processes' rows by id without double counting", () => {
    const now = Date.now();
    const rows = [
      { id: 1, s: "primary", ts: now - 2 * 3_600_000 },   // in the day, not the hour
      { id: 2, s: "primary", ts: now - 10_000 },
      { id: 3, s: "secondary", ts: now - 5_000 },
    ];
    let afterCalls = 0;
    const load = new GtowLoad();
    load.setSource({ seed: (since) => rows.filter((r) => r.ts >= since), after: (id) => { afterCalls++; return rows.filter((r) => r.id > id); } });
    expect(load.counts("primary", now)).toEqual({ h1: 1, h24: 2, pending: 0 });
    // our own write: counted now, and skipped when the sync meets its row
    rows.push({ id: 4, s: "primary", ts: now });
    load.note("primary", now, 4);
    // another process's write: counted at the next sync
    rows.push({ id: 5, s: "ultra-2", ts: now });
    expect(load.counts("primary", now).h1).toBe(2);
    expect(load.counts("ultra-2", now).h1).toBe(0);
    load.ensure(now, true);
    expect(load.counts("primary", now).h1).toBe(2);
    expect(load.counts("ultra-2", now).h1).toBe(1);
    // reads are not queries: a thousand route reads inside the sync interval cost no ledger read
    const before = afterCalls;
    for (let i = 0; i < 1000; i++) load.counts("primary", now);
    expect(afterCalls).toBe(before);
    // the hour rolls: an hour later only the day counts it
    expect(load.counts("primary", now + 3_600_001)).toMatchObject({ h1: 0, h24: 3 });
  });

  test("a routed tree is reserved on its account until its requests are noted", () => {
    const load = new GtowLoad();
    load.reserve("primary");
    expect(load.counts("primary").pending).toBe(5);
    load.note("primary", Date.now());
    load.note("primary", Date.now());
    expect(load.counts("primary")).toMatchObject({ h1: 2, pending: 3 });
    // so trees routed in the same instant spread: the second goes elsewhere
    const pool = new GtowSessions({ load, env: {} });
    const a = pool.route({ multiway: true })[0]!;
    pool.noteRouted(a, { multiway: true }, [a]);
    expect(pool.route({ multiway: true })[0]).not.toBe(a);
  });
});
