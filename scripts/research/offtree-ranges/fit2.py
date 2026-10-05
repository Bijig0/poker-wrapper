"""Second-pass fits on score.py's prepared items: pooled low-frequency band, passive vs aggressive t, hybrids.

    python fit2.py <items.pkl> <out.json>
"""
from __future__ import annotations
import json, math, pickle, sys
import numpy as np
import score as S

TP = S.TP_GRID


def gain_curve(items, mk, lvl):
    return [(p, S.mean_gain(items, mk(p), lvl)) for p in TP]


def best(curve):
    return max(curve, key=lambda x: x[1])


def main(items_p, out_p):
    items = pickle.load(open(items_p, "rb"))
    bands = {
        "off-tree": [it for it in items if it["off"]],
        "node < 5%": [it for it in items if it["node"] < 0.05],
        "node < 20%": [it for it in items if it["node"] < 0.20],
        "node < 20% passive": [it for it in items if it["node"] < 0.20 and it["kind"] in ("check", "call")],
        "node < 20% aggressive": [it for it in items if it["node"] < 0.20 and it["kind"] == "wager"],
        "node < 20% flop wager OOP no bet faced": [it for it in items if it["node"] < 0.20 and it["kind"] == "wager" and it["facing"] == "none" and not it["inPosition"] and it["street"] == "FLOP"],
        "node >= 20%": [it for it in items if it["node"] >= 0.20],
    }
    out = {}
    for name, its in bands.items():
        inr = [it for it in its if S.in_range(it)]
        row = {"n": len(its), "in_range": len(inr)}
        for lvl, sub in (("combo", inr), ("cat", its)):
            if not sub:
                continue
            c_soft = gain_curve(sub, lambda t: (lambda it: S.f_softp(it, t)), lvl)
            c_hyb = gain_curve(sub, lambda t: (lambda it: S.f_softp(it, t) * it["fp"]), lvl)
            bt, bg = best(c_soft)
            ht, hg = best(c_hyb)
            row[lvl] = {
                "qre": S.mean_gain(sub, lambda it: it["fq"], lvl), "qre_ci": S.boot_ci(sub, lambda it: it["fq"], lvl=lvl),
                "pool": S.mean_gain(sub, lambda it: it["fp"], lvl), "pool_ci": S.boot_ci(sub, lambda it: it["fp"], lvl=lvl),
                "soft_t": bt, "soft": bg, "soft_ci": S.boot_ci(sub, lambda it: S.f_softp(it, bt), lvl=lvl), "soft_curve": c_soft,
                "hyb_t": ht, "hyb": hg, "hyb_ci": S.boot_ci(sub, lambda it: S.f_softp(it, ht) * it["fp"], lvl=lvl), "hyb_curve": c_hyb,
                # the off-tree band scored at t fitted on the pooled low-frequency band (out-of-sample-ish check)
            }
        out[name] = row
        def f(x):
            return "n/a" if x is None else f"{x:+.2f}"
        cm, ct = row.get("combo", {}), row.get("cat", {})
        print(f"{name:42s} n={row['n']:4d} in={row['in_range']:4d} | combo: qre {f(cm.get('qre'))} pool {f(cm.get('pool'))} "
              f"soft t={cm.get('soft_t')} {f(cm.get('soft'))} {np.round(cm.get('soft_ci', [0, 0]), 2)} hyb t={cm.get('hyb_t')} {f(cm.get('hyb'))} "
              f"| cat: qre {f(ct.get('qre'))} pool {f(ct.get('pool'))} soft t={ct.get('soft_t')} {f(ct.get('soft'))} hyb t={ct.get('hyb_t')} {f(ct.get('hyb'))}")
    # transfer check: t fitted on node 1-20% (excluding off-tree) applied to the off-tree band
    train = [it for it in items if 0.01 <= it["node"] < 0.20 and not it["off"]]
    tr_in = [it for it in train if S.in_range(it)]
    t_star = best(gain_curve(tr_in, lambda t: (lambda it: S.f_softp(it, t)), "combo"))[0]
    test = bands["off-tree"]
    te_in = [it for it in test if S.in_range(it)]
    out["transfer"] = {"t_train": t_star, "train_n": len(tr_in),
                       "offtree_combo": S.mean_gain(te_in, lambda it: S.f_softp(it, t_star), "combo"),
                       "offtree_cat": S.mean_gain(test, lambda it: S.f_softp(it, t_star), "cat"),
                       "offtree_combo_ci": S.boot_ci(te_in, lambda it: S.f_softp(it, t_star)),
                       "offtree_cat_ci": S.boot_ci(test, lambda it: S.f_softp(it, t_star), lvl="cat")}
    print("transfer", out["transfer"])
    json.dump(out, open(out_p, "w"), indent=1, default=float)


if __name__ == "__main__":
    main(*sys.argv[1:])
