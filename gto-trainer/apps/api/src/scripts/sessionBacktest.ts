/**
 * SESSION BACKTEST (2026-09-21) — replay every hero decision of the archived sessions through the CURRENT
 * production path and diff it against what actually answered at the table.
 *
 * Input is `ignition-study-wrapper/data/hands.db`, the wrapper's own archive: one row per hand, carrying the
 * ParsedHand the feed parser built live. Each hero decision is reconstructed with `truncateAt` — the exact
 * truncation the dashboard's re-solve uses — and fed to `fastSolve` under the 6-max ring strategy. So what is
 * tested is the real pipeline end to end: line translation, chart selection, the caller-cap borrow, range
 * reconstruction, the multiway collapse, the cloud solve.
 *
 * The live answer is joined per decision through the answer log's `decision_key` (its 5th element is the
 * action index, i.e. the same `upto`), so every row says what happened THEN and what happens NOW.
 *
 * ONE WORKER ONLY. Three concurrent workers against GTO Wizard earn `spot-solution 429 Request limit
 * exceeded` (51 of 528 nodes lost that way during the collapse calibration); two were fine, one is safe.
 *
 * Run:  bun src/scripts/sessionBacktest.ts            (resumable — appends to session_backtest.jsonl)
 *       SINCE=2026-09-18 UNTIL=2026-09-21 LIMIT=50 bun src/scripts/sessionBacktest.ts
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { allRows, enrichSync, truncateAt, HANDS_DB } from "../routes/dashboard";
import { answerLog } from "../services/answerLog";
import { fastSolve } from "../services/fastSolve";

const OUT = process.env.OUT ?? join(import.meta.dir, "session_backtest.jsonl");
const SINCE = Date.parse(`${process.env.SINCE ?? "2026-09-18"}T00:00:00Z`);
const UNTIL = Date.parse(`${process.env.UNTIL ?? "2026-09-21"}T00:00:00Z`);
const LIMIT = Number(process.env.LIMIT ?? 1e9);
const STRATEGY = "ign200-ring-6max-equilibrium";
// GTO Wizard rate-limits: the multiway collapse makes 2-3 cloud walks per decision, so an unpaced replay
// earns `spot-solution 429 Request limit exceeded` within a few hundred decisions. Live play is naturally
// paced by the table; a replay is not.
const PACE_MS = Number(process.env.PACE_MS ?? 0);

/** Blinds are not decisions. */
const isDecision = (a: { hero: boolean; type: string }) =>
  a.hero && a.type !== "post-sb" && a.type !== "post-bb";

/** The action index a logged answer refers to — decision_key is [street, board, cards, toCall, index]. */
function indexOfAnswer(a: any): number | null {
  try {
    const k = JSON.parse(a.decision_key ?? "null");
    return Array.isArray(k) ? Number(k[4]) : null;
  } catch {
    return null;
  }
}

/** Group failures into the buckets that decide who owns the fix. */
function classify(reason: string): string {
  const r = reason.toLowerCase();
  if (/unable to connect|not connected|gtow|chart server|unreachable/.test(r)) return "infrastructure";
  if (/didn't close|missed action|ends on villain|not walkable|position unknown|is terminal|past a terminal/.test(r)) return "capture/read";
  if (/node_does_not_exist|not offered|not in the charts|no chart|too far from/.test(r)) return "tree-gap";
  if (/players reach the flop|no collapse|four-way|multiway/.test(r)) return "multiway";
  if (/isn't in the chart range|not in range/.test(r)) return "not-in-range";
  if (/no identifiable villain|no decision|never asked/.test(r)) return "panel/relay";
  return "other";
}

const done = new Set<string>();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { done.add(JSON.parse(l).key); } catch { /* partial line */ }
  }
}
console.error(`${done.size} decisions already replayed; resuming`);
console.error(`hands.db: ${HANDS_DB}`);

const rows = allRows().filter((r) => (r.played_at ?? 0) >= SINCE && (r.played_at ?? 0) < UNTIL);
console.error(`${rows.length} archived hands in range`);

let n = 0, fixed = 0, stillBad = 0, wasOk = 0, brokeNow = 0;
for (const row of rows) {
  const e = enrichSync(row);
  if (!e) { console.error(`  ! hand #${row.rowid} unreadable`); continue; }
  const hand = e.hand;
  const heroPos = e.summary.heroPos ?? hand.positions?.[hand.heroSeatId] ?? null;
  const logged = (e.clientHandId ? (answerLog.forHand(e.clientHandId) as any[]) : [])
    .map((a) => ({ ...a, idx: indexOfAnswer(a) }));

  for (let i = 0; i < hand.actions.length; i++) {
    if (!isDecision(hand.actions[i]!)) continue;
    const key = `${row.rowid}|${i}`;
    if (done.has(key)) continue;
    if (++n > LIMIT) { console.error("LIMIT reached"); process.exit(0); }

    const before = logged.filter((a) => a.idx === i).pop() ?? null;
    const t = truncateAt(hand, i);
    const t0 = Date.now();
    let res: any;
    try {
      res = await fastSolve({ ...t, currentNode: { ...t.currentNode, toActIsHero: true } }, heroPos,
        { heroPos, strategyId: STRATEGY, origin: "replay" });
    } catch (err) {
      res = { ok: false, reason: `THREW: ${err instanceof Error ? err.message : err}` };
    }
    const ms = Date.now() - t0;
    if (PACE_MS > 0 && ms > 200) await new Promise((r) => setTimeout(r, PACE_MS));

    const nowOk = !!res.ok;
    const thenOk = before ? !!before.text : null;          // null = the table never logged this decision
    const rec = {
      key, dbId: row.rowid, upto: i, playedAt: row.played_at, clientHandId: e.clientHandId,
      street: t.street, heroPos, heroCards: hand.heroCards, board: t.board.join(""),
      seats: Object.keys(hand.positions ?? {}).length,
      live: before ? { ok: thenOk, kind: before.fail_kind ?? null, reason: before.fail_reason ?? null, tier: before.tier ?? null } : null,
      now: nowOk
        ? { ok: true, tier: res.tier ?? null, source: res.source ?? null, decision: res.decision?.action ?? null,
            warning: res.warning ?? null, line: res.line ?? null }
        : { ok: false, reason: String(res.reason ?? "?"), bucket: classify(String(res.reason ?? "")) },
      ms,
    };
    appendFileSync(OUT, JSON.stringify(rec) + "\n");

    if (thenOk === false && nowOk) fixed++;
    else if (thenOk === false && !nowOk) stillBad++;
    else if (thenOk === true && nowOk) wasOk++;
    else if (thenOk === true && !nowOk) brokeNow++;

    const tag = thenOk === null ? "NEW " : thenOk && nowOk ? "ok  " : thenOk && !nowOk ? "BROKE" : nowOk ? "FIXED" : "still";
    console.error(`  [${n}] ${tag} #${row.rowid}@${i} ${t.street.padEnd(7)} ${ms}ms  ` +
      (nowOk ? `${rec.now.decision}` : `${String(rec.now.reason).slice(0, 80)}`));
  }
}
console.error(`\nreplayed ${n} decisions — fixed ${fixed}, still failing ${stillBad}, already fine ${wasOk}, regressed ${brokeNow}`);
