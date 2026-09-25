import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogFollower, lastMatch, readRange, tailLines } from "./fileTail";

// Every helper is checked against the whole-file read it replaced, on files larger than the first 64 KB window so
// the widening path runs too.
const dir = mkdtempSync(join(tmpdir(), "fileTail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const file = (text: string): string => { const p = join(dir, `f${++seq}.log`); writeFileSync(p, text); return p; };

/** a job-log-shaped text: short and long lines, CRLF and LF, blank lines, some non-ASCII, `lines` lines long */
function logText(lines: number, seed: number): string {
  let s = seed, out = "";
  const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < lines; i++) {
    const r = rnd();
    const body = r < 0.1 ? "" : r < 0.12 ? "x".repeat(20_000 + Math.floor(rnd() * 90_000)) : r < 0.3 ? `[lock] ${i} ♠A♥K — refining ign200_6max_D${i} for ${i % 60} min` : `line ${i} done: ${i}/76 pulled+parsed`;
    out += body + (rnd() < 0.3 ? "\r\n" : "\n");
  }
  return out;
}

describe("tailLines = whole-file split + slice, read from the end", () => {
  const cases: [string, string][] = [
    ["empty", ""],
    ["no newline at all", "just one line"],
    ["no trailing newline", "a\nb\nc"],
    ["trailing newline", "a\nb\nc\n"],
    ["one line longer than the window", "y".repeat(300_000) + "\nlast"],
    ["small log", logText(50, 7)],
    ["big log (several windows)", logText(4_000, 11)],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      const p = file(text);
      for (const n of [1, 2, 8, 10, 200, 600, 100_000, 0, NaN]) {
        expect(tailLines(p, n)).toEqual(text.split("\n").slice(-n));
        // progress.ts' runner log: CRLF-aware, blank lines dropped
        expect(tailLines(p, n, { split: /\r?\n/, keep: Boolean })).toEqual(text.split(/\r?\n/).filter(Boolean).slice(-n));
      }
    });
  }
  it("a missing file throws (callers keep their own catch)", () => {
    expect(() => tailLines(join(dir, "missing.log"), 8)).toThrow();
  });
});

describe("lastMatch = the last whole-file match, read from the end", () => {
  const re = () => /done: (\d+)\/\d+ pulled\+parsed/g;
  const wholeLast = (text: string) => [...text.matchAll(re())].pop()?.[1] ?? null;
  it("finds the last progress line in a big log", () => {
    const text = logText(4_000, 3);
    expect(lastMatch(file(text), re())?.[1] ?? null).toBe(wholeLast(text));
  });
  it("widens to the start when the only match is at the top of a big file", () => {
    const text = "done: 17/76 pulled+parsed\n" + "z".repeat(1_000_000) + "\n" + "tail\n".repeat(10_000);
    expect(lastMatch(file(text), re())?.[1]).toBe("17");
  });
  it("no match → null, and a non-global pattern is refused", () => {
    const p = file("nothing here\n".repeat(20_000));
    expect(lastMatch(p, re())).toBeNull();
    expect(() => lastMatch(p, /done/)).toThrow();
  });
});

describe("readRange = the bytes since a remembered offset", () => {
  it("reads [from, to) by BYTES, and nothing at or past the end", () => {
    const head = "héllo ♠\n";                       // multi-byte: byte and string offsets differ
    const p = file(head + "pulled a 1\npulled b 2\n");
    const from = Buffer.byteLength(head);
    const size = Buffer.byteLength(readFileSync(p));
    expect(readRange(p, from)).toEqual({ text: "pulled a 1\npulled b 2\n", size });
    expect(readRange(p, from, from + 11).text).toBe("pulled a 1\n");
    expect(readRange(p, size).text).toBe("");
    expect(readRange(p, size + 50).text).toBe("");
  });
});

describe("LogFollower = re-reading everything since `from`, one poll at a time", () => {
  it("matches a step-exit marker written in pieces, and only once it is there", () => {
    const p = file("=== step 1/1: x\n");
    const f = new LogFollower(p, Buffer.byteLength(readFileSync(p)));
    const marker = /^--- step exited (-?\d+)/m;
    expect(f.read().match(marker)).toBeNull();
    appendFileSync(p, "working ♥ ...\nstill work");
    expect(f.read().match(marker)).toBeNull();
    appendFileSync(p, "ing\n--- step ex");
    expect(f.read().match(marker)).toBeNull();
    appendFileSync(p, "ited -2\r\n");
    expect(f.read().match(marker)?.[1]).toBe("-2");
  });
  it("never reports what was there before `from`, and a missing file reads as nothing", () => {
    const p = file("--- step exited 0\n");
    expect(new LogFollower(p, Buffer.byteLength(readFileSync(p))).read()).toBe("");
    expect(new LogFollower(join(dir, "not-yet.log"), 0).read()).toBe("");
  });
  it("a multi-byte character split across two polls comes out whole", () => {
    const p = file("");
    const f = new LogFollower(p, 0);
    const spade = Buffer.from("♠");
    appendFileSync(p, Buffer.concat([Buffer.from("a "), spade.subarray(0, 1)]));
    f.read();
    appendFileSync(p, Buffer.concat([spade.subarray(1), Buffer.from(" b\n")]));
    expect(f.read()).toBe("a ♠ b\n");
  });
  it("concatenated polls of a growing log = the log since `from`", () => {
    const text = logText(600, 5);
    const p = file("");
    const f = new LogFollower(p, 0);
    let seen = "";
    for (let i = 0; i < text.length; i += 7_919) {
      appendFileSync(p, text.slice(i, i + 7_919));
      const got = f.read();
      // each poll starts with the previous poll's unfinished line, then carries on
      const lastNl = seen.lastIndexOf("\n");
      expect(got.startsWith(seen.slice(lastNl + 1))).toBe(true);
      seen = seen.slice(0, lastNl + 1) + got;
    }
    expect(seen).toBe(text);
  });
});
