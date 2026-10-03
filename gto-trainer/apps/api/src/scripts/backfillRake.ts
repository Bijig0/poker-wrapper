/**
 * BACKFILL IGNITION'S RAKE INTO ARCHIVED HANDS (2026-10-03). Since the reader keeps CO_CHIPTABLE_INFO's curRake
 * (wrapper ignition/ws.ts), each archived row carries `rake: { bb, byStreet }` and the dashboard prices a won pot after
 * rake exactly. Rows archived before that have none; the wrapper's raw frame dumps (wrapper-debug/ws_dump*.jsonl, about
 * the last 20 MB per table) still hold the frames for the recent ones. This puts the same field on those rows, built
 * the same way: the rake at each pot sweep, keyed by the street being entered (board cards out: 0 → flop, 3 → turn,
 * 4 → river, 5 → end), the last sweep's rake as `bb`.
 *
 *   bun src/scripts/backfillRake.ts [--session <declared id>] [--dir <wrapper-debug dir>] [--write]
 *
 * Without --write it only reports. It never touches a row that already has a rake, and leaves updated_at alone
 * (the stored audits are keyed on it; the rake is not something they read). A running API sees the new field after
 * its next restart (its row cache is keyed on updated_at).
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handsDbPath, wrapperDebugDir } from "../services/storePaths";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] ?? null : null);
const WRITE = argv.includes("--write");
const SESSION = opt("--session");
const DIR = opt("--dir") ?? wrapperDebugDir();

type Sweep = { boardOut: number; rakeCents: number };
const sweeps = new Map<string, Sweep[]>();   // site hand id → its pot sweeps in order

const dumps = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^ws_dump.*\.jsonl(\.\d+)?$/.test(f)) : [];
for (const f of dumps) {
  const handOf = new Map<string, string>();   // socket rid → its current hand
  const boardOf = new Map<string, number>();  // socket rid → board cards out
  for (const line of readFileSync(join(DIR, f), "utf8").split("\n")) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const d = r.data ?? {};
    if (r.pid === "PLAY_STAGE_INFO") { handOf.set(r.rid, String(d.stageNo)); boardOf.set(r.rid, 0); continue; }
    const hand = handOf.get(r.rid);
    if (!hand) continue;
    if (r.pid === "CO_BCARD3_INFO") boardOf.set(r.rid, 3);
    else if (r.pid === "CO_BCARD1_INFO" && (d.pos === 4 || d.pos === 5)) boardOf.set(r.rid, d.pos);
    else if (r.pid === "CO_CHIPTABLE_INFO" && Array.isArray(d.curRake) && d.curRake.length) {
      const list = sweeps.get(hand) ?? [];
      list.push({ boardOut: boardOf.get(r.rid) ?? 0, rakeCents: d.curRake.reduce((a: number, b: number) => a + b, 0) });
      sweeps.set(hand, list);
    }
  }
}

const db = new Database(handsDbPath(), { readwrite: true, create: false });
db.exec("PRAGMA busy_timeout = 10000");
const rows = db.query<{ rowid: number; data: string }, []>("SELECT rowid, data FROM hands WHERE client_hand_id IS NOT NULL").all();
let seen = 0, has = 0, noFrames = 0, noBb = 0, done = 0;
const upd = db.query("UPDATE hands SET data = ? WHERE rowid = ?");
const r2 = (x: number) => Math.round(x * 100) / 100;
db.transaction(() => {
  for (const row of rows) {
    let raw: any;
    try { raw = JSON.parse(row.data); } catch { continue; }
    if (SESSION && raw.sessionId !== SESSION) continue;
    seen++;
    if (raw.rake) { has++; continue; }
    const list = sweeps.get(String(raw.clientHandId));
    if (!list?.length) { noFrames++; continue; }
    const bb = Number(raw.bbCents);
    if (!(bb > 0)) { noBb++; continue; }
    const byStreet: Record<string, number> = {};
    for (const s of list) {
      const entering = s.boardOut >= 5 ? "end" : s.boardOut === 4 ? "river" : s.boardOut === 3 ? "turn" : "flop";
      byStreet[entering] = r2(s.rakeCents / bb);
    }
    raw.rake = { bb: r2(list[list.length - 1]!.rakeCents / bb), byStreet };
    done++;
    if (WRITE) upd.run(JSON.stringify(raw), row.rowid);
  }
})();
console.log(`${dumps.length} dump file(s) in ${DIR}: frames for ${sweeps.size} hand(s)`);
console.log(`${seen} archived hand(s)${SESSION ? ` of ${SESSION}` : ""}: ${has} already carry a rake, ${noFrames} have no frames left, ` +
  `${noBb} no blind size — ${done} ${WRITE ? "written" : "would be written (dry run: pass --write)"}`);
