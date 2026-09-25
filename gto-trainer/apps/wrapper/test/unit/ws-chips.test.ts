/**
 * EVERY SEAT'S CHIPS AS THE WEBSOCKET REPORTS THEM (2026-09-25, round 3 of the input-mutation harness): ignition/ws.ts
 * wsChips → the /hand export's `wsStack` (chips behind now), `wsInFront` (this street's chips) and `wsDead` (a dead
 * blind), in BB. The API's capture gate checks `startStacks − wsStack` against the chips each seat's captured actions
 * put in, to the cent — so these numbers must be the table's own, whatever becomes of the action a frame carries.
 * Frames are scripted in the shapes debug/ws_dump.jsonl records (account = chips behind AFTER the frame; a raise's
 * `raise` is the chips ADDED; SPEED_INFO arrays are indexed by seat − 1).
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { S, resetState } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { handStateIgnition } from "../../src/ignition/hand";
import { archiveHand } from "../../src/archive";
import { scratchDirs } from "./helpers";

const obj = (m: Map<number, number> | undefined) => (m ? Object.fromEntries(m) : undefined);

/** $1/$2 (200 cents a BB), five dealt: SB 1, BB 2, UTG 3, hero CO 4, BTN 6. UTG opens to 2.5, hero calls, the BTN folds,
 *  both blinds call — a four-way flop. Stacks as dealt: 100 / 100 / 100 / 105 / 150 bb. */
function fourWayPreflop(): void {
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4920500001" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 6 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 19900, baseStakes: 0, btn: 2, bet: 100, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 19800, baseStakes: 0, btn: 4, bet: 200, dead: 0 });
  onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat3: [32896, 32896], seat4: [33, 51], seat6: [32896, 32896] });
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 4096, bet: 0, raise: 500, account: 19500 });   // UTG raises to 2.5
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 256, bet: 500, raise: 0, account: 20500 });    // hero calls 2.5
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 6, btn: 1024, bet: 0, raise: 0, account: 30000 });     // BTN folds
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 256, bet: 400, raise: 0, account: 19500 });    // SB calls 2
  onGameMsg({ pid: "CO_SELECT_INFO", seat: 2, btn: 256, bet: 300, raise: 0, account: 19500 });    // BB calls 1.5
}

function withHands(body: () => void): void {
  resetState();
  scratchDirs();
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try { body(); } finally { wsSeams.archiveHand = arch0; }
}

/** The chips each seat's exported actions put in (a call adds, a post/raise/bet/all-in is the street total). */
function lineChips(actions: any[]): Record<number, number> {
  const per = new Map<string, Map<number, number>>();
  for (const a of actions) {
    if (a.amount == null) continue;
    const m = per.get(a.street) ?? new Map<number, number>();
    per.set(a.street, m);
    m.set(a.seatId, a.type === "call" ? (m.get(a.seatId) ?? 0) + a.amount : Math.max(m.get(a.seatId) ?? 0, a.amount));
  }
  const out: Record<number, number> = {};
  for (const m of per.values()) for (const [s, v] of m) out[s] = Math.round(((out[s] ?? 0) + v) * 100) / 100;
  return out;
}

test("each dealt seat's chips behind and in front, off the frames — and stacks as dealt minus them is the line's money", () => {
  withHands(() => {
    fourWayPreflop();
    const h = handStateIgnition()!;
    expect(h).not.toBeNull();
    expect(obj(h.wsStack)).toEqual({ 1: 97.5, 2: 97.5, 3: 97.5, 4: 102.5, 6: 150 });
    expect(obj(h.wsInFront)).toEqual({ 1: 2.5, 2: 2.5, 3: 2.5, 4: 2.5, 6: 0 });
    expect(h.wsDead).toBeUndefined();
    expect(obj(h.startStacks)).toEqual({ 1: 100, 2: 100, 3: 100, 4: 105, 6: 150 });
    // the invariant the API's gate checks, seat by seat: dealt − behind now = what the captured line put in
    const line = lineChips(h.actions);
    for (const [s, start] of h.startStacks) expect(Math.round((start - h.wsStack.get(s)) * 100) / 100).toBe(line[s] ?? 0);
    // the existing fields are untouched
    expect(obj(h.committed)).toEqual({ 1: 2.5, 2: 2.5, 3: 2.5, 4: 2.5 });

    // the flop: this street's chips start again from nothing; the behind counts carry on
    onGameMsg({ pid: "CO_BCARD3_INFO", bcard: [6, 25, 26] });
    let f = handStateIgnition()!;
    expect(obj(f.wsInFront)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 });
    expect(obj(f.wsStack)).toEqual({ 1: 97.5, 2: 97.5, 3: 97.5, 4: 102.5, 6: 150 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 128, bet: 300, raise: 0, account: 19200 });    // SB bets 1.5
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 2, btn: 256, bet: 300, raise: 0, account: 19200 });    // BB calls
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 4096, bet: 0, raise: 900, account: 18600 });   // UTG raises to 4.5
    f = handStateIgnition()!;
    expect(obj(f.wsInFront)).toEqual({ 1: 1.5, 2: 1.5, 3: 4.5, 4: 0, 6: 0 });
    expect(obj(f.wsStack)).toEqual({ 1: 96, 2: 96, 3: 93, 4: 102.5, 6: 150 });
    const line2 = lineChips(f.actions);
    for (const [s, start] of f.startStacks) expect(Math.round((start - f.wsStack.get(s)) * 100) / 100).toBe(line2[s] ?? 0);
  });
});

test("a money frame whose ACTION the reader drops still moves the seat's chips — the gate sees what the line lost", () => {
  withHands(() => {
    fourWayPreflop();
    // the BTN's fold is on the WS; a call frame from that seat now is dropped by the ghost guard (a folded seat cannot
    // act) — the line keeps "BTN folds", the table says 2.5bb left the stack: exactly the contradiction to refuse on
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 6, btn: 256, bet: 500, raise: 0, account: 29500 });
    const h = handStateIgnition()!;
    expect(h.actions.filter((a: any) => a.seatId === 6).map((a: any) => a.type)).toEqual(["fold"]);
    expect(h.wsStack.get(6)).toBe(147.5);
    expect(h.wsInFront.get(6)).toBe(2.5);
    expect(obj(h.committed)).toEqual({ 1: 2.5, 2: 2.5, 3: 2.5, 4: 2.5 });   // the action ledger never saw it
  });
});

test("a seat whose money the DOM filed ahead of any frame is left out until its next frame (unknown, not a discrepancy)", () => {
  withHands(() => {
    fourWayPreflop();
    onGameMsg({ pid: "CO_BCARD3_INFO", bcard: [6, 25, 26] });
    // reader.ts's backfill filed "Seat 1 bets" off the chips on screen; the WS frame has not arrived yet
    S.ws.wsStale.add(1);
    let h = handStateIgnition()!;
    expect(h.wsStack.has(1)).toBe(false);
    expect(h.wsInFront.has(1)).toBe(false);
    expect(h.wsStack.get(2)).toBe(97.5);
    // …the frame lands (the dedupe keeps the DOM's action; the chips are the table's): back in the export
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 128, bet: 300, raise: 0, account: 19200 });
    h = handStateIgnition()!;
    expect(h.wsStack.get(1)).toBe(96);
    expect(h.wsInFront.get(1)).toBe(1.5);
  });
});

test("a dead blind is exported apart: out of the stack, in no bet", () => {
  withHands(() => {
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "1" });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 4 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 4375, btn: 2, bet: 10, dead: 0 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 2450, btn: 4, bet: 25, dead: 25 });     // BB + a dead 25
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [33, 51], seat3: [32896, 32896], seat4: [32896, 32896] });
    const h = handStateIgnition()!;
    expect(h.wsDead.get(2)).toBe(1);
    expect(h.wsInFront.get(2)).toBe(1);
    expect(h.startStacks.get(2)).toBe(100);
    expect(h.wsStack.get(2)).toBe(98);                      // 100 − 1 live − 1 dead
    expect(h.wsDead.has(1)).toBe(false);
  });
});

test("the 5c stake: a 2-cent small blind is 0.4bb, a complete 0.6bb, exact to four places", () => {
  withHands(() => {
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "2" });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 4, account: 498, btn: 2, bet: 2, dead: 0 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 495, btn: 4, bet: 5, dead: 0 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat3: [32896, 32896], seat4: [32896, 32896], seat5: [30, 44] });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 1024, bet: 0, raise: 0, account: 700 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 256, bet: 3, raise: 0, account: 495 });   // SB completes
    const h = handStateIgnition()!;
    expect(obj(h.wsInFront)).toEqual({ 3: 0, 4: 1, 5: 1 });
    expect(obj(h.wsStack)).toEqual({ 3: 140, 4: 99, 5: 99 });
    expect(h.startStacks.get(4)).toBe(100);
  });
});

test("no WebSocket money, no fields: a DOM-only or authored hand exports none of them", () => {
  withHands(() => {
    Object.assign(S.ws, { heroSeat: 2, dealt: [1, 2, 3], heroDealt: true, dealer: 3, bb: 200, bbSeen: true,
                          actions: [{ seat: 1, type: "post-sb", cents: 100, street: "preflop" }, { seat: 2, type: "post-bb", cents: 200, street: "preflop" }],
                          committed: new Map([[1, 100], [2, 200]]), board: [], heroCards: ["A♠", "K♠"] });
    S.handNo = 5;
    Object.assign(S.feedPrev, { seated: true, seats: new Map() });
    const h = handStateIgnition()!;
    expect(h).not.toBeNull();
    expect("wsStack" in h || "wsInFront" in h || "wsDead" in h).toBe(false);
    // …and in fake-table mode, not even a previous real hand's counts
    fourWayPreflop();
    S.fakeMode = true;
    const f = handStateIgnition()!;
    expect("wsStack" in f || "wsInFront" in f).toBe(false);
  });
});

test("the archived row does not carry them: end-of-hand chip counts would read as a lost action against any earlier cut", () => {
  resetState();
  scratchDirs();
  fourWayPreflop();
  S.session.id = null;
  Object.assign(S.feedPrev, { seated: true, seats: new Map() });
  expect(handStateIgnition()!.wsStack).toBeDefined();
  archiveHand();
  const c = new Database(join(process.env.WRAPPER_DATA_DIR!, "hands.db"));
  try {
    const row = c.query("select data from hands").get() as { data: string } | null;
    expect(row).not.toBeNull();
    const data = JSON.parse(row!.data);
    expect(data.startStacks).toEqual({ 1: 100, 2: 100, 3: 100, 4: 105, 6: 150 });
    expect("wsStack" in data || "wsInFront" in data || "wsDead" in data).toBe(false);
  } finally {
    c.close();
  }
});
