#!/usr/bin/env python3
"""The 6-max run's full chart list, as one page: every tree we are solving, what it is, and where it is now.

The proposal page says how the work is going; this says WHAT the work is — all 132 solves laid out as a grid of
open size x depth, plus the uneven-stack states seat by seat, each cell coloured by state (done, solving on a box
now, waiting) with the chart id and the box underneath. Written for the question "what are we actually solving?".

  python sixmaxInventory.py --out inventory.html
"""
from __future__ import annotations

import argparse
import html
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API = "http://localhost:2000"
TIMEOUT = 240

PASSES = [
    ("First pass", "the equilibrium at our rake — wizard auto-solve then a fixed-sample refinement (60 min at 100bb+)",
     ["grid-6max-nl200", "grid-6max-nl200-asym"]),
    ("Second pass", "every tree re-solved with FOUR times the samples; replaces the first pass under the same ids",
     ["grid-6max-nl200-r2", "grid-6max-nl200-asym-r2"]),
]
DEPTHS = [30, 50, 75, 100, 125, 150]
OPENS = [("2", "2x open"), ("2_5", "2.5x open"), ("3", "3x open"), ("3_5", "3.5x open"), ("limp", "limp tree")]
SHORTS = [30, 50, 70]
SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]
STATE_CLASS = {"done": "done", "solved": "pull", "solving": "live", "queued": "wait"}


def api(path: str) -> dict:
    with urllib.request.urlopen(f"{API}{path}", timeout=TIMEOUT) as r:
        return json.loads(r.read())


def num(x) -> str:
    return str(x).replace(".", "_")


def states(cfg_id: str, ids: list[str]) -> dict[str, str]:
    q = urllib.parse.quote(json.dumps({"kind": "charts", "config": cfg_id, "ids": ids}))
    d = api(f"/api/ledger/work-data?d={q}")
    return {r[0]: (r[1], r[2]) for r in d["sections"][0]["table"]["rows"]}


def cell(cid: str, st: dict[str, tuple[str, str]], title: str) -> str:
    raw, where = st.get(cid, ("queued", ""))
    key = raw.split(" ")[0]
    cls = STATE_CLASS.get(key, "wait")
    word = {"done": "solved", "solved": "pulling", "solving": "solving now", "queued": "waiting"}.get(key, key)
    sub = where if key in ("done", "solved", "solving") else ""
    return (f'<div class="c {cls}" title="{html.escape(cid)} — {html.escape(raw)} {html.escape(where)}">'
            f'<b>{html.escape(title)}</b><span>{html.escape(word)}</span>'
            f'<em>{html.escape(sub[:26])}</em></div>')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="inventory.html")
    a = ap.parse_args()

    site = "ign200"
    blocks, totals = [], []
    for pass_name, pass_note, cfgs in PASSES:
        suffix = "-r2" if cfgs[0].endswith("-r2") else ""
        even_ids = [f"{site}_6max_D{d}_o{o}" for o, _ in OPENS for d in DEPTHS]
        unev_ids = [f"{site}_6max_D100_s{s}_{seat}_o{o}"
                    for s in SHORTS for o in ("2_5", "3") for seat in SEATS]
        try:
            st_even = states(cfgs[0], even_ids)
            st_unev = states(cfgs[1], unev_ids)
        except Exception as e:
            print(f"could not read {pass_name}: {e}", file=sys.stderr)
            continue
        allst = {**st_even, **st_unev}
        n_done = sum(1 for v in allst.values() if v[0].startswith("done"))
        totals.append((pass_name, n_done, len(allst)))

        rows = ['<table class="grid"><tr><th></th>' + "".join(f"<th>{d}bb</th>" for d in DEPTHS) + "</tr>"]
        for o, olabel in OPENS:
            rows.append(f"<tr><th>{html.escape(olabel)}</th>" + "".join(
                f"<td>{cell(f'{site}_6max_D{d}_o{o}', st_even, f'{d}bb')}</td>" for d in DEPTHS) + "</tr>")
        rows.append("</table>")

        un = []
        for s in SHORTS:
            for o, olabel in (("2_5", "2.5x"), ("3", "3x")):
                un.append(f'<div class="unev"><h4>a {s}bb seat at a 100bb table · {olabel} open</h4><div class="seats">'
                          + "".join(cell(f"{site}_6max_D100_s{s}_{seat}_o{o}", st_unev, seat) for seat in SEATS)
                          + "</div></div>")

        blocks.append(
            f'<section><h2>{html.escape(pass_name)} <span class="n">{n_done} of {len(allst)} solved</span></h2>'
            f'<p class="note">{html.escape(pass_note)}</p>'
            f'<h3>Even stacks — 5 trees x 6 depths = 30</h3>{"".join(rows)}'
            f'<h3>One short seat — 3 short depths x 2 opens x 6 seats = 36</h3><div class="unevs">{"".join(un)}</div>'
            f'</section>')

    head = " · ".join(f"{n}: {d} of {t}" for n, d, t in totals)
    doc = f"""<!doctype html><meta charset="utf-8"><title>6-max run — what we are solving</title><style>
:root{{--bg:#0f1216;--card:#161b21;--line:#242c35;--ink:#e7ecf2;--mut:#8b97a5}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;padding:26px}}
h1{{font-size:20px;margin:0 0 4px}}.sub{{color:var(--mut);margin-bottom:20px}}
section{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px 20px;margin-bottom:20px}}
h2{{font-size:16px;margin:0 0 2px}}h2 .n{{color:var(--mut);font-weight:400;font-size:13px}}
h3{{font-size:13px;margin:18px 0 8px;color:var(--mut);font-weight:600}}
h4{{font-size:12px;margin:0 0 6px;color:var(--mut);font-weight:600}}
p.note{{color:var(--mut);margin:0 0 6px;font-size:12.5px}}
table.grid{{border-collapse:separate;border-spacing:6px}}
table.grid th{{font-size:12px;color:var(--mut);font-weight:600;text-align:left}}
.c{{border-radius:6px;padding:6px 8px;min-width:104px;border:1px solid transparent;display:block}}
.c b{{display:block;font-size:12px}}.c span{{display:block;font-size:11px;opacity:.9}}
.c em{{display:block;font-size:10px;font-style:normal;opacity:.62;white-space:nowrap;overflow:hidden}}
.done{{background:#16301f;border-color:#245b36;color:#b9f0cd}}
.live{{background:#33240c;border-color:#7a5714;color:#ffd591}}
.pull{{background:#13283a;border-color:#255a80;color:#aad6f5}}
.wait{{background:#1b2128;border-color:#2a333d;color:#7d8895}}
.unevs{{display:flex;flex-wrap:wrap;gap:16px}}
.seats{{display:flex;gap:6px;flex-wrap:wrap}}.seats .c{{min-width:96px}}
.legend{{display:flex;gap:16px;color:var(--mut);font-size:12px;margin-top:6px}}
.legend i{{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}}
</style>
<h1>Ignition 6-max NL200 — every chart in the run</h1>
<div class="sub">{html.escape(head)}. Each tree is the whole preflop game below its open size: cold-calls, 3-bets at four
sizes, squeezes, 4-bets, jams, and the limp tree's iso-raises. Hover a cell for the chart id and which box solved it.</div>
<div class="legend"><span><i style="background:#245b36"></i>solved</span><span><i style="background:#7a5714"></i>solving now</span>
<span><i style="background:#255a80"></i>pulling</span><span><i style="background:#2a333d"></i>waiting</span></div>
<div style="height:14px"></div>
{"".join(blocks)}"""
    Path(a.out).write_text(doc, encoding="utf-8")
    print(f"wrote {a.out} ({len(doc)//1024} KB) — {head}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
