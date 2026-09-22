"""
Read collapse_calib.jsonl and report what each collapse rule costs.

The harness records every VALID collapse of each node. Production cannot pick the best one by peeking at the
truth, so this also scores the deterministic SELECTION RULES a shipped implementation would have to use:
drop the far villain, drop the near one, drop the wider range, drop the tighter one.

  python src/scripts/analyzeCollapse.py [path]
"""
import json, sys, os, statistics as st
from collections import defaultdict

import glob as _glob
HERE = os.path.dirname(__file__)
PATHS = sys.argv[1:] or sorted(_glob.glob(os.path.join(HERE, "collapse_calib*.jsonl")))
MASS = os.path.join(HERE, "collapse_seat_mass.json")
seat_mass = json.load(open(MASS)) if os.path.exists(MASS) else {}

# the run can be split across parallel workers; dedupe by node key, last write wins
seen = {}
for pth in PATHS:
    for l in open(pth, encoding="utf-8"):
        l = l.strip()
        if not l:
            continue
        try:
            r = json.loads(l)
        except Exception:
            continue  # a worker killed mid-write leaves one partial line
        seen[r["key"]] = r
rows = list(seen.values())

ok = [r for r in rows if r.get("truth", {}).get("ok")]
bad = [r for r in rows if not r.get("truth", {}).get("ok")]

CHECKED = {"n1", "n2", "n3"}
FACING = {"n4", "n5", "n6"}


def pot_kind(r):
    return "limped (SPR ~33)" if r["pot"] < 5 else "raised (SPR ~12)"


def texture(b):
    cards = [b[i:i + 2] for i in range(0, len(b), 2)]
    ranks = [c[0] for c in cards]
    suits = [c[1] for c in cards]
    if len(set(ranks)) < 3:
        return "paired"
    if len(set(suits)) == 1:
        return "monotone"
    if len(set(suits)) == 2:
        return "two-tone"
    return "rainbow"


def methods(r):
    """Every scored collapse on a row, plus the deterministic selection rules, as name -> result dict."""
    out = {}
    res = r.get("results", {})
    seats, hero = r["seats"], r["hero"]
    hi = seats.index(hero)
    ghosts = {k.split(":", 1)[1]: v for k, v in res.items() if k.startswith("ghost:") and v.get("ok")}
    for k, v in res.items():
        if v.get("ok"):
            out[k] = v
    if ghosts:
        # deterministic rules over the ghosts that were actually legal at this node
        by_dist = sorted(ghosts, key=lambda p: (-abs(seats.index(p) - hi), seats.index(p)))
        out["rule:ghost-far"] = ghosts[by_dist[0]]
        out["rule:ghost-near"] = ghosts[by_dist[-1]]
        m = seat_mass.get(r["line"] + "|" + r["src"])
        if m:
            by_mass = sorted(ghosts, key=lambda p: -m.get(p, 0))
            out["rule:ghost-wider"] = ghosts[by_mass[0]]
            out["rule:ghost-tighter"] = ghosts[by_mass[-1]]
        out["oracle:best-ghost"] = min(ghosts.values(), key=lambda v: v["loss"])
        out["oracle:worst-ghost"] = max(ghosts.values(), key=lambda v: v["loss"])
    return out


def agg(sel, label):
    """One table: every method, over the rows `sel` selects."""
    acc = defaultdict(list)
    for r in sel:
        for k, v in methods(r).items():
            acc[k].append(v)
    n_rows = len(sel)
    print(f"\n{label}  ({n_rows} nodes)")
    print(f"  {'method':20s} {'n':>4s} {'cover':>6s} {'mean bb':>9s} {'median':>8s} {'p90':>8s} "
          f"{'% pot':>7s} {'TV':>6s} {'top-act':>8s}")
    order = ["blend", "merge", "rule:ghost-far", "rule:ghost-near", "rule:ghost-wider", "rule:ghost-tighter",
             "oracle:best-ghost", "oracle:worst-ghost", "uniform"]
    for k in order + sorted(x for x in acc if x not in order and not x.startswith("ghost:")):
        v = acc.get(k)
        if not v:
            continue
        loss = [x["loss"] for x in v]
        print(f"  {k:20s} {len(v):4d} {100*len(v)/max(1,n_rows):5.0f}% {st.mean(loss):9.4f} "
              f"{st.median(loss):8.4f} {sorted(loss)[int(0.9*(len(loss)-1))]:8.4f} "
              f"{st.mean([x['lossPct'] for x in v]):6.2f}% {st.mean([x['tv'] for x in v]):6.3f} "
              f"{100*st.mean([x['agree'] for x in v]):7.0f}%")


print(f"{len(rows)} rows, {len(ok)} solved, {len(bad)} truth failures")
if bad:
    why = defaultdict(int)
    for r in bad:
        w = str(r["truth"].get("why"))[:90]
        why[w] += 1
    print("  truth failures:")
    for w, c in sorted(why.items(), key=lambda x: -x[1]):
        print(f"    {c:4d}  {w}")

if not ok:
    sys.exit(0)

agg(ok, "ALL NODES")
agg([r for r in ok if r["node"] in CHECKED], "CHECKED TO HERO (n1-n3): the collapse has two legal ghosts")
agg([r for r in ok if r["node"] in FACING], "FACING A BET (n4-n6): only the non-bettor can be ghosted")
for k in sorted({pot_kind(r) for r in ok}):
    agg([r for r in ok if pot_kind(r) == k], f"POT TYPE: {k}")
for k in sorted({texture(r["board"]) for r in ok}):
    agg([r for r in ok if texture(r["board"]) == k], f"TEXTURE: {k}")
for nd in ["n1", "n2", "n3", "n4", "n5", "n6"]:
    sel = [r for r in ok if r["node"] == nd]
    if sel:
        agg(sel, f"NODE {nd}: {sel[0]['note']}")

# which way each collapse errs: aggregate aggression vs the truth
print("\nDIRECTION — aggregate frequency of hero's aggressive actions (bet/raise), range-weighted")
print(f"  {'method':20s} {'truth':>8s} {'method':>8s} {'delta':>8s}")


def aggr_freq(codes, freq):
    return sum(f for c, f in zip(codes, freq) if c[:1] in ("B", "R", "A"))


for k in ["blend", "merge", "rule:ghost-far", "rule:ghost-near", "oracle:best-ghost", "uniform"]:
    t, a = [], []
    for r in ok:
        m = methods(r).get(k)
        if not m:
            continue
        codes = r["truth"]["codes"]
        t.append(aggr_freq(codes, r["truth"]["freq"]))
        a.append(aggr_freq(codes, m["freq"]))
    if t:
        print(f"  {k:20s} {100*st.mean(t):7.1f}% {100*st.mean(a):7.1f}% {100*(st.mean(a)-st.mean(t)):+7.1f}pp")

# DOES THE ERROR SCALE WITH HOW MUCH OF THE FIELD THE COLLAPSE REMOVES?
# This is what licenses reading the 3->2 grid across to other table sizes. 3->2 drops one of two villains
# (half the field); 4->3 drops one of three (a third); 5->3 drops two of four (half again). If loss tracks
# the share of villain range mass removed, the grid speaks directly to 5-way and is conservative for 4-way.
print("\nERROR vs SHARE OF THE FIELD REMOVED (each ghost, by the dropped seat's share of villain range mass)")
buckets = defaultdict(list)
pairs = []
for r in ok:
    m = seat_mass.get(r["line"] + "|" + r["src"])
    if not m:
        continue
    vill = [p for p in r["seats"] if p != r["hero"]]
    tot_v = sum(m.get(p, 0) for p in vill)
    if tot_v <= 0:
        continue
    for k, v in r.get("results", {}).items():
        if not k.startswith("ghost:") or not v.get("ok"):
            continue
        share = m.get(k.split(":", 1)[1], 0) / tot_v
        buckets[min(4, int(share * 5))].append(v["loss"])
        pairs.append((share, v["loss"]))
print(f"  {'dropped share':16s} {'n':>4s} {'mean bb':>9s} {'median':>8s}")
for b in sorted(buckets):
    v = buckets[b]
    print(f"  {f'{b*20:2d}-{b*20+20:3d}%':16s} {len(v):4d} {st.mean(v):9.4f} {st.median(v):8.4f}")
if len(pairs) > 2:
    mx = st.mean([p[0] for p in pairs]); my = st.mean([p[1] for p in pairs])
    cov = sum((a - mx) * (b - my) for a, b in pairs)
    vx = sum((a - mx) ** 2 for a, _ in pairs); vy = sum((b - my) ** 2 for _, b in pairs)
    if vx > 0 and vy > 0:
        print(f"  correlation(share removed, loss) = {cov / (vx * vy) ** 0.5:+.3f} over {len(pairs)} ghosts")

# the noise floor: how negative do losses get (equilibrium indifference + solver tolerance)
allv = [x["loss"] for r in ok for x in methods(r).values()]
neg = [x for x in allv if x < 0]
print(f"\nnoise floor: {len(neg)} of {len(allv)} scores below zero, most negative {min(allv):.4f} bb")
print(f"solve time: median {st.median([r['ms'] for r in ok])/1000:.1f}s per node (truth + every collapse)")
