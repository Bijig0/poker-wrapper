import { mesRiverLookup, extractLine } from "../services/mesRiver";
import { readFileSync } from "node:fs";
const locked = JSON.parse(readFileSync("../../../analysis/pipeline/limp_study/mes_handoff/runs/M2_heroBTN_srp_vs_BB_Kc7d2h.locked.json", "utf-8"));
const line = ["Check", "Check", "2c", "Check", "Bet(275)", "Call", "5s"];   // turn: BB x, BTN bets 50%, BB calls; river 5s
const t0 = Date.now();
const st = await extractLine("M2_heroBTN_srp_vs_BB", "Kc7d2h", line);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s subtree:`, st && { board: st.board, pot: st.pot, nodes: st.nodes.length, rootPlayer: st.nodes[0]?.player, rootActs: st.nodes[0]?.actions,
  ipMass: st.ip_weights.reduce((a, b) => a + b, 0).toFixed(2), oopMass: st.oop_weights.reduce((a, b) => a + b, 0).toFixed(2) });
for (const hero of [["Ah", "Qs"], ["Kh", "Qs"], ["Ad", "Kd"]]) {
  const hit = await mesRiverLookup({ family: "M2_heroBTN_srp_vs_BB", board: "Kc7d2h", heroPlayer: 1, holesHint: locked.ip_holes, line, riverTokens: ["X"], heroCardsMapped: hero });
  console.log(hero.join(""), hit ? { inRange: !hit.notInRange, actions: hit.actions.map((a) => `${a.action} ${a.frequency.toFixed(0)}%${a.ev != null ? ` (${a.ev}bb)` : ""}`).join("  "), pick: hit.exploitDecision?.action } : null);
}
process.exit(0);
