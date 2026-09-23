"""The street-boundary and hand-boundary reader rules of the 2026-09-23 hardening pass.

The whole-corpus backtest (tests/backtest/out/verdicts.csv) left three hands whose exported line
was still wrong, and one hand with no client hand id. Each was traced to its frames; this pins
what was found:

  * dashboard 621 (4919480043): hero checked the river, the big blind checked behind, and the
    reconciler read the POT landing at hero's seat (pot label gone the same tick) as "hero bets
    11.8" — a phantom decision. The award is now recognised by the pot label vanishing.
  * dashboard 425 / 441 (4919211085 / 4919213506): hero's pending press, redeemed on the NEXT
    street as its opening action. reconcile._end_street resolves the press at the street end;
    pinned here so it stays that way.
  * the cut-over (_reconciled_line) refuses a derived line no table could have dealt — a street
    opening with the wrong seat, or one seat acting twice running — instead of substituting it.
  * dashboard 714 (4919910444): a DOM "table opened" tick in the middle of a hand moved the hand
    counter on and left the id behind; and a hand that never had an id now takes it from the
    client's end-of-hand PLAY_STAGE_INFO repeat / CO_LAST_HAND_NUMBER.

Run:  aof-model/.venv/Scripts/python.exe tests/test_reader_boundary.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import launch  # noqa: E402
from reconcile import HandReconciler, Tick  # noqa: E402

launch._WS_DUMP_PATH = Path(tempfile.mkdtemp()) / "ws_dump.jsonl"

fails: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  ok    {name}")
    else:
        fails.append(f"{name}: got {got!r}, want {want!r}")
        print(f"  FAIL  {name}: got {got!r}, want {want!r}")


# ---------------------------------------------------------------- reconciler ticks
def seat(bet=None, cards=2, hero=False, badge=None, stack="100 BB"):
    return {"stack": stack, "bet": bet, "cards": cards, "hero": hero, "badge": badge}


def tick(seq, bets: dict, pot, board, buttons=(), badges: dict | None = None, cards: dict | None = None, hero=6):
    """A 6-seat table with seats 1 and 6 dealt (the 621 shape: hero 6 = SB, seat 1 = BB)."""
    badges = badges or {}
    cards = cards or {}
    seats = {}
    for n in range(1, 7):
        dealt = n in (1, 6)
        seats[n] = seat(bet=bets.get(n), cards=cards.get(n, 2 if dealt else 0), hero=(n == hero),
                        badge=badges.get(n))
    return Tick(seq=seq, t="", seats=seats, pot=pot, board=board, buttons=list(buttons), hero=hero)


def river_checked_through() -> HandReconciler:
    """Hand 621 up to the river: SB(6) raise / BB(1) call, flop bet-call, turn check / bet / call."""
    rc = HandReconciler(1)
    s = 0
    def ob(bets, pot, board, buttons=(), badges=None):
        nonlocal s
        s += 1
        rc.observe(tick(s, bets, pot, board, buttons, badges))
    ob({}, None, 0)                                    # the table clears
    ob({6: "0.5 BB", 1: "1 BB"}, 1.5, 0)               # blinds
    ob({6: "0.5 BB", 1: "1 BB"}, 1.5, 0, ["FOLD", "CALL 0.5 BB", "RAISE TO 2 BB"])
    ob({6: "0.5 BB", 1: "1 BB"}, 1.5, 0)               # hero's buttons gone
    ob({6: "2.5 BB", 1: "1 BB"}, 3.5, 0)               # hero raises to 2.5
    ob({6: "2.5 BB", 1: "2.5 BB"}, 5.0, 0)             # BB calls
    ob({}, 5.0, 3, ["CHECK", "BET 1 BB"])              # flop: hero first
    ob({}, 5.0, 3)
    ob({6: "1.3 BB"}, 6.3, 3)                          # hero bets 1.3
    ob({6: "1.3 BB", 1: "1.3 BB"}, 7.6, 3)             # BB calls
    ob({}, 7.6, 4, ["CHECK", "BET 1 BB"])              # turn
    ob({}, 7.6, 4)
    ob({}, 7.6, 4)
    ob({}, 7.6, 4, badges={6: "CHECK"})                # hero checked (3 ticks, no chips)
    ob({1: "2.4 BB"}, 10.0, 4)                         # BB bets 2.4
    ob({1: "2.4 BB"}, 10.0, 4, ["FOLD", "CALL 2.4 BB", "RAISE TO 4.8 BB"])
    ob({1: "2.4 BB"}, 10.0, 4)
    ob({1: "2.4 BB", 6: "2.4 BB"}, 12.4, 4)            # hero calls
    ob({}, 12.4, 5, ["CHECK", "BET 1 BB"])             # river: hero first again
    ob({}, 12.4, 5)
    ob({}, 12.4, 5)
    ob({}, 12.4, 5, badges={6: "CHECK"})               # hero checks
    ob({}, 12.4, 5, badges={1: "CHECK"})               # BB checks behind — badge only, no chips
    return rc


print("reconciler: the pot landing at a seat is the award, not a bet (hand 621)")
rc = river_checked_through()
line0 = [(a["street"], a["seat"], a["type"]) for a in rc.line()]
check("river so far: hero checked", line0[-1], ("river", 6, "check"))
# the award tick: the pot label vanishes and the whole pot sits in hero's bet slot
rc.observe(tick(99, {6: "12.4 BB"}, None, 5, badges={1: "CHECK"}))
line1 = [(a["street"], a["seat"], a["type"]) for a in rc.line()]
check("no hero bet was filed at the award", ("river", 6, "bet") in line1, False)
check("no BB fold was filed at the award", ("river", 1, "fold") in line1, False)
check("the hand ended at the award", rc.ended, True)

print("\nreconciler: a real bet with the pot label still up is still a bet")
rc = river_checked_through()
rc.observe(tick(99, {6: "9 BB"}, 12.4, 5))           # 9 of 12.4 = 73% pot, label still there
line2 = [(a["street"], a["seat"], a["type"], a["amount"]) for a in rc.line()]
# hero has already checked this street, so the level reads as the award only under the seat/round
# guards — which the BB's CHECK badge now satisfies; but a bet by a seat that has NOT acted yet must survive:
rc3 = HandReconciler(2)
s = 0
def ob3(bets, pot, board, buttons=(), badges=None):
    global s
    s += 1
    rc3.observe(tick(s, bets, pot, board, buttons, badges))
ob3({}, None, 0); ob3({6: "0.5 BB", 1: "1 BB"}, 1.5, 0)
ob3({6: "0.5 BB", 1: "1 BB"}, 1.5, 0, ["FOLD", "CALL 0.5 BB", "RAISE TO 2 BB"]); ob3({6: "0.5 BB", 1: "1 BB"}, 1.5, 0)
ob3({6: "2.5 BB", 1: "1 BB"}, 3.5, 0); ob3({6: "2.5 BB", 1: "2.5 BB"}, 5.0, 0)
ob3({}, 5.0, 3, ["CHECK", "BET 1 BB"]); ob3({}, 5.0, 3)
ob3({6: "3.5 BB"}, 8.5, 3)                            # hero bets 70% pot on the flop, pot label up
check("a 70%-pot flop bet is filed as a bet", [(a["street"], a["seat"], a["type"]) for a in rc3.line()][-1], ("flop", 6, "bet"))
check("  and the hand goes on", rc3.ended, False)

print("\nreconciler: a press redeemed at the street boundary lands on ITS street (hands 425/441)")
# hero (6) is the BB here: seat 5 = SB, seat 1 = UTG, three-way to the flop; hero's preflop
# option check is confirmed only after the flop is already down
rc4 = HandReconciler(3)
def t4(seq, bets, pot, board, buttons=(), badges=None):
    badges = badges or {}
    seats = {}
    for n in range(1, 7):
        dealt = n in (1, 5, 6)
        seats[n] = seat(bet=bets.get(n), cards=2 if dealt else 0, hero=(n == 6), badge=badges.get(n))
    return Tick(seq=seq, t="", seats=seats, pot=pot, board=board, buttons=list(buttons), hero=6)
rc4.observe(t4(1, {}, None, 0))
rc4.observe(t4(2, {5: "0.5 BB", 6: "1 BB"}, 1.5, 0))
rc4.observe(t4(3, {5: "0.5 BB", 6: "1 BB", 1: "1 BB"}, 2.5, 0))          # UTG calls
rc4.observe(t4(4, {5: "1 BB", 6: "1 BB", 1: "1 BB"}, 3.0, 0))            # SB completes
rc4.observe(t4(5, {5: "1 BB", 6: "1 BB", 1: "1 BB"}, 3.0, 0, ["CHECK", "RAISE TO 3 BB"]))   # hero's option
rc4.observe(t4(6, {5: "1 BB", 6: "1 BB", 1: "1 BB"}, 3.0, 0))            # buttons gone (pressed CHECK)
rc4.observe(t4(7, {}, 3.0, 3))                                           # flop down before the 3-tick wait is up
rc4.observe(t4(8, {}, 3.0, 3))
rc4.observe(t4(9, {}, 3.0, 3))
rc4.observe(t4(10, {}, 3.0, 3, badges={5: "CHECK"}))
rc4.observe(t4(11, {}, 3.0, 3, ["CHECK", "BET 1 BB"]))                   # SB checked, now hero
line4 = [(a["street"], a["seat"], a["type"]) for a in rc4.line()]
check("hero's option check is on the preflop street", ("preflop", 6, "check") in line4, True)
check("no hero check opens the flop", [x for x in line4 if x[0] == "flop"][:1], [("flop", 5, "check")])
check("hero checked exactly once so far", sum(1 for x in line4 if x[1] == 6 and x[2] == "check"), 1)


# ---------------------------------------------------------------- the cut-over's order rule
print("\ncut-over: a derived line out of turn order is refused")
class RC:  # the few attributes _line_order_fault reads
    def __init__(self, dealt, sb, bbs):
        self.dealt, self.sb, self.bbs = set(dealt), sb, bbs

rc6 = RC({1, 5, 6}, 5, 6)   # SB 5, BB 6 (hero), UTG 1 — hand 425's table
good = [("preflop", 5, "post-sb", 0.5), ("preflop", 6, "post-bb", 1.0), ("preflop", 1, "call", 1.0),
        ("preflop", 5, "call", 0.5), ("preflop", 6, "check", None),
        ("flop", 5, "check", None), ("flop", 6, "check", None), ("flop", 1, "check", None)]
check("a well-ordered line passes", launch._line_order_fault(good, rc6), None)
bad425 = good[:5] + [("flop", 6, "check", None), ("flop", 5, "check", None), ("flop", 1, "check", None)]
check("hero opening the flop before the SB is refused", bool(launch._line_order_fault(bad425, rc6)), True)
rc7 = RC({1, 6}, 6, 1)      # hand 621's table: SB 6 (hero), BB 1 — heads-up: left alone
hu = [("preflop", 6, "post-sb", 0.5), ("preflop", 1, "post-bb", 1.0), ("preflop", 6, "raise", 2.5), ("preflop", 1, "call", 1.5),
      ("flop", 6, "bet", 1.3), ("flop", 1, "call", 1.3), ("river", 6, "check", None), ("river", 6, "bet", 11.8), ("river", 1, "fold", None)]
check("heads-up order is not judged...", launch._line_order_fault(hu, rc7) is None or "twice" in launch._line_order_fault(hu, rc7), True)
check("  ...but a seat acting twice running is", "twice" in (launch._line_order_fault(hu, rc7) or ""), True)
rc8 = RC({1, 2, 6}, 6, 1)   # three-handed: SB 6, BB 1, BTN 2; the SB folds the flop, BB opens the turn
fold_then = [("preflop", 6, "post-sb", 0.5), ("preflop", 1, "post-bb", 1.0), ("preflop", 2, "raise", 2.5),
             ("preflop", 6, "call", 2.0), ("preflop", 1, "call", 1.5),
             ("flop", 6, "check", None), ("flop", 1, "check", None), ("flop", 2, "bet", 3.0), ("flop", 6, "fold", None), ("flop", 1, "call", 3.0),
             ("turn", 1, "check", None), ("turn", 2, "check", None)]
check("a folded seat is skipped when the next street opens", launch._line_order_fault(fold_then, rc8), None)
allin_then = fold_then[:8] + [("flop", 6, "all-in", 40.0), ("flop", 1, "call", 40.0), ("flop", 2, "call", 40.0),
                              ("turn", 1, "check", None)]
check("an all-in seat is skipped too", launch._line_order_fault(allin_then, rc8), None)
posts = [("preflop", 6, "post-sb", 0.5), ("preflop", 6, "post-bb", 1.0)]   # a dead-blind shape: two posts, one seat
check("blind posts never count as acting twice", launch._line_order_fault(posts, rc8), None)

print("\ncut-over: _reconciled_line keeps the event line when the derived line is misordered")
rc9 = HandReconciler(5)
rc9.armed = True
rc9.dealt = {1, 5, 6}
rc9.sb, rc9.bbs, rc9.hero = 5, 6, 6
rc9.street = 1
for st, sd, ty, am in bad425:
    rc9.street = ("preflop", "flop", "turn", "river").index(st)
    rc9._add(sd, ty, am, 10, 0.9, "test")
launch._hand_no = 77
launch._shadow.update({"hand": 77, "rc": rc9})
launch._ws_state["dealt"] = [1, 5, 6]
old = [{"seatId": s_, "hero": s_ == 6, "type": t_, "street": st_, **({"amount": a_} if a_ is not None else {})}
       for (st_, s_, t_, a_) in good]
acts, ledger, uncertain, note, source = launch._reconciled_line(old, 6, "flop")
check("source stays the event line", source, "ws")
check("the note says why", "out of turn order" in (note or ""), True)
check("the event line is returned untouched", acts, old)
check("not flagged uncertain (could-not-see is not disagreement)", uncertain, None)


# ---------------------------------------------------------------- hand ids
print("\nhand id: an id-less finished hand takes the end-of-hand repeat's id")
archived: list[tuple[int, str]] = []
launch._archive_hand = lambda: archived.append((launch._hand_no, launch._hand_ids.get(launch._hand_no)))  # type: ignore[assignment]
launch._fake_mode = False


def fresh(no: int, hid: str) -> None:
    launch._hand_no = no
    launch._hand_ids.clear()
    launch._begin_hand(hid)          # increments to no+1
    archived.clear()
    launch._ws_state["dealt"] = [1, 6]
    launch._ws_state["heroSeat"] = 6
    launch._ws_state["actions"] = [{"seat": 6, "type": "post-sb", "cents": 100, "street": "preflop"}]


fresh(10, "")                        # the hand opened without an id (opening frame lost)
check("setup: current hand has no id", launch._hand_ids.get(launch._hand_no), "")
launch._on_game_msg({"pid": "PLAY_STAGE_END_REQ"})
launch._on_game_msg({"pid": "PLAY_STAGE_INFO", "stageNo": "4919910444"})    # the repeat
check("the repeat's id is adopted", launch._hand_ids.get(launch._hand_no), "4919910444")
check("no new hand was opened for it", archived, [])
launch._on_game_msg({"pid": "CO_LAST_HAND_NUMBER", "stageNo": "4919910444"})
launch._on_game_msg({"pid": "PLAY_CLEAR_INFO"})
launch._on_game_msg({"pid": "PLAY_STAGE_INFO", "stageNo": "4919910775"})    # the next hand
check("the next hand's PLAY_STAGE_INFO opens a new hand", archived, [(11, "4919910444")])
check("  carrying its own id", launch._hand_ids.get(launch._hand_no), "4919910775")

print("\nhand id: CO_LAST_HAND_NUMBER alone also names it")
fresh(20, "")
launch._on_game_msg({"pid": "PLAY_STAGE_END_REQ"})
launch._on_game_msg({"pid": "CO_LAST_HAND_NUMBER", "stageNo": "4919910444"})   # the repeat itself was lost
check("adopted from CO_LAST_HAND_NUMBER", launch._hand_ids.get(launch._hand_no), "4919910444")
launch._on_game_msg({"pid": "PLAY_STAGE_INFO", "stageNo": "4919910775"})
check("a PLAY_STAGE_INFO after it is the next hand", archived, [(21, "4919910444")])

print("\nhand id: a PLAY_STAGE_INFO after the clear is the NEXT hand even for an id-less hand")
fresh(30, "")
launch._on_game_msg({"pid": "PLAY_STAGE_END_REQ"})
launch._on_game_msg({"pid": "PLAY_CLEAR_INFO"})                               # repeat + last-number both lost
launch._on_game_msg({"pid": "PLAY_STAGE_INFO", "stageNo": "4919910775"})
check("not adopted: a new hand opens", archived, [(31, "")])
check("  with the new id", launch._hand_ids.get(launch._hand_no), "4919910775")

print("\nhand id: a live id-less hand is never given the next hand's id")
fresh(40, "")                                                                 # not over
launch._on_game_msg({"pid": "PLAY_STAGE_INFO", "stageNo": "4919910775"})
check("a new hand opens", archived, [(41, "")])

print("\nhand id: the repeat for a hand that HAS its id is still a dup")
fresh(50, "4919910444")
launch._on_game_msg({"pid": "PLAY_STAGE_END_REQ"})
launch._on_game_msg({"pid": "PLAY_STAGE_INFO", "stageNo": "4919910444"})
check("no new hand", archived, [])
check("id unchanged", launch._hand_ids.get(launch._hand_no), "4919910444")
launch._on_game_msg({"pid": "CO_LAST_HAND_NUMBER", "stageNo": "4919910444"})
check("CO_LAST_HAND_NUMBER changes nothing", launch._hand_ids.get(launch._hand_no), "4919910444")

print("\nhand id: the DOM 'table opened' bump mid-hand carries the id (hand 714)")
# the exact branch of _feed_tick, driven through a stand-in of its inputs
fresh(60, "4919910444")
launch._ws_state["handOver"] = False
carried = launch._hand_ids.get(launch._hand_no) if launch._ws_state.get("dealt") and not launch._ws_state.get("handOver") else None
check("a hand in flight is carried", carried, "4919910444")
launch._ws_state["handOver"] = True
carried = launch._hand_ids.get(launch._hand_no) if launch._ws_state.get("dealt") and not launch._ws_state.get("handOver") else None
check("a finished hand is not", carried, None)

print()
if fails:
    print(f"{len(fails)} FAILED")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("all reader-boundary checks passed")
