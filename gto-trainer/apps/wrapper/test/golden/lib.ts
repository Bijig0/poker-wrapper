/**
 * Shared by the golden tests: read the corpus the Python recorder wrote (ignition-study-wrapper/tests/golden),
 * and normalise TS values the way tests/golden/common.py normalises Python ones, so the two can be compared.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { js } from "../../src/js";
import { pyJsonDumps } from "../../src/py";

export const CORPUS = resolve(import.meta.dir, "../../../../../ignition-study-wrapper/tests/golden/corpus");

export function corpusFiles(prefix: string): string[] {
  return readdirSync(CORPUS).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl.gz")).sort();
}

export function* readCorpus(file: string): Generator<any> {
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(CORPUS, file))));
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (line) yield JSON.parse(line);
  }
}

/** Python's norm(): Map -> object (keys str()-ed), Set -> list sorted by its JSON, NaN/inf -> strings. */
export function normPy(x: unknown): unknown {
  if (x instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of x) out[k === null || k === undefined ? "null" : typeof k === "boolean" ? (k ? "true" : "false") : Array.isArray(k) ? pyJsonDumps(normPy(k), { ensureAscii: false }) : String(k)] = normPy(v);
    return out;
  }
  if (x instanceof Set) {
    const items = [...x].map(normPy);
    const keyed = items.map((v) => [pyJsonDumps(v, { sortKeys: true, ensureAscii: false }), v] as const);
    keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return keyed.map((k) => k[1]);
  }
  if (Array.isArray(x)) return x.map(normPy);
  if (typeof x === "number") {
    if (Number.isNaN(x)) return "NaN";
    if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
    return x;
  }
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (v !== undefined) out[k] = normPy(v);
    return out;
  }
  return x === undefined ? null : x;
}

/**
 * THE FRAME RESOLVER CHANGED 2026-09-25 (session 20260925_180244: closing one table moved the others' readers onto
 * their neighbours' tables). Every recorded page question embeds the resolver (js/launch.FRAME_JS.js, identical to
 * formats.FRAME_FN.js); a question is compared with it swapped back to the one the recording was made with
 * (frame-js-2026-09-21.js, verbatim from git), a table the formats flows now name by the client's own tag
 * ({"tag":"N"}) back to the number the recording named it by, and the table read's new `frameTag` field left out —
 * so the goldens still pin every other character of every question. The new resolver's behaviour is tested on its
 * own (test/unit/cross-table.test.ts), against a DOM shim, closing tables under it.
 */
const FRAME_NOW = () => js("launch.FRAME_JS");
const FRAME_RECORDED = readFileSync(join(import.meta.dir, "frame-js-2026-09-21.js"), "utf8").replace(/\r\n/g, "\n");
const FRAME_TAG_LINE = "\n          frameTag: tf.getAttribute('data-multitableslot'),";
export function asRecordedFrame(q: string): string {
  if (typeof q !== "string" || !q.includes("__frame")) return q;
  return q.split(FRAME_NOW()).join(FRAME_RECORDED).split(FRAME_TAG_LINE).join("")
    .replace(/__frame\(\{"tag":"(\d+)"\}\)/g, "__frame($1)").replace(/const SLOT = \{"tag":"(\d+)"\};/g, "const SLOT = $1;");
}

/** Canonical JSON (keys sorted at every level) — equal iff the two values are equal as JSON. */
export function canon(x: unknown): string {
  return JSON.stringify(x, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

/** The first differing path between two JSON values, for a readable failure. */
export function firstDiff(a: any, b: any, path = "$"): string | null {
  if (canon(a) === canon(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDiff(a[k as any], b[k as any], `${path}.${k}`);
      if (d) return d;
    }
  }
  const s = (v: any) => (v === undefined ? "undefined" : JSON.stringify(v)?.slice(0, 300));
  return `${path}: got ${s(a)}, want ${s(b)}`;
}
