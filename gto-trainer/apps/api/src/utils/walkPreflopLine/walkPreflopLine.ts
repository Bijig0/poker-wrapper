import { snapToken, type SnapResult } from "../snapToken/snapToken";

/**
 * Walk an intended preflop token line through a LOCAL node source (the
 * crawled preflop DB), validating each action against the sizes the tree
 * actually offers and snapping off-tree sizes to the log-nearest one — the
 * local, zero-navigation equivalent of the live off-tree repair loop.
 *
 * Pure: the node source is a callback, so this is unit-testable without a DB.
 */
export interface WalkNode {
  /** Seat to act at this node, null on terminals. */
  pos: string | null;
  terminal: boolean;
  /** Legend actions with their URL tokens (token null = un-encodable). */
  actions: { action: string; token: string | null }[];
}

export interface WalkRepair {
  /** Index into the token line. */
  index: number;
  from: number;
  to: number;
}

export type WalkResult =
  | { ok: true; tokens: string[]; repaired: WalkRepair[]; node: WalkNode }
  | { ok: false; tokens: string[]; repaired: WalkRepair[]; missingAt: string; reason: string };

export function walkPreflopLine(
  intended: string[],
  getNode: (line: string) => WalkNode | null
): WalkResult {
  const out: string[] = [];
  const repaired: WalkRepair[] = [];

  for (let i = 0; i < intended.length; i++) {
    const line = out.join("-");
    const node = getNode(line);
    if (!node) return { ok: false, tokens: out, repaired, missingAt: line, reason: "node not in local DB" };
    if (node.terminal) return { ok: false, tokens: out, repaired, missingAt: line, reason: "line continues past a terminal" };

    let tok = intended[i]!;
    const offered = node.actions.map((a) => a.token).filter((t): t is string => t != null);
    if (!offered.includes(tok)) {
      // A check where checking is impossible (facing a bet) is a capture
      // phantom, not a strategy — drop it and keep walking rather than
      // failing the whole line.
      if (tok === "X") continue;
      const s: SnapResult = snapToken(tok, node.actions.map((a) => a.action));
      if (offered.includes(s.token)) {
        // un-snapped = same size canonicalized (R2.52 → R2.5) — not a repair
        if (s.snapped) repaired.push({ index: i, from: s.from!, to: s.to! });
        tok = s.token;
      } else {
        return { ok: false, tokens: out, repaired, missingAt: line, reason: `action "${tok}" not offered (have: ${offered.join(", ")})` };
      }
    }
    out.push(tok);
  }

  const node = getNode(out.join("-"));
  if (!node) return { ok: false, tokens: out, repaired, missingAt: out.join("-"), reason: "hero node not in local DB" };
  if (node.terminal || !node.pos) {
    return { ok: false, tokens: out, repaired, missingAt: out.join("-"), reason: "line ends on a terminal — no pending decision" };
  }
  return { ok: true, tokens: out, repaired, node };
}
