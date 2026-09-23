"""Which window is whose, when four tables share one browser.

No browser and no CDP: `pin()` is pure given a target list, so every rule it has
can be tripped here. The one that matters is the last: a slot whose window is
gone returns None rather than borrowing another slot's, because reading the
wrong table is worse than reading no table.

Run:  aof-model/.venv/Scripts/python.exe tests/test_tables.py
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import tables  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAILS.append(label)


# claims go to a scratch directory, never the real data/tables
TMP = Path(tempfile.mkdtemp(prefix="tables-test-"))
tables.CLAIM_DIR = TMP

# rank(): None = not a candidate, lower = preferred. Table pages beat lobby pages.
def IS_TABLE(u):
    low = u.lower()
    return 1 if "poker-game" in low else 2 if "ignition" in low else None
T = [{"id": "A", "url": "https://ignition/static/poker-game/?t=1"},
     {"id": "B", "url": "https://ignition/static/poker-game/?t=2"},
     {"id": "C", "url": "https://ignition/static/poker-game/?t=3"},
     {"id": "D", "url": "https://ignition/static/poker-game/?t=4"},
     {"id": "P", "url": "http://127.0.0.1:7700/panel"}]


def reset() -> None:
    for p in TMP.glob("*.json"):
        p.unlink()


# ------------------------------------------------------------ the slot
print("slot()")
for raw, want in (("", None), ("1", 1), ("4", 4), ("0", None), ("5", None), ("x", None)):
    if raw:
        os.environ["TABLE_SLOT"] = raw
    else:
        os.environ.pop("TABLE_SLOT", None)
    check(f"TABLE_SLOT={raw!r} → {want}", tables.slot() == want, repr(tables.slot()))
os.environ.pop("TABLE_SLOT", None)

# ------------------------------------------------------------ single table
# The path Brady runs today: no slot, no claim, no file touched.
print("no slot — the single-table path is untouched")
reset()
check("takes the first match", (tables.pin(T, IS_TABLE, None) or {}).get("id") == "A")
check("  ... and writes no claim", not list(TMP.glob("*.json")), str(list(TMP.glob("*.json"))))
check("no candidates → None", tables.pin([T[-1]], IS_TABLE, None) is None)

# ------------------------------------------------------------ claiming
print("claims")
reset()
a = tables.pin(T, IS_TABLE, 1)
b = tables.pin(T, IS_TABLE, 2)
c = tables.pin(T, IS_TABLE, 3)
d = tables.pin(T, IS_TABLE, 4)
got = [(x or {}).get("id") for x in (a, b, c, d)]
check("four slots take four different windows", len(set(got)) == 4 and None not in got, str(got))
check("  ... and each wrote a claim", len(list(TMP.glob("*.json"))) == 4)

# the ordering CDP returns is not stable; a claim is what makes a slot's window its own
shuffled = [T[2], T[0], T[3], T[1], T[4]]
check("a claim survives the target list being reordered",
      (tables.pin(shuffled, IS_TABLE, 1) or {}).get("id") == got[0],
      f"{(tables.pin(shuffled, IS_TABLE, 1) or {}).get('id')} != {got[0]}")
check("  ... for every slot",
      [(tables.pin(shuffled, IS_TABLE, n) or {}).get("id") for n in (1, 2, 3, 4)] == got)

# ------------------------------------------------------------ never borrow
print("a lost window is never borrowed")
reset()
tables.pin(T, IS_TABLE, 1)      # slot 1 claims A
tables.pin(T, IS_TABLE, 2)      # slot 2 claims B
only_a = [T[0], T[4]]           # slot 2's window is gone; only slot 1's is left
check("slot 2 gets None rather than slot 1's window", tables.pin(only_a, IS_TABLE, 2) is None)
check("  ... and slot 1 still has its own", (tables.pin(only_a, IS_TABLE, 1) or {}).get("id") == "A")

# ------------------------------------------------------------ expiry
print("a dead wrapper's window comes back")
reset()
tables.pin(T, IS_TABLE, 1)
claims = tables.read_claims()
stale = dict(claims[1]); stale["at"] = time.time() - tables.CLAIM_TTL_S - 5
(TMP / "1.json").write_text(__import__("json").dumps(stale), encoding="utf-8")
check("a stale claim is not a holding", tables.taken_by_others(2) == set(), str(tables.taken_by_others(2)))
check("  ... so another slot may take that window",
      (tables.pin([T[0], T[4]], IS_TABLE, 2) or {}).get("id") == "A")
check("a fresh claim IS a holding", tables.taken_by_others(1) == {"A"}, str(tables.taken_by_others(1)))

print("release")
reset()
tables.pin(T, IS_TABLE, 1)
tables.release(1)
check("a released window is free at once", tables.taken_by_others(2) == set())

# THE BUG THIS SHAPE EXISTS FOR (caught before it ever ran): rank, not a sequence of
# calls. Slot 1 is still on the lobby while slot 2 has sat down. Asked first about table
# pages only, slot 1 would not find its claim in that narrower list — and would claim
# slot 2's table. One pin over everything it could accept cannot do that.
print("a slot on the lobby never steals a seated slot's table")
reset()
LOBBY_1 = {"id": "A", "url": "https://ignition.eu/poker/lobby"}
TABLE_2 = {"id": "B", "url": "https://ignition.eu/static/poker-game/?t=2"}
mixed = [TABLE_2, LOBBY_1, T[4]]
check("slot 1 claims the lobby window it is on",
      (tables.pin([LOBBY_1, T[4]], IS_TABLE, 1) or {}).get("id") == "A")
check("slot 2 claims the table window", (tables.pin(mixed, IS_TABLE, 2) or {}).get("id") == "B")
check("slot 1 KEEPS its lobby even though a table page ranks higher",
      (tables.pin(mixed, IS_TABLE, 1) or {}).get("id") == "A",
      str((tables.pin(mixed, IS_TABLE, 1) or {}).get("id")))
check("  ... and slot 2 still has the table", (tables.pin(mixed, IS_TABLE, 2) or {}).get("id") == "B")
# once slot 1's own window loads its table, the claim follows it — same window, same id
SEATED_1 = {"id": "A", "url": "https://ignition.eu/static/poker-game/?t=1"}
check("a claim follows its window from lobby to table",
      (tables.pin([SEATED_1, TABLE_2, T[4]], IS_TABLE, 1) or {}).get("id") == "A")

print("preference ordering")
reset()
check("a table page is preferred to a lobby page on a FIRST claim",
      (tables.pin([LOBBY_1, TABLE_2], IS_TABLE, 1) or {}).get("id") == "B")
reset()
check("  ... and with no slot at all", (tables.pin([LOBBY_1, TABLE_2], IS_TABLE, None) or {}).get("id") == "B")
check("the panel is never a candidate", tables.pin([T[4]], IS_TABLE, None) is None)

print("a claim is not presence")
# THE 2026-09-21 BUG, PINNED FROM THIS SIDE. registry()/peers() used to BE the
# claim files, and when the window-model correction left `pin()` always called
# without a slot (the four tables share one page), nothing wrote a claim ever
# again — so the leader's peer list went quietly empty and it fanned every
# `/session/join` out to nobody. The two questions are now answered by different
# mechanisms on purpose, and this is the assertion that keeps them apart: a claim
# on disk must never, by itself, make a table look present. Presence is asked
# over HTTP and proved in tests/test_presence.py.
reset()
os.environ.pop("TABLE_SLOT", None)
tables.pin(T, IS_TABLE, 1, panelPort=7700)
tables.pin(T, IS_TABLE, 2, panelPort=7710)
check("two claims are written", len(list(TMP.glob("*.json"))) == 2,
      str([p.name for p in TMP.glob("*.json")]))
check("  ... and NOTHING is present because of them", tables.registry() == [] and tables.peers() == [],
      str(tables.registry()))

# ------------------------------------------------------------ the press lock
# CDP injects input per TARGET, so two tables clicking at once are not two hands on one
# mouse. What they share is visibility: bringToFront for one window can hide another's,
# and Chrome parks synthetic input on a hidden page.
print("press_lock")
reset()
tables.PRESS_LOCK = TMP / "press.lock"

os.environ.pop("TABLE_SLOT", None)
with tables.press_lock() as lk:
    check("single table: no lock, no file", not tables.PRESS_LOCK.exists() and lk.waited == 0)

os.environ["TABLE_SLOT"] = "2"
with tables.press_lock() as lk:
    check("multi-table: the lock is held", tables.PRESS_LOCK.exists())
    check("  ... uncontended, so no wait", lk.waited < 0.5, str(lk.waited))
check("  ... and released on the way out", not tables.PRESS_LOCK.exists())

# a press is never DROPPED for want of the lock: hero is on a clock
held = tables.PressLock()
held.__enter__()
t0 = time.time()
with tables.press_lock(timeout_s=0.2) as lk:
    check("a contended press waits", 0.15 <= time.time() - t0 < 1.5, str(round(time.time() - t0, 2)))
    check("  ... then presses anyway rather than missing the decision", lk.forced is True)
held.__exit__()

# a wedged or killed holder must not lock the table out forever
tables.PRESS_LOCK.write_text(__import__("json").dumps(
    {"pid": 999999, "at": time.time() - tables.PRESS_TTL_S - 1}), encoding="utf-8")
with tables.press_lock(timeout_s=1.0) as lk:
    check("a stale holder is broken, not waited on", lk.forced is False and lk.waited < 0.5, str(lk.waited))

# the shape raise_to needs: type under one lock, confirm under act()'s own
os.environ["TABLE_SLOT"] = "1"
with tables.press_lock():
    pass
with tables.press_lock(timeout_s=0.2) as lk:
    check("sequential locks do not block each other", lk.forced is False)
os.environ.pop("TABLE_SLOT", None)

# ---- the tiles ---------------------------------------------------------------
print("\nlayout")
EXT = {"x": 2880, "y": 0, "w": 2560, "h": 1504, "primary": False}
LAP = {"x": 0, "y": 0, "w": 2880, "h": 1704, "primary": True}

# ONE CLIENT WINDOW, sized by how many tables are going inside it. `table_rect`
# — a rectangle PER TABLE — is gone with the window model it came from: the
# client keeps all four tables in one page and tiles them itself, every caller
# had been passing (1, 1) for a year, and the last time anything used its
# multi-table branch the leader shrank the client to a quarter, the client tiled
# again inside that, and a press aimed at table 1 landed in table 3's frame.
check("table_rect is gone, not merely unused", not hasattr(tables, "table_rect"))

# ONE TABLE IS UNCHANGED: the old 70/30 split, to the pixel
one = tables.client_rect(1, EXT)
check("one table keeps the old rectangle", one == {"x": 2880, "y": 0, "w": 1792, "h": 1504}, str(one))
check("  ... with the panel down the strip beside it",
      tables.panel_rect(1, 1, EXT, LAP) == {"x": 4672, "y": 0, "w": 768, "h": 1504})

# SEVERAL: the whole monitor. The panels have gone to the other screen by then,
# so the strip beside the client is pixels nothing is using — and every one of
# them the client gives back to the tables.
for n in (2, 4):
    full = tables.client_rect(n, EXT)
    check(f"{n} tables give the client the WHOLE monitor",
          full == {"x": 2880, "y": 0, "w": 2560, "h": 1504}, str(full))
check("  ... which is wider per table than the single-table strip ever was",
      tables.client_rect(2, EXT)["w"] // 2 > tables.client_rect(1, EXT)["w"] // 2)
check("  ... and it does not spill off the monitor",
      tables.client_rect(4, EXT)["x"] + tables.client_rect(4, EXT)["w"] == EXT["x"] + EXT["w"])


def overlaps(a, b):
    return (a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"]
            and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"])


# the client takes one screen, the panels the other — they must not fight
check("the client and the panels are not on the same pixels",
      not overlaps(tables.client_rect(2, EXT), tables.panel_rect(1, 2, EXT, LAP)),
      f"{tables.client_rect(2, EXT)} vs {tables.panel_rect(1, 2, EXT, LAP)}")
check("  ... and the panels never overlap each other",
      not overlaps(tables.panel_rect(1, 2, EXT, LAP), tables.panel_rect(2, 2, EXT, LAP)))

# panels go to the OTHER screen when the tables have taken this one
check("panels tile the other screen once there is more than one table",
      tables.panel_rect(2, 4, EXT, LAP) == tables.grid(1, 4, LAP))
check("  ... and fall back to the table monitor when there is no other",
      tables.panel_rect(2, 4, EXT, None) == tables.grid(1, 4, EXT))

# the declared count, not the live one — a layout that shifts as slots come and
# go would move the felt mid-hand
os.environ["TABLE_COUNT"] = "4"
check("the count comes from the environment", tables.count() == 4)
os.environ["TABLE_COUNT"] = "9"
check("  ... clamped to Ignition's ceiling", tables.count() == tables.MAX_TABLES)
os.environ.pop("TABLE_COUNT", None)
check("  ... and defaults to one", tables.count() == 1)

# ---- physical pixels vs Chrome's DIP, on a MIXED-DPI desktop -----------------
print("\ndip conversion")
# Brady's real setup: laptop 2880x1704 @200% at the origin, external 2560x1552
# @100% to its right. Physical x=2880 is the external's left edge; in DIP the
# laptop only takes 1440, so the external starts at 1440 and NOT at 2880.
MIX = [{"x": 0, "y": 0, "w": 2880, "h": 1704, "scale": 2.0},
       {"x": 2880, "y": 0, "w": 2560, "h": 1552, "scale": 1.0}]
lay = {m["x"]: m for m in tables.dip_layout(MIX)}
check("the primary starts at the DIP origin", (lay[0]["dipX"], lay[0]["dipW"]) == (0, 1440), str(lay[0]))
check("the screen to its right starts where the primary's DIP ENDS",
      (lay[2880]["dipX"], lay[2880]["dipW"]) == (1440, 2560), str(lay[2880]))

ext = {"x": 2880, "y": 0, "w": 2560, "h": 1552}
# a 2x2 of that screen — grid(), which is what tiles the PANELS now that the
# client takes its monitor whole. What is under test here is to_dip, not the grid.
tiles = [tables.grid(i, 4, ext) for i in (0, 1, 2, 3)]
dips = [tables.to_dip(t, MIX) for t in tiles]
check("a 2x2 of that screen converts to its DIP cells",
      [(d["x"], d["y"], d["w"], d["h"]) for d in dips] ==
      [(1440, 0, 1280, 776), (2720, 0, 1280, 776), (1440, 776, 1280, 776), (2720, 776, 1280, 776)],
      str([(d["x"], d["y"]) for d in dips]))
# the bug this exists for: the naive divide put the right column at 4160 on a
# desktop that ends at 4000, where Chrome renders no frames and parks clicks
right_edge = lay[2880]["dipX"] + lay[2880]["dipW"]
check("  ... every tile lands ON the desktop", all(d["x"] + d["w"] <= right_edge for d in dips),
      f"desktop ends at {right_edge}, tiles end at {[d['x'] + d['w'] for d in dips]}")
check("  ... which the naive divide did not", not all(round(t["x"] / 1.0) + t["w"] <= right_edge for t in tiles))

# a single-DPI desktop must be unchanged by all this
SAME = [{"x": 0, "y": 0, "w": 1920, "h": 1080, "scale": 1.0}]
check("one screen at 100% converts to itself",
      tables.to_dip({"x": 100, "y": 50, "w": 800, "h": 600}, SAME) == {"x": 100, "y": 50, "w": 800, "h": 600})
check("a rect on no known screen is left alone",
      tables.to_dip({"x": 9999, "y": 0, "w": 10, "h": 10}, SAME) == {"x": 9999, "y": 0, "w": 10, "h": 10})

print()
print("the client window: strip at one table, the whole monitor fullscreen at several")
EXT = {"x": 2880, "y": 0, "w": 2560, "h": 1552}
one, two = tables.client_rect(1, EXT), tables.client_rect(2, EXT)
check("one table keeps the 70/30 split", (one["w"], one["h"]) == (int(2560 * tables.TABLE_FRAC), 1552), str(one))
check("two tables take the monitor whole", (two["x"], two["w"], two["h"]) == (2880, 2560, 1552), str(two))
check("  ... and four do too (the client tiles inside it)", tables.client_rect(4, EXT) == two)

import launch  # noqa: E402  — the fullscreen POLICY is the wrapper's, the rectangle is ours
_other = launch.other_area
try:
    launch.other_area = lambda: {"x": 0, "y": 0, "w": 2880, "h": 1704}   # a second screen for the panels
    launch.TABLE_FULLSCREEN = "multi"
    check("one table is never fullscreen (its panel is in the strip beside it)", launch._want_fullscreen(1) is False)
    check("two and four are", launch._want_fullscreen(2) and launch._want_fullscreen(4))
    launch.other_area = lambda: None                                      # one screen: the panels share the felt
    check("  ... but not on a single-screen desktop — that would cover the panels",
          launch._want_fullscreen(4) is False)
    launch.TABLE_FULLSCREEN = "always"
    check("TABLE_FULLSCREEN=always overrides both", launch._want_fullscreen(1) and launch._want_fullscreen(4))
    launch.TABLE_FULLSCREEN = "never"
    launch.other_area = lambda: {"x": 0, "y": 0, "w": 2880, "h": 1704}
    check("TABLE_FULLSCREEN=never overrides the other way", launch._want_fullscreen(4) is False)
finally:
    launch.other_area = _other
    launch.TABLE_FULLSCREEN = "multi"

shutil.rmtree(TMP, ignore_errors=True)
print()
if FAILS:
    print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
    sys.exit(1)
print("all passed")
