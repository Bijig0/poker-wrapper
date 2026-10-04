import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { hrc6maxDb } from "../services/hrc6maxDb";
import { registerAuditLine, solveRegister } from "../services/solveRegister";
import { ChartReviews } from "../services/chartReviews";
import { chartsReviewRoutes } from "./chartsReview";

// THE REVIEW PAGE'S DATA + THE SOLVE REGISTER'S READ SIDE (2026-10-04). The live chart for a spot is meant to be the best
// measured solve of it; Brady reviews every chart before anything is promoted. Never "0" when the register cannot be read.

const dir = mkdtempSync(join(tmpdir(), "chartsreview-"));
const bakePath = join(dir, "bake.sqlite"), regPath = join(dir, "register.sqlite"), revDir = join(dir, "chart-review");
const A = "ign200_6max_D150_o2_5", B = "ign200_6max_D100_o3";
const RAW_A = "a".repeat(64), RAW_B = "b".repeat(64);
const env = { db: process.env.HRC6MAX_DB, reg: process.env.SOLVE_REGISTER, dir: process.env.CHART_REVIEW_DIR };

function bake(): void {
  rmSync(bakePath, { force: true });
  const db = new Database(bakePath, { create: true });
  db.exec(`CREATE TABLE nodes (source TEXT, line TEXT, pos TEXT, terminal INTEGER NOT NULL, actions TEXT NOT NULL, cells BLOB NOT NULL,
             pruned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source,line)) WITHOUT ROWID;
           CREATE TABLE trees (source TEXT PRIMARY KEY, nodes INTEGER NOT NULL, built_at INTEGER NOT NULL, src_mtime INTEGER NOT NULL, src_size INTEGER NOT NULL);
           CREATE TABLE provenance (source TEXT PRIMARY KEY, raw_sha256 TEXT, body_sha256 TEXT NOT NULL, converter TEXT, plan TEXT, refine_min INTEGER,
             status TEXT NOT NULL, set_at TEXT, src_mtime INTEGER NOT NULL, src_size INTEGER NOT NULL, written_at INTEGER NOT NULL);`);
  const cells = deflateSync(Buffer.from(JSON.stringify([{ hand: "AA", actions: { "Raise 2.5": 100 } }, { hand: "72o", actions: { Fold: 100 } }])));
  for (const [s, raw] of [[A, RAW_A], [B, RAW_B]] as const) {
    db.query("INSERT INTO nodes (source,line,pos,terminal,actions,cells) VALUES (?,?,?,?,?,?)")
      .run(s, "", "UTG", 0, JSON.stringify([{ action: "Fold", token: "F" }, { action: "Raise 2.5", token: "R2.5" }]), cells);
    db.query("INSERT INTO trees VALUES (?,?,?,?,?)").run(s, 1, 0, 1, 1);
    db.query("INSERT INTO provenance VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(s, raw, "c".repeat(64), "x", "grid", 240, "verified", "t", 1, 1, 0);
  }
  db.close();
}
function register(liveRawOfA = RAW_A): void {
  solveRegister.reload();   // Windows: an open handle locks the file
  rmSync(regPath, { force: true });
  const db = new Database(regPath, { create: true });
  db.exec(`CREATE TABLE proposals (chart_id TEXT PRIMARY KEY, live_raw TEXT, live_score REAL, cand_raw TEXT, cand_score REAL, common_nodes INTEGER,
             better_pct REAL, verdict TEXT, cand_where TEXT, candidates INTEGER, runner_up_raw TEXT, runner_up_score REAL, at INTEGER)`);
  db.query("INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(A, liveRawOfA, 0.0017, "d".repeat(64), 0.0011, 433, 35, "promote", "[]", 2, "d".repeat(64), 0.0011, 1);
  db.query("INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(B, RAW_B, 0.0010, null, null, 400, 4, "keep", null, 2, "e".repeat(64), 0.00096, 1);
  db.close();
  solveRegister.reload();
}

beforeAll(() => {
  process.env.HRC6MAX_DB = bakePath; process.env.SOLVE_REGISTER = regPath; process.env.CHART_REVIEW_DIR = revDir;
  bake(); hrc6maxDb.reload();
  mkdirSync(revDir, { recursive: true });
});
afterAll(() => {
  for (const [k, v] of [["HRC6MAX_DB", env.db], ["SOLVE_REGISTER", env.reg], ["CHART_REVIEW_DIR", env.dir]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  hrc6maxDb.reload(); solveRegister.reload();
  rmSync(dir, { recursive: true, force: true });
});

describe("solve register (read side)", () => {
  it("no register: 'register not readable', the count null - never 0", () => {
    solveRegister.reload(); rmSync(regPath, { force: true });
    const a = solveRegister.audit([A, B], (id) => hrc6maxDb.provenance(id)?.raw);
    expect(a).toMatchObject({ readable: false, clearlyBetter: null });
    expect(registerAuditLine(a)).toContain("register not readable");
    expect(solveRegister.chart(A)).toBeNull();
  });
  it("counts the charts with a clearly better solve that is not live; per chart candidates / live / runner-up", () => {
    register();
    const a = solveRegister.audit([A, B], (id) => hrc6maxDb.provenance(id)?.raw);
    expect(a).toMatchObject({ readable: true, clearlyBetter: 1, clearlyBetterIds: [A] });
    expect(solveRegister.chart(B)).toMatchObject({ candidates: 2, liveScore: 0.001, runnerUpScore: 0.00096, verdict: "keep" });
    expect(registerAuditLine(a)).toContain("1 of 2 baked charts have a CLEARLY better solve");
  });
  it("a proposal made for another live raw (stale) does not count", () => {
    register("f".repeat(64));
    expect(solveRegister.audit([A, B], (id) => hrc6maxDb.provenance(id)?.raw).clearlyBetter).toBe(0);
  });
});

describe("chart reviews (poker.sqlite chart_reviews)", () => {
  it("keyed by the raw sha: a verdict for another solve is not this solve's review", () => {
    const r = new ChartReviews(":memory:");
    r.record(A, RAW_A, "flag", "AJs folds more than ATs vs the CO open");
    expect(r.latest({ [A]: RAW_A })[A]).toMatchObject({ verdict: "flag", note: expect.stringContaining("AJs") });
    expect(r.latest({ [A]: "f".repeat(64) })[A]).toBeUndefined();
    r.record(A, RAW_A, "ok");
    expect(r.latest({ [A]: RAW_A })[A]!.verdict).toBe("ok");
    expect(() => r.record(A, "nope", "ok")).toThrow();
    expect(() => r.record(A, RAW_A, "maybe" as never)).toThrow();
  });
});

describe("chart review routes", () => {
  it("index without precomputed summaries: 404 that says what to run", async () => {
    const res = await chartsReviewRoutes.request("/index");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("chart_review.py");
  });
  it("index, chart, node grid and a review round trip", async () => {
    register();
    writeFileSync(join(revDir, "index.json"), JSON.stringify({ meta: { built_at: "t", margin: 0.15 }, charts: [
      { id: A, words: "150bb · open 2.5x", group: "even", raw: RAW_A, flags: 1 }, { id: B, words: "100bb · open 3x", group: "even", raw: RAW_B, flags: 0 }] }));
    writeFileSync(join(revDir, `${A}.json`), JSON.stringify({ id: A, raw: RAW_A, words: "150bb · open 2.5x", flags: [], rfi: [], facing: [], vs3bet: [] }));
    const idx = await (await chartsReviewRoutes.request("/index")).json();
    expect(idx.register).toMatchObject({ readable: true, clearlyBetter: 1 });
    expect(idx.progress).toMatchObject({ reviewed: 0, of: 2 });
    expect(idx.charts.find((c: any) => c.id === A).register).toMatchObject({ verdict: "promote", betterPct: 35 });
    const ch = await (await chartsReviewRoutes.request(`/chart/${A}`)).json();
    expect(ch).toMatchObject({ ok: true, liveRaw: RAW_A, staleSummary: false });
    const node = await (await chartsReviewRoutes.request(`/node/${A}?line=`)).json();
    expect(node.node.cells.find((c: any) => c.hand === "AA").actions).toEqual({ "Raise 2.5": 100 });
    expect(node.guard).toMatchObject({ applies: process.env.TRUST_GUARD_ALL === "1", starved: false });   // the live guard's verdict rides along
    expect((await chartsReviewRoutes.request(`/node/ign200_6max_not_baked?line=`)).status).toBe(404);
    const wrong = await chartsReviewRoutes.request("/review", { method: "POST", body: JSON.stringify({ chartId: A, raw: "f".repeat(64), verdict: "ok" }) });
    expect(wrong.status).toBe(409);
    const ok = await chartsReviewRoutes.request("/review", { method: "POST", body: JSON.stringify({ chartId: A, raw: RAW_A, verdict: "flag", note: "KK folds" }) });
    expect((await ok.json()).review).toMatchObject({ chartId: A, raw: RAW_A, verdict: "flag" });
    const idx2 = await (await chartsReviewRoutes.request("/index")).json();
    expect(idx2.progress).toMatchObject({ reviewed: 1, flagged: 1 });
  });
  it("rejects a malformed id or line", async () => {
    expect((await chartsReviewRoutes.request("/chart/..%2Fx")).status).toBe(400);
    expect((await chartsReviewRoutes.request(`/node/${A}?line=R2.5;drop`)).status).toBe(400);
  });
});
