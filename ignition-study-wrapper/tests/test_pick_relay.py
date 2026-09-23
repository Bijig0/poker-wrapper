"""Pick → relay, offline: the label mapping and every guard in _pick_ready.

No browser, no table: the reader's state is seeded directly, the relay
functions are stubbed, and each guard is tripped in turn. The rig-side test
(test_pick_relay_rig.py) then proves the same path fires the right control
on the fake table.

Run:  aof-model/.venv/Scripts/python.exe tests/test_pick_relay.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:  # a cp1252 console cannot print the arrows in the labels
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import launch  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


# ------------------------------------------------------------ the mapping
print("_pick_plan")
P = launch._pick_plan
check("Fold", P("Fold") == {"kind": "action", "label": "fold"})
check("FOLD (chain)", P("FOLD") == {"kind": "action", "label": "fold"})
check("Check", P("Check") == {"kind": "action", "label": "check"})
check("Call", P("Call") == {"kind": "action", "label": "call"})
check("Limp → call", P("Limp") == {"kind": "action", "label": "call"})
check("Raise 2.5 (chart)", P("Raise 2.5") == {"kind": "raise-to", "amount": "2.5", "verb": "raise"})
check("RAISE 12 (chain)", P("RAISE 12") == {"kind": "raise-to", "amount": "12", "verb": "raise"})
check("BET 3.35 (chain)", P("BET 3.35") == {"kind": "raise-to", "amount": "3.35", "verb": "bet"})
check("Bet 4.5bb (MES)", P("Bet 4.5bb") == {"kind": "raise-to", "amount": "4.5", "verb": "bet"})
check("Bet 33% with pot 12 → 3.96", P("Bet 33%", 12) == {"kind": "raise-to", "amount": "3.96", "verb": "bet"})
check("Bet 33% without pot → None", P("Bet 33%") is None)
check("Raise (unsized) → press raise", P("Raise") == {"kind": "action", "label": "raise"})
check("Allin", P("Allin") == {"kind": "action", "label": "all-in"})
check("ALL-IN", P("ALL-IN") == {"kind": "action", "label": "all-in"})
check("Jam", P("Jam") == {"kind": "action", "label": "all-in"})
check("garbage → None", P("Sit out") is None)
check("None → None", P(None) is None)


# ------------------------------------------------------------ the guards
print("_pick_ready")


def seed(*, to_act=True, on=True, fresh=True, hand_no=7, key_street="preflop", key_n=3,
         pick="Raise 2.5", key_hand=7, folded=False, executed=None):
    launch._fake_mode = False
    launch._hand_no = hand_no
    launch._hand_ids[hand_no] = "4917000001"
    launch._feed_prev = {"seated": True, "seats": {1: {"stack": "100 BB"}, 2: {"stack": "100 BB"}, 3: {"stack": "100 BB"}}}
    launch._live_status.update({"toAct": to_act, "practice": False, "board": []})
    launch._ws_state.update({
        "bb": 200, "bbSeen": True, "dealt": [1, 2, 3], "heroSeat": 1, "dealer": 1,
        "board": [], "heroCards": ["A♠", "K♦"], "potCents": 300, "maxBet": 200,
        "committed": {2: 100, 3: 200},
        "actions": [{"seat": 2, "type": "post-sb", "cents": 100, "street": "preflop"},
                    {"seat": 3, "type": "post-bb", "cents": 200, "street": "preflop"},
                    {"seat": 2, "type": "call", "cents": 100, "street": "preflop"}],
        "actionOn": 1, "heroFolded": folded, "foldedSeats": set(), "domGraceUntil": 0,
    })
    launch._study.update({
        "on": on, "text": "PREFLOP — Raise 2.5 63% · Fold 37%", "pick": pick, "roll": 41,
        "at": time.time() - (0 if fresh else 10),
        "decisionKey": json.dumps([key_street, [], ["As", "Kd"], 0, key_n]), "handId": key_hand,
        "executed": executed, "auto": False, "autoTried": None, "lastExec": None,
    })


seed()
r = launch._pick_ready()
check("all guards pass", r["ok"] is True, json.dumps(r))
check("plan is raise-to 2.5", r["plan"] == {"kind": "raise-to", "amount": "2.5", "verb": "raise"}, json.dumps(r.get("plan")))

seed(on=False); check("answers off refuses", not launch._pick_ready()["ok"] and "off" in launch._pick_ready()["reason"])
seed(fresh=False); check("stale pick refuses", "stale" in (launch._pick_ready()["reason"] or ""))
seed(to_act=False); check("not hero's turn refuses", "turn" in (launch._pick_ready()["reason"] or ""))
seed(folded=True); check("hero folded refuses", "over" in (launch._pick_ready()["reason"] or ""))
seed(key_hand=6); check("pick for another hand refuses", "hand #6" in (launch._pick_ready()["reason"] or ""))
seed(key_n=2); check("action count moved on refuses", "after 2 actions" in (launch._pick_ready()["reason"] or ""))
seed(key_street="flop"); check("street moved on refuses", "flop" in (launch._pick_ready()["reason"] or ""))
seed(executed="7|" + json.dumps(["preflop", [], ["As", "Kd"], 0, 3])); check("already executed refuses", "already" in (launch._pick_ready()["reason"] or ""))
seed(executed="6|" + json.dumps(["preflop", [], ["As", "Kd"], 0, 3])); check("same spot in a NEW hand is not 'already executed'", launch._pick_ready()["ok"])
seed(pick="Sit out"); check("unmappable pick refuses", "cannot map" in (launch._pick_ready()["reason"] or ""))
seed(); launch._study["decisionKey"] = None; check("no decision key refuses", "decision key" in (launch._pick_ready()["reason"] or ""))


# ------------------------------------------------------------ the executor
print("_execute_pick")
calls: list[tuple] = []
launch.act = lambda label, kind="action": (calls.append(("act", label, kind)), {"ok": True, "clicked": label.upper()})[1]
launch.raise_to = lambda amount, strict=False: (calls.append(("raise_to", amount, strict)), {"ok": True, "typed": amount})[1]

seed(pick="Fold")
res = launch._execute_pick("press")
check("fold pressed through act()", res["ok"] and calls[-1] == ("act", "fold", "action"), json.dumps(res, default=str))
check("executed once — second press refused", not launch._execute_pick("press")["ok"])
check("lastExec recorded", (launch._study["lastExec"] or {}).get("pick") == "Fold")

seed(pick="Raise 2.5")
res = launch._execute_pick("press")
check("sized raise goes through raise_to(strict)", res["ok"] and calls[-1] == ("raise_to", "2.5", True), json.dumps(res, default=str))

seed(pick="Raise 2.5")
launch.raise_to = lambda amount, strict=False: {"ok": False, "reason": "client changed 2.5 to 3 (min/max clamp) — not pressed"}
res = launch._execute_pick("press")
check("clamped raise is refused and not marked executed", not res["ok"] and launch._study["executed"] is None)
check("refusal reason kept for the panel", "clamp" in json.dumps(launch._study["lastExec"]))

# auto mode: refuses to arm off a practice table, fires once on one
print("auto mode")
seed(pick="Call")
launch.act = lambda label, kind="action": (calls.append(("act", label, kind)), {"ok": True})[1]
check("cannot arm on a real-money table", not launch._set_auto(True)["ok"] and launch._study["auto"] is False)
launch._live_status["practice"] = True
check("arms on a practice table", launch._set_auto(True)["ok"] and launch._study["auto"] is True)
n = len(calls)
launch._maybe_auto_act()
check("auto fires the call", len(calls) == n + 1 and calls[-1][1] == "call")
launch._maybe_auto_act()
check("auto does not fire twice for the same decision", len(calls) == n + 1)
launch._live_status["practice"] = False
launch._study["executed"] = None
launch._maybe_auto_act()
check("auto stands down when the table stops being practice", len(calls) == n + 1)

# the REAL-MONEY testing allowance: explicit, bounded, self-disarming
print("real-money allowance")
seed(pick="Call")
launch._live_status["practice"] = False
launch._study.update({"auto": False, "autoRealUntil": 0.0, "autoRealHands": 0, "autoRealFrom": None, "autoRealReason": None})
r = launch._set_auto(True)
check("plain arm on real money still refused", not r["ok"] and "explicit testing allowance" in r["error"])
r = launch._set_auto(True, allow_real=True, minutes=30, hands=50, reason="test")
check("arms with allowRealMoney", r["ok"] and r["auto"] and r["practice"] is False, json.dumps(r, default=str))
a = launch._auto_allowance()
check("allowance is live and bounded", a["live"] and a["handsLeft"] == 50 and 0 < a["minutesLeft"] <= 30, json.dumps(a))
n = len(calls)
launch._maybe_auto_act()
check("auto fires on real money while the allowance is live", len(calls) == n + 1 and calls[-1][1] == "call")

# budgets are clamped, not taken on trust
launch._set_auto(False)
r = launch._set_auto(True, allow_real=True, minutes=9999, hands=9999)
a = launch._auto_allowance()
check("minute budget clamped to 120", a["minutesLeft"] <= 120, json.dumps(a))
check("hand budget clamped to 500", a["handsLeft"] == 500, json.dumps(a))

# time budget runs out -> disarms itself on the next tick
launch._set_auto(False)
launch._set_auto(True, allow_real=True, minutes=30, hands=50)
launch._study["autoRealUntil"] = time.time() - 1
n = len(calls)
launch._maybe_auto_act()
check("expired by TIME: nothing fired", len(calls) == n)
check("expired by TIME: auto disarmed itself", launch._study["auto"] is False)
check("expired by TIME: reason recorded for the panel", "expired" in json.dumps(launch._study["lastExec"]))

# hand budget runs out -> same
seed(pick="Call"); launch._live_status["practice"] = False
launch._set_auto(True, allow_real=True, minutes=30, hands=2)
launch._study["autoRealFrom"] = launch._hand_no - 2      # two hands already used
n = len(calls)
launch._maybe_auto_act()
check("expired by HANDS: nothing fired", len(calls) == n)
check("expired by HANDS: auto disarmed itself", launch._study["auto"] is False)

# disarming clears the allowance outright, and a practice table never needs one
launch._set_auto(True, allow_real=True, minutes=30, hands=50)
launch._set_auto(False)
check("auto off clears the allowance", launch._auto_allowance()["granted"] is False)
launch._live_status["practice"] = True
r = launch._set_auto(True)
check("practice arms with no allowance at all", r["ok"] and r["practice"] and not launch._auto_allowance()["granted"])
launch._set_auto(False)

# DECLARED auto-execute (setup page config.autoExecute) — intent, not bypass
print("declared at setup")


def declare(cfg: dict) -> None:
    """_apply_session_config's auto-execute half, without the rest of it."""
    launch._study.update({"auto": False, "executed": None, "autoTried": None, "lastExec": None,
                          "autoRealUntil": 0.0, "autoRealHands": 0, "autoRealFrom": None, "autoRealReason": None,
                          "autoDeclared": bool(cfg.get("autoExecute")),
                          "autoDeclaredReal": bool(cfg.get("autoRealMoney")),
                          "autoDeclaredBudget": dict(cfg.get("autoBudget") or {"minutes": 30, "hands": 50})})
    if launch._study["autoDeclared"]:
        b = launch._study["autoDeclaredBudget"]
        launch._set_auto(True, allow_real=launch._study["autoDeclaredReal"],
                         minutes=b.get("minutes") or 30, hands=b.get("hands") or 50, reason="declared at session setup")


# declared, practice table -> armed, no allowance needed
seed(pick="Call"); launch._live_status["practice"] = True
declare({"autoExecute": True})
check("declared + practice arms at start", launch._study["auto"] and not launch._auto_allowance()["granted"])

# declared without the real-money box, real table -> NOT armed, stays pending
seed(pick="Call"); launch._live_status["practice"] = False
declare({"autoExecute": True})
check("declared + real money WITHOUT the box does not arm", launch._study["auto"] is False)
check("  ... but the declaration is still pending", launch._study["autoDeclared"] is True)
n = len(calls); launch._maybe_auto_act()
check("  ... and nothing fires while pending", len(calls) == n)
# a practice table appearing arms it
launch._live_status["practice"] = True
launch._maybe_auto_arm()
check("pending declaration arms when a practice table appears", launch._study["auto"] is True)

# declared WITH the real-money box -> armed at start, bounded
seed(pick="Call"); launch._live_status["practice"] = False
declare({"autoExecute": True, "autoRealMoney": True, "autoBudget": {"minutes": 10, "hands": 5}})
a = launch._auto_allowance()
check("declared + allowRealMoney arms bounded", launch._study["auto"] and a["live"] and a["handsLeft"] == 5, json.dumps(a))
check("  ... budget comes from the declaration", a["minutesLeft"] <= 10)

# the LIVE toggle beats the declaration, and is not undone on the next tick
launch._set_auto(False)
check("live off disarms", launch._study["auto"] is False)
check("live off clears the declaration", launch._study["autoDeclared"] is False)
launch._maybe_auto_arm()
check("live off is NOT re-armed by the declaration", launch._study["auto"] is False)

# an allowance that ran out is not silently re-granted by the declaration
seed(pick="Call"); launch._live_status["practice"] = False
declare({"autoExecute": True, "autoRealMoney": True, "autoBudget": {"minutes": 10, "hands": 5}})
launch._study["autoRealUntil"] = time.time() - 1
launch._maybe_auto_act()          # notices the expiry, disarms
check("expired allowance disarms even when declared", launch._study["auto"] is False)
launch._maybe_auto_arm()
check("expired allowance is not re-granted by the declaration", launch._study["auto"] is False)

# declared OFF is the default and arms nothing
seed(pick="Call"); launch._live_status["practice"] = True
declare({})
check("no declaration arms nothing", launch._study["auto"] is False and launch._study["autoDeclared"] is False)
launch._maybe_auto_arm()
check("  ... and stays off", launch._study["auto"] is False)

# ------------------------------------------------------------ told vs did
# A press reports "ok" when the click dispatches; what the TABLE did is a separate
# question, and until 2026-09-19 nothing asked it. Hand 4919212912: typed 10.5, read
# back 10.5, the client reset the field, the click confirmed its 4 bb minimum, and the
# session recorded a clean success.
print("_did_as_told")
D = launch._did_as_told
R105 = {"kind": "raise-to", "amount": "10.5", "verb": "raise"}
check("raise-to confirmed on the level it reached", D(R105, {"type": "raise", "amount": 10.5}, 100) is True)
check("  ... tolerates the client's snapping", D(R105, {"type": "raise", "amount": 10.0}, 100) is True)
check("  ... a min-raise clamp is a DIVERGENCE", D(R105, {"type": "raise", "amount": 4.0}, 100) is False)
check("  ... so is the wrong verb", D(R105, {"type": "call", "amount": 10.5}, 100) is False)
check("  ... no amount is unknown, not wrong", D(R105, {"type": "raise"}, 100) is None)
F = {"kind": "action", "label": "fold"}
check("fold confirmed by a fold", D(F, {"type": "fold"}, 100) is True)
check("fold not confirmed by a check", D(F, {"type": "check"}, 100) is False)
C = {"kind": "action", "label": "call"}
check("call confirmed by a call", D(C, {"type": "call", "amount": 3}, 100) is True)
check("call confirmed by a short all-in", D(C, {"type": "all-in", "amount": 12}, 100) is True)
A = {"kind": "action", "label": "all-in"}
check("all-in confirmed by an all-in", D(A, {"type": "all-in"}, 86) is True)
check("all-in confirmed by a raise for the stack", D(A, {"type": "raise", "amount": 86.0}, 86) is True)
check("all-in DIVERGES on a part-stack raise", D(A, {"type": "raise", "amount": 10.5}, 86) is False)

print("_maybe_verify_exec")


def hero_acted(kind, cents=None):
    """Append hero's action to the reader's log, as the WS tap would."""
    a = {"seat": 1, "type": kind, "street": "preflop"}
    if cents is not None:
        a["cents"] = cents
    launch._ws_state["actions"].append(a)


def sent(pick):
    launch.act = lambda label, kind="action": (calls.append(("act", label, kind)), {"ok": True})[1]
    launch.raise_to = lambda amount, strict=False: (calls.append(("raise_to", amount, strict)), {"ok": True})[1]
    seed(pick=pick)
    return launch._execute_pick("press")


res = sent("Fold")
check("a sent press leaves a pending outcome", res["outcome"] == "pending" and launch._study["pendingExec"],
      json.dumps(res, default=str))
check("  ... pinned to hero's action index", (launch._study["pendingExec"] or {}).get("kN") == 3)
launch._maybe_verify_exec()
check("  ... nothing to say while the table has not moved", launch._study["pendingExec"] is not None)
hero_acted("fold")
launch._maybe_verify_exec()
check("fold that lands is CONFIRMED", (launch._study["lastExec"] or {}).get("outcome") == "confirmed"
      and launch._study["pendingExec"] is None, json.dumps(launch._study.get("lastExec"), default=str))

n_feed = len(launch._feed)
sent("Raise 10.5")
hero_acted("raise", 800)          # the client's 4 bb minimum, not the 10.5 that was typed
launch._maybe_verify_exec()
check("a size is not judged on one sighting", (launch._study.get("pendingExec") or {}).get("seen") is not None
      and (launch._study["lastExec"] or {}).get("outcome") == "pending")
launch._maybe_verify_exec()       # the same number twice: now it means something
rec = launch._study["lastExec"] or {}
check("a clamped raise is DIVERGED, not success", rec.get("outcome") == "diverged", json.dumps(rec, default=str))
check("  ... and the feed says what the table actually took",
      any("MIS-EXECUTED" in str(l) for l in launch._feed[n_feed:]), str(launch._feed[n_feed:]))

# THE FALSE ACCUSATION THIS PREVENTS (hand 4919236052): the client shows the chips ADDED
# before the new total, so a raise to 9.2 from 2.5 reads "6.7" for one tick. Judged there,
# a perfectly correct press is reported as MIS-EXECUTED.
n_feed = len(launch._feed)
sent("Raise 9.2")
launch._ws_state["actions"].append({"seat": 1, "type": "raise", "cents": 1340, "street": "preflop"})  # 6.7 bb at bb=200
launch._maybe_verify_exec()       # 6.7 — the increment, mid-animation
check("the mid-animation increment is not a verdict", (launch._study["lastExec"] or {}).get("outcome") == "pending")
launch._ws_state["actions"][-1]["cents"] = 1840     # settles to 9.2 bb, the total
launch._maybe_verify_exec()
launch._maybe_verify_exec()
rec = launch._study["lastExec"] or {}
check("  ... and the settled total CONFIRMS the press", rec.get("outcome") == "confirmed", json.dumps(rec, default=str))
check("  ... with nothing alarming in the feed",
      not any("MIS-EXECUTED" in str(l) for l in launch._feed[n_feed:]), str(launch._feed[n_feed:]))

# nothing lands: retry, but only on proof that nothing landed
calls.clear()
sent("Fold")
launch._study["pendingExec"]["deadline"] = time.time() - 1
launch._maybe_verify_exec()
check("a press that never registered is RETRIED", len(calls) == 2 and calls[-1] == ("act", "fold", "action"),
      json.dumps(calls, default=str))
check("  ... still pending after the retry", (launch._study["pendingExec"] or {}).get("attempts") == 2)
launch._study["pendingExec"]["deadline"] = time.time() - 1
launch._maybe_verify_exec()
check("  ... and gives up rather than pressing a third time",
      len(calls) == 2 and (launch._study["lastExec"] or {}).get("outcome") == "unknown",
      json.dumps({"calls": calls, "rec": launch._study.get("lastExec")}, default=str))

# the spot moved on: never press again
calls.clear()
sent("Fold")
launch._study["pendingExec"]["deadline"] = time.time() - 1
launch._live_status["toAct"] = False          # hero is no longer on the clock
launch._maybe_verify_exec()
check("no retry once the spot is no longer hero's", len(calls) == 1
      and (launch._study["lastExec"] or {}).get("outcome") == "abandoned",
      json.dumps(launch._study.get("lastExec"), default=str))

calls.clear()
sent("Fold")
launch._hand_no = 8                            # the table dealt the next hand
launch._maybe_verify_exec()
check("no retry once the hand moved on", len(calls) == 1
      and (launch._study["lastExec"] or {}).get("outcome") == "unknown",
      json.dumps(launch._study.get("lastExec"), default=str))

# ------------------------------------------------------------ the shove fallback
# Facing a raise the client often shows FOLD / CALL / RAISE TO and keeps the shove in
# the SIZING row (session 125204 hand 33: the relay refused and hero shoved by hand).
print("_actuate_all_in")
offered = set()
launch.act = lambda label, kind="action": (
    calls.append(("act", label, kind)),
    {"ok": True, "clicked": label.upper()} if f"{kind}:{label}" in offered
    else {"ok": False, "reason": f"'{label}' not on offer ({kind})"})[1]

calls.clear(); offered = {"action:all-in"}
check("shoves on the action button when there is one", launch._actuate_all_in().get("ok") is True)
calls.clear(); offered = {"preset:all-in", "action:raise"}
r = launch._actuate_all_in()
check("falls back to the sizing row + RAISE", r.get("ok") is True and ("act", "raise", "action") in calls,
      json.dumps(calls, default=str))
calls.clear(); offered = {"preset:all-in", "action:bet"}
check("  ... or BET when the client offers that instead", launch._actuate_all_in().get("ok") is True)
calls.clear(); offered = set()
r = launch._actuate_all_in()
check("refuses when neither row offers a shove", r.get("ok") is False and "not on offer" in r.get("reason", ""))
calls.clear(); offered = {"preset:all-in"}
r = launch._actuate_all_in()
check("refuses rather than leaving a size set with nothing confirming it",
      r.get("ok") is False and "confirm" in r.get("reason", ""), json.dumps(r, default=str))

# ------------------------------------------------------------ the top-up gate
# The presses run on their own thread seconds after the decision to make them; session
# 125204 hand 8 opened the Buy-chips panel into hero's turn.
print("_top_up_gate")
launch._feed_prev = {"seated": True, "waiting": False, "toAct": False}
launch._live_status.update({"toAct": False, "modal": None})
launch._ws_state["heroFolded"] = True
launch._hand_no = 8
check("between hands, hero folded — safe", launch._top_up_gate()[0] is True)
launch._live_status["toAct"] = True
check("hero on the clock — NOT safe", launch._top_up_gate() == (False, "hero is on the clock"))
launch._live_status["toAct"] = False
launch._ws_state["heroFolded"] = False
launch._ws_state["handOver"] = False
check("a hand live for hero — NOT safe", launch._top_up_gate()[0] is False)
launch._ws_state["handOver"] = True
launch._study["stackStable"] = {"text": "95.0 BB", "ticks": 0}
check("the hand over but the award still landing — NOT safe", launch._top_up_gate()[0] is False)
# hero played to the end: his stack has to stop moving before it means anything (the
# three windows and every block are covered in full by tests/test_topup_window.py)
launch._study["stackStable"] = {"text": "95.0 BB", "ticks": 9}
check("the hand being over is enough, folded or not", launch._top_up_gate()[0] is True)
launch._live_status["modal"] = {"harmless": True}
check("a notice over the strip — NOT safe", launch._top_up_gate()[0] is False)
launch._live_status["modal"] = None
# THE HAND NUMBER IS NOT A DANGER (2026-09-19): 41% of between-hand windows are shorter
# than a full run, so aborting on the deal abandoned the panel as often as it protected
# anything. A run that has started finishes; the chips land at the next hand regardless.
launch._hand_no = 99
check("the table moving on does NOT stop a run", launch._top_up_gate()[0] is True)
launch._ws_state["heroFolded"] = True


print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
