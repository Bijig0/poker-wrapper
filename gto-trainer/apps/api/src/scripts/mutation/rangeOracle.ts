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
 *   range-provenance     a seat's solver-input range is not the output of any chart walk the pipeline made (a seat
 *                        the note floors to a pool range: that range exactly, a seat that limped / cold-called a
 *                        3-bet, and the range it replaced a walk's output — poolFloorsOf)
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
import COLD_CALL_LOCKS from "../../services/poolColdCallLocks.json";
import POOL_CALL_LOCKS from "../../services/poolCallLocks.json";
import { COLD_CALL_FLOOR_COMBOS } from "../../services/poolColdCall";
import { limpLockRange } from "../../services/poolLimpFloor";
import { limpCallProduct, poolCallRange } from "../../services/poolCalls";

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
  // the ranges re-pick's own segments excuse nothing here ("RANGES RE-PICKED FOR BB: …" is not "BB: … borrowed"):
  // a re-picked seat is judged against the re-picked chart instead (layer2Postflop, repickOf)
  note = withoutRepick(note);
  // a different chart, or every range read on the pin's fitted line ("these ranges are read on that line"): all seats
  if (/tree in the set|these ranges are read on that line/i.test(note)) return true;
  if (new RegExp(`${P} with [A-Z+]+ folded|${P}: |${P}'s call at "[^"]*" is not in the tree`).test(note)) return true;
  // HERO'S OWN RANGE IS THE ANSWER'S (gtowAiPreflop.heroRangeAsAnswered, 2026-10-07): on a fitted GTO Wizard AI line
  // hero's flop range is the blend of the fits his answer was read on — the output of no single walk, hero only
  if (isHero && /hero's decision was read on a line fitted|CALLER CAP|LINE KEPT|CHART KEPT|OFF THE CHART|HERO'S OWN RANGE IS THE ANSWER'S/.test(note)) return true;
  return false;
}

/**
 * THE VILLAINS' RANGES RE-PICKED (round 2.1, services/preflopPin.repickVillainRanges): the seats the answer's note says
 * were read on another chart than the pinned one, and that chart. A seat's range read there is an EXPLAINED difference
 * from the pinned chart's reference only when the note names the re-pick FOR THAT SEAT — and then it must equal the
 * reference walk of the dealt line on the re-picked chart (layer2Postflop), and its walk replays on that chart (layer1).
 */
export function repickOf(note: string): { seats: string[]; chart: string } | null {
  const m = /RANGES RE-PICKED FOR ([A-Z]+(?:, [A-Z]+)*): .*? read on (\S+), the chart for the line as played/.exec(note);
  return m ? { seats: m[1]!.split(", "), chart: m[2]! } : null;
}
const withoutRepick = (note: string) => note.split(" · ").filter((s) => !/^RANGES RE-PICK/.test(s.trim())).join(" · ");

/**
 * THE POOL FLOORS (fastSolve, 2026-10-05): a short limper no chart covers (services/poolLimpFloor) and a 3-bet
 * cold-caller the walk left under 1% of hands (services/poolColdCall) enter the flop with the pool's measured range
 * instead of the walked one — by design (departures register: arrival:pool-limp-floor / arrival:pool-coldcall-floor),
 * said in the note. Such a seat's solver input must be the named pool range EXACTLY, and the range it replaced (the
 * note's "N combos on <chart>") is still one walk's output, judged as any other. Seat → the pool range and the floor.
 */
export interface PoolFloor {
  kind: "limp" | "coldcall" | "call"; key: string; was: number;
  /** a limp-table key: the table the answer was read from — the note's "v3: " tag after the key; none = v2 (every note
   *  before 2026-10-09, and LIMP_LOCKS=v2) */
  limpTable?: "v2" | "v3";
  /** a limp-caller (2026-10-09): the range is the named range × this one — the call overlay's "× his limp range <key>"
   *  (a limp-table key) or the floor's "× his limp-call rate <key>" (a call-table key) */
  times?: { kind: "limp" | "call"; key: string; limpTable?: "v2" | "v3" };
}
export function poolFloorsOf(note: string): Map<string, PoolFloor> {
  const out = new Map<string, PoolFloor>();
  // each "POOL … RANGE:" tag to the next (not the note's " · " separators: a GTO Wizard source id carries " · " itself)
  const heads = [...note.matchAll(/POOL (LIMP|COLD-CALL|CALL) RANGE: /g)];
  heads.forEach((h, i) => {
    const body = note.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1]!.index : undefined);
    // the pool-call overlay (services/poolCalls, 2026-10-07) names what the seat did in words; the shape is the floors'
    const re = /the ([A-Z]+) \(\d+bb\) [^—]*?— ([\d.]+) combos on .*?, now the pool's (\S+) \((v3: )?/g;
    const ms = [...body.matchAll(re)];
    ms.forEach((e, j) => {
      const kind = h[1] === "LIMP" ? "limp" : h[1] === "CALL" ? "call" : "coldcall";
      // the seat's own clause: up to the next seat's — a limp-caller's "× his …" multiplier sits inside it
      const seg = body.slice(e.index!, j + 1 < ms.length ? ms[j + 1]!.index : undefined);
      const tl = /× his limp range (\S+) \((v3: )?/.exec(seg);
      const tc = tl ? null : /× his limp-call rate (\S+) \(/.exec(seg);
      const times = tl ? { kind: "limp" as const, key: tl[1]!, limpTable: tl[2] ? "v3" as const : "v2" as const } : tc ? { kind: "call" as const, key: tc[1]! } : undefined;
      out.set(e[1]!, { kind, key: e[3]!, was: Number(e[2]), ...(kind === "limp" || (kind === "call" && !e[3]!.startsWith("poolcall_")) ? { limpTable: e[4] ? "v3" as const : "v2" as const } : {}), ...(times ? { times } : {}) });
    });
  });
  return out;
}
/** the pool's range for a floor's key, as class weights (null: the key is not in the pool's table) */
export function poolRangeOf(f: PoolFloor): Record<string, number> | null {
  // the call table as the overlay reads it (services/poolCalls — a test's injected table included), not the shipped JSON
  const callTable = { has: (k: string) => poolCallRange({ table: "call", key: k }) != null, get: (k: string) => poolCallRange({ table: "call", key: k })?.weights ?? null };
  const base = (() => {
    // the pool-call overlay's key is this table's or (a plain limp in a two-limper pot) the limp table's
    if (f.kind === "call" && callTable.has(f.key)) return callTable.get(f.key);
    if (f.kind === "limp" || f.kind === "call") return limpLockRange(f.key, f.limpTable ?? "v2")?.weights ?? null;
    return (COLD_CALL_LOCKS.ranges as Record<string, { weights: Record<string, number> }>)[f.key]?.weights ?? null;
  })();
  if (!base || !f.times) return base;
  // a limp-caller: the named range × the multiplier the note names (limpCallProduct's rounding, so it is exact)
  const other = f.times.kind === "limp" ? limpLockRange(f.times.key, f.times.limpTable ?? "v2")?.weights ?? null : callTable.get(f.times.key);
  return other ? limpCallProduct(f.times.kind === "limp" ? other : base, f.times.kind === "limp" ? base : other) : null;
}
const classCombos = (c: string): number => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const combosOf = (r: Record<string, number>): number => Object.entries(r).reduce((s, [c, w]) => s + (w > 0 ? w * classCombos(c) : 0), 0);
/** what the floor's trigger needs of the seat's preflop actions (the truth): a limp, or a call of a 3-bet as his first chips in */
function floorFits(f: PoolFloor, mine: RefAction[], all: RefAction[]): boolean {
  const first = all.findIndex((a) => a === mine.find((x) => x.kind !== "F"));
  if (first < 0 || all[first]!.kind !== "C") return false;
  const raises = all.slice(0, first).filter((a) => a.kind === "R" || a.kind === "A").length;
  // a pool call: a limp (0 raises) or a call of the open / iso (1 raise) as his first chips in
  return f.kind === "limp" ? raises === 0 : f.kind === "call" ? raises <= 1 : raises === 2;
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
  /** the chart to replay one seat's walk on when it is not `get`'s (a seat the note names as re-picked), else null */
  getFor?: (seat: string) => ((line: string) => Promise<RawNode | null>) | null;
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
  const floors = poolFloorsOf(o.note);
  const seatRange = (w: RecordedRangeWalk, P: string) => (w.result.ok ? Object.entries(w.result.ranges).find(([p]) => p.toUpperCase() === P)?.[1] : undefined);
  for (const pos of o.dry.flopSeats) {
    const P = pos.toUpperCase();
    let mine = Object.entries(o.dry.ranges).find(([p]) => p.toUpperCase() === P)?.[1];
    if (!mine) continue;
    // HERO'S OWN RANGE IS THE ANSWER'S (gtowAiPreflop.heroRangeAsAnswered, 2026-10-07): hero's range on a fitted GTO
    // Wizard AI line is the blend of the fits his preflop answer was read on — the output of no single walk, and of no
    // chart (the AI tree's nodes are not readable offline): its provenance is the note, layer 2 excuses the seat
    if (P === hero && /HERO'S OWN RANGE IS THE ANSWER'S: /.test(o.note)) continue;
    // a pool floor the note names for this seat: the input is that pool range, and the walk is judged on what it replaced
    const floor = floors.get(P);
    if (floor) {
      const pool = poolRangeOf(floor);
      if (!pool || !sameRange(pool, mine)) { say("range-provenance", `${P}'s solver-input range is not the pool's ${floor.key} the note names`); continue; }
      // the cold-call floor replaces only a range under 1% of hands
      if (floor.kind === "coldcall" && !(floor.was < COLD_CALL_FLOOR_COMBOS)) { say("range-provenance", `${P}'s ${floor.was} combos were replaced by the pool's ${floor.key} — the floor is for under ${COLD_CALL_FLOOR_COMBOS}`); continue; }
      if (!floorFits(floor, truthBy.get(P) ?? [], o.truth)) { say("range-provenance", `${P} was given the pool's ${floor.key}, and did not ${floor.kind === "limp" ? "limp" : "cold-call a 3-bet"}`); continue; }
      const was = okWalks.map((w) => seatRange(w, P)).find((r) => !!r && Math.abs(combosOf(r) - floor.was) <= 0.006);
      if (!was) { say("range-provenance", `${P}'s range before the pool floor (${floor.was} combos) is the output of none of the ${okWalks.length} chart walk(s) the answer made`); continue; }
      mine = was;
    }
    const walk = okWalks.find((w) => { const r = seatRange(w, P); return !!r && sameRange(r, mine!); });
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
        // the note must name THIS size ("HJ's 2.6bb read as 2.5bb" — preflopPin.snapsNote), not just some snap
        else if (!onTree(t.to!, got) && !o.note.includes(`${P}'s ${t.to}bb read as ${got}bb`)) say("size-snap-unreported", `${P}'s raise to ${t.to} was read as ${s.token} at "${s.line || "root"}" and the answer does not say so (no "${P}'s ${t.to}bb read as ${got}bb")`);
        level = Math.max(level, t.to!);
      }
      void level;
      // hero's own raise must be read on his exact label, a villain's on every non-jam size (the documented merge)
      if (P === hero && s.labels.length !== 1) say("step-action-mismatch", `hero's range at "${s.line}" was conditioned on ${s.labels.length} labels (${s.labels.join(", ")}), not his own`);
    }
    // the product of the chart's own frequencies along this walk, nodes read afresh
    // (a seat the note says was re-picked is replayed on the re-picked chart — its walk was made there)
    const g = o.getFor?.(P) ?? o.get;
    if (g) {
      let w: Record<string, number> | null = null;
      for (const s of steps) {
        if (s.token === "F") { w = {}; break; }
        const node = await g(s.line);
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
  /** a chart by id: the re-picked chart the note names (round 2.1) */
  getFor?: (chartId: string) => (line: string) => Promise<RawNode | null>;
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
  const rp = repickOf(o.note);
  let refRp: Awaited<ReturnType<typeof referenceRanges>> | null = null;
  const hero = o.heroPos.toUpperCase();
  const floors = poolFloorsOf(o.note);
  for (const pos of o.dry.flopSeats) {
    const P = pos.toUpperCase();
    const mine = Object.entries(o.dry.ranges ?? {}).find(([p]) => p.toUpperCase() === P)?.[1];
    const theirs = ref.ranges[P];
    // A VILLAIN THE NOTE SAYS WAS RE-PICKED (round 2.1): judged on the re-picked chart — the reference walk of the dealt
    // line there must give his range (or a fit on that chart must name him); the pinned chart's reference excuses nothing
    if (rp && P !== hero && rp.seats.includes(P) && o.getFor && mine) {
      refRp ??= await referenceRanges(o.truth, o.getFor(rp.chart), { dealt: o.dealt, heroPos: o.heroPos });
      const there = refRp.ok ? refRp.ranges[P] : undefined;
      const d2 = there ? rangeDiff(mine, there) : null;
      if (d2 && d2.max <= RANGE_TOL) {
        if (!theirs || rangeDiff(mine, theirs).max > RANGE_TOL) { explained = true; why ??= `${P} re-picked onto ${rp.chart} | RANGES RE-PICKED`; }
        continue;
      }
      if (explainsSeat(o.note, P, false)) { explained = true; why ??= `${P} re-picked onto ${rp.chart}, read on a fitted line | ${(withoutRepick(o.note).match(APPROX_NOTE) ?? [""])[0]}`; continue; }
      findings.push({ kind: "range-mismatch", reason: d2
        ? `${P} was re-picked onto ${rp.chart}: its ${d2.cls} is ${d2.a.toFixed(3)} in the solver input, ${d2.b.toFixed(3)} on the reference walk there`
        : `${P} was re-picked onto ${rp.chart}, where the reference ${refRp.ok ? `does not bring ${P} to the flop` : `cannot walk the dealt line (${refRp.why})`} and no fit is named` });
      continue;
    }
    // a seat the note floors to a pool range holds that range by design — layer 1 checked it is exactly the pool's and
    // that the walked range it replaced is the chart's own
    const floor = floors.get(P), pool = floor ? poolRangeOf(floor) : null;
    if (mine && pool && sameRange(pool, mine)) continue;
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

/**
 * THE POSTFLOP LINE AS SENT (round 2): every street's tokens in the solver input against the dealt actions before
 * hero's decision — a bet or raise at its exact size (the chain pins observed sizes, FIXED trees), an all-in that
 * raises as RAI, one that does not as C, and each token's seat. Returns the first difference, or null.
 */
export function postflopTokenMismatch(
  actions: { street: number; seat: number; type: string; amount?: number }[], k: number, posOf: (seat: number) => string,
  dry: { streets?: string[][]; streetSeats?: (string | null)[][] },
): string | null {
  if (!dry.streets) return null;
  const before = actions.slice(0, k);
  for (let st = 1; st <= 3; st++) {
    const acts = before.filter((a) => a.street === st);
    const sent = dry.streets[st - 1];
    if (!acts.length && !sent?.length) continue;
    if (!sent) return `street ${st}: ${acts.length} dealt action(s), none sent`;
    let level = 0;
    const want = acts.map((a) => {
      if (a.type === "fold") return "F";
      if (a.type === "check") return "X";
      if (a.type === "call") return "C";
      const to = a.amount ?? 0;
      if (a.type === "all-in") { if (to > level + 0.005) { level = to; return "RAI"; } return "C"; }
      level = Math.max(level, to);
      return `R${Math.round(to * 100) / 100}`;
    });
    if (want.join("-") !== sent.join("-")) return `street ${st}: dealt ${want.join("-")}, sent ${sent.join("-")}`;
    const seats = dry.streetSeats?.[st - 1];
    if (seats) for (let i = 0; i < acts.length; i++) {
      if (seats[i] != null && String(seats[i]).toUpperCase() !== posOf(acts[i]!.seat).toUpperCase()) return `street ${st}: token ${i + 1} is ${posOf(acts[i]!.seat)}'s, sent as ${seats[i]}'s`;
    }
  }
  return null;
}
