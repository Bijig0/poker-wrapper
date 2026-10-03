/**
 * Shared by the golden tests: read the corpus the Python recorder wrote (ignition-study-wrapper/tests/golden),
 * and normalise TS values the way tests/golden/common.py normalises Python ones, so the two can be compared.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
 * DELIBERATE CHANGES TO THE PAGE CODE since the recording (page-js-revisions.json: each recorded text, its text now,
 * when and why — 2026-09-25: the frame resolver finds a table by the client's own tag, pinned on the first read, since
 * closing one table moved the others' readers onto their neighbours; TABLE_JS reports that tag, the page's tags and
 * whether our frame is being drawn). Every page question embeds them; it is compared with each one swapped back to
 * the recorded text, and a table the formats flows now name by the client's own tag ({"tag":"N"}) back to the number
 * the recording named it by — so the goldens still pin every other character of every question, and an edit not
 * listed there fails. What the new code does is tested on its own (cross-table.test.ts, table-binding-replay.test.ts,
 * table-frame.test.ts).
 */
const PAGE_JS_REVISIONS: { old: string; new: string }[] = JSON.parse(readFileSync(join(import.meta.dir, "page-js-revisions.json"), "utf8"));
export function asRecordedFrame(q: string): string {
  if (typeof q !== "string" || !q.includes("__frame")) return q;
  for (const r of [...PAGE_JS_REVISIONS].reverse()) q = q.split(r.new).join(r.old);
  return q.replace(/__frame\(\{"tag":"(\d+)"\}\)/g, "__frame($1)").replace(/const SLOT = \{"tag":"(\d+)"\};/g, "const SLOT = $1;");
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

/**
 * SUPERSEDED 2026-10-04 — IGNITION'S DEAD BUTTON (hands 4922299303 / 4922296152). The Python wrapper named positions
 * counting the dealer seat even when that seat was not dealt (CO_DEALER_SEAT on a seat CO_CARDTABLE_INFO left out): it
 * labelled the undealt seat BTN and every dealt non-blind seat one name early. The fix names the seats DEALT (hand.ts
 * buttonOrder). This maps a RECORDED positions map onto the fixed rule, independently of the code under test: the
 * dealer's label is dropped; a table dealt two is the small blind and the big blind (the seat recorded BB keeps it);
 * otherwise the blinds keep their names and the other dealt seats, in their recorded order, take the LATEST names
 * (UTG/HJ/CO/BTN, or the nine-seat UTG/UTG1/UTG2/LJ/HJ/CO/BTN past four). Applied only where the INPUT has the dealer
 * outside a dealt list of two or more.
 */
const LATE6 = ["UTG", "HJ", "CO", "BTN"];
const LATE9 = ["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO", "BTN"];
export function asDeadButtonPositions(recorded: Record<string, string>, dealer: number, dealt: number[]): Record<string, string> {
  const keep = Object.entries(recorded).filter(([k]) => Number(k) !== dealer && dealt.includes(Number(k)));
  if (keep.length === 2) {
    const bb = keep.find(([, v]) => v === "BB")?.[0] ?? null;
    if (bb !== null) return Object.fromEntries(keep.map(([k]) => [k, k === bb ? "BB" : "SB"]));
    return Object.fromEntries(keep);
  }
  const others = keep.filter(([, v]) => v !== "SB" && v !== "BB").sort((a, b) => LATE9.indexOf(a[1]) - LATE9.indexOf(b[1]));
  const vocab = others.length <= 4 ? LATE6 : LATE9;
  const names = vocab.slice(vocab.length - others.length);
  const renamed = new Map(others.map(([k], i) => [k, names[i]!]));
  return Object.fromEntries(keep.map(([k, v]) => [k, renamed.get(k) ?? v]));
}
/** The dealer seat outside a dealt list of two or more, and no action of its own this hand (a seat that acted was dealt —
 *  hand.ts dealtForPositions; the socket-mixing capture of 20260920_131406 files another table's "2 check"). */
export const deadDealer = (ws: { dealer?: number | null; dealt?: number[]; actions?: any[] } | null | undefined): boolean =>
  !!ws && ws.dealer != null && Array.isArray(ws.dealt) && ws.dealt.length >= 2 && !ws.dealt.includes(ws.dealer)
  && !(ws.actions || []).some((a: any) => (a.seat ?? a.seatId) === ws.dealer);
