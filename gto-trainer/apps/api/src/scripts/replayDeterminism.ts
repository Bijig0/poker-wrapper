/**
 * CHECK #13 — replay every live postflop decision against its own recording (services/replayCheck) and file the result
 * in replay_checks, which the Coverage tab reads. Costs no GTO Wizard quota: the only "GTO Wizard" here is the trace's
 * recorded trees and nodes. Runs as its OWN process (services/replayScheduler starts it once a day when the table is
 * quiet) because the replay swaps gtowApi's network calls while it runs.
 *
 *   bun src/scripts/replayDeterminism.ts                 the last 2 days, decisions not replayed yet
 *   bun src/scripts/replayDeterminism.ts --days 30 --redo    replay again
 *   bun src/scripts/replayDeterminism.ts --dry           print, write nothing
 */
process.env.GTOW_PREFETCH = "0";
import { openStore, solvesDbPath } from "../services/storePaths";
import { replayChecks, replayText, replayTrace } from "../services/replayCheck";

const arg = (name: string, dflt: number) => { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) || dflt : dflt; };
const days = arg("--days", 2), limit = arg("--limit", 2000);
const redo = process.argv.includes("--redo"), dry = process.argv.includes("--dry");

const db = openStore(solvesDbPath());
const rows = db.query(`SELECT id, ts, client_hand_id, session_id, street, trace FROM solves
  WHERE origin = 'live' AND street IN ('flop','turn','river') AND ok = 1 AND ts >= ? ORDER BY id DESC LIMIT ?`)
  .all(Date.now() - days * 86_400_000, limit) as { id: number; ts: number; client_hand_id: string | null; session_id: string | null; street: string; trace: Uint8Array<ArrayBuffer> }[];
const done = redo || dry ? new Set<number>() : replayChecks.done(rows.map((r) => r.id));
const t0 = Date.now();
let same = 0, differ = 0, skipped = 0;
const shown: string[] = [];
for (const r of rows) {
  if (done.has(r.id)) continue;
  let trace: any;
  try { trace = JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString("utf-8")); } catch { continue; }
  const res = await replayTrace(trace);
  if (res.ok) same++; else if (res.ok === false) differ++; else skipped++;
  const row = { solveId: r.id, ts: r.ts, replayedAt: Date.now(), clientHandId: r.client_hand_id, sessionId: r.session_id, street: r.street, ...res };
  if (!dry) replayChecks.save(row);
  if (res.ok !== true && shown.length < 15) shown.push(`  solve ${r.id} hand ${r.client_hand_id} ${r.street}: ${replayText(row)}`);
}
console.log(`[replay] ${same + differ + skipped} decisions replayed in ${((Date.now() - t0) / 1000).toFixed(1)} s — ` +
  `${same} identical, ${differ} DIFFER, ${skipped} not replayable${dry ? " (dry run: nothing written)" : ""}`);
if (shown.length) console.log(shown.join("\n"));
process.exit(0);
