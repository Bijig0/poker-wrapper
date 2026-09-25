/**
 * Build — and publish — the Poker Wrapper package for another Windows laptop (player mode). Runs on the OWNER's
 * machine, from the working tree. (Port of build_package.py, 2026-09-24 — the wrapper's tooling has no Python.)
 *
 *   bun setup/buildPackage.ts                                  build into ~/poker-package
 *   bun setup/buildPackage.ts --publish --notes "what changed"  gate + upload = an UPDATE
 *   bun setup/buildPackage.ts --no-data                        code zip only
 *   bun setup/buildPackage.ts --status [--json]                what is published vs what this tree would publish
 *
 * Builds:
 *   PokerWrapper-code-<version>.zip       ~10 MB  wrapper, study API + dashboard, chart server + the chart index, launchers,
 *                                                 setup/update scripts, requirements, a TRIMMED ledger, and VERSION.json
 *                                                 (version + a sha256 per file = what the updater diffs against)
 *   PokerWrapper-data-<part>-<hash>.zip   ~1 GB   each big read-only data set, versioned by a hash of its contents:
 *                                                 preflop6 (the baked 6-max SQLite), mesturn (MES turn), nodetrust
 *   release-<version>.json                        what latest.json on the channel says
 *
 * THE UPDATE CHANNEL is R2 (PW_CHANNEL, default r2:poker-solve-db/wrapper — the friend's read-only key reads it):
 *   wrapper/latest.json                  the current release (moved LAST, so a reader never sees a half upload)
 *   wrapper/releases/<version>/          that version's code zip + release.json (kept: -Version <v> rolls back)
 *   wrapper/data/PokerWrapper-data-*.zip data parts, uploaded only when their hash is new
 * The friend's side is setup\update.ps1 (and the setup page's "Update available" banner, via the wrapper's /update).
 * --publish refuses unless `bun setup/regress.ts --publish` is green.
 *
 * Deliberately NOT in it: hands / sessions / answers history, the solve ledger's boxes, machines, proposals, plans,
 * the task board, credentials (R2 keys, Hetzner/Vultr tokens, ssh keys, GitHub), browser profiles, debug recordings,
 * HRC and the solve pipeline, the MES solve trees. The code zip is checked for credential-looking strings.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { pyJsonDumps } from "../gto-trainer/apps/wrapper/src/py";

const ROOT = resolve(import.meta.dir, "..");

/** Tracked files that exist + untracked files that are not ignored, under `paths` (repo-relative, posix). */
function gitFiles(...paths: string[]): string[] {
  const ls = (...args: string[]) => {
    const r = spawnSync("git", ["ls-files", "-z", ...args, "--", ...paths], { cwd: ROOT, maxBuffer: 1 << 28 });
    return (r.stdout?.toString("utf8") ?? "").split("\0").filter(Boolean);
  };
  const files = new Set([...ls(), ...ls("--others", "--exclude-standard")]);
  return [...files].filter((p) => isFile(join(ROOT, p))).sort();
}
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * The chart server (analysis/pipeline/solve/exploit_ui/server.py) + every analysis/pipeline/solve module it imports,
 * transitively — local modules only. (The chart server is still Python; this reads its import statements, anywhere in
 * a file, the way ast.walk did.)
 */
function solveClosure(): string[] {
  const solve = join(ROOT, "analysis", "pipeline", "solve");
  const local = new Set(readdirSync(solve).filter((f) => f.endsWith(".py")).map((f) => f.slice(0, -3)));
  const todo = [join(solve, "exploit_ui", "server.py")];
  const seen = new Set<string>();
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    const names: string[] = [];
    for (const m of src.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
      for (const part of m[1]!.replace(/[()\\]/g, " ").split(",")) {
        const mod = part.trim().split(/\s+/)[0];
        if (mod) names.push(mod);
      }
    }
    for (const m of src.matchAll(/^[ \t]*from[ \t]+\.*([\w.]+)[ \t]+import\b/gm)) names.push(m[1]!);
    for (const n of names) {
      const top = n.split(".")[0]!;
      if (local.has(top)) todo.push(join(solve, `${top}.py`));
    }
  }
  return [...seen].map((p) => p.slice(ROOT.length + 1).replace(/\\/g, "/")).sort();
}

const CODE_TREES = [
  "ignition-study-wrapper",                     // what the wrapper serves + its launchers (html, formats.json, assets)
  "gto-trainer/apps/wrapper",                   // the wrapper itself (TypeScript; run-wrapper.vbs starts it)
  "gto-trainer/apps/api",                       // study API + dashboard
  "gto-trainer/packages",                       // shared code both apps import (data-root: where every record lives)
  "gto-trainer/package.json", "gto-trainer/bun.lock", "gto-trainer/tsconfig.base.json", "gto-trainer/turbo.json",
  "gto-trainer/study-tool.vbs", "gto-trainer/study-tool.cmd", "gto-trainer/study-tool.ico",
  "config/env.ps1", "config/local.env.example",
  "setup",
  ".claude/study-api.ps1", ".claude/chart-server.ps1", ".claude/dev-api.cmd", ".claude/dev-charts.cmd",
  "scripts/start_gtow_chrome.ps1", "scripts/gtow_watchdog.ps1", "scripts/install_gtow_watchdog.ps1",
  "scripts/install_chart_server_task.ps1",
  "aof-model/requirements.txt", "aof-model/requirements-lock.txt",
  "analysis/pipeline/solve/exploit_ui",         // minus solutions/ (ignored; the *.meta.json index comes in via CODE_GLOBS)
  "analysis/pipeline/solve/river",              // the on-the-fly river MES gate the API may call
  "analysis/pipeline/limp_study/exploit_ranges_nl25.json", "analysis/pipeline/limp_study/pool_model_nl25.json",
  "analysis/pipeline/limp_study/pool_model_v4.json", "analysis/pipeline/limp_study/villain_freqs.json",
  "analysis/pipeline/limp_study/corpus_nodes.jsonl",
];
// owner-only state that git tracks (or leaves untracked) but a friend's install must not carry
const CODE_EXCLUDE = [
  /^gto-trainer\/apps\/api\/data\/ledger\.json$/,          // replaced by the trimmed ledger
  /^gto-trainer\/apps\/api\/data\/.*\.bak/,
  /^gto-trainer\/apps\/api\/data\/jobs\//,
  /^gto-trainer\/apps\/api\/data\/gtow_requests\.jsonl$/,  // the owner's GTO Wizard request log
  /^gto-trainer\/apps\/api\/data\/limp_node_trust\.json$/, // a data part (DATA_PARTS), not code
  /^gto-trainer\/apps\/api\/src\/scripts\/_/,                // other sessions' scratch scripts
  /(^|\/)__pycache__\//,
  /^ignition-study-wrapper\/\.profile-/,
];
// the chart index (~1 MB, changes whenever a chart lands) ships with the CODE; gitignored, so globbed here
const CODE_GLOBS: [string, string][] = [["analysis/pipeline/solve/exploit_ui/solutions", "*.meta.json"]];
// the big read-only data, in PARTS, each versioned by a hash of its contents (an update re-downloads only what moved)
const DATA_PARTS: Record<string, [string, string][]> = {
  preflop6: [["gto-trainer/apps/api/data", "hrc6max-preflop.sqlite"]],    // 6-max preflop, baked (2.7 GB)
  mesturn: [["gto-trainer/apps/api/data/mes_turn", "*"]],                 // MES turn extracts (2.3 GB)
  nodetrust: [["gto-trainer/apps/api/data", "limp_node_trust.json"]],     // limp-node trust table (30 MB)
};
const CHANNEL = process.env.PW_CHANNEL || "r2:poker-solve-db/wrapper";
const SECRET_PATTERNS = [
  /aws_secret_access_key\s*=\s*\S{20,}/i, /secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{30,}/i,
  /HCLOUD_TOKEN(_RW)?\s*=\s*[A-Za-z0-9]{40,}/i, /ghp_[A-Za-z0-9]{30,}/i, /github_pat_[A-Za-z0-9_]{30,}/i,
  /-----BEGIN (OPENSSH|RSA) PRIVATE KEY-----/i, /VULTR_API_KEY\s*=\s*[A-Z0-9]{30,}/i,
];
const TEXT_SUFFIXES = new Set([".ts", ".py", ".ps1", ".cmd", ".json", ".env", ".md", ".html", ".txt", ".pyw", ".js", ".vbs"]);

/** Path.glob(pat) in one directory: "*" = every entry, "*.x" = the suffix, else the exact name. */
function glob(dir: string, pat: string): string[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => pat === "*" || (pat.startsWith("*") ? n.endsWith(pat.slice(1)) : n === pat));
  return names.map((n) => join(dir, n));
}
/** sorted() of Windows paths compares case-folded parts — the data-part hash depends on this order. */
const winSorted = (ps: string[]) => [...ps].sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });

function findExe(envName: string, name: string, extra: string[]): string {
  const cands = [process.env[envName], ...(process.env.PATH || "").split(";").map((d) => join(d, `${name}.exe`)), ...extra];
  return cands.find((c) => c && isFile(c)) ?? name;
}
const findRclone = () => findExe("RCLONE", "rclone", [join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "rclone.exe")]);
function findBun(): string {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "config", "env.ps1"), "-EmitCmd"], { encoding: "utf8", timeout: 60_000 });
  const m = /^set "BUN=(.+)"\r?$/m.exec(r.stdout || "");
  return m && isFile(m[1]!) ? m[1]! : process.execPath;
}

type HashCache = Record<string, [number, number, string]>;
/** Content hash; `cache` maps path -> [size, mtime_ns, hash] so the 5 GB of data is hashed once, not per build. */
function sha256File(p: string, cache?: HashCache): string {
  const st = statSync(p, { bigint: true });
  const size = Number(st.size), mtime = Number(st.mtimeNs);
  const hit = cache?.[p];
  if (hit && hit[0] === size && hit[1] === mtime) return hit[2];
  const h = createHash("sha256");
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  const d = h.digest("hex");
  if (cache) cache[p] = [size, mtime, d];
  return d;
}
const loadCache = (p: string): HashCache => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});

const gitHead = () => spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
const dataPartFiles = (part: string) => DATA_PARTS[part]!.flatMap(([d, pat]) => winSorted(glob(join(ROOT, d), pat)).filter(isFile));
const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, "/");

function rc(args: string[], check = true): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(findRclone(), args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const out = { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  if (check && out.code) {
    console.log(`rclone ${args.join(" ")} failed: ${out.stderr.trim().slice(-400)}`);
    process.exit(1);
  }
  return out;
}

/** Every file the code zip ships (repo-relative, posix), minus the trimmed ledger it adds itself. */
function codeFiles(): string[] {
  const files = [...gitFiles(...CODE_TREES), ...solveClosure()];
  for (const [d, pat] of CODE_GLOBS) files.push(...glob(join(ROOT, d), pat).filter(isFile).map(rel));
  return [...new Set(files)].filter((f) => !CODE_EXCLUDE.some((x) => x.test(f))).sort();
}

function partVersion(files: string[], cache: HashCache): string {
  const h = createHash("sha256");
  for (const p of files) h.update(`${rel(p)}|${sha256File(p, cache)}\n`);
  return h.digest("hex").slice(0, 12);
}

/** One entry out of a zip (stored or deflated; the code zip is small enough to read whole). */
function readZipEntry(zipPath: string, name: string): Buffer {
  const z = readFileSync(zipPath);
  let eocd = -1;
  for (let i = z.length - 22; i >= Math.max(0, z.length - 65557); i--) if (z.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip (no end of central directory)");
  let p = z.readUInt32LE(eocd + 16);
  const n = z.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    const method = z.readUInt16LE(p + 10), csize = z.readUInt32LE(p + 20);
    const nlen = z.readUInt16LE(p + 28), xlen = z.readUInt16LE(p + 30), clen = z.readUInt16LE(p + 32);
    const local = z.readUInt32LE(p + 42);
    const entry = z.toString("utf8", p + 46, p + 46 + nlen);
    if (entry === name) {
      const start = local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28);
      const data = z.subarray(start, start + csize);
      return method === 8 ? inflateRawSync(data) : Buffer.from(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`there is no item named '${name}' in the archive`);
}

/** Zip `items` ([absolute path, entry name]) through setup\zip.ps1 (.NET ZipArchive: streaming, ZIP64 past 4 GB). */
function writeZip(out: string, items: [string, string][], level: "Fastest" | "Optimal"): void {
  const list = join(tmpdir(), `pw-zip-${process.pid}-${Date.now()}.json`);
  writeFileSync(list, JSON.stringify(items), "utf8");
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "setup", "zip.ps1"), "-Out", out, "-List", list, "-Level", level],
                      { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`zip failed: ${(r.stderr || r.stdout || "").trim().slice(-400)}`);
}

/**
 * What the friend has vs what this working tree would publish: the channel's latest release, the files that changed
 * / were added / were removed since it, the data parts that moved, and which changed files are not committed (a
 * publish ships the WORKING TREE). Used by --status, publish.ps1 and the owner's setup-page bar.
 */
function releaseStatus(out: string): Record<string, any> {
  const st: Record<string, any> = { ok: true, channel: CHANNEL };
  const r = rc(["cat", `${CHANNEL}/latest.json`], false);
  if (r.code || !r.stdout.trim()) return { ...st, published: null, note: "nothing published on the channel yet (or it is unreadable)" };
  const relj = JSON.parse(r.stdout);
  st.published = Object.fromEntries(["version", "published", "notes", "commit"].map((k) => [k, relj[k] ?? null]));
  const zp = join(out, relj.code.file);
  if (!existsSync(zp)) rc(["copyto", `${CHANNEL}/releases/${relj.version}/${relj.code.file}`, zp], false);
  let old: Record<string, string>;
  try {
    old = JSON.parse(readZipEntry(zp, "PokerWrapper/VERSION.json").toString("utf8")).files;
  } catch (e: any) {
    return { ...st, ok: false, error: `cannot read the published manifest: ${e?.message ?? e}` };
  }
  delete old["gto-trainer/apps/api/data/ledger.json"];     // rebuilt from the live ledger on every build
  const cachePath = join(out, "hash-cache.json");
  const cache = loadCache(cachePath);
  const cur = Object.fromEntries(codeFiles().map((f) => [f, sha256File(join(ROOT, f), cache)]));   // cached: cheap to ask often
  const changed = Object.keys(cur).filter((f) => f in old && old[f] !== cur[f]).sort();
  const added = Object.keys(cur).filter((f) => !(f in old)).sort();
  const removed = Object.keys(old).filter((f) => !(f in cur)).sort();
  const dataMoved: string[] = [];
  for (const part of Object.keys(DATA_PARTS)) {
    const fs = dataPartFiles(part);
    if (fs.length && ((relj.data || {})[part] || {}).version !== partVersion(fs, cache)) dataMoved.push(part);
  }
  writeFileSync(cachePath, JSON.stringify(cache));
  const touched = [...changed, ...added];
  let dirty = new Set<string>();
  if (touched.length) {
    const g = spawnSync("git", ["status", "--porcelain", "-z", "--", ...touched], { cwd: ROOT, maxBuffer: 1 << 26 });
    dirty = new Set((g.stdout?.toString("utf8") ?? "").split("\0").filter((e) => e.length > 3).map((e) => e.slice(3)));
  }
  return { ...st, changed, added, removed, dataChanged: dataMoved, uncommitted: [...dirty].sort(),
           pending: changed.length + added.length + removed.length + dataMoved.length };
}

function printStatus(s: Record<string, any>): void {
  if (!s.published) {
    console.log(s.note || s.error);
    return;
  }
  const p = s.published;
  console.log(`published: ${p.version}  (${p.published})  "${p.notes || ""}"`);
  if (!s.pending) {
    console.log("the working tree matches it - nothing to publish");
    return;
  }
  console.log(`since then: ${s.changed.length} changed, ${s.added.length} added, ${s.removed.length} removed`
              + (s.dataChanged.length ? `; data changed: ${s.dataChanged.join(", ")}` : ""));
  for (const f of [...s.changed, ...s.added].slice(0, 25)) console.log(`   ${s.added.includes(f) ? "+" : "~"} ${f}${s.uncommitted.includes(f) ? "   (uncommitted)" : ""}`);
  for (const f of s.removed.slice(0, 10)) console.log(`   - ${f}`);
  const more = s.changed.length + s.added.length - 25;
  if (more > 0) console.log(`   ... and ${more} more`);
  if (s.uncommitted.length) console.log(`note: ${s.uncommitted.length} of these are not committed - a publish ships them as they are on disk`);
}

/** datetime.now().isoformat(timespec="seconds"): local time, no zone. */
function isoLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? "" : null;
}

function main(): number {
  const a = { status: process.argv.includes("--status"), json: process.argv.includes("--json"), noData: process.argv.includes("--no-data"),
              publish: process.argv.includes("--publish"), skipGate: process.argv.includes("--skip-gate"),
              out: arg("--out") ?? join(homedir(), "poker-package"), notes: arg("--notes") ?? "" };
  const out = resolve(a.out);
  mkdirSync(out, { recursive: true });
  if (a.status) {
    const s = releaseStatus(out);
    if (a.json) console.log(pyJsonDumps(s));
    else printStatus(s);
    return 0;
  }
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const version = `${now.getFullYear()}.${p2(now.getMonth() + 1)}.${p2(now.getDate())}.${p2(now.getHours())}${p2(now.getMinutes())}`;
  const commit = gitHead();       // the package is built from the WORKING TREE; the commit is provenance, not a promise
  const bun = findBun();

  if (a.publish && !a.skipGate) {
    console.log("gate: setup\\regress.ts --publish ...");
    const g = spawnSync(bun, [join(ROOT, "setup", "regress.ts"), "--publish"], { cwd: ROOT, stdio: "inherit" });
    if (g.status) {
      console.log("NOT PUBLISHED: the regression gate is red (fix it, or --skip-gate for an emergency)");
      return 2;
    }
  }

  // 1. the trimmed ledger
  const trimmed = join(out, "ledger.player.json");
  const r = spawnSync(bun, ["setup/build_player_ledger.ts", trimmed], { cwd: ROOT, encoding: "utf8" });
  if (r.status || !existsSync(trimmed)) {
    console.log(r.stdout, r.stderr);
    console.log("could not build the trimmed ledger");
    return 1;
  }
  console.log((r.stdout || "").split(/\r?\n/)[0]);

  // 2. data parts: hash (cached), build the zip for any part whose version has no zip yet
  const cachePath = join(out, "hash-cache.json");
  const cache = loadCache(cachePath);
  const parts: Record<string, Record<string, any>> = {};
  for (const part of Object.keys(DATA_PARTS)) {
    const files = dataPartFiles(part);
    if (!files.length) {
      console.log(`  data part ${part}: no files, skipped`);
      continue;
    }
    const ver = partVersion(files, cache);
    const zp = join(out, `PokerWrapper-data-${part}-${ver}.zip`);
    if (!a.noData && !existsSync(zp)) {
      const tmp = zp.replace(/\.zip$/, ".tmp");
      writeZip(tmp, files.map((p) => [p, `PokerWrapper/${rel(p)}`]), "Fastest");
      renameSync(tmp, zp);
    }
    parts[part] = { version: ver, file: basename(zp), files: files.length };
    if (existsSync(zp)) Object.assign(parts[part]!, { bytes: statSync(zp).size, sha256: sha256File(zp, cache) });
    console.log(`  data part ${part}: ${ver} (${files.length} files)${existsSync(zp) ? "" : " (zip not built: --no-data)"}`);
  }
  writeFileSync(cachePath, JSON.stringify(cache));

  // 3. code, with VERSION.json = version + the manifest the updater diffs against
  const files = codeFiles();
  const manifest: Record<string, string> = Object.fromEntries(files.map((f) => [f, sha256File(join(ROOT, f))]));
  const ledgerRel = "gto-trainer/apps/api/data/ledger.json";
  manifest[ledgerRel] = sha256File(trimmed);
  const stamp = { version, built: isoLocal(), commit, notes: a.notes, data: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.version])), files: manifest };
  const codeZip = join(out, `PokerWrapper-code-${version}.zip`);
  const leaks: string[] = [];
  for (const f of files) {
    const p = join(ROOT, f);
    const dot = f.lastIndexOf(".");
    if (dot > f.lastIndexOf("/") && TEXT_SUFFIXES.has(f.slice(dot).toLowerCase()) && statSync(p).size < 5_000_000) {
      const txt = readFileSync(p, "utf8");
      for (const pat of SECRET_PATTERNS) if (pat.test(txt)) leaks.push(`${f}: ${pat.source}`);
    }
  }
  const versionJson = join(dirname(trimmed), `VERSION-${version}.json`);
  writeFileSync(versionJson, pyJsonDumps(stamp, { indent: 1 }), "utf8");
  writeZip(codeZip, [...files.map((f) => [join(ROOT, f), `PokerWrapper/${f}`] as [string, string]),
                     [trimmed, `PokerWrapper/${ledgerRel}`], [versionJson, "PokerWrapper/VERSION.json"]], "Optimal");
  console.log(`code ${version}: ${Object.keys(manifest).length} files -> ${codeZip} (${(statSync(codeZip).size / 1e6).toFixed(1)} MB)`);
  if (leaks.length) {
    console.log("CREDENTIAL-LOOKING STRINGS FOUND — the code zip was written but must not be shared until these are checked:");
    for (const l of leaks) console.log("    " + l);
    return 3;
  }
  const release = { version, published: isoLocal(), commit, notes: a.notes,
                    code: { file: basename(codeZip), bytes: statSync(codeZip).size, sha256: sha256File(codeZip) }, data: parts };
  const releasePath = join(out, `release-${version}.json`);
  writeFileSync(releasePath, pyJsonDumps(release, { indent: 1 }), "utf8");

  // 4. publish: parts first (only the ones the channel lacks), then the release, then latest.json LAST — a friend
  //    who checks mid-upload still sees the previous, complete release
  if (a.publish) {
    for (const [part, info] of Object.entries(parts)) {
      const dst = `${CHANNEL}/data/${info.file}`;
      // NOT just the exit code: on R2 a stat of a MISSING key answers a phantom directory with exit 0
      const st = rc(["lsjson", "--stat", dst], false);
      let exists = false;
      try {
        const j = JSON.parse(st.stdout);
        exists = st.code === 0 && !j.IsDir && (j.Size ?? -1) === info.bytes;
      } catch {}
      if (exists) {
        console.log(`  ${part} ${info.version}: already on the channel`);
        continue;
      }
      if (!("sha256" in info)) {
        console.log(`NOT PUBLISHED: data part ${part} changed (${info.version}) but its zip was not built (drop --no-data)`);
        return 4;
      }
      console.log(`  uploading ${info.file} (${(info.bytes / 1e9).toFixed(2)} GB) ...`);
      rc(["copyto", join(out, info.file), dst]);
    }
    rc(["copyto", codeZip, `${CHANNEL}/releases/${version}/${basename(codeZip)}`]);
    rc(["copyto", releasePath, `${CHANNEL}/releases/${version}/release.json`]);
    rc(["copyto", releasePath, `${CHANNEL}/latest.json`]);
    console.log(`published ${version} to ${CHANNEL} (latest.json moved)`);
  }
  console.log("done");
  return 0;
}

process.exit(main());
