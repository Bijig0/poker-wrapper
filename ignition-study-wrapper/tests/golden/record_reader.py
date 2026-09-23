"""Golden: the Ignition reader (launch.py) over recorded sessions.

    aof-model/.venv/Scripts/python.exe tests/golden/record_reader.py <scenario>    (one scenario, fresh process)
    aof-model/.venv/Scripts/python.exe tests/golden/record_all.py                  (every golden)

A scenario is a recorded debug session's DOM ticks (debug/<session>/dom.jsonl, with the tick's time and
the in-page watcher's events from log.jsonl) interleaved by time with the WebSocket frames the tap dumped
in the same window (debug/ws_dump*.jsonl). Each input is fed through exactly what the live loops run:

    dom  -> the body of launch._feed_loop (the tick, then the flush / auto / top-up chain)
    ws   -> the body of launch._ws_tap for one frame (_tap_accepts, the held-frame replay, _on_game_msg)

and after every input the wrapper's observable state is snapshotted: the /hand export, /state?light=1,
the live status, the feed, the WS state, the tap's binding, the reconciler, archived rows, and a few
pure readings of the tick (board, hero cards, the action strip, the modal). The file stores the inputs
too, so the TypeScript replay needs nothing but the file.

Nothing touches the real data/ or debug/: every write path is pointed at a temp directory, the CDP layer
is replaced by the recording, and a press is recorded instead of made.
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
from common import FakeTime, Writer, norm  # noqa: E402

DEBUG = ROOT / "debug"
DUMPS = {"1": DEBUG / "ws_dump.jsonl", "2": DEBUG / "ws_dump-2.jsonl"}

# name -> (debug session, which dump, TABLE_SLOT or None)
SCENARIOS: dict[str, tuple[str | None, str, str | None]] = {}
for _d in sorted(DEBUG.glob("session_*")):
    if (_d / "dom.jsonl").exists() and (_d / "log.jsonl").exists():
        SCENARIOS[_d.name] = (_d.name, "1", None)
# the 2026-09-21 two-table sessions again, as the slot that recorded them (the tap's socket binding)
for _name, _dump, _slot in (("session_20260921_150400", "1", "1"), ("session_20260921_150413", "2", "2"),
                            ("session_20260921_154507", "1", "1"), ("session_20260921_154518", "2", "2"),
                            ("session_20260922_194118", "1", "1"), ("session_20260922_194132", "2", "2")):
    if _name in SCENARIOS:
        SCENARIOS[f"{_name}-slot{_slot}"] = (_name, _dump, _slot)
# the WS-only fixture test_tap_isolation drives (no DOM ticks): single-table and both slots
SCENARIOS["multitable-fixture"] = (None, "fixture", None)
SCENARIOS["multitable-fixture-slot1"] = (None, "fixture", "1")
SCENARIOS["multitable-fixture-slot2"] = (None, "fixture", "2")

# live facts the WS-only scenarios cannot get from a DOM tick: which seat the client tags as hero's in OUR frame
# (the fixture's two sockets deal hero into seat 1 and seat 3)
INIT_LIVE = {"multitable-fixture-slot1": {"heroSeatDom": 1}, "multitable-fixture-slot2": {"heroSeatDom": 3}}

PICKS = ["Fold", "Call", "Check", "Raise 2.5", "BET 3.35", "Bet 33%", "All-in", "RAISE 12", "Limp", "jam",
         "r4", "Bet 4.5bb", "X", "CHECK", "raise", "bet"]
PLANS = [{"kind": "action", "label": "fold"}, {"kind": "action", "label": "check"},
         {"kind": "action", "label": "call"}, {"kind": "action", "label": "all-in"},
         {"kind": "action", "label": "raise"}, {"kind": "action", "label": "bet"},
         {"kind": "raise-to", "amount": "2.5", "verb": "raise"}, {"kind": "raise-to", "amount": "100", "verb": "raise"},
         {"kind": "raise-to", "amount": "7.25", "verb": "bet"}]


def load_jsonl(p: Path) -> list[dict]:
    out = []
    if not p.exists():
        return out
    for line in p.open(encoding="utf-8"):
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def build_inputs(session: str | None, dump: str) -> list[dict]:
    """The scenario's inputs in the order the replay feeds them."""
    events: list[tuple[float, int, int, dict]] = []
    if dump == "fixture":
        fx = json.loads((ROOT / "tests" / "fixtures" / "multitable-ws-2026-09-21.json").read_text(encoding="utf-8"))
        t = 1_790_000_000.0
        for i, fr in enumerate(fx["frames"]):
            d = (fr.get("d") or fr.get("data")) if isinstance(fr, dict) else None
            rid = fr.get("rid") if isinstance(fr, dict) else None
            ts = fr.get("ts") if isinstance(fr, dict) and fr.get("ts") else t + i * 0.05
            if isinstance(d, dict) and d.get("pid") and not str(d["pid"]).startswith("<"):
                events.append((float(ts), 1, i, {"kind": "ws", "ts": float(ts), "rid": rid, "d": d}))
        events.sort(key=lambda e: (e[0], e[1], e[2]))
        return [e[3] for e in events]
    sd = DEBUG / session
    logs = {r.get("seq"): r for r in load_jsonl(sd / "log.jsonl")}
    doms = load_jsonl(sd / "dom.jsonl")
    ticks = []
    for d in doms:
        seq = d.pop("seq", None)
        lg = logs.get(seq) or {}
        ts = lg.get("ts")
        if ts is None:
            continue
        ticks.append((float(ts), 0, seq, {"kind": "dom", "ts": float(ts), "seq": seq, "d": d,
                                          "events": lg.get("events") or []}))
    if not ticks:
        return []
    lo, hi = min(t[0] for t in ticks) - 5, max(t[0] for t in ticks) + 5
    frames = []
    for i, e in enumerate(load_jsonl(DUMPS[dump])):
        ts = e.get("ts")
        d = e.get("data")
        if ts is None or not (lo <= ts <= hi) or not isinstance(d, dict):
            continue
        pid = str(d.get("pid") or "")
        if not pid or pid.startswith("<"):
            continue
        frames.append((float(ts), 1, i, {"kind": "ws", "ts": float(ts), "rid": e.get("rid"), "d": d}))
    events = ticks + frames
    events.sort(key=lambda e: (e[0], e[1], e[2]))
    return [e[3] for e in events]


def main(name: str) -> int:
    session, dump, slot = SCENARIOS[name]
    if slot:
        os.environ["TABLE_SLOT"] = slot
        os.environ["TABLE_COUNT"] = "2"
    else:
        os.environ.pop("TABLE_SLOT", None)
        os.environ.pop("TABLE_COUNT", None)
    os.environ.pop("FAKE_TABLE", None)
    inputs = build_inputs(session, dump)
    if not inputs:
        print(f"{name}: no inputs")
        return 0

    tmp = Path(tempfile.mkdtemp(prefix=f"golden-{name}-"))
    (tmp / "data").mkdir()
    FT = FakeTime(inputs[0]["ts"])
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        import launch as L
    L.time = FT
    L.TABLES.time = FT
    L.DATA_DIR = tmp / "data"
    L._WS_DUMP_PATH = tmp / "ws_dump.jsonl"
    L._HERE = str(tmp)
    L._dbg.update({"on": False, "dir": None})
    L.TABLES.registry = lambda now=None: []
    L.TABLES.live_peers = lambda timeout=None: []
    L.TABLES.CLAIM_DIR = tmp / "tables"
    L.TABLES.PRESS_LOCK = tmp / "tables" / "press.lock"

    TARGET = {"id": "replay", "webSocketDebuggerUrl": "ws://replay", "url": "https://www.ignitioncasino.eu/static/poker-game/replay",
              "title": "replay", "type": "page"}
    cur: dict = {"d": {}, "events": []}
    effects: list = []

    def fake_eval(ws, expr, timeout=4):
        if expr == L._table_js(L.TABLES.dom_slot()):
            return copy.deepcopy(cur["d"])
        if expr == L._watch_js(L.TABLES.dom_slot()):
            ev, cur["events"] = cur["events"], []
            return ev
        if expr == "document.visibilityState":
            return "visible"
        effects.append({"eval": expr[:80]})
        return None

    L.cdp.available = lambda port=None: True
    L.cdp._eval = fake_eval
    L.cdp.page_targets = lambda port=None: [dict(TARGET)]
    L.cdp._dispatch_click = lambda ws, x, y: effects.append({"click": [x, y]})
    L.ignition_target = lambda: dict(TARGET)

    def fake_act(label, kind="action"):
        effects.append({"act": [label, kind]})
        return {"ok": True, "clicked": label, "kind": kind, "at": [0, 0]}

    L.act = fake_act
    L.raise_to = lambda amount, strict=False: (effects.append({"raise_to": [amount, strict]}) or {"ok": True})
    L._cdp_seq = lambda ws, cmds: effects.append({"cdp_seq": [c[0] for c in cmds]})

    init_live = INIT_LIVE.get(name) or {}
    L._live_status.update(init_live)
    w = Writer(f"reader-{name}")
    w.write({"type": "meta", "scenario": name, "session": session, "dump": dump, "slot": slot,
             "inputs": len(inputs), "t0": inputs[0]["ts"], "initLive": init_live})
    loop = {"fails": 0}
    last_row = 0
    dump_seen = 0

    def feed_loop_once():
        # launch._feed_loop's body, verbatim in order (the TS port exports the same function)
        try:
            L._feed_tick()
            if loop["fails"]:
                L._feed_add("Table reader recovered")
                L._live_status["feedStalled"] = None
            loop["fails"] = 0
        except Exception as e:
            loop["fails"] += 1
            if loop["fails"] == L.FEED_STALL_TICKS:
                L._live_status["feedStalled"] = {"since": int(FT.time() * 1000), "error": repr(e)[:200]}
                L._live_status["toAct"] = False
                L._feed_add(f"⚠ table reader failing for {loop['fails']} ticks: {e!r}"[:160])
            effects.append({"tickError": repr(e)[:300]})
        try:
            L._maybe_flush_ended()
        except Exception:
            pass
        try:
            L._maybe_auto_arm()
            L._maybe_prefold_top_up()
            L._maybe_auto_act()
            L._maybe_verify_exec()
            L._maybe_take_time()
            L._maybe_guard_buy_panel()
            L._maybe_session_orphaned()
            L._maybe_session_adopt()
            L._maybe_stand_down()
            L._top_up_kpi_tick()
            L._maybe_top_up()
        except Exception as e:
            effects.append({"chainError": repr(e)[:300]})

    def tap_frame(d, rid):
        # launch._ws_tap's per-frame body
        take = L._tap_accepts(d, rid)
        batch = [(hd, L._tap_bound, True) for hd in L._tap_take_replay()]
        if take:
            batch.append((d, rid, False))
        for fd, frid, replayed in batch:
            e = L._dump_begin(fd, frid)
            if replayed:
                e["replayed"] = True
            try:
                L._on_game_msg(fd)
            except Exception as ex:
                e["status"] = f"handler-error: {ex}"
            L._dump_commit(e)

    def light_state() -> dict:
        s = L.state(light=True)
        for k in ("panelVersion", "setupVersion", "tables"):
            s.pop(k, None)
        return s

    def synthetic_pick(k: int, h: dict | None) -> dict | None:
        """_pick_ready over a pick the poller COULD have pushed for this spot: exercises the whole guard
        chain and _pick_plan on real states without changing what the replay does next."""
        if not h:
            return None
        saved = copy.deepcopy(L._study)
        try:
            n = len(h.get("actions") or [])
            key = json.dumps([h.get("street"), h.get("board"), h.get("heroCards"),
                              (h.get("currentNode") or {}).get("toCall"), n + (1 if k % 7 == 0 else 0)])
            L._study.update({"on": True, "text": "golden", "pick": PICKS[k % len(PICKS)], "decisionKey": key,
                             "handId": h.get("handId") if k % 11 else (h.get("handId") or 0) + 1,
                             "at": FT.time(), "executed": None})
            return norm(L._pick_ready())
        finally:
            L._study.clear()
            L._study.update(saved)

    def terminal_view(h: dict | None) -> dict | None:
        if not h:
            return None
        return {"plans": [norm(L.TERMINAL.is_terminal(p, h)) for p in PLANS],
                "heroDone": norm(L.TERMINAL.hero_done(h))}

    def archived_rows() -> list:
        nonlocal last_row
        p = L.DATA_DIR / "hands.db"
        if not p.exists():
            return []
        c = sqlite3.connect(p)
        try:
            rows = c.execute("SELECT rowid, hand_id, played_at, stakes, street, result_text, result_amount, hero_cards,"
                             " action_count, data FROM hands WHERE rowid > ? ORDER BY rowid", (last_row,)).fetchall()
        finally:
            c.close()
        out = []
        for r in rows:
            last_row = max(last_row, r[0])
            out.append({"rowid": r[0], "hand_id": r[1], "played_at": r[2], "stakes": r[3], "street": r[4],
                        "result_text": r[5], "result_amount": r[6], "hero_cards": r[7], "action_count": r[8],
                        "data": json.loads(r[9])})
        return out

    def dump_entries() -> list:
        nonlocal dump_seen
        allv = list(L._ws_dump)
        new = allv[dump_seen:] if len(allv) >= dump_seen else allv
        dump_seen = len(allv)
        out = []
        for e in new:
            rec = {k: e.get(k) for k in ("hand", "pid", "seat", "rid", "status") if k in e}
            if e.get("replayed"):
                rec["replayed"] = True
            if str(e.get("pid") or "").startswith("<"):
                rec["data"] = norm(e.get("data"))
            out.append(rec)
        return out

    def rc_view():
        rc = L._shadow.get("rc")
        if rc is None:
            return None
        return {"hand": L._shadow.get("hand"), "journal": norm(rc.journal), "violations": norm(rc.violations),
                "faults": norm(rc.faults()), "armed": rc.armed, "ended": rc.ended, "street": rc.street,
                "live": norm(rc.live), "dealt": norm(rc.dealt), "allin": norm(rc.allin), "sb": rc.sb, "bbs": rc.bbs,
                "hero": rc.hero, "C": norm(rc.C), "maxBet": rc.max_bet, "revivals": norm(rc.revivals)}

    for k, ev in enumerate(inputs):
        FT.now = max(FT.now, ev["ts"])
        effects.clear()
        with contextlib.redirect_stdout(sink):
            if ev["kind"] == "dom":
                cur["d"], cur["events"] = ev["d"], list(ev.get("events") or [])
                feed_loop_once()
            else:
                try:
                    tap_frame(ev["d"], ev.get("rid"))
                except Exception as e:
                    effects.append({"tapError": repr(e)[:300]})
            h = L._hand_state()
            snap = {
                "hand": norm(h),
                "light": norm(light_state()),
                "live": norm(L._live_status),
                "handNo": L._hand_no,
                "handIds": norm(L._hand_ids),
                "ws": norm(L._ws_state),
                "feedPrev": norm(L._feed_prev),
                "feedTail": norm(L._feed[-40:]),
                "tap": {"bound": L._tap_bound, "foreign": L._tap_foreign, "held": L._tap_held,
                        "seen": norm(L._tap_seen), "dealt": norm(L._tap_dealt), "claims": norm(L._tap_claims),
                        "rejected": norm(L._tap_rejected), "hold": {str(r): len(v) for r, v in L._tap_hold.items()},
                        "mismatch": L._tap_mismatch, "domCards": norm(L._tap_dom_cards), "stall": norm(L._tap_stall)},
                "rc": rc_view(),
                "shadow": {"agree": L._shadow["agree"], "differ": L._shadow["differ"], "last": norm(L._shadow["last"])},
                "health": norm(L._state_health),
                "seatMem": norm(L._seat_mem),
                "handBlinds": norm(L._hand_blinds), "handBoard": norm(L._hand_board), "roundSeen": norm(L._round_seen),
                "winsSeen": norm(L._wins_seen), "resultSeen": norm(L._result_seen), "awards": norm(L._awards),
                "toasts": norm(L._toasts_seen), "modalState": norm(L._modal_state),
                "study": norm({k2: L._study.get(k2) for k2 in ("lastTopUp", "stackStable", "topUpHand", "topUpDue",
                                                               "autoNotFired", "uncertain")}),
                "lastArchived": norm(L._last_archived),
                "pick": synthetic_pick(k, h),
                "terminal": terminal_view(h),
                "archived": archived_rows(),
                "dump": dump_entries(),
                "effects": copy.deepcopy(effects),
            }
            if ev["kind"] == "dom":
                d = ev["d"]
                try:
                    acts, presets = L._split_strip(d) if d.get("frame") or d.get("buttons") else ([], [])
                except Exception as e:
                    acts, presets = [], [{"error": repr(e)}]
                snap["dom"] = norm({
                    "board": L._board_cards(d), "heroCards": L._hero_cards(d), "seats": L._parse_seats(d),
                    "actions": [a.get("text") for a in acts], "presets": [p.get("text") for p in presets],
                    "toAct": L._to_act(d) if d.get("frame") or d.get("buttons") else None,
                    "heroSeatDom": L._dom_hero_seat(d), "modal": L._modal_of(d),
                    "table": L.table_state()})
        w.write({"type": "in", "i": k, **ev})
        w.write({"type": "out", "i": k, **w.delta(snap)})
    w.close()
    print(f"{name}: {len(inputs)} inputs -> {w.path.name} ({w.path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in SCENARIOS:
        print("scenarios:", " ".join(SCENARIOS))
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
