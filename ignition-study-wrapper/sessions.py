"""Declared study sessions: presets, preflight, the session record.

A session is DECLARED before anything opens, not inferred afterwards. The
setup page (setup.html) picks a preset, shows the settings it implies, runs
the preflight against everything the mode needs, and only then does the
wrapper open the table. The record written at Start — config, preflight
results, a snapshot of every source version in force — is what the study
dashboard and Replay Review read back, so the tools agree by declaration.

Storage: data/sessions.sqlite (one row per session, JSON columns). The id is
the same `session_YYYYMMDD_HHMMSS` shape the debug recorder uses, and a
recording started by the session is written under that id, so the archive
(hands.db `sessionId`), the answers log, the solve store and the recording all
share one key.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = os.environ.get("STUDY_API", "http://localhost:2000")

# --------------------------------------------------------------------- presets

# The MODES a session can be declared in. Modes WITH answers are the
# dashboard's whole-hand strategies (gto-trainer services/strategies.ts —
# Ignition 25NL Zone 3-max Exploit, Ignition 200NL Zone 3-handed Equilibrium, …),
# fetched from :2000 so this page and the
# dashboard's Sources → Strategies pane and Playthrough picker all read the
# same definition: name, tagline, the three layers, its safeguard status. The
# generic "Study answers · MES / GTO" presets below only stand in when the
# API cannot be reached. Modes WITHOUT answers (silent, capture QA, test rig)
# are the wrapper's own.
STRATEGY_PREFIX = "strategy:"

# Formats (formats.json ids) per strategy. The dashboard now serves `formats` /
# `defaultFormat` on every strategy (gto-trainer services/strategies.ts); this map
# only stands in for an older API. Pool-exploit layers (MES preflop, MES postflop,
# measured pool) were built for NL25 Zone; the NL200 equilibrium strategy is the
# NL200 Zone 3-handed charts. Practice tables are allowed for every strategy
# (flagged in the archive, never graded).
_PRACTICE = ["ign-practice-ring", "ign-practice-zone"]
FORMAT_FALLBACK = {
    "ign25-zone-3max-exploit": {"formats": ["ign-zone-NL25"] + _PRACTICE, "default": "ign-zone-NL25"},
    "ign200-zone-3max-equilibrium": {"formats": ["ign-zone-NL200"] + _PRACTICE, "default": "ign-zone-NL200"},
    # + the NL5 ring TEST STAKE (formats.json `test`): NL200 answers on a $0.02/$0.05 table
    "ign200-ring-6max-equilibrium": {"formats": ["ign-ring-NL200-6", "ign-ring-NL5-6"] + _PRACTICE, "default": "ign-ring-NL200-6"},
}

BASE_PRESETS: dict[str, dict] = {
    "silent": {
        "label": "Silent play",
        "tagline": "No answers. Every hand is still archived and graded afterwards — the control group.",
        "config": {"answers": False,
                   "sources": {"exploitPreflop": False, "mesPostflop": False, "aiChain": False},
                   "recording": True, "budget": {"hands": None, "minutes": None},
                   "autoExecute": False, "autoRealMoney": False, "autoBudget": {"minutes": 30, "hands": 50}, "autoDelay": "instant", "autoTimeBank": True,
                   "format": "ign-practice-ring", "buyinBb": 100, "waitForBb": True, "profile": None, "tables": 1, "site": "ignition"},
        "formats": None, "defaultFormat": "ign-practice-ring",
        "requires": [], "sites": ["ignition", "coinpoker"],
    },
    "capture-qa": {
        "label": "Capture QA",
        "tagline": "Answers off, frame-by-frame recording on. For checking the reader and the replica against the real client.",
        "config": {"answers": False,
                   "sources": {"exploitPreflop": False, "mesPostflop": False, "aiChain": False},
                   "recording": True, "budget": {"hands": None, "minutes": None},
                   "autoExecute": False, "autoRealMoney": False, "autoBudget": {"minutes": 30, "hands": 50}, "autoDelay": "instant", "autoTimeBank": True,
                   "format": "ign-practice-ring", "buyinBb": 100, "waitForBb": True, "profile": None, "tables": 1, "site": "ignition"},
        "formats": None, "defaultFormat": "ign-practice-ring",
        # Ignition only: this mode IS the frame recorder, which frames the Ignition browser
        "requires": ["recording"], "sites": ["ignition"],
    },
    "test-rig": {
        "label": "Test rig",
        "tagline": "The fake table with authored spots. Answers on, nothing archived as played hands.",
        "config": {"answers": True,
                   "sources": {"exploitPreflop": True, "mesPostflop": True, "aiChain": True},
                   "recording": True, "budget": {"hands": None, "minutes": None},
                   "autoExecute": False, "autoRealMoney": False, "autoBudget": {"minutes": 30, "hands": 50}, "autoDelay": "instant", "autoTimeBank": True,
                   "format": None, "buyinBb": 100, "waitForBb": True, "profile": None, "tables": 1, "site": "ignition"},
        "formats": None, "defaultFormat": None,
        "requires": ["fake"], "sites": ["ignition"],
    },
}
# (there are deliberately NO stand-in answering modes: see presets())
NO_ANSWER_MODES = ("silent", "capture-qa", "test-rig")


def fetch_strategies(timeout: float = 6.0) -> list[dict] | None:
    """The dashboard's strategy catalogue (GET /api/dashboard/sources/strategies)."""
    try:
        with urllib.request.urlopen(f"{API}/api/dashboard/sources/strategies", timeout=timeout) as r:
            j = json.loads(r.read().decode("utf-8"))
        return j.get("strategies") if j.get("ok") else None
    except Exception:
        return None


# The two preflop chart stores, and the preflight check that covers each.
CHART_CHECKS = {"hrc-6max": "hrc6max"}


def chart_check(preflop_layer: dict) -> str:
    """Which store this strategy's preflop piece reads, as a preflight check id.
    Anything but the 6-max ring set is served by :8777."""
    return CHART_CHECKS.get(preflop_layer.get("source") or "", "hrc")


def _strategy_preset(s: dict) -> dict:
    """One session mode per whole-hand strategy: its config IS the strategy."""
    pre, post = s.get("preflop"), s.get("postflop")
    exploit = pre == "exploit"
    mes = post == "mes"
    layers = [s.get("preflopLayer") or {}, s.get("postflopLayer") or {}, s.get("opponentLayer") or {}]
    # WHICH CHART STORE THIS STRATEGY READS (2026-09-20). Every answering session used to
    # require ":8777 up", which is only true of the 3-max families. The 6-max ring charts are
    # baked into gto-trainer's data/hrc6max-preflop.sqlite and read from there — chart
    # RESOLUTION as well as the line walk (services/hrc6maxDb.ts) — so a ring session with the
    # server down is not degraded at all, and blocking it was simply wrong. The 3-max path is
    # unchanged: both the equilibrium charts AND the exploit overlay walk the 3-max tree on
    # :8777 (fastSolve.ts solvePreflop3max), so those strategies still require it.
    requires = ["api", chart_check(layers[0])] + (["exploit"] if exploit else []) + (["mes"] if mes else []) + ["gtow"]
    return {
        "label": s.get("name") or s["id"],
        "tagline": s.get("tagline") or "",
        "strategy": {
            "id": s["id"], "name": s.get("name"), "status": s.get("status"), "reasons": s.get("reasons") or [],
            "recommended": bool(s.get("recommended")), "matrixRow": s.get("matrixRow"),
            "layers": [{"role": r, "label": l.get("label"), "short": l.get("short"), "source": l.get("source")}
                       for r, l in zip(("preflop", "postflop", "opponent"), layers)],
            "url": f"{API}/sources/strategies/{s['id']}",
        },
        # the dashboard's safeguards decide: `misspecified` (incoherent pieces) and
        # `unavailable` (a piece has no data yet — e.g. a chart set still solving) are
        # both unplayable. `drift` stays selectable, with its warning shown.
        "disabled": s.get("status") in ("misspecified", "unavailable"),
        # No mode: the strategy IS the declaration. Which preflop/postflop piece
        # answers follows from its layers (gto-trainer services/strategies.ts).
        "config": {"answers": True,
                   "sources": {"exploitPreflop": exploit, "mesPostflop": mes, "aiChain": True},
                   "recording": True, "budget": {"hands": None, "minutes": None},
                   # auto-execute: declared here, flipped live on the panel. Off by
                   # default always — an unattended relay is never something a
                   # preset turns on for you.
                   "autoExecute": False, "autoRealMoney": False,
                   "autoBudget": {"minutes": 30, "hands": 50},
                   # how the auto mode times each pick: "instant", or "random" — a
                   # fresh 1.5-2 s wait per decision (launch.py AUTO_DELAY_S; was 3-9 s until 2026-09-19)
                   "autoDelay": "instant",
                   # take the client's +45s time bank whenever it appears (the clock at
                   # ~9 s) — on by default: more time never costs anything
                   "autoTimeBank": True,
                   # top the stack back up to the table's max buy-in between hands
                   # whenever it is below it — always, no floor (Brady, 2026-09-18)
                   "autoTopUp": True,
                   "strategy": s["id"], "strategyName": s.get("name"),
                   "format": s.get("defaultFormat"), "buyinBb": 100, "waitForBb": True, "profile": None, "tables": 1},
        # the formats (formats.json ids) the strategy's layers were built for —
        # the intersection, computed by the dashboard; None = no restriction.
        # Until the dashboard serves them, FORMAT_FALLBACK carries Brady's rule
        # (2026-09-07): the pool-exploit pieces are NL25 Zone only.
        "formats": s.get("formats") if s.get("formats") is not None else FORMAT_FALLBACK.get(s["id"], {}).get("formats"),
        "defaultFormat": s.get("defaultFormat") or FORMAT_FALLBACK.get(s["id"], {}).get("default") or "ign-zone-NL25",
        "formatCoverage": s.get("formatCoverage"),   # per format: level ready|approx|none + why (dashboard's coverage model)
        "requires": requires,
        # the site(s) the strategy plays: its own `sites` when the catalogue says,
        # else read off its formats (every "ign-*" format is Ignition)
        "sites": s.get("sites") or sorted({("coinpoker" if str(f).startswith("cp-") else "ignition")
                                           for f in (s.get("formats") or ["ign-"])}),
    }


_presets_cache: dict = {"at": 0.0, "value": None, "fromApi": False, "error": None}


def presets(refresh: bool = False) -> dict[str, dict]:
    """Current modes, strategies first. Cached 30 s; the API being down falls
    back to the generic study presets, flagged so the page says so."""
    now = time.time()
    if not refresh and _presets_cache["value"] is not None and now - _presets_cache["at"] < 30:
        return _presets_cache["value"]
    strategies = fetch_strategies()
    out: dict[str, dict] = {}
    if strategies:
        for s in strategies:
            out[STRATEGY_PREFIX + s["id"]] = _strategy_preset(s)
        _presets_cache["fromApi"] = True
        _presets_cache["error"] = None
    else:
        # NO stand-ins. The catalogue (the study API's strategies endpoint) is the only
        # source of a mode that answers; without it the setup page blocks with the reason.
        _presets_cache["fromApi"] = False
        _presets_cache["error"] = f"strategy catalogue unreachable: {API}/api/dashboard/sources/strategies"
    for k in NO_ANSWER_MODES:
        out[k] = json.loads(json.dumps(BASE_PRESETS[k]))
    _presets_cache.update({"at": now, "value": out})
    return out


def presets_from_api() -> bool:
    return bool(_presets_cache["fromApi"])


def presets_error() -> str | None:
    """Why no answering mode is on offer (None when the catalogue was read)."""
    return _presets_cache.get("error")


class _PresetsView(dict):
    """`PRESETS[...]` keeps working for callers that index it (launch.py did)."""
    def __getitem__(self, k):
        return presets()[k]
    def __contains__(self, k):
        return k in presets()
    def get(self, k, default=None):
        return presets().get(k, default)
    def items(self):
        return presets().items()
    def keys(self):
        return presets().keys()
    def __iter__(self):
        return iter(presets())
    def __len__(self):
        return len(presets())


PRESETS = _PresetsView()

CHECK_LABELS = {
    "api": "Study API on :2000",
    "hrc": "3-max chart server on :8777",
    "hrc6max": "6-max ring preflop charts readable",
    "exploit": "3-handed Zone 25NL preflop exploit charts armed",
    "mes": "MES flop solves loaded",
    "gtow": "GTO Wizard session with a live token",
    "gtow-multiway": "GTO Wizard session that can solve multiway",
    "recording": "Debug recording directory writable",
    "fake": "Launched as the test rig",
    "profile": "Account profile declared",
    "balance": "Account balance readable",
    "net": "Connection fast enough for GTO Wizard answers",
}


def merged_config(preset: str, overrides: dict | None) -> dict:
    base = json.loads(json.dumps(presets()[preset]["config"]))
    for k, v in (overrides or {}).items():
        if k == "sources" and isinstance(v, dict):
            base["sources"].update({kk: bool(vv) for kk, vv in v.items()})
        elif k == "budget" and isinstance(v, dict):
            base["budget"].update({kk: (int(vv) if vv not in (None, "", 0, "0") else None) for kk, vv in v.items()})
        elif k in ("answers", "recording", "autoExecute", "autoRealMoney", "autoTimeBank", "autoTopUp", "clearCache"):
            base[k] = bool(v)
        elif k == "autoDelay" and v in ("instant", "random"):
            base[k] = v
        elif k == "autoBudget" and isinstance(v, dict):
            # the real-money allowance declared up front (launch.py _set_auto
            # clamps these again: 1-120 min, 1-500 hands)
            base.setdefault("autoBudget", {"minutes": 30, "hands": 50})
            for kk in ("minutes", "hands"):
                if kk in v:
                    try:
                        base["autoBudget"][kk] = max(1, int(v[kk]))
                    except (TypeError, ValueError):
                        pass
        elif k == "format":
            base[k] = str(v) if v else None
        elif k == "site":
            # WHICH POKER SITE (Poker Wrapper, 2026-09-22): ignition | coinpoker
            base[k] = v if v in ("ignition", "coinpoker") else "ignition"
        elif k == "cpTable":
            # the CoinPoker table the session attaches to (the room name from the setup page's list). Unlisted keys
            # are dropped here, which is how a picked table once read as "pick the table to attach to" (2026-09-23)
            base[k] = str(v)[:200] if v else None
        elif k == "buyinBb":
            try:
                base[k] = max(1.0, float(v))
            except (TypeError, ValueError):
                pass
        elif k == "waitForBb":
            base[k] = bool(v)
        elif k == "profile":
            base[k] = str(v) if v else None
        elif k == "tables":
            # HOW MANY TABLES THIS SESSION OPENS. Only 1, 2 and 4: the tiler
            # splits a screen in halves or quarters, and three tables would
            # leave a quarter empty while still costing every table the smaller
            # window. Anything else falls back to one rather than guessing.
            try:
                base[k] = int(v) if int(v) in (1, 2, 4) else 1
            except (TypeError, ValueError):
                base[k] = 1
    return base


# ------------------------------------------------------------------ preflight

def fetch_registry(timeout: float = 6.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"{API}/api/dashboard/sources/registry", timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def requirements_for(preset: str, config: dict) -> list[str]:
    """What the DECLARED config needs, not just the preset: switching a source
    on in the settings adds its check; switching answers off drops them."""
    req = list(presets()[preset]["requires"])
    if config.get("answers"):
        if "api" not in req: req.append("api")
        src = config.get("sources", {})
        if src.get("exploitPreflop") and "exploit" not in req: req.append("exploit")
        if src.get("mesPostflop") and "mes" not in req: req.append("mes")
        if src.get("aiChain") and "gtow" not in req: req.append("gtow")
        # The preset already names the chart store its strategy reads (chart_check):
        # "hrc" for the 3-max families on :8777, "hrc6max" for the baked ring set. Only
        # add a default when the preset named neither — never override the one it chose,
        # which is what appending "hrc" unconditionally used to do.
        if not any(k in req for k in ("hrc", "hrc6max")): req.append("hrc")
    else:
        for k in ("exploit", "mes", "gtow", "hrc", "hrc6max"):
            if k in req: req.remove(k)
    if config.get("recording") and "recording" not in req:
        req.append("recording")
    return req


def run_preflight(preset: str, config: dict, fake_mode: bool, registry: dict | None, cdp_port: int | None = None) -> dict:
    """Every check the mode needs, each with ok + a one-line reason. Blocks
    when any REQUIRED check fails — a session that would answer from a
    source that is down is not a session worth recording."""
    req = requirements_for(preset, config)
    # A real-money session must say WHOSE account it is and what was in it when it
    # started: the opening balance is the anchor the whole reconciliation hangs off
    # (see balances.py — between two snapshots the money may only move by poker).
    # The test rig has no client and no account, so neither applies there.
    # The opening BALANCE is no longer a gate (Brady, 2026-09-17): the wrapper reads it itself the moment the
    # client can be read - at start if the lobby is already open, else right after the router signs in - and a
    # fresh profile's first reading is its seed. Shown below as an advisory so the setup page still says what it saw.
    coinpoker = config.get("site") == "coinpoker"
    if not fake_mode and not coinpoker:
        # the profile names the IGNITION account the router signs in as; a CoinPoker
        # client stays signed in by itself and the hero is read from its log
        req += [k for k in ("profile",) if k not in req]
    armed = (registry or {}).get("armed") or {}
    cards = {c["id"]: c for c in (registry or {}).get("cards", [])}

    def card(cid: str) -> dict:
        return cards.get(cid) or {}

    checks = []

    def add(cid: str, ok: bool, detail: str, always: bool = False):
        # Only what THIS mode answers from is listed. A strategy without an
        # exploit piece must not show "exploit charts armed" at all — an
        # equilibrium session was reading it as a failed requirement
        # (2026-09-12). `api` is always shown: nothing works without it.
        # `always` shows a row that is NOT a requirement — something worth
        # seeing before you sit down, but not a reason to refuse the seat.
        if cid != "api" and not always and cid not in req:
            return
        checks.append({"id": cid, "label": CHECK_LABELS[cid], "required": cid in req, "ok": bool(ok), "detail": detail})

    add("api", registry is not None, "reachable · " + (f"poller {'running' if armed.get('poller', {}).get('running') else 'stopped'}" if registry else f"no reply from {API}"))
    hrc = armed.get("hrc") or {}
    add("hrc", bool(hrc.get("up")), f"{'up' if hrc.get('up') else 'down'} · probe {hrc.get('ms', '?')} ms" if registry else "unknown (API down)")
    # The 6-max ring set is READABLE, which is not the same question as ":8777 up": it is
    # baked into the API's own SQLite and read from there, and the server is only what
    # answers if the bake is missing. Either one satisfies this check, and the detail says
    # which is actually carrying the session.
    hrc6 = armed.get("hrc6max") or {}
    if not registry:
        add("hrc6max", False, "unknown (API down)")
    elif hrc6.get("db"):
        add("hrc6max", True, f"baked DB · {hrc6.get('trees', '?')} trees · :8777 not needed")
    elif hrc.get("up"):
        add("hrc6max", True, f"no local bake — every node from :8777 ({hrc.get('ms', '?')} ms; run build_6max_preflop_db.py)")
    else:
        add("hrc6max", False, "no local bake on the API's machine and :8777 is down — nothing can serve the ring charts")
    ex = card("exploit-preflop")
    add("exploit", bool(armed.get("exploitPreflop")), (ex.get("stateText") or "unknown") + (" · " + next((v for k, v in ex.get("facts", []) if k == "freshness"), "") if ex else ""))
    mes = card("mes-postflop")
    add("mes", bool(armed.get("mesPostflop")), f"{armed.get('mesBoards', 0)} boards · " + next((v for k, v in mes.get("facts", []) if k == "generation"), "") if registry else "unknown (API down)")
    # GTO WIZARD IS A POOL, NOT A CLIENT (services/gtowSessions.ts). The Elite
    # session takes heads-up solves so the Ultra session's daily allowance goes
    # only on multiway trees, so "is GTO Wizard up" is really two questions:
    # can we answer ANYTHING, and can we answer a 3+ player spot. The first is
    # the requirement; the second is reported but never blocks — playing on the
    # Elite account alone, with multiway degraded, is exactly what the second
    # account is FOR when the Ultra allowance is spent.
    g = armed.get("gtow") or {}
    gsess = g.get("sessions") or []

    def _sess_line(x: dict) -> str:
        mins = x.get("expiresInMs")
        state = x.get("state")
        tail = f"{round(mins / 60000)} min" if (state == "up" and mins) else (x.get("blockedReason") or x.get("text") or state)
        return f"{x.get('id')} ({'multiway' if x.get('multiway') else 'heads-up'}): {tail}"

    if gsess:
        summary = " · ".join(_sess_line(x) for x in gsess if x.get("enabled"))
    else:
        summary = ("token live" + (f" · {round((g.get('expiresInMs') or 0) / 60000)} min left" if g.get("expiresInMs") else "")) if g.get("tokenLive") else ""
    add("gtow", bool(g.get("tokenLive")),
        summary if g.get("tokenLive")
        else (summary or "a client is up but no session has a token — sign in (or enter the activation code) in its window") if g.get("clientUp")
        else (summary or "no session reachable — start one: scripts/start_gtow_chrome.ps1 or scripts/start_gtow_secondary.ps1"))
    # Carry the per-session rows on the check itself, so the setup page can put a
    # Connect next to the session that is actually down instead of one button for
    # "GTO Wizard" as a whole.
    if checks and checks[-1]["id"] == "gtow":
        checks[-1]["sessions"] = [
            {"id": x.get("id"), "label": x.get("label"), "state": x.get("state"), "text": x.get("text"),
             "multiway": bool(x.get("multiway")), "expiresInMs": x.get("expiresInMs"),
             "cdpHost": x.get("cdpHost"), "blockedReason": x.get("blockedReason")}
            for x in gsess if x.get("enabled")
        ]

    # Only shown for a strategy that uses GTO Wizard at all. Every strategy in
    # the catalogue today is multi-handed (3-max Zone, 6-max ring), so losing
    # multiway always costs real coverage — but it costs COVERAGE, not the
    # session, so this row is informational.
    if "gtow" in req:
        mw = bool(g.get("multiwayLive"))
        mw_sess = [x for x in gsess if x.get("multiway") and x.get("enabled")]
        add("gtow-multiway", mw,
            ("via " + ", ".join(str(x.get("id")) for x in mw_sess if x.get("state") == "up")) if mw
            else ("no session can solve a 3+ player tree — heads-up spots still answer, multiway ones will not"
                  + (f" ({'; '.join((x.get('blockedReason') or x.get('text') or '') for x in mw_sess)})" if mw_sess else "")),
            always=True)
    dbg = ROOT / "debug"
    try:
        dbg.mkdir(exist_ok=True)
        probe = dbg / ".write-probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        add("recording", True, f"{dbg}")
    except Exception as e:
        add("recording", False, f"{dbg}: {e}")
    add("fake", fake_mode, "this instance is the fake-table rig" if fake_mode else "launch with FAKE_TABLE=1 for the test rig")
    profile = config.get("profile")
    add("profile", bool(profile), f"playing as {profile}" if profile else "pick the account on the setup page — hands are attributed to it and its balance is reconciled against them")
    if not fake_mode and not coinpoker:
        import balances as B
        bal = B.scrape_cached(cdp_port) if cdp_port else {"ok": False, "reason": "no CDP port"}
        last = B.latest(profile) if profile else None
        seeded = last is not None
        # NOT RED FOR "THE CLIENT ISN'T OPEN YET" (Brady, 2026-09-19). The wrapper reads the balance itself the
        # moment the session starts and the client is signed in, so before that the check is advisory: it shows
        # the last reading and says when the next one happens. Red is kept for a real failure — the client is
        # open and signed in, and the lobby still yields no balance.
        reason = str(bal.get("reason") or "")
        client_down = (not bal.get("ok")) and bool(re.search(r"no Ignition client|CDP port|no CDP|not open|signed[- ]out|login", reason, re.I))
        when_last = (time.strftime("%d %b %H:%M", time.localtime(last["ts"] / 1000)) if last and last.get("ts") else None)
        if bal.get("ok"):
            ok, detail = True, f"{B.fmt(bal.get('amountCents'))} read from the lobby ({bal.get('how')})"
        elif client_down:
            ok = True
            detail = ("client not open yet — read automatically at Start once it is signed in"
                      + (f" · last reading {B.fmt(last['amountCents'])} on {when_last}" if last else " · first reading for this profile = its seed"))
        else:
            ok, detail = False, f"client is open but no balance could be read ({reason or 'unknown'}) — the session's money would be unreconciled"
        checks.append({"id": "balance", "label": CHECK_LABELS["balance"], "required": False, "ok": ok, "detail": detail})

    # THE CONNECTION (2026-09-22): answers are chains of GTO Wizard requests, so a bad link turns 6 s answers
    # into 25 s ones and river spots into no answer at all (netcheck.py has the numbers and the thresholds).
    # Required whenever the session answers for real; the test rig is exempt.
    if config.get("answers") and not fake_mode:
        import netcheck as N
        nc = N.cached()
        checks.append({"id": "net", "label": CHECK_LABELS["net"], "required": True, "ok": bool(nc["ok"]),
                       "detail": nc["detail"], "probe": nc})
        if "net" not in req:
            req.append("net")

    blockers = [c for c in checks if c["required"] and not c["ok"]]
    return {"ok": not blockers, "checks": checks, "blockers": [c["label"] for c in blockers], "requires": req}


def versions_snapshot(registry: dict | None) -> dict:
    """Every source version in force at Start — what 'the study tool' WAS for this session."""
    out: dict = {"capturedAt": int(time.time() * 1000)}
    try:
        out["wrapperGit"] = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True,
                                                     stderr=subprocess.DEVNULL).strip()
    except Exception:
        out["wrapperGit"] = None
    if not registry:
        out["api"] = None
        return out
    armed = registry.get("armed") or {}
    facts = {c["id"]: dict(c.get("facts", [])) for c in registry.get("cards", [])}
    out["api"] = {"at": registry.get("at"), "strategyMode": armed.get("strategyMode")}
    out["exploitPreflop"] = {"armed": bool(armed.get("exploitPreflop")), **{k: facts.get("exploit-preflop", {}).get(k) for k in ("file", "fit to", "freshness")}}
    out["mesPostflop"] = {"loaded": bool(armed.get("mesPostflop")), "boards": armed.get("mesBoards"), **{k: facts.get("mes-postflop", {}).get(k) for k in ("families", "generation", "built")}}
    out["hrc"] = {"up": bool((armed.get("hrc") or {}).get("up")), **{k: facts.get("hrc-3max", {}).get(k) for k in ("charts", "re-solved rungs")}}
    # WHICH STORE SERVED THE RING CHARTS. A ring session that ran off the baked SQLite and
    # one that ran off :8777 read the same trees, but only one of them depended on a process
    # that could have been down — worth knowing when a session is read back.
    out["hrc6max"] = {"db": bool((armed.get("hrc6max") or {}).get("db")),
                      "trees": (armed.get("hrc6max") or {}).get("trees"),
                      **{k: facts.get("hrc-6max", {}).get(k) for k in ("served by", "progress")}}
    out["gtowCharts"] = {k: facts.get("gtow-charts", {}).get(k) for k in ("sets", "freshness")}
    _g = armed.get("gtow") or {}
    out["gtow"] = {
        "tokenLive": bool(_g.get("tokenLive")),
        "multiwayLive": bool(_g.get("multiwayLive")),
        "sessions": [{"id": x.get("id"), "state": x.get("state"), "multiway": bool(x.get("multiway")),
                      "expiresInMs": x.get("expiresInMs"), "text": x.get("text")}
                     for x in (_g.get("sessions") or []) if x.get("enabled")],
    }
    return out


# --------------------------------------------------------------------- store

DDL = """CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  preset TEXT,
  label TEXT,
  note TEXT,
  config TEXT,
  preflight TEXT,
  versions TEXT,
  events TEXT,
  summary TEXT
)"""


class SessionStore:
    def __init__(self, path: Path | None = None):
        self.path = path or (ROOT / "data" / "sessions.sqlite")

    def _db(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # timeout: how long a writer waits for another wrapper's write lock
        # before giving up — four tables write this store at once (event()).
        c = sqlite3.connect(self.path, timeout=15)
        c.execute("PRAGMA journal_mode=WAL")
        c.execute(DDL)
        return c

    @staticmethod
    def _row(r) -> dict | None:
        if not r:
            return None
        keys = ["id", "started_at", "ended_at", "preset", "label", "note", "config", "preflight", "versions", "events", "summary"]
        d = dict(zip(keys, r))
        for k in ("config", "preflight", "versions", "events", "summary"):
            try:
                d[k] = json.loads(d[k]) if d[k] else None
            except Exception:
                d[k] = None
        return d

    def start(self, sid: str, preset: str, label: str | None, note: str | None, config: dict, preflight: dict, versions: dict) -> dict:
        c = self._db()
        try:
            c.execute("INSERT INTO sessions (id, started_at, preset, label, note, config, preflight, versions, events) VALUES (?,?,?,?,?,?,?,?,?)",
                      (sid, int(time.time() * 1000), preset, label, note, json.dumps(config), json.dumps(preflight), json.dumps(versions), "[]"))
            c.commit()
        finally:
            c.close()
        return self.get(sid)  # type: ignore[return-value]

    def set_config(self, sid: str, config: dict) -> None:
        """A live session's config changed after start (a CoinPoker panel re-attached to another table): the
        resume path reads the record back, so it must carry the table the panel is on now."""
        c = self._db()
        try:
            c.execute("UPDATE sessions SET config=? WHERE id=?", (json.dumps(config), sid))
            c.commit()
        finally:
            c.close()

    def event(self, sid: str, kind: str, data: dict | None = None) -> None:
        """Append one event. READ-MODIFY-WRITE, so it must be serialized: with
        four tables joining one session in parallel (launch._fan_out), three
        wrappers read the same events list and the last write wins — two of the
        three `table-joined` records simply vanished, seen 2026-09-20. BEGIN
        IMMEDIATE takes the write lock for the whole read-append-write, and
        sqlite3's `timeout` makes the others wait for it rather than fail."""
        c = self._db()
        try:
            c.execute("BEGIN IMMEDIATE")
            r = c.execute("SELECT events FROM sessions WHERE id=?", (sid,)).fetchone()
            ev = json.loads(r[0]) if r and r[0] else []
            # THE EVENT'S OWN KIND AND TIME WIN (2026-09-23). The payload used to be spread AFTER them, so a
            # payload carrying its own "kind" or "at" silently replaced the event's: every state-check was filed
            # under its sub-kind ("request-without-buttons", 24 rows), every modal dismissal under the notice's
            # label ("buy-in above the table maximum", 22 rows), and 47 balance events carry a string where the
            # timestamp belongs — zero rows of kind "state-check" or "modal-dismissed" existed. A colliding
            # payload key is kept under a prefix rather than dropped.
            payload = {(f"payload_{k}" if k in ("at", "kind") else k): v for k, v in (data or {}).items()}
            ev.append({**payload, "at": int(time.time() * 1000), "kind": kind})
            c.execute("UPDATE sessions SET events=? WHERE id=?", (json.dumps(ev), sid))
            c.commit()
        except Exception:
            try:
                c.rollback()
            except Exception:
                pass
            raise
        finally:
            c.close()

    def end(self, sid: str, summary: dict, note: str | None) -> dict | None:
        c = self._db()
        try:
            if note is not None:
                c.execute("UPDATE sessions SET ended_at=?, summary=?, note=? WHERE id=?", (int(time.time() * 1000), json.dumps(summary), note, sid))
            else:
                c.execute("UPDATE sessions SET ended_at=?, summary=? WHERE id=?", (int(time.time() * 1000), json.dumps(summary), sid))
            c.commit()
        finally:
            c.close()
        return self.get(sid)

    def get(self, sid: str) -> dict | None:
        c = self._db()
        try:
            return self._row(c.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone())
        finally:
            c.close()

    def open_session(self) -> dict | None:
        """The most recent session that was never ended (a wrapper restart mid-session)."""
        rows = self.open_sessions()
        return rows[0] if rows else None

    def open_sessions(self) -> list[dict]:
        """EVERY session never ended, newest first. Several accumulate when the
        wrapper is restarted more than once mid-session; ending only the newest
        left the next one to resurface on /setup as if nothing had happened."""
        c = self._db()
        try:
            return [self._row(r) for r in c.execute("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC").fetchall()]  # type: ignore[misc]
        finally:
            c.close()

    def list(self, limit: int = 50) -> list[dict]:
        c = self._db()
        try:
            return [self._row(r) for r in c.execute("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?", (limit,)).fetchall()]  # type: ignore[misc]
        finally:
            c.close()


def new_session_id() -> str:
    return time.strftime("session_%Y%m%d_%H%M%S")
