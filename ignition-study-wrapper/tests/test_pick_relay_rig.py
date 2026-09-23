"""Pick → relay on the TEST RIG: the pick fires the right control on the fake
table, the typed size reaches the client's bet field, a clamped size is
refused, a stale/wrong-hand pick is refused, and the auto mode fires once.

Plays the poller's part itself (POST /panel/answer with the pick + decision
key), so it needs no GTO Wizard — only the test rig (Study Tool, :7701).

Run:  aof-model/.venv/Scripts/python.exe tests/test_pick_relay_rig.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
BASE = os.environ.get("WRAPPER_URL", "http://127.0.0.1:7701")
FAILS: list[str] = []


def req(path: str, body: dict | None = None, timeout: float = 15) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method="POST" if data is not None else "GET",
                               headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            return json.loads(f.read() or b"{}")
    except urllib.error.HTTPError as e:  # 409s carry a JSON body; 404/500 carry text
        raw = e.read() or b"{}"
        try:
            return json.loads(raw)
        except ValueError:
            return {"ok": False, "error": f"HTTP {e.code}: {raw[:200]!r}"}


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + str(detail)[:300]) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


def load(fixture: str) -> dict:
    """Load a fixture spot; the feed loop needs a beat to read the new page."""
    fx = json.loads((FIXTURES / fixture).read_text(encoding="utf-8"))
    r = req("/faketable/load", fx["spec"])
    assert r.get("ok"), r
    time.sleep(1.6)
    h = req("/hand")["hand"]
    assert h, "no hand exported"
    return h


def push(pick: str, hand: dict, *, hand_id: int | None = None, street: str | None = None, n: int | None = None) -> None:
    key = json.dumps([street or hand["street"], hand["board"], hand["heroCards"], hand["currentNode"]["toCall"],
                      n if n is not None else len(hand["actions"])])
    req("/panel/answer", {"text": f"{hand['street'].upper()} — {pick} 100%", "pick": pick, "roll": None,
                          "decisionKey": key, "handId": hand_id if hand_id is not None else hand["handId"]})


def lastclick() -> dict | None:
    return req("/faketable/lastclick").get("click")


def wait_state(pred, secs: float = 3.0):
    end = time.time() + secs
    s = None
    while time.time() < end:
        s = req("/state?light=1")
        if pred(s):
            return s
        time.sleep(0.25)
    return s


st = req("/state?light=1")
# `fakeRig` is the launcher's --fake flag, not the current mode: run_state_suite ends with
# /faketable/stop, and this test used to refuse to run at all when it ran second.
if not (st.get("fakeRig") or st.get("fakeTable")):
    print(f"{BASE} is not the test rig (fakeRig false) — start the Study Tool (:7701) and rerun")
    sys.exit(2)
req("/study-answers", {"on": True, "mode": "chart"})
req("/study-auto", {"auto": False})

# ---- 0. told vs did, on the live loop ---------------------------------------
# The fixture reproduces session 125204 hand 32: the client takes the typed size back as
# the click lands, so the readback passes and the wrong size goes in. Nothing on the fake
# table ever plays hero's action, so the postcondition can never be met — which is the
# point. The press must end UNCONFIRMED after one retry, not be recorded as a success.
print("told vs did (the verify loop on the feed loop)")
h = load("preflop-hero-3bet-field-reset.json")   # FOLD / CALL 2 / RAISE TO 4, field resets to 4
push("Raise 10.5", h)
s = wait_state(lambda s: (s.get("pickReady") or {}).get("ok"))
check("pickReady for the sized raise", (s.get("pickReady") or {}).get("ok") is True, json.dumps(s.get("pickReady")))
r = req("/act/pick", {})
check("/act/pick sends the raise", r.get("ok") is True, json.dumps(r, default=str))
check("  ... and it is PENDING, not done", r.get("outcome") == "pending", json.dumps(r, default=str))
c = lastclick()
check("  ... the client confirmed its own 4, not the typed 10.5", str((c or {}).get("betValue")) == "4", json.dumps(c))
s = wait_state(lambda s: (s.get("lastExec") or {}).get("outcome") not in (None, "pending"), secs=15)
ex = s.get("lastExec") or {}
check("an unconfirmed press ends UNKNOWN, never 'executed'", ex.get("outcome") == "unknown", json.dumps(ex, default=str))
check("  ... after exactly one retry", ex.get("attempts") == 2, json.dumps(ex, default=str))

# ---- 1. fold: the pick button fires the client's fold control ----------------
print("press → fold")
h = load("flop-hero-facing-bet.json")          # offers FOLD / CALL 24.8 / RAISE TO 60
push("Fold", h)
s = wait_state(lambda s: (s.get("pickReady") or {}).get("ok"))
check("pickReady after the push", (s.get("pickReady") or {}).get("ok") is True, json.dumps(s.get("pickReady")))
check("state says practice table", s.get("practice") is True)
r = req("/act/pick", {})
check("/act/pick ok", r.get("ok") is True, json.dumps(r, default=str))
c = lastclick()
check("foldButton fired", (c or {}).get("qa") == "foldButton", json.dumps(c))
r2 = req("/act/pick", {})
check("second press refused (already executed)", not r2.get("ok") and "already" in (r2.get("reason") or ""), json.dumps(r2))
check("lastExec on /state", ((req("/state?light=1").get("lastExec") or {}).get("pick")) == "Fold")

# ---- 2. sized raise: typed into the bet field, then RAISE TO ----------------
print("press → raise to 70")
h = load("flop-hero-facing-bet.json")
push("Raise 70", h)
wait_state(lambda s: (s.get("pickReady") or {}).get("ok"))
r = req("/act/pick", {})
check("/act/pick ok", r.get("ok") is True, json.dumps(r, default=str))
c = lastclick()
check("raiseButton fired", (c or {}).get("qa") == "raiseButton", json.dumps(c))
check("bet field held 70 at the press", str((c or {}).get("betValue")) in ("70", "70.0"), json.dumps(c))

# ---- 3. a size the client clamps is refused, nothing pressed ------------------
print("press → raise to 30 (below the 60 minimum)")
h = load("flop-hero-facing-bet.json")
before = lastclick()
push("Raise 30", h)
wait_state(lambda s: (s.get("pickReady") or {}).get("ok"))
r = req("/act/pick", {})
check("refused with the clamp reason", not r.get("ok") and "clamp" in json.dumps(r), json.dumps(r, default=str))
check("nothing was pressed", lastclick() == before, json.dumps(lastclick()))
check("not marked executed (a retry would be allowed)", "already" not in ((req("/state?light=1").get("pickReady") or {}).get("reason") or ""))

# ---- 4. a pick for another hand / another spot is refused ---------------------
print("guards")
h = load("flop-hero-facing-bet.json")
push("Fold", h, hand_id=h["handId"] - 1)
s = req("/state?light=1")
check("wrong hand id refused", not (s.get("pickReady") or {}).get("ok") and "hand #" in ((s.get("pickReady") or {}).get("reason") or ""), json.dumps(s.get("pickReady")))
push("Fold", h, n=len(h["actions"]) + 1)
s = req("/state?light=1")
check("moved-on action count refused", "actions" in ((s.get("pickReady") or {}).get("reason") or ""), json.dumps(s.get("pickReady")))
push("Fold", h)
time.sleep(3.3)
s = req("/state?light=1")
check("stale pick (no keep-alive) refused", "stale" in ((s.get("pickReady") or {}).get("reason") or ""), json.dumps(s.get("pickReady")))

# ---- 5. auto mode: arms on the fake table, fires once ------------------------
print("auto")
h = load("flop-hero-facing-bet.json")
a = req("/study-auto", {"auto": True})
check("auto arms on the fake table", a.get("ok") is True and a.get("auto") is True, json.dumps(a))
before = lastclick()
push("Call", h)
s = wait_state(lambda s: (s.get("lastExec") or {}).get("source") == "auto" and (s.get("lastExec") or {}).get("pick") == "Call", 4)
c = lastclick()
check("auto fired the call", (c or {}).get("qa") == "callButton" and c != before, json.dumps(c))
check("lastExec says auto", (s.get("lastExec") or {}).get("source") == "auto", json.dumps(s.get("lastExec"), default=str))
push("Call", h)            # keep-alive of the same decision
time.sleep(1.0)
check("auto did not fire again on the keep-alive", lastclick() == c, json.dumps(lastclick()))

# ---- 6. answers off blanks everything --------------------------------------
req("/study-auto", {"auto": False})
req("/study-answers", {"on": False})
s = req("/state?light=1")
check("answers off → pick not ready", "off" in ((s.get("pickReady") or {}).get("reason") or ""))
check("auto disarmed", s.get("studyAuto") is False)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
