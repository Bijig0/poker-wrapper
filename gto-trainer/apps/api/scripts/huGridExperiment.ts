/**
 * One-off (2026-09-19): does a multi-size FIXED grid change the answer at hand
 * 4919174586's river node, and what does it cost in solve time?
 *
 *   bun run scripts/huGridExperiment.ts [solveId=1070] [comboIdx=1028]
 *
 * Rebuilds the river tree from the stored chain trace (ranges entering the
 * river, pot, stack, rake, positions) and solves it with each grid below,
 * printing the root node's action list: range-wide frequency and hero's
 * combo's frequency + EV. The AUTOMATIC baseline is what answered live.
 */
import { gtowApi } from "../src/services/gtowApi";
import { buildRangeArray } from "../src/utils/buildRangeArray/buildRangeArray";

const solveId = Number(process.argv[2] ?? 1070);
const comboIdx = Number(process.argv[3] ?? 1028);
const GRIDS: Record<string, { bet: string[]; raise: string[] }> = {
  "33/75/150 · raise 55/100": { bet: ["33%", "75%", "150%"], raise: ["55%", "100%"] },
  "50/100/200 · raise 60": { bet: ["50%", "100%", "200%"], raise: ["60%"] },
};

const classMapToArray = (m: Record<string, { w: number; combos: number }>): number[] =>
  buildRangeArray(Object.entries(m).filter(([, v]) => v.w > 0)
    .map(([cls, v]) => `${cls}:${Math.min(1, v.w / v.combos).toFixed(4)}`).join(","));

const main = async () => {
  const j = await (await fetch(`http://localhost:2000/api/dashboard/solve/${solveId}`)).json() as any;
  const spec = j.spec, st = j.streets[j.streets.length - 1];
  const board = st.board.length === 10 ? st.board : spec.board;
  console.log(`spot: ${spec.heroPos} (${spec.heroSeat}) vs ${spec.ipPos ?? spec.oopPos} · board ${board} · pot ${st.potIn} · stack ${st.stackIn} · rake ${JSON.stringify(spec.rake)} · hero combo idx ${comboIdx} (${spec.heroCombo})`);
  const oopRange = classMapToArray(st.oopIn), ipRange = classMapToArray(st.ipIn);
  console.log(`ranges: OOP ${oopRange.reduce((a, b) => a + b, 0).toFixed(1)} combos · IP ${ipRange.reduce((a, b) => a + b, 0).toFixed(1)} combos`);
  for (const [label, grid] of Object.entries(GRIDS)) {
    const t0 = Date.now();
    const r = await gtowApi.customSolve({
      board, pot: st.potIn, stack: st.stackIn, oopRange, ipRange,
      oopPos: spec.oopPos, ipPos: spec.ipPos, startingStreet: st.street,
      rake: spec.rake, huGrid: grid,
    });
    const ms = Date.now() - t0;
    if (!r.ok) { console.log(`\n== ${label}: FAILED ${r.status} ${r.error}`); continue; }
    console.log(`\n== ${label}: ${ms} ms wall (${r.cached ? "cached" : "fresh"}, cloud ${r.solveSecs.toFixed(1)} s)`);
    for (const a of r.data.action_solutions ?? []) {
      const name = a.action?.type ?? a.action?.code ?? "?";
      const size = a.action?.betsize != null && a.action.betsize !== "" ? ` ${a.action.betsize}` : "";
      const s = a.strategy?.[comboIdx], ev = a.evs?.[comboIdx];
      console.log(`   ${String(name + size).padEnd(14)} range ${((a.total_frequency ?? 0) * 100).toFixed(1).padStart(5)}%   hero ${s != null ? (s * 100).toFixed(1).padStart(5) + "%" : "    ?"}   ev ${ev != null ? Number(ev).toFixed(2) : "?"}`);
    }
  }
};
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
