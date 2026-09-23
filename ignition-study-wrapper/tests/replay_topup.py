"""Would the top-up have fired at the end of every hand that finished short?

    aof-model/.venv/Scripts/python.exe tests/replay_topup.py [session ...]

Replays `_maybe_top_up`'s trigger over every recorded tick and reports, per hand that
ended below the table max, whether a window existed where it would have pressed.

The rule under test (2026-09-20) is three windows, widest first:

  not-dealt   hero is sitting out, waiting for the big blind, or was not dealt in at
              all. He cannot be put on the clock and cannot win a chip, so the whole
              hand is a window. The old rule asked for an end-of-hand marker, which a
              hand hero is not in never produces for him — so this window, the widest
              one there is, was never used.
  fold        hero's fold is confirmed. A folded hero's stack behind is already final.
  hand-over   the client says the hand is done AND hero's stack has stopped moving.

What it REPLACES is "the pot label has gone", which is a rendering detail: Ignition
often keeps the pot on screen until the next hand deals, so three of the four hands
hero played to the end and finished short in session 173224 could never trigger at all.

`handOver` is not in the recordings (it comes from a WS frame), so it is reconstructed
the way the client behaves: the hand is over once hero's last turn has passed and the
pot has been awarded — the tick where hero's stack makes its final move of the hand.
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tests"))
DEBUG = os.path.join(HERE, "debug")
SETTLE = 2          # launch.TOP_UP_SETTLE_TICKS
MAX_BB = 100.0      # the ring max we play
MIN_SHORT_BB = 1.0  # launch.TOP_UP_MIN_SHORT_BB — under this, leave the stack alone
OUT_OF_HAND = ("sitting-out", "waiting-for-bb", "not-in-hand")


def bb(s):
    if not s:
        return None
    try:
        return float(str(s).replace("BB", "").replace(",", "").strip())
    except ValueError:
        return None


def hands_of(session: str):
    path = os.path.join(DEBUG, session, "log.jsonl")
    out: dict[int, list] = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if isinstance(d.get("hand"), int):
            out.setdefault(d["hand"], []).append(d)
    return out


def hero_stack(d):
    for n, s in (d.get("seats") or {}).items():
        if s.get("hero"):
            return bb(s.get("stack"))
    return None


def windows(ticks: list, old_rule: bool) -> int:
    """Ticks at which the trigger would have fired."""
    fired = 0
    stable_text = None
    stable = 0
    # the hand is over for hero from his last turn onward (folded or not); before the
    # client's own end marker the wrapper would not even look, so this is generous to
    # BOTH rules equally and the comparison stays fair
    last_turn = max((i for i, d in enumerate(ticks) if d.get("toAct")), default=-1)
    for i, d in enumerate(ticks):
        # a hand hero is not in has no "last turn" to wait for — the not-dealt window
        # below is open from the first tick, which is the whole point of adding it
        if d.get("toAct") or (i <= last_turn and d.get("heroStatus") not in OUT_OF_HAND):
            continue
        st = hero_stack(d)
        text = None if st is None else f"{st}"
        if text == stable_text:
            stable += 1
        else:
            stable_text, stable = text, 1
        if st is None or st > MAX_BB - MIN_SHORT_BB:
            continue                       # not short enough to be worth a press
        folded = d.get("heroStatus") == "folded"
        if not old_rule and d.get("heroStatus") in OUT_OF_HAND:
            fired += 1                     # the not-dealt window: the whole hand is safe
            continue
        if old_rule:
            # the live code skips the pot/stability branch entirely for a folded hero —
            # his stack behind is already final, so there is nothing to wait for
            if not folded and (d.get("pot") is not None or stable < 4):
                continue
        elif not folded and stable < SETTLE:
            continue
        fired += 1
    return fired


def main() -> int:
    sessions = [a for a in sys.argv[1:] if a.startswith("session_")] or sorted(
        s for s in os.listdir(DEBUG) if s.startswith("session_")
        and os.path.exists(os.path.join(DEBUG, s, "log.jsonl")))
    short = old_ok = new_ok = 0
    rows = []
    by_fold = {"folded": [0, 0, 0], "played to the end": [0, 0, 0], "not dealt in": [0, 0, 0]}
    for sess in sessions:
        for h, ticks in sorted(hands_of(sess).items()):
            st = next((hero_stack(d) for d in reversed(ticks) if hero_stack(d) is not None), None)
            if st is None or st > MAX_BB - MIN_SHORT_BB:
                continue
            short += 1
            o, n = windows(ticks, True), windows(ticks, False)
            old_ok += 1 if o else 0
            new_ok += 1 if n else 0
            if any(d.get("heroStatus") in OUT_OF_HAND for d in ticks):
                key = "not dealt in"
            elif any(d.get("heroStatus") == "folded" for d in ticks):
                key = "folded"
            else:
                key = "played to the end"
            folded = key == "folded"
            by_fold.setdefault(key, [0, 0, 0])
            by_fold[key][0] += 1
            if o: by_fold[key][1] += 1
            if n: by_fold[key][2] += 1
            if not o and n:
                rows.append((sess, h, st, n, folded))
    print(f"hands that ended SHORT of {MAX_BB:.0f}bb: {short}")
    print(f"  the OLD rule (pot label gone + 4 stable ticks) had a window on : {old_ok}"
          f"  ({100 * old_ok / short:.0f}%)" if short else "")
    print(f"  the NEW rule (not-dealt / fold / hand over + {SETTLE} stable ticks) has a window on : {new_ok}"
          f"  ({100 * new_ok / short:.0f}%)" if short else "")
    print(f"\n  newly covered: {len(rows)} hands")
    for sess, h, st, n, folded in rows[:20]:
        print(f"    {sess} hand {h:>2}  ended {st:>6.1f}bb   {'folded' if folded else 'played to the end':<18} {n} tick(s) to press in")
    print("")
    print("  by how the hand ended for hero:")
    for k, (tot, o, n) in by_fold.items():
        if tot:
            print(f"    {k:<20} {tot:>3} short hands   old rule {o:>3} ({100*o/tot:.0f}%)   new rule {n:>3} ({100*n/tot:.0f}%)")
    preaction_score(sessions)
    return 0


def preaction_score(sessions: list[str]) -> None:
    """THE PRE-ACTION WINDOW (2026-09-23): for every short-ending hand hero played, was his LAST decision a
    TERMINAL one (terminal.is_terminal) with an answer on the panel — i.e. would the deterministic buy-before-
    the-action have had a window whose end WE control, instead of racing the next deal?

    The recording's tick carries the pick the panel showed (`liveAnswer`); the betting line comes from the
    archived hand (hand_ids.json -> hands.db) truncated at hero's last voluntary action. A short hand hero
    was not dealt into is left to the not-dealt window and not counted here."""
    import sqlite3
    from terminal import is_terminal  # noqa: E402
    import launch  # noqa: E402
    db = sqlite3.connect(f"file:{os.path.join(HERE, 'data', 'hands.db')}?mode=ro", uri=True)
    by_cid = {}
    for rowid, data in db.execute("SELECT rowid, data FROM hands"):
        d = json.loads(data)
        if d.get("clientHandId"):
            by_cid.setdefault(str(d["clientHandId"]), (rowid, d))
    short = terminal = answered = 0
    kinds: dict[str, int] = {}
    misses = []
    for sess in sessions:
        ids_path = os.path.join(DEBUG, sess, "hand_ids.json")
        hand_ids = json.load(open(ids_path, encoding="utf-8")) if os.path.exists(ids_path) else {}
        for h, ticks in sorted(hands_of(sess).items()):
            st = next((hero_stack(d) for d in reversed(ticks) if hero_stack(d) is not None), None)
            if st is None or st > MAX_BB - MIN_SHORT_BB:
                continue
            if any(d.get("heroStatus") in OUT_OF_HAND for d in ticks):
                continue          # the not-dealt window's hand
            turns = [d for d in ticks if d.get("toAct")]
            if not turns:
                continue
            short += 1
            last = turns[-1]
            cid = str(hand_ids.get(str(h)) or "")
            arch = by_cid.get(cid)
            pick = ((last.get("liveAnswer") or {}).get("pick") if isinstance(last.get("liveAnswer"), dict) else None)
            if not pick:
                misses.append((sess, h, "no answer on the panel at hero's last turn"))
                continue
            answered += 1
            if not arch:
                misses.append((sess, h, "no archived hand to read the line from"))
                continue
            rowid, d = arch
            idx = max((i for i, a in enumerate(d["actions"]) if a.get("hero") and a["type"] not in ("post-sb", "post-bb")), default=None)
            if idx is None:
                misses.append((sess, h, "archive has no hero action"))
                continue
            act = d["actions"][idx]
            trunc = {**d, "actions": d["actions"][:idx], "street": act.get("street"),
                     "board": d["board"][:{"preflop": 0, "flop": 3, "turn": 4, "river": 5}.get(act.get("street"), 0)],
                     "currentNode": {**d.get("currentNode", {}), "street": act.get("street"),
                                     "toCall": (d.get("currentNode") or {}).get("toCall", 0)}}
            plan = launch._pick_plan(pick, (d.get("currentNode") or {}).get("pot"))
            v = is_terminal(plan, trunc)
            if v.terminal:
                terminal += 1
                kinds[v.kind] = kinds.get(v.kind, 0) + 1
            else:
                misses.append((sess, h, f"last pick {pick!r} not terminal — {v.why}"))
    print("\n  PRE-ACTION window (buy before a TERMINAL pick, the end of the window is ours):")
    if short:
        print(f"    short hands hero played to a decision: {short}; answer on the panel at the last turn: {answered}; "
              f"last pick terminal: {terminal} ({100 * terminal / short:.0f}%) — {kinds}")
    for sess, h, why in misses[:12]:
        print(f"      {sess} hand {h:>2}: {why}")
    # THE SHOWDOWN-PENDING WINDOW (terminal.hero_done): hero's part is over (his river bet was called, an all-in
    # run-out) while the client still runs out the board — a window the deal does not cut short. Scored on the
    # archived FINAL line of each short hand hero played to the end: was hero done before the award?
    from terminal import hero_done  # noqa: E402
    done_n = 0
    done_kinds: dict[str, int] = {}
    covered = 0
    total_played = 0
    for sess in sessions:
        ids_path = os.path.join(DEBUG, sess, "hand_ids.json")
        hand_ids = json.load(open(ids_path, encoding="utf-8")) if os.path.exists(ids_path) else {}
        for h, ticks in sorted(hands_of(sess).items()):
            st = next((hero_stack(d) for d in reversed(ticks) if hero_stack(d) is not None), None)
            if st is None or st > MAX_BB - MIN_SHORT_BB:
                continue
            if any(d.get("heroStatus") in OUT_OF_HAND for d in ticks) or any(d.get("heroStatus") == "folded" for d in ticks):
                continue
            arch = by_cid.get(str(hand_ids.get(str(h)) or ""))
            if not arch:
                continue
            total_played += 1
            final = arch[1]
            # the hand as it stood when hero's LAST action landed (everything after it is villains closing / the award)
            last_hero = max((i for i, a in enumerate(final["actions"]) if a.get("hero") and a["type"] not in ("post-sb", "post-bb")), default=None)
            if last_hero is None:
                continue
            v = hero_done(final)
            if v.terminal:
                done_n += 1
                done_kinds[v.kind] = done_kinds.get(v.kind, 0) + 1
            # a hand is COVERED when either the deterministic pre-action window (terminal last pick) or the
            # showdown window exists — the two windows whose end the deal does not control
            if v.terminal:
                covered += 1
    print("\n  SHOWDOWN-PENDING window (hero's part over before the award; the run is not cut by the deal):")
    if total_played:
        print(f"    short hands hero played to the end with an archived line: {total_played}; hero done before the award: {done_n} "
              f"({100 * done_n / total_played:.0f}%) — {done_kinds}")


if __name__ == "__main__":
    raise SystemExit(main())
