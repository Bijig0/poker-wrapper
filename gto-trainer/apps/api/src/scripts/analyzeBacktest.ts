/**
 * Read session_backtest.jsonl and say what the multiway work actually fixed. Port of analyzeBacktest.py (2026-09-24).
 *
 *   bun src/scripts/analyzeBacktest.ts [files...]
 *
 * Every row is one hero decision from the archived sessions, replayed through the current production path, with
 * what the table answered at the time alongside. Four outcomes:
 *   FIXED  failed live, answers now          STILL  failed live, fails now
 *   OK     answered live, answers now        BROKE  answered live, fails now   <- a regression, the row that matters most
 * Rows never logged live ("NEW") are ones the poller never asked about — the no-probe class; counted, not scored.
 */
import { ff, fd, fr, fs, globJsonl, median, mostCommon, p90, readJsonl } from "./pyfmt";

const paths = process.argv.slice(2).length ? process.argv.slice(2) : globJsonl(import.meta.dir, "session_backtest");
const seen = new Map<string, any>();
for (const r of readJsonl(paths)) seen.set(r.key, r);
const rows = [...seen.values()];
console.log(`${rows.length} hero decisions replayed`);
if (!rows.length) process.exit(0);

// Not every live failure is a SOLVER failure, and the replay must not take credit for the others.
// "never asked" — the poller skipped the decision, or hero was judged not to act: the replay answers it because it
// asks, which proves nothing. "infrastructure" — GTO Wizard or the chart server was down at the table.
const NEVER_ASKED = new Set(["no-probe", "socket-stall", "not-to-act-live", "abandoned-stale", "not-heros-turn"]);
const INFRA = new Set(["gtow-down", "solver-unreachable", "solver-timeout"]);
const S = (x: unknown) => (x === null || x === undefined ? "None" : String(x));

function outcome(r: any): string {
  const live = r.live ?? null;
  const now = r.now.ok;
  // a replay that died on GTO Wizard's request limit says nothing about the code
  if (!now && (S(r.now.reason).includes("429") || S(r.now.reason).toLowerCase().includes("timed out"))) return "UNVERIFIED";
  if (live === null) return "NEW";
  const kind = live.kind ?? null;
  if (live.ok) return now ? "OK" : "BROKE";
  if (NEVER_ASKED.has(kind)) return "NEVER-ASKED";
  if (INFRA.has(kind)) return now ? "WAS-INFRA" : "STILL";
  return now ? "FIXED" : "STILL";
}

const buck = new Map<string, any[]>();
const B = (k: string) => buck.get(k) ?? [];
for (const r of rows) {
  const k = outcome(r);
  if (!buck.has(k)) buck.set(k, []);
  buck.get(k)!.push(r);
}
console.log("\noutcome           n     share");
for (const k of ["OK", "FIXED", "WAS-INFRA", "NEVER-ASKED", "STILL", "BROKE", "NEW", "UNVERIFIED"]) {
  console.log(`  ${fs(k, 8)} ${fd(B(k).length, 6)}   ${ff((100 * B(k).length) / rows.length, 1, 5)}%`);
}
const scored = B("OK").length + B("FIXED").length + B("STILL").length + B("BROKE").length;
const failedLive = B("FIXED").length + B("STILL").length;
if (failedLive) console.log(`\nof the ${failedLive} decisions that failed at the table, ${B("FIXED").length} (${ff((100 * B("FIXED").length) / failedLive, 0)}%) answer now`);
if (scored) {
  const then = B("OK").length + B("BROKE").length, now = B("OK").length + B("FIXED").length;
  console.log(`answer rate over the ${scored} scored decisions: ${ff((100 * then) / scored, 1)}% then -> ${ff((100 * now) / scored, 1)}% now`);
}
console.log("\nFIXED — what was failing, by live failure kind");
for (const [k, n] of mostCommon(B("FIXED").map((r) => r.live.kind ?? null))) console.log(`  ${fd(n, 5)}  ${S(k)}`);
console.log("\nSTILL FAILING — by bucket, then by reason");
for (const [k, n] of mostCommon(B("STILL").map((r) => r.now.bucket ?? null))) console.log(`  ${fd(n, 5)}  ${S(k)}`);
console.log("");
for (const [k, n] of mostCommon(B("STILL").map((r) => S(r.now.reason).slice(0, 100)), 15)) console.log(`  ${fd(n, 5)}  ${k}`);
if (B("BROKE").length) {
  console.log("\nREGRESSIONS — answered live, fail now");
  for (const r of B("BROKE").slice(0, 15)) console.log(`  #${r.dbId}@${r.upto} ${fs(r.street, 7)} ${S(r.heroPos)}  ${S(r.now.reason).slice(0, 100)}`);
}
console.log("\nby street");
console.log(`  ${fs("street", 8)} ${fr("n", 5)} ${fr("answered now", 13)} ${fr("answered live", 14)}`);
for (const s of ["preflop", "flop", "turn", "river"]) {
  const sel = rows.filter((r) => r.street === s);
  if (!sel.length) continue;
  const live = sel.filter((r) => r.live);
  const liveRate = live.length ? (100 * live.filter((r) => r.live.ok).length) / live.length : NaN;
  console.log(`  ${fs(s, 8)} ${fd(sel.length, 5)} ${ff((100 * sel.filter((r) => r.now.ok).length) / sel.length, 1, 12)}% ${ff(liveRate, 1, 13)}%`);
}
console.log("\nby table size (seats dealt)");
for (const n of [...new Set(rows.map((r) => r.seats || 0))].sort((a, b) => a - b)) {
  const sel = rows.filter((r) => (r.seats || 0) === n);
  console.log(`  ${n} seats: ${fd(sel.length, 4)} decisions, ${ff((100 * sel.filter((r) => r.now.ok).length) / sel.length, 1, 5)}% answered now`);
}
const mw = rows.filter((r) => r.now.ok && S(r.now.warning || "").includes("APPROXIMATION"));
const cc = rows.filter((r) => r.now.ok && S(r.now.warning || "").includes("CALLER CAP"));
console.log(`\nanswers using the new machinery: ${mw.length} multiway collapse, ${cc.length} caller-cap borrow`);
const lat = rows.filter((r) => r.now.ok).map((r) => r.ms);
if (lat.length) console.log(`latency of an answer: median ${ff(median(lat) / 1000, 1)}s, p90 ${ff(p90(lat) / 1000, 1)}s`);
