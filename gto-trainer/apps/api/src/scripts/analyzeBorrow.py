"""What the borrowed caller range costs. Reads borrow_calib.jsonl (see scripts/borrowCalibration.ts)."""
import json, sys, os, glob, statistics as st
from collections import defaultdict

HERE = os.path.dirname(__file__)
PATHS = sys.argv[1:] or sorted(glob.glob(os.path.join(HERE, "borrow_calib*.jsonl")))
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
rows = [r for r in seen.values() if r.get("truth", {}).get("ok") and r.get("borrowed", {}).get("ok")]
print(f"{len(seen)} rows, {len(rows)} with both solves")
if not rows:
    sys.exit(0)


def table(sel, label):
    loss = [r["borrowed"]["loss"] for r in sel]
    tv = [r["borrowed"]["tv"] for r in sel]
    ag = [r["borrowed"]["agree"] for r in sel]
    pct = [r["borrowed"]["lossPct"] for r in sel]
    wide = [r["donorMass"]["ratio"] for r in sel]
    print(f"  {label:34s} {len(sel):4d} {st.mean(loss):9.4f} {st.median(loss):8.4f} "
          f"{sorted(loss)[int(0.9*(len(loss)-1))]:8.4f} {st.mean(pct):6.2f}% {st.mean(tv):6.3f} "
          f"{100*st.mean(ag):6.0f}% {st.mean(wide):6.2f}x")


print(f"\n  {'slice':34s} {'n':>4s} {'mean bb':>9s} {'median':>8s} {'p90':>8s} {'% pot':>7s} {'TV':>6s} "
      f"{'top-act':>7s} {'range':>7s}")
table(rows, "ALL")
for nd in sorted({r["node"] for r in rows}):
    table([r for r in rows if r["node"] == nd], f"node {nd}: {next(r['note'] for r in rows if r['node']==nd)}")
for ln in sorted({r["line"] for r in rows}):
    table([r for r in rows if r["line"] == ln], f"line {ln}")
for d in sorted({r["donor"] for r in rows}):
    table([r for r in rows if r["donor"] == d], f"borrowing seat {d}")

print("\nDIRECTION — hero's aggregate bet/raise frequency")


def aggr(codes, freq):
    return sum(f for c, f in zip(codes, freq) if c[:1] in ("B", "R", "A"))


t = [aggr(r["truth"]["codes"], r["truth"]["freq"]) for r in rows]
b = [aggr(r["truth"]["codes"], r["borrowed"]["freq"]) for r in rows]
print(f"  truth {100*st.mean(t):.1f}%  borrowed {100*st.mean(b):.1f}%  delta {100*(st.mean(b)-st.mean(t)):+.1f}pp")
