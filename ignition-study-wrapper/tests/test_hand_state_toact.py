"""/hand export: hero-to-act must follow the client's action buttons when the
WebSocket missed the villain action that put hero on the clock.

Regression for hand 4917810973 (session_20260912_140454, 2026-09-12): the BB's
river bet arrived only through the DOM backfill, the WS still had action on
the BB, and hero sat 14 s with FOLD / CALL / RAISE on screen while the export
said "not hero's turn" - the poller never asked, the panel showed no answer.

Run:  aof-model/.venv/Scripts/python.exe tests/test_hand_state_toact.py
"""
from __future__ import annotations

import io
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import launch  # noqa: E402


def river_state(*, dom_to_act: bool, ws_action_on: int, grace_ahead: float = -1.0,
                hero_folded: bool = False, voluntary: bool = True) -> None:
    """The recorded state at frame 756: BTN hero (seat 2) vs BB (seat 1), river
    6c Ah Jd 9s Ts, BB just bet 2.6bb (DOM backfill), $1/$2."""
    launch._hand_no = 11
    launch._hand_ids[11] = "4917810973"
    acts = [
        {"seat": 3, "type": "post-sb", "cents": 100, "street": "preflop"},
        {"seat": 1, "type": "post-bb", "cents": 200, "street": "preflop"},
    ]
    if voluntary:
        acts += [
            {"seat": 2, "type": "raise", "cents": 500, "street": "preflop"},
            {"seat": 3, "type": "fold", "street": "preflop"},
            {"seat": 1, "type": "call", "cents": 300, "street": "preflop"},
            {"seat": 1, "type": "check", "street": "flop"},
            {"seat": 2, "type": "bet", "cents": 280, "street": "flop"},
            {"seat": 1, "type": "call", "cents": 280, "street": "flop"},
            {"seat": 1, "type": "check", "street": "turn"},
            {"seat": 2, "type": "check", "street": "turn"},
            {"seat": 1, "type": "bet", "cents": 520, "street": "river"},
        ]
    launch._ws_state.update({
        "dealt": [1, 2, 3], "heroSeat": 2, "dealer": 2,
        "actions": acts,
        "committed": {1: 520} if voluntary else {},
        "bb": 200, "bbSeen": True,
        "board": ["6♣", "A♥", "J♦", "9♠", "10♠"],
        "actionOn": ws_action_on, "maxBet": 520 if voluntary else 200,
        "potCents": 2100, "heroFolded": hero_folded,
        "domGraceUntil": time.time() + grace_ahead,
        "heroCards": ["J♥", "8♦"],
    })
    launch._live_status["board"] = ["6♣", "A♥", "J♦", "9♠", "10♠"]
    launch._live_status["toAct"] = dom_to_act
    launch._feed_prev.update({
        "seated": True,
        "seats": {1: {"stack": "96.9 BB"}, 2: {"stack": "89.6 BB"}, 3: {"stack": "210.6 BB"}},
    })


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' - ' + detail) if detail and not ok else ''}")
    return ok


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    results = []
    # 1. the bug: WS says BB to act, the screen shows hero's buttons -> hero to act
    river_state(dom_to_act=True, ws_action_on=1)
    h = launch._hand_state()
    results.append(check("DOM buttons override a stale WS action-on",
                         bool(h) and h["currentNode"]["toActIsHero"] is True and h["street"] == "river",
                         f"got {h and (h['currentNode'], h['street'])}"))
    # 2. no buttons on screen -> the WS reading stands
    river_state(dom_to_act=False, ws_action_on=1)
    h = launch._hand_state()
    results.append(check("no buttons -> WS action-on kept",
                         bool(h) and h["currentNode"]["toActIsHero"] is False))
    # 3. inside the deal grace the buttons are the previous hand's - ignored
    river_state(dom_to_act=True, ws_action_on=1, grace_ahead=5.0)
    h = launch._hand_state()
    results.append(check("deal grace blocks the override",
                         bool(h) and h["currentNode"]["toActIsHero"] is False))
    # 4. hero already folded -> never "to act"
    river_state(dom_to_act=True, ws_action_on=1, hero_folded=True)
    h = launch._hand_state()
    results.append(check("a folded hero is never put on the clock",
                         bool(h) and h["currentNode"]["toActIsHero"] is False))
    # 5. only blinds posted (buttons flashing through the deal) -> ignored
    river_state(dom_to_act=True, ws_action_on=1, voluntary=False)
    h = launch._hand_state()
    results.append(check("no voluntary action yet -> WS action-on kept",
                         bool(h) and h["currentNode"]["toActIsHero"] is False))
    # 6. WS already agrees -> unchanged
    river_state(dom_to_act=True, ws_action_on=2)
    h = launch._hand_state()
    results.append(check("WS already on hero -> still hero",
                         bool(h) and h["currentNode"]["toActIsHero"] is True))
    print(f"{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
