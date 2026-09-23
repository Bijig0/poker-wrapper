"""Table FORMATS: what we play, where it lives in the Ignition lobby, how to
get there, and how to tell which one is actually open.

formats.json is the data (captured from the live client 2026-09-07); this
module is the behaviour:

  detect(port)          -> the format of the table the client has open right
                           now, read off the table iframe's query string
                           (gameFormat / seat / playMode / blinds / buy-in).
                           None when no table is open. Independent of anything
                           the session DECLARED — the declaration is compared
                           against this, never the other way round.
  goto(fid, buyin_bb)   -> drive the lobby wizard to the format's table and
                           take a seat with the given buy-in. Every step is
                           verified against the page before the next one runs;
                           the result carries the step log and the detected
                           format of the table we ended up at.
  leave(port)           -> leave the open table (header X -> YES).

All page access is Runtime.evaluate on the client's top page (the lobby and
the table are same-origin iframes, so plain contentDocument access works).
Selectors are deliberately text-based ("Cash games", "NEXT", "TAKE MY SEAT",
the stake label): the client is an Angular app with hashed class names.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from scout import cdp
import tables  # noqa: E402  (which table window this slot owns)

ROOT = Path(__file__).resolve().parent
_PATH = ROOT / "formats.json"
_cache: dict = {"mtime": 0.0, "data": None}


def data() -> dict:
    m = _PATH.stat().st_mtime
    if _cache["data"] is None or m != _cache["mtime"]:
        _cache.update({"mtime": m, "data": json.loads(_PATH.read_text(encoding="utf-8"))})
    return _cache["data"]


def all_formats() -> list[dict]:
    return list(data()["formats"])


def get(fid: str | None) -> dict | None:
    return next((f for f in data()["formats"] if f["id"] == fid), None) if fid else None


def stake_for_bb(bb_cents: int | None) -> str | None:
    """NLxx enum for a real-money big blind in cents (None for practice chips / unknown)."""
    if not bb_cents:
        return None
    for k, v in data()["stakes"].items():
        if isinstance(v, dict) and v.get("bbCents") == bb_cents:
            return k
    return None


def format_id_for(game_type: str, stake: str | None, seats: int | None) -> str | None:
    for f in data()["formats"]:
        if f["gameType"] != game_type:
            continue
        if game_type == "practice":
            # practice identity = section only (stake is detail); seats recorded, not matched
            if f.get("path", {}).get("section") == ("zone" if stake == "zone" else "ring"):
                return f["id"]
            continue
        if f["stake"] == stake and (f["seats"] is None or f["seats"] == seats):
            return f["id"]
    return None


# ----------------------------------------------------------------- page JS

# The lobby iframe: the one whose body carries the left menu.
_LOBBY = r"""
var L = (() => { for (const f of document.querySelectorAll('iframe')) { try { const d = f.contentDocument;
  if (d && d.body && /Poker home/.test(d.body.innerText)) return d; } catch (e) {} } return null; })();
"""
# The seated table iframe (src carries playMode=...), as a param map. Identity
# params (user, txId, connectionUuid, tableId) are never read.
# Slot-aware for the same reason launch._TABLE_JS_TMPL is: four tables live in
# ONE page as sibling iframes tagged `data-multitableslot`, so "the table iframe"
# is no longer a thing that exists. `null` keeps the single-table reading.
_TABLE_JS_TMPL = r"""(() => {__FRAME__
  const SLOT = __SLOT__;
  const f = __frame(SLOT);
  if (!f) return null;
  const keep = ['gameType','gameFormat','seat','playMode','limit','isQuickSeat','quickSeatSmallBlind','quickSeatBigBlind',
                'quickSeatBuyInAmount','quickSeatMinBuyIn','quickSeatMaxBuyIn','waitForBigBlind','tableName','gameTableUrl','currency'];
  const out = {};
  for (const p of ((f.getAttribute('src') || '').split('?')[1] || '').split('&')) {
    const [k, v] = p.split('=');
    if (keep.includes(k)) out[k] = decodeURIComponent(v || '');
  }
  let title = null;
  try { title = (f.contentDocument.body.innerText.match(/[^\n]*Hold'em[^\n]*/) || [])[0] || null; } catch (e) {}
  out._title = title;
  return out;
})()"""


# THE SAME RESOLVER AS launch._FRAME_JS, and for the same reason: "the table
# iframe" is not a thing that exists once the client holds four of them. Anything
# in this module that ACTS on a table resolves it through this, never through the
# first frame that happens to carry playMode.
_FRAME_FN = r"""
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
    """`js` with __FRAME__ defined and __SLOT__ bound to this table's slot."""
    return js.replace("__FRAME__", _FRAME_FN).replace("__SLOT__", "null" if slot is None else str(int(slot)))


def _table_js(slot: int | None = None) -> str:
    return _slotted(_TABLE_JS_TMPL, slot)


def _target(port: int) -> dict | None:
    """The Ignition page THIS wrapper drives.

    ONE PAGE for every table (see launch.ignition_target): the client keeps all
    four tables in a single page as tagged iframes, so the page is shared and the
    slot is resolved INSIDE it (_table_js), never by claiming a window."""
    def rank(u: str) -> int | None:
        low = u.lower()
        return 1 if "poker-game" in low else 2 if "ignition" in low else None

    return tables.pin(cdp.page_targets(port), rank, None)


def _ev(ws: str, js: str, timeout: float = 6.0):
    """Runtime.evaluate with the page's exception surfaced (cdp._eval swallows it as None)."""
    import websocket
    conn = websocket.create_connection(ws, timeout=timeout, suppress_origin=True)
    try:
        conn.send(json.dumps({"id": 7, "method": "Runtime.evaluate",
                              "params": {"expression": js, "returnByValue": True, "awaitPromise": False}}))
        for _ in range(50):
            msg = json.loads(conn.recv())
            if msg.get("id") == 7:
                res = msg.get("result", {})
                exc = res.get("exceptionDetails")
                if exc:
                    txt = (exc.get("exception") or {}).get("description") or exc.get("text") or "JS exception"
                    raise RuntimeError(txt.splitlines()[0][:300])
                return res.get("result", {}).get("value")
    finally:
        conn.close()
    return None


def _wait(ws: str, js: str, secs: float, every: float = 0.35):
    """Poll a JS expression until it is truthy; returns the value (or None on timeout)."""
    end = time.time() + secs
    while time.time() < end:
        try:
            v = _ev(ws, js)
        except Exception:
            v = None
        if v:
            return v
        time.sleep(every)
    return None


# ----------------------------------------------------------------- detect

def _describe(p: dict) -> dict:
    """Normalise the iframe params into the format vocabulary."""
    practice = p.get("playMode") == "fun"
    section = p.get("gameTableUrl") or ""
    zone = "zone" in section or (p.get("gameFormat") or "").lower().startswith("zone")
    game_type = "practice" if practice else ("zone" if zone else "ring")
    bb = int(p["quickSeatBigBlind"]) if str(p.get("quickSeatBigBlind") or "").isdigit() else None
    sb = int(p["quickSeatSmallBlind"]) if str(p.get("quickSeatSmallBlind") or "").isdigit() else None
    if bb is None:
        # Zone (and any non-quick-seat) tables: the blinds are only in the table title,
        # "$0.10/$0.25 No Limit Hold'em - Zone Poker - Bengals - #2138" (practice: "2/4 No Limit Hold'em")
        m = re.search(r"\$?([\d.,]+)\s*/\s*\$?([\d.,]+)", p.get("_title") or "")
        if m:
            try:
                sb = int(round(float(m.group(1).replace(",", "")) * 100))
                bb = int(round(float(m.group(2).replace(",", "")) * 100))
            except ValueError:
                pass
    seats = int(p["seat"]) if str(p.get("seat") or "").isdigit() else None
    stake = None if practice else stake_for_bb(bb)
    fid = format_id_for(game_type, ("zone" if zone else "ring") if practice else stake, seats)
    buyin = int(p["quickSeatBuyInAmount"]) if str(p.get("quickSeatBuyInAmount") or "").isdigit() else None
    return {
        "formatId": fid, "site": "ignition", "gameType": game_type, "stake": stake, "seats": seats,
        "practice": practice, "sbCents": sb, "bbCents": bb,
        "buyInCents": buyin, "buyInBb": (round(buyin / bb, 1) if buyin and bb else None),
        "waitForBigBlind": p.get("waitForBigBlind") == "true", "section": section,
        "gameFormat": p.get("gameFormat"), "tableName": p.get("tableName") or None, "title": p.get("_title"),
        "name": (get(fid) or {}).get("name") or f"{stake or (f'{sb}/{bb}c' if bb else 'unknown stake')} {game_type} {seats or '?'}-max",
    }


# The sentinel for "this wrapper's own slot", which is NOT the same as slot=None
# (None is the single-table reading: the first playMode iframe in the page).
_MINE = object()


def detect(port: int, settle: float = 0.0, slot: object = _MINE) -> dict | None:
    """Format of the table currently open in the client window, or None.
    `settle` > 0 keeps re-reading for that many seconds while the blinds are
    still unknown (the table title renders a moment after the iframe appears).
    `slot` names a `data-multitableslot` other than this wrapper's own — the
    seating loop reads the table it has just opened, which by definition is not
    the one this process drives."""
    t = _target(port)
    if not t:
        return None
    dom = tables.dom_slot() if slot is _MINE else slot
    end = time.time() + settle
    while True:
        try:
            p = _ev(t["webSocketDebuggerUrl"], _table_js(dom))
        except Exception:
            return None
        d = _describe(p) if isinstance(p, dict) else None
        if d is None or d.get("bbCents") or time.time() >= end:
            return d
        time.sleep(0.5)


def compare(declared: str | None, observed: dict | None) -> dict:
    """The guardrail verdict the panel badge shows."""
    if not declared:
        return {"state": "undeclared", "text": "no format declared"}
    d = get(declared)
    dname = d["name"] if d else declared
    if not observed:
        return {"state": "unknown", "text": f"declared {dname} · no table open yet"}
    if observed.get("formatId") == declared:
        return {"state": "ok", "text": observed["name"]}
    if not observed.get("bbCents") and observed.get("gameType") in (None, (d or {}).get("gameType")):
        return {"state": "unknown", "text": f"declared {dname} · seated, stake not read yet"}
    if (d and observed.get("gameType") == d["gameType"] and observed.get("stake") == d["stake"]
            and d.get("seats") and observed.get("seats") != d["seats"]):
        return {"state": "warn", "text": f"seats: {observed.get('seats')}-max table, {d['seats']}-max declared",
                "observed": observed["name"], "declared": dname}
    return {"state": "warn", "text": f"off format: {observed['name']} (declared {dname})",
            "observed": observed["name"], "declared": dname}


# ----------------------------------------------------------------- goto

_SECTION_LINK = {"ring": "Cash games", "zone": "Zone poker"}
_SECTION_HEAD = {"ring": "Start Cash Game", "zone": "Start Zone Game"}


def _js_click_text(sel: str, text: str) -> str:
    return (_LOBBY + "if(!L) 'nolobby'; else { const e=[...L.querySelectorAll(" + json.dumps(sel) + ")]"
            ".filter(e=>(e.innerText||'').trim()===" + json.dumps(text) + ").pop(); if(e) e.click(); !!e }")


# THE SIGN-IN PAGE IS NOT ALWAYS AT /login (Brady, 2026-09-17). An expired session shows the e-mail + password form
# wherever the window was (the poker-lobby entry, the casino landing), so a URL check alone read it as "signed-in",
# the router went routing, and the lobby wait ran its full course before anyone noticed. The form itself is the truth.
_SIGNED_OUT_JS = r"""(() => { const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const ins = [...document.querySelectorAll('input')].filter(vis);
  return !!(ins.find(i => i.type === 'password') && ins.find(i => i.type === 'email' || /user|email/i.test(i.name + i.id))); })()"""


def _signed_out(ws: str) -> bool:
    try:
        return bool(_ev(ws, _SIGNED_OUT_JS, timeout=4.0))
    except Exception:
        return False


def _wait_lobby(ws: str, secs: float) -> str | None:
    """Wait for the lobby document, but come back at once if the window shows the sign-in form instead:
    'lobby' | 'signed-out' | None (timed out)."""
    end = time.time() + secs
    while time.time() < end:
        try:
            if _ev(ws, _LOBBY + "!!L", timeout=4.0):
                return "lobby"
        except Exception:
            pass
        if _signed_out(ws):
            return "signed-out"
        time.sleep(0.5)
    return None


def _close_modal(ws: str) -> None:
    _ev(ws, _LOBBY + "(() => { const c=L && L.querySelector('button.close-btn'); if (c) c.click(); return !!c; })()")


def goto(fid: str, buyin_bb: float, port: int, wait_for_bb: bool = True, log=print,
         adding: bool = False) -> dict:
    """Drive the lobby to `fid` and sit with `buyin_bb` big blinds. Returns
    {ok, steps, detected, slot, error?}.

    Refuses when a table is already open — UNLESS `adding`, which is how a
    multi-table session takes its second, third and fourth seats: Ignition seats
    up to four tables in this one client, and every one of those seats but the
    first is necessarily taken from a page that already has a table on it. The
    refusal is the single-table rule ("you are already seated, I will not sit you
    somewhere else"), and applying it to the seating loop refused table 2 of 2
    with the name of table 1."""
    steps: list[str] = []
    try:
        return _goto(fid, buyin_bb, port, wait_for_bb, log, steps, adding)
    except Exception as e:
        log(f"[goto] EXCEPTION: {e}")
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "steps": steps}


def _goto(fid: str, buyin_bb: float, port: int, wait_for_bb: bool, log, steps: list[str],
          adding: bool = False) -> dict:

    # THE RECORD FIRST, THE LOG SECOND, AND THE LOG CANNOT FAIL THE WALK. A step
    # is progress through a lobby with money at the end of it; whether anyone
    # could print it is not part of that. `steps` is what the panel and the
    # session record read, so it is appended before anything is written, and the
    # write itself is swallowed -- an encoding this console cannot render, a
    # closed pipe, a full disk. The 2026-09-21 session lost its second table to
    # exactly this: an arrow in "Cash games -> Start Cash Game" raised
    # UnicodeEncodeError out of print(), and the seat was reported as failed.
    def _say(msg: str) -> None:
        try:
            log(msg)
        except Exception:
            pass

    def step(s: str):
        steps.append(s)
        _say(f"[goto] {s}")

    def fail(err: str, **extra) -> dict:
        _say(f"[goto] FAILED: {err}")
        return {"ok": False, "error": err, "steps": steps, **extra}

    f = get(fid)
    if not f:
        return fail(f"unknown format {fid!r}")
    path = f["path"]
    t = _target(port)
    if not t:
        return fail("table window not open (no Ignition page on CDP)")
    ws = t["webSocketDebuggerUrl"]

    # Taken BEFORE anything is clicked: which tables the client already has is
    # what tells us, afterwards, which one is the new one.
    before = set(seated_slots(port))
    already = detect(port)
    if already and not adding:
        return fail(f"a table is already open: {already['name']}", detected=already)
    if adding:
        step(f"adding a table — {len(before)} already seated (slots {sorted(before)})")

    # 1. lobby section
    section = path["section"]
    if not _wait(ws, _LOBBY + "!!L", 8) and "/static/poker-game" in ((_target(port) or {}).get("url") or ""):
        # ALREADY IN THE CLIENT SHELL - DO NOT NAVIGATE AWAY (Brady, 2026-09-17). A fresh sign-in lands here and
        # the lobby frame boots 30-60 s later; hopping to the /poker-lobby entry from this page dropped the new
        # session and showed the sign-in form again, and the router went round that loop four times.
        step("client shell is up — waiting for the lobby to boot (no navigation)")
        got = _wait_lobby(ws, 75)
        if got == "signed-out":
            return fail("signed out — the window shows the sign-in form", signedOut=True)
        if got != "lobby":
            return fail("lobby did not boot inside the client shell")
    if not _wait(ws, _LOBBY + "!!L", 8):
        if adding:
            # NAVIGATING WOULD TAKE THE SEATED TABLES WITH IT. The hops below set
            # `location.href` on the TOP document — the one page every table
            # iframe lives in. Harmless when nothing is seated; with 1-3 tables in
            # hands it closes them all, mid-hand, with money in the pots. When we
            # are adding a table, no lobby frame means stop and say so.
            return fail("no lobby frame in the page — not navigating with tables already seated")
        # THE ENTRY HOP FIRST (Brady, 2026-09-14). Deep-linking the client at a
        # section — client + "?lobby=%2Fpoker-lobby%2Fzone-poker" — only boots
        # the lobby when the window is ALREADY in the poker client. From the
        # casino menu (/headless/poker/casino-crossplay, where a fresh sign-in
        # lands) it never loaded: measured 75 s of nothing, and the router sat
        # on "lobby did not load" while a seat was there for the taking. The
        # site's own /poker-lobby entry redirects into the client shell and
        # settles on /poker-lobby/home — measured 20 s from that same casino
        # page. So hop there first and let the section CLICK below do the rest;
        # the deep link stays as the second attempt for an already-warm client.
        entry = data()["lobby"].get("entry") or "https://www.ignitioncasino.eu/poker-lobby"
        _ev(ws, "location.href = " + json.dumps(entry) + "; true")
        step(f"no lobby in the window — navigated to the poker lobby entry ({entry})")
        # FASTER OUT OF THE CASINO MENU (Brady, 2026-09-17). The entry hop settles in ~20 s when it works and not
        # at all when it does not (75 s of nothing on 09-17, then the deep link booted the lobby at once). Give the
        # entry 25 s; past that the window is on the site's shell, i.e. warm, and the section deep link is the faster
        # route. The deep link gets a proper cold-load allowance of its own.
        got = _wait_lobby(ws, 25)
        if got == "signed-out":
            return fail("signed out — the window shows the sign-in form", signedOut=True)
        if got != "lobby":
            client = data()["lobby"]["client"] + data()["lobby"]["sections"][section].replace("/", "%2F")
            _ev(ws, "location.href = " + json.dumps(client) + "; true")
            step(f"entry did not boot the lobby in 25 s — {section} deep link")
            got = _wait_lobby(ws, 120)     # a cold client load reached the lobby at ~70 s on 09-17; 60 s called it failed
            if got == "signed-out":
                return fail("signed out — the window shows the sign-in form", signedOut=True)
            if got != "lobby":
                return fail("lobby did not load")
    # a Buy-In modal left open (by hand, or by an earlier attempt) blocks the wizard — close it first
    if _ev(ws, _LOBBY + "!!(L && L.querySelector('button.close-btn') && /Select Stake/.test(L.body.innerText))"):
        _close_modal(ws)
        step("closed a Buy-In modal that was already open")
        time.sleep(0.8)
    r = _ev(ws, _js_click_text("a", _SECTION_LINK[section]))
    if r is not True:
        return fail(f"could not click {_SECTION_LINK[section]!r} ({r})")
    head = _SECTION_HEAD[section]
    if not _wait(ws, _LOBBY + "!!L && L.body.innerText.includes(" + json.dumps(head) + ")", 25):
        return fail(f"{head!r} did not appear")
    step(f"{_SECTION_LINK[section]} → {head}")

    # 2. wizard — set EVERY field (the wizard remembers the last choice per section)
    wiz = data()["lobby"]["wizard"]
    for txt in (wiz["cardGame"], wiz["limit"]):
        _ev(ws, _js_click_text("button,[role=button]", txt))
    want_practice = bool(path.get("practice"))
    tog = _ev(ws, _LOBBY + "(() => { const lab = L.querySelector('.custom-toggle label'); if (!lab) return 'notoggle';"
              " const on = /switch-btn-on/.test(lab.className); if (on !== " + json.dumps(want_practice) + ") lab.click();"
              " return /switch-btn-on/.test(L.querySelector('.custom-toggle label').className); })()")
    if tog != want_practice:
        return fail(f"practice toggle would not settle ({tog})")
    seats = str(path["seats"])
    seat_res = _ev(ws, _LOBBY + "(() => { const b=[...L.querySelectorAll('button,[role=button]')].filter(e=>(e.innerText||'').trim()==="
                   + json.dumps(seats) + ").pop(); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click();"
                   " return /active/.test(b.className) ? 'active' : String(b.className); })()")
    if seat_res != "active":
        step(f"seats {seats}: {seat_res} — continuing with the client's own choice")
    step(f"wizard: {wiz['cardGame']} · {wiz['limit']} · {seats} seats · practice {'on' if want_practice else 'off'}")
    # NEXT NEEDS A LIVE LOBBY (Brady, 2026-09-17). Right after the lobby boots, the wizard renders before the
    # client is ready to serve it: NEXT clicked in that window does nothing, and the router sat 30 s on "Buy-In
    # modal did not open" while a second click would have opened it in 2 s (measured on 09-17). So: press NEXT,
    # give the modal 8 s, and if it has not come, re-press - up to four times - before giving up.
    opened = False
    for attempt in range(4):
        r = _ev(ws, _js_click_text("button", "NEXT"))
        if r is not True:
            return fail("NEXT button not found")
        if _wait(ws, _LOBBY + "!!L && L.body.innerText.includes('Select Stake')", 8 if attempt < 3 else 12):
            opened = True
            if attempt:
                step(f"Buy-In modal opened on NEXT press {attempt + 1}")
            break
        time.sleep(1.5)
    if not opened:
        return fail("Buy-In modal did not open (NEXT pressed 4 times)")
    step("Buy-In modal open")

    # 3. stake
    label = path["stakeLabel"]
    _ev(ws, _LOBBY + "(() => { const s=[...L.querySelectorAll('span')].filter(e=>(e.innerText||'').trim()==='Select Stake').pop();"
        " if (s) { s.click(); s.parentElement && s.parentElement.click(); } return !!s; })()")
    li = _wait(ws, _LOBBY + "(() => { const li=[...L.querySelectorAll('li')].filter(e=>(e.innerText||'').trim()==="
               + json.dumps(label) + ").pop(); if (li) { li.click(); return true; } return false; })()", 8)
    if not li:
        opts = _ev(ws, _LOBBY + "[...L.querySelectorAll('li')].map(e=>(e.innerText||'').trim()).filter(t=>/\\//.test(t)&&t.length<30)")
        # A PRACTICE table has exactly one NL stake, and which one it is is the
        # client's business, not ours: on 2026-09-14 the Zone practice dropdown
        # offered only "2.00 / 4.00" while formats.json recorded "25.00 / 50.00"
        # (that practice stake either went away or is hidden until the practice
        # balance is topped up), and the run failed with a seat available. A
        # practice seat is a practice seat, so take the single numeric stake on
        # offer and record which. Real-money stakes are NEVER guessed: there the
        # label is the identity of the format, and picking another one would play
        # a different game for real money.
        numeric = [o for o in (opts or []) if re.match(r"^[\d.,]+\s*/\s*[\d.,]+$", o)]
        if want_practice and len(numeric) == 1:
            li = _wait(ws, _LOBBY + "(() => { const li=[...L.querySelectorAll('li')].filter(e=>(e.innerText||'').trim()==="
                       + json.dumps(numeric[0]) + ").pop(); if (li) { li.click(); return true; } return false; })()", 8)
            if li:
                step(f"declared stake {label!r} not offered; took the only practice stake there is, {numeric[0]!r}")
                label = numeric[0]
        if not li:
            _close_modal(ws)
            # NO TABLE AT THIS STAKE RIGHT NOW (Brady, 2026-09-17): the lobby lists only stakes with a table running.
            # Real-money stakes are never guessed; the router polls the lobby again in a minute instead of stopping.
            return fail(f"no {label} table right now (lobby offers {opts})", stakeMissing=True, offered=opts)
    modal = _wait(ws, _LOBBY + "(() => { const t=L.body.innerText; return /TAKE MY SEAT/.test(t) ? t.slice(t.indexOf('Buy-In')) : null; })()", 8)
    if not modal:
        _close_modal(ws)
        return fail("buy-in amount controls did not appear")
    step(f"stake {label}")

    # 4. amount — the OTHER input, in the modal's units (dollars, or practice chips)
    mx = re.search(r"MAXIMUM\s*\$?([\d,]+\.\d\d)", modal)
    mn = re.search(r"MINIMUM\s*\$?([\d,]+\.\d\d)", modal)
    bb_units = float(label.split("/")[1].strip().lstrip("$").replace(",", ""))   # one BB in the modal's units
    want = round(float(buyin_bb) * bb_units, 2)
    lo = float(mn.group(1).replace(",", "")) if mn else None
    hi = float(mx.group(1).replace(",", "")) if mx else None
    amount = min(want, hi) if hi is not None else want
    if lo is not None and amount < lo:
        amount = lo
    if amount != want:
        step(f"buy-in {want:.2f} clamped to the table's bounds {lo}–{hi} → {amount:.2f}")
    amount_s = f"{amount:.2f}"
    if hi is not None and amount >= hi:
        # the happy path (100 bb = the table maximum): press the modal's own MAXIMUM preset and verify the box
        set_res = _ev(ws, _LOBBY + "(() => { const b=[...L.querySelectorAll('button,[role=button]')].find(b => /^MAXIMUM/i.test((b.innerText||'').trim()));"
                      " if (!b) return 'nomax'; b.click(); const inp = L.querySelector('input[name=otherAmount], #small-input');"
                      " return inp ? inp.value : 'noinput'; })()")
        if set_res in ("nomax", "noinput") or (set_res or "").replace(",", "") != amount_s:
            step(f"MAXIMUM preset gave {set_res!r} — typing the amount instead")
        else:
            step("buy-in: MAXIMUM preset (full stack)")
    if not (hi is not None and amount >= hi and (set_res or "").replace(",", "") == amount_s):
        set_res = _ev(ws, _LOBBY + "(() => {"
                      " let inp = L.querySelector('input[name=otherAmount], #small-input');"
                      " if (!inp) { const inputs=[...L.querySelectorAll('input[type=text]')].filter(i => /^[\\d,]*\\.?\\d*$/.test(i.value) && !/\\//.test(i.value)); inp = inputs[inputs.length-1]; }"
                      " if (!inp) return 'noinput';"
                      " const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
                      " inp.focus(); setter.call(inp, " + json.dumps(amount_s) + ");"
                      " inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true})); inp.blur();"
                      " return inp.value; })()")
    if (set_res or "").replace(",", "") != amount_s:
        _close_modal(ws)
        return fail(f"could not set the buy-in amount ({set_res})")
    # Wait for Big Blind (ring only; Zone has no such box)
    _ev(ws, _LOBBY + "(() => { const cb=[...L.querySelectorAll('input[type=checkbox]')].filter(e=>/Wait for Big Blind/i.test(((e.closest('label')||e.parentElement).innerText||''))).pop();"
        " if (cb && cb.checked !== " + json.dumps(bool(wait_for_bb)) + ") cb.click(); return cb ? cb.checked : null; })()")
    state = _ev(ws, _LOBBY + "(() => { const b=[...L.querySelectorAll('button')].filter(e=>/TAKE MY SEAT/i.test(e.innerText)).pop();"
                " if (!b) return 'nobutton'; return b.disabled ? ('disabled: ' + (L.body.innerText.match(/Your available balance[^\\n]*/)||['balance or limit'])[0]) : 'ready'; })()")
    if state != "ready":
        _close_modal(ws)
        return fail(f"TAKE MY SEAT not available — {state}")
    step(f"buy-in {amount_s} ({buyin_bb} bb requested) · wait for BB {'on' if wait_for_bb else 'off'}")

    # 5. seat
    _ev(ws, _LOBBY + "(() => { const b=[...L.querySelectorAll('button')].filter(e=>/TAKE MY SEAT/i.test(e.innerText)).pop(); b.click(); return true; })()")
    # WHICH TABLE DID WE JUST SIT AT? Reading our own slot answers about a table
    # that was there before the click, so when adding, every seat would report
    # table 1's name and verdict — a success message about the wrong table. The
    # client hands us the number: wait for a `data-multitableslot` that was not
    # in `before` and read THAT one.
    det = None
    new_slot = None
    end = time.time() + 25
    while time.time() < end:
        if adding:
            fresh = [x for x in seated_slots(port) if x not in before]
            if fresh:
                new_slot = fresh[0]
                det = detect(port, settle=8, slot=new_slot)
        else:
            det = detect(port, settle=8)
        if det:
            break
        time.sleep(0.5)
    if not det:
        return fail("seat taken but no table iframe appeared within 25 s"
                    + (f" (slots before: {sorted(before)})" if adding else ""))
    if not det.get("bbCents"):
        # Zone: the blinds live in the table title, which can render well after the iframe — keep reading
        det = detect(port, settle=30, slot=new_slot if adding else _MINE) or det
        if not det.get("bbCents"):
            step("table title not rendered yet — stake unread (the router keeps re-reading)")
    if det.get("buyInCents") is None:
        # Zone tables do not echo the buy-in in the iframe params; the amount we put in the modal is authoritative
        det["buyInCents"] = int(round(amount * 100))
        det["buyInBb"] = round(amount / bb_units, 1) if bb_units else None
        det["buyInSource"] = "modal"
    else:
        det["buyInSource"] = "iframe"
    verdict = compare(fid, det)
    step(f"seated{f' (table slot {new_slot})' if adding else ''}: {det['name']} · {det.get('buyInBb')} bb · {verdict['text']}")
    return {"ok": True, "steps": steps, "detected": det, "verdict": verdict, "slot": new_slot}


def leave(port: int, log=print, slot: object = _MINE) -> dict:
    """Leave OUR table. The close control is a `.iconItem.close` div in the
    table iframe's own header (top-right); a real mouse click on it opens the
    "Are you sure you want to leave this table?" dialog, then YES (both inside
    the iframe).

    SLOT-SCOPED, corrected 2026-09-21. Both of these looked up "the first iframe
    carrying playMode", which is table 1 no matter who asked — so slot 3 pressing
    Leave would have opened the leave dialog on table 1 and confirmed it, closing
    a table with money on it that nobody asked to close. The same family as the
    four bugs of 2026-09-20 and the tap's, and the same fix: name the frame."""
    t = _target(port)
    if not t:
        return {"ok": False, "error": "no table window"}
    ws = t["webSocketDebuggerUrl"]
    dom = tables.dom_slot() if slot is _MINE else slot
    if not detect(port, slot=dom):
        return {"ok": True, "note": "no table open"}
    find_x = _slotted(r"""(() => {__FRAME__
      const f = __frame(__SLOT__);
      if (!f || !f.contentDocument) return null;
      const fr=f.getBoundingClientRect(); const d=f.contentDocument;
      const el = [...d.querySelectorAll('.iconItem.close')].find(e=>{const b=e.getBoundingClientRect(); return b.width>0 && b.height>0;});
      if (!el) return null; const b=el.getBoundingClientRect();
      return {x: Math.round(fr.x + b.x + b.width/2), y: Math.round(fr.y + b.y + b.height/2)}; })()""", dom)
    click_yes = _slotted(r"""(() => {__FRAME__
      const f = __frame(__SLOT__); try {
      const b=[...f.contentDocument.querySelectorAll('button')].filter(e=>(e.innerText||'').trim()==='YES').pop(); if (b) { b.click(); return true; } } catch(e) {} return false; })()""", dom)
    # The header renders a moment after the iframe appears, and a stray click
    # can miss — so find, click, wait for YES, and retry a few times.
    yes = False
    spot = _wait(ws, find_x, 12)
    for _ in range(5):
        if not spot:
            break
        # SERIALIZED, like every other real click on this shared page: these three
        # CDP events must not interleave with another table's press (tables.press_lock).
        with tables.press_lock():
            cdp._dispatch_click(ws, spot["x"], spot["y"])
        yes = _wait(ws, click_yes, 4)
        if yes:
            break
        spot = _ev(ws, find_x)
    if not spot:
        return {"ok": False, "error": "could not find the table close control"}
    if not yes:
        return {"ok": False, "error": "leave confirmation did not appear"}
    end = time.time() + 10
    while time.time() < end and detect(port, slot=dom):
        time.sleep(0.4)
    ok = detect(port, slot=dom) is None
    log(f"[goto] left table: {ok}")
    return {"ok": ok}


# ----------------------------------------------------------------- window state

def window_state(port: int) -> dict:
    """What the table window is showing: closed (no CDP / no Ignition page),
    signed-out (login page), signed-in (lobby / client, no table), or seated
    (a table iframe is up — `detected` names the format). This is the auth gate
    the setup page and the router wait on; the human does the signing in."""
    if not cdp.available(port):
        return {"state": "closed", "cdp": False, "url": None, "detected": None}
    t = _target(port)
    if not t:
        pages = [p.get("url") or "" for p in cdp.page_targets(port)]
        return {"state": "closed", "cdp": True, "url": pages[0] if pages else None, "detected": None,
                "note": "CDP up but no Ignition page"}
    url = t.get("url") or ""
    if "/login" in url or "originURL" in url or _signed_out(t["webSocketDebuggerUrl"]):
        return {"state": "signed-out", "cdp": True, "url": url.split("?")[0], "detected": None}
    det = detect(port)
    if det:
        return {"state": "seated", "cdp": True, "url": url.split("?")[0], "detected": det}
    return {"state": "signed-in", "cdp": True, "url": url.split("?")[0], "detected": None}


# ---- several tables in one client ------------------------------------------
#
# Ignition seats up to four tables in ONE page on ONE login. You do not open a
# window per table: from a seated table you go back to the lobby and take
# another seat, and the client adds a table and re-tiles them all itself. Each
# one is a same-origin iframe tagged `data-multitableslot` (0..3; the lobby is
# -1), which is also how a wrapper knows which table is its own.

_SEATED_JS = r"""(() => {
  const play = f => /playMode=/.test(f.getAttribute('src') || '');
  const slots = [...document.querySelectorAll('iframe[data-multitableslot]')]
    .filter(play)
    .map(f => Number(f.getAttribute('data-multitableslot')))
    .filter(n => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  // the single-table client has no such attribute at all: one playMode frame is
  // one table, and it is slot 0 by definition
  if (!slots.length) {
    const one = [...document.querySelectorAll('iframe')].filter(play).length;
    return JSON.stringify({slots: one ? [0] : [], tagged: false});
  }
  return JSON.stringify({slots, tagged: true});
})()"""


def seated_slots(port: int) -> list[int]:
    """Which table slots are seated right now, by the client's own numbering."""
    t = _target(port)
    if not t:
        return []
    try:
        raw = _ev(t["webSocketDebuggerUrl"], _SEATED_JS, timeout=6)
        return list(json.loads(raw).get("slots") or []) if raw else []
    except Exception:
        return []


_LOBBY_BTN_JS = r"""(() => {
  // The Lobby control lives in the top strip of the TOP document — above every
  // table frame, outside all of them. Take the SMALLEST element whose own text
  // is exactly "Lobby": the strip nests, and the outer boxes span the whole bar.
  const hits = [...document.querySelectorAll('*')].filter(e => {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.top > 70) return false;
    const own = [...e.childNodes].filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim()).join(' ').trim();
    return /^lobby$/i.test(own);
  });
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return (ra.width * ra.height) - (rb.width * rb.height);
  });
  const r = hits[0].getBoundingClientRect();
  return JSON.stringify({x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                         w: Math.round(r.width), h: Math.round(r.height)});
})()"""


def to_lobby(port: int, log=print) -> dict:
    """Bring the lobby forward from a seated table, so another seat can be taken.

    A REAL mouse event, not `.click()`: the client's controls are React handlers
    and a synthetic click is ignored by them (the same reason scout's open_table
    dispatches input events). The lobby iframe stays mounted underneath the
    tables the whole time — this is what raises it."""
    t = _target(port)
    if not t:
        return {"ok": False, "error": "no table window"}
    ws = t["webSocketDebuggerUrl"]
    try:
        raw = _ev(ws, _LOBBY_BTN_JS, timeout=6)
    except Exception as e:
        return {"ok": False, "error": f"could not look for the Lobby control: {e}"}
    if not raw:
        return {"ok": False, "error": "no Lobby control in the top strip"}
    b = json.loads(raw)
    # SERIALIZED WITH EVERY OTHER TABLE'S PRESSES. This is a REAL mouse click on
    # the shared page — three CDP events — and the siblings whose seats we are
    # about to join are in hands on that same page. Interleaved with one of their
    # presses it becomes a drag, or a click at a coordinate nobody chose, with
    # money on the table. Same lock as launch.act(); see tables.press_lock.
    try:
        with tables.press_lock():
            cdp._dispatch_click(ws, b["x"], b["y"])
    except Exception as e:
        return {"ok": False, "error": f"clicking Lobby failed: {e}"}
    log(f"[seat] back to the lobby (Lobby at {b['x']},{b['y']})")
    # NO VERDICT ON WHETHER IT "CAME FORWARD". Two attempts at one were dropped
    # here: waiting for the lobby to EXIST is meaningless (it stays mounted under
    # the tables all session, so it is there before the click does anything), and
    # hit-testing its centre is not reliable either — on the real client's 2x2
    # that centre falls in the few-pixel gap BETWEEN two table frames.
    # It does not matter: `goto` drives the lobby through its own DOM (.click()
    # on the lobby document's elements), which fires whether or not the lobby is
    # the frame on top. So this raises it if it can and gets out of the way;
    # `goto` is the one that reports whether the seat could actually be taken,
    # step by step, and it is the honest arbiter.
    time.sleep(1.5)
    return {"ok": True, "at": [b["x"], b["y"]]}
