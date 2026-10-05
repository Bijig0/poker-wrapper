"""Attach what the SHIPPED code carries (as_built.ts output) to every node of the page's data.

    python attach_built.py <offtree_data.json> <nodes_in.json> <as_built.json> <out.json>

Per node `built`:
  soft          the shipped detector flags it; `combos`/`grid`/`mix` = the soft range the walk now carries (board and
                hero cards removed for display, as the other grids)
  downstream    the range entering the node was already collapsed by an earlier off-tree action of the same seat; with
                the build that earlier node carries the soft range, so this node sits on a different tree (new solve)
  not-flagged   the shipped detector does not flag it (`why`)
"""
import json, sys
import numpy as np
import common as C

data_p, in_p, built_p, out_p = sys.argv[1:5]
d = json.load(open(data_p))
nodes_in = {r["key"]: r for r in json.load(open(in_p))}
built = {r["key"]: r for r in json.load(open(built_p))}
ST = ["FLOP", "TURN", "RIVER"]


def key(n):
    return "|".join([n["hand"], n["street"], "-".join(n["codes"]), n["actor"]])


def r4(x):
    return float(f"{x:.4g}")


counts = {"soft": 0, "downstream": 0, "not-flagged": 0}
for n in d["nodes"]:
    k = key(n)
    b = built.get(k)
    board = C.parse_board(n["board"])
    hc = n.get("heroCards") or ""
    hero = [C.card_idx(hc[i:i + 2]) for i in range(0, len(hc), 2)] if len(hc) >= 4 else []
    legal = ~C.blocked_mask(board + hero)
    if b and "soft" in b:
        s = np.where(legal, np.array(b["soft"]), 0.0)
        cats = C.categories(board)
        tot = float(s.sum())
        g = np.zeros(169); np.add.at(g, C.COMBO_CELL, s)
        n["built"] = {"status": "soft", "combos": r4(tot), "grid": [r4(x) for x in g],
                      "mix": [round(float(s[cats == c].sum() / tot), 4) if tot > 0 else 0 for c in range(5)],
                      "qreCombos": r4(float(b["qreCombos"])), "t": b["t"]}
        counts["soft"] += 1
        continue
    earlier = [x for x in d["nodes"] if x["hand"] == n["hand"] and x["actor"] == n["actor"] and x is not n and
               (ST.index(x["street"]) < ST.index(n["street"]) or (x["street"] == n["street"] and len(x["codes"]) < len(n["codes"])))]
    r = nodes_in.get(k)
    if r is None or earlier:
        n["built"] = {"status": "downstream", "why": "his range entering this node was already collapsed by an earlier off-tree action of his in this hand; "
                      "with the build that node carries the soft range, so this one sits on a different tree (a new solve, not computable offline)"}
        counts["downstream"] += 1
        continue
    rng = np.array(r["range"]); st = np.array(r["sols"][r["taken"]]["strategy"])
    live = rng >= 0.01 * rng.max()
    i = int(np.argmax(np.where(live, st, 0)))
    blocked = C.blocked_mask(hero)[i]
    n["built"] = {"status": "not-flagged",
                  "why": f"the shipped detector does not flag it: {C.CLASS169[i]} ({'a combo holding one of hero\'s cards, which the walk\'s range keeps' if blocked else 'a combo in his range'}) "
                         f"takes the action {100 * st[i]:.1f}% (over the 2% bar); his range stays the QRE narrowing"}
    counts["not-flagged"] += 1

extra = [k for k in built if k not in {key(n) for n in d["nodes"]}]
softs = [n["built"] for n in d["nodes"] if n["built"]["status"] == "soft"]
d["asBuilt"] = {"counts": counts, "flaggedByShipped": len(built), "extraFlagged": len(extra), "t": 0.10,
                "medianQre": float(np.median([b["qreCombos"] for b in softs])), "medianSoft": float(np.median([b["combos"] for b in softs])),
                "commit": None}
json.dump(d, open(out_p, "w"), separators=(",", ":"))
print(counts, "shipped flags", len(built), "extra", len(extra), "median QRE", d["asBuilt"]["medianQre"], "-> soft", d["asBuilt"]["medianSoft"])
