"""The measurement on NL100/NL200 only (Brady 2026-10-06: no NL5 hands in the pool or the fit), with the NL200 pilot's
solved spots (offtreePilot.ts) added to the chain's own traces.

    python measure_nl200.py <hh.pkl> <out.json> <joined.pkl> [<joined.pkl> ...]

Scored actions: every joined villain action not at the NL5 stake. Pool: every hand but the NL5 ones and the scored ones.
Subsets: NL100/200 (all), NL200 only, the pilot's spots only, the chain's own traces only.
"""
from __future__ import annotations
import json, pickle, sys
import numpy as np
import score as S, pool as P
from measure_stakes import block

NL5 = 0.05


def main(hh_p, out_p, *joined_ps):
    hh = pickle.load(open(hh_p, "rb"))
    joined = [r for p in joined_ps for r in pickle.load(open(p, "rb")) if abs(r["stake"] - NL5) > 1e-9]
    seen, uniq = set(), []
    for r in joined:   # one record per (hand, street, codes, actor): the pilot never re-solves a chain hand, but be safe
        k = (r["hand"], r["street"], tuple(r["codes"]), r["actor"])
        if k not in seen:
            seen.add(k); uniq.append(r)
    scored = frozenset(r["hand"] for r in uniq)
    nl5 = frozenset(k for k, h in hh.items() if abs(h["bb"] - NL5) < 1e-9)
    pool = P.Pool(hh, exclude=scored | nl5)
    items = S.prepare(hh, uniq, pool)
    pilot = {(r["hand"], r["street"], "-".join(r["codes"]), r["actor"]) for r in uniq if r.get("pilot")}
    for it in items:
        it["fp_no5"] = it["fp"]
        it["pilot"] = (it["hand"], it["street"], "-".join(it["codes"]), it["actor"]) in pilot
    print(f"pool {pool.decisions} decisions · {len(items)} scored actions ({sum(it['pilot'] for it in items)} from the pilot)")
    subsets = {"NL100/200": items, "NL200": [it for it in items if abs(it["stake"] - 2.0) < 1e-9],
               "pilot": [it for it in items if it["pilot"]], "chain traces": [it for it in items if not it["pilot"]]}
    bands = {"off-tree": lambda it: it["off"], "node < 1%": lambda it: it["node"] < 0.01, "node < 5%": lambda it: it["node"] < 0.05,
             "node < 20%": lambda it: it["node"] < 0.20, "node < 20% aggressive": lambda it: it["node"] < 0.20 and it["kind"] == "wager",
             "node < 20% passive": lambda it: it["node"] < 0.20 and it["kind"] in ("check", "call"), "node >= 20%": lambda it: it["node"] >= 0.20}
    res = {"pool": pool.decisions, "items": len(items), "pilotItems": sum(it["pilot"] for it in items), "rows": []}
    fmt = lambda x: "  n/a" if x is None else f"{x:+.2f}"
    for sname, sub in subsets.items():
        for bname, f in bands.items():
            its = [it for it in sub if f(it)]
            b = block(its, "fp_no5")
            res["rows"].append({"subset": sname, "band": bname, **b})
            cm = b.get("combo", {})
            print(f"{sname:12s} {bname:22s} n={b['n']:4d} in={b['in_range']:4d} | qre {fmt(cm.get('qre'))} soft t={cm.get('soft_t')} {fmt(cm.get('soft'))} "
                  f"(10%: {fmt(cm.get('soft10'))}) pool {fmt(cm.get('pool'))} hyb t={cm.get('hyb_t')} {fmt(cm.get('hyb'))} {np.round(cm.get('hyb_ci', [0, 0]), 2)} (20%: {fmt(cm.get('hyb20'))})")
    json.dump(res, open(out_p, "w"), default=float, indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:])
