"""Which tables are up, and whether the leader can reach them.

    aof-model/.venv/Scripts/python.exe tests/test_presence.py

This is the test that was missing on 2026-09-21, when a two-table session ran
for twenty hands with one table answering. Nothing had broken: presence was read
from the CLAIM files, the 2026-09-20 window-model correction had removed the only
thing that WROTE them (`pin()` is now always called without a slot, because the
four tables share one page and claiming it would blind the other three), and an
empty peer list is indistinguishable from a single-table run. The leader fanned
`/session/join` out to nobody, three wrappers never learned there was a session,
and every one of them sat on a live felt with answers off.

So presence is now asked, not remembered — and it is asked of REAL servers here,
not of a stub, because the failure was in what the wrappers could see of each
other rather than in anyone's arithmetic. Four `http.server`s stand in for four
wrappers; the leader's own `_fan_out` has to reach them.

They run on a base port of their own (PANEL_BASE is late-bound for exactly this):
:7700 on this machine is a live session with real money on it.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / "aof-model"))      # scout.cdp, the way launch.py finds it
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import tables as TABLES  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


# A base well clear of the live map (7700-7730), the panel rig (7701) and the
# API (2000). Raised once if it is busy — a test that fights for a port is a
# test that fails for the wrong reason.
TEST_BASE = 7860
TEST_STEP = 10


class Wrapper:
    """One wrapper, as its peers see it: a presence answer and a POST inbox."""

    def __init__(self, slot: int, rig: str = "live", sid=None, count: int = 2,
                 delay: float = 0.0, answer_slot=None, broken: bool = False):
        self.slot = slot
        self.rig = rig
        self.sid = sid
        self.count = count
        self.delay = delay                       # a wrapper that is wedged, not dead
        self.answer_slot = slot if answer_slot is None else answer_slot
        self.broken = broken                     # answers, but not with JSON
        self.posts: list[tuple[str, dict]] = []
        self.probes = 0
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, payload: bytes):
                try:
                    self.send_response(code)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except OSError:
                    # the wedged-peer case: the prober gave up at its timeout and
                    # hung up while this handler was still asleep. That IS the
                    # behaviour under test — it should not print a stack trace
                    # over the results.
                    pass

            def do_GET(self):
                if self.path.startswith("/state"):
                    # what the leader collects for the combined strip
                    return self._json(200, json.dumps({
                        "ok": True, "tableSlot": outer.slot, "sessionId": outer.sid,
                        "studyAnswers": bool(outer.sid), "connected": True,
                        "hand": {"street": "flop", "heroCards": ["Ah", "Kd"],
                                 "currentNode": {"toActIsHero": False}},
                        "panelAnswer": None}).encode())
                if self.path != TABLES.PRESENCE_PATH:
                    return self._json(404, b'{"ok":false}')
                outer.probes += 1
                if outer.delay:
                    time.sleep(outer.delay)
                if outer.broken:
                    return self._json(200, b"<html>not json</html>")
                self._json(200, json.dumps({
                    "ok": True, "slot": outer.answer_slot, "rig": outer.rig,
                    "panelPort": TABLES.panel_port(outer.slot), "pid": 1000 + outer.slot,
                    "count": outer.count, "sid": outer.sid, "at": time.time()}).encode())

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(n) or b"{}")
                except Exception:
                    body = {}
                outer.posts.append((self.path, body))
                self._json(200, json.dumps({"ok": True, "slot": outer.slot}).encode())

        self.srv = ThreadingHTTPServer(("127.0.0.1", TABLES.panel_port(slot)), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def stop(self):
        try:
            self.srv.shutdown()
            self.srv.server_close()
        except Exception:
            pass


def be(slot, count=2, fake=False):
    """Become this wrapper: slot, declared count, rig."""
    os.environ["TABLE_SLOT"] = str(slot) if slot else ""
    if not slot:
        os.environ.pop("TABLE_SLOT", None)
    os.environ["TABLE_COUNT"] = str(count)
    if fake:
        os.environ["FAKE_TABLE"] = "1"
    else:
        os.environ.pop("FAKE_TABLE", None)
    forget()


def forget():
    with TABLES._presence_lock:
        TABLES._presence.update({"at": 0.0, "rows": [], "probing": False})


_env = {k: os.environ.get(k) for k in ("TABLE_SLOT", "TABLE_COUNT", "FAKE_TABLE")}
_base = (TABLES.PANEL_BASE, TABLES.PANEL_STEP)
TABLES.PANEL_BASE, TABLES.PANEL_STEP = TEST_BASE, TEST_STEP
live: list[Wrapper] = []

try:
    print("the port map")
    check("slots 1-4 map to base, +10, +20, +30",
          [TABLES.panel_port(n) for n in (1, 2, 3, 4)] == [TEST_BASE + 10 * i for i in range(4)],
          str([TABLES.panel_port(n) for n in (1, 2, 3, 4)]))
    check("the leader's port is slot 1's", TABLES.leader_port() == TABLES.panel_port(1))

    print("\na single table has no peers and does no I/O")
    # A wrapper on the single-table path must not so much as open a socket: that
    # path is the one that has always worked and carries the most hands.
    watcher = Wrapper(slot=2); live.append(watcher)
    be(slot=None, count=1)
    seen_before = watcher.probes
    check("registry is empty", TABLES.registry() == [])
    check("peers is empty", TABLES.peers() == [])
    check("live_peers is empty", TABLES.live_peers() == [])
    time.sleep(0.3)                          # a background refresh would have landed by now
    check("  ... and nobody was asked anything", watcher.probes == seen_before,
          f"{watcher.probes - seen_before} probes")
    watcher.stop(); live.remove(watcher)

    print("\nthe wire contract: what a wrapper SERVES is what a probe accepts")
    # Both ends of this were written in one sitting and could drift in the next:
    # the endpoint is `presence_record()` in launch's route, the reader is
    # `probe()`. A hand-written fixture in this file would agree with neither, so
    # serve the real record and probe it for real.
    be(slot=3, count=2)                       # the record is built by slot 3, about itself
    real_body = TABLES.presence_record(TABLES.panel_port(3), sid="S-live")
    be(slot=1, count=2)

    class RealH(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            payload = json.dumps(real_body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    real_srv = ThreadingHTTPServer(("127.0.0.1", TABLES.panel_port(3)), RealH)
    threading.Thread(target=real_srv.serve_forever, daemon=True).start()
    try:
        seen = TABLES.probe(3, 1.0)
        check("a real presence_record() is accepted by a real probe()", seen is not None, str(real_body))
        check("  ... as the right slot, on the right port",
              (seen or {}).get("slot") == 3 and (seen or {}).get("panelPort") == TABLES.panel_port(3),
              str(seen))
        check("  ... carrying the session it is on, which is what the strip needs",
              (seen or {}).get("sid") == "S-live", str(seen))
        check("  ... and it names a rig", real_body.get("rig") in ("live", "fake"), str(real_body))
    finally:
        real_srv.shutdown()
        real_srv.server_close()

    print("\nprobing: identity is checked, never assumed")
    be(slot=1, count=2)
    check("nothing listening → None", TABLES.probe(2, 0.5) is None)

    w2 = Wrapper(slot=2); live.append(w2)
    got = TABLES.probe(2, 1.0)
    check("a wrapper answering as slot 2 → found", (got or {}).get("slot") == 2, str(got))
    check("  ... carrying its panel port", (got or {}).get("panelPort") == TABLES.panel_port(2), str(got))

    w3 = Wrapper(slot=3, answer_slot=1); live.append(w3)
    check("something on slot 3's port answering as slot 1 → rejected", TABLES.probe(3, 1.0) is None)

    w4 = Wrapper(slot=4, broken=True); live.append(w4)
    check("an answer that is not JSON → rejected", TABLES.probe(4, 1.0) is None)

    print("\nTHE RIG IS PART OF THE IDENTITY")
    # the test rig serves these same ports; a real-money session fanning a join
    # out to a fake table would relay picks nobody made into a lookalike rig
    w2.rig = "fake"
    check("a FAKE wrapper is invisible to a live one", TABLES.probe(2, 1.0) is None)
    be(slot=1, count=2, fake=True)
    check("  ... and visible to a fake one", (TABLES.probe(2, 1.0) or {}).get("slot") == 2)
    be(slot=1, count=2)
    w2.rig = "live"
    check("  ... and back", (TABLES.probe(2, 1.0) or {}).get("slot") == 2)

    print("\nthe registry: declared tables that are NOT answering keep their row")
    # a strip that silently shrinks to one row is how three silent tables went
    # unnoticed for a whole session
    be(slot=1, count=4)
    rows = {r["slot"]: r for r in TABLES.refresh_presence(1.0) or []}
    reg = {r["slot"]: r for r in TABLES.registry()}
    check("all four declared slots have a row", sorted(reg) == [1, 2, 3, 4], str(sorted(reg)))
    check("slot 1 (us) is live", reg[1]["live"] is True and reg[1].get("me") is True, str(reg.get(1)))
    check("slot 2 (answering) is live", reg[2]["live"] is True, str(reg.get(2)))
    check("slot 3 (wrong identity) is NOT live", reg[3]["live"] is False, str(reg.get(3)))
    check("  ... and still carries its port so it can be opened", reg[3]["panelPort"] == TABLES.panel_port(3))

    be(slot=1, count=2)
    TABLES.refresh_presence(1.0)
    reg = {r["slot"]: r for r in TABLES.registry()}
    check("a session of two shows two rows, not four", sorted(reg) == [1, 2], str(sorted(reg)))

    print("\npeers: the others, never ourselves")
    peers = TABLES.peers()
    check("slot 1 sees exactly [2]", [p["slot"] for p in peers] == [2], str([p["slot"] for p in peers]))
    be(slot=2, count=2)
    TABLES.refresh_presence(1.0)
    check("slot 2 does not see itself through its own port",
          [p["slot"] for p in TABLES.peers()] == [], str([p["slot"] for p in TABLES.peers()]))

    print("\nthe hot path never waits on a wedged table")
    # WEDGED, NOT DEAD — the case that matters. A dead port refuses instantly; a
    # wrapper that accepts the connection and then stops answering holds the
    # caller for the full timeout, and the panel renders this on a 1 Hz tick.
    w3.stop(); live.remove(w3)               # free slot 3's port before rebinding it
    # (Windows' SO_REUSEADDR would let a second server bind the same port and
    # leave which one answers up to the kernel — an unreadable test.)
    w5 = Wrapper(slot=3, delay=5.0); live.append(w5)
    be(slot=1, count=4)
    forget()                                 # the snapshot is empty AND stale: worst case
    t0 = time.time()
    for _ in range(5):
        TABLES.registry()
    lag = time.time() - t0
    check(f"five registry() calls on an empty, stale snapshot cost {lag * 1000:.0f} ms", lag < 0.3,
          f"{lag:.2f}s")
    check("  ... and they did start the refresh rather than skipping it",
          TABLES._presence["probing"] is True or w5.probes > 0, str(TABLES._presence))
    t0 = time.time()
    fresh = TABLES.refresh_presence(0.8)
    spent = time.time() - t0
    check(f"a synchronous refresh is bounded by the timeout ({spent:.1f}s), not by the peer", spent < 2.5,
          f"{spent:.2f}s")
    check("  ... and a wedged table is reported not live, not guessed at",
          all(r["slot"] != 3 for r in fresh)
          and next(r for r in TABLES.registry() if r["slot"] == 3)["live"] is False, str(fresh))
    w5.stop(); live.remove(w5)
    w3 = Wrapper(slot=3); live.append(w3)    # honest again for the fan-out section

    print("\nlive_peers probes NOW — a stale snapshot is a wrong answer for a fan-out")
    be(slot=1, count=2)
    forget()
    TABLES.refresh_presence(1.0)
    before = [p["slot"] for p in TABLES.peers()]
    check("both other tables are up to begin with", before == [2, 3], str(before))
    w2.stop()
    live.remove(w2)
    check("the cached view still shows the table that just died",
          2 in [p["slot"] for p in TABLES.peers()], str(TABLES.peers()))
    check("  ... but live_peers does not", [p["slot"] for p in TABLES.live_peers(0.5)] == [3],
          str([p["slot"] for p in TABLES.live_peers(0.5)]))

    w2 = Wrapper(slot=2); live.append(w2)
    check("a table that comes up is seen at once, without waiting for the TTL",
          [p["slot"] for p in TABLES.live_peers(1.0)] == [2, 3],
          str([p["slot"] for p in TABLES.live_peers(1.0)]))

    print("\nTHE REGRESSION: the leader's fan-out actually reaches the tables")
    import launch  # noqa: E402  (imported late: it is heavy, and only this section needs it)

    be(slot=1, count=4)
    w4.broken = False                        # slot 4 answers properly from here on
    sent = launch._fan_out("/session/join", {"sid": "S1", "config": {"tables": 4, "answers": True}}, timeout=5)
    check("every live table got the join", sorted(r["slot"] for r in sent) == [2, 3, 4],
          str([r.get("slot") for r in sent]))
    for w in (w2, w3, w4):
        check(f"  ... slot {w.slot} has it in hand, with the session id",
              any(p == "/session/join" and b.get("sid") == "S1" for p, b in w.posts), str(w.posts))

    print("\nthe strip shows every DECLARED table, answering or not")
    # The card renderer already says "answers off" and "not answering" — what it
    # never got on 2026-09-21 was a card at all for the table that was silent.
    _state = launch.state
    launch.state = lambda light=False: {"ok": True, "tableSlot": 1, "sessionId": "S1",
                                        "studyAnswers": True, "connected": True, "hand": {}}
    try:
        w2.sid, w3.sid = "S1", None          # slot 2 joined; slot 3 is up with answers off
        w4.stop(); live.remove(w4)           # slot 4 declared but not running at all
        forget()
        TABLES.refresh_presence(1.0)
        view = {c["slot"]: c for c in launch.tables_overview()["tables"]}
        check("four declared tables → four cards", sorted(view) == [1, 2, 3, 4], str(sorted(view)))
        check("the table that joined shows answers ON", view[2]["answersOn"] is True, str(view.get(2)))
        check("the table that did NOT join shows answers OFF — the signal that was missing",
              view[3]["reachable"] is True and view[3]["answersOn"] is False, str(view.get(3)))
        check("the table that never came up is 'not answering', not absent",
              view[4]["reachable"] is False and "not running" in (view[4]["error"] or ""), str(view.get(4)))
    finally:
        launch.state = _state
        w4 = Wrapper(slot=4); live.append(w4)

    # and the shape of the bug itself: presence empty ⇒ fan-out silently does nothing
    for w in (w2, w3, w4):
        w.posts.clear()
    be(slot=None, count=1)
    check("a single-table wrapper fans out to nobody (the old behaviour, deliberate)",
          launch._fan_out("/session/join", {"sid": "S2"}, timeout=5) == [])
    check("  ... and nothing received it", all(not w.posts for w in (w2, w3, w4)))

finally:
    for w in live:
        w.stop()
    TABLES.PANEL_BASE, TABLES.PANEL_STEP = _base
    for k, v in _env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    forget()

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
