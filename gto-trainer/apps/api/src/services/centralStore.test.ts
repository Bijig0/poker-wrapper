/**
 * THE ONE DATA ROOT (gto-trainer/DATA-ROOT-PLAN.md), API side: the central DB is where the stores go, a stored chain is
 * only ever shown for its own hand (hand 973), the trace header survives "—"/"≈"/suits, and the hands table's live rows
 * are listed apart from the finished ones every analytic reads.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SolveStore } from "./solveStore";
import { centralDbPath, dataLayout, handsDbPath, solvesDbPath, gtowRequestsPath, pollerEventsPath } from "./storePaths";
import { headerJson } from "../routes/fastSolver";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";

describe("the stores resolve to the central DB", () => {
  test("under bun test: one temp root, and every SQLite store is its poker.sqlite", () => {
    expect(dataLayout().mode).toBe("test");
    const central = centralDbPath();
    expect(central.startsWith(dataLayout().root)).toBe(true);
    for (const p of [handsDbPath(), solvesDbPath(), gtowRequestsPath(), pollerEventsPath()]) expect(p).toBe(central);
  });
});

describe("a stored chain is shown only for its own hand (hand 973)", () => {
  const store = () => new SolveStore(join(mkdtempSync(join(tmpdir(), "solves-")), "poker.sqlite"));
  const meta = (hand: string, key: string) => ({
    origin: "live", clientHandId: hand, wrapperHandId: 1, decisionKey: key, street: "river", board: "Ac7s3hKs8h",
    heroCards: "4hTc", heroPos: "BB", tier: "ai-chain", line: "x", solves: 1, solveMs: 10, ok: true, why: null,
  });

  test("row #id that IS the answer's decision is served by id", () => {
    const s = store();
    const id = s.save(meta("4920419883", "k-river"), { spec: {}, streets: [] })!;
    const got = s.forAnswer(id, "4920419883", "k-river");
    expect(got.ok && got.via).toBe("id");
  });

  test("a row number that belongs to ANOTHER hand is never shown; the chain is found by hand + decision key", () => {
    const s = store();
    const other = s.save(meta("9000057", "k-flop"), { who: "other" })!;          // what #72 was in the main store
    const mine = s.save(meta("4920419883", "k-river"), { who: "mine" })!;
    const got = s.forAnswer(other, "4920419883", "k-river");
    expect(got.ok).toBe(true);
    if (got.ok) { expect(got.via).toBe("key"); expect(got.row.id).toBe(mine); expect(got.trace.who).toBe("mine"); }
  });

  test("when this data root has no chain for the hand, the answer says whose row the number is", () => {
    const s = store();
    const other = s.save(meta("9000057", "k-flop"), {})!;
    const got = s.forAnswer(other, "4920419883", "k-river");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("belongs to hand 9000057");
  });
});

describe("the answer's trace header", () => {
  test("text a header cannot carry (—, ≈, suits) is escaped, and parses back to the same value", () => {
    const v = { totalMs: 14154, trace: [{ ev: "chain summary", info: "TURN tree CREATED in 745 ms — first TURN tree · ≈ 4♠ T♥" }] };
    const h = headerJson(v);
    const r = new Response("x");
    expect(() => r.headers.set("X-Answer-Trace", h)).not.toThrow();
    expect(JSON.parse(r.headers.get("X-Answer-Trace")!)).toEqual(v);
  });
});

describe("the hands table: live rows and finished rows", () => {
  test("ensureHandsSchema brings an old hands.db up to date and backfills client_hand_id from the JSON", () => {
    const f = join(mkdtempSync(join(tmpdir(), "hands-")), "hands.db");
    const old = new Database(f);
    old.run(`CREATE TABLE hands (rowid INTEGER PRIMARY KEY AUTOINCREMENT, hand_id INTEGER, played_at INTEGER, stakes TEXT, street TEXT,
      result_text TEXT, result_amount REAL, hero_cards TEXT, action_count INTEGER, data TEXT NOT NULL)`);
    old.run(`INSERT INTO hands (rowid, hand_id, data) VALUES (973, 24, '{"clientHandId": "4920419883", "actions": []}')`);
    ensureHandsSchema(old);
    expect(old.query("SELECT rowid, client_hand_id, status FROM hands").get()).toEqual({ rowid: 973, client_hand_id: "4920419883", status: "done" });
    ensureHandsSchema(old);   // idempotent
    old.close();
  });
});
