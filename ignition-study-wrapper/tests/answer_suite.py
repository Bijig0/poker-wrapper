"""Tier 3 — Study Answers end to end, against a live GTO Wizard.

Loads each fixture onto the fake table, turns the panel's Study Answers switch
on, and drives the REAL poller: the same loop that answers while you play. Then
asserts an answer actually arrived and that the pipeline reported no failure.

What is deliberately NOT asserted: the pick. `rollAction` samples the mixed
strategy with Math.random() per decision, so the same spot legitimately returns
Raise on one run and Fold on the next — pinning it would produce a test that
fails for the correct reason. A fixture may instead pin the durable parts:

    "answer": {
      "contains":     ["Raise"],   // substrings the panel text must carry
      "maxLatencyMs": 25000,
      "requireChart": true         // solved from a real chart, not a
    }                              // last-resort generic range

Skips cleanly (exit 0) when GTO Wizard is not up, so it can sit in the same run
as the deterministic tiers without turning red on an absent dependency.

Run:  aof-model/.venv/Scripts/python.exe tests/answer_suite.py [name ...]
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures"
import os
# The Study Tool runs the TEST rig on 7701; 7700 is the live rig and has no
# fake table to load, so a suite pointed there reports "unavailable".
WRAPPER = os.environ.get("WRAPPER_URL", "http://127.0.0.1:7701")
API = "http://127.0.0.1:2000"
GTOW_CDP = "http://127.0.0.1:9222/json/version"
GTOW_LIST = "http://127.0.0.1:9222/json/list"

ANSWER_TIMEOUT = 90     # a cold solve navigates GTOW; that is not fast


def _req(url: str, body: dict | None = None, timeout: float = 30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        url, data=data, method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            return json.loads(f.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}")
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}


def gtow_state() -> tuple[bool, str]:
    """Is GTO Wizard actually drivable, and if not, why?

    The debug port answering is not enough: the poller drives a page whose URL
    contains app.gtowizard.com (gtowCdp.TARGET_MATCH), and the client can be
    running with CDP up while showing something else entirely — an activation
    or login screen has no such page, so every solve reports
    gtoWizardConnected=false and each fixture burns its full timeout before
    failing with nothing useful to say. Name the actual state instead.
    """
    try:
        urllib.request.urlopen(GTOW_CDP, timeout=4).read()
    except OSError as e:
        return False, f"debug port 9222 not answering ({e}) — run scripts/start_gtow_ai.ps1"
    try:
        raw = urllib.request.urlopen(GTOW_LIST, timeout=6).read()
        targets = json.loads(raw or b"[]")
    except (OSError, json.JSONDecodeError) as e:
        return False, f"debug port up but /json/list unreadable ({e})"
    pages = [t for t in targets if t.get("type") == "page"]
    if any("app.gtowizard.com" in (t.get("url") or "") for t in pages):
        return True, "app page found"
    if not pages:
        return False, "no page targets yet — the client is still starting"
    where = ", ".join((t.get("url") or "")[:70] for t in pages[:3])
    return False, (f"the client is not on the app — showing: {where}. "
                   "Sign in / activate GTO Wizard, then rerun.")


class Case:
    def __init__(self, name: str):
        self.name = name
        self.checks: list[tuple[str, bool, str]] = []

    def check(self, ok: bool, label: str, detail: str = "") -> None:
        self.checks.append((label, bool(ok), detail))

    @property
    def failed(self):
        return [c for c in self.checks if not c[1]]


def wait_for_answer(deadline: float) -> dict:
    """Poll the poller until it has an answer or a reason it cannot get one."""
    last: dict = {}
    while time.time() < deadline:
        st = _req(f"{API}/api/study-poller/status") or {}
        last = st
        if st.get("lastAnswer"):
            return st
        nav = st.get("lastNavFailure")
        if nav and nav.get("reason"):
            return st          # a definite failure — stop waiting for a miracle
        time.sleep(1.5)
    return last


def run(path: Path) -> Case:
    fx = json.loads(path.read_text(encoding="utf-8"))
    c = Case(fx.get("name") or path.stem)
    want = (fx.get("expect") or {}).get("answer") or {}

    load = _req(f"{WRAPPER}/faketable/load", fx["spec"])
    if not load.get("ok"):
        c.check(False, "state loaded", json.dumps(load))
        return c
    time.sleep(1.4)

    # The panel switch is the poller's gate; without it the poller idles by
    # design and pushes null forever.
    _req(f"{WRAPPER}/study-answers", {"on": True})
    _req(f"{API}/api/study-poller/start", {})

    t0 = time.time()
    st = wait_for_answer(t0 + ANSWER_TIMEOUT)
    elapsed = int((time.time() - t0) * 1000)

    text = st.get("lastAnswer")
    nav = st.get("lastNavFailure") or {}
    c.check(bool(text), "an answer was produced",
            f"after {elapsed}ms; navFailure={nav.get('reason')!r} "
            f"error={st.get('lastError')!r} gtow={st.get('gtoWizardConnected')}")
    if not text:
        return c

    c.check(not nav.get("reason"), "no navigation failure", str(nav.get("reason")))
    c.check(not st.get("lastError"), "no poller error", str(st.get("lastError")))
    c.check(elapsed <= int(want.get("maxLatencyMs", ANSWER_TIMEOUT * 1000)),
            "answer within the latency budget", f"{elapsed}ms")

    for sub in want.get("contains") or []:
        c.check(sub.lower() in text.lower(), f"answer mentions {sub!r}", text[:120])

    # The push the panel would actually show, gated by the toggle and the TTL.
    state = _req(f"{WRAPPER}/state") or {}
    pa = state.get("panelAnswer")
    c.check(bool(pa and pa.get("text")), "answer reached the panel",
            json.dumps(pa)[:160] if pa else "no panelAnswer")

    if want.get("requireChart"):
        # A last-resort generic range is a real answer but a weak one; a
        # fixture can insist the spot had a chart behind it.
        c.check("generic" not in (text or "").lower(),
                "solved from a chart, not a generic range", text[:120])
    return c


def main() -> int:
    ok, why = gtow_state()
    if not ok:
        print(f"SKIPPING Tier 3 — GTO Wizard is not drivable: {why}")
        return 0
    print(f"GTO Wizard ready ({why})")
    for name, url in (("wrapper", f"{WRAPPER}/state"), ("api", f"{API}/")):
        try:
            _req(url)
        except OSError as e:
            print(f"{name} not reachable ({e})")
            return 2

    wanted = set(sys.argv[1:])
    files = sorted(FIXTURES.glob("*.json"))
    if wanted:
        files = [f for f in files if f.stem in wanted
                 or json.loads(f.read_text(encoding="utf-8")).get("name") in wanted]

    cases = []
    for f in files:
        print(f"\n=== {f.stem} ===")
        try:
            case = run(f)
        except Exception as e:
            case = Case(f.stem)
            case.check(False, "fixture ran", repr(e))
        cases.append(case)
        for label, ok, detail in case.checks:
            print(f"  {'PASS' if ok else 'FAIL'}  {label}"
                  + (f"   — {detail}" if detail else ""))

    try:
        _req(f"{WRAPPER}/study-answers", {"on": False})
        _req(f"{API}/api/study-poller/stop", {})
        _req(f"{WRAPPER}/faketable/stop", {})
    except Exception:
        pass

    bad = [c for c in cases if c.failed]
    total = sum(len(c.checks) for c in cases)
    print(f"\n{len(cases) - len(bad)}/{len(cases)} fixtures answered "
          f"({total - sum(len(c.failed) for c in cases)}/{total} assertions)")
    if bad:
        print("unanswered / degraded: " + ", ".join(c.name for c in bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
