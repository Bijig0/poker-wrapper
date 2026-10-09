import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { __resetLivePriority, cachedBehindLive, keepWarm } from "./livePriority";

// NOT REBUILT WHILE A SESSION IS LIVE (2026-10-09): the registry and the strategy catalogue rebuilt on the live API's
// thread every 20 s / 5 min during a session ("cache refresh sources/registry 22.1 s"). With `holdWhile` / `skipWhile`
// a stale copy is served as is while the session runs, with one log line per key.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cache holds while a session is live", () => {
  let now = 0;
  beforeEach(() => { now = 5_000_000; __resetLivePriority(() => now); });
  afterEach(() => __resetLivePriority());

  it("holdWhile: a stale copy is served and not rebuilt; one log line; rebuilt once the session ends", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      let n = 0, live = true;
      const build = () => ++n;
      const opts = { holdWhile: () => live };
      expect(await cachedBehindLive("reg", 1_000, build, opts)).toBe(1);   // a cold key is still built
      now += 5_000;
      expect(await cachedBehindLive("reg", 1_000, build, opts)).toBe(1);
      expect(await cachedBehindLive("reg", 1_000, build, opts)).toBe(1);
      await sleep(20);
      expect(n).toBe(1);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("reg: not rebuilt while a poker session is live")).length).toBe(1);
      live = false;
      expect(await cachedBehindLive("reg", 1_000, build, opts)).toBe(1);   // stale once more, the rebuild runs behind
      await sleep(20);
      expect(n).toBe(2);
    } finally { log.mockRestore(); }
  });

  it("keepWarm skipWhile: no refresh-ahead during a session", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      let n = 0, live = true;
      await cachedBehindLive("cat", 1_000, () => ++n);
      const stop = keepWarm("cat", 1_000, () => ++n, { leadMs: 500, demandMs: 60_000, everyMs: 5, skipWhile: () => live });
      now += 900;
      await sleep(40);
      expect(n).toBe(1);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("cat: not rebuilt")).length).toBe(1);
      live = false;
      await sleep(40);
      expect(n).toBe(2);
      stop();
    } finally { log.mockRestore(); }
  });
});
