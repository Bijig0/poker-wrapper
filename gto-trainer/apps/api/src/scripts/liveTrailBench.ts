/**
 * THE HAND TRAIL, OFFLINE (2026-10-12, docs/2026-10-12-hand-trail.md §4.3): GET /api/dashboard/live-trail over the
 * recorded hands of the last sessions — what each street drew (chips with a chart, decisions, inputs) and what the route
 * costs (build ms, reply KB) — before the panel asks it under every live answer. Read-only: the hands row, the answer
 * log, the stored solves, the hand facts and the GTO Wizard solve cache are only read; nothing is ever requested.
 *
 *   HAND_FACTS_DB_PATH=<central poker.sqlite> bun src/scripts/liveTrailBench.ts [--hands 200] [--dump <clientHandId>]
 *
 * Do not run while a session is live (it reads the central database the live API writes).
 */
import { Database } from "bun:sqlite";
import { answersDbPath } from "../services/storePaths";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] ?? null : null; };
const N = Number(arg("--hands") ?? 200);
const dump = arg("--dump");

const { default: app } = await import("../routes/dashboard");
const db = new Database(answersDbPath(), { readonly: true });
const ids = dump ? [dump] : (db.query<{ c: string }, [number]>(
  "SELECT client_hand_id AS c FROM answers WHERE client_hand_id IS NOT NULL AND text IS NOT NULL AND length(client_hand_id) = 10 GROUP BY client_hand_id ORDER BY MAX(ts) DESC LIMIT ?",
).all(N)).map((r) => r.c);

const ms: number[] = [], kb: number[] = [];
const tally = { hands: 0, failed: 0, streets: 0, chips: 0, chipsWithChart: 0, decisions: 0, decisionsWithNode: 0, facing: 0, inputs: 0, sentVerbatim: 0, kinds: {} as Record<string, number>, unread: {} as Record<string, number>, example: {} as Record<string, string> };
const misses: string[] = [];
for (const id of ids) {
  const t0 = performance.now();
  const r = await app.request(`/live-trail?hand=${id}`);
  const text = await r.text();
  ms.push(performance.now() - t0);
  kb.push(text.length / 1024);
  if (process.argv.includes("--verbose")) console.error(`${id} ${r.status} ${(performance.now() - t0).toFixed(0)} ms ${(text.length / 1024).toFixed(1)} KB`);
  const j = JSON.parse(text);
  if (dump) {
    // the grids as their size only: the shape of the reply is what a dump is for
    if (process.argv.includes("--raw")) { console.log(JSON.stringify(j)); break; }
    const slim = JSON.stringify(j, (k, v) => (k === "strategy" || k === "range") && v && typeof v === "object" ? `<${Object.keys(v).length} classes>` : k === "shape" ? "<shape>" : v, 1);
    console.log(slim.slice(0, 60_000));
    break;
  }
  if (!j.ok) { tally.failed++; misses.push(`${id}: ${j.error}`); continue; }
  tally.hands++;
  for (const s of j.streets) {
    tally.streets++;
    tally.chips += s.chips.length;
    tally.chipsWithChart += s.chips.filter((c: any) => c.node).length;
    tally.decisions += s.decisions.length;
    for (const ch of s.chips) if (!ch.node) {
      const k = `${s.street}:${s.inputs?.kind ?? "none"}:${ch.label.split(" ")[0]}:${ch.pending ? "pending" : ch.actionIndex != null && s.decisions.length && ch.actionIndex > Math.max(...s.decisions.map((d: any) => d.actionIndex)) ? "after-hero" : "before-hero"}`;
      tally.unread[k] = (tally.unread[k] ?? 0) + 1;
      tally.example[k] ??= `${id} #${ch.actionIndex}${s.inputs?.chart?.walkNote ? ` — ${s.inputs.chart.walkNote}` : ""}${s.note ? ` — ${s.note}` : ""}`;
    }
    tally.decisionsWithNode += s.decisions.filter((d: any) => d.node).length;
    tally.facing += s.decisions.filter((d: any) => d.facing).length;
    if (s.inputs) { tally.inputs++; tally.kinds[`${s.street}:${s.inputs.kind}`] = (tally.kinds[`${s.street}:${s.inputs.kind}`] ?? 0) + 1; }
    if (s.inputs?.street?.sentFrom === "recorded") tally.sentVerbatim++;
    for (const d of s.decisions) if (!d.node && d.answer) misses.push(`${id} ${s.street} #${d.actionIndex} (${d.answer.source ?? d.answer.tier}): no node${s.note ? ` — ${s.note}` : ""}`);
  }
}
if (!dump) {
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };
  console.log(JSON.stringify(tally, null, 1));
  console.log(`build+serve ms  p50 ${q(ms, 0.5).toFixed(1)}  p90 ${q(ms, 0.9).toFixed(1)}  p99 ${q(ms, 0.99).toFixed(1)}  max ${Math.max(...ms).toFixed(1)}`);
  console.log(`reply KB        p50 ${q(kb, 0.5).toFixed(1)}  p90 ${q(kb, 0.9).toFixed(1)}  max ${Math.max(...kb).toFixed(1)}`);
  // the cached second ask: what the panel's re-render costs
  const t1 = performance.now();
  for (const id of ids.slice(0, 50)) await (await app.request(`/live-trail?hand=${id}`)).text();
  console.log(`cached re-ask ms/hand ${((performance.now() - t1) / Math.min(50, ids.length)).toFixed(2)}`);
  console.log(`\nwithout a node (${misses.length}):\n${misses.slice(0, 40).join("\n")}`);
}
process.exit(0);
