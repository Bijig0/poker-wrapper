import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AnswerLog } from "./answerLog";

const dir = mkdtempSync(join(tmpdir(), "answer-rows-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the WAL */ } });

const row = (hand: string | null, text: string | null = "Call 100%") => ({
  ts: Date.now(), wrapperHandId: 1, clientHandId: hand, street: "flop", board: "AsKd2c", heroCards: "QhQd",
  decisionKey: `${hand}:flop:0`, text, pick: text ? "Call" : null, roll: null, tier: "gtow-ai", warning: null,
  latencyMs: 1200, failReason: text ? null : "no answer", sessionId: "session_20260926_010000",
}) as any;

describe("answerLog.rows — cached per window until something writes (2026-09-26)", () => {
  it("serves the cache between writes, and sees this connection's inserts and attaches", () => {
    const log = new AnswerLog(join(dir, "a.sqlite"));
    log.add(row("4920000001"));
    const a = log.rows(60), b = log.rows(60);
    expect(a.length).toBe(1);
    expect(b).not.toBe(a);                 // a fresh array each call…
    expect(b[0]).toBe(a[0]);               // …over the cached rows (no re-query)
    log.add(row(null, null));           // a probe failure: no hand id yet
    const c = log.rows(60);
    expect(c.length).toBe(2);
    log.attach(c[1]!.id, "4920000002", null, 7);
    expect(log.rows(60)[1]!.client_hand_id).toBe("4920000002");
  });

  it("sees another connection's insert (max id moves)", () => {
    const path = join(dir, "b.sqlite");
    const log = new AnswerLog(path);
    log.add(row("4920000003"));
    expect(log.rows(60).length).toBe(1);
    const other = new Database(path);
    other.run("INSERT INTO answers (ts, client_hand_id, text) VALUES (?, ?, ?)", [Date.now(), "4920000004", "Fold 100%"]);
    other.close();
    expect(log.rows(60).map((r) => r.client_hand_id)).toEqual(["4920000003", "4920000004"]);
  });

  it("a caller changing its array leaves the cache alone; windows are cached apart", () => {
    const log = new AnswerLog(join(dir, "c.sqlite"));
    log.add(row("4920000005"));
    log.rows(60).length = 0;
    expect(log.rows(60).length).toBe(1);
    expect(log.rows(3650).length).toBe(1);
  });

  it("a fresh table gets the session index (created after the column migration)", () => {
    const path = join(dir, "d.sqlite");
    const log = new AnswerLog(path);
    log.add(row("4920000006"));
    const db = new Database(path, { readonly: true });
    const names = db.query<{ name: string }, []>("PRAGMA index_list(answers)").all().map((r) => r.name);
    db.close();
    expect(names).toContain("idx_answers_session");
  });
});
