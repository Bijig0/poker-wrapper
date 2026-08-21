"""Fake Ignition table: render a game-state spec as a faithful local table.

Two jobs at once, and both matter:

  * STRUCTURE — it emits the client's own DOM contract (the data-qa hooks and
    containment _TABLE_JS keys on), so the wrapper reads a specified state
    exactly as it reads real Ignition: playerContainer-N seats carrying
    playerBalance / myPlayerTag / holeCards, board card<N> svgs under
    [data-qa='table'] and under no seat, and fold/call/raise/*Selector
    controls.

  * APPEARANCE — the geometry and art are the replica's, not invented here.
    Every constant below was measured off the live client (see
    gto-trainer/apps/dashboard/src/components/table/types.ts, whose comments
    record how each was measured and how it was mismeasured first), and the
    card faces, card back, chip, dealer button and watermark are the real
    assets — the last four harvested from the client's own DOM.

Keeping both in one document is the point: what the reader parses and what a
human eyeballs are then guaranteed to be the same table.

Layout mirrors the client exactly: an 800x400 "design unit" seat container
inset inside a larger painted felt, scaled to the window with CSS `zoom`.
"""
from __future__ import annotations

import html
import mimetypes
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# The replica's asset library (card faces + the SVGs harvested from the client).
ASSETS = ROOT.parent / "gto-trainer" / "apps" / "dashboard" / "public"

_RANKS = "A23456789TJQK"
_SUITS = "cdhs"
_GLYPH = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}

# ---- geometry, measured off the live client (types.ts) ---------------------
DESIGN = (800, 400)
FELT = (955, 512)
SEAT_INSET = (77.5, 16.7)
OVAL = (162, 107, 476, 186)
POT_PILL = (340, 124, 120, 21)
BOARD_BOX = (251, 176)
SEAT_BOX = (114, 100)
HEADER_H = 26
CARD_ASPECT = 100 / 150

SEAT_MAPS = {
    # 3-max is not a layout of its own: the client seats three players on the
    # six-slot ring, at hero's bottom-centre chair and the two LOWER side
    # chairs flanking it (6-max slots 0, 1 and 5). Seat order runs the same
    # way the six-slot ring runs — hero, then screen-left, then screen-right —
    # so hero on the button gives SB screen-left and BB screen-right, which is
    # what the replica's own 3-max preset shows.
    3: [(343, 290), (63, 236), (623, 236)],
    6: [(343, 290), (63, 236), (63, 66), (343, 14), (623, 66), (623, 236)],
    9: [(343, 290), (183, 279), (45, 210), (51, 66), (234, 8),
        (452, 8), (636, 66), (641, 210), (502, 279)],
}
# Per-seat bet-chip anchors: the client places each seat's chips on the side
# facing the table centre, so this is a lookup, not a uniform offset.
CHIPS = {
    # Slot 3 (6-max top-centre) is the one anchor types.ts flags as UNVERIFIED —
    # it borrows the 9-max top seats' offset and was never observed with a bet.
    # Borrowed verbatim it lands at (377,123), straight on top of the measured
    # pot pill at (340,124): the top seat's chips and the pot readout overwrite
    # each other whenever the button bets. Nudged left of the pill instead. The
    # 9-max top seats sit at x=234/452 and clear the pill on their own.
    6: [(34.7, -10), (96, 25), (118, 93), (-66, 100), (-48.6, 93), (-26.6, 25)],
    9: [(34.7, -10), (34.7, 5), (96, 25), (118, 93), (34.7, 109),
        (34.7, 109), (-48.6, 93), (-26.6, 25), (34.7, 5)],
}
# 3-max borrows the anchors of the three 6-max chairs it occupies (0, 1, 5).
CHIPS[3] = [CHIPS[6][0], CHIPS[6][1], CHIPS[6][5]]
PILL = dict(x=0, y=58, w=114, h=28, radius=50)
BADGE = dict(d=24, x=3)
STRIP = dict(y=72, h=29, visible=15)
HOLE = dict(w=36, pitch=39, x=18, y=7.3)
VILLAIN = dict(w=30, pitch=32, x=25, y=24.3)
BOARD_CARD = dict(w=51, pitch=61)
ACTION_BAR = dict(h=76, btn_w=132, btn_h=40, raise_h=48, gap=10)

# The client's own felt gradients, verbatim from its stylesheet rules
# (.f1k8wgos base, .fufhpgb, .f1nx5g43); teal approximated from the Zone
# capture. spec.theme picks one; red is the default table.
FELTS = {
    "red": "radial-gradient(rgb(204,0,0) 0%, rgb(109,0,0) 80%, rgb(70,2,2) 100%)",
    "orange": "radial-gradient(rgb(227,96,3) 0%, rgb(180,74,0) 50%, rgb(106,33,0) 100%)",
    "purple": "radial-gradient(rgb(112,55,84) 0%, rgb(93,49,78) 30%, rgb(26,26,51) 90%)",
    "teal": "radial-gradient(rgb(30,65,64) 0%, rgb(24,51,52) 62%, rgb(17,38,38) 100%)",
}
MAIN_POT_PILL = (342.3, 149.4, 111.3, 17.8)

# The client's felt noise tile (.fs9k49k), verbatim: a 20x20 SVG at 4% black.
FELT_NOISE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 52 52'%3E%3Cpath fill='%23000000' fill-opacity='0.04' d='M0 17.83V0h17.83a3 3 0 0 1-5.66 2H5.9A5 5 0 0 1 2 5.9v6.27a3 3 0 0 1-2 5.66zm0 18.34a3 3 0 0 1 2 5.66v6.27A5 5 0 0 1 5.9 52h6.27a3 3 0 0 1 5.66 0H0V36.17zM36.17 52a3 3 0 0 1 5.66 0h6.27a5 5 0 0 1 3.9-3.9v-6.27a3 3 0 0 1 0-5.66V52H36.17zM0 31.93v-9.78a5 5 0 0 1 3.8.72l4.43-4.43a3 3 0 1 1 1.42 1.41L5.2 24.28a5 5 0 0 1 0 5.52l4.44 4.43a3 3 0 1 1-1.42 1.42L3.8 31.2a5 5 0 0 1-3.8.72zm52-14.1a3 3 0 0 1 0-5.66V5.9A5 5 0 0 1 48.1 2h-6.27a3 3 0 0 1-5.66-2H52v17.83zm0 14.1a4.97 4.97 0 0 1-1.72-.72l-4.43 4.44a3 3 0 1 1-1.41-1.42l4.43-4.43a5 5 0 0 1 0-5.52l-4.43-4.43a3 3 0 1 1 1.41-1.41l4.43 4.43c.53-.35 1.12-.6 1.72-.72v9.78zM22.15 0h9.78a5 5 0 0 1-.72 3.8l4.44 4.43a3 3 0 1 1-1.42 1.42L29.8 5.2a5 5 0 0 1-5.52 0l-4.43 4.44a3 3 0 1 1-1.41-1.42l4.43-4.43a5 5 0 0 1-.72-3.8zm0 52c.13-.6.37-1.19.72-1.72l-4.43-4.43a3 3 0 1 1 1.41-1.41l4.43 4.43a5 5 0 0 1 5.52 0l4.43-4.43a3 3 0 1 1 1.42 1.41l-4.44 4.43c.36.53.6 1.12.72 1.72h-9.78zm9.75-24a5 5 0 0 1-3.9 3.9v6.27a3 3 0 1 1-2 0V31.9a5 5 0 0 1-3.9-3.9h-6.27a3 3 0 1 1 0-2h6.27a5 5 0 0 1 3.9-3.9v-6.27a3 3 0 1 1 2 0v6.27a5 5 0 0 1 3.9 3.9h6.27a3 3 0 1 1 0 2H31.9z'%3E%3C/path%3E%3C/svg%3E"

C = dict(oval="rgba(255,255,255,0.2)", pill="#ffffff",
         pill_folded="rgba(196,214,217,0.45)", badge="#00c9b7",
         pot_bg="rgba(0,0,0,0.25)", chip_bg="rgba(0,0,0,0.3)",
         strip="#00c9b7", strip_fold="rgba(0,0,0,0.45)", text="#0b1516")


def asset(rel: str) -> tuple[bytes, str] | None:
    """Serve one file from the replica's public/ directory. Path-checked: only
    files that really sit under ASSETS are returned."""
    try:
        p = (ASSETS / rel).resolve()
        if not str(p).startswith(str(ASSETS.resolve())) or not p.is_file():
            return None
        return p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    except OSError:
        return None


def display_card(code: str) -> str:
    """"Tc" -> "10♣" — the wrapper's internal display form (_card_name's
    output), which _hand_state shortens back to solver form at the boundary."""
    c = code.strip()
    r = "10" if c[0].upper() == "T" or c.startswith("10") else c[0].upper()
    s = _GLYPH.get(c[-1].lower(), c[-1])
    return r + s


def encode_card(code: str) -> int:
    """"Ah" -> 26, the client's own id (suit*13 + rank, ace low)."""
    c = code.strip().replace("10", "T")
    r = _RANKS.index(c[0].upper())
    suit = {v: k for k, v in _GLYPH.items()}.get(c[-1], c[-1].lower())
    return _SUITS.index(suit) * 13 + r


def _art(code: str, kind: str) -> str:
    c = code.strip().replace("10", "T")
    suit = {v: k for k, v in _GLYPH.items()}.get(c[-1], c[-1].lower())
    return f"/faketable/assets/cards/{kind}/{c[0].upper()}{suit}.png"


def _card(code: str, w: float, kind: str) -> str:
    """A real card. The element is an <svg data-qa='card<N>'> because that is
    what the reader looks for; the face is the replica's own art, drawn inside
    it. Height is derived from the width via the 2:3 aspect every client card
    svg uses, so faces are never stretched."""
    h = w / CARD_ASPECT
    n = encode_card(code)
    return (f"<svg data-qa='card{n}' width='{w:.1f}' height='{h:.1f}' "
            f"viewBox='0 0 100 150' style='display:block;border-radius:{w*0.09:.1f}px;"
            f"box-shadow:0 1px 3px rgba(0,0,0,.55);background:#fff'>"
            f"<image href='{_art(code, kind)}' width='100' height='150' "
            f"preserveAspectRatio='none'/></svg>")


def _back(w: float) -> str:
    """Face-down card: the client's own back art, under the hidden sentinel id."""
    h = w / CARD_ASPECT
    return (f"<svg data-qa='card-1' width='{w:.1f}' height='{h:.1f}' "
            f"viewBox='0 0 100 150' style='display:block;border-radius:{w*0.09:.1f}px;"
            f"box-shadow:0 1px 3px rgba(0,0,0,.55)'>"
            f"<image href='/faketable/assets/ign/card-back.svg' width='100' height='150' "
            f"preserveAspectRatio='none'/></svg>")


def _bb(v) -> str:
    if v is None:
        return ""
    return f"{float(v):g} BB"


def _seat(num: int, slot: int, s: dict, is_hero: bool, cap: int,
          hero_cards: list[str], dealer: bool, acting: bool) -> str:
    """One playerContainer-N, laid out exactly as the replica lays out a seat."""
    ox, oy = SEAT_MAPS[cap][slot]
    idx = num - 1
    box = (f"position:absolute;left:{ox}px;top:{oy}px;"
           f"width:{SEAT_BOX[0]}px;height:{SEAT_BOX[1]}px")

    if s.get("empty"):
        return (
            f"<div data-qa='playerContainer-{idx}' style='{box};display:flex;"
            f"flex-direction:column;align-items:center;justify-content:center;gap:5px;"
            f"color:rgba(255,255,255,.55)'>"
            f"<div data-qa='player-empty-seat-panel' style='display:flex;flex-direction:column;"
            f"align-items:center;gap:5px'>"
            f"<div style='width:32px;height:32px;border-radius:50%;"
            f"border:1.5px solid rgba(255,255,255,.5);display:flex;align-items:center;"
            f"justify-content:center'>"
            f"<svg width='17' height='17' viewBox='0 0 24 24'>"
            f"<circle cx='12' cy='8.2' r='3.6' fill='currentColor'/>"
            f"<path d='M4.6 20c0-4 3.3-6.2 7.4-6.2S19.4 16 19.4 20Z' fill='currentColor'/>"
            f"</svg></div>"
            f"<div data-qa='player-empty-seat-label' style='font-size:9px;text-align:center;"
            f"line-height:1.2'>Vacant<br>seat</div></div></div>")

    folded = not s.get("cards")
    cw = HOLE if is_hero else VILLAIN

    # Hole cards: hero shows faces, a live villain shows backs. They tuck BEHIND
    # the stack pill by design, so the pill carries a z-index above them.
    cards_html = ""
    if is_hero and hero_cards and not folded:
        # Hero's slot COUNT comes from the seat like everyone else's, not from
        # how many faces the spec happens to carry: a folded hero must show no
        # cards, and a seat observed holding more slots than faces (the client's
        # animation double-buffer, which the geometric reader counts twice) has
        # to be reproducible or the round trip loses it. Faces first, backs for
        # any remainder.
        want_n = int(s.get("cards") or len(hero_cards))
        cards_html = "".join(
            f"<div data-qa='holeCards' style='position:absolute;left:{i*cw['pitch']}px;top:0'>"
            + (_card(hero_cards[i], cw["w"], "hole") if i < len(hero_cards)
               else _back(cw["w"]))
            + "</div>"
            for i in range(want_n))
    elif not folded:
        cards_html = "".join(
            f"<div data-qa='holeCards' style='position:absolute;left:{i*cw['pitch']}px;top:0'>"
            f"{_back(cw['w'])}</div>"
            for i in range(int(s.get("cards") or 2)))
    cards_block = (f"<div style='position:absolute;left:{cw['x']}px;top:{cw['y']}px;"
                   f"opacity:{0.4 if folded else 1}'>{cards_html}</div>"
                   if cards_html else "")

    # Status strip, sliding out from under the pill.
    badge = s.get("badge")
    # The reader NORMALIZES the client's "POST SB" to "POST-SB", and specs
    # round-tripped from recordings carry that form. The real client never
    # renders the hyphen, so neither can this table — rendering it verbatim
    # made the reader's own badge regex miss it, and parity blamed the reader
    # for a badge this table had drawn wrong.
    if badge:
        badge = re.sub(r"^POST-(SB|BB)$", r"POST \1", str(badge))
    strip = ""
    if badge:
        strip = (
            f"<div style='position:absolute;left:{PILL['x']}px;top:{STRIP['y']}px;"
            f"width:{PILL['w']}px;height:{STRIP['h']}px;"
            f"background:{C['strip_fold'] if folded else C['strip']};"
            f"border-radius:4px 4px 6px 6px;color:#fff;font-size:12px;font-weight:700;"
            f"letter-spacing:.3px;display:flex;align-items:center;justify-content:center;"
            f"padding-top:{STRIP['h']-STRIP['visible']}px'>{html.escape(str(badge))}</div>")

    # Committed chips, in front of the seat, at this seat's own anchor. The
    # client keeps a "0 BB" chip on every seated player between actions: the
    # reader RECORDS it (and its vis() rejects opacity/visibility tricks, so
    # the text must be first-class visible in the client's DOM), yet no
    # recorded FRAME ever shows one — the client paints idle chips with
    # transparent ink rather than hiding the element. Rendering them in solid
    # colour here dressed every seat in a 0 BB chip the real table never
    # displays. Transparent ink reproduces both truths: the reader still reads
    # "0 BB" (exercising its zero-bet filter, exactly as live), and the felt
    # looks like the client's.
    bet = s.get("bet")
    live = bet is not None and bet != 0
    ink = "" if live else "background:transparent;color:transparent;"
    img_ink = "" if live else "visibility:hidden;"
    bx, by = CHIPS[cap][slot]
    chips = (
        f"<div style='position:absolute;left:{bx}px;top:{by}px;height:15px;"
        f"display:flex;align-items:center;gap:3px'>"
        f"<span style='background:{C['chip_bg']};border-radius:9999px;padding:0 6px;"
        f"color:#fff;font-size:12px;line-height:15px;white-space:nowrap;{ink}'>"
        f"{_bb(bet if bet is not None else 0)}</span>"
        f"<img src='/faketable/assets/ign/chip-icon.svg' style='width:14px;height:15px;"
        f"display:block;{img_ink}'></div>")

    halo = ""
    if acting:
        halo = (f"<div style='position:absolute;left:{SEAT_BOX[0]/2}px;"
                f"top:{PILL['y']+PILL['h']/2}px;width:160px;height:160px;"
                f"transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;"
                f"background:radial-gradient(circle,rgba(255,255,255,.13) 38%,"
                f"rgba(255,255,255,.05) 58%,transparent 68%)'></div>")

    # Countdown strip for the seat on the clock, below the status strip (or the
    # pill when no badge shows) — the replica's own layout rule.
    timer = s.get("timer")
    timer_html = ""
    if acting and timer is not None:
        t_top = STRIP["y"] + STRIP["h"] if badge else PILL["y"] + PILL["h"]
        frac = max(0.0, min(1.0, float(timer) / 30))
        timer_html = (
            f"<div style='position:absolute;left:{PILL['x']}px;top:{t_top}px;"
            f"width:{PILL['w']}px;height:11px;background:rgba(0,0,0,.55);"
            f"border-radius:0 0 6px 6px;display:flex;align-items:center;gap:4px;"
            f"padding:0 5px;box-sizing:border-box'>"
            f"<span style='color:#fff;font-size:8px;font-weight:700'>{int(timer)}</span>"
            f"<span style='flex:1;height:4px;border-radius:2px;"
            f"background:rgba(255,255,255,.25);overflow:hidden'>"
            f"<span style='display:block;height:100%;width:{frac*100:.0f}%;"
            f"background:#efc144'></span></span></div>")

    dealer_btn = ""
    if dealer:
        dx = -8 if ox > 400 else SEAT_BOX[0] - 8
        dealer_btn = (
            f"<div style='position:absolute;left:{dx}px;top:{PILL['y']-6}px;width:17px;"
            f"height:17px;border-radius:50%;background:#e6e6e6;"
            f"border:.5px solid rgba(0,0,0,.3);display:flex;align-items:center;"
            f"justify-content:center;z-index:3'>"
            f"<img src='/faketable/assets/ign/dealer-d.svg' style='width:10px;height:10px;"
            f"display:block'></div>")

    # The stack pill. myPlayerTag marks hero — the hook the reader keys on.
    tag_open = ("<div data-qa='myPlayerTag' style='display:contents'>" if is_hero
                else "<div style='display:contents'>")
    pill = (
        f"{tag_open}"
        f"<div style='position:absolute;left:{PILL['x']}px;top:{PILL['y']}px;"
        f"width:{PILL['w']}px;height:{PILL['h']}px;border-radius:{PILL['radius']}px;"
        f"background:{C['pill_folded'] if folded else C['pill']};"
        f"box-shadow:0 1px 10px 4px rgba(0,0,0,.5);display:flex;align-items:center;"
        f"z-index:2'>"
        f"<span style='width:{BADGE['d']}px;height:{BADGE['d']}px;margin-left:{BADGE['x']}px;"
        f"flex:0 0 auto;border-radius:50%;"
        f"background:{'rgba(0,201,183,.5)' if folded else C['badge']};color:#fff;"
        f"font-size:12px;font-weight:700;display:flex;align-items:center;"
        f"justify-content:center'>{num}</span>"
        f"<span data-qa='playerBalance' style='flex:1;text-align:center;padding-right:6px;"
        f"font-size:16px;font-weight:700;color:{C['text']};"
        f"opacity:{0.7 if folded else 1}'>{_bb(s.get('stack'))}</span>"
        f"</div></div>")

    return (f"<div data-qa='playerContainer-{idx}' style='{box}'>"
            f"{halo}{chips}{cards_block}{strip}{timer_html}{pill}{dealer_btn}</div>")


def _button(qa: str, label: str, kind: str = "action") -> str:
    h = ACTION_BAR["raise_h"] if qa == "raiseButton" else ACTION_BAR["btn_h"]
    bg = "rgba(0,0,0,0.3)" if qa == "raiseButton" else (
        "rgba(255,255,255,0.25)" if kind == "preset" else "rgba(0,0,0,0.55)")
    fs = 10 if kind == "preset" else 14
    w = 97.8 if kind == "preset" else ACTION_BAR["btn_w"]
    return (f"<button data-qa='{qa}' style='width:{w}px;height:{h}px;border:0;"
            f"border-radius:8px;background:{bg};color:#fff;font:inherit;font-size:{fs}px;"
            f"font-weight:600;cursor:pointer;white-space:pre-line'>"
            f"{html.escape(label)}</button>")


def render_inner(spec: dict) -> str:
    raw_cap = int(spec.get("capacity", 6))
    cap = 3 if raw_cap <= 3 else 9 if raw_cap > 6 else 6
    hero = int(spec.get("heroSeat") or 1)
    dealer = spec.get("dealerSeat")
    seats_in = spec.get("seats") or {}
    to_act = (spec.get("node") or {}).get("toActSeat")
    hero_cards = [c for c in (spec.get("heroCards") or [])]

    # Hero is pinned bottom-centre (slot 0) and the ring rotates around them —
    # the client's own convention, which is why the seat maps are lookups.
    order = [((hero - 1 + i) % cap) + 1 for i in range(cap)]
    seat_html = "".join(
        _seat(num, slot, seats_in.get(str(num)) or seats_in.get(num) or {"empty": True},
              num == hero, cap, hero_cards, num == dealer, num == to_act)
        for slot, num in enumerate(order))

    # The board is a STATIC five-slot rack the client fills left to right, so
    # the flop never moves when the turn and river land. Undealt slots keep
    # the client's placeholder graphic alive (data-qa='card-placeholder',
    # 134:199 aspect — deliberately NOT the card aspect, per types.ts).
    board = spec.get("board") or []
    bx, by = BOARD_BOX
    ph_h = BOARD_CARD["w"] * 199 / 134
    board_html = "".join(
        f"<div style='position:absolute;left:{i*BOARD_CARD['pitch']}px;top:0'>"
        f"{_card(c, BOARD_CARD['w'], 'board')}</div>"
        for i, c in enumerate(board)) + "".join(
        f"<div style='position:absolute;left:{i*BOARD_CARD['pitch']}px;top:0'>"
        f"<svg data-qa='card-placeholder' width='{BOARD_CARD['w']}' height='{ph_h:.1f}' "
        f"viewBox='0 0 134 199' style='display:block'>"
        f"<rect x='2' y='2' width='130' height='195' rx='8' fill='none' "
        f"stroke='rgba(255,255,255,0.12)' stroke-width='2'/></svg></div>"
        for i in range(len(board), 5))

    offer = spec.get("offer") or {}
    strip = []
    if offer.get("fold"):
        strip.append(_button("foldButton", "FOLD"))
    if offer.get("check"):
        strip.append(_button("checkButton", "CHECK"))
    if offer.get("call") is not None:
        strip.append(_button("callButton", f"CALL {_bb(offer['call'])}"))
    if offer.get("bet") is not None:
        strip.append(_button("betButton", f"BET {_bb(offer['bet'])}"))
    if offer.get("raise") is not None:
        strip.append(_button("raiseButton", f"RAISE TO {_bb(offer['raise'])}"))
    # The client's raise column carries a small ALL-IN chip beneath the RAISE
    # TO button (97.8x24 on white 25%); it is decoration on the raise action,
    # distinct from the sizing row's allInSelector.
    if offer.get("raise") is not None and offer.get("allInChip", True):
        strip[-1] = (
            f"<div style='display:flex;flex-direction:column;align-items:center;gap:4px'>"
            f"{strip[-1]}"
            f"<div style='width:97.8px;height:24px;border-radius:8px;"
            f"background:rgba(255,255,255,.25);color:#fff;font-size:10px;font-weight:700;"
            f"display:flex;align-items:center;justify-content:center'>ALL-IN</div></div>")
    sel_qa = {"X2.5": "x2.5Selector", "X3": "x3Selector", "X4": "x4Selector",
              "Pot": "potSelector", "1/3 Pot": "third_potSelector",
              "3/4 Pot": "threeQuarter_potSelector", "ALL-IN": "allInSelector"}
    presets = [_button(sel_qa.get(s, f"{s}Selector"), s, "preset")
               for s in offer.get("selectors") or []]

    title = html.escape(spec.get("title") or "$1/$2 No Limit Hold'em")
    pot = _bb(spec.get("potBB"))
    fw, fh = FELT
    # Bar height fits its rows: the action row (76 when the raise column
    # carries its ALL-IN chip, else a plain button row) plus the sizing row
    # above it when the offer has one. The felt keeps ~95du of chrome below
    # the seat container in the client; this is that chrome.
    action_row_h = (ACTION_BAR["raise_h"] + 28 if offer.get("raise") is not None
                    else ACTION_BAR["btn_h"] + 8)
    bar_h = ((action_row_h + (44 if presets else 0) + 16)
             if strip or presets else 0)
    total_h = fh + HEADER_H + bar_h
    ix, iy = SEAT_INSET
    ox_, oy_, ow, oh = OVAL
    px, py, pw, ph = POT_PILL
    felt_bg = FELTS.get(spec.get("theme") or "red", FELTS["red"])

    pot_html = (f"<div style='position:absolute;left:{px}px;top:{py}px;width:{pw}px;"
                f"height:{ph}px;border-radius:9999px;background:{C['pot_bg']};color:#fff;"
                f"font-size:13px;display:flex;align-items:center;justify-content:center'>"
                f"Total pot:&nbsp;<b>{pot}</b></div>") if pot else ""
    mx, my, mw, mh = MAIN_POT_PILL
    main_pot = _bb(spec.get("mainPotBB"))
    main_pot_html = (
        f"<div style='position:absolute;left:{mx}px;top:{my}px;width:{mw}px;"
        f"height:{mh}px;border-radius:9999px;background:{C['pot_bg']};"
        f"color:rgba(255,255,255,.85);font-size:12px;display:flex;align-items:center;"
        f"justify-content:center'>Main pot:&nbsp;<b>{main_pot}</b></div>") if main_pot else ""
    # Hero's own strength label. Rendered in the bottom strip region so the
    # reader's heroHand extraction (rank text in the bottom third of the frame)
    # reads it exactly as it reads the client's.
    strength = spec.get("handStrength")
    strength_html = (
        f"<div style='position:absolute;left:24px;top:{fh + HEADER_H + 22}px;"
        f"color:#e8eded;font-size:14px;z-index:4'>{html.escape(str(strength))}</div>"
        if strength else "")

    return f"""<!doctype html><html><head><meta charset=utf-8>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  html,body {{ margin:0; background:#0b1416; overflow:hidden; }}
  #felt {{ position:relative; width:{fw}px; height:{total_h}px;
           background:{felt_bg}; font-family:Roboto,system-ui,sans-serif;
           user-select:none; }}
  /* The client's own noise tile (.fs9k49k) — the data URI holds single
     quotes, hence a stylesheet rule rather than an inline style attr. */
  #noise {{ position:absolute; inset:0; pointer-events:none;
            background-image:url("{FELT_NOISE}"); }}
</style></head><body>
<div id='felt'>
  <div id='noise'></div>
  <div style='position:absolute;left:{ix}px;top:{HEADER_H + iy}px;width:{DESIGN[0]}px;
       height:{DESIGN[1]}px;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:6px;opacity:.12;pointer-events:none'>
    <img src='/faketable/assets/ign/watermark-flame.svg' style='width:38px'>
    <img src='/faketable/assets/ign/watermark-text.svg' style='width:90px'>
  </div>
  <div style='position:absolute;left:0;right:0;top:0;height:{HEADER_H}px;
       background:rgba(0,0,0,.45);display:flex;align-items:center;padding:0 10px;gap:8px;
       color:rgba(255,255,255,.9);font-size:12px'>
    <span style='opacity:.6'>&#9432;</span><span>{title}</span>
    <span style='margin-left:auto;opacity:.6'>&#10005;</span>
  </div>
  <div data-qa='table' style='position:absolute;left:{ix}px;top:{HEADER_H + iy}px;
       width:{DESIGN[0]}px;height:{DESIGN[1]}px'>
    <div style='position:absolute;left:{ox_}px;top:{oy_}px;width:{ow}px;height:{oh}px;
         border-radius:9999px;border:2px solid {C['oval']};box-sizing:border-box'></div>
    {pot_html}
    {main_pot_html}
    <div style='position:absolute;left:{bx}px;top:{by}px'>{board_html}</div>
    {seat_html}
  </div>
  {strength_html}
  <div style='position:absolute;left:0;right:0;top:{fh + HEADER_H}px;
       height:{bar_h}px;background:rgba(0,0,0,.35);display:flex;
       flex-direction:column;align-items:center;justify-content:center;gap:6px'>
    <div style='display:flex;gap:6px'>{''.join(presets)}</div>
    <div style='display:flex;align-items:flex-start;gap:{ACTION_BAR['gap']}px'>
      {''.join(strip)}
    </div>
  </div>
</div>
<script>
  // Scale to the window the way the client does — CSS zoom, so descendants
  // keep laying out in design units and the reader's geometry stays readable.
  const fit = () => {{ document.getElementById('felt').style.zoom =
      Math.min(1, window.innerWidth / {fw}); }};
  fit(); window.addEventListener('resize', fit);
  // Echo every button click so the relay test can assert what actually fired.
  // Recorded on BOTH windows: the buttons live in this frame, but the CDP
  // page target the reader drives is the top document.
  document.querySelectorAll('button[data-qa]').forEach(b => b.addEventListener('click', () => {{
    const hit = {{ qa: b.getAttribute('data-qa'), text: b.innerText, t: Date.now() }};
    window.__lastClick = hit;
    try {{ window.parent.__lastClick = hit; }} catch (e) {{}}
  }}));
</script>
</body></html>"""


def render_outer(frame_url: str) -> str:
    """The top page: an iframe whose src carries `playMode`, which is how
    _TABLE_JS locates the table frame. `playMode=fun` marks it practice."""
    return f"""<!doctype html><html><head><meta charset=utf-8>
<title>Fake Ignition Table (test)</title>
<style>html,body{{margin:0;height:100%;background:#0b1416}}
iframe{{border:0;width:100%;height:100vh;display:block}}</style>
</head><body>
<iframe src="{html.escape(frame_url)}"></iframe>
</body></html>"""


# CONTRACT-faketable — the spec shape:
#   title, capacity, potBB, board[], heroSeat, dealerSeat, heroCards[],
#   seats { "<num>": {stack, bet, badge, cards, empty} },
#   offer { fold, check, call, bet, raise, selectors[] },
#   node  { dealt[], toActSeat, committed{}, maxBet, actions[] }
EXAMPLE_SPEC = {
    "title": "$1/$2 No Limit Hold'em",
    "capacity": 6,
    "potBB": 24.8,
    "board": ["Tc", "5s", "5h"],
    "heroSeat": 4,
    "dealerSeat": 1,
    "heroCards": ["Th", "Td"],
    "seats": {
        "1": {"stack": 98.6, "bet": 24.8, "badge": "BET", "cards": 2},
        "2": {"stack": 140.4, "cards": 0},
        "3": {"stack": 54.6, "cards": 0},
        "4": {"stack": 97.2, "cards": 2},
        "5": {"stack": 100, "cards": 0},
        "6": {"stack": 84.2, "cards": 0},
    },
    "offer": {"fold": True, "call": 24.8, "raise": 60,
              "selectors": ["Pot", "ALL-IN"]},
    "node": {"toActSeat": 4},
}
