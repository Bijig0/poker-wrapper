/**
 * THE REPLAY GATE'S TEMP COPIES (2026-10-09): every run of scripts/replayGate copies poker.sqlite and gtow-cache.sqlite
 * (0.7-1.5 GB together) into a work dir under %TEMP% — `replay-gate` by default, `<work>-control-<commit>` and
 * `<work>-candidate` under --control. Until today nothing removed them: 47 of them (~60 GB) from the 2026-10-03 runs
 * were found and deleted by hand on 2026-10-09. Now the gate removes its copies when the run finishes (success or
 * failure; --keep-temp keeps them, --reuse-copy implies it) and sweeps the leftovers of earlier runs older than a day
 * at the start of a run. The pure file-system side lives here so it can be unit tested (replayGateTemp.test.ts).
 *
 * What a work dir holds after a run: the two SQLite copies, the copied json configs (gtow-accounts.json, wrapper/,
 * api/), whatever the services wrote into the copy, and the run's REPORT (replay-gate-<tag>.json, .vs-baseline.json).
 * The reports are small and are what a later run compares itself with (--baseline), so the per-run cleanup keeps
 * them (the dir stays with the reports only); the day-old sweep takes the whole dir.
 */
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** the names the gate (and the hands that drove it) gave the work dirs: replay-gate* · rg*-candidate · rg*-control-* */
export function isGateTempName(name: string): boolean {
  return /^replay-gate/i.test(name) || /^rg.*-candidate$/i.test(name) || /^rg.*-control-./i.test(name);
}

const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const isRoot = (p: string) => dirname(resolve(p)) === resolve(p);

/**
 * A path the cleanup may touch: never a drive root, never the live data root or anything that contains it (a --work
 * pointed at poker-data, or at a parent of it, would otherwise be emptied).
 */
export function refusalFor(dir: string, protect: readonly string[]): string | null {
  if (isRoot(dir)) return "a filesystem root";
  const d = norm(dir);
  for (const p of protect) {
    const q = norm(p);
    if (q === d || q.startsWith(`${d}/`)) return `it holds the live data root ${p}`;
  }
  return null;
}

/** bytes under a path; a symlink / junction counts 0 and is never followed */
export function sizeOf(path: string): number {
  let st; try { st = lstatSync(path); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(path)) n += sizeOf(join(path, e));
  return n;
}

export const fmtGb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

export type Removed = { path: string; bytes: number; kept: string[]; error?: string };

/**
 * Remove a run's work copy: everything in the dir except the top-level files `keep` names (the reports). When nothing
 * is kept the dir itself goes. rmSync never follows a symlink or a junction (node_modules linked into a control
 * worktree are unlinked, their targets untouched). Returns what was removed; `error` when the dir had to stay.
 */
export function removeGateTemp(dir: string, opts: { protect?: readonly string[]; keep?: (name: string) => boolean } = {}): Removed {
  const out: Removed = { path: dir, bytes: 0, kept: [] };
  if (!existsSync(dir)) return out;
  const refusal = refusalFor(dir, opts.protect ?? []);
  if (refusal) { out.error = `refusing to remove ${dir}: ${refusal}`; return out; }
  const keep = opts.keep ?? (() => false);
  try {
    if (!lstatSync(dir).isDirectory()) { out.bytes = sizeOf(dir); rmSync(dir, { force: true, maxRetries: 5, retryDelay: 200 }); return out; }
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (keep(e) && lstatSync(p).isFile()) { out.kept.push(e); continue; }
      out.bytes += sizeOf(p);
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    if (!out.kept.length) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    out.error = `${dir}: ${(e as Error).message}`;
  }
  return out;
}

export type Sweep = { removed: Removed[]; kept: string[]; skipped: string[] };

/**
 * The sweep at the start of a run: every directory directly under `root` whose name isGateTempName and whose mtime is
 * older than `olderThanMs` goes — whole, reports included. `keep` names this run's own dirs (never swept whatever
 * their age). Returns what went, what stayed for being young or kept, and what could not be removed.
 */
export function sweepGateTemp(root: string, opts: { olderThanMs?: number; now?: number; keep?: readonly string[]; protect?: readonly string[] } = {}): Sweep {
  const res: Sweep = { removed: [], kept: [], skipped: [] };
  const olderThan = opts.olderThanMs ?? DAY_MS, now = opts.now ?? Date.now();
  const keep = new Set((opts.keep ?? []).map(norm));
  let names: string[];
  try { names = readdirSync(root); } catch { return res; }
  for (const name of names) {
    if (!isGateTempName(name)) continue;
    const p = join(root, name);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (keep.has(norm(p))) { res.kept.push(p); continue; }
    let mtime = st.mtimeMs;
    try { mtime = Math.max(mtime, statSync(p).mtimeMs); } catch { /* the lstat's time stands */ }
    if (now - mtime < olderThan) { res.kept.push(p); continue; }
    const r = removeGateTemp(p, { protect: opts.protect });
    if (r.error) res.skipped.push(r.error); else res.removed.push(r);
  }
  return res;
}

/** a swept dir that was a git worktree of the control commit (the orchestrator prunes git's record of it) */
export const isControlWorktreeName = (path: string) => /^replay-gate-control-/i.test(basename(path));
