/** Dump one archived hand and replay one decision, with the reconstruction's seat list shown. */
import { allRows, enrichSync, truncateAt } from "../routes/dashboard";
import { fastSolve } from "../services/fastSolve";
const ID = Number(process.env.ID ?? 425), UPTO = Number(process.env.UPTO ?? 12);
const row = allRows().find((r) => r.rowid === ID)!;
const e = enrichSync(row)!;
const h = e.hand;
console.log(`hand #${ID} ${e.clientHandId} positions=${JSON.stringify(h.positions)} hero=${h.positions?.[h.heroSeatId]} liveSeats=${JSON.stringify(h.liveSeats)}`);
console.log(`board ${h.board.join(" ")}`);
for (const [i, a] of h.actions.entries()) {
  console.log(`  ${String(i).padStart(2)}${i === UPTO ? " <<<" : "    "} ${a.street.padEnd(8)} seat ${a.seatId}${a.hero ? "*" : " "} ${h.positions?.[a.seatId] ?? "?"}  ${a.type}${a.amount != null ? " " + a.amount : ""}`);
}
const t = truncateAt(h, UPTO);
const heroPos = e.summary.heroPos ?? null;
const r = await fastSolve({ ...t, currentNode: { ...t.currentNode, toActIsHero: true } }, heroPos, { heroPos, strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
console.log(`\nNOW: ${r.ok ? `OK ${r.decision?.action}` : `FAIL ${r.reason}`}`);
if (r.ok) console.log(`warning: ${r.warning}`);
