"""Tick-by-tick trace of one recorded hand through the level reconciler.

    python tests/trace_reconcile.py session_20260918_192735 8

Prints only the ticks where the table changed (chips, cards, buttons, pot, board)
or the reconciler wrote something, then the derived line against the archive.
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tests"))
from replay_reconcile import ticks_of, archived  # noqa: E402
from reconcile import HandReconciler  # noqa: E402


def trace(session: str, hn: int) -> None:
    ids = json.load(open(os.path.join(HERE, "debug", session, "hand_ids.json")))
    tks = ticks_of(session)[hn]
    rc = HandReconciler(hn)
    print(f"===== {session} hand {hn} ({ids.get(str(hn))}) · {len(tks)} ticks =====")
    lastkey = None
    for tk in tks:
        n0, v0 = len(rc.journal), len(rc.violations)
        rc.observe(tk)
        lv = {n: (s.get("bet") or "-") for n, s in sorted(tk.seats.items())}
        cd = {n: s.get("cards") for n, s in sorted(tk.seats.items())}
        bd = {n: (s.get("badge") or "") for n, s in sorted(tk.seats.items()) if s.get("badge")}
        key = (tuple(lv.items()), tuple(cd.items()), tuple(tk.buttons), tk.pot, tk.board, tuple(bd.items()))
        if key != lastkey or len(rc.journal) > n0 or len(rc.violations) > v0 or rc.ended:
            hero = f" hero={tk.hero}" if tk.hero else ""
            print(f"seq {tk.seq:>4} {tk.t} pot={tk.pot} board={tk.board} bets={lv} cards={cd} badges={bd} btn={tk.buttons[:4]}{hero}")
            for a in rc.journal[n0:]:
                print(f"        + {a['street']} seat {a['seat']} {a['type']} {a['amount']} via {a['via']}" + (f" ({a['note']})" if a.get("note") else ""))
            for a in rc.journal[:n0]:
                if a["retracted"] and a["retracted"]["seq"] == tk.seq:
                    print(f"        - retracted seat {a['seat']} {a['type']}: {a['retracted']['why']}")
            for v in rc.violations[v0:]:
                print(f"        ! {v}")
            lastkey = key
        if rc.ended:
            print("        (ended)")
            break
    rc.finish(tks[-1].seq)
    print("derived:", [(a["street"], a["seat"], a["type"], a["amount"]) for a in rc.line()])
    arch = archived(ids[str(hn)])
    print("archive:", [(a["street"], a["seatId"], a["type"], a.get("amount")) for a in (arch or {}).get("actions", [])],
          "hero seat", (arch or {}).get("heroSeatId"))


if __name__ == "__main__":
    trace(sys.argv[1], int(sys.argv[2]))
