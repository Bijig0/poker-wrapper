"""Tier 2 — spot selection: does the study tool solve the RIGHT spot?

For each fixture: load the state onto the fake table, take the /hand export the
study pipeline would consume, and put it through gto-trainer's own audit
endpoint (POST /api/feed-spot). That endpoint compares the OBSERVED table
against the solved configuration actually used and names every divergence —
solution set, effective depth, hero position, the preflop line after snapping
to the solved tree, players in the hand.

This is the layer where the failures in the study notes actually lived: limped
pots, phantom-fold desyncs, the 200bb depth gap. It is also entirely
deterministic and needs NO GTO Wizard — feed-spot imports none of it — so it
runs on every change.

A fixture may declare `expect.spot`:

    "spot": {
      "allow":      ["depth"],       // divergences that are fine here
      "heroPos":    "BTN",           // assert the position it solved as
      "maxSeverity": "minor"         // nothing worse than this
    }

With no `spot` block, the default is: nothing major, and the audit succeeded.

Run:  aof-model/.venv/Scripts/python.exe tests/spot_audit.py [name ...]
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
import os
# The rig under test. The test rig (7701) is the one showing a fake table;
# override for a different one.
WRAPPER = os.environ.get("WRAPPER_URL", "http://127.0.0.1:7701")
from rig import rig_check  # noqa: E402  (is 7701 OUR rig, or CoinPoker's?)
API = "http://127.0.0.1:2000"

SEVERITY = {"info": 0, "minor": 1, "major": 2}


def _req(url: str, body: dict | None = None, timeout: float = 30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        url, data=data, method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            return json.loads(f.read() or b"{}")
    except urllib.error.HTTPError as e:          # feed-spot reports 4xx with a body
        try:
            return json.loads(e.read() or b"{}")
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}


class Case:
    def __init__(self, name: str):
        self.name = name
        self.checks: list[tuple[str, bool, str]] = []
        self.notes: list[tuple[str, str]] = []

    def check(self, ok: bool, label: str, detail: str = "") -> None:
        self.checks.append((label, bool(ok), detail))

    def known(self, label: str, detail: str = "") -> None:
        """A documented limitation: shown every run, never a failure."""
        self.notes.append((label, detail))

    @property
    def failed(self):
        return [c for c in self.checks if not c[1]]


def run(path: Path) -> Case:
    fx = json.loads(path.read_text(encoding="utf-8"))
    c = Case(fx.get("name") or path.stem)
    want = (fx.get("expect") or {}).get("spot") or {}

    load = _req(f"{WRAPPER}/faketable/load", fx["spec"])
    if not load.get("ok"):
        c.check(False, "state loaded", json.dumps(load))
        return c
    time.sleep(1.4)

    hand = (_req(f"{WRAPPER}/hand") or {}).get("hand")
    if not hand:
        c.check(False, "/hand exports the state", "no hand")
        return c

    audit = _req(f"{API}/api/feed-spot", {"hand": hand})
    if not audit.get("ok"):
        c.check(False, "feed-spot audited the spot",
                str(audit.get("error"))[:160])
        return c
    c.check(True, "feed-spot audited the spot")

    discs = audit.get("discrepancies") or []
    allow = set(want.get("allow") or [])
    known = dict(want.get("known") or {})
    cap = SEVERITY.get(want.get("maxSeverity", "minor"), 1)

    seen_known: set[str] = set()
    for d in discs:
        field = d.get("field")
        sev = SEVERITY.get(d.get("severity", "info"), 0)
        detail = (f"{d.get('severity')}: actual={d.get('actual')!r} "
                  f"shown={d.get('shown')!r} {d.get('note') or ''}").strip()
        if field in allow:
            continue
        if field in known:
            # A documented limitation of the solved charts, not a defect in the
            # study tools. Reported every run so it stays visible, but it does
            # not fail the suite — what would fail is it CHANGING.
            seen_known.add(field)
            c.known(f"divergence '{field}'", f"{known[field]} | {detail}")
            continue
        c.check(sev <= cap, f"divergence '{field}' within tolerance", detail)

    # A known limitation that stops happening is news too: either it was fixed
    # (update the fixture) or the spot silently stopped exercising it.
    for field in known:
        if field not in seen_known:
            c.check(False, f"known divergence '{field}' still present",
                    "it is gone — fixed, or this fixture no longer reaches it")

    # The audit reports the configuration it actually solved; a fixture can pin
    # the parts that matter for the spot it is meant to represent.
    shown = audit.get("shown") or {}
    actual = audit.get("actual") or {}
    for key in ("heroPos", "setId", "depth", "street"):
        if key in want:
            got = shown.get(key, actual.get(key))
            c.check(got == want[key], f"solved {key}", f"got {got!r}, want {want[key]!r}")
    if "chart" in want:
        got = (shown.get("chart3max") or {}).get("id")
        c.check(got == want["chart"], "solved from chart", f"got {got!r}, want {want['chart']!r}")

    warn = audit.get("warnings") or []
    c.check(not any("no chart" in str(w).lower() for w in warn),
            "charts available for this spot", "; ".join(map(str, warn))[:160])
    return c


def main() -> int:
    if bad := rig_check(WRAPPER):
        print(bad)
        return 2
    try:
        # /api, not / — the dashboard took the root in the 2026-09-17 restyle and
        # serves HTML there, which made this reachability probe a JSONDecodeError
        # and skipped two whole tiers of run_all.py as "FAIL" with no output.
        _req(f"{API}/api")
    except OSError as e:
        print(f"gto-trainer API not reachable on {API} ({e})")
        return 2

    wanted = set(sys.argv[1:])
    files = sorted(FIXTURES.glob("*.json"))
    if wanted:
        files = [f for f in files if f.stem in wanted
                 or json.loads(f.read_text(encoding="utf-8")).get("name") in wanted]
    if not files:
        print(f"no fixtures in {FIXTURES}")
        return 2

    cases = []
    for f in files:
        print(f"\n=== {f.stem} ===")
        try:
            case = run(f)
        except Exception as e:
            case = Case(f.stem)
            case.check(False, "fixture ran", repr(e))
        cases.append(case)
        for label, detail in case.notes:
            print(f"  KNOWN {label}" + (f"   — {detail}" if detail else ""))
        for label, ok, detail in case.checks:
            print(f"  {'PASS' if ok else 'FAIL'}  {label}"
                  + (f"   — {detail}" if detail else ""))

    try:
        _req(f"{WRAPPER}/faketable/stop", {})
    except Exception:
        pass

    bad = [c for c in cases if c.failed]
    total = sum(len(c.checks) for c in cases)
    print(f"\n{len(cases) - len(bad)}/{len(cases)} fixtures clean "
          f"({total - sum(len(c.failed) for c in cases)}/{total} assertions)")
    if bad:
        print("divergent fixtures: " + ", ".join(c.name for c in bad))
        counts = Counter(lbl for c in bad for lbl, ok, _ in c.checks if not ok)
        for lbl, n in counts.most_common(8):
            print(f"  x{n:<3} {lbl}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
