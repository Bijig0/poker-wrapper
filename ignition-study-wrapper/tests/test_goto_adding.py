"""Taking the SECOND seat: `formats.goto(..., adding=True)`.

    aof-model/.venv/Scripts/python.exe tests/test_goto_adding.py

tests/test_seating.py injects `goto`, so it proves the counting and the stopping
and can say nothing about goto itself — which is exactly where table 2 of 2 died
with "a table is already open: NL200 Ring 6-max Ignition". goto's refusal is the
SINGLE-table rule ("you are seated, I will not sit you somewhere else"); every
seat after the first is necessarily taken from a page that already has a table.

The whole client is faked at `_ev` (every probe, wait and click goes through it),
so this drives the real wizard walk end to end against a client that seats a new
`data-multitableslot` when TAKE MY SEAT is pressed.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / "aof-model"))      # scout.cdp, the way launch.py finds it
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import formats as F  # noqa: E402
import tables as T  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


MODAL = ("Buy-In\nMINIMUM $40.00\nMAXIMUM $200.00\nWait for Big Blind\nTAKE MY SEAT")


class Client:
    """A fake Ignition client: N seated tables, a lobby, and a wizard that says
    yes to everything. TAKE MY SEAT adds the next `data-multitableslot`."""

    def __init__(self, seated: int = 1, lobby: bool = True):
        self.slots = list(range(seated))
        self.lobby = lobby
        self.navigated: list[str] = []
        self.detect_slots: list[object] = []      # which slot each detect() asked about
        self.seat_presses = 0

    # the table each slot is sitting at (all the same format here)
    def _params(self, slot: int) -> dict:
        return {"gameType": "NLHE", "gameFormat": "ring", "seat": "1", "playMode": "real",
                "quickSeatSmallBlind": "100", "quickSeatBigBlind": "200",
                "quickSeatBuyInAmount": "20000", "waitForBigBlind": "true",
                "gameTableUrl": "/poker-game/ring", "tableName": f"Table {slot}",
                "_title": "NL Hold'em $1/$2"}

    def ev(self, ws, js, timeout=6.0):
        # detect(): _table_js stamps the slot it wants into the source
        m = re.search(r"const SLOT = (null|\d+);", js)
        if m:
            want = None if m.group(1) == "null" else int(m.group(1))
            self.detect_slots.append(want)
            if want is None:
                return self._params(self.slots[0]) if self.slots else None
            return self._params(want) if want in self.slots else None
        if "data-multitableslot" in js and "slots" in js:            # _SEATED_JS
            return json.dumps({"slots": list(self.slots), "tagged": True})
        if js.startswith("location.href"):
            self.navigated.append(js)
            return True
        if "!!L" in js and js.strip().endswith("!!L"):               # is the lobby frame there?
            return self.lobby
        if not self.lobby:
            return None
        if "Start Cash Game" in js or "Select Stake" in js and "includes" in js:
            return True
        if "TAKE MY SEAT" in js and "b.click()" in js:
            self.seat_presses += 1
            self.slots.append(len(self.slots))
            return True
        if "TAKE MY SEAT" in js:                                     # the enabled/disabled read
            return "ready"
        if "custom-toggle" in js:
            return False                                             # practice off, as declared
        if "switch-btn" in js:
            return False
        if "MAXIMUM" in js and "b.click()" in js:
            return "200.00"
        if "otherAmount" in js:
            return "200.00"
        if "input[type=checkbox]" in js:
            return True
        if "Buy-In" in js and "TAKE MY SEAT" in js:
            return MODAL
        if "/TAKE MY SEAT/" in js:
            return MODAL
        if "close-btn" in js:
            return False
        if "querySelectorAll('li')" in js:
            return True
        if ".pop(); if(e) e.click()" in js or "b.click(); return /active/" in js:
            return "active" if "active" in js else True
        return True

    def target(self, port):
        return {"webSocketDebuggerUrl": "ws://fake", "url": "https://ignitioncasino.eu/casino"}


def install(c: Client):
    F._target = c.target
    F._ev = c.ev
    F._signed_out = lambda ws, **k: False
    # `_wait` polls through _ev; give it one pass so a "no" costs no wall clock,
    # and the same for the minutes-long lobby-boot waits
    F._wait = lambda ws, js, secs, every=0.35: c.ev(ws, js)
    F._wait_lobby = lambda ws, secs: ("lobby" if c.lobby else None)


_real = {k: getattr(F, k) for k in ("_target", "_ev", "_signed_out", "_wait", "_wait_lobby")}
FID = "ign-ring-NL200-6"

print("the refusal is the single-table rule")
c = Client(seated=1)
install(c)
r = F.goto(FID, 100, 0, log=lambda m: None)
check("a table open and adding=False → still refuses", r["ok"] is False and "already open" in r["error"], str(r)[:120])
check("  ... and presses nothing", c.seat_presses == 0, str(c.seat_presses))

c = Client(seated=1)
install(c)
r = F.goto(FID, 100, 0, log=lambda m: None, adding=True)
check("a table open and adding=True → takes the seat", r["ok"] is True, str(r)[:200])
check("  ... exactly one TAKE MY SEAT", c.seat_presses == 1, str(c.seat_presses))

print("\nit reports the table it just sat at, not the one already open")
check("the new slot is named", r.get("slot") == 1, str(r.get("slot")))
check("  ... and detect() was asked about slot 1", 1 in c.detect_slots, str(c.detect_slots))

print("\nthe first seat is unchanged")
c = Client(seated=0)
install(c)
r = F.goto(FID, 100, 0, log=lambda m: None)
check("no table open → seats normally", r["ok"] is True, str(r)[:200])
check("  ... and never asks about a slot it invented", c.detect_slots and set(c.detect_slots) <= {None}, str(c.detect_slots))

print("\nA LOG LINE CANNOT FAIL THE SEAT")
# 2026-09-21, from the session record: `route-failed ... UnicodeEncodeError:
# 'charmap' codec can't encode character '\\u2192' in position 18`, steps
# ["Cash games -> Start Cash Game"]. The wrapper's stdout was cp1252, the step
# text contains a real arrow, print() raised, and the exception came back out of
# goto as THE SEAT FAILING. Table 2 was never seated and a two-table session ran
# with one table. Whether anyone could print the step is not part of taking it.
c = Client(seated=1)
install(c)


def _explodes(msg):
    raise UnicodeEncodeError("charmap", msg, 0, 1, "character maps to <undefined>")


r = F.goto(FID, 100, 0, log=_explodes, adding=True)
check("a log that raises does not fail the walk", r["ok"] is True, str(r)[:200])
check("  ... the seat is still taken", c.seat_presses == 1, str(c.seat_presses))
check("  ... and the steps are still recorded for the panel and the record",
      any("Cash games" in s for s in (r.get("steps") or [])), str(r.get("steps"))[:200])

print("\nNAVIGATION IS REFUSED WITH TABLES SEATED")
# the entry/deep-link hops set location.href on the TOP document — the one page
# every table iframe lives in. With tables in hands that closes them all.
c = Client(seated=2, lobby=False)
install(c)
r = F.goto(FID, 100, 0, log=lambda m: None, adding=True)
check("no lobby frame + tables seated → refuses", r["ok"] is False and "not navigating" in r["error"], str(r)[:160])
check("  ... and the page was NEVER navigated", c.navigated == [], str(c.navigated))
c = Client(seated=0, lobby=False)
install(c)
F.goto(FID, 100, 0, log=lambda m: None)
check("no lobby frame + nothing seated → still hops (the old path)", len(c.navigated) > 0, str(c.navigated))

for k, v in _real.items():
    setattr(F, k, v)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
