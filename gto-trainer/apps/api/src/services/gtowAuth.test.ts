import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * AN AUTH REFUSAL IS NOT A VERDICT ON THE LINE (services/gtowAuth, 2026-10-08). The core stress re-run got
 * `400 {"code": "VALIDATION_ERROR", "detail": "Invalid API Key"}` on spot-solution polls while the Ultra token was being
 * rotated, and the node poll gave the decision up as if GTO Wizard had refused the line. These pin: an auth refusal
 * refreshes the token ONCE and sends the same request again (polls, tree / solution POSTs; postflop and preflop); twice
 * refused = the "GTO Wizard auth failed twice (token rotation)" reason and nothing cached; a real line refusal
 * (NODE_DOES_NOT_EXIST, "Incorrect actions") is the verdict exactly as before, with no refresh.
 *
 * Hermetic: GTO Wizard is a fake fetch that refuses the OLD token on reads (POSTs pass, as they did on 2026-10-08); the
 * session pool is the real one with its CDP sniff stubbed to hand out the NEW token; caches are temp files.
 */
process.env.GTOW_POLL_MS = "20";
process.env.GTOW_FIRST_POLL_MS = "20";
let GtowApi: typeof import("./gtowApi").GtowApi;
let P: typeof import("./gtowAiPreflop");
let C: typeof import("./gtowSolveCache");
let B: typeof import("./gtowAuthBody");
let S: typeof import("./gtowSessions");

const jwt = (tag: string) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, tag })).toString("base64url")}.s`;
const OLD = jwt("old");
const NEW = jwt("new");
const AUTH_BODY = JSON.stringify({ code: "VALIDATION_ERROR", detail: "Invalid API Key", data: { detail: "Invalid API Key" } });
const NODE_DNE = JSON.stringify({ code: "NODE_DOES_NOT_EXIST", detail: "The node in the actions doesn't exists" });
const INCORRECT = JSON.stringify({ code: "VALIDATION_ERROR", detail: "Incorrect actions" });

/** the sniff stub: how many CDP reads, how long each takes, what it brings back */
const sniffer = { n: 0, ms: 0, token: NEW as string | null };
const POOL_STUBS = ["route", "routeIgnoringBlocks", "liveFirst", "sniff"] as const;
const saved: { m: string; own: boolean; fn: unknown }[] = [];
let savedSessions: Map<string, { token: string | null; tokenExpMs: number; sniffFailedMs?: number; enabled: boolean; lastError: string | null }>;
const sessionsOf = () => (S.gtowSessions as unknown as { sessions: Map<string, any> }).sessions;

beforeAll(async () => {
  ({ GtowApi } = await import("./gtowApi"));
  P = await import("./gtowAiPreflop");
  C = await import("./gtowSolveCache");
  B = await import("./gtowAuthBody");
  S = await import("./gtowSessions");
  const s = S.gtowSessions as any;
  for (const m of POOL_STUBS) saved.push({ m, own: Object.prototype.hasOwnProperty.call(s, m), fn: s[m] });
  s.route = (need: { multiway?: boolean; preflop?: boolean } = {}) => (need.multiway || need.preflop ? ["primary"] : ["secondary"]);
  s.routeIgnoringBlocks = s.route;
  s.liveFirst = (ids: string[]) => ids;
  s.sniff = async () => { sniffer.n++; if (sniffer.ms) await Bun.sleep(sniffer.ms); return sniffer.token; };
  savedSessions = new Map([...sessionsOf()].map(([id, x]) => [id, { token: x.token, tokenExpMs: x.tokenExpMs, sniffFailedMs: x.sniffFailedMs, enabled: x.cfg.enabled, lastError: x.lastError }]));
});
afterAll(() => {
  const s = S.gtowSessions as any;
  for (const { m, own, fn } of saved) { if (own) s[m] = fn; else delete s[m]; }
  for (const [id, v] of savedSessions) {
    const x = sessionsOf().get(id);
    if (!x) continue;
    Object.assign(x, { token: v.token, tokenExpMs: v.tokenExpMs, sniffFailedMs: v.sniffFailedMs, lastError: v.lastError });
    x.cfg.enabled = v.enabled;
  }
  P.setPreflopSolveCache(null);
  P.resetAiPreflopMemory();
});

/** every account holds the OLD token, live for an hour */
beforeEach(() => {
  sniffer.n = 0; sniffer.ms = 0; sniffer.token = NEW;
  delete process.env.GTOW_AUTH_REFRESH_MS;
  for (const id of ["primary", "secondary"]) {
    const x = sessionsOf().get(id);
    if (!x) throw new Error(`no ${id} session under test`);
    x.cfg.enabled = true;
    Object.assign(x, { token: OLD, tokenExpMs: Date.now() + 3_600_000, sniffFailedMs: 0, lastAttemptMs: 0, blockedUntilMs: 0, blockedKind: null });
  }
});

const realFetch = globalThis.fetch;
const realLog = console.log;
const dirs: string[] = [];
const caches: { close(): void; flush(): void }[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  P.setPreflopSolveCache(null);
  P.resetAiPreflopMemory();
  for (const c of caches.splice(0)) c.close();
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* WAL handle settling */ }
});
const tempCache = () => {
  const d = mkdtempSync(join(tmpdir(), "gtow-auth-")); dirs.push(d);
  const c = new C.GtowSolveCache({ path: join(d, "gtow-cache.sqlite"), flushMs: 1 });
  caches.push(c);
  return c;
};
/** console.log captured: the [gtow-auth] lines */
const captureLog = (): string[] => {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return lines;
};

type Seen = { kind: "tree" | "solution" | "poll"; token: string; node: string };
/**
 * A fake GTO Wizard. Reads with a refused token answer the auth 400; `refuse` lists the refused tokens (default: OLD
 * only — NEW passes). POSTs pass with any token unless `refusePosts`. `lines` answers a read by its node: an object = a
 * node, a [status, body] = that reply; anything else 204.
 */
function fakeGtow(opts: { lines: Record<string, object | [number, string]>; refuse?: string[]; refusePosts?: boolean; preflop?: boolean }): Seen[] {
  const seen: Seen[] = [];
  const refuse = new Set(opts.refuse ?? [OLD]);
  let seq = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(String(input));
    const token = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
    const kind: Seen["kind"] = u.pathname.endsWith("/custom-trees/") ? "tree" : u.pathname.endsWith("/custom-solutions/") ? "solution" : "poll";
    const node = opts.preflop ? u.searchParams.get("preflop_actions") ?? ""
      : u.searchParams.get("river_actions") || u.searchParams.get("turn_actions") || u.searchParams.get("flop_actions") || "";
    seen.push({ kind, token, node });
    if (kind !== "poll") {
      if (opts.refusePosts && refuse.has(token)) return new Response(AUTH_BODY, { status: 400 });
      return Response.json({ id: `${kind}-${++seq}` }, { status: 201 });
    }
    if (refuse.has(token)) return new Response(AUTH_BODY, { status: 400 });
    const v = opts.lines[node];
    if (v === undefined) return new Response(null, { status: 204 });
    if (Array.isArray(v)) return new Response(v[1], { status: v[0] });
    return Response.json(v);
  }) as typeof fetch;
  return seen;
}

const postNode = { action_solutions: [{ action: { code: "X" }, strategy: [1] }] };
/** a GtowApi holding solve `solId` (owned by `owner`, created long ago), its replies stored under a tree in `cache` */
function apiWith(solId: string, owner: string, cache = tempCache()) {
  const api = new GtowApi(cache as any);
  (api as any).solOwner.set(solId, owner);
  (api as any).solCreatedAt.set(solId, Date.now() - 10_000);
  const key = `tree-of-${solId}`;
  (cache as any).noteTree(key, "post", JSON.stringify({ tree: { players: [1, 2] }, solution: { actions: "", board: "Td6h7s" } }));
  (api as any).noteSolKey(solId, key);
  return { api, cache, key };
}

describe("which replies are auth refusals (services/gtowAuthBody)", () => {
  it("GTO Wizard's own 'Invalid API Key' 400, a 401, a 403 that names the token — and none of the line's refusals", () => {
    expect(B.isAuthFailure(400, AUTH_BODY)).toBe(true);
    expect(B.isAuthFailure(401, "")).toBe(true);
    expect(B.isAuthFailure(403, '{"detail": "Authentication credentials were not provided."}')).toBe(true);
    expect(B.isAuthFailure(400, NODE_DNE)).toBe(false);
    expect(B.isAuthFailure(400, INCORRECT)).toBe(false);
    expect(B.isAuthFailure(422, '{"code": "VALIDATION_ERROR", "detail": "Engine validation failed"}')).toBe(false);
    expect(B.isAuthFailure(422, '{"code": "VALIDATION_ERROR", "detail": "Preflop: Only effective stacks up to 250bb are supported"}')).toBe(false);
    expect(B.isAuthFailure(403, '{"code": "PREFLOP_MULTIWAY_NOT_ALLOWED", "detail": "Not allowed"}')).toBe(false);
    expect(B.isAuthFailure(429, '{"detail": "Request limit exceeded"}')).toBe(false);
    expect(B.refusalDetail(AUTH_BODY)).toBe("Invalid API Key");
  });
  it("the pool reads a 403 'Invalid API Key' as auth, not as a ~24 h quota wall; the plan refusal stays a plan refusal", () => {
    expect(S.classifyFailure(403, AUTH_BODY)).toBe("auth");
    expect(S.classifyFailure(400, AUTH_BODY)).toBe("auth");
    expect(S.classifyFailure(400, NODE_DNE)).toBeNull();
    expect(S.classifyFailure(403, '{"code": "PREFLOP_MULTIWAY_NOT_ALLOWED", "detail": "Not allowed"}')).toBe("plan");
  });
  it("the solve cache never keeps an auth body as the line's refusal, and an old one reads as a miss", () => {
    const c = tempCache();
    c.noteTree("k", "post", "{}");
    c.putNode("k", "a", -400, AUTH_BODY);           // VALIDATION_ERROR matches DETERMINISTIC_REFUSAL — refused all the same
    c.putNode("k", "b", -400, NODE_DNE);
    c.putNode("k", "c", -400, INCORRECT);
    c.flush();
    expect(c.getNode("k", "a", false)).toBeNull();
    expect(c.getNode("k", "b", false)?.status).toBe(-400);
    expect(c.getNode("k", "c", false)?.status).toBe(-400);
    // a row written before the guard (an older process): served as a miss, so the caller asks GTO Wizard again
    const db = new Database((c as any).path);
    db.query("INSERT INTO gtow_cache_nodes (key, addr, status, bytes, created_ms, last_hit_ms, hits, reply) VALUES (?,?,?,?,?,?,0,?)")
      .run("k", "old", -400, AUTH_BODY.length, Date.now(), Date.now(), Bun.gzipSync(Buffer.from(AUTH_BODY)));
    db.close();
    expect(c.getNode("k", "old", false)).toBeNull();
    expect(C.isLineVerdict(-400, AUTH_BODY)).toBe(false);
    expect(C.isLineVerdict(-400, NODE_DNE)).toBe(true);
  });
});

describe("postflop node poll (gtowApi)", () => {
  it("an auth 400: ONE token refresh, the same poll again, the node served — and nothing refused is stored", async () => {
    const seen = fakeGtow({ lines: { "": postNode, X: postNode } });
    const log = captureLog();
    const { api, cache, key } = apiWith("sol-auth-1", "secondary");
    const r = await api.customNode("sol-auth-1", { flopActions: "", board: "Td6h7s" }, 4_000);
    expect(r.ok).toBe(true);
    expect(sniffer.n).toBe(1);
    expect(seen.filter((x) => x.kind === "poll").map((x) => x.token === NEW ? "new" : "old")).toEqual(["old", "new"]);
    expect(log.some((l) => l.startsWith("[gtow-auth] secondary poll 400 \"Invalid API Key\"") && l.includes("recovered"))).toBe(true);
    // the next read of the same solve goes out with the new token at once — no second refresh
    const r2 = await api.customNode("sol-auth-1", { flopActions: "X", board: "Td6h7s" }, 4_000);
    expect(r2.ok).toBe(true);
    expect(sniffer.n).toBe(1);
    (cache as any).flush();
    expect((cache as any).getNode(key, C.nodeAddr({ flop: "", board: "Td6h7s" }), false)?.status).toBe(C.NODE_OK);
  });

  it("refused again with the refreshed token: no answer, the auth reason, status 401 — never stored as the line's refusal", async () => {
    const seen = fakeGtow({ lines: { "": postNode }, refuse: [OLD, NEW] });
    const log = captureLog();
    const { api, cache } = apiWith("sol-auth-2", "secondary");
    const r = await api.customNode("sol-auth-2", { flopActions: "", board: "Td6h7s" }, 4_000);
    expect(r.ok).toBe(false);
    const f = r as { status: number; error: string };
    expect(f.status).toBe(401);
    expect(f.error).toContain("GTO Wizard auth failed twice (token rotation)");
    expect(f.error).toContain("Invalid API Key");
    expect(f.error).not.toContain("VALIDATION_ERROR");          // downstream that word means "GTO Wizard refused the tree"
    expect(sniffer.n).toBe(1);
    expect(seen.filter((x) => x.kind === "poll").length).toBe(2);   // the poll and its one retry — then it stops
    expect(log.some((l) => l.includes("auth failed twice"))).toBe(true);
    (cache as any).flush();
    const db = new Database((cache as any).path, { readonly: true });
    expect((db.query("SELECT COUNT(*) n FROM gtow_cache_nodes").get() as { n: number }).n).toBe(0);
    db.close();
    // the account keeps its routing (no minute-long auth block); the refused token is dropped
    const x = sessionsOf().get("secondary");
    expect(x.blockedKind).toBeNull();
    expect(x.token).toBeNull();
  });

  it("a real line refusal is the verdict as before: returned at once as the 400, no token refresh", async () => {
    fakeGtow({ lines: { "": postNode, "X-X": [400, NODE_DNE], "B5": [400, INCORRECT] }, refuse: [] });
    const { api } = apiWith("sol-auth-3", "secondary");
    expect((await api.customNode("sol-auth-3", { flopActions: "", board: "Td6h7s" }, 4_000)).ok).toBe(true);
    const a = await api.customNode("sol-auth-3", { flopActions: "X-X", board: "Td6h7s" }, 4_000) as { ok: false; status: number; error: string };
    expect(a.status).toBe(400);
    expect(a.error).toContain("NODE_DOES_NOT_EXIST");
    const b = await api.customNode("sol-auth-3", { flopActions: "B5", board: "Td6h7s" }, 4_000) as { ok: false; status: number; error: string };
    expect(b.status).toBe(400);
    expect(b.error).toContain("Incorrect actions");
    expect(sniffer.n).toBe(0);
  });

  it("five reads refused at once share ONE token read (the sniff is joined, not repeated)", async () => {
    const lines = { "": postNode, X: postNode, B2: postNode, "X-B2": postNode, "B2-C": postNode };
    fakeGtow({ lines });
    const { api } = apiWith("sol-auth-4", "secondary");
    expect((await api.customNode("sol-auth-4", { flopActions: "", board: "Td6h7s" }, 4_000)).ok).toBe(true);
    sniffer.n = 0;
    sessionsOf().get("secondary").token = OLD;                 // the token rotates again under a ready solve
    sniffer.ms = 50;
    const res = await Promise.all(["X", "B2", "X-B2", "B2-C"].map((a) => api.customNode("sol-auth-4", { flopActions: a, board: "Td6h7s" }, 4_000)));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(sniffer.n).toBe(1);
  });

  it("the refresh is held to the read's clock: none in time = no retry, and the reason says so", async () => {
    fakeGtow({ lines: { "": postNode } });
    sniffer.ms = 1_500;
    const { api } = apiWith("sol-auth-5", "secondary");
    const t0 = Date.now();
    const r = await api.customNode("sol-auth-5", { flopActions: "", board: "Td6h7s" }, 1_600) as { ok: false; status: number; error: string };
    expect(Date.now() - t0).toBeLessThan(1_400);                // 1.6 s less the retry's second: ~0.6 s of refresh
    expect(r.status).toBe(401);
    expect(r.error).toContain("GTO Wizard auth failed (token rotation)");
    expect(r.error).toContain("did not finish within");
    await Bun.sleep(1_600);                                    // the background read lands (the keeper's token)
  });

  it("a refresh slower than 2 s is named in the reason", async () => {
    fakeGtow({ lines: { "": postNode }, refuse: [OLD, NEW] });
    sniffer.ms = 2_200;
    const { api } = apiWith("sol-auth-6", "secondary");
    const r = await api.customNode("sol-auth-6", { flopActions: "", board: "Td6h7s" }, 6_000) as { ok: false; error: string };
    expect(r.error).toContain("auth failed twice");
    expect(r.error).toMatch(/the token refresh took 2\.\d s/);
  });

  it("a tree POST refused for auth is sent again, the SAME body, once — then the solution with the new token", async () => {
    const seen = fakeGtow({ lines: {}, refusePosts: true });
    const api = new GtowApi(tempCache() as any);
    const body = { tree: "body" };
    const made = await (api as any).postCustomSolution(body, { actions: "", board: "Td6h7s" }, {});
    expect(made.ok).toBe(true);
    expect(seen.map((x) => `${x.kind}:${x.token === NEW ? "new" : "old"}`)).toEqual(["tree:old", "tree:new", "solution:new"]);
    expect(sniffer.n).toBe(1);
  });
});

// ── preflop (gtowAiPreflop) ───────────────────────────────────────────────────────────────────────────────────────
const arr = (x: number) => new Array(1326).fill(x);
const pnode = (actor: string, acts: [string, string, number][]) => ({
  game: { players: [{ position: actor, is_hero: true }] },
  action_solutions: acts.map(([code, type, f]) => ({ action: { code, type, betsize: code.startsWith("R") ? code.slice(1) : "" }, strategy: arr(f), total_frequency: f })),
});
const PRE: Record<string, object | [number, string]> = {
  "": pnode("BTN", [["F", "FOLD", 0.5], ["R2.5", "RAISE", 0.5]]),
  "R2.5": pnode("SB", [["F", "FOLD", 0.9], ["C", "CALL", 0.1]]),
  "R2.5-F": pnode("BB", [["F", "FOLD", 0.4], ["C", "CALL", 0.6]]),
  "R2.5-C": pnode("BB", [["F", "FOLD", 0.3], ["C", "CALL", 0.7]]),
  "R2.5-R9": [400, INCORRECT],
};
/** Three-handed: the BTN opens 2.5, the SB folds, hero (BB) to act. */
const hand = (id: string): ParsedHand => ({
  handId: 1, clientHandId: id, bbCents: 200, heroSeatId: 6, heroCards: ["Kh", "Qd"], board: [], street: "preflop",
  actions: [
    { seatId: 1, hero: false, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 6, hero: true, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 5, hero: false, type: "raise", amount: 2.5, street: "preflop" },
    { seatId: 1, hero: false, type: "fold", street: "preflop" },
  ],
  liveSeats: [1, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "SB", 5: "BTN", 6: "BB" }, stacks: { 1: 100, 5: 100, 6: 100 },
  currentNode: { street: "preflop", toActSeatId: 6, toActIsHero: true, pot: 4, toCall: 1.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand);

describe("AI preflop (gtowAiPreflop)", () => {
  it("an auth 400 on the node read: one refresh, the same read again, the answer served", async () => {
    const seen = fakeGtow({ lines: PRE, preflop: true });
    P.setPreflopSolveCache(tempCache() as any);
    const out = await P.solvePreflopGtowAi(hand("gtow-auth-pre-1"), null, "test");
    if (!out.ok) throw new Error(out.reason);
    expect(sniffer.n).toBe(1);
    expect(seen.some((x) => x.kind === "poll" && x.token === NEW)).toBe(true);
  });

  it("refused twice: no answer with the auth reason (not a tree refusal), and nothing stored as the line's refusal", async () => {
    fakeGtow({ lines: PRE, preflop: true, refuse: [OLD, NEW] });
    const cache = tempCache();
    P.setPreflopSolveCache(cache as any);
    const out = await P.solvePreflopGtowAi(hand("gtow-auth-pre-2"), null, "test");
    expect(out.ok).toBe(false);
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain("GTO Wizard auth failed twice (token rotation)");
    expect(reason).not.toContain("refused the tree");
    expect(reason).not.toContain("not a legal betting sequence");
    await Bun.sleep(50);
    cache.flush();
    const db = new Database((cache as any).path, { readonly: true });
    const refusals = (db.query("SELECT COUNT(*) n FROM gtow_cache_nodes WHERE status < 0 AND status != -204").get() as { n: number }).n;
    db.close();
    expect(refusals).toBe(0);
  });

  it("a real refusal of the line ('Incorrect actions') is cached as before, with no refresh", async () => {
    fakeGtow({ lines: PRE, preflop: true, refuse: [] });
    const cache = tempCache();
    P.setPreflopSolveCache(cache as any);
    // the tree solved and one node read, through the reader every walk uses (fetchNode)
    const r = await P.debugPreflopNode(hand("gtow-auth-pre-3"), null, "R2.5-R9");
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("Incorrect actions");
    expect(sniffer.n).toBe(0);
    await Bun.sleep(20);
    cache.flush();
    const db = new Database((cache as any).path, { readonly: true });
    const rows = db.query("SELECT status FROM gtow_cache_nodes WHERE status = -400").all();
    db.close();
    expect(rows.length).toBe(1);
  });
});
