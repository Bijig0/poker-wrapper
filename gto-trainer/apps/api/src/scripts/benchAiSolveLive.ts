/**
 * LIVE version of scripts/benchAiSolve.ts — same scenarios, real GTO Wizard
 * cloud. Requires the desktop client running with `--remote-debugging-port=9222`
 * and logged in (scripts/start_gtow_ai.ps1).
 *
 * This SPENDS custom solves against the account's daily limit — about 7 per
 * run. Each scenario uses a DIFFERENT board so gtowApi's caches can't leak a
 * warm result into the cold measurement (which would silently fake the win).
 *
 *   bun run src/scripts/benchAiSolveLive.ts
 */

import { gtowApi } from "../services/gtowApi";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { solveExploitLine, warmExploitLine, type ExploitLineInput } from "../services/exploitLine";

const OOP_SPEC = "22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,87s,76s,A9o+,KTo+,QTo+,JTo";
const IP_SPEC = "22+,A2s+,K2s+,Q6s+,J7s+,T7s+,96s+,86s+,75s+,65s,A7o+,K9o+,Q9o+,J9o+,T9o";

const oopRange = buildRangeArray(OOP_SPEC);
const ipRange = buildRangeArray(IP_SPEC);

const base = { oopRange, ipRange, oopPos: "BB", ipPos: "SB", flopPot: 5, effStack: 97.5 };

/** Hero faces a river bet after a flop bet-call and a turn bet-call. */
const deepRiver = (board: string): ExploitLineInput => ({
  ...base,
  boardFull: board,
  streets: { flop: ["X", "R3", "C"], turn: ["X", "R8", "C"], river: ["R20"] },
  current: "river",
});

interface Row { label: string; ms: number; note: string }
const rows: Row[] = [];

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

async function main(): Promise<void> {
  // Pay the CDP token sniff up front so it lands in nobody's measurement — the
  // same thing startTokenKeeper() does for the server.
  const t0 = Date.now();
  const probe = await gtowApi.customSolve({
    board: "Ts7h2d", pot: 5, stack: 97.5, oopRange, ipRange,
    oopPos: "BB", ipPos: "SB", startingStreet: "FLOP", flopActions: "X",
  });
  if (!probe.ok) {
    console.error(`\nprobe solve failed: ${probe.error}\n`);
    console.error("Is GTO Wizard running with --remote-debugging-port=9222 and logged in?\n");
    process.exit(1);
  }
  console.log(`token sniff + first solve (excluded from results): ${secs(Date.now() - t0)}`);

  // 1. floor — a flop decision, nothing to walk
  {
    const t = Date.now();
    const r = await solveExploitLine({ ...base, boardFull: "Jc8d3h", streets: { flop: ["X", "R3"], turn: [], river: [] }, current: "flop" });
    if (!r.ok) throw new Error(`floor: ${r.error}`);
    rows.push({ label: "flop decision (1 solve, floor)", ms: Date.now() - t, note: `cached=${r.cached}` });
  }

  // 2. cold deep river — the whole chain on hero's clock
  {
    const t = Date.now();
    const r = await solveExploitLine(deepRiver("9c5h3sQd2c"));
    if (!r.ok) throw new Error(`cold: ${r.error}`);
    rows.push({ label: "river, COLD (walk on hero's clock)", ms: Date.now() - t, note: `${r.solves} streets walked` });
  }

  // 3. same shape, different board — warmed during "dead time", then solved
  {
    const spot = deepRiver("Kd8s4h6cJh");
    const tw = Date.now();
    const w = await warmExploitLine(spot);
    if (!w.ok) throw new Error(`warm: ${w.error}`);
    const warmMs = Date.now() - tw;

    const t = Date.now();
    const r = await solveExploitLine(spot);
    if (!r.ok) throw new Error(`warmed solve: ${r.error}`);
    rows.push({ label: "river, WARMED (hero's node only)", ms: Date.now() - t, note: `warm took ${secs(warmMs)} off-clock` });
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`\n${pad("scenario", 38)} ${pad("hero waits", 12)} note`);
  console.log("-".repeat(84));
  for (const r of rows) console.log(`${pad(r.label, 38)} ${pad(secs(r.ms), 12)} ${r.note}`);

  const cold = rows[1]!, warm = rows[2]!;
  console.log(`\ncold → warmed: ${secs(cold.ms)} → ${secs(warm.ms)} (${Math.round((1 - warm.ms / cold.ms) * 100)}% faster)`);
  console.log(`floor is ${secs(rows[0]!.ms)} — warmed should sit near it.\n`);
}

await main();
