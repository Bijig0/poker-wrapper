"""Golden: the CoinPoker reader (sites/cp_feed.py + sites/coinpoker.py) over the client's own logs.

    aof-model/.venv/Scripts/python.exe tests/golden/record_cp.py

Input: every CoinPoker log on this machine (%APPDATA%/CoinPoker/logs/main.log and the rotated main.N.log.gz),
line by line through exactly what Feed.poll does for a line (the hero sign-in scan, the split-line rejoin,
the quit-table fallback, Room.apply). After each line that changed anything, a snapshot: the feed lines it
produced, the touched room's ParsedHand export, Site.table() / hero_status() attached to that room, and the
finished hands the archiver would drain (with their export_finished form). The log lines are written into
the file, so the TypeScript replay needs nothing else.
"""
from __future__ import annotations

import contextlib
import gzip
import io
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
from common import FakeTime, Writer, norm  # noqa: E402

os.environ.pop("CP_HERO", None)
FT = FakeTime(1_790_000_000.0)
with contextlib.redirect_stdout(io.StringIO()):
    from sites import cp_feed as feed
    from sites import coinpoker as CPS
feed.time = FT
CPS.time = FT

LOGS = Path(os.environ.get("APPDATA", "")) / "CoinPoker" / "logs"


def log_files() -> list[tuple[str, list[str]]]:
    out = []
    for p in sorted(LOGS.glob("main.*.log.gz"), key=lambda p: -int(p.name.split(".")[1])):   # oldest first
        out.append((p.name, gzip.open(p, "rb").read().decode("utf-8", errors="replace").split("\n")))
    if (LOGS / "main.log").exists():
        out.append(("main.log", (LOGS / "main.log").read_bytes().decode("utf-8", errors="replace").split("\n")))
    return out


def keep(line: str) -> bool:
    """Lines the reader can act on (the rest are the lobby's own chatter). A continuation chunk of a split
    message carries the UNITY prefix, so it is kept."""
    return ("[UNITY]" in line or "SendMessageToPipe" in line or "Login on SFS" in line
            or "TransformToBean" in line)


def main() -> int:
    files = log_files()
    if not files:
        print("no CoinPoker logs on this machine")
        return 0
    for name, lines in files:
        lines = [ln for ln in lines if keep(ln)]
        tmp = Path(tempfile.mkdtemp(prefix="golden-cp-")) / "main.log"
        tmp.write_text("\n".join(lines), encoding="utf-8")
        feed.HERO, feed.HERO_SOURCE = "", None
        f = feed.Feed(path=tmp, from_start=True)
        site = CPS.Site()
        site.feed = f
        w = Writer(f"cp-{name.replace('.', '_')}")
        w.write({"type": "meta", "file": name, "lines": len(lines), "heroAtStart": feed.HERO})
        n_out = 0
        for i, raw in enumerate(lines):
            if f.line_at:
                FT.now = f.line_at + 0.5
            before_rooms = set(f.rooms)
            out: list[tuple[str, str]] = []
            touched = None
            # --- Feed.poll's per-line body ---
            if "Login on SFS" in raw:
                lm = feed._LOGIN.search(raw)
                if lm:
                    feed._learn_hero(lm.group(1))
            p = f._join(raw)
            if not p:
                q = feed._QUIT.search(raw)
                if q and q.group(1) in f.rooms:
                    touched = q.group(1)
                    out += [(q.group(1), s) for s in f.rooms[q.group(1)].apply("game.quit_table", {}, f.line_at)]
            else:
                cmd, d = p
                room = d["room"] or "?"
                touched = room
                r = f.rooms.setdefault(room, feed.Room(room))
                before = len(out)
                out += [(room, s) for s in r.apply(cmd, d["bean"], f.line_at)]
                if len(out) == before and cmd.startswith("game.") and cmd not in feed._QUIET:
                    f.unknown[cmd] = f.unknown.get(cmd, 0) + 1
            w.write({"type": "in", "i": i, "line": raw})
            if touched is None and set(f.rooms) == before_rooms and f._pending is None and not out:
                continue
            if f.line_at:
                FT.now = f.line_at + 0.5
            snap: dict = {"lines": out, "hero": feed.HERO, "lineAt": f.line_at, "pending": f._pending is not None,
                          "broken": f.broken, "unknown": dict(f.unknown)}
            if touched and touched in f.rooms:
                r = f.rooms[touched]
                site.pinned = touched
                snap["room"] = touched
                snap["export"] = feed.export(r)
                snap["table"] = site.table()
                snap["heroStatus"] = site.hero_status()
                snap["practice"] = site.practice()
                snap["roomState"] = {"seats": r.seats, "status": r.status, "props": r.props, "sitout": r.sitout,
                                     "closed": r.closed, "touched": r.touched,
                                     "hand": {k: v for k, v in (r.hand or {}).items() if k not in ("t0", "tEnd", "turnAt")},
                                     "last": (r.last or {}).get("id")}
                done = f.drain_finished()
                snap["finished"] = [{"room": rr.name, "id": h.get("id"),
                                     "export": site.export_finished(rr, h)} for rr, h in done]
                site.pinned = None
                snap["active"] = (f.active().name if f.active() else None)
            w.write({"type": "out", "i": i, **w.delta(norm(snap))})
            n_out += 1
        w.close()
        print(f"{name}: {len(lines)} lines, {n_out} snapshots -> {w.path.name} ({w.path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
