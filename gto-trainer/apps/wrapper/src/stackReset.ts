/**
 * DEEP STACK: SIT OUT AT THE THRESHOLD, LEAVE, WAIT, TAKE A FRESH SEAT (Brady, 2026-10-03, after
 * session_20261003_153908: GTO Wizard AI preflop refuses a tree whose effective stack is over 250bb, and hero got no
 * pick twice). The API caps the preflop tree at 250bb (gtowAiPreflop PREFLOP_STACK_CAP_BB) — accurate enough for an
 * orbit. This is the other half: once hero's OWN stack reaches the session's `stackResetBb`, the wrapper ticks "Sit out
 * next big blind", and once hero is sat out it leaves the table, waits `stackResetWaitS` and has the leader seat a
 * fresh table of the session's format at the normal buy-in — same session, same slot and panel; the old table's socket
 * closing is ours, not a failure (ignition/reader.ts noteSocketClosed), and the new table's frame and socket bind to
 * this slot as after a site close (dom.ts forgetFrame, ws.ts tapForget).
 *
 * OFF UNLESS THE SESSION SAYS SO: the setup page's "Deep stack" row; no `stackResetBb` in the config (every session
 * before this, and every session with the row on Off) = off. NOT YET SEEN ON THE LIVE CLIENT (2026-10-03): the
 * "Sit out next big blind" box's tick state and the click on its label are unverified — the reader treats an
 * unreadable box as unknown, never as unticked.
 *
 * Per table, from the feed loop (loops.ts), one step per tick; the slow parts (the press, telling the leader, the
 * leave) run in the background so the reader keeps ticking:
 *
 *   idle       hero's stack ≥ the threshold → armed (event stack-reset-armed)
 *   armed      tick the box (read first; click only when it reads unticked or has not been clicked); a later hand in
 *              which hero still POSTED THE BIG BLIND means the tick did not take → tick again, at most
 *              STACK_RESET_TICKS, then aborted. Stays armed if the stack falls back under the threshold.
 *   sat-out    hero sitting out, no hand on → the leader is told (a pending note, so the seat-count drop that
 *              follows is a re-seat, not a close by hand); its yes → leaving. No yes → aborted.
 *   leaving    the sibling tables are told which socket is about to close; markLeaving; the leave (F.leave: the
 *              close icon, then YES). Failed → aborted.
 *   waiting    left: the leader is told when the new seat is due; our frame and socket are let go
 *   reseating  the wait is over: the leader seats; done once our frame is pinned, hero seated, the socket bound
 *              (event stack-reset-done)
 *
 * Stands aside while a disconnect or a connection drop is noted (the session ends), outside a session, on the fake
 * table, and off Ignition. Any failure before the leave presses I AM BACK if hero is sitting out (event
 * stack-reset-aborted {why}) and play goes on under the API's 250bb cap; the reset is not tried again for
 * STACK_RESET_RETRY_HANDS hands, and not at all after STACK_RESET_MAX_ABORTS aborts in a session (event stack-reset-off,
 * said on the feed).
 *
 * A READ IS NOT A TICK (2026-10-09, session_20261009_052537: five resets armed, each burned its three ticks within a
 * second on "no 'Sit out next big blind' box on the table" - the read's fault, not the box's - and the session's
 * reset was off after the third). A tick that pressed nothing (the read failed, found no box, or the press was
 * refused before it went out) is tried again STACK_RESET_MISS_S later and counts against nothing; only presses count
 * towards STACK_RESET_TICKS. The armed state ends in an abort only on what the table did: hero posting the big blind
 * after the arming STACK_RESET_TICKS times (whatever was or was not pressed in between). /state `stackReset` carries
 * the machine (stackResetBrief).
 */
import * as cdp from "./cdp";
import { nowMs, sleep, time } from "./clock";
import { C } from "./config";
import { feedAdd, log } from "./feed";
import { postJson } from "./http";
import { js } from "./js";
import { pyRepr, pyRound, pyStr } from "./py";
import { PEER_LEAVING_S, S, inAHand, isClientSite, pressBlocked, seams, type StackResetState } from "./state";
import * as TABLES from "./tables";
import { forgetFrame, framePin, mySel, slotted, type FrameSel } from "./ignition/dom";
import { stackBb } from "./ignition/hand";
import { tapForget } from "./ignition/ws";
import { ensureVisible, pointIsMyTable } from "./relay";
import { ignitionSitBackIn } from "./sitback";
import { markLeaving, noteStackReset, sessionSeams } from "./session";

/** Ticks of the box per reset before it is given up (a box that never takes is not clicked for ever). */
export const STACK_RESET_TICKS = 3;
/** Hands after an abort before the reset may arm again. */
export const STACK_RESET_RETRY_HANDS = 10;
/** Aborts in one session before the reset stops trying for the rest of it. */
export const STACK_RESET_MAX_ABORTS = 3;
/** How long the new table may take to seat, pin and bind after the wait before the reset gives up waiting for it. */
export const STACK_RESET_RESEAT_S = 600;
/** A tick that pressed nothing (no box read, the read failed, the press refused before it went out) is tried again
 *  this many seconds later — it costs no tick. */
export const STACK_RESET_MISS_S = 5;

/** Finds "Sit out next big blind" on one table: {ok, found, checked (null = unknown), via, shared, back, seated, x, y
 *  (null when nothing measures), on: 'box'|'label'|null, hidden (matches not shown), idleMs (the frame's last draw)}. */
export const sitoutBbReadJs = (sel: FrameSel = null) =>
  slotted(js("stackreset.SITOUT_BB_READ_JS_TMPL"), sel).split("__CLICK__").join("false");
/** The same read, then a DOM click on the box (or on the label when no box is ours): {..., domClicked | domClickError}. */
export const sitoutBbClickJs = (sel: FrameSel = null) =>
  slotted(js("stackreset.SITOUT_BB_READ_JS_TMPL"), sel).split("__CLICK__").join("true");

/** Why a DOM click may not go to our table now (null = it may): the refusals relay.pointIsMyTable makes before its
 *  point probe — the session lost the server, or (several tables) our frame is not pinned or is gone. The click
 *  snippet then finds OUR frame by its pinned tag (mySel → __frame {tag}) or nothing, never another table's. */
export function domClickRefusal(): string | null {
  const blocked = pressBlocked();
  if (blocked) return blocked;
  if (TABLES.domSlot() === null) return null;
  const pin = framePin();
  if (pin.tag === null) return `table ${pyStr(TABLES.slot())} has not identified its own table in the client yet — refusing`;
  if (pin.lost !== null) return `table ${pyStr(TABLES.slot())}'s own table (the client's tag ${pin.tag}) is gone — refusing`;
  return null;
}

/** Tick "Sit out next big blind" on OUR table — reads first, presses only when the box reads unticked, or its state is
 *  unreadable and this reset has not pressed it yet (`clickedBefore`). netguard.ignitionSitoutNextHand's pattern.
 *
 *  HOW IT PRESSES (2026-10-09). First a pointer click at the box (else the label) through CDP Input — the press every
 *  pick makes, and those land on a frame Chrome has stopped drawing (session_20261009_052537: every pick of both
 *  tables went through while /state said `drawn:false` for 2,000+ s; hit-testing runs on layout, not paint), guarded
 *  by ensureVisible and pointIsMyTable as before. A DOM click (`.click()` on the box, else the label, inside OUR frame
 *  only — domClickRefusal) is used when there is no point to press (nothing measures), when the page is not rendering
 *  (a parked pointer click never arrives; a DOM click needs no frame), when the point would not land on our table,
 *  and once after a pointer click that left the box reading unticked. `pressed` = a click went out (it counts a
 *  tick); `retry` = nothing went out (the caller tries again later, no tick spent). */
export async function ignitionSitoutNextBb(clickedBefore: boolean): Promise<Record<string, any>> {
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, retry: true, why: "poker client not open" };
  const ws = t.webSocketDebuggerUrl;
  const read = sitoutBbReadJs(mySel());
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, read, 6)) || {};
  } catch (e: any) {
    return { ok: false, retry: true, why: `table read failed: ${e?.message ?? e}` };
  }
  if (!d.ok) return { ok: false, retry: true, why: d.reason || "table not readable" };
  if (d.back) return { ok: true, state: "already sitting out (I'm back is showing)" };
  if (!d.found) {
    return { ok: false, retry: true, idleMs: d.idleMs ?? null,
             why: "no 'Sit out next big blind' box on the table" + (d.seated ? "" : " - not seated")
               + (d.hidden ? ` (${d.hidden} hidden by style)` : "") };
  }
  if (d.checked === true) return { ok: true, state: "already ticked", via: d.via ?? null };
  if ((d.checked === null || d.checked === undefined) && clickedBefore) {
    return { ok: true, state: "clicked earlier (tick state unreadable)", via: d.via ?? null, shared: !!d.shared, html: d.html ?? null };
  }
  const domNo = domClickRefusal();
  const viaDom = async (): Promise<{ sent: boolean; why?: string; target?: string }> => {
    let c: Record<string, any>;
    try {
      c = (await cdp.evaluate(ws, sitoutBbClickJs(mySel()), 6)) || {};
    } catch (e: any) {
      return { sent: false, why: `DOM click failed: ${e?.message ?? e}` };
    }
    if (!c.found || !c.domClicked) {
      return { sent: false, why: `DOM click did not go out (${pyStr(c.domClickError ?? c.reason ?? (c.found ? null : "the box is gone"))})` };
    }
    return { sent: true, target: String(c.domClicked) };
  };
  let method = "";
  const lk = await TABLES.pressLock();
  try {
    const point = typeof d.x === "number" && typeof d.y === "number" && Number.isFinite(d.x) && Number.isFinite(d.y);
    let noPoint: string | null = point ? null : `nothing to point at (the label measures ${d.w ?? 0} x ${d.h ?? 0})`;
    if (!noPoint) noPoint = await ensureVisible(ws);
    if (!noPoint) {
      const wrong = await pointIsMyTable(ws, d.x, d.y);
      if (wrong && pressBlocked()) return { ok: false, retry: true, why: wrong };
      noPoint = wrong;
    }
    if (!noPoint) {
      try {
        await cdp.dispatchClick(ws, d.x, d.y);
      } catch (e: any) {
        return { ok: false, retry: true, why: `click did not go through: ${e?.message ?? e}` };
      }
      method = `point (${d.on ?? "label"})`;
    } else {
      if (domNo) return { ok: false, retry: true, why: `${noPoint}; no DOM click either: ${domNo}` };
      const r = await viaDom();
      if (!r.sent) return { ok: false, retry: true, why: `${noPoint}; ${r.why}` };
      method = `dom: ${r.target} (${noPoint})`;
    }
  } finally {
    lk.release();
  }
  await sleep(0.4);
  const reread = async (): Promise<Record<string, any>> => {
    try {
      return (await cdp.evaluate(ws, read, 6)) || {};
    } catch {
      return {};
    }
  };
  let after = await reread();
  // a pointer click that left the box reading unticked did not land: once more, through the DOM (it read unticked
  // before and after, so this can only tick it)
  if (after.checked === false && d.checked === false && method.startsWith("point") && !domNo) {
    const lk2 = await TABLES.pressLock();
    let r: { sent: boolean; why?: string; target?: string };
    try {
      r = await viaDom();
    } finally {
      lk2.release();
    }
    if (r.sent) {
      method += ` → dom: ${r.target}`;
      await sleep(0.4);
      after = await reread();
    }
  }
  if (after.checked === false && d.checked === false) {
    return { ok: false, why: "clicked, but the box still reads unticked", clicked: true, pressed: true, method, html: after.html ?? null };
  }
  return { ok: true, clicked: true, pressed: true, method,
           state: after.checked ? "ticked" : "clicked (tick state unreadable - check the table)",
           via: d.via ?? null, shared: !!d.shared, html: after.checked ? null : d.html ?? null };
}

/** What a test replaces: the tick, the I AM BACK press, the leader, the siblings, the leave, how a slow step runs. */
export const stackResetSeams = {
  tick: (clickedBefore: boolean) => ignitionSitoutNextBb(clickedBefore),
  sitBack: () => ignitionSitBackIn(),
  /** the leader's bookkeeping: called in-process at the leader (or the only table), over HTTP from a follower */
  tellLeader: async (body: Record<string, any>): Promise<Record<string, any>> => {
    if (TABLES.isLeader()) return noteStackReset(body)[1];
    return postJson(`http://127.0.0.1:${TABLES.leaderPort()}/session/stack-reset`, body, 20);
  },
  /** every other live table: our socket is about to close on purpose */
  tellPeers: async (body: Record<string, any>): Promise<number> => {
    let n = 0;
    for (const p of await seams.livePeers()) {
      const r = await postJson(`http://127.0.0.1:${p.panelPort}/table/peer-leaving`, body, 5);
      if (r && r.ok) n++;
    }
    return n;
  },
  leave: () => sessionSeams.leave(C.CDP_PORT),
  /** how a slow step runs: in the background, so the feed loop keeps reading (a test collects and awaits them) */
  spawn: (p: Promise<unknown>): void => { void p; },
};

/** Hero's stack in bb: as dealt this hand off the table's own account (exact), else the screen's reading. */
export function heroStackBb(): number | null {
  const w = S.ws;
  const seat = w.heroSeat ?? null;
  const bbC = Number(w.bb || 0);
  if (seat !== null && bbC > 0 && !w.handOver) {
    const c = (w.startCents as Map<number, number> | undefined)?.get(seat);
    if (typeof c === "number" && c > 0) return pyRound(c / bbC, 2);
  }
  const p = S.feedPrev;
  const mine = S.liveStatus.heroSeatDom ?? null;
  const s = p.seats instanceof Map && mine !== null ? p.seats.get(mine) : null;
  return s ? stackBb(s.stack ?? null) : null;
}

/** Hero posted the big blind in the hand on now (the client's own blind frame, ws.ts CO_BLIND_INFO). */
const heroPostedBb = (): boolean =>
  (S.ws.actions || []).some((a: any) => a.type === "post-bb" && a.seat !== null && a.seat === (S.ws.heroSeat ?? null));

function event(kind: string, data: Record<string, any>): void {
  if (S.session.id) S.sessions.event(S.session.id, kind, { slot: TABLES.slot(), hand: S.handNo, ...data });
}

function setState(st: StackResetState): void {
  S.stackReset.state = st;
  S.stackReset.since = time();
}

/** Off for now: no setting, no session, nothing to read, or the session is ending for a connection fault. */
function standsAside(): boolean {
  return !S.stackReset.bb || !S.session.id || S.fakeMode || isClientSite() || !!S.disconnect || !!S.net.drop || !!S.net.sitout;
}

/** From the feed loop, every tick. The slow steps (the press, the leader, the leave) run in the background. */
export async function maybeStackReset(): Promise<void> {
  const R = S.stackReset;
  if (standsAside() || R.busy) return;
  const now = time();
  switch (R.state) {
    case "idle": {
      if (R.aborts >= STACK_RESET_MAX_ABORTS) return;
      if (R.abortedAt !== null && S.handNo < R.abortedAt + STACK_RESET_RETRY_HANDS) return;
      const st = heroStackBb();
      if (st === null || st < R.bb) return;
      Object.assign(R, { armedHand: S.handNo, stackBb: st, ticks: 0, clicked: false, needTick: true, lastTick: null, bbHands: [],
                         misses: 0, retryAt: 0.0, lastMissWhy: null });
      setState("armed");
      feedAdd(`DEEP STACK: ${st} bb ≥ ${R.bb} bb — sitting out at the next big blind, then a fresh table of this format`);
      log(`[stack-reset] armed at ${st} bb (hand ${S.handNo})`);
      event("stack-reset-armed", { stackBb: st });
      break;   // the tick, below, once hero is not on the clock
    }
    case "armed":
      break;
    case "waiting": {
      if (now < R.notBefore) return;
      setState("reseating");
      feedAdd("Deep stack: the wait is over — the next table seated is this one");
      log(`[stack-reset] wait over (${pyRound(now - R.leftAt, 1)} s) — waiting for the new table`);
      return;
    }
    case "reseating": {
      const pinned = TABLES.slot() === null || S.frame.tag !== null;
      if (pinned && S.feedPrev.seated && S.tapBound !== null && S.liveStatus.hero !== "unknown") {
        const waited = pyRound(now - R.leftAt, 1);
        const tag = S.frame.tag, rid = S.tapBound;
        setState("idle");
        Object.assign(R, { armedHand: 0, stackBb: null, ticks: 0, clicked: false, needTick: false, bbHands: [], oldRid: null, oldTag: null,
                           misses: 0, retryAt: 0.0, lastMissWhy: null });
        feedAdd(`Deep stack: seated at a fresh table (${waited} s after leaving the old one)`);
        log(`[stack-reset] done: frame ${pyStr(tag)}, socket ${pyStr(rid)} (${waited} s after the leave)`);
        event("stack-reset-done", { waitedS: waited, tag, rid });
        return;
      }
      if (now - R.notBefore > STACK_RESET_RESEAT_S) {
        setState("idle");
        const why = `no new table seated, pinned and bound within ${STACK_RESET_RESEAT_S} s of the wait`;
        countAbort(why);
        feedAdd("Deep stack: no new table came up for this slot — check the lobby and the leader's panel");
        log(`[stack-reset] gave up waiting for the new table (${STACK_RESET_RESEAT_S} s after the wait)`);
        event("stack-reset-aborted", { why, phase: "reseating" });
        sayOff(why);
      }
      return;
    }
    default:
      return;          // sat-out, leaving: the background step owns them
  }
  // ---- armed
  if (S.liveStatus.hero === "sitting-out" && !inAHand()) {
    setState("sat-out");
    log(`[stack-reset] sat out (hand ${S.handNo}) — telling table ${TABLES.LEADER} before leaving`);
    event("stack-reset-satout", { stackBb: heroStackBb() });
    background(async () => {
      const r = await stackResetSeams.tellLeader({ sid: S.session.id, slot: TABLES.slot(), phase: "pending", waitS: R.waitS });
      if (!(r && r.ok)) return abort(`the leader did not answer (${pyStr((r || {}).error ?? null)})`);
      if (R.state === "sat-out") await leave();
    });
    return;
  }
  // a hand after the arming in which hero still posted the big blind: the tick did not take (or none went out yet)
  if (S.handNo > R.armedHand && heroPostedBb() && !R.bbHands.includes(S.handNo)) {
    R.bbHands.push(S.handNo);
    if (R.ticks >= STACK_RESET_TICKS || R.bbHands.length >= STACK_RESET_TICKS) {
      await abort(R.ticks >= STACK_RESET_TICKS
        ? `the box did not take: hero posted the big blind after ${R.ticks} tick(s)`
        : `hero posted the big blind ${R.bbHands.length} times since the arming with ${R.ticks} press(es) of the box`
          + (R.misses ? ` (${R.misses} read(s) pressed nothing: ${pyStr(R.lastMissWhy)})` : ""));
      return;
    }
    log(`[stack-reset] hero posted the big blind in hand ${S.handNo} — ` + (R.ticks ? "the tick did not take; ticking again" : "no press has gone out yet; still trying"));
    Object.assign(R, { needTick: true, clicked: false, retryAt: 0.0 });
  }
  // the press waits while hero is on the clock or a notice is up (nothing is clicked over a decision), and a tick that
  // pressed nothing waits STACK_RESET_MISS_S before the next read
  if (R.needTick && now >= R.retryAt && !S.liveStatus.toAct && !S.liveStatus.modal) tickBox();
}

/** A slow step in the background; the machine waits for it (`busy`). */
function background(f: () => Promise<unknown>): void {
  const R = S.stackReset;
  R.busy = true;
  stackResetSeams.spawn((async () => {
    try {
      await f();
    } catch (e: any) {
      log(`[stack-reset] ${e?.message ?? e}`);
    } finally {
      R.busy = false;
    }
  })());
}

/** Tick the box, in the background. A result that pressed nothing (`ok` false and no click went out) is a MISS: no
 *  tick spent, the read tried again STACK_RESET_MISS_S later, said once per reason (log, feed, event stack-reset-miss)
 *  and counted on /state. A press counts a tick whatever came of it. */
function tickBox(): void {
  const R = S.stackReset;
  R.needTick = false;
  background(async () => {
    const res = await stackResetSeams.tick(R.clicked);
    const pressed = !!(res.pressed || res.clicked);
    R.clicked = R.clicked || pressed;
    const { html: _h, ...result } = res;
    R.lastTick = { at: nowMs(), ...result };
    if (!res.ok && !pressed) {
      R.misses += 1;
      R.retryAt = time() + STACK_RESET_MISS_S;
      if (R.state === "armed") R.needTick = true;
      const why = pyStr(res.why ?? null);
      if (why !== R.lastMissWhy) {
        R.lastMissWhy = why;
        log(`[stack-reset] nothing pressed (read ${R.misses}, no tick spent — ${R.ticks}/${STACK_RESET_TICKS} so far): ${pyRepr(result)}; trying again every ${STACK_RESET_MISS_S} s`);
        feedAdd(`Deep stack: "Sit out next big blind" not pressed yet (${why}) — trying again every ${STACK_RESET_MISS_S} s`);
        event("stack-reset-miss", { misses: R.misses, ticks: R.ticks, result });
      } else if (R.misses % 12 === 0) {
        log(`[stack-reset] still nothing pressed after ${R.misses} reads (${why})`);
      }
      return;
    }
    R.ticks += 1;
    log(`[stack-reset] tick ${R.ticks}/${STACK_RESET_TICKS}: ${pyRepr(result)}`);
    event("stack-reset-tick", { attempt: R.ticks, result });
    if (res.ok) return;
    feedAdd(`Deep stack: could not tick "Sit out next big blind" (${pyStr(res.why ?? null)})`);
    if (R.ticks >= STACK_RESET_TICKS) await abort(`could not tick the box: ${pyStr(res.why ?? null)}`);
    else if (R.state === "armed") R.needTick = true;            // tried again on a later tick
  });
}

/** The leave itself (inside the background step that asked the leader). */
async function leave(): Promise<void> {
  const R = S.stackReset;
  setState("leaving");
  R.oldRid = S.tapBound;
  R.oldTag = S.frame.tag;
  let told = 0;
  if (TABLES.slot() !== null && R.oldRid) {
    try {
      told = await stackResetSeams.tellPeers({ sid: S.session.id, slot: TABLES.slot(), rid: R.oldRid });
    } catch (e: any) {
      log(`[stack-reset] telling the other tables: ${e?.message ?? e}`);
    }
  }
  markLeaving();
  let res: Record<string, any>;
  try {
    res = await stackResetSeams.leave();
  } catch (e: any) {
    res = { ok: false, error: String(e?.message ?? e) };
  }
  if (!res.ok) return abort(`the leave failed: ${pyStr(res.error ?? null)}`);
  R.leftAt = time();
  R.notBefore = R.leftAt + R.waitS;
  setState("waiting");
  // our frame and socket are gone: the next table the client opens is read and bound as this slot's
  forgetFrame();
  if (R.oldRid) tapForget(R.oldRid);
  feedAdd(`Deep stack: left the table — a fresh one in ${R.waitS} s`);
  log(`[stack-reset] left (socket ${pyStr(R.oldRid)}, frame ${pyStr(R.oldTag)}; ${told} other table(s) told) — new seat due in ${R.waitS} s`);
  event("stack-reset-left", { rid: R.oldRid, tag: R.oldTag, waitS: R.waitS, peersTold: told });
  const r = await stackResetSeams.tellLeader({ sid: S.session.id, slot: TABLES.slot(), phase: "left", notBefore: R.notBefore });
  if (!(r && r.ok)) log(`[stack-reset] the leader did not take the 'left' note (${pyStr((r || {}).error ?? null)}) — it seats on its own clock`);
}

/** Give the reset up: hero back in if he is sitting out, the leader's note withdrawn; play goes on under the API's cap. */
async function abort(why: string): Promise<void> {
  const R = S.stackReset;
  const phase = R.state;
  setState("idle");
  R.needTick = false;
  countAbort(why);
  let back: Record<string, any> | null = null;
  if (S.liveStatus.hero === "sitting-out" && !S.disconnect) {
    try {
      back = await stackResetSeams.sitBack();
    } catch (e: any) {
      back = { ok: false, why: String(e?.message ?? e) };
    }
  }
  feedAdd(`Deep stack reset given up (${why})` + (back ? (back.ok ? " — pressed I AM BACK" : ` — could NOT press I AM BACK (${pyStr(back.why ?? null)}): press it yourself`) : ""));
  log(`[stack-reset] aborted in ${phase}: ${why}; I AM BACK ${pyRepr(back)}`);
  event("stack-reset-aborted", { why, phase, sitBack: back ? { ok: !!back.ok, why: back.why ?? null } : null });
  sayOff(why);
  if (phase === "sat-out" || phase === "leaving") {
    try {
      await stackResetSeams.tellLeader({ sid: S.session.id, slot: TABLES.slot(), phase: "aborted" });
    } catch {}
  }
}

/** One more abort on the session's count; the reset re-arms no sooner than STACK_RESET_RETRY_HANDS hands from now. */
function countAbort(why: string): void {
  const R = S.stackReset;
  R.aborts += 1;
  R.abortedAt = S.handNo;
  R.lastAbortWhy = why;
}

/** The abort that reached STACK_RESET_MAX_ABORTS: said once — feed, log, event stack-reset-off. */
function sayOff(why: string): void {
  const R = S.stackReset;
  if (R.aborts !== STACK_RESET_MAX_ABORTS) return;
  feedAdd(`Deep stack reset is OFF for the rest of this session (${R.aborts} aborts; the last: ${why}) — deep hands play under the API's 250 bb cap`);
  log(`[stack-reset] off for the rest of the session after ${R.aborts} aborts (the last: ${why})`);
  event("stack-reset-off", { aborts: R.aborts, why });
}

/** /state `stackReset` (only while the session has the reset on): the machine, readable without the log. */
export function stackResetBrief(): Record<string, any> {
  const R = S.stackReset;
  const lt = R.lastTick;
  return {
    state: R.state, bb: R.bb, waitS: R.waitS, since: R.since || null, forS: R.since ? pyRound(time() - R.since, 1) : null,
    busy: R.busy, armedHand: R.state === "idle" ? null : R.armedHand, stackBb: R.stackBb,
    ticks: R.ticks, maxTicks: STACK_RESET_TICKS, clicked: R.clicked, misses: R.misses,
    retryInS: R.state === "armed" && R.needTick && R.retryAt > time() ? pyRound(R.retryAt - time(), 1) : null,
    bbHands: [...R.bbHands],
    lastTick: lt ? { at: lt.at ?? null, ok: !!lt.ok, why: lt.why ?? null, state: lt.state ?? null, method: lt.method ?? null,
                     via: lt.via ?? null, pressed: !!(lt.pressed || lt.clicked) } : null,
    aborts: R.aborts, maxAborts: STACK_RESET_MAX_ABORTS, lastAbortWhy: R.lastAbortWhy,
    abortedHand: R.abortedAt, off: R.aborts >= STACK_RESET_MAX_ABORTS,
    notBefore: R.state === "waiting" || R.state === "reseating" ? R.notBefore : null,
  };
}

/** POST /table/peer-leaving — a sibling table is about to leave its table on purpose: its socket closing is not ours to
 *  weigh (ignition/reader.ts noteSocketClosed, the !ours branch; state.ts peerIsLeaving). */
export function peerLeaving(body: Record<string, any>): [number, Record<string, any>] {
  const sid = String(body.sid || "");
  const rid = body.rid === undefined || body.rid === null ? "" : String(body.rid);
  if (!S.session.id || (sid && sid !== S.session.id) || !rid) return [200, { ok: false, noted: false }];
  const m = S.stackReset.peerLeaving;
  for (const [k, at] of m) if (time() - at > PEER_LEAVING_S) m.delete(k);
  m.set(rid, time());
  log(`[stack-reset] table ${pyStr(body.slot ?? null)} is leaving its table on purpose — its socket ${rid} closing is not a drop`);
  return [200, { ok: true, noted: true }];
}
