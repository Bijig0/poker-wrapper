import { snapToken } from "../snapToken/snapToken";

/**
 * Reconstruct each flop player's range from the crawled preflop charts: walk the
 * preflop token line and, for every hand class, accumulate the product of that
 * player's continuation frequencies at each node they acted. The result is each
 * player's GTO range reaching the flop (class → weight in [0,1]) — the ranges an
 * exploit solve starts from before you apply a read. Keyed by position so the
 * caller maps OOP/IP however the spot resolved. Pure over a `getNode` callback.
 */

export interface RawNode {
  pos: string | null;
  terminal: boolean;
  actions: { action: string; token: string | null }[];
  cells: { hand: string; actions: Record<string, number> }[];
}

export type ReconstructResult =
  | { ok: true; ranges: Record<string, Record<string, number>> } // position → (class → weight)
  | { ok: false; reason: string };

/**
 * `getNode` may be async. The locally crawled charts are an in-memory table and
 * answer synchronously, but the 3-max asymmetric corpus is served over HTTP,
 * and it cannot be pre-fetched into a cache instead: this walk SNAPS tokens as
 * it goes, so which node comes next is not known until the previous one has
 * been read. Awaiting the accessor keeps the snapping in one place rather than
 * duplicating it in a pre-walk.
 */
export interface ReconstructOpts {
  /**
   * Merge wager sizes for every actor EXCEPT this position.
   *
   * A real opponent almost always uses ONE raise size, so conditioning their
   * range on the chart's size-specific branch models a fiction: the "R2.2
   * range" is the equilibrium slice that mixes into 2.2 specifically, not
   * what a 2.2x-only human holds. Measured at the 100bb BTN root, the slice
   * misdescribes ~26% of a single-sizer's range — all too tight. With
   * merging, a villain's raise conditions on the UNION of all raise branches
   * at the node (their total open range); the observed size still walks the
   * tree, so pot and stack geometry are untouched. Jams stay their own
   * action — a jam is a distinct human decision, not a sizing choice.
   *
   * Hero is exempt: hero genuinely uses the chart's mixed sizes, and hero's
   * own range must stay conditioned on what hero actually chose.
   */
  heroPos?: string;
}

const isJamLabel = (l: string) => /all-?in/i.test(l);
// Plain prefix match on purpose: chart labels are "Raise 2.5" / "Bet(194)",
// nothing else starts with these words. (A word-boundary here once shipped as
// a literal backspace character via a heredoc — invisible in grep, fatal in
// the regex — so the simpler pattern is also the safer one.)
const isRaiseLabel = (l: string) => /^(raise|bet)/i.test(l) && !isJamLabel(l);

export async function reconstructFlopRanges(
  tokens: string[],
  getNode: (line: string) => RawNode | null | Promise<RawNode | null>,
  opts: ReconstructOpts = {}
): Promise<ReconstructResult> {
  const ranges = new Map<string, Map<string, number>>();
  const lastToken = new Map<string, string>();
  const out: string[] = []; // snapped prefix so far

  for (let k = 0; k < tokens.length; k++) {
    const node = await getNode(out.join("-"));
    if (!node) return { ok: false, reason: `preflop node "${out.join("-")}" not in the charts` };
    if (node.terminal) return { ok: false, reason: `preflop node "${out.join("-")}" is terminal before the line ends` };
    const pos = node.pos;
    if (!pos) return { ok: false, reason: `preflop node "${out.join("-")}" has no acting position` };

    let tok = tokens[k]!;
    const offered = node.actions.map((a) => a.token).filter((t): t is string => t != null);
    if (tok !== "F" && !offered.includes(tok)) {
      const s = snapToken(tok, node.actions.map((a) => a.action));
      // accept both a genuine snap and a same-size canonicalization (R2.52 → R2.5)
      if (offered.includes(s.token)) tok = s.token;
      else return { ok: false, reason: `action "${tok}" not offered at "${out.join("-")}"` };
    }
    lastToken.set(pos, tok);
    out.push(tok);
    if (tok === "F") continue;

    const label = node.actions.find((a) => a.token === tok)?.action;
    if (!label) return { ok: false, reason: `token ${tok} isn't an action at "${out.slice(0, -1).join("-")}"` };

    // A villain's non-jam raise conditions on ALL raise sizes at this node
    // (see ReconstructOpts.heroPos); hero's, and every call/check, on the
    // exact label as before.
    const merge =
      opts.heroPos != null &&
      pos.toUpperCase() !== opts.heroPos.toUpperCase() &&
      isRaiseLabel(label);
    const labels = merge
      ? node.actions.map((a) => a.action).filter(isRaiseLabel)
      : [label];

    const prev = ranges.get(pos) ?? null;
    const next = new Map<string, number>();
    for (const cell of node.cells) {
      const pct = labels.reduce((acc, l) => acc + (cell.actions[l] ?? 0), 0);
      if (pct <= 0) continue;
      const contFreq = Math.min(1, pct / 100);
      const prior = prev === null ? 1 : prev.get(cell.hand) ?? 0;
      if (prev !== null && prior <= 0) continue;
      next.set(cell.hand, prior * contFreq);
    }
    ranges.set(pos, next);
  }

  const flopPositions = [...lastToken.entries()].filter(([, t]) => t !== "F").map(([p]) => p);
  if (flopPositions.length !== 2) {
    return { ok: false, reason: `${flopPositions.length} players reach the flop — need exactly 2` };
  }
  const outRanges: Record<string, Record<string, number>> = {};
  for (const p of flopPositions) {
    const m = ranges.get(p) ?? new Map();
    if (!m.size) return { ok: false, reason: `reconstructed range for ${p} is empty (uncrawled subtree?)` };
    outRanges[p] = Object.fromEntries(m);
  }
  return { ok: true, ranges: outRanges };
}

/** class→weight map → solver range spec ("AA,AKs:0.8,…"); weight ≥0.9995 emitted bare. */
export const classWeightsToSpec = (w: Record<string, number>): string =>
  Object.entries(w)
    .filter(([, x]) => x > 0)
    .map(([cls, x]) => (x >= 0.9995 ? cls : `${cls}:${x.toFixed(4).replace(/\.?0+$/, "")}`))
    .join(",");
