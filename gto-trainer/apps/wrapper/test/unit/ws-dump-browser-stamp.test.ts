/**
 * WHEN THE BROWSER GOT THE FRAME (2026-10-04, ignition/ws.ts dumpBegin `bts`). The dump's `ts` is our own clock when
 * this process read the frame; Chrome's own stamp on Network.webSocketFrameReceived is kept beside it, so a seat's time
 * to act can be taken off the browser's clock. A frame HELD while no socket was bound is written at the replay —
 * seconds later by `ts` — and must still carry the stamp it arrived with.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig, wsDumpPath } from "../../src/config";
import { S, TupleSet, resetState } from "../../src/state";
import { cardName } from "../../src/ignition/dom";
import { tapFrame, tapVerify, wsSeams } from "../../src/ignition/ws";
import { scratchDirs } from "./helpers";

const T0 = 1_790_334_700;
const FACE_DOWN = 32896;
const stage = (id: string) => ({ pid: "PLAY_STAGE_INFO", stageNo: id });
const deal = (seat: number, a: number, b: number) => ({ pid: "CO_CARDTABLE_INFO", [`seat${seat}`]: [a, b], seat2: [FACE_DOWN, FACE_DOWN] });
const dumped = () => readFileSync(wsDumpPath(), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));

function withTable(slot: number | null, run: () => void) {
  const s0 = process.env.TABLE_SLOT, c0 = process.env.TABLE_COUNT;
  const archive0 = wsSeams.archiveHand;
  const log0 = console.log;
  try {
    if (slot === null) {
      delete process.env.TABLE_SLOT;
      delete process.env.TABLE_COUNT;
    } else {
      process.env.TABLE_SLOT = String(slot);
      process.env.TABLE_COUNT = "4";
    }
    scratchDirs("ws-browser-stamp-");
    resetState();
    reloadConfig();
    setFakeTime(T0);
    wsSeams.archiveHand = () => {};
    console.log = () => {};
    run();
  } finally {
    console.log = log0;
    wsSeams.archiveHand = archive0;
    realTime();
    if (s0 === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = s0;
    if (c0 === undefined) delete process.env.TABLE_COUNT;
    else process.env.TABLE_COUNT = c0;
    reloadConfig();
  }
}

test("a frame is dumped with the browser's own stamp; one that came without it has none", () => {
  withTable(null, () => {
    tapFrame(stage("4922314918"), "T", 81234.5678904321);
    tapFrame({ pid: "CO_DEALER_SEAT", seat: 4 }, "T");
    const [a, b] = dumped().filter((e) => !String(e.pid).startsWith("<"));
    expect(a.pid).toBe("PLAY_STAGE_INFO");
    expect(a.bts).toBe(81234.567890);
    expect(a.ts).toBe(T0);
    expect(a.data).toEqual(stage("4922314918"));
    expect("bts" in b).toBe(false);
  });
});

test("a frame held while no socket was bound keeps the stamp it arrived with", () => {
  withTable(1, () => {
    S.liveStatus.heroSeatDom = 4;
    Object.assign(S, { tapHist: new Map(), tapDeals: new Map(), tapRejected: new Set(), tapClaims: new Map(), tapHold: new Map(),
                       tapDomCards: [], tapAmbiguousSaid: new TupleSet(), tapPrevHero: [], tapDealtAt: 0.0, handAbandoned: null });
    tapFrame(stage("4920571310"), "T", 500.25);
    tapFrame(deal(4, 18, 17), "T", 500.75);
    expect(S.tapBound).toBe(null);
    // our frame shows the cards that socket dealt our seat, three seconds on: it binds and the held hand is read
    setFakeTime(time() + 3);
    for (let i = 0; i < 4 && S.tapBound === null; i++) {
      setFakeTime(time() + 0.25);
      tapVerify([cardName("card18")!, cardName("card17")!]);
    }
    expect(S.tapBound).toBe("T");
    const replayed = dumped().filter((e) => e.replayed);
    expect(replayed.map((e) => [e.pid, e.bts])).toEqual([["PLAY_STAGE_INFO", 500.25], ["CO_CARDTABLE_INFO", 500.75]]);
    expect(replayed.every((e) => e.ts >= T0 + 3)).toBe(true);
  });
});
