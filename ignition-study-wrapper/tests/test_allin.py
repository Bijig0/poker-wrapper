"""An all-in is its own action, and an all-in seat is finished acting.

    aof-model/.venv/Scripts/python.exe tests/test_allin.py

Hand 4919482454 (dashboard 657). Seat 5 had 69.4 behind and bet exactly 69.4.
The client drew all three facts at once —

    seat5  bet='69.4 BB'  stack='0 BB'  badge='ALL-IN'

— and the reader recorded a plain `bet`. Downstream, the whole chain already
speaks all-in:

    action "all-in"  ->  token "RAI"    ->  label AllIn(stack)  ->  the tree's ALLIN
    action "bet"     ->  token "R69.4"  ->  label Bet(6940)     ->  nothing

so the turn came back `"Bet(6940)" not walkable at TURN#0 (offered: CHECK, ALLIN)`
three times and the spot went unanswered. The WS line had it right; the cut-over
preferred the derived one.

It does not stop at the missed answer. A seat believed to be a bettor can still
act, so the same hand's river collected three impossible actions: seat 5 checked
and then folded on a stack of zero, and the 204bb POT sliding to the winner read
as a 204bb bet from a hero holding 7.3.

THE STACK DECIDES, AND IT HAS TO HOLD. Not the badge — badges lag, clear early and
flicker, which is why folds are not judged by them either. And not one frame of it:
chips animate. A zero that holds HOLD_TICKS is the fact; a zero for one tick is a
number on its way somewhere. Because the wager is filed on the tick the chips land,
the confirmation arrives a tick late and RELABELS what was already written
(_confirm_jam) — without that, every real jam was rejected along with the flickers
(session 193322 hand 36, session 131406 hand 60 both hold the zero only 4-5 ticks).
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

from reconcile import HandReconciler, Tick  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


def seats(spec: dict) -> dict:
    """spec: seat -> (stack, bet, cards, badge)"""
    return {n: {"stack": None if s is None else f"{s} BB",
                "bet": None if b is None else f"{b} BB",
                "cards": c, "hero": n == 6, "badge": g}
            for n, (s, b, c, g) in spec.items()}


def run(frames, hero=6):
    """frames: (board, pot, {seat: (stack, bet, cards, badge)}) repeated."""
    rc = HandReconciler(1)
    seq = 0
    for board, pot, spec in frames:
        seq += 1
        rc.observe(Tick(seq=seq, t="", seats=seats(spec), pot=pot, board=board, buttons=[], hero=hero))
    rc.finish(seq)
    return rc


# Hand 657's turn geometry, at its real numbers: seat 5 jams 69.4 of 69.4, hero
# calls holding 76.6 and is left with 7.3. The hand is ABBREVIATED to the blinds
# and this street, so the pots are the ones that abbreviation implies (1.5 + the
# chips on the street) rather than the 134.6 the full hand had — the reader checks
# pot against its own ledger every tick, and a fixture that skips the preflop and
# flop betting while keeping their pot is asserting a disagreement it created.
PRE = [(0, 1.5, {5: (100, "0.5", 2, None), 6: (100, "1", 2, None)})]
POT_JAM = 70.9          # 1.5 + 69.4
POT_CALLED = 140.3      # + hero's 69.4


def turn_frames(n_zero: int):
    f = list(PRE)
    f += [(4, 1.5, {5: (69.4, None, 2, None), 6: (76.6, None, 2, None)})]
    for i in range(n_zero):
        f += [(4, POT_JAM, {5: (0, "69.4", 2, "ALL-IN" if i else None), 6: (76.6, None, 2, None)})]
    return f


print("the jam itself")
rc = run(turn_frames(3))
jam = [a for a in rc.line() if a["seat"] == 5 and a["type"] == "all-in"]
check("seat 5's 69.4 of 69.4 is an all-in, not a bet", len(jam) == 1,
      str([(a["type"], a.get("amount")) for a in rc.line() if a["seat"] == 5]))
check("  ... at the amount played", bool(jam) and abs((jam[0].get("amount") or 0) - 69.4) < 0.01)
check("  ... and the seat is recorded as all-in", 5 in rc.allin, str(sorted(rc.allin)))
check("  ... with no invariant violated", not rc.violations, str(rc.violations))

print("one frame is not a jam — chips animate")
rc = run(turn_frames(1))
check("a single tick of zero does not type an all-in",
      not [a for a in rc.line() if a["type"] == "all-in"],
      str([(a["seat"], a["type"]) for a in rc.line()]))

print("an unreadable stack is not a zero")
f = list(PRE) + [(4, 1.5, {5: (69.4, None, 2, None), 6: (76.6, None, 2, None)})]
f += [(4, POT_JAM, {5: (None, "69.4", 2, None), 6: (76.6, None, 2, None)})] * 4
rc = run(f)
check("a dropped stack read never invents an all-in",
      not [a for a in rc.line() if a["type"] == "all-in"],
      str([(a["seat"], a["type"]) for a in rc.line()]))

print("the badge alone is not enough either")
f = list(PRE) + [(4, 1.5, {5: (69.4, None, 2, None), 6: (76.6, None, 2, None)})]
f += [(4, POT_JAM, {5: (30.0, "69.4", 2, "ALL-IN"), 6: (76.6, None, 2, None)})] * 4
rc = run(f)
check("an ALL-IN badge over a live stack is not believed",
      not [a for a in rc.line() if a["type"] == "all-in"],
      str([(a["seat"], a["type"]) for a in rc.line()]))

print("an all-in seat is finished")
f = turn_frames(3)
f += [(4, POT_CALLED, {5: (0, "69.4", 2, None), 6: (7.3, "69.4", 2, None)})] * 2  # hero calls
f += [(5, POT_CALLED, {5: (0, None, 2, None), 6: (7.3, None, 2, None)})] * 3     # river runs out
f += [(5, POT_CALLED, {5: (0, None, 0, None), 6: (7.3, None, 2, None)})] * 3     # its cards clear
rc = run(f)
after = [a for a in rc.line() if a["seat"] == 5 and a["street"] == "river"]
check("no river action for a seat with nothing behind", not after, str(after))
check("  ... and its cards clearing is not read as a fold",
      not [a for a in rc.line() if a["seat"] == 5 and a["type"] == "fold"],
      str([(a["street"], a["type"]) for a in rc.line() if a["seat"] == 5]))

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
