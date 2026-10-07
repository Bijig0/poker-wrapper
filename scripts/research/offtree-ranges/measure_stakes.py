"""The measurement again with NL5 kept apart (2026-10-06, after the Oct 2-4 Ignition downloads): every score for
(a) all scored actions, (b) NL100/NL200 only (no NL5), (c) NL5 only — each with the pool model built from all hands and
from the hands without NL5 (the scored hands always left out of the pool).

    python measure_stakes.py <hh.pkl> <joined.pkl> <out.json> [<items.pkl>]
"""
from __future__ import annotations
import json, pickle, sys
import numpy as np
import score as S, pool as P

NL5 = 0.05


def best(curve):
    return max(curve, key=lambda x: x[1])


def block(items, fpk):
    """the scores of one subset with one pool (fpk = the item field holding that pool's factor)"""
    inr = [it for it in items if S.in_range(it)]
    out = {"n": len(items), "in_range": len(inr)}
    for lvl, sub in (("combo", inr), ("cat", items)):
        if not sub:
            continue
        cs = [(t, S.mean_gain(sub, (lambda tt: (lambda it: S.f_softp(it, tt)))(t), lvl)) for t in S.TP_GRID]
        ch = [(t, S.mean_gain(sub, (lambda tt: (lambda it: S.f_softp(it, tt) * it[fpk]))(t), lvl)) for t in S.TP_GRID]
        bt, bg = best(cs); ht, hg = best(ch)
        out[lvl] = {
            "qre": S.mean_gain(sub, lambda it: it["fq"], lvl), "qre_ci": S.boot_ci(sub, lambda it: it["fq"], lvl=lvl),
            "soft_t": bt, "soft": bg, "soft_ci": S.boot_ci(sub, lambda it: S.f_softp(it, bt), lvl=lvl),
            "soft10": S.mean_gain(sub, lambda it: S.f_softp(it, 0.1), lvl),
            "pool": S.mean_gain(sub, lambda it: it[fpk], lvl), "pool_ci": S.boot_ci(sub, lambda it: it[fpk], lvl=lvl),
            "hyb_t": ht, "hyb": hg, "hyb_ci": S.boot_ci(sub, lambda it: S.f_softp(it, ht) * it[fpk], lvl=lvl),
            "hyb20": S.mean_gain(sub, lambda it: S.f_softp(it, 0.2) * it[fpk], lvl),
        }
    return out


def main(hh_p, joined_p, out_p, items_p=None):
    hh = pickle.load(open(hh_p, "rb"))
    joined = pickle.load(open(joined_p, "rb"))
    scored = frozenset(r["hand"] for r in joined)
    nl5 = frozenset(k for k, h in hh.items() if abs(h["bb"] - NL5) < 1e-9)
    pool_all = P.Pool(hh, exclude=scored)
    pool_no5 = P.Pool(hh, exclude=scored | nl5)
    print(f"pool all: {pool_all.decisions} decisions · pool without NL5: {pool_no5.decisions}")
    items = S.prepare(hh, joined, pool_all)
    for it in items:
        it["fp_all"] = it["fp"]
        rates = np.array([pool_no5.p(it["spot"], c, it["kind"]) for c in range(5)])
        cats = it["cats"]
        it["fp_no5"] = np.where(cats >= 0, rates[np.clip(cats, 0, 4)], 0.0)
        it["nl5"] = abs(it["stake"] - NL5) < 1e-9
    print(f"{len(items)} items ({sum(it['nl5'] for it in items)} NL5)")
    subsets = {"all": items, "no NL5": [it for it in items if not it["nl5"]], "NL5 only": [it for it in items if it["nl5"]]}
    bands = {
        "off-tree": lambda it: it["off"],
        "node < 20%": lambda it: it["node"] < 0.20,
        "node < 20% aggressive": lambda it: it["node"] < 0.20 and it["kind"] == "wager",
        "node < 20% passive": lambda it: it["node"] < 0.20 and it["kind"] in ("check", "call"),
        "node >= 20%": lambda it: it["node"] >= 0.20,
    }
    res = {"pool": {"all": pool_all.decisions, "no NL5": pool_no5.decisions}, "items": len(items), "rows": []}
    for sname, sub in subsets.items():
        for bname, f in bands.items():
            its = [it for it in sub if f(it)]
            for pname, fpk in (("pool all", "fp_all"), ("pool no NL5", "fp_no5")):
                if pname == "pool no NL5" and bname == "node >= 20%":
                    continue
                b = block(its, fpk)
                res["rows"].append({"subset": sname, "band": bname, "pool": pname, **b})
                cm = b.get("combo", {})
                fmt = lambda x: "  n/a" if x is None else f"{x:+.2f}"
                print(f"{sname:9s} {bname:22s} {pname:12s} n={b['n']:4d} in={b['in_range']:4d} | qre {fmt(cm.get('qre'))} "
                      f"soft t={cm.get('soft_t')} {fmt(cm.get('soft'))} {np.round(cm.get('soft_ci', [0, 0]), 2)} (t=10%: {fmt(cm.get('soft10'))}) "
                      f"pool {fmt(cm.get('pool'))} hyb t={cm.get('hyb_t')} {fmt(cm.get('hyb'))} {np.round(cm.get('hyb_ci', [0, 0]), 2)} (t=20%: {fmt(cm.get('hyb20'))})")
    json.dump(res, open(out_p, "w"), default=float, indent=1)
    if items_p:
        pickle.dump(items, open(items_p, "wb"))


if __name__ == "__main__":
    main(*sys.argv[1:])
