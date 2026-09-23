"""CoinPoker live table feed, read from the client's own log.

CoinPoker tables are a separate Unity program (no CDP), but the Unity table
relays every server command to the Electron lobby over a named pipe and the
lobby logs each one to %APPDATA%/CoinPoker/logs/main.log:

    2026-09-22 04:31:35:697 [info]  [UNITY] Stdout: ... cmd - game.potInfo
    [Method] -> SendMessageToPipe - {"EventName":"extension_event",...
        "Data":{"cmd_bean":{"BeanData":"{...json...}","Cmd":"game.potInfo",
        "RoomName":"31st NL HU 0.05-0.10 EV-INRIT-(A) 1392337"},...}}

This module tails that file and folds the commands into one hand per room.
The file is opened, read and closed on every poll — never held open — so the
client's log rotation (a rename) is never blocked by us.

    python cpfeed.py            follow live, print the feed
    python cpfeed.py --replay   parse the whole current main.log and exit
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

LOG = Path(os.environ.get("APPDATA", "")) / "CoinPoker" / "logs" / "main.log"
HERO = os.environ.get("CP_HERO", "megturism0")

_RANK = {"TWO": "2", "THREE": "3", "FOUR": "4", "FIVE": "5", "SIX": "6",
         "SEVEN": "7", "EIGHT": "8", "NINE": "9", "TEN": "T", "JACK": "J",
         "QUEEN": "Q", "KING": "K", "ACE": "A"}
_SUIT = {"SPADES": "s", "HEARTS": "h", "DIAMONDS": "d", "CLUBS": "c"}
STREETS = ("FLOP", "TURN", "RIVER")
# game.seat captions that are real actions (the rest — Inuse, Sitout,
# Disconnected — are seat status, not play)
ACTIONS = {"SB", "BB", "Ante", "AutoBB", "Fold", "Check", "Call", "Raise", "AllIn"}


def card(c: dict | None) -> str | None:
    if not c:
        return None
    return _RANK.get(c.get("value", ""), "?") + _SUIT.get(c.get("suit", ""), "?")


def parse_line(line: str) -> tuple[str, dict] | None:
    """One log line -> (cmd, {room, bean}) for SendMessageToPipe command beans."""
    i = line.find("SendMessageToPipe - {")
    if i < 0:
        return None
    try:
        m = json.loads(line[i + 20:])
    except ValueError:
        return None
    d = m.get("Data")
    cb = d.get("cmd_bean") if isinstance(d, dict) else None
    if not isinstance(cb, dict) or not cb.get("Cmd"):
        return None
    try:
        bean = json.loads(cb.get("BeanData") or "null")
    except ValueError:
        bean = None
    return cb["Cmd"], {"room": cb.get("RoomName") or d.get("room_name"),
                       "bean": bean if isinstance(bean, dict) else {}}


def _truncated(line: str) -> bool:
    """A SendMessageToPipe line whose JSON does not parse (vs. one that parses
    but carries no command bean, e.g. lobby leaderboard pushes)."""
    i = line.find("SendMessageToPipe - {")
    if i < 0:
        return False
    try:
        json.loads(line[i + 20:])
        return False
    except ValueError:
        return True


def new_hand(hid: str) -> dict:
    return {"id": hid, "sb": None, "bb": None, "ante": None, "button": None,
            "seats": {}, "hero": None, "heroCards": None, "board": [],
            "street": "PREFLOP", "actions": [], "toAct": None, "pot": None,
            "winners": None, "shown": {}, "done": False, "t0": time.time(),
            "streetBet": {},   # name -> total put in on the current street
            "dealt": []}       # seats dealt in (isPlaying goes false on a fold, so
                               # it is snapshotted at the deal, plus anyone who acts)


class Room:
    """Hand state for one table (room)."""

    def __init__(self, name: str):
        self.name = name
        self.seats: dict[int, dict] = {}   # seatId -> {name, chips, playing}
        self.hand: dict | None = None
        self.last: dict | None = None      # the previous finished hand
        self.status: dict[str, str] = {}   # name -> last seat-status caption (Sitout, Inuse…)
        self.finished: list[dict] = []     # finished hands, drained by the archiver
        self.touched = 0.0                 # log time of the last command for this room
        self.closed = False                # hero quit this table (game.quit_table)
        self._ts = None                    # initTimeStamp of the command being applied
        # roomProperties from game.game_alldata (sent when the table opens):
        # coinType 1 = real money (USDT), 2 = practice chips; rake, blinds, size
        self.props: dict = {}
        self.sitout: dict = {}             # hero's sitOutMap (game.sitout echo)

    @property
    def coin_type(self):
        return self.props.get("coinType")

    @property
    def practice(self) -> bool:
        """True ONLY when the server said so (coinType 2). Unknown = not practice."""
        return self.props.get("coinType") == 2

    def _finish(self) -> None:
        if self.hand and not self.hand["done"]:
            self.hand["done"] = True
            self.hand["tEnd"] = time.time()
            self.last = self.hand
            self.finished.append(self.hand)

    def _hand_for(self, hid: str | None) -> dict:
        if hid and (not self.hand or self.hand["id"] != hid):
            self._finish()
            self.hand = new_hand(hid)
            # server time (ms) of the hand's first message — the replay-safe
            # "played at" (t0 is wall time of processing, wrong on a backfill)
            ts = str(self._ts or "")
            self.hand["serverT0"] = int(ts) if ts.isdigit() else None
        if not self.hand:
            self.hand = new_hand(hid or "?")
        return self.hand

    def apply(self, cmd: str, b: dict, at: float | None = None) -> list[str]:
        """Fold one command in; returns human-readable feed lines. `at` is the
        log line's own time (epoch s) — NOT the time we read it, which on a
        backfill would make a long-closed table look live."""
        out: list[str] = []
        self.touched = at or time.time()
        self.closed = False
        self._ts = b.get("initTimeStamp")
        hid = b.get("gameHandId") or b.get("gameId")
        if cmd == "game.game_alldata":
            self.props = b.get("roomProperties") or {}
            return out
        if cmd == "game.sitout":
            self.sitout = b.get("sitOutMap") or {}
            on = [k for k, v in self.sitout.items() if v]
            out.append("hero sit-out: " + (", ".join(on) if on else "off"))
            return out
        if cmd == "game.seatInfo":
            for s in b.get("seatResponseDataList") or []:
                if s.get("userName"):
                    self.seats[s["seatId"]] = {"name": s["userName"],
                                               "chips": s.get("userChips"),
                                               "playing": s.get("isPlaying")}
                else:
                    self.seats.pop(s.get("seatId"), None)
            if self.hand and not self.hand["done"]:
                self.hand["seats"] = {k: dict(v) for k, v in self.seats.items()}
            return out
        if cmd == "game.pre_hand_start_info":
            h = self._hand_for(hid)
            h.update(sb=b.get("sbAmount"), bb=b.get("bbAmount"),
                     ante=b.get("anteAmount"), button=b.get("dealerSeatId"))
            h["seats"] = {k: dict(v) for k, v in self.seats.items()}
            h["stacks"] = {s["name"]: s["chips"] for s in h["seats"].values()
                           if s.get("chips") is not None}
            h["startStacks"] = dict(h["stacks"])   # stacks mutates per action
            for sid, s in h["seats"].items():
                if s["name"] == HERO:
                    h["hero"] = sid
            h["dealt"] = sorted(sid for sid, s in h["seats"].items() if s.get("playing"))
            btn = h["seats"].get(h["button"], {}).get("name", h["button"])
            out.append(f"--- hand {h['id']}  {h['sb']}/{h['bb']}"
                       + (f" ante {h['ante']}" if h["ante"] else "")
                       + f"  button {btn}  | "
                       + ", ".join(f"{s['name']} {s['chips']}" for s in h["seats"].values()))
            return out
        if cmd == "game.game_start":
            h = self._hand_for(hid)
            h["button"] = b.get("dealerSeatId", h["button"])
            return out
        if cmd == "game.hole_cards":
            h = self._hand_for(hid)
            h["heroCards"] = [card(c) for c in b.get("holeCards") or []]
            if h.get("hero") is not None and h["hero"] not in h["dealt"]:
                h["dealt"] = sorted(h["dealt"] + [h["hero"]])
            out.append(f"HERO dealt {''.join(h['heroCards'])}")
            return out
        if cmd == "game.seat":
            cap = b.get("caption")
            if cap not in ACTIONS:
                if b.get("userName"):
                    self.status[b["userName"]] = cap
                return out
            if not self.hand:
                return out
            h = self._hand_for(hid)
            name = b.get("userName")
            to = float(b.get("betAmout") or 0)
            # betAmout is the player's TOTAL on this street; the ante is its
            # own pot contribution, not part of the street bet
            prev = 0.0 if cap == "Ante" else h["streetBet"].get(name, 0.0)
            label = b.get("newCaption") or cap   # "Bet" vs "Raise"
            added = 0.0 if cap == "Fold" else round(max(to - prev, 0), 4)
            a = {"street": h["street"], "seat": b.get("seatId"), "name": name,
                 "action": label, "to": to, "added": added,
                 "stack": b.get("userChips"), "t": b.get("initTimeStamp")}
            if cap not in ("Fold", "Ante"):
                h["streetBet"][name] = to
            # invariant: previous stack - chips added == the stack the server reports
            st = h.setdefault("stacks", {})
            if name in st and b.get("userChips") is not None \
                    and abs(st[name] - added - b["userChips"]) > 0.005:
                a["mismatch"] = round(st[name] - added - b["userChips"], 4)
                out.append(f"  !! stack mismatch for {name}: expected "
                           f"{st[name] - added:.2f}, server says {b['userChips']}")
            if b.get("userChips") is not None:
                st[name] = b["userChips"]
            h["actions"].append(a)
            if a["seat"] is not None and a["seat"] not in h["dealt"] and cap != "Ante":
                h["dealt"] = sorted(h["dealt"] + [a["seat"]])
            if cap not in ("SB", "BB", "Ante", "AutoBB"):
                self.status[name] = "Inuse"
            if h.get("toAct") == name:
                h["toAct"] = None          # the turn is spent
            if b.get("seatId") in h["seats"]:
                h["seats"][b["seatId"]]["chips"] = b.get("userChips")
            who = "HERO" if name == HERO else name
            amt = "" if label in ("Fold", "Check") else f" {to:g}"
            out.append(f"  {h['street'][:4].lower()}  {who} {label}{amt}  (stack {b.get('userChips')})")
            return out
        if cmd == "game.dealer_cards":
            h = self._hand_for(hid)
            dc = b.get("dealerCards") or {}
            board = []
            for st in STREETS:
                board += [card(c) for c in dc.get(st) or []]
            if len(board) > len(h["board"]):
                h["board"] = board
                h["street"] = {3: "FLOP", 4: "TURN", 5: "RIVER"}.get(len(board), h["street"])
                h["streetBet"] = {}
                out.append(f"  == {h['street']} {' '.join(board)}")
            return out
        if cmd == "game.user_turn":
            h = self._hand_for(hid)
            h["toAct"] = b.get("whoseTurn")
            h["turnAt"] = time.time()
            opts = b.get("userTurnOptions")
            h["heroOptions"] = ({k: b.get(k) for k in ("callAmount", "potRaiseValue",
                                                        "potAmount", "roundMaxBet", "totalPot")}
                                | {"options": opts}) if b.get("whoseTurn") == HERO else None
            if b.get("whoseTurn") == HERO:
                out.append(f"  >>> HERO TO ACT  pot {b.get('totalPot')}  call {b.get('callAmount')}")
            return out
        if cmd == "game.potInfo":
            if self.hand:
                self.hand["pot"] = b.get("totalPotAmount")
            return out
        if cmd in ("game.show_hole_cards", "game.reveal_cards"):
            if self.hand:
                for u in b.get("userCardListMap") or []:
                    # keyed by seatId (userCardListMap: [{seatId, cards}])
                    nm = (u.get("userName") or u.get("playerName")
                          or self.hand["seats"].get(u.get("seatId"), {}).get("name")
                          or self.seats.get(u.get("seatId"), {}).get("name"))
                    if nm in self.hand["shown"]:
                        continue
                    cs = u.get("cards") or u.get("holeCards") or []
                    if nm and cs:
                        self.hand["shown"][nm] = [card(c) for c in cs]
                        out.append(f"  shows {nm} {''.join(self.hand['shown'][nm])}")
            return out
        if cmd == "game.winnerInfo":
            if self.hand:
                w = []
                for pot in b.get("winnerDataList") or []:
                    for x in (pot.get("winnerDetails") or {}).get("winnerList") or []:
                        w.append({"name": x.get("playerName"), "won": x.get("winAmountFromPot"),
                                  "pot": pot.get("potAmount"),
                                  "potAfterRake": pot.get("potAmountAfterRake")})
                self.hand["winners"] = w
                out.append("  wins: " + ", ".join(f"{x['name']} {x['won']} (pot {x['pot']}, "
                                                  f"after rake {x['potAfterRake']})" for x in w))
            return out
        if cmd in ("game.quit_table", "game.leave_Seat"):
            # our own client's command: hero stood up / closed the window
            self._finish()
            if cmd == "game.quit_table":
                self.closed = True
                self.hand = None
            out.append("hero left the table" if cmd == "game.quit_table" else "hero left the seat")
            return out
        if cmd == "game.return_chips":
            # an uncalled bet coming back: it went in as an action, so the
            # hero's net has to add it back (winAmountFromPot excludes it)
            if self.hand and b.get("chipsToReturn"):
                sid = b.get("seatId")
                ret = self.hand.setdefault("returned", {})
                ret[sid] = round(ret.get(sid, 0) + float(b["chipsToReturn"]), 4)
                nm = self.hand["seats"].get(sid, {}).get("name", sid)
                out.append(f"  returned {b['chipsToReturn']} to {nm} (uncalled)")
            return out
        if cmd == "game.reset_data":
            self._finish()
            return out
        return out


# ---- ParsedHand export (ignition CONTRACT.md §1a) --------------------------

_SUIT_GLYPH = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}
_TYPE = {"SB": "post-sb", "BB": "post-bb", "AutoBB": "post-bb", "Fold": "fold",
         "Check": "check", "Call": "call", "Bet": "bet", "Raise": "raise",
         "AllIn": "all-in"}


def glyph(c: str | None) -> str | None:
    """'Ts' -> 'T♠' — the contract's card form (ranks use T, never 10)."""
    return c[0] + _SUIT_GLYPH.get(c[1], c[1]) if c and len(c) == 2 else None


def positions(dealt: list[int], button: int | None) -> dict[int, str]:
    """gto-trainer vocabulary, button-backwards (ignition's _positions_all)."""
    if not dealt or button is None:
        return {}
    seats = sorted(set(dealt) | {button})
    i = seats.index(button)
    order = seats[i + 1:] + seats[:i + 1]          # SB … BTN
    n = len(order)
    if n == 2:
        other = next(s for s in order if s != button)
        return {button: "SB", other: "BB"}         # heads-up: the button posts the SB
    if n == 3:
        names = ["SB", "BB", "BTN"]
    else:
        mids = (["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO"] if n > 6
                else ["UTG", "HJ", "CO"])[-(n - 3):]
        names = ["SB", "BB"] + mids + ["BTN"]
    return dict(zip(order, names))


def export(room: Room) -> dict | None:
    """The room's current hand as a ParsedHand (amounts in BB), or None
    between hands. Everything comes from the server's own messages, so there
    is one source of truth: no buttons/DOM cross-check exists here."""
    h = room.hand
    if not h or h["done"] or not h.get("bb"):
        return None
    bb = float(h["bb"])
    r2 = lambda v: round(v / bb, 2) if v is not None else None  # noqa: E731
    name_seat = {s["name"]: sid for sid, s in h["seats"].items()}
    hero = h.get("hero")
    dealt = list(h["dealt"])
    pos = positions(dealt, h.get("button"))
    street = h["street"].lower()
    actions, committed, pot, ante = [], {}, 0.0, 0.0
    for a in h["actions"]:
        pot += a["added"]
        sid = a["seat"] if a["seat"] is not None else name_seat.get(a["name"])
        if a["action"] == "Ante":
            ante += a["added"]
            continue
        t = _TYPE.get(a["action"])
        if not t:
            continue
        rec = {"seatId": sid, "hero": sid == hero and hero is not None,
               "type": t, "street": a["street"].lower()}
        # raise/bet/all-in = the seat's round total ("raises to"); call = the top-up
        if t not in ("check", "fold"):
            rec["amount"] = r2(a["added"] if t == "call" else a["to"])
        actions.append(rec)
    for name, v in h["streetBet"].items():
        if name in name_seat:
            committed[name_seat[name]] = r2(v)
    max_bet = max(h["streetBet"].values(), default=0.0)
    hero_name = h["seats"].get(hero, {}).get("name") if hero is not None else None
    hero_owed = max(0.0, max_bet - h["streetBet"].get(hero_name, 0.0)) if hero_name else 0.0
    folded = {a["seatId"] for a in actions if a["type"] == "fold"}
    hero_folded = hero is not None and hero in folded
    villains = [s for s in dealt if s != hero]
    hero_won = (hero is not None and not hero_folded and bool(villains)
                and all(s in folded for s in villains))
    to_act_name = h.get("toAct")
    to_act_seat = name_seat.get(to_act_name) if to_act_name else None
    to_act_hero = (to_act_seat is not None and to_act_seat == hero
                   and not hero_folded and not h.get("winners"))
    st = room.status.get(hero_name or "", "")
    status = ("not-in-hand" if hero is None or hero not in dealt
              else "folded" if hero_folded
              else "in-hand" if h.get("heroCards")
              else "sitting-out" if st == "Sitout" else "unknown")
    why = (None if to_act_hero
           else "no hero seat" if hero is None
           else "hero folded" if hero_folded
           else "hand won" if hero_won or h.get("winners")
           else f"action on seat {to_act_seat}" if to_act_seat is not None
           else "action-on unknown")
    return {
        "handId": int(h["id"]) if str(h["id"]).isdigit() else h["id"],
        "clientHandId": h["id"],
        "site": "coinpoker",
        "room": room.name,
        "coinType": room.coin_type,          # 1 real money, 2 practice, None unknown
        "practice": room.practice,
        "sitOut": dict(room.sitout),
        "bb": bb, "sb": h.get("sb"), "ante": h.get("ante") or 0,
        "bbCents": round(bb * 100),
        "anteBb": r2(ante) or 0,
        "heroSeatId": hero,
        "heroName": hero_name,
        "heroCards": [glyph(c) for c in h.get("heroCards") or []],
        "board": [glyph(c) for c in h["board"]],
        "street": street,
        "actions": actions,
        "liveSeats": dealt,
        "committed": committed,
        "potByStreet": {},
        "positions": pos,
        "names": {sid: s["name"] for sid, s in h["seats"].items()},
        "stacks": {name_seat[n]: r2(v) for n, v in (h.get("stacks") or {}).items()
                   if n in name_seat} or None,
        "currentNode": {
            "street": street,
            "toActSeatId": to_act_seat,
            "toActIsHero": to_act_hero,
            "pot": r2(pot) or 0,
            "toCall": r2(hero_owed) or 0,
            "legalActions": [],
            "complete": False,
        },
        "heroFolded": hero_folded,
        "heroWon": hero_won,
        "ended": hero_folded or hero_won or bool(h.get("winners")),
        "buttonsUp": None,     # the Unity table's buttons are not readable
        "toActSources": {"buttons": None, "ws": to_act_hero,
                         "actionOn": to_act_seat, "wsAt": h.get("turnAt"),
                         "timeBank": None},
        "heroStatus": status,
        "notToActWhy": why,
        "lineSource": "log",
        "lineUncertain": None,
        "lineNote": None,
    }


class Feed:
    """Tails main.log; rooms keyed by RoomName."""

    def __init__(self, path: Path = LOG, from_start: bool = False,
                 backfill: int = 3_000_000):
        """from_start reads the whole file; otherwise the last `backfill` bytes
        are replayed first, so a reader started mid-hand still has the hand's
        blinds, seats and hole cards (the first, partial line is dropped)."""
        self.path = path
        self.rooms: dict[str, Room] = {}
        size = path.stat().st_size if path.exists() else 0
        self.pos = 0 if from_start else max(0, size - backfill)
        self._skip_partial = self.pos > 0
        self.line_at: float | None = None  # epoch s of the latest log-line prefix
        self._buf = ""
        self._pending: str | None = None   # a SendMessageToPipe line cut mid-JSON
        self._tries = 0
        self.unknown: dict[str, int] = {}
        self.broken = 0                    # split messages we could not rejoin

    def _join(self, line: str) -> tuple[str, dict] | None:
        """The logger cuts long Unity stdout writes into chunks at arbitrary
        byte offsets; each continuation starts on a fresh line with its own
        '<ts> [info]  [UNITY] Stdout: ' prefix (seen splitting a gameHandId in
        two). Rejoin a SendMessageToPipe line that fails to parse with the
        following chunk(s)."""
        line = line.rstrip("\r")
        m = _PREFIX.match(line)
        if m:
            self.line_at = _line_time(m.group(0)) or self.line_at
        content = line[m.end():] if m else line
        if self._pending is not None:
            joined = self._pending + content
            p = parse_line(joined)
            if p:
                self._pending = None
                return p
            self._tries += 1
            if content.startswith("[") or self._tries > 6:
                if "cmd_bean" in self._pending:   # lobby pushes are not game data
                    self.broken += 1
                self._pending = None      # a new record began — give up on the old one
            else:
                self._pending = joined
                return None
        p = parse_line(content)
        if p is None and _truncated(content):
            self._pending, self._tries = content, 0
        return p

    def poll(self) -> list[tuple[str, str]]:
        """Read whatever is new; returns [(room, line)]."""
        try:
            size = self.path.stat().st_size
        except OSError:
            return []
        if size < self.pos:          # rotated — the new main.log starts over
            self.pos, self._buf = 0, ""
        if size == self.pos:
            return []
        with open(self.path, "rb") as fh:
            fh.seek(self.pos)
            chunk = fh.read(size - self.pos)
        self.pos = size
        text = self._buf + chunk.decode("utf-8", errors="replace")
        lines = text.split("\n")
        self._buf = lines.pop()      # partial last line waits for the next poll
        if self._skip_partial and lines:
            lines.pop(0)             # backfill began mid-line
            self._skip_partial = False
        out = []
        for line in lines:
            p = self._join(line)
            if not p:
                # closing a table never reaches the pipe as a bean — the window
                # is gone — but the Unity side still logs the command it handled
                q = _QUIT.search(line)
                if q and q.group(1) in self.rooms:
                    out += [(q.group(1), s) for s in
                            self.rooms[q.group(1)].apply("game.quit_table", {}, self.line_at)]
                continue
            cmd, d = p
            room = d["room"] or "?"
            r = self.rooms.setdefault(room, Room(room))
            before = len(out)
            out += [(room, s) for s in r.apply(cmd, d["bean"], self.line_at)]
            if len(out) == before and cmd.startswith("game.") and cmd not in _QUIET:
                self.unknown[cmd] = self.unknown.get(cmd, 0) + 1
        return out


    def active(self) -> Room | None:
        """The table hero plays: the most recently active room where hero is
        seated; else the most recently active room at all."""
        rooms = sorted(self.rooms.values(), key=lambda r: r.touched, reverse=True)
        rooms = [r for r in rooms if not r.closed]
        seated = [r for r in rooms if any(s["name"] == HERO for s in r.seats.values())]
        return (seated or rooms or [None])[0]

    def drain_finished(self) -> list[tuple[Room, dict]]:
        out = []
        for r in self.rooms.values():
            out += [(r, h) for h in r.finished]
            r.finished = []
        return out


def _line_time(prefix: str) -> float | None:
    """'2026-09-22 04:47:27:083 [info] ...' -> epoch seconds (local clock)."""
    try:
        return time.mktime(time.strptime(prefix[:19], "%Y-%m-%d %H:%M:%S")) + int(prefix[20:23]) / 1000
    except (ValueError, OverflowError):
        return None


_QUIT = re.compile(r"TransformToBean - RoomName - (.+?) cmd - game\.quit_table\s*$")
_PREFIX = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d:\d{3} \[\w+\]\s+\[UNITY\] Stdout: ")

_QUIET = {"game.dealer_chat", "game.dealer_chat_action", "game.wait_list_data",
          "game.wait_list_status", "game.game_ready", "game.return_chips",
          "game.cumulativeWinnerInfo", "game.seatInfo", "game.potInfo",
          "game.game_start", "game.user_turn", "game.reset_data"}


def main() -> None:
    replay = "--replay" in sys.argv
    only = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--room=")), None)
    f = Feed(from_start=replay)
    while True:
        for room, line in f.poll():
            if only and only not in room:
                continue
            print(f"[{room.split()[-1]}] {line}", flush=True)
        if replay:
            break
        time.sleep(0.15)
    if replay:
        print("unhandled commands:", f.unknown, "| unjoinable split messages:", f.broken)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
