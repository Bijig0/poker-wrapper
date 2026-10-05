"""Shared helpers: GTO Wizard combo order, hand classes, a fast board-relative hand category, the off-tree detector.

GTO Wizard order: card = rank*4 + suit (ranks 23456789TJQKA, suits c d h s); combo(a<b) = b(b-1)/2 + a.
"""
from __future__ import annotations
import numpy as np

RANKS = "23456789TJQKA"
SUITS = "cdhs"


def card_idx(c: str) -> int:
    return RANKS.index(c[0].upper()) * 4 + SUITS.index(c[1].lower())


def combo_idx(c1: str, c2: str) -> int:
    a, b = sorted((card_idx(c1), card_idx(c2)))
    return b * (b - 1) // 2 + a


COMBOS = []   # combo index -> (card a, card b), a < b
for b in range(52):
    for a in range(b):
        COMBOS.append((a, b))
COMBO_A = np.array([x[0] for x in COMBOS])
COMBO_B = np.array([x[1] for x in COMBOS])


def class169(i: int) -> str:
    a, b = COMBOS[i]
    ra, rb = a // 4, b // 4
    if ra == rb:
        return RANKS[ra] * 2
    hi, lo = max(ra, rb), min(ra, rb)
    return RANKS[hi] + RANKS[lo] + ("s" if a % 4 == b % 4 else "o")


CLASS169 = [class169(i) for i in range(1326)]
GRID = [[None] * 13 for _ in range(13)]   # row/col 0 = A
for r in range(13):
    for cc in range(13):
        hi, lo = 12 - min(r, cc), 12 - max(r, cc)
        GRID[r][cc] = RANKS[hi] * 2 if r == cc else (RANKS[hi] + RANKS[lo] + ("s" if r < cc else "o"))
CLASS_INDEX = {GRID[r][c]: r * 13 + c for r in range(13) for c in range(13)}
COMBO_CELL = np.array([CLASS_INDEX[c] for c in CLASS169])


def blocked_mask(cards: list[int]) -> np.ndarray:
    """True for combos that share a card with `cards`."""
    m = np.zeros(1326, dtype=bool)
    for c in cards:
        m |= (COMBO_A == c) | (COMBO_B == c)
    return m


def to_grid(range1326: np.ndarray) -> list[float]:
    """169 cells (row-major, AA top-left): combos of weight in each cell."""
    g = np.zeros(169)
    np.add.at(g, COMBO_CELL, range1326)
    return g.tolist()


# ---- hand category on a board (fast, hole-card contribution only) ----
# 0 air · 1 draw (flush draw or open-ender, no pair) · 2 weak pair (middle/bottom/under) · 3 top pair / overpair ·
# 4 strong (two pair with both hole cards, set/trips, straight, flush, full house+ that use a hole card)
CAT_NAMES = ["air", "draw", "weak pair", "top pair/overpair", "two pair+"]


def _straight_ranks(rset: set[int]) -> bool:
    s = set(rset)
    if 12 in s:
        s.add(-1)
    for lo in range(-1, 9):
        if all(r in s for r in range(lo, lo + 5)):
            return True
    return False


def category(h1: int, h2: int, board: list[int]) -> int:
    br = [c // 4 for c in board]
    bs = [c % 4 for c in board]
    r1, r2 = h1 // 4, h2 // 4
    s1, s2 = h1 % 4, h2 % 4
    allr = br + [r1, r2]
    alls = bs + [s1, s2]
    cnt = {}
    for r in allr:
        cnt[r] = cnt.get(r, 0) + 1
    bcnt = {}
    for r in br:
        bcnt[r] = bcnt.get(r, 0) + 1
    # flush using a hole card
    for s in range(4):
        if alls.count(s) >= 5 and (s1 == s or s2 == s):
            return 4
    # straight using a hole card
    if _straight_ranks(set(allr)) and not _straight_ranks(set(br)):
        return 4
    # sets / trips / boats with a hole card
    if cnt[r1] >= 3 or cnt[r2] >= 3:
        return 4
    top = max(br)
    if r1 == r2:   # pocket pair
        return 3 if r1 > top else 2
    p1, p2 = bcnt.get(r1, 0) >= 1, bcnt.get(r2, 0) >= 1
    if p1 and p2:
        return 4
    if p1 or p2:
        pr = r1 if p1 else r2
        return 3 if pr == top else 2
    if len(board) < 5:
        for s in range(4):
            if alls.count(s) == 4 and (s1 == s or s2 == s):
                return 1
        rs = set(allr)
        outs = 0
        for r in range(13):
            if r in rs:
                continue
            if _straight_ranks(rs | {r}) and not _straight_ranks(set(br) | {r}):
                outs += 1
        if outs >= 2:
            return 1
    return 0


_CAT_CACHE: dict = {}


def categories(board: list[int]) -> np.ndarray:
    key = tuple(board)
    v = _CAT_CACHE.get(key)
    if v is None:
        bm = blocked_mask(board)
        v = np.full(1326, -1, dtype=np.int8)
        for i, (a, b) in enumerate(COMBOS):
            if not bm[i]:
                v[i] = category(a, b, board)
        _CAT_CACHE[key] = v
    return v


def parse_board(s: str) -> list[int]:
    import re
    return [card_idx(c) for c in re.findall(r"[2-9TJQKA][cdhs]", s, flags=re.I)]


# ---- the off-tree detector (services/offTree.ts) + the dust fix ----
OFF_TREE_NODE_FREQ = 0.01
OFF_TREE_MAX_HAND = 0.02
DUST = 0.01   # a combo under 1% of the range's largest weight does not vote in maxHand


def off_tree_stats(rng: np.ndarray, strat_taken: np.ndarray, dust: bool = True):
    w = rng.sum()
    node = float((rng * strat_taken).sum() / w) if w > 0 else 0.0
    live = rng > (DUST * rng.max() if dust and rng.max() > 0 else 0)
    mx = float(strat_taken[live].max()) if live.any() else 0.0
    return node, mx


def is_off_tree(node: float, mx: float) -> bool:
    return node < OFF_TREE_NODE_FREQ and mx < OFF_TREE_MAX_HAND
