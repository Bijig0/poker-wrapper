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
 * STACK_RESET_RETRY_HANDS hands, and not at all after STACK_RESET_MAX_ABORTS aborts in a session.
 */
import * as cdp from "./cdp";
import { nowMs, sleep, time } from "./clock";
import { C } from "./config";
import { feedAdd, log } from "./feed";
import { postJson } from "./http";
import { js } from "./js";
import { pyRepr, pyRound, pyStr } from "./py";
import { PEER_LEAVING_S, S, inAHand, isClientSite, seams, type StackResetState } from "./state";
import * as TABLES from "./tables";
import { forgetFrame, mySel, slotted, type FrameSel } from "./ignition/dom";
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

/** Finds "Sit out next big blind" on one table: {ok, found, checked (null = unknown), back, seated, x, y}. */
export const sitoutBbReadJs = (sel: FrameSel = null) => slotted(js("stackreset.SITOUT_BB_READ_JS_TMPL"), sel);

/** Tick "Sit out next big blind" on OUR table — reads first, clicks only when the box reads unticked, or its state is
 *  unreadable and this reset has not clicked it yet (`clickedBefore`). netguard.ignitionSitoutNextHand's pattern. */
export async function ignitionSitoutNextBb(clickedBefore: boolean): Promise<Record<string, any>> {
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, why: "poker client not open" };
  const ws = t.webSocketDebuggerUrl;
  const read = sitoutBbReadJs(mySel());
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, read, 6)) || {};
  } catch (e: any) {
    return { ok: false, why: `table read failed: ${e?.message ?? e}` };
  }
  if (!d.ok) return { ok: false, why: d.reason || "table not readable" };
  if (d.back) return { ok: true, state: "already sitting out (I'm back is showing)" };
  if (!d.found) return { ok: false, why: "no 'Sit out next big blind' box on the table" + (d.seated ? "" : " - not seated") };
  if (d.checked === true) return { ok: true, state: "already ticked", via: d.via ?? null };
  if ((d.checked === null || d.checked === undefined) && clickedBefore) {
    return { ok: true, state: "clicked earlier (tick state unreadable)", html: d.html ?? null };
  }
  const lk = await TABLES.pressLock();
  try {
    const blind = await ensureVisible(ws);
    if (blind) return { ok: false, why: blind };
    const wrong = await pointIsMyTable(ws, d.x, d.y);
    if (wrong) return { ok: false, why: wrong };
    try {
      await cdp.dispatchClick(ws, d.x, d.y);
    } catch (e: any) {
      return { ok: false, why: `click did not go through: ${e?.message ?? e}` };
    }
  } finally {
    lk.release();
  }
  await sleep(0.4);
  let after: Record<string, any> = {};
  try {
    after = (await cdp.evaluate(ws, read, 6)) || {};
  } catch {
    after = {};
  }
  if (after.checked === false && d.checked === false) {
    return { ok: false, why: "clicked, but the box still reads unticked", clicked: true, html: after.html ?? null };
  }
  return { ok: true, clicked: true, state: after.checked ? "ticked" : "clicked (tick state unreadable - check the table)",
           via: d.via ?? null, html: after.checked ? null : d.html ?? null };
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
      Object.assign(R, { armedHand: S.handNo, stackBb: st, ticks: 0, clicked: false, needTick: true, lastTick: null, bbHands: [] });
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
        Object.assign(R, { armedHand: 0, stackBb: null, ticks: 0, clicked: false, needTick: false, bbHands: [], oldRid: null, oldTag: null });
        feedAdd(`Deep stack: seated at a fresh table (${waited} s after leaving the old one)`);
        log(`[stack-reset] done: frame ${pyStr(tag)}, socket ${pyStr(rid)} (${waited} s after the leave)`);
        event("stack-reset-done", { waitedS: waited, tag, rid });
        return;
      }
      if (now - R.notBefore > STACK_RESET_RESEAT_S) {
        setState("idle");
        R.aborts += 1;
        R.abortedAt = S.handNo;
        feedAdd("Deep stack: no new table came up for this slot — check the lobby and the leader's panel");
        log(`[stack-reset] gave up waiting for the new table (${STACK_RESET_RESEAT_S} s after the wait)`);
        event("stack-reset-aborted", { why: `no new table seated, pinned and bound within ${STACK_RESET_RESEAT_S} s of the wait`, phase: "reseating" });
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
  // a hand after the arming in which hero still posted the big blind: the tick did not take
  if (S.handNo > R.armedHand && heroPostedBb() && !R.bbHands.includes(S.handNo)) {
    R.bbHands.push(S.handNo);
    if (R.ticks >= STACK_RESET_TICKS) {
      await abort(`the box did not take: hero posted the big blind after ${R.ticks} tick(s)`);
      return;
    }
    log(`[stack-reset] hero posted the big blind in hand ${S.handNo} — the tick did not take; ticking again`);
    Object.assign(R, { needTick: true, clicked: false });
  }
  // the press waits while hero is on the clock or a notice is up (nothing is clicked over a decision)
  if (R.needTick && !S.liveStatus.toAct && !S.liveStatus.modal) tickBox();
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

/** Tick the box, in the background. */
function tickBox(): void {
  const R = S.stackReset;
  R.needTick = false;
  R.ticks += 1;
  background(async () => {
    const res = await stackResetSeams.tick(R.clicked);
    R.clicked = R.clicked || !!res.clicked;
    const { html: _h, ...result } = res;
    R.lastTick = { at: nowMs(), ...result };
    log(`[stack-reset] tick ${R.ticks}/${STACK_RESET_TICKS}: ${pyRepr(result)}`);
    event("stack-reset-tick", { attempt: R.ticks, result });
    if (res.ok) return;
    feedAdd(`Deep stack: could not tick "Sit out next big blind" (${pyStr(res.why ?? null)})`);
    if (R.ticks >= STACK_RESET_TICKS) await abort(`could not tick the box: ${pyStr(res.why ?? null)}`);
    else R.needTick = true;            // tried again on a later tick
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
  R.aborts += 1;
  R.abortedAt = S.handNo;
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
  if (phase === "sat-out" || phase === "leaving") {
    try {
      await stackResetSeams.tellLeader({ sid: S.session.id, slot: TABLES.slot(), phase: "aborted" });
    } catch {}
  }
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
