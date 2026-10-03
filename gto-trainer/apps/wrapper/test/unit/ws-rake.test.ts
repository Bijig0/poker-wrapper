/**
 * IGNITION'S OWN RAKE (2026-10-03, Brady: "on the flop we will read 4bb, when … the amount after rake is 3.8 and that is
 * the amount we are actually playing for"): CO_CHIPTABLE_INFO carries curRake — the rake taken so far, in cents — beside
 * curPot (the GROSS pot). ignition/ws.ts keeps it (S.ws.rakeCents, and per street entered in S.ws.rakeByStreet); the
 * /hand export carries currentNode.potRake and `rake` { bb, byStreet }, which the archive keeps.
 * The frames are hand 4922314918 as debug/ws_dump.jsonl recorded it (NL5, 5 cents a BB): BTN hero raises 2.6, BB calls;
 * the flop sweep is 28c with 1c rake, the turn 28c/1c, the river 38c/1c; on the river hero shoves, the BB is all-in for
 * 0.27, 10.89 comes back, and the last sweep is 284c with 14c rake — the 270c Ignition paid hero (CO_POT_INFO returnHi).
 */
import { expect, test } from "bun:test";
import { resetState } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { handStateIgnition } from "../../src/ignition/hand";
import { scratchDirs } from "./helpers";

const FRAMES: any[] = [
  {"pid":"PLAY_STAGE_INFO","stageNo":"4922314918"},
  {"seat":4,"pid":"CO_DEALER_SEAT"},
  {"seat":4,"pid":"CO_DEALER_SEAT"},
  {"pid":"CO_BLIND_INFO","seat":5,"account":658,"baseStakes":0,"btn":2,"bet":2,"dead":0},
  {"pid":"CO_BLIND_INFO","seat":6,"account":136,"baseStakes":0,"btn":4,"bet":5,"dead":0},
  {"pid":"CO_CARDTABLE_INFO","seat1":[32896,32896],"seat2":[32896,32896],"seat3":[32896,32896],"seat4":[23,21],"seat5":[32896,32896],"seat6":[32896,32896]},
  {"pid":"CO_SELECT_INFO","seat":1,"btn":1024,"bet":0,"raise":0,"account":407},
  {"pid":"CO_SELECT_INFO","seat":2,"btn":1024,"bet":0,"raise":0,"account":562},
  {"pid":"CO_SELECT_INFO","seat":3,"btn":1024,"bet":0,"raise":0,"account":281},
  {"pid":"CO_SELECT_INFO","seat":4,"btn":512,"bet":5,"raise":13,"account":1217},
  {"pid":"CO_SELECT_INFO","seat":5,"btn":1024,"bet":0,"raise":0,"account":658},
  {"pid":"CO_SELECT_INFO","seat":6,"btn":256,"bet":8,"raise":0,"account":128},
  {"pid":"CO_CHIPTABLE_INFO","seat":0,"potCount":0,"curPot":[28],"curRake":[1]},
  {"bcard":[30,17,32],"pid":"CO_BCARD3_INFO"},
  {"pid":"CO_SELECT_INFO","seat":6,"btn":64,"bet":0,"raise":0,"account":128},
  {"pid":"CO_SELECT_INFO","seat":4,"btn":64,"bet":0,"raise":0,"account":1217},
  {"pid":"CO_CHIPTABLE_INFO","seat":0,"potCount":0,"curPot":[28],"curRake":[1]},
  {"pos":4,"card":22,"pid":"CO_BCARD1_INFO"},
  {"pid":"CO_SELECT_INFO","seat":6,"btn":128,"bet":5,"raise":0,"account":123},
  {"pid":"CO_SELECT_INFO","seat":4,"btn":256,"bet":5,"raise":0,"account":1212},
  {"pid":"CO_CHIPTABLE_INFO","seat":0,"potCount":0,"curPot":[38],"curRake":[1]},
  {"pos":5,"card":14,"pid":"CO_BCARD1_INFO"},
  {"pid":"CO_SELECT_INFO","seat":6,"btn":128,"bet":96,"raise":0,"account":27},
  {"pid":"CO_SELECT_INFO","seat":4,"btn":4096,"bet":96,"raise":1212,"account":0},
  {"pid":"CO_SELECT_INFO","seat":6,"btn":2048,"bet":27,"raise":0,"account":0},
  {"pid":"CO_CHIPTABLE_INFO","returnBet":1089,"seat":4,"potCount":1,"curPot":[284],"curRake":[14]},
  {"pid":"CO_PCARD_INFO","type":0,"seat":4,"card":[23,21]},
  {"pid":"CO_RESULT_INFO","account":[407,562,281,1359,658,0,0,0,0],"handHi4":[0,5,1,3,6]},
  {"pid":"CO_POT_INFO","kicker":0,"kickerCard":[0,0,0,0,0,0,0,0,0],"potNo":0,"returnHi":[0,0,0,270,0,0,0,0,0],"returnLo":[0,0,0,0,0,0,0,0,0]},
  {"seat":4,"pid":"CO_DEALER_SEAT"},
];

function play(upTo: (f: any) => boolean): any {
  resetState();
  scratchDirs();
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    for (const f of FRAMES) { onGameMsg(f); if (upTo(f)) break; }
    return handStateIgnition();
  } finally { wsSeams.archiveHand = arch0; }
}

test("the flop's pot carries the rake Ignition took from it", () => {
  const h = play((f) => f.pid === "CO_BCARD3_INFO");
  expect(h.currentNode.pot).toBe(5.6);
  expect(h.currentNode.potRake).toBe(0.2);
  expect(h.rake).toEqual({ bb: 0.2, byStreet: { flop: 0.2 } });
});

test("each street entered keeps its rake; the hand's last sweep is the rake on the award", () => {
  const h = play(() => false);
  expect(h.rake.byStreet).toEqual({ flop: 0.2, turn: 0.2, river: 0.2, end: 2.8 });
  expect(h.rake.bb).toBe(2.8);
  // gross 284c less 14c rake = the 270c award
  expect(h.currentNode.pot - h.currentNode.potRake).toBeCloseTo(54, 6);
});

test("no rake before the first sweep — nothing is exported", () => {
  const h = play((f) => f.pid === "CO_SELECT_INFO" && f.seat === 4);
  expect(h.rake).toBeUndefined();
  expect(h.currentNode.potRake).toBeUndefined();
});
