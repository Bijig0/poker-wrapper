"""Top up before ANY terminal action, and the reader rules the 2026-09-23 hardening pass added.

    aof-model/.venv/Scripts/python.exe tests/test_terminal_topup.py

Pure: launch.py's functions against seeded module state, with the client (act / _top_up_read /
_maybe_take_time / sessions) stubbed. What is pinned:

  * the pre-action run starts for every TERMINAL pick (fold, shove, all-in call, the river call or check
    that closes the action) and for nothing else — and records which kind, and whether the amount is exact
  * auto-execute HOLDS while the run is active (the press used to race the panel render — TU-06)
  * `banked` is the time-bank PRESS RESULT, not the button's presence (TU-07); the budget follows the grant
  * a press still pending a receipt blocks a second buy (TU-09); a REFUSED press does not (TU-10)
  * the refusal notice files its own event against the press and marks it refused
  * sessions.event: the event's own kind and time win over a payload's
  * _reconciled_line never drops a hero action the client reported (the five fold→check hands)
  * the archive refuses a hand hero was not dealt into and a client hand id already on file
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import launch  # noqa: E402
import sessions as S  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


# ---- a table hero is on the clock at, with a pick ready --------------------------------------------------
def seed(pick: str, hand: dict, *, auto=True, to_act=True):
    launch._fake_mode = False
    launch._session["id"] = "session_test"
    launch._study.update({"on": True, "auto": auto, "topUp": True, "text": pick, "pick": pick, "at": time.time(),
                          "decisionKey": json.dumps([hand["street"], hand["board"], hand["heroCards"],
                                                     hand["currentNode"]["toCall"], len(hand["actions"])]),
                          "handId": hand["handId"], "executed": None, "uncertain": None, "topUpHand": None,
                          "lastTopUp": None, "autoTried": None, "autoDue": None, "autoHeld": None, "timeBank": True,
                          "timeBankAt": 0.0, "autoNotFired": None, "autoDelay": "instant"})
    launch._topup_prefold.update({"active": False, "key": None, "hand": None, "deadline": 0.0, "startedAt": 0.0, "banked": False})
    launch._topup_abort.clear()
    launch._topup_panel.update({"open": False, "lastCloseAt": 0.0, "domTicks": 0})
    launch._live_status.clear()
    launch._live_status.update({"hero": "in-hand", "toAct": to_act, "practice": True, "modal": None, "buyPanel": False, "timeBank": None})
    launch._feed_prev.clear()
    launch._feed_prev.update({"seated": True, "waiting": False, "toAct": to_act})
    launch._hand_no = hand["handId"]
    launch._hand_ids[hand["handId"]] = f"cid-{hand['handId']}"
    launch._hand_state = lambda: hand
    launch._top_up_read = lambda: {"seated": True, "stackCents": 17000, "maxCents": 20000, "bbCents": 200, "zone": False, "panelOpen": False}


def hand(street="river", hero=4, dealt=(3, 4), actions=(), to_call=6.0, stacks=None):
    acts = []
    for a in actions:
        rec = {"seatId": a[0], "hero": a[0] == hero, "type": a[1], "street": a[3] if len(a) > 3 else street}
        if len(a) > 2 and a[2] is not None:
            rec["amount"] = a[2]
        acts.append(rec)
    return {"handId": 7, "heroSeatId": hero, "heroCards": ["A♠", "K♠"], "board": ["2♣", "7♦", "9♥", "T♠", "3♣"][: {"preflop": 0, "flop": 3, "turn": 4, "river": 5}[street]],
            "street": street, "actions": acts, "liveSeats": sorted(dealt), "committed": {}, "positions": {str(s): "X" for s in dealt},
            "stacks": stacks or {str(s): 100.0 for s in dealt},
            "currentNode": {"street": street, "toActSeatId": hero, "toActIsHero": True, "pot": 20.0, "toCall": to_call},
            "heroFolded": False, "ended": False}


started: list[dict] = []
events: list[tuple] = []
launch.threading.Thread = lambda *a, **k: type("T", (), {"start": lambda self: started.append(dict(k))})()  # type: ignore
launch._sessions.event = lambda sid, kind, data=None: events.append((kind, data or {}))
launch._maybe_take_time = lambda: None
REAL_ACT = launch.act          # the relay itself, for the guard checks below
launch.act = lambda *a, **k: {"ok": True}

print("which picks start a pre-action run")
cases = [
    ("FOLD", hand(street="flop", actions=[(3, "bet", 6.0)], to_call=6.0), True, "fold"),
    ("CALL 6", hand(street="river", actions=[(3, "bet", 6.0)], to_call=6.0), True, "closing-river-call"),
    ("CHECK", hand(street="river", actions=[(3, "check", None)], to_call=0.0), True, "closing-river-check"),
    ("ALL-IN", hand(street="turn", actions=[(3, "bet", 6.0)], to_call=6.0), True, "shove"),
    ("CALL 60", hand(street="flop", actions=[(3, "bet", 60.0)], to_call=60.0, stacks={"3": 40.0, "4": 55.0}), True, "all-in-call"),
    ("CALL 6", hand(street="flop", actions=[(3, "bet", 6.0)], to_call=6.0), False, None),
    ("CHECK", hand(street="turn", actions=[(3, "check", None)], to_call=0.0), False, None),
    ("RAISE 12", hand(street="river", actions=[(3, "bet", 6.0)], to_call=6.0), False, None),
    ("CALL 6", hand(street="river", dealt=(1, 3, 4), actions=[(3, "bet", 6.0)], to_call=6.0), False, None),   # seat 1 still to act
]
for pick, h, want, kind in cases:
    started.clear(); events.clear()
    seed(pick, h)
    launch._maybe_prefold_top_up()
    got = bool(started)
    check(f"{pick:<8} on the {h['street']:<7} → {'run' if want else 'no run'}", got is want, f"started={got}")
    if want and got:
        ev = next((d for k, d in events if k == "top-up-prefold"), {})
        check(f"    …event names the kind {kind}", ev.get("terminalKind") == kind and launch._topup_prefold["kind"] == kind, str(ev))
        check("    …finalStackKnown only for the fold", ev.get("finalStackKnown") is (kind == "fold"), str(ev.get("finalStackKnown")))
        check("    …the run took the lock", launch._topup_lock.locked())
        if launch._topup_lock.locked():
            launch._topup_lock.release()

print("\nauto-execute holds while the run is active (TU-06)")
started.clear(); events.clear()
seed("FOLD", hand(street="flop", actions=[(3, "bet", 6.0)], to_call=6.0))
launch._maybe_prefold_top_up()
if launch._topup_lock.locked():
    launch._topup_lock.release()
executed: list = []
launch._execute_pick = lambda *a, **k: executed.append(a) or {"ok": True}
launch._maybe_auto_act()
held = next((d for k, d in events if k == "study-auto-held"), None)
check("the same tick's auto press is HELD, not fired", not executed and held is not None and "pre-action" in held.get("why", ""), f"executed={executed} held={held}")
launch._topup_prefold["active"] = False
launch._maybe_auto_act()
check("the run's finally releases the hold: the press fires", bool(executed))

print("\nbanked follows the PRESS, not the button (TU-07)")
started.clear(); events.clear()
seed("FOLD", hand(street="flop", actions=[(3, "bet", 6.0)], to_call=6.0))
launch._live_status["timeBank"] = {"text": "+16s"}
launch._maybe_take_time = lambda: None          # cooldown / refused: nothing pressed
launch._maybe_prefold_top_up()
ev = next((d for k, d in events if k == "top-up-prefold"), {})
check("button visible but not pressed → banked False, base budget", ev.get("timeBank") is False and ev.get("budgetS") == launch.TOP_UP_PREFOLD_BUDGET_S, str(ev))
if launch._topup_lock.locked():
    launch._topup_lock.release()
started.clear(); events.clear()
seed("FOLD", hand(street="flop", actions=[(3, "bet", 6.0)], to_call=6.0))
launch._live_status["timeBank"] = {"text": "+16s"}
launch._maybe_take_time = lambda: {"ok": True, "label": "+16s"}
launch._maybe_prefold_top_up()
ev = next((d for k, d in events if k == "top-up-prefold"), {})
check("+16s granted → banked True, budget grows by the grant, never the +45s budget",
      ev.get("timeBank") is True and launch.TOP_UP_PREFOLD_BUDGET_S < ev.get("budgetS", 0) < launch.TOP_UP_PREFOLD_BANKED_S, str(ev))
if launch._topup_lock.locked():
    launch._topup_lock.release()

print("\na pending press blocks a second buy; a refused one does not (TU-09 / TU-10)")
started.clear(); events.clear()
seed("FOLD", hand(street="flop", actions=[(3, "bet", 6.0)], to_call=6.0))
launch._study["lastTopUp"] = {"pressed": True, "receiptCents": None, "at": int(time.time() * 1000) - 5000, "amountCents": 3000}
launch._maybe_prefold_top_up()
check("press awaiting its receipt → no pre-action run", not started)
launch._study["lastTopUp"]["refused"] = True
launch._maybe_prefold_top_up()
check("the same press marked REFUSED → the run starts", bool(started))
if launch._topup_lock.locked():
    launch._topup_lock.release()

print("\nthe refusal notice is filed against the press")
events.clear()
launch._study["lastTopUp"] = {"pressed": True, "receiptCents": None, "at": int(time.time() * 1000) - 4000, "amountCents": 3000, "trigger": "pre-action", "terminalKind": "closing-river-call"}
launch._note_top_up_refusal({"harmless": "buy-in above the table maximum", "text": "The amount you entered is more than the maximum buy in amount allowed for this table."})
rec = launch._study["lastTopUp"]
ev = next((d for k, d in events if k == "top-up-refused-over-max"), None)
check("record marked refused, not ok", rec.get("refused") is True and rec.get("ok") is False)
check("one top-up-refused-over-max event with the press's kind", ev is not None and ev.get("terminalKind") == "closing-river-call", str(ev))
events.clear()
launch._note_top_up_refusal({"harmless": "buy-in above the table maximum", "text": "…"})
check("a second notice for the same press files nothing more", not events)
launch._note_top_up_refusal({"harmless": None, "text": "Are you sure you want to leave this table?"})
check("an unknown notice is not a refusal", not events)

print("\nsessions.event: the event's kind and time win over the payload's")
tmp = Path(tempfile.mkdtemp(prefix="sess-"))
store = S.SessionStore(tmp / "sessions.sqlite")
if store is None:
    print("  (skip: sessions store class not found by that name)")
else:
    rec = store.start("session_test_events", "p", None, None, {}, {}, {})
    sid = (rec or {}).get("id") if isinstance(rec, dict) else None
    if not sid:
        print("  (skip: could not create a session in the temp store)")
    else:
        store.event(sid, "state-check", {"kind": "request-without-buttons", "at": "seated", "detail": "x"})
        evs = store.get(sid)["events"]
        e = evs[-1]
        check("kind is the event's", e["kind"] == "state-check", str(e))
        check("the payload's colliding keys survive under a prefix", e.get("payload_kind") == "request-without-buttons" and e.get("payload_at") == "seated", str(e))
        check("at is a timestamp", isinstance(e["at"], int))

print("\n_reconciled_line never drops a hero action the client reported")


class FakeRC:
    armed = True
    bbs = 5
    C = {4: 0.0}
    max_bet = 6.0
    violations: list = []

    def __init__(self, line):
        self._line = line

    def line(self):
        return self._line

    def faults(self, street):
        return []


old = [{"seatId": 3, "hero": False, "type": "post-sb", "street": "preflop", "amount": 0.5},
       {"seatId": 4, "hero": True, "type": "post-bb", "street": "preflop", "amount": 1.0},
       {"seatId": 3, "hero": False, "type": "bet", "street": "turn", "amount": 4.3},
       {"seatId": 4, "hero": True, "type": "fold", "street": "turn"}]
derived = [{"seat": 3, "type": "post-sb", "street": "preflop", "amount": 0.5}, {"seat": 4, "type": "post-bb", "street": "preflop", "amount": 1.0},
           {"seat": 3, "type": "bet", "street": "turn", "amount": 4.3}, {"seat": 4, "type": "check", "street": "turn"}, {"seat": 3, "type": "fold", "street": "river"}]
launch._shadow.update({"hand": 7, "rc": FakeRC(derived)})
launch._hand_no = 7
launch._ws_state["dealt"] = [3, 4]
acts, ledger, unc, note, src = launch._reconciled_line(old, 4, "turn")
check("hero's WS fold is missing from the derived line → the event line is kept", src == "ws" and acts == old and "hero's own reported action" in (note or ""), f"{src} {note}")
derived2 = [{"seat": 3, "type": "post-sb", "street": "preflop", "amount": 0.5}, {"seat": 4, "type": "post-bb", "street": "preflop", "amount": 1.0},
            {"seat": 3, "type": "bet", "street": "turn", "amount": 4.3}, {"seat": 4, "type": "fold", "street": "turn"}, {"seat": 4, "type": "check", "street": "flop"}]
launch._shadow.update({"hand": 7, "rc": FakeRC(derived2)})
acts, ledger, unc, note, src = launch._reconciled_line(old, 4, "turn")
check("the reconciler ADDING a hero check the WS missed is still taken", src == "reconciled", f"{src} {note}")

print("\nthe archive refuses hands hero was not dealt into, and duplicates across processes")
data_dir = Path(tempfile.mkdtemp(prefix="hands-"))
launch.DATA_DIR = data_dir
launch._hand_state = launch._hand_state_ignition
launch._ws_state.update({"heroSeat": 2, "dealt": [1, 2, 3], "heroDealt": False, "dealer": 3, "bb": 200, "bbSeen": True,
                         "actions": [{"seat": 1, "type": "post-sb", "cents": 100, "street": "preflop"}, {"seat": 2, "type": "post-bb", "cents": 200, "street": "preflop"}],
                         "committed": {}, "board": [], "heroCards": []})
launch._hand_no = 9
launch._hand_ids[9] = "cid-9"
check("_hand_state is None when the deal frame showed no face-up seat", launch._hand_state_ignition() is None)
launch._ws_state["heroDealt"] = True
launch._ws_state["heroCards"] = ["A♠", "K♠"]
launch._feed_prev.update({"seated": True, "seats": {}})
h = launch._hand_state_ignition()
check("…and exports again once hero's cards are seen", h is not None and h["heroCards"] == ["A♠", "K♠"], str(h and h["heroCards"]))
launch._last_archived.update({"no": 0, "fp": None, "body": None})
launch._archive_hand_locked()
c = sqlite3.connect(data_dir / "hands.db")
n1 = c.execute("select count(*) from hands").fetchone()[0]
check("the hand is archived once", n1 == 1, str(n1))
launch._hand_no = 10
launch._hand_ids[10] = "cid-9"      # another wrapper on the same table filed the same client hand
launch._last_archived.update({"no": 0, "fp": None, "body": None})
launch._archive_hand_locked()
n2 = c.execute("select count(*) from hands").fetchone()[0]
check("a client hand id already on file is not archived again", n2 == 1, str(n2))
launch._hand_no = 11
launch._hand_ids[11] = "cid-11"
launch._ws_state["heroDealt"] = False
launch._archive_hand_locked()
n3 = c.execute("select count(*) from hands").fetchone()[0]
check("a hand hero was not dealt into is not archived", n3 == 1, str(n3))

print("\nthe showdown-pending window opens once hero's part is over")
seed("CHECK", hand(street="river", actions=[(4, "bet", 6.0), (3, "call", 6.0)], to_call=0.0), to_act=False)
launch._ws_state.update({"heroFolded": False, "handOver": False})
launch._live_status["toAct"] = False
ok, trig, why = launch._top_up_window()
check("river bet called, hand not over → window open, trigger names the showdown", ok and (trig or "").startswith("showdown"), f"{ok} {trig} {why}")
seed("CHECK", hand(street="river", actions=[(4, "bet", 6.0)], to_call=0.0), to_act=False)
launch._ws_state.update({"heroFolded": False, "handOver": False})
ok, trig, why = launch._top_up_window()
check("river bet unanswered → still 'a hand is live for hero'", not ok and why == "a hand is live for hero", f"{ok} {trig} {why}")
seed("CHECK", hand(street="turn", actions=[(4, "bet", 6.0), (3, "call", 6.0)], to_call=0.0), to_act=False)
launch._ws_state.update({"heroFolded": False, "handOver": False})
ok, trig, why = launch._top_up_window()
check("turn bet called → no window (the river is still to come)", not ok, f"{ok} {trig} {why}")

print("\nrelay guards (EVM-03 / EVM-15 / EVM-08 / EVM-12)")
seed("CALL 6", hand(street="river", actions=[(3, "bet", 6.0)], to_call=6.0))
launch._live_status["buyPanel"] = True
r = launch._pick_ready()
check("a manual/any pick is refused while the Buy-chips panel is over the strip", not r["ok"] and "Buy-chips" in (r["reason"] or ""), str(r["reason"]))
launch._live_status["buyPanel"] = False
snapshot = {"seated": True, "buttons": [{"text": "FOLD", "qa": "foldButton", "x": 10, "y": 500, "w": 80, "h": 30, "row": 0},
                                        {"text": "OK", "qa": "modal.action.ok", "x": 400, "y": 300, "w": 80, "h": 30}],
            "nodes": [{"text": "The amount you entered is more than the maximum buy in amount allowed for this table.", "x": 300, "y": 200, "w": 300, "h": 20}],
            "frame": {"x": 0, "y": 0, "w": 900, "h": 700}}
launch.ignition_target = lambda: {"webSocketDebuggerUrl": "ws://stub"}
launch.cdp._eval = lambda *a, **k: snapshot
launch._split_strip = lambda d: ([b for b in d["buttons"] if b["qa"] == "foldButton"], [])
res = REAL_ACT("fold", "action")
check("act() refuses an action when its own fresh read shows a notice over the strip", not res.get("ok") and "notice" in (res.get("reason") or ""), str(res))
D = launch._did_as_told
check("an unsized Raise pick is confirmed by a raise", D({"kind": "action", "label": "raise"}, {"type": "raise", "amount": 5.0}, 100) is True)
check("an unsized Bet pick is confirmed by a bet", D({"kind": "action", "label": "bet"}, {"type": "bet", "amount": 5.0}, 100) is True)
check("an unsized Bet pick is NOT confirmed by a check", D({"kind": "action", "label": "bet"}, {"type": "check"}, 100) is False)
check("all-in judged on the stack at send: a landed 86bb shove is confirmed even though 0 is behind now",
      D({"kind": "action", "label": "all-in"}, {"type": "raise", "amount": 86.0}, 86.0) is True)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("all clean")
