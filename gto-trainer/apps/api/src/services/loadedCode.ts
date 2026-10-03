import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * IS THIS PROCESS STILL RUNNING THE CODE ON DISK — exactly, and for every service.
 *
 * A Bun process reads each source file once, at start. The API, the chart server and the wrapper are long-lived, so a
 * fix that lands on disk changes nothing until the process restarts, and (2026-10-03) the only thing that said so was
 * the dashboard's banner over a modification-time scan of apps/api: it missed the code the API loads from outside that
 * folder (packages/data-root, apps/wrapper/src), it fired on test files and one-off scripts the server never loads,
 * and the chart server and the wrapper had nothing at all.
 *
 * So the stamp is THE FILES THIS PROCESS LOADED: the import graph walked from the entry file (static, dynamic and
 * require imports that resolve to a file outside node_modules), plus any files the process reads once and keeps (the
 * wrapper's src/js snippets), each with a hash of its content. Stale = one of those files now has other content.
 * A touched file with the same text is not stale (line endings aside); a test or a script the entry never imports is
 * not in the set.
 *
 * It also reads the checkout's commit (straight from .git, no process spawned), so a service can say which commit it
 * is running, and `autoRestart.ts` uses both to restart a supervised worker when a commit changed code it loaded.
 */

const SCRIPT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);
const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
};
/** A re-check is one stat per loaded file (a read only when size or mtime moved); once every 5 s is plenty. */
const THROTTLE_MS = 5_000;

const inNodeModules = (p: string) => p.split(sep).includes("node_modules");
const hashOf = (text: string) => Bun.hash(text).toString(36);
/** A file's content as the runtime reads it, line endings aside: git writes CRLF or LF by its autocrlf setting, and a
 *  checkout that only re-wrote the line endings (a reset, a merge of an untouched file) is not a new version. */
const contentOf = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** The local files `entry` loads, itself included: the import graph, node_modules and built-ins left out. */
export function importGraph(entry: string): { files: string[]; errors: string[] } {
  const seen = new Set<string>();
  const errors: string[] = [];
  const queue = [resolve(entry)];
  const transpilers = new Map<string, InstanceType<typeof Bun.Transpiler>>();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const ext = extname(file).toLowerCase();
    if (!SCRIPT.has(ext)) continue;   // a JSON or text import: stamped, not scanned
    let imports: { path: string }[];
    try {
      const loader = LOADERS[ext]!;
      let t = transpilers.get(loader);
      if (!t) transpilers.set(loader, t = new Bun.Transpiler({ loader }));
      imports = t.scanImports(readFileSync(file, "utf8"));
    } catch (e: any) {
      errors.push(`${file}: ${String(e?.errors?.[0]?.message ?? e?.message ?? e).slice(0, 200)}`);
      continue;
    }
    for (const imp of imports) {
      // only a path can be this repo's own code: "hono", "node:fs", "bun:sqlite" are the runtime's or a package's
      if (!imp.path.startsWith(".") && !isAbsolute(imp.path)) continue;
      let target: string;
      try { target = Bun.resolveSync(imp.path, dirname(file)); }
      catch { errors.push(`${file}: cannot resolve "${imp.path}"`); continue; }
      if (!inNodeModules(target)) queue.push(target);
    }
  }
  return { files: [...seen].sort(), errors };
}

/** The checkout a file belongs to (the folder holding .git), or null outside one — an installed copy has none. */
export function repoRootOf(file: string): string | null {
  let dir = dirname(resolve(file));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** The commit a checkout is on, read from .git directly (a worktree's .git is a file naming its real folder). */
export function gitHead(repo: string | null): string | null {
  if (!repo) return null;
  try {
    let gitDir = join(repo, ".git");
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = resolve(repo, m[1]!.trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    // a worktree keeps HEAD in its own folder and the branches in the shared one
    let common = gitDir;
    try { common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()); } catch { /* the main checkout */ }
    for (const base of [gitDir, common]) {
      try { return readFileSync(join(base, ref), "utf8").trim(); } catch { /* packed, or in the other folder */ }
    }
    const packed = readFileSync(join(common, "packed-refs"), "utf8");
    return new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed)?.[1] ?? null;
  } catch { return null; }
}

export interface LoadedCodeOpts {
  /** the file the process was started with */
  entry: string;
  /** files, or folders of files, the process reads once and keeps (not imports) */
  extra?: string[];
  /** what paths are shown relative to; default = the checkout, else the entry's folder */
  root?: string;
}

export interface CodeStatus {
  /** when this process started */
  bootAt: number;
  /** the checkout's commit when this process started, and now */
  commit: string | null;
  head: string | null;
  /** a loaded file has other content on disk than this process read */
  stale: boolean;
  changedCount: number;
  /** up to 12 of them, relative to the checkout */
  changed: string[];
  /** the newest modification among the changed files (ms), 0 when none */
  changedAt: number;
  /** one value per distinct set of changes: "dismiss until something else changes" keys on it */
  sig: string;
  /** how many files this process loaded, and what the last check cost */
  files: number;
  scanMs: number;
  /** files the entry imports that could not be read or resolved at boot (a boot that got this far loaded without them) */
  graphErrors: string[];
}

interface Stamp { size: number; mtimeMs: number; hash: string | null }

function stampOf(file: string): Stamp {
  try {
    const st = statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs, hash: hashOf(contentOf(file)) };
  } catch { return { size: -1, mtimeMs: 0, hash: null }; }
}

export class LoadedCode {
  readonly bootAt = Date.now();
  readonly entry: string;
  readonly repo: string | null;
  readonly root: string;
  readonly commit: string | null;
  /** Taken once, here, and fixed for the process's life: it must describe what was LOADED, not what is on disk now.
   *  Construct it while the entry is still importing — every static import has been read by then, so the only blind
   *  spot is an edit landing during boot itself: seconds, not hours. */
  private readonly boot = new Map<string, Stamp>();
  private readonly graphErrors: string[];
  private last: { at: number; status: CodeStatus } | null = null;

  constructor(opts: LoadedCodeOpts) {
    this.entry = resolve(opts.entry);
    this.repo = repoRootOf(this.entry);
    this.root = opts.root ?? this.repo ?? dirname(this.entry);
    this.commit = gitHead(this.repo);
    const graph = importGraph(this.entry);
    this.graphErrors = graph.errors;
    const files = new Set(graph.files);
    for (const x of opts.extra ?? []) {
      let st;
      try { st = statSync(x); } catch { continue; }
      if (st.isFile()) files.add(resolve(x));
      else for (const name of readdirSync(x)) {
        const full = resolve(x, name);
        try { if (statSync(full).isFile()) files.add(full); } catch { /* gone between the two calls */ }
      }
    }
    for (const f of files) this.boot.set(f, stampOf(f));
  }

  /** The loaded files, absolute. */
  loaded(): string[] { return [...this.boot.keys()]; }

  /** The loaded files whose content on disk is no longer what this process read, absolute. */
  changedFiles(): string[] {
    const out: string[] = [];
    for (const [file, was] of this.boot) {
      let st;
      try { st = statSync(file); } catch { if (was.hash !== null) out.push(file); continue; }
      // same size and same mtime as at boot: not rewritten since. Otherwise the content decides — a checkout that
      // rewrote the same bytes, or a save without a change, is not a new version.
      if (st.size === was.size && st.mtimeMs === was.mtimeMs) continue;
      let now: string | null = null;
      try { now = hashOf(contentOf(file)); } catch { /* unreadable = changed */ }
      if (now !== was.hash) out.push(file);
    }
    return out;
  }

  rel(file: string): string { return relative(this.root, file).replace(/\\/g, "/"); }

  status(force = false): CodeStatus {
    const now = Date.now();
    if (!force && this.last && now - this.last.at < THROTTLE_MS) return this.last.status;
    const t0 = performance.now();
    const changed = this.changedFiles();
    let changedAt = 0;
    const parts: string[] = [];
    for (const f of changed) {
      let m = 0;
      try { m = statSync(f).mtimeMs; } catch { /* deleted */ }
      if (m > changedAt) changedAt = m;
      parts.push(`${f}:${m}`);
    }
    const status: CodeStatus = {
      bootAt: this.bootAt,
      commit: this.commit,
      head: gitHead(this.repo),
      stale: changed.length > 0,
      changedCount: changed.length,
      changed: changed.slice(0, 12).map((f) => this.rel(f)),
      changedAt: Math.round(changedAt),
      sig: changed.length ? hashOf(parts.join("|")) : "",
      files: this.boot.size,
      scanMs: Math.round(performance.now() - t0),
      graphErrors: this.graphErrors.slice(0, 5),
    };
    this.last = { at: now, status };
    return status;
  }
}

/**
 * Of `files` (absolute, inside `repo`), the ones git says differ from the commit: edits nobody committed.
 * null = git could not say (not a checkout, git missing) — the caller falls back to "did the commit move".
 */
export async function uncommittedOf(repo: string | null, files: string[]): Promise<Set<string> | null> {
  if (!repo || !files.length) return repo ? new Set() : null;
  try {
    const p = Bun.spawn(["git", "-C", repo, "status", "--porcelain=v1", "-z", "--", ...files.map((f) => relative(repo, f))], {
      stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true,
    });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, 15_000);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    if (code !== 0) return null;
    const dirty = new Set<string>();
    // "XY path\0" per entry; a rename adds the old path as its own \0 field, which is no status line and is skipped
    for (const rec of out.split("\0")) if (rec.length > 3 && rec[2] === " ") dirty.add(resolve(repo, rec.slice(3)));
    return dirty;
  } catch { return null; }
}

/**
 * WOULD THE CODE ON DISK START? Bundle the entry in a child process: every import is resolved and every file parsed,
 * and a name imported from a module that does not export it is an error. Nothing is run. null = it would; else why not.
 * (The supervisor backs off on a worker that keeps dying at boot, but a restart into a syntax error is still an outage:
 * better the old process keeps serving and says what is wrong with the new code.)
 */
export async function bootCheck(entry: string, timeoutMs = 60_000): Promise<string | null> {
  const out = join(tmpdir(), `bootcheck-${process.pid}-${Date.now()}.js`);
  try {
    const p = Bun.spawn([process.execPath, "build", entry, "--target=bun", `--outfile=${out}`], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true, cwd: dirname(entry),
    });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeoutMs);
    const [so, se, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    if (code === 0) return null;
    const text = `${se}\n${so}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6).join(" | ");
    return text.slice(0, 600) || `the build check exited ${code}`;
  } catch (e: any) {
    return `the build check could not run: ${String(e?.message ?? e).slice(0, 200)}`;
  } finally {
    try { unlinkSync(out); } catch { /* never written */ }
  }
}
