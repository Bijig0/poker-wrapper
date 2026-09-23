"""Replay every debug recording through the hero-status rule and the "hero to
act" cross-checks — the regression suite for the class of bug hand 398 was
(2026-09-19: a villain's SITTING OUT label read as hero sitting out, 19 s on the
clock, no answer, no failure row).

    aof-model/.venv/Scripts/python.exe tests/replay_status.py            # every recording
    aof-model/.venv/Scripts/python.exe tests/replay_status.py session_20260919_010011 [-v]

Per recorded tick (log.jsonl + dom.jsonl, joined on seq):

  status    _hero_status() as the wrapper would compute it now, with the WS
            state patched from the recording (hero seat, who holds cards) —
            must be "in-hand" on every tick hero holds cards. The OLD rule
            (any "sitting out" on the table) is computed beside it so the
            replay shows what it would have said.
  buttons   ticks with hero's turn buttons up while the status was not
            in-hand = the hand-398 class. Must be 0.
  decisions every hero decision in the archive (hands.db) must have had at
            least one tick with the buttons up in that hand (a decision the
            reader never saw as hero's turn is a capture gap).
  ws        where debug/ws_dump.jsonl still covers the hand: each
            CO_SELECT_REQ (the client asking hero to act) must be matched by a
            button episode within 3 s and vice versa.

Exit status 1 when the buttons check (the regression) fails anywhere.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
DEBUG = os.path.join(HERE, "debug")
DB = os.path.join(HERE, "data", "hands.db")
WS_DUMP = os.path.join(DEBUG, "ws_dump.jsonl")

import launch  # noqa: E402  (the reader itself; needs the aof-model venv)


def load_rows(path):
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        out[r.get("seq")] = r
    return out


def archived_hero_decisions() -> dict[str, int]:
    """client hand id -> number of hero decisions (voluntary actions) archived."""
    if not os.path.exists(DB):
        return {}
    db = sqlite3.connect(DB)
    out: dict[str, int] = {}
    for (data,) in db.execute("select data from hands"):
        try:
            h = json.loads(data)
        except Exception:
            continue
        cid = h.get("clientHandId")
        if not cid:
            continue
        n = sum(1 for a in h.get("actions") or [] if a.get("hero") and a.get("type") not in ("post-sb", "post-bb"))
        out[cid] = max(out.get(cid, 0), n)
    db.close()
    return out


def ws_requests() -> dict[str, dict]:
    """client hand id -> {req: [ts...], hero_acts: [ts...]} from the WS dump."""
    out: dict[str, dict] = {}
    if not os.path.exists(WS_DUMP):
        return out
    cur = None
    hero_seat = None
    for line in open(WS_DUMP, encoding="utf-8"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        pid = e.get("pid")
        d = e.get("data") or {}
        if pid == "PLAY_STAGE_INFO":
            cur = str(d.get("stageNo") or "")
            out.setdefault(cur, {"req": [], "hero_acts": []})
        elif pid == "CO_CARDTABLE_INFO":
            for k, v in d.items():
                if str(k).startswith("seat") and isinstance(v, list) and any(x != 32896 for x in v):
                    hero_seat = int(str(k)[4:])
        elif pid == "CO_SELECT_REQ" and cur:
            out[cur]["req"].append(e.get("ts"))
        elif pid == "CO_SELECT_INFO" and cur and hero_seat is not None and d.get("seat") == hero_seat:
            out[cur]["hero_acts"].append(e.get("ts"))
    return out


def run(session: str, verbose: bool = False) -> dict:
    log = load_rows(os.path.join(DEBUG, session, "log.jsonl"))
    dom = load_rows(os.path.join(DEBUG, session, "dom.jsonl"))
    ids_path = os.path.join(DEBUG, session, "hand_ids.json")
    hand_ids = json.load(open(ids_path, encoding="utf-8")) if os.path.exists(ids_path) else {}
    decisions = archived_hero_decisions()
    wsreq = ws_requests()
    res = {"session": session, "ticks": 0, "status_bad": 0, "status_old_bad": 0, "buttons_bad": 0,
           "hands": 0, "decisions": 0, "decisions_unseen": 0, "ws_hands": 0, "ws_req": 0,
           "ws_req_unmatched": 0, "episodes_unmatched": 0, "details": []}
    by_hand: dict[int, list] = {}
    for seq in sorted(log):
        by_hand.setdefault(log[seq].get("hand") or 0, []).append(seq)
    for hand, seqs in sorted(by_hand.items()):
        if not hand:
            continue
        res["hands"] += 1
        cid = hand_ids.get(str(hand)) or hand_ids.get(hand)
        saw_buttons = False
        episodes: list[tuple[float, float]] = []   # (start, end) of button-up runs, in recorded ts
        ep_start = None
        for seq in seqs:
            r = log[seq]
            d = dom.get(seq) or {}
            seats = r.get("seats") or {}
            hero = next((int(n) for n, s in seats.items() if s.get("hero")), None)
            hero_cards = int((seats.get(str(hero)) or seats.get(hero) or {}).get("cards") or 0) if hero is not None else 0
            dealt = sorted(int(n) for n, s in seats.items() if (s.get("cards") or 0) >= 1)
            ts = r.get("ts")
            to_act = bool(r.get("toAct"))
            if to_act:
                saw_buttons = True
                if ep_start is None:
                    ep_start = ts
            elif ep_start is not None:
                episodes.append((ep_start, ts)); ep_start = None
            if hero is None or not d.get("nodes"):
                continue
            res["ticks"] += 1
            launch._ws_state.update({"heroSeat": hero, "dealt": dealt, "heroFolded": False})
            status = launch._hero_status(d, d.get("nodes") or [])
            txt = " ".join(n["text"] for n in d.get("nodes") or []).lower()
            old = "sitting-out" if ("i am back" in txt or "sitting out" in txt) else "in-hand"
            if hero_cards >= 1 and status != "in-hand":
                res["status_bad"] += 1
                res["details"].append(f"hand {hand} seq {seq}: status {status} while hero holds cards")
            if hero_cards >= 1 and old != "in-hand":
                res["status_old_bad"] += 1
            if to_act and status != "in-hand":
                res["buttons_bad"] += 1
                res["details"].append(f"hand {hand} seq {seq}: BUTTONS UP with status {status} (the hand-398 class)")
        if ep_start is not None:
            episodes.append((ep_start, log[seqs[-1]].get("ts")))
        n_dec = decisions.get(str(cid), 0) if cid else 0
        res["decisions"] += n_dec
        if n_dec and not saw_buttons:
            res["decisions_unseen"] += n_dec
            res["details"].append(f"hand {hand} ({cid}): {n_dec} archived hero decision(s) but no tick ever showed the turn buttons")
        w = wsreq.get(str(cid)) if cid else None
        if w and w["req"]:
            res["ws_hands"] += 1
            res["ws_req"] += len(w["req"])
            for t in w["req"]:
                if not any(s - 3 <= t <= e + 3 for s, e in episodes):
                    res["ws_req_unmatched"] += 1
                    res["details"].append(f"hand {hand} ({cid}): the client asked hero to act at ts {t:.1f} but no button episode matched (episodes {[(round(s,1), round(e,1)) for s, e in episodes]})")
            for s, e in episodes:
                if not any(s - 3 <= t <= e + 3 for t in w["req"]):
                    res["episodes_unmatched"] += 1
                    res["details"].append(f"hand {hand} ({cid}): buttons were up {s:.1f}-{e:.1f} with no CO_SELECT_REQ near it")
    return res


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    sessions = args or sorted(d for d in os.listdir(DEBUG)
                              if d.startswith("session_") and os.path.exists(os.path.join(DEBUG, d, "log.jsonl")))
    tot = {"ticks": 0, "status_bad": 0, "status_old_bad": 0, "buttons_bad": 0, "hands": 0, "decisions": 0,
           "decisions_unseen": 0, "ws_hands": 0, "ws_req": 0, "ws_req_unmatched": 0, "episodes_unmatched": 0}
    print(f"{'session':28} {'hands':>5} {'ticks':>6} {'status✗':>8} {'old✗':>5} {'btn✗':>5} {'dec':>4} {'unseen':>6} {'wsH':>4} {'req':>4} {'req✗':>5} {'ep✗':>4}")
    worst = 0
    for s in sessions:
        r = run(s, verbose)
        for k in tot:
            tot[k] += r[k]
        print(f"{s:28} {r['hands']:>5} {r['ticks']:>6} {r['status_bad']:>8} {r['status_old_bad']:>5} {r['buttons_bad']:>5} "
              f"{r['decisions']:>4} {r['decisions_unseen']:>6} {r['ws_hands']:>4} {r['ws_req']:>4} {r['ws_req_unmatched']:>5} {r['episodes_unmatched']:>4}")
        worst = max(worst, r["buttons_bad"])
        if verbose or r["buttons_bad"] or r["status_bad"]:
            for line in r["details"][:40]:
                print("   ", line)
    print(f"{'TOTAL':28} {tot['hands']:>5} {tot['ticks']:>6} {tot['status_bad']:>8} {tot['status_old_bad']:>5} {tot['buttons_bad']:>5} "
          f"{tot['decisions']:>4} {tot['decisions_unseen']:>6} {tot['ws_hands']:>4} {tot['ws_req']:>4} {tot['ws_req_unmatched']:>5} {tot['episodes_unmatched']:>4}")
    print("status✗ = ticks hero held cards but the status rule said otherwise (NOW) · old✗ = the same for the pre-fix rule · "
          "btn✗ = turn buttons up with a non-in-hand status (the regression, must be 0) · unseen = archived hero decisions with "
          "no button tick · req✗ = client turn requests with no button episode · ep✗ = button episodes with no request")
    return 1 if worst else 0


if __name__ == "__main__":
    raise SystemExit(main())
