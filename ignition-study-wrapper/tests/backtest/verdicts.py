"""THE PER-DECISION VERDICT TABLE (hardening pass, 2026-09-23).

    python tests/backtest/verdicts.py [--out DIR]

One row per hero decision in the archive, four columns of truth side by side:

  CAPTURE   what the export carried at the decision — the archived line (complete) beside the WS-only
            snapshot the raw frames give at the moment the client asked hero to act
            (tests/replay_ws_decisions.py -> tests/backtest/ws_decisions.jsonl), and the capture faults
            the API's captureFaults names on the archived line.
  ANSWER    what the table got THEN (every answers.sqlite row for that decision) and what the CURRENT
            solve path returns NOW (gto-trainer/apps/api/src/scripts/hardeningBacktest.ts ->
            src/scripts/hardening_backtest.jsonl).
  EXECUTE   what the wrapper did with it: the pick-executed / pick-outcome / pick-refused /
            study-auto-held events of the session (sessions.sqlite), hero's archived action at that
            index, whether it FOLLOWED the pick, and whether auto was armed with no press recorded
            (a manual takeover or a missed press).
  VERDICT   one word per decision, by distinct hand and by street:
            OK · FIXED · STILL(<class>) · BROKE · CORRECT-REFUSAL · NEVER-ASKED(<why>) · SKIPPED · UNVERIFIED

A refusal of a capture that is provably corrupt is CORRECT behaviour, never a regression: the rotation
cross-check and captureFaults were built to refuse. The root-cause class of every STILL comes from the
solver's reason (hardeningBacktest.classifyReason) and is reported by DISTINCT HAND, because one corrupt
hand fires the same reason at every decision.

Inputs are read-only. Outputs: <out>/verdicts.csv, <out>/summary.json, <out>/summary.md.
"""
from __future__ import annotations

import csv
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]              # ignition-study-wrapper/
API = ROOT.parent / "gto-trainer" / "apps" / "api"
HANDS_DB = ROOT / "data" / "hands.db"
SESSIONS_DB = ROOT / "data" / "sessions.sqlite"
ANSWERS_DB = API / "data" / "answers.sqlite"
BACKTEST = API / "src" / "scripts" / "hardening_backtest.jsonl"
WS_DECISIONS = ROOT / "tests" / "backtest" / "ws_decisions.jsonl"
OUT = ROOT / "tests" / "backtest" / "out"
STRATEGY = "ign200-ring-6max-equilibrium"
BLINDS = ("post-sb", "post-bb")


def ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)


def load_sessions():
    """session id -> {strategy, format, tables, auto windows [(from, to)], events by wrapper hand no}."""
    out = {}
    c = ro(SESSIONS_DB)
    for sid, started, ended, cfg, ev in c.execute("SELECT id, started_at, ended_at, config, events FROM sessions"):
        cfg = json.loads(cfg or "{}")
        events = json.loads(ev or "[]")
        # auto-execute windows: study-auto on:true .. (study-auto on:false | study-auto-expired | session end)
        windows, open_at = [], None
        for e in events:
            k = e.get("kind")
            at = e.get("at") if isinstance(e.get("at"), (int, float)) else None
            if k == "study-auto" and e.get("on") and open_at is None:
                open_at = at
            elif k in ("study-auto-expired",) or (k == "study-auto" and not e.get("on")):
                if open_at is not None:
                    windows.append((open_at, at or ended or 4e12)); open_at = None
        if open_at is not None:
            windows.append((open_at, ended or 4e12))
        by_hand = defaultdict(list)
        for e in events:
            if e.get("kind") in ("pick-executed", "pick-outcome", "pick-refused", "pick-retried", "study-auto-held",
                                 "study-auto-resumed", "time-bank", "top-up-prefold", "unknown-modal",
                                 "request-without-buttons", "buttons-without-request", "dealt-without-cards"):
                by_hand[e.get("hand")].append(e)
        out[sid] = {"strategy": cfg.get("strategy"), "format": cfg.get("format"), "tables": cfg.get("tables"),
                    "auto_windows": windows, "events": by_hand, "started": started, "ended": ended,
                    "test": "NL5" in str(cfg.get("format") or "")}
    return out


def load_answers():
    """(clientHandId, idx) -> [rows]."""
    out = defaultdict(list)
    c = ro(ANSWERS_DB)
    cols = [r[1] for r in c.execute("PRAGMA table_info(answers)")]
    for row in c.execute("SELECT * FROM answers WHERE client_hand_id IS NOT NULL"):
        d = dict(zip(cols, row))
        try:
            idx = json.loads(d["decision_key"])[4]
        except Exception:
            continue
        out[(str(d["client_hand_id"]), int(idx))].append(d)
    return out


def load_backtest():
    out = {}
    if not BACKTEST.exists():
        return out
    for l in BACKTEST.read_text(encoding="utf-8").splitlines():
        if not l.strip():
            continue
        try:
            r = json.loads(l)
        except Exception:
            continue
        out[(r["dbId"], r["upto"])] = r
    return out


def load_ws_decisions():
    """clientHandId -> list of WS-only snapshots at hero's turn (rising edge of CO_SELECT_REQ)."""
    out = defaultdict(list)
    if not WS_DECISIONS.exists():
        return out
    for l in WS_DECISIONS.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(l)
        except Exception:
            continue
        if r.get("clientHandId"):
            out[str(r["clientHandId"])].append(r)
    return out


def line_of(actions) -> str:
    return " ".join(f"{a.get('seatId')}:{a.get('type')}{'' if a.get('amount') is None else ':' + str(a.get('amount'))}" for a in actions)


def hero_action_matches(pick: str | None, act: dict) -> bool | None:
    """Did hero's archived action follow the pick? None = cannot tell."""
    if not pick:
        return None
    p = pick.strip().lower()
    t = (act.get("type") or "").lower()
    amt = act.get("amount")
    if p.startswith("fold"):
        return t == "fold"
    if p.startswith("check"):
        return t == "check"
    if p.startswith("call") or p.startswith("limp"):
        return t in ("call", "all-in")
    if p.startswith("all") or p.startswith("jam") or p.startswith("shove"):
        return t == "all-in" or (t in ("raise", "bet"))
    if p.startswith("raise") or p.startswith("bet") or p[:1] == "r":
        if t not in ("raise", "bet", "all-in"):
            return False
        import re
        m = re.search(r"(\d+(?:\.\d+)?)", p)
        if not m or amt is None:
            return None
        want = float(m.group(1))
        return abs(float(amt) - want) <= max(0.12 * want, 0.05)
    return None


def main() -> int:
    out_dir = OUT
    if "--out" in sys.argv:
        out_dir = Path(sys.argv[sys.argv.index("--out") + 1])
    out_dir.mkdir(parents=True, exist_ok=True)

    sessions = load_sessions()
    answers = load_answers()
    backtest = load_backtest()
    ws = load_ws_decisions()

    rows = []
    c = ro(HANDS_DB)
    for rowid, played, stakes, data in c.execute("SELECT rowid, played_at, stakes, data FROM hands ORDER BY rowid"):
        d = json.loads(data)
        sid = d.get("sessionId")
        sess = sessions.get(sid) if sid else None
        in_scope = (sess["strategy"] == STRATEGY) if sess else (stakes == "$1.00/$2.00" and (played or 0) >= 1789689600000)
        if not in_scope:
            continue
        chid = str(d.get("clientHandId") or "")
        acts = d.get("actions") or []
        hero_no = d.get("handId")
        ev = (sess or {}).get("events", {}).get(hero_no, []) if sess else []
        auto_on = any(a <= (played or 0) <= b for a, b in (sess or {}).get("auto_windows", [])) if sess else False
        # decisions this hand in order, to match pick events by order when there are several
        dec_idx = [i for i, a in enumerate(acts) if a.get("hero") and a.get("type") not in BLINDS]
        picks = [e for e in ev if e.get("kind") == "pick-executed"]
        outcomes = [e for e in ev if e.get("kind") == "pick-outcome"]
        refused = [e for e in ev if e.get("kind") == "pick-refused"]
        held = [e for e in ev if e.get("kind") == "study-auto-held"]
        snaps = ws.get(chid, [])
        for n, i in enumerate(dec_idx):
            a = acts[i]
            bt = backtest.get((rowid, i))
            ans = answers.get((chid, i), []) if chid else []
            then_ok = any(bool(r.get("text")) for r in ans) if ans else None
            then_pick = next((r.get("pick") for r in ans if r.get("text")), None)
            # EVERY pick the table was shown for this decision: more than one distinct pick means the decision was
            # re-solved and RE-ROLLED live (the poller's decisionKey carries toCall, which flickers) — the pick could
            # flip under hero, and the press that followed may match a later roll rather than the first.
            then_picks = sorted({str(r.get("pick")) for r in ans if r.get("text") and r.get("pick")})
            rerolled = len(then_picks) > 1
            then_kinds = sorted({r.get("fail_kind") or ("ok" if r.get("text") else "unknown") for r in ans})
            # WS-only snapshot with the same action count at hero's turn, if the raw frames covered this hand
            snap = next((s for s in snaps if s.get("exported") and s.get("nActions") == i), None)
            snap_any = snaps[n] if n < len(snaps) else None
            capture = "no-dump"
            if snaps:
                if snap:
                    same = [(x.get("seatId"), x.get("type")) for x in snap["actions"]] == [(x.get("seatId"), x.get("type")) for x in acts[:i]]
                    capture = "ws-identical" if same else "ws-divergent"
                elif snap_any and snap_any.get("exported"):
                    capture = f"ws-missing-actions({snap_any.get('nActions')}<{i})" if (snap_any.get("nActions") or 0) < i else f"ws-extra-actions({snap_any.get('nActions')}>{i})"
                elif snap_any:
                    capture = f"ws-not-exported({snap_any.get('why')})"
                else:
                    capture = "ws-no-turn-frame"
            faults = (bt or {}).get("capture", {}).get("faultsAtDecision", []) if bt else []
            # the press for THIS decision: the pick-executed event nearest in time to the decision's answer rows
            # (falling back to the n-th event of the hand when no answer row carries a timestamp)
            ans_ts = [r.get("ts") for r in ans if r.get("ts")]
            pick_ev = None
            if ans_ts and picks:
                t0 = min(ans_ts)
                cands = [e for e in picks if isinstance(e.get("at"), (int, float)) and -2000 <= e["at"] - t0 <= 60000]
                pick_ev = min(cands, key=lambda e: abs(e["at"] - t0)) if cands else None
            if pick_ev is None and n < len(picks) and not ans_ts:
                pick_ev = picks[n]
            out_ev = None
            if pick_ev:
                later = [e for e in outcomes if isinstance(e.get("at"), (int, float)) and 0 <= e["at"] - (pick_ev.get("at") or 0) <= 15000]
                out_ev = min(later, key=lambda e: e["at"] - pick_ev["at"]) if later else None
            followed = None
            for pk in then_picks or [then_pick]:
                m = hero_action_matches(pk, a)
                if m:
                    followed = True; break
                if m is False:
                    followed = False
            if pick_ev:
                exec_state = f"executed:{pick_ev.get('source')}"
            elif n < len(refused):
                exec_state = "refused"
            elif auto_on and then_ok:
                exec_state = "MANUAL-OR-MISSED (auto armed, answer on panel, no press recorded)"
            elif auto_on:
                exec_state = "auto armed, no answer"
            else:
                exec_state = "manual session"
            now = (bt or {}).get("now") if bt else None
            if bt is None:
                verdict = "NOT-REPLAYED"
            elif not now["ok"] and str(now.get("reason", "")).startswith("skipped"):
                verdict = "SKIPPED(cloud budget)"
            elif not now["ok"] and now.get("bucket", "").startswith("infra/"):
                verdict = "UNVERIFIED(infra)"
            elif then_ok is None:
                verdict = "NEVER-ASKED"
            elif then_ok and now["ok"]:
                verdict = "OK"
            elif then_ok and not now["ok"]:
                verdict = "CORRECT-REFUSAL" if (now.get("correctRefusal") or faults) else "BROKE"
            elif not then_ok and now["ok"]:
                verdict = "FIXED"
            else:
                verdict = f"STILL({now.get('bucket')})" if not (now.get("correctRefusal") or faults) else "CORRECT-REFUSAL"
            rows.append({
                "dbId": rowid, "idx": i, "clientHandId": chid, "session": sid, "test_stake": bool(sess and sess["test"]),
                "playedAt": played, "stakes": stakes, "street": a.get("street"), "heroPos": (d.get("positions") or {}).get(str(d.get("heroSeatId"))),
                "seats": len(d.get("positions") or {}), "heroCards": " ".join(d.get("heroCards") or []),
                "hero_action": f"{a.get('type')}{'' if a.get('amount') is None else ' ' + str(a.get('amount'))}",
                "line_before": line_of(acts[:i]),
                "capture_ws": capture, "capture_faults": "; ".join(faults), "lineSource": d.get("lineSource"), "lineUncertain": d.get("lineUncertain"),
                "then_probed": bool(ans), "then_rows": len(ans), "then_ok": then_ok, "then_kinds": ",".join(then_kinds), "then_pick": then_pick,
                "then_picks_all": " | ".join(then_picks), "rerolled": rerolled,
                "then_reason": next((r.get("fail_reason") for r in reversed(ans) if r.get("fail_reason")), None),
                "then_latency_ms": next((r.get("latency_ms") for r in ans if r.get("text")), None),
                "now_ok": now["ok"] if now else None, "now_decision": now.get("decision") if now and now["ok"] else None,
                "now_tier": now.get("tier") if now and now["ok"] else None, "now_reason": now.get("reason") if now and not now["ok"] else None,
                "now_bucket": now.get("bucket") if now and not now["ok"] else None, "now_ms": (bt or {}).get("ms"), "gtow_requests": (bt or {}).get("req"),
                "auto_armed": auto_on, "exec": exec_state, "exec_pick": (pick_ev or {}).get("pick"), "exec_plan": json.dumps((pick_ev or {}).get("plan")) if pick_ev else None,
                "exec_outcome": (out_ev or {}).get("outcome"), "exec_outcome_why": (out_ev or {}).get("why"),
                "followed_pick": followed, "held": "; ".join(h.get("why", "") for h in held) or None,
                "verdict": verdict,
            })

    # ---- write the table -------------------------------------------------------------------------------------
    csv_path = out_dir / "verdicts.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["dbId"])
        w.writeheader()
        for r in rows:
            w.writerow(r)

    # ---- summaries, by distinct hand and by street ----------------------------------------------------------
    def tally(key):
        by = defaultdict(lambda: Counter())
        hands = defaultdict(lambda: defaultdict(set))
        for r in rows:
            by[key(r)][r["verdict"]] += 1
            hands[key(r)][r["verdict"]].add(r["dbId"])
        return {k: {"decisions": dict(v), "hands": {vk: len(vs) for vk, vs in hands[k].items()}} for k, v in by.items()}

    summary = {
        "decisions": len(rows), "hands": len({r["dbId"] for r in rows}),
        "verdicts": dict(Counter(r["verdict"] for r in rows)),
        "verdicts_by_hand": {k: len(v) for k, v in defaultdict(set, {}).items()},
        "by_street": tally(lambda r: r["street"]),
        "still_by_bucket": dict(Counter(r["now_bucket"] for r in rows if r["verdict"].startswith("STILL"))),
        "still_hands_by_bucket": {b: sorted({r["dbId"] for r in rows if r["verdict"].startswith("STILL") and r["now_bucket"] == b})
                                  for b in {r["now_bucket"] for r in rows if r["verdict"].startswith("STILL")}},
        "capture_ws": dict(Counter(r["capture_ws"].split("(")[0] for r in rows)),
        "capture_faults_hands": len({r["dbId"] for r in rows if r["capture_faults"]}),
        "then": {"probed": sum(1 for r in rows if r["then_probed"]), "answered": sum(1 for r in rows if r["then_ok"]),
                 "never_probed": sum(1 for r in rows if not r["then_probed"])},
        "now": {"answered": sum(1 for r in rows if r["now_ok"]), "refused": sum(1 for r in rows if r["now_ok"] is False),
                "not_replayed": sum(1 for r in rows if r["now_ok"] is None)},
        "exec": dict(Counter(r["exec"].split(" (")[0] for r in rows)),
        "exec_outcomes": dict(Counter(r["exec_outcome"] for r in rows if r["exec_outcome"])),
        "followed_pick": dict(Counter(str(r["followed_pick"]) for r in rows if r["then_ok"])),
        "rerolled_live": {"decisions": sum(1 for r in rows if r["rerolled"]), "hands": len({r["dbId"] for r in rows if r["rerolled"]}),
                          "examples": [(r["dbId"], r["idx"], r["then_picks_all"]) for r in rows if r["rerolled"]][:12]},
        "not_followed": [(r["dbId"], r["idx"], r["street"], r["then_picks_all"], r["hero_action"], r["exec"].split(" (")[0], r["exec_outcome"]) for r in rows if r["followed_pick"] is False],
        "manual_or_missed_under_auto": [(r["dbId"], r["idx"], r["street"], r["then_pick"], r["hero_action"]) for r in rows if r["exec"].startswith("MANUAL")],
        "pick_disagreement_then_vs_now": sum(1 for r in rows if r["then_ok"] and r["now_ok"] and (r["then_pick"] or "").lower() != (r["now_decision"] or "").lower()),
        "gtow_requests_spent": sum(r["gtow_requests"] or 0 for r in rows),
    }
    vh = defaultdict(set)
    for r in rows:
        vh[r["verdict"]].add(r["dbId"])
    summary["verdicts_by_hand"] = {k: len(v) for k, v in vh.items()}
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1, default=str), encoding="utf-8")

    md = [f"# Hardening verdicts — {summary['decisions']} hero decisions in {summary['hands']} hands", "",
          "| verdict | decisions | distinct hands |", "|---|---|---|"]
    for k, v in sorted(summary["verdicts"].items(), key=lambda kv: -kv[1]):
        md.append(f"| {k} | {v} | {summary['verdicts_by_hand'].get(k, 0)} |")
    md += ["", "## By street (decisions → verdict)", ""]
    for st in ("preflop", "flop", "turn", "river"):
        t = summary["by_street"].get(st)
        if t:
            md.append(f"- **{st}**: " + ", ".join(f"{k} {v}" for k, v in sorted(t["decisions"].items(), key=lambda kv: -kv[1])))
    md += ["", "## Still failing, by root-cause class (distinct hands)", ""]
    for b, hs in sorted(summary["still_hands_by_bucket"].items(), key=lambda kv: -len(kv[1])):
        md.append(f"- {b}: {len(hs)} hands — dbIds {hs[:20]}{' …' if len(hs) > 20 else ''}")
    md += ["", "## Capture (WS-only snapshot vs archive at hero's turn)", "", *(f"- {k}: {v}" for k, v in sorted(summary["capture_ws"].items(), key=lambda kv: -kv[1])),
           "", "## Execution", "", *(f"- {k}: {v}" for k, v in summary["exec"].items()),
           f"- outcomes: {summary['exec_outcomes']}", f"- hero followed the pick (answered decisions): {summary['followed_pick']}",
           f"- manual-or-missed under auto: {len(summary['manual_or_missed_under_auto'])} → {summary['manual_or_missed_under_auto'][:15]}",
           f"- RE-ROLLED LIVE (more than one distinct pick shown for one decision): {summary['rerolled_live']['decisions']} decisions in {summary['rerolled_live']['hands']} hands — {summary['rerolled_live']['examples'][:6]}",
           f"- hero did NOT follow any shown pick: {len(summary['not_followed'])} → {summary['not_followed'][:12]}",
           f"- then-vs-now pick disagreement (both answered; rolls differ on mixed spots): {summary['pick_disagreement_then_vs_now']}",
           f"- GTO Wizard requests spent by the replay so far: {summary['gtow_requests_spent']}", ""]
    (out_dir / "summary.md").write_text("\n".join(md), encoding="utf-8")
    print("\n".join(md))
    print(f"\n-> {csv_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
