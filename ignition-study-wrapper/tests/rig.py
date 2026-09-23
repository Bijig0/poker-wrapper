"""Is the thing on the other end of WRAPPER_URL actually the Ignition test rig?

THE PORT IS SHARED (2026-09-20). The default rig URL is 127.0.0.1:7701, and the
CoinPoker assistive wrapper's panel defaults to 7701 as well. When that one is the
process running, every fixture in four of the five tiers comes back HTTP 404 and the
run reports sixty failures that say nothing whatever about the reader — the exact
"red suite that says nothing" run_all.py's own header warns against. It happened
silently for a whole day.

Two fields in /state settle it: only the Ignition wrapper publishes `fakeTable` at
all, and only a rig started with FAKE_TABLE=1 has a fake table to load. A tier that
cannot find its rig must exit 2 (UNAVAILABLE), never 1 (FAIL).
"""
from __future__ import annotations

import json
import urllib.request


def rig_check(base: str, timeout: float = 5) -> str | None:
    """None when `base` is the Ignition fake rig, else the sentence to print."""
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/state", timeout=timeout) as f:
            st = json.loads(f.read() or b"{}")
    except Exception as e:
        return f"wrapper not reachable on {base} - launch Ignition Study first ({e})"
    if not isinstance(st, dict) or "fakeTable" not in st:
        return (f"{base} is answering, but it is NOT the Ignition wrapper (no fakeTable in "
                f"/state) - the CoinPoker wrapper's panel defaults to this port too. Start "
                f"the Ignition test rig, or point WRAPPER_URL at it.")
    if not st.get("fakeTable") and not st.get("fakeRig"):
        return (f"{base} is the Ignition wrapper but NOT a test rig (FAKE_TABLE=1): it has "
                f"no fake table to load, so this tier would test nothing. 7700 is the live rig.")
    return None
