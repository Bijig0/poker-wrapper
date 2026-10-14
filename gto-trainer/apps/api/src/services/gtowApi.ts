/**
 * Direct client for GTO Wizard's private solution API (api.gtowizard.com).
 *
 * The endpoint `GET /v4/solutions/spot-solution/` returns the full library
 * solution for a spot — both players' ranges plus per-action strategy, EVs and
 * equity buckets — as ~500KB JSON. The only auth it needs is a short-lived
 * (~15 min) bearer ACCESS token.
 *
 * We don't hold credentials: an always-running GTO Wizard session self-refreshes,
 * so we sniff its live access token over CDP (the token rides every request's
 * Authorization header), cache it, and re-sniff on expiry or a 401. The refresh
 * token itself is single-use/rotating, so it can't be replayed out of band —
 * hence sniffing the access token rather than driving the refresh ourselves.
 *
 * There is more than one such session (services/gtowSessions.ts): the Elite
 * account takes every heads-up solve so the Ultra account's daily allowance is
 * spent only on the multiway trees that need it. Everything below therefore
 * asks the pool for a token rather than holding one, walks to the next session
 * when one refuses, and remembers which account minted each cloud solve.
 *
 * This complements the local preflop DB (see services/preflopDb.ts): preflop is
 * answered locally; this reaches GTOW's HU postflop library directly, JSON in /
 * JSON out, no DOM scraping.
 */

import { gtowSessions, logRoute, type GtowNeed, type GtowSessionId } from "./gtowSessions";
// EVERY request to api.gtowizard.com goes through the ledger (2026-09-23): GTO Wizard caps REQUESTS, not
// solves, and a poll loop is many requests — see services/gtowRequestLog.ts.
import { gtowRequests } from "./gtowRequestLog";
// AN AUTH REFUSAL IS NOT A VERDICT (2026-10-08, services/gtowAuth): every request below goes through sendWithAuthRetry —
// one token refresh, the same request once more, else the decision fails with "GTO Wizard auth failed twice".
import { AUTH_RETRY_RESERVE_MS, authFailedReason, authRefreshBudgetMs, sendWithAuthRetry, type AuthRound } from "./gtowAuth";
import { NT_AUTH_RETRY, isAuthFailure, refusalDetail } from "./gtowAuthBody";
import { tmark } from "./answerTrace";
import { tstepDetail } from "./liveSteps";
// THE PERSISTENT SOLVE CACHE (2026-09-28, services/gtowSolveCache.ts): beneath ensureCustomSolution / customNode — the
// level every test stub and replay sits ABOVE — so a stubbed walk never meets it and a live one always does.
import {
  CACHE_SESSION, NO_NODE, NODE_OK, cacheKeyOf, gtowSolveCache, isStoredSolId, keyOfStoredSolId, nodeAddr, storedSolId,
  type GtowSolveCache, type StoredNode,
} from "./gtowSolveCache";

const API_BASE = "https://api.gtowizard.com";
// Zone gives ~15s per decision and the study panel needs the verdict inside
// ~10s — a solve that outlives this ceiling is useless for the decision it
// was meant to answer, so fail fast and free the poller's single flight.
const CUSTOM_SOLVE_TIMEOUT_MS = 12_000;
// Cloud solves land in ~2-5s; 1.5s polling quantized every answer up to the
// next multiple. Env-tunable so scripts/benchAiSolve.ts can sweep it.
const CUSTOM_SOLVE_POLL_MS = Number(process.env.GTOW_POLL_MS ?? 400);
/** Solved-node JSON is ~500KB each; bound the cache so a long live session
 *  can't grow it without limit. LRU — a hand's prior-street nodes stay hot. */
const NODE_CACHE_MAX = 64;
/**
 * WASTED "NOT READY" POLLS (2026-09-27). GTO Wizard answers 204 both while a custom solve is running AND, forever,
 * for a line that has no decision node in the solved tree (it closes the street / ends the hand). The ledger showed
 * the turn and river spending 104 of 178 / 55 of 99 requests on 204s, from two habits: the chain's speculative
 * prefetch asks up to 8 nodes of an UNFINISHED solve in parallel, each polling every 400 ms; and the addresses that
 * do not exist kept polling until their 6-12 s timeout. With GTO Wizard's limit measured at 2,250 requests per
 * rolling hour per account — and a trip costing the account ~a day — those polls are budget, not noise. So, for
 * the single-street shape the chain uses: ONE readiness probe per solve (its street root), first sent no sooner than
 * FIRST_POLL_MS after the solve was created (measured: ready at >= 0.66 s, median 1.1-1.7 s); every other node
 * waits for it; and once the solve is ready, a 204 is a missing node — one grace retry, then it is reported as such.
 */
const FIRST_POLL_MS = Number(process.env.GTOW_FIRST_POLL_MS ?? 600);
/**
 * THE HUNG-POLL BOUND (2026-10-08, core-real-4922578514 river: no answer after 19.0 s on a 15 s three-way node clock).
 * One spot-solution poll was allowed 8 s on its own (AbortSignal.timeout(8_000)), whatever was left of the read's clock:
 * the chain's prefetch created the solve's readiness probe (a 6 s read), its poll hung 8 s, the walk joined that probe,
 * then started its own, whose poll hung 8 s again — the read ended 4 s past its clock. Now every poll's signal is the
 * read's REMAINING clock capped at POLL_HANG_MS (GTOW_POLL_HANG_MS, default 8 s — today's per-poll cap), the token read
 * and every join on another caller's poll are bounded by it too, and a poll that HANGS (no reply within POLL_HANG_MS)
 * on a walk read hands the tree to the next account (`hung`) only when a cold tree can be expected to be re-posted and
 * read there inside what is left (COLD_TREE_MS); otherwise the read keeps polling to its clock — no answer, as before.
 * Ledger 2026-10-01..08: ~1.4% of polls ended status 0 at ~8.8 s (the cap) — hangs, not slow replies.
 *
 * WHAT A "HUNG" POLL IS (2026-10-14, hand 4924409679: KsJd river vs a raise, no answer in 62 s, the time bank gone).
 * GTO Wizard's spot-solution read of a custom solution that is still SOLVING does not answer 204 — it HOLDS the request
 * until the solve is done (ledger 9-28..10-14: 93 polls sent before a solution's first 200, 0 answered 204, 93 "hung").
 * So a hang is a solve slower than POLL_HANG_MS, not a lost request: that night's two cold river solves took 10.6 s and
 * 11.1 s to their root (idle-account median 2.3 s, p90 6.5 s; 7.1% take over 8 s, 23.7% when the account already has
 * a solve running — gtowSessions routeInFlightOn). The re-post above threw the running solve away and started a cold
 * one on the other account, and the next attempt stacked a third. Hence THE HEDGE (aiChain, GTOW_HUNG_HEDGE): a hung
 * walk read keeps polling its solve AND posts the same tree on another account (hedgeSolution — the tree's own solve is
 * not forgotten); the first node to answer wins and that solve is adopted for the rest of the hand (adoptSolution).
 * Measured odds at the hang (4 s left of a 12 s read): keep polling 43.5%, a cold re-post ~64%, both ~80%.
 *   GTOW_HUNG_HEDGE=on (unset) | off (2026-10-08..14: forget the hung solve, re-post cold on another account)
 */
export const pollHangMs = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.GTOW_POLL_HANG_MS);
  return Number.isFinite(n) && n > 0 ? n : 8_000;
};
export const hungHedgeOn = (env: Record<string, string | undefined> = process.env): boolean =>
  !/^(off|0|false|no)$/i.test(env.GTOW_HUNG_HEDGE?.trim() ?? "");
/**
 * A COLD TREE'S COST, tree + solution POSTs + its first node read, MEDIAN — the 40-hand core menus re-run of 2026-10-08
 * (721 requests, origin stress500-core-menus): two-seat 3.9 s (p90 6.3), three-seat 6.3 s (p90 11.5). A hung walk read
 * re-posts its tree on another account only when at least this much of its clock is left.
 */
export const COLD_TREE_MS = { hu: 3_900, threeWay: 6_300 } as const;
export const coldTreeMs = (seats: number): number => (seats >= 3 ? COLD_TREE_MS.threeWay : COLD_TREE_MS.hu);

/** `p`, or `late()` once `ms` has passed — a wait on someone else's work bounded by this caller's own clock. */
function within<T>(p: Promise<T>, ms: number, late: () => T): Promise<T> {
  if (!(ms > 0)) return Promise.resolve(late());
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((res) => { timer = setTimeout(() => res(late()), ms); })]).finally(() => clearTimeout(timer));
}
const NO_NODE_GRACE = 1;
const READY_SET_MAX = 2_000;

/** `store`: served from the persistent solve cache (services/gtowSolveCache) — no request was sent for it */
/** `hung` (2026-10-08): a walk read whose poll got no reply within POLL_HANG_MS, with time left to re-post the tree on
 *  another account (`opts.repostMs`) — the caller re-creates the tree elsewhere (aiChain), as after a 429 */
type NodeFetchResult = { ok: true; data: any; solveSecs: number; cached: boolean; src: NodeSource; store?: boolean } | { ok: false; status: number; error: string; store?: boolean; hung?: boolean };
type NodeQuery = { flopActions?: string; turnActions?: string; riverActions?: string; board: string };
/** `noCache`: neither read nor write the persistent solve cache — a check that must reach GTO Wizard (the poller's
 *  startup probe, the pool-routing script). The in-process caches still apply, as they always have. */
export interface CacheOpts { noCache?: boolean }
/** A node read's options: `repostMs` — when a poll hangs and at least this much of the read's clock is left, return
 *  `hung` at once (the walk re-posts the tree on another account) instead of polling the hung solve to the clock. */
export interface NodeReadOpts extends CacheOpts { repostMs?: number }
/** A tree's options: `avoid` — accounts this tree must not be minted on (a hung solve's owner, the walk's re-post). */
export interface TreeOpts extends CacheOpts { avoid?: GtowSessionId[] }
/** `route`: the `[gtow-route]` reason the account took the tree (least-loaded routing, services/gtowSessions) */
type SolveMade = { ok: true; solId: string; session: GtowSessionId; stored?: boolean; route?: string } | { ok: false; status: number; error: string };
type EnsureResult = { ok: true; solId: string; created: boolean; session: GtowSessionId; why?: string; stored?: boolean; route?: string } | { ok: false; status: number; error: string };

/** The in-process node cache's key: the solution and the full query. */
const nodeKeyOf = (solId: string, q: NodeQuery) => JSON.stringify([solId, q.flopActions ?? "", q.turnActions ?? "", q.riverActions ?? "", q.board]);
/** The persistent cache's node address for a postflop query (services/gtowSolveCache.nodeAddr). */
const addrOf = (q: NodeQuery) => nodeAddr({ flop: q.flopActions, turn: q.turnActions, river: q.riverActions, board: q.board });

/** The chain's query shape: at most one street's actions, asked against exactly that street's board. Only this shape
 *  is known to be a single-street solve, where "the root is ready" means "every node is". */
function streetRooted(q: NodeQuery): boolean {
  const cards = (q.board ?? "").length / 2;
  const set = [q.flopActions, q.turnActions, q.riverActions].map((a) => !!a);
  if (set.filter(Boolean).length > 1) return false;
  const street = set.indexOf(true);
  return cards >= 3 && cards <= 5 && (street < 0 || street === cards - 3);
}
const isRootQuery = (q: NodeQuery) => !q.flopActions && !q.turnActions && !q.riverActions;

export interface SpotSolutionParams {
  gametype: string;
  depth: number;
  preflop_actions: string; // e.g. "R2.5-C"
  flop_actions?: string; // e.g. "X" | "X-R3" ...
  turn_actions?: string;
  river_actions?: string;
  /** Concatenated, e.g. "Ts7h2d". Omit or "" for a preflop node. */
  board?: string;
  stacks?: string;
}

/** No session could take the work — the same shape every caller already handles. */
const noSession = (need: GtowNeed) => ({
  ok: false as const,
  status: 0,
  error: need.multiway
    ? `No GTO Wizard session can solve a multiway ${need.preflop ? "preflop " : ""}tree (the Ultra account is down or out of allowance)`
    : "No access token — is a GTO Wizard session running with its debug port? (see the dashboard's GTO Wizard panel)",
});

class GtowApi {
  /** `cache`: the persistent solve cache this client reads and writes — the process's own by default; a test hands
   *  each instance its own (two instances on one file = two processes sharing it). */
  constructor(private readonly cache: GtowSolveCache = gtowSolveCache) {}

  /**
   * Which ACCOUNT minted each custom solution. A cloud solve lives on the
   * account that created it, so every later poll of it must carry that
   * account's token — mixing them up 404s. This is the one piece of state the
   * multi-session pool forces on callers, and keeping it here means
   * `customNode(solId, …)` stays a two-argument call everywhere it is used.
   */
  private solOwner = new Map<string, GtowSessionId>();

  /** The account a solve this process holds lives on (a stored tree: the one that materialised it), or null. */
  ownerOf(solId: string): GtowSessionId | null {
    const o = this.solOwner.get(solId) ?? (isStoredSolId(solId) ? this.solOwner.get(this.realOf.get(solId) ?? "") : undefined);
    return o && o !== CACHE_SESSION ? o : null;
  }

  startTokenKeeper(intervalMs = 30_000): void {
    gtowSessions.startKeeper(intervalMs);
  }

  /**
   * Get a token in hand NOW rather than on the keeper's next tick. Call it the
   * moment GTO Wizard becomes reachable: the keeper can't sniff before the
   * client is up, so its 30s cadence otherwise races the first decision of the
   * session — and losing that race costs the full sniff (7.2-8.6s measured,
   * larger than any solve). No-op while the current tokens are healthy.
   */
  primeToken(): void {
    gtowSessions.prime();
  }

  /** Sniff NOW, ignoring the attempt rate-limit — for the dashboard's Connect
   *  button, which has just (re)launched a client and is waiting on it. */
  async forceRefresh(id?: GtowSessionId): Promise<boolean> {
    return gtowSessions.forceRefresh(id);
  }

  /** True once a usable token is in hand — lets callers report readiness
   *  without forcing a sniff. */
  hasLiveToken(need: { multiway?: boolean } = {}): boolean {
    return gtowSessions.hasLiveToken(need);
  }

  /**
   * Token keeper state for the Sources registry — no sniff, no side effects.
   * The top-level fields are the POOL rolled up (any session live = live, the
   * longest-lived token's expiry), so every existing caller keeps working;
   * `sessions` is the per-account detail the monitors render.
   */
  tokenStatus(): {
    live: boolean;
    expiresInMs: number | null;
    lastAttemptMs: number | null;
    keeperRunning: boolean;
    multiwayLive: boolean;
    sessions: ReturnType<typeof gtowSessions.status>;
  } {
    const sessions = gtowSessions.status();
    const usable = sessions.filter((s) => s.tokenLive && s.state === "up");
    const best = usable.reduce<number | null>((m, s) => (s.expiresInMs != null && (m == null || s.expiresInMs > m) ? s.expiresInMs : m), null);
    const lastAttempt = sessions.reduce<number | null>((m, s) => (s.lastAttemptMs != null && (m == null || s.lastAttemptMs > m) ? s.lastAttemptMs : m), null);
    return {
      live: usable.length > 0,
      expiresInMs: best,
      lastAttemptMs: lastAttempt,
      keeperRunning: gtowSessions.keeperRunning(),
      multiwayLive: gtowSessions.hasLiveToken({ multiway: true }),
      sessions,
    };
  }

  /** A valid access token from the best session for this work (the node poll's fallback when a solution has no
   *  recorded owner, and its refresh after a 401). */
  async accessToken(force = false, need: GtowNeed = {}): Promise<string | null> {
    if (force) await gtowSessions.forceRefresh();
    return (await gtowSessions.bestToken(need))?.token ?? null;
  }

  /** Requests sent to api.gtowizard.com (all processes, per account), against the stated daily cap. */
  requestStats() {
    return gtowRequests.stats();
  }

  private buildUrl(p: SpotSolutionParams): string {
    const q = new URLSearchParams({
      gametype: p.gametype,
      depth: String(p.depth),
      stacks: p.stacks ?? "",
      preflop_actions: p.preflop_actions,
      flop_actions: p.flop_actions ?? "",
      turn_actions: p.turn_actions ?? "",
      river_actions: p.river_actions ?? "",
      // `?? ""` like every field above it. Without the fallback URLSearchParams
      // stringifies undefined to the literal "undefined" and the API 422s with
      // `Invalid board: 'undefined'` — which is every preflop node, since a
      // preflop spot has no board.
      board: p.board ?? "",
    });
    return `${API_BASE}/v4/solutions/spot-solution/?${q}`;
  }

  /**
   * Fetch a spot solution. Returns the parsed JSON on success. On an auth refusal (a 401, or a 400 "Invalid API Key")
   * the token is refreshed once and the call retried (services/gtowAuth). `null` means the API/client
   * is unreachable or a solution doesn't exist for the spot.
   */
  async spotSolution(p: SpotSolutionParams): Promise<{ ok: true; data: any } | { ok: false; status: number; error: string }> {
    const url = this.buildUrl(p);
    const need: GtowNeed = {}; // library solutions: any plan, so any session may serve it
    const ids = gtowSessions.route(need);
    const candidates = gtowSessions.liveFirst(ids.length ? ids : gtowSessions.routeIgnoringBlocks(need));
    if (!candidates.length) return noSession(need);
    let last: { status: number; error: string } | null = null;
    for (const id of candidates) {
      // one token refresh per session (services/gtowAuth): a token that went stale or was rotated between the keeper's
      // tick and this call is the common auth refusal, not a signed-out account
      const token = await gtowSessions.tokenFor(id);
      if (!token) { last = { status: 0, error: `${id}: no access token` }; continue; }
      let sent: Awaited<ReturnType<typeof sendWithAuthRetry>>;
      try {
        sent = await sendWithAuthRetry(id, "library", token, (tok, retry) =>
          gtowRequests.fetch(id, "library", url, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(12_000) }, retry ? { nt: NT_AUTH_RETRY } : undefined));
      } catch (e) {
        last = { status: 0, error: `${id}: ${e instanceof Error ? e.message : e}` };
        continue;
      }
      if (sent.auth && !sent.auth.recovered) {
        gtowSessions.noteAuthFailure(id, sent.token, sent.auth.detail);
        last = { status: 401, error: authFailedReason(sent.auth) };
        continue;
      }
      const res = sent.res;
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        // 404 means this SPOT has no library solution — every account would
        // say the same, so don't burn the pool walking to the next one.
        if (res.status === 404) return { ok: false, status: 404, error: body };
        gtowSessions.noteFailure(id, res.status, body, need);
        last = { status: res.status, error: body };
        continue;
      }
      gtowSessions.noteSuccess(id);
      return { ok: true, data: await res.json() };
    }
    return { ok: false, status: last?.status ?? 401, error: last?.error ?? "Unauthorized after token refresh" };
  }

  // ── AI-solve (custom solutions) ────────────────────────────────────────────
  /** tree params → custom_solution_id, so every node of the same tree shares one cloud solve. */
  private treeSolCache = new Map<string, string>();
  /** (solId, node) → solved node JSON. */
  private nodeCache = new Map<string, any>();
  /**
   * The last tree created for each board + starting street + seat count, as a fingerprint (2026-09-24). The
   * chain re-walks every earlier street on every decision and expects those trees to come from treeSolCache;
   * when one is created again instead, the fingerprint diff says WHAT moved the key — a stack that drifted
   * between probes, a size pinned after a wager, ranges from a different chart — and that reason travels in
   * the answer's trace and the [chain] log line. Before this the only symptom was a slow turn.
   */
  private lastTreeByStreet = new Map<string, TreeFingerprint>();

  private treeKey(input: CustomTreeInput): string {
    return JSON.stringify([
      input.board, input.pot, input.stack, input.startingStreet ?? "FLOP",
      input.oopRange, input.ipRange, input.rake ?? null, input.fixedBets ?? null,
      input.fixedLevels ?? null, input.mid?.range ?? null, input.huGrid ?? null,
      // what the tree carries since 2026-10-03: each seat's own stack, the wagers played as amounts, the settings
      treeStacksOf(input), input.played ?? null, TREE_SETTINGS_TAG,
      // a re-tree's carried menus (2026-10-08, retree-consistency) — only when present, so every other key is unchanged
      ...(input.carry ? [input.carry] : []),
      // the heads-up fixed menu (2026-10-08, HU_FIXED_MENU: B's tag as before, F its own) — only when it applies, so every
      // other key is unchanged; the three-way menu C and the net-pot sizes likewise (THREEWAY_MENU, MENU_POT): with
      // HU_FIXED_MENU=b, THREEWAY_MENU=b and MENU_POT=gross every key is fada815's. Deterministic: identical tables, one key.
      ...menuTagsOf(input),
    ]);
  }

  /**
   * THE TREE REQUEST (rewritten 2026-10-03, hand 4922087007: "send the table's real state"). What goes out is the
   * table as the reader has it and nothing GTO Wizard would rewrite:
   *  - EACH SEAT ITS OWN STACK (`stacks`; `stack` for every seat only when the caller has no per-seat stacks).
   *  - THE SETTINGS EXPLICIT AND OFF (TREE_SETTINGS): no all-in threshold that turns a pinned 72%-of-stack bet into the
   *    all-in (measured 2026-10-02: 18.8 of 26.2 became ALLIN), no all-in added by `allin_if_less_than`, no size merging.
   *  - THE ALL-IN LISTED where a FIXED seat's sizes are listed: with the settings off a FIXED list has no all-in unless
   *    it names one. Each seat's is its own all-in, "<stack>bb" (capped at the deepest other seat — a raise past what
   *    anyone can call is the all-in; GTO Wizard names the node by the seat's own stack: probed 2026-10-03).
   *  - A WAGER PLAYED IS ITS AMOUNT ("9.4bb" → node R9.4), never a % of the pot rounded to a tenth (`played`).
   *  - HEADS-UP: a seat that has wagered this street is FIXED at the levels it played; a seat that has not is
   *    AUTOMATIC (GTO Wizard picks its sizes — and whether to offer an all-in: an AUTOMATIC seat facing a bet can lose
   *    the all-in the old FIXED street had, and `add_allin` does not bring it back, probed 2026-10-03). A FIXED seat with
   *    no bet list is refused at every node (VALIDATION_ERROR, probed), so a raiser who did not bet gets the street's
   *    bet amount (the bet that was made there, same pot). A raise list left null on a FIXED seat is NOT automatic:
   *    GTO Wizard offers the min-raise and the all-in there (probed: 8.6 → 17.2, 19.7 → 30.8, 25 → 41.4). A null
   *    second/third list takes a copy of the list below it (probed), so where that would copy a played amount that
   *    does not fit there, the level gets the base raise list instead.
   *  - THREE SEATS: FIXED everywhere (AUTOMATIC is refused for 3+ players): a level played is its amount alone on every
   *    seat, a level not played the base list (THREE_WAY_SIZES) — and every list its seat's all-in.
   *  - HEADS-UP FIXED MENU (2026-10-08, Brady "fix 3"; HU_FIXED_MENU=on, the default — off = the AUTOMATIC rules above,
   *    byte for byte): NO AUTOMATIC SEAT on a heads-up tree. A street with no wager played: every seat FIXED at
   *    HU_FIXED_SIZES (bets 33% / 75%, raises 60% at every level — the 3-way list) + its all-in. A street with wagers
   *    played: every seat keeps that menu and its OWN wagers are added at their levels (the union the re-tree carry
   *    builds from a FIXED tree — the first tree of a played street and the re-tree are the same request); a base bet
   *    within the walk's tolerance of the seat's own played bet is dropped for it (one size, the one played).
   *  - THE MENUS SINCE 2026-10-08 EVENING (Brady's decisions on the menu study): heads-up menu F (HU_FIXED_MENU=f: bets
   *    25/33/50/75/100/125/150%, raises 60/100%), three-way menu C (THREEWAY_MENU=c: flop bets 25/75/125%, turn / river 33/75/125%, raises 60%), every
   *    BET size of our menus sent on the pot after rake (MENU_POT=net: onNetPot), every list held to GTO Wizard's
   *    10-entry cap (capSizeList, `[menu-cap]`). Each switch's old value gives the request before, byte for byte.
   */
  buildCustomTree(input: CustomTreeInput) {
    // Seats in acting order. A third seat makes it GTO Wizard's 3-player tree ("OOP+1" between the two).
    const seats: string[] = input.mid ? ["OOP", "OOP+1", "IP"] : ["OOP", "IP"];
    const stacks = treeStacksOf(input);
    const allInOf = seatAllIns(stacks);
    const AI = (i: number) => bbAmount(allInOf[i]!);
    /** a list with the seat's all-in at its end; an amount at or past the all-in IS the all-in (dropped for it) */
    const withAllIn = (i: number, list: readonly string[]): string[] => {
      const out: string[] = [];
      for (const x of list) {
        const m = /^(\d+(?:\.\d+)?)bb$/.exec(x);
        if (m && Number(m[1]) >= allInOf[i]! - 0.005) continue;
        if (!out.includes(x)) out.push(x);
      }
      out.push(AI(i));
      return out;
    };
    const LISTS = ["bet_sizes", "raise_sizes", "second_raise_sizes", "third_plus_raise_sizes"] as const;
    /** GTO Wizard's 10-entry cap per list (capSizeList): on a played street, past the cap the menu size nearest a played
     *  size goes — amounts compared in bb: a bet % on the street's pot, a raise % as raise-to over the wager it faces */
    const capped = (i: number, lv: number, list: string[], ws: PlayedWager[] | null, s: string | null): string[] => {
      if (list.length <= GTOW_SIZE_LIST_MAX) return list;
      const played = (ws ?? []).map((w) => bbAmount(w.to));
      const facing = lv === 0 ? 0 : (ws?.[Math.min(lv, 3) - 1]?.to ?? 0);
      const toBb = (x: string): number | null => {
        const a = /^(\d+(?:\.\d+)?)bb$/.exec(x);
        if (a) return Number(a[1]);
        const m = /^(\d+(?:\.\d+)?)%$/.exec(x);
        if (!m) return null;
        return lv === 0 ? (Number(m[1]) / 100) * input.pot : facing + (Number(m[1]) / 100) * (input.pot + 2 * facing);
      };
      const r = capSizeList(list, played, toBb);
      if (r.dropped.length) {
        logMenuCap(`[menu-cap] ${input.board} ${s ?? input.startingStreet ?? "FLOP"} ${seats[i]} ${LISTS[lv]}: ${list.length} sizes > ${GTOW_SIZE_LIST_MAX} ` +
          `(GTO Wizard's cap, all-in included) — dropped ${r.dropped.join(", ")} (nearest the played ${played.join(", ") || "none: nearest the all-in"}); sent [${r.list.join(", ")}]`);
      }
      return r.list;
    };
    const fixedOf = (i: number, lists: (readonly string[] | null)[], ws: PlayedWager[] | null = null, s: string | null = null) => {
      const o: Record<string, unknown> = { position: seats[i]!, type: "FIXED" as const, use_fixed_sizes: true, allow_limp: false };
      LISTS.forEach((k, lv) => { o[k] = lists[lv] == null ? null : capped(i, lv, withAllIn(i, lists[lv]!), ws, s); });
      return o;
    };
    // OUR MENUS (2026-10-08 evening): three-way C or B (THREEWAY_MENU), heads-up F or B (HU_FIXED_MENU), their BET sizes on
    // the pot after rake (MENU_POT=net: onNetPot at this tree's pot and rake — see the header of MENU_POT_NET_TAG)
    const potFactor = menuOnNetPot(input) ? netPotFactor(input.pot, input.rake ?? DEFAULT_TREE_RAKE) : 1;
    // three-way C is street-specific (flop 25/75/125, turn and river 33/75/125): the bet list by street, one raise list
    const TW = threeWaySizes();
    const twBetOf = (s: "FLOP" | "TURN" | "RIVER") => onNetPot(threeWaySizes(s).bet, potFactor);
    const auto = (i: number) => ({ position: seats[i]!, type: "AUTOMATIC" as const, allow_limp: false });
    // FIXED sizing pins a street's bets to an exact % of pot (validated format: bet_sizes:["90%"]) on every seat — the
    // street-root fallback's pin (fastSolve). With the all-in listed beside it.
    const fixed = (i: number, pct: string) => fixedOf(i, [[pct], [pct], [pct], [pct]]);
    // Per-raise-level FIXED sizing as % of pot (the AI-study route's pins): lv[0] the street's first bet, lv[1] the
    // raise over it, lv[2] the re-raise, lv[3]+ beyond; levels past the list keep the last one.
    const fixedPerLevel = (i: number, lv: string[]) => {
      const at = (k: number) => lv[Math.min(k, lv.length - 1)] ?? "50%";
      return fixedOf(i, [[at(0)], [at(1)], [at(2)], [at(3)]]);
    };
    // A 3-player tree is FIXED on every street or the API refuses it (422 "Dynamic/Automatic sizings is
    // currently not supported for 3+ players", probed 2026-09-19), so a wager-free street gets this grid
    // where a heads-up tree would get AUTOMATIC.
    const threeWay = (i: number, s: "FLOP" | "TURN" | "RIVER") => fixedOf(i, [twBetOf(s), TW.raise, TW.raise, TW.raise]);
    // A multi-size FIXED grid for a heads-up wager-free street (2026-09-19): the alternative to AUTOMATIC, opt-in per
    // tree (huGrid; the collapse-calibration harness).
    const grid = (i: number, g: { bet: readonly string[]; raise: readonly string[] }) => fixedOf(i, [g.bet, g.raise, g.raise, g.raise]);
    // THE HEADS-UP FIXED MENU (2026-10-08, HU_FIXED_MENU): where a heads-up seat was AUTOMATIC it is FIXED at
    // HU_FIXED_SIZES instead (+ its all-in), so the menu is ours and the same on every tree of the hand
    const huFix = huFixedMenuApplies(input);
    const HU = huMenuSizes();
    const huBet = onNetPot(HU.bet, potFactor);
    const huBase = (lv: number): readonly string[] => (lv === 0 ? huBet : HU.raise);
    const huFixed = (i: number) => fixedOf(i, [huBase(0), huBase(1), huBase(2), huBase(3)]);
    /** a heads-up fixed bet list with the seat's own played bet: a base % within the walk's tolerance (5% or 0.15bb,
     *  matchActionLoose) of that amount on the street's starting pot is the same size — the played amount stays */
    const huBetUnion = (list: readonly string[], s: "FLOP" | "TURN" | "RIVER", own: string[]): string[] => {
      const amts = own.map((x) => Number(/^(\d+(?:\.\d+)?)bb$/.exec(x)?.[1])).filter((x) => Number.isFinite(x));
      const onStart = s === (input.startingStreet ?? "FLOP");
      const keep = list.filter((x) => {
        const m = /^(\d+(?:\.\d+)?)%$/.exec(x);
        if (!m || !onStart) return true;
        const amt = Math.round(Number(m[1]) * input.pot) / 100;
        return !amts.some((a) => Math.abs(a - amt) <= Math.max(0.05 * a, 0.15));
      });
      return [...new Set([...keep, ...own])];
    };
    /** a street with wagers played: the levels as amounts (see the header) */
    const playedStreet = (ws: PlayedWager[], s: "FLOP" | "TURN" | "RIVER") => {
      /** a wager that IS its actor's all-in (2026-10-03, review): a short stack's shove is carried by that seat's own
       *  listed all-in, never handed to the other seats as a size — 12bb over a 10 bet is below their minimum raise, a
       *  0.6bb all-in bet is no bet size for a 100bb seat */
      const isAllIn = (w: PlayedWager) => w.to >= allInOf[w.seat]! - 0.005;
      /** the amounts played at a level, as seat i's list carries them: its own wagers (an all-in among them is its
       *  all-in), another seat's only when that was not an all-in */
      const lvAmt = (lv: number, i?: number): string[] => {
        const xs = ws.filter((w, k) => (lv < 3 ? k === lv : k >= 3) && (i == null || w.seat === i || !isAllIn(w))).map((w) => bbAmount(w.to));
        return xs.length ? [...new Set(xs)] : [];
      };
      const playedBy = (i: number, lv: number) => ws.some((w, k) => w.seat === i && (lv < 3 ? k === lv : k >= 3));
      // A RE-TREE CARRIES THE MENUS (2026-10-08, retree-consistency — aiChain.retreeInputs): the street re-solved because a
      // played size was not on the tree hero was answered on keeps that tree's menus, seat by seat, with the size added —
      // heads-up and THREE-WAY (Brady 2026-10-08: "do the 3-way too"): every seat keeps its 33% / 75% | 60% (+ its all-in)
      // and only the actor's list gains the amount played, never "the played amount alone on every seat" (below)
      const carried = input.carry && input.carry.street === s ? input.carry : null;
      if (input.mid && carried) {
        return seats.map((_, i) => {
          const cs = carried.seats[i] ?? null;
          return cs ? fixedOf(i, carriedLists(cs, i, ws, s), ws, s) : fixedOf(i, [0, 1, 2, 3].map((lv) => { const a = lvAmt(lv, i); return a.length ? a : lv === 0 ? twBetOf(s) : TW.raise; }), ws, s);
        });
      }
      if (input.mid || input.huGrid) {
        const base = input.huGrid ? { bet: input.huGrid.bet, raise: input.huGrid.raise } : { bet: twBetOf(s), raise: TW.raise };
        return seats.map((_, i) => fixedOf(i, [0, 1, 2, 3].map((lv) => { const a = lvAmt(lv, i); return a.length ? a : lv === 0 ? base.bet : base.raise; }), ws, s));
      }
      if (huFix) {
        // THE HEADS-UP FIXED MENU: each seat its base menu with its own wagers added — or, on a re-tree, the menus
        // carried (a FIXED tree's, as sent: the same lists), its own wagers added; the base bet a played bet replaces dropped
        const own = (i: number, lv: number) => ws.filter((w, k) => w.seat === i && (lv < 3 ? k === lv : k >= 3)).map((w) => bbAmount(w.to));
        return seats.map((_, i) => {
          const cs = carried?.seats[i] ?? null;
          const lists = cs ? carriedLists(cs, i, ws, s) : [0, 1, 2, 3].map((lv) => [...new Set([...huBase(lv), ...own(i, lv)])]);
          return fixedOf(i, lists.map((l, lv) => (lv === 0 && l ? huBetUnion(l, s, own(i, 0)) : l)), ws, s);
        });
      }
      return seats.map((_, i) => {
        const cs = carried?.seats[i] ?? null;
        if (cs) return fixedOf(i, carriedLists(cs, i, ws, s), ws, s);
        // AUTOMATIC ON PURPOSE — Brady's decision, 2026-10-03: the seat that has not wagered on the street is AUTOMATIC
        // even where that means no all-in at its node (probed: GTO Wizard's automatic sizing decides whether to offer
        // one, `add_allin` does not change it, and the 3 nodes measured that lost it had played the all-in 0%). The
        // "all-in stays where it was" rule of the 2026-10-03 brief (item 8) does NOT apply to AUTOMATIC seats. Do not
        // make this seat FIXED to get the all-in back: a FIXED seat's null raise list is the min-raise, not GTO Wizard's
        // size, and a listed one is a size we chose.
        if (!ws.some((w) => w.seat === i)) return auto(i);
        // the bet list: the street's bet — the base list where that bet was another seat's all-in
        const bet = lvAmt(0, i);
        const lists: (readonly string[] | null)[] = [bet.length ? bet : THREE_WAY_SIZES.bet, null, null, null];
        for (const lv of [1, 2, 3]) {
          if (playedBy(i, lv)) lists[lv] = ws.filter((w, k) => w.seat === i && (lv < 3 ? k === lv : k >= 3)).map((w) => bbAmount(w.to));
          // GTO Wizard copies the list sent for the level below into a null second / third list: keep it null only
          // when the level below went null too, else give the base raise list
          else if (lv >= 2 && lists[lv - 1] != null) lists[lv] = THREE_WAY_SIZES.raise;
        }
        return fixedOf(i, lists, ws, s);
      });
    };
    /** the base lists a carried seat's missing level takes: this tree's menu (three-way / heads-up fixed), else B as before */
    const baseBet = (s: "FLOP" | "TURN" | "RIVER"): readonly string[] => (input.mid ? twBetOf(s) : huFix ? huBet : THREE_WAY_SIZES.bet);
    const baseRaise: readonly string[] = input.mid ? TW.raise : huFix ? HU.raise : THREE_WAY_SIZES.raise;
    /**
     * A CARRIED SEAT'S LISTS (retree-consistency, 2026-10-08). Each level: the earlier tree's list for the seat — as it was
     * SENT (a FIXED seat: carried exactly, a null list stays null) or as GTO Wizard RESOLVED it at that tree's nodes (an
     * AUTOMATIC seat) — with every wager this seat played at the level added (the size the earlier tree lacked). A level
     * the earlier tree never showed for an AUTOMATIC seat: its bet takes the street's bet as a seat that wagered does
     * today, its raises the base raise list (the size we use wherever no size was chosen by GTO Wizard or played).
     */
    const carriedLists = (cs: CarriedSeat, i: number, ws: PlayedWager[], s: "FLOP" | "TURN" | "RIVER"): (readonly string[] | null)[] => {
      const own = (lv: number) => ws.filter((w, k) => w.seat === i && (lv < 3 ? k === lv : k >= 3)).map((w) => bbAmount(w.to));
      const out: (readonly string[] | null | undefined)[] = [0, 1, 2, 3].map((lv) => {
        const c = cs.lists[lv];
        const mine = own(lv);
        if (c != null) return [...new Set([...c, ...mine])];
        if (mine.length) return mine;
        return cs.from === "sent" ? null : undefined;
      });
      if (out[0] === undefined || out[0] === null) {
        // the bet list may never be empty on a FIXED seat (GTO Wizard refuses it): the street's bet, else the base list
        const streetBet = ws.filter((_, k) => k === 0 && !(ws[0]!.to >= allInOf[ws[0]!.seat]! - 0.005)).map((w) => bbAmount(w.to));
        out[0] = streetBet.length ? streetBet : baseBet(s);
      }
      if (out[1] === undefined) out[1] = baseRaise;
      for (const lv of [2, 3]) if (out[lv] === undefined) out[lv] = out[lv - 1] != null ? baseRaise : null;
      return out as (readonly string[] | null)[];
    };
    const fb = input.fixedBets;
    const fl = input.fixedLevels;
    const pl = input.played;
    const street = (s: "FLOP" | "TURN" | "RIVER") =>
      pl && pl[s]?.length
        ? { street: s, position_bet_sizes: playedStreet(pl[s]!, s) }
        : fl && fl[s]?.length
          ? { street: s, position_bet_sizes: seats.map((_, i) => fixedPerLevel(i, fl[s]!)) }
          : fb && fb[s] != null
            ? { street: s, position_bet_sizes: seats.map((_, i) => fixed(i, `${fb[s]}%`)) }
            : input.mid
              ? { street: s, position_bet_sizes: seats.map((_, i) => threeWay(i, s)) }
              : input.huGrid
                ? { street: s, position_bet_sizes: seats.map((_, i) => grid(i, input.huGrid!)) }
                : huFix
                  ? { street: s, position_bet_sizes: seats.map((_, i) => huFixed(i)) }
                  : { street: s, position_bet_sizes: seats.map((_, i) => auto(i)) };
    const player = (i: number, display: string, range: number[]) => ({
      position: seats[i]!, display_position: display, blind: null, range, stack: stacks[i]!,
      tournament_instant_bounty: null, tournament_total_bounty: null,
    });
    return {
      starting_street: input.startingStreet ?? "FLOP",
      pot: input.pot,
      ante: null,
      ante_distribution_method: "PER_PLAYER",
      bet_sizes: {
        ...TREE_SETTINGS,
        max_num_raises: 5,
        street_bet_sizes: [street("FLOP"), street("TURN"), street("RIVER")],
      },
      players: [
        player(0, input.oopPos ?? "BB", input.oopRange),
        ...(input.mid ? [player(1, input.mid.pos, input.mid.range)] : []),
        player(input.mid ? 2 : 1, input.ipPos ?? "CO", input.ipRange),
      ],
      tree_operations: [],
      resolving_policy: null,
      rake: input.rake ?? { ...DEFAULT_TREE_RAKE },
      tournament_data: null,
    };
  }

  /**
   * THE TREE REQUEST AS SENT, for the record (2026-09-24, Brady: "what the inputs sent in was … e.g. what the rake cap
   * you set was"): exactly buildCustomTree's body — the one createCustomSolution POSTs — with each player's 1,326-weight
   * range replaced by its size (combos with weight, total weight). The chain stores it per street and the hand page
   * shows it; the ranges themselves travel in the trace (rangesIn), so the summary loses nothing.
   */
  treeRequestSummary(input: CustomTreeInput) {
    const body = this.buildCustomTree(input);
    const size = (r: number[]) => {
      let combos = 0, weight = 0;
      for (const w of r) if (w > 0) { combos++; weight += w; }
      return { combos, weight: Math.round(weight * 100) / 100 };
    };
    return { ...body, players: body.players.map((p) => ({ ...p, range: size(p.range) })) };
  }

  /**
   * Create the custom tree + solution on an account (no waiting for the solve).
   *
   * A 3-seat tree (`input.mid`) is multiway, which only the Ultra plan's AI
   * will accept — so the pool is asked for a session that can take it, and a
   * plan refusal walks to the next session rather than failing the spot.
   */
  private async createCustomSolution(input: CustomTreeInput, opts: TreeOpts = {}): Promise<SolveMade> {
    const body = this.buildCustomTree(input);
    const solution = { actions: "", board: input.board };
    // A TREE THE STORE HOLDS IS NOT CREATED AGAIN (services/gtowSolveCache). It is handed out as the synthetic id
    // `gc:<key>` — no request — and its nodes are served from the store; only a node the store lacks makes an account
    // mint the solve (materialise), once. The key covers exactly this body and the solution's {actions, board}.
    const ck = this.cache.enabled && !opts.noCache ? cacheKeyOf("post", body, solution) : null;
    if (ck && this.cache.hasTree(ck.key)) return { ok: true, solId: storedSolId(ck.key), session: CACHE_SESSION, stored: true };
    // POSTFLOP: heads-up belongs to the Elite account, multiway to Ultra.
    // `preflop` is deliberately absent — that flag is the preflop piece's
    // (services/gtowAiPreflop.ts), and it is what sends preflop to Ultra.
    const made = await this.postCustomSolution(body, solution, { multiway: Boolean(input.mid) }, opts.avoid);
    // a fresh solve: every node reply it gives is stored under the tree's key (the tree's row goes in with the first)
    if (made.ok && ck) {
      this.cache.noteTree(ck.key, "post", ck.body);
      this.noteSolKey(made.solId, ck.key);
    }
    return made;
  }

  /** real solution id → its cache key: every reply polled from it is stored under that key */
  private solKey = new Map<string, string>();
  private noteSolKey(solId: string, key: string): void {
    this.solKey.set(solId, key);
    if (this.solKey.size > READY_SET_MAX) this.solKey.delete(this.solKey.keys().next().value as string);
  }
  /** The cache key a solution id answers for: a synthetic id carries it, a real one this process created maps to it. */
  private cacheKeyOfSol(solId: string): string | null {
    return isStoredSolId(solId) ? keyOfStoredSolId(solId) : this.solKey.get(solId) ?? null;
  }

  /** POST a tree and its solution on the first account routing allows (the network half of createCustomSolution, and
   *  what materialising a stored tree sends — the body exactly as stored). */
  private async postCustomSolution(body: unknown, solution: { actions: string; board: string }, need: GtowNeed, avoid: GtowSessionId[] = []): Promise<SolveMade> {
    // Every wall we record is a GUESS about what the API meant. A wrong quota
    // guess would otherwise disable multiway until the next daily reset, so
    // when nothing is routable we still try the walled sessions rather than
    // failing the spot outright — the same last-ditch rule bestToken uses.
    // THE ORDER IS THE POOL'S (least-loaded routing since 2026-10-08, GTOW_ROUTE), live tokens first; `avoid` drops the
    // accounts a re-post must not land on (a hung solve's owner) — none left = no answer, never the same account again
    const ids = gtowSessions.route(need);
    const candidates = gtowSessions.liveFirst(ids.length ? ids : gtowSessions.routeIgnoringBlocks(need)).filter((id) => !avoid.includes(id));
    if (!candidates.length) {
      return avoid.length ? { ok: false, status: 0, error: `no other GTO Wizard account can take this tree (${avoid.join(", ")} left out: its solve hung)` } : noSession(need);
    }
    let last: { status: number; error: string } | null = null;
    const skipped: string[] = [];
    const headersOf = (tok: string) => ({ Authorization: `Bearer ${tok}`, "Content-Type": "application/json" });
    for (const id of candidates) {
      const token = await gtowSessions.tokenFor(id);
      if (!token) { last = { status: 0, error: `${id}: no access token` }; skipped.push(`${id}: no token`); continue; }
      // [gtow-route]: which account takes this tree and why (least-loaded / budget / fallback) — counted on it at once
      const route = gtowSessions.noteRouted(id, need, candidates, skipped);
      logRoute(id, need, route, avoid.length ? `tree (re-post; ${avoid.join(", ")} left out)` : "tree");

      // 1. create the tree (bounded — an unbounded fetch here hung whole
      // solves when the API stalled; nothing upstream can cancel it). An auth refusal: one token refresh, the same POST
      // once more (services/gtowAuth) — then the next session.
      let tr: Awaited<ReturnType<typeof sendWithAuthRetry>>;
      try {
        tr = await sendWithAuthRetry(id, "tree", token, (tok, retry) => gtowRequests.fetch(id, "tree", `${API_BASE}/v4/custom-solutions/custom-trees/`, {
          method: "POST", headers: headersOf(tok), body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        }, retry ? { nt: NT_AUTH_RETRY } : undefined));
      } catch (e) { last = { status: 0, error: `${id}: custom-trees ${e instanceof Error ? e.message : e}` }; skipped.push(`${id}: tree failed`); continue; }
      if (tr.auth && !tr.auth.recovered) {
        gtowSessions.noteAuthFailure(id, tr.token, tr.auth.detail);
        last = { status: 401, error: `custom-trees: ${authFailedReason(tr.auth)}` };
        skipped.push(`${id}: auth refused`);
        continue; // next session
      }
      const treeRes = tr.res;
      if (!treeRes.ok) {
        const msg = (await treeRes.text().catch(() => "")).slice(0, 180);
        gtowSessions.noteFailure(id, treeRes.status, msg, need);
        last = { status: treeRes.status, error: `custom-trees: ${msg}` };
        skipped.push(`${id}: tree ${treeRes.status}`);
        continue; // next session
      }
      const tree = await treeRes.json();
      const treeId = tree.id ?? tree.custom_tree_id ?? tree.uuid;
      if (!treeId) return { ok: false, status: 502, error: "custom-trees returned no id" };

      // 2. create the solution (with the token the tree went through — the refreshed one after an auth round)
      let so: Awaited<ReturnType<typeof sendWithAuthRetry>>;
      try {
        so = await sendWithAuthRetry(id, "solution", tr.token, (tok, retry) => gtowRequests.fetch(id, "solution", `${API_BASE}/v4/custom-solutions/`, {
          method: "POST", headers: headersOf(tok), body: JSON.stringify({ custom_tree_id: treeId, actions: solution.actions, board: solution.board }),
          signal: AbortSignal.timeout(15_000),
        }, retry ? { nt: NT_AUTH_RETRY } : undefined));
      } catch (e) { last = { status: 0, error: `${id}: custom-solutions ${e instanceof Error ? e.message : e}` }; skipped.push(`${id}: solution failed`); continue; }
      if (so.auth && !so.auth.recovered) {
        gtowSessions.noteAuthFailure(id, so.token, so.auth.detail);
        last = { status: 401, error: `custom-solutions: ${authFailedReason(so.auth)}` };
        skipped.push(`${id}: auth refused`);
        continue; // next session
      }
      const solRes = so.res;
      if (!solRes.ok) {
        const msg = (await solRes.text().catch(() => "")).slice(0, 180);
        gtowSessions.noteFailure(id, solRes.status, msg, need);
        last = { status: solRes.status, error: `custom-solutions: ${msg}` };
        skipped.push(`${id}: solution ${solRes.status}`);
        continue; // next session
      }
      const sol = await solRes.json();
      const solId = sol.id ?? sol.custom_solution_id ?? sol.uuid;
      if (!solId) return { ok: false, status: 502, error: "custom-solutions returned no id" };
      gtowSessions.noteSuccess(id, { tree: true });
      return { ok: true, solId: String(solId), session: id, route };
    }
    return { ok: false, status: last?.status ?? 401, error: last?.error ?? "Unauthorized after token refresh" };
  }

  /**
   * A custom solution for the given TREE params, reused across every node query
   * of the same tree — one cloud solve serves a whole street's navigation.
   * Doesn't wait for the solve; `customNode`'s poll does.
   */
  // ONE CLOUD SOLVE PER TREE, HOWEVER MANY ASK AT ONCE (2026-09-19). The poller's solve, the street warm-up
  // (fastSolve.warmPostflop6max) and the panel's own feed-spot can all want the same street within a second;
  // each used to mint its own custom solution — two cloud solves for one spot, both slower (hand 4919059283's
  // turn: two 19-24 s answers for the same key). Later callers now join the first request.
  private treePending = new Map<string, Promise<EnsureResult>>();
  private nodePending = new Map<string, Promise<NodeFetchResult>>();
  /**
   * STORED TREES MINTED IN THIS PROCESS (services/gtowSolveCache). A synthetic id `gc:<key>` is not a solve on any
   * account; the first node read the store cannot answer creates one (materialise) and every later read polls THAT —
   * so readiness, ownership and polling all key on the real id, exactly as for a tree created afresh.
   */
  private realOf = new Map<string, string>();
  /** the one in-flight materialisation per synthetic id: concurrent misses join it (one tree + one solution POST) */
  private matPending = new Map<string, Promise<SolveMade>>();
  /** a stored tree re-posted after a hung solve (TreeOpts.avoid): the accounts its next materialisation must not use */
  private matAvoid = new Map<string, GtowSessionId[]>();
  /** speculative reads (the chain's prefetch) waiting for someone to materialise a stored tree — see customNode */
  private matWaiters = new Map<string, Set<() => void>>();
  /** seats of each solve this process minted (informational: the hung-poll log line) */
  private solSeats = new Map<string, number>();
  /** when this process created each solve — the readiness probe waits FIRST_POLL_MS from here */
  private solCreatedAt = new Map<string, number>();
  /** solves whose street root has answered: every node of them is served now, so a 204 means "no such node" */
  private solReady = new Set<string>();
  /** the one in-flight readiness probe per unfinished solve; other node asks wait on it instead of polling */
  private solProbe = new Map<string, Promise<NodeFetchResult>>();

  /**
   * Drop a solution from the tree cache — used when the account that owns it hits its daily wall mid-walk, so
   * the next ensureCustomSolution re-creates the SAME tree on an account that can still be polled.
   */
  forgetSolution(solId: string): void {
    // a stored tree's materialisation lives on the account that minted it: forgetting the synthetic id (or that real
    // solve) makes the next read mint it again, on whichever account routing allows now — the 429 reroute's point
    const ids = new Set([solId]);
    if (isStoredSolId(solId)) {
      const real = this.realOf.get(solId);
      if (real) ids.add(real);
    } else {
      for (const [g, r] of this.realOf) if (r === solId) ids.add(g);
    }
    for (const id of ids) {
      if (isStoredSolId(id)) { this.realOf.delete(id); this.matPending.delete(id); this.solOwner.delete(id); }
    }
    for (const [k, v] of this.treeSolCache) if (ids.has(v)) this.treeSolCache.delete(k);
  }

  /**
   * A POSTFLOP NODE-LOCKED CHILD of a solve this process holds (services/offTree offTreeLock, 2026-10-06, OFFTREE_LOCK=on):
   * POST /v4/custom-solutions/ {parent_solution_id, last_node_lock} on the account that owns the parent (a stored tree is
   * materialised first — a lock forks a real solve). The child is read like any solve (customNode); it is not written to
   * the persistent store (its key would need the lock: in-process memo only, one POST per parent + lock).
   */
  private lockedPending = new Map<string, Promise<EnsureResult>>();
  async lockedCustomSolution(parentSolId: string, lock: unknown): Promise<EnsureResult> {
    const memoKey = `${parentSolId}|${Bun.hash(JSON.stringify(lock)).toString(36)}`;
    const memo = this.lockedPending.get(memoKey);
    if (memo) return memo.then((r) => (r.ok ? { ...r, created: false, why: "node-locked child already made in this process" } : r));
    const p = (async (): Promise<EnsureResult> => {
      let parent = parentSolId;
      if (isStoredSolId(parent)) {
        const m = await this.materialise(parent);
        if (!m.ok) return m;
        parent = m.solId;
      }
      const owner = this.solOwner.get(parent);
      if (!owner || owner === CACHE_SESSION) return { ok: false, status: 0, error: "node lock: the account that owns the parent solution is not known" };
      const token = await gtowSessions.tokenFor(owner);
      if (!token) return { ok: false, status: 0, error: `node lock: no GTO Wizard token for ${owner}` };
      let sent: Awaited<ReturnType<typeof sendWithAuthRetry>>;
      try {
        sent = await sendWithAuthRetry(owner, "solution", token, (tok, retry) => gtowRequests.fetch(owner, "solution", `${API_BASE}/v4/custom-solutions/`, {
          method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({ parent_solution_id: parent, last_node_lock: lock }), signal: AbortSignal.timeout(15_000),
        }, retry ? { nt: NT_AUTH_RETRY } : undefined));
      } catch (e) { return { ok: false, status: 0, error: `node lock: ${e instanceof Error ? e.message : e}` }; }
      if (sent.auth && !sent.auth.recovered) {
        gtowSessions.noteAuthFailure(owner, sent.token, sent.auth.detail);
        return { ok: false, status: 401, error: `node lock: ${authFailedReason(sent.auth)}` };
      }
      const res = sent.res;
      const t = await res.text().catch(() => "");
      if (!res.ok) {
        gtowSessions.noteFailure(owner, res.status, t.slice(0, 180), {});
        return { ok: false, status: res.status, error: `node lock ${res.status}: ${t.slice(0, 180)}` };
      }
      let id: string | null = null;
      try { const j = JSON.parse(t); id = j?.id ?? j?.custom_solution_id ?? null; } catch { /* below */ }
      if (!id) return { ok: false, status: 502, error: `node lock: no solution id in the reply (${t.slice(0, 120)})` };
      this.registerSolve(String(id), owner, this.solSeats.get(parent) ?? 2);
      return { ok: true, solId: String(id), created: true, session: owner, why: "node-locked child of the street's solve" };
    })();
    this.lockedPending.set(memoKey, p);
    p.then((r) => { if (!r.ok) this.lockedPending.delete(memoKey); }).catch(() => this.lockedPending.delete(memoKey));
    if (this.lockedPending.size > 200) this.lockedPending.delete(this.lockedPending.keys().next().value as string);
    return p;
  }

  /** The solution this process already holds for these tree params, or null — a cache lookup, never a request. A tree
   *  the persistent store holds counts: its synthetic id is what ensureCustomSolution would hand out for it. */
  peekSolution(input: CustomTreeInput): string | null {
    const hit = this.treeSolCache.get(this.treeKey(input));
    if (hit) return hit;
    if (!this.cache.enabled) return null;
    const ck = cacheKeyOf("post", this.buildCustomTree(input), { actions: "", board: input.board });
    return this.cache.hasTree(ck.key, false) ? storedSolId(ck.key) : null;
  }

  /** A node already in the cache — this process's, or the persistent store's — or null; never a request. (Does not
   *  count as a hit, neither for the LRU nor for the store's statistics.) */
  peekNode(solId: string, q: { flopActions?: string; turnActions?: string; riverActions?: string; board: string }): any | null {
    const mem = this.memNode(solId, q);
    if (mem) return mem.data;
    const ck = this.cache.enabled ? this.cacheKeyOfSol(solId) : null;
    const s = ck ? this.cache.getNode(ck, addrOf(q), false) : null;
    return s?.status === NODE_OK ? s.data : null;
  }

  /** A node in this process's cache: under the id asked for, or — for a stored tree minted here — under its real solve. */
  private memNode(solId: string, q: NodeQuery): { key: string; data: any } | null {
    const key = nodeKeyOf(solId, q);
    const hit = this.nodeCache.get(key);
    if (hit) return { key, data: hit };
    const real = isStoredSolId(solId) ? this.realOf.get(solId) : undefined;
    if (!real) return null;
    const k2 = nodeKeyOf(real, q);
    const h2 = this.nodeCache.get(k2);
    return h2 ? { key: k2, data: h2 } : null;
  }

  private rememberNode(key: string, data: any): void {
    this.nodeCache.set(key, data);
    if (this.nodeCache.size > NODE_CACHE_MAX) this.nodeCache.delete(this.nodeCache.keys().next().value as string);
  }

  async ensureCustomSolution(input: CustomTreeInput, opts: TreeOpts = {}): Promise<EnsureResult> {
    const key = this.treeKey(input);
    // a re-post after a hung solve: a stored tree's next materialisation leaves the hung account out too
    if (opts.avoid?.length && this.cache.enabled && !opts.noCache) {
      const ck = cacheKeyOf("post", this.buildCustomTree(input), { actions: "", board: input.board });
      if (this.cache.hasTree(ck.key, false)) this.matAvoid.set(storedSolId(ck.key), opts.avoid.slice());
    }
    const hit = this.treeSolCache.get(key);
    // (a check that must reach GTO Wizard never takes a stored tree, not even one this process already handed out)
    if (hit && !(opts.noCache && isStoredSolId(hit))) {
      tstepDetail("already solved");
      return { ok: true, solId: hit, created: false, session: this.solOwner.get(hit) ?? (isStoredSolId(hit) ? CACHE_SESSION : "primary"),
        ...(isStoredSolId(hit) ? { stored: true } : {}) };
    }
    const pending = this.treePending.get(key);
    if (pending) {
      tstepDetail("joined a solve already running");
      return pending.then((r) => (r.ok ? { ...r, created: false, why: `joined a solve another request started (${r.why ?? "same tree"})` } : r));
    }
    // WHY is this tree not in the cache? Answered before the solve is even sent, against the last tree of the
    // same board/street/seats, so a re-creation is explained by its own log line rather than inferred later.
    const fp = treeFingerprint(input);
    const fpKey = `${fp.board}|${fp.street}|${fp.seats}|${input.planTag ?? fp.posKey}`;
    const why = describeTreeChange(this.lastTreeByStreet.get(fpKey) ?? null, fp);
    this.lastTreeByStreet.set(fpKey, fp);
    if (this.lastTreeByStreet.size > 200) {
      const first = this.lastTreeByStreet.keys().next().value;
      if (first !== undefined) this.lastTreeByStreet.delete(first);
    }
    tmark(`GTO Wizard tree ${fp.street} ${fp.board} not cached`, why);
    const p = (async (): Promise<EnsureResult> => {
      const made = await this.createCustomSolution(input, opts);
      if (!made.ok) return made;
      this.treeSolCache.set(key, made.solId);
      if (made.stored) {
        // no solve was created and none may ever be: the store holds the tree, and its nodes are served from there
        tmark(`GTO Wizard tree ${fp.street} ${fp.board} served from the solve cache`, `stored tree ${keyOfStoredSolId(made.solId).slice(0, 8)} — no request`);
        tstepDetail("already solved");
        return { ok: true, solId: made.solId, created: false, session: made.session, stored: true,
          why: `served from the persistent solve cache — no request (the in-process cache did not hold it: ${why})` };
      }
      this.registerSolve(made.solId, made.session, input.mid ? 3 : 2);
      tstepDetail("new tree");
      return { ok: true as const, solId: made.solId, created: true, session: made.session, why, ...(made.route ? { route: made.route } : {}) };
    })().finally(() => this.treePending.delete(key));
    this.treePending.set(key, p);
    return p;
  }

  /** A solve this process just POSTed: its owner, seats and age (the readiness probe), and routing's in-flight count. */
  private registerSolve(solId: string, session: GtowSessionId, seats: number): void {
    this.solOwner.set(solId, session);
    this.solSeats.set(solId, seats);
    this.solCreatedAt.set(solId, Date.now());
    if (this.solCreatedAt.size > READY_SET_MAX) this.solCreatedAt.delete(this.solCreatedAt.keys().next().value as string);
    gtowSessions.noteSolvePosted(session, solId);
  }

  /**
   * THE HEDGE (2026-10-14, see the header "WHAT A HUNG POLL IS"): a SECOND solve of the same tree on another account,
   * posted while the first keeps running. Unlike ensureCustomSolution it never answers from the tree cache or the store,
   * never joins a pending solve and does not replace the tree's solve — the caller races the two reads and adopts the
   * winner (adoptSolution). `avoid`: the account(s) whose solve hung. The hedge is a real solve like any other: owner,
   * age, seats, in-flight count, and its node replies go to the persistent store under the same tree key.
   */
  async hedgeSolution(input: CustomTreeInput, opts: { avoid?: GtowSessionId[]; /** the solve this one hedges (hedgeSibling) */ of?: string } = {}): Promise<EnsureResult> {
    const body = this.buildCustomTree(input);
    const solution = { actions: "", board: input.board };
    const made = await this.postCustomSolution(body, solution, { multiway: Boolean(input.mid) }, opts.avoid ?? []);
    if (!made.ok) return made;
    if (this.cache.enabled) {
      const ck = cacheKeyOf("post", body, solution);
      this.cache.noteTree(ck.key, "post", ck.body);
      this.noteSolKey(made.solId, ck.key);
    }
    this.registerSolve(made.solId, made.session, input.mid ? 3 : 2);
    if (opts.of) {
      const real = isStoredSolId(opts.of) ? this.realOf.get(opts.of) ?? opts.of : opts.of;
      for (const id of new Set([opts.of, real])) this.hedges.set(id, made.solId);
      this.hedges.set(made.solId, real);
      if (this.hedges.size > READY_SET_MAX) this.hedges.delete(this.hedges.keys().next().value as string);
    }
    return { ok: true, solId: made.solId, created: true, session: made.session, why: "hedge: a second solve of the tree on another account", ...(made.route ? { route: made.route } : {}) };
  }

  /** hedge pairs (hedgeSolution `of`): each solve → the one solved alongside it, both ways */
  private hedges = new Map<string, string>();
  /** The solve already running alongside `solId` as its hedge (a poller's later attempt races it again instead of posting a
   *  third solve), or null. */
  hedgeSibling(solId: string): string | null {
    const s = this.hedges.get(solId) ?? (isStoredSolId(solId) ? this.hedges.get(this.realOf.get(solId) ?? "") : undefined);
    return s ?? null;
  }

  /** Make `solId` the solve this process hands out for these tree params from now on (a hedge that answered first):
   *  every later ensureCustomSolution of the tree returns it, and a stored tree's synthetic id resolves to it. */
  adoptSolution(input: CustomTreeInput, solId: string): void {
    const key = this.treeKey(input);
    const prev = this.treeSolCache.get(key);
    this.treeSolCache.set(key, solId);
    if (prev && isStoredSolId(prev)) {
      this.realOf.set(prev, solId);
      const owner = this.solOwner.get(solId);
      if (owner) this.solOwner.set(prev, owner);
    }
  }

  /**
   * One node of an existing custom solution, polled until the cloud solve has a
   * strategy there (~2s on a fresh solution, instant afterwards). Actions are
   * GTOW tokens relative to the tree's starting street ("X-R3.3-…").
   */
  async customNode(
    solId: string,
    q: { flopActions?: string; turnActions?: string; riverActions?: string; board: string },
    timeoutMs = CUSTOM_SOLVE_TIMEOUT_MS,
    /** who is asking — rides every request this read sends into the ledger (`cl`): walk | prefetch | study */
    caller?: string,
    opts: NodeReadOpts = {}
  ): Promise<NodeFetchResult> {
    const key = nodeKeyOf(solId, q);
    const mem = this.memNode(solId, q);
    if (mem) {
      // a hit is re-inserted so the cache is a true LRU: a hand's earlier-street nodes, read again on every
      // later decision, must outlive the burst of a multiway collapse's fresh nodes (insertion order alone
      // evicted the oldest node first, which is exactly the flop root every turn and river re-walks)
      this.nodeCache.delete(mem.key);
      this.nodeCache.set(mem.key, mem.data);
      return { ok: true, data: mem.data, solveSecs: 0, cached: true, src: "cache" };
    }
    // THE PERSISTENT STORE, before any request (services/gtowSolveCache): a node GTO Wizard already answered for this
    // tree — in this process or any earlier one — is served as it came, and counted as a request not sent
    const ck = this.cache.enabled && !opts.noCache ? this.cacheKeyOfSol(solId) : null;
    if (ck) {
      const addr = addrOf(q);
      const s = this.cache.getNode(ck, addr, false);
      const served = s ? this.servedFromStore(key, q, s, caller) : null;
      this.cache.countNode(ck, addr, served ? s : null);   // a stored verdict this caller is not served is a miss
      if (served) return served;
      // A SPECULATIVE READ NEVER MINTS A STORED TREE. The chain prefetches up to 8 addresses the moment it has a
      // tree; on a stored tree most of the walk is usually in the store, and a mispredicted address must not spend a
      // tree + a solution POST the walk never needed. So the prefetch waits (within its own timeout) for someone to
      // materialise the tree — the walk, on a node the store lacks — and only then reads, joining that solve.
      if (caller === "prefetch" && isStoredSolId(solId) && !this.realOf.has(solId) && !this.matPending.has(solId)) {
        const t0 = Date.now();
        if (!(await this.materialisationStarted(solId, timeoutMs))) {
          return { ok: false, status: 0, error: "speculative read of a stored tree skipped — nothing asked for a node the solve cache lacks, so the tree was never created" };
        }
        const again = this.memNode(solId, q);
        if (again) return { ok: true, data: again.data, solveSecs: 0, cached: true, src: "cache" };
        return this.readThrough(solId, q, key, Math.max(0, timeoutMs - (Date.now() - t0)), caller, opts.repostMs);
      }
    }
    return this.readThrough(solId, q, key, timeoutMs, caller, opts.repostMs);
  }

  /**
   * A stored node as customNode's answer, or null to read through. A full node is served to everyone. A stored
   * NO_NODE — "the solve is served and this line has no decision node", which the poll INFERS from two 204s on a
   * ready solve — is served to the speculative prefetch only (the addresses it guesses are where such lines live):
   * a walk that meets one asks GTO Wizard again, so a wrong inference can never become a spot that fails forever.
   */
  private servedFromStore(key: string, q: NodeQuery, s: StoredNode, caller?: string): NodeFetchResult | null {
    if (s.status === NODE_OK) {
      this.rememberNode(key, s.data);
      return { ok: true, data: s.data, solveSecs: 0, cached: true, src: "cache", store: true };
    }
    if (s.status === NO_NODE) {
      if (caller !== "prefetch") return null;
      const line = q.riverActions ?? q.turnActions ?? q.flopActions ?? "";
      return { ok: false, status: 204, store: true,
        error: `no decision node at [${line || "root"}] — GTO Wizard's verdict on this tree, from the solve cache (the line closes the street or ends the hand)` };
    }
    return { ok: false, status: -s.status, store: true, error: `${-s.status}: ${(s.text ?? "").slice(0, 160)} (from the solve cache)` };
  }

  /** The read itself: join a poll already in flight for this node, or start one. */
  private readThrough(solId: string, q: NodeQuery, key: string, timeoutMs: number, caller: string | undefined, repostMs?: number): Promise<NodeFetchResult> {
    const pending = this.nodePending.get(key);
    if (pending) {
      // the same node is already being polled by another request (a warm-up, another panel) — share it. The wait
      // is recorded because the other request's polls are in ITS trace, not this one's: without this line a
      // joined poll is a hole in the timeline.
      const node = q.riverActions ?? q.turnActions ?? q.flopActions ?? "";
      tmark(`GTO Wizard node [${node || "root"}] joined another request's poll`, `solution ${solId.slice(0, 8)}`);
      // THE JOIN IS BOUNDED BY THIS CALLER'S CLOCK (2026-10-08, the hung-poll bound): the other request may hold a longer
      // one (a warm-up). A join that ended in a TIMEOUT while this caller still has time reads the node itself (as the
      // readiness probe already did — fetchOnSolve), not inherits another caller's shorter clock.
      const t0 = Date.now();
      const late = (): NodeFetchResult => ({ ok: false, status: 504, error: `AI solve timed out — waited ${(timeoutMs / 1000).toFixed(1)} s on another request's poll of [${node || "root"}] (solution ${solId.slice(0, 8)})` });
      return within(pending, timeoutMs, late).then((r) => {
        if (r.ok) return { ...r, src: "joined" as const };
        const left = timeoutMs - (Date.now() - t0);
        if (r.status === 504 && left > CUSTOM_SOLVE_POLL_MS && !this.nodePending.has(key)) return this.readThrough(solId, q, key, left, caller, repostMs);
        return r;
      });
    }
    const p = this.customNodeFetch(solId, q, timeoutMs, caller, repostMs).finally(() => this.nodePending.delete(key));
    this.nodePending.set(key, p);
    return p;
  }

  /** Resolves true once a materialisation of `gcId` is under way (or done), false after `ms`. */
  private materialisationStarted(gcId: string, ms: number): Promise<boolean> {
    if (this.realOf.has(gcId) || this.matPending.has(gcId)) return Promise.resolve(true);
    return new Promise((res) => {
      let set = this.matWaiters.get(gcId);
      if (!set) this.matWaiters.set(gcId, (set = new Set()));
      const waiters = set;
      const done = (v: boolean) => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (!waiters.size && this.matWaiters.get(gcId) === waiters) this.matWaiters.delete(gcId);
        res(v);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      waiters.add(wake);
    });
  }

  /**
   * MATERIALISE A STORED TREE (services/gtowSolveCache): a node read the store could not answer needs a real solve, so
   * the tree and its solution are POSTed from the stored body — exactly what was POSTed the first time — through the
   * normal routing (heads-up to Elite, three seats to Ultra), once however many reads miss at the same moment. The
   * account that mints it owns it; readiness, ownership and the node polls then key on the real id like any fresh solve.
   */
  private materialise(gcId: string, mint = true): Promise<SolveMade> {
    const have = this.realOf.get(gcId);
    if (have) return Promise.resolve({ ok: true, solId: have, session: this.solOwner.get(have) ?? "primary" });
    const pending = this.matPending.get(gcId);
    if (pending) return pending;
    // the prefetch joins a materialisation, it never starts one (customNode) — nor a second one after a failed first
    if (!mint) return Promise.resolve({ ok: false, status: 0, error: "speculative read of a stored tree skipped — its solve was not created" });
    const key = keyOfStoredSolId(gcId);
    // (declared first: the body compares against it once its POSTs are back, to see whether a forget replaced it)
    let p!: Promise<SolveMade>;
    p = (async (): Promise<SolveMade> => {
      const stored = this.cache.treeBody(key);
      if (!stored || stored.kind !== "post") {
        return { ok: false, status: 410, error: `the solve cache no longer holds tree ${key.slice(0, 8)} (${this.cache.enabled ? "evicted" : "the cache is off"}) — ask again to solve it afresh` };
      }
      const seats = Array.isArray(stored.tree?.players) ? stored.tree.players.length : 2;
      tmark(`GTO Wizard stored tree ${key.slice(0, 8)} materialised`, "a node the solve cache does not hold — creating its solve (tree + solution)");
      const made = await this.postCustomSolution(stored.tree, stored.solution, { multiway: seats > 2 }, this.matAvoid.get(gcId) ?? []);
      this.matAvoid.delete(gcId);
      if (!made.ok) return made;
      // the real solve is a solve like any other: its owner, its age for the readiness probe, its replies stored
      this.noteSolKey(made.solId, key);
      this.registerSolve(made.solId, made.session, seats);
      this.cache.noteMaterialised(key);
      // …and it stands for the stored tree unless a 429 reroute forgot this materialisation while it was in flight
      if (this.matPending.get(gcId) === p) {
        this.realOf.set(gcId, made.solId);
        this.solOwner.set(gcId, made.session);
        if (this.realOf.size > READY_SET_MAX) this.realOf.delete(this.realOf.keys().next().value as string);
      }
      return made;
    })().finally(() => { if (this.matPending.get(gcId) === p) this.matPending.delete(gcId); });
    this.matPending.set(gcId, p);
    const waiters = this.matWaiters.get(gcId);
    if (waiters) { this.matWaiters.delete(gcId); for (const w of [...waiters]) w(); }
    return p;
  }

  private async customNodeFetch(solId: string, q: NodeQuery, timeoutMs: number, caller?: string, repostMs?: number): Promise<NodeFetchResult> {
    if (isStoredSolId(solId)) {
      // the node's own budget starts once the solve exists — as for a tree created afresh, whose POSTs come before it
      const m = await this.materialise(solId, caller !== "prefetch");
      if (!m.ok) return m;
      return this.fetchOnSolve(m.solId, q, timeoutMs, caller, repostMs);
    }
    return this.fetchOnSolve(solId, q, timeoutMs, caller, repostMs);
  }

  /** A node of a real solve: the readiness probe for the chain's single-street shape, then the poll. */
  private async fetchOnSolve(solId: string, q: NodeQuery, timeoutMs: number, caller?: string, repostMs?: number): Promise<NodeFetchResult> {
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    // anything but the chain's single-street shape keeps the old behaviour: poll until a strategy or the timeout
    if (!streetRooted(q)) return this.pollNode(solId, q, t0, deadline, "legacy", caller, repostMs);
    // THE HEDGE TRIGGER IS THE SOLVE'S AGE (2026-10-14, live check of the hedge: the hang landed on the readiness probe the
    // PREFETCH had started, the walk merely joined it and never saw a hang — so no hedge). A walk read (`repostMs` set) of
    // a solve that has run for POLL_HANG_MS without serving its root, with a cold tree's cost still on its clock, comes
    // back `hung` at that moment whichever read owns the probe; the probe runs on (the solve is still being polled — the
    // caller's hedge reads it again and joins it). A solve this process did not create is aged from this read's start.
    const hangAt = (this.solCreatedAt.get(solId) ?? t0) + pollHangMs();
    while (!this.solReady.has(solId)) {
      let probe = this.solProbe.get(solId);
      const mine = !probe;
      if (!probe) {
        probe = this.probeSolution(solId, q.board, deadline, caller, repostMs).finally(() => this.solProbe.delete(solId));
        this.solProbe.set(solId, probe);
      } else {
        tmark(`GTO Wizard node [${q.riverActions ?? q.turnActions ?? q.flopActions ?? "root"}] waits for the solve's readiness probe`, `solution ${solId.slice(0, 8)}`);
      }
      // a probe another read started runs on ITS clock; this read waits no longer than its own (the hung-poll bound) —
      // and a walk read waits no longer than the solve's hang age (above)
      const until = repostMs != null ? Math.min(deadline, Math.max(hangAt, Date.now() + 1)) : deadline;
      const late = (): NodeFetchResult => ({ ok: false, status: 504, error: `AI solve timed out — the solve's readiness probe${mine ? "" : " (another read's)"} did not answer within this read's ${(timeoutMs / 1000).toFixed(1)} s` });
      const pr = mine && repostMs == null ? await probe : await within(probe, until - Date.now(), late);
      if (this.solReady.has(solId)) {
        if (isRootQuery(q)) return pr.ok ? { ...pr, solveSecs: (Date.now() - t0) / 1000, src: mine ? "fetched" : "joined" } : pr;
        break;
      }
      if (!pr.ok && (pr as { hung?: boolean }).hung) return pr;   // the probe's own poll hung with time to re-post: as before
      if (repostMs != null && !pr.ok && Date.now() >= hangAt) {
        const left = deadline - Date.now();
        const owner = this.solOwner.get(solId) ?? "?";
        const age = ((Date.now() - (this.solCreatedAt.get(solId) ?? t0)) / 1000).toFixed(1);
        if (left >= repostMs) {
          console.log(`[gtow-hung] ${owner} solve ${solId.slice(0, 8)} not served after ${age} s, ${(left / 1000).toFixed(1)} s left on the read — hedged on another account (a cold ${this.solSeats.get(solId) ?? "?"}-seat tree needs ~${(repostMs / 1000).toFixed(1)} s)`);
          tmark("GTO Wizard solve slow", `${owner} solve ${solId.slice(0, 8)} not served after ${age} s — hedged on another account`);
          return { ok: false, status: 0, hung: true, error: `GTO Wizard solve hung on ${owner} (not served after ${age} s) — ${(left / 1000).toFixed(1)} s left, hedged on another account` };
        }
        if (Date.now() >= deadline) return pr;
        // too little left to hedge: wait for the probe to the clock, as before
        const rest = mine ? await probe : await within(probe, deadline - Date.now(), late);
        if (this.solReady.has(solId)) { if (isRootQuery(q)) return rest.ok ? { ...rest, solveSecs: (Date.now() - t0) / 1000, src: mine ? "fetched" : "joined" } : rest; break; }
        if (rest.ok || rest.status !== 504 || Date.now() >= deadline) return rest;
        continue;
      }
      // The probe ran on ITS creator's deadline. The chain's speculative prefetch fires first, with 6 s, and the
      // live walk (12 s) joins it — so a probe that merely timed out must not fail a caller who still has time:
      // that caller starts a fresh probe. A wall, a lost token or anything else ends every waiter alike.
      if (pr.ok || pr.status !== 504 || Date.now() >= deadline) return pr;
    }
    return this.pollNode(solId, q, t0, deadline, "ready", caller, repostMs);
  }

  /** Poll a solve's street root until it answers (not before FIRST_POLL_MS after the solve was created). A 200 of any
   *  kind means the solve is served; it is marked ready and the root node cached like any other. */
  private async probeSolution(solId: string, board: string, deadline: number, caller?: string, repostMs?: number): Promise<NodeFetchResult> {
    const created = this.solCreatedAt.get(solId);
    const wait = created != null ? created + FIRST_POLL_MS - Date.now() : 0;
    if (wait > 0) await new Promise((res) => setTimeout(res, Math.min(wait, Math.max(0, deadline - Date.now()))));
    return this.pollNode(solId, { board }, Date.now(), deadline, "until-ready", caller, repostMs);
  }

  /**
   * The poll loop. `legacy` and `until-ready` keep polling through 204s (the solve is running); `until-ready` also
   * marks the solve ready on the first 200. `ready` knows the solve is served, so an empty answer (204, or a 200
   * without action_solutions) gets NO_NODE_GRACE retries and is then reported as a missing node (status 204).
   */
  private async pollNode(solId: string, q: NodeQuery, t0: number, deadline: number, mode: "legacy" | "until-ready" | "ready", caller?: string, repostMs?: number): Promise<NodeFetchResult> {
    const key = nodeKeyOf(solId, q);
    const line = q.riverActions ?? q.turnActions ?? q.flopActions ?? "";
    const line0 = () => line || "root";
    let empties = 0;
    const markReady = () => {
      gtowSessions.noteSolveReady(solId);   // routing: this solve no longer runs on its account (every mode)
      if (mode === "legacy") return;
      this.solReady.add(solId);
      if (this.solReady.size > READY_SET_MAX) this.solReady.delete(this.solReady.values().next().value as string);
    };
    // every verdict about the solve itself goes to the persistent store too, under the tree's key (a solve created
    // with the cache on has one — services/gtowSolveCache); a timeout, a wall or a lost token never does
    const ck = this.cache.enabled ? this.solKey.get(solId) ?? null : null;
    const noNode = (): NodeFetchResult => {
      if (ck) this.cache.putNode(ck, addrOf(q), NO_NODE, null);
      return { ok: false, status: 204,
        error: `no decision node at [${line || "root"}] — the solve is ready and this line has none (it closes the street or ends the hand)` };
    };

    const params = new URLSearchParams({
      custom_solution_id: solId,
      preflop_actions: "",
      flop_actions: q.flopActions ?? "",
      turn_actions: q.turnActions ?? "",
      river_actions: q.riverActions ?? "",
      board: q.board,
    });
    let lastErr = "the cloud didn't return a strategy in time";
    // WHAT THE POLLS SAID (2026-10-03, the postflop twin of the preflop fix b633a50): the timeout used to report the
    // first failure it kept ("poll request failed: timed out") though every later poll had answered 204 — read as a
    // network fault when the solve was simply slow, or the node missing. Counted, and the reason says so.
    const said = { notReady: 0, failed: 0, empty: 0 };
    // ONE AUTH ROUND PER READ (services/gtowAuth): the first auth refusal refreshes the token and polls again at once;
    // a later one (the refreshed token refused too) ends the read with the auth reason — never as a verdict on the line
    let authRound: AuthRound | null = null;
    // The solve lives on the account that minted it: poll it with THAT
    // session's token, never whichever token happens to be freshest. A solve with no recorded owner (none minted in this
    // process) is pinned to ONE account for the whole read (2026-10-08): with least-loaded routing the "best" account
    // can change between two polls, and a solve polled with another account's token 404s.
    let owner = this.solOwner.get(solId) ?? null;
    if (!owner) owner = (await within(gtowSessions.bestToken(), deadline - Date.now(), () => null))?.id ?? null;
    const hangMs = pollHangMs();
    const timedOutErr = (e: unknown) => /timed? ?out|abort/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));
    while (Date.now() < deadline) {
      // the token read is bounded by the read's clock too: an expired token is a CDP sniff (up to 15 s)
      const token = owner ? await within(gtowSessions.tokenFor(owner), deadline - Date.now(), () => null) : null;
      if (!token) {
        if (Date.now() >= deadline) break;
        return { ok: false, status: 0, error: `No access token for the session that owns this solve${owner ? ` (${owner})` : ""} — is it still running with its debug port?` };
      }
      // PER-REQUEST BOUND (2026-10-08, the hung-poll bound): the read's REMAINING clock, capped at POLL_HANG_MS — computed
      // when the request goes (an auth retry goes later and gets what is left then). A poll used to get 8 s whatever was
      // left, which is how a 15 s read ended at 19 s.
      let r: Response;
      // the ledger learns what this poll was for: the readiness probe, a read of a served solve, the grace retry of an
      // empty answer, or the old loop — with that, a hand's 204s can be told apart later (solving vs no such node)
      const pm = mode === "legacy" ? "legacy" : mode === "until-ready" ? "probe" : empties ? "retry" : "node";
      let reqMs = hangMs;
      const poll = (tok: string, retry: boolean) => {
        reqMs = Math.max(1, Math.min(hangMs, deadline - Date.now()));
        return gtowRequests.fetch(owner, "poll", `${API_BASE}/v4/solutions/spot-solution/?${params}`, {
          headers: { Authorization: `Bearer ${tok}` },
          signal: AbortSignal.timeout(reqMs),
        }, { pm, cl: caller ?? null, ...(retry ? { nt: NT_AUTH_RETRY } : {}) });
      };
      let sent: Awaited<ReturnType<typeof sendWithAuthRetry>>;
      try {
        // the refresh fits the read's own clock: its deadline, less a second for the retry itself
        sent = authRound ? { res: await poll(token, false), auth: null, token }
          : await sendWithAuthRetry(owner, "poll", token, poll, Math.min(authRefreshBudgetMs(), deadline - Date.now() - AUTH_RETRY_RESERVE_MS));
      } catch (e) {
        lastErr = `poll request failed: ${e instanceof Error ? e.message : e}`;
        said.failed++;
        // A HUNG POLL: no reply within the full POLL_HANG_MS (not merely cut by the read's clock). When the caller can
        // re-post the tree on another account inside what is left (repostMs: a cold tree's cost), say so at once.
        const hung = reqMs >= hangMs && timedOutErr(e);
        if (hung) {
          const left = deadline - Date.now();
          const line = `${owner ?? "?"} poll of solution ${solId.slice(0, 8)} [${line0()}] hung ${(hangMs / 1000).toFixed(1)} s, ${(Math.max(0, left) / 1000).toFixed(1)} s left on the read`;
          if (repostMs != null && left >= repostMs) {
            console.log(`[gtow-hung] ${line} — the tree is re-posted on another account (a cold ${this.solSeats.get(solId) ?? "?"}-seat tree needs ~${(repostMs / 1000).toFixed(1)} s)`);
            tmark("GTO Wizard poll hung", `${line} — re-post on another account`);
            return { ok: false, status: 0, hung: true, error: `GTO Wizard poll hung on ${owner ?? "the owning account"} (no reply in ${(hangMs / 1000).toFixed(1)} s) — ${(left / 1000).toFixed(1)} s left, the tree is re-posted on another account` };
          }
          console.log(`[gtow-hung] ${line} — ${repostMs != null ? `too little left to re-post (a cold tree needs ~${(repostMs / 1000).toFixed(1)} s): polling on` : "polling on (no re-post for this read)"}`);
          tmark("GTO Wizard poll hung", line);
          if (caller !== "prefetch") tstepDetail("poll hung — re-asking");
        }
        if (Date.now() >= deadline) break;
        await new Promise((res) => setTimeout(res, Math.min(CUSTOM_SOLVE_POLL_MS, Math.max(0, deadline - Date.now()))));
        continue;
      }
      r = sent.res;
      if (sent.auth) authRound = sent.auth;
      if (sent.auth && !sent.auth.recovered) {
        gtowSessions.noteAuthFailure(owner, sent.token, sent.auth.detail);
        return { ok: false, status: 401, error: authFailedReason(sent.auth) };
      }
      if (authRound && !sent.auth && r.status !== 204 && !r.ok) {
        // a later poll of this read refused for auth again, after the round: no second refresh
        const b = await r.clone().text().catch(() => "");
        if (isAuthFailure(r.status, b)) {
          gtowSessions.noteAuthFailure(owner, token, refusalDetail(b));
          return { ok: false, status: 401, error: authFailedReason({ ...authRound, retryStatus: r.status, recovered: false }) };
        }
      }
      if (r.ok && r.status !== 204) {
        // read as text, then parsed: the store keeps the reply exactly as GTO Wizard sent it
        const text = await r.text().catch(() => "");
        let j: any = null;
        try { j = text ? JSON.parse(text) : null; } catch { j = null; }
        markReady();                                   // any 200 means the solve is being served
        if (j?.action_solutions?.length) {
          this.rememberNode(key, j);
          if (ck) this.cache.putNode(ck, addrOf(q), NODE_OK, text);
          return { ok: true, data: j, solveSecs: (Date.now() - t0) / 1000, cached: false, src: "fetched" };
        }
        said.empty++;
        // a 200 with no decision: nothing to wait for once the solve is served
        if (mode !== "legacy" && ++empties > NO_NODE_GRACE) return noNode();
      } else if (r.status === 204) {
        said.notReady++;
        if (mode === "ready" && ++empties > NO_NODE_GRACE) return noNode();
      } else if (!r.ok) {
        const body = (await r.text().catch(() => "")).slice(0, 120);
        lastErr = `spot-solution ${r.status}: ${body}`;
        said.failed++;
        // a wall hit mid-poll is worth recording: the NEXT tree goes elsewhere
        if (owner && r.status !== 404) gtowSessions.noteFailure(owner, r.status, body);
        // …and a QUOTA wall will not lift while we wait (2026-09-22: the stress run sat out a whole timeout on a
        // 429). Return at once, flagged, so the caller can re-create the tree on another account (forgetSolution).
        if (r.status === 429 || (r.status === 403 && /limit|quota|exceed/i.test(body))) {
          return { ok: false, status: 429, error: lastErr };
        }
        // A 400 / 422 IS GTO WIZARD'S VERDICT ON THE QUERY (NODE_DOES_NOT_EXIST, VALIDATION_ERROR): polling it again
        // until the deadline only spent requests and the clock (2026-10-03). Returned at once, as the 400 it is. An AUTH
        // refusal never gets here (2026-10-08): "Invalid API Key" is a VALIDATION_ERROR 400 too, and it was read as this
        // verdict — sendWithAuthRetry above refreshed the token and polled again, or the read ended with the auth reason.
        if (r.status === 400 || r.status === 422) return { ok: false, status: r.status, error: lastErr };
      }
      await new Promise((res) => setTimeout(res, Math.min(CUSTOM_SOLVE_POLL_MS, Math.max(0, deadline - Date.now()))));
    }
    const polls = said.notReady + said.failed + said.empty;
    const tally = `${polls} poll${polls === 1 ? "" : "s"}: ${said.notReady} answered 204 (not solved yet)` +
      `${said.empty ? `, ${said.empty} answered with no decision` : ""}, ${said.failed} failed${said.failed ? ` (last: ${lastErr})` : ""}`;
    return { ok: false, status: 504, error: `AI solve timed out on ${owner ?? "the GTO Wizard session"} — ${polls ? tally : lastErr} (that account may have hit its daily solution limit, or the client lost connection).` };
  }

  /**
   * AI-solve a spot with CUSTOM ranges — the exploit path. Creates (or reuses) a
   * custom tree + solution for the tree params, then polls the shared
   * spot-solution endpoint by `custom_solution_id` at the requested node until
   * the cloud solve lands (~2s). Returns the same JSON shape as `spotSolution`.
   * Both layers cache, since every fresh call otherwise mints a new custom
   * solution on the account.
   *
   * `opts.noCache` keeps the persistent solve cache out of it (services/gtowSolveCache): the poller's startup probe
   * and the pool-routing check exist to reach GTO Wizard, and a stored answer would make them pass without doing so.
   * `stored` says the answer came from the persistent cache (tree, node or both) — no request was sent for it.
   */
  async customSolve(
    input: CustomSolveInput,
    opts: CacheOpts = {}
  ): Promise<{ ok: true; customSolutionId: string; solveSecs: number; cached: boolean; data: any; session: GtowSessionId; stored?: boolean } | { ok: false; status: number; error: string }> {
    const ens = await this.ensureCustomSolution(input, opts);
    if (!ens.ok) return ens;
    const node = await this.customNode(ens.solId, {
      flopActions: input.flopActions,
      turnActions: input.turnActions,
      riverActions: input.riverActions,
      board: input.queryBoard ?? input.board,
    }, undefined, undefined, opts);
    if (!node.ok) return node;
    return { ok: true, customSolutionId: ens.solId, solveSecs: node.solveSecs, cached: node.cached, data: node.data, session: ens.session,
      ...(ens.stored || node.store ? { stored: true } : {}) };
  }

  /** The persistent solve cache's statistics (GET /api/gtow/cache). */
  solveCacheStats() {
    return this.cache.stats();
  }
}

/** Where a node's JSON came from: the process cache, a poll another request already had in flight, or our own poll. */
export type NodeSource = "cache" | "joined" | "fetched";

/**
 * What a tree is keyed on, reduced to numbers a log line can compare (2026-09-24). The key itself holds the
 * full 1326-weight ranges; a fingerprint keeps each range's total weight and live-combo count, which is enough
 * to say "the OOP range changed" without printing it.
 */
export interface TreeFingerprint {
  board: string;
  street: string;
  seats: number;
  /** the real table positions in acting order ("SB-BB-CO"), not just a count (2026-09-24). A 4+ way flop is
   *  solved as SEVERAL concurrent trees for different collapse plans (multiwayCollapse.ts) — different real
   *  seats merged or dropped, same board/street/seat-COUNT. Without the positions in the key, the second plan's
   *  first-ever tree compared against the first plan's and reported a fictitious "range changed", when the two
   *  are unrelated trees for different players (hand 4919957671: "OOP+1 range changed 8.97→465.66" was walk 2's
   *  BB+CO merge compared against walk 1's BB alone — not a re-solve of the same tree with drifted ranges). */
  posKey: string;
  pot: number;
  stack: number;
  /** each seat's own stack in the tree, acting order (2026-10-03) */
  stacks: number[];
  /** the street's pinned sizes: the wagers played as amounts ("R9.4bb by OOP"), or the % pins of older callers */
  fixedLevels: string[] | null;
  rake: string;
  huGrid: string | null;
  /** per seat in acting order: [sum of weights, combos with weight > 0] */
  ranges: [number, number][];
}

export function treeFingerprint(input: CustomTreeInput): TreeFingerprint {
  const street = input.startingStreet ?? "FLOP";
  const fp = (r: number[]): [number, number] => {
    let sum = 0, live = 0;
    for (const w of r) { if (w > 0) { sum += w; live++; } }
    return [Math.round(sum * 100) / 100, live];
  };
  const seats = [input.oopRange, ...(input.mid ? [input.mid.range] : []), input.ipRange];
  const fixedBet = input.fixedBets?.[street];
  const names = input.mid ? ["OOP", "OOP+1", "IP"] : ["OOP", "IP"];
  const played = input.played?.[street];
  return {
    board: input.board, street, seats: seats.length,
    posKey: [input.oopPos ?? "?", input.mid?.pos, input.ipPos ?? "?"].filter(Boolean).join("-"),
    pot: input.pot, stack: input.stack, stacks: treeStacksOf(input),
    fixedLevels: played?.length ? played.map((w) => `${bbAmount(w.to)} by ${names[w.seat] ?? `seat${w.seat}`}`)
      : input.fixedLevels?.[street]?.length ? input.fixedLevels[street]!.slice() : fixedBet != null ? [`${fixedBet}%`] : null,
    rake: JSON.stringify(input.rake ?? null), huGrid: input.huGrid ? JSON.stringify(input.huGrid) : menuTagsOf(input).join(" ") || null,
    ranges: seats.map(fp),
  };
}

/**
 * Why a tree had to be created: the first for its board/street in this process, or what changed since the last
 * one. "stack 69.28→67.88" is the dealt-stack drift that cost hand 140706500001 its flop tree on the turn; "fixed
 * sizes null→[100%]" is the expected re-create after a wager on a street solved AUTOMATIC before it.
 */
export function describeTreeChange(prev: TreeFingerprint | null, next: TreeFingerprint): string {
  if (!prev) return `first ${next.street} tree for ${next.board} in this process`;
  const d: string[] = [];
  if (prev.pot !== next.pot) d.push(`pot ${prev.pot}→${next.pot}`);
  if (prev.stack !== next.stack) d.push(`stack ${prev.stack}→${next.stack}`);
  const sk = (x: number[] | undefined) => (x ?? []).join("/");
  if (prev.stack === next.stack && sk(prev.stacks) !== sk(next.stacks)) d.push(`seat stacks ${sk(prev.stacks) || "?"}→${sk(next.stacks)}`);
  const fl = (x: string[] | null) => (x ? `[${x.join(",")}]` : "null");
  if (fl(prev.fixedLevels) !== fl(next.fixedLevels)) d.push(`fixed sizes ${fl(prev.fixedLevels)}→${fl(next.fixedLevels)}`);
  if (prev.rake !== next.rake) d.push(`rake ${prev.rake}→${next.rake}`);
  if (prev.huGrid !== next.huGrid) d.push(`grid ${prev.huGrid ?? "auto"}→${next.huGrid ?? "auto"}`);
  const names = next.seats === 3 ? ["OOP", "OOP+1", "IP"] : ["OOP", "IP"];
  next.ranges.forEach((r, i) => {
    const p = prev.ranges[i];
    if (!p) return;
    if (p[0] !== r[0] || p[1] !== r[1]) d.push(`${names[i] ?? `seat${i}`} range changed (weight ${p[0]}→${r[0]}, live combos ${p[1]}→${r[1]})`);
  });
  if (!d.length) return "re-created with an IDENTICAL fingerprint — the exact key still differed (a range weight below the fingerprint's rounding, or the cache was cleared)";
  return `re-created: ${d.join(", ")}`;
}

/**
 * Bet grid for a 3-player tree's wager-free streets (see buildCustomTree). Two bets and one raise size keep
 * the cloud solve in the same 3-5 s band as heads-up (probed 2026-09-19: root 3.5 s, nodes 1.3-3.1 s);
 * a street that DID see a wager is pinned to the observed sizes instead, exactly as heads-up.
 * Since 2026-10-08 this is menu B: the three-way default is menu C below (THREEWAY_MENU); B is also the heads-up
 * HU_FIXED_MENU=b menu and the fallback list of the AUTOMATIC (HU_FIXED_MENU=off) rules.
 */
export const THREE_WAY_SIZES = { bet: ["33%", "75%"], raise: ["60%"] } as const;

/**
 * THE HEADS-UP FIXED MENU (2026-10-08, Brady "fix 3"; register `postflop-size-menu`). A heads-up tree used to leave every
 * seat that had not wagered on the street AUTOMATIC: GTO Wizard chose its sizes, a different menu per tree. The re-tree
 * carry (retree-consistency) then carried whatever `auto` returned first — stress core-bvb-007 turn: tree A offered hero
 * CHECK / BET 20.5 (a lone ~137% bet), he checked Q8 100% and later folded it 98% to a half-pot bet; with a 25% bet on
 * the menu he bets it 99.6%. Across 52 re-run core hands 22 mixes moved ≥10 points and 12 top actions flipped only
 * because the carried auto menu differed from a fresh one. Now the heads-up menu is ours, + each seat's all-in, on every
 * street of every heads-up answer-path tree. Identical tables send identical trees (one body per table state).
 *
 * MENU F (2026-10-08 evening, Brady: "is there anything wrong with just doing F?" — the menu study, memory menu-study,
 * poker-data/audits/menu-study-hu-2026-10-08.txt): bets 25 / 33 / 50 / 75 / 100 / 125 / 150% and raises 60 / 100% at
 * every level, every unforced street, both seats. Best EV of the six menus on every street (mean loss 0.017% pot vs B's
 * 0.068%, at the yardstick's own noise floor), no re-tree on any stability spot, cold solve 1.3 s median (flop 1.9 s),
 * first node max 6.6 s. B (33/75 | 60) failed the turn and river: facing a bet only a 60% raise exists where ~100% is
 * wanted, and no overbet on a polarized river (core-real-4921729477). 8 entries with the all-in, under GTO Wizard's
 * 10-entry list cap (capSizeList). A % bet past a seat's stack is GTO Wizard's all-in (one node, no refusal: seen in
 * the live cache, 33/75 trees where 75% of the pot was more than the stack).
 * HU_FIXED_MENU = f (unset, the default) | b (33/75 | 60, the menu of fada815) | off (the AUTOMATIC rules, the request
 * byte for byte as e50e3b8). "on" (the old value) and anything else = f. Read at every tree.
 */
export const HU_FIXED_SIZES = THREE_WAY_SIZES;
export const HU_MENU_F = { bet: ["25%", "33%", "50%", "75%", "100%", "125%", "150%"], raise: ["60%", "100%"] } as const;
/** in the tree key of a heads-up tree on menu B (unchanged since fada815, so a B tree keeps its key) */
export const HU_FIXED_MENU_TAG = "hu-fixed:33/75|60";
/** in the tree key of a heads-up tree on menu F */
export const HU_MENU_F_TAG = "hu-fixed:F 25/33/50/75/100/125/150|60/100";
export type HuMenuMode = "f" | "b" | "off";
export const huMenuMode = (env: Record<string, string | undefined> = process.env): HuMenuMode => {
  const v = String(env.HU_FIXED_MENU ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "b" ? "b" : "f";
};
export const huFixedMenuOn = (env: Record<string, string | undefined> = process.env): boolean => huMenuMode(env) !== "off";
/** The heads-up fixed menu applies to this tree: heads-up, no explicit grid (the collapse-calibration harness), switch not off. */
export const huFixedMenuApplies = (input: Pick<CustomTreeInput, "mid" | "huGrid">): boolean =>
  !input.mid && !input.huGrid && huFixedMenuOn();
/** The heads-up menu's sizes as listed (% of the pot; MENU_POT says what is actually sent). */
export const huMenuSizes = (env: Record<string, string | undefined> = process.env): { bet: readonly string[]; raise: readonly string[] } =>
  (huMenuMode(env) === "f" ? HU_MENU_F : HU_FIXED_SIZES);
/** The heads-up menu's key tag for this tree, or null when the fixed menu does not apply. */
export const huMenuTag = (input: Pick<CustomTreeInput, "mid" | "huGrid">): string | null =>
  (huFixedMenuApplies(input) ? (huMenuMode() === "f" ? HU_MENU_F_TAG : HU_FIXED_MENU_TAG) : null);

/**
 * THE THREE-WAY MENU (2026-10-08 evening, Brady: "for 3 way I'm ok with doing C, we just need to be within the 15 second
 * cap, I approve"). Menu C = FLOP bets 25 / 75 / 125%, TURN and RIVER bets 33 / 75 / 125%, raises 60% (+ each seat's
 * all-in) on every unforced street of a 3-player tree. THE 25% FLOP (follow-up measured the same evening, Brady approved
 * the test): on the 6 three-way flop spots 25/75/125 cuts the flop loss from 0.091% to 0.015% of the pot (worst 0.225%
 * -> 0.108%), first node 5.3 s median / 11.9 s max, no tree over 15 s, stability TV 0.002; turn and river are C's exactly.
 * Cost: fewer pool flop bets land on 25/75/125 than on 33/75/125 (12% vs 28% on the post-rake pot), so more three-way
 * flop re-trees — each one more ~5 s tree, and the carry keeps them stable. Study (memory menu-study, poker-data/audits/menu-study-3way-2026-10-08.txt, 15 spots): mean loss 0.035%
 * pot (B 0.047%), cold solve 5.5 s median, 2 of 15 trees past 12 s, worst first node 13.4 s (core-srp-3way-001 deep flop,
 * idle machine) — hence the three-way node clock of 15 s (postflopNodeTimeoutMs). F is not possible three-way
 * (TREE_IS_TOO_BIG on 9 of 15). A 4+-way flop collapsed to three seats IS a 3-player tree here (buildCustomTree cannot
 * tell them apart), so it takes the same menu; one collapsed to two seats takes the heads-up menu.
 * THREEWAY_MENU = c (unset, the default) | b (33/75 | 60, the menu before) | off (= b: a 3-player tree cannot be
 * AUTOMATIC). Read at every tree.
 */
export const THREE_WAY_MENU_C = { flopBet: ["25%", "75%", "125%"], bet: ["33%", "75%", "125%"], raise: ["60%"] } as const;
/** in the tree key of a 3-player tree on menu C (a B tree carries no tag: its key is unchanged) */
export const THREE_WAY_MENU_C_TAG = "3way:C flop 25/75/125 turn+river 33/75/125|60";
export type ThreeWayMenuMode = "c" | "b";
export const threeWayMenuMode = (env: Record<string, string | undefined> = process.env): ThreeWayMenuMode => {
  const v = String(env.THREEWAY_MENU ?? "").trim().toLowerCase();
  return v === "b" || v === "off" ? "b" : "c";
};
/** The three-way menu's sizes on `street` (C's bet list is the flop's or the turn / river one; B is one list). */
export const threeWaySizes = (street: "FLOP" | "TURN" | "RIVER" = "TURN", env: Record<string, string | undefined> = process.env): { bet: readonly string[]; raise: readonly string[] } =>
  (threeWayMenuMode(env) === "c" ? { bet: street === "FLOP" ? THREE_WAY_MENU_C.flopBet : THREE_WAY_MENU_C.bet, raise: THREE_WAY_MENU_C.raise } : THREE_WAY_SIZES);
/** The three-way menu's key tag for this tree, or null (heads-up, or menu B). */
export const threeWayMenuTag = (input: Pick<CustomTreeInput, "mid">): string | null =>
  (input.mid && threeWayMenuMode() === "c" ? THREE_WAY_MENU_C_TAG : null);

/**
 * MENU SIZES ON THE POT AFTER RAKE (2026-10-08 evening, Brady: "Sure put menu sizes on pot after rake"). The pool sizes its
 * bets on the pot NET of Ignition's rake (menu study, coverage pass over 14,208 Ignition NL100-500 hands / 7,033 pool
 * wagers: the modes are 32.5 / 50 / 75 / 100% of the net pot = 47.5 / 71.3% of the gross pot). GTO Wizard takes a size
 * list as % of the GROSS pot it is sent, so our 75% (gross) and the pool's 75% (of net, 71.25% gross) were 5.3% apart —
 * past the walk's 5% / 0.15bb tolerance — and every such bet re-treed the street. Now each BET size s% of our menus is
 * sent as s × (pot_net / pot_gross), to a tenth of a percent (GTO Wizard takes "71.3%"; a tenth of a percent of the pot is
 * far inside the matcher's 5% of the amount), where pot_net = pot − min(rake% × pot, cap) with the rake THIS TREE is
 * solved with (input.rake, else DEFAULT_TREE_RAKE: on the live path the table's 5% and its cap by players dealt). So the
 * menu's 75% is the pool's 75%: its node's AMOUNT is what a pool 75%-of-net bet comes to, and the walk's matcher
 * (matchActionLoose, which compares AMOUNTS, never percentages) lands it without a re-tree — matcher and menu speak the
 * same convention by construction (gtowApi.menus.test.ts).
 *  - WHICH POT: the pot at the tree's starting street (`pot`). Every street hero is answered on is the starting street of
 *    its own tree (aiChain builds one tree per street), so that street is exact. The later streets of a tree
 *    (continuation only) take the same factor: exact on the line that checks through, and below the rake cap (pots under
 *    cap / 5%: 40bb at NL200 with six dealt) the factor is 0.95 at every pot; past the cap a bigger later pot is raked a
 *    smaller share, so those later-street sizes are up to ~5% small — never on the street being answered.
 *  - PREFLOP: no flop, no drop — a hand that ends preflop is not raked, so a preflop pot has nothing to take off and its
 *    sizes stay as they are (the preflop trees, services/gtowAiPreflop, and the charts are untouched). Every tree built
 *    here starts on the flop or later, where the flop has been dealt and the rake WILL be taken from the final pot: the
 *    pool's buttons size on the pot after it, so the conversion applies to every street of these trees.
 *  - RAISES are NOT converted: the coverage pass found the pool's raises do not follow the net pot (heads-up flop raises
 *    on F: 18.8% land with the gross convention, 16.5% with net; turn 28.9 -> 25.8). Played amounts (bb), the street-root
 *    pins (fixedBets / fixedLevels: the table's real sizes), an explicit huGrid and the AUTOMATIC rules
 *    (HU_FIXED_MENU=off) are never converted.
 * MENU_POT = net (unset, the default) | gross (the sizes as listed, the request before). Read at every tree; the key
 * carries MENU_POT_NET_TAG only where a converted menu is sent.
 */
export const MENU_POT_NET_TAG = "menu-pot:net";
export type MenuPotMode = "net" | "gross";
export const menuPotMode = (env: Record<string, string | undefined> = process.env): MenuPotMode =>
  (String(env.MENU_POT ?? "").trim().toLowerCase() === "gross" ? "gross" : "net");
/** The menu is sent on the net pot for this tree: switch net, and a fixed menu of ours applies (three-way or the
 *  heads-up fixed menu; never an explicit grid or the AUTOMATIC rules). */
export const menuOnNetPot = (input: Pick<CustomTreeInput, "mid" | "huGrid">): boolean =>
  menuPotMode() === "net" && !input.huGrid && (!!input.mid || huFixedMenuApplies(input));
/** pot_net / pot_gross for a pot raked `rake` (pct_of_pot, capped at cap_in_chips, both in the tree's units = bb). */
export function netPotFactor(pot: number, rake: { pct_of_pot: number; cap_in_chips: number } | null | undefined): number {
  if (!(pot > 0) || !rake) return 1;
  const pct = Number(rake.pct_of_pot) || 0;
  const cap = Number(rake.cap_in_chips);
  const taken = Math.min((pct / 100) * pot, Number.isFinite(cap) && cap >= 0 ? cap : Infinity);
  return taken > 0 ? (pot - taken) / pot : 1;
}
/** A bet list's % sizes as sent on the net pot: s × factor, to a tenth of a percent; amounts ("9.4bb") as they are. */
export function onNetPot(list: readonly string[], factor: number): string[] {
  if (factor === 1) return list.slice();
  return list.map((x) => {
    const m = /^(\d+(?:\.\d+)?)%$/.exec(x);
    if (!m) return x;
    // half a tenth rounds up (the epsilon keeps 143.25 from reading as 143.2499999 in floating point)
    return `${Math.round(Number(m[1]) * factor * 10 + 1e-6) / 10}%`;
  });
}

/**
 * GTO WIZARD'S SIZE-LIST CAP (menu study 2026-10-08): every size list (bet / raise / second / third+) may hold at most 10
 * entries INCLUDING the all-in — 11 is refused (422 too_long), and the refusal comes at the FIRST POLL, after the tree and
 * the solution were accepted (3 requests spent). Menu F is 8 with the all-in; the re-tree carry adds the played sizes, so
 * a list with three played sizes at one level would be refused. RULE: past the cap, drop the menu size(s) NEAREST a
 * played size (by amount), one at a time — never a played size, never the all-in (the last entry); with no played size
 * in the list, the size nearest the all-in. Three-way the same (one fixedOf for both). api.log `[menu-cap]`.
 */
/** The menu tags in a tree's key (and fingerprint): the heads-up menu's, menu C's, the net pot's — each only where it
 *  applies, so with HU_FIXED_MENU=b, THREEWAY_MENU=b and MENU_POT=gross the key is fada815's byte for byte. */
export const menuTagsOf = (input: Pick<CustomTreeInput, "mid" | "huGrid">): string[] =>
  [huMenuTag(input), threeWayMenuTag(input), menuOnNetPot(input) ? MENU_POT_NET_TAG : null].filter((x): x is string => !!x);

export const GTOW_SIZE_LIST_MAX = 10;
export function capSizeList(list: readonly string[], played: readonly string[], toBb: (x: string) => number | null, max = GTOW_SIZE_LIST_MAX): { list: string[]; dropped: string[] } {
  const out = list.slice();
  const dropped: string[] = [];
  const isPlayed = (x: string) => played.includes(x);
  while (out.length > max) {
    const allIn = out[out.length - 1]!;
    const anchors = out.filter(isPlayed).map(toBb).filter((v): v is number => v != null && Number.isFinite(v));
    const ref = anchors.length ? anchors : [toBb(allIn) ?? Infinity];
    let best = -1, bestD = Infinity;
    out.forEach((x, k) => {
      if (k === out.length - 1 || isPlayed(x)) return;
      const v = toBb(x);
      if (v == null || !Number.isFinite(v)) return;
      const d = Math.min(...ref.map((a) => Math.abs(a - v)));
      if (d < bestD) { bestD = d; best = k; }
    });
    if (best < 0) break;   // only played sizes and the all-in left: nothing of ours to drop
    dropped.push(out.splice(best, 1)[0]!);
  }
  return { list: out, dropped };
}
const menuCapLogged = new Set<string>();
/** one api.log line per distinct cut (buildCustomTree runs several times per tree: key, peek, summary, POST) */
function logMenuCap(line: string): void {
  if (menuCapLogged.has(line)) return;
  menuCapLogged.add(line);
  if (menuCapLogged.size > 500) menuCapLogged.delete(menuCapLogged.values().next().value as string);
  console.log(line);
}

/**
 * THE POSTFLOP NODE CLOCK (CUSTOM_SOLVE_TIMEOUT_MS = 12 s: how long one walk's node read — the solve's first poll
 * included — may take before the decision is given up; counted from the read's start, after the tree and solution
 * POSTs). THREE-WAY 15 s since 2026-10-08 (menu C: worst cold first node 13.4 s on an idle machine, 11.8 s of it the
 * solve — 0.2 s inside 12 s; Brady: "we just need to be within the 15 second cap"). Heads-up stays 12 s.
 * THREEWAY_NODE_TIMEOUT_MS = 15000 (unset, the default) | a number of ms | off (= 12000, the clock before).
 */
export const threeWayNodeTimeoutMs = (env: Record<string, string | undefined> = process.env): number => {
  const raw = String(env.THREEWAY_NODE_TIMEOUT_MS ?? "").trim().toLowerCase();
  if (raw === "off") return CUSTOM_SOLVE_TIMEOUT_MS;
  const v = Number(raw);
  return raw && v > 0 ? v : 15_000;
};
/** The walk's node-read clock for a tree of `seats` seats. */
export const postflopNodeTimeoutMs = (seats: number, env: Record<string, string | undefined> = process.env): number =>
  (seats >= 3 ? threeWayNodeTimeoutMs(env) : CUSTOM_SOLVE_TIMEOUT_MS);

/**
 * THE TREE SETTINGS, EXPLICIT AND OFF (2026-10-03, Brady: "I don't want any weird sort of settings sent"). What was
 * sent before was never chosen (it came with the first tree builder): `allin_threshold: 60` REPLACED a pinned bet of
 * 60%+ of the stack by the all-in (2026-09-30: a 9.4 bet walked as ALLIN 14.2, an 18.8 as ALLIN 26.2),
 * `allin_if_less_than: 500` ADDED an all-in beside the sizes listed, `merge_sizes_threshold: 10` collapsed sizes near
 * each other. Off, the tree holds exactly the sizes listed — and the all-in where it is listed (buildCustomTree). The
 * preflop tree (services/gtowAiPreflop) sends the same.
 */
export const TREE_SETTINGS = { allin_threshold: 100, allin_if_less_than: 0, merge_sizes_threshold: 0 } as const;
/** in every tree key: a tree built under other settings is never taken for one built under these */
export const TREE_SETTINGS_TAG = "allin-listed:100/0/0";

/** A size as the API takes an AMOUNT: "<bb>bb", to the cent ("9.4bb", "28bb", "8.75bb"). A bare number is a 422. */
export const bbAmount = (x: number): string => `${Math.round(x * 100) / 100}bb`;

/** Each seat's stack in the tree, acting order: its own (`stacks`), else the one `stack` for every seat. */
export function treeStacksOf(input: Pick<CustomTreeInput, "stack" | "stacks" | "mid">): number[] {
  const n = input.mid ? 3 : 2;
  return Array.from({ length: n }, (_, i) => {
    const v = input.stacks?.[i];
    return v != null && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : input.stack;
  });
}
/** Each seat's all-in, acting order: its own stack, capped at the deepest other seat's (nobody can call more). */
export function seatAllIns(stacks: number[]): number[] {
  return stacks.map((s, i) => {
    const others = stacks.filter((_, j) => j !== i);
    return Math.round(Math.min(s, others.length ? Math.max(...others) : s) * 100) / 100;
  });
}

/** One wager played on a street, in order: the seat (index in acting order) and its raise-to amount on the street (bb).
 *  Its level is its index in the street's list (0 = the bet, 1 = the raise over it, 2 = the re-raise, 3+ beyond). */
export interface PlayedWager { seat: number; to: number }

/**
 * ONE SEAT'S MENU CARRIED INTO A RE-TREE (2026-10-08, Brady: "one tree; if we need to re-tree, from the original tree up
 * to the point of disagreement capture EVERYTHING including menu bet sizes, recreate the new tree with the same details,
 * add the bet size we didn't have, and loop" — services/aiChain.retreeInputs). `lists` = bet / raise / second raise /
 * third+ raise, as the API takes them. from "sent": the earlier tree sent this seat FIXED — carried exactly (a null
 * list stays null: GTO Wizard's min-raise + all-in there, as before). from "resolved": the earlier tree had the seat
 * AUTOMATIC and these are the sizes GTO Wizard chose at that tree's nodes — a bet as its amount, a raise as GTO Wizard's
 * % of the pot (its betsize_by_pot, the % a FIXED list takes: probed in the cache, "60%" → 0.6); null = a level the
 * earlier tree's nodes never showed (buildCustomTree fills it).
 */
export interface CarriedSeat { from: "sent" | "resolved"; lists: (string[] | null)[] }
/** The menus a re-tree carries on its starting street, one entry per seat in acting order (null = as before: AUTOMATIC
 *  unless the seat wagered). Heads-up and three-way (a three-seat tree's seats are all FIXED: carried as sent). Part of the tree key. */
export interface CarriedMenus { street: "FLOP" | "TURN" | "RIVER"; seats: (CarriedSeat | null)[] }

/** The rake a custom tree gets when its input carries none: GTO Wizard's own NL500 structure, 5% capped at 0.6bb.
 *  The chain passes the table's rake on the Ignition 6-max and CoinPoker heads-up strategies; a solve without one
 *  is solved at this, and the hand page says so rather than "no rake" (2026-09-24). */
export const DEFAULT_TREE_RAKE = { pct_of_pot: 5, cap_in_chips: 0.6, preflop_rake_type: null } as const;

export interface CustomTreeInput {
  board: string; // concatenated, e.g. "Ts7h2d"
  pot: number; // bb
  stack: number; // effective, bb — every seat's stack when `stacks` is absent
  /** EACH SEAT'S OWN STACK behind at the tree's starting street, in acting order (OOP, [OOP+1], IP) — 2026-10-03. A seat
   *  missing (or not a positive number) takes `stack`. Part of the tree key. */
  stacks?: number[];
  /** THE WAGERS PLAYED on a street, as amounts (2026-10-03): the street is pinned to exactly these (see buildCustomTree).
   *  Takes precedence over fixedLevels / fixedBets for that street. Part of the tree key. */
  played?: Partial<Record<"FLOP" | "TURN" | "RIVER", PlayedWager[]>>;
  /** 1326-weight ranges (see buildRangeArray). */
  oopRange: number[];
  ipRange: number[];
  oopPos?: string;
  ipPos?: string;
  /** A THIRD seat (2026-09-19, Ultra): the middle player of a 3-way flop, GTO Wizard's "OOP+1". Present ⇒ a
   *  3-player tree, which the API accepts only with FIXED sizes on every street (THREE_WAY_SIZES on a
   *  wager-free street). Absent ⇒ the heads-up tree exactly as before. Its stack is `stacks[1]` (else `stack`). */
  mid?: { pos: string; range: number[] };
  startingStreet?: "FLOP" | "TURN" | "RIVER";
  rake?: { pct_of_pot: number; cap_in_chips: number; preflop_rake_type: string | null };
  /** Pin each street's bets to an exact % of pot (solve villain's exact sizes). */
  fixedBets?: Partial<Record<"FLOP" | "TURN" | "RIVER", number>>;
  /** Pin a street's bets PER RAISE LEVEL (["33%","120%"] = bet 33% pot, raise
   *  120% pot) — how ai-study solves lines containing arbitrary user sizes. */
  fixedLevels?: Partial<Record<"FLOP" | "TURN" | "RIVER", string[]>>;
  /** A multi-size FIXED grid for heads-up wager-free streets instead of AUTOMATIC
   *  (e.g. {bet:["33%","75%","150%"], raise:["55%","100%"]}). Part of the tree key. */
  huGrid?: { bet: readonly string[]; raise: readonly string[] };
  /** A RE-TREE'S CARRIED MENUS (2026-10-08, retree-consistency): the starting street's per-seat menus from the tree hero
   *  was answered on, the played size added (see CarriedMenus). Heads-up or three-way, with `played` on the same street. */
  carry?: CarriedMenus | null;
  /** Diagnostic only (2026-09-24, aiChain.AiChainSpec.planTag) — which concurrent collapse plan this tree belongs
   *  to, so the tree-miss "why" doesn't compare two unrelated plans' trees to each other. NEVER part of treeKey(). */
  planTag?: string | null;
}

/** Tree params plus the node to query within it. */
export interface CustomSolveInput extends CustomTreeInput {
  flopActions?: string;
  turnActions?: string;
  riverActions?: string;
  /** Full board (incl. turn/river) for the spot-solution QUERY, when the tree
   *  starts earlier than the queried node (defaults to `board`). */
  queryBoard?: string;
}

export const gtowApi = new GtowApi();
export { GtowApi };
