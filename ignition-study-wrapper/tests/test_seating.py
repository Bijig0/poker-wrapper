"""Taking the session's seats: how many, when to stop, what a failure does.

    aof-model/.venv/Scripts/python.exe tests/test_seating.py

Ignition seats up to four tables in ONE client on ONE login: from a seated table
you go back to the lobby and take another seat, and the client adds a table and
re-tiles them all. `launch._seat_next_table` takes exactly one of those seats and
says whether the session has them all yet.

The three client calls are injected, so this tests the part that is OURS — the
counting, the stopping, the failure handling — without needing a lobby to click.
What a Lobby button looks like lives in formats.py and can only be proven against
the real client; the arithmetic here can be proven now, and it is the half that
would silently seat three tables when you asked for four.
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


class Client:
    """A client that seats a table whenever `goto` is called — or refuses to."""

    def __init__(self, seated=0, fails_at=None, lobby_ok=True):
        self.seated = seated
        self.fails_at = fails_at          # 1-based seat number that will not take
        self.lobby_ok = lobby_ok
        self.lobby_calls = 0
        self.goto_calls = 0

    def fns(self):
        return {"count": lambda: list(range(self.seated)),
                "to_lobby": self._to_lobby, "goto": self._goto}

    def _to_lobby(self):
        self.lobby_calls += 1
        return {"ok": True} if self.lobby_ok else {"ok": False, "error": "no Lobby control"}

    def _goto(self):
        self.goto_calls += 1
        if self.fails_at == self.seated + 1:
            return {"ok": False, "error": "no table at that stake"}
        self.seated += 1
        return {"ok": True, "detected": {"name": f"table {self.seated}"}}


def seat_until_done(want, client, limit=10):
    """Drive the step the way the router does, and count the passes."""
    passes = 0
    while passes < limit:
        passes += 1
        r = launch._seat_next_table("ign-practice-ring", {"tables": want}, want, client.fns())
        if r["done"] or not r.get("ok"):
            return r, passes
    return {"done": False, "error": "did not settle"}, passes


print("how many seats get taken")
for want in (1, 2, 4):
    c = Client(seated=1)                  # the first table is already seated by the router
    r, passes = seat_until_done(want, c)
    check(f"asked for {want} → {c.seated} seated", c.seated == want, f"got {c.seated}")
    check(f"  ... and it stops (done after {passes} pass{'es' if passes > 1 else ''})", r["done"] is True, str(r))
    check(f"  ... taking {want - 1} extra seat{'s' if want - 1 != 1 else ''}",
          c.goto_calls == want - 1, f"goto called {c.goto_calls}x")

print("\nalready there")
c = Client(seated=4)
r, _ = seat_until_done(4, c)
check("four wanted, four seated → nothing to do", r["done"] and c.goto_calls == 0, str(r))
c = Client(seated=2)
r = launch._seat_next_table("f", {"tables": 2}, 2, c.fns())
check("two wanted, two seated → no extra seat", r["done"] and c.goto_calls == 0, str(r))

print("\na seat that will not take")
c = Client(seated=1, fails_at=2)
r, passes = seat_until_done(4, c)
check("the loop STOPS rather than spinning on it", r.get("ok") is False and passes == 1, f"{passes} passes, {r}")
check("  ... and says which table it was", r.get("seat") == 2, str(r.get("seat")))
check("  ... leaving the tables that did seat", c.seated == 1, str(c.seated))

print("\nthe lobby is an aid, not a gate")
# goto drives the lobby through the DOM, which fires whether or not the lobby is
# the frame on top — so a missing Lobby button must not refuse a seat that would
# have worked
c = Client(seated=1, lobby_ok=False)
r, _ = seat_until_done(2, c)
check("no Lobby control → the seat is still attempted", c.goto_calls == 1, f"goto called {c.goto_calls}x")
check("  ... and succeeds", c.seated == 2 and r["done"], str(r))

print("\nthe client's count is believed, not our own bookkeeping")


class Liar(Client):
    """`goto` says ok but the client seated nothing — a silent refusal."""
    def _goto(self):
        self.goto_calls += 1
        return {"ok": True, "detected": {}}


c = Liar(seated=1)
r, passes = seat_until_done(4, c)
check("goto claiming success without a seat is caught", r.get("ok") is False and passes == 1, str(r))

print("\nclosing a table STOPS the session asking for it back")
# Until 2026-09-21 the seating loop worked to the DECLARED count, so closing a
# table meant the leader took the seat straight back — the only way to end up
# with one table was to end the session.
CFG2, CFG4 = {"tables": 2}, {"tables": 4}


def fresh_close(rec=None):
    launch._closed_tables.clear()
    launch._seating["reached"] = 0
    launch._session.update({"id": None, "rec": rec, "started": 0.0})


fresh_close()
check("nothing closed → the session wants what it declared",
      (launch._tables_wanted(CFG2), launch._tables_wanted(CFG4)) == (2, 4),
      str((launch._tables_wanted(CFG2), launch._tables_wanted(CFG4))))
launch._closed_tables.add(2)
check("one closed → it wants one fewer", launch._tables_wanted(CFG2) == 1, str(launch._tables_wanted(CFG2)))
check("  ... and the seating loop is then finished at one table",
      launch._seat_next_table("f", CFG2, launch._tables_wanted(CFG2), Client(seated=1).fns())["done"] is True)
launch._closed_tables.update({2, 3, 4})
check("all the extras closed → never below one table", launch._tables_wanted(CFG4) == 1,
      str(launch._tables_wanted(CFG4)))

print("\n  ... and it is remembered in the session record, not only in memory")
fresh_close(rec={"config": {"tables": 4},
                 "events": [{"kind": "table-closed", "data": {"slot": 3}}]})
check("a leader restarted mid-session still honours the close",
      launch._tables_wanted(CFG4) == 3 and 3 in launch._tables_closed(), str(launch._tables_closed()))

print("\na close never forfeits a hand")
# The half that stops the re-seating is unconditional; the half that presses
# Leave waits for the hand to finish. Getting this the other way round would
# fold hero's aces because somebody clicked a button on another window.
LEFT: list[str] = []
_real_leave, _real_cdp = launch.F.leave, launch.cdp.available
launch.F.leave = lambda *a, **k: (LEFT.append("left"), {"ok": True})[1]
launch.cdp.available = lambda *a, **k: True
try:
    launch._study["standDownPending"] = None
    launch._ws_state.update({"heroCards": ["Ah", "Ad"], "handOver": False, "heroFolded": False})
    r = launch._stand_down_table("closed from the panel")
    check("hero holding cards → the table is NOT left yet", r.get("deferred") is True and not LEFT, str(r))
    check("  ... and it is remembered", launch._study.get("standDownPending"), str(launch._study.get("standDownPending")))
    launch._maybe_stand_down()
    check("  ... still not, while the hand is on", not LEFT, str(LEFT))
    launch._ws_state["handOver"] = True
    launch._maybe_stand_down()
    check("  ... and left the moment the hand is over", LEFT == ["left"], str(LEFT))
    check("  ... once, not every tick", (launch._maybe_stand_down(), LEFT)[1] == ["left"], str(LEFT))
finally:
    launch.F.leave, launch.cdp.available = _real_leave, _real_cdp
    launch._study["standDownPending"] = None
    launch._ws_state.update({"heroCards": [], "handOver": False})

print("\nclosed BY HAND is a decision too, not a table to re-seat")
# the count falling BELOW a number we have reached is a table that went away;
# the same count before we ever reached it is a table still coming up
fresh_close()
launch._seating["reached"] = 0
check("2 of 4 seated on the way up → still wants 4", launch._honour_closed_tables(CFG4, 2) == 4)
launch._seating["reached"] = 4
check("2 of 4 seated AFTER having had 4 → wants 2", launch._honour_closed_tables(CFG4, 2) == 2)
check("  ... and does not keep giving up on the same drop",
      launch._honour_closed_tables(CFG4, 2) == 2 and len(launch._closed_tables) == 2,
      str(launch._closed_tables))
check("  ... tables are given up from the end (4, then 3)",
      launch._closed_tables == {3, 4}, str(launch._closed_tables))
fresh_close()

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
