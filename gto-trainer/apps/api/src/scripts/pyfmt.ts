/**
 * Python's report formatting and statistics, for the analysis scripts ported from Python (2026-09-24): f-string
 * number specs, statistics.mean / median, Counter.most_common. The reports read the same line for line as the
 * Python versions did.
 */
import { fmtFixed } from "../../../wrapper/src/py";

/** f"{x:[+][width].{prec}f}" */
export function ff(x: number, prec: number, width = 0, sign = false): string {
  let s = fmtFixed(x, prec);
  if (sign && !s.startsWith("-")) s = "+" + s;
  return s.padStart(width);
}
/** f"{n:{width}d}" */
export const fd = (n: number, width = 0) => String(Math.trunc(n)).padStart(width);
/** f"{s:{width}s}" (left) / f"{s:>{width}s}" (right) */
export const fs = (s: unknown, width: number) => String(s).padEnd(width);
export const fr = (s: unknown, width: number) => String(s).padStart(width);

/** Exact sum (Shewchuk / math.fsum), so a mean agrees with Python's exact statistics.mean to the last bit. */
export function fsum(xs: number[]): number {
  const partials: number[] = [];
  for (let x of xs) {
    let i = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo) partials[i++] = lo;
      x = hi;
    }
    partials.length = i;
    partials.push(x);
  }
  return partials.reduce((a, b) => a + b, 0);
}
export function mean(xs: number[]): number {
  if (!xs.length) throw new Error("mean requires at least one data point");
  return fsum(xs) / xs.length;
}
export function median(xs: number[]): number {
  if (!xs.length) throw new Error("no median for empty data");
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** sorted(xs)[int(0.9 * (len - 1))] — the scripts' p90. */
export const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.trunc(0.9 * (xs.length - 1))]!;

/** Counter(xs).most_common(n): by count, ties in first-seen order. */
export function mostCommon<T>(xs: Iterable<T>, n?: number): [T, number][] {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  const out = [...m].sort((a, b) => b[1] - a[1]);
  return n === undefined ? out : out.slice(0, n);
}

/** Every line of the jsonl files, parsed; a partial last line (a worker killed mid-write) is skipped. */
export function readJsonl(paths: string[]): any[] {
  const out: any[] = [];
  for (const p of paths) {
    for (const raw of require("node:fs").readFileSync(p, "utf8").split("\n")) {
      const l = raw.trim();
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
  }
  return out;
}
/** sorted(glob(dir/prefix*.jsonl)) */
export function globJsonl(dir: string, prefix: string): string[] {
  const { readdirSync } = require("node:fs");
  const { join } = require("node:path");
  return (readdirSync(dir) as string[]).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort().map((f) => join(dir, f));
}
