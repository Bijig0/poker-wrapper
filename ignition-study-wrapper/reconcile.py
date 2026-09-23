"""reconcile — rebuild a hand's betting line from LEVELS, not edges (shadow mode, 2026-09-18).

The wrapper's live capture accumulates EVENTS (WebSocket frames, DOM badge/card
diffs) into an action log. One wrong edge is permanent, and a guard that trusts
the log over the client's own money threw away a real 3-bet (hand 368: a stale
FOLD label flashed for one tick on the seat that then raised).

The client keeps LEVELS on screen every tick: each seat's chips in front, its
stack, how many hole cards it holds, the pot, the board, and hero's own action
buttons with their amounts. Levels persist and stay consistent, so the line can
be DERIVED from how they change, in seat order:

    a seat's chips-in-front rise ........ call / bet / raise-to (the level IS the amount)
    a seat's hole cards go away ......... fold      (held two ticks: cards flicker)
    a FOLD badge held two ticks ......... fold, tentative (a badge is the weakest signal)
    hero's buttons vanish while owing,
      chips unchanged ................... hero folded (hero's cards stay on screen)
    a later seat acts while an earlier live seat has no action this street
      and owes nothing .................. that earlier seat checked
    the street changes / hand ends with live seats unacted and nothing owed ... checks

Order needs no dealer button: the small blind is the first 0.5 post and the big
blind the first 1.0; preflop action starts after the big blind, postflop at the
small blind, clockwise by displayed seat number over the seats that were dealt.

Everything derived carries a confidence and can be RETRACTED by later evidence
(chips from a "folded" seat, its cards back on the table). The line is a view
over the non-retracted journal. Invariants are checked every tick and recorded,
never silently fixed:

    pot == Σ chips committed on every street        (held 4 ticks: the pot lags the chips)
    hero's CALL x  ⇔  x == (standing bet − hero's chips in front)
    a seat holding cards has not folded; a seat adding chips is live
    preflop, every seat before an actor must have acted (it owed the blind)

Start of a hand: the table still shows the previous hand's chips, board and
cards for a few ticks. Nothing is read until the table has CLEARED (no chips in
front, or only the blinds with a matching pot).

This module is pure: it sees ticks and returns a line, violations and a journal.
It has no CDP, no feed, no side effects — the live hook (launch.py) and the
replay harness (tests/replay_reconcile.py) feed it the same tick shape.

THE RULE FOR ANYTHING OBSERVED OVER TIME
----------------------------------------
Every reader bug found on 2026-09-19 — six of them, in five different code paths —
was one rule broken. A signal that takes more than one tick to confirm (a seat's
cards going, a FOLD badge, hero's buttons vanishing) must be:

  1. TALLIED EVERY TICK, before any decision. Counting is not judging. The counters
     used to live below the arming gate, the street-armed gate, the `ended` guard and
     the sweep branch — all of which fire on street boundaries and pot awards, exactly
     where folds happen. A skipped tick froze the counter and the fold surfaced a
     street late.  -> _tally()
  2. DATED TO WHEN IT WAS SEEN, not when it was confirmed. `_add(..., street=)` with
     `hold_street[seat]`, which keys on the SEAT (cards-gone and the badge arrive a
     tick apart) and uses `street_armed` rather than the board (the board runs ahead
     of the street while the previous street's chips are still on the table).
  3. REDEEMED EXACTLY ONCE. Never twice — `_add` clears `hero_gone_at` for any action
     recorded for hero, because every path that says what he did spends the same
     promise. Never zero times — `_end_street` RESOLVES a pending press rather than
     discarding it, or hero's fold to a river bet is simply lost.

tests/fuzz_reconcile.py enforces all three over thousands of generated hands, with
the client's real artefacts switched on. Add a path that observes something over
time, and add it to the fuzzer in the same commit.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_BB = re.compile(r"^\s*([\d,]+(?:\.\d+)?)\s*BB\s*$", re.I)
_CALL = re.compile(r"^CALL\s+([\d.]+)\s*BB", re.I)
TOL = 0.06          # bb; the client rounds displayed amounts to one decimal
HOLD_TICKS = 2      # a fold signal must hold this many ticks (badges/cards flicker for one)
POT_HOLD = 4        # a pot/ledger mismatch must persist this many ticks (the pot lags the chips)
# A fault is LIVE while its condition keeps re-asserting, and for this many ticks after
# (~3 s at the feed's rate) — long enough that a real disagreement never looks resolved
# between two reads, short enough that a one-tick misread does not disable the relay for
# a whole street. See HandReconciler.faults().
FAULT_TTL = 8
FAULT_COALESCE = 3  # the same fault seen again within this many ticks refreshes it
# The one fault a later tick cannot repair: a seat acted that the derived line never
# accounted for, so every action after it is attributed to the wrong seat.
FAULT_STICKY = ("seat skipped while owing",)
STREETS = ("preflop", "flop", "turn", "river")


def bb(s) -> float | None:
    """'7.5 BB' -> 7.5; anything else (None, '$3.00', 'RAISE') -> None."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    m = _BB.match(str(s))
    return float(m.group(1).replace(",", "")) if m else None


@dataclass
class Tick:
    seq: int
    t: str = ""
    seats: dict = field(default_factory=dict)   # num -> {stack, bet, cards, hero, badge}
    pot: float | None = None                    # bb
    board: int = 0                              # cards on the board
    buttons: list = field(default_factory=list) # hero's action buttons, text
    hero: int | None = None


def street_of(board: int) -> int:
    return 0 if board < 3 else 1 if board == 3 else 2 if board == 4 else 3


def _buttons_up(buttons) -> bool:
    """Is the client asking hero to act? Real turn buttons, not a stale strip."""
    return (any(re.match(r"^(FOLD|CHECK|CALL|BET|RAISE)", b, re.I) for b in buttons)
            and any(re.search(r"\d", b) or b.upper() == "CHECK" for b in buttons))


def _swept(levels: dict[int, float], committed: dict[int, float]) -> bool:
    """Have the chips gone to the POT, or has one seat's slot just flickered?

    A SWEEP CLEARS THE WHOLE TABLE. One seat's chips-in-front falling is not a sweep,
    and reading it as one cost hand 4919236052 (dashboard #443) its entire line: the
    client renders the amount ADDED in the bet slot for a tick before the new total, so
    hero calling 14.4 from 9.2 showed "5.2" — a drop — while the other seats still had
    their chips in front. That was read as the street ending, which settled hero's
    pending press as a FOLD (he owed 5.2 and his buttons were gone), and `ended` then
    stopped the reader for the rest of a hand he played to showdown. No invariant was
    broken, so nothing downstream distrusted the line either.

    The same flicker is why a RISING level is already coalesced into one action (see the
    "still animating up" branch). This is the falling half of the same client behaviour.
    """
    return all(levels.get(n, 0.0) <= TOL for n, c in committed.items() if c > TOL)


class HandReconciler:
    def __init__(self, hand_no: int):
        self.hand_no = hand_no
        self.journal: list[dict] = []       # every derived action, retracted ones flagged
        self.violations: list[dict] = []
        self.armed = False                  # the table has cleared the previous hand
        self.board_reset = False            # a board of 0 has been seen this hand
        self.street = 0
        self.C: dict[int, float] = {}       # chips in front this street
        self.done: list[dict] = []          # committed per finished street
        self.max_bet = 0.0
        self.live: set[int] = set()
        # Nothing behind: these seats cannot act again for the REST OF THE HAND, so
        # unlike `acted` this is never cleared at a street boundary. Without it the
        # reader keeps offering an all-in seat turns it cannot take — hand 4919482454
        # had seat 5 "check" and then "fold" the river on a stack of zero, and the pot
        # itself read as a 204bb bet from a hero with 7.3 behind.
        self.allin: set[int] = set()
        # consecutive ticks this seat has shown a readable zero behind (see _jammed)
        self.jam_hold: dict[int, int] = {}
        self.dealt: set[int] = set()
        self.sb: int | None = None
        self.bbs: int | None = None
        self.hero: int | None = None
        self.acted: set[int] = set()        # acted since the last raise, this street
        self.fold_hold: dict[int, int] = {}
        self.card_hold: dict[int, int] = {}
        # the street each hold STARTED on — a fold seen on one street and confirmed on
        # the next belongs to the first (see the fold block)
        self.hold_street: dict[int, int] = {}
        self.pot_bad = 0
        self.undealt_hold: dict[int, int] = {}   # ticks a seat has shown chips with no cards
        self.prev: Tick | None = None
        self.hero_on_clock = False
        self.hero_gone_at: int | None = None   # hero's buttons vanished: the press shows in the chips a tick later
        self.hero_folded = False
        self.aggressor: int | None = None      # last bettor/raiser this street: action continues after them
        self._cards_now: dict[int, int] = {}
        self.sweep_at: int | None = None       # chips pulled into the pot: a street change (board follows) or the end
        self.street_armed = True               # the new street's chips have cleared (a dealt board shows the old chips for a tick)
        self.last_pot: float | None = None     # the pot vanishes the tick it is awarded; the award is judged against this
        self._badge_now: dict[int, str] = {}
        self.ended = False
        # every time a conclusion about this hand was taken back (see _revive) — the
        # shadow record carries them, so a reader that keeps changing its mind is visible
        self.revivals: list[dict] = []

    # ---- journal helpers ----
    def _add(self, seat: int, kind: str, amount: float | None, seq: int, conf: float, via: str,
             note: str | None = None, street: int | None = None) -> dict:
        """`street` overrides the street this lands on — for a HELD signal that began on
        an earlier one. See the fold block: a signal is stamped with the street it was
        SEEN on, never the street it happened to be confirmed on."""
        a = {"seat": seat, "type": kind, "amount": amount,
             "street": STREETS[self.street if street is None else street], "seq": seq,
             "conf": conf, "via": via, "retracted": None}
        if note:
            a["note"] = note
        # AN ACTION BY A SEAT WITH NOTHING BEHIND IS IMPOSSIBLE, so if one is ever
        # filed, say so rather than let a plausible-looking line carry it downstream
        # (2026-09-20). The seat is added to `allin` only AFTER its own jam is filed,
        # so this can never fire on the jam itself — only on something that follows
        # it, which is exactly the class this cannot otherwise detect. It reports and
        # does NOT drop the action: a wrong all-in that silently swallowed real
        # actions would be worse than one that is loud about disagreeing with itself.
        if seat in self.allin:
            self._violate(seq, "action by an all-in seat", seat=seat, kind=kind,
                          amount=amount, via=via)
        self.journal.append(a)
        # HERO'S PENDING PRESS IS SPENT THE MOMENT ANY ACTION IS RECORDED FOR HIM
        # (2026-09-19, found by tests/fuzz_reconcile.py). `hero_gone_at` is a promise that
        # his vanished buttons will show up in the chips shortly; every path that records
        # what he did has to redeem it, not just the one that set it. It was cleared only
        # by the buttons path itself, so this happened inside ONE tick: _implied_checks
        # recorded hero's check, the raise that triggered it reset `acted`, and the buttons
        # timer — finding hero no longer in `acted` and now owing — resolved the same press
        # a second time as a FOLD. Hero folded a hand he had checked, dated before the
        # villains who really did fold. Same family as the street-straddling press of hand
        # 4919211085: a held signal redeemed twice.
        if seat == self.hero:
            self.hero_gone_at = None
        return a

    def _violate(self, seq: int, what: str, **kw) -> None:
        """Record a broken invariant. A condition that is STILL true on the next tick
        refreshes the existing entry instead of appending a new one, so `seq` always
        means "last seen true" — which is what faults() reads to tell a fault that is
        still happening from one that has passed."""
        street = STREETS[self.street]
        last = next((v for v in reversed(self.violations)
                     if v["what"] == what and v["street"] == street), None)
        if last is not None and 0 <= seq - last["seq"] <= FAULT_COALESCE:
            last.update(kw)
            last["seq"] = seq
            last["n"] = last.get("n", 1) + 1
            return
        self.violations.append({"seq": seq, "street": street, "what": what, "n": 1, **kw})

    def faults(self, street: str | None = None) -> list[dict]:
        """The violations that are TRUE NOW — what a caller should hold a decision on.

        `violations` is an append-only audit log: everything ever seen, kept for the
        replays. Holding auto-execute on that log means one flickering tick disables
        the relay for a whole street with no way back (hand 4919212164, 2026-09-19:
        one tick of the previous hand's chips in an empty seat → the Q9o preflop pick
        was never executed and hero acted by hand). A fault counts as live while the
        condition keeps re-asserting itself (every tick's check refreshes its `seq`),
        and for FAULT_TTL ticks after it stops. The exception is a MISSED ACTION: the
        derived line is wrong from that point on and no later tick repairs it."""
        street = street or STREETS[self.street]
        now = self.prev.seq if self.prev else 0
        return [v for v in self.violations
                if v["street"] == street
                and (v["what"] in FAULT_STICKY or now - v["seq"] <= FAULT_TTL)]

    def _retract(self, seat: int, kind: str, seq: int, why: str) -> bool:
        for a in reversed(self.journal):
            if a["seat"] == seat and a["type"] == kind and not a["retracted"]:
                a["retracted"] = {"seq": seq, "why": why}
                return True
        return False

    def line(self) -> list[dict]:
        return [a for a in self.journal if not a["retracted"]]

    # ---- order ----
    def _ring(self) -> list[int]:
        return sorted(self.dealt | ({self.sb, self.bbs} - {None}))

    def _order(self) -> list[int]:
        """Seats in action order for the current street. Preflop: after the big
        blind. Postflop: from the small blind. Unknown blinds: no order (and no
        order-based inference)."""
        ring = self._ring()
        if not ring or self.bbs is None:
            return []
        if self.street == 0 or self.sb is None or self.sb not in ring or len(ring) == 2:
            anchor = self.bbs                           # heads-up: the small blind is the dealer, big blind acts first postflop
            if anchor not in ring:
                return []
            i = ring.index(anchor)
            return ring[i + 1:] + ring[:i + 1]      # after the big blind
        i = ring.index(self.sb)
        return ring[i:] + ring[:i]                  # from the small blind

    def _confirm_jam(self, num: int) -> None:
        """The zero behind has held: relabel this seat's wager on THIS street as all-in."""
        for a in reversed(self.journal):
            if a["seat"] != num or a["retracted"]:
                continue
            if a["street"] != STREETS[self.street]:
                break                      # nothing of this seat's on this street
            if a["type"] in ("bet", "raise"):
                a["type"] = "all-in"
                self.allin.add(num)
            elif a["type"] == "all-in":
                self.allin.add(num)
            elif a["type"] == "call":
                self.allin.add(num)        # called off the last of it; still cannot act again
            break

    def _jammed(self, tk: Tick, num: int) -> bool:
        """Has this seat put its last chip in? A READABLE zero behind, nothing else.

        Not the ALL-IN badge: badges arrive late, clear early and flicker, which is
        why folds are never judged by them either. A badge is fine corroboration and
        a poor trigger. And an unreadable stack is NOT a zero — a dropped read must
        never invent a jam, because a wrong all-in freezes a seat out of the rest of
        the hand, which is far worse than missing one.
        """
        return self.jam_hold.get(num, 0) >= HOLD_TICKS

    def _implied_checks(self, actor: int, seq: int) -> None:
        """A later seat acted: every live seat before it in order with no
        action since the last raise, owing nothing, checked (postflop). Preflop
        every seat owes, so a skipped seat is a missed observation, not a check."""
        order = self._order()
        if actor not in order:
            return
        if self.aggressor in order and self.aggressor != actor:
            i = order.index(self.aggressor)
            order = order[i + 1:] + order[:i + 1]     # action continues after the raiser
        for s in order:
            if s == actor:
                break
            if s in self.allin:
                continue                 # nothing behind: this seat has no turn to skip
            if s in self.live and s not in self.acted:
                owed = self.max_bet - self.C.get(s, 0.0)
                if owed <= TOL:
                    self._add(s, "check", None, seq, 0.8, "order")   # incl. the big blind's option
                    self.acted.add(s)
                elif self._cards_now.get(s, 1) == 0 or self._badge_now.get(s) == "FOLD":
                    # the order says it acted, its empty seat / FOLD label says how — no need to wait for the hold
                    self._add(s, "fold", None, seq, 0.85, "order+cards" if self._cards_now.get(s, 1) == 0 else "order+badge")
                    self.live.discard(s); self.acted.add(s)
                    if s == self.hero:
                        self.hero_folded = True; self.hero_gone_at = None
                elif s == self.hero:
                    # hero's cards stay on screen after a fold, and a PRE-SELECTED fold (the client's
                    # "next turn" checkbox) never shows buttons: a later seat acting while hero owes is hero's fold
                    self._add(s, "fold", None, seq, 0.8 if self.hero_gone_at is not None else 0.7,
                              "buttons+order" if self.hero_gone_at is not None else "order", note=None if self.hero_gone_at is not None else "pre-selected or unseen fold")
                    self.live.discard(s); self.acted.add(s); self.hero_folded = True; self.hero_gone_at = None
                else:
                    self._violate(seq, "seat skipped while owing", seat=s, owed=round(owed, 2), actor=actor)

    def _end_street(self, seq: int) -> None:
        """Nothing owed and live seats unacted: they checked around."""
        if self.max_bet - max((self.C.get(s, 0.0) for s in self.live), default=0.0) <= TOL:
            for s in self._order():
                if s in self.allin:
                    continue             # an all-in seat did not check, it simply cannot act
                if s in self.live and s not in self.acted and self.max_bet - self.C.get(s, 0.0) <= TOL:
                    self._add(s, "check", None, seq, 0.7, "street-end")
        # THE PENDING PRESS IS RESOLVED BY THE STREET ENDING, NEVER CARRIED PAST IT
        # (hand 4919211085, 2026-09-19). Hero's buttons vanish, the 3-tick wait for his
        # chips is still running, and the board arrives first. Left armed, the timer
        # redeemed that press a SECOND time against the NEW street — a phantom "hero
        # checks" as the flop's first action, before the small blind; the walker is
        # positional, so hero's real flop node read as the third seat's and every probe
        # failed "line ends on villain's turn" (13 of them, one hand).
        #
        # But DISCARDING it is not the answer either (found by tests/fuzz_reconcile.py):
        # when hero folds to a bet, that press is the only evidence there is. Dropped, he
        # stayed live for the rest of the hand and was folded at the pot award instead —
        # his turn fold filed on the river, one street late, which is the same damage from
        # the other direction. If he owes, the press was a fold, and it belongs here. If he
        # owes nothing it was a check, and the street-end loop above has already added it.
        if (self.hero_gone_at is not None and self.hero is not None
                and self.hero in self.live and self.hero not in self.acted
                and self.max_bet - self.C.get(self.hero, 0.0) > TOL):
            self._add(self.hero, "fold", None, seq, 0.75, "buttons+street-end")
            self.live.discard(self.hero)
            self.acted.add(self.hero)
            self.hero_folded = True
        self.done.append(dict(self.C))
        self.C = {}
        self.max_bet = 0.0
        self.acted = set()
        self.aggressor = None
        self.hero_gone_at = None

    # ---- the tick ----
    def _revive(self, tk: Tick, why: str) -> None:
        """The hand is still in front of us, so whatever ended it was wrong.

        NO CONCLUSION ABOUT A LIVE HAND IS FINAL (2026-09-19, Brady). Six places used to
        set `ended` and nothing ever cleared it, so `observe` returned immediately for the
        rest of the hand — one bad tick and the reader was blind until the next deal. That
        is how hand 4919236052 lost four streets to a single flickering bet slot.

        Reviving is cheap and the evidence is unambiguous: the client is asking hero to
        act, or the board has grown. Neither can happen in a hand that is over. A fold
        this reader INFERRED for hero is retracted at the same time — the buttons are the
        strongest turn signal there is, and a seat being asked to act has not folded.
        """
        self.ended = False
        self.sweep_at = None
        # RE-BASELINE THE LEDGER. Ending the hand wrongly usually meant settling a street
        # that was not over, so `done` and `C` now describe money that never moved. Carried
        # forward, every later tick reports "pot disagrees with the ledger" — a fault that
        # holds auto-execute for a disagreement the reader caused itself. A revival is an
        # admission that the bookkeeping was wrong, so the bookkeeping is re-anchored to
        # what the table shows right now: chips in front as they stand, and one synthetic
        # bucket for everything already in the pot. `done` is only ever summed.
        levels = {n: (bb(s.get("bet")) or 0.0) for n, s in tk.seats.items()}
        self.C = {n: v for n, v in levels.items() if v > TOL}
        self.max_bet = max(self.C.values(), default=0.0)
        pot_now = tk.pot if tk.pot is not None else self.last_pot
        if pot_now is not None:
            self.done = [{0: max(0.0, pot_now - sum(self.C.values()))}]
        self.pot_bad = 0
        if self.hero_folded and self.hero is not None:
            if self._retract(self.hero, "fold", tk.seq, f"hero is still in the hand — {why}"):
                self.live.add(self.hero)
                self.acted.discard(self.hero)
            self.hero_folded = False
            self.hero_gone_at = None
        self.revivals.append({"seq": tk.seq, "why": why})

    def _tally(self, tk: Tick) -> None:
        """Advance the per-seat observation counters. EVERY TICK, BEFORE ANY DECISION.

        These are bookkeeping over what is on screen — how many ticks a seat has shown no
        cards, how many it has shown a FOLD badge, and which street its fold evidence first
        appeared on. They are not judgements and they must never be skipped.

        They used to live at the BOTTOM of observe(), below every early return: the arming
        gate, the street-armed gate, the `ended` guard, and the sweep branch that returns
        when one player is left. Those exits fire on exactly the ticks that matter most —
        street boundaries and pot awards — so a seat folding in one of those windows had
        its counter frozen and its fold detected two ticks later, on the NEXT street.

        Hand 4919261748 (dashboard #489) is the shape: the big blind's cards went at seq
        2984 on preflop, the fold was filed on the flop, an "F" for a seat not in the flop
        tree went into the tokens, and every postflop decision in the hand died on `"Fold"
        not walkable at FLOP#1`. Hand 12 of session 204555 is the same thing one street
        over: seat 3's cards went at seq 992 (turn), the sweep branch declared the hand
        ended and returned, the `ended` guard returned again at 993, _revive brought the
        hand back at 994 — and the counter started there, on the river. Measured over the
        recordings, actions filed on a street where the table had already shown that seat
        out: 20 hands before, and the street-stamp fix alone only took it to 14.
        """
        for num, s in tk.seats.items():
            cards = s.get("cards") or 0
            badge = (s.get("badge") or "").upper()
            had = bool(self.card_hold.get(num, 0) or self.fold_hold.get(num, 0))
            self.card_hold[num] = self.card_hold.get(num, 0) + 1 if (cards == 0 and num in self.dealt) else 0
            self.fold_hold[num] = self.fold_hold.get(num, 0) + 1 if badge == "FOLD" else 0
            # A ZERO STACK MUST HOLD, LIKE EVERY OTHER SIGNAL HERE (2026-09-20). Chips
            # animate: a stack can read 0 for a tick while a raise is still climbing and
            # then settle with money behind. Session 115240 hand 37 is that — seat 4's
            # stack blinked to 0 at a raise of 14.0 and he raised again to 15.2 two ticks
            # later, which an all-in seat cannot do. Typed off one frame it froze him out
            # of his own hand; held for HOLD_TICKS it is the fact it looks like.
            st_bb = bb(s.get("stack"))
            self.jam_hold[num] = (self.jam_hold.get(num, 0) + 1) if (st_bb is not None and st_bb <= TOL) else 0
            # NOT RELEASED ONCE SET, and that is a decision rather than an oversight.
            # A seat freed from `allin` has its cards read again, and at showdown those
            # cards clear exactly like a folder's — so releasing on a stack that climbs
            # back reinstates the phantom folds this set removes (measured on the 313
            # recordings: post-all-in actions 1 -> 8). Every refill in that corpus is the
            # pot being pushed to the winner, which is not news about who can act, and a
            # spurious zero long enough to confirm (HOLD_TICKS) appears nowhere in it.
            # If one ever does, the evidence to tell it from a pot award is what this
            # would need, and guessing between them is worse than the latch.
            # CONFIRMED LATE, because the wager is typed on the tick the chips land and
            # the hold is only one tick old by then. The zero goes on holding while the
            # seat sits there all-in, so the moment it completes, the wager already filed
            # is relabelled. Without this the hold silently rejected every real jam
            # (session 193322 hand 36, 131406 hand 60) instead of only the flickers.
            if self.jam_hold[num] == HOLD_TICKS:
                self._confirm_jam(num)
            now = bool(self.card_hold[num] or self.fold_hold[num])
            # the street this seat's fold evidence FIRST appeared on. Keyed to the seat, not
            # to the signal: cards-gone and the FOLD badge arrive a tick apart, and
            # re-stamping on the second one puts the street back to the one being avoided.
            if now and not had:
                # WHICH STREET IS THIS, REALLY. Not `street_of(tk.board)`: when the chips
                # are swept AFTER the board grows, the board runs ahead of the street the
                # action belongs to, and a fold on the last tick of the turn gets dated to
                # the river. `street_armed` is the honest marker — it is False from the
                # deal until the previous street's chips have cleared, which is precisely
                # the window where the board lies. Found by tests/fuzz_reconcile.py, and
                # only ever with fold_at_boundary AND sweep_late together: neither alone
                # produces it, which is why no recording had shown it.
                self.hold_street[num] = self.street if self.street_armed else max(0, self.street - 1)
            elif not now:
                self.hold_street.pop(num, None)

    def observe(self, tk: Tick) -> None:
        self._tally(tk)
        if self.ended:
            # the only two things that cannot happen in a hand that is over
            if _buttons_up(tk.buttons):
                self._revive(tk, "hero's turn buttons came back up")
            elif self.board_reset and street_of(tk.board) > self.street:
                self._revive(tk, f"the board grew to {tk.board} cards")
            else:
                return
        if tk.hero is not None:
            self.hero = tk.hero
        levels = {n: (bb(s.get("bet")) or 0.0) for n, s in tk.seats.items()}
        if not self.armed:
            # the previous hand's chips/pot are still on the table until it clears
            clear = all(v <= TOL for v in levels.values())
            blinds_only = tk.pot is not None and tk.pot <= 1.5 + TOL and all(v <= 1.0 + TOL for v in levels.values())
            if not (clear or blinds_only):
                self.prev = tk
                return
            self.armed = True
        if tk.board == 0:
            self.board_reset = True
        board = tk.board if self.board_reset else 0      # a stale board from the last hand
        for num, s in tk.seats.items():
            if s.get("hero") and self.hero is None:
                self.hero = num
            if (s.get("cards") or 0) >= 1:
                self.dealt.add(num)
                if num not in self.live and not any(a["seat"] == num and a["type"] == "fold" and not a["retracted"] for a in self.journal):
                    self.live.add(num)
        self._cards_now = {n: (s.get("cards") or 0) for n, s in tk.seats.items()}
        self._badge_now = {n: (s.get("badge") or "").upper() for n, s in tk.seats.items()}
        st = street_of(board)
        if st > self.street:
            if self.sweep_at is None:
                self._end_street(tk.seq)
                self.street_armed = False     # the old chips are still on screen this tick
            self.sweep_at = None
            self.street = st
        if not self.street_armed:
            if all(v <= TOL for v in levels.values()):
                self.street_armed = True
            else:
                self.prev = tk
                return
        elif self.sweep_at is not None and tk.seq - self.sweep_at >= 8:
            self.ended = True                 # swept and no new street: the pot was awarded
            return
        # levels, in action order (unordered seats after)
        order = self._order()
        seq_seats = order + [n for n in sorted(tk.seats) if n not in order]
        if self.bbs is None:
            seq_seats = sorted(seq_seats, key=lambda n: levels.get(n, 0.0))   # the small blind posts first
        anyone_dealt = any((s.get("cards") or 0) >= 1 for s in tk.seats.values())
        for num in seq_seats:
            if num not in tk.seats:
                continue
            level = levels.get(num, 0.0)
            have = self.C.get(num, 0.0)
            undealt_now = (level > have + TOL and num not in self.dealt and anyone_dealt
                           and (tk.seats[num].get("cards") or 0) == 0)
            if not undealt_now:
                self.undealt_hold.pop(num, None)
            if undealt_now:
                # chips "appearing" in front of a seat that was never dealt while the
                # hand is under way: a misread (a sitter's stack drifting into the bet
                # slot for a tick — session 100647 hand 11: seat 2, 53.7), never an
                # action. Ignored from the FIRST tick; REPORTED only once it holds, like
                # every other flicker-prone signal here (2026-09-19). A new hand's opening
                # ticks routinely show the previous hand's chips in a seat whose cards have
                # not landed yet — one such tick used to mark the whole street uncertain and
                # hold auto-execute with no way back (hand 4919212164, the Q9o fold).
                self.undealt_hold[num] = self.undealt_hold.get(num, 0) + 1
                if self.undealt_hold[num] >= HOLD_TICKS:
                    self._violate(tk.seq, "chips from an undealt seat", seat=num, level=round(level, 2))
                continue
            if level > have + TOL:
                if self.sweep_at is not None:
                    self.ended = True                   # chips after a sweep with no new street: the pot moving to the winner
                    return
                able = [n for n in self.live if n not in self.allin]
                round_done = bool(self.live) and all(
                    n in self.acted and abs(self.C.get(n, 0.0) - self.max_bet) <= TOL for n in able)
                pot_ref = tk.pot if tk.pot is not None else self.last_pot
                # ONE PLAYER WITH CHIPS IS NOT A BETTING ROUND. Betting needs two seats
                # able to act; with the rest all-in the remaining streets are dealt out
                # and the only chips that move are the pot's. Without `len(able) <= 1`
                # hand 4919482454's river read the 204bb pot sliding to the winner as a
                # 204bb BET by a hero who had 7.3 behind.
                if self.bbs is not None and self.dealt and (round_done or len(self.live) <= 1 or len(able) <= 1) and pot_ref is not None and pot_ref >= 1.5 and level >= 0.6 * pot_ref and level > self.max_bet + TOL:
                    self._settle_pending(tk.seq)       # the pot moving to the winner: the hand is over
                    self.ended = True
                    return
                if num not in self.live and num in self.dealt and self._retract(num, "fold", tk.seq, "chips added after the fold"):
                    self.live.add(num)
                    self._violate(tk.seq, "fold retracted: seat added chips", seat=num)
                    self.hero_folded = False if num == self.hero else self.hero_folded
                if self.street == 0 and self.sb is None and self.bbs is None and level < 1.0 - TOL:
                    self.sb = num
                    self._add(num, "post-sb", round(level, 2), tk.seq, 0.95, "level")
                elif self.street == 0 and self.bbs is None and abs(level - 1.0) <= TOL and self.max_bet <= 1.0 + TOL:
                    self.bbs = num
                    self._add(num, "post-bb", 1.0, tk.seq, 0.95, "level")
                else:
                    last = self.journal[-1] if self.journal else None
                    if last and last["seat"] == num and last["type"] in ("bet", "raise", "call", "all-in") and not last["retracted"] \
                            and last["street"] == STREETS[self.street] and tk.seq - last["seq"] <= 3:
                        # the same seat's chips still animating up: one action, the final level
                        if last["type"] == "call" and level > self.max_bet + TOL:
                            last["type"] = "raise"; last["amount"] = round(level, 2); self.aggressor = num; self.acted = {num}
                        elif last["type"] == "call":
                            last["amount"] = round((last["amount"] or 0.0) + (level - have), 2)
                        else:
                            last["amount"] = round(level, 2)
                        # the chips were still climbing when this was first filed; if they
                        # have now emptied the stack it was a jam all along
                        if last["type"] in ("bet", "raise") and self._jammed(tk, num):
                            last["type"] = "all-in"
                        if last["type"] == "all-in":
                            self.allin.add(num)
                        last["seq"] = tk.seq
                        self.C[num] = level
                        self.max_bet = max(self.max_bet, level)
                        continue
                    self._implied_checks(num, tk.seq)
                    if level > self.max_bet + TOL:
                        # A JAM IS NOT A BET (2026-09-20). The tree's aggressive action at a
                        # low SPR is ALLIN, and only the token "RAI" reaches it — an R<bb>
                        # jam line walks into a node that does not exist. Hand 4919482454
                        # (dashboard 657): seat 5 had 69.4 behind and bet exactly 69.4, the
                        # client drew `bet 69.4 BB / stack 0 BB / badge ALL-IN`, this read it
                        # as a plain bet, and the turn came back
                        #   "Bet(6940)" not walkable at TURN#0 (offered: CHECK, ALLIN)
                        # three times over. The WS line had it right; the cut-over preferred
                        # this one.
                        #
                        # The STACK decides, not the badge: badges lag and flicker (the reader
                        # already refuses to judge folds by them), while a readable zero behind
                        # is the fact itself. Unreadable is NOT zero — treating a dropped stack
                        # read as a jam would invent all-ins out of noise.
                        kind = ("all-in" if self._jammed(tk, num)
                                else "raise" if self.max_bet > TOL else "bet")
                        self._add(num, kind, round(level, 2), tk.seq, 0.9, "level")
                        if kind == "all-in":
                            self.allin.add(num)
                        self.acted = {num}          # everyone else must act again
                        self.aggressor = num
                    else:
                        short = self.max_bet - level > TOL
                        if short:
                            # A CALL IS DRAWN AS THE CHIPS ADDED, NOT THE NEW TOTAL — and when
                            # the call CLOSES the street, the sweep lands before the total is
                            # ever drawn, so the single frame the reader gets reads BELOW
                            # max_bet. Preflop is where that bites, because the caller already
                            # has the blind out: hand 4919310706 (dashboard 501), the BB called
                            # to 2.5 holding 1, the slot showed 1.5 for one tick and swept, and
                            # the preflop ledger stayed 1 BB - exactly the blind - short for the
                            # whole hand. That failed the pot invariant on the turn and HELD
                            # auto-execute on a Bet 15.7 that had to be typed by hand.
                            #
                            # Settling below max_bet is only legal for a seat that is ALL IN.
                            # With chips behind it can only be an increment, and `have + level`
                            # landing exactly on max_bet is what makes reading it as one safe:
                            # a number that does not reconcile is left alone and still flagged.
                            behind = bb(tk.seats.get(num, {}).get("stack"))
                            implied = have + level
                            if (behind is None or behind > TOL) and abs(implied - self.max_bet) <= TOL:
                                level = implied
                                short = False
                        self._add(num, "call", round(level - have, 2), tk.seq, 0.9, "level",
                                  note="short (all-in)" if short else None)
                        # NOT `short` — that only means the level recorded sits below
                        # max_bet, which the big blind's post does, and which the
                        # increment display does whenever a call closes a street. It says
                        # nothing about chips behind. Marking on it put 45 seats in one
                        # session into `allin` holding 50bb (hand 22, seat 4: stack 50.8),
                        # froze them out of their own hands and then reported every later
                        # action as impossible. The stack is the only thing that means
                        # all-in, and _confirm_jam applies it a tick later once the zero
                        # has held — which is where an all-in CALL gets marked.
                        if self._jammed(tk, num):
                            self.allin.add(num)     # calling off the stack ends this seat too
                        self.acted.add(num)
                self.C[num] = level
                self.max_bet = max(self.max_bet, level)
            elif (level + TOL < have and st == self.street and self.sb is not None
                    and self.sweep_at is None and _swept(levels, self.C)):
                # chips pulled into the pot. Either the street is over (the board grows a
                # tick or two later) or the hand is (the pot is awarded). Settle the
                # street now; the board or the silence decides which it was.
                self._settle_pending(tk.seq)
                if len(self.live) <= 1:
                    self.ended = True                   # uncalled: the pot goes to the last player standing
                    return
                self._end_street(tk.seq)
                self.sweep_at = tk.seq
                break
        p = self.prev
        # folds: cards gone (held) or a FOLD badge (held); hero's fold from the buttons below
        self.max_live = max(getattr(self, "max_live", 0), len(self.live))
        others_hold_cards = any((s.get("cards") or 0) >= 1 for n, s in tk.seats.items() if n in self.live)
        if self.max_live >= 2 and not others_hold_cards and self.sb is not None:
            # every seat's cards are gone at once: the table clearing after the hand (never folds)
            self._settle_pending(tk.seq)
            self.ended = True
            return
        for num, s in tk.seats.items():
            cards = s.get("cards") or 0
            badge = (s.get("badge") or "").upper()
            # the counters advanced in _tally, at the top of the tick — see there
            if num == self.hero:
                continue
            if num in self.allin:
                # A SEAT WITH NOTHING BEHIND CANNOT FOLD (2026-09-20). Its cards clear at
                # showdown exactly like a folder's do, and the two are indistinguishable
                # from the seat alone — so the money decides. Session 131406 hand 38 and
                # hand 46 both file a preflop "fold" for a seat that was already all-in,
                # which puts an F in the tokens for a player who is still in the pot.
                continue
            if num in self.live:
                # A FOLD BELONGS TO THE STREET IT WAS SEEN ON (2026-09-19, hand 4919261748).
                # Cards take two ticks to count as gone, and that hold can straddle the deal:
                # the big blind's cards vanished at seq 2984 with the board still empty, and
                # the hold completed at 2985 with the flop already down. Stamped at
                # confirmation time, his PREFLOP fold landed on the FLOP — which put an "F"
                # in the flop tokens for a seat that was not even in the flop tree, so the
                # walk died on `"Fold" not walkable at FLOP#1 (offered: CHECK, BET)` and
                # every postflop decision in the hand went unanswered. It also handed hero a
                # phantom flop check, because a later seat "acting" implies the earlier ones
                # checked. Neither follows once the fold is filed where it happened: this
                # street's action order has nothing to say about an earlier street's fold.
                began = self.hold_street.get(num, self.street)
                late = began != self.street
                if self.card_hold[num] >= HOLD_TICKS:
                    if not late:
                        self._implied_checks(num, tk.seq)
                    self._add(num, "fold", None, tk.seq, 0.85, "cards", street=began)
                    self.live.discard(num); self.acted.add(num)
                elif self.fold_hold[num] >= HOLD_TICKS and cards >= 1:
                    if not late:
                        self._implied_checks(num, tk.seq)
                    self._add(num, "fold", None, tk.seq, 0.5, "badge",
                              note="cards still showing", street=began)
                    self.live.discard(num); self.acted.add(num)
            elif num in self.dealt and cards >= 1 and p is not None and (p.seats.get(num, {}).get("cards") or 0) == 0:
                last = next((a for a in reversed(self.journal) if a["seat"] == num and a["type"] == "fold" and not a["retracted"]), None)
                if last and last["via"] == "badge" and self._retract(num, "fold", tk.seq, "cards came back"):
                    self.live.add(num)
        # hero's buttons: the client says whose clock it is and what is owed
        on = _buttons_up(tk.buttons)
        if self.hero is not None and self.hero in self.live:
            owed = self.max_bet - self.C.get(self.hero, 0.0)
            if on:
                for b in tk.buttons:
                    m = _CALL.match(b)
                    if m and abs(float(m.group(1)) - owed) > TOL:
                        self._violate(tk.seq, "CALL amount disagrees with the ledger", call=float(m.group(1)), ledger_owed=round(owed, 2), max_bet=self.max_bet, hero_in_front=self.C.get(self.hero, 0.0))
                        break
                    if b.upper() == "CHECK" and owed > TOL:
                        self._violate(tk.seq, "CHECK offered while the ledger says hero owes", ledger_owed=round(owed, 2))
                        break
                if not self.hero_on_clock:
                    self._implied_checks(self.hero, tk.seq)
            elif self.hero_on_clock:
                self.hero_gone_at = tk.seq            # the press lands in the chips a tick or two later
            if self.hero_gone_at is not None and not on:
                if self.hero in self.acted:
                    self.hero_gone_at = None          # the chips recorded it (call / raise)
                elif tk.seq - self.hero_gone_at >= 3:
                    # three ticks with no chips: owed nothing -> check; owed -> fold
                    if owed <= TOL:
                        self._add(self.hero, "check", None, tk.seq, 0.75, "buttons")
                        self.acted.add(self.hero)
                    else:
                        self._add(self.hero, "fold", None, tk.seq, 0.8, "buttons")
                        self.live.discard(self.hero); self.acted.add(self.hero)
                        self.hero_folded = True
                    self.hero_gone_at = None
        self.hero_on_clock = on
        # invariant: pot == Σ committed (held: the pot lags the chips by a tick or two)
        if tk.pot and self.bbs is not None and self.sweep_at is None:
            total = sum(sum(d.values()) for d in self.done) + sum(self.C.values())
            low = total * (0.94 if self.street > 0 else 1.0) - TOL      # rake comes off the displayed pot from the flop on
            if tk.pot > total + TOL or tk.pot < low:
                self.pot_bad += 1
                # RE-ASSERTED every tick it is still wrong (2026-09-19), not once: faults()
                # reads `seq` as "last seen true", and a fault that stops refreshing is one
                # that has passed. Coalescing in _violate keeps it to one journal entry.
                if self.pot_bad >= POT_HOLD:
                    self._violate(tk.seq, "pot disagrees with the ledger", pot=tk.pot, ledger=round(total, 2))
            else:
                self.pot_bad = 0
        if tk.pot:
            self.last_pot = tk.pot
        self.prev = tk

    def _settle_pending(self, seq: int) -> None:
        """The hand is ending: a fold the two-tick hold had not confirmed, hero's
        pending press, and every live seat still owing after an uncalled bet all
        resolve now — the pot being awarded is the client's word that they did."""
        if (self.hero_gone_at is not None and self.hero in self.live
                and self.hero not in self.acted and self.hero not in self.allin):
            # An all-in hero cannot check and cannot fold. Today every path that puts
            # him in `allin` also puts him in `acted`, so this guard never fires — it is
            # here so that stays true by statement rather than by coincidence.
            owed = self.max_bet - self.C.get(self.hero, 0.0)
            if owed <= TOL:
                self._add(self.hero, "check", None, seq, 0.7, "buttons+end")
            else:
                self._add(self.hero, "fold", None, seq, 0.75, "buttons+end")
                self.live.discard(self.hero); self.hero_folded = True
            self.acted.add(self.hero); self.hero_gone_at = None
        for s in list(self._order() or sorted(self.live)):
            if s in self.allin:
                continue                 # all-in for less: it is a showdown, not a fold
            if s in self.live and s != self.aggressor and self.max_bet - self.C.get(s, 0.0) > TOL:
                self._add(s, "fold", None, seq, 0.7, "end", note="owed at the pot award")
                self.live.discard(s); self.acted.add(s)

    def finish(self, seq: int) -> None:
        if not self.ended:
            self._settle_pending(seq)
            if self.sweep_at is None:
                self._end_street(seq)
        self.ended = True

    # ---- comparison with an archived line ----
    @staticmethod
    def normalize(actions: list[dict]) -> list[tuple]:
        out = []
        for a in actions:
            seat = a.get("seat", a.get("seatId"))
            amt = a.get("amount")
            out.append((a.get("street"), seat, a.get("type"), round(float(amt), 1) if amt is not None else None))
        return out

    def diff(self, archived: list[dict]) -> dict:
        """The archive stops at hero's fold (the wrapper ends the hand there), so
        the derived line is cut at the same point before comparing."""
        import difflib
        mine_full = self.line()
        theirs = self.normalize(archived)
        cut = next((i for i, a in enumerate(mine_full) if a["seat"] == self.hero and a["type"] == "fold"), None)
        mine = self.normalize(mine_full if cut is None else mine_full[:max(cut + 1, len(theirs))])
        sm = difflib.SequenceMatcher(a=theirs, b=mine, autojunk=False)
        missing, extra, changed = [], [], []
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                continue
            if tag == "replace":
                changed.append({"archive": theirs[i1:i2], "reconciled": mine[j1:j2]})
            elif tag == "delete":
                extra.extend(theirs[i1:i2])       # in the archive, not derived
            elif tag == "insert":
                missing.extend(mine[j1:j2])       # derived, not in the archive
        return {"agree": not (missing or extra or changed), "archive_only": extra, "reconciled_only": missing, "changed": changed,
                "archive": theirs, "reconciled": mine}
