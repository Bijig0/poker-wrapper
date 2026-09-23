"""Buying chips before the fold, while we still hold the clock.

    aof-model/.venv/Scripts/python.exe tests/test_prefold_topup.py

WHY THIS EXISTS. Every top-up window used to be AFTER hero's action, so it raced
the next deal and sometimes lost by a second (session 193322: pressed 19:48:23,
next hand dealt 19:48:24). When the answer is FOLD we choose when the fold lands,
so the chips can go in first and the deadline becomes hero's act clock — which
the client's own time bank can extend.

That means deliberately putting a modal over the action strip during hero's turn.
Everything that makes it safe to do that is tested here, and the one that matters
most is the last: THE HAND IS NEVER LOST TO A TOP-UP. If the run hangs, the panel
comes off the strip and the fold goes.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import launch  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


def reset(**prefold):
    launch._topup_prefold.update({"active": False, "key": None, "hand": None,
                                  "deadline": 0.0, "startedAt": 0.0, "banked": False})
    launch._topup_prefold.update(prefold)
    launch._topup_abort.clear()
    launch._topup_panel.update({"lastCloseAt": 0.0, "domTicks": 0})   # a fresh close episode (the guard debounces re-closes, 2026-09-23)
    launch._feed_prev.clear()
    launch._feed_prev.update({"seated": True, "waiting": False, "toAct": False})
    launch._live_status.clear()
    launch._live_status.update({"hero": "in-hand", "toAct": False})
    launch._ws_state.update({"heroFolded": False, "handOver": False})
    launch._study["stackStable"] = {"ticks": 9}


# ---- which picks qualify ------------------------------------------------------
# Only a fold. Check and call leave hero able to WIN the pot, and a hero who wins
# after buying is over the max — the client then refuses with a modal over the
# action strip (session 100647 hands 4/5, 12 s, swallowed the next turn).
print("only a FOLD qualifies")
for label, want in (("FOLD", True), ("fold", True), ("FOLD 100%", True),
                    ("CHECK", False), ("CALL 2 BB", False), ("RAISE TO 10 BB", False),
                    ("ALL-IN", False), ("", False)):
    got = launch._prefold_pick_is_fold({"plan": {"label": label, "kind": "action"}, "pick": label})
    check(f"{label!r:<16} → {'fold' if want else 'not a fold'}", got is want, f"got {got}")
check("a sizing preset is never a fold",
      launch._prefold_pick_is_fold({"plan": {"label": "FOLD", "kind": "preset"}}) is False)

# ---- the window ---------------------------------------------------------------
print("\nthe window it opens")
reset()
launch._live_status["toAct"] = True
ok, trig, why = launch._top_up_window()
check("hero on the clock, no pre-fold run → still refused", ok is False and why == "hero is on the clock", str(why))

reset(active=True, deadline=time.time() + 5)
launch._live_status["toAct"] = True
ok, trig, why = launch._top_up_window()
check("with a live pre-fold run → the window is open", ok is True and trig == "pre-fold", f"{ok} {trig} {why}")

reset(active=True, deadline=time.time() - 0.1)
launch._live_status["toAct"] = True
ok, trig, why = launch._top_up_window()
check("past its deadline → shut again", ok is False and "budget" in (why or ""), str(why))

# the two hard blocks have NO exception, pre-fold or not
reset(active=True, deadline=time.time() + 5)
launch._live_status.update({"toAct": True, "modal": {"kind": "something"}})
ok, _t, why = launch._top_up_window()
check("a client notice still blocks it", ok is False and "notice" in (why or ""), str(why))

reset(active=True, deadline=time.time() + 5)
launch._live_status["toAct"] = True
launch._topup_abort.set()
ok, _t, why = launch._top_up_window()
check("an aborted run still blocks it", ok is False, str(why))
launch._topup_abort.clear()

reset(active=True, deadline=time.time() + 5)
launch._feed_prev["seated"] = False
ok, _t, why = launch._top_up_window()
check("not seated still blocks it", ok is False and why == "not seated", str(why))

# ---- THE ONE THAT MATTERS: the hand is never lost to a top-up -----------------
print("\nthe panel never outstays the budget")
closed = {"n": 0}
real_close, real_feed = launch._close_buy_panel, launch._feed_add
launch._close_buy_panel = lambda: closed.__setitem__("n", closed["n"] + 1)
launch._feed_add = lambda *a, **k: None
try:
    # inside the budget: the guard leaves our panel alone, or the run dies here
    reset(active=True, deadline=time.time() + 5)
    launch._live_status.update({"toAct": True, "buyPanel": True})
    launch._topup_panel["open"] = True
    launch._maybe_guard_buy_panel()
    check("inside the budget the guard leaves it up", closed["n"] == 0 and not launch._topup_abort.is_set(),
          f"closed {closed['n']}x abort={launch._topup_abort.is_set()}")
    check("  ... and the run is still live", launch._topup_prefold["active"] is True)

    # past it: closed, aborted, and the flag cleared so the fold can go
    closed["n"] = 0
    reset(active=True, deadline=time.time() - 0.01)
    launch._live_status.update({"toAct": True, "buyPanel": True})
    launch._topup_panel["open"] = True
    launch._maybe_guard_buy_panel()
    check("past the budget the panel is CLOSED", closed["n"] >= 1, f"closed {closed['n']}x")
    check("  ... the run is called off", launch._topup_abort.is_set() is True)
    check("  ... and the flag is cleared so the fold is no longer held",
          launch._topup_prefold["active"] is False)

    # a panel up on hero's clock with NO pre-fold run is closed as it always was
    closed["n"] = 0
    reset()
    launch._live_status.update({"toAct": True, "buyPanel": True})
    launch._topup_panel["open"] = True
    launch._maybe_guard_buy_panel()
    check("someone else's panel on hero's clock is still closed at once", closed["n"] >= 1)
finally:
    launch._close_buy_panel, launch._feed_add = real_close, real_feed
    launch._topup_abort.clear()
    launch._topup_panel["open"] = False

# ---- the trigger refuses everything it should --------------------------------
print("\nthe trigger will not take hero's clock unless every precondition holds")
launch._feed_add = lambda *a, **k: None
try:
    def started() -> bool:
        return launch._topup_prefold["active"]

    base = dict(topUp=True, on=True, auto=True)
    reset()
    launch._study.update(base)
    launch._fake_mode = True
    launch._maybe_prefold_top_up()
    check("fake rig → never", not started())
    launch._fake_mode = False

    reset(); launch._study.update({**base, "auto": False})
    launch._maybe_prefold_top_up()
    check("auto NOT armed → never (the human is reaching for that strip)", not started())

    reset(); launch._study.update(base)
    launch._live_status["toAct"] = False
    launch._maybe_prefold_top_up()
    check("hero not on the clock → never (the ordinary windows own that)", not started())

    reset(); launch._study.update({**base, "topUp": False})
    launch._live_status["toAct"] = True
    launch._maybe_prefold_top_up()
    check("top-up switched off → never", not started())

    reset(active=True, deadline=time.time() + 5)
    launch._study.update(base)
    launch._live_status["toAct"] = True
    launch._maybe_prefold_top_up()
    check("a run already in flight → not started twice", launch._topup_prefold["key"] is None)
finally:
    launch._feed_add = real_feed
    reset()

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
