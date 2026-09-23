/**
 * Read collapse_calib.jsonl and report what each collapse rule costs. Port of analyzeCollapse.py (2026-09-24).
 *
 *   bun src/scripts/analyzeCollapse.ts [files...]
 *
 * The harness records every VALID collapse of each node. Production cannot pick the best one by peeking at the
 * truth, so this also scores the deterministic SELECTION RULES a shipped implementation would have to use: drop the
 * far villain, drop the near one, drop the wider range, drop the tighter one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ff, fd, fr, fs, globJsonl, mean, median, p90, readJsonl } from "./pyfmt";

const HERE = import.meta.dir;
const paths = process.argv.slice(2).length ? process.argv.slice(2) : globJsonl(HERE, "collapse_calib");
const MASS = join(HERE, "collapse_seat_mass.json");
const seatMass: Record<string, Record<string, number>> = existsSync(MASS) ? JSON.parse(readFileSync(MASS, "utf8")) : {};

// the run can be split across parallel workers; dedupe by node key, last write wins
const seen = new Map<string, any>();
for (const r of readJsonl(paths)) seen.set(r.key, r);
const rows = [...seen.values()];
const ok = rows.filter((r) => r.truth?.ok);
const bad = rows.filter((r) => !r.truth?.ok);
const CHECKED = new Set(["n1", "n2", "n3"]);
const FACING = new Set(["n4", "n5", "n6"]);

const potKind = (r: any) => (r.pot < 5 ? "limped (SPR ~33)" : "raised (SPR ~12)");
function texture(b: string): string {
  const cards: string[] = [];
  for (let i = 0; i < b.length; i += 2) cards.push(b.slice(i, i + 2));
  if (new Set(cards.map((c) => c[0])).size < 3) return "paired";
  const suits = new Set(cards.map((c) => c[1]));
  return suits.size === 1 ? "monotone" : suits.size === 2 ? "two-tone" : "rainbow";
}
/** min/max by key: the FIRST extreme, as Python's min()/max() pick it. */
const firstBy = <T>(xs: T[], key: (x: T) => number, better: (a: number, b: number) => boolean) =>
  xs.reduce((best, x) => (better(key(x), key(best)) ? x : best));
/** sorted() by a tuple key, stable. */
const sortBy = <T>(xs: T[], key: (x: T) => number[]) => [...xs].sort((a, b) => {
  const ka = key(a), kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
  return 0;
});

/** Every scored collapse on a row, plus the deterministic selection rules, as name -> result. */
function methods(r: any): Map<string, any> {
  const out = new Map<string, any>();
  const res: Record<string, any> = r.results || {};
  const seats: string[] = r.seats, hero = r.hero;
  const hi = seats.indexOf(hero);
  const ghosts = new Map<string, any>();
  for (const [k, v] of Object.entries(res)) if (k.startsWith("ghost:") && v.ok) ghosts.set(k.split(":").slice(1).join(":"), v);
  for (const [k, v] of Object.entries(res)) if (v.ok) out.set(k, v);
  if (ghosts.size) {
    // deterministic rules over the ghosts that were actually legal at this node
    const byDist = sortBy([...ghosts.keys()], (p) => [-Math.abs(seats.indexOf(p) - hi), seats.indexOf(p)]);
    out.set("rule:ghost-far", ghosts.get(byDist[0]!));
    out.set("rule:ghost-near", ghosts.get(byDist[byDist.length - 1]!));
    const m = seatMass[r.line + "|" + r.src];
    if (m && Object.keys(m).length) {
      const byMass = sortBy([...ghosts.keys()], (p) => [-(m[p] ?? 0)]);
      out.set("rule:ghost-wider", ghosts.get(byMass[0]!));
      out.set("rule:ghost-tighter", ghosts.get(byMass[byMass.length - 1]!));
    }
    out.set("oracle:best-ghost", firstBy([...ghosts.values()], (v) => v.loss, (a, b) => a < b));
    out.set("oracle:worst-ghost", firstBy([...ghosts.values()], (v) => v.loss, (a, b) => a > b));
  }
  return out;
}

/** One table: every method, over the rows `sel` selects. */
function agg(sel: any[], label: string): void {
  const acc = new Map<string, any[]>();
  for (const r of sel) for (const [k, v] of methods(r)) {
    if (!acc.has(k)) acc.set(k, []);
    acc.get(k)!.push(v);
  }
  const nRows = sel.length;
  console.log(`\n${label}  (${nRows} nodes)`);
  console.log(`  ${fs("method", 20)} ${fr("n", 4)} ${fr("cover", 6)} ${fr("mean bb", 9)} ${fr("median", 8)} ${fr("p90", 8)} `
              + `${fr("% pot", 7)} ${fr("TV", 6)} ${fr("top-act", 8)}`);
  const order = ["blend", "merge", "rule:ghost-far", "rule:ghost-near", "rule:ghost-wider", "rule:ghost-tighter",
                 "oracle:best-ghost", "oracle:worst-ghost", "uniform"];
  const rest = [...acc.keys()].filter((x) => !order.includes(x) && !x.startsWith("ghost:")).sort();
  for (const k of [...order, ...rest]) {
    const v = acc.get(k);
    if (!v || !v.length) continue;
    const loss = v.map((x) => x.loss);
    console.log(`  ${fs(k, 20)} ${fd(v.length, 4)} ${ff((100 * v.length) / Math.max(1, nRows), 0, 5)}% ${ff(mean(loss), 4, 9)} `
                + `${ff(median(loss), 4, 8)} ${ff(p90(loss), 4, 8)} `
                + `${ff(mean(v.map((x) => x.lossPct)), 2, 6)}% ${ff(mean(v.map((x) => x.tv)), 3, 6)} `
                + `${ff(100 * mean(v.map((x) => x.agree)), 0, 7)}%`);
  }
}

console.log(`${rows.length} rows, ${ok.length} solved, ${bad.length} truth failures`);
if (bad.length) {
  const why = new Map<string, number>();
  for (const r of bad) {
    const w = String(r.truth?.why ?? "None").slice(0, 90);
    why.set(w, (why.get(w) ?? 0) + 1);
  }
  console.log("  truth failures:");
  for (const [w, c] of [...why].sort((a, b) => b[1] - a[1])) console.log(`    ${fd(c, 4)}  ${w}`);
}
if (!ok.length) process.exit(0);

agg(ok, "ALL NODES");
agg(ok.filter((r) => CHECKED.has(r.node)), "CHECKED TO HERO (n1-n3): the collapse has two legal ghosts");
agg(ok.filter((r) => FACING.has(r.node)), "FACING A BET (n4-n6): only the non-bettor can be ghosted");
for (const k of [...new Set(ok.map(potKind))].sort()) agg(ok.filter((r) => potKind(r) === k), `POT TYPE: ${k}`);
for (const k of [...new Set(ok.map((r) => texture(r.board)))].sort()) agg(ok.filter((r) => texture(r.board) === k), `TEXTURE: ${k}`);
for (const nd of ["n1", "n2", "n3", "n4", "n5", "n6"]) {
  const sel = ok.filter((r) => r.node === nd);
  if (sel.length) agg(sel, `NODE ${nd}: ${sel[0].note}`);
}

// which way each collapse errs: aggregate aggression vs the truth
console.log("\nDIRECTION — aggregate frequency of hero's aggressive actions (bet/raise), range-weighted");
console.log(`  ${fs("method", 20)} ${fr("truth", 8)} ${fr("method", 8)} ${fr("delta", 8)}`);
const aggrFreq = (codes: string[], freq: number[]) => {
  let s = 0;
  for (let i = 0; i < Math.min(codes.length, freq.length); i++) if (["B", "R", "A"].includes(codes[i]!.slice(0, 1))) s += freq[i]!;
  return s;
};
for (const k of ["blend", "merge", "rule:ghost-far", "rule:ghost-near", "oracle:best-ghost", "uniform"]) {
  const t: number[] = [], a: number[] = [];
  for (const r of ok) {
    const m = methods(r).get(k);
    if (!m) continue;
    t.push(aggrFreq(r.truth.codes, r.truth.freq));
    a.push(aggrFreq(r.truth.codes, m.freq));
  }
  if (t.length) console.log(`  ${fs(k, 20)} ${ff(100 * mean(t), 1, 7)}% ${ff(100 * mean(a), 1, 7)}% ${ff(100 * (mean(a) - mean(t)), 1, 7, true)}pp`);
}

// DOES THE ERROR SCALE WITH HOW MUCH OF THE FIELD THE COLLAPSE REMOVES? This licenses reading the 3->2 grid across
// to other table sizes: if loss tracks the share of villain range mass removed, the grid speaks to 5-way directly.
console.log("\nERROR vs SHARE OF THE FIELD REMOVED (each ghost, by the dropped seat's share of villain range mass)");
const buckets = new Map<number, number[]>();
const pairs: [number, number][] = [];
for (const r of ok) {
  const m = seatMass[r.line + "|" + r.src];
  if (!m || !Object.keys(m).length) continue;
  const vill = (r.seats as string[]).filter((p) => p !== r.hero);
  const totV = vill.reduce((s, p) => s + (m[p] ?? 0), 0);
  if (totV <= 0) continue;
  for (const [k, v] of Object.entries<any>(r.results || {})) {
    if (!k.startsWith("ghost:") || !v.ok) continue;
    const share = (m[k.split(":").slice(1).join(":")] ?? 0) / totV;
    const b = Math.min(4, Math.trunc(share * 5));
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(v.loss);
    pairs.push([share, v.loss]);
  }
}
console.log(`  ${fs("dropped share", 16)} ${fr("n", 4)} ${fr("mean bb", 9)} ${fr("median", 8)}`);
for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
  const v = buckets.get(b)!;
  console.log(`  ${fs(`${fd(b * 20, 2)}-${fd(b * 20 + 20, 3)}%`, 16)} ${fd(v.length, 4)} ${ff(mean(v), 4, 9)} ${ff(median(v), 4, 8)}`);
}
if (pairs.length > 2) {
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let cov = 0, vx = 0, vy = 0;
  for (const [a, b] of pairs) {
    cov += (a - mx) * (b - my);
    vx += (a - mx) ** 2;
    vy += (b - my) ** 2;
  }
  if (vx > 0 && vy > 0) console.log(`  correlation(share removed, loss) = ${ff(cov / (vx * vy) ** 0.5, 3, 0, true)} over ${pairs.length} ghosts`);
}

// the noise floor: how negative do losses get (equilibrium indifference + solver tolerance)
const allv = ok.flatMap((r) => [...methods(r).values()].map((x) => x.loss));
const neg = allv.filter((x) => x < 0);
console.log(`\nnoise floor: ${neg.length} of ${allv.length} scores below zero, most negative ${ff(Math.min(...allv), 4)} bb`);
console.log(`solve time: median ${ff(median(ok.map((r) => r.ms)) / 1000, 1)}s per node (truth + every collapse)`);
