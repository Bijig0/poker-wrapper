"""Golden: the CDP-DRIVING flows (formats.goto / leave / window_state / detect / seated_slots / to_lobby, auth's
page_state / login / submit_code / snapshot, balances' scrape / in_play / snapshot) against SCRIPTED page replies.

    aof-model/.venv/Scripts/python.exe tests/golden/record_trace.py

Each scenario scripts what the page answers; every call the Python module makes to the browser is recorded in
order — the JS it evaluated, the clicks, the CDP commands, the target listings — with the answer it got. The
TypeScript replay (apps/wrapper/test/golden/trace.test.ts) feeds the port the same answers by call index and
requires the same calls, in the same order, and the same result. A lobby walk that asks one question differently
is caught at that question.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / "aof-model"))
sys.path.insert(0, str(HERE))
from common import FakeTime, Writer, norm  # noqa: E402

os.environ.pop("TABLE_SLOT", None)
os.environ.pop("TABLE_COUNT", None)
T0 = 1_790_200_000.0
FT = FakeTime(T0)
with contextlib.redirect_stdout(io.StringIO()):
    import formats as F
    import auth as A
    import balances as BAL
    import tables as TABLES
    from scout import cdp
for m in (F, A, BAL, TABLES):
    m.time = FT

TMP = Path(tempfile.mkdtemp(prefix="golden-trace-"))
A.PROFILES = TMP / "profiles.json"
A.SNAPS = TMP / "auth_pages"
BAL.DB = TMP / "sessions.sqlite"
TABLES.CLAIM_DIR = TMP / "tables"
PASSWORDS = {"brady": "correct horse", "nopw": None}
A.keyring = type("K", (), {"get_password": staticmethod(lambda s, u: PASSWORDS.get(u)),
                           "set_password": staticmethod(lambda s, u, p: PASSWORDS.__setitem__(u, p)),
                           "delete_password": staticmethod(lambda s, u: PASSWORDS.pop(u, None))})
PROFILES = [{"name": "brady", "site": "ignition", "email": "brady@example.com", "rememberMe": True, "trustDevice": False},
            {"name": "nopw", "site": "ignition", "email": "x@y.z", "rememberMe": False},
            {"name": "shortmail", "site": "ignition", "email": "", "rememberMe": None}]
A.PROFILES.write_text(json.dumps(PROFILES), encoding="utf-8")

WS = "ws://127.0.0.1:9333/devtools/page/T1"
TARGET = {"id": "T1", "type": "page", "url": "https://www.ignitioncasino.eu/static/poker-game/?lobby=%2Fpoker-lobby",
          "title": "Ignition Poker", "webSocketDebuggerUrl": WS}
LOBBY_ONLY = {"id": "T0", "type": "page", "url": "https://www.ignitioncasino.eu/poker-lobby", "title": "Lobby", "webSocketDebuggerUrl": WS}

calls: list = []
logs: list = []


class Raise:
    def __init__(self, msg):
        self.msg = msg


def install(resp):
    """Route every browser call through `resp(kind, payload) -> answer` and record it."""
    def rec(kind, payload, answer):
        calls.append({"k": kind, "p": norm(payload), "r": norm(answer.__dict__ if isinstance(answer, Raise) else answer),
                      **({"raise": True} if isinstance(answer, Raise) else {})})
        if isinstance(answer, Raise):
            raise RuntimeError(answer.msg)
        return answer

    F._ev = lambda ws, js, timeout=6.0: rec("evs", [ws, js], resp("evs", js))
    cdp._eval = lambda ws, js, timeout=4: rec("ev", [ws, js], resp("ev", js))
    cdp._dispatch_click = lambda ws, x, y: rec("click", [ws, x, y], None)
    cdp.page_targets = lambda port=None: rec("targets", [port], resp("targets", port))
    cdp.available = lambda port=None: rec("available", [port], resp("available", port))
    A._cmds = lambda ws, cmds, timeout=6.0: rec("cmds", [ws, [list(c) for c in cmds]], [None] * len(cmds))


W = Writer("trace")


def run(name: str, fn: str, args: list, resp, before=None):
    calls.clear()
    logs.clear()
    FT.now = T0
    if before:
        before()
    install(resp)
    target = {"formats.goto": lambda *a, **k: F.goto(*a, log=logs.append, **k),
              "formats.leave": lambda *a, **k: F.leave(*a, log=logs.append, **k),
              "formats.window_state": F.window_state, "formats.detect": F.detect,
              "formats.seated_slots": F.seated_slots, "formats.to_lobby": lambda *a: F.to_lobby(*a, log=logs.append),
              "auth.page_state": A.page_state, "auth.login": lambda *a: A.login(*a, log=logs.append),
              "auth.submit_code": lambda *a, **k: A.submit_code(*a, log=logs.append, **k),
              "auth.snapshot": lambda *a: A.snapshot(*a, log=logs.append),
              "balances.scrape": BAL.scrape, "balances.in_play": BAL.in_play,
              "balances.snapshot": BAL.snapshot}[fn]
    kwargs = {}
    if args and isinstance(args[-1], dict) and args[-1].get("__kw__"):
        kwargs = {k: v for k, v in args[-1].items() if k != "__kw__"}
        args = args[:-1]
    try:
        result = target(*args, **kwargs)
    except Exception as e:
        result = {"__error__": f"{type(e).__name__}: {e}"}
    if fn == "auth.snapshot" and isinstance(result, str):
        result = Path(result).name
    W.write({"name": name, "fn": fn, "args": norm(args), "kwargs": norm(kwargs), "t0": T0, "calls": calls[:],
             "result": norm(result), "logs": logs[:], "tEnd": FT.now})
    print(f"{name}: {len(calls)} calls")


def table_params(bb="200", seats="6", play="real", section="ring", title="$1/$2 No Limit Hold'em - Table 5",
                 buyin="20000"):
    p = {"gameType": "holdem", "gameFormat": "ring", "seat": seats, "playMode": play, "limit": "nl",
         "quickSeatBigBlind": bb, "quickSeatSmallBlind": str(int(bb) // 2) if bb else "", "gameTableUrl": section,
         "quickSeatBuyInAmount": buyin, "waitForBigBlind": "true", "tableName": "T5", "_title": title}
    return {k: v for k, v in p.items() if v is not None}


def lobby_page(state):
    """A lobby that works: every step of the wizard answers the way the live client does."""
    def resp(kind, p):
        if kind == "targets":
            return [TARGET]
        if kind == "available":
            return True
        js = p
        if js == F._SEATED_JS:
            return json.dumps({"slots": state["slots"], "tagged": bool(state.get("tagged"))})
        if "keep = ['gameType'" in js:                       # detect()
            if state.get("seated"):
                if state.get("detect_calls", 0) < state.get("detect_blank", 0):
                    state["detect_calls"] = state.get("detect_calls", 0) + 1
                    return table_params(bb="", title=None)
                return state["params"]
            return None
        if js.endswith("!!L"):
            state["lobby_polls"] = state.get("lobby_polls", 0) + 1
            return state["lobby_polls"] > state.get("lobby_after", 0)
        if "button.close-btn') && /Select Stake/" in js:
            return state.get("modal_open", False)
        if "button.close-btn'); if (c) c.click()" in js:
            return True
        if "if(!L) 'nolobby'" in js:
            if '"NEXT"' in js:
                state["next"] = state.get("next", 0) + 1
            return True
        if "L.body.innerText.includes(\"Start" in js:
            return True
        if "custom-toggle" in js:
            return state["practice"]
        if "return /active/.test(b.className)" in js:
            return state.get("seat_res", "active")
        if "innerText.includes('Select Stake')" in js:
            return state.get("next", 0) >= state.get("next_needed", 1)
        if "==='Select Stake').pop()" in js:
            return True
        if "querySelectorAll('li')].filter(e=>(e.innerText||'').trim()===" in js:
            label = json.loads(js.split("trim()===")[1].split(").pop()")[0])
            return label in state.get("stakes", [])
        if "map(e=>(e.innerText||'').trim()).filter(t=>" in js:
            return state.get("stakes", [])
        if "/TAKE MY SEAT/.test(t)" in js:
            return state.get("modal_text")
        if "/^MAXIMUM/i.test" in js:
            return state.get("max_value", "200.00")
        if "let inp = L.querySelector('input[name=otherAmount]" in js:
            return js.split("setter.call(inp, ")[1].split(");")[0].strip('"')
        if "Wait for Big Blind" in js:
            return True
        if "if (!b) return 'nobutton'" in js:
            return state.get("take_state", "ready")
        if "TAKE MY SEAT/i.test(e.innerText)).pop(); b.click()" in js:
            state["seated"] = True
            if state.get("adding"):
                state["slots"] = state["slots"] + [len(state["slots"])]
            return True
        if js.startswith("location.href"):
            state["navigated"] = state.get("navigated", 0) + 1
            return True
        if js == F._SIGNED_OUT_JS:
            return state.get("signed_out", False)
        return None
    return resp


MODAL = "Buy-In\nSelect Stake\n$1.00 / $2.00\nMINIMUM $40.00\nMAXIMUM $200.00\nTAKE MY SEAT"
run("goto ring NL200 max preset", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333],
    lobby_page({"slots": [], "practice": False, "stakes": ["$1.00 / $2.00"], "modal_text": MODAL, "params": table_params()}))
run("goto ring NL200 80bb typed", "formats.goto", ["ign-ring-NL200-6", 80.0, 9333],
    lobby_page({"slots": [], "practice": False, "stakes": ["$1.00 / $2.00"], "modal_text": MODAL, "params": table_params(buyin="16000")}))
run("goto ring NL200 clamp low", "formats.goto", ["ign-ring-NL200-6", 5.0, 9333],
    lobby_page({"slots": [], "practice": False, "stakes": ["$1.00 / $2.00"], "modal_text": MODAL, "params": table_params(buyin="4000")}))
run("goto NEXT twice", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333],
    lobby_page({"slots": [], "practice": False, "stakes": ["$1.00 / $2.00"], "modal_text": MODAL, "next_needed": 2,
                "params": table_params(), "seat_res": "disabled"}))
run("goto stake missing", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333],
    lobby_page({"slots": [], "practice": False, "stakes": ["$0.25 / $0.50", "Select Stake"], "modal_text": MODAL, "params": table_params()}))
run("goto practice zone other stake", "formats.goto", ["ign-practice-zone", 100.0, 9333],
    lobby_page({"slots": [], "practice": True, "stakes": ["2.00 / 4.00"], "modal_text": "Buy-In MAXIMUM 400.00 TAKE MY SEAT",
                "params": table_params(bb="", play="fun", section="/poker-lobby/zone-poker", title="2/4 No Limit Hold'em - Zone", buyin=None),
                "max_value": "400.00", "detect_blank": 3}))
run("goto already seated", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333],
    lobby_page({"slots": [0], "seated": True, "practice": False, "params": table_params()}))
run("goto adding", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333, True, {"__kw__": True, "adding": True}],
    lobby_page({"slots": [0], "seated": True, "adding": True, "practice": False, "stakes": ["$1.00 / $2.00"],
                "modal_text": MODAL, "params": table_params(), "tagged": True}))
run("goto entry hop", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333],
    lobby_page({"slots": [], "practice": False, "stakes": ["$1.00 / $2.00"], "modal_text": MODAL, "params": table_params(),
                "lobby_after": 60}))
run("goto signed out", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333],
    lobby_page({"slots": [], "practice": False, "lobby_after": 10**6, "signed_out": True}))
run("goto toggle stuck", "formats.goto", ["ign-practice-ring", 100.0, 9333],
    lobby_page({"slots": [], "practice": False, "stakes": [], "modal_text": MODAL}))
run("goto disabled seat", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333],
    lobby_page({"slots": [], "practice": False, "stakes": ["$1.00 / $2.00"], "modal_text": MODAL, "params": table_params(),
                "take_state": "disabled: Your available balance is $3.00"}))
run("goto unknown format", "formats.goto", ["nope", 100.0, 9333], lobby_page({"slots": []}))
run("goto no target", "formats.goto", ["ign-ring-NL200-6", 100.0, 9333],
    lambda k, p: [] if k == "targets" else True)


def leave_page(state):
    def resp(kind, p):
        if kind == "targets":
            return [TARGET]
        if kind == "available":
            return True
        js = p
        if "keep = ['gameType'" in js:
            return None if state.get("left") else table_params()
        if ".iconItem.close" in js:
            state["find"] = state.get("find", 0) + 1
            return None if state["find"] <= state.get("find_blank", 0) else {"x": 700, "y": 12}
        if "==='YES').pop()" in js:
            state["yes"] = state.get("yes", 0) + 1
            if state["yes"] > state.get("yes_after", 0):
                state["left_after"] = state.get("left_after", 2)
                state["left"] = True
                return True
            return False
        return None
    return resp


run("leave happy", "formats.leave", [9333], leave_page({}))
run("leave header late", "formats.leave", [9333], leave_page({"find_blank": 5, "yes_after": 3}))
run("leave no yes", "formats.leave", [9333], leave_page({"yes_after": 10**6}))
run("leave no table", "formats.leave", [9333], leave_page({"left": True}))

for label, avail, targets, signed, params in [
        ("closed", False, [], False, None), ("no ignition page", True, [{"id": "x", "type": "page", "url": "about:blank", "webSocketDebuggerUrl": "ws://x"}], False, None),
        ("login url", True, [{**TARGET, "url": "https://www.ignitioncasino.eu/login?x=1"}], False, None),
        ("signed out form", True, [TARGET], True, None), ("seated", True, [TARGET], False, table_params()),
        ("signed in", True, [TARGET], False, None)]:
    run(f"window_state {label}", "formats.window_state", [9333],
        lambda k, p, a=avail, t=targets, s=signed, pr=params: a if k == "available" else t if k == "targets"
        else s if p == F._SIGNED_OUT_JS else pr if "keep = ['gameType'" in p else None)
run("detect settle", "formats.detect", [9333, 3.0],
    lobby_page({"slots": [0], "seated": True, "params": table_params(bb="", title=None), "detect_blank": 0}))
run("detect raises", "formats.detect", [9333], lambda k, p: [TARGET] if k == "targets" else Raise("TypeError: boom"))
run("seated_slots", "formats.seated_slots", [9333], lambda k, p: [TARGET] if k == "targets" else json.dumps({"slots": [0, 1, 3], "tagged": True}))
run("to_lobby", "formats.to_lobby", [9333], lambda k, p: [TARGET] if k == "targets" else json.dumps({"x": 40, "y": 20, "w": 50, "h": 20}))
run("to_lobby none", "formats.to_lobby", [9333], lambda k, p: [TARGET] if k == "targets" else None)
run("to_lobby raises", "formats.to_lobby", [9333], lambda k, p: [TARGET] if k == "targets" else Raise("Error: page gone"))

# ---------------------------------------------------------------- auth
STATES = {
    "seated": {"path": "/static/poker-game/", "seated": True},
    "captcha": {"path": "/login", "challenge": True, "hasLogin": True},
    "code": {"path": "/login", "hasCode": True, "hasLogin": True, "errs": [], "codeField": {"name": "code", "id": "code", "ac": "", "max": 6, "type": "number"}},
    "code-err": {"path": "/login", "hasCode": True, "errs": ["Invalid code"]},
    "login": {"path": "/login", "hasLogin": True, "errs": [], "trustField": {"id": "trusted_device", "checked": False}},
    "login-err": {"path": "/login", "hasLogin": True, "errs": ["Error", "Please try again"]},
    "lobby": {"path": "/poker-lobby/home", "lobby": True},
    "unknown": {"path": "/x", "snippet": "Something else entirely " * 10},
}
for st in STATES:
    run(f"page_state {st}", "auth.page_state", [9333],
        lambda k, p, st=st: True if k == "available" else [TARGET] if k == "targets" else STATES[st] if p == A._STATE_JS else None)
run("page_state raises", "auth.page_state", [9333],
    lambda k, p: True if k == "available" else [TARGET] if k == "targets" else Raise("socket closed"))
run("page_state closed", "auth.page_state", [9333], lambda k, p: False if k == "available" else [])


def login_page(state):
    def resp(kind, p):
        if kind == "available":
            return True
        if kind == "targets":
            return [TARGET]
        js = p
        if js == A._STATE_JS:
            state["polls"] = state.get("polls", 0) + 1
            if state.get("clicked"):
                return STATES[state.get("after", "lobby")] if state["polls"] > state.get("settle_polls", 2) else STATES["login"]
            return STATES["login-err"] if state["polls"] <= state.get("err_polls", 0) else STATES["login"]
        if "e.focus(); e.select && e.select();" in js:
            return True
        if "return e ? e.value.length : -1;" in js:
            state["len_reads"] = state.get("len_reads", 0) + 1
            return -1 if state["len_reads"] <= state.get("short_len_reads", 0) else (17 if "email" in js else 13)
        if "setter.call(e, " in js and "dispatchEvent(new Event('change'" in js:
            return None
        if "return [e ? e.value.length : -1, p ? p.value.length : -1]" in js:
            state["rb"] = state.get("rb", 0) + 1
            return [3, 13] if state["rb"] <= state.get("short_readback", 0) else [len("brady@example.com"), len("correct horse")]
        if "remember_me" in js:
            return True
        if "#loginSubmit" in js:
            state["clicked"] = True
            return state.get("submit", True)
        return None
    return resp


run("login happy", "auth.login", ["brady", 9333], login_page({}))
run("login error toast then retype", "auth.login", ["brady", 9333], login_page({"err_polls": 3, "short_readback": 1, "short_len_reads": 1}))
run("login to code form", "auth.login", ["brady", 9333], login_page({"after": "code", "settle_polls": 4}))
run("login stays on form", "auth.login", ["brady", 9333], login_page({"after": "login", "settle_polls": 10**6}))
run("login no button", "auth.login", ["brady", 9333], login_page({"submit": False}))
run("login no password", "auth.login", ["nopw", 9333], login_page({}))
run("login no profile", "auth.login", ["ghost", 9333], login_page({}))
run("login already signed in", "auth.login", ["brady", 9333],
    lambda k, p: True if k == "available" else [TARGET] if k == "targets" else STATES["lobby"] if p == A._STATE_JS else None)


def code_page(state):
    def resp(kind, p):
        if kind == "available":
            return True
        if kind == "targets":
            return [TARGET]
        js = p
        if js == A._STATE_JS:
            state["polls"] = state.get("polls", 0) + 1
            if state.get("submitted"):
                return STATES[state.get("after", "lobby")] if state["polls"] > 3 else STATES["code"]
            return STATES["code"]
        if "e.focus(); e.select && e.select();" in js:
            return True
        if "return e ? e.value.length : -1;" in js:
            return 6
        if "trusted_device" in js:
            return True
        if "CONTINUE" in js:
            state["submitted"] = True
            return state.get("button", "button:CONTINUE")
        return None
    return resp


run("code happy", "auth.submit_code", ["12 34 56", 9333], code_page({}))
run("code enter fallback + trust", "auth.submit_code", ["654321", 9333, {"__kw__": True, "trust_device": True}], code_page({"button": None}))
run("code rejected", "auth.submit_code", ["111111", 9333], code_page({"after": "code-err"}))
run("code too short", "auth.submit_code", ["12a", 9333], code_page({}))
run("code not asked", "auth.submit_code", ["123456", 9333],
    lambda k, p: True if k == "available" else [TARGET] if k == "targets" else STATES["login"] if p == A._STATE_JS else None)
run("snapshot", "auth.snapshot", [9333, "login-form"],
    lambda k, p: [TARGET] if k == "targets" else {"url": "https://x/login", "title": "Login", "inputs": [], "buttons": [], "iframes": [], "text": "hi"})

# ---------------------------------------------------------------- balances
SCRAPES = {"header": {"ok": True, "how": "header", "amount": "2115.15", "raw": "Balance: $3,008.87 AUD ($2,115.15 USD)"},
           "none": {"ok": False, "reason": "no balance found in the lobby", "candidates": ["$5 bonus"]},
           "bad": {"ok": True, "how": "labelled", "amount": "abc", "raw": "Balance abc"},
           "huge": {"ok": True, "how": "hook", "amount": "2000000", "raw": "$2,000,000.00"}}
INPLAY = {"seated": {"seated": True, "amount": 185.5, "raw": "92.75 BB", "how": "stack-bb x $2.0"},
          "notseated": {"seated": False, "reason": "no hero seat on the table"}}
for s in SCRAPES:
    for ip in INPLAY:
        run(f"scrape {s} {ip}", "balances.scrape", [9333],
            lambda k, p, s=s, ip=ip: [TARGET] if k == "targets" else INPLAY[ip] if p == BAL._IN_PLAY_JS else SCRAPES[s] if p.endswith(BAL._SCRAPE_JS) else None)
run("scrape no client", "balances.scrape", [9333], lambda k, p: [] if k == "targets" else None)
run("scrape non-dict", "balances.scrape", [9333], lambda k, p: [TARGET] if k == "targets" else "weird")
run("in_play raises", "balances.in_play", [9333], lambda k, p: [TARGET] if k == "targets" else Raise("TypeError: x"))
run("snapshot seated", "balances.snapshot", ["brady", 9333, "session_x", "open"],
    lambda k, p: [TARGET] if k == "targets" else INPLAY["seated"] if p == BAL._IN_PLAY_JS else SCRAPES["header"])
run("snapshot lobby", "balances.snapshot", ["brady", 9333, None, "close"],
    lambda k, p: [TARGET] if k == "targets" else INPLAY["notseated"] if p == BAL._IN_PLAY_JS else SCRAPES["header"])
W.close()
print(f"trace: {W.n} scenarios -> {W.path.name}")
