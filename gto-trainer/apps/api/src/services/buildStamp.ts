import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * IS THIS PROCESS STILL RUNNING THE CODE ON DISK?
 *
 * The API runs under the StudyAPI supervisor without --watch (deliberately: a
 * --watch worker crash leaves the watcher alive and hides the failure). So an
 * edit changes nothing until someone restarts it — and nothing says so. On
 * 2026-09-19 that process stayed up from 19:54 while four separate fixes landed
 * on disk unread, and the one that mattered most (two pollers answering one
 * table, every decision solved and rolled twice) went on happening all evening
 * in a process that could not know it had been fixed.
 *
 * So: stamp the newest source mtime at boot, re-scan on demand, and let the
 * dashboard say "restart to pick this up" with a button that does it.
 *
 * "At boot" means in the constructor, i.e. while index.ts is still importing,
 * before the server answers anything. It used to be taken lazily on the first
 * /api/build call, which is only "boot" if someone asks straight away. On
 * 2026-09-24 nobody asked for 2½ hours: the worker booted at 02:00, a fix landed
 * at 04:38, the first question came at ~04:50 and stamped the FIXED file as
 * loaded, so the API said stale:false while it went on running the 02:00 code.
 *
 * A clean exit IS the restart — the supervisor relaunches 10s later with EXPLOIT_CHART
 * and POOL_MODEL armed, which is exactly why the button must never try to spawn
 * the API itself.
 *
 * Source only. data/ is excluded: the API writes there constantly (answers,
 * ledger, jobs) and a stamp that moved on every answer would cry wolf until it
 * was ignored, which is worse than no alert at all.
 */

const ROOT = join(import.meta.dir, "..", "..");
/** Directories under the API root whose contents are CODE. */
const WATCH = ["src", "."] as const;
const CODE = /\.(ts|tsx|js|mjs|html)$/;
const SKIP = new Set(["node_modules", "data", ".git", "dist", "build", ".claude"]);
/** A re-scan costs a few hundred stat() calls; once every 5s is plenty. */
const THROTTLE_MS = 5_000;

export interface BuildStatus {
  /** when this process started */
  bootAt: number;
  /** newest source mtime as of boot */
  bootStamp: number;
  /** newest source mtime right now */
  diskStamp: number;
  /** disk is newer than what this process loaded */
  stale: boolean;
  /** how many files are newer than boot, and a few of their names */
  changedCount: number;
  changed: string[];
  /** the supervisor is up, so a clean exit really does come back */
  supervised: boolean;
  scannedFiles: number;
  scanMs: number;
}

interface Scan { stamp: number; files: number; newer: string[]; ms: number }

/** Newest code mtime under `root`, and (when `since` is set) the files newer than it. */
export function scan(root: string, since: number): Scan {
  const t0 = Date.now();
  let stamp = 0;
  let files = 0;
  const newer: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // src/ is its own WATCH entry; walking it again from "." listed its top-level files twice
        if (dir === root && (WATCH as readonly string[]).includes(e.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!CODE.test(e.name)) continue;
      let m = 0;
      try { m = statSync(full).mtimeMs; } catch { continue; }
      files++;
      if (m > stamp) stamp = m;
      if (since && m > since && newer.length < 40) newer.push(full.slice(root.length + 1).replace(/\\/g, "/"));
    }
  };
  for (const w of WATCH) walk(join(root, w), w === "." ? 7 : 0);
  return { stamp, files, newer, ms: Date.now() - t0 };
}

export class BuildStamp {
  readonly bootAt = Date.now();
  /** Taken once, here, and then fixed for this process's life. That is the whole
   *  point: it must describe what was LOADED, not what is on disk now. Every
   *  static import has been read before this module evaluates, so the only blind
   *  spot left is an edit landing during boot itself — seconds, not hours. */
  private readonly boot: Scan;
  private last: { at: number; scan: Scan } | null = null;

  constructor(private readonly root: string = ROOT) {
    this.boot = scan(root, 0);
  }

  status(force = false): BuildStatus {
    const boot = this.boot;
    const now = Date.now();
    if (force || !this.last || now - this.last.at > THROTTLE_MS) {
      this.last = { at: now, scan: scan(this.root, boot.stamp) };
    }
    const cur = this.last.scan;
    return {
      bootAt: this.bootAt,
      bootStamp: Math.round(boot.stamp),
      diskStamp: Math.round(cur.stamp),
      // A whole second of slack: mtime resolution and the copy that wrote the
      // file are not worth a false alarm.
      stale: cur.stamp > boot.stamp + 1000,
      changedCount: cur.newer.length,
      changed: cur.newer.slice(0, 12),
      supervised: isSupervised(),
      scannedFiles: cur.files,
      scanMs: cur.ms,
    };
  }
}

/**
 * Only the supervisor can bring this process back, so the button is only honest
 * when it is running. study-api.ps1 exports STUDY_API_SUPERVISOR with its own
 * pid; anything else (a hand-started `bun index.ts`, a dev instance) exits and
 * stays exited, so the UI offers the command instead of a button.
 */
export function isSupervised(): boolean {
  return !!process.env.STUDY_API_SUPERVISOR;
}

/** Constructed when index.ts imports routes/build.ts: at boot, before the server listens. */
export const buildStamp = new BuildStamp();
