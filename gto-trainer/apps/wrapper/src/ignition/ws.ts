/**
 * THE AUTHORITATIVE GAME FEED — the client's own WebSocket frames (launch.py: _on_game_msg and the tap).
 *
 * The client receives plain-JSON game messages; reading them turns actions from something inferred off animated
 * pixels into discrete events with exact seat, amounts and hand id. `btn` is a bitmask, learned by correlating
 * live messages with amounts: 64 checks, 1024 folds, 256 calls, 4096 raises to, 2048 all-in.
 *
 * ONE PAGE, FOUR TABLES, ONE TAP: the tap enables Network on the page, so it receives EVERY table's frames. CDP's
 * requestId (one per WebSocket, so one per table) is what tells them apart; the tap binds to the socket that
 * deals face-up cards into OUR seat (or whose hero-only frames name it) and holds, then replays, what it saw
 * while unbound. The long history of why is in launch.py's block comment over `_tap_bound`.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { strftime, time } from "../clock";
import { wsDumpPath } from "../config";
import { feedAdd, log } from "../feed";
import { fmtFixed, pyJsonDumps, pyRepr, pyRound, pyStr, sortedNums, truthy } from "../py";
import { S, TupleSet } from "../state";
import * as TABLES from "../tables";
import { archiveHand } from "../archive";
import { faceUpSeats, heroClaim, wireCard } from "./dom";

const BTN: Record<number, string> = { 64: "checks", 1024: "folds", 256: "calls", 4096: "raises to", 2048: "is ALL-IN" };
const BLIND_BTN: Record<number, string> = { 2: "small blind", 4: "big blind", 8: "post" };
const STREET_RANK: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };

const ws = () => S.ws;

/** The archive call a test replaces (Python's tests stubbed launch._archive_hand). */
export const wsSeams = { archiveHand: () => archiveHand() };

/** The street, from how FAR the board reaches (a dropped flop message leaves [null, null, null, 'Ts']). */
export function streetNow(): string {
  const b: (string | null)[] = ws().board || [];
  let n = 0;
  b.forEach((c, i) => { if (c) n = Math.max(n, i + 1); });
  return n >= 5 ? "river" : n === 4 ? "turn" : n === 3 ? "flop" : "preflop";
}

/** A hand's streets only ever go FORWARD: a defaulted stamp is clamped to the furthest street reached. */
export function streetMonotonic(st: string): string {
  const seen: any[] = ws().actions || [];
  if (!seen.length) return st;
  let high = 0;
  for (const a of seen) high = Math.max(high, STREET_RANK[a.street || "preflop"] ?? 0);
  return (STREET_RANK[st] ?? 0) >= high ? st : Object.keys(STREET_RANK).find((k) => STREET_RANK[k] === high)!;
}

/** Structured mirror of the feed lines, for the /hand export. Amounts stay in wire cents. */
export function actAdd(seat: number | null | undefined, kind: string, cents: number | null = null, street: string | null = null): void {
  if (seat === null || seat === undefined) return;
  const w = ws();
  (w.actions ??= []).push({ seat, type: kind, cents, street: street ? street : streetMonotonic(streetNow()) });
  if (seat === w.heroSeat) w.heroLastActAt = time();
}

/** Cross-source dedupe for one betting round: whichever of the WS tap and the DOM diff reports first wins. */
export function actSeen(key: unknown[]): boolean {
  const seen: TupleSet = (ws().actSeen ??= new TupleSet());
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

/** Money-action dedupe key: committed total rounded to the nearest 5 wire cents. */
export const mkey = (seat: number | null, cents: number): unknown[] => [seat, pyRound(cents / 5)];

/** Re-render the feed lines printed while the big blind was only a guess (the SB post). */
export function refeedBlindGuess(): void {
  for (const line of S.feed) {
    const cents = line.guessCents;
    if (cents === null || cents === undefined) continue;
    line.line = String(line.line).replace(/\(([^)]*)\)$/, () => `(${amt(cents)})`);
    delete line.guessCents;
  }
}

/** A wire amount (cents) in big blinds when the BB is known, else the raw stake. */
export function amt(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "?";
  const bb = ws().bb || 0;
  if (bb && ws().bbSeen) {
    return fmtFixed(cents / bb, 2).replace(/0+$/, "").replace(/\.$/, "") + " BB";
  }
  return fmtFixed(cents / 100, 2);
}

// ---- the WS message dump -------------------------------------------------------------------------------
export function dumpBegin(d: Record<string, any>, rid: string | null = null): Record<string, any> {
  const now = time();
  const e: Record<string, any> = {
    ts: pyRound(now, 3),
    t: strftime("%H:%M:%S", now) + "." + String(Math.trunc(now * 1000) % 1000).padStart(3, "0"),
    hand: S.handNo, pid: d.pid ?? null, seat: d.seat ?? null,
    rid,
    status: "ok", data: d,
  };
  S.wsDump.push(e);
  if (S.wsDump.length > 3000) S.wsDump.shift();
  S.wsDumpCur = e;
  return e;
}

/** Stamp the frame being processed with WHY it was ignored. */
export function dumpMark(reason: string): void {
  if (S.wsDumpCur !== null) S.wsDumpCur.status = reason;
}

export function dumpCommit(e: Record<string, any>): void {
  S.wsDumpCur = null;
  try {
    const p = wsDumpPath();
    mkdirSync(dirname(p), { recursive: true });
    if (existsSync(p) && statSync(p).size > 20_000_000) renameSync(p, p.replace(/\.jsonl$/, ".jsonl.1"));
    appendFileSync(p, pyJsonDumps(e) + "\n", "utf8");
  } catch {}
}

/** A non-frame marker (tap connected/lost/bound...) in the same stream. */
export function dumpEvent(pid: string, extra: Record<string, any> = {}): void {
  dumpCommit(dumpBegin({ pid, ...extra }));
}

// ---- the stacks as dealt ----------------------------------------------------------------------------------
/**
 * THE STACKS AS DEALT (2026-09-24, hand 723). Every blind and action frame carries the seat's `account` — its chips
 * behind right after that frame (the SB's fold frame repeats its blind frame's account) — so the first one a seat
 * sends in a hand, plus every chip it has put in by then, is the stack it was dealt. Exact, where the seat readings
 * on screen can lag a blind or a top-up (hands 406 / 693 / 702), and where an archived row only has the END of the
 * hand's money (the API rebuilt a decision's from that: 83% exact). Exported as the hand's `startStacks`
 * (ignition/hand.ts); the API reads every covered seat's money from it (utils/archivedHand.withStartStacks).
 */
function moneyIn(seat: number | null, cents: number): void {
  if (seat === null || !(cents > 0)) return;
  const m: Map<number, number> = (ws().moneyIn ??= new Map());
  m.set(seat, (m.get(seat) ?? 0) + cents);
}
function noteAccount(seat: number | null, account: unknown): void {
  if (seat === null || typeof account !== "number" || !Number.isFinite(account) || account < 0) return;
  const w = ws();
  const start: Map<number, number> = (w.startCents ??= new Map());
  if (!start.has(seat)) start.set(seat, account + ((w.moneyIn as Map<number, number> | undefined)?.get(seat) ?? 0));
}

// ---- one player action ----------------------------------------------------------------------------------
/** One player action, from a live CO_SELECT_INFO or one slot of a batched CO_SELECT_SPEED_INFO. `raise` is
 *  chips ADDED; unmapped btn codes are inferred from the amounts. `account` is the seat's chips behind after it. */
export function applySelect(seat: number | null, btn: number | null, bet: number, rz: number, account: unknown = null): void {
  const w = ws();
  const dealtNow: number[] = w.dealt || [];
  const foldedNow: Set<number> = w.foldedSeats ?? new Set<number>();
  if (seat !== null && foldedNow.has(seat) && (w.domFolds ?? new Set()).has(seat) && (rz || bet)) {
    // the fold was the DOM's guess (a badge); money from the seat says it is still in the hand
    foldedNow.delete(seat);
    w.domFolds.delete(seat);
    (w.actSeen as TupleSet | undefined)?.delete(["fold", seat]);
    const acts: any[] = w.actions || [];
    for (let i = acts.length - 1; i >= 0; i--) {
      if (acts[i].seat === seat && acts[i].type === "fold") {
        acts.splice(i, 1);
        break;
      }
    }
    feedAdd(`Seat ${pyStr(seat)} did not fold — a stale FOLD label; retracted`);
    dumpMark(`retracted a DOM fold for seat ${pyStr(seat)}: chips arrived on the WS`);
  }
  if (seat !== null && ((dealtNow.length && !dealtNow.includes(seat)) || foldedNow.has(seat))) {
    dumpMark(`dropped: ghost-guard (dealt=${pyRepr(dealtNow)}, folded=${pyRepr(sortedNums(w.foldedSeats ?? new Set()))})`);
    return;
  }
  let verb = btn !== null && btn !== undefined ? BTN[btn] : undefined;
  if (verb === undefined) verb = rz ? "raises to" : bet ? "calls" : "checks";
  const top = w.maxBet ?? 0;
  const com: Map<number | null, number> = (w.committed ??= new Map());
  const prior = com.get(seat) ?? 0;
  if (verb === "raises to") {
    const total = prior + rz;
    com.set(seat, total);
    w.maxBet = Math.max(top, total);
    if (!actSeen(mkey(seat, total))) {
      actAdd(seat, "raise", total);
      feedAdd(`Seat ${pyStr(seat)} raises to ${amt(total)}`);
    } else dumpMark("dup: money action already recorded");
  } else if (verb === "calls") {
    com.set(seat, prior + bet);
    if (prior + bet > top) {
      w.maxBet = prior + bet;
      if (!actSeen(mkey(seat, prior + bet))) {
        actAdd(seat, "bet", prior + bet);
        feedAdd(`Seat ${pyStr(seat)} bets ${amt(bet)}`);
      } else dumpMark("dup: money action already recorded");
    } else if (!actSeen(mkey(seat, prior + bet))) {
      actAdd(seat, "call", bet);
      feedAdd(`Seat ${pyStr(seat)} calls ${amt(bet)}`);
    } else dumpMark("dup: money action already recorded");
  } else if (verb === "is ALL-IN") {
    const total = prior + Math.max(bet, rz);
    com.set(seat, total);
    w.maxBet = Math.max(top, total);
    if (!actSeen(mkey(seat, total))) {
      actAdd(seat, "all-in", total);
      feedAdd(`Seat ${pyStr(seat)} is ALL-IN (${amt(total)})`);
    } else dumpMark("dup: money action already recorded");
  } else {
    if (verb === "folds" && seat === w.heroSeat) w.heroFolded = true;
    const kind = verb === "folds" ? "fold" : "check";
    if (kind === "fold") (w.foldedSeats ??= new Set<number>()).add(seat);
    if (!actSeen([kind, seat])) {
      actAdd(seat, kind);
      feedAdd(`Seat ${pyStr(seat)} ${verb}`);
    } else dumpMark(`dup: ${kind} already recorded`);
  }
  moneyIn(seat, (com.get(seat) ?? 0) - prior);
  noteAccount(seat, account);
}

// ---- which socket is ours ---------------------------------------------------------------------------------
const TAP_HOLD_MAX = 1500;
export const TAP_STALL_S = 90.0;
const TAP_MISMATCH_TICKS = 8;

/** Let go of the socket and look again; the socket let go of is no longer bound on a CLAIM, only on a deal. */
export function tapUnbind(why: string): void {
  if (S.tapBound !== null) {
    dumpEvent("<tap-unbound>", { rid: S.tapBound, why });
    S.tapRejected.add(S.tapBound);
  }
  S.tapBound = null;
  S.tapMismatch = 0;
  S.tapHold.clear();
}

export function tapBind(rid: string, why: Record<string, any>): void {
  S.tapStall = { since: null, said: false };
  S.tapBound = rid;
  S.tapReplay = [...(S.tapHold.get(rid) || [])];
  S.tapHold.clear();
  dumpEvent("<tap-bound>", { rid, replayed: S.tapReplay.length, ...why });
}

/** Multi-table: bind the ONE socket that says it is ours, if there is one. */
export function tapTryBind(): void {
  const mine = S.liveStatus.heroSeatDom ?? null;
  if (mine === null) return;
  const cands = new Set<string>();
  const dealt = new Set<string>();
  for (const [r, s] of S.tapClaims) if (s === mine && !S.tapRejected.has(r)) cands.add(r);
  for (const [r, up] of S.tapDealt) if (up.has(mine)) { dealt.add(r); cands.add(r); }
  if (cands.size === 1) {
    const rid = [...cands][0]!;
    if (dealt.has(rid)) {
      tapBind(rid, { seat: mine, cards: S.tapDealt.get(rid)!.get(mine),
                     why: `this socket deals face-up cards into our own seat ${mine}` });
    } else {
      tapBind(rid, { seat: mine, why: `this socket's own buy-in / sit-in frames name our seat ${mine} - bound before the first deal` });
    }
    return;
  }
  if (cands.size < 2) return;
  const dom = [...(S.tapDomCards || [])].sort();
  const byCards = [...cands].filter((r) => dom.length && JSON.stringify([...(S.tapDealt.get(r)?.get(mine) || [])].sort()) === JSON.stringify(dom));
  if (byCards.length === 1) {
    tapBind(byCards[0]!, { seat: mine, cards: dom,
                           why: `several sockets name our seat ${mine}; this one dealt the cards our own frame shows` });
  } else {
    const key = [...cands].sort();
    if (!S.tapAmbiguousSaid.has(key)) {
      S.tapAmbiguousSaid.add(key);
      dumpEvent("<tap-bind-ambiguous>", { rids: key, seat: mine,
                                          why: "more than one socket names our seat - waiting for hole cards to tell them apart" });
    }
  }
}

/** The bound socket's held frames, once, right after it binds. */
export function tapTakeReplay(): Record<string, any>[] {
  const out = S.tapReplay;
  S.tapReplay = [];
  return out;
}

/** True when this frame belongs to the table we are watching and should be read NOW. */
export function tapAccepts(d: Record<string, any>, rid: string | null | undefined): boolean {
  if (rid === null || rid === undefined) return true;
  const multi = TABLES.slot() !== null;
  if (S.tapBound === null) {
    const up = d.pid === "CO_CARDTABLE_INFO" ? faceUpSeats(d) : new Map<number, string[]>();
    if (!multi) {
      if (up.size) {
        S.tapStall = { since: null, said: false };
        S.tapBound = rid;
        dumpEvent("<tap-bound>", { rid, why: "hero's cards are face up on this socket" });
      }
      return true;
    }
    if (up.size) {
      S.tapSeen.set(rid, sortedNums(up.keys()));
      S.tapDealt.set(rid, up);
      const mine = S.liveStatus.heroSeatDom ?? null;
      if (mine === null) {
        dumpEvent("<tap-bind-waiting>", { rid, seats: sortedNums(up.keys()), why: "the DOM has not said which seat is hero's yet" });
      } else if (!up.has(mine)) {
        dumpEvent("<tap-other-table>", { rid, seats: sortedNums(up.keys()), ourSeat: mine });
      }
    }
    const s = heroClaim(d);
    if (s !== null && S.tapClaims.get(rid) !== s) {
      S.tapClaims.set(rid, s);
      dumpEvent("<tap-claim>", { rid, seat: s, frame: d.pid ?? null, ourSeat: S.liveStatus.heroSeatDom ?? null });
    }
    let hold = S.tapHold.get(rid);
    if (!hold) S.tapHold.set(rid, (hold = []));
    if (d.pid === "PLAY_STAGE_INFO") hold.length = 0;
    if (hold.length < TAP_HOLD_MAX) hold.push(d);
    tapTryBind();
    if (S.tapBound !== null) return false;
    S.tapHeld += 1;
    if (S.tapStall.since === null) S.tapStall.since = time();
    else if (time() - S.tapStall.since > TAP_STALL_S && !S.tapStall.said) {
      S.tapStall.said = true;
      log(`[ws] STALLED: ${S.tapHeld} frames held, no socket identified as table ${pyStr(TABLES.slot())}'s (our seat reads ${pyStr(S.liveStatus.heroSeatDom ?? null)})`);
      feedAdd("Capture cannot tell which table is ours - no answers until it can (it will not guess)");
    }
    if ([1, 10, 100, 1000, 10000].includes(S.tapHeld)) {
      dumpEvent("<tap-held>", { rid, frame: d.pid ?? null, held: S.tapHeld,
                                why: "no socket identified as ours yet - holding rather than mixing tables" });
    }
    return false;
  }
  if (rid === S.tapBound) return true;
  S.tapForeign += 1;
  if ([1, 10, 100, 1000].includes(S.tapForeign)) {
    dumpEvent("<tap-foreign-frame>", { rid, frame: d.pid ?? null, dropped: S.tapForeign });
  }
  return false;
}

/** Hero's cards as OUR OWN frame renders them must be the cards the bound socket dealt; sustained disagreement
 *  means the socket is another table's. */
export function tapVerify(domCards: string[]): void {
  S.tapDomCards = [...(domCards || [])];
  if (S.tapBound === null || TABLES.slot() === null) return;
  const tapCards: string[] = ws().heroCards || [];
  if (!domCards.length || !tapCards.length || domCards.length < 2) {
    S.tapMismatch = 0;
    return;
  }
  if (JSON.stringify([...domCards].sort()) === JSON.stringify([...tapCards].sort())) {
    S.tapMismatch = 0;
    return;
  }
  S.tapMismatch += 1;
  if (S.tapMismatch >= TAP_MISMATCH_TICKS) {
    tapUnbind(`our frame shows ${domCards.join(" ")} while this socket dealt ${tapCards.join(" ")} — it is another table's`);
    feedAdd("Capture was following the wrong table — re-identifying it from your own seat");
  }
}

/** An incoming flop that cannot belong to the hand in progress (boards only grow). */
export function boardContradicts(d: Record<string, any>): boolean {
  const have = (ws().board || []).filter((c: any) => c);
  if (!have.length) return false;
  const names = (d.bcard || []).map(wireCard).filter((n: string | null): n is string => !!n);
  return names.length === 3 && JSON.stringify(names.slice(0, have.length)) !== JSON.stringify(have.slice(0, names.length));
}

/** Close the hand in progress and open a new one. */
export function beginHand(hid: string | null): void {
  hid = hid || "";
  wsSeams.archiveHand();
  S.handNo += 1;
  S.handIds.set(S.handNo, hid);
  const w = ws();
  w.board = [];
  w.maxBet = 0;
  w.heroFolded = false;
  w.actionOn = null;
  w.committed = new Map();
  w.moneyIn = new Map();           // every chip each seat has put in this hand, all streets (noteAccount)
  w.startCents = new Map();        // each seat's stack as dealt, from its first account this hand
  w.actions = [];
  w.actSeen = new TupleSet();
  w.foldedSeats = new Set<number>();
  w.domFolds = new Set<number>();
  w.foldTicks = new Map<number, number>();
  w.heroTurn = null;
  w.heldCards = new Set<number>();
  w.heroCards = [];
  w.pot = null;
  w.potCents = null;
  w.handOver = false;
  w.endedSince = null;
  w.lastHandNoSeen = false;
  w.cleared = false;
  w.dealer = null;
  w.dealt = [];
  w.heroDealt = null;
  w.domGraceUntil = time() + 2.5;
  w.bbSeen = false;
  feedAdd("───── new hand ─────");
  if (hid) feedAdd(`(hand id ${hid})`);
}

const idOf = (v: unknown) => (truthy(v) ? pyStr(v) : "");

export function onGameMsg(d: Record<string, any>): void {
  if (S.fakeMode) {
    dumpMark("dropped: fake-table test mode");
    return;
  }
  const w = ws();
  const pid = d.pid;
  if (pid === "PLAY_STAGE_INFO") {
    const hid = idOf(d.stageNo);
    if (hid && hid === S.handIds.get(S.handNo)) {
      dumpMark("dup: repeated PLAY_STAGE_INFO for the same hand id");
      return;
    }
    if (hid && !S.handIds.get(S.handNo) && w.handOver && !w.lastHandNoSeen && !w.cleared
        && (truthy(w.actions) || truthy(w.dealt))) {
      S.handIds.set(S.handNo, hid);
      dumpMark("adopted: the end-of-hand repeat named this id-less hand");
      feedAdd(`(hand id ${hid} — from the end-of-hand repeat)`);
      return;
    }
    beginHand(hid);
  } else if (pid === "CO_BCARD3_INFO" && boardContradicts(d)) {
    dumpMark("forced new hand: flop contradicts the board held in this hand");
    beginHand(null);
    onGameMsg(d);
    return;
  } else if (pid === "CO_BLIND_INFO") {
    const btn = d.btn ?? null, bet = d.bet ?? null;
    if (truthy(bet)) {
      if (btn === 4) {
        const guessed = w.bbGuessed;
        delete w.bbGuessed;
        if (truthy(guessed) && w.bb !== bet) {
          w.bb = bet;
          refeedBlindGuess();
        }
        w.bb = bet;
      } else if (btn === 2 && !w.bbSeen) {
        w.bb = bet * 2;
        w.bbGuessed = true;
      }
      w.bbSeen = true;
      w.maxBet = Math.max(w.maxBet ?? 0, bet);
      const com: Map<number | null, number> = (w.committed ??= new Map());
      const seat = d.seat ?? null;
      com.set(seat, (com.get(seat) ?? 0) + bet);
      moneyIn(seat, bet + (Number(d.dead) || 0));     // a dead blind leaves the stack too, just not as a bet
    }
    noteAccount(d.seat ?? null, d.account);
    const label = btn !== null ? BLIND_BTN[btn] : undefined;
    if (btn === 2 || btn === 4) actAdd(d.seat ?? null, btn === 2 ? "post-sb" : "post-bb", bet);
    // A POST-IN (btn 8): a new/returning player's live blind out of turn — "Seat 1 posts post (1 BB)". Recorded
    // since 2026-09-25 (hands 4920414446 / 4920414607): without it the poster's option-CHECK read as an illegal
    // check and the level reconciler invented a call for the chips. The API folds it into his own action.
    else if (btn === 8 && truthy(bet)) actAdd(d.seat ?? null, "post", bet);
    feedAdd(`Seat ${pyStr(d.seat ?? null)} posts ` + (label ? `${label} (${amt(bet)})` : `(${amt(bet)})`));
    if (w.bbGuessed) S.feed[S.feed.length - 1]!.guessCents = bet;
  } else if (pid === "CO_SELECT_REQ") {
    w.heroTurn = { at: time(), hand: S.handNo, timeBank: d.timeBank ?? null, bet: d.bet ?? null, raise: d.raise ?? null, btns: d.btns ?? null };
  } else if (pid === "CO_SELECT_INFO") {
    if (d.seat !== null && d.seat !== undefined && d.seat === w.heroSeat) w.heroTurn = null;
    applySelect(d.seat ?? null, d.btn ?? null, d.bet || 0, d.raise || 0, d.account ?? null);
  } else if (pid === "CO_SELECT_SPEED_INFO") {
    const btns: number[] = d.btn || [];
    const bets: number[] = d.bet || [];
    const rzs: number[] = d.raise || [];
    const accts: unknown[] = d.account || [];
    const n = Math.max(btns.length, bets.length, rzs.length);
    const first = d.firstSeat || 1;
    for (let k = 0; k < n; k++) {
      const seat = ((((first - 1 + k) % n) + n) % n) + 1;
      const i = seat - 1;
      const b = i < btns.length ? btns[i]! : 0;
      const be = i < bets.length ? bets[i]! : 0;
      const rz = i < rzs.length ? rzs[i]! : 0;
      if (!(b || be || rz)) continue;
      applySelect(seat, b, be, rz, i < accts.length ? accts[i] : null);
    }
  } else if (pid === "CO_BCARD3_INFO") {
    const names = (d.bcard || []).map(wireCard).filter((n: string | null): n is string => !!n);
    if (names.length === 3) {
      w.board = names;
      w.maxBet = 0;
      w.committed = new Map();
      w.actSeen = new TupleSet();
      w.domGraceUntil = time() + 1.2;
      feedAdd(`— FLOP — ${names.join(" ")} — pot ${w.pot || "?"}`);
    }
  } else if (pid === "CO_BCARD1_INFO") {
    const pos = d.pos || 0;
    const name = wireCard(d.card === undefined ? "None" : pyStr(d.card));
    if (!name || pos < 4) return;
    const b: (string | null)[] = w.board;
    const idx = pos - 1;
    while (b.length <= idx) b.push(null);
    b[idx] = name;
    const shown = b.filter((c) => c);
    w.maxBet = 0;
    w.committed = new Map();
    w.actSeen = new TupleSet();
    w.domGraceUntil = time() + 1.2;
    const street = pos === 4 ? "TURN" : "RIVER";
    feedAdd(`— ${street} — ${shown.join(" ")} — pot ${w.pot || "?"}`);
  } else if (pid === "CO_CURRENT_PLAYER") {
    w.actionOn = d.seat ?? null;
    if (d.seat !== null && d.seat !== undefined && d.seat !== w.heroSeat) w.heroTurn = null;
  } else if (pid === "PLAY_STAGE_END_REQ") {
    w.handOver = true;
  } else if (pid === "CO_LAST_HAND_NUMBER") {
    const hid = idOf(d.stageNo);
    w.lastHandNoSeen = true;
    if (hid && !S.handIds.get(S.handNo) && w.handOver) {
      S.handIds.set(S.handNo, hid);
      feedAdd(`(hand id ${hid} — from CO_LAST_HAND_NUMBER)`);
    }
  } else if (pid === "PLAY_CLEAR_INFO") {
    w.cleared = true;
  } else if (pid === "CO_DEALER_SEAT") {
    w.dealer = d.seat ?? null;
  } else if (pid === "CO_CARDTABLE_INFO") {
    const dealt: number[] = [];
    let faceUp: number | null = null;
    for (const [k, v] of Object.entries(d)) {
      const m = /^seat(\d+)$/.exec(String(k));
      if (!m || !Array.isArray(v)) continue;
      dealt.push(Number(m[1]));
      const names = v.map(wireCard).filter((n): n is string => !!n);
      if (names.length) {
        faceUp = Number(m[1]);
        w.heroSeat = faceUp;
        w.heroCards = names;
      }
    }
    w.dealt = sortedNums(dealt);
    w.heroDealt = faceUp !== null;
  } else if (pid === "CO_CHIPTABLE_INFO") {
    const pots: number[] = d.curPot || [];
    if (pots.length) {
      const sum = pots.reduce((a, b) => a + b, 0);
      w.pot = amt(sum);
      w.potCents = sum;
    }
  } else if (pid === "CO_PCARD_INFO" && d.type === 0) {
    const names = (d.card || []).map(wireCard).filter((n: string | null): n is string => !!n);
    if (!names.length) return;
    const seat = d.seat ?? null;
    if (seat !== null && seat !== w.heroSeat) {
      feedAdd(`Seat ${pyStr(seat)} shows ${names.join(" ")}`);
    } else {
      w.heroCards = names;
      w.heroDealt = true;
      feedAdd(`Your cards: ${names.join(" ")}`);
    }
  }
}

/** One frame through the tap, exactly as the live loop runs it: accept or hold, the replay of what a socket that
 *  just bound had held, then the reader. (launch._ws_tap's per-frame body; the golden harness calls this.) */
export function tapFrame(d: Record<string, any>, rid: string | null | undefined): void {
  const take = tapAccepts(d, rid);
  const batch: [Record<string, any>, string | null, boolean][] = tapTakeReplay().map((hd) => [hd, S.tapBound, true]);
  if (take) batch.push([d, rid ?? null, false]);
  for (const [fd, frid, replayed] of batch) {
    const e = dumpBegin(fd, frid);
    if (replayed) e.replayed = true;
    try {
      onGameMsg(fd);
    } catch (ex: any) {
      e.status = `handler-error: ${ex?.message ?? ex}`;
    }
    dumpCommit(e);
  }
}
