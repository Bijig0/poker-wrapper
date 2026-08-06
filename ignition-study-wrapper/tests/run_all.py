"""Every tier, in the order that makes a failure easiest to place.

    1  state suite      fixture -> /hand export, relay, refusals   (fake table)
    2  reader parity    recorded real states round-trip            (fake table)
    3  spot audit       did it solve the RIGHT spot                (+ API)
    4  answers          did an answer arrive                       (+ GTO Wizard)

Ordered cheapest-and-most-local first: a broken reader fails tier 1 and every
tier after it, so reading the FIRST failure is reading the cause. Tiers that
need a dependency skip rather than fail when it is absent, so a run with no GTO
Wizard is a pass with a gap, not a red suite.

Run:  aof-model/.venv/Scripts/python.exe tests/run_all.py [--all]
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable

TIERS = [
    ("state suite   ", "run_state_suite.py", []),
    ("reader parity ", "reader_parity.py", ["--all"] if "--all" in sys.argv else []),
    ("spot audit    ", "spot_audit.py", []),
    ("answers (gtow)", "answer_suite.py", []),
]


def main() -> int:
    results = []
    for label, script, extra in TIERS:
        print(f"\n{'=' * 70}\n{label.strip()}  ({script})\n{'=' * 70}")
        t0 = time.time()
        p = subprocess.run([PY, "-u", str(HERE / script), *extra], cwd=str(HERE.parent))
        results.append((label, p.returncode, time.time() - t0))

    print(f"\n{'=' * 70}")
    worst = 0
    for label, code, secs in results:
        # 0 = clean (a skipped tier also exits 0 and says so in its own output)
        state = "PASS" if code == 0 else ("FAIL" if code == 1 else "UNAVAILABLE")
        worst = max(worst, 1 if code else 0)
        print(f"  {state:<12} {label}  {secs:5.0f}s")
    print(f"{'=' * 70}")
    return worst


if __name__ == "__main__":
    sys.exit(main())
