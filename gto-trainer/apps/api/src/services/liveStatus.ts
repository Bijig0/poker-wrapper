import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AutoStatus } from "./autoRestart";
import type { CodeStatus } from "./loadedCode";
import { livePort } from "./ports";

/**
 * WHAT IS LIVE, in one answer: every long-lived process of this install, which commit it runs, and whether it is
 * behind the disk. The dashboard banner, the wrapper's "Running the current code" check and `bun setup/live.ts` all
 * read this, so "is my change live?" has one place to look instead of a process list and a guess.
 *
 *   services     the API, the chart server, each wrapper table that is up — each answers /build itself — and, on a
 *                machine that also runs the chart factory, its API (FACTORY_API_URL in config/local.env)
 *   supervisors  the PowerShell scripts that keep them alive. A supervisor reads its script, config/env.ps1 and
 *                config/local.env ONCE, at start, so a fix to any of those needs the supervisor restarted, not the
 *                worker. Each writes data/jobs/supervisor-<name>.json (the files it read, hashed) when it starts;
 *                changed = the file on disk no longer matches.
 *
 * This file is the same in the poker-wrapper repo and the chart factory's (poker): keep the two copies identical.
 */

/** This file's own checkout: <repo>/gto-trainer/apps/api/src/services. */
const API_DIR = resolve(import.meta.dir, "..", "..");
const REPO = resolve(API_DIR, "..", "..", "..");

/** What a service answers on its build route (the API: /api/build; charts: /api/build; the wrapper: /build). */
export interface ServiceBuild extends CodeStatus {
  ok: boolean;
  service: string;
  supervised: boolean;
  auto: AutoStatus;
  /** the factory's API hands its own supervisor's line along (it lives in another checkout) */
  supervisor?: SupervisorLine;
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
  if (!b.stale) return `${head} · current`;
  const files = b.changed.slice(0, 3).join(", ") + (b.changedCount > 3 ? ` +${b.changedCount - 3} more` : "");
  const st = b.auto?.state;
  // the auto-restart's own sentence when it has looked; before its first tick only the files are known
  if (st && st !== "current" && b.auto.why) return `${head} · BEHIND THE DISK [${st}] ${b.auto.why}`;
  return `${head} · BEHIND THE DISK: ${b.changedCount} loaded file(s) changed (${files})`;
}

/** A service's line from its own build reply. */
export function lineOf(name: string, port: number, build: ServiceBuild, self = false): ServiceLine {
  return { name, port, up: true, current: !build.stale, build, text: describeBuild(build), ...(self ? { self: true } : {}) };
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

const sha256 = (file: string): string | null => {
  try { return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex").toLowerCase(); } catch { return null; }
};

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** The supervisors this install runs: stamp name → what it keeps alive. */
export const SUPERVISORS: Record<string, string> = { api: "the API", charts: "the chart server", gtow: "the GTO Wizard clients" };

export function supervisorLine(name: string, jobsDir = join(API_DIR, "data", "jobs")): SupervisorLine {
  let j: any;
  try {
    // PowerShell 5.1 writes UTF-8 with a BOM
    j = JSON.parse(readFileSync(join(jobsDir, `supervisor-${name}.json`), "utf8").replace(/^﻿/, ""));
  } catch {
    return { name, pid: null, alive: false, startedAt: null, changed: [], current: false,
      text: "no start stamp — it was started before stamps existed (or is not installed); its script and config cannot be checked until it restarts" };
  }
  const pid = Number(j.pid) || null;
  const alive = pid !== null && pidAlive(pid);
  const changed: string[] = [];
  for (const [file, was] of Object.entries<string>(j.files ?? {})) {
    if (sha256(file) !== String(was).toLowerCase()) changed.push(file.startsWith(REPO) ? file.slice(REPO.length + 1).replace(/\\/g, "/") : file);
  }
  const text = !alive ? `not running (last started ${j.startedAt ?? "?"}, pid ${pid ?? "?"})`
    : changed.length ? `pid ${pid} · BEHIND THE DISK: ${changed.join(", ")} changed since it started ${j.startedAt ?? "?"} — restart the supervisor (CLAUDE.md, "What is live")`
    : `pid ${pid} · started ${j.startedAt ?? "?"} · current`;
  return { name, pid, alive, startedAt: j.startedAt ?? null, changed, current: alive && !changed.length, text };
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
  const supervisors = Object.keys(SUPERVISORS).map((n) => supervisorLine(n));
  if (factory?.build?.supervisor) supervisors.push({ ...factory.build.supervisor, name: "factory" });
  const head = services.find((s) => s.self)?.build?.head ?? services.map((s) => s.build?.head).find((h) => !!h) ?? null;
  return { head, current: allCurrent(services, supervisors), services, supervisors };
}
