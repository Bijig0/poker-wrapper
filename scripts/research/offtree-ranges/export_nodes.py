"""Every villain action of the traces as the walk saw it (range entering the node, the node's per-combo strategy + EVs,
full precision from the GTO Wizard cache where it still has the reply, the pot at the node) -> JSON for as_built.ts,
which runs the SHIPPED services/offTree.ts on them.   python export_nodes.py <scratch dir> <out.json>"""
import json, os, pickle, sys
import numpy as np
import common as C, cache

sd, out = sys.argv[1], sys.argv[2]
rows = []
for name, src in (("acts_live.pkl", "live-db"), ("acts_stress.pkl", "stress")):
    for r in pickle.load(open(os.path.join(sd, name), "rb")):
        t = r["taken"]
        # a cheap pre-filter (the shipped detector decides): node share under 2% on the trace's numbers
        rng = r["range"]
        w = rng.sum()
        if not (w > 0) or (rng * r["strat"][t]).sum() / w >= 0.02:
            continue
        x = cache.lookup(r)
        strat = x["strat"] if x is not None else r["strat"]
        evs = x["evs"] if x is not None else r["evs"]
        rows.append({"key": "|".join(map(str, r["key"])), "src": "stress" if src == "stress" else r["origin"], "precise": x is not None,
                     "range": [float(v) for v in rng], "taken": t, "pot": float(r["pot"] or 0),
                     "sols": [{"code": a["code"], "strategy": [float(v) for v in strat[i]],
                               "evs": [None if not np.isfinite(v) else float(v) for v in evs[i]]} for i, a in enumerate(r["acts"])]})
json.dump(rows, open(out, "w"))
print(f"{len(rows)} candidate nodes -> {out}")
