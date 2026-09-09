import { mesRiverLookup } from "../services/mesRiver";
import { readFileSync } from "node:fs";
const locked = JSON.parse(readFileSync("../../../analysis/pipeline/limp_study/mes_handoff/runs/M2_heroBTN_srp_vs_BB_Kc7d2h.locked.json", "utf-8"));
const t0 = Date.now();
// M2 Kc7d2h: BB checks, BTN checks; turn 2c: BB checks, BTN checks; river 5s: BB checks -> hero (BTN, player 1) to act
const hit = await mesRiverLookup({ family: "M2_heroBTN_srp_vs_BB", board: "Kc7d2h", heroPlayer: 1, holesHint: locked.ip_holes,
  line: ["Check", "Check", "2c", "Check", "Check", "5s"], riverTokens: ["X"], heroCardsMapped: ["Ah", "Qs"] });
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, hit ? { board: hit.board, actual: hit.actualBoard, inRange: !hit.notInRange,
  actions: hit.actions.map((a) => `${a.action} ${a.frequency.toFixed(0)}%${a.ev != null ? ` (${a.ev}bb)` : ""}`).join("  "), pick: hit.exploitDecision?.action } : null);
const t1 = Date.now();
const again = await mesRiverLookup({ family: "M2_heroBTN_srp_vs_BB", board: "Kc7d2h", heroPlayer: 1, holesHint: locked.ip_holes,
  line: ["Check", "Check", "2c", "Check", "Check", "5s"], riverTokens: ["X"], heroCardsMapped: ["Kh", "Qs"] });
console.log(`cached ${((Date.now() - t1) / 1000).toFixed(2)}s KQo:`, again?.actions.map((a) => `${a.action} ${a.frequency.toFixed(0)}%`).join("  "));
process.exit(0);
