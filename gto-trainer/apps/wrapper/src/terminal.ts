/**
 * THE TERMINAL-ACTION FAMILY — one named place for "after this press hero has no further decision in this hand"
 * (2026-09-23, Brady: top up before ANY terminal action, not only a fold). Port of terminal.py.
 *
 * Why a family and not a string test. The pre-fold top-up buys chips while we still hold hero's clock, so the
 * deadline is ours and not the dealer's. It qualified only a plain FOLD because a fold is the one action after
 * which hero's stack BEHIND is his final stack — the amount is exact. But hero also has no further decision after
 * a shove, after a call that puts him all-in, after the river call or check that closes the action, and after a
 * call when every opponent is already all-in. What differs is only that hero may still WIN the pot, so a buy
 * sized off stack-behind can land above the table max and be refused at the next hand — an EXPECTED outcome the
 * caller must handle, so the verdict says which case it is (`finalStackKnown`), never just yes/no.
 *
 * Pure functions of the relay PLAN and the exported ParsedHand. CONSERVATIVE BY CONSTRUCTION: every uncertainty
 * resolves to NOT terminal — except a fold, which is terminal whatever else we know.
 */
import { pyFloat, pyFloatStr, pyInt, pyRepr, pyReprStr, sortedNums } from "./py";

export const EPS_BB = 0.05;

export const TERMINAL_ACTIONS: Record<string, string> = {
  fold: "always",
  "all-in": "always",
  call: "conditional",
  check: "conditional",
  "raise-to": "conditional",
  raise: "never",
  bet: "never",
};

export const WRAPPER_TERMINALS: Record<string, { topUpBefore: boolean; source: string }> = {
  "sit-out-next-hand": { topUpBefore: false, source: "launch._ignition_sitout_next_hand (net guard)" },
  "leave-table": { topUpBefore: false, source: "formats.leave / launch._maybe_stand_down" },
};

export type TerminalVerdict = {
  terminal: boolean;
  kind: string;
  why: string;
  finalStackKnown: boolean;
  details: Record<string, unknown>;
};

const V = (terminal: boolean, kind: string, why: string, finalStackKnown = false, details: Record<string, unknown> = {}): TerminalVerdict =>
  ({ terminal, kind, why, finalStackKnown, details });

function num(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  try {
    return pyFloat(x);
  } catch {
    return null;
  }
}

function seat(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  try {
    return pyInt(x);
  } catch {
    return null;
  }
}

type Hand = Record<string, any>;

export function streetActions(hand: Hand): any[] {
  const st = hand.street || (hand.currentNode || {}).street || "preflop";
  return (hand.actions || []).filter((a: any) => (a.street || "preflop") === st);
}

export type TableView = {
  hero: number | null;
  dealt: Set<number>;
  folded: Set<number | null>;
  allin: Set<number | null>;
  inHand: Set<number>;
  contestants: Set<number>;
  withChips: Set<number>;
  stacks: Map<number | null, number | null>;
};

export function tableView(hand: Hand): TableView {
  const hero = seat(hand.heroSeatId);
  const dealt = new Set<number>();
  for (const x of hand.liveSeats || []) {
    const s = seat(x);
    if (s !== null) dealt.add(s);
  }
  const acts: any[] = hand.actions || [];
  const folded = new Set(acts.filter((a) => a.type === "fold").map((a) => seat(a.seatId)));
  const allin = new Set(acts.filter((a) => a.type === "all-in").map((a) => seat(a.seatId)));
  const stacks = new Map<number | null, number | null>();
  // the live export carries Maps (int seat keys); a hand read back from JSON carries string keys
  const st = hand.stacks || {};
  for (const [k, v] of st instanceof Map ? st : Object.entries(st)) stacks.set(seat(k), num(v));
  for (const [s, v] of stacks) {
    if (s !== null && v !== null && v <= EPS_BB && dealt.has(s) && !folded.has(s)) allin.add(s);
  }
  const inHand = new Set([...dealt].filter((s) => !folded.has(s)));
  const contestants = new Set([...inHand].filter((s) => s !== hero));
  const withChips = new Set([...contestants].filter((s) => !allin.has(s)));
  return { hero, dealt, folded, allin, inHand, contestants, withChips, stacks };
}

/** Opponents with chips who must still act on THIS street once hero has acted now. null = an amount needed to
 *  place an action is missing (the caller must then treat the spot as not terminal). */
export function stillToActAfterHero(hand: Hand, view: TableView): Set<number> | null {
  const acts = streetActions(hand);
  const hero = view.hero;
  let top = 0.0;
  let lastAggrIdx: number | null = null;
  let aggressor: number | null = null;
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    const t = a.type;
    const amt = num(a.amount);
    if (t === "bet" || t === "raise") {
      lastAggrIdx = i;
      aggressor = seat(a.seatId);
      top = amt === null ? Infinity : Math.max(top, amt);
    } else if (t === "all-in") {
      if (amt === null) return null;
      if (amt > top + EPS_BB) {
        lastAggrIdx = i;
        aggressor = seat(a.seatId);
        top = amt;
      }
    } else if ((t === "post-sb" || t === "post-bb" || t === "post") && amt !== null) {
      top = Math.max(top, amt);
    }
  }
  const after = lastAggrIdx !== null ? acts.slice(lastAggrIdx + 1) : acts;
  const actedAfter = new Set(after.map((a: any) => seat(a.seatId)));
  const pending = new Set([...view.withChips].filter((s) => !actedAfter.has(s)));
  if (aggressor !== null) pending.delete(aggressor);
  if (hero !== null) pending.delete(hero);
  return pending;
}

/** Every seat (hero included) that still owes an action on the CURRENT street; null when an all-in this street
 *  could not be sized. */
export function seatsToAct(hand: Hand): Set<number> | null {
  const view = tableView(hand);
  const acts = streetActions(hand);
  const liveWithChips = new Set([...view.inHand].filter((s) => !view.allin.has(s)));
  let top = 0.0;
  let lastAggrIdx: number | null = null;
  let aggressor: number | null = null;
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    const t = a.type;
    const amt = num(a.amount);
    if (t === "bet" || t === "raise") {
      lastAggrIdx = i;
      aggressor = seat(a.seatId);
      top = amt === null ? Infinity : Math.max(top, amt);
    } else if (t === "all-in") {
      if (amt === null) return null;
      if (amt > top + EPS_BB) {
        lastAggrIdx = i;
        aggressor = seat(a.seatId);
        top = amt;
      }
    } else if ((t === "post-sb" || t === "post-bb" || t === "post") && amt !== null) {
      top = Math.max(top, amt);
    }
  }
  const after = lastAggrIdx !== null ? acts.slice(lastAggrIdx + 1) : acts;
  const actedAfter = new Set(after.map((a: any) => seat(a.seatId)));
  const pending = new Set([...liveWithChips].filter((s) => !actedAfter.has(s)));
  if (aggressor !== null) pending.delete(aggressor);
  return pending;
}

/** Is hero's part in this hand OVER although the hand is not? (the SHOWDOWN-PENDING window) */
export function heroDone(hand: Hand | null | undefined): TerminalVerdict {
  if (!hand || !Object.keys(hand).length) return V(false, "unknown", "no hand state");
  const view = tableView(hand);
  const hero = view.hero;
  if (hero === null || !view.inHand.has(hero)) return V(false, "unknown", "hero is not in the hand (folded or unknown)");
  if (!view.contestants.size) return V(false, "not-terminal", "no opponent left: the pot is hero's, the hand is over");
  if (view.allin.has(hero)) return V(true, "hero-all-in", "hero is all-in; the board runs out", false);
  if (!view.withChips.size) return V(true, "run-out", "every opponent is all-in; the board runs out", false);
  const street = hand.street || (hand.currentNode || {}).street || "preflop";
  if (street !== "river") return V(false, "not-terminal", `the ${street} is not the last street; hero may act again`);
  const pending = seatsToAct(hand);
  if (pending === null) return V(false, "not-terminal", "an all-in on the river could not be sized");
  if (pending.size) {
    const p = sortedNums(pending);
    return V(false, "not-terminal", `the river is still open: ${pyRepr(p)} to act`, false, { pending: p });
  }
  const acts = streetActions(hand);
  if (!acts.length) return V(false, "not-terminal", "the river has not been acted on");
  return V(true, "showdown-pending", "the river action is closed; the hands are being shown", false);
}

/** Is a CALL the most hero can put in right now — so a shove can only be made BY CALLING? True when the call
 *  takes hero's last chip (hero is covered), or when every opponent still in is already all-in (a raise would be
 *  called by nobody, and the client offers FOLD / CALL only). Hand 4920544353 (2026-09-25, KJo on K-high): the
 *  BTN jammed 21.6 into hero's 87.4 with the blinds folded, the strip read FOLD / CALL 21.6 BB, the answer was
 *  ALLIN — and there was nothing labelled ALL-IN or RAISE to press, so it was refused twice and then folded.
 *  CONSERVATIVE: anything unknown is `false` (the caller then refuses instead of calling). */
export function callIsMaxCommit(hand: Hand | null | undefined): { yes: boolean; why: string } {
  if (!hand || !Object.keys(hand).length) return { yes: false, why: "no hand state" };
  const view = tableView(hand);
  const hero = view.hero;
  if (hero === null || !view.inHand.has(hero)) return { yes: false, why: "hero is not in the hand" };
  if (!view.contestants.size) return { yes: false, why: "no opponent left in the hand" };
  const toCall = num((hand.currentNode || {}).toCall) || 0.0;
  if (toCall <= 0) return { yes: false, why: "nothing to call" };
  const behind = view.stacks.has(hero) ? view.stacks.get(hero)! : null;
  if (behind !== null && toCall >= behind - EPS_BB) {
    return { yes: true, why: `calling ${pyFloatStr(toCall)} puts hero's last ${pyFloatStr(behind)} in` };
  }
  if (!view.withChips.size) {
    return { yes: true, why: `every opponent still in is all-in (${pyRepr(sortedNums(view.contestants))}) — a call is the most that can go in` };
  }
  return { yes: false, why: behind === null ? "hero's stack is unknown"
    : `hero has ${pyFloatStr(behind)} behind against a ${pyFloatStr(toCall)} call and ${pyRepr(sortedNums(view.withChips))} still have chips` };
}

/** Does this relay plan end hero's decisions in this hand? */
export function isTerminal(plan: Record<string, any> | null | undefined, hand: Hand | null | undefined): TerminalVerdict {
  if (!plan || !Object.keys(plan).length) return V(false, "unknown", "no plan");
  const kind = String(plan.kind || "action").toLowerCase();
  const label = String(plan.label || plan.action || "").trim().toLowerCase();
  if (kind === "action" && (label === "fold" || label.startsWith("fold "))) {
    return V(true, "fold", "a fold ends hero's hand; stack behind is final", true);
  }
  if (kind === "action" && label === "all-in") return V(true, "shove", "hero is all-in; no further decision", false);
  if (!hand || !Object.keys(hand).length) return V(false, "unknown", "no hand state");
  const view = tableView(hand);
  const hero = view.hero;
  if (hero === null) return V(false, "unknown", "hero seat unknown");
  if (!view.contestants.size) return V(false, "unknown", "no opponent left in the hand — nothing to act on");
  const street = hand.street || (hand.currentNode || {}).street || "preflop";
  const node = hand.currentNode || {};
  const toCall = num(node.toCall) || 0.0;
  const behind = view.stacks.has(hero) ? view.stacks.get(hero)! : null;
  const committedMap = hand.committed || {};
  const committed = committedMap instanceof Map
    ? num(committedMap.get(hero)) || num(committedMap.get(String(hero))) || 0.0
    : num(committedMap[String(hero)]) || num(committedMap[hero as any]) || 0.0;
  const details: Record<string, unknown> = {
    street, toCall, behind, committed,
    contestants: sortedNums(view.contestants), withChips: sortedNums(view.withChips),
  };

  if (kind === "raise-to") {
    const amount = num(plan.amount);
    if (amount === null || behind === null) {
      return V(false, "not-terminal", "a sized raise; hero acts again unless it is a shove (size or stack unknown)", false, details);
    }
    if (amount >= committed + behind - EPS_BB) {
      return V(true, "shove", `raise to ${pyFloatStr(amount)} is hero's whole stack (${pyFloatStr(committed)} + ${pyFloatStr(behind)})`, false, details);
    }
    return V(false, "not-terminal", "a raise leaves hero with chips and opponents to act", false, details);
  }

  if (kind !== "action") return V(false, "unknown", `plan kind ${pyReprStr(kind)} not understood`, false, details);

  if (label === "call") {
    if (behind !== null && toCall >= behind - EPS_BB && toCall > 0) {
      return V(true, "all-in-call", `calling ${pyFloatStr(toCall)} puts hero's last ${pyFloatStr(behind)} in`, false, details);
    }
    if (!view.withChips.size) return V(true, "run-out", "every opponent is already all-in; the board runs out", false, details);
    if (street !== "river") return V(false, "not-terminal", `a ${street} call: hero acts again on the next street`, false, details);
    const pending = stillToActAfterHero(hand, view);
    if (pending === null) return V(false, "not-terminal", "an all-in on this street could not be sized; not provably closing", false, details);
    if (pending.size) {
      const p = sortedNums(pending);
      return V(false, "not-terminal", `seats still to act after the call: ${pyRepr(p)}`, false, { ...details, pending: p });
    }
    if (toCall <= 0) return V(false, "not-terminal", "nothing to call — this is a check", false, details);
    return V(true, "closing-river-call", "the river call closes the action; showdown follows", false, details);
  }

  if (label === "check") {
    if (street !== "river") return V(false, "not-terminal", `a ${street} check: the hand goes on`, false, details);
    if (toCall > 0) return V(false, "not-terminal", "hero owes chips — a check is not on offer", false, details);
    if (!view.withChips.size) return V(true, "run-out", "every opponent is already all-in; the board runs out", false, details);
    const pending = stillToActAfterHero(hand, view);
    if (pending === null) return V(false, "not-terminal", "an action on this street could not be sized; not provably closing", false, details);
    if (pending.size) {
      const p = sortedNums(pending);
      return V(false, "not-terminal", `seats still to act after the check: ${pyRepr(p)}`, false, { ...details, pending: p });
    }
    return V(true, "closing-river-check", "the river check closes the action; showdown follows", false, details);
  }

  if (label === "raise" || label === "bet") return V(false, "not-terminal", "an unsized raise/bet cannot be proven a shove", false, details);
  return V(false, "unknown", `plan label ${pyReprStr(label)} not understood`, false, details);
}
