/**
 * IS THIS WRAPPER RUNNING THE CODE ON DISK (2026-10-03).
 *
 * Launching the wrapper replaces the running instance, so a fresh launch is always the code on disk — but a wrapper
 * left open between sessions keeps the code it started with while fixes are merged, and nothing said so. The stamp is
 * the files this process loaded (the API's services/loadedCode.ts: the import graph from main.ts plus the src/js
 * snippets, which are read once and kept), taken when this module is imported, before the server answers.
 *
 *   GET  /build           this process: commit, booted, stale files, and whether the change is committed
 *   GET  /build/all       the whole install — API, chart server, wrapper tables, supervisors (services/liveStatus.ts)
 *   POST /build/relaunch  start the launcher again; the new instance replaces this one (refused during a session)
 *
 * Nothing supervises the wrapper, so it never restarts itself: the setup page shows the row and offers the button.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AutoRestart } from "../../api/src/services/autoRestart";
import { liveStatus, type LiveStatus, type ServiceBuild } from "../../api/src/services/liveStatus";
import { LoadedCode } from "../../api/src/services/loadedCode";
import { C } from "./config";
import { log } from "./feed";
import { S } from "./state";
import * as TABLES from "./tables";
import * as W from "./win32";

export const wrapperCode = new LoadedCode({ entry: join(import.meta.dir, "main.ts"), extra: [join(import.meta.dir, "js")] });

/** The decision an API worker acts on, used here only to SAY which kind of change is waiting (it never exits). */
const auto = new AutoRestart({
  code: wrapperCode,
  name: "wrapper",
  supervised: () => false,
  busy: async () => null,
  byHand: "relaunch the Poker Wrapper to load it (its shortcut, or Relaunch on the setup page) — a session in progress keeps the code it started with",
  log,
});

export async function buildReply(force = false): Promise<ServiceBuild> {
  const status = wrapperCode.status(force);
  return { ok: true, service: TABLES.slot() !== null ? `wrapper table ${TABLES.slot()}` : "wrapper", ...status, supervised: false, auto: await auto.tick() };
}

export async function buildAll(): Promise<LiveStatus & { ok: true; sessionActive: boolean }> {
  // this wrapper hands in its own line: on a rig or a second site's panel port it is "this one", not the install's :7700
  return { ok: true, sessionActive: !!S.session.rec, ...(await liveStatus({ port: C.PANEL_PORT, build: await buildReply(true) })) };
}

/** The launcher the desktop shortcut runs; a sandboxed copy of the pages (WRAPPER_ROOT, the tests) has none. */
const launcher = () => join(C.ROOT, "run-wrapper.vbs");

/** Start the launcher with this process's own arguments. The new instance asks this one to stand down (app.ts takeover). */
export function relaunch(): [number, Record<string, any>] {
  if (S.session.rec) return [409, { ok: false, why: "a session is running — end it first; it keeps the code it started with" }];
  if (TABLES.slot() !== null) return [409, { ok: false, why: "this is an extra table's process — relaunch the wrapper from its first table" }];
  if (!existsSync(launcher())) return [409, { ok: false, why: `no launcher at ${launcher()}` }];
  const args = process.argv.slice(2);
  log(`[build] relaunch asked — starting ${launcher()} ${args.join(" ")}; the new instance replaces this one`);
  const wscript = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const pid = W.startDetached(wscript, [launcher(), ...args], { cwd: C.ROOT, hide: true }, log);
  return pid ? [200, { ok: true, relaunching: true }] : [500, { ok: false, why: "the launcher could not be started" }];
}
