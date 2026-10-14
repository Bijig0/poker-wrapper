/**
 * THE STRUCTURED HAND EXPORT (GET /hand, CONTRACT.md §1a) — launch.py's _hand_state and what it leans on:
 * positions from the button and who was dealt in, the three independent views of hero's turn, and the cut-over
 * between the event log's betting line and the level reconciler's.
 *
 * Positions use gto-trainer's vocabulary (UTG/HJ/CO), assigned from the button backwards so a short table maps
 * onto the late seats of the 6-max tree.
 */
import { time } from "../clock";
import { log } from "../feed";
import { pyFloatStr, pyRound, pyStr, sortedNums, splitWs } from "../py";
import { CGG, CP, S, isCgg, isCp } from "../state";
import { C } from "../config";
import * as TABLES from "../tables";
import { TOL } from "../reconcile";
import { potVal } from "./dom";
import { dealtCents, domBoardRefused, dumpEvent, voluntaryActed, withoutRabbit } from "./ws";
import { potAgrees, wsHand, type WsHand } from "./wsLine";
import { seatWords, undealtStatus } from "./roster";
import { KEEPALIVE_GRACE_S, KEEPALIVE_S } from "./stall";

const ws = () => S.ws;

/** THE BOUND SOCKET IS ALIVE while its last frame is this recent — and while it is, hero's turn is ITS word, never the
 *  screen's (handStateIgnition). The threshold is the keep-alive-overdue mark stall.ts already uses (one PONG every
 *  30 s + 5 s grace): every socket dump 2026-09-20 .. 10-14 (415,520 in-hand frame gaps) shows a healthy socket's
 *  longest in-hand quiet is the 30 s PONG spacing (p99 31.2 s; p99.9 of all gaps 15.6 s), and the 42 gaps over 30 s
 *  are the stalls (206 s, 132 s, 70 s …) — the one case the strip rule below is for. Hero's own ask (CO_SELECT_REQ)
 *  never comes out of silence: in 9,284 of 9,284 asks it followed the previous frame on its socket by ≤ 0.32 s. */
export const SOCKET_ALIVE_S = KEEPALIVE_S + KEEPALIVE_GRACE_S;

/** The bound socket's word on itself: `alive` (a frame within SOCKET_ALIVE_S), `silent` (bound, but quiet longer —
 *  a stall, a lost tap), `none` (no socket bound, or none heard yet: the fake table, a replay without rids). */
export function socketWord(): { word: "alive" | "silent" | "none"; silentS: number | null } {
  const rid = S.tapBound;
  const L = rid ? S.tapLast.get(rid) : undefined;
  if (!rid || !L) return { word: "none", silentS: null };
  const silent = Math.max(0, time() - L.at);
  return { word: silent <= SOCKET_ALIVE_S ? "alive" : "silent", silentS: Math.round(silent * 10) / 10 };
}

/** A strip reading older than this is no evidence of the buttons. The reader ticks every ~0.45 s (gaps up to 3.8 s
 *  under load: session_20260926_030543, 48 of 1,866 ticks over 2 s), so 6 s is a reader that has STOPPED reading, not
 *  a slow one. A tick that stands down before it reads the strip (table read failed, "table broke", not seated) leaves
 *  liveStatus.toAct as it was.
 *  Hand 4921602992 (2026-09-30): the reader returned early for four minutes with toAct frozen TRUE from the moment
 *  hero had been on the clock, so every action count of every hand went out as hero's turn — phantom solves held the
 *  API's slot and hero timed out facing a jam. A reading never stamped (S.screenReadAt null: a replay from before the
 *  field, a test that sets toAct by hand) counts as fresh. */
export const BUTTONS_STALE_S = 6.0;

/** Seconds since the reader last read the strip, or null when it never has. */
export function screenReadAgeS(): number | null {
  const at = S.screenReadAt;
  return typeof at === "number" ? Math.max(0, time() - at) : null;
}

/** The strip reading is older than BUTTONS_STALE_S: the reader stood down, and liveStatus.toAct is what it WAS. */
export function stripReadStale(): boolean {
  const age = screenReadAgeS();
  return age !== null && age > BUTTONS_STALE_S;
}

/** Hero's turn buttons are up ON A FRESH READ — the one test every press-side check should make (relay, top-up),
 *  never `S.liveStatus.toAct` alone. */
export function stripButtonsUp(): boolean {
  return !!S.liveStatus.toAct && !stripReadStale();
}

/** The three independent views of "hero to act", side by side — and the socket's word on itself (`socket`), which says
 *  whether the screen's strip was allowed to decide (handStateIgnition: only when the socket is not `alive`). */
export function toActSources(buttonsUp: boolean): Record<string, any> {
  const hero = ws().heroSeat ?? null;
  const turn = ws().heroTurn ?? null;
  const age = screenReadAgeS();
  const stale = age !== null && age > BUTTONS_STALE_S;
  const sock = socketWord();
  return {
    buttons: !!buttonsUp && !stale,
    ws: !!(turn && turn.hand === S.handNo && !ws().heroFolded),
    actionOn: hero !== null && (ws().actionOn ?? null) === hero,
    wsAt: (turn || {}).at ?? null, timeBank: (turn || {}).timeBank ?? null,
    socket: sock.word,
    ...(sock.word === "silent" ? { socketSilentS: sock.silentS } : {}),
    ...(stale && buttonsUp ? { buttonsStaleS: Math.round(age * 10) / 10 } : {}),
  };
}

/** Python's xs[start:] (negative start counts from the end). */
function sliceFrom<T>(xs: T[], start: number): T[] {
  return xs.slice(start < 0 ? Math.max(0, xs.length + start) : start);
}

/** A hand dealt with no small blind: the first seat after the button posted the big blind and nobody posted a
 *  small one. `order` = dealt seats clockwise from the seat after the button (SB … BTN). */
export function deadSmallBlind(order: number[]): boolean {
  if (order.length < 3) return false;
  let sb: number | null = null, bbSeat: number | null = null;
  for (const a of ws().actions || []) {
    if (a.type === "post-sb" && sb === null) sb = a.seat ?? null;
    else if (a.type === "post-bb" && bbSeat === null) bbSeat = a.seat ?? null;
  }
  return sb === null && bbSeat !== null && order[0] === bbSeat;
}

/**
 * THE DEALT SEATS IN BUTTON ORDER (2026-10-04, Ignition's DEAD BUTTON). `order` runs clockwise from the seat after the
 * button to the button: SB … BTN, the last seat to act before the blinds. Ignition deals a DEAD BUTTON when the player
 * due the button has left or sits out — CO_DEALER_SEAT names a seat CO_CARDTABLE_INFO did not deal: hand 4922299303
 * (2026-10-03, table 2) put the button on seat 4, emptied by a bust 40 s earlier, and dealt 1,2,3,5,6; 4922296152 put
 * it on seat 4 sitting out and dealt 1,3,5,6. Positions used to count the dealer seat in all the same and label it BTN,
 * so the real last seat — hero's seat 3 in both — was named CO: the 6-max chart answered a four-handed button open as a
 * CO's (A♠6♥ folded 99.6%), and with hero in the blinds every villain was read one seat early (a button open as a CO
 * open). 56 of 1,544 hands in the socket dumps of 2026-10-02/03 dealt a dead button (3.6%), hero on its right in 13.
 * Now the seats are named from the seats DEALT: the order starts at the first dealt seat after the dealer, so the last
 * dealt seat before the blinds is the BTN, and the early names are the ones a short table drops (five dealt:
 * SB/BB/HJ/CO/BTN — the 6-max chart walk pads UTG as the fold, exactly as at any five-handed table).
 * A dealt list of one seat (the Python recorder's partial states, never a real hand) keeps the old rule. CO_CARDTABLE_INFO
 * lists every dealt seat at once, so a dealer missing from a non-empty dealt list is a dead button, not a late frame.
 */
export function buttonOrder(dealt: number[], btn: number): { order: number[]; deadButton: boolean } {
  const live = sortedNums(new Set(dealt));
  if (!live.includes(btn) && live.length >= 2) {
    const k = live.findIndex((s) => s > btn);
    const i = k < 0 ? 0 : k;
    return { order: [...live.slice(i), ...live.slice(0, i)], deadButton: true };
  }
  const seats = live.includes(btn) ? live : sortedNums(new Set([...live, btn]));
  const i = seats.indexOf(btn);
  return { order: [...seats.slice(i + 1), ...seats.slice(0, i + 1)], deadButton: false };
}

/** The seats the positions are named from: the dealt list, plus the dealer seat when it has ACTED this hand — a seat that
 *  acted was dealt, whatever the list says. On a live table CO_CARDTABLE_INFO already lists it; an authored fake-table
 *  state (contract fixture preflop-hero-bb-limped) lists only the seats still holding cards, and its button had folded:
 *  that is a live button that folded, not a dead one. */
function dealtForPositions(): number[] {
  const dealt: number[] = ws().dealt || [];
  const btn = ws().dealer ?? null;
  if (btn === null || dealt.includes(btn) || !dealt.length) return dealt;
  return (ws().actions || []).some((a: any) => a.seat === btn) ? sortedNums(new Set([...dealt, btn])) : dealt;
}

/** Heads-up names [SB, BB]. The dealer posts the small blind; with a dead button (none in the socket dumps — every dead
 *  button there dealt three or more) the posts decide: the seat that posted the small blind, else the one that did NOT
 *  post the big blind, else the first seat after the button (as the old rule named it). */
function headsUpSeats(order: number[], btn: number, deadButton: boolean): [number, number] {
  if (!deadButton) return [btn, order.find((s) => s !== btn)!];
  const acts: any[] = ws().actions || [];
  const posted = (t: string) => acts.find((a) => a.type === t && order.includes(a.seat))?.seat ?? null;
  const sbPost = posted("post-sb"), bbPost = posted("post-bb");
  const sb = sbPost ?? (bbPost !== null ? order.find((s) => s !== bbPost)! : order[0]!);
  return [sb, order.find((s) => s !== sb)!];
}

/** Hero's position name (the panel's vocabulary: UTG+1 / MP). */
export function heroPosition(): string | null {
  const seats: number[] = dealtForPositions();
  const btn = ws().dealer ?? null, hero = ws().heroSeat ?? null;
  if (!seats.length || btn === null || hero === null || !seats.includes(hero)) return null;
  const bo = buttonOrder(seats, btn);
  let order = bo.order;
  const n = order.length;
  let names: string[];
  if (n === 2) {
    names = ["SB", "BB"];
    order = headsUpSeats(order, btn, bo.deadButton);
  } else if (deadSmallBlind(order)) {
    const late = ["CO", "BTN"];
    const early = ["UTG", "UTG+1", "MP", "MP+1", "HJ"].slice(0, Math.max(0, n - 3));
    names = ["BB", ...early, ...late].slice(0, n);
  } else if (n === 3) {
    names = ["SB", "BB", "BTN"];
  } else {
    const late = ["CO", "BTN"];
    const early = ["UTG", "UTG+1", "MP", "MP+1", "HJ"].slice(0, Math.max(0, n - 4));
    names = ["SB", "BB", ...early, ...late].slice(0, n);
  }
  const k = order.indexOf(hero);
  return k >= 0 && k < names.length ? names[k]! : null;
}

/** Every dealt seat's position, gto-trainer's names. */
export function positionsAll(): Map<number, string> {
  const dealt: number[] = dealtForPositions();
  const btn = ws().dealer ?? null;
  if (!dealt.length || btn === null) return new Map();
  const bo = buttonOrder(dealt, btn);
  const order = bo.order;
  const n = order.length;
  if (n === 2) {
    const [sb, bb] = headsUpSeats(order, btn, bo.deadButton);
    return new Map([[sb, "SB"], [bb, "BB"]]);
  }
  const BIG = ["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO"], SMALL = ["UTG", "HJ", "CO"];
  let names: string[];
  if (deadSmallBlind(order)) {
    const mids = sliceFrom(n - 2 > 3 ? BIG : SMALL, -(n - 2));
    names = ["BB", ...mids, "BTN"];
  } else if (n === 3) {
    names = ["SB", "BB", "BTN"];
  } else {
    const mids = sliceFrom(n > 6 ? BIG : SMALL, -(n - 3));
    names = ["SB", "BB", ...mids, "BTN"];
  }
  const out = new Map<number, string>();
  for (let k = 0; k < Math.min(order.length, names.length); k++) out.set(order[k]!, names[k]!);
  return out;
}

/**
 * THE HAND'S SEAT ROSTER (2026-10-04): every seat of the table and why it was or was not in this hand — dealt, or
 * sitting out / busted / reserved by a new player / waiting / empty (roster.ts says what each socket word means and what
 * is not established) — with the button seat and whether it, or the small blind, was dead. Exported on /hand and
 * archived with the hand, so a dead button is a fact of the record and never again inferred from labels. null before
 * the deal.
 */
export function seatRoster(): Record<string, any> | null {
  const w = ws();
  const dealt: number[] = sortedNums(dealtForPositions());
  const btn: number | null = w.dealer ?? null;
  if (!dealt.length) return null;
  const bo = btn !== null ? buttonOrder(dealt, btn) : null;
  const words = seatWords();
  const heard = [...words].filter(([, x]) => x.type !== undefined || x.tableState).map(([s]) => s);
  const top = Math.max(...dealt, btn ?? 0, ...heard);
  const posts = new Map<number, string>();
  for (const a of w.actions || []) {
    if (a.street !== "preflop" || a.seat === null || a.seat === undefined || posts.has(a.seat)) continue;
    if (a.type === "post-sb") posts.set(a.seat, "sb");
    else if (a.type === "post-bb") posts.set(a.seat, "bb");
    else if (a.type === "post") posts.set(a.seat, "in");
  }
  const seats: Record<string, any> = {};
  for (let s = 1; s <= (top <= 6 ? 6 : top); s++) {
    if (dealt.includes(s)) {
      seats[s] = { status: "dealt", ...(s === w.heroSeat ? { hero: true } : {}), ...(posts.has(s) ? { posted: posts.get(s) } : {}) };
      continue;
    }
    const x = words.get(s);
    seats[s] = { status: undealtStatus(x), ...(x && x.type !== undefined ? { word: `type ${x.type} state ${x.state}` } : {}),
                 ...(x?.reserved ? { reserved: true } : {}) };
  }
  return { dealer: btn, deadButton: !!bo?.deadButton, deadSb: !!bo && deadSmallBlind(bo.order), dealt, seats };
}

/** A DOM stack label in BB — an explicit 'BB' suffix, else currency over the hand's observed blind. */
export function stackBb(text: string | null | undefined): number | null {
  const v = potVal(text);
  if (v === null || v <= 0) return null;
  if (text && text.toUpperCase().includes("BB")) return v;
  const bb = ws().bb || 0;
  return bb && ws().bbSeen ? pyRound(v / (bb / 100), 1) : null;
}

type LineRow = [string, number, string, number | null];

/** The first way a normalised (street, seat, type, amount) line is one no table could have dealt, or null. */
export function lineOrderFault(line: LineRow[], rc: { dealt: Iterable<number>; sb: number | null; bbs: number | null }): string | null {
  let order: number[] | null = null;
  try {
    const ring = sortedNums(new Set([...rc.dealt, ...[rc.sb, rc.bbs].filter((x): x is number => x !== null && x !== undefined)]));
    if (rc.sb !== null && rc.sb !== undefined && ring.includes(rc.sb) && ring.length >= 3) {
      const i = ring.indexOf(rc.sb);
      order = [...ring.slice(i), ...ring.slice(0, i)];
    } else if (ring.length === 2 && rc.bbs !== null && rc.bbs !== undefined && ring.includes(rc.bbs)) {
      // heads-up the BIG BLIND opens every postflop street (the dealer posts the small blind). Unjudged until
      // 2026-09-24, which let a derived line with the SB checking first replace a correct event line (hand 4920374906)
      const i = ring.indexOf(rc.bbs);
      order = [...ring.slice(i), ...ring.slice(0, i)];
    }
  } catch {
    order = null;
  }
  const folded = new Set<number>();
  const allin = new Set<number>();
  let prevStreet: string | null = null, prevSeat: number | null = null, prevType: unknown = null;
  for (const [st, seat, typ] of line) {
    const post = typeof typ === "string" && typ.startsWith("post");
    if (st !== prevStreet) {
      if (st !== "preflop" && order !== null) {
        const live = order.filter((s) => !folded.has(s) && !allin.has(s));
        if (live.length >= 2 && seat !== live[0]) return `${pyStr(st)} opens with seat ${pyStr(seat)}, seat ${live[0]} is first to act`;
      }
      prevStreet = st; prevSeat = null; prevType = null;
    } else if (seat === prevSeat && !post && !(typeof prevType === "string" && prevType.startsWith("post"))) {
      return `seat ${pyStr(seat)} acts twice running on the ${pyStr(st)}`;
    }
    prevSeat = seat; prevType = typ;
    if (typ === "fold") folded.add(seat);
    else if (typ === "all-in") allin.add(seat);
  }
  return null;
}

const rowKey = (x: LineRow) => JSON.stringify(x);

/** Every chip a /hand line has put in, in BB: each seat's last level on each street, summed — a bet / raise / all-in
 *  carries the level it went to, a call the chips it added, a blind its post. null = a money row without an amount
 *  (the blind not seen yet): the line cannot be summed. */
export function lineChips(line: any[]): number | null {
  let done = 0, street: string | null = null;
  let level = new Map<number, number>();
  for (const a of line) {
    if (a.street !== street) {
      for (const v of level.values()) done += v;
      level = new Map();
      street = a.street;
    }
    const t = String(a.type);
    if (t === "fold" || t === "check") continue;
    const amt = a.amount;
    if (typeof amt !== "number" || !Number.isFinite(amt)) return null;
    if (t === "call" || t.startsWith("post")) level.set(a.seatId, (level.get(a.seatId) ?? 0) + amt);
    else level.set(a.seatId, amt);
  }
  for (const v of level.values()) done += v;
  return pyRound(done, 2);
}

export const POT_FAULT = "pot disagrees with the ledger";

/**
 * A POT FAULT THE EVENT LINE ANSWERS (2026-09-26, NL5 session_20260926_030543; Brady: "preflop the auto execute
 * worked, postflop it failed", hand 4920637334 K9 on 7-9-7). The level reconciler reads the chips IN FRONT of each
 * seat once a feed tick; with four tables a tick is 1-3 s, and a call that closes a street is swept into the pot
 * between two ticks (frame 388: BB 1 in front, pot 4 → frame 389: flop, pot 5.4, BB's stack 1.6 lower) — the
 * reconciler never sees it, its ledger stays short by that call, and "pot disagrees with the ledger" fires on every
 * later street. That fault was sent to the poller as `lineUncertain` and HELD auto-execute on every postflop decision
 * of the hand, although the line /hand actually carried — the event log's, which had "5 call 1.6" — was right.
 * All six pot faults of that session were this: the event line summed to the table's pot (less rake) every time.
 *
 * The check is the reconciler's own (reconcile.ts: pot within [ledger × 0.94 after the flop, ledger] ± TOL), asked of
 * the line being answered instead of the reconciler's ledger. True = that line accounts for the table's pot, so the
 * fault is the reconciler's miss, not the line's. A line with a phantom or lost action still fails it and still holds.
 */
export function potFaultAnswered(line: any[], pot: number | null | undefined, street: string): boolean {
  if (typeof pot !== "number" || !(pot > 0)) return false;
  const total = lineChips(line);
  if (total === null) return false;
  const low = total * (street === "preflop" ? 1.0 : 0.94) - TOL;
  return pot <= total + TOL && pot >= low;
}
const amtStr = (a: number | null) => (a === null ? "" : ` ${pyFloatStr(a)}`);

/** CUT-OVER: which betting line /hand carries — the event log's, or the level reconciler's when the two differ
 *  and the reconciler's derivation is clean, well formed, in turn order and keeps hero's reported actions.
 *  Returns [actions, ledger | null, uncertain | null, note | null, source]. */
export function reconciledLine(old: any[], hero: number | null, street: string): [any[], any, string | null, string | null, string] {
  const rc = S.shadow.hand === S.handNo ? S.shadow.rc : null;
  if (rc === null || rc === undefined || !rc.armed || rc.bbs === null || hero === null) return [old, null, null, null, "ws"];
  // A POST-IN IS INVISIBLE TO THE LEVELS (2026-09-25, hand 4920414607): chips in front of a seat that has not acted
  // read as a call ("added: 3 call 0.4", out of turn). The event log has the post itself — keep it.
  if (old.some((a) => a.type === "post")) {
    return [old, null, null, "a player posted in — the level reconciler cannot tell a post from a call; event line kept", "ws"];
  }
  let journal: any[], viol: any[], rcC: Map<number, number>, rcMax: number;
  try {
    journal = [...rc.line()];
    viol = [...rc.faults(street)];
    if (viol.some((v) => v.what === POT_FAULT) && potFaultAnswered(old, rc.lastPot, street)) {
      viol = viol.filter((v) => v.what !== POT_FAULT);
    }
    rcC = new Map(rc.C);
    rcMax = rc.maxBet;
  } catch {
    return [old, null, null, null, "ws"];
  }
  const derived: any[] = [];
  for (const a of journal) {
    const rec: any = { seatId: a.seat, hero: a.seat === hero, type: a.type, street: a.street };
    if (a.amount !== null && a.amount !== undefined) rec.amount = a.amount;
    derived.push(rec);
  }
  const uncertain = viol.length ? `line uncertain — ${viol[viol.length - 1].what}` : null;
  const dirty = [...rc.violations];
  const norm = (acts: any[]): LineRow[] => acts.map((x) => [x.street, x.seatId, x.type,
    x.amount !== null && x.amount !== undefined ? pyRound(Number(x.amount), 1) : null]);
  const o = norm(old), r = norm(derived);
  const same = (a: LineRow[], b: LineRow[]) => a.length === b.length && a.every((x, i) => rowKey(x) === rowKey(b[i]!));
  if (same(o, r)) return [old, null, uncertain, null, "ws"];
  if (r.length < o.length && same(o.slice(0, r.length), r)) return [old, null, uncertain, null, "ws"];
  if (uncertain || dirty.length) {
    const why = uncertain || `the derived line broke an invariant this hand (${dirty[dirty.length - 1].what}) — event line kept`;
    return [old, null, uncertain, uncertain ? null : why, "ws"];
  }
  const heroOld = o.filter((x) => x[1] === hero).map((x) => [x[0], x[2], x[3]] as [string, string, number | null]);
  const unmatched = r.filter((x) => x[1] === hero).map((x) => [x[0], x[2], x[3]] as [string, string, number | null]);
  const lost: string[] = [];
  for (const [st, typ, a] of heroOld) {
    const hit = unmatched.findIndex(([s2, t2, a2]) => s2 === st && t2 === typ && (a === null || a2 === null || Math.abs(a2 - a) <= 0.15));
    if (hit < 0) lost.push(`${st} ${typ}${amtStr(a)}`);
    else unmatched.splice(hit, 1);
  }
  if (lost.length) return [old, null, null, `the derived line lacks hero's own reported action (${lost.slice(0, 3).join(", ")}) — event line kept`, "ws"];
  const disorder = lineOrderFault(r, rc);
  if (disorder) return [old, null, null, `the derived line is out of turn order (${disorder}) — event line kept`, "ws"];
  const dealtNow = new Set<number>(ws().dealt || []);
  const types = r.map((x) => x[2]);
  const wellFormed = types.length >= 2 && types[0] === "post-sb" && types[1] === "post-bb"
    && (!dealtNow.size || r.every((x) => dealtNow.has(x[1])));
  if (!wellFormed) return [old, null, null, "the level reconciler could not read this hand (its line opens outside the blinds) — event line kept", "ws"];
  const oSet = new Set(o.map(rowKey)), rSet = new Set(r.map(rowKey));
  const gone = o.filter((x) => !rSet.has(rowKey(x))).map(([, s, t, a]) => `${pyStr(s)} ${t}${amtStr(a)}`);
  const added = r.filter((x) => !oSet.has(rowKey(x))).map(([, s, t, a]) => `${pyStr(s)} ${t}${amtStr(a)}`);
  const note = "line from the chips on screen" + (gone.length ? `; dropped: ${gone.slice(0, 3).join(", ")}` : "")
    + (added.length ? `; added: ${added.slice(0, 3).join(", ")}` : "");
  const committed = new Map<number, number>();
  for (const [s, v] of rcC) committed.set(Math.trunc(s), pyRound(v, 2));
  const ledger = { committed, maxBet: pyRound(rcMax, 2) };
  return [derived, ledger, null, note, "reconciled"];
}

/** A test's stand-in for the whole export (Python's tests replaced launch._hand_state). */
export const handSeams: { override: null | (() => Record<string, any> | null) } = { override: null };

/** The current hand as a ParsedHand, from whichever site this session plays. */
export function handState(): Record<string, any> | null {
  if (handSeams.override) return handSeams.override();
  if (isCp()) {
    const h = CP.hand();
    if (h !== null) h.panelPort = C.PANEL_PORT;
    return h;
  }
  if (isCgg()) {
    const h = CGG.hand();
    if (h !== null) h.panelPort = C.PANEL_PORT;
    return h;
  }
  return handStateIgnition();
}

const short = (c: string) => c.replaceAll("10", "T");

/** The EVENT log's line for the current hand (WS frames + DOM edges) as /hand rows — the line BEFORE the cut-over
 *  (reconciledLine) may swap in the level reconciler's. The shadow audit diffs the reconciler against this. */
export function eventLine(): any[] {
  const w = ws();
  const hero = w.heroSeat ?? null;
  const bb = w.bb || 0;
  const scaled = bb && w.bbSeen;
  return [...(w.actions || [])].map((a: any) => {
    const rec: any = { seatId: a.seat, hero: a.seat === hero, type: a.type, street: a.street };
    if (scaled && a.cents !== null && a.cents !== undefined) rec.amount = pyRound(a.cents / bb, 2);
    return rec;
  });
}

/** THE HAND FROM THE PROTOCOL (wsLine.ts): this hand's frames, reduced. null = no frames to build it from — the fake
 *  table (it has no socket) or a hand the tap has not bound yet — and /hand keeps the old event-log line. */
export function protocolHand(): WsHand | null {
  const w = ws();
  if (S.fakeMode || !(w.frames && w.frames.length)) return null;
  const bb = w.bb || 0;
  return wsHand(w.frames, bb && w.bbSeen ? bb : null);
}

/**
 * WHICH LINE WAS SERVED (2026-10-14, hand 4924546540, session_20261014_131738 table 1): for at least 50 s mid-hand the
 * /state line carried a FOLD by seat 4, the button, all-in for his whole 2.2bb (his CO_SELECT_INFO: btn 4096 "raise",
 * bet 5, raise 11, account 0). The server skipped him (CO_CURRENT_PLAYER 6 → 5), the API built a GTO Wizard node from
 * the fold, and the hand got no answer. The archive written 20 s later (lineSource "ws", the protocol's line) and the
 * shadow report's reconciled line had no such fold, and nothing recorded which line /state served at that moment or
 * why. These lines make the next one attributable:
 *   1. the protocol line unavailable while a hand is on — which line was served instead (and when it comes back);
 *   2. a fold read for a seat with nothing behind, outside the protocol reducer (the level reconciler, the DOM backfill);
 *   3. an all-in the protocol's frame typed as a raise / bet / call (wsLine.ts nothingBehind — the typing unchanged).
 * LOGS AND DUMP MARKERS ONLY: /state and /hand carry nothing new (the reader goldens compare them byte for byte). Each
 * line is logged once per hand (once per seat per hand for 2 and 3). `lineDiagSeams.log` is the tests' seam.
 */
export const lineDiagSeams = { log: (m: string) => log(m) };

function lineDiag(): typeof S.lineDiag {
  const m = S.lineDiag;
  if (m.hand !== S.handNo) Object.assign(m, { hand: S.handNo, fallback: false, back: false, said: new Set<string>() });
  return m;
}

const handTag = () => {
  const id = S.handIds.get(S.handNo);
  return `hand ${S.handNo}${id ? ` (${id})` : ""}`;
};

const rowText = (a: any) => `${String(a.street ?? "?")[0]} ${pyStr(a.seatId)} ${a.type}${a.amount !== undefined && a.amount !== null ? " " + pyStr(a.amount) : ""}`;

/** 1 — the protocol line unavailable while a hand is on (handStateIgnition: a hand with dealt seats and hero): log and
 *  mark the ws_dump once, with the line served instead; once more when the protocol line is back. */
export function noteLineServed(proto: WsHand | null, lineSource: string, served: any[], note: string | null): void {
  if (S.fakeMode) return;
  const w = ws(), m = lineDiag();
  const frames = (w.frames || []).length;
  if (!proto) {
    if (m.fallback) return;
    m.fallback = true;
    const which = lineSource === "reconciled" ? "reconciled" : "event";
    lineDiagSeams.log(`[line] ${handTag()}: protocol line unavailable — frames ${frames}, tapBound ${S.tapBound ?? null}, serving the ${which} line`
      + ` (${served.length} rows: ${served.slice(-6).map(rowText).join(", ") || "none"})`);
    dumpEvent("<line-fallback>", { frames, tapBound: S.tapBound ?? null, served: which, line: served.map(rowText), note });
  } else if (m.fallback && !m.back) {
    m.back = true;
    lineDiagSeams.log(`[line] ${handTag()}: protocol line available again — frames ${frames}`);
    dumpEvent("<line-back>", { frames, tapBound: S.tapBound ?? null });
  }
}

/** 2 — a fold read for a seat other than hero OUTSIDE the protocol reducer (`via`: the level reconciler's derivation,
 *  the DOM backfill) while the wrapper's latest reading says the seat has nothing behind: its socket account
 *  (S.ws.wsAccount, from its own last frame) or its screen stack (`screenBehindBb`, null = unread) is 0, or its last
 *  action this hand in the event log was an all-in. Once per seat per hand. */
export function noteFoldNothingBehind(seat: number, via: string, screenBehindBb: number | null | undefined): void {
  try {
    foldNothingBehind(seat, via, screenBehindBb);
  } catch {}
}

function foldNothingBehind(seat: number, via: string, screenBehindBb: number | null | undefined): void {
  if (S.fakeMode || !S.handNo) return;
  const w = ws();
  if (seat === (w.heroSeat ?? null)) return;
  const acct = (w.wsAccount as Map<number, number> | undefined)?.get(seat);
  let last: any = null;
  const acts: any[] = w.actions || [];
  for (let i = acts.length - 1; i >= 0; i--) if (acts[i].seat === seat && acts[i].type !== "fold") { last = acts[i]; break; }
  const zeroWs = acct === 0, zeroScreen = typeof screenBehindBb === "number" && screenBehindBb <= TOL;
  const jammed = last?.type === "all-in";
  if (!zeroWs && !zeroScreen && !jammed) return;
  const m = lineDiag(), key = `fold ${seat}`;
  if (m.said.has(key)) return;
  m.said.add(key);
  const chips = zeroWs || zeroScreen ? "0" : acct !== undefined ? `${acct}c` : "nothing";
  const detail = [`socket account ${acct ?? "unread"}`, `screen ${screenBehindBb ?? "unread"}`,
    last ? `last action ${last.type}${last.cents != null ? ` ${last.cents}c` : ""}` : "no earlier action"];
  lineDiagSeams.log(`[line] ${handTag()} seat ${seat}: fold read via ${via} but the seat has ${chips} behind (${detail.join(", ")})`);
}

/** 3 — the protocol's line filed a money action that left its seat with nothing behind under a verb other than all-in
 *  (or a fold from a seat already at 0): logged once per seat per hand, the typing left as it is. */
export function noteProtoNothingBehind(proto: WsHand): void {
  if (S.fakeMode || !proto.nothingBehind.length) return;
  const m = lineDiag();
  const bb = ws().bb || 0, scaled = bb && ws().bbSeen;
  for (const x of proto.nothingBehind) {
    const key = `proto ${x.seat}`;
    if (m.said.has(key)) continue;
    m.said.add(key);
    const size = scaled ? `${pyRound(x.toCents / bb, 2)}bb` : `${x.toCents}c`;
    lineDiagSeams.log(x.verb === "fold"
      ? `[line] ${handTag()} seat ${x.seat}: the protocol filed a fold (${x.street}) from a seat with 0 behind`
      : `[line] ${handTag()} seat ${x.seat}: ${x.type} to ${size} leaves 0 behind — an all-in the frame typed "${x.verb}" (${x.street})`);
  }
}

/**
 * THE SCREEN AS A CHECKER (2026-09-26): with the line built from the protocol, nothing the screen shows is written
 * into it — a disagreement marks the decision uncertain instead (auto-execute holds, the panel says why). Checked:
 * the protocol's own pot against the chips the line put in (exact, at each pot frame); a frame the reducer could not
 * place; a board card the screen shows that no frame dealt; the screen's pot against the line (screenCheck, kept by
 * the shadow tick over several ticks so a frame drawn a tick late is not a disagreement).
 */
export function protocolUncertain(p: WsHand, screenBoard: string | null): string | null {
  if (p.faults.length) return `line uncertain — ${p.faults[p.faults.length - 1]}`;
  if (potAgrees(p) === false) {
    return `line uncertain — the table's pot (${p.potCheck!.potCents}c) disagrees with the chips the line put in (${p.potCheck!.lineCents}c)`;
  }
  if (screenBoard) return `line uncertain — ${screenBoard}`;
  const sc = S.screenCheck;
  if (sc && sc.hand === S.handNo && sc.why) return `line uncertain — ${sc.why}`;
  return null;
}

export function handStateIgnition(): Record<string, any> | null {
  const w = ws();
  const dealt: number[] = [...(w.dealt || [])];
  const hero = w.heroSeat ?? null;
  if (!S.handNo || !dealt.length || hero === null) return null;
  if (w.heroDealt === false) return null;
  const positions = positionsAll();
  if (!positions.size) return null;
  const roster = seatRoster();
  const actsSrc: any[] = [...(w.actions || [])];
  const committedSrc: Map<number | null, number> = new Map(w.committed || []);
  const seatsSrc: Map<any, any> = new Map(S.feedPrev.seats || []);
  const bb = w.bb || 0;
  const scaled = bb && w.bbSeen;
  const toBb = (cents: number | null | undefined) => (scaled && cents !== null && cents !== undefined ? pyRound(cents / bb, 2) : null);
  const proto = protocolHand();
  let board = (proto ? proto.board : (w.board || []).filter((c: any) => c)).map(short);
  const pastGrace = time() >= (w.domGraceUntil ?? 0);
  const hasVoluntary = voluntaryActed();
  let screenBoard: string | null = null;
  if (pastGrace) {
    // the screen's board fills a board frame the tap lost — never with the rabbit hunt's card (ws.ts withoutRabbit), and
    // never when it is not this hand's: another table's, or an earlier hand's a stuck frame still shows (domBoardRefused).
    // With the protocol's line the screen only CHECKS: a card it shows that no frame dealt holds the decision.
    const domRaw: string[] = withoutRabbit((S.liveStatus.board || []).filter((c: any) => c));
    if (hasVoluntary && [3, 4, 5].includes(domRaw.length) && domRaw.length > board.length && !domBoardRefused(domRaw)) {
      if (proto) screenBoard = `the screen shows ${domRaw.length} board cards, the protocol has dealt ${board.length}`;
      else board = domRaw.map(short);
    }
  }
  const street = board.length >= 5 ? "river" : board.length === 4 ? "turn" : board.length === 3 ? "flop" : "preflop";
  let actions: any[] = proto ? proto.actions : eventLine();
  let committed: Map<any, number> = new Map();
  for (const [s, c] of committedSrc) {
    const v = toBb(c);
    if (v !== null) committed.set(s, v);
  }
  const stacks = new Map<any, number>();
  for (const [num, s] of seatsSrc) {
    const v = stackBb((s || {}).stack ?? null);
    if (v !== null) stacks.set(num, v);
  }
  // each dealt seat's stack AS DEALT: off the table's own account on its first frame this hand (ws.ts noteAccount,
  // source "frame"), and until that frame the figure carried from the table's last word on the seat — the previous
  // hand's result, a buy, a seat word (ws.ts dealtCents, 2026-10-14) — so every dealt seat is covered from the deal.
  // `stacks` above stay the screen's readings; the API prefers these for every seat they cover, and
  // `startStacksSource` says per seat whether the figure is the seat's own frame or carried
  const startStacks = new Map<number, number>();
  const startStacksSource = new Map<number, string>();
  for (const [s, { cents, source }] of dealtCents()) {
    const v = toBb(cents);
    if (v === null || !dealt.includes(s)) continue;
    startStacks.set(s, v);
    startStacksSource.set(s, source);
  }
  // EVERY DEALT SEAT'S CHIPS AS THE WEBSOCKET REPORTS THEM (round 3, ws.ts wsChips): chips behind now, chips in front
  // this street, dead blinds — to 4 decimals of a BB, exact at every Ignition stake. Only once the WS has reported
  // this hand (a blind frame at least): a DOM-only reading has no table money to offer, and zeros would be a claim.
  // A seat the DOM filed money for ahead of any frame is left out (`wsStale`). Never in fake-table mode (no frames).
  const wsStack = new Map<number, number>(), wsInFront = new Map<number, number>(), wsDead = new Map<number, number>();
  const acct: Map<number, number> | undefined = w.wsAccount;
  if (!S.fakeMode && scaled && acct && acct.size) {
    // stale = the DOM backfill filed a seat's money ahead of its frame; the protocol line has no such seat
    const stale: Set<number> = proto ? new Set<number>() : w.wsStale ?? new Set<number>();
    const bb4 = (c: number) => pyRound(c / bb, 4);
    for (const s of sortedNums(dealt)) {
      if (stale.has(s)) continue;
      if (acct.has(s)) wsStack.set(s, bb4(acct.get(s)!));
      wsInFront.set(s, bb4((w.wsFront as Map<number, number> | undefined)?.get(s) ?? 0));
      const dead = (w.wsDead as Map<number, number> | undefined)?.get(s) ?? 0;
      if (dead > 0) wsDead.set(s, bb4(dead));
    }
  }
  let heroCards: string[] = w.heroCards || [];
  if (!heroCards.length && S.feedPrev.heroCards) heroCards = splitWs(String(S.feedPrev.heroCards));
  heroCards = heroCards.map(short);
  let actionOn = w.actionOn ?? null;
  const heroOwed = (w.maxBet ?? 0) - (committedSrc.get(hero) || 0);
  const heroFolded = proto ? proto.folded.has(hero) : !!w.heroFolded;
  const actionOnRaw = actionOn;
  const src = toActSources(!!S.liveStatus.toAct);
  const since = S.liveStatus.toActSince || 0.0;
  const buttonsHeld = !!src.buttons && pastGrace && !!since && time() - since >= 1.0;
  // THE SCREEN'S STRIP DECIDES HERO'S TURN ONLY WHEN THE SOCKET CANNOT (2026-10-14, the answer-path audit's independent
  // review of hand 4921603348): hero SB 8♥8♠ was answered twice (answers 8166 / 8167, "Raise 2.5" on a line padded
  // F-F-F-F) 18.7 s and 15.7 s BEFORE the socket asked him (CO_SELECT_REQ 10:50:51.5; the HJ's raise 10:50:40.1), off
  // toActSources {buttons: true, ws: false, actionOn: false}: the socket said action on seat 1 then 2, and the strip
  // counted as his turn through the held-buttons rule 0.14 s past the deal grace — Ignition's PRE-ACTION buttons
  // ("CALL 3", CO_SELECT_SPEED_BTN) carry a digit and satisfy dom.ts toAct. Nine such answers in six hands since 09-20,
  // all preflop. While the bound socket is alive (socketWord, a frame within SOCKET_ALIVE_S) the ask will come on it
  // — it never comes out of silence — so the turn is the socket's: its own ask (ws), or action-on hero with the
  // buttons up. The strip's two rules (buttons past the grace with a voluntary action in; buttons held 1 s) stay
  // for the socket that is silent (a stall, a lost tap) or absent (the fake table, no rid). This only makes the turn
  // EARLIER, never later: Ignition draws the buttons 3-4 s after the socket's ask (session_20261013_223500).
  const stripDecides = src.socket !== "alive";
  if (actionOn !== hero && !heroFolded && (src.ws || (stripDecides && ((src.buttons && pastGrace && hasVoluntary) || buttonsHeld)))) actionOn = hero;
  const actionOnOnly = actionOn === hero && !src.ws && !src.buttons;
  const toActHero = actionOn === hero && !actionOnOnly;
  // THE CLIENT'S OWN PRICE (2026-10-14, the same review): CO_SELECT_REQ.bet is the amount hero is asked to CALL when
  // the ask offers FOLD (btns bit 1024; equal to hero's own later call in 754 of 754 dumps' asks), and the MIN BET when
  // it offers CHECK (bit 64; hero owes 0). Exported as `askedToCall` (bb, 4 dp) for the API's capture gate to hold
  // against the line's toCall — a line padded with folds the socket never saw cannot agree with it. `askedSizes`
  // carries the ask's pot-size presets (bb) for the record. Only this hand's ask, only once the blinds scaled it.
  const turn = w.heroTurn && w.heroTurn.hand === S.handNo && !heroFolded ? w.heroTurn : null;
  const askBits = turn ? Number(turn.btns) || 0 : 0;
  const bb4 = (c: unknown) => (scaled && typeof c === "number" && Number.isFinite(c) ? pyRound(c / bb, 4) : null);
  const askedToCall = turn && typeof turn.bet === "number" ? (askBits & 64 ? 0 : askBits & 1024 ? bb4(turn.bet) : null) : null;
  const askedSizes = turn && (turn.betPot != null || turn.halfPot != null)
    ? { ...(bb4(turn.betPot) !== null ? { betPot: bb4(turn.betPot) } : {}), ...(bb4(turn.halfPot) !== null ? { halfPot: bb4(turn.halfPot) } : {}) }
    : null;
  const foldedSeats = proto ? proto.folded : new Set(actsSrc.filter((a) => a.type === "fold").map((a) => a.seat));
  const villains = dealt.filter((s) => s !== hero);
  const heroWon = !heroFolded && villains.length > 0 && villains.every((s) => foldedSeats.has(s));
  const [lineActions, rcLedger, lineUncertain, lineNote, lineSource] = proto
    ? [actions, null, protocolUncertain(proto, screenBoard), null, "ws"] as [any[], any, string | null, string | null, string]
    : reconciledLine(actions, hero, street);
  actions = lineActions;
  // WHICH LINE WAS SERVED (2026-10-14, hand 4924546540): logs only, nothing below changes (noteLineServed)
  try {
    noteLineServed(proto, lineSource, actions, lineNote);
    if (proto) noteProtoNothingBehind(proto);
  } catch {}
  let heroOwedBb: number | null = null;
  if (rcLedger !== null) {
    committed = rcLedger.committed;
    heroOwedBb = Math.max(0.0, rcLedger.maxBet - (committed.get(hero) || 0.0));
  }
  const status = S.liveStatus.hero ?? null;
  const notToActWhy = toActHero && !heroFolded && !heroWon ? null
    : heroFolded ? "hero folded" : heroWon ? "hand won"
    : status === "sitting-out" || status === "waiting-for-bb" ? `status ${status}`
    : src.buttonsStaleS !== undefined ? `the screen's buttons are a stale read (${src.buttonsStaleS} s old, the reader stood down) — not trusted`
    : src.buttons && !stripDecides ? `the screen shows turn buttons but the table's connection is alive and has not asked you to act (its ask decides; ${actionOnRaw !== null ? `action on seat ${pyStr(actionOnRaw)}` : "action-on unknown"})`
    : actionOnOnly ? "action-on names you but the client has not asked and shows no buttons"
    : actionOnRaw !== null ? `action on seat ${pyStr(actionOnRaw)}`
    : "action-on unknown";
  const toCall = heroOwedBb !== null ? pyRound(heroOwedBb, 2) : toBb(Math.max(0, heroOwed));
  return {
    handId: S.handNo,
    tableSlot: TABLES.slot(),
    panelPort: C.PANEL_PORT,
    clientHandId: S.handIds.get(S.handNo) ?? null,
    bbCents: scaled ? bb : null,
    heroSeatId: hero,
    heroCards,
    board,
    street,
    actions,
    liveSeats: sortedNums(dealt),
    committed,
    potByStreet: {},
    positions,
    // every seat of the table and why it was or was not dealt, the button seat, a dead button / small blind (seatRoster)
    ...(roster ? { roster } : {}),
    stacks: stacks.size ? stacks : null,
    ...(startStacks.size ? { startStacks, startStacksSource } : {}),
    ...(wsStack.size ? { wsStack } : {}),
    ...(wsInFront.size ? { wsInFront } : {}),
    ...(wsDead.size ? { wsDead } : {}),
    currentNode: {
      street,
      toActSeatId: actionOn,
      toActIsHero: toActHero,
      pot: toBb(w.potCents ?? null) || 0,
      // the rake already taken from that pot (bb); pot − potRake is what the winner is paid from it
      ...(w.rakeCents != null ? { potRake: toBb(w.rakeCents) ?? 0 } : {}),
      toCall: toCall || 0,
      legalActions: [],
      complete: false,
    },
    heroFolded,
    heroWon,
    ended: heroFolded || heroWon,
    // the client's own ask (CO_SELECT_REQ): what hero is asked to call (0 when it offers CHECK), its pot presets
    ...(askedToCall !== null ? { askedToCall } : {}),
    ...(askedSizes && Object.keys(askedSizes).length ? { askedSizes } : {}),
    // the socket joined this hand after it began (ws.ts CO_TABLE_INFO): its earlier actions were never seen
    ...(w.joinedMidHand ? { joinedMidHand: true } : {}),
    buttonsUp: !!src.buttons,
    toActSources: src,
    heroStatus: status,
    notToActWhy,
    lineSource,
    lineUncertain,
    lineNote,
    // Ignition's own rake (CO_CHIPTABLE_INFO curRake), bb: taken so far, and as each street was entered ("end" = the
    // last sweep, all five cards out) — the archive keeps it, so a won pot is priced after rake exactly
    ...(w.rakeCents != null ? { rake: { bb: toBb(w.rakeCents) ?? 0, byStreet: Object.fromEntries(Object.entries(w.rakeByStreet || {}).map(([k, c]) => [k, toBb(c as number) ?? 0])) } } : {}),
  };
}

