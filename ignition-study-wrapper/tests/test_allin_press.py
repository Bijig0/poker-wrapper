"""Pressing a shove: the ordered fallback, and the rows it must not cross.

    aof-model/.venv/Scripts/python.exe tests/test_allin_press.py

Session 125204 hand 33: the pick was All-in, `act('all-in', 'action')` found
nothing on the action row, the relay refused, and Brady shoved by hand. The
client does not put a shove on the action row — across every DOM recording we
have, the ONLY all-in control ever rendered is `allInSelector`, 11,369 ticks of
it, always in the SIZING row beside potSelector/x4Selector and never once among
foldButton/callButton/raiseButton. A shove is therefore two presses: size it on
the sizing row, then confirm it on RAISE (or BET, when the client is offering a
bet rather than a raise).

_actuate_all_in encodes that, and this pins it — because the path has never run.
`All-in` has been the pick exactly once in the whole answer log and there is no
relayed all-in press anywhere on record, so nothing else would notice if the
order broke.

THE ROWS ARE THE POINT. `act(label, kind)` searches ONE row: kind="action" the
turn actions, kind="preset" the sizing row. The sizing ALL-IN must never be
reachable as an action (it sizes without committing — a press that silently does
nothing), and a real action must never be reached as a preset. These assert the
`kind` of every call, not just that a press happened.
"""
from __future__ import annotations

import sys
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


CALLS: list[tuple[str, str]] = []


def fake_act(offers):
    """`offers` maps (label, kind) -> the act() result. Anything else is 'not offered'."""
    def _act(label, kind="action"):
        CALLS.append((label, kind))
        r = offers.get((label, kind))
        return dict(r) if r else {"ok": False, "reason": f"no {label!r} on the {kind} row"}
    return _act


HIT = lambda what: {"ok": True, "clicked": what}

_real_act, _real_sleep = launch.act, launch.time.sleep
launch.time.sleep = lambda *_a, **_k: None          # the 0.25s settle between the two presses

try:
    print("the client offers a shove on the action row (it never has, but if it did)")
    CALLS.clear()
    launch.act = fake_act({("all-in", "action"): HIT("ALL-IN")})
    r = launch._actuate_all_in()
    check("pressed once, on the action row", r.get("ok") and CALLS == [("all-in", "action")], str(CALLS))
    check("  ... and the sizing row was never touched",
          not [c for c in CALLS if c[1] == "preset"], str(CALLS))

    print("the real client: size it on the sizing row, confirm on RAISE")
    CALLS.clear()
    launch.act = fake_act({("all-in", "preset"): HIT("ALL-IN"), ("raise", "action"): HIT("RAISE TO 100 BB")})
    r = launch._actuate_all_in()
    check("shove goes through", r.get("ok") is True, str(r))
    check("  ... as size-then-confirm, not a single press", r.get("kind") == "preset+confirm", str(r))
    check("  ... action row tried FIRST, then the preset, then the confirm",
          CALLS == [("all-in", "action"), ("all-in", "preset"), ("raise", "action")], str(CALLS))
    check("  ... and it says what it clicked", "ALL-IN" in str(r.get("clicked")) and "RAISE" in str(r.get("clicked")),
          str(r.get("clicked")))

    print("no RAISE on offer — the client is offering a BET")
    CALLS.clear()
    launch.act = fake_act({("all-in", "preset"): HIT("ALL-IN"), ("bet", "action"): HIT("BET 100 BB")})
    r = launch._actuate_all_in()
    check("confirms on BET instead", r.get("ok") is True and "BET" in str(r.get("clicked")), str(r))
    check("  ... only after RAISE was tried", ("raise", "action") in CALLS and
          CALLS.index(("raise", "action")) < CALLS.index(("bet", "action")), str(CALLS))

    print("no ALL-IN preset — MAX is the same control under another name")
    CALLS.clear()
    launch.act = fake_act({("max", "preset"): HIT("MAX"), ("raise", "action"): HIT("RAISE TO 100 BB")})
    r = launch._actuate_all_in()
    check("falls through to MAX", r.get("ok") is True and "MAX" in str(r.get("clicked")), str(r))
    check("  ... having tried ALL-IN first", CALLS[:2] == [("all-in", "action"), ("all-in", "preset")], str(CALLS))

    # THE DANGEROUS HALF-PRESS. Sizing without confirming leaves the amount set and
    # nothing committed — hero's clock still running, the table unchanged, and a
    # relay that believes it acted. It has to refuse, loudly, naming the control it
    # already touched so the state is recoverable by hand.
    print("sized but nothing to confirm on")
    CALLS.clear()
    launch.act = fake_act({("all-in", "preset"): HIT("ALL-IN")})
    r = launch._actuate_all_in()
    check("refuses rather than claiming success", r.get("ok") is False, str(r))
    check("  ... and names the control it already pressed", "ALL-IN" in str(r.get("reason")), str(r.get("reason")))

    print("nothing on offer at all")
    CALLS.clear()
    launch.act = fake_act({})
    r = launch._actuate_all_in()
    check("refuses", r.get("ok") is False, str(r))
    check("  ... never presses anything else instead",
          all(c in [("all-in", "action"), ("all-in", "preset"), ("max", "preset")] for c in CALLS), str(CALLS))

    print("the pick routes to the shove path at all")
    for pick in ("All-in", "ALL-IN", "all in", "jam", "shove", "RAI"):
        plan = launch._pick_plan(pick)
        check(f"  {pick!r} -> the all-in plan", plan == {"kind": "action", "label": "all-in"}, str(plan))
    CALLS.clear()
    launch.act = fake_act({("all-in", "preset"): HIT("ALL-IN"), ("raise", "action"): HIT("RAISE")})
    r = launch._actuate({"kind": "action", "label": "all-in"})
    check("_actuate sends it to _actuate_all_in, not act('all-in')",
          r.get("kind") == "preset+confirm", str(r))

    # A CALL IS NOT A SHOVE. Facing an opponent's all-in the client offers a plain
    # FOLD / CALL <n> (both instances on record), so this must stay the ordinary
    # one-press path — never the sizing row.
    print("facing an opponent's shove is an ordinary call")
    CALLS.clear()
    launch.act = fake_act({("call", "action"): HIT("CALL 69.4 BB")})
    r = launch._actuate(launch._pick_plan("Call"))
    check("one press, on the action row", r.get("ok") and CALLS == [("call", "action")], str(CALLS))
finally:
    launch.act = _real_act
    launch.time.sleep = _real_sleep

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
