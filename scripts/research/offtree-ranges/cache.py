"""Full-precision node reads from the GTO Wizard node caches (zero requests).

The trace writer rounds strategies to 4 dp, which erases the thin QRE slivers this study is about. The node cache
keeps GTO Wizard's reply whole: gtow_cache_nodes(key, addr, reply) with addr = preflop|flop|turn|river|board, the
chain's street trees starting at their own street (a turn tree: '||<codes>||<4 cards>').

    lookup(record) -> {"range", "strat", "evs", "codes", "key"} or None
Several trees can share an address (re-created with other sizes); the one whose strategies agree with the trace's
rounded ones (and whose action codes are the same) wins.
"""
from __future__ import annotations
import gzip, json, sqlite3, zlib
import numpy as np

CACHES = [r"C:\Users\Brady\poker-data\gtow-cache.sqlite", r"C:\Users\Brady\poker-data-stress500\root\gtow-cache.sqlite"]
SIDX = {"FLOP": 1, "TURN": 2, "RIVER": 3}
_conns = None


def conns():
    global _conns
    if _conns is None:
        _conns = [sqlite3.connect(f"file:{p}?mode=ro", uri=True) for p in CACHES]
    return _conns


def dec(b):
    if b is None:
        return None
    if b[:2] == b"\x1f\x8b":
        b = gzip.decompress(b)
    elif b[:1] == b"x":
        b = zlib.decompress(b)
    return json.loads(b)


def addr_of(street: str, codes: list[str], board: str) -> str:
    parts = ["", "", "", ""]
    parts[SIDX[street]] = "-".join(codes)
    return "|".join(parts) + "|" + board


def lookup(r: dict):
    addr = addr_of(r["street"], r["codes"], r["board"])
    want = [a["code"] for a in r["acts"]]
    best, best_err = None, 1e9
    for c in conns():
        for key, blob in c.execute("select key, reply from gtow_cache_nodes where addr=? and status=200", (addr,)):
            try:
                d = dec(blob)
            except Exception:
                continue
            sols = d.get("action_solutions") or []
            codes = [s["action"]["code"] for s in sols]
            if codes != want:
                continue
            strat = np.array([s["strategy"] for s in sols], dtype=np.float64)
            err = float(np.abs(strat - r["strat"]).max())
            if err < best_err:
                pos = sols[0]["action"]["position"]
                pi = next((p for p in d["players_info"] if p["player"]["position"] == pos), None)
                if pi is None:
                    continue
                best_err = err
                best = {"range": np.array(pi["range"], dtype=np.float64), "strat": strat,
                        "evs": np.array([s["evs"] for s in sols], dtype=np.float64), "key": key, "err": err,
                        "hand_cat": d.get("hand_categories_range"), "draw_cat": d.get("draw_categories_range")}
    if best is not None and best_err > 0.002:   # not the same tree as the trace's
        return None
    return best
