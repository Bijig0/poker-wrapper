"""The terminal-action family (terminal.py), over every plan shape the relay can send.

    aof-model/.venv/Scripts/python.exe tests/test_terminal.py

Pure: no client, no rig. Each case is a relay plan (launch._pick_plan's output) against an
exported ParsedHand, with the verdict the top-up may act on. The conservative rule is asserted
directly: anything unreadable is NOT terminal, except a fold.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import launch  # noqa: E402  (the plan shapes come from the real _pick_plan)
from terminal import TERMINAL_ACTIONS, WRAPPER_TERMINALS, is_terminal, still_to_act_after_hero, table_view  # noqa: E402

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}  {detail}")
        FAILS.append(name)


def hand(street="river", hero=4, dealt=(1, 3, 4, 5), actions=(), stacks=None, to_call=0.0, committed=None):
    """A minimal ParsedHand as launch._hand_state exports it (CONTRACT §1a)."""
    acts = []
    for a in actions:
        seat, typ = a[0], a[1]
        rec = {"seatId": seat, "hero": seat == hero, "type": typ, "street": a[3] if len(a) > 3 else street}
        if len(a) > 2 and a[2] is not None:
            rec["amount"] = a[2]
        acts.append(rec)
    return {
        "handId": 1, "heroSeatId": hero, "heroCards": ["A♠", "K♠"], "board": ["2♣", "7♦", "9♥", "T♠", "3♣"][: {"preflop": 0, "flop": 3, "turn": 4, "river": 5}[street]],
        "street": street, "actions": acts, "liveSeats": sorted(dealt),
        "committed": committed or {}, "positions": {str(s): "X" for s in dealt},
        "stacks": stacks if stacks is not None else {str(s): 100.0 for s in dealt},
        "currentNode": {"street": street, "toActSeatId": hero, "toActIsHero": True, "pot": 20.0, "toCall": to_call},
        "heroFolded": False, "ended": False,
    }


# ---- the plan shapes, from the real mapper --------------------------------------------------
plans = {p: launch._pick_plan(p, pot_bb=10.0) for p in
         ["Fold", "FOLD 100%", "Check", "CHECK", "Call", "Call 2.5", "limp", "All-in", "ALL-IN 98.2 BB", "jam", "shove",
          "Raise 2.5", "RAISE 12", "Bet 3.35", "Bet 33%", "R2.5", "Raise", "Bet"]}
for p, plan in plans.items():
    check(f"plan for {p!r} maps", plan is not None, str(plan))
check("every plan kind/label the relay emits is in TERMINAL_ACTIONS",
      all((pl["kind"] if pl["kind"] != "action" else pl["label"]) in TERMINAL_ACTIONS for pl in plans.values() if pl),
      str({(pl["kind"] if pl["kind"] != "action" else pl["label"]) for pl in plans.values() if pl} - set(TERMINAL_ACTIONS)))
check("wrapper-initiated terminals never buy first", all(not v["top_up_before"] for v in WRAPPER_TERMINALS.values()))

# ---- fold: terminal always, exact amount, needs nothing from the table ----------------------
for p in ("Fold", "FOLD 100%"):
    v = is_terminal(plans[p], None)
    check(f"{p}: terminal with no hand state", v.terminal and v.kind == "fold" and v.final_stack_known, v.why)
v = is_terminal(plans["Fold"], hand(street="preflop", stacks={}))
check("fold: terminal even with unreadable stacks", v.terminal and v.final_stack_known)

# ---- all-in label: terminal, amount not final --------------------------------------------------
for p in ("All-in", "ALL-IN 98.2 BB", "jam", "shove"):
    v = is_terminal(plans[p], hand())
    check(f"{p}: shove is terminal", v.terminal and v.kind == "shove" and not v.final_stack_known, v.why)

# ---- raise-to: a shove when it is hero's whole stack, else not ---------------------------------
h = hand(street="flop", stacks={"1": 50.0, "3": 80.0, "4": 9.5, "5": 100.0}, committed={"4": 2.5})
check("raise-to 12 with 9.5 behind + 2.5 committed = shove",
      is_terminal(plans["RAISE 12"], h).kind == "shove")
h = hand(street="flop", stacks={"1": 50.0, "3": 80.0, "4": 60.0, "5": 100.0}, committed={"4": 2.5})
check("raise-to 12 with 60 behind = not terminal", not is_terminal(plans["RAISE 12"], h))
h = hand(street="flop", stacks={})
check("raise-to with unknown stack = not terminal (conservative)", not is_terminal(plans["RAISE 12"], h))
check("unsized 'Raise' = not terminal", not is_terminal(plans["Raise"], hand()))
check("unsized 'Bet' = not terminal", not is_terminal(plans["Bet"], hand()))
check("Bet 33% (priced) = not terminal", not is_terminal(plans["Bet 33%"], hand()))

# ---- call --------------------------------------------------------------------------------------
# river: villain 3 bets, hero is the only other live seat -> the call closes the action
h = hand(street="river", dealt=(3, 4), actions=[(3, "bet", 6.0)], to_call=6.0)
v = is_terminal(plans["Call"], h)
check("river call heads-up closes the action", v.terminal and v.kind == "closing-river-call", v.why)
# river 3-way: villain 1 bets, hero calls, villain 5 STILL to act -> not terminal
h = hand(street="river", dealt=(1, 4, 5), actions=[(1, "bet", 6.0)], to_call=6.0)
v = is_terminal(plans["Call"], h)
check("river call with a seat still to act is not terminal", not v.terminal and v.details.get("pending") == [5], v.why)
# river 3-way: villain 5 bets, villain 1 calls, hero last -> closes
h = hand(street="river", dealt=(1, 4, 5), actions=[(5, "bet", 6.0), (1, "call", 6.0)], to_call=6.0)
check("river call as the last to act closes", is_terminal(plans["Call"], h).kind == "closing-river-call")
# river: hero checked, villain bet, hero calls -> closes (hero acted before the aggressor; only hero owes)
h = hand(street="river", dealt=(3, 4), actions=[(4, "check", None), (3, "bet", 6.0)], to_call=6.0)
check("river check-call heads-up closes", is_terminal(plans["Call"], h).kind == "closing-river-call")
# river 3-way: seat 1 checked, seat 5 bet, hero calls -> seat 1 still owes -> not terminal
h = hand(street="river", dealt=(1, 4, 5), actions=[(1, "check", None), (5, "bet", 6.0)], to_call=6.0)
check("river call when an earlier checker still owes is not terminal", not is_terminal(plans["Call"], h))
# flop call: hero acts again -> not terminal
h = hand(street="flop", dealt=(3, 4), actions=[(3, "bet", 6.0)], to_call=6.0)
check("flop call is not terminal", not is_terminal(plans["Call"], h))
# flop call that puts hero all-in -> terminal
h = hand(street="flop", dealt=(3, 4), actions=[(3, "bet", 60.0)], to_call=60.0, stacks={"3": 40.0, "4": 55.0})
v = is_terminal(plans["Call"], h)
check("flop call for hero's whole stack is terminal (all-in call)", v.terminal and v.kind == "all-in-call", v.why)
# turn call when every opponent is already all-in -> run-out, terminal
h = hand(street="turn", dealt=(3, 4), actions=[(3, "all-in", 30.0)], to_call=30.0, stacks={"3": 0.0, "4": 90.0})
v = is_terminal(plans["Call"], h)
check("call when the only opponent is all-in = run-out", v.terminal and v.kind == "run-out", v.why)
# turn call vs an all-in with a THIRD player still holding chips -> not terminal
h = hand(street="turn", dealt=(1, 3, 4), actions=[(3, "all-in", 30.0)], to_call=30.0, stacks={"1": 80.0, "3": 0.0, "4": 90.0})
check("call of an all-in with another live seat behind is not terminal", not is_terminal(plans["Call"], h))
# an all-in this street whose amount we did not catch -> refuse to call it closing
h = hand(street="river", dealt=(3, 4), actions=[(3, "all-in", None)], to_call=6.0, stacks={"3": 0.0, "4": 90.0})
v = is_terminal(plans["Call"], h)
check("unsized all-in: run-out still recognised (opponent has no chips)", v.terminal and v.kind == "run-out", v.why)
h = hand(street="river", dealt=(1, 3, 4), actions=[(3, "all-in", None)], to_call=6.0, stacks={"1": 50.0, "3": 0.0, "4": 90.0})
check("unsized all-in with a live seat behind: not terminal (conservative)", not is_terminal(plans["Call"], h))
check("'limp' preflop maps to call and is not terminal", not is_terminal(plans["limp"], hand(street="preflop", dealt=(1, 3, 4, 5), to_call=1.0)))
check("call with unknown hero stack on the river still closes heads-up",
      is_terminal(plans["Call"], hand(street="river", dealt=(3, 4), actions=[(3, "bet", 6.0)], to_call=6.0, stacks={})).terminal)

# ---- check --------------------------------------------------------------------------------------
h = hand(street="river", dealt=(3, 4), actions=[(3, "check", None)], to_call=0.0)
v = is_terminal(plans["Check"], h)
check("river check behind a check closes", v.terminal and v.kind == "closing-river-check", v.why)
h = hand(street="river", dealt=(3, 4), actions=[], to_call=0.0)
check("river check first to act is not terminal", not is_terminal(plans["Check"], h))
h = hand(street="river", dealt=(1, 4, 5), actions=[(1, "check", None)], to_call=0.0)
check("river check with a seat still to act is not terminal", not is_terminal(plans["Check"], h))
h = hand(street="river", dealt=(1, 4, 5), actions=[(1, "check", None), (5, "check", None)], to_call=0.0)
check("river check as last of three closes", is_terminal(plans["Check"], h).kind == "closing-river-check")
h = hand(street="turn", dealt=(3, 4), actions=[(3, "check", None)], to_call=0.0)
check("turn check is not terminal", not is_terminal(plans["Check"], h))
h = hand(street="river", dealt=(3, 4), actions=[(3, "bet", 5.0)], to_call=5.0)
check("check when owing chips is not terminal (not on offer)", not is_terminal(plans["Check"], h))

# ---- degenerate states: never terminal except a fold --------------------------------------------
check("no plan -> not terminal", not is_terminal(None, hand()))
check("no hand -> call not terminal", not is_terminal(plans["Call"], None))
check("no opponents in hand -> not terminal", not is_terminal(plans["Call"], hand(dealt=(4,))))
check("hero seat unknown -> not terminal", not is_terminal(plans["Check"], {**hand(), "heroSeatId": None}))
check("unknown plan kind -> not terminal", not is_terminal({"kind": "mystery"}, hand()))

# ---- helpers ---------------------------------------------------------------------------------
tv = table_view(hand(street="flop", dealt=(1, 3, 4, 5), actions=[(1, "fold", None), (5, "all-in", 30.0)], stacks={"1": 50, "3": 80, "4": 90, "5": 0}))
check("table_view: folded/all-in/with-chips", tv["folded"] == {1} and tv["allin"] == {5} and tv["with_chips"] == {3})
pending = still_to_act_after_hero(hand(street="river", dealt=(1, 3, 4, 5), actions=[(1, "check", None), (3, "bet", 4.0), (5, "fold", None)], to_call=4.0),
                                  table_view(hand(street="river", dealt=(1, 3, 4, 5), actions=[(1, "check", None), (3, "bet", 4.0), (5, "fold", None)], to_call=4.0)))
check("still_to_act: the earlier checker owes, the folder and the bettor do not", pending == {1}, str(pending))

# ---- hero_done: the showdown-pending window ------------------------------------------------
from terminal import hero_done, seats_to_act  # noqa: E402
h = hand(street="river", dealt=(3, 4), actions=[(4, "bet", 6.0), (3, "call", 6.0)], to_call=0.0)
v = hero_done(h)
check("river bet called: hero is done (showdown pending)", v.terminal and v.kind == "showdown-pending" and not v.final_stack_known, v.why)
h = hand(street="river", dealt=(3, 4), actions=[(4, "bet", 6.0)], to_call=0.0)
check("river bet not yet answered: not done", not hero_done(h))
h = hand(street="river", dealt=(3, 4), actions=[(3, "check", None), (4, "check", None)], to_call=0.0)
check("river checked through: done", hero_done(h).kind == "showdown-pending")
h = hand(street="river", dealt=(1, 3, 4), actions=[(1, "check", None), (3, "bet", 5.0), (4, "call", 5.0)], to_call=0.0)
check("river 3-way, one seat still to answer the bet: not done", not hero_done(h) and hero_done(h).details.get("pending") == [1])
h = hand(street="turn", dealt=(3, 4), actions=[(3, "bet", 6.0), (4, "call", 6.0)], to_call=0.0)
check("turn call: not done (river to come)", not hero_done(h))
h = hand(street="turn", dealt=(3, 4), actions=[(3, "all-in", 30.0), (4, "call", 30.0)], to_call=0.0, stacks={"3": 0.0, "4": 90.0})
check("opponent all-in and called: run-out, done", hero_done(h).kind == "run-out")
h = hand(street="flop", dealt=(3, 4), actions=[(4, "all-in", 50.0)], to_call=0.0, stacks={"3": 90.0, "4": 0.0})
check("hero all-in: done", hero_done(h).kind == "hero-all-in")
h = hand(street="river", dealt=(3, 4), actions=[(4, "fold", None)], to_call=0.0)
check("hero folded: not this window's business", not hero_done(h))
check("no hand: not done", not hero_done(None))
check("seats_to_act after a bet answered by everyone is empty", seats_to_act(hand(street="river", dealt=(3, 4), actions=[(4, "bet", 6.0), (3, "call", 6.0)])) == set())
check("seats_to_act with an unsized all-in is None", seats_to_act(hand(street="river", dealt=(3, 4), actions=[(3, "all-in", None)])) is None)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("all clean")
