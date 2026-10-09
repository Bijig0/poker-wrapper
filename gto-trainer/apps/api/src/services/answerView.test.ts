import { describe, expect, it } from "bun:test";
import { AnswerView } from "./answerView";
import { pathCodesOf } from "./answerPathCodes";
import type { LoggedAnswer } from "./answerLog";

const DAY = 86_400_000;
const row = (id: number, ts: number, extra: Partial<LoggedAnswer> = {}): LoggedAnswer =>
  ({ id, ts, text: "Call 100%", path: null, client_hand_id: `h${id}`, warning: null, ...extra }) as LoggedAnswer;

// the pure half of the incremental answer log (2026-10-09, catalogue-incremental): append, replace, age eviction, windows
describe("AnswerView", () => {
  it("appends in (ts, id) order; an out-of-order row is inserted in place", () => {
    const now = 100 * DAY;
    const v = new AnswerView(30 * DAY);
    v.upsert(row(1, now - 3_000), undefined, now);
    v.upsert(row(2, now - 1_000), undefined, now);
    v.upsert(row(3, now - 2_000), undefined, now);   // another process's row, a little late
    v.upsert(row(4, now - 1_000), undefined, now);   // same ts: id breaks the tie
    expect(v.window(0).map((r) => r.id)).toEqual([1, 3, 2, 4]);
    expect(v.size).toBe(4);
    expect(v.maxId).toBe(4);
  });

  it("replaces a row by id (attach), in place or moved when its ts changed", () => {
    const now = 100 * DAY;
    const v = new AnswerView(30 * DAY);
    for (let i = 1; i <= 3; i++) v.upsert(row(i, now - (10 - i) * 1_000), undefined, now);
    v.upsert(row(2, now - 8_000, { client_hand_id: "attached" }), undefined, now);
    expect(v.window(0).map((r) => r.client_hand_id)).toEqual(["h1", "attached", "h3"]);
    v.upsert(row(1, now - 1_000), undefined, now);
    expect(v.window(0).map((r) => r.id)).toEqual([2, 3, 1]);
    expect(v.size).toBe(3);
  });

  it("windows are fresh arrays over the shared rows, from the asked ts", () => {
    const now = 100 * DAY;
    const v = new AnswerView(30 * DAY);
    for (let i = 1; i <= 5; i++) v.upsert(row(i, now - i * DAY), undefined, now);
    const w = v.window(now - 2.5 * DAY);
    expect(w.map((r) => r.id)).toEqual([2, 1]);
    w.length = 0;
    expect(v.window(now - 2.5 * DAY).length).toBe(2);
    expect(v.window(now - 2.5 * DAY)[0]).toBe(v.get(2)!);
  });

  it("age eviction drops old rows and marks from when the view is complete", () => {
    let now = 100 * DAY;
    const v = new AnswerView(10 * DAY);
    for (let i = 0; i < 20; i++) v.upsert(row(i + 1, now - i * DAY / 2), undefined, now);   // 0 … 9.5 days old
    expect(v.covers(now - 3650 * DAY)).toBe(true);     // nothing evicted yet: it holds the whole table
    now += 5 * DAY;
    expect(v.evict(now)).toBe(9);                        // the ones now older than 10 days (exactly 10 stays)
    expect(v.size).toBe(11);
    expect(v.covers(now - 10 * DAY)).toBe(true);
    expect(v.covers(now - 11 * DAY)).toBe(false);        // further back: the caller reads SQL
    expect(v.has(20)).toBe(false);
    v.upsert(row(99, now - 11 * DAY), undefined, now);   // a late row already past the bound is not kept
    expect(v.has(99)).toBe(false);
  });

  it("keeps each row's chain-path codes, computed once", () => {
    const now = 100 * DAY;
    const v = new AnswerView(30 * DAY);
    const path = JSON.stringify({ reasons: [{ code: "A" }, { code: "B" }, { code: "A" }], arrival: { code: "C", first: { code: "D" } } });
    v.upsert(row(1, now - 1, { path }), undefined, now);
    v.upsert(row(2, now, { path, text: null }), undefined, now);   // a failure carries none
    v.upsert(row(3, now, { path: "{not json" }), undefined, now);
    expect(v.codesOf(v.get(1)!).sort()).toEqual(["A", "B", "C", "D"]);
    expect(v.codesOf(v.get(2)!)).toEqual([]);
    expect(v.codesOf(v.get(3)!)).toEqual([]);
    v.upsert(row(4, now, { path }), ["given"], now);                  // the seed's worker computed them already
    expect(v.codesOf(v.get(4)!)).toEqual(["given"]);
  });

  it("pathCodesOf reads an object-valued reasons map like json_each does", () => {
    expect(pathCodesOf({ text: "x", path: JSON.stringify({ reasons: { a: { code: "X" }, b: { code: 7 } } }) }).sort()).toEqual(["7", "X"]);
  });
});
