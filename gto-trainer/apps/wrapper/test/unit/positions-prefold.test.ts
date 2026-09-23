/**
 * Port of tests/test_positions_dead_sb.py and tests/test_prefold_topup.py.
 *
 *  - Positions when a hand is dealt with NO small blind (hand 4919958486): the seat after the button posts the big
 *    blind alone — BB first, then the middle seats, the button last; a BB post from elsewhere keeps the geometry.
 *  - Buying chips before the fold, while we hold the clock: only a fold qualifies for the older matcher, the
 *    pre-fold window, its hard blocks, and THE HAND IS NEVER LOST TO A TOP-UP (the panel never outstays the budget).
 */
import { expect, test } from "bun:test";
import { realTime, time } from "../../src/clock";
import { S, resetState, seams } from "../../src/state";
import { heroPosition, positionsAll } from "../../src/ignition/hand";
import { maybeGuardBuyPanel, maybePrefoldTopUp, prefoldPickIsFold, topUpWindow } from "../../src/topup";
import { checker, J } from "./helpers";

function state(dealt: number[], dealer: number, hero: number, posts: [number, string, number][]) {
  S.ws = { bb: 200, bbSeen: true, board: [], pot: null, dealt: [...dealt], dealer, heroSeat: hero,
           actions: posts.map(([s, t, c]) => ({ seat: s, type: t, cents: c, street: "preflop" })) };
}

test("positions when a hand is dealt with NO small blind", () => {
  const { fails, check } = checker();
  resetState();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const pos = (want: Record<number, string>) => new Map(Object.entries(want).map(([k, v]) => [Number(k), v]));
  const sameMap = (label: string, got: Map<number, string>, want: Map<number, string>) =>
    eq(label, [...got].sort((a, b) => a[0] - b[0]), [...want].sort((a, b) => a[0] - b[0]));
  state([2, 3, 4, 5, 6], 6, 4, [[2, "post-bb", 200]]);
  sameMap("732 map", positionsAll(), pos({ 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }));
  eq("732 hero", heroPosition(), "UTG+1");
  state([1, 3, 4, 5, 6], 1, 1, [[3, "post-bb", 200]]);
  sameMap("372 map", positionsAll(), pos({ 3: "BB", 4: "UTG", 5: "HJ", 6: "CO", 1: "BTN" }));
  eq("372 hero", heroPosition(), "BTN");
  state([1, 3, 4, 5], 1, 5, [[3, "post-bb", 200]]);
  sameMap("4-seat map", positionsAll(), pos({ 3: "BB", 4: "HJ", 5: "CO", 1: "BTN" }));
  eq("4-seat hero", heroPosition(), "CO");
  state([1, 3, 4], 1, 4, [[3, "post-bb", 200]]);
  sameMap("3-seat map", positionsAll(), pos({ 3: "BB", 4: "CO", 1: "BTN" }));
  state([1, 2, 3, 4, 5, 6], 6, 4, [[1, "post-sb", 100], [2, "post-bb", 200]]);
  sameMap("normal map", positionsAll(), pos({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }));
  eq("normal hero", heroPosition(), "UTG+1");
  state([1, 2, 4], 4, 4, [[4, "post-bb", 200]]);
  sameMap("718 map (new-player post, not a dead SB)", positionsAll(), pos({ 1: "SB", 2: "BB", 4: "BTN" }));
  state([1, 2, 3, 4, 5, 6], 6, 4, [[2, "post-bb", 200]]);
  sameMap("missed SB frame", positionsAll(), pos({ 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" }));
  state([2, 3, 4, 5, 6], 6, 4, []);
  sameMap("no posts yet", positionsAll(), pos({ 2: "SB", 3: "BB", 4: "HJ", 5: "CO", 6: "BTN" }));
  expect(fails).toEqual([]);
});

function reset(prefold: Record<string, any> = {}) {
  Object.assign(S.topupPrefold, { active: false, key: null, hand: null, deadline: 0.0, startedAt: 0.0, banked: false }, prefold);
  S.topupAbort = false;
  Object.assign(S.topupPanel, { lastCloseAt: 0.0, domTicks: 0 });
  S.feedPrev = { seated: true, waiting: false, toAct: false };
  S.liveStatus = { hero: "in-hand", toAct: false };
  Object.assign(S.ws, { heroFolded: false, handOver: false });
  S.study.stackStable = { ticks: 9 };
}

test("buying chips before the fold, while we still hold the clock", async () => {
  const { fails, check } = checker();
  realTime();
  resetState();
  for (const [label, want] of [["FOLD", true], ["fold", true], ["FOLD 100%", true], ["CHECK", false], ["CALL 2 BB", false],
                               ["RAISE TO 10 BB", false], ["ALL-IN", false], ["", false]] as [string, boolean][]) {
    const got = prefoldPickIsFold({ plan: { label, kind: "action" }, pick: label });
    check(`'${label}' → ${want ? "fold" : "not a fold"}`, got === want, `got ${got}`);
  }
  check("a sizing preset is never a fold", prefoldPickIsFold({ plan: { label: "FOLD", kind: "preset" } }) === false);

  reset();
  S.liveStatus.toAct = true;
  let [ok, trig, why] = topUpWindow();
  check("hero on the clock, no pre-fold run → still refused", ok === false && why === "hero is on the clock", String(why));
  reset({ active: true, deadline: time() + 5 });
  S.liveStatus.toAct = true;
  [ok, trig, why] = topUpWindow();
  check("with a live pre-fold run → the window is open", ok === true && trig === "pre-fold", `${ok} ${trig} ${why}`);
  reset({ active: true, deadline: time() - 0.1 });
  S.liveStatus.toAct = true;
  [ok, trig, why] = topUpWindow();
  check("past its deadline → shut again", ok === false && (why || "").includes("budget"), String(why));
  reset({ active: true, deadline: time() + 5 });
  Object.assign(S.liveStatus, { toAct: true, modal: { kind: "something" } });
  [ok, , why] = topUpWindow();
  check("a client notice still blocks it", ok === false && (why || "").includes("notice"), String(why));
  reset({ active: true, deadline: time() + 5 });
  S.liveStatus.toAct = true;
  S.topupAbort = true;
  [ok, , why] = topUpWindow();
  check("an aborted run still blocks it", ok === false, String(why));
  S.topupAbort = false;
  reset({ active: true, deadline: time() + 5 });
  S.feedPrev.seated = false;
  [ok, , why] = topUpWindow();
  check("not seated still blocks it", ok === false && why === "not seated", String(why));

  // THE ONE THAT MATTERS: the hand is never lost to a top-up
  let closed = 0;
  const act0 = seams.act;
  const log0 = console.log;
  console.log = () => {};
  seams.act = async (label: string) => {
    if (label === "Buy chips") closed++;
    return { ok: true };
  };
  try {
    reset({ active: true, deadline: time() + 5 });
    Object.assign(S.liveStatus, { toAct: true, buyPanel: true });
    S.topupPanel.open = true;
    await maybeGuardBuyPanel();
    check("inside the budget the guard leaves it up", closed === 0 && !(S.topupAbort as boolean), `closed ${closed}x abort=${S.topupAbort}`);
    check("  ... and the run is still live", S.topupPrefold.active === true);
    closed = 0;
    reset({ active: true, deadline: time() - 0.01 });
    Object.assign(S.liveStatus, { toAct: true, buyPanel: true });
    S.topupPanel.open = true;
    await maybeGuardBuyPanel();
    check("past the budget the panel is CLOSED", closed >= 1, `closed ${closed}x`);
    check("  ... the run is called off", (S.topupAbort as boolean) === true);
    check("  ... and the flag is cleared so the fold is no longer held", S.topupPrefold.active === false);
    closed = 0;
    reset();
    Object.assign(S.liveStatus, { toAct: true, buyPanel: true });
    S.topupPanel.open = true;
    await maybeGuardBuyPanel();
    check("someone else's panel on hero's clock is still closed at once", closed >= 1);
  } finally {
    seams.act = act0;
    S.topupAbort = false;
    S.topupPanel.open = false;
  }

  // the trigger will not take hero's clock unless every precondition holds
  try {
    const started = () => S.topupPrefold.active;
    const base = { topUp: true, on: true, auto: true };
    reset();
    Object.assign(S.study, base);
    S.fakeMode = true;
    await maybePrefoldTopUp();
    check("fake rig → never", !started());
    S.fakeMode = false;
    reset();
    Object.assign(S.study, { ...base, auto: false });
    await maybePrefoldTopUp();
    check("auto NOT armed → never (the human is reaching for that strip)", !started());
    reset();
    Object.assign(S.study, base);
    S.liveStatus.toAct = false;
    await maybePrefoldTopUp();
    check("hero not on the clock → never (the ordinary windows own that)", !started());
    reset();
    Object.assign(S.study, { ...base, topUp: false });
    S.liveStatus.toAct = true;
    await maybePrefoldTopUp();
    check("top-up switched off → never", !started());
    reset({ active: true, deadline: time() + 5 });
    Object.assign(S.study, base);
    S.liveStatus.toAct = true;
    await maybePrefoldTopUp();
    check("a run already in flight → not started twice", S.topupPrefold.key === null);
  } finally {
    console.log = log0;
    reset();
  }
  expect(fails).toEqual([]);
});
