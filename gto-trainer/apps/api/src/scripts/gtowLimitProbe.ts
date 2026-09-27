/**
 * GTO WIZARD LIMIT PROBE (2026-09-26, Brady: "stress test the limits" — staggered, 1 request/s, both accounts).
 *
 *   bun src/scripts/gtowLimitProbe.ts            start, or resume from the state file
 *   bun src/scripts/gtowLimitProbe.ts --status   print the state and exit (spends nothing)
 *
 * WHY. The 429 says `request_limit 1275 / 86400 s`, yet the Ultra account once sent 6,149 requests in 24 h with no
 * wall, and a wall cleared after 5 minutes. GTO Wizard's web app labels this 429 "security protection" — a throttle,
 * not the plan's daily spot limit. This measures it, per account:
 *   1. how many requests at a steady 1/s until the first 429          (CLIMB: node reads of one solve)
 *   2. what the wall looks like — full body + headers (Retry-After?), and whether 200s still slip through (INSIDE)
 *   3. when it lifts: minutes / 24 h rolling / 00:00 UTC                (WAIT: one probe per 10 min)
 *   4. per ACCOUNT or per IP: when the first account walls, the other (fresh) account is probed at once (CROSS-CHECK)
 *   5. after the reset, a second climb made of NEW SOLVES instead of node reads (CLIMB2) — do solves count differently?
 * STAGGERED: the Elite account (secondary) climbs first; the Ultra (primary) climbs only after the cross-check.
 *
 * Every request goes through gtowRequests.fetch (origin `gtowLimitProbe`), so the ledger keeps each one with its
 * target and limit headers, and every 429 whole in gtow_responses; `bun src/scripts/gtowQuotaReport.ts` reads it.
 * Human log: data/jobs/gtow_limit_probe.log · state: data/jobs/gtow_limit_probe.state.json (resumable).
 *
 * STOPS: an account stops on a 403 that is not a limit answer, on sign-out that outlasts 12 h, or on its per-climb cap
 * (10,000 requests / 1,500 solves — reaching the cap IS the answer: no wall at this pace). EVERYTHING stops on a reply
 * that mentions a suspension or ban.
 *
 * Test hooks (the fake-server test sets these): GTOW_PROBE_BASE (API base), GTOW_PROBE_TOKEN (skip the CDP sniff),
 * GTOW_PROBE_SCALE (multiplies every wait), GTOW_PROBE_DIR (state + log directory).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gtowRequests, type GtowRequestKind } from "../services/gtowRequestLog";
import { gtowSessions, type GtowSessionId } from "../services/gtowSessions";

const API_BASE = process.env.GTOW_PROBE_BASE ?? "https://api.gtowizard.com";
const SCALE = Number(process.env.GTOW_PROBE_SCALE ?? 1);
const DIR = process.env.GTOW_PROBE_DIR ?? join(import.meta.dir, "..", "..", "data", "jobs");
const STATE = join(DIR, "gtow_limit_probe.state.json");
const LOG = join(DIR, "gtow_limit_probe.log");

const CLIMB_GAP = 1_000;                 // Brady: 1 request per second
const INSIDE_GAP = 10_000;
const INSIDE_FOR = 10 * 60_000;
const WAIT_GAP = 10 * 60_000;
const WAIT_MIN = 2 * 60_000;
const CONFIRM = 5;                       // cleared = this many OK in a row
const CONFIRM_GAP = 2_000;
const CLIMB_CAP = 10_000;
const SOLVE_CAP = 1_500;
const AUTH_GIVE_UP = 12 * 3_600_000;   // 2 h at first; overnight the idle clients stop minting tokens for hours (2026-09-27 04:27 local) and a stop would miss the 00:00 UTC reset
const NODE_TARGET = 20;
const MAX_IN_FLIGHT = 5;
const REFILL_CAP = 5_000;
const HOUR = 3_600_000;
const ALARM = /suspend|banned|\bban\b|disabled|locked|fraud|abuse|terminated|violation/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms * SCALE)));
/** 1 request per second means START to start: a request takes ~1 s itself, so a flat 1 s pause after it halved the rate */
const paceFrom = (t0: number) => sleep(CLIMB_GAP - (Date.now() - t0) / SCALE);
const iso = (t = Date.now()) => new Date(t).toISOString().replace("T", " ").slice(0, 19) + "Z";

type Phase = "setup" | "climb" | "inside" | "wait" | "drain" | "refill" | "waitR" | "climb2" | "inside2" | "wait2" | "done" | "stopped";
type ClimbBox = { start: number | null; sent: number; ok: number; wall: Wall | null; capped: boolean };
type WaitBox = { start: number | null; probes: number; lastProbe: number | null; clearedAt: number | null; lastStatus: number | null };
interface Wall { at: number; sentInClimb: number; solvesInClimb?: number; kind: string; body: string; retryAfter: string | null; headers: Record<string, string> }
interface Acct {
  id: GtowSessionId;
  label: string;
  phase: Phase;
  solId: string | null;
  nodes: string[];
  climb: { start: number | null; sent: number; ok: number; wall: Wall | null; capped: boolean };
  inside: { start: number | null; ok: number; x429: number; other: number };
  wait: { start: number | null; probes: number; lastProbe: number | null; clearedAt: number | null; lastStatus: number | null };
  climb2: { start: number | null; sent: number; solves: number; wall: Wall | null; capped: boolean };
  inside2: { start: number | null; ok: number; x429: number; other: number };
  wait2: { start: number | null; probes: number; lastProbe: number | null; clearedAt: number | null; lastStatus: number | null };
  /** DRAIN (added 2026-09-26 after the first wall showed a 2250 / HOUR limit): one probe per 2 min from the lift until
   *  the hour after the wall has passed — how the window reopens. REFILL: then node reads at 1/s again on the emptied
   *  window — ~2250 = a pure rolling hour; fewer = a daily (or other) budget is also being spent. */
  drain?: { start: number | null; samples: { t: number; st: number; ra: string | null }[] };
  refill?: ClimbBox;
  waitR?: WaitBox;
  crossCheck: { at: number; statuses: number[]; verdict: string } | null;
  stopReason: string | null;
  lastRequestAt: number | null;
}
interface State { startedAt: number; updatedAt: number; pid: number; alarm: string | null; accts: Record<GtowSessionId, Acct> }

const fresh = (id: GtowSessionId, label: string): Acct => ({
  id, label, phase: "setup", solId: null, nodes: [],
  climb: { start: null, sent: 0, ok: 0, wall: null, capped: false },
  inside: { start: null, ok: 0, x429: 0, other: 0 },
  wait: { start: null, probes: 0, lastProbe: null, clearedAt: null, lastStatus: null },
  climb2: { start: null, sent: 0, solves: 0, wall: null, capped: false },
  inside2: { start: null, ok: 0, x429: 0, other: 0 },
  wait2: { start: null, probes: 0, lastProbe: null, clearedAt: null, lastStatus: null },
  crossCheck: null, stopReason: null, lastRequestAt: null,
});

mkdirSync(DIR, { recursive: true });
const load = (): State | null => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return null; } };

if (process.argv.includes("--status")) {
  console.log(existsSync(STATE) ? readFileSync(STATE, "utf8") : "no state file — the probe has not started");
  process.exit(0);
}

const state: State = load() ?? {
  startedAt: Date.now(), updatedAt: Date.now(), pid: process.pid, alarm: null,
  accts: { secondary: fresh("secondary", "Elite"), primary: fresh("primary", "Ultra") },
};
state.pid = process.pid;
// a state file from before DRAIN / REFILL existed
for (const a of Object.values(state.accts)) {
  a.drain ??= { start: null, samples: [] };
  a.refill ??= { start: null, sent: 0, ok: 0, wall: null, capped: false };
  a.waitR ??= { start: null, probes: 0, lastProbe: null, clearedAt: null, lastStatus: null };
}
const save = () => {
  state.updatedAt = Date.now();
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, STATE);
};
const log = (a: Acct | null, msg: string) => {
  const line = `${iso()} ${a ? `[${a.label}/${a.id}] ` : ""}${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch { /* the state file is the record */ }
};

// ---------------------------------------------------------------- requests

async function token(a: Acct, force = false): Promise<string | null> {
  if (process.env.GTOW_PROBE_TOKEN) return `${process.env.GTOW_PROBE_TOKEN}-${a.id}`;
  try { return await gtowSessions.tokenFor(a.id, force); } catch { return null; }
}

interface Reply { status: number; body: string; json: any; headers: Record<string, string> }

/** One request with a live token; waits out sign-outs (up to AUTH_GIVE_UP), refreshes once on a 401. */
async function send(a: Acct, kind: GtowRequestKind, path: string, init: { method?: string; body?: unknown } = {}): Promise<Reply | null> {
  const t0 = Date.now();
  let refreshed = false;
  for (;;) {
    if (state.alarm || a.phase === "stopped") return null;
    const tok = await token(a, refreshed);
    if (!tok) {
      if (Date.now() - t0 > AUTH_GIVE_UP) { stop(a, "no token for 12 h — the client is signed out or down"); return null; }
      log(a, "no token (client signed out or restarting) — retrying in 60 s");
      await sleep(60_000);
      continue;
    }
    let r: Response;
    try {
      r = await gtowRequests.fetch(a.id, kind, `${API_BASE}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${tok}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      a.lastRequestAt = Date.now();
      return { status: 0, body: String(e instanceof Error ? e.message : e), json: null, headers: {} };
    }
    a.lastRequestAt = Date.now();
    const body = await r.text().catch(() => "");
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    if (r.status === 401 && !refreshed) { refreshed = true; continue; }
    if (r.status === 401) {
      if (Date.now() - t0 > AUTH_GIVE_UP) { stop(a, "401 for 2 h"); return null; }
      log(a, "401 after a token refresh — retrying in 60 s");
      await sleep(60_000);
      refreshed = false;
      continue;
    }
    // only an ERROR reply is read for ban wording — a solved node is a large JSON that can contain any word
    // (the 2026-09-26 11:08 run tripped on a 200 root node)
    if ((r.status < 200 || r.status >= 300) && ALARM.test(body)) {
      state.alarm = `${a.label} ${r.status}: ${body.slice(0, 400)}`;
      log(a, `ALARM — the reply mentions a suspension/ban; stopping EVERYTHING: ${body.slice(0, 400)}`);
      save();
      return null;
    }
    let json: any = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* not JSON */ }
    return { status: r.status, body, json, headers };
  }
}

const isWall = (r: Reply) => r.status === 429 || (r.status === 403 && /limit|exceed|quota/i.test(r.body));
const isRefusal = (r: Reply) => r.status === 403 && !isWall(r);

function stop(a: Acct, why: string) {
  a.phase = "stopped";
  a.stopReason = why;
  log(a, `STOPPED: ${why}`);
  save();
}

const nodePath = (solId: string, line: string) => `/v4/solutions/spot-solution/?${new URLSearchParams({
  custom_solution_id: solId, preflop_actions: line, flop_actions: "", turn_actions: "", river_actions: "", board: "" })}`;

/** Heads-up 100bb Ignition-shaped preflop tree — the live code's body (gtowAiPreflop.treeBody) with its full HU menu.
 *  `stack` varies per solve in CLIMB2 so no two trees are identical. */
function huTree(stack = 100) {
  const sizes = (position: string) => ({ position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true,
    allow_3betplus_cold_calls: true, bet_sizes: ["2x", "2.2x", "2.5x", "3x", "3.5x"], raise_sizes: ["3.2x", "3.8x", "4.5x"],
    second_raise_sizes: ["2.2x", "2.6x"], third_plus_raise_sizes: ["2.2x"] });
  return {
    starting_street: "PREFLOP", pot: 0, ante: null, ante_distribution_method: "PER_PLAYER", max_allowed_limps: null,
    bet_sizes: { allin_threshold: 60, allin_if_less_than: 500, merge_sizes_threshold: 10, max_num_raises: 5,
      street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: ["SB", "BB"].map(sizes) }] },
    players: ["SB", "BB"].map((p) => ({ position: p, display_position: p, blind: p === "SB" ? 0.5 : 1, range: null, stack,
      tournament_instant_bounty: null, tournament_total_bounty: null })),
    tree_operations: [], resolving_policy: null,
    rake: { pct_of_pot: 5, cap_in_chips: 0.5, preflop_rake_type: "no_flop_no_drop" },
    tournament_data: null,
  };
}

/** tree + solution; returns the solution id, or the Reply that refused it */
async function createSolve(a: Acct, stack: number): Promise<{ solId: string } | { refused: Reply } | null> {
  const tr = await send(a, "tree", "/v4/custom-solutions/custom-trees/", { method: "POST", body: huTree(stack) });
  if (!tr) return null;
  if (tr.status < 200 || tr.status >= 300 || !tr.json?.id) return { refused: tr };
  const so = await send(a, "solution", "/v4/custom-solutions/", { method: "POST", body: { custom_tree_id: tr.json.id, actions: "", board: "" } });
  if (!so) return null;
  if (so.status < 200 || so.status >= 300 || !so.json?.id) return { refused: so };
  return { solId: String(so.json.id) };
}

/** poll one node until solved (1 request / s); null = gave up */
async function readyNode(a: Acct, solId: string, line: string, onReply?: (r: Reply) => boolean): Promise<Reply | null> {
  for (let i = 0; i < 60; i++) {
    const r = await send(a, "poll", nodePath(solId, line));
    if (!r) return null;
    if (onReply && onReply(r)) return r;          // the caller took it (a wall)
    if (r.status === 200 && r.json && typeof r.json === "object") return r;
    if (isWall(r) || isRefusal(r) || r.status === 400 || r.status === 422) return r;
    await sleep(CLIMB_GAP);
  }
  return null;
}

const wallOf = (r: Reply, sent: number, kind: string, solves?: number): Wall => ({
  at: Date.now(), sentInClimb: sent, ...(solves != null ? { solvesInClimb: solves } : {}), kind,
  body: r.body.slice(0, 4000), retryAfter: r.headers["retry-after"] ?? null, headers: r.headers,
});

// ---------------------------------------------------------------- phases

async function setup(a: Acct): Promise<void> {
  if (a.solId && a.nodes.length) { a.phase = "climb"; return; }
  log(a, "setup: creating one heads-up 100bb preflop solve");
  const s = await createSolve(a, 100);
  if (!s) return;
  if ("refused" in s) {
    if (isWall(s.refused)) { a.solId = null; a.phase = "climb"; log(a, `setup refused by a wall (${s.refused.status}) — the climb will read it`); return; }
    stop(a, `setup refused ${s.refused.status}: ${s.refused.body.slice(0, 300)}`);
    return;
  }
  a.solId = s.solId;
  // walk the tree breadth-first for NODE_TARGET decision nodes, so the climb rotates reads (no single cached node)
  const queue = [""];
  const seen = new Set<string>();
  while (queue.length && a.nodes.length < NODE_TARGET) {
    const line = queue.shift()!;
    if (seen.has(line)) continue;
    seen.add(line);
    const r = await readyNode(a, a.solId, line);
    if (!r || r.status !== 200) { if (r && isWall(r)) break; continue; }
    const sols: any[] = r.json?.action_solutions ?? [];
    if (!sols.length) continue;                    // terminal
    a.nodes.push(line);
    for (const s2 of sols) {
      const code = String(s2?.action?.code ?? "");
      // a line that ends the hand or goes to the flop has no preflop node: GTO Wizard answers it 204 forever
      // (the 2026-09-26 11:09 run spent 60 polls on each of C-X, R2-C, R2.5-C before this check)
      if (s2?.action?.is_hand_end || s2?.action?.next_street) continue;
      if (code && code !== "F") queue.push(line ? `${line}-${code}` : code);
    }
    await sleep(CLIMB_GAP);
  }
  if (!a.nodes.length) a.nodes = [""];
  log(a, `setup done: solution ${a.solId}, ${a.nodes.length} decision nodes to rotate (${a.nodes.slice(0, 6).map((n) => n || "root").join(", ")}${a.nodes.length > 6 ? ", …" : ""})`);
  a.phase = "climb";
  save();
}

/** CLIMB / REFILL: node reads at 1/s until a wall (or the cap). */
async function climb(a: Acct, which: "climb" | "refill" = "climb"): Promise<void> {
  const box = which === "climb" ? a.climb : a.refill!;
  const cap = which === "climb" ? CLIMB_CAP : REFILL_CAP;
  box.start ??= Date.now();
  log(a, `${which === "climb" ? "climb" : "REFILL climb (the hour after the wall has passed)"}: node reads at 1/s from request ${box.sent + 1} (cap ${cap})`);
  // written from the overlapping requests' callbacks
  const got: { inFlight: number; gone: boolean; walled: { r: Reply; seq: number } | null; refused: Reply | null } =
    { inFlight: 0, gone: false, walled: null, refused: null };
  while (a.phase === which && !state.alarm && !got.walled && !got.refused && !got.gone) {
    if (box.sent >= cap) {
      box.capped = true;
      log(a, `${which} reached the ${cap}-request cap with NO wall — at 1/s node reads are not limited within this span`);
      a.phase = "climb2"; save(); return;
    }
    if (!a.solId) {                                // setup itself was walled: probe with a fresh solve attempt
      const s = await createSolve(a, 100);
      if (!s) return;
      if ("refused" in s) { box.sent++; if (isWall(s.refused)) { await hitWall(a, s.refused, which); return; } stop(a, `refused ${s.refused.status}`); return; }
      a.solId = s.solId; a.nodes = [""];
      continue;
    }
    // A FIXED 1-SECOND CLOCK, not request-then-pause: a node reply is large and takes ~2.5 s to arrive, so one at a
    // time ran at 0.38/s. Up to MAX_IN_FLIGHT requests overlap; a request's number is its place in send order.
    const t0 = Date.now();
    if (got.inFlight >= MAX_IN_FLIGHT) { await sleep(100); continue; }
    const seq = ++box.sent;
    const line = a.nodes[(seq - 1) % a.nodes.length];
    got.inFlight++;
    send(a, "poll", nodePath(a.solId, line)).then((r) => {
      if (!r) { got.gone = true; return; }
      if (isWall(r)) { if (!got.walled || seq < got.walled.seq) got.walled = { r, seq }; }
      else if (isRefusal(r)) got.refused = r;
      else if (r.status >= 200 && r.status < 300) box.ok++;
    }).catch(() => { /* a thrown fetch is logged by the ledger as status 0 */ }).finally(() => { got.inFlight--; });
    if (seq % 25 === 0) save();
    if (seq % 300 === 0) log(a, `${which}: ${seq} sent, ${box.ok} ok`);
    await paceFrom(t0);
  }
  while (got.inFlight > 0) await sleep(100);        // let the overlapping requests land before judging
  if (got.walled) { box.sent = got.walled.seq; await hitWall(a, got.walled.r, which); return; }
  if (got.refused) { stop(a, `403 during the ${which}: ${got.refused.body.slice(0, 300)}`); return; }
}

async function hitWall(a: Acct, r: Reply, which: "climb" | "refill" | "climb2"): Promise<void> {
  if (which === "climb") {
    a.climb.wall = wallOf(r, a.climb.sent, "node read");
    log(a, `WALL after ${a.climb.sent} requests in the climb (${Math.round((Date.now() - (a.climb.start ?? Date.now())) / 60_000)} min): ${r.status} ${r.body.slice(0, 500)} | Retry-After ${a.climb.wall.retryAfter ?? "none"}`);
    a.phase = "inside";
  } else if (which === "refill") {
    const box = a.refill!;
    box.wall = wallOf(r, box.sent, "node read (refill)");
    const verdict = box.sent >= 2000 ? "the FULL hourly allowance came back — a pure rolling hour"
      : `only ${box.sent} of ~2250 — something besides the rolling hour (a daily budget?) is also spent`;
    log(a, `REFILL WALL after ${box.sent} requests (${Math.round((Date.now() - (box.start ?? Date.now())) / 60_000)} min) — ${verdict}: ${r.status} ${r.body.slice(0, 500)} | Retry-After ${box.wall.retryAfter ?? "none"}`);
    a.phase = "waitR";
  } else {
    a.climb2.wall = wallOf(r, a.climb2.sent, "solve", a.climb2.solves);
    log(a, `WALL in the solve climb after ${a.climb2.solves} solves / ${a.climb2.sent} requests: ${r.status} ${r.body.slice(0, 500)} | Retry-After ${a.climb2.wall.retryAfter ?? "none"}`);
    a.phase = "inside2";
  }
  save();
}

/** CROSS-CHECK: the other account, fresh, probed the moment this one walls — a wall there too = per-IP. */
async function crossCheck(walled: Acct, other: Acct): Promise<void> {
  if (other.crossCheck || other.phase === "stopped") return;
  if (!other.solId) { log(other, "cross-check skipped: no solve to read (setup did not finish)"); return; }
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await send(other, "poll", nodePath(other.solId, other.nodes[i % other.nodes.length]));
    if (!r) return;
    statuses.push(r.status);
    await sleep(CONFIRM_GAP);
  }
  const walledToo = statuses.filter((s) => s === 429).length;
  const verdict = walledToo === 3 ? `PER-IP (or shared): ${other.label} is walled too while ${walled.label} is`
    : walledToo ? `MIXED: ${walledToo}/3 of ${other.label}'s probes were 429` : `PER-ACCOUNT: ${other.label} answers normally while ${walled.label} is walled`;
  other.crossCheck = { at: Date.now(), statuses, verdict };
  log(other, `cross-check → ${statuses.join(", ")} — ${verdict}`);
  save();
}

/** INSIDE: 10 minutes at 1 per 10 s — does anything still get through? */
async function inside(a: Acct, which: "inside" | "inside2"): Promise<void> {
  const box = a[which];
  box.start ??= Date.now();
  const node = () => (a.solId ? nodePath(a.solId, a.nodes[(box.ok + box.x429 + box.other) % a.nodes.length]) : null);
  while (a.phase === which && !state.alarm && Date.now() - box.start < INSIDE_FOR * SCALE) {
    const p = node();
    if (!p) break;
    const r = await send(a, "poll", p);
    if (!r) return;
    if (r.status === 429) box.x429++; else if (r.status >= 200 && r.status < 300) box.ok++; else box.other++;
    if (isRefusal(r)) { stop(a, `403 inside the wall: ${r.body.slice(0, 300)}`); return; }
    save();
    await sleep(INSIDE_GAP);
  }
  if (a.phase !== which) return;
  log(a, `inside the wall (10 min, 1 per 10 s): ${box.x429} x 429, ${box.ok} x ok, ${box.other} other — ${box.ok ? "requests STILL GET THROUGH (a per-server / leaky counter?)" : "a solid wall"}`);
  a.phase = which === "inside" ? "wait" : "wait2";
  save();
}

/** WAIT: one probe per 10 min (sooner if Retry-After says so); cleared = CONFIRM OK in a row. */
async function wait(a: Acct, which: "wait" | "waitR" | "wait2"): Promise<void> {
  const box = which === "waitR" ? a.waitR! : a[which];
  box.start ??= Date.now();
  const wall = which === "wait" ? a.climb.wall : which === "waitR" ? a.refill!.wall : a.climb2.wall;
  const ra = Number(wall?.retryAfter);
  // a Retry-After shorter than the gap is honoured, but never below WAIT_MIN: a leaky wall answered every minute
  // would spend thousands of probes a day and keep a rolling window from ever clearing
  const gap = Number.isFinite(ra) && ra > 0 ? Math.min(WAIT_GAP, Math.max(WAIT_MIN, ra * 1000 + 5_000)) : WAIT_GAP;
  log(a, `waiting for the wall to lift: one probe every ${(gap / 60_000).toFixed(1)} min${wall?.retryAfter ? ` (Retry-After was ${wall.retryAfter})` : ""}`);
  while (a.phase === which && !state.alarm) {
    const since = box.lastProbe ? Date.now() - box.lastProbe : Infinity;
    if (since < gap * SCALE) { await sleep((gap - since / SCALE)); continue; }
    if (!a.solId) break;
    let okRun = 0;
    for (let i = 0; i < CONFIRM; i++) {
      const r = await send(a, "poll", nodePath(a.solId, a.nodes[(box.probes + i) % a.nodes.length]));
      if (!r) return;
      box.probes++;
      box.lastProbe = Date.now();
      box.lastStatus = r.status;
      if (isRefusal(r)) { stop(a, `403 while waiting: ${r.body.slice(0, 300)}`); return; }
      if (r.status >= 200 && r.status < 300) okRun++; else break;
      if (i < CONFIRM - 1) await sleep(CONFIRM_GAP);
    }
    save();
    if (okRun === CONFIRM) {
      box.clearedAt = Date.now();
      const w = wall?.at ?? box.start;
      log(a, `WALL LIFTED — ${CONFIRM} OK in a row at ${iso()} (${((Date.now() - w) / 3_600_000).toFixed(2)} h after the first 429; the last probe before it was ${gap / 60_000} min earlier)`);
      a.phase = which === "wait" ? "drain" : which === "waitR" ? "climb2" : "done";
      save();
      return;
    }
    if (okRun) log(a, `probe: ${okRun} OK then a 429 — not cleared yet`);
  }
}

/** DRAIN: one probe per 2 min until the hour after the first wall has fully passed, then REFILL. */
async function drain(a: Acct): Promise<void> {
  const box = a.drain!;
  box.start ??= Date.now();
  const until = (a.climb.wall?.at ?? box.start) + (HOUR + 90_000) * SCALE;
  log(a, `drain: one probe per ${WAIT_MIN / 60_000} min until ${iso(until)} (an hour after the wall), then the refill climb`);
  let lastSt: number | null = box.samples.at(-1)?.st ?? null;
  while (a.phase === "drain" && !state.alarm) {
    if (Date.now() >= until) { a.phase = "refill"; save(); return; }
    const last = box.samples.at(-1)?.t ?? 0;
    const since = Date.now() - last;
    if (since < WAIT_MIN * SCALE) { await sleep(Math.min(WAIT_MIN - since / SCALE, (until - Date.now()) / SCALE + 10)); continue; }
    if (!a.solId) break;
    const r = await send(a, "poll", nodePath(a.solId, a.nodes[box.samples.length % a.nodes.length]));
    if (!r) return;
    if (isRefusal(r)) { stop(a, `403 while draining: ${r.body.slice(0, 300)}`); return; }
    box.samples.push({ t: Date.now(), st: r.status, ra: r.headers["retry-after"] ?? null });
    if (r.status !== lastSt) log(a, `drain probe: ${r.status}${r.headers["retry-after"] ? ` (Retry-After ${r.headers["retry-after"]})` : ""}${lastSt != null ? ` — was ${lastSt}` : ""}`);
    lastSt = r.status;
    save();
  }
}

/** CLIMB2: new solves (tree + solution + root read) at 1 request / s until the first wall. */
async function climb2(a: Acct): Promise<void> {
  a.climb2.start ??= Date.now();
  log(a, `solve climb: new heads-up solves at 1 request/s from solve ${a.climb2.solves + 1} (cap ${SOLVE_CAP} solves / ${CLIMB_CAP} requests)`);
  while (a.phase === "climb2" && !state.alarm) {
    if (a.climb2.solves >= SOLVE_CAP || a.climb2.sent >= CLIMB_CAP) {
      a.climb2.capped = true;
      log(a, `solve climb reached its cap with NO wall (${a.climb2.solves} solves, ${a.climb2.sent} requests)`);
      a.phase = "done"; save(); return;
    }
    const stack = 100 + ((a.climb2.solves + 1) % 400) / 10;       // 100.1 … 140: every tree distinct
    const tr = await send(a, "tree", "/v4/custom-solutions/custom-trees/", { method: "POST", body: huTree(stack) });
    if (!tr) return;
    a.climb2.sent++;
    if (isWall(tr)) { await hitWall(a, tr, "climb2"); return; }
    if (isRefusal(tr)) { stop(a, `403 creating a tree: ${tr.body.slice(0, 300)}`); return; }
    await sleep(CLIMB_GAP);
    if (!tr.json?.id) continue;
    const so = await send(a, "solution", "/v4/custom-solutions/", { method: "POST", body: { custom_tree_id: tr.json.id, actions: "", board: "" } });
    if (!so) return;
    a.climb2.sent++;
    if (isWall(so)) { await hitWall(a, so, "climb2"); return; }
    if (isRefusal(so)) { stop(a, `403 creating a solution: ${so.body.slice(0, 300)}`); return; }
    await sleep(CLIMB_GAP);
    if (!so.json?.id) continue;
    const seen: { wall: Reply | null } = { wall: null };
    const root = await readyNode(a, String(so.json.id), "", (r) => { a.climb2.sent++; if (isWall(r)) { seen.wall = r; return true; } return false; });
    if (seen.wall) { await hitWall(a, seen.wall, "climb2"); return; }
    if (root?.status === 200) a.climb2.solves++;
    if (a.climb2.solves % 25 === 0) log(a, `solve climb: ${a.climb2.solves} solves, ${a.climb2.sent} requests`);
    save();
    await sleep(CLIMB_GAP);
  }
}

// ---------------------------------------------------------------- driver

async function run(a: Acct, other: Acct, gate: () => boolean): Promise<void> {
  while (!state.alarm) {
    if (a.phase === "done" || a.phase === "stopped") return;
    if (a.phase === "setup") { await setup(a); if (a.phase === "setup") return; continue; }
    if (a.phase === "climb") {
      if (!gate()) { await sleep(5_000); continue; }   // staggered: Ultra waits for Elite's wall + the cross-check
      await climb(a);
      // only the FIRST wall is cross-checked, and only against an account that has not walled itself
      if ((a.phase as Phase) === "inside" && !a.crossCheck && !other.crossCheck && !other.climb.wall && other.phase !== "stopped") await crossCheck(a, other);
      continue;
    }
    if (a.phase === "inside" || a.phase === "inside2") { await inside(a, a.phase); continue; }
    if (a.phase === "wait" || a.phase === "waitR" || a.phase === "wait2") { await wait(a, a.phase); continue; }
    if (a.phase === "drain") { await drain(a); continue; }
    if (a.phase === "refill") { await climb(a, "refill"); continue; }
    if (a.phase === "climb2") { await climb2(a); continue; }
    return;
  }
}

// Bun ends a process whose event loop is empty EVEN WITH a top-level await pending — and the CDP token sniff holds
// nothing that keeps the loop alive, so the first run (2026-09-26 11:04 UTC) exited silently mid-sniff. Hold it open,
// and never die without a line in the log.
setInterval(() => { /* keep-alive */ }, 60_000);
process.on("exit", (code) => log(null, `process exit (code ${code}) — Elite: ${state.accts.secondary.phase}, Ultra: ${state.accts.primary.phase}`));
process.on("uncaughtException", (e) => { log(null, `CRASH: ${e instanceof Error ? e.stack ?? e.message : e}`); save(); process.exit(1); });
process.on("unhandledRejection", (e) => { log(null, `CRASH (rejection): ${e instanceof Error ? e.stack ?? e.message : e}`); save(); process.exit(1); });

const E = state.accts.secondary;
const U = state.accts.primary;
log(null, `probe ${load() && state.startedAt < Date.now() - 5_000 ? "RESUMED" : "started"} (pid ${process.pid}) — Elite: ${E.phase}, Ultra: ${U.phase}; API ${API_BASE}${SCALE !== 1 ? `, time scale ${SCALE}` : ""}`);
save();
// both solves first (a few requests each), so the cross-check has something to read on the fresh account
if (U.phase === "setup") await setup(U);
if (E.phase === "setup") await setup(E);
// Ultra climbs once Elite has walled and been cross-checked — or once Elite is out of the picture
const ultraMayClimb = () => !!U.crossCheck || E.phase === "stopped" || E.phase === "done" || (E.climb.capped && E.phase !== "climb");
await Promise.all([run(E, U, () => true), run(U, E, ultraMayClimb)]);
log(null, `probe finished — Elite: ${E.phase}${E.stopReason ? ` (${E.stopReason})` : ""}, Ultra: ${U.phase}${U.stopReason ? ` (${U.stopReason})` : ""}${state.alarm ? ` — ALARM: ${state.alarm}` : ""}`);
save();
process.exit(0);
