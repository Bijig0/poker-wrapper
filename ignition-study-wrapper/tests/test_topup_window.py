"""The auto top-up's windows and guards, offline.

No browser, no table: the reader's state is seeded directly and each window is
opened and each guard tripped in turn. The companion replay (replay_topup.py)
then asks the same rule of every recorded hand.

What is under test (2026-09-20):

  * _top_up_window names ONE of three windows — not-dealt, fold, hand-over — or
    says why there is none, and the gate consulted before every press is that
    same function, so a window that starts a run cannot be a window the next
    press disagrees with.
  * the Buy-chips panel is modal over the action strip, so an action relayed
    while it is open must fold it away first, and the feed loop must close it
    the moment hero is put on the clock.
  * the abort that those two raise is cleared again once the run is over —
    without that, the first guarded close wedges the top-up for the session.

Run:  aof-model/.venv/Scripts/python.exe tests/test_topup_window.py
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


def seed(*, seated=True, waiting=False, to_act=False, hero="in-hand", modal=None,
         folded=False, over=False, settled=True, stack="95.0 BB") -> None:
    """The table as the reader would have it this tick."""
    launch._feed_prev = {"seated": seated, "waiting": waiting, "toAct": to_act,
                         "seats": {4: {"stack": stack, "hero": True}}}
    launch._live_status.clear()
    launch._live_status.update({"hero": hero, "toAct": to_act, "modal": modal})
    launch._ws_state.update({"heroSeat": 4, "heroFolded": folded, "handOver": over})
    launch._study["stackStable"] = {"text": stack, "ticks": 9 if settled else 0}
    launch._topup_panel["open"] = False
    launch._topup_abort.clear()


def win() -> tuple:
    return launch._top_up_window()


# ------------------------------------------------------------- the windows
print("_top_up_window — the three windows")
seed(hero="not-in-hand")
check("hero not dealt into the hand", win() == (True, "not-dealt", None), str(win()))
seed(hero="sitting-out")
check("hero sitting out", win()[1] == "not-dealt", str(win()))
seed(hero="waiting-for-bb")
check("hero waiting for the big blind", win()[1] == "not-dealt", str(win()))

seed(hero="folded", folded=True, settled=False)
check("hero folded — fires without waiting for the stack to settle",
      win() == (True, "fold", None), str(win()))

seed(over=True, settled=True)
check("hand over and the stack has settled", win() == (True, "hand-over", None), str(win()))
seed(over=True, settled=False)
check("hand over but the award has not landed", win()[0] is False and "award" in (win()[2] or ""), str(win()))

# the window that used to be the only one, and the one it could never open
seed(over=False, folded=False)
check("a hand live for hero is not a window", win() == (False, None, "a hand is live for hero"), str(win()))

# -------------------------------------------------------------- the blocks
print("\n_top_up_window — the hard blocks")
seed(hero="not-in-hand", to_act=True)
check("hero on the clock beats every window", win()[2] == "hero is on the clock", str(win()))
seed(hero="folded", folded=True, modal={"text": "Buy-in maximum", "harmless": False})
check("a client notice beats every window", win()[2] == "a client notice is on screen", str(win()))
seed(seated=False)
check("not seated", win()[2] == "not seated", str(win()))
seed(waiting=True)
check("table broke", win()[2] == "waiting for the next hand", str(win()))

print("\n_top_up_gate is the same rule")
seed(hero="folded", folded=True)
check("gate open when the window is", launch._top_up_gate() == (True, None), str(launch._top_up_gate()))
seed(to_act=True)
check("gate shut when hero is on the clock",
      launch._top_up_gate() == (False, "hero is on the clock"), str(launch._top_up_gate()))

# ------------------------------------------------------- the panel guards
print("\nthe Buy-chips panel is modal — the guards")
pressed: list[str] = []
real_act = launch.act
launch.act = lambda label, kind="action": (pressed.append(f"{kind}:{label}"), {"ok": True})[1]
try:
    seed(hero="folded", folded=True)
    launch._topup_panel["open"] = True
    launch._maybe_guard_buy_panel()
    check("panel left alone while hero is not on the clock", pressed == [], str(pressed))

    seed(hero="folded", folded=True, to_act=True)
    launch._topup_panel["open"] = True
    launch._maybe_guard_buy_panel()
    check("panel closed the moment hero is on the clock", pressed == ["button:Buy chips"], str(pressed))
    check("and the run is called off", launch._topup_abort.is_set())
    check("and the flag says it is shut", launch._topup_panel["open"] is False)

    pressed.clear()
    launch._maybe_guard_buy_panel()
    check("closing twice does not re-open it (the press is a toggle)", pressed == [], str(pressed))

    pressed.clear()
    launch._topup_panel["open"] = True
    launch._close_buy_panel()
    launch._close_buy_panel()
    check("_close_buy_panel is idempotent", pressed == ["button:Buy chips"], str(pressed))
finally:
    launch.act = real_act

print("\nthe relay never presses through our own panel")
seen: list[str] = []
real_target = launch.ignition_target
launch.ignition_target = lambda: seen.append("looked for the table") or None
try:
    seed(hero="folded", folded=True)
    launch._topup_panel["open"] = True
    launch.act("fold", "action")
    check("an action folds the panel away first", launch._topup_panel["open"] is False)
    check("and calls the top-up off", launch._topup_abort.is_set())
finally:
    launch.ignition_target = real_target

# ------------------------------------------------------------- the abort
print("\nthe abort is cleared once the run is over")
launch._study.update({"topUp": True, "topUpHand": None, "topUpAt": 0.0, "topUpDue": None,
                      "lastTopUp": None, "topUpTrigger": None})
launch._session["id"] = "test-session"
launch._fake_mode = False
seed(hero="folded", folded=True)
launch._topup_abort.set()
launch._maybe_top_up()
check("a stale abort does not wedge the next window", not launch._topup_abort.is_set())
check("and nothing was scheduled on that tick", launch._study.get("topUpDue") is not None,
      "the wait should be drawn, not skipped")

# the small wait, and that it is dropped when the window shuts
launch._study["topUpDue"] = time.time() + 30
seed()          # a hand is live for hero again
launch._maybe_top_up()
check("the wait is dropped when the window shuts", launch._study.get("topUpDue") is None)

# ---------------------------------------------------- the once-per-hand key
print("\nthe once-per-hand guard is keyed on the CLIENT's hand id")
launch._hand_no = 7
launch._hand_ids[7] = "4919080696"
check("client id when there is one", launch._hand_key() == "4919080696", launch._hand_key())
launch._hand_ids.pop(7, None)
check("the reader's own counter only as a fallback", launch._hand_key() == "local-7", launch._hand_key())

# --------------------------------------------------- one press per hand
print("\nthe scheduler over a run of ticks")
runs: list[str] = []
real_thread = launch.threading.Thread


class FakeThread:
    """Run the top-up body inline so the sequence is deterministic."""

    def __init__(self, target=None, daemon=None, name=None, args=()):
        self.target, self.name, self.args = target, name, args

    def start(self):
        if self.name == "top-up":
            runs.append(launch._study.get("topUpTrigger"))
            launch._topup_lock.release()


launch.threading.Thread = FakeThread
launch.TOP_UP_JITTER_S = (0.0, 0.0)
try:
    launch._study.update({"topUp": True, "topUpHand": None, "topUpAt": 0.0, "topUpDue": None,
                          "lastTopUp": None, "topUpTrigger": None})
    launch._session["id"] = "test-session"
    launch._hand_no, launch._hand_ids[101] = 101, "hand-101"

    seed()                                   # hero in a live hand
    for _ in range(20):
        launch._maybe_top_up()
    check("nothing while the hand is live", runs == [], str(runs))

    seed(hero="folded", folded=True)
    for _ in range(20):
        launch._maybe_top_up()
    check("exactly one run on the fold", runs == ["fold"], str(runs))

    # the next hand, and the cooldown that separates them
    launch._hand_no, launch._hand_ids[102] = 102, "hand-102"
    launch._study["topUpAt"] = 0.0           # a cooldown that has run out
    seed(hero="not-in-hand")
    for _ in range(20):
        launch._maybe_top_up()
    check("the next hand gets its own run, from the not-dealt window",
          runs == ["fold", "not-dealt"], str(runs))

    # the same hand again must not
    launch._study["topUpAt"] = 0.0
    for _ in range(20):
        launch._maybe_top_up()
    check("but only once for that hand", runs == ["fold", "not-dealt"], str(runs))

    # a press whose chips have not landed blocks the next one
    launch._hand_no, launch._hand_ids[103] = 103, "hand-103"
    launch._study.update({"topUpAt": 0.0,
                          "lastTopUp": {"at": int(time.time() * 1000), "pressed": True, "receiptCents": None}})
    seed(hero="folded", folded=True)
    for _ in range(20):
        launch._maybe_top_up()
    check("chips still in flight block the next press", runs == ["fold", "not-dealt"], str(runs))
finally:
    launch.threading.Thread = real_thread

print("")
if FAILS:
    print(f"{len(FAILS)} FAILED: " + ", ".join(FAILS))
    raise SystemExit(1)
print("all top-up window checks passed")
