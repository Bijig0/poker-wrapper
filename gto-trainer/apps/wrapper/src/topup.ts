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
 */
import * as cdp from "./cdp";
import { nowMs, sleep, time } from "./clock";
import { C } from "./config";
import { feedAdd, log } from "./feed";
import { fmtFixed, pyFloat, pyRepr, pyRound, pyStr } from "./py";
import { S, seams } from "./state";
import * as TERMINAL from "./terminal";
import { mySel, topupFillJs, topupReadJs } from "./ignition/dom";
import { handState } from "./ignition/hand";
import { act, autoTableOk, heroTimeLeft, maybeTakeTime, pickReady } from "./relay";

/** What a test replaces: the table read, the time-bank press, and how a run is started (Python's tests stubbed
 *  _top_up_read, _maybe_take_time and threading.Thread). */
export const topupSeams = {
  read: (): Promise<Record<string, any>> => topUpRead(),
  takeTime: (): Promise<Record<string, any> | null> => maybeTakeTime(),
  spawn: (_name: string, f: () => Promise<unknown>): void => { void f(); },
};

const TOP_UP_COOLDOWN_S = 20.0;
const TOP_UP_SETTLE_TICKS = 2;
const TOP_UP_MIN_SHORT_BB = 1.0;
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
  if (!(S.liveStatus.toAct || S.feedPrev.toAct)) return;
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
  const rec = S.study.lastTopUp || {};
  if (!rec.pressed || rec.receiptCents || rec.refused) return;
  if (time() * 1000 - (rec.at || 0) > 180_000) return;
  Object.assign(rec, { ok: false, refused: true,
                       reason: "refused by the client at the next hand — hero's stack was above the max (won the pot after the buy)" });
  feedAdd(`Top-up $${fmtFixed((rec.amountCents || 0) / 100, 2)} refused — hero finished above the max; the next window decides again`);
  if (S.session.id) {
    S.sessions.event(S.session.id, "top-up-refused-over-max", {
      hand: S.handNo, handKey: handKey(), amountCents: rec.amountCents ?? null, pressedHandKey: rec.handKey ?? null,
      trigger: rec.trigger ?? null, terminalKind: rec.terminalKind ?? null,
    });
  }
}

const pendingPress = (last: Record<string, any>) =>
  last.pressed && !last.receiptCents && !last.refused && time() * 1000 - (last.at || 0) < 180_000;

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
  if (!(S.liveStatus.toAct || S.feedPrev.toAct)) return;
  if (S.liveStatus.modal || S.liveStatus.buyPanel) return;
  const r = pickReady();
  if (!r.ok) return;
  const verdict = terminalPick(r);
  if (!verdict.terminal) return;
  if (st.uncertain) return;
  const hid = handKey();
  if (S.topupPrefold.hand === hid || st.topUpHand === hid) return;
  if (pendingPress(st.lastTopUp || {})) return;
  const read = await topupSeams.read();
  if (read.zone || !read.seated || read.stackCents === null || read.stackCents === undefined || !read.maxCents) return;
  const short = read.maxCents - read.stackCents;
  const floor = Math.max(1, pyRound((read.bbCents || 0) * TOP_UP_MIN_SHORT_BB));
  if (short < floor) return;
  if (S.topupLocked) return;
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

/** THE NUMBER THAT MATTERS: hands hero STARTED below the table max, counted once per hand. */
export function topUpKpiTick(): void {
  const hid = handKey();
  if (S.topupKpi.hand === hid || !S.feedPrev.seated || S.feedPrev.waiting) return;
  if (!(S.study.topUp && S.session.id) || S.fakeMode) return;
  if (["sitting-out", "waiting-for-bb", "not-in-hand", "unknown", null, undefined].includes(S.liveStatus.hero)) return;
  S.topupKpi.hand = hid;
  topupSeams.spawn("top-up-kpi", () => topUpKpiRead(hid));
}

async function topUpKpiRead(hid: string): Promise<void> {
  try {
    const r = await topupSeams.read();
    const bb = r.bbCents, stack = r.stackCents, mx = r.maxCents;
    if (r.zone || !bb || stack === null || stack === undefined || !mx) return;
    S.study.topUpMax = { maxCents: mx, bbCents: bb, assumed: !!r.maxAssumed };
    // STACK AS DEALT, not stack behind: what hero has put in this hand goes back on
    const wireBb = S.ws.bb || 0;
    const committed: Map<any, number> = S.ws.committed || new Map();
    const mine = committed.get(S.ws.heroSeat ?? null) || 0;
    const dealtCents = stack + (wireBb && S.ws.bbSeen ? pyRound(mine / wireBb * bb) : 0);
    const shortBb = (mx - dealtCents) / bb;
    S.topupKpi.hands += 1;
    if (shortBb < TOP_UP_MIN_SHORT_BB) return;
    S.topupKpi.short += 1;
    S.topupKpi.worstBb = Math.max(S.topupKpi.worstBb, pyRound(shortBb, 1));
    feedAdd(`Started this hand ${fmtFixed(shortBb, 1)} bb below the max (${S.topupKpi.short} of ${S.topupKpi.hands} hands so far)`);
    if (S.session.id) {
      S.sessions.event(S.session.id, "top-up-short-start", {
        hand: hid, shortBb: pyRound(shortBb, 2), stackCents: stack, dealtCents, maxCents: mx,
        short: S.topupKpi.short, hands: S.topupKpi.hands,
      });
    }
  } catch (e: any) {
    log(`[top-up] kpi: ${e?.message ?? e}`);
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
  if (pendingPress(st.lastTopUp || {})) return;
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

/** The presses. Every press is gated on the table AS IT IS AT THAT MOMENT; once started it finishes across the
 *  deal (the chips land at the next hand however it goes). Returns the record it wrote. */
export async function topUpRun(force = false, amountCents: number | null = null): Promise<Record<string, any>> {
  if (force) S.study.topUpTrigger = "forced";
  let opened = false;
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
    const short = r.maxCents - r.stackCents;
    const floor = Math.max(1, pyRound((r.bbCents || 0) * TOP_UP_MIN_SHORT_BB));
    if (amountCents === null && short < floor) return topUpDone(true, 0, r, "at the max already", null, false, true);
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
      const [ok, why] = topUpGate();
      if (!ok) {
        await closeBuyPanel();
        S.study.topUpHand = null;
        return topUpDone(false, short, r, `not pressed — ${why}`);
      }
    }
    const want = amountCents ? Math.trunc(amountCents) : r.offerCents ? r.offerCents : short;
    const t = await seams.ignitionTarget();
    const fill = t ? (await cdp.evaluate(t.webSocketDebuggerUrl, topupFillJs(mySel()) + `(${Math.trunc(want)})`, 6)) || {} : {};
    if (!fill.ok) {
      await closeBuyPanel();
      return topUpDone(false, want, r, `could not set the amount — ${"reason" in fill ? pyStr(fill.reason) : "no reply"}`);
    }
    await sleep(0.3);
    if (!force) {
      const [ok, why] = topUpGate();
      if (!ok) {
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
    // THE RECEIPT MUST BE NEW AND MATCH (filed by the feed loop on its rising edge)
    let receipt: string | null = null;
    const pressedAt = time();
    const tries = S.topupPrefold.active ? 0 : 8;
    for (let i = 0; i < tries; i++) {
      await sleep(0.4);
      receipt = [...S.toastsSeen].reverse().find(([a, at]) => at >= pressedAt - 0.5
        && Math.abs(pyRound(pyFloat(a.replace(/,/g, "")) * 100) - Math.trunc(want)) <= 100)?.[0] ?? null;
      if (receipt) break;
    }
    const after = (await topUpRead()).stackCents ?? null;
    const landed = after !== null && Math.abs(after - r.stackCents - Math.trunc(want)) <= Math.max(100, Math.floor(Math.trunc(want) / 10));
    const okNow = !!receipt || landed;
    if (S.topupPrefold.active && !okNow) {
      return topUpDone(true, want, r, "pressed before the fold; the receipt lands on its own", after, true);
    }
    return topUpDone(okNow, want, r, okNow ? null : "pressed; no receipt and the stack has not moved yet (the client adds chips at the next hand)", after, true);
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

function topUpDone(ok: boolean, cents: number, r: Record<string, any>, reason: string | null, after: number | null = null,
                   pressed = false, quiet = false): Record<string, any> {
  const rec = {
    at: nowMs(), ok, pressed, amountCents: Math.trunc(cents),
    beforeCents: r.stackCents ?? null, afterCents: after, maxCents: r.maxCents ?? null,
    maxAssumed: !!r.maxAssumed, bbCents: r.bbCents ?? null, stackText: r.stackText ?? null,
    hand: S.handNo, handKey: handKey(), trigger: S.study.topUpTrigger ?? null,
    reason,
  };
  S.study.lastTopUp = rec;
  log(`[top-up] ${pyRepr(rec)}`);
  if (quiet) return rec;
  const amt = `$${fmtFixed(cents / 100, 2)}`;
  feedAdd(ok ? `Top-up ${amt} → stack $${fmtFixed((after || 0) / 100, 2)}`
          : pressed ? `Top-up ${amt} pressed — ${pyStr(reason)}` : `Top-up NOT done — ${pyStr(reason)}`);
  if (S.session.id) S.sessions.event(S.session.id, "top-up", rec);
  return rec;
}
