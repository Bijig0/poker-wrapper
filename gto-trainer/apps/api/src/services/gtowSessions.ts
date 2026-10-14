/**
 * GtowSessions — the pool of GTO Wizard accounts we can answer a spot with.
 *
 * There is more than one, for two reasons that pull in opposite directions:
 *
 *  - PRIMARY  is the Ultra account, signed in to app.gtowizard.com inside a
 *    dedicated Chrome profile (scripts/start_gtow_chrome.ps1, CDP 9222). Ultra
 *    is the only plan whose AI can solve 3+ player trees — every multiway
 *    postflop node and nearly every preflop node needs it. It also carries the
 *    daily browsing/solve limit we keep running into, which is the whole
 *    reason a second account exists.
 *
 *  - SECONDARY is an Elite account (its own Chrome profile and CDP port). Elite
 *    includes GTO Wizard AI but HEADS-UP ONLY: hand it a 3-player tree and the
 *    API refuses it. Its quota is separate from the primary's, so every
 *    heads-up solve it absorbs is one the primary does not spend. (The pool has
 *    had no Elite account since the desktop-app one was dropped 2026-10-13;
 *    the routing below is unchanged and applies whenever one is added.)
 *
 * Hence the routing rule Brady asked for (2026-09-21):
 *
 *      postflop heads-up  -> SECONDARY (Elite), so the Ultra quota is spared
 *      preflop, any shape -> PRIMARY (Ultra)
 *      postflop multiway  -> PRIMARY (Ultra)
 *
 * `route()` is where that lives; everything else here exists to keep the two
 * sessions' tokens warm and to notice when one of them has hit a wall.
 *
 * NOTE the shape of the preflop rule: it is an ORDER, not a capability. Elite
 * genuinely cannot take a multiway tree (`PREFLOP_MULTIWAY_NOT_ALLOWED`,
 * measured 2026-09-21), so `multiway` is a hard filter. Elite CAN solve a
 * heads-up preflop tree — measured at 3.6 s end to end, the same as Ultra — so
 * making preflop a hard filter too would mean that the day Ultra runs out,
 * every preflop spot has no answer at all while a perfectly capable account
 * sits idle. Preferring the primary gets the rule Brady wants in every normal
 * case and keeps Elite as the last resort in the one case that would otherwise
 * go dark.
 *
 * Capability is a HINT, not a contract. `multiway` below is what we believe a
 * plan can do, but the truth is whatever the API says when asked — so a plan
 * refusal observed at runtime is recorded against the session (see
 * `noteFailure`) and routing stops sending it that kind of work. This is what
 * makes the pool safe to reconfigure: declare the tiers wrong and the first
 * refusal corrects it.
 */

import { asActivity, currentStepper, step, timed, tmark } from "./answerTrace";
import { currentRequestScope } from "./requestScope";
import { loadAccounts, WALL_MS, type GtowTier } from "./gtowAccounts";
import { isAuthFailure } from "./gtowAuthBody";
import { gtowLoad, type LoadCounts, type LoadView } from "./gtowLoad";
import { tstepDetail } from "./liveSteps";

const TOKEN_SKEW_MS = 60_000; // treat a token as dead a minute before it expires
const REFRESH_RETRY_MS = 10_000; // floor between sniff ATTEMPTS on one session
// A sniff that found NO token is remembered this long: a session whose client is up but signed out (the Elite
// window after GTO Wizard's outage, 2026-09-24) otherwise cost EVERY heads-up solve a full SNIFF_TIMEOUT_MS
// (15 s) before the next account was tried — hand 754's flop answer took 21 s, 15 of them here. The keeper's
// forced refresh still re-checks it in the background, so signing back in is picked up within its cadence.
const SNIFF_FAIL_HOLD_MS = 60_000;
const SNIFF_TIMEOUT_MS = 15_000;
const SNIFF_PASSIVE_MS = 3_500;
/** A session that is simply unreachable/logged out is retried soon — it is a
 *  transient, not a wall. */
const SOFT_BLOCK_MS = 60_000;

/** A slot id from the account registry (services/gtowAccounts.ts): "primary" (Ultra) and "secondary" (Elite 1, retired
 *  2026-10-13 — its old ledger rows keep the id) for the accounts that predate it, a slug of the name for any added later. A string, so a third account is a
 *  registry row and not a code change. */
export type GtowSessionId = string;

/** What a piece of work needs from an account. `multiway` is a hard capability
 *  (Elite's AI refuses 3+ player trees); `preflop` only changes the ORDER — see
 *  the note at the top of this file. */
export interface GtowNeed {
  multiway?: boolean;
  preflop?: boolean;
}

export interface GtowSessionCfg {
  id: GtowSessionId;
  /** the registry's name for the account ("Ultra", "Elite 1") */
  label: string;
  tier: GtowTier;
  /** host:port of this session's Chrome DevTools endpoint */
  cdpHost: string;
  /** does this account's plan include 3+ player AI trees (Ultra yes, Elite no) */
  multiway: boolean;
  /** preference among the sessions that CAN do the work — lower goes first */
  order: number;
  /** the same preference for PREFLOP work, where Brady wants Ultra first */
  preflopOrder: number;
  /** what brings it up, shown in the UI when it is down */
  launchHint: string;
  enabled: boolean;
}

/**
 * LEAST-LOADED ROUTING (2026-10-08, Brady: "for the same type of work … rotate through all the accounts we have … PER
 * request, this sort of balances out so that no individual account gets too much and is split evenly"). Agreed with him:
 * the unit is a TREE — a solve's polls, node reads, node locks and auth retries stay on the account that minted it (a
 * solve lives on that account; another account's token 404s it) — and "rotate" means the CAPABLE account with the fewest
 * requests in the trailing hour (round-robin when they are level; self-correcting when the Ultras also carry the
 * multiway work Elite cannot take). Before it, the pool routed by a fixed PREFERENCE and live-token-first put nearly
 * everything on `primary` (5,180 of 5,800 requests in 24 h on 2026-10-08 — memory gtow-pool-no-spread).
 *
 *   GTOW_ROUTE=balanced (unset) | priority (the old preference order, byte for byte)
 *   GTOW_HOUR_BUDGET  soft per-account trailing-hour budget, default 1800 (GTO Wizard's wall is 2,250 / rolling hour)
 *   GTOW_DAY_BUDGET   soft per-account trailing-24 h budget, default 5000 (the DAY throttle tripped near ~6,000-6,600)
 * An account at or past a budget goes to the END of the list — still used when every other one is worse (never dark).
 * Walls, plan refusals, signed-out holds and the session allowlist filter exactly as before; live-token-first stays
 * (a CDP sniff must never delay an answer while a signed-in account is ready). Counts come from services/gtowLoad (in
 * memory, every origin, no query per route).
 *
 * SOLVES IN FLIGHT FIRST (2026-10-14, hand 4924409679 — the KJ river that ran the time bank out). GTO Wizard runs an
 * account's custom solves roughly one at a time: measured on 5,334 solves (ledger 9-28..10-14), a solve POSTed while the
 * same account still had an unanswered one took 4.5 s to its first node (median) against 2.3 s on an idle account, and
 * 23.7% took longer than 8 s against 7.1%. That night three cold solves were stacked on `primary` inside 27 s while
 * `ultra-2` sat idle, and none of the last two answered. So, inside each group above, the accounts with NO solve of this
 * process still running come first (then the trailing-hour count as before). A solve is "in flight" from its POST until
 * its first answered node (or FLIGHT_MAX_MS, whichever comes first) — fed by gtowApi / gtowAiPreflop, never queried.
 *   GTOW_ROUTE_INFLIGHT=on (unset) | off (the trailing-hour order alone, as 2026-10-08..14)
 */
export type RouteMode = "balanced" | "priority";
export const routeMode = (env: Record<string, string | undefined> = process.env): RouteMode =>
  /^priority$/i.test(env.GTOW_ROUTE?.trim() ?? "") ? "priority" : "balanced";
export const routeInFlightOn = (env: Record<string, string | undefined> = process.env): boolean =>
  !/^(off|0|false|no)$/i.test(env.GTOW_ROUTE_INFLIGHT?.trim() ?? "");
/** a solve nobody has read a node of counts as running for at most this long (a lost read must not pin an account) */
export const FLIGHT_MAX_MS = 45_000;
const envNum = (v: string | undefined, d: number) => { const n = Number(v); return v != null && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : d; };
export const hourBudget = (env: Record<string, string | undefined> = process.env): number => envNum(env.GTOW_HOUR_BUDGET, 1_800);
export const dayBudget = (env: Record<string, string | undefined> = process.env): number => envNum(env.GTOW_DAY_BUDGET, 5_000);

/** One account's load as routing saw it. `count` = what it is ordered by: the trailing hour plus trees just routed. */
export interface RouteLoad extends LoadCounts { count: number; overHour: boolean; overDay: boolean }

/** route() with its reasons: the order, each account's load, and which accounts are past a soft budget. */
export interface RouteExplained {
  mode: RouteMode;
  ids: GtowSessionId[];
  loads: Record<GtowSessionId, RouteLoad>;
  /** accounts that are capable and un-blocked but past a soft budget (moved to the end) */
  overBudget: GtowSessionId[];
  hourBudget: number;
  dayBudget: number;
  /** this process's solves still running on each account (GTOW_ROUTE_INFLIGHT) — the first ordering key when on */
  flight: Record<GtowSessionId, number>;
}

/** Why a session is not taking work right now. */
export type BlockKind = "quota" | "plan" | "auth" | "unreachable";

/** What refreshAfterAuthFailure brought back: the token to retry with (null: none), how long the read took, whether it
 *  is the very token that was refused (`same`), and whether the caller's budget ran out first. */
export interface AuthRefresh { session: GtowSessionId | null; token: string | null; ms: number; same: boolean; timedOut: boolean }

export interface GtowSessionStatus {
  id: GtowSessionId;
  label: string;
  tier: GtowTier;
  cdpHost: string;
  multiway: boolean;
  order: number;
  /** where this session sits in the PREFLOP order (1 = tried first) */
  preflopOrder: number;
  enabled: boolean;
  launchHint: string;
  /** a token is in hand and not about to expire */
  tokenLive: boolean;
  expiresInMs: number | null;
  lastAttemptMs: number | null;
  /** blocked until this instant (quota wall, logged out, …) */
  blockedUntilMs: number | null;
  /** when the current request wall began (the first 429), null when not walled */
  wallSinceMs: number | null;
  blockedKind: BlockKind | null;
  blockedReason: string | null;
  /** the API refused a multiway tree on this account — routing believes the API */
  multiwayRefused: boolean;
  lastError: string | null;
  /** cloud solves minted on this account since the API started */
  trees: number;
  lastUsedMs: number | null;
  /** WHO is signed in on this client — the email + public id carried in its token (null until a token is seen).
   *  Two sessions with the same plan label (say two Elite accounts) are told apart by this, and two sessions
   *  showing the SAME account means both clients are signed into one login. */
  account: string | null;
  accountId: string | null;
  /** least-loaded routing (GTOW_ROUTE): this account's trailing-hour / 24 h requests (every origin) and trees just
   *  routed to it, against the soft budgets (absent on a pool without a counter) */
  load?: RouteLoad & { hourBudget: number; dayBudget: number };
  /** Rolled up for the UI: what this session is doing for us right now.
   *  "unknown" = nobody probed, so down and signed-out cannot be told apart. */
  state: "up" | "no-token" | "blocked" | "down" | "off" | "unknown";
  text: string;
}

/** The pool's sessions ARE the account registry (services/gtowAccounts.ts, <root>/gtow-accounts.json). The env vars
 *  that used to build this list seed the file once; edits come from the dashboard's accounts tab. */
function configs(): GtowSessionCfg[] {
  return loadAccounts().accounts.map((a) => ({
    id: a.id, label: a.name, tier: a.tier, cdpHost: a.cdpHost, multiway: a.multiway,
    order: a.order, preflopOrder: a.preflopOrder, launchHint: a.launchHint, enabled: a.enabled,
  }));
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

const decodeExpMs = (jwt: string): number => {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64").toString()).exp * 1000;
  } catch {
    return 0;
  }
};

/** The signed-in account a GTO Wizard token belongs to (its `email` / `public_id` claims), or null. */
const decodeAccount = (jwt: string): { email: string | null; publicId: string | null } | null => {
  try {
    const c = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    const email = typeof c.email === "string" && c.email ? c.email : null;
    const publicId = typeof c.public_id === "string" && c.public_id ? c.public_id : null;
    return email || publicId ? { email, publicId } : null;
  } catch {
    return null;
  }
};

/** Next 00:00 UTC. NOT when a request wall lifts — measured 2026-09-26/27: both accounts stayed walled straight through
 *  it, for 18-20 h and counting. Kept for callers that want the calendar boundary; walls use WALL_MS from the trip. */
export const nextDailyResetMs = (now = Date.now()): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
};

/**
 * What a non-OK response from GTO Wizard actually means for routing.
 *
 * The distinction that matters: a PLAN refusal is permanent for that kind of
 * work (Elite will never solve a 3-player tree), a QUOTA wall lifts at the
 * daily reset, and everything else is transient. Getting this wrong in the
 * cautious direction only costs a retry on the other session.
 */
export function classifyFailure(status: number, body: string): BlockKind | null {
  const b = (body ?? "").toLowerCase();
  // a 401, or a 400 / 403 whose body refuses the TOKEN ("Invalid API Key", 2026-10-08): auth, before anything below —
  // a 403 "Invalid API Key" used to fall to the bare-403 rule and read as a ~24 h QUOTA wall
  if (isAuthFailure(status, body)) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 403 || status === 422 || status === 400) {
    // The refusal GTO Wizard actually sends when Elite is handed a 3+ player
    // preflop tree (measured 2026-09-21):
    //   403 {"code": "PREFLOP_MULTIWAY_NOT_ALLOWED", "detail": "Not allowed"}
    // Nothing in that says "plan", so it used to fall through to the bare-403
    // rule below and read as a QUOTA wall — which would have taken the Elite
    // account out of rotation until the next daily reset and pushed every
    // heads-up solve onto the Ultra allowance the second account exists to
    // protect. Match the code and the bare "not allowed" explicitly.
    if (/_not_allowed|\bnot allowed\b/.test(b)) return "plan";
    // "not supported for 3+ players", "upgrade", "your plan", "elite", "ultra"
    if (/\b(plan|upgrade|subscription|tier|not (?:available|supported|included)|elite|ultra|premium)\b/.test(b)) return "plan";
    if (/\b(limit|quota|exceed|allowance|too many|daily)\b/.test(b)) return "quota";
    return status === 403 ? "quota" : null;
  }
  if (status === 0) return "unreachable";
  return null;
}

interface SessionState {
  cfg: GtowSessionCfg;
  token: string | null;
  tokenExpMs: number;
  lastAttemptMs: number;
  /** when a sniff last found NO token (0 = none since the last success) — see SNIFF_FAIL_HOLD_MS */
  sniffFailedMs?: number;
  refreshing: boolean;
  blockedUntilMs: number;
  /** the first 429 of the current wall (0 = not walled) — what "expected lift" counts from */
  wallSinceMs: number;
  blockedKind: BlockKind | null;
  blockedReason: string | null;
  multiwayRefused: boolean;
  lastError: string | null;
  trees: number;
  lastUsedMs: number;
  /** the account the last token belonged to — kept after the token expires so the UI still says whose window it is */
  account: { email: string | null; publicId: string | null } | null;
}

class GtowSessions {
  private sessions = new Map<GtowSessionId, SessionState>();
  private keeper: ReturnType<typeof setInterval> | null = null;
  /** the running session's allowlist (Brady, 2026-09-27: per-session, default everything) — null = no restriction */
  private allow: Set<GtowSessionId> | null = null;
  /** where the trailing-hour counts come from (services/gtowLoad) — none: every account reads 0, i.e. the preference order */
  private load: LoadView | null;
  /** env for the route switches (tests pass their own) */
  private env: Record<string, string | undefined>;
  /** solves this process POSTed and has not yet read a node of: id → the account and when (see routeInFlightOn) */
  private flight = new Map<string, { id: GtowSessionId; at: number }>();

  /** A solve was just POSTed on `id` (gtowApi / gtowAiPreflop): it counts against the account until noteSolveReady. */
  noteSolvePosted(id: GtowSessionId, solId: string, now = Date.now()): void {
    this.flight.set(solId, { id, at: now });
    if (this.flight.size > 500) this.flight.delete(this.flight.keys().next().value as string);
  }

  /** A node of the solve answered (any 200): it is no longer running. Unknown ids are ignored. */
  noteSolveReady(solId: string): void {
    this.flight.delete(solId);
  }

  /** This process's solves still running on `id`: POSTed within FLIGHT_MAX_MS and no node answered yet. */
  inFlight(id: GtowSessionId, now = Date.now()): number {
    let n = 0;
    for (const [sol, f] of this.flight) {
      if (now - f.at > FLIGHT_MAX_MS) { this.flight.delete(sol); continue; }
      if (f.id === id) n++;
    }
    return n;
  }

  constructor(opts: { load?: LoadView | null; env?: Record<string, string | undefined> } = {}) {
    this.load = opts.load ?? null;
    this.env = opts.env ?? process.env;
    this.reload();
  }

  /** (Re)read the registry, keeping any tokens already in hand; a slot that left the registry is dropped. */
  reload(): void {
    const seen = new Set<GtowSessionId>();
    for (const cfg of configs()) {
      seen.add(cfg.id);
      const prev = this.sessions.get(cfg.id);
      if (prev) {
        prev.cfg = cfg;
        continue;
      }
      this.sessions.set(cfg.id, {
        cfg,
        token: null,
        tokenExpMs: 0,
        lastAttemptMs: 0,
        refreshing: false,
        blockedUntilMs: 0,
        wallSinceMs: 0,
        blockedKind: null,
        blockedReason: null,
        multiwayRefused: false,
        lastError: null,
        trees: 0,
        lastUsedMs: 0,
        account: null,
      });
    }
    for (const id of [...this.sessions.keys()]) if (!seen.has(id)) this.sessions.delete(id);
    void this.adoptLedgerWalls();
  }

  /**
   * A wall outlives this process (2026-09-27: the API restarted twice during a 20 h wall and each time offered the
   * walled account live work at once). The request ledger remembers the last 429 and the last success per account,
   * so a fresh pool starts out knowing who is walled. Dynamic import: the ledger module must not be loaded just to
   * construct a pool in a test.
   */
  private async adoptLedgerWalls(): Promise<void> {
    try {
      const { gtowRequests } = await import("./gtowRequestLog");
      // the in-memory ledger once it is seeded (services/gtowLedgerView; a reload is an accounts-page write) — else the table
      const { gtowLedgerView } = await import("./gtowLedgerView");
      const ledger = gtowLedgerView.ready ? gtowLedgerView : gtowRequests;
      for (const s of this.sessions.values()) {
        if (s.blockedKind) continue;
        const w = ledger.wallState(s.cfg.id, Date.now(), WALL_MS);
        if (!w.walled || !w.expectedLiftMs || w.expectedLiftMs <= Date.now()) continue;
        s.blockedKind = "quota";
        s.blockedUntilMs = w.expectedLiftMs;
        s.wallSinceMs = w.sinceMs ?? Date.now();
        s.blockedReason = `request wall (429) seen in the ledger at ${new Date(s.wallSinceMs).toISOString().slice(11, 16)}Z — held ~24 h from the first refusal; a probe confirms`;
      }
    } catch { /* no ledger (tests) — nothing to adopt */ }
  }

  /** Restrict routing to these slots for the running session (null lifts it). Unknown ids are ignored, and an
   *  allowlist that names no known slot lifts itself rather than silence every answer. */
  setAllow(ids: GtowSessionId[] | null): void {
    const known = ids?.filter((id) => this.sessions.has(id)) ?? [];
    this.allow = ids && known.length ? new Set(known) : null;
  }

  allowList(): GtowSessionId[] | null {
    return this.allow ? [...this.allow] : null;
  }

  private allowed(s: SessionState): boolean {
    return !this.allow || this.allow.has(s.cfg.id);
  }

  private all(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => a.cfg.order - b.cfg.order);
  }

  /** The sessions in the order this KIND of work should try them. Preflop work
   *  prefers the primary (Ultra); everything else spends the secondary first. */
  private ranked(need: GtowNeed): SessionState[] {
    const key = (s: SessionState) => (need.preflop ? s.cfg.preflopOrder : s.cfg.order);
    return [...this.sessions.values()].sort((a, b) => key(a) - key(b));
  }

  /** The same candidates, those with a LIVE token first (route order kept within each group): work never waits on
   *  sniffing an account while another one is already signed in and ready. */
  liveFirst(ids: GtowSessionId[]): GtowSessionId[] {
    const isLive = (id: GtowSessionId) => { const s = this.sessions.get(id); return !!s && this.live(s); };
    return [...ids.filter(isLive), ...ids.filter((id) => !isLive(id))];
  }

  private live(s: SessionState): boolean {
    return Boolean(s.token) && Date.now() < s.tokenExpMs - TOKEN_SKEW_MS;
  }

  private blocked(s: SessionState): boolean {
    return Date.now() < s.blockedUntilMs;
  }

  /** Can this session do this kind of work, per config AND per what the API
   *  has actually told us? */
  private capable(s: SessionState, need: GtowNeed): boolean {
    if (!need.multiway) return true;
    return s.cfg.multiway && !s.multiwayRefused;
  }

  /**
   * The sessions that could answer this piece of work, best first.
   *
   * Order is the configured preference for this kind of work (secondary
   * before primary, except preflop, which is Ultra-first), minus anything that
   * cannot do the work or is behind a wall. Callers walk the list and try the
   * next one when a session refuses — that retry is what makes a wrong tier
   * declaration self-correcting.
   */
  route(need: GtowNeed = {}): GtowSessionId[] {
    return this.explainRoute(need).ids;
  }

  /** Every enabled session that could do the work, blocked ones included —
   *  the last-ditch list when `route` came back empty. */
  routeIgnoringBlocks(need: GtowNeed = {}): GtowSessionId[] {
    return this.explainRoute(need, true).ids;
  }

  /** One account's load as routing reads it (all 0 without a counter). */
  loadOf(id: GtowSessionId, now = Date.now()): RouteLoad {
    const c = this.load?.counts(id, now) ?? { h1: 0, h24: 0, pending: 0 };
    const count = c.h1 + c.pending;
    return { ...c, count, overHour: count >= hourBudget(this.env), overDay: c.h24 >= dayBudget(this.env) };
  }

  /**
   * route() and its reasons. PRIORITY: the preference order (`order`, `preflopOrder` for preflop), exactly as before.
   * BALANCED: the same candidates, in groups — (1) the accounts this KIND of work is for: multiway or preflop work → the
   * accounts whose plan takes 3+ player trees (cfg.multiway, no plan refusal seen), everything else → every account;
   * (2) heads-up preflop only: the rest (Elite, which solves a heads-up preflop tree — the last resort it always was);
   * each group under its soft budgets first, then past them; inside each, fewest requests in the trailing hour (plus
   * trees just routed) first, ties in the preference order.
   */
  explainRoute(need: GtowNeed = {}, ignoreBlocks = false): RouteExplained {
    const mode = routeMode(this.env);
    const hb = hourBudget(this.env), db = dayBudget(this.env);
    const cands = this.ranked(need).filter((s) => s.cfg.enabled && this.allowed(s) && this.capable(s, need) && (ignoreBlocks || !this.blocked(s)));
    const loads: Record<GtowSessionId, RouteLoad> = {};
    const flight: Record<GtowSessionId, number> = {};
    if (mode === "priority") return { mode, ids: cands.map((s) => s.cfg.id), loads, overBudget: [], hourBudget: hb, dayBudget: db, flight };
    const now = Date.now();
    const useFlight = routeInFlightOn(this.env);
    for (const s of cands) {
      loads[s.cfg.id] = this.loadOf(s.cfg.id, now);
      flight[s.cfg.id] = useFlight ? this.inFlight(s.cfg.id, now) : 0;
    }
    const forKind = (s: SessionState) => !(need.multiway || need.preflop) || (s.cfg.multiway && !s.multiwayRefused);
    const over = (s: SessionState) => loads[s.cfg.id]!.overHour || loads[s.cfg.id]!.overDay;
    const rank = (s: SessionState) => (forKind(s) ? 0 : 2) + (over(s) ? 1 : 0);
    // ranked() is in preference order and Array.sort is stable: equal loads keep it (round-robin as the counts level).
    // Inside a rank: the accounts with no solve of ours still running first (GTO Wizard queues an account's solves —
    // routeInFlightOn), then the trailing-hour count.
    const ids = [...cands].sort((a, b) => rank(a) - rank(b) || flight[a.cfg.id]! - flight[b.cfg.id]! || loads[a.cfg.id]!.count - loads[b.cfg.id]!.count).map((s) => s.cfg.id);
    return { mode, ids, loads, overBudget: cands.filter(over).map((s) => s.cfg.id), hourBudget: hb, dayBudget: db, flight };
  }

  /**
   * A tree was just routed to `id` (its tree POST is about to go): it is counted on the account at once
   * (gtowLoad.reserve) so trees posted in the same instant spread, and the `[gtow-route]` reason is returned — which
   * account took it and why. `order`: the candidates as walked (after live-token-first); `skipped`: why earlier ones
   * were passed over. Call it BEFORE the request goes, so the reason describes the loads the choice was made on.
   */
  noteRouted(id: GtowSessionId, need: GtowNeed, order: GtowSessionId[], skipped: string[] = []): string {
    const why = routeWhy(id, this.explainRoute(need, true), order, skipped);
    this.load?.reserve?.(id);
    return why;
  }

  cfg(id: GtowSessionId): GtowSessionCfg | null {
    return this.sessions.get(id)?.cfg ?? null;
  }

  /** Sniff this session's bearer token off its CDP endpoint. */
  private async sniff(cdpHost: string): Promise<string | null> {
    let targets: CdpTarget[];
    try {
      // Bounded: the DevTools HTTP endpoint serves one client at a time — a
      // busy/hung port otherwise wedges every solve behind this fetch.
      targets = await (await fetch(`http://${cdpHost}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
    } catch {
      return null;
    }
    const page = targets.find((t) => t.type === "page" && /gtowizard/i.test(t.url ?? ""));
    if (!page?.webSocketDebuggerUrl) return null;
    // the keeper tick's step timer (services/answerTrace): every CDP frame is parsed on the loop, timed as one step
    const stepIn = currentStepper();

    return new Promise<string | null>((resolve) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      let seq = 0;
      let done = false;
      const finish = (tok: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(hardTimer);
        clearTimeout(passiveTimer);
        try { ws.close(); } catch {}
        resolve(tok);
      };
      const hardTimer = setTimeout(() => finish(null), SNIFF_TIMEOUT_MS);
      // only on an OPEN socket: the passive timer can fire before onopen, or after the client went away — ws.send then
      // throws InvalidStateError inside a timer callback, which is uncaught and took the whole API down (2026-09-11)
      const send = (method: string, params: unknown = {}) => {
        if (ws.readyState !== WebSocket.OPEN) { finish(null); return; }
        try { ws.send(JSON.stringify({ id: ++seq, method, params })); } catch { finish(null); }
      };

      // PASSIVE-FIRST: the token rides every authenticated request, and the study
      // poller drives the client constantly — so just watch its natural traffic.
      // Navigating ourselves would race the poller (both own the one client) and
      // fail. Only if nothing flies by within the passive window (idle client, no
      // poller) do we nudge a request by navigating.
      const passiveTimer = setTimeout(() => {
        if (done) return;
        const s =
          "gametype=CashHu500zComplex&depth=100&solution_type=gwiz&gmfs_solution_tab=gwiz" +
          "&soltab=strategy&preflop_actions=R2.5-C&board=2c2d2h&flop_actions=X&history_spot=3";
        // A REAL RELOAD, not an in-app navigation (2026-09-23). The app is a single page: setting location.href
        // to another /solutions route swaps a view and often fires no authenticated request, so an idle client
        // sat at "no token" for ten minutes twice today while a Page.reload minted one in six seconds (probed).
        send("Page.reload", {});
        void s;
      }, SNIFF_PASSIVE_MS);

      ws.onopen = () => {
        send("Network.enable");
        send("Runtime.enable");
      };
      ws.onmessage = (ev) => {
        let m: any;
        try { m = stepIn("cdp frame parse", () => JSON.parse(String(ev.data))); } catch { return; }
        if (m.method === "Network.requestWillBeSent") {
          const h = m.params?.request?.headers ?? {};
          const auth: string | undefined = h.Authorization ?? h.authorization;
          if (auth && /^Bearer eyJ/.test(auth)) finish(auth.replace(/^Bearer /, ""));
        }
      };
      ws.onerror = () => finish(null);
      ws.onclose = () => finish(null);
    });
  }

  /** A usable token for one session, cached until shortly before it expires. */
  async tokenFor(id: GtowSessionId, force = false): Promise<string | null> {
    const s = this.sessions.get(id);
    if (!s || !s.cfg.enabled) return null;
    if (!force && this.live(s)) return s.token;
    if (!force && s.sniffFailedMs && Date.now() - s.sniffFailedMs < SNIFF_FAIL_HOLD_MS) return null;   // known signed out
    // ONE CDP READ AT A TIME PER SESSION (2026-10-08). The keeper, an auth retry and every poll refused at the same
    // moment all ask for a fresh token; each sniff may Page.reload the client, and a reload can rotate the very token
    // the sniff before it just caught. Callers join the read in flight instead.
    const inflight = this.sniffing.get(id);
    if (inflight) return inflight;
    let p!: Promise<string | null>;
    p = this.sniffInto(s, id).finally(() => { if (this.sniffing.get(id) === p) this.sniffing.delete(id); });
    this.sniffing.set(id, p);
    return p;
  }

  /** the sniff in flight per session (tokenFor) */
  private sniffing = new Map<GtowSessionId, Promise<string | null>>();

  /** Sniff one session's token and keep it (tokenFor's read). */
  private async sniffInto(s: SessionState, id: GtowSessionId): Promise<string | null> {
    const tok = await timed(`GTO Wizard token sniff ${id} (${s.cfg.cdpHost})`, () => this.sniff(s.cfg.cdpHost), (t: string | null) => (t ? "token" : "none"));
    s.lastAttemptMs = Date.now();
    if (!tok) {
      s.sniffFailedMs = Date.now();
      s.lastError = `no token on ${s.cfg.cdpHost}`;
      // don't stamp a hard block: the keeper retries, and a live client that
      // is merely mid-navigation would otherwise sit out a whole minute
      return null;
    }
    s.token = tok;
    s.sniffFailedMs = 0;
    s.tokenExpMs = decodeExpMs(tok);
    s.account = decodeAccount(tok) ?? s.account;
    s.lastError = null;
    // a fresh token means the account is reachable and signed in again — an
    // auth/unreachable wall is stale the moment one lands
    if (s.blockedKind === "auth" || s.blockedKind === "unreachable") this.clearBlock(id);
    return tok;
  }

  /**
   * The best session for this work with a token already in hand, sniffing only
   * if none of them has one. Returns the session id alongside the token because
   * a cloud solve belongs to the ACCOUNT that minted it — the caller must poll
   * it with the same token.
   */
  async bestToken(need: GtowNeed = {}): Promise<{ id: GtowSessionId; token: string } | null> {
    const ids = this.route(need);
    for (const id of ids) {
      const s = this.sessions.get(id)!;
      if (this.live(s)) return { id, token: s.token! };
    }
    for (const id of ids) {
      const tok = await this.tokenFor(id);
      if (tok) return { id, token: tok };
    }
    // every candidate is blocked — a blocked session with a live token still
    // beats returning nothing at all (a stale quota guess must not take the
    // whole chain down)
    for (const id of this.routeIgnoringBlocks(need)) {
      const s = this.sessions.get(id)!;
      if (this.live(s)) return { id, token: s.token! };
    }
    return null;
  }

  /**
   * A FRESH TOKEN AFTER AN AUTH REFUSAL (2026-10-08, services/gtowAuth): GTO Wizard refused `failed` ("Invalid API Key"
   * while the account's token was being rotated). A token another caller already put in its place is handed out at
   * once; otherwise the session's token is read again over CDP — joining a read already in flight (the keeper's, another
   * refused poll's) — within `budgetMs`, the caller's clock. A read that began before the rotation can bring the refused
   * token back: then one more read, if the budget allows. `token` null = none in time (`timedOut`) or none at all.
   * `id` null (a poll whose solve has no recorded owner): the session that held `failed`, else the best one.
   */
  async refreshAfterAuthFailure(id: GtowSessionId | null, failed: string | null, budgetMs: number): Promise<AuthRefresh> {
    const t0 = Date.now();
    const done = (session: GtowSessionId | null, token: string | null, timedOut = false): AuthRefresh =>
      ({ session, token, ms: Date.now() - t0, same: token != null && token === failed, timedOut });
    let sid = id;
    if (!sid && failed) for (const s of this.sessions.values()) if (s.token === failed) { sid = s.cfg.id; break; }
    if (!sid) {
      const b = await this.bestToken();
      return done(b?.id ?? null, b && b.token !== failed ? b.token : null);
    }
    const s = this.sessions.get(sid);
    if (!s || !s.cfg.enabled) return done(sid, null);
    if (s.token && s.token !== failed && this.live(s)) return done(sid, s.token);
    let tok: string | null = null;
    for (let read = 0; read < 2; read++) {
      const left = budgetMs - (Date.now() - t0);
      if (left <= 0) return done(sid, null, true);
      s.lastAttemptMs = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = Symbol("late");
      const got = await Promise.race([
        this.tokenFor(sid, true),
        new Promise<typeof late>((res) => { timer = setTimeout(() => res(late), left); }),
      ]).finally(() => clearTimeout(timer));
      // the read goes on in the background (the keeper and the next request get its token); this caller is out of time
      if (got === late) return done(sid, null, true);
      tok = got;
      if (!tok || tok !== failed) break;
    }
    return done(sid, tok);
  }

  /**
   * An auth refusal the refresh did not cure (services/gtowAuth). The refused token is dropped — only while it is still
   * the session's (a newer one a read brought in meanwhile stays), so the next request reads a fresh one — and the error
   * is recorded. No block: noteFailure's auth block would take a rotating account off routing for a minute, and a
   * signed-out client is already held off by the failed sniff (SNIFF_FAIL_HOLD_MS).
   */
  noteAuthFailure(id: GtowSessionId | null, token: string | null, detail: string): void {
    const s = id ? this.sessions.get(id) : [...this.sessions.values()].find((x) => token != null && x.token === token);
    if (!s) return;
    s.lastError = `auth refused: ${detail}`;
    if (token && s.token === token) { s.token = null; s.tokenExpMs = 0; }
  }

  /** Record what the API said when this session was refused, and stop routing
   *  work it cannot take. */
  noteFailure(id: GtowSessionId, status: number, body: string, need: GtowNeed = {}): BlockKind | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const kind = classifyFailure(status, body);
    s.lastError = `${status}: ${(body ?? "").slice(0, 160)}`;
    if (!kind) return null;
    if (kind === "plan" && need.multiway) {
      // The account's plan does not cover multiway trees. That is permanent,
      // and narrower than a block: it keeps taking heads-up work.
      s.multiwayRefused = true;
      s.blockedReason = `plan does not cover 3+ player AI trees (${status})`;
      return kind;
    }
    // A request wall holds about a day from the FIRST refusal (measured 2026-09-26/27 — not until midnight UTC,
    // not for Retry-After, not until a fresh login); a second 429 inside the wall must not push the lift out.
    if (kind === "quota" && !s.wallSinceMs) s.wallSinceMs = Date.now();
    const until =
      kind === "quota" ? s.wallSinceMs + WALL_MS
      : Date.now() + SOFT_BLOCK_MS;
    s.blockedUntilMs = until;
    s.blockedKind = kind;
    s.blockedReason =
      kind === "quota" ? `request wall (${status}) — GTO Wizard's 2,250/hour throttle; measured to hold ~24 h from the first refusal (a probe confirms)`
      : kind === "plan" ? `plan refused this request (${status})`
      : kind === "auth" ? "signed out — token rejected"
      : `unreachable (${status})`;
    if (kind === "auth") { s.token = null; s.tokenExpMs = 0; }
    return kind;
  }

  noteSuccess(id: GtowSessionId, opts: { tree?: boolean } = {}): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.lastUsedMs = Date.now();
    if (opts.tree) s.trees += 1;
    // work getting through is the only proof a wall has lifted
    if (s.blockedKind && s.blockedKind !== "plan") this.clearBlock(id);
  }

  clearBlock(id: GtowSessionId): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.blockedUntilMs = 0;
    s.wallSinceMs = 0;
    s.blockedKind = null;
    s.blockedReason = null;
  }

  /** Operator escape hatch: forget everything learned about a session. */
  reset(id: GtowSessionId): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.clearBlock(id);
    s.multiwayRefused = false;
    s.lastError = null;
    s.lastAttemptMs = 0;
  }

  // ── keeper ────────────────────────────────────────────────────────────────
  /** Keep a live token on hand for every enabled session, so no solve ever
   *  waits on a 4-8s CDP sniff. */
  startKeeper(intervalMs = 30_000): void {
    if (this.keeper) return;
    this.keeper = setInterval(() => void asActivity("timer gtowSessions.refresh", () => this.refreshAll()), intervalMs);
    void this.refreshAll();
  }

  keeperRunning(): boolean {
    return this.keeper != null;
  }

  private async refreshAll(): Promise<void> {
    // the routing counter's share from OTHER processes (services/gtowLoad) is synced on this timer, not in a route call
    if (this.load === gtowLoad) step("gtow load sync", () => gtowLoad.ensure(Date.now(), true));
    // the synchronous part of each session's check (until its first await) is a step of the keeper tick
    await Promise.all(this.all().map((s) => step(`session ${s.cfg.id}`, () => this.refreshIfExpiring(s))));
  }

  private async refreshIfExpiring(s: SessionState): Promise<void> {
    if (!s.cfg.enabled || s.refreshing) return;
    // 3-min margin: two keeper ticks of slack before a solve would block.
    if (s.token && Date.now() < s.tokenExpMs - 3 * 60_000) return;
    // Rate-limit ATTEMPTS, not successes: a session that is reachable but
    // logged out has no token to find, and without this it would re-sniff (and
    // re-navigate the client) every tick, forever.
    if (Date.now() - s.lastAttemptMs < REFRESH_RETRY_MS) return;
    s.refreshing = true;
    try {
      await this.tokenFor(s.cfg.id, true);
    } finally {
      s.refreshing = false;
    }
  }

  /** Get a token in hand NOW rather than on the keeper's next tick. */
  prime(): void {
    void this.refreshAll();
  }

  /** Sniff NOW, ignoring the attempt rate-limit — for the Connect button,
   *  which has just (re)launched a client and is waiting on it. */
  async forceRefresh(id?: GtowSessionId): Promise<boolean> {
    const ids = id ? [id] : this.all().map((s) => s.cfg.id);
    let any = false;
    for (const i of ids) {
      const s = this.sessions.get(i);
      if (!s?.cfg.enabled) continue;
      s.lastAttemptMs = 0;
      if (await this.tokenFor(i, true)) any = true;
    }
    return any;
  }

  /** Any session at all with a live token — "can we answer anything". */
  hasLiveToken(need: GtowNeed = {}): boolean {
    return this.ranked(need).some((s) => s.cfg.enabled && this.allowed(s) && this.capable(s, need) && this.live(s));
  }

  // ── status, for the dashboard and the wrapper's preflight ─────────────────
  private statusOf(s: SessionState, clientUp: boolean | null): GtowSessionStatus {
    const live = this.live(s);
    const blocked = this.blocked(s);
    // `clientUp === null` means NOBODY PROBED, which is not the same as "the
    // client is down" — callers that need the distinction use statusProbed().
    const state: GtowSessionStatus["state"] =
      !s.cfg.enabled ? "off"
      : live && !blocked ? "up"
      : live && blocked ? "blocked"
      : clientUp === false ? "down"
      : clientUp === true ? "no-token"
      : "unknown";
    const mins = s.token ? Math.max(0, Math.round((s.tokenExpMs - Date.now()) / 60_000)) : null;
    const text =
      !s.cfg.enabled ? "disabled"
      : blocked ? (s.blockedReason ?? "not taking work")
      : live ? `token live, ${mins} min left`
      : clientUp === true ? "client reachable but no token — is it signed in?"
      : clientUp === false ? `nothing listening on ${s.cfg.cdpHost}`
      : `no token from ${s.cfg.cdpHost}`;
    return {
      id: s.cfg.id,
      label: s.cfg.label,
      tier: s.cfg.tier,
      cdpHost: s.cfg.cdpHost,
      multiway: s.cfg.multiway && !s.multiwayRefused,
      order: s.cfg.order,
      preflopOrder: s.cfg.preflopOrder,
      enabled: s.cfg.enabled,
      launchHint: s.cfg.launchHint,
      tokenLive: live,
      expiresInMs: s.token ? s.tokenExpMs - Date.now() : null,
      lastAttemptMs: s.lastAttemptMs || null,
      blockedUntilMs: blocked ? s.blockedUntilMs : null,
      wallSinceMs: blocked && s.blockedKind === "quota" ? s.wallSinceMs || null : null,
      blockedKind: blocked ? s.blockedKind : null,
      blockedReason: blocked ? s.blockedReason : s.multiwayRefused ? s.blockedReason : null,
      multiwayRefused: s.multiwayRefused,
      lastError: s.lastError,
      trees: s.trees,
      lastUsedMs: s.lastUsedMs || null,
      account: s.account?.email ?? null,
      accountId: s.account?.publicId ?? null,
      ...(this.load ? { load: { ...this.loadOf(s.cfg.id), hourBudget: hourBudget(this.env), dayBudget: dayBudget(this.env) } } : {}),
      state,
      text,
    };
  }

  /** Per-session status WITHOUT probing anything — no sniff, no side effects. */
  status(): GtowSessionStatus[] {
    return this.all().map((s) => this.statusOf(s, null));
  }

  /** Per-session status WITH a cheap CDP liveness probe per session, so the UI
   *  can tell "client not running" from "running but signed out". */
  async statusProbed(): Promise<GtowSessionStatus[]> {
    return Promise.all(
      this.all().map(async (s) => {
        if (!s.cfg.enabled) return this.statusOf(s, null);
        let clientUp = false;
        let browser: string | null = null;
        try {
          const r = await fetch(`http://${s.cfg.cdpHost}/json/version`, { signal: AbortSignal.timeout(1500) });
          clientUp = r.ok;
          try { browser = ((await r.json()) as any)?.Browser ?? null; } catch { /* not json */ }
        } catch { clientUp = false; }
        return { ...this.statusOf(s, clientUp), clientUp, browser } as GtowSessionStatus & { clientUp: boolean; browser: string | null };
      })
    );
  }
}

/** The `[gtow-route]` reason for an account taking a tree: least-loaded, budget (past its soft budget, every other one
 *  worse or unavailable), fallback (an account before it in the order had no live token, or refused), or priority. */
export function routeWhy(id: GtowSessionId, ex: RouteExplained, order: GtowSessionId[], skipped: string[] = []): string {
  if (ex.mode === "priority") return `priority (GTOW_ROUTE=priority: ${order.join(" > ")})${skipped.length ? `; passed over: ${skipped.join("; ")}` : ""}`;
  const fmt = (x: GtowSessionId) => { const l = ex.loads[x]; return l ? `${x} ${l.h1}${l.pending ? `+${l.pending}` : ""}/h ${l.h24}/24h` : x; };
  const head = ex.ids[0];
  const ahead = ex.ids.slice(0, Math.max(0, ex.ids.indexOf(id)));
  const busy = ex.ids.filter((x) => (ex.flight[x] ?? 0) > 0);
  const why = skipped.length ? `fallback (${skipped.join("; ")})`
    : id !== head && ahead.length ? `fallback (live token first: ${ahead.join(", ")} had none in hand)`
    : ex.overBudget.includes(id) ? `budget (every capable account is past a soft budget — hour ${ex.hourBudget} / day ${ex.dayBudget} — this one is the least loaded)`
    : busy.length && !(ex.flight[id] ?? 0) ? "least-loaded (no solve of ours running on it)"
    : "least-loaded";
  const past = ex.overBudget.filter((x) => x !== id);
  const inFlight = busy.length ? `; solves in flight: ${busy.map((x) => `${x} ${ex.flight[x]}`).join(" · ")}` : "";
  return `${why}; trailing hour: ${ex.ids.map(fmt).join(" · ")}${inFlight}${past.length ? `; past a soft budget: ${past.join(", ")}` : ""}`;
}

/** The `[gtow-route]` line: api.log, and the answer's own trace (X-Answer-Trace) — which account took a tree and why,
 *  with the hand and street it was for when the request was made inside an answer (services/requestScope). */
export function logRoute(id: GtowSessionId, need: GtowNeed, why: string, what = "tree"): void {
  const sc = currentRequestScope();
  const kind = `${need.preflop ? "preflop " : ""}${need.multiway ? "multiway" : "heads-up"}`;
  const at = sc ? `${sc.handKey} ${sc.street ?? "?"} (${sc.origin}) ` : "";
  console.log(`[gtow-route] ${at}${kind} ${what} -> ${id}: ${why}`);
  tmark(`[gtow-route] ${kind} ${what} -> ${id}`, why, 400);
  // LIVE STEPS: the account the stage went to, by its name on the accounts page ("Ultra 2")
  tstepDetail(gtowSessions.cfg(id)?.label ?? String(id));
}

export const gtowSessions = new GtowSessions({ load: gtowLoad });
export { GtowSessions };
