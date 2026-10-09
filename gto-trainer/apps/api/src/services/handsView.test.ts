import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import { HandsView, HANDS_VIEW_OVERLAP_MS } from "./handsView";
import { ensureHandsSchema, FINISHED } from "../../../../packages/data-root/handsSchema";
import { __resetLivePriority, setCached } from "./livePriority";
import { __resetSetupLive, noteSetupPoll } from "./setupLive";
import { __setSessionLiveReader } from "./sessionLive";

// THE FINISHED HANDS IN MEMORY (2026-10-09, catalogue-incremental): the dashboard's allRows() reads this instead of the
// whole hands table; it must equal the table's finished rows after every kind of write the wrapper makes.
const dbs: Database[] = [];
const dir = testTempDir("hands-view-", { release: () => dbs.forEach((d) => { try { d.close(); } catch { /* closed */ } }) });
let k = 0;
const COLS = "rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data, status, updated_at";
type Row = { rowid: number; data: string; status: string | null; updated_at: number | null };

function setup(n: number, mode: "loop" | "worker" = "loop") {
  const path = join(dir, `h${++k}.sqlite`);
  const reader = new Database(path); dbs.push(reader);
  reader.exec("PRAGMA journal_mode = WAL");
  ensureHandsSchema(reader);
  const writer = new Database(path); dbs.push(writer);   // the wrapper: another connection
  const now = Date.now();
  const ins = writer.query("INSERT INTO hands (hand_id, played_at, stakes, data, client_hand_id, status, updated_at) VALUES (?,?,?,?,?,?,?)");
  writer.transaction(() => {
    for (let i = 1; i <= n; i++) ins.run(i, now - (n - i) * 60_000, "$1/$2", JSON.stringify({ clientHandId: String(4_920_000_000 + i), pad: "x".repeat(2_000) }),
      String(4_920_000_000 + i), i % 50 === 0 ? "live" : "done", i % 3 === 0 ? null : now - (n - i) * 60_000);
  })();
  let t = now;
  const view = new HandsView<Row>(COLS, FINISHED, (r) => r.status === "done");
  view.setClock(() => t);
  view.seedMode = mode;
  view.setSource({ path, db: () => reader });
  const sql = () => reader.query<Row, []>(`SELECT ${COLS} FROM hands WHERE ${FINISHED} ORDER BY rowid`).all();
  return { view, writer, sql, setNow: (x: number) => { t = x; }, now: () => t };
}
const same = (a: Row[] | null, b: Row[]) => {
  expect(a).not.toBeNull();
  expect(a!.map((r) => [r.rowid, r.updated_at, r.status, r.data])).toEqual(b.map((r) => [r.rowid, r.updated_at, r.status, r.data]));
};

describe("HandsView", () => {
  for (const mode of ["loop", "worker"] as const) {
    it(`seeds (${mode}) to exactly the table's finished rows; rows carry no extra key`, async () => {
      const { view, sql } = setup(700, mode);
      expect(view.rows()).toBeNull();                       // before the seed: the caller reads the table
      expect(await view.whenReady()).toBe(true);
      expect(view.lastSeed!.mode).toBe(mode);
      same(view.rows(), sql());
      expect(Object.keys(view.rows()![0]!).sort()).toEqual(COLS.split(", ").sort());
    });
  }

  it("follows the wrapper's writes: a new finished hand, a live hand finishing, a patch, a row going back to live", async () => {
    const { view, writer, sql, setNow } = setup(200);
    await view.whenReady();
    const t = Date.now() + 60_000;
    setNow(t + HANDS_VIEW_OVERLAP_MS + 1);                 // the seed's writes are old news
    writer.run("INSERT INTO hands (hand_id, data, status, updated_at) VALUES (?,?,?,?)", [999, '{"clientHandId":"4921000001"}', "done", t]);
    writer.run("UPDATE hands SET status = 'done', data = ?, updated_at = ? WHERE rowid = 50", ['{"clientHandId":"4920000050","finished":1}', t + 1]);
    writer.run("UPDATE hands SET data = ?, updated_at = ? WHERE rowid = 10", ['{"clientHandId":"4920000010","award":1}', t + 2]);
    writer.run("UPDATE hands SET status = 'live', updated_at = ? WHERE rowid = 11", [t + 3]);
    same(view.rows(), sql());
    expect(view.rows()!.some((r) => r.rowid === 11)).toBe(false);
  });

  it("an insert patched a moment later without moving updated_at is still read (the overlap)", async () => {
    const { view, writer, sql, setNow } = setup(50);
    await view.whenReady();
    const t = Date.now() + 120_000;
    setNow(t + 1_000);                                     // inside the overlap of the newest write
    writer.run("INSERT INTO hands (hand_id, data, status, updated_at) VALUES (?,?,?,?)", [1, '{"clientHandId":"4921000002"}', "done", t]);
    view.rows();                                           // reads the row before its patch…
    const id = (writer.query("SELECT max(rowid) m FROM hands").get() as { m: number }).m;
    writer.run("UPDATE hands SET data = ? WHERE rowid = ?", ['{"clientHandId":"4921000002","dbId":1}', id]);   // …the patch (no updated_at)
    setNow(t + 2_000);
    same(view.rows(), sql());                              // …and re-reads it while the write is under the overlap old
  });

  it("a warm read of 6,500 hands is a copy of an array, not a table read", async () => {
    const { view } = setup(6_500, "worker");
    expect(await view.whenReady()).toBe(true);
    expect(view.lastSeed!.maxSliceMs).toBeLessThan(50);
    view.rows();
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) view.rows();
    expect((performance.now() - t0) / 10).toBeLessThan(10);
  });

  it("no source: never ready, the caller reads the table", async () => {
    const view = new HandsView<Row>(COLS, FINISHED, (r) => r.status === "done");
    expect(await view.whenReady()).toBe(false);
    expect(view.rows()).toBeNull();
  });
});

// GET /api/dashboard/profiles/alerts: cached, and while a session is live (or the setup page is open) the copy is served,
// never rebuilt on the loop (2026-10-09 10:26:48Z: open across an 11.3 s freeze mid-session)
describe("GET /profiles/alerts — cached behind live", () => {
  afterEach(() => { __resetLivePriority(); __resetSetupLive(); __setSessionLiveReader(() => null); });

  it("a fresh copy is served as is; a stale one is served (not rebuilt) while live", async () => {
    let now = 50_000_000;
    __resetLivePriority(() => now);
    __resetSetupLive(() => now);
    __setSessionLiveReader(() => null, () => now);
    const { default: app, PROFILE_ALERTS_KEY } = await import("../routes/dashboard");
    const payload = { ok: true, count: 3, live: null, items: [], marker: "cached" };
    setCached(PROFILE_ALERTS_KEY, payload);
    expect(await (await app.request("/profiles/alerts")).json()).toEqual(payload);
    now += 10 * 60_000;                                    // long stale
    noteSetupPoll();                                       // the setup page is open: counts as live
    const t0 = performance.now();
    expect(await (await app.request("/profiles/alerts")).json()).toEqual(payload);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
