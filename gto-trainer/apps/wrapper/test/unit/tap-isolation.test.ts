/**
 * Port of tests/test_tap_isolation.py — one page holds up to four tables, so the tap sees every table's frames;
 * ours is isolated by socket. Single table: bind on hero's face-up cards. Multi-table: bind the socket that dealt our
 * seat the hole cards OUR OWN frame shows — a seat number is not a table (2026-09-25: seat evidence bound other tables'
 * sockets in all three four-table sessions that day) — hold and replay its hand until then, drop another table's
 * frames, follow our frame to the socket whose deal it shows, ride out a frame still showing the last hand, and the
 * real 2026-09-21 two-table frames split cleanly between two wrappers. The real four-table page is replayed in
 * table-binding-replay.test.ts.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realTime, setFakeTime, time } from "../../src/clock";
import { paths } from "../../src/env";
import { S, TupleSet, resetState } from "../../src/state";
import { cardName, domHeroSeat, faceUpSeats, heroCards } from "../../src/ignition/dom";
import { tapAccepts, tapFrame, tapTakeReplay, tapVerify } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const FACE_DOWN = 32896;
const OURS = { pid: "CO_CARDTABLE_INFO", seat1: [FACE_DOWN, FACE_DOWN], seat2: [33, 51] };
const THEIRS = { pid: "CO_CARDTABLE_INFO", seat1: [FACE_DOWN, FACE_DOWN], seat3: [FACE_DOWN, FACE_DOWN] };
const STAGE = { pid: "PLAY_STAGE_INFO", stageNo: "123" };
const names = (...codes: number[]) => codes.map((c) => cardName(`card${c}`)!);

function reset(slot: number | null = null, heroSeat: number | null = null) {
  Object.assign(S, {
    tapBound: null, tapForeign: 0, tapHeld: 0, tapMismatch: 0, tapSeen: new Map(), tapDealt: new Map(), tapClaims: new Map(),
    tapRejected: new Set(), tapHold: new Map(), tapReplay: [], tapDomCards: [], tapAmbiguousSaid: new TupleSet(),
    tapStall: { since: null, said: false }, tapDeals: new Map(), tapHist: new Map(), tapPrevHero: [], tapDealtAt: 0.0,
    tapDealDrawn: false, handAbandoned: null, wsDump: [],
  });
  S.ws.heroCards = [];
  S.liveStatus.heroSeatDom = heroSeat;
  if (slot === null) delete process.env.TABLE_SLOT;
  else process.env.TABLE_SLOT = String(slot);
}

function dealt(seat: number, cards: number[], others = [1, 3, 5]): Record<string, any> {
  const d: Record<string, any> = { pid: "CO_CARDTABLE_INFO", [`seat${seat}`]: [...cards] };
  for (const o of others) if (o !== seat) d[`seat${o}`] = [FACE_DOWN, FACE_DOWN];
  return d;
}

/** What the reader read off the frames the tap handed it (the dump), as [rid, pid, replayed]. */
const read = () => S.wsDump.filter((e) => !String(e.pid).startsWith("<")).map((e) => [e.rid, e.pid, !!e.replayed]);

test("tap socket isolation", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  scratchDirs();
  resetState();
  const slot0 = process.env.TABLE_SLOT;
  const log0 = console.log;
  console.log = () => {};
  setFakeTime(1790000000);
  try {
    // ---- one table: unchanged — the socket showing hero's cards is ours
    reset();
    eq("no requestId is always accepted", tapAccepts(STAGE, null), true);
    eq("  and never binds", S.tapBound, null);
    reset();
    tapAccepts(THEIRS, "rid-B");
    eq("a table without hero's cards does not bind", S.tapBound, null);
    tapAccepts(OURS, "rid-A");
    eq("the socket showing hero's cards binds", S.tapBound, "rid-A");
    eq("our own socket is accepted", tapAccepts(STAGE, "rid-A"), true);
    eq("the other table's frames are dropped", tapAccepts(STAGE, "rid-B"), false);
    eq("  and counted", S.tapForeign, 1);
    tapAccepts(THEIRS, "rid-B");
    eq("  repeatedly", S.tapForeign, 2);
    reset();
    eq("pre-binding frames pass", tapAccepts(STAGE, "rid-B"), true);

    // ---- several tables: the cards our own frame shows decide
    const OURS_3 = dealt(3, [33, 51]);
    const OTHER_1 = dealt(1, [25, 34]);
    reset(2, 3);
    eq("a socket dealing into ANOTHER seat does not bind us", tapAccepts(OTHER_1, "rid-B") || S.tapBound, null);
    eq("  ... and its frames are not taken in the meantime", tapAccepts(STAGE, "rid-B"), false);
    tapAccepts(OURS_3, "rid-A");
    eq("a socket dealing into our seat NUMBER does not bind on that alone", S.tapBound, null);
    tapVerify(names(33, 51));
    eq("  ... our own frame showing the cards it dealt does", S.tapBound, "rid-A");
    eq("  ... ours is accepted", tapAccepts(STAGE, "rid-A"), true);
    eq("  ... and the other table is dropped", tapAccepts(STAGE, "rid-B"), false);

    reset(2, 3);
    eq("a frame from an unidentified socket is dropped", tapAccepts(STAGE, "rid-B"), false);
    eq("  ... and counted as held", S.tapHeld, 1);
    eq("  ... including the other table's deal", tapAccepts(OTHER_1, "rid-B"), false);
    eq("  ... so nothing of another table's hand is ever read", S.tapBound, null);

    // 05:11:10, session 20260925_051023: the leader's table's buy-in named seat 3 before table 3's own did
    const BUYIN_3 = { pid: "PLAY_BUYIN_INFO", type: 1, seat: 3, displayMax: 20000 };
    const SIT_3 = { pid: "CO_SIT_PLAY", play: 1, seat: 3 };
    const CASH_3 = { pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 3, cash: 2500 };
    const SEAT_3 = { pid: "PLAY_SEAT_INFO", type: 1, seat: 3, nickName: "x" };
    const BLINDS = { pid: "CO_BLIND_INFO", seat: 1, bet: 10 };
    reset(2, 3);
    tapAccepts(BUYIN_3, "rid-B");
    eq("ANOTHER table's buy-in naming our seat number binds nothing (11292.614, 05:11:10)", S.tapBound, null);
    tapAccepts(BUYIN_3, "rid-A");
    tapAccepts(SIT_3, "rid-A");
    tapAccepts(CASH_3, "rid-A");
    tapAccepts(SEAT_3, "rid-A");
    eq("  ... nor our own buy-in, sit-in or seat frames: two tables name seat 3", S.tapBound, null);
    tapAccepts(STAGE, "rid-A");
    tapAccepts(BLINDS, "rid-A");
    tapAccepts({ pid: "PLAY_STAGE_INFO", stageNo: "999" }, "rid-B");
    tapAccepts(dealt(3, [7, 8]), "rid-B");
    tapAccepts(dealt(3, [33, 51]), "rid-A");
    eq("  ... nor the deals into seat 3 at both tables", S.tapBound, null);
    tapVerify(names(33, 51));
    eq("  ... the socket that dealt the cards OUR frame shows binds", S.tapBound, "rid-A");
    eq("  ... and its hand is read at once, from its PLAY_STAGE_INFO, in order", read().map(([r, p, rp]) => [r, p, rp]),
       [["rid-A", "PLAY_STAGE_INFO", true], ["rid-A", "CO_BLIND_INFO", true], ["rid-A", "CO_CARDTABLE_INFO", true]]);
    eq("  ... nothing is left to replay twice", tapTakeReplay(), []);
    eq("  ... the other table's held frames are gone", S.tapHold.size, 0);

    reset(2, null);
    tapAccepts(OURS_3, "rid-A");
    tapVerify(names(33, 51));
    eq("the DOM has not named our seat: nothing binds on a guess", S.tapBound, null);
    eq("  ... and nothing is read", tapAccepts(STAGE, "rid-A"), false);
    S.liveStatus.heroSeatDom = 3;
    tapAccepts(OURS_3, "rid-A");
    tapVerify(names(33, 51));
    eq("  ... it binds as soon as the DOM says which seat is hero's", S.tapBound, "rid-A");

    reset(2, 3);
    tapAccepts(OURS_3, "rid-A");
    tapVerify(names(51, 33));
    eq("our frame's cards match in any order", S.tapBound, "rid-A");

    // ---- bound: our frame still showing the LAST hand's cards is not a disagreement (04:57:23, 18:12:15)
    reset(2, 3);
    tapFrame(dealt(3, [33, 51]), "rid-A");
    tapVerify(names(33, 51));
    tapFrame({ pid: "PLAY_STAGE_INFO", stageNo: "124" }, "rid-A");
    tapFrame(dealt(3, [7, 8]), "rid-A");
    for (let i = 0; i < 30; i++) {
      setFakeTime(time() + 0.25);
      tapVerify(names(33, 51));
    }
    eq("the frame showing the last hand's cards for 7.5 s after a new deal keeps the socket (live: 3.7 s let it go)", S.tapBound, "rid-A");
    eq("  ... and counts no disagreement", S.tapMismatch, 0);
    tapVerify(names(7, 8));
    eq("  ... then it shows the new hand's", S.tapBound, "rid-A");
    tapFrame(dealt(3, [7, 8]), "rid-A");
    tapVerify(names(33, 51));
    eq("a repeated deal frame is the same deal: the last hand is still one hand back", S.tapMismatch, 0);

    // ---- bound: cards NO socket dealt, sustained, let the socket go
    reset(2, 3);
    tapFrame(dealt(3, [33, 51]), "rid-A");
    tapVerify(names(33, 51));
    for (let i = 0; i < 7; i++) tapVerify(names(6, 19));
    eq("a few ticks of cards no socket dealt are ridden out", S.tapBound, "rid-A");
    tapVerify(names(6, 19));
    eq("  ... the 8th lets the socket go", S.tapBound, null);
    tapFrame({ pid: "PLAY_STAGE_INFO", stageNo: "125" }, "rid-A");
    tapFrame(dealt(3, [7, 8]), "rid-A");
    tapVerify(names(7, 8));
    eq("  ... and the socket can bind again on the cards (a let-go socket is not banned)", S.tapBound, "rid-A");
    tapVerify([]);
    eq("an empty read is not a disagreement", S.tapMismatch, 0);

    reset(2, 3);
    tapAccepts(dealt(3, [33, 51]), "rid-A");
    tapVerify(names(33, 51));
    for (let i = 0; i < 40; i++) {
      setFakeTime(time() + 0.5);
      tapVerify(["7c", "2d"], false);
    }
    eq("a frame the browser is not drawing is never held against the socket", [S.tapBound, S.tapMismatch], ["rid-A", 0]);

    // ---- bound: our frame shows the cards ANOTHER socket just dealt our seat — follow it, its hand whole
    reset(2, 4);
    tapAccepts(dealt(4, [18, 17]), "rid-A");
    tapVerify(names(18, 17));
    eq("bound to our table's socket", S.tapBound, "rid-A");
    S.wsDump = [];
    tapAccepts({ pid: "PLAY_STAGE_INFO", stageNo: "4920571386" }, "rid-C");
    tapAccepts({ pid: "CO_BLIND_INFO", seat: 1, bet: 2 }, "rid-C");
    tapAccepts(dealt(4, [29, 24]), "rid-C");
    tapAccepts({ pid: "PLAY_STAGE_INFO", stageNo: "4920571374" }, "rid-B");
    tapAccepts(dealt(4, [47, 8]), "rid-B");
    tapVerify(names(47, 8));
    eq("the table moved to a new socket: our frame shows ITS deal, so the capture follows it", S.tapBound, "rid-B");
    eq("  ... reading that hand whole, from its PLAY_STAGE_INFO", read(),
       [["rid-B", "PLAY_STAGE_INFO", true], ["rid-B", "CO_CARDTABLE_INFO", true]]);
    eq("  ... never the socket that dealt the same seat number other cards (2864.10681, 18:12:19)",
       S.wsDump.some((e) => e.rid === "rid-C"), false);
    eq("  ... whose frames are dropped from then on", tapAccepts(STAGE, "rid-C"), false);

    // ---- the DOM's seat numbering
    const DOM = { seatQa: [{ seat: 0, num: 1, me: false }, { seat: 2, num: 4, me: true }, { seat: 3, num: 6, me: false }] };
    eq("hero's seat is read as the client draws it", domHeroSeat(DOM), 4);
    eq("  ... not as the container index", domHeroSeat(DOM) !== 2, true);
    eq("no seat tagged as ours: None, never a guess", domHeroSeat({ seatQa: [{ seat: 0, num: 1 }] }), null);
    eq("  ... and an untagged capture is None too", domHeroSeat({}), null);
    eq("a seat with no drawn number is not a seat", domHeroSeat({ seatQa: [{ seat: 1, num: null, me: true }] }), null);
    reset(2, domHeroSeat(DOM));
    tapAccepts(dealt(2, [33, 51]), "rid-container");
    tapVerify(names(33, 51));
    eq("a socket dealing to the CONTAINER index does not bind", S.tapBound, null);
    tapAccepts(dealt(4, [33, 51]), "rid-felt");
    tapVerify(names(33, 51));
    eq("  ... the one dealing to the drawn seat does", S.tapBound, "rid-felt");

    const MINIS = { heroMini: [{ qa: "card33", x: 10, y: 8, w: 20 }, { qa: "card51", x: 32, y: 8, w: 20 }], seatQa: [], allCards: [] };
    delete process.env.TABLE_SLOT;
    eq("one table still reads the minis (they cover blind stretches)", heroCards(MINIS).length, 2);
    process.env.TABLE_SLOT = "2";
    eq("  ... several tables never do — no cards beats another table's cards", heroCards(MINIS), []);

    // the real thing: the 2026-09-21 session's own frames. Each wrapper's frame shows the cards ITS table dealt hero
    // (the table's own socket, 9240.618 = hero in seat 1, 9240.1035 = seat 3) a moment after the deal.
    const FIX = JSON.parse(readFileSync(join(paths().root, "tests", "fixtures", "multitable-ws-2026-09-21.json"), "utf8"));
    const FRAMES: any[] = FIX.frames;
    const BOUND_AT: Record<number, number> = {};
    const replay = (heroSeat: number, slot: number, own: string): [string | null, string[], string | null] => {
      reset(slot, heroSeat);
      FRAMES.forEach((f, i) => {
        const was = S.tapBound;
        tapFrame(f.d, f.rid);
        const up = f.d.pid === "CO_CARDTABLE_INFO" && f.rid === own ? faceUpSeats(f.d).get(heroSeat) : undefined;
        if (up) tapVerify(up);                                   // our frame draws the cards our table dealt
        if (was === null && S.tapBound !== null) BOUND_AT[heroSeat] = i;
      });
      const took = [...new Set(read().map(([r]) => String(r)))].sort();
      const firstRead = read()[0];
      return [S.tapBound, took, firstRead ? String(firstRead[1]) : null];
    };
    eq("the fixture really is two tables on one page", [...new Set(FRAMES.map((f) => f.rid))].sort(), ["9240.1035", "9240.618"]);
    const firstDeal = (rid: string, seat: number) => FRAMES.findIndex((f) => f.rid === rid && f.d.pid === "CO_CARDTABLE_INFO" && faceUpSeats(f.d).has(seat));
    const [boundA, tookA, firstA] = replay(1, 1, "9240.618");
    eq("the wrapper whose hero sits in seat 1 binds table 1's socket", boundA, "9240.618");
    eq("  ... and reads nothing of the other table", tookA, ["9240.618"]);
    eq("  ... binding at its first deal, the moment its frame shows the cards", BOUND_AT[1], firstDeal("9240.618", 1));
    eq("  ... and reading that hand from its PLAY_STAGE_INFO", firstA, "PLAY_STAGE_INFO");
    const [boundB, tookB, firstB] = replay(3, 2, "9240.1035");
    eq("the wrapper whose hero sits in seat 3 binds table 2's socket", boundB, "9240.1035");
    eq("  ... and reads nothing of the other table", tookB, ["9240.1035"]);
    eq("  ... binding at its first deal, the moment its frame shows the cards", BOUND_AT[3], firstDeal("9240.1035", 3));
    eq("  ... and reading that hand from its PLAY_STAGE_INFO", firstB, "PLAY_STAGE_INFO");
    eq("the two wrappers ended up on DIFFERENT sockets", boundA !== boundB, true);
  } finally {
    console.log = log0;
    realTime();
    if (slot0 === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = slot0;
    resetState();
  }
  expect(fails).toEqual([]);
});
