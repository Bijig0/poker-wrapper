// scratch: one archived hand's money and seats, and its stored solves' chart + stacks (read-only)
import { Database } from "bun:sqlite";
const id = process.argv[2]!;
const hands = new Database("C:/Users/Brady/poker/ignition-study-wrapper/data/hands.db", { readonly: true });
const solves = new Database("C:/Users/Brady/poker/gto-trainer/apps/api/data/solves.sqlite", { readonly: true });
const row = hands.query<any, [string]>("SELECT rowid, data FROM hands WHERE json_extract(data, '$.clientHandId') = ? ORDER BY rowid DESC").all(id);
for (const r of row) {
  const d = JSON.parse(r.data);
  console.log(`rowid ${r.rowid} site ${d.site} bb ${d.bbCents} hero ${d.heroSeatId} ${JSON.stringify(d.heroCards)} board ${JSON.stringify(d.board)}`);
  console.log(" positions", JSON.stringify(d.positions), "\n liveSeats", JSON.stringify(d.liveSeats), "\n startStacks", JSON.stringify(d.startStacks), "\n stacks", JSON.stringify(d.stacks), "\n committed", JSON.stringify(d.committed));
  for (const a of d.actions) console.log(`   ${a.street} ${a.seatId}${a.hero ? "*" : ""} ${d.positions?.[a.seatId] ?? "?"} ${a.type} ${a.amount ?? ""}`);
}
for (const s of solves.query<any, [string]>("SELECT id, ts, origin, street, line, decision_key, trace FROM solves WHERE client_hand_id = ? ORDER BY id").all(id)) {
  const t = JSON.parse(Buffer.from(Bun.gunzipSync(s.trace)).toString());
  console.log(`#${s.id} ${new Date(s.ts).toISOString()} ${s.origin} ${s.street} ${s.line} · ${t.spec?.rangeSource} pot ${t.spec?.flopPot} stack ${t.spec?.flopStack} dk ${s.decision_key}`);
}
