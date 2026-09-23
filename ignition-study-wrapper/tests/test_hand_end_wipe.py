"""The hand-end wipe is not a fold — and it IS hero's fold when the hand ended
on hero's turn.

Replays the recorded DOM frames of hand 4917810302 (session_20260912_140454,
7h6h BTN, 2026-09-12) through the real reader (_feed_tick with the CDP read
stubbed to the recording). Before the fix the wipe frame filed "Seat 3 folds"
for the all-in villain and nothing for hero, so the hand archived as "won
uncontested" (+102.8bb) when hero had folded to a 101bb jam.

Run:  aof-model/.venv/Scripts/python.exe tests/test_hand_end_wipe.py
"""
from __future__ import annotations

import io
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import launch  # noqa: E402

REC = ROOT / "debug" / "session_20260912_140454"
FIRST, LAST = 216, 233          # a few ticks before hero's fold → the next table


def frames(lo: int, hi: int) -> list[dict]:
    out = []
    with open(REC / "dom.jsonl", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line.strip():
                continue
            d = json.loads(line)
            if lo <= d.get("seq", -1) <= hi:
                out.append(d)
    return out


def logged(seq: int) -> dict:
    with open(REC / "log.jsonl", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.strip():
                r = json.loads(line)
                if r.get("seq") == seq:
                    return r
    raise KeyError(seq)


def seed(prompt_pot_bump: float | None = None) -> None:
    """The reader's state as the WS tap had it at the jam: everything but
    hero's last action is on record."""
    launch._fake_mode = False
    launch._dbg["on"] = False
    launch._hand_no = 6
    launch._hand_ids[6] = "4917810302"
    launch._feed.clear()
    launch._seat_mem.clear()
    launch._wins_seen.clear()
    acts = [
        {"seat": 3, "type": "post-sb", "cents": 100, "street": "preflop"},
        {"seat": 1, "type": "post-bb", "cents": 200, "street": "preflop"},
        {"seat": 2, "type": "raise", "cents": 560, "street": "preflop"},
        {"seat": 3, "type": "raise", "cents": 2400, "street": "preflop"},
        {"seat": 1, "type": "fold", "street": "preflop"},
        {"seat": 2, "type": "raise", "cents": 5200, "street": "preflop"},
        {"seat": 3, "type": "raise", "cents": 20360, "street": "preflop"},
    ]
    launch._ws_state.clear()
    launch._ws_state.update({
        "bb": 200, "bbSeen": True, "board": [], "pot": "128.8 BB", "potCents": 25760,
        "dealt": [1, 2, 3], "heroSeat": 2, "dealer": 2,
        "actions": acts, "committed": {1: 200, 2: 5200, 3: 20360}, "maxBet": 20360,
        "actionOn": 2, "heroFolded": False, "handOver": False, "endedSince": None,
        "actSeen": {("fold", 1)}, "foldedSeats": {1},
        "heroCards": ["7♥", "6♥"], "domGraceUntil": 0,
        "heroToActAt": 0.0, "heroLastActAt": 0.0,
    })
    # the previous DOM tick, as the reader had parsed it
    prev = logged(FIRST - 1)
    launch._feed_prev = {"seated": True, "seats": prev["seats"], "board": len(prev["board"]),
                         "pot": prev["pot"], "heroHand": None, "toAct": prev["toAct"],
                         "heroCards": " ".join(prev["heroCards"])}
    launch._live_status.update({"hero": "in-hand", "board": [], "toAct": prev["toAct"]})


def replay(fs: list[dict], bump_from: int | None = None, bump_to: str | None = None) -> None:
    it = iter(fs)
    cur = {"d": None}

    def fake_eval(ws, js, timeout=6):
        d = cur["d"]
        return d if d is not None else {}

    launch.ignition_target = lambda: {"webSocketDebuggerUrl": "ws://recorded"}
    launch.cdp._eval = fake_eval
    for d in it:
        if bump_from is not None and d["seq"] >= bump_from and bump_to is not None:
            # pretend the pot grew after the prompt (a hero raise the WS missed)
            nodes = d.get("nodes") or []
            for i, n in enumerate(nodes):
                if n["text"].lower().startswith("total pot"):
                    right = [m for m in nodes if abs(m["y"] - n["y"]) < 10 and m["x"] > n["x"]]
                    if right:
                        min(right, key=lambda m: m["x"])["text"] = bump_to
                    break
        cur["d"] = d
        launch._feed_tick()
        time.sleep(0.01)


def acts() -> list[tuple[int, str]]:
    return [(a["seat"], a["type"]) for a in launch._ws_state.get("actions", [])]


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' - ' + detail) if detail and not ok else ''}")
    return ok


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if not (REC / "dom.jsonl").exists():
        print("SKIP: recording not present")
        return 0
    fs = frames(FIRST, LAST)
    results = []

    seed()
    replay(fs)
    a = acts()
    results.append(check("the wipe files no villain fold", (3, "fold") not in a, f"actions {a}"))
    results.append(check("hero's fold is inferred (hand ended on hero's turn)", (2, "fold") in a, f"actions {a}"))
    results.append(check("heroFolded is set", launch._ws_state.get("heroFolded") is True))
    results.append(check("the export says the hand ended by hero's fold",
                         (launch._hand_state() or {}).get("heroFolded") is True
                         and (launch._hand_state() or {}).get("heroWon") is False))

    # a hero raise the WS missed: same frames, but the pot grows after the prompt
    seed()
    replay(fs, bump_from=226, bump_to="176.8 BB")
    a = acts()
    results.append(check("pot grew after the prompt -> no fold inferred", (2, "fold") not in a, f"actions {a}"))
    results.append(check("...and still no villain fold from the wipe", (3, "fold") not in a, f"actions {a}"))

    print(f"{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
