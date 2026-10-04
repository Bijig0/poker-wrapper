/**
 * STRESS-500 ENGINE (2026-10-05, Brady: "give me like 500 spots … weird limping preflop, crazy postflop … full hand
 * histories"). A strict no-limit hold'em table that writes a synthetic 6-max hand in the ARCHIVE's own terms — the
 * `hands.data` record the wrapper stores — so every hero decision is cut and solved exactly as the replay gate and
 * /resolve-chain do it (normalizeHand → withStartStacks(truncateAt(hand, i))).
 *
 * The archive contract it follows (feed/parsePanelFeed; scripts/stressPostflopSweep's builder):
 *   - amounts in big blinds; posts carry what was posted; a CALL carries the increment; a BET / RAISE / ALL-IN carries
 *     the seat's round TOTAL; an all-in call for less may be written as type "all-in" with that total (Ignition's RAI);
 *   - `startStacks` are the stacks as dealt (withStartStacks rebuilds every cut's stacks from them and the actions);
 *   - positions by seat id; seats numbered clockwise from a random button, so seat ids and positions never coincide.
 *
 * Legality is enforced, not assumed: the seat to act is the next one in rotation; a check only when nothing is owed; a
 * bet of at least the big blind; a raise of at least the last full raise (an all-in for less is an INCOMPLETE raise and
 * does not reopen the action for seats that already acted); a hand with one seat left, or all but one all-in and the
 * bets matched, ends or runs out the board.
 */

export const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
export type Pos = (typeof SEATS)[number];
export type Street = "preflop" | "flop" | "turn" | "river";
export const STREETS: Street[] = ["preflop", "flop", "turn", "river"];
const PRE_ORDER: Pos[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const POST_ORDER: Pos[] = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];
/** clockwise seating from the button: BTN, SB, BB, UTG, HJ, CO */
const CLOCKWISE: Pos[] = ["BTN", "SB", "BB", "UTG", "HJ", "CO"];

export interface RawAction { seatId: number; hero: boolean; type: string; street: Street; amount?: number }

export const r2 = (x: number): number => Math.round(x * 100) / 100;

export class IllegalAction extends Error {}

export interface TableOpts {
  id: string;
  /** every seat dealt in, with its stack as dealt (bb); a position left out is an empty seat */
  stacks: Partial<Record<Pos, number>>;
  hero: Pos;
  heroCards: [string, string];
  /** five board cards (only the ones the hand reaches are shown) */
  board: string[];
  /** non-blind seats that post 1bb to come in (Ignition's post-in; read as a limp when they check their option) */
  postIns?: Pos[];
  /** the button's seat number, 1-6 (seat ids run clockwise from it) */
  buttonSeat?: number;
}

export class Table {
  readonly id: string;
  readonly seats: Pos[];
  readonly seatId: Record<string, number> = {};
  readonly stack0: Record<string, number> = {};
  readonly hero: Pos;
  readonly heroCards: [string, string];
  readonly fullBoard: string[];
  readonly actions: RawAction[] = [];
  readonly postIns: Pos[];
  behind: Record<string, number> = {};
  inStreet: Record<string, number> = {};
  total: Record<string, number> = {};
  folded = new Set<Pos>();
  allIn = new Set<Pos>();
  street: Street = "preflop";
  high = 0;
  lastInc = 1;
  /** seats that have acted since the last FULL raise (they may not raise again facing an incomplete one) */
  actedSinceFull = new Set<Pos>();
  lastActor: Pos | null = null;
  ended = false;
  /** how the hand ended: "fold" (one seat left) or "showdown" (the board ran out) */
  endedBy: "fold" | "showdown" | null = null;
  /** the street the hand's last action was on (the board shown runs to the last street reached) */
  boardShown = 0;

  constructor(o: TableOpts) {
    this.id = o.id;
    this.hero = o.hero;
    this.heroCards = o.heroCards;
    this.fullBoard = o.board;
    this.postIns = o.postIns ?? [];
    this.seats = SEATS.filter((p) => o.stacks[p] != null);
    if (!this.seats.includes(o.hero)) throw new IllegalAction(`${o.id}: hero ${o.hero} is not dealt in`);
    if (!this.seats.includes("BB")) throw new IllegalAction(`${o.id}: no big blind`);
    const button = o.buttonSeat ?? 1;
    // seat ids clockwise from the button; a thinned table keeps the seat numbers of the full ring (empty seats exist)
    CLOCKWISE.forEach((p, k) => { this.seatId[p] = ((button - 1 + k) % 6) + 1; });
    for (const p of this.seats) {
      this.stack0[p] = r2(o.stacks[p]!);
      this.behind[p] = this.stack0[p]!;
      this.inStreet[p] = 0;
      this.total[p] = 0;
    }
    // the blinds and the post-ins
    if (this.seats.includes("SB")) this.post("SB", "post-sb", 0.5);
    this.post("BB", "post-bb", 1);
    for (const p of this.postIns) {
      if (!this.seats.includes(p) || p === "SB" || p === "BB") throw new IllegalAction(`${o.id}: post-in ${p} is not a dealt non-blind seat`);
      this.post(p, "post", 1);
    }
    this.high = 1;
    this.lastInc = 1;
    this.lastActor = "BB";
  }

  private push(p: Pos, type: string, amount?: number): void {
    this.actions.push({ seatId: this.seatId[p]!, hero: p === this.hero, type, street: this.street, ...(amount != null ? { amount: r2(amount) } : {}) });
  }
  private put(p: Pos, amt: number): void {
    const a = Math.min(amt, this.behind[p]!);
    this.behind[p] = r2(this.behind[p]! - a);
    this.inStreet[p] = r2(this.inStreet[p]! + a);
    this.total[p] = r2(this.total[p]! + a);
    if (this.behind[p]! <= 0.0001 && !this.folded.has(p)) this.allIn.add(p);
  }
  private post(p: Pos, type: string, amt: number): void {
    const a = Math.min(amt, this.behind[p]!);
    this.put(p, a);
    this.push(p, type, a);
  }

  /** the order the current street acts in, empty seats left out */
  order(): Pos[] { return (this.street === "preflop" ? PRE_ORDER : POST_ORDER).filter((p) => this.seats.includes(p)); }
  live(): Pos[] { return this.seats.filter((p) => !this.folded.has(p)); }
  active(): Pos[] { return this.live().filter((p) => !this.allIn.has(p)); }
  pot(): number { return r2(this.seats.reduce((s, p) => s + this.total[p]!, 0)); }
  toCall(p: Pos): number { return r2(Math.max(0, this.high - this.inStreet[p]!)); }
  needs(p: Pos): boolean {
    return !this.folded.has(p) && !this.allIn.has(p) && (!this.actedSinceFull.has(p) || this.inStreet[p]! < this.high - 0.0001);
  }
  canRaise(p: Pos): boolean {
    if (!this.needs(p)) return false;
    // facing only an incomplete raise after acting: call or fold
    if (this.actedSinceFull.has(p)) return false;
    // somebody must be able to answer a raise
    return this.active().filter((q) => q !== p).length > 0 && this.behind[p]! > this.toCall(p) + 0.0001;
  }

  /** the next seat to act, or null when the betting round is over */
  next(): Pos | null {
    if (this.ended) return null;
    const ord = this.order();
    const start = this.lastActor ? ord.indexOf(this.lastActor) : -1;
    for (let k = 1; k <= ord.length; k++) {
      const p = ord[(start + k + ord.length) % ord.length]!;
      if (this.needs(p)) return p;
    }
    return null;
  }

  private expect(p: Pos): void {
    if (this.ended) throw new IllegalAction(`${this.id}: ${p} acts after the hand ended`);
    const n = this.next();
    if (n !== p) throw new IllegalAction(`${this.id}: ${p} acts out of turn on the ${this.street} (${n ?? "nobody"} is to act)`);
  }

  fold(p: Pos): void {
    this.expect(p);
    this.folded.add(p);
    this.push(p, "fold");
    this.after(p);
  }
  check(p: Pos): void {
    this.expect(p);
    if (this.toCall(p) > 0.0001) throw new IllegalAction(`${this.id}: ${p} checks facing ${this.toCall(p)}`);
    this.actedSinceFull.add(p);
    this.push(p, "check");
    this.after(p);
  }
  /** a call; `asAllIn`: an all-in call (for less, or exactly) written as Ignition's all-in button */
  call(p: Pos, asAllIn = false): void {
    this.expect(p);
    const owe = this.toCall(p);
    if (owe <= 0.0001) throw new IllegalAction(`${this.id}: ${p} calls with nothing owed`);
    const inc = Math.min(owe, this.behind[p]!);
    this.put(p, inc);
    this.actedSinceFull.add(p);
    if (asAllIn && this.allIn.has(p)) this.push(p, "all-in", this.inStreet[p]);
    else this.push(p, "call", inc);
    this.after(p);
  }
  /** a bet or raise TO `to` (the seat's round total); past the stack = all-in */
  raise(p: Pos, to: number): void {
    this.expect(p);
    const cap = r2(this.inStreet[p]! + this.behind[p]!);
    let t = r2(Math.min(to, cap));
    if (t <= this.high + 0.0001) {
      // an all-in that does not top the bet is a call
      if (t >= cap - 0.0001 && this.toCall(p) > 0) { this.lastActor = this.lastActor; this.callFromRaise(p); return; }
      throw new IllegalAction(`${this.id}: ${p} raises to ${t}, not above ${this.high}`);
    }
    if (!this.canRaise(p)) throw new IllegalAction(`${this.id}: ${p} may not raise here (incomplete raise / nobody left to answer)`);
    const isAllIn = t >= cap - 0.0001;
    const inc = r2(t - this.high);
    const opening = this.high <= 0.0001;
    const minTo = opening ? 1 : r2(this.high + this.lastInc);
    if (t < minTo - 0.0001 && !isAllIn) throw new IllegalAction(`${this.id}: ${p} raises to ${t}, below the minimum ${minTo}`);
    this.put(p, r2(t - this.inStreet[p]!));
    const full = inc >= this.lastInc - 0.0001 || opening;
    if (full) {
      this.lastInc = opening ? Math.max(1, t) : inc;
      this.actedSinceFull = new Set([p]);
    } else {
      this.actedSinceFull.add(p);
    }
    this.high = t;
    const type = isAllIn ? "all-in" : opening && this.street !== "preflop" ? "bet" : "raise";
    this.push(p, type, t);
    this.after(p);
  }
  private callFromRaise(p: Pos): void {
    const inc = Math.min(this.toCall(p), this.behind[p]!);
    this.put(p, inc);
    this.actedSinceFull.add(p);
    this.push(p, this.allIn.has(p) ? "all-in" : "call", this.allIn.has(p) ? this.inStreet[p] : inc);
    this.after(p);
  }
  jam(p: Pos): void {
    const cap = r2(this.inStreet[p]! + this.behind[p]!);
    if (cap <= this.high + 0.0001) { this.expect(p); this.callFromRaise(p); return; }
    this.raise(p, cap);
  }

  private after(p: Pos): void {
    this.lastActor = p;
    if (this.live().length <= 1) { this.finish("fold"); return; }
    if (this.next() == null) this.closeRound();
  }

  private closeRound(): void {
    // nobody left who can act against anybody: run the board out
    const act = this.active();
    const matched = this.live().every((q) => this.allIn.has(q) || this.inStreet[q]! >= this.high - 0.0001);
    if (this.street === "river") { this.finish("showdown"); return; }
    if (act.length <= 1 && matched) {
      this.boardShown = 5;
      this.finish("showdown");
      return;
    }
    this.street = STREETS[STREETS.indexOf(this.street) + 1]!;
    this.boardShown = this.street === "flop" ? 3 : this.street === "turn" ? 4 : 5;
    for (const q of this.seats) this.inStreet[q] = 0;
    this.high = 0;
    this.lastInc = 1;
    this.actedSinceFull = new Set();
    const ord = this.order();
    this.lastActor = ord[ord.length - 1]!;
    if (this.next() == null) this.closeRound();
  }

  private finish(how: "fold" | "showdown"): void {
    this.ended = true;
    this.endedBy = how;
  }

  /** the default for a seat the script does not name: preflop fold; postflop check, else fold */
  idle(p: Pos): void {
    if (this.toCall(p) <= 0.0001) this.check(p);
    else this.fold(p);
  }

  /** The hand as the wrapper archives it (`hands.data`). */
  toRaw(meta: Record<string, unknown> = {}): Record<string, unknown> {
    const positions: Record<number, string> = {};
    const startStacks: Record<number, number> = {};
    const stacks: Record<number, number> = {};
    for (const p of this.seats) {
      positions[this.seatId[p]!] = p;
      startStacks[this.seatId[p]!] = this.stack0[p]!;
      stacks[this.seatId[p]!] = this.behind[p]!;
    }
    const dealt = this.seats.map((p) => this.seatId[p]!).sort((a, b) => a - b);
    const lastStreet = (this.actions.length ? this.actions[this.actions.length - 1]!.street : "preflop") as Street;
    const shown = this.endedBy === "showdown" ? 5 : lastStreet === "flop" ? 3 : lastStreet === "turn" ? 4 : lastStreet === "river" ? 5 : 0;
    const board = this.fullBoard.slice(0, Math.max(shown, this.boardShown && this.endedBy === "showdown" ? 5 : 0));
    const btnSeat = this.seats.includes("BTN") ? this.seatId.BTN! : this.seatId.SB ?? this.seatId.BB!;
    return {
      handId: meta.handId ?? 0,
      clientHandId: this.id,
      bbCents: 200,
      stakes: "$1/$2",
      heroSeatId: this.seatId[this.hero],
      heroCards: [...this.heroCards],
      board,
      street: lastStreet,
      actions: this.actions.map((a) => ({ ...a })),
      liveSeats: dealt,
      committed: {},
      potByStreet: {},
      positions,
      roster: {
        dealer: btnSeat, deadButton: false, deadSb: false, dealt,
        seats: Object.fromEntries(this.seats.map((p) => [this.seatId[p]!, {
          status: "dealt", ...(p === this.hero ? { hero: true } : {}),
          ...(p === "SB" ? { posted: "sb" } : p === "BB" ? { posted: "bb" } : this.postIns.includes(p) ? { posted: "post" } : {}),
        }])),
      },
      stacks,
      startStacks,
      currentNode: { street: lastStreet, toActSeatId: null, toActIsHero: false, pot: this.pot(), toCall: 0, legalActions: [], complete: true },
      heroFolded: this.folded.has(this.hero),
      ended: true,
      lineSource: "synthetic",
      ...meta,
    };
  }
}
