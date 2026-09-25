/**
 * Single-owner lock for this API's BACKGROUND work (study poller, GTOW token keeper, job
 * dispatcher, box keeper). The HTTP server is deliberately NOT locked: a second instance is
 * allowed to serve requests (that is what `dev-api.cmd --watch` is for), it just must not run a
 * second copy of the work.
 *
 * Why a pid file and not the obvious alternatives (2026-09-14, after two keepers ran for 14 h):
 *   - the PORT cannot be the mutex. index.ts sets `reusePort: true` on purpose, because on Windows
 *     the box runners inherit the listening socket and keep :2000 "in use" after their parent dies
 *     (2026-09-09: every request hung until HRC exited). A "port taken => don't start" rule would
 *     bring that back, and a free port would not prove the old worker is gone anyway.
 *   - a HELD FILE HANDLE has the same defect: boxKeeper shells out with Bun.spawn, and those
 *     ssh/rclone children inherit open handles, so the lock would read as held for as long as a
 *     straggler ssh lives.
 *   So: record the pid, and VERIFY it — alive (process.kill(pid, 0)) and still a bun process
 *   (tasklist, to survive pid reuse). Nothing is held open, so nothing can be inherited.
 *
 * What went wrong without it: two workers (the StudyAPI supervisor's and a hand-started one) each
 * ran a poller that rolls mixed strategies with Math.random() and pushes the pick to the wrapper,
 * each ran a job dispatcher whose "one job per lane" Map is per-process, and each ran a keeper
 * whose parse cleanup (`rm -f <solutions>/<id>.json.gz ...`) landed inside the other's run.
 */
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { backgroundLockPath } from "./storePaths";

// in the data root, so every API process on this machine (main checkout or a worktree) contends for ONE lock
const LOCK_PATH = backgroundLockPath();
/** How often a demoted instance re-checks whether the owner is gone. */
const RETRY_MS = 60_000;
/** How often the owner restamps the file, so `status` can show the lock is live and not abandoned. */
const HEARTBEAT_MS = 30_000;

type LockFile = { pid: number; since: number; heartbeat: number; argv?: string };

/** Set once startBackgroundLock() runs. Until then every caller is treated as the owner, so tests
 *  and any other entry point that imports a service directly behave exactly as they did before. */
let managed = false;
let owner = false;
let heldBy: LockFile | null = null;
let lastNote = "not started";
let retryTimer: ReturnType<typeof setInterval> | null = null;
let beatTimer: ReturnType<typeof setInterval> | null = null;
const onOwn: Array<() => void> = [];

/** True when this process owns the background work (or when the lock was never started). */
export function isBackgroundOwner(): boolean { return !managed || owner; }

/** Run `fn` as soon as this process owns the background work — immediately if it already does. */
export function onBackgroundOwnership(fn: () => void): void {
  // `!managed` = the lock was never started (tests, scripts): the unmanaged caller IS the owner, so
  // run now rather than queue a callback that nothing will ever drain.
  if (!managed || owner) { fn(); return; }
  onOwn.push(fn);
}

export function backgroundLockStatus(): {
  managed: boolean; owner: boolean; pid: number; path: string;
  heldBy: number | null; since: number | null; heartbeatAgeSec: number | null; note: string;
} {
  return {
    managed, owner, pid: process.pid, path: LOCK_PATH,
    heldBy: owner ? process.pid : heldBy?.pid ?? null,
    since: owner ? heldBy?.since ?? null : heldBy?.since ?? null,
    heartbeatAgeSec: heldBy?.heartbeat ? Math.round((Date.now() - heldBy.heartbeat) / 1000) : null,
    note: lastNote,
  };
}

/** Is `pid` a live bun process? EPERM means alive-but-not-ours, which still counts as alive. */
function aliveBun(pid: number): boolean {
  if (!(pid > 0) || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); } catch (e: any) { if (e?.code !== "EPERM") return false; }
  // The pid is live. Windows recycles pids, so make sure it is still a bun process and not whatever
  // took the number after the old worker died — otherwise a recycled pid locks us out forever.
  try {
    const r = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { stdout: "pipe", stderr: "ignore" });
    const out = new TextDecoder().decode(r.stdout);
    if (/^\s*$/.test(out) || /No tasks/i.test(out)) return false;
    return /bun/i.test(out.split(",")[0] ?? "");
  } catch { return true; } // no tasklist (non-Windows): trust process.kill
}

function readLock(): LockFile | null {
  try { const f = JSON.parse(readFileSync(LOCK_PATH, "utf-8")); return f && typeof f.pid === "number" ? f : null; } catch { return null; }
}

function writeOurs(): boolean {
  const body: LockFile = { pid: process.pid, since: Date.now(), heartbeat: Date.now(), argv: process.argv.slice(0, 3).join(" ") };
  try {
    // "wx" = create-or-fail, so two candidates racing cannot both believe they created it.
    const fd = openSync(LOCK_PATH, "wx");
    try { writeSync(fd, JSON.stringify(body, null, 1)); } finally { closeSync(fd); }
  } catch { return false; }
  // Read back: if anything else clobbered the file between our create and now, we are not the owner.
  const back = readLock();
  if (back?.pid !== process.pid) return false;
  heldBy = body;
  return true;
}

/** One acquisition attempt. Returns true if this process now owns the background work. */
function tryAcquire(): boolean {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  const cur = readLock();
  if (cur && cur.pid !== process.pid) {
    if (aliveBun(cur.pid)) { heldBy = cur; lastNote = `background work is owned by pid ${cur.pid} (since ${new Date(cur.since).toISOString().slice(0, 19)})`; return false; }
    // Stale: the recorded owner is gone (crash, kill -9, pid recycled to a non-bun process).
    try { unlinkSync(LOCK_PATH); } catch { /* someone else got there first */ }
  } else if (cur?.pid === process.pid) {
    heldBy = cur; return true;
  }
  if (writeOurs()) { lastNote = "owns the background work"; return true; }
  const after = readLock();
  heldBy = after;
  lastNote = after ? `lost the acquisition race to pid ${after.pid}` : "could not write the lock file";
  return false;
}

function beat(): void {
  if (!owner) return;
  const cur = readLock();
  // Someone else took the lock (only possible if this process was declared dead). Do not fight it —
  // give the background work up rather than run a second copy.
  if (cur && cur.pid !== process.pid) {
    owner = false; heldBy = cur;
    lastNote = `lock was taken over by pid ${cur.pid} — background work stopped here`;
    console.warn(`!!! background lock taken over by pid ${cur.pid}; this instance is now HTTP-only`);
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    return;
  }
  const body: LockFile = { pid: process.pid, since: heldBy?.since ?? Date.now(), heartbeat: Date.now(), argv: heldBy?.argv };
  try { const fd = openSync(LOCK_PATH, "w"); try { writeSync(fd, JSON.stringify(body, null, 1)); } finally { closeSync(fd); } heldBy = body; } catch { /* best effort */ }
}

function becomeOwner(): void {
  owner = true;
  if (!beatTimer) { beatTimer = setInterval(beat, HEARTBEAT_MS); beatTimer.unref?.(); }
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  while (onOwn.length) { const fn = onOwn.shift()!; try { fn(); } catch (e) { console.error("background-ownership hook failed:", e); } }
}

function release(): void {
  if (!owner) return;
  const cur = readLock();
  if (cur?.pid === process.pid) { try { unlinkSync(LOCK_PATH); } catch { /* gone already */ } }
  owner = false;
}

/**
 * Claim the background work for this process, retrying every RETRY_MS while another live instance
 * holds it. Call once, at boot, before starting the services.
 */
export function startBackgroundLock(): void {
  if (managed) return;
  managed = true;
  if (tryAcquire()) {
    console.log(`background lock: this process (pid ${process.pid}) owns the poller, job dispatcher and box keeper`);
    becomeOwner();
    return;
  }
  // Loud on purpose: a silently demoted instance that looks healthy but keeps nothing is exactly
  // the failure this lock exists to prevent.
  console.warn(`!!! background lock held by pid ${heldBy?.pid}: this instance serves HTTP ONLY —`
    + " no study poller, no job dispatcher, no box keeper."
    + " (Another API is already running; stop it, or the StudyAPI scheduled task, if you meant this one to be in charge.)");
  retryTimer = setInterval(() => { if (tryAcquire()) { console.log(`background lock: acquired after the previous owner exited — pid ${process.pid} now owns the background work`); becomeOwner(); } }, RETRY_MS);
  retryTimer.unref?.();
}

// Best effort only, and deliberately so. A normal exit (and `bun --watch`'s reload) releases the
// lock; a taskkill /F — how the supervisor kills a hung worker, and how Windows ends a process that
// is not listening for POSIX signals — runs no handler and leaves the file behind. That is fine:
// nothing trusts the file's existence, only the liveness of the pid inside it, and the next
// instance to boot unlinks the stale one and takes over (verified 2026-09-14).
for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  try { process.on(sig, () => { release(); if (sig !== "exit") process.exit(0); }); } catch { /* signal not supported on this platform */ }
}
