/**
 * WHAT DOES GTO WIZARD'S LIMIT COUNT? (2026-09-26)
 *
 *   bun src/scripts/gtowQuotaReport.ts [--days 7]
 *
 * Reads the request ledger (gtow_requests + gtow_responses in the central poker.sqlite) and, for every 429
 * episode (a run of 429s on one account with no 10-minute gap), prints:
 *   - the whole stored 429 (body + headers — Retry-After, rate-limit headers) when one was kept
 *   - how long the wall lasted: the last 429 and the first 2xx after it
 *   - what each candidate unit had reached in the trailing 24 h AND since 00:00 UTC when the wall hit
 *     (every request, polls, delivered nodes, DISTINCT nodes, solves, trees)
 *   - the highest each candidate ever reached on that account WITHOUT a 429 — a candidate whose no-wall peak is
 *     above the stated cap cannot be the unit
 *
 * The 429 body says `request_limit: 1275, time_period_in_seconds: 86400`, but on 2026-09-24 the Ultra account sent
 * 6,149 requests in 24 h without one, and the 2026-09-25 wall cleared after 5 minutes. GTO Wizard's own web app
 * shows this 429 as "security protection" — a throttle, not the plan's daily spot limit (that one carries
 * code DAILY_SPOT_SOLUTION_LIMIT_EXCEEDED and a usage counter). Spends nothing: it only reads the ledger.
 */
import { Database } from "bun:sqlite";
import { gtowRequestsPath } from "../services/storePaths";

const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 30;
const db = new Database(gtowRequestsPath(), { readonly: true });
const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(gtow_requests)").all().map((c) => c.name));
const hasQ = cols.has("q");
const hasResponses = !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='gtow_responses'").get();

type Row = { ts: number; s: string; k: string; st: number; q: string | null };
const since = Date.now() - days * 86_400_000;
const all = db.query<Row, [number]>(`SELECT ts, s, k, st, ${hasQ ? "q" : "NULL AS q"} FROM gtow_requests WHERE ts >= ? - 86400000 ORDER BY ts, id`).all(since);
const iso = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 19);

/** candidate units — each is a filter plus, optionally, a key that makes it "distinct" */
const UNITS: { name: string; f: (r: Row) => boolean; key?: (r: Row) => string | null }[] = [
  { name: "every request", f: (r) => r.st !== 429 },
  { name: "polls (spot-solution GETs)", f: (r) => r.k === "poll" && r.st !== 429 },
  { name: "delivered nodes (poll 200)", f: (r) => r.k === "poll" && r.st === 200 },
  { name: "DISTINCT nodes (poll 200, by q)", f: (r) => r.k === "poll" && r.st === 200 && !!r.q, key: (r) => r.q },
  { name: "solves (solution 201)", f: (r) => r.k === "solution" && r.st === 201 },
  { name: "trees", f: (r) => r.k === "tree" && r.st >= 200 && r.st < 300 },
  { name: "library GETs", f: (r) => r.k === "library" && r.st !== 429 },
];

function count(rows: Row[], u: (typeof UNITS)[number], from: number, to: number): number {
  const sel = rows.filter((r) => r.ts >= from && r.ts < to && u.f(r));
  return u.key ? new Set(sel.map(u.key)).size : sel.length;
}

/** highest trailing-24h value of a unit at any moment before `until` (sampled at every request) */
function peakWithoutWall(rows: Row[], u: (typeof UNITS)[number], until: number): { n: number; at: number } {
  const sel = rows.filter((r) => r.ts < until && u.f(r));
  let best = { n: 0, at: 0 };
  if (u.key) {
    // distinct counting over a sliding window: step hourly (exact enough, and O(n) per step)
    for (let t = sel[0]?.ts ?? until; t < until; t += 3_600_000) {
      const n = new Set(sel.filter((r) => r.ts > t - 86_400_000 && r.ts <= t).map(u.key)).size;
      if (n > best.n) best = { n, at: t };
    }
    return best;
  }
  let j = 0;
  for (let i = 0; i < sel.length; i++) {
    while (sel[j].ts < sel[i].ts - 86_400_000) j++;
    if (i - j + 1 > best.n) best = { n: i - j + 1, at: sel[i].ts };
  }
  return best;
}

console.log(`GTO Wizard limit report — ledger ${gtowRequestsPath()}`);
console.log(`window: last ${days} day(s); q column ${hasQ ? "present" : "MISSING (worker not restarted onto the new ledger yet)"}; gtow_responses ${hasResponses ? "present" : "missing"}`);
const qRows = all.filter((r) => r.ts >= since && r.q).length;
console.log(`rows with a request target (q): ${qRows} — DISTINCT-node counts only cover those\n`);

for (const s of [...new Set(all.map((r) => r.s))].sort()) {
  const rows = all.filter((r) => r.s === s);
  const x = rows.filter((r) => r.st === 429 && r.ts >= since);
  // episodes: 429s with no 10-minute gap
  const eps: { start: number; end: number; n: number }[] = [];
  for (const r of x) {
    const last = eps.at(-1);
    if (last && r.ts - last.end < 600_000) { last.end = r.ts; last.n++; } else eps.push({ start: r.ts, end: r.ts, n: 1 });
  }
  console.log(`=== ${s}: ${rows.filter((r) => r.ts >= since).length} requests, ${x.length} x 429 in ${eps.length} episode(s)`);
  for (const e of eps) {
    const cleared = rows.find((r) => r.ts > e.end && r.st >= 200 && r.st < 300);
    const midnight = new Date(e.start); midnight.setUTCHours(0, 0, 0, 0);
    const okInside = rows.filter((r) => r.ts >= e.start && r.ts <= e.end && r.st >= 200 && r.st < 300).length;
    console.log(`\n  episode ${iso(e.start)} -> ${iso(e.end)} UTC: ${e.n} x 429, ${okInside} x 2xx mixed in; first 2xx after: ${cleared ? `${iso(cleared.ts)} (${Math.round((cleared.ts - e.end) / 60_000)} min after the last 429)` : "none yet"}`);
    for (const u of UNITS) {
      const d = count(rows, u, e.start - 86_400_000, e.start);
      const m = count(rows, u, midnight.getTime(), e.start);
      console.log(`    ${u.name.padEnd(34)} trailing 24 h ${String(d).padStart(6)}   since 00:00 UTC ${String(m).padStart(6)}`);
    }
    if (hasResponses) {
      const kept = db.query<{ ts: number; k: string; url: string; headers: string; body: string }, [string, number, number]>(
        "SELECT ts, k, url, headers, body FROM gtow_responses WHERE s = ? AND why = 'limit' AND st = 429 AND ts BETWEEN ? AND ? ORDER BY id LIMIT 1")
        .get(s, e.start - 1000, e.end + 1000);
      if (kept) console.log(`    stored 429 (${kept.k} ${kept.url}):\n      body    ${kept.body}\n      headers ${kept.headers}`);
      else console.log("    no stored 429 body (before the 2026-09-26 ledger, or another process's ledger)");
    }
  }
  const first = x[0]?.ts ?? Date.now();
  console.log(`\n  highest trailing-24 h value WITHOUT a 429 (before ${x.length ? iso(first) : "now"}) — above 1275 means "not the unit":`);
  for (const u of UNITS) {
    const p = peakWithoutWall(rows, u, first);
    console.log(`    ${u.name.padEnd(34)} ${String(p.n).padStart(6)}${p.at ? `  @ ${iso(p.at)}` : ""}${p.n > 1275 ? "   <- over the stated cap with no wall" : ""}`);
  }
  console.log("");
}

// ---------------------------------------------------------------- what the requests of a HAND were
// The hand-tagged rows (h / sr / go since 2026-09-25; pm / cl since 2026-09-27) answer "where does a hand's budget
// go": per street and origin, the trees and solves, and each poll by purpose x outcome. A 204 under `probe` is the
// solve still running; under `node` / `retry` it is a line with no decision node. Per-hand percentiles follow.
if (cols.has("pm")) {
  type R = { h: string; sr: string | null; go: string | null; k: string; st: number; pm: string | null; cl: string | null };
  const tagged = db.query<R, [number]>("SELECT h, sr, go, k, st, pm, cl FROM gtow_requests WHERE ts >= ? AND h IS NOT NULL ORDER BY id").all(since);
  if (tagged.length) {
    console.log(`\n=== REQUEST ANATOMY — ${tagged.length} hand-tagged requests over ${new Set(tagged.map((r) => r.h)).size} hands (last ${days} day(s))`);
    const groups = new Map<string, R[]>();
    for (const r of tagged) { const k = `${r.sr ?? "?"} ${r.go ?? "?"}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
    const order = ["preflop", "flop", "turn", "river"];
    const outcome = (st: number) => (st === 200 ? "200" : st === 204 ? "204" : st === 429 ? "429" : "other");
    for (const [k, rs] of [...groups].sort((a, b) => order.indexOf(a[0].split(" ")[0]!) - order.indexOf(b[0].split(" ")[0]!) || a[0].localeCompare(b[0]))) {
      const hands = new Set(rs.map((r) => r.h)).size;
      const trees = rs.filter((r) => r.k === "tree").length, sols = rs.filter((r) => r.k === "solution").length;
      const polls = rs.filter((r) => r.k === "poll");
      const by: Record<string, Record<string, number>> = {};
      for (const p of polls) { const pm = p.pm ?? "untagged"; (by[pm] ??= {})[outcome(p.st)] = ((by[pm] ??= {})[outcome(p.st)] ?? 0) + 1; }
      const pollTxt = Object.entries(by).sort().map(([pm, o]) => `${pm} ${Object.entries(o).sort().map(([s, n]) => `${s}×${n}`).join(" ")}`).join(" | ");
      const callers = Object.entries(polls.reduce<Record<string, number>>((a, p) => { const c = p.cl ?? "-"; a[c] = (a[c] ?? 0) + 1; return a; }, {})).sort().map(([c, n]) => `${c} ${n}`).join(", ");
      console.log(`  ${k.padEnd(14)} hands ${String(hands).padStart(3)} | ${(rs.length / hands).toFixed(1).padStart(5)} req/hand | trees ${trees} solves ${sols} | polls: ${pollTxt || "none"} | asked by: ${callers}`);
    }
    // per-hand totals
    const perHand = new Map<string, number>(); for (const r of tagged) perHand.set(r.h, (perHand.get(r.h) ?? 0) + 1);
    const v = [...perHand.values()].sort((a, b) => a - b);
    const pct = (p: number) => v[Math.floor(p * (v.length - 1))];
    console.log(`  per hand (all streets): median ${pct(0.5)}, p75 ${pct(0.75)}, p90 ${pct(0.9)}, max ${v.at(-1)} requests`);
    const wasted = tagged.filter((r) => r.k === "poll" && r.st === 204);
    const solving = wasted.filter((r) => r.pm === "probe" || r.pm === "legacy").length;
    const noNode = wasted.filter((r) => r.pm === "node" || r.pm === "retry").length;
    const untagged = wasted.length - solving - noNode;
    console.log(`  204s: ${wasted.length} of ${tagged.length} requests (${(100 * wasted.length / tagged.length).toFixed(0)}%) — ${solving} while a solve ran, ${noNode} on lines with no node${untagged ? `, ${untagged} untagged (rows from before 2026-09-27: either)` : ""}`);
  }
}

if (hasResponses) {
  const samples = db.query<{ s: string; k: string; st: number; headers: string }, [number]>(
    "SELECT s, k, st, headers FROM gtow_responses WHERE why = 'sample' AND ts >= ? GROUP BY s, k, st ORDER BY s, k, st").all(since);
  if (samples.length) {
    console.log("=== header samples of normal replies (one per account x kind x status):");
    for (const r of samples) console.log(`  ${r.s} ${r.k} ${r.st}: ${r.headers}`);
  }
}
