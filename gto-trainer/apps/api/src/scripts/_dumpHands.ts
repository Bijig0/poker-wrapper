import { allRows, enrichSync } from "../routes/dashboard";
const ids = (process.env.IDS ?? "425,441,565").split(",").map(Number);
for (const id of ids) {
  const row = allRows().find((r) => r.rowid === id);
  if (!row) { console.log(`#${id} missing`); continue; }
  const e = enrichSync(row)!; const h = e.hand;
  console.log(`\n=== #${id} ${e.clientHandId} hero=${h.positions?.[h.heroSeatId]} seats=${JSON.stringify(h.positions)} live=${JSON.stringify(h.liveSeats)} board=${h.board.join(" ")}`);
  for (const [i, a] of h.actions.entries())
    console.log(`  ${String(i).padStart(2)} ${a.street.padEnd(8)} seat${a.seatId}${a.hero ? "*" : " "} ${String(h.positions?.[a.seatId] ?? "?").padEnd(4)} ${a.type}${a.amount != null ? " " + a.amount : ""}`);
}
