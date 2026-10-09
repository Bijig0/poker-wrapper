/**
 * PER-SEAT SESSION VPIP / PFR, LOGGED AT EVERY HERO DECISION (2026-10-09 — groundwork for the player-type dimension;
 * memory player-type-study: on CoinPoker a villain's VPIP band explains pool calling decisions 4-5x better than stack
 * bands, and "the wrapper does not record per-seat session VPIP at decision time"). NO BEHAVIOUR CHANGE: nothing reads
 * these numbers to answer; the answer row carries them (answers.seat_stats, JSON) so the held-out scoreboard can later
 * key the pool tables by a session-VPIP band. Register: NOT_DEPARTURES.logging["answers.seat_stats"].
 *
 * WHERE THE HANDS COME FROM: the API never sees the wrapper's archive as an event (the wrapper writes poker.sqlite
 * itself), but it sees EVERY hand of every table live — the study poller probes POST /api/ingest about once a second
 * whether or not hero is to act, and /fast-solver resolves the same hand at each decision. Both call `observe`, which
 * keeps the CURRENT hand's last snapshot per table; when a table's hand id changes, the previous hand is counted from its
 * last snapshot. All in memory, O(actions) per call — never a DB scan on the decision path (memory: event-loop freezes).
 * Lost on an API restart (the counts start again; `since` says when the table's tally began).
 *
 * WHAT IS COUNTED, per (session, table slot, seat id), for the seat's CURRENT OCCUPANT, over completed hands only (the
 * hand in progress is never in its own numbers):
 *   hands  hands the seat was dealt whose preflop the snapshots saw to its end (the hand ended, or a later street began)
 *   vpip   of those, hands he put money in voluntarily preflop: a call (not the BB's check-call of a limped pot, not a
 *          post or a post-in) or a raise / bet / all-in
 *   pfr    of those, hands he raised preflop
 *   partial  hands he was dealt whose last snapshot stopped inside the preflop (not counted above)
 * THE OCCUPANT — HONESTLY: Ignition is anonymous (no stable player ids; seat + stack continuity is all the wrapper has).
 * A seat's tally starts again ("new") when the seat was not dealt in the table's previous observed hand (a gap: sat out,
 * left, or a new player) or when its stack as dealt is BELOW what it ended the previous hand with by more than a blind
 * (stacks do not shrink between hands). A stack ABOVE the previous end (a pot won after the last snapshot, a top-up, a
 * rebuy — or a new player who sat down with more) keeps the tally and is marked `grew` in `continuity`; the counter
 * `breaks` says how many times the seat's tally restarted this session. Not counted as a break: a stack within a blind
 * of the previous end (`stack`).
 * Pure apart from the module's one in-memory store (`seatStats`), which a test resets.
 */
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { dealtSeats } from "../utils/dealtSeats/dealtSeats";

const POSTS = new Set(["post-sb", "post-bb", "post", "post-dead", "ante"]);
/** a stack within this of the previous hand's end is the same player (a dead SB + BB post is 1.5bb) */
const CONT_TOL_BB = 1.6;
const MAX_TABLES = 32;

export type SeatContinuity = "new" | "stack" | "grew";
export interface SeatTally {
  hands: number; vpip: number; pfr: number; partial: number;
  /** how the current occupant's tally was carried into the latest counted hand */
  continuity: SeatContinuity;
  /** times this seat's tally restarted this session (occupant changes, as far as stacks can tell) */
  breaks: number;
  /** when this occupant's tally began (ms) */
  since: number;
}
/** One villain seat as the answer row records it. */
export interface SeatStatsRow {
  seatId: number;
  pos: string | null;
  hands: number; vpip: number; pfr: number; partial: number;
  continuity: SeatContinuity;
  breaks: number;
  /** vpip / hands, rounded (null under one counted hand) */
  vpipPct: number | null;
  pfrPct: number | null;
}

interface HandSnap {
  key: string;
  dealt: number[];
  start: Record<number, number>;
  end: Record<number, number>;
  vpip: Set<number>;
  pfr: Set<number>;
  /** the preflop was seen to its end */
  complete: boolean;
  heroSeatId: number;
  positions: Record<number, string>;
}
interface TableState {
  current: HandSnap | null;
  /** the last counted hand's dealt seats and end stacks (the continuity check of the next) */
  prev: { dealt: Set<number>; end: Record<number, number> } | null;
  seats: Map<number, SeatTally>;
  at: number;
}

/** Each seat's voluntary preflop money, from the hand's actions (pure). */
export function preflopVoluntary(hand: Pick<ParsedHand, "actions" | "positions" | "heroSeatId">): { vpip: Set<number>; pfr: Set<number> } {
  const vpip = new Set<number>(), pfr = new Set<number>();
  let high = 1, raised = false;
  for (const a of hand.actions ?? []) {
    if (a.street !== "preflop" || POSTS.has(String(a.type))) continue;
    const seat = a.hero ? hand.heroSeatId : a.seatId;
    const amt = Number(a.amount ?? 0);
    const isRaise = a.type === "raise" || a.type === "bet" || (a.type === "all-in" && amt > high + 1e-9);
    if (isRaise) { vpip.add(seat); pfr.add(seat); raised = true; high = Math.max(high, amt); continue; }
    if (a.type === "call" || a.type === "all-in") {
      // the BB's "call" before any raise is his check of a limped pot — no voluntary money
      if (!raised && String(hand.positions?.[seat] ?? "").toUpperCase() === "BB") continue;
      vpip.add(seat);
    }
  }
  return { vpip, pfr };
}

function snapOf(hand: ParsedHand): HandSnap | null {
  const key = String(hand.clientHandId ?? (hand.handId ? `w${hand.handId}` : ""));
  if (!key) return null;
  const start = { ...(hand.startStacks ?? {}) } as Record<number, number>;
  // the dealt seats (utils/dealtSeats: labelled and dealt — liveSeats alone may drop the folded on some sources)
  const dealt = [...dealtSeats(hand).keys()].filter((x) => Number.isFinite(x));
  const { vpip, pfr } = preflopVoluntary(hand);
  const complete = !!hand.ended || (hand.street != null && hand.street !== "preflop");
  return { key, dealt: [...new Set(dealt)], start, end: { ...(hand.stacks ?? {}) } as Record<number, number>, vpip, pfr, complete,
    heroSeatId: hand.heroSeatId, positions: { ...(hand.positions ?? {}) } };
}

export class SeatStats {
  private tables = new Map<string, TableState>();
  private clock: () => number = () => Date.now();
  setClock(fn: () => number): void { this.clock = fn; }
  reset(): void { this.tables.clear(); }

  private tableKey = (sessionId: string | null | undefined, tableSlot: number | null | undefined) => `${sessionId ?? "-"}|${tableSlot ?? 0}`;

  /** A snapshot of a live hand (the ingest probe, a fast-solve). Cheap; never throws. */
  observe(sessionId: string | null | undefined, hand: ParsedHand | null | undefined): void {
    try {
      if (!hand) return;
      const snap = snapOf(hand);
      if (!snap) return;
      const tk = this.tableKey(sessionId ?? hand.sessionId, hand.tableSlot);
      let t = this.tables.get(tk);
      if (!t) {
        t = { current: null, prev: null, seats: new Map(), at: this.clock() };
        this.tables.set(tk, t);
        if (this.tables.size > MAX_TABLES) {
          const oldest = [...this.tables.entries()].sort((a, b) => a[1].at - b[1].at)[0]![0];
          this.tables.delete(oldest);
        }
      }
      t.at = this.clock();
      if (t.current && t.current.key !== snap.key) this.count(t, t.current);
      // a later snapshot of the same hand replaces the earlier (its actions are a superset); a start stack seen once is kept
      if (t.current && t.current.key === snap.key) {
        snap.start = { ...t.current.start, ...snap.start };
        snap.dealt = [...new Set([...t.current.dealt, ...snap.dealt])];
        for (const x of t.current.vpip) snap.vpip.add(x);
        for (const x of t.current.pfr) snap.pfr.add(x);
        snap.complete ||= t.current.complete;
      }
      t.current = snap;
    } catch { /* logging only — never the decision's problem */ }
  }

  /** The previous hand is over: count it into each dealt seat's tally (the continuity check first). */
  private count(t: TableState, h: HandSnap): void {
    for (const seat of h.dealt) {
      if (seat === h.heroSeatId) continue;
      let tally = t.seats.get(seat);
      const s = Number(h.start[seat]);
      let cont: SeatContinuity = "new";
      if (tally && t.prev?.dealt.has(seat)) {
        const lastEnd = Number(t.prev.end[seat]);
        if (!Number.isFinite(s) || !Number.isFinite(lastEnd)) cont = "stack";            // nothing to say otherwise
        else if (s < lastEnd - CONT_TOL_BB) cont = "new";
        else cont = s > lastEnd + CONT_TOL_BB ? "grew" : "stack";
      }
      if (!tally || cont === "new") {
        tally = { hands: 0, vpip: 0, pfr: 0, partial: 0, continuity: "new", breaks: tally ? tally.breaks + 1 : 0, since: this.clock() };
        t.seats.set(seat, tally);
      }
      tally.continuity = cont;
      if (!h.complete) { tally.partial++; continue; }
      tally.hands++;
      if (h.vpip.has(seat)) tally.vpip++;
      if (h.pfr.has(seat)) tally.pfr++;
    }
    t.prev = { dealt: new Set(h.dealt), end: { ...h.end } };
  }

  /**
   * The villain seats of the table's current hand (or of `positions`, when the tracker has not seen this hand), each with
   * his tally over the completed hands before it. [] when the table was never observed.
   */
  snapshot(a: { sessionId: string | null | undefined; tableSlot: number | null | undefined; clientHandId?: string | null; heroSeatId?: number | null; positions?: Record<number, string> | null }): SeatStatsRow[] {
    const t = this.tables.get(this.tableKey(a.sessionId, a.tableSlot));
    if (!t) return [];
    const cur = t.current && (!a.clientHandId || t.current.key === String(a.clientHandId)) ? t.current : null;
    const positions = cur?.positions ?? a.positions ?? {};
    const hero = cur?.heroSeatId ?? a.heroSeatId ?? null;
    const seats = (cur?.dealt ?? Object.keys(positions).map(Number)).filter((s) => s !== hero).sort((x, y) => x - y);
    return seats.map((seatId) => {
      const s = t.seats.get(seatId);
      const prevHad = t.prev?.dealt.has(seatId) ?? false;
      // this hand's own stack check: a seat whose stack fell since the last counted hand is a new occupant NOW
      const start = Number(cur?.start[seatId]), lastEnd = Number(t.prev?.end[seatId]);
      const freshNow = !s || !prevHad || (Number.isFinite(start) && Number.isFinite(lastEnd) && start < lastEnd - CONT_TOL_BB);
      const hands = freshNow ? 0 : s!.hands, vpip = freshNow ? 0 : s!.vpip, pfr = freshNow ? 0 : s!.pfr;
      return {
        seatId, pos: positions[seatId] ?? null, hands, vpip, pfr, partial: freshNow ? 0 : s!.partial,
        continuity: freshNow ? "new" : (Number.isFinite(start) && Number.isFinite(lastEnd) && start > lastEnd + CONT_TOL_BB ? "grew" : "stack"),
        breaks: (s?.breaks ?? 0) + (s && freshNow ? 1 : 0),
        vpipPct: hands ? Math.round((1000 * vpip) / hands) / 10 : null,
        pfrPct: hands ? Math.round((1000 * pfr) / hands) / 10 : null,
      };
    });
  }
}

/** The API's one store (the ingest route and /fast-solver feed it; the study poller reads it into each answer row). */
export const seatStats = new SeatStats();

/** The answer row's `seat_stats` (JSON) for a decision's hand — null when the table was never observed. Never throws. */
export function seatStatsJson(sessionId: string | null | undefined,
    hand: { clientHandId?: string | null; tableSlot?: number | null; positions?: Record<number, string> | null; heroSeatId?: number | null; sessionId?: string | null } | null | undefined): string | null {
  try {
    if (!hand) return null;
    const rows = seatStats.snapshot({ sessionId: sessionId ?? hand.sessionId ?? null, tableSlot: hand.tableSlot ?? null, clientHandId: hand.clientHandId ?? null,
      heroSeatId: hand.heroSeatId ?? null, positions: hand.positions ?? null });
    return rows.length ? JSON.stringify(rows) : null;
  } catch { return null; }
}
