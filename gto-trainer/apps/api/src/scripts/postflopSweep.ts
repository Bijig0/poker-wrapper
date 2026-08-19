/**
 * Part 1 of the synthetic postflop audit: ~1k LEGAL heads-up postflop nodes,
 * stubbed realistic ranges, straight into gtowApi.customSolve.
 *
 * Ranges are inputs to the solve (two 1326-combo arrays), so stubbing them is
 * the API's own contract, not a shortcut. They are REALISTIC (a ~45% opener
 * vs a ~35% defender built from hand-class weights) because the goal is that
 * every input is one the solver should handle — then any failure is a genuine
 * solve-path bug, not the harness feeding garbage. Geometry is legal by
 * construction: unique cards, street = board length, bets within stack.
 *
 * Resumable: appends to postflop_sweep.jsonl next to this script, keyed by a
 * deterministic spot id (seeded LCG — same 1k spots every run).
 *
 * Run:  bun run src/scripts/postflopSweep.ts [count]
 */
import { gtowApi } from "../services/gtowApi";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";

const OUT = `${import.meta.dir}/postflop_sweep.jsonl`;
const COUNT = Number(process.argv[2] ?? 1000);

// ── deterministic RNG ────────────────────────────────────────────────────────
let seed = 0x5eed;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;

// ── realistic-ish stub ranges (class -> continue weight) ────────────────────
const OPENER: Record<string, number> = Object.fromEntries([
  ...["22","33","44","55","66","77","88","99","TT","JJ","QQ","KK","AA"].map((c) => [c, 1]),
  ...["ATs","AJs","AQs","AKs","A9s","A8s","A7s","A6s","A5s","A4s","A3s","A2s"].map((c) => [c, 1]),
  ...["KTs","KJs","KQs","K9s","QTs","QJs","JTs","T9s","98s","87s","76s","65s","54s"].map((c) => [c, 1]),
  ...["AJo","AQo","AKo","ATo","KQo","KJo","QJo","JTo","A9o","KTo"].map((c) => [c, 1]),
  ...["K8s","Q9s","J9s","T8s","97s","86s","75s","64s","A8o","A7o","QTo","T9o"].map((c) => [c, 0.5]),
]);
const DEFENDER: Record<string, number> = Object.fromEntries([
  ...["22","33","44","55","66","77","88","99","TT"].map((c) => [c, 1]),
  ...["A2s","A3s","A4s","A5s","A6s","A7s","A8s","A9s","ATs","AJs"].map((c) => [c, 1]),
  ...["K9s","KTs","KJs","Q9s","QTs","QJs","J9s","JTs","T8s","T9s","98s","97s","87s","86s","76s","65s","54s","43s"].map((c) => [c, 1]),
  ...["ATo","AJo","KTo","KJo","QTo","QJo","JTo","T9o","98o","A9o","A8o","A5o"].map((c) => [c, 1]),
  ...["K8s","K7s","Q8s","J8s","96s","85s","75s","64s","53s","K9o","Q9o","J9o","87o"].map((c) => [c, 0.5]),
]);
const OOP_ARR = buildRangeArray(classWeightsToSpec(DEFENDER));
const IP_ARR = buildRangeArray(classWeightsToSpec(OPENER));

// ── legal node generator ─────────────────────────────────────────────────────
const RANKS = "23456789TJQKA".split("");
const SUITS = "shdc".split("");
function board(n: number): string {
  const used = new Set<string>();
  while (used.size < n) used.add(pick(RANKS) + pick(SUITS));
  return [...used].join("");  // GTOW board format: concatenated, no commas
}
// (pot, stack) entering the street, in bb — SRP / 3-bet / 4-bet-ish pots.
const GEOMETRIES: [number, number][] = [[5, 97.5], [6.5, 96], [13, 89], [20, 80], [44, 60], [7, 40]];
const STREETS = [["FLOP", 3], ["TURN", 4], ["RIVER", 5]] as const;

function spot(i: number) {
  seed = 0x5eed + i * 7919; // per-spot determinism, independent of order
  const [street, n] = pick([...STREETS]);
  const [pot, stack] = pick(GEOMETRIES);
  const facing = rnd() < 0.45 ? pick([33, 50, 75, 100]) : null; // % pot bet faced
  return {
    id: `pf${String(i).padStart(4, "0")}`,
    tree: {
      board: board(n),
      pot,
      stack,
      oopRange: OOP_ARR,
      ipRange: IP_ARR,
      oopPos: "BB",
      ipPos: "BTN",
      startingStreet: street,
      // the tree call requires the per-street action fields, empty = root
      flopActions: "", turnActions: "", riverActions: "",
      ...(facing ? { fixedBets: { [street]: facing } } : {}),
    },
    facing,
  };
}

// ── validation: an answer must be RIGHT-SHAPED, not merely present ──────────
function problems(sol: any, facing: number | null, stack: number): string[] {
  const out: string[] = [];
  const acts: any[] = sol?.action_solutions ?? [];
  if (!acts.length) return ["no action_solutions"];
  const total = acts.reduce((a, s) => a + (s?.total_frequency ?? 0), 0);
  if (Math.abs(total - 1) > 0.02 && Math.abs(total - 100) > 2)
    out.push(`frequencies sum to ${total.toFixed(3)}`);
  const names = acts.map((a) => String(a?.action?.display_name ?? "").toUpperCase());
  if (facing == null && names.includes("FOLD"))
    out.push("FOLD offered with nothing to call");
  if (facing != null && !names.some((x) => x.includes("CALL") || x.includes("FOLD")))
    out.push("facing a bet but no call/fold offered");
  for (const a of acts) {
    const sz = parseFloat(a?.action?.betsize);
    if (sz > stack + 0.01) out.push(`size ${sz} exceeds stack ${stack}`);
  }
  return out;
}

// ── the sweep ────────────────────────────────────────────────────────────────
const done = new Set<string>();
try {
  for (const l of (await Bun.file(OUT).text()).split("\n"))
    if (l.trim()) done.add(JSON.parse(l).id);
} catch {}

const w = Bun.file(OUT).writer();
let ok = 0, bad = 0, err = 0, run = 0;
for (let i = 0; i < COUNT; i++) {
  const s = spot(i);
  if (done.has(s.id)) continue;
  const t0 = Date.now();
  let row: any = { id: s.id, street: s.tree.startingStreet, board: s.tree.board,
                   pot: s.tree.pot, stack: s.tree.stack, facing: s.facing };
  try {
    let res: any = await gtowApi.customSolve(s.tree as any);
    // customSolve returns {ok, data}; the solution lives under data.
    if (!res?.ok) throw new Error(String(res?.error ?? "solve not ok"));
    let sol = res.data;
    if (s.facing != null) {
      // fixedBets only SIZES the tree; facing a bet means walking villain's
      // bet action to hero's response node, using the tree's own action code
      // (exactly how fastSolve walks observed action).
      const agg = (sol?.action_solutions ?? []).find((a: any) =>
        /^(BET|RAISE|ALLIN)/i.test(a?.action?.display_name ?? ""));
      if (!agg?.action?.code) throw new Error("tree offered no bet to face");
      const key = s.tree.startingStreet.toLowerCase() + "Actions";
      res = await gtowApi.customSolve({ ...s.tree, [key]: String(agg.action.code) } as any);
      if (!res?.ok) throw new Error(String(res?.error ?? "walked solve not ok"));
      sol = res.data;
    }
    const probs = problems(sol, s.facing, s.tree.stack);
    row = { ...row, ok: probs.length === 0, problems: probs.length ? probs : undefined,
            nActions: (sol?.action_solutions ?? []).length };
    probs.length ? bad++ : ok++;
  } catch (e) {
    row = { ...row, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
    err++;
  }
  row.ms = Date.now() - t0;
  w.write(JSON.stringify(row) + "\n");
  w.flush();
  if (++run % 20 === 0)
    console.log(`${run} run: ${ok} ok, ${bad} malformed, ${err} errors (last ${row.ms}ms)`);
}
w.end();
console.log(`DONE: ${run} solved this run — ${ok} ok, ${bad} malformed answers, ${err} errors`);
