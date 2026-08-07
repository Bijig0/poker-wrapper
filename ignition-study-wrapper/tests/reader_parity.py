"""Tier 1 — reader parity: does the fake table lose anything the reader reads?

For each recorded tick from the REAL client:

    facts_real = reader(recorded dom.jsonl tick)
    spec       = project(facts_real)          # authored from what was observed
    facts_fake = reader(render(spec))         # through the fake table
    assert facts_real == facts_fake

What this proves: the fake table is a faithful stand-in for the reader —
rendering an observed state and reading it back loses nothing. Every field the
study tools consume survives the round trip.

What it does NOT prove: that the reader is right about the real client. Both
sides run the same reader, so a misreading is reproduced identically on both.
Only recorded ground truth (the frames beside the parse, in Replay Review) can
break that circularity. This measures the surrogate, not the reader.

Runs against the wrapper's own /faketable, so the wrapper must be up. No GTO
Wizard, no live table.

Run:  aof-model/.venv/Scripts/python.exe tests/reader_parity.py [session ...]
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import launch  # noqa: E402  (the reader under test)

# The rig under test. The Study Tool runs the TEST rig on 7701 with the fake
# table; 7700 is the live rig and has no fake table to load, so a suite
# pointed there reports "unavailable" and silently tests nothing.
BASE = os.environ.get("WRAPPER_URL", "http://127.0.0.1:7701")
# States checked by default. Enough to catch a systematic loss; the whole
# corpus (--all) is a deliberate, much longer sweep.
SAMPLE = 120
# States the corpus contains but no table could show — counted, not hidden.
SKIPPED: Counter = Counter()
# Cards come back in the wrapper's display form ("10♣"); the fake table takes
# solver form ("Tc"). One conversion, so the projection is lossless.
_SUIT = {"♠": "s", "♥": "h", "♦": "d", "♣": "c"}


def to_code(display: str) -> str:
    d = display.strip()
    rank = "T" if d.startswith("10") else d[0].upper()
    return rank + _SUIT.get(d[-1], d[-1].lower())


def _post(path: str, body: dict, timeout: float = 20):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                               method="POST",
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as f:
        return json.loads(f.read() or b"{}")


def facts(d: dict) -> dict:
    """Everything the study tools take from one DOM read.

    Deliberately the reader's OUTPUT, not its input: pixel positions differ
    between a real client at some window size and the fake table at another,
    and that difference is meaningless. What must survive is the extraction.
    """
    seats = launch._parse_seats(d)
    return {
        "board": launch._board_cards(d),
        "hero": launch._hero_cards(d),
        "seats": {
            str(n): {
                "stack": s.get("stack"),
                "bet": s.get("bet"),
                "badge": s.get("badge"),
                "cards": s.get("cards"),
            }
            for n, s in sorted(seats.items())
        },
    }


def project(f: dict, d: dict) -> dict | None:
    """An authored spec that should reproduce these observed facts.

    Hero's seat comes from the capture's own myPlayerTag when it carries one,
    else from whichever seat holds the cards the reader attributed to hero —
    the fake table needs to know which chair to deal the faces into.
    """
    seats = f["seats"]
    if len(seats) < 2:
        return None
    nums = sorted(int(n) for n in seats)
    hero = None
    for s in d.get("seatQa") or []:
        if s.get("me") and s.get("num"):
            hero = int(s["num"])
            break
    if hero is None:
        # Older captures: fall back to the lowest seat, which only has to be
        # CONSISTENT between the two sides for the comparison to be valid.
        hero = nums[0]

    def bb(v):
        n = launch._pot_val(v)
        return n

    # Table capacity, not the number of players: a real table routinely shows
    # occupied seats 2..5 on a six-chair ring, and the empty chairs are part of
    # the state. Prefer the capture's own container count, since that IS the
    # capacity; fall back to rounding the highest seat number up to a real
    # table size for captures predating seatQa.
    containers = len(d.get("seatQa") or [])
    cap = containers if containers in (3, 6, 9) else (6 if max(nums) <= 6 else 9)
    if max(nums) > cap or hero not in nums:
        return None

    # A state the reader contradicts itself about cannot be projected onto any
    # table: hero holding identified cards while hero's own seat reports zero
    # of them describes no table that can exist. Reproducing it would mean
    # choosing which half to honour, so it is reported as a source
    # inconsistency instead of scored as a parity loss.
    if f["hero"] and not (seats[str(hero)]["cards"] or 0):
        SKIPPED["hero holds cards at a seat reporting none"] += 1
        return None

    spec_seats: dict[str, dict] = {}
    for n in range(1, cap + 1):
        s = seats.get(str(n))
        if s is None:
            spec_seats[str(n)] = {"empty": True}
            continue
        spec_seats[str(n)] = {
            "stack": bb(s["stack"]),
            "bet": bb(s["bet"]),
            "badge": s["badge"],
            "cards": s["cards"] or 0,
        }
    return {
        "title": "parity",
        "capacity": cap,
        "heroSeat": hero,
        "board": [to_code(c) for c in f["board"]],
        "heroCards": [to_code(c) for c in f["hero"]],
        "seats": spec_seats,
        "node": {"toActSeat": hero},
    }


def read_fake(want_seats: int, tries: int = 14) -> dict:
    """Read the fake table through the same reader, once the page has settled.

    Loading a spec reloads the tab, and a read landing mid-reload returns an
    empty table — which would score as a parity failure when it is only a race
    (it produced 10 spurious mismatches before this poll existed). So retry
    until the expected seat count appears and the reading repeats, rather than
    sleeping a fixed interval and hoping.
    """
    from scout import cdp
    last: dict | None = None
    for _ in range(tries):
        t = next((p for p in (cdp.page_targets(launch.CDP_PORT) or [])
                  if "/faketable" in (p.get("url") or "")), None)
        if t:
            try:
                d = cdp._eval(t["webSocketDebuggerUrl"], launch._TABLE_JS, timeout=10) or {}
                f = facts(d)
                if len(f["seats"]) >= want_seats and f == last:
                    return f          # same reading twice: the page has settled
                last = f
            except Exception:
                last = None
        time.sleep(0.35)
    if last is None:
        raise RuntimeError("fake table never became readable")
    return last


def diff(a: dict, b: dict) -> list[str]:
    """Where the round trip lost something.

    Money is compared as an AMOUNT, not as a string. The client renders some
    readings without the BB suffix and the fake table always writes it, so a
    byte comparison reports "15" vs "15 BB" as a loss when nothing was lost.
    (Those particular readings were the acting seat's COUNTDOWN misread as a
    bet by the geometric fallback — a reader defect the structural pass fixed,
    and not a question about the surrogate.)
    """
    out = []
    if a["board"] != b["board"]:
        out.append(f"board {a['board']} -> {b['board']}")
    if a["hero"] != b["hero"]:
        out.append(f"hero {a['hero']} -> {b['hero']}")
    for n in sorted(set(a["seats"]) | set(b["seats"])):
        x, y = a["seats"].get(n), b["seats"].get(n)
        if x is None or y is None:
            out.append(f"seat {n} {'missing on fake' if y is None else 'invented by fake'}")
            continue
        for k in ("stack", "bet"):
            if launch._pot_val(x[k]) != launch._pot_val(y[k]):
                out.append(f"seat {n}.{k} {x[k]!r} -> {y[k]!r}")
        for k in ("badge", "cards"):
            if x[k] != y[k]:
                out.append(f"seat {n}.{k} {x[k]!r} -> {y[k]!r}")
    return out


def main() -> int:
    try:
        urllib.request.urlopen(BASE + "/state", timeout=5)
    except (urllib.error.URLError, OSError) as e:
        print(f"wrapper not reachable on {BASE} — launch Ignition Study first ({e})")
        return 2

    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    every = "--all" in sys.argv
    wanted = set(args)
    sessions = sorted((ROOT / "debug").glob("session_*"))
    if wanted:
        sessions = [s for s in sessions if s.name in wanted]

    # One tick per distinct observed state: consecutive ticks repeat the same
    # table for seconds at a time, and re-rendering identical states only costs
    # wall clock.
    cases: list[tuple[str, int, dict, dict]] = []
    for s in sessions:
        p = s / "dom.jsonl"
        if not p.exists():
            continue
        seen: set[str] = set()
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            f = facts(d)
            if len(f["seats"]) < 2:
                continue
            key = json.dumps(f, sort_keys=True, ensure_ascii=False)
            if key in seen:
                continue
            seen.add(key)
            spec = project(f, d)
            if spec is None:
                continue
            cases.append((s.name, d.get("seq", -1), f, spec))

    if SKIPPED:
        print("source states no table could reproduce (reader self-contradictions):")
        for why, n in SKIPPED.most_common():
            print(f"  x{n:<4} {why}")
        print()
    if not cases:
        print("no projectable states in the corpus — record a session first")
        return 2

    # Each state costs a page reload and a settle poll, so the whole corpus is
    # a ~50-minute sweep — worth running deliberately, too slow to run on every
    # change. Default to an EVENLY SPREAD sample so every session and every
    # phase of every session is represented (contiguous ticks repeat the same
    # few spots, so a head-of-list cut would only ever test the first hand).
    total = len(cases)
    if not every and total > SAMPLE:
        step = total / SAMPLE
        cases = [cases[int(i * step)] for i in range(SAMPLE)]
    limit = len(cases)
    print(f"{total} distinct states from {len(sessions)} session(s)"
          + ("" if limit == total else f" — sampling {limit} (--all for every one)")
          + "\n")

    fails: list[tuple[str, int, list[str]]] = []
    reasons: Counter = Counter()
    for i, (sess, seq, want, spec) in enumerate(cases[:limit], 1):
        try:
            _post("/faketable/load", spec)
            got = read_fake(len(want["seats"]))
        except Exception as e:
            fails.append((sess, seq, [f"render/read failed: {e!r}"]))
            continue
        d = diff(want, got)
        if d:
            fails.append((sess, seq, d))
            for line in d:
                reasons[line.split()[0] + " " + line.split()[1].split(".")[-1]] += 1
        if i % 25 == 0 or i == limit:
            print(f"  {i}/{limit} checked, {len(fails)} mismatched")

    try:
        _post("/faketable/stop", {})
    except Exception:
        pass

    print()
    if not fails:
        print(f"PARITY HOLDS — {limit} states round-tripped with no loss")
        return 0
    print(f"{len(fails)}/{limit} states diverged. Most common:")
    for what, n in reasons.most_common(10):
        print(f"  x{n:<4} {what}")
    print("\nfirst few:")
    for sess, seq, d in fails[:5]:
        print(f"  {sess} seq {seq}")
        for line in d[:6]:
            print(f"      {line}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
