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
  | { ok: true; ranges: Record<string, Record<string, number>>; notes?: string[] } // position → (class → weight)
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
  /**
   * THE BORROWED-CALLER SHORTCUT (2026-09-17, Brady's call). The HRC 6-max trees cap callers - two cold-callers
   * after an open, one caller of a 3-bet, two limpers - so a third caller / second 3-bet caller / third limper has
   * no branch and the walk used to stop there, losing the whole postflop spot. With this on, a call the tree does
   * not offer is conditioned on the NEAREST node the tree does have: the same seat calling the same price with
   * one earlier caller folded instead. The borrowed range is a little too wide (calling behind two is tighter
   * than behind one); pot, stacks and board stay exact; the answer says so in `notes`. Only when no raise follows
   * in the line - a later squeeze would need the missing branch's own responses.
   */
  borrowCaller?: boolean;
  /**
   * How many players may reach the flop. Default 2 — every heads-up tree (the GTO Wizard library, the HU chain).
   * The 6-max ring strategy passes 3 since 2026-09-19: GTO Wizard AI on Ultra solves 3-way postflop, so a
   * three-way flop is a solvable spot there rather than a miss. FOUR AND FIVE are allowed since 2026-09-20 —
   * not because a four-way tree exists (none does anywhere) but because the postflop step COLLAPSES the field
   * to three seats, and it needs every seat's arrival range to choose which to drop or merge. Note the 6-max
   * charts barely contain such lines (the caller cap stops at two cold-callers: ign200_6max_D100_o2_5 holds
   * ZERO four-way lines, olimp five, all multi-limped) — the real four-way range source is the GTO Wizard AI
   * preflop tree, which solves the multiway preflop outright (services/gtowAiPreflop.ts).
   */
  maxPlayers?: 2 | 3 | 4 | 5 | 6;
  /**
   * THE LINE STOPS AT A PREFLOP DECISION, NOT AT THE FLOP (2026-09-24, the hand page's range looker): return the
   * range of every seat that has acted and not folded, with no player-count check. Seats that have not acted yet
   * hold every hand and are not listed.
   */
  partial?: boolean;
  /**
   * Called at every decision the walk reads, folds included (2026-09-24, the range looker's villain rows: "what
   * does a BB raise to 10 look like"). Forced folds have no node and no step.
   */
  onStep?: (step: WalkStep) => void;
}

/** One decision of the walk: the node read, who acted, what they took, and their range either side of it. */
export interface WalkStep {
  /** the tree path before this decision (snapped; after a borrow, the borrowed path) */
  line: string;
  node: RawNode;
  pos: string;
  /** the token as the tree holds it, and as the line had it */
  token: string;
  rawToken: string;
  /** the label the line took here, and the labels the range was conditioned on (a villain raise: every size) */
  label: string;
  labels: string[];
  /** class → weight in [0,1]; null before = every hand (the seat's first decision), null after = a fold */
  rangeIn: Record<string, number> | null;
  rangeOut: Record<string, number> | null;
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
  let out: string[] = []; // snapped prefix so far (the TREE path; after a borrow it has one caller fewer than reality)
  const walkedPos: string[] = []; // acting position of each token in `out`
  const notes: string[] = [];

  for (let k = 0; k < tokens.length; k++) {
    let node = await getNode(out.join("-"));
    // A FORCED FOLD HAS NO NODE (2026-09-22, see walk3max): the engine folds the would-be fifth entrant
    // without a decision. That player never put money in, so he holds no range to drop — step through.
    // …in CHAINS: once four have entered, every seat still to act is force-folded (SB and BB both).
    if (!node && tokens[k] === "F" && out.length) {
      let run = 0;
      while (tokens[k + run] === "F") run++;
      let landed = 0;
      for (let r = 1; r <= run && !landed; r++) if (await getNode([...out, ...Array(r).fill("F")].join("-"))) landed = r;
      if (landed) {
        for (let r = 0; r < landed; r++) { out.push("F"); walkedPos.push(""); }
        k += landed - 1;
        continue;
      }
    }
    if (!node) return { ok: false, reason: `preflop node "${out.join("-")}" not in the charts` };
    if (node.terminal) {
      // A TERMINAL FOLLOWED ONLY BY FOLDS IS THE FLOP (2026-09-25, hand 4920396764). The converter marks a subtree
      // HRC never exported (an action it plays at ~0%, e.g. a 30bb small blind flat-calling a button open) as
      // "closes the preflop action", so the walk met a terminal at the SB's call with the BB's fold still to read.
      // Seats that fold after the tree's close never put money in and hold no range to drop — the players who
      // reached the flop are already known. Anything other than folds past a terminal is still a broken line.
      if (tokens.slice(k).every((t) => t === "F")) {
        notes.push(`the chart holds no node after "${out.join("-")}" (a branch it plays at ~0%); the ${tokens.length - k} remaining fold(s) were taken as read`);
        break;
      }
      return { ok: false, reason: `preflop node "${out.join("-")}" is terminal before the line ends` };
    }
    let pos = node.pos;
    if (!pos) return { ok: false, reason: `preflop node "${out.join("-")}" has no acting position` };

    let tok = tokens[k]!;
    let offered = node.actions.map((a) => a.token).filter((t): t is string => t != null);
    if (tok !== "F" && !offered.includes(tok)) {
      const s = snapToken(tok, node.actions.map((a) => a.action));
      // accept both a genuine snap and a same-size canonicalization (R2.52 → R2.5)
      if (offered.includes(s.token)) tok = s.token;
      else if (tok === "C" && opts.borrowCaller && !tokens.slice(k + 1).some((t) => /^R/i.test(t))) {
        // the borrowed-caller shortcut (see ReconstructOpts): fold the EARLIEST other caller out of the tree path
        // and read this call at the node that leaves - the same seat, the same price, one caller fewer
        let borrowed: { node: RawNode; path: string[]; dropped: string } | null = null;
        for (let j = 0; j < out.length && !borrowed; j++) {
          if (out[j] !== "C" || walkedPos[j] === pos) continue;
          const path = out.slice(); path[j] = "F";
          const alt = await getNode(path.join("-"));
          if (!alt || alt.terminal || alt.pos !== pos) continue;
          if (!alt.actions.some((a) => a.token === "C")) continue;
          borrowed = { node: alt, path, dropped: walkedPos[j]! };
        }
        if (!borrowed) return { ok: false, reason: `action "${tok}" not offered at "${out.join("-")}" (no neighbouring node to borrow from)` };
        notes.push(`${pos}'s call at "${out.join("-")}" is not in the tree (caller cap) — range borrowed from the node with the ${borrowed.dropped}'s call folded`);
        node = borrowed.node; out = borrowed.path; pos = node.pos!;
        offered = node.actions.map((a) => a.token).filter((t): t is string => t != null);
      }
      else return { ok: false, reason: `action "${tok}" not offered at "${out.join("-")}"` };
    }
    lastToken.set(pos, tok);
    out.push(tok); walkedPos.push(pos);
    if (tok === "F") {
      if (opts.onStep) {
        const label = node.actions.find((a) => a.token === "F")?.action ?? "Fold";
        const prev = ranges.get(pos);
        opts.onStep({ line: out.slice(0, -1).join("-"), node, pos, token: tok, rawToken: tokens[k]!, label, labels: [label],
          rangeIn: prev ? Object.fromEntries(prev) : null, rangeOut: null });
      }
      continue;
    }

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
    opts.onStep?.({ line: out.slice(0, -1).join("-"), node, pos, token: tok, rawToken: tokens[k]!, label, labels,
      rangeIn: prev ? Object.fromEntries(prev) : null, rangeOut: Object.fromEntries(next) });
  }

  const flopPositions = [...lastToken.entries()].filter(([, t]) => t !== "F").map(([p]) => p);
  if (opts.partial) {
    const partial: Record<string, Record<string, number>> = {};
    for (const p of flopPositions) partial[p] = Object.fromEntries(ranges.get(p) ?? new Map());
    return { ok: true, ranges: partial, ...(notes.length ? { notes } : {}) };
  }
  const maxPlayers = opts.maxPlayers ?? 2;
  if (flopPositions.length < 2 || flopPositions.length > maxPlayers) {
    const need = maxPlayers > 2 ? `2 to ${maxPlayers}` : "exactly 2";
    return { ok: false, reason: `${flopPositions.length} players reach the flop — need ${need}` };
  }
  const outRanges: Record<string, Record<string, number>> = {};
  for (const p of flopPositions) {
    const m = ranges.get(p) ?? new Map();
    if (!m.size) return { ok: false, reason: `reconstructed range for ${p} is empty (uncrawled subtree?)` };
    outRanges[p] = Object.fromEntries(m);
  }
  return { ok: true, ranges: outRanges, ...(notes.length ? { notes } : {}) };
}

/** class→weight map → solver range spec ("AA,AKs:0.8,…"); weight ≥0.9995 emitted bare. */
export const classWeightsToSpec = (w: Record<string, number>): string =>
  Object.entries(w)
    .filter(([, x]) => x > 0)
    .map(([cls, x]) => (x >= 0.9995 ? cls : `${cls}:${x.toFixed(4).replace(/\.?0+$/, "")}`))
    .join(",");
