"""Which table window this wrapper owns, when up to four share one browser.

Ignition allows four tables at once. The wrapper is one process reading one
table — 6,000 lines of module-level state that presses buttons with real money —
so four tables are four PROCESSES, not one process with four of everything. The
alternative is a reader whose failure mode is "acted on the wrong table's
state", which is the worst outcome this codebase has.

They share ONE browser: one `--user-data-dir` means one Chrome process, one
login and one CDP port, with each table in its own app window. So every wrapper
sees all four page targets and has to know which one is its own.

    slot 1  →  panel :7700  →  target A
    slot 2  →  panel :7710  →  target B          one browser, one CDP port,
    slot 3  →  panel :7720  →  target C          four windows, four claims
    slot 4  →  panel :7730  →  target D

A CLAIM is this slot's chosen Chrome targetId, written to data/tables/<slot>.json
and refreshed on every read. A claim is LIVE while it is fresh; a wrapper that
dies stops refreshing and its window is free to be claimed again. Claims are how
two wrappers never read the same window, which no amount of ordering can
guarantee on its own — targets come back from CDP in whatever order Chrome
feels like, and a window that reloads lands somewhere else in the list.

Targets are claimed at the WINDOW level, not the table level: at startup the
windows are lobbies with no table in them yet, and each slot navigates its own
window to its own table afterwards. A Chrome targetId survives navigation within
the tab, so the claim holds from lobby through to sitting down and through every
reload after.

SINGLE TABLE IS UNCHANGED. With no TABLE_SLOT in the environment there is no
claim, no registry and no probing: `pin()` returns the first matching target,
exactly as `ignition_target()` always did.

A CLAIM IS NOT PRESENCE, and conflating the two cost a whole session (2026-09-21).
The claim above answers "which WINDOW is mine"; presence (below) answers "which
TABLES are up". They were one mechanism until the window model was corrected on
2026-09-20: the client turned out to keep all four tables in ONE shared page, so
`pin()` is now only ever called WITHOUT a slot (formats._target,
launch.ignition_target) - claiming the one page would let the first wrapper take
the only client and leave the other three blind. That correction was right, and
it silently emptied `peers()`, which was reading claim files nothing wrote any
more. The leader then fanned every `/session/join` out to nobody: four wrappers
read four tables perfectly and three of them never learned there was a session,
so they sat there with answers off. Nothing errored - `peers()` returning [] is
exactly what a single-table run looks like.

Presence therefore shares no mechanism with claims any more. It ASKS: each slot's
panel port is known (7700/7710/7720/7730), every wrapper serves
`/table/presence` with its own local facts, and a table is up when it answers as
itself. Nothing to write, nothing to expire, nothing left behind by a crash.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLAIM_DIR = ROOT / "data" / "tables"

# A claim not refreshed for this long is treated as abandoned. Generous next to
# the feed loop's ~0.4 s tick: the cost of expiring a live claim too eagerly is
# two wrappers fighting over one window, and the cost of expiring it late is a
# restarted wrapper waiting a few seconds for its own window back.
CLAIM_TTL_S = 20.0

MAX_TABLES = 4          # Ignition's own ceiling
# The counts the session setup offers. Three is deliberately not on the list:
# the tiler splits a screen into halves or quarters, so three tables cost every
# table the quarter-sized window and leave one quarter empty.
TABLE_COUNTS = (1, 2, 4)


def slot() -> int | None:
    """This process's table slot (1-4), or None when it is the only table.

    None is not slot 1: it means "multi-table was never set up here", which is
    what keeps the single-table path byte-for-byte what it was."""
    raw = os.environ.get("TABLE_SLOT")
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        return None
    return n if 1 <= n <= MAX_TABLES else None


def _path(n: int) -> Path:
    return CLAIM_DIR / f"{n}.json"


def read_claims() -> dict[int, dict]:
    """Every slot's claim as written, stale ones included (the caller decides)."""
    out: dict[int, dict] = {}
    try:
        if not CLAIM_DIR.exists():
            return out
        for p in CLAIM_DIR.glob("*.json"):
            try:
                n = int(p.stem)
            except ValueError:
                continue
            try:
                out[n] = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue            # a half-written claim is no claim
    except Exception:
        pass
    return out


def taken_by_others(me: int, now: float | None = None) -> set[str]:
    """Target ids other LIVE slots hold. Stale claims are not holdings."""
    now = time.time() if now is None else now
    out: set[str] = set()
    for n, c in read_claims().items():
        if n == me:
            continue
        tid = c.get("targetId")
        if tid and now - (c.get("at") or 0) <= CLAIM_TTL_S:
            out.add(tid)
    return out


def write_claim(me: int, target_id: str, **extra) -> None:
    try:
        CLAIM_DIR.mkdir(parents=True, exist_ok=True)
        rec = {"slot": me, "targetId": target_id, "at": time.time(), "pid": os.getpid(), **extra}
        tmp = _path(me).with_suffix(".tmp")
        tmp.write_text(json.dumps(rec), encoding="utf-8")
        tmp.replace(_path(me))      # atomic: a reader never sees half a claim
    except Exception:
        pass                        # a claim that cannot be written is not fatal


def release(me: int) -> None:
    """Give the window up — on a clean stand-down, so a restart reclaims it at once."""
    try:
        _path(me).unlink(missing_ok=True)
    except Exception:
        pass


def pin(targets: list[dict], rank, me: int | None = None, **extra) -> dict | None:
    """The target THIS slot owns, out of every page target on the browser.

    `targets` is cdp.page_targets(port). `rank(url) -> int | None` says whether a
    page is a candidate at all (None = no) and how much it is preferred (lower
    first) — the table page over the lobby, say.

    RANK, NOT A SEQUENCE OF CALLS. The obvious shape — try the table pages, then
    the lobby pages, then anything — is wrong here, because each call would be free
    to claim: a slot whose own window is still on the lobby, asked first about table
    pages, would find its claim missing from that narrower list and claim a window
    that belongs to another slot. It has to decide once, over everything it could
    accept, with preference expressed as ordering rather than as separate attempts.

    With no slot this is the first-ranked match — the original single-table
    behaviour, and no claim is written. With a slot: keep the claimed window if it
    is still a candidate, otherwise take the best-ranked one no other live slot
    holds. Returns None rather than borrowing another slot's window; reading the
    wrong table is worse than reading no table, and the wrapper already knows how
    to say "no table".
    """
    ranked = [(r, i, t) for i, t in enumerate(targets)
              if (r := rank((t.get("url") or ""))) is not None]
    ranked.sort(key=lambda x: (x[0], x[1]))     # preference, then CDP's own order
    cands = [t for _, _, t in ranked]
    if me is None:
        return cands[0] if cands else None
    claims = read_claims()
    mine = (claims.get(me) or {}).get("targetId")
    if mine:
        held = next((t for t in cands if t.get("id") == mine), None)
        if held is not None:
            write_claim(me, mine, **extra)      # refresh: this slot is alive
            return held
    others = taken_by_others(me)
    free = next((t for t in cands if t.get("id") and t.get("id") not in others), None)
    if free is None:
        return None
    write_claim(me, free["id"], **extra)
    return free


# ---- one wrapper presses at a time -------------------------------------------
#
# The original reason for this lock was window visibility, and it was wrong along
# with the window model it came from. The REAL reason is worse, and it survived
# the correction (2026-09-20):
#
# ALL FOUR TABLES ARE ONE PAGE, and a click is not one CDP call — it is three
# (`mouseMoved`, `mousePressed`, `mouseReleased`; scout/cdp._dispatch_click).
# Four wrapper processes dispatch those to the SAME target over their own
# sockets, so without a lock they interleave:
#
#     table 1:  moved(a) pressed(a)
#     table 3:            moved(b) pressed(b)
#     table 1:                      released(a)
#
# and the page has been told to press at (a), move to (b) and release at (a) —
# a drag, or a click somewhere nobody asked for, with real money on both tables.
# The three events have to be one uninterrupted turn. It also still covers the
# Buy-chips panel, which is modal over its table.
#
# A press is never DROPPED for want of the lock. Waiting forever to be polite costs
# a hand — hero is on a clock — so a wait that times out proceeds anyway and says so.
# The window is short (a bringToFront and a click, ~100-300 ms), so a genuine wait is
# rare and brief.
PRESS_LOCK = CLAIM_DIR / "press.lock"
PRESS_TTL_S = 5.0       # a holder older than this is wedged or dead; take it
PRESS_WAIT_S = 2.0      # how long to wait before pressing anyway


class _NullLock:
    """No slot, no multi-table, no lock, no file I/O — today's single-table path."""
    waited = 0.0
    forced = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class PressLock:
    """Cross-process mutex over the shared browser's windows."""

    def __init__(self, timeout_s: float = PRESS_WAIT_S):
        self.timeout_s = timeout_s
        self.waited = 0.0
        self.forced = False
        self._held = False

    def __enter__(self) -> "PressLock":
        start = time.time()
        while True:
            if self._take():
                self._held = True
                break
            held = self._holder()
            if held is not None and time.time() - held > PRESS_TTL_S:
                self._break_stale()
                continue
            if time.time() - start >= self.timeout_s:
                self.forced = True      # press anyway: a missed press costs a hand
                break
            time.sleep(0.02)
        self.waited = round(time.time() - start, 3)
        return self

    def __exit__(self, *exc) -> bool:
        if self._held:
            try:
                PRESS_LOCK.unlink(missing_ok=True)
            except Exception:
                pass
            self._held = False
        return False

    def _take(self) -> bool:
        try:
            CLAIM_DIR.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(PRESS_LOCK), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        except Exception:
            return True             # a lock we cannot create must not block a press
        try:
            os.write(fd, json.dumps({"pid": os.getpid(), "at": time.time()}).encode())
        finally:
            os.close(fd)
        return True

    def _holder(self) -> float | None:
        try:
            return json.loads(PRESS_LOCK.read_text(encoding="utf-8")).get("at")
        except Exception:
            return None

    def _break_stale(self) -> None:
        try:
            PRESS_LOCK.unlink(missing_ok=True)
        except Exception:
            pass


def press_lock(timeout_s: float = PRESS_WAIT_S):
    """Serialize a press against the other tables — a no-op when there is only one."""
    return PressLock(timeout_s) if slot() is not None else _NullLock()


# `registry()` used to live here, reading the claim files above and calling that
# the list of tables. It is under "presence" now, and asks the tables themselves —
# see the note at the top of this module for what that cost to find out.


# ---- where each slot's windows go --------------------------------------------
#
# Overlapping windows are not untidiness here, they are a CORRECTNESS problem:
# Chrome parks synthetic CDP input on a hidden page, so while the windows cover
# each other a press depends on who called bringToFront last (press_lock above is
# the belt to this brace, and it presses anyway rather than miss a decision). Four
# windows that never cover each other make the question go away.
#
# The layout is computed from the DECLARED table count, not from how many slots
# happen to be up: a layout that shifts as slots start, die and restart would move
# the felt under the mouse, and target_area() in launch.py carries the same
# reasoning for the same reason.
#
# ONE TABLE IS UNCHANGED: n <= 1 gives exactly the old rectangle — table on the
# left TABLE_FRAC of the monitor, panel down the right-hand strip.

TABLE_FRAC = 0.7        # single-table split, matching launch.TABLE_FRAC


def count() -> int:
    """How many tables this run declared.

    From the environment, because that is what a spawned slot inherits: the
    leader sets it on itself and passes it to every table it opens, so all of
    them compute the same tiling. The SESSION is where the number comes from
    (config `tables`, chosen on the setup page); the environment is only how it
    travels between processes."""
    try:
        n = int(os.environ.get("TABLE_COUNT") or "1")
    except ValueError:
        return 1
    return n if n in TABLE_COUNTS else max(1, min(MAX_TABLES, n))


def adopt(n: int) -> int:
    """Become table 1 of `n`, or go back to being the only table.

    A wrapper launched on its own has NO slot, and that is the point — the
    single-table path takes none of the claim, lock or tiling code. But the
    setup page can ask for four tables at Start, and from that moment this
    process is table 1 of four and has to pick its own window out of the list
    like everybody else. `slot()` reads the environment on every call, so
    setting it here is enough; the panel's window and title were fixed at
    startup and do not need to change (the leader keeps the unsuffixed title,
    which is what the followers' suffixes are distinguished FROM).

    Asking for one table again gives the claim back and restores the plain
    single-table path."""
    n = n if n in TABLE_COUNTS else 1
    os.environ["TABLE_COUNT"] = str(n)
    if n > 1:
        os.environ["TABLE_SLOT"] = str(LEADER)
    else:
        me = slot()
        if me is not None:
            release(me)
        os.environ.pop("TABLE_SLOT", None)
    return n


def grid(i: int, n: int, area: dict) -> dict:
    """Cell `i` (0-based) of an n-cell grid over `area`. Physical pixels.

    1 → the whole area; 2 → two columns; 3 and 4 → a 2x2 (three tables leave the
    fourth cell empty rather than stretching one, so adding the fourth table
    later does not move the first three)."""
    cols = 1 if n <= 1 else 2
    rows = 1 if n <= 2 else 2
    cx, cy = i % cols, i // cols
    w, h = area["w"] // cols, area["h"] // rows
    # the last column/row takes the rounding, so the tiles always cover the screen
    return {"x": area["x"] + cx * w, "y": area["y"] + cy * h,
            "w": area["w"] - cx * w if cx == cols - 1 else w,
            "h": area["h"] - cy * h if cy == rows - 1 else h}


def client_rect(n: int, area: dict) -> dict:
    """Where the ONE poker client window goes, in physical pixels.

    ONE TABLE: the old 70/30 split, unchanged - the client on the left of the
    table monitor and this wrapper's panel down the strip beside it, which is the
    setup that has always worked and carries the most hands.

    SEVERAL: the WHOLE monitor. The panels have moved to the other screen by then
    (panel_rect), so there is nothing left to make room for, and every pixel given
    back to the client is pixels its own tiler gives to the tables. At 2 tables on
    a 2560-wide screen that is 1280 per table instead of 896. The window is then
    also put FULLSCREEN (launch._want_fullscreen), which takes the title bar and
    the taskbar strip as well; this rectangle is where it is placed first, since
    Chrome fullscreens onto the monitor the window is already on.

    THERE IS ONE CLIENT WINDOW, NOT N. `table_rect(slot, n, area)` used to live
    here and tiled the monitor into a rectangle PER TABLE - a leftover of the
    window model that was corrected on 2026-09-20, when the client turned out to
    keep all four tables inside a single page and tile them itself. Nothing in the
    wrapper had called its multi-table branch since (every caller passed 1, 1),
    but it was still there to be called, and the last time something did the
    leader shrank the client to a quarter, the client tiled again inside that, and
    a press aimed at table 1 computed into table 3's frame."""
    if n <= 1:
        return {"x": area["x"], "y": area["y"], "w": int(area["w"] * TABLE_FRAC), "h": area["h"]}
    return {"x": area["x"], "y": area["y"], "w": area["w"], "h": area["h"]}


def panel_rect(slot_n: int, n: int, area: dict, other: dict | None) -> dict:
    """Where slot `slot_n`'s PANEL belongs.

    One table: the strip beside it, as it has always been. More than one: the
    tables take the whole table monitor, so the panels go to the OTHER screen,
    tiled the same way — and when there is no other screen they share the table
    monitor's grid cell, overlapping their own table and nobody else's (a panel
    is read, never clicked through CDP, so covering one's own felt costs
    legibility and not a press)."""
    if n <= 1:
        tw = int(area["w"] * TABLE_FRAC)
        return {"x": area["x"] + tw, "y": area["y"], "w": area["w"] - tw, "h": area["h"]}
    return grid(max(1, min(n, slot_n)) - 1, n, other or area)


# ---- who is in charge --------------------------------------------------------
#
# Four tables are four processes, but they are ONE session: Brady declares it
# once and every table joins it, rather than four setup pages each declaring
# their own (which is what the code did until 2026-09-20 — four open sessions in
# sessions.sqlite, four opening balance readings on one account, four rows in the
# dashboard for one sitting).
#
# The LEADER is slot 1, by definition rather than by election. It is the slot
# that launches the browser and owns its debugger, so it is the one that always
# exists when anything else does; an election between peers that can each be
# restarted at any moment buys nothing here and can split.

LEADER = 1

# TWO NUMBERINGS, and they are off by one on purpose.
#
#   wrapper slot   1..4   what Brady sees ("table 3"), what picks the panel port
#   client slot    0..3   the client's own `data-multitableslot` on the iframe
#
# The client owns the second one and we do not get to choose it; the first is
# human-facing and predates knowing about the second. Converting in ONE place
# beats every reader remembering to subtract one — which is precisely the kind
# of thing that reads table 2 while believing it is table 3.

def dom_slot(me: int | None = None) -> int | None:
    """This wrapper's table as an ORDINAL among the client's table frames, or
    None for the single-table path.

    It used to mean "our `data-multitableslot` value", i.e. the client's own
    number, and the resolver looked that value up literally. Live on 2026-09-21
    the leader's lookup for 0 matched nothing while slot 2's for 1 matched a
    table, so whatever base that build tags from, it is not the one we assumed --
    and the leader spent a whole session with no frame, no hero seat, no bound
    capture socket and "no hand in progress" on its panel. We do not need the
    client's numbers, only its ORDER: the resolver sorts the tagged table frames
    by their own tag and takes the Nth (launch._FRAME_JS)."""
    me = slot() if me is None else me
    return None if me is None else me - 1


def is_leader() -> bool:
    """True for slot 1 — and for the single-table setup, which leads itself."""
    me = slot()
    return me is None or me == LEADER


def leader_port(base: int | None = None, step: int | None = None) -> int:
    """Panel port of the slot that declares the session (run-tables.pyw's map)."""
    return panel_port(LEADER, base, step)


# ---- presence: which tables are actually up ----------------------------------
#
# ONE QUESTION, ASKED DIRECTLY. Every wrapper already serves an HTTP panel on a
# port derived from its slot, so "is table 3 up?" is a request to :7720 - not a
# file whose freshness has to be modelled. A dead wrapper stops answering the
# instant it dies, a restarted one answers again the instant it is back, and a
# crash leaves nothing behind to sweep.
#
# IDENTITY IS CHECKED, NEVER ASSUMED. A port is not an identity: the test rig
# uses these same four ports, and a leftover process from an earlier run can be
# sitting on one. So the answer has to say it is that slot AND that it belongs to
# this rig. What this prevents is not cosmetic - it is a real-money session
# fanning `/session/join` out to a fake table, which would then relay picks
# nobody made into a rig that looks exactly like the real one.

PANEL_BASE, PANEL_STEP = 7700, 10
PRESENCE_PATH = "/table/presence"
# The hot path (the panel's 1 Hz /state) never waits for a probe: it reads the
# last snapshot and kicks a refresh off behind it when that one has gone stale.
# Correctness-critical callers ask for a fresh answer explicitly (live_peers).
PRESENCE_TTL_S = 3.0
PROBE_TIMEOUT_S = 0.8


def panel_port(slot_n: int, base: int | None = None, step: int | None = None) -> int:
    """The panel port slot `slot_n` serves on. The map, in one place.

    Reads the module globals at CALL time rather than freezing them as defaults,
    so moving the block moves every caller — and so the tests can run four real
    wrappers on ports of their own instead of reaching for :7700, which on this
    machine is a live session with money on it."""
    return ((PANEL_BASE if base is None else base)
            + (PANEL_STEP if step is None else step) * (slot_n - 1))


def rig() -> str:
    """Which rig this process belongs to: the live wrapper, or the test rig.

    Both use the same four ports, so this is what keeps them from finding each
    other (see the note above)."""
    return "fake" if os.environ.get("FAKE_TABLE") == "1" else "live"


def presence_record(port: int, sid: str | None = None) -> dict:
    """What a wrapper answers `/table/presence` with: local facts only.

    No peer I/O of any kind. Four wrappers each asking the other three at 1 Hz
    is nothing; four wrappers whose answer to "are you there" is itself three
    more questions is a storm, and on a slow tick a circular wait."""
    return {"ok": True, "slot": slot(), "panelPort": port, "rig": rig(),
            "pid": os.getpid(), "count": count(), "sid": sid, "at": time.time()}


def probe(slot_n: int, timeout: float = PROBE_TIMEOUT_S) -> dict | None:
    """Ask slot `slot_n` whether it is up. None = not up, or not who it claims."""
    port = panel_port(slot_n)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{PRESENCE_PATH}", timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception:
        return None
    if not isinstance(d, dict) or d.get("slot") != slot_n or d.get("rig") != rig():
        return None
    return {"slot": slot_n, "panelPort": port, "pid": d.get("pid"),
            "count": d.get("count"), "sid": d.get("sid"), "at": time.time()}


_presence: dict = {"at": 0.0, "rows": [], "probing": False}
_presence_lock = threading.Lock()


def _self_row(now: float) -> dict:
    """This process's own row, from local facts rather than a loopback call to
    ourselves - which would come back empty for the second or two before our own
    server is listening, and show this table as missing from its own strip."""
    me = slot()
    return {"slot": me, "panelPort": panel_port(me), "pid": os.getpid(),
            "count": count(), "at": now, "me": True}


def refresh_presence(timeout: float = PROBE_TIMEOUT_S) -> list[dict]:
    """Probe every OTHER slot now, in parallel, and remember what answered.

    In parallel because a dead port fails fast but a wedged one does not: three
    in series could cost three timeouts, and this runs on the path that starts a
    session."""
    me = slot()
    if me is None:
        with _presence_lock:
            _presence.update({"at": time.time(), "rows": [], "probing": False})
        return []
    rows: list[dict] = []
    threads = []

    def go(k: int) -> None:
        if (r := probe(k, timeout)) is not None:
            rows.append(r)

    for k in range(1, MAX_TABLES + 1):
        if k == me:
            continue
        t = threading.Thread(target=go, args=(k,), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout + 0.5)
    rows.sort(key=lambda r: r["slot"])
    with _presence_lock:
        _presence.update({"at": time.time(), "rows": rows, "probing": False})
    return rows


def _refresh_bg() -> None:
    try:
        refresh_presence()
    except Exception:
        with _presence_lock:
            _presence["probing"] = False


def registry(now: float | None = None) -> list[dict]:
    """Every table of this session and whether it is answering - the strip.

    NEVER BLOCKS. It renders on the panel's 1 Hz tick, so it reads the last
    snapshot and starts a refresh behind it once that is stale; a wedged peer
    costs a stale row, never a frozen panel.

    A table the session DECLARED but which is not answering keeps a row, with
    `live: False`, rather than vanishing. A strip that silently shrinks from four
    rows to one is how three tables sat there saying nothing for a whole session
    without anyone noticing."""
    me = slot()
    if me is None:
        return []                       # single table: nothing to give an overview of
    now = time.time() if now is None else now
    with _presence_lock:
        rows, at = list(_presence["rows"]), _presence["at"]
        kick = (now - at) > PRESENCE_TTL_S and not _presence["probing"]
        if kick:
            _presence["probing"] = True
    if kick:
        threading.Thread(target=_refresh_bg, daemon=True).start()
    seen = {r["slot"]: r for r in rows if r.get("slot") != me}
    seen[me] = _self_row(now)
    declared = count()
    out = []
    for k in range(1, MAX_TABLES + 1):
        r = seen.get(k)
        if r is not None:
            out.append({**r, "live": True, "ageS": round(max(0.0, now - r["at"]), 1)})
        elif k <= declared:
            out.append({"slot": k, "panelPort": panel_port(k), "live": False,
                        "ageS": round(max(0.0, now - at), 1) if at else None})
    return out


def peers(now: float | None = None) -> list[dict]:
    """The OTHER tables that are up, in slot order - from the cached snapshot.

    For anything where a stale answer is merely a stale answer (the overview
    strip). Use `live_peers()` wherever it would be a WRONG one."""
    me = slot()
    return [r for r in registry(now) if r.get("live") and r.get("slot") != me]


def live_peers(timeout: float = PROBE_TIMEOUT_S) -> list[dict]:
    """The other tables that are up RIGHT NOW - probed, not remembered.

    Every instruction the leader fans out goes to this list: a session start, a
    join, a leave. Missing a table here does not degrade a display, it leaves a
    real table out of the session, so the extra half second of probing is the
    cheapest part of starting one."""
    me = slot()
    if me is None:
        return []
    return [r for r in refresh_presence(timeout) if r["slot"] != me]


# ---- physical pixels vs the browser's ----------------------------------------
#
# Windows lays the desktop out in PHYSICAL pixels (what monitors() measures);
# Chrome places windows in DIP, where every monitor is divided by its own
# scaling. On a single-DPI desktop those two differ by one constant and you can
# get away with dividing. On a MIXED one you cannot: a laptop at 200% occupying
# physical 0..2880 takes DIP 0..1440, so the screen to its right starts at DIP
# 1440 while its physical origin is 2880.
#
# Dividing the absolute coordinate by the destination monitor's scale therefore
# put the right-hand column of tables at DIP 4160 on a desktop that ends at
# 4000 — off the edge, producing no frames, and Chrome parks synthetic clicks on
# a page that is not rendering. The relay refused them (correctly, loudly), but
# two of four tables were simply unusable. Found 2026-09-20.
#
# The conversion has to carry each monitor's own ORIGIN as well as its scale.

def dip_layout(mons: list[dict]) -> list[dict]:
    """Each monitor with its DIP rect alongside its physical one.

    Windows scales each monitor about the desktop origin, so a monitor's DIP
    origin is the sum of the DIP sizes of the monitors between it and the
    origin. `scale` must already be on each monitor (the caller knows the DPI)."""
    out = []
    for m in mons:
        sc = float(m.get("scale") or 1.0) or 1.0
        left = [o for o in mons if o["x"] < m["x"]]
        above = [o for o in mons if o["y"] < m["y"]]
        out.append({**m, "scale": sc,
                    "dipX": sum(round(o["w"] / (float(o.get("scale") or 1.0) or 1.0)) for o in left),
                    "dipY": sum(round(o["h"] / (float(o.get("scale") or 1.0) or 1.0)) for o in above),
                    "dipW": round(m["w"] / sc), "dipH": round(m["h"] / sc)})
    return out


def to_dip(rect: dict, mons: list[dict]) -> dict:
    """A PHYSICAL rect as Chrome's DIP rect. Falls back to the rect unchanged
    when no monitor contains it — a wrong guess is worse than no conversion."""
    lay = dip_layout(mons)
    host = next((m for m in lay
                 if m["x"] <= rect["x"] < m["x"] + m["w"] and m["y"] <= rect["y"] < m["y"] + m["h"]), None)
    if host is None:
        return dict(rect)
    sc = host["scale"]
    return {"x": host["dipX"] + round((rect["x"] - host["x"]) / sc),
            "y": host["dipY"] + round((rect["y"] - host["y"]) / sc),
            "w": round(rect["w"] / sc), "h": round(rect["h"] / sc)}
