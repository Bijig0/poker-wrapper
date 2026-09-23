"""Backfill the client's award into archived hands from the debug recordings.

The client's result box reads "<< Result for hand N >>" over "Player S wins
($X)" (or "wins main pot ($X) with (…)"). Until 2026-09-19 the wrapper's feed
dropped the winner's name (the two text nodes touch, and the adjacency test
wanted a positive gap), so every showdown line archived as a nameless "★ wins
…" — which the dashboard then read as HERO's win. This walks every recording's
dom.jsonl, pairs each result box with its hand id, and writes
result.winnerSeat / wonCents / heroWon into hands.db.

    aof-model/.venv/Scripts/python.exe tests/backfill_results.py [--dry]
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEBUG = os.path.join(HERE, "debug")
DB = os.path.join(HERE, "data", "hands.db")
_WIN = re.compile(r"^wins\b.*?\(\$([\d,]+(?:\.\d+)?)\)", re.I)
_ID = re.compile(r"result for hand\s*(\d+)", re.I)


def results_of(session: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    p = os.path.join(DEBUG, session, "dom.jsonl")
    for line in open(p, encoding="utf-8"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        nodes = d.get("nodes") or []
        for n in nodes:
            m = _ID.search(n["text"])
            if not m:
                continue
            hid = m.group(1)
            # the award line sits on the next row of the same box
            row = [x for x in nodes if 12 <= x["y"] - n["y"] <= 40 and abs(x["x"] - n["x"]) < 120]
            win = next((x for x in row if _WIN.match(x["text"])), None)
            if not win:
                continue
            cents = int(round(float(_WIN.match(win["text"]).group(1).replace(",", "")) * 100))
            # the same rule the wrapper uses live (launch._award_name): a wrapped award's
            # text box starts at the row's left edge, so the 'Player N' node sits INSIDE
            # it rather than to its left — prefer the tagged node on the row outright
            same_row = [x for x in row if x is not win and abs(x["y"] - win["y"]) <= 8 and x["x"] <= win["x"] + 4]
            tagged = [x for x in same_row if re.fullmatch(r"Player \d+", x["text"].strip())]
            if tagged:
                name = min(tagged, key=lambda x: abs(x["x"] - win["x"]))["text"].strip()
            else:
                near = [x for x in same_row if -4 <= win["x"] - (x["x"] + x["w"]) < 60]
                name = min(near, key=lambda x: win["x"] - (x["x"] + x["w"]))["text"].strip() if near else ""
            seat = int(re.search(r"Player (\d+)", name).group(1)) if re.search(r"Player (\d+)", name) else None
            rec = {"winnerSeat": seat, "winnerLabel": name or None, "wonCents": cents, "text": win["text"]}
            if hid not in out or (out[hid].get("winnerSeat") is None and seat is not None):
                out[hid] = rec
    return out


def main() -> int:
    dry = "--dry" in sys.argv
    found: dict[str, dict] = {}
    for s in sorted(os.listdir(DEBUG)):
        if s.startswith("session_") and os.path.exists(os.path.join(DEBUG, s, "dom.jsonl")):
            found.update(results_of(s))
    print(f"awards read from recordings: {len(found)} hands, {sum(1 for r in found.values() if r['winnerSeat'] is not None)} with a seat")
    db = sqlite3.connect(DB)
    patched = 0
    for rowid, data in db.execute("select rowid, data from hands").fetchall():
        h = json.loads(data)
        cid = h.get("clientHandId")
        r = found.get(cid) if cid else None
        if not r or r["winnerSeat"] is None:
            continue
        res = dict(h.get("result") or {})
        if res.get("winnerSeat") == r["winnerSeat"] and res.get("wonCents") == r["wonCents"]:
            continue
        res.update({"winnerSeat": r["winnerSeat"], "winnerLabel": r["winnerLabel"], "wonCents": r["wonCents"],
                    "heroWon": r["winnerSeat"] == h.get("heroSeatId"), "backfilled": "2026-09-19 from the recording"})
        if res.get("text", "").startswith("★ wins"):
            res["text"] = f"★ Player {r['winnerSeat']} " + res["text"][2:]
        h["result"] = res
        hero_won = res["heroWon"]
        print(f"  hand {cid} rowid {rowid}: winner seat {r['winnerSeat']} ${r['wonCents']/100:.2f} → {'HERO won' if hero_won else 'hero lost/out'}")
        if not dry:
            db.execute("update hands set data = ?, result_text = ? where rowid = ?", (json.dumps(h), res["text"], rowid))
        patched += 1
    if not dry:
        db.commit()
    print(f"{'would patch' if dry else 'patched'} {patched} archived hands")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
