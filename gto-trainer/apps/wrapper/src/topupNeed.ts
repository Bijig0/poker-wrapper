/**
 * THE TOP-UP NEED (2026-10-04, Brady's design after session_20261003_234358) — ONE PURE FUNCTION decides WHETHER hero
 * needs chips and HOW MANY; the windows (topup.ts topUpWindow) only decide WHEN, and topUpRun does the presses. No DOM,
 * no clock, no globals: everything it weighs comes in as an argument, so a test or an offline check over the socket
 * dumps runs exactly the rule the live wrapper runs.
 *
 * WHY (session_20261003_234358, NL5, table 1): hand 4922343204's $0.05 pre-fold buy LANDED — the socket said so at
 * 23:54:11.494 (PLAY_ACCOUNT_CASH_RES type 2, hero's seat, cash 500) — but its on-screen receipt was a line identical to
 * hand 2's, so the reader never saw a new one, and the press stayed "pending". A pending press then blocked EVERY window
 * for 180 s without a word: hero folded KThh at 76.8bb and started hands 10-13 at 384 cents of a 500 max, and the first
 * press came 6 s after the lockout ran out. 62 of 263 pressed buys in the ten days before were never confirmed; about 69
 * short starts fell inside such a lockout. So:
 *  - a pending buy is settled by EVIDENCE, never by a timer: a receipt (the socket's, exact, or the screen's), a refusal,
 *    the stack at the next deal showing the chips (landed), or a hand that ENDED after the press with nothing to show
 *    for it (lost — the client adds a buy at the end of the hand in progress, or at once when hero is not dealt in, and
 *    its socket says so within a second);
 *  - while it is in flight it blocks, and SAYS so (`blockedBy`): the caller files one `top-up-need` event per hand.
 */

/** A buy is due once hero is at least this many big blinds below the table max (Brady 2026-10-03: keep it at 1.0). */
export const TOP_UP_MIN_SHORT_BB = 1.0;
/** A hand end counts against a pending buy only when it came this long after the BUY press: a press a moment before the
 *  end may reach the client after it and be added at the end of the NEXT hand. */
export const TOP_UP_END_GRACE_MS = 1000;
/** After such an end the client's socket names the add within ~0.3 s (PLAY_ACCOUNT_CASH_RES 0.25 s after
 *  PLAY_STAGE_END_REQ in every buy of 2026-10-03): with no word this long after it, the buy is lost. */
export const TOP_UP_RECEIPT_WAIT_MS = 3000;
/** No socket at all (the tap not bound): a press is lost after two deals and a minute with no receipt. */
export const TOP_UP_DOM_ONLY_HANDS = 2;
export const TOP_UP_DOM_ONLY_MS = 60_000;

/**
 * HOW CLOSE TWO AMOUNTS OF CHIPS MUST BE TO BE THE SAME BUY: half a big blind, at least a cent. It used to be a flat
 * $1 (`max(100, want/10)` in topUpRun, `<= 100` in the receipt match) — 20 big blinds at NL5, so every buy of $1 or
 * less was logged ok:true with the stack read unchanged (afterCents == beforeCents: 16 such records on 2026-10-03).
 */
export function topUpTolCents(bbCents: number | null | undefined): number {
  return Math.max(1, Math.floor((Number(bbCents) || 0) / 2));
}

/** The one buy pressed last (topup.ts S.study.lastTopUp), as the need function reads it. */
export interface PendingBuy {
  pressed?: boolean;
  amountCents?: number | null;
  /** hero's stack when the BUY was pressed */
  beforeCents?: number | null;
  /** when the BUY was pressed (ms); older records only carry `at`, when the run wrote them */
  pressedAtMs?: number | null;
  at?: number | null;
  /** the wrapper's hand counter at the press (S.handNo); older records carry it as `hand` */
  pressHandNo?: number | null;
  hand?: number | null;
  handKey?: string | null;
  receiptCents?: number | null;
  refused?: boolean;
  landed?: boolean;
  lost?: boolean;
}

export type NeedPoint = "deal" | "final" | "press";
export type PendingVerdict = "landed" | "lost" | "pending" | "refused" | null;

export interface NeedInput {
  /** deal = hero's stack as dealt, at the start of a hand he is in; final = a window is open (his stack for this hand
   *  is final, or he is not in it); press = topUpRun / the pre-action buy, right before the presses */
  point: NeedPoint;
  handKey: string;
  /** the wrapper's hand counter now (S.handNo) */
  handNo: number;
  /** hero's stack in cents — AS DEALT at the deal (what he posted this hand added back), his stack now otherwise */
  stackCents: number | null;
  /** where it came from ("socket: …" exact, "screen" a read of the felt) — carried into the verdict for the event */
  stackSource: string | null;
  maxCents: number | null;
  bbCents: number | null;
  zone: boolean;
  /** the pending-buy record, if any */
  pending: PendingBuy | null;
  /** when the table's socket saw a hand end (ms), most recent last */
  handEndsMs: number[];
  nowMs: number;
  /** the client's own word on what may still be added (PLAY_BUYIN_INFO allowedMax) — only when it is this panel's */
  allowedMaxCents?: number | null;
  /** the deep-stack reset's state (stackReset.ts): anything but idle means hero is on his way out of this seat */
  stackReset?: string | null;
  minShortBb?: number;
}

export interface NeedVerdict {
  /** hero is at least the floor below the max — the fact, whatever stands in the way */
  need: boolean;
  /** a stack and a max were known: a verdict, not a guess */
  known: boolean;
  shortCents: number | null;
  shortBb: number | null;
  floorCents: number | null;
  /** what a press would buy (the panel's own Max decides in the end) */
  amountCents: number;
  /** why a press must not go now, when need is true */
  blockedBy: string | null;
  pendingVerdict: PendingVerdict;
  /** the pending verdict's reason, when there is a pending record */
  pendingWhy: string | null;
  stackCents: number | null;
  stackSource: string | null;
  why: string;
}

const cents = (c: number) => `$${(c / 100).toFixed(2)}`;

/** What became of the last pressed buy, from the evidence alone. */
export function pendingVerdictOf(inp: NeedInput): [PendingVerdict, string | null] {
  const p = inp.pending;
  if (!p || !p.pressed) return [null, null];
  if (p.refused) return ["refused", "the client refused it"];
  if (p.receiptCents || p.landed) return ["landed", p.receiptCents ? `receipt for ${cents(p.receiptCents)}` : "landed"];
  if (p.lost) return ["lost", "no receipt after a hand end"];
  const pressAt = Number(p.pressedAtMs ?? p.at ?? 0) || 0;
  const amount = Number(p.amountCents) || 0;
  const tol = topUpTolCents(inp.bbCents);
  // THE STACK AT THE DEAL SHOWS IT: what hero had when he pressed plus what he bought (or the max itself)
  if (inp.point === "deal" && inp.stackCents !== null) {
    const before = p.beforeCents ?? null;
    if (before !== null && amount > 0 && inp.stackCents >= before + amount - tol) {
      return ["landed", `the stack at the deal (${inp.stackCents}c) shows the ${cents(amount)} bought at ${before}c`];
    }
    if (inp.maxCents && inp.stackCents >= inp.maxCents - tol) {
      return ["landed", `hero was dealt in at the max (${inp.stackCents}c)`];
    }
  }
  // A HAND ENDED AFTER THE PRESS and the socket named no add (or refusal) within the wait: lost
  const end = inp.handEndsMs.find((t) => t >= pressAt + TOP_UP_END_GRACE_MS);
  if (end !== undefined) {
    if (inp.nowMs - end >= TOP_UP_RECEIPT_WAIT_MS) {
      return ["lost", `a hand ended ${((inp.nowMs - end) / 1000).toFixed(0)} s ago, ${((end - pressAt) / 1000).toFixed(0)} s after the press, `
                      + "with no receipt and no refusal"];
    }
    return ["pending", "a hand just ended — the client's word on the buy is due"];
  }
  // NO SOCKET WORD AT ALL (a tap not bound): two deals and a minute
  const pressHand = p.pressHandNo ?? p.hand ?? null;
  if (inp.point === "deal" && pressHand !== null && inp.handNo - pressHand >= TOP_UP_DOM_ONLY_HANDS
      && inp.nowMs - pressAt >= TOP_UP_DOM_ONLY_MS) {
    return ["lost", `${inp.handNo - pressHand} hands and ${((inp.nowMs - pressAt) / 1000).toFixed(0)} s since the press with no receipt `
                    + "and the stack not showing it"];
  }
  return ["pending", `pressed ${((inp.nowMs - pressAt) / 1000).toFixed(0)} s ago; the client adds it at the end of the hand in progress`];
}

/** THE NEED: whether hero needs chips, how many, and what (if anything) stands in the way. Pure. */
export function topUpNeed(inp: NeedInput): NeedVerdict {
  const [pv, pwhy] = pendingVerdictOf(inp);
  const base = { pendingVerdict: pv, pendingWhy: pwhy, stackCents: inp.stackCents, stackSource: inp.stackSource };
  // WHAT STANDS IN THE WAY of any press, whatever the stack turns out to be (an unknown stack is read by the run —
  // a buy in flight or a reset under way must hold it all the same)
  let blockedBy: string | null = null;
  if (inp.stackReset && inp.stackReset !== "idle") blockedBy = `the deep-stack reset is under way (${inp.stackReset})`;
  else if (pv === "pending") blockedBy = `a ${cents(Number(inp.pending?.amountCents) || 0)} buy is still in flight — ${pwhy}`;
  const none = (why: string, known = false): NeedVerdict =>
    ({ need: false, known, shortCents: null, shortBb: null, floorCents: null, amountCents: 0, blockedBy: known ? null : blockedBy, ...base, why });
  if (inp.zone) return { ...none("Zone table — the client sets the stack", true), blockedBy: null };
  if (!inp.maxCents) return none("no table max known");
  if (inp.stackCents === null || inp.stackCents === undefined) return none("hero's stack unknown");
  const short = inp.maxCents - inp.stackCents;
  const bb = Number(inp.bbCents) || 0;
  const floor = Math.max(1, Math.round(bb * (inp.minShortBb ?? TOP_UP_MIN_SHORT_BB)));
  const shortBb = bb ? Math.round((short / bb) * 100) / 100 : null;
  const known = { known: true, shortCents: short, shortBb, floorCents: floor };
  if (short < floor) {
    return { ...none(short <= 0 ? "at or above the max" : `${short}c short — under the ${floor}c floor`, true), ...known };
  }
  // THE CLIENT'S OWN WORD wins over our arithmetic: allowedMax 0 = nothing can be added (hand 4922343004: our read said
  // 495 of 500, the table had paid hero's pot — 507 — and the panel opened at "Max. $0")
  if (inp.allowedMaxCents === 0) {
    return { ...none("the client says nothing can be added (its Max is $0)", true), ...known };
  }
  let amount = short;
  if (inp.allowedMaxCents && inp.allowedMaxCents > 0) amount = Math.min(amount, inp.allowedMaxCents);
  return { need: true, ...known, amountCents: amount, blockedBy, ...base,
           why: `${short}c below the ${inp.maxCents}c max (${shortBb ?? "?"} bb)` };
}
