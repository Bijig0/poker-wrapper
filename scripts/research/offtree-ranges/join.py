"""Join the chain's villain actions (extract.py) with Ignition's hand histories (hh_parse.py): villain's real cards.

    python join.py <acts.pkl> <hh.pkl> <out.pkl>

Kept only when the history agrees with the trace: hero's cards and seat, the board, and the action itself (the HH
action at that place in the street is the actor's and of the same kind).
"""
from __future__ import annotations
import pickle, sys
from collections import Counter
import numpy as np
import common as C

KIND = {"Checks": "check", "Bets": "wager", "Raises": "wager", "All-in": "wager", "All-in(raise)": "wager",
        "Calls": "call", "Folds": "fold"}
ST = {"FLOP": 1, "TURN": 2, "RIVER": 3}


def code_kind(code: str) -> str:
    return {"F": "fold", "X": "check", "C": "call"}.get(code, "wager")


def hh_kind(kind: str, amts, facing: bool) -> str:
    k = KIND.get(kind, "?")
    if kind == "All-in" and not facing:
        return "wager"
    return k


def main(acts_p, hh_p, out):
    acts = pickle.load(open(acts_p, "rb"))
    hh = pickle.load(open(hh_p, "rb"))
    why = Counter()
    keep = []
    for r in acts:
        # a pilot spot (offtreePilot.ts, client id "pilot-<hand>"): the chain's hero is whichever player it answered for,
        # not Brady's [ME] seat — that player's seat and cards are the history's hero for the checks below
        if str(r["hand"]).startswith("pilot-"):
            base = hh.get(str(r["hand"])[6:])
            h = dict(base, hero=r["hero"]) if base else None
            if h is not None:
                r = dict(r, hand=str(r["hand"])[6:], pilot=True)
        else:
            h = hh.get(r["hand"])
        if h is None:
            why["no history"] += 1
            continue
        board = C.parse_board(r["board"])
        hb = [C.card_idx(c) for c in h["board"]]
        if set(board) - set(hb):
            why["board differs"] += 1
            continue
        vc = h["cards"].get(r["actor"])
        if not vc:
            why["actor not dealt"] += 1
            continue
        hc = r.get("heroCards") or ""
        hero_cards = [C.card_idx(hc[i:i + 2]) for i in range(0, len(hc), 2)] if hc else []
        if h.get("hero") and h["hero"] != r["hero"]:
            why["hero seat differs"] += 1
            continue
        if hero_cards and h["hero"] and set(hero_cards) != {C.card_idx(c) for c in h["cards"].get(h["hero"], [])}:
            why["hero cards differ"] += 1
            continue
        # the action at this place in the street, among the chain's seats
        st = ST.get(r["street"])
        seq = [(p, k, a) for s, p, k, a in h["acts"] if s == st and p in r["players"]]
        i = len(r["codes"])
        code = r["acts"][r["taken"]]["code"]
        if i >= len(seq):
            why["action missing in HH"] += 1
            continue
        p, k, a = seq[i]
        if p != r["actor"]:
            why["actor differs at this place"] += 1
            continue
        kk = KIND.get(k, "?")
        if kk != code_kind(code) and not (kk == "wager" and code_kind(code) == "call") and not (kk == "call" and code_kind(code) == "wager"):
            why[f"kind differs ({kk} vs {code_kind(code)})"] += 1
            continue
        if kk != code_kind(code):
            why["call/all-in kind looseness (kept)"] += 1
        r = dict(r)
        r["villainCards"] = vc
        r["villainCombo"] = C.combo_idx(vc[0], vc[1])
        r["heroCardIdx"] = hero_cards
        r["boardIdx"] = board
        r["stake"] = h["bb"]
        r["fmt"] = h["fmt"]
        keep.append(r)
        why["kept"] += 1
    print(dict(why))
    pickle.dump(keep, open(out, "wb"))


if __name__ == "__main__":
    main(*sys.argv[1:4])
