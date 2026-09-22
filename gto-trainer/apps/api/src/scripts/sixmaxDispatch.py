#!/usr/bin/env python3
"""6-max run watchdog: keep every HRC box busy while the proposal has work left, and report anything odd.

The box keeper (services/boxKeeper.ts) revives a FAILED job and repairs a sick box. It does not notice a box
that is simply IDLE because its own shard finished while another config still has trees to solve — that gap
left all four Hetzner boxes idle for 5-12 hours on 2026-09-14. This closes it:

  for each box lane with no live job:
      pick the first config of the run that is not done and still has work this box can do
      (Linux boxes cannot finish a limp tree — the X11 wizard walk never completes one), and queue it there.

Prints one line per action or problem; silence means everything is busy and healthy. Safe to run every few
minutes: it never queues a config that already has a live job on that lane, and the runners themselves skip
trees that are already solved.

  python sixmaxDispatch.py [--api http://localhost:2000] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# the run's configs, in the order a free box should pick them up: finish the first pass before the second
ORDER = ["grid-6max-nl200", "grid-6max-nl200-asym", "grid-6max-nl200-r2", "grid-6max-nl200-asym-r2"]
WIN_ONLY = "olimp"          # limp trees: Windows boxes only
TIMEOUT = 90


def api(base: str, path: str, body: dict | None = None) -> dict:
    url = f"{base}{path}"
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def num(x) -> str:
    return str(x).replace(".", "_")


def expected_ids(cfg: dict) -> list[str]:
    """The chart ids a 6-max config is expected to produce — the same formula as services/ledger.ts."""
    env = cfg.get("env") or {}
    site = (env.get("SITES") or "ign200").split(",")[0].strip()
    ids: list[str] = []
    if env.get("GRID") != "off":
        depths = [d.strip() for d in env["DEPTHS"].split(",")] if env.get("DEPTHS") else [str(d) for d in (cfg.get("depths") or [100])]
        opens = [o.strip() for o in (env.get("OPENS") or "2.5,3,2,3.5,limp").split(",")]
        for o in opens:
            for d in depths:
                ids.append(f"{site}_6max_D{num(d)}_o{'limp' if o == 'limp' else num(o)}")
    a = env.get("ASYM")
    if a:
        kv = dict(p.split("=", 1) for p in a.split(";") if "=" in p)
        deep = kv.get("deep", "100").strip()
        shorts = [s.strip() for s in kv.get("shorts", "30,50").split(",")]
        opens = [o.strip() for o in kv.get("opens", "2.5,3").split(",")]
        seats = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] if kv.get("seats", "all").strip() == "all" else [s.strip().upper() for s in kv["seats"].split(",")]
        for sh in shorts:
            for o in opens:
                for seat in seats:
                    ids.append(f"{site}_6max_D{num(deep)}_s{num(sh)}_{seat}_o{'limp' if o == 'limp' else num(o)}")
    return ids


def chart_states(base: str, cfg_id: str, ids: list[str]) -> dict[str, str]:
    q = urllib.parse.quote(json.dumps({"kind": "charts", "config": cfg_id, "ids": ids}))
    d = api(base, f"/api/ledger/work-data?d={q}")
    return {r[0]: r[1] for r in d["sections"][0]["table"]["rows"]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:2000")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    base = a.api.rstrip("/")

    try:
        L = api(base, "/api/ledger")
        jobs = api(base, "/api/ledger/jobs?limit=250")["jobs"]
    except Exception as e:  # the API restarts on its own; a tick that cannot read it simply says so
        print(f"dispatch: API unreachable ({str(e)[:80]}) — nothing done this tick")
        return 0

    boxes = L.get("boxes") or {}
    if not boxes:
        try:
            boxes = json.load(open(__file__.rsplit("src", 1)[0] + "data/ledger.json", encoding="utf-8"))["boxes"]
        except Exception:
            print("dispatch: cannot read the box list")
            return 1
    lanes: list[tuple[str, str]] = [(f"hrc-box:{b['label']}", b["label"]) for b in boxes.get("hrc-box", []) if b.get("host") != "local"]
    lanes += [(f"hrc-linux:{b['label']}", b["label"]) for b in boxes.get("hrc-linux", [])]

    by_id = {c["id"]: c for c in L["configs"]}
    live_lanes = {j["lane"] for j in jobs if j["status"] == "running" or (j["status"] == "queued" and not j.get("waitInputs"))}
    live_cfg_lane = {(j["config"], j["lane"]) for j in jobs if j["status"] in ("running", "queued")}
    # a config whose fan-out is still running anywhere is OFF LIMITS - see the module docstring: queueing it again
    # re-splits the plan against the shards already in flight
    live_cfgs = {j["config"] for j in jobs if j["status"] == "running" or (j["status"] == "queued" and not j.get("waitInputs"))}

    # what is left per config, once per tick
    left: dict[str, dict[str, list[str]]] = {}
    for cid in ORDER:
        c = by_id.get(cid)
        if not c or c.get("effective") == "done":
            continue
        ids = expected_ids(c)
        if not ids:
            continue
        try:
            st = chart_states(base, cid, ids)
        except Exception as e:
            print(f"dispatch: could not read {cid} chart states ({str(e)[:60]})")
            continue
        todo = [i for i, s in st.items() if s != "done"]
        left[cid] = {"all": todo, "any_box": [i for i in todo if WIN_ONLY not in i]}

    if not left:
        return 0

    # Group the idle lanes by the config they should pick up and queue each config ONCE across all of them: a job
    # queued for a single box is a one-box fan-out (--shard 0/1 = the WHOLE remaining plan), so queueing box by box
    # had two boxes solve the same tree (hrc-l3 and hrc-l4 both on D150_o2, 2026-09-14). One request per config with
    # every idle box in it splits the work i/n the way the fan-out intends.
    want: dict[str, list[str]] = {}
    for lane, label in lanes:
        if lane in live_lanes:
            continue
        is_linux = lane.startswith("hrc-linux:")
        for cid in ORDER:
            if cid not in left or (cid, lane) in live_cfg_lane or cid in live_cfgs:
                continue
            if not (left[cid]["any_box"] if is_linux else left[cid]["all"]):
                continue
            want.setdefault(cid, []).append(label)
            break

    acted = 0
    for cid, labels in want.items():
        n_left = len(left[cid]["all"])
        if a.dry_run:
            print(f"dispatch: would queue {cid} across {', '.join(labels)} ({n_left} tree(s) left)")
            acted += 1
            continue
        try:
            r = api(base, "/api/ledger/jobs", {"config": cid, "boxes": labels})
        except Exception as e:
            print(f"dispatch: queueing {cid} across {', '.join(labels)} failed ({str(e)[:60]})")
            continue
        if r.get("ok"):
            print(f"dispatch: idle {', '.join(labels)} -> queued {cid} split {len(labels)} way(s) (job {r['job']['id']}, {n_left} tree(s) left)")
            acted += 1
        else:
            print(f"dispatch: {cid} refused for {', '.join(labels)}: {str(r.get('error'))[:80]}")

    # A config down to limp trees with every Windows box busy is a WAIT, not a problem: say it once and stay quiet
    # until the situation changes (a 10-minute repeat for the next 15 hours is noise, not information).
    state_path = Path(__file__).with_name(".dispatch_state.json")
    try:
        seen = json.loads(state_path.read_text())
    except Exception:
        seen = {}
    now_state = {}
    for cid, d in left.items():
        if d["all"] and not d["any_box"] and not any(l.startswith("hrc-box:") and l not in live_lanes for l, _ in lanes):
            key = f"limp:{cid}:{len(d['all'])}"
            now_state[key] = True
            if not seen.get(key):
                print(f"dispatch: {cid} is down to {len(d['all'])} limp tree(s) and every Windows box is busy — they run when one frees up (said once)")
    try:
        state_path.write_text(json.dumps(now_state))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
