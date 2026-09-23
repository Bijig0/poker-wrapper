"""Concurrent appends to one session's event log must not lose any.

The multi-table fan-out (launch._fan_out) tells every table to join the SAME
session at the same instant, and each one appends a `table-joined` event. The
append is a read-modify-write over a JSON column, so without the write lock held
across the whole of it the last writer wins and the others' events vanish — seen
for real on 2026-09-20: four tables joined, one `table-joined` was recorded.

Processes, not threads: the tables are separate processes, so a lock inside one
interpreter would prove nothing.

Run:  aof-model/.venv/Scripts/python.exe tests/test_session_events.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import shutil
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import sessions as S  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


TMP = Path(tempfile.mkdtemp(prefix="sessev-"))
DB = TMP / "sessions.sqlite"

WORKER = r'''
import sys, time
sys.path.insert(0, %r)
import sessions as S
from pathlib import Path
st = S.SessionStore(Path(%r))
slot = int(sys.argv[1])
at = float(sys.argv[2])
while time.time() < at:          # every worker appends in the same instant
    time.sleep(0.001)
for i in range(%d):
    st.event("sid", "table-joined", {"slot": slot, "i": i})
'''

PER = 12
N = 4

store = S.SessionStore(DB)
store.start("sid", "test-rig", None, None, {}, {}, {})

src = TMP / "worker.py"
src.write_text(WORKER % (str(ROOT), str(DB), PER), encoding="utf-8")

print("concurrent event appends")
go = time.time() + 1.5
procs = [subprocess.Popen([sys.executable, str(src), str(slot), str(go)]) for slot in range(1, N + 1)]
for p in procs:
    p.wait(timeout=90)
check("every worker exited cleanly", all(p.returncode == 0 for p in procs),
      str([p.returncode for p in procs]))

ev = store.get("sid")["events"]
joined = [e for e in ev if e["kind"] == "table-joined"]
check(f"all {N * PER} appends survived", len(joined) == N * PER, f"got {len(joined)}")
for slot in range(1, N + 1):
    mine = sorted(e["i"] for e in joined if e["slot"] == slot)
    check(f"  ... slot {slot} kept all {PER} of its own", mine == list(range(PER)), str(mine))
check("the events stayed valid JSON", isinstance(ev, list) and all("at" in e for e in ev))

shutil.rmtree(TMP, ignore_errors=True)
print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
