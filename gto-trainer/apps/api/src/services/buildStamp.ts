import { statSync } from "node:fs";
import { join } from "node:path";
import { AutoRestart, liveSessionReason } from "./autoRestart";
import { liveBusy } from "./livePriority";
import { LoadedCode } from "./loadedCode";

/**
 * IS THIS API STILL RUNNING THE CODE ON DISK — and what happens about it.
 *
 * The API runs under its supervisor without --watch (deliberately: a --watch worker crash leaves the watcher alive
 * and hides the failure). So an edit changes nothing until the process restarts. On 2026-09-19 that process stayed
 * up from 19:54 while four separate fixes landed on disk unread, and the one that mattered most (two pollers
 * answering one table, every decision solved and rolled twice) went on happening all evening.
 *
 * The first answer was a banner with a button. People did not press it: on 2026-10-03 the API was again found a
 * merge behind, with the page (read from disk) newer than the routes it called. Now:
 *   - the stamp is the exact set of files this process loaded (services/loadedCode.ts), taken HERE — while index.ts
 *     is still importing, before the server answers anything (a lazy stamp once swallowed a 2½-hour-old edit);
 *   - a COMMITTED change to one of them restarts the worker by itself when no session is live
 *     (services/autoRestart.ts) — a merge to main is the deploy;
 *   - an uncommitted edit only shows in the banner, with the button.
 *
 * A clean exit IS the restart: the supervisor relaunches with EXPLOIT_CHART and POOL_MODEL armed, which is exactly
 * why nothing here may spawn the API itself.
 */

const API_ROOT = join(import.meta.dir, "..", "..");

/**
 * Only a supervisor can bring this process back, so an exit is only honest when one is running. study-api.ps1
 * exports STUDY_API_SUPERVISOR (and every supervisor POKER_SUPERVISOR) with its own pid; anything else — a
 * hand-started `bun index.ts`, a verify instance — would exit and stay exited, so it never restarts on its own
 * and the page offers the command instead of a button.
 */
export function isSupervised(): boolean {
  return !!(process.env.STUDY_API_SUPERVISOR || process.env.POKER_SUPERVISOR);
}

/** Constructed when index.ts imports routes/build.ts: at boot, before the server listens. */
export const buildStamp = new LoadedCode({ entry: join(API_ROOT, "index.ts") });

export const autoRestart = new AutoRestart({
  code: buildStamp,
  name: "api",
  supervised: isSupervised,
  // a live answer in the last minute means a table is being played even if the wrapper's /session could not say so
  busy: async () => (liveBusy(60_000) ? "a live answer was computed within the last minute" : liveSessionReason()),
});

/**
 * The dashboard page is read from disk on every request, so an open tab can be older than the page on disk.
 * This token changes whenever the page file does; the tab compares it with the one it was served.
 */
export function pageToken(): string {
  try {
    const st = statSync(join(API_ROOT, "dashboard.html"));
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch { return ""; }
}
