/**
 * Ignition's own hand record (the client's hand-history lookup, fetched live through the wrapper's GET /hh/:id)
 * read into our terms, and checked against what the reader archived for the same hand.
 *
 * Money in the record is dollar strings; amounts follow the same convention as our actions: Raises = the total
 * the bet is raised TO, Calls / All-in = the chips added, Bets = the bet. Seats are the table's own numbers, the
 * same ones the wrapper exports. Villains' hole cards are blank unless shown.
 */
import type { ActionType, ParsedHand, Street } from "../../feed/parsePanelFeed/parsePanelFeed";

export interface IgnAction { seat: number | null; position: string; type: ActionType; amountBb?: number; street: Street; label: string }
export interface IgnSeat { seat: number; position: string; hero: boolean; cards: string[]; startBb: number; endBb: number; netBb: number; totalBetBb: number }
export interface IgnHand {
  bbCents: number;
  table: string;
  startTime: string | null;
  board: string[];
  heroCards: string[];
  seats: IgnSeat[];
  actions: IgnAction[];
  /** entries that are not a betting action (dealer, deals, uncalled returns, results, unrecognised labels) */
  other: { position: string; label: string; data: string[]; street: Street }[];
  previousHandId: string | null;
  nextHandId: string | null;
}
export type DiffKind = "big-blind" | "seats" | "hero-seat" | "hero-cards" | "board" | "board-extra" | "start-stack" | "end-stack"
  | "action-amount" | "action-extra" | "action-missing";
export interface HhDiff { kind: DiffKind; field: string; ours: string; ignition: string; note?: string }

const TYPE: Record<string, ActionType> = {
  "small blind": "post-sb", "big blind": "post-bb", folds: "fold", checks: "check", calls: "call", bets: "bet", raises: "raise", "all-in": "all-in",
};
const STREET: Record<string, Street> = { FLOP: "flop", TURN: "turn", RIVER: "river" };

const cents = (s: unknown): number => {
  const m = String(s ?? "").replace(/,/g, "").match(/(-?)\$?(-?\d+(?:\.\d+)?)/);
  return m ? Math.round(Number(m[2]) * 100) * (m[1] === "-" ? -1 : 1) : NaN;
};
const posName = (p: string) => p.replace(/\[ME\]/i, "").replace(/\s+/g, " ").trim();
const round2 = (x: number) => Math.round(x * 100) / 100;

export function parseIgnitionHh(body: any): IgnHand {
  const blinds = String(body?.blinds ?? "").split("/");
  const bbCents = cents(blinds[1]);
  const bb = (s: unknown) => round2(cents(s) / bbCents);
  const seats: IgnSeat[] = (body?.players ?? []).map((p: any) => {
    const [start, end] = String(p.startEndAmount ?? "").split("/");
    return { seat: Number(p.seat), position: posName(p.position ?? ""), hero: !!p.isMe, cards: (p.cards ?? []).filter(Boolean),
      startBb: bb(start), endBb: bb(end), netBb: bb(p.winLoseAmount), totalBetBb: bb(p.totalBet) };
  });
  const seatOf = new Map(seats.map((s) => [s.position.toLowerCase(), s.seat]));
  const actions: IgnAction[] = [];
  const other: IgnHand["other"] = [];
  let street: Street = "preflop";
  for (const a of body?.action ?? []) {
    const label = String(a.action ?? "");
    const data: string[] = (a.data ?? []).map(String);
    if (STREET[label]) { street = STREET[label]!; continue; }
    const type = TYPE[label.toLowerCase()];
    const position = posName(a.position ?? "");
    if (!type) { other.push({ position, label, data, street }); continue; }
    const amt = data[0] ? bb(data[0]) : undefined;
    actions.push({ seat: seatOf.get(position.toLowerCase()) ?? null, position, type, ...(amt != null && Number.isFinite(amt) ? { amountBb: amt } : {}), street, label });
  }
  return {
    bbCents, table: String(body?.tableName ?? ""), startTime: body?.startTime ?? null,
    board: (body?.communityCards ?? []).filter(Boolean), heroCards: seats.find((s) => s.hero)?.cards ?? [],
    seats, actions, other, previousHandId: body?.previousHandId ?? null, nextHandId: body?.nextHandId ?? null,
  };
}

/** The archive keeps money to 0.1bb; Ignition's is exact to the cent (0.05bb at $2, 0.04bb at $0.25). */
const near = (a: number, b: number) => Math.abs(a - b) <= 0.06;

const fmtAct = (a: { seat: number | null; type: string; amount?: number; street: string } | undefined) =>
  a ? `${a.street} seat ${a.seat ?? "?"} ${a.type}${a.amount != null ? ` ${a.amount}bb` : ""}` : "—";

/** Where our archived hand disagrees with Ignition's record. Empty = the reader got it right. */
export function compareHand(ours: ParsedHand, ign: IgnHand): HhDiff[] {
  const out: HhDiff[] = [];
  const add = (kind: DiffKind, field: string, o: string, g: string, note?: string) =>
    out.push({ kind, field, ours: o, ignition: g, ...(note ? { note } : {}) });
  if (ours.bbCents && ours.bbCents !== ign.bbCents) add("big-blind", "big blind", `${ours.bbCents}¢`, `${ign.bbCents}¢`);
  const ourSeats = [...(ours.liveSeats ?? [])].sort((a, b) => a - b).join(",");
  const ignSeats = ign.seats.map((s) => s.seat).sort((a, b) => a - b).join(",");
  if (ourSeats !== ignSeats) add("seats", "seats dealt", ourSeats || "—", ignSeats);
  const hero = ign.seats.find((s) => s.hero);
  if (hero && ours.heroSeatId !== hero.seat) add("hero-seat", "hero seat", String(ours.heroSeatId), String(hero.seat));
  if (ign.heroCards.length && ours.heroCards.join("") !== ign.heroCards.join("")) {
    add("hero-cards", "hero cards", ours.heroCards.join(" ") || "—", ign.heroCards.join(" "));
  }
  if (ours.board.join(" ") !== ign.board.join(" ")) {
    const extra = ours.board.length > ign.board.length && ign.board.every((c, i) => ours.board[i] === c);
    add(extra ? "board-extra" : "board", "board", ours.board.join(" ") || "—", ign.board.join(" ") || "—",
      extra ? "we archived card(s) the hand never dealt (rabbit hunt / stale board?)" : undefined);
  }
  // rows archived before 2026-09-24 carry no stacks as dealt: nothing to check, not a miss
  if (ours.startStacks) for (const s of ign.seats) {
    const got = ours.startStacks[s.seat];
    if (got == null || !near(got, s.startBb)) add("start-stack", `seat ${s.seat} start stack`, got == null ? "—" : `${got}bb`, `${s.startBb}bb`);
  }
  // the archived stack is the last one read: before the pot is pushed (start − total bet) or after it (end) are both right
  for (const s of ign.seats) {
    const got = ours.stacks?.[s.seat];
    const beforeAward = round2(s.startBb - s.totalBetBb);
    if (got != null && !near(got, s.endBb) && !near(got, beforeAward)) {
      add("end-stack", `seat ${s.seat} end stack`, `${got}bb`, `${s.endBb}bb`, beforeAward !== s.endBb ? `${beforeAward}bb before the pot was pushed` : undefined);
    }
  }
  const oa = ours.actions.map((a) => ({ seat: a.seatId, type: a.type, amount: a.amount, street: a.street }));
  const ia = ign.actions.map((a) => ({ seat: a.seat, type: a.type, amount: a.amountBb, street: a.street }));
  for (const [i, j] of alignActions(oa, ia)) {
    const o = i != null ? oa[i] : undefined, g = j != null ? ia[j] : undefined;
    if (o && g && (o.amount == null || g.amount == null || near(o.amount, g.amount))) continue;
    if (o && g) add("action-amount", `action ${i! + 1} amount`, fmtAct(o), fmtAct(g));
    else if (o) add("action-extra", `action ${i! + 1} only in ours`, fmtAct(o), "—");
    else add("action-missing", `Ignition action ${j! + 1} missing from ours`, "—", fmtAct(g));
  }
  return out;
}

type Key = { seat: number | null; type: string; street: string };
const sameKey = (a: Key, b: Key) => a.seat === b.seat && a.type === b.type && a.street === b.street;

/** Longest-common-subsequence alignment on (seat, type, street): one missed action shows as one row, not a cascade. */
function alignActions(a: Key[], b: Key[]): [number | null, number | null][] {
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    L[i]![j] = sameKey(a[i]!, b[j]!) ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  }
  const pairs: [number | null, number | null][] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && sameKey(a[i]!, b[j]!)) pairs.push([i++, j++]);
    else if (j >= b.length || (i < a.length && L[i + 1]![j]! >= L[i]![j + 1]!)) pairs.push([i++, null]);
    else pairs.push([null, j++]);
  }
  return pairs;
}
