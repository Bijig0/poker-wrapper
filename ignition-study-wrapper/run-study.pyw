"""Icon entry point. Imports launch and runs main() — module mode.

Guarantees a fresh start every open, on two levels:

  1. Bytecode. Python caches compiled .pyc keyed by SOURCE MTIME, and files on
     this machine get rewritten by the mac sync — a sync that restores an
     older mtime makes Python run the STALE .pyc even though the source on
     disk is new. Close-time cleanup cannot cover this (a killed process runs
     no cleanup), so the caches are purged HERE, before launch is imported,
     every single open. `dont_write_bytecode` then keeps the run from leaving
     a new cache that a later mtime shuffle could resurrect.

  2. Process. launch.main() itself replaces any still-running instance (see
     _takeover), so the newly-loaded code always becomes the live one.

Between them, opening from the icon always runs the code as it is on disk.
"""
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARK = HERE / "debug" / "last-start.txt"

# Never trust or write cached bytecode for this run.
sys.dont_write_bytecode = True

# Purge every __pycache__ under the wrapper AND its scout dependency (imported
# from a sibling tree, with its own cache). rglob covers nested packages.
_purged = 0
for base in (HERE, HERE.parent / "aof-model" / "scout"):
    if not base.exists():
        continue
    for pc in base.rglob("__pycache__"):
        try:
            shutil.rmtree(pc)
            _purged += 1
        except OSError:
            pass  # a locked cache is not worth aborting the launch over

# Rig selection, taken from argv rather than the environment on purpose: the
# takeover scan reads other processes' COMMAND LINES to tell one rig from
# another (environment is not readable across processes), so the ports have to
# be visible there. Translated into the env launch.py already reads.
#   --panel-port N   panel/server port      (default 7700)
#   --cdp-port N     table window's CDP port(default 9333)
#   --fake           table window shows the local fake table, not Ignition
_argv = sys.argv[1:]


def _opt(name: str) -> str | None:
    for i, a in enumerate(_argv):
        if a == name and i + 1 < len(_argv):
            return _argv[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


import os  # noqa: E402  (after the cache purge, before launch is imported)

if (_p := _opt("--panel-port")):
    os.environ["PANEL_PORT"] = _p
if (_c := _opt("--cdp-port")):
    os.environ["CDP_PORT"] = _c
if "--fake" in _argv:
    os.environ["FAKE_TABLE"] = "1"

try:
    MARK.parent.mkdir(exist_ok=True)
    MARK.write_text(f"start (purged {_purged} caches) argv={_argv}\n", encoding="utf-8")
    sys.path.insert(0, str(HERE))
    import launch
    with MARK.open("a", encoding="utf-8") as f:
        f.write("imported\n")
    launch.main()
    with MARK.open("a", encoding="utf-8") as f:
        f.write("main returned\n")
except BaseException as e:  # pythonw has nowhere to print — file it
    import traceback
    with MARK.open("a", encoding="utf-8") as f:
        f.write("EXC: " + repr(e) + "\n")
        traceback.print_exc(file=f)
