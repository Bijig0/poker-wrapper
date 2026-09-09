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
_TABLE_JS = r"""(() => {
  const f = [...document.querySelectorAll('iframe')].find(f => /playMode=/.test(f.getAttribute('src') || ''));
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


def _target(port: int) -> dict | None:
    for t in cdp.page_targets(port):
        u = (t.get("url") or "").lower()
        if "poker-game" in u or "ignition" in u:
            return t
    return None


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


def detect(port: int, settle: float = 0.0) -> dict | None:
    """Format of the table currently open in the client window, or None.
    `settle` > 0 keeps re-reading for that many seconds while the blinds are
    still unknown (the table title renders a moment after the iframe appears)."""
    t = _target(port)
    if not t:
        return None
    end = time.time() + settle
    while True:
        try:
            p = _ev(t["webSocketDebuggerUrl"], _TABLE_JS)
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


def _close_modal(ws: str) -> None:
    _ev(ws, _LOBBY + "(() => { const c=L && L.querySelector('button.close-btn'); if (c) c.click(); return !!c; })()")


def goto(fid: str, buyin_bb: float, port: int, wait_for_bb: bool = True, log=print) -> dict:
    """Drive the lobby to `fid` and sit with `buyin_bb` big blinds. Returns
    {ok, steps, detected, error?}. Refuses when a table is already open."""
    steps: list[str] = []
    try:
        return _goto(fid, buyin_bb, port, wait_for_bb, log, steps)
    except Exception as e:
        log(f"[goto] EXCEPTION: {e}")
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "steps": steps}


def _goto(fid: str, buyin_bb: float, port: int, wait_for_bb: bool, log, steps: list[str]) -> dict:

    def step(s: str):
        steps.append(s)
        log(f"[goto] {s}")

    def fail(err: str, **extra) -> dict:
        log(f"[goto] FAILED: {err}")
        return {"ok": False, "error": err, "steps": steps, **extra}

    f = get(fid)
    if not f:
        return fail(f"unknown format {fid!r}")
    path = f["path"]
    t = _target(port)
    if not t:
        return fail("table window not open (no Ignition page on CDP)")
    ws = t["webSocketDebuggerUrl"]

    already = detect(port)
    if already:
        return fail(f"a table is already open: {already['name']}", detected=already)

    # 1. lobby section
    section = path["section"]
    if not _wait(ws, _LOBBY + "!!L", 8):
        client = data()["lobby"]["client"] + data()["lobby"]["sections"][section].replace("/", "%2F")
        _ev(ws, "location.href = " + json.dumps(client) + "; true")
        step(f"no lobby in the window — navigated to the {section} section")
        if not _wait(ws, _LOBBY + "!!L", 75):     # a cold client load takes 30-60 s
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
    r = _ev(ws, _js_click_text("button", "NEXT"))
    if r is not True:
        return fail("NEXT button not found")
    if not _wait(ws, _LOBBY + "!!L && L.body.innerText.includes('Select Stake')", 30):   # slow right after a leave
        return fail("Buy-In modal did not open")
    step("Buy-In modal open")

    # 3. stake
    label = path["stakeLabel"]
    _ev(ws, _LOBBY + "(() => { const s=[...L.querySelectorAll('span')].filter(e=>(e.innerText||'').trim()==='Select Stake').pop();"
        " if (s) { s.click(); s.parentElement && s.parentElement.click(); } return !!s; })()")
    li = _wait(ws, _LOBBY + "(() => { const li=[...L.querySelectorAll('li')].filter(e=>(e.innerText||'').trim()==="
               + json.dumps(label) + ").pop(); if (li) { li.click(); return true; } return false; })()", 8)
    if not li:
        opts = _ev(ws, _LOBBY + "[...L.querySelectorAll('li')].map(e=>(e.innerText||'').trim()).filter(t=>/\\//.test(t)&&t.length<30)")
        _close_modal(ws)
        return fail(f"stake {label!r} not offered; dropdown had {opts}")
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
    det = None
    end = time.time() + 25
    while time.time() < end:
        det = detect(port, settle=8)
        if det:
            break
        time.sleep(0.5)
    if not det:
        return fail("seat taken but no table iframe appeared within 25 s")
    if not det.get("bbCents"):
        # Zone: the blinds live in the table title, which can render well after the iframe — keep reading
        det = detect(port, settle=30) or det
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
    step(f"seated: {det['name']} · {det.get('buyInBb')} bb · {verdict['text']}")
    return {"ok": True, "steps": steps, "detected": det, "verdict": verdict}


def leave(port: int, log=print) -> dict:
    """Leave the open table. The close control is a `.iconItem.close` div in the
    table iframe's own header (top-right); a real mouse click on it opens the
    "Are you sure you want to leave this table?" dialog, then YES (both inside
    the iframe)."""
    t = _target(port)
    if not t:
        return {"ok": False, "error": "no table window"}
    ws = t["webSocketDebuggerUrl"]
    if not detect(port):
        return {"ok": True, "note": "no table open"}
    find_x = r"""(() => {
      const f=[...document.querySelectorAll('iframe')].find(f=>/playMode=/.test(f.getAttribute('src')||''));
      if (!f || !f.contentDocument) return null;
      const fr=f.getBoundingClientRect(); const d=f.contentDocument;
      const el = [...d.querySelectorAll('.iconItem.close')].find(e=>{const b=e.getBoundingClientRect(); return b.width>0 && b.height>0;});
      if (!el) return null; const b=el.getBoundingClientRect();
      return {x: Math.round(fr.x + b.x + b.width/2), y: Math.round(fr.y + b.y + b.height/2)}; })()"""
    click_yes = r"""(() => { const f=[...document.querySelectorAll('iframe')].find(f=>/playMode=/.test(f.getAttribute('src')||'')); try {
      const b=[...f.contentDocument.querySelectorAll('button')].filter(e=>(e.innerText||'').trim()==='YES').pop(); if (b) { b.click(); return true; } } catch(e) {} return false; })()"""
    # The header renders a moment after the iframe appears, and a stray click
    # can miss — so find, click, wait for YES, and retry a few times.
    yes = False
    spot = _wait(ws, find_x, 12)
    for _ in range(5):
        if not spot:
            break
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
    while time.time() < end and detect(port):
        time.sleep(0.4)
    ok = detect(port) is None
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
    if "/login" in url or "originURL" in url:
        return {"state": "signed-out", "cdp": True, "url": url.split("?")[0], "detected": None}
    det = detect(port)
    if det:
        return {"state": "seated", "cdp": True, "url": url.split("?")[0], "detected": det}
    return {"state": "signed-in", "cdp": True, "url": url.split("?")[0], "detected": None}
