import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE SEATS THAT WERE DEALT (2026-09-25, round 2 of the input-mutation harness, `undealt-seat`). The wrapper labels
 * every OCCUPIED seat, sitting-out ones included (hand 937's BTN, seat 3: no start stack, never acted), so the
 * positions map can hold a seat that was never dealt a hand. e5d4cdd8 taught the AI tree (gtowAiPreflop.shapeOf) to
 * drop such a seat; everything else still counted labels: the rake cap (by players DEALT: $3 at 4-5, $4 at 6+) was
 * one player high, and a three-handed table with a sitting-out label routed to the 6-max charts as a four-handed one
 * although three-handed is the AI piece's by design.
 *
 * A labelled seat is undealt only when BOTH say so: it is missing from `liveSeats` (the wrapper's dealt list; other
 * sources send only the unfolded seats, so a missing seat alone proves nothing) AND it has no action this hand. Hero
 * is always dealt. Returns seat id → position label (upper-cased) for the dealt seats.
 */
export function dealtSeats(hand: ParsedHand, heroPos?: string | null): Map<number, string> {
  const live = new Set(hand.liveSeats ?? []);
  const acted = new Set(hand.actions.map((a) => (a.hero ? hand.heroSeatId : a.seatId)));
  const out = new Map<number, string>();
  for (const [k, p] of Object.entries(hand.positions ?? {})) {
    const s = Number(k);
    const undealt = live.size > 0 && !live.has(s) && !acted.has(s) && s !== hand.heroSeatId;
    if (!undealt) out.set(s, String(p).toUpperCase());
  }
  if (!out.has(hand.heroSeatId) && heroPos) out.set(hand.heroSeatId, heroPos.toUpperCase());
  return out;
}

/**
 * THE SEATS STILL IN THE HAND (round 2, harness stack-behind check): dealt, not folded — and, once the preflop round
 * was played, not a non-blind seat with no action at all: that is a fold the tap lost (captureFaults' own rule for
 * missed folds; a blind is in by his post, captured or not). Used for the effective stack (hrc6max.dealtEffective)
 * and the postflop rotation (repairPostflopRotation.rotationFor).
 */
export function seatsInHand(hand: ParsedHand, heroPos?: string | null): Set<number> {
  const seatOf = (a: ParsedHand["actions"][number]) => (a.hero ? hand.heroSeatId : a.seatId);
  const folded = new Set(hand.actions.filter((a) => a.type === "fold").map(seatOf));
  const out = new Set<number>();
  for (const [s, pos] of dealtSeats(hand, heroPos)) {
    if (folded.has(s)) continue;
    if (s !== hand.heroSeatId && lostPreflopFold(hand, s, pos)) continue;
    out.add(s);
  }
  return out;
}

/**
 * A PREFLOP FOLD THE TAP LOST (round 2): the preflop round was played, and this seat took no voluntary preflop action
 * and has done nothing since — every seat must act preflop, so it folded and the capture never saw it. A blind's post
 * is not a decision (fresh sweep seeds 15564/17644: the SB's lost fold, his post counted as "acted"); only the BB of an
 * UNRAISED pot is exempt — his free check may be the action that was lost, and he is still in.
 */
export function lostPreflopFold(hand: ParsedHand, seat: number, pos: string): boolean {
  const seatOf = (a: ParsedHand["actions"][number]) => (a.hero ? hand.heroSeatId : a.seatId);
  const voluntary = (a: ParsedHand["actions"][number]) => a.type !== "post-sb" && a.type !== "post-bb";
  const pre = hand.actions.filter((a) => a.street === "preflop" && voluntary(a));
  if (!pre.length) return false;
  if (hand.actions.some((a) => seatOf(a) === seat && voluntary(a))) return false;
  const raised = pre.some((a) => a.type === "raise" || a.type === "bet" || (a.type === "all-in" && Number(a.amount ?? 0) > 1));
  return !(/^BB$/i.test(pos) && !raised);
}

/**
 * IGNITION'S DEAD BUTTON, RENAMED FROM THE SEATS DEALT (2026-10-04, hands 4922299303 / 4922296152 of 2026-10-03).
 * When the player due the button has left or sits out, Ignition deals with the button on that empty seat. The wrapper
 * (before 2026-10-04) counted the dealer seat anyway and labelled it BTN, so every dealt non-blind seat carried the
 * name one seat EARLY: hero on the real last seat read CO, and the 6-max chart walk — padding the "BTN" as a fold
 * behind him — answered a CO node that assumes a live button still to act (4922296152: a four-handed button open with
 * A♠6♥ folded 99.6%, path "clean"). A missing seat that acts BEFORE hero is a fold, but a missing seat AFTER him is not.
 * With hero in the blinds the villains were one seat early too (a button open read as a CO open).
 *
 * The signature is exact: the seat labelled BTN was not dealt (dealtSeats: missing from liveSeats and no action). The
 * rule is Brady's, and wider than the button (2026-10-04): ANY undealt seat between hero and the button shifts hero
 * later — so a labelled non-blind seat that was not dealt, whichever (a source that labels a sitting-out HJ), renames
 * the dealt seats the same way. (The Ignition wrapper never labelled one: positionsAll orders the dealt seats plus the
 * dealer, so only the dealer seat could be undealt — 141 hands in four days with a non-dealer seat out between hero and
 * a live button, 0 mislabelled.) The dealt seats are then named among the dealt — the blinds keep their names, the other dealt seats, in table order, take
 * the LATEST names (five dealt: SB/BB/HJ/CO/BTN, the chart walk padding UTG as the fold exactly as at any five-handed
 * table; four: SB/BB/CO/BTN; three: SB/BB/BTN; two: SB/BB) — the names the fixed wrapper sends (ignition/hand.ts
 * buttonOrder). A dead small blind beside it keeps its BB-first names (the same rule: the blinds keep theirs). The
 * undealt seat's label is dropped. Applied by normalizeHand, so live hands from a wrapper still on the old rule and every
 * archived hand replay with the fix; a hand that is not the signature (or uses a 9-max vocabulary) is returned as is.
 */
const NON_BLIND_6 = ["UTG", "HJ", "CO", "BTN"];
const asSeatName = (p: string): string => { const u = String(p).trim().toUpperCase(); return u === "BU" || u === "D" || u === "DEALER" ? "BTN" : u; };
export function relabelUndealt(hand: ParsedHand): { hand: ParsedHand; note: string | null } {
  const positions = hand.positions ?? {};
  const dealt = dealtSeats(hand);
  const labelled = Object.keys(positions).map(Number);
  const undealt = labelled.filter((s) => !dealt.has(s));
  if (!undealt.length || !undealt.every((s) => NON_BLIND_6.includes(asSeatName(positions[s]!)))) return { hand, note: null };
  const deadButton = undealt.some((s) => asSeatName(positions[s]!) === "BTN");
  const kept = labelled.filter((s) => dealt.has(s));
  const names = new Map(kept.map((s) => [s, asSeatName(positions[s]!)]));
  if ([...names.values()].some((p) => p !== "SB" && p !== "BB" && !NON_BLIND_6.includes(p))) return { hand, note: null };
  const fixed: Record<number, string> = {};
  if (kept.length === 2 && [...names.values()].includes("BB")) {
    // heads-up: the big blind and the small blind (the dealer posts it — here the button was dead, so the other seat)
    for (const s of kept) fixed[s] = names.get(s) === "BB" ? "BB" : "SB";
  } else {
    const others = kept.filter((s) => names.get(s) !== "SB" && names.get(s) !== "BB")
      .sort((a, b) => NON_BLIND_6.indexOf(names.get(a)!) - NON_BLIND_6.indexOf(names.get(b)!));
    const late = NON_BLIND_6.slice(NON_BLIND_6.length - others.length);
    for (const s of kept) fixed[s] = names.get(s)!;
    others.forEach((s, i) => { fixed[s] = late[i]!; });
  }
  const changed = kept.filter((s) => fixed[s] !== names.get(s)).map((s) => `seat ${s} ${positions[s]}→${fixed[s]}`);
  // an undealt seat no dealt seat's name depends on (one that acts before every non-blind seat dealt) changes nothing
  if (!deadButton && !changed.length) return { hand, note: null };
  const what = undealt.map((s) => `seat ${s} (${positions[s]})`).join(", ");
  const note = (deadButton ? `DEAD BUTTON: the button seat — ${what} — was not dealt (it sat out or was empty), so `
    : `SEAT NOT DEALT: ${what} was labelled but not dealt, so `) +
    `the ${kept.length} dealt seats were named among the dealt${changed.length ? ` — ${changed.join(", ")}` : ""}.`;
  return { hand: { ...hand, positions: fixed, seatRelabel: { from: { ...positions }, note } }, note };
}

/**
 * THE NAMES THE SEATS DEALT GIVE (2026-10-04, the check on hero's label): the table's own geometry, independent of the
 * labels the hand carries — the dealt seats clockwise from the first one after the button seat (the roster's `dealer`,
 * which may be a seat not dealt), named as the wrapper names them (ignition/hand.ts positionsAll): SB, BB, the middle
 * seats on the latest of UTG/HJ/CO, BTN last; with no small blind posted and the big blind on the first seat, BB first
 * (a dead small blind); heads-up the small blind is the seat that posted it (else the button). null when the roster or
 * the dealt list cannot place it (no button seat, fewer than two or more than six dealt).
 */
export function namesFromRoster(hand: ParsedHand): Map<number, string> | null {
  const r = hand.roster;
  if (!r || r.dealer == null || !Array.isArray(r.dealt)) return null;
  const live = [...new Set(r.dealt)].sort((a, b) => a - b);
  if (live.length < 2 || live.length > 6) return null;
  const btn = r.dealer;
  let order: number[];
  if (live.includes(btn)) { const i = live.indexOf(btn); order = [...live.slice(i + 1), ...live.slice(0, i + 1)]; }
  else { const k = live.findIndex((s) => s > btn); const i = k < 0 ? 0 : k; order = [...live.slice(i), ...live.slice(0, i)]; }
  const seatOf = (a: ParsedHand["actions"][number]) => (a.hero ? hand.heroSeatId : a.seatId);
  const sbPost = hand.actions.find((a) => a.type === "post-sb");
  const bbPost = hand.actions.find((a) => a.type === "post-bb");
  const out = new Map<number, string>();
  if (live.length === 2) {
    const sb = sbPost && order.includes(seatOf(sbPost)) ? seatOf(sbPost)
      : bbPost && order.includes(seatOf(bbPost)) ? order.find((s) => s !== seatOf(bbPost))!
        : live.includes(btn) ? btn : order[0]!;
    for (const s of order) out.set(s, s === sb ? "SB" : "BB");
    return out;
  }
  const n = order.length;
  const deadSb = !sbPost && !!bbPost && seatOf(bbPost) === order[0];
  if (deadSb && n > 5) return null;   // six dealt with no small blind is a nine-seat table: not this vocabulary
  const names = deadSb
    ? ["BB", ...["UTG", "HJ", "CO"].slice(3 - (n - 2)), "BTN"]
    : n === 3 ? ["SB", "BB", "BTN"] : ["SB", "BB", ...["UTG", "HJ", "CO"].slice(3 - (n - 3)), "BTN"];
  order.forEach((s, i) => out.set(s, names[i]!));
  return out;
}

/** How many players were dealt in: the labelled seats minus the ones that were not dealt, hero included. */
export const dealtCount = (hand: ParsedHand, heroPos?: string | null): number =>
  dealtSeats(hand, heroPos).size + (dealtSeats(hand, heroPos).has(hand.heroSeatId) ? 0 : 1);
