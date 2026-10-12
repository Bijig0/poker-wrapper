// SHARED WITH THE CHART FACTORY (setup/shared-with-factory.json): edit it in poker-wrapper only — the factory takes it with `bun scripts/sync_from_wrapper.ts`.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AutoStatus } from "./autoRestart";
import type { CodeStatus } from "./loadedCode";
import { livePort } from "./ports";
import { SUPERVISOR_PROTOCOL, pidAlive, readStamp, requestPath, stillRefused, supervisorNeed } from "./supervisorRestart";

/**
 * WHAT IS LIVE, in one answer: every long-lived process of this install, which commit it runs, and whether it is
 * behind the disk. The dashboard banner, the wrapper's "Running the current code" check and `bun setup/live.ts` all
 * read this, so "is my change live?" has one place to look instead of a process list and a guess.
 *
 *   services     the API, the chart server, each wrapper table that is up — each answers /build itself — and, on a
 *                machine that also runs the chart factory, its API (FACTORY_API_URL in config/local.env)
 *   supervisors  the PowerShell scripts that keep them alive. A supervisor reads its script, config/env.ps1 and
 *                config/local.env when it starts, and writes data/jobs/supervisor-<name>.json (the files it read,
 *                hashed); changed = the file on disk no longer matches. Since 2026-10-10 (stamp protocol 2) the API
 *                and chart supervisors re-read env.ps1 + local.env before every worker start, and every supervisor
 *                replaces itself when no session is live (services/supervisorRestart.ts) — so "behind" is a state
 *                that clears by itself, and the line says when.
 *
 * The chart factory runs a copy of this file (setup/shared-with-factory.json). Its API reports in its /api/build which
 * shared files it is behind poker-wrapper's main on (`shared`), and its line here says so — not current — until
 * `bun scripts/sync_from_wrapper.ts --commit` has run in the factory checkout.
 */

/** This file's own checkout: <repo>/gto-trainer/apps/api/src/services. */
const API_DIR = resolve(import.meta.dir, "..", "..");

/** What a service answers on its build route (the API: /api/build; charts: /api/build; the wrapper: /build). */
export interface ServiceBuild extends CodeStatus {
  ok: boolean;
  service: string;
  supervised: boolean;
  auto: AutoStatus;
  /** the factory's API hands its own supervisor's line along (it lives in another checkout) */
  supervisor?: SupervisorLine;
  /** the factory's API: its copies of setup/shared-with-factory.json's files against poker-wrapper's main */
  shared?: SharedDrift;
}

/**
 * The chart factory's copies of the shared files (setup/shared-with-factory.json), as its API sees them against
 * poker-wrapper's main. Until 2026-10-13 nothing compared them: the factory ran the 10-03 copies for ten days while
 * the product changed them three times (supervisors restarting themselves, the post-sleep restart).
 */
export interface SharedDrift {
  /** poker-wrapper's main compared against; null when the factory could not read that checkout */
  wrapperHead: string | null;
  /** copies that are an older version of poker-wrapper's, or missing: a sync brings them up to date */
  behind: string[];
  /** copies that match no version of poker-wrapper's: edited in the factory — move the edit to poker-wrapper */
  diverged: string[];
  error?: string;
}

const sharedOff = (s: SharedDrift | undefined): number => (s ? s.behind.length + s.diverged.length : 0);

/** The shared-code clause of a factory line, or "". */
export function describeShared(s: SharedDrift | undefined): string {
  if (!s) return "";
  const names = (xs: string[]) => xs.map((p) => p.split("/").pop()).slice(0, 4).join(", ") + (xs.length > 4 ? ` +${xs.length - 4} more` : "");
  const parts: string[] = [];
  if (s.behind.length) parts.push(`SHARED CODE BEHIND poker-wrapper ${short(s.wrapperHead)} (${names(s.behind)}) — run \`bun scripts/sync_from_wrapper.ts --commit\` in the factory checkout`);
  if (s.diverged.length) parts.push(`SHARED CODE EDITED IN THE FACTORY (${names(s.diverged)}) — move the edit to poker-wrapper, then sync`);
  if (!parts.length && s.error) parts.push(`shared code not checked: ${s.error}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export interface ServiceLine {
  name: string;
  port: number;
  up: boolean;
  /** up, and running what is on disk */
  current: boolean;
  /** one line for a person */
  text: string;
  build: ServiceBuild | null;
  /** the process that produced this answer */
  self?: boolean;
}

export interface SupervisorLine {
  name: string;
  pid: number | null;
  alive: boolean;
  startedAt: string | null;
  /** files it read at start that have other content now */
  changed: string[];
  current: boolean;
  text: string;
  /** behind, and it will restart itself (stamp protocol 2, AUTO_RESTART on): nothing for a person to do */
  selfRestart?: boolean;
}

export interface LiveStatus {
  /** the checkout's commit now */
  head: string | null;
  /** every service up is current, and no supervisor is behind its script */
  current: boolean;
  services: ServiceLine[];
  supervisors: SupervisorLine[];
}

/** The process asking: its own build goes in as it is, instead of a request to itself. */
export interface Self { port: number; build: ServiceBuild }

const short = (c: string | null | undefined) => (c ? c.slice(0, 7) : "no commit");

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** The sentence for one service's build reply. */
export function describeBuild(b: ServiceBuild, now = Date.now()): string {
  const head = `${short(b.commit)} · up ${ago(b.bootAt, now)}`;
  if (!b.stale) {
    // running what is on disk, but the process itself wants replacing (services/runtimeHealth.ts)
    const a = b.auto;
    if (a?.reason === "runtime-degraded" && a.state !== "current" && a.why) return `${head} · current · DEGRADED [${a.state}] ${a.why}`;
    return `${head} · current`;
  }
  const files = b.changed.slice(0, 3).join(", ") + (b.changedCount > 3 ? ` +${b.changedCount - 3} more` : "");
  const st = b.auto?.state;
  // the auto-restart's own sentence when it has looked; before its first tick only the files are known
  if (st && st !== "current" && b.auto.why) return `${head} · BEHIND THE DISK [${st}] ${b.auto.why}`;
  return `${head} · BEHIND THE DISK: ${b.changedCount} loaded file(s) changed (${files})`;
}

/** A service's line from its own build reply. The factory's is not current while its shared code is off. */
export function lineOf(name: string, port: number, build: ServiceBuild, self = false): ServiceLine {
  return {
    name, port, up: true, current: !build.stale && !sharedOff(build.shared), build,
    text: describeBuild(build) + describeShared(build.shared), ...(self ? { self: true } : {}),
  };
}

async function ask(name: string, base: string, port: number, path: string, timeoutMs: number): Promise<ServiceLine | null> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    const refused = /ConnectionRefused|ECONNREFUSED/i.test(String(e?.code ?? "")) || /refused|unable to connect/i.test(String(e?.message ?? ""));
    if (refused) return null;
    return { name, port, up: false, current: false, build: null, text: `not answering (${String(e?.name ?? e?.message ?? e).slice(0, 60)})` };
  }
  let b: any = null;
  try { b = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !b || typeof b.stale !== "boolean" || !("commit" in b)) {
    // a process started before 2026-10-03 has no build report (or the old one): that alone says it is old code
    const how = name.startsWith("wrapper") ? "relaunch Poker Wrapper from its shortcut (when no session is running)" : "restart it";
    return { name, port, up: true, current: false, build: null, text: `up, but running code from before the build report existed — ${how}` };
  }
  return lineOf(name, port, b as ServiceBuild);
}

/** The supervisors this install runs: stamp name → what it keeps alive. */
export const SUPERVISORS: Record<string, string> = { api: "the API", charts: "the chart server", gtow: "the GTO Wizard clients" };

export function supervisorLine(name: string, jobsDir = join(API_DIR, "data", "jobs"), env: NodeJS.ProcessEnv = process.env): SupervisorLine {
  const j = readStamp(name, jobsDir);
  if (!j) {
    return { name, pid: null, alive: false, startedAt: null, changed: [], current: false,
      text: "no start stamp — it was started before stamps existed (or is not installed); its script and config cannot be checked until it restarts" };
  }
  const pid = j.pid;
  const alive = pid !== null && pidAlive(pid);
  const need = supervisorNeed(j);
  const changed = need ? need.files : [];
  const off = /^(off|0|false|no)$/i.test((env.AUTO_RESTART ?? "").trim());
  const refused = !!need && stillRefused(j);
  const selfRestart = alive && !!need && j.protocol >= SUPERVISOR_PROTOCOL && !off && !refused;
  const asked = existsSync(requestPath(name, jobsDir)) ? " · restart requested" : "";
  const tail = !need ? ""
    : j.protocol < SUPERVISOR_PROTOCOL ? `this supervisor started before it could restart itself — restart it by hand once (CLAUDE.md, "What is live")`
    : off ? `AUTO_RESTART=off — restart the supervisor by hand (CLAUDE.md, "What is live")`
    : refused ? `it refused the change and keeps the old one: ${j.refused!.why} — fix the file`
    : `will restart itself when no session is live (AUTO_RESTART)${asked}`;
  const text = !alive ? `not running (last started ${j.startedAt ?? "?"}, pid ${pid ?? "?"})`
    : need ? `pid ${pid} · BEHIND THE DISK: ${need.why} since it started ${j.startedAt ?? "?"} — ${tail}`
    : `pid ${pid} · started ${j.startedAt ?? "?"} · current`;
  return { name, pid, alive, startedAt: j.startedAt, changed, current: alive && !need, text, ...(need && alive ? { selfRestart } : {}) };
}

/**
 * A supervisor line with what its restart is doing right now: the worker it runs decides (the API's / chart server's
 * auto status, `reason` env-changed / supervisor-changed), and the API decides for the watchdog (`auto.others`).
 */
export function withAutoState(line: SupervisorLine, auto: { state: string; why: string } | null | undefined): SupervisorLine {
  if (line.current || !line.selfRestart || !auto) return line;
  const held = /restart held: (.*)$/.exec(auto.why)?.[1];
  const now = auto.state === "held" && held ? `held — ${held}` : auto.state === "settling" ? "restarting within a minute" : auto.state;
  return { ...line, text: `${line.text} · now: ${now}` };
}

/** Everything up is current and no supervisor is behind. A supervisor without a stamp is unknown, not behind. */
export const allCurrent = (services: ServiceLine[], supervisors: SupervisorLine[]): boolean =>
  services.every((s) => s.current) && supervisors.every((s) => s.current || s.pid === null);

/**
 * Every service and supervisor of this install. `self` is the process asking: its line is its own build, marked
 * `self`, whatever port it serves (a rig on another port is listed as "this one", beside the install's own).
 * A wrapper table that is not running is simply not listed (no session = no wrapper is normal); the API and the
 * chart server not answering is a line of its own.
 */
export async function liveStatus(self: Self | null = null, env: NodeJS.ProcessEnv = process.env): Promise<LiveStatus> {
  const down = (name: string, port: number): ServiceLine => ({ name, port, up: false, current: false, build: null, text: "not running" });
  const local = (p: number) => `http://127.0.0.1:${p}`;
  const one = (name: string, p: number, path: string, timeoutMs: number): Promise<ServiceLine | null> =>
    self && self.port === p ? Promise.resolve(lineOf(name, p, self.build, true)) : ask(name, local(p), p, path, timeoutMs);
  const apiPort = livePort("api", env), chartsPort = livePort("charts", env), panel = livePort("panel", env);
  // the chart factory's API, where there is one (the owner's machine): another checkout, asked over HTTP only
  const factoryUrl = (env.FACTORY_API_URL ?? "").trim().replace(/\/+$/, "");
  const factoryPort = Number(/:(\d+)$/.exec(factoryUrl)?.[1] ?? 0);
  const [api, charts, factory, ...tables] = await Promise.all([
    one("api", apiPort, "/api/build?force=1", 4_000),
    one("charts", chartsPort, "/api/build?force=1", 4_000),
    factoryUrl ? ask("factory", factoryUrl, factoryPort, "/api/build?force=1", 4_000).then((l) => l ?? down("factory", factoryPort)) : Promise.resolve(null),
    ...[0, 1, 2, 3].map((i) => one(i === 0 ? "wrapper" : `wrapper table ${i + 1}`, panel + 10 * i, "/build?force=1", 3_000)),
  ]);
  const services = [api ?? down("api", apiPort), charts ?? down("charts", chartsPort), ...tables.filter((t): t is ServiceLine => t !== null)];
  if (factory) services.push(factory);
  // a process on a port of its own (a verify API, a test rig, a CoinPoker panel) still answers for itself
  if (self && !services.some((s) => s.self)) services.push(lineOf(`${self.build.service} :${self.port} (this one)`, self.port, self.build, true));
  // what each restart is doing now: the API's and the chart server's own decisions, the API's for the watchdog
  const autoOf = (svc: ServiceLine | null | undefined) => {
    const a = svc?.build?.auto;
    return a && (a.reason === "env-changed" || a.reason === "supervisor-changed") ? a : null;
  };
  const apiLine = services.find((s) => s.name === "api");
  const decided: Record<string, { state: string; why: string } | null> = {
    api: autoOf(apiLine), charts: autoOf(services.find((s) => s.name === "charts")), gtow: apiLine?.build?.auto?.others?.gtow ?? null,
  };
  const supervisors = Object.keys(SUPERVISORS).map((n) => withAutoState(supervisorLine(n, undefined, env), decided[n]));
  if (factory?.build?.supervisor) supervisors.push({ ...factory.build.supervisor, name: "factory" });
  const head = services.find((s) => s.self)?.build?.head ?? services.map((s) => s.build?.head).find((h) => !!h) ?? null;
  return { head, current: allCurrent(services, supervisors), services, supervisors };
}
