/**
 * ClubGG table feed: screen snapshots (cggFrame) folded into one hand per table, and that hand as a ParsedHand.
 *
 * ClubGG gives us no log and no socket (a Unity player with an anti-tamper module; see sites/clubgg.ts), so the line
 * is REBUILT FROM WHAT THE SCREEN DRAWS, and every step says how it knows:
 *   - money moves are chip facts: a seat's bet number grew by Δ and its stack fell by Δ. A new bet value must be seen
 *     on two frames running (or with its action label) before it counts — one misread digit is not a raise.
 *   - the TYPE of a money move follows from the street's top bet (call = matches it, bet/raise = above it, all-in =
 *     stack 0); the seat's own label (Call / Raise / Bet / All-in) only confirms.
 *   - a fold is the red Fold label, or the seat's cards fading (dark) / gone on two frames running.
 *   - a check is the Check label, or the timer moving on from a seat that owed nothing (confirmed a frame later), or
 *     implied: a seat skipped by a later action while it owed nothing, and the seats left when a street closes.
 *   - "Total Pot N" (what the table says is in) is checked against the line's own sum every frame.
 * Anything inferred is marked on the action (`inferred`); anything the reader could not square goes to lineUncertain.
 *
 * Seats are numbered 1..N CLOCKWISE from the bottom-centre seat (ParsedHand orders seats by number), found from
 * where the plates are — the table's layout for its size is never assumed.
 */
import { time } from "../clock";
import { fmtG, pyRound } from "../py";
import { glyph, positions } from "./cpFeed";
import type { SeatSnap, Snapshot } from "./cggFrame";

export const SITE = "clubgg";
const EPS = 0.004;
const CENTER = { x: 849, y: 660 };               // the felt's middle (reference px): seat angles are taken about it
export const STREETS = ["PREFLOP", "FLOP", "TURN", "RIVER"] as const;

/** WHO HERO IS: CGG_HERO pins it; otherwise the seat showing FACE-UP cards mid-hand (only hero's are, before a showdown). */
export const hero = { name: (process.env.CGG_HERO || "").trim(), source: (process.env.CGG_HERO || "").trim() ? "CGG_HERO" : (null as string | null) };

export type Action = {
  street: string; seat: number; name: string; action: string; to: number; added: number; stack: number | null; t: number;
  inferred?: string;
};

export type Hand = {
  id: number; t0: number; tEnd?: number;
  sb: number | null; bb: number | null; ante: number | null;
  button: number | null;
  prevButton: number | null;                      // the last hand's button: a disc still there has not moved yet
  slotIds: Map<number, number>;                   // slot index -> seat id (frozen for the hand)
  names: Map<number, string>;
  startStacks: Map<number, number>;
  stacks: Map<number, number>;
  dealt: number[];
  hadCards: Set<number>;
  posting: boolean;                               // no voluntary action yet (blinds / posts / bomb antes)
  bomb: boolean;
  dead: number;                                   // money in the middle nobody's bet explains (a dead blind)
  actions: Action[];
  streetBet: Map<number, number>;
  street: (typeof STREETS)[number];
  board: (string | null)[];
  folded: Set<number>;
  allIn: Set<number>;
  round: number;                                  // bumps on every bet / raise
  acted: Map<number, number>;                     // seat -> the round it last acted in
  lastActor: number | null;
  toAct: number | null;
  turnAt: number | null;
  winners: { seat: number; name: string; won: number | null }[];
  shown: Map<number, (string | null)[]>;
  hero: number | null;
  heroCards: (string | null)[] | null;
  ended: boolean;
  done: boolean;
  joinedLate: boolean;
  uncertain: string[];
  potMismatch: number;                            // frames in a row the table's Total Pot disagreed with the line
  screenPot: number | null;
  frames: number;                                 // snapshots folded into this hand
  seen: Map<number, number>;                      // each seat's stack as last read (after the award, at the end)
  cardsSince: number | null;                      // when two seats first showed cards (the deal is out)
  staleLabels: Map<number, string>;               // labels already up when the street began (the last street's)
  stacksDue: Map<number, { want: number; n: number }>; // the stack a committed action should leave, until the screen shows it
};

const sortN = (xs: number[]) => [...xs].sort((a, b) => a - b);
// clockwise from 25 degrees before straight down: the bottom-centre seat (x ~849) must not sit on the seam, or a
// pixel either way numbers it first or last (20260928_194914: kaikye flipped to seat 7 mid-session)
const angleKey = (cx: number, cy: number) => ((Math.atan2(cy - CENTER.y, cx - CENTER.x) * 180 / Math.PI) - 90 + 25 + 720) % 360;

/** One table (window). */
export class Room {
  key: string;
  title: string;
  stakes: { sb: number | null; bb: number | null; ante: number | null } = { sb: null, bb: null, ante: null };
  /** where plates have been seen; `n` = how many frames — a place is a SEAT once seen on 5 (a stray OCR'd "name over a
   *  number" — another window's text, a chat line — never becomes one) */
  slots: { cx: number; cy: number; n: number }[] = [];
  hand: Hand | null = null;
  last: Hand | null = null;
  finished: Hand[] = [];
  touched = 0;
  closed = false;
  frames = 0;
  lastSnap: Snapshot | null = null;
  private pendingBet = new Map<number, number>();
  private noCards = new Map<number, number>();
  private pendingCheck: { seat: number; round: number; bet: number; since: number } | null = null;
  private dealerSeen: { seat: number | null; n: number } = { seat: null, n: 0 };
  private boardGone = 0;
  private handSeq = 0;

  constructor(key: string, title: string) {
    this.key = key;
    this.title = title;
  }

  // ---- seats ----
  private slotOf(cx: number, cy: number): number {
    let best = -1, bd = 1e9;
    this.slots.forEach((s, i) => {
      const d = Math.hypot(s.cx - cx, s.cy - cy);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0 && bd < 70) {
      this.slots[best]!.n++;
      return best;
    }
    this.slots.push({ cx, cy, n: 1 });
    return this.slots.length - 1;
  }

  /** slot -> seat id, 1..N clockwise from the bottom-centre seat. */
  private seatIds(): Map<number, number> {
    const all = this.slots.map((s, i) => ({ i, n: s.n, a: angleKey(s.cx, s.cy) }));
    // the first hand a reader sees starts before any place has been seen on 5 frames: then every place counts
    const sure = all.filter((o) => o.n >= 5);
    const order = (sure.length >= 2 ? sure : all).sort((a, b) => a.a - b.a);
    return new Map(order.map((o, k) => [o.i, k + 1]));
  }

  private nearestSeat(p: { x: number; y: number } | null, h: Hand | null): number | null {
    if (!p) return null;
    const ids = h ? h.slotIds : this.seatIds();
    let best: number | null = null, bd = 1e9;
    this.slots.forEach((s, i) => {
      const d = Math.hypot(s.cx - p.x, s.cy - p.y);
      if (d < bd && ids.has(i)) { bd = d; best = ids.get(i)!; }
    });
    return bd < 420 ? best : null;
  }

  // ---- the fold ----
  apply(snap: Snapshot): string[] {
    const out: string[] = [];
    this.touched = snap.t;
    this.closed = false;
    this.frames++;
    const bySlot = new Map<number, SeatSnap>();
    for (const s of snap.seats) bySlot.set(this.slotOf(s.cx, s.cy), s);
    // the dealer button, held for three frames before it counts as moved
    const dSeat = this.nearestSeat(snap.dealer, this.hand && !this.hand.done ? this.hand : null);
    if (dSeat === this.dealerSeen.seat) this.dealerSeen.n++;
    else this.dealerSeen = { seat: dSeat, n: 1 };
    const dealer = this.dealerSeen.n >= 3 ? this.dealerSeen.seat : null;

    let h = this.hand && !this.hand.done ? this.hand : null;
    if (h && this.shouldEnd(h, snap, bySlot, dealer, dSeat)) {
      this.finish(out);
      h = null;
    }
    if (!h) {
      if (!this.shouldStart(snap, bySlot)) {
        this.lastSnap = snap;
        return out;
      }
      h = this.startHand(snap, bySlot, dealer, out);
    }
    this.step(h, snap, bySlot, out, dealer);
    this.lastSnap = snap;
    return out;
  }

  private shouldStart(snap: Snapshot, bySlot: Map<number, SeatSnap>): boolean {
    const seats = [...bySlot.values()];
    return seats.some((s) => s.bet !== null && s.bet > 0) || seats.filter((s) => s.cards === "backs" || s.cards === "faces").length >= 2;
  }

  private shouldEnd(h: Hand, snap: Snapshot, bySlot: Map<number, SeatSnap>, dealer: number | null, dealerNow: number | null): boolean {
    // the board is not this hand's (different cards where both have one), or a hand that was over preflop now has a flop
    if (snap.board.some((c, i) => c && h.board[i] && c !== h.board[i])) return true;
    if (h.ended && !h.board.length && snap.board.length >= 3) return true;
    // frames missing for more than 3 s (the table was covered): a button that moved is a new hand, board or not
    const gap = this.lastSnap ? snap.t - this.lastSnap.t : 0;
    if (gap > 3 && dealerNow !== null && h.button !== null && dealerNow !== h.button && dealerNow !== h.prevButton) return true;
    // the board is cleared (two frames: a dealing animation can blank it for one)
    if (h.board.length && !snap.board.length) this.boardGone++;
    else this.boardGone = 0;
    if (this.boardGone >= 2) return true;
    // (never while a board is out: the pot's gold chips flying to the winner read as the button once — hand 1790600510296)
    if (dealer !== null && h.button !== null && dealer !== h.button && dealer !== h.prevButton && !snap.board.length && !h.posting) return true;
    // a hand that is over (winner shown / one seat left) gives way to the next deal's posts
    if (h.ended && !snap.board.length) {
      const bets = [...bySlot.values()].filter((s) => s.bet !== null && s.bet > 0).length;
      const cards = [...bySlot.values()].filter((s) => s.cards === "backs").length;
      if (bets >= 1 && (h.winners.length > 0 || cards >= 2)) return true;
    }
    return snap.t - h.t0 > 20 * 60;                 // nothing is a 20-minute hand
  }

  private startHand(snap: Snapshot, bySlot: Map<number, SeatSnap>, dealer: number | null, out: string[]): Hand {
    const slotIds = this.seatIds();
    const h: Hand = {
      id: Math.round(snap.t * 1000) + (this.handSeq++ % 1000), t0: snap.t,
      sb: this.stakes.sb, bb: this.stakes.bb, ante: this.stakes.ante,
      button: dealer ?? this.nearestSeat(snap.dealer, null), prevButton: this.last?.button ?? null, slotIds,
      names: new Map(), startStacks: new Map(), stacks: new Map(), dealt: [], hadCards: new Set(), posting: true, bomb: false, dead: 0,
      actions: [], streetBet: new Map(), street: "PREFLOP", board: [], folded: new Set(), allIn: new Set(), round: 0, acted: new Map(),
      lastActor: null, toAct: null, turnAt: null, winners: [], shown: new Map(), hero: null, heroCards: null, ended: false, done: false,
      joinedLate: false, uncertain: [], potMismatch: 0, screenPot: null, frames: 0, cardsSince: null, seen: new Map(), staleLabels: new Map(), stacksDue: new Map(),
    };
    // JOINED LATE: the first frame already shows a board, an action label, or a bet no blind explains
    const firstBets = [...bySlot.values()].map((s) => s.bet ?? 0).filter((b) => b > EPS);
    const cardsOut = [...bySlot.values()].filter((s) => s.cards === "backs" || s.cards === "faces").length >= 2;
    const bombLike = firstBets.length >= 3 && firstBets.every((b) => Math.abs(b - firstBets[0]!) < EPS);
    h.joinedLate = snap.board.length > 0 || [...bySlot.values()].some((s) => !!s.label && s.label !== "fold" && s.label !== "win")
      || (cardsOut && !bombLike && h.bb !== null && firstBets.some((b) => b > h.bb! + EPS));
    for (const [slot, s] of bySlot) {
      const id = slotIds.get(slot);
      if (id === undefined) continue;
      h.names.set(id, s.name);
      if (s.stack !== null) {
        // the stack BEFORE the bet in front of it: committing that bet takes it back off
        h.stacks.set(id, pyRound(s.stack + (s.bet ?? 0), 2));
        h.startStacks.set(id, pyRound(s.stack + (s.bet ?? 0), 2));
      }
    }
    if (h.joinedLate) h.uncertain.push("the reader joined this hand after it started");
    this.hand = h;
    this.pendingBet.clear();
    this.noCards.clear();
    this.pendingCheck = null;
    this.boardGone = 0;
    const btn = h.button !== null ? h.names.get(h.button) ?? `seat ${h.button}` : "unknown";
    out.push(`--- hand ${h.id}  ${fmtG(h.sb ?? 0)}/${fmtG(h.bb ?? 0)}  button ${btn}  | `
      + sortN([...h.names.keys()]).map((id) => `${h.names.get(id)} ${fmtG(h.startStacks.get(id) ?? 0)}`).join(", "));
    return h;
  }

  finish(out: string[] = []): void {
    const h = this.hand;
    if (!h || h.done) return;
    h.done = true;
    h.tEnd = time();
    this.last = h;
    this.finished.push(h);
    out.push(`  (hand ${h.id} over${h.winners.length ? ": " + h.winners.map((w) => `${w.name} ${w.won !== null ? "+" + fmtG(w.won) : "wins"}`).join(", ") : ""})`);
  }

  drainFinished(): Hand[] {
    return this.finished.splice(0);
  }

  // ---- action order ----
  private live(h: Hand): number[] {
    return h.dealt.filter((s) => !h.folded.has(s));
  }

  /** Seats in acting order for the street (preflop from after the big blind; later from after the button). */
  private order(h: Hand): number[] {
    const seats = sortN(h.dealt);
    if (!seats.length) return [];
    let start = 0;
    if (h.button !== null) {
      const after = seats.findIndex((s) => s > h.button!);
      start = after >= 0 ? after : 0;
      if (h.street === "PREFLOP" && !h.bomb && seats.length > 2) start = (start + 2) % seats.length;
      if (h.street === "PREFLOP" && seats.length === 2) start = seats.indexOf(h.button) >= 0 ? seats.indexOf(h.button) : start;
    }
    return [...seats.slice(start), ...seats.slice(0, start)];
  }

  private top(h: Hand): number {
    let m = 0;
    for (const v of h.streetBet.values()) if (v > m) m = v;
    return m;
  }

  private owes(h: Hand, seat: number): boolean {
    return (h.streetBet.get(seat) ?? 0) < this.top(h) - EPS;
  }

  private needsToAct(h: Hand, seat: number): boolean {
    if (h.folded.has(seat) || h.allIn.has(seat)) return false;
    return h.acted.get(seat) !== h.round || this.owes(h, seat);
  }

  private push(h: Hand, a: Omit<Action, "street" | "t" | "name"> & { name?: string }, out: string[], t: number): void {
    const name = a.name ?? h.names.get(a.seat) ?? `seat ${a.seat}`;
    const rec: Action = { street: h.street, t, name, ...a } as Action;
    h.actions.push(rec);
    if (!["SB", "BB", "Post", "Ante"].includes(a.action)) {
      h.acted.set(a.seat, h.round);
      h.lastActor = a.seat;
    }
    const who = a.seat === h.hero ? "HERO" : name;
    const amt = a.action === "Fold" || a.action === "Check" ? "" : ` ${fmtG(a.to)}`;
    out.push(`  ${h.street.slice(0, 4).toLowerCase()}  ${who} ${a.action}${amt}${a.stack !== null && a.stack !== undefined ? `  (stack ${fmtG(a.stack)})` : ""}${a.inferred ? `  [${a.inferred}]` : ""}`);
  }

  /** Before `seat` acts: every seat between the last actor and it that still had to act checked (when it owed
   *  nothing) — or the reader missed something (it owed chips and nothing was seen). */
  private skipTo(h: Hand, seat: number, out: string[], t: number): void {
    const ord = this.order(h);
    const i = ord.indexOf(seat);
    if (i < 0) return;
    let j = h.lastActor !== null && ord.includes(h.lastActor) ? (ord.indexOf(h.lastActor) + 1) % ord.length : 0;
    for (let guard = 0; j !== i && guard < ord.length; guard++, j = (j + 1) % ord.length) {
      const y = ord[j]!;
      if (!this.needsToAct(h, y)) continue;
      if (h.posting && h.street === "PREFLOP") continue;
      if (!this.owes(h, y)) this.push(h, { seat: y, action: "Check", to: h.streetBet.get(y) ?? 0, added: 0, stack: h.stacks.get(y) ?? null, inferred: "skipped by a later action while owing nothing" }, out, t);
      else h.uncertain.push(`${h.names.get(y) ?? "seat " + y} owed ${fmtG(this.top(h) - (h.streetBet.get(y) ?? 0))} on the ${h.street.toLowerCase()} and the reader saw no action from them`);
    }
  }

  /** A street ends: whoever still owed chips called (their stack says so) or is unknown; whoever had not acted checked. */
  private closeStreet(h: Hand, out: string[], t: number, snapSeats: Map<number, SeatSnap>): void {
    if (h.posting) this.endPosting(h, out, t);
    if (h.bomb && h.street === "PREFLOP") return;   // a bomb pot has no preflop betting: the antes go straight to the flop
    for (const y of this.order(h)) {
      if (!this.needsToAct(h, y)) continue;
      if (this.owes(h, y)) {
        const owed = this.top(h) - (h.streetBet.get(y) ?? 0);
        const s = snapSeats.get(y);
        const before = h.stacks.get(y);
        if (s && (s.cards === "none" || s.cards === "dark")) {
          h.folded.add(y);
          this.push(h, { seat: y, action: "Fold", to: h.streetBet.get(y) ?? 0, added: 0, stack: s.stack, inferred: "no cards when the street closed" }, out, t);
        } else if (s && s.stack !== null && before !== undefined && Math.abs(before - owed - s.stack) < 0.011) {
          this.commit(h, y, this.top(h), s, out, t, "the street closed and the stack paid the call");
        } else if (s && s.stack !== null && before !== undefined && s.stack < EPS && before < owed + EPS) {
          this.commit(h, y, (h.streetBet.get(y) ?? 0) + before, s, out, t, "the street closed; all in for less");
        } else {
          h.uncertain.push(`${h.names.get(y) ?? "seat " + y} owed ${fmtG(owed)} when the ${h.street.toLowerCase()} closed; no call or fold was seen`);
        }
      } else {
        this.push(h, { seat: y, action: "Check", to: h.streetBet.get(y) ?? 0, added: 0, stack: h.stacks.get(y) ?? null, inferred: "the street closed" }, out, t);
      }
    }
  }

  /** The blinds / posts are in: were they a bomb pot's antes? */
  private endPosting(h: Hand, out: string[], t: number): void {
    h.posting = false;
    const posts = h.actions.filter((a) => a.street === "PREFLOP" && ["SB", "BB", "Post", "Ante"].includes(a.action));
    const amts = posts.map((a) => a.to);
    const bb = h.bb ?? 0;
    if (posts.length >= 3 && amts.every((v) => Math.abs(v - amts[0]!) < EPS) && (!bb || amts[0]! > bb + EPS)) {
      h.bomb = true;
      for (const a of posts) a.action = "Ante";
      h.streetBet = new Map();                     // a bomb pot's antes are the pot, not a street's bets
      out.push(`  bomb pot: ${posts.length} x ${fmtG(amts[0]!)}`);
    }
  }

  /** A seat's bet reached `to`: type it and write it down. */
  private commit(h: Hand, seat: number, to: number, s: SeatSnap | undefined, out: string[], t: number, inferred?: string): void {
    const prev = h.streetBet.get(seat) ?? 0;
    const added = pyRound(to - prev, 2);
    if (added <= EPS) return;
    const stack = s?.stack ?? null;
    const top = this.top(h);
    let action: string;
    const post = h.posting && h.street === "PREFLOP" ? this.postType(h, seat, to) : null;
    if (post) action = post;
    else if (h.street === "PREFLOP" && to < this.top(h) - EPS && !(stack !== null && stack < EPS) && h.bb !== null && Math.abs(to - h.bb) < EPS) {
      // below the top bet and not all in: no call is that — a post (a returning player's big blind)
      action = "Post";
    } else {
      if (h.posting) this.endPosting(h, out, t);
      if (!inferred) this.skipTo(h, seat, out, t);
      const cur = this.top(h);
      if ((stack !== null && stack < EPS) || s?.label === "all-in") action = "AllIn";
      else if (to <= cur + EPS) action = "Call";
      else action = cur > EPS || h.street === "PREFLOP" ? "Raise" : "Bet";
      if (s?.label && ["call", "raise", "bet"].includes(s.label) && s.label !== action.toLowerCase() && action !== "AllIn") {
        h.uncertain.push(`${h.names.get(seat) ?? "seat " + seat}: the chips say ${action.toLowerCase()} ${fmtG(to)}, the table's label says ${s.label}`);
      }
    }
    void top;
    const before = h.stacks.get(seat);
    const want = before !== undefined ? pyRound(before - added, 2) : stack;
    if (want !== null && want !== undefined && stack !== null && Math.abs(want - stack) > 0.011) h.stacksDue.set(seat, { want, n: 0 });
    else h.stacksDue.delete(seat);
    if (!h.dealt.includes(seat)) h.dealt = sortN([...h.dealt, seat]);
    const raised = to > this.top(h) + EPS && !["SB", "BB", "Post", "Ante"].includes(action);
    h.streetBet.set(seat, to);
    if (want !== null && want !== undefined) h.stacks.set(seat, want);
    if (action === "AllIn" || (stack !== null && stack < EPS)) h.allIn.add(seat);
    if (raised) h.round++;
    this.push(h, { seat, action, to, added, stack, ...(inferred ? { inferred } : {}) }, out, t);
  }

  private cardsOut(h: Hand): boolean {
    return h.hadCards.size > 0;
  }

  /** While nobody has acted: is this bet a blind / post? The blinds are the two seats after the button (by amount
   *  when the button is unknown); any other post comes BEFORE the cards (after them, a big blind's worth is a limp). */
  private postType(h: Hand, seat: number, to: number): string | null {
    const sbSeat = this.blindSeat(h, 0), bbSeat = this.blindSeat(h, 1);
    if (h.sb !== null && Math.abs(to - h.sb) < EPS && (sbSeat === null || seat === sbSeat) && !h.actions.some((a) => a.action === "SB")) return "SB";
    if (h.bb !== null && Math.abs(to - h.bb) < EPS && (bbSeat === null || seat === bbSeat) && !h.actions.some((a) => a.action === "BB")) return "BB";
    if (!this.cardsOut(h)) return "Post";
    return null;
  }

  /** The small (k=0) / big (k=1) blind's seat: the k-th DEALT seat after the button (heads-up: the button is the SB).
   *  A seat sitting out between the button and the blinds is skipped (hand 1 of 20260928_194914: Sfuller321 sat out
   *  after the button, so dserf420 posted the small blind). Before any cards are out, every named seat counts. */
  private blindSeat(h: Hand, k: number): number | null {
    if (h.button === null) return null;
    const seats = sortN(h.dealt.length >= 2 ? [...new Set([...h.dealt, h.button])] : [...new Set([...h.names.keys()])]);
    if (seats.length < 2) return null;
    if (seats.length === 2) return k === 0 ? h.button : seats.find((s) => s !== h.button) ?? null;
    const after = seats.findIndex((s) => s > h.button!);
    const i = after >= 0 ? after : 0;
    return seats[(i + k) % seats.length]!;
  }

  private step(h: Hand, snap: Snapshot, bySlot: Map<number, SeatSnap>, out: string[], dealer: number | null = null): void {
    const t = snap.t;
    const seats = new Map<number, SeatSnap>();
    for (const [slot, s0] of bySlot) {
      const id = h.slotIds.get(slot);
      if (id === undefined) continue;
      // a label that was already up when this street began is the last street's (or the last hand's): not an action
      let s = s0;
      const stale = h.staleLabels.get(id);
      if (stale !== undefined) {
        if (s.label === stale) s = { ...s, label: null };
        else h.staleLabels.delete(id);
      }
      if (h.frames === 0 && s.label && !h.joinedLate) {
        h.staleLabels.set(id, s.label);
        s = { ...s, label: null };
      }
      seats.set(id, s);
      if (!h.names.has(id)) h.names.set(id, s.name);
      if (s.stack !== null) h.seen.set(id, s.stack);
      if (!h.stacks.has(id) && s.stack !== null) {
        h.stacks.set(id, pyRound(s.stack + (s.bet ?? 0), 2));
        if (h.street === "PREFLOP") h.startStacks.set(id, pyRound(s.stack + (s.bet ?? 0), 2));
      } else if (s.stack !== null && h.street === "PREFLOP" && h.frames < 4 && !h.joinedLate) {
        const dealt = pyRound(s.stack + Math.max(s.bet ?? 0, h.streetBet.get(id) ?? 0), 2);
        if (dealt > (h.startStacks.get(id) ?? 0) + 0.004) {
          h.startStacks.set(id, dealt);
          h.stacks.set(id, pyRound(dealt - (h.streetBet.get(id) ?? 0), 2));
          h.stacksDue.delete(id);
        }
      }
      if ((s.cards === "backs" || s.cards === "faces") && !h.ended) {
        h.hadCards.add(id);
        if (!h.dealt.includes(id) && (h.posting || h.street === "PREFLOP") && !h.folded.has(id)) h.dealt = sortN([...h.dealt, id]);
      }
    }
    if (h.cardsSince === null && h.hadCards.size >= 2) h.cardsSince = t;
    // stacks an action should have left: fine once the screen shows them; four frames of something else is a misread
    // line (or a misread stack) — say so and take the screen's number
    for (const [id, due] of [...h.stacksDue]) {
      const s = seats.get(id);
      if (!s || s.stack === null) continue;
      if (Math.abs(s.stack - due.want) <= 0.011) h.stacksDue.delete(id);
      else if (++due.n >= 4) {
        h.uncertain.push(`${h.names.get(id) ?? "seat " + id}'s stack reads ${fmtG(s.stack)}; the line leaves ${fmtG(due.want)}`);
        h.stacks.set(id, s.stack);
        h.stacksDue.delete(id);
      }
    }
    // money already in the middle before the first sweep = a dead blind (only at the start: the pot is swept there at the end)
    if (h.street === "PREFLOP" && h.frames < 2 && snap.centerPot !== null) h.dead = snap.centerPot;
    // hero: pinned by name, else the seat whose cards are FACE UP while another live seat still shows backs
    if (h.hero === null) {
      for (const [id, s] of seats) {
        if (hero.name && s.name === hero.name) h.hero = id;
      }
      if (h.hero === null && !h.ended && h.street !== "RIVER") {
        const faces = [...seats].filter(([, s]) => s.cards === "faces").map(([id]) => id);
        const backs = [...seats].filter(([, s]) => s.cards === "backs").length;
        if (faces.length === 1 && backs >= 1) h.hero = faces[0]!;
      }
    }

    // 1. a new street: more board cards, all of them read
    const nb = snap.board.length;
    if (h.frames === 0 && h.joinedLate && nb >= 3 && nb <= 5 && snap.board.every((c) => c)) {
      h.board = [...snap.board];
      h.street = nb === 3 ? "FLOP" : nb === 4 ? "TURN" : "RIVER";
      h.posting = false;
      h.dead = snap.centerPot ?? 0;               // what went in before the reader arrived
      h.uncertain.push(`the reader joined at the ${h.street.toLowerCase()}: nothing before it was seen`);
      out.push(`  == ${h.street} ${h.board.join(" ")} (joined here, ${fmtG(h.dead)} already in the middle)`);
    }
    if (!snap.boardRaised && nb > h.board.length && nb >= 3 && nb <= 5) {
      if (snap.board.every((c) => c)) {
        if (h.street === "PREFLOP" && h.joinedLate && !h.actions.length) {
          h.uncertain.push("the preflop was not seen (the reader joined at the " + (nb === 3 ? "flop" : nb === 4 ? "turn" : "river") + ")");
          h.posting = false;
        } else this.closeStreet(h, out, t, seats);
        h.board = [...snap.board];
        h.staleLabels = new Map([...seats].filter(([, x]) => !!x.label).map(([id, x]) => [id, x.label!]));
        for (const [id, x] of [...seats]) if (x.label) seats.set(id, { ...x, label: null });
        h.street = nb === 3 ? "FLOP" : nb === 4 ? "TURN" : "RIVER";
        h.streetBet = new Map();
        h.round++;
        h.lastActor = null;
        this.pendingBet.clear();
        this.pendingCheck = null;
        out.push(`  == ${h.street} ${h.board.map((c) => c ?? "?").join(" ")}`);
      }
    }

    // THE BUTTON WHILE THE BLINDS GO IN. The disc can still be on the last hand's seat when the new hand is first seen
    // (hand 1790600373611 of 20260928_194914 read kaikye's small blind as a post and William_Law's big blind as a
    // raise): while nobody has acted, a disc that settles on another seat moves this hand's button, and a disc still on
    // the last hand's seat gives way to the blinds — a small blind's worth with a big blind's worth on the next seat
    // round (seats with cards or chips; one sitting out or folded unseen can make that guess wrong, so a settled disc wins).
    if (h.posting && h.street === "PREFLOP") {
      if (dealer !== null && dealer !== h.button && dealer !== h.prevButton) {
        out.push(`  button: ${h.names.get(dealer) ?? "seat " + dealer} (the disc settled there)`);
        h.button = dealer;
      } else if (h.sb !== null && h.bb !== null && (h.button === null || h.button === h.prevButton)
                 && !h.actions.some((a) => a.action === "SB" || a.action === "BB")) {
        const ring = sortN([...seats].filter(([id, x]) => x.cards === "backs" || x.cards === "faces" || (x.bet ?? 0) > 0 || h.dealt.includes(id)).map(([id]) => id));
        const sbs = ring.filter((id) => Math.abs((seats.get(id)?.bet ?? 0) - h.sb!) < EPS);
        if (sbs.length === 1 && ring.length >= 3) {
          const i = ring.indexOf(sbs[0]!);
          const next = ring[(i + 1) % ring.length]!;
          const btn = ring[(i - 1 + ring.length) % ring.length]!;
          if (Math.abs((seats.get(next)?.bet ?? 0) - h.bb) < EPS && btn !== h.button) {
            out.push(`  button: ${h.names.get(btn) ?? "seat " + btn} — the blinds are ${h.names.get(sbs[0]!) ?? sbs[0]} / ${h.names.get(next) ?? next} (the disc is still on the last hand's seat)`);
            h.button = btn;
          }
        }
      }
    }

    // 2. chips: a bet that grew (seen twice, or once with its label)
    const ord = this.order(h);
    const rot = h.lastActor !== null && ord.includes(h.lastActor) ? ord.indexOf(h.lastActor) + 1 : 0;
    let walk = [...ord.slice(rot), ...ord.slice(0, rot), ...[...seats.keys()].filter((id) => !ord.includes(id))];
    if (h.posting && h.sb !== null && h.bb !== null) {
      // the blinds go in first, whatever else the same frame shows: the small blind, then the big blind after it —
      // everything else keeps its acting order (a returning player's post comes after the raise it sat behind)
      const amt = (id: number) => seats.get(id)?.bet ?? 0;
      const sbSeat = walk.filter((id) => Math.abs(amt(id) - h.sb!) < EPS);
      const ring = sortN(walk);
      let bbSeat: number | undefined;
      if (sbSeat.length === 1) {
        const i = ring.indexOf(sbSeat[0]!);
        bbSeat = [...ring.slice(i + 1), ...ring.slice(0, i)].find((id) => Math.abs(amt(id) - h.bb!) < EPS);
      }
      const first = [...(sbSeat.length === 1 ? [sbSeat[0]!] : []), ...(bbSeat !== undefined ? [bbSeat] : [])];
      walk = [...first, ...walk.filter((id) => !first.includes(id))];
    }
    for (const id of walk) {
      const s = seats.get(id);
      if (!s || s.bet === null || h.folded.has(id)) continue;
      const prev = h.streetBet.get(id) ?? 0;
      if (s.bet <= prev + EPS) {
        this.pendingBet.delete(id);
        continue;
      }
      const has = h.stacks.get(id);
      if (has !== undefined && s.bet > prev + has + 0.011) {
        // more than the seat has behind: a misread (an OCR'd jackpot, a covered frame's stray text)
        this.pendingBet.delete(id);
        continue;
      }
      const seen = this.pendingBet.get(id);
      const labelled = !!s.label && ["call", "raise", "bet", "all-in"].includes(s.label);
      const firstLook = h.frames === 0;                // the bets already out when the hand is first seen
      if ((seen === undefined || Math.abs(seen - s.bet) > EPS) && !labelled && !firstLook && !(h.posting && !this.cardsOut(h))) {
        this.pendingBet.set(id, s.bet);
        continue;
      }
      this.pendingBet.delete(id);
      this.commit(h, id, s.bet, s, out, t);
    }

    // 3. folds: the label, or the cards fading / gone two frames running
    if (!h.ended && !snap.boardRaised && !snap.seats.some((s) => s.win !== null || s.label === "win")) {
      const ordF = this.order(h);
      const r0 = h.lastActor !== null && ordF.includes(h.lastActor) ? ordF.indexOf(h.lastActor) + 1 : 0;
      for (const id of [...ordF.slice(r0), ...ordF.slice(0, r0)]) {
        if (h.folded.has(id)) continue;
        const s = seats.get(id);
        if (!s) continue;
        // a seat that put chips in but never showed cards once the deal was out (1.5 s) is out of the hand too
        const never = !h.hadCards.has(id) && h.cardsSince !== null && t - h.cardsSince > 1.5 && s.cards === "none";
        const gone = (h.hadCards.has(id) && (s.cards === "dark" || s.cards === "none")) || never;
        const n = gone ? (this.noCards.get(id) ?? 0) + 1 : 0;
        this.noCards.set(id, n);
        if (s.label === "fold" || n >= 2) {
          if (s.label === "fold") this.skipTo(h, id, out, t);
          h.folded.add(id);
          this.push(h, { seat: id, action: "Fold", to: h.streetBet.get(id) ?? 0, added: 0, stack: s.stack,
                         ...(s.label === "fold" ? {} : { inferred: never ? "no cards in front of it" : "its cards faded" }) }, out, t);
        }
      }
    }

    // 4. checks: the label, or the timer moving on from a seat that owed nothing (confirmed a frame later)
    const active = [...seats].find(([, s]) => s.active)?.[0] ?? null;
    const pc = this.pendingCheck;
    if (pc) {
      const s = seats.get(pc.seat);
      const moved = h.round !== pc.round || h.folded.has(pc.seat) || (h.streetBet.get(pc.seat) ?? 0) !== pc.bet || !this.needsToAct(h, pc.seat)
        || this.owes(h, pc.seat) || this.pendingBet.has(pc.seat) || (!!s && ((s.bet ?? 0) > pc.bet + EPS || (!!s.label && s.label !== "check")))
        || (!!s && s.cards !== "backs" && s.cards !== "faces");
      if (moved) this.pendingCheck = null;
      else if (t - pc.since >= 1.2) {
        this.skipTo(h, pc.seat, out, t);
        this.push(h, { seat: pc.seat, action: "Check", to: pc.bet, added: 0, stack: h.stacks.get(pc.seat) ?? null, inferred: "the timer moved on" }, out, t);
        this.pendingCheck = null;
      }
    }
    for (const [id, s] of seats) {
      if (s.label !== "check" || h.folded.has(id) || !this.needsToAct(h, id) || this.owes(h, id)) continue;
      if (h.posting) this.endPosting(h, out, t);
      this.skipTo(h, id, out, t);
      this.push(h, { seat: id, action: "Check", to: h.streetBet.get(id) ?? 0, added: 0, stack: s.stack }, out, t);
    }
    if (h.toAct !== null && active !== h.toAct && h.dealt.includes(h.toAct) && !h.posting && this.needsToAct(h, h.toAct) && !this.owes(h, h.toAct)) {
      this.pendingCheck = { seat: h.toAct, round: h.round, bet: h.streetBet.get(h.toAct) ?? 0, since: t };
    }
    if (active !== h.toAct) h.turnAt = t;
    h.toAct = active;

    // 5. the end: a WIN label / "+amount", or one seat left
    for (const [id, s] of seats) {
      if ((s.win !== null || s.label === "win") && !h.winners.some((w) => w.seat === id)) {
        h.winners.push({ seat: id, name: h.names.get(id) ?? s.name, won: s.win });
        out.push(`  wins: ${h.names.get(id) ?? s.name}${s.win !== null ? " +" + fmtG(s.win) : ""}`);
      } else if (s.win !== null) {
        const w = h.winners.find((x) => x.seat === id);
        if (w && w.won === null) w.won = s.win;
      }
      if (s.cards === "faces" && id !== h.hero && (h.ended || h.street === "RIVER" || h.allIn.size) && !h.shown.has(id)) {
        h.shown.set(id, [null, null]);
      }
    }
    if (!h.ended && (h.winners.length || (h.dealt.length >= 2 && this.live(h).length <= 1))) h.ended = true;

    // 6. the table's Total Pot against the line's
    if (snap.totalPot !== null && !h.ended) {
      h.screenPot = snap.totalPot;
      const line = pyRound(h.actions.reduce((a, x) => a + x.added, 0) + h.dead, 2);
      if (h.posting && snap.totalPot > line + EPS && !h.actions.some((a) => !["SB", "BB", "Post", "Ante"].includes(a.action))) {
        // money in the middle before anyone acted = a dead blind
        const pending = [...seats.values()].reduce((a, s) => a + (s.bet ?? 0), 0);
        if (pyRound(pending, 2) <= line + EPS) h.dead = pyRound(snap.totalPot - line, 2);
      } else if (Math.abs(snap.totalPot - line) > 0.011) {
        h.potMismatch++;
      } else h.potMismatch = 0;
    }
    h.frames++;
  }
}

// ---- ParsedHand export (ignition CONTRACT.md §1a) ------------------------------------------------------------
const TYPE: Record<string, string> = {
  SB: "post-sb", BB: "post-bb", Post: "post-bb", Fold: "fold", Check: "check", Call: "call", Bet: "bet", Raise: "raise", AllIn: "all-in",
};

/** The table's current hand as a ParsedHand (amounts in BB), or null between hands. */
export function exportHand(room: Room, h: Hand | null = room.hand): Record<string, any> | null {
  if (!h || (h.done && h !== room.last) || !h.bb) return null;
  const bb = h.bb;
  const r2 = (v: number | null | undefined) => (v !== null && v !== undefined ? pyRound(v / bb, 2) : null);
  const heroSeat = h.hero;
  const dealt = [...h.dealt];
  const street = h.street.toLowerCase();
  const actions: any[] = [];
  let pot = h.dead, ante = 0;
  const inferred: string[] = [];
  for (const a of h.actions) {
    pot += a.added;
    if (a.action === "Ante") {
      ante = Math.max(ante, a.added);
      continue;
    }
    const t = TYPE[a.action];
    if (!t) continue;
    const rec: Record<string, any> = { seatId: a.seat, hero: a.seat === heroSeat && heroSeat !== null, type: t, street: a.street.toLowerCase() };
    if (t !== "check" && t !== "fold") rec.amount = r2(t === "call" ? a.added : a.to);
    if (a.inferred) {
      rec.inferred = a.inferred;
      inferred.push(`${a.name} ${a.action.toLowerCase()} (${a.inferred})`);
    }
    actions.push(rec);
  }
  const committed = new Map<number, number | null>();
  for (const [sid, v] of h.streetBet) committed.set(sid, r2(v));
  let maxBet = 0;
  for (const v of h.streetBet.values()) if (v > maxBet) maxBet = v;
  const heroOwed = heroSeat !== null ? Math.max(0, maxBet - (h.streetBet.get(heroSeat) ?? 0)) : 0;
  const heroFolded = heroSeat !== null && h.folded.has(heroSeat);
  const villains = dealt.filter((s) => s !== heroSeat);
  const heroWon = heroSeat !== null && !heroFolded && villains.length > 0 && villains.every((s) => h.folded.has(s));
  const toActSeat = h.toAct;
  const toActHero = toActSeat !== null && toActSeat === heroSeat && !heroFolded && !h.ended;
  const status = heroSeat === null || !dealt.includes(heroSeat) ? "not-in-hand" : heroFolded ? "folded" : "in-hand";
  const why = toActHero ? null : heroSeat === null ? "no hero seat (observing)" : heroFolded ? "hero folded"
    : heroWon || h.ended ? "hand won" : toActSeat !== null ? `action on seat ${toActSeat}` : "action-on unknown";
  const stacks = new Map<number, number | null>();
  for (const [sid, v] of h.stacks) stacks.set(sid, r2(v));
  const startStacks = new Map<number, number>();
  for (const [sid, v] of h.startStacks) if (dealt.includes(sid)) startStacks.set(sid, r2(v)!);
  const unsure = [...h.uncertain];
  if (h.potMismatch >= 2 && h.screenPot !== null) unsure.push(`the table's Total Pot is ${fmtG(h.screenPot)}, the line adds up to ${fmtG(pyRound(pot, 2))}`);
  if (heroSeat !== null && !h.heroCards) unsure.push("hero's hole cards are not read yet (ClubGG hole-card templates pending)");
  return {
    handId: h.id,
    clientHandId: String(h.id),
    site: SITE,
    room: room.title,
    table: room.key,
    practice: false,
    bb, sb: h.sb ?? null, ante: ante ? ante : 0,
    bbCents: pyRound(bb * 100),
    anteBb: r2(ante) || 0,
    bombPot: h.bomb,
    deadBb: r2(h.dead) || 0,
    heroSeatId: heroSeat,
    heroName: heroSeat !== null ? h.names.get(heroSeat) ?? null : null,
    heroCards: (h.heroCards || []).map((c) => glyph(c)),
    board: h.board.map((c) => glyph(c)),
    street,
    actions,
    liveSeats: dealt,
    committed,
    potByStreet: {},
    positions: positions(dealt, h.button),
    names: new Map(h.names),
    stacks: stacks.size ? stacks : null,
    ...(startStacks.size ? { startStacks } : {}),
    currentNode: {
      street, toActSeatId: toActSeat, toActIsHero: toActHero, pot: r2(pot) || 0, toCall: r2(heroOwed) || 0, legalActions: [], complete: false,
    },
    heroFolded,
    heroWon,
    ended: heroFolded || heroWon || h.ended,
    buttonsUp: null,
    toActSources: { buttons: null, ws: null, actionOn: toActSeat, wsAt: h.turnAt, timeBank: null, screen: toActSeat },
    heroStatus: status,
    notToActWhy: why,
    lineSource: "screen",
    lineUncertain: unsure.length ? unsure.join("; ") : null,
    lineNote: inferred.length ? `inferred from the screen: ${inferred.join("; ")}` : null,
    winners: h.winners.map((w) => ({ seatId: w.seat, name: w.name, wonBb: r2(w.won) })),
  };
}
