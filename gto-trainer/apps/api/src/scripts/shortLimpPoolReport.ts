/**
 * THE SHORT-LIMP POOL EXPERIMENT'S DIAGNOSTIC (2026-10-05; services/poolLimpFloor + hrc6max shortLimperAlone, off switch
 * SHORT_LIMP_POOL=off). Reads the answer log only — no requests, no solves:
 *   - the POOL LIMP FLOOR: postflop decisions whose flop ranges gave a short limper the pool's limp range (the answer's
 *     note "POOL LIMP RANGE: …"), by pool key, the limper's combos before → after, and how those decisions went
 *     (answered / refused, and why);
 *   - the PICKER: preflop decisions read on a short limper's own pool-locked uneven tree ("… his pool-locked uneven limp
 *     tree (30bb) answers"), by chart;
 *   - THE THING IT IS FOR: postflop refusals in hands with a short limper — "no decision node", an empty range — which
 *     should be gone.
 *
 *   bun src/scripts/shortLimpPoolReport.ts [--since 2026-10-05] [--list 12]
 *
 * Good: the floor fires on short-limper hands only, its decisions answer as often as any other postflop decision, and no
 * "no decision node" refusal is left in them. Bad: refusals or timeouts that cluster on floored hands (a 350-combo
 * limper makes bigger trees), or answers that look absurd against a 26% limper (read a few hand pages).
 */
import { Database } from "bun:sqlite";
import { answersDbPath } from "../services/storePaths";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const SINCE_DAY = arg("--since") ?? "2026-10-05";
const SINCE = Date.parse(`${SINCE_DAY}T00:00:00+07:00`);
const LIST = Number(arg("--list")) || 12;
const pct = (k: number, d: number) => (d ? `${((100 * k) / d).toFixed(1)}%` : "—");

type Row = { id: number; ts: number; cid: string; street: string; chart: string | null; source: string | null; warning: string | null; fail: string | null };
const db = new Database(answersDbPath(), { readonly: true });
const rows = db.query<Row, [number]>(`SELECT id, ts, client_hand_id cid, street, chart, source, warning, fail_reason fail FROM answers
  WHERE ts >= ? AND session_id IS NOT NULL ORDER BY ts`).all(SINCE);
console.log(`answers since ${SINCE_DAY}: ${rows.length}`);

// ── the floor ──
const floored = rows.filter((r) => r.street !== "preflop" && /POOL LIMP RANGE:/.test(r.warning ?? ""));
const flooredHands = new Set(floored.map((r) => r.cid));
const keys = new Map<string, { n: number; was: number[]; now: number[] }>();
for (const r of floored) {
  for (const m of (r.warning ?? "").matchAll(/limped — ([\d.]+) combos on [^,]+, now the pool's (\w+) \([^)]*, ([\d.]+) combos\)/g)) {
    const k = keys.get(m[2]!) ?? { n: 0, was: [], now: [] };
    k.n++; k.was.push(Number(m[1])); k.now.push(Number(m[3]));
    keys.set(m[2]!, k);
  }
}
console.log(`\nPOOL LIMP FLOOR: ${floored.length} postflop decisions in ${flooredHands.size} hands`);
for (const [k, v] of [...keys].sort((a, b) => b[1].n - a[1].n)) {
  const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
  console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(4)} · limper ${med(v.was)} → ${med(v.now)} combos (median)`);
}
// every postflop decision of a floored hand (the floor's note rides on the answers; a refusal carries no note)
const inFloored = rows.filter((r) => r.street !== "preflop" && flooredHands.has(r.cid));
const refused = inFloored.filter((r) => r.fail);
const allPost = rows.filter((r) => r.street !== "preflop");
console.log(`  refused in those hands: ${refused.length} of ${inFloored.length} (${pct(refused.length, inFloored.length)}) · every postflop decision: ${pct(allPost.filter((r) => r.fail).length, allPost.length)} refused`);
for (const r of refused.slice(-LIST)) console.log(`    hand ${r.cid} ${r.street}: ${String(r.fail).slice(0, 140)}`);

// ── the picker ──
const picked = rows.filter((r) => r.street === "preflop" && /his pool-locked uneven limp tree/.test(r.warning ?? ""));
const byChart = new Map<string, number>();
for (const r of picked) byChart.set(r.chart ?? "?", (byChart.get(r.chart ?? "?") ?? 0) + 1);
console.log(`\nPICKER: ${picked.length} preflop decisions read on a short limper's own pool-locked uneven tree`);
for (const [c, n] of [...byChart].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(44)} ${n}`);

// ── what it is for ──
const empty = allPost.filter((r) => /no decision node at|range is empty/.test(r.fail ?? ""));
console.log(`\n"no decision node" / empty-range refusals: ${empty.length}${empty.length ? "" : " (good)"}`);
for (const r of empty.slice(-LIST)) console.log(`  hand ${r.cid} ${r.street}${flooredHands.has(r.cid) ? " (floored)" : ""}: ${String(r.fail).slice(0, 140)}`);
console.log(`\noff switch: SHORT_LIMP_POOL=off in config/local.env (the :2000 worker reads it at every decision once restarted)`);
