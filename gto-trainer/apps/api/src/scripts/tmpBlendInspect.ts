/** TEMP: per-collapse strategies for the stress spots, read back from data/solves.sqlite. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { comboIndex } from "../utils/comboIndex/comboIndex";

const db = new Database(join(import.meta.dir, "..", "..", "data", "solves.sqlite"), { readonly: true });
const ids = (Bun.argv[2] ?? "stress-multi-01").split(",");
for (const cid of ids) {
  const rows = db.query<any, [string]>(
    "SELECT id, ts, hero_cards, hero_pos, line, tier, trace FROM solves WHERE client_hand_id = ? ORDER BY ts DESC LIMIT 6",
  ).all(cid);
  console.log(`\n=== ${cid}: ${rows.length} stored walks (newest first)`);
  for (const r of rows) {
    const t = JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString("utf-8"));
    const cards = String(r.hero_cards ?? "").match(/[2-9TJQKA][shdc]/gi) ?? [];
    const idx = cards.length === 2 ? comboIndex(cards[0]!, cards[1]!) : null;
    const hero = (t.nodes ?? []).filter((n: any) => n.heroNode).pop() ?? (t.nodes ?? []).at(-1);
    const acts = (hero?.actions ?? []).map((a: any) =>
      `${a.code}=${idx != null && a.strategy ? (100 * (a.strategy[idx] ?? 0)).toFixed(1) : "?"}%` +
      (a.totalFrequency != null ? `(range ${(100 * a.totalFrequency).toFixed(0)}%)` : ""));
    console.log(`  #${r.id} ${new Date(r.ts).toISOString().slice(11, 19)} ${t.kind ?? t.collapse ?? t.plan ?? ""} hero ${r.hero_pos} ${cards.join("")}`);
    console.log(`      seats: ${(t.seats ?? t.spec?.seats ?? []).map((s: any) => s.pos ?? s).join("/")}  line ${r.line}`);
    console.log(`      hero node: ${acts.join("  ")}`);
  }
}
