import { Database } from "bun:sqlite";
import { join } from "node:path";
const db = new Database(join(import.meta.dir, "..", "..", "data", "solves.sqlite"), { readonly: true });
const rows = db.query<any, []>("SELECT id, ts, origin, client_hand_id, street, board, hero_pos, line, tier, trace FROM solves WHERE ok = 1 ORDER BY ts DESC LIMIT 600").all();
let n = 0;
for (const r of rows) {
  const t = JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString("utf-8"));
  const s = t.spec ?? {};
  if (s.midRange || s.midPos) continue;                 // heads-up only
  if (!s.oopRange || !s.flopPot) continue;
  const pre = String(r.line ?? "").split("/")[0];
  console.log(`#${r.id} ${r.origin?.padEnd(6)} ${String(r.client_hand_id).slice(0,14).padEnd(14)} ${s.oopPos}v${s.ipPos} board ${s.board} pot ${s.flopPot} stk ${s.flopStack} pre ${pre}`);
  if (++n >= 25) break;
}
