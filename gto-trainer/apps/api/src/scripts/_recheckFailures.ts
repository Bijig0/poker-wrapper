/** Re-run every decision the backtest left failing, and classify the message we give now. */
import { readFileSync } from "node:fs";
import { allRows, enrichSync, truncateAt } from "../routes/dashboard";
import { fastSolve } from "../services/fastSolve";
const rows = readFileSync("src/scripts/session_backtest.jsonl", "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const bad = rows.filter((r) => !r.now.ok).sort((a, b) => a.dbId - b.dbId || a.upto - b.upto);
const byId = new Map(allRows().map((r) => [r.rowid, r]));
const cls = (m: string) =>
  /internally inconsistent/.test(m) ? "CAPTURE FAULT (named)"
  : /429|Request limit/.test(m) ? "rate limit (unverifiable today)"
  : /disagrees with the rotation|ends on villain/.test(m) ? "rotation (still)"
  : /didn't close/.test(m) ? "preflop didn't close (still)"
  : /too far from|not offered|NODE_DOES_NOT_EXIST|past a terminal|terminal before/.test(m) ? "tree gap"
  : /table thinned/.test(m) ? "strategy scope (2-3 seats)"
  : "other";
const tally = new Map<string, number>();
for (const r of bad) {
  const e = enrichSync(byId.get(r.dbId)!); if (!e) continue;
  const t = truncateAt(e.hand, r.upto);
  const heroPos = e.summary.heroPos ?? null;
  let res: any; try {
    res = await fastSolve({ ...t, currentNode: { ...t.currentNode, toActIsHero: true } }, heroPos, { heroPos, strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
  } catch (err) { res = { ok: false, reason: `THREW: ${err}` }; }
  const msg = res.ok ? "ANSWERS NOW" : String(res.reason);
  const k = res.ok ? "ANSWERS NOW" : cls(msg);
  tally.set(k, (tally.get(k) ?? 0) + 1);
  console.log(`#${String(r.dbId).padStart(4)}@${String(r.upto).padEnd(3)} ${r.street.padEnd(7)} ${k.padEnd(30)} ${msg.slice(0, 95)}`);
}
console.log("\n" + [...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(3)}  ${k}`).join("\n"));
