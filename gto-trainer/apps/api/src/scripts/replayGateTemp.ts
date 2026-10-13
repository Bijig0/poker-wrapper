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
 *
 * EVERY RUN ITS OWN DIRS (2026-10-13): two gates at once — two Claude sessions, both --control <main HEAD> — shared the
 * control worktree (replay-gate-control-<commit>) and the default work dirs (replay-gate-control-<commit>, the SAME path
 * as that worktree, and replay-gate-candidate): each run's copies were replaced under the other, one run's finally
 * removed the worktree the other's child ran in, and one run printed 294 decisions changed against the control with a
 * PASS (alone: 0). Now the default work dir and the control worktree carry the run's id (gateRunId: the local start
 * time and the pid), and a run CLAIMS every work dir it uses with a lock file (claimGateDirs): a dir another live run
 * holds — an explicit --work two runs were both given — is refused, naming the holder.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** the names the gate (and the hands that drove it) gave the work dirs: replay-gate* · rg*-candidate · rg*-control-* */
export function isGateTempName(name: string): boolean {
  return /^replay-gate/i.test(name) || /^rg.*-candidate$/i.test(name) || /^rg.*-control-./i.test(name);
}

/** a run's id: its local start time and its pid (20261013-135800-12345) — unique among the runs alive at once */
export function gateRunId(now = new Date(), pid = process.pid): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${pid}`;
}

/**
 * The dirs a run uses under the temp dir `tmp`. `work` is --work when given (the person's choice: claimGateDirs keeps
 * two runs off it), else replay-gate-<run id>. Under --control the two replays work in <work>-control-<commit> and
 * <work>-candidate, and the control commit is checked out in replay-gate-control-<commit>-<run id> — never the same
 * path as a work dir (it was, by default, until 2026-10-13: the copies landed inside the worktree).
 */
export function gateRunDirs(o: { tmp: string; runId: string; work?: string | null; commit?: string | null }) {
  const slash = (p: string) => p.replace(/\\/g, "/");
  const work = slash(o.work ?? join(o.tmp, `replay-gate-${o.runId}`));
  if (!o.commit) return { work, controlWorktree: null, controlWork: null, candidateWork: null };
  return { work, controlWorktree: slash(join(o.tmp, `replay-gate-control-${o.commit}-${o.runId}`)),
    controlWork: `${work}-control-${o.commit}`, candidateWork: `${work}-candidate` };
}

// ---- the claim: one live run per work dir ---------------------------------------------------------------------------
export const LOCK_FILE = ".replay-gate.lock";
export type GateHolder = { pid: number; started: string; startedMs: number; cwd: string; argv: string[] };

/** whether a process is alive (signal 0 tests, sends nothing; EPERM = alive, not ours) */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Who holds `dir`: null when nobody does — no lock, an unreadable one, a dead pid, or a lock older than a day (the
 * sweep's age: a pid reused by another program must not hold a dir for ever).
 */
export function gateHolder(dir: string, opts: { alive?: (pid: number) => boolean; now?: number } = {}): GateHolder | null {
  let h: GateHolder;
  try { h = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")); } catch { return null; }
  if (!Number.isInteger(h?.pid) || h.pid <= 0) return null;
  if ((opts.now ?? Date.now()) - Number(h.startedMs ?? 0) >= DAY_MS) return null;
  return (opts.alive ?? pidAlive)(h.pid) ? h : null;
}

/**
 * Claim the dirs for this run (made when missing): a lock file in each, written exclusively. A dir another live run
 * holds is refused — every claim this call made is undone and the refusal names the holder; a stale lock is taken
 * over. Returns null when every dir is this run's.
 */
export function claimGateDirs(dirs: readonly string[], me: GateHolder, opts: { alive?: (pid: number) => boolean; now?: number } = {}): string | null {
  const done: { dir: string; made: boolean }[] = [];
  const text = JSON.stringify(me, null, 1);
  for (const dir of dirs) {
    const made = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, LOCK_FILE);
    try { writeFileSync(lock, text, { flag: "wx" }); done.push({ dir, made }); continue; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    const h = gateHolder(dir, opts);
    if (h && h.pid !== me.pid) {
      releaseGateDirs(done.map((d) => d.dir), me.pid);
      for (const d of done) if (d.made) { try { rmdirSync(d.dir); } catch { /* not empty: the sweep takes it */ } }
      return `${dir} is in use by another replay gate — pid ${h.pid}, started ${h.started}, in ${h.cwd}: ${h.argv.join(" ")}\n`
        + `  wait for it to end, or give this run another --work (if pid ${h.pid} is not a replay gate, delete ${lock})`;
    }
    writeFileSync(lock, text);            // stale (or already this run's): taken over
    done.push({ dir, made });
  }
  return null;
}

/** release this run's claims (a lock another run took over is left alone) */
export function releaseGateDirs(dirs: readonly string[], pid: number): void {
  for (const dir of dirs) {
    const lock = join(dir, LOCK_FILE);
    try { if (JSON.parse(readFileSync(lock, "utf8")).pid === pid) rmSync(lock, { force: true }); } catch { /* none, or unreadable */ }
  }
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

/**
 * a run's report — replay-gate-<tag>.json, .vs-baseline.json: what the per-run cleanup keeps. Only those: the copied
 * configs are json too, and gtow-accounts.json (the GTO Wizard accounts) stayed in %TEMP% beside the reports until
 * 2026-10-13
 */
export const isGateReport = (name: string) => /^replay-gate-.+\.json$/i.test(name);

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

/**
 * a swept dir that was a git worktree of the control commit (the orchestrator prunes git's record of it):
 * replay-gate-control-<commit>-<run id>, and the run-less replay-gate-control-<commit> of the runs before 2026-10-13 —
 * never a work dir (replay-gate-<run id>-control-<commit>)
 */
export const isControlWorktreeName = (path: string) => /^replay-gate-control-/i.test(basename(path));
