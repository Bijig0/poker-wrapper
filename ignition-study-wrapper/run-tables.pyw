"""Open 1-4 Ignition tables, each with its own study answers.

    aof-model/.venv/Scripts/pythonw.exe run-tables.pyw [N] [--fake] [--stop]

Each slot runs the TypeScript wrapper (gto-trainer/apps/wrapper); WRAPPER_IMPL=python runs the Python one.

N is 1-4 (Ignition's own ceiling); it defaults to 1, which is exactly today's
single-table setup and takes none of the multi-table paths.

WHAT THIS STARTS

    slot 1  panel :7700  ─┐
    slot 2  panel :7710   ├─ four wrapper PROCESSES, one shared Chrome
    slot 3  panel :7720   │  (one --user-data-dir ⇒ one login, one CDP port),
    slot 4  panel :7730  ─┘  four app windows, four panels

Four tables are four processes rather than one process with four of everything,
because the wrapper is six thousand lines of module-level state that presses
buttons with real money: the failure mode of sharing that state across tables is
"acted on the wrong table's state", and process isolation makes it impossible
rather than unlikely.

Nothing here hands out windows: the client keeps all N tables in ONE page and
tiles them itself, so starting N wrappers IS the setup, and a wrapper that dies
can be restarted on its own and picks its own table back up by its slot.

The API needs no telling either: each wrapper registers itself with the study
poller by its own panel URL, and the poller keeps one per wrapper.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tables as TABLES          # noqa: E402  — the port map and the presence contract

ROOT = Path(__file__).resolve().parent
VENV_PYW = ROOT.parent / "aof-model" / ".venv" / "Scripts" / "pythonw.exe"
RUN = ROOT / "run-study.pyw"
# the TypeScript wrapper (2026-09-24) is what each slot runs; WRAPPER_IMPL=python runs run-study.pyw instead
MAIN_TS = ROOT.parent / "gto-trainer" / "apps" / "wrapper" / "src" / "main.ts"
PYTHON_IMPL = os.environ.get("WRAPPER_IMPL", "").lower() in ("py", "python")


def _find_bun() -> str:
    """bun: $BUN, PATH, the ZIP-installed Node's bundled bun, npm global, ~/.bun — config/env.ps1's search."""
    import glob
    import shutil
    local = os.environ.get("LOCALAPPDATA", "")
    on_path = shutil.which("bun")
    on_path = on_path if on_path and on_path.lower().endswith(".exe") else None   # not npm's bun.CMD shim
    cands = [os.environ.get("BUN"), on_path,
             *sorted(glob.glob(os.path.join(local, "Programs", "node-v*", "node_modules", "bun", "bin", "bun.exe")), reverse=True),
             os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules", "bun", "bin", "bun.exe"),
             os.path.join(os.path.expanduser("~"), ".bun", "bin", "bun.exe")]
    return next((c for c in cands if c and os.path.isfile(c)), "bun")

MAX_TABLES = TABLES.MAX_TABLES
TOTAL = [1]              # how many tables this run declared; every slot is told
CDP_PORT = int(os.environ.get("CDP_PORT", "9333"))

panel_port = TABLES.panel_port          # 7700, 7710, 7720, 7730 — one map, in tables.py


def up(slot: int, fake: bool, timeout: float = 1.5) -> bool:
    """Is slot `slot` up — as that slot, on the rig this run is for?

    NOT "does something answer :7710". The test rig serves these same four ports,
    so a bare liveness check makes `run-tables.pyw 2 --fake` look at a live
    real-money wrapper, call slot 2 "already up", and quietly give you a fake run
    with a real table in it (and the same the other way round). The wrapper says
    which slot and which rig it is; believe that, not the port.

    It cannot use TABLES.rig(), which reads this launcher's own environment —
    `--fake` is set on the CHILD's environment, not ours."""
    want_rig = "fake" if fake else "live"
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{panel_port(slot)}{TABLES.PRESENCE_PATH}", timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception:
        return False
    return isinstance(d, dict) and d.get("slot") == slot and d.get("rig") == want_rig


def start_slot(slot: int, fake: bool) -> None:
    port = panel_port(slot)
    if up(slot, fake):
        print(f"slot {slot}: already up on :{port}")
        return
    env = dict(os.environ)
    env["TABLE_SLOT"] = str(slot)
    env["PANEL_PORT"] = str(port)
    # THE DECLARED COUNT, passed to every slot. The window layout is computed from
    # it rather than from how many slots happen to be up, so a slot that dies and
    # restarts finds its own cell again instead of the tiles reshuffling under the
    # mouse mid-hand (tables.table_rect).
    env["TABLE_COUNT"] = str(TOTAL[0])
    # EVERY SLOT SHARES ONE CDP PORT. The browser is one process (one profile), so
    # there is one debugger for all four windows; each wrapper picks its own window
    # out of the target list by its claim.
    env["CDP_PORT"] = str(CDP_PORT)
    if fake:
        env["FAKE_TABLE"] = "1"
    # the ports in ARGV too: the takeover scan tells one instance from another by its command line, and a slot
    # started without them reads as :7700 — relaunching table 1 would end it
    argv = ["--panel-port", str(port), "--cdp-port", str(CDP_PORT)] + (["--fake"] if fake else [])
    if PYTHON_IMPL or not MAIN_TS.exists():
        exe = str(VENV_PYW) if VENV_PYW.exists() else sys.executable
        cmd = [exe, str(RUN), *argv]
    else:
        env.setdefault("WRAPPER_LOG_FILE", str(ROOT / "server.log"))
        cmd = [_find_bun(), "run", str(MAIN_TS), *argv]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    subprocess.Popen(cmd, env=env, cwd=str(ROOT), creationflags=flags,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    print(f"slot {slot}: starting on :{port} (CDP :{CDP_PORT})")


def stop_slot(slot: int, fake: bool) -> None:
    # THE RIG IS PART OF THE ADDRESS HERE TOO. `--stop --fake` must not stand down
    # a live wrapper that happens to hold :7710 — that is a real table, possibly
    # mid-hand, being closed by a test-rig teardown.
    port = panel_port(slot)
    if not up(slot, fake):
        return
    try:
        urllib.request.urlopen(
            urllib.request.Request(f"http://127.0.0.1:{port}/quit", data=b"{}",
                                   headers={"Content-Type": "application/json"}),
            timeout=5)
        print(f"slot {slot}: asked :{port} to stand down")
    except Exception as e:
        print(f"slot {slot}: could not stop :{port} — {e}")


def main() -> int:
    args = sys.argv[1:]
    fake = "--fake" in args
    stop = "--stop" in args
    nums = [a for a in args if a.isdigit()]
    n = int(nums[0]) if nums else 1
    if not 1 <= n <= MAX_TABLES:
        print(f"tables must be 1-{MAX_TABLES} (Ignition's own ceiling); got {n}")
        return 2
    TOTAL[0] = n

    if stop:
        for slot in range(MAX_TABLES, 0, -1):
            stop_slot(slot, fake)
        return 0

    # SLOT 1 FIRST, AND ALONE UNTIL IT IS UP. It is the one that launches the browser
    # with the debugger bound; every later slot only joins that process and would race
    # a half-started Chrome, each opening its own and ending up with four browsers,
    # four logins and three unreachable debuggers.
    start_slot(1, fake)
    for _ in range(120):
        if up(1, fake):
            break
        time.sleep(0.5)
    else:
        print("slot 1 did not come up — not starting the rest")
        return 1
    print("slot 1 is up; the browser and its debugger belong to it")

    for slot in range(2, n + 1):
        start_slot(slot, fake)
        # stagger: wait for each slot to answer as itself before starting the next,
        # so a failure is attributed to the slot that had it rather than showing up
        # as "three tables did not come up"
        for _ in range(60):
            if up(slot, fake):
                break
            time.sleep(0.5)

    print()
    for slot in range(1, n + 1):
        port = panel_port(slot)
        print(f"  table {slot}: panel http://127.0.0.1:{port}/panel  {'up' if up(slot, fake) else 'NOT UP'}")
    print("\nEach table needs its own seat: open its panel and use the session setup as usual.")
    if n > 1:
        print("The tables tile the table monitor between them; the panels tile the other screen.")
        print("Each slot's log prints the logical size it got, and warns when that is too narrow")
        print("for the Ignition layout the state reader was built against.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
