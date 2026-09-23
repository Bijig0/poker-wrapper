"""One page holds up to four tables, so the tap sees every table's frames — isolate ours by socket.

Ignition seats up to four tables in a SINGLE page (see launch.ignition_target), each an iframe with its own
WebSocket. `Network.enable` is page-wide, so the tap receives all of them, and the payloads carry no table id
worth the name (`tableNo` rides on PLAY_TABLE_NUMBER alone — 50 frames out of 32,102 in the recorded dump).
The result is a second table's hand interleaving into ours: that dump contains 54 hand ids that RESUME after
another hand had started, and that is how a different hand's board, pot and actions end up inside the hand we
export.

CDP does say which socket a frame arrived on (`params.requestId`, one per WebSocket, one per table), and only
hero's OWN table shows his hole cards face up. These tests pin that behaviour:

  * frames with no socket id behave exactly as before (fake mode, replay harnesses)
  * the tap binds to the socket that reveals hero's cards
  * once bound, another table's frames are dropped
  * MULTI-TABLE: hero's cards are face up at every table he is seated at, so "some hand is face up here" no
    longer separates them. What does is WHICH SEAT they are dealt to: the client tags hero's own seat inside
    our own slot's frame (myPlayerTag), so the socket dealing into OUR seat is ours. Until one is
    identified the tap DROPS rather than accepts — reading the wrong table is worse than reading no table,
    and this is the case that used to accept everything.

This last part is not hypothetical. In the first real two-table session (2026-09-21) both wrappers ingested
both tables' sockets: table 1's aces landed in table 2's hand state, the shadow reconciler disagreed on
every hand it compared, and auto-execute refused to press on state it could not trust. That session's dump
shows every frame of both sockets recorded twice, once under each wrapper's hand numbering.

Run:  aof-model/.venv/Scripts/python.exe tests/test_tap_isolation.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import tempfile  # noqa: E402

import launch  # noqa: E402
import tables as TABLES  # noqa: E402

# the binder logs <tap-*> events; they must not land in the REAL post-mortem
# dump (rid-A/rid-B were found in debug/ws_dump.jsonl mid-session)
launch._WS_DUMP_PATH = Path(tempfile.mkdtemp()) / "ws_dump.jsonl"

FACE_DOWN = 32896
OURS = {"pid": "CO_CARDTABLE_INFO", "seat1": [FACE_DOWN, FACE_DOWN], "seat2": [33, 51]}   # seat2 is hero
# a table we are not seated at: every hand is face down to us
THEIRS = {"pid": "CO_CARDTABLE_INFO", "seat1": [FACE_DOWN, FACE_DOWN], "seat3": [FACE_DOWN, FACE_DOWN]}
STAGE = {"pid": "PLAY_STAGE_INFO", "stageNo": "123"}

fails: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  ok    {name}")
    else:
        fails.append(f"{name}: got {got!r}, want {want!r}")
        print(f"  FAIL  {name}: got {got!r}, want {want!r}")


def reset(slot: int | None = None, hero_seat: int | None = None) -> None:
    launch._tap_bound = None
    launch._tap_foreign = 0
    launch._tap_held = 0
    launch._tap_mismatch = 0
    launch._tap_seen = {}
    launch._tap_dealt = {}
    launch._tap_claims = {}
    launch._tap_rejected = set()
    launch._tap_hold = {}
    launch._tap_replay = []
    launch._tap_dom_cards = []
    launch._tap_ambiguous_said = set()
    launch._ws_state["heroCards"] = []
    launch._live_status["heroSeatDom"] = hero_seat
    TABLES.slot = lambda: slot          # type: ignore[assignment]


def dealt(seat: int, cards: list[int], others=(1, 3, 5)) -> dict:
    """A CO_CARDTABLE_INFO as one table sends it: hero's own seat face up, the
    rest face down."""
    d = {"pid": "CO_CARDTABLE_INFO", f"seat{seat}": list(cards)}
    for o in others:
        if o != seat:
            d[f"seat{o}"] = [FACE_DOWN, FACE_DOWN]
    return d


print("tap socket isolation")

# 1. no socket id at all — the replay harnesses and fake mode must be untouched
reset()
check("no requestId is always accepted", launch._tap_accepts(STAGE, None), True)
check("  and never binds", launch._tap_bound, None)

# 2. binds to the socket that shows hero's cards
reset()
launch._tap_accepts(THEIRS, "rid-B")
check("a table without hero's cards does not bind", launch._tap_bound, None)
launch._tap_accepts(OURS, "rid-A")
check("the socket showing hero's cards binds", launch._tap_bound, "rid-A")

# 3. once bound, the other table's frames are dropped
check("our own socket is accepted", launch._tap_accepts(STAGE, "rid-A"), True)
check("the other table's frames are dropped", launch._tap_accepts(STAGE, "rid-B"), False)
check("  and counted", launch._tap_foreign, 1)
launch._tap_accepts(THEIRS, "rid-B")
check("  repeatedly", launch._tap_foreign, 2)

# 4. everything before the binding is let through, so nothing is lost while we learn
reset()
check("pre-binding frames pass", launch._tap_accepts(STAGE, "rid-B"), True)

# 5. MULTI-TABLE: the seat is what separates the tables
# hero sits in seat 3 at our table and seat 1 at the other — the shape of the real
# session's dump, where the two sockets dealt to seat 1 and seat 3
OURS_3 = dealt(3, [33, 51])              # our table: hero in seat 3
OTHER_1 = dealt(1, [25, 34])             # our OTHER table: hero in seat 1, cards of its own

print("\nmulti-table: bind by the seat the client says is ours")
reset(slot=2, hero_seat=3)
check("a socket dealing into ANOTHER seat does not bind us", launch._tap_accepts(OTHER_1, "rid-B") or launch._tap_bound, None)
check("  ... and its frames are not taken in the meantime", launch._tap_accepts(STAGE, "rid-B"), False)
launch._tap_accepts(OURS_3, "rid-A")
check("the socket dealing into OUR seat binds", launch._tap_bound, "rid-A")
check("  ... ours is accepted", launch._tap_accepts(STAGE, "rid-A"), True)
check("  ... and the other table is dropped", launch._tap_accepts(STAGE, "rid-B"), False)

print("\nunbound means DROP, never mix (this is the bug that was shipped)")
reset(slot=2, hero_seat=3)
check("a frame from an unidentified socket is dropped", launch._tap_accepts(STAGE, "rid-B"), False)
check("  ... and counted as held", launch._tap_held, 1)
check("  ... including the other table's deal", launch._tap_accepts(OTHER_1, "rid-B"), False)
check("  ... so nothing of another table's hand is ever read", launch._tap_bound, None)

print("\nbind at SIT-DOWN, not at the deal (2026-09-22: the first hand at each table was lost)")
BUYIN_3 = {"pid": "PLAY_BUYIN_INFO", "type": 1, "seat": 3, "displayMax": 20000, "account": 7437}
BUYIN_1 = {"pid": "PLAY_BUYIN_INFO", "type": 1, "seat": 1, "displayMax": 20000, "account": 7437}
SIT_3 = {"pid": "CO_SIT_PLAY", "play": 1, "seat": 3}
CASH_3 = {"pid": "PLAY_ACCOUNT_CASH_RES", "type": 2, "seat": 3, "cash": 2500}   # broadcast: NOT a claim
SEAT_3 = {"pid": "PLAY_SEAT_INFO", "type": 1, "seat": 3, "nickName": "x"}       # broadcast: NOT a claim
BLINDS = {"pid": "CO_BLIND_INFO", "seat": 1, "bet": 10}

reset(slot=2, hero_seat=3)
launch._tap_accepts(BUYIN_1, "rid-B")
check("the other table's buy-in (another seat) does not bind us", launch._tap_bound, None)
launch._tap_accepts(CASH_3, "rid-B")
launch._tap_accepts(SEAT_3, "rid-B")
check("broadcast seat frames naming our seat do not bind", launch._tap_bound, None)
launch._tap_accepts(BUYIN_3, "rid-A")
check("OUR buy-in, naming our seat, binds before any card is dealt", launch._tap_bound, "rid-A")
check("  ... and hands the held frame back for reading", [f["pid"] for f in launch._tap_take_replay()],
      ["PLAY_BUYIN_INFO"])
check("  ... once", launch._tap_take_replay(), [])

reset(slot=2, hero_seat=3)
launch._tap_accepts(SIT_3, "rid-A")
check("our sit-in toggle binds too", launch._tap_bound, "rid-A")

print("\nheld, then replayed: a late bind still reads the hand from its first frame")
reset(slot=2, hero_seat=None)                           # the DOM has not tagged our seat yet
launch._tap_accepts({"pid": "PLAY_STAGE_INFO", "stageNo": "old"}, "rid-A")
launch._tap_accepts(BLINDS, "rid-A")
launch._tap_accepts(STAGE, "rid-A")                     # a NEW hand: the old one's frames are let go
launch._tap_accepts(BLINDS, "rid-A")
launch._tap_accepts(STAGE, "rid-B")                     # the other table's hand
launch._tap_accepts(BLINDS, "rid-B")
check("nothing binds without our seat", launch._tap_bound, None)
launch._live_status["heroSeatDom"] = 3
took = launch._tap_accepts(OURS_3, "rid-A")
check("the deal binds", launch._tap_bound, "rid-A")
check("  ... the binding frame itself comes back through replay, not twice", took, False)
check("  ... replay = OUR socket's hand from its PLAY_STAGE_INFO, in order",
      [(f["pid"], f.get("stageNo")) for f in launch._tap_take_replay()],
      [("PLAY_STAGE_INFO", "123"), ("CO_BLIND_INFO", None), ("CO_CARDTABLE_INFO", None)])
check("  ... and the other table's held frames are gone", launch._tap_hold, {})

print("\nthe same seat number at both tables: cards decide, never a guess")
reset(slot=2, hero_seat=3)
launch._live_status["heroSeatDom"] = None
launch._tap_accepts(BUYIN_3, "rid-A")
launch._tap_accepts(BUYIN_3, "rid-B")
launch._live_status["heroSeatDom"] = 3
launch._tap_accepts(STAGE, "rid-B")
check("two sockets name our seat: stay unbound", launch._tap_bound, None)
launch._tap_accepts(dealt(3, [7, 8]), "rid-B")          # rid-B deals 9c 10c into seat 3
launch._tap_accepts(dealt(3, [33, 51]), "rid-A")        # rid-A deals ours
check("  ... still unbound until our own frame shows its cards", launch._tap_bound, None)
launch._tap_verify([launch._card_name("card33"), launch._card_name("card51")])
launch._tap_accepts(STAGE, "rid-B")                     # any next frame re-tries
check("  ... then the socket that dealt THOSE cards binds", launch._tap_bound, "rid-A")

print("\na socket let go for dealing the wrong cards is not re-bound on its claim")
reset(slot=2, hero_seat=3)
launch._tap_accepts(BUYIN_3, "rid-A")
launch._tap_unbind("test")
launch._tap_accepts(STAGE, "rid-A")
check("its buy-in no longer binds it", launch._tap_bound, None)

print("\n... but the single-table path is untouched")
reset(slot=None)
check("one table still accepts while it looks", launch._tap_accepts(STAGE, "rid-B"), True)
check("  ... and still binds on any face-up hand", (launch._tap_accepts(OURS, "rid-A"), launch._tap_bound)[1], "rid-A")

print("\nthe DOM has not named our seat yet")
reset(slot=2, hero_seat=None)
launch._tap_accepts(OURS_3, "rid-A")
check("nothing binds on a guess", launch._tap_bound, None)
check("  ... and nothing is read", launch._tap_accepts(STAGE, "rid-A"), False)
launch._live_status["heroSeatDom"] = 3
launch._tap_accepts(OURS_3, "rid-A")
check("  ... it binds as soon as the DOM says which seat is hero's", launch._tap_bound, "rid-A")

print("\na mis-bind lets go by itself")
# hero's cards as OUR OWN frame renders them are the arbiter: a socket that dealt
# something else is another table's, however it came to be bound
reset(slot=2, hero_seat=3)
launch._tap_accepts(OURS_3, "rid-A")
launch._ws_state["heroCards"] = ["Ah", "Ad"]          # what the bound socket dealt
for _ in range(launch._TAP_MISMATCH_TICKS - 1):
    launch._tap_verify(["7c", "2d"])                  # what our own frame shows
check("a few disagreeing ticks are ridden out (the DOM lags a fresh deal)", launch._tap_bound, "rid-A")
launch._tap_verify(["7c", "2d"])
check("  ... sustained disagreement lets the socket go", launch._tap_bound, None)
launch._tap_accepts(OURS_3, "rid-A")
check("  ... and it can bind again", launch._tap_bound, "rid-A")

launch._tap_verify(["Ah", "Ad"])
launch._ws_state["heroCards"] = ["Ah", "Ad"]
launch._tap_verify(["Ad", "Ah"])                      # same two cards, other order
check("agreement in any order resets the counter", launch._tap_mismatch, 0)
launch._tap_verify([])                                # between hands: says nothing
check("  ... and an empty read is not a disagreement", launch._tap_mismatch, 0)

print("\nthe seat the binder compares is the DISPLAYED one, not the container index")
# THIS IS THE BUG THAT SHIPPED. seatQa carries both: `seat` is
# playerContainer-N (0-based) and `num` is the number the client draws on the
# felt (1-based) — which is the numbering the WebSocket's seatN keys use.
# Comparing the wrong one matched nothing, so every frame was dropped and a live
# two-table session ran with no capture at all while /state still said
# "connected".
DOM = {"seatQa": [{"seat": 0, "num": 1, "me": False},
                  {"seat": 2, "num": 4, "me": True},      # hero: container 2, felt seat 4
                  {"seat": 3, "num": 6, "me": False}]}
check("hero's seat is read as the client draws it", launch._dom_hero_seat(DOM), 4)
check("  ... not as the container index", launch._dom_hero_seat(DOM) != 2, True)
check("no seat tagged as ours: None, never a guess", launch._dom_hero_seat({"seatQa": [{"seat": 0, "num": 1}]}), None)
check("  ... and an untagged capture is None too", launch._dom_hero_seat({}), None)
check("a seat with no drawn number is not a seat", launch._dom_hero_seat({"seatQa": [{"seat": 1, "num": None, "me": True}]}), None)

# and the binder must agree with the WS's own keys: seat4 here, not seat2
reset(slot=2, hero_seat=launch._dom_hero_seat(DOM))
launch._tap_accepts(dealt(2, [33, 51]), "rid-container")     # the container index
check("a socket dealing to the CONTAINER index does not bind", launch._tap_bound, None)
launch._tap_accepts(dealt(4, [33, 51]), "rid-felt")          # the drawn seat number
check("  ... the one dealing to the drawn seat does", launch._tap_bound, "rid-felt")

print("\nhero's cards come from OUR table or from nowhere")
# the tab-strip minis are read from the top page, outside every table iframe —
# at two tables both wrappers read the same strip and reported the same hole
# cards for both tables (observed live: 10h 8d on both)
MINIS = {"heroMini": [{"qa": "card33", "x": 10, "y": 8, "w": 20},
                      {"qa": "card51", "x": 32, "y": 8, "w": 20}], "seatQa": [], "allCards": []}
TABLES.slot = lambda: None
check("one table still reads the minis (they cover blind stretches)",
      len(launch._hero_cards(MINIS)), 2)
TABLES.slot = lambda: 2
check("  ... several tables never do — no cards beats another table's cards",
      launch._hero_cards(MINIS), [])

print("\nthe real thing: the 2026-09-21 session's own frames")
# 756 frames off ONE page carrying TWO tables — sockets 9240.618 (hero in seat 1)
# and 9240.1035 (hero in seat 3), captured while both wrappers were reading both.
# Nothing here is authored: this is what the client actually sent.
import json  # noqa: E402
from collections import Counter  # noqa: E402

FIX = json.loads((ROOT / "tests" / "fixtures" / "multitable-ws-2026-09-21.json").read_text(encoding="utf-8"))
FRAMES = FIX["frames"]


def replay(hero_seat: int, slot: int):
    reset(slot=slot, hero_seat=hero_seat)
    took = Counter()
    for i, f in enumerate(FRAMES):
        was = launch._tap_bound
        if launch._tap_accepts(f["d"], f["rid"]):
            took[f["rid"]] += 1
        took[launch._tap_bound] += len(launch._tap_take_replay())
        if was is None and launch._tap_bound is not None:
            BOUND_AT[hero_seat] = i
    return launch._tap_bound, +took


BOUND_AT: dict = {}


check("the fixture really is two tables on one page",
      sorted({f["rid"] for f in FRAMES}), ["9240.1035", "9240.618"])

bound_a, took_a = replay(hero_seat=1, slot=1)
check("the wrapper whose hero sits in seat 1 binds table 1's socket", bound_a, "9240.618")
check("  ... and reads nothing of the other table", sorted(took_a), ["9240.618"])

bound_b, took_b = replay(hero_seat=3, slot=2)
check("the wrapper whose hero sits in seat 3 binds table 2's socket", bound_b, "9240.1035")
check("  ... and reads nothing of the other table", sorted(took_b), ["9240.1035"])

check("the two wrappers ended up on DIFFERENT sockets", bound_a != bound_b, True)
# the deal came at frames 190 (table 1) and 49 (table 2); each table's buy-in at 10 and 23
check("table 1 binds on its buy-in, long before its first deal", BOUND_AT.get(1), 10)
check("table 2 binds on its buy-in, long before its first deal", BOUND_AT.get(3), 23)

reset()
launch._live_status["heroSeatDom"] = None
print()
if fails:
    print(f"FAILED {len(fails)}")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("all clean")
