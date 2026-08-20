/**
 * Part 2 of the synthetic postflop audit: same idea as postflopSweep.ts, but
 * the ranges are REAL — reconstructed from the local crawled preflop charts
 * for genuine preflop lines, exactly as the live pipeline seeds its solves.
 * Part 1 (stubs) proved the solve path; any failure HERE that Part 1 didn't
 * show is therefore a range-reconstruction problem, which is the point of
 * running both.
 *
 * Pot and stack are DERIVED from each line (preflopPotStack), so the whole
 * node is coherent: the ranges that reach the flop and the money that got
 * there agree with each other, unlike Part 1's independently-sampled
 * geometries.
 *
 * Resumable and append-safe (Part 1's Bun writer truncated on resume, which
 * silently dropped the earlier rows — appendFileSync keeps them).
 *
 * Run:  bun run src/scripts/postflopSweepReal.ts [count]
 */
import { appendFileSync } from "node:fs";
import { gtowApi } from "../services/gtowApi";
import { preflopDb } from "../services/preflopDb";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { preflopPotStack, POSTFLOP_ORDER } from "../utils/aiStudyLine/aiStudyLine";

const OUT = `${import.meta.dir}/postflop_sweep_real.jsonl`;
const COUNT = Number(process.argv[2] ?? 1000);
const GAMETYPE = "Cash6m500zGeneral";
const DEPTH = 100;

// Real preflop lines in the 6-max rotation (UTG-HJ-CO-BTN-SB-BB). Sizes are
// snapped to the tree by the reconstruction itself, so a size that is not the
// chart's exact rung still walks.
const LINES: { name: string; tokens: string[] }[] = [
  { name: "btn-open-bb-call",   tokens: "F-F-F-R2.5-F-C".split("-") },
  { name: "co-open-bb-call",    tokens: "F-F-R2.5-F-F-C".split("-") },
  { name: "sb-open-bb-call",    tokens: "F-F-F-F-R3-C".split("-") },
  { name: "bb-3bet-btn-call",   tokens: "F-F-F-R2.5-F-R11-C".split("-") },
  { name: "btn-3bet-co-call",   tokens: "F-F-R2.5-R7.5-F-F-C".split("-") },
];

interface Prepared {
  name: string;
  pot: number;
  stack: number;
  oopPos: string;
  ipPos: string;
  oopArr: number[];
  ipArr: number[];
}

async function prepare(): Promise<Prepared[]> {
  if (!preflopDb.available(GAMETYPE, DEPTH))
    throw new Error(`local preflop DB missing ${GAMETYPE}@${DEPTH}`);
  const out: Prepared[] = [];
  for (const l of LINES) {
    const recon = await reconstructFlopRanges(l.tokens, (line) =>
      preflopDb.rawNode(GAMETYPE, DEPTH, line));
    if (!recon.ok) {
      // A line the charts cannot walk is itself a finding — report, not hide.
      console.log(`LINE FAILED ${l.name}: ${recon.reason}`);
      continue;
    }
    const positions = Object.keys(recon.ranges);
    if (positions.length !== 2) {
      console.log(`LINE FAILED ${l.name}: ${positions.length} players reach the flop`);
      continue;
    }
    const [a, b] = positions as [string, string];
    const [oopPos, ipPos] =
      POSTFLOP_ORDER.indexOf(a.toUpperCase()) < POSTFLOP_ORDER.indexOf(b.toUpperCase())
        ? [a, b] : [b, a];
    const { pot, stack } = preflopPotStack(l.tokens, DEPTH);
    out.push({
      name: l.name,
      pot: Math.round(pot * 100) / 100,
      stack: Math.round(stack * 100) / 100,
      oopPos, ipPos,
      oopArr: buildRangeArray(classWeightsToSpec(recon.ranges[oopPos]!)),
      ipArr: buildRangeArray(classWeightsToSpec(recon.ranges[ipPos]!)),
    });
    console.log(`prepared ${l.name}: pot ${pot} stack ${stack} ${oopPos} vs ${ipPos}`);
  }
  if (!out.length) throw new Error("no line prepared — nothing to sweep");
  return out;
}

// ── deterministic generator (fresh seed base so spots differ from Part 1) ───
let seed = 0xbeef;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const RANKS = "23456789TJQKA".split("");
const SUITS = "shdc".split("");
function board(n: number): string {
  const used = new Set<string>();
  while (used.size < n) used.add(pick(RANKS) + pick(SUITS));
  return [...used].join("");
}
const STREETS = [["FLOP", 3], ["TURN", 4], ["RIVER", 5]] as const;

function problems(sol: any, facing: number | null, stack: number): string[] {
  const out: string[] = [];
  const acts: any[] = sol?.action_solutions ?? [];
  if (!acts.length) return ["no action_solutions"];
  const total = acts.reduce((a, s) => a + (s?.total_frequency ?? 0), 0);
  if (Math.abs(total - 1) > 0.02 && Math.abs(total - 100) > 2)
    out.push(`frequencies sum to ${total.toFixed(3)}`);
  const names = acts.map((a) => String(a?.action?.display_name ?? "").toUpperCase());
  if (facing == null && names.includes("FOLD")) out.push("FOLD offered with nothing to call");
  if (facing != null && !names.some((x) => x.includes("CALL") || x.includes("FOLD")))
    out.push("facing a bet but no call/fold offered");
  for (const a of acts) {
    const sz = parseFloat(a?.action?.betsize);
    if (sz > stack + 0.01) out.push(`size ${sz} exceeds stack ${stack}`);
  }
  return out;
}

const prepped = await prepare();

const done = new Set<string>();
try {
  for (const l of (await Bun.file(OUT).text()).split("\n"))
    if (l.trim()) done.add(JSON.parse(l).id);
} catch {}

let ok = 0, bad = 0, err = 0, run = 0;
for (let i = 0; i < COUNT; i++) {
  seed = 0xbeef + i * 6007;
  const line = pick(prepped);
  const [street, n] = pick([...STREETS]);
  const facing = rnd() < 0.45 ? pick([33, 50, 75, 100]) : null;
  const id = `pfr${String(i).padStart(4, "0")}`;
  if (done.has(id)) continue;

  const tree = {
    board: board(n), pot: line.pot, stack: line.stack,
    oopRange: line.oopArr, ipRange: line.ipArr,
    oopPos: line.oopPos, ipPos: line.ipPos,
    startingStreet: street,
    flopActions: "", turnActions: "", riverActions: "",
    ...(facing ? { fixedBets: { [street]: facing } } : {}),
  };
  const t0 = Date.now();
  let row: any = { id, line: line.name, street, board: tree.board,
                   pot: line.pot, stack: line.stack, facing };
  try {
    let res: any = await gtowApi.customSolve(tree as any);
    if (!res?.ok) throw new Error(String(res?.error ?? "solve not ok"));
    let sol = res.data;
    if (facing != null) {
      const agg = (sol?.action_solutions ?? []).find((a: any) =>
        /^(BET|RAISE|ALLIN)/i.test(a?.action?.display_name ?? ""));
      if (!agg?.action?.code) throw new Error("tree offered no bet to face");
      const key = street.toLowerCase() + "Actions";
      res = await gtowApi.customSolve({ ...tree, [key]: String(agg.action.code) } as any);
      if (!res?.ok) throw new Error(String(res?.error ?? "walked solve not ok"));
      sol = res.data;
    }
    const probs = problems(sol, facing, line.stack);
    row = { ...row, ok: probs.length === 0, problems: probs.length ? probs : undefined,
            nActions: (sol?.action_solutions ?? []).length };
    probs.length ? bad++ : ok++;
  } catch (e) {
    row = { ...row, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
    err++;
  }
  row.ms = Date.now() - t0;
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  if (++run % 20 === 0)
    console.log(`${run} run: ${ok} ok, ${bad} malformed, ${err} errors (last ${row.ms}ms)`);
}
console.log(`DONE: ${run} solved this run — ${ok} ok, ${bad} malformed, ${err} errors`);
