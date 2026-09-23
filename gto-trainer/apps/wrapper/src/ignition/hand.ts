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
import { CP, S, isCp } from "../state";
import { C } from "../config";
import * as TABLES from "../tables";
import { potVal } from "./dom";

const ws = () => S.ws;

/** The three independent views of "hero to act", side by side. */
export function toActSources(buttonsUp: boolean): Record<string, any> {
  const hero = ws().heroSeat ?? null;
  const turn = ws().heroTurn ?? null;
  return {
    buttons: !!buttonsUp,
    ws: !!(turn && turn.hand === S.handNo && !ws().heroFolded),
    actionOn: hero !== null && (ws().actionOn ?? null) === hero,
    wsAt: (turn || {}).at ?? null, timeBank: (turn || {}).timeBank ?? null,
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
const amtStr = (a: number | null) => (a === null ? "" : ` ${pyFloatStr(a)}`);

/** CUT-OVER: which betting line /hand carries — the event log's, or the level reconciler's when the two differ
 *  and the reconciler's derivation is clean, well formed, in turn order and keeps hero's reported actions.
 *  Returns [actions, ledger | null, uncertain | null, note | null, source]. */
export function reconciledLine(old: any[], hero: number | null, street: string): [any[], any, string | null, string | null, string] {
  const rc = S.shadow.hand === S.handNo ? S.shadow.rc : null;
  if (rc === null || rc === undefined || !rc.armed || rc.bbs === null || hero === null) return [old, null, null, null, "ws"];
  let journal: any[], viol: any[], rcC: Map<number, number>, rcMax: number;
  try {
    journal = [...rc.line()];
    viol = [...rc.faults(street)];
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

/** The current hand as a ParsedHand, from whichever site this session plays. */
export function handState(): Record<string, any> | null {
  if (isCp()) {
    const h = CP.hand();
    if (h !== null) h.panelPort = C.PANEL_PORT;
    return h;
  }
  return handStateIgnition();
}

const short = (c: string) => c.replaceAll("10", "T");

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
  let board = (w.board || []).filter((c: any) => c).map(short);
  const pastGrace = time() >= (w.domGraceUntil ?? 0);
  const hasVoluntary = actsSrc.some((a) => a.type !== "post-sb" && a.type !== "post-bb");
  if (pastGrace) {
    const domBoard = (S.liveStatus.board || []).filter((c: any) => c).map(short);
    if (hasVoluntary && [3, 4, 5].includes(domBoard.length) && domBoard.length > board.length) board = domBoard;
  }
  const street = board.length >= 5 ? "river" : board.length === 4 ? "turn" : board.length === 3 ? "flop" : "preflop";
  let actions: any[] = [];
  for (const a of actsSrc) {
    const rec: any = { seatId: a.seat, hero: a.seat === hero, type: a.type, street: a.street };
    const am = toBb(a.cents);
    if (am !== null) rec.amount = am;
    actions.push(rec);
  }
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
  let heroCards: string[] = w.heroCards || [];
  if (!heroCards.length && S.feedPrev.heroCards) heroCards = splitWs(String(S.feedPrev.heroCards));
  heroCards = heroCards.map(short);
  let actionOn = w.actionOn ?? null;
  const heroOwed = (w.maxBet ?? 0) - (committedSrc.get(hero) || 0);
  const heroFolded = !!w.heroFolded;
  const actionOnRaw = actionOn;
  const src = toActSources(!!S.liveStatus.toAct);
  const since = S.liveStatus.toActSince || 0.0;
  const buttonsHeld = !!src.buttons && pastGrace && !!since && time() - since >= 1.0;
  if (actionOn !== hero && !heroFolded && (src.ws || (src.buttons && pastGrace && hasVoluntary) || buttonsHeld)) actionOn = hero;
  const actionOnOnly = actionOn === hero && !src.ws && !src.buttons;
  const toActHero = actionOn === hero && !actionOnOnly;
  const foldedSeats = new Set(actsSrc.filter((a) => a.type === "fold").map((a) => a.seat));
  const villains = dealt.filter((s) => s !== hero);
  const heroWon = !heroFolded && villains.length > 0 && villains.every((s) => foldedSeats.has(s));
  const [lineActions, rcLedger, lineUncertain, lineNote, lineSource] = reconciledLine(actions, hero, street);
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

