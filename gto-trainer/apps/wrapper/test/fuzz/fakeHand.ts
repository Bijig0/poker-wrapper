/**
 * A whole hand, rendered the way the Ignition client renders one — artefacts included (port of the Python
 * tests/fake_hand.py, 2026-09-24; seed for seed identical, see fuzz.test.ts).
 *
 * The fake TABLE draws one frozen spot: right for the DOM reader and the relay, no help for HandReconciler, which
 * consumes a STREAM of ticks — every reader bug of 2026-09-19 lived in how that stream is interpreted across time.
 * So this renders a scripted hand as ticks and returns the line it MEANT; what the reader derives must equal it.
 *
 * THE ARTEFACTS ARE THE POINT. Each is a behaviour observed in a real recording, with the hand it cost us:
 *   increment_first   a bet slot shows the chips ADDED for one tick before the new total (hand 4919236052)
 *   increment_only    the same, but the call CLOSES the street: the sweep lands before the new total is drawn, so
 *                     the increment is the ONLY frame (hand 4919310706). NOT in ALL_ARTEFACTS: an equal-increment
 *                     call is invisible in the chips and unrecorded — run it alone to get a real number
 *   badge_lag         a folded seat's cards go, and the FOLD badge arrives a tick later (hand 4919261748)
 *   fold_at_boundary  a fold lands in the last tick before the deal (hand 4919261748: a preflop fold filed on the
 *                     flop cost every postflop answer)
 *   pot_lingers       the pot label stays until the next deal (session 173224: the top-up waited five hands)
 *   sweep_late        the chips are pulled into the pot a tick or two AFTER the board grows
 *   award_in_slot     the pot is drawn in the WINNER'S BET SLOT for a tick, the label already gone (dashboard 621)
 *   card_flicker      a seat's card count blips to 0 for one tick — why HOLD_TICKS exists. NOT a bet-slot flicker:
 *                     the client has never been seen inventing a wager
 * Nothing here is invented. An artefact added should come with the recording that shows the client doing it.
 */
import { fmtG, pyRound } from "../../src/py";
import { makeTick, type SeatFacts, type Tick } from "../../src/reconcile";
import type { PyRandom } from "./pyRandom";

export const ALL_ARTEFACTS = ["increment_first", "badge_lag", "fold_at_boundary", "pot_lingers", "sweep_late",
                              "award_in_slot", "card_flicker"] as const;
export const STREETS = ["preflop", "flop", "turn", "river"] as const;

export type Act = [street: number, seat: number, type: string, amount: number | null];
export type Played = [street: string, seat: number, type: string, amount: number | null];

/** A hand to play. Seats are the client's own numbering, 1..capacity; `stacks` in seat order. */
export interface Script {
  stacks: Map<number, number>;
  hero: number;
  sb: number;
  bb: number;
  order: number[];
  actions: Act[];
}

const fmt = (v: number | null | undefined): string | null => (v === null || v === undefined ? null : `${fmtG(pyRound(v, 2))} BB`);

class Render {
  a: Set<string>;
  seq = 0;
  ticks: Tick[] = [];
  stack: Map<number, number>;
  bet = new Map<number, number>();
  cards = new Map<number, number>();
  badge = new Map<number, string | null>();
  pot: number | null = null;
  boardN = 0;
  buttons: string[] = [];
  expected: Played[] = [];

  constructor(public s: Script, artefacts: readonly string[], public rng: PyRandom) {
    this.a = new Set(artefacts);
    this.stack = new Map(s.stacks);
    for (const n of s.stacks.keys()) {
      this.cards.set(n, 0);
      this.badge.set(n, null);
    }
  }

  emit(n = 1): void {
    for (let k = 0; k < n; k++) {
      this.seq++;
      const seats = new Map<number, SeatFacts>();
      for (const num of this.s.stacks.keys()) {
        seats.set(num, { stack: fmt(this.stack.get(num)), bet: fmt(this.bet.get(num)), cards: this.cards.get(num)!,
                         hero: num === this.s.hero, badge: this.badge.get(num) ?? null });
      }
      const t = `${String(Math.floor(this.seq / 60)).padStart(2, "0")}:${String(this.seq % 60).padStart(2, "0")}`;
      this.ticks.push(makeTick({ seq: this.seq, t, seats, pot: this.pot, board: this.boardN, buttons: [...this.buttons], hero: this.s.hero }));
      // a badge lasts a few ticks then clears, as the client's does
      for (const [num, b] of [...this.badge]) if (b && this.rng.random() < 0.35) this.badge.set(num, null);
    }
  }

  potAdd(amount: number): void {
    this.pot = pyRound((this.pot || 0.0) + amount, 2);
  }

  post(seat: number, amount: number, kind: "post-sb" | "post-bb"): void {
    this.bet.set(seat, amount);
    this.stack.set(seat, pyRound(this.stack.get(seat)! - amount, 2));
    this.badge.set(seat, kind === "post-sb" ? "POST-SB" : "POST-BB");
    this.potAdd(amount);
    this.expected.push([STREETS[0], seat, kind, amount]);
    this.emit(2);
  }

  /** A bet / raise / call. `to` is the seat's street TOTAL. */
  wager(street: number, seat: number, kind: string, to: number, closes = false): void {
    const had = this.bet.get(seat) ?? 0.0;
    const added = pyRound(to - had, 2);
    if (this.a.has("increment_only") && closes && kind === "call" && had > 0 && added > 0) {
      // the chips are swept before the client ever draws the new total: the increment is all the reader sees
      this.bet.set(seat, added);
      this.stack.set(seat, pyRound(this.stack.get(seat)! - added, 2));
      this.badge.set(seat, "CALL");
      this.potAdd(added);
      this.expected.push([STREETS[street]!, seat, kind, added]);
      this.emit(1);
      return;
    }
    if (this.a.has("increment_first") && added > 0) {
      this.bet.set(seat, added);            // the chips being pushed, before the new total
      this.emit(1);
    }
    this.bet.set(seat, to);
    this.stack.set(seat, pyRound(this.stack.get(seat)! - added, 2));
    // A WAGER THAT EMPTIES THE STACK IS AN ALL-IN, and the client says so twice (stack 0, badge ALL-IN) — hand 4919482454
    const jam = this.stack.get(seat)! <= 0.005 && (kind === "bet" || kind === "raise");
    if (jam) kind = "all-in";
    this.badge.set(seat, jam ? "ALL-IN" : ({ call: "CALL", bet: "BET", raise: "RAISE" } as Record<string, string>)[kind] ?? kind.toUpperCase());
    this.potAdd(added);
    this.expected.push([STREETS[street]!, seat, kind, kind === "call" ? added : to]);
    this.emit(2);
  }

  check(street: number, seat: number): void {
    this.badge.set(seat, "CHECK");
    this.expected.push([STREETS[street]!, seat, "check", null]);
    this.emit(2);
  }

  fold(street: number, seat: number, atBoundary = false): void {
    // HERO'S CARDS STAY ON SCREEN WHEN HE FOLDS — only a villain's seat clears; the reader infers hero's fold
    // from the buttons
    if (seat !== this.s.hero) this.cards.set(seat, 0);
    this.expected.push([STREETS[street]!, seat, "fold", null]);
    if (atBoundary) {
      this.emit(1);                        // the last tick of the street: the hold completes on the next street
      return;
    }
    this.emit(1);
    if (this.a.has("badge_lag")) this.badge.set(seat, "FOLD");
    this.emit(2);
  }

  /** Hero on the clock, then the buttons go; his press shows in the chips a tick or two later — or, for a fold, never. */
  heroTurn(buttons: string[], think = 3): void {
    this.buttons = buttons;
    this.emit(think);
    this.buttons = [];
    this.emit(1);
  }

  /** A new street: sweep the chips, then grow the board. */
  deal(upto: number): void {
    if (this.a.has("sweep_late")) {
      this.boardN = upto;
      this.emit(1);
      this.bet = new Map();
      this.emit(2);
    } else {
      this.bet = new Map();
      this.emit(1);
      this.boardN = upto;
      this.emit(2);
    }
  }

  /** One tick of a live seat's cards vanishing and coming straight back. */
  flicker(): void {
    if (!this.a.has("card_flicker") || this.rng.random() > 0.35) return;
    const live = [...this.cards].filter(([, c]) => c >= 1).map(([n]) => n);
    if (!live.length) return;
    const victim = this.rng.choice(live);
    this.cards.set(victim, 0);
    this.emit(1);
    this.cards.set(victim, 2);
    this.emit(1);
  }
}

/** [ticks, expected line]. The line is what was PLAYED, in the reader's own vocabulary. */
export function simulate(script: Script, artefacts: readonly string[], rng: PyRandom): [Tick[], Played[]] {
  const r = new Render(script, artefacts, rng);
  r.emit(2);                                // the table before the deal: clear, so the reader arms
  r.post(script.sb, 0.5, "post-sb");
  r.post(script.bb, 1.0, "post-bb");
  for (const n of script.stacks.keys()) r.cards.set(n, 2);
  r.emit(2);

  const byStreet = new Map<number, Act[]>();
  for (const a of script.actions) {
    if (!byStreet.has(a[0])) byStreet.set(a[0], []);
    byStreet.get(a[0])!.push(a);
  }
  for (const street of [...byStreet.keys()].sort((x, y) => x - y)) {
    if (street > 0) r.deal(2 + street);
    const acts = byStreet.get(street)!;
    acts.forEach(([, seat, kind, amount], i) => {
      const lastOfStreet = i === acts.length - 1;
      if (seat === script.hero) r.heroTurn(kind !== "check" ? ["FOLD", "CALL 1 BB", "RAISE TO 2 BB"] : ["CHECK", "BET 1 BB"]);
      if (kind === "fold") {
        const boundary = lastOfStreet && r.a.has("fold_at_boundary") && byStreet.has(street + 1);
        r.fold(street, seat, boundary);
      } else if (kind === "check") r.check(street, seat);
      else r.wager(street, seat, kind, amount!, lastOfStreet);
      r.flicker();
    });
  }

  // the pot is awarded: chips clear, the winner's stack rises, and the pot label may hang about until the next deal
  const winner = [...script.stacks.keys()].find((s) => r.cards.get(s)! >= 1) ?? script.hero;
  const won = r.pot || 0;
  if (r.a.has("award_in_slot") && !r.a.has("pot_lingers") && won) {
    r.bet = new Map([[winner, won]]);       // the pot travels to the winner through his bet slot
    r.pot = null;
    r.emit(1);
  }
  r.bet = new Map();
  r.stack.set(winner, pyRound(r.stack.get(winner)! + won, 2));
  if (!r.a.has("pot_lingers")) r.pot = null;
  r.emit(4);
  return [r.ticks, r.expected];
}
