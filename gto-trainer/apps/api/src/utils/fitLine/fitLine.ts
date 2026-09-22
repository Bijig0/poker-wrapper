/**
 * FIT A REAL LINE INTO A CAPPED TREE (2026-09-22).
 *
 * The 6-max charts are solved under three caps (HRC tree spec): at most two limpers, at most two flat-callers
 * of a raise, and `maxactive: 4` — once four players have voluntarily put money in, every other seat is folded
 * by the engine without a decision. Real hands ignore all three: five limpers, an iso with three callers, a
 * squeeze over a limped iso. The first borrow (hrc3max.walk3max `borrowCaller`) patched this node by node and
 * the esoteric stress family found every hole in that: it only fired where a node existed without the call,
 * it could fold HERO's own limp, and it could not cross a chain of forced folds (SB and BB both force-folded
 * once four have entered: `C-C-R5-C` and `C-C-R5-C-F` are missing, the next node is `C-C-R5-C-F-F`).
 *
 * THE RULE, applied to the whole line instead of one node: while the tree refuses the line, fold the EARLIEST
 * plain caller or limper — never hero, never a player who raises later in the hand (folding a limp-reraiser
 * would delete the raise hero is facing) — drop that player's later actions (he is gone), and try again.
 * Every fold is one player fewer in the pot: the answer is read at the nearest spot the tree holds, errs
 * slightly tight (worse pot odds than the real spot), and says so. Bounded by `maxFolds`.
 *
 * The walk itself (walk3max) steps through forced-fold CHAINS; this module decides who to fold.
 */
import { walk3max, type GetNode, type Walk3Result } from "../../services/hrc3max";

const SEATS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;

/**
 * Who takes each token, all-in aware: a seat whose total reaches its stack is all-in and never acts again —
 * the rule `actorsOfLine` (utils/borrowHeroCall) omits, and which a line with a limp-JAM in it needs.
 */
export function actorsWithAllins(tokens: string[], stack: number, seats: readonly string[] = SEATS6): (string | null)[] {
  // `active` = seats that can still ACT (not folded, not all-in); `inHand` = seats not folded. They differ:
  // a lone player facing a jam still has to call or fold it, so "fewer than two can act" is not the end —
  // only "fewer than two in the hand" or "nobody can act" is.
  let active = [...seats];
  let inHand = seats.length;
  const inFor: Record<string, number> = {};
  for (const s of seats) inFor[s] = s === "SB" ? 0.5 : s === "BB" ? 1 : 0;
  let p = 0;
  return tokens.map((tok) => {
    if (inHand < 2 || active.length === 0) return null;
    p %= active.length;
    const seat = active[p]!;
    if (tok === "F") { active = active.filter((s) => s !== seat); inHand--; return seat; }
    if (tok === "C") inFor[seat] = Math.min(Math.max(...Object.values(inFor)), stack);
    else if (tok !== "X") {
      const to = tok === "RAI" ? stack : Number(/^R([\d.]+)$/.exec(tok)?.[1] ?? NaN);
      if (Number.isFinite(to)) inFor[seat] = Math.min(to, stack);
    }
    if ((inFor[seat] ?? 0) >= stack - 1e-9) active = active.filter((s) => s !== seat);
    else p += 1;
    return seat;
  });
}

export interface FitFold {
  /** index in the ORIGINAL line of the call that was folded */
  index: number;
  seat: string;
  /** that seat's later actions, removed with it */
  dropped: string[];
}

export type FitResult = Walk3Result & {
  folds: FitFold[];
  fittedLine?: string[];
  /** the tree accepted the fitted line: a decision node, or (with acceptTerminal) the end of preflop */
  fitted: boolean;
};

/**
 * Walk `intended` through the tree, folding callers until it fits. Returns the walk (as walk3max) plus every
 * fold made. A line that needs no fold comes back exactly as walk3max would return it.
 */
export async function walkFitted(
  intended: string[],
  getNode: GetNode,
  opts: {
    heroSeat: string | null; stack: number; seats?: readonly string[]; maxFolds?: number;
    /** further seats that must not be folded — the range walk keeps the one whose range it is reading */
    protect?: string[];
    /** the line runs to the FLOP (range reconstruction): ending on a terminal is the goal, not a failure */
    acceptTerminal?: boolean;
  },
): Promise<FitResult> {
  const seats = opts.seats ?? SEATS6;
  const hero = opts.heroSeat?.toUpperCase() ?? null;
  const keep = new Set([hero, ...(opts.protect ?? []).map((x) => x.toUpperCase())].filter(Boolean) as string[]);
  const maxFolds = opts.maxFolds ?? 4;
  let tokens = intended.slice();
  const folds: FitFold[] = [];
  // index mapping back to the original line, for the record
  let origIdx = intended.map((_, i) => i);

  for (let attempt = 0; ; attempt++) {
    const w = await walk3max(tokens, getNode);
    const endsAtFlop = !w.ok && !!opts.acceptTerminal && /ends on a terminal/.test(w.reason ?? "");
    if (w.ok || w.unreachable || endsAtFlop) return { ...w, folds, fittedLine: tokens, fitted: w.ok || endsAtFlop };
    if (attempt >= maxFolds) return { ...w, folds, fittedLine: tokens, fitted: false };

    const who = actorsWithAllins(tokens, opts.stack, seats);
    const raisers = new Set(tokens.map((t, i) => (/^R/.test(t) || t === "RAI" ? who[i] : null)).filter((s): s is string => !!s));
    let j = -1;
    for (let i = 0; i < tokens.length; i++) {
      const s = who[i];
      if (tokens[i] !== "C" || !s) continue;
      if (keep.has(s.toUpperCase())) continue;              // never fold hero's (or a protected seat's) action
      if (raisers.has(s)) continue;                         // a limp-reraiser's raise is the spot itself
      j = i;
      break;
    }
    if (j < 0) return { ...w, folds, fittedLine: tokens, fitted: false };  // nothing left that may be folded

    const seat = who[j]!;
    const dropped: string[] = [];
    const next: string[] = [];
    const nextIdx: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (i === j) { next.push("F"); nextIdx.push(origIdx[i]!); continue; }
      if (i > j && who[i] === seat) { dropped.push(tokens[i]!); continue; }   // he folded: his later actions never happen
      next.push(tokens[i]!); nextIdx.push(origIdx[i]!);
    }
    folds.push({ index: origIdx[j]!, seat, dropped });
    tokens = next;
    origIdx = nextIdx;
  }
}
