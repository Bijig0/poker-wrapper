"""Fake Ignition table: render a game-state spec as the exact DOM contract the
reader consumes, so the study panel can be tested locally against any state.

This is NOT the replica (that draws a pretty table for human review). This
emits the CLIENT's structural contract — the data-qa hooks and containment
_TABLE_JS keys on — so the wrapper reads a specified state exactly as it reads
real Ignition: same playerContainer-N seats, same playerBalance/myPlayerTag/
holeCards/card<N>, same [data-qa='table'] board, same fold/call/raise buttons.

Two documents, mirroring the client: an OUTER page holding an <iframe> whose
src carries `playMode` (what _TABLE_JS searches for), and the INNER frame
carrying the table itself. Same origin, so contentDocument is readable.

The spec is the single source; the wrapper stores the current one and both
routes render from it. See CONTRACT-faketable below for the shape.
"""
from __future__ import annotations

import html
import json

# Card id = suit*13 + rank, suit c/d/h/s = 0..3, rank A,2..T,J,Q,K = 0..12 —
# the client's own encoding, inverse of launch._card_name.
_RANKS = "A23456789TJQK"
_SUITS = "cdhs"


def display_card(code: str) -> str:
    """"Tc" -> "10♣" — the wrapper's internal display form (_card_name's
    output), which _hand_state shortens back to solver form at the boundary."""
    c = code.strip()
    r = "10" if c[0].upper() == "T" or c.startswith("10") else c[0].upper()
    s = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}[c[-1].lower()] \
        if c[-1].lower() in "shdc" else c[-1]
    return r + s


def encode_card(code: str) -> int:
    """"Ah" -> 26. Accepts "10♥"/"Th"/"AS" forms."""
    c = code.strip().replace("10", "T")
    r = _RANKS.index(c[0].upper())
    suit_ch = {"♠": "s", "♥": "h", "♦": "d", "♣": "c"}.get(c[-1], c[-1].lower())
    s = _SUITS.index(suit_ch)
    return s * 13 + r


def _card_svg(code: str, w: int = 40) -> str:
    """A card element the reader recognises: <svg data-qa='card<N>'>. The inner
    shapes are irrelevant to a structural read; width carries the geometry the
    fallback path and the replica-side classifier still sample."""
    n = encode_card(code)
    h = round(w * 1.5)
    return (f"<svg data-qa='card{n}' width='{w}' height='{h}' "
            f"style='width:{w}px;height:{h}px;display:inline-block'>"
            f"<rect width='{w}' height='{h}' rx='3' fill='#fff'/></svg>")


def _back_svg(w: int = 40) -> str:
    """Face-down card: the hidden sentinel id (-1), still under holeCards so it
    counts toward the seat's card total without leaking identity."""
    h = round(w * 1.5)
    return (f"<svg data-qa='card-1' width='{w}' height='{h}' "
            f"style='width:{w}px;height:{h}px;display:inline-block'>"
            f"<rect width='{w}' height='{h}' rx='3' fill='#356'/></svg>")


def _bb(v) -> str:
    if v is None:
        return ""
    return f"{v:g} BB"


def _seat_html(num: int, s: dict, is_hero: bool, w: int) -> str:
    """One playerContainer-N. `num` is the DISPLAYED seat number (what the WS
    feed and _parse_seats key on); the container index is num-1 for a 1-based
    table, but the reader reads the displayed number from the bare digit, so
    both are emitted consistently."""
    idx = num - 1
    if s.get("empty"):
        return (f"<div data-qa='playerContainer-{idx}' class='seat'>"
                f"<div data-qa='player-empty-seat-panel'>"
                f"<div data-qa='player-empty-seat-label'>Vacant seat</div></div></div>")

    # Hole cards under holeCards hooks: hero shows faces, live villains show
    # backs, folded/empty shows none — matching the renderer's own contract.
    cards = s.get("cards")
    hole = ""
    if is_hero and s.get("heroCards"):
        hole = "".join(
            f"<div data-qa='holeCards'>{_card_svg(c, round(w * 0.9))}</div>"
            for c in s["heroCards"])
    elif cards:
        hole = "".join(
            f"<div data-qa='holeCards'>{_back_svg(round(w * 0.75))}</div>"
            for _ in range(int(cards)))

    bet = s.get("bet")
    bet_html = f"<div class='bet'>{_bb(bet)}</div>" if bet else ""
    badge = s.get("badge")
    badge_html = f"<div class='badge'>{html.escape(str(badge))}</div>" if badge else ""
    tag_open = "<div data-qa='myPlayerTag'>" if is_hero else "<div class='tag'>"

    # Seat number (bare digit) + playerBalance inside the name tag, exactly as
    # the client nests them (textContent of myPlayerTag reads "3245.4 BB").
    return (
        f"<div data-qa='playerContainer-{idx}' class='seat'>"
        f"{tag_open}"
        f"<span class='seatnum'>{num}</span>"
        f"<span data-qa='playerBalance'>{_bb(s.get('stack'))}</span>"
        f"</div>"
        f"{badge_html}{bet_html}"
        f"<div class='hole'>{hole}</div>"
        f"</div>"
    )


def _button(qa: str, label: str) -> str:
    return (f"<button data-qa='{qa}' class='act'>{html.escape(label)}</button>")


def render_inner(spec: dict) -> str:
    """The table frame document: every hook the structural reader consumes."""
    w = 40
    cap = int(spec.get("capacity", 6))
    hero = spec.get("heroSeat")
    seats_in = spec.get("seats", {})

    seat_divs = []
    for num in range(1, cap + 1):
        s = seats_in.get(str(num)) or seats_in.get(num) or {"empty": True}
        if num == hero and spec.get("heroCards"):
            s = {**s, "heroCards": spec["heroCards"]}
        seat_divs.append(_seat_html(num, s, num == hero, w))

    # Board under [data-qa='table'] and under NO seat -> structural board.
    board = spec.get("board") or []
    board_svgs = "".join(_card_svg(c, 51) for c in board)
    placeholders = "".join(
        f"<svg data-qa='card-placeholder' width='51' height='76'></svg>"
        for _ in range(max(0, 5 - len(board))))

    # Action strip: only what the node offers.
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
    for sel in offer.get("selectors") or []:
        qa = {"X2.5": "x2.5Selector", "X3": "x3Selector", "X4": "x4Selector",
              "Pot": "potSelector", "1/3 Pot": "third_potSelector",
              "3/4 Pot": "threeQuarter_potSelector",
              "ALL-IN": "allInSelector"}.get(sel, f"{sel}Selector")
        strip.append(_button(qa, sel))

    title = html.escape(spec.get("title") or "$1/$2 No Limit Hold'em")
    pot = _bb(spec.get("potBB"))

    return f"""<!doctype html><html><head><meta charset=utf-8>
<style>
  body {{ margin:0; font-family:Roboto,system-ui,sans-serif; background:#123; color:#fff; }}
  [data-qa='table'] {{ position:relative; width:800px; height:400px; margin:0 auto; }}
  .title {{ padding:4px 8px; background:rgba(0,0,0,.45); font-size:12px; }}
  .board {{ text-align:center; padding:8px; }}
  .seats {{ display:flex; flex-wrap:wrap; gap:6px; padding:8px; }}
  .seat {{ border:1px solid #345; border-radius:6px; padding:4px 8px; min-width:120px; }}
  .seatnum {{ display:inline-block; width:16px; }}
  .badge {{ font-size:11px; color:#0c9; font-weight:700; }}
  .bet {{ font-size:11px; }}
  .hole svg {{ margin:1px; }}
  .strip {{ position:fixed; bottom:0; left:0; right:0; text-align:center;
            padding:8px; background:rgba(0,0,0,.35); }}
  .act {{ font:inherit; font-weight:700; margin:0 4px; padding:8px 14px;
          border:0; border-radius:8px; background:#0a2233; color:#fff; cursor:pointer; }}
</style></head><body>
<div class='title'>&#9432; {title}</div>
<div data-qa='table'>
  <div class='board'>Total pot: <b>{pot}</b><div>{board_svgs}{placeholders}</div></div>
  <div class='seats'>{''.join(seat_divs)}</div>
</div>
<div class='strip'>{''.join(strip)}</div>
<script>
  // Echo every button click so the relay test can assert what actually fired
  // (act() dispatches a real CDP click at the button's centre). Recorded on
  // BOTH windows: the buttons live in this frame, but the CDP page target the
  // reader drives is the top document, and that is where the test looks.
  document.querySelectorAll('button[data-qa]').forEach(b => b.addEventListener('click', () => {{
    const hit = {{ qa: b.getAttribute('data-qa'), text: b.innerText, t: Date.now() }};
    window.__lastClick = hit;
    try {{ window.parent.__lastClick = hit; }} catch (e) {{ /* same origin, cannot fail */ }}
  }}));
</script>
</body></html>"""


def render_outer(frame_url: str) -> str:
    """The top page: an iframe whose src carries `playMode`, which is how
    _TABLE_JS locates the table frame. `playMode=fun` marks it practice so the
    study path treats it like a play-money table."""
    return f"""<!doctype html><html><head><meta charset=utf-8>
<title>Fake Ignition Table (test)</title>
<style>html,body{{margin:0;height:100%}}iframe{{border:0;width:100%;height:100vh}}</style>
</head><body>
<iframe src="{html.escape(frame_url)}"></iframe>
</body></html>"""


# CONTRACT-faketable — the spec shape (a superset of the render fields; the node
# fields drive Phase 2's /hand and Study Answers, ignored by the DOM render):
#   title, capacity, potBB, board[], heroSeat, dealerSeat, heroCards[],
#   seats { "<num>": {stack, bet, badge, cards, empty} },
#   offer { fold, check, call, bet, raise, selectors[] },
#   node  { positions{}, actions[], street, toCall, ... }   # Phase 2
EXAMPLE_SPEC = {
    "title": "$1/$2 No Limit Hold'em",
    "capacity": 6,
    "potBB": 24.8,
    "board": ["Tc", "5s", "5h"],
    "heroSeat": 4,
    "dealerSeat": 1,
    "heroCards": ["Th", "Td"],
    "seats": {
        "1": {"stack": 98.6, "bet": 24.8, "badge": None, "cards": 2},
        "2": {"stack": 140.4, "cards": 2},
        "3": {"stack": 54.6, "cards": 2},
        "4": {"stack": 97.2, "cards": 2},
        "5": {"stack": 100, "cards": 2},
        "6": {"stack": 84.2, "cards": 2},
    },
    "offer": {"fold": True, "check": True, "bet": 1,
              "selectors": ["1/3 Pot", "3/4 Pot", "Pot", "ALL-IN"]},
}


if __name__ == "__main__":
    # Emit the example inner frame for eyeballing.
    print(render_inner(EXAMPLE_SPEC))
