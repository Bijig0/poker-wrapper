import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GtowRequestLog } from "./gtowRequestLog";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "gtow-req-"));
  dirs.push(d);
  return new GtowRequestLog(join(d, "gtow_requests.jsonl"));
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("gtowRequestLog", () => {
  test("every note is one line, and stats count it per account and kind", () => {
    const log = fresh();
    log.note({ session: "primary", kind: "tree", status: 201 });
    log.note({ session: "primary", kind: "poll", status: 200 });
    log.note({ session: "primary", kind: "poll", status: 429 });
    log.note({ session: "secondary", kind: "solution", status: 201 });
    log.note({ session: null, kind: "poll", status: 0 });
    expect(readFileSync(log.path, "utf8").trim().split("\n")).toHaveLength(5);
    const s = log.stats();
    expect(s.last24h.total).toBe(5);
    expect(s.last24h.bySession).toEqual({ primary: 3, secondary: 1, unknown: 1 });
    expect(s.last24h.byKind).toEqual({ tree: 1, poll: 3, solution: 1 });
    expect(s.last24h.status429).toBe(1);
    expect(s.cap).toBe(1275);
    expect(log.headroom("primary")).toBe(1275 - 3);
    expect(log.headroom("secondary")).toBe(1275 - 1);
  });

  test("the trailing-24h window drops old rows; since-midnight is a separate count", () => {
    const log = fresh();
    const now = Date.UTC(2026, 8, 23, 12, 0, 0);          // 12:00 UTC
    // written by hand so the timestamps can be controlled
    const rows = [
      { ts: now - 30 * 3_600_000, s: "primary", k: "poll", st: 200, o: "t" },   // 30 h ago: outside both
      { ts: now - 20 * 3_600_000, s: "primary", k: "poll", st: 200, o: "t" },   // 20 h ago: in 24h, before midnight
      { ts: now - 2 * 3_600_000, s: "primary", k: "poll", st: 200, o: "t" },    // 2 h ago: in both
    ];
    require("node:fs").writeFileSync(log.path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const s = log.stats(now);
    expect(s.last24h.total).toBe(2);
    expect(s.sinceUtcMidnight.total).toBe(1);
    expect(s.lastHour.total).toBe(0);
  });

  test("a torn line from a concurrent writer is skipped, not fatal", () => {
    const log = fresh();
    log.note({ session: "primary", kind: "tree", status: 201 });
    require("node:fs").appendFileSync(log.path, '{"ts": 1, "s": "prim');
    expect(log.stats().last24h.total).toBe(1);
  });

  test("fetch wrapper counts a thrown request as status 0 and rethrows", async () => {
    const log = fresh();
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => { throw new Error("boom"); };
    try {
      await expect(log.fetch("primary", "poll", "https://api.gtowizard.com/x")).rejects.toThrow("boom");
    } finally {
      globalThis.fetch = orig;
    }
    const s = log.stats();
    expect(s.last24h.total).toBe(1);
    expect(existsSync(log.path)).toBe(true);
  });

  test("GTOW_BLOCK=1 refuses every request with a 503 and writes nothing", async () => {
    const log = fresh();
    const prev = process.env.GTOW_BLOCK;
    process.env.GTOW_BLOCK = "1";
    try {
      const r = await log.fetch("primary", "tree", "https://api.gtowizard.com/x");
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("GTOW_BLOCK");
    } finally {
      if (prev === undefined) delete process.env.GTOW_BLOCK; else process.env.GTOW_BLOCK = prev;
    }
    expect(existsSync(log.path)).toBe(false);
  });

  test("GTOW_RESERVE refuses once the account's headroom is below the reserve", async () => {
    const log = fresh();
    const prev = process.env.GTOW_RESERVE;
    process.env.GTOW_RESERVE = String(1275 - 1);          // headroom 1275, 1274 pass; 1273 is below the reserve
    const orig = globalThis.fetch;
    // @ts-expect-error test stub
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      expect((await log.fetch("primary", "poll", "https://api.gtowizard.com/1")).status).toBe(200);
      expect((await log.fetch("primary", "poll", "https://api.gtowizard.com/2")).status).toBe(200);
      const r = await log.fetch("primary", "poll", "https://api.gtowizard.com/3");
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("GTOW_RESERVE");
      // another account is not affected by the primary's headroom
      expect((await log.fetch("secondary", "poll", "https://api.gtowizard.com/4")).status).toBe(200);
    } finally {
      globalThis.fetch = orig;
      if (prev === undefined) delete process.env.GTOW_RESERVE; else process.env.GTOW_RESERVE = prev;
    }
    expect(log.stats().last24h.total).toBe(3);           // the refused one was never a request
  });

  test("compact keeps the last 48 h once the file is large", () => {
    const log = fresh();
    const now = Date.UTC(2026, 8, 23, 12, 0, 0);
    const old = { ts: now - 3 * 86_400_000, s: "primary", k: "poll", st: 200, o: "t" };
    const recent = { ts: now - 3_600_000, s: "primary", k: "poll", st: 200, o: "t" };
    const lines = [...Array(60_000).fill(JSON.stringify(old)), JSON.stringify(recent)];
    require("node:fs").writeFileSync(log.path, lines.join("\n") + "\n");
    log.compact(now);
    expect(readFileSync(log.path, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
