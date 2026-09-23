"""Which screen the wrapper opens on.

    aof-model/.venv/Scripts/python.exe tests/test_monitor.py

The rule must not depend on WHEN it is asked. `target_area()` is re-read at five
points over the first seconds of a launch — startup, surfacing the panel, opening
the table window, and two delayed apply_layout timers — so a rule that reads the
mouse gives a different answer at each one. On 2026-09-19, thirteen identical
launches: twelve on the laptop panel, one on the external, nothing different but
where the pointer was. Four tiled tables need it stable too.

`monitors()` is a Windows API call, so it is stubbed here; the decision itself is
pure and is what these assert.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import launch  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


# Brady's desk, as the logs report it: the Zenbook panel is primary at the origin,
# the external sits to its right.
LAPTOP = {"x": 0, "y": 0, "w": 2880, "h": 1704, "primary": True}
EXTERNAL = {"x": 2880, "y": 0, "w": 2560, "h": 1504, "primary": False}

_real_monitors = launch.monitors


def with_monitors(mons):
    launch.monitors = lambda: list(mons)


def env(value):
    if value is None:
        os.environ.pop("STUDY_MONITOR", None)
    else:
        os.environ["STUDY_MONITOR"] = value


try:
    print("default — the external screen whenever one is attached")
    env(None)
    with_monitors([LAPTOP, EXTERNAL])
    check("two screens → the external", launch.target_area() == EXTERNAL, str(launch.target_area()))
    with_monitors([EXTERNAL, LAPTOP])
    check("  ... whatever order Windows enumerates them", launch.target_area() == EXTERNAL)
    with_monitors([LAPTOP])
    check("laptop alone → the laptop", launch.target_area() == LAPTOP)
    with_monitors([])
    check("no monitors at all → a sane default, never a crash", launch.target_area()["w"] > 0)

    # THE POINT OF THE RULE: the same answer however many times it is asked, and
    # wherever the mouse is. Five call sites over the first seconds of a launch used to
    # be five independent chances to land somewhere else.
    print("stability")
    with_monitors([LAPTOP, EXTERNAL])
    answers = {tuple(sorted(launch.target_area().items())) for _ in range(20)}
    check("twenty calls, one answer", len(answers) == 1, str(len(answers)))

    print("overrides")
    env("primary")
    check("STUDY_MONITOR=primary → the laptop", launch.target_area() == LAPTOP)
    env("external")
    check("STUDY_MONITOR=external → the external", launch.target_area() == EXTERNAL)
    env("secondary")
    check("  ... 'secondary' still accepted", launch.target_area() == EXTERNAL)
    env("EXTERNAL")
    check("  ... and case does not matter", launch.target_area() == EXTERNAL)
    env("primary")
    with_monitors([EXTERNAL])
    check("primary asked for, only the external attached → the external",
          launch.target_area() == EXTERNAL)

    # the old behaviour is still reachable for anyone who wants it
    print("cursor, on request")
    env("cursor")
    with_monitors([LAPTOP, EXTERNAL])
    a = launch.target_area()
    check("STUDY_MONITOR=cursor returns a real monitor", a in (LAPTOP, EXTERNAL), str(a))
finally:
    launch.monitors = _real_monitors
    env(None)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
