/**
 * THE STRUCTURED HAND EXPORT (GET /hand, CONTRACT.md §1a) — launch.py's _hand_state and what it leans on:
 * positions from the button and who was dealt in, the three independent views of hero's turn, and the cut-over
 * between the event log's betting line and the level reconciler's.
 *
 * Positions use gto-trainer's vocabulary (UTG/HJ/CO), assigned from the button backwards so a short table maps
 * onto the late seats of the 6-max tree.
 */
import { time } from "../clock";
import { pyFloatStr, pyRound, pyStr, sortedNums, splitWs } from "../py";
import { CGG, CP, S, isCgg, isCp } from "../state";
import { C } from "../config";
import * as TABLES from "../tables";
import { TOL } from "../reconcile";
import { potVal } from "./dom";
import { domBoardRefused, voluntaryActed, withoutRabbit } from "./ws";
import { potAgrees, wsHand, type WsHand } from "./wsLine";

const ws = () => S.ws;

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

/** The three independent views of "hero to act", side by side. */
export function toActSources(buttonsUp: boolean): Record<string, any> {
  const hero = ws().heroSeat ?? null;
  const turn = ws().heroTurn ?? null;
  const age = screenReadAgeS();
  const stale = age !== null && age > BUTTONS_STALE_S;
  return {
    buttons: !!buttonsUp && !stale,
    ws: !!(turn && turn.hand === S.handNo && !ws().heroFolded),
    actionOn: hero !== null && (ws().actionOn ?? null) === hero,
    wsAt: (turn || {}).at ?? null, timeBank: (turn || {}).timeBank ?? null,
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

/** Hero's position name (the panel's vocabulary: UTG+1 / MP). */
export function heroPosition(): string | null {
  let seats: number[] = ws().dealt || [];
  const btn = ws().dealer ?? null, hero = ws().heroSeat ?? null;
  if (!seats.length || btn === null || hero === null || !seats.includes(hero)) return null;
  if (!seats.includes(btn)) seats = sortedNums(new Set([...seats, btn]));
  const i = seats.indexOf(btn);
  let order = [...seats.slice(i + 1), ...seats.slice(0, i + 1)];
  const n = order.length;
  let names: string[];
  if (n === 2) {
    names = ["SB", "BB"];
    order = [btn, order.filter((s) => s !== btn)[0]!];
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
  const dealt: number[] = ws().dealt || [];
  const btn = ws().dealer ?? null;
  if (!dealt.length || btn === null) return new Map();
  const seats = sortedNums(new Set([...dealt, btn]));
  const i = seats.indexOf(btn);
  const order = [...seats.slice(i + 1), ...seats.slice(0, i + 1)];
  const n = order.length;
  if (n === 2) {
    const other = order.find((s) => s !== btn)!;
    return new Map([[btn, "SB"], [other, "BB"]]);
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
  // each dealt seat's stack AS DEALT, off the table's own account on its first frame this hand (ws.ts noteAccount) —
  // `stacks` above stay the screen's readings; the API prefers these for every seat they cover
  const startStacks = new Map<number, number>();
  for (const [s, c] of (w.startCents as Map<number, number> | undefined) ?? []) {
    const v = toBb(c);
    if (v !== null && dealt.includes(s)) startStacks.set(s, v);
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
  if (actionOn !== hero && !heroFolded && (src.ws || (src.buttons && pastGrace && hasVoluntary) || buttonsHeld)) actionOn = hero;
  const actionOnOnly = actionOn === hero && !src.ws && !src.buttons;
  const toActHero = actionOn === hero && !actionOnOnly;
  const foldedSeats = proto ? proto.folded : new Set(actsSrc.filter((a) => a.type === "fold").map((a) => a.seat));
  const villains = dealt.filter((s) => s !== hero);
  const heroWon = !heroFolded && villains.length > 0 && villains.every((s) => foldedSeats.has(s));
  const [lineActions, rcLedger, lineUncertain, lineNote, lineSource] = proto
    ? [actions, null, protocolUncertain(proto, screenBoard), null, "ws"] as [any[], any, string | null, string | null, string]
    : reconciledLine(actions, hero, street);
  actions = lineActions;
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
    stacks: stacks.size ? stacks : null,
    ...(startStacks.size ? { startStacks } : {}),
    ...(wsStack.size ? { wsStack } : {}),
    ...(wsInFront.size ? { wsInFront } : {}),
    ...(wsDead.size ? { wsDead } : {}),
    currentNode: {
      street,
      toActSeatId: actionOn,
      toActIsHero: toActHero,
      pot: toBb(w.potCents ?? null) || 0,
      toCall: toCall || 0,
      legalActions: [],
      complete: false,
    },
    heroFolded,
    heroWon,
    ended: heroFolded || heroWon,
    buttonsUp: !!src.buttons,
    toActSources: src,
    heroStatus: status,
    notToActWhy,
    lineSource,
    lineUncertain,
    lineNote,
  };
}

