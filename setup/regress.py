r"""Regression gate for the Poker Wrapper: one line per check + a summary. Exit 0 = green.

    aof-model\.venv\Scripts\python.exe setup\regress.py            full: API tests + typecheck + wrapper tests,
                                                                     typecheck, contract + the headless rig test +
                                                                     live smoke (:2000 / :8777 / :7700)
    ... setup\regress.py --quick                                    skip the rig test
    ... setup\regress.py --publish                                  what build_package.py --publish requires:
                                                                     no rig test, no live checks

Baselines (2026-09-24): API bun test 0 fail; tsc 0 errors outside src/scripts/_* (other sessions' scratch scripts,
never shipped); wrapper bun test 0 fail (2 skips); contract 287/287 with the transcript identical. The wrapper is
TypeScript only (the Python one was deleted 2026-09-24); every Bun here is the one config/env.ps1 resolves, the one
the launchers run. The rig test runs on its own headless rig (:7792) — never :7700 / :7701. The live checks need
the StudyAPI/ChartServer services and, for :7700, the Poker Wrapper open.
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "gto-trainer" / "apps" / "api"
PUBLISH = "--publish" in sys.argv
QUICK = "--quick" in sys.argv or PUBLISH
results = []


def find_bun() -> str:
    # THE SAME BUN THE LAUNCHERS RUN (2026-09-24): config/env.ps1 resolves it (PATH's bun.exe, then the ZIP Node's
    # bundled one). PATH's `bun` here was npm's bun.CMD shim — a different Bun (1.4.0 vs the launchers' 1.3.14) —
    # and 1.3.14 drops a statement calling a function named `declare`, which only the launchers' Bun showed.
    if not os.environ.get("BUN"):
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                                  str(ROOT / "config" / "env.ps1"), "-EmitCmd"], capture_output=True, text=True, timeout=60).stdout
            m = re.search(r'^set "BUN=(.+)"$', out, re.M)
            if m and Path(m.group(1)).is_file():
                return m.group(1)
        except Exception:
            pass
    for c in (os.environ.get("BUN"), shutil.which("bun"),
              *sorted((Path(os.environ.get("LOCALAPPDATA", "")) / "Programs").glob("node-v*/node_modules/bun/bin/bun.exe"), reverse=True),
              Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / "bun.exe"):
        if c and Path(c).is_file():
            return str(c)
    return "bun"


BUN = find_bun()


def rec(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name:34s} {detail}", flush=True)


def get(url, timeout=20, data=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json"} if data is not None else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def run(cmd, cwd, timeout):
    p = subprocess.run([str(c) for c in cmd], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    return p.returncode, p.stdout + p.stderr


# 1. API unit tests
try:
    code, out = run([BUN, "test"], API, 600)
    m = re.search(r"(\d+) pass\s+(\d+) fail", out)
    fails = [l.strip()[7:120] for l in out.splitlines() if l.startswith("(fail)")]
    rec("api unit tests (bun test)", bool(m) and m.group(2) == "0",
        (f"{m.group(1)} pass / {m.group(2)} fail" + (f": {'; '.join(fails[:3])}" if fails else "")) if m else out[-200:])
except Exception as e:
    rec("api unit tests (bun test)", False, str(e))

# 2. API typecheck — errors in src/scripts/_* are scratch scripts (not shipped, not ours to fix here)
try:
    code, out = run([BUN, ROOT / "gto-trainer" / "node_modules" / "typescript" / "bin" / "tsc", "--noEmit", "-p", "."], API, 600)
    errs = [l for l in out.splitlines() if "error TS" in l]
    real = [l for l in errs if not re.match(r"src[\\/]scripts[\\/]_", l)]
    rec("api typecheck (tsc)", not real, f"{len(real)} errors" + (f": {real[0][:120]}" if real else "")
        + (f" (+{len(errs) - len(real)} in scratch src/scripts/_*)" if len(errs) > len(real) else ""))
except Exception as e:
    rec("api typecheck (tsc)", False, str(e))

# 3. the wrapper (gto-trainer/apps/wrapper — TypeScript only since 2026-09-24): its unit tests + the goldens
#    (reader / pure / CDP trace / CoinPoker, first recorded from the Python wrapper), its typecheck, and the HTTP
#    contract replayed against a headless instance on its own ports (7791 / 9391) — never :7700 / :7701.
#    Baselines: bun test 0 fail (2 skips: the opt-in rig test, a recording that is not on disk); contract
#    287/287 and the transcript identical to the recording.
TSW = ROOT / "gto-trainer" / "apps" / "wrapper"
try:
    code, out = run([BUN, "test"], TSW, 900)
    m = re.search(r"(\d+) pass\s+(?:(\d+) skip\s+)?(\d+) fail", out)
    fails = [l.strip()[7:120] for l in out.splitlines() if l.startswith("(fail)")]
    rec("wrapper TS tests (bun test)", bool(m) and m.group(3) == "0",
        (f"{m.group(1)} pass / {m.group(3)} fail" + (f": {'; '.join(fails[:3])}" if fails else "")) if m else out[-200:])
except Exception as e:
    rec("wrapper TS tests (bun test)", False, str(e))
try:
    code, out = run([BUN, ROOT / "gto-trainer" / "node_modules" / "typescript" / "bin" / "tsc", "--noEmit", "-p", "."], TSW, 600)
    errs = [l for l in out.splitlines() if "error TS" in l]
    rec("wrapper TS typecheck (tsc)", code == 0 and not errs, f"{len(errs)} errors" + (f": {errs[0][:120]}" if errs else ""))
except Exception as e:
    rec("wrapper TS typecheck (tsc)", False, str(e))
try:
    code, out = run([BUN, "run", "test/contract/runner.ts", "--impl", "ts"], TSW, 600)
    m = re.search(r"ts: (\d+)/(\d+) assertions passed", out)
    ident = "transcript identical" in out
    rec("wrapper TS contract (vs Python)", code == 0 and bool(m) and ident,
        (f"{m.group(1)}/{m.group(2)} assertions, transcript {'identical' if ident else 'DIFFERS'}") if m else out[-200:])
except Exception as e:
    rec("wrapper TS contract (vs Python)", False, str(e))


if not QUICK:
    # the end-to-end rig: pick -> relay -> the fake table's own click record, on a headless rig of its OWN
    # (panel :7792, CDP :9392, its own profile) — it never touches :7700 or Brady's :7701 rig, and no window opens
    try:
        os.environ["WRAPPER_RIG_TEST"] = "1"          # the rig test is opt-in (it launches a headless browser)
        try:
            code, out = run([BUN, "test", "test/unit/pick-relay-rig.test.ts"], TSW, 300)
        finally:
            os.environ.pop("WRAPPER_RIG_TEST", None)
        m = re.search(r"(\d+) pass\s+(?:(\d+) skip\s+)?(\d+) fail", out)
        rec("wrapper rig (pick -> relay)", code == 0 and bool(m) and m.group(3) == "0" and m.group(1) == "1",
            f"{m.group(1)} pass / {m.group(3)} fail" if m else out[-200:])
    except Exception as e:
        rec("wrapper rig (pick -> relay)", False, str(e))

# 4. live smoke
if not PUBLISH:
    try:
        j = get("http://127.0.0.1:2000/api/dashboard/sources/strategies")
        st = {s["id"]: s["status"] for s in j["strategies"]}
        ok = all(st.get(k) in ("ok", "drift") for k in ("ign25-zone-3max-exploit", "ign200-zone-3max-equilibrium",
                                                       "ign200-ring-6max-equilibrium", "cp200-hu-equilibrium"))
        rec("api :2000 strategies", ok, " ".join(f"{k.split('-')[0]}:{v}" for k, v in st.items()))
    except Exception as e:
        rec("api :2000 strategies", False, str(e))
    try:
        n = get("http://127.0.0.1:8777/api/preflop/node?source=hrc_hu_cp200a_d100_o2_5_3b9&line=", timeout=90)
        rec("chart server :8777 node", bool(n.get("ok")), f"root {n.get('pos')} {[a['token'] for a in n.get('actions', [])]}")
    except Exception as e:
        rec("chart server :8777 node", False, str(e))
    try:
        s = get("http://127.0.0.1:7700/state?light=1")
        rec("wrapper :7700 /state", "site" in s and "panelVersion" in s, f"site {s.get('site')} session {s.get('sessionId')}")
        for site, preset, cfg in (("ignition", "strategy:ign200-ring-6max-equilibrium", {"format": "ign-ring-NL200-6"}),
                                  ("coinpoker", "strategy:cp200-hu-equilibrium", {"format": "cp-hu-NL200", "recording": False})):
            pf = get("http://127.0.0.1:7700/session/preflight", data={"preset": preset, "config": {"site": site, **cfg}}, timeout=60)
            # environment, not regressions: the Ignition profile, the live connection speed (netcheck), and
            # the CoinPoker attached table (none is picked by this call; the setup page picks one)
            hard = [c["label"] for c in pf["checks"] if c["required"] and not c["ok"] and c["id"] not in ("profile", "net", "cp-table")]
            rec(f"wrapper preflight {site}", not hard, f"{len(pf['checks'])} checks; blocking: {hard or 'none'}")
    except Exception as e:
        rec("wrapper :7700 (open the Poker Wrapper)", False, str(e))
    try:
        code, out = run([BUN, "src/scripts/cpHuSmoke.ts"], API, 300)
        ans = re.findall(r"hrc-hu-preflop/chart-hu .* -> pick (\S+)", out)
        rec("coinpoker HU preflop smoke", len(ans) == 4 and "refused" in out, f"{len(ans)}/4 answered: {ans}")
    except Exception as e:
        rec("coinpoker HU preflop smoke", False, str(e))

bad = [n for n, ok, _ in results if not ok]
print(f"\n{'ALL GREEN' if not bad else 'FAILURES: ' + ', '.join(bad)}  ({time.strftime('%H:%M:%S')})")
sys.exit(1 if bad else 0)
