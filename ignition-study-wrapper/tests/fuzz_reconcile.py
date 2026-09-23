"""Throw hands at the reader until it breaks.

    aof-model/.venv/Scripts/python.exe tests/fuzz_reconcile.py [N] [--artefacts a,b,c] [-v]

Random hands are rendered as tick streams by tests/fake_hand.py — with the artefacts a
real Ignition client produces — and the line `HandReconciler` derives is compared to the
line that was actually played. The recordings can only show what has already happened to
us; this shows what would.

Reported per artefact as well as overall, because that is the useful shape: a failure
rate that only moves when `increment_first` is on says where to look.
"""
from __future__ import annotations

import random
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from fake_hand import ALL_ARTEFACTS, Script, simulate  # noqa: E402
from reconcile import HandReconciler  # noqa: E402

TOL = 0.06


def _round(street, ring, live, committed, level, rng, actions, stacks) -> float:
    """One betting round, played until it CLOSES.

    A single pass over the seats is not a betting round: a raise puts everyone who has
    already acted back in. A generator that does one pass produces hands no table could
    deal, and the reader is then blamed for not reconstructing them.
    """
    acted: set[int] = set()
    aggressor = None
    i = 0
    guard = 0
    while guard < 60:
        guard += 1
        if len(live) < 2:
            return level
        seat = ring[i % len(ring)]
        i += 1
        if seat not in live:
            continue
        owed = round(level - committed.get(seat, 0.0), 2)
        if seat in acted and owed <= TOL:
            if all(s in acted and round(level - committed.get(s, 0.0), 2) <= TOL for s in live):
                return level
            continue
        roll = rng.random()
        if owed > TOL and roll < 0.45:
            actions.append((street, seat, "fold", None))
            live.remove(seat)
            acted.add(seat)
        elif owed > TOL and roll < 0.85:
            actions.append((street, seat, "call", level))
            committed[seat] = level
            acted.add(seat)
        elif owed <= TOL and roll < 0.55:
            actions.append((street, seat, "check", None))
            acted.add(seat)
        else:
            step = rng.choice([2.0, 2.5, 3.0]) if street == 0 else rng.choice([1.2, 2.5, 5.0])
            to = round((level * step) if street == 0 else (level + step), 2)
            headroom = min(stacks[s] for s in live)
            if to >= headroom:                       # keep it off the all-in path
                actions.append((street, seat, "call" if owed > TOL else "check",
                                level if owed > TOL else None))
                if owed > TOL:
                    committed[seat] = level
                acted.add(seat)
            else:
                actions.append((street, seat, "raise" if level > TOL else "bet", to))
                committed[seat] = to
                level = to
                aggressor = seat
                acted = {seat}
        if all(s in acted and round(level - committed.get(s, 0.0), 2) <= TOL for s in live):
            return level
    return level


def random_script(rng: random.Random) -> Script:
    """A hand the way a table actually deals one.

    THE RING IS NOT OPTIONAL. The reader works the acting order out from the blinds —
    preflop after the big blind, postflop from the small blind, clockwise by displayed
    seat number over the seats that were dealt (reconcile._order). A generator that deals
    in some other order is not a harder test, it is a wrong one: the reader attributes
    each action to whoever its ring says is acting, so every mismatch is the generator's.
    Getting this wrong was 45% "failures" on the first run, with no artefacts at all.
    """
    n = rng.choice([2, 3, 4, 5, 6])
    seats = sorted(rng.sample(range(1, 7), n))      # the ring, in displayed seat order
    stacks = {s: round(rng.choice([100.0, 100.0, 100.0, 57.3, 86.6, 175.5, 40.0]), 1) for s in seats}
    btn = rng.randrange(n)
    if n == 2:
        sb, bb = seats[btn], seats[(btn + 1) % 2]   # heads-up: the dealer IS the small blind
    else:
        sb, bb = seats[(btn + 1) % n], seats[(btn + 2) % n]
    i_bb = seats.index(bb)
    order = seats[i_bb + 1:] + seats[:i_bb + 1]     # preflop acts after the big blind
    hero = rng.choice(seats)

    actions: list[tuple] = []
    live = list(seats)
    committed = {sb: 0.5, bb: 1.0}
    _round(0, order, live, committed, 1.0, rng, actions, stacks)

    i_sb = seats.index(sb)
    ring = seats[i_sb:] + seats[:i_sb]              # postflop starts at the small blind
    for street in (1, 2, 3):
        if len(live) < 2:
            break
        _round(street, [s for s in ring if s in live], live, {}, 0.0, rng, actions, stacks)
    return Script(stacks, hero, sb, bb, order, actions)


def playable(script) -> bool:
    """Could a client actually deal this hand?

    The generator caps a raise at the SMALLEST live stack and never at the actor's
    own remaining, so it occasionally has a seat wager more than it holds — the rig
    then renders a negative stack ("-1.25 BB"), which no client has ever drawn.
    That never mattered while the reader had no notion of all-in; now that a zero
    behind is a signal, those hands ask it to interpret a number that cannot exist.

    Skipped rather than asserted on: a fuzzer that fails on hands the game cannot
    produce teaches nothing, and "don't test fiction" cost us a day already. Modelling
    all-ins properly in the generator is worth doing — it would give the ALLIN path
    real coverage — but it is a rewrite of _round, not a patch, and the reader's all-in
    handling is meanwhile covered by tests/test_allin.py and the 21 recorded hands.
    """
    spent: dict[int, float] = {}
    street_c: dict[int, dict[int, float]] = {}
    for street, seat, kind, amount in script.actions:
        if amount is None:
            continue
        cur = street_c.setdefault(street, {})
        cur[seat] = max(cur.get(seat, 0.0), float(amount)) if kind != "call" else float(amount)
    for per in street_c.values():
        for seat, v in per.items():
            spent[seat] = spent.get(seat, 0.0) + v
    return all(v <= script.stacks.get(seat, 0.0) + 0.01 for seat, v in spent.items())


def norm(entry) -> tuple:
    street, seat, kind, amount = entry
    return (street, seat, kind, None if amount is None else round(float(amount), 1))


def derived(ticks) -> list[tuple]:
    rc = HandReconciler(1)
    for tk in ticks:
        rc.observe(tk)
    rc.finish(ticks[-1].seq if ticks else 0)
    return [norm((a["street"], a["seat"], a["type"], a.get("amount"))) for a in rc.line()]


def first_divergence(want: list[tuple], got: list[tuple]) -> str:
    for i in range(max(len(want), len(got))):
        w = want[i] if i < len(want) else None
        g = got[i] if i < len(got) else None
        if w != g:
            return f"at #{i}: played {w}, read {g}"
    return "identical"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    n = int(args[0]) if args else 400
    only = None
    for a in sys.argv[1:]:
        if a.startswith("--artefacts"):
            only = tuple(x for x in a.split("=", 1)[1].split(",") if x)

    combos = [()] if only == () else None
    if only is not None:
        combos = [only]
    else:
        combos = [()] + [(a,) for a in ALL_ARTEFACTS] + [ALL_ARTEFACTS]

    grand_bad = 0
    for combo in combos:
        bad = 0
        skipped = 0
        why: Counter = Counter()
        examples: list[str] = []
        for i in range(n):
            rng = random.Random(i)
            script = random_script(rng)
            if not playable(script):
                skipped += 1
                continue
            ticks, want = simulate(script, artefacts=combo, seed=i)
            if not ticks:
                continue
            w = [norm(x) for x in want]
            g = derived(ticks)
            if w != g:
                bad += 1
                d = first_divergence(w, g)
                why[d.split(":")[0]] += 1
                if len(examples) < 3:
                    examples.append(f"      seed {i} ({len(script.stacks)} seats): {d}")
        grand_bad += bad
        label = "none" if not combo else ("ALL" if combo == ALL_ARTEFACTS else ",".join(combo))
        flag = "ok " if not bad else "BAD"
        print(f"  {flag} artefacts={label:<18} {n - bad - skipped}/{n - skipped} hands read exactly right"
              + (f"   ({100 * bad / max(1, n - skipped):.1f}% wrong)" if bad else "")
              + (f"   [{skipped} unplayable, skipped]" if skipped else ""))
        if bad and verbose:
            for e in examples:
                print(e)
    print()
    print("all clean" if not grand_bad else f"{grand_bad} mismatched hands across the combinations")
    return 1 if grand_bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
