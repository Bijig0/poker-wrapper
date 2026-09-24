/**
 * reconcile — rebuild a hand's betting line from LEVELS, not edges (shadow mode, 2026-09-18). Port of reconcile.py.
 *
 * The wrapper's live capture accumulates EVENTS (WebSocket frames, DOM badge/card diffs) into an action log. One
 * wrong edge is permanent. The client keeps LEVELS on screen every tick — each seat's chips in front, its stack,
 * how many hole cards it holds, the pot, the board, hero's own action buttons — and the line can be DERIVED from
 * how they change, in seat order:
 *
 *     a seat's chips-in-front rise ........ call / bet / raise-to (the level IS the amount)
 *     a seat's hole cards go away ......... fold      (held two ticks: cards flicker)
 *     a FOLD badge held two ticks ......... fold, tentative (a badge is the weakest signal)
 *     hero's buttons vanish while owing,
 *       chips unchanged ................... hero folded (hero's cards stay on screen)
 *     a later seat acts while an earlier live seat has no action this street and owes nothing .. it checked
 *     the street changes / hand ends with live seats unacted and nothing owed ... checks
 *
 * Everything derived carries a confidence and can be RETRACTED by later evidence. Invariants are checked every
 * tick and recorded, never silently fixed. This module is pure: it sees ticks and returns a line, violations and
 * a journal.
 *
 * THE RULE FOR ANYTHING OBSERVED OVER TIME: a signal that takes more than one tick to confirm must be
 *   1. TALLIED EVERY TICK, before any decision (_tally),
 *   2. DATED TO WHEN IT WAS SEEN, not when it was confirmed (hold_street, street_armed),
 *   3. REDEEMED EXACTLY ONCE (_add clears hero_gone_at; _end_street resolves a pending press).
 *
 * ORDER MATTERS: `seats` is a Map in the order the tick listed them — two folds seen on one tick are journalled
 * in that order, exactly as Python iterates its dict.
 */
import { SequenceMatcher } from "./difflib";
import { maxBy, pyFloat, pyRound } from "./py";

const BB_RE = /^\s*([\d,]+(?:\.\d+)?)\s*BB\s*$/i;
const CALL_RE = /^CALL\s+([\d.]+)\s*BB/i;
export const TOL = 0.06;
export const HOLD_TICKS = 2;
export const POT_HOLD = 4;
export const FAULT_TTL = 8;
export const FAULT_COALESCE = 3;
export const FAULT_STICKY = ["seat skipped while owing"];
export const STREETS = ["preflop", "flop", "turn", "river"] as const;

/** '7.5 BB' -> 7.5; anything else (None, '$3.00', 'RAISE') -> null. */
export function bb(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return s;
  if (typeof s === "boolean") return s ? 1 : 0;
  const m = BB_RE.exec(String(s));
  return m ? pyFloat(m[1]!.replace(/,/g, "")) : null;
}

export type SeatFacts = { stack?: unknown; bet?: unknown; cards?: number | null; hero?: boolean; badge?: string | null; dealer?: boolean };

export type Tick = {
  seq: number;
  t: string;
  seats: Map<number, SeatFacts>;
  pot: number | null;
  board: number;
  buttons: string[];
  hero: number | null;
};

export function makeTick(p: Partial<Tick> & { seq: number }): Tick {
  return { t: "", seats: new Map(), pot: null, board: 0, buttons: [], hero: null, ...p };
}

export function streetOf(board: number): number {
  return board < 3 ? 0 : board === 3 ? 1 : board === 4 ? 2 : 3;
}

/** Is the client asking hero to act? Real turn buttons, not a stale strip. */
export function buttonsUp(buttons: string[]): boolean {
  return buttons.some((b) => /^(FOLD|CHECK|CALL|BET|RAISE)/i.test(b))
    && buttons.some((b) => /\d/.test(b) || b.toUpperCase() === "CHECK");
}

/** Have the chips gone to the POT, or has one seat's slot just flickered? A SWEEP CLEARS THE WHOLE TABLE. */
function swept(levels: Map<number, number>, committed: Map<number, number>): boolean {
  for (const [n, c] of committed) if (c > TOL && (levels.get(n) ?? 0.0) > TOL) return false;
  return true;
}

export type JournalEntry = {
  seat: number;
  type: string;
  amount: number | null;
  street: string;
  seq: number;
  conf: number;
  via: string;
  retracted: { seq: number; why: string } | null;
  note?: string;
};

export type Violation = { seq: number; street: string; what: string; n: number; [k: string]: unknown };

const seatFacts = (tk: Tick, n: number): SeatFacts => tk.seats.get(n) || {};
const cardsOf = (s: SeatFacts | undefined) => (s?.cards || 0) as number;

export class HandReconciler {
  handNo: number;
  journal: JournalEntry[] = [];
  violations: Violation[] = [];
  armed = false;
  boardReset = false;
  street = 0;
  C = new Map<number, number>();
  done: Map<number, number>[] = [];
  maxBet = 0.0;
  live = new Set<number>();
  allin = new Set<number>();
  jamHold = new Map<number, number>();
  dealt = new Set<number>();
  sb: number | null = null;
  bbs: number | null = null;
  hero: number | null = null;
  acted = new Set<number>();
  foldHold = new Map<number, number>();
  cardHold = new Map<number, number>();
  holdStreet = new Map<number, number>();
  potBad = 0;
  undealtHold = new Map<number, number>();
  prev: Tick | null = null;
  heroOnClock = false;
  heroGoneAt: number | null = null;
  heroFolded = false;
  aggressor: number | null = null;
  private cardsNow = new Map<number, number>();
  sweepAt: number | null = null;
  streetArmed = true;
  lastPot: number | null = null;
  private badgeNow = new Map<number, string>();
  ended = false;
  revivals: { seq: number; why: string }[] = [];
  maxLive = 0;

  constructor(handNo: number) {
    this.handNo = handNo;
  }

  // ---- journal helpers ----
  private add(seat: number, kind: string, amount: number | null, seq: number, conf: number, via: string,
              note: string | null = null, street: number | null = null): JournalEntry {
    const a: JournalEntry = {
      seat, type: kind, amount, street: STREETS[street === null ? this.street : street]!, seq, conf, via, retracted: null,
    };
    if (note) a.note = note;
    if (this.allin.has(seat)) this.violate(seq, "action by an all-in seat", { seat, kind, amount, via });
    this.journal.push(a);
    if (seat === this.hero) this.heroGoneAt = null;
    return a;
  }

  private violate(seq: number, what: string, kw: Record<string, unknown> = {}): void {
    const street = STREETS[this.street]!;
    let last: Violation | undefined;
    for (let i = this.violations.length - 1; i >= 0; i--) {
      const v = this.violations[i]!;
      if (v.what === what && v.street === street) { last = v; break; }
    }
    if (last !== undefined && seq - last.seq >= 0 && seq - last.seq <= FAULT_COALESCE) {
      Object.assign(last, kw);
      last.seq = seq;
      last.n = (last.n || 1) + 1;
      return;
    }
    this.violations.push({ seq, street, what, n: 1, ...kw });
  }

  /** The violations that are TRUE NOW — what a caller should hold a decision on. */
  faults(street?: string | null): Violation[] {
    const st = street || STREETS[this.street];
    const now = this.prev ? this.prev.seq : 0;
    return this.violations.filter((v) => v.street === st && (FAULT_STICKY.includes(v.what) || now - v.seq <= FAULT_TTL));
  }

  private retract(seat: number, kind: string, seq: number, why: string): boolean {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const a = this.journal[i]!;
      if (a.seat === seat && a.type === kind && !a.retracted) {
        a.retracted = { seq, why };
        return true;
      }
    }
    return false;
  }

  line(): JournalEntry[] {
    return this.journal.filter((a) => !a.retracted);
  }

  // ---- order ----
  private ring(): number[] {
    const s = new Set(this.dealt);
    if (this.sb !== null) s.add(this.sb);
    if (this.bbs !== null) s.add(this.bbs);
    return [...s].sort((a, b) => a - b);
  }

  /** Seats in action order for the current street. Preflop: after the big blind. Postflop: from the small blind —
   *  except HEADS-UP, where the dealer posts the small blind and the BIG BLIND acts first on every postflop street.
   *  (Until 2026-09-24 heads-up took the preflop order on every street: the SB "checked first", so a turn where the
   *  BB checked and hero was to act derived a line with the BB's check missing — hand 4920374906, 75o, no answer
   *  on the turn or river. The API's capture gate, repairPostflopRotation, holds the same BB-first rule.) */
  order(): number[] {
    const ring = this.ring();
    if (!ring.length || this.bbs === null) return [];
    if (this.street > 0 && ring.length === 2) {
      if (!ring.includes(this.bbs)) return [];
      const i = ring.indexOf(this.bbs);
      return [...ring.slice(i), ...ring.slice(0, i)];
    }
    if (this.street === 0 || this.sb === null || !ring.includes(this.sb)) {
      const anchor = this.bbs;
      if (!ring.includes(anchor)) return [];
      const i = ring.indexOf(anchor);
      return [...ring.slice(i + 1), ...ring.slice(0, i + 1)];
    }
    const i = ring.indexOf(this.sb);
    return [...ring.slice(i), ...ring.slice(0, i)];
  }

  private confirmJam(num: number): void {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const a = this.journal[i]!;
      if (a.seat !== num || a.retracted) continue;
      if (a.street !== STREETS[this.street]) break;
      if (a.type === "bet" || a.type === "raise") {
        a.type = "all-in";
        this.allin.add(num);
      } else if (a.type === "all-in") {
        this.allin.add(num);
      } else if (a.type === "call") {
        this.allin.add(num);
      }
      break;
    }
  }

  private jammed(_tk: Tick, num: number): boolean {
    return (this.jamHold.get(num) || 0) >= HOLD_TICKS;
  }

  private impliedChecks(actor: number, seq: number): void {
    let order = this.order();
    if (!order.includes(actor)) return;
    if (this.aggressor !== null && order.includes(this.aggressor) && this.aggressor !== actor) {
      const i = order.indexOf(this.aggressor);
      order = [...order.slice(i + 1), ...order.slice(0, i + 1)];
    }
    for (const s of order) {
      if (s === actor) break;
      if (this.allin.has(s)) continue;
      if (this.live.has(s) && !this.acted.has(s)) {
        const owed = this.maxBet - (this.C.get(s) ?? 0.0);
        if (owed <= TOL) {
          this.add(s, "check", null, seq, 0.8, "order");
          this.acted.add(s);
        } else if ((this.cardsNow.has(s) ? this.cardsNow.get(s)! : 1) === 0 || this.badgeNow.get(s) === "FOLD") {
          this.add(s, "fold", null, seq, 0.85, (this.cardsNow.has(s) ? this.cardsNow.get(s)! : 1) === 0 ? "order+cards" : "order+badge");
          this.live.delete(s);
          this.acted.add(s);
          if (s === this.hero) {
            this.heroFolded = true;
            this.heroGoneAt = null;
          }
        } else if (s === this.hero) {
          const pressed = this.heroGoneAt !== null;
          this.add(s, "fold", null, seq, pressed ? 0.8 : 0.7, pressed ? "buttons+order" : "order",
                   pressed ? null : "pre-selected or unseen fold");
          this.live.delete(s);
          this.acted.add(s);
          this.heroFolded = true;
          this.heroGoneAt = null;
        } else {
          this.violate(seq, "seat skipped while owing", { seat: s, owed: pyRound(owed, 2), actor });
        }
      }
    }
  }

  private endStreet(seq: number): void {
    let maxLiveC = 0.0;
    let any = false;
    for (const s of this.live) {
      const v = this.C.get(s) ?? 0.0;
      if (!any || v > maxLiveC) { maxLiveC = v; any = true; }
    }
    if (this.maxBet - (any ? maxLiveC : 0.0) <= TOL) {
      for (const s of this.order()) {
        if (this.allin.has(s)) continue;
        if (this.live.has(s) && !this.acted.has(s) && this.maxBet - (this.C.get(s) ?? 0.0) <= TOL) {
          this.add(s, "check", null, seq, 0.7, "street-end");
        }
      }
    }
    if (this.heroGoneAt !== null && this.hero !== null && this.live.has(this.hero) && !this.acted.has(this.hero)
        && this.maxBet - (this.C.get(this.hero) ?? 0.0) > TOL) {
      this.add(this.hero, "fold", null, seq, 0.75, "buttons+street-end");
      this.live.delete(this.hero);
      this.acted.add(this.hero);
      this.heroFolded = true;
    }
    this.done.push(new Map(this.C));
    this.C = new Map();
    this.maxBet = 0.0;
    this.acted = new Set();
    this.aggressor = null;
    this.heroGoneAt = null;
  }

  // ---- the tick ----
  private revive(tk: Tick, why: string): void {
    this.ended = false;
    this.sweepAt = null;
    const levels = new Map<number, number>();
    for (const [n, s] of tk.seats) levels.set(n, bb(s.bet) || 0.0);
    this.C = new Map([...levels].filter(([, v]) => v > TOL));
    this.maxBet = this.C.size ? Math.max(...this.C.values()) : 0.0;
    const potNow = tk.pot !== null ? tk.pot : this.lastPot;
    if (potNow !== null) {
      let sumC = 0;
      for (const v of this.C.values()) sumC += v;
      this.done = [new Map([[0, Math.max(0.0, potNow - sumC)]])];
    }
    this.potBad = 0;
    if (this.heroFolded && this.hero !== null) {
      if (this.retract(this.hero, "fold", tk.seq, `hero is still in the hand — ${why}`)) {
        this.live.add(this.hero);
        this.acted.delete(this.hero);
      }
      this.heroFolded = false;
      this.heroGoneAt = null;
    }
    this.revivals.push({ seq: tk.seq, why });
  }

  private tally(tk: Tick): void {
    for (const [num, s] of tk.seats) {
      const cards = s.cards || 0;
      const badge = String(s.badge || "").toUpperCase();
      const had = !!((this.cardHold.get(num) || 0) || (this.foldHold.get(num) || 0));
      this.cardHold.set(num, cards === 0 && this.dealt.has(num) ? (this.cardHold.get(num) || 0) + 1 : 0);
      this.foldHold.set(num, badge === "FOLD" ? (this.foldHold.get(num) || 0) + 1 : 0);
      const stBb = bb(s.stack);
      this.jamHold.set(num, stBb !== null && stBb <= TOL ? (this.jamHold.get(num) || 0) + 1 : 0);
      if (this.jamHold.get(num) === HOLD_TICKS) this.confirmJam(num);
      const now = !!(this.cardHold.get(num) || this.foldHold.get(num));
      if (now && !had) {
        this.holdStreet.set(num, this.streetArmed ? this.street : Math.max(0, this.street - 1));
      } else if (!now) {
        this.holdStreet.delete(num);
      }
    }
  }

  observe(tk: Tick): void {
    this.tally(tk);
    if (this.ended) {
      if (buttonsUp(tk.buttons)) this.revive(tk, "hero's turn buttons came back up");
      else if (this.boardReset && streetOf(tk.board) > this.street) this.revive(tk, `the board grew to ${tk.board} cards`);
      else return;
    }
    if (tk.hero !== null && tk.hero !== undefined) this.hero = tk.hero;
    const levels = new Map<number, number>();
    for (const [n, s] of tk.seats) levels.set(n, bb(s.bet) || 0.0);
    if (!this.armed) {
      const clear = [...levels.values()].every((v) => v <= TOL);
      const blindsOnly = tk.pot !== null && tk.pot <= 1.5 + TOL && [...levels.values()].every((v) => v <= 1.0 + TOL);
      if (!(clear || blindsOnly)) {
        this.prev = tk;
        return;
      }
      this.armed = true;
    }
    if (tk.board === 0) this.boardReset = true;
    const board = this.boardReset ? tk.board : 0;
    for (const [num, s] of tk.seats) {
      if (s.hero && this.hero === null) this.hero = num;
      if ((s.cards || 0) >= 1) {
        this.dealt.add(num);
        if (!this.live.has(num) && !this.journal.some((a) => a.seat === num && a.type === "fold" && !a.retracted)) {
          this.live.add(num);
        }
      }
    }
    this.cardsNow = new Map([...tk.seats].map(([n, s]) => [n, s.cards || 0]));
    this.badgeNow = new Map([...tk.seats].map(([n, s]) => [n, String(s.badge || "").toUpperCase()]));
    const st = streetOf(board);
    if (st > this.street) {
      if (this.sweepAt === null) {
        this.endStreet(tk.seq);
        this.streetArmed = false;
      }
      this.sweepAt = null;
      this.street = st;
    }
    if (!this.streetArmed) {
      if ([...levels.values()].every((v) => v <= TOL)) {
        this.streetArmed = true;
      } else {
        this.prev = tk;
        return;
      }
    } else if (this.sweepAt !== null && tk.seq - this.sweepAt >= 8) {
      this.ended = true;
      return;
    }
    const order = this.order();
    let seqSeats = [...order, ...[...tk.seats.keys()].sort((a, b) => a - b).filter((n) => !order.includes(n))];
    if (this.bbs === null) {
      // Python's sorted() is stable; so is Array.prototype.sort
      seqSeats = [...seqSeats].sort((a, b) => (levels.get(a) ?? 0.0) - (levels.get(b) ?? 0.0));
    }
    const anyoneDealt = [...tk.seats.values()].some((s) => (s.cards || 0) >= 1);
    for (let num of seqSeats) {
      if (!tk.seats.has(num)) continue;
      let level = levels.get(num) ?? 0.0;
      const have = this.C.get(num) ?? 0.0;
      const undealtNow = level > have + TOL && !this.dealt.has(num) && anyoneDealt && (tk.seats.get(num)!.cards || 0) === 0;
      if (!undealtNow) this.undealtHold.delete(num);
      if (undealtNow) {
        this.undealtHold.set(num, (this.undealtHold.get(num) || 0) + 1);
        if (this.undealtHold.get(num)! >= HOLD_TICKS) {
          this.violate(tk.seq, "chips from an undealt seat", { seat: num, level: pyRound(level, 2) });
        }
        continue;
      }
      if (level > have + TOL) {
        if (this.sweepAt !== null) {
          this.ended = true;
          return;
        }
        const able = [...this.live].filter((n) => !this.allin.has(n));
        const roundDone = this.live.size > 0 && able.every((n) => this.acted.has(n) && Math.abs((this.C.get(n) ?? 0.0) - this.maxBet) <= TOL);
        const potRef = tk.pot !== null ? tk.pot : this.lastPot;
        const potGone = tk.pot === null && this.prev !== null && this.prev.pot !== null;
        if (this.bbs !== null && this.dealt.size && (roundDone || potGone || this.live.size <= 1 || able.length <= 1)
            && potRef !== null && potRef >= 1.5 && level >= 0.6 * potRef && level > this.maxBet + TOL) {
          this.settlePending(tk.seq);
          this.ended = true;
          return;
        }
        if (!this.live.has(num) && this.dealt.has(num) && this.retract(num, "fold", tk.seq, "chips added after the fold")) {
          this.live.add(num);
          this.violate(tk.seq, "fold retracted: seat added chips", { seat: num });
          this.heroFolded = num === this.hero ? false : this.heroFolded;
        }
        if (this.street === 0 && this.sb === null && this.bbs === null && level < 1.0 - TOL) {
          this.sb = num;
          this.add(num, "post-sb", pyRound(level, 2), tk.seq, 0.95, "level");
        } else if (this.street === 0 && this.bbs === null && Math.abs(level - 1.0) <= TOL && this.maxBet <= 1.0 + TOL) {
          this.bbs = num;
          this.add(num, "post-bb", 1.0, tk.seq, 0.95, "level");
        } else {
          const last = this.journal.length ? this.journal[this.journal.length - 1]! : null;
          if (last && last.seat === num && ["bet", "raise", "call", "all-in"].includes(last.type) && !last.retracted
              && last.street === STREETS[this.street] && tk.seq - last.seq <= 3) {
            if (last.type === "call" && level > this.maxBet + TOL) {
              last.type = "raise";
              last.amount = pyRound(level, 2);
              this.aggressor = num;
              this.acted = new Set([num]);
            } else if (last.type === "call") {
              last.amount = pyRound((last.amount || 0.0) + (level - have), 2);
            } else {
              last.amount = pyRound(level, 2);
            }
            if ((last.type === "bet" || last.type === "raise") && this.jammed(tk, num)) last.type = "all-in";
            if (last.type === "all-in") this.allin.add(num);
            last.seq = tk.seq;
            this.C.set(num, level);
            this.maxBet = Math.max(this.maxBet, level);
            continue;
          }
          this.impliedChecks(num, tk.seq);
          if (level > this.maxBet + TOL) {
            const kind = this.jammed(tk, num) ? "all-in" : this.maxBet > TOL ? "raise" : "bet";
            this.add(num, kind, pyRound(level, 2), tk.seq, 0.9, "level");
            if (kind === "all-in") this.allin.add(num);
            this.acted = new Set([num]);
            this.aggressor = num;
          } else {
            let short = this.maxBet - level > TOL;
            if (short) {
              const behind = bb(seatFacts(tk, num).stack);
              const implied = have + level;
              if ((behind === null || behind > TOL) && Math.abs(implied - this.maxBet) <= TOL) {
                level = implied;
                short = false;
              }
            }
            this.add(num, "call", pyRound(level - have, 2), tk.seq, 0.9, "level", short ? "short (all-in)" : null);
            if (this.jammed(tk, num)) this.allin.add(num);
            this.acted.add(num);
          }
        }
        this.C.set(num, level);
        this.maxBet = Math.max(this.maxBet, level);
      } else if (level + TOL < have && st === this.street && this.sb !== null && this.sweepAt === null && swept(levels, this.C)) {
        this.settlePending(tk.seq);
        if (this.live.size <= 1) {
          this.ended = true;
          return;
        }
        this.endStreet(tk.seq);
        this.sweepAt = tk.seq;
        break;
      }
    }
    const p = this.prev;
    this.maxLive = Math.max(this.maxLive, this.live.size);
    const othersHoldCards = [...tk.seats].some(([n, s]) => this.live.has(n) && (s.cards || 0) >= 1);
    if (this.maxLive >= 2 && !othersHoldCards && this.sb !== null) {
      this.settlePending(tk.seq);
      this.ended = true;
      return;
    }
    for (const [num, s] of tk.seats) {
      const cards = s.cards || 0;
      if (num === this.hero) continue;
      if (this.allin.has(num)) continue;
      if (this.live.has(num)) {
        const began = this.holdStreet.has(num) ? this.holdStreet.get(num)! : this.street;
        const late = began !== this.street;
        if ((this.cardHold.get(num) || 0) >= HOLD_TICKS) {
          if (!late) this.impliedChecks(num, tk.seq);
          this.add(num, "fold", null, tk.seq, 0.85, "cards", null, began);
          this.live.delete(num);
          this.acted.add(num);
        } else if ((this.foldHold.get(num) || 0) >= HOLD_TICKS && cards >= 1) {
          if (!late) this.impliedChecks(num, tk.seq);
          this.add(num, "fold", null, tk.seq, 0.5, "badge", "cards still showing", began);
          this.live.delete(num);
          this.acted.add(num);
        }
      } else if (this.dealt.has(num) && cards >= 1 && p !== null && cardsOf(p.seats.get(num)) === 0) {
        let last: JournalEntry | undefined;
        for (let i = this.journal.length - 1; i >= 0; i--) {
          const a = this.journal[i]!;
          if (a.seat === num && a.type === "fold" && !a.retracted) { last = a; break; }
        }
        if (last && last.via === "badge" && this.retract(num, "fold", tk.seq, "cards came back")) this.live.add(num);
      }
    }
    const on = buttonsUp(tk.buttons);
    if (this.hero !== null && this.live.has(this.hero)) {
      const owed = this.maxBet - (this.C.get(this.hero) ?? 0.0);
      if (on) {
        for (const b of tk.buttons) {
          const m = CALL_RE.exec(b);
          if (m && Math.abs(pyFloat(m[1]!) - owed) > TOL) {
            this.violate(tk.seq, "CALL amount disagrees with the ledger", {
              call: pyFloat(m[1]!), ledger_owed: pyRound(owed, 2), max_bet: this.maxBet, hero_in_front: this.C.get(this.hero) ?? 0.0,
            });
            break;
          }
          if (b.toUpperCase() === "CHECK" && owed > TOL) {
            this.violate(tk.seq, "CHECK offered while the ledger says hero owes", { ledger_owed: pyRound(owed, 2) });
            break;
          }
        }
        if (!this.heroOnClock) this.impliedChecks(this.hero, tk.seq);
      } else if (this.heroOnClock) {
        this.heroGoneAt = tk.seq;
      }
      if (this.heroGoneAt !== null && !on) {
        if (this.acted.has(this.hero)) {
          this.heroGoneAt = null;
        } else if (tk.seq - this.heroGoneAt >= 3) {
          if (owed <= TOL) {
            this.add(this.hero, "check", null, tk.seq, 0.75, "buttons");
            this.acted.add(this.hero);
          } else {
            this.add(this.hero, "fold", null, tk.seq, 0.8, "buttons");
            this.live.delete(this.hero);
            this.acted.add(this.hero);
            this.heroFolded = true;
          }
          this.heroGoneAt = null;
        }
      }
    }
    this.heroOnClock = on;
    if (tk.pot && this.bbs !== null && this.sweepAt === null) {
      let total = 0;
      for (const d of this.done) {
        let s = 0;
        for (const v of d.values()) s += v;
        total += s;
      }
      let sc = 0;
      for (const v of this.C.values()) sc += v;
      total += sc;
      const low = total * (this.street > 0 ? 0.94 : 1.0) - TOL;
      if (tk.pot > total + TOL || tk.pot < low) {
        this.potBad += 1;
        if (this.potBad >= POT_HOLD) this.violate(tk.seq, "pot disagrees with the ledger", { pot: tk.pot, ledger: pyRound(total, 2) });
      } else {
        this.potBad = 0;
      }
    }
    if (tk.pot) this.lastPot = tk.pot;
    this.prev = tk;
  }

  settlePending(seq: number): void {
    if (this.heroGoneAt !== null && this.hero !== null && this.live.has(this.hero) && !this.acted.has(this.hero) && !this.allin.has(this.hero)) {
      const owed = this.maxBet - (this.C.get(this.hero) ?? 0.0);
      if (owed <= TOL) {
        this.add(this.hero, "check", null, seq, 0.7, "buttons+end");
      } else {
        this.add(this.hero, "fold", null, seq, 0.75, "buttons+end");
        this.live.delete(this.hero);
        this.heroFolded = true;
      }
      this.acted.add(this.hero);
      this.heroGoneAt = null;
    }
    const ord = this.order();
    const seats1 = ord.length ? ord : [...this.live].sort((a, b) => a - b);
    for (const s of seats1) {
      if (this.allin.has(s)) continue;
      if (this.live.has(s) && s !== this.aggressor && this.maxBet - (this.C.get(s) ?? 0.0) > TOL) {
        this.add(s, "fold", null, seq, 0.7, "end", "owed at the pot award");
        this.live.delete(s);
        this.acted.add(s);
      }
    }
    const able = [...this.live].filter((s) => !this.allin.has(s));
    if (this.sweepAt === null && able.length >= 2) {
      const ord2 = this.order();
      const seats2 = ord2.length ? ord2 : [...this.live].sort((a, b) => a - b);
      for (const s of seats2) {
        if (able.includes(s) && !this.acted.has(s) && this.maxBet - (this.C.get(s) ?? 0.0) <= TOL) {
          this.add(s, "check", null, seq, 0.7, "end", "round closed at the pot award");
          this.acted.add(s);
        }
      }
    }
  }

  finish(seq: number): void {
    if (!this.ended) {
      this.settlePending(seq);
      if (this.sweepAt === null) this.endStreet(seq);
    }
    this.ended = true;
  }

  // ---- comparison with an archived line ----
  static normalize(actions: any[]): [string | null, number | null, string | null, number | null][] {
    return actions.map((a) => {
      const seat = "seat" in a ? a.seat : a.seatId;
      const amt = a.amount;
      return [a.street ?? null, seat ?? null, a.type ?? null, amt !== null && amt !== undefined ? pyRound(pyFloat(amt), 1) : null];
    });
  }

  /** The archive stops at hero's fold, so the derived line is cut at the same point before comparing. */
  diff(archived: any[]) {
    const mineFull = this.line();
    const theirs = HandReconciler.normalize(archived);
    const cut = mineFull.findIndex((a) => a.seat === this.hero && a.type === "fold");
    const mine = HandReconciler.normalize(cut < 0 ? mineFull : mineFull.slice(0, Math.max(cut + 1, theirs.length)));
    const sm = new SequenceMatcher(theirs, mine);
    const missing: unknown[] = [], extra: unknown[] = [], changed: unknown[] = [];
    for (const [tag, i1, i2, j1, j2] of sm.getOpcodes()) {
      if (tag === "equal") continue;
      if (tag === "replace") changed.push({ archive: theirs.slice(i1, i2), reconciled: mine.slice(j1, j2) });
      else if (tag === "delete") extra.push(...theirs.slice(i1, i2));
      else if (tag === "insert") missing.push(...mine.slice(j1, j2));
    }
    return {
      agree: !(missing.length || extra.length || changed.length), archive_only: extra, reconciled_only: missing, changed,
      archive: theirs, reconciled: mine,
    };
  }
}

/** Unused by the port but kept for parity with the module's surface. */
export const _maxBy = maxBy;
