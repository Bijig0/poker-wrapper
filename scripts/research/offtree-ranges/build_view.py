"""Data for the off-tree ranges page: every off-tree villain node with each belief's 13x13 grid, the thin states of the
stress-500 run, and the measurement summary.

    python build_view.py <scratch dir> <out data.json>
Needs in <scratch dir>: hh.pkl, acts_live.pkl, acts_stress.pkl, joined.pkl, items.pkl, score.json, fit2.json.
Read-only on the databases; zero GTO Wizard requests.
"""
from __future__ import annotations
import glob, gzip, json, math, os, pickle, sqlite3, sys
from collections import Counter, defaultdict
import numpy as np
import common as C, cache, pool as P, score as S

LIVE_DB = r"C:\Users\Brady\poker-data\poker.sqlite"
STRESS_DB = r"C:\Users\Brady\poker-data-stress500\root\poker.sqlite"
STRESS_DIR = r"C:\Users\Brady\poker-data-stress500"
T_FIT, T_TIGHT, T_LOOSE = 0.10, 0.05, 0.20     # soft model: T as a share of the pot (fit2.json, node share < 20%)
T_HYB = 0.20
THIN = 1.5
CLASS_COMBOS = np.array([6 if len(C.GRID[r][c]) == 2 else (4 if C.GRID[r][c].endswith("s") else 12)
                         for r in range(13) for c in range(13)], dtype=float)


def r4(x):
    return float(f"{x:.4g}")


def kind_of(code):
    return {"F": "fold", "X": "check", "C": "call"}.get(code, "wager")


def spot_from_trace(r):
    codes = r["codes"]
    wagers = [i for i, c in enumerate(codes) if c.startswith("R")]
    if not wagers:
        facing = "none"
    elif len(wagers) >= 2:
        facing = "raise"
    else:
        facing = "betcall" if any(c == "C" for c in codes[wagers[-1] + 1:]) else "bet"
    st = {"FLOP": 1, "TURN": 2, "RIVER": 3}[r["street"]]
    return (st, facing, "IP" if r["inPosition"] else "OOP", "agg" if r.get("prevAgg") == r["actor"] else "notagg",
            "HU" if len(r["players"]) == 2 else "MW")


def belief_pack(R, f, cats):
    w = R * f
    tot = float(w.sum())
    g = np.zeros(169)
    np.add.at(g, C.COMBO_CELL, w)
    mix = [float(w[cats == k].sum() / tot) if tot > 0 else 0.0 for k in range(5)]
    return {"combos": r4(tot), "grid": [r4(x) for x in g], "mix": [round(m, 4) for m in mix]}


def trace_of(db, sid):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    row = c.execute("select trace, line from solves where id=?", (sid,)).fetchone()
    if not row:
        return None, None
    return json.loads(gzip.decompress(row[0])), row[1]


def downstream(db, r):
    """What the chain did after this node in the same trace: the actor's range entering each later street, and
    hero's answer at his node (today's numbers)."""
    t, line = trace_of(db, r["solve"])
    if not t:
        return None
    out = {"line": line, "later": []}
    si0 = {"FLOP": 0, "TURN": 1, "RIVER": 2}[r["street"]]
    streets = t.get("streets") or []
    board_all = C.parse_board((t.get("spec") or {}).get("board") or r["board"])
    for s in streets:
        names = s.get("players") or []
        if s.get("street") == r["street"] or r["actor"] not in names:
            continue
        if {"FLOP": 0, "TURN": 1, "RIVER": 2}.get(s.get("street"), -1) <= si0:
            continue
        rng = np.asarray(s["rangesIn"][names.index(r["actor"])], dtype=float)
        bd = C.parse_board(s.get("board") or "")
        rng = np.where(~C.blocked_mask(bd), rng, 0)
        out["later"].append({"street": s["street"], "combos": r4(rng.sum()), "board": s.get("board")})
    hero_nodes = [n for n in t.get("nodes") or [] if n.get("heroNode")]
    spec = t.get("spec") or {}
    if hero_nodes and spec.get("heroComboIdx") is not None:
        hn = hero_nodes[-1]
        hi = spec["heroComboIdx"]
        out["hero"] = {"street": hn.get("street"), "codes": hn.get("codes"),
                       "mix": [{"a": a.get("name") or a.get("code"), "code": a.get("code"), "p": round(float((a.get("strategy") or [0] * 1326)[hi]), 4),
                                "node": round(float(a.get("totalFrequency") or 0), 4)} for a in hn.get("actions") or []]}
    return out


def composition(items, groups):
    """Real hands' category mix vs each belief's expected mix (mean over the actions of the group)."""
    out = {}
    for name, its in groups.items():
        if not its:
            continue
        real = Counter(it["cat"] for it in its)
        exp = {}
        for model, f in (("qre", lambda it: it["fq"]), ("pre", lambda it: np.ones(1326)),
                         ("soft", lambda it: S.f_softp(it, T_FIT)), ("pool", lambda it: it["fp"]),
                         ("hybrid", lambda it: S.f_softp(it, T_HYB) * it["fp"])):
            acc = np.zeros(5)
            for it in its:
                w = it["R"] * f(it)
                tot = w.sum()
                if tot > 0:
                    acc += np.array([w[it["cats"] == k].sum() / tot for k in range(5)])
            exp[model] = [round(x / len(its), 4) for x in acc]
        out[name] = {"n": len(its), "real": [real.get(k, 0) / len(its) for k in range(5)], "realN": [real.get(k, 0) for k in range(5)], "exp": exp}
    return out


def stress_thin_states():
    states = []
    for d in ("hands", "hands_pre_coldcall"):
        for p in sorted(glob.glob(os.path.join(STRESS_DIR, d, "*.json"))):
            h = json.load(open(p))
            hero = h.get("hero")
            for k, v in (h.get("views") or {}).items():
                if v.get("street") == "preflop" or v.get("actor") != hero:
                    continue
                for seat, rg in (v.get("ranges") or {}).items():
                    if seat == hero or not rg:
                        continue
                    combos = float(np.dot(np.asarray(rg, dtype=float), CLASS_COMBOS)) if len(rg) == 169 else float(sum(rg))
                    if combos < THIN:
                        states.append({"run": d, "hand": h["id"], "family": h.get("family"), "title": h.get("title"), "view": k,
                                       "street": v["street"], "line": v.get("line"), "seat": seat, "combos": r4(combos)})
    return states


def main(sd, out):
    L = lambda n: pickle.load(open(os.path.join(sd, n), "rb"))
    hh = L("hh.pkl")
    acts = [(LIVE_DB, r) for r in L("acts_live.pkl")] + [(STRESS_DB, r) for r in L("acts_stress.pkl")]
    joined = {r["key"]: r for r in L("joined.pkl")}
    items = L("items.pkl")
    pool = P.Pool(hh)
    lc = sqlite3.connect(f"file:{LIVE_DB}?mode=ro", uri=True)
    otl = {}
    for row in lc.execute("select key, client_hand_id, street, codes, villain_pos, origin, node_freq, max_hand, ev_gap, family, session_id from off_tree_lines"):
        key, hand, street, codes, seat = row[0], row[1], row[2], json.loads(row[3] or "[]"), row[4]
        otl[(str(hand), street.upper(), "-".join(codes), seat)] = {"key": key, "origin": row[5], "nodeFreq": row[6], "maxHand": row[7], "evGap": row[8], "family": row[9], "session": row[10]}
    by = defaultdict(list)   # the actor's ordinal on the street, to find his HH decision
    for _, r in acts:
        by[(r["hand"], r["street"], r["actor"])].append(len(r["codes"]))
    nodes = []
    seen_otl = set()
    for db, r in acts:
        board = C.parse_board(r["board"])
        hc = r.get("heroCards") or ""
        hero_cards = [C.card_idx(hc[i:i + 2]) for i in range(0, len(hc), 2)] if len(hc) >= 4 else []
        legal = ~C.blocked_mask(board + hero_cards)
        R0 = np.where(legal, r["range"], 0.0)
        t = r["taken"]
        node, mx = C.off_tree_stats(R0, r["strat"][t])
        n0, m0 = C.off_tree_stats(R0, r["strat"][t], dust=False)
        okey = (r["hand"], r["street"], "-".join(r["codes"]), r["actor"])
        in_otl = okey in otl
        if not C.is_off_tree(node, mx) and not in_otl:
            continue
        x = cache.lookup(r)
        precise = x is not None
        R = np.where(legal, x["range"] if precise else r["range"], 0.0)
        strat = x["strat"] if precise else r["strat"]
        evs = x["evs"] if precise else r["evs"]
        fq = strat[t].copy() if precise else np.where(r["strat"][t] <= 0, S.ROUND_FLOOR, r["strat"][t])
        ev_ok = np.isfinite(evs).all(axis=0)
        best = np.where(ev_ok, np.nanmax(np.where(np.isfinite(evs), evs, -1e9), axis=0), 0)
        dev = np.maximum(np.where(ev_ok, best - evs[t], 0.0), 0)
        pot = float(r["pot"] or 1)
        cats = C.categories(board)
        kind = kind_of(r["acts"][t]["code"])
        j = joined.get(r["key"])
        h = hh.get(r["hand"])
        key = None
        if j and h:
            st = {"FLOP": 1, "TURN": 2, "RIVER": 3}[r["street"]]
            mine = [d for d in P.decisions(h) if d[0] == st and d[1] == r["actor"]]
            ordn = sorted(by[(r["hand"], r["street"], r["actor"])]).index(len(r["codes"]))
            if ordn < len(mine):
                key = mine[ordn][2]
        if key is None:
            key = spot_from_trace(r)
        fp_c = np.array([pool.p(key, k, kind) for k in range(5)])
        fp = np.where(cats >= 0, fp_c[np.clip(cats, 0, 4)], 0.0)
        soft = lambda tt: np.exp(-dev / (tt * pot))
        beliefs = {
            "qre": belief_pack(R, fq, cats),
            "pre": belief_pack(R, np.ones(1326), cats),
            "soft_tight": belief_pack(R, soft(T_TIGHT), cats),
            "soft": belief_pack(R, soft(T_FIT), cats),
            "soft_loose": belief_pack(R, soft(T_LOOSE), cats),
            "pool": belief_pack(R, fp, cats),
            "hybrid": belief_pack(R, soft(T_HYB) * fp, cats),
        }
        acts_tot = [float((R * strat[i]).sum() / R.sum()) if R.sum() > 0 else 0 for i in range(len(strat))]
        rec = {
            "id": len(nodes), "src": "stress" if db == STRESS_DB else r["origin"], "hand": r["hand"], "street": r["street"],
            "board": r["board"], "codes": r["codes"], "actor": r["actor"], "players": r["players"], "hero": r["hero"],
            "heroCards": hc, "inPosition": r["inPosition"], "pot": pot, "pfLine": r.get("pfLine"),
            "acts": [{"code": a["code"], "name": a.get("name"), "betsize": a.get("betsize"), "share": round(acts_tot[i], 5)} for i, a in enumerate(r["acts"])],
            "taken": t, "kind": kind, "nodeFreq": node, "maxHand": mx, "nodeFreqNoDust": n0, "maxHandNoDust": m0,
            "offTree": C.is_off_tree(node, mx), "dustFixOnly": C.is_off_tree(node, mx) and not C.is_off_tree(n0, m0),
            "evGap": float((R * dev).sum() / R.sum()) if R.sum() > 0 else None, "precise": precise,
            "spot": list(key), "poolN": pool.count(key), "poolNkind": pool.count(key, kind),
            "poolRate": [round(float(v), 4) for v in fp_c],
            "villainCards": (j or {}).get("villainCards"), "villainClass": C.CLASS169[j["villainCombo"]] if j else None,
            "villainCat": int(cats[j["villainCombo"]]) if j else None,
            "liveLog": otl.get(okey), "beliefs": beliefs,
            "downstream": downstream(db, r),
        }
        if j:
            hs = j["villainCombo"]
            rec["villainShare"] = {k: (float((R * f)[hs] / (R * f).sum()) if (R * f).sum() > 0 else 0) for k, f in
                                   (("qre", fq), ("pre", np.ones(1326)), ("soft", soft(T_FIT)), ("pool", fp), ("hybrid", soft(T_HYB) * fp))}
        if in_otl:
            seen_otl.add(okey)
        nodes.append(rec)
    missing_otl = [dict(v, hand=k[0], street=k[1], codes=k[2], seat=k[3]) for k, v in otl.items() if k not in seen_otl]
    # measurement summary
    score = json.load(open(os.path.join(sd, "score.json")))
    fit2 = json.load(open(os.path.join(sd, "fit2.json")))
    low = [it for it in items if it["node"] < 0.20]
    groups = {
        "off-tree (all)": [it for it in items if it["off"]],
        "node share < 20%, aggressive": [it for it in low if it["kind"] == "wager"],
        "node share < 20%, flop bet OOP (no bet faced)": [it for it in low if it["kind"] == "wager" and it["facing"] == "none" and not it["inPosition"] and it["street"] == "FLOP"],
        "node share < 20%, passive": [it for it in low if it["kind"] in ("check", "call")],
        "node share >= 20% (common actions)": [it for it in items if it["node"] >= 0.20],
    }
    comp = composition(items, groups)
    stakes = Counter(f"{it['fmt']} {it['stake']:g}" for it in items)
    hh_stakes = Counter(f"{h['fmt']} {h['bb']:g}" for h in hh.values())
    data = {
        "built": "2026-10-06", "T": {"fit": T_FIT, "tight": T_TIGHT, "loose": T_LOOSE, "hybrid": T_HYB},
        "catNames": C.CAT_NAMES, "grid": C.GRID, "nodes": nodes, "missingLiveLog": missing_otl,
        "thinStates": stress_thin_states(), "score": score, "fit2": fit2, "composition": comp,
        "sample": {"items": len(items), "hands": len({it["hand"] for it in items}), "hhHands": len(hh), "poolDecisions": pool.decisions,
                   "itemStakes": stakes.most_common(12), "hhStakes": hh_stakes.most_common(12),
                   "origins": Counter(it["origin"] for it in items).most_common()},
    }
    json.dump(data, open(out, "w"), default=float, separators=(",", ":"))
    print(f"{len(nodes)} nodes ({sum(n['offTree'] for n in nodes)} off-tree, {sum(1 for n in nodes if n['liveLog'])} in the live log, "
          f"{sum(n['precise'] for n in nodes)} full precision), {len(data['thinStates'])} thin states, {len(missing_otl)} live-log rows without a trace node "
          f"-> {out} ({os.path.getsize(out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
