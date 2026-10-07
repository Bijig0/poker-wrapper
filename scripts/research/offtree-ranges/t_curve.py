"""The soft range's T on the trigger bands, NL100/NL200 only (Brady: no NL5), with paired bootstrap intervals.

    python t_curve.py <hh.pkl> <out.json> <joined.pkl> [<joined.pkl> ...]

Bands: off-tree by today's rule (share < 1% and no hand > 2%), share < 1% alone (the detector branch's trigger), share
< 5%. For T in {5, 10, 20, 30, 50, 75, 100}% of the pot: mean bits per action (hand in range) against ignoring the
action, 90% interval; and the paired difference against today's T = 10%.
"""
from __future__ import annotations
import json, math, pickle, sys
import numpy as np
import score as S, pool as P

TS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0]


def main(hh_p, out_p, *joined_ps):
    hh = pickle.load(open(hh_p, "rb"))
    joined = [r for p in joined_ps for r in pickle.load(open(p, "rb")) if abs(r["stake"] - 0.05) > 1e-9]
    seen, uniq = set(), []
    for r in joined:
        k = (r["hand"], r["street"], tuple(r["codes"]), r["actor"])
        if k not in seen:
            seen.add(k); uniq.append(r)
    nl5 = frozenset(k for k, h in hh.items() if abs(h["bb"] - 0.05) < 1e-9)
    pool = P.Pool(hh, exclude=frozenset(r["hand"] for r in uniq) | nl5)
    items = [it for it in S.prepare(hh, uniq, pool) if S.in_range(it)]
    bands = {"off-tree (today's rule)": lambda it: it["off"], "share < 1% (detector branch)": lambda it: it["node"] < 0.01,
             "share < 5%": lambda it: it["node"] < 0.05}
    rng = np.random.default_rng(3)
    out = {}
    for name, f in bands.items():
        its = [it for it in items if f(it)]
        base = np.array([S.logp(it, np.ones(1326)) for it in its])
        g = {t: (np.array([S.logp(it, S.f_softp(it, t)) for it in its]) - base) / math.log(2) for t in TS}
        q = (np.array([S.logp(it, it["fq"]) for it in its]) - base) / math.log(2)
        idx = [rng.integers(0, len(its), len(its)) for _ in range(1000)]
        ci = lambda a: [float(np.percentile([a[i].mean() for i in idx], 5)), float(np.percentile([a[i].mean() for i in idx], 95))]
        rows = {f"{int(t * 100)}%": {"gain": float(g[t].mean()), "ci": ci(g[t]), "vs10": float((g[t] - g[0.1]).mean()), "vs10_ci": ci(g[t] - g[0.1])} for t in TS}
        out[name] = {"n": len(its), "qre": float(q.mean()), "qre_ci": ci(q), "soft": rows}
        print(f"== {name}: {len(its)} actions with the hand in range · QRE {q.mean():+.2f} [{ci(q)[0]:+.2f},{ci(q)[1]:+.2f}]")
        for t in TS:
            r = rows[f"{int(t * 100)}%"]
            print(f"   T {int(t * 100):3d}% pot: {r['gain']:+.3f} [{r['ci'][0]:+.3f},{r['ci'][1]:+.3f}]   vs 10%: {r['vs10']:+.3f} [{r['vs10_ci'][0]:+.3f},{r['vs10_ci'][1]:+.3f}]")
    json.dump(out, open(out_p, "w"), indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:])
