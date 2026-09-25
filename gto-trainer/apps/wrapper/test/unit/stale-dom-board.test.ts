/**
 * THE SCREEN'S BOARD FILLS A LOST FRAME — IT NEVER STANDS IN FOR THE HAND'S OWN (2026-09-25). /hand takes the DOM's
 * board when it is ahead of the WebSocket's (a board frame the tap lost). On the multi-table page a slot's frame showed
 * boards that were not the hand's, and hands were archived with them:
 *  - SLOT 4, a frame STUCK on an earlier hand (sessions 20260925_044829 and _134058): 4920544731's river board
 *    T♦ A♣ A♦ 3♥ 9♦ stayed on screen for the next three hands — archived on 4920544902 (flop 5♦ 8♠ 3♣ dealt),
 *    4920545054 (turn 9♣ 5♠ 4♥ 8♣ dealt) and 4920545175, which ended PREFLOP (seat 4 folds to seat 6's raise) and was
 *    archived street "river". At hero's preflop decision in 4920545175 /hand said river.
 *  - SLOT 2, ANOTHER TABLE's frame (session 20260925_051025): 4920434476 ended preflop (everyone folds to hero's big
 *    blind) and 0.6 s later slot 2's read landed on table 4, flop 9♠ 10♠ Q♣ — archived street "flop".
 *
 * Slot 4's session has no DOM recording, so its stuck frame is modelled as the one capture it kept showing (the WS
 * frames are the table's own, test/fixtures/ign-stale-dom-board.jsonl.gz), with each hole-card state such a frame can
 * show: the stuck hand's, none, or — as 4920431916's did — the hand's own, which only the board rules can refuse. Slot
 * 2's DOM ticks and frames are the recording's own (lobby balance blanked, wallet / seat-name frames dropped).
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { DATA_DIR, reloadConfig } from "../../src/config";
import { S, resetState, seams } from "../../src/state";
import { archiveHand } from "../../src/archive";
import { mySel, tableJs, watchJs } from "../../src/ignition/dom";
import { handState } from "../../src/ignition/hand";
import { feedTick, maybeFlushEnded } from "../../src/ignition/reader";
import { beginHand, domBoardRefusal, noteDomBoard, onGameMsg, tapFrame } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "ign-stale-dom-board.jsonl.gz");
const TARGET = { id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.uno/static/poker-game/replay", title: "replay", type: "page" };

function group(grp: string): any[] {
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(FIXTURE)));
  return text.split("\n").filter((l) => l).map((l) => JSON.parse(l)).filter((r) => r.grp === grp);
}

type Export = { ts: number; hand: string | null; board: string[]; street: string; heroTurn: boolean };

/** The records through the live loop's reader, in time order: every /hand export, the archived rows, the log. */
async function replay(recs: any[], capture: (r: any) => any, env: Record<string, string> = {}) {
  const env0 = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const io0 = { ...cdp.io };
  const seams0 = { ...seams };
  const log0 = console.log;
  const exports: Export[] = [];
  const logs: string[] = [];
  try {
    Object.assign(process.env, env);
    scratchDirs("wrapper-stale-board-");
    reloadConfig();
    resetState();
    let cur: any = null;
    cdp.io.available = async () => true;
    cdp.io.pageTargets = async () => [{ ...TARGET }];
    cdp.io.evaluate = async (_ws: string, expr: string) => {
      // the reader asks for its PINNED frame (mySel) once the first read has pinned it — a stub keyed on the slot
      // number answered none of slot 2's 31 reads: each came back null, which the reader took as "not seated" before
      // 2026-09-26, so the replay below never showed it the other table's flop it is here to refuse
      if (expr === tableJs(mySel())) return structuredClone(capture(cur));
      if (expr === watchJs(mySel())) return [];
      return null;
    };
    seams.ignitionTarget = async () => ({ ...TARGET });
    console.log = (m: unknown) => { logs.push(String(m)); };
    setFakeTime(recs[0].ts);
    for (const r of recs) {
      setFakeTime(Math.max(time(), r.ts));
      if (r.kind === "dom") {
        cur = r;
        await feedTick();
        maybeFlushEnded();
      } else {
        tapFrame(r.d, null);
      }
      const h = handState();
      if (h) exports.push({ ts: r.ts, hand: h.clientHandId, board: h.board, street: h.street, heroTurn: !!h.currentNode?.toActIsHero });
    }
    archiveHand();
  } finally {
    console.log = log0;
    realTime();
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
    for (const [k, v] of Object.entries(env0)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    reloadConfig();
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
  return { exports, rows, logs };
}

// ---- slot 4: the frame stuck on 4920544731's river ---------------------------------------------------------------
const STUCK = [22, 0, 13, 28, 21];                  // T♦ A♣ A♦ 3♥ 9♦ (data-qa card numbers)
const STUCK_FLOP = ["T♦", "A♣", "A♦"];
const QA: Record<string, number> = {};
for (let i = 0; i < 52; i++) QA[["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"][i % 13]! + "♣♦♥♠"[Math.floor(i / 13)]!] = i;

/** The capture a stuck frame keeps returning: 4920544731's board, every seat holding cards, no turn buttons — with
 *  `hole` at hero's seat 3 (the hand's own cards when it follows the table, as 4920431916's stuck frame did). */
function stuckCapture(hole: () => string[]) {
  const card = (qa: number, x: number, seat: number | null, y: number) => ({ qa: `card${qa}`, x, y, w: seat === null ? 72 : 42, seat, tbl: true });
  return () => ({
    seated: true, practice: false, frame: { x: 2, y: 70, w: 1276, h: 762 }, zoom: 1,
    nodes: [{ text: "$0.02/$0.05 No Limit Hold'em", x: 76, y: 79, w: 160, h: 14 },
            { text: "Total pot:", x: 458, y: 292, w: 81, h: 22 }, { text: "24.6 BB", x: 539, y: 292, w: 54, h: 22 }],
    buttons: [], cards: [], heroMini: [], canvases: 0,
    allCards: [...STUCK.map((qa, k) => card(qa, 350 + 85 * k, null, 345)),
               ...hole().map((c, k) => card(QA[c]!, 494 + 54 * k, 2, 500))],
    seatQa: [1, 2, 3, 4, 5, 6].map((num) => ({ seat: num - 1, num, me: num === 3, status: null, empty: false, stack: "100 BB", bet: null,
                                               badge: null, nHole: 2, dealer: false })),
  });
}

/** Slot 4's frames with a DOM tick every half second between them. */
function slot4Recs(): any[] {
  const ws = group("slot4-stuck");
  const recs = [...ws];
  for (let t = ws[0].ts - 1; t < ws[ws.length - 1].ts; t += 0.5) recs.push({ kind: "dom", ts: t });   // the table was open before
  return recs.sort((a, b) => a.ts - b.ts || (a.kind === b.kind ? 0 : a.kind === "ws" ? -1 : 1));
}

const WS_BOARDS: Record<string, string[]> = {        // what the table dealt each hand, in full
  "4920544902": ["5♦", "8♠", "3♣", "J♠", "A♠"],
  "4920545054": ["9♣", "5♠", "4♥", "8♣", "9♥"],
  "4920545175": [],
};

for (const [label, hole] of [
  ["the stuck hand's hole cards (7♣ 4♥)", () => ["7♣", "4♥"]],
  ["no hole cards", () => []],
  ["the hand's own hole cards", () => [...(S.ws.heroCards || [])]],
] as [string, () => string[]][]) {
  test(`a frame stuck on an earlier hand's board, showing ${label}: never the hand's board (slot 4, 4920545175)`, async () => {
    const { fails, check } = checker();
    const eq = (what: string, got: unknown, want: unknown) => check(what, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
    const recs = slot4Recs();
    const capture = stuckCapture(hole);
    const { exports, rows, logs } = await replay(recs, () => capture());
    const stuck = exports.filter((e) => J(e.board.slice(0, 3)) === J(STUCK_FLOP));
    eq("/hand never showed the stuck board", [...new Set(stuck.map((e) => e.hand))], []);
    for (const id of Object.keys(WS_BOARDS)) {
      const row = rows.find((r) => r.clientHandId === id);
      check(`${id} archived`, !!row, J(rows.map((r) => r.clientHandId)));
      if (!row) continue;
      eq(`${id}: the archived board is the table's own, as far as it had dealt`, row.board, WS_BOARDS[id]!.slice(0, row.board.length));
      check(`${id}: and it reached at least the flop the table dealt`, row.board.length >= Math.min(3, WS_BOARDS[id]!.length), J(row.board));
    }
    const pre = rows.find((r) => r.clientHandId === "4920545175");
    if (pre) {
      eq("4920545175 ended preflop: archived street", [pre.street, pre.column], ["preflop", "preflop"]);
      eq("  and no board", pre.board, []);
    }
    const decision = exports.filter((e) => e.hand === "4920545175" && e.heroTurn);
    check("/hand was read at hero's preflop decision in 4920545175", decision.length > 0);
    eq("  and said preflop, with no board", [...new Set(decision.map((e) => J([e.street, e.board])))], [J(["preflop", []])]);
    check("the refusal is logged, once per hand and reason",
          logs.filter((l) => l.startsWith("[board] hand 4920545175:")).length >= 1
          && new Set(logs.filter((l) => l.startsWith("[board]"))).size === logs.filter((l) => l.startsWith("[board]")).length,
          J(logs.filter((l) => l.startsWith("[board]"))));
    expect(fails).toEqual([]);
  });
}

// ---- slot 2: another table's frame, after the hand ended preflop -------------------------------------------------
test("another table's board, read after the hand ended preflop, is not the hand's (slot 2, 4920434476 replayed)", async () => {
  const { fails, check } = checker();
  const eq = (what: string, got: unknown, want: unknown) => check(what, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const recs = group("4920434476");
  const lastFold = recs.find((r) => r.kind === "ws" && r.d.pid === "CO_SELECT_INFO" && r.d.seat === 6 && r.d.btn === 1024)?.ts ?? Infinity;
  const foreign = recs.find((r) => r.kind === "dom" && r.ts > lastFold
                             && (r.d.allCards || []).filter((c: any) => c.tbl && c.seat == null && /^card\d+$/.test(c.qa)).length >= 3);
  check("the recording has a DOM tick after the hand's last fold that shows another table's flop", !!foreign);
  const { exports, rows } = await replay(recs, (r) => r?.d ?? {}, { TABLE_SLOT: "2", TABLE_COUNT: "4" });
  eq("/hand for 4920434476 never had a board", [...new Set(exports.filter((e) => e.hand === "4920434476").map((e) => J([e.street, e.board])))],
     [J(["preflop", []])]);
  const row = rows.find((r) => r.clientHandId === "4920434476");
  check("archived", !!row, J(rows.map((r) => r.clientHandId)));
  if (row) {
    eq("archived preflop", [row.street, row.column], ["preflop", "preflop"]);
    eq("  with no board", row.board, []);
    eq("  its line the table's own", row.actions.map((a: any) => [a.street, a.seatId, a.type]),
       [["preflop", 6, "post-sb"], ["preflop", 2, "post-bb"], ["preflop", 3, "fold"], ["preflop", 4, "fold"], ["preflop", 5, "fold"], ["preflop", 6, "fold"]]);
  }
  expect(fails).toEqual([]);
});

// ---- the rules, one by one ----------------------------------------------------------------------------------------
test("the screen's board is refused rule by rule, and a board frame the tap lost is still filled", () => {
  const { fails, check } = checker();
  const eq = (what: string, got: unknown, want: unknown) => check(what, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const refused = (board: string[]) => domBoardRefusal(board);
  const HOLE = ["K♠", "K♥"];                       // hero's cards as the table deals them: seat 3 [51, 38]
  const FLOP = ["2♣", "7♦", "J♥"];
  const deal = (hid: string) => {
    beginHand(hid);
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, btn: 2, bet: 2, account: 498 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, btn: 4, bet: 5, account: 495 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat3: [51, 38], seat4: [32896, 32896] });
  };
  try {
    setFakeTime(1_000);
    resetState();
    // a board frame the tap lost: the hand's own flop on screen with hero's own cards, after the preflop action
    deal("1");
    setFakeTime(1_010);
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 256, bet: 5, raise: 0, account: 495 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 1024, bet: 0, raise: 0, account: 500 });
    noteDomBoard(FLOP, HOLE);
    eq("a lost flop on screen with hero's own cards is taken", refused(FLOP), null);
    eq("  as is the lost turn after it", refused([...FLOP, "3♠"]), null);
    noteDomBoard(FLOP, [...HOLE].reverse());
    eq("  hole cards compare as a pair, in any order", refused(FLOP), null);
    noteDomBoard(FLOP, ["Q♠", "Q♥"]);
    check("hero's seat showing other cards: another table's or an earlier hand's", /came with Q♠ Q♥ at hero's seat, not K♠ K♥/.test(refused(FLOP) ?? ""), refused(FLOP) ?? "taken");
    noteDomBoard(FLOP, []);
    check("hero's seat showing no cards: refused too", /came with no hole cards/.test(refused(FLOP) ?? ""), refused(FLOP) ?? "taken");
    noteDomBoard(FLOP, HOLE);
    onGameMsg({ pid: "CO_BCARD3_INFO", bcard: [1, 19, 36] });   // 2♣ 7♦ J♥
    eq("the table's own flop and the screen's turn after it", refused([...FLOP, "3♠"]), null);
    check("a screen board that contradicts the table's flop", /contradicts the table's own \(2♣ 7♦ J♥\)/.test(refused(["2♣", "7♦", "Q♥", "3♠"]) ?? ""),
          refused(["2♣", "7♦", "Q♥", "3♠"]) ?? "taken");
    // a dropped flop frame: the WS holds only the turn, by position — the screen may fill the flop before it
    deal("2");
    setFakeTime(1_030);
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 256, bet: 5, raise: 0, account: 495 });
    onGameMsg({ pid: "CO_BCARD1_INFO", pos: 4, card: 41 });     // 3♠ at the turn's position
    noteDomBoard([...FLOP, "3♠"], HOLE);
    eq("the screen fills a flop the tap lost before a turn it has", refused([...FLOP, "3♠"]), null);
    check("  but not with another turn", /contradicts/.test(refused([...FLOP, "4♠"]) ?? ""), refused([...FLOP, "4♠"]) ?? "taken");
    // a board up before anyone acted is older than the hand, for the rest of it — from the deal on, grace or not
    deal("3");
    noteDomBoard(FLOP, HOLE);
    eq("the last hand's board still up at the deal is remembered", [...S.domBoard.stale], [FLOP.join(" ")]);
    setFakeTime(1_040);
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 256, bet: 5, raise: 0, account: 495 });
    noteDomBoard(FLOP, HOLE);
    check("a board up past the grace before anyone acted: refused once someone has",
          /was up before anyone had acted/.test(refused(FLOP) ?? ""), refused(FLOP) ?? "taken");
    check("  and the same board with a card more", /was up before anyone had acted/.test(refused([...FLOP, "3♠"]) ?? ""));
    eq("  another board is judged on its own", refused(["4♣", "8♦", "Q♠"]), null);
    deal("4");
    setFakeTime(1_050);
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 256, bet: 5, raise: 0, account: 495 });
    noteDomBoard(FLOP, HOLE);
    eq("a new hand forgets the last hand's stale boards", refused(FLOP), null);
    // the hand never left preflop: over, no board frame, every action preflop
    deal("5");
    setFakeTime(1_060);
    for (const seat of [3, 4, 1]) onGameMsg({ pid: "CO_SELECT_INFO", seat, btn: 1024, bet: 0, raise: 0, account: 500 });
    noteDomBoard(["4♣", "8♦", "Q♠"], HOLE);
    check("everyone folded to the big blind preflop: no board is the hand's",
          /ended preflop/.test(refused(["4♣", "8♦", "Q♠"]) ?? ""), refused(["4♣", "8♦", "Q♠"]) ?? "taken");
    deal("6");
    setFakeTime(1_070);
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 256, bet: 5, raise: 0, account: 495 });
    for (const seat of [4, 1]) onGameMsg({ pid: "CO_SELECT_INFO", seat, btn: 1024, bet: 0, raise: 0, account: 500 });
    S.ws.actions.push({ seat: 2, type: "check", cents: null, street: "flop" });   // the screen's backfill, on a flop
    S.ws.actions.push({ seat: 3, type: "fold", cents: null, street: "flop" });
    S.ws.foldedSeats.add(3);
    noteDomBoard(FLOP, HOLE);
    eq("a hand whose line went on past preflop keeps the screen's board after it ends", refused(FLOP), null);
  } finally {
    realTime();
  }
  expect(fails).toEqual([]);
});
