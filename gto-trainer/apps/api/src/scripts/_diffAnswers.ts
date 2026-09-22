/** Where the answer CONTENT changed though both old and new answered — the caller-cap class is invisible to
 *  any answered/not-answered metric, because the old answer was confidently wrong rather than missing. */
import { readFileSync } from "node:fs";
import { answerLog } from "../services/answerLog";
const rows = readFileSync("src/scripts/session_backtest.jsonl", "utf8").split("\n")
  .filter((l) => l.trim()).map((l) => JSON.parse(l));
let n = 0;
for (const r of rows) {
  if (!r.now.ok || !r.clientHandId) continue;
  const w = String(r.now.warning ?? "");
  if (!/CALLER CAP|APPROXIMATION/.test(w)) continue;
  const live = (answerLog.forHand(r.clientHandId) as any[])
    .filter((a) => { try { const k = JSON.parse(a.decision_key ?? "null"); return Array.isArray(k) && Number(k[4]) === r.upto; } catch { return false; } }).pop();
  n++;
  const tag = /CALLER CAP/.test(w) ? "CALLER-CAP" : "MULTIWAY";
  console.log(`\n${tag}  #${r.dbId}@${r.upto} ${r.street} ${r.heroPos} ${String(r.heroCards)} seats=${r.seats}`);
  console.log(`  live: ${live?.text ? `"${live.text}"` : live ? `FAILED (${live.fail_reason ?? ""})`.slice(0, 90) : "never asked"}`);
  console.log(`  now : ${r.now.decision}`);
  console.log(`  why : ${w.split(" · ").filter((x: string) => /CALLER CAP|APPROXIMATION/.test(x))[0]?.slice(0, 160)}`);
}
console.log(`\n${n} decisions answered using the new machinery`);
