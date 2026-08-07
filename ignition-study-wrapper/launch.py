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

Env overrides: IGNITION_URL, CDP_PORT (9333), PANEL_PORT (7700), CHROME_EXE,
TABLE_FRAC (0.70 = table share of work-area width).
"""

import ctypes
import ctypes.wintypes
import json
from collections import deque
import os
import re
import sqlite3
import subprocess
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

# The game-state spec the /faketable routes render. Set via POST /faketable/spec
# by the tester; None falls back to faketable.EXAMPLE_SPEC. _fake_mode marks the
# wrapper as driving the LOCAL fake table: the target search prefers it, the
# archiver refuses authored hands, and the DOM-diff inference stays frozen.
_faketable_spec: dict | None = None
# FAKE_TABLE=1 makes this instance a TEST RIG: the table window opens the local
# fake table instead of Ignition, and everything downstream — reader, /hand,
# relay, the answer poller — runs unchanged against it. That is the whole point:
# the study tools cannot tell the difference, so testing them here tests them.
# Launched on its own ports (see study-tool.pyw) so a real session can run at
# the same time and neither can disturb the other.
_fake_mode = os.environ.get("FAKE_TABLE") == "1"

# Under pythonw (the desktop shortcut) there is no console: sys.stdout is None
# and any print() would crash. Route output to the log file instead.
if sys.stdout is None or sys.stderr is None:
    _log = open(ROOT / "server.log", "a", buffering=1, encoding="utf-8")
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

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
TABLE_FRAC = float(os.environ.get("TABLE_FRAC", "0.70"))
# Per-rig browser profiles and window title. A shared profile dir puts both
# rigs' windows in ONE Chrome process, where --window-position/--window-size and
# the CDP port stop sticking; a shared title makes each panel's
# bring-to-front surface the other rig's window.
_RIG = "-fake" if os.environ.get("FAKE_TABLE") == "1" else ""
PROFILE_TABLE = f".profile-table{_RIG}"
PROFILE_PANEL = f".profile-panel{_RIG}"
PANEL_TITLE = "Ignition Study Tool" if _RIG else "Ignition Study"


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
        r = mi.rcWork
        out.append({"x": r.left, "y": r.top, "w": r.right - r.left,
                    "h": r.bottom - r.top, "primary": bool(mi.dwFlags & 1)})
        return 1

    ctypes.windll.user32.EnumDisplayMonitors(None, None, proto(cb), 0)
    return out


def target_area() -> dict:
    """The monitor the app should occupy: the secondary if one is attached,
    else the primary."""
    mons = monitors()
    sec = [m for m in mons if not m["primary"]]
    return (sec or mons or [{"x": 0, "y": 0, "w": 1440, "h": 852, "primary": True}])[0]


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
            if exe.value.lower().endswith("brave.exe") and "ignition" in buf.value.lower():
                found.append((h, buf.value))
        return 1

    ctypes.windll.user32.EnumWindows(proto(cb), 0)
    table = next((h for h, t in found if t != "Ignition Study"), None)
    panel = next((h for h, t in found if t == "Ignition Study"), None)
    return table, panel


def apply_layout() -> dict:
    """Fit table (left ~70%) + panel (right) onto the target monitor."""
    area = target_area()
    table_w = int(area["w"] * TABLE_FRAC)
    table, panel = _wrapper_windows()
    moved = {}
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
    """The table window's page target — the one that isn't our own panel."""
    pages = cdp.page_targets(CDP_PORT)
    # In test mode the fake table IS the table — prefer it even when the real
    # client is also open, so an authored state is never read off live felt.
    if _fake_mode:
        for t in pages:
            if "/faketable" in t.get("url", ""):
                return t
    # The actual game lives on /static/poker-game/ — prefer it over the lobby.
    for pat in ("poker-game", "ignition"):
        for t in pages:
            if pat in t.get("url", "").lower():
                return t
    for t in pages:
        u = t.get("url", "")
        if f"localhost:{PANEL_PORT}" not in u and not u.startswith("devtools"):
            return t
    return None


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
          "at": 0.0}
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


def state(light: bool = False) -> dict:
    """Full state for the panel's connection card; `light` skips the DOM eval
    and target listing — enough for the 1 Hz study-answer poll and the
    poller's probe (CONTRACT.md §1) without extra CDP traffic."""
    try:  # page-code fingerprint: the panel reloads itself when this changes
        pv = int((ROOT / "panel.html").stat().st_mtime)
    except OSError:
        pv = 0
    out = {"cdp": cdp.available(CDP_PORT), "ignition": None, "targets": [],
           "panelVersion": pv,
           # Which rig this is. The panel shows its Table Setup card only on a
           # test rig, and points the answer poller at its OWN wrapper — one
           # poller exists, so whichever panel you switch answers on becomes
           # the one it watches.
           # cdpPort so a tool driving THIS rig reads THIS rig's browser. A
           # test that posts to one rig's panel and then reads the other rig's
           # CDP port finds no fake table and reports every state as a parity
           # loss — which is what an hour-long run of 120/120 failures was.
           "fakeTable": _fake_mode, "panelPort": PANEL_PORT, "cdpPort": CDP_PORT,
           # live-feed contract (CONTRACT.md §1) — what resolveHand consumes
           "connected": False, "hand": None, "studyAnswers": _study["on"],
           "panelAnswer": _current_answer(),
           "snapshot": {"status": _live_status["hero"],
                        "seats": [{"hero": True,
                                   "sittingOut": _live_status["hero"]
                                   in ("sitting-out", "waiting-for-bb")}]}}
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
_TABLE_JS = r"""(() => {
  const tf = [...document.querySelectorAll('iframe')].find(f => (f.src || '').includes('playMode'));
  if (!tf) return {seated: false};
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
    let bet = null, badge = null, num = null;
    const wk = doc.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = wk.nextNode())) {
      const tx = (n.nodeValue || '').trim();
      if (!tx) continue;
      const pe = n.parentElement;
      if (SM.test(tx)) { if (!(bal && bal.contains(pe)) && bet === null && vis(pe)) bet = tx; }
      else if (BW.test(tx)) { if (badge === null && vis(pe)) badge = tx.toUpperCase(); }
      else if (/^[1-9]$/.test(tx) && num === null) num = +tx;
    }
    return {
      seat: +s.getAttribute('data-qa').split('-')[1],
      num, me: !!s.querySelector("[data-qa='myPlayerTag']"),
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


def table_state() -> dict:
    t = ignition_target()
    if not t:
        return {"seated": False, "reason": "poker client not open"}
    try:
        d = cdp._eval(t["webSocketDebuggerUrl"], _TABLE_JS, timeout=6) or {}
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
_WATCH_JS = r"""(() => {
  const tf = [...document.querySelectorAll('iframe')].find(f => (f.src || '').includes('playMode'));
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


def _drain_actions() -> list[dict]:
    """Install (once) and drain the in-page action watcher."""
    t = ignition_target()
    if not t:
        return []
    try:
        return cdp._eval(t["webSocketDebuggerUrl"], _WATCH_JS, timeout=6) or []
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
        d = cdp._eval(t["webSocketDebuggerUrl"], _TABLE_JS, timeout=6) or {}
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
            _live_status["board"] = list(board_cards)
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
    cur = {"seated": True, "seats": seats, "board": board, "pot": pot,
           "heroHand": hero_hand, "toAct": to_act,
           "heroCards": " ".join(hero_cards)}

    first = not p.get("seated") or p.get("waiting")
    if first:
        _hand_no += 1
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
                name = next((m["text"] for m in d["nodes"]
                             if abs(m["y"] - n["y"]) <= 8
                             and 0 < n["x"] - (m["x"] + m["w"]) < 60), "")
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
            # badge is old news, not a new action.
            if ((badge == "FOLD" and ob_badge != "FOLD") or (oc >= 1 and cc == 0)) \
                    and not _act_seen(("fold", num)):
                folded_seats.add(num)
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
    _dbg_record(t["webSocketDebuggerUrl"], {
        "hand": _hand_no, "pot": pot, "board": board_cards,
        "heroCards": hero_cards, "toAct": to_act, "seats": seats,
        "actions": [a["text"] for a in actions], "events": events,
        "feedTail": [line["line"] for line in _feed[-4:]]}, raw=d)
    _feed_prev = cur


# ---- Debug recorder: frame + parsed state + feed tail per tick ----
# The ground truth for chasing misread actions: each tick's EXACT screenshot
# paired with what the parser made of it and what the feed said.
_dbg = {"on": False, "dir": None, "seq": 0}


def set_debug(on: bool) -> dict:
    if on and not _dbg["on"]:
        _prune_debug()
        d = ROOT / "debug" / time.strftime("session_%Y%m%d_%H%M%S")
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
    n = len([c for c in _ws_state.get("board") or [] if c])
    return "river" if n >= 5 else "turn" if n == 4 else "flop" if n == 3 else "preflop"


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
         "street": street or _street_now()})


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
_WS_DUMP_PATH = ROOT / "debug" / "ws_dump.jsonl"
_ws_dump: deque = deque(maxlen=3000)
_ws_dump_cur: dict | None = None


def _dump_begin(d: dict) -> dict:
    global _ws_dump_cur
    now = time.time()
    e = {"ts": round(now, 3),
         "t": time.strftime("%H:%M:%S", time.localtime(now)) + f".{int(now * 1000) % 1000:03d}",
         "hand": _hand_no, "pid": d.get("pid"), "seat": d.get("seat"),
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
    if seat is not None and ((dealt_now and seat not in dealt_now)
                             or seat in _ws_state.get("foldedSeats", set())):
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
        _ws_state["heroCards"] = []
        _ws_state["pot"] = None
        _ws_state["potCents"] = None
        _ws_state["handOver"] = False
        _ws_state["endedSince"] = None
        # Zone deals a NEW table every hand: the previous hand's dealer/dealt
        # must not leak into this one (stale geometry = wrong positions = the
        # study line walks the wrong seats). Both are re-announced within the
        # same message burst (CO_DEALER_SEAT / CO_CARDTABLE_INFO); until then
        # /hand exports null and the poller simply waits a beat.
        _ws_state["dealer"] = None
        _ws_state["dealt"] = []
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
    elif pid == "CO_BLIND_INFO":
        btn, bet = d.get("btn"), d.get("bet")
        if bet:
            if btn == 4:                               # BB post = exact scale
                _ws_state["bb"] = bet
            elif btn == 2 and not _ws_state.get("bbSeen"):
                _ws_state["bb"] = bet * 2              # SB arrives first; infer
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
    elif pid == "CO_SELECT_INFO":
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
    elif pid == "PLAY_STAGE_END_REQ":
        # The client's own end-of-hand marker — covers SHOWDOWN hands, whose
        # `ended` flag stays false (it means folded-or-uncontested), so the
        # idle flush (_maybe_flush_ended) can archive them too.
        _ws_state["handOver"] = True
    elif pid == "CO_DEALER_SEAT":
        _ws_state["dealer"] = d.get("seat")
    elif pid == "CO_CARDTABLE_INFO":
        # Hero is the only seat whose cards come through face-UP; everyone
        # else's read as the face-down back (32896). That identifies our seat
        # without any guessing.
        dealt = []
        for k, v in d.items():
            if not (m := re.fullmatch(r"seat(\d+)", str(k))) or not isinstance(v, list):
                continue
            dealt.append(int(m.group(1)))
            names = [n for n in (_card_name(f"card{c}") for c in v) if n]
            if names:
                _ws_state["heroSeat"] = int(m.group(1))
                # Store the cards too: CO_PCARD_INFO doesn't arrive every hand
                # and the DOM minis are blank between hands, so without this
                # the archive (and any boundary-time read) lost hero's cards.
                _ws_state["heroCards"] = names
        _ws_state["dealt"] = sorted(dealt)
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
            _feed_add(f"Your cards: {' '.join(names)}")


def _hero_status(d: dict, nodes: list) -> str:
    """Why hero isn't acting: sitting out, waiting to be dealt in, folded, or
    simply not their turn. The client states the first two on the table itself
    ("I AM BACK", "SITTING OUT", "Waiting for big blind")."""
    txt = " ".join(n["text"] for n in nodes).lower()
    if "i am back" in txt or "sitting out" in txt:
        return "sitting-out"
    if re.search(r"wait(ing)? (for )?(the )?big blind", txt):
        return "waiting-for-bb"
    if _ws_state.get("heroFolded"):
        return "folded"
    hero = _ws_state.get("heroSeat")
    dealt = _ws_state.get("dealt") or []
    if hero is not None and dealt and hero not in dealt:
        return "not-in-hand"
    return "in-hand"


def _hero_position() -> str | None:
    """Hero's position name, from the dealer button and who was dealt in.
    Seats run clockwise, so order the dealt seats starting after the button:
    SB, BB, then early→late, with the button itself last."""
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
    if n == 3:
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
    # SNAPSHOT shared mutables up front: this runs on HTTP threads while the
    # WS tap and DOM feed threads append/assign concurrently — iterating the
    # live dict/list can raise mid-request and 500 the poller's probe.
    dealt = list(_ws_state.get("dealt") or [])
    hero = _ws_state.get("heroSeat")
    if not _hand_no or not dealt or hero is None:
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
    if time.time() >= _ws_state.get("domGraceUntil", 0):
        dom_board = [short(c) for c in (_live_status.get("board") or []) if c]
        has_voluntary = any(a["type"] not in ("post-sb", "post-bb") for a in acts_src)
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
    # Uncontested win: every dealt villain has folded — the hand is over and
    # there is no decision left to solve (the panel shows "you win", not a
    # solver failure).
    folded_seats = {a["seat"] for a in acts_src if a["type"] == "fold"}
    villains = [s for s in dealt if s != hero]
    hero_won = (not hero_folded and bool(villains)
                and all(s in folded_seats for s in villains))
    return {
        "handId": _hand_no,
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
            "toActIsHero": action_on == hero,
            "pot": to_bb(_ws_state.get("potCents")) or 0,
            "toCall": to_bb(max(0, hero_owed)) or 0,
            "legalActions": [],
            "complete": False,
        },
        "heroFolded": hero_folded,
        "heroWon": hero_won,
        "ended": hero_folded or hero_won,
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


_last_archived = {"no": 0}


def _archive_hand() -> None:
    """Persist the finishing hand. Called at the NEXT hand's PLAY_STAGE_INFO
    (the reliable end-of-hand signal) and at table close (no next hand will
    ever come) — the dedupe guard makes the two triggers safe together."""
    if _fake_mode:
        return  # authored test states are not hand history
    try:
        h = _hand_state()
        if not h or not h["actions"]:
            return
        if h["handId"] == _last_archived["no"]:
            return  # already flushed (table close followed by a rejoin)
        lines = [f["line"] for f in _feed if f.get("hand") == _hand_no]
        result = next((x for x in reversed(lines)
                       if re.search(r"\bwins?\b|Result for hand", x)), None)
        h["playedAt"] = int(time.time() * 1000)
        h["stakes"] = _stakes_str()
        h["clientHandId"] = _hand_ids.get(_hand_no)
        h["feedLines"] = lines
        if result:
            h["result"] = {"text": result}
        c = _db()
        try:
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
                    e = _dump_begin(d)
                    try:
                        _on_game_msg(d)
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


def _maybe_flush_ended() -> None:
    """Archive a FINISHED hand after a short grace even when no next hand ever
    arrives (player pauses / sits out after it) — otherwise it waits for the
    next PLAY_STAGE_INFO indefinitely and never reaches the dashboard. The
    grace lets the result/win feed lines land first; _archive_hand's id guard
    makes the eventual next-hand trigger a harmless no-op."""
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


def _feed_loop() -> None:
    while True:
        try:
            _feed_tick()
        except Exception:
            pass
        try:
            _maybe_flush_ended()
        except Exception:
            pass
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
    t = ignition_target()
    if not t:
        return {"ok": False, "reason": "poker client not open"}
    try:
        d = cdp._eval(t["webSocketDebuggerUrl"], _TABLE_JS, timeout=6) or {}
    except Exception as e:
        return {"ok": False, "reason": f"table read failed: {e}"}
    if not d.get("seated"):
        return {"ok": False, "reason": "no table tab open"}
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
    cdp._dispatch_click(t["webSocketDebuggerUrl"],
                        hit["x"] + hit["w"] / 2, hit["y"] + hit["h"] / 2)
    return {"ok": True, "clicked": hit["text"], "kind": kind,
            "at": [hit["x"] + hit["w"] // 2, hit["y"] + hit["h"] // 2]}


# The bet-size input inside the table's action strip (present on raise turns).
_FIND_INPUT_JS = r"""(() => {
  const tf = [...document.querySelectorAll('iframe')].find(f => (f.src || '').includes('playMode'));
  if (!tf || !tf.contentDocument) return {practice: false, inputs: []};
  const d = tf.contentDocument, fb = tf.getBoundingClientRect();
  const inputs = [...d.querySelectorAll('input, [contenteditable=true]')].map(el => {
    const r = el.getBoundingClientRect();
    return {r, value: el.value ?? el.textContent, type: el.type || 'editable'};
  }).filter(i => i.r.width > 0 && i.r.height > 0 && i.r.y > fb.height * 0.6)
    .map(i => ({x: Math.round(fb.x + i.r.x + i.r.width / 2),
                y: Math.round(fb.y + i.r.y + i.r.height / 2),
                value: String(i.value), type: i.type}));
  return {practice: (tf.src || '').includes('playMode=fun'), inputs};
})()"""


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


def raise_to(amount: str) -> dict:
    """Custom raise: type an exact BB amount into the client's own bet field
    (triple-click selects the old value, insertText replaces it), then press
    its RAISE TO button. Assistive relay of a user-entered amount — see act()."""
    amount = amount.strip().replace(",", ".")
    if not re.fullmatch(r"\d{1,6}(\.\d{1,2})?", amount):
        return {"ok": False, "reason": f"bad amount {amount!r} — digits only, in BB"}
    t = ignition_target()
    if not t:
        return {"ok": False, "reason": "poker client not open"}
    ws = t["webSocketDebuggerUrl"]
    try:
        d = cdp._eval(ws, _FIND_INPUT_JS, timeout=6) or {}
    except Exception as e:
        return {"ok": False, "reason": f"input lookup failed: {e}"}
    if not d.get("inputs"):
        return {"ok": False, "reason": "no bet input on screen — not a raise spot?"}
    inp = d["inputs"][0]
    base = {"x": inp["x"], "y": inp["y"], "button": "left"}
    _cdp_seq(ws, [
        ("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": inp["x"], "y": inp["y"]}),
        ("Input.dispatchMouseEvent", {**base, "type": "mousePressed", "clickCount": 1}),
        ("Input.dispatchMouseEvent", {**base, "type": "mouseReleased", "clickCount": 1}),
        ("Input.dispatchMouseEvent", {**base, "type": "mousePressed", "clickCount": 3}),
        ("Input.dispatchMouseEvent", {**base, "type": "mouseReleased", "clickCount": 3}),
        ("Input.insertText", {"text": amount}),
    ])
    time.sleep(0.25)
    res = act("RAISE TO", "action")
    return {"ok": res.get("ok", False), "typed": amount, "confirm": res}


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

    def _send(self, code: int, ctype: str, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The dashboard app (localhost:2100) drives the state tester cross-
        # origin; everything here is already loopback-only.
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
            if path in ("/", "/panel"):
                self._send(200, "text/html; charset=utf-8",
                           (ROOT / "panel.html").read_bytes())
            elif path == "/state":
                light = "light=1" in (self.path.split("?", 1) + [""])[1]
                self._send(200, "application/json",
                           json.dumps(state(light=light)).encode())
            elif path == "/table":
                self._send(200, "application/json", json.dumps(table_state()).encode())
            elif path == "/faketable":
                # Outer page: an iframe whose src carries playMode, so the
                # reader's frame search finds the table below.
                self._send(200, "text/html; charset=utf-8",
                           faketable.render_outer("/faketable/frame?playMode=fun")
                           .encode())
            elif path == "/faketable/frame":
                spec = _faketable_spec or faketable.EXAMPLE_SPEC
                self._send(200, "text/html; charset=utf-8",
                           faketable.render_inner(spec).encode())
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
                        res = cdp._eval(t["webSocketDebuggerUrl"], """(() => {
                            const f = document.querySelector('iframe');
                            return (f && f.contentWindow.__lastClick)
                                   || window.__lastClick || null;
                        })()""", timeout=4)
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
                self._send(500, "text/plain", str(e).encode())
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
            elif path == "/study-answers":       # the toggle (CONTRACT.md §3)
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                _study["on"] = bool(body.get("on"))
                if not _study["on"]:
                    _study["text"] = None        # switch off = card goes blank now
                print(f"[study] answers {'ON' if _study['on'] else 'off'}")
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
                _study["at"] = time.time()
                self._send(200, "application/json", json.dumps({"ok": True}).encode())
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
                self._send(500, "text/plain", str(e).encode())
            except Exception:
                pass


def chrome_window(url: str, profile: str, x: int, y: int, w: int, h: int,
                  cdp_port: int | None = None) -> subprocess.Popen:
    """One app-mode (chromeless, PWA-style) Chrome window. Each window gets its
    own user-data-dir: that keeps it a separate process, which is what makes
    the --window-position/--window-size flags and the CDP port actually stick
    (a shared profile would just join the existing process and ignore them)."""
    args = [CHROME, f"--app={url}", f"--user-data-dir={ROOT / profile}",
            f"--window-position={x},{y}", f"--window-size={w},{h}",
            "--no-first-run", "--no-default-browser-check"]
    if cdp_port:
        args.insert(2, f"--remote-debugging-port={cdp_port}")
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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
    out = []
    try:
        for p in psutil.process_iter(["pid", "name", "cmdline"]):
            if p.info["pid"] == me:
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
        "actSeen": set(), "foldedSeats": set(),
        "domGraceUntil": time.time() + 1e9,
    })
    _action_grace_until = time.time() + 1e9

    # A browser for the page: reuse a /faketable tab on the CDP port, retarget
    # an existing CDP browser via DevTools' HTTP API, or launch the standard
    # table window at the fake URL if no CDP browser exists at all.
    url = f"http://127.0.0.1:{PANEL_PORT}/faketable"
    opened = "reused"
    existing = next((t for t in (cdp.page_targets(CDP_PORT) or [])
                     if "/faketable" in (t.get("url") or "")), None)
    if existing:
        # The page renders the spec at REQUEST time, so a tab already showing
        # a previous state must be reloaded or the test runs against the old
        # spot. Both documents are re-fetched (no-store defeats caching).
        try:
            cdp._eval(existing["webSocketDebuggerUrl"],
                      "location.reload(); true", timeout=4)
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
    print("[faketable] test mode off")
    return {"ok": True}


def _stand_down() -> None:
    """Archive the hand in flight, then go. Runs off the request thread so the
    /quit response is delivered before the process ends.

    os._exit rather than srv.shutdown(): the main thread parks in a long sleep
    and the tap/feed threads are daemons, so a graceful shutdown would leave
    the process alive and the port held — the very thing being fixed.
    """
    time.sleep(0.2)
    try:
        _archive_hand()
    except Exception:
        pass
    print("[panel] standing down for a new instance")
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
        print(f"[panel] serving on http://127.0.0.1:{PANEL_PORT}/panel")

    # Prefer the secondary monitor when one is attached.
    area = target_area()
    w, h, ax, ay = area["w"], area["h"], area["x"], area["y"]
    table_w = int(w * TABLE_FRAC)
    # Idempotent: a rerun while windows are already open just restarts the
    # panel server, it never spawns duplicate browser windows.
    # In test mode the TABLE IS THE FAKE TABLE. Everything downstream reads it
    # exactly as it reads Ignition, so the layout, the panel and the answer
    # pipeline are the real ones being exercised — not a mock of them.
    table_url = (f"http://127.0.0.1:{PANEL_PORT}/faketable" if _fake_mode
                 else IGNITION_URL)
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
    else:
        chrome_window(table_url, PROFILE_TABLE, ax, ay, table_w, h, CDP_PORT)
        print(f"[table] {'fake' if _fake_mode else 'Ignition'} app window "
              f"{table_w}x{h} (CDP :{CDP_PORT})")
        for _ in range(40):  # wait for CDP before opening the panel beside it
            if cdp.available(CDP_PORT):
                break
            time.sleep(0.5)
        print(f"[table] CDP {'up' if cdp.available(CDP_PORT) else 'NOT up (panel will keep retrying)'}")

    if hwnd := ctypes.windll.user32.FindWindowW(None, PANEL_TITLE):
        # A double-click must always DO something visible: surface the panel.
        ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        ctypes.windll.user32.SetForegroundWindow(hwnd)
        print("[panel] window already open — brought to front")
    else:
        chrome_window(f"http://127.0.0.1:{PANEL_PORT}/panel", PROFILE_PANEL,
                      ax + table_w, ay, w - table_w, h)
        print(f"[panel] window beside table ({w - table_w}x{h})")

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
    print("Ctrl+C stops the panel server (browser windows stay open).")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
