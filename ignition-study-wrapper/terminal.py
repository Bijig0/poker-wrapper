"""THE TERMINAL-ACTION FAMILY — one named place for "after this press hero has no further
decision in this hand" (2026-09-23, Brady: top up before ANY terminal action, not only a fold).

Why a family and not a string test. The pre-fold top-up (launch._maybe_prefold_top_up) buys chips
while we still hold hero's clock, so the deadline is ours and not the dealer's. It qualified only a
plain FOLD because a fold is the one action after which hero's stack BEHIND is his final stack — the
amount is exact. But hero also has no further decision after a shove, after a call that puts him
all-in, after the river call or check that closes the action, and after a call when every opponent
is already all-in (the board just runs out). In all of those the clock is ours too; what differs is
only that hero may still WIN the pot, so a buy sized off stack-behind can land above the table max
and the client refuses it at the next hand with a notice over the action strip (session 100647
hands 4/5). That is an EXPECTED outcome the caller must handle, so the verdict says which case it is
(`final_stack_known`), never just yes/no.

Everything here is a pure function of the relay PLAN (launch._pick_plan's output) and the exported
ParsedHand (launch._hand_state, CONTRACT.md §1a) — no module state, no client, so it is unit-tested
over every plan shape the relay can send (tests/test_terminal.py) and usable from the replays.

CONSERVATIVE BY CONSTRUCTION. Taking hero's clock on a wrong "terminal" verdict costs a decision;
missing a terminal costs one top-up window. So every uncertainty (a stack we cannot read, an action
whose amount we did not catch, a seat we cannot place) resolves to NOT terminal — except a fold,
which is terminal whatever else we know.
"""
from __future__ import annotations

from dataclasses import dataclass, field

EPS_BB = 0.05

# The relay plan kinds launch._pick_plan can emit and what each one is for hero's future in the hand.
# `always` = terminal in every state; `conditional` = decided by is_terminal from the table; `never` =
# hero acts again (barring an all-in, which is decided from the amount and stacks, not the label).
TERMINAL_ACTIONS: dict[str, str] = {
    "fold": "always",
    "all-in": "always",
    "call": "conditional",     # closes the river / puts hero all-in / every opponent already all-in
    "check": "conditional",    # closes the river
    "raise-to": "conditional", # a raise-to that is hero's whole stack is a shove
    "raise": "never",          # a sized press with no size cannot be a shove we can prove
    "bet": "never",
}

# Actions the WRAPPER takes on its own that also end hero's part in the hand or the session. They are
# listed so the family is complete in one place; none of them wants chips bought first — a seat that
# is sitting out or leaving needs nothing, and the not-dealt window already covers a sitter.
WRAPPER_TERMINALS: dict[str, dict] = {
    "sit-out-next-hand": {"top_up_before": False, "source": "launch._ignition_sitout_next_hand (net guard)"},
    "leave-table":       {"top_up_before": False, "source": "formats.leave / launch._maybe_stand_down"},
}


@dataclass
class TerminalVerdict:
    terminal: bool
    kind: str                       # fold | shove | all-in-call | run-out | closing-river-call | closing-river-check | not-terminal | unknown
    why: str
    # True when hero's stack BEHIND is already his final stack (a fold): the top-up amount is exact.
    # False when hero can still win the pot: the buy may land above the max and be refused.
    final_stack_known: bool = False
    details: dict = field(default_factory=dict)

    def __bool__(self) -> bool:      # `if is_terminal(...)` reads naturally
        return self.terminal


def _num(x) -> float | None:
    try:
        return None if x is None else float(x)
    except (TypeError, ValueError):
        return None


def _seat(x) -> int | None:
    try:
        return None if x is None else int(x)
    except (TypeError, ValueError):
        return None


def street_actions(hand: dict) -> list[dict]:
    st = hand.get("street") or (hand.get("currentNode") or {}).get("street") or "preflop"
    return [a for a in (hand.get("actions") or []) if (a.get("street") or "preflop") == st]


def table_view(hand: dict) -> dict:
    """The seats as the terminal test needs them: dealt, folded, all-in, still able to act."""
    hero = _seat(hand.get("heroSeatId"))
    dealt = {s for s in (_seat(x) for x in (hand.get("liveSeats") or [])) if s is not None}
    acts = hand.get("actions") or []
    folded = {_seat(a.get("seatId")) for a in acts if a.get("type") == "fold"}
    allin = {_seat(a.get("seatId")) for a in acts if a.get("type") == "all-in"}
    stacks = {_seat(k): _num(v) for k, v in (hand.get("stacks") or {}).items()}
    for s, v in stacks.items():
        if s is not None and v is not None and v <= EPS_BB and s in dealt and s not in folded:
            allin.add(s)                    # the label shows an empty stack: that seat is all-in
    in_hand = {s for s in dealt if s not in folded}
    contestants = {s for s in in_hand if s != hero}
    with_chips = {s for s in contestants if s not in allin}
    return {"hero": hero, "dealt": dealt, "folded": folded, "allin": allin, "in_hand": in_hand,
            "contestants": contestants, "with_chips": with_chips, "stacks": stacks}


def still_to_act_after_hero(hand: dict, view: dict) -> set[int] | None:
    """Opponents with chips who must still act on THIS street once hero has acted now.

    After the last aggressive action every other live seat with chips owes one action; the seats that
    acted after it are done. With no aggression yet, every seat that has not acted this street is
    still to come. Returns None when an amount needed to place an action is missing — the caller must
    then treat the spot as not terminal."""
    acts = street_actions(hand)
    hero = view["hero"]
    # find the last aggressive action: bet / raise, or an all-in that RAISED (amount above the max so far)
    top = 0.0
    last_aggr_idx = None
    aggressor = None
    for i, a in enumerate(acts):
        t = a.get("type")
        amt = _num(a.get("amount"))
        if t in ("bet", "raise"):
            last_aggr_idx, aggressor = i, _seat(a.get("seatId"))
            if amt is None:
                # a raise we could not size: it still re-opens the action for everyone
                top = float("inf")
            else:
                top = max(top, amt)
        elif t == "all-in":
            if amt is None:
                return None            # cannot tell a jam from a call-all-in: refuse to reason
            if amt > top + EPS_BB:
                last_aggr_idx, aggressor, top = i, _seat(a.get("seatId")), amt
        elif t in ("post-sb", "post-bb") and amt is not None:
            top = max(top, amt)
    after = acts[(last_aggr_idx + 1):] if last_aggr_idx is not None else acts
    acted_after = {_seat(a.get("seatId")) for a in after}
    pending = {s for s in view["with_chips"] if s not in acted_after}
    if aggressor is not None:
        pending.discard(aggressor)
    pending.discard(hero)
    return pending


def seats_to_act(hand: dict) -> set[int] | None:
    """Every seat (hero included) that still owes an action on the CURRENT street.

    After the last aggressive action every other live seat with chips owes one; the seats that acted after
    it are done. With no aggression yet, every live seat with chips that has not acted this street owes one.
    None when an all-in this street could not be sized (the caller must then assume the action is open)."""
    view = table_view(hand)
    acts = street_actions(hand)
    live_with_chips = {s for s in view["in_hand"] if s not in view["allin"]}
    top = 0.0
    last_aggr_idx = None
    aggressor = None
    for i, a in enumerate(acts):
        t = a.get("type")
        amt = _num(a.get("amount"))
        if t in ("bet", "raise"):
            last_aggr_idx, aggressor = i, _seat(a.get("seatId"))
            top = float("inf") if amt is None else max(top, amt)
        elif t == "all-in":
            if amt is None:
                return None
            if amt > top + EPS_BB:
                last_aggr_idx, aggressor, top = i, _seat(a.get("seatId")), amt
        elif t in ("post-sb", "post-bb") and amt is not None:
            top = max(top, amt)
    after = acts[(last_aggr_idx + 1):] if last_aggr_idx is not None else acts
    acted_after = {_seat(a.get("seatId")) for a in after}
    pending = {s for s in live_with_chips if s not in acted_after}
    if aggressor is not None:
        pending.discard(aggressor)
    # preflop with no aggression yet, the big blind still holds the option even after "acting" by posting
    return pending


def hero_done(hand: dict | None) -> TerminalVerdict:
    """Is hero's part in this hand OVER although the hand is not — nothing left for him to decide?

    The SHOWDOWN-PENDING window (2026-09-23): a hero whose river bet was called, who called an all-in, or who
    is all-in himself has no decision left while the client runs out the board and shows the hands, which
    takes seconds — a window whose length the deal does not cut short the way the hand-over window's is
    (median 2.4 s from the client's end marker to the next deal). Hero can still WIN, so a buy here may be
    refused at the next hand (the handled refusal); it can never cost him a decision because he has none.
    Conservative like is_terminal: anything unreadable is NOT done."""
    if not hand:
        return TerminalVerdict(False, "unknown", "no hand state")
    view = table_view(hand)
    hero = view["hero"]
    if hero is None or hero not in view["in_hand"]:
        return TerminalVerdict(False, "unknown", "hero is not in the hand (folded or unknown)")
    if not view["contestants"]:
        return TerminalVerdict(False, "not-terminal", "no opponent left: the pot is hero's, the hand is over")
    if hero in view["allin"]:
        return TerminalVerdict(True, "hero-all-in", "hero is all-in; the board runs out", final_stack_known=False)
    if not view["with_chips"]:
        return TerminalVerdict(True, "run-out", "every opponent is all-in; the board runs out", final_stack_known=False)
    street = hand.get("street") or (hand.get("currentNode") or {}).get("street") or "preflop"
    if street != "river":
        return TerminalVerdict(False, "not-terminal", f"the {street} is not the last street; hero may act again", )
    pending = seats_to_act(hand)
    if pending is None:
        return TerminalVerdict(False, "not-terminal", "an all-in on the river could not be sized")
    if pending:
        return TerminalVerdict(False, "not-terminal", f"the river is still open: {sorted(pending)} to act", details={"pending": sorted(pending)})
    acts = street_actions(hand)
    if not acts:
        return TerminalVerdict(False, "not-terminal", "the river has not been acted on")
    return TerminalVerdict(True, "showdown-pending", "the river action is closed; the hands are being shown", final_stack_known=False)


def is_terminal(plan: dict | None, hand: dict | None) -> TerminalVerdict:
    """Does this relay plan end hero's decisions in this hand?  See the module docstring.

    `plan` is launch._pick_plan's output: {"kind": "action", "label": fold|check|call|all-in|raise|bet}
    or {"kind": "raise-to", "amount": "<bb>", "verb": raise|bet}.  `hand` is the exported ParsedHand."""
    if not plan:
        return TerminalVerdict(False, "unknown", "no plan")
    kind = str(plan.get("kind") or "action").lower()
    label = str(plan.get("label") or plan.get("action") or "").strip().lower()
    if kind == "action" and (label == "fold" or label.startswith("fold ")):
        # The one verdict that needs nothing from the table: folding forfeits what hero committed, so his
        # stack behind IS his final stack and the top-up amount is exact.
        return TerminalVerdict(True, "fold", "a fold ends hero's hand; stack behind is final", final_stack_known=True)
    if kind == "action" and label == "all-in":
        return TerminalVerdict(True, "shove", "hero is all-in; no further decision", final_stack_known=False)
    if not hand:
        return TerminalVerdict(False, "unknown", "no hand state")
    view = table_view(hand)
    hero = view["hero"]
    if hero is None:
        return TerminalVerdict(False, "unknown", "hero seat unknown")
    if not view["contestants"]:
        return TerminalVerdict(False, "unknown", "no opponent left in the hand — nothing to act on")
    street = hand.get("street") or (hand.get("currentNode") or {}).get("street") or "preflop"
    node = hand.get("currentNode") or {}
    to_call = _num(node.get("toCall")) or 0.0
    behind = view["stacks"].get(hero)
    committed = _num((hand.get("committed") or {}).get(str(hero))) or _num((hand.get("committed") or {}).get(hero)) or 0.0
    details = {"street": street, "toCall": to_call, "behind": behind, "committed": committed,
               "contestants": sorted(view["contestants"]), "withChips": sorted(view["with_chips"])}

    if kind == "raise-to":
        amount = _num(plan.get("amount"))
        if amount is None or behind is None:
            return TerminalVerdict(False, "not-terminal", "a sized raise; hero acts again unless it is a shove (size or stack unknown)", details=details)
        if amount >= committed + behind - EPS_BB:
            return TerminalVerdict(True, "shove", f"raise to {amount} is hero's whole stack ({committed} + {behind})", details=details)
        return TerminalVerdict(False, "not-terminal", "a raise leaves hero with chips and opponents to act", details=details)

    if kind != "action":
        return TerminalVerdict(False, "unknown", f"plan kind {kind!r} not understood", details=details)

    if label == "call":
        if behind is not None and to_call >= behind - EPS_BB and to_call > 0:
            return TerminalVerdict(True, "all-in-call", f"calling {to_call} puts hero's last {behind} in", details=details)
        if not view["with_chips"]:
            return TerminalVerdict(True, "run-out", "every opponent is already all-in; the board runs out", details=details)
        if street != "river":
            return TerminalVerdict(False, "not-terminal", f"a {street} call: hero acts again on the next street", details=details)
        pending = still_to_act_after_hero(hand, view)
        if pending is None:
            return TerminalVerdict(False, "not-terminal", "an all-in on this street could not be sized; not provably closing", details=details)
        if pending:
            return TerminalVerdict(False, "not-terminal", f"seats still to act after the call: {sorted(pending)}", details={**details, "pending": sorted(pending)})
        if to_call <= 0:
            return TerminalVerdict(False, "not-terminal", "nothing to call — this is a check", details=details)
        return TerminalVerdict(True, "closing-river-call", "the river call closes the action; showdown follows", details=details)

    if label == "check":
        if street != "river":
            return TerminalVerdict(False, "not-terminal", f"a {street} check: the hand goes on", details=details)
        if to_call > 0:
            return TerminalVerdict(False, "not-terminal", "hero owes chips — a check is not on offer", details=details)
        if not view["with_chips"]:
            return TerminalVerdict(True, "run-out", "every opponent is already all-in; the board runs out", details=details)
        pending = still_to_act_after_hero(hand, view)
        if pending is None:
            return TerminalVerdict(False, "not-terminal", "an action on this street could not be sized; not provably closing", details=details)
        if pending:
            return TerminalVerdict(False, "not-terminal", f"seats still to act after the check: {sorted(pending)}", details={**details, "pending": sorted(pending)})
        return TerminalVerdict(True, "closing-river-check", "the river check closes the action; showdown follows", details=details)

    if label in ("raise", "bet"):
        return TerminalVerdict(False, "not-terminal", "an unsized raise/bet cannot be proven a shove", details=details)
    return TerminalVerdict(False, "unknown", f"plan label {label!r} not understood", details=details)
