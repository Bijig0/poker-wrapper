import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChartStore, type ChartStoreOpts } from "./chartStore";
import { testTempDir } from "../test/tempDir";

// The chart server's doc cache is keyed by chart id: a body converted again under the same id was served from memory
// until evicted or restarted, and the GTOW crawl SQLite was opened once.
const stores: ChartStore[] = [];
const root = testTempDir("data-reread-", { release: () => stores.forEach((s) => s.close()) });
let dirs = 0;
const fresh = () => { const d = join(root, `c${++dirs}`); mkdirSync(d); return d; };

const gz = (o: unknown) => Bun.gzipSync(new TextEncoder().encode(JSON.stringify(o)));
/** write a chart's sidecar + body; `secondsAgo` gives the body an mtime of its own (Windows' clock is coarse) */
function chart(dir: string, id: string, nodes: Record<string, unknown>, secondsAgo = 120) {
  writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({ id, label: id }));
  const body = join(dir, `${id}.json.gz`);
  writeFileSync(body, gz({ meta: { id }, nodes }));
  aged(body, secondsAgo);
  return body;
}
const aged = (p: string, secondsAgo: number) => { const t = new Date(Date.now() - secondsAgo * 1000); utimesSync(p, t, t); };
function store(dir: string, o: Partial<ChartStoreOpts> = {}) {
  const s = new ChartStore({ dir, remote: "", bigMax: 2, bigBytesMax: 1e12, smallMax: 2, smallBytes: 1024, diskCapBytes: 1e12,
    pinnedPrefixes: [], preflopDb: join(dir, "crawl.sqlite"), log: () => {}, bodyCheckMs: 0, bodySettleMs: 0, crawlCheckMs: 0, ...o });
  stores.push(s);
  return s;
}
const q = (s: Record<string, string>) => new URLSearchParams(s);

describe("ChartStore follows chart bodies", () => {
  test("a body converted again under the same id is read again on the next hit", async () => {
    const d = fresh();
    const body = chart(d, "hu", { "": { n: 0 } });
    const s = store(d);
    expect(await s.node(q({ source: "hu", line: "" }))).toEqual({ n: 0 });
    // same size, same file: only the gzip trailer (and the mtime) differ
    writeFileSync(body, gz({ meta: { id: "hu" }, nodes: { "": { n: 1 } } })); aged(body, 60);
    expect(await s.node(q({ source: "hu", line: "" }))).toEqual({ n: 1 });
    writeFileSync(body, gz({ meta: { id: "hu" }, nodes: { "": { n: 2 }, R2: { n: 3 } } })); aged(body, 30);
    expect(await s.node(q({ source: "hu", line: "R2" }))).toEqual({ n: 3 });
  });

  test("unchanged, only touched, or gone from disk: the resident doc is served (no re-read)", async () => {
    const d = fresh();
    const body = chart(d, "hu", { "": { n: 0 } });
    const s = store(d);
    const first = await s.doc("hu");
    expect(await s.doc("hu")).toBe(first);
    aged(body, 10);                                   // a touch (server.py, another chart server's disk LRU)
    expect(await s.doc("hu")).toBe(first);
    unlinkSync(body);                                 // the disk cap evicted it: R2 holds it
    expect(await s.doc("hu")).toBe(first);
  });

  test("a body still being written is not read until it settles; between checks it is not stat'ed", async () => {
    const d = fresh();
    const body = chart(d, "hu", { "": { n: 0 } });
    const s = store(d, { bodySettleMs: 60_000 });
    const first = await s.doc("hu");
    writeFileSync(body, gz({ meta: { id: "hu" }, nodes: { "": { n: 1 }, F: {} } }));   // mtime = now: being written
    expect(await s.doc("hu")).toBe(first);
    aged(body, 120);                                  // the writer finished two minutes ago
    expect(((await s.doc("hu"))!.nodes[""] as { n: number }).n).toBe(1);

    const t = store(d, { bodyCheckMs: 60_000 });
    const held = await t.doc("hu");
    writeFileSync(body, gz({ meta: { id: "hu" }, nodes: { "": { n: 2 } } })); aged(body, 90);
    expect(await t.doc("hu")).toBe(held);             // inside bodyCheckMs: no stat
  });

  test("a body that grew past the small-body size moves LRUs: one entry, its new size", async () => {
    const d = fresh();
    const body = chart(d, "grew", { "": { n: 0 } });
    const s = store(d);
    await s.doc("grew");
    expect(s.resident()).toEqual({ big: [], small: ["grew"] });
    const pad = randomBytes(7000).toString("base64");   // incompressible: the gzip body is past smallBytes (1024)
    writeFileSync(body, gz({ meta: { id: "grew" }, nodes: { "": { pad } } })); aged(body, 60);
    await s.doc("grew");
    expect(s.resident()).toEqual({ big: ["grew"], small: [] });
    expect(s.cacheReport().big.docs[0]!.bytes).toBeGreaterThan(pad.length);
  });
});

describe("ChartStore follows the GTOW crawl SQLite", () => {
  test("missing → not found; created later → read; rewritten → reopened and read", async () => {
    const d = fresh();
    const crawl = join(d, "crawl.sqlite");
    const s = store(d);
    expect(((await s.node(q({ line: "" }))) as { error: string }).error).toMatch(/^preflop DB not found/);
    const db = new Database(crawl, { create: true });
    db.exec(`CREATE TABLE nodes (gametype TEXT, depth INTEGER, line TEXT, pos TEXT, reach REAL, actions TEXT, cells TEXT,
               terminal INTEGER, PRIMARY KEY (gametype, depth, line))`);
    const ins = db.query("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)");
    ins.run("Cash6m500zGeneral", 100, "", "UTG", 1, "[]", "[]", 0);
    expect(await s.node(q({ line: "" }))).toMatchObject({ ok: true, line: "", pos: "UTG" });
    ins.run("Cash6m500zGeneral", 100, "R2.5", "HJ", 0.2, "[]", "[]", 0);
    db.close();
    aged(crawl, 30);
    expect(await s.node(q({ line: "R2.5" }))).toMatchObject({ ok: true, pos: "HJ" });
  });
});
