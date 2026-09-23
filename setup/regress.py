"""Regression gate for the Poker Wrapper: one line per check + a summary. Exit 0 = green.

    aof-model\\.venv\\Scripts\\python.exe setup\\regress.py            full: unit + typecheck + wrapper tiers + rig
                                                                     state suite + live smoke (:2000 / :8777 / :7700)
    ... setup\\regress.py --quick                                    skip the rig state suite
    ... setup\\regress.py --publish                                  what build_package.py --publish requires:
                                                                     unit + typecheck + wrapper tiers, no live checks

Baselines (2026-09-22): bun test 0 fail; tsc 0 errors outside src/scripts/_* (other sessions' scratch scripts,
never shipped); rig state suite 15/16 fixtures, the one failure = multitable-ws-2026-09-21 (a WS recording with no
spec). The rig must be on :7701 (gto-trainer\\study-tool.pyw) for the state suite; the live checks need the
StudyAPI/ChartServer services and, for :7700, the Poker Wrapper open.
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "gto-trainer" / "apps" / "api"
WR = ROOT / "ignition-study-wrapper"
VPY = ROOT / "aof-model" / ".venv" / "Scripts" / "python.exe"
PUBLISH = "--publish" in sys.argv
QUICK = "--quick" in sys.argv or PUBLISH
results = []


def find_bun() -> str:
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
    rec("api unit tests (bun test)", bool(m) and m.group(2) == "0", f"{m.group(1)} pass / {m.group(2)} fail" if m else out[-200:])
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

# 3. wrapper fast tiers (the ones run_all runs, minus parity/spot/answers which are slow or API-side)
FAST = [("line fuzz", ["tests/fuzz_reconcile.py", "600"]), ("tap isolation", ["tests/test_tap_isolation.py"]),
        ("top-up windows", ["tests/test_topup_window.py"]), ("frame resolver", ["tests/test_frame_resolver.py"]),
        ("table presence", ["tests/test_presence.py"]), ("table claims", ["tests/test_tables.py"]),
        ("seating", ["tests/test_seating.py"]), ("session tables", ["tests/test_session_tables.py"])]
for name, args in FAST:
    try:
        code, out = run([VPY, "-u", *args], WR, 300)
        rec(f"wrapper {name}", code == 0, out.strip().splitlines()[-1][:90] if out.strip() else "")
    except Exception as e:
        rec(f"wrapper {name}", False, str(e))


def rig_visible():
    try:
        import websocket
        t = json.load(urllib.request.urlopen("http://127.0.0.1:9334/json", timeout=5))[0]
        c = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
        c.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": "document.visibilityState", "returnByValue": True}}))
        while True:
            m = json.loads(c.recv())
            if m.get("id") == 1:
                return m["result"]["result"]["value"] == "visible"
    except Exception:
        return None


if not QUICK:
    # THE RIG'S TABLE MUST BE ON SCREEN: the relay refuses to press a page Chrome is not rendering, so a covered
    # rig window looks like 40 regressions. Minimize the LIVE wrapper's windows (never the rig's) and re-front it.
    if rig_visible() is False:
        subprocess.run(["powershell", "-NoProfile", "-Command",
            "Add-Type 'using System; using System.Runtime.InteropServices; public class WM { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); }';"
            "Get-Process brave -EA 0 | ? { $_.MainWindowTitle -like 'Poker Wrapper*' -and $_.MainWindowTitle -notlike 'Poker Wrapper Tool*' } | % { [void][WM]::ShowWindow($_.MainWindowHandle, 6) }"],
            capture_output=True, timeout=30)
        try: get("http://127.0.0.1:7701/layout", data={}, timeout=30)
        except Exception: pass
        time.sleep(3)
        print(f"      (rig table was covered — live wrapper windows minimized; now visible: {rig_visible()})")
    try:
        code, out = run([VPY, "-u", "tests/run_state_suite.py"], WR, 900)
        st = re.search(r"(\d+)/(\d+) fixtures passed \((\d+)/(\d+) assertions\)", out)
        failing = re.search(r"failing fixtures: (.*)", out)
        ok = bool(st) and (failing is None or failing.group(1).strip() == "multitable-ws-2026-09-21")
        rec("wrapper state suite (rig :7701)", ok, f"{st.group(1)}/{st.group(2)} fixtures, {st.group(3)}/{st.group(4)} assertions; failing: {failing.group(1) if failing else 'none'}" if st else out[-200:])
    except Exception as e:
        rec("wrapper state suite (rig :7701)", False, str(e))

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
            # "profile" and the client-side rows are environment, not regressions
            hard = [c["label"] for c in pf["checks"] if c["required"] and not c["ok"] and c["id"] not in ("profile",)]
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
