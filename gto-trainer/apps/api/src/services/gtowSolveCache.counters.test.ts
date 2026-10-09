import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import { GtowSolveCache, NODE_OK, NO_NODE, runScanWorker } from "./gtowSolveCache";
import { scanCache, type ScanReply } from "./gtowCacheScanWorker";

// THE ROW COUNTERS (2026-10-09): the cache's size is never COUNTED on the API's thread any more — summary(), stats via
// the route and the size cap read four counters kept in gtow_cache_totals, moved in the same transaction as each write.
// A file from before the counters is counted once, in a Worker, never while a session is live.
const caches: GtowSolveCache[] = [];
const dir = testTempDir("gtow-cache-counters-", { release: () => { for (const c of caches) c.close(); } });
let n = 0;
const fileOf = () => join(dir, `c${++n}.sqlite`);
const open = (path: string, opts: { maxBytes?: number; archiveDir?: string | null } = {}) => { const c = new GtowSolveCache({ path, flushMs: 1, ...opts }); caches.push(c); return c; };
const node = (pad = 10) => JSON.stringify({ action_solutions: [{ pad: "x".repeat(pad) }] });
const counters = (path: string) => {
  const db = new Database(path, { readonly: true });
  const m = Object.fromEntries((db.query("SELECT name, n FROM gtow_cache_totals WHERE name LIKE 'rows_%'").all() as { name: string; n: number }[]).map((r) => [r.name, r.n]));
  db.close();
  return m;
};
const truth = (path: string) => { const r = scanCache(path, 0); if (!r.ok) throw new Error(r.error); return r.rows; };

describe("gtow cache row counters", () => {
  it("a new file is seeded at zero and the counters follow every insert and verdict upgrade exactly", () => {
    const path = fileOf();
    const c = open(path);
    c.noteTree("k1", "post", JSON.stringify({ a: 1 }));
    c.putNode("k1", "a", NODE_OK, node(500));
    c.putNode("k1", "b", NO_NODE, null);
    c.flush();
    c.putNode("k1", "b", NODE_OK, node(800));               // the verdict replaced by a full node
    c.noteTree("k2", "pre", JSON.stringify({ b: 2 }));
    c.putNode("k2", "x", NO_NODE, null);
    c.flush();
    const t = truth(path);
    expect(c.summary()).toMatchObject({ trees: t.trees, nodes: t.nodes });
    const k = counters(path);
    expect(k).toMatchObject({ rows_trees: t.trees, rows_nodes: t.nodes, rows_neg: t.negatives, rows_bytes: t.storedBytes });
    expect(k.rows_seeded).toBeGreaterThan(0);
    expect(t).toMatchObject({ trees: 2, nodes: 3, negatives: 1 });
  });

  it("age deletion and eviction move the counters with the rows; the cap is read from them", async () => {
    const path = fileOf();
    const c = open(path);
    c.noteTree("old", "post", "{}");
    c.putNode("old", "x", NODE_OK, node(50));
    c.noteTree("new", "post", "{}");
    for (const a of ["n1", "n2", "n3", "n4", "n5"]) c.putNode("new", a, NODE_OK, JSON.stringify({ action_solutions: [{ pad: Array.from({ length: 1500 }, () => Math.random().toString(36).slice(2)).join("") }] }));
    c.close();
    const now = Date.now();
    const db = new Database(path);
    db.query("UPDATE gtow_cache_trees SET last_hit_ms = ? WHERE key = 'old'").run(now - 61 * 86_400_000);
    db.query("UPDATE gtow_cache_nodes SET last_hit_ms = ? WHERE key = 'old'").run(now - 61 * 86_400_000);
    ["n1", "n2", "n3", "n4", "n5"].forEach((a, i) => db.query("UPDATE gtow_cache_nodes SET last_hit_ms = ? WHERE addr = ?").run(now - (10 - i) * 60_000, a));
    const total = (db.query("SELECT SUM(bytes) b FROM gtow_cache_nodes WHERE key = 'new'").get() as { b: number }).b;
    db.close();
    const c2 = open(path, { maxBytes: Math.round(total * 0.62) });
    c2.liveNow = () => false;
    await c2.maintenance();
    expect(c2.summary().trees).toBe(1);
    const t = truth(path);
    expect(counters(path)).toMatchObject({ rows_trees: t.trees, rows_nodes: t.nodes, rows_neg: t.negatives, rows_bytes: t.storedBytes });
    expect(t.storedBytes).toBeLessThanOrEqual(total * 0.62);
  });

  it("a file from before the counters reads 'counting…' and is counted once, off the loop (the scan is the Worker's)", async () => {
    const path = fileOf();
    const a = open(path);
    a.noteTree("k", "post", "{}");
    a.putNode("k", "a", NODE_OK, node(300));
    a.putNode("k", "b", NO_NODE, null);
    a.close();
    const db = new Database(path);
    db.query("DELETE FROM gtow_cache_totals WHERE name LIKE 'rows_%'").run();   // as an old file
    db.close();
    const c = new GtowSolveCache({ path, flushMs: 1 });
    caches.push(c);
    let scans = 0;
    let release!: (r: ScanReply) => void;
    c.scanOffLoop = (p, recent) => { scans++; return new Promise((res) => { release = (r) => res(r); void recent; void p; }); };
    c.liveNow = () => false;
    expect(c.summary()).toMatchObject({ trees: null, nodes: null });
    expect(scans).toBe(1);
    // a write while the scan runs is added to its totals
    c.putNode("k", "c", NODE_OK, node(100));
    c.flush();
    release(scanCache(path, 0));           // the scan saw the file as it is now — this test's write included
    await c.whenSeeded();
    const t = truth(path);
    const k = counters(path);
    // the in-flight write is counted twice at most (scan + delta): the documented bound of a seed racing a write
    expect(k.rows_trees).toBe(t.trees);
    expect(k.rows_nodes).toBeGreaterThanOrEqual(t.nodes);
    expect(k.rows_nodes).toBeLessThanOrEqual(t.nodes + 1);
    (c as any).summaryMemo = null;
    expect(c.summary().trees).toBe(1);
  });

  it("never starts the counting scan while a poker session is live", () => {
    const path = fileOf();
    const a = open(path);
    a.noteTree("k", "post", "{}");
    a.putNode("k", "a", NODE_OK, node(10));
    a.close();
    const db = new Database(path);
    db.query("DELETE FROM gtow_cache_totals WHERE name LIKE 'rows_%'").run();
    db.close();
    const c = new GtowSolveCache({ path, flushMs: 1 });
    caches.push(c);
    let scans = 0;
    c.scanOffLoop = async () => { scans++; return { ok: false, error: "no" }; };
    c.liveNow = () => true;
    expect(c.summary().trees).toBeNull();
    expect(scans).toBe(0);
  });

  it("the Worker counts a real file on its own thread", async () => {
    const path = fileOf();
    const a = open(path);
    a.noteTree("k", "post", "{}");
    a.putNode("k", "a", NODE_OK, node(300));
    a.flush();
    const r = await runScanWorker(path, 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toMatchObject({ trees: 1, nodes: 1, negatives: 0 });
  });
  // THE MAINTENANCE WINDOW (Brady 2026-10-09): eviction, retention, vacuum and the counting scan only while no session
  // is live, in batches of at most MAINT_BUDGET_MS with the live check between them
  const bigFile = (nodes: number) => {
    const path = fileOf();
    const a = open(path);
    a.noteTree("t", "post", "{}");
    for (let i = 0; i < nodes; i++) a.putNode("t", `n${i}`, NODE_OK, JSON.stringify({ action_solutions: [{ pad: Array.from({ length: 300 }, () => Math.random().toString(36).slice(2)).join("") }] }));
    a.close();
    return path;
  };

  it("writes over the cap are kept until the window: flush never evicts", () => {
    const path = bigFile(30);
    const c = open(path, { maxBytes: 10_000 });
    c.liveNow = () => true;
    c.noteTree("u", "post", "{}");
    c.putNode("u", "x", NODE_OK, node(50));
    c.flush();
    expect(truth(path).nodes).toBe(31);
  });

  it("no maintenance while a session is live", async () => {
    const path = bigFile(30);
    const c = open(path, { maxBytes: 10_000 });
    c.liveNow = () => true;
    const r = await c.maintenance();
    expect(r).toMatchObject({ ran: false, why: "a poker session is live" });
    expect(truth(path).nodes).toBe(30);
  });

  it("a session that starts mid-pass stops it between batches; the counters stay exact; the next window finishes", async () => {
    const path = bigFile(400);
    const c = open(path, { maxBytes: 20_000 });
    let checks = 0;
    c.liveNow = () => ++checks > 3;            // live from the 4th check on
    const r1 = await c.maintenance();
    expect(r1.stoppedBy).toBe("a poker session started");
    const mid = truth(path);
    expect(mid.nodes).toBeGreaterThan(0);
    expect(counters(path)).toMatchObject({ rows_nodes: mid.nodes, rows_bytes: mid.storedBytes });
    c.liveNow = () => false;
    const r2 = await c.maintenance();
    expect(r2.stoppedBy).toBeUndefined();
    const end = truth(path);
    expect(end.storedBytes).toBeLessThanOrEqual(20_000);
    expect(counters(path)).toMatchObject({ rows_nodes: end.nodes, rows_trees: end.trees, rows_bytes: end.storedBytes });
  });

  // NOTHING EVICTED IS LOST (Brady 2026-10-09): the window moves every row it removes to the cold archive first
  it("evicted and expired rows are MOVED: present in the month's archive, absent from the hot file, found by the archive lookup", async () => {
    const path = bigFile(40);
    const archiveDir = join(dir, `arch${n}`);
    const c = open(path, { maxBytes: 20_000, archiveDir });
    c.liveNow = () => false;
    const r = await c.maintenance();
    expect(r.ran).toBe(true);
    expect(r.archived).toBe(r.rows);
    const hot = new Database(path, { readonly: true });
    const left = new Set((hot.query("SELECT addr FROM gtow_cache_nodes").all() as { addr: string }[]).map((x) => x.addr));
    hot.close();
    const arch = new Database(r.archivedTo!, { readonly: true });
    const moved = (arch.query("SELECT addr, status, bytes FROM gtow_cache_nodes").all() as { addr: string }[]).map((x) => x.addr);
    arch.close();
    expect(moved.length).toBeGreaterThan(0);
    for (const a of moved) expect(left.has(a)).toBe(false);          // moved, not copied
    expect(moved.length + left.size).toBe(40);                         // nothing lost
    const gone = moved[0]!;
    expect(c.getNode("t", gone, false)).toBeNull();                   // the live path does not see it
    const back = c.getNodeArchived("t", gone)!;                       // the hand page / offline read path does
    expect(back.status).toBe(NODE_OK);
    expect(back.data.action_solutions.length).toBe(1);
  });

  it("no archive, no deletion: an archive that cannot be opened stops the pass before anything is removed", async () => {
    const path = bigFile(20);
    const blocker = join(dir, `notadir${n}`);
    await Bun.write(blocker, "a file where the archive directory should be");
    const c = open(path, { maxBytes: 10_000, archiveDir: join(blocker, "sub") });
    c.liveNow = () => false;
    const r = await c.maintenance();
    expect(r).toMatchObject({ ran: false, why: "the cold archive cannot be opened" });
    expect(truth(path).nodes).toBe(20);
  });
});
