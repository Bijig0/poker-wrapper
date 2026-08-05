"""Game-state test suite: drive the study tools from authored Ignition states.

Each fixture describes a spot (`spec`) and what the tools must do with it
(`expect`). For every fixture the runner:

  1. POSTs the spec to /faketable/load — the wrapper renders it as the real
     DOM contract and seeds the hand state from the node section;
  2. reads GET /hand and checks the exported ParsedHand field by field
     (street, board, hero, positions, the node, action count);
  3. asks the relay for each expected action and asserts, from the page's OWN
     click record, that the right control actually fired;
  4. asks for actions the state does not offer and asserts they are refused.

This is the panel's own machinery end to end — the same reader, the same
export, the same relay — differing from live play only in where the DOM
comes from. A failure here is a real defect in the study tools.

Run:  aof-model/.venv/Scripts/python.exe tests/run_state_suite.py [name ...]
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
BASE = "http://127.0.0.1:7700"


def _req(path: str, body: dict | None = None, timeout: float = 15):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path, data=data, method="POST" if data is not None else "GET",
        headers={"Content-Type": "application/json"} if data is not None else {})
    with urllib.request.urlopen(r, timeout=timeout) as f:
        return json.loads(f.read() or b"{}")


class Case:
    def __init__(self, name: str):
        self.name = name
        self.checks: list[tuple[str, bool, str]] = []

    def eq(self, label: str, got, want):
        ok = got == want
        self.checks.append((label, ok, "" if ok else f"got {got!r}, want {want!r}"))

    def truthy(self, label: str, ok: bool, detail: str = ""):
        self.checks.append((label, bool(ok), detail))

    @property
    def failed(self):
        return [c for c in self.checks if not c[1]]


def run_fixture(path: Path) -> Case:
    fx = json.loads(path.read_text(encoding="utf-8"))
    c = Case(fx.get("name") or path.stem)
    exp = fx.get("expect") or {}

    load = _req("/faketable/load", fx["spec"])
    c.truthy("state loaded", load.get("ok") is True, json.dumps(load))
    if not load.get("ok"):
        return c
    # The tab reloads to render the new spot; the feed reads at 4 Hz.
    time.sleep(1.5)

    # ---- the exported hand ----------------------------------------------
    hand = (_req("/hand") or {}).get("hand")
    if not hand:
        c.truthy("/hand exports the state", False, "no hand returned")
        return c
    c.truthy("/hand exports the state", True)
    h = exp.get("hand") or {}
    node = hand.get("currentNode") or {}
    for key, got in (
        ("street", hand.get("street")),
        ("board", hand.get("board")),
        ("heroSeatId", hand.get("heroSeatId")),
        ("heroCards", hand.get("heroCards")),
        ("ended", hand.get("ended")),
    ):
        if key in h:
            c.eq(f"hand.{key}", got, h[key])
    if "actionCount" in h:
        c.eq("hand.actions length", len(hand.get("actions") or []), h["actionCount"])
    if "positions" in h:
        c.eq("hand.positions",
             {str(k): v for k, v in (hand.get("positions") or {}).items()},
             {str(k): v for k, v in h["positions"].items()})
    for key in ("toActSeatId", "toActIsHero", "toCall"):
        if key in h:
            c.eq(f"currentNode.{key}", node.get(key), h[key])

    # ---- the relay -------------------------------------------------------
    for want in exp.get("relay") or []:
        res = _req("/act", {"label": want["label"], "kind": want.get("kind", "action")})
        if not res.get("ok"):
            c.truthy(f"relay {want['label']}", False,
                     f"refused: {res.get('reason')} (offer {res.get('offer')})")
            continue
        time.sleep(0.6)
        click = (_req("/faketable/lastclick") or {}).get("click") or {}
        c.eq(f"relay {want['label']} fires", click.get("qa"), want["fires"])

    # ---- actions the state does not offer --------------------------------
    for label in exp.get("refuse") or []:
        res = _req("/act", {"label": label, "kind": "action"})
        c.truthy(f"relay refuses {label}", res.get("ok") is False,
                 f"expected refusal, got {json.dumps(res)}")
    return c


def main() -> int:
    try:
        _req("/state", timeout=5)
    except (urllib.error.URLError, OSError) as e:
        print(f"wrapper not reachable on {BASE} — launch Ignition Study first ({e})")
        return 2

    wanted = set(sys.argv[1:])
    files = sorted(FIXTURES.glob("*.json"))
    if wanted:
        files = [f for f in files if f.stem in wanted or (json.loads(
            f.read_text(encoding="utf-8")).get("name") in wanted)]
    if not files:
        print(f"no fixtures in {FIXTURES}")
        return 2

    cases = []
    for f in files:
        print(f"\n=== {f.stem} ===")
        try:
            case = run_fixture(f)
        except Exception as e:  # a crashed case is a failed case, not a crashed run
            case = Case(f.stem)
            case.truthy("fixture ran", False, repr(e))
        cases.append(case)
        for label, ok, detail in case.checks:
            print(f"  {'PASS' if ok else 'FAIL'}  {label}"
                  + (f"   — {detail}" if detail else ""))

    try:
        _req("/faketable/stop")
    except Exception:
        pass

    bad = [c for c in cases if c.failed]
    total = sum(len(c.checks) for c in cases)
    print(f"\n{len(cases) - len(bad)}/{len(cases)} fixtures passed "
          f"({total - sum(len(c.failed) for c in cases)}/{total} assertions)")
    if bad:
        print("failing fixtures: " + ", ".join(c.name for c in bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
