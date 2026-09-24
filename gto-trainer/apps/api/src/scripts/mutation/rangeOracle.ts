/**
 * THE RANGE-LEVEL ORACLE (2026-09-25, round 2 of the input-mutation harness). Round 1's oracle checked that a solver
 * input EXISTS with the dealt pot and the right flop seats; a 25bb jam read as the chart's 2.5bb open passed it
 * (seed 2053, caught by hand). These checks look at what the input SAYS:
 *
 * LAYER 1 — invariants that need no reference (each its own finding kind):
 *   hero-combo-zero      hero's actual combo has weight 0 in the range array the tree is built with
 *   range-widened        a seat's range grew at one of its own decisions (a walk may only narrow a range)
 *   jam-on-raise         an all-in that raised was conditioned on a normal raise, or a normal action on the all-in
 *   step-action-mismatch a seat's range was conditioned on an action that seat did not take (a call read as a jam,
 *                        a raise read as a call, another seat's action handed to it)
 *   size-past-tolerance  a size the range was conditioned on is further than τ (utils/snapToken SNAP_TAU) from the
 *                        size played
 *   size-snap-unreported a size the tree does not have (beyond snapToken's on-tree tolerance) and the answer's note
 *                        does not say a size was snapped
 *   range-provenance     a seat's solver-input range is not the output of any chart walk the pipeline made
 *   range-product        the product of the chart's own per-class frequencies along that walk (nodes read afresh from
 *                        the chart) does not reproduce the seat's weights
 *   tree-range-mismatch  the 1326-combo array a tree seat is built with is not that seat's class range
 * LAYER 2 — the reference walker (./referenceRanges.ts), an independent walk of the SAME chart on the DEALT line:
 *   range-mismatch       a flop seat's range differs from the reference beyond RANGE_TOL and the answer's note names
 *                        no approximation that explains it (fitted line, borrowed caller, chart kept, off the chart…)
 *   reference-unwalkable the reference cannot walk the dealt line on that chart, and the answer names no approximation
 *   preflop-node-mismatch a preflop answer read at a node other than the reference's, with no approximation named
 */
import { SNAP_TAU } from "../../utils/snapToken/snapToken";
import { buildRangeArray } from "../../utils/buildRangeArray/buildRangeArray";
import { classWeightsToSpec, type RawNode, type RecordedRangeWalk } from "../../utils/reconstructFlopRanges/reconstructFlopRanges";
import { comboIndex } from "../../utils/comboIndex/comboIndex";
import { referenceRanges, rangeDiff, type RefAction } from "./referenceRanges";

export interface OracleFinding { kind: string; reason: string }
export interface OracleStats { explained: number; compared: number; refUnwalkable: number }

/** A difference smaller than this (per class weight) is the same range. */
export const RANGE_TOL = 0.02;
/** The approximations an answer can name, which make its ranges legitimately differ from a plain walk of the dealt line. */
export const APPROX_NOTE = /LINE FITTED|fitted line|RANGE SHORTCUT|borrow|CALLER CAP|CHART KEPT|LINE KEPT|OFF THE CHART|ALL-IN PREFLOP|tree in the set/i;
/**
 * DOES THE NOTE EXPLAIN THIS SEAT? A difference on one seat is excused only by an approximation that touches that
 * seat: a fit or borrow that names it ("BB with BTN folded", "BB: BTN's call … borrowed", "BB's call … not in the
 * tree"), hero's own decision read on a fitted/borrowed/kept line (hero only), or a different chart altogether (every
 * seat). A fit naming another seat does not excuse this one.
 */
export function explainsSeat(note: string, seat: string, isHero: boolean): boolean {
  const P = seat.toUpperCase();
  // a different chart, or every range read on the pin's fitted line ("these ranges are read on that line"): all seats
  if (/tree in the set|these ranges are read on that line/i.test(note)) return true;
  if (new RegExp(`${P} with [A-Z+]+ folded|${P}: |${P}'s call at "[^"]*" is not in the tree`).test(note)) return true;
  if (isHero && /hero's decision was read on a line fitted|CALLER CAP|LINE KEPT|CHART KEPT|OFF THE CHART/.test(note)) return true;
  return false;
}

/** An answer that says a size was moved onto the tree. */
export const SNAP_NOTE = /snapped|SNAPPED/;

const jam = (l: string) => /all-?in/i.test(l);
const sizeOf = (t: string | null | undefined): number | null => { const m = /^R([\d.]+)$/.exec(t ?? ""); return m ? Number(m[1]) : null; };
const onTree = (want: number, got: number) => Math.abs(want - got) <= Math.max(0.05, want * 0.025);

/** The truth's preflop actions as the reference reads them (posts dropped; an all-in that did not raise is a call). */
export function truthLine(actions: { street: number; seat: number; type: string; amount?: number }[], posOf: (seat: number) => string): RefAction[] {
  const out: RefAction[] = [];
  let level = 1;
  // a POSTED-IN player's option-check is read as a limp (utils/foldPostIns, Brady 2026-09-25: the documented
  // approximation, said in the answer as "POSTED IN (approximation)") — the reference walks the line the same way
  const posters = new Set(actions.filter((a) => a.street === 0 && a.type === "post").map((a) => a.seat));
  for (const a of actions) {
    if (a.street !== 0 || a.type === "post-sb" || a.type === "post-bb" || a.type === "post") continue;
    const pos = posOf(a.seat);
    const poster = posters.delete(a.seat);
    if (a.type === "fold") out.push({ pos, kind: "F" });
    else if (a.type === "check") out.push({ pos, kind: poster ? "C" : "X" });
    else if (a.type === "call") out.push({ pos, kind: "C" });
    else if (a.type === "all-in") {
      const to = a.amount ?? 0;
      if (to > level + 0.01) { out.push({ pos, kind: "A", to }); level = to; } else out.push({ pos, kind: "C" });
    } else { const to = a.amount ?? 0; out.push({ pos, kind: "R", to }); level = Math.max(level, to); }
  }
  return out;
}

const sameRange = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => Math.abs((b[k] ?? -1) - v) < 1e-12);

/**
 * Layer 1 over the recorded walks of one postflop dry run. `get` reads the chart the ranges came from, afresh.
 */
export async function layer1(o: {
  truth: RefAction[]; heroPos: string; heroCards: [string, string]; note: string;
  dry: { ranges?: Record<string, Record<string, number>>; trees?: { kind: string | null; heroSeat: string; seats: { pos: string; range: number[] }[] }[]; flopSeats: string[] };
  walks: RecordedRangeWalk[]; get: ((line: string) => Promise<RawNode | null>) | null;
}): Promise<OracleFinding[]> {
  const out: OracleFinding[] = [];
  const say = (kind: string, reason: string) => { if (!out.some((f) => f.kind === kind)) out.push({ kind, reason }); };
  const hero = o.heroPos.toUpperCase();
  // hero's combo in the arrays the trees are built with
  const idx = comboIndex(o.heroCards[0], o.heroCards[1]);
  for (const t of o.dry.trees ?? []) {
    const at = t.heroSeat === "oop" ? 0 : t.heroSeat === "ip" ? t.seats.length - 1 : 1;
    const seat = t.seats[at];
    if (seat && !(seat.range[idx]! > 0)) say("hero-combo-zero", `hero's ${o.heroCards.join("")} has weight 0 in the ${t.kind ?? "tree"}'s ${seat.pos} range (hero seat ${t.heroSeat})`);
    // each seat's array must be its own class range (a plain tree; a merged/collapsed seat is its own composite)
    if (t.kind == null && o.dry.ranges) for (const s of t.seats) {
      const r = Object.entries(o.dry.ranges).find(([p]) => p.toUpperCase() === s.pos.toUpperCase())?.[1];
      if (!r) { say("tree-range-mismatch", `tree seat ${s.pos} has no range among the walked seats (${Object.keys(o.dry.ranges).join("/")})`); continue; }
      const want = buildRangeArray(classWeightsToSpec(r));
      const bad = want.findIndex((w, i) => Math.abs(w - (s.range[i] ?? 0)) > 1e-9);
      if (bad >= 0) say("tree-range-mismatch", `tree seat ${s.pos}'s array differs from its class range at combo ${bad} (${s.range[bad]} vs ${want[bad]})`);
    }
  }
  if (!o.dry.ranges) return out;
  // provenance: each flop seat's range is the output of one recorded walk
  const okWalks = o.walks.filter((w) => w.result.ok);
  const truthBy = new Map<string, RefAction[]>();
  for (const a of o.truth) (truthBy.get(a.pos) ?? truthBy.set(a.pos, []).get(a.pos)!).push(a);
  for (const pos of o.dry.flopSeats) {
    const P = pos.toUpperCase();
    const mine = Object.entries(o.dry.ranges).find(([p]) => p.toUpperCase() === P)?.[1];
    if (!mine) continue;
    const walk = okWalks.find((w) => { const r = w.result.ok ? Object.entries(w.result.ranges).find(([p]) => p.toUpperCase() === P)?.[1] : undefined; return !!r && sameRange(r, mine); });
    if (!walk) { say("range-provenance", `${P}'s solver-input range is the output of none of the ${okWalks.length} chart walk(s) the answer made`); continue; }
    const steps = walk.steps.filter((s) => s.pos.toUpperCase() === P);
    const truth = truthBy.get(P) ?? [];
    let level = 1;
    for (let j = 0; j < steps.length; j++) {
      const s = steps[j]!;
      // widening
      if (s.rangeIn && s.rangeOut) {
        const grew = Object.entries(s.rangeOut).find(([c, w]) => w > (s.rangeIn![c] ?? 0) + 1e-9);
        if (grew) say("range-widened", `${P}'s ${grew[0]} grew from ${s.rangeIn[grew[0]] ?? 0} to ${grew[1]} at "${s.line}" (${s.label})`);
      }
      const t = truth[j];
      if (s.token === "F") continue;     // a fitted fold-out: the seat's later actions leave the line with it
      if (!t) { say("step-action-mismatch", `${P}'s range read a ${s.label} at "${s.line}" — the seat took no ${j + 1}th preflop action`); continue; }
      const kindOk = t.kind === "C" ? s.token === "C" : t.kind === "X" ? s.token === "X" : t.kind === "F" ? false
        : t.kind === "A" ? jam(s.label) : sizeOf(s.token) != null;
      if (!kindOk) {
        say(t.kind === "A" || jam(s.label) ? "jam-on-raise" : "step-action-mismatch",
          `${P}'s ${j + 1}th preflop action was ${t.kind === "A" ? `an all-in to ${t.to}` : t.kind === "R" ? `a raise to ${t.to}` : t.kind}, its range was conditioned on "${s.label}" at "${s.line || "root"}"`);
        continue;
      }
      if (t.kind === "R") {
        const got = sizeOf(s.token)!;
        if (jam(s.label)) { /* a raise read as the all-in: the nearest size was the jam — a size question, below */ }
        const d = Math.abs(Math.log(t.to! / got));
        if (d > SNAP_TAU) say("size-past-tolerance", `${P}'s raise to ${t.to} was conditioned on ${s.token} (${s.label}) at "${s.line || "root"}", ${d.toFixed(2)} log-distance (τ ${SNAP_TAU})`);
        else if (!onTree(t.to!, got) && !SNAP_NOTE.test(o.note)) say("size-snap-unreported", `${P}'s raise to ${t.to} was read as ${s.token} at "${s.line || "root"}" and the answer does not say a size was snapped`);
        level = Math.max(level, t.to!);
      }
      void level;
      // hero's own raise must be read on his exact label, a villain's on every non-jam size (the documented merge)
      if (P === hero && s.labels.length !== 1) say("step-action-mismatch", `hero's range at "${s.line}" was conditioned on ${s.labels.length} labels (${s.labels.join(", ")}), not his own`);
    }
    // the product of the chart's own frequencies along this walk, nodes read afresh
    if (o.get) {
      let w: Record<string, number> | null = null;
      for (const s of steps) {
        if (s.token === "F") { w = {}; break; }
        const node = await o.get(s.line);
        if (!node) { say("range-product", `${P}'s walk read "${s.line || "root"}", which the chart does not hold`); w = null; break; }
        if (String(node.pos ?? "").toUpperCase() !== P) { say("range-product", `${P}'s range was conditioned at "${s.line || "root"}", which is ${node.pos}'s node in the chart`); w = null; break; }
        const next: Record<string, number> = {};
        for (const c of node.cells) {
          const pct = s.labels.reduce((acc, l) => acc + (c.actions[l] ?? 0), 0);
          const prior = w ? w[c.hand] ?? 0 : 1;
          if (pct > 0 && prior > 0) next[c.hand] = prior * Math.min(1, pct / 100);
        }
        w = next;
      }
      if (w) {
        const d = rangeDiff(w, mine);
        if (d.max > 1e-6) say("range-product", `${P}'s ${d.cls}: the chart's frequencies along the walk give ${d.a.toFixed(4)}, the solver input holds ${d.b.toFixed(4)}`);
      }
    }
  }
  return out;
}

/**
 * Layer 2 for a postflop dry run: every tree seat's range against the reference walk of the dealt line on the same
 * chart. Returns the findings and whether a difference was explained by a named approximation.
 */
export async function layer2Postflop(o: {
  truth: RefAction[]; dealt: string[]; heroPos: string; note: string;
  dry: { ranges?: Record<string, Record<string, number>>; flopSeats: string[] };
  get: (line: string) => Promise<RawNode | null>;
}): Promise<{ findings: OracleFinding[]; explained: boolean; unwalkable: boolean; why?: string }> {
  const findings: OracleFinding[] = [];
  const approx = APPROX_NOTE.test(o.note);
  const ref = await referenceRanges(o.truth, o.get, { dealt: o.dealt, heroPos: o.heroPos });
  if (!ref.ok) {
    if (!approx) findings.push({ kind: "reference-unwalkable", reason: `the reference cannot walk the dealt line (${ref.why}) and the answer names no approximation` });
    return { findings, explained: approx, unwalkable: true, why: `unwalkable: ${ref.why} | ${(o.note.match(APPROX_NOTE) ?? [""])[0]}` };
  }
  let explained = false;
  let why: string | undefined;
  for (const pos of o.dry.flopSeats) {
    const P = pos.toUpperCase();
    const mine = Object.entries(o.dry.ranges ?? {}).find(([p]) => p.toUpperCase() === P)?.[1];
    const theirs = ref.ranges[P];
    if (!mine || !theirs) { findings.push({ kind: "range-mismatch", reason: `${P} is a flop seat of the ${mine ? "pipeline" : "reference"} only (reference at the flop: ${ref.atFlop.join("/")})` }); continue; }
    const d = rangeDiff(mine, theirs);
    if (d.max <= RANGE_TOL) continue;
    if (explainsSeat(o.note, P, P === o.heroPos.toUpperCase())) { explained = true; why ??= `${P} ${d.cls} ${d.a.toFixed(3)} vs ${d.b.toFixed(3)} | ${(o.note.match(APPROX_NOTE) ?? [""])[0]}`; continue; }
    findings.push({ kind: "range-mismatch", reason: `${P}'s ${d.cls} is ${d.a.toFixed(3)} in the solver input, ${d.b.toFixed(3)} on the reference walk "${ref.path.join("-")}"` });
  }
  return { findings, explained, unwalkable: false, why };
}

/** Layer 2 for a preflop answer: hero's node against the reference's pending node on the same chart. */
export async function layer2Preflop(o: {
  truth: RefAction[]; dealt: string[]; heroPos: string; note: string; line: string; get: (line: string) => Promise<RawNode | null>;
}): Promise<{ findings: OracleFinding[]; explained: boolean }> {
  const approx = APPROX_NOTE.test(o.note);
  const ref = await referenceRanges(o.truth, o.get, { dealt: o.dealt, heroPos: o.heroPos, pending: true });
  const mine = o.line === "(root)" ? "" : o.line;
  if (!ref.ok) return { findings: approx ? [] : [{ kind: "reference-unwalkable", reason: `the reference cannot walk to hero's decision (${ref.why}); the answer read "${mine || "root"}" and names no approximation` }], explained: approx };
  const theirs = ref.path.join("-");
  if (theirs === mine) {
    // the same node: its sizes are the reference's nearest ones — every one must be within τ, and a moved one said
    const f: OracleFinding[] = [];
    for (const s of ref.steps) {
      if (s.kind !== "R") continue;
      const got = sizeOf(s.token); if (got == null) continue;
      const d = Math.abs(Math.log(s.to! / got));
      if (d > SNAP_TAU) f.push({ kind: "size-past-tolerance", reason: `${s.pos}'s raise to ${s.to} was answered at ${s.token} (${d.toFixed(2)} log-distance, τ ${SNAP_TAU}) at "${s.line || "root"}"` });
      else if (!onTree(s.to!, got) && !SNAP_NOTE.test(o.note)) f.push({ kind: "size-snap-unreported", reason: `${s.pos}'s raise to ${s.to} was answered as ${s.token} at "${s.line || "root"}" and the answer does not say a size was snapped` });
    }
    return { findings: f.slice(0, 1), explained: false };
  }
  if (approx) return { findings: [], explained: true };
  return { findings: [{ kind: "preflop-node-mismatch", reason: `hero's decision was read at "${mine || "root"}", the reference walk of the dealt line reaches "${theirs || "root"}"` }], explained: false };
}
