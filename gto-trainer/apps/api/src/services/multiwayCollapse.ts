/**
 * FOUR AND FIVE WAY POSTFLOP, BY COLLAPSING TO A TREE THAT EXISTS (2026-09-21).
 *
 * GTO Wizard AI solves three postflop seats; nothing anywhere solves four. So a four- or five-way flop is
 * answered by collapsing the field to three seats, solving that, and — where more than one collapse is legal —
 * combining them. Two primitives, and both were calibrated one player down, at 3→2, where the truth exists
 * (scripts/collapseCalibration.ts, 528 nodes):
 *
 *   GHOST(v)    villain v leaves the tree; his chips stay in the pot as dead money. Legal only while every
 *               token of his on the walked streets is a check or a fold — otherwise his money is
 *               unrepresentable, since a seat that is not in the tree cannot put chips into it.
 *   MERGE(a,b)  two ADJACENT villains (hero not between them) become one seat whose range is the sum of
 *               theirs. Legal while the pair commits chips at most once per street — two commitments on one
 *               street would collapse into one and leave the pot short.
 *
 * MEASURED, checked to hero / facing a bet, in bb of EV against the true tree:
 *
 *   BLEND of 2+ ghosts   0.0079  /  (blend unavailable at 3→2 facing a bet; available at 4→3, see below)
 *   MERGE                0.0205  /  0.0464
 *   one GHOST            0.0199  /  0.0661
 *   no answer at all     0.1606  /  0.6801     (uniform play, the no-information bound)
 *
 * Hence the policy in `pickCollapses`: blend when two or more ghosts are legal, else merge, else the one
 * ghost. Note 3→2 is the HARD direction — it deletes half the field where 4→3 deletes a third, and it leaves
 * only one legal ghost facing a bet where 4→3 leaves two — so these are upper bounds on what we ship.
 *
 * The blend rule itself is monotone rather than an average, and that mattered: 0.0079 vs 0.0281 bb for a
 * plain mean over the same ghosts. Facing more opponents can only shrink hero's share of the pot, so fold as
 * often as the MOST folding collapse and bet as often as the LEAST betting one. Every single collapse
 * over-bets by +8 to +13pp of aggression; the blend is the only rule that corrects it (−5.6pp).
 *
 * A seat that FOLDED without committing chips is not a collapse at all (2026-09-27): he leaves first, as a fold,
 * and the policy above runs on the players still in. See planCollapses. (Ported to poker-wrapper 2026-10-05: it was
 * one of the product edits left uncommitted in the factory repo at the 2026-09-28 cut-over.)
 */

/** One postflop token and the seat that played it. */
export interface SeatTok {
  tok: string;
  seat: string;
}

export interface CollapseSeat {
  pos: string;
  /** 1326-combo weights entering the flop */
  range: number[];
  /** a MERGED seat: the table seats it stands for (its `pos` is the first of them). Absent = just `pos`. */
  members?: string[];
}

export interface CollapsePlan {
  /** "ghost:CO", "merge:HJ+CO", "ghost:CO + merge:SB+BB", "fold:BB + ghost:SB" — what was done, for the answer's
   *  warning. A "fold:" is not an approximation: the seat folded and simply left (2026-09-27). */
  kind: string;
  /** the tree's seats in postflop order: three, or two when the folds left a heads-up street */
  seats: CollapseSeat[];
  /** hero's index within `seats` */
  heroIdx: number;
  /** the walked streets with the dropped seats' tokens removed and merged pairs reduced to one actor */
  streets: SeatTok[][];
  /** how many primitives were applied — 1 for a four-way flop, 2 for five-way; 0 when the folds alone left three
   *  seats or fewer (an exact tree, nothing collapsed) */
  steps: number;
  /** true when every primitive was a GHOST (what the blend was measured on) */
  ghostOnly: boolean;
  /** the folds and primitives that made it, in order — replayable on a later decision of the hand (replayPlan); absent
   *  on a plan not built by planCollapses (a re-root's, a dead-money one) */
  recipe?: PlanRecipe;
}

/** A collapse as the steps that built it: the seats that left as folds, then each GHOST / MERGE by table seat. */
export interface PlanRecipe {
  folds: string[];
  ops: ({ ghost: string } | { merge: [string, string] })[];
}

const COMMITS = (tok: string) => tok !== "X" && tok !== "F";
const isFree = (tok: string) => tok === "X" || tok === "F";

interface State {
  seats: CollapseSeat[];
  heroPos: string;
  streets: SeatTok[][];
  kinds: string[];
  ghostOnly: boolean;
  ops: PlanRecipe["ops"];
}

/** GHOST: villain `v` leaves. Legal only while he has committed nothing on any walked street. */
function ghost(st: State, v: number): State | null {
  const seat = st.seats[v]!;
  if (seat.pos === st.heroPos) return null;
  for (const street of st.streets) {
    for (const t of street) if (t.seat === seat.pos && COMMITS(t.tok)) return null;
  }
  return {
    seats: st.seats.filter((_, i) => i !== v),
    heroPos: st.heroPos,
    streets: st.streets.map((street) => street.filter((t) => t.seat !== seat.pos)),
    kinds: [...st.kinds, `ghost:${seat.pos}`],
    ghostOnly: st.ghostOnly,
    ops: [...st.ops, { ghost: seat.pos }],
  };
}

/** MERGE: adjacent villains `a` and `a+1` become one seat. Legal while the pair commits at most once a street. */
function merge(st: State, a: number): State | null {
  const x = st.seats[a]!;
  const y = st.seats[a + 1];
  if (!y) return null;
  if (x.pos === st.heroPos || y.pos === st.heroPos) return null;   // hero is never merged away
  const pair = new Set([x.pos, y.pos]);
  // AN ALL-IN SEAT IS NEVER MERGED (2026-10-03): a merged seat carries ONE stack (the deeper member's), so a short
  // member's all-in would become a bet with chips behind it — the 28bb shove walked as 97.8 all over again.
  if (st.streets.some((street) => street.some((t) => pair.has(t.seat) && t.tok === "RAI"))) return null;

  const streets: SeatTok[][] = [];
  let carrier: string | null = null;
  // the members still in: the composite folds only when the last of them folds (hand 4922575177, 2026-10-05)
  const alive = new Set([x.pos, y.pos]);
  for (const street of st.streets) {
    const mine = street.filter((t) => pair.has(t.seat));
    const commits = mine.filter((t) => COMMITS(t.tok));
    if (commits.length > 1) return null;                            // two commitments would collapse into one
    if (commits.length === 1) carrier = commits[0]!.seat;
    if (!mine.length) { streets.push(street.slice()); continue; }
    // THE PAIR ACTS ONCE PER ORBIT (2026-09-24, postflop sweep w4-turn/river-faces-checkraise). The two seats are
    // adjacent, so the n-th action of one and the n-th action of the other happen in the same orbit; the composite
    // takes one action per orbit, in the earlier slot, carrying the committing action when that orbit has one. The
    // old rule kept ONE action per street at the pair's first slot, which moved a check-RAISE back in front of the
    // bet it raises ("SB x, BB x, hero bets, SB raises" became "SB raises, hero bets") and the walk refused the line.
    const nth = new Map<string, number>();
    const orbits: { at: number; toks: string[]; seats: string[] }[] = [];
    street.forEach((t, i) => {
      if (!pair.has(t.seat)) return;
      const n = nth.get(t.seat) ?? 0;
      nth.set(t.seat, n + 1);
      const o = (orbits[n] ??= { at: i, toks: [], seats: [] });
      o.toks.push(t.tok); o.seats.push(t.seat);
    });
    // A MEMBER'S FOLD IS THE COMPOSITE'S ONLY WHEN NO MEMBER IS LEFT (2026-10-05, hand 4922575177: UTG checks, CO bets,
    // two callers, UTG folds — the orbit's lone action was UTG's fold, the composite "folded" after its own bet had
    // been called, and every walk refused "street closed but more actions follow"). The other member is still in: the
    // composite carries on as him and does nothing in that orbit.
    const emit = new Map<number, string>();
    for (const o of orbits) {
      o.toks.forEach((tok, k) => { if (tok === "F") alive.delete(o.seats[k]!); });
      const commit = o.toks.find(COMMITS);
      const tok = commit ?? (o.toks.includes("X") ? "X" : alive.size === 0 ? "F" : null);
      if (tok != null) emit.set(o.at, tok);
    }
    const out: SeatTok[] = [];
    street.forEach((t, i) => {
      if (!pair.has(t.seat)) { out.push(t); return; }
      const tok = emit.get(i);
      if (tok != null) out.push({ tok, seat: x.pos });              // named for the earlier seat: its slot in the rotation
    });
    streets.push(out);
  }
  // the composite's range is the sum of the two — one opponent who could hold either
  const composite: CollapseSeat = {
    pos: x.pos, range: x.range.map((w, i) => w + (y.range[i] ?? 0)),
    members: [...(x.members ?? [x.pos]), ...(y.members ?? [y.pos])],
  };
  const seats = st.seats.slice();
  seats.splice(a, 2, composite);
  return {
    seats,
    heroPos: st.heroPos,
    streets,
    kinds: [...st.kinds, `merge:${x.pos}+${y.pos}${carrier && carrier !== x.pos ? ` (${carrier}'s action)` : ""}`],
    ghostOnly: false,
    ops: [...st.ops, { merge: [x.pos, y.pos] }],
  };
}

/** A villain who has FOLDED on the walked streets without ever putting chips in: every token of his is X or F, one is F. */
const hasFolded = (pos: string, streets: SeatTok[][]): boolean => {
  let folded = false;
  for (const street of streets) {
    for (const t of street) {
      if (t.seat !== pos) continue;
      if (COMMITS(t.tok)) return false;
      if (t.tok === "F") folded = true;
    }
  }
  return folded;
};

/** The villains who folded on the walked streets without ever putting chips in (planCollapses' folds). */
export const foldedSeats = (seats: { pos: string }[], heroPos: string, streets: SeatTok[][]): string[] =>
  seats.filter((s) => s.pos !== heroPos && hasFolded(s.pos, streets)).map((s) => s.pos);

const labelOf = (folds: string[], kinds: string[]): string => [...folds.map((p) => `fold:${p}`), ...kinds].join(" + ");

/** A finished state as a plan, or null when it is not a tree (hero gone, alone, or more than three seats). */
function planOf(st: State, folds: string[]): CollapsePlan | null {
  if (st.seats.length > 3) return null;
  const heroIdx = st.seats.findIndex((s) => s.pos === st.heroPos);
  if (heroIdx < 0 || st.seats.length < 2) return null;   // hero gone, or alone: nothing to solve
  return {
    kind: labelOf(folds, st.kinds), seats: st.seats, heroIdx, streets: st.streets,
    steps: st.kinds.length, ghostOnly: st.ghostOnly, recipe: { folds: folds.slice(), ops: st.ops.slice() },
  };
}

/**
 * Every distinct way to bring `seats` down to three, cheapest primitive first. Returns [] when the field
 * cannot be collapsed at all — every villain has chips in this street and no pair is mergeable.
 *
 * A FOLDED SEAT LEAVES FIRST, AS A FOLD, NEVER AS AN APPROXIMATION (2026-09-27, Brady: "folded seat always
 * ghosted"). A villain who folded without ever committing chips on the walked streets has no future in the hand:
 * dropping him and his tokens is the ordinary treatment of a fold — the very tree the chain builds when he folds
 * preflop instead — not a collapse. Until now he counted as "the only legal ghost", so the picker preferred
 * MERGING him into his neighbour: "SB bets, BB calls, CO folds" was solved as SB / BB+CO / hero, a caller holding
 * BB's and CO's ranges added together, and hero's answer was read against hands that had already left the pot.
 * The calibration that ranks a merge above a lone ghost never held a folded seat (at three seats a fold makes the
 * pot heads-up). A seat that committed chips and THEN folded stays as before: his chips are in the street, and
 * only a seat in the tree, or a composite carrying his call, can have put them there. When the folds alone leave
 * three seats or fewer, the one plan returned has `steps: 0` — the field IS the tree (two seats: heads-up).
 */
export function planCollapses(
  seats: CollapseSeat[],
  heroPos: string,
  streets: SeatTok[][]
): CollapsePlan[] {
  const folds = foldedSeats(seats, heroPos, streets);
  return collapsesFrom(startState(seats, heroPos, streets, folds), folds, null);
}

/**
 * The identity of a finished tree. The RANGES are part of it, not just the shape: ghosting a villain who only checked
 * and merging him into his neighbour leave the same seats and the same tokens, but the merged seat carries both ranges.
 * Keying on shape alone silently threw the merge away as a duplicate.
 */
const planKey = (st: { seats: CollapseSeat[]; streets: SeatTok[][] }): string =>
  st.seats.map((s) => `${s.pos}:${s.range.reduce((a, b) => a + b, 0).toFixed(3)}`).join("/") + "|" +
  st.streets.map((x) => x.map((t) => `${t.seat}${t.tok}`).join(",")).join(";");

/**
 * Every distinct tree reachable from `start` by GHOST / MERGE, in planCollapses' order. `foldCheck` (replanKeeping's walk,
 * which keeps the seats that folded after the hand's first collapse): the streets on which a merge with a FOLDED member is
 * refused, as replayPlan refuses it. Null for planCollapses, whose folded seats left before any merge.
 */
function collapsesFrom(start: State, folds: string[], foldCheck: SeatTok[][] | null): CollapsePlan[] {
  const out: CollapsePlan[] = [];
  const seen = new Set<string>();

  const walk = (st: State): void => {
    if (st.seats.length <= 3) {
      const plan = planOf(st, folds);
      if (!plan) return;
      const key = planKey(st);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(plan);
      return;
    }
    for (let i = 0; i < st.seats.length; i++) {
      const g = ghost(st, i);
      if (g) walk(g);
    }
    for (let i = 0; i + 1 < st.seats.length; i++) {
      if (foldCheck) {
        const pair = st.seats.slice(i, i + 2).flatMap((s) => s.members ?? [s.pos]);
        if (pair.some((m) => hasFolded(m, foldCheck))) continue;
      }
      const m = merge(st, i);
      if (m) walk(m);
    }
  };
  walk(start);
  // ghost-only plans first (what the blend was calibrated on), then fewest primitives
  out.sort((a, b) => Number(b.ghostOnly) - Number(a.ghostOnly) || a.steps - b.steps || a.kind.localeCompare(b.kind));
  return out;
}

/** The walk's start: the folded seats and their tokens gone, nothing collapsed yet. */
function startState(seats: CollapseSeat[], heroPos: string, streets: SeatTok[][], folds: string[]): State {
  const gone = new Set(folds);
  return {
    seats: seats.filter((s) => !gone.has(s.pos)), heroPos,
    streets: streets.map((street) => street.filter((t) => !gone.has(t.seat))),
    kinds: [], ghostOnly: true, ops: [],
  };
}

/**
 * THE SAME COLLAPSE ON A LATER DECISION OF THE HAND (2026-10-14, hand 4924401943). Rebuilds the plan `recipe` describes
 * from the seats and the streets as they read NOW, or null when it no longer holds: one of its folds is not a fold
 * (it cannot be — a fold is final — but the capture can change), a ghosted seat has since put chips in, a merge has
 * since committed twice on a street, or a member of a merged pair has since FOLDED (the composite would go on carrying
 * the folded seat's range — planCollapses' own rule drops a folded seat before any merge).
 *
 * A villain who folded AFTER the recipe was made is not removed here: he folds inside the trees that kept him, at the
 * street close, as any fold does — the trees and every range the hand's earlier decisions walked stay as they were.
 * planCollapses instead takes him out from the flop (a fold is "not a collapse"), which builds different trees from
 * the root: on the river of hand 4924401943 (5-way to the turn, three folded to hero's raise) that was a heads-up
 * flop + turn walked again from nothing, the off-tree lock solved again and a hung poll — 26 s for an answer whose
 * ranges came from a hand that was never heads-up on the flop.
 */
export function replayPlan(seats: CollapseSeat[], heroPos: string, streets: SeatTok[][], recipe: PlanRecipe): CollapsePlan | null {
  const r = replayExplained(seats, heroPos, streets, recipe);
  return "plan" in r ? r.plan : null;
}

const STREET_NAMES = ["flop", "turn", "river"];
const streetName = (k: number): string => STREET_NAMES[k] ?? `street ${k + 1}`;

/** "the SB bet the turn": the first time `pos` put chips in on the walked streets, in words. */
function commitPhrase(pos: string, streets: SeatTok[][]): string {
  for (let k = 0; k < streets.length; k++) {
    const street = streets[k]!;
    for (let j = 0; j < street.length; j++) {
      const t = street[j]!;
      if (t.seat !== pos || !COMMITS(t.tok)) continue;
      const verb = t.tok === "C" ? "called" : t.tok === "RAI" ? "went all-in on"
        : /^[RB]/.test(t.tok) ? (street.slice(0, j).some((x) => COMMITS(x.tok)) ? "raised" : "bet") : "put chips in on";
      return `the ${pos} ${verb} the ${streetName(k)}`;
    }
  }
  return `the ${pos} put chips in`;
}

/** Why MERGE of `pair` (its members) no longer holds on these streets, in words. */
function mergePhrase(pair: string[], streets: SeatTok[][]): string {
  for (let k = 0; k < streets.length; k++) {
    const allIn = streets[k]!.find((t) => pair.includes(t.seat) && t.tok === "RAI");
    if (allIn) return `the ${allIn.seat} went all-in on the ${streetName(k)}`;
  }
  for (let k = 0; k < streets.length; k++) {
    const who = [...new Set(streets[k]!.filter((t) => pair.includes(t.seat) && COMMITS(t.tok)).map((t) => t.seat))];
    if (who.length > 1) return `the ${who.join(" and the ")} both put chips in on the ${streetName(k)}`;
  }
  return `the ${pair.join("+")} merge no longer fits the action`;
}

/** replayPlan, saying why the recipe no longer holds when it does not (replanKeeping's `why`). */
function replayExplained(seats: CollapseSeat[], heroPos: string, streets: SeatTok[][], recipe: PlanRecipe): { plan: CollapsePlan } | { broke: string } {
  for (const f of recipe.folds) {
    if (f === heroPos || !seats.some((s) => s.pos === f)) return { broke: `the ${f} is not a villain in the hand` };
    if (!hasFolded(f, streets)) return { broke: `the ${f}'s fold is no longer in the capture` };
  }
  let st: State = startState(seats, heroPos, streets, recipe.folds);
  for (const op of recipe.ops) {
    if ("ghost" in op) {
      const i = st.seats.findIndex((s) => s.pos === op.ghost);
      if (i < 0) return { broke: `the ${op.ghost} is no longer a seat of the tree` };
      const g = ghost(st, i);
      if (!g) return { broke: commitPhrase(op.ghost, streets) };
      st = g;
    } else {
      const [a, b] = op.merge;
      const i = st.seats.findIndex((s) => s.pos === a);
      if (i < 0 || st.seats[i + 1]?.pos !== b) return { broke: `the ${a} and the ${b} no longer sit side by side in the tree` };
      const members = [...(st.seats[i]!.members ?? [a]), ...(st.seats[i + 1]!.members ?? [b])];
      const gone = members.find((m) => hasFolded(m, streets));
      if (gone) return { broke: `the ${gone} folded out of the merged seat` };
      const m = merge(st, i);
      if (!m) return { broke: mergePhrase(members, streets) };
      st = m;
    }
  }
  const plan = planOf(st, recipe.folds);
  return plan ? { plan } : { broke: "it no longer leaves hero in a tree" };
}

/** A recipe's label, as planOf names the plan it builds (a merge without its "(X's action)" note). */
const recipeLabel = (r: PlanRecipe): string =>
  labelOf(r.folds, r.ops.map((op) => ("ghost" in op ? `ghost:${op.ghost}` : `merge:${op.merge[0]}+${op.merge[1]}`)));

const himOrThem = (xs: string[]): string => (xs.length === 1 ? "him" : "them");

export interface Replanned extends Picked {
  /** `why` without its closing "… folded since" clause — what the hand's memo keeps for its next decision */
  baseWhy: string;
  /** the kept recipes that still hold, rebuilt on these streets (the first of `plans`, in the memo's order) */
  kept: CollapsePlan[];
  /** the kept recipes that no longer hold, by label, and why */
  dropped: { kind: string; why: string }[];
  /** plans added after a drop to bring the pick back up to `max` (the rest of `plans`) */
  added: CollapsePlan[];
  /** villains who folded without chips after the recipes were made (they fold inside the trees) */
  since: string[];
  /** after a drop: villains in no tree, because no collapse that holds keeps them */
  uncovered: string[];
}

/**
 * KEEP WHAT STILL HOLDS, TOP UP THE REST (2026-10-14, Brady: "I don't care about upfront cost, just want the one with the
 * best final performance"). A later decision of a 4+ way hand, given the collapse recipes its earlier decision was
 * answered on (the hand's memo, fastSolve.keptCollapsePick):
 *
 *   1. every recipe is replayed (replayPlan); the ones that still hold are KEPT — same seats, same ranges, same flop, so
 *      the streets already walked come from the hand's checkpoints — and always come first, never replaced;
 *   2. when one or more no longer hold (the villain a plan ghosted put chips in since), the pick is TOPPED BACK UP to
 *      `max` with collapses built over the hand's ORIGINAL seats and the folds as they were when the recipes were made
 *      (`recipe.folds`): a villain who folded after that stays in the tree and folds inside it (the hand's real history),
 *      never removed from the flop as planCollapses does. A top-up holds now (a ghosted seat committed nothing on any
 *      walked street; a merge commits at most once a street and no member of it folded) and is chosen as coverPick
 *      chooses: repeatedly the one keeping the most villains no plan yet keeps, ties to planCollapses' order. Only
 *      GHOST-only plans top up ghost-only survivors — what the blend was measured on; a merge is never blended in, and a
 *      merge survivor (a single pick) gets no top-up;
 *   3. nothing holds → null: the caller picks afresh (planCollapses), as before.
 *
 * Mode as pickCollapses: "blend" with two or more ghost-only plans, else "single". Until this, one broken recipe dropped
 * them all and the fresh pick took every villain who had folded without chips out of the FLOP — a 4-way flop answered as
 * heads-up, new trees from the root, no checkpoints: six live hands on 2026-10-14 (4924195300, 4923556567, 4923565359,
 * 4923553178, 4924403091, 4923484379), each with one of three single-ghost plans broken and two still holding.
 */
export function replanKeeping(
  seats: CollapseSeat[], heroPos: string, streets: SeatTok[][], keptRecipes: PlanRecipe[], max = 3, prevWhy?: string,
): Replanned | null {
  const kept: CollapsePlan[] = [];
  const dropped: { kind: string; why: string }[] = [];
  for (const r of keptRecipes) {
    const x = replayExplained(seats, heroPos, streets, r);
    if ("plan" in x) kept.push(x.plan);
    else dropped.push({ kind: recipeLabel(r), why: x.broke });
  }
  if (!kept.length) return null;
  const base = kept[0]!.recipe!.folds;
  const added: CollapsePlan[] = [];
  const covered = new Set(kept.flatMap(keptVillains));
  if (dropped.length && kept.length < max && kept.every((p) => p.ghostOnly)) {
    const have = new Set(kept.map(planKey));
    const left = collapsesFrom(startState(seats, heroPos, streets, base), base, streets)
      .filter((p) => p.ghostOnly && !have.has(planKey(p)));
    while (kept.length + added.length < max && left.length) {
      let best = 0;
      let bestGain = -1;
      left.forEach((p, i) => {
        const gain = new Set(keptVillains(p).filter((v) => !covered.has(v))).size;
        if (gain > bestGain) { best = i; bestGain = gain; }   // strict: a tie stays with the earlier plan
      });
      const p = left.splice(best, 1)[0]!;
      added.push(p);
      for (const v of keptVillains(p)) covered.add(v);
    }
  }
  const plans = [...kept, ...added];
  const mode: Picked["mode"] = plans.filter((p) => p.ghostOnly).length >= 2 ? "blend" : "single";
  const since = foldedSeats(seats, heroPos, streets).filter((f) => !base.includes(f));
  const uncovered = dropped.length
    ? seats.filter((s) => s.pos !== heroPos && !base.includes(s.pos) && !covered.has(s.pos)).map((s) => s.pos) : [];
  let baseWhy: string;
  if (!dropped.length) {
    baseWhy = prevWhy ?? (mode === "blend"
      ? `${plans.length} independent collapses blended (measured 0.008bb vs the true tree; a single collapse costs 0.020-0.066bb)`
      : "one collapse of this field (measured 0.020-0.066bb vs the true tree)");
  } else {
    // what each top-up brought back into a tree, said beside it
    const seen = new Set(kept.flatMap(keptVillains));
    const addedText = added.map((p) => {
      const gain = [...new Set(keptVillains(p).filter((v) => !seen.has(v)))];
      for (const v of gain) seen.add(v);
      return gain.length ? `${p.kind} added to keep the ${gain.join(", ")} in a tree` : `${p.kind} added`;
    });
    baseWhy = (mode === "blend" ? `${plans.length} collapses blended (measured 0.008bb vs the true tree)`
      : "one collapse (measured 0.020-0.066bb vs the true tree)") +
      `: ${dropped.map((d) => `${d.kind} dropped — ${d.why}`).join("; ")}; ${kept.map((p) => p.kind).join(", ")} kept from the hand's earlier decision` +
      (addedText.length ? `; ${addedText.join("; ")}` : "") +
      (uncovered.length ? `; the ${uncovered.join(", ")} in no tree — no collapse that holds keeps ${himOrThem(uncovered)}` : "");
  }
  const told = /kept from (the hand's|its) earlier decision/.test(baseWhy);
  const why = baseWhy + (!since.length ? ""
    : told ? `; ${since.join(", ")} folded since, inside the trees that hold ${himOrThem(since)}`
    : `; the hand's collapses kept from its earlier decision — ${since.join(", ")} folded since, inside the trees that hold ${himOrThem(since)}, so the streets already walked are reused`);
  return { plans, mode, why, baseWhy, kept, dropped, added, since, uncovered };
}

export interface Picked {
  plans: CollapsePlan[];
  /** "blend" combines them; "single" means the one plan's strategy is used as-is */
  mode: "blend" | "single";
  why: string;
}

/** The table seats a plan keeps in its tree besides hero (a merged seat counts each of its members). */
export const keptVillains = (p: CollapsePlan): string[] =>
  p.seats.filter((_, i) => i !== p.heroIdx).flatMap((s) => s.members ?? [s.pos]);

/**
 * THREE-AND-COVER (2026-10-07, Brady: "three-and-cover, go"). At most `max` of `plans` (planCollapses' order), chosen
 * so that every villain any of them keeps is kept in at least one. The first `max` in order (the pick before) stand
 * whenever they already do that; only when they leave a villain out, greedy — repeatedly the plan that keeps the most
 * villains not yet kept by one already taken, ties to the earlier plan; once every villain is in, the rest in order.
 * With `max` plans or fewer nothing is chosen: all of them, in order, exactly as before (every 4-way field, and a
 * 5-way field with a villain who has chips in).
 *
 * Why: the pick used to be the first `max` in name order. A 5-way flop with all four villains free has six two-ghost
 * plans, and the first three by name all ghost the alphabetically first villain — stress-500 po_56way-004 (hero SB;
 * BB, UTG, HJ, CO all checked): "ghost:BB + ghost:CO", "ghost:BB + ghost:HJ", "ghost:BB + ghost:UTG", so the BB sat in
 * none of the three trees and the blend was over three answers that all ignored him. Three plans of two kept villains
 * are six slots for four villains, so a full cover always exists at 5-way; the request count is unchanged.
 */
export function coverPick(plans: CollapsePlan[], max: number): CollapsePlan[] {
  if (plans.length <= max) return plans.slice();
  // THE OLD PICK STAYS WHEN IT ALREADY COVERS (2026-10-07, coordinator's amendment): a different trio where every villain
  // was already in a tree moves the served mix with no coverage gain (12 of the 14 live all-free 5-way answers)
  const first = plans.slice(0, max);
  const all = new Set(plans.flatMap(keptVillains));
  if (new Set(first.flatMap(keptVillains)).size >= all.size) return first;
  const left = plans.slice();
  const kept = new Set<string>();
  const out: CollapsePlan[] = [];
  while (out.length < max && left.length) {
    let best = 0;
    let bestGain = -1;
    left.forEach((p, i) => {
      const gain = new Set(keptVillains(p).filter((v) => !kept.has(v))).size;
      if (gain > bestGain) { best = i; bestGain = gain; }   // strict: a tie stays with the earlier plan
    });
    const p = left.splice(best, 1)[0]!;
    out.push(p);
    for (const v of keptVillains(p)) kept.add(v);
  }
  return out;
}

/**
 * The shipped policy, straight off the calibration: blend two or more GHOST plans; failing that take a MERGE;
 * failing that the single ghost. `max` bounds the cloud cost — each plan is one full chain walk. When more than `max`
 * ghost plans are legal (a 5-way flop with every villain free) and the first `max` by name leave a villain in no tree,
 * the `max` blended are chosen to keep every villain in at least one (coverPick, 2026-10-07).
 */
export function pickCollapses(plans: CollapsePlan[], max = 3): Picked | null {
  if (!plans.length) return null;
  // no primitive applied: the folds alone left the tree's seats — nothing to blend and nothing approximate
  const exact = plans.find((p) => p.steps === 0);
  if (exact) {
    const who = exact.kind.split(" + ").map((k) => k.replace(/^fold:/, "")).join(", ");
    return { plans: [exact], mode: "single",
      why: `${who} folded — the ${exact.seats.length} seats still in are the tree, nothing collapsed` };
  }
  const ghosts = plans.filter((p) => p.ghostOnly);
  if (ghosts.length >= 2) {
    const chosen = coverPick(ghosts, max);
    // said only when the cover changed the pick: the first `max` by name is what every other answer blends
    const covered = chosen.some((p, i) => p !== ghosts[i]);
    const all = new Set(ghosts.flatMap(keptVillains));
    const kept = new Set(chosen.flatMap(keptVillains));
    return {
      plans: chosen, mode: "blend",
      why: `${chosen.length} independent collapses blended (measured 0.008bb vs the true tree; ` +
        `a single collapse costs 0.020-0.066bb)` +
        (!covered ? ""
          : kept.size >= all.size ? `; the ${chosen.length} of ${ghosts.length} legal chosen so every villain is in at least one tree`
          : `; the ${chosen.length} of ${ghosts.length} legal chosen to keep the most villains in a tree (${kept.size} of ${all.size})`),
    };
  }
  const m = plans.find((p) => !p.ghostOnly);
  if (m) {
    return { plans: [m], mode: "single",
      why: "only one seat could be dropped, so the other two villains are merged into one " +
        "(measured 0.046bb facing a bet, against 0.066bb for dropping a seat)" };
  }
  return { plans: [ghosts[0]!], mode: "single",
    why: "only one collapse of this field is legal (measured 0.020-0.066bb vs the true tree)" };
}

/**
 * BLEND: fold as often as the MOST folding collapse, bet as often as the LEAST betting one, and let the
 * passive action absorb the rest. `strats[i][a][c]` is collapse i's frequency for action a, combo c; every
 * collapse must already be expressed on the same action list `codes`.
 */
export function blendStrategies(codes: string[], strats: number[][][]): number[][] {
  if (strats.length === 1) return strats[0]!;
  const isFold = codes.map((c) => /^F/i.test(c));
  const isAggr = codes.map((c) => /^(B|R|A)/i.test(c));
  const passive = codes.findIndex((c) => /^(X|C)/i.test(c));
  const n = strats[0]![0]!.length;
  const out = codes.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    let spare = 0;
    for (let a = 0; a < codes.length; a++) {
      const vals = strats.map((s) => s[a]![i] ?? 0);
      const v = isFold[a] ? Math.max(...vals) : isAggr[a] ? Math.min(...vals) : 0;
      out[a]![i] = v;
      spare += v;
    }
    if (passive >= 0) out[passive]![i] = (out[passive]![i] ?? 0) + Math.max(0, 1 - spare);
    else { const s = spare || 1; for (let a = 0; a < codes.length; a++) out[a]![i] = (out[a]![i] ?? 0) / s; }
  }
  return out;
}

/** Re-express one collapse's action_solutions on the reference collapse's action list. Null when the menus
 *  differ, which means the collapses disagree about the tree and must not be blended. */
export function alignStrategy(codes: string[], sols: { code: string; strategy: number[] }[]): number[][] | null {
  const n = sols[0]?.strategy.length ?? 0;
  if (!n) return null;
  const out = codes.map(() => new Array(n).fill(0));
  for (const s of sols) {
    const t = codes.indexOf(s.code);
    if (t < 0) return null;
    for (let i = 0; i < n; i++) out[t]![i] = (out[t]![i] ?? 0) + (s.strategy[i] ?? 0);
  }
  return out;
}

/**
 * ONE WALK'S ACTIONS ON THE REFERENCE MENU, for one combo (or the node's aggregate): each code's frequency (summed when
 * the walk's menu names it twice, as alignStrategy does) and its EV — the walk's own EVs for that code weighted by its
 * frequencies, their plain mean when it never plays them, undefined when it gives none. Null when the menus differ.
 */
export function alignedAt(codes: string[], sols: { code: string; f: number; ev: number | null | undefined }[]): { f: number; ev: number | undefined }[] | null {
  if (!sols.length) return null;
  const by = codes.map(() => [] as { f: number; ev: number | null | undefined }[]);
  for (const s of sols) {
    const t = codes.indexOf(s.code);
    if (t < 0) return null;
    by[t]!.push(s);
  }
  return by.map((xs) => ({ f: xs.reduce((s, x) => s + (Number.isFinite(x.f) ? x.f : 0), 0), ev: blendEv(xs.map((x) => ({ f: x.f, ev: x.ev }))) }));
}

/**
 * THE EV BESIDE A BLENDED MIX (2026-10-03, Brady: "do 1-3" — the EV next to a blended mix should describe the mix being
 * played). The mix is blendStrategies' (fold at the most folding walk's frequency, bet at the least betting one's); an
 * action's EV is each walk's EV for it weighted by how often THAT walk plays it,
 *     ev(a) = Σ_k f_k(a)·ev_k(a) / Σ_k f_k(a)
 * — so a walk that never bets says nothing about the bet's EV — and the plain mean of ev_k(a) when no walk plays it.
 * It used to be the first walk's EV alone, whatever the blend did. A walk with no EV for the action is left out.
 */
export function blendEv(walks: { f: number; ev: number | null | undefined }[]): number | undefined {
  const known = walks.filter((w) => w.ev != null && Number.isFinite(w.ev));
  if (!known.length) return undefined;
  const wsum = known.reduce((s, w) => s + (w.f > 0 ? w.f : 0), 0);
  return wsum > 0
    ? known.reduce((s, w) => s + (w.f > 0 ? w.f : 0) * w.ev!, 0) / wsum
    : known.reduce((s, w) => s + w.ev!, 0) / known.length;
}

/** Per action of the reference menu, blendEv over the walks (each already alignedAt the menu). */
export function blendEvs(walks: { f: number; ev: number | undefined }[][]): (number | undefined)[] {
  const n = walks[0]?.length ?? 0;
  return Array.from({ length: n }, (_, a) => blendEv(walks.map((w) => w[a] ?? { f: 0, ev: undefined })));
}

/** True when this field could not be collapsed and the caller must say so rather than guess. */
export const collapseRefusal = (seats: CollapseSeat[], streets: SeatTok[][]): string => {
  const stuck = seats.filter((s) => streets.some((st) => st.some((t) => t.seat === s.pos && COMMITS(t.tok))));
  return `${seats.length} players are in the hand and no collapse to three seats is legal — ` +
    `${stuck.map((s) => s.pos).join(", ")} already have chips in on this street, and no two villains sit ` +
    `adjacent with hero outside them`;
};

export { isFree as tokenIsFree };
