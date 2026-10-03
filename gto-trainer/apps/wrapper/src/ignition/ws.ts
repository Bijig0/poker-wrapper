/**
 * THE AUTHORITATIVE GAME FEED — the client's own WebSocket frames (launch.py: _on_game_msg and the tap).
 *
 * The client receives plain-JSON game messages; reading them turns actions from something inferred off animated
 * pixels into discrete events with exact seat, amounts and hand id. `btn` is a bitmask, learned by correlating
 * live messages with amounts: 64 checks, 1024 folds, 256 calls, 4096 raises to, 2048 all-in.
 *
 * ONE PAGE, FOUR TABLES, ONE TAP: the tap enables Network on the page, so it receives EVERY table's frames. CDP's
 * requestId (one per WebSocket, so one per table) is what tells them apart; the tap binds to the socket that dealt
 * our seat the hole cards our OWN frame shows, and holds, then replays, what it saw while unbound (the section
 * "which socket is ours" below says why a seat number alone never binds).
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
import { markTopUpRefused } from "../topup";
import { faceUpSeats, heroClaim, wireCard } from "./dom";
import { TwinFilter } from "./wsLine";
import { noteHeroDealt, noteTapFrame } from "./stall";
import { noteRosterFrame } from "./roster";

// 1048576 = "Folds & shows" (a fold; without it the no-chips rule reads a check); blind 16 = a post with a dead small
// blind beside it — wsLine.ts has both
const BTN: Record<number, string> = { 64: "checks", 1024: "folds", 1048576: "folds", 256: "calls", 4096: "raises to", 2048: "is ALL-IN" };
const BLIND_BTN: Record<number, string> = { 2: "small blind", 4: "big blind", 8: "post", 16: "post" };
const STREET_RANK: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };

const ws = () => S.ws;

/** The archive call a test replaces (Python's tests stubbed launch._archive_hand). */
export const wsSeams = { archiveHand: () => archiveHand() };

/** How FAR the WebSocket's board reaches: the last position a board frame filled (a dropped flop message leaves
 *  [null, null, null, 'Ts'], which reaches 4). */
function boardReach(): number {
  const b: (string | null)[] = ws().board || [];
  let n = 0;
  b.forEach((c, i) => { if (c) n = Math.max(n, i + 1); });
  return n;
}

/** The street, from how far the board reaches. */
export function streetNow(): string {
  const n = boardReach();
  return n >= 5 ? "river" : n === 4 ? "turn" : n === 3 ? "flop" : "preflop";
}

/**
 * THE RABBIT HUNT IS NOT A STREET (2026-09-25, hand 4920544353). When a hand ends before the river, Ignition turns over
 * the card that would have come next — CO_RABBITCARD_INFO {pos, card}, after the pot award (CO_RESULT_INFO /
 * CO_POT_INFO), one card, pos 4 or 5 — and the client draws it in the board's own slot, where a DOM read cannot tell it
 * from a card dealt (same qa, same place). It never was: nobody acted on it. `board` is a board as the DOM shows it; the
 * hand's own cards are the ones before the first rabbit position — cut by POSITION, not by card, so a board frame the tap
 * lost still counts (a dropped turn frame with a river rabbit keeps the DOM's turn). The whole board when the table named
 * no rabbit card this hand. Until this, the export's DOM-board override archived the rabbit card as the hand's turn or
 * river (24 archived hands confirmed against their frames) and the level reconciler revived the ended hand on it.
 *
 * A rabbit card must lie PAST every card the hand dealt, and a board frame at or past its position takes it back: on a
 * stream mixing two tables (recording 20260920_131406) another table's rabbit at pos 4 arrived just before our own turn
 * frame — our DOM showed that turn, and a rabbit taken on trust would have cut it.
 */
export function withoutRabbit<T>(board: T[]): T[] {
  const cap = boardCap();
  return board.length > cap ? board.slice(0, cap) : board;
}

/** How many board cards this hand can have been dealt: 5, or the cards before the first rabbit position. */
export function boardCap(): number {
  const r: Map<number, string> | undefined = ws().rabbit;
  return r && r.size ? Math.min(...r.keys()) - 1 : 5;
}

/** Anyone has acted this hand beyond posting a blind (a post-in is a blind too). */
export function voluntaryActed(): boolean {
  return (ws().actions || []).some((a: any) => a.type !== "post-sb" && a.type !== "post-bb" && a.type !== "post");
}

/** One DOM read of the board (reader.ts feedTick), with the hole cards the SAME capture showed at hero's seat. A board
 *  on screen while nobody has acted yet cannot be this hand's — no flop comes before an action, which is why the
 *  override already waits for one — and its flop is remembered for the rest of the hand. From the deal on, not only
 *  past the deal grace: a stuck frame's board is up from the start, and the first action can come before the grace
 *  has ended plus one tick (4920545175: seat 1 folded 0.27 s after it). */
export function noteDomBoard(board: string[], hole: string[]): void {
  const m = S.domBoard;
  if (m.hand !== S.handNo) Object.assign(m, { hand: S.handNo, stale: new Set<string>(), said: new Set<string>() });
  m.hole = [...hole];
  if (board.length >= 3 && !voluntaryActed()) m.stale.add(board.slice(0, 3).join(" "));
}

const holeKey = (cards: string[]) => [...cards].sort().join(" ");

/**
 * THE SCREEN'S BOARD IS THIS HAND'S ONLY WHEN NOTHING SAYS OTHERWISE (2026-09-25). /hand takes the DOM's board when it
 * is ahead of the WebSocket's — a board frame the tap lost (ignition/hand.ts). On the multi-table page a slot's frame
 * can show a board that is not this hand's: a frame STUCK on an earlier hand (slot 4 on 2026-09-24 and 09-25: one
 * hand's board on screen for the next four to six hands while the hole cards moved on) or ANOTHER TABLE's frame (slot
 * 2's read landed on table 4 as its hand ended). Archived: preflop fold-outs with a river board (4920545175,
 * 4920432813, 4920434476), a flop replaced by an older hand's five cards (4920431916, 4920544902). Refused when:
 *  - it contradicts a card the table's own feed dealt: it fills a lost frame, it never replaces one;
 *  - the hand never left preflop: over (one dealt seat standing) with no board frame and every action preflop;
 *  - it was on screen before anyone had acted this hand (noteDomBoard): older than the hand;
 *  - the capture it came from does not show hero's hole cards as the table dealt them. On a healthy table they stay on
 *    screen with the hand's board until the hand-end wipe, folded or not (checked across the 2026-09-24/25 debug
 *    sessions); without them, or with others, the frame is another table's or an earlier hand's (4909421009: the last
 *    hand's board still up at hero's preflop decision, hero's new cards not yet drawn).
 * `board` is the screen's, cards named as the WS names them. Returns why, or null when the board may be taken.
 */
export function domBoardRefusal(board: string[]): string | null {
  const w = ws();
  const shown = board.join(" ");
  const own: (string | null)[] = w.board || [];
  if (own.some((c, i) => c && board[i] !== c)) {
    return `the screen's board ${shown} contradicts the table's own (${own.map((c) => c ?? "?").join(" ")})`;
  }
  const dealt: number[] = w.dealt || [];
  const folded: Set<number> = w.foldedSeats ?? new Set<number>();
  if (boardReach() === 0 && dealt.length && dealt.filter((s) => !folded.has(s)).length <= 1
      && (w.actions || []).every((a: any) => (a.street || "preflop") === "preflop")) {
    return `the hand ended preflop — the screen's board ${shown} was never dealt to it`;
  }
  const m = S.domBoard;
  const now = m.hand === S.handNo;
  if (now && m.stale.has(board.slice(0, 3).join(" "))) {
    return `the screen's board ${shown} was up before anyone had acted — an earlier hand's`;
  }
  const hole: string[] = w.heroCards || [];
  if (hole.length && (!now || holeKey(m.hole) !== holeKey(hole))) {
    return `the screen's board ${shown} came with ${now && m.hole.length ? m.hole.join(" ") : "no hole cards"} at hero's seat, `
      + `not ${hole.join(" ")} — another table's or an earlier hand's`;
  }
  return null;
}

/** domBoardRefusal, logged once per hand and reason (/hand is read many times a second). */
export function domBoardRefused(board: string[]): boolean {
  const why = domBoardRefusal(board);
  if (why === null) return false;
  const m = S.domBoard;
  if (m.hand === S.handNo && !m.said.has(why)) {
    m.said.add(why);
    log(`[board] hand ${S.handIds.get(S.handNo) || `#${S.handNo}`}: ${why} — /hand keeps the table's own board`);
  }
  return true;
}

/** A board frame reached `reach`: a rabbit card at or before it was not this hand's. */
function rabbitDealt(reach: number): void {
  const w = ws();
  const r: Map<number, string> | undefined = w.rabbit;
  if (!r) return;
  for (const p of [...r.keys()]) if (p <= reach) r.delete(p);
  if (!r.size) delete w.rabbit;
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

/**
 * THE LAST SEAT STANDING (2026-09-25, hands 4920545590 / 4920544353): every other seat dealt into the hand has
 * folded, so the hand is over and this seat won it. It has no action left — its cards leave the table at the pot
 * award (mucked, "does not show") and the pot slides into its slot, which the DOM backfill read as "Seat N folds"
 * (74 of 448 archived hands ended with the winner folding) or, a tick later, as chips put in.
 * Judged only off the table's own deal (CO_CARDTABLE_INFO): with no deal frame the fold set can still hold a fold
 * from a hand whose end the DOM never saw (a tap not yet bound: golden 20260922_194132-slot2 input 91, where a real
 * flop check read as the "last seat" acting), so a DOM-only hand is left as it was.
 */
export function lastStanding(seat: number): boolean {
  const w = ws();
  const inHand: number[] = w.dealt || [];
  const folded: Set<number> = w.foldedSeats ?? new Set<number>();
  const others = inHand.filter((s) => s !== seat);
  return inHand.includes(seat) && others.length > 0 && others.every((s) => folded.has(s));
}

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

// ---- the chips as the table reports them -------------------------------------------------------------------
/**
 * EVERY SEAT'S CHIPS, AS THE WEBSOCKET REPORTS THEM (2026-09-25, round 3 of the input-mutation harness; Brady: "we
 * should fix this"). The API's capture gate caught a lost villain action by comparing the table's POT with the line,
 * with 0.6bb of slack — so a lost small-blind complete (0.5bb; 0.6 at the 5c stake) by a seat that then folded, or a
 * lost call by a seat yet to act on the new street, could still be answered as if that seat had folded. The money is
 * exact per seat: every blind and action frame carries the seat's `account` (its chips behind right after the frame)
 * and the chips the frame put in (`bet` / `raise`, the same arithmetic applySelect uses for `committed`). Recorded
 * here for the FRAME ITSELF — before the ghost guard and the dedupe decide whether it becomes an action — so a frame
 * whose action the line lost still moves the chips. Exported per dealt seat as `wsStack` (chips behind now),
 * `wsInFront` (this street's chips) and `wsDead` (a dead blind: chips that left the stack but are no bet), in BB
 * (ignition/hand.ts); the API checks `startStacks − wsStack` against the chips each seat's captured actions put in,
 * to the cent (utils/repairPostflopRotation lostActionFaults, "exact per-seat chips").
 *
 * A seat whose last money action the DOM backfill filed BEFORE any WebSocket frame said so is STALE (`wsStale`,
 * reader.ts): its reported chips predate an action the line already holds, so it is left out of the export until
 * its next frame — unknown is not a discrepancy. A returned uncalled bet (CO_CHIPTABLE_INFO returnBet) is not added
 * back: it ends the betting, so no decision reads it, and the ledger stays "chips the seat's actions moved".
 */
function wsChips(seat: number | null, account: unknown, added: number, dead = 0): void {
  if (seat === null || seat === undefined) return;
  const w = ws();
  const hasAccount = typeof account === "number" && Number.isFinite(account) && account >= 0;
  // A REPEATED FRAME IS NOT MORE MONEY: chips cannot go in without the account dropping, so a money frame that reports
  // the account this seat already has is the same frame again (recording 20260921_125219 carries every frame twice) —
  // counted once. The account itself is idempotent; the chips in front would double.
  if (added > 0 && hasAccount && (w.wsAccount as Map<number, number> | undefined)?.get(seat) === account) return;
  if (added > 0) {
    const f: Map<number, number> = (w.wsFront ??= new Map());
    f.set(seat, (f.get(seat) ?? 0) + added);
  }
  if (dead > 0) {
    const d: Map<number, number> = (w.wsDead ??= new Map());
    d.set(seat, (d.get(seat) ?? 0) + dead);
  }
  if (hasAccount) {
    (w.wsAccount ??= new Map<number, number>()).set(seat, account as number);
    (w.wsStale as Set<number> | undefined)?.delete(seat);
  }
}

/** The chips a CO_SELECT_INFO (or one batched slot) puts in front of the seat — applySelect's own arithmetic:
 *  a raise ADDS `raise`, a call/bet adds `bet`, an all-in the larger of the two, a check or fold nothing. */
export function chipsAdded(btn: number | null, bet: number, rz: number): number {
  let verb = btn !== null && btn !== undefined ? BTN[btn] : undefined;
  if (verb === undefined) verb = rz ? "raises to" : bet ? "calls" : "checks";
  return verb === "raises to" ? rz : verb === "calls" ? bet : verb === "is ALL-IN" ? Math.max(bet, rz) : 0;
}

// ---- one player action ----------------------------------------------------------------------------------
/** One player action, from a live CO_SELECT_INFO or one slot of a batched CO_SELECT_SPEED_INFO. `raise` is
 *  chips ADDED; unmapped btn codes are inferred from the amounts. `account` is the seat's chips behind after it. */
export function applySelect(seat: number | null, btn: number | null, bet: number, rz: number, account: unknown = null): void {
  const w = ws();
  wsChips(seat, account, chipsAdded(btn, bet, rz));   // the table's money, whatever becomes of the action below
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
/**
 * WITH SEVERAL TABLES, A SEAT NUMBER IS NOT A TABLE (2026-09-25). Hero sits in the same seat at two of four tables
 * all the time, and the frames that name a seat arrive from every table's socket in whatever order the tables sit
 * down. Seat evidence bound other tables' sockets in all three four-table sessions that day: slot 3 took the leader's
 * socket on its buy-in 300 ms before its own table's arrived (11292.614, 05:11:10), slot 3 took slot 4's on its buy-in
 * naming seat 3 and flip-flopped on it for hands (21032.3585, 13:56:42), the leader took the A8o table's new socket on
 * its sit-in (2864.10681, 18:11:19) and again on a deal into "our seat 4" (18:12:19). What identifies a table is the
 * CARDS: the socket that dealt our seat exactly the hole cards our own frame shows. So with several tables a socket
 * binds on that alone — claims and seat deals only say a candidate exists — on the DOM tick the cards appear, and its
 * hand is replayed from its PLAY_STAGE_INFO at once (tapNote keeps every socket's), so nothing of the hand is lost by
 * waiting for the cards; bound, our frame showing the cards ANOTHER socket just dealt our seat moves us to it.
 */
const TAP_HOLD_MAX = 1500;
export const TAP_STALL_S = 90.0;
const TAP_MISMATCH_TICKS = 8;
/** How long our frame may go on showing the PREVIOUS hand's cards after the bound socket dealt a new one before that
 *  counts as a disagreement: measured 3.7 s live (2026-09-25 18:12:11.6 → 18:12:15.3, a verify that let the right
 *  socket go), the tick grace (TAP_MISMATCH_TICKS × 0.25 s) is 2 s. */
export const TAP_DEAL_LAG_S = 10.0;
/** How long after the bound socket deals hero in our frame has to show those cards once before the socket counts as
 *  another table's (tapVerify). The deal animation takes a tick or two, but a frame still showing the hand before's
 *  showdown draws the new cards only after it: 6 s on table 3 (2864.10681 dealt J♣4♠ at 18:11:21.5, its frame showed
 *  them at 18:11:27.5 — at 5 s this let the right socket go and dropped the hand), so the same allowance as the lag. */
export const TAP_DEAL_SHOW_S = TAP_DEAL_LAG_S;

const sameCards = (a: readonly string[], b: readonly string[]) => a.length > 0 && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Let go of the socket and look again. THE HAND IN PROGRESS GOES WITH IT (2026-09-25): it was read off that socket,
 *  so carrying on meant the next socket's frames — and our own frame's DOM backfill — were added to another table's
 *  hand (A8o 4920571422: "seat 6 acted on the preflop but has no position label; preflop actions appear after turn
 *  actions"). A socket let go of binds again only by dealing the cards our own frame shows (tapTryBind). */
export function tapUnbind(why: string): void {
  if (S.tapBound !== null) {
    dumpEvent("<tap-unbound>", { rid: S.tapBound, why });
    S.tapRejected.add(S.tapBound);
    const w = ws();
    if (truthy(w.actions) || truthy(w.dealt) || truthy(w.heroCards)) abandonHand("its socket was another table's");
  }
  S.tapBound = null;
  S.tapMismatch = 0;
  S.tapHold.clear();
}

/** A socket that is gone for good (the site closed its table): nothing it dealt or claimed may bind or be replayed
 *  again — the next table's socket is found from its own deal into our own frame. */
export function tapForget(rid: string): void {
  for (const m of [S.tapHist, S.tapHold, S.tapDeals, S.tapClaims, S.tapSeen]) m.delete(rid);
  S.tapRejected.delete(rid);
  if (S.tapBound === rid) S.tapBound = null;
}

/** Bind `rid`: its current hand (every frame since its PLAY_STAGE_INFO, whether or not we were reading it) is
 *  replayed through the reader, so a socket bound mid-hand — first time, or back after a drop — rebuilds the hand
 *  from its start. */
export function tapBind(rid: string, why: Record<string, any>): void {
  S.tapStall = { since: null, said: false };
  S.tapBound = rid;
  S.tapReplay = [...(S.tapHist.get(rid) || S.tapHold.get(rid) || [])];
  S.tapHold.clear();
  S.tapMismatch = 0;
  dumpEvent("<tap-bound>", { rid, replayed: S.tapReplay.length, ...why });
}

/** Every socket's current hand — its frames and its face-up deal — kept whether or not it is the one we read, so
 *  the right one can be found (and rebuilt) later. A new hand on a socket clears its old deal: a deal from a hand
 *  that is over never binds anything. */
function tapNote(d: Record<string, any>, rid: string): void {
  let h = S.tapHist.get(rid);
  if (!h) S.tapHist.set(rid, (h = []));
  if (d.pid === "PLAY_STAGE_INFO") {
    h.length = 0;
    S.tapDeals.delete(rid);
  }
  if (h.length < TAP_HOLD_MAX) h.push(d);
  if (d.pid === "CO_CARDTABLE_INFO") {
    const up = faceUpSeats(d);
    if (up.size) S.tapDeals.set(rid, { up, at: time() });
  }
}

/** Multi-table: bind the ONE socket whose current deal gave our seat exactly the hole cards our own frame shows —
 *  whatever claimed our seat or was let go before. The cards are the one fact another table cannot share: two tables
 *  can seat hero in the same seat number (seat 4 at two of the 2026-09-25 tables), and table 1 bound the other one's
 *  socket on its sit-in, then again and again on a deal into "our seat 4" that was the previous hand's, from another
 *  table, while its own frame showed 9♠9♣ and then 5♣7♣. With no cards on our frame nothing binds (a buy-in, a
 *  sit-in or a deal naming our seat only says which sockets could be ours): the frame draws a deal of its own within a
 *  second or two, and the socket's hand is replayed from its start when it does. */
export function tapTryBind(): void {
  const mine = S.liveStatus.heroSeatDom ?? null;
  if (mine === null) return;
  const dom = (S.tapDomCards || []).length >= 2 ? [...S.tapDomCards] : null;
  const match = dom ? dealtTo(mine, dom) : [];
  if (match.length === 1) {
    const rid = match[0]!;
    tapBind(rid, { seat: mine, cards: dom, why: S.tapRejected.has(rid)
      ? `this socket, let go of before, dealt the cards our own frame shows into our seat ${mine}`
      : `this socket dealt the cards our own frame shows into our seat ${mine}` });
    return;
  }
  if (match.length > 1) {
    tapAmbiguous(match, mine, "more than one socket dealt the cards our frame shows - waiting");
    return;
  }
  const cands = new Set<string>();
  for (const [r, st] of S.tapClaims) if (st === mine) cands.add(r);
  for (const [r, dl] of S.tapDeals) if (dl.up.has(mine)) cands.add(r);
  if (cands.size) {
    tapAmbiguous([...cands], mine, `${cands.size} socket(s) name our seat ${mine} - a seat number is not a table: `
                                   + "waiting for our own frame to show the cards one of them dealt");
  }
}

/** The sockets whose current deal gave our seat exactly these cards. */
function dealtTo(seat: number, cards: readonly string[]): string[] {
  return [...S.tapDeals].filter(([, dl]) => sameCards(dl.up.get(seat) || [], cards)).map(([r]) => r);
}

/** Bound to one socket, our own frame shows the cards ANOTHER dealt our seat (a table moved to a new socket): follow
 *  that one — the hand in progress goes with the old socket (tapUnbind), the new one's is replayed from its start. */
function tapSwitch(rid: string, why: string, seat: number, cards: string[]): void {
  tapUnbind(why);
  tapBind(rid, { seat, cards, why: "our own frame shows the cards this socket dealt our seat" });
  drainReplay();
  feedAdd("Capture moved to the socket that dealt the cards on your own table");
}

function tapAmbiguous(rids: string[], seat: number, why: string): void {
  const key = [...rids].sort();
  if (S.tapAmbiguousSaid.has(key)) return;
  S.tapAmbiguousSaid.add(key);
  dumpEvent("<tap-bind-ambiguous>", { rids: key, seat, why });
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
  if (multi) tapNote(d, rid);
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
      log(`[ws] STALLED: ${S.tapHeld} frames held, no socket identified as table ${pyStr(TABLES.slot())}'s (our seat reads ${pyStr(S.liveStatus.heroSeatDom ?? null)}, `
          + `our frame shows ${S.tapDomCards.length ? S.tapDomCards.join(" ") : "no hole cards"})`);
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
 *  means the socket is another table's. The bound socket's cards are the hand in progress: a socket let go of takes
 *  its hand with it (tapUnbind), so what is compared here was only ever dealt by the socket we are on.
 *  THE DOM LAGS A NEW DEAL: our frame still showing the hand before's cards within TAP_DEAL_LAG_S of the socket's deal
 *  is our table catching up, not a disagreement (2026-09-25 18:12:15: 6♦5♦ on screen 3.7 s after this table's socket
 *  dealt 9♠9♣ let the RIGHT socket go — and table 1 never found its way back).
 *  Unbound, this is where a socket binds: the DOM tick our frame shows cards some socket dealt our seat (tapTryBind),
 *  its hand read at once. Our frame showing the cards ANOTHER socket just dealt our seat moves us there (tapSwitch).
 *  A frame the browser is not drawing (`drawn` false, reader.ts noteFrame) is never held against the socket: what it
 *  shows may be seconds or hands old. */
export function tapVerify(domCards: string[], drawn = true): void {
  S.tapDomCards = [...(domCards || [])];
  if (TABLES.slot() === null) return;
  if (S.tapBound === null) {
    tapTryBind();
    if (S.tapBound !== null) drainReplay();
    return;
  }
  if (!drawn) {
    S.tapMismatch = 0;
    return;
  }
  const tapCards: string[] = ws().heroCards || [];
  if (!domCards.length || !tapCards.length || domCards.length < 2) {
    // A DEAL OUR FRAME NEVER DRAWS is another table's: the socket dealt hero in and our frame has not once shown
    // those cards (2026-09-25 18:10:22 — table 1, hero sitting out at its own table after the reconnect, bound the A8o
    // table's socket on a sit-in naming its seat, and read that table's 6♠K♥ hand, with its own frame's seats merged
    // in, for 56 s — until its own table dealt it A♠2♥ and the cards could disagree)
    if (tapCards.length && !S.tapDealDrawn && S.tapDealtAt > 0 && time() - S.tapDealtAt > TAP_DEAL_SHOW_S) {
      S.tapMismatch += 1;
      if (S.tapMismatch >= TAP_MISMATCH_TICKS) {
        tapUnbind(`this socket dealt ${tapCards.join(" ")} into our seat ${fmtFixed(time() - S.tapDealtAt, 1)} s ago and our frame has not shown them once — it is another table's`);
        feedAdd("Capture was following the wrong table — re-identifying it from your own seat");
      }
      return;
    }
    S.tapMismatch = 0;
    return;
  }
  if (JSON.stringify([...domCards].sort()) === JSON.stringify([...tapCards].sort())) {
    S.tapMismatch = 0;
    S.tapDealDrawn = true;
    return;
  }
  if (sameCards(domCards, S.tapPrevHero) && time() - S.tapDealtAt < TAP_DEAL_LAG_S) {
    S.tapMismatch = 0;
    return;
  }
  const mine = S.liveStatus.heroSeatDom ?? null;
  const others = mine === null ? [] : dealtTo(mine, domCards).filter((r) => r !== S.tapBound);
  if (others.length === 1) {
    tapSwitch(others[0]!, `our frame shows ${domCards.join(" ")}, which socket ${others[0]} dealt our seat ${mine}; this socket `
              + `dealt ${tapCards.join(" ")} — it is another table's`, mine!, [...domCards]);
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
  S.tapPrevHero = [...(w.heroCards || [])];
  S.tapDealtAt = 0.0;
  S.tapDealDrawn = false;
  w.board = [];
  w.maxBet = 0;
  w.heroFolded = false;
  w.actionOn = null;
  w.committed = new Map();
  w.moneyIn = new Map();           // every chip each seat has put in this hand, all streets (noteAccount)
  w.startCents = new Map();        // each seat's stack as dealt, from its first account this hand
  w.wsAccount = new Map();         // each seat's chips behind per its latest frame this hand (wsChips)
  w.wsFront = new Map();           // each seat's chips in front this street, per its frames
  w.wsDead = new Map();            // dead blinds: chips out of the stack that are no bet
  w.wsStale = new Set<number>();   // seats whose last money action the DOM filed ahead of any frame
  w.actions = [];
  w.frames = [];                   // every frame the tap took for this hand, in order — the protocol line (wsLine.ts)
  w.frameFilter = new TwinFilter(); // a frame delivered twice is one frame (keepFrame)
  w.actSeen = new TupleSet();
  w.foldedSeats = new Set<number>();
  w.domFolds = new Set<number>();
  w.foldTicks = new Map<number, number>();
  w.heroTurn = null;
  w.heldCards = new Set<number>();
  w.heroCards = [];
  w.pot = null;
  w.potCents = null;
  w.rakeCents = null;              // the rake taken from the pot so far (CO_CHIPTABLE_INFO curRake)
  w.rakeByStreet = {};             // that rake as each street was entered: flop / turn / river / end
  w.handOver = false;
  w.endedSince = null;
  w.lastHandNoSeen = false;
  w.cleared = false;
  w.dealer = null;
  w.dealt = [];
  w.heroDealt = null;
  w.domGraceUntil = time() + 2.5;
  w.bbSeen = false;
  delete w.rabbit;                 // the rabbit hunt's card by board position (withoutRabbit) — only set by its frame
  feedAdd("───── new hand ─────");
  if (hid) feedAdd(`(hand id ${hid})`);
}

/** Drop the hand in progress WITHOUT archiving it: it was read (wholly or in part) off a socket that turned out to
 *  be another table's, so it is neither this table's history nor a spot to answer. An id-less hand opens in its
 *  place (never archived either, S.handAbandoned); the socket bound next replays its own hand from its start. */
export function abandonHand(why: string): void {
  const keep = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    beginHand(null);
  } finally {
    wsSeams.archiveHand = keep;
  }
  S.handAbandoned = S.handNo;
  S.tapPrevHero = [];
  feedAdd(`(the hand in progress was dropped — ${why})`);
  log(`[ws] hand in progress dropped — ${why}`);
}

const idOf = (v: unknown) => (truthy(v) ? pyStr(v) : "");

/** The hand's frames for the protocol line (wsLine.ts), less a frame delivered twice (wsLine.TwinFilter). */
function keepFrame(w: Record<string, any>, d: Record<string, any>): void {
  const f: TwinFilter = (w.frameFilter ??= new TwinFilter());
  if (f.keep(d, time())) (w.frames ??= []).push(d);
}

export function onGameMsg(d: Record<string, any>): void {
  if (S.fakeMode) {
    dumpMark("dropped: fake-table test mode");
    return;
  }
  const w = ws();
  const pid = d.pid;
  noteRosterFrame(d);   // the seats' words between hands — why a seat was not dealt (roster.ts)
  // THE HAND'S FRAMES (wsLine.ts builds /hand's line from them): every frame this handler takes, in order; a new
  // hand's PLAY_STAGE_INFO opens the list below, after beginHand has emptied it
  if (pid !== "PLAY_STAGE_INFO") keepFrame(w, d);
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
    keepFrame(w, d);
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
      wsChips(seat, d.account, bet, Number(d.dead) || 0);
    } else wsChips(d.seat ?? null, d.account, 0);
    noteAccount(d.seat ?? null, d.account);
    const label = btn !== null ? BLIND_BTN[btn] : undefined;
    if (btn === 2 || btn === 4) actAdd(d.seat ?? null, btn === 2 ? "post-sb" : "post-bb", bet);
    // A POST-IN (btn 8): a new/returning player's live blind out of turn — "Seat 1 posts post (1 BB)". Recorded
    // since 2026-09-25 (hands 4920414446 / 4920414607): without it the poster's option-CHECK read as an illegal
    // check and the level reconciler invented a call for the chips. The API folds it into his own action.
    else if ((btn === 8 || btn === 16) && truthy(bet)) actAdd(d.seat ?? null, "post", bet);
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
      w.wsFront = new Map();
      w.actSeen = new TupleSet();
      w.domGraceUntil = time() + 1.2;
      rabbitDealt(3);
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
    w.wsFront = new Map();
    w.actSeen = new TupleSet();
    w.domGraceUntil = time() + 1.2;
    rabbitDealt(pos);
    const street = pos === 4 ? "TURN" : "RIVER";
    feedAdd(`— ${street} — ${shown.join(" ")} — pot ${w.pot || "?"}`);
  } else if (pid === "CO_RABBITCARD_INFO") {
    // the card the next street would have been, shown after the award — kept apart from the board (withoutRabbit)
    const pos = Number(d.pos) || 0;
    const name = wireCard(d.card === undefined || d.card === null ? "None" : pyStr(d.card));
    if (!name || !(pos >= 1 && pos <= 5)) return;
    if (pos <= boardReach()) {
      dumpMark(`dropped: rabbit card at board position ${pos}, which this hand dealt (another table's frame?)`);
      return;
    }
    (w.rabbit ??= new Map<number, string>()).set(pos, name);
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
        S.tapDealtAt = time();
        S.tapDealDrawn = false;
      }
    }
    w.dealt = sortedNums(dealt);
    w.heroDealt = faceUp !== null;
    if (w.heroDealt) noteHeroDealt(S.handNo);
  } else if (pid === "CO_CHIPTABLE_INFO") {
    const pots: number[] = d.curPot || [];
    if (pots.length) {
      const sum = pots.reduce((a, b) => a + b, 0);
      w.pot = amt(sum);
      w.potCents = sum;
    }
    // THE RAKE, AS IGNITION TAKES IT (2026-10-03, Brady: "on the flop we read 4bb … after rake is 3.8 and that is the
    // amount we are actually playing for"): curPot is the GROSS pot; curRake beside it is the rake taken so far (5%
    // rounded down to the cent, none before a flop). Final curPot − curRake = the award, in every hand of the
    // 2026-10-03 dumps. The pot is swept in before the next street's cards, so the board length names the street
    // being entered; a frame with all five cards out is the end of the hand.
    const rakes: number[] = d.curRake || [];
    if (rakes.length) {
      const rake = rakes.reduce((a, b) => a + b, 0);
      w.rakeCents = rake;
      const out = (w.board || []).filter(Boolean).length;
      const entering = out >= 5 ? "end" : out === 4 ? "river" : out === 3 ? "turn" : "flop";
      (w.rakeByStreet ??= {})[entering] = rake;
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
      noteHeroDealt(S.handNo);
      feedAdd(`Your cards: ${names.join(" ")}`);
    }
  } else if (pid === "PLAY_ACCOUNT_CASH_RES" && d.type === 5) {
    // THE CLIENT'S OWN ADD-CHIPS RESULT (2026-09-30). A top-up pressed mid-hand is added when the hand ends; `cash` is
    // what was added — 0 when hero's stack is already at the max (the buy before a closing river check that then chopped:
    // session_20260930_104219 hand 4921602320, and six more refusals across the socket dumps, every one of them
    // {type 5, seat: hero, cash 0} a millisecond after PLAY_STATUS_INFO {type 3, status 2, dwData: the max}). The
    // client's notice for it follows seconds later and is only filed by a tick that reads it; this word is on the
    // socket whatever the screen read does. Type 2 is a seat's buy-in (every seat, every hand) — not this.
    const seat = d.seat ?? null;
    const hero = w.heroSeat ?? null;
    if ((d.cash ?? null) === 0 && (seat === null || hero === null || seat === hero)) {
      if (markTopUpRefused("the table's socket: nothing added, the stack is at the max")) {
        log(`[ws] top-up refused on the socket: PLAY_ACCOUNT_CASH_RES type 5 seat ${pyStr(seat)} cash 0`);
      }
    }
  }
}

/** One frame through the tap, exactly as the live loop runs it: accept or hold, the replay of what a socket that
 *  just bound had held, then the reader. (launch._ws_tap's per-frame body; the golden harness calls this.) */
export function tapFrame(d: Record<string, any>, rid: string | null | undefined): void {
  noteTapFrame(rid, d.pid);
  const take = tapAccepts(d, rid);
  const batch: [Record<string, any>, string | null, boolean][] = tapTakeReplay().map((hd) => [hd, S.tapBound, true]);
  if (take) batch.push([d, rid ?? null, false]);
  readFrames(batch);
}

/** A socket bound on a DOM tick (tapVerify): its held hand is read NOW, not whenever its next frame happens to come —
 *  seconds, with hero possibly first to act (5.6 s after the cards showed, recording 20260922_194118 slot 1). */
function drainReplay(): void {
  readFrames(tapTakeReplay().map((hd) => [hd, S.tapBound, true]));
}

function readFrames(batch: [Record<string, any>, string | null, boolean][]): void {
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
