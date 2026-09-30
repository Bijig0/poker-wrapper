/**
 * Declared study sessions: presets, preflight, the session record. Port of sessions.py.
 *
 * A session is DECLARED before anything opens, not inferred afterwards. The setup page picks a preset, shows the
 * settings it implies, runs the preflight against everything the mode needs, and only then does the wrapper open
 * the table. The record written at Start — config, preflight results, a snapshot of every source version in force
 * — is what the study dashboard and Replay Review read back.
 *
 * Storage: data/sessions.sqlite (one row per session, JSON columns), shared with the Python wrapper's rows.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as balances from "./balances";
import { nowMs, strftime, time } from "./clock";
import { paths } from "./env";
import { openStore } from "../../../packages/data-root/centralDb";
import * as netcheck from "./netcheck";
import { pyFloat, pyInt, pyJsonDumps, pyReprStr, pyRound, pyStr, truthy, ValueError } from "./py";
import { apiUrl, port } from "../../api/src/services/ports";

/** dict.get(k, default): the default only when the key is ABSENT (a present None stays None). */
const getd = (o: any, k: string, d: unknown) => (o && typeof o === "object" && k in o ? o[k] : d);

/** 127.0.0.1, NOT localhost: on Windows localhost tries ::1 first and the API listens on IPv4 only. */
export const API = () => process.env.STUDY_API || apiUrl();

export const STRATEGY_PREFIX = "strategy:";
const PRACTICE = ["ign-practice-ring", "ign-practice-zone"];
export const FORMAT_FALLBACK: Record<string, { formats: string[]; default: string }> = {
  "ign25-zone-3max-exploit": { formats: ["ign-zone-NL25", ...PRACTICE], default: "ign-zone-NL25" },
  "ign200-zone-3max-equilibrium": { formats: ["ign-zone-NL200", ...PRACTICE], default: "ign-zone-NL200" },
  "ign200-ring-6max-equilibrium": { formats: ["ign-ring-NL200-6", "ign-ring-NL5-6", ...PRACTICE], default: "ign-ring-NL200-6" },
};

const baseConfig = (fmt: string | null, answers: boolean, sources: Record<string, boolean>) => ({
  answers, sources, recording: true, budget: { hands: null, minutes: null },
  autoExecute: false, autoRealMoney: false, autoBudget: { minutes: 30, hands: 50 }, autoDelay: "instant", autoTimeBank: true,
  format: fmt, buyinBb: 100, waitForBb: true, profile: null, tables: 1, site: "ignition",
});
const noSources = { exploitPreflop: false, mesPostflop: false, aiChain: false };

export const BASE_PRESETS: Record<string, any> = {
  silent: {
    label: "Silent play",
    tagline: "No answers. Every hand is still archived and graded afterwards — the control group.",
    config: baseConfig("ign-practice-ring", false, noSources),
    formats: null, defaultFormat: "ign-practice-ring", requires: [], sites: ["ignition", "coinpoker", "clubgg"],
  },
  "capture-qa": {
    label: "Capture QA",
    tagline: "Answers off, frame-by-frame recording on. For checking the reader and the replica against the real client.",
    config: baseConfig("ign-practice-ring", false, noSources),
    formats: null, defaultFormat: "ign-practice-ring", requires: ["recording"], sites: ["ignition"],
  },
  "test-rig": {
    label: "Test rig",
    tagline: "The fake table with authored spots. Answers on, nothing archived as played hands.",
    config: baseConfig(null, true, { exploitPreflop: true, mesPostflop: true, aiChain: true }),
    formats: null, defaultFormat: null, requires: ["fake"], sites: ["ignition"],
  },
};
export const NO_ANSWER_MODES = ["silent", "capture-qa", "test-rig"];

async function fetchJson(url: string, timeoutS: number): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutS * 1000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** The dashboard's strategy catalogue (GET /api/dashboard/sources/strategies), or null. */
export async function realFetchStrategies(timeoutS = 6.0): Promise<any[] | null> {
  try {
    const j = await fetchJson(`${API()}/api/dashboard/sources/strategies`, timeoutS);
    return j.ok ? j.strategies ?? null : null;
  } catch {
    return null;
  }
}

export async function realFetchRegistry(timeoutS = 6.0): Promise<any | null> {
  try {
    return await fetchJson(`${API()}/api/dashboard/sources/registry`, timeoutS);
  } catch {
    return null;
  }
}

/** Swappable for tests (the goldens replay a captured catalogue and patch the balance / net probes). */
export const deps = {
  fetchStrategies: realFetchStrategies,
  fetchRegistry: realFetchRegistry,
  scrapeCached: (port: number) => balances.scrapeCached(port),
  latestBalance: (profile: string) => balances.latest(profile) as any,
  netCached: () => netcheck.cached(),
  gitHead: (): string | null => {
    try {
      const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: paths().root, stderr: "ignore" });
      return p.exitCode === 0 ? p.stdout.toString().trim() : null;
    } catch {
      return null;
    }
  },
};

export const fetchRegistry = (timeoutS = 6.0) => deps.fetchRegistry(timeoutS);

export const CHART_CHECKS: Record<string, string | null> = {
  "hrc-6max": "hrc6max",
  // a preflop piece that is GTO Wizard AI alone (the CoinPoker ring on-demand strategy, 2026-09-30) reads no chart:
  // the chart server is not its requirement, and its being down must not block the session
  "gtow-ai-preflop": null,
};

export function chartCheck(preflopLayer: any): string | null {
  const src = (preflopLayer || {}).source || "";
  return src in CHART_CHECKS ? CHART_CHECKS[src]! : "hrc";
}

/** One session mode per whole-hand strategy: its config IS the strategy. */
export function strategyPreset(s: any): any {
  const pre = s.preflop, post = s.postflop;
  const exploit = pre === "exploit";
  const mes = post === "mes";
  const layers = [s.preflopLayer || {}, s.postflopLayer || {}, s.opponentLayer || {}];
  const chk = chartCheck(layers[0]);
  const requires = ["api", ...(chk ? [chk] : []), ...(exploit ? ["exploit"] : []), ...(mes ? ["mes"] : []), "gtow"];
  const fb = FORMAT_FALLBACK[s.id];
  return {
    label: s.name || s.id,
    tagline: s.tagline || "",
    strategy: {
      id: s.id, name: s.name ?? null, status: s.status ?? null, reasons: s.reasons || [],
      recommended: !!s.recommended, matrixRow: s.matrixRow ?? null,
      layers: ["preflop", "postflop", "opponent"].map((r, i) => ({ role: r, label: layers[i].label ?? null, short: layers[i].short ?? null,
                                                                   source: layers[i].source ?? null })),
      url: `${API()}/sources/strategies/${s.id}`,
    },
    disabled: s.status === "misspecified" || s.status === "unavailable",
    config: {
      answers: true,
      sources: { exploitPreflop: exploit, mesPostflop: mes, aiChain: true },
      recording: true, budget: { hands: null, minutes: null },
      autoExecute: false, autoRealMoney: false,
      autoBudget: { minutes: 30, hands: 50 },
      autoDelay: "instant",
      autoTimeBank: true,
      autoTopUp: true,
      strategy: s.id, strategyName: s.name ?? null,
      format: s.defaultFormat ?? null, buyinBb: 100, waitForBb: true, profile: null, tables: 1,
      // an ON-DEMAND strategy (the API's catalogue, 2026-09-30) answers only when Solve is pressed and never
      // auto-executes — carried on the config so the session applies it (session.applySessionConfig)
      ...(s.onDemand ? { onDemand: true } : {}),
    },
    ...(s.onDemand ? { onDemand: true } : {}),
    formats: s.formats !== null && s.formats !== undefined ? s.formats : fb ? fb.formats : null,
    defaultFormat: s.defaultFormat || (fb ? fb.default : null) || "ign-zone-NL25",
    formatCoverage: s.formatCoverage ?? null,
    requires,
    ...(chk === null ? { chartFree: true } : {}),
    sites: truthy(s.sites) ? s.sites
      : [...new Set(((truthy(s.formats) ? s.formats : ["ign-"]) as unknown[]).map((f) => (String(f).startsWith("cp-") ? "coinpoker" : String(f).startsWith("cgg-") ? "clubgg" : "ignition")))].sort(),
  };
}

const presetsCache: { at: number; value: Record<string, any> | null; fromApi: boolean; error: string | null; lastGood?: any[]; lastGoodAt?: number } =
  { at: 0.0, value: null, fromApi: false, error: null };

/** Current modes, strategies first. Cached 30 s; a failed refresh keeps the last good catalogue for 15 min. */
export async function presets(refresh = false): Promise<Record<string, any>> {
  const now = time();
  if (!refresh && presetsCache.value !== null && now - presetsCache.at < 30) return presetsCache.value;
  let strategies = await deps.fetchStrategies();
  if (!truthy(strategies) && presetsCache.lastGood && now - (presetsCache.lastGoodAt || 0) < 900) {
    strategies = presetsCache.lastGood;
  } else if (truthy(strategies)) {
    presetsCache.lastGood = strategies!;
    presetsCache.lastGoodAt = now;
  }
  const out: Record<string, any> = {};
  if (truthy(strategies)) {
    for (const s of strategies!) out[STRATEGY_PREFIX + s.id] = strategyPreset(s);
    presetsCache.fromApi = true;
    presetsCache.error = null;
  } else {
    presetsCache.fromApi = false;
    presetsCache.error = `strategy catalogue unreachable: ${API()}/api/dashboard/sources/strategies`;
  }
  for (const k of NO_ANSWER_MODES) out[k] = structuredClone(BASE_PRESETS[k]);
  Object.assign(presetsCache, { at: now, value: out });
  return out;
}

export const presetsFromApi = () => !!presetsCache.fromApi;
export const presetsError = () => presetsCache.error;

export const CHECK_LABELS: Record<string, string> = {
  api: `Study API on :${port("api")}`,
  hrc: `3-max chart server on :${port("charts")}`,
  hrc6max: "6-max ring preflop charts readable",
  exploit: "3-handed Zone 25NL preflop exploit charts armed",
  mes: "MES flop solves loaded",
  gtow: "GTO Wizard session with a live token",
  "gtow-multiway": "GTO Wizard session that can solve multiway",
  recording: "Debug recording directory writable",
  fake: "Launched as the test rig",
  profile: "Account profile declared",
  balance: "Account balance readable",
  net: "Connection fast enough for GTO Wizard answers",
};

/** Python's `v in (None, "", 0, "0")` (0 == 0.0 == False). */
const emptyish = (v: unknown) => v === null || v === undefined || v === "" || v === 0 || v === false || v === "0";

/** str(v) of a JSON value, as Python prints it. */
function strOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

export class PresetUnavailable extends ValueError {}

export async function mergedConfig(preset: string, overrides: Record<string, any> | null | undefined): Promise<any> {
  const p = (await presets())[preset];
  if (p === undefined) {
    throw new PresetUnavailable(`the mode ${pyReprStr(preset)} is not on offer right now — the strategy catalogue (the study API) `
      + "could not be read; wait a few seconds and press Start again");
  }
  const base = structuredClone(p.config);
  for (const [k, v] of Object.entries(overrides || {})) {
    if (k === "sources" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [kk, vv] of Object.entries(v)) base.sources[kk] = truthy(vv);
    } else if (k === "budget" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [kk, vv] of Object.entries(v)) base.budget[kk] = emptyish(vv) ? null : pyInt(vv);
    } else if (["answers", "recording", "autoExecute", "autoRealMoney", "autoTimeBank", "autoTopUp", "autoFoldNoAnswer", "autoSitBackIn", "clearCache"].includes(k)) {
      base[k] = truthy(v);
    } else if (k === "gtowAccounts") {
      // the session's GTO Wizard allowlist (2026-09-27): registry slot ids this session may spend; null = every account
      base.gtowAccounts = Array.isArray(v) && v.length ? v.map((x) => String(x)) : null;
    } else if (k === "autoDelay" && (v === "instant" || v === "random")) {
      base[k] = v;
    } else if (k === "autoBudget" && v && typeof v === "object" && !Array.isArray(v)) {
      base.autoBudget ??= { minutes: 30, hands: 50 };
      for (const kk of ["minutes", "hands"]) {
        if (kk in v) {
          try {
            base.autoBudget[kk] = Math.max(1, pyInt((v as any)[kk]));
          } catch {}
        }
      }
    } else if (k === "format") {
      base[k] = truthy(v) ? strOf(v) : null;
    } else if (k === "site") {
      base[k] = v === "ignition" || v === "coinpoker" || v === "clubgg" ? v : "ignition";
    } else if (k === "cggTable" || k === "cggTitle") {
      base[k] = truthy(v) ? strOf(v).slice(0, 200) : null;
    } else if (k === "cpTable") {
      base[k] = truthy(v) ? strOf(v).slice(0, 200) : null;
    } else if (k === "buyinBb") {
      try {
        base[k] = Math.max(1.0, pyFloat(v));
      } catch {}
    } else if (k === "waitForBb") {
      base[k] = truthy(v);
    } else if (k === "profile") {
      base[k] = truthy(v) ? strOf(v) : null;
    } else if (k === "tables") {
      try {
        const n = pyInt(v);
        base[k] = [1, 2, 4].includes(n) ? n : 1;
      } catch {
        base[k] = 1;
      }
    }
  }
  return base;
}

/** What the DECLARED config needs, not just the preset. */
export async function requirementsFor(preset: string, config: any): Promise<string[]> {
  const pre = (await presets())[preset];
  const req: string[] = [...pre.requires];
  if (truthy(config.answers)) {
    if (!req.includes("api")) req.push("api");
    const src = config.sources || {};
    if (truthy(src.exploitPreflop) && !req.includes("exploit")) req.push("exploit");
    if (truthy(src.mesPostflop) && !req.includes("mes")) req.push("mes");
    if (truthy(src.aiChain) && !req.includes("gtow")) req.push("gtow");
    if (!pre.chartFree && !["hrc", "hrc6max"].some((k) => req.includes(k))) req.push("hrc");
  } else {
    for (const k of ["exploit", "mes", "gtow", "hrc", "hrc6max"]) {
      const i = req.indexOf(k);
      if (i >= 0) req.splice(i, 1);
    }
  }
  if (truthy(config.recording) && !req.includes("recording")) req.push("recording");
  return req;
}

/** Every check the mode needs, each with ok + a one-line reason. Blocks when any REQUIRED check fails. */
export async function runPreflight(preset: string, config: any, fakeMode: boolean, registry: any | null, cdpPort: number | null = null) {
  const req = await requirementsFor(preset, config);
  // a desktop-client site (CoinPoker, ClubGG): no Ignition profile to sign in, no Ignition lobby balance
  const clientSite = config.site === "coinpoker" || config.site === "clubgg";
  if (!fakeMode && !clientSite) for (const k of ["profile"]) if (!req.includes(k)) req.push(k);
  const armed = (registry || {}).armed || {};
  const cards = new Map<string, any>(((registry || {}).cards || []).map((c: any) => [c.id, c]));
  const card = (cid: string) => cards.get(cid) || {};
  const facts = (c: any): [string, any][] => c.facts || [];
  const checks: any[] = [];
  const add = (cid: string, ok: unknown, detail: string, always = false) => {
    if (cid !== "api" && !always && !req.includes(cid)) return;
    checks.push({ id: cid, label: CHECK_LABELS[cid], required: req.includes(cid), ok: truthy(ok), detail });
  };

  add("api", registry !== null && registry !== undefined, "reachable · " + (truthy(registry)
    ? `poller ${truthy((armed.poller || {}).running) ? "running" : "stopped"}` : `no reply from ${API()}`));
  const hrc = armed.hrc || {};
  add("hrc", truthy(hrc.up), truthy(registry) ? `${truthy(hrc.up) ? "up" : "down"} · probe ${pyStr(getd(hrc, "ms", "?"))} ms` : "unknown (API down)");
  const hrc6 = armed.hrc6max || {};
  if (!truthy(registry)) add("hrc6max", false, "unknown (API down)");
  else if (truthy(hrc6.db)) add("hrc6max", true, `baked DB · ${pyStr(getd(hrc6, "trees", "?"))} trees · :8777 not needed`);
  else if (truthy(hrc.up)) add("hrc6max", true, `no local bake — every node from :8777 (${pyStr(getd(hrc, "ms", "?"))} ms; run build_6max_preflop_db.py)`);
  else add("hrc6max", false, "no local bake on the API's machine and :8777 is down — nothing can serve the ring charts");
  const ex = card("exploit-preflop");
  add("exploit", truthy(armed.exploitPreflop), (ex.stateText || "unknown")
    + (Object.keys(ex).length ? " · " + (facts(ex).find(([k]) => k === "freshness")?.[1] ?? "") : ""));
  const mes = card("mes-postflop");
  add("mes", truthy(armed.mesPostflop), truthy(registry)
    ? `${pyStr(getd(armed, "mesBoards", 0))} boards · ` + (facts(mes).find(([k]) => k === "generation")?.[1] ?? "") : "unknown (API down)");
  const g = armed.gtow || {};
  const gsess: any[] = g.sessions || [];
  const sessLine = (x: any) => {
    const mins = x.expiresInMs;
    const state = x.state;
    const tail = state === "up" && truthy(mins) ? `${pyRound(mins / 60000)} min` : (x.blockedReason || x.text || state);
    return `${pyStr(x.id ?? null)} (${truthy(x.multiway) ? "multiway" : "heads-up"}): ${pyStr(tail ?? null)}`;
  };
  const summary = gsess.length
    ? gsess.filter((x) => truthy(x.enabled)).map(sessLine).join(" · ")
    : truthy(g.tokenLive) ? "token live" + (truthy(g.expiresInMs) ? ` · ${pyRound((g.expiresInMs || 0) / 60000)} min left` : "") : "";
  add("gtow", truthy(g.tokenLive), truthy(g.tokenLive) ? summary
    : truthy(g.clientUp) ? (summary || "a client is up but no session has a token — sign in (or enter the activation code) in its window")
    : (summary || "no session reachable — start one: scripts/start_gtow_chrome.ps1 or scripts/start_gtow_secondary.ps1"));
  if (checks.length && checks[checks.length - 1].id === "gtow") {
    // EVERY account the API knows, disabled ones included (enabled: false) — the panel's Connection list shows the
    // whole pool; the setup page's rows keep to the enabled ones
    checks[checks.length - 1].sessions = gsess.map((x) => ({
      id: x.id ?? null, label: x.label ?? null, state: x.state ?? null, text: x.text ?? null, multiway: truthy(x.multiway),
      expiresInMs: x.expiresInMs ?? null, cdpHost: x.cdpHost ?? null, blockedReason: x.blockedReason ?? null,
      enabled: truthy(x.enabled), tokenLive: truthy(x.tokenLive), trees: x.trees ?? null,
      account: x.account ?? null, accountId: x.accountId ?? null,
    }));
  }
  if (req.includes("gtow")) {
    const mw = truthy(g.multiwayLive);
    const mwSess = gsess.filter((x) => truthy(x.multiway) && truthy(x.enabled));
    add("gtow-multiway", mw, mw
      ? "via " + mwSess.filter((x) => x.state === "up").map((x) => pyStr(x.id ?? null)).join(", ")
      : "no session can solve a 3+ player tree — heads-up spots still answer, multiway ones will not"
        + (mwSess.length ? ` (${mwSess.map((x) => x.blockedReason || x.text || "").join("; ")})` : ""), true);
  }
  const dbg = paths().debug;
  try {
    mkdirSync(dbg, { recursive: true });
    const probe = join(dbg, ".write-probe");
    writeFileSync(probe, "ok", "utf8");
    unlinkSync(probe);
    add("recording", true, dbg);
  } catch (e: any) {
    add("recording", false, `${dbg}: ${e?.message || e}`);
  }
  add("fake", fakeMode, fakeMode ? "this instance is the fake-table rig" : "launch with FAKE_TABLE=1 for the test rig");
  const profile = config.profile;
  add("profile", truthy(profile), truthy(profile) ? `playing as ${profile}`
    : "pick the account on the setup page — hands are attributed to it and its balance is reconciled against them");
  if (!fakeMode && !clientSite) {
    const bal = cdpPort ? await deps.scrapeCached(cdpPort) : { ok: false, reason: "no CDP port" };
    const last = truthy(profile) ? deps.latestBalance(profile) : null;
    const reason = String(bal.reason || "");
    const clientDown = !bal.ok && /no Ignition client|CDP port|no CDP|not open|signed[- ]out|login/i.test(reason);
    const whenLast = last && last.ts ? strftime("%d %b %H:%M", last.ts / 1000) : null;
    let ok: boolean, detail: string;
    if (bal.ok) {
      ok = true;
      detail = `${balances.fmt(bal.amountCents)} read from the lobby (${bal.how ?? "None"})`;
    } else if (clientDown) {
      ok = true;
      detail = "client not open yet — read automatically at Start once it is signed in"
        + (last ? ` · last reading ${balances.fmt(last.amountCents)} on ${whenLast}` : " · first reading for this profile = its seed");
    } else {
      ok = false;
      detail = `client is open but no balance could be read (${reason || "unknown"}) — the session's money would be unreconciled`;
    }
    checks.push({ id: "balance", label: CHECK_LABELS.balance, required: false, ok, detail });
  }
  if (truthy(config.answers) && !fakeMode) {
    const nc = await deps.netCached();
    checks.push({ id: "net", label: CHECK_LABELS.net, required: true, ok: !!nc.ok, detail: nc.detail, probe: nc });
    if (!req.includes("net")) req.push("net");
  }
  const blockers = checks.filter((c) => c.required && !c.ok);
  return { ok: !blockers.length, checks, blockers: blockers.map((c) => c.label), requires: req };
}

/** Every source version in force at Start — what 'the study tool' WAS for this session. */
export function versionsSnapshot(registry: any | null): any {
  const out: any = { capturedAt: nowMs() };
  out.wrapperGit = deps.gitHead();
  if (!truthy(registry)) {
    out.api = null;
    return out;
  }
  const armed = registry.armed || {};
  const facts: Record<string, Record<string, any>> = {};
  for (const c of registry.cards || []) facts[c.id] = Object.fromEntries(c.facts || []);
  const f = (id: string, k: string) => (facts[id] || {})[k] ?? null;
  out.api = { at: registry.at ?? null, strategyMode: armed.strategyMode ?? null };
  out.exploitPreflop = { armed: truthy(armed.exploitPreflop), ...Object.fromEntries(["file", "fit to", "freshness"].map((k) => [k, f("exploit-preflop", k)])) };
  out.mesPostflop = { loaded: truthy(armed.mesPostflop), boards: armed.mesBoards ?? null,
                      ...Object.fromEntries(["families", "generation", "built"].map((k) => [k, f("mes-postflop", k)])) };
  out.hrc = { up: truthy((armed.hrc || {}).up), ...Object.fromEntries(["charts", "re-solved rungs"].map((k) => [k, f("hrc-3max", k)])) };
  out.hrc6max = { db: truthy((armed.hrc6max || {}).db), trees: (armed.hrc6max || {}).trees ?? null,
                  ...Object.fromEntries(["served by", "progress"].map((k) => [k, f("hrc-6max", k)])) };
  out.gtowCharts = Object.fromEntries(["sets", "freshness"].map((k) => [k, f("gtow-charts", k)]));
  const g = armed.gtow || {};
  out.gtow = {
    tokenLive: truthy(g.tokenLive), multiwayLive: truthy(g.multiwayLive),
    sessions: (g.sessions || []).filter((x: any) => truthy(x.enabled)).map((x: any) => ({
      id: x.id ?? null, state: x.state ?? null, multiway: truthy(x.multiway), expiresInMs: x.expiresInMs ?? null, text: x.text ?? null,
    })),
  };
  return out;
}

// --------------------------------------------------------------------- store
const DDL = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  preset TEXT,
  label TEXT,
  note TEXT,
  config TEXT,
  preflight TEXT,
  versions TEXT,
  events TEXT,
  summary TEXT
)`;

const KEYS = ["id", "started_at", "ended_at", "preset", "label", "note", "config", "preflight", "versions", "events", "summary"];

/** json.dumps as Python writes these columns (the API and older rows read the same text). */
const dumps = (v: unknown) => pyJsonDumps(v);

export class SessionStore {
  path: string;

  constructor(path?: string) {
    this.path = path || paths().sessionsDb;
  }

  private db(): Database {
    const c = openStore(this.path, { busyMs: 15000 });
    c.run(DDL);
    return c;
  }

  private with<T>(f: (c: Database) => T): T {
    const c = this.db();
    try {
      return f(c);
    } finally {
      c.close();
    }
  }

  static row(r: any): any | null {
    if (!r) return null;
    const d: any = {};
    for (const k of KEYS) d[k] = r[k] ?? null;
    for (const k of ["config", "preflight", "versions", "events", "summary"]) {
      try {
        d[k] = d[k] ? JSON.parse(d[k]) : null;
      } catch {
        d[k] = null;
      }
    }
    return d;
  }

  start(sid: string, preset: string, label: string | null, note: string | null, config: any, preflight: any, versions: any): any {
    this.with((c) => {
      c.query("INSERT INTO sessions (id, started_at, preset, label, note, config, preflight, versions, events) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(sid, nowMs(), preset, label ?? null, note ?? null, dumps(config), dumps(preflight), dumps(versions), "[]");
    });
    return this.get(sid);
  }

  setConfig(sid: string, config: any): void {
    this.with((c) => c.query("UPDATE sessions SET config=? WHERE id=?").run(dumps(config), sid));
  }

  /** Append one event (read-modify-write under BEGIN IMMEDIATE: four tables write this store at once). The
   *  event's own kind and time win; a colliding payload key is kept under a payload_ prefix. */
  event(sid: string, kind: string, data: Record<string, any> | null = null): void {
    this.with((c) => {
      c.run("BEGIN IMMEDIATE");
      try {
        const r: any = c.query("SELECT events FROM sessions WHERE id=?").get(sid);
        const ev = r && r.events ? JSON.parse(r.events) : [];
        const payload: Record<string, any> = {};
        for (const [k, v] of Object.entries(data || {})) payload[k === "at" || k === "kind" ? `payload_${k}` : k] = v;
        ev.push({ ...payload, at: nowMs(), kind });
        c.query("UPDATE sessions SET events=? WHERE id=?").run(dumps(ev), sid);
        c.run("COMMIT");
      } catch (e) {
        try { c.run("ROLLBACK"); } catch {}
        throw e;
      }
    });
  }

  end(sid: string, summary: any, note: string | null | undefined): any {
    this.with((c) => {
      if (note !== null && note !== undefined) {
        c.query("UPDATE sessions SET ended_at=?, summary=?, note=? WHERE id=?").run(nowMs(), dumps(summary), note, sid);
      } else {
        c.query("UPDATE sessions SET ended_at=?, summary=? WHERE id=?").run(nowMs(), dumps(summary), sid);
      }
    });
    return this.get(sid);
  }

  get(sid: string): any | null {
    return this.with((c) => SessionStore.row(c.query("SELECT * FROM sessions WHERE id=?").get(sid)));
  }

  openSession(): any | null {
    const rows = this.openSessions();
    return rows.length ? rows[0] : null;
  }

  openSessions(): any[] {
    return this.with((c) => c.query("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC").all().map(SessionStore.row));
  }

  list(limit = 50): any[] {
    return this.with((c) => c.query("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit).map(SessionStore.row));
  }
}

export function newSessionId(): string {
  return strftime("session_%Y%m%d_%H%M%S");
}

