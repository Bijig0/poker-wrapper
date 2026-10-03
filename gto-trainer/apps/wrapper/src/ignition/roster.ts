/**
 * THE TABLE'S SEATS BETWEEN HANDS (2026-10-04, the dead-button fix). A hand's own frames say who was dealt
 * (CO_CARDTABLE_INFO), where the button is (CO_DEALER_SEAT) and who posted (CO_BLIND_INFO) — not WHY a seat was not
 * dealt. That is said between hands, one seat at a time, and this module keeps the latest word per seat so each hand
 * can record its roster (hand.ts seatRoster → /hand `roster`, archived with the hand).
 *
 * WHAT THE WORDS MEAN — read off the socket dumps of 2026-10-02 18:00 → 10-03 20:00 (3,990 hands, both tables), each
 * word against whether the seat was dealt the next hand (scratch analysis, not a spec from Ignition):
 *   PLAY_SEAT_INFO {type, seat, state, account, nickName}
 *     `type` reads as the SITTING-OUT flag, `state` as the seat's occupancy (16 = no stack on the table: empty, or held
 *     by a player still sitting down; 32 = a player with his stack; 4 = only ever hero's own seat, 15 frames):
 *     type 1 state 32   a player sitting out — 547 of 584 next hands not dealt; account 0 = busted (158 of 158)
 *                       (seat 4 of table 2 at 16:02:15, the dead button of 4922296152; seat 4 at 16:35:29, busted)
 *     type 0 state 32   back in (seconds after a type 1: seat 5 at 16:01:11 → 16:01:14) — 3,576 of 3,825 dealt
 *     type 0 state 16   the player LEFT, the seat is empty (account 0) — 2,141 of 2,346 not dealt (the dealt ones
 *                       are a new player who sat down since: his arrival is not always a frame we see)
 *     type 1 state 16   a NEW player has the seat, sitting down — always followed within ~0.3 s by
 *                       PLAY_SEAT_RESERVATION {add: 0, seat}; he is dealt from the next hand he posts in (CO_BLIND_INFO
 *                       btn 8) or the next hand the big blind reaches him (seat 4 at 16:06:50 → dealt as BB 16:07:50)
 *   PLAY_SEAT_RESERVATION {add, seat}   `add` was 0 in every one of 638 frames — its meaning is NOT established; it is
 *                       kept only as "reserved" beside a type 1 state 16 word
 *   CO_TABLE_INFO {seatState[9], dealerSeat, account[9]}   the whole table once, when our socket joins (150 frames):
 *                       0 = no player (no stack), otherwise a bitmask over 16/32/64/4 whose bits are NOT established
 *                       (16, 48, 80 and 84 all both dealt and not dealt) — read here only as empty vs occupied
 *   CO_SIT_PLAY {play, seat}   HERO's own seat only (play 1 at his deal, 0 when he is out of the hand) — not a roster word
 * NOT ESTABLISHED: a seat's sitting-out state at the moment we join (no frame says it until it changes), the meaning of
 * the seatState bits beyond 0/non-0, and whether "waiting for the big blind" differs on the socket from "reserved".
 * The per-hand facts (dealt, button, posts) are exact; the words only say why an undealt seat was undealt.
 */
import { time } from "../clock";
import { S } from "../state";

export interface SeatWord {
  /** PLAY_SEAT_INFO type / state as sent; tableState = CO_TABLE_INFO's seatState when that is all we have */
  type?: number;
  state?: number;
  tableState?: number;
  account?: number;
  /** a PLAY_SEAT_RESERVATION came after the word */
  reserved?: boolean;
  at: number;
}

const words = (): Map<number, SeatWord> => (S.ws.seatWords ??= new Map<number, SeatWord>());

/** One frame the tap took for our table (ws.ts onGameMsg): the seat words it carries, if any. */
export function noteRosterFrame(d: Record<string, any>): void {
  const pid = d.pid;
  if (pid === "PLAY_SEAT_INFO") {
    const seat = Number(d.seat);
    if (!Number.isInteger(seat) || seat < 1) return;
    words().set(seat, { type: Number(d.type), state: Number(d.state), account: Number(d.account) || 0, at: time() });
  } else if (pid === "PLAY_SEAT_RESERVATION") {
    const seat = Number(d.seat);
    if (!Number.isInteger(seat) || seat < 1) return;
    const w = words().get(seat);
    words().set(seat, { ...(w ?? { at: time() }), reserved: true });
  } else if (pid === "CO_TABLE_INFO" && Array.isArray(d.seatState)) {
    // a fresh picture of the whole table (our socket joined it): it replaces every word heard before
    const m = new Map<number, SeatWord>();
    d.seatState.forEach((v: unknown, i: number) => {
      const acct = Array.isArray(d.account) ? Number(d.account[i]) || 0 : 0;
      m.set(i + 1, { tableState: Number(v) || 0, account: acct, at: time() });
    });
    S.ws.seatWords = m;
  }
}

export type SeatStatus = "dealt" | "sitting-out" | "busted" | "waiting" | "reserved" | "empty" | "not-dealt";

/** Why a seat the hand did NOT deal was left out, from its latest word (see the header for what each word means). */
export function undealtStatus(w: SeatWord | undefined): SeatStatus {
  if (!w) return "not-dealt";   // nothing heard about the seat since our socket joined: why it was not dealt is unknown
  if (w.type === undefined) return w.tableState ? "not-dealt" : "empty";
  if (w.state === 16) return w.type === 1 ? "reserved" : "empty";
  if (w.state === 32) return w.type === 1 ? (w.account ? "sitting-out" : "busted") : "waiting";
  return "not-dealt";
}

/** The latest word per seat (hand.ts reads it to build the hand's roster). */
export function seatWords(): Map<number, SeatWord> {
  return words();
}
