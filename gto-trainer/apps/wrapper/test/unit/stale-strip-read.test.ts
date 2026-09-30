/**
 * A STRIP READING THE READER STOPPED REFRESHING IS NO EVIDENCE OF THE BUTTONS (2026-09-30, hand 4921602992). The
 * reader's tick stood down early for four minutes ("table broke — waiting for a new table…" on a chat line that
 * stayed on screen) and liveStatus.toAct stayed TRUE from the moment hero had been on the clock. hand.ts let the
 * buttons win over the socket's action-on, so every action count of every hand went out as hero's turn: phantom
 * solves held the API's slot and hero timed out facing a jam. Now the reader stamps S.screenReadAt when it reads the
 * strip, and toActSources counts the buttons only while that stamp is fresh.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime } from "../../src/clock";
import { BUTTONS_STALE_S, screenReadAgeS, toActSources } from "../../src/ignition/hand";
import { S, resetState } from "../../src/state";

test("buttons count while the strip was read this tick, and stop counting once the reading is stale", () => {
  resetState();
  try {
    setFakeTime(1000);
    S.handNo = 5;
    S.ws.heroSeat = 5;
    S.ws.actionOn = 2;                                 // the socket: the BB is on the clock
    S.liveStatus.toAct = true;                         // the strip as last read: hero's buttons up

    S.screenReadAt = 1000;                             // read this tick
    expect(screenReadAgeS()).toBe(0);
    let src = toActSources(!!S.liveStatus.toAct);
    expect(src.buttons).toBe(true);
    expect(src.buttonsStaleS).toBeUndefined();

    setFakeTime(1000 + BUTTONS_STALE_S + 1);           // the reader stood down for a while
    src = toActSources(!!S.liveStatus.toAct);
    expect(src.buttons).toBe(false);                   // the frozen TRUE is not hero's turn
    expect(src.buttonsStaleS).toBe(BUTTONS_STALE_S + 1);
    expect(src.ws).toBe(false);
    expect(src.actionOn).toBe(false);

    S.screenReadAt = 1000 + BUTTONS_STALE_S + 1;       // the reader is back
    src = toActSources(!!S.liveStatus.toAct);
    expect(src.buttons).toBe(true);
  } finally {
    realTime();
  }
});

test("a reading never stamped counts as fresh (replays from before the stamp, tests that set toAct by hand)", () => {
  resetState();
  try {
    setFakeTime(5000);
    S.screenReadAt = null;
    expect(screenReadAgeS()).toBeNull();
    expect(toActSources(true).buttons).toBe(true);
    expect(toActSources(false).buttons).toBe(false);
  } finally {
    realTime();
  }
});
