import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Read the END of an append-only log without reading the rest (2026-09-26). The API is one event loop that also
 * answers live decisions, and the box keeper, the job runner and the ledger pages all took "the last line" or "what
 * is new" from a job log by readFileSync-ing the whole file. HRC job logs grow without bound, so every one of those
 * reads cost more each day. These helpers read only the bytes they need; the whole file is read only when it is
 * smaller than what the caller asks for (and then the answer is the same as from the whole file).
 *
 * Offsets are BYTES (what statSync().size gives), never string indexes.
 */

const FIRST_WINDOW = 64 * 1024;

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * Bytes [from, to) of `path` as text (`to` defaults to the size now). A remembered offset in, only what was appended
 * since out. Throws when the file cannot be opened; an offset at or past the end reads as "".
 */
export function readRange(path: string, from: number, to?: number): { text: string; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const end = Math.min(to ?? size, size);
    if (end <= from) return { text: "", size };
    return { text: readAt(fd, from, end - from).toString("utf-8"), size };
  } finally { closeSync(fd); }
}

/**
 * Hand `look` the complete lines at the end of the file, a growing window at a time (64 KB, then ×4), until it
 * returns something or the window is the whole file. The window never starts mid-line: everything up to its first
 * "\n" is dropped (unless the window is the whole file), so a line-shaped pattern sees whole lines only.
 */
function fromTheEnd<T>(path: string, look: (text: string, whole: boolean) => T | undefined): T | undefined {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    for (let want = Math.min(FIRST_WINDOW, size); ; want = Math.min(want * 4, size)) {
      const buf = readAt(fd, size - want, want);
      const whole = want >= size;
      let start = 0;
      if (!whole) {
        const nl = buf.indexOf(0x0a);   // 0x0a never occurs inside a multi-byte UTF-8 sequence
        if (nl < 0) continue;           // one line longer than the window: widen it
        start = nl + 1;
      }
      const r = look(buf.toString("utf-8", start), whole);
      if (r !== undefined || whole) return r;
    }
  } finally { closeSync(fd); }
}

/**
 * The last `n` lines of the file — the same array as `readFileSync(path, "utf-8").split(split).filter(keep).slice(-n)`,
 * read from the end. Throws when the file cannot be opened.
 */
export function tailLines(path: string, n: number, opts: { split?: string | RegExp; keep?: (line: string) => boolean } = {}): string[] {
  const split = opts.split ?? "\n";
  return fromTheEnd(path, (text, whole) => {
    const lines = opts.keep ? text.split(split).filter(opts.keep) : text.split(split);
    // n that is not a positive count (0, NaN from a bad ?lines=) slices like Array.slice does: it needs the whole file
    return (n > 0 && lines.length >= n) || whole ? lines.slice(-n) : undefined;
  }) ?? [];
}

/**
 * The last match of `re` in the file, or null — the same as the last of `readFileSync(path, "utf-8").matchAll(re)`
 * for a pattern that cannot span a newline, read from the end. `re` must be global. Throws when the file cannot be
 * opened.
 */
export function lastMatch(path: string, re: RegExp): RegExpMatchArray | null {
  if (!re.global) throw new Error("lastMatch needs a global RegExp");
  return fromTheEnd(path, (text) => {
    let last: RegExpMatchArray | undefined;
    for (const m of text.matchAll(re)) last = m;
    return last;
  }) ?? null;
}

/**
 * Follow an append-only log from a byte offset. Each read() returns what was appended since the previous read,
 * prefixed with the previous read's unfinished last line — so a pattern anchored at a line start (`^` with /m) that
 * was only half written last time is matched whole this time, exactly as re-reading everything since `from` would.
 * A missing file reads as "" (the step may not have written anything yet).
 */
export class LogFollower {
  private offset: number;
  private carry: Buffer = Buffer.alloc(0);
  constructor(readonly path: string, from: number) { this.offset = from; }
  read(): string {
    let fresh: Buffer;
    try {
      const fd = openSync(this.path, "r");
      try {
        const size = fstatSync(fd).size;
        fresh = size > this.offset ? readAt(fd, this.offset, size - this.offset) : Buffer.alloc(0);
        this.offset += fresh.length;
      } finally { closeSync(fd); }
    } catch { fresh = Buffer.alloc(0); }
    // bytes, not text: a read that ends inside a multi-byte character keeps its first bytes for the next read
    const all = this.carry.length ? Buffer.concat([this.carry, fresh]) : fresh;
    const nl = all.lastIndexOf(0x0a);
    this.carry = Buffer.from(nl < 0 ? all : all.subarray(nl + 1));
    return all.toString("utf-8");
  }
}
