"""Ignition assistive panel — accessible play for a user with limited mobility.

The panel mirrors the poker client beside it: a large-print live feed of the
hand, the current state, and big accessible buttons for the actions the client
is currently offering. Pressing one relays that press to the client's own
button. The user decides every action; this only carries the press, the way an
eye tracker or switch interface would.

One command opens the whole demo:

  - a Chrome app-mode window at Ignition (left, ~70% of the work area), launched
    with --remote-debugging-port so CDP can read it — no screen capture APIs
  - the study panel beside it (right), a second Chrome app-mode window pointed
    at this script's local panel server

The panel is a placeholder for the assistive-play live feed. What it already
does, via CDP against the table window:
  - shows connection status (CDP up? Ignition page found?)
  - shows a live screenshot mirror of the table page (the future OCR source)
  - "Dump DOM sample" — extracts visible text nodes from every frame, to answer
    THE phase-1 question: is Ignition's web client DOM-readable (like
    CoinPoker's was), or canvas-rendered (OCR path needed)?

Run:  launch.cmd    (uses the aof-model venv python)

Env overrides: IGNITION_URL, CDP_PORT (9333), PANEL_PORT (7700), PANEL_PUBLIC_URL, CHROME_EXE,
TABLE_FRAC (0.70 = table share of work-area width at ONE table),
TABLE_FULLSCREEN (multi = the client fills the table monitor from two tables up; always | never).
"""

import ctypes
import ctypes.wintypes

# Window placement is done in PHYSICAL pixels. Without this the process is DPI-
# virtualised (the Zenbook panel runs at 200%, an external monitor at 100%) and
# a MoveWindow aimed at the right-hand strip lands on top of the table instead.
# Must run before the first user32 call.
try:
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))   # PER_MONITOR_AWARE_V2
except Exception:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
import json
from collections import deque
import os
import random
import re
import sqlite3
import subprocess
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "aof-model"))
from scout import cdp  # noqa: E402  (reuses the Windows-validated CDP reader)
import faketable  # noqa: E402  (local fake-Ignition renderer for the state tester)
import sessions as S  # noqa: E402  (declared sessions: presets, preflight, record)
import reconcile as RC  # noqa: E402  (shadow reconciler: the line from the table's levels)
import terminal as TERMINAL  # noqa: E402  (the terminal-action family: after which press hero has no further decision)
import formats as F  # noqa: E402  (table formats: detect / go-to / leave, formats.json)
import auth as A  # noqa: E402  (login profiles + sign-in driver; passwords in Credential Manager)
import balances as BAL  # noqa: E402  (account balance snapshots; the poker-only-movement rule)
import tables as TABLES  # noqa: E402  (which table window this slot owns, 1-4 sharing one browser)
from sites import coinpoker as CPS  # noqa: E402  (CoinPoker: its log is the reader, the Unity table the buttons)

# WHICH SITE THIS SESSION PLAYS (Poker Wrapper, 2026-09-22). Ignition is read by
# everything in this file; CoinPoker by sites/coinpoker.py. The choice is the
# session's (config.site, from the setup page) and is applied with the rest of
# its config; with no session it is Ignition, which is what this wrapper was.
CP = CPS.Site()
_SITE = {"id": "ignition"}


def _site() -> str:
    return _SITE["id"]


def _is_cp() -> bool:
    return _SITE["id"] == CPS.SITE

# The declared session (sessions.py). Nothing opens until one is started from
# /setup; its id is stamped on every archived hand, carried on /state for the
# answer poller, and used as the debug recording's directory name.
_session = {"id": None, "rec": None, "started": 0.0}
_sessions = S.SessionStore()

# The game-state spec the /faketable routes render. Set via POST /faketable/spec
# by the tester; None falls back to faketable.EXAMPLE_SPEC. _fake_mode marks the
# wrapper as driving the LOCAL fake table: the target search prefers it, the
# archiver refuses authored hands, and the DOM-diff inference stays frozen.
_faketable_spec: dict | None = None
# PER-SLOT fixtures for the rig. With four fake tables in one page, each has to
# be able to hold a DIFFERENT spot — a rig where every frame renders the same
# state cannot tell a reader that scopes correctly from one that reads table 1
# four times. `_faketable_spec` stays the single-table spec and the slot 0 /
# null-slot default, so the existing rig is unchanged.
_faketable_specs: dict[int, dict] = {}


def _fake_spec_for(slot: int | None) -> dict:
    if slot is not None and slot in _faketable_specs:
        return _faketable_specs[slot]
    return _faketable_spec or faketable.EXAMPLE_SPEC
# FAKE_TABLE=1 makes this instance a TEST RIG: the table window opens the local
# fake table instead of Ignition, and everything downstream — reader, /hand,
# relay, the answer poller — runs unchanged against it. That is the whole point:
# the study tools cannot tell the difference, so testing them here tests them.
# Launched on its own ports (see study-tool.pyw) so a real session can run at
# the same time and neither can disturb the other.
_fake_mode = os.environ.get("FAKE_TABLE") == "1"
# WHAT THIS PROCESS IS, as opposed to what it is doing right now. `_fake_mode` is a MODE:
# /faketable/load turns it on, /faketable/stop turns it off, and run_state_suite turns it
# off when it finishes — which used to leave the next rig-side test reporting "not the
# test rig" purely because it ran second. This is the launcher's --fake flag and never
# changes for the life of the process.
_FAKE_RIG = os.environ.get("FAKE_TABLE") == "1"

# Under pythonw (the desktop shortcut) there is no console: sys.stdout is None
# and any print() would crash. Route output to the log file instead.
if sys.stdout is None or sys.stderr is None:
    _log = open(ROOT / "server.log", "a", buffering=1, encoding="utf-8")
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log
# AND A print() MUST NEVER BE ABLE TO KILL ANYTHING (2026-09-21). A wrapper
# spawned with a pipe or a console gets the locale encoding, which on this
# machine is cp1252 -- so every log line in this codebase carrying an arrow, an
# em dash or a suit symbol is a live UnicodeEncodeError. It is not theoretical
# and it is not cosmetic: `formats._goto` logs its steps as it walks the lobby,
# step two is "Cash games -> Start Cash Game" with a real arrow, and the
# exception that raised came back as the SEATING FAILING. The session record
# reads `route-failed: UnicodeEncodeError ... position 18`, table 2 was never
# seated, and a two-table session ran with one table.
for _stream in ("stdout", "stderr"):
    _s = getattr(sys, _stream, None)
    if _s is not None and hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

PANEL_PORT = int(os.environ.get("PANEL_PORT", "7700"))
CDP_PORT = int(os.environ.get("CDP_PORT", "9333"))
IGNITION_URL = os.environ.get("IGNITION_URL", "https://www.ignitioncasino.eu/poker-lobby")
def _default_browser() -> str:
    """Brave if installed (the PWA-style setup used before), else Chrome."""
    local = os.environ.get("LOCALAPPDATA", "")
    for p in (rf"{local}\BraveSoftware\Brave-Browser\Application\brave.exe",
              r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
              r"C:\Program Files\Google\Chrome\Application\chrome.exe"):
        if Path(p).is_file():
            return p
    return "chrome.exe"


CHROME = os.environ.get("CHROME_EXE") or _default_browser()
# scout/cdp.py routes every call through its module-global PORT (default 9223 =
# CoinPoker); pin it here so no code path ever talks to the wrong client.
cdp.PORT = CDP_PORT
# The test rig's side window hosts the full Study Tool (review queue, state
# tester), which needs real width; the live rig's panel is a narrow column.
TABLE_FRAC = float(os.environ.get(
    "TABLE_FRAC", "0.55" if os.environ.get("FAKE_TABLE") == "1" else "0.70"))
# WHEN THE CLIENT FILLS ITS MONITOR OUTRIGHT (no title bar, no taskbar strip).
#   multi (default) — from two tables up, where the panels have moved to the other
#                     screen and nothing else is on the table monitor to make room for
#   always / never  — force it either way (TABLE_FULLSCREEN=always|never|multi)
# One table keeps the 70/30 split: the panel lives in the strip beside the felt there,
# and a fullscreen client would cover it.
TABLE_FULLSCREEN = (os.environ.get("TABLE_FULLSCREEN") or "multi").strip().lower()


def _want_fullscreen(n: int) -> bool:
    if TABLE_FULLSCREEN in ("never", "0", "off", "false"):
        return False
    if TABLE_FULLSCREEN in ("always", "1", "on", "true"):
        return True
    # ONLY WHEN THE PANELS HAVE SOMEWHERE ELSE TO BE. With a second screen the
    # panels tile on it and the table monitor is the client's alone; on a
    # one-screen machine they share the table monitor's grid cells, and a
    # fullscreen client would cover the very thing that shows the answers.
    return n > 1 and other_area() is not None
# Per-rig browser profiles and window title. A shared profile dir puts both
# rigs' windows in ONE Chrome process, where --window-position/--window-size and
# the CDP port stop sticking; a shared title makes each panel's
# bring-to-front surface the other rig's window.
_RIG = "-fake" if os.environ.get("FAKE_TABLE") == "1" else ""
# MULTI-TABLE: the TABLE profile is deliberately NOT per-slot. One profile is one Chrome
# process, which is one login and one CDP port — exactly what four tables need, and the
# reason the caveat above (flags not sticking) is a price worth paying: placement is
# applied by window handle afterwards anyway (_place_when_shown). The PANEL profile IS
# per-slot, or four panels share one process and each panel's bring-to-front raises
# whichever window Chrome feels like.
_SLOT = os.environ.get("TABLE_SLOT") or ""
PROFILE_TABLE = f".profile-table{_RIG}"
# an extra CoinPoker panel opened from the admin page carries a tag ("#2") — in its title (below) and its profile
_TAG = os.environ.get("PANEL_TAG") or ""
PROFILE_PANEL = (f".profile-panel{_RIG}{('-' + _SLOT) if _SLOT else ''}"
                 + (f"-t{''.join(ch for ch in _TAG if ch.isalnum())}" if _TAG else ""))
# the CoinPoker LEADER window (the admin page), opened by the main panel for a CoinPoker session
PROFILE_LEADER = f".profile-leader{_RIG}"
# The panel window is found by its TITLE (_wrapper_windows), so with four
# wrappers up the title has to say which slot it belongs to — otherwise slot 1
# surfaces, moves or tiles slot 3's panel. The page files carry the base title;
# _slot_title() stamps the slot on the way out (_send_page).
# "Poker Wrapper" since it plays more than Ignition (2026-09-22; was "Ignition Study").
# an extra CoinPoker panel's tag ("#2", above) goes in its title too, for the same reason
PANEL_TITLE = ("Poker Wrapper Tool" if _RIG else "Poker Wrapper") + (f" {_SLOT}" if _SLOT else "") + (f" {_TAG}" if _TAG else "")


def work_area() -> tuple[int, int]:
    """Usable desktop size (excludes the taskbar)."""
    r = ctypes.wintypes.RECT()
    ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(r), 0)
    return r.right - r.left, r.bottom - r.top


class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.wintypes.DWORD),
                ("rcMonitor", ctypes.wintypes.RECT),
                ("rcWork", ctypes.wintypes.RECT),
                ("dwFlags", ctypes.wintypes.DWORD)]


def monitors() -> list[dict]:
    """Work areas of all attached monitors (primary flagged)."""
    out: list[dict] = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                               ctypes.POINTER(ctypes.wintypes.RECT), ctypes.c_ssize_t)

    def cb(hmon, _hdc, _rect, _lp):
        mi = _MONITORINFO()
        mi.cbSize = ctypes.sizeof(_MONITORINFO)
        ctypes.windll.user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
        r, f = mi.rcWork, mi.rcMonitor
        # rcWork is the desktop (taskbar excluded) — every window we place lives in
        # it. fw/fh are the SCREEN, which is what a fullscreen window covers: the
        # only place that number is needed is saying what the tables will get.
        out.append({"x": r.left, "y": r.top, "w": r.right - r.left,
                    "h": r.bottom - r.top, "primary": bool(mi.dwFlags & 1),
                    "fw": f.right - f.left, "fh": f.bottom - f.top})
        return 1

    ctypes.windll.user32.EnumDisplayMonitors(None, None, proto(cb), 0)
    return out


def target_area() -> dict:
    """The monitor the app should occupy.

    THE EXTERNAL SCREEN WHENEVER ONE IS ATTACHED (Brady, 2026-09-19), falling back to
    the laptop panel when it is not. `STUDY_MONITOR=primary|external|cursor` overrides
    ("secondary" is accepted as a synonym for external).

    This is deliberately a rule that does not depend on the moment it is asked. It was
    `cursor` — the monitor the MOUSE is on — from 2026-09-13, after the original
    "secondary if attached" put every window on the other screen and read as "the icons
    open off-screen and I can't get them back". But `cursor` is re-read independently at
    five points over the first few seconds of a launch (here, the panel surface, the
    table window, and two delayed apply_layout timers), so moving the mouse during setup
    dragged the windows to the other screen mid-way: of thirteen identical launches on
    2026-09-19, twelve landed on the laptop panel and one on the external, with nothing
    different but where the pointer happened to be. A deterministic rule cannot drift
    between those five calls, which is also what four tiled tables need.

    "External" = the non-primary monitor, which is the laptop-as-primary setup this runs
    on. If the external is ever made Windows' PRIMARY display, that inverts — set
    STUDY_MONITOR=primary in that case."""
    mons = monitors() or [{"x": 0, "y": 0, "w": 1440, "h": 852, "primary": True}]
    want = (os.environ.get("STUDY_MONITOR") or "external").lower()
    if want == "primary":
        return next((m for m in mons if m["primary"]), mons[0])
    if want == "cursor":
        try:
            pt = ctypes.wintypes.POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            for m in mons:
                if m["x"] <= pt.x < m["x"] + m["w"] and m["y"] <= pt.y < m["y"] + m["h"]:
                    return m
        except Exception:
            pass
        return next((m for m in mons if m["primary"]), mons[0])
    # external / secondary (the default): the non-primary screen, else the only one there is
    ext = [m for m in mons if not m["primary"]]
    return ext[0] if ext else next((m for m in mons if m["primary"]), mons[0])


def _wrapper_windows() -> tuple[int | None, int | None]:
    """(table hwnd, panel hwnd) — Brave windows only, matched by title."""
    found: list[tuple[int, str]] = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, _lp):
        if not ctypes.windll.user32.IsWindowVisible(h):
            return 1
        n = ctypes.windll.user32.GetWindowTextLengthW(h)
        if not n:
            return 1
        buf = ctypes.create_unicode_buffer(n + 1)
        ctypes.windll.user32.GetWindowTextW(h, buf, n + 1)
        # Only OUR windows: verify the owning process is brave.exe.
        pid = ctypes.wintypes.DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        hp = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid.value)
        if hp:
            sz = ctypes.wintypes.DWORD(1024)
            exe = ctypes.create_unicode_buffer(sz.value)
            ctypes.windll.kernel32.QueryFullProcessImageNameW(hp, 0, exe, ctypes.byref(sz))
            ctypes.windll.kernel32.CloseHandle(hp)
            # the Ignition table page ("…Ignition…") or one of our panels ("Poker Wrapper…")
            if exe.value.lower().endswith("brave.exe") and ("ignition" in buf.value.lower()
                                                            or buf.value.startswith("Poker Wrapper")):
                found.append((h, buf.value))
        return 1

    ctypes.windll.user32.EnumWindows(proto(cb), 0)
    # The panel is THIS rig's title (the test rig's is "Ignition Study Tool");
    # anything else with "ignition" in it is the table. Matching the live
    # title only made the test rig take its own panel for the table and pin
    # both windows on the same rectangle — the fully covered table page then
    # reported visibilityState=hidden and every relayed click hung (2026-09-13).
    other_panel = "Poker Wrapper Tool" if PANEL_TITLE == "Poker Wrapper" else "Poker Wrapper"
    # MULTI-TABLE: every table window carries the same title, so "the one that is
    # not my panel" picks an arbitrary slot's felt — and every other slot's PANEL
    # looks like a table too. There is no title that can answer this, so with a
    # slot set the table is simply not looked for here: it is addressed by its
    # claimed CDP target instead (place_client_window).
    table = None if TABLES.slot() is not None else next(
        (h for h, t in found if not _is_panel_title(t, PANEL_TITLE) and not _is_panel_title(t, other_panel)
         and not t.startswith("Poker Wrapper")), None)      # never another wrapper's panel (tagged, slotted, the rig's)
    panel = next((h for h, t in found if _is_panel_title(t, PANEL_TITLE)), None)
    return table, panel


def _is_panel_title(title: str, base: str) -> bool:
    """The panel window's title is the PAGE title: "Ignition Study" on the
    panel, "Ignition Study · Session setup" on setup, "Ignition Study ·
    Analysis" in analysis mode. An exact match missed the setup page, so
    every icon click during setup opened one more window (two "Session setup"
    windows side by side, 2026-09-13). The test rig's "Ignition Study Tool"
    must not match the live rig's base, hence the separator."""
    return title == base or title.startswith(base + " · ") or title.startswith(base + " - ")


_layout_last: dict = {}


def _layout_note() -> dict | None:
    """The last measured table geometry, and whether it is too small to press in.
    Cheap: it is whatever place_client_window() last measured, never a probe."""
    return _layout_last or None


def _slot_title(html: bytes) -> bytes:
    """Stamp this slot on the page title, so the panel window can be told from
    the other slots' (see PANEL_TITLE). A no-op for the single-table setup —
    the bytes are returned exactly as they were read."""
    if not _SLOT and not _TAG:
        return html
    base = b"<title>Poker Wrapper Tool" if _RIG else b"<title>Poker Wrapper"
    suffix = (f" {_SLOT}" if _SLOT else "") + (f" {_TAG}" if _TAG else "")
    return html.replace(base, base + suffix.encode(), 1)


def _panel_hwnd() -> int | None:
    """This rig's panel window, whatever page it is showing."""
    return _wrapper_windows()[1]


def _window_rect(hwnd: int) -> tuple[int, int, int, int]:
    r = ctypes.wintypes.RECT()
    ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def other_area() -> dict | None:
    """The monitor the tables are NOT on — where the panels go once there are
    several of them. None when this machine has one screen."""
    tgt = target_area()
    return next((m for m in monitors() if (m["x"], m["y"]) != (tgt["x"], tgt["y"])), None)


def _browser_ws(port: int) -> str | None:
    """The BROWSER-level debugger socket (not a page's). Window geometry lives
    there: Browser.getWindowForTarget / Browser.setWindowBounds."""
    if not cdp._listening(port):        # a closed port costs 2 s to refuse on Windows
        return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
            return json.loads(r.read())["webSocketDebuggerUrl"]
    except Exception:
        return None


def _set_window_bounds(target_id: str, rect: dict, port: int, fullscreen: bool = False) -> dict | None:
    """Move the window holding `target_id` to `rect` (PHYSICAL pixels).

    `fullscreen` then asks Chrome to fill that monitor outright — no title bar,
    no taskbar strip, which is what a table monitor with nothing else on it
    should give the felt (several tables: the panels are on the other screen).
    The bounds are still set first, because fullscreen goes to the monitor the
    window is ON: place it, then fill.

    Placing the table window by CDP rather than by window handle is not a
    refinement, it is the only thing that works with four of them: every table
    window carries the same title, so _wrapper_windows() — which matches on
    title — cannot tell slot 1's felt from slot 4's and would move whichever it
    met first. A targetId is exactly this slot's window, by construction: it is
    the claim (tables.py).

    Browser.setWindowBounds speaks LOGICAL (DIP) pixels, while monitors() and
    MoveWindow speak physical ones — the same split that put a window at x=5760
    on a 5440-wide desktop in 2026-09-12. Scale by the DPI of the monitor the
    window is going TO, as chrome_window already does for its flags."""
    ws_url = _browser_ws(port)
    if not ws_url:
        return None
    # PHYSICAL -> DIP, carrying each monitor's ORIGIN as well as its scale. On a
    # mixed-DPI desktop those are different questions: a laptop at 200% taking
    # physical 0..2880 takes DIP 0..1440, so the screen beside it starts at DIP
    # 1440 while its physical origin is 2880. Dividing the absolute coordinate
    # put the right-hand column of tables at DIP 4160 on a desktop ending at
    # 4000 — off the edge, rendering nothing, and Chrome parks synthetic clicks
    # on a page producing no frames, so two of four tables could not be pressed
    # (2026-09-20). tables.to_dip does the conversion properly.
    d = TABLES.to_dip(rect, [{**m, "scale": _dpi_at(m["x"] + 10, m["y"] + 10) / 96.0} for m in monitors()])
    bounds = {"left": d["x"], "top": d["y"], "width": d["w"], "height": d["h"]}
    try:
        import websocket  # the scout's dependency, already on the path
        ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
        try:
            ws.send(json.dumps({"id": 1, "method": "Browser.getWindowForTarget",
                                "params": {"targetId": target_id}}))
            win = None
            for _ in range(20):
                msg = json.loads(ws.recv())
                if msg.get("id") == 1:
                    win = (msg.get("result") or {}).get("windowId")
                    break
            if win is None:
                return None
            # ALREADY FULLSCREEN IS ALREADY RIGHT. apply_layout runs on every
            # window open, retry and re-seat; dropping the client out of
            # fullscreen and back on each of those would flash the felt — and
            # does it mid-hand.
            ws.send(json.dumps({"id": 2, "method": "Browser.getWindowBounds",
                                "params": {"windowId": win}}))
            cur = {}
            for _ in range(20):
                msg = json.loads(ws.recv())
                if msg.get("id") == 2:
                    cur = ((msg.get("result") or {}).get("bounds")) or {}
                    break
            if fullscreen and cur.get("windowState") == "fullscreen":
                return {**bounds, "windowState": "fullscreen", "unchanged": True}
            # a window left maximized or minimized ignores a bounds change, so
            # normalise first — the same trap MoveWindow has (_place_when_shown)
            ws.send(json.dumps({"id": 3, "method": "Browser.setWindowBounds",
                                "params": {"windowId": win, "bounds": {"windowState": "normal"}}}))
            ws.send(json.dumps({"id": 4, "method": "Browser.setWindowBounds",
                                "params": {"windowId": win, "bounds": bounds}}))
            for _ in range(20):
                if json.loads(ws.recv()).get("id") == 4:
                    break
            if fullscreen:
                # windowState is set ON ITS OWN: Chrome rejects a bounds change that
                # carries a state with any of left/top/width/height beside it.
                ws.send(json.dumps({"id": 5, "method": "Browser.setWindowBounds",
                                    "params": {"windowId": win, "bounds": {"windowState": "fullscreen"}}}))
                for _ in range(20):
                    if json.loads(ws.recv()).get("id") == 5:
                        break
                bounds = {**bounds, "windowState": "fullscreen"}
        finally:
            ws.close()
        return bounds
    except Exception as e:
        print(f"[layout] setWindowBounds failed for {target_id[:12]}: {e}")
        return None


def place_client_window() -> dict | None:
    """Put the ONE poker client window where it belongs. Leader only.

    There is a single client window however many tables are open — the client
    tiles its tables INSIDE it — so this places that window at the table
    rectangle and lets the client do the rest. It used to give each slot a
    quarter of the screen, which with one shared window meant the leader shrank
    the client to a quarter and the tables inside it were tiled again within
    that: the action rows fell outside their own frames and a press aimed at
    table 1 computed into table 3's frame (2026-09-20).

    By CDP rather than by window handle: the title tells us nothing useful now
    that every panel is a Brave window too, and the page target is exact."""
    if TABLES.slot() is not None and not TABLES.is_leader():
        return None                      # the client is the leader's to place
    t = ignition_target()
    if not t or not t.get("id"):
        return None
    # One window; its size is the only thing we choose. Several tables take the
    # whole monitor (the panels are on the other screen by then), one keeps the
    # 70/30 split it has always had.
    n = TABLES.count()
    rect = TABLES.client_rect(n, target_area())
    full = _want_fullscreen(n)
    got = _set_window_bounds(t["id"], rect, CDP_PORT, fullscreen=full)
    if got and not got.get("unchanged"):
        print(f"[layout] client window {got['width']}x{got['height']} at ({got['left']},{got['top']}) DIP"
              + (" — FULLSCREEN on the table monitor" if full else "")
              + " — the client tiles its own tables inside it")
    return got


_cp_snap = {"room": None}      # the CoinPoker table the panel last went beside (auto-snap: once per table)


def _snap_panel_to_cp_table() -> dict:
    """COINPOKER: put the PANEL beside the table — the table itself is never moved (2026-09-23).

    You place and size the table; the reader does not care where it is (the log is the reader), and a press
    computes its buttons from wherever the table is at that moment. So the panel follows the table: same
    monitor, the side with room (right first), the table's height, the strip width the Ignition layout uses
    (or the panel's own width if you have set one that fits). A table on another virtual desktop cannot be
    reached — Windows lets no program move another's window between desktops — so that is said, not done."""
    from sites import cp_actions as CPA
    u = ctypes.windll.user32
    t = CP.table()
    if not t:
        return {"ok": False, "why": "no CoinPoker table open yet — sit down in the client"}
    h = CPA.table_window(t["room"])
    if not h:
        return {"ok": False, "why": "the table's window was not found"}
    if CPA.cloaked(h):
        return {"ok": False, "why": CPA.OTHER_DESKTOP}
    if u.IsIconic(h):
        return {"ok": False, "why": "the table is minimised — restore it, then press again"}
    panel = _wrapper_windows()[1]
    if not panel:
        return {"ok": False, "why": "the panel window was not found"}
    r = ctypes.wintypes.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    cx, cy = (r.left + r.right) // 2, (r.top + r.bottom) // 2
    mons = monitors()
    area = next((m for m in mons if m["x"] <= cx < m["x"] + m["w"] and m["y"] <= cy < m["y"] + m["h"]),
                mons[0] if mons else None)
    if not area:
        return {"ok": False, "why": "no monitor found"}
    p = ctypes.wintypes.RECT()
    u.GetWindowRect(panel, ctypes.byref(p))
    cur_w = p.right - p.left
    strip = area["w"] - int(area["w"] * TABLE_FRAC)
    want = cur_w if int(area["w"] * 0.18) <= cur_w <= int(area["w"] * 0.45) else strip
    right = area["x"] + area["w"] - r.right
    left = r.left - area["x"]
    floor = int(area["w"] * 0.15)                    # narrower than this the panel is unreadable
    if right >= want:
        side, x, w = "right", r.right, want
    elif left >= want:
        side, x, w = "left", r.left - want, want
    elif max(right, left) >= floor:
        side = "right" if right >= left else "left"
        w = max(right, left)
        x = r.right if side == "right" else area["x"]
    else:
        return {"ok": False, "why": f"no room beside the table on its screen — make the table narrower or move it "
                                    f"to one side (the panel needs about {want}px)"}
    y = max(r.top, area["y"])
    ht = min(r.bottom, area["y"] + area["h"]) - y
    if ht < int(area["h"] * 0.5):                    # a short table: the panel still gets the full height
        y, ht = area["y"], area["h"]
    if u.IsZoomed(panel) or u.IsIconic(panel):
        u.ShowWindow(panel, 9)
    u.MoveWindow(panel, x, y, w, ht, True)
    _, _, cw, ch = CPA.client_rect(h)
    ratio = (cw / ch) if ch else 0
    ref = CPA.REF_W / CPA.REF_H
    shape_ok = bool(ratio) and abs(ratio / ref - 1) <= 0.04
    _cp_snap["room"] = t["room"]
    return {"ok": True, "side": side, "panel": {"x": x, "y": y, "w": w, "h": ht},
            "table": {"room": t["room"], "client": [cw, ch], "shapeOk": shape_ok},
            "monitor": area, "monitors": len(mons),
            **({} if shape_ok else {"note": f"the table is {cw}x{ch}, a different shape from the layout the buttons "
                                             f"were measured on ({CPA.REF_W}x{CPA.REF_H}) — if a press is refused, "
                                             f"resize the table closer to that shape"})}


# ---- CoinPoker: several panels, one admin page (2026-09-23) --------------------------------------------------
# Each panel is its own wrapper process attached to one table. The main one is :7700; the admin page opens more on
# 7720-7739 (tag "#2".., CDP 9340+ — unused by CoinPoker, but every instance needs its own), each running a session
# that copies the main panel's strategy with its own cpTable. The admin page (served by any panel, /admin) finds
# the panels by probing those ports, and moves / opens / ends them through ITS OWN server (no cross-port fetches).
ADMIN_PORTS = [7700] + list(range(7720, 7740))


def _listening(ports: list[int]) -> set[int]:
    """Which of these ports something listens on. Asked of the OS, not by connecting: on Windows a connect to a
    CLOSED localhost port takes 2 s to fail, so probing the 21 admin ports by connecting took ~40 s."""
    try:
        import psutil
        return {c.laddr.port for c in psutil.net_connections("tcp")
                if c.status == "LISTEN" and c.laddr and c.laddr.port in ports}
    except Exception:
        return set(ports)


def _panel_probe(port: int) -> dict | None:
    if port != PANEL_PORT and port not in _listening([port]):
        return None
    if port == PANEL_PORT:
        s = state(light=True)
    else:
        try:
            # 5 s: a panel's own /state can spend 2 s on a closed CDP port (no Ignition window up)
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/state?light=1", timeout=5) as r:
                s = json.loads(r.read())
        except Exception:
            return None
    t = s.get("table") or {}
    return {"port": port, "tag": s.get("panelTag") or ("main" if port == 7700 else f":{port}"), "site": s.get("site"),
            "sessionId": s.get("sessionId"), "attached": (s.get("coinpoker") or {}).get("attached"),
            "table": t.get("room"), "label": t.get("label"), "heroSeated": t.get("heroSeated"),
            "answers": s.get("studyAnswers"), "me": port == PANEL_PORT}


def _admin_state() -> dict:
    # this page's own panel always counts (a spare or test instance runs outside ADMIN_PORTS); probed in parallel
    ports = sorted((_listening(ADMIN_PORTS) & set(ADMIN_PORTS)) | {PANEL_PORT})
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as ex:
        panels = [x for x in ex.map(_panel_probe, ports) if x]
    tables = CP.open_tables()
    for t in tables:
        t["panels"] = [x["port"] for x in panels if x.get("attached") == t["room"]]
    return {"ok": True, "tables": tables, "panels": panels, "client": CP.client_state(), "me": PANEL_PORT}


def _cp_reattach(room: str | None) -> tuple[int, dict]:
    """This panel reads another table from now on (the admin page's Move, or the panel's own switch)."""
    if room and room not in CP.open_rooms():
        return 409, {"ok": False, "why": "that table is not open in the CoinPoker client"}
    CP.attach(room)
    _study.update(text=None, pick=None)                 # the old table's answer is not this table's
    if _session["rec"]:
        cfg = dict(_session["rec"].get("config") or {}, cpTable=room)
        _session["rec"]["config"] = cfg
        _sessions.set_config(_session["id"], cfg)       # a resume re-attaches to the table it is on NOW
        _sessions.event(_session["id"], "coinpoker-attach", {"room": room})
    _cp_snap["room"] = room
    threading.Thread(target=lambda: _cp_snap.update(last=_snap_panel_to_cp_table(), at=time.time()), daemon=True).start()
    print(f"[coinpoker] attached to {room!r}")
    return 200, {"ok": True, "room": room, "label": CPS.Site.label(room, None)["label"] if room else None}


def _leader_hwnd() -> int | None:
    """The CoinPoker leader window (title "CoinPoker Leader · ..."), if one is up. Never a "Poker Wrapper" title,
    so the panel finder (_wrapper_windows) cannot take it for a panel or a table."""
    found = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)

    def cb(h, _):
        if ctypes.windll.user32.IsWindowVisible(h):
            n = ctypes.windll.user32.GetWindowTextLengthW(h)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                ctypes.windll.user32.GetWindowTextW(h, buf, n + 1)
                if buf.value.startswith("CoinPoker Leader"):
                    found.append(h)
        return True
    ctypes.windll.user32.EnumWindows(proto(cb), 0)
    return found[0] if found else None


def _open_leader() -> None:
    """THE LEADER PANEL (Brady, 2026-09-23): while the Poker Wrapper plays CoinPoker, the main panel keeps a second
    window up — the admin page: every open table, every panel, open / move / end. Only the main panel (no tag, not
    the rig) owns it; it closes with the main panel's CoinPoker session (_session_end)."""
    if _TAG or _fake_mode:
        return
    # a leader window already up may be ANOTHER wrapper's (a stray instance on another port, or this panel's own
    # previous process): it would show that wrapper's page and code. Replace it with ours.
    if _leader_hwnd():
        _kill_profile_windows(PROFILE_LEADER)
    area = other_area() or target_area()
    w, ht = min(area["w"], max(520, area["w"] // 3)), int(area["h"] * 0.7)
    chrome_window(f"http://127.0.0.1:{PANEL_PORT}/admin", PROFILE_LEADER, area["x"], area["y"], w, ht)
    print("[coinpoker] leader window opened")


def _admin_post(port: int, path: str, body: dict, timeout: float = 30) -> tuple[int, dict]:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {"ok": False, "why": str(e)}
    except Exception as e:
        return 502, {"ok": False, "why": f"panel :{port} did not answer ({e})"}


def _admin_open(room: str, preset: str | None = None) -> tuple[int, dict]:
    """A new panel for `room`: another wrapper on the next free admin port, then a session on it — the strategy the
    leader's Open-a-panel dialog chose (`preset`), else this panel's, else the CoinPoker heads-up one — attached to
    that table. The new wrapper opens NO setup window (PANEL_DEFER_WINDOW); once its session runs it is told to open
    its panel window, which then follows the table."""
    if room not in CP.open_rooms():
        return 409, {"ok": False, "why": "that table is not open in the CoinPoker client"}
    # ONE PANEL PER TABLE: two would answer every decision twice and archive every hand into two sessions
    busy = [x for x in (_panel_probe(p) for p in sorted(_listening(ADMIN_PORTS) | {PANEL_PORT})) if x and x.get("attached") == room]
    if busy:
        return 409, {"ok": False, "why": f"a panel is already on that table ({busy[0]['tag']})"}
    if preset and preset not in S.PRESETS:
        return 409, {"ok": False, "why": f"the mode {preset!r} is not on offer right now"}
    live = _listening(ADMIN_PORTS)
    port = next((p for p in range(7720, 7740) if p not in live), None)
    if port is None:
        return 409, {"ok": False, "why": "no free panel port (7720-7739 are all in use)"}
    tag = f"#{port - 7718}"
    exe = Path(sys.executable)
    exe = exe.with_name("pythonw.exe") if exe.with_name("pythonw.exe").exists() else exe
    subprocess.Popen([str(exe), str(ROOT / "run-study.pyw"), "--panel-port", str(port), "--cdp-port", str(9340 + port - 7720)],
                     env={**os.environ, "PANEL_TAG": tag, "PANEL_DEFER_WINDOW": "1"}, cwd=str(ROOT),
                     creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    for _ in range(60):
        if _panel_probe(port):
            break
        time.sleep(1)
    else:
        return 504, {"ok": False, "why": f"the new panel on :{port} did not come up"}
    rec = _session["rec"] if (_session["rec"] and _is_cp()) else None
    t = next((x for x in CP.open_tables() if x["room"] == room), {})
    if preset:                                    # chosen in the dialog: that mode's own defaults
        cfg = {"answers": bool((S.PRESETS.get(preset) or {}).get("config", {}).get("answers", True))}
    else:                                         # copy this panel's session, else the heads-up strategy
        preset = rec["preset"] if rec else "strategy:cp200-hu-equilibrium"
        cfg = dict((rec or {}).get("config") or {"answers": True})
    cfg.update(site=CPS.SITE, cpTable=room)
    cfg.pop("panelPort", None)                    # the new panel stamps its own
    if t.get("format"):
        cfg["format"] = t["format"]
    code, res = _admin_post(port, "/session/start", {"preset": preset, "config": cfg, "label": f"{t.get('label') or room} ({tag})"}, 60)
    if res.get("ok"):
        _admin_post(port, "/panel/open-window", {}, 20)     # now, and straight onto the panel
    else:
        _admin_post(port, "/quit", {}, 5)                   # a panel that could not start is not left running
    return (200 if res.get("ok") else code), {**res, "port": port, "tag": tag}


_cp_follow: dict = {"room": None, "hwnd": None, "rect": None, "stable": 0, "snapped": None}


def _cp_follow_loop() -> None:
    """THE PANEL FOLLOWS THE TABLE (Brady, 2026-09-24: "Panel beside table" is the default, no button).

    Every second, the attached table's window rectangle is read. When it has CHANGED and then held still for a
    second (you let go of the drag), the panel goes beside it; a table that does not move is never acted on, so
    the panel is never fought over. The first rectangle seen counts as a change, which is the first snap when a
    session attaches or re-attaches. A snap that fails (no room beside the table, another desktop) is not
    retried until the table moves again."""
    from sites import cp_actions as CPA
    u = ctypes.windll.user32
    while True:
        time.sleep(1.0)
        try:
            room = CP.pinned
            if not (_is_cp() and _session["rec"] and room):
                _cp_follow.update(room=None, hwnd=None, rect=None, stable=0, snapped=None)
                continue
            if _cp_follow["room"] != room or not _cp_follow["hwnd"] or not u.IsWindow(_cp_follow["hwnd"]):
                _cp_follow.update(room=room, hwnd=CPA.table_window(room), rect=None, stable=0, snapped=None)
            h = _cp_follow["hwnd"]
            if not h or u.IsIconic(h) or CPA.cloaked(h):
                continue
            r = ctypes.wintypes.RECT()
            u.GetWindowRect(h, ctypes.byref(r))
            rect = (r.left, r.top, r.right, r.bottom)
            if rect != _cp_follow["rect"]:
                _cp_follow.update(rect=rect, stable=0)      # still moving (or just seen)
                continue
            _cp_follow["stable"] += 1
            if rect != _cp_follow["snapped"]:
                res = _snap_panel_to_cp_table()
                _cp_follow["snapped"] = rect
                _cp_snap.update(last=res, at=time.time())
        except Exception as e:
            print(f"[coinpoker] follow: {e}")


def apply_layout() -> dict:
    """Put this wrapper's two windows where they belong.

    ONE TABLE: table on the left ~70% of the target monitor, panel down the
    strip beside it — unchanged, and reached by the same code path it always
    was. SEVERAL: the tables tile the target monitor between them (by CDP, since
    they all carry the same window title) and the panels tile the other screen.
    Geometry and the reasoning for it are in tables.py.

    COINPOKER: the panel goes beside the table (_snap_panel_to_cp_table); with no table yet it takes the usual
    strip. Nothing but the panel is ever moved there."""
    if _is_cp():
        snap = _snap_panel_to_cp_table()
        if snap.get("ok"):
            return snap
        area = target_area()
        panel = _wrapper_windows()[1]
        if panel and not CP.table():                 # no table yet: the usual strip, until one opens
            if ctypes.windll.user32.IsZoomed(panel) or ctypes.windll.user32.IsIconic(panel):
                ctypes.windll.user32.ShowWindow(panel, 9)
            table_w = int(area["w"] * TABLE_FRAC)
            ctypes.windll.user32.MoveWindow(panel, area["x"] + table_w, area["y"], area["w"] - table_w, area["h"], True)
            return {"ok": True, "monitor": area, "monitors": len(monitors()), "moved": {"panel": True},
                    "why": snap.get("why")}
        return {**snap, "monitor": area, "monitors": len(monitors())}
    me = TABLES.slot()
    n = TABLES.count()
    area = target_area()
    moved = {}
    # ONE CLIENT WINDOW, N PANELS. The client window is the leader's to place and
    # is always the full table strip — the client tiles its own tables inside it.
    # The PANELS are still one window per wrapper, so those are tiled between
    # them on the other screen.
    if me is not None:
        bounds = place_client_window()          # None on a follower, by design
        if bounds:
            moved["table"] = True
        panel = _wrapper_windows()[1]
        if panel:
            r = TABLES.panel_rect(me, n, area, other_area())
            if ctypes.windll.user32.IsZoomed(panel) or ctypes.windll.user32.IsIconic(panel):
                ctypes.windll.user32.ShowWindow(panel, 9)
            ctypes.windll.user32.MoveWindow(panel, r["x"], r["y"], r["w"], r["h"], True)
            moved["panel"] = True
        return {"ok": bool(moved), "monitor": area, "slot": me, "tables": n,
                "monitors": len(monitors()), "moved": moved, "client": bounds}
    table_w = int(area["w"] * TABLE_FRAC)
    table, panel = _wrapper_windows()
    for h in (table, panel):          # a maximized window ignores MoveWindow; a minimized one stays hidden
        if h and (ctypes.windll.user32.IsZoomed(h) or ctypes.windll.user32.IsIconic(h)):
            ctypes.windll.user32.ShowWindow(h, 9)   # SW_RESTORE
    if table:
        ctypes.windll.user32.MoveWindow(table, area["x"], area["y"],
                                        table_w, area["h"], True)
        moved["table"] = True
    if panel:
        ctypes.windll.user32.MoveWindow(panel, area["x"] + table_w, area["y"],
                                        area["w"] - table_w, area["h"], True)
        moved["panel"] = True
    return {"ok": bool(moved), "monitor": area,
            "monitors": len(monitors()), "moved": moved}


# ---- CDP helpers (all read-only against the table window) ----

def ignition_target():
    """The poker client's page target — the one that isn't our own panel.

    ONE PAGE, SHARED BY EVERY TABLE (corrected 2026-09-20 against the live
    client). Ignition seats up to four tables in a single page, each a
    same-origin iframe tagged `data-multitableslot`; there is no window per
    table to claim. So every wrapper resolves to the SAME target here and tells
    its tables apart INSIDE the page (_slotted / _FRAME_JS).

    This used to claim the target exclusively per slot, from the earlier and
    wrong belief that four tables meant four windows. Claiming here now would be
    worse than useless: the first wrapper would take the only page and leave the
    other three unable to find the client at all."""
    pages = cdp.page_targets(CDP_PORT)

    def rank(u: str) -> int | None:
        # In test mode the fake table IS the table — prefer it even when the real
        # client is also open, so an authored state is never read off live felt.
        if _fake_mode and "/faketable" in u:
            return 0
        low = u.lower()
        # The actual game lives on /static/poker-game/ — prefer it over the lobby.
        if "poker-game" in low:
            return 1
        if "ignition" in low:
            return 2
        if f"localhost:{PANEL_PORT}" in u or u.startswith("devtools"):
            return None              # our own panel is never the table
        return 3

    # slot None: the page is shared on purpose, so it is never claimed away
    return TABLES.pin(pages, rank, None)


# Like scout/cdp.py's extractor, but recurses into SAME-ORIGIN iframes — the
# Ignition poker client nests its whole UI in them, so a top-document-only walk
# sees almost nothing. (Cross-origin iframes are separate CDP targets anyway.)
_EXTRACT_DEEP_JS = r"""(() => {
  const out = [];
  const walk = (doc, ox, oy) => {
    if (!doc || !doc.body) return;
    const wk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = wk.nextNode())) {
      const s = (n.nodeValue || '').trim();
      if (!s || s.length > 24) continue;
      const r = doc.createRange(); r.selectNodeContents(n);
      const b = r.getBoundingClientRect();
      if (b.width > 0 && b.height > 0)
        out.push({text: s, x: Math.round(b.x + ox), y: Math.round(b.y + oy),
                  w: Math.round(b.width), h: Math.round(b.height)});
    }
    for (const f of doc.querySelectorAll('iframe')) {
      try {
        const fb = f.getBoundingClientRect();
        walk(f.contentDocument, ox + fb.x, oy + fb.y);
      } catch (e) { /* cross-origin — separate CDP target */ }
    }
  };
  const count = (doc, sel) => {
    if (!doc) return 0;
    let c = doc.querySelectorAll(sel).length;
    for (const f of doc.querySelectorAll('iframe')) {
      try { c += count(f.contentDocument, sel); } catch (e) {}
    }
    return c;
  };
  walk(document, 0, 0);
  return {nodes: out, canvases: count(document, 'canvas'),
          iframes: count(document, 'iframe'),
          vw: innerWidth, vh: innerHeight, url: location.href, title: document.title};
})()"""



# ---- Study Answers state (CONTRACT.md §§1-3) ----
# The panel's toggle is THE gate: gto-trainer's studyPoller reads it from
# /state every tick and idles while it's off. Answers arrive as pushes on
# /panel/answer; the TTL mirrors assistive-play's run.ts so a dead poller
# degrades to a blank card, never a stale verdict.
STUDY_ANSWER_TTL_MS = 3000
_study = {"on": False, "text": None, "pick": None, "roll": None, "note": None,
          "at": 0.0,
          # NO MODE. Which preflop piece answers is a property of the declared
          # STRATEGY (gto-trainer services/strategies.ts), resolved from the
          # session's strategy id that /state already carries in `session`.
          # Until 2026-09-14 a mode flag rode alongside it and won, so an API
          # started without EXPLOIT_CHART answered off the equilibrium chart
          # while the session still called itself an Exploit strategy.
          # The decision the pick was rolled for, as the poller saw it: its
          # decisionKey ([street, board, cards, toCall, nActions]) and the
          # wrapper hand id. The pick-to-relay path refuses to act unless
          # these still describe the table (see _pick_ready).
          "decisionKey": None, "handId": None,
          # Pick → relay. `auto` executes the pick without a press; it can only
          # be armed on a PRACTICE table (playMode=fun) or the fake table —
          # see /study-auto. `executed` is the decisionKey already acted on
          # (one execution per decision, press or auto); `autoTried` the key
          # the auto loop last attempted (a refused attempt is not retried);
          # `lastExec` what happened, for the panel.
          "auto": False, "executed": None, "autoTried": None, "lastExec": None,
          # `autoHeld` is a decision the uncertainty gate is holding RIGHT NOW: the
          # key, the reason and when it started. Re-tested every tick and cleared the
          # moment the fault stops — a hold is a pause, never a verdict (2026-09-19).
          "autoHeld": None,
          # `pendingExec` is a press whose OUTCOME is not yet known: what was sent, the
          # action index it must land at, and the attempts left. _maybe_verify_exec
          # resolves it from the table's own chips — see there.
          "pendingExec": None,
          # timing of the auto mode: "instant" fires the moment a pick is ready;
          # "random" waits a fresh uniform AUTO_DELAY_S draw per decision first
          # (declared at setup as config.autoDelay, flipped live on /study-auto).
          # `autoDue` is the pending wait: the decision key it was drawn for and
          # when it fires — dropped the moment that key stops being ready.
          "autoDelay": "instant", "autoDue": None,
          # THE TIME BANK. Ignition's ring tables show a "+45s" button on the action
          # strip once hero's clock reaches ~9 s (seen in the 2026-08-05 recordings:
          # 7 episodes, clock 9 the tick before, 8 the first tick with it; it stays
          # until hero acts). With `timeBank` on, the feed loop presses it whenever
          # it is there — more time never costs anything — and again if it reappears.
          "timeBank": True, "timeBankAt": 0.0, "lastTimeBank": None,
          # AUTO TOP-UP (2026-09-18, Brady): whenever hero's stack is below the ring
          # table's max buy-in, buy back up to it, between hands. The client has no
          # such setting of its own (a full session's DOM: the Buy-chips panel is
          # manual — amount field, Max, BUY), so the wrapper presses what a player
          # would. `topUpHand` = the hand it last ran for; `lastTopUp` = the record.
          "topUp": True, "topUpAt": 0.0, "topUpHand": None, "lastTopUp": None,
          # `topUpDue` = the small wait drawn when a window opens; `topUpTrigger` = which
          # window it was (not-dealt / fold / hand-over), carried into the record.
          "topUpDue": None, "topUpTrigger": None,
          # REAL-MONEY TESTING ALLOWANCE (Brady, 2026-09-14). Auto normally arms
          # only on practice/fake tables. The practice tables never fill, so the
          # unattended path could not be exercised at all; this is the temporary,
          # EXPLICIT, EXPIRING exception that lets it run at a real table while
          # the mechanism is being tested. It has to be asked for by name
          # (/study-auto allowRealMoney:true), it carries a minute and hand
          # budget, it is written into the session record, and it disarms itself
          # when either budget runs out or the session ends. Never a default,
          # never silent, never open-ended.
          "autoRealUntil": 0.0, "autoRealHands": 0, "autoRealFrom": None, "autoRealReason": None,
          # what the SESSION declared on the setup page (config.autoExecute /
          # autoRealMoney / autoBudget). The live toggle overrides it freely;
          # this only decides the state the panel opens in, and lets a
          # declaration arm once a table it is allowed on appears.
          "autoDeclared": False, "autoDeclaredReal": False, "autoDeclaredBudget": None}
# Hero's table status, cached by _feed_tick (which polls the DOM anyway) so
# /state never needs an extra CDP eval to answer the poller's 1 Hz probe.
_live_status = {"hero": "unknown"}


def _current_answer() -> dict | None:
    """The displayable answer {text, pick, roll} — only while the toggle is on
    and the last push is fresh (dead poller ⇒ blank card, never stale advice)."""
    if not _study["on"] or not _study["text"]:
        return None
    if (time.time() - _study["at"]) * 1000 >= STUDY_ANSWER_TTL_MS:
        return None
    return {"text": _study["text"], "pick": _study["pick"],
            "roll": _study["roll"], "note": _study["note"]}


def _current_note() -> str | None:
    """WHY there is no answer, when there is none.

    The answer card is freshness-gated so a dead poller leaves a blank rather than stale
    advice — but that gate also swallowed the one message that only ever arrives WITHOUT
    an answer: "this spot has been asked its limit of times and will not be asked again"
    (2026-09-19). Same gate, separate channel: the explanation is as perishable as the
    advice, and it is shown only when there is no advice to show instead."""
    if not _study["on"] or _study.get("text") or not _study.get("note"):
        return None
    if (time.time() - _study["at"]) * 1000 >= STUDY_ANSWER_TTL_MS:
        return None
    return _study["note"]


# ---- the big pieces, watched (2026-09-23) -------------------------------------------------------------------
# "When a major piece is down there should be a massive warning in the panel" (Brady). Three pieces answer:
# the study API (:2000, everything), the chart server (:8777, the HRC preflop charts), GTO Wizard (postflop and
# multiway, through the API's GTO Wizard sessions). A background thread checks them every 15 s — the API's
# GTO Wizard status alone takes ~4 s, far too slow for the panel's 1 Hz poll — and state() carries the result:
# "down" (red: that layer answers nothing) or "partial" (amber: some of it works).
_health: dict = {"at": 0.0, "issues": []}


def _health_check() -> list[dict]:
    issues: list[dict] = []
    api = S.API.rstrip("/")

    def get(url: str, timeout: float) -> bytes | None:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception:
            return None

    if get(f"{api}/api/dashboard/config", 5) is None:
        issues.append({"level": "down", "piece": "study-api",
                       "text": "The study API (:2000) is DOWN — there are no answers at all",
                       "fix": "it restarts itself within a minute; if it stays down, restart the laptop"})
        return issues                                  # the other two are reached through it / are moot
    charts = os.environ.get("HRC3MAX_URL", "http://127.0.0.1:8777").rstrip("/")
    if get(f"{charts}/", 5) is None:
        issues.append({"level": "down", "piece": "chart-server",
                       "text": "The chart server (:8777) is DOWN — preflop chart answers (3-handed, heads-up) are OFF",
                       "fix": "it restarts itself within a minute"})
    # /gtow-status (~0.2 s), not the sources registry (~4 s): this runs every 15 s in every panel, and the
    # registry's cost was enough load to time out other requests to the API
    raw = get(f"{api}/api/dashboard/gtow-status", 10)
    try:
        g = json.loads(raw) if raw else {}
    except ValueError:
        g = {}
    sess = [x for x in g.get("sessions") or [] if x.get("enabled", True)]
    live = [x for x in sess if x.get("tokenLive")]
    if raw is not None and sess and not live:
        issues.append({"level": "down", "piece": "gtow",
                       "text": "GTO Wizard is NOT CONNECTED — postflop and multiway answers are OFF",
                       "detail": " · ".join(f"{x.get('id')}: {x.get('text')}" for x in sess),
                       "fix": "is GTO Wizard up? Sign in again in its Chrome window if it shows the login page"})
    elif live and len(live) < len(sess):
        off = [x for x in sess if not x.get("tokenLive")]
        issues.append({"level": "partial", "piece": "gtow",
                       "text": "GTO Wizard is PARTLY connected — " + ", ".join(
                           f"the {x.get('id')} account{' (heads-up)' if not x.get('multiway') else ''} is down" for x in off),
                       "detail": " · ".join(f"{x.get('id')}: {x.get('text')}" for x in off)})
    return issues


# ---- a closed panel ends its session (Brady, 2026-09-24) ----------------------------------------------------
PANEL_GONE_S = 8          # a reload blanks the title for a moment; only a window gone this long counts as closed
_panel_watch: dict = {"sid": None, "seen": False, "missingSince": None}


def _panel_watch_loop() -> None:
    """Every 2 s while a session runs: is this wrapper's panel window still there? Gone for PANEL_GONE_S = you
    closed it, and the session ends with it.
    - CoinPoker: end + close out — this panel's process stands down, the table stays open in the client, and the
      main panel takes its leader window with it (the same as the panel's own End button).
    - Ignition (single table): the session RECORD ends; the table is not left and its window is not closed —
      closing a panel must never stand you up from a real-money table.
    Skipped: the test rig, and multi-table Ignition slots (their session is shared by every table)."""
    while True:
        time.sleep(2)
        try:
            sid = _session["id"]
            if not sid or _fake_mode or TABLES.slot() is not None:
                _panel_watch.update(sid=sid, seen=False, missingSince=None)
                continue
            if _panel_watch["sid"] != sid:
                _panel_watch.update(sid=sid, seen=False, missingSince=None)
            if _panel_hwnd():
                _panel_watch.update(seen=True, missingSince=None)
                continue
            if not _panel_watch["seen"]:
                continue        # no window yet this session (a panel the leader opens once its session runs)
            if _panel_watch["missingSince"] is None:
                _panel_watch["missingSince"] = time.time()
                continue
            if time.time() - _panel_watch["missingSince"] < PANEL_GONE_S:
                continue
            print(f"[session] {sid}: the panel window was closed — ending the session")
            _sessions.event(sid, "panel-closed", {"goneS": round(time.time() - _panel_watch["missingSince"], 1)})
            _panel_watch.update(seen=False, missingSince=None)
            res = _session_end({"note": "ended: the panel window was closed"})
            if res.get("ok") and _is_cp():
                _close_out_after_end(sid)
        except Exception as e:
            print(f"[session] panel watch: {e}")


def _health_loop() -> None:
    while True:
        try:
            _health.update(issues=_health_check(), at=time.time())
        except Exception as e:
            print(f"[health] check failed: {e}")
        time.sleep(15)


def state(light: bool = False) -> dict:
    """Full state for the panel's connection card; `light` skips the DOM eval
    and target listing — enough for the 1 Hz study-answer poll and the
    poller's probe (CONTRACT.md §1) without extra CDP traffic."""
    try:  # page-code fingerprint: the panel reloads itself when this changes
        pv = int((ROOT / "panel.html").stat().st_mtime)
    except OSError:
        pv = 0
    try:
        sv = int((ROOT / "setup.html").stat().st_mtime)
    except OSError:
        sv = 0
    out = {"cdp": cdp.available(CDP_PORT), "ignition": None, "targets": [],
           "panelVersion": pv, "setupVersion": sv,
           # the big pieces (_health_loop): the panel's red / amber banner
           "health": {"issues": _health["issues"], "checkedAgo": round(time.time() - _health["at"], 1) if _health["at"] else None},
           # Which rig this is. The panel shows its Table Setup card only on a
           # test rig, and points the answer poller at its OWN wrapper — one
           # poller exists, so whichever panel you switch answers on becomes
           # the one it watches.
           # cdpPort so a tool driving THIS rig reads THIS rig's browser. A
           # test that posts to one rig's panel and then reads the other rig's
           # CDP port finds no fake table and reports every state as a parity
           # loss — which is what an hour-long run of 120/120 failures was.
           "fakeTable": _fake_mode, "fakeRig": _FAKE_RIG, "panelPort": PANEL_PORT, "cdpPort": CDP_PORT,
           # WHICH TABLE THIS PANEL IS, and the others sharing the browser: the overview
           # strip. Empty on the single-table setup — there is nothing to give an
           # overview of, and the strip stays out of the way.
           "tableSlot": TABLES.slot(), "tables": TABLES.registry(),
           # WHICH SOCKET THE CAPTURE IS ON. One page carries every table's
           # WebSocket, so "bound" is the difference between reading our table
           # and reading all of them at once (see _tap_accepts). Held frames are
           # the ones dropped while we could not yet tell which was ours.
           "tap": {"bound": _tap_bound, "heroSeat": _live_status.get("heroSeatDom"),
                   "foreignDropped": _tap_foreign, "heldWhileUnbound": _tap_held,
                   "multi": TABLES.slot() is not None,
                   # unbound for longer than makes sense = say so, loudly, rather
                   # than let a dead capture look like an idle table
                   "stalled": bool(_tap_stall["since"] and _tap_bound is None
                                   and time.time() - _tap_stall["since"] > _TAP_STALL_S),
                   "unboundForS": (round(time.time() - _tap_stall["since"], 1)
                                   if _tap_stall["since"] and _tap_bound is None else None)},
           # THE CONNECTION GUARD (netcheck.py): the last probe, the bad/good streak, and the
           # sit-out it made, if any
           "net": {"last": _net["last"], "bad": _net["bad"], "good": _net["good"],
                   "sitout": ({k: v for k, v in _net["sitout"].items() if k != "html"}
                              if _net["sitout"] else None),
                   "everyS": NET_PROBE_EVERY_S},
           # The CLIENT WINDOW's geometry, as last placed. The tables inside it
           # are the client's to size — it tiles them itself — so this is no
           # longer a per-table measurement and carries no "too narrow" verdict.
           # What protects a press now is _point_is_my_table, which asks the
           # client where the point actually lands rather than trusting a size.
           "layout": _layout_note(),
           # live-feed contract (CONTRACT.md §1) — what resolveHand consumes
           "connected": False, "hand": None, "studyAnswers": _study["on"],

           "sessionId": _session["id"],
           "panelTag": _TAG or None,
           "session": _session_brief(),
           "panelAnswer": _current_answer(),
           # why there is no answer, when there is none (see _current_note)
           "panelNote": _current_note(),
           # pick → relay: is the table a practice one (the only place the
           # auto mode may arm), is auto armed, can the current pick be
           # executed right now (and why not), what the last execution did
           "practice": bool(_fake_mode or _live_status.get("practice")),
           "studyAuto": bool(_study["auto"]),
           "studyAutoDelay": _study.get("autoDelay") or "instant",
           "studyTimeBank": bool(_study.get("timeBank")),
           "studyTopUp": bool(_study.get("topUp")),
           # THE TOP-UP SCOREBOARD: hands hero started below the table max (the number
           # to drive to zero), which window is open right now, and the panel state.
           "topUpKpi": {"hands": _topup_kpi["hands"], "short": _topup_kpi["short"],
                        "worstBb": _topup_kpi["worstBb"]},
           "topUpWindow": (lambda w: {"open": w[0], "trigger": w[1], "why": w[2]})(_top_up_window()),
           "topUpPanelOpen": bool(_topup_panel["open"]),
           "shadow": {"agree": _shadow["agree"], "differ": _shadow["differ"], "last": _shadow["last"]},
           # the per-tick cross-checks of the table reading (see _state_check)
           "stateHealth": _state_health_summary(),
           "lineUncertain": _study.get("uncertain"),
           # a decision the uncertainty gate is holding right now — a pause that lifts
           # itself, so the panel says "held, still watching", not "held, over"
           "autoHeld": ({"why": _study["autoHeld"]["why"],
                         "forS": round(time.time() - _study["autoHeld"]["at"], 1)}
                        if _study.get("autoHeld") else None),
           # a press whose outcome is not settled yet (see _maybe_verify_exec)
           "pendingExec": ({"pick": _study["pendingExec"]["pick"],
                            "attempts": _study["pendingExec"]["attempts"],
                            "forS": round(time.time() - _study["pendingExec"]["sentAt"], 1)}
                           if _study.get("pendingExec") else None),
           # a client notice over the table right now (harmless ones are dismissed)
           "modal": _live_status.get("modal"),
           "lastTopUp": _study.get("lastTopUp"),
           "timeBankOffered": bool(_live_status.get("timeBank")),
           "lastTimeBank": _study.get("lastTimeBank"),
           # the pending randomized wait, so the panel can count it down
           "studyAutoDue": ({"secondsLeft": max(0.0, round(_study["autoDue"]["at"] - time.time(), 1)),
                             "wait": round(_study["autoDue"]["wait"], 1)} if _study.get("autoDue") else None),
           # the real-money testing allowance, so the panel can show what is
           # left of it and never imply auto is "just on"
           "autoAllowance": _auto_allowance(),
           # what setup DECLARED, so the panel can say "declared, waiting for a
           # table it may arm on" rather than just showing an unticked box
           "autoDeclared": {"on": bool(_study.get("autoDeclared")),
                            "realMoney": bool(_study.get("autoDeclaredReal")),
                            "budget": _study.get("autoDeclaredBudget")},
           "pickReady": _pick_ready(),
           "lastExec": _study["lastExec"],
           "snapshot": {"status": _live_status["hero"],
                        "seats": [{"hero": True,
                                   "sittingOut": _live_status["hero"]
                                   in ("sitting-out", "waiting-for-bb")}]}}
    out["site"] = _site()
    if _is_cp():
        # A CoinPoker table is "connected" when it is live in the client's log; the
        # Ignition browser (and its CDP port) plays no part.
        t = CP.table()
        st = CP.hero_status()
        # the panel beside the table: _cp_follow_loop, continuously (no longer once per table here)
        out.update({"connected": bool(t), "hand": _hand_state() if t else None, "table": t,
                    "practice": bool(t and t.get("practice")),
                    "coinpoker": {"client": CP.client_state(), "error": CP.error, "snap": _cp_snap.get("last"),
                                  "attached": CP.pinned},
                    "snapshot": {"status": st, "seats": [{"hero": True, "sittingOut": st == "sitting-out"}]}})
        return out
    if not out["cdp"]:
        return out
    if light:
        out["connected"] = bool(ignition_target())
        if out["connected"]:
            out["hand"] = _hand_state()
        return out
    out["targets"] = [{"title": t.get("title", ""), "url": t.get("url", "")}
                      for t in cdp.page_targets(CDP_PORT)]
    t = ignition_target()
    if t:
        out["connected"] = True
        out["hand"] = _hand_state()
        try:
            d = cdp._eval(t["webSocketDebuggerUrl"], _EXTRACT_DEEP_JS) or {}
        except Exception:
            d = {}
        out["ignition"] = {"title": t.get("title", ""), "url": t.get("url", ""),
                           "textNodes": len(d.get("nodes", [])),
                           "canvases": d.get("canvases", 0),
                           "iframes": d.get("iframes", 0)}
    return out


def dom_dump() -> dict:
    """Visible text nodes from EVERY frame (page + iframes) of the table window,
    plus a readability verdict. This is the CoinPoker wrapper's 'Dump DOM
    sample' equivalent."""
    frames = []
    for ws in cdp.all_target_wss(CDP_PORT):
        try:
            d = cdp._eval(ws, _EXTRACT_DEEP_JS, timeout=8)
        except Exception:
            d = None
        if not d or f"localhost:{PANEL_PORT}" in d.get("url", ""):
            continue
        frames.append(d)
    frames.sort(key=lambda f: len(f.get("nodes", [])), reverse=True)
    best = frames[0] if frames else None
    n = len(best["nodes"]) if best else 0
    c = sum(f.get("canvases", 0) for f in frames)
    verdict = ("no frames readable" if not best else
               f"DOM-READABLE: {n} visible text nodes — CoinPoker-style DOM feed viable"
               if n >= 40 else
               f"likely CANVAS-RENDERED ({n} text nodes, {c} canvas element(s)) — OCR path needed"
               if c else f"sparse ({n} text nodes) — inspect the sample below")
    return {"verdict": verdict, "frames": frames}


# ---- Live table state + assistive controls ----
# Reads ONLY the table iframe (src carries playMode). Node coords come back in
# page-viewport space, so a matched button can be clicked directly.
# WHICH TABLE THIS READ IS ABOUT.
#
# Ignition seats up to four tables in ONE page on ONE login: each is a
# same-origin iframe tagged `data-multitableslot` (0-3; the lobby is -1), all
# four live and clickable at once, and the client tiles them itself. So the
# reader cannot say "the table" any more — it has to name one.
#
# `__SLOT__` is substituted by _table_js(): a number picks that slot's iframe,
# and `null` keeps exactly what this did when one table was all there could be
# (the first iframe whose src carries playMode). The single-table path and the
# fake rig — where no such attribute exists — take the null branch unchanged.
# ONE PLACE THAT ANSWERS "WHICH FRAME IS THIS TABLE".
#
# Five separate reads used to each write `[...iframes].find(src has playMode)`.
# That is the single-table question, and with four tables in one page every one
# of them would have answered "the first one" — the same mistake `_faketable_load`
# made, which passed testing for a day because only table 1 was ever checked.
# They all go through this now, so there is one line to get right.
_FRAME_JS = r"""
  const __frame = (SLOT) => {
    const play = f => /playMode=/.test(f.getAttribute('src') || '');
    const all = [...document.querySelectorAll('iframe')].filter(play);
    if (SLOT === null) return all[0];
    // BY ORDINAL, NOT BY THE ATTRIBUTE'S VALUE (2026-09-21). This used to ask
    // for `[data-multitableslot="0"]` and take the client's numbering on faith.
    // Live, the leader's lookup for 0 found NOTHING while slot 2's for 1 found a
    // table -- whatever base this build tags from, it is not the one we assumed.
    // The leader then had no frame, so no seatQa, so no hero seat, so the tap
    // never identified its socket and the panel read "no hand in progress" for
    // the whole session. We do not need the client's numbers, only its ORDER:
    // sort the tagged table frames by their own tag and take the Nth. Works
    // 0-based, 1-based or with gaps.
    const tagged = all.filter(f => f.getAttribute('data-multitableslot') !== null);
    if (!tagged.length) return SLOT === 0 ? all[0] : undefined;   // untagged = the single-table client
    tagged.sort((a, b) => Number(a.getAttribute('data-multitableslot'))
                        - Number(b.getAttribute('data-multitableslot')));
    return tagged[SLOT];
  };
"""


def _slotted(js: str, slot: int | None) -> str:
    """A table-reading snippet aimed at one slot: `__frame(__SLOT__)` resolves to
    that table's iframe, or to the single-table one when slot is None."""
    return (js.replace("__FRAME__", _FRAME_JS)
              .replace("__SLOT__", "null" if slot is None else str(int(slot))))


_TABLE_JS_TMPL = r"""(() => {__FRAME__
  const SLOT = __SLOT__;
  const tf = __frame(SLOT);          // never the lobby frame: it carries no playMode
  if (!tf) return {seated: false, slot: SLOT};
  let doc = null;
  try { doc = tf.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return {seated: false};
  const fb = tf.getBoundingClientRect();
  const out = [];
  const walk = (d, ox, oy) => {
    // Skip INVISIBLE text: the client leaves stale labels (old FOLD badges,
    // 0 BB bets) in the DOM at opacity 0 / visibility hidden, and reading
    // them corrupts the seat parse. Computed visibility is already resolved
    // per element; opacity must be checked up the ancestor chain (memoized).
    const view = d.defaultView;
    const opCache = new Map();
    const opOk = el => {
      if (!el || el === d.body) return true;
      if (opCache.has(el)) return opCache.get(el);
      const ok = +view.getComputedStyle(el).opacity >= 0.5 && opOk(el.parentElement);
      opCache.set(el, ok);
      return ok;
    };
    const wk = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = wk.nextNode())) {
      const s = (n.nodeValue || '').trim();
      if (!s || s.length > 90) continue;
      const pe = n.parentElement;
      if (!pe || view.getComputedStyle(pe).visibility !== 'visible' || !opOk(pe)) continue;
      const r = d.createRange(); r.selectNodeContents(n);
      const b = r.getBoundingClientRect();
      if (b.width > 0 && b.height > 0)
        out.push({text: s, x: Math.round(b.x + ox), y: Math.round(b.y + oy),
                  w: Math.round(b.width), h: Math.round(b.height)});
    }
    for (const f of d.querySelectorAll('iframe')) {
      try { const r = f.getBoundingClientRect();
            if (f.contentDocument) walk(f.contentDocument, ox + r.x, oy + r.y); } catch (e) {}
    }
  };
  walk(doc, fb.x, fb.y);
  // Community cards are card-sized SVGs in the middle band — but the board's
  // card SLOTS exist in the DOM even when no card shows, so require actual
  // visibility: the element under the card's centre must be the card itself.
  const cardEls = [];
  for (const svg of doc.querySelectorAll('svg')) {
    const r = svg.getBoundingClientRect();
    if (r.width < 40 || r.width > 80 || r.height < 60 || r.height > 110) continue;
    if (r.y < fb.height * 0.2 || r.y > fb.height * 0.65) continue;
    if (r.x < fb.width * 0.18 || r.x + r.width > fb.width * 0.82) continue;
    // Style-based visibility only — no elementFromPoint (overlays like the
    // sit-out veil or winner banner cover real cards and would hide them).
    // Empty slots are computed-visibility hidden; animation ghosts hang off
    // opacity-0 ancestors.
    if (doc.defaultView.getComputedStyle(svg).visibility !== 'visible') continue;
    let vis = true;
    for (let e = svg; e && e !== doc.body; e = e.parentElement) {
      if (+doc.defaultView.getComputedStyle(e).opacity < 0.5) { vis = false; break; }
    }
    if (vis)
      cardEls.push({x: Math.round(r.x), y: Math.round(r.y),
                    w: Math.round(r.width), h: Math.round(r.height),
                    qa: svg.getAttribute('data-qa') || ''});
  }
  // The hero's hole cards are mirrored as minis in the TAB STRIP (top page,
  // outside the table iframe) — same data-qa card indices.
  const heroMini = [...document.querySelectorAll('svg[data-qa]')].map(s => {
    const r = s.getBoundingClientRect();
    return {qa: s.getAttribute('data-qa'), x: Math.round(r.x),
            y: Math.round(r.y), w: Math.round(r.width)};
  }).filter(c => /^card\d+$/.test(c.qa) && c.y < 140 && c.w >= 12 && c.w <= 60);
  const btns = [...doc.querySelectorAll('button, [role=button]')].map(el => {
    const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
    const r = el.getBoundingClientRect();
    // The client tags each control: foldButton/callButton/raiseButton/etc are
    // turn actions, *Selector are sizing presets, *PreselectButton are the
    // between-turn pre-arm checkboxes. Carrying the hook lets the action/preset
    // split read the client's own roles instead of guessing by row geometry.
    return {text: t, x: Math.round(fb.x + r.x), y: Math.round(fb.y + r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            qa: el.getAttribute('data-qa') || null};
  }).filter(b => b.text && b.text.length < 40 && b.w > 0 && b.h > 0);
  // STRUCTURAL ownership, read from the client's own containment: which
  // playerContainer a card sits under, and whether it is under the table
  // element at all. The geometric board/hole split (band + modal row) has
  // recorded near-misses — hero cards flood the board band on small layouts
  // and 13 ticks across sessions had mixed-width cards sharing a y-row — so
  // ownership is captured per element to let the split become pure DOM.
  const seatOf = el => {
    const s = el.closest && el.closest("[data-qa^='playerContainer-']");
    return s ? +s.getAttribute('data-qa').split('-')[1] : null;
  };
  const tblEl = doc.querySelector("[data-qa='table']");
  // EVERY visible card element with its position — seat card presence is the
  // reliable fold signal (a folded seat's cards are mucked and stay gone,
  // unlike action badges which animate and re-render).
  const allCards = [...doc.querySelectorAll('svg[data-qa]')].map(s => {
    const r = s.getBoundingClientRect();
    return {qa: s.getAttribute('data-qa') || '', x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2), w: Math.round(r.width), el: s};
  }).filter(c => /^card/.test(c.qa) && c.w >= 20 &&
                 doc.defaultView.getComputedStyle(c.el).visibility === 'visible')
    .map(c => ({qa: c.qa, x: c.x, y: c.y, w: c.w,
                seat: seatOf(c.el), tbl: !!(tblEl && tblEl.contains(c.el))}));
  // Per-seat structural facts, read from the client's own containment — every
  // value the geometric _parse_seats reconstructs by proximity is available
  // inside the seat's playerContainer, so no distances are needed.
  //   stack  : the playerBalance hook (data-qa, stable)
  //   bet    : the one 'X BB' money node that is NOT playerBalance
  //   badge  : the action word (FOLD/CHECK/...), animation-doubled -> first
  //   num    : the displayed seat number (bare single digit; differs from the
  //            0-indexed container id and is what the WS feed keys on)
  //   nHole  : holeCards hooks = real hole-card slots (0 = folded/not dealt)
  const SM = /^[\d,]+(\.\d+)?\s*BB$/i;
  const BW = /^(FOLD|CHECK|CALL|BET|RAISE|ALL[ -]?IN|POST SB|POST BB)$/i;
  // Seat STATUS words, captured per container (2026-09-19): "SITTING OUT" under
  // a villain's seat used to be read as hero sitting out because the status
  // scan saw the whole table as one string (hand 4919080696). Scoping the word
  // to the seat that shows it is what makes it attributable.
  const SW = /sitting out|i am back|wait(ing)?\s+(for\s+)?(the\s+)?big blind|waiting for bb/i;
  // Same visibility test the main node walk uses: the client leaves stale
  // labels (a folded seat's old FOLD, a settled 0 BB bet) in the DOM at
  // opacity 0, and a plain textContent read would resurrect them onto a seat
  // that has since acted again.
  const vw = doc.defaultView;
  const opShown = el => {
    for (let e = el; e && e !== doc.body; e = e.parentElement)
      if (+vw.getComputedStyle(e).opacity < 0.5) return false;
    return true;
  };
  const vis = el => el && vw.getComputedStyle(el).visibility === 'visible' && opShown(el);
  const seatQa = [...doc.querySelectorAll("[data-qa^='playerContainer-']")].map(s => {
    const bal = s.querySelector("[data-qa='playerBalance']");
    let bet = null, badge = null, num = null, status = null;
    const wk = doc.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = wk.nextNode())) {
      const tx = (n.nodeValue || '').trim();
      if (!tx) continue;
      const pe = n.parentElement;
      if (SM.test(tx)) { if (!(bal && bal.contains(pe)) && bet === null && vis(pe)) bet = tx; }
      else if (BW.test(tx)) { if (badge === null && vis(pe)) badge = tx.toUpperCase(); }
      else if (SW.test(tx)) { if (vis(pe)) status = status ? status + ' ' + tx : tx; }
      else if (/^[1-9]$/.test(tx) && num === null) num = +tx;
    }
    const sr = s.getBoundingClientRect();
    return {
      seat: +s.getAttribute('data-qa').split('-')[1],
      num, me: !!s.querySelector("[data-qa='myPlayerTag']"),
      // the seat's own status words (SITTING OUT / I AM BACK / waiting for BB)
      // and its box, so a word can be attributed to the seat that shows it
      status,
      box: {x: Math.round(fb.x + sr.x), y: Math.round(fb.y + sr.y),
            w: Math.round(sr.width), h: Math.round(sr.height)},
      empty: !!s.querySelector("[data-qa^='player-empty-seat']"),
      stack: bal ? bal.textContent.trim() : null,
      bet, badge,
      // VISIBLE hole-card slots only. The client keeps a folded seat's
      // holeCards hooks in the DOM and merely hides them, so counting hooks
      // reported two cards for a seat that mucked and never dropped: across a
      // recorded session, 99 seats kept "holding" cards after the feed said
      // they folded, for a median of 20 ticks and up to 145 — not the muck
      // animation, which is one or two. Card presence IS the fold signal, so
      // that left folded players live in every downstream read. The same
      // filter the bet and badge already use fixes it.
      nHole: [...s.querySelectorAll("[data-qa='holeCards']")].filter(vis).length,
      // The dealer button. It has NO text node (it is drawn, not written), so
      // the geometric pass can never see it and no capture has ever carried
      // it — the one seat fact the review queue confirmed missing on every
      // path. The asset harvested from the client's own DOM is dealer-d.svg,
      // so an <img> under the seat container whose src names the dealer is
      // the client's marker; data-qa is checked too in case a build swaps the
      // img for a hooked element.
      dealer: !!([...s.querySelectorAll("img")].some(i => /dealer/i.test(i.src || ""))
                 || s.querySelector("[data-qa*='dealer' i]")),
    };
  });
  // The client scales its fixed-size table with CSS `zoom`. Every coordinate
  // above is viewport pixels, so design units = (viewport - frame origin) /
  // zoom. The factor cannot be recovered from the coordinates afterwards and
  // the frame rect is the iframe (not the felt), so it is read here or not at
  // all. Walk up from a card: the factor is only ever set on the container,
  // and Chrome computes unset `zoom` to "1" (not "normal") on every ancestor,
  // so the walk must skip 1 and keep climbing rather than stop at the first
  // parsable value. Verified: from a card 54.24px deep under a 1.4275 host the
  // walk returns 1.4275 and 54.24/1.4275 lands back on the declared 38du.
  const zoomOf = el => {
    for (let e = el; e; e = e.parentElement) {
      const z = parseFloat(doc.defaultView.getComputedStyle(e).zoom);
      if (z && z !== 1) return z;
    }
    return 1;
  };
  // Any tagged element will do as a starting point, not a card specifically:
  // between hands there are no cards, and defaulting to 1 there would be
  // indistinguishable from a genuinely unzoomed table. null means "no
  // reference element" so a consumer normalising coordinates can refuse rather
  // than quietly divide by the wrong factor.
  const zoomRef = doc.querySelector('svg[data-qa], [data-qa]');
  return {seated: true, practice: (tf.src || '').includes('playMode=fun'),
          frame: {x: Math.round(fb.x), y: Math.round(fb.y),
                  w: Math.round(fb.width), h: Math.round(fb.height)},
          zoom: zoomRef ? zoomOf(zoomRef) : null,
          nodes: out, buttons: btns, cards: cardEls, allCards, heroMini, seatQa,
          canvases: doc.querySelectorAll('canvas').length};
})()"""
def _table_js(slot: int | None = None) -> str:
    """The table reader, aimed at one slot. `None` = the single-table reading
    this always did, byte-for-byte."""
    return _slotted(_TABLE_JS_TMPL, slot)


# NO MODULE-LEVEL "THE TABLE" READER. Every read names its slot at the call
# site (`TABLES.slot()`), because with four tables in one page a snippet that
# does not name one is a bug that reads whichever table Chrome listed first —
# which is exactly what _faketable_load did for a day without anyone noticing.

# data-qa="card<N>": N = suit*13 + rank, suits alphabetical ♣♦♥♠, ranks
# A,2,…,10,J,Q,K (decoded from live board vs screenshot ground truth).
_SUITS = "♣♦♥♠"
_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]


def _card_name(qa: str | None) -> str | None:
    m = re.fullmatch(r"card(\d{1,2})", qa or "")
    if not m or not 0 <= int(m.group(1)) <= 51:
        return None
    i = int(m.group(1))
    return _RANKS[i % 13] + _SUITS[i // 13]


def _board_cards(d: dict) -> list[str]:
    """Identified community cards, left to right.

    STRUCTURAL: a board card is a real-id card element under the client's own
    [data-qa='table'] and under NO playerContainer — the client's containment,
    not our geometry. Verified against the live client: across fold, deal and
    street animations every card element was either seat-owned or table-only
    (zero orphans), the board tracked turn and river through containment, and
    a fresh hand's hero faces landed seat-owned with the board empty. A deck
    has no duplicate cards, so animation double-buffers collapse by id.

    The geometric band/modal-row/>=3 stack this replaces survived on layered
    guards: hero's cards flood the 40-80px band on small layouts and recorded
    sessions show mixed-width cards sharing a y-row. Kept only as the fallback
    for a capture without the structural fields.
    """
    ac = d.get("allCards") or []
    if any("seat" in c for c in ac):
        seen: dict[str, dict] = {}
        for c in ac:
            if c.get("tbl") and c.get("seat") is None and _card_name(c.get("qa")):
                seen.setdefault(c["qa"], c)
        row = sorted(seen.values(), key=lambda c: c["x"])
        return [_card_name(c["qa"]) for c in row]
    cs = [c for c in d.get("cards", []) if _card_name(c.get("qa"))]
    if not cs:
        return []
    from collections import Counter
    ymode = Counter(round(c["y"] / 12) for c in cs).most_common(1)[0][0]
    row = sorted((c for c in cs if abs(c["y"] / 12 - ymode) < 1.01),
                 key=lambda c: c["x"])
    out: list[dict] = []
    for c in row:
        if out and c["x"] - out[-1]["x"] < 20:
            continue
        out.append(c)
    # A real board is only ever 3/4/5 cards — one or two card-shaped hits are a
    # seat's hole cards straying into the band, never the board.
    return [_card_name(c["qa"]) for c in out] if len(out) >= 3 else []


def _dom_hero_seat(d: dict) -> int | None:
    """Hero's seat NUMBER at our own table, as the client tags it (myPlayerTag).

    The one fact in this process that distinguishes our table from the other
    three: the DOM read is scoped to our `data-multitableslot` frame, so this is
    our seat at OUR table and nobody else's. `None` means the capture has not
    seen our seat yet — never "seat 1".

    THE DISPLAYED NUMBER (`num`), NOT THE CONTAINER INDEX (`seat`). `seatQa`
    carries both: `seat` is `playerContainer-N`, which is 0-based, and `num` is
    the seat number the client draws on the felt, which is 1-based and is the
    numbering the WebSocket's `seatN` keys use. _seats_structural already says
    this in as many words ("keyed by the DISPLAYED seat number to match the WS
    feed"); using the other one here meant the binder compared a 0-based seat
    with a 1-based one, so it matched nothing, dropped every frame, and left a
    live two-table session with no capture at all (2026-09-21)."""
    me = next((sq for sq in (d.get("seatQa") or []) if sq.get("me")), None)
    try:
        return int(me["num"]) if me and me.get("num") is not None else None
    except (TypeError, ValueError):
        return None


def _hero_cards(d: dict) -> list[str]:
    """Hero's hole cards.

    STRUCTURAL: the cards owned by the playerContainer carrying myPlayerTag —
    read where the client actually deals them, so they exist whenever hero is
    in the hand. The tab-strip mini path stays as fallback; it renders outside
    the table frame and recorded sessions show it blind for whole stretches
    (239 zero-mini ticks in one session while hero held cards).
    """
    ac = d.get("allCards") or []
    me = next((s.get("seat") for s in d.get("seatQa") or [] if s.get("me")), None)
    if me is not None and any("seat" in c for c in ac):
        seen: dict[str, dict] = {}
        for c in ac:
            if c.get("seat") == me and _card_name(c.get("qa")):
                seen.setdefault(c["qa"], c)
        row = sorted(seen.values(), key=lambda c: c["x"])
        if row:
            return [_card_name(c["qa"]) for c in row][:2]
    # THE TAB-STRIP MINIS ARE NOT OUR TABLE'S (2026-09-21). They are read from
    # the TOP page, outside every table iframe -- the one part of this reader
    # that cannot be scoped to a slot. At one table that is exactly why they are
    # useful (they survive stretches where the felt reads blind); at two, both
    # wrappers read the same strip and reported the SAME hole cards for both
    # tables -- observed live as 10h 8d on table 1 and table 2 at once. These
    # cards feed the exported hand, so that is an answer computed from another
    # table's holding. With a slot set the structural read is the only honest
    # one: no cards beats somebody else's cards.
    if TABLES.slot() is not None:
        return []
    minis = sorted(d.get("heroMini", []), key=lambda c: c["x"])
    out: list[dict] = []
    for c in minis:  # collapse animation double-buffers at the same spot
        if out and c["x"] - out[-1]["x"] < 8:
            continue
        out.append(c)
    return [n for n in (_card_name(c["qa"]) for c in out) if n][:2]

# The hero's real action buttons (bottom strip of the table frame). Seat chips
# also say RAISE/FOLD mid-table, so the y-band filter is what disambiguates.
_ACTION_RE = re.compile(r"^(fold|check|call|raise|bet|all[ -]?in)\b", re.I)


# The client's own control roles. Turn actions end in "Button" (but the
# between-turn pre-arm checkboxes end in "PreselectButton", and buyMoreChips is
# not an action); sizing presets end in "Selector".
_ACTION_QA = re.compile(r"^(fold|check|call|bet|raise|allIn)Button$", re.I)
_PRESET_QA = re.compile(r"Selector$")


def _split_strip(d: dict) -> tuple[list[dict], list[dict]]:
    """Split the bottom strip's buttons into (turn actions, sizing presets).

    STRUCTURAL when the buttons carry the client's data-qa: fold/call/raise/etc
    Button are actions, *Selector are sizing presets, *PreselectButton (the
    between-turn pre-arm) is neither. This is the client's own labelling, so the
    sizing ALL-IN (allInSelector) can never pose as the shove (raiseButton) and
    a pre-armed Fold never counts as a live turn. Falls back to the row-geometry
    split for captures whose buttons predate the hook."""
    tagged = [b for b in d.get("buttons", []) if b.get("qa")]
    if tagged:
        actions, presets = [], []
        for b in tagged:
            if _ACTION_QA.match(b["qa"]):
                actions.append(b)
            elif _PRESET_QA.search(b["qa"]):
                presets.append(b)
            # everything else (buyMoreChipsButton, *PreselectButton) is ignored
        seen: dict[str, dict] = {}
        for a in actions:
            seen.setdefault(a["text"].lower(), a)
        return list(seen.values()), presets

    fr = d["frame"]
    bottom = fr["y"] + fr["h"] * 0.72
    strip = [b for b in d.get("buttons", []) if b["y"] + b["h"] / 2 >= bottom]
    marker = [b for b in strip
              if re.fullmatch(r"(x[\d.,]+|[\d.,]+x|pot|min|max)", b["text"], re.I)]
    preset_y = min((b["y"] for b in marker), default=None)

    def in_preset_row(b: dict) -> bool:
        return preset_y is not None and abs(b["y"] - preset_y) <= 8

    presets = [b for b in strip
               if in_preset_row(b) and (b in marker or _ACTION_RE.match(b["text"]))]
    actions = [b for b in strip if _ACTION_RE.match(b["text"])
               and not in_preset_row(b)
               and "%" not in b["text"] and "·" not in b["text"]]
    seen: dict[str, dict] = {}
    for a in actions:
        seen.setdefault(a["text"].lower(), a)
    return list(seen.values()), presets


def _to_act(d: dict) -> bool:
    """Hero is on the clock: the client shows turn buttons, at least one with
    an amount ("CALL 5 BB") — the between-turn pre-select checkboxes never
    carry one. Same rule table_state and _feed_tick apply."""
    actions, _ = _split_strip(d)
    return bool(actions) and any(re.search(r"\d", a["text"]) for a in actions)


def table_state() -> dict:
    t = ignition_target()
    if not t:
        return {"seated": False, "reason": "poker client not open"}
    try:
        d = cdp._eval(t["webSocketDebuggerUrl"], _table_js(TABLES.dom_slot()), timeout=6) or {}
    except Exception as e:
        return {"seated": False, "reason": f"read failed: {e}"}
    if not d.get("seated"):
        return {"seated": False, "reason": "no table tab open"}
    fr, nodes = d["frame"], d.get("nodes", [])
    bottom = fr["y"] + fr["h"] * 0.72
    # Real clickable buttons in the bottom action strip. Skip the between-turn
    # PRE-SELECT checkboxes ("ALL-IN · 100%") — only turn buttons belong on the
    # panel, and only elements the client itself calls buttons are offered.
    actions, presets = _split_strip(d)
    pot = None
    for n in nodes:
        if re.match(r"^total pot", n["text"], re.I):
            right = [m for m in nodes if abs(m["y"] - n["y"]) < 10 and m["x"] > n["x"]]
            pot = min(right, key=lambda m: m["x"])["text"] if right else None
            break
    title = next((n["text"] for n in nodes
                  if re.search(r"hold'?em|omaha", n["text"], re.I) and "/" in n["text"]), None)
    # The hero's own strength label sits in the bottom strip; rank text higher
    # up is the message panel's win history — never the live hand.
    hero_hand = next((n["text"] for n in d.get("nodes", [])
                      if _RANK_RE.search(n["text"]) and len(n["text"]) < 30
                      and n["y"] >= fr["y"] + fr["h"] * 0.68), None)
    # A genuine turn always offers at least one amount-bearing button
    # ("CALL 5 BB"); the between-turn pre-select checkboxes never do.
    to_act = bool(actions) and any(re.search(r"\d", a["text"]) for a in actions)
    if not to_act:
        actions = []
    board_cards = _board_cards(d)
    return {"seated": True, "practice": d.get("practice", False), "title": title,
            "pot": pot, "toAct": to_act, "board": len(board_cards),
            "boardCards": board_cards, "heroCards": _hero_cards(d),
            "heroHand": hero_hand,
            "actionOn": _ws_state.get("actionOn"),
            "heroSeat": _ws_state.get("heroSeat"),
            "heroFolded": bool(_ws_state.get("heroFolded")),
            "position": _hero_position(),
            "heroStatus": _hero_status(d, nodes),
            "actions": [{"text": a["text"]} for a in actions],
            "presets": [{"text": p["text"]} for p in presets]}


# ---- Play-by-play hand feed (the mac panel's large-print story, DOM-diffed) ----
# Amounts render as "123.4 BB" or plain "123.4" depending on the client's
# display-units setting — accept both (bare integers can also be act-timers,
# which the geometric association rules mostly keep out of seat facts).
_MONEY_RE = re.compile(r"^[\d,]+(?:\.\d+)?(?:\s*BB)?$")
_BADGE_RE = re.compile(r"^(FOLD|CHECK|CALL|BET|RAISE|ALL[ -]?IN)$", re.I)
_RANK_RE = re.compile(
    r"high card|(?<!two )pair|two pair|three of a kind|straight flush|straight"
    r"|flush|full house|four of a kind|royal", re.I)


# ---- In-page action watcher (lossless action capture) ----
# Sampling action badges from OUT here misses anything shorter than our poll
# interval (measured 1.0-1.9s; fast folds flash quicker than that). So we
# install a watcher INSIDE the page that snapshots badges every ~120ms and
# buffers every change with its own timestamp; our poll merely drains it.
# Detection accuracy is then independent of how often we poll.
_WATCH_JS_TMPL = r"""(() => {__FRAME__
  const tf = __frame(__SLOT__);
  if (!tf || !tf.contentDocument || !tf.contentWindow) return null;
  const w = tf.contentWindow, d = tf.contentDocument;
  if (!w.__ignWatch) {
    // Full match only: the seat stat chips ("ALL-IN · 0%", "CALL · 100%") are
    // permanent fixtures, not actions, and a prefix match swallowed them.
    const BADGE = /^(FOLD|CHECK|CALL|BET|RAISE|ALL[- ]?IN)$/i;
    const MONEY = /^[\d,]+(\.\d+)?(\s*BB)?$/;
    const buf = [];
    w.__ignBuf = buf;
    // Real action badges animate through low opacities (measured peak 0.31 on
    // some), so only TRUE ghosts (opacity 0 template nodes) may be rejected.
    const vis = el => {
      if (!el) return false;
      if (w.getComputedStyle(el).visibility !== 'visible') return false;
      for (let e = el; e && e !== d.body; e = e.parentElement)
        if (+w.getComputedStyle(e).opacity < 0.05) return false;
      return true;
    };
    const snap = () => {
      const anchors = [], badges = [], money = [];
      const H = d.documentElement.clientHeight || 654;
      const wk = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = wk.nextNode())) {
        const s = (n.nodeValue || '').trim();
        if (!s || s.length > 24) continue;
        const pe = n.parentElement;
        if (!vis(pe)) continue;
        const rg = d.createRange(); rg.selectNodeContents(n);
        const b = rg.getBoundingClientRect();
        if (!b.width || !b.height || b.y > H * 0.72) continue;
        if (/^[1-9]$/.test(s) && b.width <= 16 && b.height <= 20)
          anchors.push({s, x: b.x, y: b.y});
        else if (BADGE.test(s))
          badges.push({s: s.toUpperCase().replace(/\s+/g, '-'), x: b.x, y: b.y});
        else if (MONEY.test(s)) money.push({s, x: b.x, y: b.y});
      }
      const out = {};
      for (const bd of badges) {
        let best = null, bdist = 1e9;
        for (const a of anchors) {
          const dd = Math.abs(a.x - bd.x) + Math.abs(a.y - bd.y);
          if (dd < bdist) { bdist = dd; best = a; }
        }
        if (!best || bdist > 160) continue;
        let bet = null, mdist = 1e9;
        for (const m of money) {
          const dd = Math.hypot(m.x - best.x, m.y - best.y);
          if (dd < mdist && dd < 95) { mdist = dd; bet = m.s; }
        }
        out[best.s] = {badge: bd.s, bet};
      }
      return out;
    };
    let prev = {}, lastEmit = {};
    w.__ignWatch = setInterval(() => {
      try {
        const cur = snap(), now = Date.now();
        for (const seat of Object.keys(cur)) {
          const v = cur[seat], p = prev[seat];
          if (p && p.badge === v.badge) continue;
          const k = seat + ':' + v.badge;
          if (lastEmit[k] && now - lastEmit[k] < 900) continue;  // flicker guard
          lastEmit[k] = now;
          buf.push({t: now, seat: +seat, badge: v.badge, bet: v.bet});
          if (buf.length > 300) buf.shift();
        }
        prev = cur;
      } catch (e) { /* never break the page */ }
    }, 120);
  }
  const b = w.__ignBuf || [];
  return b.splice(0, b.length);
})()"""


def _watch_js(slot: int | None = None) -> str:
    return _slotted(_WATCH_JS_TMPL, slot)




def _drain_actions() -> list[dict]:
    """Install (once) and drain the in-page action watcher."""
    t = ignition_target()
    if not t:
        return []
    try:
        return cdp._eval(t["webSocketDebuggerUrl"], _watch_js(TABLES.dom_slot()), timeout=6) or []
    except Exception:
        return []


def _seats_structural(d: dict) -> dict | None:
    """Per-seat facts from the client's containment (seatQa), or None if the
    capture predates the structural fields.

    Every value the geometric pass reconstructs by proximity is read here from
    inside the seat's own playerContainer: no anchor detection, no toward-centre
    test, no 90px radius. Keyed by the DISPLAYED seat number to match the WS
    feed and the geometric path it replaces. A seat with no displayed number or
    no stack is UI noise (a flapping ghost seat) and is dropped, exactly as
    before."""
    sq = d.get("seatQa")
    if not sq:
        return None
    out: dict[int, dict] = {}
    for s in sq:
        if s.get("empty"):
            continue
        num = s.get("num")
        stack = s.get("stack")
        if num is None or stack is None:
            continue
        bet = s.get("bet")
        # "0 BB" is not a live bet — the client shows it on every idle seat.
        if bet is not None and _pot_val(bet) == 0:
            bet = None
        out[num] = {
            "stack": stack,
            "bet": bet,
            "badge": s["badge"].replace(" ", "-") if s.get("badge") else None,
            "cards": s.get("nHole") or 0,
            # The button, read from the client's own marker — previously only
            # inferable from the WS dealer frame or the small-blind post.
            "dealer": bool(s.get("dealer")),
            # The client tags hero's own seat (myPlayerTag). Recording it means
            # nothing downstream has to INFER which seat is hero -- the previous
            # consumer guessed "the seat holding more than two cards", which
            # only worked while hero's cards were double-counted, and silently
            # anchored the whole table on seat 1 once that was fixed.
            "hero": bool(s.get("me")),
        }
    return out


def _parse_seats(d: dict) -> dict:
    """Per-seat facts: stack, the transient action badge, chips bet in front,
    and cards held. Structural when the capture carries seatQa (read straight
    from each playerContainer); otherwise the geometric fallback below groups
    the frame's text nodes by proximity to the seat-number chip."""
    # An EMPTY structural result is not an empty table — it means the capture's
    # seatQa is not the shape this reader expects, so fall through to geometry
    # rather than reporting nobody at the table. A recorded session from the
    # first (capture-only) seatQa shape had every field this pass needs absent,
    # and six seated players parsed as zero seats; a future field rename would
    # do the same to live play.
    structural = _seats_structural(d)
    if structural:
        return structural
    fr = d.get("frame")
    if not fr:
        return {}
    strip_y = fr["y"] + fr["h"] * 0.72
    cx, cy = fr["x"] + fr["w"] / 2, fr["y"] + fr["h"] / 2
    nodes = [n for n in d.get("nodes", []) if n["y"] < strip_y]
    anchors = {int(n["text"]): n for n in nodes
               if re.fullmatch(r"[1-9]", n["text"]) and n["w"] <= 16 and n["h"] <= 20}
    seats = {num: {"stack": None, "bet": None, "badge": None} for num in anchors}
    money = [n for n in nodes if _MONEY_RE.match(n["text"])]
    claimed: set[int] = set()
    for num, a in anchors.items():
        for n in money:
            if id(n) in claimed:
                continue
            if abs(n["y"] - a["y"]) <= 14 and 0 < n["x"] - a["x"] <= 110:
                seats[num]["stack"] = n["text"]
                claimed.add(id(n))
                break
    for n in money:
        if id(n) in claimed:
            continue
        num, dist = None, 1e9
        for s, a in anchors.items():
            dd = ((n["x"] - a["x"]) ** 2 + (n["y"] - a["y"]) ** 2) ** 0.5
            if dd < dist:
                num, dist = s, dd
        # Real bet chips hug their seat (<90px); the pot's chip stack sits
        # farther out toward the middle and must never read as a bet.
        if num is None or dist > 90 or seats[num]["bet"] is not None:
            continue
        a = anchors[num]
        toward_centre = (abs(n["x"] - cx) + abs(n["y"] - cy)
                         < abs(a["x"] - cx) + abs(a["y"] - cy))
        if toward_centre:
            seats[num]["bet"] = n["text"]
    for num, a in anchors.items():
        for n in nodes:
            if _BADGE_RE.match(n["text"]) and abs(n["x"] - a["x"]) <= 120 \
                    and -60 <= a["y"] - n["y"] <= 60:
                seats[num]["badge"] = n["text"].upper().replace(" ", "-")
    # Cards held by each seat (0 = folded / not dealt in). Frame-relative card
    # coords vs frame-absolute anchors, so shift the anchor to compare.
    for num, a in anchors.items():
        ax, ay = a["x"] - fr["x"], a["y"] - fr["y"]
        seats[num]["cards"] = sum(
            1 for c in d.get("allCards", [])
            if abs(c["x"] - ax) < 90 and abs(c["y"] - ay) < 90)
    # A real seat always shows a stack ("0 BB" counts); a bare digit with no
    # adjacent money node is UI noise (ghost seats that flap joined/left).
    return {num: s for num, s in seats.items() if s["stack"] is not None}


def _board_count(d: dict) -> int:
    return len(_board_cards(d))


_feed: list[dict] = []
_feed_prev: dict = {}
_hand_no = 0


def _feed_add(line: str) -> None:
    _feed.append({"t": time.strftime("%H:%M:%S"), "line": line, "hand": _hand_no})
    del _feed[:-400]


def _pot_val(pot: str | None) -> float | None:
    try:
        return float(pot.replace(",", "").split()[0])
    except (AttributeError, ValueError, IndexError):
        return None


def _verb(badge: str, bet: str | None) -> str:
    if bet is not None and _pot_val(bet) == 0:
        bet = None
    b = badge.upper()
    if b == "FOLD":
        return "folds"
    if b == "CHECK":
        return "checks"
    if b == "CALL":
        return f"calls {bet}" if bet else "calls"
    if b in ("RAISE", "BET"):
        return f"{'raises to' if b == 'RAISE' else 'bets'} {bet}" if bet else b.lower() + "s"
    return f"is ALL-IN ({bet})" if bet else "is ALL-IN"


# Per-seat debounce memory: joins/leaves need _STABLE_TICKS consistent polls
# (seat chips flicker during win animations), and a badge is only re-announced
# after it has genuinely cleared for a while.
_seat_mem: dict[int, dict] = {}
# Ticks of agreement before a seat counts as joined/left. This is a DURATION,
# not a count: at the 0.25s poll it must be ~12 to keep the ~3s of hysteresis
# that stops a seat flickering out during deal/win animations.
_STABLE_TICKS = 12
# Per-hand blind announcements (sb first, then bb, once each) + one-shot
# "Your hand" strength line (it changes every street — announcing each change
# was noise).
_hand_blinds = {"no": 0, "sb": False, "bb": False, "ticks": 0, "strength": False,
                "cards": ""}
# Street tracking: the finished hand's board lingers on screen through the win
# animation, so street counting only ARMS once the board has been seen clear.
_hand_board = {"no": 0, "max": 0, "armed": False}
# (seat, badge) already announced this betting round — the client re-renders
# badges during win/deal animations, so the same action can be re-observed.
_round_seen: set = set()
# Wall-clock until which action events are ignored: the finished hand's badges
# keep re-rendering through the deal animation and would otherwise be filed as
# the NEW hand's opening actions (seen as "BB posts, BB instantly folds").
_action_grace_until = 0.0
# Winner announcements — texts already reported (the client's message panel
# keeps old lines visible, so dedupe globally).
_wins_seen: list[str] = []
# The client's own globally-unique hand ids ("Result for hand N"), mapped to
# our local hand numbers as each hand ends.
_hand_ids: dict[int, str] = {}
_result_seen: list[str] = []


def _feed_tick() -> None:
    global _feed_prev, _hand_no, _action_grace_until
    t = ignition_target()
    if not t:
        return
    try:
        d = cdp._eval(t["webSocketDebuggerUrl"], _table_js(TABLES.dom_slot()), timeout=6) or {}
    except Exception:
        return
    if _fake_mode:
        # The authored state owns the hand's HISTORY, so the DOM-diff backfill,
        # the feed lines and the hand counter all stand down (this tick's
        # "first sighting of a table" branch was silently advancing the hand
        # number the moment the fake page loaded).
        #
        # But the per-tick SNAPSHOT is read from the table, not authored, and
        # _hand_state takes hero's cards and every seat's stack from here.
        # Returning without publishing it meant the export carried no stacks at
        # all, so answers fell back to "stacks unreadable for N seat(s) — using
        # the even 100bb chart" — and on 3-max, where the chart is CHOSEN by
        # the stack distribution, that is the wrong chart every time.
        try:
            board_cards = _board_cards(d)
            _live_status["hero"] = _hero_status(d, d.get("nodes") or [])
            _live_status["heroSeatDom"] = _dom_hero_seat(d)
            _live_status["board"] = list(board_cards)
            # the pick-to-relay path reads these for the fake table too
            _live_status["practice"] = True
            _live_status["toAct"] = _to_act(d)
            # a rendered client notice is DETECTED here (so /state.modal and the
            # pick guard can be tested), never clicked — the fake table owns its state
            _m = _modal_of(d)
            _live_status["modal"] = {"text": _m["text"], "harmless": _m["harmless"]} if _m else None
            _feed_prev = {
                "seated": True,
                "seats": _parse_seats(d),
                "board": len(board_cards),
                "heroCards": " ".join(_hero_cards(d)),
            }
        except Exception:
            pass
        return
    # Cache hero's status for /state (the poller probes at 1 Hz; this tick
    # already paid for the DOM read, so /state never needs its own eval).
    try:
        _live_status["hero"] = _hero_status(d, d.get("nodes") or [])
    except Exception:
        pass
    # WHICH SEAT IS HERO'S, AT OUR OWN TABLE — the client's own tag, read inside
    # our slot's frame. It is what tells the tap which of the page's sockets is
    # ours (see _tap_accepts), so it is published before anything else uses this
    # tick, and the tap is checked against hero's cards while we are here.
    try:
        _live_status["heroSeatDom"] = _dom_hero_seat(d)
        _tap_verify(_hero_cards(d))
    except Exception:
        pass
    # The Buy-chips panel, straight off this tick's buttons — the one fact
    # _maybe_guard_buy_panel() needs and the only one our own flag got wrong
    # (hand 513). `modal` above only matches the client's data-qa=modal.action.*
    # notices, which this panel is not.
    try:
        _live_status["buyPanel"] = any(
            str(b.get("qa") or "") == "buyInButton" for b in (d.get("buttons") or []))
    except Exception:
        pass
    p = _feed_prev
    if not d.get("seated"):
        if p.get("seated"):
            _feed_add("table closed")
            # No next PLAY_STAGE_INFO will ever come — flush the in-progress
            # hand to the history now or it is lost with the table.
            _archive_hand()
            _feed_prev = {}
            _seat_mem.clear()
        return

    # The table-broke interstitial renders in the table's middle band. The
    # message feed at the BOTTOM must not trip this: "Player 5 has joined you
    # from another table with $1.45" matches the regex, persists for as long
    # as the message shows, and classified every tick as waiting — freezing
    # the feed, the archiver and the debug recorder mid-session while the WS
    # tap carried on. Position, not wording, is what separates the two.
    _fr = d.get("frame") or {}
    _mid = _fr.get("y", 0) + _fr.get("h", 0) * 0.7
    waiting = any(re.search(r"please wait|another table", n["text"], re.I)
                  and n["y"] < _mid
                  for n in d.get("nodes", []))
    if waiting:
        if not p.get("waiting"):
            _feed_add("table broke — waiting for a new table…")
        _feed_prev = {"seated": True, "waiting": True}
        _seat_mem.clear()
        return

    # Drain the in-page watcher FIRST so nothing is lost while we parse.
    events = _drain_actions()
    seats = _parse_seats(d)
    board_cards = _board_cards(d)
    board = len(board_cards)
    hero_cards = _hero_cards(d)
    actions, _ = _split_strip(d)
    pot = None
    for n in d.get("nodes", []):
        if re.match(r"^total pot", n["text"], re.I):
            right = [m for m in d["nodes"] if abs(m["y"] - n["y"]) < 10 and m["x"] > n["x"]]
            pot = min(right, key=lambda m: m["x"])["text"] if right else None
            break
    fr = d["frame"]
    hero_hand = next((n["text"] for n in d.get("nodes", [])
                      if _RANK_RE.search(n["text"]) and len(n["text"]) < 30
                      and n["y"] >= fr["y"] + fr["h"] * 0.68), None)
    to_act = bool(actions) and any(re.search(r"\d", a["text"]) for a in actions)
    # Published for /hand: the client's own action buttons are the ground
    # truth for "hero to act" when the WS missed the villain action that put
    # hero on the clock (see _hand_state).
    _live_status["toAct"] = to_act
    # how long the buttons have been up without a break (0.25 s ticks): a
    # button strip that HOLDS is hero's turn whatever the event log thinks
    if to_act:
        _live_status["toActSince"] = _live_status.get("toActSince") or time.time()
    else:
        _live_status["toActSince"] = None
    # which seats have held cards this hand — a seat that never did cannot fold
    # (the phantom end-of-hand folds the shadow diff exposed: 202818/9,14,16,17)
    if time.time() >= _ws_state.get("domGraceUntil", 0):
        held = _ws_state.setdefault("heldCards", set())
        for _num, _cs in seats.items():
            if (_cs.get("cards") or 0) >= 1:
                held.add(_num)
    # the client's own top-up receipt ("You have successfully added $5 in
    # chips.") — the definitive word that a buy went through, whatever the
    # Buy-chips panel looked like to the reader. RISING EDGE only: the client
    # keeps the line in its message history, so a receipt counts when it
    # APPEARS, not while it sits there (session 100647: the $200 sit-down
    # receipt re-fired every 60 s for the whole session).
    now_receipts = set()
    for n in d.get("nodes", []):
        if m := re.search(r"successfully added \$?([\d,]+(?:\.\d+)?) in chips", n["text"], re.I):
            now_receipts.add(n["text"].strip())
    for txt in now_receipts - _live_status.get("receipts", set()):
        _top_up_receipt(re.search(r"\$?([\d,]+(?:\.\d+)?) in chips", txt, re.I).group(1))
    _live_status["receipts"] = now_receipts
    # CROSS-CHECK the independent views of "hero to act" every tick
    _state_check(to_act, seats)
    # the client's modal notices: a known-harmless one is dismissed, any other
    # is reported (never clicked blind) — and while one is up, no pick is relayed
    _handle_modal(d)
    # The client's "+45s" time-bank button, when it is on the strip (the clock is
    # at ~9 s). Kept as its box so _maybe_take_time can press it without another
    # read. _split_strip never counts it as an action — it carries no action word.
    _live_status["timeBank"] = next((b for b in d.get("buttons", [])
                                     if re.fullmatch(r"\+\d+s", (b.get("text") or "").strip())), None)
    # Practice-money table (the iframe's playMode=fun) — the only kind the
    # pick-to-relay auto mode may arm on (see _maybe_auto_act).
    _live_status["practice"] = bool(d.get("practice"))
    cur = {"seated": True, "seats": seats, "board": board, "pot": pot,
           "heroHand": hero_hand, "toAct": to_act,
           "heroCards": " ".join(hero_cards)}

    first = not p.get("seated") or p.get("waiting")
    if first:
        # THE HAND KEEPS ITS ID ACROSS A DOM "TABLE OPENED" TICK (2026-09-23, hand 4919910444 /
        # dashboard 714, the −82 bb 55-vs-KQ hand). One tick read the table as not-seated/waiting
        # in the MIDDLE of a hand the WebSocket had already opened; the counter moved on here, the
        # id stayed behind on the old number, and the whole hand was archived with clientHandId
        # null — no join to its answers, no cross-process dedupe. The counter still moves (the
        # DOM-side dedupe keys on it) but a hand in flight takes its id with it.
        carried = (_hand_ids.get(_hand_no)
                   if _ws_state.get("dealt") and not _ws_state.get("handOver") else None)
        _hand_no += 1
        if carried:
            _hand_ids[_hand_no] = carried
            _feed_add(f"(table re-read mid-hand — hand id {carried} kept)")
        title = next((n["text"] for n in d.get("nodes", [])
                      if re.search(r"hold'?em|omaha", n["text"], re.I)), "table")
        _feed_add(f"Table opened — {title}")
        # Absorb the message panel's HISTORY of win lines and hand-result ids
        # silently — only ones appearing after this point are news.
        for n in d.get("nodes", []):
            if re.search(r"\bwins?\b.*pot", n["text"], re.I) \
                    and n["text"] not in _wins_seen:
                _wins_seen.append(n["text"])
            if m := re.search(r"result for hand\s*(\d+)", n["text"], re.I):
                if m.group(1) not in _result_seen:
                    _result_seen.append(m.group(1))
        del _wins_seen[:-80]
        del _result_seen[:-80]

    # Presence debounce.
    for num in set(seats) | set(_seat_mem):
        m = _seat_mem.setdefault(num, {"present": 0, "absent": 0,
                                       "on": first and num in seats,
                                       "badge": None, "badge_gone": 0,
                                       "emitted": set()})
        if num in seats:
            m["present"], m["absent"] = m["present"] + 1, 0
            if not m["on"] and m["present"] >= _STABLE_TICKS:
                m["on"] = True  # presence tracked, not announced (see below)
        else:
            m["absent"], m["present"] = m["absent"] + 1, 0
            if m["on"] and m["absent"] >= _STABLE_TICKS:
                m["on"] = False
                m["badge"], m["badge_gone"] = None, 0
        # Seat joins/leaves are deliberately NOT announced: they are read from
        # the DOM (the one thing still inferred) and flicker during deal/win
        # animations, and a seat changing is not part of a hand's story.

    if not first:
        # Hand boundary, in order of reliability:
        # 1) the client's own "Result for hand N" line (authoritative, and it
        #    stamps the unique id onto the hand that just finished);
        # 2) the board cleared;
        # 3) the pot collapsed to a fraction of itself (unit-agnostic — the
        #    client can display BB or dollars).
        # Hand ids + boundaries come from PLAY_STAGE_INFO on the WebSocket; the
        # chat-panel scan here only persists the id map for debug recordings.
        id_boundary = False
        for n in d.get("nodes", []):
            if m := re.search(r"result for hand\s*(\d+)", n["text"], re.I):
                hid = m.group(1)
                # THE CLIENT'S AWARD (2026-09-19): the row under "Result for hand N"
                # says "Player S wins ($X)" — the winner's seat and the amount, rake
                # already off. Kept per hand id and written into the archive
                # (result.winnerSeat / wonCents / heroWon), which is what the
                # dashboard's net uses from now on instead of chaining stacks.
                _note_award(hid, n, d.get("nodes", []))
                if hid not in _result_seen:
                    _result_seen.append(hid)
                    del _result_seen[:-80]
                    if _dbg["on"] and _dbg["dir"]:
                        try:
                            with open(os.path.join(_dbg["dir"], "hand_ids.json"),
                                      "w", encoding="utf-8") as fh:
                                json.dump(_hand_ids, fh)
                        except Exception:
                            pass
        # The client's own hand id is authoritative; a cleared board is the only
        # other trustworthy signal. The pot-collapse heuristic fired on mid-hand
        # animations and split single hands into three, so it's gone.
        young = _hand_blinds["no"] == _hand_no and _hand_blinds["ticks"] <= 12
        new_hand = id_boundary or (
            not young and p.get("board", 0) >= 3 and board == 0)
        street_up = board > p.get("board", 0) and board in (3, 4, 5)
        if new_hand:
            # Hand numbering + the "new hand" line come from PLAY_STAGE_INFO on
            # the WebSocket now; this only resets local per-hand bookkeeping.
            _round_seen.clear()
            events = []
            _action_grace_until = time.time() + 2.0
            # ABSORB whatever badges are still on screen — they belong to the
            # finished hand and must not re-announce into this one.
            for num, m in _seat_mem.items():
                b = seats.get(num, {}).get("badge")
                m["badge"], m["badge_gone"] = b, 0
                m["emitted"] = {b} if b else set()
        # Street markers: only ARM once this hand's board has been seen clear —
        # the previous hand's five cards linger through the win animation.
        if _hand_board["no"] != _hand_no:
            _hand_board.update({"no": _hand_no, "max": 0, "armed": board < 3})
        if board < 3:
            _hand_board["armed"] = True
        if not new_hand and _hand_board["armed"] and board in (3, 4, 5) \
                and board > _hand_board["max"]:
            _hand_board["max"] = board
            _round_seen.clear()  # a new street = a fresh betting round
            # (street banner itself is emitted from CO_BCARD1_INFO)
        # (hole cards come from CO_PCARD_INFO on the WebSocket)
        # Blind posts open the hand's story: watch the hand's first seconds for
        # the 0.5 BB then 1 BB posts (they can render a tick or two after the
        # hand boundary fires, so the boundary tick alone isn't enough).
        if _hand_blinds["no"] != _hand_no:
            _hand_blinds.update({"no": _hand_no, "sb": False, "bb": False,
                                 "ticks": 0, "strength": False, "cards": ""})
        _hand_blinds["ticks"] += 1
        # (blind posts come from CO_BLIND_INFO on the WebSocket)
        # Winner lines — the client prints "… wins main pot (…) with (…)" as
        # text; prefix the neighbouring name node when there is one.
        for n in d.get("nodes", []):
            txt = n["text"]
            if re.search(r"\bwins?\b.*pot", txt, re.I) and txt not in _wins_seen:
                _wins_seen.append(txt)
                del _wins_seen[:-60]
                # the winner's name node TOUCHES the win text (gap 0 on 37 of 43
                # recorded awards) — a strictly positive gap dropped it on every
                # showdown, and a nameless "★ wins" line then read as HERO's
                # win downstream (hand 4919174586, 2026-09-19)
                name = _award_name(n, [m for m in d["nodes"] if abs(m["y"] - n["y"]) <= 8])
                _feed_add(("★ " + (name + " " if name else "") + txt).strip())
        # Actions are derived from PERSISTENT STATE DELTAS, not from transient
        # badges. A fold is "this seat's cards are gone"; a bet/raise/call is
        # "this seat's committed chips went up". Those states survive until
        # something else changes them, so a missed poll delays a line but never
        # loses it — and an animation replaying a badge can't invent one.
        # The WebSocket tap is the PRIMARY action source (exact, instant) but
        # it dies across Zone table hops and misses whatever happened in the
        # gap. The DOM diff below BACKFILLS those actions into the same
        # structured log + feed, deduped via the shared _act_seen keys —
        # whichever source reports an action first wins. It also re-syncs
        # committed/maxBet so the tap's math is coherent when it resumes.
        prev_seats = p.get("seats") or {}
        if time.time() < _ws_state.get("domGraceUntil", 0):
            prev_seats = {}  # deal animation — the previous hand's pixels lie
        bbc = _ws_state.get("bb") or 0
        bb_known = bool(bbc and _ws_state.get("bbSeen"))
        hero_seat = _ws_state.get("heroSeat")
        if to_act:
            _ws_state["heroToActAt"] = time.time()
            _ws_state["heroToActPot"] = _pot_val(pot)
        # THE HAND-END WIPE. When a hand ends the client clears the pot and
        # every seat's cards in one tick. Read as a seat diff, "cards gone" is
        # a fold — so every villain still in the hand was filed as folding at
        # the end of EVERY hand (session_20260912_140454: 15/15 hands "won
        # uncontested", +182bb of fiction; even the A5 showdown logged "Seat 1
        # folds" after "wins main pot"). A wipe is not an action. What it can
        # tell us is HERO's fold: the reader never reads hero's own seat, and
        # the WS emitted no fold for hero this session — but a hand that ends
        # within a couple of seconds of hero being on the clock, with no hero
        # action recorded since and no showdown, ended because hero folded.
        wipe = (pot is None and bool(seats)
                and all((cs.get("cards") or 0) == 0 for cs in seats.values())
                and any((old.get("cards") or 0) >= 1 for old in prev_seats.values()))
        if wipe:
            to_act_at = _ws_state.get("heroToActAt") or 0.0
            acted_at = _ws_state.get("heroLastActAt") or 0.0
            hand_lines = [f["line"] for f in _feed if f.get("hand") == _hand_no]
            showdown = any(re.search(r"\bshows\b|\bwins?\b.*pot", ln) for ln in hand_lines)
            # A hero RAISE the WS missed looks the same by timing (prompt →
            # villain folds → wipe, all within seconds). The pot tells them
            # apart: a fold leaves it where the prompt found it, a raise or
            # call grows it before the wipe.
            pot_at_prompt = _ws_state.get("heroToActPot")
            pot_before_wipe = _pot_val(p.get("pot"))
            pot_grew = (pot_at_prompt is not None and pot_before_wipe is not None
                        and pot_before_wipe > pot_at_prompt + 0.05)
            if (hero_seat is not None and not _ws_state.get("heroFolded")
                    and time.time() - to_act_at <= 3.0 and acted_at < to_act_at
                    and not showdown and not pot_grew
                    and not _act_seen(("fold", hero_seat))):
                # the street hero folded on = the board the PREVIOUS tick showed
                # (this tick's board is already wiped)
                nb = p.get("board", 0) or 0
                street_prev = ("river" if nb >= 5 else "turn" if nb == 4
                               else "flop" if nb == 3 else "preflop")
                _ws_state["heroFolded"] = True
                _ws_state.setdefault("foldedSeats", set()).add(hero_seat)
                _act_add(hero_seat, "fold", street=street_prev)
                _feed_add(f"Seat {hero_seat} folds (you — hand ended on your turn)")
            prev_seats = {}   # nothing else in this tick is an action

        def dom_cents(v: float | None) -> int | None:
            return int(round(v * bbc)) if bb_known and v is not None else None

        # The DOM's OWN street — during a tap gap the WS board is stale, and
        # backfilled actions stamped with the wrong street corrupt the walk.
        street_dom = ("river" if len(board_cards) >= 5 else
                      "turn" if len(board_cards) == 4 else
                      "flop" if len(board_cards) == 3 else "preflop")
        # Published for /hand: when the WS board is BEHIND (missed street
        # message), the export can use the DOM's board instead of solving a
        # closed preflop line while hero stares at a flop.
        _live_status["board"] = list(board_cards)
        folded_seats = _ws_state.setdefault("foldedSeats", set())
        prev_max = max((_pot_val(s.get("bet")) or 0
                        for s in prev_seats.values()), default=0.0)
        for num in sorted(seats):
            cs, old = seats[num], prev_seats.get(num)
            # Folded seats keep their FOLD badge (and empty cards) for the
            # rest of the hand — without this guard every street-reset of the
            # dedupe keys re-filed a phantom fold for them.
            if not old or num in folded_seats:
                continue
            # HERO's seat is off-limits for DOM action detection: the action
            # panel (CHECK/FOLD buttons, pre-selects) renders near hero's
            # seat anchor and its text reads as a "badge" — observed live as
            # a phantom hero check while FACING A RAISE. The WS tap owns
            # hero's actions; a hero action missed in a tap gap lands in the
            # last-resort AI net instead of poisoning the line.
            if num == _ws_state.get("heroSeat"):
                continue
            badge = (cs.get("badge") or "").upper()
            ob_badge = (old.get("badge") or "").upper()
            oc, cc = old.get("cards", 0), cs.get("cards", 0)
            # Badges are EDGE-detected (changed since last tick) — a lingering
            # badge is old news, not a new action. A FOLD badge must also HOLD
            # for two ticks: the client flashes a seat's OLD fold label for a
            # single tick with the cards still showing (12 times in the
            # 2026-09-18 session), and one such flash filed "Seat 5 folds" on a
            # seat that then 3-bet — the 3-bet was dropped as a ghost, the line
            # closed as "everyone folded", and hero folded a hand it was told it
            # had won (hand 368). A real fold's badge stays for the whole hand,
            # so the second tick costs 250 ms and nothing else.
            ticks = _ws_state.setdefault("foldTicks", {})
            ticks[num] = ticks.get(num, 0) + 1 if badge == "FOLD" else 0
            # a seat that never held cards this hand has nothing to fold: its
            # FOLD label is the previous hand's, or a sitter's (2026-09-19)
            if num not in _ws_state.get("heldCards", set()):
                continue
            if ((badge == "FOLD" and ticks[num] == 2) or (oc >= 1 and cc == 0)) \
                    and not _act_seen(("fold", num)):
                folded_seats.add(num)
                # a DOM fold is a guess, not a report: chips from the seat on the
                # WebSocket later prove it wrong and retract it (_ws_action)
                _ws_state.setdefault("domFolds", set()).add(num)
                if num == _ws_state.get("heroSeat"):
                    _ws_state["heroFolded"] = True
                _act_add(num, "fold", street=street_dom)
                _feed_add(f"Seat {num} folds")
                continue
            if badge == "CHECK" and ob_badge != "CHECK" and not _act_seen(("check", num)):
                _act_add(num, "check", street=street_dom)
                _feed_add(f"Seat {num} checks")
                continue
            # A missing bet reading means UNKNOWN, never zero: treating it as
            # zero turned any stray money label (a seat's STACK drifting into
            # the bet slot for one tick) into a huge phantom raise — observed
            # live as "raises to 97.5". The DOM therefore never reports a
            # street's first bet; the WS tap owns those.
            ob, cb = _pot_val(old.get("bet")), _pot_val(cs.get("bet"))
            if ob is None or cb is None or cb <= ob + 1e-9:
                continue
            total_c = dom_cents(cb)
            if total_c is None or _act_seen(_mkey(num, total_c)):
                continue
            # READ-ONLY with respect to the WS bookkeeping: a DOM misread that
            # synced committed/maxBet once poisoned every later WS amount in
            # the hand (a phantom 11bb raise turned a real 8.28 bet into a
            # recorded 19.28). The backfill contributes actions, never math.
            com = _ws_state.get("committed") or {}
            top_c = _ws_state.get("maxBet", 0)
            # An action must INCREASE the seat's committed total. A label that
            # doesn't (the DOM showing the 1.6 top-up while the WS already
            # booked the 2.0 total) is an echo of a recorded action — filing
            # it produced a duplicate call with a NEGATIVE amount that walked
            # the line past its close.
            if total_c <= (com.get(num, 0) or 0):
                continue
            if (_pot_val(cs.get("stack")) or 0) == 0:
                _act_add(num, "all-in", total_c, street=street_dom)
                _feed_add(f"Seat {num} is ALL-IN ({cs['bet']})")
            elif total_c > max(top_c, dom_cents(prev_max) or 0):
                kind = "raise" if prev_max > 0 or top_c > (dom_cents(1.0) or 0) else "bet"
                _act_add(num, kind, total_c, street=street_dom)
                _feed_add(f"Seat {num} {'raises to' if kind == 'raise' else 'bets'} {cs['bet']}")
            else:
                _act_add(num, "call", total_c - (com.get(num, 0) or 0), street=street_dom)
                _feed_add(f"Seat {num} calls {cs['bet']}")
        if cur["toAct"] and not p.get("toAct"):
            _feed_add("YOUR TURN: " + " / ".join(
                a["text"] for a in actions if "%" not in a["text"]))
        if hero_hand and hero_hand != p.get("heroHand") \
                and not _hand_blinds["strength"]:
            _hand_blinds["strength"] = True
            _feed_add(f"Your hand: {hero_hand}")
    _shadow_tick({"hand": _hand_no, "pot": pot, "board": board_cards, "seats": seats,
                  "actions": [a["text"] for a in actions]})
    _dbg_record(t["webSocketDebuggerUrl"], {
        "hand": _hand_no, "pot": pot, "board": board_cards,
        "heroCards": hero_cards, "toAct": to_act, "seats": seats,
        "actions": [a["text"] for a in actions], "events": events,
        # the independent "hero to act" views this tick, and hero's status, so
        # a replay can re-run the state check (tests/replay_status.py)
        "toActSrc": _to_act_sources(to_act),
        "heroStatus": _live_status.get("hero"),
        # The whole hand's story, not the last four lines. Four dropped the
        # blind posts from every hand with more than two actions, which reads
        # as "the reader missed the blinds" when it had them all along.
        "feedTail": [line["line"] for line in _feed[-40:]],
        # What the panel was actually recommending at this moment — the study
        # answer as pushed by the poller and shown/spoken to the player. Until
        # this rode along, a recording could say what the TABLE showed but not
        # what WE said about it, so "was the live advice right?" was
        # unanswerable in review. None when answers are off or stale.
        "liveAnswer": ({"text": _study["text"], "pick": _study["pick"],
                        "roll": _study["roll"], **(_study.get("prov") or {})}
                       if _study.get("text") else None)},
        raw=d)
    _feed_prev = cur


# ---- Debug recorder: frame + parsed state + feed tail per tick ----
# The ground truth for chasing misread actions: each tick's EXACT screenshot
# paired with what the parser made of it and what the feed said.
_dbg = {"on": False, "dir": None, "seq": 0}


def set_debug(on: bool) -> dict:
    if on and not _dbg["on"]:
        _prune_debug()
        # Under the session's own id when a session is on and nothing is
        # there yet — one key for the archive, the answers, the solves and
        # the frames. A second recording in the same session gets a timestamp.
        sid = _session["id"]
        name = sid if sid and not (ROOT / "debug" / sid).exists() else time.strftime("session_%Y%m%d_%H%M%S")
        d = ROOT / "debug" / name
        d.mkdir(parents=True, exist_ok=True)
        _dbg.update({"on": True, "dir": str(d), "seq": 0})
        print(f"[debug] recording to {d}")
    elif not on and _dbg["on"]:
        _dbg["on"] = False
        print(f"[debug] stopped — {_dbg['seq']} frames in {_dbg['dir']}")
    return {"on": _dbg["on"], "dir": _dbg["dir"], "frames": _dbg["seq"]}


def _shot_jpeg(ws: str, out: str, quality: int = 40) -> bool:
    """Screenshot as JPEG, capturing the composited frame as-is.

    NO `clip`. A clip whose scale is not 1 makes Chrome apply a device-metrics
    override, relayout the page at that scale, capture, then clear the
    override — on a HEADED window that is a visible resize and snap-back, and
    at the feed's 4 Hz tick it strobes the table the user is playing on. The
    panel's live mirror (scout/cdp.screenshot) has always passed no clip and
    has never flashed; this now matches it.

    Quality now carries the whole size budget, since without a clip there is
    no downscale left to apply. Measured against the live client at q40: 63 KB
    per frame, 117 ms per capture. At the feed's 4 Hz that is ~900 MB/hour, so
    DEBUG_BUDGET_MB (2000) holds roughly two hours before pruning oldest-first.
    Lower `quality` to trade fidelity for hours; the flash does not come back
    either way, because quality is a pure encoder setting that never touches
    layout. Do NOT reintroduce a scaled clip to win the space back.
    """
    import base64
    import websocket
    conn = websocket.create_connection(ws, timeout=8, suppress_origin=True)
    try:
        conn.send(json.dumps({"id": 1, "method": "Page.captureScreenshot",
                              "params": {"format": "jpeg", "quality": quality}}))
        for _ in range(30):
            m = json.loads(conn.recv())
            if m.get("id") == 1:
                data = m.get("result", {}).get("data")
                if not data:
                    return False
                with open(out, "wb") as fh:
                    fh.write(base64.b64decode(data))
                return True
    finally:
        conn.close()
    return False


# Retention: recordings are debugging scratch, not archives. Prune oldest
# sessions so the debug folder never exceeds this budget.
DEBUG_BUDGET_MB = int(os.environ.get("DEBUG_BUDGET_MB", "2000"))


def _prune_debug() -> None:
    base = ROOT / "debug"
    if not base.exists():
        return
    sess = sorted((d for d in base.iterdir()
                   if d.is_dir() and d.name.startswith("session_")),
                  key=lambda d: d.name)
    def size(d: Path) -> int:
        return sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
    total = sum(size(d) for d in sess)
    budget = DEBUG_BUDGET_MB * 1024 * 1024
    # Never prune the newest 2 sessions, or one you annotated with a note.
    for d in sess[:-2]:
        if total <= budget:
            break
        if (d / "note.txt").exists():
            continue
        sz = size(d)
        try:
            import shutil
            shutil.rmtree(d)
            total -= sz
            print(f"[debug] pruned {d.name} ({sz/1e6:.0f} MB) to stay under "
                  f"{DEBUG_BUDGET_MB} MB")
        except Exception:
            pass


def _dbg_dom(seq: int, raw: dict | None) -> bool:
    """Persist the tick's UNPARSED _TABLE_JS output, keyed by the same seq as
    log.jsonl and the frame.

    log.jsonl records what we MADE of the client; this is what the client
    actually handed us. Only the raw form can (a) replay real DOM through the
    reader in a test and (b) serve as the parity target a replica has to hit —
    neither is reachable from parsed output, and neither can be recovered after
    the fact, so it is captured whenever the recorder runs. Sibling file rather
    than extra keys so log.jsonl stays skimmable by eye.
    """
    if not raw:
        return False
    try:
        with open(os.path.join(_dbg["dir"], "dom.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"seq": seq, **raw}, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False


def _dbg_record(ws: str, state: dict, raw: dict | None = None) -> None:
    if not (_dbg["on"] and _dbg["dir"]):
        return
    try:
        seq = _dbg["seq"]
        _dbg["seq"] += 1
        img = f"f{seq:05d}.jpg"
        _shot_jpeg(ws, os.path.join(_dbg["dir"], img))
        dom = _dbg_dom(seq, raw)
        with open(os.path.join(_dbg["dir"], "log.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"seq": seq, "t": time.strftime("%H:%M:%S"),
                                 "ts": round(time.time(), 2), "png": img,
                                 "dom": dom, **state},
                                ensure_ascii=False) + "\n")
    except Exception:
        pass  # never let the recorder break the feed


def recordings() -> list[dict]:
    """Saved debug sessions with their time range, frame count, captured hand
    ids, and the user's annotation note."""
    base = ROOT / "debug"
    out: list[dict] = []
    if not base.exists():
        return out
    for d in sorted(base.iterdir(), reverse=True):
        if not d.is_dir() or not d.name.startswith("session_"):
            continue
        frames, t0, t1 = 0, None, None
        log = d / "log.jsonl"
        if log.exists():
            try:
                lines = log.read_text(encoding="utf-8").strip().splitlines()
                frames = len(lines)
                if lines:
                    t0 = json.loads(lines[0]).get("t")
                    t1 = json.loads(lines[-1]).get("t")
            except Exception:
                pass
        ids, note = {}, ""
        try:
            if (hj := d / "hand_ids.json").exists():
                ids = json.loads(hj.read_text(encoding="utf-8"))
            if (nf := d / "note.txt").exists():
                note = nf.read_text(encoding="utf-8")
        except Exception:
            pass
        out.append({"name": d.name, "frames": frames, "start": t0, "end": t1,
                    "handIds": ids, "note": note})
    return out


def _session_dir(session: str) -> Path | None:
    """Validated path to a recording folder (no traversal)."""
    if not re.fullmatch(r"session_[\d_]+", session):
        return None
    d = ROOT / "debug" / session
    return d if d.is_dir() else None


def rec_log(session: str) -> list[dict]:
    """Every frame's parsed state for one recording."""
    d = _session_dir(session)
    if not d or not (log := d / "log.jsonl").exists():
        return []
    out = []
    for line in log.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def rec_frame(session: str, seq: int) -> tuple[bytes, str] | None:
    d = _session_dir(session)
    if not d:
        return None
    for ext, ctype in ((".jpg", "image/jpeg"), (".png", "image/png")):
        p = d / f"f{seq:05d}{ext}"
        if p.exists():
            return p.read_bytes(), ctype
    return None


def save_note(session: str, note: str) -> dict:
    if not re.fullmatch(r"session_[\d_]+", session):
        return {"ok": False, "reason": "bad session name"}
    d = ROOT / "debug" / session
    if not d.is_dir():
        return {"ok": False, "reason": "no such session"}
    (d / "note.txt").write_text(note[:4000], encoding="utf-8")
    return {"ok": True}


# ---- Authoritative game feed from the client's own WebSocket ----
# The client receives plain-JSON game messages; reading them turns actions from
# something we INFER off animated pixels into discrete events with exact seat,
# amounts and hand id. Every misread class we fought (replayed badges, phantom
# calls, missed folds, reordered board cards) is structurally impossible here.
# btn is a bitmask; values learned by correlating live messages with amounts.
# Verified against live play: seats sending 64 keep acting on later streets
# (only possible if still in the hand) while seats sending 1024 disappear.
_BTN = {64: "checks", 1024: "folds", 256: "calls", 4096: "raises to",
        2048: "is ALL-IN"}
_BLIND_BTN = {2: "small blind", 4: "big blind", 8: "post"}
_ws_state: dict = {"bb": 0, "board": [], "pot": None}


def _street_now() -> str:
    """The street, from how FAR the board reaches — not how many cards we happen to hold (2026-09-21).

    CO_BCARD1_INFO writes the turn and river at their own positions, padding with None for anything missing,
    so a hand whose flop message was dropped holds [None, None, None, 'Ts']. Counting non-empty cards calls
    that ONE card and therefore "preflop", and every action from the turn onward is stamped preflop — which
    is what produces the nonsense preflop lines ("F-F-F-F-F", a seat acting five times) that make the spot
    unsolvable downstream. The furthest filled position is the street whatever gaps precede it."""
    b = _ws_state.get("board") or []
    n = max((i + 1 for i, c in enumerate(b) if c), default=0)
    return "river" if n >= 5 else "turn" if n == 4 else "flop" if n == 3 else "preflop"


_STREET_RANK = {"preflop": 0, "flop": 1, "turn": 2, "river": 3}


def _street_monotonic(st: str) -> str:
    """A hand's streets only ever go FORWARD (2026-09-21).

    `_street_now()` reads the WS board, and the tap can lag a street change by a tick or two — the docstring
    on _act_add already says as much. When it does, a new action is stamped with the PREVIOUS street, and the
    exported hand then carries flop actions sitting after turn actions. Downstream that is not noise: the
    solver rebuilds the betting line per street, so a mis-streeted action puts chips on the wrong street and
    the spot cannot be solved at all (hand 4919433077, 2026-09-20, and 30 "preflop betting didn't close"
    failures inside eleven minutes of one session).

    Streets are monotonic within a hand by the rules of the game, so a defaulted stamp is clamped to the
    furthest street this hand has already reached. Only the DEFAULT is clamped: the DOM backfill passes its
    own `street` explicitly, precisely because it discovers earlier actions late, and that stays untouched.
    """
    seen = _ws_state.get("actions") or []
    if not seen:
        return st
    high = max((_STREET_RANK.get(a.get("street") or "preflop", 0) for a in seen), default=0)
    return st if _STREET_RANK.get(st, 0) >= high else next(
        k for k, v in _STREET_RANK.items() if v == high)


def _act_add(seat: int | None, kind: str, cents: int | None = None,
             street: str | None = None) -> None:
    """Structured mirror of the feed lines, for the /hand export. Amounts stay
    in wire cents — the BB scale may only be learned mid-hand, so conversion
    happens at export time. `street` lets the DOM backfill stamp its OWN board
    state — during a tap gap the WS board is stale."""
    if seat is None:
        return
    _ws_state.setdefault("actions", []).append(
        {"seat": seat, "type": kind, "cents": cents,
         "street": street if street else _street_monotonic(_street_now())})
    if seat == _ws_state.get("heroSeat"):
        _ws_state["heroLastActAt"] = time.time()   # see the hand-end wipe in _feed_tick


def _act_seen(key: tuple) -> bool:
    """Cross-source dedupe for one betting round: the WS tap and the DOM diff
    both observe actions, and whichever reports first wins. Keys: ('fold'|
    'check', seat) for the unique actions, _mkey(seat, cents) for money
    actions. Cleared with the round (new hand / new street)."""
    seen = _ws_state.setdefault("actSeen", set())
    if key in seen:
        return True
    seen.add(key)
    return False


def _mkey(seat: int | None, cents: int) -> tuple:
    """Money-action dedupe key: committed total rounded to the nearest 5 wire
    cents — the DOM displays ROUNDED amounts (1.7 BB) while the WS has exact
    ones (1.72 BB), and exact-cent keys let the same action through twice."""
    return (seat, int(round(cents / 5)))


def _refeed_blind_guess() -> None:
    """Re-render feed lines printed while the big blind was only a guess.

    Just the small-blind post in practice: it is the one line emitted between
    the SB frame and the BB frame that carries a BB-denominated amount. Its
    raw cents were stashed when it was written, so this reformats from the
    source number rather than trying to parse the wrong text back out."""
    for line in _feed:
        cents = line.get("guessCents")
        if cents is None:
            continue
        line["line"] = re.sub(r"\(([^)]*)\)$", f"({_amt(cents)})", line["line"])
        line.pop("guessCents", None)


def _amt(cents: int | None) -> str:
    """Format a wire amount (cents) in big blinds when the BB is known."""
    if cents is None:
        return "?"
    bb = _ws_state.get("bb") or 0
    if bb and _ws_state.get("bbSeen"):
        v = cents / bb
        return f"{v:.2f}".rstrip("0").rstrip(".") + " BB"
    # Until this hand's big blind is observed, show the raw stake rather than
    # scaling by a blind size that may belong to a different table.
    return f"{cents / 100:.2f}"


# ---- WS message dump (debugging) -------------------------------------------
# Every game-protocol frame the tap receives, with the OUTCOME of processing
# it — "ok", or the exact guard that dropped it. A missed action then reads as
# DATA ("dropped: ghost-guard …") instead of an absence nobody can explain
# after the fact. Ring buffer feeds the panel's "WS message dump" card;
# debug/ws_dump.jsonl keeps the full history for post-mortems (rotated at
# ~20 MB). Tap lifecycle markers ("<tap-connected>" / "<tap-lost>") land in the
# same stream, so a blind window shows exactly which frames it swallowed.
# ONE FILE PER SLOT. Four wrappers sharing one dump interleave four hand
# counters into one stream, so the same frame appears twice under two different
# hand numbers and no post-mortem can tell whose it was. That is not a cosmetic
# problem: it is how the 2026-09-21 session's dump hid, for an hour, the fact
# that BOTH wrappers were processing BOTH tables' sockets.
_WS_DUMP_PATH = ROOT / "debug" / (f"ws_dump-{_SLOT}.jsonl" if _SLOT else "ws_dump.jsonl")
_ws_dump: deque = deque(maxlen=3000)
_ws_dump_cur: dict | None = None


def _dump_begin(d: dict, rid: str | None = None) -> dict:
    global _ws_dump_cur
    now = time.time()
    e = {"ts": round(now, 3),
         "t": time.strftime("%H:%M:%S", time.localtime(now)) + f".{int(now * 1000) % 1000:03d}",
         "hand": _hand_no, "pid": d.get("pid"), "seat": d.get("seat"),
         "rid": rid,                       # WHICH SOCKET: one per table (see _tap_accepts)
         "status": "ok", "data": d}
    _ws_dump.append(e)
    _ws_dump_cur = e
    return e


def _dump_mark(reason: str) -> None:
    """Called from inside _on_game_msg's guards: stamps the frame currently
    being processed with WHY it was ignored."""
    if _ws_dump_cur is not None:
        _ws_dump_cur["status"] = reason


def _dump_commit(e: dict) -> None:
    global _ws_dump_cur
    _ws_dump_cur = None
    try:
        _WS_DUMP_PATH.parent.mkdir(exist_ok=True)
        if _WS_DUMP_PATH.exists() and _WS_DUMP_PATH.stat().st_size > 20_000_000:
            _WS_DUMP_PATH.replace(_WS_DUMP_PATH.with_suffix(".jsonl.1"))
        with _WS_DUMP_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(e, default=str) + "\n")
    except Exception:
        pass


def _dump_event(pid: str, **extra) -> None:
    """A non-frame marker (tap connected/lost) in the same stream."""
    _dump_commit(_dump_begin({"pid": pid, **extra}))


def _apply_select(seat: int | None, btn: int | None, bet: int, rz: int) -> None:
    """One player action, from a live CO_SELECT_INFO frame OR one slot of a
    batched CO_SELECT_SPEED_INFO (Zone pre-selected actions) — identical
    semantics: `raise` is chips ADDED (running total = prior + rz), `bet` is
    the matching amount, unmapped btn codes are inferred from the amounts
    (the speed batch uses its own codes, e.g. 512 for a pre-raise)."""
    # Ghost/echo guard: actions from seats never dealt this hand, or from
    # seats that already folded, are the client re-rendering old state —
    # recording them corrupts the line walk.
    dealt_now = _ws_state.get("dealt") or []
    folded_now = _ws_state.get("foldedSeats", set())
    if seat is not None and seat in folded_now and seat in _ws_state.get("domFolds", set()) and (rz or bet):
        # The fold was the DOM's guess (a badge); money from the seat is the
        # client's own word that it is still in the hand. Retract the guess and
        # let the action through (hand 368, 2026-09-18: a stale FOLD flash on the
        # BTN swallowed its 3-bet).
        folded_now.discard(seat)
        _ws_state["domFolds"].discard(seat)
        _ws_state.get("actSeen", set()).discard(("fold", seat))
        acts = _ws_state.get("actions") or []
        for i in range(len(acts) - 1, -1, -1):
            if acts[i].get("seat") == seat and acts[i].get("type") == "fold":
                del acts[i]
                break
        _feed_add(f"Seat {seat} did not fold — a stale FOLD label; retracted")
        _dump_mark(f"retracted a DOM fold for seat {seat}: chips arrived on the WS")
    if seat is not None and ((dealt_now and seat not in dealt_now)
                             or seat in folded_now):
        _dump_mark(f"dropped: ghost-guard (dealt={dealt_now}, "
                   f"folded={sorted(_ws_state.get('foldedSeats', set()))})")
        return
    verb = _BTN.get(btn)
    if verb is None:                               # unmapped code: infer
        verb = "raises to" if rz else ("calls" if bet else "checks")
    top = _ws_state.get("maxBet", 0)
    com = _ws_state.setdefault("committed", {})
    prior = com.get(seat, 0)
    if verb == "raises to":
        # `raise` is the chips ADDED by this action; "raises to" means the
        # seat's running total for the round, so add what they already had
        # in front (a blind, or an earlier bet this street).
        total = prior + rz
        com[seat] = total
        _ws_state["maxBet"] = max(top, total)
        if not _act_seen(_mkey(seat, total)):
            _act_add(seat, "raise", total)
            _feed_add(f"Seat {seat} raises to {_amt(total)}")
        else:
            _dump_mark("dup: money action already recorded")
    elif verb == "calls":
        # Matching the standing bet is a call; exceeding it (or acting when
        # nothing is owed) is a bet — the bitmask alone can't tell these
        # apart, so compare against the round's high-water mark.
        com[seat] = prior + bet
        if prior + bet > top:
            _ws_state["maxBet"] = prior + bet
            if not _act_seen(_mkey(seat, prior + bet)):
                _act_add(seat, "bet", prior + bet)
                _feed_add(f"Seat {seat} bets {_amt(bet)}")
            else:
                _dump_mark("dup: money action already recorded")
        elif not _act_seen(_mkey(seat, prior + bet)):
            # A call reports the amount called (the top-up), which is the
            # standard hand-history convention — unlike "raises to".
            _act_add(seat, "call", bet)
            _feed_add(f"Seat {seat} calls {_amt(bet)}")
        else:
            _dump_mark("dup: money action already recorded")
    elif verb == "is ALL-IN":
        total = prior + max(bet, rz)
        com[seat] = total
        _ws_state["maxBet"] = max(top, total)
        if not _act_seen(_mkey(seat, total)):
            _act_add(seat, "all-in", total)
            _feed_add(f"Seat {seat} is ALL-IN ({_amt(total)})")
        else:
            _dump_mark("dup: money action already recorded")
    else:
        if verb == "folds" and seat == _ws_state.get("heroSeat"):
            _ws_state["heroFolded"] = True
        kind = "fold" if verb == "folds" else "check"
        if kind == "fold":
            _ws_state.setdefault("foldedSeats", set()).add(seat)
        if not _act_seen((kind, seat)):
            _act_add(seat, kind)
            _feed_add(f"Seat {seat} {verb}")
        else:
            _dump_mark(f"dup: {kind} already recorded")


# ── ONE PAGE, FOUR TABLES, ONE TAP ────────────────────────────────────────────────────────────────────
# Ignition seats up to four tables in a SINGLE page (see ignition_target), each an iframe with its own
# WebSocket. The tap enables Network on the page, so it receives EVERY table's frames, and nothing in the
# payloads says which table they came from — `tableNo` rides only on PLAY_TABLE_NUMBER, 50 frames out of
# 32,102. So a second table's hands interleave into ours: replaying one recorded dump shows 54 hand ids
# RESUMING after another hand had started, and that is what puts a different hand's board, pot and actions
# into the hand we are exporting.
#
# CDP does say which socket a frame came from — `params.requestId`, one per WebSocket, so one per table.
# Bind to the socket that shows HERO'S OWN CARDS face up (CO_CARDTABLE_INFO reveals only our own hole cards)
# and ignore the rest.
#
# MULTI-TABLE, SOLVED 2026-09-21 — and it was NOT solved before. With TABLE_SLOT set the account is seated
# at several tables at once, so "hero's cards are face up here" is true of every one of them and the test
# above cannot separate them. The old code gave up at that point and accepted EVERYTHING, which is the
# mixing it was written to prevent: in the first real two-table session both wrappers ingested both tables'
# sockets, table 1's aces arrived in table 2's hand state, the reconciler disagreed on every hand it
# compared (shadow 0 agree / 5 differ) and auto-execute correctly refused to press on state it could not
# trust. The evidence is in that session's own dump: every frame of sockets 9240.618 and 9240.1035 appears
# TWICE, once under each wrapper's hand numbering.
#
# WHAT SEPARATES THEM: hero sits in a DIFFERENT SEAT at each table, and the client tags hero's own seat in
# the DOM (`myPlayerTag`) inside OUR OWN slot's frame — which _feed_tick already reads every tick and now
# publishes as _live_status["heroSeatDom"]. So the socket whose CO_CARDTABLE_INFO deals face-up cards INTO
# OUR SEAT is ours. In that session's dump the two tables read seat 1 and seat 3 — unambiguous.
#
# UNBOUND MEANS HOLD, not accept (multi-table only). This is the rule tables.pin already states for windows:
# reading the wrong table is worse than reading no table. A tap that has not yet identified its own socket
# must not READ anything - but it must not THROW it away either (below).
#
# BIND AT SIT-DOWN, NOT AT THE DEAL (2026-09-22). The deal used to be the only bind trigger, so on a
# two-table practice run both panels sat on "has not identified our table" until each table's first hand
# was dealt (40 s and 3 min), and everything before it was dropped - including that hand's own
# PLAY_STAGE_INFO, blinds and stacks, so the first hand at each table was read from the middle with stale
# seats and the ghost-guard threw away real villain actions. The client says which seat is ours the moment
# we sit, in frames it sends to OUR socket only, each carrying our seat:
#   PLAY_BUYIN_INFO type 1   - the buy-in dialog for our seat (right after we take it)
#   CO_SIT_PLAY              - our own sit-in / sit-out toggle (play 1 matched hero's next deal 488/488
#                              times across every recorded dump; other seats' toggles are never sent)
# A socket CLAIMING the seat the DOM says is ours is ours. PLAY_ACCOUNT_CASH_RES and PLAY_SEAT_INFO are
# NOT claims: both are broadcast for every seat (measured: 184 / 189 frames naming another seat).
#
# HOLD, THEN REPLAY. While unbound, each socket's frames since its last PLAY_STAGE_INFO are kept; the
# moment one binds, its held frames are replayed through the reader BEFORE anything live, so even a late
# bind reads the hand from its first frame. The other sockets' holds are discarded.
#
# SAME SEAT NUMBER AT TWO TABLES: two sockets can both claim our seat. Then the seat cannot separate them
# and the binder waits for the deal, where the hole cards our OWN frame renders pick the one socket that
# dealt them. Ambiguous and no cards yet = stay unbound (and holding); never a guess.
_tap_bound: str | None = None
_tap_foreign = 0
_tap_held = 0                       # frames held while unbound (multi-table)
_tap_seen: dict = {}                # rid -> the seats it has dealt face-up cards to
_tap_dealt: dict = {}               # rid -> {seat: card names} of its latest face-up deal
_tap_claims: dict = {}              # rid -> the seat its latest hero-only frame (buy-in/sit toggle) named
_tap_rejected: set = set()          # rids let go for dealing the wrong cards: no longer bound on a claim
_tap_hold: dict = {}                # rid -> frames since its last PLAY_STAGE_INFO, while unbound
_tap_replay: list = []              # the bound socket's held frames, waiting for _tap_take_replay()
_tap_dom_cards: list = []           # hero's cards as OUR OWN frame last rendered them (feed tick)
_tap_ambiguous_said: set = set()
_tap_mismatch = 0                   # consecutive DOM-vs-tap card disagreements
_TAP_HOLD_MAX = 1500                # a hand is ~100-300 frames; this only bounds a pathological socket
# How long an unbound tap may stay quiet before it says so on the panel and in
# the log. Long enough to cover sitting down and waiting for the big blind.
_TAP_STALL_S = 90.0
_tap_stall: dict = {"since": None, "said": False}


def _face_up_seats(d: dict) -> dict:
    """{seat number: card names} for every seat this frame shows FACE UP.

    Only hero's own cards are face up to hero, so at a single table this is
    hero's seat; across several tables it is hero's seat AT THAT TABLE."""
    out: dict[int, list[str]] = {}
    for k, v in d.items():
        if not (m := re.fullmatch(r"seat(\d+)", str(k))) or not isinstance(v, list):
            continue
        if names := [nm for nm in (_card_name(f"card{c}") for c in v) if nm]:
            out[int(m.group(1))] = names
    return out


def _hero_claim(d: dict) -> int | None:
    """The seat a HERO-ONLY frame names, or None. See the block comment above
    for why these two and not the broadcast seat frames."""
    pid = d.get("pid")
    if (pid == "PLAY_BUYIN_INFO" and d.get("type") == 1) or pid == "CO_SIT_PLAY":
        s = d.get("seat")
        return s if isinstance(s, int) and s > 0 else None
    return None


def _tap_unbind(why: str) -> None:
    """Let go of the socket and look again. Cheap and safe: the next hand we are
    dealt into re-binds, and until then the DOM carries the reader. The socket
    let go of is no longer bound on a CLAIM - its claim is what bound it wrongly -
    only on a deal."""
    global _tap_bound, _tap_mismatch
    if _tap_bound is not None:
        _dump_event("<tap-unbound>", rid=_tap_bound, why=why)
        _tap_rejected.add(_tap_bound)
    _tap_bound = None
    _tap_mismatch = 0
    _tap_hold.clear()


def _tap_bind(rid: str, **why) -> None:
    global _tap_bound, _tap_replay
    _tap_stall.update({"since": None, "said": False})
    _tap_bound = rid
    _tap_replay = list(_tap_hold.get(rid) or [])
    _tap_hold.clear()
    _dump_event("<tap-bound>", rid=rid, replayed=len(_tap_replay), **why)


def _tap_try_bind() -> None:
    """Multi-table: bind the ONE socket that says it is ours, if there is one."""
    mine = _live_status.get("heroSeatDom")
    if mine is None:
        return
    claimed = {r for r, s in _tap_claims.items() if s == mine and r not in _tap_rejected}
    dealt = {r for r, up in _tap_dealt.items() if mine in up}
    cands = claimed | dealt
    if len(cands) == 1:
        rid = next(iter(cands))
        if rid in dealt:
            _tap_bind(rid, seat=mine, cards=_tap_dealt[rid][mine],
                      why=f"this socket deals face-up cards into our own seat {mine}")
        else:
            _tap_bind(rid, seat=mine, why=f"this socket's own buy-in / sit-in frames name our seat {mine}"
                                          " - bound before the first deal")
        return
    if len(cands) < 2:
        return
    # several sockets name our seat: only the hole cards our own frame shows can
    # tell them apart
    dom = sorted(_tap_dom_cards or [])
    by_cards = [r for r in cands if dom and sorted(_tap_dealt.get(r, {}).get(mine) or []) == dom]
    if len(by_cards) == 1:
        _tap_bind(by_cards[0], seat=mine, cards=dom,
                  why=f"several sockets name our seat {mine}; this one dealt the cards our own frame shows")
    elif frozenset(cands) not in _tap_ambiguous_said:
        _tap_ambiguous_said.add(frozenset(cands))
        _dump_event("<tap-bind-ambiguous>", rids=sorted(cands), seat=mine,
                    why="more than one socket names our seat - waiting for hole cards to tell them apart")


def _tap_take_replay() -> list:
    """The bound socket's held frames, once, right after it binds. The tap loop
    runs them through the reader before any live frame."""
    global _tap_replay
    out, _tap_replay = _tap_replay, []
    return out


def _tap_accepts(d: dict, rid: str | None) -> bool:
    """True when this frame belongs to the table we are watching and should be
    read NOW. Multi-table: a frame held while unbound returns False here and is
    handed back by _tap_take_replay() if its socket turns out to be ours."""
    global _tap_bound, _tap_foreign, _tap_held
    if rid is None:
        return True                                   # no socket id (fake mode, replay): behave as before
    multi = TABLES.slot() is not None
    if _tap_bound is None:
        up = _face_up_seats(d) if d.get("pid") == "CO_CARDTABLE_INFO" else {}
        if not multi:
            if up:
                # ONE TABLE: any face-up hand is ours, because only ours is.
                _tap_stall.update({"since": None, "said": False})
                _tap_bound = rid
                _dump_event("<tap-bound>", rid=rid, why="hero's cards are face up on this socket")
            return True                               # single table: unchanged, accept while looking
        # MULTI: record what this frame says about its socket, hold it, try to bind.
        if up:
            _tap_seen[rid] = sorted(up)
            _tap_dealt[rid] = up
            mine = _live_status.get("heroSeatDom")
            if mine is None:
                _dump_event("<tap-bind-waiting>", rid=rid, seats=sorted(up),
                            why="the DOM has not said which seat is hero's yet")
            elif mine not in up:
                # a face-up hand in a seat that is not ours is ANOTHER table of
                # ours - expected, and worth seeing
                _dump_event("<tap-other-table>", rid=rid, seats=sorted(up), ourSeat=mine)
        if (s := _hero_claim(d)) is not None and _tap_claims.get(rid) != s:
            _tap_claims[rid] = s
            _dump_event("<tap-claim>", rid=rid, seat=s, frame=d.get("pid"),
                        ourSeat=_live_status.get("heroSeatDom"))
        hold = _tap_hold.setdefault(rid, [])
        if d.get("pid") == "PLAY_STAGE_INFO":
            hold.clear()                              # a new hand: what came before it is not needed
        if len(hold) < _TAP_HOLD_MAX:
            hold.append(d)
        _tap_try_bind()
        if _tap_bound is not None:
            return False                              # held frames (this one included) come back via replay
        _tap_held += 1
        if _tap_stall["since"] is None:
            _tap_stall["since"] = time.time()
        # A BINDER THAT NEVER BINDS MUST NOT BE QUIET. Holding is the right
        # answer to "which table is this?" being unanswered -- answering from
        # the wrong table is worse -- but it stops the capture dead, and on
        # 2026-09-21 it did exactly that for a live two-table session while
        # /state still read "connected". It does NOT fall back to accepting
        # everything: that is the mixing this exists to prevent. It says so.
        elif (time.time() - _tap_stall["since"] > _TAP_STALL_S) and not _tap_stall["said"]:
            _tap_stall["said"] = True
            print(f"[ws] STALLED: {_tap_held} frames held, no socket identified as table "
                  f"{TABLES.slot()}'s (our seat reads {_live_status.get('heroSeatDom')})")
            _feed_add("Capture cannot tell which table is ours - no answers until it can "
                      "(it will not guess)")
        if _tap_held in (1, 10, 100, 1000, 10000):
            _dump_event("<tap-held>", rid=rid, frame=d.get("pid"), held=_tap_held,
                        why="no socket identified as ours yet - holding rather than mixing tables")
        return False
    if rid == _tap_bound:
        return True
    _tap_foreign += 1
    if _tap_foreign in (1, 10, 100, 1000):
        _dump_event("<tap-foreign-frame>", rid=rid, frame=d.get("pid"), dropped=_tap_foreign)
    return False


# How many consecutive ticks hero's cards may disagree between the DOM (our own
# frame, authoritative about WHICH table) and the tap before we conclude we are
# bound to the wrong socket. ~2 s at the feed loop's 0.25 s tick: long enough to
# ride out the DOM lagging a fresh deal, short enough that a genuine mis-bind
# costs one decision rather than a session.
_TAP_MISMATCH_TICKS = 8


def _tap_verify(dom_cards: list) -> None:
    """Belt to the binder's braces: hero's cards, as OUR OWN frame renders them,
    must be the cards the bound socket dealt. Sustained disagreement means the
    socket is another table's — let go and re-bind.

    Both sides have to be known and the hand still live, so this says nothing
    between hands (when the DOM minis are blank) or before the first deal."""
    global _tap_mismatch, _tap_dom_cards
    _tap_dom_cards = list(dom_cards or [])   # the binder's tie-break when two sockets name our seat
    if _tap_bound is None or TABLES.slot() is None:
        return
    tap_cards = _ws_state.get("heroCards") or []
    if not dom_cards or not tap_cards or len(dom_cards) < 2:
        _tap_mismatch = 0
        return
    if sorted(dom_cards) == sorted(tap_cards):
        _tap_mismatch = 0
        return
    _tap_mismatch += 1
    if _tap_mismatch >= _TAP_MISMATCH_TICKS:
        _tap_unbind(f"our frame shows {' '.join(dom_cards)} while this socket dealt "
                    f"{' '.join(tap_cards)} — it is another table's")
        _feed_add("Capture was following the wrong table — re-identifying it from your own seat")


def _board_contradicts(d: dict) -> bool:
    """True when an incoming flop cannot belong to the hand in progress: we already hold board cards and
    the new ones are not an extension of them. Boards only grow within a hand."""
    have = [c for c in (_ws_state.get("board") or []) if c]
    if not have:
        return False
    names = [n for n in (_card_name(f"card{c}") for c in (d.get("bcard") or [])) if n]
    return len(names) == 3 and names[: len(have)] != have[: len(names)]


def _begin_hand(hid: str | None) -> None:
    """Close the hand in progress and open a new one. Called for the authoritative PLAY_STAGE_INFO, and
    when the traffic proves a hand boundary we never saw (see _board_contradicts)."""
    global _hand_no
    hid = hid or ""
    _archive_hand()   # the finished hand, an instant before its state resets
    _hand_no += 1
    _hand_ids[_hand_no] = hid
    _ws_state["board"] = []
    _ws_state["maxBet"] = 0
    _ws_state["heroFolded"] = False
    _ws_state["actionOn"] = None
    _ws_state["committed"] = {}
    _ws_state["actions"] = []
    _ws_state["actSeen"] = set()
    _ws_state["foldedSeats"] = set()
    _ws_state["domFolds"] = set()
    _ws_state["foldTicks"] = {}
    # the client's own "your turn" request (CO_SELECT_REQ) is per hand; and
    # which seats have held cards this hand (a fold needs cards to fold)
    _ws_state["heroTurn"] = None
    _ws_state["heldCards"] = set()
    _ws_state["heroCards"] = []
    _ws_state["pot"] = None
    _ws_state["potCents"] = None
    _ws_state["handOver"] = False
    _ws_state["endedSince"] = None
    # the end-of-hand frames after the id repeat (see PLAY_STAGE_INFO in _on_game_msg)
    _ws_state["lastHandNoSeen"] = False
    _ws_state["cleared"] = False
    # Zone deals a NEW table every hand: the previous hand's dealer/dealt
    # must not leak into this one (stale geometry = wrong positions = the
    # study line walks the wrong seats). Both are re-announced within the
    # same message burst (CO_DEALER_SEAT / CO_CARDTABLE_INFO); until then
    # /hand exports null and the poller simply waits a beat.
    _ws_state["dealer"] = None
    _ws_state["dealt"] = []
    _ws_state["heroDealt"] = None     # unknown until this hand's deal frame says (CO_CARDTABLE_INFO)
    # DOM-backfill grace: the finished hand's badges/cards re-render
    # through the deal animation, so the seat-diff would file them as the
    # NEW hand's opening actions (three phantom folds one second in —
    # including hero's, which killed the panel with 'waiting for your
    # turn' forever). The WS tap still captures real early actions.
    _ws_state["domGraceUntil"] = time.time() + 2.5
    # Drop the BB calibration each hand: a stale value from a previous
    # table renders every amount at the wrong scale ("calls 0.02 BB"),
    # and the upcoming CO_BLIND_INFO re-establishes it immediately.
    _ws_state["bbSeen"] = False
    _feed_add("───── new hand ─────")
    if hid:
        _feed_add(f"(hand id {hid})")


def _on_game_msg(d: dict) -> None:
    global _hand_no
    if _fake_mode:
        # Test mode owns the hand state. A real client left open in the
        # background keeps its socket alive, and its frames would otherwise
        # advance the hand counter and rewrite the authored line mid-test.
        _dump_mark("dropped: fake-table test mode")
        return
    pid = d.get("pid")
    if pid == "PLAY_STAGE_INFO":                       # authoritative new hand
        hid = str(d.get("stageNo") or "")
        # The client repeats this message for the same hand; without an id
        # check that spawned a phantom hand carrying the previous hand's id.
        if hid and hid == _hand_ids.get(_hand_no):
            _dump_mark("dup: repeated PLAY_STAGE_INFO for the same hand id")
            return
        # A HAND THAT NEVER GOT ITS ID TAKES IT FROM THE END-OF-HAND REPEAT (2026-09-23). That
        # repeat comes ~2 s after PLAY_STAGE_END_REQ and BEFORE CO_LAST_HAND_NUMBER, PLAY_CLEAR_INFO
        # and the next hand's PLAY_STAGE_INFO — every boundary in the recorded dumps has that
        # order. A hand opened without an id (the wrapper attached mid-hand, or the opening frame
        # was lost — the tap drops frames across a reconnect) would otherwise be archived id-less,
        # and its own repeat would then open a PHANTOM hand carrying its id. The repeat is only
        # taken as ours while the hand is over and nothing after the repeat has arrived yet; a
        # PLAY_STAGE_INFO after CO_LAST_HAND_NUMBER / PLAY_CLEAR_INFO is the next hand, as before.
        if hid and not _hand_ids.get(_hand_no) and _ws_state.get("handOver") \
                and not _ws_state.get("lastHandNoSeen") and not _ws_state.get("cleared") \
                and (_ws_state.get("actions") or _ws_state.get("dealt")):
            _hand_ids[_hand_no] = hid
            _dump_mark("adopted: the end-of-hand repeat named this id-less hand")
            _feed_add(f"(hand id {hid} — from the end-of-hand repeat)")
            return
        _begin_hand(hid)
    elif pid == "CO_BCARD3_INFO" and _board_contradicts(d):
        # A MISSED PLAY_STAGE_INFO MERGES TWO HANDS (2026-09-21). The hand boundary rides on a single
        # message; the tap drops frames on reconnect (see the read-timeout note above - 183 reconnect
        # markers in one day), and when the dropped frame is PLAY_STAGE_INFO the next hand's actions, board
        # and pot all accumulate onto the previous hand. That is the corruption behind exported lines that
        # contradict themselves: flop actions after turn actions, a seat acting twice running, "F-F-F-F-F".
        # Replaying the recorded traffic shows it directly, as a board changing identity mid-hand.
        #
        # A flop whose cards contradict the board we already hold cannot belong to this hand, because boards
        # only grow. So close the hand here and open the next one, exactly as the missing message would.
        _dump_mark("forced new hand: flop contradicts the board held in this hand")
        _begin_hand(None)
        _on_game_msg(d)   # apply the flop to the hand it actually belongs to
        return
    elif pid == "CO_BLIND_INFO":
        btn, bet = d.get("btn"), d.get("bet")
        if bet:
            if btn == 4:                               # BB post = exact scale
                if _ws_state.pop("bbGuessed", None) and _ws_state.get("bb") != bet:
                    _ws_state["bb"] = bet          # correct BEFORE re-rendering
                    _refeed_blind_guess()
                _ws_state["bb"] = bet
            elif btn == 2 and not _ws_state.get("bbSeen"):
                # SB arrives first, so the BB is not known yet. Doubling it is
                # only right where the SB is half the BB, which Ignition's
                # 0.02/0.05 is not: the true SB is 0.4 BB and this renders it
                # "0.5 BB". Mark the guess so the real post can correct both
                # the rate and the line already printed with it.
                _ws_state["bb"] = bet * 2
                _ws_state["bbGuessed"] = True
            _ws_state["bbSeen"] = True
            # Blinds are live bets: without this the first caller's matching
            # amount looks like an opening bet rather than a call, and a raise
            # over a blind would under-report its total.
            _ws_state["maxBet"] = max(_ws_state.get("maxBet", 0), bet)
            com = _ws_state.setdefault("committed", {})
            com[d.get("seat")] = com.get(d.get("seat"), 0) + bet
        label = _BLIND_BTN.get(btn)
        if btn in (2, 4):
            _act_add(d.get("seat"), "post-sb" if btn == 2 else "post-bb", bet)
        _feed_add(f"Seat {d.get('seat')} posts "
                  + (f"{label} ({_amt(bet)})" if label else f"({_amt(bet)})"))
        if _ws_state.get("bbGuessed"):
            _feed[-1]["guessCents"] = bet
    elif pid == "CO_SELECT_REQ":
        # THE CLIENT ASKING HERO TO ACT (2026-09-19). This frame has no seat: it is
        # the client putting THIS player on the clock, with the buttons offered
        # (btns bitmask, bet/raise/maxRaise) and the time bank. It is the most
        # direct "hero to act" signal there is — the DOM buttons and CO_CURRENT_
        # PLAYER are downstream of it — so /hand treats it as authoritative for
        # hero's turn (see _hand_state) and the state check compares the
        # buttons against it every tick. Cleared when hero's own CO_SELECT_INFO
        # (the action taken) arrives, or when action moves to another seat.
        _ws_state["heroTurn"] = {"at": time.time(), "hand": _hand_no, "timeBank": d.get("timeBank"),
                                 "bet": d.get("bet"), "raise": d.get("raise"), "btns": d.get("btns")}
    elif pid == "CO_SELECT_INFO":
        if d.get("seat") is not None and d.get("seat") == _ws_state.get("heroSeat"):
            _ws_state["heroTurn"] = None           # hero acted: the request is answered
        _apply_select(d.get("seat"), d.get("btn"), d.get("bet") or 0, d.get("raise") or 0)
    elif pid == "CO_SELECT_SPEED_INFO":
        # Zone's PRE-SELECTED ("speed") actions arrive BATCHED in seat-indexed
        # arrays, not as individual CO_SELECT_INFO frames — a player who
        # pre-folds or pre-raises never emits one. This was every "missed
        # early villain action" (proved by hand 4907488490's dump: seat 3's
        # raise lived in btn=[…,512,…]/raise=[…,75,…] while the wrapper only
        # knew CO_SELECT_INFO). Apply each armed seat in acting order starting
        # from firstSeat, through the same guard/dedupe path as live actions.
        btns = d.get("btn") or []
        bets = d.get("bet") or []
        rzs = d.get("raise") or []
        n = max(len(btns), len(bets), len(rzs))
        first = d.get("firstSeat") or 1
        for k in range(n):
            seat = ((first - 1 + k) % n) + 1
            i = seat - 1
            b = btns[i] if i < len(btns) else 0
            be = bets[i] if i < len(bets) else 0
            rz = rzs[i] if i < len(rzs) else 0
            if not (b or be or rz):
                continue
            _apply_select(seat, b, be, rz)
    elif pid == "CO_BCARD3_INFO":                      # the flop, all three at once
        names = [n for n in (_card_name(f"card{c}") for c in (d.get("bcard") or []))
                 if n]
        if len(names) == 3:
            _ws_state["board"] = names
            _ws_state["maxBet"] = 0                    # bets reset each round
            _ws_state["committed"] = {}
            _ws_state["actSeen"] = set()
            # street-deal animation lies just like the hand-deal one: chips
            # sliding to the pot read as fresh bets for a moment
            _ws_state["domGraceUntil"] = time.time() + 1.2
            _feed_add(f"— FLOP — {' '.join(names)} — pot {_ws_state['pot'] or '?'}")
    elif pid == "CO_BCARD1_INFO":                      # turn (pos 4), river (pos 5)
        pos, name = d.get("pos") or 0, _card_name(f"card{d.get('card')}")
        if not name or pos < 4:
            return
        b = _ws_state["board"]
        idx = pos - 1                                  # positions are 1-based
        while len(b) <= idx:
            b.append(None)
        b[idx] = name
        shown = [c for c in b if c]
        _ws_state["maxBet"] = 0
        _ws_state["committed"] = {}
        _ws_state["actSeen"] = set()
        _ws_state["domGraceUntil"] = time.time() + 1.2
        street = "TURN" if pos == 4 else "RIVER"
        _feed_add(f"— {street} — {' '.join(shown)} — pot {_ws_state['pot'] or '?'}")
    # CO_RABBITCARD_INFO is deliberately ignored: rabbit-hunt cards are shown
    # after a hand ends and were never actually dealt to the board.
    elif pid == "CO_CURRENT_PLAYER":                   # authoritative "action on"
        _ws_state["actionOn"] = d.get("seat")
        if d.get("seat") is not None and d.get("seat") != _ws_state.get("heroSeat"):
            _ws_state["heroTurn"] = None           # the clock moved on to someone else
    elif pid == "PLAY_STAGE_END_REQ":
        # The client's own end-of-hand marker — covers SHOWDOWN hands, whose
        # `ended` flag stays false (it means folded-or-uncontested), so the
        # idle flush (_maybe_flush_ended) can archive them too.
        _ws_state["handOver"] = True
    elif pid == "CO_LAST_HAND_NUMBER":
        # Names the hand that JUST FINISHED (it follows that hand's PLAY_STAGE_INFO repeat by a
        # few ms and precedes the next hand's). For a finished hand that never got an id this
        # is the last chance to learn it; for every other hand it only marks where we are in the
        # end-of-hand burst, so a later PLAY_STAGE_INFO is read as the next hand (see there).
        hid = str(d.get("stageNo") or "")
        _ws_state["lastHandNoSeen"] = True
        if hid and not _hand_ids.get(_hand_no) and _ws_state.get("handOver"):
            _hand_ids[_hand_no] = hid
            _feed_add(f"(hand id {hid} — from CO_LAST_HAND_NUMBER)")
    elif pid == "PLAY_CLEAR_INFO":
        _ws_state["cleared"] = True             # the table is being cleared for the next deal
    elif pid == "CO_DEALER_SEAT":
        _ws_state["dealer"] = d.get("seat")
    elif pid == "CO_CARDTABLE_INFO":
        # Hero is the only seat whose cards come through face-UP; everyone
        # else's read as the face-down back (32896). That identifies our seat
        # without any guessing.
        dealt = []
        face_up = None
        for k, v in d.items():
            if not (m := re.fullmatch(r"seat(\d+)", str(k))) or not isinstance(v, list):
                continue
            dealt.append(int(m.group(1)))
            names = [n for n in (_card_name(f"card{c}") for c in v) if n]
            if names:
                face_up = int(m.group(1))
                _ws_state["heroSeat"] = face_up
                # Store the cards too: CO_PCARD_INFO doesn't arrive every hand
                # and the DOM minis are blank between hands, so without this
                # the archive (and any boundary-time read) lost hero's cards.
                _ws_state["heroCards"] = names
        _ws_state["dealt"] = sorted(dealt)
        # WAS HERO DEALT IN (2026-09-23)? Only our own seat comes face-up, so a deal with no face-up seat is a hand
        # hero is not in — sitting out, waiting for the big blind, or RE-SEATED: heroSeat was never reset between
        # hands, so a villain sitting in hero's old seat had his actions exported and archived as hero's (hands.db
        # 375-378, 226, 312 — the API was probed about a stranger's spot with no cards). 35 of 93 empty archived
        # hands were hero-not-dealt hands filed as hero hands. The export and the archiver read this flag.
        _ws_state["heroDealt"] = face_up is not None
    elif pid == "CO_CHIPTABLE_INFO":
        pots = d.get("curPot") or []
        if pots:
            _ws_state["pot"] = _amt(sum(pots))
            _ws_state["potCents"] = sum(pots)
    elif pid == "CO_PCARD_INFO" and d.get("type") == 0:
        # Same message carries OUR deal and other players' showdown reveals —
        # without the seat check a villain's cards were announced as ours.
        names = [n for n in (_card_name(f"card{c}") for c in (d.get("card") or [])) if n]
        if not names:
            return
        seat = d.get("seat")
        if seat is not None and seat != _ws_state.get("heroSeat"):
            _feed_add(f"Seat {seat} shows {' '.join(names)}")
        else:
            _ws_state["heroCards"] = names
            _ws_state["heroDealt"] = True      # cards for our seat: hero is in this hand whatever the deal frame said
            _feed_add(f"Your cards: {' '.join(names)}")


def _hero_status(d: dict, nodes: list) -> str:
    """Why hero isn't acting: sitting out, waiting to be dealt in, folded, or
    simply not their turn. The client states the first two on the table itself
    ("I AM BACK", "SITTING OUT", "Waiting for big blind")."""
    txt = " ".join(n["text"] for n in nodes).lower()
    hero = _ws_state.get("heroSeat")
    dealt = _ws_state.get("dealt") or []
    # LEVELS BEFORE WORDS (2026-09-19). The table words used to be scanned as
    # ONE string, and every seat got them: a villain's "SITTING OUT" label
    # (seat 3, hand 4919080696) read as hero sitting out, the API then said
    # "not hero's turn", and the poller never asked — 19 s on the clock, first
    # to act, no answer and no failure row. Two facts settle hero's status
    # before any word does: the WS dealt hero in (CO_CARDTABLE_INFO) and hero's
    # own seat shows hole cards. A sitting-out player has neither. Only when
    # both are absent do the words count, and then hero's OWN container's words
    # (captured per seat by _TABLE_JS) come before the table-wide scan.
    hero_dealt = hero is not None and hero in dealt
    me = next((s for s in (d.get("seatQa") or []) if s.get("me")), None)
    my_words = str((me or {}).get("status") or "").lower()
    my_cards = int((me or {}).get("nHole") or 0)
    _WAIT_BB = r"wait(ing)?\s+(for\s+)?(the\s+)?big blind|waiting for bb"
    if not hero_dealt and my_cards == 0:
        if "sitting out" in my_words or "i am back" in txt or ("sitting out" in txt and me is None):
            return "sitting-out"
        if re.search(_WAIT_BB, my_words) or (re.search(_WAIT_BB, txt) and me is None):
            return "waiting-for-bb"
        # a table-wide word with no structural seat capture at all (old
        # captures): the word is the only evidence there is
        if me is None and "sitting out" in txt:
            return "sitting-out"
    if _ws_state.get("heroFolded"):
        return "folded"
    if hero is not None and dealt and hero not in dealt:
        return "not-in-hand"
    if _ws_state.get("heroDealt") is False and my_cards == 0:
        return "not-in-hand"    # the deal frame showed no face-up seat: a stranger sits in hero's old seat (2026-09-23)
    return "in-hand"


def _to_act_sources(buttons_up: bool) -> dict:
    """The three independent views of "hero to act", side by side."""
    hero = _ws_state.get("heroSeat")
    turn = _ws_state.get("heroTurn")
    return {"buttons": bool(buttons_up),
            "ws": bool(turn and turn.get("hand") == _hand_no and not _ws_state.get("heroFolded")),
            "actionOn": hero is not None and _ws_state.get("actionOn") == hero,
            "wsAt": (turn or {}).get("at"), "timeBank": (turn or {}).get("timeBank")}


# STATE HEALTH (2026-09-19): every tick the independent views of the table are
# compared, and a disagreement that HOLDS (animations never last a second) is
# recorded once per decision — on the feed, in the session, in /state — so a
# misread names itself the first time it happens instead of at archive time.
_state_health = {"ticks": 0, "events": [], "byKind": {}, "streak": {}, "seen": set()}


def _state_event(kind: str, detail: str, resolved: str) -> None:
    key = (_hand_no, kind, len(_ws_state.get("actions") or []))
    if key in _state_health["seen"]:
        return
    _state_health["seen"].add(key)
    if len(_state_health["seen"]) > 400:
        _state_health["seen"] = set(list(_state_health["seen"])[-200:])
    ev = {"at": int(time.time() * 1000), "hand": _hand_no, "clientHandId": _hand_ids.get(_hand_no),
          "kind": kind, "detail": detail, "resolvedAs": resolved}
    _state_health["events"].append(ev)
    del _state_health["events"][:-50]
    _state_health["byKind"][kind] = _state_health["byKind"].get(kind, 0) + 1
    _feed_add(f"⚠ state check ({kind}): {detail} — {resolved}")
    print(f"[state-check] {kind}: {detail} — {resolved}")
    if _session["id"]:
        # the session row is kind "state-check" with the sub-kind under `check` (until 2026-09-23 the payload's
        # own "kind" overwrote the event's, so no "state-check" row ever existed — sessions.event)
        _sessions.event(_session["id"], "state-check", {**{k: v for k, v in ev.items() if k not in ("kind", "at")}, "check": kind})


def _state_check(buttons_up: bool, seats: dict) -> None:
    """Compare the buttons, the client's own action request, action-on and
    hero's status; a disagreement held for 4 ticks (~1 s) is an event."""
    _state_health["ticks"] += 1
    hero = _ws_state.get("heroSeat")
    dealt = _ws_state.get("dealt") or []
    if hero is None or hero not in dealt or time.time() < _ws_state.get("domGraceUntil", 0):
        _state_health["streak"] = {}
        return
    src = _to_act_sources(buttons_up)
    status = _live_status.get("hero")
    folded = bool(_ws_state.get("heroFolded"))
    my_cards = (seats.get(hero) or {}).get("cards") or 0
    checks = {
        "buttons-without-request": (src["buttons"] and not src["ws"] and not folded,
                                    "your buttons are up but the client never asked you to act (CO_SELECT_REQ missed?)",
                                    "the buttons win: exported as your turn"),
        "request-without-buttons": (src["ws"] and not src["buttons"] and not folded,
                                    "the client asked you to act but no turn buttons are on screen",
                                    "exported as your turn on the client's word"),
        "buttons-vs-action-on": (src["buttons"] and not src["actionOn"] and not src["ws"] and not folded,
                                 f"buttons up while action-on says seat {_ws_state.get('actionOn')}",
                                 "the buttons win: exported as your turn"),
        "status-while-dealt": (status in ("sitting-out", "waiting-for-bb"),
                               f"status read as {status} while you were dealt in",
                               "dealt wins: exported as in the hand"),
        "dealt-without-cards": (my_cards == 0 and not folded and src["buttons"],
                                "your seat shows no cards while your buttons are up",
                                "the buttons win"),
    }
    st = _state_health["streak"]
    for kind, (bad, detail, resolved) in checks.items():
        st[kind] = st.get(kind, 0) + 1 if bad else 0
        if st[kind] == 4:
            _state_event(kind, detail, resolved)


def _state_health_summary() -> dict:
    ev = _state_health["events"]
    return {"ticks": _state_health["ticks"], "events": len(ev), "byKind": dict(_state_health["byKind"]),
            "last": ev[-1] if ev else None, "recent": ev[-5:]}


# THE CLIENT'S MODAL NOTICES (Brady, 2026-09-19). Session 100647 hand 5: the
# auto top-up pressed BUY for $5 with hero still in the hand, hero then won the
# pot, and at the next hand the client refused the buy with a modal — "The
# amount you entered is more than the maximum buy in amount allowed for this
# table." + OK — that sat over the action strip for 12 s, through hero's next
# turn, and swallowed the auto-execute's click. Two answers: the top-up never
# presses while hero can still win chips (see _maybe_top_up), and a modal the
# wrapper KNOWS to be harmless is dismissed the tick it appears. Any other
# modal is reported (state-check event + feed) and left alone: a notice the
# wrapper has never seen may be the one that matters.
_HARMLESS_MODALS = [
    (r"more than the maximum buy.?in amount", "buy-in above the table maximum"),
    (r"maximum buy.?in", "buy-in maximum notice"),
]
_modal_state = {"lastClickAt": 0.0, "reported": set()}


def _modal_of(d: dict) -> dict | None:
    """The client's modal, if one is up: its OK/close button (data-qa
    modal.action.*) and the notice text nearest to it."""
    btns = [b for b in d.get("buttons", []) if str(b.get("qa") or "").startswith("modal.action.")]
    if not btns:
        return None
    ok = next((b for b in btns if b["qa"].endswith(".ok") or b["text"].strip().lower() in ("ok", "close", "got it")), btns[0])
    # the notice: the longest visible text within the modal's column, above the button
    near = [n for n in d.get("nodes", [])
            if n["y"] < ok["y"] and ok["y"] - n["y"] < 260 and abs((n["x"] + n["w"] / 2) - (ok["x"] + ok["w"] / 2)) < 320
            and len(n["text"]) > 12]
    text = max(near, key=lambda n: len(n["text"]))["text"] if near else ""
    kind = next((label for pat, label in _HARMLESS_MODALS if re.search(pat, text, re.I)), None)
    return {"text": text, "button": ok, "harmless": kind, "buttons": [b["text"] for b in btns]}


def _handle_modal(d: dict) -> None:
    m = _modal_of(d)
    _live_status["modal"] = {"text": m["text"], "harmless": m["harmless"]} if m else None
    if not m:
        return
    now = time.time()
    if m["harmless"]:
        if now - _modal_state["lastClickAt"] < 2.0:
            return
        _modal_state["lastClickAt"] = now
        res = act(m["button"]["text"], "button")
        _feed_add(f"Dismissed the client's notice ({m['harmless']}): {m['text'][:80]}")
        if _session["id"]:
            _sessions.event(_session["id"], "modal-dismissed", {"modalKind": m["harmless"], "text": m["text"][:200],
                                                               "ok": bool(res.get("ok")), "hand": _hand_no})
        print(f"[modal] dismissed ({m['harmless']}): {res}")
        _note_top_up_refusal(m)
        return
    key = m["text"][:80]
    if key not in _modal_state["reported"]:
        _modal_state["reported"].add(key)
        _state_event("unknown-modal", f"the client shows a notice the wrapper does not know: {m['text'][:120]!r} (buttons {m['buttons']})",
                     "left on screen — picks are held until it is gone")


_toasts_seen: list[tuple[str, float]] = []


def _top_up_receipt(amount: str) -> None:
    """The client's own receipt for a buy. Marks the pending top-up record ok
    (whatever the panel read said) and files the receipt on the session."""
    now = time.time()
    _toasts_seen.append((amount, now))
    del _toasts_seen[:-20]
    _feed_add(f"Top-up receipt — the client added ${amount} in chips")
    cents = int(round(float(amount.replace(",", "")) * 100))
    rec = _study.get("lastTopUp")
    # the receipt settles the LAST PRESS only when the amount is the one pressed
    # for (the client adds the chips at the next hand, so a receipt can land a
    # hand later); the sit-down $200 receipt never settles a $34 press
    if rec and rec.get("pressed") and not rec.get("receiptCents") and now * 1000 - (rec.get("at") or 0) < 180_000 \
            and abs(cents - int(rec.get("amountCents") or 0)) <= 100:
        rec.update({"ok": True, "reason": None if rec.get("ok") else f"confirmed by the client's receipt (${amount} added)",
                    "receiptCents": cents})
    if _session["id"]:
        _sessions.event(_session["id"], "top-up-receipt", {"amount": amount, "hand": _hand_no,
                                                          "at": int(now * 1000)})


def _line_order_fault(line: list[tuple], rc) -> str | None:
    """The first way a normalised (street, seat, type, amount) line is one no table could
    have dealt, or None. Two rules only: a seat never acts twice running on a street (blind
    posts aside), and a postflop street opens with the first seat after the dealer that is
    still live and not all-in. Heads-up is left alone (its postflop order inverts). A seat
    whose jam the line recorded as a plain call is 'live' here and may make a street look
    misordered — that direction (refusing a substitution) is the safe one."""
    order: list[int] | None = None
    try:
        ring = sorted(set(rc.dealt) | ({rc.sb, rc.bbs} - {None}))
        if rc.sb is not None and rc.sb in ring and len(ring) >= 3:
            i = ring.index(rc.sb)
            order = ring[i:] + ring[:i]      # heads-up / unknown blinds: no opening-seat rule
    except Exception:
        order = None
    folded: set[int] = set()
    allin: set[int] = set()
    prev_street = None
    prev_seat = None
    prev_type = None
    for st, seat, typ, _amt in line:
        post = isinstance(typ, str) and typ.startswith("post")
        if st != prev_street:
            if st != "preflop" and order is not None:
                live = [s for s in order if s not in folded and s not in allin]
                if len(live) >= 2 and seat != live[0]:
                    return f"{st} opens with seat {seat}, seat {live[0]} is first to act"
            prev_street, prev_seat, prev_type = st, None, None
        elif seat == prev_seat and not post and not (isinstance(prev_type, str) and prev_type.startswith("post")):
            return f"seat {seat} acts twice running on the {st}"
        prev_seat, prev_type = seat, typ
        if typ == "fold":
            folded.add(seat)
        elif typ == "all-in":
            allin.add(seat)
    return None


def _reconciled_line(old: list[dict], hero: int | None, street: str):
    """CUT-OVER (2026-09-19): which betting line /hand carries.

    `old` is the event log's line (WS frames + DOM backfill). The level
    reconciler (reconcile.py, fed every tick by _shadow_tick) derives its own
    from the chips, cards and buttons on screen. Rules, in order:

      identical ..................... the event line (nothing to decide)
      reconciler is a strict prefix .. the event line — the reconciler holds
                                        folds/presses for 2-3 ticks, the WS is instant
      any invariant broken, any street  the event line: a derivation that tripped over
                                        its own arithmetic anywhere does not get to
                                        replace the log for the whole hand
      reconciler could not read it ... the event line, noted, NOT uncertain
      otherwise ..................... the reconciler's line (hand 368: a stale FOLD
                                        flash swallowed a 3-bet the chips showed)

    TWO DIFFERENT QUESTIONS, separated 2026-09-19. "May the derived line replace the
    log?" is about the whole hand's derivation being clean — any violation, any street,
    disqualifies it. "Must auto-execute hold RIGHT NOW?" is about a fault that is still
    true at this moment on this street (reconcile.faults()); a disagreement that has
    passed is not a reason to make hero play the rest of the street by hand. Answering
    both with one flag cost 21 held decisions across the recordings, and separately let a
    hand whose preflop CALL was derived 1 bb short be archived from the derived line
    because the only violation happened later, on the flop (session 115240 hand 8).

    Returns (actions, ledger | None, uncertain | None, note | None, source)."""
    rc = _shadow.get("rc") if _shadow.get("hand") == _hand_no else None
    if rc is None or not rc.armed or rc.bbs is None or hero is None:
        return old, None, None, None, "ws"
    try:
        # snapshot: this runs on HTTP threads while the feed thread appends to
        # the journal — a mid-iteration change must never 500 the probe
        journal = list(rc.line())
        # LIVE faults only, not the whole audit log (2026-09-19): holding a decision on
        # `violations` meant one flickering tick disabled auto-execute for the rest of the
        # street with no way back. reconcile.faults() keeps a fault while its condition
        # keeps re-asserting and for a few ticks after; a missed action stays forever.
        viol = list(rc.faults(street))
        rc_c, rc_max = dict(rc.C), rc.max_bet
    except Exception:
        return old, None, None, None, "ws"
    derived = []
    for a in journal:
        rec = {"seatId": a["seat"], "hero": a["seat"] == hero, "type": a["type"], "street": a["street"]}
        if a.get("amount") is not None:
            rec["amount"] = a["amount"]
        derived.append(rec)
    uncertain = f"line uncertain — {viol[-1]['what']}" if viol else None
    # Every invariant this hand broke, on any street: the bar for REPLACING the log.
    dirty = list(rc.violations)
    norm = lambda acts: [(x["street"], x["seatId"], x["type"],  # noqa: E731
                          round(float(x["amount"]), 1) if x.get("amount") is not None else None) for x in acts]
    o, r = norm(old), norm(derived)
    if o == r:
        return old, None, uncertain, None, "ws"
    if len(r) < len(o) and o[:len(r)] == r:
        return old, None, uncertain, None, "ws"
    if uncertain or dirty:
        why = uncertain or f"the derived line broke an invariant this hand ({dirty[-1]['what']}) — event line kept"
        return old, None, uncertain, None if uncertain else why, "ws"
    # HERO'S OWN REPORTED ACTIONS ARE NOT NEGOTIABLE (2026-09-23). The event line's hero actions come from the
    # client's own CO_SELECT_INFO for our seat; the reconciler infers hero's from levels, and hero's cards stay
    # on screen after he folds. In five archived hands (471, 479, 497, 523, 693) hero FOLDED to a bet — the WS
    # said so, the relay's postcondition confirmed it — and the derived line, taken at the archive, read a hero
    # CHECK plus a villain fold at the pot award. The reconciler may ADD a hero action the WS missed (the
    # missed-check case the cut-over exists for); it may never drop or retype one the client reported.
    hero_old = [(x[0], x[2], x[3]) for x in o if x[1] == hero]
    hero_new = [(x[0], x[2], x[3]) for x in r if x[1] == hero]
    unmatched = list(hero_new)
    lost = []
    for st, typ, amt in hero_old:
        hit = next((i for i, (s2, t2, a2) in enumerate(unmatched)
                    if s2 == st and t2 == typ and (amt is None or a2 is None or abs(a2 - amt) <= 0.15)), None)
        if hit is None:
            lost.append(f"{st} {typ}{'' if amt is None else f' {amt}'}")
        else:
            unmatched.pop(hit)
    if lost:
        return old, None, None, f"the derived line lacks hero's own reported action ({', '.join(lost[:3])}) — event line kept", "ws"
    # TURN ORDER before substitution (2026-09-23). The two remaining line-desync hands of the
    # hardening backtest (425 flop, 441 turn) were derived lines whose street OPENED with hero
    # — a press redeemed on the wrong street — while the seat first to act had not acted; 621's
    # had hero act twice running on the river (a check, then the pot award read as a bet). The
    # walker is positional, so either shape answers the wrong node or none. The reconciler has
    # since been fixed for both, but the substitution itself now refuses a line no table could
    # have dealt: no seat acts twice in a row on a street, and a postflop street opens with the
    # first live seat after the dealer. A refused line is not evidence against the event line.
    disorder = _line_order_fault(r, rc)
    if disorder:
        return old, None, None, f"the derived line is out of turn order ({disorder}) — event line kept", "ws"
    # SHAPE before substitution: the derived line must open with the two blind
    # posts and name only seats the client dealt in (replay 202818 hand 6: a
    # fold derived from a card flicker landed BEFORE the big blind's post — a
    # line no tree walk can follow). A malformed derived line is not evidence
    # against the event line; it is the reconciler saying it could not see.
    dealt_now = set(_ws_state.get("dealt") or [])
    types = [x[2] for x in r]
    well_formed = (types[:2] == ["post-sb", "post-bb"]
                   and (not dealt_now or all(x[1] in dealt_now for x in r)))
    if not well_formed:
        # COULD NOT SEE IS NOT DISAGREEMENT (2026-09-19). This used to return `uncertain`,
        # which holds auto-execute — but the paragraph above is the reason it must not: a
        # malformed derived line is no evidence against the event line. It was 11 of the 21
        # held decisions across every recording, every one of them on a hand whose event
        # line was perfectly good. The event line answers, and the note says why.
        return old, None, None, "the level reconciler could not read this hand (its line opens outside the blinds) — event line kept", "ws"
    o_set, r_set = set(o), set(r)
    gone = [f"{s} {t}{'' if a is None else f' {a}'}" for (_, s, t, a) in o if (_, s, t, a) not in r_set]
    new = [f"{s} {t}{'' if a is None else f' {a}'}" for (_, s, t, a) in r if (_, s, t, a) not in o_set]
    note = "line from the chips on screen" + (f"; dropped: {', '.join(gone[:3])}" if gone else "") \
        + (f"; added: {', '.join(new[:3])}" if new else "")
    ledger = {"committed": {int(s): round(v, 2) for s, v in rc_c.items()}, "maxBet": round(rc_max, 2)}
    return derived, ledger, None, note, "reconciled"


def _dead_small_blind(order: list[int]) -> bool:
    """A HAND DEALT WITH NO SMALL BLIND (2026-09-23, hand 4919958486). When the
    player in the SB seat leaves or sits out between hands, Ignition skips the
    seat: the button stays, and the seat after the empty one posts the BIG blind
    alone (the pot is 1bb, no SB post ever arrives). Counting seats from the
    button then names the BB poster "SB" and the next seat "BB", and both
    preflop pieces refuse the hand ("SB posted the big blind"). The posts say
    what the geometry cannot: the first seat after the button posted the big
    blind and nobody posted a small one. `order` = dealt seats clockwise from
    the seat after the button (SB … BTN)."""
    if len(order) < 3:
        return False
    sb_seat = bb_seat = None
    for a in _ws_state.get("actions") or []:
        if a.get("type") == "post-sb" and sb_seat is None:
            sb_seat = a.get("seat")
        elif a.get("type") == "post-bb" and bb_seat is None:
            bb_seat = a.get("seat")
    return sb_seat is None and bb_seat is not None and order[0] == bb_seat


def _hero_position() -> str | None:
    """Hero's position name, from the dealer button and who was dealt in.
    Seats run clockwise, so order the dealt seats starting after the button:
    SB, BB, then early→late, with the button itself last — unless no small
    blind was posted (see _dead_small_blind), when it is BB first."""
    seats = _ws_state.get("dealt") or []
    btn, hero = _ws_state.get("dealer"), _ws_state.get("heroSeat")
    if not seats or btn is None or hero is None or hero not in seats:
        return None
    if btn not in seats:
        seats = sorted(set(seats) | {btn})
    i = seats.index(btn)
    order = seats[i + 1:] + seats[:i + 1]          # SB … BTN
    n = len(order)
    if n == 2:
        names = ["SB", "BB"]                        # heads-up: button is the SB
        order = [btn, [s for s in order if s != btn][0]]
    elif _dead_small_blind(order):
        late = ["CO", "BTN"]
        early = ["UTG", "UTG+1", "MP", "MP+1", "HJ"][:max(0, n - 3)]
        names = (["BB"] + early + late)[:n]
    elif n == 3:
        names = ["SB", "BB", "BTN"]
    else:
        late = ["CO", "BTN"]
        early = ["UTG", "UTG+1", "MP", "MP+1", "HJ"][:max(0, n - 4)]
        names = (["SB", "BB"] + early + late)[:n]
    try:
        return names[order.index(hero)]
    except (ValueError, IndexError):
        return None


# ---- structured hand export (GET /hand) ------------------------------------
# A ParsedHand-shaped snapshot of the current hand for gto-trainer's feed
# tools (POST /api/feed-spot audits it against the solved trees). Positions
# use gto-trainer's vocabulary (UTG/HJ/CO — not UTG+1/MP), assigned from the
# button backwards so a short table maps onto the late seats of the 6-max tree.


def _positions_all() -> dict[int, str]:
    dealt = _ws_state.get("dealt") or []
    btn = _ws_state.get("dealer")
    if not dealt or btn is None:
        return {}
    seats = sorted(set(dealt) | {btn})
    i = seats.index(btn)
    order = seats[i + 1:] + seats[:i + 1]          # SB … BTN
    n = len(order)
    if n == 2:
        other = next(s for s in order if s != btn)
        return {btn: "SB", other: "BB"}
    if _dead_small_blind(order):
        # no SB this hand: the seat after the button IS the big blind, and
        # everyone between it and the button is a middle seat (n - 2 of them)
        mids = (["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO"] if n - 2 > 3
                else ["UTG", "HJ", "CO"])[-(n - 2):]
        names = ["BB"] + mids + ["BTN"]
    elif n == 3:
        names = ["SB", "BB", "BTN"]
    else:
        mids = (["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO"] if n > 6
                else ["UTG", "HJ", "CO"])[-(n - 3):]
        names = ["SB", "BB"] + mids + ["BTN"]
    return dict(zip(order, names))


def _stack_bb(text: str | None) -> float | None:
    """A DOM stack label in BB — trusts an explicit 'BB' suffix, else converts
    from currency using the hand's observed blind size."""
    v = _pot_val(text)
    if v is None or v <= 0:
        return None
    if text and "BB" in text.upper():
        return v
    bb = _ws_state.get("bb") or 0
    return round(v / (bb / 100), 1) if bb and _ws_state.get("bbSeen") else None


def _hand_state() -> dict | None:
    """The current hand as a ParsedHand (CONTRACT.md §1a), from whichever site
    this session plays. Everything downstream — /state, /hand, the pick guards,
    the press verifier — reads it through here and never asks which site."""
    if _is_cp():
        h = CP.hand()
        if h is not None:
            h["panelPort"] = PANEL_PORT
        return h
    return _hand_state_ignition()


def _hand_state_ignition() -> dict | None:
    # SNAPSHOT shared mutables up front: this runs on HTTP threads while the
    # WS tap and DOM feed threads append/assign concurrently — iterating the
    # live dict/list can raise mid-request and 500 the poller's probe.
    dealt = list(_ws_state.get("dealt") or [])
    hero = _ws_state.get("heroSeat")
    if not _hand_no or not dealt or hero is None:
        return None
    # A HAND HERO IS NOT IN IS NOT HERO'S HAND (2026-09-23): the deal frame showed no face-up seat, so whoever sits
    # in the remembered seat is a stranger. Nothing to export — the poller sees an idle table (422), the archiver
    # nothing to file — instead of a villain's spot with empty hero cards (hands.db 375-378, answers 4919049163…).
    if _ws_state.get("heroDealt") is False:
        return None
    positions = _positions_all()
    if not positions:
        return None  # dealer not yet announced — geometry unknown, don't guess
    acts_src = list(_ws_state.get("actions") or [])
    committed_src = dict(_ws_state.get("committed") or {})
    seats_src = dict(_feed_prev.get("seats") or {})
    bb = _ws_state.get("bb") or 0
    scaled = bb and _ws_state.get("bbSeen")

    def to_bb(cents):
        return round(cents / bb, 2) if scaled and cents is not None else None

    # Display keeps "10♠"; the export uses the solver-standard "T♠" so every
    # downstream card parser (normalizeHand, gtowApi boards) understands it.
    short = lambda c: c.replace("10", "T")  # noqa: E731
    board = [short(c) for c in (_ws_state.get("board") or []) if c]
    # WS board is authoritative but can lag (missed CO_BCARD during a tap
    # gap) — hero then sits on a flop while the export still says preflop
    # ("line ends on a terminal" no-answers). Fall back to the DOM's board,
    # guarded: outside the deal grace and only once the hand has real action
    # (a lingering previous-hand board fails both).
    past_grace = time.time() >= _ws_state.get("domGraceUntil", 0)
    has_voluntary = any(a["type"] not in ("post-sb", "post-bb") for a in acts_src)
    if past_grace:
        dom_board = [short(c) for c in (_live_status.get("board") or []) if c]
        if has_voluntary and len(dom_board) in (3, 4, 5) and len(dom_board) > len(board):
            board = dom_board
    street = ("river" if len(board) >= 5 else "turn" if len(board) == 4
              else "flop" if len(board) == 3 else "preflop")
    actions = []
    for a in acts_src:
        rec = {"seatId": a["seat"], "hero": a["seat"] == hero,
               "type": a["type"], "street": a["street"]}
        amt = to_bb(a.get("cents"))
        if amt is not None:
            rec["amount"] = amt
        actions.append(rec)
    committed = {s: to_bb(c) for s, c in committed_src.items()
                 if to_bb(c) is not None}
    stacks = {}
    for num, s in seats_src.items():
        v = _stack_bb(s.get("stack"))
        if v is not None:
            stacks[num] = v
    hero_cards = _ws_state.get("heroCards") or []
    if not hero_cards and _feed_prev.get("heroCards"):
        hero_cards = str(_feed_prev["heroCards"]).split()
    hero_cards = [short(c) for c in hero_cards]
    action_on = _ws_state.get("actionOn")
    hero_owed = _ws_state.get("maxBet", 0) - (committed_src.get(hero, 0) or 0)
    hero_folded = bool(_ws_state.get("heroFolded"))
    action_on_raw = action_on
    # THREE INDEPENDENT VIEWS OF HERO'S TURN, most direct first (2026-09-19):
    #  1. CO_SELECT_REQ — the client asking THIS player to act (heroTurn);
    #  2. the client's own action buttons on screen (the DOM);
    #  3. CO_CURRENT_PLAYER — whose clock the table says it is (actionOn).
    # The WS owns action-on, but it misses villain actions in tap gaps. Hand
    # 4917810973 (2026-09-12): the BB's river bet reached the log only through
    # the DOM backfill, the WS still had action on the BB, and hero sat 14 s
    # with FOLD / CALL / RAISE on screen while this export said "not hero's
    # turn" — so the poller never asked. Buttons up outside the deal grace with
    # real action in the hand, OR buttons that have HELD for a second (first
    # to act preflop has no voluntary action yet), OR the client's own request
    # for hero's action: any of them means hero to act.
    src = _to_act_sources(bool(_live_status.get("toAct")))
    since = _live_status.get("toActSince") or 0.0
    buttons_held = bool(src["buttons"]) and past_grace and since and (time.time() - since) >= 1.0
    if (action_on != hero and not hero_folded
            and (src["ws"] or (src["buttons"] and past_grace and has_voluntary) or buttons_held)):
        action_on = hero
    # ACTION-ON ALONE IS NOT A TURN (session 100647, hand 9): CO_CURRENT_PLAYER
    # stays on hero for a tick or two after hero's own action, and it names
    # hero at a new street before the client has asked (CO_SELECT_REQ) or
    # drawn the buttons. Both windows sent the poller a stale spot (a 4.7 s
    # preflop solve abandoned at the flop; a 5 s river solve on a line that
    # ended on villain's turn). The client's request or its buttons carry
    # every real turn; action-on only corroborates.
    action_on_only = (action_on == hero and not src["ws"] and not src["buttons"])
    to_act_hero = action_on == hero and not action_on_only
    # Uncontested win: every dealt villain has folded — the hand is over and
    # there is no decision left to solve (the panel shows "you win", not a
    # solver failure).
    folded_seats = {a["seat"] for a in acts_src if a["type"] == "fold"}
    villains = [s for s in dealt if s != hero]
    hero_won = (not hero_folded and bool(villains)
                and all(s in folded_seats for s in villains))
    # THE LEVEL RECONCILER'S LINE, when it is the better one (cut-over 2026-09-19,
    # see _reconciled_line): the event log's line is replaced when the two differ
    # and the reconciler's invariants hold; a failed invariant keeps the event
    # log's line and marks the answer uncertain (auto-execute then holds).
    actions, rc_ledger, line_uncertain, line_note, line_source = _reconciled_line(actions, hero, street)
    if rc_ledger is not None:
        committed = rc_ledger["committed"]
        hero_owed_bb = max(0.0, rc_ledger["maxBet"] - (committed.get(hero, 0.0) or 0.0))
    else:
        hero_owed_bb = None
    status = _live_status.get("hero")
    not_to_act_why = (None if to_act_hero and not hero_folded and not hero_won
                      else "hero folded" if hero_folded else "hand won" if hero_won
                      else f"status {status}" if status in ("sitting-out", "waiting-for-bb")
                      else "action-on names you but the client has not asked and shows no buttons" if action_on_only
                      else f"action on seat {action_on_raw}" if action_on_raw is not None
                      else "action-on unknown")
    return {
        "handId": _hand_no,
        # WHICH TABLE THIS IS (2026-09-19). With up to four tables open, `handId` is a
        # per-PROCESS counter and collides across them; the site's own clientHandId does
        # not. The slot is what attributes a hand, an answer and a press to one table in
        # a session that spans all of them — null on the single-table setup, which has
        # no slots and needs none.
        "tableSlot": TABLES.slot(),
        "panelPort": PANEL_PORT,
        # the site's own hand id — stable across wrapper restarts, so live
        # study answers can be joined to the archived hand later
        "clientHandId": _hand_ids.get(_hand_no),
        # the table's big blind in wire cents (200 = $1/$2, 500 = $2.50/$5),
        # once this hand's BB post has calibrated the scale — lets the solver
        # pick the rake-matched chart set (ign200 vs ign500) for 3-max
        "bbCents": bb if scaled else None,
        "heroSeatId": hero,
        "heroCards": hero_cards,
        "board": board,
        "street": street,
        "actions": actions,
        "liveSeats": sorted(dealt),
        "committed": committed,
        "potByStreet": {},
        "positions": positions,
        "stacks": stacks or None,
        "currentNode": {
            "street": street,
            "toActSeatId": action_on,
            "toActIsHero": to_act_hero,
            "pot": to_bb(_ws_state.get("potCents")) or 0,
            "toCall": (round(hero_owed_bb, 2) if hero_owed_bb is not None else to_bb(max(0, hero_owed))) or 0,
            "legalActions": [],
            "complete": False,
        },
        "heroFolded": hero_folded,
        "heroWon": hero_won,
        "ended": hero_folded or hero_won,
        # STATE PROVENANCE (2026-09-19) — how "hero to act" was decided, so the
        # consumer (gto-trainer studyPoller) can say WHY it did not ask instead
        # of staying silent: the buttons view, the client's request, action-on,
        # hero's status, and the reason when the answer is "not hero's turn".
        "buttonsUp": bool(src["buttons"]),
        "toActSources": src,
        "heroStatus": status,
        "notToActWhy": not_to_act_why,
        # which line the export carries and whether it can be trusted
        "lineSource": line_source,
        "lineUncertain": line_uncertain,
        "lineNote": line_note,
    }


# ---- Hand history (assistive-play's exact schema) --------------------------
# Every finished hand is archived into data/hands.db with the same DDL and
# column semantics as assistive-play's HandStore (src/store/handStore.ts), so
# its History/replay/MDA tooling reads Windows hands unchanged. The `data`
# blob is the structured /hand export plus this hand's feed lines.
DATA_DIR = ROOT / "data"
_DB_DDL = """CREATE TABLE IF NOT EXISTS hands (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_id INTEGER,
  played_at INTEGER,
  stakes TEXT,
  street TEXT,
  result_text TEXT,
  result_amount REAL,
  hero_cards TEXT,
  action_count INTEGER,
  data TEXT NOT NULL
)"""


def _db() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    c = sqlite3.connect(DATA_DIR / "hands.db", timeout=5)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute(_DB_DDL)
    return c


def _stakes_str() -> str | None:
    bb = _ws_state.get("bb") or 0
    if not (bb and _ws_state.get("bbSeen")):
        return None
    return f"${bb / 200:.2f}/${bb / 100:.2f}"


_last_archived = {"no": 0, "fp": None}
_archive_lock = threading.Lock()


def _archive_fp(h: dict) -> tuple:
    """What makes two archive attempts the SAME hand, independent of the
    wrapper's own hand counter: the site's hand id when we have one, else the
    hand's content. The counter is not enough — a table close followed by a
    reopen (Zone table break, re-seat) bumps _hand_no on the DOM tick without
    a PLAY_STAGE_INFO to reset the WS state, so the previous hand's actions
    were re-archived under a fresh number and no client id, once per
    open/close, until the next real deal (hands.db rows 125/126, 186/187,
    224/225 were exactly that)."""
    if h.get("clientHandId"):
        return ("id", h["clientHandId"])
    return ("body", h.get("stakes"), tuple(h["heroCards"]),
            tuple((a["seatId"], a["type"], a.get("amount")) for a in h["actions"]))


def _archive_hand() -> None:
    """Persist the finishing hand. Called at the NEXT hand's PLAY_STAGE_INFO
    (the reliable end-of-hand signal), at table close (no next hand will
    ever come), after the ended-hand grace, and at stand-down — the dedupe
    guards make the triggers safe together. The lock is what makes them safe
    concurrently: two triggers on different threads (WS tap + feed loop) both
    passed the id guard before either had set it, and wrote the same hand
    twice in the same second (rows 190/191, 273/274)."""
    if _fake_mode or _is_cp():
        return  # authored test states are not hand history; CoinPoker archives via _archive_cp
    with _archive_lock:
        _archive_hand_locked()


def _award_name(win: dict, row: list) -> str:
    """The winner's label on the award row. The client labels players 'Player
    N' (anonymous tables; N = the seat). A one-line award ("Player 3 wins
    ($5).") has the name node touching the win text (gap 0); a WRAPPED award
    ("Player 2 wins main pot ($74) with (…)") has the win text's box starting
    at the row's left edge, so the name node sits INSIDE it (gap −40). Prefer
    the row's 'Player N' node outright; fall back to the nearest left neighbour."""
    same_row = [x for x in row if x is not win and abs(x["y"] - win["y"]) <= 8 and x["x"] <= win["x"] + 4]
    tagged = [x for x in same_row if re.fullmatch(r"Player \d+", x["text"].strip())]
    if tagged:
        return min(tagged, key=lambda x: abs(x["x"] - win["x"]))["text"].strip()
    near = [x for x in same_row if -4 <= win["x"] - (x["x"] + x["w"]) < 60]
    return min(near, key=lambda x: win["x"] - (x["x"] + x["w"]))["text"].strip() if near else ""


# client hand id -> {winnerSeat, winnerLabel, wonCents, text}, from the result box
_awards: dict[str, dict] = {}
_AWARD_WIN = re.compile(r"^wins\b.*?\(\$([\d,]+(?:\.\d+)?)\)", re.I)


def _note_award(hid: str, id_node: dict, nodes: list) -> None:
    """Read 'Player S wins ($X)' under a 'Result for hand N' node; archive it,
    patching the hand's row when the award arrives after the archive (the box
    can render a beat after the next hand's deal)."""
    row = [x for x in nodes if 12 <= x["y"] - id_node["y"] <= 40 and abs(x["x"] - id_node["x"]) < 120]
    win = next((x for x in row if _AWARD_WIN.match(x["text"])), None)
    if not win:
        return
    cents = int(round(float(_AWARD_WIN.match(win["text"]).group(1).replace(",", "")) * 100))
    name = _award_name(win, row)
    m = re.search(r"Player (\d+)", name)
    seat = int(m.group(1)) if m else None
    rec = {"winnerSeat": seat, "winnerLabel": name or None, "wonCents": cents,
           "text": ("★ " + (name + " " if name else "") + win["text"]).strip()}
    if _awards.get(hid) == rec:
        return
    _awards[hid] = rec
    for k in list(_awards)[:-60]:
        _awards.pop(k, None)
    # already archived (the box came late)? patch the row in place
    if _hand_ids.get(_last_archived["no"]) == hid:
        try:
            c = _db()
            try:
                r = c.execute("SELECT rowid, data FROM hands WHERE data LIKE ? ORDER BY rowid DESC LIMIT 1",
                              (f'%"{hid}"%',)).fetchone()
                if r:
                    h = json.loads(r[1])
                    if h.get("clientHandId") == hid and (h.get("result") or {}).get("wonCents") != cents:
                        h["result"] = {**(h.get("result") or {}), **rec, "heroWon": seat == h.get("heroSeatId")}
                        c.execute("UPDATE hands SET data = ?, result_text = ? WHERE rowid = ?",
                                  (json.dumps(h), rec["text"], r[0]))
                        c.commit()
                        print(f"[history] award attached to hand {hid}: seat {seat} ${cents / 100:.2f}")
            finally:
                c.close()
        except Exception as e:
            print(f"[history] award patch failed: {e}")


def _cp_line(room: str, line: str) -> None:
    """A CoinPoker feed line (sites/coinpoker log thread) onto the panel feed."""
    if _is_cp() and (not CP.pinned or room == CP.pinned):     # attached: that table's lines only
        _feed_add(f"[{room.split()[-1]}] {line.strip()}")


def _cp_finished(room, raw: dict) -> None:
    """A CoinPoker hand the log says is over -> hands.db (same table as Ignition's,
    tagged site=coinpoker). Only while a CoinPoker session is the site, so hands
    land in the session that played them."""
    if not _is_cp():
        return
    if CP.pinned and room.name != CP.pinned:
        return      # another panel's table: its own panel (and session) archives it
    try:
        _archive_cp(room, raw)
    except Exception as e:
        print(f"[history] coinpoker archive failed: {e}")


def _archive_cp(room, raw: dict) -> None:
    if not raw.get("bb") or not raw.get("actions"):
        return
    # YOUR hands only: a table you are watching (not seated, or sitting out) deals
    # other people's hands through the same log, and those are not hand history
    if raw.get("hero") is None or raw["hero"] not in (raw.get("dealt") or []):
        return
    h = CP.export_finished(room, raw)
    if not h:
        return
    hid = str(raw["id"])
    hero = (raw.get("seats") or {}).get(raw.get("hero"), {}).get("name")
    net = None
    if hero:
        put = sum(a["added"] for a in raw["actions"] if a["name"] == hero)
        won = sum(w.get("won") or 0 for w in raw.get("winners") or [] if w.get("name") == hero)
        back = (raw.get("returned") or {}).get(raw.get("hero"), 0)
        net = round(won + back - put, 4)
    winners = ", ".join(f"{w['name']} {w['won']}" for w in raw.get("winners") or [])
    bb = float(raw["bb"])
    h.update({"playedAt": raw.get("serverT0") or int(time.time() * 1000),
              "stakes": f"{raw.get('sb')}/{raw.get('bb')}" + (f" ante {raw['ante']}" if raw.get("ante") else ""),
              "sessionId": _session["id"], "site": CPS.SITE,
              "feedLines": [], "shown": raw.get("shown"),
              "result": {"text": winners or None, "winners": raw.get("winners"),
                         "heroNet": net, "heroNetBb": round(net / bb, 2) if net is not None and bb else None,
                         "heroWon": bool(net and net > 0)},
              "startStacks": raw.get("startStacks"), "rake": (CP.table() or {}).get("rake")})
    with _archive_lock:
        c = _db()
        try:
            if c.execute("SELECT 1 FROM hands WHERE data LIKE ? LIMIT 1", (f'%"clientHandId": "{hid}"%',)).fetchone():
                return          # a restart replays the log's tail; never write a hand twice
            c.execute(
                "INSERT INTO hands (hand_id, played_at, stakes, street, result_text,"
                " result_amount, hero_cards, action_count, data) VALUES (?,?,?,?,?,?,?,?,?)",
                (int(hid) if hid.isdigit() else None, h["playedAt"], h["stakes"], h["street"],
                 winners or None, None, " ".join(h.get("heroCards") or []) or None,
                 len(h["actions"]), json.dumps(h)))
            c.commit()
        finally:
            c.close()
    print(f"[history] coinpoker hand {hid} archived ({h['stakes']}, hero net {net})")


def _archive_hand_locked() -> None:
    try:
        h = _hand_state()
        if not h or not h["actions"]:
            return
        if h["handId"] == _last_archived["no"]:
            return  # already flushed (table close followed by a rejoin)
        # YOUR HANDS ONLY (2026-09-23, the rule _archive_cp always had): a hand hero was not dealt into is not hand
        # history. 35 of the 93 empty archived hands were sit-outs / waiting-for-BB / re-seats filed as hero hands,
        # and every per-hand statistic counted them. `heroDealt` is the deal frame's word (CO_CARDTABLE_INFO); the
        # liveSeats check is the belt for hands whose export predates the flag.
        if _ws_state.get("heroDealt") is False or h["heroSeatId"] not in (h.get("liveSeats") or [h["heroSeatId"]]):
            _last_archived["no"] = h["handId"]
            print(f"[history] skipped hand #{h['handId']}: hero was not dealt in (not hand history)")
            return
        lines = [f["line"] for f in _feed if f.get("hand") == _hand_no]
        result = next((x for x in reversed(lines)
                       if re.search(r"\bwins?\b|Result for hand", x)), None)
        h["playedAt"] = int(time.time() * 1000)
        h["stakes"] = _stakes_str()
        h["clientHandId"] = _hand_ids.get(_hand_no)
        _shadow_archive(h)
        h["sessionId"] = _session["id"]
        h["feedLines"] = lines
        if result:
            h["result"] = {"text": result}
        aw = _awards.get(h["clientHandId"] or "")
        if aw:
            h["result"] = {**(h.get("result") or {"text": aw["text"]}), **aw,
                           "heroWon": aw.get("winnerSeat") == h.get("heroSeatId")}
        fp = _archive_fp(h)
        # the BODY alone (no id, no hero cards): a reopen replays the previous hand's state under a fresh counter
        # and no id, and the DOM cards it carries can differ from the archived row's — row 374 replayed 373 past
        # the id-vs-body fingerprint, rows 595-598 replayed one dead hand four times with four card readings
        body = ("body", h.get("stakes"), tuple((a["seatId"], a["type"], a.get("amount")) for a in h["actions"]))
        if fp == _last_archived["fp"] or (not h.get("clientHandId") and body == _last_archived.get("body")):
            # Same hand as the last archive under a new counter value — the
            # previous hand's state replayed by a reopen, not a new hand.
            _last_archived["no"] = h["handId"]
            print(f"[history] skipped hand #{h['handId']}: same hand as the last "
                  f"archive (table reopen replayed the previous hand's state)")
            return
        c = _db()
        try:
            # ONE ROW PER CLIENT HAND, ACROSS PROCESSES (2026-09-23). Two wrappers reading one table (2026-09-20/21,
            # 44 client hand ids archived twice) both passed their own in-process guards; the shared hands.db is the
            # only place the duplicate is visible, so it is refused here — as _archive_cp has always done.
            cid = h.get("clientHandId")
            if cid and c.execute("SELECT 1 FROM hands WHERE data LIKE ? LIMIT 1", (f'%"clientHandId": "{cid}"%',)).fetchone():
                _last_archived["no"] = h["handId"]
                _last_archived["fp"] = fp
                print(f"[history] skipped hand #{h['handId']}: client hand {cid} is already archived (another wrapper on this table?)")
                return
            cur = c.execute(
                "INSERT INTO hands (hand_id, played_at, stakes, street, result_text,"
                " result_amount, hero_cards, action_count, data)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (h["handId"], h["playedAt"], h["stakes"], h["street"], result, None,
                 ",".join(h["heroCards"]), len(h["actions"]), json.dumps(h)))
            h["dbId"] = cur.lastrowid
            c.execute("UPDATE hands SET data = ? WHERE rowid = ?",
                      (json.dumps(h), h["dbId"]))
            c.commit()
        finally:
            c.close()
        _last_archived["no"] = h["handId"]
        _last_archived["fp"] = fp
        _last_archived["body"] = body
        print(f"[history] archived hand #{h['handId']} ({len(h['actions'])} actions)")
    except Exception as e:
        print(f"[history] archive failed: {e}")


def history(limit: int = 20) -> dict:
    try:
        c = _db()
        try:
            n = c.execute("SELECT COUNT(*) FROM hands").fetchone()[0]
            rows = c.execute(
                "SELECT rowid, hand_id, played_at, stakes, street, result_text,"
                " hero_cards, action_count FROM hands ORDER BY rowid DESC LIMIT ?",
                (limit,)).fetchall()
        finally:
            c.close()
        return {"count": n, "hands": [
            {"dbId": r[0], "handId": r[1], "playedAt": r[2], "stakes": r[3],
             "street": r[4], "result": r[5], "heroCards": r[6], "actions": r[7]}
            for r in rows]}
    except Exception as e:
        return {"count": 0, "hands": [], "error": str(e)}


def _ws_tap() -> None:
    """Follow the table's WebSocket via CDP, forever, reconnecting as needed.
    Every reconnect is a blind window (Zone table hops kill the connection) —
    keep it SHORT and make it VISIBLE; the DOM diff backfills what was missed."""
    import websocket
    was_up = False
    while True:
        try:
            t = ignition_target()
            if not t:
                time.sleep(1)
                continue
            c = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=60,
                                            suppress_origin=True)
            c.send(json.dumps({"id": 1, "method": "Network.enable"}))
            print("[ws] tapped table game protocol")
            _dump_event("<tap-connected>", target=t.get("url", ""))
            if was_up:
                _feed_add("(capture reconnected — DOM backfill covered the gap)")
            was_up = True
            ping_id = 1
            while True:
                try:
                    m = json.loads(c.recv())
                except websocket.WebSocketTimeoutException:
                    # An idle table sends nothing for minutes; that is NOT a
                    # dead socket. Tearing down on the 60s read timeout cycled
                    # the connection every minute, each cycle a blind window
                    # (183 reconnect markers in one day's feed). Probe the SAME
                    # connection instead; a real corpse fails the send.
                    ping_id += 1
                    c.send(json.dumps({"id": ping_id, "method": "Network.enable"}))
                    continue
                if m.get("method") != "Network.webSocketFrameReceived":
                    continue
                raw = m["params"]["response"].get("payloadData", "")
                try:
                    o = json.loads(re.sub(r"^\d+\|", "", raw))
                except Exception:
                    # Heartbeats ("2"/"3") are noise; anything longer that
                    # fails to parse is worth seeing in the dump.
                    if len(raw) > 4:
                        _dump_event("<unparsed>", raw=raw[:300])
                    continue
                d = o.get("data") if isinstance(o, dict) else None
                if isinstance(d, dict) and d.get("pid"):
                    rid = (m.get("params") or {}).get("requestId")
                    take = _tap_accepts(d, rid)
                    # a socket that has just bound hands back what it held while
                    # unbound - read that FIRST, so the hand starts at its start
                    batch = [(hd, _tap_bound, True) for hd in _tap_take_replay()]
                    if take:
                        batch.append((d, rid, False))
                    for fd, frid, replayed in batch:
                        e = _dump_begin(fd, frid)
                        if replayed:
                            e["replayed"] = True
                        try:
                            _on_game_msg(fd)
                        except Exception as ex:
                            e["status"] = f"handler-error: {ex}"
                        _dump_commit(e)
        except Exception as ex:
            if was_up:
                # Log the loss ONCE; was_up re-arms on the next successful
                # connect (which also prints the feed's reconnect note).
                _dump_event("<tap-lost>", err=str(ex)[:200])
                was_up = False
                _feed_add("(capture connection lost — reconnecting)")
            time.sleep(0.5)


# ── THE CONNECTION GUARD ──────────────────────────────────────────────────────────────────────────────
# (2026-09-22, Brady: "if the connection drops below a threshold, mandatory sit out next hand".) Answers
# are chains of GTO Wizard requests, so a bad link does not make them a little late - it makes them 25 s
# late, and on the river not there at all (the pocket-fives and T4s hands of session_20260922_194118).
# netcheck.py measures the path the answers take and holds the thresholds. Every NET_PROBE_EVERY_S while a
# session that answers is running, this probes; NET_BAD_TO_SITOUT bad probes IN A ROW tick "Sit out next
# hand" on OUR table (one bad probe is a blip; two, ~1.5 min apart, is a link). It never sits back in by
# itself - when the link has been good for NET_GOOD_TO_CLEAR probes it SAYS so and you press I'm back.
# While the link stays bad it keeps the box ticked, so sitting back in on a bad link is undone next hand.
NET_PROBE_EVERY_S = float(os.environ.get("NET_PROBE_EVERY_S") or "45")
NET_BAD_TO_SITOUT = 2
NET_GOOD_TO_CLEAR = 2
_net: dict = {"last": None, "bad": 0, "good": 0, "sitout": None, "history": deque(maxlen=40)}

_SITOUT_READ_JS_TMPL = r"""(() => {__FRAME__
  const f = __frame(__SLOT__);
  if (!f) return { ok: false, reason: 'no table frame' };
  let doc = null; try { doc = f.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return { ok: false, reason: 'table frame not readable' };
  const fb = f.getBoundingClientRect();
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const leaves = [...doc.querySelectorAll('*')].filter(e => e.children.length === 0);
  const back = leaves.some(e => /^\s*i'?m back\s*$/i.test(e.textContent || '') && vis(e));
  const seated = !!doc.querySelector("[data-qa='myPlayerTag']");
  const lab = leaves.find(e => /^\s*sit out next hand\s*$/i.test(e.textContent || '') && vis(e));
  if (!lab) return { ok: true, found: false, back, seated };
  // the tick state: a real checkbox, an aria-checked control, or a class that says so -
  // whichever the client uses, found by walking up from the label
  let checked = null, via = null, c = lab;
  for (let i = 0; i < 5 && c && c !== doc.body; i++) {
    const inp = c.querySelector && c.querySelector('input[type=checkbox]');
    if (inp) { checked = !!inp.checked; via = 'input'; break; }
    const ar = (c.hasAttribute && c.hasAttribute('aria-checked')) ? c : (c.querySelector && c.querySelector('[aria-checked]'));
    if (ar) { checked = ar.getAttribute('aria-checked') === 'true'; via = 'aria'; break; }
    c = c.parentElement;
  }
  const r = lab.getBoundingClientRect();
  return { ok: true, found: true, checked, via, back, seated,
           x: fb.x + r.x + r.width / 2, y: fb.y + r.y + r.height / 2,
           html: ((c || lab.parentElement || lab).outerHTML || '').slice(0, 600) };
})()"""


def _ignition_sitout_next_hand() -> dict:
    """Tick "Sit out next hand" on OUR table. Idempotent: reads the tick first and
    clicks only when it is not ticked. Already sitting out (I'm back showing) is
    success. Same guards as every other press (act): press lock, the window must
    be rendering, and the point must be inside OUR table's frame."""
    t = ignition_target()
    if not t:
        return {"ok": False, "why": "poker client not open"}
    ws = t["webSocketDebuggerUrl"]
    js = _slotted(_SITOUT_READ_JS_TMPL, TABLES.dom_slot())
    try:
        d = cdp._eval(ws, js, timeout=6) or {}
    except Exception as e:
        return {"ok": False, "why": f"table read failed: {e}"}
    if not d.get("ok"):
        return {"ok": False, "why": d.get("reason") or "table not readable"}
    if d.get("back"):
        return {"ok": True, "state": "already sitting out (I'm back is showing)"}
    if not d.get("found"):
        return {"ok": False, "why": "no 'Sit out next hand' box on the table" +
                ("" if d.get("seated") else " - not seated")}
    if d.get("checked") is True:
        return {"ok": True, "state": "already ticked"}
    if d.get("checked") is None and _net.get("sitout") and _net["sitout"].get("clicked"):
        # the tick state is unreadable and we already clicked it in this bad stretch:
        # a second click would UN-tick it
        return {"ok": True, "state": "clicked earlier this bad stretch (tick state unreadable)",
                "html": d.get("html")}
    with TABLES.press_lock():
        if blind := _ensure_visible(ws):
            return {"ok": False, "why": blind}
        if wrong := _point_is_my_table(ws, d["x"], d["y"]):
            return {"ok": False, "why": wrong}
        try:
            cdp._dispatch_click(ws, d["x"], d["y"])
        except Exception as e:
            return {"ok": False, "why": f"click did not go through: {e}"}
    time.sleep(0.4)
    try:
        after = cdp._eval(ws, js, timeout=6) or {}
    except Exception:
        after = {}
    if after.get("checked") is False and d.get("checked") is False:
        return {"ok": False, "why": "clicked, but the box still reads unticked", "clicked": True,
                "html": after.get("html")}
    return {"ok": True, "clicked": True,
            "state": "ticked" if after.get("checked") else "clicked (tick state unreadable - check the table)",
            "via": d.get("via"), "html": None if after.get("checked") else d.get("html")}


def _net_sitout(probe: dict) -> dict:
    res = (CP.sitout(True, False) if _is_cp() else _ignition_sitout_next_hand())
    first = _net["sitout"] is None
    _net["sitout"] = {**res, "at": time.time(), "clicked": res.get("clicked") or
                      bool(_net["sitout"] and _net["sitout"].get("clicked"))}
    if first or res.get("clicked"):
        why = "; ".join(probe.get("why") or []) or "connection too slow"
        _feed_add(f"CONNECTION TOO SLOW for answers ({why}) - "
                  + ("sitting out next hand" if res.get("ok") else f"could NOT sit out: {res.get('why')}"
                     " - SIT OUT YOURSELF"))
        print(f"[net] sit-out: {res}")
        if _session["id"]:
            _sessions.event(_session["id"], "net-sitout", {"hand": _hand_no, "probe": _net_compact(probe),
                                                           "result": {k: v for k, v in res.items() if k != "html"}})
    return res


def _net_compact(p: dict) -> dict:
    return {k: p.get(k) for k in ("ok", "at", "rttMs", "lostOf10", "warmMedMs", "warmMaxMs")}


def _net_step(p: dict) -> None:
    """One probe's consequences (split out of the loop so it can be tested)."""
    _net["last"] = p
    _net["history"].append(_net_compact(p))
    sid = _session["id"]
    if p["ok"]:
        _net["good"] += 1
        if _net["bad"] >= NET_BAD_TO_SITOUT and sid:
            _sessions.event(sid, "net-recovering", {"hand": _hand_no, "probe": _net_compact(p)})
        _net["bad"] = 0
        if _net["sitout"] and _net["good"] >= NET_GOOD_TO_CLEAR:
            _feed_add("Connection is good again - press I'm back when you are ready")
            if sid:
                _sessions.event(sid, "net-ok", {"hand": _hand_no, "probe": _net_compact(p)})
            _net["sitout"] = None
        return
    _net["good"] = 0
    _net["bad"] += 1
    if _net["bad"] == 1:
        _feed_add("Connection slow: " + "; ".join(p.get("why") or []) +
                  " - sitting out if the next check is bad too")
    if _net["bad"] >= NET_BAD_TO_SITOUT:
        _net_sitout(p)


def _net_guard() -> None:
    import netcheck as NC
    # stagger the tables' probes so four wrappers do not measure each other's traffic
    time.sleep(3 + 7 * ((TABLES.slot() or 1) - 1))
    while True:
        try:
            cfg = ((_session.get("rec") or {}).get("config")) or {}
            if not _session["id"] or _fake_mode or not cfg.get("answers"):
                _net.update({"bad": 0, "good": 0, "sitout": None})
                time.sleep(5)
                continue
            _net_step(NC.probe())
        except Exception as e:
            print(f"[net] guard error: {e}")
        time.sleep(NET_PROBE_EVERY_S)


def _maybe_flush_ended() -> None:
    """Archive a FINISHED hand after a short grace even when no next hand ever
    arrives (player pauses / sits out after it) — otherwise it waits for the
    next PLAY_STAGE_INFO indefinitely and never reaches the dashboard. The
    grace lets the result/win feed lines land first; _archive_hand's id guard
    makes the eventual next-hand trigger a harmless no-op."""
    if _is_cp():
        return      # CoinPoker's log says when a hand ends (_archive_cp)
    h = _hand_state()
    over = bool(_ws_state.get("handOver")) or bool(h and h.get("ended"))
    if not h or not over or not h.get("actions") or h["handId"] == _last_archived["no"]:
        _ws_state["endedSince"] = None
        return
    since = _ws_state.get("endedSince")
    if since is None:
        _ws_state["endedSince"] = time.time()
    elif time.time() - since > 8:
        _archive_hand()


FEED_STALL_TICKS = 8


def _feed_loop() -> None:
    fails = 0
    while True:
        try:
            _feed_tick()
            if fails:
                _feed_add("Table reader recovered")
                _live_status["feedStalled"] = None
            fails = 0
        except Exception as e:
            # A DEAD READER MUST NOT LOOK LIKE AN IDLE TABLE (EIP-22, 2026-09-23). This was `except: pass`: a tick
            # that raised every time (a new client build, a changed node) froze _live_status at its last values,
            # /state kept saying connected, and the poller kept probing a stale export with no error anywhere.
            fails += 1
            if fails == 1 or fails % 40 == 0:
                print(f"[feed] tick failed ({fails}x): {e!r}")
            if fails == FEED_STALL_TICKS:
                _live_status["feedStalled"] = {"since": int(time.time() * 1000), "error": repr(e)[:200]}
                _live_status["toAct"] = False    # a frozen 'to act' must not keep a press live
                _feed_add(f"⚠ table reader failing for {fails} ticks: {e!r}"[:160])
                if _session["id"]:
                    try:
                        _sessions.event(_session["id"], "feed-stalled", {"hand": _hand_no, "error": repr(e)[:200]})
                    except Exception:
                        pass
        try:
            _maybe_flush_ended()
        except Exception:
            pass
        try:
            _maybe_auto_arm()
            # BEFORE the auto press, not after: this is the one that may decide to
            # hold hero's clock for a moment and buy chips first. It puts the
            # Buy-chips panel over the strip, which _maybe_auto_act reads as "the
            # strip is covered" and waits on - so the ordering IS the handshake.
            _maybe_prefold_top_up()
            _maybe_auto_act()
            _maybe_verify_exec()
            _maybe_take_time()
            _maybe_guard_buy_panel()
            _maybe_session_orphaned()
            _maybe_session_adopt()
            _maybe_stand_down()
            _top_up_kpi_tick()
            _maybe_top_up()
        except Exception as e:
            print(f"[pick] auto: {e}")
        # State reads are cheap (~35ms DOM eval); sampling often is what keeps
        # fast actions attributable to the right street and order.
        time.sleep(0.25)


def act(label: str, kind: str = "action") -> dict:
    """Relay ONE human-chosen press: re-read the strip, match the label within
    its OWN row (action row vs sizing row), click the button's centre. Amounts
    baked into labels ("ALL-IN 255.4 BB") change between render and press, so a
    miss on exact text falls back to the action word within the same row —
    never across rows, so the sizing ALL-IN can't swallow the shove (or vice
    versa).

    This is an ASSISTIVE INPUT relay: it actuates only a control the user has
    just pressed on the panel, on the table they are already sitting at. It
    never chooses an action, never acts unprompted, and never acts on anything
    the client is not currently offering — the decision is always the user's,
    exactly as with any other alternative input device.

    Special labels outside the strip (e.g. "Buy chips") match any button."""
    # OUR OWN MODAL FIRST (2026-09-20). The Buy-chips panel renders OVER the action
    # strip, so an action relayed while it is up lands on the panel instead of on
    # FOLD / CALL / RAISE — and the reader would report a clean press. Fold it away
    # and call the top-up off: the stack can wait a hand, the turn cannot.
    if kind in ("action", "preset") and _topup_panel["open"]:
        _topup_abort.set()
        _close_buy_panel()
        time.sleep(0.4)
    t = ignition_target()
    if not t:
        return {"ok": False, "reason": "poker client not open"}
    try:
        d = cdp._eval(t["webSocketDebuggerUrl"], _table_js(TABLES.dom_slot()), timeout=6) or {}
    except Exception as e:
        return {"ok": False, "reason": f"table read failed: {e}"}
    if not d.get("seated"):
        return {"ok": False, "reason": "no table tab open"}
    # THE FRESH READ DECIDES (EVM-03, 2026-09-23): the modal guard in _pick_ready is a tick old; a notice that
    # appeared between the tick and this press would be pressed through — the action buttons stay in the DOM
    # under the overlay with a size, so the click dispatches at their coordinates and lands on the notice.
    if kind in ("action", "preset") and _modal_of(d):
        return {"ok": False, "reason": "a client notice is over the action strip (seen on the press's own read)"}
    actions, presets = _split_strip(d)
    pool = presets if kind == "preset" else actions if kind == "action" \
        else d.get("buttons", [])
    want = label.strip().lower()
    hit = next((b for b in pool if b["text"].lower() == want), None)
    if not hit:
        m = _ACTION_RE.match(label)
        word = (m.group(0) if m else label.split()[0] if label.split() else label).lower()
        hit = next((b for b in pool if b["text"].lower().startswith(word)), None)
    if not hit:
        return {"ok": False, "reason": f"'{label}' not on offer ({kind})",
                "offer": [b["text"] for b in pool]}
    # SERIALIZED ACROSS TABLES (2026-09-19): bringToFront for one window can hide
    # another's, and Chrome parks synthetic input on a hidden page. A no-op unless
    # several tables are open — see tables.press_lock.
    with TABLES.press_lock() as lk:
        if blind := _ensure_visible(t["webSocketDebuggerUrl"]):
            return {"ok": False, "reason": blind, "offer": [b["text"] for b in pool]}
        px, py = hit["x"] + hit["w"] / 2, hit["y"] + hit["h"] / 2
        if wrong := _point_is_my_table(t["webSocketDebuggerUrl"], px, py):
            return {"ok": False, "reason": wrong, "offer": [b["text"] for b in pool]}
        try:
            cdp._dispatch_click(t["webSocketDebuggerUrl"], px, py)
        except Exception as e:
            return {"ok": False, "reason": f"click did not go through: {e}", "offer": [b["text"] for b in pool]}
    out = {"ok": True, "clicked": hit["text"], "kind": kind,
           "at": [hit["x"] + hit["w"] // 2, hit["y"] + hit["h"] // 2]}
    if getattr(lk, "waited", 0):
        out["pressWaitedS"] = lk.waited
    if getattr(lk, "forced", False):
        out["pressLockForced"] = True     # another table held the windows; pressed anyway
    return out


def _point_is_my_table(ws: str, x: float, y: float) -> str | None:
    """None if that page point is inside THIS table, else why it is not.

    THE PRESS THAT LANDS ON SOMEONE ELSE'S FELT is the worst thing this codebase
    can do, and with four tables in one page it is one arithmetic slip away: a
    button's page coordinate is its frame's offset plus its position inside that
    frame, so the moment a table's content is taller than the frame the client
    gave it, the coordinate walks out of our table and into the neighbour below.
    Measured on the rig 2026-09-20: slot 0's action row computed to page y=373
    while slot 0's frame ended at y=368 — the click would have gone to slot 2.

    So the point is checked against the client's own hit-testing, not against our
    arithmetic: whatever `elementFromPoint` says is there has to be inside the
    iframe carrying OUR data-multitableslot. A single table (no slot) keeps the
    old behaviour and is not checked — there is no other table to hit."""
    me = TABLES.dom_slot()
    if me is None:
        return None
    js = ("(() => { const e = document.elementFromPoint(%f, %f);"
          " if (!e) return 'nothing is at that point — it is off the page';"
          " const f = e.closest ? e.closest('iframe[data-multitableslot]') : null;"
          " const own = (e.getAttribute && e.getAttribute('data-multitableslot'))"
          "   || (f && f.getAttribute('data-multitableslot'));"
          " return own === null || own === undefined ? 'unknown' : String(own); })()") % (x, y)
    try:
        got = cdp._eval(ws, js, timeout=4)
    except Exception as e:
        return f"could not check which table that point is on: {e}"
    if got == str(me):
        return None
    if got == "unknown":
        return None                      # single-frame page (the rig) — nothing to confuse it with
    return (f"that press would land on table {int(got) + 1}, not table {TABLES.slot()} "
            f"— refusing" if str(got).lstrip("-").isdigit() else f"that press would not land on table {TABLES.slot()} ({got})")


def _ensure_visible(ws: str) -> str | None:
    """Make the page render, or say why it cannot. None = visible, else the reason.

    A fully covered (or minimized) page is `visibilityState: hidden`, and Chrome then
    parks synthetic input until a frame is produced — a relayed click waits forever
    (seen on the test rig with the panel over the table). Page.bringToFront makes it
    render; on a table that is already showing it changes nothing.

    A MONITOR THAT IS ATTACHED BUT ASLEEP CANNOT BE WOKEN THIS WAY (2026-09-19). Windows
    still enumerates it, so the layout happily puts the table there, and the page then
    reports `hasFocus(): true` with `visibilityState: hidden` — focused, rendering
    nothing. bringToFront returns OK in 20 ms and changes nothing. Every click after
    that spends five seconds in the socket and comes back "Connection timed out", which
    says nothing about the cause. So the check now REPORTS: one honest refusal naming
    the real problem beats a timeout per press."""
    try:
        if cdp._eval(ws, "document.visibilityState", timeout=3) == "visible":
            return None
        _cdp_seq(ws, [("Page.bringToFront", {})])
        if cdp._eval(ws, "document.visibilityState", timeout=3) == "visible":
            return None
        return ("the table window is not rendering (its screen is off or asleep, or the "
                "window is minimized) — Chrome parks clicks on a page producing no frames")
    except Exception as e:
        return f"could not check the table window: {e}"


# The bet-size input inside the table's action strip (present on raise turns).
# The ANCHOR is what tells the bet field from any other field on screen. Until
# 2026-09-20 this returned the inputs alone and raise_to took inputs[0] — the
# first one in DOM order, anywhere in the lower 40% of the frame. The Buy-chips
# panel has an amount field of its own and sits bottom-LEFT (buyInButton x=32)
# while the action strip is at x>=320, so with that panel up the relay typed the
# raise size into the BUY box: hand 4919313617 (dashboard 513) was told Raise 2.5,
# typed 2.5 into the buy-in field, re-read that same field for the clamp check,
# saw no clamp, pressed RAISE — and the client took its default, 2 BB.
_FIND_INPUT_JS_TMPL = r"""(() => {__FRAME__
  const tf = __frame(__SLOT__);
  if (!tf || !tf.contentDocument) return {practice: false, inputs: [], anchor: null};
  const d = tf.contentDocument, fb = tf.getBoundingClientRect();
  const inputs = [...d.querySelectorAll('input, [contenteditable=true]')].map(el => {
    const r = el.getBoundingClientRect();
    return {r, value: el.value ?? el.textContent, type: el.type || 'editable'};
  // EVERY visible input. This used to keep only the lower 40% of the frame, on
  // the assumption that the action strip lives there — which is true only while
  // the frame is about as tall as the table it renders. When the external screen
  // moved from 200% to 100% scaling the frame became 1513 px tall around the same
  // ~756 px of table, the bet field landed at 39% of the frame, and every relayed
  // raise was refused as "not a raise spot" (2026-09-20). Frame-relative geometry
  // was never the right discriminator; the RAISE/BET button beside the field is
  // (see _pick_bet_input), and it does not care how tall the frame is.
  }).filter(i => i.r.width > 0 && i.r.height > 0)
    .map(i => ({x: Math.round(fb.x + i.r.x + i.r.width / 2),
                y: Math.round(fb.y + i.r.y + i.r.height / 2),
                h: Math.round(i.r.height),
                value: String(i.value), type: i.type}));
  // the action button this raise will be confirmed on — the bet field is the one
  // beside it, never the one beside some other panel's button
  const ab = [...d.querySelectorAll('[data-qa=raiseButton], [data-qa=betButton]')]
    .map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0)[0];
  const anchor = ab ? {x: Math.round(fb.x + ab.x + ab.width / 2),
                       y: Math.round(fb.y + ab.y + ab.height / 2)} : null;
  // any OTHER panel with a field of its own that could pose as the bet box
  const buy = !!d.querySelector('[data-qa=buyInButton]');
  return {practice: (tf.src || '').includes('playMode=fun'), inputs, anchor, buyPanel: buy,
          frameW: Math.round(fb.width)};
})()"""


def _find_input_js(slot: int | None = None) -> str:
    return _slotted(_FIND_INPUT_JS_TMPL, slot)




# Half the frame: comfortably wider than the sizing row, far narrower than the gap
# to the Buy-chips panel on the far left (strip x>=320 vs buy-in x~32 at 883 wide).
BET_INPUT_MAX_DX = 0.5
# ... and the field is on the SAME STRIP as the button, so it is within a few of
# its own heights of it vertically. Measured in the input's own height rather
# than the frame's, because the frame's height is exactly what stopped being a
# reliable unit when the display scaling changed.
BET_INPUT_MAX_DY_ROWS = 3.0


def _pick_bet_input(inputs: list[dict], anchor: dict | None, frame_w: float | None = None) -> tuple[dict | None, str | None]:
    """The client's BET field among everything else on screen.

    Returns (input, refusal). A refusal is deliberate: relaying a size into a field
    we have not identified is how hand 513 raised 2x when it was told 2.5x, and the
    read-back clamp check cannot catch it because it re-reads the same wrong field.
    Pressing nothing is always recoverable; pressing the wrong size is not."""
    if not inputs:
        return None, "no bet input on screen — not a raise spot?"
    if anchor is None:
        # No RAISE/BET button means this is not a sizing spot at all. One field and
        # nothing to confirm on is still not something to type into blind.
        return (inputs[0], None) if len(inputs) == 1 else (None, f"{len(inputs)} inputs on screen and no RAISE/BET button to tell them apart")
    # SAME STRIP AS THE BUTTON. The row is narrowed FIRST and the nearest field
    # chosen within it — not the other way round. Picking the horizontally
    # nearest input and then vetoing it on row would let anything that happens
    # to sit above the button deny a perfectly good bet field beside it.
    ay = anchor.get("y")
    def same_row(i: dict) -> bool:
        if ay is None or not i.get("h"):
            return True                  # nothing to judge it on — let dx decide
        return abs(i["y"] - ay) <= i["h"] * BET_INPUT_MAX_DY_ROWS
    row_inputs = [i for i in inputs if same_row(i)]
    if not row_inputs:
        off = min(abs(i["y"] - ay) for i in inputs)
        return None, (f"the nearest input is {off}px above/below the RAISE/BET button "
                      f"— a different row, not the bet field")
    near = min(row_inputs, key=lambda i: abs(i["x"] - anchor["x"]))
    dx = abs(near["x"] - anchor["x"])
    if frame_w and dx > frame_w * BET_INPUT_MAX_DX:
        return None, (f"the nearest input is {dx}px from the RAISE/BET button "
                      f"— not the bet field")
    return near, None


def _cdp_seq(ws_url: str, cmds: list[tuple[str, dict]]) -> None:
    import websocket
    conn = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    try:
        for i, (method, params) in enumerate(cmds, 1):
            conn.send(json.dumps({"id": i, "method": method, "params": params}))
            while True:
                m = json.loads(conn.recv())
                if m.get("id") == i:
                    break
    finally:
        conn.close()


def raise_to(amount: str, strict: bool = False) -> dict:
    """Custom raise: type an exact BB amount into the client's own bet field
    (triple-click selects the old value, insertText replaces it), then press
    its RAISE TO button (or BET, when the client offers a bet instead).
    Assistive relay of a user-entered amount — see act().

    `strict` (the pick-to-relay path): read the field back after typing and
    REFUSE to press if the client clamped the value to its min or max. A
    human who typed the amount can see the clamp; a relayed pick cannot, and
    pressing a size nobody asked for is worse than pressing nothing."""
    amount = amount.strip().replace(",", ".")
    if not re.fullmatch(r"\d{1,6}(\.\d{1,2})?", amount):
        return {"ok": False, "reason": f"bad amount {amount!r} — digits only, in BB"}
    t = ignition_target()
    if not t:
        return {"ok": False, "reason": "poker client not open"}
    ws = t["webSocketDebuggerUrl"]
    try:
        d = cdp._eval(ws, _find_input_js(TABLES.dom_slot()), timeout=6) or {}
    except Exception as e:
        return {"ok": False, "reason": f"input lookup failed: {e}"}
    inp, refusal = _pick_bet_input(d.get("inputs") or [], d.get("anchor"), d.get("frameW"))
    if refusal:
        # The Buy-chips panel is the one we have actually been bitten by, so name it
        # when it is up — "not the bet field" is true but unhelpful at 3am.
        if d.get("buyPanel"):
            refusal += " — the Buy-chips panel is open over the strip"
        return {"ok": False, "reason": refusal}
    # the field is reached by coordinate too, so it needs the same guard as a
    # press: typing a raise size into the table next door is no better than
    # clicking it (_point_is_my_table)
    if wrong := _point_is_my_table(ws, inp["x"], inp["y"]):
        return {"ok": False, "reason": wrong}
    base = {"x": inp["x"], "y": inp["y"], "button": "left"}
    # TYPING IS ITS OWN TURN AT THE WINDOWS, and the lock closes before the confirming
    # act() takes its own (see act()). Holding one lock across both would be a wrapper
    # waiting on itself: PressLock is not re-entrant, so raise_to would stall its full
    # timeout and then force the lock it already held.
    with TABLES.press_lock():
        if blind := _ensure_visible(ws):
            return {"ok": False, "reason": blind}
        _cdp_seq(ws, [
            ("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": inp["x"], "y": inp["y"]}),
            ("Input.dispatchMouseEvent", {**base, "type": "mousePressed", "clickCount": 1}),
            ("Input.dispatchMouseEvent", {**base, "type": "mouseReleased", "clickCount": 1}),
            ("Input.dispatchMouseEvent", {**base, "type": "mousePressed", "clickCount": 3}),
            ("Input.dispatchMouseEvent", {**base, "type": "mouseReleased", "clickCount": 3}),
            ("Input.insertText", {"text": amount}),
        ])
    time.sleep(0.25)
    if strict:
        try:
            d2 = cdp._eval(ws, _find_input_js(TABLES.dom_slot()), timeout=6) or {}
            # THE SAME PICKER, NOT inputs[0] (2026-09-20). Re-reading the first input
            # is what made this check useless in hand 513: the size had gone into the
            # Buy-chips panel's amount box, so the read-back found "2.5" sitting there
            # unclamped and waved the press through. A clamp check that validates a
            # field it did not write to only makes the wrong press look verified.
            back, why2 = _pick_bet_input(d2.get("inputs") or [], d2.get("anchor"), d2.get("frameW"))
            if back is None:
                return {"ok": False, "reason": f"could not read the bet field back — {why2}", "typed": amount}
            got = str(back.get("value", "")).replace(",", ".")
            gv = float(re.sub(r"[^\d.]", "", got) or "nan")
        except Exception as e:
            return {"ok": False, "reason": f"could not read the bet field back: {e}", "typed": amount}
        if not (abs(gv - float(amount)) <= 0.011):
            return {"ok": False, "reason": f"client changed {amount} to {got} (min/max clamp) — not pressed",
                    "typed": amount, "field": got}
    # the confirming button: RAISE TO when facing a wager, BET when opening
    res = act("raise", "action")
    if not res.get("ok"):
        alt = act("bet", "action")
        if alt.get("ok"):
            res = alt
    return {"ok": res.get("ok", False), "typed": amount, "confirm": res}


# ---- Study pick → the relay ---------------------------------------------------
# The study answer's rolled pick, executed through the SAME relay a panel
# press goes through. Two ways in:
#   press  — POST /act/pick: the user hit the pick button (or Enter/Space on
#            the panel). One deliberate press instead of reading the mix and
#            choosing among three or four buttons — the assistive form.
#   auto   — no press. Armed with POST /study-auto, and ONLY on a practice
#            table (the client's playMode=fun) or the fake table; the feed
#            loop executes a ready pick once per decision (_maybe_auto_act).
# Either way _pick_ready has to agree: answers on, a fresh pick, hero on the
# clock, and the pick's decision key still describing THIS spot — a Zone hand
# moves fast, and a stale pick must never land on the next hand.

_PICK_TTL_S = STUDY_ANSWER_TTL_MS / 1000
# The randomized auto mode waits this long, drawn fresh per decision, before it
# fires. Longer than _PICK_TTL_S on purpose: the poller re-pushes a cached answer
# every tick and each push refreshes _study["at"], so a pick for an UNCHANGED spot
# stays ready for the whole wait — and _execute_pick re-runs _pick_ready at fire
# time, so a spot that moved on drops the wait instead of landing a stale pick.
AUTO_DELAY_S = (1.5, 2.0)   # 2026-09-19 Brady: 3-9 s felt too long; 1.5-2 s is enough


def _pick_plan(pick: str | None, pot_bb: float | None = None) -> dict | None:
    """What relay call a pick label means, or None when it cannot be mapped.

    Three label dialects reach the panel: the HRC charts ("Fold", "Call",
    "Raise 2.5"), the GTO Wizard chain ("CHECK", "BET 3.35", "RAISE 12" —
    the size is the street total, i.e. a raise-TO), and MES ("Bet 4.5bb").
    A sized raise/bet becomes a typed amount + the confirming button; the
    rest press the client's own action button. A pot-fraction bet ("Bet 33%")
    is priced from the pot when one is given."""
    if not pick:
        return None
    s = pick.strip().lower()
    if s.startswith("fold"):
        return {"kind": "action", "label": "fold"}
    if s.startswith("check"):
        return {"kind": "action", "label": "check"}
    if s.startswith("call") or s.startswith("limp"):
        return {"kind": "action", "label": "call"}
    if re.match(r"^(all[ -]?in|jam|shove|rai\b)", s):
        return {"kind": "action", "label": "all-in"}
    if s.startswith("raise") or s.startswith("bet") or re.match(r"^r\d", s):
        verb = "bet" if s.startswith("bet") else "raise"
        m = re.search(r"(\d+(?:\.\d+)?)\s*(%|bb)?", s)
        if not m:
            return {"kind": "action", "label": verb}
        size = float(m.group(1))
        if m.group(2) == "%":
            if pot_bb is None or pot_bb <= 0:
                return None
            size = round(size / 100 * pot_bb, 2)
        if size <= 0:
            return None
        return {"kind": "raise-to", "amount": f"{size:.2f}".rstrip("0").rstrip("."), "verb": verb}
    return None


def _pick_ready() -> dict:
    """Can the current pick be executed right now? Every guard names its
    reason so the panel can say why not, not just that not."""
    out = {"ok": False, "reason": None, "pick": _study.get("pick"), "plan": None,
           "key": _study.get("decisionKey")}

    def no(reason: str) -> dict:
        out["reason"] = reason
        return out

    if not _study["on"]:
        return no("answers are off")
    if not _study.get("text") or not _study.get("pick"):
        return no("no pick yet")
    if (time.time() - _study["at"]) > _PICK_TTL_S:
        return no("pick is stale (poller not refreshing it)")
    key = _study.get("decisionKey")
    if not key or _study.get("handId") is None:
        return no("pick carries no decision key (poller predates this)")
    # one execution per decision: keyed by hand AND decision (the key alone
    # repeats when the next hand deals the same cards into the same spot)
    out["key"] = f"{_study.get('handId')}|{key}"
    if _study.get("executed") == out["key"]:
        return no("already executed for this decision")
    if _is_cp():
        # CoinPoker's turn signal is the server's own game.user_turn (the Unity
        # buttons cannot be read); cp_actions still OCR-checks the button it presses
        hh = _hand_state()
        if not (hh and (hh.get("currentNode") or {}).get("toActIsHero")):
            return no("not your turn (CoinPoker has not asked you to act)")
    elif not _live_status.get("toAct"):
        return no("not your turn (no turn buttons on the table)")
    if not _is_cp() and _live_status.get("modal"):
        # a client notice is over the strip: a relayed click would land on it
        # (session 100647 hand 5) — harmless ones are being dismissed
        return no(f"a client notice is on screen — {'dismissing it' if _live_status['modal'].get('harmless') else 'close it first'}")
    if not _is_cp() and _live_status.get("buyPanel"):
        # THE BUY-CHIPS PANEL COVERS THE STRIP FOR A MANUAL PRESS TOO (EVM-15, 2026-09-23): hand 4919313617 typed
        # the raise size into the buy-in box; the hold was added to auto-execute and raise_to only, so a manual
        # Fold/Call/Check press still went under the panel and act() reported a clean click.
        return no("Buy-chips panel is over the action strip")
    h = _hand_state()
    if not h:
        return no("no hand exported")
    if h.get("heroFolded") or h.get("ended"):
        return no("hand is over for you")
    if _study.get("handId") != h["handId"]:
        return no(f"pick was for hand #{_study.get('handId')}, table is on #{h['handId']}")
    try:
        k = json.loads(key)
        k_street, k_n = k[0], int(k[4])
    except Exception:
        return no("decision key unreadable")
    if k_street != h["street"] or k_n != len(h["actions"]):
        return no(f"pick was for {k_street} after {k_n} actions; table is {h['street']} after {len(h['actions'])}")
    # the index hero's action must land at — the postcondition _maybe_verify_exec checks
    out["kN"] = k_n
    plan = _pick_plan(_study["pick"], (h.get("currentNode") or {}).get("pot"))
    if not plan:
        return no(f"cannot map pick {_study['pick']!r} to a table action")
    out.update({"ok": True, "plan": plan})
    return out


_exec_lock = threading.Lock()

# ---- told vs did -------------------------------------------------------------
# A relayed press reports "ok" the moment the click dispatches. That is a claim about
# OUR side of the wire and nothing else: on 2026-09-19 hand 4919212912 the bet field
# was typed to 10.5, read back as 10.5, and the client had reset it to its 4 bb minimum
# by the time the RAISE button took the click — a 3-bet six and a half blinds smaller
# than the one the solver asked for, recorded as a success and invisible until the hand
# was graded offline hours later.
#
# So every press now carries a POSTCONDITION, checked against the table's own chips:
# hero's action must appear at the action index the decision key names, and must be the
# action that was asked for. Three outcomes, because two are not enough — "it did not
# happen" and "something else happened" need opposite responses:
#
#   confirmed  the action at hero's index is the one we sent
#   diverged   hero acted, but not as told — the chips are already in, so a retry would
#              only act twice; say it loudly and let the record carry it
#   unknown    nothing arrived before the deadline and we cannot prove why
#
# A retry runs ONLY on proof that nothing landed: hero still on the clock, the same hand,
# the same action count, no notice over the strip — _pick_ready's own guards. Poker
# actions are not idempotent and there is a clock running, so the budget is small and the
# fallback is to tell the human rather than keep pressing.
VERIFY_DEADLINE_S = 2.5     # per attempt: the chips show a press within a tick or two
VERIFY_ATTEMPTS = 2         # total presses for one decision, retries included
# A raise-to is confirmed on the level hero reaches; the client snaps sizes to its own
# grid, so allow a little — but far less than the gap a min-raise clamp opens.
RAISE_TOL = 0.12


def _actuate(plan: dict) -> dict:
    """The press itself, with no opinion about what it meant."""
    if _is_cp():
        # sites/coinpoker: real input on the Unity table, read back before and
        # confirmed from the log after; `auto` is refused off a practice table
        return CP.actuate(plan, auto=_study.get("execSource") == "auto")
    if plan["kind"] == "raise-to":
        return raise_to(plan["amount"], strict=True)
    if plan["label"] == "all-in":
        return _actuate_all_in()
    return act(plan["label"], "action")


def _actuate_all_in() -> dict:
    """A shove, by whichever control the client is offering it through.

    Ignition shows a dedicated ALL-IN action button only sometimes. Facing a raise it
    often shows FOLD / CALL x / RAISE TO y instead, with the shove living in the SIZING
    row (allInSelector) — set the size there, then confirm on RAISE. Session 125204 hand
    33 was exactly that: the pick was All-in, `act('all-in', 'action')` found nothing on
    the action row, the relay refused, and hero shoved by hand.

    The two rows stay strictly separate (see _split_strip): the sizing ALL-IN can never
    pose as the action button, so this is an ordered fallback, never a guess."""
    res = act("all-in", "action")
    if res.get("ok"):
        return res
    for label in ("all-in", "max"):
        preset = act(label, "preset")
        if not preset.get("ok"):
            continue
        time.sleep(0.25)
        confirm = act("raise", "action")
        if not confirm.get("ok"):
            confirm = act("bet", "action")
        if confirm.get("ok"):
            return {"ok": True, "clicked": f"{preset.get('clicked')} + {confirm.get('clicked')}",
                    "kind": "preset+confirm"}
        return {"ok": False, "reason": f"sized the shove on {preset.get('clicked')} but "
                                       f"no RAISE/BET to confirm it — {confirm.get('reason')}"}
    return res


def _did_as_told(plan: dict, a: dict, hero_stack: float | None) -> bool | None:
    """Is hero's recorded action the one `plan` asked for? None = cannot tell."""
    t = (a.get("type") or "").lower()
    amt = a.get("amount")
    if plan["kind"] == "raise-to":
        if t not in ("raise", "bet", "all-in"):
            return False
        if amt is None:
            return None
        want = float(plan["amount"])
        return abs(amt - want) <= max(RAISE_TOL * want, 0.05)
    label = plan.get("label")
    if label == "fold":
        return t == "fold"
    if label == "check":
        return t == "check"
    if label == "call":
        return t in ("call", "all-in")
    if label in ("raise", "bet"):
        # an UNSIZED pick presses the button at the field's default; the verb is the only thing to judge (EVM-12:
        # this returned None and filed every landed one as UNCONFIRMED)
        return t in (label, "all-in")
    if label == "all-in":
        if t == "all-in":
            return True
        if t in ("raise", "bet") and amt is not None and hero_stack:
            return amt >= 0.9 * hero_stack      # the client may name a jam by its size
        return None if t in ("raise", "bet") else False
    return None


def _spot_unchanged(p: dict, h: dict) -> tuple[bool, str | None]:
    """Is the table still showing the EXACT decision this press was sent for?

    This is the whole safety case for a retry, so it asks about the table and nothing
    else. Deliberately NOT _pick_ready: that answers "should we send a pick", which also
    depends on answers being on and the poller still refreshing the pick — neither of
    which has any bearing on whether a press that never registered may be sent again. A
    retry gated on the answer pipeline gives up on a live decision because a solve went
    stale, which is the opposite of the point."""
    if not _live_status.get("toAct"):
        return False, "hero is no longer on the clock"
    if _live_status.get("modal"):
        return False, "a client notice is over the action strip"
    if h.get("handId") != p["handId"]:
        return False, "the table moved to the next hand"
    if h.get("heroFolded") or h.get("ended"):
        return False, "the hand is over for hero"
    if len(h.get("actions") or []) != p["kN"]:
        return False, "another action landed first — the spot moved on"
    try:
        # the key is "<handId>|<decisionKey>"; the decision key opens with its street
        if json.loads(p["key"].split("|", 1)[1])[0] != h.get("street"):
            return False, "the street moved on"
    except Exception:
        pass
    return True, None


def _verify_done(outcome: str, why: str | None, observed: dict | None = None) -> None:
    """Close out a pending press: the panel record, the feed, the session event. A
    confirmed press says nothing new — the send line already said it. Everything else is
    the thing we were blind to, so it is loud."""
    p = _study.get("pendingExec") or {}
    _study["pendingExec"] = None
    rec = _study.get("lastExec")
    if isinstance(rec, dict) and rec.get("key") == p.get("key"):
        rec.update({"outcome": outcome, "outcomeWhy": why, "observed": observed,
                    "attempts": p.get("attempts")})
    if outcome == "diverged":
        _feed_add(f"Study pick MIS-EXECUTED — told {p.get('pick')}, the table took {why}")
    elif outcome == "unknown":
        _feed_add(f"Study pick UNCONFIRMED — {p.get('pick')} was sent, the table never showed it ({why})")
    elif outcome == "abandoned":
        _feed_add(f"Study pick unverified — {p.get('pick')}: {why}")
    if _session["id"]:
        _sessions.event(_session["id"], "pick-outcome",
                        {"outcome": outcome, "why": why, "pick": p.get("pick"), "plan": p.get("plan"),
                         "hand": p.get("handId"), "attempts": p.get("attempts"), "observed": observed})
    if outcome != "confirmed":
        print(f"[pick] outcome {outcome}: {why}")


def _maybe_verify_exec() -> None:
    """From the feed loop: resolve the pending press against the table.

    This lives on the tick loop on purpose. The thing that observes the table IS the tick
    loop, so waiting for an outcome anywhere else would mean either blocking the reader
    for seconds at the exact moment it matters, or racing it from a thread."""
    p = _study.get("pendingExec")
    if not p:
        return
    h = _hand_state()
    if not h:
        if time.time() > p["deadline"]:
            _verify_done("unknown", "no hand state to check against")
        return
    if h.get("handId") != p["handId"]:
        _verify_done("unknown", "the table moved to the next hand before the press showed")
        return
    acts = h.get("actions") or []
    k = p["kN"]
    mine = acts[k] if len(acts) > k and acts[k].get("hero") else None
    if mine is None and len(acts) > k:
        # the capture ordered things differently — take hero's first action from k on
        mine = next((a for a in acts[k:] if a.get("hero")), None)
    if mine is not None:
        # LET THE AMOUNT SETTLE BEFORE JUDGING IT (2026-09-19, hand 4919236052). The client
        # renders the chips ADDED in the bet slot for a tick before the new total: hero
        # raising to 9.2 from 2.5 shows "6.7" first. Read at 800 ms, that is a press this
        # check calls MIS-EXECUTED when it was exactly right — and a false accusation about
        # the one thing this check exists to be trusted on. A size is judged only once the
        # same number has been seen twice, or the deadline runs out and we judge what we
        # have. Only sized plans wait: fold/check/call compare a verb, and verbs do not
        # wobble. Costs one tick on a confirmed raise, which writes no feed line anyway.
        did_now = (mine.get("type"), mine.get("amount"))
        if p["plan"]["kind"] == "raise-to" and time.time() <= p["deadline"] and p.get("seen") != did_now:
            p["seen"] = did_now
            return
        # THE STACK AT SEND TIME, NOT NOW (EVM-08, 2026-09-23): the label shows chips BEHIND after the action, so a
        # landed shove reads 0 behind — falsy — and the verdict was "unknown" for a correct press; a part-stack
        # raise that left a little behind passed as an all-in. _execute_pick snapshots stack + committed.
        stack = p.get("stackAtSend")
        if stack is None:
            stack = (h.get("stacks") or {}).get(h.get("heroSeatId"))
        verdict = _did_as_told(p["plan"], mine, stack)
        did = mine.get("type") + (f" {mine['amount']}" if mine.get("amount") is not None else "")
        if verdict is True:
            _verify_done("confirmed", None, {"did": did})
        elif verdict is False:
            _verify_done("diverged", did, {"did": did})
        else:
            _verify_done("unknown", f"hero acted ({did}) but it cannot be matched to the pick", {"did": did})
        return
    if time.time() <= p["deadline"]:
        return
    # NOTHING LANDED. Retry only on proof of that, never on a timeout alone.
    if p["attempts"] < VERIFY_ATTEMPTS:
        same, why_not = _spot_unchanged(p, h)
        if same:
            p["attempts"] += 1
            p["deadline"] = time.time() + VERIFY_DEADLINE_S
            res = _actuate(p["plan"])
            _feed_add(f"Study pick {p['pick']} did not register — retried ({p['attempts']}/{VERIFY_ATTEMPTS})"
                      + ("" if res.get("ok") else f", refused: {res.get('reason')}"))
            if _session["id"]:
                _sessions.event(_session["id"], "pick-retried",
                                {"pick": p["pick"], "plan": p["plan"], "hand": p["handId"],
                                 "attempt": p["attempts"], "ok": bool(res.get("ok")),
                                 "reason": res.get("reason")})
            if not res.get("ok"):
                _verify_done("unknown", f"retry refused — {res.get('reason')}")
            return
        _verify_done("abandoned", why_not or "the spot is no longer hero's to act on")
        return
    _verify_done("unknown", f"no action from hero after {VERIFY_ATTEMPTS} presses")


def _execute_pick(source: str, waited_s: float | None = None) -> dict:
    """Run the current pick through the relay, if _pick_ready agrees. One
    execution per decision; the outcome is kept for the panel and written to
    the feed and the session record either way. `waited_s` is the randomized
    wait an auto execution sat through, recorded with it.

    Returns when the press has been SENT. What the table did with it is settled a tick or
    two later by _maybe_verify_exec — see the note above it."""
    with _exec_lock:
        r = _pick_ready()
        if not r["ok"]:
            return {"ok": False, "reason": r["reason"], "source": source}
        plan, key, pick = r["plan"], r["key"], r["pick"]
        k_n = r.get("kN")
        _study["execSource"] = source      # a CoinPoker press needs to know auto from a person
        res = _actuate(plan)
        ok = bool(res.get("ok"))
        rec = {"at": int(time.time() * 1000), "source": source, "pick": pick, "plan": plan,
               "ok": ok, "result": res, "hand": _hand_no, "waitedS": waited_s, "key": key,
               "outcome": "pending" if ok else "refused"}
        _study["lastExec"] = rec
        if ok:
            _study["executed"] = key
            waited = f", after {waited_s:.1f} s" if waited_s is not None else ""
            _feed_add(f"Study pick executed — {pick} ({source}{waited})")
            if k_n is not None:
                h0 = _hand_state() or {}
                hero0 = h0.get("heroSeatId")
                behind0 = (h0.get("stacks") or {}).get(hero0)
                committed0 = (h0.get("committed") or {}).get(hero0) or 0
                _study["pendingExec"] = {"key": key, "pick": pick, "plan": plan, "kN": k_n,
                                         "handId": _study.get("handId"), "sentAt": time.time(),
                                         "deadline": time.time() + VERIFY_DEADLINE_S, "attempts": 1,
                                         # hero's whole stack at the moment of the press (behind + this street's
                                         # commitment): what an all-in verdict is judged against (EVM-08)
                                         "stackAtSend": (behind0 + committed0) if behind0 is not None else None}
        else:
            _feed_add(f"Study pick NOT executed — {pick}: {res.get('reason', 'refused')}")
        if _session["id"]:
            _sessions.event(_session["id"], "pick-executed" if ok else "pick-refused",
                            {"source": source, "pick": pick, "plan": plan, "hand": _hand_no,
                             "waitedS": waited_s, "reason": None if ok else res.get("reason")})
        print(f"[pick] {source}: {pick!r} -> {res}")
        return {"ok": ok, **rec}


def _auto_allowance() -> dict:
    """State of the real-money testing allowance: whether it is live, and what
    is left of its budgets. `hands` counts hands SINCE it was granted."""
    until, cap, frm = _study["autoRealUntil"], _study["autoRealHands"], _study["autoRealFrom"]
    if not until:
        return {"granted": False, "live": False, "minutesLeft": None, "handsLeft": None}
    mins_left = max(0.0, round((until - time.time()) / 60, 1))
    hands_used = max(0, _hand_no - (frm if frm is not None else _hand_no))
    hands_left = max(0, cap - hands_used) if cap else None
    live = mins_left > 0 and (hands_left is None or hands_left > 0)
    return {"granted": True, "live": live, "minutesLeft": mins_left, "handsLeft": hands_left,
            "handsUsed": hands_used, "reason": _study["autoRealReason"]}


def _auto_table_ok() -> tuple[bool, str | None]:
    """May auto-execute run against the table in front of us right now?
    Practice and the fake table always; a real-money table only while the
    explicit testing allowance is live. CoinPoker: practice tables ONLY — there
    is no real-money allowance there."""
    if _is_cp():
        return ((True, None) if CP.practice() else
                (False, "CoinPoker auto-execute arms only on a practice table (the server's coinType 2)"))
    if _fake_mode or _live_status.get("practice"):
        return True, None
    a = _auto_allowance()
    if a["live"]:
        return True, None
    if a["granted"]:
        return False, ("real-money testing allowance has expired "
                       f"({'time' if a['minutesLeft'] == 0 else 'hand budget'} used up) — auto disarmed")
    return False, "auto-execute arms only on a practice table, or with an explicit real-money testing allowance"


def _maybe_auto_arm() -> None:
    """A session that DECLARED auto-execute but could not arm at Start (no
    table yet, or a real-money table with no allowance declared) arms itself
    the moment a table it is allowed on appears. Without this, declaring it at
    setup would silently do nothing on the common path, since Start runs before
    the router has seated anybody."""
    if not (_study["on"] and _study.get("autoDeclared") and not _study["auto"]):
        return
    # an allowance that was granted and then ran out is NOT re-armed: the
    # budget was the point
    if _study["autoRealUntil"] and not _auto_allowance()["live"]:
        return
    ok, _ = _auto_table_ok()
    if not (ok or _study.get("autoDeclaredReal")):
        return
    b = _study.get("autoDeclaredBudget") or {}
    res = _set_auto(True, allow_real=bool(_study.get("autoDeclaredReal")),
                    minutes=b.get("minutes") or 30, hands=b.get("hands") or 50,
                    reason="declared at session setup")
    if res.get("ok"):
        _feed_add("Auto-execute armed (declared at session setup)")


PICK_NOT_FIRED_S = 1.5


def _note_pick_not_fired(r: dict) -> None:
    """AN ANSWER ON THE PANEL THAT AUTO NEVER FIRED LEAVES A RECORD (EIP-06, 2026-09-23). Hand 4919661065: AA in
    the BB, real money, auto armed, 'Raise 9.5 65%' pushed and refreshed for 7 s, _pick_ready said 'not your turn
    (no turn buttons on the table)' every tick while the client's own request said it WAS hero's turn — and the
    client folded AA for hero at the clock. Nothing was written: no event, no feed line. Now, once per decision,
    when a FRESH pick has been refused for PICK_NOT_FIRED_S with the same reason, one `pick-not-fired` event."""
    if not (_study.get("text") and _study.get("pick")) or (time.time() - _study.get("at", 0)) > _PICK_TTL_S:
        _study["autoNotFired"] = None
        return
    key = f"{_study.get('handId')}|{_study.get('decisionKey')}"
    cur = _study.get("autoNotFired")
    if not cur or cur.get("key") != key or cur.get("reason") != r.get("reason"):
        _study["autoNotFired"] = {"key": key, "reason": r.get("reason"), "since": time.time(), "said": False}
        return
    if cur.get("said") or time.time() - cur["since"] < PICK_NOT_FIRED_S:
        return
    cur["said"] = True
    _feed_add(f"Auto-execute has an answer ({_study.get('pick')}) it cannot fire — {r.get('reason')}")
    print(f"[pick] auto not fired for {round(time.time() - cur['since'], 1)}s: {r.get('reason')}")
    if _session["id"]:
        _sessions.event(_session["id"], "pick-not-fired",
                        {"hand": _hand_no, "clientHandId": _hand_ids.get(_hand_no), "pick": _study.get("pick"),
                         "reason": r.get("reason"), "heldS": round(time.time() - cur["since"], 1),
                         "toActSources": _to_act_sources(bool(_live_status.get("toAct")))})


def _maybe_auto_act() -> None:
    """The auto mode, from the feed loop: only when the table is allowed (see
    _auto_table_ok) and everything _pick_ready checks holds. A refused attempt
    is not retried for the same decision (the reason stays on the panel)."""
    if not (_study["on"] and _study["auto"]):
        return
    ok, why = _auto_table_ok()
    if not ok:
        # an allowance that ran out disarms itself rather than sitting there
        # looking armed on a real-money table
        if _study["autoRealUntil"] and _study["auto"]:
            _study["auto"] = False
            _study["lastExec"] = {"at": int(time.time() * 1000), "source": "auto", "pick": None,
                                  "plan": None, "ok": False, "result": {"reason": why}, "hand": _hand_no}
            _feed_add(f"Auto-execute disarmed — {why}")
            if _session["id"]:
                _sessions.event(_session["id"], "study-auto-expired", {"reason": why, "hand": _hand_no})
            print(f"[pick] auto disarmed: {why}")
        return
    r = _pick_ready()
    if not r["ok"]:
        # a wait drawn for a pick that is no longer ready is dropped, never
        # carried over: the spot moved on, and the next decision draws its own
        if _study.get("autoDue"):
            _study["autoDue"] = None
        _note_pick_not_fired(r)
        return
    _study["autoNotFired"] = None
    if r["key"] == _study.get("autoTried"):
        return
    # THE STRIP IS COVERED (2026-09-20). Holding for the same reason the reconciler
    # holds: a press whose target may not be what we think it is. Hand 513 relayed
    # "Raise 2.5" with the Buy-chips panel over the strip, the size went into the
    # buy-in box, and the client took the RAISE button's default of 2 BB. This is
    # belt to raise_to's braces — that refuses the press, this stops the clock being
    # burned on one — and it lifts itself the tick _maybe_guard_buy_panel() closes
    # the panel.
    hold_why = _study.get("uncertain")
    if not hold_why and _live_status.get("buyPanel"):
        hold_why = "Buy-chips panel is over the action strip"
    # A PRE-ACTION TOP-UP IS BUYING (TU-06, 2026-09-23). The hold above keys on the DOM's view of the panel,
    # which is a tick old: with autoDelay "instant" the press fired on the same tick the run started, and with
    # "random" it raced the ~1 s panel render (the one live case engaged at 1.48 s). The run's own flag is the
    # fact; its fuse (_maybe_guard_buy_panel) and its finally clear it, so this can never hold past the budget.
    if not hold_why and _topup_prefold["active"] and time.time() < _topup_prefold["deadline"]:
        hold_why = f"pre-action top-up in progress ({_topup_prefold.get('kind') or 'terminal'})"
    if hold_why:
        # the exported line failed the reconciler's invariants: the pick may be
        # for a spot that is not the table's — the human reads the caveat and
        # decides; auto never does (cut-over rule, 2026-09-19)
        #
        # A HOLD IS NOT A VERDICT (2026-09-19). This used to set `autoTried`, which
        # retires the decision: the fault could clear on the very next tick and the
        # relay would still sit out the rest of the spot. Faults are live things now
        # (reconcile.faults()), so the hold is re-tested every tick and lifts itself.
        # The feed says it once per (decision, reason), not forty times.
        held = _study.get("autoHeld") or {}
        if held.get("key") != r["key"] or held.get("why") != hold_why:
            _study["autoHeld"] = {"key": r["key"], "why": hold_why, "at": time.time()}
            _feed_add(f"Auto-execute held — {hold_why}")
            if _session["id"]:
                _sessions.event(_session["id"], "study-auto-held", {"why": hold_why, "hand": _hand_no,
                                                                    "pick": r["pick"]})
        _study["autoDue"] = None
        return
    if (_study.get("autoHeld") or {}).get("key") == r["key"]:
        # the same decision, the fault gone: say so, then let the normal path run
        was = _study["autoHeld"]
        _study["autoHeld"] = None
        _feed_add(f"Auto-execute resumed — {was['why'].replace('line uncertain — ', '')} cleared "
                  f"after {time.time() - was['at']:.1f} s")
        if _session["id"]:
            _sessions.event(_session["id"], "study-auto-resumed",
                            {"why": was["why"], "heldS": round(time.time() - was["at"], 1),
                             "hand": _hand_no, "pick": r["pick"]})
    if _study.get("autoDelay") == "random":
        due = _study.get("autoDue")
        if not due or due["key"] != r["key"]:
            wait = random.uniform(*AUTO_DELAY_S)
            _study["autoDue"] = {"key": r["key"], "at": time.time() + wait, "wait": wait}
            _feed_add(f"Auto-execute: {r['pick']} in {wait:.1f} s (randomized)")
            return
        if time.time() < due["at"]:
            return
        _study["autoDue"] = None
        _study["autoTried"] = r["key"]
        _execute_pick("auto", waited_s=due["wait"])
        return
    _study["autoTried"] = r["key"]
    _execute_pick("auto")


TIME_BANK_COOLDOWN_S = 5.0


def _maybe_take_time() -> dict | None:
    """Press the client's +45s time bank whenever it is offered, from the feed
    loop. Independent of the auto mode: it never chooses an action, it only buys
    the clock — so it runs whenever answers are on and the session allows it.
    The cooldown lets a bank that reappears (the extra time also ran low) be
    taken again, without hammering the same button every 250 ms tick.

    Returns the press record ({ok, label, …}) or None when nothing was pressed —
    the pre-action top-up sizes its budget on THAT, not on the button having
    been visible (TU-07, 2026-09-23)."""
    if not (_study["on"] and _study.get("timeBank")):
        return None
    b = _live_status.get("timeBank")
    if not b or (time.time() - _study.get("timeBankAt", 0.0)) < TIME_BANK_COOLDOWN_S:
        return None
    if _live_status.get("modal"):
        return None      # the button is under a notice: the click would land on the notice (EVM-19)
    _study["timeBankAt"] = time.time()
    label = (b.get("text") or "+45s").strip()
    res = act(label, "button")
    ok = bool(res.get("ok"))
    _study["lastTimeBank"] = {"at": int(time.time() * 1000), "label": label, "ok": ok,
                              "hand": _hand_no, "reason": None if ok else res.get("reason")}
    _feed_add(f"Time bank {label} taken" if ok else f"Time bank {label} NOT taken — {res.get('reason', 'refused')}")
    if _session["id"]:
        _sessions.event(_session["id"], "time-bank", {"label": label, "ok": ok, "hand": _hand_no,
                                                       "reason": None if ok else res.get("reason")})
    print(f"[time-bank] {label}: {res}")
    return _study["lastTimeBank"]


# SHADOW RECONCILER (2026-09-18, Brady's go): reconcile.py rebuilds each hand's line
# from the table's LEVELS (chips in front, cards, pot, board, hero's buttons) beside the
# live logger, and when the hand is archived the two lines are diffed. Shadow means
# exactly that: it writes only to shadow.jsonl (the recording folder when recording,
# else data/) and to /state; it never touches the feed, the answers or the archive.
# It is fed the same per-tick dict the debug recorder writes, so
# tests/replay_reconcile.py replays exactly what the live hook saw.
_shadow = {"hand": None, "rc": None, "seq": 0, "done": {}, "agree": 0, "differ": 0, "last": None}
_HERE = os.path.dirname(os.path.abspath(__file__))


def _shadow_tick(state: dict) -> None:
    try:
        hand = state.get("hand")
        if hand != _shadow["hand"]:
            rc = _shadow["rc"]
            if rc is not None:
                rc.finish(rc.prev.seq if rc.prev else _shadow["seq"])
                _shadow["done"][_shadow["hand"]] = rc
                for k in [k for k in _shadow["done"] if hand is not None and k < hand - 5]:
                    _shadow["done"].pop(k, None)
            _shadow["hand"], _shadow["rc"] = hand, RC.HandReconciler(hand or 0)
        _shadow["seq"] += 1
        hero = _ws_state.get("heroSeat")
        seats = {}
        for num, sd in (state.get("seats") or {}).items():
            n = int(num)
            seats[n] = {"stack": sd.get("stack"), "bet": sd.get("bet"), "cards": sd.get("cards") or 0,
                        "hero": (n == hero) or bool(sd.get("hero")), "badge": sd.get("badge")}
        _shadow["rc"].observe(RC.Tick(seq=_shadow["seq"], t=time.strftime("%H:%M:%S"), seats=seats,
                                      pot=RC.bb(state.get("pot")), board=len(state.get("board") or []),
                                      buttons=list(state.get("actions") or []), hero=hero))
    except Exception as e:
        print(f"[shadow] tick error: {e}")


def _shadow_archive(h: dict) -> None:
    """At archive time: the reconciler's line for this hand against the archived one."""
    try:
        hid = h.get("handId")
        rc = _shadow["done"].get(hid) or (_shadow["rc"] if _shadow["hand"] == hid else None)
        if rc is None:
            return
        if not rc.ended:
            rc.finish(rc.prev.seq if rc.prev else _shadow["seq"])
        d = rc.diff(h.get("actions") or [])
        rec = {"at": int(time.time() * 1000), "session": _session["id"], "hand": hid, "clientHandId": h.get("clientHandId"),
               "agree": d["agree"], "archive_only": d["archive_only"], "reconciled_only": d["reconciled_only"], "changed": d["changed"],
               "violations": rc.violations, "retractions": [a for a in rc.journal if a["retracted"]],
               "line": d["reconciled"], "archive": d["archive"]}
        _shadow["agree" if d["agree"] else "differ"] += 1
        _shadow["last"] = {"hand": hid, "clientHandId": h.get("clientHandId"), "agree": d["agree"],
                           "diffs": len(d["archive_only"]) + len(d["reconciled_only"]) + len(d["changed"]),
                           "violations": len(rc.violations)}
        path = os.path.join(_dbg["dir"], "shadow.jsonl") if _dbg["on"] and _dbg["dir"] else os.path.join(_HERE, "data", "shadow.jsonl")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[shadow] hand {hid}: {'agree' if d['agree'] else 'DIFF'} · {len(rc.violations)} violation(s) · "
              f"{len(d['archive_only'])} archive-only · {len(d['reconciled_only'])} derived-only · {len(d['changed'])} changed")
    except Exception as e:
        print(f"[shadow] archive error: {e}")


TOP_UP_COOLDOWN_S = 20.0
# ticks hero's stack must hold still before the award is taken as landed
TOP_UP_SETTLE_TICKS = 2
# Below this much short of the table max, leave the stack alone. A stack 0.05 bb
# light is not worth a press: it spends a window, writes a feed line, and makes the
# top-ups a metronome — one at the end of nearly every hand. One big blind is the
# smallest shortfall that changes a decision anywhere.
TOP_UP_MIN_SHORT_BB = 1.0
# A small wait before the first press of a run, drawn once per window. Without it
# every press lands one 250 ms tick after the fold, forever.
TOP_UP_JITTER_S = (0.4, 2.0)
_topup_lock = threading.Lock()
# Set while the Buy-chips panel is open BECAUSE OF US. The panel is modal over the
# action strip, so the relay folds it away before pressing an action and the feed
# loop closes it the moment hero is put on the clock. `_topup_abort` is how those
# two tell the run thread its window is gone.
_topup_panel = {"open": False, "lastCloseAt": 0.0, "domTicks": 0}
_topup_abort = threading.Event()
# how long a guard close is not repeated (the panel needs a tick or two to leave the DOM) — TU-13
TOP_UP_CLOSE_DEBOUNCE_S = 1.5
# Hands hero STARTED below the table max — the only top-up number that matters.
_topup_kpi = {"hand": None, "hands": 0, "short": 0, "worstBb": 0.0}

# ---- TOP UP BEFORE THE FOLD, NOT AFTER IT -----------------------------------
#
# THE PROBLEM, from the record. Every window the top-up had was AFTER hero's
# action, so it raced the next deal — and lost. Of the 14 hands that started
# short across the four sessions where this was measured at all (2026-09-20),
# FOUR were pressed correctly in the `fold` window and still arrived short
# because the chips had not been credited by the deal, and three more were
# refused outright with "a hand is live for hero" / "hero is on the clock".
# Session 193322 is the shape of it: pressed at 19:48:23, the next hand dealt at
# 19:48:24. One second. No window rule can fix a one-second window.
#
# THE FIX (Brady, 2026-09-20): when the answer is FOLD, WE choose when the fold
# happens. So buy the chips first and fold afterwards. The deadline stops being
# "before the client deals again" — which we do not control — and becomes "before
# hero's act clock runs out", which we do, and which we can extend with the
# client's own time bank.
#
# WHY ONLY FOLD. The amount is read off hero's stack BEHIND, which already
# excludes what he has committed this hand. Folding forfeits that commitment, so
# stack-behind IS his final stack and the shortfall is exactly the same number it
# would be a moment later in the `fold` window — the arithmetic does not change,
# only the timing. Every other action fails that test: check and call leave the
# hand live and hero can still WIN the pot, which would put him OVER the max (the
# client then refuses the buy with a modal over the strip — session 100647 hands
# 4/5, where it swallowed the next turn for 12 s).
#
# WHY ONLY WITH AUTO ARMED. The whole premise is that we hold the clock. If the
# human is pressing, the panel would be sitting over the action strip he is
# reaching for.
TOP_UP_PREFOLD = (os.environ.get("TOP_UP_PREFOLD", "1") != "0")
# Measured 2026-09-20 over 272 hero-turn episodes in the recordings: the client's
# "+45s" button first appears a median 17 ticks (~4.6 s) into the turn, and it is
# offered at ~9 s remaining — so the base act clock is around 14 s. Six seconds
# is comfortably inside that with the deal-out never in question; taking the time
# bank first buys 45 s more and earns the longer budget.
TOP_UP_PREFOLD_BUDGET_S = float(os.environ.get("TOP_UP_PREFOLD_BUDGET_S") or "6.0")
TOP_UP_PREFOLD_BANKED_S = float(os.environ.get("TOP_UP_PREFOLD_BANKED_S") or "20.0")
# `active` is what lets the Buy-chips panel stand over the action strip at all —
# every other path closes it on sight (_maybe_guard_buy_panel). It is therefore
# ALWAYS cleared, in a finally, whatever happens.
_topup_prefold: dict = {"active": False, "key": None, "hand": None,
                        "deadline": 0.0, "startedAt": 0.0, "banked": False}

# The table's own numbers for a top-up: hero's stack and the ring table's max buy-in
# (both from the client, never typed), plus the Buy-chips panel when it is open —
# its "Max. $X" is the amount the client itself will accept.
_TOPUP_READ_JS_TMPL = r"""(() => {__FRAME__
  const f = __frame(__SLOT__);
  if (!f) return { seated: false, reason: 'no table frame' };
  let doc = null; try { doc = f.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return { seated: false, reason: 'table frame not readable' };
  const src = f.getAttribute('src') || '';
  const q = Object.fromEntries((src.split('?')[1] || '').split('&').map(kv => kv.split('=').map(x => { try { return decodeURIComponent(x); } catch (e) { return x; } })));
  // quickSeatBigBlind is in CENTS (200 = $1/$2 — formats.py reads it the same way). Until 2026-09-19 this
  // treated it as dollars: a "92.5 BB" stack came back 100x too big, so every top-up run exited "at the max
  // already" without a word (session 220727), and the in-play balance logged $20,300 on a $2 table.
  let bbCents = parseInt(q.quickSeatBigBlind || '', 10);
  if (!(bbCents > 0)) {
    // Zone / non-quick-seat tables: the blinds live only in the table title, "$1/$2 No Limit Hold'em - …"
    const leaf = (root) => [...root.querySelectorAll('*')].filter(e => e.children.length === 0).map(e => (e.textContent || '').trim());
    const tt = [...leaf(doc), ...leaf(document)].find(s => /\$[\d.,]+\s*\/\s*\$[\d.,]+/.test(s)) || '';
    const tm = tt.match(/\$([\d.,]+)\s*\/\s*\$([\d.,]+)/);
    if (tm) bbCents = Math.round(parseFloat(tm[2].replace(/,/g, '')) * 100);
  }
  // the ring max from the src (cents); a quick-seat table without it is taken as 100bb — Ignition's ring max
  // everywhere we play — and flagged so the record says the number was assumed, not read
  let maxCents = parseInt(q.quickSeatMaxBuyIn || '', 10);
  let maxAssumed = false;
  const zone = /zone/i.test(q.gameFormat || '') || /zone/i.test(q.gameTableUrl || '');
  if (!(maxCents > 0) && bbCents > 0 && !zone) { maxCents = 100 * bbCents; maxAssumed = true; }
  const me = doc.querySelector("[data-qa='myPlayerTag']");
  const seat = me ? me.closest("[data-qa^='playerContainer-']") : null;
  const bal = seat ? seat.querySelector("[data-qa='playerBalance']") : null;
  if (!bal) return { seated: false, reason: 'no hero seat on the table' };
  const t = (bal.textContent || '').trim();
  const m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(BB)?$/i);
  let stackCents = null;
  if (m) { const n = parseFloat(m[1].replace(/,/g, '')); stackCents = m[2] ? (bbCents > 0 ? Math.round(n * bbCents) : null) : Math.round(n * 100); }
  // THE BUY-CHIPS PANEL = a visible text/number field whose surroundings say "Max. $N" / "Playable balance"
  // (2026-09-19: the client renders "Max. $5" as ONE leaf, so the old "a leaf that is exactly 'Max.'" test never
  // matched — an open panel read as closed, three times in session 010011, and the press toggled it shut again)
  let panel = null, offerCents = null, input = null;
  for (const inp of doc.querySelectorAll('input')) {
    if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'hidden') continue;
    const b = inp.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0)) continue;
    let c = inp.parentElement;
    for (let i = 0; i < 6 && c && c !== doc.body; i++) {
      const tx = c.textContent || '';
      if (/Max\.?\s*\$?\s*[\d,]+(?:\.\d+)?/i.test(tx) || /Playable balance/i.test(tx)) { panel = c; break; }
      c = c.parentElement;
    }
    if (panel) {
      const mm = (panel.textContent || '').match(/Max\.?\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
      if (mm) offerCents = Math.round(parseFloat(mm[1].replace(/,/g, '')) * 100);
      input = inp;
      break;
    }
  }
  return { seated: true, stackCents, stackText: t, bbCents: bbCents > 0 ? bbCents : null, zone,
           maxCents: maxCents > 0 ? maxCents : null, maxAssumed, panelOpen: !!panel, offerCents,
           inputFound: !!input, inputValue: input ? input.value : null };
})()"""


def _topup_read_js(slot: int | None = None) -> str:
    return _slotted(_TOPUP_READ_JS_TMPL, slot)



# Put an amount in the panel's field the way a keypress would (React needs the
# native setter + an input event, not a bare .value assignment).
_TOPUP_FILL_JS_TMPL = r"""((cents) => {__FRAME__
  const f = __frame(__SLOT__);
  let doc = null; try { doc = f && f.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return { ok: false, reason: 'no table frame' };
  let input = null;
  for (const inp of doc.querySelectorAll('input')) {
    if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'hidden') continue;
    const b = inp.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0)) continue;
    let c = inp.parentElement, hit = false;
    for (let i = 0; i < 6 && c && c !== doc.body; i++) { if (/Max\.?\s*\$|Playable balance/i.test(c.textContent || '')) { hit = true; break; } c = c.parentElement; }
    if (hit) { input = inp; break; }
  }
  if (!input) return { ok: false, reason: 'no amount field in the Buy-chips panel' };
  const v = (cents / 100).toFixed(2);
  const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
  input.focus();
  if (d && d.set) d.set.call(input, v); else input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: input.value };
})"""


def _topup_fill_js(slot: int | None = None) -> str:
    return _slotted(_TOPUP_FILL_JS_TMPL, slot)




def _top_up_toast() -> str | None:
    """The client's 'successfully added $N in chips' toast, if it is on screen."""
    t = ignition_target()
    if not t:
        return None
    try:
        d = cdp._eval(t["webSocketDebuggerUrl"], _table_js(TABLES.dom_slot()), timeout=6) or {}
    except Exception:
        return None
    for n in d.get("nodes", []):
        if m := re.search(r"successfully added \$?([\d,]+(?:\.\d+)?) in chips", n.get("text") or "", re.I):
            return m.group(1)
    return None


def _top_up_read() -> dict:
    t = ignition_target()
    if not t:
        return {"seated": False, "reason": "poker client not open"}
    try:
        return cdp._eval(t["webSocketDebuggerUrl"], _topup_read_js(TABLES.dom_slot()), timeout=6) or {"seated": False, "reason": "empty read"}
    except Exception as e:
        return {"seated": False, "reason": f"table read failed: {e}"}


def _hand_key() -> str:
    """The key the once-per-hand guards hang on: the CLIENT's hand id where there
    is one. `_hand_no` is the reader's OWN counter and it bumps on a table re-open
    or a Zone table change, which would silently hand a spent hand a second attempt
    - and, the other way round, hold a fresh hand's attempt against the last one."""
    return _hand_ids.get(_hand_no) or f"local-{_hand_no}"


def _top_up_settle_tick() -> None:
    """Has hero's stack stopped moving? Counted EVERY feed tick, not only when a
    top-up is being considered: a counter that advances only while someone is
    looking never reaches two."""
    hero = _ws_state.get("heroSeat")
    stack = ((_feed_prev.get("seats") or {}).get(hero) or {}).get("stack")
    st = _study.setdefault("stackStable", {"text": None, "ticks": 0})
    if stack == st.get("text"):
        st["ticks"] = st.get("ticks", 0) + 1
    else:
        st.update({"text": stack, "ticks": 1})


def _top_up_window() -> tuple[bool, str | None, str | None]:
    """Is there a safe window to buy chips RIGHT NOW, and which one is it?
    Returns (open, trigger, why-not). FOUR WINDOWS:

      pre-fold    hero is on the clock, the answer is FOLD and auto is armed, so
                  WE decide when the fold lands - the one window whose END we
                  control. Bounded by TOP_UP_PREFOLD_BUDGET_S; see _topup_prefold
                  for why fold and nothing else qualifies. The other three all
                  race the next deal and, measured, sometimes lose it by a second.

      not-dealt   hero is sitting out, waiting for the big blind, or simply was
                  not dealt into this hand. He cannot be put on the clock and
                  cannot win a chip, so the WHOLE hand is a window. Until
                  2026-09-20 this one was never used at all: the old test asked
                  for the client's end-of-hand marker, which a hand hero is not
                  in never produces for him.
      fold        hero's fold is confirmed. A folded hero's stack behind is
                  already his final stack, so nothing has to settle. Measured
                  over 122 folds on record: median 40.8 s to the next deal, only
                  5 of them under 3 s. This is the window worth having, and it is
                  why the panel is NOT pre-staged during the hand - pre-staging
                  would buy back the 4% of windows that are tight by leaving a
                  modal over the action strip for the other 96%.
      hand-over   the client's own end-of-hand marker, once hero's stack has
                  stopped moving (i.e. the pot award has landed).

    HARD BLOCKS whichever window is open: the Buy-chips panel is modal over the
    action strip, so a press while hero is on the clock can swallow his turn, and
    a press while a client notice is up lands on the notice.
    """
    p = _feed_prev
    if not p.get("seated"):
        return False, None, "not seated"
    if p.get("waiting"):
        return False, None, "waiting for the next hand"
    # THE TWO HARD BLOCKS COME FIRST, before any window can claim to be open: a
    # click while a client notice is up lands on the NOTICE, and a run that has
    # been called off must not press again. Neither has an exception.
    if _live_status.get("modal"):
        return False, None, "a client notice is on screen"
    if _topup_abort.is_set():
        return False, None, "the window closed under the run"
    # pre-fold: hero IS on the clock and that is the point - we are holding it
    # deliberately so the chips land before we fold (see _topup_prefold). Bounded
    # by its own deadline, after which it stops being a window at all.
    if _topup_prefold["active"]:
        if time.time() < _topup_prefold["deadline"]:
            return True, "pre-fold", None
        return False, None, "the pre-fold budget ran out"
    if p.get("toAct") or _live_status.get("toAct"):
        return False, None, "hero is on the clock"
    if _live_status.get("hero") in ("sitting-out", "waiting-for-bb", "not-in-hand"):
        return True, "not-dealt", None
    if _ws_state.get("heroFolded"):
        return True, "fold", None
    if not _ws_state.get("handOver"):
        # SHOWDOWN PENDING (2026-09-23, terminal.hero_done): hero's river bet was called, he called an all-in, or
        # he is all-in himself — nothing left for him to decide while the client runs out the board and shows
        # the hands. Measured over the recordings, only 2 of 26 short hands hero played to a decision ended on
        # a terminal PICK; most ended on a bet or raise that was called, and the hand-over window after the award
        # is ~2.4 s to the next deal — too short for a run. This window is seconds long and the deal does not
        # cut it: hero has no decision the panel could cover. He can still WIN, so the buy may be refused at the
        # next hand — the handled refusal (_note_top_up_refusal).
        try:
            done = TERMINAL.hero_done(_hand_state())
        except Exception:
            done = None
        if done and done.terminal:
            return True, f"showdown ({done.kind})", None
        return False, None, "a hand is live for hero"
    # HERO PLAYED TO THE END: the award has to have landed before his stack means
    # anything. NOT "the pot label has gone" (2026-09-19, session 173224) - Ignition
    # keeps the pot on screen right up to the next deal, so that test never opened:
    # three of the four hands hero played to the end and finished short that session
    # never cleared the pot at all, and he sat at 86-92 bb for five hands. A stack
    # that has stopped moving is the fact; the label is a rendering detail.
    if (_study.get("stackStable") or {}).get("ticks", 0) < TOP_UP_SETTLE_TICKS:
        return False, None, "waiting for the pot award to land"
    return True, "hand-over", None


def _top_up_gate() -> tuple[bool, str | None]:
    """Is it safe to press a Buy-chips control RIGHT NOW?

    RE-READ BEFORE EVERY PRESS, not once at the start (2026-09-19). _maybe_top_up tests
    its preconditions and then hands the presses to a thread that reaches the client two
    to four seconds later; hero can be on the clock by then. Session 125204 hand 8: the
    panel opened at 12:55:57 with FOLD / CALL / RAISE on screen, the strip took it back a
    second later, and the poll that followed reported "the Buy-chips panel did not open"
    - a stack left at 98.5 bb through the blinds, and the panel one tick away from
    covering the action buttons instead.

    TWO DANGERS, AND THE HAND NUMBER IS NOT ONE OF THEM (2026-09-19, second pass). The
    Buy-chips panel is modal over the action strip, so pressing while hero is on the clock
    can swallow his turn, and pressing while a client notice is up lands the click on the
    notice. Those are hard blocks. "The table moved to the next hand" is not dangerous -
    the chips land at the next hand either way - and blocking on it killed runs mid-
    sequence: measured over every recording, 41% of the windows between hero's last turn
    and the next deal are shorter than a full run takes, so that check was abandoning the
    panel open about as often as it was protecting anything. Relevance is settled by
    re-reading the stack instead: a hero who is no longer short exits "at the max already".

    ONE SET OF RULES (2026-09-20): the gate and the scheduler read the same
    _top_up_window, so a window that opens a run cannot be a window the next press
    disagrees with.
    """
    ok, _trigger, why = _top_up_window()
    return ok, why


def _close_buy_panel() -> None:
    """Fold the Buy-chips panel back off the action strip.

    Safe to call twice, which the plain press was not: "Buy chips" is a TOGGLE, so
    pressing it on a panel that is already shut OPENS it - over the action strip,
    the one place it must never be. The flag is what makes the second call a no-op."""
    if not _topup_panel["open"]:
        return
    _topup_panel["open"] = False
    try:
        act("Buy chips", "button")
    except Exception as e:
        print(f"[top-up] could not close the Buy-chips panel: {e}")


_orphan_check = {"at": 0.0, "said": None}
ORPHAN_POLL_S = 10.0
# The pull side (_maybe_session_adopt). Faster than the orphan poll on purpose:
# every tick a table spends outside the session is a hand it answers nothing for,
# while an orphaned table carries on reading and only mis-files its archive.
_adopt_check = {"at": 0.0, "said": None}
ADOPT_POLL_S = 4.0


def _maybe_session_orphaned() -> None:
    """A FOLLOWER WHOSE SESSION HAS BEEN ENDED STANDS ITSELF DOWN (2026-09-20).

    The leader tells the tables when it ends a session, and now also when it sweeps
    a leftover — but neither helps if the leader is killed, crashes, or its panel is
    closed. The follower would go on answering and archiving into a session the
    record says finished, which is exactly what happened to 130435: 33 hands, an
    hour, into a session summarised as "hands: 0".

    So the follower checks for itself. The sessions store is one sqlite file both
    processes already share, so this costs a keyed read every ORPHAN_POLL_S — no
    IPC, and it works no matter how the leader went away. The leader never does
    this: it OWNS the record, and an id it has not ended is not orphaned.
    """
    sid = _session["id"]
    if not sid or TABLES.is_leader():
        return
    now = time.time()
    if now - _orphan_check["at"] < ORPHAN_POLL_S:
        return
    _orphan_check["at"] = now
    try:
        rec = _sessions.get(sid)
    except Exception:
        return                      # the store is busy; try again in ten seconds
    if not rec or not rec.get("ended_at"):
        return
    if _orphan_check["said"] == sid:
        return
    _orphan_check["said"] = sid
    print(f"[session] slot {TABLES.slot()}: {sid} was ended by the leader — standing down")
    _feed_add(f"Session {sid} ended elsewhere — this table stood down")
    try:
        _session_leave({"sid": sid})
    except Exception as e:
        print(f"[session] slot {TABLES.slot()}: could not stand down cleanly: {e}")


def _maybe_session_adopt() -> None:
    """A FOLLOWER WITH NO SESSION TAKES UP ONE THAT DECLARED IT (2026-09-21).

    The counterpart of _maybe_session_orphaned, and the reason this failure mode
    took a whole session to notice: the leader PUSHES `/session/join` once, at
    Start, and if that push does not arrive the table never asks again. It read
    its felt for twenty hands with answers off and nothing anywhere said so.

    A push can miss for ordinary reasons — this wrapper restarted mid-session,
    or it was still booting when the leader fanned out — and none of them should
    cost a table its answers. So the follower also PULLS, from the same sqlite
    store the orphan check already reads: no IPC, and it works even when the
    leader has gone away.

    It only takes a session that ASKED for this table: `config.tables` is the
    count Brady chose on the setup page, so a single-table session (or a
    two-table one, to slot 3) is not ours to join, and we stay out of it."""
    me = TABLES.slot()
    if _session["id"] or me is None or TABLES.is_leader():
        return
    now = time.time()
    if now - _adopt_check["at"] < ADOPT_POLL_S:
        return
    _adopt_check["at"] = now
    try:
        open_recs = _sessions.open_sessions()
    except Exception:
        return                          # the store is busy; try again shortly
    for rec in open_recs:               # newest first
        cfg = rec.get("config") or {}
        try:
            want = int(cfg.get("tables") or 1)
        except (TypeError, ValueError):
            want = 1
        if want < me:
            continue                    # that session did not ask for this table
        # SAID ONCE, TRIED EVERY TICK. A join that fails now may succeed in four
        # seconds (the store was mid-write, the record was a moment from being
        # ended), so giving up after one attempt would put this table back where
        # it started — reading a felt in silence. What is deduplicated is the
        # SAYING, not the trying: one line per session, not one every poll.
        first = _adopt_check["said"] != rec["id"]
        _adopt_check["said"] = rec["id"]
        if first:
            print(f"[session] slot {me}: {rec['id']} declared {want} tables and never reached this one — joining it")
            _feed_add(f"Joined session {rec['id']} (the leader's invitation never arrived)")
        try:
            code, res = _session_join({"sid": rec["id"], "config": cfg})
            if code != 200:
                print(f"[session] slot {me}: could not join {rec['id']}: {res.get('error')}")
        except Exception as e:
            print(f"[session] slot {me}: could not join {rec['id']}: {e}")
        return


def _maybe_guard_buy_panel() -> None:
    """Hero put on the clock with our panel up: close it NOW and call the run off.

    The panel is modal over the action strip, so the strip is behind it - the study
    answer cannot be relayed and hero cannot press for himself. Session 125204 hand 8
    is exactly this, from the other side: the panel opened a second before FOLD /
    CALL / RAISE appeared and the run then reported it had never opened."""
    # THE DOM DECIDES, NOT OUR FLAG (2026-09-20). This used to return early on
    # `not _topup_panel["open"]`, which is the belief the top-up run had just written
    # — and when that belief was wrong (hand 513: panel rendered after the poll gave
    # up) the one guard written for this case disarmed itself. The buy panel's own
    # BUY button is in the DOM snapshot this tick already read, so ask it.
    if not (_live_status.get("buyPanel") or _topup_panel["open"]):
        return
    if not (_live_status.get("toAct") or _feed_prev.get("toAct")):
        return
    # THE ONE SANCTIONED EXCEPTION: a pre-fold run put that panel there ON PURPOSE
    # while hero is on the clock, because the answer is FOLD and we are holding the
    # clock to get the chips in first. Closing it here would call off the very run
    # this feature exists for, every time, one tick after it started.
    #
    # It is an exception with a fuse, not a licence: the instant the budget is
    # spent the panel comes off the strip and the run is called off, exactly as
    # for anyone else. A pre-fold run that hangs must never cost hero the hand.
    if _topup_prefold["active"]:
        if time.time() < _topup_prefold["deadline"]:
            return
        _topup_prefold["active"] = False
        _feed_add("Pre-action top-up out of time - closing the panel so the action can go")
        print("[top-up] pre-action budget spent; closing the panel so the action can go")
    _topup_abort.set()
    # ONE CLOSE PER EPISODE (TU-13, 2026-09-23): the panel takes a tick or two to leave the DOM after the toggle,
    # and a guard re-pressing on every 250 ms tick toggled it OPEN again (dom.jsonl 131406 shows 1-tick opens
    # 2-3 ticks after a close). A close is not repeated for TOP_UP_CLOSE_DEBOUNCE_S.
    if time.time() - _topup_panel.get("lastCloseAt", 0.0) < TOP_UP_CLOSE_DEBOUNCE_S:
        return
    # the flag may say shut while the panel is plainly up; _close_buy_panel() is a
    # no-op in that case, so tell it the truth first
    if _live_status.get("buyPanel"):
        _topup_panel["open"] = True
    _topup_panel["lastCloseAt"] = time.time()
    _close_buy_panel()
    _feed_add("Buy-chips panel closed - hero is on the clock")


def _terminal_pick(r: dict):
    """Is this pick TERMINAL for hero — no further decision in this hand after it?

    Read off the PLAN the relay would actually send, not the prose: `pick` is
    display text ("FOLD 100%"), `plan` is what goes to the client. The family
    lives in ONE place, terminal.is_terminal (fold · shove · all-in call · the
    river call or check that closes the action · a call when every opponent is
    already all-in), decided from the exported hand. Plain string tests inside
    it, deliberately NOT a regex: the first cut of the fold matcher carried a
    literal BACKSPACE where a word boundary was meant ("^fold\\x08"), which
    greps as "^fold" and matched nothing at all."""
    return TERMINAL.is_terminal(r.get("plan") or {}, _hand_state())


def _prefold_pick_is_fold(r: dict) -> bool:
    """A plain FOLD, and nothing else — the exact-amount case of the family (kept for the older tests)."""
    return _terminal_pick(r).kind == "fold"


def _note_top_up_refusal(m: dict) -> None:
    """THE EXPECTED REFUSAL (2026-09-23). A buy pressed before a terminal action hero could still WIN lands
    above the max when he does win; the client processes it at the next hand and refuses with the "more than
    the maximum buy in" notice over the action strip (session 100647 hands 4/5). _handle_modal dismisses it the
    tick it appears; this files it as its own event against the press it belongs to, marks that press refused
    (so the pending-press block does not starve the next window), and leaves the ordinary windows to retry if
    hero is still short. Nothing here presses anything."""
    if (m or {}).get("harmless") not in ("buy-in above the table maximum", "buy-in maximum notice"):
        return
    rec = _study.get("lastTopUp") or {}
    if not rec.get("pressed") or rec.get("receiptCents") or rec.get("refused"):
        return
    if time.time() * 1000 - (rec.get("at") or 0) > 180_000:
        return
    rec.update({"ok": False, "refused": True,
                "reason": "refused by the client at the next hand — hero's stack was above the max (won the pot after the buy)"})
    _feed_add(f"Top-up ${(rec.get('amountCents') or 0) / 100:.2f} refused — hero finished above the max; the next window decides again")
    if _session["id"]:
        _sessions.event(_session["id"], "top-up-refused-over-max",
                        {"hand": _hand_no, "handKey": _hand_key(), "amountCents": rec.get("amountCents"),
                         "pressedHandKey": rec.get("handKey"), "trigger": rec.get("trigger"),
                         "terminalKind": rec.get("terminalKind")})


def _maybe_prefold_top_up() -> None:
    """Buy the chips BEFORE a TERMINAL action, while we still hold the clock.

    Runs from the feed loop, ahead of _maybe_auto_act. When it starts a run, the
    Buy-chips panel goes up over the action strip — and _maybe_auto_act holds the
    press while this run is active (and while the panel is over the strip). That
    hold is re-tested every tick and is not a verdict, so nothing special is
    needed to release it: the run's finally IS the release.

    WHICH ACTIONS (2026-09-23, Brady: "before any terminal action, not only a
    fold"): terminal.is_terminal — a fold, a shove, a call that puts hero all-in,
    the river call or check that closes the action, a call when every opponent
    is already all-in. For a fold, stack behind is hero's final stack and the
    amount is exact. For the others hero can still WIN the pot; a buy sized off
    stack behind then lands above the max, and the client refuses it at the next
    hand with a notice over the strip — an EXPECTED outcome: _handle_modal
    dismisses it, _note_top_up_refusal files it and frees the next window, and a
    hero who lost or chopped and is still short is served by the ordinary
    windows. Either way hero starts the next hand at the max or the refusal
    says why not.

    Everything here is a precondition for taking hero's clock. If any of them is
    not met we simply do not start, and the ordinary post-action windows carry on
    exactly as before."""
    if not (TOP_UP_PREFOLD and _study.get("topUp") and _study.get("on") and _session["id"]) or _fake_mode:
        return
    if _topup_prefold["active"] or _topup_lock.locked() or _topup_abort.is_set():
        return
    # WE MUST OWN THE PRESS. Without auto armed the human is the one reaching for
    # the action strip, and the panel would be sitting on top of it.
    if not _study.get("auto"):
        return
    ok, _why = _auto_table_ok()
    if not ok:
        return
    if not (_live_status.get("toAct") or _feed_prev.get("toAct")):
        return
    if _live_status.get("modal") or _live_status.get("buyPanel"):
        return                       # a notice, or someone else's panel already up
    r = _pick_ready()
    if not r.get("ok"):
        return
    verdict = _terminal_pick(r)
    if not verdict.terminal:
        return
    if _study.get("uncertain"):
        return                       # the line is disputed; do not act on it at all
    hid = _hand_key()
    # ONCE PER HAND, and never for a hand the ordinary path already served.
    if _topup_prefold.get("hand") == hid or _study.get("topUpHand") == hid:
        return
    # A PRESS STILL PENDING (TU-09): the previous hand's buy has no receipt yet — the client credits chips at the
    # next hand, so the stack still reads short. Pressing again is the second-buy-in-one-hand question the
    # ordinary path already refuses to ask (_maybe_top_up); the same guard here.
    last = _study.get("lastTopUp") or {}
    if last.get("pressed") and not last.get("receiptCents") and not last.get("refused") \
            and (time.time() * 1000 - (last.get("at") or 0)) < 180_000:
        return
    read = _top_up_read()
    if read.get("zone") or not read.get("seated") or read.get("stackCents") is None or not read.get("maxCents"):
        return
    short = read["maxCents"] - read["stackCents"]
    floor = max(1, int(round((read.get("bbCents") or 0) * TOP_UP_MIN_SHORT_BB)))
    if short < floor:
        return
    # ONE RUN AT A TIME (TU-08): the lock is the "a run is in flight" signal every other path reads, and
    # _top_up_run's finally releases it — so it is taken here, exactly as _maybe_top_up takes it.
    if not _topup_lock.acquire(blocking=False):
        return
    # THE CLOCK. The client offers "+45s" at about nine seconds left; taking it
    # first is worth far more than it costs, and it is pressed BEFORE the panel
    # goes up because the panel would cover the button. `banked` is the PRESS
    # RESULT (TU-07): it used to read True whenever the button was on screen,
    # cooldown or refusal notwithstanding, and bought a 20 s budget on a ~14 s clock.
    banked = False
    bank_label = None
    if _live_status.get("timeBank"):
        try:
            res = _maybe_take_time()
            banked = bool(res and res.get("ok"))
            bank_label = (res or {}).get("label")
        except Exception as e:
            print(f"[top-up] pre-action: could not take the time bank: {e}")
    # the budget follows the bank actually granted: "+45s" earns the long budget, a shorter grant ("+16s" is
    # on record) only what it added, and no grant the base budget
    budget = TOP_UP_PREFOLD_BUDGET_S
    if banked:
        m = re.search(r"(\d+)", bank_label or "")
        granted = int(m.group(1)) if m else 45
        # three quarters of what was granted goes to the run, the rest stays hero's; the full +45s earns the
        # long budget, a "+16s" (on record) about 18 s
        budget = TOP_UP_PREFOLD_BANKED_S if granted >= 45 else min(TOP_UP_PREFOLD_BANKED_S, TOP_UP_PREFOLD_BUDGET_S + granted * 0.75)
    _topup_prefold.update({"active": True, "key": r.get("key"), "hand": hid,
                           "startedAt": time.time(), "deadline": time.time() + budget,
                           "banked": banked, "kind": verdict.kind, "finalStackKnown": verdict.final_stack_known})
    _study["topUpHand"] = hid        # this hand's attempt is spent either way
    _study["topUpTrigger"] = "pre-action"
    _study["topUpAt"] = time.time()
    _study["topUpMayExceed"] = not verdict.final_stack_known
    _feed_add(f"Pre-action top-up ({verdict.kind}): buying ${short / 100:.2f} before the {r.get('pick')}"
              + (" (time bank taken)" if banked else "")
              + ("" if verdict.final_stack_known else " — hero can still win, so the client may refuse it at the next hand"))
    print(f"[top-up] pre-action ({verdict.kind}): {short}c short, {budget:.0f}s budget"
          + (f" after taking the time bank ({bank_label})" if banked else ""))
    if _session["id"]:
        _sessions.event(_session["id"], "top-up-prefold", {
            "hand": _hand_no, "handKey": hid, "shortCents": short,
            "budgetS": budget, "timeBank": banked, "timeBankLabel": bank_label, "pick": r.get("pick"),
            "terminalKind": verdict.kind, "finalStackKnown": verdict.final_stack_known, "why": verdict.why})

    def go():
        try:
            rec = _top_up_run()
            if isinstance(rec, dict):
                rec["terminalKind"] = verdict.kind
        except Exception as e:
            print(f"[top-up] pre-action run: {e}")
        finally:
            # ALWAYS, whatever happened. While this flag is set the Buy-chips
            # panel is allowed to stand over the action strip; leaving it set
            # after the run would leave hero unable to act at all.
            _topup_prefold["active"] = False
            if _topup_lock.locked():
                try:
                    _topup_lock.release()      # _top_up_run releases on its own paths; this is the belt
                except RuntimeError:
                    pass
            try:
                _close_buy_panel()
            except Exception:
                pass
            held = round(time.time() - _topup_prefold["startedAt"], 1)
            print(f"[top-up] pre-action done in {held}s - the {verdict.kind} can go")

    threading.Thread(target=go, daemon=True, name="top-up-preaction").start()


def _top_up_kpi_tick() -> None:
    """THE NUMBER THAT MATTERS: how many hands hero STARTED below the table max.

    Every other top-up statistic - presses, receipts, windows used - is a proxy for
    this one, and the proxies disagreed with it all through September: 11 presses on
    record while 24 short hands were played out untouched. Counted once per hand off
    the client's own stack and max, on a thread so the feed loop never waits."""
    hid = _hand_key()
    if _topup_kpi["hand"] == hid or not _feed_prev.get("seated") or _feed_prev.get("waiting"):
        return
    if not (_study.get("topUp") and _session["id"]) or _fake_mode:
        return
    if _live_status.get("hero") in ("sitting-out", "waiting-for-bb", "not-in-hand", "unknown", None):
        return   # hero is not in this hand: there is no "started" to measure
    _topup_kpi["hand"] = hid
    threading.Thread(target=_top_up_kpi_read, args=(hid,), daemon=True, name="top-up-kpi").start()


def _top_up_kpi_read(hid: str) -> None:
    try:
        r = _top_up_read()
        bb, stack, mx = r.get("bbCents"), r.get("stackCents"), r.get("maxCents")
        if r.get("zone") or not bb or stack is None or not mx:
            return   # Zone sets the stack itself; an unreadable table is not a short hand
        _study["topUpMax"] = {"maxCents": mx, "bbCents": bb, "assumed": bool(r.get("maxAssumed"))}
        # STACK AS DEALT, not stack behind. The blinds are gone from the seat label by
        # the first tick of the hand, so the raw reading calls every big blind one bb
        # short and every open-raiser three. Everything hero has put in this hand goes
        # back on — the sum is his stack at the deal whenever this runs in the hand.
        wire_bb = _ws_state.get("bb") or 0
        mine = (_ws_state.get("committed") or {}).get(_ws_state.get("heroSeat")) or 0
        dealt_cents = stack + (round(mine / wire_bb * bb) if wire_bb and _ws_state.get("bbSeen") else 0)
        short_bb = (mx - dealt_cents) / bb
        _topup_kpi["hands"] += 1
        if short_bb < TOP_UP_MIN_SHORT_BB:
            return
        _topup_kpi["short"] += 1
        _topup_kpi["worstBb"] = max(_topup_kpi["worstBb"], round(short_bb, 1))
        _feed_add(f"Started this hand {short_bb:.1f} bb below the max "
                  f"({_topup_kpi['short']} of {_topup_kpi['hands']} hands so far)")
        if _session["id"]:
            _sessions.event(_session["id"], "top-up-short-start",
                            {"hand": hid, "shortBb": round(short_bb, 2), "stackCents": stack,
                             "dealtCents": dealt_cents, "maxCents": mx,
                             "short": _topup_kpi["short"], "hands": _topup_kpi["hands"]})
    except Exception as e:
        print(f"[top-up] kpi: {e}")


def _maybe_top_up() -> None:
    """AUTO TOP-UP, from the feed loop: hero below the table's max buy-in, in a safe
    window -> open Buy chips, take the Max the client offers, press BUY. The amount is
    always the client's own number. Once per hand, with a cooldown, and the presses run
    on their own thread so the feed loop never waits on the client. Independent of the
    study answers: it is about the stack, not the decision.

    WHICH WINDOW, and why it is not "between hands" any more, is in _top_up_window."""
    if not (_study.get("topUp") and _session["id"]) or _fake_mode:
        return
    _top_up_settle_tick()
    # THE DOM DECIDES THE PANEL BELIEF OFF THE CLOCK TOO (TU-12, 2026-09-23). `open` is a belief three threads
    # write; a two-press failure left it True with no close, and at hero's next turn act() toggled a SHUT panel
    # open over the strip. Four consecutive ticks without the panel in the DOM (and no run in flight) is the
    # panel being shut; two with it is the panel being open.
    if not _topup_lock.locked():
        seen = _topup_panel.get("domTicks", 0)
        if _live_status.get("buyPanel"):
            _topup_panel["domTicks"] = seen + 1 if seen >= 0 else 1
            if _topup_panel["domTicks"] >= 2:
                _topup_panel["open"] = True
        else:
            _topup_panel["domTicks"] = seen - 1 if seen <= 0 else -1
            if _topup_panel["domTicks"] <= -4:
                _topup_panel["open"] = False
    # The abort belongs to the run that was called off. Once that run has let the lock
    # go and the panel is shut, the next window starts clean — without this the very
    # first guarded close would wedge the top-up for the rest of the session.
    if _topup_abort.is_set() and not _topup_lock.locked() and not _topup_panel["open"]:
        _topup_abort.clear()
    ok, trigger, _why = _top_up_window()
    if not ok:
        _study["topUpDue"] = None    # the window shut before the wait ran out
        return
    hid = _hand_key()
    if _study.get("topUpHand") == hid or (time.time() - _study.get("topUpAt", 0.0)) < TOP_UP_COOLDOWN_S:
        return
    # A press whose chips have not landed yet (no receipt) is not a shortfall
    # to press for again: the client adds the chips at the NEXT hand, and a
    # second press meanwhile just toggles the panel (session 100647, hand 10:
    # $34 pressed for a stack the $33 from hand 9 was about to fix).
    last = _study.get("lastTopUp") or {}
    if (last.get("pressed") and not last.get("receiptCents") and not last.get("refused")
            and (time.time() * 1000 - (last.get("at") or 0)) < 180_000):
        return      # a press the client REFUSED (over the max) is not pending: the next window decides again
    # A SMALL WAIT, drawn once per window (TOP_UP_JITTER_S). The fold trigger fires on
    # the tick the fold is confirmed, which is 250 ms after it happens, every time.
    due = _study.get("topUpDue")
    if due is None:
        _study["topUpDue"] = time.time() + random.uniform(*TOP_UP_JITTER_S)
        return
    if time.time() < due:
        return
    _study["topUpDue"] = None
    if not _topup_lock.acquire(blocking=False):
        return
    _study["topUpAt"] = time.time()
    _study["topUpHand"] = hid
    _study["topUpTrigger"] = trigger
    _topup_abort.clear()
    threading.Thread(target=_top_up_run, daemon=True, name="top-up").start()


def _top_up_run(force: bool = False, amount_cents: int | None = None) -> dict:
    """The presses. Returns the record it wrote (or why it did nothing).

    Every press is gated on the table AS IT IS AT THAT MOMENT (_top_up_gate),
    not on what it was when this run was scheduled — see the note there. A run that
    opened the panel and then finds it cannot go on folds the panel back rather than
    leaving it over the action strip.

    IT FINISHES ACROSS THE DEAL (2026-09-19, Brady). 41% of the windows between hero's
    last turn and the next hand are shorter than this run takes, and the chips land at
    the next hand however it goes — so once started, the run presses on. Only the two
    real dangers stop it: hero on the clock, or a notice over the strip. Relevance (has
    the table moved on?) is decided ONCE, before anything has been pressed."""
    if force:
        _study["topUpTrigger"] = "forced"
    opened = False
    try:
        if not force:
            ok, why = _top_up_gate()
            if not ok:
                # nothing was pressed, so this hand's attempt is not spent: let the feed
                # loop schedule another once the table is between hands again. SAID OUT
                # LOUD (2026-09-19): these exits were quiet, which is why one session's
                # only good window is unexplainable from the record — the feed showed
                # nothing between a stack going short and staying short for five hands.
                _study["topUpHand"] = None
                return _top_up_done(False, 0, {}, f"not pressed — {why}")
        r = _top_up_read()
        if r.get("zone"):
            return _top_up_done(True, 0, r, "Zone table — the client sets the stack, nothing to top up", quiet=True)
        if not r.get("seated") or r.get("stackCents") is None or not r.get("maxCents"):
            # Until 2026-09-19 this exit was silent (no record, no print): the units bug above hid behind it for
            # two sessions. Now every exit says why, on the panel and in the session.
            why = r.get("reason") or ("stack unreadable" if r.get("seated") and r.get("stackCents") is None
                                     else "no max buy-in on this table" if r.get("seated") else "not seated")
            return _top_up_done(False, 0, r, why)
        short = r["maxCents"] - r["stackCents"]
        # A MINIMUM WORTH PRESSING FOR (2026-09-20). The old floor was a twentieth of a
        # big blind, i.e. anything at all: a stack 0.05 bb light spent the window, wrote
        # a feed line and put the panel over the strip for nothing. Nothing about a
        # decision changes under one big blind.
        floor = max(1, int(round((r.get("bbCents") or 0) * TOP_UP_MIN_SHORT_BB)))
        if amount_cents is None and short < floor:
            return _top_up_done(True, 0, r, "at the max already", quiet=True)
        if not r.get("panelOpen"):
            # TWO GOES, each gated (2026-09-19). One press and a three-second poll was a
            # single point of failure: the press is a TOGGLE, so a panel already open when
            # we arrive is closed by it, and a panel opened into hero's turn is taken back
            # by the action strip before the poll can see it.
            for attempt in (1, 2):
                if not force:
                    ok, why = _top_up_gate()
                    if not ok:
                        _study["topUpHand"] = None
                        return _top_up_done(False, short, r, f"not pressed — {why}")
                res = act("Buy chips", "button")
                if not res.get("ok"):
                    return _top_up_done(False, short, r, f"could not open Buy chips — {res.get('reason')}")
                opened = _topup_panel["open"] = True
                # the panel renders about a second after the press — poll for it rather than read once
                for _ in range(10):
                    time.sleep(0.3)
                    r = {**r, **{k: v for k, v in _top_up_read().items() if k in ("panelOpen", "offerCents", "inputFound", "inputValue")}}
                    if r.get("panelOpen"):
                        break
                if r.get("panelOpen"):
                    break
                # THE PRESS WAS ISSUED, SO THE PANEL IS NOT KNOWN TO BE SHUT (2026-09-20).
                # This used to record `open = False` — "the toggle left it shut" — and that
                # guess is what cost hand 513: the client rendered the panel a second after
                # this poll gave up, the next gate check returned without closing anything,
                # and _maybe_guard_buy_panel() then skipped it for 56s because the flag said
                # shut. A late panel is far likelier than a lost press, and believing it open
                # costs one extra toggle while believing it shut costs the hand.
                print(f"[top-up] Buy-chips panel not up after press {attempt} — assuming it may still render")
            if not r.get("panelOpen"):
                return _top_up_done(False, short, r, "the Buy-chips panel did not open (two presses)")
        opened = _topup_panel["open"] = True
        if not force:
            ok, why = _top_up_gate()
            if not ok:
                _close_buy_panel()   # fold the panel back off the strip
                _study["topUpHand"] = None
                return _top_up_done(False, short, r, f"not pressed — {why}")
        # the caller's amount if it named one (the probes), else the client's Max, else our shortfall
        want = int(amount_cents) if amount_cents else (r["offerCents"] if r.get("offerCents") else short)
        t = ignition_target()
        fill = (cdp._eval(t["webSocketDebuggerUrl"], _topup_fill_js(TABLES.dom_slot()) + f"({int(want)})", timeout=6) or {}) if t else {}
        if not fill.get("ok"):
            _close_buy_panel()   # fold the panel back
            return _top_up_done(False, want, r, f"could not set the amount — {fill.get('reason', 'no reply')}")
        time.sleep(0.3)
        if not force:
            ok, why = _top_up_gate()
            if not ok:
                _close_buy_panel()
                return _top_up_done(False, want, r, f"not pressed — {why}")
        res = act("BUY", "button")
        if not res.get("ok"):
            _close_buy_panel()
            return _top_up_done(False, want, r, f"BUY not pressed — {res.get('reason')}")
        _topup_panel["open"] = False   # BUY dismisses the panel itself
        # THE RECEIPT: the client toasts "You have successfully added $N in chips."
        # — its own word that the buy went through (seen in the 010011 recording
        # while the reader was still saying the panel had not opened). Poll for it.
        receipt = None
        pressed_at = time.time()
        # NOT ON THE PRE-ACTION PATH: this poll costs up to 3.2 s and every one of
        # them is clock hero still needs to act with. The receipt is not lost by
        # skipping it — _top_up_receipt() picks the toast up from the feed loop a
        # moment later and records it — it is only not waited FOR here.
        tries = 0 if _topup_prefold["active"] else 8
        for _ in range(tries):
            time.sleep(0.4)
            # THE RECEIPT MUST BE NEW AND MATCH (TU-04, 2026-09-23). This used to re-scan the table text, which
            # still shows the sit-down "$200 added" line for the whole session: session 100647 hand 5 recorded a
            # $5 press as ok on a $200 receipt, and 18 records are ok with the stack unchanged and no receipt.
            # The feed loop files each toast once, on its rising edge (_top_up_receipt -> _toasts_seen); only a
            # toast filed since THIS press, within $1 of the amount pressed, is this press's receipt.
            receipt = next((amt for amt, at in reversed(_toasts_seen)
                            if at >= pressed_at - 0.5 and abs(int(round(float(amt.replace(",", "")) * 100)) - int(want)) <= 100), None)
            if receipt:
                break
        after = _top_up_read().get("stackCents")
        # a stack that rose by ABOUT the amount pressed is the buy landing; a stack that rose by the pot is a win
        # (session 125204 hand 34: 14200 -> 24700 on a 20000 max was filed as a landed $58 buy) — TU-05
        landed = after is not None and abs((after - r["stackCents"]) - int(want)) <= max(100, int(want) // 10)
        ok = bool(receipt) or landed
        if _topup_prefold["active"] and not ok:
            # BUY went in and we did not wait around to watch it land. That is the
            # design, not a failure: say so, rather than filing it as one.
            return _top_up_done(True, want, r, "pressed before the fold; the receipt lands on its own",
                                after, pressed=True)
        return _top_up_done(ok, want, r,
                            None if ok else "pressed; no receipt and the stack has not moved yet (the client adds chips at the next hand)",
                            after, pressed=True)
    except Exception as e:
        if opened:
            _close_buy_panel()   # never leave it covering the action strip
        return _top_up_done(False, 0, {}, f"error: {e}")
    finally:
        if _topup_lock.locked() and not force:
            _topup_lock.release()


def _top_up_probe_second(cents: int = 0) -> dict:
    """TEST A: will Ignition take a SECOND buy request in the same hand, while the
    first one's chips are still pending?

    The answer decides how much design the showdown case needs. If a second request is
    accepted, the top-up can fire early and optimistically and correct itself a moment
    later; if it is refused, every press has to be the right one first time and the
    windows have to be picked carefully. The recordings cannot settle it — the one
    natural experiment on record (session 100647, hands 9 and 10) is confounded,
    because the second press is also the one where the panel never opened.

    RUN IT AT A LIVE RING TABLE with hero short of the max and NOT in a hand. It
    presses two small buys back to back and reports what the client did with each.
    With no amount it splits the shortfall in two."""
    out: dict = {"at": int(time.time() * 1000), "presses": []}
    before = _top_up_read()
    out["before"] = {k: before.get(k) for k in ("stackCents", "maxCents", "bbCents", "panelOpen", "zone")}
    if not before.get("seated") or before.get("stackCents") is None or not before.get("maxCents"):
        return {**out, "ok": False, "verdict": "no readable ring table — the probe needs hero seated at one"}
    short = before["maxCents"] - before["stackCents"]
    cents = int(cents) or max(100, short // 2)
    if cents * 2 > short + 1:
        return {**out, "ok": False, "short": short,
                "verdict": f"hero is only ${short / 100:.2f} short — two ${cents / 100:.2f} buys would go over the max"}
    out.update({"amountCents": cents, "shortCents": short, "hand": _hand_key()})
    for i in (1, 2):
        out["presses"].append(_top_up_run(force=True, amount_cents=cents))
        if i == 1:
            time.sleep(4.0)
    out["modal"] = _live_status.get("modal")
    out["afterCents"] = _top_up_read().get("stackCents")
    out["sameHand"] = out["hand"] == _hand_key()
    p1, p2 = out["presses"]
    out["ok"] = bool(p1.get("pressed"))
    out["verdict"] = ("inconclusive — the FIRST press never went through: " + str(p1.get("reason"))
                      if not p1.get("pressed") else
                      "SECOND REQUEST ACCEPTED — the client took both" if p2.get("ok") else
                      "SECOND REQUEST REFUSED — " + str(p2.get("reason")))
    if not out["sameHand"]:
        out["verdict"] += " (CAVEAT: the table dealt a new hand mid-probe — run it again between hands)"
    _feed_add(f"Top-up probe: {out['verdict']}")
    if _session["id"]:
        _sessions.event(_session["id"], "top-up-probe-second", out)
    return out


def _top_up_done(ok: bool, cents: int, r: dict, reason: str | None, after: int | None = None, pressed: bool = False,
                 quiet: bool = False) -> dict:
    rec = {"at": int(time.time() * 1000), "ok": ok, "pressed": pressed, "amountCents": int(cents),
           "beforeCents": r.get("stackCents"), "afterCents": after, "maxCents": r.get("maxCents"),
           "maxAssumed": bool(r.get("maxAssumed")), "bbCents": r.get("bbCents"), "stackText": r.get("stackText"),
           "hand": _hand_no, "handKey": _hand_key(), "trigger": _study.get("topUpTrigger"),
           "reason": reason}
    _study["lastTopUp"] = rec
    print(f"[top-up] {rec}")
    if quiet:
        return rec   # nothing to do (at the max / Zone): the record says so, the feed stays clean
    amt = f"${cents / 100:.2f}"
    _feed_add(f"Top-up {amt} → stack ${(after or 0) / 100:.2f}" if ok
              else f"Top-up {amt} pressed — {reason}" if pressed else f"Top-up NOT done — {reason}")
    if _session["id"]:
        _sessions.event(_session["id"], "top-up", rec)
    return rec


def _set_auto(on: bool, allow_real: bool = False, minutes: float = 30.0,
              hands: int = 50, reason: str | None = None, delay: str | None = None,
              time_bank: bool | None = None, top_up: bool | None = None) -> dict:
    """Arm/disarm the auto mode.

    Practice and fake tables arm with no ceremony. A REAL-MONEY table needs
    `allow_real` — the caller saying, in as many words, that it meant this —
    and the allowance it grants is bounded by BOTH a wall-clock minute budget
    and a hand budget, whichever runs out first (see _auto_allowance). It is
    stamped into the session record, shown on the panel, and dropped by
    _maybe_auto_act the moment either budget is gone. Granted 2026-09-14 so the
    unattended path could be tested at all: the practice tables never have
    enough players to deal a hand.
    """
    if delay in ("instant", "random"):
        _study["autoDelay"] = delay
        _study["autoDue"] = None   # a mode change never inherits a wait drawn under the other
    if time_bank is not None:
        _study["timeBank"] = bool(time_bank)
    if top_up is not None:
        _study["topUp"] = bool(top_up)
    if not on:
        _study["auto"] = False
        _study["autoDue"] = None
        _study.update({"autoRealUntil": 0.0, "autoRealHands": 0, "autoRealFrom": None, "autoRealReason": None})
        # The LIVE toggle wins over the declaration. Without this, switching it
        # off on the panel would be undone by _maybe_auto_arm on the very next
        # feed tick (declared + not armed = arm it), i.e. an off switch that
        # does not switch off.
        _study["autoDeclared"] = False
        if _session["id"]:
            _sessions.event(_session["id"], "study-auto", {"on": False, "hand": _hand_no})
        print("[pick] auto off")
        return {"ok": True, "auto": False, "allowance": _auto_allowance()}

    practice = bool(_fake_mode or (CP.practice() if _is_cp() else _live_status.get("practice")))
    if _is_cp() and not practice:
        _study["auto"] = False
        return {"ok": False, "auto": False,
                "error": "CoinPoker auto-execute is practice-only — this table is real money (or its type is unknown)",
                "allowance": _auto_allowance()}
    if not practice:
        if not allow_real:
            _study["auto"] = False
            return {"ok": False, "auto": False,
                    "error": "this is a REAL-MONEY table: auto-execute needs an explicit testing allowance "
                             "(POST /study-auto {auto:true, allowRealMoney:true, minutes, hands})",
                    "allowance": _auto_allowance()}
        mins = max(1.0, min(float(minutes or 30), 120.0))
        cap = max(1, min(int(hands or 50), 500))
        _study.update({"autoRealUntil": time.time() + mins * 60, "autoRealHands": cap,
                       "autoRealFrom": _hand_no, "autoRealReason": reason or "unattended-path test"})
        print(f"[pick] REAL-MONEY auto allowance: {mins} min / {cap} hands ({_study['autoRealReason']})")

    _study["auto"] = True
    if _session["id"]:
        _sessions.event(_session["id"], "study-auto", {
            "on": True, "hand": _hand_no, "practice": practice, "delay": _study.get("autoDelay"),
            "realMoneyAllowance": None if practice else _auto_allowance()})
    print(f"[pick] auto ON ({'practice' if practice else 'REAL MONEY, bounded'}, {_study.get('autoDelay')})")
    return {"ok": True, "auto": True, "practice": practice, "delay": _study.get("autoDelay"), "allowance": _auto_allowance()}


def shot() -> bytes | None:
    t = ignition_target()
    if not t:
        return None
    png = Path(tempfile.gettempdir()) / "ignition_study_shot.png"
    try:
        if cdp.screenshot(t["webSocketDebuggerUrl"], str(png)):
            return png.read_bytes()
    except Exception:
        pass
    return None


# ---- Panel server ----

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence per-request noise
        pass

    def parse_request(self):
        self._t0 = time.time()          # when this request began, for the slow-request line in _send
        return super().parse_request()

    def _send(self, code: int, ctype: str, body: bytes):
        # SLOW REQUESTS, LOGGED (2026-09-24): the study API reads /state with a 3 s budget; a reply that takes
        # long is a lost or late answer, and until now nothing said which request or how long
        dt = time.time() - getattr(self, "_t0", time.time())
        if dt > 0.4:
            print(f"[slow] {self.command} {self.path} {dt * 1000:.0f} ms -> {code}")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The study pages (served by the API on :2000) drive the state tester
        # cross-origin; everything here is already loopback-only.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # CORS preflight for the dashboard's JSON POSTs
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path in ("/", "/panel") and not _session["id"] and not _fake_mode:
                # Nothing is declared yet — the setup page is the front door.
                self.send_response(302)
                self.send_header("Location", "/setup")
                self.end_headers()
            elif path in ("/", "/panel"):
                self._send(200, "text/html; charset=utf-8",
                           _slot_title((ROOT / "panel.html").read_bytes()))
            elif path == "/setup":
                # ONE SETUP PAGE for all the tables. A follower has nothing of its
                # own to declare, so it sends you to the leader rather than showing
                # a second page that looks like it would work.
                if not TABLES.is_leader():
                    self.send_response(302)
                    self.send_header("Location", f"http://127.0.0.1:{TABLES.leader_port()}/setup")
                    self.end_headers()
                else:
                    self._send(200, "text/html; charset=utf-8",
                               _slot_title((ROOT / "setup.html").read_bytes()))
            elif path == "/bridge":
                # between Start and the panel: window → sign-in → (Authy code, only if asked) → table
                self._send(200, "text/html; charset=utf-8",
                           (ROOT / "bridge.html").read_bytes())
            elif path == "/auth/snapshots":
                self._send(200, "application/json", json.dumps({"snapshots": A.snapshots()}).encode())
            elif path == "/update":              # packaged installs: is a newer release waiting?
                self._send(200, "application/json", json.dumps(_update_status("force=1" in (self.path.split("?", 1) + [""])[1])).encode())
            elif path == "/admin":               # CoinPoker: every open table and every panel, from one page
                self._send(200, "text/html; charset=utf-8", (ROOT / "admin.html").read_bytes())
            elif path == "/admin/state":
                self._send(200, "application/json", json.dumps(_admin_state()).encode())
            elif path == "/coinpoker/tables":    # the tables open in the client, for the setup page to attach one
                self._send(200, "application/json", json.dumps({
                    "tables": CP.open_tables(), "attached": CP.pinned, "client": CP.client_state()}).encode())
            elif path == "/formats":
                # every known format + what the client has open right now
                self._send(200, "application/json", json.dumps({
                    "formats": F.all_formats() + CPS.FORMATS, "stakes": F.data()["stakes"],
                    "detected": F.detect(CDP_PORT) if cdp.available(CDP_PORT) else None}).encode())
            elif path == "/auth/profiles":
                # every account, each with the money last seen in it — the dashboard's
                # Profiles view reads the same two facts from the same two stores
                profs = A.profiles()
                for pr in profs:
                    b = BAL.latest(pr["name"])
                    pr["balance"] = {"amountCents": b["amountCents"], "at": b["ts"], "source": b["source"]} if b else None
                self._send(200, "application/json", json.dumps({"profiles": profs}).encode())
            elif path == "/balance/probe":
                # Calibration + a manual read: scrape the lobby and say WHICH strategy
                # matched, or hand back the money-looking text so the selector can be
                # fixed in one pass against the real DOM. Records nothing.
                self._send(200, "application/json", json.dumps(BAL.scrape(CDP_PORT)).encode())
            elif path == "/balances":
                # same query style the rest of this handler uses (no urllib import here)
                q = (self.path.split("?", 1) + [""])[1]
                who = next((v.split("=", 1)[1] for v in q.split("&") if v.startswith("profile=")), None)
                who = __import__("urllib.parse", fromlist=["unquote"]).unquote(who) if who else None
                self._send(200, "application/json", json.dumps({"balances": BAL.history(who, 200)}).encode())
            elif path == "/auth/state":
                st = A.page_state(CDP_PORT) if not _fake_mode else {"state": "signed-in", "detail": "fake table"}
                st["routing"] = {k: _router[k] for k in ("state", "text", "steps", "at", "format", "seats")}
                self._send(200, "application/json", json.dumps(st).encode())
            elif path == "/table/state":
                st = F.window_state(CDP_PORT) if not _fake_mode else {"state": "signed-in", "cdp": True, "url": "faketable", "detected": None}
                st["routing"] = {k: _router[k] for k in ("state", "text", "steps", "at", "format", "seats")}
                self._send(200, "application/json", json.dumps(st).encode())
            elif path == "/format/detect":
                self._send(200, "application/json", json.dumps({
                    "detected": F.detect(CDP_PORT) if cdp.available(CDP_PORT) else None,
                    "cdp": cdp.available(CDP_PORT)}).encode())
            elif path == "/session/checks":
                self._send(200, "application/json", json.dumps(_session_checks()).encode())
            elif path == "/session":
                self._send(200, "application/json", json.dumps({
                    "ok": True, "current": _session["rec"], "brief": _session_brief(),
                    "presets": S.presets(refresh=True), "presetsFromApi": S.presets_from_api(), "catalogueError": S.presets_error(),
                    "fakeTable": _fake_mode,
                    "lastPreset": (_sessions.list(1) or [{}])[0].get("preset"),
                }).encode())
            elif path == "/sessions":
                self._send(200, "application/json", json.dumps({
                    "ok": True, "sessions": _sessions.list(50),
                    "open": (_leftovers() or [None])[0] if not _session["id"] else None,
                    # every abandoned session (this panel's live one and other live panels' excluded): the setup
                    # card ends ALL of them at once
                    "openAll": _leftovers(),
                }).encode())
            elif path == "/state":
                light = "light=1" in (self.path.split("?", 1) + [""])[1]
                self._send(200, "application/json",
                           json.dumps(state(light=light)).encode())
            elif path == "/layout/preview":
                # WHAT THE CLIENT WILL GET. There is ONE client window however
                # many tables are open — Ignition tiles its own tables inside it
                # — so the useful number is that window's size and what a tile of
                # it works out to, NOT a rectangle per table that we would place.
                # (This used to report a window per table, from the window model
                # that turned out to be wrong.)
                area = target_area()
                mons = [{**m, "scale": _dpi_at(m["x"] + 10, m["y"] + 10) / 96.0} for m in monitors()]
                counts = {}
                for n in TABLES.TABLE_COUNTS:
                    # the window is sized by the count too, so each row is what
                    # THAT choice actually gives a table — including the taskbar
                    # strip and the title bar at the counts that go fullscreen
                    rect = TABLES.client_rect(n, area)
                    if _want_fullscreen(n) and area.get("fw"):
                        rect = {**rect, "w": area["fw"], "h": area["fh"]}
                    w = TABLES.to_dip(rect, mons)
                    cols = 1 if n == 1 else 2
                    rows = 1 if n <= 2 else 2
                    # per table, and the window THAT choice gets — the page shows the
                    # row you are hovering, not the count this wrapper happens to be on
                    counts[str(n)] = {"w": w["w"] // cols, "h": w["h"] // rows,
                                      "winW": w["w"], "winH": w["h"],
                                      "fullscreen": _want_fullscreen(n)}
                win = TABLES.to_dip(TABLES.client_rect(TABLES.count(), area), mons)
                self._send(200, "application/json", json.dumps({
                    "ok": True, "counts": counts, "window": {"w": win["w"], "h": win["h"]},
                    "monitor": f"{area['w']}x{area['h']}" + ("" if area.get("primary") else " (the external screen)"),
                }).encode())
            elif path == "/table/presence":
                # "ARE YOU THERE, AND WHO ARE YOU?" — how every other wrapper
                # discovers this one (tables.probe). Local facts only: it must
                # never ask the peers anything itself, or four tables asking
                # each other at 1 Hz becomes a storm that answers nothing.
                self._send(200, "application/json",
                           json.dumps(TABLES.presence_record(PANEL_PORT, _session["id"])).encode())
            elif path == "/tables":
                # EVERY table's answer, collected by the leader (tables_overview)
                self._send(200, "application/json", json.dumps(tables_overview()).encode())
            elif path == "/table":
                self._send(200, "application/json", json.dumps(table_state()).encode())
            elif path == "/faketable":
                # Outer page: one iframe per table, each carrying playMode (how
                # the reader finds a table) and data-multitableslot (how it tells
                # them apart) — the real client's shape. ?tables=N, default 1.
                q = (self.path.split("?", 1) + [""])[1]
                want = next((v.split("=", 1)[1] for v in q.split("&") if v.startswith("tables=")), "1")
                try:
                    n = int(want)
                except ValueError:
                    n = 1
                self._send(200, "text/html; charset=utf-8",
                           faketable.render_outer("/faketable/frame?playMode=fun", n).encode())
            elif path == "/faketable/frame":
                q = (self.path.split("?", 1) + [""])[1]
                sl = next((v.split("=", 1)[1] for v in q.split("&") if v.startswith("slot=")), None)
                try:
                    sl = int(sl) if sl is not None else None
                except ValueError:
                    sl = None
                self._send(200, "text/html; charset=utf-8",
                           faketable.render_inner(_fake_spec_for(sl)).encode())
            elif path.startswith("/faketable/assets/"):
                # The replica's asset library: 104 card faces plus the five
                # SVGs harvested from the real client (card back, chip, dealer
                # button, watermark). Serving them here lets the fake table
                # draw the actual Ignition art instead of coloured boxes.
                rel = path[len("/faketable/assets/"):]
                got = faketable.asset(rel)
                if got:
                    self._send(200, got[1], got[0])
                else:
                    self._send(404, "text/plain", b"no asset")
            elif path == "/faketable/current":
                # The spec the fake table is showing right now. Lets the State
                # Tester BUILD OUT the current table (e.g. a Solve Audit row
                # that was just clicked onto it) instead of starting blank.
                self._send(200, "application/json",
                           json.dumps({"ok": True, "spec": _faketable_spec
                                       if _fake_mode else None}).encode())
            elif path == "/faketable/fixtures":
                # The suite's fixtures, served to the State Tester so authored
                # spots and regression cases are the same files.
                fdir = ROOT / "tests" / "fixtures"
                out = []
                for f in sorted(fdir.glob("*.json")):
                    try:
                        out.append({"file": f.name,
                                    "fixture": json.loads(f.read_text(encoding="utf-8"))})
                    except (OSError, json.JSONDecodeError):
                        pass
                self._send(200, "application/json",
                           json.dumps({"ok": True, "fixtures": out}).encode())
            elif path == "/sweep-report":
                # The postflop solve audit, generated by make_pf_report.py
                # into debug/ — a tool tab, so the results live where the
                # rest of the study surfaces do.
                rp = ROOT / "debug" / "postflop_sweep_report.html"
                if rp.exists():
                    self._send(200, "text/html; charset=utf-8", rp.read_bytes())
                else:
                    self._send(200, "text/html; charset=utf-8",
                               "<body style='background:#0d141c;color:#cfe0ef;font:14px system-ui;padding:2em'>no sweep report yet - run make_pf_report.py</body>".encode())
            elif path == "/tool":
                # The Study Tool's single window: the panel plus every
                # dashboard surface as tabs. The panel iframe is NEVER
                # unloaded — it is what polls for answers and speaks them, and
                # unloading it on a tab switch would silence the tool.
                self._send(200, "text/html; charset=utf-8",
                           _tool_shell().encode())
            elif path == "/faketable/lastclick":
                # What the relay actually pressed on the fake page — the
                # page records every button click into window.__lastClick.
                t = ignition_target()
                res = None
                if t and "/faketable" in (t.get("url") or ""):
                    try:
                        # The buttons live in the table frame, so the record is
                        # written there; read it from the frame rather than
                        # relying on it having propagated to the top window.
                        # THIS TABLE'S click log, not the first frame's. With
                        # four rig tables in one page, `document.querySelector
                        # ('iframe')` is slot 0 — so every follower asking what
                        # it had just pressed was handed TABLE 1's last click,
                        # and read `raiseButton` for every assertion no matter
                        # what it actually pressed (2026-09-20). Fourth instance
                        # of the same mistake: "the iframe" when there are four.
                        res = cdp._eval(t["webSocketDebuggerUrl"], _slotted("""(() => {__FRAME__
                            const f = __frame(__SLOT__) || document.querySelector('iframe');
                            let w = null; try { w = f && f.contentWindow; } catch (e) {}
                            return (w && w.__lastClick) || window.__lastClick || null;
                        })()""", TABLES.dom_slot()), timeout=4)
                    except Exception:
                        res = None
                self._send(200, "application/json",
                           json.dumps({"ok": True, "click": res}).encode())
            elif path == "/feed":
                self._send(200, "application/json",
                           json.dumps({"lines": _feed, "hand": _hand_no,
                                       "handIds": _hand_ids}).encode())
            elif path == "/hand":
                h = _hand_state()
                self._send(200, "application/json",
                           json.dumps({"ok": h is not None, "hand": h}).encode())
            elif path == "/history":
                self._send(200, "application/json", json.dumps(history()).encode())
            elif path == "/debug":
                self._send(200, "application/json", json.dumps(
                    {"on": _dbg["on"], "dir": _dbg["dir"],
                     "frames": _dbg["seq"]}).encode())
            elif path == "/ws-dump":
                q = (self.path.split("?", 1) + [""])[1]
                mm = re.search(r"n=(\d+)", q)
                n = min(int(mm.group(1)) if mm else 200, 3000)
                self._send(200, "application/json", json.dumps(
                    {"count": len(_ws_dump), "file": str(_WS_DUMP_PATH),
                     "lines": list(_ws_dump)[-n:]}, default=str).encode())
            elif path == "/recordings":
                self._send(200, "application/json", json.dumps(recordings()).encode())
            elif path.startswith("/rec/"):
                # /rec/<session>/log  |  /rec/<session>/frame/<n>.png
                parts = path.split("/")
                if len(parts) == 4 and parts[3] == "log":
                    self._send(200, "application/json",
                               json.dumps(rec_log(parts[2])).encode())
                elif len(parts) == 5 and parts[3] == "frame":
                    got = rec_frame(parts[2], int(re.sub(r"\D", "", parts[4]) or -1))
                    if got:
                        self._send(200, got[1], got[0])
                    else:
                        self._send(404, "text/plain", b"no frame")
                else:
                    self._send(404, "text/plain", b"not found")
            elif path == "/dom":
                self._send(200, "application/json", json.dumps(dom_dump()).encode())
            elif path == "/shot":
                png = shot()
                if png:
                    self._send(200, "image/png", png)
                else:
                    self._send(503, "text/plain", b"no table page yet")
            else:
                self._send(404, "text/plain", b"not found")
        except Exception as e:  # keep the skeleton unkillable by one bad request
            try:
                # JSON, not text: every page reads the reply with .json(), and a bare str(KeyError) such as
                # "'strategy:…'" surfaced as "Unexpected token … is not valid JSON" instead of the error
                self._send(500, "application/json", json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}).encode())
            except Exception:
                pass

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/act":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if body.get("kind") == "raise-to":
                    res = raise_to(str(body.get("amount", ""))[:12])
                else:
                    res = act(str(body.get("label", ""))[:32],
                              str(body.get("kind", "action"))[:12])
                print(f"[act] {body.get('label') or body.get('amount')!r} -> {res}")
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/quit":                # a new instance is taking over
                self._send(200, "application/json", b'{"ok": true}')
                threading.Thread(target=_stand_down, daemon=True).start()
            elif path == "/faketable/slot":       # set ONE slot's spot (render only)
                # The rig's per-table fixture. Body {slot, spec}. Render-only:
                # it does not touch _ws_state, so it is for exercising the
                # READER's scoping, not the hand pipeline.
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                sl = body.get("slot")
                if sl is None:
                    self._send(400, "application/json", b'{"ok": false, "error": "slot required"}')
                else:
                    _faketable_specs[int(sl)] = body.get("spec") or faketable.EXAMPLE_SPEC
                    self._send(200, "application/json",
                               json.dumps({"ok": True, "slot": int(sl),
                                           "slots": sorted(_faketable_specs)}).encode())
            elif path == "/faketable/spec":       # set the spot (render only)
                global _faketable_spec
                n = int(self.headers.get("Content-Length") or 0)
                _faketable_spec = json.loads(self.rfile.read(n) or b"{}")
                self._send(200, "application/json", b'{"ok": true}')
            elif path == "/faketable/load":       # full test mode: render + node
                n = int(self.headers.get("Content-Length") or 0)
                spec = json.loads(self.rfile.read(n) or b"{}")
                res = _faketable_load(spec)
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/faketable/stop":
                self._send(200, "application/json",
                           json.dumps(_faketable_stop()).encode())
            elif path == "/faketable/fixture":   # save an authored fixture
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                name = re.sub(r"[^a-z0-9-]", "-",
                              str(body.get("name") or "").lower()).strip("-")
                fx = body.get("fixture")
                if not name or not isinstance(fx, dict):
                    self._send(400, "application/json",
                               b'{"ok": false, "error": "name and fixture required"}')
                else:
                    fdir = ROOT / "tests" / "fixtures"
                    fdir.mkdir(parents=True, exist_ok=True)
                    p = fdir / f"{name}.json"
                    p.write_text(json.dumps(fx, indent=2, ensure_ascii=False) + "\n",
                                 encoding="utf-8")
                    print(f"[faketable] fixture saved: {p.name}")
                    self._send(200, "application/json",
                               json.dumps({"ok": True, "file": p.name}).encode())
            elif path == "/layout":
                res = apply_layout()
                print(f"[layout] -> {res}")
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/session/gtow-connect":
                # proxy to the study API: launch the session(s) with their debug
                # port and wait for a token (≤ ~60 s), then the page re-runs
                # preflight. An optional {"source": "primary"|"secondary"} targets
                # ONE session — the setup page sends it from the row you pressed.
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n) or b"{}") if n else {}
                    payload = json.dumps({"source": body["source"]} if body.get("source") in ("primary", "secondary") else {}).encode()
                    req = urllib.request.Request(f"{S.API}/api/dashboard/gtow-connect", data=payload,
                                                 headers={"Content-Type": "application/json"}, method="POST")
                    with urllib.request.urlopen(req, timeout=90) as r:
                        self._send(200, "application/json", r.read())
                except Exception as e:
                    self._send(200, "application/json", json.dumps({"ok": False, "connected": False,
                               "hint": f"the study API on {S.API} did not answer: {e}"}).encode())
            elif path == "/tables/close":
                # CLOSE A TABLE and stop the session asking for it back. Leader
                # only: it owns the seating loop, and that loop is the thing
                # being told to stand down.
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                try:
                    want = int(body.get("slot"))
                except (TypeError, ValueError):
                    want = 0
                if not TABLES.is_leader():
                    res = {"ok": False, "error": f"table {TABLES.slot()} does not run the session — close from table {TABLES.LEADER}"}
                elif not 1 <= want <= TABLES.MAX_TABLES:
                    res = {"ok": False, "error": "slot must be 1-4"}
                else:
                    res = _close_table(want, body.get("why") or "closed from the panel")
                self._send(200 if res.get("ok") else 409, "application/json", json.dumps(res).encode())
            elif path == "/table/stand-down":
                # This wrapper leaves its OWN table. Asked of it by the leader;
                # deferred to the end of the hand when hero is holding cards.
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                res = {"ok": True, "slot": TABLES.slot(),
                       "left": _stand_down_table(body.get("why") or "closed from the panel")}
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/auth/profiles":
                # create / update. The password goes straight to Credential Manager and is not echoed back.
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                try:
                    row = A.save_profile(body.get("name"), body.get("site") or "ignition", body.get("email"), body.get("password") or None,
                                         body.get("rememberMe", True) is not False, bool(body.get("trustDevice")))
                    self._send(200, "application/json", json.dumps({"ok": True, "profile": row}).encode())
                except Exception as e:
                    self._send(400, "application/json", json.dumps({"ok": False, "error": str(e)}).encode())
            elif path == "/auth/profiles/delete":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                self._send(200, "application/json", json.dumps({"ok": A.delete_profile(body.get("name") or "")}).encode())
            elif path == "/auth/login":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if not cdp.available(CDP_PORT):
                    res = {"ok": False, "error": "table window not up"}
                else:
                    _router["loginAt"] = time.time()
                    res = A.login(body.get("profile") or "", CDP_PORT)
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/auth/code":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                prof = A.get(body.get("profile") or ((_session["rec"] or {}).get("config") or {}).get("profile"))
                trust = body.get("trustDevice") if "trustDevice" in body else (prof or {}).get("trustDevice", False)
                res = A.submit_code(body.get("code") or "", CDP_PORT, trust_device=bool(trust)) if cdp.available(CDP_PORT) else {"ok": False, "error": "table window not up"}
                if res.get("ok") and _session["id"]:
                    _sessions.event(_session["id"], "code-accepted", {})
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/table/open":
                # the table window alone (no session) — for the go-to-er and tests
                threading.Thread(target=_open_table_window, daemon=True).start()
                self._send(200, "application/json", json.dumps({"ok": True}).encode())
            elif path == "/format/goto":
                # Drive the lobby to a format and take a seat. Synchronous (up to ~90 s):
                # the caller wants the step log and the detected table back.
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                fid = body.get("format")
                try:
                    buyin = float(body.get("buyinBb") or 100)
                except (TypeError, ValueError):
                    buyin = 100.0
                if not cdp.available(CDP_PORT):
                    res = {"ok": False, "error": f"table window not up (CDP :{CDP_PORT})"}
                else:
                    res = F.goto(fid, buyin, CDP_PORT, wait_for_bb=body.get("waitForBb", True) is not False)
                self._send(200 if res.get("ok") else 409, "application/json", json.dumps(res).encode())
            elif path == "/format/reseat":
                # "Re-seat in the declared format": the session's router leaves a wrong
                # table (if seated) and routes to the declared one. Asynchronous — the
                # panel's session card follows the router's state.
                cfg = ((_session["rec"] or {}).get("config") or {}) if _session["id"] else {}
                if not _session["id"]:
                    res = {"ok": False, "error": "no session"}
                elif not cfg.get("format"):
                    res = {"ok": False, "error": "the session declared no format"}
                elif not cdp.available(CDP_PORT):
                    res = {"ok": False, "error": f"table window not up (CDP :{CDP_PORT})"}
                else:
                    _router["reseat"] = True
                    _router_set("routing", f"re-seat requested: going to {(F.get(cfg['format']) or {}).get('name', cfg['format'])}", [])
                    res = {"ok": True}
                self._send(200 if res.get("ok") else 409, "application/json", json.dumps(res).encode())
            elif path == "/router/retry":
                # "Retry" on a failed bridge step (Brady, 2026-09-12): whatever stopped the router — a window that never
                # came, a sign-in error, a lobby run that did not reach the format, a table we left — push it back into
                # motion from where it is. Asynchronous; the bridge page follows the router's state. The auth gate's 45 s
                # hold-off is cleared so a sign-in retry happens at once; when signed in, the re-seat path leaves a wrong
                # table (if any) and routes to the declared format again.
                if not _session["id"]:
                    res = {"ok": False, "error": "no session"}
                else:
                    was = _router["state"]
                    seats = _router.get("seats") or {}
                    mid_seating = bool(seats.get("leader") and (seats.get("want") or 1) > 1
                                       and 0 < (seats.get("have") or 0) < (seats.get("want") or 1))
                    _router.update({"steps": [], "loginAt": 0.0, "snapState": None, "loginTries": 0})
                    if not cdp.available(CDP_PORT):
                        threading.Thread(target=_open_table_window, daemon=True).start()
                        _router_set("waiting-window", "retry: opening the table window", [])
                    elif mid_seating:
                        # RETRYING TABLE 3 OF 4 MUST NOT GIVE UP TABLE 1. The re-seat path
                        # leaves the table we are on, which is the right answer for a wrong
                        # table and the wrong one for a seat that did not take: the seating
                        # loop takes the next seat by itself, so this only clears the failure
                        # and lets it come round again now instead of after its back-off.
                        _router_set("seating", f"retry: taking seat {(seats.get('have') or 0) + 1} of {seats.get('want')} again", [])
                    else:
                        _router["reseat"] = True
                        _router_set("routing", f"retry requested (was: {was})", [])
                    if _session["id"]:
                        _sessions.event(_session["id"], "retry", {"was": was})
                    res = {"ok": True, "was": was}
                self._send(200 if res.get("ok") else 409, "application/json", json.dumps(res).encode())
            elif path == "/format/leave":
                res = F.leave(CDP_PORT) if cdp.available(CDP_PORT) else {"ok": False, "error": "table window not up"}
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/session/preflight":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                preset = body.get("preset") if body.get("preset") in S.PRESETS else next(iter(S.presets()))
                cfg = S.merged_config(preset, body.get("config"))
                self._send(200, "application/json",
                           json.dumps(_preflight(preset, cfg)).encode())
            elif path == "/session/start":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                code, res = _session_start(body)
                self._send(code, "application/json", json.dumps(res).encode())
            elif path == "/session/join":
                # leader -> follower: take up this session (never called by hand)
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                code, res = _session_join(body)
                self._send(code, "application/json", json.dumps(res).encode())
            elif path == "/session/leave":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                code, res = _session_leave(body)
                self._send(code, "application/json", json.dumps(res).encode())
            elif path == "/session/end":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                was_live = bool(_session["id"]) and (not body.get("id") or body.get("id") == _session["id"])
                res = _session_end(body)
                # the panel's End button also closes out (leave the table, close both windows)
                if body.get("closeOut") and res.get("ok") and was_live and not body.get("all"):
                    res["closeOut"] = _close_out_after_end((res.get("session") or {}).get("id") or "")
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/balance/seed":
                # SEED: the first equity reading for an account, and the only balance
                # write that is not part of a session. Scraped from the client, never
                # typed — a hand-entered anchor would make every later check a check
                # against a guess. Refused once a seed exists: after that the only
                # readings are the ones sessions take, and the math is checked against
                # each of them (gto-trainer profiles.ts).
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                prof = (body.get("profile") or "").strip()
                if not A.get(prof):
                    self._send(404, "application/json", json.dumps({"ok": False, "error": f"no profile {prof!r}"}).encode())
                elif BAL.latest(prof):
                    self._send(409, "application/json", json.dumps({"ok": False, "error": f"{prof} is already seeded", "seed": BAL.latest(prof)}).encode())
                else:
                    res = BAL.snapshot(prof, CDP_PORT, None, "seed")
                    if res.get("ok"):
                        print(f"[balance] {prof} seeded at {BAL.fmt(res['amountCents'])} cashier" + (f" + {BAL.fmt(res['inPlayCents'])} on the table" if res.get("inPlayCents") is not None else ""))
                    self._send(200 if res.get("ok") else 409, "application/json", json.dumps(res).encode())
            elif path == "/topup/probe":
                # what the auto top-up would see right now: stack, table max, the panel
                self._send(200, "application/json", json.dumps(_top_up_read()).encode())
            elif path == "/topup/test-second":
                # TEST A: two buys in one hand. Body {"cents": N} to name the amount.
                nb = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(nb) or b"{}")
                if not _topup_lock.acquire(blocking=False):
                    self._send(409, "application/json", json.dumps({"ok": False, "reason": "a top-up is already running"}).encode())
                else:
                    try:
                        self._send(200, "application/json", json.dumps(_top_up_probe_second(int(body.get("cents") or 0))).encode())
                    finally:
                        _topup_lock.release()
            elif path == "/topup/now":
                # run the presses once, regardless of hand state or cooldown (a test hook)
                if not _topup_lock.acquire(blocking=False):
                    self._send(409, "application/json", json.dumps({"ok": False, "reason": "a top-up is already running"}).encode())
                else:
                    try:
                        self._send(200, "application/json", json.dumps(_top_up_run(force=True)).encode())
                    finally:
                        _topup_lock.release()
            elif path == "/balance/reread":
                # RESET (2026-09-17): a fresh equity reading on demand, outside any session,
                # for an account that is already seeded. The dashboard's "mark the current
                # reading as correct" takes it first, so the baseline the acknowledged
                # residue restarts from is what the client shows NOW — not a stored reading
                # that may itself have been the wrong one. Scraped like every reading.
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                prof = (body.get("profile") or "").strip()
                if not A.get(prof):
                    self._send(404, "application/json", json.dumps({"ok": False, "error": f"no profile {prof!r}"}).encode())
                elif not BAL.latest(prof):
                    self._send(409, "application/json", json.dumps({"ok": False, "error": f"{prof} is not seeded yet — seed it first"}).encode())
                else:
                    res = BAL.snapshot(prof, CDP_PORT, _session["id"], "reset")
                    if res.get("ok"):
                        print(f"[balance] {prof} re-read at {BAL.fmt(res['amountCents'])} cashier" + (f" + {BAL.fmt(res['inPlayCents'])} on the table" if res.get("inPlayCents") is not None else ""))
                    self._send(200 if res.get("ok") else 409, "application/json", json.dumps(res).encode())
            elif path == "/session/resume":
                rec = _sessions.open_session()
                if rec:
                    _session.update({"id": rec["id"], "rec": rec, "started": rec["started_at"] / 1000})
                    _apply_session_config(rec["config"])
                    _sessions.event(rec["id"], "resumed")
                    _end_other_open(rec["id"], "ended: another session was resumed")
                    # A RESUMED SESSION IS STILL AS MANY TABLES AS IT DECLARED. The count
                    # lives in the environment, which a restarted leader does not inherit
                    # from the one that died — so without this the resume quietly became a
                    # single-table session: the client back to the 70% strip, the panel
                    # back beside it, and the tables the session is actually seated at
                    # left without a wrapper. The record is what the session declared.
                    try:
                        n_res = int(((rec.get("config") or {}).get("tables")) or 1)
                    except (TypeError, ValueError):
                        n_res = 1
                    if _is_cp():
                        # CoinPoker: no browser and no router — the client and its
                        # tables carry on by themselves; the log reader picks them up
                        CP.ensure_client()
                        threading.Thread(target=_open_leader, daemon=True).start()
                        n_res = 1
                    elif n_res > 1:
                        TABLES.adopt(n_res)
                    if not _is_cp():
                        _open_table_window()
                        _start_router(rec.get("config") or {}, rec["id"])
                    if n_res > 1:
                        # brings up any slot that is not running (idempotent — a table that
                        # is already up is probed and left alone) and re-places the windows
                        threading.Thread(target=_open_tables, args=(n_res,), daemon=True).start()
                self._send(200, "application/json", json.dumps({"ok": bool(rec), "session": rec}).encode())
            elif path == "/study-answers":       # the toggle (CONTRACT.md §3)
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                before = _study["on"]
                _study["on"] = bool(body.get("on"))
                # `mode` in the body is ignored: the strategy decides the piece.
                if not _study["on"]:
                    _study["text"] = None        # switch off = card goes blank now
                print(f"[study] answers {'ON' if _study['on'] else 'off'}")
                # A mid-session flip is a fact about the session — recorded,
                # never silently absorbed into "the mode".
                if _session["id"] and before != _study["on"]:
                    _sessions.event(_session["id"], "study-toggle",
                                    {"on": _study["on"], "hand": _hand_no})
                self._send(200, "application/json",
                           json.dumps({"ok": True, "on": _study["on"]}).encode())
            elif path == "/panel/answer":        # poller push (CONTRACT.md §2)
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                text = body.get("text")
                live = isinstance(text, str) and bool(text.strip())
                _study["text"] = text if live else None
                pick = body.get("pick")
                _study["pick"] = pick if live and isinstance(pick, str) else None
                _study["roll"] = body.get("roll") if live else None
                note = body.get("note")
                _study["note"] = note if live and isinstance(note, str) else None
                # the exported line's trust (CONTRACT §2): an uncertain line holds auto-execute
                unc = body.get("uncertain")
                _study["uncertain"] = unc if live and isinstance(unc, str) and unc else None
                # provenance: which strategy/chart answered and where the roll fell,
                # so review can show the LIVE pick with the same detail as NOW
                _study["prov"] = ({k: body.get(k) for k in
                                   ("band", "strategy", "source", "tier", "chart", "exploitPick", "chartPick")}
                                  if live else None)
                # the decision this pick was rolled for — what the pick-to-relay
                # path checks against the table before it acts (_pick_ready)
                dk = body.get("decisionKey")
                _study["decisionKey"] = dk if live and isinstance(dk, str) else None
                hid = body.get("handId")
                _study["handId"] = hid if live and isinstance(hid, int) else None
                _study["at"] = time.time()
                self._send(200, "application/json", json.dumps({"ok": True}).encode())
            elif path == "/update":              # packaged installs: run setup\update.ps1, then stand down
                code, res = _start_update()
                self._send(code, "application/json", json.dumps(res).encode())
            elif path == "/panel/open-window":   # a panel started with no window (from the leader): open it now
                if _panel_hwnd():
                    self._send(200, "application/json", b'{"ok": true, "already": true}')
                else:
                    area = target_area()
                    tw = int(area["w"] * TABLE_FRAC)
                    chrome_window(f"http://127.0.0.1:{PANEL_PORT}/panel", PROFILE_PANEL,
                                  area["x"] + tw, area["y"], area["w"] - tw, area["h"])
                    _cp_follow.update(snapped=None, rect=None)   # the follow loop puts it beside the table
                    self._send(200, "application/json", b'{"ok": true}')
            elif path in ("/coinpoker/attach", "/admin/attach", "/admin/open", "/admin/panel"):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
                if path == "/coinpoker/attach":          # this panel reads another table
                    code, res = _cp_reattach(body.get("room"))
                elif path == "/admin/open":              # a new panel on that table
                    code, res = _admin_open(str(body.get("room") or ""), body.get("preset") or None)
                else:
                    port = int(body.get("port") or 0)
                    if port not in ADMIN_PORTS:
                        code, res = 400, {"ok": False, "why": "not a panel port"}
                    elif path == "/admin/attach":        # move that panel to another table
                        code, res = (_cp_reattach(body.get("room")) if port == PANEL_PORT
                                     else _admin_post(port, "/coinpoker/attach", {"room": body.get("room")}))
                    else:                                # {port, action: snap | end}
                        # NOT named `act`: an assignment anywhere in do_POST makes the name local to all of it,
                        # and the /act route (the button press) calls the module's act() — that broke every press
                        what = body.get("action")
                        if what == "snap":
                            code, res = _admin_post(port, "/layout", {})
                        elif what == "end":
                            code, res = _admin_post(port, "/session/end", {"note": "ended from the admin page", "closeOut": True})
                        else:
                            code, res = 400, {"ok": False, "why": "action must be snap or end"}
                self._send(code, "application/json", json.dumps(res).encode())
            elif path == "/publish":             # OWNER (source checkout): open setup/publish.cmd in a console
                if _installed_version() is not None or not (_REPO / "setup" / "publish.cmd").exists():
                    self._send(409, "application/json", json.dumps({"ok": False, "why": "not the source checkout"}).encode())
                else:
                    subprocess.Popen(["cmd", "/c", "start", "Publish Poker Wrapper update", str(_REPO / "setup" / "publish.cmd")],
                                     cwd=str(_REPO), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    _owner_release["at"] = 0.0          # re-check after it runs
                    self._send(200, "application/json", json.dumps({"ok": True}).encode())
            elif path == "/sitout":              # CoinPoker: Sit Out Next Hand / Sit Out All
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
                if not _is_cp():
                    self._send(409, "application/json", json.dumps(
                        {"ok": False, "why": "sit-out is wired for CoinPoker sessions only"}).encode())
                else:
                    res = CP.sitout(bool(body.get("on", True)), bool(body.get("all")))
                    if _session["id"]:
                        _sessions.event(_session["id"], "sitout", {"on": body.get("on", True),
                                                                    "all": bool(body.get("all")), "ok": res.get("ok")})
                    self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/act/pick":            # the pick button / Enter on the panel
                self._send(200, "application/json", json.dumps(_execute_pick("press")).encode())
            elif path == "/study-auto":          # arm/disarm auto-execute
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                res = _set_auto(bool(body.get("auto")),
                                allow_real=bool(body.get("allowRealMoney")),
                                minutes=body.get("minutes") or 30,
                                hands=body.get("hands") or 50,
                                reason=body.get("reason"),
                                delay=body.get("delay"),
                                time_bank=(bool(body["timeBank"]) if "timeBank" in body else None),
                                top_up=(bool(body["topUp"]) if "topUp" in body else None))
                self._send(200 if res.get("ok") else 409, "application/json", json.dumps(res).encode())
            elif path == "/debug":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                res = set_debug(bool(body.get("on")))
                self._send(200, "application/json", json.dumps(res).encode())
            elif path == "/recnote":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                res = save_note(str(body.get("session", "")),
                                str(body.get("note", "")))
                self._send(200, "application/json", json.dumps(res).encode())
            else:
                self._send(404, "text/plain", b"not found")
        except Exception as e:
            try:
                # JSON, not text: every page reads the reply with .json(), and a bare str(KeyError) such as
                # "'strategy:…'" surfaced as "Unexpected token … is not valid JSON" instead of the error
                self._send(500, "application/json", json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}).encode())
            except Exception:
                pass


def _dpi_at(x: int, y: int) -> int:
    """DPI of the monitor containing the (physical) point; 96 when unknown."""
    try:
        pt = ctypes.wintypes.POINT(x, y)
        hmon = ctypes.windll.user32.MonitorFromPoint(pt, 2)  # MONITOR_DEFAULTTONEAREST
        dx, dy = ctypes.wintypes.UINT(), ctypes.wintypes.UINT()
        if ctypes.windll.shcore.GetDpiForMonitor(hmon, 0, ctypes.byref(dx), ctypes.byref(dy)) == 0:
            return int(dx.value) or 96
    except Exception:
        pass
    return 96


def _place_when_shown(proc: subprocess.Popen, x: int, y: int, w: int, h: int,
                      timeout: float = 20.0) -> None:
    """Pin a freshly launched browser window to (x, y, w, h) in PHYSICAL pixels.

    --window-position/--window-size are read by Chromium in logical (DIP)
    pixels, but this process is per-monitor DPI aware and measures monitors in
    physical pixels — on a 200% screen the flags land the window at twice the
    coordinates, off the right edge of every monitor (seen 2026-09-12: the
    setup window at x=5760 on a desktop that ends at 5440, visible only in the
    taskbar). MoveWindow from this process takes physical pixels, so once the
    window exists we move it where the flags were meant to put it."""
    proto = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    deadline = time.time() + timeout
    while time.time() < deadline:
        hit: list[int] = []

        def cb(hwnd, _lp):
            if not ctypes.windll.user32.IsWindowVisible(hwnd):
                return 1
            pid = ctypes.wintypes.DWORD()
            ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value == proc.pid and ctypes.windll.user32.GetWindowTextLengthW(hwnd):
                hit.append(hwnd)
            return 1

        ctypes.windll.user32.EnumWindows(proto(cb), 0)
        if hit:
            hwnd = hit[0]
            # a maximized window ignores MoveWindow; a MINIMIZED one takes the move
            # but stays in the taskbar (the table window sat minimized at -32000,
            # -32000 on 2026-09-12 — "I can't open the ignition client")
            if ctypes.windll.user32.IsZoomed(hwnd) or ctypes.windll.user32.IsIconic(hwnd):
                ctypes.windll.user32.ShowWindow(hwnd, 9)   # SW_RESTORE
            ctypes.windll.user32.MoveWindow(hwnd, x, y, w, h, True)
            r = ctypes.wintypes.RECT()
            ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(r))
            print(f"[layout] window pinned at ({r.left},{r.top}) {r.right - r.left}x{r.bottom - r.top} (physical px)")
            return
        time.sleep(0.25)
    print("[layout] window not found within the timeout — left where the flags put it")


def chrome_window(url: str, profile: str, x: int, y: int, w: int, h: int,
                  cdp_port: int | None = None) -> subprocess.Popen:
    """One app-mode (chromeless, PWA-style) Chrome window. Each window gets its
    own user-data-dir: that keeps it a separate process, which is what makes
    the --window-position/--window-size flags and the CDP port actually stick
    (a shared profile would just join the existing process and ignore them).

    x/y/w/h are PHYSICAL pixels (what monitors()/target_area() measure). The
    flags want logical pixels, so they get a DPI-scaled hint; the exact
    placement is then applied by handle (_place_when_shown)."""
    scale = _dpi_at(x, y) / 96.0
    lx, ly, lw, lh = (round(v / scale) for v in (x, y, w, h))
    args = [CHROME, f"--app={url}", f"--user-data-dir={ROOT / profile}",
            f"--window-position={lx},{ly}", f"--window-size={lw},{lh}",
            "--no-first-run", "--no-default-browser-check"]
    if cdp_port:
        args.insert(2, f"--remote-debugging-port={cdp_port}")
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    threading.Thread(target=_place_when_shown, args=(proc, x, y, w, h), daemon=True).start()
    return proc


def _server_alive() -> bool:
    """A live sibling instance answers /state — more reliable than bind races
    (Windows' SO_REUSEADDR semantics let two listeners share a port)."""
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{PANEL_PORT}/state", timeout=1.5):
            return True
    except Exception:
        return False


def _port_of(cmdline: list[str]) -> int:
    """The panel port another instance was launched on, from its own argv.

    Environment is not readable across processes, so the launcher passes
    --panel-port; an instance without one is a default (7700) instance.
    """
    for i, a in enumerate(cmdline):
        if a == "--panel-port" and i + 1 < len(cmdline):
            try:
                return int(cmdline[i + 1])
            except ValueError:
                return 7700
        if a.startswith("--panel-port="):
            try:
                return int(a.split("=", 1)[1])
            except ValueError:
                return 7700
    return 7700


def _sibling_pids() -> list[int]:
    """Live processes running THIS script, excluding us.

    Matched on the script path in the command line rather than on the port or
    a pid file: an instance that lost a bind race, or crashed before writing
    anything, still sits there running its own copy of this file — and that is
    exactly the stray that makes edits look like they did nothing. Two were
    found running for hours.

    The path match is deliberately narrow: the CoinPoker wrapper is a sibling
    script sharing this venv and must never be caught here.
    """
    try:
        import psutil
    except ImportError:
        return []
    me = os.getpid()
    here = str(Path(__file__).resolve()).lower()
    # Our own ancestors are never siblings. On Windows a venv's python.exe is
    # a REDIRECTOR: it spawns the base interpreter with the identical command
    # line and waits for it, so the scan below would find our parent — same
    # script path, same port — and terminate it. From a desktop icon that only
    # orphans us; under a scheduled task the action's root process (cmd) then
    # returns and Task Scheduler kills the whole tree, us included, before a
    # single line is logged. (Seen on the Vultr box, 2026-09-07.)
    try:
        ancestors = {a.pid for a in psutil.Process(me).parents()}
    except Exception:
        ancestors = {os.getppid()}
    out = []
    try:
        for p in psutil.process_iter(["pid", "name", "cmdline"]):
            if p.info["pid"] == me or p.info["pid"] in ancestors:
                continue
            # Interpreters only, and the EXACT absolute path only. Anything
            # looser is lethal in practice: a bare `launch.py` token inside a
            # shell's -Command string resolves against OUR cwd to this very
            # file, and terminating that shell kills our own parent — the
            # launcher silently dies with it (observed repeatedly as exit 15,
            # from tooling shim processes that are themselves python). The
            # desktop icon always passes the absolute path, which is the case
            # this exists for.
            if not (p.info.get("name") or "").lower().startswith("python"):
                continue
            cmd = p.info.get("cmdline") or []
            if not any(a.lower() == here for a in cmd):
                continue
            # Same script, DIFFERENT panel port, is a different rig — the test
            # instance and a real session run side by side on purpose, and
            # taking over by script path alone would have each one killing the
            # other on launch. The port is carried in argv precisely so this
            # check can see it.
            if _port_of(cmd) != PANEL_PORT:
                continue
            out.append(p.info["pid"])
    except Exception:
        return out
    return out


def _port_owner() -> int | None:
    """Pid of whatever LISTENS on the panel port, if it isn't us.

    Ground truth the command-line scan cannot provide: shells and tooling
    shims mention launch.py, but only a real wrapper instance holds the
    panel socket. This is what lets takeover work even on instances the
    scan cannot recognise (started via -c strings, odd interpreters, or
    older builds).
    """
    try:
        import psutil
    except ImportError:
        return None
    me = os.getpid()
    try:
        for c in psutil.net_connections("tcp"):
            if (c.status == "LISTEN" and c.laddr and c.laddr.port == PANEL_PORT
                    and c.pid and c.pid != me):
                return c.pid
    except Exception:
        pass
    return None


def _takeover() -> None:
    """Replace any previous instance rather than deferring to it.

    The icon is the only control the user has, so relaunching from it must be
    enough to pick up a new build. The old behaviour — spot a live sibling,
    ensure the windows are up, exit — left an instance started hours earlier
    serving its own stale copy of this file, invisible from the outside with
    no obvious way to stop it.

    Ask politely first so the hand in flight is archived, then terminate
    whatever is still standing.
    """
    if _server_alive():
        try:
            urllib.request.urlopen(urllib.request.Request(
                f"http://127.0.0.1:{PANEL_PORT}/quit", method="POST"), timeout=3)
            print("[panel] asked the running instance to stand down")
        except Exception:
            pass
        for _ in range(24):                      # ~6 s for a clean exit
            if not _server_alive():
                break
            time.sleep(0.25)

    # An instance that ignored /quit (an older build without the route, or a
    # wedged one) is found by what it cannot hide: the panel socket it holds.
    stale = set(_sibling_pids())
    if (owner := _port_owner()) is not None:
        stale.add(owner)
    if not stale:
        return
    try:
        import psutil
    except ImportError:
        return
    procs = []
    for pid in stale:
        try:
            p = psutil.Process(pid)
            p.terminate()
            procs.append(p)
        except Exception:
            pass
    gone, alive = psutil.wait_procs(procs, timeout=4)
    for p in alive:                              # wedged: no longer negotiable
        try:
            p.kill()
        except Exception:
            pass
    print(f"[panel] replaced previous instance(s): {sorted(stale)}")


def _tool_shell() -> str:
    """One window for the whole Study Tool.

    Tab 1 is the wrapper's own panel (same origin). The rest are study surfaces
    iframed from the API on :2000 — they used to live on the dashboard app's
    Vite server (:2100), which meant keeping a second node process alive purely
    to host three pages; they were rebuilt as plain pages on the API, which
    already served the data behind them. Each iframe loads on first open and
    stays alive after, so the review queue keeps its place and the panel keeps
    announcing answers from behind whichever tab is in front.

    The State Tester deliberately gets no ?wrapper= override: it defaults to the
    TEST rig (7701) whichever rig opened this shell, so the live rig's window
    can never push an authored spot onto a real table.
    """
    dash = "http://127.0.0.1:2000"
    tabs = [
        ("study", "Study Answers", f"http://127.0.0.1:{PANEL_PORT}/panel"),
        ("review", "Review Queue", f"{dash}/replay"),
        ("setup", "State Tester", f"{dash}/state-tester"),
        ("verify", "Reader Verify", f"{dash}/table"),
        ("audit", "Solve Audit", f"http://127.0.0.1:{PANEL_PORT}/sweep-report"),
    ]
    buttons = "".join(
        f"<button data-tab='{k}'>{label}</button>" for k, label, _ in tabs)
    frames = "".join(
        f"<iframe data-pane='{k}' data-src='{url}'></iframe>" for k, _, url in tabs)
    return f"""<!doctype html><html><head><meta charset=utf-8>
<title>{PANEL_TITLE}</title>
<style>
  html,body {{ margin:0; height:100%; background:#0d141c; color:#cfe0ef;
    font:13px system-ui,sans-serif; display:flex; flex-direction:column; }}
  nav {{ display:flex; gap:2px; padding:4px 6px 0; background:#0a0f15;
    border-bottom:1px solid #1d2833; flex:0 0 auto; }}
  nav button {{ font:inherit; border:1px solid #1d2833; border-bottom:none;
    background:#101823; color:#8fa1b6; padding:6px 14px; cursor:pointer;
    border-radius:6px 6px 0 0; }}
  nav button.on {{ background:#16212e; color:#fff; border-color:#2a3a4c; }}
  nav .hint {{ margin-left:auto; align-self:center; font-size:11px;
    color:#ffce56; padding-right:8px; display:none; }}
  main {{ flex:1; position:relative; }}
  iframe {{ position:absolute; inset:0; width:100%; height:100%; border:0;
    display:none; background:#0d141c; }}
  iframe.on {{ display:block; }}
</style></head><body>
<nav>{buttons}<span class="hint" id="hint">the API on :2000 is not running —
  these tabs need it (the launcher starts it; see study-tool.log)</span></nav>
<main>{frames}</main>
<script>
  const frames = [...document.querySelectorAll("iframe")];
  const btns = [...document.querySelectorAll("nav button")];
  function show(k) {{
    btns.forEach(b => b.classList.toggle("on", b.dataset.tab === k));
    frames.forEach(f => {{
      const on = f.dataset.pane === k;
      f.classList.toggle("on", on);
      if (on && !f.src) f.src = f.dataset.src;   // lazy, then persistent
      // Tabs stay alive behind each other, so a page cannot know it was
      // re-fronted — tell it. The State Tester re-pulls the fake table's
      // current spec on this, which is how an audit-row click that loaded a
      // NEW spot replaces the stale one it was still showing.
      if (on && f.src) {{
        try {{ f.contentWindow.postMessage({{ shown: k }}, "*"); }} catch (e) {{}}
      }}
    }});
  }}
  btns.forEach(b => b.onclick = () => show(b.dataset.tab));
  // Iframes can ask the shell to switch tabs (the Solve Audit does after
  // loading a clicked spot onto the fake table).
  window.addEventListener("message", e => {{
    if (e.data && typeof e.data.tab === "string") show(e.data.tab);
  }});
  show("study");
  // These tabs are dead without :2000 — say so instead of a blank pane.
  fetch("http://127.0.0.1:2000/", {{ mode: "no-cors" }})
    .catch(() => document.getElementById("hint").style.display = "inline");
</script>
</body></html>"""


def _faketable_load(spec: dict) -> dict:
    """Enter test mode with an authored state: store the spec, seed the
    WS-side hand state from its `node` section, and make sure a CDP-visible
    browser is showing the fake page.

    The WS tap is the authoritative source live; here there is no socket, so
    the node's history is written straight into _ws_state in the same units
    the tap uses (wire cents, bb = 100 so spec amounts are plain BB). The
    DOM-diff inference is frozen for the whole session — every fact of an
    authored state is authored, so anything the diff would add is by
    definition a phantom.
    """
    global _faketable_spec, _fake_mode, _hand_no, _action_grace_until
    _faketable_spec = spec
    # THE RIG'S FRAMES ARE ALL SERVED BY THE LEADER (one origin — see
    # faketable.render_outer), so a follower's fixture has to be written there or
    # its own frame would keep rendering whatever the leader last had.
    if TABLES.slot() is not None and not TABLES.is_leader():
        _peer_post(TABLES.leader_port(), "/faketable/slot",
                   {"slot": TABLES.dom_slot(), "spec": spec}, timeout=10)
    _fake_mode = True
    node = spec.get("node") or {}
    bb = 100

    def cents(v) -> int | None:
        return None if v is None else int(round(float(v) * bb))

    seats = spec.get("seats") or {}
    dealt = node.get("dealt") or sorted(
        int(k) for k, s in seats.items()
        if not (s or {}).get("empty") and (s or {}).get("cards"))
    acts = [{"seat": int(a["seat"]), "type": a["type"],
             "cents": cents(a.get("amount")),
             "street": a.get("street", "preflop")}
            for a in node.get("actions") or []]
    committed = {int(k): cents(v) or 0
                 for k, v in (node.get("committed") or {}).items()}
    hero = int(spec.get("heroSeat") or 1)

    _hand_no += 1
    _hand_ids[_hand_no] = str(node.get("clientHandId") or (9_000_000 + _hand_no))
    _ws_state.update({
        "bb": bb, "bbSeen": True,
        "dealt": [int(x) for x in dealt],
        "heroSeat": hero,
        "dealer": int(spec.get("dealerSeat") or hero),
        "board": [faketable.display_card(c) for c in spec.get("board") or []],
        "heroCards": [faketable.display_card(c) for c in spec.get("heroCards") or []],
        "actions": acts,
        "committed": committed,
        "maxBet": cents(node.get("maxBet")) or max(committed.values(), default=0),
        "actionOn": int(node.get("toActSeat") or hero),
        "potCents": cents(spec.get("potBB")),
        "heroFolded": False, "handOver": False, "endedSince": None,
        "actSeen": set(), "foldedSeats": set(), "domFolds": set(), "foldTicks": {},
        "domGraceUntil": time.time() + 1e9,
    })
    _action_grace_until = time.time() + 1e9

    # A browser for the page: reuse a /faketable tab on the CDP port, retarget
    # an existing CDP browser via DevTools' HTTP API, or launch the standard
    # table window at the fake URL if no CDP browser exists at all.
    url = f"http://127.0.0.1:{PANEL_PORT}/faketable"
    opened = "reused"
    # THIS SLOT'S WINDOW, not the first fake table on the port. With four tables
    # sharing one browser there are four /faketable pages, and taking the first
    # meant every follower's fixture load reloaded the LEADER's page: table 1
    # passed the state suite 15/15 while tables 2-4 sat frozen on a stale spot
    # and scored 8/15 (2026-09-20). ignition_target() honours the claim, which
    # is the whole point of claims — this is the one place that went around it.
    existing = ignition_target()
    if existing and "/faketable" not in (existing.get("url") or ""):
        existing = None                  # our window is not on the fake table yet
    if existing:
        # The page renders the spec at REQUEST time, so a tab already showing
        # a previous state must be reloaded or the test runs against the old
        # spot. Both documents are re-fetched (no-store defeats caching).
        try:
            # RELOAD ONLY THIS TABLE. The four rig frames share one page, so
            # location.reload() would yank the other three tables out from under
            # whoever is mid-hand on them — the multi-table equivalent of acting
            # on someone else's felt. Re-pointing the frame at its own src
            # re-fetches just this slot (the page renders the spec at request
            # time, so a re-fetch is what picks the new one up).
            me = TABLES.slot()
            # THROUGH THE RESOLVER, like every other "which frame is mine".
            # This was the last copy of the literal attribute lookup, and the
            # literal lookup is what left the leader frameless on a live client
            # whose tags did not start where we assumed (2026-09-21).
            js = ("location.reload(); true" if me is None else
                  _slotted("(() => {__FRAME__ const f = __frame(__SLOT__);"
                           " if (!f) return false; f.src = f.src; return true; })()",
                           TABLES.dom_slot()))
            cdp._eval(existing["webSocketDebuggerUrl"], js, timeout=4)
            time.sleep(1.2)
            opened = "reloaded"
        except Exception:
            pass
    if not existing:
        if cdp.available(CDP_PORT):
            import urllib.request as _rq
            for method in ("PUT", "GET"):
                try:
                    _rq.urlopen(_rq.Request(
                        f"http://127.0.0.1:{CDP_PORT}/json/new?{url}",
                        method=method), timeout=4)
                    opened = "new tab"
                    break
                except Exception:
                    continue
        else:
            area = target_area()
            chrome_window(url, ".profile-faketest", area["x"], area["y"],
                          int(area["w"] * TABLE_FRAC), area["h"], CDP_PORT)
            opened = "launched"
    print(f"[faketable] test mode ON — hand {_hand_no}, browser {opened}")
    return {"ok": True, "hand": _hand_no, "browser": opened}


def _faketable_stop() -> dict:
    """Leave test mode; live reading resumes untouched next hand."""
    global _fake_mode
    _fake_mode = False
    _ws_state["domGraceUntil"] = 0
    # The authored state is still what _hand_state() returns until the next
    # real deal resets it. _archive_hand skips it while _fake_mode is on, but
    # once off, the ended-hand grace / a table close / stand-down archived
    # it as a played hand (hands.db rows with the synthetic 9000xxx ids).
    # Mark it flushed so no trigger can.
    with _archive_lock:
        _last_archived["no"] = _hand_no
    print("[faketable] test mode off")
    return {"ok": True}


def _stand_down(why: str = "a new instance") -> None:
    """Archive the hand in flight, then go. Runs off the request thread so the
    /quit (or /session/end) response is delivered before the process ends.

    os._exit rather than srv.shutdown(): the main thread parks in a long sleep
    and the tap/feed threads are daemons, so a graceful shutdown would leave
    the process alive and the port held — the very thing being fixed.
    """
    time.sleep(0.2)
    try:
        _archive_hand()
    except Exception:
        pass
    # GIVE THE WINDOW BACK. A claim that is only left to expire keeps this slot
    # in the overview strip as a dead table for CLAIM_TTL_S, and keeps the next
    # wrapper that wants the window waiting for it. Releasing is what release()
    # is for; the TTL stays the safety net for a process that dies outright.
    try:
        me = TABLES.slot()
        if me is not None:
            TABLES.release(me)
    except Exception:
        pass
    print(f"[panel] standing down ({why})")
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(0)


def main() -> None:
    # Launching REPLACES whatever was running. Deferring to a live sibling is
    # what let an hours-old process keep serving stale code with the icon as
    # the user's only control.
    class _Srv(ThreadingHTTPServer):
        allow_reuse_address = False

    _takeover()

    # The mutex still guards the sub-second double-click: two icons clicked
    # together both find nothing to take over, and only this separates them.
    # Created AFTER the takeover, or we would race the instance we just asked
    # to exit.
    # Port-scoped: the single-instance guard is per RIG, not per machine. A
    # machine-wide name made the test instance defer to a running real session
    # and exit without ever serving.
    ctypes.windll.kernel32.CreateMutexW(
        None, False, f"IgnitionStudyPanelServer:{PANEL_PORT}")
    already = ctypes.windll.kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS

    srv = None
    if already:
        print("[panel] another launch is starting up — deferring to it")
    else:
        for _ in range(12):              # the dead listener releases the port
            try:                          # a moment after its process goes
                srv = _Srv(("127.0.0.1", PANEL_PORT), Handler)
                break
            except OSError:
                time.sleep(0.25)
        if srv is None:
            print(f"[panel] port :{PANEL_PORT} still held — reusing existing server")
    if srv:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        threading.Thread(target=_feed_loop, daemon=True).start()
        threading.Thread(target=_ws_tap, daemon=True).start()
        # CoinPoker's log reader: always tailing (a file read every 150 ms), so a
        # CoinPoker session has the table's state from its first second; its lines
        # and hands only reach the panel/archive while the session's site is CoinPoker
        CP.start(on_line=_cp_line, on_finished=_cp_finished)
        threading.Thread(target=_health_loop, daemon=True, name="health").start()
        threading.Thread(target=_panel_watch_loop, daemon=True, name="panel-watch").start()
        threading.Thread(target=_cp_follow_loop, daemon=True, name="cp-follow").start()
        threading.Thread(target=_chain_keeper, daemon=True).start()
        threading.Thread(target=_net_guard, daemon=True, name="net-guard").start()
        print(f"[panel] serving on http://127.0.0.1:{PANEL_PORT}/panel")

    # The external screen whenever one is attached (see target_area).
    area = target_area()
    w, h, ax, ay = area["w"], area["h"], area["x"], area["y"]
    table_w = int(w * TABLE_FRAC)
    # A session left open by a crashed/restarted wrapper is offered on the
    # setup page (resume or end); nothing is assumed.
    # The TABLE opens when a session is STARTED (see _open_table_window), not
    # here — with two exceptions that need no declaration: the test rig, and a
    # table window that is already up from before (never relaunch it).
    if _fake_mode or cdp.available(CDP_PORT):
        _open_table_window()

    if hwnd := _panel_hwnd():
        # A double-click must always DO something visible: surface the panel —
        # on the screen the mouse is on, restored if it was minimized.
        area = target_area()
        ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        if not (area["x"] <= (r := _window_rect(hwnd))[0] < area["x"] + area["w"]):
            table_up = _fake_mode or cdp.available(CDP_PORT)
            ctypes.windll.user32.MoveWindow(hwnd, area["x"] + (table_w if table_up else 0), area["y"],
                                            (w - table_w) if table_up else w, h, True)
        ctypes.windll.user32.SetForegroundWindow(hwnd)
        print("[panel] window already open — brought to front")
    elif os.environ.get("PANEL_DEFER_WINDOW") == "1":
        # started by the CoinPoker leader: no setup page — the leader starts the session and then asks for the
        # panel window (/panel/open-window), so the only window that ever appears is the panel itself
        print("[panel] no window yet — the leader opens it once the session runs")
    else:
        # A follower has no setup page of its own (it redirects to the leader's),
        # so opening one would give four windows all showing the leader's form.
        # It opens its PANEL instead: the table it is, and what it was told.
        side_url = (f"http://127.0.0.1:{PANEL_PORT}/tool" if _fake_mode
                    else f"http://127.0.0.1:{PANEL_PORT}/setup" if TABLES.is_leader()
                    else f"http://127.0.0.1:{PANEL_PORT}/panel")
        # No table yet (setup first): the panel takes the WHOLE target monitor
        # so the setup page has room; _open_table_window refits it to the side
        # strip the moment a session starts and the table opens.
        table_up = _fake_mode or cdp.available(CDP_PORT)
        me, n = TABLES.slot(), TABLES.count()
        if me is not None and n > 1:
            # several tables: the felt takes the table monitor, the panels take
            # the other one — each on its own cell, so four setup pages are four
            # windows you can actually see rather than a stack of one
            r = TABLES.panel_rect(me, n, area, other_area())
            chrome_window(side_url, PROFILE_PANEL, r["x"], r["y"], r["w"], r["h"])
            print(f"[panel] slot {me}/{n}: panel at ({r['x']},{r['y']}) {r['w']}x{r['h']} — {side_url}")
        elif table_up:
            chrome_window(side_url, PROFILE_PANEL, ax + table_w, ay, w - table_w, h)
            print(f"[panel] window beside table ({w - table_w}x{h}) at {side_url}")
        else:
            chrome_window(side_url, PROFILE_PANEL, ax, ay, w, h)
            print(f"[panel] setup window on the {'secondary' if not area['primary'] else 'primary'} monitor ({w}x{h}) at {side_url}")

    # A fresh test rig RENDERS a table (the page falls back to the example
    # spec) but had no hand behind it until something called /faketable/load,
    # so the panel showed cards, seats and a pending decision while /hand was
    # empty and Study Answers waited forever for a turn that had not been
    # dealt. Seed the same spot the page is already showing.
    if srv and _fake_mode:
        try:
            _faketable_load(_faketable_spec or faketable.EXAMPLE_SPEC)
        except Exception as e:
            print(f"[faketable] could not seed the opening spot: {e}")

    if not srv:
        return  # the running instance keeps serving; windows are ensured
    _main_tail()


def _open_table_window() -> None:
    """Open (or retarget) the table window — the Ignition lobby, or the fake
    table on the test rig. Idempotent: a window that is already up is reused,
    its URL corrected in place if it shows the other rig's table."""
    area = target_area()
    w, h, ax, ay = area["w"], area["h"], area["x"], area["y"]
    table_w = int(w * TABLE_FRAC)
    # In test mode the TABLE IS THE FAKE TABLE. Everything downstream reads it
    # exactly as it reads Ignition, so the layout, the panel and the answer
    # pipeline are the real ones being exercised — not a mock of them.
    table_url = (f"http://127.0.0.1:{PANEL_PORT}/faketable" if _fake_mode
                 else IGNITION_URL)
    # ONE WINDOW FOR EVERY TABLE (corrected 2026-09-20). This used to open ANOTHER
    # browser window for slots 2-4, from the belief that four tables meant four
    # windows. They do not: Ignition seats all four inside ONE page as tagged
    # iframes and tiles them itself. A follower opening a window would give it a
    # second client — a second lobby, its own login prompt — and nothing to read.
    # So only the leader ever opens the client; a follower waits for it.
    me = TABLES.slot()
    if me is not None and not TABLES.is_leader():
        if cdp.available(CDP_PORT):
            print(f"[table] slot {me}: reading table {me} in the client the leader opened")
        else:
            print(f"[table] slot {me}: waiting for table {TABLES.LEADER} to open the client")
        return
    if cdp.available(CDP_PORT):
        # Reusing the window is the point (a rerun must not spawn duplicates),
        # but reusing whatever URL happens to be in it is not: a rig that was
        # last used the other way round leaves a real table in the test rig's
        # window, or a fake one in the real rig's, and the reader believes it.
        # Correct the URL in place instead of relaunching the window.
        want_fake = _fake_mode
        for t in (cdp.page_targets(CDP_PORT) or []):
            url = t.get("url") or ""
            if url.startswith("devtools"):
                continue
            if ("/faketable" in url) != want_fake:
                try:
                    cdp._eval(t["webSocketDebuggerUrl"],
                              f"location.href = {json.dumps(table_url)}; true",
                              timeout=5)
                    print(f"[table] window was showing the other rig's table — "
                          f"sent it to {table_url}")
                except Exception as e:
                    print(f"[table] could not retarget the window: {e}")
            break
        print("[table] already open (CDP up) — not relaunching")
        # the panel had the whole monitor during setup — tuck it beside the table
        # here too, not only when the window is freshly launched
        threading.Timer(1.0, lambda: print(f"[layout] {apply_layout()}")).start()
    else:
        # the WHOLE table strip whatever the table count: one client window, and
        # the client tiles its tables inside it
        first = TABLES.client_rect(TABLES.count(), {"x": ax, "y": ay, "w": w, "h": h})
        chrome_window(table_url, PROFILE_TABLE, first["x"], first["y"], first["w"], first["h"], CDP_PORT)
        print(f"[table] {'fake' if _fake_mode else 'Ignition'} app window "
              f"{first['w']}x{first['h']} (CDP :{CDP_PORT})")
        # the panel had the whole monitor during setup — tuck it beside the table
        threading.Timer(2.5, lambda: print(f"[layout] {apply_layout()}")).start()
        for _ in range(40):  # wait for CDP before the reader starts polling
            if cdp.available(CDP_PORT):
                break
            time.sleep(0.5)
        print(f"[table] CDP {'up' if cdp.available(CDP_PORT) else 'NOT up (panel will keep retrying)'}")


# ---- Declared sessions (sessions.py) ---------------------------------------

# ---- the answer chain, kept connected for the session -------------------------
# A declared session with answers means "I want answers": the poller must be
# pointed at THIS wrapper and GTO Wizard must have a live token. Neither is a
# button any more — session start ensures both, and a keeper re-checks every
# 20 s and reconnects the client on its own (once per 2 min at most). The
# panel shows the same checklist the setup page's preflight uses.
_chain = {"attempting": False, "lastAt": 0.0, "lastResult": None, "lastCheck": None}


def _api_post(path: str, body: dict | None = None, timeout: float = 5.0) -> dict | None:
    try:
        data = json.dumps(body or {}).encode()
        req = urllib.request.Request(f"{S.API}{path}", data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _ensure_answer_chain(reason: str) -> None:
    """Point the poller here and get GTO Wizard connected — in the background,
    never twice at once, at most one launch attempt per two minutes."""
    # PANEL_PUBLIC_URL = what the API must call to reach THIS wrapper. Same-machine
    # runs use loopback; a remote box (deploy/winbox) advertises the Zenbook-side
    # end of its SSH tunnel instead (e.g. http://127.0.0.1:17700).
    public = os.environ.get("PANEL_PUBLIC_URL") or f"http://127.0.0.1:{PANEL_PORT}"
    r = _api_post("/api/study-poller/start", {"assistiveUrl": public})
    if not (r or {}).get("ok", True):
        print(f"[chain] poller start: {r}")
    reg = S.fetch_registry()
    g = ((reg or {}).get("armed") or {}).get("gtow") or {}
    # Two ways to be short-handed now that GTO Wizard is a POOL: no token at all,
    # or tokens but none on an account whose AI takes 3+ player trees (every
    # multiway spot then has no answer). Both are worth one connect attempt —
    # it is rate-limited below, and the API never restarts a client that is
    # sitting on its activation or sign-in screen.
    if g.get("tokenLive") and g.get("multiwayLive", True):
        return
    if _chain["attempting"] or time.time() - _chain["lastAt"] < 120:
        return

    def go():
        _chain.update({"attempting": True, "lastAt": time.time()})
        print(f"[chain] GTO Wizard {'has no multiway session' if g.get('tokenLive') else 'not connected'} ({reason}) — connecting")
        res = _api_post("/api/dashboard/gtow-connect", {}, timeout=95)
        _chain.update({"attempting": False, "lastResult": {"at": time.time(), "connected": bool((res or {}).get("connected")),
                                                            "text": (res or {}).get("text") or (res or {}).get("hint") or (res or {}).get("error")}})
        print(f"[chain] connect -> {_chain['lastResult']}")
    threading.Thread(target=go, daemon=True).start()


# ---- the table router: auth gate, then go to the declared format ------------
# The session declares a FORMAT (formats.json id), a buy-in and optionally a
# login PROFILE (auth.py). Starting it opens the table window; if that window
# is on the login page the router signs in from the profile (or waits for the
# human when there is none), waits for the human's Authy code when the site
# asks for one, then drives the lobby to the format and takes the seat. It
# keeps watching for the life of the session: a mid-session sign-out shows up
# in the checklist and the panel badge, and the gate runs again. State is on
# /session (brief.routing), /table/state and /auth/state.
_router = {"state": "idle", "text": "", "steps": [], "at": 0.0, "format": None, "thread": None, "cancel": False,
           "loginAt": 0.0,
           # HOW THE SEATS ARE GOING, for the pages: {"have": n, "want": n, "leader": bool}.
           # "table 2 of 4" is a sentence in `text`; this is the same thing as numbers, so the
           # bridge can draw one sub-step per table instead of parsing the sentence.
           "seats": None}
# The most tables this session has actually had open at once. A DROP from it is a
# table someone closed; a number below it that was never reached is a table still
# coming up. Without the distinction the two are the same reading.
_seating: dict = {"reached": 0}


def _honour_closed_tables(cfg: dict, seated_now: int) -> int:
    """How many tables to seat, having noticed any that were closed by hand.

    A TABLE THAT WENT AWAY AFTER WE HAD THEM ALL WAS CLOSED ON PURPOSE. The
    single-table router has always refused to re-seat a table the human left
    ("the human left it — do not re-seat them"); this is that rule at N tables,
    and without it closing a table by hand means the leader takes the seat
    straight back, every few seconds, for the rest of the session.

    The high-water mark is what makes the reading possible: a count BELOW a
    number we have never reached is a table still coming up, and a count below
    one we HAVE reached is a table that went away. Same number, opposite
    meanings, and only the history separates them."""
    want = _tables_wanted(cfg)
    reached = _seating.get("reached") or 0
    if not reached or seated_now >= reached:
        return want
    gone = reached - seated_now
    _seating["reached"] = seated_now
    for _ in range(gone):
        _closed_tables.add(_next_unclosed_slot(cfg))
    want = _tables_wanted(cfg)
    _feed_add(f"A table was closed — not re-seating it (the session now wants {want})")
    print(f"[tables] seated count fell to {seated_now}; honouring it, wanted is now {want}")
    if _session["id"]:
        _sessions.event(_session["id"], "table-closed", {"slot": None, "why": "closed by hand"})
    return want


def _next_unclosed_slot(cfg: dict) -> int:
    """The highest slot this session still counts as open — the one a drop in the
    seated count must mean, since tables are taken in order and given up from the
    end."""
    try:
        declared = int(cfg.get("tables") or 1)
    except (TypeError, ValueError):
        declared = 1
    closed = _tables_closed()
    for k in range(min(declared, TABLES.MAX_TABLES), 1, -1):
        if k not in closed:
            return k
    return declared


def _router_set(state: str, text: str, steps: list | None = None) -> None:
    changed = (state, text) != (_router["state"], _router["text"])
    _router.update({"state": state, "text": text, "at": time.time()})
    if steps is not None:
        _router["steps"] = list(steps)
    if changed:
        print(f"[router] {state}: {text}")


def _router_seats(have: int, want: int, leader: bool = True) -> None:
    """Record the seat count the pages draw the per-table steps from.

    ONLY THE LEADER COUNTS SEATS. A follower reads the same client page but never
    drives the lobby, so its "have" is not a reading of anything — it says so, and
    the bridge falls back to one step for the table it is watching."""
    _router["seats"] = {"have": max(0, int(have)), "want": max(1, int(want)), "leader": bool(leader)}


def _seat_next_table(fid, cfg: dict, want: int, fns=None) -> dict:
    """Take ONE more seat, if fewer than `want` tables are seated.

    Ignition seats up to four tables in this one client: you go back to the
    lobby and take another seat, and it adds a table and re-tiles them all. This
    is the leader's job alone — a follower driving the lobby would pull it out
    from under the page its siblings are reading.

    `fns` injects the three client calls so the ORCHESTRATION can be tested
    without a lobby to click (tests/test_seating.py): how many seats are taken,
    when to stop, and what a failure does are all decided here; what a Lobby
    button looks like is decided in formats.py."""
    f = fns or {"count": lambda: F.seated_slots(CDP_PORT),
                "to_lobby": lambda: F.to_lobby(CDP_PORT, log=lambda m: (_router["steps"].append(m.replace("[seat] ", "")), print(m))),
                # adding=True: we are seating table 2/3/4 FROM a seated table, which is
                # the only way Ignition does it. Without it `goto` applies the single-table
                # rule and refuses with the name of the table already open.
                "goto": lambda: F.goto(fid, float(cfg.get("buyinBb") or 100), CDP_PORT,
                                       wait_for_bb=cfg.get("waitForBb", True) is not False,
                                       adding=True,
                                       log=lambda m: (_router["steps"].append(m.replace("[goto] ", "")), print(m)))}
    have = f["count"]()
    if len(have) >= want:
        # `have` is a COUNT here, as it is on every other return: the caller compares
        # it with the high-water mark, and a list would raise there rather than seat.
        return {"done": True, "have": len(have)}
    seat = len(have) + 1
    # BEST EFFORT, NOT A GATE. `goto` drives the lobby through the DOM (.click()
    # on its own elements), which fires whether or not the lobby is the frame on
    # top — so failing the whole seating because a Lobby button could not be
    # found would refuse to do something that would probably have worked. It is
    # raised when it can be, and the attempt goes ahead either way.
    back = f["to_lobby"]()
    if not back.get("ok"):
        print(f"[seat] table {seat}: could not raise the lobby ({back.get('error')}) — trying the seat anyway")
    res = f["goto"]()
    now = f["count"]()
    if res.get("ok") and len(now) > len(have):
        return {"done": len(now) >= want, "ok": True, "have": len(now), "seat": seat,
                "detected": res.get("detected"),
                "text": f"table {len(now)} of {want} seated"}
    return {"done": False, "ok": False, "have": len(have), "seat": seat,
            "error": res.get("error") or "the seat did not take",
            "steps": res.get("steps"),
            "text": f"table {seat} of {want}: {res.get('error') or 'the seat did not take'}"}


def _route_session(cfg: dict, sid: str) -> None:
    """The session's table keeper: auth gate → route to the declared format →
    watch. Runs for the life of the session. Sign-in uses the session's
    PROFILE (auth.py) when it has one; the Authy code is always typed by the
    human (setup page / panel → POST /auth/code); a reCAPTCHA challenge is
    always solved by the human in the real window."""
    fid = cfg.get("format")
    profile = cfg.get("profile")
    if _fake_mode:
        _router_set("idle", "test rig — no routing")
        return
    f = F.get(fid) if fid else None
    if fid and not f:
        _router_set("failed", f"unknown format {fid}")
        return
    _router.update({"format": fid, "cancel": False, "loginAt": 0.0, "loginTries": 0})
    seated_by_us = False
    was_signed_out = False

    def alive() -> bool:
        return not _router["cancel"] and _session["id"] == sid

    while alive():
        # ---- 1. the auth gate: the window, then sign-in ----------------------
        st = F.window_state(CDP_PORT)
        if st["state"] == "closed":
            _router_set("waiting-window", "waiting for the table window")
            time.sleep(2)
            continue
        if st["state"] == "signed-out":
            was_signed_out = True
            a = A.page_state(CDP_PORT)
            # keep a redacted picture of every auth page we meet (login form, code box, error, captcha)
            if a["state"] in ("login-form", "code-form", "error", "captcha") and a["state"] != _router.get("snapState"):
                _router["snapState"] = a["state"]
                try:
                    A.snapshot(CDP_PORT, a["state"])
                except Exception as e:
                    print(f"[auth] snapshot: {e}")
            if a["state"] == "code-form":
                if _router["state"] != "waiting-code":
                    _sessions.event(sid, "code-needed", {})
                _router_set("waiting-code", "Authy code needed — type the 6 digits on the setup page or the panel")
            elif a["state"] == "captcha":
                _router_set("waiting-captcha", "reCAPTCHA challenge — solve it in the table window")
            elif a["state"] in ("login-form", "error") and profile and A.get(profile):
                # A FAILED SIGN-IN IS RETRIED QUICKLY, THREE TIMES (Brady, 2026-09-17): the site's generic "Error"
                # toast and a form that lost a field are transient; 15 s between tries, then it stays login-error
                # for the human (↻ Retry resets the count).
                tries = _router.get("loginTries", 0)
                if a["state"] == "error" and _router["loginAt"] and (time.time() - _router["loginAt"] < 15 or tries >= 3):
                    _router_set("login-error", f"sign-in as {profile} failed: {a['detail']}" + (" (3 attempts)" if tries >= 3 else ""))
                    time.sleep(5)
                elif tries >= 3 and _router["loginAt"]:
                    _router_set("login-error", f"sign-in as {profile} failed 3 times — press Retry after checking the window")
                    time.sleep(5)
                elif time.time() - _router["loginAt"] > 15:
                    _router_set("logging-in", f"signing in as {profile}" + (f" (attempt {tries + 1})" if tries else ""))
                    _router["loginAt"] = time.time()
                    _router["loginTries"] = tries + 1
                    res = A.login(profile, CDP_PORT, log=lambda m: (_router["steps"].append(m.replace("[auth] ", "")), print(m)))
                    _sessions.event(sid, "login", {"profile": profile, "ok": res.get("ok"), "state": res.get("state")})
                    if not res.get("ok"):
                        _router_set("login-error", res.get("error") or res.get("detail") or "sign-in failed")
            elif a["state"] == "error":
                _router_set("login-error", a["detail"])
            else:
                if _router["state"] != "waiting-signin":
                    _sessions.event(sid, "sign-in-needed", {"profile": profile})
                _router_set("waiting-signin", "table window is on the Ignition login page — no profile on this session, sign in there (e-mail, password, Authy)")
            time.sleep(2)
            continue
        if was_signed_out:
            was_signed_out = False
            _router["loginTries"] = 0
            _sessions.event(sid, "signed-in", {"profile": profile})
            _auto_open_balance(sid, profile, "after sign-in")
        _resume_recording_if_pending()

        # ---- 2. the table --------------------------------------------------
        if _router.get("reseat"):
            _router["reseat"] = False
            if st["state"] == "seated":
                _router_set("routing", "re-seat: leaving the current table", [])
                res = F.leave(CDP_PORT, log=lambda m: (_router["steps"].append(m.replace("[leave] ", "")), print(m)))
                _sessions.event(sid, "reseat", {"left": res.get("ok"), "was": st.get("detected")})
                if not res.get("ok"):
                    _router_set("failed", f"could not leave the table: {res.get('error') or 'unknown'}", res.get("steps"))
                    time.sleep(5)
                    continue
                time.sleep(2)
                continue          # next pass: signed in, no table → routes to the declared format
            _router_set("routing", "re-seat: no table open — routing", [])
            # fall through: signed in, no table, state 'routing' → the routing block below runs
        if st["state"] == "seated":
            _auto_open_balance(sid, profile, "seated")
            # ---- 2a. MORE TABLES, if the session asked for them --------------
            leader = TABLES.is_leader()
            seated_now = len(F.seated_slots(CDP_PORT)) if leader else 1
            want = _honour_closed_tables(cfg, seated_now) if leader else _tables_wanted(cfg)
            _router_seats(seated_now, want, leader)
            if want > 1 and leader:
                step = _seat_next_table(fid, cfg, want)
                _router_seats(step.get("have") or seated_now, want, leader)
                if step["done"]:
                    _seating["reached"] = max(_seating.get("reached") or 0, step.get("have") or want)
                    if _router["state"] == "seating":
                        _router_set("routing", f"all {want} tables seated", _router["steps"])
                        _sessions.event(sid, "tables-seated", {"tables": step["have"]})
                else:
                    _router_set("seating", step["text"], _router["steps"])
                    if step.get("ok"):
                        _sessions.event(sid, "seated", {"table": step["have"], "of": want,
                                                        "detected": step.get("detected")})
                    else:
                        _router_set("failed", step["text"], step.get("steps"))
                        _sessions.event(sid, "seat-failed", {"table": step["seat"], "error": step.get("error")})
                        time.sleep(10)
                    continue          # re-read the window and carry on
            v = F.compare(fid, st["detected"]) if fid else {"state": "undeclared", "text": st["detected"]["name"]}
            if _router["state"] not in ("done", "off-format"):
                _router_set("done" if v["state"] in ("ok", "undeclared") else "off-format",
                            f"seated: {st['detected']['name']} — {v['text']}")
                _sessions.event(sid, "routed", {"format": fid, "seated": st["detected"], "verdict": v, "byRouter": seated_by_us})
                seated_by_us = False
            time.sleep(5)
            continue
        # signed in, no table
        if not fid:
            _router_set("idle", "signed in · no format declared, nothing to route to")
            time.sleep(5)
            continue
        if _router["state"] in ("done", "off-format"):
            # the table went away while signed in: the human left it — do not re-seat them
            _router_set("left", f"table closed — not re-seating (declared {f['name']})")
            time.sleep(5)
            continue
        if _router["state"] in ("left", "failed"):
            time.sleep(5)
            continue
        _router_seats(0, _tables_wanted(cfg), TABLES.is_leader())
        _router_set("routing", f"going to {f['name']} · buy-in {cfg.get('buyinBb', 100)} bb", [])
        res = F.goto(fid, float(cfg.get("buyinBb") or 100), CDP_PORT, wait_for_bb=cfg.get("waitForBb", True) is not False,
                     log=lambda m: (_router["steps"].append(m.replace("[goto] ", "")), print(m)))
        if res.get("ok"):
            seated_by_us = True
            _router_seats(1, _tables_wanted(cfg), TABLES.is_leader())
            v = res.get("verdict") or {}
            _router_set("done" if v.get("state") == "ok" else "off-format", v.get("text") or "seated", res.get("steps"))
            _sessions.event(sid, "routed", {"format": fid, "seated": res.get("detected"), "verdict": v, "byRouter": True})
        elif res.get("stakeMissing"):
            # the declared stake has no running table: not a failure - wait a minute and look again (the modal was
            # closed by goto; the next pass walks the wizard afresh)
            _router_set("waiting-stake", f"{res.get('error')} — checking again in 60 s", res.get("steps"))
            for _ in range(60):
                if not alive():
                    break
                time.sleep(1)
            continue
        elif res.get("signedOut"):
            # the lobby run found the sign-in form: not a failure, the auth gate's job - straight back to the top of
            # the loop, where window_state now reads the form and the profile signs in (Brady, 2026-09-17)
            _router_set("routing", "signed out on the way to the lobby — signing in first", res.get("steps"))
            _router["loginAt"] = 0.0
            continue
        else:
            _router_set("failed", res.get("error") or "routing failed", res.get("steps"))
            _sessions.event(sid, "route-failed", {"format": fid, "error": res.get("error"), "steps": res.get("steps")})
    _router_set("cancelled" if _router["cancel"] else "idle", "session ended")


def _start_router(cfg: dict, sid: str) -> None:
    _router["cancel"] = True
    time.sleep(0.1)
    t = threading.Thread(target=_route_session, args=(cfg, sid), daemon=True)
    _router["thread"] = t
    t.start()


# Recording never starts on a signed-out window (no frame of the login page
# is ever captured): it is deferred until the router sees the lobby.
_rec_pending = {"on": False}


def _resume_recording_if_pending() -> None:
    if _rec_pending["on"]:
        _rec_pending["on"] = False
        set_debug(True)


def _chain_keeper() -> None:
    while True:
        time.sleep(20)
        try:
            rec = _session["rec"]
            if rec and (rec.get("config") or {}).get("answers"):
                _ensure_answer_chain("keeper")
        except Exception as e:
            print(f"[chain] keeper: {e}")


def _session_checks() -> dict:
    """The live checklist for the panel: the session's own preflight, re-run
    now, plus the keeper's state. Without a session: the same checks, none
    required, so the panel still shows what is up."""
    rec = _session["rec"]
    registry = S.fetch_registry()
    presets = S.presets()
    if rec and rec.get("preset") in presets:
        preset, cfg = rec["preset"], rec.get("config") or {}
    else:
        preset = next(iter(presets))
        cfg = {"answers": False, "sources": {}, "recording": False, "budget": {}}
    if cfg.get("site") == CPS.SITE:
        # CoinPoker: the client, its log and the table it is following ARE the link —
        # there is no table window, sign-in or lobby format to check
        pf = _preflight(preset, cfg, registry)
        t = CP.table()
        if t and rec:
            for c in pf["checks"]:
                if c["id"] == "cp-table":
                    c["required"] = bool(cfg.get("answers"))
        _chain["lastCheck"] = time.time()
        return {"ok": pf["ok"], "checks": pf["checks"], "blockers": pf["blockers"], "checkedAt": int(time.time() * 1000),
                "preset": rec.get("preset") if rec else None,
                "session": _session_brief(), "chain": {"attempting": _chain["attempting"], "lastResult": _chain["lastResult"]}}
    pf = S.run_preflight(preset, cfg, _fake_mode, registry, CDP_PORT)
    # The table link is one more row of the same list (Brady: one place that
    # answers "is everything connected"). Required while a session with
    # answers is running — no table page means nothing to answer.
    cdp_up = cdp.available(CDP_PORT)
    tgt = ignition_target() if cdp_up else None
    table = {"id": "table", "label": "Table window linked (CDP)", "required": bool(rec and cfg.get("answers")), "ok": bool(tgt),
             "detail": (f"{(tgt.get('title') or 'table page')} · CDP :{CDP_PORT}" if tgt
                        else f"CDP :{CDP_PORT} up, no table page yet" if cdp_up
                        else "no table window — it opens when a session starts")}
    ws_state = F.window_state(CDP_PORT) if not _fake_mode else {"state": "signed-in", "detected": None}
    signin = {"id": "signin", "label": "Table window signed in", "required": bool(rec and not _fake_mode),
              "ok": ws_state["state"] in ("signed-in", "seated"),
              "detail": {"closed": "no table window", "signed-out": f"Ignition login page · {_router['text'] or 'waiting'}",
                         "signed-in": "lobby up", "seated": f"seated: {(ws_state.get('detected') or {}).get('name')}"}.get(ws_state["state"], ws_state["state"])}
    fid = cfg.get("format")
    verdict = F.compare(fid, ws_state.get("detected")) if fid else None
    fmt = {"id": "format", "label": "Table format matches the declaration", "required": False,
           "ok": bool(verdict) and verdict["state"] in ("ok", "unknown"),
           "detail": (verdict["text"] if verdict else "no format declared") + (f" · router: {_router['text']}" if _router["state"] not in ("idle", "done") else "")}
    checks = [table, signin] + ([fmt] if fid else []) + pf["checks"]
    blockers = [c["label"] for c in checks if c["required"] and not c["ok"]]
    _chain["lastCheck"] = time.time()
    return {"ok": not blockers, "checks": checks, "blockers": blockers, "checkedAt": int(time.time() * 1000),
            "preset": rec.get("preset") if rec else None,
            "session": _session_brief(), "chain": {"attempting": _chain["attempting"], "lastResult": _chain["lastResult"]}}


def _session_brief() -> dict | None:
    """What /state carries every second: enough for the panel's session card
    and the answer poller's provenance, without the JSON columns."""
    rec = _session["rec"]
    if not rec:
        return None
    cfg = rec.get("config") or {}
    budget = cfg.get("budget") or {}
    elapsed_min = (time.time() - _session["started"]) / 60 if _session["started"] else 0
    hands = _session_hands(rec["id"])
    fid = cfg.get("format")
    if cfg.get("site") == CPS.SITE:
        # a CoinPoker format is a label (you pick the table in the client): the verdict
        # says which table the log is following and whether it is practice chips
        t = CP.table()
        cpf = next((f for f in CPS.FORMATS if f["id"] == fid), None)
        observed = {"name": t["room"], "practice": t["practice"], "coinType": t["coinType"]} if t else None
        verdict = ({"state": "ok", "text": f"at {t['room']} ({'practice chips' if t['practice'] else 'real money'})"} if t
                   else {"state": "unknown", "text": "no CoinPoker table open yet — sit down in the client"})
    else:
        cpf = None
        observed = F.detect(CDP_PORT) if (not _fake_mode and cdp.available(CDP_PORT)) else None
        verdict = F.compare(fid, observed) if fid else None
    prof = cfg.get("profile")
    bal = BAL.latest(prof) if prof else None
    return {"id": rec["id"], "preset": rec.get("preset"), "label": rec.get("label"),
            "strategy": cfg.get("strategy"), "strategyName": cfg.get("strategyName"),
            "profile": prof,
            "balance": ({"amountCents": bal["amountCents"], "at": bal["ts"], "phase": bal["phase"], "source": bal["source"]} if bal else None),
            "format": fid, "formatName": (cpf or F.get(fid) or {}).get("name"), "buyinBb": cfg.get("buyinBb"),
            # a TEST-STAKE format (formats.json `test`): the strategy's own answers on a cheaper real table
            "testOf": ((F.get(fid) or {}).get("testOf") if (F.get(fid) or {}).get("test") else None),
            "testOfName": ((F.get((F.get(fid) or {}).get("testOf")) or {}).get("name") if (F.get(fid) or {}).get("test") else None),
            "site": cfg.get("site") or "ignition",
            "observed": observed, "verdict": verdict,
            "profile": cfg.get("profile"),
            "routing": {k: _router[k] for k in ("state", "text", "steps", "at", "seats")},
            "answers": cfg.get("answers"), "recording": cfg.get("recording"),
            "startedAt": rec.get("started_at"), "elapsedMin": round(elapsed_min, 1), "hands": hands,
            "budget": budget,
            "budgetHit": bool((budget.get("hands") and hands >= budget["hands"]) or
                              (budget.get("minutes") and elapsed_min >= budget["minutes"]))}


_hands_cache = {"id": None, "at": 0.0, "n": 0}


def _session_hands(sid: str) -> int:
    """Archived hands stamped with this session (cached 5 s — /state is polled at 1 Hz)."""
    now = time.time()
    if _hands_cache["id"] == sid and now - _hands_cache["at"] < 5:
        return _hands_cache["n"]
    n = 0
    try:
        c = _db()
        try:
            n = c.execute("SELECT COUNT(*) FROM hands WHERE json_extract(data, '$.sessionId') = ?", (sid,)).fetchone()[0]
        finally:
            c.close()
    except Exception:
        pass
    _hands_cache.update({"id": sid, "at": now, "n": n})
    return n


def _apply_session_config(cfg: dict) -> None:
    _SITE["id"] = CPS.SITE if cfg.get("site") == CPS.SITE else "ignition"
    # CoinPoker: read the table the setup page attached (None = follow the most recently active table)
    CP.attach(cfg.get("cpTable") if cfg.get("site") == CPS.SITE else None)
    _study["on"] = bool(cfg.get("answers"))
    _study["text"] = None
    # auto-execute (and any real-money allowance) is armed per session, never inherited
    _study.update({"auto": False, "executed": None, "autoTried": None, "lastExec": None, "autoDue": None,
                   "autoDelay": cfg.get("autoDelay") if cfg.get("autoDelay") in ("instant", "random") else "instant",
                   "timeBank": bool(cfg.get("autoTimeBank", True)), "timeBankAt": 0.0, "lastTimeBank": None,
                   "topUp": bool(cfg.get("autoTopUp", True)), "topUpAt": 0.0, "topUpHand": None, "lastTopUp": None,
                   "topUpDue": None, "topUpTrigger": None, "stackStable": {"text": None, "ticks": 0},
                   "autoRealUntil": 0.0, "autoRealHands": 0, "autoRealFrom": None, "autoRealReason": None})
    # the short-hand scoreboard is per session, like everything else here
    _topup_kpi.update({"hand": None, "hands": 0, "short": 0, "worstBb": 0.0})
    _topup_panel["open"] = False
    _topup_abort.clear()
    # DECLARED auto-execute (setup page, config.autoExecute). The declaration is
    # an INTENT, not a bypass: it is applied here, and _set_auto still decides
    # whether the table in front of us allows it. At session start there is
    # usually no table yet, so a real-money session declared with autoRealMoney
    # gets its bounded allowance now (it was declared in writing, before
    # anything opened, and it is in the session record) while one declared
    # WITHOUT it simply arms as soon as a practice table appears. Either way the
    # panel's toggle flips it live afterwards.
    _study["autoDeclared"] = bool(cfg.get("autoExecute"))
    _study["autoDeclaredReal"] = bool(cfg.get("autoRealMoney"))
    _study["autoDeclaredBudget"] = dict(cfg.get("autoBudget") or {"minutes": 30, "hands": 50})
    if _study["autoDeclared"]:
        b = _study["autoDeclaredBudget"]
        res = _set_auto(True, allow_real=_study["autoDeclaredReal"],
                        minutes=b.get("minutes") or 30, hands=b.get("hands") or 50,
                        reason="declared at session setup")
        if not res.get("ok"):
            # e.g. declared for a real-money table without the real-money box:
            # stays pending, and _maybe_auto_arm picks it up when a practice
            # table appears. The panel says which.
            print(f"[pick] declared auto not armed yet: {res.get('error')}")
    if _is_cp():
        # the debug recorder frames the Ignition browser; a Unity table has no page
        # to record, and the log already keeps every message
        _rec_pending["on"] = False
        set_debug(False)
    elif cfg.get("recording") and not _fake_mode and F.window_state(CDP_PORT)["state"] in ("closed", "signed-out"):
        _rec_pending["on"] = True       # starts once the window shows the lobby (router)
        set_debug(False)
    else:
        _rec_pending["on"] = False
        set_debug(bool(cfg.get("recording")))


def _clear_table_cache() -> None:
    """The setup page's "clear its cache" box (Brady, 2026-09-17): wipe the table window's HTTP / script /
    service-worker caches before the session opens it - never cookies or storage, so the sign-in survives. With
    the window already up this goes through CDP; otherwise the profile's cache folders are removed on disk."""
    if _fake_mode:
        return
    if cdp.available(CDP_PORT):
        n = 0
        for t in (cdp.page_targets(CDP_PORT) or []):
            if not t.get("webSocketDebuggerUrl") or (t.get("url") or "").startswith("devtools"):
                continue
            try:
                A._cmds(t["webSocketDebuggerUrl"], [("Network.enable", {}), ("Network.clearBrowserCache", {}), ("Network.disable", {})], timeout=10)
                n += 1
            except Exception as e:
                print(f"[table] cache clear via CDP failed: {e}")
        print(f"[table] browser cache cleared via CDP on {n} page(s)")
        return
    prof = ROOT / PROFILE_TABLE / "Default"
    removed = []
    for rel in ("Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache", "DawnCache"):
        d = prof / rel
        if d.exists():
            try:
                shutil.rmtree(d)
                removed.append(rel)
            except OSError as e:
                print(f"[table] could not remove {rel}: {e}")
    print(f"[table] browser cache folders removed: {removed or 'none present'}")


def _auto_open_balance(sid: str | None, profile: str | None, where: str) -> None:
    """Record the session's OPENING balance the moment it can be read - at start if the client is already on the
    lobby, else right after the router signs in or seats - and only once per session. A fresh profile's first
    reading IS its seed: nothing to seed by hand any more (Brady, 2026-09-17). The preflight no longer gates on it."""
    if _fake_mode or not sid or not profile:
        return
    rec = _sessions.get(sid) or {}
    if any(e.get("kind") == "balance" and e.get("phase") == "open" for e in (rec.get("events") or [])):
        return
    fresh = BAL.latest(profile) is None
    snap = BAL.snapshot(profile, CDP_PORT, sid, "open")
    if snap.get("ok"):
        _sessions.event(sid, "balance", {"phase": "open", "amountCents": snap["amountCents"], "how": snap.get("how"), "where": where, "seed": fresh})
        print(f"[balance] {profile} opens at {BAL.fmt(snap['amountCents'])} ({where}{'; first reading for this profile = its seed' if fresh else ''})")
    else:
        _sessions.event(sid, "balance-missed", {"phase": "open", "reason": snap.get("reason"), "where": where})
        print(f"[balance] no opening balance yet ({where}): {snap.get('reason')} - retried after sign-in / seating")


# ---- one session, several tables --------------------------------------------
#
# Brady declares a session ONCE, on the leader's setup page, and every other live
# table joins it. Until 2026-09-20 each wrapper declared its own, which gave four
# open rows in sessions.sqlite for one sitting, four opening balance readings on
# one account, and a dashboard that saw four sessions of sixty hands instead of
# one of two hundred and forty.
#
# A follower NEVER writes a session record, never takes a balance reading and
# never ends anything: it adopts the leader's id, stamps its hands with its own
# slot, and hands the record back when it leaves. The money readings belong to
# the ACCOUNT, and the account is one whatever the table count is.

# ---- opening the tables the session asked for --------------------------------
#
# The COUNT is a session decision, made on the setup page (config `tables`,
# 1 / 2 / 4), not a command-line argument: you choose how many tables you want
# the way you choose the format and the buy-in, and pressing Start opens them.
#
# The extra tables are separate PROCESSES of this same wrapper (see tables.py
# for why), spawned here. Each one joins the session it was opened for, claims
# its own window on the browser this process already owns, and tiles itself.
# `run-tables.pyw` still works and does the same thing up front — it is the way
# to bring tables up without declaring a session, which the test rig wants.

# The interpreter a spawned table runs under. pythonw so it opens no console of
# its own; the venv's, because that is where the wrapper's dependencies are.
VENV_PYW = ROOT.parent / "aof-model" / ".venv" / "Scripts" / "pythonw.exe"


def _slot_panel_port(slot_n: int) -> int:
    return TABLES.panel_port(slot_n)


def _slot_up(slot_n: int, timeout: float = 1.5) -> bool:
    """Is slot `slot_n` up — and is it really that slot, on this rig?

    Takes the SLOT, not a port, and asks `/table/presence` rather than `/state`.
    Two reasons, both learned the hard way. A port is not an identity: the test
    rig serves these same four ports, so "something answered :7710" was never
    the question. And `/state?light=1` builds the whole panel payload (every
    seat, the reconciler's health, the last exec) to answer a yes/no — on the
    path that spawns tables, four times."""
    return TABLES.probe(slot_n, timeout) is not None


def _spawn_slot(slot_n: int, n: int) -> dict:
    """Start table `slot_n` of `n`, unless it is already up."""
    port = _slot_panel_port(slot_n)
    if _slot_up(slot_n):
        return {"slot": slot_n, "panelPort": port, "ok": True, "already": True}
    env = dict(os.environ)
    env["TABLE_SLOT"] = str(slot_n)
    env["TABLE_COUNT"] = str(n)
    env["PANEL_PORT"] = str(port)
    # EVERY SLOT SHARES ONE CDP PORT: the browser is one process (one profile,
    # one login) with a window per table, so there is one debugger for all of
    # them and each wrapper picks its own window out by its claim.
    env["CDP_PORT"] = str(CDP_PORT)
    if _fake_mode:
        env["FAKE_TABLE"] = "1"
    exe = str(VENV_PYW) if VENV_PYW.exists() else sys.executable
    try:
        subprocess.Popen([exe, str(ROOT / "run-study.pyw")], env=env, cwd=str(ROOT),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return {"slot": slot_n, "panelPort": port, "ok": False, "error": f"could not start: {e}"}
    for _ in range(120):                       # it has a browser window to open
        time.sleep(0.5)
        if _slot_up(slot_n):
            return {"slot": slot_n, "panelPort": port, "ok": True}
    return {"slot": slot_n, "panelPort": port, "ok": False, "error": "did not come up within 60 s"}


# ---- tables the session has given up on ---------------------------------------
#
# CLOSING A TABLE HAS TO STICK. The router seats another table whenever the
# client shows fewer than the session declared, which is right while the session
# is coming up and wrong the moment a table is closed on purpose: close table 2
# and the leader takes the seat straight back, so the only way to end up with one
# table was to end the session. A closed slot is recorded here AND in the session
# record (so a leader restarted mid-session does not undo it), and the seating
# loop asks for `declared - closed`.
#
# CLOSED BY HAND COUNTS TOO. The single-table router already refuses to re-seat a
# table the human left ("the human left it — do not re-seat them"); this is that
# same rule at N tables. Once the session has had all the tables it asked for, a
# drop in the count is a decision, not a failure, and it is honoured rather than
# fought.
_closed_tables: set = set()


def _tables_closed() -> set:
    """Slots closed this session — memory first, the record as the backstop."""
    out = set(_closed_tables)
    for e in ((_session["rec"] or {}).get("events") or []):
        if e.get("kind") == "table-closed" and (e.get("data") or {}).get("slot"):
            out.add(int(e["data"]["slot"]))
    return out


def _tables_wanted(cfg: dict) -> int:
    """How many tables this session should have OPEN right now."""
    try:
        declared = int(cfg.get("tables") or 1)
    except (TypeError, ValueError):
        declared = 1
    return max(1, declared - len(_tables_closed()))


def _close_table(slot_n: int, why: str = "closed from the panel") -> dict:
    """Close table `slot_n`: stop the session asking for it, and stand it down.

    IDEMPOTENT by construction. Closing a table that is already closed — or one
    that was never seated — records the intent and reports what it found; it
    never presses anything a second time, and it never errors for being early or
    late. What always happens is the first half: the slot stops being a table
    this session is owed."""
    me = TABLES.slot()
    already = slot_n in _tables_closed()
    _closed_tables.add(slot_n)
    if _session["id"] and not already:
        _sessions.event(_session["id"], "table-closed", {"slot": slot_n, "why": why})
    out = {"ok": True, "slot": slot_n, "already": already,
           "wanted": _tables_wanted(((_session["rec"] or {}).get("config") or {}))}
    if already:
        out["note"] = "already closed — left alone"
        return out
    # then the table itself. A wrapper leaves its OWN table and nobody else's,
    # so this is asked of the slot that owns it rather than done from here.
    if slot_n == (me or TABLES.LEADER):
        out["stood_down"] = _stand_down_table(why)
    else:
        out["stood_down"] = _peer_post(TABLES.panel_port(slot_n), "/table/stand-down",
                                       {"why": why, "sid": _session["id"]}, timeout=30)
    _feed_add(f"Table {slot_n} closed — the session now wants {out['wanted']}")
    print(f"[tables] table {slot_n} closed ({why}); wanted is now {out['wanted']}")
    return out


def _stand_down_table(why: str) -> dict:
    """This wrapper leaves its own table and stops answering for it.

    NEVER MID-HAND. Hero holding cards is money on the table; the leave is
    deferred to the next hand boundary (the feed loop calls back in) rather than
    forfeiting a hand to a button press. The stop-asking half has already
    happened by the time this runs, so the deferral costs nothing."""
    if _in_a_hand():
        _study["standDownPending"] = why
        _feed_add("Table will be left as soon as this hand is over")
        return {"deferred": True, "why": "hero is in a hand"}
    _study["standDownPending"] = None
    _study["on"] = False
    try:
        res = F.leave(CDP_PORT) if cdp.available(CDP_PORT) else {"ok": True, "note": "no table window"}
    except Exception as e:
        res = {"ok": False, "error": str(e)}
    _router["cancel"] = True          # the router must not route this table anywhere again
    _router_set("left", f"table closed — {why}")
    return res


def _in_a_hand() -> bool:
    """Hero has cards in front of him right now — money that a Leave would
    forfeit. `_hero_status`'s own vocabulary: in-hand, not-in-hand, folded,
    sitting-out, waiting-for-bb."""
    if _ws_state.get("handOver") or _ws_state.get("heroFolded"):
        return False
    return bool(_ws_state.get("heroCards")) or _live_status.get("hero") == "in-hand"


def _maybe_stand_down() -> None:
    """The deferred half of a close: leave the table the moment the hand ends."""
    if not _study.get("standDownPending") or _in_a_hand():
        return
    why = _study["standDownPending"]
    _study["standDownPending"] = None
    print(f"[tables] hand over — leaving the table now ({why})")
    _stand_down_table(why)


def _open_tables(n: int) -> list[dict]:
    """Become table 1 of `n` and bring the rest up. Returns one row per extra
    table. `n == 1` puts this process back to being the only table."""
    before = TABLES.slot()
    TABLES.adopt(n)
    if n <= 1:
        if before is not None:
            print("[tables] back to one table")
            threading.Timer(0.5, lambda: print(f"[layout] {apply_layout()}")).start()
        return []
    # The CLIENT WINDOW does not change: there is one of it however many tables
    # are open, and the client tiles them inside it. What follows is the wrapper
    # PROCESSES — one per table, each reading its own slot in that one page. The
    # tables themselves are seated by the router (_route_session step 2a), which
    # goes back to the lobby and takes another seat for each one.
    print(f"[tables] this session wants {n} tables; this is table {TABLES.LEADER}")
    # BOTH WINDOWS, AFTER adopt(), NOT JUST THE CLIENT. Everything about this
    # layout is a function of the COUNT, and the count only becomes N on the line
    # above: the client goes from the 70% strip to the whole table monitor, and
    # this wrapper's panel goes from the strip beside it to a tile on the other
    # screen next to its siblings'. Until now the only thing that re-placed them
    # was a timer _open_table_window() had set a second or two earlier, which
    # raced adopt() and left the leader wherever it happened to lose — its panel
    # on the table monitor while every follower tiled on the other one.
    print(f"[layout] {apply_layout()}")
    out = []
    for k in range(2, n + 1):
        r = _spawn_slot(k, n)
        out.append(r)
        print(f"[tables] table {k}: {'up' if r.get('ok') else 'FAILED - ' + str(r.get('error'))}"
              f" on :{r['panelPort']}" + (" (already running)" if r.get("already") else ""))
    return out


def _peer_get(port: int, path: str, timeout: float = 3.0) -> dict:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _table_card(st: dict, slot_n: int, port: int, me: bool) -> dict:
    """One table, in the words the combined strip shows: whose turn, what we
    said about it, and whether this table is in any state to be answering."""
    h = st.get("hand") or {}
    node = h.get("currentNode") or {}
    a = st.get("panelAnswer")
    a = {"text": a, "pick": None} if isinstance(a, str) else (a or None)
    ended = bool(h.get("ended"))
    return {
        "slot": slot_n, "panelPort": port, "me": me,
        "reachable": st.get("ok") is not False,
        "error": st.get("error"),
        "session": (st.get("session") or {}).get("id") if isinstance(st.get("session"), dict) else st.get("sessionId"),
        "answersOn": bool(st.get("studyAnswers")),
        "connected": bool(st.get("connected")),
        "street": h.get("street"),
        "heroCards": h.get("heroCards"),
        "handId": st.get("handId") or h.get("handId"),
        "toActIsHero": bool(node.get("toActIsHero")) and not ended,
        "toCall": node.get("toCall"),
        "notToActWhy": h.get("notToActWhy"),
        "ended": ended,
        "answer": a and a.get("text"),
        "pick": a and a.get("pick"),
        "layout": st.get("layout"),
        # a table nobody can press on is worth saying out loud, not hiding
        "clientWindow": st.get("layout"),
    }


def tables_overview() -> dict:
    """Every table's answer in one payload — what the leader's panel renders.

    The panel cannot fetch the other tables itself: each one is a different
    ORIGIN (its own port), so the browser would need CORS on four servers to show
    one strip. The leader collects them instead, over loopback, in parallel — and
    a table that does not answer within the timeout is shown as unreachable
    rather than holding the whole strip up."""
    me = TABLES.slot()
    mine = _table_card(state(light=True), me or 1, PANEL_PORT, True)
    cards = [mine]
    # EVERY DECLARED TABLE GETS A CARD, answering or not. Listing only the ones
    # that replied means a table which never came up, or died, simply is not
    # there — and a strip that quietly shrinks from four cards to one is exactly
    # how a two-table session ran for twenty hands with one table answering and
    # nothing on screen saying so (2026-09-21). An absent table is a fact worth
    # rendering; the card for one reads "not answering".
    rows = [r for r in TABLES.registry() if r.get("slot") != me]
    if rows:
        got: list[dict] = []
        ts = []

        def go(r):
            st = (_peer_get(r["panelPort"], "/state?light=1") if r.get("live")
                  else {"ok": False, "error": f"table {r['slot']} is not running"})
            got.append(_table_card(st, r["slot"], r["panelPort"], False))

        for r in rows:
            t = threading.Thread(target=go, args=(r,), daemon=True)
            t.start()
            ts.append(t)
        for t in ts:
            t.join(4.0)
        cards += got
    cards.sort(key=lambda c: c["slot"])
    closed = sorted(_tables_closed())
    cfg = (_session["rec"] or {}).get("config") or {}
    for c in cards:
        c["closed"] = c["slot"] in closed
    return {"ok": True, "at": time.time(), "leader": TABLES.LEADER, "slot": me,
            "tables": cards, "declared": TABLES.count(),
            # what the session is still owed, after the tables given up on: the
            # number the seating loop actually works to
            "closed": closed, "wanted": _tables_wanted(cfg),
            "waiting": sum(1 for c in cards if c["toActIsHero"])}


def _peer_post(port: int, path: str, body: dict, timeout: float = 25.0) -> dict:
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                     data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _fan_out(path: str, body: dict, timeout: float = 25.0) -> list[dict]:
    """Send one instruction to every live peer, in parallel — four tables opening
    their own lobby in series is four times the wait before the first hand.

    PROBED, NOT REMEMBERED (`live_peers`). Everything that comes through here is
    an instruction about a session — start it, join it, leave it — and a table
    missing from this list does not get a worse display, it gets left out of the
    session entirely. That is the 2026-09-21 failure in one line: the peer list
    was empty, the fan-out succeeded against nobody, and three tables read their
    felt all session with answers off. The half second of probing is the
    cheapest part of starting a session."""
    out: list[dict] = []
    peers = TABLES.live_peers()
    if not peers:
        return out
    threads = []

    def go(p):
        r = _peer_post(p["panelPort"], path, body, timeout)
        out.append({"slot": p["slot"], "panelPort": p["panelPort"], **r})

    for p in peers:
        t = threading.Thread(target=go, args=(p,), daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout + 5)
    out.sort(key=lambda r: r["slot"])
    return out


def _session_join(body: dict) -> tuple[int, dict]:
    """Follower: take up the leader's session. No record, no balance, no event
    that claims this table started anything."""
    sid = (body.get("sid") or "").strip()
    cfg = body.get("config") or {}
    if not sid:
        return 400, {"ok": False, "error": "sid required"}
    if _session["id"] == sid:
        return 200, {"ok": True, "session": _session["rec"], "already": True}
    if _session["id"]:
        return 409, {"ok": False, "error": f"slot {TABLES.slot()} is already on session {_session['id']}"}
    rec = _sessions.get(sid)
    if not rec:
        return 404, {"ok": False, "error": f"no session {sid}"}
    if rec.get("ended_at"):
        return 409, {"ok": False, "error": f"session {sid} has already ended"}
    _session.update({"id": sid, "rec": rec, "started": time.time()})
    _apply_session_config(cfg)
    if cfg.get("answers"):
        threading.Thread(target=_ensure_answer_chain, args=(f"slot {TABLES.slot()} joined",), daemon=True).start()
    _sessions.event(sid, "table-joined", {"slot": TABLES.slot(), "panelPort": PANEL_PORT})
    print(f"[session] slot {TABLES.slot()} joined {sid}")
    try:
        _open_table_window()
    except Exception as e:
        print(f"[session] slot {TABLES.slot()} table window: {e}")
    _start_router(cfg, sid)
    return 200, {"ok": True, "session": rec, "slot": TABLES.slot()}


def _session_leave(body: dict) -> tuple[int, dict]:
    """Follower: step off the session. The RECORD is the leader's to end — this
    table only says it has stopped playing on it."""
    sid = _session["id"]
    if not sid:
        return 200, {"ok": True, "left": None}
    # LEAVE THE SESSION NAMED, NOT WHATEVER THIS TABLE IS ON (2026-09-20). The
    # caller has always passed `sid`; this ignored it and stood the table down
    # regardless. Harmless while the only caller was the leader ending the one
    # session everybody shared — and not harmless at all once _end_other_open
    # starts sweeping LEFTOVER ids, which is a different session from the one
    # this table may be happily playing.
    want = (body or {}).get("sid")
    if want and want != sid:
        return 200, {"ok": True, "left": None, "on": sid,
                     "note": f"slot {TABLES.slot()} is on {sid}, not {want}"}
    hands = _session_hands(sid)
    try:
        _archive_hand()          # the hand in flight belongs to this session
    except Exception:
        pass
    # the same teardown the leader does for itself, WITHOUT ending the record or
    # taking a balance reading: both of those belong to the account, once
    _router["cancel"] = True
    _study["on"] = False
    _study["text"] = None
    _study["auto"] = False
    _study.update({"autoRealUntil": 0.0, "autoRealHands": 0, "autoRealFrom": None, "autoRealReason": None})
    set_debug(False)
    _rec_pending["on"] = False
    _sessions.event(sid, "table-left", {"slot": TABLES.slot(), "hands": hands})
    _session.update({"id": None, "rec": None, "started": 0.0})
    print(f"[session] slot {TABLES.slot()} left {sid} after {hands} hand(s)")
    return 200, {"ok": True, "left": sid, "slot": TABLES.slot(), "hands": hands}


# ---- updates for a PACKAGED install (setup\build_package.py --publish -> setup\update.ps1) ----
# A packaged install has <root>\VERSION.json; the owner's source checkout does not (it updates from git), so
# /update says packaged: false there and the setup page shows nothing. The channel (R2 latest.json) is read with
# the same rclone remote the chart server uses, at most every 30 min.
_REPO = ROOT.parent
_update_cache = {"at": 0.0, "latest": None, "error": None}


def _installed_version() -> dict | None:
    try:
        return json.loads((_REPO / "VERSION.json").read_text(encoding="utf-8-sig"))
    except Exception:
        return None


_owner_release = {"at": 0.0, "running": False, "status": None}


def _owner_release_refresh() -> None:
    """THE OWNER'S SIDE (source checkout): what the friends have vs what this tree would publish, from
    setup/build_package.py --status --json (~8 s: hashes the shipped files), so the setup page can say
    "N changes not published yet". Background thread; the page gets the last result at once."""
    try:
        r = subprocess.run([sys.executable, str(_REPO / "setup" / "build_package.py"), "--status", "--json"],
                           cwd=str(_REPO), capture_output=True, text=True, timeout=180,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        line = (r.stdout.strip().splitlines() or [""])[-1]
        _owner_release["status"] = json.loads(line) if line.startswith("{") else {"ok": False, "error": (r.stderr or r.stdout)[-300:]}
    except Exception as e:
        _owner_release["status"] = {"ok": False, "error": str(e)[:300]}
    finally:
        _owner_release["at"], _owner_release["running"] = time.time(), False


def _update_status(force: bool = False) -> dict:
    inst = _installed_version()
    if inst is None:
        if not (_REPO / "setup" / "build_package.py").exists():
            return {"ok": True, "packaged": False}
        # 90 s: the status is ~2 s now (build_package hashes through its size+mtime cache), and a stale
        # "N changes not published yet" after a publish was the bug (2026-09-23)
        if not _owner_release["running"] and (force or time.time() - _owner_release["at"] > 90):
            _owner_release["running"] = True
            threading.Thread(target=_owner_release_refresh, daemon=True).start()
        return {"ok": True, "packaged": False, "owner": _owner_release["status"]}
    if force or time.time() - _update_cache["at"] > 1800:
        _update_cache["at"] = time.time()
        rc = next((c for c in (os.environ.get("RCLONE"), shutil.which("rclone"),
                               str(Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / "rclone.exe"))
                   if c and Path(c).is_file()), None)
        ch = os.environ.get("PW_CHANNEL", "r2:poker-solve-db/wrapper")
        try:
            r = subprocess.run([rc or "rclone", "cat", f"{ch}/latest.json"], capture_output=True, text=True,
                               timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            _update_cache["latest"] = json.loads(r.stdout) if r.returncode == 0 else None
            _update_cache["error"] = None if r.returncode == 0 else (r.stderr.strip()[-200:] or "update channel unreadable")
        except Exception as e:
            _update_cache["latest"], _update_cache["error"] = None, str(e)[:200]
    lat = _update_cache["latest"] or {}
    try:
        have = json.loads((_REPO / "config" / "installed-data.json").read_text(encoding="utf-8-sig"))
    except Exception:
        have = {}
    data_behind = [k for k, v in (lat.get("data") or {}).items() if have.get(k) != (v or {}).get("version")]
    code_behind = bool(lat.get("version")) and lat["version"] > str(inst.get("version") or "")
    return {"ok": True, "packaged": True, "installed": inst.get("version"), "latest": lat.get("version"),
            "notes": lat.get("notes") or "", "available": code_behind or bool(data_behind and lat),
            "dataBehind": data_behind, "error": _update_cache["error"], "sessionActive": bool(_session["rec"])}


def _start_update() -> tuple[int, dict]:
    """Hand over to setup/update.ps1 in its own console window, then stand down so it can replace our files.
    Started through `cmd /c start` so the updater is not in this process's tree (update.ps1 kills the
    wrapper's tree when it stops everything)."""
    if _session["rec"]:
        return 409, {"ok": False, "why": "a session is running — end it first"}
    if _installed_version() is None:
        return 409, {"ok": False, "why": "this is the source checkout — it updates from git"}
    ps1 = _REPO / "setup" / "update.ps1"
    args = ["-Yes", "-Relaunch", "-PanelPort", str(PANEL_PORT)]
    if PANEL_PORT != 7700:   # reopen THIS instance (a second install / test rig), not a default one
        args += ["-WrapperArgs", f"--panel-port {PANEL_PORT} --cdp-port {CDP_PORT}" + (" --fake" if _fake_mode else "")]
    # a test install beside a live one: its API / chart ports, and hands off the scheduled tasks
    for env, flag in (("PW_API_PORT", "-ApiPort"), ("PW_CHART_PORT", "-ChartPort")):
        if os.environ.get(env):
            args += [flag, os.environ[env]]
    if os.environ.get("PW_SKIP_TASKS") == "1":
        args.append("-SkipTasks")
    subprocess.Popen(["cmd", "/c", "start", "Poker Wrapper update", "powershell", "-NoProfile", "-ExecutionPolicy",
                      "Bypass", "-File", str(ps1), *args], cwd=str(_REPO),
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    threading.Thread(target=_stand_down, args=("updating",), daemon=True).start()
    return 200, {"ok": True, "updating": True}


def _preflight(preset: str, cfg: dict, registry: dict | None = None) -> dict:
    """The session's preflight: sessions.run_preflight, plus the site's own rows
    (CoinPoker: client, log, table)."""
    pf = S.run_preflight(preset, cfg, _fake_mode, registry if registry is not None else S.fetch_registry(), CDP_PORT)
    if cfg.get("site") == CPS.SITE:
        pf["checks"] = pf["checks"] + CP.preflight(cfg.get("cpTable"))
        blockers = [c for c in pf["checks"] if c["required"] and not c["ok"]]
        pf.update({"ok": not blockers, "blockers": [c["label"] for c in blockers]})
    return pf


def _session_start(body: dict) -> tuple[int, dict]:
    # ONE SETUP PAGE. A follower declaring its own session is the thing this
    # replaced, so it is refused rather than quietly allowed: the setup page it
    # would have come from now redirects to the leader's.
    if not TABLES.is_leader() and not body.get("joining"):
        return 409, {"ok": False, "error": f"table {TABLES.slot()} does not declare sessions — "
                                           f"start it from table {TABLES.LEADER} "
                                           f"(http://127.0.0.1:{TABLES.leader_port()}/setup)"}
    if _session["id"]:
        return 409, {"ok": False, "error": f"session {_session['id']} is already running — end it first"}
    preset = body.get("preset") if body.get("preset") in S.PRESETS else None
    if not preset:
        return 400, {"ok": False, "error": "unknown preset"}
    cfg = S.merged_config(preset, body.get("config"))
    cfg["panelPort"] = PANEL_PORT       # which panel plays it: another panel must not sweep it as a leftover
    registry = S.fetch_registry()
    pf = _preflight(preset, cfg, registry)
    if not pf["ok"]:
        return 409, {"ok": False, "error": "blocked by preflight: " + " · ".join(pf["blockers"]), "preflight": pf}
    sid = S.new_session_id()
    rec = _sessions.start(sid, preset, body.get("label"), body.get("note"), cfg, pf, S.versions_snapshot(registry))
    _session.update({"id": sid, "rec": rec, "started": time.time()})
    _apply_session_config(cfg)
    if cfg.get("answers"):
        threading.Thread(target=_ensure_answer_chain, args=("session start",), daemon=True).start()
    _sessions.event(sid, "started", {"hand": _hand_no})
    if _is_cp():
        # CoinPoker: no browser window, no lobby router, no balance scraper — the
        # client is opened if it is not up, and you take the seat in it. The log
        # reader is already running (main) and follows whichever table you open.
        cl = CP.ensure_client()
        _sessions.event(sid, "coinpoker-client", cl)
        threading.Thread(target=_open_leader, daemon=True).start()
        print(f"[session] {sid} started · {preset} · CoinPoker · client "
              f"{'started' if cl.get('started') else 'already running' if cl.get('ok') else cl.get('error')}")
        return 200, {"ok": True, "session": rec, "tables": [], "opened": [], "site": CPS.SITE, "client": cl}
    # The opening balance anchors this session: everything the account does from
    # here until the closing snapshot should be explained by the hands in between
    # (balances.py). Preflight already refused a real-money start without one, so
    # a failure here is the client having moved between the check and the start.
    if cfg.get("clearCache"):
        _clear_table_cache()
        _sessions.event(sid, "cache-cleared", {})
    _auto_open_balance(sid, cfg.get("profile"), "session start")
    print(f"[session] {sid} started · {preset} · answers={'on' if cfg['answers'] else 'off'} recording={'on' if cfg['recording'] else 'off'}")
    # THE TABLE COUNT IS DECLARED BEFORE THE WINDOW OPENS. Everything about the
    # client's rectangle is a function of it — the 70% strip at one table, the
    # whole monitor (fullscreen) from two — and it used to be adopted AFTER, down
    # in _open_tables: the window was opened at the single-table size and then
    # moved, with the placement timers _open_table_window had already set racing
    # the move. Losing that race is what left a four-table session on a 70%-wide
    # client. adopt() is idempotent; _open_tables still calls it.
    n_tables = int(cfg.get("tables") or 1)
    if n_tables > 1:
        TABLES.adopt(n_tables)
    try:
        _open_table_window()
    except Exception as e:
        print(f"[session] table window: {e}")
    _start_router(cfg, sid)
    # THE TABLES THIS SESSION ASKED FOR. Opened after the leader is started, so
    # each one joins an id that already exists; a table that fails to open or
    # join leaves the session running on the ones that did — reported, never
    # rolled back, because the leader may already have been dealt a hand.
    opened = _open_tables(n_tables)
    if opened:
        _sessions.event(sid, "tables-opened", {"want": cfg.get("tables"),
                                               "up": [r["slot"] for r in opened if r.get("ok")],
                                               "failed": [r["slot"] for r in opened if not r.get("ok")]})
    joined = _fan_out("/session/join", {"sid": sid, "config": cfg}) if TABLES.slot() is not None else []
    if joined:
        ok = [r["slot"] for r in joined if r.get("ok")]
        bad = [f"{r['slot']}: {r.get('error')}" for r in joined if not r.get("ok")]
        print(f"[session] {sid} joined by table(s) {ok or 'none'}" + (f" · FAILED {bad}" if bad else ""))
        _sessions.event(sid, "tables", {"joined": ok, "failed": bad})
    return 200, {"ok": True, "session": rec, "tables": joined, "opened": opened}


def _owned_elsewhere(rec: dict) -> bool:
    """A never-ended session that ANOTHER running panel is playing right now — an extra CoinPoker panel (#2 on
    7720, ...) or a second wrapper — is not a leftover. Recognised by the panel port the session was started on
    (config.panelPort) still serving that very session. Before this, the main panel's setup page offered a live
    panel's session as "left open", and End-all ended it under the panel still playing it (2026-09-24)."""
    port = (rec.get("config") or {}).get("panelPort")
    if not port or port == PANEL_PORT or port not in _listening([port]):
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/state?light=1", timeout=5) as r:
            return json.loads(r.read()).get("sessionId") == rec["id"]
    except Exception:
        return False


def _leftovers() -> list[dict]:
    """Never-ended sessions that are really abandoned: not this panel's live one, not another live panel's."""
    return [r for r in _sessions.open_sessions() if r["id"] != _session["id"] and not _owned_elsewhere(r)]


def _end_other_open(keep: str | None, note: str) -> list[str]:
    """End every never-ended session except `keep` (the one in use). Returns the ids ended."""
    ended = []
    for r in _sessions.open_sessions():
        if r["id"] == keep or _owned_elsewhere(r):      # another live panel's session is not a leftover
            continue
        _sessions.end(r["id"], {"hands": _session_hands(r["id"]),
                                "durationMin": round(((time.time() * 1000) - r["started_at"]) / 60000, 1),
                                "events": len(r.get("events") or []), "recording": None, "orphaned": True}, note)
        _sessions.event(r["id"], "ended", {"orphaned": True})
        ended.append(r["id"])
        # AND TELL THE TABLES (2026-09-20). Ending only the RECORD is how session
        # 130435 split: the leader swept it as a leftover at 13:13:49, took a new
        # single-table session 30 s later, and slot 2 — never told — kept its sid
        # and archived 33 more hands into the dead one until 14:15. The session's
        # own summary says "hands: 0" while those 33 carry its id. A follower on a
        # different session is unaffected: _session_leave checks the id now.
        try:
            for peer in _fan_out("/session/leave", {"sid": r["id"]}, timeout=8):
                if peer.get("left"):
                    print(f"[session] slot {peer['slot']} stood down from leftover {r['id']}")
        except Exception as e:
            print(f"[session] could not stand tables down from {r['id']}: {e}")
    if ended:
        print(f"[session] ended {len(ended)} leftover session(s): {', '.join(ended)}")
    return ended


def _close_browser(port: int) -> bool:
    """Close the whole app-mode browser behind a CDP port (Browser.close on its
    browser-level socket). Scoped by PORT, never by process name."""
    if not cdp._listening(port):        # nothing to close — and a closed port costs 2 s to refuse
        return False
    try:
        import websocket  # the scout's dependency, already on the path
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
            ws_url = json.loads(r.read())["webSocketDebuggerUrl"]
        ws = websocket.create_connection(ws_url, timeout=4, suppress_origin=True)
        try:
            ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
            try:
                ws.recv()
            except Exception:
                pass
        finally:
            ws.close()
        return True
    except Exception as e:
        print(f"[close-out] Browser.close on :{port} failed: {e}")
        return False


def _kill_profile_windows(profile: str) -> int:
    """Stop the app-mode browser that runs on OUR user-data-dir `profile` (the
    panel window has no CDP port, so this is its only handle). Matched on the
    dedicated --user-data-dir path only — never on the browser's exe name, so a
    user's own Chrome/Brave windows are untouched."""
    path = str(ROOT / profile)
    ps = ("$p = '" + path.replace("'", "''") + "'; "
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=' + $p) } "
          "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                             capture_output=True, text=True, timeout=20)
        pids = [x for x in out.stdout.split() if x.strip().isdigit()]
        print(f"[close-out] {profile}: stopped {len(pids)} process(es)")
        return len(pids)
    except Exception as e:
        print(f"[close-out] could not stop {profile}: {e}")
        return 0


def _close_out_after_end(sid: str) -> dict:
    """END SESSION = ALSO CLOSE OUT (Brady, 2026-09-19): leave the table, then close
    the table window and the panel/setup window, THEN END THIS PROCESS. The leave
    runs first and synchronously: money comes off the table before anything is
    closed, and if the leave fails nothing is closed — the panel says so instead.
    The windows go a moment after the reply so the panel gets its answer.

    The process exit (Brady, 2026-09-19): a wrapper that outlives its session
    keeps serving the code it was started with — a fix written mid-session sat
    on disk for a whole later session because the instance from before the edit
    was still the one running. With the process gone at End session, the next
    open from the icon is always the code on disk."""
    if _fake_mode:
        return {"left": None, "windows": "kept", "why": "test rig"}
    if _is_cp():
        # CoinPoker's tables belong to its client: the session ends, the panel goes,
        # and every table (and the chips on it) stays exactly where it is
        def _go_cp() -> None:
            # every panel has its own Brave profile, so this closes OUR window only; the main panel takes its
            # leader window with it (the extra panels keep running until they are ended themselves)
            _kill_profile_windows(PROFILE_PANEL)
            if not _TAG:
                _kill_profile_windows(PROFILE_LEADER)
            _stand_down("session ended")
        threading.Timer(0.8, _go_cp).start()
        return {"left": None, "windows": "closing", "process": "exiting",
                "why": "CoinPoker tables are left open in the client"}
    if not cdp.available(CDP_PORT):
        def _go_no_table() -> None:
            _kill_profile_windows(PROFILE_PANEL)
            _stand_down("session ended")
        threading.Timer(0.8, _go_no_table).start()
        return {"left": None, "windows": "closing", "process": "exiting", "why": "no table window was open"}
    try:
        res = F.leave(CDP_PORT, log=lambda m: print(m))
    except Exception as e:
        res = {"ok": False, "error": str(e)}
    left = bool(res.get("ok"))
    if _session["id"] is None:   # the session is over either way; the record keeps the outcome
        pass
    _sessions.event(sid, "close-out", {"left": left, "note": res.get("note"), "error": res.get("error")})
    if not left:
        print(f"[close-out] table NOT left ({res.get('error') or 'unknown'}) — windows kept open")
        return {"left": False, "windows": "kept", "why": res.get("error") or "could not leave the table"}

    def _go() -> None:
        _close_browser(CDP_PORT) or _kill_profile_windows(PROFILE_TABLE)
        _kill_profile_windows(PROFILE_PANEL)
        _stand_down("session ended")
    threading.Timer(0.8, _go).start()
    return {"left": True, "windows": "closing", "process": "exiting", "why": None}


def _session_end(body: dict) -> dict:
    if body.get("all"):
        # "End all and start fresh": clear every leftover; the live session (if any) stays on
        ended = _end_other_open(_session["id"], body.get("note") or "ended from setup (all leftovers)")
        return {"ok": True, "ended": ended, "kept": _session["id"]}
    sid = body.get("id") or _session["id"]
    if not sid:
        return {"ok": False, "error": "no session to end"}
    rec = _sessions.get(sid)
    if not rec:
        return {"ok": False, "error": f"no session {sid}"}
    live = sid == _session["id"]
    if live:
        try:
            _archive_hand()  # the hand in flight belongs to this session
        except Exception:
            pass
        # THE OTHER TABLES STOP FIRST. The closing balance below brackets the
        # session's hands, and a table still playing would move the account
        # between the reading and the record — the unexplained movement the
        # dashboard then flags would be our own doing.
        # ASK THE PEERS REGARDLESS OF OUR OWN SLOT (2026-09-20). This used to be
        # gated on `TABLES.slot() is not None`, so a leader already put back to a
        # single table (adopt(1)) ended the record without standing anyone down.
        # peers() is empty on a genuinely single-table run, which is the same
        # no-op this guard was reaching for, arrived at from the evidence instead
        # of from a flag.
        left = _fan_out("/session/leave", {"sid": sid})
        if left:
            print(f"[session] {sid}: tables stood down {[(r['slot'], r.get('hands')) for r in left]}")
            # The extra tables were opened FOR this session, so they close with
            # it: the next session picks its own count on the setup page, and
            # leaving four wrappers running would silently decide that for it.
            _fan_out("/quit", {}, timeout=8)
            time.sleep(1.0)
            TABLES.adopt(1)
            print("[tables] extra tables closed; back to one")
    # The CLOSING balance, taken before anything else is torn down: the pair
    # (open, close) brackets exactly this session's hands, and the difference
    # between that pair and what the hands say is the unexplained movement the
    # dashboard flags (balances.py).
    close_cents = None
    prof = ((rec.get("config") or {}).get("profile")) if isinstance(rec.get("config"), dict) else None
    if live and prof and not _fake_mode:
        snap = BAL.snapshot(prof, CDP_PORT, sid, "close")
        if snap.get("ok"):
            close_cents = snap["amountCents"]
            _sessions.event(sid, "balance", {"phase": "close", "amountCents": close_cents, "how": snap.get("how")})
            print(f"[balance] {prof} closes at {BAL.fmt(close_cents)}")
        else:
            _sessions.event(sid, "balance-missed", {"phase": "close", "reason": snap.get("reason")})
            print(f"[balance] could not record a closing balance: {snap.get('reason')} — the session's money is unreconciled")
    summary = {"hands": _session_hands(sid),
               "durationMin": round(((time.time() * 1000) - rec["started_at"]) / 60000, 1),
               "events": len(rec.get("events") or []),
               "balanceCloseCents": close_cents,
               "recording": _dbg["dir"] if live and _dbg["on"] else None}
    if live:
        _study["on"] = False
        _study["text"] = None
        _study["auto"] = False
        # a real-money allowance never outlives the session that granted it
        _study.update({"autoRealUntil": 0.0, "autoRealHands": 0, "autoRealFrom": None, "autoRealReason": None})
        set_debug(False)
        _rec_pending["on"] = False
        _router["cancel"] = True
        _sessions.event(sid, "ended", {"hand": _hand_no})
        _session.update({"id": None, "rec": None, "started": 0.0})
        print(f"[session] {sid} ended · {summary}")
    out = _sessions.end(sid, summary, body.get("note"))
    return {"ok": True, "session": out}


def _main_tail() -> None:
    """Called after the server is up: a session left open by a restart is NOT
    auto-resumed — the setup page offers resume/end so the choice is explicit."""
    opened = _leftovers()
    if opened:
        print(f"[session] {len(opened)} left open ({', '.join(r['id'] for r in opened)}) — resume the newest or end them all on /setup")
    print("Ctrl+C stops the panel server (browser windows stay open).")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
