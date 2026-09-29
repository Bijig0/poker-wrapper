/**
 * GTO WIZARD ACCOUNTS (2026-09-27, Brady: "name them, show what each has used since when, when each expires,
 * and make me connect them first").
 *
 * The REGISTRY is a JSON file in the data root (<root>/gtow-accounts.json). The session pool (gtowSessions.ts) is
 * built from it, so adding a third account is a row here, not a code change. The two accounts that existed before
 * the registry keep their old slot ids — "primary" (Ultra) and "secondary" (Elite 1) — because the request ledger,
 * every stored solve's owner and the dashboard's routes already speak those ids; new accounts get a slug of their
 * name ("elite-2"). The env vars that used to configure the pool (GTOW_CDP_HOST, GTOW_CDP_HOST_SECONDARY,
 * GTOW_PREFER, GTOW_SECONDARY, …) are read ONCE, to seed the file when it does not exist; after that the file rules.
 *
 * What the page shows per account, and where it comes from:
 *   - name / tier / capability / CDP port / enabled …          this file
 *   - connected, signed-in identity, wall (routing view)         the pool's live state (gtowSessions.status)
 *   - requests in the last hour and last 24 h, since when        the request ledger (gtowRequestLog.windows)
 *   - the wall as the ledger saw it: since / expected lift        gtowRequestLog.wallState — survives API restarts
 *   - plan, renewal date and price, hands usage, credit           the client's own page storage (`user_info`), read
 *                                                                 over CDP — no GTO Wizard request is spent
 *
 * The 24 h "expected lift" is our measurement (2026-09-26/27: both accounts still walled 18-20 h after the trip;
 * Retry-After, the 00:00 UTC reset and a fresh login did not lift it), not a documented rule. The PROBE spends one
 * request to find out for real — it polls a solve this account already owns (probeSolId), creating one the first
 * time (two more requests, once).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { underTest } from "../../../../packages/data-root/dataRoot";
import { gtowAccountsPath } from "./storePaths";
import { livePort, port } from "./ports";

export type GtowTier = "ultra" | "elite" | "other";

export interface GtowAccountEntry {
  /** stable slot id — the ledger's `s`, a solve's owner, the routes' `source` */
  id: string;
  /** Brady's name for it: "Ultra", "Elite 1", "Elite 2" */
  name: string;
  tier: GtowTier;
  /** the plan solves 3+ player AI trees (Ultra yes, Elite no) */
  multiway: boolean;
  /** host:port of the client's DevTools endpoint — every account its own port */
  cdpHost: string;
  /** what brings the client up (a .ps1 under scripts/, or "" for the primary's built-in launcher) */
  launchHint: string;
  /**
   * HOW THE CLIENT IS RUN (2026-09-29, a dynamic number of accounts): the watchdog and the Connect button share one
   * rule, `launchPlan` below —
   *   chrome    app.gtowizard.com in a dedicated Chrome profile (`profileDir`, default %LOCALAPPDATA%\gtow-cdp-profile-<id>;
   *             the primary keeps the original gtow-cdp-profile), launched with --remote-debugging-port=<cdpHost's port>.
   *             Any number of these can run side by side: one profile folder + one port each.
   *   electron  a desktop build (`exe`), launched with the same flag. One per INSTALL: GTO Wizard's desktop app is a
   *             single-instance program, so a second electron account needs its own build ("Secondary GTO Wizard").
   * A `launchHint` .ps1 that exists under scripts/ still wins over both (the secondary's start_gtow_secondary.ps1).
   */
  client: "chrome" | "electron";
  exe: string | null;
  profileDir: string | null;
  /** a disabled account takes no work but keeps its token warm (Brady, 2026-09-27) */
  enabled: boolean;
  /** routing preference among capable accounts — lower first; and the same for PREFLOP work */
  order: number;
  preflopOrder: number;
  /** what Brady pays a month, if he wants it on the page (the client also reports its own renewal price) */
  priceMonthly: number | null;
  notes: string;
  /** a solve on this account the probe polls with ONE request; learned on the first probe */
  probeSolId: string | null;
  /** identity last seen in this slot's token — informational; two slots showing one id = one login in two windows */
  accountEmail: string | null;
  accountId: string | null;
}

export interface GtowAccountsFile { version: 1; accounts: GtowAccountEntry[] }

const envBool = (v: string | undefined, dflt: boolean): boolean =>
  v == null || v.trim() === "" ? dflt : !/^(0|no|false|off)$/i.test(v.trim());

/**
 * Where GTO Wizard's desktop app installs (the official "GTO Wizard Setup x.y.z.exe": per user, under the profile —
 * measured 1.0.9 on 2026-09-29 — older builds under Program Files). The first that exists is the primary's client
 * when the registry is seeded, so an install that put the app on first uses it; GTOW_CLIENT_PATH pins a build,
 * GTOW_CLIENT=chrome says "the Chrome window even though the app is installed".
 */
export const desktopAppCandidates = (env: NodeJS.ProcessEnv = process.env): string[] => [
  join(env.USERPROFILE ?? "", "GTO Wizard", "GTO Wizard.exe"),
  join(env.LOCALAPPDATA ?? "", "Programs", "GTO Wizard", "GTO Wizard.exe"),
  "C:\\Program Files\\GTO Wizard\\GTO Wizard.exe",
  "C:\\Program Files\\Chinese GTO Wizard\\Chinese GTO Wizard.exe",
];
export function desktopAppPath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (/^chrome$/i.test(env.GTOW_CLIENT ?? "")) return null;
  const pinned = env.GTOW_CLIENT_PATH?.trim();
  if (pinned) return pinned;
  // absolute only: with USERPROFILE unset the first candidate is the relative "GTO Wizard\GTO Wizard.exe"
  return desktopAppCandidates(env).find((p) => isAbsolute(p) && exists(p)) ?? null;
}

/** The two accounts the pool had before the registry, named as Brady named them (2026-09-27). */
export function defaultAccounts(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): GtowAccountEntry[] {
  const preferPrimary = /^primary$/i.test(env.GTOW_PREFER ?? "");
  const app = desktopAppPath(env, exists);
  return [
    {
      id: "secondary", name: "Elite 1", tier: "elite",
      multiway: envBool(env.GTOW_SECONDARY_MULTIWAY, false),
      cdpHost: env.GTOW_CDP_HOST_SECONDARY ?? `127.0.0.1:${port("gtowSecondary", env)}`,
      launchHint: "scripts/start_gtow_secondary.ps1",
      client: "electron", exe: env.GTOW_SECONDARY_PATH?.trim() || null, profileDir: null,
      enabled: envBool(env.GTOW_SECONDARY, true),
      order: preferPrimary ? 2 : 1, preflopOrder: 2,
      priceMonthly: null, notes: "", probeSolId: null, accountEmail: null, accountId: null,
    },
    {
      id: "primary", name: "Ultra", tier: "ultra",
      multiway: envBool(env.GTOW_PRIMARY_MULTIWAY, true),
      cdpHost: env.GTOW_CDP_HOST ?? `127.0.0.1:${port("gtow", env)}`,
      launchHint: "scripts/start_gtow_chrome.ps1",
      client: app ? "electron" : "chrome", exe: app,
      profileDir: env.GTOW_CHROME_PROFILE?.trim() || null,
      enabled: envBool(env.GTOW_PRIMARY, true),
      order: preferPrimary ? 1 : 2, preflopOrder: 1,
      priceMonthly: null, notes: "", probeSolId: null, accountEmail: null, accountId: null,
    },
  ];
}

/** The port in a cdpHost ("127.0.0.1:9224" → 9224), or null when it has none. */
export const cdpPort = (cdpHost: string): number | null => {
  const m = /:(\d+)\s*$/.exec(cdpHost);
  return m ? Number(m[1]) : null;
};

/** The account (other than `exceptId`) already on this cdpHost's port — two clients cannot share a DevTools port. */
export function cdpHostTakenBy(cdpHost: string, exceptId: string, accounts: GtowAccountEntry[] = loadAccounts().accounts): GtowAccountEntry | null {
  const port = cdpPort(cdpHost);
  if (port == null) return null;
  return accounts.find((a) => a.id !== exceptId && cdpPort(a.cdpHost) === port) ?? null;
}

export interface LaunchPlan {
  port: number;
  /** "script": run this .ps1 (repo-relative) with -Force; "electron": start `exe`; "chrome": start_gtow_chrome.ps1 */
  kind: "script" | "electron" | "chrome";
  script: string | null;
  exe: string | null;
  profileDir: string;
  /** what the launcher reads: the port for both scripts, the profile for the chrome one */
  env: Record<string, string>;
}

/** How to bring one account's client up — the one rule the Connect button and the watchdog both follow. */
export function launchPlan(a: GtowAccountEntry, repo: string, localAppData = process.env.LOCALAPPDATA ?? ""): LaunchPlan {
  const port = cdpPort(a.cdpHost) ?? livePort("gtow");
  const profileDir = a.profileDir?.trim() || join(localAppData, a.id === "primary" ? "gtow-cdp-profile" : `gtow-cdp-profile-${a.id}`);
  const script = /\.ps1$/i.test(a.launchHint) && existsSync(join(repo, a.launchHint)) ? a.launchHint : null;
  const kind: LaunchPlan["kind"] = script ? "script" : a.client === "electron" && a.exe ? "electron" : "chrome";
  return {
    port, kind, script, exe: a.exe, profileDir,
    env: { GTOW_CDP_PORT: String(port), GTOW_SECONDARY_CDP_PORT: String(port), GTOW_CHROME_PROFILE: profileDir,
           ...(a.exe ? { GTOW_CLIENT_PATH: a.exe, GTOW_SECONDARY_PATH: a.exe } : {}) },
  };
}

const FIELDS: (keyof GtowAccountEntry)[] = ["id", "name", "tier", "multiway", "cdpHost", "launchHint", "client", "exe", "profileDir", "enabled", "order", "preflopOrder", "priceMonthly", "notes", "probeSolId", "accountEmail", "accountId"];

function normalize(raw: any, fallback?: GtowAccountEntry): GtowAccountEntry | null {
  const id = String(raw?.id ?? fallback?.id ?? "").trim();
  if (!id) return null;
  // a row from before a field existed reads as its SEEDED self (the secondary: a desktop build); a NEW row is a Chrome
  // profile of its own (launchPlan names it), no launcher script, no desktop build
  const seeded = defaultAccounts().find((d) => d.id === id);
  const f = fallback ?? seeded ?? { ...defaultAccounts()[1]!, id, name: id, tier: "other" as GtowTier, multiway: false, cdpHost: "", launchHint: "",
                                    client: "chrome" as const, exe: null, profileDir: null, order: 9, preflopOrder: 9 };
  const tier = ["ultra", "elite", "other"].includes(raw?.tier) ? raw.tier : f.tier;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const price = raw?.priceMonthly == null || raw?.priceMonthly === "" ? (raw?.priceMonthly === "" ? null : f.priceMonthly) : Number(raw.priceMonthly);
  return {
    id,
    name: String(raw?.name ?? f.name).trim() || id,
    tier,
    multiway: typeof raw?.multiway === "boolean" ? raw.multiway : f.multiway,
    cdpHost: String(raw?.cdpHost ?? f.cdpHost).trim(),
    launchHint: String(raw?.launchHint ?? f.launchHint).trim(),
    client: raw?.client === "electron" || raw?.client === "chrome" ? raw.client : (f.client ?? "chrome"),
    exe: raw?.exe == null ? (f.exe ?? null) : String(raw.exe).trim() || null,
    profileDir: raw?.profileDir == null ? (f.profileDir ?? null) : String(raw.profileDir).trim() || null,
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : f.enabled,
    order: num(raw?.order, f.order),
    preflopOrder: num(raw?.preflopOrder, f.preflopOrder),
    priceMonthly: Number.isFinite(price as number) ? (price as number) : null,
    notes: String(raw?.notes ?? f.notes ?? ""),
    probeSolId: raw?.probeSolId == null ? f.probeSolId : String(raw.probeSolId) || null,
    accountEmail: raw?.accountEmail == null ? f.accountEmail : String(raw.accountEmail) || null,
    accountId: raw?.accountId == null ? f.accountId : String(raw.accountId) || null,
  };
}

/** The registry: the file if it exists, else the seeded defaults (written once, never under test). */
export function loadAccounts(): GtowAccountsFile {
  const path = gtowAccountsPath();
  if (existsSync(path)) {
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      const accounts = (Array.isArray(j?.accounts) ? j.accounts : []).map((a: any) => normalize(a)).filter(Boolean) as GtowAccountEntry[];
      if (accounts.length) return { version: 1, accounts };
    } catch { /* a torn write: fall through to the defaults, which the next save replaces */ }
  }
  const seeded: GtowAccountsFile = { version: 1, accounts: defaultAccounts() };
  if (!underTest()) { try { saveAccounts(seeded); } catch { /* read-only root: the defaults still serve */ } }
  return seeded;
}

export function saveAccounts(file: GtowAccountsFile): void {
  const path = gtowAccountsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

export const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";

/** Add or change one account; `id` picks the row (a new id, or none, adds one named after `name`). */
export function upsertAccount(patch: Partial<GtowAccountEntry> & { name?: string }): GtowAccountEntry {
  const file = loadAccounts();
  const id = String(patch.id ?? "").trim() || slugOf(String(patch.name ?? ""));
  const i = file.accounts.findIndex((a) => a.id === id);
  const next = normalize({ ...patch, id }, i >= 0 ? file.accounts[i] : undefined)!;
  if (i >= 0) file.accounts[i] = next; else file.accounts.push(next);
  saveAccounts(file);
  return next;
}

export function removeAccount(id: string): boolean {
  const file = loadAccounts();
  const n = file.accounts.length;
  file.accounts = file.accounts.filter((a) => a.id !== id);
  if (file.accounts.length === n) return false;
  saveAccounts(file);
  return true;
}

/** Remember a fact learned at runtime (the probe's solve, the token's identity) without touching anything else. */
export function noteAccountFact(id: string, facts: Partial<Pick<GtowAccountEntry, "probeSolId" | "accountEmail" | "accountId">>): void {
  try {
    const file = loadAccounts();
    const a = file.accounts.find((x) => x.id === id);
    if (!a) return;
    let changed = false;
    for (const k of Object.keys(facts) as (keyof typeof facts)[]) {
      if (facts[k] !== undefined && a[k] !== facts[k]) { (a as any)[k] = facts[k]; changed = true; }
    }
    if (changed && !underTest()) saveAccounts(file);
  } catch { /* informational */ }
}

// ---------------------------------------------------------------- the client's own view of the account

export interface GtowPlanInfo {
  tier: string;
  interval: string | null;
  /** what the next renewal costs, as the client reports it */
  priceNext: number | null;
  currency: string | null;
  /** the subscription's end (the free tier reports year 2526 = never) */
  expirationDate: string | null;
  canceled: boolean;
  handsUsed: number | null;
  handsLimit: number | null;
  /** the monthly cycle boundary — the renewal anniversary when expirationDate is missing */
  handsResetDate: string | null;
}

export interface GtowAccountInfo {
  readAtMs: number;
  signedIn: boolean;
  /** where the client's page was (a /login URL is the signed-out tell) */
  pageUrl: string | null;
  email: string | null;
  publicId: string | null;
  creditBalance: number | null;
  plan: GtowPlanInfo | null;
}

/** Runs in the client page: the pieces of `user_info` the page shows, nothing else. */
const USER_INFO_EXPR = `(() => {
  try {
    const u = JSON.parse(localStorage.getItem('user_info') || 'null');
    const out = { url: location.href, signedIn: !!u, email: u?.email ?? null, publicId: u?.public_id ?? u?.id ?? null, credit: u?.credit_balance ?? null, subs: [] };
    for (const s of (u?.subs || u?.subscriptions || [])) {
      out.subs.push({ tier: s?.plan?.tier ?? null, interval: s?.plan?.interval ?? null,
        priceNext: s?.next_renewal_price?.price ?? null, currency: s?.next_renewal_price?.currency ?? null,
        expirationDate: s?.expiration_date ?? null, canceled: !!s?.canceled,
        handsUsed: s?.hands_usage?.hands_used ?? null, handsLimit: s?.hands_limit ?? null, handsResetDate: s?.hands_usage?.reset_date ?? null });
    }
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

/** One Runtime.evaluate on the client's GTO Wizard page over CDP. Null when the client is down or has no such page. */
async function evaluateOnClient(cdpHost: string, expression: string, timeoutMs = 6_000): Promise<string | null> {
  let targets: { type: string; url: string; webSocketDebuggerUrl?: string }[];
  try {
    targets = await (await fetch(`http://${cdpHost}/json/list`, { signal: AbortSignal.timeout(2_500) })).json();
  } catch { return null; }
  const page = targets.find((t) => t.type === "page" && /gtowizard\.com/i.test(t.url ?? ""));
  if (!page?.webSocketDebuggerUrl) return null;
  return new Promise<string | null>((resolve) => {
    let done = false;
    const ws = new WebSocket(page.webSocketDebuggerUrl!);
    const finish = (v: string | null) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch { /* closed */ } resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); } catch { finish(null); } };
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(String(ev.data)); if (m.id === 1) finish(typeof m.result?.result?.value === "string" ? m.result.result.value : null); } catch { finish(null); }
    };
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(null);
  });
}

const infoCache = new Map<string, GtowAccountInfo>();
const INFO_TTL_MS = 10 * 60_000;

/** The account as its client page describes it, cached for INFO_TTL_MS per CDP host; null when unreadable. */
export async function accountInfo(cdpHost: string, opts: { force?: boolean } = {}): Promise<GtowAccountInfo | null> {
  const hit = infoCache.get(cdpHost);
  if (hit && !opts.force && Date.now() - hit.readAtMs < INFO_TTL_MS) return hit;
  const raw = await evaluateOnClient(cdpHost, USER_INFO_EXPR);
  if (!raw) return hit ?? null;
  let j: any; try { j = JSON.parse(raw); } catch { return hit ?? null; }
  if (j?.error) return hit ?? null;
  const paid = (j.subs as any[]).find((s) => s.tier && s.tier !== "FREE") ?? (j.subs as any[])[0] ?? null;
  const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const info: GtowAccountInfo = {
    readAtMs: Date.now(),
    signedIn: !!j.signedIn,
    pageUrl: typeof j.url === "string" ? j.url : null,
    email: j.email ?? null,
    publicId: j.publicId ?? null,
    creditBalance: num(j.credit),
    plan: paid ? {
      tier: String(paid.tier ?? "?"), interval: paid.interval ?? null,
      priceNext: num(paid.priceNext), currency: paid.currency ?? null,
      expirationDate: paid.expirationDate ?? null, canceled: !!paid.canceled,
      handsUsed: num(paid.handsUsed), handsLimit: num(paid.handsLimit), handsResetDate: paid.handsResetDate ?? null,
    } : null,
  };
  infoCache.set(cdpHost, info);
  return info;
}

/** Our reading of GTO Wizard's request wall: measured to hold about a day from the first refusal. */
export const WALL_MS = 24 * 3_600_000;
/** the hourly throttle GTO Wizard's 429 states, and Brady's conservative daily budget — both 2,250 */
export const REQUEST_CAP = 2_250;

/** The heads-up 100bb Ignition-shaped preflop tree the probe creates once per account (the limit probe's body). */
export function probeTreeBody() {
  const sizes = (position: string) => ({ position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true,
    allow_3betplus_cold_calls: true, bet_sizes: ["2x", "2.2x", "2.5x", "3x", "3.5x"], raise_sizes: ["3.2x", "3.8x", "4.5x"],
    second_raise_sizes: ["2.2x", "2.6x"], third_plus_raise_sizes: ["2.2x"] });
  return {
    starting_street: "PREFLOP", pot: 0, ante: null, ante_distribution_method: "PER_PLAYER", max_allowed_limps: null,
    bet_sizes: { allin_threshold: 60, allin_if_less_than: 500, merge_sizes_threshold: 10, max_num_raises: 5,
      street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: ["SB", "BB"].map(sizes) }] },
    players: ["SB", "BB"].map((p) => ({ position: p, display_position: p, blind: p === "SB" ? 0.5 : 1, range: null, stack: 100,
      tournament_instant_bounty: null, tournament_total_bounty: null })),
    tree_operations: [], resolving_policy: null,
    rake: { pct_of_pot: 5, cap_in_chips: 0.5, preflop_rake_type: "no_flop_no_drop" },
    tournament_data: null,
  };
}
