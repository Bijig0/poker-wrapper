/**
 * THE CROSS-TABLE FIXES (2026-09-25, session 20260925_180244 — 4 tables, NL5, real money, auto on). A wifi drop
 * replaced the tables; the recovery then read and pressed the wrong tables:
 *   1. hole cards before any click — table 1 pressed 4hQd's "Raise 3.5" with 9♠9♣ (a 5bb 3-bet, then a no-answer
 *      FOLD) and A8o's "Call" with 5♣7♣, because every check compared the pick with a capture that was itself the
 *      wrong hand;
 *   2. a table by the client's own TAG, not its position — closing the top-right table by hand moved table 2 onto
 *      the bottom-left table and table 3 (reading A8o there) onto the bottom-right;
 *   3. a socket by its hole cards — table 1 bound the A8o table's socket on a sit-in naming "seat 4" (hero sat in
 *      seat 4 at both), then 16 times more on a deal from the hand before, while its own frame showed 9♠9♣ / 5♣7♣;
 *   4. the verify — our frame still showing the hand before's 6♦5♦ 3.7 s after the deal let the RIGHT socket go,
 *      and the hand in progress was carried on onto the next socket (A8o's "internally inconsistent" capture).
 * Each is pinned here against the thing that went wrong; test/unit/cross-table-replay.test.ts replays the session.
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { js } from "../../src/js";
import { pyJsonDumps } from "../../src/py";
import { S, TupleSet, resetState, seams } from "../../src/state";
import { archiveHand } from "../../src/archive";
import { cardKey, cardName, forgetFrame, mySel, pinFrame, sameHole } from "../../src/ignition/dom";
import { TAP_DEAL_LAG_S, tapFrame, tapVerify, wsSeams } from "../../src/ignition/ws";
import {
  act, executePick, holeCardsRefusal, keyCards, maybeFoldNoAnswer, maybeTakeTime, pickReady, pointIsMyTable, raiseTo,
} from "../../src/relay";
import { BET_SPOT, FakeIgnition, RIVER_FACING_BET } from "./fakeIgnition";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_790_334_700;

function env(slot: number | null, count = 4) {
  if (slot === null) {
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
  } else {
    process.env.TABLE_SLOT = String(slot);
    process.env.TABLE_COUNT = String(count);
  }
}

function saveEnv() {
  const s0 = process.env.TABLE_SLOT, c0 = process.env.TABLE_COUNT;
  return () => {
    if (s0 === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = s0;
    if (c0 === undefined) delete process.env.TABLE_COUNT;
    else process.env.TABLE_COUNT = c0;
  };
}

// ---- 2. the frame resolver, run for real against a page shim -------------------------------------------------
/** One client page: its table iframes (id, tag) — mutable, so a table can close under the wrappers reading it — and
 *  its window, where the page keeps who holds which tag. */
class Page {
  window: Record<string, any> = {};
  now = 1_000_000;
  constructor(public tables: [string, string | null][]) {}
  frame() {
    const els = () => this.tables.map(([id, tag]) => ({
      // the lobby frame (tag -1) carries no playMode: it is never a table
      id, getAttribute: (n: string) => (n === "data-multitableslot" ? tag : n === "src" ? (tag === "-1" ? `lobby#${id}` : `x?playMode=real#${id}`) : null),
    }));
    const document = { querySelectorAll: (sel: string) => {
      if (sel !== "iframe") throw new Error("the resolver asked for " + sel);
      return els();
    } };
    const f = new Function("document", "window", "Date", js("launch.FRAME_JS") + "\nreturn __frame;")(document, this.window, { now: () => this.now });
    return (sel: unknown): string | null => {
      const got = f(sel);
      return got ? got.id : null;
    };
  }
}

test("2. a table is the client's TAG: closing one never moves another wrapper onto it", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  // the 2026-09-25 client: TL 0, TR 1, BL 2 (the A8o table), BR 3, the lobby at -1
  const page = new Page([["lobby", "-1"], ["TL", "0"], ["TR", "1"], ["BL", "2"], ["BR", "3"]]);
  let frame = page.frame();
  const tagOf = (id: string | null) => page.tables.find(([t]) => t === id)?.[1] ?? null;
  const pins: Record<number, string | null> = {};
  for (let s = 1; s <= 4; s++) pins[s] = tagOf(frame({ ord: s - 1, me: s }));
  eq("each wrapper's first read finds its own table in the client's order", pins, { 1: "0", 2: "1", 3: "2", 4: "3" });

  // 18:13:18.5 — the top-right table closed by hand
  page.tables = page.tables.filter(([id]) => id !== "TR");
  page.now += 250;
  frame = page.frame();
  eq("BEFORE: by ordinal, table 2 read the bottom-left table (the A8o hand) ...", frame(1), "BL");
  eq("  ... and table 3 the bottom-right — the neighbours' tables", frame(2), "BR");
  const read = (s: number) => frame({ tag: pins[s], ord: s - 1, me: s });
  eq("NOW: table 1 still reads its own table", read(1), "TL");
  eq("  ... table 2's table is gone: it reads NOTHING rather than a neighbour's", read(2), null);
  eq("  ... table 3 stays on the bottom-left table, the A8o hand's", read(3), "BL");
  eq("  ... table 4 stays on its own", read(4), "BR");

  page.now += 5_000;
  frame = page.frame();
  eq("a wrapper that restarted within the minute finds the tag it held (not the 3rd table now in order)", frame({ ord: 2, me: 3 }), "BL");
  eq("a restarted table 2 does not take the table another wrapper is reading", frame({ ord: 1, me: 2 }), null);

  // a table closes and the client later reopens one under the same tag: its wrapper follows it there
  page.tables.push(["TR2", "1"]);
  eq("the client's tag 1 back (a new table in the old place): table 2 reads it again", page.frame()({ tag: "1", ord: 1, me: 2 }), "TR2");

  // a new session: every wrapper forgets its pin; a stale page entry from long ago must not block the leader
  const p2 = new Page([["lobby", "-1"], ["A", "0"], ["B", "1"]]);
  p2.window.__pwFramePins = { 0: { slot: 2, at: p2.now - 120_000 } };
  eq("an old claim (2 minutes) does not keep the leader off tag 0", p2.frame()({ ord: 0, me: 1 }), "A");
  eq("  ... and the leader's read claims it at once", J(p2.window.__pwFramePins["0"].slot), "1");
  eq("  ... so table 2, not pinned yet, gets its own and not the leader's", p2.frame()({ ord: 1, me: 2 }), "B");

  // formats' flows name a table by the client's own number
  const gaps = new Page([["x", "5"], ["y", "9"]]);
  eq("{tag} finds the table the client tags that way, gaps or not", gaps.frame()({ tag: "9" }), "y");
  eq("  ... and a tag the client does not show is nothing", gaps.frame()({ tag: "7" }), null);
  const one = new Page([["only", null]]);
  eq("the single-table client (no tags): null and the leader's first read are its table", [one.frame()(null), one.frame()({ ord: 0, me: 1 })], ["only", "only"]);
  eq("  ... and there is no second table", one.frame()({ ord: 1, me: 2 }), null);
  eq("formats' resolver is the identical snippet", js("formats.FRAME_FN"), js("launch.FRAME_JS"));
  expect(fails).toEqual([]);
});

test("2. the reader pins its table's tag, says when it goes, and a new table set lets it go", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const restore = saveEnv();
  resetState();
  setFakeTime(T0);
  try {
    env(null);
    eq("one table: no selector, no pin", [mySel(), pinFrame("0", true)], [null, null]);
    env(3);
    eq("table 3 of 4, before its first read: the 3rd table in the client's order", mySel(), { ord: 2, me: 3 });
    eq("a read that found no table pins nothing", pinFrame(null, false), null);
    eq("the first read that finds one pins its tag", pinFrame("2", true), "pinned");
    eq("  ... and every snippet then names that tag", mySel(), { tag: "2", ord: 2, me: 3 });
    eq("  ... later reads change nothing", pinFrame("2", true), null);
    eq("the table gone: said once", [pinFrame(null, false), pinFrame(null, false)], ["lost", null]);
    eq("  ... and still pinned to it (never re-pinned to whatever is there now)", mySel(), { tag: "2", ord: 2, me: 3 });
    eq("  ... back when the client shows that tag again", pinFrame("2", true), "back");
    env(3, 2);
    eq("a new table count lets the pin go", mySel(), { ord: 2, me: 3 });
    pinFrame("7", true);
    forgetFrame();
    eq("a new session lets it go too", mySel(), { ord: 2, me: 3 });
  } finally {
    restore();
    resetState();
  }
  expect(fails).toEqual([]);
});

test("2. a press lands only inside the table the reader pinned", async () => {
  const { fails, check } = checker();
  const restore = saveEnv();
  const ev0 = cdp.io.evaluate;
  resetState();
  let answer = "2";
  cdp.io.evaluate = async () => answer;
  try {
    env(3);
    const why0 = await pointIsMyTable("ws://x", 10, 10);
    check("no pin yet: refused", !!why0 && why0.includes("has not identified"), String(why0));
    pinFrame("2", true);
    check("a point in our table (the client's 2): allowed", (await pointIsMyTable("ws://x", 10, 10)) === null);
    answer = "3";
    const why = await pointIsMyTable("ws://x", 10, 10);
    check("a point in the client's table 3: refused, naming both", !!why && why.includes("table 3") && why.includes("the client's 2"), String(why));
    answer = "unknown";
    const outside = await pointIsMyTable("ws://x", 10, 10);
    check("a point outside every table (the page's own grid, a gap, an overlay) is refused at several tables", !!outside && outside.includes("outside every table"), String(outside));
    answer = "2";
    pinFrame(null, false);
    const gone = await pointIsMyTable("ws://x", 10, 10);
    check("our table gone: refused", !!gone && gone.includes("is gone"), String(gone));
    env(null);
    check("one table: never asked", (await pointIsMyTable("ws://x", 10, 10)) === null);
  } finally {
    cdp.io.evaluate = ev0;
    restore();
    resetState();
  }
  expect(fails).toEqual([]);
});

// ---- 3 + 4. the socket binder and the verify, frame by frame -------------------------------------------------
const FACE_DOWN = 32896;
// wire codes: N = suit*13 + rank (A=0), suits ♣♦♥♠
const C = { "9s": 47, "9c": 8, "6d": 18, "5d": 17, "4h": 29, "Qd": 24, "8h": 33, "Ac": 0, "5c": 4, "7c": 6, "Ks": 51, "5h": 30 };
const deal = (seat: number, a: number, b: number) => ({ pid: "CO_CARDTABLE_INFO", [`seat${seat}`]: [a, b], seat2: [FACE_DOWN, FACE_DOWN] });
const stage = (id: string) => ({ pid: "PLAY_STAGE_INFO", stageNo: id });
const blinds = [{ pid: "CO_BLIND_INFO", seat: 2, account: 483, btn: 2, bet: 2, dead: 0 }, { pid: "CO_BLIND_INFO", seat: 4, account: 588, btn: 4, bet: 5, dead: 0 }];
const names = (...cs: number[]) => cs.map((c) => cardName(`card${c}`)!);

function freshTap(slot = 1, heroSeat = 4) {
  resetState();
  env(slot);
  reloadConfig();
  S.liveStatus.heroSeatDom = heroSeat;
  Object.assign(S, { tapHist: new Map(), tapDeals: new Map(), tapRejected: new Set(), tapClaims: new Map(), tapHold: new Map(),
                     tapDomCards: [], tapAmbiguousSaid: new TupleSet(), tapPrevHero: [], tapDealtAt: 0.0, handAbandoned: null });
}

/** The reader's tick, as far as the tap is concerned: our frame shows `cards`, a quarter-second later. */
function tick(cards: string[], n = 1) {
  for (let i = 0; i < n; i++) {
    setFakeTime(time() + 0.25);
    tapVerify(cards);
  }
}

test("4. the verify rides out our frame catching up on a new deal — and still lets another table go", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const restore = saveEnv();
  scratchDirs();
  setFakeTime(T0);
  const log0 = console.log;
  console.log = () => {};
  try {
    freshTap();
    tapFrame({ pid: "CO_SIT_PLAY", play: 1, seat: 4 }, "T");
    eq("our own sit-in, no cards on our frame: bound", S.tapBound, "T");
    tapFrame(stage("4920571310"), "T");
    for (const b of blinds) tapFrame(b, "T");
    tapFrame(deal(4, C["6d"], C["5d"]), "T");
    tick(names(C["6d"], C["5d"]), 4);
    // 18:12:11.6: the next hand's deal; our frame goes on showing the hand before's 6♦5♦ for 3.7 s
    tapFrame(stage("4920571374"), "T");
    tapFrame(deal(4, C["9s"], C["9c"]), "T");
    tick(names(C["6d"], C["5d"]), 15);
    eq("3.7 s of the hand before's cards on our frame: the socket is kept (the old verify let it go at 2 s)", S.tapBound, "T");
    tick(names(C["9s"], C["9c"]), 1);
    eq("  ... and the frame catches up", [S.tapBound, S.tapMismatch], ["T", 0]);
    // the hand after: our frame shows cards that are neither this hand's nor the one before's
    tick(names(C["Ks"], C["5h"]), 7);
    eq("cards of ANOTHER hand on our frame: ridden out for 7 ticks ...", S.tapBound, "T");
    tick(names(C["Ks"], C["5h"]), 1);
    eq("  ... and let go at the 8th, as before", S.tapBound, null);

    freshTap();
    tapFrame({ pid: "CO_SIT_PLAY", play: 1, seat: 4 }, "T");
    tapFrame(stage("h1"), "T");
    tapFrame(deal(4, C["6d"], C["5d"]), "T");
    tick(names(C["6d"], C["5d"]), 1);
    tapFrame(stage("h2"), "T");
    tapFrame(deal(4, C["9s"], C["9c"]), "T");
    setFakeTime(time() + TAP_DEAL_LAG_S + 0.5);
    tick(names(C["6d"], C["5d"]), 8);
    eq("the hand before's cards long after the deal ARE a disagreement", S.tapBound, null);
  } finally {
    console.log = log0;
    restore();
    resetState();
  }
  expect(fails).toEqual([]);
});

test("3. a socket binds by the cards our own frame shows — never a stale deal, never a claim over them", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const restore = saveEnv();
  scratchDirs();
  setFakeTime(T0);
  const log0 = console.log;
  console.log = () => {};
  try {
    // 18:12:19 — table 1 unbound, its frame showing 9♠9♣; the A8o table's socket X deals 4♥Q♦ into "seat 4"
    freshTap();
    tick(names(C["9s"], C["9c"]));
    tapFrame(stage("4920571386"), "X");
    tapFrame(deal(4, C["4h"], C["Qd"]), "X");
    eq("a deal into our seat number that our frame contradicts does not bind (it did, 16 times)", S.tapBound, null);
    tapFrame({ pid: "CO_SIT_PLAY", play: 1, seat: 4 }, "X");
    eq("  ... nor does that table's sit-in naming our seat, while our frame shows cards", S.tapBound, null);
    tapFrame(stage("4920571374"), "T");
    for (const b of blinds) tapFrame(b, "T");
    tapFrame(deal(4, C["9s"], C["9c"]), "T");
    eq("the socket that dealt the cards our frame shows binds", S.tapBound, "T");
    eq("  ... replaying its own hand from its start, and nothing of the other table's", [S.handIds.get(S.handNo), S.ws.heroCards], ["4920571374", names(C["9s"], C["9c"])]);

    // no cards on our frame: a deal binds only while it is fresh; a hand's deal is forgotten when that socket moves on
    freshTap();
    tick(names(C["5c"], C["7c"]));
    tapFrame(stage("a"), "X");
    tapFrame(deal(4, C["8h"], C["Ac"]), "X");
    tick([], 1);
    setFakeTime(time() + 5);
    tapFrame({ pid: "PONG" }, "X");
    eq("a deal into our seat older than our frame takes to draw one is another table's", S.tapBound, null);
    tapFrame(stage("b"), "X");
    eq("  ... and a socket's new hand forgets its old deal", S.tapDeals.has("X"), false);
    tapFrame(deal(4, C["8h"], C["Ac"]), "X");
    eq("a fresh deal with nothing on our frame to contradict it binds (the frame lags its own deal)", S.tapBound, "X");
  } finally {
    console.log = log0;
    restore();
    resetState();
  }
  expect(fails).toEqual([]);
});

test("4. a socket let go takes the hand with it: never archived, nothing pressed, rebuilt from its start on its own cards", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const restore = saveEnv();
  const tmp = scratchDirs();
  setFakeTime(T0);
  const log0 = console.log;
  console.log = () => {};
  const arch0 = wsSeams.archiveHand;
  let archived = 0;
  try {
    freshTap();
    tapFrame({ pid: "CO_SIT_PLAY", play: 1, seat: 4 }, "T");
    tapFrame(stage("4920571422"), "T");
    for (const b of blinds) tapFrame(b, "T");
    tapFrame(deal(4, C["8h"], C["Ac"]), "T");
    tapFrame({ pid: "CO_SELECT_INFO", seat: 2, btn: 4096, bet: 3, raise: 13, account: 470 }, "T");
    tapFrame({ pid: "CO_SELECT_INFO", seat: 4, btn: 4096, bet: 10, raise: 43, account: 545 }, "T");
    tick(names(C["8h"], C["Ac"]));
    const n0 = S.ws.actions.length, hand0 = S.handNo;
    eq("the hand is read", [S.tapBound, S.handIds.get(S.handNo), n0], ["T", "4920571422", 4]);
    wsSeams.archiveHand = () => { archived++; arch0(); };
    // our frame moves on to another table's hand (18:13:19: K♠5♥)
    tick(names(C["Ks"], C["5h"]), 8);
    eq("sustained disagreement lets the socket go", S.tapBound, null);
    eq("  ... and the hand in progress goes with it — not carried onto the next socket", [S.ws.actions.length, S.ws.heroCards, S.handIds.get(S.handNo)], [0, [], ""]);
    eq("  ... a new, id-less hand in its place", S.handNo, hand0 + 1);
    eq("  ... the dropped hand is not archived (another table's, or unverifiable)", archived, 0);
    archiveHand();
    const db = join(tmp, "data", "hands.db");
    const rows = existsSync(db) ? (new Database(db).query("SELECT COUNT(*) n FROM hands").get() as any).n : 0;
    eq("  ... nor is the id-less one opened in its place", rows, 0);
    Object.assign(S.study, { on: true, text: "x", pick: "Check", at: time(), handId: S.handNo,
                             decisionKey: pyJsonDumps(["preflop", [], ["8h", "Ac"], 0, 0]) });
    S.liveStatus.toAct = true;
    const r = pickReady();
    eq("  ... and nothing is pressed for it", [r.ok, String(r.reason).includes("dropped")], [false, true]);
    // the frame shows 8♥A♣ again (it was ours after all): the let-go socket comes back on those cards
    tick(names(C["8h"], C["Ac"]));
    tapFrame({ pid: "PONG" }, "T");
    eq("a socket let go of binds again on the cards our frame shows", S.tapBound, "T");
    eq("  ... and its hand is rebuilt from its start, every action", [S.handIds.get(S.handNo), S.ws.actions.length, S.ws.heroCards],
       ["4920571422", n0, names(C["8h"], C["Ac"])]);
  } finally {
    wsSeams.archiveHand = arch0;
    console.log = log0;
    restore();
    resetState();
  }
  expect(fails).toEqual([]);
});

// ---- 1. the hole-card guard ------------------------------------------------------------------------------------
test("1. hole cards before any click: the notation, the rule, the decision key", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const restore = saveEnv();
  try {
    eq("every notation is one card", ["A♥", "Ah", "ah", "10♦", "Td", " T♦ ", "x", "11h"].map(cardKey), ["Ah", "Ah", "Ah", "Td", "Td", "Td", null, null]);
    eq("the same two cards in any order and notation", [sameHole(["A♣", "8♥"], ["8h", "Ac"]), sameHole(["Ac"], ["Ac"]), sameHole(["Ac", "8h"], ["Ac", "9h"])], [true, false, false]);
    env(null);
    eq("one table: the same hand passes", holeCardsRefusal(["8h", "Ac"], ["A♣", "8♥"]), null);
    const why = holeCardsRefusal(["8h", "Ac"], ["5♣", "7♣"]);
    check("  ... another hand is refused, naming both (A8o's Call on the 57s table)", !!why && why.includes("8h Ac") && why.includes("5c 7c"), String(why));
    eq("  ... nothing drawn is left alone (the single-table reader has always pressed through it)", holeCardsRefusal(["8h", "Ac"], []), null);
    env(1);
    check("several tables: nothing drawn is refused", String(holeCardsRefusal(["8h", "Ac"], [])).includes("shows no hole cards"));
    check("  ... and a decision carrying no cards is refused", String(holeCardsRefusal(null, ["8♥", "A♣"])).includes("no hole cards"));
    eq("  ... unless the caller is a human (strict off): then only a contradiction refuses", holeCardsRefusal(["8h", "Ac"], [], false), null);
    eq("the cards a decision key was made for", [keyCards(`17|${pyJsonDumps(["river", ["3s"], ["8h", "Ac"], 0, 12])}`), keyCards(pyJsonDumps(["preflop", [], ["9s", "9c"], 0, 2])), keyCards("x|nonsense"), keyCards(null)],
       [["8h", "Ac"], ["9s", "9c"], null, null]);
  } finally {
    restore();
  }
  expect(fails).toEqual([]);
});

const KEY = (n: number) => pyJsonDumps(["preflop", [], ["8h", "Ac"], 0, n]);

/** A decision the relay would press: hero (seat 4, 8♥A♣) facing SB's open, the answer "Call". */
function seedDecision(pick = "Call") {
  S.fakeMode = false;
  S.handNo = 17;
  S.handIds.set(17, "4920571422");
  S.feedPrev = { seated: true, seats: new Map([[2, { stack: "97 BB" }], [4, { stack: "118.6 BB" }]]) };
  Object.assign(S.liveStatus, { toAct: true, practice: false, board: [], modal: null, buyPanel: false });
  Object.assign(S.ws, {
    bb: 5, bbSeen: true, dealt: [2, 4], heroSeat: 4, dealer: 2, board: [], heroCards: ["8♥", "A♣"], potCents: 20, maxBet: 15,
    committed: new Map([[2, 15], [4, 5]]),
    actions: [{ seat: 2, type: "post-sb", cents: 2, street: "preflop" }, { seat: 4, type: "post-bb", cents: 5, street: "preflop" },
              { seat: 2, type: "raise", cents: 15, street: "preflop" }],
    actionOn: 4, heroFolded: false, foldedSeats: new Set(), domGraceUntil: 0,
  });
  Object.assign(S.study, { on: true, text: `PREFLOP — ${pick} 69%`, pick, roll: 34, at: time(), decisionKey: KEY(3), handId: 17,
                           executed: null, auto: false, autoTried: null, lastExec: null });
}

test("1. pickReady waits for the table to show the hand the answer is for", () => {
  const { fails, check } = checker();
  const restore = saveEnv();
  scratchDirs();
  setFakeTime(T0);
  resetState();
  try {
    env(null);
    seedDecision();
    S.tapDomCards = ["8♥", "A♣"];
    check("the frame shows the answer's hand: ready", pickReady().ok, J(pickReady()));
    S.tapDomCards = ["5♣", "7♣"];
    const r = pickReady();
    check("the frame shows another hand: not ready, and why", !r.ok && String(r.reason).includes("8h Ac") && String(r.reason).includes("5c 7c"), J(r));
    S.tapDomCards = [];
    check("one table, nothing drawn yet: ready as before", pickReady().ok);
    env(1);
    const r2 = pickReady();
    check("several tables, nothing drawn yet: not ready (waits a tick for the deal animation)", !r2.ok && String(r2.reason).includes("no hole cards"), J(r2));
  } finally {
    restore();
    resetState();
  }
  expect(fails).toEqual([]);
});

test("1. the press itself: refused on its own read of a table showing another hand — nothing typed, nothing clicked", async () => {
  const { fails, check } = checker();
  const restore = saveEnv();
  scratchDirs();
  setFakeTime(T0);
  resetState();
  const log0 = console.log;
  console.log = () => {};
  env(null);
  const fake = new FakeIgnition(RIVER_FACING_BET, { stack: 118.6 });
  const undo = fake.install();
  try {
    fake.heroQa = ["card4", "card6"];                       // 5♣ 7♣ — the top-left table's hand
    let res = await act("call", "action", { cards: ["8h", "Ac"] });
    check("a CALL for 8♥A♣ on a table showing 5♣7♣: refused", !res.ok && res.wrongHand && String(res.reason).includes("5c 7c"), J(res));
    check("  ... nothing clicked", fake.clicks.length === 0, J(fake.clicks));
    res = await raiseTo("9.6", true, { cards: ["8h", "Ac"] });
    check("a raise for 8♥A♣: refused before a size is typed", !res.ok && res.wrongHand && fake.field === "2.0" && fake.clicks.length === 0, J(res));
    fake.heroQa = ["card33", "card0"];                      // 8♥ A♣
    res = await act("call", "action", { cards: ["8h", "Ac"] });
    check("the table showing 8♥A♣: the CALL goes", res.ok && J(fake.clicks) === J(["CALL 1 BB"]), J(res));
  } finally {
    undo();
    console.log = log0;
    restore();
    resetState();
  }
  expect(fails).toEqual([]);
});

test("1. every automatic press carries the decision's cards: the pick, the no-answer fold, the time bank", async () => {
  const { fails, check } = checker();
  const restore = saveEnv();
  scratchDirs();
  setFakeTime(T0);
  resetState();
  const log0 = console.log;
  console.log = () => {};
  env(null);
  const fake = new FakeIgnition(BET_SPOT, { stack: 91.2 });
  const undo = fake.install();
  try {
    // the reader last saw 8♥A♣ — then the frame changed under the pick (the reason the press re-reads)
    seedDecision("CHECK");
    S.tapDomCards = ["8♥", "A♣"];
    fake.heroQa = ["card4", "card6"];
    const res = await executePick("auto");
    check("the pick: refused on the press's own read, recorded as refused", !res.ok && S.study.lastExec?.outcome === "refused"
          && String(S.study.lastExec?.result?.reason).includes("5c 7c"), J(S.study.lastExec));
    check("  ... nothing clicked", fake.clicks.length === 0, J(fake.clicks));

    // fold-on-no-answer (18:12:38: a no-answer FOLD for 4hQd folded 9♠9♣ on another table)
    seedDecision("CHECK");
    Object.assign(S.study, { text: null, pick: null, auto: true, foldNoAnswer: true, noAnswerTurn: null });
    S.heroClock = 2;
    await maybeFoldNoAnswer();
    const nf = S.study.lastNoAnswerFold;
    check("no-answer: the CHECK is refused on a table showing another hand ...", nf && !nf.ok && String(nf.reason).includes("5c 7c"), J(nf));
    check("  ... and no FOLD is tried after it", nf && nf.did === "check" && fake.clicks.length === 0, J([nf, fake.clicks]));
    fake.heroQa = ["card33", "card0"];
    Object.assign(S.study, { noAnswerTurn: null });
    await maybeFoldNoAnswer();
    check("  ... the table showing the capture's hand: CHECK pressed", S.study.lastNoAnswerFold?.ok && J(fake.clicks) === J(["CHECK"]), J(fake.clicks));

    // the time bank is not spent on a decision the capture is not reading
    const tb = new FakeIgnition(RIVER_FACING_BET, { stack: 118.6 });
    undo();
    const undo2 = tb.install();
    try {
      seedDecision("Call");
      Object.assign(S.study, { timeBank: true, timeBankAt: 0, timeBankDecision: null });
      S.liveStatus.timeBank = { text: "+45s" };
      tb.heroQa = ["card4", "card6"];
      const t1 = await maybeTakeTime();
      check("time bank: not pressed on a table showing another hand", t1 && !t1.ok && tb.clicks.length === 0, J([t1, tb.clicks]));
      setFakeTime(time() + 6);
      tb.heroQa = ["card33", "card0"];
      const t2 = await maybeTakeTime();
      check("  ... pressed when it shows the capture's hand", t2 && t2.ok && J(tb.clicks) === J(["+45s"]), J([t2, tb.clicks]));
    } finally {
      undo2();
    }
  } finally {
    try { undo(); } catch {}
    console.log = log0;
    restore();
    resetState();
  }
  expect(fails).toEqual([]);
});
