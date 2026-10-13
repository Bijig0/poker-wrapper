/**
 * A HAND RE-ROOTED AT STREET S STAYS RE-ROOTED AT S (2026-10-14, Brady: "I don't care about upfront cost, just want the
 * one with the best final performance").
 *
 * multiwayReroot.rerootCollapse re-roots a 4+ way hand that no collapse fits from the flop at the CURRENT street. Every
 * decision used to do that again at ITS street, so a later decision of the hand reused nothing the earlier one computed:
 *   1. a hand re-rooted at the turn was re-rooted AGAIN at the river — the turn's chain (first street 1) and its
 *      checkpoints were abandoned, the river's entering ranges came from NEW narrowing walks over flop + turn, and hero's
 *      own turn action was narrowed by that walk's tree, not by the tree he was answered on;
 *   2. the narrowing walks carried no hand key — nothing they computed was checkpointed, and a walk that failed on one
 *      decision and not the next gave a different "not narrowed" entering range, so a different root;
 *   3. the re-rooted street's collapses were picked afresh every decision — a villain who folded after hero's first
 *      decision on it left from the street's root (`fold:X`): new trees, every checkpoint missed.
 *
 * Now the hand remembers its re-root (RerootFact — in handFacts on the hand's own `<hand>#reroot` row: memory first,
 * the disk after an API restart): the street, the entering ranges exactly as narrowed, the pot / stacks entering it and
 * the collapse plans (their recipes, multiwayCollapse.PlanRecipe). A later decision of the hand runs the SAME chain —
 * the same first street, seats, ranges, pot, stack and plan names — with the streets since appended (keptReroot), so
 * aiChain's root key is the one the earlier decision walked under: its closed-street checkpoints and hero's mid-street
 * resume point hit, and hero's earlier action is conditioned from the node he was answered on.
 *
 * The kept plans are replayed on the tokens since (multiwayCollapse.replayPlan): a villain who folds since folds INSIDE
 * the trees that kept him; a plan that no longer holds (a ghosted seat put chips in, a merged member folded) is dropped
 * and, when that leaves a villain in no tree, the pick is topped back up, coverPick's way, with legal plans on the kept
 * streets so every villain is in at least one tree again; nothing left → picked afresh on the kept streets (and that pick is kept). Only when the kept re-root cannot
 * stand — the capture of an earlier street changed, the ranges or money reaching the flop changed, hero's seat
 * changed, nothing collapses on the kept streets, a dead-money street would have to carry into the next — the decision
 * re-roots afresh, as before, and says why (RerootResult.notKept → path code postflop:reroot-not-kept).
 * REROOT_KEEP=off: every decision re-roots at its own street, its narrowing walks unkeyed (the behaviour before).
 */
import { handFacts } from "./handFacts";
import { foldedSeats, keptVillains, pickCollapses, planCollapses, replayPlan, type CollapsePlan, type CollapseSeat, type PlanRecipe, type Picked, type SeatTok } from "./multiwayCollapse";
import { pickDeadMoney, planDeadMoney } from "./deadMoneyCollapse";
import type { RerootArgs, RerootResult, WalkFailure } from "./multiwayReroot";

const STREET = ["flop", "turn", "river"] as const;

/** REROOT_KEEP=off: re-root afresh at every decision (and the narrowing walks run without the hand's key) */
export const rerootKeepOn = (): boolean => process.env.REROOT_KEEP !== "off";

/** What a hand's re-root was answered on — enough to run the same chain at every later decision of the hand. */
export interface RerootFact {
  v: 1;
  heroPos: string;
  /** the street re-rooted at: 1 turn, 2 river */
  first: 1 | 2;
  /** the streets before it as the capture read them then: the kept re-root holds while it still reads them so */
  earlier: { streets: string[][]; seats: string[][]; amounts: string };
  /** the inputs the money and the narrowing rested on (rerootBasis): the seats, the ranges reaching the flop, pot, stacks, board */
  basis: string;
  pot: number;
  stack: number;
  /** each seat's stack behind entering the street (moneyThrough) — the dead-money collapse prices with it */
  behind: Record<string, number>;
  /** fastSolve gave the seats' own stacks (RerootArgs.behind): the result carries `behind` */
  hasBehind: boolean;
  allIn: string[];
  /** the seats in the tree(s) → the range entering the street, Float64 base64: exact (aiChain's root key hashes it) */
  ranges: Record<string, string>;
  /** the collapse plans by name and recipe; null = a dead-money collapse (re-picked on its own street only) */
  plans: { kind: string; recipe: PlanRecipe }[] | null;
  mode: Picked["mode"];
  /** the pick's own why (without the keep clauses) */
  why: string;
  walks: number;
  left: string;
  unnarrowed?: string[];
  failedWalks?: WalkFailure[];
  at: number;
}

const hashOf = (x: unknown): string => Bun.hash(JSON.stringify(x)).toString(36);
const encodeRange = (r: number[]): string => Buffer.from(new Float64Array(r).buffer).toString("base64");
/** copied into a fresh buffer: a pooled Buffer's offset need not be 8-aligned */
const decodeRange = (s: string): number[] => Array.from(new Float64Array(new Uint8Array(Buffer.from(s, "base64")).buffer));
const amountsKey = (am: (number | null)[][] | undefined, first: number): string =>
  JSON.stringify((am ?? []).slice(0, first).map((st) => (st && st.some((x) => x != null) ? st : null)));
const same = (x: readonly unknown[] | undefined, y: readonly unknown[] | undefined): boolean =>
  JSON.stringify(x ?? []) === JSON.stringify(y ?? []);

/** The inputs a re-root at `first` rests on besides the earlier streets' tokens: who reached the flop with which range,
 *  the pot and stacks there, the board through the re-rooted street, the rake. */
export function rerootBasis(a: RerootArgs, first: number): string {
  return hashOf([a.ordered, a.heroPos, a.flopPot, a.flopStack, a.behind ?? null, a.board.slice(0, 6 + 2 * first), a.rake ?? null,
    a.ordered.map((p) => hashOf(a.arr(p)))]);
}

/** The hand's kept re-root, or undefined (none, switched off, no key). */
export function keptRerootFact(handKey: string | undefined): RerootFact | undefined {
  return handKey && rerootKeepOn() ? handFacts.reroot(handKey) : undefined;
}
export function saveRerootFact(handKey: string, fact: RerootFact): void { handFacts.setReroot(handKey, fact); }
export function forgetRerootFact(handKey: string): void { handFacts.forgetReroot(handKey); }

/** The fact for a re-root just made (multiwayReroot.rerootCollapse's fresh path). */
export function rerootFactOf(a: RerootArgs, r: Extract<RerootResult, { ok: true }>, live: string[], ranges: Record<string, number[]>,
    mBehind: Record<string, number>, pickWhy: string): RerootFact {
  return {
    v: 1, heroPos: a.heroPos, first: r.first,
    earlier: { streets: a.streets.slice(0, r.first), seats: a.streetSeats.slice(0, r.first), amounts: amountsKey(a.amounts, r.first) },
    basis: rerootBasis(a, r.first), pot: r.pot, stack: r.stack, behind: mBehind, hasBehind: !!a.behind, allIn: r.allIn,
    ranges: Object.fromEntries(live.map((p) => [p, encodeRange(ranges[p]!)])),
    // a plan with no recipe is the "seats still in" tree: replayed as nothing dropped
    plans: r.dead ? null : r.picked.plans.map((p) => ({ kind: p.kind, recipe: p.recipe ?? { folds: [], ops: [] } })),
    mode: r.picked.mode, why: pickWhy, walks: r.walks, left: r.left,
    ...(r.unnarrowed ? { unnarrowed: r.unnarrowed } : {}), ...(r.failedWalks ? { failedWalks: r.failedWalks } : {}),
    at: Date.now(),
  };
}

/** a plan's tree: its seats (a merged seat by its members) and the tokens it walks — two plans with one tree are one */
const treeOf = (p: CollapsePlan): string =>
  `${p.seats.map((s) => (s.members ?? [s.pos]).join("+")).join("/")}|${p.streets.map((st) => st.map((t) => `${t.seat}${t.tok}`).join(",")).join(";")}`;

/**
 * THE SURVIVORS TOPPED BACK UP (coverPick's greedy rule, seeded with the plans that still hold): while a villain some
 * legal plan keeps is in no plan taken, and fewer than `max` are taken, add the legal ghost-only plan keeping the most
 * such villains (ties to the earlier, planCollapses' order) — so every villain is in at least one tree again. Only to
 * restore the cover: a plan that adds no villain is a new tree from the root (a fold taken out at the street's start)
 * that the kept trees already hold, better, with the fold inside them.
 */
export function topUpCollapses(survivors: CollapsePlan[], fresh: CollapsePlan[], max: number): { plans: CollapsePlan[]; added: CollapsePlan[] } {
  const have = new Set(survivors.map(treeOf));
  const left = fresh.filter((p) => p.ghostOnly && !have.has(treeOf(p)));
  const out = survivors.slice();
  const kept = new Set(out.flatMap(keptVillains));
  const added: CollapsePlan[] = [];
  while (out.length < max && left.length) {
    let best = 0, bestGain = 0;
    left.forEach((p, i) => {
      const gain = new Set(keptVillains(p).filter((v) => !kept.has(v))).size;
      if (gain > bestGain) { best = i; bestGain = gain; }
    });
    if (!bestGain) break;
    const p = left.splice(best, 1)[0]!;
    out.push(p); added.push(p);
    for (const v of keptVillains(p)) kept.add(v);
  }
  return { plans: out, added };
}

/**
 * THE KEPT RE-ROOT ON THIS DECISION: the same chain as the hand's earlier decision, the streets since appended — or why
 * it cannot stand (the caller re-roots afresh and says so).
 */
export function keptReroot(a: RerootArgs, f: RerootFact):
    { ok: true; result: Extract<RerootResult, { ok: true }>; fact: RerootFact } | { ok: false; why: string } {
  const at = STREET[f.first];
  const now = a.streets.length - 1;
  if (f.heroPos !== a.heroPos) return { ok: false, why: `hero sits ${a.heroPos} now, ${f.heroPos} when the hand was re-rooted at the ${at}` };
  if (now < f.first || now > 2) return { ok: false, why: `the capture is on the ${STREET[now] ?? `street ${now}`}, not at or past the ${at} the hand was re-rooted at` };
  for (let i = 0; i < f.first; i++) {
    if (!same(f.earlier.streets[i], a.streets[i]) || !same(f.earlier.seats[i], a.streetSeats[i])) {
      return { ok: false, why: `the ${STREET[i]} was [${(f.earlier.streets[i] ?? []).join(",")}] when the hand was re-rooted at the ${at}, the capture now says [${(a.streets[i] ?? []).join(",")}]` };
    }
  }
  if (f.earlier.amounts !== amountsKey(a.amounts, f.first)) return { ok: false, why: `the all-in amounts of the streets before the ${at} changed on the capture since the hand was re-rooted there` };
  if (rerootBasis(a, f.first) !== f.basis) return { ok: false, why: `the ranges, pot or stacks reaching the flop changed since the hand was re-rooted at the ${at}` };
  const live = a.ordered.filter((p) => f.ranges[p] != null);
  const seats: CollapseSeat[] = live.map((p) => ({ pos: p, range: decodeRange(f.ranges[p]!) }));
  const cur: SeatTok[][] = a.streets.slice(f.first).map((st, i) => st.map((tok, j) => ({ tok, seat: a.streetSeats[f.first + i]![j]! })));
  const stranger = cur.flat().find((t) => f.ranges[t.seat] == null);
  if (stranger) return { ok: false, why: `${stranger.seat} acts since the ${at} but was not in the hand's re-rooted trees` };
  const span = now === f.first ? `the ${at}` : `the ${at} and ${STREET[now]}`;

  let picked: Picked;
  let pickWhy = f.why;
  let plans = f.plans;
  let dead = false;
  if (!f.plans) {
    // A DEAD-MONEY STREET is priced on its own tokens (deadMoneyCollapse): re-picked on the kept ranges, its street only
    if (now !== f.first) return { ok: false, why: `the ${at} was answered on a dead-money collapse, which does not carry into the ${STREET[now]}` };
    const dm = planDeadMoney({ seats, heroPos: a.heroPos, street: cur[0]!, amounts: a.amounts?.[f.first] ?? null, behind: (p) => f.behind[p] });
    const dp = pickDeadMoney(dm.plans);
    if (!dp) return { ok: false, why: `the ${at}'s dead-money collapse no longer fits (${dm.why})` };
    picked = dp; dead = true; pickWhy = dp.why;
  } else {
    const replayed = f.plans.map((p) => {
      const r = replayPlan(seats, a.heroPos, cur, p.recipe);
      return r ? { ...r, kind: p.kind, recipe: p.recipe } : null;   // the kept name: the chain's plan tag
    });
    const survivors = replayed.filter((p): p is NonNullable<typeof p> => !!p);
    const dropped = f.plans.filter((_, i) => !replayed[i]).map((p) => p.kind);
    if (!dropped.length) {
      picked = { plans: survivors, mode: f.mode, why: f.why };
    } else {
      const fresh = planCollapses(seats, a.heroPos, cur);
      const lost = `${dropped.join(", ")} no longer hold${dropped.length === 1 ? "s" : ""} (a seat it dropped has put chips in, or a merged seat's member folded)`;
      if (!survivors.length) {
        const p = pickCollapses(fresh);
        if (!p) return { ok: false, why: `no collapse kept from the ${at} still holds (${lost}) and none fits ${span} afresh` };
        picked = p; pickWhy = `${p.why}; picked afresh on ${span} — ${lost}`;
      } else {
        const t = topUpCollapses(survivors, fresh, f.plans.length);
        pickWhy = t.plans.length > 1
          ? `${t.plans.length} independent collapses blended (measured 0.008bb vs the true tree; a single collapse costs 0.020-0.066bb)`
          : "only one collapse of this field still holds (measured 0.020-0.066bb vs the true tree)";
        pickWhy += `; ${lost} — dropped${t.added.length ? `, ${t.added.map((p) => p.kind).join(", ")} added so every villain is in at least one tree` : ""}`;
        picked = { plans: t.plans, mode: t.plans.length > 1 ? "blend" : "single", why: pickWhy };
      }
      plans = picked.plans.map((p) => ({ kind: p.kind, recipe: p.recipe ?? { folds: [], ops: [] } }));
    }
  }
  // the villains who folded since without chips: inside the kept trees, not out of their roots
  const since = plans ? foldedSeats(seats, a.heroPos, cur).filter((v) => !plans!.some((p) => p.recipe.folds.includes(v))) : [];
  const keepClause = `the hand stays re-rooted at the ${at} (kept from its earlier decision: the same entering ranges, ${f.pot}bb pot and ` +
    `${f.stack}bb behind — the trees ${now === f.first ? "it walked" : `it walked on the ${at}, the ${STREET[now]} appended`})` +
    (since.length ? `; ${since.join(", ")} folded since, inside the trees that hold ${since.length === 1 ? "him" : "them"}` : "");
  const fact: RerootFact = { ...f, plans, mode: picked.mode, why: pickWhy, at: Date.now() };
  return {
    ok: true, fact,
    result: {
      ok: true, picked: { ...picked, why: `${pickWhy}; ${keepClause}` }, first: f.first, pot: f.pot, stack: f.stack, walks: f.walks, left: f.left,
      allIn: f.allIn, ...(f.hasBehind ? { behind: f.behind } : {}), ...(dead ? { dead: true } : {}),
      ...(f.unnarrowed ? { unnarrowed: f.unnarrowed } : {}), ...(f.failedWalks ? { failedWalks: f.failedWalks } : {}),
      kept: keepClause,
    },
  };
}
