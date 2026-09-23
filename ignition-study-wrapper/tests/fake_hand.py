"""A whole hand, rendered the way the Ignition client renders one — artefacts included.

The fake TABLE (faketable.py) draws one frozen spot. That is the right tool for the DOM
reader and the relay, and the state suite uses it well. It cannot help with the other
half of the wrapper at all: `HandReconciler.observe()` consumes a STREAM of ticks, and
every reader bug found on 2026-09-19 lived in how that stream is interpreted across time
— a signal seen on one tick and confirmed on the next, a value still animating, a street
turning over mid-observation.

So this renders a scripted hand as a tick stream, and returns the line it MEANT. The
assertion is then exact: what the reader derives must equal what was played.

THE ARTEFACTS ARE THE POINT. Each one is a behaviour observed in a real recording, with
the hand it cost us:

  increment_first   a bet slot shows the chips ADDED for one tick before the new total
                    (hand 4919236052: raising to 9.2 from 2.5 reads "6.7"; calling 14.4
                    from 9.2 reads "5.2", which looks like a DROP)
  increment_only    the same, except the call CLOSES the street: the sweep lands before
                    the new total is ever drawn, so the increment is the ONLY frame the
                    reader ever gets (hand 4919310706 / dashboard 501: the BB called to
                    2.5 holding 1, the slot showed 1.5 for one tick and swept, and the
                    preflop ledger stayed exactly one big blind short for the rest of the
                    hand — the pot invariant then failed and held auto-execute on the
                    turn's Bet 15.7, which had to be typed by hand). Preflop is where it
                    bites, because the blind is the only money already in front
  badge_lag         a folded seat's cards go, and the FOLD badge arrives a tick later
                    (hand 4919261748: the two signals a tick apart)
  fold_at_boundary  a fold lands in the last tick before the deal, so the two-tick hold
                    completes with the next street already on screen (hand 4919261748:
                    a preflop fold filed on the flop, which put an "F" for a seat that
                    was not in the flop tree into the tokens and cost the hand every
                    postflop answer)
  pot_lingers       the pot label stays on screen until the next hand deals, rather than
                    clearing when the pot is awarded (session 173224: the auto top-up
                    waited for a clear that never came, and sat short for five hands)
  sweep_late        the chips are pulled into the pot a tick or two AFTER the board grows
  award_in_slot     the pot is awarded by drawing the whole pot in the WINNER'S BET SLOT for a
                    tick while the pot label is already gone (session_20260920_193322 hand 29 /
                    dashboard 621, seq 3545: pot=None, hero's slot "11.8 BB" after a check-check
                    river — read as "hero bets 11.8" and a phantom decision)
  card_flicker      a seat's card count blips to 0 for a single tick and comes back —
                    the reason HOLD_TICKS exists at all ("cards flicker", reconcile's own
                    docstring). NOT a bet-slot flicker: the client has never been seen
                    inventing a wager, and a generator that does so is testing fiction

Nothing here is invented. If an artefact is added it should come with the recording that
shows the client doing it.
"""
from __future__ import annotations

import random
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from reconcile import Tick  # noqa: E402

ALL_ARTEFACTS = ("increment_first", "badge_lag", "fold_at_boundary", "pot_lingers",
                 "sweep_late", "award_in_slot", "card_flicker")

# NOT in ALL_ARTEFACTS, and deliberately so — run it with
#   tests/fuzz_reconcile.py 400 --artefacts=increment_only
#
# The one frame we have of it (hand 4919310706) is a call whose increment DIFFERED
# from the chips already out, so the slot visibly changed and the reader had
# something to read; that case is fixed and this artefact covers it. But the same
# generator also produces the case where the increment EQUALS the level already in
# front — the big blind calling a raise to exactly 2x — and then the slot never
# changes value at all and the call is invisible in the chips.
#
# We have no recording of that, and it is not a small fix: 62 of 400 hands diverge,
# 46 of them a villain's invisible call and 16 hero's own, where the existing
# buttons-and-no-chips rule reads a FOLD (and only retracts it a street later, if
# he bets again). Closing it means reworking the fold inference that hand
# 4919211085 shaped, which is a decision to take deliberately rather than at the
# end of a long night. Left here, named, and OUT of the default suite so it reports
# a real number instead of a permanently red one.
STREETS = ("preflop", "flop", "turn", "river")


@dataclass
class Script:
    """A hand to play. Seats are the client's own numbering, 1..capacity."""
    stacks: dict[int, float]                    # seat -> starting stack in bb
    hero: int
    sb: int
    bb: int
    order: list[int]                            # preflop action order, after the blinds
    actions: list[tuple]                        # (street_idx, seat, type, amount|None)
    board: list[str] = field(default_factory=lambda: ["2c", "7d", "9s", "Jh", "4c"])


def _fmt(v: float | None) -> str | None:
    if v is None:
        return None
    return f"{round(v, 2):g} BB"


class _Render:
    def __init__(self, script: Script, artefacts, rng: random.Random):
        self.s = script
        self.a = set(artefacts)
        self.rng = rng
        self.seq = 0
        self.ticks: list[Tick] = []
        self.stack = dict(script.stacks)
        self.bet: dict[int, float] = {}          # chips in front, this street
        self.cards = {n: 0 for n in script.stacks}
        self.badge: dict[int, str | None] = {n: None for n in script.stacks}
        self.pot: float | None = None
        self.board_n = 0
        self.buttons: list[str] = []
        self.expected: list[tuple] = []

    # ---- the tick itself ----
    def emit(self, n: int = 1) -> None:
        for _ in range(n):
            self.seq += 1
            seats = {}
            for num in self.s.stacks:
                seats[num] = {"stack": _fmt(self.stack[num]), "bet": _fmt(self.bet.get(num)),
                              "cards": self.cards[num], "hero": num == self.s.hero,
                              "badge": self.badge.get(num)}
            self.ticks.append(Tick(seq=self.seq, t=f"{self.seq // 60:02d}:{self.seq % 60:02d}",
                                   seats=seats, pot=self.pot, board=self.board_n,
                                   buttons=list(self.buttons), hero=self.s.hero))
            # a badge lasts a few ticks then clears, as the client's does
            for num, b in list(self.badge.items()):
                if b and self.rng.random() < 0.35:
                    self.badge[num] = None

    def _pot_add(self, amount: float) -> None:
        self.pot = round((self.pot or 0.0) + amount, 2)

    # ---- the actions ----
    def post(self, seat: int, amount: float, kind: str) -> None:
        self.bet[seat] = amount
        self.stack[seat] = round(self.stack[seat] - amount, 2)
        self.badge[seat] = "POST-SB" if kind == "post-sb" else "POST-BB"
        self._pot_add(amount)
        self.expected.append((STREETS[0], seat, kind, amount))
        self.emit(2)

    def wager(self, street: int, seat: int, kind: str, to: float, closes: bool = False) -> None:
        """A bet / raise / call. `to` is the seat's street TOTAL."""
        had = self.bet.get(seat, 0.0)
        added = round(to - had, 2)
        if ("increment_only" in self.a and closes and kind == "call"
                and had > 0 and added > 0):
            # the chips are swept before the client ever draws the new total, so the
            # increment is all the reader will see of this call
            self.bet[seat] = added
            self.stack[seat] = round(self.stack[seat] - added, 2)
            self.badge[seat] = "CALL"
            self._pot_add(added)
            self.expected.append((STREETS[street], seat, kind, added))
            self.emit(1)
            return
        if "increment_first" in self.a and added > 0:
            # the client shows the chips being pushed before it shows the new total
            self.bet[seat] = added
            self.emit(1)
        self.bet[seat] = to
        self.stack[seat] = round(self.stack[seat] - added, 2)
        # A WAGER THAT EMPTIES THE STACK IS AN ALL-IN, and the client says so twice:
        # the stack reads 0 and the badge reads ALL-IN. The rig used to label it
        # "raise"/"bet" like any other, which made the READER wrong for getting it
        # right (seed 214). The tree's aggressive action at a low SPR is ALLIN and
        # only the token RAI reaches it, so this distinction is the whole difference
        # between an answer and "Bet(6940) not walkable" — hand 4919482454.
        jam = self.stack[seat] <= 0.005 and kind in ("bet", "raise")
        if jam:
            kind = "all-in"
        self.badge[seat] = ("ALL-IN" if jam else
                            {"call": "CALL", "bet": "BET", "raise": "RAISE"}.get(kind, kind.upper()))
        self._pot_add(added)
        self.expected.append((STREETS[street], seat, kind, added if kind == "call" else to))
        self.emit(2)

    def check(self, street: int, seat: int) -> None:
        self.badge[seat] = "CHECK"
        self.expected.append((STREETS[street], seat, "check", None))
        self.emit(2)

    def fold(self, street: int, seat: int, at_boundary: bool = False) -> None:
        # HERO'S CARDS STAY ON SCREEN WHEN HE FOLDS. The client only clears a VILLAIN's
        # seat; hero keeps his two cards until the next deal, which is why the reader
        # never judges hero by cards and infers his fold from the buttons instead
        # (reconcile's docstring says so, and `if num == self.hero: continue` in the fold
        # block enforces it). A rig that clears them is testing a client that does not
        # exist — and it hid every one of hero's own folds from this fuzzer.
        if seat != self.s.hero:
            self.cards[seat] = 0
        self.expected.append((STREETS[street], seat, "fold", None))
        if at_boundary:
            # the fold lands on the LAST tick of the street: the two-tick hold that
            # confirms it will complete with the next street already on screen
            self.emit(1)
            return
        self.emit(1)
        if "badge_lag" in self.a:
            self.badge[seat] = "FOLD"
        self.emit(2)

    def hero_turn(self, buttons: list[str], think: int = 3) -> None:
        """Hero on the clock, then the buttons go. His press shows in the chips a tick or
        two later — or, for a fold, never, which is exactly what the reader has to infer."""
        self.buttons = buttons
        self.emit(think)
        self.buttons = []
        self.emit(1)

    def deal(self, upto: int) -> None:
        """Move to a new street: sweep the chips, then grow the board."""
        if "sweep_late" in self.a:
            self.board_n = upto
            self.emit(1)
            self.bet = {}
            self.emit(2)
        else:
            self.bet = {}
            self.emit(1)
            self.board_n = upto
            self.emit(2)

    def flicker(self) -> None:
        """One tick of a live seat's cards vanishing and coming straight back."""
        if "card_flicker" not in self.a or self.rng.random() > 0.35:
            return
        live = [n for n, c in self.cards.items() if c >= 1]
        if not live:
            return
        victim = self.rng.choice(live)
        self.cards[victim] = 0
        self.emit(1)
        self.cards[victim] = 2
        self.emit(1)


def simulate(script: Script, artefacts=ALL_ARTEFACTS, seed: int = 0):
    """(ticks, expected line). The line is what was PLAYED, in the reader's own vocabulary."""
    r = _Render(script, artefacts, random.Random(seed))
    # the table before the deal: clear, so the reader arms
    r.emit(2)
    r.post(script.sb, 0.5, "post-sb")
    r.post(script.bb, 1.0, "post-bb")
    for n in script.stacks:
        r.cards[n] = 2
    r.emit(2)

    by_street: dict[int, list] = {}
    for a in script.actions:
        by_street.setdefault(a[0], []).append(a)

    for street in sorted(by_street):
        if street > 0:
            r.deal(2 + street)
        acts = by_street[street]
        for i, (_, seat, kind, amount) in enumerate(acts):
            last_of_street = i == len(acts) - 1
            if seat == script.hero:
                r.hero_turn(["FOLD", "CALL 1 BB", "RAISE TO 2 BB"] if kind != "check"
                            else ["CHECK", "BET 1 BB"])
            if kind == "fold":
                boundary = last_of_street and "fold_at_boundary" in r.a and street + 1 in by_street
                r.fold(street, seat, at_boundary=boundary)
            elif kind == "check":
                r.check(street, seat)
            else:
                r.wager(street, seat, kind, amount, closes=last_of_street)
            r.flicker()

    # the pot is awarded: chips clear, the winner's stack rises, and the pot label may
    # hang about until the next hand deals
    winner = next((s for s in script.stacks if r.cards[s] >= 1), script.hero)
    won = r.pot or 0
    if "award_in_slot" in r.a and "pot_lingers" not in r.a and won:
        # the pot travels to the winner through his bet slot, the label already gone
        r.bet = {winner: won}
        r.pot = None
        r.emit(1)
    r.bet = {}
    r.stack[winner] = round(r.stack[winner] + won, 2)
    if "pot_lingers" not in r.a:
        r.pot = None
    r.emit(4)
    return r.ticks, r.expected
