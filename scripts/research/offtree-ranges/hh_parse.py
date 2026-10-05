"""Ignition downloaded hand histories -> one record per hand with EVERY dealt seat's hole cards and every action.

RESEARCH ONLY (2026-10-06, offtree-ranges). Reads files, writes nothing but the pickle named on the command line.
Sends nothing anywhere, touches no live port.

Sources (local, read-only):
  %USERPROFILE%/Ignition Casino Poker/Hand History/<account>/HH*.txt   the client's DOWNLOAD (every seat's cards)
  poker/analysis/pipeline/limp_study/ignition_hh_exchange/anon_nl*.txt the same format from another account

Positions follow build_calls.py (caller-read-pool): dealt seats in Ignition's seat-name order -> UTG..BB (6-max).
"""
from __future__ import annotations
import glob, os, pickle, re, sys

SEATS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]
USERPROFILE = os.environ.get("USERPROFILE", r"C:\Users\Brady")
TEXT_ROOT = os.path.join(USERPROFILE, "Ignition Casino Poker", "Hand History")
ANON_DIR = os.path.join(USERPROFILE, "poker", "analysis", "pipeline", "limp_study", "ignition_hh_exchange")

HDR = re.compile(r"^Ignition Hand #(\d+):? (?:TBL#(\d+)|Zone Poker ID#(\d+)) HOLDEM\s*(Zone Poker )?No Limit - (\S+ \S+)")
SEAT = re.compile(r"^Seat (\d+): (.+?)\s*(\[ME\])? \(\$([\d.,]+) in chips\)")
ACT = re.compile(r"^(.+?)\s*(\[ME\])?\s*: (.*)$")
MONEY = re.compile(r"\$([\d.,]+)")
CARDS = re.compile(r"\[([^\]]*)\]")
STAKES = re.compile(r"Stakes: \$([\d.]+)-\$([\d.]+)")


def order_key(name):
    if name.startswith("UTG"):
        return int(name[4:]) if "+" in name else 0
    return {"Dealer": 100, "Small Blind": 101, "Big Blind": 102}.get(name, 99)


def money(s):
    return [float(x.replace(",", "")) for x in MONEY.findall(s)]


def parse(lines, src):
    m = HDR.match(lines[0])
    if not m:
        return None
    hid, tbl, zid, zone, ts = m.groups()
    seats, cards, hero, bb = {}, {}, None, None
    street, board, ev, hole = 0, [], [], False
    for ln in lines[1:]:
        st = STAKES.search(ln)
        if st:
            bb = float(st.group(2))
        if ln.startswith("*** HOLE CARDS"):
            hole = True
            continue
        if ln.startswith("***"):
            cs = CARDS.findall(ln)
            if ln.startswith("*** FLOP"):
                street, board = 1, cs[0].split()
            elif ln.startswith("*** TURN"):
                street, board = 2, board[:3] + cs[-1].split()
            elif ln.startswith("*** RIVER"):
                street, board = 3, board[:4] + cs[-1].split()
            elif ln.startswith("*** SUMMARY"):
                break
            continue
        s = SEAT.match(ln)
        if s and not hole:
            seats[s.group(2).strip()] = float(s.group(4).replace(",", ""))
            if s.group(3):
                hero = s.group(2).strip()
            continue
        a = ACT.match(ln)
        if not a:
            continue
        nm, verb = a.group(1).strip(), a.group(3)
        if a.group(2):
            hero = nm
        if verb.startswith("Card dealt to a spot"):
            cc = (CARDS.findall(verb) or [""])[0].split()
            if len(cc) >= 2:
                cards[nm] = cc[:2]
            continue
        for kind in ("Folds", "Checks", "Calls", "Bets", "Raises", "All-in", "Small Blind", "Big blind", "Posts"):
            if verb.startswith(kind):
                amts = money(verb)
                # "Raises $4 to $4" -> to-amount is the last; "All-in(raise) $x to $y"
                ev.append((street, nm, kind if kind != "All-in" else ("All-in(raise)" if "raise" in verb.lower() else "All-in"), amts))
                break
    if not bb:  # own downloads carry no "Stakes:" line: the big blind's post is the unit
        bb = next((amts[0] for _, _, k, amts in ev if k == "Big blind" and amts), None)
    dealt = [n for n in seats if n in cards]
    if len(dealt) < 2 or len(dealt) > 6 or not bb:
        return None
    names = sorted(dealt, key=order_key)
    n = len(names)
    pos = dict(zip(names, SEATS6[6 - n:])) if n > 2 else {names[0]: "SB", names[1]: "BB"}
    if any(k == "Posts" for _, _, k, _ in ev):
        return None
    acts = [(st, pos[nm], kind, [x / bb for x in amts]) for st, nm, kind, amts in ev if nm in pos]
    return {
        "id": hid, "ts": ts, "fmt": "zone" if (zone or zid) else "ring", "bb": bb, "src": src,
        "hero": pos.get(hero) if hero else None,
        "cards": {pos[k]: v for k, v in cards.items() if k in pos},
        "stacks": {pos[k]: seats[k] / bb for k in names},
        "board": board, "acts": acts,
    }


def split_hands(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        block = []
        for ln in f:
            ln = ln.rstrip("\n")
            if ln.startswith("Ignition Hand #") and block:
                yield block
                block = []
            if ln.strip() or block:
                block.append(ln)
        if block:
            yield block


def main(out):
    hands = {}
    files = [(p, "own") for p in glob.glob(os.path.join(TEXT_ROOT, "*", "HH*.txt"))]
    files += [(p, "anon") for p in glob.glob(os.path.join(ANON_DIR, "anon_nl*.txt"))]
    for p, src in files:
        for block in split_hands(p):
            h = parse(block, src)
            if h and h["id"] not in hands:
                hands[h["id"]] = h
    with open(out, "wb") as f:
        pickle.dump(hands, f)
    print(f"{len(hands)} hands from {len(files)} files -> {out}")


if __name__ == "__main__":
    main(sys.argv[1])
