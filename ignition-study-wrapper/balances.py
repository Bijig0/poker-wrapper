"""
balances.py — the money in a profile's account, as timestamped OBSERVATIONS.

A balance is something we saw at a moment, not a property of the profile: it is
stored as a row (profile, ts, amount, source, which session it brackets), and
"the balance now" is simply the newest row. That shape is what makes the rule
below checkable at all — a single mutable number could never be reconciled.

THE RULE (2026-09-16). Between two snapshots of the same profile the balance may
move by exactly what poker did. Anything else is money that entered or left the
account outside the game — a deposit, a cash-out, a bonus, a fee, or a hand we
never captured — and that is a fact to FLAG, never to absorb into a win rate.
gto-trainer/apps/api reconciles the two and shows what is unexplained.

EQUITY, NOT THE CASHIER. The lobby's "available balance" excludes chips in play,
so a snapshot taken while seated would report the table stack as money that left
the account. Every snapshot therefore records BOTH the cashier figure and what is
on the table (in_play_cents, read from the seat's own stack), and everything is
reconciled on their sum. That is also what lets a session start or end from a seat.

Money is stored in integer USD cents. A float dollar amount silently loses a
cent every time it is added, and this number is the one being reconciled.

The account is USD. Any other display currency (AUD) is a conversion applied at
read time with a dated rate — never persisted here as if it had been measured.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# The wrapper owns the record; the API reads this file read-only, as it already
# does for sessions — one file, one writer.
DB = ROOT / "data" / "sessions.sqlite"

DDL = """CREATE TABLE IF NOT EXISTS balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  profile TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL,
  session_id TEXT,
  phase TEXT,
  how TEXT,
  raw TEXT,
  in_play_cents INTEGER
)"""


def _db() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB, timeout=5)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout = 5000")
    c.execute(DDL)
    try:
        c.execute("ALTER TABLE balances ADD COLUMN in_play_cents INTEGER")  # rows from before the equity model
    except sqlite3.OperationalError:
        pass
    c.execute("CREATE INDEX IF NOT EXISTS balances_profile_ts ON balances (profile, ts)")
    return c


def record(profile: str, amount_cents: int, source: str, session_id: str | None = None,
           phase: str | None = None, how: str | None = None, raw: str | None = None,
           currency: str = "USD", in_play_cents: int | None = None) -> dict:
    """Write one observation. Returns the row. `in_play_cents` is None when hero was
    not seated (nothing on the table), never 0 by default — the two mean different things."""
    if not profile:
        raise ValueError("a balance belongs to a profile")
    ts = int(time.time() * 1000)
    with _db() as c:
        cur = c.execute(
            "INSERT INTO balances (ts, profile, amount_cents, currency, source, session_id, phase, how, raw, in_play_cents)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (ts, profile, int(amount_cents), currency, source, session_id, phase, how, (raw or "")[:200],
             None if in_play_cents is None else int(in_play_cents)))
        rid = cur.lastrowid
    return {"id": rid, "ts": ts, "profile": profile, "amountCents": int(amount_cents), "inPlayCents": in_play_cents,
            "equityCents": int(amount_cents) + int(in_play_cents or 0),
            "currency": currency, "source": source, "sessionId": session_id, "phase": phase, "how": how}


def _row(r) -> dict:
    in_play = r[10] if len(r) > 10 else None
    return {"id": r[0], "ts": r[1], "profile": r[2], "amountCents": r[3], "currency": r[4],
            "source": r[5], "sessionId": r[6], "phase": r[7], "how": r[8], "raw": r[9],
            "inPlayCents": in_play, "equityCents": r[3] + (in_play or 0)}


def latest(profile: str) -> dict | None:
    with _db() as c:
        r = c.execute("SELECT * FROM balances WHERE profile=? ORDER BY ts DESC, id DESC LIMIT 1", (profile,)).fetchone()
    return _row(r) if r else None


def history(profile: str | None = None, limit: int = 500) -> list[dict]:
    with _db() as c:
        if profile:
            rs = c.execute("SELECT * FROM balances WHERE profile=? ORDER BY ts DESC, id DESC LIMIT ?", (profile, limit)).fetchall()
        else:
            rs = c.execute("SELECT * FROM balances ORDER BY ts DESC, id DESC LIMIT ?", (limit,)).fetchall()
    return [_row(r) for r in rs]


def for_session(session_id: str) -> list[dict]:
    with _db() as c:
        rs = c.execute("SELECT * FROM balances WHERE session_id=? ORDER BY ts, id", (session_id,)).fetchall()
    return [_row(r) for r in rs]


# ----------------------------------------------------------------- scraping

# Read the cashier balance off the lobby. Written defensively ON PURPOSE: the
# only string we know for certain the site renders is "Your available balance…"
# (formats.py already matches it on a failed buy-in), so the rest are ordered
# guesses and every one of them reports WHICH matched, in `how`. When none does,
# the reply carries candidate text instead of a silent null — /balance/probe
# prints it, and the selector can then be fixed in one pass against the real DOM.
_SCRAPE_JS = r"""(() => {
  const money = (s) => {
    const m = String(s || '').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    return m ? m[1].replace(/,/g, '') : null;
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  // 0. the client's own app bar — "Balance: $3,008.87 AUD ($2,115.15 USD)" — shown on
  //    the lobby AND at a table (seen in the 2026-08-05 recordings), so a balance can be
  //    read from a seat. USD is the account's currency; the site's AUD rides in `raw`.
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument); } catch (e) {} }
  for (const doc of docs) {
    const m = (doc.body.innerText || '').match(/Balance:\s*\$([\d,]+(?:\.\d{1,2})?)\s*AUD\s*\(\$([\d,]+(?:\.\d{1,2})?)\s*USD\)/i)
           || (doc.body.innerText || '').match(/Balance:\s*\$([\d,]+(?:\.\d{1,2})?)\s*USD/i);
    if (m) {
      const usd = (m[2] || m[1]).replace(/,/g, '');
      return { ok: true, how: 'header', amount: usd, raw: clean(m[0]) };
    }
  }
  const D = (typeof L !== 'undefined' && L) ? L : null;
  if (!D) return { ok: false, reason: 'no Balance header on screen and the Poker home lobby frame is not open' };

  // 1. an explicit hook, if the client ever grows one
  for (const el of D.querySelectorAll('[data-qa*="balance" i],[data-testid*="balance" i],[id*="balance" i]')) {
    const v = money(el.textContent);
    if (v) return { ok: true, how: 'hook', amount: v, raw: clean(el.textContent) };
  }
  // 2. the sentence we KNOW this client renders
  const sent = (D.body.innerText.match(/Your available balance[^\n]*/i) || [])[0];
  if (sent) {
    const v = money(sent);
    if (v) return { ok: true, how: 'text:available-balance', amount: v, raw: clean(sent) };
  }
  // 3. a node labelled balance, with the amount on it or beside it
  const labelled = [...D.querySelectorAll('*')].filter((e) => e.children.length === 0 && /balance|cashier/i.test(e.textContent || ''));
  for (const el of labelled) {
    const near = money(el.textContent) || money(el.parentElement && el.parentElement.textContent)
      || money(el.nextElementSibling && el.nextElementSibling.textContent);
    if (near) return { ok: true, how: 'labelled', amount: near, raw: clean((el.parentElement || el).textContent) };
  }
  // nothing matched: hand back what money-looking text IS on the page
  const cands = [...new Set((D.body.innerText.match(/[^\n]*\$\s*[\d,]+(?:\.\d{1,2})?[^\n]*/g) || []).map(clean))].slice(0, 12);
  return { ok: false, reason: 'no balance found in the lobby', candidates: cands };
})()"""


# Hero's stack in the seated table, converted to cents. The client shows the stack
# as "X BB" (the playerBalance hook launch.py already reads) or as dollars; the big
# blind comes from the table iframe's own src (quickSeatBigBlind), which formats.py
# already parses — so BB × that is exact, not a guess from the declared format.
_IN_PLAY_JS = r"""(() => {
  const f = [...document.querySelectorAll('iframe')].find(f => /playMode=/.test(f.getAttribute('src') || ''));
  if (!f) return { seated: false };
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
  const me = doc.querySelector("[data-qa='myPlayerTag']");
  const seat = me ? me.closest("[data-qa^='playerContainer-']") : null;
  const bal = seat ? seat.querySelector("[data-qa='playerBalance']") : null;
  if (!bal) return { seated: false, reason: 'no hero seat on the table' };
  const t = (bal.textContent || '').trim();
  const m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(BB)?$/i);
  if (!m) return { seated: true, reason: 'stack text not understood', raw: t };
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (m[2]) {
    if (!(bbCents > 0)) return { seated: true, reason: 'stack is in BB but the table gave no big blind', raw: t };
    return { seated: true, amount: n * bbCents / 100, raw: t, how: 'stack-bb x $' + (bbCents / 100) };
  }
  return { seated: true, amount: n, raw: t, how: 'stack-$' };
})()"""


def in_play(port: int) -> dict:
    """What hero has on the table right now: {seated, inPlayCents?, how, raw}."""
    try:
        import sys
        aof = str(ROOT.parent / "aof-model")
        if aof not in sys.path:
            sys.path.insert(0, aof)
        import formats as F
        t = F._target(port)
        if not t:
            return {"seated": False, "reason": f"no Ignition client on CDP port {port}"}
        res = F._ev(t["webSocketDebuggerUrl"], _IN_PLAY_JS)
    except Exception as e:
        return {"seated": False, "reason": f"could not read the table: {e}"}
    if not isinstance(res, dict):
        return {"seated": False, "reason": f"unexpected reply: {res!r}"}
    if res.get("seated") and res.get("amount") is not None:
        res["inPlayCents"] = int(round(float(res["amount"]) * 100))
    return res


def scrape(port: int) -> dict:
    """Read the balance from the open client. {ok, amountCents, how, raw} or {ok:False, reason, candidates}."""
    try:
        # formats.py imports scout.cdp at module load; launch.py puts it on the path,
        # so add it here too for the standalone calibration entry point below.
        import sys
        aof = str(ROOT.parent / "aof-model")
        if aof not in sys.path:
            sys.path.insert(0, aof)
        import formats as F
        t = F._target(port)
        if not t:
            return {"ok": False, "reason": f"no Ignition client on CDP port {port}"}
        res = F._ev(t["webSocketDebuggerUrl"], F._LOBBY + _SCRAPE_JS)
    except Exception as e:  # a closed window, a dead port, a CDP hiccup
        return {"ok": False, "reason": f"could not read the client: {e}"}
    if not isinstance(res, dict):
        return {"ok": False, "reason": f"unexpected reply from the client: {res!r}"}
    if not res.get("ok"):
        return res
    try:
        cents = int(round(float(res["amount"]) * 100))
    except Exception:
        return {"ok": False, "reason": f"could not read an amount from {res.get('raw')!r}"}
    if cents < 0 or cents > 100_000_000:  # a negative or a $1M+ cashier is a mis-read, not a fact
        return {"ok": False, "reason": f"implausible balance {cents / 100:.2f} read from {res.get('raw')!r} ({res.get('how')})"}
    out = {"ok": True, "amountCents": cents, "currency": "USD", "how": res.get("how"), "raw": res.get("raw")}
    ip = in_play(port)
    out["seated"] = bool(ip.get("seated"))
    out["inPlayCents"] = ip.get("inPlayCents") if ip.get("seated") else None
    out["inPlayHow"] = ip.get("how") or ip.get("reason")
    out["equityCents"] = cents + (out["inPlayCents"] or 0)
    return out


_cache: dict = {"at": 0.0, "port": None, "res": None}


def scrape_cached(port: int, ttl: float = 15.0) -> dict:
    """scrape(), memoised for a few seconds. The setup page polls preflight every
    second and a CDP round trip per poll would make it crawl; a balance does not
    move while nobody is playing. Session start and end never use this."""
    now = time.time()
    if _cache["res"] is not None and _cache["port"] == port and now - _cache["at"] < ttl:
        return _cache["res"]
    res = scrape(port)
    _cache.update({"at": now, "port": port, "res": res})
    return res


def snapshot(profile: str, port: int, session_id: str | None = None, phase: str | None = None) -> dict:
    """Scrape and record in one step — what session start and session end call."""
    got = scrape(port)
    if not got.get("ok"):
        return got
    row = record(profile, got["amountCents"], "scraped", session_id, phase,
                 f"{got.get('how')} + table {got.get('inPlayHow')}" if got.get("seated") else got.get("how"),
                 got.get("raw"), in_play_cents=got.get("inPlayCents"))
    return {"ok": True, **row}


def fmt(cents: int | None) -> str:
    if cents is None:
        return "—"
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.2f}"


if __name__ == "__main__":  # python balances.py [port] — calibrate the scraper
    import sys
    print(json.dumps(scrape(int(sys.argv[1]) if len(sys.argv) > 1 else 9333), indent=2))
