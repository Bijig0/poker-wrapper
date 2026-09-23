"""The connection guard: a link too slow for GTO Wizard answers sits us out.

session_20260922_194118: postflop answers took a median 25 s and two river spots
(pocket fives, T4s) got no answer at all. The link measured round trip ~290 ms,
3-6 of 10 packets lost, warm GTO Wizard requests 0.6-1.6 s with spikes past 2 s.
These tests pin (1) that those numbers fail the gate and a healthy link passes,
and (2) the guard's rule: one bad probe is a warning, two in a row sit out, the
box is re-asserted while it stays bad, and it never sits back in by itself.

Run:  aof-model/.venv/Scripts/python.exe tests/test_net_guard.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import launch  # noqa: E402
import netcheck as NC  # noqa: E402

launch._WS_DUMP_PATH = Path(tempfile.mkdtemp()) / "ws_dump.jsonl"
fails: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  ok    {name}")
    else:
        fails.append(f"{name}: got {got!r}, want {want!r}")
        print(f"  FAIL  {name}: got {got!r}, want {want!r}")


def probe_with(conn_ms: list[float], lost: int, warm_ms: list[float], err=None) -> dict:
    NC._connects = lambda: (conn_ms, lost)            # type: ignore[assignment]
    NC._warm = lambda: (warm_ms, err)                 # type: ignore[assignment]
    return NC.probe()


print("the gate")
bad_today = probe_with([285, 290, 300, 288, 292], 5, [604, 598, 1735, 595, 644])
check("2026-09-22's link fails", bad_today["ok"], False)
check("  ... on round trip AND loss", [w.split()[0] for w in bad_today["why"]][:2], ["round", "5"])
check("a clean Jakarta->Sydney link passes", probe_with([110, 120, 105, 130] * 2 + [115, 118], 0, [390, 410, 420, 400, 450])["ok"], True)
check("one lost packet of ten is tolerated", probe_with([120] * 9, 1, [420] * 5)["ok"], True)
check("two lost of ten is not", probe_with([120] * 8, 2, [420] * 5)["ok"], False)
check("a single request stalling past 2 s fails", probe_with([120] * 10, 0, [400, 400, 2300, 400, 400])["ok"], False)
check("unreachable fails, never raises", probe_with([], 10, [], "could not open HTTPS")["ok"], False)

print("\nthe guard")
calls: list[dict] = []
feed: list[str] = []
launch._ignition_sitout_next_hand = lambda: (calls.append({}) or {"ok": True, "clicked": True, "state": "ticked"})  # type: ignore
launch._feed_add = lambda s: feed.append(s)            # type: ignore[assignment]
launch._is_cp = lambda: False                           # type: ignore[assignment]
launch._session.update({"id": None})                   # no session record writes in the test
BAD = {"ok": False, "why": ["round trip 290 ms (max 200)"], "rttMs": 290}
GOOD = {"ok": True, "why": [], "rttMs": 120}

launch._net_step(BAD)
check("one bad probe does not sit out", len(calls), 0)
check("  ... but says so", any("Connection slow" in f for f in feed), True)
launch._net_step(BAD)
check("two in a row sit out", len(calls), 1)
check("  ... and say why on the panel", any("CONNECTION TOO SLOW" in f and "sitting out" in f for f in feed), True)
launch._net_step(BAD)
check("still bad: the box is re-asserted (the click itself is idempotent)", len(calls), 2)
launch._net_step(GOOD)
check("one good probe does not clear it", launch._net["sitout"] is not None, True)
launch._net_step(GOOD)
check("two good probes clear it and tell you to press I'm back", (launch._net["sitout"], any("I'm back" in f for f in feed)), (None, True))
check("  ... never sitting back in by itself", len(calls), 2)

launch._net.update({"bad": 0, "good": 0, "sitout": None})
launch._net_step(BAD)
launch._net_step(GOOD)
launch._net_step(BAD)
check("bad, good, bad is not two in a row", len(calls), 2)

print("\nsit-out failure is loud")
launch._net.update({"bad": 0, "good": 0, "sitout": None})
feed.clear()
launch._ignition_sitout_next_hand = lambda: {"ok": False, "why": "no 'Sit out next hand' box on the table"}  # type: ignore
launch._net_step(BAD)
launch._net_step(BAD)
check("a sit-out that could not be made tells you to do it yourself", any("SIT OUT YOURSELF" in f for f in feed), True)

print()
if fails:
    print(f"FAILED {len(fails)}")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("all passed")
