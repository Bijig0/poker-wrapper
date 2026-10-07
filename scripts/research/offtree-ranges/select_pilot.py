"""THE NL200 PILOT'S SPOTS (Brady 2026-10-06, relayed): heads-up flops from the NL200 ($1/$2 ring) downloaded Ignition
histories that never went through the chain, where a non-hero player ("V", never Brady's own [ME] seat) made a
rare-looking flop or turn action. Each spot becomes a raw hand (the wrapper's archive shape, normalizeHand's input) with
the OTHER player as the chain's hero, and the decision to answer = that player's first action after V's: the walk to it
reads V's node (and every other node of the street) on GTO Wizard.

    python select_pilot.py <hh.pkl> <out.json> [--max 220] [--categories "donk OOP,raise of a bet,overbet"] [--exclude <spots.json>]

--categories keeps only those kinds of spot; --exclude leaves out every hand an earlier spots file picked (the follow-up
after the pilot: the kinds that yielded off-tree actions, hands not yet tried).

Rare-looking (the solve decides what is off-tree): OOP donk (not the preflop raiser, first in, bets), the preflop
raiser's check-back in position, check-raise, raise of a bet, min-bet (<= 25% pot), overbet (> 100% pot). Cheapest first within each
category: a decision on the same street as V's action needs one tree; a turn decision after a flop action needs two.
"""
import json, pickle, sqlite3, sys
from collections import Counter

SIX = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]
ORDER = ["SB", "BB", "UTG", "HJ", "CO", "BTN"]
MAXN = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 220
CATS = set(sys.argv[sys.argv.index("--categories") + 1].split(",")) if "--categories" in sys.argv else None
EXCL = {p["hand"] for p in json.load(open(sys.argv[sys.argv.index("--exclude") + 1]))["picked"]} if "--exclude" in sys.argv else set()
hh = pickle.load(open(sys.argv[1], "rb"))
db = sqlite3.connect("file:C:/Users/Brady/poker-data/poker.sqlite?mode=ro", uri=True)
solved = {str(r[0]) for r in db.execute("select distinct client_hand_id from solves")}


def to_raw(h, hero_pos):
    """Ignition text actions -> the archive's raw actions: a raise / all-in-raise / all-in = the street total it makes, a
    call = the chips it adds, a bet = its size; seats numbered 1..n in position order (UTG first)."""
    seats = [p for p in SIX if p in h["cards"]]
    sid = {p: i + 1 for i, p in enumerate(seats)}
    acts, contrib, street_of = [], {}, {0: "preflop", 1: "flop", 2: "turn", 3: "river"}
    cur = -1
    for st, p, kind, amts in h["acts"]:
        if st != cur:
            cur, contrib = st, {}
        a = {"seatId": sid[p], "hero": p == hero_pos, "street": street_of[st]}
        before = contrib.get(p, 0.0)
        if kind == "Small Blind":
            a.update(type="post-sb", amount=amts[0]); contrib[p] = amts[0]
        elif kind == "Big blind":
            a.update(type="post-bb", amount=amts[0]); contrib[p] = amts[0]
        elif kind == "Folds":
            a.update(type="fold")
        elif kind == "Checks":
            a.update(type="check")
        elif kind == "Calls":
            a.update(type="call", amount=round(amts[0], 4)); contrib[p] = before + amts[0]
        elif kind == "Bets":
            a.update(type="bet", amount=round(amts[0], 4)); contrib[p] = before + amts[0]
        elif kind == "Raises":
            a.update(type="raise", amount=round(amts[-1], 4)); contrib[p] = amts[-1]
        elif kind == "All-in(raise)":
            a.update(type="all-in", amount=round(amts[-1], 4)); contrib[p] = amts[-1]
        elif kind == "All-in":
            tot = before + amts[0]
            a.update(type="all-in", amount=round(tot, 4)); contrib[p] = tot
        else:
            continue
        acts.append(a)
    dealer = sid.get("BTN")
    board = h["board"]
    return {
        "handId": int(h["id"]) % 1_000_000, "clientHandId": f"pilot-{h['id']}", "bbCents": int(round(h["bb"] * 100)),
        "heroSeatId": sid[hero_pos], "heroCards": h["cards"][hero_pos], "board": board,
        "street": ["preflop", "flop", "flop", "flop", "turn", "river"][min(len(board), 5)],
        "actions": acts, "liveSeats": list(sid.values()), "committed": {}, "potByStreet": {},
        "positions": {str(v): k for k, v in sid.items()},
        "roster": {"dealer": dealer, "deadButton": False, "deadSb": False, "dealt": list(sid.values()),
                   "seats": {str(v): {"status": "dealt", **({"hero": True} if k == hero_pos else {})} for k, v in sid.items()}},
        "stacks": {str(sid[p]): round(h["stacks"][p], 4) for p in seats}, "startStacks": {str(sid[p]): round(h["stacks"][p], 4) for p in seats},
        "ended": True, "lineSource": "ws",
    }


cands = []
why = Counter()
for hid, h in hh.items():
    if h["fmt"] != "ring" or abs(h["bb"] - 2.0) > 1e-9:
        continue
    if hid in solved:
        why["went through the chain"] += 1; continue
    if hid in EXCL:
        why["tried before"] += 1; continue
    if len(h["board"]) < 3:
        continue
    post = [(s, p, k, a) for s, p, k, a in h["acts"] if s >= 1]
    flop_players = {p for s, p, k, a in post if s == 1}
    if len(flop_players) != 2:
        continue
    pre_agg = None
    for s, p, k, a in h["acts"]:
        if s == 0 and k in ("Raises", "All-in(raise)"):
            pre_agg = p
    pre_pot = sum(x for s, p, k, a in h["acts"] if s == 0 and k in ("Small Blind", "Big blind", "Calls", "Bets") for x in a[:1])
    # pot entering the flop: every preflop contribution (raise-to amounts counted once per seat)
    contrib = {}
    for s, p, k, a in h["acts"]:
        if s != 0:
            continue
        if k in ("Small Blind", "Big blind"): contrib[p] = a[0]
        elif k == "Calls": contrib[p] = contrib.get(p, 0) + a[0]
        elif k in ("Raises", "All-in(raise)"): contrib[p] = a[-1]
        elif k == "All-in": contrib[p] = contrib.get(p, 0) + a[0]
    pot = sum(contrib.values())
    ip = max(flop_players, key=ORDER.index)
    target = None
    for st in (1, 2):
        sc = [(p, k, a) for s, p, k, a in post if s == st]
        if not sc:
            break
        street_pot, put, wagers = pot, {}, 0
        for i, (p, k, a) in enumerate(sc):
            tag = None
            villain = p != h["hero"]
            if villain:
                if k in ("Bets", "All-in") and wagers == 0:
                    size = a[0]
                    if p != (pre_agg if st == 1 else None) and p != ip and i == 0: tag = "donk OOP"
                    elif size <= 0.25 * street_pot: tag = "min-bet"
                    elif size > 1.0 * street_pot: tag = "overbet"
                elif k in ("Raises", "All-in(raise)") and wagers >= 1:
                    tag = "check-raise" if sc[0][0] == p and sc[0][1] == "Checks" else "raise of a bet"
                elif k == "Checks" and p == ip and p == pre_agg and st == 1 and all(x[1] == "Checks" for x in sc[:i]):
                    tag = "PFR check-back IP"
            if k in ("Bets", "Raises", "All-in(raise)", "All-in"):
                wagers += 1
            amt = a[-1] if k in ("Raises", "All-in(raise)") else (a[0] if a else 0)
            if k in ("Bets", "Calls", "All-in"): put[p] = put.get(p, 0) + amt
            elif k in ("Raises", "All-in(raise)"): put[p] = amt
            if tag and target is None:
                target = (st, i, p, tag)
        pot += sum(put.values())
        if target:
            break
    if not target:
        continue
    st, i, vpos, tag = target
    if CATS and tag not in CATS:
        continue
    hero_pos = next(iter(flop_players - {vpos}))
    raw = to_raw(h, hero_pos)
    # the decision: the first action of hero_pos after V's action
    street_name = {1: "flop", 2: "turn"}[st]
    seen = 0
    v_idx = None
    for j, a in enumerate(raw["actions"]):
        if a["street"] == street_name:
            if seen == i:
                v_idx = j; break
            seen += 1
    dec = next((j for j in range(v_idx + 1, len(raw["actions"])) if raw["actions"][j]["hero"] and raw["actions"][j]["street"] in ("flop", "turn")), None)
    if dec is None:
        why["no later decision for the other player"] += 1; continue
    cost = 1 if raw["actions"][dec]["street"] == street_name else 2
    cands.append({"id": f"pilot-{hid}", "hand": hid, "category": tag, "street": street_name, "villain": vpos, "hero": hero_pos,
                  "heroIsBrady": hero_pos == h["hero"], "decisionIndex": dec, "trees": cost + (1 if st == 2 else 0), "raw": raw})
    why[f"candidate: {tag}"] += 1

# an even mix of categories (round-robin), the cheapest spots first within each, capped
cands.sort(key=lambda c: (c["trees"], c["hand"]))
by = {}
for c in cands:
    by.setdefault(c["category"], []).append(c)
lists = [by[k] for k in sorted(by)]
picked, k = [], 0
while len(picked) < MAXN and any(k < len(l) for l in lists):
    for l in lists:
        if k < len(l) and len(picked) < MAXN:
            picked.append(l[k])
    k += 1
json.dump({"built": "2026-10-06", "candidates": len(cands), "picked": picked}, open(sys.argv[2], "w"))
print(dict(why))
print(f"{len(cands)} candidates -> {len(picked)} picked: {Counter(c['category'] for c in picked)} · trees {Counter(c['trees'] for c in picked)} · "
      f"hero is Brady in {sum(c['heroIsBrady'] for c in picked)}")
