/**
 * THE RE-SCORE OF THE STORED CHECKS (scripts/rescoreChecks, 2026-10-03, audit finding 5) on real rows copied from
 * poker.sqlite (fixtures/rescoreChecks.fixture.json): #4 at a ring table, #12's median half, the three #14 hands —
 * and everything else left byte-for-byte. The database side runs on a scratch file in the temp dir, never the live one.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rescoreRow, runRescore, type AnswerRow, type HandCtx } from "./rescoreChecks";
import { classifyPath, type DecisionPath } from "../services/chainPath";

const FX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "rescoreChecks.fixture.json"), "utf8")) as {
  rows: AnswerRow[]; hands: Record<string, string>; facts: Record<string, string>;
};
const row = (id: number) => FX.rows.find((r) => r.id === id)!;
const statusOf = (path: string | null, street: string, id: number) =>
  (JSON.parse(path!) as DecisionPath).checks![street as "flop"]!.find((c) => c.id === id)?.status;

/** a scratch poker.sqlite holding the fixture rows */
let dirs: string[] = [];
let dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs) d.close();                      // Windows: an open file cannot be removed
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = []; dbs = [];
});
function scratch(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rescore-checks-"));
  dirs.push(dir);
  const db = new Database(join(dir, "poker.sqlite"));
  dbs.push(db);
  db.run("CREATE TABLE answers (id INTEGER PRIMARY KEY, client_hand_id TEXT, table_seats INTEGER, decision_key TEXT, decision_json TEXT, path_verdict TEXT, path TEXT)");
  db.run("CREATE TABLE hands (client_hand_id TEXT, data TEXT)");
  db.run("CREATE TABLE hand_facts (hand_key TEXT PRIMARY KEY, doc TEXT)");
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER)");
  const ins = db.query("INSERT INTO answers VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const r of FX.rows) ins.run(r.id, r.client_hand_id, r.table_seats, r.decision_key, r.decision_json, r.path_verdict, r.path);
  for (const [k, v] of Object.entries(FX.hands)) db.query("INSERT INTO hands VALUES (?, ?)").run(k, v);
  for (const [k, v] of Object.entries(FX.facts)) db.query("INSERT INTO hand_facts VALUES (?, ?)").run(k, v);
  return { db, dir };
}
const snapshot = (db: Database) => db.query("SELECT id, path_verdict, path FROM answers ORDER BY id").all() as { id: number; path_verdict: string; path: string }[];

describe("rescoreRow: only what the change redefines", () => {
  const ctx = (over: Partial<HandCtx> = {}): HandCtx => ({ dealtFromHand: null, dealtLabels: null, trees: [], ...over });
  it("#4 (hand 4921602320, five dealt, SB → BB): the old heads-up fail becomes a pass, the verdict clean", () => {
    const r = rescoreRow(row(8126), ctx({ dealtFromHand: 5 }));
    expect(r.changed).toBe(true);
    expect([row(8126).path_verdict, r.verdict]).toEqual(["failed", "clean"]);
    expect(statusOf(r.path, "flop", 4)).toBe("pass");
    expect(r.edits.map((e) => [e.street, e.id, e.from, e.to])).toEqual([["flop", 4, "fail", "pass"], ["turn", 4, "fail", "pass"]]);
    expect(r.dealtSrc).toBe("hand");
  });
  it("#4 falls back to answers.table_seats; dealt unknown leaves a blind-vs-blind order not checked (pass, said so)", () => {
    const fromSeats = rescoreRow(row(8125), ctx());
    expect([fromSeats.dealtSrc, statusOf(fromSeats.path, "flop", 4)]).toEqual(["table_seats", "pass"]);
    const unknown = rescoreRow({ ...row(8125), table_seats: null }, ctx());
    expect(unknown.dealtSrc).toBe("unknown");
    expect((JSON.parse(unknown.path!) as DecisionPath).checks!.flop!.find((c) => c.id === 4)!.text).toContain("a blind-vs-blind order is not checked");
    // dealt two: the old fail was right, and stays a fail (re-worded with the count)
    const hu = rescoreRow(row(8125), ctx({ dealtFromHand: 2 }));
    expect(statusOf(hu.path, "flop", 4)).toBe("fail");
    expect(hu.verdict).toBe("failed");
  });
  it("#12: a median-only fail becomes a flag; a fail with an action-clock part is left alone", () => {
    const r = rescoreRow(row(8273), ctx());
    expect([r.changed, r.verdict]).toEqual([true, "clean"]);
    const c12 = (JSON.parse(r.path!) as DecisionPath).checks!.flop!.find((c) => c.id === 12)!;
    expect(c12.status).toBe("flag");
    expect(c12.text).toContain("over 3× its rolling median of 0.6 s (cached trees, last 21) — a flag, never a verdict");
    const clock = rescoreRow(row(8420), ctx());
    const p = JSON.parse(clock.path!) as DecisionPath;
    const twelve = Object.values(p.checks!).flat().filter((c) => c!.id === 12 && c!.status === "fail");
    expect(twelve.length).toBeGreaterThan(0);
    expect(twelve.every((c) => /action clock/.test(c!.text))).toBe(true);
  });
  it("#14: the dead-button hands pass with the hand's dealt seats, and without them are left alone", () => {
    for (const id of [8866, 10232]) {
      const r = row(id);
      const without = rescoreRow(r, ctx());
      expect(without.changed).toBe(false);
      const labels = JSON.parse(FX.hands[r.client_hand_id!]!).positions;
      const dealtLabels = id === 8866 ? ["BB", "CO", "SB"] : ["CO", "SB", "BB"];
      expect(Object.values(labels)).toContain("BTN");            // the button seat is labelled, but sat out
      const withSeats = rescoreRow(r, ctx({ dealtLabels, dealtFromHand: 3 }));
      expect([withSeats.changed, withSeats.verdict, statusOf(withSeats.path, "preflop", 14)]).toEqual([true, "clean", "pass"]);
    }
  });
  it("#14: the QQ all-in (4921673474) is the call for less — the by-design reason stays, the verdict is by-design", () => {
    const r = rescoreRow(row(9172), ctx());
    expect([r.changed, r.verdict]).toEqual([true, "by-design"]);
    const p = JSON.parse(r.path!) as DecisionPath;
    expect(p.reasons.map((x) => x.code)).toEqual(["preflop:charts-cannot-hold"]);
    expect(p.checks!.preflop!.find((c) => c.id === 14)!.text).toContain("its all-in is the call for less (87bb behind, 98.8bb to call)");
  });
  it("rows this change does not touch come back as the same bytes; a re-scored row keeps its key order and other fields", () => {
    for (const id of [8121, 8313]) {
      const r = rescoreRow(row(id), ctx({ dealtFromHand: 6 }));
      expect(r.changed).toBe(false);
      expect(r.path).toBe(row(id).path);
    }
    const before = JSON.parse(row(8273).path!), after = JSON.parse(rescoreRow(row(8273), ctx()).path!);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after.requests).toEqual(before.requests);
    expect(after.streets).toEqual(before.streets);
    // the verdict is classifyPath's, never set by hand
    const { v: _v, verdict: _vd, reasons, ...rest } = after;
    expect(classifyPath({ ...rest, fault: reasons.find((x: any) => x.v === "fault") ?? null }).verdict).toBe(after.verdict);
  });
});

describe("runRescore on a scratch database", () => {
  const quiet = () => {};
  it("the dry run writes nothing", async () => {
    const { db } = scratch();
    const before = snapshot(db);
    const r = await runRescore({ db, dbPath: "scratch", log: quiet });
    expect(r.changed).toBeGreaterThan(0);
    expect(snapshot(db)).toEqual(before);
  });
  it("--apply backs up, writes in one go, is idempotent, and --restore puts the bytes back", async () => {
    const { db, dir } = scratch();
    const before = snapshot(db);
    const a = await runRescore({ db, dbPath: "scratch", apply: true, backupDir: dir, log: quiet });
    expect(a.applied).toBe(a.changed);
    expect(a.backup!.startsWith(dir)).toBe(true);
    const backedUp = readFileSync(a.backup!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(backedUp.length).toBe(a.changed);
    const after = snapshot(db);
    expect(after.find((x) => x.id === 8126)!.path_verdict).toBe("clean");
    expect(after.find((x) => x.id === 8121)).toEqual(before.find((x) => x.id === 8121));   // untouched: same bytes
    // a second run changes nothing
    const again = await runRescore({ db, dbPath: "scratch", apply: true, backupDir: dir, log: quiet });
    expect([again.changed, again.applied]).toEqual([0, 0]);
    expect(readdirSync(dir).filter((f) => f.startsWith("answers-path-backup-")).length).toBe(1);
    const back = await runRescore({ db, dbPath: "scratch", restore: a.backup!, log: quiet });
    expect(back.restored).toBe(a.changed);
    expect(snapshot(db)).toEqual(before);
  });
  it("refuses to write while a poker session is live (the dry run still reads)", async () => {
    const { db, dir } = scratch();
    db.run("INSERT INTO sessions VALUES ('session_live', 1, NULL)");
    const before = snapshot(db);
    const r = await runRescore({ db, dbPath: "scratch", apply: true, backupDir: dir, log: quiet });
    expect(r.refused).toContain("a poker session is live");
    expect(snapshot(db)).toEqual(before);
    expect((await runRescore({ db, dbPath: "scratch", restore: join(dir, "x.jsonl"), log: quiet })).refused).toContain("live");
    expect((await runRescore({ db, dbPath: "scratch", log: quiet })).refused).toBeUndefined();
  });
});
