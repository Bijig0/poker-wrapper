"""Drive the wrapper's Ignition client over CDP — dev/probe CLI.

Targets the POKER-GAME page (never the marketing page). Coordinates are page
viewport pixels; the deep extractor in launch.py reports node coords in that
same space (same-origin iframe offsets already folded in), so its output can be
clicked directly.

  drive.py targets            list page targets
  drive.py dump [filter]      deep DOM text nodes (optionally only text ~filter)
  drive.py click X Y          one real mouse click at viewport X,Y
  drive.py shot out.png       screenshot the poker-game page
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "aof-model"))
from scout import cdp  # noqa: E402

sys.path.insert(0, str(ROOT))
from launch import _EXTRACT_DEEP_JS, CDP_PORT  # noqa: E402


cdp.PORT = CDP_PORT  # scout/cdp.py routes through its module-global port


def game_target():
    pages = cdp.page_targets(CDP_PORT)
    for pat in ("poker-game", "poker-lobby"):
        for t in pages:
            if pat in t.get("url", "").lower():
                return t
    print("no poker-game target — open the poker client in the wrapper window")
    sys.exit(1)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "dump"
    if cmd == "targets":
        for t in cdp.page_targets(CDP_PORT):
            print(f"{t.get('title', '')[:60]!r}  {t.get('url', '')[:90]}")
        return
    t = game_target()
    ws = t["webSocketDebuggerUrl"]
    if cmd == "dump":
        d = cdp._eval(ws, _EXTRACT_DEEP_JS, timeout=10) or {}
        nodes = d.get("nodes", [])
        filt = sys.argv[2].lower() if len(sys.argv) > 2 else None
        if filt:
            nodes = [n for n in nodes if filt in n["text"].lower()]
        print(f"# {t.get('url', '')}")
        print(f"# {len(d.get('nodes', []))} nodes, {d.get('canvases')} canvases, "
              f"{d.get('iframes')} iframes, viewport {d.get('vw')}x{d.get('vh')}")
        for n in nodes:
            print(f"{n['x']},{n['y']} {n['w']}x{n['h']}  {n['text']}")
    elif cmd == "click":
        x, y = int(sys.argv[2]), int(sys.argv[3])
        cdp._dispatch_click(ws, x, y)
        print(f"clicked {x},{y}")
    elif cmd == "eval":
        print(json.dumps(cdp._eval(ws, sys.argv[2], timeout=10), indent=1))
    elif cmd == "shot":
        out = sys.argv[2] if len(sys.argv) > 2 else "shot.png"
        print("ok" if cdp.screenshot(ws, out) else "failed", out)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
