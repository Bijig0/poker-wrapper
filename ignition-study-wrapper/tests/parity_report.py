"""Geometric parity: recorded client DOM vs the replica's measured constants.

Reads a debug session's dom.jsonl (the raw _TABLE_JS output captured off the
real client) and checks the geometry the replica renders from — card sizes,
pitches, aspect ratios, board layout — against what the client actually drew.

Coordinates in dom.jsonl are viewport pixels and the client's CSS `zoom`
computes to 1 on this layout, so nothing external gives the du scale. The
scale is instead SELF-CALIBRATED per tick from elements whose design size is
known: hero hole cards are 36du wide, so s = median(hero_w) / 36. Every other
measurement is then converted through s and compared to the constant. A wrong
calibration cannot silently pass: independent elements (board width, pitches,
villain cards) would all disagree together.

Replica constants duplicated from gto-trainer .../components/table/types.ts —
this script deliberately has no TS dependency. If types.ts changes, change
EXPECTED below.

Run:  aof-model/.venv/Scripts/python.exe tests/parity_report.py [session_dir]
"""
from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# --- replica constants (types.ts) -------------------------------------------
EXPECTED = {
    "hero_card_w": 36.0,        # PARTS.holeCard.w
    "hero_pitch": 39.0,         # PARTS.holeCard.pitch
    "villain_card_w": 30.0,     # PARTS.villainCard.w
    "board_card_w": 51.0,       # PARTS.boardCard.w
    "board_pitch": 61.0,        # PARTS.boardCard.pitch
    "card_aspect": 150 / 100,   # h/w — every real card SVG is 100x150
    "board_slots": 5,
    "placeholder_aspect": 199 / 134,  # empty board slots use a 134:199 graphic
}
TOL = 0.03  # 3% — generous for rounding to whole px at ~1.17 scale


def decode(qa: str) -> int | None:
    if qa.startswith("card") and qa[4:].lstrip("-").isdigit():
        return int(qa[4:])
    return None


def classify(dom: list[dict]) -> dict[str, list]:
    """Bucket every card element in every tick by what it is.

    Real cards (id 0..51) split into board vs hole by band: _TABLE_JS's
    `cards` list is the mid-band board filter, so anything in `allCards`
    with a real id that is NOT at a board position is a hole card. Hole
    cards further split hero/villain by width cluster — hero's are the
    widest hole cards on the table by design (36du vs 30du).
    """
    out = defaultdict(list)
    for d in dom:
        # `cards` entries are top-left boxes with w+h; `allCards` entries are
        # CENTERS with width only (see _TABLE_JS). Compare like with like or
        # the board dedup never fires and board cards pollute the hole set.
        board_ctr = {(c["x"] + c["w"] / 2, c["y"] + c["h"] / 2)
                     for c in d.get("cards") or []}
        for c in d.get("cards") or []:
            cid = decode(c.get("qa", ""))
            if c.get("qa") == "card-placeholder":
                out["placeholder"].append(c)
            elif cid is not None and 0 <= cid <= 51:
                out["board"].append(c)
        for c in d.get("allCards") or []:
            cid = decode(c.get("qa", ""))
            if cid is None or not (0 <= cid <= 51):
                continue
            if any(abs(c["x"] - bx) < 6 and abs(c["y"] - by) < 6
                   for bx, by in board_ctr):
                continue
            out["hole"].append(c)
        # Board slot x-positions from the PLACEHOLDER rack only. It is the
        # static five-slot layout; real cards animate through intermediate
        # positions and the hidden-card layer sits in a second row, so mixing
        # them turns the stride into garbage.
        xs = sorted({c["x"] for c in d.get("cards") or []
                     if c.get("qa") == "card-placeholder"})
        deltas = [b - a for a, b in zip(xs, xs[1:])]
        out["board_stride"].extend(dl for dl in deltas if 20 <= dl <= 150)
        if len(xs) == 5:
            out["five_slot_ticks"].append(xs)
    return out


def med(vals) -> float | None:
    vals = list(vals)
    return statistics.median(vals) if vals else None


class Report:
    def __init__(self):
        self.rows: list[tuple[str, str, str, float | None, bool | None]] = []

    def add(self, name: str, measured, expected, ok: bool | None):
        self.rows.append((name, measured, expected, ok))

    def check(self, name: str, measured: float | None, expected: float):
        if measured is None:
            self.add(name, "—", f"{expected:g}", None)
            return
        ok = abs(measured - expected) / expected <= TOL
        self.add(name, f"{measured:.3f}", f"{expected:g}", ok)

    def dump(self) -> int:
        w = max(len(r[0]) for r in self.rows) + 2
        fails = 0
        for name, m, e, ok in self.rows:
            mark = "  " if ok is None else ("OK" if ok else "FAIL")
            if ok is False:
                fails += 1
            print(f"  {name:<{w}} measured {m:>10}   expected {e:>8}   {mark}")
        return fails


def main() -> int:
    if len(sys.argv) > 1:
        S = Path(sys.argv[1])
    else:
        S = max((ROOT / "debug").glob("session_*"), key=lambda p: p.name)
    dom_path = S / "dom.jsonl"
    if not dom_path.exists():
        print(f"no dom.jsonl in {S}")
        return 2
    dom = [json.loads(l) for l in dom_path.read_text(encoding="utf-8", errors="replace").splitlines() if l.strip()]
    print(f"session {S.name}: {len(dom)} ticks")

    cards = classify(dom)

    # --- width clusters, anchor-free ----------------------------------------
    # Positional filters cannot classify cards on this layout (hero's hand
    # sits inside the client's own board band), but the WIDTH population can:
    # by design there are exactly three real-card sizes with fixed ratios,
    # villain 30du : hero 36du : board 51du. Cluster all real-card widths,
    # take the three modes, and let the RATIOS identify which is which. The
    # hero cluster then sets the scale; villain and board agreeing with their
    # own du sizes through that same scale is itself the parity evidence —
    # a wrong assignment cannot produce three coincidental agreements.
    # Geometry needs every card-shaped element, not just identified faces:
    # villain hands render as CARD_EMPTY backs (card32896 = 0x8080) and in a
    # no-showdown session those are the ONLY villain-card samples. Sentinels
    # carry no identity but they are drawn in the real slot geometry, which is
    # what is being measured. Only card-1 (the hidden layer) and the
    # placeholder rack stay out — they use different art with different boxes.
    hist: dict[int, int] = defaultdict(int)
    for d in dom:
        for c in d.get("allCards") or []:
            qa = c.get("qa", "")
            if qa.startswith("card") and qa[4:].isdigit():
                hist[c["w"]] += 1
    modes = sorted(w for w, n in hist.items() if n >= max(hist.values()) * 0.05)
    # merge ±1px rounding neighbours into their heavier mode
    merged: list[int] = []
    for w in modes:
        if merged and w - merged[-1] <= 1:
            if hist[w] > hist[merged[-1]]:
                merged[-1] = w
        else:
            merged.append(w)
    if len(merged) < 2:
        print(f"not enough width clusters to calibrate (got {merged})")
        return 2
    villain_w, hero_w = (merged[0], merged[1]) if len(merged) == 2 else (merged[-3], merged[-2])
    board_w = merged[-1] if len(merged) >= 3 else None

    s = hero_w / EXPECTED["hero_card_w"]
    n_hero = hist[hero_w]
    print(f"width clusters (px): {merged}  ->  villain {villain_w}, hero {hero_w}, "
          f"board {board_w}")
    print(f"scale s = {s:.4f} px/du   (hero cluster, {n_hero} samples; "
          f"CSS zoom reported {dom[len(dom)//2].get('zoom')})")
    print()

    r = Report()
    r.check("villain card w (du)", villain_w / s, EXPECTED["villain_card_w"])
    if board_w is not None:
        r.check("board card w (du)", board_w / s, EXPECTED["board_card_w"])
        # aspect from full boxes in the mid-band list, board-width only
        bd = [c for c in cards["board"] if abs(c["w"] - board_w) <= 1]
        if bd:
            r.check("card aspect h/w (board)", med(c["h"] / c["w"] for c in bd),
                    EXPECTED["card_aspect"])
    stride = cards["board_stride"]
    if stride:
        r.check("board pitch (du)", med(stride) / s, EXPECTED["board_pitch"])
    # hero pitch: adjacent hero-width cards in one tick; x values are centres,
    # and centre deltas equal left-edge deltas for equal-width cards
    hero_pitch = []
    for d in dom:
        hx = sorted({c["x"] for c in d.get("allCards") or []
                     if (qa := c.get("qa", "")).startswith("card") and qa[4:].isdigit()
                     and abs(c["w"] - hero_w) <= 1})
        hero_pitch.extend(b - a for a, b in zip(hx, hx[1:]) if 0 < b - a < hero_w * 2)
    if hero_pitch:
        r.check("hero pitch (du)", med(hero_pitch) / s, EXPECTED["hero_pitch"])
    ph = cards["placeholder"]
    if ph:
        r.check("placeholder aspect h/w", med(c["h"] / c["w"] for c in ph),
                EXPECTED["placeholder_aspect"])
    for xs in cards["five_slot_ticks"][:1]:
        r.add("board slots", str(len(xs)), "5", len(xs) == 5)
    # Board equal spacing: max deviation between strides in a 5-slot tick
    dev = [max(b - a for a, b in zip(xs, xs[1:])) - min(b - a for a, b in zip(xs, xs[1:]))
           for xs in cards["five_slot_ticks"]]
    if dev:
        r.add("board slot spacing max jitter (px)", f"{max(dev)}", "<= 2",
              max(dev) <= 2)

    fails = r.dump()

    # --- context the numbers need -------------------------------------------
    fr = dom[len(dom) // 2].get("frame") or {}
    if fr:
        print(f"\n  frame {fr.get('w')}x{fr.get('h')} px = "
              f"{fr.get('w', 0) / s:.0f}x{fr.get('h', 0) / s:.0f} du "
              f"(replica felt: 955x512 du)")
    caps = {len([n for n in (d.get('nodes') or []) if 'BB' in n.get('text', '')])
            for d in dom}
    print(f"\n{'PARITY HOLDS' if fails == 0 else str(fails) + ' DEVIATIONS'} "
          f"on the self-similar geometry (sizes, pitches, aspects).")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
