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

/** The line an answer carries when the hand had posted-in players. */
export function postInNote(postIns: PostIn[] | undefined, positions: Record<number, string>): string | null {
  if (!postIns?.length) return null;
  const who = postIns.map((p) => {
    const pos = positions[p.seatId] ?? `seat ${p.seatId}`;
    const how = p.readAs === "limp" ? "checked his option — read as a LIMP"
      : p.readAs === "fold" ? `folded, ${p.amount}bb left in the pot (not in the line)`
      : p.readAs === "pending" ? "is yet to act" : `${p.readAs}s (post included)`;
    return `${p.hero ? "you" : pos} posted ${p.amount}bb and ${how}`;
  });
  const limped = postIns.some((p) => p.readAs === "limp");
  return `POSTED IN (approximation): ${who.join("; ")}.` + (limped
    ? " A poster's check range is really any hand he did not raise — wider and weaker than the limp range the answer assumes"
    : " A poster who has not acted is read as an ordinary player; one who called or raised, as any caller or raiser");
}
