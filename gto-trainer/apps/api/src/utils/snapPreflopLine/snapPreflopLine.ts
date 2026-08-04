import { snapToken } from "../snapToken/snapToken";

/**
 * Snap a COMPLETE preflop token line (all seats acted, reaching the flop) to
 * the tree's real sizes, using the crawled preflop nodes. Live opens are often
 * off-tree — a 2.5 open in the 6-max General tree (which opens 2.3) — and the
 * spot-solution API returns nothing for an off-tree preflop line, so the tokens
 * must be snapped before the postflop query.
 *
 * Unlike walkPreflopLine this does NOT require a pending decision at the end:
 * the line runs to the flop, whose node isn't a preflop decision. Pure over a
 * `getNode` callback.
 */

export interface SnapNode {
  pos: string | null;
  terminal: boolean;
  actions: { action: string; token: string | null }[];
}

export type SnapLineResult =
  | { ok: true; tokens: string[]; repaired: { index: number; from: number; to: number }[] }
  | { ok: false; reason: string; at: string };

export function snapPreflopLine(
  intended: string[],
  getNode: (line: string) => SnapNode | null
): SnapLineResult {
  const out: string[] = [];
  const repaired: { index: number; from: number; to: number }[] = [];

  for (let i = 0; i < intended.length; i++) {
    const line = out.join("-");
    const node = getNode(line);
    if (!node) return { ok: false, reason: "node not in local charts", at: line };
    if (node.terminal) return { ok: false, reason: "line continues past a terminal", at: line };

    let tok = intended[i]!;
    const offered = node.actions.map((a) => a.token).filter((t): t is string => t != null);
    if (!offered.includes(tok)) {
      const s = snapToken(tok, node.actions.map((a) => a.action));
      if (s.snapped && offered.includes(s.token)) {
        repaired.push({ index: i, from: s.from!, to: s.to! });
        tok = s.token;
      } else {
        return { ok: false, reason: `action "${tok}" not offered (have: ${offered.join(", ")})`, at: line };
      }
    }
    out.push(tok);
  }
  return { ok: true, tokens: out, repaired };
}
