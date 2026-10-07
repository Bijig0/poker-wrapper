"""Every villain action the postflop AI chain walked, from the stored solve traces, with the node's numbers.

RESEARCH ONLY (2026-10-06, offtree-ranges). Read-only on the databases named below; writes one pickle.

    python extract.py <poker.sqlite> <out.pkl> [--origins live,backtest,...]

One record per (hand, street, codes before the action, actor seat): the actor's range ENTERING the node (the street's
rangesIn walked through every earlier action of the street, exactly as aiChain does), every action's per-combo
strategy and EV (1326 combos, GTO Wizard order), the action taken, the pot. Hero's own actions are skipped.
Trace strategies are rounded to 4 dp by the trace writer: fine for EVs, coarse for the thinnest QRE slivers
(see cache.py for the full-precision node read from the GTO Wizard node cache).
"""
from __future__ import annotations
import gzip, json, pickle, sqlite3, sys
import numpy as np

SIX = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]


def preflop_aggressor(line: str, dealt=None):
    """The last raiser of the preflop line ('F-F-C-R5-C-F-C'), seats in 6-max order (or the trace's dealt seats)."""
    seats = [p for p in SIX if not dealt or p in dealt]
    codes = [c for c in (line or "").split("-") if c]
    live = seats[:]
    i, agg = 0, None
    for c in codes:
        if not live:
            break
        p = live[i % len(live)]
        if c.startswith("R"):
            agg = p
        if c == "F":
            live.remove(p)
            continue
        i += 1
    return agg


PREF = {"live": 0, "backtest": 1, "warm": 2, "replay": 3, "adhoc": 4, "stress": 5}


def kind_of(code: str) -> str:
    if code == "F": return "fold"
    if code == "X": return "check"
    if code == "C": return "call"
    return "wager"   # R<size> = bet or raise (incl. all-in)


def main(db, out, origins=None):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    q = "select id, origin, client_hand_id, hero_cards, hero_pos, board, trace, ts, line from solves where tier='ai-chain' and trace is not null"
    recs = {}
    n_tr = 0
    for sid, origin, hand, hero_cards, hero_pos, board, blob, ts, sline in c.execute(q):
        if origins and origin not in origins:
            continue
        try:
            t = json.loads(gzip.decompress(blob))
        except Exception:
            continue
        n_tr += 1
        spec = t.get("spec") or {}
        hero = spec.get(f"{spec.get('heroSeat')}Pos") or hero_pos
        streets = t.get("streets") or []
        nodes = t.get("nodes") or []
        dealt = spec.get("dealt")
        dealt = [d.get("pos") if isinstance(d, dict) else d for d in dealt] if isinstance(dealt, list) else None
        prev_agg = preflop_aggressor((sline or "").split(" / ")[0], dealt)
        for si, s in enumerate(streets):
            street_agg = None
            players = s.get("players") or []
            rin = s.get("rangesIn") or []
            if len(rin) != len(players) or not players:
                continue
            ranges = [np.asarray(r, dtype=np.float64) for r in rin]
            # seats leave the street when they fold: the node's actor index is into the LIVE seats? No — aiChain keeps
            # `seats` for the whole street and only drops folded seats when the street closes, so actor indexes players.
            for nd in nodes:
                if nd.get("si", 0) != si or nd.get("street") != s.get("street"):
                    continue
                if nd.get("fromCheckpoint"):
                    pass
                acts = nd.get("actions") or []
                ti = nd.get("taken")
                a = nd.get("actor")
                if a is None or a >= len(players):
                    break
                if ti is None or nd.get("heroNode"):
                    continue
                pos = players[a]
                strat = [np.asarray(x.get("strategy") or [0] * 1326, dtype=np.float64) for x in acts]
                evs = [np.asarray(x.get("evs") or [np.nan] * 1326, dtype=np.float64) for x in acts]
                if pos != hero:
                    key = (str(hand), s.get("street"), "-".join(nd.get("codes") or []), pos)
                    pref = PREF.get(origin, 9)
                    old = recs.get(key)
                    # the preferred origin wins; within one origin the LATEST trace (a re-run on newer code)
                    if old is None or pref < old["pref"] or (pref == old["pref"] and (ts or 0) > (old["ts"] or 0)):
                        recs[key] = {
                            "key": key, "pref": pref, "origin": origin, "solve": sid, "hand": str(hand), "ts": ts,
                            "street": s.get("street"), "board": nd.get("board") or s.get("board"),
                            "codes": list(nd.get("codes") or []), "actor": pos, "players": list(players),
                            "inPosition": a == len(players) - 1, "hero": hero, "heroCards": hero_cards,
                            "pot": nd.get("potNode"), "range": ranges[a].copy(),
                            "acts": [{"code": x.get("code"), "name": x.get("name"), "betsize": x.get("betsize"),
                                      "freq": x.get("totalFrequency")} for x in acts],
                            "strat": np.vstack(strat) if strat else None, "evs": np.vstack(evs) if evs else None,
                            "taken": ti, "solId": s.get("solId"), "prevAgg": prev_agg, "pfLine": (sline or "").split(" / ")[0],
                        }
                if 0 <= ti < len(strat):
                    ranges[a] = ranges[a] * strat[ti]
                    if str(acts[ti].get("code", "")).startswith("R"):
                        street_agg = pos
            prev_agg = street_agg
    with open(out, "wb") as f:
        pickle.dump(list(recs.values()), f)
    print(f"{n_tr} traces -> {len(recs)} villain actions -> {out}")


if __name__ == "__main__":
    args = sys.argv[1:]
    origins = None
    if "--origins" in args:
        i = args.index("--origins"); origins = set(args[i + 1].split(",")); del args[i:i + 2]
    main(args[0], args[1], origins)
