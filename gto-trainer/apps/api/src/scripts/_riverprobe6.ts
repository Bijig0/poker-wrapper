import { mesRiverLookup } from "../services/mesRiver";
import { readFileSync } from "node:fs";
const locked = JSON.parse(readFileSync("../../../analysis/pipeline/limp_study/mes_handoff/runs/M2_heroBTN_srp_vs_BB_Kc7d2h.locked.json", "utf-8"));
const line = ["Check", "Check", "2c", "Check", "Bet(275)", "Call", "5s"];
for (const hero of [["Ah", "Qs"], ["Kh", "Qs"], ["Ad", "Kd"], ["Jh", "Th"]]) {
  const hit = await mesRiverLookup({ family: "M2_heroBTN_srp_vs_BB", board: "Kc7d2h", heroPlayer: 1, holesHint: locked.ip_holes, line, riverTokens: ["X"], heroCardsMapped: hero });
  console.log(hero.join(""), hit ? `inRange=${!hit.notInRange}  ${hit.actions.map((a) => `${a.action} ${a.frequency.toFixed(0)}%${a.ev != null ? ` (${a.ev}bb)` : ""}`).join("  ")}  pick=${hit.exploitDecision?.action}` : "null");
}
process.exit(0);
