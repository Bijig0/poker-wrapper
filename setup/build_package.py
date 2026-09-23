"""Build — and publish — the Poker Wrapper package for another Windows laptop (player mode). Runs on the OWNER's
machine, from the working tree.

    aof-model\\.venv\\Scripts\\python.exe setup\\build_package.py                       build into ~/poker-package
    ... setup\\build_package.py --publish --notes "what changed, in a line"             gate + upload = an UPDATE
    ... setup\\build_package.py --no-data                                               code zip only

Builds:
  PokerWrapper-code-<version>.zip          ~10 MB  wrapper, study API + dashboard, chart server + the chart index,
                                                   launchers, setup/update scripts, requirements, a TRIMMED ledger,
                                                   and VERSION.json (version + a sha256 per file = what the
                                                   updater diffs against)
  PokerWrapper-data-<part>-<hash>.zip      ~1 GB   each big read-only data set, versioned by a hash of its
                                                   contents: preflop6 (the baked 6-max SQLite), mesturn (MES turn),
                                                   nodetrust (the limp-node trust table)
  release-<version>.json                           what latest.json on the channel says

The UPDATE CHANNEL is R2 (PW_CHANNEL, default r2:poker-solve-db/wrapper — the friend's read-only key reads it):
  wrapper/latest.json                      the current release (moved LAST, so a reader never sees a half upload)
  wrapper/releases/<version>/              that version's code zip + release.json (kept: -Version <v> rolls back)
  wrapper/data/PokerWrapper-data-*.zip     data parts, uploaded only when their hash is new
The friend's side is setup\\update.ps1 (and the setup page's "Update available" banner, via the wrapper's /update).
--publish refuses unless setup\\regress.py --publish is green.

What is deliberately NOT in it: hands / sessions / answers history, the solve ledger's boxes, machines, proposals,
plans, the task board, credentials (R2 keys, Hetzner/Vultr tokens, ssh keys, GitHub), browser profiles, debug
recordings, HRC and the solve pipeline, the MES solve trees (256 GB). The builder checks the code zip for
credential-looking strings before it finishes.
"""
from __future__ import annotations

import argparse
import ast
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUN = None


def git_files(*paths: str) -> list[str]:
    """Tracked files that exist + untracked files that are not ignored, under `paths` (repo-relative, posix)."""
    def ls(*args):
        out = subprocess.run(["git", "ls-files", "-z", *args, "--", *paths], cwd=ROOT, capture_output=True).stdout
        return [p for p in out.decode("utf-8", "replace").split("\0") if p]
    files = set(ls()) | set(ls("--others", "--exclude-standard"))
    return sorted(p for p in files if (ROOT / p).is_file())


def solve_closure() -> list[str]:
    """exploit_ui/server.py + every analysis/pipeline/solve module it imports, transitively (local modules only)."""
    solve = ROOT / "analysis" / "pipeline" / "solve"
    local = {p.stem for p in solve.glob("*.py")}
    todo, seen = [solve / "exploit_ui" / "server.py"], set()
    while todo:
        f = todo.pop()
        if f in seen or not f.exists():
            continue
        seen.add(f)
        try:
            tree = ast.parse(f.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        for n in ast.walk(tree):
            names = [a.name for a in n.names] if isinstance(n, ast.Import) else [n.module] if isinstance(n, ast.ImportFrom) and n.module else []
            for m in names:
                top = m.split(".")[0]
                if top in local:
                    todo.append(solve / f"{top}.py")
    return sorted(str(p.relative_to(ROOT)).replace("\\", "/") for p in seen)


CODE_TREES = [
    "ignition-study-wrapper",                     # what the wrapper serves + its launchers (html, formats.json, assets)
    "gto-trainer/apps/wrapper",                   # the wrapper itself (TypeScript; run-wrapper.vbs starts it)
    "gto-trainer/apps/api",                       # study API + dashboard
    "gto-trainer/package.json", "gto-trainer/bun.lock", "gto-trainer/tsconfig.base.json", "gto-trainer/turbo.json",
    "gto-trainer/study-tool.pyw", "gto-trainer/study-tool.ico",
    "config/env.ps1", "config/local.env.example",
    "setup",
    ".claude/study-api.ps1", ".claude/chart-server.ps1", ".claude/dev-api.cmd", ".claude/dev-charts.cmd",
    "scripts/start_gtow_chrome.ps1", "scripts/gtow_watchdog.ps1", "scripts/install_gtow_watchdog.ps1",
    "scripts/install_chart_server_task.ps1",
    "aof-model/requirements.txt", "aof-model/requirements-lock.txt", "aof-model/scout/cdp.py",
    "analysis/pipeline/solve/exploit_ui",         # minus solutions/ (ignored; the *.meta.json index comes in via CODE_GLOBS)
    "analysis/pipeline/solve/river",              # the on-the-fly river MES gate the API may call
    "analysis/pipeline/limp_study/exploit_ranges_nl25.json", "analysis/pipeline/limp_study/pool_model_nl25.json",
    "analysis/pipeline/limp_study/pool_model_v4.json", "analysis/pipeline/limp_study/villain_freqs.json",
    "analysis/pipeline/limp_study/corpus_nodes.jsonl",
]
# owner-only state that git tracks (or leaves untracked) but a friend's install must not carry
CODE_EXCLUDE = [
    re.compile(r"^gto-trainer/apps/api/data/ledger\.json$"),          # replaced by the trimmed ledger
    re.compile(r"^gto-trainer/apps/api/data/.*\.bak"),
    re.compile(r"^gto-trainer/apps/api/data/jobs/"),
    re.compile(r"^gto-trainer/apps/api/data/gtow_requests\.jsonl$"),  # the owner's GTO Wizard request log
    re.compile(r"^gto-trainer/apps/api/data/limp_node_trust\.json$"), # a data part (DATA_PARTS), not code
    re.compile(r"^gto-trainer/apps/api/src/scripts/_"),                # other sessions' scratch scripts
    re.compile(r"(^|/)__pycache__/"),
    re.compile(r"^ignition-study-wrapper/\.profile-"),
]
# the chart index (~1 MB, changes whenever a chart lands) ships with the CODE so new charts arrive with an update;
# gitignored, so it is globbed here rather than listed by git
CODE_GLOBS = [("analysis/pipeline/solve/exploit_ui/solutions", "*.meta.json")]
# the big read-only data, in PARTS: each is versioned by a hash of its contents, so an update re-downloads only a
# part that actually changed (a 2 GB download is not something to repeat because a chart index file moved)
DATA_PARTS = {
    "preflop6": [("gto-trainer/apps/api/data", "hrc6max-preflop.sqlite")],   # 6-max preflop, baked (2.7 GB)
    "mesturn":  [("gto-trainer/apps/api/data/mes_turn", "*")],               # MES turn extracts (2.3 GB)
    "nodetrust": [("gto-trainer/apps/api/data", "limp_node_trust.json")],   # limp-node trust table (30 MB, node_trust.py)
}
CHANNEL = os.environ.get("PW_CHANNEL", "r2:poker-solve-db/wrapper")
SECRET_PATTERNS = [
    re.compile(p, re.I) for p in (
        r"aws_secret_access_key\s*=\s*\S{20,}", r"secret_access_key\s*[=:]\s*['\"]?[A-Za-z0-9/+]{30,}",
        r"HCLOUD_TOKEN(_RW)?\s*=\s*[A-Za-z0-9]{40,}", r"ghp_[A-Za-z0-9]{30,}", r"github_pat_[A-Za-z0-9_]{30,}",
        r"-----BEGIN (OPENSSH|RSA) PRIVATE KEY-----", r"VULTR_API_KEY\s*=\s*[A-Z0-9]{30,}",
    )
]


def find_bun() -> str:
    for c in (os.environ.get("BUN"), shutil.which("bun"),
              *sorted((Path(os.environ.get("LOCALAPPDATA", "")) / "Programs").glob("node-v*/node_modules/bun/bin/bun.exe"), reverse=True)):
        if c and Path(c).is_file():
            return str(c)
    return "bun"


def find_rclone() -> str:
    for c in (os.environ.get("RCLONE"), shutil.which("rclone"),
              Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / "rclone.exe"):
        if c and Path(c).is_file():
            return str(c)
    return "rclone"


def sha256_file(p: Path, cache: dict | None = None) -> str:
    """Content hash; `cache` maps path -> [size, mtime_ns, hash] so the 5 GB of data is hashed once, not per build."""
    st = p.stat()
    key = str(p)
    if cache is not None and key in cache and cache[key][:2] == [st.st_size, st.st_mtime_ns]:
        return cache[key][2]
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    d = h.hexdigest()
    if cache is not None:
        cache[key] = [st.st_size, st.st_mtime_ns, d]
    return d


def git_head() -> tuple[str, bool]:
    sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    return sha, False  # the package is built from the WORKING TREE; the commit is provenance, not a promise


def data_part_files(part: str) -> list[Path]:
    out = []
    for d, pat in DATA_PARTS[part]:
        out += [p for p in sorted((ROOT / d).glob(pat)) if p.is_file()]
    return out


def rc(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run([find_rclone(), *args], capture_output=True, text=True)
    if check and r.returncode:
        raise SystemExit(f"rclone {' '.join(args)} failed: {r.stderr.strip()[-400:]}")
    return r


def code_files() -> list[str]:
    """Every file the code zip ships (repo-relative, posix), minus the trimmed ledger it adds itself."""
    files = git_files(*CODE_TREES) + solve_closure()
    for d, pat in CODE_GLOBS:
        files += [p.relative_to(ROOT).as_posix() for p in (ROOT / d).glob(pat) if p.is_file()]
    return sorted({f for f in files if not any(x.search(f) for x in CODE_EXCLUDE)})


def release_status(out: Path) -> dict:
    """What the friend has vs what this working tree would publish: the channel's latest release, the files that
    changed / were added / were removed since it, the data parts that moved, and which changed files are not
    committed (a publish ships the WORKING TREE). Used by --status, publish.cmd and the owner's setup-page bar."""
    st: dict = {"ok": True, "channel": CHANNEL}
    r = rc("cat", f"{CHANNEL}/latest.json", check=False)
    if r.returncode or not r.stdout.strip():
        return {**st, "published": None, "note": "nothing published on the channel yet (or it is unreadable)"}
    rel = json.loads(r.stdout)
    st["published"] = {k: rel.get(k) for k in ("version", "published", "notes", "commit")}
    zp = out / rel["code"]["file"]
    if not zp.exists():
        rc("copyto", f"{CHANNEL}/releases/{rel['version']}/{rel['code']['file']}", str(zp), check=False)
    try:
        with zipfile.ZipFile(zp) as z:
            old = json.loads(z.read("PokerWrapper/VERSION.json"))["files"]
    except Exception as e:
        return {**st, "ok": False, "error": f"cannot read the published manifest: {e}"}
    old.pop("gto-trainer/apps/api/data/ledger.json", None)   # rebuilt from the live ledger on every build
    cache_path = out / "hash-cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    cur = {f: sha256_file(ROOT / f, cache) for f in code_files()}   # cached by size+mtime: cheap to ask often
    changed = sorted(f for f in cur if f in old and old[f] != cur[f])
    added = sorted(f for f in cur if f not in old)
    removed = sorted(f for f in old if f not in cur)
    data_moved = []
    for part in DATA_PARTS:
        fs = data_part_files(part)
        h = hashlib.sha256()
        for p in fs:
            h.update(f"{p.relative_to(ROOT).as_posix()}|{sha256_file(p, cache)}\n".encode())
        if fs and (rel.get("data") or {}).get(part, {}).get("version") != h.hexdigest()[:12]:
            data_moved.append(part)
    cache_path.write_text(json.dumps(cache))
    touched = changed + added
    dirty = set()
    if touched:
        g = subprocess.run(["git", "status", "--porcelain", "-z", "--", *touched], cwd=ROOT, capture_output=True)
        dirty = {e[3:] for e in g.stdout.decode("utf-8", "replace").split("\0") if len(e) > 3}
    return {**st, "changed": changed, "added": added, "removed": removed, "dataChanged": data_moved,
            "uncommitted": sorted(dirty), "pending": len(changed) + len(added) + len(removed) + len(data_moved)}


def print_status(s: dict) -> None:
    if not s.get("published"):
        print(s.get("note") or s.get("error"))
        return
    p = s["published"]
    print(f"published: {p['version']}  ({p['published']})  \"{p.get('notes') or ''}\"")
    if not s.get("pending"):
        print("the working tree matches it - nothing to publish")
        return
    print(f"since then: {len(s['changed'])} changed, {len(s['added'])} added, {len(s['removed'])} removed"
          + (f"; data changed: {', '.join(s['dataChanged'])}" if s["dataChanged"] else ""))
    for f in (s["changed"] + s["added"])[:25]:
        print(f"   {'+' if f in s['added'] else '~'} {f}{'   (uncommitted)' if f in s['uncommitted'] else ''}")
    for f in s["removed"][:10]:
        print(f"   - {f}")
    more = len(s["changed"]) + len(s["added"]) - 25
    if more > 0:
        print(f"   ... and {more} more")
    if s["uncommitted"]:
        print(f"note: {len(s['uncommitted'])} of these are not committed - a publish ships them as they are on disk")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true", help="what is published vs what this tree would publish")
    ap.add_argument("--json", action="store_true", help="with --status: machine-readable")
    ap.add_argument("--out", default=str(Path.home() / "poker-package"))
    ap.add_argument("--no-data", action="store_true", help="code zip only (skip building data parts)")
    ap.add_argument("--publish", action="store_true", help=f"gate, then upload to {CHANNEL} and move latest.json")
    ap.add_argument("--notes", default="", help="one or two lines the friend sees on the update banner")
    ap.add_argument("--skip-gate", action="store_true", help="publish without setup\\regress.py --publish (emergency only)")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.status:
        s = release_status(out)
        print(json.dumps(s)) if a.json else print_status(s)
        return 0
    version = dt.datetime.now().strftime("%Y.%m.%d.%H%M")
    commit, _ = git_head()

    if a.publish and not a.skip_gate:
        print("gate: setup\\regress.py --publish ...")
        g = subprocess.run([sys.executable, str(ROOT / "setup" / "regress.py"), "--publish"], cwd=ROOT)
        if g.returncode:
            print("NOT PUBLISHED: the regression gate is red (fix it, or --skip-gate for an emergency)")
            return 2

    # 1. the trimmed ledger
    trimmed = out / "ledger.player.json"
    r = subprocess.run([find_bun(), "setup/build_player_ledger.ts", str(trimmed)], cwd=ROOT, capture_output=True, text=True)
    if r.returncode or not trimmed.exists():
        print(r.stdout, r.stderr)
        print("could not build the trimmed ledger")
        return 1
    print(r.stdout.splitlines()[0])

    # 2. data parts: hash (cached), build the zip for any part whose version has no zip yet
    cache_path = out / "hash-cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    parts = {}
    for part in DATA_PARTS:
        files = data_part_files(part)
        if not files:
            print(f"  data part {part}: no files, skipped")
            continue
        h = hashlib.sha256()
        for p in files:
            h.update(f"{p.relative_to(ROOT).as_posix()}|{sha256_file(p, cache)}\n".encode())
        ver = h.hexdigest()[:12]
        zp = out / f"PokerWrapper-data-{part}-{ver}.zip"
        if not a.no_data and not zp.exists():
            tmp = zp.with_suffix(".tmp")
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
                for p in files:
                    z.write(p, f"PokerWrapper/{p.relative_to(ROOT).as_posix()}")
            tmp.replace(zp)
        parts[part] = {"version": ver, "file": zp.name, "files": len(files)}
        if zp.exists():
            parts[part].update(bytes=zp.stat().st_size, sha256=sha256_file(zp, cache))
        print(f"  data part {part}: {ver} ({len(files)} files){'' if zp.exists() else ' (zip not built: --no-data)'}")
    cache_path.write_text(json.dumps(cache))

    # 3. code, with VERSION.json = version + the manifest the updater diffs against
    files = code_files()
    manifest = {f: sha256_file(ROOT / f) for f in files}
    ledger_rel = "gto-trainer/apps/api/data/ledger.json"
    manifest[ledger_rel] = sha256_file(trimmed)
    stamp = {"version": version, "built": dt.datetime.now().isoformat(timespec="seconds"), "commit": commit,
             "notes": a.notes, "data": {k: v["version"] for k, v in parts.items()}, "files": manifest}
    code_zip = out / f"PokerWrapper-code-{version}.zip"
    leaks = []
    with zipfile.ZipFile(code_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in files:
            p = ROOT / f
            z.write(p, f"PokerWrapper/{f}")
            if p.suffix.lower() in (".ts", ".py", ".ps1", ".cmd", ".json", ".env", ".md", ".html", ".txt", ".pyw", ".js") and p.stat().st_size < 5_000_000:
                txt = p.read_text(encoding="utf-8", errors="replace")
                leaks += [f"{f}: {pat.pattern}" for pat in SECRET_PATTERNS if pat.search(txt)]
        z.write(trimmed, f"PokerWrapper/{ledger_rel}")
        z.writestr("PokerWrapper/VERSION.json", json.dumps(stamp, indent=1))
    print(f"code {version}: {len(manifest)} files -> {code_zip} ({code_zip.stat().st_size / 1e6:.1f} MB)")
    if leaks:
        print("CREDENTIAL-LOOKING STRINGS FOUND — the code zip was written but must not be shared until these are checked:")
        for l in leaks:
            print("   ", l)
        return 3

    release = {"version": version, "published": dt.datetime.now().isoformat(timespec="seconds"), "commit": commit,
               "notes": a.notes,
               "code": {"file": code_zip.name, "bytes": code_zip.stat().st_size, "sha256": sha256_file(code_zip)},
               "data": parts}
    (out / f"release-{version}.json").write_text(json.dumps(release, indent=1))

    # 4. publish: parts first (only the ones the channel lacks), then the release, then latest.json LAST — a
    #    friend who checks mid-upload still sees the previous, complete release
    if a.publish:
        for part, info in parts.items():
            dst = f"{CHANNEL}/data/{info['file']}"
            # NOT just the exit code: on R2 a stat of a MISSING key answers a phantom directory with exit 0
            st = rc("lsjson", "--stat", dst, check=False)
            try:
                exists = st.returncode == 0 and not json.loads(st.stdout).get("IsDir") and json.loads(st.stdout).get("Size", -1) == info.get("bytes")
            except Exception:
                exists = False
            if exists:
                print(f"  {part} {info['version']}: already on the channel")
                continue
            if "sha256" not in info:
                print(f"NOT PUBLISHED: data part {part} changed ({info['version']}) but its zip was not built (drop --no-data)")
                return 4
            print(f"  uploading {info['file']} ({info['bytes'] / 1e9:.2f} GB) ...")
            rc("copyto", str(out / info["file"]), dst)
        rc("copyto", str(code_zip), f"{CHANNEL}/releases/{version}/{code_zip.name}")
        rc("copyto", str(out / f"release-{version}.json"), f"{CHANNEL}/releases/{version}/release.json")
        rc("copyto", str(out / f"release-{version}.json"), f"{CHANNEL}/latest.json")
        print(f"published {version} to {CHANNEL} (latest.json moved)")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
