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
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
  // ABSOLUTE (the 2026-10-13 audit): the children run in other directories (the control worktree's apps/api, this
  // checkout's) — a relative --work ("%TEMP%/x" is literal text in bash and PowerShell) put the control's copies and
  // report inside its worktree, and the candidate's --baseline pointed at an empty dir
  const slash = (p: string) => resolve(p).replace(/\\/g, "/");
  const work = slash(o.work ?? join(o.tmp, `replay-gate-${o.runId}`));
  if (!o.commit) return { work, controlWorktree: null, controlWork: null, candidateWork: null };
  return { work, controlWorktree: slash(join(o.tmp, `replay-gate-control-${o.commit}-${o.runId}`)),
    controlWork: `${work}-control-${o.commit}`, candidateWork: `${work}-candidate` };
}

/** what a run leaves in a work dir: its reports, the lock's files, the copies, the copied configs (api/ and wrapper/ hold json / sqlite only) */
const isLeftover = (dir: string, name: string): boolean => {
  if (isGateReport(name) || name.startsWith(LOCK_FILE) || /^(poker|gtow-cache)\.sqlite/i.test(name) || /\.copying$/i.test(name) || name === "gtow-accounts.json") return true;
  if (name !== "api" && name !== "wrapper") return false;
  try { return readdirSync(join(dir, name), { withFileTypes: true }).every((e) => e.isFile() && /\.(json|sqlite(-wal|-shm)?)$/i.test(e.name)); } catch { return false; }
};

/**
 * Why a dir may not be a run's work dir (null = it may): the run's cleanup deletes everything in it but the reports, so
 * an existing dir must be the gate's — named like one (isGateTempName), empty, holding a run's lock, or holding only
 * what a run leaves (a report among it: a re-run on the same --work, a --reuse-copy). `--work .` from apps/api, a
 * checkout, the live data would otherwise be emptied (the 2026-10-13 audit; so since 2026-10-09).
 */
export function workDirRefusal(dir: string, protect: readonly string[] = []): string | null {
  const refusal = refusalFor(dir, protect);
  if (refusal) return `work dir ${dir}: ${refusal}`;
  let st; try { st = lstatSync(dir); } catch { return null; }        // not there: the run makes it
  if (st.isSymbolicLink() || !st.isDirectory()) return `work dir ${dir} is not a directory`;
  if (isGateTempName(basename(dir))) return null;
  const names = readdirSync(dir);
  if (!names.length || names.includes(LOCK_FILE)) return null;
  if (names.some(isGateReport) && names.every((n) => isLeftover(dir, n))) return null;
  return `work dir ${dir} exists and is not a replay-gate dir (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}) — the run's `
    + "cleanup would delete what is in it: give a new or empty dir, or one named replay-gate*";
}

// ---- the claim: one live run per work dir ---------------------------------------------------------------------------
export const LOCK_FILE = ".replay-gate.lock";
export type GateHolder = { pid: number; started: string; startedMs: number; cwd: string; argv: string[] };
type LockOpts = { alive?: (pid: number) => boolean; now?: number };

/** whether a process is alive (signal 0 tests, sends nothing; EPERM = alive, not ours) */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * A lock's holder: null when there is none (no file; not JSON and older than 5 s: corrupt, every lock is written whole);
 * "unreadable" when it is there but was not read (a sharing violation, a scanner) or is not JSON yet young — held, for now.
 */
const readLock = (path: string): GateHolder | null | "unreadable" => {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable"; }
  try { return JSON.parse(text); } catch { try { return Date.now() - statSync(path).mtimeMs < 5000 ? "unreadable" : null; } catch { return null; } }
};
/** the holder named for a lock that could not be read: it holds (the safe side) until it reads */
const UNREADABLE: GateHolder = { pid: 0, started: "?", startedMs: 0, cwd: "?", argv: ["(a lock that could not be read)"] };
/** a holder that holds: a live pid, a lock younger than a day (a pid reused by another program must not hold for ever) */
const live = (h: GateHolder | null | "unreadable", opts: LockOpts): GateHolder | null => {
  if (h === "unreadable") return UNREADABLE;
  if (!h || !Number.isInteger(h.pid) || h.pid <= 0) return null;
  if ((opts.now ?? Date.now()) - Number(h.startedMs ?? 0) >= DAY_MS) return null;
  return (opts.alive ?? pidAlive)(h.pid) ? h : null;
};

/** Who holds `dir`: null when nobody does — no lock, a corrupt one, a dead pid, or a lock older than a day. */
export function gateHolder(dir: string, opts: LockOpts = {}): GateHolder | null {
  return live(readLock(join(dir, LOCK_FILE)), opts);
}

/**
 * A lock file made whole or not at all: the text is written to a temp file, then hard-linked to `path` — the link fails
 * (EEXIST) when the file is there, and a reader never sees it half written. (A temp file removed under it — another
 * run's cleanup — is written again.)
 */
function linkExclusive(path: string, text: string, pid: number): boolean {
  for (let i = 0; ; i++) {
    const tmp = `${path}.${pid}.${Date.now()}.${i}.tmp`;
    writeFileSync(tmp, text);
    try { linkSync(tmp, path); return true; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code !== "ENOENT" || i >= 3) throw e;
    } finally { rmSync(tmp, { force: true }); }
  }
}

/**
 * One dir's lock for `me`: null when it is this run's, else the run that holds it. A STALE lock (a dead pid, a day
 * old) is replaced only by the run holding the dir's takeover token (another exclusive file) — two runs that both
 * found it stale cannot both take it (12 runs racing onto a dead run's lock: 2-12 of them did, before; the audit).
 */
function claimOne(dir: string, me: GateHolder, text: string, opts: LockOpts): GateHolder | null {
  const lock = join(dir, LOCK_FILE), token = `${lock}.takeover`;
  for (let i = 0; i < 200; i++) {
    if (linkExclusive(lock, text, me.pid)) return null;
    const h = live(readLock(lock), opts);
    if (h === UNREADABLE) { Bun.sleepSync(10); continue; }                    // look again: it may be read in a moment
    if (h) return h.pid === me.pid ? null : h;
    if (linkExclusive(token, text, me.pid)) {
      try {
        const now = live(readLock(lock), opts);         // still stale? (a run that held the token may have taken it)
        if (now === UNREADABLE) continue;
        if (now) return now.pid === me.pid ? null : now;
        rmSync(lock, { force: true });
        if (linkExclusive(lock, text, me.pid)) return null;
        continue;                                        // a run linked into the gap: it holds (read on the next turn)
      } finally { rmSync(token, { force: true }); }
    }
    // another run is taking it over: look again shortly (a token a crashed run left — 10 s old — is cleared)
    try { if (Date.now() - statSync(token).mtimeMs > 10_000) rmSync(token, { force: true }); } catch { /* gone */ }
    Bun.sleepSync(10);
  }
  return live(readLock(lock), opts) ?? { pid: 0, started: "?", startedMs: 0, cwd: "?", argv: ["(a takeover that did not settle in 2 s)"] };
}

/**
 * Claim the dirs for this run (made when missing; touched, so the day-old sweep sees them young): a lock file in
 * each. A dir another live run holds is refused — every claim this call made is undone (on a throw too) and the
 * refusal names the holder. Returns null when every dir is this run's.
 */
export function claimGateDirs(dirs: readonly string[], me: GateHolder, opts: LockOpts = {}): string | null {
  const done: { dir: string; made: boolean }[] = [];
  const undo = () => {
    releaseGateDirs(done.map((d) => d.dir), me.pid);
    for (const d of done) if (d.made) { try { rmdirSync(d.dir); } catch { /* not empty: the sweep takes it */ } }
  };
  const text = JSON.stringify(me, null, 1);
  try {
    for (const dir of dirs) {
      const made = !existsSync(dir);
      mkdirSync(dir, { recursive: true });
      const h = claimOne(dir, me, text, opts);
      if (h) {
        undo();
        return `${dir} is in use by another replay gate — pid ${h.pid}, started ${h.started}, in ${h.cwd}: ${(h.argv ?? []).join(" ")}\n`
          + `  wait for it to end, or give this run another --work (if pid ${h.pid} is not a replay gate, delete ${join(dir, LOCK_FILE)})`;
      }
      done.push({ dir, made });
      try { const t = new Date(); utimesSync(dir, t, t); } catch { /* the age stays the dir's own */ }
    }
  } catch (e) { undo(); throw e; }
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
export function sweepGateTemp(root: string, opts: { olderThanMs?: number; now?: number; keep?: readonly string[]; protect?: readonly string[]; alive?: (pid: number) => boolean } = {}): Sweep {
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
    // a dir a live run holds stays whatever its age (a --reuse-copy run adds no entry: its dir's mtime can be old)
    if (gateHolder(p, { alive: opts.alive, now })) { res.kept.push(p); continue; }
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
