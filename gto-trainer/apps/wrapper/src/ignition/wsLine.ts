/**
 * THE HAND FROM THE PROTOCOL ALONE (2026-09-26, Brady: "construct everything from the WS protocol … the screen as a
 * checker"). A pure reducer: the frames the tap took for this hand (ws.ts onGameMsg keeps them in S.ws.frames, the
 * same stream debug/ws_dump-<slot>.jsonl records) in, the hand out — blinds and post-ins, every action in protocol
 * order at its exact size, the board, hero's cards, every seat's stack as dealt. Nothing here reads a clock, a tick or
 * the screen, so the same frames always give the same hand.
 *
 * Why: the event log it replaces merged THREE authors (these frames, the DOM backfill's badge/chip guesses once per
 * 1-3 s tick, and the level reconciler's cut-over) first-come-first-served, so timing decided the line. Backtest over
 * the 77 hands of NL5 session_20260926_030543 against Ignition's own hand histories: this reducer 76/77 exact (the
 * 77th = the socket closed with the session mid-hand, after hero's fold), where the archived lines had 15 hands wrong
 * before hero's last action (phantom BB checks, phantom hero checks postflop, lost first-to-act folds, lost stacks).
 * test/unit/ws-line-backtest.test.ts keeps that backtest.
 *
 * Row semantics are ws.ts's (eventLine): amounts in BB; raise / bet / all-in = the level it went TO, call = the chips
 * ADDED, post-sb / post-bb / post = the blind. A post-in's free option at its own turn is filed as the check it is
 * (the API folds it into the poster's limp — utils/foldPostIns); Ignition's history leaves it out.
 */
import { pyRound } from "../py";
import { wireCard } from "./dom";

// 128 (bet) and 512 (raise) carry their chips and fall to the amount rule below. 1048576 = "Folds & shows": a fold with
// no chips, which that rule would read as a check (hands 4921654555 / 4921725385, 2026-10-01).
const BTN: Record<number, string> = { 64: "check", 1024: "fold", 1048576: "fold", 256: "call", 4096: "raise", 2048: "all-in" };

export type WsRow = { seatId: number; hero: boolean; type: string; street: string; amount?: number };

export type WsHand = {
  actions: WsRow[];
  board: string[];
  dealt: number[];
  heroSeat: number | null;
  heroCards: string[];
  /** each seat's stack as dealt, in cents: its first account this hand plus what it had put in before it */
  startCents: Map<number, number>;
  folded: Set<number>;
  /** dead blinds: chips that went into the pot as nobody's bet (a returning player's dead small blind) */
  deadCents: number;
  /** the protocol's own pot (CO_CHIPTABLE_INFO curPot) against the chips the line put in, at the last pot frame */
  potCheck: { potCents: number; lineCents: number } | null;
  /** frames the reducer could not place (an action from a seat not dealt in, or one that already folded) */
  faults: string[];
};

/** A wire card as ws.ts names it ("7♣", "10♦") — the /hand export's own spelling; compare with dom.cardKey. */
const card = (n: unknown): string | null => wireCard(n);

/** The hand so far, from its frames. `bbCents` scales the amounts (null = unscaled: money rows carry no amount). */
export function wsHand(frames: readonly Record<string, any>[], bbCents: number | null): WsHand {
  const rows: WsRow[] = [];
  const faults: string[] = [];
  const level = new Map<number, number>();       // chips in front this street
  const moneyIn = new Map<number, number>();     // chips put in this hand (for startCents)
  const startCents = new Map<number, number>();
  const folded = new Set<number>();
  const board: string[] = [];
  let street = "preflop", maxBet = 0, dealt: number[] = [], heroSeat: number | null = null, heroCards: string[] = [];
  let potCheck: WsHand["potCheck"] = null;
  let returned = 0, deadCents = 0;
  const bb = (cents: number) => (bbCents ? pyRound(cents / bbCents, 2) : undefined);
  const push = (seatId: number, type: string, cents: number | null) => {
    const r: WsRow = { seatId, hero: seatId === heroSeat, type, street };
    const a = cents === null ? undefined : bb(cents);
    if (a !== undefined) r.amount = a;
    rows.push(r);
  };
  const account = (seat: number, acct: unknown) => {
    if (typeof acct === "number" && Number.isFinite(acct) && acct >= 0 && !startCents.has(seat)) startCents.set(seat, acct + (moneyIn.get(seat) ?? 0));
  };
  const live = () => dealt.filter((s) => !folded.has(s)).length;
  const newStreet = (s: string) => { street = s; level.clear(); maxBet = 0; };
  const act = (seat: number | null, btn: number | null, bet: number, rz: number, acct: unknown) => {
    if (seat === null || seat === undefined) return;
    if ((dealt.length && !dealt.includes(seat)) || folded.has(seat)) {
      faults.push(`seat ${seat} acted while ${folded.has(seat) ? "folded" : "not dealt in"}`);
      return;
    }
    let verb = btn !== null && btn !== undefined ? BTN[btn] : undefined;
    if (verb === undefined) verb = rz ? "raise" : bet ? "call" : "check";
    const prior = level.get(seat) ?? 0;
    const added = verb === "raise" ? rz : verb === "call" ? bet : verb === "all-in" ? Math.max(bet, rz) : 0;
    const to = prior + added;
    moneyIn.set(seat, (moneyIn.get(seat) ?? 0) + added);
    account(seat, acct);
    if (verb === "raise") push(seat, "raise", to);
    else if (verb === "all-in") push(seat, "all-in", to);
    else if (verb === "call") {
      if (to > maxBet) push(seat, "bet", to);
      else push(seat, "call", added);
    } else if (verb === "fold") {
      folded.add(seat);
      push(seat, "fold", null);
    } else push(seat, "check", null);
    level.set(seat, to);
    maxBet = Math.max(maxBet, to);
  };
  for (const d of frames) {
    switch (d.pid) {
      case "CO_BLIND_INFO": {
        const seat = d.seat ?? null, bet = Number(d.bet) || 0;
        if (seat === null) break;
        if (bet) {
          level.set(seat, (level.get(seat) ?? 0) + bet);
          maxBet = Math.max(maxBet, bet);
        }
        moneyIn.set(seat, (moneyIn.get(seat) ?? 0) + bet + (Number(d.dead) || 0));
        deadCents += Number(d.dead) || 0;
        account(seat, d.account);
        // btn 16 = a returning player's post WITH a dead small blind (bet = the live blind, dead = the dead one): the
        // live part is a post like btn 8's; the dead part is in the pot as nobody's bet (hands 4921653890 / 4921673957)
        if (bet && (d.btn === 2 || d.btn === 4 || d.btn === 8 || d.btn === 16)) push(seat, d.btn === 2 ? "post-sb" : d.btn === 4 ? "post-bb" : "post", bet);
        break;
      }
      case "CO_CARDTABLE_INFO": {
        dealt = [];
        for (const [k, v] of Object.entries(d)) {
          const m = /^seat(\d+)$/.exec(k);
          if (!m || !Array.isArray(v)) continue;
          dealt.push(Number(m[1]));
          const names = v.map(card).filter((x): x is string => !!x);
          if (names.length) { heroSeat = Number(m[1]); heroCards = names; }
        }
        dealt.sort((a, b) => a - b);
        for (const r of rows) r.hero = r.seatId === heroSeat;
        break;
      }
      case "CO_SELECT_INFO":
        act(d.seat ?? null, d.btn ?? null, Number(d.bet) || 0, Number(d.raise) || 0, d.account);
        break;
      case "CO_SELECT_SPEED_INFO": {
        const btns: number[] = d.btn || [], bets: number[] = d.bet || [], rzs: number[] = d.raise || [], accts: unknown[] = d.account || [];
        const n = Math.max(btns.length, bets.length, rzs.length), first = d.firstSeat || 1;
        for (let k = 0; k < n; k++) {
          const seat = ((((first - 1 + k) % n) + n) % n) + 1, i = seat - 1;
          const b = btns[i] ?? 0, be = bets[i] ?? 0, rz = rzs[i] ?? 0;
          if (b || be || rz) act(seat, b, be, rz, accts[i]);
        }
        break;
      }
      // a board card dealt once the hand is over (one seat left) is the rabbit hunt — no street (ws.ts withoutRabbit)
      case "CO_BCARD3_INFO":
        if (live() >= 2) {
          const names = (d.bcard || []).map(card);
          if (names.length === 3 && names.every(Boolean)) {
            names.forEach((c: string, i: number) => { board[i] = c; });
            newStreet("flop");
          }
        }
        break;
      case "CO_BCARD1_INFO": {
        const c = card(d.card);
        if (live() >= 2 && (d.pos === 4 || d.pos === 5) && c) {
          board[d.pos - 1] = c;
          newStreet(d.pos === 4 ? "turn" : "river");
        }
        break;
      }
      case "CO_CHIPTABLE_INFO": {
        const pots: number[] = d.curPot || [];
        returned += Number(d.returnBet) || 0;     // an uncalled bet handed back to `seat`: in the line, not the pot
        if (pots.length) {
          let line = -returned;
          for (const v of moneyIn.values()) line += v;
          potCheck = { potCents: pots.reduce((a, b) => a + b, 0), lineCents: line };
        }
        break;
      }
    }
  }
  return { actions: rows, board: board.filter(Boolean), dealt, heroSeat, heroCards, startCents, folded, deadCents, potCheck, faults };
}

/** Does the protocol's own pot agree with the chips the line put in? The pot frame counts every chip of the closed
 *  streets (the current street's bets join it when the street closes), so it is checked at the frame, where the two
 *  are the same money. null = no pot frame yet. */
export function potAgrees(h: WsHand): boolean | null {
  if (!h.potCheck) return null;
  return Math.abs(h.potCheck.potCents - h.potCheck.lineCents) <= 1;
}

/** Frames that change the line: between two copies of a frame, one of these makes the second a real repeat. */
const LINE_PIDS = new Set(["PLAY_STAGE_INFO", "CO_BLIND_INFO", "CO_CARDTABLE_INFO", "CO_SELECT_INFO", "CO_SELECT_SPEED_INFO",
                           "CO_BCARD3_INFO", "CO_BCARD1_INFO"]);

/** A frame delivered twice: the same content again within this many seconds with nothing that changes the line between. */
export const FRAME_TWIN_S = 0.25;

/**
 * A FRAME DELIVERED TWICE is one frame (recording 20260921_143046: every frame twice within milliseconds — hand
 * 4919661235's blinds and turn bet would count double). A REAL REPEAT is not: hand 4920544810's big blind checked
 * preflop, the flop came 46 ms later, and it checked the flop 1 ms after that — the same frame, same stack, a board
 * card between. So a copy is dropped only when nothing that changes the line came between the two. ws.ts keeps the
 * live hand's frames through one of these; tools/wsLineBacktest.ts replays a dump through another.
 */
export class TwinFilter {
  private last = new Map<string, { body: string; at: number; seq: number }>();
  private seq = 0;
  /** Keep this frame (arriving at `at` seconds)? */
  keep(d: Record<string, any>, at: number): boolean {
    const body = JSON.stringify(d), prev = this.last.get(d.pid);
    const twin = !!prev && prev.body === body && at - prev.at <= FRAME_TWIN_S && prev.seq === this.seq;
    if (twin) return false;
    if (LINE_PIDS.has(d.pid)) this.seq += 1;
    this.last.set(d.pid, { body, at, seq: this.seq });
    return true;
  }
}
