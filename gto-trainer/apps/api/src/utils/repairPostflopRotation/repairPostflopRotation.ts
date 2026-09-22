/**
 * POSTFLOP CAPTURES THAT ARRIVE OUT OF ROTATION (2026-09-21).
 *
 * The vision layer sometimes reports a street's actions in the wrong order — hero's check landing before the
 * seat that actually acts first, or a phantom check inserted ahead of a bet the same seat then calls. Two
 * real examples from the 2026-09-18..20 sessions:
 *
 *   hand 4919211085  flop  BB>SB>UTG   (postflop order is SB>BB>UTG — hero's check jumped the queue)
 *   hand 4919213506  turn  HJ>BB>HJ    (BB acts first; HJ's leading check is noise before BB's bet)
 *
 * Downstream this is poison rather than noise. `deriveExploitSpot` reads OOP/IP off whoever acted first, so a
 * scrambled street silently reverses the seats; the chain then walks a tree with the wrong player out of
 * position. Before aiChain's rotation cross-check existed, that ANSWERED — from a scrambled tree.
 *
 * WHAT THIS REPAIRS, AND WHY IT IS SAFE: only CHECKS. A check commits no chips and cannot change any seat's
 * range, so moving one into its rotational slot, or dropping one that duplicates a seat already accounted
 * for, cannot change the game being solved. Anything involving money is left exactly as captured — a
 * misplaced bet is a capture we do not understand, and answering from a guess about it would be worse than
 * refusing (which aiChain's cross-check then does, loudly).
 *
 *   1. ALL-CHECK STREET     every action is a check -> sort into rotation order. Order is unobservable here.
 *   2. LEADING PHANTOM      the street opens with a check by a seat that is not first to act, and either the
 *                           seat that SHOULD have opened acts next or the checker acts again later -> drop
 *                           the check. The first form is the one that survives truncation, which matters
 *                           because hero is often the phantom checker and is the one on the clock.
 *
 * Postflop order is SB, BB, UTG, HJ, CO, BTN among the seats still in the hand — except heads-up, where the
 * dealer posts the small blind and acts LAST (routes/aiStudy.ts uses the same ["BB","SB"] special case).
 */
import type { ParsedHand, ParsedAction, Street } from "../../feed/parsePanelFeed/parsePanelFeed";
import { POSTFLOP_ORDER } from "../aiStudyLine/aiStudyLine";

const STREETS: Street[] = ["flop", "turn", "river"];

/** The seats still in the hand when `street` is dealt, in the order they act. */
export function rotationFor(hand: ParsedHand, street: Street): number[] {
  const upto = STREETS.indexOf(street);
  const earlier: Street[] = ["preflop", ...STREETS.slice(0, Math.max(0, upto))];
  const folded = new Set(
    hand.actions.filter((a) => a.type === "fold" && earlier.includes(a.street)).map((a) => a.seatId)
  );
  const seats = (hand.liveSeats?.length ? hand.liveSeats : Object.keys(hand.positions ?? {}).map(Number))
    .filter((s) => !folded.has(s) && hand.positions?.[s]);
  // HEADS-UP MEANS THE TABLE IS TWO-HANDED, NOT THAT TWO PLAYERS ARE LEFT (2026-09-21). At a full table the
  // small blind acts FIRST postflop, blind-versus-blind included; only when the table itself is heads-up does
  // the dealer post the small blind and act last. Keying this off the number of players still in the hand
  // inverted every blind-vs-blind pot — and then the phantom-check rule below "repaired" the SB's perfectly
  // good check out of the line (hand 4919480043).
  const dealt = Object.keys(hand.positions ?? {}).length;
  const order = dealt === 2 ? ["BB", "SB", "BTN"] : POSTFLOP_ORDER;
  const rank = (s: number) => {
    const i = order.indexOf((hand.positions?.[s] ?? "").toUpperCase());
    return i < 0 ? 99 : i;
  };
  return [...seats].sort((a, b) => rank(a) - rank(b));
}

export interface RepairNote {
  street: Street;
  kind: "reordered-checks" | "dropped-phantom-check";
  detail: string;
}

/**
 * Return the hand with repairable postflop rotation errors fixed, plus a note per repair. The hand is
 * returned unchanged (same object) when there is nothing to repair, so the normal path costs one scan.
 */
export function repairPostflopRotation(hand: ParsedHand): { hand: ParsedHand; notes: RepairNote[] } {
  const notes: RepairNote[] = [];
  const pos = (s: number) => (hand.positions?.[s] ?? `seat${s}`).toUpperCase();
  let actions = hand.actions;

  for (const street of STREETS) {
    const idx = actions.map((a, i) => ({ a, i })).filter((x) => x.a.street === street);
    if (idx.length < 2) continue;
    const rot = rotationFor(hand, street);
    if (rot.length < 2) continue;
    const firstShouldBe = rot[0]!;
    const acts = idx.map((x) => x.a);

    // 1. an all-check street carries no information in its order — sort it into rotation
    if (acts.every((a) => a.type === "check")) {
      const rank = (s: number) => { const i = rot.indexOf(s); return i < 0 ? 99 : i; };
      const sorted = [...acts].sort((a, b) => rank(a.seatId) - rank(b.seatId));
      if (sorted.some((a, k) => a !== acts[k])) {
        const next = actions.slice();
        idx.forEach((x, k) => { next[x.i] = sorted[k]!; });
        actions = next;
        notes.push({ street, kind: "reordered-checks",
          detail: `${acts.map((a) => pos(a.seatId)).join(">")} -> ${sorted.map((a) => pos(a.seatId)).join(">")}` });
      }
      continue;
    }

    // 2. a street that OPENS with a check by someone who is not first to act, where the seat that should
    //    have opened acts next (or the checker acts again later): the check happened before the street's
    //    first actor had acted, so it is noise. The "acts next" form is the one that survives truncation —
    //    at hero's own decision the checker's later action has not been captured yet (hand 4919213506's
    //    turn is HJ-check > BB-bet > HJ-call, and hero IS that HJ).
    const lead = acts[0]!;
    const second = acts[1];
    if (lead.type === "check" && lead.seatId !== firstShouldBe &&
        (second?.seatId === firstShouldBe || acts.slice(1).some((a) => a.seatId === lead.seatId))) {
      const at = idx[0]!.i;
      actions = actions.filter((_, i) => i !== at);
      notes.push({ street, kind: "dropped-phantom-check",
        detail: `${pos(lead.seatId)} checked before ${pos(firstShouldBe)} was to act, and acts again later` });
    }
  }

  return notes.length ? { hand: { ...hand, actions }, notes } : { hand, notes };
}

/**
 * Faults that make a capture internally impossible, as opposed to merely misordered. These are NOT
 * repairable — the wrapper lost track of the hand — and the point of naming them is that the solver's own
 * message ("preflop betting didn't close (missed action?)") sends you hunting for a missing action when the
 * real problem is that the capture contradicts itself. Two live examples from 2026-09-20:
 *
 *   hand 4919433077  flop actions appear AFTER turn actions, and SB checks, then calls, then bets in a row
 *   hand 4919432644  SB posts the BIG blind
 *
 * Report, do not repair: a spot built from a self-contradicting capture has no right answer.
 */
export function captureFaults(hand: ParsedHand): string[] {
  const faults: string[] = [];
  const pos = (s: number) => (hand.positions?.[s] ?? `seat${s}`).toUpperCase();
  const order = ["preflop", ...STREETS];

  // a street that reopens after a later one has already acted
  let high = 0;
  for (const a of hand.actions) {
    const i = order.indexOf(a.street);
    if (i < 0) continue;
    if (i < high) { faults.push(`${a.street} actions appear after ${order[high]} actions`); break; }
    high = Math.max(high, i);
  }

  // the same seat acting twice in a row on one street, with no one between. PREFLOP counts too (blind posts
  // excluded — they are not actions): hand 4919432731 has the BTN bet-then-check in consecutive slots, which
  // is the session-start corruption that surfaces downstream as the nonsense line "F-F-F-F-F".
  for (const street of ["preflop", ...STREETS] as Street[]) {
    const acts = hand.actions.filter((a) => a.street === street && a.type !== "post-sb" && a.type !== "post-bb");
    for (let i = 1; i < acts.length; i++) {
      // a seat CAN act twice on a street, but never twice running — someone has to act between, or there was
      // nothing to respond to. hand 4919432609's flop is BTN-bet-11 then BTN-fold, which no table produces.
      if (acts[i]!.seatId !== acts[i - 1]!.seatId) continue;
      faults.push(`${pos(acts[i]!.seatId)} acts twice in a row on the ${street} (${acts[i - 1]!.type} then ${acts[i]!.type})`);
      break;
    }
  }

  // a seat cannot reach a postflop street without having acted preflop. hand 4919432609 is on the flop with
  // nothing preflop but the two blind posts, so whatever the BTN did to get there was never captured.
  if (hand.currentNode?.street && hand.currentNode.street !== "preflop") {
    const acted = new Set(hand.actions.filter((a) => a.street === "preflop").map((a) => a.seatId));
    const missing = (hand.liveSeats ?? []).filter((s) => hand.positions?.[s] && !acted.has(s));
    if (missing.length) {
      faults.push(`${missing.map(pos).join(", ")} reached the ${hand.currentNode.street} with no preflop action captured`);
    }
  }

  // only the BIG BLIND can check preflop, and only while nobody has raised — everyone else owes the blind and
  // must fold, call or raise. hand 4919432731 has the BTN checking preflop, which is the same session-start
  // corruption seen from another angle.
  for (const a of hand.actions) {
    if (a.street !== "preflop" || a.type !== "check") continue;
    if (pos(a.seatId) !== "BB") { faults.push(`${pos(a.seatId)} checked preflop, which only the big blind can do`); break; }
  }

  // blinds that do not match the seat that posted them
  for (const a of hand.actions) {
    if (a.type === "post-sb" && pos(a.seatId) !== "SB") faults.push(`${pos(a.seatId)} posted the small blind`);
    if (a.type === "post-bb" && pos(a.seatId) !== "BB") faults.push(`${pos(a.seatId)} posted the big blind`);
  }

  return [...new Set(faults)];
}
