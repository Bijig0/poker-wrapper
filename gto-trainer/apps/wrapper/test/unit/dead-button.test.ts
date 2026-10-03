/**
 * IGNITION'S DEAD BUTTON (2026-10-04, hands 4922299303 / 4922296152 of 2026-10-03, table 2). CO_DEALER_SEAT can name a
 * seat CO_CARDTABLE_INFO did not deal — the player due the button left or sits out. Positions used to count that seat
 * and label it BTN, so the real last seat (hero's, in both hands) read CO and the 6-max chart answered the wrong node.
 * Positions now come from the seats DEALT (hand.ts buttonOrder), and the hand records its seat roster (seatRoster,
 * roster.ts). The frames in the second half are the hands' own, verbatim from wrapper-debug/ws_dump-2.jsonl.1.
 */
import { expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { buttonOrder, handStateIgnition, heroPosition, positionsAll, seatRoster } from "../../src/ignition/hand";
import { undealtStatus } from "../../src/ignition/roster";
import { J, scratchDirs } from "./helpers";

function state(dealt: number[], dealer: number, hero: number, posts: [number, string, number][]) {
  S.ws = { bb: 5, bbSeen: true, board: [], pot: null, dealt: [...dealt], dealer, heroSeat: hero,
           actions: posts.map(([s, t, c]) => ({ seat: s, type: t, cents: c, street: "preflop" })) };
}
const sorted = (m: Map<number, string>) => J([...m].sort((a, b) => a[0] - b[0]));
const map = (o: Record<number, string>) => J(Object.entries(o).map(([k, v]) => [Number(k), v]).sort((a, b) => (a[0] as number) - (b[0] as number)));

test("buttonOrder: the dealt seats from the first one after the dealer; a dealt dealer is last", () => {
  expect(buttonOrder([1, 2, 3, 5, 6], 4)).toEqual({ order: [5, 6, 1, 2, 3], deadButton: true });
  expect(buttonOrder([1, 3, 5, 6], 4)).toEqual({ order: [5, 6, 1, 3], deadButton: true });
  expect(buttonOrder([1, 2, 3], 6)).toEqual({ order: [1, 2, 3], deadButton: true });           // wraps past the top seat
  expect(buttonOrder([1, 2, 3, 4, 5, 6], 3)).toEqual({ order: [4, 5, 6, 1, 2, 3], deadButton: false });
  // one dealt seat is no hand (the Python recorder's partial states): the old rule, the dealer counted
  expect(buttonOrder([1], 2)).toEqual({ order: [1, 2], deadButton: false });
});

test("a dead button: the dealt seats take the LATEST names, hero on the real last seat is the BTN", () => {
  resetState();
  // five dealt (4922299303's table): SB/BB/HJ/CO/BTN — the chart walk pads UTG as the fold, as at any five-handed table
  const five: Record<number, [string, string]> = { 5: ["SB", "SB"], 6: ["BB", "BB"], 1: ["HJ", "UTG"], 2: ["CO", "CO"], 3: ["BTN", "BTN"] };
  for (const [hero, [name, panel]] of Object.entries(five)) {
    state([1, 2, 3, 5, 6], 4, Number(hero), [[5, "post-sb", 2], [6, "post-bb", 5]]);
    expect(sorted(positionsAll())).toBe(map({ 5: "SB", 6: "BB", 1: "HJ", 2: "CO", 3: "BTN" }));
    expect(positionsAll().get(Number(hero))).toBe(name);
    expect(heroPosition()).toBe(panel);   // the panel's vocabulary (UTG for a five-handed table's first seat, as before)
  }
  // four dealt (4922296152's table): SB/BB/CO/BTN
  const four: Record<number, string> = { 5: "SB", 6: "BB", 1: "CO", 3: "BTN" };
  for (const [hero, name] of Object.entries(four)) {
    state([1, 3, 5, 6], 4, Number(hero), [[5, "post-sb", 2], [6, "post-bb", 5]]);
    expect(sorted(positionsAll())).toBe(map(four));
    expect(heroPosition()).toBe(name);
  }
  // three dealt: SB/BB/BTN (the AI piece's table)
  for (const [hero, name] of Object.entries({ 5: "SB", 1: "BB", 3: "BTN" })) {
    state([1, 3, 5], 4, Number(hero), [[5, "post-sb", 2], [1, "post-bb", 5]]);
    expect(sorted(positionsAll())).toBe(map({ 5: "SB", 1: "BB", 3: "BTN" }));
    expect(heroPosition()).toBe(name);
  }
  // six dealt with the button dead (a nine-seat table): SB/BB/UTG/HJ/CO/BTN
  for (const [hero, [name, panel]] of Object.entries({ 5: ["SB", "SB"], 6: ["BB", "BB"], 7: ["UTG", "UTG"], 1: ["HJ", "UTG+1"], 2: ["CO", "CO"], 3: ["BTN", "BTN"] })) {
    state([1, 2, 3, 5, 6, 7], 4, Number(hero), [[5, "post-sb", 2], [6, "post-bb", 5]]);
    expect(sorted(positionsAll())).toBe(map({ 5: "SB", 6: "BB", 7: "UTG", 1: "HJ", 2: "CO", 3: "BTN" }));
    expect(heroPosition()).toBe(panel);
    expect(positionsAll().get(Number(hero))).toBe(name);
  }
});

test("a dead button AND a dead small blind (4920414398, 4922316006): BB, then the late names", () => {
  resetState();
  for (const [hero, name] of Object.entries({ 4: "BB", 5: "CO", 6: "BTN" })) {
    state([4, 5, 6], 1, Number(hero), [[4, "post-bb", 5]]);
    expect(sorted(positionsAll())).toBe(map({ 4: "BB", 5: "CO", 6: "BTN" }));
    expect(heroPosition()).toBe(name);
  }
  state([1, 2, 6], 4, 2, [[6, "post-bb", 5]]);
  expect(sorted(positionsAll())).toBe(map({ 6: "BB", 1: "CO", 2: "BTN" }));
  expect(heroPosition()).toBe("BTN");
  // four dealt, both dead: BB/HJ/CO/BTN — the same names a dead small blind alone gives four dealt
  state([1, 2, 3, 6], 4, 3, [[6, "post-bb", 5]]);
  expect(sorted(positionsAll())).toBe(map({ 6: "BB", 1: "HJ", 2: "CO", 3: "BTN" }));
});

test("heads-up with a dead button: the small blind is the seat that posted it", () => {
  resetState();
  state([2, 5], 3, 5, [[5, "post-sb", 2], [2, "post-bb", 5]]);
  expect(sorted(positionsAll())).toBe(map({ 5: "SB", 2: "BB" }));
  expect(heroPosition()).toBe("SB");
  state([2, 5], 3, 2, [[5, "post-sb", 2], [2, "post-bb", 5]]);
  expect(heroPosition()).toBe("BB");
  // a live button heads-up is unchanged: the dealer posts the small blind
  state([2, 5], 5, 2, []);
  expect(sorted(positionsAll())).toBe(map({ 5: "SB", 2: "BB" }));
});

test("a dealt dealer is named exactly as before (no dead button)", () => {
  resetState();
  state([1, 2, 3, 4, 5, 6], 6, 4, [[1, "post-sb", 2], [2, "post-bb", 5]]);
  expect(sorted(positionsAll())).toBe(map({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }));
  state([1, 3, 4, 5, 6], 1, 1, [[3, "post-bb", 5]]);   // a dead SB, the button dealt (hand 372)
  expect(sorted(positionsAll())).toBe(map({ 3: "BB", 4: "UTG", 5: "HJ", 6: "CO", 1: "BTN" }));
  state([1, 2, 4], 4, 4, [[4, "post-bb", 5]]);         // a new player's post, not a dead SB (hand 718)
  expect(sorted(positionsAll())).toBe(map({ 1: "SB", 2: "BB", 4: "BTN" }));
});

test("the seat words: what each PLAY_SEAT_INFO says about a seat the hand did not deal", () => {
  expect(undealtStatus({ type: 1, state: 32, account: 523, at: 0 })).toBe("sitting-out");
  expect(undealtStatus({ type: 1, state: 32, account: 0, at: 0 })).toBe("busted");
  expect(undealtStatus({ type: 0, state: 16, account: 0, at: 0 })).toBe("empty");
  expect(undealtStatus({ type: 1, state: 16, account: 0, reserved: true, at: 0 })).toBe("reserved");
  expect(undealtStatus({ type: 0, state: 32, account: 552, at: 0 })).toBe("waiting");
  expect(undealtStatus({ tableState: 0, account: 0, at: 0 })).toBe("empty");
  expect(undealtStatus({ tableState: 80, account: 500, at: 0 })).toBe("not-dealt");
  expect(undealtStatus(undefined)).toBe("not-dealt");
});

function quiet<T>(fn: () => T): T {
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try { return fn(); } finally { wsSeams.archiveHand = arch0; }
}

test("4922296152 from its own frames: seat 4 sat out and was the dead button; hero's seat 3 is the BTN of four", () => {
  resetState();
  scratchDirs();
  quiet(() => {
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 1, seat: 2, state: 32, account: 145, nickName: "" });   // 15:59:23.982
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 0, seat: 2, state: 16, account: 0, nickName: "" });     // 15:59:24.254 left
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 1, seat: 5, state: 32, account: 552, nickName: "" });   // 16:01:11.779
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 0, seat: 5, state: 32, account: 552, nickName: "" });   // 16:01:14.901 back
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 1, seat: 4, state: 32, account: 523, nickName: "" });   // 16:02:15.575 sits out
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4922296123" });                                       // 16:02:20.029
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
    onGameMsg({ pid: "CO_SIT_PLAY", play: 1, seat: 3 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 547, baseStakes: 0, btn: 4, bet: 5, dead: 0 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat3: [42, 37], seat5: [32896, 32896], seat6: [32896, 32896] });
    // the hand before: a dead SMALL blind (seat 4 sat out, seat 5 posted the big blind alone), the button dealt
    let r = seatRoster()!;
    expect(r.deadSb).toBe(true);
    expect(r.deadButton).toBe(false);
    expect(sorted(positionsAll())).toBe(map({ 5: "BB", 6: "HJ", 1: "CO", 3: "BTN" }));
    onGameMsg({ pid: "CO_SIT_PLAY", play: 0, seat: 3 });
    onGameMsg({ pid: "PLAY_STAGE_END_REQ" });
    onGameMsg({ pid: "CO_LAST_HAND_NUMBER", stageNo: "4922296123" });
    onGameMsg({ pid: "PLAY_CLEAR_INFO" });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4922296152" });                                       // 16:02:33.987
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 4 });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 4 });
    onGameMsg({ pid: "CO_SIT_PLAY", play: 1, seat: 3 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 550, baseStakes: 0, btn: 2, bet: 2, dead: 0 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 6, account: 309, baseStakes: 0, btn: 4, bet: 5, dead: 0 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat3: [31, 39], seat5: [32896, 32896], seat6: [32896, 32896] });
    onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 1 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 1024, bet: 0, raise: 0, account: 1666 });       // CO folds
    onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 3 });
    onGameMsg({ pid: "CO_SELECT_REQ", btns: 2098944, bet: 5, raise: 10, maxRaise: 500, betPot: 17, halfPot: 0, timeBank: 45 });
    expect(sorted(positionsAll())).toBe(map({ 5: "SB", 6: "BB", 1: "CO", 3: "BTN" }));
    expect(heroPosition()).toBe("BTN");
    r = seatRoster()!;
    expect(r).toEqual({
      dealer: 4, deadButton: true, deadSb: false, dealt: [1, 3, 5, 6],
      seats: {
        1: { status: "dealt" }, 2: { status: "empty", word: "type 0 state 16" }, 3: { status: "dealt", hero: true },
        4: { status: "sitting-out", word: "type 1 state 32" }, 5: { status: "dealt", posted: "sb" }, 6: { status: "dealt", posted: "bb" },
      },
    });
    // /hand (and so the archived row) carries both: the positions and the roster
    const h = handStateIgnition()!;
    expect(sorted(h.positions)).toBe(map({ 5: "SB", 6: "BB", 1: "CO", 3: "BTN" }));
    expect(h.roster.deadButton).toBe(true);
    expect(h.roster.seats[4].status).toBe("sitting-out");
  });
});

test("4922299303 from its own frames: seat 4 busted, left, a new player reserved it — the dead button; hero BTN of five", () => {
  resetState();
  scratchDirs();
  quiet(() => {
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 1, seat: 4, state: 32, account: 0, nickName: "" });     // 16:35:29.976 busted
    onGameMsg({ pid: "CO_LAST_HAND_NUMBER", stageNo: "4922299158" });
    onGameMsg({ pid: "PLAY_CLEAR_INFO" });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 2 });
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4922299255" });                                       // 16:35:29.987
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
    onGameMsg({ pid: "CO_SIT_PLAY", play: 1, seat: 3 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 461, baseStakes: 0, btn: 4, bet: 5, dead: 0 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat3: [41, 0], seat5: [32896, 32896], seat6: [32896, 32896] });
    let r = seatRoster()!;
    expect([r.deadSb, r.deadButton, r.seats[4].status]).toEqual([true, false, "busted"]);
    expect(sorted(positionsAll())).toBe(map({ 5: "BB", 6: "UTG", 1: "HJ", 2: "CO", 3: "BTN" }));
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 0, seat: 4, state: 16, account: 0, nickName: "" });     // 16:35:40.074 left
    onGameMsg({ pid: "CO_SIT_PLAY", play: 0, seat: 3 });
    onGameMsg({ pid: "PLAY_SEAT_INFO", type: 1, seat: 4, state: 16, account: 0, nickName: "" });     // 16:35:47.784 taken
    onGameMsg({ pid: "PLAY_SEAT_RESERVATION", add: 0, seat: 4 });                                     // 16:35:48.022
    onGameMsg({ pid: "PLAY_STAGE_END_REQ" });
    onGameMsg({ pid: "CO_LAST_HAND_NUMBER", stageNo: "4922299255" });
    onGameMsg({ pid: "PLAY_CLEAR_INFO" });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 3 });
    onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4922299303" });                                       // 16:36:08.979
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 4 });
    onGameMsg({ pid: "CO_DEALER_SEAT", seat: 4 });
    onGameMsg({ pid: "CO_SIT_PLAY", play: 1, seat: 3 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 5, account: 478, baseStakes: 0, btn: 2, bet: 2, dead: 0 });
    onGameMsg({ pid: "CO_BLIND_INFO", seat: 6, account: 435, baseStakes: 0, btn: 4, bet: 5, dead: 0 });
    onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat3: [36, 4], seat5: [32896, 32896], seat6: [32896, 32896] });
    onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 1 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 256, bet: 5, raise: 0, account: 1808 });         // HJ limps
    onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 2 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 2, btn: 1024, bet: 0, raise: 0, account: 191 });         // CO folds
    onGameMsg({ pid: "CO_CURRENT_PLAYER", seat: 3 });
    onGameMsg({ pid: "CO_SELECT_REQ", btns: 6293248, bet: 5, raise: 10, maxRaise: 1007, betPot: 22, halfPot: 11, timeBank: 45 });
    expect(sorted(positionsAll())).toBe(map({ 5: "SB", 6: "BB", 1: "HJ", 2: "CO", 3: "BTN" }));
    expect(heroPosition()).toBe("BTN");
    r = seatRoster()!;
    expect([r.dealer, r.deadButton, r.deadSb]).toEqual([4, true, false]);
    expect(r.seats[4]).toEqual({ status: "reserved", word: "type 1 state 16", reserved: true });
    const h = handStateIgnition()!;
    expect(h.positions.get(3)).toBe("BTN");
    expect([...h.positions.keys()].includes(4)).toBe(false);   // the dead button's seat carries no label
  });
});

/**
 * BRADY'S RULE (2026-10-04): ANY undealt seat between hero and the button shifts hero later — not only the button.
 * With a LIVE button the wrapper always had it right: positionsAll orders the dealt seats plus the dealer, so a
 * non-dealer seat that sat out simply has no name (4921622118: seat 4 out, hero seat 3 → CO; 141 such hands in the
 * archive's four days, 0 mislabelled). These pin that it stays so, for every set of undealt seats between hero and the
 * button, with the button live and with it dead. The oracle names the seats the plain way: clockwise from the first dealt
 * seat after the button seat, the last dealt seat is the BTN, the first two the blinds, the middle seats the latest of
 * UTG/HJ/CO.
 */
function namesAmongDealt(dealt: number[], dealer: number): Map<number, string> {
  const live = [...dealt].sort((a, b) => a - b);
  const k = live.findIndex((s) => s > dealer);
  const order = k < 0 ? live : [...live.slice(k), ...live.slice(0, k)];
  const mids = ["UTG", "HJ", "CO"].slice(3 - (order.length - 3));
  const names = order.length === 3 ? ["SB", "BB", "BTN"] : ["SB", "BB", ...mids, "BTN"];
  return new Map(order.map((s, i) => [s, names[i]!]));
}
function subsets<T>(xs: T[]): T[][] {
  return xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);
}

test("4921622118: seat 4 out between hero (seat 3) and a live button (seat 5) — hero is the CO", () => {
  resetState();
  state([1, 2, 3, 5, 6], 5, 3, [[6, "post-sb", 2], [1, "post-bb", 5]]);
  expect(sorted(positionsAll())).toBe(map({ 6: "SB", 1: "BB", 2: "HJ", 3: "CO", 5: "BTN" }));
  expect(heroPosition()).toBe("CO");
});

test("every set of undealt seats between hero and the button shifts hero later — live button and dead button", () => {
  resetState();
  // a six-seat table, the button on seat 6, blinds 1 and 2: hero on each non-blind seat 3..5 (and the button seat when
  // it is live); the seats strictly between hero and the button, and the button seat itself (dead), in every combination
  let cases = 0;
  for (const deadBtn of [false, true]) {
    for (const hero of deadBtn ? [3, 4, 5] : [3, 4, 5, 6]) {
      const between = [4, 5].filter((s) => s > hero);
      for (const out of subsets(between)) {
        const dealt = [1, 2, 3, 4, 5, 6].filter((s) => !out.includes(s) && !(deadBtn && s === 6));
        if (!dealt.includes(hero)) continue;
        state(dealt, 6, hero, [[1, "post-sb", 2], [2, "post-bb", 5]]);
        const want = namesAmongDealt(dealt, 6);
        expect(sorted(positionsAll())).toBe(J([...want].sort((a, b) => a[0] - b[0])));
        // hero moves one name later for every undealt seat between him and the button (the dead button included)
        const behind = dealt.filter((s) => s > hero).length;
        expect(positionsAll().get(hero)).toBe(["BTN", "CO", "HJ", "UTG"][behind]);
        cases++;
      }
    }
  }
  expect(cases).toBe(15);   // live: hero 3 ×4, 4 ×2, 5, 6 · dead: hero 3 ×4, 4 ×2, 5
});
