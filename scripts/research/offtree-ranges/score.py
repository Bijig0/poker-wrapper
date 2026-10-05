"""Which belief about villain's range after his action matches the hands real players held?

RESEARCH ONLY (2026-10-06, offtree-ranges). Inputs are the pickles from hh_parse.py and join.py; output = a JSON
summary (and the prepared items as a pickle for the display builder).

    python score.py <hh.pkl> <joined.pkl> <out.json> [<items.pkl>]

Beliefs about villain's hand after action a at a node, from his range R entering the node (board and hero cards
removed; full-precision node from the GTO Wizard cache when it has one, else the trace's 4-dp numbers):
  qre      R(h) * QRE strategy_a(h)                     (what aiChain does today)
  pre      R(h)                                         (option 1: ignore the action)
  soft T   R(h) * exp(-dEV_h / T),  dEV_h = max_b EV_b(h) - EV_a(h)  (option 3, T in bb)
  softp t  the same with dEV in pots (dEV_h / pot) and t a share of the pot
  logit T  R(h) * exp(EV_a/T) / sum_b exp(EV_b/T)      (a softer QRE: normalised per hand)
  pool     R(h) * P_pool(kind_a | category(h), spot)    (option 2, Ignition all-cards histories, this hand excluded)
Score = log-likelihood of villain's real combo, belief mixed with 1% uniform over legal combos (so a belief that
excludes the real hand costs log(0.01/n) instead of infinity). Reported per action as the gain over `pre`, in bits.
"""
from __future__ import annotations
import json, math, pickle, sys
from collections import Counter, defaultdict
import numpy as np
import common as C, cache, pool as P

EPS = 0.01
T_GRID = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 12, 20, 35, 60, 100, 1e9]
TP_GRID = [0.002, 0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 1e9]
ROUND_FLOOR = 2.5e-5   # half the trace writer's 4-dp step, for a combo whose rounded strategy is 0


def kind_of(code):
    return {"F": "fold", "X": "check", "C": "call"}.get(code, "wager")


def family(it):
    """The off-tree family names Brady used: street x action kind x IP/OOP (+ facing)."""
    k = it["kind"]
    if k == "wager":
        k = "bet/donk" if it["facing"] == "none" else "raise"
    if k == "check" and it["inPosition"]:
        k = "check back"
    if k == "call" and it["facing"] == "betcall":
        k = "over-call"
    return f"{it['street'].lower()} {k} {'IP' if it['inPosition'] else 'OOP'}"


def prepare(hh, joined, pool):
    # the actor's ordinal on the street (to find the matching HH decision)
    by = defaultdict(list)
    for r in joined:
        by[(r["hand"], r["street"], r["actor"])].append(len(r["codes"]))
    items = []
    for r in joined:
        h = hh[r["hand"]]
        x = cache.lookup(r)
        precise = x is not None
        rng = (x["range"] if precise else r["range"]).copy()
        strat = x["strat"] if precise else r["strat"]
        evs = x["evs"] if precise else r["evs"]
        t = r["taken"]
        legal = ~C.blocked_mask(r["boardIdx"] + r["heroCardIdx"])
        rng = np.where(legal, rng, 0.0)
        hs = r["villainCombo"]
        if not legal[hs] or rng.sum() <= 0:
            continue
        fq = strat[t].copy()
        if not precise:
            fq = np.where(fq <= 0, ROUND_FLOOR, fq)
        ev_ok = np.isfinite(evs).all(axis=0)
        best = np.where(ev_ok, np.nanmax(np.where(np.isfinite(evs), evs, -1e9), axis=0), 0)
        dev = np.where(ev_ok, best - evs[t], 0.0)
        dev = np.maximum(dev, 0)
        node, mx = C.off_tree_stats(rng, strat[t])
        node_nd, mx_nd = C.off_tree_stats(rng, strat[t], dust=False)
        ordn = sorted(by[(r["hand"], r["street"], r["actor"])]).index(len(r["codes"]))
        st = {"FLOP": 1, "TURN": 2, "RIVER": 3}[r["street"]]
        mine = [d for d in P.decisions(h) if d[0] == st and d[1] == r["actor"]]
        if ordn >= len(mine):
            continue
        key = mine[ordn][2]
        cats = C.categories(r["boardIdx"])
        kind = kind_of(r["acts"][t]["code"])
        fpool = np.array([pool.p(key, int(c), kind) if c >= 0 else 0.0 for c in range(5)])
        fp = np.where(cats >= 0, fpool[np.clip(cats, 0, 4)], 0.0)
        it = {
            "hand": r["hand"], "street": r["street"], "board": r["board"], "codes": r["codes"], "actor": r["actor"],
            "players": r["players"], "inPosition": r["inPosition"], "hero": r["hero"], "heroCards": r["heroCards"],
            "pot": float(r["pot"] or 0), "origin": r["origin"], "precise": precise, "code": r["acts"][t]["code"],
            "acts": r["acts"], "taken": t, "kind": kind, "facing": key[1], "spot": key, "stake": r["stake"], "fmt": r["fmt"],
            "villainCards": r["villainCards"], "hs": hs, "cat": int(cats[hs]),
            "R": rng, "fq": fq, "dev": dev, "evs": evs, "fp": fp, "node": node, "mx": mx, "node_nodust": node_nd,
            "mx_nodust": mx_nd, "off": C.is_off_tree(node, mx), "off_nodust": C.is_off_tree(node_nd, mx_nd),
            "nlegal": int(legal.sum()), "legal": legal, "cats": cats,
        }
        it["family"] = family(it)
        items.append(it)
    return items


def logp(it, f):
    w = it["R"] * f
    s = w.sum()
    b = w[it["hs"]] / s if s > 0 else 0.0
    return math.log((1 - EPS) * b + EPS / it["nlegal"])


def logp_cat(it, f):
    """log-likelihood of the real hand's CATEGORY (air / draw / weak pair / top pair / two pair+), 1% uniform mix."""
    w = it["R"] * f
    s = w.sum()
    cats = it["cats"]
    m = float(w[cats == it["cat"]].sum() / s) if s > 0 else 0.0
    return math.log((1 - EPS) * m + EPS / 5)


def in_range(it):
    """the real combo carries real weight in the range entering the node (not dust): the update is measurable"""
    R = it["R"]
    return R[it["hs"]] >= 0.01 * R.max()


def f_soft(it, T):
    return np.exp(-it["dev"] / T) if T < 1e8 else np.ones(1326)


def f_softp(it, t):
    pot = max(it["pot"], 1e-6)
    return np.exp(-it["dev"] / (t * pot)) if t < 1e8 else np.ones(1326)


def f_logit(it, T):
    e = it["evs"]
    if not np.isfinite(e).all():
        return np.ones(1326)
    z = (e - e.max(axis=0)) / T
    ez = np.exp(z)
    return ez[it["taken"]] / ez.sum(axis=0)


LP = {"combo": logp, "cat": logp_cat}
ONES = np.ones(1326)


def gains(items, f, lvl):
    lp = LP[lvl]
    return np.array([(lp(it, f(it)) - lp(it, ONES)) / math.log(2) for it in items])


def mean_gain(items, f, lvl="combo"):
    if not items:
        return None
    return float(gains(items, f, lvl).mean())


def boot_ci(items, f, n=400, seed=1, lvl="combo"):
    rng = np.random.default_rng(seed)
    g = gains(items, f, lvl)
    bs = [g[rng.integers(0, len(g), len(g))].mean() for _ in range(n)]
    return [float(np.percentile(bs, 5)), float(np.percentile(bs, 95))]


def fit(items, grid, mk, lvl="combo"):
    res = [(p, mean_gain(items, mk(p), lvl)) for p in grid]
    best = max(res, key=lambda x: x[1])
    return best, res


def score_block(items, lvl):
    out = {"n": len(items)}
    if not items:
        return out
    out["qre"] = mean_gain(items, lambda it: it["fq"], lvl)
    out["pool"] = mean_gain(items, lambda it: it["fp"], lvl)
    (bt, bg), curve = fit(items, T_GRID, lambda T: (lambda it: f_soft(it, T)), lvl)
    (bp, bpg), curvep = fit(items, TP_GRID, lambda t: (lambda it: f_softp(it, t)), lvl)
    (bl, blg), curvel = fit(items, T_GRID[:-1], lambda T: (lambda it: f_logit(it, T)), lvl)
    out["soft"] = {"T": bt, "gain": bg, "curve": curve, "ci": boot_ci(items, lambda it: f_soft(it, bt), lvl=lvl)}
    out["softp"] = {"t": bp, "gain": bpg, "curve": curvep, "ci": boot_ci(items, lambda it: f_softp(it, bp), lvl=lvl)}
    out["logit"] = {"T": bl, "gain": blg, "curve": curvel}
    out["qre_ci"] = boot_ci(items, lambda it: it["fq"], lvl=lvl)
    out["pool_ci"] = boot_ci(items, lambda it: it["fp"], lvl=lvl)
    return out


def summary(items, name):
    inr = [it for it in items if in_range(it)]
    out = {"name": name, "n": len(items), "hands": len({it["hand"] for it in items}),
           "precise": sum(it["precise"] for it in items), "in_range": len(inr)}
    if not items:
        return out
    out["combo"] = score_block(inr, "combo")
    out["cat"] = score_block(items, "cat")
    bt = out["combo"].get("soft", {}).get("T", 1.0)
    out["combos"] = {
        "pre": float(np.median([it["R"].sum() for it in items])),
        "qre": float(np.median([(it["R"] * it["fq"]).sum() for it in items])),
        "soft": float(np.median([(it["R"] * f_soft(it, bt)).sum() for it in items])),
        "pool": float(np.median([(it["R"] * it["fp"]).sum() for it in items])),
    }
    out["cats_real"] = dict(Counter(C.CAT_NAMES[it["cat"]] for it in items))
    return out


def main(hh_p, joined_p, out_p, items_p=None):
    hh = pickle.load(open(hh_p, "rb"))
    joined = pickle.load(open(joined_p, "rb"))
    excl = frozenset(r["hand"] for r in joined)
    pool = P.Pool(hh, exclude=excl)
    print(f"pool: {pool.decisions} decisions (scored hands excluded)")
    items = prepare(hh, joined, pool)
    print(f"{len(items)} items")
    subsets = {
        "off-tree (detector + dust fix)": [it for it in items if it["off"]],
        "off-tree, full-precision nodes": [it for it in items if it["off"] and it["precise"]],
        "off-tree passive (check/call)": [it for it in items if it["off"] and it["kind"] in ("check", "call")],
        "off-tree aggressive (bet/raise)": [it for it in items if it["off"] and it["kind"] == "wager"],
        "node share < 3%": [it for it in items if it["node"] < 0.03],
        "node share 1-5%": [it for it in items if 0.01 <= it["node"] < 0.05],
        "node share 5-20%": [it for it in items if 0.05 <= it["node"] < 0.20],
        "node share >= 20%": [it for it in items if it["node"] >= 0.20],
        "all villain actions": items,
    }
    fams = Counter(it["family"] for it in items if it["off"])
    for fam, n in fams.items():
        if n >= 4:
            subsets[f"off-tree family: {fam}"] = [it for it in items if it["off"] and it["family"] == fam]
    res = {name: summary(v, name) for name, v in subsets.items()}
    res["_meta"] = {"pool_decisions": pool.decisions, "items": len(items), "families": dict(fams), "eps": EPS}
    json.dump(res, open(out_p, "w"), indent=1, default=float)
    def line(b):
        if not b.get("n"):
            return "n=0"
        ci = lambda c: f"[{c[0]:+.2f},{c[1]:+.2f}]"
        return (f"n={b['n']:4d} qre {b['qre']:+.2f}{ci(b['qre_ci'])} pool {b['pool']:+.2f}{ci(b['pool_ci'])} "
                f"soft T={b['soft']['T']:g} {b['soft']['gain']:+.2f}{ci(b['soft']['ci'])} softp t={b['softp']['t']:g} {b['softp']['gain']:+.2f} "
                f"logit T={b['logit']['T']:g} {b['logit']['gain']:+.2f}")
    for name, s in res.items():
        if name.startswith("_") or not s.get("n"):
            continue
        print(f"== {name}  (n={s['n']}, precise {s['precise']}, in-range {s['in_range']}; median combos {({k: round(v, 2) for k, v in s['combos'].items()})})")
        print("   combo (in-range):", line(s["combo"]))
        print("   category (all):  ", line(s["cat"]))
    if items_p:
        pickle.dump(items, open(items_p, "wb"))


if __name__ == "__main__":
    main(*sys.argv[1:])
