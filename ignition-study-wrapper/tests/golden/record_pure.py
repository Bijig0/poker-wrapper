"""Golden: the wrapper's pure functions, over real and generated inputs.

    aof-model/.venv/Scripts/python.exe tests/golden/record_pure.py

One line per call: {"fn": <name>, "args": [...], "state": {...}?, "out": <result>}. The TypeScript test
dispatches on `fn` to its own implementation with the same args (after applying `state`, the module state
the call reads) and must return the same `out`. Inputs come from the real hand archive (data/hands.db,
read-only), the fixtures, the strategy catalogue the study API serves right now (captured into the file),
and generators; every input is written into the file, so the TS side needs nothing else.
"""
from __future__ import annotations

import contextlib
import copy
import io
import itertools
import json
import os
import random
import sqlite3
import sys
import tempfile
import types
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(HERE))
from common import FakeTime, Writer, norm  # noqa: E402

os.environ.pop("TABLE_SLOT", None)
os.environ.pop("TABLE_COUNT", None)
os.environ.pop("FAKE_TABLE", None)

FT = FakeTime(1_790_100_000.0)
_sink = io.StringIO()
with contextlib.redirect_stdout(_sink):
    import launch as L
    import reconcile as RC
    import terminal as TERMINAL
    import tables as TABLES
    import formats as F
    import sessions as S
    import faketable as FAKE
    import netcheck as NC
    import balances as BAL
    import auth as A
    from sites import cp_feed as CPF
    from sites import coinpoker as CPS
    from fake_hand import ALL_ARTEFACTS, simulate
    import fuzz_reconcile as FZ
for m in (L, RC, TERMINAL, TABLES, F, S, NC, BAL, A, CPF, CPS):
    if hasattr(m, "time"):
        m.time = FT

TMP = Path(tempfile.mkdtemp(prefix="golden-pure-"))
W = Writer("pure")


def rec(fn: str, args: list, out, state: dict | None = None) -> None:
    r = {"fn": fn, "args": norm(args), "out": norm(out)}
    if state is not None:
        r["state"] = norm(state)
    W.write(r)


def safe(f, *a, **k):
    try:
        return f(*a, **k)
    except Exception as e:
        return {"__error__": f"{type(e).__name__}: {e}"}


# ------------------------------------------------------------------ inputs
HANDS: list[dict] = []
_db = sqlite3.connect(f"file:{ROOT / 'data' / 'hands.db'}?mode=ro", uri=True)
for (data,) in _db.execute("SELECT data FROM hands ORDER BY rowid"):
    try:
        HANDS.append(json.loads(data))
    except Exception:
        pass
_db.close()
IGN = [h for h in HANDS if h.get("site") != "coinpoker"]
CPH = [h for h in HANDS if h.get("site") == "coinpoker"]

# ------------------------------------------------------------------ launch: cards / text helpers
for qa in [f"card{i}" for i in range(-1, 60)] + [None, "", "cardx", "card-1", "card07", "card123", "xcard1"]:
    rec("launch._card_name", [qa], L._card_name(qa))
for s in [None, "", "12.5", "1,234.50 BB", "0 BB", "abc", "7", "  3.5  BB", "12.5 BB extra", "-2"]:
    rec("launch._pot_val", [s], L._pot_val(s))
for badge, bet in itertools.product(["FOLD", "check", "CALL", "BET", "raise", "ALL-IN", "all in"],
                                    [None, "0 BB", "2.5 BB", "12", "0"]):
    rec("launch._verb", [badge, bet], L._verb(badge, bet))
for bb, seen in [(0, False), (200, False), (200, True), (5, True), (50, True)]:
    L._ws_state.update({"bb": bb, "bbSeen": seen})
    for c in [None, 0, 1, 50, 100, 150, 250, 333, 1000, 2717, 20000]:
        rec("launch._amt", [c], L._amt(c), state={"ws": {"bb": bb, "bbSeen": seen}})
    for t in [None, "", "0 BB", "97.5 BB", "12.34", "$100.00", "1,234", "50", "7.25 bb"]:
        rec("launch._stack_bb", [t], L._stack_bb(t), state={"ws": {"bb": bb, "bbSeen": seen}})
L._ws_state.update({"bb": 0, "bbSeen": False})

PICKS = ["Fold", "fold 100%", "Check", "CHECK", "Call", "call 2.5", "Limp", "All-in", "ALL IN", "all-in 55",
         "jam", "shove", "RAI", "rai 3", "Raise", "raise", "Raise 2.5", "RAISE 12", "raise 12.555", "r4", "R9.5",
         "Bet", "bet 4.5bb", "BET 3.35", "Bet 33%", "bet 75%", "Bet 0", "Bet 0%", "Raise to 7", "X", "", None,
         "  call  ", "Bet 1/3 pot", "raise 1e3", "bet 100.00", "Raise 2.50bb", "bet 150%"]
for p, pot in itertools.product(PICKS, [None, 0, 6.5, 12.25, 3.0]):
    rec("launch._pick_plan", [p, pot], L._pick_plan(p, pot))

PLANS = [{"kind": "action", "label": x} for x in ("fold", "check", "call", "raise", "bet", "all-in", "limp")] + \
        [{"kind": "raise-to", "amount": a, "verb": v} for a, v in (("2.5", "raise"), ("10", "bet"), ("0.5", "raise"), ("100", "raise"))]
ACTS = [{"type": t, "amount": a} for t in ("fold", "check", "call", "raise", "bet", "all-in", "post-bb", None)
        for a in (None, 0.5, 2.5, 2.6, 2.9, 9.0, 10.0, 50.0, 95.0)]
for plan, a, st in itertools.product(PLANS, ACTS, [None, 0, 50.0, 100.0]):
    rec("launch._did_as_told", [plan, a, st], L._did_as_told(plan, a, st))

BET_INPUT_CASES = [
    ([], None, None), ([], {"x": 500, "y": 600}, 883),
    ([{"x": 400, "y": 600, "h": 30, "value": "2"}], None, 883),
    ([{"x": 400, "y": 600, "h": 30, "value": "2"}, {"x": 40, "y": 600, "h": 30, "value": "5"}], None, 883),
    ([{"x": 400, "y": 600, "h": 30, "value": "2"}, {"x": 40, "y": 600, "h": 30, "value": "5"}], {"x": 520, "y": 600}, 883),
    ([{"x": 40, "y": 600, "h": 30, "value": "5"}], {"x": 520, "y": 600}, 883),
    ([{"x": 480, "y": 400, "h": 30, "value": "5"}], {"x": 520, "y": 600}, 883),
    ([{"x": 480, "y": 400, "h": 0, "value": "5"}], {"x": 520, "y": 600}, 883),
    ([{"x": 480, "y": 590, "h": 30, "value": "5"}, {"x": 470, "y": 598, "h": 30, "value": "6"}], {"x": 520, "y": 600}, None),
    ([{"x": 480, "y": 590, "h": 30}], {"x": 520}, 1000),
]
for inputs, anchor, fw in BET_INPUT_CASES:
    rec("launch._pick_bet_input", [inputs, anchor, fw], L._pick_bet_input(copy.deepcopy(inputs), anchor, fw))

for d in [{"pid": "CO_CARDTABLE_INFO", "seat1": [32896, 32896], "seat2": [33, 51]},
          {"pid": "CO_CARDTABLE_INFO", "seat1": [1, 2], "seat3": [40, 41], "seat4": 7, "seatx": [1]},
          {"pid": "CO_CARDTABLE_INFO", "seat5": [], "seat6": [60, 70]}, {}]:
    rec("launch._face_up_seats", [d], L._face_up_seats(d))
for d in [{"pid": "PLAY_BUYIN_INFO", "type": 1, "seat": 3}, {"pid": "PLAY_BUYIN_INFO", "type": 2, "seat": 3},
          {"pid": "CO_SIT_PLAY", "seat": 5}, {"pid": "CO_SIT_PLAY", "seat": 0}, {"pid": "CO_SIT_PLAY", "seat": "3"},
          {"pid": "PLAY_SEAT_INFO", "seat": 2}]:
    rec("launch._hero_claim", [d], L._hero_claim(d))

# positions: every seat subset, dealer, hero, with and without a small-blind post
rng = random.Random(7)
for n in range(1, 10):
    for _ in range(12):
        dealt = sorted(rng.sample(range(1, 10), n))
        dealer = rng.choice(dealt + [None, rng.randint(1, 9)])
        hero = rng.choice(dealt + [None, 10])
        acts = []
        if n >= 2 and rng.random() < 0.8:
            if rng.random() < 0.7 and n >= 2:
                acts.append({"seat": dealt[(dealt.index(dealer) + 1) % n] if dealer in dealt else dealt[0], "type": "post-sb"})
            acts.append({"seat": rng.choice(dealt), "type": "post-bb"})
        st = {"dealt": dealt, "dealer": dealer, "heroSeat": hero, "actions": acts}
        L._ws_state.update(copy.deepcopy(st))
        rec("launch._positions_all", [], L._positions_all(), state={"ws": st})
        rec("launch._hero_position", [], L._hero_position(), state={"ws": st})
L._ws_state.update({"dealt": [], "dealer": None, "heroSeat": None, "actions": []})

# the turn-order rule the derived line must pass, over real archived lines and shuffled ones
for h in IGN[:400]:
    line = [(a.get("street"), a.get("seatId"), a.get("type"),
             round(float(a["amount"]), 1) if a.get("amount") is not None else None) for a in h.get("actions") or []]
    dealt = h.get("liveSeats") or []
    pos = h.get("positions") or {}
    sb = next((int(s) for s, p in pos.items() if p == "SB"), None)
    bbs = next((int(s) for s, p in pos.items() if p == "BB"), None)
    rc = {"dealt": sorted(dealt), "sb": sb, "bbs": bbs}
    ns = types.SimpleNamespace(dealt=set(dealt), sb=sb, bbs=bbs)
    rec("launch._line_order_fault", [line, rc], L._line_order_fault(line, ns))
    if len(line) > 3:
        sh = list(line)
        rng.shuffle(sh)
        rec("launch._line_order_fault", [sh, rc], L._line_order_fault(sh, ns))

AWARD_ROWS = [
    ({"text": "wins ($5.00)", "x": 100, "y": 50, "w": 80, "h": 12},
     [{"text": "Player 3", "x": 50, "y": 50, "w": 50, "h": 12}, {"text": "wins ($5.00)", "x": 100, "y": 50, "w": 80, "h": 12}]),
    ({"text": "wins main pot ($74) with (a pair)", "x": 20, "y": 80, "w": 200, "h": 12},
     [{"text": "Player 2", "x": 22, "y": 81, "w": 50, "h": 12}]),
    ({"text": "wins ($1)", "x": 100, "y": 50, "w": 50, "h": 12},
     [{"text": "Bob", "x": 40, "y": 50, "w": 58, "h": 12}, {"text": "Al", "x": 10, "y": 50, "w": 20, "h": 12}]),
    ({"text": "wins ($1)", "x": 100, "y": 50, "w": 50, "h": 12}, []),
]
for win, row in AWARD_ROWS:
    rec("launch._award_name", [win, row], L._award_name(win, row))

for title, base in itertools.product(["Poker Wrapper", "Poker Wrapper · Session setup", "Poker Wrapper - x",
                                      "Poker Wrapper Tool", "Poker Wrapper 2", "Ignition"],
                                     ["Poker Wrapper", "Poker Wrapper Tool"]):
    rec("launch._is_panel_title", [title, base], L._is_panel_title(title, base))
for argv in [["x"], ["--panel-port", "7710"], ["--panel-port=7720"], ["--panel-port", "abc"], ["--panel-port"], []]:
    rec("launch._port_of", [argv], L._port_of(argv))

# every JS snippet the reader sends: the TS port must send byte-identical code
for slot in (None, 0, 1, 2, 3):
    rec("launch._table_js", [slot], L._table_js(slot))
    rec("launch._watch_js", [slot], L._watch_js(slot))
    rec("launch._find_input_js", [slot], L._find_input_js(slot))
    rec("launch._topup_read_js", [slot], L._topup_read_js(slot))
    rec("launch._topup_fill_js", [slot], L._topup_fill_js(slot))
    rec("launch._sitout_read_js", [slot], L._slotted(L._SITOUT_READ_JS_TMPL, slot))
    rec("formats._table_js", [slot], F._table_js(slot))
rec("launch._EXTRACT_DEEP_JS", [], L._EXTRACT_DEEP_JS)
for k in ("_LOBBY", "_SIGNED_OUT_JS", "_SEATED_JS", "_LOBBY_BTN_JS"):
    rec(f"formats.{k}", [], getattr(F, k))
for sel, text in (("a", "Cash games"), ("button,[role=button]", "No Limit"), ("button", "NEXT"), ("a", "it's \"x\"")):
    rec("formats._js_click_text", [sel, text], F._js_click_text(sel, text))
rec("auth._STATE_JS", [], A._STATE_JS)
rec("auth._SNAP_JS", [], A._SNAP_JS)
rec("balances._SCRAPE_JS", [], BAL._SCRAPE_JS)
rec("balances._IN_PLAY_JS", [], BAL._IN_PLAY_JS)
from scout import cdp as CDP  # noqa: E402
rec("cdp._EXTRACT_JS", [], CDP._EXTRACT_JS)

# _point_is_my_table's probe (it formats the point with %f)
_seen_js = []
_orig_eval = L.cdp._eval
L.cdp._eval = lambda ws, js, timeout=4: (_seen_js.append(js) or "0")
os.environ["TABLE_SLOT"] = "1"
for x, y in ((100, 200), (12.5, 7.25), (0.1234567, 999.9999999)):
    _seen_js.clear()
    got = L._point_is_my_table("ws://x", x, y)
    rec("launch._point_is_my_table.js", [x, y], {"js": _seen_js[-1], "result": got})
os.environ.pop("TABLE_SLOT", None)
L.cdp._eval = _orig_eval

# ------------------------------------------------------------------ tables geometry
AREAS = [{"x": 0, "y": 0, "w": 2560, "h": 1400}, {"x": 2880, "y": 0, "w": 2560, "h": 1400},
         {"x": -1920, "y": 100, "w": 1920, "h": 1040}, {"x": 0, "y": 0, "w": 1441, "h": 851}]
for area in AREAS:
    for n in range(0, 6):
        for i in range(0, 5):
            rec("tables.grid", [i, n, area], TABLES.grid(i, n, area))
        rec("tables.client_rect", [n, area], TABLES.client_rect(n, area))
        for s in range(0, 6):
            for other in (None, AREAS[1]):
                rec("tables.panel_rect", [s, n, area, other], TABLES.panel_rect(s, n, area, other))
MONS = [
    [{"x": 0, "y": 0, "w": 2880, "h": 1800, "scale": 2.0}, {"x": 2880, "y": 0, "w": 2560, "h": 1440, "scale": 1.0}],
    [{"x": 0, "y": 0, "w": 1920, "h": 1080, "scale": 1.25}],
    [{"x": 0, "y": 0, "w": 2560, "h": 1440, "scale": 1.0}, {"x": -1920, "y": 0, "w": 1920, "h": 1080, "scale": 1.5},
     {"x": 0, "y": 1440, "w": 1920, "h": 1080, "scale": None}],
]
for mons in MONS:
    rec("tables.dip_layout", [mons], TABLES.dip_layout(copy.deepcopy(mons)))
    for rect in ({"x": 0, "y": 0, "w": 2016, "h": 1800}, {"x": 2880, "y": 0, "w": 1280, "h": 720},
                 {"x": 3100, "y": 40, "w": 999, "h": 555}, {"x": -1000, "y": 10, "w": 500, "h": 300},
                 {"x": 99999, "y": 0, "w": 1, "h": 1}, {"x": 5, "y": 1500, "w": 101, "h": 77}):
        rec("tables.to_dip", [rect, mons], TABLES.to_dip(rect, copy.deepcopy(mons)))
for env in ({}, {"TABLE_COUNT": "2"}, {"TABLE_COUNT": "3"}, {"TABLE_COUNT": "4"}, {"TABLE_COUNT": "9"},
            {"TABLE_COUNT": "0"}, {"TABLE_COUNT": "x"}, {"TABLE_SLOT": "1", "TABLE_COUNT": "4"},
            {"TABLE_SLOT": "3", "TABLE_COUNT": "4"}, {"TABLE_SLOT": "5"}, {"TABLE_SLOT": "y"}):
    old = {k: os.environ.get(k) for k in ("TABLE_SLOT", "TABLE_COUNT")}
    for k in ("TABLE_SLOT", "TABLE_COUNT"):
        os.environ.pop(k, None)
    os.environ.update(env)
    rec("tables.env", [env], {"slot": TABLES.slot(), "count": TABLES.count(), "domSlot": TABLES.dom_slot(),
                              "isLeader": TABLES.is_leader(), "leaderPort": TABLES.leader_port(),
                              "ports": [TABLES.panel_port(k) for k in range(1, 5)], "rig": TABLES.rig()})
    for k in ("TABLE_SLOT", "TABLE_COUNT"):
        os.environ.pop(k, None)
        if old[k] is not None:
            os.environ[k] = old[k]

# ------------------------------------------------------------------ formats
rec("formats.data", [], F.data())
for bbc in [None, 0, 2, 4, 5, 10, 25, 50, 100, 200, 500, 1000, 7]:
    rec("formats.stake_for_bb", [bbc], F.stake_for_bb(bbc))
for gt, st, seats in itertools.product(["ring", "zone", "practice", "hu"], [None, "zone", "ring", "NL25", "NL200", "NL5"], [None, 2, 3, 6, 9]):
    rec("formats.format_id_for", [gt, st, seats], F.format_id_for(gt, st, seats))
PARAMS = []
for play, section, gf, seat, bb, sb, buyin, title in itertools.product(
        ["fun", "real"], ["", "/poker-lobby/zone-poker", "ring"], [None, "ZONE", "ring"], ["6", "3", "", None],
        ["200", "", None, "25"], ["100", None], ["20000", None], [None, "$0.10/$0.25 No Limit Hold'em - Zone", "2/4 No Limit Hold'em", "$1,000/$2,000 NL"]):
    p = {"playMode": play, "gameTableUrl": section, "gameFormat": gf, "seat": seat, "quickSeatBigBlind": bb,
         "quickSeatSmallBlind": sb, "quickSeatBuyInAmount": buyin, "_title": title, "waitForBigBlind": "true",
         "tableName": "T"}
    PARAMS.append({k: v for k, v in p.items() if v is not None})
for p in PARAMS[::3]:
    rec("formats._describe", [p], F._describe(p))
OBS = [None] + [F._describe(p) for p in PARAMS[::41]]
for fid in [None, "ign-zone-NL25", "ign-ring-NL200-6", "ign-practice-ring", "ign-practice-zone", "nope"]:
    for o in OBS:
        rec("formats.compare", [fid, o], F.compare(fid, o))

# ------------------------------------------------------------------ sessions
try:
    with urllib.request.urlopen(f"{S.API}/api/dashboard/sources/strategies", timeout=20) as r:
        CATALOGUE = json.loads(r.read().decode("utf-8"))["strategies"]
except Exception as e:
    print(f"strategy catalogue unavailable ({e}) — using a synthetic one")
    CATALOGUE = [{"id": "ign200-ring-6max-equilibrium", "name": "x", "preflop": "equilibrium", "postflop": "ai",
                  "preflopLayer": {"source": "hrc-6max"}, "status": "ok"}]
rec("sessions.catalogue", [], CATALOGUE)
for s in CATALOGUE:
    rec("sessions._strategy_preset", [s], S._strategy_preset(s))
for s in CATALOGUE[:1]:
    for mut in ({"status": "misspecified"}, {"formats": None}, {"formats": ["cp-hu-NL200"]}, {"sites": ["coinpoker"]},
                {"preflop": "exploit", "postflop": "mes"}, {"preflopLayer": {}}, {"defaultFormat": None, "id": "ign25-zone-3max-exploit"}):
        s2 = {**s, **mut}
        rec("sessions._strategy_preset", [s2], S._strategy_preset(s2))
S.fetch_strategies = lambda timeout=6.0: copy.deepcopy(CATALOGUE)
PRESETS = S.presets(refresh=True)
rec("sessions.presets", [], PRESETS)
OVR = [None, {}, {"answers": 0}, {"answers": 1, "recording": "", "clearCache": 1}, {"sources": {"exploitPreflop": 1, "mesPostflop": 0}},
       {"budget": {"hands": "50", "minutes": 0}}, {"budget": {"hands": None, "minutes": "30"}},
       {"autoDelay": "random"}, {"autoDelay": "slow"}, {"autoBudget": {"minutes": "12", "hands": 0}}, {"autoBudget": {"minutes": "x"}},
       {"format": ""}, {"format": "ign-zone-NL25"}, {"site": "coinpoker"}, {"site": "pokerstars"}, {"cpTable": "31st NL HU 0.05-0.10 X 1392337"},
       {"cpTable": ""}, {"buyinBb": "80"}, {"buyinBb": "0.2"}, {"buyinBb": "zz"}, {"waitForBb": 0}, {"profile": "brady"},
       {"profile": ""}, {"tables": "2"}, {"tables": 3}, {"tables": "q"}, {"strategy": "ignored"}, {"autoExecute": 1, "autoRealMoney": 1, "autoTopUp": 0}]
for preset in list(PRESETS)[:6]:
    for o in OVR:
        rec("sessions.merged_config", [preset, o], safe(S.merged_config, preset, copy.deepcopy(o)))
rec("sessions.merged_config", ["no-such-mode", {}], safe(S.merged_config, "no-such-mode", {}))
for preset in PRESETS:
    for o in (None, {"answers": 0}, {"answers": 1, "sources": {"exploitPreflop": 1, "mesPostflop": 1, "aiChain": 0}},
              {"recording": 0}, {"recording": 1}):
        cfg = S.merged_config(preset, copy.deepcopy(o))
        rec("sessions.requirements_for", [preset, cfg], S.requirements_for(preset, cfg))
try:
    with urllib.request.urlopen(f"{S.API}/api/dashboard/sources/registry", timeout=30) as r:
        REGISTRY = json.loads(r.read().decode("utf-8"))
except Exception as e:
    print(f"registry unavailable ({e})")
    REGISTRY = None
REGS = [None, REGISTRY, {"armed": {}, "cards": []},
        {"armed": {"hrc": {"up": True, "ms": 12}, "hrc6max": {"db": True, "trees": 64}, "exploitPreflop": True, "mesPostflop": True,
                   "mesBoards": 1755, "gtow": {"tokenLive": True, "multiwayLive": False, "clientUp": True,
                                              "sessions": [{"id": "primary", "enabled": True, "multiway": True, "state": "down", "text": "no token"},
                                                           {"id": "secondary", "enabled": True, "multiway": False, "state": "up", "expiresInMs": 1800000}]},
                   "poller": {"running": True}},
         "cards": [{"id": "exploit-preflop", "stateText": "armed", "facts": [["freshness", "2 days"], ["file", "x.json"]]},
                   {"id": "mes-postflop", "facts": [["generation", "refit2"]]}]},
        {"armed": {"hrc": {"up": False}, "hrc6max": {}, "gtow": {"tokenLive": False, "clientUp": True}}, "cards": []},
        {"armed": {"hrc": {"up": True, "ms": 3}, "hrc6max": {}, "gtow": {"tokenLive": False}}, "cards": []}]
_bal_latest, _bal_scrape_cached = BAL.latest, BAL.scrape_cached
BAL.scrape_cached = lambda port, ttl=15.0: {"ok": False, "reason": "no Ignition client on CDP port 9333"}
BAL.latest = lambda profile: ({"amountCents": 123456, "ts": 1_790_000_000_000} if profile == "brady" else None)
NC.cached = lambda max_age_s=20.0: {"ok": True, "detail": "round trip 120 ms · 0/10 lost", "rttMs": 120}
S.ROOT = TMP
for preset in list(PRESETS)[:5]:
    for reg in REGS:
        for fake in (False, True):
            for o in ({"answers": 1, "profile": "brady"}, {"answers": 0}, {"answers": 1, "site": "coinpoker"}):
                cfg = S.merged_config(preset, copy.deepcopy(o))
                out = S.run_preflight(preset, cfg, fake, copy.deepcopy(reg), 9333)
                for c in out["checks"]:
                    if c["id"] == "recording":
                        c["detail"] = "<debug dir>"
                rec("sessions.run_preflight", [preset, cfg, fake, reg, 9333], out)
BAL.latest, BAL.scrape_cached = _bal_latest, _bal_scrape_cached
for reg in REGS:
    v = S.versions_snapshot(copy.deepcopy(reg))
    v.pop("wrapperGit", None)
    rec("sessions.versions_snapshot", [reg], v)

# ------------------------------------------------------------------ terminal, over real archived hands
TPLANS = [None, {"kind": "action", "label": "fold"}, {"kind": "action", "label": "Fold 100%"}, {"kind": "action", "label": "all-in"},
          {"kind": "action", "label": "call"}, {"kind": "action", "label": "check"}, {"kind": "action", "label": "raise"},
          {"kind": "action", "label": "bet"}, {"kind": "raise-to", "amount": "2.5"}, {"kind": "raise-to", "amount": "250"},
          {"kind": "raise-to", "amount": "x"}, {"kind": "weird"}, {"kind": "action", "label": "limp"}]
for h in HANDS[:500]:
    acts = h.get("actions") or []
    cuts = sorted({len(acts), max(0, len(acts) - 1), len(acts) // 2})
    for cut in cuts:
        hh = {**h, "actions": acts[:cut]}
        for plan in TPLANS:
            rec("terminal.is_terminal", [plan, hh], TERMINAL.is_terminal(plan, hh))
        rec("terminal.hero_done", [hh], TERMINAL.hero_done(hh))
rec("terminal.hero_done", [None], TERMINAL.hero_done(None))
rec("terminal.is_terminal", [{"kind": "action", "label": "call"}, None], TERMINAL.is_terminal({"kind": "action", "label": "call"}, None))

# ------------------------------------------------------------------ reconcile, over generated hands (the fuzzer's)
combos = [()] + [(a,) for a in ALL_ARTEFACTS] + [ALL_ARTEFACTS, ("increment_only",)]
for combo in combos:
    for i in range(60):
        script = FZ.random_script(random.Random(i))
        if not FZ.playable(script):
            continue
        try:
            ticks, want = simulate(script, artefacts=combo, seed=i)
        except Exception as e:
            rec("reconcile.fuzz", [list(combo), i], {"__error__": repr(e)})
            continue
        if not ticks:
            continue
        rc = RC.HandReconciler(1)
        faults = []
        for tk in ticks:
            rc.observe(tk)
            faults.append(len(rc.faults()))
        rc.finish(ticks[-1].seq if ticks else 0)
        played = [list(FZ.norm(x)) for x in want]
        # seats as [num, facts] PAIRS: the order a tick lists its seats in is the order same-tick folds are
        # journalled in, and a JSON object would lose it (JS orders integer keys numerically)
        tick_args = [{**norm({k: v for k, v in t.__dict__.items() if k != "seats"}),
                      "seats": [[n, norm(sd)] for n, sd in t.seats.items()]} for t in ticks]
        rec("reconcile.run", [tick_args],
            {"journal": rc.journal, "violations": rc.violations, "line": rc.line(), "faultsPerTick": faults,
             "revivals": rc.revivals, "ended": rc.ended,
             "diff": rc.diff([{"street": (RC.STREETS[x[0]] if isinstance(x[0], int) else x[0]), "seat": x[1], "type": x[2],
                               "amount": x[3]} for x in want]),
             "played": played})
for s in [None, 3, 2.5, "7.5 BB", " 1,234.5 bb ", "$3.00", "RAISE", "", "12"]:
    rec("reconcile.bb", [s], RC.bb(s))
for b in [[], ["FOLD", "CALL 2 BB"], ["CHECK"], ["FOLD", "CALL"], ["RAISE TO 4 BB"], ["fold", "check"], ["BET 3"]]:
    rec("reconcile._buttons_up", [b], RC._buttons_up(b))

# ------------------------------------------------------------------ faketable
FAKE_SPECS = [FAKE.EXAMPLE_SPEC]
for f in sorted((ROOT / "tests" / "fixtures").glob("*.json")):
    fx = json.loads(f.read_text(encoding="utf-8"))
    if isinstance(fx.get("spec"), dict):
        FAKE_SPECS.append(fx["spec"])
extra = copy.deepcopy(FAKE.EXAMPLE_SPEC)
extra.update({"capacity": 9, "theme": "teal", "mainPotBB": 12.5, "handStrength": "Two Pair, Tens & Fives",
              "modal": {"text": "The amount you entered is more than the maximum buy in amount allowed for this table.", "ok": "OK"}})
extra["seats"]["2"] = {"empty": True}
extra["seats"]["3"] = {"stack": 54.6, "cards": 2, "sittingOut": True, "badge": "POST-BB", "timer": 12}
extra["seats"]["5"] = {"stack": 100, "cards": 3, "waitingForBB": True, "bet": 0}
extra["offer"] = {"fold": True, "check": True, "call": 3, "bet": 2.25, "raise": 7.5, "max": 97.2, "allInChip": False,
                  "selectors": ["X2.5", "X3", "Pot", "1/3 Pot", "3/4 Pot", "ALL-IN", "Weird"], "betFieldResets": 4}
extra["node"] = {"toActSeat": 3}
FAKE_SPECS.append(extra)
three = copy.deepcopy(FAKE.EXAMPLE_SPEC)
three.update({"capacity": 2, "heroSeat": 2, "dealerSeat": 3, "board": [], "potBB": None, "title": "<b>x</b> & 'y'"})
FAKE_SPECS.append(three)
for spec in FAKE_SPECS:
    rec("faketable.render_inner", [spec], FAKE.render_inner(copy.deepcopy(spec)))
for url, n in itertools.product(["/faketable/frame?playMode=fun", "/f?a=1&b=<2>"], [1, 2, 3, 4, 0]):
    rec("faketable.render_outer", [url, n], FAKE.render_outer(url, n))
for code in [r + s for r in "A23456789TJQK" for s in "cdhs"] + ["10c", "10♠", "Ah", "t♦", " Ks "]:
    rec("faketable.display_card", [code], safe(FAKE.display_card, code))
    rec("faketable.encode_card", [code], safe(FAKE.encode_card, code))
for v in [None, 0, 1, 2.5, 100, 24.8, 1e-5, 123456789, 0.1 + 0.2, 97.25, "3"]:
    rec("faketable._bb", [v], FAKE._bb(v))

# ------------------------------------------------------------------ netcheck verdicts
for conn, lost, warm, err in [([100, 110, 120], 0, [300, 400, 420], None), ([], 10, [], "could not open HTTPS to api.gtowizard.com: x"),
                              ([250, 300, 290], 3, [600, 700, 2300], None), ([150] * 9, 1, [700, 900, 810], None),
                              ([190, 210], 8, [100], "request failed: y"), ([199.5, 200.5], 0, [800.4, 800.6], None)]:
    NC._connects = lambda c=conn, l=lost: (list(c), l)
    NC._warm = lambda w=warm, e=err: (list(w), e)
    out = NC.probe()
    rec("netcheck.probe", [conn, lost, warm, err], out)

# ------------------------------------------------------------------ balances
for c in [None, 0, 1, -1, 99, 100, 123456, -123456, 100000000, 5, 10]:
    rec("balances.fmt", [c], BAL.fmt(c))
BAL.DB = TMP / "sessions.sqlite"
rows = []
for i, (p, a, src, sid, ph, how, raw, ip) in enumerate([("brady", 100000, "scraped", "s1", "open", "header", "Balance: $1,000.00", None),
                                                          ("brady", 99000, "scraped", "s1", "close", "header", "x" * 300, 1500),
                                                          ("other", 5, "seed", None, None, None, None, 0)]):
    FT.now += 60
    rows.append(BAL.record(p, a, src, sid, ph, how, raw, in_play_cents=ip))
rec("balances.record", [], rows)
rec("balances.latest", ["brady"], BAL.latest("brady"))
rec("balances.history", [None, 10], BAL.history(None, 10))
rec("balances.for_session", ["s1"], BAL.for_session("s1"))

# ------------------------------------------------------------------ cp_feed helpers
for c in [None, {}, {"value": "ACE", "suit": "SPADES"}, {"value": "TEN", "suit": "HEARTS"}, {"value": "X", "suit": "Y"}, {"value": "TWO"}]:
    rec("cp_feed.card", [c], CPF.card(c))
for c in [None, "", "Ts", "Ah", "2c", "9d", "Kx", "T", "Tsx"]:
    rec("cp_feed.glyph", [c], CPF.glyph(c))
for n in range(1, 10):
    for _ in range(6):
        dealt = sorted(rng.sample(range(1, 10), n))
        btn = rng.choice(dealt + [None, 10])
        rec("cp_feed.positions", [dealt, btn], CPF.positions(dealt, btn))
for s in ["2026-09-22 04:47:27:083 [info]  [UNITY] Stdout: x", "2026-02-30 00:00:00:000 x", "garbage", "2026-09-22 04:47:27:9xx"]:
    rec("cp_feed._line_time", [s], CPF._line_time(s))

# ------------------------------------------------------------------ coinpoker labels / formats
ROOMS = ["31st NL HU 0.05-0.10 EV-INRIT-(A) 1392337", "17th-TX PLO 6-max 0.25-0.50 ANTE 1407388", "Practice NL 2-4 55555",
         "weird", "NL 6-max 1-2 ANTE 123", "Table 1392766"]
PROPS = [None, {}, {"maxSize": 2, "smallBlind": 0.05, "bigBlind": 0.1, "ante": 0}, {"maxSize": 6, "smallBlind": 0.1, "bigBlind": 0.25, "ante": 0.04},
         {"maxSize": 6, "smallBlind": 1, "bigBlind": 2, "ante": 0.32, "coinType": 1}, {"maxSize": 2, "smallBlind": 1, "bigBlind": 2, "ante": 0.2},
         {"maxSize": 9, "smallBlind": 0.5, "bigBlind": 1.0}, {"coinType": 2, "maxSize": 6}, {"smallBlind": 0.25, "bigBlind": 0.5}]
for room, props in itertools.product(ROOMS, PROPS):
    rec("coinpoker.label", [room, props], CPS.Site.label(room, props))
for props in PROPS + [{"maxSize": 6, "bigBlind": 0.5}, {"maxSize": 2, "bigBlind": 2.0}, {"maxSize": 6, "bigBlind": 7}]:
    rec("coinpoker._format_for", [props], CPS.Site._format_for(props or {}))
rec("coinpoker.FORMATS", [], CPS.FORMATS)
from sites import cp_actions as CPA  # noqa: E402
for t in [None, "", "2,000", "0.25", "1.18M", "Raise 4,000", "Bet 12.5k", "abc", "1,2,3.4.5", "0"]:
    rec("cp_actions.parse_amount", [t], CPA.parse_amount(t))
for v in [0, 1, 2.5, 2.555, 0.1, 100, 1.005, 12.0, 0.25]:
    rec("cp_actions._fmt", [v], CPA._fmt(v))

W.close()
print(f"pure: {W.n} calls -> {W.path.name} ({W.path.stat().st_size // 1024} KB)")
