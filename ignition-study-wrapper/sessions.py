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
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = os.environ.get("STUDY_API", "http://localhost:2000")

# --------------------------------------------------------------------- presets

# The MODES a session can be declared in. Modes WITH answers are the
# dashboard's whole-hand strategies (gto-trainer services/strategies.ts —
# Apex, Vanguard, Bedrock, …), fetched from :2000 so this page and the
# dashboard's Sources → Strategies pane and Playthrough picker all read the
# same definition: name, tagline, the three layers, its safeguard status. The
# generic "Study answers · MES / GTO" presets below only stand in when the
# API cannot be reached. Modes WITHOUT answers (silent, capture QA, test rig)
# are the wrapper's own.
STRATEGY_PREFIX = "strategy:"

# Formats (formats.json ids) per strategy while the dashboard does not serve
# `formats`/`defaultFormat` itself. Pool-exploit layers (MES preflop, MES
# postflop, measured pool) were built for NL25 Zone; equilibrium layers route
# by stake and are valid anywhere. Practice tables are allowed for every
# strategy (flagged in the archive, never graded).
_PRACTICE = ["ign-practice-ring", "ign-practice-zone"]
FORMAT_FALLBACK = {
    "apex": {"formats": ["ign-zone-NL25"] + _PRACTICE, "default": "ign-zone-NL25"},
    "vanguard": {"formats": ["ign-zone-NL25"] + _PRACTICE, "default": "ign-zone-NL25"},
    "bedrock": {"formats": None, "default": "ign-zone-NL25"},
    "mirage": {"formats": ["ign-zone-NL25"] + _PRACTICE, "default": "ign-zone-NL25"},
}

BASE_PRESETS: dict[str, dict] = {
    "study-mes": {
        "label": "Study answers · MES",
        "tagline": "Play with answers on. Pool-exploit preflop and MES flops lead; GTO Wizard fills the rest.",
        "config": {"answers": True, "mode": "exploit",
                   "sources": {"exploitPreflop": True, "mesPostflop": True, "aiChain": True},
                   "recording": False, "budget": {"hands": None, "minutes": None},
                   "format": None, "buyinBb": 100, "waitForBb": True, "profile": None},
        "formats": None, "defaultFormat": None,
        "requires": ["api", "hrc", "exploit", "mes", "gtow"],
    },
    "study-gto": {
        "label": "Study answers · GTO",
        "tagline": "Play with answers on. Equilibrium charts and the GTO Wizard chain; the MES answer rides along for comparison.",
        "config": {"answers": True, "mode": "chart",
                   "sources": {"exploitPreflop": False, "mesPostflop": False, "aiChain": True},
                   "recording": False, "budget": {"hands": None, "minutes": None},
                   "format": None, "buyinBb": 100, "waitForBb": True, "profile": None},
        "formats": None, "defaultFormat": None,
        "requires": ["api", "hrc", "gtow"],
    },
    "silent": {
        "label": "Silent play",
        "tagline": "No answers. Every hand is still archived and graded afterwards — the control group.",
        "config": {"answers": False, "mode": "chart",
                   "sources": {"exploitPreflop": False, "mesPostflop": False, "aiChain": False},
                   "recording": False, "budget": {"hands": None, "minutes": None},
                   "format": "ign-practice-ring", "buyinBb": 100, "waitForBb": True, "profile": None},
        "formats": None, "defaultFormat": "ign-practice-ring",
        "requires": [],
    },
    "capture-qa": {
        "label": "Capture QA",
        "tagline": "Answers off, frame-by-frame recording on. For checking the reader and the replica against the real client.",
        "config": {"answers": False, "mode": "chart",
                   "sources": {"exploitPreflop": False, "mesPostflop": False, "aiChain": False},
                   "recording": True, "budget": {"hands": None, "minutes": None},
                   "format": "ign-practice-ring", "buyinBb": 100, "waitForBb": True, "profile": None},
        "formats": None, "defaultFormat": "ign-practice-ring",
        "requires": ["recording"],
    },
    "test-rig": {
        "label": "Test rig",
        "tagline": "The fake table with authored spots. Answers on, nothing archived as played hands.",
        "config": {"answers": True, "mode": "exploit",
                   "sources": {"exploitPreflop": True, "mesPostflop": True, "aiChain": True},
                   "recording": False, "budget": {"hands": None, "minutes": None},
                   "format": None, "buyinBb": 100, "waitForBb": True, "profile": None},
        "formats": None, "defaultFormat": None,
        "requires": ["fake"],
    },
}
GENERIC_STUDY = ("study-mes", "study-gto")     # stand-ins, only when the API is down
NO_ANSWER_MODES = ("silent", "capture-qa", "test-rig")


def fetch_strategies(timeout: float = 6.0) -> list[dict] | None:
    """The dashboard's strategy catalogue (GET /api/dashboard/sources/strategies)."""
    try:
        with urllib.request.urlopen(f"{API}/api/dashboard/sources/strategies", timeout=timeout) as r:
            j = json.loads(r.read().decode("utf-8"))
        return j.get("strategies") if j.get("ok") else None
    except Exception:
        return None


def _strategy_preset(s: dict) -> dict:
    """One session mode per whole-hand strategy: its config IS the strategy."""
    pre, post = s.get("preflop"), s.get("postflop")
    exploit = pre == "exploit"
    mes = post == "mes"
    layers = [s.get("preflopLayer") or {}, s.get("postflopLayer") or {}, s.get("opponentLayer") or {}]
    requires = ["api", "hrc"] + (["exploit"] if exploit else []) + (["mes"] if mes else []) + ["gtow"]
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
        "disabled": s.get("status") == "misspecified",
        "config": {"answers": True, "mode": "exploit" if exploit else "chart",
                   "sources": {"exploitPreflop": exploit, "mesPostflop": mes, "aiChain": True},
                   "recording": False, "budget": {"hands": None, "minutes": None},
                   "strategy": s["id"], "strategyName": s.get("name"),
                   "format": s.get("defaultFormat"), "buyinBb": 100, "waitForBb": True, "profile": None},
        # the formats (formats.json ids) the strategy's layers were built for —
        # the intersection, computed by the dashboard; None = no restriction.
        # Until the dashboard serves them, FORMAT_FALLBACK carries Brady's rule
        # (2026-09-07): the pool-exploit pieces are NL25 Zone only.
        "formats": s.get("formats") if s.get("formats") is not None else FORMAT_FALLBACK.get(s["id"], {}).get("formats"),
        "defaultFormat": s.get("defaultFormat") or FORMAT_FALLBACK.get(s["id"], {}).get("default") or "ign-zone-NL25",
        "formatCoverage": s.get("formatCoverage"),   # per format: level ready|approx|none + why (dashboard's coverage model)
        "requires": requires,
    }


_presets_cache: dict = {"at": 0.0, "value": None, "fromApi": False}


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
    else:
        for k in GENERIC_STUDY:
            p = json.loads(json.dumps(BASE_PRESETS[k]))
            p["tagline"] = "(generic — the dashboard's strategy catalogue on :2000 could not be reached) " + p["tagline"]
            out[k] = p
        _presets_cache["fromApi"] = False
    for k in NO_ANSWER_MODES:
        out[k] = json.loads(json.dumps(BASE_PRESETS[k]))
    _presets_cache.update({"at": now, "value": out})
    return out


def presets_from_api() -> bool:
    return bool(_presets_cache["fromApi"])


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
    "exploit": "Pool-exploit preflop overlay armed",
    "mes": "MES flop solves loaded",
    "gtow": "GTO Wizard client with a live token",
    "recording": "Debug recording directory writable",
    "fake": "Launched as the test rig",
}


def merged_config(preset: str, overrides: dict | None) -> dict:
    base = json.loads(json.dumps(presets()[preset]["config"]))
    for k, v in (overrides or {}).items():
        if k == "sources" and isinstance(v, dict):
            base["sources"].update({kk: bool(vv) for kk, vv in v.items()})
        elif k == "budget" and isinstance(v, dict):
            base["budget"].update({kk: (int(vv) if vv not in (None, "", 0, "0") else None) for kk, vv in v.items()})
        elif k in ("answers", "recording"):
            base[k] = bool(v)
        elif k == "mode" and v in ("exploit", "chart"):
            base[k] = v
        elif k == "format":
            base[k] = str(v) if v else None
        elif k == "buyinBb":
            try:
                base[k] = max(1.0, float(v))
            except (TypeError, ValueError):
                pass
        elif k == "waitForBb":
            base[k] = bool(v)
        elif k == "profile":
            base[k] = str(v) if v else None
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
        if "hrc" not in req: req.append("hrc")
    else:
        for k in ("exploit", "mes", "gtow", "hrc"):
            if k in req: req.remove(k)
    if config.get("recording") and "recording" not in req:
        req.append("recording")
    return req


def run_preflight(preset: str, config: dict, fake_mode: bool, registry: dict | None) -> dict:
    """Every check the mode needs, each with ok + a one-line reason. Blocks
    when any REQUIRED check fails — a session that would answer from a
    source that is down is not a session worth recording."""
    req = requirements_for(preset, config)
    armed = (registry or {}).get("armed") or {}
    cards = {c["id"]: c for c in (registry or {}).get("cards", [])}

    def card(cid: str) -> dict:
        return cards.get(cid) or {}

    checks = []

    def add(cid: str, ok: bool, detail: str):
        checks.append({"id": cid, "label": CHECK_LABELS[cid], "required": cid in req, "ok": bool(ok), "detail": detail})

    add("api", registry is not None, "reachable · " + (f"poller {'running' if armed.get('poller', {}).get('running') else 'stopped'}" if registry else f"no reply from {API}"))
    hrc = armed.get("hrc") or {}
    add("hrc", bool(hrc.get("up")), f"{'up' if hrc.get('up') else 'down'} · probe {hrc.get('ms', '?')} ms" if registry else "unknown (API down)")
    ex = card("exploit-preflop")
    add("exploit", bool(armed.get("exploitPreflop")), (ex.get("stateText") or "unknown") + (" · " + next((v for k, v in ex.get("facts", []) if k == "freshness"), "") if ex else ""))
    mes = card("mes-postflop")
    add("mes", bool(armed.get("mesPostflop")), f"{armed.get('mesBoards', 0)} boards · " + next((v for k, v in mes.get("facts", []) if k == "generation"), "") if registry else "unknown (API down)")
    g = armed.get("gtow") or {}
    add("gtow", bool(g.get("tokenLive")), ("token live" + (f" · {round((g.get('expiresInMs') or 0) / 60000)} min left" if g.get("expiresInMs") else "")) if g.get("tokenLive") else ("client up, no token yet — open GTO Wizard and sign in" if g.get("clientUp") else "client not reachable — start it with scripts/start_gtow_ai.ps1"))
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
    out["gtowCharts"] = {k: facts.get("gtow-charts", {}).get(k) for k in ("sets", "freshness")}
    out["gtow"] = {"tokenLive": bool((armed.get("gtow") or {}).get("tokenLive"))}
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
        c = sqlite3.connect(self.path, timeout=5)
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

    def event(self, sid: str, kind: str, data: dict | None = None) -> None:
        c = self._db()
        try:
            r = c.execute("SELECT events FROM sessions WHERE id=?", (sid,)).fetchone()
            ev = json.loads(r[0]) if r and r[0] else []
            ev.append({"at": int(time.time() * 1000), "kind": kind, **(data or {})})
            c.execute("UPDATE sessions SET events=? WHERE id=?", (json.dumps(ev), sid))
            c.commit()
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
