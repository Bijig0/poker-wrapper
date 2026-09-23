"""Positions when a hand is dealt with NO small blind (the SB seat emptied
between hands): the seat after the button posts the big blind alone, and the
position map must say so - BB first, then the middle seats, the button last.

Regression for hand 4919958486 (session_20260923_020036, dbId 732): five
dealt (2..6), dealer seat 6, seat 2 posted the big blind, no SB post. The map
read {2: SB, 3: BB, 4: HJ, 5: CO, 6: BTN}, the API refused ("SB posted the big
blind"), and hero (HJ, T9o) got no answer. Hands 372 and 566 have the same
signature.

Run:  aof-model/.venv/Scripts/python.exe tests/test_positions_dead_sb.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import launch  # noqa: E402


def state(dealt, dealer, hero, posts):
    launch._ws_state.clear()
    launch._ws_state.update({"bb": 200, "bbSeen": True, "board": [], "pot": None,
                             "dealt": list(dealt), "dealer": dealer, "heroSeat": hero,
                             "actions": [{"seat": s, "type": t, "cents": c, "street": "preflop"}
                                         for (s, t, c) in posts]})


def check(label, got, want):
    ok = got == want
    print(("PASS" if ok else "FAIL"), label, "->", got, "" if ok else f"(wanted {want})")
    return ok


def main() -> int:
    ok = True
    # hand 732: dealer 6, seat 1 empty (the dead SB), seat 2 posted the BB
    state([2, 3, 4, 5, 6], 6, 4, [(2, "post-bb", 200)])
    ok &= check("732 map", launch._positions_all(), {2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN"})
    # the panel keeps its own early-seat vocabulary (UTG, UTG+1, … as before): third seat after the BB here
    ok &= check("732 hero", launch._hero_position(), "UTG+1")
    # hand 372 / 566: dealer 1, seat 2 empty, seat 3 posted the BB, hero on the button
    state([1, 3, 4, 5, 6], 1, 1, [(3, "post-bb", 200)])
    ok &= check("372 map", launch._positions_all(), {3: "BB", 4: "UTG", 5: "HJ", 6: "CO", 1: "BTN"})
    ok &= check("372 hero", launch._hero_position(), "BTN")
    # four dealt with a dead SB
    state([1, 3, 4, 5], 1, 5, [(3, "post-bb", 200)])
    ok &= check("4-seat map", launch._positions_all(), {3: "BB", 4: "HJ", 5: "CO", 1: "BTN"})
    ok &= check("4-seat hero", launch._hero_position(), "CO")
    # three dealt with a dead SB
    state([1, 3, 4], 1, 4, [(3, "post-bb", 200)])
    ok &= check("3-seat map", launch._positions_all(), {3: "BB", 4: "CO", 1: "BTN"})
    # both blinds posted: unchanged
    state([1, 2, 3, 4, 5, 6], 6, 4, [(1, "post-sb", 100), (2, "post-bb", 200)])
    ok &= check("normal map", launch._positions_all(), {1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN"})
    ok &= check("normal hero", launch._hero_position(), "UTG+1")
    # a BB post from a seat that is NOT first after the button (a new player posting in): geometry kept
    state([1, 2, 4], 4, 4, [(4, "post-bb", 200)])
    ok &= check("718 map (new-player post, not a dead SB)", launch._positions_all(), {1: "SB", 2: "BB", 4: "BTN"})
    # SB post missed by the tap but the seat after the button did not post the BB: geometry kept
    state([1, 2, 3, 4, 5, 6], 6, 4, [(2, "post-bb", 200)])
    ok &= check("missed SB frame", launch._positions_all(), {1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN"})
    # before any post arrives: geometry (the old behaviour)
    state([2, 3, 4, 5, 6], 6, 4, [])
    ok &= check("no posts yet", launch._positions_all(), {2: "SB", 3: "BB", 4: "HJ", 5: "CO", 6: "BTN"})
    print("ALL PASS" if ok else "FAILURES")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
