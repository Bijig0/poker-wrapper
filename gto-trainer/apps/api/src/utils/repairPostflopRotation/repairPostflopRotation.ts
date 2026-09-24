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

/** Seat geometry clockwise from the small blind in gto-trainer's full vocabulary (6-max labels plus the 9-max
 *  ones: UTG1/UTG2/LJ sit between UTG and HJ). Preflop action runs this way round from the seat after the BB. */
const CLOCKWISE_RING = ["SB", "BB", "UTG", "UTG1", "UTG2", "LJ", "HJ", "CO", "BTN"];

/** The seats still in the hand when `street` is dealt, in the order they act. */
export function rotationFor(hand: ParsedHand, street: Street): number[] {
  const upto = STREETS.indexOf(street);
  const earlier: Street[] = ["preflop", ...STREETS.slice(0, Math.max(0, upto))];
  const folded = new Set(
    hand.actions.filter((a) => a.type === "fold" && earlier.includes(a.street)).map((a) => a.seatId)
  );
  // A FOLD THE TAP LOST (round 2, harness missed-fold seeds 213/232): once the preflop round was played, a seat with no
  // action at all — no blind, nothing preflop, nothing since — folded preflop and the capture never saw it
  // (captureFaults' own rule for missed folds). Counted as live it made the SEAT BEFORE IT look out of turn, and the
  // phantom-check rule below dropped hero's own check.
  const acted = new Set(hand.actions.map((a) => (a.hero ? hand.heroSeatId : a.seatId)));
  const preflopPlayed = hand.actions.some((a) => a.street === "preflop" && a.type !== "post-sb" && a.type !== "post-bb");
  // (a blind is in the pot by his post, captured or not — only the seats with nothing in are judged)
  const blind = (s: number) => /^(SB|BB)$/i.test(String(hand.positions?.[s] ?? ""));
  const seats = (hand.liveSeats?.length ? hand.liveSeats : Object.keys(hand.positions ?? {}).map(Number))
    .filter((s) => !folded.has(s) && hand.positions?.[s] && (!preflopPlayed || acted.has(s) || blind(s)));
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
 * And two more from the 2026-09-23 archive sweep (capture-faults-rules batch, gap PF-04):
 *
 *   dbId 557 / 4919432519  CO folds, then the SB bets — UTG, HJ and BTN never acted (preflop out of rotation)
 *   dbId 583 / 4919432947  the SB folds before anyone has acted, then the BTN raises (same)
 *   dbId 688 / 4919661065  seats 4 and 5 fold and raise preflop with NO position label; the map says two seats
 *                          are dealt, so the answer came from a HEADS-UP tree with the folds attributed to the
 *                          wrong seats (13 of 707 archived hands carry an unlabelled actor)
 *
 * Report, do not repair: a spot built from a self-contradicting capture has no right answer.
 */
export function captureFaults(hand: ParsedHand): string[] {
  const faults: string[] = [];
  const pos = (s: number) => (hand.positions?.[s] ?? `seat${s}`).toUpperCase();
  const order = ["preflop", ...STREETS];

  // UNLABELLED ACTOR (PF-04, dbId 688). A seat that folds, calls, bets or raises but has no entry in the position
  // map is a seat the wrapper does not know is dealt. Every builder downstream sizes the tree from the label count
  // and consumes the action at whatever seat its walk is on, so the hand is silently solved for a smaller table
  // with the actions attributed to the wrong seats. No exemption: hero's own row without a label is just as
  // unreadable. Blind posts are left to the post rules below ("SEAT4 posted the small blind").
  for (const a of hand.actions) {
    if (a.type === "post-sb" || a.type === "post-bb") continue;
    if (hand.positions?.[a.seatId]) continue;
    faults.push(`seat ${a.seatId} acted on the ${a.street} but has no position label`);
  }
  // …and a POSTED-IN player (round 2, harness seed 199 [unlabelled-seat + post-in]): normalizeHand folds his post out
  // of the line (utils/foldPostIns), so until he acts the rule above never sees him — a live player's chips on no seat
  for (const p of hand.postIns ?? []) {
    const s = p.hero ? hand.heroSeatId : p.seatId;
    if (hand.positions?.[s] || hand.actions.some((a) => a.seatId === s && a.type !== "post-sb" && a.type !== "post-bb")) continue;
    faults.push(`seat ${s} posted in on the preflop but has no position label`);
  }

  // PREFLOP OUT OF ROTATION (dbId 557 / 583). Voluntary preflop action starts with the seat after the big blind and
  // goes clockwise around the seats dealt in, coming back around after a raise; a seat that has folded or is all-in
  // is skipped, and nobody may act while a seat between the previous actor and them is still owed an action.
  // Heads-up the SB/BTN is the seat after the BB, so it acts first; a dead-small-blind hand (relabelled by
  // repairDeadSmallBlind: BB, mids, BTN, no SB) anchors on its BB the same way. The ring is the labelled seats
  // that are also in liveSeats — 12 archived hands label a button that was dealt out (hand 4: UTG, HJ, CO, SB fold
  // and the BTN never acts), and anchoring the rotation on a seat with no cards would flag a perfectly good hand.
  // A round that has closed is not modelled: a stray action after closure is still walked clockwise, which can
  // only miss a fault, never invent one. Money is never moved — report, and let the solve refuse.
  //
  // MISSED AND LATE FOLDS ARE NOT FAULTS (the first sweep of this rule flagged 113 of 707 archived hands, most
  // of them hands the pipeline answers correctly today). The tap misses folds and the DOM backfill discovers
  // them late, so a seat that "should" have acted and never does, or acts LATER with a fold, is a fold the
  // capture lost or filed late — a fold commits nothing, the token builders pad it, and the game solved is the
  // same (dbId 417: UTG's fold never captured; 283: UTG's fold filed last). What cannot happen is a skipped
  // seat that later puts chips in or checks: the action order then contradicts the chips (dbId 583: the SB folds
  // "before" the BTN raise it must have been facing). That, and a seat acting after it folded, is what is flagged.
  {
    const laterVoluntary = new Map<number, number>();   // seat -> index of its last non-fold preflop action
    hand.actions.forEach((a, i) => {
      if (a.street === "preflop" && a.type !== "post-sb" && a.type !== "post-bb" && a.type !== "fold") laterVoluntary.set(a.seatId, i);
    });
    const live = hand.liveSeats?.length ? new Set(hand.liveSeats) : null;
    const ring = Object.keys(hand.positions ?? {}).map(Number)
      .filter((s) => hand.positions?.[s] && (!live || live.has(s)))
      .sort((a, b) => CLOCKWISE_RING.indexOf(pos(a)) - CLOCKWISE_RING.indexOf(pos(b)));
    // action opens after the last blind: the BB, or the SB when no BB is labelled (a capture the post rules flag)
    const bb = ring.findIndex((s) => pos(s) === "BB");
    const anchor = bb >= 0 ? bb : ring.findIndex((s) => pos(s) === "SB");
    if (ring.length >= 2 && anchor >= 0 && ring.every((s) => CLOCKWISE_RING.includes(pos(s)))) {
      const out = new Map<number, string>();   // seat -> how it left the rotation (fold / all-in)
      let cursor = (anchor + 1) % ring.length;
      let idx = -1;
      for (const a of hand.actions) {
        idx++;
        if (a.street !== "preflop" || a.type === "post-sb" || a.type === "post-bb") continue;
        if (!ring.includes(a.seatId)) continue;   // unlabelled (reported above) or dealt out: not part of the rotation
        if (out.has(a.seatId)) {
          faults.push(`${pos(a.seatId)} acted preflop after ${out.get(a.seatId) === "fold" ? "folding" : "going all-in"} (preflop out of rotation)`);
          break;
        }
        const skipped: number[] = [];
        for (let steps = 0; ring[cursor] !== a.seatId && steps < ring.length; steps++) {
          if (!out.has(ring[cursor]!)) skipped.push(ring[cursor]!);
          cursor = (cursor + 1) % ring.length;
        }
        // only a skipped seat that later puts chips in (or checks) proves the order wrong; a seat that never acts
        // or only folds later is a fold the capture missed or filed late — see the note above
        const contradicted = skipped.filter((s) => (laterVoluntary.get(s) ?? -1) > idx);
        if (contradicted.length) {
          faults.push(`${pos(a.seatId)} acted before ${contradicted.map(pos).join(", ")} ${contradicted.length > 1 ? "were" : "was"} to act (preflop out of rotation)`);
          break;
        }
        if (a.type === "fold" || a.type === "all-in") out.set(a.seatId, a.type);
        cursor = (cursor + 1) % ring.length;
      }
    }
  }

  // PREFLOP CHIPS ARE CALLS AND RAISES, NEVER A BET (2026-09-23). The blinds open the betting, so a preflop "bet" is
  // a chip movement the reader could not place — every one of the 26 archived hands with one (hands.db 546-591)
  // comes from the 2026-09-20 two-wrappers-on-one-table socket mixing, and no other session has any.
  for (const a of hand.actions) {
    if (a.street === "preflop" && a.type === "bet") {
      faults.push(`${pos(a.seatId)} bet preflop — preflop chips are calls or raises, so this capture merged or misread an action`);
      break;
    }
  }

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
  // …but only a seat that PLAYS ON proves it (2026-09-25, harness `missed-fold`: 76 of 807 decisions refused). A dealt
  // seat with no preflop action that never appears again is a fold the tap missed — the comment on the rotation rule
  // above says so, and the token builders pad it — yet this rule refused every flop, turn and river of such a hand.
  // A silent seat whose chips ARE in the pot is lostActionFaults' business (the pot ledger), not this rule's.
  if (hand.currentNode?.street && hand.currentNode.street !== "preflop") {
    const acted = new Set(hand.actions.filter((a) => a.street === "preflop").map((a) => a.seatId));
    const playsOn = new Set(hand.actions.filter((a) => a.street !== "preflop").map((a) => a.seatId));
    const missing = (hand.liveSeats ?? []).filter((s) => hand.positions?.[s] && !acted.has(s) && playsOn.has(s));
    if (missing.length) {
      faults.push(`${missing.map(pos).join(", ")} reached the ${hand.currentNode.street} with no preflop action captured`);
    }
  }

  faults.push(...lostActionFaults(hand));

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

  // THE LINE MUST PRICE HERO'S DECISION (2026-09-24, CoinPoker hand 140706500001). Postflop, hero can only owe
  // chips if someone bet, raised or went all-in on this street — so a table that says hero faces a bet, over a
  // captured street with no villain aggression on it, is a line missing that bet. That hand's reader dropped the
  // villain's Pot-button bet: the chain walked a line where hero was first to act, and answered "Check" facing 21bb.
  // Measured over every logged postflop decision (answers.sqlite, 155 matched): 11 fires, all captures already
  // refused for other reasons or this hand — none on a decision that had been answered right.
  const node = hand.currentNode;
  const street = node?.street as Street | undefined;
  if (node?.toActIsHero && street && STREETS.includes(street)) {
    const onStreet = hand.actions.filter((a) => a.street === street);
    const owed = Number(node.toCall) || 0;
    const aggression = onStreet.some((a) => !a.hero && a.seatId !== hand.heroSeatId && ["bet", "raise", "all-in"].includes(a.type));
    if (owed > 0.01 && !aggression) {
      faults.push(`the table has hero facing ${owed}bb on the ${street}, but no bet or raise on the ${street} was captured — the line is missing it`);
    }

    // WHO ACTS FIRST IS A FACT OF THE SEATING, NOT OF THE CAPTURE. Heads-up postflop, the out-of-position seat
    // acts first on every street (the BB on a two-handed table, where the dealer posts the small blind). When
    // hero sits in position and is to act, the villain has acted on this street — if the capture has nothing
    // from them, it lost the action, and every downstream builder then takes the first action it sees (none)
    // as "hero is out of position" and solves hero's spot from the villain's seat. A missed CHECK is the case
    // the price rule above cannot see (nothing to call). Same 193-decision sweep: 11 fires, the only one that
    // had been answered is the hand above.
    const order = rotationFor(hand, street);
    if (order.length === 2 && order.includes(hand.heroSeatId) && order[1] === hand.heroSeatId) {
      const villain = order[0]!;
      if (!onStreet.some((a) => a.seatId === villain)) {
        faults.push(`${pos(villain)} acts first on the ${street} heads-up, but no ${street} action of theirs was captured before hero's decision`);
      }
    }
  }

  return [...new Set(faults)];
}

/**
 * A VILLAIN'S CALL THE CAPTURE LOST (2026-09-25, mutation harness `dropped-call`: 95 answers in a 300-seed sweep came
 * from a line with a caller missing). A lost call reads as a fold — every token builder pads a silent seat with "F" —
 * so the answer comes from a spot that never happened: a heads-up pot that was three-way, a caller's range gone from
 * the flop. The chips do not lie, so two ledger checks, each on evidence a live export really carries:
 *
 *   1. THIS ROUND'S CHIPS. `committed` is the table's own chip count for the round being played (Ignition: the WS
 *      ledger, updated in the same handler that records the action — a WS money message the dedupe drops, or the
 *      ghost guard, moves the chips and loses the action; CoinPoker: the log's street bets, where an untyped action
 *      moves chips with no row). A seat with more chips in front of it than its captured actions put there lost an
 *      action — folded seats included: a call lost before a fold turns "open, call, 3-bet" into "open, fold, 3-bet",
 *      and the 3-bettor's node is another one (harness seed 152). A new player's posted blind
 *      (Ignition btn 8, which the reader records in the feed but not as an action) looks the same — 1bb in and no
 *      action — and is refused too: the line would read a live seat as folded (archive: 2 of 888 hands, rows 292/690).
 *   2. A ROUND THAT NEVER CLOSED FOR A SEAT THAT PLAYS ON. A seat that acts on a later street was in the pot when the
 *      earlier round closed, so it had matched that round's top bet or was all-in. A seat that acts later with less in
 *      than the top of an earlier round lost its call (archive: rows 451 / 489 / 538, the BB's call of a raise missing
 *      and the BB betting the flop). A seat that is short and has NOT acted since may have folded without the fold
 *      being captured — the tap misses folds, the token builders pad them — so that is not flagged.
 * Tolerance 0.05bb: every amount is the same cents on both sides, rounded to 0.01bb.
 */
export function lostActionFaults(hand: ParsedHand): string[] {
  const faults: string[] = [];
  const pos = (s: number) => (hand.positions?.[s] ?? `seat${s}`).toUpperCase();
  const order = ["preflop", ...STREETS] as string[];
  const street = String(hand.currentNode?.street ?? hand.street ?? "preflop");
  const seatOf = (a: ParsedAction) => (a.hero ? hand.heroSeatId : a.seatId);
  const per = new Map<string, Map<number, number>>();
  for (const a of hand.actions) {
    const m = per.get(a.street) ?? new Map<number, number>();
    per.set(a.street, m);
    const amt = Number(a.amount ?? 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const s = seatOf(a);
    if (a.type === "call") m.set(s, (m.get(s) ?? 0) + amt);
    else if (["post-sb", "post-bb", "raise", "bet", "all-in"].includes(a.type)) m.set(s, Math.max(m.get(s) ?? 0, amt));
  }
  // A POSTED-IN PLAYER'S POST IS CAPTURED (2026-09-25, round 2, harness `post-in`): normalizeHand carries a post on the
  // poster's own next action (utils/foldPostIns), so a poster who has not acted yet — or who folded — holds chips no
  // action carries. They are the post, captured by the wrapper: counted here, not refused as a lost action.
  for (const p of hand.postIns ?? []) {
    if (p.readAs !== "pending" && p.readAs !== "fold") continue;
    const m = per.get("preflop") ?? new Map<number, number>();
    per.set("preflop", m);
    const s = p.hero ? hand.heroSeatId : p.seatId;
    m.set(s, Math.max(m.get(s) ?? 0, Number(p.amount) || 0));
  }
  const folded = new Set(hand.actions.filter((a) => a.type === "fold").map(seatOf));
  const allIn = new Set(hand.actions.filter((a) => a.type === "all-in").map(seatOf));
  const r2 = (x: number) => Math.round(x * 100) / 100;

  // 1. this round's chips against this round's captured actions
  const cur = per.get(street) ?? new Map<number, number>();
  for (const [k, v] of Object.entries(hand.committed ?? {})) {
    const s = Number(k), chips = Number(v);
    if (!Number.isFinite(chips)) continue;
    const captured = cur.get(s) ?? 0;
    if (chips - captured > 0.05) {
      const reads = folded.has(s) ? `folding ${captured > 0 ? "after putting in less" : "without ever putting chips in"}` : captured > 0 ? "short" : "folded";
      faults.push(`${pos(s)} has ${r2(chips)}bb in front of them on the ${street} but the captured ${street} actions put in ${r2(captured)}bb — an action of theirs (a call, a limp, or a posted blind) was lost, and the line reads them as ${reads}`);
    }
  }

  // 2. a seat that acts on a later street with an earlier round it never matched
  const lastStreetOf = new Map<number, number>();
  for (const a of hand.actions) {
    const i = order.indexOf(a.street);
    if (i < 0 || a.type === "post-sb" || a.type === "post-bb") continue;
    lastStreetOf.set(seatOf(a), Math.max(lastStreetOf.get(seatOf(a)) ?? -1, i));
  }
  for (const [s, last] of lastStreetOf) {
    if (folded.has(s) || allIn.has(s)) continue;
    for (let i = 0; i < last; i++) {
      const m = per.get(order[i]!);
      if (!m) continue;
      const level = Math.max(0, ...m.values());
      const mine = m.get(s) ?? 0;
      if (level - mine > 0.05) {
        faults.push(`${pos(s)} acts on the ${order[last]} but put ${r2(mine)}bb into a ${order[i]} round that went to ${r2(level)}bb — their call was lost, so the line reads them as out of the pot`);
        break;
      }
    }
  }

  // 3. the table's pot against every chip the capture accounts for. Ignition's pot is the WS CO_CHIPTABLE_INFO sum
  //    (the closed rounds' chips, dead money included); CoinPoker's adds every action's chips and the antes. Either
  //    way it can only be SMALLER than the closed rounds' captured chips + this round's committed chips + the antes
  //    (an uncalled excess returned, the rake, a pot not yet updated) — never larger unless chips moved with no
  //    action. This is the only evidence left for a lost call by a seat that folded later in the round, or that has
  //    not acted on the new street yet. 0.6bb of slack covers a dead small blind posted by a returning player.
  //    Archive (hands.db, end-of-hand pots): 38 of 631 hands exceed it, and every one read is a capture already
  //    known to be broken — the 2026-09-20 socket-mixing session, CoinPoker 140706500001 (the dropped Pot-button
  //    bet), 140553400095 (a river bet missing before the BB's fold).
  const pot = Number(hand.currentNode?.pot ?? 0);
  if (Number.isFinite(pot) && pot > 0) {
    let closed = 0;
    for (const [st, m] of per) if (order.indexOf(st) >= 0 && order.indexOf(st) < order.indexOf(street)) for (const v of m.values()) closed += v;
    // this round: what is known to be in front of each seat — the table's count or the captured actions, whichever is
    // more (an export with no `committed` map is "unknown", not "nothing in")
    const nowBySeat = new Map<number, number>(cur);
    for (const [k, v] of Object.entries(hand.committed ?? {})) {
      const x = Number(v);
      if (Number.isFinite(x)) nowBySeat.set(Number(k), Math.max(nowBySeat.get(Number(k)) ?? 0, x));
    }
    let now = 0;
    for (const v of nowBySeat.values()) now += v;
    const dealtN = (hand.liveSeats?.length ? hand.liveSeats.length : Object.keys(hand.positions ?? {}).length);
    const antes = Math.max(0, Number(hand.anteBb ?? 0) || 0) * dealtN;
    const missing = pot - closed - now - antes;
    if (missing > 0.6) {
      faults.push(`the table's pot is ${r2(pot)}bb but the captured actions account for ${r2(closed + now + antes)}bb — ${r2(missing)}bb went in with no action captured (a lost call or bet)`);
    }
  }
  return faults;
}

// ---------------------------------------------------------------------------------------------------------------
// FOLDS FILED LATE (2026-09-23, hand 4919958787 / dbId 734). The WS tap misses folds and the DOM backfill finds
// them a tick or two later, so the archive can read "CO calls, UTG folds, HJ folds, BTN raises" for a hand that
// went UTG-HJ fold, CO limp, BTN raise. Every token builder downstream walks the ring in order and pads a fold
// for each silent seat, so that capture becomes "F-F-C-F-F-F-R4.5-F" — eight tokens at six seats, which the limp
// chart cannot walk and GTO Wizard rejects with 400 Incorrect actions (three answers.sqlite rows on that hand).
// A fold commits nothing, so moving one into the slot the rotation expected cannot change the game being solved
// — the same argument repairPostflopRotation makes for checks. Only folds move, and only when the seat the
// rotation expected has a fold somewhere later in the line; a seat that never acts is left to the padding, and a
// seat that later puts chips in stops the repair (that is a real fault for captureFaults to name).
// ---------------------------------------------------------------------------------------------------------------

export function repairPreflopFoldOrder(hand: ParsedHand): { hand: ParsedHand; note: string | null } {
  const pos = (s: number) => (hand.positions?.[s] ?? `seat${s}`).toUpperCase();
  const live = hand.liveSeats?.length ? new Set(hand.liveSeats) : null;
  const ring = Object.keys(hand.positions ?? {}).map(Number)
    .filter((s) => hand.positions?.[s] && (!live || live.has(s)))
    .sort((a, b) => CLOCKWISE_RING.indexOf(pos(a)) - CLOCKWISE_RING.indexOf(pos(b)));
  const bb = ring.findIndex((s) => pos(s) === "BB");
  const anchor = bb >= 0 ? bb : ring.findIndex((s) => pos(s) === "SB");
  if (ring.length < 2 || anchor < 0 || !ring.every((s) => CLOCKWISE_RING.includes(pos(s)))) return { hand, note: null };

  const isVol = (a: ParsedAction) => a.street === "preflop" && a.type !== "post-sb" && a.type !== "post-bb" && ring.includes(a.seatId);
  const pending = hand.actions.filter(isVol);
  if (!pending.length) return { hand, note: null };
  const ordered: ParsedAction[] = [];
  const out = new Set<number>();
  const moved: string[] = [];
  const missed: string[] = [];
  const start = (anchor + 1) % ring.length;
  let cursor = start;
  let lap = 0;                                   // completed trips round the ring: 0 = the opening orbit
  const step = () => { cursor = (cursor + 1) % ring.length; if (cursor === start) lap++; };
  let guard = 0;
  while (pending.length && guard++ < 200) {
    const expect = ring[cursor]!;
    const next = pending[0]!;
    if (out.has(expect)) { step(); continue; }
    if (next.seatId === expect) {
      ordered.push(pending.shift()!);
      if (next.type === "fold" || next.type === "all-in") out.add(next.seatId);
      step();
      continue;
    }
    const later = pending.findIndex((a) => a.seatId === expect);
    if (later > 0 && pending[later]!.type === "fold") {
      // the expected seat's fold was filed late: pull it into its slot
      ordered.push(pending.splice(later, 1)[0]!);
      out.add(expect);
      moved.push(pos(expect));
      step();
      continue;
    }
    if (later < 0) {
      // NEVER ACTS AGAIN though the rotation passed him: a fold the tap missed. In the opening orbit the token
      // builders pad it positionally; in a LATER orbit they append the actions in capture order, so the next seat's
      // fold was handed to him and a seat that folded "reached the flop" (2026-09-25, harness `missed-fold` seed 3:
      // BTN's fold to the 4-bet lost, the SB's fold read as the BTN's, the SB solved as a flop seat). There the fold
      // is written into its slot. Never hero's: his own missing action is not ours to invent.
      if (expect !== hand.heroSeatId) {
        if (lap > 0) {
          ordered.push({ seatId: expect, hero: false, type: "fold", street: "preflop" } as ParsedAction);
          missed.push(pos(expect));
        }
        out.add(expect);   // folded either way: the opening orbit's padding, or the fold written here
      }
      step();
      continue;
    }
    break;   // the expected seat puts chips in later — a genuine contradiction, not ours to repair
  }
  ordered.push(...pending);
  if (!moved.length && !missed.length) return { hand, note: null };
  const rest = hand.actions.filter((a) => !isVol(a));
  // keep the blind posts first, then the repaired preflop line, then everything postflop in its captured order
  const posts = rest.filter((a) => a.street === "preflop");
  const post = rest.filter((a) => a.street !== "preflop");
  const notes = [
    moved.length ? `FOLDS FILED LATE: ${moved.join(", ")}'s fold${moved.length > 1 ? "s were" : " was"} captured after later seats acted and moved back into rotation (a fold commits nothing, so the spot is unchanged).` : null,
    missed.length ? `FOLDS NOT CAPTURED: ${missed.join(", ")} never acted again though the action passed ${missed.length > 1 ? "them" : "him"}, so ${missed.length > 1 ? "their folds were" : "his fold was"} written into the line (a fold commits nothing; chips with no action are refused by the ledger).` : null,
  ].filter(Boolean);
  return {
    hand: { ...hand, actions: [...posts, ...ordered, ...post] },
    note: notes.join(" "),
  };
}

/**
 * THE POSTFLOP CAPTURE GATE (2026-09-25, mutation harness `late-fold`: 70 flop/turn/river refusals in a 300-seed
 * sweep). The preflop gate moves a late-filed preflop fold back into its slot before the faults are read, but the
 * postflop path read the raw capture: the same "HJ folds, UTG folds, CO raises" line that every preflop decision of
 * the hand had answered was refused at the flop as "UTG acted before CO, SB, BB were to act". The preflop line is
 * the same capture at both points, so it is repaired the same way (a fold commits nothing — and the preflop pin,
 * written from the repaired line, still matches it), then the postflop checks, then the faults are read.
 */
export function repairPostflopCapture(hand: ParsedHand): { hand: ParsedHand; notes: string[]; faults: string[] } {
  const folds = repairPreflopFoldOrder(hand);
  const fixed = repairPostflopRotation(folds.hand);
  const notes = [
    ...(folds.note ? [`CAPTURE REPAIR (preflop): ${folds.note}`] : []),
    ...fixed.notes.map((n) => `CAPTURE REPAIR (${n.street}): ${n.detail}`),
  ];
  return { hand: fixed.hand, notes, faults: captureFaults(fixed.hand) };
}

// ---------------------------------------------------------------------------------------------------------------
// A DEAD SMALL BLIND MISLABELLED AS A LIVE ONE (2026-09-23, hand 4919958486 / dbId 732).
//
// When the player in the small-blind seat leaves or sits out between hands, Ignition deals the next hand with NO
// small blind: the button stays where it is, the empty seat is skipped, and the seat after it posts the big blind
// alone (the feed shows "Seat 2 posts big blind (1 BB)" and nothing else; the pot is 1bb). The wrapper's position
// map counted seats from the dealer button — SB, BB, …, BTN — without looking at who posted, so the BB poster was
// labelled SB and the seat after it BB. Both preflop pieces then refused: captureFaults saw "SB posted the big
// blind", and the AI piece walked a line that put the (non-existent) SB on the clock. Three such hands in the
// 293-hand NL200 corpus (372, 566, 732), all with this exact signature.
//
// The wrapper now labels from the posts (launch.py _positions_all / _hero_position), but hands already recorded
// carry the old labels, and any capture that reaches the API with this signature can be repaired losslessly: the
// seat geometry is intact, only the names are shifted by one. Clockwise from the poster: BB, then the middle seats,
// then the button. Nothing else about the hand changes. Applied at the fastSolve entry, before captureFaults.
// ---------------------------------------------------------------------------------------------------------------

/** Seat geometry clockwise from the small blind — the order seats sit in, not the order they act preflop. */
const CLOCKWISE_FROM_SB = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];

export function repairDeadSmallBlind(hand: ParsedHand): { hand: ParsedHand; note: string | null } {
  const positions = hand.positions ?? {};
  const sbPost = hand.actions.find((a) => a.type === "post-sb");
  const bbPost = hand.actions.find((a) => a.type === "post-bb");
  if (sbPost || !bbPost) return { hand, note: null };
  // the signature: the seat labelled SB posted the BIG blind, and a seat labelled BB exists behind it
  if ((positions[bbPost.seatId] ?? "").toUpperCase() !== "SB") return { hand, note: null };
  const seats = Object.keys(positions).map(Number);
  const labels = seats.map((s) => positions[s]!.toUpperCase());
  if (!labels.includes("BB") || !labels.includes("BTN")) return { hand, note: null };
  if (labels.some((l) => !CLOCKWISE_FROM_SB.includes(l))) return { hand, note: null };   // 9-max vocabulary: leave it
  const n = seats.length;
  if (n < 3 || n > 5) return { hand, note: null };   // a 6-max table with a dead SB deals at most five
  const clockwise = seats.slice().sort((a, b) => CLOCKWISE_FROM_SB.indexOf(positions[a]!.toUpperCase()) - CLOCKWISE_FROM_SB.indexOf(positions[b]!.toUpperCase()));
  const mids = ["UTG", "HJ", "CO"].slice(3 - (n - 2));
  const names = ["BB", ...mids, "BTN"];
  const fixed: Record<number, string> = {};
  clockwise.forEach((s, i) => { fixed[s] = names[i]!; });
  const changed = seats.filter((s) => fixed[s] !== positions[s]!.toUpperCase()).map((s) => `seat ${s} ${positions[s]}→${fixed[s]}`);
  return {
    hand: { ...hand, positions: fixed },
    note: `DEAD SMALL BLIND: seat ${bbPost.seatId} posted the big blind with no small blind in front of it (the SB seat emptied between hands), so the seats were relabelled from the post — ${changed.join(", ")}.`,
  };
}
