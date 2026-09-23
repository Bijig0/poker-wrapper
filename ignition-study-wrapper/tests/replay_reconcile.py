"""Replay every debug recording through the level reconciler and diff each hand's
derived line against what the wrapper archived (hands.db, by client hand id).

    python tests/replay_reconcile.py            # every recording with hand ids
    python tests/replay_reconcile.py session_20260918_192735 [--hand 12] [-v]

Writes debug/<session>/shadow_report.json and prints the divergences. This is
the regression suite for the capture: a change to the live logger or to the
reconciler has to keep (or improve) every recorded hand.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from reconcile import HandReconciler, Tick, bb  # noqa: E402

DEBUG = os.path.join(HERE, "debug")
DB = os.path.join(HERE, "data", "hands.db")


def archived(client_id: str) -> dict | None:
    db = sqlite3.connect(DB)
    row = db.execute("select data from hands where data like ? order by rowid desc limit 1", (f'%"{client_id}"%',)).fetchone()
    db.close()
    if not row:
        return None
    d = json.loads(row[0])
    return d if d.get("clientHandId") == client_id else None


def ticks_of(session: str):
    """log.jsonl rows -> Tick, grouped by the wrapper's hand number."""
    path = os.path.join(DEBUG, session, "log.jsonl")
    hands: dict[int, list[Tick]] = {}
    for line in open(path, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        seats = {}
        hero = None
        for num, s in (r.get("seats") or {}).items():
            n = int(num)
            seats[n] = {"stack": s.get("stack"), "bet": s.get("bet"), "cards": s.get("cards") or 0,
                        "dealer": bool(s.get("dealer")), "hero": bool(s.get("hero")), "badge": s.get("badge")}
            if s.get("hero"):
                hero = n
        pot = bb(r.get("pot"))
        hands.setdefault(r.get("hand") or 0, []).append(Tick(
            seq=r["seq"], t=r.get("t", ""), seats=seats, pot=pot, board=len(r.get("board") or []),
            buttons=list(r.get("actions") or []), hero=hero))
    return hands


def run(session: str, only_hand: int | None = None, verbose: bool = False) -> dict:
    ids_path = os.path.join(DEBUG, session, "hand_ids.json")
    if not os.path.exists(ids_path):
        return {"session": session, "hands": [], "note": "no hand ids"}
    ids = {int(k): v for k, v in json.load(open(ids_path)).items()}
    hands = ticks_of(session)
    report = {"session": session, "hands": []}
    for hand_no, cid in sorted(ids.items()):
        if only_hand and hand_no != only_hand:
            continue
        tks = hands.get(hand_no) or []
        arch = archived(cid)
        if not tks or not arch:
            report["hands"].append({"hand": hand_no, "clientHandId": cid, "skipped": "no frames" if not tks else "not archived"})
            continue
        rc = HandReconciler(hand_no)
        for tk in tks:
            rc.observe(tk)
        rc.finish(tks[-1].seq)
        d = rc.diff(arch.get("actions") or [])
        entry = {"hand": hand_no, "clientHandId": cid, "frames": len(tks), "agree": d["agree"],
                 "archive_only": d["archive_only"], "reconciled_only": d["reconciled_only"], "changed": d["changed"],
                 "violations": rc.violations, "retractions": [a for a in rc.journal if a["retracted"]],
                 "line": d["reconciled"], "archive": d["archive"]}
        report["hands"].append(entry)
        flag = "OK " if d["agree"] and not rc.violations else "!! "
        print(f"{flag}{session} hand {hand_no:>2} ({cid}) frames={len(tks):>4} "
              f"{'agree' if d['agree'] else 'DIFF'} · {len(rc.violations)} violation(s) · {len(entry['retractions'])} retraction(s)")
        if verbose or not d["agree"] or rc.violations:
            for x in d["archive_only"]:
                print(f"      archive only : {x}")
            for x in d["reconciled_only"]:
                print(f"      derived only : {x}")
            for x in d["changed"]:
                print(f"      changed      : archive {x['archive']} → derived {x['reconciled']}")
            for v in rc.violations[:6]:
                print(f"      violation    : seq {v['seq']} {v['street']} — {v['what']} {({k: v[k] for k in v if k not in ('seq','street','what')})}")
            for a in entry["retractions"]:
                print(f"      retracted    : seat {a['seat']} {a['type']} (via {a['via']}, seq {a['seq']}) — {a['retracted']['why']}")
            if verbose:
                print("      derived line :", d["reconciled"])
                print("      archive line :", d["archive"])
    out = os.path.join(DEBUG, session, "shadow_report.json")
    json.dump(report, open(out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    return report


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    only_hand = int(args[args.index("--hand") + 1]) if "--hand" in args else None
    sessions = [a for a in args if a.startswith("session_")] or sorted(
        s for s in os.listdir(DEBUG) if os.path.exists(os.path.join(DEBUG, s, "hand_ids.json"))
        and os.path.exists(os.path.join(DEBUG, s, "log.jsonl")))
    tot = agree = viol = 0
    for s in sessions:
        r = run(s, only_hand, verbose)
        for h in r["hands"]:
            if h.get("skipped"):
                continue
            tot += 1
            agree += 1 if h["agree"] else 0
            viol += 1 if h["violations"] else 0
    print(f"\n{tot} hands · {agree} agree with the archive · {tot - agree} differ · {viol} with invariant violations")
