"""Every hero decision in every recording, replayed through the live gates.

    aof-model/.venv/Scripts/python.exe tests/replay_decisions.py [session ...] [-v]

For each tick where hero's turn buttons came up, this rebuilds the reconciler as
it stood AT THAT TICK and asks the questions the wrapper asks live:

  * would `_reconciled_line` have marked the line UNCERTAIN (auto-execute held)?
  * which line would /hand have carried — the event log's or the reconciler's?

The regression it guards is the one that cost hand 4919212164 (dashboard #432):
a one-tick misread marking a whole street uncertain, so the pick was never
auto-executed and hero had to act by hand. `held` is the number to drive down —
without driving `uncertain-while-truly-wrong` to zero, which replay_cutover.py
guards from the other side.
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tests"))

import launch  # noqa: E402
from replay_reconcile import archived, ticks_of  # noqa: E402
from reconcile import HandReconciler  # noqa: E402

DEBUG = os.path.join(HERE, "debug")
STREET_AT = {0: "preflop", 3: "flop", 4: "turn", 5: "river"}


def decisions_of(session: str):
    """(hand_no, seq, street, uncertain, source, note) per hero decision."""
    ids_path = os.path.join(DEBUG, session, "hand_ids.json")
    hand_ids = json.load(open(ids_path, encoding="utf-8")) if os.path.exists(ids_path) else {}
    out = []
    for hand_no, ticks in sorted(ticks_of(session).items()):
        if not hand_no or not ticks:
            continue
        cid = hand_ids.get(str(hand_no))
        arch = archived(cid) if cid else None
        hero = (arch or {}).get("heroSeatId") or next(
            (n for tk in ticks for n, s in tk.seats.items() if s.get("hero")), None)
        old = (arch or {}).get("actions") or []
        # hero's voluntary actions, in order: the d-th decision's event line is the
        # archived line up to (not including) hero's d-th one. The recordings carry no
        # event log of their own, and the archive is what the event log became.
        hero_acts = [i for i, a in enumerate(old)
                     if a.get("hero") and a["type"] not in ("post-sb", "post-bb")]
        rc = HandReconciler(hand_no)
        prev_on = False
        d = 0
        for tk in ticks:
            rc.observe(tk)
            on = bool(tk.buttons)
            if on and not prev_on and hero is not None:
                street = STREET_AT.get(tk.board, "preflop")
                cut = hero_acts[d] if d < len(hero_acts) else len(old)
                launch._shadow["rc"], launch._shadow["hand"] = rc, hand_no
                launch._hand_no = hand_no
                launch._ws_state["dealt"] = sorted(rc.dealt)
                _, _, uncertain, note, source = launch._reconciled_line(old[:cut], hero, street)
                out.append({"hand": hand_no, "cid": cid, "seq": tk.seq, "t": tk.t, "street": street,
                            "uncertain": uncertain, "source": source, "note": note,
                            "acted": d < len(hero_acts), "buttons": list(tk.buttons)})
                d += 1
            prev_on = on
    return out


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    sessions = args or sorted(
        d for d in os.listdir(DEBUG)
        if d.startswith("session_") and os.path.exists(os.path.join(DEBUG, d, "log.jsonl")))
    tot = held = 0
    by_reason: dict[str, int] = {}
    for s in sessions:
        ds = decisions_of(s)
        h = [d for d in ds if d["uncertain"]]
        tot += len(ds)
        held += len(h)
        for d in h:
            key = d["uncertain"].split("—")[-1].strip()
            by_reason[key] = by_reason.get(key, 0) + 1
        if ds:
            print(f"{s}: {len(ds)} decisions · {len(h)} held")
        for d in (h if not verbose else ds):
            print(f"    hand {d['hand']:>2} seq {d['seq']:>5} {d['t']} {d['street']:<8} "
                  f"{'HELD — ' + d['uncertain'] if d['uncertain'] else d['source']}")
    print(f"\nTOTAL: {tot} hero decisions · {held} would have been HELD from auto-execute")
    for k, n in sorted(by_reason.items(), key=lambda x: -x[1]):
        print(f"   {n:>3}  {k}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
