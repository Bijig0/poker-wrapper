/**
 * What the borrowed caller range costs. Reads borrow_calib.jsonl (see scripts/borrowCalibration.ts). Port of
 * analyzeBorrow.py (2026-09-24).
 *
 *   bun src/scripts/analyzeBorrow.ts [files...]
 */
import { ff, fd, fr, fs, globJsonl, mean, median, p90, readJsonl } from "./pyfmt";

const paths = process.argv.slice(2).length ? process.argv.slice(2) : globJsonl(import.meta.dir, "borrow_calib");
const seen = new Map<string, any>();
for (const r of readJsonl(paths)) seen.set(r.key, r);
const rows = [...seen.values()].filter((r) => r.truth?.ok && r.borrowed?.ok);
console.log(`${seen.size} rows, ${rows.length} with both solves`);
if (!rows.length) process.exit(0);

function table(sel: any[], label: string): void {
  const loss = sel.map((r) => r.borrowed.loss), tv = sel.map((r) => r.borrowed.tv), ag = sel.map((r) => r.borrowed.agree);
  const pct = sel.map((r) => r.borrowed.lossPct), wide = sel.map((r) => r.donorMass.ratio);
  console.log(`  ${fs(label, 34)} ${fd(sel.length, 4)} ${ff(mean(loss), 4, 9)} ${ff(median(loss), 4, 8)} `
              + `${ff(p90(loss), 4, 8)} ${ff(mean(pct), 2, 6)}% ${ff(mean(tv), 3, 6)} `
              + `${ff(100 * mean(ag), 0, 6)}% ${ff(mean(wide), 2, 6)}x`);
}

console.log(`\n  ${fs("slice", 34)} ${fr("n", 4)} ${fr("mean bb", 9)} ${fr("median", 8)} ${fr("p90", 8)} ${fr("% pot", 7)} ${fr("TV", 6)} `
            + `${fr("top-act", 7)} ${fr("range", 7)}`);
table(rows, "ALL");
const sortedSet = (xs: any[]) => [...new Set(xs)].sort();
for (const nd of sortedSet(rows.map((r) => r.node))) table(rows.filter((r) => r.node === nd), `node ${nd}: ${rows.find((r) => r.node === nd).note}`);
for (const ln of sortedSet(rows.map((r) => r.line))) table(rows.filter((r) => r.line === ln), `line ${ln}`);
for (const d of sortedSet(rows.map((r) => r.donor))) table(rows.filter((r) => r.donor === d), `borrowing seat ${d}`);

console.log("\nDIRECTION — hero's aggregate bet/raise frequency");
const aggr = (codes: string[], freq: number[]) => codes.reduce((s, c, i) => (i < freq.length && "BRA".includes(c.slice(0, 1)) && c ? s + freq[i]! : s), 0);
const t = rows.map((r) => aggr(r.truth.codes, r.truth.freq));
const b = rows.map((r) => aggr(r.truth.codes, r.borrowed.freq));
console.log(`  truth ${ff(100 * mean(t), 1)}%  borrowed ${ff(100 * mean(b), 1)}%  delta ${ff(100 * (mean(b) - mean(t)), 1, 0, true)}pp`);
