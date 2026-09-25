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
    ]);
  }

  buildCustomTree(input: CustomTreeInput) {
    // Seats in acting order. A third seat makes it GTO Wizard's 3-player tree ("OOP+1" between the two).
    const seats: string[] = input.mid ? ["OOP", "OOP+1", "IP"] : ["OOP", "IP"];
    const auto = (position: string) => ({ position, type: "AUTOMATIC" as const, allow_limp: false });
    // FIXED sizing pins a street's bets to an exact % of pot (validated format:
    // bet_sizes:["90%"]). Used to solve the villain's EXACT off-tree bet when the
    // nearest library size is too far to snap (see snapToken τ). Applies to every
    // seat on that street; the string list is what the API expects.
    const fixed = (position: string, pct: string) => ({
      position, type: "FIXED" as const, use_fixed_sizes: true, allow_limp: false,
      bet_sizes: [pct], raise_sizes: [pct], second_raise_sizes: [pct], third_plus_raise_sizes: [pct],
    });
    // Per-raise-level FIXED sizing: lv[0] pins the street's first bet, lv[1]
    // the raise over it, lv[2] the re-raise, lv[3]+ beyond. Levels past the
    // supplied list fall back to the last given pct — they only shape the
    // (rarely reached) deeper raise war, not the studied line itself.
    const fixedPerLevel = (position: string, lv: string[]) => {
      const at = (i: number) => lv[Math.min(i, lv.length - 1)] ?? "50%";
      return {
        position, type: "FIXED" as const, use_fixed_sizes: true, allow_limp: false,
        bet_sizes: [at(0)], raise_sizes: [at(1)],
        second_raise_sizes: [at(2)], third_plus_raise_sizes: [at(3)],
      };
    };
    // A 3-player tree is FIXED on every street or the API refuses it (422 "Dynamic/Automatic sizings is
    // currently not supported for 3+ players", probed 2026-09-19), so a wager-free street gets this grid
    // where a heads-up tree would get AUTOMATIC.
    const threeWay = (position: string) => ({
      position, type: "FIXED" as const, use_fixed_sizes: true, allow_limp: false,
      bet_sizes: THREE_WAY_SIZES.bet, raise_sizes: THREE_WAY_SIZES.raise,
      second_raise_sizes: THREE_WAY_SIZES.raise, third_plus_raise_sizes: THREE_WAY_SIZES.raise,
    });
    // A multi-size FIXED grid for a heads-up wager-free street (2026-09-19): the
    // alternative to AUTOMATIC, which lets the engine pick ONE size per node
    // (hand 4919174586: a 300%-pot river bet as the only bet). Opt-in per
    // tree (huGrid); the chain decides whether to use it.
    const grid = (position: string, g: { bet: readonly string[]; raise: readonly string[] }) => ({
      position, type: "FIXED" as const, use_fixed_sizes: true, allow_limp: false,
      bet_sizes: [...g.bet], raise_sizes: [...g.raise],
      second_raise_sizes: [...g.raise], third_plus_raise_sizes: [...g.raise],
    });
    const fb = input.fixedBets;
    const fl = input.fixedLevels;
    const street = (s: "FLOP" | "TURN" | "RIVER") =>
      fl && fl[s]?.length
        ? { street: s, position_bet_sizes: seats.map((p) => fixedPerLevel(p, fl[s]!)) }
        : fb && fb[s] != null
          ? { street: s, position_bet_sizes: seats.map((p) => fixed(p, `${fb[s]}%`)) }
          : input.mid
            ? { street: s, position_bet_sizes: seats.map(threeWay) }
            : input.huGrid
              ? { street: s, position_bet_sizes: seats.map((p) => grid(p, input.huGrid!)) }
              : { street: s, position_bet_sizes: seats.map(auto) };
    const player = (position: string, display: string, range: number[]) => ({
      position, display_position: display, blind: null, range, stack: input.stack,
      tournament_instant_bounty: null, tournament_total_bounty: null,
    });
    return {
      starting_street: input.startingStreet ?? "FLOP",
      pot: input.pot,
      ante: null,
      ante_distribution_method: "PER_PLAYER",
      bet_sizes: {
        allin_threshold: 60,
        allin_if_less_than: 500,
        merge_sizes_threshold: 10,
        max_num_raises: 5,
        street_bet_sizes: [street("FLOP"), street("TURN"), street("RIVER")],
      },
      players: [
        player("OOP", input.oopPos ?? "BB", input.oopRange),
        ...(input.mid ? [player("OOP+1", input.mid.pos, input.mid.range)] : []),
        player("IP", input.ipPos ?? "CO", input.ipRange),
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
  private async createCustomSolution(
    input: CustomTreeInput
  ): Promise<{ ok: true; solId: string; session: GtowSessionId } | { ok: false; status: number; error: string }> {
    // POSTFLOP: heads-up belongs to the Elite account, multiway to Ultra.
    // `preflop` is deliberately absent — that flag is the preflop piece's
    // (services/gtowAiPreflop.ts), and it is what sends preflop to Ultra.
    const need: GtowNeed = { multiway: Boolean(input.mid) };
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
            method: "POST", headers, body: JSON.stringify(this.buildCustomTree(input)),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (e) { last = { status: 0, error: `${id}: custom-trees ${e instanceof Error ? e.message : e}` }; break; }
        if (treeRes.status === 401 && attempt === 0) continue;
        if (!treeRes.ok) {
          const body = (await treeRes.text().catch(() => "")).slice(0, 180);
          gtowSessions.noteFailure(id, treeRes.status, body, need);
          last = { status: treeRes.status, error: `custom-trees: ${body}` };
          break; // next session
        }
        const tree = await treeRes.json();
        const treeId = tree.id ?? tree.custom_tree_id ?? tree.uuid;
        if (!treeId) return { ok: false, status: 502, error: "custom-trees returned no id" };

        // 2. create the solution
        let solRes: Response;
        try {
          solRes = await gtowRequests.fetch(id, "solution", `${API_BASE}/v4/custom-solutions/`, {
            method: "POST", headers, body: JSON.stringify({ custom_tree_id: treeId, actions: "", board: input.board }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (e) { last = { status: 0, error: `${id}: custom-solutions ${e instanceof Error ? e.message : e}` }; break; }
        if (!solRes.ok) {
          const body = (await solRes.text().catch(() => "")).slice(0, 180);
          gtowSessions.noteFailure(id, solRes.status, body, need);
          last = { status: solRes.status, error: `custom-solutions: ${body}` };
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
  private treePending = new Map<string, Promise<{ ok: true; solId: string; created: boolean; session: GtowSessionId; why?: string } | { ok: false; status: number; error: string }>>();
  private nodePending = new Map<string, Promise<{ ok: true; data: any; solveSecs: number; cached: boolean } | { ok: false; status: number; error: string }>>();

  /**
   * Drop a solution from the tree cache — used when the account that owns it hits its daily wall mid-walk, so
   * the next ensureCustomSolution re-creates the SAME tree on an account that can still be polled.
   */
  forgetSolution(solId: string): void {
    for (const [k, v] of this.treeSolCache) if (v === solId) this.treeSolCache.delete(k);
  }

  /** The solution this process already holds for these tree params, or null — a cache lookup, never a request. */
  peekSolution(input: CustomTreeInput): string | null {
    return this.treeSolCache.get(this.treeKey(input)) ?? null;
  }

  /** A node already in the cache, or null — never a request. (Does not count as a hit for the LRU.) */
  peekNode(solId: string, q: { flopActions?: string; turnActions?: string; riverActions?: string; board: string }): any | null {
    return this.nodeCache.get(JSON.stringify([solId, q.flopActions ?? "", q.turnActions ?? "", q.riverActions ?? "", q.board])) ?? null;
  }

  async ensureCustomSolution(
    input: CustomTreeInput
  ): Promise<{ ok: true; solId: string; created: boolean; session: GtowSessionId; why?: string } | { ok: false; status: number; error: string }> {
    const key = this.treeKey(input);
    const hit = this.treeSolCache.get(key);
    if (hit) return { ok: true, solId: hit, created: false, session: this.solOwner.get(hit) ?? "primary" };
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
    const p = (async () => {
      const made = await this.createCustomSolution(input);
      if (!made.ok) return made;
      this.treeSolCache.set(key, made.solId);
      this.solOwner.set(made.solId, made.session);
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
    timeoutMs = CUSTOM_SOLVE_TIMEOUT_MS
  ): Promise<{ ok: true; data: any; solveSecs: number; cached: boolean; src: NodeSource } | { ok: false; status: number; error: string }> {
    const key = JSON.stringify([solId, q.flopActions ?? "", q.turnActions ?? "", q.riverActions ?? "", q.board]);
    const hit = this.nodeCache.get(key);
    if (hit) {
      // a hit is re-inserted so the cache is a true LRU: a hand's earlier-street nodes, read again on every
      // later decision, must outlive the burst of a multiway collapse's fresh nodes (insertion order alone
      // evicted the oldest node first, which is exactly the flop root every turn and river re-walks)
      this.nodeCache.delete(key);
      this.nodeCache.set(key, hit);
      return { ok: true, data: hit, solveSecs: 0, cached: true, src: "cache" };
    }
    const pending = this.nodePending.get(key);
    if (pending) {
      // the same node is already being polled by another request (a warm-up, another panel) — share it. The wait
      // is recorded because the other request's polls are in ITS trace, not this one's: without this line a
      // joined poll is a hole in the timeline.
      const node = q.riverActions ?? q.turnActions ?? q.flopActions ?? "";
      tmark(`GTO Wizard node [${node || "root"}] joined another request's poll`, `solution ${solId.slice(0, 8)}`);
      return pending.then((r) => (r.ok ? { ...r, src: "joined" as const } : r));
    }
    const p = this.customNodeFetch(solId, q, timeoutMs).finally(() => this.nodePending.delete(key));
    this.nodePending.set(key, p);
    return p;
  }

  private async customNodeFetch(
    solId: string,
    q: { flopActions?: string; turnActions?: string; riverActions?: string; board: string },
    timeoutMs: number
  ): Promise<{ ok: true; data: any; solveSecs: number; cached: boolean; src: NodeSource } | { ok: false; status: number; error: string }> {
    const key = JSON.stringify([solId, q.flopActions ?? "", q.turnActions ?? "", q.riverActions ?? "", q.board]);

    const params = new URLSearchParams({
      custom_solution_id: solId,
      preflop_actions: "",
      flop_actions: q.flopActions ?? "",
      turn_actions: q.turnActions ?? "",
      river_actions: q.riverActions ?? "",
      board: q.board,
    });
    const t0 = Date.now();
    let lastErr = "the cloud didn't return a strategy in time";
    let refreshed = false;
    // The solve lives on the account that minted it: poll it with THAT
    // session's token, never whichever token happens to be freshest.
    const owner = this.solOwner.get(solId) ?? null;
    while (Date.now() - t0 < timeoutMs) {
      const token = owner ? await gtowSessions.tokenFor(owner) : await this.accessToken();
      if (!token) return { ok: false, status: 0, error: `No access token for the session that owns this solve${owner ? ` (${owner})` : ""} — is it still running with its debug port?` };
      // per-request bound: the loop's wall-clock ceiling can't fire while a
      // single fetch hangs inside it — a timed-out poll just retries
      let r: Response;
      try {
        r = await gtowRequests.fetch(owner, "poll", `${API_BASE}/v4/solutions/spot-solution/?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8_000),
        });
      } catch (e) {
        lastErr = `poll request failed: ${e instanceof Error ? e.message : e}`;
        await new Promise((res) => setTimeout(res, CUSTOM_SOLVE_POLL_MS));
        continue;
      }
      if (r.status === 401 && !refreshed) { refreshed = true; if (owner) await gtowSessions.tokenFor(owner, true); else await this.accessToken(true); continue; }
      if (r.ok && r.status !== 204) {
        const j = await r.json().catch(() => null);
        if (j?.action_solutions?.length) {
          this.nodeCache.set(key, j);
          if (this.nodeCache.size > NODE_CACHE_MAX) {
            this.nodeCache.delete(this.nodeCache.keys().next().value as string);
          }
          return { ok: true, data: j, solveSecs: (Date.now() - t0) / 1000, cached: false, src: "fetched" };
        }
      } else if (!r.ok) {
        const body = (await r.text().catch(() => "")).slice(0, 120);
        lastErr = `spot-solution ${r.status}: ${body}`;
        // a wall hit mid-poll is worth recording: the NEXT tree goes elsewhere
        if (owner && r.status !== 404) gtowSessions.noteFailure(owner, r.status, body);
        // …and a QUOTA wall will not lift while we wait (2026-09-22: the stress run sat out a whole timeout on a
        // 429). Return at once, flagged, so the caller can re-create the tree on another account (forgetSolution).
        if (r.status === 429 || (r.status === 403 && /limit|quota|exceed/i.test(body))) {
          return { ok: false, status: 429, error: lastErr };
        }
      }
      await new Promise((res) => setTimeout(res, CUSTOM_SOLVE_POLL_MS));
    }
    return { ok: false, status: 504, error: `AI solve timed out on ${owner ?? "the GTO Wizard session"} — ${lastErr} (that account may have hit its daily solution limit, or the client lost connection).` };
  }

  /**
   * AI-solve a spot with CUSTOM ranges — the exploit path. Creates (or reuses) a
   * custom tree + solution for the tree params, then polls the shared
   * spot-solution endpoint by `custom_solution_id` at the requested node until
   * the cloud solve lands (~2s). Returns the same JSON shape as `spotSolution`.
   * Both layers cache, since every fresh call otherwise mints a new custom
   * solution on the account.
   */
  async customSolve(
    input: CustomSolveInput
  ): Promise<{ ok: true; customSolutionId: string; solveSecs: number; cached: boolean; data: any; session: GtowSessionId } | { ok: false; status: number; error: string }> {
    const ens = await this.ensureCustomSolution(input);
    if (!ens.ok) return ens;
    const node = await this.customNode(ens.solId, {
      flopActions: input.flopActions,
      turnActions: input.turnActions,
      riverActions: input.riverActions,
      board: input.queryBoard ?? input.board,
    });
    if (!node.ok) return node;
    return { ok: true, customSolutionId: ens.solId, solveSecs: node.solveSecs, cached: node.cached, data: node.data, session: ens.session };
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
  return {
    board: input.board, street, seats: seats.length,
    posKey: [input.oopPos ?? "?", input.mid?.pos, input.ipPos ?? "?"].filter(Boolean).join("-"),
    pot: input.pot, stack: input.stack,
    fixedLevels: input.fixedLevels?.[street]?.length ? input.fixedLevels[street]!.slice() : fixedBet != null ? [`${fixedBet}%`] : null,
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

/** Everything that defines the custom TREE (and so the cloud solve). */
/**
 * Bet grid for a 3-player tree's wager-free streets (see buildCustomTree). Two bets and one raise size keep
 * the cloud solve in the same 3-5 s band as heads-up (probed 2026-09-19: root 3.5 s, nodes 1.3-3.1 s);
 * a street that DID see a wager is pinned to the observed sizes instead, exactly as heads-up.
 */
export const THREE_WAY_SIZES = { bet: ["33%", "75%"], raise: ["60%"] } as const;

/** The rake a custom tree gets when its input carries none: GTO Wizard's own NL500 structure, 5% capped at 0.6bb.
 *  The chain passes the table's rake on the Ignition 6-max and CoinPoker heads-up strategies; a solve without one
 *  is solved at this, and the hand page says so rather than "no rake" (2026-09-24). */
export const DEFAULT_TREE_RAKE = { pct_of_pot: 5, cap_in_chips: 0.6, preflop_rake_type: null } as const;

export interface CustomTreeInput {
  board: string; // concatenated, e.g. "Ts7h2d"
  pot: number; // bb
  stack: number; // effective, bb
  /** 1326-weight ranges (see buildRangeArray). */
  oopRange: number[];
  ipRange: number[];
  oopPos?: string;
  ipPos?: string;
  /** A THIRD seat (2026-09-19, Ultra): the middle player of a 3-way flop, GTO Wizard's "OOP+1". Present ⇒ a
   *  3-player tree, which the API accepts only with FIXED sizes on every street (THREE_WAY_SIZES on a
   *  wager-free street). Absent ⇒ the heads-up tree exactly as before. Same stack as the other two. */
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
