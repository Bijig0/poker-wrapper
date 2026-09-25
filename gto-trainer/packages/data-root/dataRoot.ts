/**
 * ONE DATA ROOT (2026-09-25) — the only place that decides where a RUNTIME record lives (answers, stored chains,
 * the GTO Wizard request ledger, poller events, job logs, the wrapper's hands.db / sessions / debug recordings…).
 *
 * Why: every store used to work its path out from the source file that opened it
 * (`join(import.meta.dir, "..", "..", "data", …)`), so the data followed the CHECKOUT. Hand 973 (#4920419883) was
 * answered by an API running from a worktree: its answers reached the main answers.sqlite (ANSWERS_DB_PATH), its
 * stored chains, request ledger and [chain] lines went to the worktree's data/ — deleted with the worktree — and
 * `answers.solve_id` then pointed at another hand's row. See gto-trainer/DATA-ROOT-PLAN.md.
 *
 * The rule:
 *   - POKER_DATA_DIR=X  → api records in X/api, wrapper records in X/wrapper, wrapper debug in X/wrapper-debug.
 *   - otherwise         → root = <main checkout>/data (the central poker.sqlite lives there — see centralDb.ts);
 *                         the non-database records (job logs, caches, profiles.json, recordings) stay in the main
 *                         checkout's existing folders (gto-trainer/apps/api/data, ignition-study-wrapper/data, …/debug).
 *                         The main checkout is resolved through git's common dir, so a worktree writes where the
 *                         main checkout does.
 *   - under `bun test`  → one temp directory per test run (POKER_TEST_DATA_DIR, inherited by child processes), so no
 *                         test reaches a live store whichever store it opens.
 * Tracked reference artifacts (preflop-db.sqlite, resolved-charts.json, mes_postflop.json, ledger.json …) are NOT
 * runtime records: they are versioned with the code and stay beside it.
 *
 * Per-store env overrides (ANSWERS_DB_PATH, HANDS_DB_PATH, …) keep working — tests and verify servers use them —
 * but `storeReport()` names them, and `splitStores()` lists every one that lands outside the root: a live process
 * refuses to start with a split (that is exactly how hand 973's records came apart).
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type RootMode = "env" | "main-checkout" | "test";

export interface DataLayout {
  mode: RootMode;
  /** POKER_DATA_DIR, the test root, or <main checkout>/data — where the central poker.sqlite lives */
  root: string;
  /** the API's runtime records (answers.sqlite, solves.sqlite, gtow_requests.jsonl, jobs/ …) */
  api: string;
  /** the wrapper's runtime records (hands.db, sessions.sqlite, profiles.json, tables/ …) */
  wrapper: string;
  /** the wrapper's debug recordings and ws dumps */
  wrapperDebug: string;
  /** the checkout the running code came from */
  codeCheckout: string;
  /** the repository's main checkout (== codeCheckout outside a worktree) */
  mainCheckout: string;
  /** true when the running code is a git worktree, not the main checkout */
  inWorktree: boolean;
}

/** The checkout (directory holding `.git`) that contains `from`, or null. */
export function checkoutOf(from: string): string | null {
  let d = resolve(from);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * The main checkout behind a (possibly worktree) checkout. A worktree's `.git` is a FILE `gitdir: <main>/.git/worktrees/<name>`
 * whose `commondir` file points back at `<main>/.git`; read without spawning git (this runs at import time).
 */
export function mainCheckoutOf(checkout: string): string {
  const dotGit = join(checkout, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return checkout;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return checkout;
    const gitdir = resolve(checkout, m[1]!.trim());
    let common = gitdir;
    const cd = join(gitdir, "commondir");
    if (existsSync(cd)) common = resolve(gitdir, readFileSync(cd, "utf8").trim());
    else if (/[\\/]worktrees[\\/][^\\/]+$/.test(gitdir)) common = resolve(gitdir, "..", "..");
    return dirname(common);
  } catch {
    return checkout;
  }
}

/** Under `bun test`: the environment says so (bun sets NODE_ENV=test), or the runner is bun's test runner. */
export function underTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test";
}

function testRoot(env: NodeJS.ProcessEnv): string {
  // one root per test RUN: set once and inherited by every child process the tests spawn, so a spawned wrapper
  // and the test that reads its hands.db agree
  if (!env.POKER_TEST_DATA_DIR) env.POKER_TEST_DATA_DIR = join(tmpdir(), `poker-test-data-${process.pid}-${Date.now().toString(36)}`);
  return env.POKER_TEST_DATA_DIR;
}

/**
 * Resolve the layout. `codeDir` is any directory inside the running checkout (defaults to this file's own);
 * `env` is injectable for tests. Pure apart from reading `.git` — nothing is created here.
 */
export function dataLayout(env: NodeJS.ProcessEnv = process.env, codeDir: string = import.meta.dir): DataLayout {
  const codeCheckout = checkoutOf(codeDir) ?? resolve(codeDir, "..", "..", "..");
  const mainCheckout = mainCheckoutOf(codeCheckout);
  const inWorktree = resolve(mainCheckout) !== resolve(codeCheckout);
  const base = { codeCheckout, mainCheckout, inWorktree };
  const explicit = env.POKER_DATA_DIR?.trim();
  if (explicit) {
    const root = resolve(explicit);
    return { mode: "env", root, api: join(root, "api"), wrapper: join(root, "wrapper"), wrapperDebug: join(root, "wrapper-debug"), ...base };
  }
  if (underTest(env)) {
    const root = testRoot(env);
    return { mode: "test", root, api: join(root, "api"), wrapper: join(root, "wrapper"), wrapperDebug: join(root, "wrapper-debug"), ...base };
  }
  return {
    mode: "main-checkout",
    root: join(mainCheckout, "data"),
    api: join(mainCheckout, "gto-trainer", "apps", "api", "data"),
    wrapper: join(mainCheckout, "ignition-study-wrapper", "data"),
    wrapperDebug: join(mainCheckout, "ignition-study-wrapper", "debug"),
    ...base,
  };
}

/** The API's runtime record `name` (e.g. "answers.sqlite", "jobs/poller-events.jsonl"). */
export function apiData(...name: string[]): string {
  return join(dataLayout().api, ...name);
}

/** The wrapper's runtime record `name` (e.g. "hands.db"). */
export function wrapperData(...name: string[]): string {
  return join(dataLayout().wrapper, ...name);
}

/** mkdir -p the directory that will hold `file`, returning `file` (stores call this right before opening). */
export function ensureDirFor(file: string): string {
  if (file !== ":memory:" && !file.startsWith("file::memory:")) mkdirSync(dirname(file), { recursive: true });
  return file;
}

export interface StoreEntry {
  /** short name ("answers", "hands.db" …) */
  store: string;
  /** where it resolves now */
  path: string;
  /** the env var that moved it, when one did */
  override: string | null;
}

/**
 * A store's path: the override env var when set, else the root's default. Returns the entry too, so a process can
 * report every store it opens in one place.
 */
export function storePath(store: string, defaultPath: string, overrideVar?: string, env: NodeJS.ProcessEnv = process.env): StoreEntry {
  const o = overrideVar ? env[overrideVar]?.trim() : undefined;
  const e: StoreEntry = { store, path: o ? (o.startsWith(":memory:") || o.startsWith("file::memory:") ? o : resolve(o)) : defaultPath, override: o ? overrideVar! : null };
  registry.set(store, e);
  return e;
}

const registry = new Map<string, StoreEntry>();

/** Every store resolved so far in this process (via `storePath`). */
export function storeReport(): StoreEntry[] {
  return [...registry.values()];
}

/**
 * In-memory, or under one of the layout's three folders. A temp file is OUTSIDE: a live process writing one store to
 * a temp dir has split its records all the same (verify servers on snapshots are not live, so the guard skips them).
 */
export function insideLayout(path: string, L: DataLayout = dataLayout()): boolean {
  if (path.startsWith(":memory:") || path.startsWith("file::memory:")) return true;
  const p = resolve(path);
  const within = (dir: string) => { const r = relative(resolve(dir), p); return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r)); };
  return within(L.root) || within(L.api) || within(L.wrapper) || within(L.wrapperDebug);
}

/** The overridden stores that land OUTSIDE the data root — a live process with any of these would split its records. */
export function splitStores(entries: StoreEntry[] = storeReport(), L: DataLayout = dataLayout()): StoreEntry[] {
  return entries.filter((e) => e.override && !insideLayout(e.path, L));
}

/** One line for a process's start-up log. */
export function describeLayout(L: DataLayout = dataLayout()): string {
  const where = L.mode === "env" ? `POKER_DATA_DIR=${L.root}` : L.mode === "test" ? `test root ${L.root}` : `main checkout ${L.mainCheckout} (db in ${L.root})`;
  return `[data-root] ${where} · api ${L.api} · wrapper ${L.wrapper} · debug ${L.wrapperDebug}` +
    (L.inWorktree ? ` · code from worktree ${L.codeCheckout} (records still go to the root above)` : "");
}
