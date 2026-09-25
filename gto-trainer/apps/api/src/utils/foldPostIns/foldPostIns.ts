import type { ParsedAction, PostIn } from "../../feed/parsePanelFeed/parsePanelFeed";

/**
 * POSTED-IN PLAYERS READ AS LIMPERS (2026-09-25, Brady; hands 4920414446 56o, 4920414607 9Ts, 734, 917).
 *
 * A new or returning Ignition player POSTS a live blind out of turn (CO_BLIND_INFO btn 8 — "Seat 1 posts post
 * (1 BB)") and still acts in his own seat with the option: unraised, he CHECKS. No tree we have can play that game:
 * every HRC chart holds exactly one big blind, and GTO Wizard's AI tree treats any extra blind as a STRADDLE and
 * moves that player to act last (probed on hand 937's shape: the posters acted first/last around the blinds, a
 * 0.99bb blind the same). So Brady's call is an approximation that errs TIGHT: the poster's option-check reads as a
 * LIMP. His real range is wider and weaker (a free check never folds; it is everything but his raises), a limp range
 * is narrower and stronger — the answer knows it is facing better hands than it is.
 *
 * Folded into the ordinary vocabulary HERE, at the API's entry, so every consumer (chart walk, AI tree, capture
 * gate, range walks, pot sums) sees an ordinary hand:
 *   - the `post` itself leaves the line (it is not a decision) and is kept in `postIns`;
 *   - the poster's FIRST later preflop action carries his post: a check becomes a call of the post (a limp), a call
 *     of X becomes a call of X + post (the post was live), a raise/bet/all-in is already a total and stays;
 *   - a poster who folds leaves his post in the pot — the line cannot carry it (said in the note).
 * Chip totals are unchanged: every chip the post put in is still on exactly one action, except a folder's.
 */
export function foldPostIns(actions: ParsedAction[]): { actions: ParsedAction[]; postIns: PostIn[] } {
  const posts = actions.filter((a) => a.type === "post");
  if (!posts.length) return { actions, postIns: [] };
  const owed = new Map<number, number>();          // poster seat → live post not yet carried by an action
  for (const p of posts) owed.set(p.seatId, (owed.get(p.seatId) ?? 0) + (p.amount ?? 0));
  const postIns: PostIn[] = posts.map((p) => ({ seatId: p.seatId, hero: p.hero, amount: p.amount ?? 0, readAs: "pending" }));
  const out: ParsedAction[] = [];
  for (const a of actions) {
    if (a.type === "post") continue;
    const carry = a.street === "preflop" ? owed.get(a.seatId) : undefined;
    if (carry === undefined) { out.push(a); continue; }
    owed.delete(a.seatId);
    const rec = postIns.find((p) => p.seatId === a.seatId)!;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    if (a.type === "check") { out.push({ ...a, type: "call", amount: r2(carry) }); rec.readAs = "limp"; }
    else if (a.type === "call") { out.push({ ...a, amount: r2((a.amount ?? 0) + carry) }); rec.readAs = "call"; }
    else if (a.type === "fold") { out.push(a); rec.readAs = "fold"; }
    else { out.push(a); rec.readAs = "raise"; }
  }
  return { actions: out, postIns };
}

/**
 * DEAD POSTS (2026-09-25, round 2 of the input-mutation harness, `post-in` seed 8). A poster who FOLDS leaves his post in
 * the pot and no action carries it, so the flop pot rolled from the token line was short by it (1bb in a 6.5bb pot).
 * The bb of dead posts the pot must add; a post carried by a limp, call or raise is already in the line.
 */
export function deadPostsBb(postIns: PostIn[] | undefined, street = "flop"): number {
  return Math.round((postIns ?? []).filter((p) => lostOrFolded(p, street)).reduce((s, p) => s + (Number(p.amount) || 0), 0) * 100) / 100;
}
/** A poster who folded — or who is still "pending" once the preflop is over: every live player acts preflop, so his
 *  fold is one the capture lost (round 2, harness post-in + missed-fold, seed 412). */
const lostOrFolded = (p: PostIn, street: string) => p.readAs === "fold" || (p.readAs === "pending" && street !== "preflop");

/**
 * HERO'S OWN FREE OPTION (2026-09-25, the post-in matrix, scripts/postInMatrix.ts). Hero posted in and nobody has
 * raised: the chart node is an ordinary player's facing 1bb (or limps), so its mix may hold FOLD and CALL/LIMP — and
 * both mean "put nothing more in", which Ignition's strip offers as CHECK (FOLD · CHECK · RAISE TO). Rewriting only
 * the served decision was not enough: the poller ROLLS over the mix (rollDecision), so a roll landed on the chart's
 * Fold (98s on the BTN over an HJ limp, Fold 75% → the relay pressed FOLD over a free check) or its Limp (pressed CALL,
 * which is not on the strip — refused until the no-answer clock checked). Here the mix itself says Check: every
 * passive action merged into one Check, where the first of them stood; raises and all-ins unchanged.
 * Returns null when the mix has no passive action to merge.
 */
export function freeOptionMix<T extends { action: string; frequency: number }>(actions: T[] | null | undefined): { action: string; frequency: number }[] | null {
  if (!actions?.length) return null;
  const passive = (a: { action: string }) => /^(fold|check|call|limp|complete)\b/i.test(a.action.trim());
  if (!actions.some(passive) || (actions.filter(passive).length === 1 && /^check\b/i.test(actions.find(passive)!.action))) return null;
  const sum = Math.round(actions.filter(passive).reduce((s, a) => s + (Number(a.frequency) || 0), 0) * 100) / 100;
  const out: { action: string; frequency: number }[] = [];
  for (const a of actions) {
    if (!passive(a)) out.push({ ...a });
    else if (!out.some((x) => x.action === "Check")) out.push({ action: "Check", frequency: sum });
  }
  return out;
}

/** The line an answer carries when the hand had posted-in players. */
export function postInNote(postIns: PostIn[] | undefined, positions: Record<number, string>, street = "preflop"): string | null {
  if (!postIns?.length) return null;
  const who = postIns.map((p) => {
    const pos = positions[p.seatId] ?? `seat ${p.seatId}`;
    const how = p.readAs === "limp" ? `checked ${p.hero ? "your" : "his"} option — read as a LIMP`
      : p.readAs === "fold" ? `folded, ${p.amount}bb left in the pot as dead money`
      : lostOrFolded(p, street) ? `folded (the fold was not captured), ${p.amount}bb left in the pot as dead money`
      : p.readAs === "pending" ? (p.hero ? "are yet to act" : "is yet to act")
      : p.hero ? `${p.readAs === "call" ? "called" : "raised"} (post included)` : `${p.readAs}s (post included)`;
    return `${p.hero ? "you" : pos} posted ${p.amount}bb and ${how}`;
  });
  const limped = postIns.some((p) => p.readAs === "limp");
  return `POSTED IN (approximation): ${who.join("; ")}.` + (limped
    ? " A poster's check range is really any hand he did not raise — wider and weaker than the limp range the answer assumes"
    : " A poster who has not acted is read as an ordinary player; one who called or raised, as any caller or raiser");
}
