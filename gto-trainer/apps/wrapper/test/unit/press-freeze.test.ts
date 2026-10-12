/**
 * A PRESS INTO A FROZEN TABLE (2026-10-12, session_20261012_211242 table 2, hand 4924193376, QsTh HJ, Raise 2.5): Brave
 * stopped drawing for ~8 s, the raise's typing step (mouseMoved, CDP reply 1) timed out, the error escaped to the feed
 * loop and auto-execute never pressed again — Brady raised by hand in the time bank. Now:
 *   - auto-execute HOLDS while the browser is not drawing the table (nothing is sent into a frozen page);
 *   - a press that fails before any turn-button click went out is REFUSED, and the existing retry presses it again;
 *   - a press that fails AFTER a turn-button click went out is UNCERTAIN (the browser queues input, the click may land
 *     when drawing resumes): never pressed again on a timer — the socket shows it landed (confirmed) or, once the table
 *     has drawn again for a full window and the spot is unchanged, the verifier presses once more.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime, time } from "../../src/clock";
import { pyJsonDumps } from "../../src/py";
import * as cdp from "../../src/cdp";
import { S, resetState, seams } from "../../src/state";
import { FROZEN_HOLD_WHY, actuate, executePick, frameFrozen, maybeAutoAct, maybeVerifyExec, pressMark, pressUncertain } from "../../src/relay";
import { noteFrame } from "../../src/ignition/reader";
import { FakeIgnition, RIVER_FACING_BET } from "./fakeIgnition";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_790_000_000;
const KEY = pyJsonDumps(["preflop", [], ["Qs", "Th"], 1, 3]);
const PKEY = `7|${KEY}`;

function seed() {
  S.fakeMode = false;
  S.handNo = 7;
  S.handIds.set(7, "4924193376");
  S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }], [2, { stack: "100 BB" }], [3, { stack: "100 BB" }]]) };
  Object.assign(S.liveStatus, { toAct: true, practice: true, board: [], modal: null, buyPanel: null, timeBank: null });
  Object.assign(S.ws, {
    bb: 200, bbSeen: true, dealt: [1, 2, 3], heroSeat: 1, dealer: 1, board: [], heroCards: ["Q♠", "T♥"], potCents: 300, maxBet: 200,
    committed: new Map([[2, 100], [3, 200]]),
    actions: [{ seat: 2, type: "post-sb", cents: 100, street: "preflop" }, { seat: 3, type: "post-bb", cents: 200, street: "preflop" },
              { seat: 2, type: "call", cents: 100, street: "preflop" }],
    actionOn: 1, heroFolded: false, foldedSeats: new Set(), domGraceUntil: 0,
  });
  Object.assign(S.study, {
    on: true, text: "PREFLOP — Raise 2.5 100%", pick: "Raise 2.5", roll: null, note: null, at: time(), decisionKey: KEY,
    handId: 7, executed: null, auto: true, autoDelay: "instant", autoTried: null, autoRetry: null, lastExec: null,
    autoHeld: null, uncertain: null, autoDue: null, autoNotFired: null, pendingExec: null,
  });
  S.frameHealth.frozen = false;
}

/** hero's raise as the socket reports it (CO_SELECT_INFO for hero's seat) */
const heroRaised = () => S.ws.actions.push({ seat: 1, type: "raise", cents: 500, street: "preflop" });

test("a frozen table holds auto-execute; a press that fails before its click is refused and retried", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  const log0 = console.log;
  console.log = () => {};
  const act0 = seams.act, raise0 = seams.raiseTo;
  const calls: string[] = [];
  let typingTimesOut = true;
  seams.raiseTo = async (amount) => {
    calls.push(`raise_to ${amount}`);
    // the QsTh press: the typing step's first command (mouseMoved, CDP reply 1) never answered — no turn button clicked
    if (typingTimesOut) throw new Error("timed out waiting for reply 1");
    return { ok: true, typed: amount, confirm: { ok: true, clicked: "RAISE TO 2.5 BB" } };
  };
  seams.act = async (label) => { calls.push(`act ${label}`); return { ok: true, clicked: label }; };
  const tickAt = async (t: number) => { setFakeTime(T0 + t); S.study.at = time(); await maybeAutoAct(); };
  try {
    setFakeTime(T0);
    seed();
    S.frameHealth.frozen = true;
    await tickAt(0);
    check("frozen: nothing pressed", calls.length === 0, J(calls));
    check("  ... held, and says why", (S.study.autoHeld || {}).why === FROZEN_HOLD_WHY, J(S.study.autoHeld));
    check("  ... in the feed", S.feed.some((l) => String(l.line).includes("Auto-execute held — the browser has stopped drawing")));
    await tickAt(3);
    check("  ... still held 3 s on", calls.length === 0, J(calls));
    process.env.FREEZE_HOLD = "off";
    try {
      check("FREEZE_HOLD=off: not frozen as far as presses go", frameFrozen() === false);
    } finally {
      delete process.env.FREEZE_HOLD;
    }
    check("  ... and back on without it", frameFrozen() === true);

    S.frameHealth.frozen = false;
    let threw: unknown = null;
    try { await tickAt(4); } catch (e) { threw = e; }
    check("drawn again: pressed, and the failure does not escape", calls.length === 1 && threw === null, J({ calls, threw: String(threw) }));
    check("  ... REFUSED, not uncertain (no turn-button click went out)",
          (S.study.lastExec || {}).outcome === "refused" && !(S.study.lastExec || {}).result?.uncertain, J(S.study.lastExec));
    check("  ... not marked executed", S.study.executed === null);
    check("  ... the feed names the failure", S.feed.some((l) => String(l.line).includes("NOT executed") && String(l.line).includes("timed out waiting for reply 1")));

    typingTimesOut = false;
    await tickAt(4.5);
    check("not re-pressed inside the retry gap", calls.length === 1, J(calls));
    await tickAt(5.2);
    check("the existing retry presses it again", calls.length === 2 && S.study.executed === PKEY, J({ calls, executed: S.study.executed }));
  } finally {
    seams.act = act0;
    seams.raiseTo = raise0;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});

test("a press whose turn-button click went out unanswered is UNCERTAIN: the socket decides, never a timer", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  const log0 = console.log;
  console.log = () => {};
  const act0 = seams.act, raise0 = seams.raiseTo;
  const calls: string[] = [];
  let clickHangs = true;
  // the size typed fine; the RAISE TO click (actReal, kind "action") went out and its reply never came
  seams.raiseTo = async (amount) => {
    calls.push(`raise_to ${amount}`);
    pressMark.actionClicks += 1;
    if (clickHangs) {
      pressMark.actionClicksFailed += 1;
      return { ok: false, typed: amount, confirm: { ok: false, reason: "click did not go through: timed out waiting for reply 1" } };
    }
    return { ok: true, typed: amount, confirm: { ok: true, clicked: "RAISE TO 2.5 BB" } };
  };
  seams.act = async (label) => { calls.push(`act ${label}`); return { ok: true, clicked: label }; };
  const tickAt = async (t: number) => { setFakeTime(T0 + t); S.study.at = time(); await maybeAutoAct(); await maybeVerifyExec(); };
  try {
    // 1. the click lands late — when the table draws again — and auto-execute never pressed twice
    setFakeTime(T0);
    seed();
    await tickAt(0);
    check("pressed once", calls.length === 1, J(calls));
    const ex = S.study.lastExec || {};
    check("  ... UNCERTAIN: pending, not refused", ex.outcome === "pending" && ex.result?.uncertain === true, J(ex));
    check("  ... auto-execute counts it as executed (no timer re-press)", S.study.executed === PKEY);
    check("  ... the verifier holds it, marked uncertain", (S.study.pendingExec || {}).uncertain === true, J(S.study.pendingExec));
    check("  ... the feed says so", S.feed.some((l) => String(l.line).includes("Study pick UNCERTAIN")));
    S.frameHealth.frozen = true;
    for (const t of [1, 2, 3, 4, 5, 6, 7, 8]) await tickAt(t);
    check("frozen 8 s: nothing pressed again", calls.length === 1, J(calls));
    check("  ... still pending", (S.study.lastExec || {}).outcome === "pending" && S.study.pendingExec !== null);
    S.frameHealth.frozen = false;
    heroRaised();                                     // the queued click lands as drawing resumes: the socket shows it
    await tickAt(8.5); await tickAt(9);
    check("the socket's echo CONFIRMS it", (S.study.lastExec || {}).outcome === "confirmed", J(S.study.lastExec));
    check("  ... with exactly one press", calls.length === 1, J(calls));

    // 2. nothing ever lands: one more press, only after the table has drawn again for a full window
    calls.length = 0;
    setFakeTime(T0 + 100);
    seed();
    await tickAt(100);
    S.frameHealth.frozen = true;
    for (const t of [101, 102, 103, 104, 105]) await tickAt(t);
    S.frameHealth.frozen = false;
    clickHangs = false;
    await tickAt(106);
    check("drawn again: not judged at once", calls.length === 1, J(calls));
    await tickAt(108.4);
    check("  ... nor inside the window after the freeze", calls.length === 1, J(calls));
    await tickAt(108.7);
    check("no echo for a full window, same spot: pressed again once", calls.length === 2, J(calls));
    heroRaised();
    await tickAt(109.0); await tickAt(109.4);
    check("  ... and that press is confirmed", (S.study.lastExec || {}).outcome === "confirmed", J(S.study.lastExec));

    // 3. the spot moved on while frozen (the site acted for hero / the clock ran out): never pressed again
    calls.length = 0;
    clickHangs = true;
    setFakeTime(T0 + 200);
    seed();
    await tickAt(200);
    S.frameHealth.frozen = true;
    await tickAt(201);
    S.frameHealth.frozen = false;
    S.liveStatus.toAct = false;
    await tickAt(205);
    check("  ... the window after the thaw is waited out (a late echo still counts)", (S.study.lastExec || {}).outcome === "pending");
    await tickAt(208);
    check("spot gone: abandoned, one press", calls.length === 1 && (S.study.lastExec || {}).outcome === "abandoned", J({ calls, ex: S.study.lastExec }));

    // 4. a press that RAISED after its click went out is uncertain too
    calls.length = 0;
    setFakeTime(T0 + 300);
    seed();
    seams.raiseTo = async (amount) => { calls.push(`raise_to ${amount}`); pressMark.actionClicks += 1; throw new Error("socket closed before the reply"); };
    let threw: unknown = null;
    try { await executePick("auto"); } catch (e) { threw = e; }
    check("a press that raised after its click: no escape, UNCERTAIN", threw === null && (S.study.lastExec || {}).result?.uncertain === true, J({ threw: String(threw), ex: S.study.lastExec }));
  } finally {
    seams.act = act0;
    seams.raiseTo = raise0;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});

test("pressUncertain: only a turn-button click that may still land", () => {
  resetState();
  S.fakeMode = false;
  const p0 = { ...pressMark };
  expect(pressUncertain(p0, false)).toBe(false);                 // refused before anything was sent
  expect(pressUncertain(p0, true)).toBe(false);                  // raised before any turn-button click (typing, a read)
  pressMark.actionClicks += 1;
  expect(pressUncertain(p0, false)).toBe(false);                 // a click whose reply came: refused for another reason
  expect(pressUncertain(p0, true)).toBe(true);                   // raised after a click went out
  pressMark.actionClicksFailed += 1;
  expect(pressUncertain(p0, false)).toBe(true);                  // a click whose reply never came
});

test("the REAL press code counts only turn-button clicks: typing or a preset that hangs is refused, a hung turn click is uncertain", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const log0 = console.log;
  console.log = () => {};
  let undo = () => {};
  const table = () => {
    undo();
    const t = new FakeIgnition(RIVER_FACING_BET, { stack: 89.2 });
    undo = t.install();
    return t;
  };
  const hang = () => { throw new cdp.CdpError("timed out waiting for reply 1"); };
  try {
    S.ws.bb = 200;
    // 1. the QsTh case: the typing sequence (cdpSeq: mouseMoved first) never answers — nothing that acts was sent
    let t = table();
    seams.cdpSeq = async () => hang();
    let p0 = { ...pressMark };
    let threw = false;
    try { await actuate({ kind: "raise-to", amount: "2.5", verb: "raise" }); } catch { threw = true; }
    check("typing hangs: the raise path raises", threw);
    check("  ... no turn-button click was sent", t.clicks.length === 0 && pressMark.actionClicks === p0.actionClicks, J({ clicks: t.clicks, pm: pressMark }));
    check("  ... so it is REFUSED (safe to press again)", pressUncertain(p0, threw) === false);

    // 2. the RAISE TO click goes out (the client queues it) and its reply never comes
    t = table();
    const click0 = cdp.io.dispatchClick;
    cdp.io.dispatchClick = async (ws: string, x: number, y: number) => { await click0(ws, x, y); hang(); };
    p0 = { ...pressMark };
    let r = await actuate({ kind: "raise-to", amount: "2.5", verb: "raise" });
    check("a hung RAISE TO click: not ok", r.ok === false, J(r));
    check("  ... counted as a turn-button click sent and unanswered",
          pressMark.actionClicks === p0.actionClicks + 1 && pressMark.actionClicksFailed === p0.actionClicksFailed + 1, J(pressMark));
    check("  ... UNCERTAIN (it may still land)", pressUncertain(p0, false) === true);

    // 3. a sizing PRESET that hangs (the ALL-IN preset before the confirm) acts nothing at the table
    t = table();
    const click1 = cdp.io.dispatchClick;
    cdp.io.dispatchClick = async (ws: string, x: number, y: number) => {
      const b = RIVER_FACING_BET.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (b && /Selector$/.test(b.qa || "")) hang();
      await click1(ws, x, y);
    };
    p0 = { ...pressMark };
    r = await actuate({ kind: "action", label: "all-in" });
    check("a hung preset click: not ok, and no turn button pressed", r.ok === false && t.pressed === null, J({ r, pressed: t.pressed }));
    check("  ... REFUSED, not uncertain", pressUncertain(p0, false) === false && pressMark.actionClicks === p0.actionClicks, J(pressMark));

    // 4. a turn click whose reply comes: counted as sent, never as unanswered — and it is ok
    t = table();
    p0 = { ...pressMark };
    r = await actuate({ kind: "action", label: "fold" });
    check("a fold that answers: ok, one click counted, none unanswered",
          r.ok === true && pressMark.actionClicks === p0.actionClicks + 1 && pressMark.actionClicksFailed === p0.actionClicksFailed, J({ r, pressMark }));
  } finally {
    undo();
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});

test("noteFrame: frozen only when the page is visible and the table on screen; each freeze is a session event", () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  setFakeTime(T0);
  const log0 = console.log;
  console.log = () => {};
  const events: [string, any][] = [];
  const ev0 = S.sessions.event;
  S.session.id = "session_test";
  S.sessions.event = ((_sid: string, kind: string, data: any) => { events.push([kind, data]); }) as any;
  const cap = (draw: any) => ({ seated: true, frameTag: "0", tags: [0], draw });
  const DRAWN = { beats: 900, idleMs: 16, ageMs: 15000, pageHidden: false, offscreen: false };
  const STUCK = { beats: 900, idleMs: 4000, ageMs: 15000, pageHidden: false, offscreen: false };
  try {
    noteFrame(cap(DRAWN));
    check("drawn: not frozen, no event", S.frameHealth.frozen === false && events.length === 0, J({ f: S.frameHealth, events }));
    noteFrame(cap(STUCK));
    check("stuck while visible + on screen: FROZEN", S.frameHealth.frozen === true);
    check("  ... one frame-undrawn event", events.length === 1 && events[0]![0] === "frame-undrawn" && events[0]![1].frozen === true, J(events));
    setFakeTime(T0 + 8);
    noteFrame(cap(STUCK));
    check("  ... said once, not every read", events.length === 1, J(events));
    noteFrame(cap(DRAWN));
    check("drawn again: not frozen", S.frameHealth.frozen === false);
    check("  ... a frame-drawn-again event with how long", events.length === 2 && events[1]![0] === "frame-drawn-again" && events[1]![1].forS === 8, J(events));
    noteFrame(cap({ ...STUCK, pageHidden: true }));
    check("a hidden page is not a freeze (the press path brings it to front)", S.frameHealth.frozen === false && S.frameHealth.drawn === false);
    noteFrame(cap({ ...STUCK, offscreen: true }));
    check("nor a table moved off screen by the lobby", S.frameHealth.frozen === false);
    noteFrame(cap({ beats: 3, idleMs: 900, ageMs: 900, pageHidden: false, offscreen: false }));
    check("a heartbeat younger than the idle limit is never a freeze", S.frameHealth.frozen === false);
    noteFrame({ seated: true, nodes: [] });
    check("a read without the heartbeat is unknown, never frozen", S.frameHealth.frozen === false && S.frameHealth.drawn === null);
  } finally {
    S.sessions.event = ev0;
    S.session.id = null;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});
