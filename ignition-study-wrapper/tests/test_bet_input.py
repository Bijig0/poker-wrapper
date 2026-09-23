"""Which field a relayed raise types into.

    aof-model/.venv/Scripts/python.exe tests/test_bet_input.py

Hand 4919313617 (dashboard 513): the Buy-chips panel was left open over the action
strip, `raise_to` took inputs[0] — first in DOM order, anywhere in the lower 40% of
the frame — and typed "2.5" into the BUY box. The strict clamp check then re-read
that same wrong field, saw 2.5 unchanged, found no clamp and pressed RAISE, which
took its own default of 2 BB. Told 2.5x, played 2x, with the told-vs-did check the
only thing that noticed.

The geometry below is the real one, read out of that hand's DOM dump at seq 1944:

    buyMoreChipsButton  x=16   buyInButton x=32     <- panel, bottom LEFT
    foldButton x=320  callButton x=460  raiseButton x=606
    x2.5Selector x=326 ... allInSelector x=640      <- sizing row, same band
    frame w=883

So the bet field is the one beside the button the raise is confirmed on, and
anything a long way from it is some other panel's. When that cannot be decided,
REFUSING is the answer: pressing nothing is recoverable, pressing a size nobody
asked for is not.
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


FRAME_W = 883
RAISE = {"x": 606 + 66, "y": 594}          # centre of the RAISE TO button
BET_FIELD = {"x": 640, "y": 660, "value": "2", "type": "text"}
BUYIN_FIELD = {"x": 98, "y": 608, "value": "200", "type": "text"}

print("hand 513: the Buy-chips panel is open and has an amount field of its own")
inp, why = launch._pick_bet_input([BUYIN_FIELD, BET_FIELD], RAISE, FRAME_W)
check("the BET field is chosen, not the buy-in box", inp is BET_FIELD, f"{inp} / {why}")
check("  ... and nothing is refused when it can be told apart", why is None, str(why))

print("DOM order must not decide it")
inp, _ = launch._pick_bet_input([BET_FIELD, BUYIN_FIELD], RAISE, FRAME_W)
check("bet field first in the list", inp is BET_FIELD)
inp, _ = launch._pick_bet_input([BUYIN_FIELD, BET_FIELD], RAISE, FRAME_W)
check("buy-in first in the list (the hand-513 order)", inp is BET_FIELD)

print("the ordinary spot: one field, beside the button")
inp, why = launch._pick_bet_input([BET_FIELD], RAISE, FRAME_W)
check("taken", inp is BET_FIELD and why is None, str(why))

print("refusals — a size we cannot place is never typed")
inp, why = launch._pick_bet_input([], RAISE, FRAME_W)
check("no inputs at all", inp is None and "no bet input" in (why or ""), str(why))
inp, why = launch._pick_bet_input([BUYIN_FIELD], RAISE, FRAME_W)
check("only the buy-in box on screen → refuse, do not type into it",
      inp is None and "RAISE/BET button" in (why or ""), str(why))
inp, why = launch._pick_bet_input([BUYIN_FIELD, BET_FIELD], None, FRAME_W)
check("two fields and no RAISE/BET anchor → refuse",
      inp is None and "tell them apart" in (why or ""), str(why))
inp, why = launch._pick_bet_input([BET_FIELD], None, FRAME_W)
check("one field and no anchor → still usable", inp is BET_FIELD and why is None, str(why))

# The sizing row (x2.5 / X4 / Pot / ALL-IN, x 326..738) sits under the strip and is
# the same band as the bet field: a picker tuned so tightly it rejected those would
# refuse real raises. Half the frame is the margin.
print("tolerance is wide enough for the real strip, narrow enough to exclude the panel")
far_left = {"x": 98, "y": 660}
near_strip = {"x": 326, "y": 660}
inp, why = launch._pick_bet_input([near_strip], RAISE, FRAME_W)
check("a field at the left end of the sizing row is still the bet field", inp is near_strip, str(why))
inp, why = launch._pick_bet_input([far_left], RAISE, FRAME_W)
check("a field over at the Buy-chips panel is not", inp is None and "not the bet field" in (why or ""), str(why))


# ---- THE FRAME IS NOT A RULER (2026-09-20) ------------------------------------
# _FIND_INPUT_JS used to keep only inputs in the lower 40% of the FRAME. That
# holds while the frame is about as tall as the table it renders. When the
# external screen moved from 200% to 100% scaling the frame became 1513 px tall
# around the same ~756 px of table: the bet field sat at 39% of the frame, was
# filtered out before it ever reached _pick_bet_input, and every relayed raise
# came back "no bet input on screen — not a raise spot?". The anchor decides now,
# and these pin that it does so regardless of how tall the frame is.
print("a tall frame around a short table")
TALL_RAISE = {"x": 672, "y": 591}
TALL_FIELD = {"x": 640, "y": 591, "h": 42, "value": "4", "type": "text"}
inp, why = launch._pick_bet_input([TALL_FIELD], TALL_RAISE, 1392)
check("the bet field is found though it sits at 39% of a 1513px frame", inp is TALL_FIELD, str(why))

# the discrimination that filter was standing in for still has to hold
FAR_ROW = {"x": 660, "y": 591 - 400, "h": 42, "value": "9", "type": "text"}
inp, why = launch._pick_bet_input([FAR_ROW], TALL_RAISE, 1392)
check("  ... but a field 400px above the button is a different row → refuse",
      inp is None and "row" in (why or ""), str(why))
inp, _ = launch._pick_bet_input([FAR_ROW, TALL_FIELD], TALL_RAISE, 1392)
check("  ... and with both on screen it still takes the one beside the button", inp is TALL_FIELD)

# an input carrying no height (older reads) must not be refused for it
NO_H = {"x": 640, "y": 591, "value": "4", "type": "text"}
inp, why = launch._pick_bet_input([NO_H], TALL_RAISE, 1392)
check("an input with no height recorded is still usable", inp is NO_H, str(why))

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
