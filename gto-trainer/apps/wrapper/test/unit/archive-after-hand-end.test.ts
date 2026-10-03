/**
 * THE STORED HAND IS THE WHOLE HAND (2026-10-03, the reader audit). The archive's ended-hand grace used to fire on
 * "hero is out" — 8 s after hero's fold — and the one-write-per-hand guard then turned away the complete record when
 * the hand really ended: 644 of 1,434 stored hands were a correct line cut short (no board, no later action), shown on
 * the dashboard as the whole hand and filed by the hand-history check as mismatches. The reader had the rest.
 *
 * Hand 4922084061 (2026-10-02, NL5): hero is under the gun and folds first; the hand runs 47 more seconds — a raise,
 * a call, a fold, a call, three streets checked through, a showdown. Replayed from its own DOM captures and WS frames
 * (test/fixtures/ign-hero-folds-early.jsonl.gz; wallet / seat-name frames and the balance stripped) through the live
 * reader. The stored row used to end at "hero folds, seat 3 folds, seat 4 raises".
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { DATA_DIR, reloadConfig } from "../../src/config";
import { resetState, seams } from "../../src/state";
import * as TABLES from "../../src/tables";
import { archiveHand } from "../../src/archive";
import { tableJs, watchJs } from "../../src/ignition/dom";
import { feedTick, maybeFlushEnded } from "../../src/ignition/reader";
import { tapFrame } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "ign-hero-folds-early.jsonl.gz");
const TARGET = { id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.uno/static/poker-game/replay", title: "replay", type: "page" };
const HAND = "4922084061";

/** the hand as Ignition's own history has it */
const WHOLE = [
  ["preflop", 6, "post-sb", 0.4], ["preflop", 1, "post-bb", 1],
  ["preflop", 2, "fold", null], ["preflop", 3, "fold", null], ["preflop", 4, "raise", 3], ["preflop", 5, "call", 3],
  ["preflop", 6, "fold", null], ["preflop", 1, "call", 2],
  ["flop", 1, "check", null], ["flop", 4, "check", null], ["flop", 5, "check", null],
  ["turn", 1, "check", null], ["turn", 4, "check", null], ["turn", 5, "check", null],
  ["river", 1, "check", null], ["river", 4, "check", null], ["river", 5, "check", null],
];

const line = (row: any) => (row.actions || []).map((a: any) => [a.street, a.seatId, a.type, a.amount ?? null]);

function rowsNow(): { data: any; status: string }[] {
  const dbp = join(DATA_DIR(), "hands.db");
  if (!existsSync(dbp)) return [];
  const c = new Database(dbp);
  try {
    return (c.query("SELECT data, status FROM hands ORDER BY rowid").all() as any[]).map((r) => ({ data: JSON.parse(r.data), status: r.status }));
  } finally {
    c.close();
  }
}

test("a hand hero folds early is stored whole, at the table's end of hand — not 8 s after his fold", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const io0 = { ...cdp.io };
  const seams0 = { ...seams };
  const log0 = console.log;
  try {
    scratchDirs("wrapper-archive-end-");
    reloadConfig();
    resetState();
    const recs: any[] = new TextDecoder().decode(Bun.gunzipSync(readFileSync(FIXTURE))).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const cur: { d: any; events: any[] } = { d: {}, events: [] };
    cdp.io.available = async () => true;
    cdp.io.pageTargets = async () => [{ ...TARGET }];
    cdp.io.evaluate = async (_ws: string, expr: string) => {
      if (expr === tableJs(TABLES.domSlot())) return structuredClone(cur.d);
      if (expr === watchJs(TABLES.domSlot())) {
        const ev = cur.events;
        cur.events = [];
        return ev;
      }
      return null;
    };
    seams.ignitionTarget = async () => ({ ...TARGET });
    const archivedAt: number[] = [];
    console.log = (m: unknown) => { if (String(m).startsWith("[history] archived hand")) archivedAt.push(time()); };

    const heroFold = recs.find((r) => r.kind === "ws" && r.d.pid === "CO_SELECT_INFO" && r.d.seat === 2 && r.d.btn === 1024)!.ts;
    const handEnd = recs.find((r) => r.kind === "ws" && r.d.pid === "PLAY_STAGE_END_REQ")!.ts;
    check("the fixture: the hand plays on long after hero's fold", handEnd - heroFold > 40, `${(handEnd - heroFold).toFixed(1)} s`);

    let doneMidHand = false;
    setFakeTime(recs[0].ts);
    for (const r of recs) {
      setFakeTime(Math.max(time(), r.ts));
      if (r.kind === "dom") {
        cur.d = r.d;
        cur.events = [...(r.events || [])];
        await feedTick();
        maybeFlushEnded();
        // 20 s after hero's fold and well before the showdown: the old grace had finished the row by now
        if (r.ts > heroFold + 20 && r.ts < handEnd - 5 && rowsNow().some((x) => x.status === "done")) doneMidHand = true;
      } else {
        tapFrame(r.d, null);
      }
    }
    // no next hand in the fixture beyond its first frame: the grace finishes a hand the table has ended
    setFakeTime(time() + 9);
    maybeFlushEnded();
    setFakeTime(time() + 9);
    maybeFlushEnded();
    archiveHand();

    check("nothing was finished while the others were still playing", !doneMidHand);
    const rows = rowsNow().filter((x) => x.data.clientHandId === HAND);
    eq("one stored row for the hand", rows.length, 1);
    const row = rows[0]?.data;
    if (row) {
      eq("it is finished", rows[0]!.status, "done");
      eq("the stored line is the whole hand, as Ignition's history has it", line(row), WHOLE);
      eq("the board is all five cards", (row.board || []).length, 5);
      eq("the line's source", row.lineSource, "ws");
    }
    eq("archived once", archivedAt.length, 1);
    check("…at or after the table's end of hand", archivedAt.length === 1 && archivedAt[0]! >= handEnd, `archived at +${((archivedAt[0] ?? 0) - heroFold).toFixed(1)} s after hero's fold; the hand ended at +${(handEnd - heroFold).toFixed(1)} s`);
  } finally {
    console.log = log0;
    realTime();
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
  }
  expect(fails).toEqual([]);
});
