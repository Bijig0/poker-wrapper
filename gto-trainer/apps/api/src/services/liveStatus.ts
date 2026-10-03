import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoStatus } from "./autoRestart";
import type { CodeStatus } from "./loadedCode";
import { livePort, port } from "./ports";
import { API_DIR, REPO } from "./repoPaths";

/**
 * WHAT IS LIVE, in one answer: every long-lived process of this install, which commit it runs, and whether it is
 * behind the disk. The dashboard banner, the wrapper's "Running the current code" check and `bun setup/live.ts` all
 * read this, so "is my change live?" has one place to look instead of a process list and a guess.
 *
 *   services     the API, the chart server, and each wrapper table that is up — each answers /build itself
 *   supervisors  the PowerShell scripts that keep them alive. A supervisor reads its script, config/env.ps1 and
 *                config/local.env ONCE, at start, so a fix to any of those needs the supervisor restarted, not the
 *                worker. Each writes data/jobs/supervisor-<name>.json (the files it read, hashed) when it starts;
 *                changed = the file on disk no longer matches.
 */

/** What a service answers on its build route (the API: /api/build; charts: /api/build; the wrapper: /build). */
export interface ServiceBuild extends CodeStatus {
  ok: boolean;
  service: string;
  supervised: boolean;
  auto: AutoStatus;
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

async function ask(name: string, port: number, path: string, timeoutMs: number): Promise<ServiceLine | null> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    const refused = /ConnectionRefused|ECONNREFUSED/i.test(String(e?.code ?? "")) || /refused|unable to connect/i.test(String(e?.message ?? ""));
    if (refused) return null;
    return { name, port, up: false, current: false, build: null, text: `not answering (${String(e?.name ?? e?.message ?? e).slice(0, 60)})` };
  }
  let b: any = null;
  try { b = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !b || typeof b.stale !== "boolean" || !("commit" in b)) {
    // a process started before 2026-10-03 has no build report (or the old one): that alone says it is old code
    return { name, port, up: true, current: false, build: null, text: "up, but running code from before the build report existed — restart it" };
  }
  return { name, port, up: true, current: !b.stale, build: b as ServiceBuild, text: describeBuild(b as ServiceBuild) };
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

/**
 * Every service and supervisor of this install. `known.api` lets the API hand in its own line instead of calling
 * itself. A wrapper table that is not running is simply not listed (no session = no wrapper is normal); the API and
 * the chart server not answering is a line of its own.
 */
export async function liveStatus(known: { api?: ServiceBuild } = {}, env: NodeJS.ProcessEnv = process.env): Promise<LiveStatus> {
  const down = (name: string, port: number): ServiceLine => ({ name, port, up: false, current: false, build: null, text: "not running" });
  const apiPort = livePort("api", env), chartsPort = livePort("charts", env), panel = livePort("panel", env);
  const [api, charts, ...tables] = await Promise.all([
    known.api
      // the caller's own line carries the port IT serves (a verify API beside the live one is not :2000)
      ? Promise.resolve<ServiceLine>({ name: "api", port: port("api", env), up: true, current: !known.api.stale, build: known.api, text: describeBuild(known.api) })
      : ask("api", apiPort, "/api/build?force=1", 4_000),
    ask("charts", chartsPort, "/api/build?force=1", 4_000),
    ...[0, 1, 2, 3].map((i) => ask(i === 0 ? "wrapper" : `wrapper table ${i + 1}`, panel + 10 * i, "/build?force=1", 3_000)),
  ]);
  const services = [api ?? down("api", apiPort), charts ?? down("charts", chartsPort), ...tables.filter((t): t is ServiceLine => t !== null)];
  const supervisors = Object.keys(SUPERVISORS).map((n) => supervisorLine(n));
  const head = services.map((s) => s.build?.head).find((h) => !!h) ?? null;
  return {
    head,
    // a supervisor without a stamp is unknown, not behind: it does not make the whole answer red
    current: services.every((s) => s.current) && supervisors.every((s) => s.current || s.pid === null),
    services, supervisors,
  };
}
