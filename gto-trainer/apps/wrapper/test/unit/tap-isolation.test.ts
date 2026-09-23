/**
 * Port of tests/test_tap_isolation.py — one page holds up to four tables, so the tap sees every table's frames;
 * ours is isolated by socket. Single table: bind on hero's face-up cards. Multi-table: bind on the socket dealing
 * into OUR seat (or whose buy-in / sit-in names it), hold and replay until then, drop another table's frames,
 * let go of a mis-bind — and the real 2026-09-21 two-table frames split cleanly between two wrappers.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/env";
import { S, TupleSet, resetState } from "../../src/state";
import { cardName, domHeroSeat, heroCards } from "../../src/ignition/dom";
import { tapAccepts, tapTakeReplay, tapUnbind, tapVerify } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const FACE_DOWN = 32896;
const OURS = { pid: "CO_CARDTABLE_INFO", seat1: [FACE_DOWN, FACE_DOWN], seat2: [33, 51] };
const THEIRS = { pid: "CO_CARDTABLE_INFO", seat1: [FACE_DOWN, FACE_DOWN], seat3: [FACE_DOWN, FACE_DOWN] };
const STAGE = { pid: "PLAY_STAGE_INFO", stageNo: "123" };

function reset(slot: number | null = null, heroSeat: number | null = null) {
  Object.assign(S, {
    tapBound: null, tapForeign: 0, tapHeld: 0, tapMismatch: 0, tapSeen: new Map(), tapDealt: new Map(), tapClaims: new Map(),
    tapRejected: new Set(), tapHold: new Map(), tapReplay: [], tapDomCards: [], tapAmbiguousSaid: new TupleSet(),
    tapStall: { since: null, said: false },
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

test("tap socket isolation", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  scratchDirs();
  resetState();
  const slot0 = process.env.TABLE_SLOT;
  const log0 = console.log;
  console.log = () => {};
  try {
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

    const OURS_3 = dealt(3, [33, 51]);
    const OTHER_1 = dealt(1, [25, 34]);
    reset(2, 3);
    eq("a socket dealing into ANOTHER seat does not bind us", tapAccepts(OTHER_1, "rid-B") || S.tapBound, null);
    eq("  ... and its frames are not taken in the meantime", tapAccepts(STAGE, "rid-B"), false);
    tapAccepts(OURS_3, "rid-A");
    eq("the socket dealing into OUR seat binds", S.tapBound, "rid-A");
    eq("  ... ours is accepted", tapAccepts(STAGE, "rid-A"), true);
    eq("  ... and the other table is dropped", tapAccepts(STAGE, "rid-B"), false);

    reset(2, 3);
    eq("a frame from an unidentified socket is dropped", tapAccepts(STAGE, "rid-B"), false);
    eq("  ... and counted as held", S.tapHeld, 1);
    eq("  ... including the other table's deal", tapAccepts(OTHER_1, "rid-B"), false);
    eq("  ... so nothing of another table's hand is ever read", S.tapBound, null);

    const BUYIN_3 = { pid: "PLAY_BUYIN_INFO", type: 1, seat: 3, displayMax: 20000, account: 7437 };
    const BUYIN_1 = { pid: "PLAY_BUYIN_INFO", type: 1, seat: 1, displayMax: 20000, account: 7437 };
    const SIT_3 = { pid: "CO_SIT_PLAY", play: 1, seat: 3 };
    const CASH_3 = { pid: "PLAY_ACCOUNT_CASH_RES", type: 2, seat: 3, cash: 2500 };
    const SEAT_3 = { pid: "PLAY_SEAT_INFO", type: 1, seat: 3, nickName: "x" };
    const BLINDS = { pid: "CO_BLIND_INFO", seat: 1, bet: 10 };
    reset(2, 3);
    tapAccepts(BUYIN_1, "rid-B");
    eq("the other table's buy-in (another seat) does not bind us", S.tapBound, null);
    tapAccepts(CASH_3, "rid-B");
    tapAccepts(SEAT_3, "rid-B");
    eq("broadcast seat frames naming our seat do not bind", S.tapBound, null);
    tapAccepts(BUYIN_3, "rid-A");
    eq("OUR buy-in, naming our seat, binds before any card is dealt", S.tapBound, "rid-A");
    eq("  ... and hands the held frame back for reading", tapTakeReplay().map((f) => f.pid), ["PLAY_BUYIN_INFO"]);
    eq("  ... once", tapTakeReplay(), []);
    reset(2, 3);
    tapAccepts(SIT_3, "rid-A");
    eq("our sit-in toggle binds too", S.tapBound, "rid-A");

    reset(2, null);
    tapAccepts({ pid: "PLAY_STAGE_INFO", stageNo: "old" }, "rid-A");
    tapAccepts(BLINDS, "rid-A");
    tapAccepts(STAGE, "rid-A");
    tapAccepts(BLINDS, "rid-A");
    tapAccepts(STAGE, "rid-B");
    tapAccepts(BLINDS, "rid-B");
    eq("nothing binds without our seat", S.tapBound, null);
    S.liveStatus.heroSeatDom = 3;
    const took = tapAccepts(OURS_3, "rid-A");
    eq("the deal binds", S.tapBound, "rid-A");
    eq("  ... the binding frame itself comes back through replay, not twice", took, false);
    eq("  ... replay = OUR socket's hand from its PLAY_STAGE_INFO, in order", tapTakeReplay().map((f) => [f.pid, f.stageNo ?? null]),
       [["PLAY_STAGE_INFO", "123"], ["CO_BLIND_INFO", null], ["CO_CARDTABLE_INFO", null]]);
    eq("  ... and the other table's held frames are gone", S.tapHold.size, 0);

    reset(2, 3);
    S.liveStatus.heroSeatDom = null;
    tapAccepts(BUYIN_3, "rid-A");
    tapAccepts(BUYIN_3, "rid-B");
    S.liveStatus.heroSeatDom = 3;
    tapAccepts(STAGE, "rid-B");
    eq("two sockets name our seat: stay unbound", S.tapBound, null);
    tapAccepts(dealt(3, [7, 8]), "rid-B");
    tapAccepts(dealt(3, [33, 51]), "rid-A");
    eq("  ... still unbound until our own frame shows its cards", S.tapBound, null);
    tapVerify([cardName("card33")!, cardName("card51")!]);
    tapAccepts(STAGE, "rid-B");
    eq("  ... then the socket that dealt THOSE cards binds", S.tapBound, "rid-A");

    reset(2, 3);
    tapAccepts(BUYIN_3, "rid-A");
    tapUnbind("test");
    tapAccepts(STAGE, "rid-A");
    eq("a socket let go for dealing the wrong cards is not re-bound on its claim", S.tapBound, null);

    reset(null);
    eq("one table still accepts while it looks", tapAccepts(STAGE, "rid-B"), true);
    tapAccepts(OURS, "rid-A");
    eq("  ... and still binds on any face-up hand", S.tapBound, "rid-A");

    reset(2, null);
    tapAccepts(OURS_3, "rid-A");
    eq("the DOM has not named our seat: nothing binds on a guess", S.tapBound, null);
    eq("  ... and nothing is read", tapAccepts(STAGE, "rid-A"), false);
    S.liveStatus.heroSeatDom = 3;
    tapAccepts(OURS_3, "rid-A");
    eq("  ... it binds as soon as the DOM says which seat is hero's", S.tapBound, "rid-A");

    reset(2, 3);
    tapAccepts(OURS_3, "rid-A");
    S.ws.heroCards = ["Ah", "Ad"];
    for (let i = 0; i < 8 - 1; i++) tapVerify(["7c", "2d"]);
    eq("a few disagreeing ticks are ridden out (the DOM lags a fresh deal)", S.tapBound, "rid-A");
    tapVerify(["7c", "2d"]);
    eq("  ... sustained disagreement lets the socket go", S.tapBound, null);
    tapAccepts(OURS_3, "rid-A");
    eq("  ... and it can bind again", S.tapBound, "rid-A");
    tapVerify(["Ah", "Ad"]);
    S.ws.heroCards = ["Ah", "Ad"];
    tapVerify(["Ad", "Ah"]);
    eq("agreement in any order resets the counter", S.tapMismatch, 0);
    tapVerify([]);
    eq("  ... and an empty read is not a disagreement", S.tapMismatch, 0);

    const DOM = { seatQa: [{ seat: 0, num: 1, me: false }, { seat: 2, num: 4, me: true }, { seat: 3, num: 6, me: false }] };
    eq("hero's seat is read as the client draws it", domHeroSeat(DOM), 4);
    eq("  ... not as the container index", domHeroSeat(DOM) !== 2, true);
    eq("no seat tagged as ours: None, never a guess", domHeroSeat({ seatQa: [{ seat: 0, num: 1 }] }), null);
    eq("  ... and an untagged capture is None too", domHeroSeat({}), null);
    eq("a seat with no drawn number is not a seat", domHeroSeat({ seatQa: [{ seat: 1, num: null, me: true }] }), null);
    reset(2, domHeroSeat(DOM));
    tapAccepts(dealt(2, [33, 51]), "rid-container");
    eq("a socket dealing to the CONTAINER index does not bind", S.tapBound, null);
    tapAccepts(dealt(4, [33, 51]), "rid-felt");
    eq("  ... the one dealing to the drawn seat does", S.tapBound, "rid-felt");

    const MINIS = { heroMini: [{ qa: "card33", x: 10, y: 8, w: 20 }, { qa: "card51", x: 32, y: 8, w: 20 }], seatQa: [], allCards: [] };
    delete process.env.TABLE_SLOT;
    eq("one table still reads the minis (they cover blind stretches)", heroCards(MINIS).length, 2);
    process.env.TABLE_SLOT = "2";
    eq("  ... several tables never do — no cards beats another table's cards", heroCards(MINIS), []);

    // the real thing: the 2026-09-21 session's own frames
    const FIX = JSON.parse(readFileSync(join(paths().root, "tests", "fixtures", "multitable-ws-2026-09-21.json"), "utf8"));
    const FRAMES: any[] = FIX.frames;
    const BOUND_AT: Record<number, number> = {};
    const replay = (heroSeat: number, slot: number): [string | null, string[]] => {
      reset(slot, heroSeat);
      const took = new Map<string | null, number>();
      FRAMES.forEach((f, i) => {
        const was = S.tapBound;
        if (tapAccepts(f.d, f.rid)) took.set(f.rid, (took.get(f.rid) || 0) + 1);
        took.set(S.tapBound, (took.get(S.tapBound) || 0) + tapTakeReplay().length);
        if (was === null && S.tapBound !== null) BOUND_AT[heroSeat] = i;
      });
      return [S.tapBound, [...took].filter(([, n]) => n > 0).map(([k]) => String(k)).sort()];
    };
    eq("the fixture really is two tables on one page", [...new Set(FRAMES.map((f) => f.rid))].sort(), ["9240.1035", "9240.618"]);
    const [boundA, tookA] = replay(1, 1);
    eq("the wrapper whose hero sits in seat 1 binds table 1's socket", boundA, "9240.618");
    eq("  ... and reads nothing of the other table", tookA, ["9240.618"]);
    const [boundB, tookB] = replay(3, 2);
    eq("the wrapper whose hero sits in seat 3 binds table 2's socket", boundB, "9240.1035");
    eq("  ... and reads nothing of the other table", tookB, ["9240.1035"]);
    eq("the two wrappers ended up on DIFFERENT sockets", boundA !== boundB, true);
    eq("table 1 binds on its buy-in, long before its first deal", BOUND_AT[1], 10);
    eq("table 2 binds on its buy-in, long before its first deal", BOUND_AT[3], 23);
  } finally {
    console.log = log0;
    if (slot0 === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = slot0;
    resetState();
  }
  expect(fails).toEqual([]);
});
