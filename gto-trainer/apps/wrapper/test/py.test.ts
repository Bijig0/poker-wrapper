import { expect, test } from "bun:test";
import { fmtFixed, fmtFixedComma, fmtG, pyFloatStr, pyJsonDumps, pyRepr, pyRound } from "../src/py";
import nums from "./fixtures/py-numbers.json";
import strs from "./fixtures/py-strings.json";

test("python number formatting and rounding", () => {
  const bad: string[] = [];
  for (const r of nums as any[]) {
    const v: number = r.v;
    const got: Record<string, unknown> = {
      repr: pyFloatStr(v), g: fmtG(v), g3: fmtG(v, 3), f0: fmtFixed(v, 0), f1: fmtFixed(v, 1), f2: fmtFixed(v, 2), f4: fmtFixed(v, 4),
      r: pyRound(v), r1: pyRound(v, 1), r2: pyRound(v, 2), r4: pyRound(v, 4), comma: fmtFixedComma(v, 2),
    };
    for (const [k, g] of Object.entries(got)) if (g !== r[k] && !(typeof g === "number" && Object.is(g, r[k]) )) {
      if (typeof g === "number" && g === r[k]) continue;
      bad.push(`${k}(${r.repr}): got ${g}, want ${r[k]}`);
    }
  }
  expect(bad.slice(0, 20)).toEqual([]);
});

test("python repr / json.dumps", () => {
  for (const r of strs as any[]) {
    if ("s" in r) {
      expect(pyRepr(r.s)).toBe(r.repr);
      expect(pyJsonDumps(r.s)).toBe(r.json);
      expect(pyJsonDumps(r.s, { ensureAscii: false })).toBe(r.jsonNA);
    } else {
      expect(pyJsonDumps(r.obj)).toBe(r.json.replace("2.5", "2.5"));
    }
  }
});
