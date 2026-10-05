"""Pool action rates by hand category and spot, from Ignition's downloaded histories (every seat's cards: no showdown bias).

For every postflop decision of every non-hero seat:
  spot = street · facing (none / bet / betcall / raise) · IP|OOP (last to act among the live seats at the street's
         start) · agg|notagg (the actor made the previous street's last wager; preflop = the last raiser) · HU|MW
  kind = check / wager (bet, raise, all-in) when facing none; fold / call / wager when facing a wager
  cat  = common.category(hole, board) (air / draw / weak pair / top pair-overpair / two pair+)

    P(kind | cat, spot) with backoff: full spot -> street·facing·ip·agg -> street·facing -> facing (alpha pseudo-counts)
"""
from __future__ import annotations
from collections import defaultdict
import common as C

ORDER = ["SB", "BB", "UTG", "HJ", "CO", "BTN"]
KIND = {"Checks": "check", "Bets": "wager", "Raises": "wager", "All-in": "wager", "All-in(raise)": "wager",
        "Calls": "call", "Folds": "fold"}


def decisions(h):
    """Yield (street, pos, spotKey tuple, kind, index within the street's actions) for every postflop decision."""
    acts = h["acts"]
    live = [p for p in ORDER if p in h["cards"]]
    folded = set()
    prev_agg = None
    for s, p, k, a in acts:   # preflop aggressor
        if s == 0:
            if k in ("Raises", "All-in(raise)") or (k == "All-in" and a):
                prev_agg = p
            if k == "Folds":
                folded.add(p)
    for st in (1, 2, 3):
        if len(h["board"]) < 2 + st:
            break
        inhand = [p for p in live if p not in folded]
        if len(inhand) < 2:
            break
        ip = inhand[-1]
        mw = "HU" if len(inhand) == 2 else "MW"
        wagers, calls_since, street_agg = 0, 0, None
        idx = 0
        for s, p, k, a in acts:
            if s != st or p not in inhand:
                continue
            kind = KIND.get(k)
            if kind is None:
                continue
            facing = "none" if wagers == 0 else ("raise" if wagers >= 2 else ("betcall" if calls_since else "bet"))
            if facing == "none" and kind == "call":
                kind = "check"
            if facing != "none" and kind == "check":
                kind = "call"
            if facing != "none" and k == "All-in":   # an all-in that only matches the wager is a call
                kind = "call"
            key = (st, facing, "IP" if p == ip else "OOP", "agg" if p == prev_agg else "notagg", mw)
            yield st, p, key, kind, idx
            idx += 1
            if kind == "wager":
                wagers += 1; calls_since = 0; street_agg = p
            elif kind == "call":
                calls_since += 1
            elif kind == "fold":
                folded.add(p)
        prev_agg = street_agg   # None when the street checked through


def levels(key):
    st, facing, ip, agg, mw = key
    return [key, (st, facing, ip, agg), (st, facing), (facing,)]


class Pool:
    def __init__(self, hands, exclude=frozenset(), alpha=20.0):
        self.alpha = alpha
        self.n = defaultdict(float)      # (level key, cat, kind) -> count
        self.nc = defaultdict(float)     # (level key, cat) -> count
        self.decisions = 0
        for hid, h in hands.items():
            if hid in exclude:
                continue
            for st, p, key, kind, idx in decisions(h):
                if p == h.get("hero"):
                    continue
                cards = h["cards"].get(p)
                if not cards:
                    continue
                board = [C.card_idx(c) for c in h["board"][:2 + st]]
                cat = C.category(C.card_idx(cards[0]), C.card_idx(cards[1]), board)
                for lk in levels(key):
                    self.n[(lk, cat, kind)] += 1
                    self.nc[(lk, cat)] += 1
                self.decisions += 1

    def p(self, key, cat, kind):
        lv = levels(key)[::-1]
        # top of the backoff: facing-only rate with a flat prior over the kinds the facing allows
        kinds = ["check", "wager"] if key[1] == "none" else ["fold", "call", "wager"]
        prob = 1.0 / len(kinds)
        for lk in lv:
            prob = (self.n[(lk, cat, kind)] + self.alpha * prob) / (self.nc[(lk, cat)] + self.alpha)
        return prob

    def count(self, key, kind=None):
        if kind is None:
            return sum(self.nc[(key, c)] for c in range(5))
        return sum(self.n[(key, c, kind)] for c in range(5))
