/**
 * THE POT WINNER NEVER FOLDS (2026-09-25). Archived Ignition hands ended with the winner "folding" after everyone
 * else had folded — 74 of 448 hands (4920545590: river, seat 4 bets, hero folds, then "Seat 4 folds"; 4920544353:
 * seat 6 ALL-IN on the turn, hero folds, then "Seat 6 folds"). The WebSocket never sent it: at the pot award the
 * winner's cards leave the table (CO_SHOW_INFO — does not show) while hero's folded cards stay on screen, so the
 * hand-end wipe does not fire and the DOM backfill read the cards going as a fold. The level reconciler filed the same
 * fold off the same pixels (4920544156), where the cut-over could swap it into /hand.
 *
 * The two hands are replayed from their own frames — test/fixtures/ign-pot-winner-folds.jsonl.gz, session
 * 20260925_135420's DOM captures and WS frames (wallet / seat-name frames and the lobby balance stripped) — through the
 * live reader, and the reconciler over ticks shaped like 4920544156.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { DATA_DIR, reloadConfig } from "../../src/config";
import { HandReconciler, makeTick } from "../../src/reconcile";
import { S, resetState, seams } from "../../src/state";
import * as TABLES from "../../src/tables";
import { archiveHand } from "../../src/archive";
import { tableJs, watchJs } from "../../src/ignition/dom";
import { feedTick, maybeFlushEnded } from "../../src/ignition/reader";
import { lastStanding, tapFrame } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "ign-pot-winner-folds.jsonl.gz");
const TARGET = { id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.uno/static/poker-game/replay", title: "replay", type: "page" };

function fixture(): Map<string, any[]> {
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(FIXTURE)));
  const groups = new Map<string, any[]>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (!groups.has(r.grp)) groups.set(r.grp, []);
    groups.get(r.grp)!.push(r);
  }
  return groups;
}

/** One hand's frames through the live loop's reader, in time order; returns the archived rows and the reader log. */
async function replay(recs: any[]): Promise<{ rows: any[]; shadow: any[]; logs: string[] }> {
  resetState();
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
  const logs: string[] = [];
  const log0 = console.log;
  console.log = (m: unknown) => { logs.push(String(m)); };
  try {
    setFakeTime(recs[0].ts);
    for (const r of recs) {
      setFakeTime(Math.max(time(), r.ts));
      if (r.kind === "dom") {
        cur.d = r.d;
        cur.events = [...(r.events || [])];
        await feedTick();
        maybeFlushEnded();
      } else {
        tapFrame(r.d, null);
      }
    }
    archiveHand();
  } finally {
    console.log = log0;
    realTime();
  }
  const dbp = join(DATA_DIR(), "hands.db");
  const rows: any[] = [];
  if (existsSync(dbp)) {
    const c = new Database(dbp);
    try {
      for (const row of c.query("SELECT data FROM hands ORDER BY rowid").all() as any[]) rows.push(JSON.parse(row.data));
    } finally {
      c.close();
    }
  }
  const sp = join(DATA_DIR(), "shadow.jsonl");
  const shadow = existsSync(sp) ? readFileSync(sp, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
  return { rows, shadow, logs };
}

const line = (row: any) => (row.actions || []).map((a: any) => [a.street, a.seatId, a.type, a.amount ?? null]);

/** Each hand as the table dealt it, the winner's award no longer read as a fold — every real fold kept. */
const HANDS: { id: string; winner: number; want: any[] }[] = [
  {
    id: "4920545590", winner: 4,
    want: [["preflop", 3, "post-sb", 0.4], ["preflop", 4, "post-bb", 1], ["preflop", 5, "raise", 2.6], ["preflop", 6, "fold", null],
           ["preflop", 2, "fold", null], ["preflop", 3, "call", 2.2], ["preflop", 4, "raise", 10.4], ["preflop", 5, "call", 7.8],
           ["preflop", 3, "fold", null], ["flop", 4, "check", null], ["flop", 5, "check", null], ["turn", 4, "check", null],
           ["turn", 5, "check", null], ["river", 4, "bet", 1], ["river", 5, "fold", null]],
  },
  {
    id: "4920544353", winner: 6,
    want: [["preflop", 1, "post-sb", 0.4], ["preflop", 2, "post-bb", 1], ["preflop", 3, "fold", null], ["preflop", 4, "fold", null],
           ["preflop", 5, "raise", 2.6], ["preflop", 6, "call", 2.6], ["preflop", 1, "call", 2.2], ["preflop", 2, "call", 1.6],
           ["flop", 1, "check", null], ["flop", 2, "bet", 1], ["flop", 5, "call", 1], ["flop", 6, "raise", 10],
           ["flop", 1, "fold", null], ["flop", 2, "fold", null], ["flop", 5, "call", 9], ["turn", 5, "check", null],
           ["turn", 6, "all-in", 21.6], ["turn", 5, "fold", null]],
  },
];

test("the pot winner's cards leaving at the award is not a fold (4920545590, 4920544353 replayed)", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const io0 = { ...cdp.io };
  const seams0 = { ...seams };
  try {
    const groups = fixture();
    for (const { id, winner, want } of HANDS) {
      scratchDirs("wrapper-pot-winner-");
      reloadConfig();
      const { rows, shadow, logs } = await replay(groups.get(id)!);
      const row = rows.find((r) => r.clientHandId === id);
      check(`${id}: archived`, !!row, J(rows.map((r) => r.clientHandId)));
      if (!row) continue;
      eq(`${id}: the result names seat ${winner} the winner`, row.result?.winnerSeat, winner);
      eq(`${id}: the archived line, every real fold kept and no fold by the winner`, line(row), want);
      eq(`${id}: the event line's source`, row.lineSource, "ws");
      check(`${id}: no "Seat ${winner} folds" in the hand's feed`, !(row.feedLines || []).includes(`Seat ${winner} folds`), J(row.feedLines));
      check(`${id}: the reader says why it filed nothing`,
            logs.some((l) => l.startsWith(`[reader] seat ${winner}'s cards left at the pot award`)), J(logs.filter((l) => l.startsWith("[reader]"))));
      const audit = shadow.find((s) => s.clientHandId === id);
      check(`${id}: the reconciler's line has no fold by the winner either`,
            !!audit && !audit.line.some((a: any[]) => a[1] === winner && a[2] === "fold"), J(audit?.line));
    }
  } finally {
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
  }
  expect(fails).toEqual([]);
});

test("the last seat standing is judged off the table's own deal only", () => {
  const { fails, check } = checker();
  resetState();
  Object.assign(S.ws, { dealt: [2, 4, 5], foldedSeats: new Set([2, 5]) });
  check("everyone else folded: seat 4 won", lastStanding(4) === true);
  check("a folded seat is not the one standing", lastStanding(2) === false);
  S.ws.foldedSeats = new Set([2]);
  check("two seats still in: nobody has won yet", lastStanding(4) === false && lastStanding(5) === false);
  // no deal frame (the tap not bound yet): the fold set may still hold a previous hand's folds — never judged
  Object.assign(S.ws, { dealt: [], foldedSeats: new Set([1, 2, 4]), heldCards: new Set([1, 2, 4, 5]) });
  check("without CO_CARDTABLE_INFO nothing is the last seat standing", lastStanding(5) === false);
  Object.assign(S.ws, { dealt: [3, 6], foldedSeats: new Set([6]) });
  check("a seat the table did not deal in is never it", lastStanding(1) === false);
  expect(fails).toEqual([]);
});

// ---- the reconciler: hand 4920544156's shape — no small blind read, BB hero folds to a raise, the raiser wins
const seat = (bet: string | null, cards: number, hero: boolean) => ({ stack: "100 BB", bet, cards, hero, badge: null });
function tick(seq: number, bets: Record<number, string>, pot: number | null, cards: Record<number, number>, buttons: string[] = []) {
  const seats = new Map<number, any>();
  for (const n of [1, 2, 4, 5]) seats.set(n, seat(bets[n] ?? null, cards[n] ?? 2, n === 4));
  return makeTick({ seq, t: "", seats, pot, board: 0, buttons, hero: 4 });
}

test("the reconciler files no fold for the last seat standing — and still files every real one", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const rc = new HandReconciler(1);
  let q = 0;
  const ob = (bets: Record<number, string>, pot: number | null, cards: Record<number, number> = {}, buttons: string[] = []) =>
    rc.observe(tick(++q, bets, pot, cards, buttons));
  ob({}, null);
  ob({ 4: "1 BB" }, 1.0);                                       // the big blind; the small blind is dead / never read
  ob({ 4: "1 BB" }, 1.0, { 5: 0 }); ob({ 4: "1 BB" }, 1.0, { 5: 0 });                   // seat 5 folds (cards gone)
  ob({ 4: "1 BB" }, 1.0, { 5: 0, 1: 0 }); ob({ 4: "1 BB" }, 1.0, { 5: 0, 1: 0 });       // seat 1 folds
  ob({ 2: "2.5 BB", 4: "1 BB" }, 3.5, { 5: 0, 1: 0 });                                   // seat 2 raises
  ob({ 2: "2.5 BB", 4: "1 BB" }, 3.5, { 5: 0, 1: 0 }, ["FOLD", "CALL 1.5 BB", "RAISE TO 4 BB"]);
  for (let n = 0; n < 4; n++) ob({ 2: "2.5 BB", 4: "1 BB" }, 3.5, { 5: 0, 1: 0 });      // hero folds (buttons gone)
  const before = rc.line().map((a) => [a.seat, a.type]);
  eq("real folds are filed while two seats are in", before.filter(([, t]) => t === "fold"), [[5, "fold"], [1, "fold"], [4, "fold"]]);
  // the award: the raiser's cards leave the table (hero's folded cards stay up)
  for (let n = 0; n < 4; n++) ob({ 2: "2.5 BB", 4: "1 BB" }, 3.5, { 5: 0, 1: 0, 2: 0 });
  const after = rc.line().map((a) => [a.seat, a.type]);
  check("no fold is filed for the raiser who won", !after.some(([s, t]) => s === 2 && t === "fold"), J(after));
  eq("  and nothing else changed", after, before);
  expect(fails).toEqual([]);
});
