"""Replay recorded game-protocol frames through the wrapper's own parser and
check the exported hands against CONTRACT.md §1a.

`debug/ws_dump.jsonl` stores each frame's `data` payload exactly as the tap
handed it to `_on_game_msg`, so replaying it drives the real parser over real
traffic — no client, no table, no network. Failures here are parser failures,
not flaky-capture failures.

Two families of check:

  * SHAPE — the invariants CONTRACT.md §1a promises consumers (card spelling,
    street/board agreement, position vocabulary, action types).
  * SEQUENCE — properties that hold across a hand's snapshots and are where the
    desync bugs actually live: boards only grow, folded seats stop acting,
    round totals only climb, no card appears twice.

Run:  aof-model/.venv/Scripts/python.exe tests/replay_ws_dump.py [dump.jsonl]
"""
from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import launch  # noqa: E402


def sandbox() -> Path:
    """Point every write path in launch.py at a throwaway directory.

    Replaying real traffic drives the REAL parser, and the parser archives
    finished hands — so an unguarded run inserts its replayed hands straight
    into data/hands.db, next to hands actually played. It did exactly that
    once: 13 rows, all stamped inside the same 86 ms. The wrapper may also be
    running against a live table while this executes, so "nothing is using it"
    is never a safe assumption.

    Redirecting rather than stubbing keeps _archive_hand on the tested path —
    it just lands somewhere disposable.
    """
    tmp = Path(tempfile.mkdtemp(prefix="replay-ws-"))
    launch.DATA_DIR = tmp                       # _db() -> hands.db
    launch._WS_DUMP_PATH = tmp / "ws_dump.jsonl"  # belt-and-braces: tap-only
    launch._dbg.update({"on": False, "dir": None})  # debug recorder stays off
    return tmp

# CONTRACT.md §1a: "A♠"-style, ranks use T and never 10.
CARD_RE = re.compile(r"^[AKQJT98765432][♠♥♦♣]$")
POSITIONS = {"UTG", "UTG1", "UTG2", "LJ", "HJ", "CO", "BTN", "SB", "BB"}
ACTION_TYPES = {"post-sb", "post-bb", "fold", "check", "call", "bet", "raise",
                "all-in"}
STREET_FOR_BOARD = {0: "preflop", 3: "flop", 4: "turn", 5: "river"}
VOLUNTARY = ACTION_TYPES - {"post-sb", "post-bb"}


class Report:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.checked = 0

    def check(self, ok: bool, label: str, detail: str = "") -> None:
        self.checked += 1
        if not ok:
            self.failures.append(f"{label}{'  — ' + detail if detail else ''}")


def replay(path: Path) -> tuple[list[dict], dict]:
    """Feed every frame through the parser, snapshotting the export as it goes.

    Snapshots are taken after each frame rather than only at hand boundaries:
    the export is what the poller reads at 1 Hz mid-hand, so a state that is
    only briefly wrong is still a state that ships a wrong answer.
    """
    frames = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line:
            try:
                frames.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # a torn last line from a killed process is not a failure

    snapshots: list[dict] = []
    stats = {"frames": len(frames), "applied": 0, "skipped": 0, "errors": 0}
    for e in frames:
        data = e.get("data")
        pid = e.get("pid")
        # Lifecycle markers and unparsed frames never reached the parser live.
        if not isinstance(data, dict) or not pid or pid.startswith("<"):
            stats["skipped"] += 1
            continue
        try:
            launch._on_game_msg(data)
            stats["applied"] += 1
        except Exception as exc:  # a parser that throws is itself the bug
            stats["errors"] += 1
            snapshots.append({"__error__": f"{pid}: {exc!r}"})
            continue
        try:
            h = launch._hand_state()
        except Exception as exc:
            stats["errors"] += 1
            snapshots.append({"__error__": f"_hand_state after {pid}: {exc!r}"})
            continue
        if h:
            snapshots.append(h)
    return snapshots, stats


def check_shape(h: dict, r: Report, tag: str) -> None:
    r.check(isinstance(h.get("handId"), int), f"{tag} handId is a number")
    r.check(isinstance(h.get("heroSeatId"), int), f"{tag} heroSeatId is a number")

    for c in h.get("heroCards") or []:
        r.check(bool(CARD_RE.match(c)), f"{tag} heroCard spelling", repr(c))
    for c in h.get("board") or []:
        r.check(bool(CARD_RE.match(c)), f"{tag} board card spelling", repr(c))

    board = h.get("board") or []
    r.check(len(board) in STREET_FOR_BOARD, f"{tag} board length is 0/3/4/5",
            f"len={len(board)}")
    if len(board) in STREET_FOR_BOARD:
        r.check(h.get("street") == STREET_FOR_BOARD[len(board)],
                f"{tag} street matches board length",
                f"street={h.get('street')} board={len(board)}")

    r.check(len(h.get("heroCards") or []) in (0, 2), f"{tag} hero holds 0 or 2 cards",
            str(h.get("heroCards")))

    seen: dict[str, str] = {}
    for where, cards in (("board", board), ("hero", h.get("heroCards") or [])):
        for c in cards:
            r.check(c not in seen, f"{tag} no duplicate card in play",
                    f"{c} in {where} and {seen.get(c)}")
            seen[c] = where

    for a in h.get("actions") or []:
        r.check(a.get("type") in ACTION_TYPES, f"{tag} action type in vocabulary",
                str(a.get("type")))
        r.check(isinstance(a.get("seatId"), int), f"{tag} action carries a seat")
        if "amount" in a:
            r.check(isinstance(a["amount"], (int, float)) and a["amount"] >= 0,
                    f"{tag} action amount is a non-negative number", str(a["amount"]))

    for seat, pos in (h.get("positions") or {}).items():
        r.check(pos in POSITIONS, f"{tag} position in gto-trainer vocabulary",
                f"seat {seat} -> {pos}")
    pos_vals = list((h.get("positions") or {}).values())
    r.check(len(pos_vals) == len(set(pos_vals)), f"{tag} positions are unique",
            str(pos_vals))

    node = h.get("currentNode") or {}
    for key in ("pot", "toCall"):
        if node.get(key) is not None:
            r.check(isinstance(node[key], (int, float)) and node[key] >= 0,
                    f"{tag} currentNode.{key} is a non-negative number",
                    str(node[key]))

    # CONTRACT §1a: hero folded => ended.
    if any(a.get("type") == "fold" and a.get("seatId") == h.get("heroSeatId")
           for a in h.get("actions") or []):
        r.check(bool(h.get("ended")), f"{tag} hero folded implies ended")


def check_sequence(hand_id: int, snaps: list[dict], r: Report) -> None:
    tag = f"hand {hand_id}"

    # Boards only ever grow, and dealt cards never change underneath.
    prev: list[str] = []
    for h in snaps:
        b = h.get("board") or []
        r.check(len(b) >= len(prev), f"{tag} board never shrinks",
                f"{prev} -> {b}")
        if len(b) >= len(prev):
            r.check(b[:len(prev)] == prev, f"{tag} dealt board cards are stable",
                    f"{prev} -> {b}")
        prev = b if len(b) >= len(prev) else prev

    final = snaps[-1]
    acts = final.get("actions") or []

    # A folded seat is out of the hand — anything after it is a phantom.
    folded: set[int] = set()
    for a in acts:
        seat = a.get("seatId")
        r.check(seat not in folded, f"{tag} no action after a seat folds",
                f"seat {seat} {a.get('type')} after folding")
        if a.get("type") == "fold":
            folded.add(seat)

    # Blinds come first: no voluntary action may precede a post in the same hand.
    first_voluntary = next((i for i, a in enumerate(acts)
                            if a.get("type") in VOLUNTARY), None)
    last_post = max((i for i, a in enumerate(acts)
                     if a.get("type") in ("post-sb", "post-bb")), default=None)
    if first_voluntary is not None and last_post is not None:
        r.check(last_post < first_voluntary, f"{tag} blinds precede voluntary action",
                f"post at {last_post}, voluntary at {first_voluntary}")

    # "raises to" is a ROUND TOTAL, so within one street it can only climb.
    by_street: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for a in acts:
        if a.get("type") in ("bet", "raise", "all-in") and "amount" in a:
            by_street[a.get("street") or "?"].append((a["type"], a["amount"]))
    for street, seq in by_street.items():
        top = 0.0
        for kind, amt in seq:
            # all-in may be a short shove below the current bet; it does not
            # set a new top and is exempt from the climb.
            if kind == "all-in":
                continue
            r.check(amt >= top, f"{tag} {street} round totals never decrease",
                    f"{kind} {amt} after top {top}")
            top = max(top, amt)

    # Positions are fixed geometry: they must not move mid-hand.
    seen_pos = {json.dumps(h.get("positions") or {}, sort_keys=True) for h in snaps}
    r.check(len(seen_pos) <= 1, f"{tag} positions stable through the hand",
            f"{len(seen_pos)} distinct maps")


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "debug" / "ws_dump.jsonl"
    if not path.exists():
        print(f"no dump at {path}")
        return 2

    # Fingerprint production before touching anything, so the run can PROVE it
    # stayed out rather than asserting it in a comment.
    prod = ROOT / "data" / "hands.db"
    before = prod.stat().st_size if prod.exists() else None

    tmp = sandbox()
    # _archive_hand narrates every hand it files; that is noise here, but the
    # count is a useful signal that the replay reached hand boundaries at all.
    chatter = io.StringIO()
    with contextlib.redirect_stdout(chatter):
        snapshots, stats = replay(path)
    archived = chatter.getvalue().count("[history] archived")

    r = Report()
    after = prod.stat().st_size if prod.exists() else None
    r.check(before == after, "production hands.db untouched by the replay",
            f"{before} -> {after} bytes")

    errors = [s["__error__"] for s in snapshots if "__error__" in s]
    for e in errors:
        r.check(False, "parser raised", e)
    snapshots = [s for s in snapshots if "__error__" not in s]

    by_hand: dict[int, list[dict]] = defaultdict(list)
    for h in snapshots:
        by_hand[h.get("handId")].append(h)

    for h in snapshots:
        check_shape(h, r, f"hand {h.get('handId')}")
    for hand_id, snaps in sorted(by_hand.items(), key=lambda kv: kv[0] or 0):
        check_sequence(hand_id, snaps, r)

    print(f"dump           {path}")
    print(f"frames         {stats['frames']} "
          f"({stats['applied']} applied, {stats['skipped']} lifecycle/unparsed)")
    print(f"hands exported {len(by_hand)}")
    print(f"snapshots      {len(snapshots)}")
    print(f"assertions     {r.checked}")

    if not r.failures:
        print("\nALL PASS")
        return 0

    # Collapse repeats: one bad field re-snapshotted 40 times is one bug.
    counts: dict[str, int] = defaultdict(int)
    for f in r.failures:
        counts[f] += 1
    print(f"\n{len(r.failures)} failed assertions, {len(counts)} distinct:\n")
    for msg, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  x{n:<4} {msg}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
