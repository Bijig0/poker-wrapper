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
const CUSTOM_SOLVE_TIMEOUT_MS = 30_000; // cloud AI solve poll ceiling (fail fast, don't hang)
/** Solved-node JSON is ~500KB each; bound the cache so a long live session
 *  can't grow it without limit. LRU — a hand's prior-street nodes stay hot. */
const NODE_CACHE_MAX = 64;

/**
 * How long to wait before the next poll, given how long we've been waiting.
 *
 * A flat interval is the wrong shape here: a cloud solve never lands before
 * ~0.7s, most land in the 1.5-2.5s window, and a queued one can take much
 * longer. The old flat 1500ms quantized every solve up to a multiple of 1.5s —
 * a solve that finished at 1.6s wasn't seen until 3.0s. Waiting out the dead
 * period once, then polling tightly through the window where solves actually
 * land, cuts roughly half a second off a typical solve without spraying
 * requests: the tight phase only costs a handful of extra GETs.
 */
export const pollDelayMs = (elapsedMs: number): number => {
  if (elapsedMs < 700) return 700 - elapsedMs; // nothing lands this fast
  if (elapsedMs < 6_000) return 300; // the window solves actually land in
  return 1_500; // straggler / queued behind other solves
};

export interface SpotSolutionParams {
  gametype: string;
  depth: number;
  preflop_actions: string; // e.g. "R2.5-C"
  flop_actions?: string; // e.g. "X" | "X-R3" ...
  turn_actions?: string;
  river_actions?: string;
  board: string; // concatenated, e.g. "Ts7h2d"
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
      // Timeout is load-bearing: a half-open CDP port (client relaunched
      // without the debug flag) otherwise hangs this fetch FOREVER, freezing
      // every solve behind the token instead of failing fast.
      targets = await (await fetch(`http://${CDP_HOST}/json/list`, { signal: AbortSignal.timeout(2_000) })).json();
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
      const send = (method: string, params: unknown = {}) => ws.send(JSON.stringify({ id: ++seq, method, params }));

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
    });
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
      board: p.board,
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
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
      input.fixedLevels ?? null,
    ]);
  }

  private buildCustomTree(input: CustomTreeInput) {
    const auto = (position: "OOP" | "IP") => ({ position, type: "AUTOMATIC" as const, allow_limp: false });
    // FIXED sizing pins a street's bets to an exact % of pot (validated format:
    // bet_sizes:["90%"]). Used to solve the villain's EXACT off-tree bet when the
    // nearest library size is too far to snap (see snapToken τ). Applies to both
    // seats on that street; the string list is what the API expects.
    const fixed = (position: "OOP" | "IP", pct: string) => ({
      position, type: "FIXED" as const, use_fixed_sizes: true, allow_limp: false,
      bet_sizes: [pct], raise_sizes: [pct], second_raise_sizes: [pct], third_plus_raise_sizes: [pct],
    });
    // Per-raise-level FIXED sizing: lv[0] pins the street's first bet, lv[1]
    // the raise over it, lv[2] the re-raise, lv[3]+ beyond. Levels past the
    // supplied list fall back to the last given pct — they only shape the
    // (rarely reached) deeper raise war, not the studied line itself.
    const fixedPerLevel = (position: "OOP" | "IP", lv: string[]) => {
      const at = (i: number) => lv[Math.min(i, lv.length - 1)] ?? "50%";
      return {
        position, type: "FIXED" as const, use_fixed_sizes: true, allow_limp: false,
        bet_sizes: [at(0)], raise_sizes: [at(1)],
        second_raise_sizes: [at(2)], third_plus_raise_sizes: [at(3)],
      };
    };
    const fb = input.fixedBets;
    const fl = input.fixedLevels;
    const street = (s: "FLOP" | "TURN" | "RIVER") =>
      fl && fl[s]?.length
        ? { street: s, position_bet_sizes: [fixedPerLevel("OOP", fl[s]!), fixedPerLevel("IP", fl[s]!)] }
        : fb && fb[s] != null
          ? { street: s, position_bet_sizes: [fixed("OOP", `${fb[s]}%`), fixed("IP", `${fb[s]}%`)] }
          : { street: s, position_bet_sizes: [auto("OOP"), auto("IP")] };
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
        { position: "OOP", display_position: input.oopPos ?? "BB", blind: null, range: input.oopRange, stack: input.stack, tournament_instant_bounty: null, tournament_total_bounty: null },
        { position: "IP", display_position: input.ipPos ?? "CO", blind: null, range: input.ipRange, stack: input.stack, tournament_instant_bounty: null, tournament_total_bounty: null },
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

      // 1. create the tree
      const treeRes = await fetch(`${API_BASE}/v4/custom-solutions/custom-trees/`, {
        method: "POST", headers, body: JSON.stringify(this.buildCustomTree(input)),
      });
      if (treeRes.status === 401 && attempt === 0) continue;
      if (!treeRes.ok) return { ok: false, status: treeRes.status, error: `custom-trees: ${(await treeRes.text()).slice(0, 180)}` };
      const tree = await treeRes.json();
      const treeId = tree.id ?? tree.custom_tree_id ?? tree.uuid;
      if (!treeId) return { ok: false, status: 502, error: "custom-trees returned no id" };

      // 2. create the solution
      const solRes = await fetch(`${API_BASE}/v4/custom-solutions/`, {
        method: "POST", headers, body: JSON.stringify({ custom_tree_id: treeId, actions: "", board: input.board }),
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
  async ensureCustomSolution(
    input: CustomTreeInput
  ): Promise<{ ok: true; solId: string; created: boolean } | { ok: false; status: number; error: string }> {
    const key = this.treeKey(input);
    const hit = this.treeSolCache.get(key);
    if (hit) return { ok: true, solId: hit, created: false };
    const made = await this.createCustomSolution(input);
    if (!made.ok) return made;
    this.treeSolCache.set(key, made.solId);
    return { ok: true, solId: made.solId, created: true };
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
    if (hit) {
      this.nodeCache.delete(key); // refresh LRU recency
      this.nodeCache.set(key, hit);
      return { ok: true, data: hit, solveSecs: 0, cached: true };
    }

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
      const r = await fetch(`${API_BASE}/v4/solutions/spot-solution/?${params}`, { headers: { Authorization: `Bearer ${token}` } });
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
      await new Promise((res) => setTimeout(res, pollDelayMs(Date.now() - t0)));
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
    const node = await this.customNode(
      ens.solId,
      {
        flopActions: input.flopActions,
        turnActions: input.turnActions,
        riverActions: input.riverActions,
        board: input.queryBoard ?? input.board,
      },
      // Flop-rooted trees are the whole remaining game and can genuinely need
      // more than the default ceiling (measured: a 33%-fixed flop tree blew
      // past 30s while rivers land in ~1s) — let callers wait longer for them.
      input.timeoutMs,
    );
    if (!node.ok) return node;
    return { ok: true, customSolutionId: ens.solId, solveSecs: node.solveSecs, cached: node.cached, data: node.data };
  }
}

/** Everything that defines the custom TREE (and so the cloud solve). */
export interface CustomTreeInput {
  board: string; // concatenated, e.g. "Ts7h2d"
  pot: number; // bb
  stack: number; // effective, bb
  /** 1326-weight ranges (see buildRangeArray). */
  oopRange: number[];
  ipRange: number[];
  oopPos?: string;
  ipPos?: string;
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
  /** Poll ceiling override for the node query (default CUSTOM_SOLVE_TIMEOUT_MS).
   *  Not part of the tree identity — cache keys ignore it. */
  timeoutMs?: number;
  /** Full board (incl. turn/river) for the spot-solution QUERY, when the tree
   *  starts earlier than the queried node (defaults to `board`). */
  queryBoard?: string;
}

export const gtowApi = new GtowApi();
export { GtowApi };
