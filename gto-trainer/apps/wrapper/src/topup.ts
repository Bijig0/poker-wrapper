/**
 * AUTO TOP-UP (launch.py 2026-09-18 → 23): whenever hero's stack is below the ring table's max buy-in, buy back up
 * to it — the client's own Buy-chips panel, its own Max amount, pressed the way a player would. The windows, the
 * hard blocks and the history behind each rule are in launch.py's comments over _top_up_window and _topup_prefold;
 * in short:
 *
 *   pre-fold / pre-action  hero is on the clock and the (auto-armed) answer is TERMINAL: buy first, then act —
 *                          the one window whose END we control (bounded by its budget, and the panel has a fuse)
 *   not-dealt              hero is sitting out / waiting / not dealt in: the whole hand is a window
 *   fold                   hero's fold is confirmed: stack behind is already final
 *   showdown (…)           nothing left for hero to decide while the board runs out
 *   hand-over              the client's end-of-hand marker, once hero's stack has stopped moving
 *
 * HARD BLOCKS: a client notice over the strip; a run that was called off; hero on the clock (except pre-action).
 * A run is one async task at a time (Python's lock + thread); `S.topupLocked` is the "a run is in flight" signal.
 *
 * WHEN vs WHETHER (2026-10-04, session_20261003_234358): the windows above decide only WHEN; WHETHER hero needs chips
 * and HOW MANY is one pure function, topupNeed.ts topUpNeed, fed from the table's own socket where it has the number
 * (hero's stack as dealt, at a hand's end, after a buy) and the screen only where it does not. It runs at every deal
 * hero is in (one `top-up-need` event per hand, the KPI, the stall alarm), at every open window, and before the
 * presses. The 180 s "a press is pending" lockout that silently blocked every window is gone: a pending buy is
 * settled by evidence (a receipt, a refusal, the stack at the deal, a hand end with nothing to show), and while it
 * blocks it says so.
 */
import * as cdp from "./cdp";
import { nowMs, sleep, time } from "./clock";
import { C } from "./config";
import { feedAdd, log } from "./feed";
import { fmtFixed, pyFloat, pyRepr, pyRound, pyStr } from "./py";
import { S, seams } from "./state";
import * as TERMINAL from "./terminal";
import { mySel, topupFillJs, topupReadJs } from "./ignition/dom";
import { handState, stripButtonsUp } from "./ignition/hand";
import { act, autoTableOk, heroTimeLeft, maybeTakeTime, pickReady } from "./relay";
import { topUpNeed, topUpTolCents, type NeedPoint, type NeedVerdict } from "./topupNeed";

/** What a test replaces: the table read, the time-bank press, and how a run is started (Python's tests stubbed
 *  _top_up_read, _maybe_take_time and threading.Thread). */
export const topupSeams = {
  read: (): Promise<Record<string, any>> => topUpRead(),
  takeTime: (): Promise<Record<string, any> | null> => maybeTakeTime(),
  spawn: (_name: string, f: () => Promise<unknown>): void => { void f(); },
};

const TOP_UP_COOLDOWN_S = 20.0;
const TOP_UP_SETTLE_TICKS = 2;
/** The small wait before a run's first press, drawn once per window (a test sets it to zero). */
export const topupTuning = { jitterS: [0.4, 2.0] as [number, number] };
const TOP_UP_CLOSE_DEBOUNCE_S = 1.5;

/** The table's own numbers: hero's stack, the ring max, and the Buy-chips panel when it is open. */
export async function topUpRead(): Promise<Record<string, any>> {
  const t = await seams.ignitionTarget();
  if (!t) return { seated: false, reason: "poker client not open" };
  try {
    return (await cdp.evaluate(t.webSocketDebuggerUrl, topupReadJs(mySel()), 6)) || { seated: false, reason: "empty read" };
  } catch (e: any) {
    return { seated: false, reason: `table read failed: ${e?.message ?? e}` };
  }
}

/** The key the once-per-hand guards hang on: the CLIENT's hand id where there is one. */
export function handKey(): string {
  return S.handIds.get(S.handNo) || `local-${S.handNo}`;
}

/** Has hero's stack stopped moving? Counted EVERY tick (a counter that advances only while someone looks never
 *  reaches two). */
export function topUpSettleTick(): void {
  const hero = S.ws.heroSeat ?? null;
  const seats = S.feedPrev.seats;
  const stack = (seats instanceof Map ? seats.get(hero) : undefined)?.stack ?? null;
  const st = (S.study.stackStable ??= { text: null, ticks: 0 });
  if (stack === st.text) st.ticks = (st.ticks || 0) + 1;
  else Object.assign(st, { text: stack, ticks: 1 });
}

/** Is there a safe window to buy chips RIGHT NOW, and which one? [open, trigger, why-not] */
export function topUpWindow(): [boolean, string | null, string | null] {
  const p = S.feedPrev;
  if (!p.seated) return [false, null, "not seated"];
  if (p.waiting) return [false, null, "waiting for the next hand"];
  if (S.liveStatus.modal) return [false, null, "a client notice is on screen"];
  if (S.topupAbort) return [false, null, "the window closed under the run"];
  if (S.topupPrefold.active) {
    if (time() < S.topupPrefold.deadline) return [true, "pre-fold", null];
    return [false, null, "the pre-fold budget ran out"];
  }
  if (p.toAct || S.liveStatus.toAct) return [false, null, "hero is on the clock"];
  if (["sitting-out", "waiting-for-bb", "not-in-hand"].includes(S.liveStatus.hero)) return [true, "not-dealt", null];
  if (S.ws.heroFolded) return [true, "fold", null];
  if (!S.ws.handOver) {
    // SHOWDOWN PENDING: nothing left for hero to decide while the client runs out the board
    let done: TERMINAL.TerminalVerdict | null = null;
    try {
      done = TERMINAL.heroDone(handState());
    } catch {
      done = null;
    }
    if (done && done.terminal) return [true, `showdown (${done.kind})`, null];
    return [false, null, "a hand is live for hero"];
  }
  if (((S.study.stackStable || {}).ticks ?? 0) < TOP_UP_SETTLE_TICKS) return [false, null, "waiting for the pot award to land"];
  return [true, "hand-over", null];
}

/** Is it safe to press a Buy-chips control RIGHT NOW? Re-read before EVERY press (the same rules). */
export function topUpGate(): [boolean, string | null] {
  const [ok, , why] = topUpWindow();
  return [ok, why];
}

/** Fold the Buy-chips panel back off the action strip (safe to call twice: "Buy chips" is a TOGGLE). */
export async function closeBuyPanel(): Promise<void> {
  if (!S.topupPanel.open) return;
  // closed only when the close press WENT THROUGH (2026-09-25 audit): the flag used to drop first and the result was
  // ignored, so a refused close left the panel up while every later check believed it gone
  try {
    const r = await seams.act("Buy chips", "button");
    if (r?.ok) S.topupPanel.open = false;
    else log(`[top-up] could not close the Buy-chips panel: ${r?.reason ?? "refused"}`);
  } catch (e: any) {
    log(`[top-up] could not close the Buy-chips panel: ${e?.message ?? e}`);
  }
}

/** Hero put on the clock with the panel up: close it NOW and call the run off (the DOM decides, not our flag). */
export async function maybeGuardBuyPanel(): Promise<void> {
  if (!(S.liveStatus.buyPanel || S.topupPanel.open)) return;
  if (!(stripButtonsUp() || S.feedPrev.toAct)) return;
  // THE ONE SANCTIONED EXCEPTION, with a fuse: a pre-action run holding the clock on purpose
  if (S.topupPrefold.active) {
    if (time() < S.topupPrefold.deadline) return;
    S.topupPrefold.active = false;
    feedAdd("Pre-action top-up out of time - closing the panel so the action can go");
    log("[top-up] pre-action budget spent; closing the panel so the action can go");
  }
  S.topupAbort = true;
  // ONE CLOSE PER EPISODE: a re-press every tick toggles it open again
  if (time() - (S.topupPanel.lastCloseAt ?? 0.0) < TOP_UP_CLOSE_DEBOUNCE_S) return;
  if (S.liveStatus.buyPanel) S.topupPanel.open = true;
  S.topupPanel.lastCloseAt = time();
  await closeBuyPanel();
  feedAdd("Buy-chips panel closed - hero is on the clock");
}

/** Is this pick TERMINAL for hero (read off the PLAN the relay would send)? */
function terminalPick(r: Record<string, any>): TERMINAL.TerminalVerdict {
  return TERMINAL.isTerminal(r.plan || {}, handState());
}

export function prefoldPickIsFold(r: Record<string, any>): boolean {
  return terminalPick(r).kind === "fold";
}

/** THE EXPECTED REFUSAL: a buy pressed before a terminal action hero could still WIN lands above the max; the
 *  client refuses it at the next hand with a notice. Filed against the press it belongs to; presses nothing. */
export function noteTopUpRefusal(m: Record<string, any> | null): void {
  if (!["buy-in above the table maximum", "buy-in maximum notice"].includes((m || {}).harmless)) return;
  markTopUpRefused("the client's notice");
}

/**
 * The pressed buy the client refused: the record settled (a refused press does not block the next window) and the
 * refusal filed against it, once. `how` = the word it came by — the client's notice (noteTopUpRefusal), or the table's
 * socket (ws.ts PLAY_ACCOUNT_CASH_RES type 5 / cash 0, 2026-09-30), which says it seconds BEFORE the notice and
 * whether or not a screen read ever gets to the notice. Returns whether a press was settled by this call.
 */
export function markTopUpRefused(how: string): boolean {
  const rec = S.study.lastTopUp || {};
  if (!rec.pressed || rec.receiptCents || rec.refused) return false;
  if (time() * 1000 - (rec.at || 0) > 180_000) return false;
  Object.assign(rec, { ok: false, refused: true, refusedBy: how,
                       reason: "refused by the client at the next hand — hero's stack was above the max (won the pot after the buy)" });
  feedAdd(`Top-up $${fmtFixed((rec.amountCents || 0) / 100, 2)} refused (${how}) — hero finished above the max; the next window decides again`);
  if (S.session.id) {
    S.sessions.event(S.session.id, "top-up-refused-over-max", {
      hand: S.handNo, handKey: handKey(), amountCents: rec.amountCents ?? null, pressedHandKey: rec.handKey ?? null,
      trigger: rec.trigger ?? null, terminalKind: rec.terminalKind ?? null, how,
    });
  }
  return true;
}

// ---- hero's money on the table's socket ---------------------------------------------------------------------------
/**
 * WHAT THE TABLE'S SOCKET SAYS ABOUT HERO'S MONEY (2026-10-04, measured on both tables of session_20261003_234358 and
 * checked against every buy in the dumps since 2026-09-25). Every frame the tap takes passes here (ws.ts onGameMsg):
 *  - CO_RESULT_INFO {account[9]}: every seat's stack at the hand's end (index = seat − 1), BEFORE a buy pressed during
 *    the hand is added. Exact where the screen lags the pot award: hand 4922342889 (table 2) ended with hero at 507, the
 *    felt still read 495 two ticks later, and the hand-over window pressed a buy the client could only open at "Max. $0".
 *  - PLAY_ACCOUNT_CASH_RES {type 2, seat, cash}: a seat's buy went through and `cash` is its NEW stack. For hero's seat it
 *    is THE RECEIPT, exact and whatever the screen shows — it arrives at the end of the hand in progress (0.25 s after
 *    PLAY_STAGE_END_REQ: a buy is added when the hand ends, folded or not; at once when hero is not dealt in). For other
 *    seats: their own buy-ins and rebuys. (Type 5 cash 0 = refused — ws.ts files it.)
 *  - PLAY_ACCOUNT_INFO {account}: hero's stack — sent as he folds (and when he leaves the hand), NOT at each deal.
 *  - PLAY_BUYIN_INFO {type 1, seat, displayMax, allowedMax}: the Buy-chips panel opening — the table max, and what may
 *    still be added (0 = nothing: hero is at or above the max).
 * Each note carries its socket and hand: a note from another table's socket (a re-bind) or an older hand is never read.
 */
export function noteTopUpFrame(d: Record<string, any>): void {
  const pid = d.pid;
  const T = S.topupSock;
  const hero = S.ws.heroSeat ?? S.liveStatus?.heroSeatDom ?? null;
  const rid = S.tapBound ?? null;
  const now = time();
  if (pid === "CO_RESULT_INFO" || pid === "PLAY_STAGE_END_REQ") {
    if (T.endHand !== S.handNo) {
      T.endHand = S.handNo;
      T.ends.push(Math.trunc(now * 1000));
      keepLastN(T.ends, 20);
    }
    const acc = Array.isArray(d.account) ? d.account : null;
    if (pid === "CO_RESULT_INFO" && hero !== null && acc && typeof acc[hero - 1] === "number") {
      T.end = { cents: acc[hero - 1], at: now, handNo: S.handNo, rid };
    }
  } else if (pid === "PLAY_ACCOUNT_INFO" && typeof d.account === "number") {
    T.account = { cents: d.account, at: now, handNo: S.handNo, rid };
  } else if (pid === "PLAY_BUYIN_INFO" && d.type === 1 && (hero === null || d.seat === hero)) {
    T.buyin = { allowedMax: d.allowedMax ?? null, displayMax: d.displayMax ?? null, at: now, handNo: S.handNo, rid };
  } else if (pid === "PLAY_ACCOUNT_CASH_RES" && d.type === 2 && hero !== null && d.seat === hero && Number(d.cash) > 0) {
    topUpSocketReceipt(Number(d.cash));
  }
}

function keepLastN<T>(xs: T[], n: number): void {
  if (xs.length > n) xs.splice(0, xs.length - n);
}

const sockMine = (e: Record<string, any> | null): e is Record<string, any> => !!e && e.rid === (S.tapBound ?? null);

/**
 * THE SOCKET'S RECEIPT for hero's buy: settles the pending record exactly (what was added = the new stack less hero's
 * stack before it: his stack at this hand's end when the buy waited for one, else his stack at the press) and files the
 * `top-up-receipt` event, source "socket". A screen receipt for the same buy (checks.ts topUpReceipt) is then only noted
 * on the record. A seat-down buy-in with no pressed record is noted and nothing else.
 */
export function topUpSocketReceipt(cash: number): void {
  const T = S.topupSock;
  const now = time();
  T.cash = { cents: cash, at: now, handNo: S.handNo, rid: S.tapBound ?? null };
  const rec = S.study.lastTopUp;
  const pressAt = rec ? Number(rec.pressedAtMs ?? rec.at ?? 0) || 0 : 0;
  if (!rec || !rec.pressed || rec.refused || now * 1000 - pressAt > 15 * 60_000) {
    log(`[top-up] socket: hero's stack is now ${cash}c after a buy-in (no pressed top-up waiting for it)`);
    return;
  }
  if (rec.receiptCents) {
    // the screen's receipt came first: the same buy, now confirmed exactly
    if (!rec.socketCents) Object.assign(rec, { socketCents: cash, afterCents: cash, receiptSource: "screen+socket" });
    log(`[top-up] socket confirms the buy the screen's receipt settled: stack now ${cash}c`);
    return;
  }
  const end = sockMine(T.end) && T.end.at * 1000 >= pressAt - 500 ? T.end.cents : null;
  const base = end ?? rec.beforeCents ?? null;
  let added = base !== null && base !== undefined ? cash - base : Number(rec.amountCents) || 0;
  if (!(added > 0)) added = Number(rec.amountCents) || 0;
  const wasLost = !!rec.lost;
  Object.assign(rec, { ok: true, receiptCents: added, receiptSource: "socket", socketCents: cash, afterCents: cash, lost: false,
                       reason: rec.ok && !wasLost ? rec.reason : `confirmed by the table's socket ($${fmtFixed(added / 100, 2)} added, stack $${fmtFixed(cash / 100, 2)})` });
  feedAdd(`Top-up receipt (table socket) — $${fmtFixed(added / 100, 2)} added, stack $${fmtFixed(cash / 100, 2)}`
          + (wasLost ? " (it had been given up as lost)" : ""));
  if (S.session.id) {
    S.sessions.event(S.session.id, "top-up-receipt", {
      source: "socket", amount: fmtFixed(added / 100, 2), amountCents: added, cashCents: cash, hand: S.handNo, handKey: handKey(),
      pressedHandKey: rec.handKey ?? null, trigger: rec.trigger ?? null, afterLost: wasLost, at: Math.trunc(now * 1000),
    });
  }
}

/**
 * HERO'S STACK AS DEALT, off the socket: the stack his first frame this hand implies (ws.ts startCents — the blinds'
 * frames carry it at the deal itself), else his stack at the previous hand's end plus any buy that landed since.
 * Null when this socket has no word on it (the screen decides then).
 */
export function sockDealtStack(): { cents: number; source: string } | null {
  const hero = S.ws.heroSeat ?? null;
  const start: Map<number, number> | undefined = S.ws.startCents;
  if (hero !== null && start?.has(hero)) return { cents: start.get(hero)!, source: "socket: as dealt" };
  return sockBetweenHands(S.handNo - 1);
}

/** Hero's stack between hands: hand `endHand`'s end, or the buy that landed after it. */
function sockBetweenHands(endHand: number): { cents: number; source: string } | null {
  const T = S.topupSock;
  if (!sockMine(T.end) || T.end.handNo !== endHand) return null;
  if (sockMine(T.cash) && T.cash.at >= T.end.at) return { cents: T.cash.cents, source: "socket: after the buy" };
  return { cents: T.end.cents, source: "socket: last hand's end" };
}

/**
 * HERO'S STACK NOW, off the socket, where it is final: this hand's end (and a buy since), his chips behind once he has
 * folded (his fold frame's account, or PLAY_ACCOUNT_INFO), his chips behind on any open window of a hand he is in (a
 * pre-action buy, a showdown), or — not dealt in — the last hand's end. Null when the socket has no word.
 */
export function sockStackNow(): { cents: number; source: string } | null {
  const T = S.topupSock;
  const hero = S.ws.heroSeat ?? null;
  const ended = sockBetweenHands(S.handNo);
  if (ended) return ended;
  const dealtIn = hero !== null && (S.ws.dealt || []).includes(hero) && S.ws.heroDealt !== false;
  if (dealtIn) {
    if (S.ws.heroFolded && sockMine(T.account) && T.account.handNo === S.handNo) return { cents: T.account.cents, source: "socket: as he folded" };
    const behind: Map<number, number> | undefined = S.ws.wsAccount;
    if (behind?.has(hero!)) return { cents: behind.get(hero!)!, source: "socket: chips behind" };
    return null;
  }
  return sockBetweenHands(S.handNo - 1);
}

/** The Buy-chips panel's offer, as the socket gave it when the panel opened after `since` (s). */
function sockAllowed(since: number): number | null {
  const b = S.topupSock.buyin;
  return sockMine(b) && b.at >= since && typeof b.allowedMax === "number" ? b.allowedMax : null;
}

/**
 * The need at `point`, with everything the wrapper knows: the socket's stack where it has one, else `dom.stackCents`
 * (the caller's read of the felt — at the deal, with what hero posted added back); the max and big blind off the table
 * read (or the last one, or the panel's own displayMax).
 */
export function needFor(point: NeedPoint, dom: Record<string, any> = {}, allowedMaxCents: number | null = null): NeedVerdict {
  const sock = point === "deal" ? sockDealtStack() : sockStackNow();
  const domStack = typeof dom.stackCents === "number" ? dom.stackCents : null;
  const cached = S.study.topUpMax || {};
  const maxCents = dom.maxCents || cached.maxCents || S.topupSock.buyin?.displayMax || null;
  const bbCents = dom.bbCents || cached.bbCents || (S.ws.bbSeen && !S.ws.bbGuessed ? S.ws.bb : null) || null;
  return topUpNeed({
    point, handKey: handKey(), handNo: S.handNo,
    stackCents: sock ? sock.cents : domStack, stackSource: sock ? sock.source : domStack !== null ? "screen" : null,
    maxCents, bbCents, zone: !!dom.zone,
    pending: S.study.lastTopUp || null, handEndsMs: [...S.topupSock.ends], nowMs: Math.trunc(time() * 1000),
    allowedMaxCents, stackReset: S.stackReset?.state ?? null,
  });
}

/**
 * A pending buy the evidence has settled: LANDED (the stack at the deal shows it — no receipt was read) or LOST (a hand
 * ended after the press, nothing came of it). Settled once; a lost buy no longer blocks, so the next window may press.
 */
export function settlePending(v: NeedVerdict): void {
  const rec = S.study.lastTopUp;
  if (!rec || !rec.pressed || rec.receiptCents || rec.refused || rec.landed || rec.lost) return;
  if (v.pendingVerdict === "landed") {
    Object.assign(rec, { ok: true, landed: true, landedBy: v.pendingWhy, reason: `landed: ${v.pendingWhy}` });
    log(`[top-up] the $${fmtFixed((rec.amountCents || 0) / 100, 2)} buy of hand ${pyStr(rec.handKey ?? null)} landed — ${v.pendingWhy}`);
  } else if (v.pendingVerdict === "lost") {
    Object.assign(rec, { ok: false, lost: true, lostWhy: v.pendingWhy, reason: `lost: ${v.pendingWhy}` });
    feedAdd(`⚠ Top-up $${fmtFixed((rec.amountCents || 0) / 100, 2)} (hand ${pyStr(rec.handKey ?? null)}) never landed — ${v.pendingWhy}; the next window may buy again`);
    log(`[top-up] LOST: the $${fmtFixed((rec.amountCents || 0) / 100, 2)} buy of hand ${pyStr(rec.handKey ?? null)} — ${v.pendingWhy}`);
    if (S.session.id) {
      S.sessions.event(S.session.id, "top-up-lost", {
        hand: S.handNo, handKey: handKey(), pressedHandKey: rec.handKey ?? null, amountCents: rec.amountCents ?? null,
        beforeCents: rec.beforeCents ?? null, stackCents: v.stackCents, stackSource: v.stackSource, trigger: rec.trigger ?? null,
        why: v.pendingWhy,
      });
    }
  }
}

/** The fields a `top-up-need` event (and the logs) carry. */
function needFields(v: NeedVerdict): Record<string, any> {
  const rec = S.study.lastTopUp || {};
  return { need: v.need, known: v.known, shortCents: v.shortCents, shortBb: v.shortBb, stackCents: v.stackCents,
           stackSource: v.stackSource, amountCents: v.amountCents, blockedBy: v.blockedBy, pendingVerdict: v.pendingVerdict,
           pendingWhy: v.pendingWhy, pendingAmountCents: v.pendingVerdict ? rec.amountCents ?? null : null, why: v.why };
}

/** A window opened and the need said no press: said once per hand — in the log when hero needs nothing, as a
 *  `top-up-need` event (point "final") when he needs chips and something stands in the way. Never silent. */
function sayFinal(v: NeedVerdict, trigger: string | null): void {
  const hid = handKey();
  if (S.topupNeed.finalSaid === hid) return;
  S.topupNeed.finalSaid = hid;
  S.topupNeed.last = { point: "final", hand: hid, ...needFields(v) };
  if (!v.blockedBy) {
    log(`[top-up] ${trigger} window, hand ${hid}: no buy — ${v.why}` + (v.stackSource ? ` (${v.stackSource})` : ""));
    return;
  }
  log(`[top-up] ${trigger} window, hand ${hid}: ${v.need ? "NEEDED but" : "a buy may be due but"} held — ${v.blockedBy}`);
  feedAdd(`Top-up ${v.need ? `needed (${v.shortBb ?? "?"} bb short)` : "window"} but held — ${v.blockedBy}`);
  if (S.session.id) S.sessions.event(S.session.id, "top-up-need", { point: "final", trigger, hand: S.handNo, handKey: hid, ...needFields(v) });
}

/** Seconds of hero's clock the pre-action buy leaves for the action itself (auto delay ≤ 2 s, the press, a retry). */
const PREFOLD_ACT_RESERVE_S = 6.0;
/** A buy with less time than this is not started at all. */
const PREFOLD_MIN_BUDGET_S = 2.0;

/** Buy the chips BEFORE a TERMINAL action, while we still hold the clock (auto armed, practice table). */
export async function maybePrefoldTopUp(): Promise<void> {
  const st = S.study;
  if (!(C.TOP_UP_PREFOLD && st.topUp && st.on && S.session.id) || S.fakeMode) return;
  if (S.topupPrefold.active || S.topupLocked || S.topupAbort) return;
  if (!st.auto) return;
  const [ok] = autoTableOk();
  if (!ok) return;
  if (!(stripButtonsUp() || S.feedPrev.toAct)) return;
  if (S.liveStatus.modal || S.liveStatus.buyPanel) return;
  const r = pickReady();
  if (!r.ok) return;
  const verdict = terminalPick(r);
  if (!verdict.terminal) return;
  if (st.uncertain) return;
  const hid = handKey();
  if (S.topupPrefold.hand === hid || st.topUpHand === hid) return;
  // a buy still in flight holds this one (it SAYS so — the 180 s silent lockout is gone: a pending buy is settled by
  // evidence, topupNeed.ts); checked before the read so a blocked hand costs no table read per tick
  const pre = needFor("press");
  if (pre.pendingVerdict === "lost") settlePending(pre);
  if (pre.pendingVerdict === "pending") return;
  const read = await topupSeams.read();
  if (read.zone || !read.seated || read.stackCents === null || read.stackCents === undefined || !read.maxCents) return;
  // WHETHER and HOW MUCH: the need, on the socket's chips behind where it has them (exact), else this read
  const v = needFor("press", read);
  if (!v.need || v.blockedBy) return;
  const short = v.shortCents!;
  if (S.topupLocked) return;
  S.topupNeed.lastAttemptAt = time();
  S.topupLocked = true;
  // THE CLOCK: "+45s" first (the panel would cover it); the budget follows the bank actually granted
  let banked = false;
  let bankLabel: string | null = null;
  if (S.liveStatus.timeBank) {
    try {
      const res = await topupSeams.takeTime();
      banked = !!(res && res.ok);
      bankLabel = (res || {}).label ?? null;
    } catch (e: any) {
      log(`[top-up] pre-action: could not take the time bank: ${e?.message ?? e}`);
    }
  }
  let budget = C.TOP_UP_PREFOLD_BUDGET_S;
  if (banked) {
    const m = /(\d+)/.exec(bankLabel || "");
    const granted = m ? Number(m[1]) : 45;
    budget = granted >= 45 ? C.TOP_UP_PREFOLD_BANKED_S : Math.min(C.TOP_UP_PREFOLD_BANKED_S, C.TOP_UP_PREFOLD_BUDGET_S + granted * 0.75);
  }
  // THE BUY NEVER EATS THE ACTION'S TIME: capped by what is really left on hero's clock (the bank included — the
  // client starts it at 0), keeping PREFOLD_ACT_RESERVE_S for the press, its settle and one retry. Hand 4920545590:
  // a 6 s buy that never pressed, then the shove went out at clock 4 and was folded there.
  const left = heroTimeLeft();
  if (left !== null) {
    const room = left.total - PREFOLD_ACT_RESERVE_S;
    if (room < PREFOLD_MIN_BUDGET_S) {
      S.topupLocked = false;
      log(`[top-up] pre-action (${verdict.kind}) skipped: ${left.total} s left on hero's clock — the ${verdict.kind} goes first`);
      if (S.session.id) {
        S.sessions.event(S.session.id, "top-up-prefold-skipped", { hand: S.handNo, handKey: hid, shortCents: short, clockS: left.clock,
                                                                  bankS: left.bank, pick: r.pick ?? null, terminalKind: verdict.kind });
      }
      S.topupPrefold.hand = hid;
      return;
    }
    budget = Math.min(budget, room);
  }
  Object.assign(S.topupPrefold, { active: true, key: r.key ?? null, hand: hid, startedAt: time(), deadline: time() + budget,
                                  banked, kind: verdict.kind, finalStackKnown: verdict.finalStackKnown });
  st.topUpHand = hid;
  st.topUpTrigger = "pre-action";
  st.topUpAt = time();
  st.topUpMayExceed = !verdict.finalStackKnown;
  feedAdd(`Pre-action top-up (${verdict.kind}): buying $${fmtFixed(short / 100, 2)} before the ${pyStr(r.pick ?? null)}`
          + (banked ? " (time bank pressed)" : "")
          + (verdict.finalStackKnown ? "" : " — hero can still win, so the client may refuse it at the next hand"));
  log(`[top-up] pre-action (${verdict.kind}): ${short}c short, ${fmtFixed(budget, 0)}s budget` + (banked ? ` after taking the time bank (${bankLabel})` : ""));
  if (S.session.id) {
    S.sessions.event(S.session.id, "top-up-prefold", {
      hand: S.handNo, handKey: hid, shortCents: short, budgetS: budget, timeBank: banked, timeBankLabel: bankLabel,
      pick: r.pick ?? null, terminalKind: verdict.kind, finalStackKnown: verdict.finalStackKnown, why: verdict.why,
    });
  }
  topupSeams.spawn("top-up-preaction", async () => {
    try {
      const rec = await topUpRun();
      if (rec && typeof rec === "object") rec.terminalKind = verdict.kind;
    } catch (e: any) {
      log(`[top-up] pre-action run: ${e?.message ?? e}`);
    } finally {
      // ALWAYS: while this flag is set the panel may stand over the strip
      S.topupPrefold.active = false;
      S.topupLocked = false;
      try {
        await closeBuyPanel();
      } catch {}
      log(`[top-up] pre-action done in ${fmtFixed(time() - S.topupPrefold.startedAt, 1)}s - the ${verdict.kind} can go`);
    }
  });
}

/** THE NUMBER THAT MATTERS: hands hero STARTED below the table max, counted once per hand — now the need at the deal
 *  (topUpDealNeed), which also files the hand's `top-up-need` event, settles a pending buy and raises the stall alarm. */
export function topUpKpiTick(): void {
  const hid = handKey();
  if (S.topupKpi.hand === hid || !S.feedPrev.seated || S.feedPrev.waiting) return;
  if (!(S.study.topUp && S.session.id) || S.fakeMode) return;
  if (["sitting-out", "waiting-for-bb", "not-in-hand", "unknown", null, undefined].includes(S.liveStatus.hero)) return;
  S.topupKpi.hand = hid;
  topupSeams.spawn("top-up-kpi", () => topUpDealNeed(hid));
}

/**
 * THE NEED AT THE DEAL, once for every hand hero is in. The stack is the stack AS DEALT — the socket's (exact: the
 * blinds' frames, or the last hand's end plus a buy since), else the felt's with what hero has put in this hand added
 * back. Files ONE `top-up-need` event (needed / not needed / blocked by what), keeps the KPI (`top-up-short-start` and
 * topUpKpi, names unchanged for the panel and the dashboards), settles a pending buy the evidence has settled, and
 * raises `top-up-stalled` when hero started two hands in a row short with no run attempted between them — the alarm
 * the 2026-10-03 lockout (four short starts, no press, no word) never had.
 */
export async function topUpDealNeed(hid: string): Promise<NeedVerdict | null> {
  try {
    const r = await topupSeams.read();
    const bb = r.bbCents, stack = r.stackCents, mx = r.maxCents;
    if (r.zone) return null;
    if (bb && mx) S.study.topUpMax = { maxCents: mx, bbCents: bb, assumed: !!r.maxAssumed };
    // STACK AS DEALT off the felt, not stack behind: what hero has put in this hand goes back on (used when the socket
    // has no word on hero's stack)
    let domDealt: number | null = null;
    if (stack !== null && stack !== undefined && bb) {
      const wireBb = S.ws.bb || 0;
      const committed: Map<any, number> = S.ws.committed || new Map();
      const mine = committed.get(S.ws.heroSeat ?? null) || 0;
      domDealt = stack + (wireBb && S.ws.bbSeen ? pyRound(mine / wireBb * bb) : 0);
    }
    const v = needFor("deal", { ...r, stackCents: domDealt });
    settlePending(v);
    S.topupNeed.last = { point: "deal", hand: hid, ...needFields(v) };
    if (!v.known) {
      log(`[top-up] deal of hand ${hid}: no verdict — ${v.why}`);
      return v;
    }
    // THE KPI: hands started at least the floor below the max
    S.topupKpi.hands += 1;
    if (v.need) {
      S.topupKpi.short += 1;
      S.topupKpi.worstBb = Math.max(S.topupKpi.worstBb, pyRound(v.shortBb ?? 0, 1));
      feedAdd(`Started this hand ${fmtFixed(v.shortBb ?? 0, 1)} bb below the max (${S.topupKpi.short} of ${S.topupKpi.hands} hands so far)`
              + (v.blockedBy ? ` — held: ${v.blockedBy}` : ""));
      if (S.session.id) {
        S.sessions.event(S.session.id, "top-up-short-start", {
          hand: hid, shortBb: pyRound(v.shortBb ?? 0, 2), stackCents: stack ?? v.stackCents, dealtCents: v.stackCents, maxCents: v.stackCents! + v.shortCents!,
          short: S.topupKpi.short, hands: S.topupKpi.hands, stackSource: v.stackSource,
        });
      }
    }
    // THE STALL ALARM: short at this deal and the last one, and no run started between them
    const prev = S.topupNeed.prev;
    const now = time();
    if (v.need && prev && prev.need && prev.hid !== hid && S.topupNeed.lastAttemptAt < prev.at && v.pendingVerdict !== "pending") {
      S.topupNeed.stalls += 1;
      feedAdd(`⚠ TOP-UP STALLED: hero started two hands in a row short (${fmtFixed(prev.shortBb ?? 0, 1)} then ${fmtFixed(v.shortBb ?? 0, 1)} bb) `
              + `and no buy was tried — ${v.blockedBy ?? "no window opened for a buy"}`);
      log(`[top-up] STALLED at hand ${hid}: short at ${prev.hid} and ${hid}, no run since ${fmtFixed(now - prev.at, 0)} s ago`);
      if (S.session.id) {
        S.sessions.event(S.session.id, "top-up-stalled", {
          hand: S.handNo, handKey: hid, prevHandKey: prev.hid, prevShortBb: prev.shortBb, stalls: S.topupNeed.stalls,
          lastAttemptAgoS: S.topupNeed.lastAttemptAt ? pyRound(now - S.topupNeed.lastAttemptAt, 1) : null, ...needFields(v),
        });
      }
    }
    S.topupNeed.prev = { hid, need: v.need, at: now, shortBb: v.shortBb };
    if (S.session.id) S.sessions.event(S.session.id, "top-up-need", { point: "deal", hand: S.handNo, handKey: hid, maxCents: mx ?? null, ...needFields(v) });
    return v;
  } catch (e: any) {
    log(`[top-up] need at the deal: ${e?.message ?? e}`);
    return null;
  }
}

/** AUTO TOP-UP, from the feed loop: hero below the max, in a safe window -> Buy chips, Max, BUY. */
export function maybeTopUp(): void {
  const st = S.study;
  if (!(st.topUp && S.session.id) || S.fakeMode) return;
  topUpSettleTick();
  // THE DOM DECIDES THE PANEL BELIEF OFF THE CLOCK TOO: 2 ticks seen = open, 4 unseen = shut
  if (!S.topupLocked) {
    const seen = S.topupPanel.domTicks ?? 0;
    if (S.liveStatus.buyPanel) {
      S.topupPanel.domTicks = seen >= 0 ? seen + 1 : 1;
      if (S.topupPanel.domTicks >= 2) S.topupPanel.open = true;
    } else {
      S.topupPanel.domTicks = seen <= 0 ? seen - 1 : -1;
      if (S.topupPanel.domTicks <= -4) S.topupPanel.open = false;
    }
  }
  if (S.topupAbort && !S.topupLocked && !S.topupPanel.open) S.topupAbort = false;
  const [ok, trigger] = topUpWindow();
  if (!ok) {
    st.topUpDue = null;
    return;
  }
  const hid = handKey();
  if (st.topUpHand === hid || time() - (st.topUpAt ?? 0.0) < TOP_UP_COOLDOWN_S) return;
  // WHETHER: the need, on the socket's own number where it has one — the felt can lag the pot award (hand 4922342889:
  // 495 on screen two ticks after the table paid hero to 507). With no socket word the run decides after its read.
  const v = needFor("final");
  if (v.pendingVerdict === "lost") settlePending(v);
  if ((v.known && !v.need) || v.blockedBy) {
    st.topUpDue = null;
    sayFinal(v, trigger);
    return;
  }
  const due = st.topUpDue ?? null;
  if (due === null) {
    const [lo, hi] = topupTuning.jitterS;
    st.topUpDue = time() + lo + Math.random() * (hi - lo);
    return;
  }
  if (time() < due) return;
  st.topUpDue = null;
  if (S.topupLocked) return;
  S.topupLocked = true;
  st.topUpAt = time();
  st.topUpHand = hid;
  st.topUpTrigger = trigger;
  S.topupAbort = false;
  topupSeams.spawn("top-up", () => topUpRun().finally(() => { S.topupLocked = false; }));
}

/** The presses. Every press is gated on the table AS IT IS AT THAT MOMENT, and the need decides whether and how much
 *  (topupNeed.ts). A run opened by a window of one hand (fold, showdown, hand-over) presses nothing once the next hand
 *  is dealt; a not-dealt or forced run carries on (the chips land at the end of the hand in progress however it goes).
 *  The BUY press is on record the moment it is made (topUpPressed). Returns the record it wrote. */
export async function topUpRun(force = false, amountCents: number | null = null): Promise<Record<string, any>> {
  if (force) S.study.topUpTrigger = "forced";
  let opened = false;
  const runAt = time();
  // THE RUN BELONGS TO THE HAND IT STARTED IN: a window of that hand (fold, showdown, hand-over) is no window once the
  // next hand is dealt — the run is called off before any later press (not-dealt and forced runs carry on)
  const runHid = handKey();
  const trig = S.study.topUpTrigger ?? null;
  const handBound = !force && trig !== null && trig !== "not-dealt";
  const newDeal = () => (handBound && handKey() !== runHid ? `a new hand (${handKey()}) was dealt under the run` : null);
  S.topupNeed.lastAttemptAt = runAt;
  try {
    if (!force) {
      const [ok, why] = topUpGate();
      if (!ok) {
        S.study.topUpHand = null;
        return topUpDone(false, 0, {}, `not pressed — ${why}`);
      }
    }
    let r = await topUpRead();
    if (r.zone) return topUpDone(true, 0, r, "Zone table — the client sets the stack, nothing to top up", null, false, true);
    if (!r.seated || r.stackCents === null || r.stackCents === undefined || !r.maxCents) {
      const why = r.reason || (r.seated && (r.stackCents === null || r.stackCents === undefined) ? "stack unreadable"
                               : r.seated ? "no max buy-in on this table" : "not seated");
      return topUpDone(false, 0, r, why);
    }
    // WHETHER and HOW MUCH: the need — on the socket's stack where it has one (exact), else this read
    const v = needFor("press", r);
    if (amountCents === null && v.known && !v.need) return topUpDone(true, 0, r, "at the max already", null, false, true);
    if (!force && v.blockedBy) return topUpDone(false, 0, r, `not pressed — ${v.blockedBy}`);
    const short = v.shortCents ?? r.maxCents - r.stackCents;
    if (!r.panelOpen) {
      for (const attempt of [1, 2]) {
        if (!force) {
          const [ok, why] = topUpGate();
          if (!ok) {
            S.study.topUpHand = null;
            return topUpDone(false, short, r, `not pressed — ${why}`);
          }
        }
        const res = await act("Buy chips", "button");
        if (!res.ok) return topUpDone(false, short, r, `could not open Buy chips — ${pyStr(res.reason ?? null)}`);
        opened = S.topupPanel.open = true;
        for (let i = 0; i < 10; i++) {
          await sleep(0.3);
          const rr = await topUpRead();
          const pick: Record<string, any> = {};
          for (const k of ["panelOpen", "offerCents", "inputFound", "inputValue"]) if (k in rr) pick[k] = rr[k];
          r = { ...r, ...pick };
          if (r.panelOpen) break;
        }
        if (r.panelOpen) break;
        log(`[top-up] Buy-chips panel not up after press ${attempt} — assuming it may still render`);
      }
      if (!r.panelOpen) return topUpDone(false, short, r, "the Buy-chips panel did not open (two presses)");
    }
    opened = S.topupPanel.open = true;
    if (!force) {
      const [ok, why0] = topUpGate();
      const why = ok ? newDeal() : why0;
      if (why) {
        await closeBuyPanel();
        S.study.topUpHand = null;
        return topUpDone(false, short, r, `not pressed — ${why}`);
      }
    }
    // THE CLIENT'S OWN OFFER: the panel's "Max. $N", and the socket's allowedMax as the panel opened. Nothing to add
    // means NOTHING IS PRESSED and the panel is folded away (hand 4922343004, table 2: the panel opened at "Max. $0", the
    // run typed $0.05 and pressed a BUY that did nothing, logged it ok, and the panel stood open over the strip for 4 min
    // 12 s — PLAY_BUYIN_INFO allowedMax 0 at every fold until the client closed it at 23:56:45)
    const allowed = sockAllowed(runAt - 0.5);
    if (amountCents === null && (allowed === 0 || r.offerCents === 0)) {
      await closeBuyPanel();
      return topUpDone(true, 0, r, `nothing to add — the client's Max is $0 (${allowed === 0 ? "its socket said allowedMax 0" : "the panel says Max. $0"}); `
                                   + "hero is at or above the table max", null, false, false);
    }
    let want = amountCents ? Math.trunc(amountCents) : r.offerCents ? r.offerCents : short;
    if (!amountCents && allowed && allowed > 0 && want > allowed) want = allowed;
    const t = await seams.ignitionTarget();
    const fill = t ? (await cdp.evaluate(t.webSocketDebuggerUrl, topupFillJs(mySel()) + `(${Math.trunc(want)})`, 6)) || {} : {};
    if (!fill.ok) {
      await closeBuyPanel();
      return topUpDone(false, want, r, `could not set the amount — ${"reason" in fill ? pyStr(fill.reason) : "no reply"}`);
    }
    await sleep(0.3);
    if (!force) {
      const [ok, why0] = topUpGate();
      const why = ok ? newDeal() : why0;
      if (why) {
        await closeBuyPanel();
        return topUpDone(false, want, r, `not pressed — ${why}`);
      }
    }
    const res = await act("BUY", "button");
    if (!res.ok) {
      await closeBuyPanel();
      return topUpDone(false, want, r, `BUY not pressed — ${pyStr(res.reason ?? null)}`);
    }
    S.topupPanel.open = false;
    // THE PRESS IS ON RECORD THE MOMENT IT IS MADE: the socket's receipt (or refusal) can come while the run is still
    // waiting below, and must find this press, not the one before it
    const pressedAt = time();
    const tol = topUpTolCents(r.bbCents);
    const pend = topUpPressed(want, r, v, pressedAt);
    // THE RECEIPT MUST BE NEW AND MATCH: the socket's (settles `pend` itself) or the screen's (the feed loop files it on
    // its rising edge)
    let receipt: string | null = null;
    const tries = S.topupPrefold.active ? 0 : 8;
    for (let i = 0; i < tries; i++) {
      await sleep(0.4);
      if (pend.receiptCents || pend.refused) break;
      receipt = [...S.toastsSeen].reverse().find(([a, at]) => at >= pressedAt - 0.5
        && Math.abs(pyRound(pyFloat(a.replace(/,/g, "")) * 100) - Math.trunc(want)) <= tol)?.[0] ?? null;
      if (receipt) break;
    }
    const afterRead = await topUpRead();
    const after = afterRead.stackCents ?? null;
    // LANDED = the stack moved by what was bought, to within half a big blind (it was $1 — 20bb at NL5 — so an unmoved
    // stack read as landed for every buy of $1 or less)
    const landed = after !== null && Math.abs(after - r.stackCents - Math.trunc(want)) <= tol;
    // A PANEL STILL UP AFTER BUY is folded away: the client keeps it open when the BUY did nothing (Max. $0, an amount it
    // would not take), and left there it stands over the strip for hands
    if (afterRead.panelOpen) {
      S.topupPanel.open = true;
      log("[top-up] the Buy-chips panel is still open after BUY — closing it");
      await closeBuyPanel();
    }
    const okNow = !!receipt || landed || !!pend.receiptCents;
    if (S.topupPrefold.active && !okNow) {
      return topUpDone(false, want, r, "pressed before the action; the client adds it at the end of the hand — the receipt settles it", after, true, false, pend);
    }
    return topUpDone(okNow, want, r, okNow ? null : "pressed; no receipt yet (the client adds the chips at the end of the hand in progress)", after, true, false, pend);
  } catch (e: any) {
    if (opened) await closeBuyPanel();
    return topUpDone(false, 0, {}, `error: ${e?.message ?? e}`);
  } finally {
    if (!force) S.topupLocked = false;
  }
}

/** TEST A: will Ignition take a SECOND buy request in the same hand? Run at a live ring table, hero short and
 *  NOT in a hand. */
export async function topUpProbeSecond(cents = 0): Promise<Record<string, any>> {
  const out: Record<string, any> = { at: nowMs(), presses: [] };
  const before = await topUpRead();
  out.before = Object.fromEntries(["stackCents", "maxCents", "bbCents", "panelOpen", "zone"].map((k) => [k, before[k] ?? null]));
  if (!before.seated || before.stackCents === null || before.stackCents === undefined || !before.maxCents) {
    return { ...out, ok: false, verdict: "no readable ring table — the probe needs hero seated at one" };
  }
  const short = before.maxCents - before.stackCents;
  cents = Math.trunc(cents) || Math.max(100, Math.floor(short / 2));
  if (cents * 2 > short + 1) {
    return { ...out, ok: false, short,
             verdict: `hero is only $${fmtFixed(short / 100, 2)} short — two $${fmtFixed(cents / 100, 2)} buys would go over the max` };
  }
  Object.assign(out, { amountCents: cents, shortCents: short, hand: handKey() });
  for (const i of [1, 2]) {
    out.presses.push(await topUpRun(true, cents));
    if (i === 1) await sleep(4.0);
  }
  out.modal = S.liveStatus.modal ?? null;
  out.afterCents = (await topUpRead()).stackCents ?? null;
  out.sameHand = out.hand === handKey();
  const [p1, p2] = out.presses;
  out.ok = !!p1.pressed;
  out.verdict = !p1.pressed ? "inconclusive — the FIRST press never went through: " + pyStr(p1.reason ?? null)
    : p2.ok ? "SECOND REQUEST ACCEPTED — the client took both" : "SECOND REQUEST REFUSED — " + pyStr(p2.reason ?? null);
  if (!out.sameHand) out.verdict += " (CAVEAT: the table dealt a new hand mid-probe — run it again between hands)";
  feedAdd(`Top-up probe: ${out.verdict}`);
  if (S.session.id) S.sessions.event(S.session.id, "top-up-probe-second", out);
  return out;
}

/** The pending record of a BUY just pressed (S.study.lastTopUp), written at the press: what was bought, hero's stack
 *  then (the socket's where it has it), when, and in which hand — what the need function and the receipts settle. */
function topUpPressed(want: number, r: Record<string, any>, v: NeedVerdict, pressedAt: number): Record<string, any> {
  const rec: Record<string, any> = {
    at: Math.trunc(pressedAt * 1000), pressedAtMs: Math.trunc(pressedAt * 1000), ok: false, pressed: true,
    amountCents: Math.trunc(want), beforeCents: v.stackCents ?? r.stackCents ?? null, beforeSource: v.stackSource,
    screenBeforeCents: r.stackCents ?? null, maxCents: r.maxCents ?? null, bbCents: r.bbCents ?? null,
    hand: S.handNo, pressHandNo: S.handNo, handKey: handKey(), trigger: S.study.topUpTrigger ?? null, reason: "pressed — waiting for the receipt",
  };
  S.study.lastTopUp = rec;
  return rec;
}

/** What a receipt or refusal settled on the pressed record while the run was still waiting: kept over the run's own
 *  verdict. */
const SETTLED_KEYS = ["receiptCents", "receiptSource", "socketCents", "refused", "refusedBy", "landed", "landedBy", "lost", "lostWhy"];

function topUpDone(ok: boolean, cents: number, r: Record<string, any>, reason: string | null, after: number | null = null,
                   pressed = false, quiet = false, pend: Record<string, any> | null = null): Record<string, any> {
  let rec: Record<string, any> = {
    at: nowMs(), ok, pressed, amountCents: Math.trunc(cents),
    beforeCents: r.stackCents ?? null, afterCents: after, maxCents: r.maxCents ?? null,
    maxAssumed: !!r.maxAssumed, bbCents: r.bbCents ?? null, stackText: r.stackText ?? null,
    hand: S.handNo, handKey: handKey(), trigger: S.study.topUpTrigger ?? null,
    reason,
  };
  if (pend) {
    // the press's own record, completed: its press time, hand and stack-before stay; a receipt or refusal that came
    // while the run waited wins over the run's verdict
    const settled: Record<string, any> = {};
    for (const k of SETTLED_KEYS) if (pend[k] !== undefined) settled[k] = pend[k];
    const { at: _a, hand: _h, handKey: _k, beforeCents: _b, ...rest } = rec;
    Object.assign(pend, rest, settled);
    if (pend.receiptCents) Object.assign(pend, { ok: true, reason: null, afterCents: pend.socketCents ?? after });
    else if (pend.refused) Object.assign(pend, { ok: false, reason: pend.reason && String(pend.reason).startsWith("refused") ? pend.reason : "refused by the client" });
    if (pend.handKey !== rec.handKey) pend.recordedHandKey = rec.handKey;
    rec = pend;
  }
  // A RUN THAT PRESSED NOTHING NEVER BURIES A BUY STILL IN FLIGHT: that record is what the receipts and the need settle
  const cur = S.study.lastTopUp;
  const inFlight = cur && cur !== rec && cur.pressed && !cur.receiptCents && !cur.refused && !cur.lost && !cur.landed;
  if (pressed || !inFlight) S.study.lastTopUp = rec;
  log(`[top-up] ${pyRepr(rec)}`);
  if (quiet) return rec;
  const amt = `$${fmtFixed(cents / 100, 2)}`;
  feedAdd(rec.ok && pressed ? `Top-up ${amt} → stack $${fmtFixed((rec.afterCents ?? after ?? 0) / 100, 2)}`
          : rec.ok ? `Top-up: ${pyStr(rec.reason)}`
          : pressed ? `Top-up ${amt} pressed — ${pyStr(rec.reason)}` : `Top-up NOT done — ${pyStr(rec.reason)}`);
  if (S.session.id) S.sessions.event(S.session.id, "top-up", rec);
  return rec;
}
