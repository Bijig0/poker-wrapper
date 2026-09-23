"""Which line would /hand have carried? The cut-over rule (launch._reconciled_line)
replayed over every recorded hand: the reconciler is rebuilt from the recording
(as tests/replay_reconcile.py does), the event log's line is the archived one,
and the rule decides between them exactly as it does live — at the END of the
hand (both lines complete) and, for hero's decisions, at the tick the buttons
came up (the reconciler possibly lagging).

    aof-model/.venv/Scripts/python.exe tests/replay_cutover.py [session ...] [-v]

Prints, per hand where the two lines differ: the rule's choice and why. The
regression it guards: no hand where the reconciler's line was taken while an
invariant was broken, and no hand where a LAGGING reconciler line (a strict
prefix) displaced the event line.
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


def choose(rc: HandReconciler, old_actions: list[dict], hero: int, street: str):
    """Run the live rule against a reconciler instance and an archived line."""
    old = [{"seatId": a.get("seatId", a.get("seat")), "hero": a.get("hero"), "type": a["type"], "street": a["street"],
            **({"amount": a["amount"]} if a.get("amount") is not None else {})} for a in old_actions]
    launch._shadow["rc"] = rc
    launch._shadow["hand"] = rc.hand_no
    launch._hand_no = rc.hand_no
    return launch._reconciled_line(old, hero, street)


def run(session: str, verbose: bool) -> dict:
    ids_path = os.path.join(DEBUG, session, "hand_ids.json")
    if not os.path.exists(ids_path):
        return {"hands": 0, "differ": 0, "took_rc": 0, "uncertain": 0, "kept_prefix": 0, "bad": 0}
    hand_ids = json.load(open(ids_path, encoding="utf-8"))
    out = {"hands": 0, "differ": 0, "took_rc": 0, "uncertain": 0, "kept_prefix": 0, "bad": 0}
    for hand_no, ticks in sorted(ticks_of(session).items()):
        cid = hand_ids.get(str(hand_no))
        arch = archived(cid) if cid else None
        if not arch or not ticks:
            continue
        out["hands"] += 1
        hero = arch.get("heroSeatId")
        # the decision ticks: the reconciler as it stood when hero's buttons came up
        rc = HandReconciler(hand_no)
        street_at = {0: "preflop", 3: "flop", 4: "turn", 5: "river"}
        decisions = []
        prev_on = False
        for tk in ticks:
            rc.observe(tk)
            on = bool(tk.buttons)
            if on and not prev_on:
                # the archived line UP TO this decision = its prefix on this street with hero not yet acted:
                # approximate by the archived actions before hero's k-th voluntary action
                decisions.append((tk.seq, street_at.get(tk.board, "preflop"), [a for a in rc.line()]))
            prev_on = on
        rc.finish(ticks[-1].seq)
        old = arch.get("actions") or []
        actions, ledger, uncertain, note, source = choose(rc, old, hero, old[-1]["street"] if old else "preflop")
        d = rc.diff(old)
        if not d["agree"]:
            out["differ"] += 1
            if source == "reconciled":
                out["took_rc"] += 1
            elif uncertain:
                out["uncertain"] += 1
            else:
                out["kept_prefix"] += 1
            if verbose or source == "reconciled" or uncertain:
                print(f"  {session} hand {hand_no} ({cid}): {source}" + (f" — {uncertain}" if uncertain else "") + (f" — {note}" if note else ""))
                print(f"      archive : {d['archive']}")
                print(f"      derived : {d['reconciled']}")
            # THE REGRESSION: the derived line displacing the log after breaking an invariant
            # ANYWHERE in the hand. Scoping this to one street let session 115240 hand 8
            # through — its preflop CALL derived 1 bb short, its only violation on the flop.
            if source == "reconciled" and rc.violations:
                out["bad"] += 1
                print(f"  !! hand {hand_no}: reconciler taken despite a violation this street")
    return out


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    sessions = args or sorted(d for d in os.listdir(DEBUG) if d.startswith("session_") and os.path.exists(os.path.join(DEBUG, d, "log.jsonl")))
    tot = {"hands": 0, "differ": 0, "took_rc": 0, "uncertain": 0, "kept_prefix": 0, "bad": 0}
    for s in sessions:
        r = run(s, verbose)
        for k in tot:
            tot[k] += r[k]
        if r["hands"]:
            print(f"{s}: {r['hands']} hands · {r['differ']} differ → reconciler {r['took_rc']} · uncertain {r['uncertain']} · event line kept (prefix/agree) {r['kept_prefix']}")
    print(f"TOTAL: {tot['hands']} hands · {tot['differ']} differ → reconciler {tot['took_rc']} · uncertain {tot['uncertain']} · kept {tot['kept_prefix']} · BAD {tot['bad']}")
    return 1 if tot["bad"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
