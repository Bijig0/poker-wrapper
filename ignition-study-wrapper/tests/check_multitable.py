"""Is multi-table actually working RIGHT NOW? Read-only, safe to run mid-session.

    aof-model/.venv/Scripts/python.exe tests/check_multitable.py
    aof-model/.venv/Scripts/python.exe tests/check_multitable.py --watch

Every failure this checks for has actually happened, on a real table, with money
on it, and every one of them was INVISIBLE from the panel at the time:

  * the followers never joined the session, so they read their felt in silence
    with answers off (2026-09-21)
  * both wrappers ingested both tables' WebSockets, so table 1's aces arrived in
    table 2's hand state and the wrong panel answered them
  * the capture could not identify its own socket, dropped every frame, and the
    panel sat on "no hand in progress" while /state still said "connected"
  * the second table was never seated at all, because a log line raised

So this asks the questions that separate those from a healthy run, and says which
one is which. It reads only — no presses, no navigation, nothing written.

WHAT A PASS MEANS: each wrapper is on its own table, on the same session, with
answers on and its capture bound to its own socket. What it cannot tell you is
whether the ANSWER is right; that is what the Game state card on each panel is
for — check its hole cards against the felt.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import tables as TABLES  # noqa: E402

OK, BAD, WARN = "PASS", "FAIL", "....."


def get(port: int, path: str, timeout: float = 6.0):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"__error": f"{type(e).__name__}: {e}"}


class Report:
    def __init__(self):
        self.bad = 0
        self.warn = 0

    def say(self, state: str, label: str, detail: str = "") -> None:
        if state == BAD:
            self.bad += 1
        elif state == WARN:
            self.warn += 1
        print(f"  {state:<5} {label}{('  — ' + detail) if detail else ''}")

    def check(self, ok, label, detail="", soft=False):
        self.say(OK if ok else (WARN if soft else BAD), label, "" if ok else detail)
        return ok


def live_wrappers() -> list[dict]:
    out = []
    for slot in range(1, TABLES.MAX_TABLES + 1):
        p = TABLES.panel_port(slot)
        d = get(p, TABLES.PRESENCE_PATH, 3.0)
        if not d.get("__error") and d.get("slot") == slot:
            out.append({"slot": slot, "port": p, "presence": d})
    return out


def run() -> int:
    r = Report()
    print("=" * 66)
    print("MULTI-TABLE HEALTH  " + time.strftime("%H:%M:%S"))
    print("=" * 66)

    print("\n1. the wrappers")
    live = live_wrappers()
    if not r.check(live, "wrappers are answering",
                   f"nothing on {[TABLES.panel_port(n) for n in (1, 2, 3, 4)]} — is the session running?"):
        return 1
    print(f"        slots up: {[w['slot'] for w in live]}")
    r.check(any(w["slot"] == TABLES.LEADER for w in live),
            f"table {TABLES.LEADER} (the leader) is one of them",
            "the leader runs the session and the seating; without it nothing else joins")
    rigs = {w["presence"].get("rig") for w in live}
    r.check(len(rigs) == 1, "they are all the same rig", f"mixed rigs: {rigs} — a live wrapper and the test rig share these ports")
    if len(live) < 2:
        r.say(WARN, "only one table is up", "nothing below can go wrong yet — start the second and run this again")
        return 0 if not r.bad else 1

    print("\n2. one session, not one each")
    sids = {w["slot"]: w["presence"].get("sid") for w in live}
    r.check(all(sids.values()), "every table is on a session", f"no session on {[s for s, v in sids.items() if not v]}")
    r.check(len(set(sids.values())) == 1, "and it is the SAME session",
            f"{sids} — a follower that never got /session/join reads its felt with answers off")

    print("\n3. each table is reading its OWN table")
    states = {}
    for w in live:
        st = get(w["port"], "/state?light=1")
        states[w["slot"]] = st
        if st.get("__error"):
            r.check(False, f"table {w['slot']} answers /state", st["__error"])
    states = {k: v for k, v in states.items() if not v.get("__error")}

    taps = {s: (st.get("tap") or {}) for s, st in states.items()}
    for s, t in taps.items():
        if not t.get("multi"):
            r.say(WARN, f"table {s} does not think it is multi-table", "TABLE_SLOT is not set on it")
            continue
        bound = t.get("bound")
        r.check(bound, f"table {s}: capture is bound to a socket",
                f"unbound for {t.get('unboundForS')}s, {t.get('heldWhileUnbound')} frames dropped"
                + (" — STALLED" if t.get("stalled") else " (it binds on the first hand you are dealt in)"))
        seat = t.get("heroSeat")
        r.check(isinstance(seat, int) and seat >= 1, f"table {s}: the DOM says which seat is yours",
                f"heroSeat={seat!r} — a frame it could not resolve, or a seat number it could not read")
    bounds = [t.get("bound") for t in taps.values() if t.get("bound")]
    if len(bounds) > 1:
        r.check(len(set(bounds)) == len(bounds), "the tables are on DIFFERENT sockets",
                f"{bounds} — two wrappers reading one table")

    print("\n4. the hands are different hands")
    hands = {s: (st.get("hand") or {}) for s, st in states.items()}
    dealt = {s: h for s, h in hands.items() if h.get("heroCards")}
    if len(dealt) < 2:
        r.say(WARN, "fewer than two tables are in a hand right now",
              "run it again mid-hand — this is the check that catches cross-table reads")
    else:
        cards = {s: " ".join(h["heroCards"]) for s, h in dealt.items()}
        r.check(len(set(cards.values())) == len(cards), "no two tables show the same hole cards",
                f"{cards} — the same cards on two tables is one table being read twice")
        ids = {s: h.get("clientHandId") for s, h in dealt.items() if h.get("clientHandId")}
        if len(ids) > 1:
            r.check(len(set(ids.values())) == len(ids), "no two tables show the same hand id", str(ids))

    print("\n5. the answers are armed")
    for s, st in states.items():
        r.check(st.get("studyAnswers"), f"table {s}: study answers are on",
                "the session declared answers but this table is not answering")
        pr = st.get("pickReady") or {}
        if not pr.get("ok") and pr.get("reason"):
            r.say(WARN, f"table {s}: no pick right now", str(pr.get("reason")))

    print("\n6. nothing is being dropped that should not be")
    first = {s: (taps.get(s) or {}).get("heldWhileUnbound") for s in states}
    time.sleep(4)
    for s in states:
        t2 = (get(TABLES.panel_port(s), "/state?light=1").get("tap") or {})
        a, b = first.get(s), t2.get("heldWhileUnbound")
        if a is None or b is None:
            continue
        if t2.get("bound"):
            r.check(True, f"table {s}: bound, so nothing is being held")
        else:
            r.check(b == a, f"table {s}: held frames are not still climbing",
                    f"{a} -> {b} in 4s — the capture still cannot tell which table is ours")

    print("\n" + "=" * 66)
    if r.bad:
        print(f"  {r.bad} FAILED" + (f", {r.warn} to watch" if r.warn else ""))
        print("  Do not trust the answers until these are clean.")
    else:
        print("  ALL CLEAN" + (f" ({r.warn} to watch)" if r.warn else ""))
        print("  Last thing, and only you can do it: open each panel's Game state")
        print("  card and check the hole cards against that table's felt.")
    print("=" * 66)
    return 1 if r.bad else 0


if __name__ == "__main__":
    if "--watch" in sys.argv:
        try:
            while True:
                run()
                time.sleep(20)
        except KeyboardInterrupt:
            print("\nstopped")
        sys.exit(0)
    sys.exit(run())
