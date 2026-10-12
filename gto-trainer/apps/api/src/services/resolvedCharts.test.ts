import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvedRungs, setResolvedChartsCheckMs } from "./resolvedCharts";
import { chartFor, resetChartPins } from "./hrc3max";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { testTempDir } from "../test/tempDir";

// resolved-charts.json was read ONCE, at module load (hrc3max.ts, chartCatalog.ts): a re-export picked which chart
// answers only after a restart. These walk the file through write / change / break / delete / appear and ask the
// chart picker each time.
const dir = testTempDir("data-reread-");
const file = join(dir, "resolved-charts.json");
let n = 0;
/** write, then give the file an mtime of its own (Windows' coarse clock can give two quick writes the same one) */
const put = (text: string) => { writeFileSync(file, text); const t = new Date(Date.now() - 60_000 + ++n * 1000); utimesSync(file, t, t); };

/** 3-handed, everyone 100bb, hero on the button: the even chart at the D100 rung. */
const hand100 = { handId: 1, heroSeatId: 1, heroCards: ["As", "Ks"], board: [], street: "preflop",
  actions: [
    { seatId: 2, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 3, hero: false, type: "post-bb", amount: 1, street: "preflop" },
  ],
  liveSeats: [1, 2, 3], committed: {}, potByStreet: {}, positions: { 1: "BTN", 2: "SB", 3: "BB" },
  stacks: { 1: 100, 2: 100, 3: 100 },
  currentNode: { street: "preflop", toActSeatId: 1, toActIsHero: true, pot: 1.5, toCall: 1, legalActions: [], complete: false },
  ended: false } as unknown as ParsedHand;
const pick = () => { resetChartPins(); return chartFor(hand100, "BTN").id; };
const V2CI = "ign200_3maxasym2ci_D100_s100_eq", BASE = "ign200_3maxasym_D100_s100_eq";

const saved = { path: process.env.RESOLVED_CHARTS_PATH, off: process.env.RESOLVED_OFF };
beforeAll(() => { process.env.RESOLVED_CHARTS_PATH = file; delete process.env.RESOLVED_OFF; });
afterAll(() => {
  if (saved.path === undefined) delete process.env.RESOLVED_CHARTS_PATH; else process.env.RESOLVED_CHARTS_PATH = saved.path;
  if (saved.off !== undefined) process.env.RESOLVED_OFF = saved.off;
  setResolvedChartsCheckMs(5_000);
  resetChartPins();
});
beforeEach(() => setResolvedChartsCheckMs(0));

describe("resolved-charts.json is followed", () => {
  test("missing at first → the hand-verified D100 fallback; appears later → read", () => {
    try { unlinkSync(file); } catch { /* not there */ }
    expect(resolvedRungs()).toBeNull();
    expect(pick()).toBe(V2CI);                     // fallback: ign200 D100 only
    put(JSON.stringify({ ign200: [95, 100, 105], ign500: [] }));
    expect([...resolvedRungs()!.ign200!]).toEqual([95, 100, 105]);
    expect(pick()).toBe(V2CI);
  });

  test("a re-export that drops the rung changes the pick without a restart", () => {
    put(JSON.stringify({ ign200: [100] }));
    expect(pick()).toBe(V2CI);
    put(JSON.stringify({ ign200: [95], ign500: [100] }));
    expect(pick()).toBe(BASE);
    put(JSON.stringify({ ign200: [100, 105] }));
    expect(pick()).toBe(V2CI);
  });

  test("a file caught mid-copy keeps the manifest read before; the good copy after it is read", () => {
    put(JSON.stringify({ ign200: [95] }));
    expect(pick()).toBe(BASE);
    put('{"ign200": [9');
    expect([...resolvedRungs()!.ign200!]).toEqual([95]);
    expect(pick()).toBe(BASE);
    put(JSON.stringify({ ign200: [100] }));
    expect(pick()).toBe(V2CI);
  });

  test("between checks the file is not stat'ed: a change shows once the check interval has passed", () => {
    put(JSON.stringify({ ign200: [95] }));
    expect(pick()).toBe(BASE);
    setResolvedChartsCheckMs(60_000);
    put(JSON.stringify({ ign200: [100] }));
    expect(pick()).toBe(BASE);                     // read within the interval: the cached manifest
    setResolvedChartsCheckMs(0);
    expect(pick()).toBe(V2CI);
  });

  test("a deleted manifest is the fallback again (what a restart would read)", () => {
    put(JSON.stringify({ ign200: [95] }));
    expect(pick()).toBe(BASE);
    unlinkSync(file);
    expect(resolvedRungs()).toBeNull();
    expect(pick()).toBe(V2CI);
  });
});
