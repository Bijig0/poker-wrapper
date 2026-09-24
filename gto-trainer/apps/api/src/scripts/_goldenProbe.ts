// scratch: what the main checkout's solves.sqlite holds (read-only)
import { Database } from "bun:sqlite";
const db = new Database("C:/Users/Brady/poker/gto-trainer/apps/api/data/solves.sqlite", { readonly: true });
console.log(db.query("SELECT origin, street, ok, count(*) n FROM solves GROUP BY 1,2,3 ORDER BY n DESC").all());
console.log(db.query("SELECT min(ts) a, max(ts) b, count(distinct client_hand_id) hands FROM solves").get());
const rows = db.query<any, []>("SELECT id, ts, origin, client_hand_id, street, hero_pos, line, ok, trace FROM solves WHERE ok=1 AND origin='live' ORDER BY id DESC LIMIT 400").all();
const srcs: Record<string, number> = {};
for (const r of rows) {
  const t = JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString());
  const rs = String(t.spec?.rangeSource ?? "?").replace(/_D\d+.*/, "_D*");
  srcs[rs] = (srcs[rs] ?? 0) + 1;
}
console.log(srcs);
const r = rows.find((x) => /6max/.test(JSON.parse(Buffer.from(Bun.gunzipSync(x.trace)).toString()).spec?.rangeSource ?? ""));
if (r) {
  const t = JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString());
  const { oopRange, ipRange, midRange, ...rest } = t.spec;
  console.log(r.id, r.client_hand_id, r.street, r.line, JSON.stringify(rest).slice(0, 800), oopRange?.length, ipRange?.length, midRange?.length);
}
