import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * POST /api/gtow/accounts/:id/probe (probeAccount, 2026-09-28): a WALLED account still accepts tree + solution POSTs —
 * only the spot-solution READ is refused with the hourly 429 (Ultra's probe created a fresh probe solve with 201s, was
 * declared unwalled, and the next node read got 429). So a probe that has to create its solve then READS it, and the
 * verdict is that read. Hermetic: a fake fetch, the pool's token / verdict methods stubbed and recorded, a temp registry.
 */
let probeAccount: typeof import("./gtowAccounts").probeAccount;
let gtowSessions: typeof import("../services/gtowSessions").gtowSessions;
const METHODS = ["tokenFor", "noteSuccess", "noteFailure"] as const;
const saved: { m: string; own: boolean; fn: unknown }[] = [];
const verdicts: string[] = [];
beforeAll(async () => {
  ({ probeAccount } = await import("./gtowAccounts"));
  ({ gtowSessions } = await import("../services/gtowSessions"));
  const s = gtowSessions as any;
  for (const m of METHODS) saved.push({ m, own: Object.prototype.hasOwnProperty.call(s, m), fn: s[m] });
  s.tokenFor = async () => "t";
  s.noteSuccess = (id: string) => { verdicts.push(`success ${id}`); };
  s.noteFailure = (id: string, status: number) => { verdicts.push(`failure ${id} ${status}`); return null; };
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of saved) { if (own) s[m] = fn; else delete s[m]; }
});

let dir = "";
const prevPath = process.env.GTOW_ACCOUNTS_PATH;
const realFetch = globalThis.fetch;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gtow-probe-"));
  process.env.GTOW_ACCOUNTS_PATH = join(dir, "gtow-accounts.json");   // the seeded defaults: no probe solve yet
  verdicts.length = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevPath === undefined) delete process.env.GTOW_ACCOUNTS_PATH; else process.env.GTOW_ACCOUNTS_PATH = prevPath;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ }
});

/** tree + solution POSTs answer 201; the spot-solution reads answer `reads` in order (the last one repeats) */
function fakeGtow(reads: number[]): { kinds: string[] } {
  const log = { kinds: [] as string[] };
  let i = 0;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/custom-trees/")) { log.kinds.push("tree"); return Response.json({ id: "probe-tree" }, { status: 201 }); }
    if (u.pathname.endsWith("/custom-solutions/")) { log.kinds.push("solution"); return Response.json({ id: "probe-sol" }, { status: 201 }); }
    const st = reads[Math.min(i++, reads.length - 1)]!;
    log.kinds.push(`read ${st}`);
    if (st === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(st === 429 ? { detail: "Request limit exceeded" } : { action_solutions: [{ action: { code: "F" } }] }), { status: st, headers: st === 429 ? { "retry-after": "900" } : {} });
  }) as typeof fetch;
  return log;
}
const fast = { firstWaitMs: 1, retryWaitMs: 1 };

describe("probeAccount: the verdict is the READ, never the POSTs", () => {
  it("tree 201 + solution 201 + a 429 on the read = walled, and the wall is renewed", async () => {
    const log = fakeGtow([429]);
    const r = await probeAccount("primary", fast);
    expect(r).toMatchObject({ ok: false, walled: true, status: 429, retryAfter: "900", requestsSpent: 3, created: true });
    expect(log.kinds).toEqual(["tree", "solution", "read 429"]);
    expect(verdicts).toEqual(["failure primary 429"]);
  });

  it("a fresh solve still solving (204) gets a short retry; a 200 read clears the wall — every request counted", async () => {
    const log = fakeGtow([204, 204, 200]);
    const r = await probeAccount("primary", fast);
    expect(r).toMatchObject({ ok: true, walled: false, status: 200, requestsSpent: 5, created: true });
    expect(log.kinds).toEqual(["tree", "solution", "read 204", "read 204", "read 200"]);
    expect(verdicts).toEqual(["success primary"]);
  });

  it("at most three reads: 204 throughout is an answered read (not a wall)", async () => {
    const log = fakeGtow([204]);
    const r = await probeAccount("secondary", fast);
    expect(r).toMatchObject({ walled: false, status: 204, requestsSpent: 5 });
    expect(log.kinds.filter((k) => k.startsWith("read")).length).toBe(3);
    expect(verdicts).toEqual(["success secondary"]);
  });

  it("an unknown account is null (the route answers 404)", async () => {
    fakeGtow([200]);
    expect(await probeAccount("no-such-account", fast)).toBeNull();
  });
});
