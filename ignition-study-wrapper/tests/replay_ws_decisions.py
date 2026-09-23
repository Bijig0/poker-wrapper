"""What the poller ACTUALLY HAD at each hero decision, replayed from the raw frames.

    aof-model/.venv/Scripts/python.exe tests/replay_ws_decisions.py [dump.jsonl ...] [--out FILE]

The archive (hands.db) is the COMPLETE capture: by the time a hand is archived every frame has landed
and the reconciler has had its say. A live no-answer caused by the export lacking an action at that
instant does not reproduce from the archive and looks "fixed" (memory: session-backtest-2026-09-21).
This replays `debug/ws_dump*.jsonl` through the real parser (no client, no DOM, no network) and
snapshots `_hand_state()` at the moment the client asks HERO to act (CO_SELECT_REQ -> heroTurn),
i.e. the export the poller would have read on that tick, WS-only. Each snapshot is written as one
JSON line so the hardening verdict table can compare it to the archived hand truncated at the same
decision (tests/backtest/verdicts.py): identical / missing actions / divergent.

WS-only is a LOWER BOUND on what the live export had — the DOM backfill and the reconciler are not in
this replay — so "missing actions" here means "the WS tap alone had not seen them", not "the panel
showed a wrong line". The verdict table says which.

Writes are sandboxed exactly as tests/replay_ws_dump.py does (the parser archives finished hands).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import launch  # noqa: E402
from replay_ws_dump import sandbox  # noqa: E402


def replay_decisions(path: Path, out) -> dict:
    stats = {"dump": str(path), "frames": 0, "applied": 0, "decisions": 0, "errors": 0, "hands": 0}
    prev_turn = None
    prev_hand = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        stats["frames"] += 1
        data, pid = e.get("data"), e.get("pid")
        if not isinstance(data, dict) or not pid or str(pid).startswith("<"):
            continue
        try:
            launch._on_game_msg(data)
            stats["applied"] += 1
        except Exception as exc:
            stats["errors"] += 1
            out.write(json.dumps({"error": f"{pid}: {exc!r}", "frame": stats["frames"]}) + "\n")
            continue
        hand_no = launch._hand_no
        if hand_no != prev_hand:
            prev_hand = hand_no
            prev_turn = None
            stats["hands"] += 1
        turn = launch._ws_state.get("heroTurn")
        # the RISING EDGE of the client's request is the tick the poller first sees hero's turn
        if turn and not prev_turn:
            try:
                h = launch._hand_state()
            except Exception as exc:
                stats["errors"] += 1
                out.write(json.dumps({"error": f"_hand_state after {pid}: {exc!r}", "frame": stats["frames"]}) + "\n")
                prev_turn = turn
                continue
            rec = {
                "dump": path.name, "frame": stats["frames"], "t": e.get("t"), "ts": e.get("ts"), "rid": e.get("rid"),
                "wrapperHand": hand_no, "clientHandId": launch._hand_ids.get(hand_no),
                "exported": bool(h),
            }
            if h:
                rec.update({
                    "street": h.get("street"), "board": h.get("board"), "heroCards": h.get("heroCards"),
                    "heroSeatId": h.get("heroSeatId"), "positions": h.get("positions"),
                    "nActions": len(h.get("actions") or []),
                    "actions": [{"seatId": a.get("seatId"), "type": a.get("type"), "street": a.get("street"),
                                 **({"amount": a["amount"]} if "amount" in a else {})} for a in (h.get("actions") or [])],
                    "toCall": (h.get("currentNode") or {}).get("toCall"), "pot": (h.get("currentNode") or {}).get("pot"),
                    "toActIsHero": (h.get("currentNode") or {}).get("toActIsHero"),
                    "lineSource": h.get("lineSource"), "lineUncertain": h.get("lineUncertain"),
                    "bbCents": h.get("bbCents"),
                })
            else:
                rec["why"] = ("no dealer/positions yet" if not launch._positions_all() else
                              "no dealt seats" if not launch._ws_state.get("dealt") else "hero seat unknown")
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            stats["decisions"] += 1
        prev_turn = turn
    return stats


def main() -> int:
    args = [a for a in sys.argv[1:]]
    out_path = None
    if "--out" in args:
        i = args.index("--out")
        out_path = Path(args[i + 1])
        del args[i:i + 2]
    dumps = [Path(a) for a in args] or sorted((ROOT / "debug").glob("ws_dump*.jsonl"))
    out_path = out_path or (ROOT / "tests" / "backtest" / "ws_decisions.jsonl")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sandbox()
    with open(out_path, "w", encoding="utf-8") as out:
        for d in dumps:
            # a fresh parser per dump: the two dumps are two tables, not one stream
            launch._hand_no = 0
            launch._hand_ids.clear()
            launch._ws_state.clear()
            launch._ws_state.update({"bb": 0, "board": [], "pot": None})
            st = replay_decisions(d, out)
            print(f"{d.name}: frames {st['frames']} applied {st['applied']} hands {st['hands']} "
                  f"hero-turn snapshots {st['decisions']} errors {st['errors']}")
    print(f"-> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
