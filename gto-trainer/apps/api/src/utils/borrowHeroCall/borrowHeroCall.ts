/**
 * THE THIRD CALLER (2026-09-21).
 *
 * The 6-max charts cap how many players may call: after two cold-callers (or two limpers) the next seat's
 * tree node offers FOLD and RAISE only. When that seat is HERO, the walk still succeeds and the node still
 * has a strategy — but it is the strategy of a tree in which hero *cannot call*, so the solver 3-bets far
 * wider instead. Measured on the BTN facing an open and two calls: TT raises 82% (62% call one node over),
 * 77 folds 99% (64% call), 22 folds 100% (28% call). That answer used to be served silently: the walk did
 * not fail, so the miss queue never saw it either. 1.12% of hero's preflop decisions (241 of 21,609).
 *
 * This is the same shortcut `reconstructFlopRanges` already uses for villains' ranges, pointed at hero's own
 * decision: read it at the neighbouring node with ONE EARLIER CALLER FOLDED — the same seat, the same price,
 * one caller fewer.
 *
 * It is an approximation and it errs in a known direction: the donor node has one player and one call less in
 * the pot, so its odds are worse than the real spot's and it will call slightly too TIGHT. That beats a menu
 * with no call on it.
 *
 * SELF-VALIDATING, which is the point: the borrow only fires when the donor node offers a call that this node
 * does not. A tree that forbids limping everywhere (the no-limp open charts, where the root itself has no C)
 * has no donor either, so it is left alone rather than misread as a caller cap.
 */

/** The little a chart node has to expose for the borrow to be decidable. */
export interface BorrowNode {
  pos: string | null;
  terminal: boolean;
  actions: { token: string | null }[];
}

export interface BorrowResult<N> {
  node: N;
  /** the donor line, for the answer's warning and the stored trace */
  line: string;
  /** index into `tokens` of the call that was folded */
  index: number;
  /** the seat whose call was folded */
  dropped: string;
}

const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;

/**
 * Who acts on each token of a preflop line — the same rotation preflopPotStack replays. Returns one seat name
 * per token (or null once fewer than two players remain).
 *
 * KNOWN BLIND SPOT: it models a fold but NOT an all-in, so on a line containing a jam it keeps dealing the
 * all-in seat further turns and every attribution after that point is shifted. Harmless for the one caller it
 * has — `borrowHeroCall` only needs to find a CALL before hero's node, and a wrong pick produces a donor line
 * whose node belongs to another seat, which the hero-seat guard in fastSolve refuses. It is NOT harmless in
 * general: auditing the chart corpus with it flagged 132 nodes in every 3-max chart, all of them jam lines
 * where the charts were right (2026-09-22). Anything that judges or attributes a line with jams in it needs a
 * stack-aware rotation — see scripts/chartRotationAudit.ts `nextActor` for one.
 */
export function actorsOfLine(tokens: string[], seats: readonly string[] = SEATS): (string | null)[] {
  let active = [...seats];
  let p = 0;
  return tokens.map((tok) => {
    if (active.length < 2) return null;
    p = p % active.length;
    const seat = active[p]!;
    if (tok === "F") { active = active.filter((s) => s !== seat); return seat; }
    p += 1;
    return seat;
  });
}

/**
 * Hero's decision node, read one caller fewer, when and only when his own call is missing from the tree.
 * `null` means no borrow was needed or none was available — the caller keeps the node it already has.
 *
 * `tokens` is the WALKED (snapped) line, so the donor path differs from it by exactly one token and can be
 * read directly rather than re-walked.
 */
export async function borrowHeroCall<N extends BorrowNode>(
  tokens: string[],
  node: N,
  getNode: (line: string) => Promise<N | null | "unreachable">,
  opts: {
    heroPos?: string | null; seats?: readonly string[];
    /** seats whose call must stay in the line: the callers hero's EARLIER decision of the hand was read with —
     *  folding one moves the node that decision was read at (2026-09-25, harness seed 2593 [thin-table]) */
    keep?: readonly string[];
  } = {}
): Promise<BorrowResult<N> | null> {
  const offers = (n: BorrowNode) => n.actions.some((a) => a.token === "C");
  if (offers(node)) return null;                       // hero's call is in the tree — nothing to fix

  const actors = actorsOfLine(tokens, opts.seats ?? SEATS);
  const hero = opts.heroPos?.toUpperCase() ?? node.pos?.toUpperCase() ?? null;
  const keep = new Set((opts.keep ?? []).map((s) => s.toUpperCase()));

  for (let j = 0; j < tokens.length; j++) {
    if (tokens[j] !== "C") continue;
    const who = actors[j];
    // never fold hero's own earlier call out of the line — that is a different hand, not a neighbouring node
    if (!who || (hero && who.toUpperCase() === hero)) continue;
    if (keep.has(who.toUpperCase())) continue;
    const alt = tokens.slice();
    alt[j] = "F";
    const line = alt.join("-");
    const donor = await getNode(line);
    if (!donor || donor === "unreachable" || donor.terminal) continue;
    // the donor must be the SAME seat's decision — otherwise the fold shifted the rotation
    if (!donor.pos || !node.pos || donor.pos.toUpperCase() !== node.pos.toUpperCase()) continue;
    if (!offers(donor)) continue;                      // no call there either: tree design, not a caller cap
    return { node: donor, line, index: j, dropped: who };
  }
  return null;
}
