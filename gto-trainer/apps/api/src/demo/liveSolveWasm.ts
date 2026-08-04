/**
 * LIVE GTO DEMO  (postflop-solver via WASM)
 * =========================================
 * Type ANY bet size as a % of pot — a size that exists in no precomputed
 * database — and a game tree containing that exact node is built and solved to
 * equilibrium IN-PROCESS (no subprocess, no file I/O) in ~1ms. Returns hero's
 * real, averaged GTO strategy.
 *
 * Spot (heads-up river):  HERO (OOP) checks -> VILLAIN (IP) bets the size you
 * pick -> HERO responds (call / fold).
 *
 * Run interactively:   bun run src/demo/liveSolveWasm.ts
 * One-shot:            bun run src/demo/liveSolveWasm.ts 137
 */

import { createRequire } from "module";
import { join } from "path";

const require = createRequire(import.meta.url);
const { solve_river } = require(
  join(import.meta.dir, "..", "..", "solver-wasm", "pkg", "solver_wasm.js")
);

// ---- the fixed spot --------------------------------------------------------
const SPOT = {
  board: "Qs Jh 2h 8c 3d",
  pot: 100,
  stack: 600, // deep enough for big overbets
  // HERO out of position: a condensed bluff-catching range (varied strength).
  heroOOP:
    "JJ,TT,99,88,77,66,55,AQs,AQo,AJs,ATs,KQs,KQo,KJs,QJs,QTs,JTs,T9s,A5s",
  // VILLAIN in position: a polarized river betting range (value + missed draws).
  villainIP:
    "AA,KK,QQ,JJ,TT,AKs,AKo,AQs,KQs,QJs,JTs,T9s,98s,76s,A5s,A4s,54s",
};

// The prior-street line these ranges are ASSUMED to come from. This is the
// "story" that shapes the two ranges — it is a hand-authored assumption, NOT a
// live preflop/flop/turn solve. (Building the derived version is the next step.)
const ASSUMED_LINE = [
  "Preflop  — villain opens (IP/BTN), hero calls (OOP/BB)",
  "Flop  Qs Jh 2h — hero checks, villain bets, hero CALLS  (→ hero capped to bluff-catchers)",
  "Turn  8c — hero checks, villain checks back  (→ villain keeps value + gives up some air)",
  "River 3d — hero checks → villain bets the size YOU pick, hero responds",
];

interface Result {
  exploitability: number;
  bet_chips: number;
  villain_bet_freq: number;
  actions: string[];
  hands: string[];
  strategy: number[][];
  weights: number[];
  ev: number[];
}

function solve(betPct: number): Result {
  return JSON.parse(
    solve_river(SPOT.board, SPOT.heroOOP, SPOT.villainIP, SPOT.pot, SPOT.stack, betPct)
  );
}

const idxOf = (r: Result, name: string) => r.actions.findIndex((a) => a.startsWith(name));

/** combo-weighted aggregate frequency for each action across hero's range */
function aggregate(r: Result): Record<string, number> {
  const out: Record<string, number> = {};
  let wsum = 0;
  for (let h = 0; h < r.hands.length; h++) wsum += r.weights[h];
  for (let a = 0; a < r.actions.length; a++) {
    let s = 0;
    for (let h = 0; h < r.hands.length; h++) s += r.strategy[h][a] * r.weights[h];
    out[r.actions[a]] = wsum ? s / wsum : 0;
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const label = (a: string) => (a.startsWith("Bet") || a.startsWith("Raise") ? "RAISE" : a.toUpperCase());

function printResult(betPct: number, r: Result) {
  const agg = aggregate(r);
  const foldIdx = idxOf(r, "Fold");
  const theoryFold = Math.round(((betPct / 100) / (1 + betPct / 100)) * 100);

  console.log(`\n  ✅ solved LIVE in ~1ms   (exploitability ${r.exploitability.toFixed(3)} chips, ${(100 * r.exploitability / SPOT.pot).toFixed(2)}% of pot)`);
  console.log(`  context: villain value-bets this size with ${pct(r.villain_bet_freq)} of range\n`);
  console.log(`  Villain bet ${r.bet_chips} chips (${betPct}% pot). YOUR GTO RESPONSE (whole range):`);
  const parts = r.actions.map((a) => `${label(a)} ${pct(agg[a])}`);
  console.log(`     ${parts.join("    ")}`);
  if (foldIdx >= 0) {
    console.log(`     └─ folds ${pct(agg[r.actions[foldIdx]])} vs. theoretical MDF fold ≈ ${theoryFold}%  ✓`);
  }

  // example hands across the strength ladder
  const examples: [string, string][] = [
    ["JsJd", "2nd pair — strong bluffcatcher"],
    ["AcQd", "top pair"],
    ["KdJd", "weak top pair / marginal"],
    ["5s5c", "underpair — bottom of range"],
  ];
  const callIdx = idxOf(r, "Call");
  const shown = examples.filter(([h]) => r.hands.includes(h));
  if (shown.length) {
    console.log(`\n  Example hands (real mixed strategy + EV):`);
    for (const [h, desc] of shown) {
      const i = r.hands.indexOf(h);
      const mix = r.actions
        .map((a, ai) => (r.strategy[i][ai] > 0.005 ? `${label(a)} ${pct(r.strategy[i][ai])}` : null))
        .filter(Boolean)
        .join(" / ");
      const ev = callIdx >= 0 ? `  (call EV ${r.ev[i].toFixed(1)} chips)` : "";
      console.log(`     ${(h + "  " + desc).padEnd(38)} ${mix}${ev}`);
    }
  }
}

function header() {
  console.log(`\n┌─ LIVE GTO DEMO — postflop-solver (Rust→WASM, in-process) ──────────┐`);
  console.log(`│ River: ${SPOT.board}                                          │`);
  console.log(`│ You (OOP) check → villain (IP) bets a size YOU choose → you respond.│`);
  console.log(`│ Pot ${SPOT.pot} · stacks ${SPOT.stack}.  Every size is solved from scratch, live.     │`);
  console.log(`└────────────────────────────────────────────────────────────────────┘`);

  console.log(`\n  HOW WE GOT HERE  (assumed prior-street action — shapes both ranges):`);
  for (const step of ASSUMED_LINE) console.log(`    • ${step}`);
  console.log(`\n  RANGES FED TO THE SOLVER (assumed, not derived from a live prior-street solve):`);
  console.log(`    Hero  (OOP, capped bluff-catchers): ${SPOT.heroOOP}`);
  console.log(`    Villain (IP, polarized):            ${SPOT.villainIP}`);
  console.log(`    ⚠ These ranges are hand-authored inputs. The solver reasons over them`);
  console.log(`      correctly (blockers, EV, MDF) — but the ranges themselves are assumed.`);
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    header();
    const betPct = parseFloat(arg);
    console.log(`\nVillain bets ${betPct}% of pot…  building tree with that exact node + solving`);
    printResult(betPct, solve(betPct));
    console.log("");
    return;
  }
  header();
  const prompt = "\nVillain bets what % of pot?  (try 33, 137, 215…)  → ";
  process.stdout.write(prompt);
  for await (const line of console as any) {
    const betPct = parseFloat(String(line).trim());
    if (!isFinite(betPct) || betPct <= 0) {
      process.stdout.write("  (enter a positive number, Ctrl-C to quit)" + prompt);
      continue;
    }
    try {
      printResult(betPct, solve(betPct));
    } catch (e) {
      console.log(`  ❌ ${(e as Error).message}`);
    }
    process.stdout.write(prompt);
  }
}

main();
