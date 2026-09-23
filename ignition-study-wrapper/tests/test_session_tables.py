"""A multi-table sitting must not split into two sessions.

    aof-model/.venv/Scripts/python.exe tests/test_session_tables.py

Session 20260920_130435 is what this is for. The leader declared it with
tables=2, slot 2 joined, and nine minutes later the leader swept it as a
"leftover" (_end_other_open) and took a fresh single-table session instead.
Nobody told slot 2. It kept the dead id and archived 33 hands into it between
13:19 and 14:15 — while the session's own summary says "hands: 0".

Three things have to hold:

  1. a table leaves the session it was ASKED to leave, never whatever it is on
     — the leftover sweep names an id, and a table on a different one is busy;
  2. the sweep tells the tables at all, instead of only writing the record;
  3. a follower whose session was ended behind its back notices by itself —
     because the leader may have crashed rather than swept anything.

And the other direction, which cost the 2026-09-21 session: a follower whose
JOIN never arrived takes the session up itself. The leader pushes `/session/join`
once, at Start; if that push misses — the peer list was empty, the table was
still booting, the wrapper restarted mid-session — nothing ever asked again, and
the table read its felt for twenty hands with answers off.
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
import tables as TABLES  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


# ---- stubs: the record store, the archive, and everything teardown touches ----
EVENTS: list[tuple] = []
ENDED: set[str] = set()


OPEN: list[dict] = []           # what open_sessions() offers, newest first


class _Store:
    def get(self, sid):
        for r in OPEN:
            if r["id"] == sid:
                return {**r, "ended_at": 1 if sid in ENDED else None}
        if sid not in ("live-session", "dead-session"):
            return None
        return {"id": sid, "ended_at": 1 if sid in ENDED else None}

    def event(self, sid, kind, data=None):
        EVENTS.append((sid, kind, data))

    def open_sessions(self):
        return [r for r in OPEN if r["id"] not in ENDED]


_real = {
    "sessions": launch._sessions, "hands": launch._session_hands,
    "archive": launch._archive_hand, "debug": launch.set_debug,
    "feed": launch._feed_add, "slot": TABLES.slot, "leader": TABLES.is_leader,
}


def install(slot):
    launch._sessions = _Store()
    launch._session_hands = lambda sid: 7
    launch._archive_hand = lambda *a, **k: None
    launch.set_debug = lambda *a, **k: None
    launch._feed_add = lambda *a, **k: None
    TABLES.slot = lambda: slot
    TABLES.is_leader = lambda: slot is None or slot == TABLES.LEADER
    launch._orphan_check.update({"at": 0.0, "said": None})


def restore():
    launch._sessions = _real["sessions"]
    launch._session_hands = _real["hands"]
    launch._archive_hand = _real["archive"]
    launch.set_debug = _real["debug"]
    launch._feed_add = _real["feed"]
    TABLES.slot = _real["slot"]
    TABLES.is_leader = _real["leader"]


try:
    print("1. a table leaves the session it was NAMED, not whatever it is on")
    install(slot=2)
    launch._session.update({"id": "live-session", "rec": {}, "started": 0.0})
    code, body = launch._session_leave({"sid": "some-other-session"})
    check("asked to leave a session it is not on → stays", launch._session["id"] == "live-session",
          str(launch._session["id"]))
    check("  ... and says so rather than erroring", code == 200 and body.get("left") is None, str(body))

    code, body = launch._session_leave({"sid": "live-session"})
    check("asked to leave its OWN session → leaves", launch._session["id"] is None, str(launch._session["id"]))
    check("  ... reporting the id and its hand count",
          body.get("left") == "live-session" and body.get("hands") == 7, str(body))
    check("  ... and records table-left with the slot",
          any(e[1] == "table-left" and (e[2] or {}).get("slot") == 2 for e in EVENTS), str(EVENTS))

    # a bare call with no sid is the old shape and must still stand the table down
    EVENTS.clear()
    launch._session.update({"id": "live-session", "rec": {}, "started": 0.0})
    launch._session_leave({})
    check("no sid given → leaves (the old caller shape still works)", launch._session["id"] is None)

    print("2. a follower notices its session was ended behind its back")
    install(slot=3)
    ENDED.clear()
    launch._session.update({"id": "live-session", "rec": {}, "started": 0.0})
    launch._maybe_session_orphaned()
    check("session still open → carries on", launch._session["id"] == "live-session")

    ENDED.add("live-session")
    launch._orphan_check["at"] = 0.0          # past the poll interval
    launch._maybe_session_orphaned()
    check("session ended elsewhere → stands itself down", launch._session["id"] is None,
          str(launch._session["id"]))

    print("3. the leader never orphans itself")
    install(slot=None)                         # a lone wrapper: is_leader() is true
    ENDED.add("live-session")
    launch._session.update({"id": "live-session", "rec": {}, "started": 0.0})
    launch._maybe_session_orphaned()
    check("single-table wrapper ignores the check", launch._session["id"] == "live-session")

    install(slot=1)                            # the leader of a multi-table run
    launch._session.update({"id": "live-session", "rec": {}, "started": 0.0})
    launch._maybe_session_orphaned()
    check("leader of four ignores it too — the record is its own",
          launch._session["id"] == "live-session")

    print("4. the poll does not hammer the store")
    install(slot=2)
    reads = {"n": 0}

    class _Counting(_Store):
        def get(self, sid):
            reads["n"] += 1
            return super().get(sid)

    launch._sessions = _Counting()
    launch._session.update({"id": "live-session", "rec": {}, "started": 0.0})
    ENDED.clear()
    for _ in range(50):
        launch._maybe_session_orphaned()
    check("fifty ticks → one read, not fifty", reads["n"] == 1, f"{reads['n']} reads")

    print("5. a follower whose invitation never arrived joins the session itself")
    JOINS: list[dict] = []

    def _join(body):
        JOINS.append(body)
        if body.get("fail"):
            return 409, {"ok": False, "error": "no"}
        launch._session.update({"id": body["sid"], "rec": {}, "started": 0.0})
        return 200, {"ok": True}

    _real_join = launch._session_join
    launch._session_join = _join

    def fresh(slot, sessions):
        install(slot=slot)
        launch._sessions = _Store()
        launch._session.update({"id": None, "rec": None, "started": 0.0})
        launch._adopt_check.update({"at": 0.0, "said": None})
        JOINS.clear()
        EVENTS.clear()
        ENDED.clear()
        OPEN[:] = sessions

    TWO = {"id": "s-two", "config": {"tables": 2, "answers": True, "format": "ign-ring-NL200-6"}}
    ONE = {"id": "s-one", "config": {"tables": 1, "answers": True}}

    fresh(slot=2, sessions=[TWO])
    launch._maybe_session_adopt()
    check("a session that declared 2 tables → slot 2 joins it",
          [j["sid"] for j in JOINS] == ["s-two"], str(JOINS))
    check("  ... carrying the session's own config, not a guess",
          (JOINS[0].get("config") or {}).get("format") == "ign-ring-NL200-6", str(JOINS))
    check("  ... and it is on that session now", launch._session["id"] == "s-two")

    # THE GUARD THAT MATTERS: a session that did not ask for this table
    fresh(slot=2, sessions=[ONE])
    launch._maybe_session_adopt()
    check("a SINGLE-table session is not ours to join", JOINS == [], str(JOINS))
    fresh(slot=3, sessions=[TWO])
    launch._maybe_session_adopt()
    check("a two-table session is not table 3's either", JOINS == [], str(JOINS))
    fresh(slot=4, sessions=[ONE, TWO])
    launch._maybe_session_adopt()
    check("  ... and it looks past the ones that are not, without taking them",
          JOINS == [], str(JOINS))

    fresh(slot=1, sessions=[TWO])
    launch._maybe_session_adopt()
    check("the LEADER never adopts — it owns the record", JOINS == [], str(JOINS))
    fresh(slot=None, sessions=[TWO])
    launch._maybe_session_adopt()
    check("nor does a single-table wrapper", JOINS == [], str(JOINS))

    print("6. ... and it keeps trying, without saying so every time")
    fresh(slot=2, sessions=[TWO])
    TWO_BAD = {**TWO, "config": {**TWO["config"]}, "fail": True}
    OPEN[:] = [TWO_BAD]

    def _join_failing(body):
        JOINS.append(body)
        return 409, {"ok": False, "error": "the leader had not written it yet"}

    launch._session_join = _join_failing
    for _ in range(5):
        launch._adopt_check["at"] = 0.0       # each one a fresh poll interval
        launch._maybe_session_adopt()
    check("five polls, five attempts — a transient refusal is not the end of it",
          len(JOINS) == 5, f"{len(JOINS)} attempts")

    launch._session_join = _join
    launch._adopt_check["at"] = 0.0
    launch._maybe_session_adopt()
    check("  ... and the moment it can join, it does", launch._session["id"] == "s-two")

    print("7. the pull does not hammer the store either")
    fresh(slot=2, sessions=[TWO])
    reads2 = {"n": 0}

    class _CountingOpen(_Store):
        def open_sessions(self):
            reads2["n"] += 1
            return super().open_sessions()

    launch._sessions = _CountingOpen()
    launch._session_join = lambda body: (409, {"ok": False, "error": "busy"})
    for _ in range(50):
        launch._maybe_session_adopt()
    check("fifty ticks → one read, not fifty", reads2["n"] == 1, f"{reads2['n']} reads")
    launch._session_join = _real_join
finally:
    restore()
    launch._session.update({"id": None, "rec": None, "started": 0.0})

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
