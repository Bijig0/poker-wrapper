/**
 * THE RECORD'S OWN LINE (2026-10-14, the answer-path audit's merged records). Three archived hands since 09-30 carried
 * their actions TWICE: the wrapper's socket closed mid-hand, the next DOM tick re-bound the closed socket and replayed
 * its whole hand into the record still open for it (4923409614: a post-sb on the "river" at index 15, then the flop and
 * turn again; 4923409734, 4923345879). The reconciler read hero's replayed actions as decisions nobody asked about and
 * wrote three phantom no-probe rows (answers 13722-13724). The wrapper no longer does this (ignition/ws.ts
 * tapSocketClosed, blindOpensNewHand); the rows it wrote are still in the archive, and a tap gap could still lose a
 * PLAY_STAGE_INFO — so every reader of an archived line takes only the leading actions that can be ONE hand's:
 *   - streets only go forward (a flop row after a turn row is another hand's);
 *   - a blind post comes before any play, on the preflop (one after a voluntary action, or off the preflop, is the
 *     next hand's first frame).
 * Everything from the first action that breaks either rule is a tail that belongs to no decision of this hand.
 */
const RANK: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
const POSTS = new Set(["post-sb", "post-bb", "post", "post-ante"]);

type Row = { type?: string; street?: string | null };

/** How many leading actions of an archived line belong to the hand itself (its whole length when nothing breaks). */
export function ownActionCount(actions: readonly Row[]): number {
  let high = 0, played = false;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    const r = RANK[a.street ?? "preflop"] ?? 0;
    const post = POSTS.has(String(a.type));
    if (r < high) return i;
    if (post && (played || r > 0)) return i;
    if (!post) played = true;
    high = r;
  }
  return actions.length;
}

/** The actions past the record's own line — a merged tail — or an empty list. */
export const mergedTail = <T extends Row>(actions: readonly T[]): T[] => actions.slice(ownActionCount(actions));
