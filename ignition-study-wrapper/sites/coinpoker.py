"""CoinPoker as a Poker Wrapper site.

Ignition is read through its web client (CDP + the game's WebSocket) by
launch.py itself. CoinPoker cannot be read that way: each table is a separate
Unity program with no DOM. What it does have is a log — the lobby writes every
server message a table receives to %APPDATA%/CoinPoker/logs/main.log — so the
reader here is cp_feed (a tail of that file) and the presses are cp_actions
(real input on the Unity window, read back by OCR before and confirmed from the
log after). Measured and validated 2026-09-22; see cp_feed / cp_actions.

What launch.py gets from this module is the same things it gets from its own
Ignition reader: the current hand as a ParsedHand (CONTRACT.md §1a), finished
hands to archive, feed lines, and a press for a study pick. It never needs to
know which site answered.

AUTO-EXECUTE HERE IS PRACTICE-ONLY, with no real-money allowance: cp_actions
refuses `auto` unless the server said the table is practice chips (coinType 2).
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path

import psutil

from . import cp_actions as actions
from . import cp_feed as feed

SITE = "coinpoker"
def _find_exe() -> Path:
    """Where the CoinPoker client is: CP_EXE, then the usual install folders (machine-wide or per-user)."""
    env = os.environ.get("CP_EXE")
    cands = [Path(env)] if env else []
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
                 os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs")):
        if base:
            cands.append(Path(base) / "CoinPoker" / "CoinPoker.exe")
    return next((c for c in cands if c.is_file()), cands[0] if cands else Path("CoinPoker.exe"))


EXE = _find_exe()
# the lobby's DevTools port — 9223 is the GTO Wizard Elite session (2026-09-21)
CDP_PORT = 9235
LOG_STALE_S = 120       # no message from any table this long = no table
# hero's name: feed.HERO (CP_HERO, else learned from the client's log) — read live, it can be learned late

# Formats offered on the setup page. The player takes the seat in the client
# (there is no lobby router for CoinPoker yet); the format labels the session
# and is what a future strategy will be matched against.
FORMATS = [
    # blinds as the lobby lists them (NL25 is ₮0.1/₮0.25, not half the big blind)
    # antes differ by stake: the NL10 EV-INRIT HU table read ante 0 off its own log
    # (2026-09-22); NL200 HU plays 0.2bb/player (Brady, 2026-09-17), which is what
    # the hrc_hu_cp200a charts are solved with. The live ante is read per hand
    # (game.pre_hand_start_info anteAmount), so a table that differs is caught.
    *({"id": f"cp-hu-NL{n}", "site": SITE, "gameType": "hu", "stake": f"NL{n}", "seats": 2,
       "name": f"CoinPoker NL{n} Heads-Up", "sb": sb, "bb": bb, "anteBb": ante, "currency": "USDT",
       "_doc": f"₮{sb:g}/₮{bb:g} heads-up, " + (f"ante {ante:g}bb/player" if ante else "no ante" if ante == 0 else "ante not yet read off a table")}
      for n, sb, bb, ante in ((10, 0.05, 0.1, 0), (25, 0.1, 0.25, None), (50, 0.25, 0.5, None),
                              (100, 0.5, 1.0, None), (200, 1.0, 2.0, 0.2))),
    *({"id": f"cp-ring-NL{n}-6", "site": SITE, "gameType": "ring", "stake": f"NL{n}", "seats": 6,
       "name": f"CoinPoker NL{n} 6-max", "sb": sb, "bb": bb, "currency": "USDT",
       "_doc": f"₮{sb:g}/₮{bb:g} 6-max ring (the ANTE tables add 16% of a bb)"}
      for n, sb, bb in ((10, 0.05, 0.1), (25, 0.1, 0.25), (50, 0.25, 0.5), (100, 0.5, 1.0))),
    {"id": "cp-practice", "site": SITE, "gameType": "practice", "stake": None, "seats": 6,
     "name": "CoinPoker Practice", "bb": None, "currency": "practice chips",
     "_doc": "Practice Games tab — play chips (Claim Chips = 500K a day); the only tables auto-execute arms on"},
]


class Site:
    id = SITE

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.feed: feed.Feed | None = None
        self.error: str | None = None
        self._thread: threading.Thread | None = None
        self._on_line = None
        self._on_finished = None
        # THE ATTACHED TABLE (2026-09-23): the room the session chose on the setup page. While set, the wrapper
        # reads that table and no other — a quiet table stays attached, and a busier one never steals the panel.
        # None = the old behaviour (the most recently active table, seated first).
        self.pinned: str | None = None

    def attach(self, room: str | None) -> None:
        with self.lock:
            self.pinned = room or None

    @staticmethod
    def open_rooms() -> dict[str, int]:
        """The tables OPEN in the client right now — joined, seated or not: each is its own CoinPoker.exe started
        with roomName=<room> (the hidden --prewarm instance has none). {room: pid}."""
        out: dict[str, int] = {}
        for p in psutil.process_iter(["name", "cmdline"]):
            try:
                if (p.info["name"] or "").lower() != "coinpoker.exe":
                    continue
                room = next((a[len("roomName="):] for a in p.info["cmdline"] or [] if a.startswith("roomName=")), None)
                if room:
                    out[room] = p.pid
            except (psutil.Error, TypeError):
                continue
        return out

    @staticmethod
    def _format_for(props: dict) -> str | None:
        """The FORMATS id this table is, from its roomProperties (size, big blind, practice chips)."""
        if not props:
            return None
        if props.get("coinType") == 2:
            return "cp-practice"
        size, bb = props.get("maxSize"), props.get("bigBlind")
        kind = "hu" if size == 2 else "ring" if size == 6 else None
        return next((f["id"] for f in FORMATS if f.get("gameType") == kind and f.get("bb") is not None
                     and bb is not None and abs(f["bb"] - bb) < 1e-9), None)

    @staticmethod
    def label(room: str, props: dict | None) -> dict:
        """A table as a person reads it: "NL HU 0.10-0.25 · ante 0.04" — game, size, blinds, ante — from the
        table's own roomProperties, else parsed out of the room name ("31st NL HU 0.05-0.10 EV-INRIT-(A)
        1392766" is the lobby's internal name). `number` is the room's id, for telling two same-stakes tables
        apart; the page shows it only when two labels collide."""
        import re as _re
        p = props or {}
        amt = lambda x: f"{x:.2f}" if x < 1 else f"{x:g}"
        game = "PLO" if "PLO" in room.upper() else "NL"
        size = p.get("maxSize")
        kind = "HU" if size == 2 else f"{size}-max" if size else None
        sb, bb, ante = p.get("smallBlind"), p.get("bigBlind"), p.get("ante")
        if sb is not None and bb is not None:
            text = " ".join(x for x in (game, kind, f"{amt(sb)}-{amt(bb)}") if x)
            if ante:
                text += f" · ante {amt(ante)}"
        else:                                   # properties not logged yet: what the name says
            m = _re.search(r"\b(NL|PLO)\s*(HU|\d-max)?\s*([\d.]+-[\d.]+)", room, _re.I)
            text = " ".join(x for x in (m.group(1).upper(), m.group(2), m.group(3)) if x) if m else _re.sub(r"\s*\d{5,}$", "", room)
            if m and "ANTE" in room.upper():
                text += " · ante"
        num = _re.search(r"(\d{5,})\s*$", room)
        return {"label": text, "number": num.group(1) if num else None}

    def open_tables(self) -> list[dict]:
        """What the setup page lists to attach to: every open table, with what its log has said about it
        (stakes, size, real or practice chips, who sits there). A table opened a moment ago may not have
        logged its properties yet — it is listed anyway, with those fields empty."""
        rooms = self.open_rooms()
        out = []
        with self.lock:
            known = self.feed.rooms if self.feed else {}
            for name in rooms:
                r = known.get(name)
                p = r.props if r else {}
                seated = [s["name"] for s in r.seats.values()] if r else []
                out.append({
                    "room": name, **self.label(name, p), "attached": name == self.pinned,
                    "practice": bool(r and r.practice), "coinType": p.get("coinType"),
                    "sb": p.get("smallBlind"), "bb": p.get("bigBlind"), "ante": p.get("ante"),
                    "maxSize": p.get("maxSize"), "players": len(seated),
                    "heroSeated": bool(feed.HERO) and feed.HERO in seated,
                    "lastEventAgo": round(time.time() - r.touched, 1) if r and r.touched else None,
                    "format": self._format_for(p),
                })
        out.sort(key=lambda t: (not t["heroSeated"], t["lastEventAgo"] if t["lastEventAgo"] is not None else 1e9))
        return out

    # ---- the reader thread ------------------------------------------------
    def start(self, on_line=None, on_finished=None) -> None:
        """Tail the log. Cheap (a file read every 150 ms), so it may run for
        the life of the process; the callbacks decide whether it matters."""
        self._on_line, self._on_finished = on_line, on_finished
        if self._thread:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name="coinpoker-log")
        self._thread.start()

    def _loop(self) -> None:
        while True:
            try:
                with self.lock:
                    if self.feed is None:
                        self.feed = feed.Feed()          # replays the log's tail first
                    lines = self.feed.poll()
                    done = self.feed.drain_finished()
                for room, line in lines:
                    if self._on_line:
                        self._on_line(room, line)
                for room, h in done:
                    if self._on_finished:
                        self._on_finished(room, h)
                self.error = None
            except Exception as e:  # keep tailing through one bad poll
                self.error = f"{type(e).__name__}: {e}"
            time.sleep(0.15)

    # ---- what the wrapper reads -------------------------------------------
    def _room(self):
        f = self.feed
        if self.pinned:
            # attached: that table only — even when it is quiet (no staleness cut-off), gone once you close it
            r = f.rooms.get(self.pinned) if f else None
            return r if r and not r.closed else None
        r = f.active() if f else None
        return r if r and time.time() - r.touched < LOG_STALE_S else None

    def room(self):
        with self.lock:
            return self._room()

    def rooms(self) -> dict:
        with self.lock:
            return dict(self.feed.rooms) if self.feed else {}

    def hand(self) -> dict | None:
        """The active table's hand, ParsedHand-shaped, or None between hands."""
        with self.lock:
            r = self._room()
            return self._decorate(feed.export(r)) if r else None

    def hand_of(self, room):
        def get():
            with self.lock:
                return self._decorate(feed.export(room))
        return get

    @staticmethod
    def _decorate(h: dict | None) -> dict | None:
        if h is not None:
            h.setdefault("tableSlot", None)
        return h

    def export_finished(self, room, h: dict) -> dict | None:
        """A finished hand (from drain_finished) as a ParsedHand."""
        with self.lock:
            save = room.hand
            room.hand = dict(h, done=False)
            try:
                return self._decorate(feed.export(room))
            finally:
                room.hand = save

    def table(self) -> dict | None:
        with self.lock:
            r = self._room()
            if not r:
                return None
            hero = next((s for s in r.seats.values() if s["name"] == feed.HERO), None)
            hero_sid = next((k for k, s in r.seats.items() if s["name"] == feed.HERO), None)
            # DEALT IN = NOT SITTING OUT (2026-09-24). "Sit Out Next Hand" / "Sit Out All" are about the NEXT hand;
            # counting them as sitting out NOW made the study API read hero's live turns as "not hero's turn (no
            # reason given)" for the rest of the hand the box was ticked in (hand 763: the flop bet never asked;
            # hand 754 the same) — the API gates toAct on !heroSittingOut. While hero holds cards in a live hand he
            # is playing it; between hands (or not dealt in) the boxes still mean sitting out.
            live = r.hand if r.hand and not r.hand.get("done") else None
            dealt_in = bool(live and hero_sid is not None and hero_sid in (live.get("dealt") or []))
            flagged = bool(r.sitout.get("sitOutNextHand") or r.sitout.get("sitOutAll") or r.status.get(feed.HERO) == "Sitout")
            return {"room": r.name, **self.label(r.name, r.props), "lastEventAgo": round(time.time() - r.touched, 1),
                    "seats": {str(k): dict(v) for k, v in r.seats.items()},
                    "heroSeated": hero is not None,
                    "heroSittingOut": flagged and not dealt_in,
                    "heroSitOutPending": flagged and dealt_in,      # ticked, takes effect when this hand ends
                    "sitOut": dict(r.sitout), "practice": r.practice, "coinType": r.coin_type,
                    "rake": {k: r.props.get(k) for k in ("rake", "rakeHeadsUp", "rakeCap", "isPotRakePf")
                             if k in r.props} or None,
                    "lastHand": (r.last or {}).get("id")}

    def practice(self) -> bool:
        r = self.room()
        return bool(r and r.practice)

    def hero_status(self) -> str | None:
        """In the /state snapshot vocabulary: in-hand / sitting-out / not-in-hand."""
        t = self.table()
        if not t:
            return None
        if t["heroSittingOut"]:
            return "sitting-out"
        return "in-hand" if t["heroSeated"] else "not-in-hand"

    # ---- presses ------------------------------------------------------------
    def actuate(self, plan: dict, *, auto: bool = False) -> dict:
        """A study pick's plan (launch._pick_plan) as a press on the Unity table.
        Returns launch's _actuate shape: {ok, reason?, clicked?, kind?}."""
        r = self.room()
        if not r:
            return {"ok": False, "reason": "no CoinPoker table in the log"}
        get = self.hand_of(r)
        h = get()
        if not h:
            return {"ok": False, "reason": "no live hand"}
        bb = float(h.get("bb") or 0)
        hero = h.get("heroSeatId")
        total_bb = ((h.get("stacks") or {}).get(hero) or 0) + ((h.get("committed") or {}).get(hero) or 0)
        total = round(total_bb * bb, 4) if bb else None
        if plan.get("kind") == "raise-to":
            try:
                amt_bb = float(plan["amount"])
            except (TypeError, ValueError):
                return {"ok": False, "reason": f"unreadable size {plan.get('amount')!r}"}
            amount = round(amt_bb * bb, 2) if bb >= 0.05 else round(amt_bb * bb)
            if total and amount >= total * 0.999:
                res = actions.act(r, get, "allin", total, auto=auto)
            else:
                res = actions.act(r, get, plan.get("verb") or "raise", amount, auto=auto)
        else:
            label = {"all-in": "allin"}.get(plan.get("label"), plan.get("label"))
            res = actions.act(r, get, label, total if label == "allin" else None, auto=auto)
        out = {"ok": bool(res.get("ok")), "clicked": res.get("label"), "kind": "coinpoker", "result": res}
        if not res.get("ok"):
            out["reason"] = res.get("why")
        return out

    def sitout(self, on: bool, every: bool = False) -> dict:
        r = self.room()
        if not r:
            return {"ok": False, "why": "no CoinPoker table in the log"}
        if not any(s["name"] == feed.HERO for s in r.seats.values()):
            return {"ok": False, "why": f"you are not seated at {r.name} (observing) — nothing to sit out of"}
        return actions.set_sitout(r, on, "sitOutAll" if every else "sitOutNextHand")

    # ---- the client -----------------------------------------------------------
    @staticmethod
    def _lobby_procs() -> list[psutil.Process]:
        out = []
        for p in psutil.process_iter(["name", "cmdline"]):
            try:
                if (p.info["name"] or "").lower() != "coinpoker.exe":
                    continue
                cl = p.info["cmdline"] or []
                # the Electron lobby: not a helper (--type=renderer/gpu/…) and not the Unity
                # table exe — which also runs one hidden `--prewarm` copy with no roomName
                if any(a.startswith("--type=") for a in cl) or "unity-resources" in (cl[0] if cl else "").lower():
                    continue
                out.append(p)
            except (psutil.Error, TypeError):
                continue
        return out

    def client_state(self) -> dict:
        procs = self._lobby_procs()
        cmd = " ".join(procs[0].info["cmdline"] or []) if procs else ""
        return {"running": bool(procs), "cdp": f"--remote-debugging-port={CDP_PORT}" in cmd,
                "log": str(feed.LOG), "logExists": feed.LOG.exists(),
                "logAgeS": round(time.time() - feed.LOG.stat().st_mtime, 1) if feed.LOG.exists() else None}

    def ensure_client(self) -> dict:
        """Start the CoinPoker client if it is not running (with its DevTools
        port, for the lobby). A running client is never restarted: that would
        close every table."""
        st = self.client_state()
        if st["running"]:
            return {"ok": True, "started": False, **st}
        if not EXE.is_file():
            return {"ok": False, "started": False, "error": f"CoinPoker not installed at {EXE}", **st}
        # DETACHED: the client (and every table it opens) must outlive this wrapper —
        # a wrapper restart or End session never takes a CoinPoker table down with it
        subprocess.Popen([str(EXE), f"--remote-debugging-port={CDP_PORT}", "--remote-allow-origins=*"],
                         cwd=str(EXE.parent), close_fds=True,
                         creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
        return {"ok": True, "started": True, **st}

    def preflight(self, room: str | None = None) -> list[dict]:
        """The CoinPoker rows of the setup page's preflight. `room` = the table the session attaches to (chosen
        from the setup page's list of open tables); it must be picked and still open."""
        st = self.client_state()
        t = next((x for x in self.open_tables() if x["room"] == room), None) if room else None
        return [
            {"id": "cp-client", "label": "CoinPoker client", "required": True, "ok": st["running"],
             "detail": ("running" + (f" · lobby DevTools on :{CDP_PORT}" if st["cdp"] else " (without the DevTools port — fine; only the lobby uses it)"))
             if st["running"] else "not running — open CoinPoker and join a table"},
            {"id": "cp-log", "label": "CoinPoker table log readable", "required": True, "ok": st["logExists"],
             "detail": (f"{st['log']} · last written {st['logAgeS']} s ago" if st["logExists"]
                        else f"{st['log']} does not exist — has the client ever run on this machine?")},
            {"id": "cp-table", "label": "Attached table", "required": True, "ok": bool(t),
             "detail": (f"{t['label']} · {'PRACTICE chips' if t['practice'] else 'REAL MONEY' if t['coinType'] == 1 else 'type not logged yet'}"
                        + (" · you are seated" if t["heroSeated"] else " · not seated (the wrapper reads it; sit down to get answers)"))
             if t else (f"{self.label(room, None)['label']} is no longer open in the client — pick another" if room
                        else "pick the table to attach to (join one in the CoinPoker client first)")},
        ]
