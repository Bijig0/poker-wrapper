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
  /** "ghost:CO", "merge:HJ+CO", "ghost:CO+merge:SB+BB" — what was done, for the answer's warning */
  kind: string;
  /** exactly three seats, in postflop order */
  seats: CollapseSeat[];
  /** hero's index within `seats` */
  heroIdx: number;
  /** the walked streets with the dropped seats' tokens removed and merged pairs reduced to one actor */
  streets: SeatTok[][];
  /** how many primitives were applied — 1 for a four-way flop, 2 for five-way */
  steps: number;
  /** true when every primitive was a GHOST (what the blend was measured on) */
  ghostOnly: boolean;
}

const COMMITS = (tok: string) => tok !== "X" && tok !== "F";
const isFree = (tok: string) => tok === "X" || tok === "F";

interface State {
  seats: CollapseSeat[];
  heroPos: string;
  streets: SeatTok[][];
  kinds: string[];
  ghostOnly: boolean;
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
  };
}

/** MERGE: adjacent villains `a` and `a+1` become one seat. Legal while the pair commits at most once a street. */
function merge(st: State, a: number): State | null {
  const x = st.seats[a]!;
  const y = st.seats[a + 1];
  if (!y) return null;
  if (x.pos === st.heroPos || y.pos === st.heroPos) return null;   // hero is never merged away
  const pair = new Set([x.pos, y.pos]);

  const streets: SeatTok[][] = [];
  let carrier: string | null = null;
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
    const orbits: { at: number; toks: string[] }[] = [];
    street.forEach((t, i) => {
      if (!pair.has(t.seat)) return;
      const n = nth.get(t.seat) ?? 0;
      nth.set(t.seat, n + 1);
      (orbits[n] ??= { at: i, toks: [] }).toks.push(t.tok);
    });
    const emit = new Map<number, string>();
    for (const o of orbits) {
      const commit = o.toks.find(COMMITS);
      emit.set(o.at, commit ?? (o.toks.includes("X") ? "X" : o.toks[0]!));
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
  };
}

/**
 * Every distinct way to bring `seats` down to three, cheapest primitive first. Returns [] when the field
 * cannot be collapsed at all — every villain has chips in this street and no pair is mergeable.
 */
export function planCollapses(
  seats: CollapseSeat[],
  heroPos: string,
  streets: SeatTok[][]
): CollapsePlan[] {
  const start: State = { seats, heroPos, streets, kinds: [], ghostOnly: true };
  const out: CollapsePlan[] = [];
  const seen = new Set<string>();

  const walk = (st: State): void => {
    if (st.seats.length === 3) {
      const heroIdx = st.seats.findIndex((s) => s.pos === st.heroPos);
      if (heroIdx < 0) return;
      // The RANGES are part of the identity, not just the shape: ghosting a villain who only checked and
      // merging him into his neighbour leave the same seats and the same tokens, but the merged seat carries
      // both ranges. Keying on shape alone silently threw the merge away as a duplicate.
      const key = st.seats.map((s) => `${s.pos}:${s.range.reduce((a, b) => a + b, 0).toFixed(3)}`).join("/") + "|" +
        st.streets.map((x) => x.map((t) => `${t.seat}${t.tok}`).join(",")).join(";");
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        kind: st.kinds.join(" + "), seats: st.seats, heroIdx, streets: st.streets,
        steps: st.kinds.length, ghostOnly: st.ghostOnly,
      });
      return;
    }
    if (st.seats.length < 3) return;
    for (let i = 0; i < st.seats.length; i++) {
      const g = ghost(st, i);
      if (g) walk(g);
    }
    for (let i = 0; i + 1 < st.seats.length; i++) {
      const m = merge(st, i);
      if (m) walk(m);
    }
  };
  walk(start);
  // ghost-only plans first (what the blend was calibrated on), then fewest primitives
  out.sort((a, b) => Number(b.ghostOnly) - Number(a.ghostOnly) || a.steps - b.steps || a.kind.localeCompare(b.kind));
  return out;
}

export interface Picked {
  plans: CollapsePlan[];
  /** "blend" combines them; "single" means the one plan's strategy is used as-is */
  mode: "blend" | "single";
  why: string;
}

/**
 * The shipped policy, straight off the calibration: blend two or more GHOST plans; failing that take a MERGE;
 * failing that the single ghost. `max` bounds the cloud cost — each plan is one full chain walk.
 */
export function pickCollapses(plans: CollapsePlan[], max = 3): Picked | null {
  if (!plans.length) return null;
  const ghosts = plans.filter((p) => p.ghostOnly);
  if (ghosts.length >= 2) {
    return {
      plans: ghosts.slice(0, max), mode: "blend",
      why: `${Math.min(ghosts.length, max)} independent collapses blended (measured 0.008bb vs the true tree; ` +
        `a single collapse costs 0.020-0.066bb)`,
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

/** True when this field could not be collapsed and the caller must say so rather than guess. */
export const collapseRefusal = (seats: CollapseSeat[], streets: SeatTok[][]): string => {
  const stuck = seats.filter((s) => streets.some((st) => st.some((t) => t.seat === s.pos && COMMITS(t.tok))));
  return `${seats.length} players are in the hand and no collapse to three seats is legal — ` +
    `${stuck.map((s) => s.pos).join(", ")} already have chips in on this street, and no two villains sit ` +
    `adjacent with hero outside them`;
};

export { isFree as tokenIsFree };
