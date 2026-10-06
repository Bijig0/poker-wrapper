"""Should the off-tree detector's second condition go or be loosened? (Brady 2026-10-06, relayed; OFFLINE, zero requests)

Today: isOffTree = node share < 1% AND no hand of his range (dust ignored) takes the action > 2%. Rules compared:
  max-hand cut 2% (today) · 5% · 10% · 20% · none (share < 1% alone)

    python detector_rules.py <scratch dir> <out.json>
Needs: hh2.pkl, acts_live2.pkl, acts_stress2.pkl, acts_pilot.pkl, joined2.pkl, joined_pilot.pkl.

Part A, every villain node in the traces (no cards needed): how many fire under each cut, by source; at the nodes a cut
adds over today's, what he carries after the action (QRE vs the soft range at 10%), and how many of them leave him
under 1.5 combos with QRE (the stress run's thin villains).
Part B, NL100/200 nodes with villain's real cards (NL5 excluded, as Brady ruled): at the nodes each cut adds, the bits
per action (hand in range) of QRE (what they get today) vs the soft range at 10% (what they would get).
"""
from __future__ import annotations
import json, math, os, pickle, sys
from collections import Counter
import numpy as np
import common as C, score as S, pool as P

CUTS = [0.02, 0.05, 0.10, 0.20, 1.01]
NAME = {0.02: "2% (today)", 0.05: "5%", 0.10: "10%", 0.20: "20%", 1.01: "none (share < 1% alone)"}


def stats_of(r):
    board = C.parse_board(r["board"])
    hc = r.get("heroCards") or ""
    hero = [C.card_idx(hc[i:i + 2]) for i in range(0, len(hc), 2)] if len(hc) >= 4 else []
    legal = ~C.blocked_mask(board + hero)
    R = np.where(legal, r["range"], 0.0)
    t = r["taken"]
    st = r["strat"][t]
    if not (R.sum() > 0):
        return None
    node, mx = C.off_tree_stats(R, st)
    qre = float((R * st).sum())
    ev = r["evs"]
    ok = np.isfinite(ev).all(axis=0)
    best = np.where(ok, np.nanmax(np.where(np.isfinite(ev), ev, -1e9), axis=0), 0)
    dev = np.maximum(np.where(ok, best - ev[t], 0), 0)
    played = r["strat"].sum(axis=0) > 0.5
    pot = float(r["pot"] or 0)
    soft = float((R * np.exp(-dev / (0.1 * pot)) * played).sum()) if pot > 0 else float("nan")
    return {"node": node, "mx": mx, "qre": qre, "soft": soft, "pre": float(R.sum())}


def main(sd, out_p):
    L = lambda n: pickle.load(open(os.path.join(sd, n), "rb"))
    res = {"A": {}, "B": {}}
    # ── Part A ──
    rows = []
    for name, src in (("acts_live2.pkl", None), ("acts_stress2.pkl", "stress-500"), ("acts_pilot.pkl", "NL200 pilot")):
        for r in L(name):
            s = stats_of(r)
            if s is None or s["node"] >= 0.01:
                continue
            rows.append({**s, "src": src or r["origin"], "hand": r["hand"], "street": r["street"], "actor": r["actor"],
                         "action": r["acts"][r["taken"]]["code"], "codes": r["codes"]})
    print(f"Part A: {len(rows)} villain nodes with share < 1% in the traces")
    base = [r for r in rows if r["mx"] < 0.02]
    for cut in CUTS:
        fire = [r for r in rows if r["mx"] < cut]
        new = [r for r in fire if r["mx"] >= 0.02]
        thin = [r for r in new if r["qre"] < 1.5]
        row = {"fire": len(fire), "new": len(new), "bySource": dict(Counter(r["src"] for r in new)),
               "newThinUnderQre": len(thin),
               "medianQre": float(np.median([r["qre"] for r in new])) if new else None,
               "medianSoft": float(np.nanmedian([r["soft"] for r in new])) if new else None,
               "medianPre": float(np.median([r["pre"] for r in new])) if new else None,
               "mxRange": [float(min(r["mx"] for r in new)), float(max(r["mx"] for r in new))] if new else None}
        res["A"][NAME[cut]] = row
        print(f"  cut {NAME[cut]:26s} fires {row['fire']:4d} (+{row['new']:3d}: {row['bySource']}) · newly firing median QRE {row['medianQre']} "
              f"-> soft {row['medianSoft']} (pre {row['medianPre']}) · {row['newThinUnderQre']} of them under 1.5 combos with QRE")
    # the stress villains the peer named: share < 1% and NOT flagged today
    stress_missed = [r for r in rows if r["src"] == "stress-500" and r["mx"] >= 0.02]
    res["A"]["stressMissed"] = [{k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.items()} for r in stress_missed]
    print(f"  stress-500 nodes under 1% NOT flagged today: {len(stress_missed)}")
    for r in sorted(stress_missed, key=lambda x: x["hand"])[:20]:
        print(f"    {r['hand'][-24:]:24s} {r['street']} {'-'.join(r['codes']) or 'root':10s} {r['actor']} {r['action']:7s} share {100 * r['node']:.3f}% top hand {100 * r['mx']:.1f}% "
              f"· QRE {r['qre']:.3g} combos -> soft {r['soft']:.3g}")
    # ── Part B ──
    hh = L("hh2.pkl")
    joined = [r for r in L("joined2.pkl") + L("joined_pilot.pkl") if abs(r["stake"] - 0.05) > 1e-9]
    seen, uniq = set(), []
    for r in joined:
        k = (r["hand"], r["street"], tuple(r["codes"]), r["actor"])
        if k not in seen:
            seen.add(k); uniq.append(r)
    nl5 = frozenset(k for k, h in hh.items() if abs(h["bb"] - 0.05) < 1e-9)
    pool = P.Pool(hh, exclude=frozenset(r["hand"] for r in uniq) | nl5)
    items = S.prepare(hh, uniq, pool)
    low = [it for it in items if it["node"] < 0.01]
    print(f"Part B: {len(items)} NL100/200 actions with real cards, {len(low)} with share < 1%")
    for cut in CUTS:
        new = [it for it in low if 0.02 <= it["mx"] < cut]
        cur = [it for it in low if it["mx"] < 0.02]
        out = {}
        for label, sub in (("newly firing", new), ("firing today", cur)):
            inr = [it for it in sub if S.in_range(it)]
            if not inr:
                out[label] = {"n": len(sub), "in_range": 0}; continue
            cs = [(t, S.mean_gain(inr, (lambda tt: (lambda it: S.f_softp(it, tt)))(t), "combo")) for t in S.TP_GRID]
            bt, bg = max(cs, key=lambda x: x[1])
            out[label] = {"n": len(sub), "in_range": len(inr),
                          "qre": S.mean_gain(inr, lambda it: it["fq"], "combo"), "qre_ci": S.boot_ci(inr, lambda it: it["fq"]),
                          "soft10": S.mean_gain(inr, lambda it: S.f_softp(it, 0.1), "combo"), "soft10_ci": S.boot_ci(inr, lambda it: S.f_softp(it, 0.1)),
                          "soft_t": bt, "soft": bg,
                          "soft10_minus_qre": float(np.mean([(S.logp(it, S.f_softp(it, 0.1)) - S.logp(it, it["fq"])) / math.log(2) for it in inr])),
                          "qreExcluded": sum(1 for it in inr if (it["R"] * it["fq"])[it["hs"]] / max((it["R"] * it["fq"]).sum(), 1e-300) < 1e-4)}
        res["B"][NAME[cut]] = out
        f = lambda d, k: "  n/a" if d.get(k) is None else f"{d[k]:+.2f}"
        nw = out["newly firing"]
        print(f"  cut {NAME[cut]:26s} newly firing n={nw['n']:3d} in={nw['in_range']:3d} | QRE {f(nw, 'qre')} soft10 {f(nw, 'soft10')} "
              f"(soft - QRE {f(nw, 'soft10_minus_qre')}) best soft t={nw.get('soft_t')} {f(nw, 'soft')} · QRE all but excludes the real hand in {nw.get('qreExcluded')}")
    cur = res["B"][NAME[0.02]]["firing today"]
    print(f"  (firing today: n={cur['n']} in={cur['in_range']} QRE {cur.get('qre')} soft10 {cur.get('soft10')})")
    json.dump(res, open(out_p, "w"), indent=1, default=float)


if __name__ == "__main__":
    main(*sys.argv[1:3])
