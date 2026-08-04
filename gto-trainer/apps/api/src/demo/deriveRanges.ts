/**
 * DERIVED-RANGES DEMO  (postflop-solver via WASM)
 * ===============================================
 * Proves that flop/turn/river ranges are COMPUTED by the solver, not supplied.
 *
 * We feed only ONE thing that comes from outside the solve: the preflop range
 * pair (wide HU single-raised-pot ranges). Then we solve the WHOLE flop (turn &
 * river undealt) and walk a fixed line —
 *
 *     Flop  QsJh2h : hero (OOP) checks -> villain bets -> hero CALLS
 *     Turn  8c     : check, check
 *     River 3d
 *
 * — reading hero's range straight out of the solver at the START of each street.
 * Watch the range narrow and strengthen: the turn/river ranges are DERIVED.
 *
 * Run:  bun run src/demo/deriveRanges.ts
 */

import { createRequire } from "module";
import { join } from "path";

const require = createRequire(import.meta.url);
const { derive_ranges } = require(
  join(import.meta.dir, "..", "..", "solver-wasm", "pkg", "solver_wasm.js")
);

// ---- the spot --------------------------------------------------------------
const SPOT = {
  flop: "QsJh2h",
  turn: "8c",
  river: "3d",
  pot: 100,
  stack: 200, // SPR 2 — kept shallow so the full flop solve stays ~25s, not minutes
  // The ONLY external input: wide HU preflop ranges (the "seed").
  oop: "22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,87s,76s,65s,54s,A2o+,K9o+,Q9o+,J9o+,T9o",
  ip: "22+,A2s+,K2s+,Q2s+,J5s+,T7s+,97s+,86s+,75s+,64s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o",
  bet: "50%",
  raise: "a",
};

interface HandRow {
  hand: string;
  weight: number;
  equity: number;
}
interface StreetSnapshot {
  label: string;
  n_combos: number;
  avg_equity: number;
  top: HandRow[];
}
interface DeriveResult {
  exploitability: number;
  streets: StreetSnapshot[];
}

function bar(n: number, max: number, width = 24): string {
  const filled = Math.max(1, Math.round((n / max) * width));
  return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
}

function main() {
  console.log(`\n┌─ DERIVED-RANGES DEMO — ranges are COMPUTED, not assumed ───────────┐`);
  console.log(`│ We supply ONLY preflop ranges, then solve the whole flop and walk   │`);
  console.log(`│ one line. Hero's turn & river ranges are read out of the solver.    │`);
  console.log(`└────────────────────────────────────────────────────────────────────┘`);
  console.log(`\n  Line:  Flop ${SPOT.flop}  check → villain bets → hero CALLS`);
  console.log(`         Turn ${SPOT.turn}  check → check`);
  console.log(`         River ${SPOT.river}`);
  console.log(`  Pot ${SPOT.pot} · stacks ${SPOT.stack} (SPR 2) · bet ${SPOT.bet}, raise all-in`);
  console.log(`\n  Preflop SEED ranges (the only external input):`);
  console.log(`    Hero  (OOP): ${SPOT.oop}`);
  console.log(`    Villain(IP): ${SPOT.ip}`);

  console.log(`\n  ⏳ Solving the FULL flop (turn & river undealt)…`);
  console.log(`     this ~20-30s wait is exactly the cost that precomputing a`);
  console.log(`     flop blueprint pays once, offline, so it's instant at the table.`);

  const t0 = performance.now();
  const r: DeriveResult = JSON.parse(
    derive_ranges(
      SPOT.flop, SPOT.turn, SPOT.river,
      SPOT.oop, SPOT.ip,
      SPOT.pot, SPOT.stack,
      SPOT.bet, SPOT.raise,
      200, 0.005
    )
  );
  const secs = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`\n  ✅ solved in ${secs}s  (exploitability ${r.exploitability.toFixed(3)} chips)\n`);

  const maxCombos = Math.max(...r.streets.map((s) => s.n_combos));
  for (const s of r.streets) {
    console.log(`  ${s.label}`);
    console.log(`     range width  ${bar(s.n_combos, maxCombos)}  ~${s.n_combos} combos`);
    console.log(`     avg equity   ${(s.avg_equity * 100).toFixed(1)}%`);
    const tops = s.top
      .slice(0, 6)
      .map((h) => `${h.hand}·${(h.equity * 100).toFixed(0)}%`)
      .join("   ");
    console.log(`     heaviest     ${tops}`);
    console.log("");
  }

  console.log(`  ── What this proves ────────────────────────────────────────────────`);
  console.log(`  Nobody typed in a turn or river range. The solver derived them:`);
  console.log(`  the range NARROWS (calling the flop caps it) and STRENGTHENS`);
  console.log(`  (avg equity climbs) purely as a consequence of the equilibrium.`);
  console.log("");
}

main();
