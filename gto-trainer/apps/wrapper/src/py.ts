/**
 * Python semantics the port has to reproduce exactly (the golden corpus was recorded from the Python wrapper).
 *
 * The traps, each of which silently changes a number or a string the rest of the system reads:
 *  - round(): Python rounds HALF-TO-EVEN on the exact binary value (round(2.5) == 2, round(0.125, 2) == 0.12);
 *    Math.round rounds half up, and toFixed rounds exact ties away from zero.
 *  - f"{x:.2f}" / f"{x:g}": the same half-even rule, and %g's own layout (6 significant digits, exponent below
 *    1e-4 and from 1e6, no trailing zeros).
 *  - str(float): "2.0", not "2"; and scientific notation from 1e16 / below 1e-4 ("1e-05"), not JS's 1e21 / 1e-7.
 *  - json.dumps: ", " / ": " separators and \uXXXX escapes (rows in hands.db are matched with LIKE on that text).
 *  - int() / float() of a string reject what Number() happily accepts ("" -> 0, "3abc" -> 3 via parseInt).
 *  - html.escape escapes quotes too.
 */

/** The exact decimal expansion of a finite double's magnitude: [integer digits, fractional digits]. */
function exactDigits(ax: number): [string, string] {
  if (ax < 1e21) {
    const s = ax.toFixed(100);                       // exact for every double we meet (see the module note)
    const i = s.indexOf(".");
    return [s.slice(0, i), s.slice(i + 1)];
  }
  // ≥ 1e21 is an integer: BigInt gives its exact digits
  return [BigInt(ax).toString(), ""];
}

/** Round the exact value |x| to `n` fractional digits, half-to-even. Returns the digit string (no sign). */
function roundDigits(ax: number, n: number): string {
  const [ip, fp] = exactDigits(ax);
  const frac = fp.padEnd(n + 1, "0");
  let head = ip + frac.slice(0, n);
  const rest = frac.slice(n);
  const first = rest.charCodeAt(0) - 48;
  const tail = rest.slice(1);
  let up = false;
  if (first > 5) up = true;
  else if (first === 5) up = /[1-9]/.test(tail) || ((head.charCodeAt(head.length - 1) - 48) % 2 === 1);
  if (up) {
    const digits = head.split("");
    let i = digits.length - 1;
    while (i >= 0) {
      if (digits[i] === "9") { digits[i] = "0"; i--; }
      else { digits[i] = String.fromCharCode(digits[i]!.charCodeAt(0) + 1); break; }
    }
    head = (i < 0 ? "1" : "") + digits.join("");
  }
  const intLen = head.length - n;
  const intPart = head.slice(0, intLen).replace(/^0+(?=\d)/, "") || "0";
  return n > 0 ? `${intPart}.${head.slice(intLen)}` : intPart;
}

/** Python's round(x, n) for n ≥ 0 (and round(x) when n is omitted — the int result, half-to-even). */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return x;
  const p = 10 ** n;
  const y = Math.abs(x) * p;
  const f = Math.floor(y);
  const d = y - f;
  // far from a tie: the product's rounding error cannot move it across .5
  if (n <= 15 && Math.abs(d - 0.5) > 1e-7 && y < 2 ** 52) {
    const k = d < 0.5 ? f : f + 1;
    const v = n === 0 ? k : k / p;
    return x < 0 ? -v : v;
  }
  const v = Number(roundDigits(Math.abs(x), n));
  return x < 0 ? -v : v;
}

/** f"{x:.{n}f}" */
export function fmtFixed(x: number, n: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  return (neg ? "-" : "") + roundDigits(Math.abs(x), n);
}

/** Significant-digit rounding of |x| (x ≠ 0): the digit string and the decimal exponent of its first digit. */
function sigDigits(ax: number, p: number): { digits: string; exp: number } {
  const [ip, fp] = exactDigits(ax);
  const all = (ip === "0" ? "" : ip) + fp;
  let exp: number;
  let start: number;
  if (ip !== "0") {
    exp = ip.length - 1;
    start = 0;
  } else {
    const z = fp.search(/[1-9]/);
    exp = -(z + 1);
    start = z;
  }
  const body = (ip === "0" ? fp : all).slice(start);
  const keep = body.slice(0, p).padEnd(p, "0");
  const rest = body.slice(p);
  let up = false;
  const first = rest.length ? rest.charCodeAt(0) - 48 : 0;
  if (first > 5) up = true;
  else if (first === 5) up = /[1-9]/.test(rest.slice(1)) || ((keep.charCodeAt(p - 1) - 48) % 2 === 1);
  let digits = keep;
  if (up) {
    const d = keep.split("");
    let i = d.length - 1;
    while (i >= 0) {
      if (d[i] === "9") { d[i] = "0"; i--; } else { d[i] = String.fromCharCode(d[i]!.charCodeAt(0) + 1); break; }
    }
    if (i < 0) { digits = "1" + d.join("").slice(0, p - 1); exp += 1; } else digits = d.join("");
  }
  return { digits, exp };
}

/** f"{x:g}" (and f"{x:.{p}g}") */
export function fmtG(x: number, p = 6): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (p === 0) p = 1;
  const neg = x < 0 || Object.is(x, -0);
  const sign = neg ? "-" : "";
  if (x === 0) return sign + "0";
  const { digits, exp } = sigDigits(Math.abs(x), p);
  if (exp < -4 || exp >= p) {
    let m = digits[0]! + (p > 1 ? "." + digits.slice(1) : "");
    m = m.replace(/\.?0+$/, "");
    const e = Math.abs(exp) < 10 ? `0${Math.abs(exp)}` : String(Math.abs(exp));
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
  }
  let s: string;
  if (exp >= 0) {
    const ip = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
    const fp = digits.slice(exp + 1);
    s = fp ? `${ip}.${fp}` : ip;
  } else {
    s = "0." + "0".repeat(-exp - 1) + digits;
  }
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return sign + s;
}

/** f"{x:,.2f}" — thousands separators on the integer part */
export function fmtFixedComma(x: number, n: number): string {
  const s = fmtFixed(x, n);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [ip, fp] = body.split(".");
  const withCommas = ip!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + withCommas + (fp !== undefined ? "." + fp : "");
}

/** repr()/str() of a Python FLOAT: shortest round-trip digits, Python's layout ("2.0", "1e-05", "1e+16"). */
export function pyFloatStr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mant, e] = x.toExponential().split("e") as [string, string];
  const exp = Number(e);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const ae = Math.abs(exp);
    return `${neg ? "-" : ""}${m}e${exp < 0 ? "-" : "+"}${ae < 10 ? "0" + ae : ae}`;
  }
  let s: string;
  if (exp >= 0) {
    const ip = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
    const fp = digits.slice(exp + 1);
    s = `${ip}.${fp || "0"}`;
  } else {
    s = "0." + "0".repeat(-exp - 1) + digits;
  }
  return (neg ? "-" : "") + s;
}

/**
 * str() of an arbitrary value as Python would print it inside an f-string. Numbers are printed as INTS when
 * integral (the port cannot know a Python float from an int — call pyFloatStr at a site that holds a float).
 */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatStr(v);
  if (typeof v === "string") return v;
  return pyRepr(v);
}

/** repr() of a string, the way Python picks quotes and escapes. */
export function pyReprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return q + out + q;
}

/** repr() of a plain value (lists, dicts, strings, numbers-as-ints). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatStr(v);
  if (typeof v === "string") return pyReprStr(v);
  if (v instanceof PyTuple) return v.items.length === 1 ? `(${pyRepr(v.items[0])},)` : `(${v.items.map(pyRepr).join(", ")})`;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Set) return v.size ? `{${[...v].map(pyRepr).join(", ")}}` : "set()";
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  if (typeof v === "object") return `{${Object.entries(v as object).map(([k, x]) => `${pyReprStr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  return String(v);
}

/** A Python tuple, where one must print as "(a, b)". */
export class PyTuple {
  constructor(public items: unknown[]) {}
}

function jsonStr(s: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i]!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || (ensureAscii && c > 0x7e)) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

export type DumpsOpts = { ensureAscii?: boolean; sortKeys?: boolean; indent?: number; compact?: boolean };

/**
 * json.dumps(v) with Python's defaults: ", " and ": " separators, ensure_ascii=True, keys in insertion order
 * (or sorted), Maps as dicts (keys str()-ed the way json.dumps does: int -> "3", None -> "null", True -> "true").
 * Numbers: integral ones print as ints (see pyStr's caveat); NaN/Infinity as Python writes them.
 */
export function pyJsonDumps(v: unknown, opts: DumpsOpts = {}): string {
  const ensureAscii = opts.ensureAscii !== false;
  const itemSep = opts.compact ? "," : opts.indent !== undefined ? "," : ", ";
  const keySep = opts.compact ? ":" : ": ";
  const ind = opts.indent;
  const enc = (x: unknown, level: number): string => {
    if (x === null || x === undefined) return "null";
    if (x === true) return "true";
    if (x === false) return "false";
    if (typeof x === "number") {
      if (Number.isNaN(x)) return "NaN";
      if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
      return Number.isInteger(x) ? String(x) : pyFloatStr(x);
    }
    if (typeof x === "string") return jsonStr(x, ensureAscii);
    const nl = ind !== undefined ? "\n" + " ".repeat(ind * (level + 1)) : "";
    const close = ind !== undefined ? "\n" + " ".repeat(ind * level) : "";
    if (x instanceof PyTuple) x = x.items;
    if (x instanceof Set) x = [...x];
    if (Array.isArray(x)) {
      if (!x.length) return "[]";
      return "[" + nl + x.map((e) => enc(e, level + 1)).join(itemSep + nl) + close + "]";
    }
    let entries: [string, unknown][];
    if (x instanceof Map) entries = [...x].map(([k, e]) => [jsonKey(k), e]);
    else entries = Object.entries(x as object);
    if (opts.sortKeys) entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (!entries.length) return "{}";
    return "{" + nl + entries.map(([k, e]) => jsonStr(k, ensureAscii) + keySep + enc(e, level + 1)).join(itemSep + nl) + close + "}";
  };
  return enc(v, 0);
}

function jsonKey(k: unknown): string {
  if (k === null || k === undefined) return "null";
  if (k === true) return "true";
  if (k === false) return "false";
  if (typeof k === "number") return Number.isInteger(k) ? String(k) : pyFloatStr(k);
  return String(k);
}

/** int(s) for a str: optional sign, digits, surrounding whitespace; anything else throws (ValueError). */
export function pyInt(s: unknown): number {
  if (typeof s === "number") {
    if (!Number.isFinite(s)) throw new Error(`cannot convert float ${s} to integer`);
    return Math.trunc(s);
  }
  if (typeof s === "boolean") return s ? 1 : 0;
  if (typeof s !== "string") throw new TypeError(`int() argument must be a string or a number, not '${s === null ? "NoneType" : typeof s}'`);
  const t = s.trim().replace(/_/g, "");
  if (!/^[+-]?\d+$/.test(t)) throw new Error(`invalid literal for int() with base 10: ${pyReprStr(s)}`);
  return Number(t);
}

/** float(s): Python's accepted spellings (incl. inf/nan, underscores between digits); anything else throws. */
export function pyFloat(s: unknown): number {
  if (typeof s === "number") return s;
  if (typeof s === "boolean") return s ? 1 : 0;
  if (typeof s !== "string") throw new TypeError(`float() argument must be a string or a real number, not '${s === null ? "NoneType" : typeof s}'`);
  const t = s.trim();
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (/^[+-]?(\d(_?\d)*)?(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?$/.test(t) && /\d/.test(t.replace(/[eE].*$/, ""))) {
    return Number(t.replace(/_/g, ""));
  }
  throw new Error(`could not convert string to float: ${pyReprStr(s)}`);
}

/** html.escape(s, quote=True) */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/** min(xs, key=f): the FIRST element with the smallest key (undefined on empty, where Python raises). */
export function minBy<T>(xs: Iterable<T>, key: (x: T) => number): T | undefined {
  let best: T | undefined;
  let bk = Infinity;
  let first = true;
  for (const x of xs) {
    const k = key(x);
    if (first || k < bk) { best = x; bk = k; first = false; }
  }
  return best;
}

/** max(xs, key=f): the FIRST element with the largest key. */
export function maxBy<T>(xs: Iterable<T>, key: (x: T) => number): T | undefined {
  let best: T | undefined;
  let bk = -Infinity;
  let first = true;
  for (const x of xs) {
    const k = key(x);
    if (first || k > bk) { best = x; bk = k; first = false; }
  }
  return best;
}

/** sorted() of numbers (Python sorts numerically; Array.prototype.sort does not). */
export function sortedNums(xs: Iterable<number>): number[] {
  return [...xs].sort((a, b) => a - b);
}

/** Python truthiness. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "" || Number.isNaN(v)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** dict(...)-style shallow copy of a plain object. */
export const dict = <T extends object>(o: T | null | undefined): T => ({ ...(o || {}) }) as T;

/** Python's `a or b`: the first truthy operand, else the last one. */
export function or<T>(...xs: T[]): T {
  for (const x of xs) if (truthy(x)) return x;
  return xs[xs.length - 1] as T;
}

/** str.split() with no argument: split on runs of whitespace, no empty strings. */
export function splitWs(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Python's `x in s` for a str haystack. */
export const contains = (hay: string, needle: string) => hay.includes(needle);

/** The last `n` items (Python's xs[-n:]). */
export function lastN<T>(xs: T[], n: number): T[] {
  return n <= 0 ? [] : xs.slice(Math.max(0, xs.length - n));
}

/** del xs[:-n] — keep only the last n, in place. */
export function keepLast<T>(xs: T[], n: number): void {
  if (xs.length > n) xs.splice(0, xs.length - n);
}
