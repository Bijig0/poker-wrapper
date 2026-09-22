"""
Read session_backtest.jsonl and say what the multiway work actually fixed.

Every row is one hero decision from the archived sessions, replayed through the current production path,
with what the table answered at the time alongside. Four outcomes:

  FIXED     failed live, answers now
  STILL     failed live, fails now
  OK        answered live, answers now
  BROKE     answered live, fails now        <- a regression, the row that matters most

Rows whose decision was never logged live ("NEW") are ones the poller never asked about — the no-probe class.
They cannot be scored as fixed or not, only counted.
"""
import json, sys, os, glob, statistics as st
from collections import defaultdict, Counter

HERE = os.path.dirname(__file__)
PATHS = sys.argv[1:] or sorted(glob.glob(os.path.join(HERE, "session_backtest*.jsonl")))
seen = {}
for p in PATHS:
    for l in open(p, encoding="utf-8"):
        l = l.strip()
        if not l:
            continue
        try:
            r = json.loads(l)
        except Exception:
            continue
        seen[r["key"]] = r
rows = list(seen.values())
print(f"{len(rows)} hero decisions replayed")
if not rows:
    sys.exit(0)


# Not every live failure is a SOLVER failure, and the replay must not take credit for the others.
# "never asked"  - the poller skipped the decision, or hero was judged not to act. The replay answers it
#                  because it asks, which proves nothing about the solver.
# "infrastructure" - GTO Wizard or the chart server was down at the table. It answers now because the
#                  service is up, not because anything was fixed.
NEVER_ASKED = {"no-probe", "not-to-act-live", "abandoned-stale", "not-heros-turn"}
INFRA = {"gtow-down", "solver-unreachable", "solver-timeout"}


def outcome(r):
    live = r.get("live")
    now = r["now"]["ok"]
    # A replay that died on GTO Wizard's request limit says nothing about the code. The collapse makes 2-3
    # cloud walks per decision, so a bulk replay burns quota far faster than live play ever does.
    if not now and ("429" in str(r["now"].get("reason")) or "timed out" in str(r["now"].get("reason")).lower()):
        return "UNVERIFIED"
    if live is None:
        return "NEW"
    kind = live.get("kind")
    if live["ok"]:
        return "OK" if now else "BROKE"
    if kind in NEVER_ASKED:
        return "NEVER-ASKED"
    if kind in INFRA:
        return "WAS-INFRA" if now else "STILL"
    return "FIXED" if now else "STILL"


buck = defaultdict(list)
for r in rows:
    buck[outcome(r)].append(r)

print("\noutcome           n     share")
for k in ["OK", "FIXED", "WAS-INFRA", "NEVER-ASKED", "STILL", "BROKE", "NEW", "UNVERIFIED"]:
    v = buck[k]
    print(f"  {k:8s} {len(v):6d}   {100*len(v)/len(rows):5.1f}%")

scored = len(buck["OK"]) + len(buck["FIXED"]) + len(buck["STILL"]) + len(buck["BROKE"])
failed_live = len(buck["FIXED"]) + len(buck["STILL"])
if failed_live:
    print(f"\nof the {failed_live} decisions that failed at the table, {len(buck['FIXED'])} "
          f"({100*len(buck['FIXED'])/failed_live:.0f}%) answer now")
if scored:
    then = len(buck["OK"]) + len(buck["BROKE"])
    now = len(buck["OK"]) + len(buck["FIXED"])
    print(f"answer rate over the {scored} scored decisions: {100*then/scored:.1f}% then -> {100*now/scored:.1f}% now")

print("\nFIXED — what was failing, by live failure kind")
for k, n in Counter(r["live"]["kind"] for r in buck["FIXED"]).most_common():
    print(f"  {n:5d}  {k}")

print("\nSTILL FAILING — by bucket, then by reason")
for k, n in Counter(r["now"]["bucket"] for r in buck["STILL"]).most_common():
    print(f"  {n:5d}  {k}")
print()
for k, n in Counter(str(r["now"]["reason"])[:100] for r in buck["STILL"]).most_common(15):
    print(f"  {n:5d}  {k}")

if buck["BROKE"]:
    print("\nREGRESSIONS — answered live, fail now")
    for r in buck["BROKE"][:15]:
        print(f"  #{r['dbId']}@{r['upto']} {r['street']:7s} {r['heroPos']}  {str(r['now']['reason'])[:100]}")

print("\nby street")
print(f"  {'street':8s} {'n':>5s} {'answered now':>13s} {'answered live':>14s}")
for s in ["preflop", "flop", "turn", "river"]:
    sel = [r for r in rows if r["street"] == s]
    if not sel:
        continue
    live = [r for r in sel if r.get("live")]
    print(f"  {s:8s} {len(sel):5d} {100*sum(1 for r in sel if r['now']['ok'])/len(sel):12.1f}% "
          f"{(100*sum(1 for r in live if r['live']['ok'])/len(live) if live else float('nan')):13.1f}%")

print("\nby table size (seats dealt)")
for n_seats in sorted({r.get("seats") or 0 for r in rows}):
    sel = [r for r in rows if (r.get("seats") or 0) == n_seats]
    print(f"  {n_seats} seats: {len(sel):4d} decisions, {100*sum(1 for r in sel if r['now']['ok'])/len(sel):5.1f}% answered now")

mw = [r for r in rows if r["now"]["ok"] and "APPROXIMATION" in str(r["now"].get("warning") or "")]
cc = [r for r in rows if r["now"]["ok"] and "CALLER CAP" in str(r["now"].get("warning") or "")]
print(f"\nanswers using the new machinery: {len(mw)} multiway collapse, {len(cc)} caller-cap borrow")

lat = [r["ms"] for r in rows if r["now"]["ok"]]
if lat:
    print(f"latency of an answer: median {st.median(lat)/1000:.1f}s, p90 {sorted(lat)[int(0.9*(len(lat)-1))]/1000:.1f}s")
