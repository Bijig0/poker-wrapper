/**
 * THE PREFLOP PIECE'S ACCOUNT FAILOVER (2026-10-12; hand 4923636936: five polls of the minting account hung at the 8 s
 * cap and the node came 1 s inside the 30 s read). What the postflop chain has had since 2026-10-08, here:
 *   - a tree / solution POST that fails (times out, the connection drops) moves on to the next account, never a throw;
 *   - a poll that HANGS re-posts the solve (tree, solution, locks) on another account when a cold tree fits what is left
 *     of the read, and the read goes on there — the caller's old solution id keeps answering (`moved`);
 *   - a 429 on the owning account re-posts the same way, or, with no time left, forgets the tree's memo so the next ask
 *     posts afresh elsewhere (it used to hand the walled solve back for every re-ask);
 *   - a node-lock POST that fails is sent once more on the same account (the parent lives there);
 *   - (2026-10-13) a re-post leaves out EVERY account the read has hung or walled on, not only the last one — it used to
 *     ping-pong back to the account that hung first — and the read never waits past its own clock (not for a poll wait,
 *     not for a re-post onto a slow account: that one lands for the next ask).
 * The network is a fake fetch keyed on the bearer token (one per account); a hang rejects when the poll's own
 * AbortSignal fires, exactly as a real timed-out request does.
 *
 * THE FILE USED TO HANG FOREVER (2026-10-13; `bun test` in apps/api and so setup/regress.ts never finished). Bun 1.3.14
 * on Windows never fires an AbortSignal.timeout while nothing else holds the event loop open: the loop spins at 100% CPU
 * and the test's own timeout never fires either. A real hung request holds its socket open, and the API process always
 * has its server, so live polls are cut off as they should be; the fake's hang held nothing. It now holds a timer, as
 * the socket would. Every test has its own timeout too (T), which works only because the hang holds that timer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

/** each test's own timeout: the longest (a read polled to its 4 s end) takes ~4 s */
const T = 15_000;

let P: typeof import("./gtowAiPreflop");
let gtowSessions: typeof import("./gtowSessions").gtowSessions;
const POOL_METHODS = ["route", "routeIgnoringBlocks", "liveFirst", "tokenFor", "bestToken", "noteSuccess", "noteFailure", "noteRouted", "forceRefresh"] as const;
const savedPool: { m: string; own: boolean; fn: unknown }[] = [];
let routeIds: string[] = ["primary", "secondary"];
let failures: { id: string; status: number }[] = [];
const ENV = ["GTOW_POLL_HANG_MS", "GTOW_NODE_TIMEOUT_MS", "GTOW_PREFLOP_REPOST_MS", "GTOW_PREFETCH"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  P = await import("./gtowAiPreflop");
  ({ gtowSessions } = await import("./gtowSessions"));
  const s = gtowSessions as any;
  for (const m of POOL_METHODS) savedPool.push({ m, own: Object.prototype.hasOwnProperty.call(s, m), fn: s[m] });
  s.route = () => [...routeIds];
  s.routeIgnoringBlocks = s.route;
  s.liveFirst = (ids: string[]) => ids;
  s.tokenFor = async (id: string) => `tok-${id}`;
  s.bestToken = async () => ({ id: "primary", token: "tok-primary" });
  s.noteSuccess = () => {};
  s.noteFailure = (id: string, status: number) => { failures.push({ id, status }); return null; };
  s.noteRouted = () => "test";
  s.forceRefresh = async () => true;
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.GTOW_PREFETCH = "0";
});
afterAll(() => {
  const s = gtowSessions as any;
  for (const { m, own, fn } of savedPool) { if (own) s[m] = fn; else delete s[m]; }
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  P.resetAiPreflopMemory();
});

const realFetch = globalThis.fetch;
// before EACH test, the first included: a test run on its own (--test-name-pattern) used to get the live 8 s / 30 s
beforeEach(() => {
  process.env.GTOW_POLL_HANG_MS = "200";
  process.env.GTOW_NODE_TIMEOUT_MS = "4000";
  process.env.GTOW_PREFLOP_REPOST_MS = "500";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  P.resetAiPreflopMemory();
  routeIds = ["primary", "secondary"];
  failures = [];
});

interface Seen { kind: "tree" | "solution" | "lock" | "poll"; acct: string; sol?: string | null; body?: any }
interface Fake {
  seen: Seen[];
  /** accounts whose polls never reply (the poll's own abort ends them) */
  hang: Set<string>;
  /** accounts whose polls answer 429 */
  walled: Set<string>;
  /** accounts whose tree POST fails (the request throws) */
  treeFails: Set<string>;
  /** accounts whose tree POST replies only after this many ms (a slow account, well inside the 20 s request bound) */
  slowTree: Map<string, number>;
  /** how many lock POSTs on an account still fail before one lands */
  lockFails: Map<string, number>;
  /** solution ids minted per account */
  ownerOf: Map<string, string>;
}
const NODE = { action_solutions: [{ action: { code: "R2.5", type: "RAISE", betsize: "2.5" }, strategy: new Array(1326).fill(1) }] };
function fakeGtow(): Fake {
  const f: Fake = { seen: [], hang: new Set(), walled: new Set(), treeFails: new Set(), slowTree: new Map(), lockFails: new Map(), ownerOf: new Map() };
  let seq = 0;
  const timeoutErr = () => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  /** a poll that never replies: rejected when its own AbortSignal fires (the read's bound), as a real one is. `hold`
   *  stands in for the open socket: without it Bun never fires the signal (see the top of the file). */
  const timedOut = (signal: AbortSignal | null | undefined) => new Promise<Response>((_, rej) => {
    const hold = setTimeout(() => {}, 60_000);
    const fire = () => { clearTimeout(hold); rej(timeoutErr()); };
    if (!signal) return;
    if (signal.aborted) fire(); else signal.addEventListener("abort", fire, { once: true });
  });
  /** a POST whose request failed (a 20 s timeout live, a dropped connection): the same rejection, at once */
  const failed = () => Promise.reject<Response>(timeoutErr());
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(String(input));
    const acct = String(init?.headers?.Authorization ?? init?.headers?.authorization ?? "").replace(/^Bearer tok-/, "");
    if (u.pathname.endsWith("/custom-trees/")) {
      f.seen.push({ kind: "tree", acct, body: JSON.parse(init.body) });
      if (f.treeFails.has(acct)) return failed();
      const slow = f.slowTree.get(acct);
      if (slow) return new Promise<Response>((res) => setTimeout(() => res(Response.json({ id: `tree-${++seq}` }, { status: 201 })), slow));
      return Response.json({ id: `tree-${++seq}` }, { status: 201 });
    }
    if (u.pathname.endsWith("/custom-solutions/")) {
      const body = JSON.parse(init.body);
      const kind = body.parent_solution_id ? "lock" : "solution";
      f.seen.push({ kind, acct, body });
      if (kind === "lock") {
        const left = f.lockFails.get(acct) ?? 0;
        if (left > 0) { f.lockFails.set(acct, left - 1); return failed(); }
      }
      const id = `sol-${++seq}-${acct}`;
      f.ownerOf.set(id, acct);
      return Response.json({ id }, { status: 201 });
    }
    const sol = u.searchParams.get("custom_solution_id");
    f.seen.push({ kind: "poll", acct, sol });
    if (f.hang.has(acct)) return timedOut(init?.signal);
    if (f.walled.has(acct)) return new Response(JSON.stringify({ detail: "Request limit exceeded" }), { status: 429 });
    return Response.json(NODE);
  }) as typeof fetch;
  return f;
}
const BODY = { players: [{ position: "BTN" }, { position: "BB" }], tag: "failover-test" };
const LOCK = { action_history: [], strategy: [{ action: "C", strategy: [] }], hands_locked: [], previous_nodes_lock_type: "street_all" as const };
const polls = (f: Fake, acct: string) => f.seen.filter((x) => x.kind === "poll" && x.acct === acct).length;
const trees = (f: Fake) => f.seen.filter((x) => x.kind === "tree").map((x) => x.acct);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe("a tree or solution POST that fails", () => {
  it("moves on to the next account instead of throwing out of the solve", async () => {
    const f = fakeGtow();
    f.treeFails.add("primary");
    const r = await P.poolLockSeams.solve("k-tree-fail", BODY, { preflop: true });
    expect("solId" in r).toBe(true);
    expect(trees(f)).toEqual(["primary", "secondary"]);
    expect(f.ownerOf.get((r as { solId: string }).solId)).toBe("secondary");
    // the solve's polls carry its own account's token
    const n = await P.fetchNode((r as { solId: string }).solId, "");
    expect("error" in n).toBe(false);
    expect(polls(f, "primary")).toBe(0);
    expect(polls(f, "secondary")).toBe(1);
  }, T);

  it("nobody left: a refusal with the reason, not a throw", async () => {
    const f = fakeGtow();
    f.treeFails.add("primary"); f.treeFails.add("secondary");
    const r = await P.poolLockSeams.solve("k-all-fail", BODY, { preflop: true });
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/custom-trees request failed on secondary: The operation timed out/);
  }, T);
});

describe("a poll that hangs on the owning account", () => {
  it("re-posts the solve on another account and the read goes on there — the old id keeps answering", async () => {
    const f = fakeGtow();
    f.hang.add("primary");
    const made = await P.poolLockSeams.solve("k-hang", BODY, { preflop: true });
    const old = (made as { solId: string }).solId;
    expect(f.ownerOf.get(old)).toBe("primary");
    const t0 = Date.now();
    const n = await P.fetchNode(old, "");
    expect("error" in n).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3_000);            // well inside the 4 s read, not polled to its end
    expect(trees(f)).toEqual(["primary", "secondary"]);     // the same tree, re-posted once
    expect(f.seen.filter((x) => x.kind === "tree")[1]!.body).toEqual(BODY);
    expect(polls(f, "primary")).toBe(1);                    // the one that hung
    expect(polls(f, "secondary")).toBe(1);
    // a later read of the OLD id goes straight to the replacement: no poll of the hung account
    const again = await P.fetchNode(old, "F");
    expect("error" in again).toBe(false);
    expect(polls(f, "primary")).toBe(1);
    expect(polls(f, "secondary")).toBe(2);
    // the old id's memo still hands out the old id (callers never see the move)
    const same = await P.poolLockSeams.solve("k-hang", BODY, { preflop: true });
    expect((same as { solId: string }).solId).toBe(old);
    expect(trees(f).length).toBe(2);
  }, T);

  it("re-posts once however many reads hang on it together", async () => {
    const f = fakeGtow();
    f.hang.add("primary");
    const made = await P.poolLockSeams.solve("k-hang-many", BODY, { preflop: true });
    const old = (made as { solId: string }).solId;
    const reads = await Promise.all(["", "F", "C", "R2.5"].map((ln) => P.fetchNode(old, ln)));
    expect(reads.every((r) => !("error" in r))).toBe(true);
    expect(trees(f)).toEqual(["primary", "secondary"]);
  }, T);

  it("every account hangs: one re-post per account at most, never back to one that hung — the read ends on its own clock", async () => {
    const f = fakeGtow();
    f.hang.add("primary"); f.hang.add("secondary");
    const made = await P.poolLockSeams.solve("k-hang-all", BODY, { preflop: true });
    const t0 = Date.now();
    const n = await P.fetchNode((made as { solId: string }).solId, "");
    expect("error" in n).toBe(true);
    expect((n as { error: string }).error).toMatch(/did not return the node in time/);
    // the 4 s read and slack: the poll wait (POLL_MS 1.2 s) is clipped to the read's clock — it used to run up to 1.2 s past
    expect(Date.now() - t0).toBeLessThan(4_000 + 1_000);
    // primary hung → re-posted on secondary; secondary hung → nobody left this read has not hung on: polled on there. It
    // used to re-post back onto primary, then secondary, … (~15 re-posts in this 4 s read)
    expect(trees(f)).toEqual(["primary", "secondary"]);
    expect(polls(f, "primary")).toBe(1);
  }, T);

  it("with too little of the read left for a cold tree: polls on and ends as before, nothing re-posted", async () => {
    const f = fakeGtow();
    f.hang.add("primary");
    process.env.GTOW_PREFLOP_REPOST_MS = "100000";
    const made = await P.poolLockSeams.solve("k-hang-late", BODY, { preflop: true });
    const n = await P.fetchNode((made as { solId: string }).solId, "");
    expect("error" in n).toBe(true);
    expect((n as { error: string }).error).toMatch(/did not return the node in time/);
    expect(trees(f)).toEqual(["primary"]);
  }, T);

  it("a locked chain is re-posted with its locks, on the replacement parent", async () => {
    const f = fakeGtow();
    f.hang.add("primary");
    const parent = await P.poolLockSeams.solve("k-hang-lock", BODY, { preflop: true });
    const chain = await P.lockedSolution((parent as { solId: string }).solId, BODY, [LOCK]);
    expect("solId" in chain).toBe(true);
    const child = (chain as { solId: string }).solId;
    expect(f.seen.filter((x) => x.kind === "lock").map((x) => x.acct)).toEqual(["primary"]);
    const n = await P.fetchNode(child, "");
    expect("error" in n).toBe(false);
    // the re-post: tree, solution and the lock on the other account, the lock on the NEW parent
    const onSecondary = f.seen.filter((x) => x.acct === "secondary" && x.kind !== "poll").map((x) => x.kind);
    expect(onSecondary).toEqual(["tree", "solution", "lock"]);
    const newParent = f.seen.find((x) => x.kind === "solution" && x.acct === "secondary")!;
    const newLock = f.seen.find((x) => x.kind === "lock" && x.acct === "secondary")!;
    expect(f.ownerOf.get(newLock.body.parent_solution_id)).toBe("secondary");
    expect(newLock.body.last_node_lock).toEqual(LOCK);
    expect(newParent.body.custom_tree_id).toMatch(/^tree-/);
  }, T);
});

describe("three accounts, two of them stuck", () => {
  it("primary and secondary hang, ultra-2 answers: the 2nd re-post goes to ultra-2, never back to primary", async () => {
    routeIds = ["primary", "secondary", "ultra-2"];
    const f = fakeGtow();
    f.hang.add("primary"); f.hang.add("secondary");
    const made = await P.poolLockSeams.solve("k-hang-three", BODY, { preflop: true });
    const old = (made as { solId: string }).solId;
    const t0 = Date.now();
    const n = await P.fetchNode(old, "");
    expect("error" in n).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(trees(f)).toEqual(["primary", "secondary", "ultra-2"]);
    expect(polls(f, "primary")).toBe(1);
    expect(polls(f, "secondary")).toBe(1);
    expect(polls(f, "ultra-2")).toBe(1);
    // a later read of the OLD id goes to the LAST replacement — `moved` followed to its end, not one hop (secondary, hung)
    const again = await P.fetchNode(old, "F");
    expect("error" in again).toBe(false);
    expect(polls(f, "primary")).toBe(1);
    expect(polls(f, "secondary")).toBe(1);
    expect(polls(f, "ultra-2")).toBe(2);
  }, T);

  it("a wall counts as a hang: primary 429s, secondary hangs → ultra-2, not back to primary", async () => {
    // (the fake's routing never blocks a walled account — live, noteFailure does — so this is the read's own list at work)
    routeIds = ["primary", "secondary", "ultra-2"];
    const f = fakeGtow();
    f.walled.add("primary"); f.hang.add("secondary");
    const made = await P.poolLockSeams.solve("k-wall-hang-three", BODY, { preflop: true });
    const n = await P.fetchNode((made as { solId: string }).solId, "");
    expect("error" in n).toBe(false);
    expect(trees(f)).toEqual(["primary", "secondary", "ultra-2"]);
    expect(polls(f, "primary")).toBe(1);
    expect(failures).toEqual([{ id: "primary", status: 429 }]);
  }, T);
});

describe("a re-post onto a slow account", () => {
  it("does not hold the read past its clock: the read ends on time, the re-post lands for the next ask", async () => {
    process.env.GTOW_NODE_TIMEOUT_MS = "1500";
    const f = fakeGtow();
    f.hang.add("primary");
    f.slowTree.set("secondary", 2_500);
    const made = await P.poolLockSeams.solve("k-hang-slow", BODY, { preflop: true });
    const old = (made as { solId: string }).solId;
    const t0 = Date.now();
    const n = await P.fetchNode(old, "");
    expect("error" in n).toBe(true);
    expect((n as { error: string }).error).toMatch(/did not return the node in time/);
    // the 1.5 s read and slack — it used to wait the slow tree POST out (2.5 s here; up to 20 s per POST live)
    expect(Date.now() - t0).toBeLessThan(1_500 + 700);
    // the re-post goes on without the read and lands…
    for (let i = 0; i < 80 && !f.seen.some((x) => x.kind === "solution" && x.acct === "secondary"); i++) await sleep(50);
    await sleep(50);
    expect(trees(f)).toEqual(["primary", "secondary"]);
    // …so the next ask of the old id goes straight to it: no poll of the hung account
    const next = await P.fetchNode(old, "");
    expect("error" in next).toBe(false);
    expect(polls(f, "primary")).toBe(1);
    expect(polls(f, "secondary")).toBe(1);
  }, T);
});

describe("a request wall (429) on the owning account", () => {
  it("with time left: the solve is re-posted elsewhere and the read answers", async () => {
    const f = fakeGtow();
    f.walled.add("primary");
    const made = await P.poolLockSeams.solve("k-wall", BODY, { preflop: true });
    const n = await P.fetchNode((made as { solId: string }).solId, "");
    expect("error" in n).toBe(false);
    expect(trees(f)).toEqual(["primary", "secondary"]);
    expect(failures).toEqual([{ id: "primary", status: 429 }]);
  }, T);

  it("with no time to re-post: the read ends and the tree's memo is forgotten — the next ask posts afresh", async () => {
    const f = fakeGtow();
    f.walled.add("primary");
    process.env.GTOW_PREFLOP_REPOST_MS = "100000";
    const made = await P.poolLockSeams.solve("k-wall-late", BODY, { preflop: true });
    const n = await P.fetchNode((made as { solId: string }).solId, "");
    expect("error" in n).toBe(true);
    expect((n as { error: string }).error).toMatch(/429/);
    expect(trees(f)).toEqual(["primary"]);
    // the walled account is now blocked by routing (the pool's noteFailure); the next ask of the SAME tree posts afresh
    routeIds = ["secondary"];
    const again = await P.poolLockSeams.solve("k-wall-late", BODY, { preflop: true });
    expect((again as { solId: string }).solId).not.toBe((made as { solId: string }).solId);
    expect(trees(f)).toEqual(["primary", "secondary"]);
    const ok = await P.fetchNode((again as { solId: string }).solId, "");
    expect("error" in ok).toBe(false);
  }, T);
});

describe("a node-lock POST that fails", () => {
  it("is sent once more on the same account; failing twice it is a refusal, not a throw", async () => {
    const f = fakeGtow();
    const parent = await P.poolLockSeams.solve("k-lock-retry", BODY, { preflop: true });
    f.lockFails.set("primary", 1);
    const chain = await P.lockedSolution((parent as { solId: string }).solId, BODY, [LOCK]);
    expect("solId" in chain).toBe(true);
    expect(f.seen.filter((x) => x.kind === "lock").map((x) => x.acct)).toEqual(["primary", "primary"]);
    f.lockFails.set("primary", 2);
    const twice = await P.lockedSolution((parent as { solId: string }).solId, BODY, [{ ...LOCK, action_history: ["F"] }]);
    expect("error" in twice).toBe(true);
    expect((twice as { error: string }).error).toMatch(/failed twice on primary/);
  }, T);
});
