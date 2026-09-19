/**
 * Direct client for GTO Wizard's private solution API (api.gtowizard.com).
 *
 * The endpoint `GET /v4/solutions/spot-solution/` returns the full library
 * solution for a spot — both players' ranges plus per-action strategy, EVs and
 * equity buckets — as ~500KB JSON. The only auth it needs is a short-lived
 * (~15 min) bearer ACCESS token.
 *
 * We don't hold credentials: the always-running desktop client self-refreshes,
 * so we sniff its live access token over CDP (the token rides every request's
 * Authorization header), cache it, and re-sniff on expiry or a 401. The refresh
 * token itself is single-use/rotating, so it can't be replayed out of band —
 * hence sniffing the access token rather than driving the refresh ourselves.
 *
 * This complements the local preflop DB (see services/preflopDb.ts): preflop is
 * answered locally; this reaches GTOW's HU postflop library directly, JSON in /
 * JSON out, no DOM scraping.
 */

const CDP_HOST = process.env.GTOW_CDP_HOST ?? "127.0.0.1:9222";
const API_BASE = "https://api.gtowizard.com";
const TOKEN_SKEW_MS = 60_000; // re-sniff a minute before expiry
// Zone gives ~15s per decision and the study panel needs the verdict inside
// ~10s — a solve that outlives this ceiling is useless for the decision it
// was meant to answer, so fail fast and free the poller's single flight.
const CUSTOM_SOLVE_TIMEOUT_MS = 12_000;
// Cloud solves land in ~2-5s; 1.5s polling quantized every answer up to the
// next multiple. Env-tunable so scripts/benchAiSolve.ts can sweep it.
const CUSTOM_SOLVE_POLL_MS = Number(process.env.GTOW_POLL_MS ?? 400);
const REFRESH_RETRY_MS = 10_000; // floor between token-sniff ATTEMPTS (see refreshIfExpiring)
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

class GtowApi {
  private token: string | null = null;
  private tokenExpMs = 0;

  /** Open a short-lived CDP session, provoke one authenticated request, and
   * capture its bearer token. Returns null if the client isn't reachable. */
  private async sniffToken(timeoutMs = 15_000, passiveMs = 3_500): Promise<string | null> {
    let targets: CdpTarget[];
    try {
      // Bounded: the DevTools HTTP endpoint serves one client at a time — a
      // busy/hung 9222 otherwise wedges every solve behind this fetch.
      targets = await (await fetch(`http://${CDP_HOST}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
    } catch {
      return null;
    }
    const page = targets.find((t) => t.type === "page" && /gtowizard/i.test(t.url ?? ""));
    if (!page?.webSocketDebuggerUrl) return null;

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
      const hardTimer = setTimeout(() => finish(null), timeoutMs);
      // only on an OPEN socket: the passive timer can fire before onopen, or after the client went away — ws.send then
      // throws InvalidStateError inside a timer callback, which is uncaught and took the whole API down (2026-09-11)
      const send = (method: string, params: unknown = {}) => {
        if (ws.readyState !== WebSocket.OPEN) { finish(null); return; }
        try { ws.send(JSON.stringify({ id: ++seq, method, params })); } catch { finish(null); }
      };

      // PASSIVE-FIRST: the token rides every authenticated request, and the study
      // poller drives the client constantly — so just watch its natural traffic.
      // Navigating ourselves would race the poller (both own the one client) and
      // fail. Only if nothing flies by within `passiveMs` (idle client, no poller)
      // do we nudge a request by navigating.
      const passiveTimer = setTimeout(() => {
        if (done) return;
        const s =
          "gametype=CashHu500zComplex&depth=100&solution_type=gwiz&gmfs_solution_tab=gwiz" +
          "&soltab=strategy&preflop_actions=R2.5-C&board=2c2d2h&flop_actions=X&history_spot=3";
        send("Runtime.evaluate", {
          expression: `location.href = location.origin + "/solutions?" + ${JSON.stringify(s)}`,
        });
      }, passiveMs);

      ws.onopen = () => {
        send("Network.enable");
        send("Runtime.enable");
      };
      ws.onmessage = (ev) => {
        let m: any;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
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

  // ── Proactive token keeper ────────────────────────────────────────────────
  // The sniff costs 4-8s (passive window + forced navigation), and paying it
  // inline delayed whichever unlucky solve hit the ~15-min expiry — the
  // recurring "10-second answer" spikes. Refreshing in the background keeps a
  // live token on hand so no solve ever waits on CDP.
  private keeper: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private lastRefreshAttemptMs = 0;

  startTokenKeeper(intervalMs = 30_000): void {
    if (this.keeper) return;
    this.keeper = setInterval(() => void this.refreshIfExpiring(), intervalMs);
    void this.refreshIfExpiring(); // warm the very first token at boot too
  }

  /**
   * Get a token in hand NOW rather than on the keeper's next tick. Call it the
   * moment GTO Wizard becomes reachable: the keeper can't sniff before the
   * client is up, so its 30s cadence otherwise races the first decision of the
   * session — and losing that race costs the full sniff (7.2-8.6s measured,
   * larger than any solve). No-op while the current token is healthy.
   */
  primeToken(): void {
    void this.refreshIfExpiring();
  }

  /** Sniff NOW, ignoring the attempt rate-limit — for the dashboard's Connect
   *  button, which has just (re)launched the client and is waiting on it. */
  async forceRefresh(): Promise<boolean> {
    this.lastRefreshAttemptMs = 0;
    await this.refreshIfExpiring();
    return this.hasLiveToken();
  }

  private async refreshIfExpiring(): Promise<void> {
    if (this.refreshing) return;
    // 3-min margin: two keeper ticks of slack before a solve would block.
    if (this.token && Date.now() < this.tokenExpMs - 3 * 60_000) return;
    // Rate-limit ATTEMPTS, not successes: primeToken is called from the 1s
    // poll loop, and a client that's reachable but logged out has no token to
    // find — without this it would re-sniff (and re-navigate the client) every
    // tick, forever.
    if (Date.now() - this.lastRefreshAttemptMs < REFRESH_RETRY_MS) return;
    this.lastRefreshAttemptMs = Date.now();
    this.refreshing = true;
    try {
      await this.accessToken(true);
    } finally {
      this.refreshing = false;
    }
  }

  /** True once a usable token is in hand — lets callers report readiness
   *  without forcing a sniff. */
  hasLiveToken(): boolean {
    return Boolean(this.token) && Date.now() < this.tokenExpMs - TOKEN_SKEW_MS;
  }

  /** Token keeper state for the Sources registry — no sniff, no side effects. */
  tokenStatus(): { live: boolean; expiresInMs: number | null; lastAttemptMs: number | null; keeperRunning: boolean } {
    return {
      live: this.hasLiveToken(),
      expiresInMs: this.token ? this.tokenExpMs - Date.now() : null,
      lastAttemptMs: this.lastRefreshAttemptMs || null,
      keeperRunning: this.keeper != null,
    };
  }

  /** A valid access token, cached until shortly before it expires. */
  private async accessToken(force = false): Promise<string | null> {
    if (!force && this.token && Date.now() < this.tokenExpMs - TOKEN_SKEW_MS) return this.token;
    const tok = await this.sniffToken();
    if (!tok) return null;
    this.token = tok;
    this.tokenExpMs = decodeExpMs(tok);
    return tok;
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt === 1);
      if (!token) return { ok: false, status: 0, error: "No access token (is the GTO Wizard client running with CDP on 9222?)" };
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12_000) });
      if (res.status === 401 && attempt === 0) continue; // token went stale — re-sniff and retry
      if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
      return { ok: true, data: await res.json() };
    }
    return { ok: false, status: 401, error: "Unauthorized after token refresh" };
  }

  // ── AI-solve (custom solutions) ────────────────────────────────────────────
  /** tree params → custom_solution_id, so every node of the same tree shares one cloud solve. */
  private treeSolCache = new Map<string, string>();
  /** (solId, node) → solved node JSON. */
  private nodeCache = new Map<string, any>();

  private treeKey(input: CustomTreeInput): string {
    return JSON.stringify([
      input.board, input.pot, input.stack, input.startingStreet ?? "FLOP",
      input.oopRange, input.ipRange, input.rake ?? null, input.fixedBets ?? null,
      input.fixedLevels ?? null, input.mid?.range ?? null,
    ]);
  }

  private buildCustomTree(input: CustomTreeInput) {
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
    const fb = input.fixedBets;
    const fl = input.fixedLevels;
    const street = (s: "FLOP" | "TURN" | "RIVER") =>
      fl && fl[s]?.length
        ? { street: s, position_bet_sizes: seats.map((p) => fixedPerLevel(p, fl[s]!)) }
        : fb && fb[s] != null
          ? { street: s, position_bet_sizes: seats.map((p) => fixed(p, `${fb[s]}%`)) }
          : input.mid
            ? { street: s, position_bet_sizes: seats.map(threeWay) }
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
      rake: input.rake ?? { pct_of_pot: 5, cap_in_chips: 0.6, preflop_rake_type: null },
      tournament_data: null,
    };
  }

  /** Create the custom tree + solution on the account (no waiting for the solve). */
  private async createCustomSolution(
    input: CustomTreeInput
  ): Promise<{ ok: true; solId: string } | { ok: false; status: number; error: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt === 1);
      if (!token) return { ok: false, status: 0, error: "No access token (is the GTO Wizard client running with CDP on 9222?)" };
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      // 1. create the tree (bounded — an unbounded fetch here hung whole
      // solves when the API stalled; nothing upstream can cancel it)
      const treeRes = await fetch(`${API_BASE}/v4/custom-solutions/custom-trees/`, {
        method: "POST", headers, body: JSON.stringify(this.buildCustomTree(input)),
        signal: AbortSignal.timeout(15_000),
      });
      if (treeRes.status === 401 && attempt === 0) continue;
      if (!treeRes.ok) return { ok: false, status: treeRes.status, error: `custom-trees: ${(await treeRes.text()).slice(0, 180)}` };
      const tree = await treeRes.json();
      const treeId = tree.id ?? tree.custom_tree_id ?? tree.uuid;
      if (!treeId) return { ok: false, status: 502, error: "custom-trees returned no id" };

      // 2. create the solution
      const solRes = await fetch(`${API_BASE}/v4/custom-solutions/`, {
        method: "POST", headers, body: JSON.stringify({ custom_tree_id: treeId, actions: "", board: input.board }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!solRes.ok) return { ok: false, status: solRes.status, error: `custom-solutions: ${(await solRes.text()).slice(0, 180)}` };
      const sol = await solRes.json();
      const solId = sol.id ?? sol.custom_solution_id ?? sol.uuid;
      if (!solId) return { ok: false, status: 502, error: "custom-solutions returned no id" };
      return { ok: true, solId: String(solId) };
    }
    return { ok: false, status: 401, error: "Unauthorized after token refresh" };
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
  private treePending = new Map<string, Promise<{ ok: true; solId: string; created: boolean } | { ok: false; status: number; error: string }>>();
  private nodePending = new Map<string, Promise<{ ok: true; data: any; solveSecs: number; cached: boolean } | { ok: false; status: number; error: string }>>();

  async ensureCustomSolution(
    input: CustomTreeInput
  ): Promise<{ ok: true; solId: string; created: boolean } | { ok: false; status: number; error: string }> {
    const key = this.treeKey(input);
    const hit = this.treeSolCache.get(key);
    if (hit) return { ok: true, solId: hit, created: false };
    const pending = this.treePending.get(key);
    if (pending) return pending.then((r) => (r.ok ? { ...r, created: false } : r));
    const p = (async () => {
      const made = await this.createCustomSolution(input);
      if (!made.ok) return made;
      this.treeSolCache.set(key, made.solId);
      return { ok: true as const, solId: made.solId, created: true };
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
  ): Promise<{ ok: true; data: any; solveSecs: number; cached: boolean } | { ok: false; status: number; error: string }> {
    const key = JSON.stringify([solId, q.flopActions ?? "", q.turnActions ?? "", q.riverActions ?? "", q.board]);
    const hit = this.nodeCache.get(key);
    if (hit) return { ok: true, data: hit, solveSecs: 0, cached: true };
    const pending = this.nodePending.get(key);
    if (pending) return pending;   // the same node is already being polled — share it (see treePending)
    const p = this.customNodeFetch(solId, q, timeoutMs).finally(() => this.nodePending.delete(key));
    this.nodePending.set(key, p);
    return p;
  }

  private async customNodeFetch(
    solId: string,
    q: { flopActions?: string; turnActions?: string; riverActions?: string; board: string },
    timeoutMs: number
  ): Promise<{ ok: true; data: any; solveSecs: number; cached: boolean } | { ok: false; status: number; error: string }> {
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
    while (Date.now() - t0 < timeoutMs) {
      const token = await this.accessToken();
      if (!token) return { ok: false, status: 0, error: "No access token (is the GTO Wizard client running with CDP on 9222?)" };
      // per-request bound: the loop's wall-clock ceiling can't fire while a
      // single fetch hangs inside it — a timed-out poll just retries
      let r: Response;
      try {
        r = await fetch(`${API_BASE}/v4/solutions/spot-solution/?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8_000),
        });
      } catch (e) {
        lastErr = `poll request failed: ${e instanceof Error ? e.message : e}`;
        await new Promise((res) => setTimeout(res, CUSTOM_SOLVE_POLL_MS));
        continue;
      }
      if (r.status === 401 && !refreshed) { refreshed = true; await this.accessToken(true); continue; }
      if (r.ok && r.status !== 204) {
        const j = await r.json().catch(() => null);
        if (j?.action_solutions?.length) {
          this.nodeCache.set(key, j);
          if (this.nodeCache.size > NODE_CACHE_MAX) {
            this.nodeCache.delete(this.nodeCache.keys().next().value as string);
          }
          return { ok: true, data: j, solveSecs: (Date.now() - t0) / 1000, cached: false };
        }
      } else if (!r.ok) {
        lastErr = `spot-solution ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120)}`;
      }
      await new Promise((res) => setTimeout(res, CUSTOM_SOLVE_POLL_MS));
    }
    return { ok: false, status: 504, error: `AI solve timed out — ${lastErr} (GTO Wizard may have hit its daily solution limit, or the client lost connection).` };
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
  ): Promise<{ ok: true; customSolutionId: string; solveSecs: number; cached: boolean; data: any } | { ok: false; status: number; error: string }> {
    const ens = await this.ensureCustomSolution(input);
    if (!ens.ok) return ens;
    const node = await this.customNode(ens.solId, {
      flopActions: input.flopActions,
      turnActions: input.turnActions,
      riverActions: input.riverActions,
      board: input.queryBoard ?? input.board,
    });
    if (!node.ok) return node;
    return { ok: true, customSolutionId: ens.solId, solveSecs: node.solveSecs, cached: node.cached, data: node.data };
  }
}

/** Everything that defines the custom TREE (and so the cloud solve). */
/**
 * Bet grid for a 3-player tree's wager-free streets (see buildCustomTree). Two bets and one raise size keep
 * the cloud solve in the same 3-5 s band as heads-up (probed 2026-09-19: root 3.5 s, nodes 1.3-3.1 s);
 * a street that DID see a wager is pinned to the observed sizes instead, exactly as heads-up.
 */
export const THREE_WAY_SIZES = { bet: ["33%", "75%"], raise: ["60%"] } as const;

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
