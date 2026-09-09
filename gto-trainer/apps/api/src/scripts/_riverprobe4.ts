import { extractLine } from "../services/mesRiver";
import { readFileSync } from "node:fs";
const locked = JSON.parse(readFileSync("../../../analysis/pipeline/limp_study/mes_handoff/runs/M2_heroBTN_srp_vs_BB_Kc7d2h.locked.json", "utf-8"));
const st = (await extractLine("M2_heroBTN_srp_vs_BB", "Kc7d2h", ["Check", "Check", "2c", "Check", "Bet(275)", "Call", "5s"]))!;
const holes: string[] = locked.ip_holes;
for (const n of st.nodes) {
  const nz = n.strategy.map((row) => row.filter((x) => x > 0).length);
  console.log(JSON.stringify(n.history), "p", n.player, n.actions.join("/"), "| width", n.strategy[0]?.length, "| nonzero per action", nz.join(","), "| ev nonzero", n.ev.map((r) => r.filter((x) => x !== 0).length).join(","));
}
const hero0 = st.nodes.find((n) => n.history.length === 1 && n.history[0] === 0);
if (hero0) { const i = holes.indexOf("AhQs"); console.log("hero node after BB check: AhQs ->", hero0.strategy.map((r) => r[i]), "ev", hero0.ev.map((r) => r[i]));
  const best = hero0.strategy[0]!.map((_, j) => [hero0.strategy.map((r) => r[j]!), holes[j]] as const).filter(([s]) => s.some((x) => x > 0)).slice(0, 6);
  console.log("some combos with mass:", best.map(([s, h]) => `${h}:${s.map((x) => x.toFixed(2)).join("/")}`).join("  ")); }
process.exit(0);
