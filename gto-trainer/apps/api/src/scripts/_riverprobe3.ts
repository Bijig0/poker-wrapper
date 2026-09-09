import { extractLine } from "../services/mesRiver";
import { readFileSync } from "node:fs";
const locked = JSON.parse(readFileSync("../../../analysis/pipeline/limp_study/mes_handoff/runs/M2_heroBTN_srp_vs_BB_Kc7d2h.locked.json", "utf-8"));
const st = await extractLine("M2_heroBTN_srp_vs_BB", "Kc7d2h", ["Check", "Check", "2c", "Check", "Bet(275)", "Call", "5s"]);
if (!st) { console.log("null"); process.exit(0); }
const ip = st.ip_weights, holes: string[] = locked.ip_holes;
console.log("board", st.board, "pot", st.pot, "nodes", st.nodes.length, "holes", holes.length, "ip_weights", ip.length, "oop_weights", st.oop_weights.length);
console.log("root", st.nodes[0]?.player, st.nodes[0]?.actions, "| strategy dims", st.nodes[0]?.strategy.length, "x", st.nodes[0]?.strategy[0]?.length);
const mass = ip.reduce((a, b) => a + b, 0); console.log("ip mass", mass.toFixed(3), "nonzero", ip.filter((x) => x > 0).length);
const top = ip.map((w, i) => [w, holes[i]] as const).sort((a, b) => b[0] - a[0]).slice(0, 8);
console.log("top IP holes by weight:", top.map(([w, h]) => `${h}:${w.toFixed(3)}`).join(" "));
const i = holes.indexOf("AhQs"), j = holes.indexOf("QsAh"); console.log("AhQs idx", i, "w", i >= 0 ? ip[i] : "-", "| QsAh idx", j);
const heroNode = st.nodes.find((n) => n.player === 1); console.log("first hero node", heroNode?.history, heroNode?.actions, "sum strat over hands:", heroNode?.strategy.map((row) => row.reduce((a, b) => a + b, 0).toFixed(1)));
process.exit(0);
