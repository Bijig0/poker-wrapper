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
 *  - SECONDARY is the Elite account in the "Secondary GTO Wizard" desktop
 *    build (CDP 9223). Elite includes GTO Wizard AI but HEADS-UP ONLY: hand it
 *    a 3-player tree and the API refuses it. Its quota is separate from the
 *    primary's, so every heads-up solve it absorbs is one the primary does not
 *    spend.
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

import { asActivity, timed } from "./answerTrace";

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

export type GtowSessionId = "primary" | "secondary";

/** What a piece of work needs from an account. `multiway` is a hard capability
 *  (Elite's AI refuses 3+ player trees); `preflop` only changes the ORDER — see
 *  the note at the top of this file. */
export interface GtowNeed {
  multiway?: boolean;
  preflop?: boolean;
}

export interface GtowSessionCfg {
  id: GtowSessionId;
  label: string;
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

/** Why a session is not taking work right now. */
export type BlockKind = "quota" | "plan" | "auth" | "unreachable";

export interface GtowSessionStatus {
  id: GtowSessionId;
  label: string;
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
  /** Rolled up for the UI: what this session is doing for us right now.
   *  "unknown" = nobody probed, so down and signed-out cannot be told apart. */
  state: "up" | "no-token" | "blocked" | "down" | "off" | "unknown";
  text: string;
}

const envBool = (v: string | undefined, dflt: boolean): boolean =>
  v == null || v.trim() === "" ? dflt : !/^(0|no|false|off)$/i.test(v.trim());

function configs(): GtowSessionCfg[] {
  const preferPrimary = /^primary$/i.test(process.env.GTOW_PREFER ?? "");
  return [
    {
      id: "secondary",
      label: "Secondary GTO Wizard (Elite · heads-up AI)",
      cdpHost: process.env.GTOW_CDP_HOST_SECONDARY ?? "127.0.0.1:9223",
      // Elite's AI is heads-up only. Override if the plan changes.
      multiway: envBool(process.env.GTOW_SECONDARY_MULTIWAY, false),
      // spend this one first on POSTFLOP heads-up — its quota is the one we
      // are trying to burn; preflop goes to Ultra, and reaches this account
      // only when the primary cannot take the work at all
      order: preferPrimary ? 2 : 1,
      preflopOrder: 2,
      launchHint: "scripts/start_gtow_secondary.ps1",
      enabled: envBool(process.env.GTOW_SECONDARY, true),
    },
    {
      id: "primary",
      label: "Primary GTO Wizard (Ultra · Chrome profile)",
      cdpHost: process.env.GTOW_CDP_HOST ?? "127.0.0.1:9222",
      multiway: envBool(process.env.GTOW_PRIMARY_MULTIWAY, true),
      order: preferPrimary ? 1 : 2,
      preflopOrder: 1,
      launchHint: "scripts/start_gtow_chrome.ps1",
      enabled: envBool(process.env.GTOW_PRIMARY, true),
    },
  ];
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

/** Next 00:00 UTC — when GTO Wizard's daily allowance rolls over. */
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
  if (status === 401) return "auth";
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

  constructor() {
    this.reload();
  }

  /** (Re)read the env-driven config, keeping any tokens already in hand. */
  reload(): void {
    for (const cfg of configs()) {
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
        blockedKind: null,
        blockedReason: null,
        multiwayRefused: false,
        lastError: null,
        trees: 0,
        lastUsedMs: 0,
        account: null,
      });
    }
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
    return this.ranked(need)
      .filter((s) => s.cfg.enabled && this.capable(s, need) && !this.blocked(s))
      .map((s) => s.cfg.id);
  }

  /** Every enabled session that could do the work, blocked ones included —
   *  the last-ditch list when `route` came back empty. */
  routeIgnoringBlocks(need: GtowNeed = {}): GtowSessionId[] {
    return this.ranked(need)
      .filter((s) => s.cfg.enabled && this.capable(s, need))
      .map((s) => s.cfg.id);
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

  /** A usable token for one session, cached until shortly before it expires. */
  async tokenFor(id: GtowSessionId, force = false): Promise<string | null> {
    const s = this.sessions.get(id);
    if (!s || !s.cfg.enabled) return null;
    if (!force && this.live(s)) return s.token;
    if (!force && s.sniffFailedMs && Date.now() - s.sniffFailedMs < SNIFF_FAIL_HOLD_MS) return null;   // known signed out
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
    const until =
      kind === "quota" ? nextDailyResetMs()
      : Date.now() + SOFT_BLOCK_MS;
    s.blockedUntilMs = until;
    s.blockedKind = kind;
    s.blockedReason =
      kind === "quota" ? `daily allowance spent (${status}) — retries after the 00:00 UTC reset`
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
    await Promise.all(this.all().map((s) => this.refreshIfExpiring(s)));
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
    return this.ranked(need).some((s) => s.cfg.enabled && this.capable(s, need) && this.live(s));
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
      blockedKind: blocked ? s.blockedKind : null,
      blockedReason: blocked ? s.blockedReason : s.multiwayRefused ? s.blockedReason : null,
      multiwayRefused: s.multiwayRefused,
      lastError: s.lastError,
      trees: s.trees,
      lastUsedMs: s.lastUsedMs || null,
      account: s.account?.email ?? null,
      accountId: s.account?.publicId ?? null,
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

export const gtowSessions = new GtowSessions();
export { GtowSessions };
