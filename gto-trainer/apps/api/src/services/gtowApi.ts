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

import { gtowSessions, type GtowNeed, type GtowSessionId } from "./gtowSessions";
// EVERY request to api.gtowizard.com goes through the ledger (2026-09-23): GTO Wizard caps REQUESTS, not
// solves, and a poll loop is many requests — see services/gtowRequestLog.ts.
import { gtowRequests } from "./gtowRequestLog";
import { tmark } from "./answerTrace";
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
const NO_NODE_GRACE = 1;
const READY_SET_MAX = 2_000;

/** `store`: served from the persistent solve cache (services/gtowSolveCache) — no request was sent for it */
type NodeFetchResult = { ok: true; data: any; solveSecs: number; cached: boolean; src: NodeSource; store?: boolean } | { ok: false; status: number; error: string; store?: boolean };
type NodeQuery = { flopActions?: string; turnActions?: string; riverActions?: string; board: string };
/** `noCache`: neither read nor write the persistent solve cache — a check that must reach GTO Wizard (the poller's
 *  startup probe, the pool-routing script). The in-process caches still apply, as they always have. */
export interface CacheOpts { noCache?: boolean }
type SolveMade = { ok: true; solId: string; session: GtowSessionId; stored?: boolean } | { ok: false; status: number; error: string };
type EnsureResult = { ok: true; solId: string; created: boolean; session: GtowSessionId; why?: string; stored?: boolean } | { ok: false; status: number; error: string };

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
   * Fetch a spot solution. Returns the parsed JSON on success. On a 401 the
   * token is re-sniffed once and the call retried. `null` means the API/client
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
      // one re-sniff per session: a token that went stale between the keeper's
      // tick and this call is the common 401, not a signed-out account
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await gtowSessions.tokenFor(id, attempt === 1);
        if (!token) { last = { status: 0, error: `${id}: no access token` }; break; }
        let res: Response;
        try {
          res = await gtowRequests.fetch(id, "library", url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12_000) });
        } catch (e) {
          last = { status: 0, error: `${id}: ${e instanceof Error ? e.message : e}` };
          break;
        }
        if (res.status === 401 && attempt === 0) continue;
        if (!res.ok) {
          const body = (await res.text().catch(() => "")).slice(0, 200);
          // 404 means this SPOT has no library solution — every account would
          // say the same, so don't burn the pool walking to the next one.
          if (res.status === 404) return { ok: false, status: 404, error: body };
          gtowSessions.noteFailure(id, res.status, body, need);
          last = { status: res.status, error: body };
          break;
        }
        gtowSessions.noteSuccess(id);
        return { ok: true, data: await res.json() };
      }
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
    const fixedOf = (i: number, lists: (readonly string[] | null)[]) => {
      const o: Record<string, unknown> = { position: seats[i]!, type: "FIXED" as const, use_fixed_sizes: true, allow_limp: false };
      LISTS.forEach((k, lv) => { o[k] = lists[lv] == null ? null : withAllIn(i, lists[lv]!); });
      return o;
    };
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
    const threeWay = (i: number) => fixedOf(i, [THREE_WAY_SIZES.bet, THREE_WAY_SIZES.raise, THREE_WAY_SIZES.raise, THREE_WAY_SIZES.raise]);
    // A multi-size FIXED grid for a heads-up wager-free street (2026-09-19): the alternative to AUTOMATIC, opt-in per
    // tree (huGrid; the collapse-calibration harness).
    const grid = (i: number, g: { bet: readonly string[]; raise: readonly string[] }) => fixedOf(i, [g.bet, g.raise, g.raise, g.raise]);
    /** a street with wagers played: the levels as amounts (see the header) */
    const playedStreet = (ws: PlayedWager[]) => {
      const lvAmt = (lv: number): string[] => {
        const xs = ws.filter((_, k) => (lv < 3 ? k === lv : k >= 3)).map((w) => bbAmount(w.to));
        return xs.length ? [...new Set(xs)] : [];
      };
      const playedBy = (i: number, lv: number) => ws.some((w, k) => w.seat === i && (lv < 3 ? k === lv : k >= 3));
      if (input.mid || input.huGrid) {
        const base = input.huGrid ? { bet: input.huGrid.bet, raise: input.huGrid.raise } : THREE_WAY_SIZES;
        const lists = [0, 1, 2, 3].map((lv) => { const a = lvAmt(lv); return a.length ? a : lv === 0 ? base.bet : base.raise; });
        return seats.map((_, i) => fixedOf(i, lists));
      }
      return seats.map((_, i) => {
        // AUTOMATIC ON PURPOSE — Brady's decision, 2026-10-03: the seat that has not wagered on the street is AUTOMATIC
        // even where that means no all-in at its node (probed: GTO Wizard's automatic sizing decides whether to offer
        // one, `add_allin` does not change it, and the 3 nodes measured that lost it had played the all-in 0%). The
        // "all-in stays where it was" rule of the 2026-10-03 brief (item 8) does NOT apply to AUTOMATIC seats. Do not
        // make this seat FIXED to get the all-in back: a FIXED seat's null raise list is the min-raise, not GTO Wizard's
        // size, and a listed one is a size we chose.
        if (!ws.some((w) => w.seat === i)) return auto(i);
        const lists: (readonly string[] | null)[] = [lvAmt(0), null, null, null];
        for (const lv of [1, 2, 3]) {
          if (playedBy(i, lv)) lists[lv] = ws.filter((w, k) => w.seat === i && (lv < 3 ? k === lv : k >= 3)).map((w) => bbAmount(w.to));
          // GTO Wizard copies the list sent for the level below into a null second / third list: keep it null only
          // when the level below went null too, else give the base raise list
          else if (lv >= 2 && lists[lv - 1] != null) lists[lv] = THREE_WAY_SIZES.raise;
        }
        return fixedOf(i, lists);
      });
    };
    const fb = input.fixedBets;
    const fl = input.fixedLevels;
    const pl = input.played;
    const street = (s: "FLOP" | "TURN" | "RIVER") =>
      pl && pl[s]?.length
        ? { street: s, position_bet_sizes: playedStreet(pl[s]!) }
        : fl && fl[s]?.length
          ? { street: s, position_bet_sizes: seats.map((_, i) => fixedPerLevel(i, fl[s]!)) }
          : fb && fb[s] != null
            ? { street: s, position_bet_sizes: seats.map((_, i) => fixed(i, `${fb[s]}%`)) }
            : input.mid
              ? { street: s, position_bet_sizes: seats.map((_, i) => threeWay(i)) }
              : input.huGrid
                ? { street: s, position_bet_sizes: seats.map((_, i) => grid(i, input.huGrid!)) }
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
  private async createCustomSolution(input: CustomTreeInput, opts: CacheOpts = {}): Promise<SolveMade> {
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
    const made = await this.postCustomSolution(body, solution, { multiway: Boolean(input.mid) });
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
  private async postCustomSolution(body: unknown, solution: { actions: string; board: string }, need: GtowNeed): Promise<SolveMade> {
    // Every wall we record is a GUESS about what the API meant. A wrong quota
    // guess would otherwise disable multiway until the next daily reset, so
    // when nothing is routable we still try the walled sessions rather than
    // failing the spot outright — the same last-ditch rule bestToken uses.
    const ids = gtowSessions.route(need);
    const candidates = gtowSessions.liveFirst(ids.length ? ids : gtowSessions.routeIgnoringBlocks(need));
    if (!candidates.length) return noSession(need);
    let last: { status: number; error: string } | null = null;
    for (const id of candidates) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await gtowSessions.tokenFor(id, attempt === 1);
        if (!token) { last = { status: 0, error: `${id}: no access token` }; break; }
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

        // 1. create the tree (bounded — an unbounded fetch here hung whole
        // solves when the API stalled; nothing upstream can cancel it)
        let treeRes: Response;
        try {
          treeRes = await gtowRequests.fetch(id, "tree", `${API_BASE}/v4/custom-solutions/custom-trees/`, {
            method: "POST", headers, body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (e) { last = { status: 0, error: `${id}: custom-trees ${e instanceof Error ? e.message : e}` }; break; }
        if (treeRes.status === 401 && attempt === 0) continue;
        if (!treeRes.ok) {
          const msg = (await treeRes.text().catch(() => "")).slice(0, 180);
          gtowSessions.noteFailure(id, treeRes.status, msg, need);
          last = { status: treeRes.status, error: `custom-trees: ${msg}` };
          break; // next session
        }
        const tree = await treeRes.json();
        const treeId = tree.id ?? tree.custom_tree_id ?? tree.uuid;
        if (!treeId) return { ok: false, status: 502, error: "custom-trees returned no id" };

        // 2. create the solution
        let solRes: Response;
        try {
          solRes = await gtowRequests.fetch(id, "solution", `${API_BASE}/v4/custom-solutions/`, {
            method: "POST", headers, body: JSON.stringify({ custom_tree_id: treeId, actions: solution.actions, board: solution.board }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (e) { last = { status: 0, error: `${id}: custom-solutions ${e instanceof Error ? e.message : e}` }; break; }
        if (!solRes.ok) {
          const msg = (await solRes.text().catch(() => "")).slice(0, 180);
          gtowSessions.noteFailure(id, solRes.status, msg, need);
          last = { status: solRes.status, error: `custom-solutions: ${msg}` };
          break; // next session
        }
        const sol = await solRes.json();
        const solId = sol.id ?? sol.custom_solution_id ?? sol.uuid;
        if (!solId) return { ok: false, status: 502, error: "custom-solutions returned no id" };
        gtowSessions.noteSuccess(id, { tree: true });
        return { ok: true, solId: String(solId), session: id };
      }
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
  /** speculative reads (the chain's prefetch) waiting for someone to materialise a stored tree — see customNode */
  private matWaiters = new Map<string, Set<() => void>>();
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

  async ensureCustomSolution(input: CustomTreeInput, opts: CacheOpts = {}): Promise<EnsureResult> {
    const key = this.treeKey(input);
    const hit = this.treeSolCache.get(key);
    // (a check that must reach GTO Wizard never takes a stored tree, not even one this process already handed out)
    if (hit && !(opts.noCache && isStoredSolId(hit))) {
      return { ok: true, solId: hit, created: false, session: this.solOwner.get(hit) ?? (isStoredSolId(hit) ? CACHE_SESSION : "primary"),
        ...(isStoredSolId(hit) ? { stored: true } : {}) };
    }
    const pending = this.treePending.get(key);
    if (pending) return pending.then((r) => (r.ok ? { ...r, created: false, why: `joined a solve another request started (${r.why ?? "same tree"})` } : r));
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
        return { ok: true, solId: made.solId, created: false, session: made.session, stored: true,
          why: `served from the persistent solve cache — no request (the in-process cache did not hold it: ${why})` };
      }
      this.solOwner.set(made.solId, made.session);
      this.solCreatedAt.set(made.solId, Date.now());
      if (this.solCreatedAt.size > READY_SET_MAX) this.solCreatedAt.delete(this.solCreatedAt.keys().next().value as string);
      return { ok: true as const, solId: made.solId, created: true, session: made.session, why };
    })().finally(() => this.treePending.delete(key));
    this.treePending.set(key, p);
    return p;
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
    opts: CacheOpts = {}
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
        return this.readThrough(solId, q, key, Math.max(0, timeoutMs - (Date.now() - t0)), caller);
      }
    }
    return this.readThrough(solId, q, key, timeoutMs, caller);
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
  private readThrough(solId: string, q: NodeQuery, key: string, timeoutMs: number, caller: string | undefined): Promise<NodeFetchResult> {
    const pending = this.nodePending.get(key);
    if (pending) {
      // the same node is already being polled by another request (a warm-up, another panel) — share it. The wait
      // is recorded because the other request's polls are in ITS trace, not this one's: without this line a
      // joined poll is a hole in the timeline.
      const node = q.riverActions ?? q.turnActions ?? q.flopActions ?? "";
      tmark(`GTO Wizard node [${node || "root"}] joined another request's poll`, `solution ${solId.slice(0, 8)}`);
      return pending.then((r) => (r.ok ? { ...r, src: "joined" as const } : r));
    }
    const p = this.customNodeFetch(solId, q, timeoutMs, caller).finally(() => this.nodePending.delete(key));
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
      const made = await this.postCustomSolution(stored.tree, stored.solution, { multiway: seats > 2 });
      if (!made.ok) return made;
      // the real solve is a solve like any other: its owner, its age for the readiness probe, its replies stored
      this.noteSolKey(made.solId, key);
      this.solOwner.set(made.solId, made.session);
      this.solCreatedAt.set(made.solId, Date.now());
      if (this.solCreatedAt.size > READY_SET_MAX) this.solCreatedAt.delete(this.solCreatedAt.keys().next().value as string);
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

  private async customNodeFetch(solId: string, q: NodeQuery, timeoutMs: number, caller?: string): Promise<NodeFetchResult> {
    if (isStoredSolId(solId)) {
      // the node's own budget starts once the solve exists — as for a tree created afresh, whose POSTs come before it
      const m = await this.materialise(solId, caller !== "prefetch");
      if (!m.ok) return m;
      return this.fetchOnSolve(m.solId, q, timeoutMs, caller);
    }
    return this.fetchOnSolve(solId, q, timeoutMs, caller);
  }

  /** A node of a real solve: the readiness probe for the chain's single-street shape, then the poll. */
  private async fetchOnSolve(solId: string, q: NodeQuery, timeoutMs: number, caller?: string): Promise<NodeFetchResult> {
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    // anything but the chain's single-street shape keeps the old behaviour: poll until a strategy or the timeout
    if (!streetRooted(q)) return this.pollNode(solId, q, t0, deadline, "legacy", caller);
    while (!this.solReady.has(solId)) {
      let probe = this.solProbe.get(solId);
      const mine = !probe;
      if (!probe) {
        probe = this.probeSolution(solId, q.board, deadline, caller).finally(() => this.solProbe.delete(solId));
        this.solProbe.set(solId, probe);
      } else {
        tmark(`GTO Wizard node [${q.riverActions ?? q.turnActions ?? q.flopActions ?? "root"}] waits for the solve's readiness probe`, `solution ${solId.slice(0, 8)}`);
      }
      const pr = await probe;
      if (this.solReady.has(solId)) {
        if (isRootQuery(q)) return pr.ok ? { ...pr, solveSecs: (Date.now() - t0) / 1000, src: mine ? "fetched" : "joined" } : pr;
        break;
      }
      // The probe ran on ITS creator's deadline. The chain's speculative prefetch fires first, with 6 s, and the
      // live walk (12 s) joins it — so a probe that merely timed out must not fail a caller who still has time:
      // that caller starts a fresh probe. A wall, a lost token or anything else ends every waiter alike.
      if (pr.ok || pr.status !== 504 || Date.now() >= deadline) return pr;
    }
    return this.pollNode(solId, q, t0, deadline, "ready", caller);
  }

  /** Poll a solve's street root until it answers (not before FIRST_POLL_MS after the solve was created). A 200 of any
   *  kind means the solve is served; it is marked ready and the root node cached like any other. */
  private async probeSolution(solId: string, board: string, deadline: number, caller?: string): Promise<NodeFetchResult> {
    const created = this.solCreatedAt.get(solId);
    const wait = created != null ? created + FIRST_POLL_MS - Date.now() : 0;
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    return this.pollNode(solId, { board }, Date.now(), deadline, "until-ready", caller);
  }

  /**
   * The poll loop. `legacy` and `until-ready` keep polling through 204s (the solve is running); `until-ready` also
   * marks the solve ready on the first 200. `ready` knows the solve is served, so an empty answer (204, or a 200
   * without action_solutions) gets NO_NODE_GRACE retries and is then reported as a missing node (status 204).
   */
  private async pollNode(solId: string, q: NodeQuery, t0: number, deadline: number, mode: "legacy" | "until-ready" | "ready", caller?: string): Promise<NodeFetchResult> {
    const key = nodeKeyOf(solId, q);
    const line = q.riverActions ?? q.turnActions ?? q.flopActions ?? "";
    let empties = 0;
    const markReady = () => {
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
    let refreshed = false;
    // The solve lives on the account that minted it: poll it with THAT
    // session's token, never whichever token happens to be freshest.
    const owner = this.solOwner.get(solId) ?? null;
    while (Date.now() < deadline) {
      const token = owner ? await gtowSessions.tokenFor(owner) : await this.accessToken();
      if (!token) return { ok: false, status: 0, error: `No access token for the session that owns this solve${owner ? ` (${owner})` : ""} — is it still running with its debug port?` };
      // per-request bound: the loop's wall-clock ceiling can't fire while a
      // single fetch hangs inside it — a timed-out poll just retries
      let r: Response;
      // the ledger learns what this poll was for: the readiness probe, a read of a served solve, the grace retry of an
      // empty answer, or the old loop — with that, a hand's 204s can be told apart later (solving vs no such node)
      const pm = mode === "legacy" ? "legacy" : mode === "until-ready" ? "probe" : empties ? "retry" : "node";
      try {
        r = await gtowRequests.fetch(owner, "poll", `${API_BASE}/v4/solutions/spot-solution/?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8_000),
        }, { pm, cl: caller ?? null });
      } catch (e) {
        lastErr = `poll request failed: ${e instanceof Error ? e.message : e}`;
        said.failed++;
        await new Promise((res) => setTimeout(res, CUSTOM_SOLVE_POLL_MS));
        continue;
      }
      if (r.status === 401 && !refreshed) { refreshed = true; if (owner) await gtowSessions.tokenFor(owner, true); else await this.accessToken(true); continue; }
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
        // until the deadline only spent requests and the clock (2026-10-03). Returned at once, as the 400 it is.
        if (r.status === 400 || r.status === 422) return { ok: false, status: r.status, error: lastErr };
      }
      await new Promise((res) => setTimeout(res, CUSTOM_SOLVE_POLL_MS));
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
    rake: JSON.stringify(input.rake ?? null), huGrid: input.huGrid ? JSON.stringify(input.huGrid) : null,
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
 */
export const THREE_WAY_SIZES = { bet: ["33%", "75%"], raise: ["60%"] } as const;

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
