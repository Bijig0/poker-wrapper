// scratch: archived Ignition 6-max hands with hero decisions on 2+ postflop streets, heads-up at the flop (read-only)
import { Database } from "bun:sqlite";
const db = new Database("C:/Users/Brady/poker/ignition-study-wrapper/data/hands.db", { readonly: true });
const out: string[] = [];
for (const r of db.query<{ rowid: number; data: string }, []>("SELECT rowid, data FROM hands ORDER BY rowid DESC LIMIT 400").all()) {
  const d = JSON.parse(r.data);
  if ((d.site ?? "ignition") !== "ignition" || !d.clientHandId) continue;
  const labels = Object.keys(d.positions ?? {}).length;
  if (labels < 4) continue;
  const pre = (d.actions ?? []).filter((a: any) => a.street === "preflop");
  const folded = new Set(pre.filter((a: any) => a.type === "fold").map((a: any) => a.seatId));
  const inFlop = [...new Set(pre.map((a: any) => a.seatId))].filter((s) => !folded.has(s));
  const heroStreets = new Set((d.actions ?? []).filter((a: any) => a.hero && a.street !== "preflop").map((a: any) => a.street));
  if (inFlop.length !== 2 || heroStreets.size < 2) continue;
  out.push(`${d.clientHandId} rowid ${r.rowid} bb ${d.bbCents} labels ${labels} startStacks ${d.startStacks ? "yes" : "no"} hero streets ${[...heroStreets].join("/")} line ${pre.map((a: any) => `${d.positions?.[a.seatId]}:${a.type}${a.amount ?? ""}`).join(" ")}`);
}
console.log(out.slice(0, 15).join("\n"));
