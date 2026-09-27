/**
 * THE RABBIT HUNT IS NOT A STREET (2026-09-25, hand 4920544353). The hand ended on the TURN (seat 6 all-in, hero
 * folded); after the pot award Ignition sent CO_RABBITCARD_INFO {pos: 5, card: 11} — the river that would have come —
 * and the client drew Q♣ in the board's river slot. The WebSocket reader ignored the frame, but the export's DOM-board
 * override (there for a board frame the tap lost) took the screen's five cards: archived with board 6♠ 8♥ K♠ Q♥ Q♣ and
 * street "river". The level reconciler read the same card as a new street and revived the hand ("the board grew to 5
 * cards"), retracting hero's fold and filing hero checking the turn and the river.
 *
 * Replayed from the hand's own frames (test/fixtures/ign-pot-winner-folds.jsonl.gz, session 20260925_135420) through
 * the live reader — and once more with the TURN's board frame dropped. Until 2026-09-26 the screen's turn was taken into
 * the line there; since the line is the protocol's (ignition/wsLine.ts), a card only the screen shows HOLDS the
 * decision as uncertain instead, and the rabbit card after it still counts for nothing.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { DATA_DIR, reloadConfig } from "../../src/config";
import { S, resetState, seams } from "../../src/state";
import * as TABLES from "../../src/tables";
import { archiveHand } from "../../src/archive";
import { tableJs, watchJs } from "../../src/ignition/dom";
import { handState } from "../../src/ignition/hand";
import { feedTick, maybeFlushEnded } from "../../src/ignition/reader";
import { beginHand, onGameMsg, tapFrame, withoutRabbit } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "ign-pot-winner-folds.jsonl.gz");
const TARGET = { id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.uno/static/poker-game/replay", title: "replay", type: "page" };
const HAND = "4920544353";
const TURN_BOARD = ["6♠", "8♥", "K♠", "Q♥"];

function handFrames(): any[] {
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(FIXTURE)));
  return text.split("\n").filter((l) => l).map((l) => JSON.parse(l)).filter((r) => r.grp === HAND);
}

type Export = { ts: number; kind: string; pid: string | null; board: string[]; street: string; uncertain: string | null };

/** The hand through the live loop's reader, in time order: every /hand export of this hand along the way, the
 *  archived rows, the shadow audit, and the rabbit card the WS reader kept. */
async function replay(recs: any[]) {
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
  const exports: Export[] = [];
  let rabbitSeen: unknown = null;
  const log0 = console.log;
  console.log = () => {};
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
      if (S.ws.rabbit) rabbitSeen = Object.fromEntries(S.ws.rabbit);
      const h = handState();
      if (h && h.clientHandId === HAND) exports.push({ ts: r.ts, kind: r.kind, pid: r.kind === "ws" ? r.d.pid : null, board: h.board, street: h.street, uncertain: h.lineUncertain ?? null });
    }
    archiveHand();
  } finally {
    console.log = log0;
    realTime();
  }
  const rows: any[] = [];
  const dbp = join(DATA_DIR(), "hands.db");
  if (existsSync(dbp)) {
    const c = new Database(dbp);
    try {
      for (const row of c.query("SELECT street, data FROM hands ORDER BY rowid").all() as any[]) rows.push({ column: row.street, ...JSON.parse(row.data) });
    } finally {
      c.close();
    }
  }
  const sp = join(DATA_DIR(), "shadow.jsonl");
  const shadow = existsSync(sp) ? readFileSync(sp, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
  return { exports, rows, audit: shadow.find((s) => s.clientHandId === HAND), rabbitSeen };
}

async function withReplay(recs: any[], body: (r: Awaited<ReturnType<typeof replay>>) => void) {
  const io0 = { ...cdp.io };
  const seams0 = { ...seams };
  try {
    scratchDirs("wrapper-rabbit-");
    reloadConfig();
    body(await replay(recs));
  } finally {
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
  }
}

test("the rabbit hunt's card neither extends the board nor opens a street (4920544353 replayed)", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const recs = handFrames();
  const rabbitAt = recs.find((r) => r.kind === "ws" && r.d.pid === "CO_RABBITCARD_INFO")?.ts;
  const domRabbit = recs.find((r) => r.kind === "dom" && (r.d.allCards || []).some((c: any) => c.tbl && c.seat == null && c.qa === "card11"))?.ts;
  check("the fixture holds the rabbit frame and a DOM board showing its card after it", rabbitAt && domRabbit && domRabbit > rabbitAt, J({ rabbitAt, domRabbit }));
  await withReplay(recs, ({ exports, rows, audit, rabbitSeen }) => {
    eq("the WS reader kept the rabbit card by position", rabbitSeen, { 5: "Q♣" });
    const row = rows.find((r) => r.clientHandId === HAND);
    check("archived", !!row, J(rows.map((r) => r.clientHandId)));
    if (row) {
      eq("the archived board is the turn's", row.board, TURN_BOARD);
      eq("the archived street is the turn", row.street, "turn");
      eq("  and so is the row's street column", row.column, "turn");
    }
    const shown = exports.filter((e) => e.kind === "dom" && domRabbit && e.ts >= domRabbit);
    check("/hand was read while the rabbit card was on the DOM board", shown.length > 0);
    eq("/hand never showed a river for this hand", exports.filter((e) => e.street === "river" || e.board.length > 4).map((e) => e.ts), []);
    eq("/hand while the rabbit card is on screen", [...new Set(shown.map((e) => J([e.board, e.street])))], [J([TURN_BOARD, "turn"])]);
    check("the shadow audit ran", !!audit);
    if (audit) {
      eq("the reconciler's line never reaches the river", audit.line.filter((a: any[]) => a[0] === "river"), []);
      eq("  and ends on hero's turn fold, as the table's line does", audit.line.slice(-2), [["turn", 6, "all-in", 21.6], ["turn", 5, "fold", null]]);
      eq("  hero's fold was not retracted by a revival", audit.retractions, []);
      check("  it agrees with the archived line", audit.agree === true, J(audit));
    }
  });
  expect(fails).toEqual([]);
});

test("a board frame the tap lost: the screen's turn holds the decision, it is never written into the line", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  // the turn's CO_BCARD1_INFO dropped: the WS board stops at the flop, the DOM shows Q♥ (then the rabbit's Q♣)
  const recs = handFrames().filter((r) => !(r.kind === "ws" && r.d.pid === "CO_BCARD1_INFO" && r.d.pos === 4));
  check("the variant really lacks the turn frame", !recs.some((r) => r.kind === "ws" && r.d.pid === "CO_BCARD1_INFO"));
  const endAt = recs.find((r) => r.kind === "ws" && r.d.pid === "CO_RESULT_INFO")?.ts ?? 0;
  await withReplay(recs, ({ exports, rows }) => {
    eq("/hand never took a board card no frame dealt", exports.filter((e) => e.board.length > 3).map((e) => e.ts), []);
    check("/hand said why while the screen showed the turn", exports.some((e) => e.ts < endAt
      && e.uncertain === "line uncertain — the screen shows 4 board cards, the protocol has dealt 3"),
      J(exports.map((e) => [e.ts, e.uncertain])));
    const row = rows.find((r) => r.clientHandId === HAND);
    check("archived", !!row);
    if (row) eq("the archived board is what the protocol dealt", row.board, TURN_BOARD.slice(0, 3));
  });
  expect(fails).toEqual([]);
});

test("the rabbit card is kept by position for the hand, and a new hand forgets it", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const five = ["2♣", "3♦", "4♥", "5♠", "6♣"];
  resetState();
  beginHand("1");
  eq("no rabbit: the whole board", withoutRabbit(five), five);
  onGameMsg({ pid: "CO_RABBITCARD_INFO", pos: 0, card: 11 });
  onGameMsg({ pid: "CO_RABBITCARD_INFO", pos: 5 });
  check("a frame without a board position or a card is ignored", S.ws.rabbit === undefined, J(S.ws.rabbit));
  onGameMsg({ pid: "CO_RABBITCARD_INFO", pos: 5, card: 11 });
  eq("a river rabbit: the turn's four cards", withoutRabbit(five), five.slice(0, 4));
  eq("  a shorter board is left as it is", withoutRabbit(five.slice(0, 3)), five.slice(0, 3));
  onGameMsg({ pid: "CO_RABBITCARD_INFO", pos: 4, card: 37 });
  eq("a turn rabbit cuts at the turn, whatever else was named", withoutRabbit(five), five.slice(0, 3));
  eq("the frames are kept as the table named them", S.ws.rabbit, { 5: "Q♣", 4: "Q♥" });
  eq("the WS board itself never takes a rabbit card", S.ws.board, []);
  beginHand("2");
  check("a new hand has no rabbit card", S.ws.rabbit === undefined, J(S.ws.rabbit));
  eq("  and the whole board again", withoutRabbit(five), five);
  expect(fails).toEqual([]);
});

test("a rabbit card the hand's own board contradicts is another table's — never taken, or taken back", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const five = ["5♣", "Q♦", "J♥", "T♦", "9♣"];
  const flop = { pid: "CO_BCARD3_INFO", bcard: [4, 24, 36] };            // 5♣ Q♦ J♥
  resetState();
  // recording 20260920_131406 (two tables' frames on one stream): another table's rabbit at pos 4, then OUR turn frame
  beginHand("4919432519");
  onGameMsg(flop);
  onGameMsg({ pid: "CO_RABBITCARD_INFO", pos: 4, card: 8 });
  eq("a rabbit past the flop is taken while nothing says otherwise", withoutRabbit(five), five.slice(0, 3));
  onGameMsg({ pid: "CO_BCARD1_INFO", pos: 4, card: 22 });
  check("the hand's own turn frame takes the pos-4 rabbit back", S.ws.rabbit === undefined, J(S.ws.rabbit));
  eq("  the DOM's turn counts again", withoutRabbit(five), five);
  onGameMsg({ pid: "CO_RABBITCARD_INFO", pos: 4, card: 8 });
  check("a rabbit at a position the hand already dealt is not taken", S.ws.rabbit === undefined, J(S.ws.rabbit));
  onGameMsg({ pid: "CO_RABBITCARD_INFO", pos: 5, card: 9 });
  eq("a river rabbit after that turn is", S.ws.rabbit, { 5: "10♣" });
  eq("  cutting only the river", withoutRabbit(five), five.slice(0, 4));
  onGameMsg({ pid: "CO_BCARD1_INFO", pos: 5, card: 7 });
  check("and a river frame takes that one back", S.ws.rabbit === undefined, J(S.ws.rabbit));
  expect(fails).toEqual([]);
});
