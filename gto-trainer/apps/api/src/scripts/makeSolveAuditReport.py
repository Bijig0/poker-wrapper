"""Render the postflop sweeps as the Solve Audit page — clickable.

Every row carries a COMPLETE FakeSpec rebuilt from the solved node: click it
and the page loads that spot onto the fake table (same-origin POST) and asks
the tool shell to switch to the State Tester tab, which builds itself out from
the table's current spec and fetches the study answer. The audit is not just a
scoreboard — each line is a spot you can stand in.

Spec reconstruction notes:
- capacity 6 with hero ALWAYS seat 1 (bottom); the dealer seat is chosen so
  seat 1 lands on hero's position, and the four irrelevant seats fold.
- The preflop story is included (per solved line; part-1 rows use the
  BTN-open/BB-call shape their stub ranges approximate) so /hand exports a
  walkable line and the answer path can reconstruct real ranges.
- Facing rows put villain's bet in front (OOP bets, hero responds in
  position); first-to-act rows give hero (OOP) the check/bet node.
"""
import json
from collections import Counter
from pathlib import Path

SRC = Path(r"C:\Users\Brady\poker\gto-trainer\apps\api\src\scripts\postflop_sweep.jsonl")
OUT = Path(r"C:\Users\Brady\poker\ignition-study-wrapper\debug\postflop_sweep_report.html")

rows = [json.loads(l) for l in SRC.read_text(encoding="utf-8").splitlines() if l.strip()]
REAL = SRC.parent / "postflop_sweep_real.jsonl"
if REAL.exists():
    rows += [json.loads(l) for l in REAL.read_text(encoding="utf-8").splitlines() if l.strip()]

GEO_NAME = {(5, 97.5): "SRP", (6.5, 96): "SRP bvb", (13, 89): "3-bet pot",
            (20, 80): "3-bet+ pot", (44, 60): "4-bet pot", (7, 40): "short SRP"}

# ---- spec reconstruction ----------------------------------------------------
POS_OFF = {"BTN": 0, "SB": 1, "BB": 2, "UTG": 3, "HJ": 4, "CO": 5}
LINE_POS = {  # oop, ip per solved line; part-1 rows have no line -> BB vs BTN
    "btn-open-bb-call": ("BB", "BTN"), "co-open-bb-call": ("BB", "CO"),
    "sb-open-bb-call": ("SB", "BB"), "bb-3bet-btn-call": ("BB", "BTN"),
    "btn-3bet-co-call": ("CO", "BTN"),
}
PRE_ACTS = {  # (pos, type, amount|None) after the blinds; calls are increments
    "btn-open-bb-call": [("UTG", "fold", None), ("HJ", "fold", None), ("CO", "fold", None),
                         ("BTN", "raise", 2.5), ("SB", "fold", None), ("BB", "call", 1.5)],
    "co-open-bb-call": [("UTG", "fold", None), ("HJ", "fold", None), ("CO", "raise", 2.5),
                        ("BTN", "fold", None), ("SB", "fold", None), ("BB", "call", 1.5)],
    "sb-open-bb-call": [("UTG", "fold", None), ("HJ", "fold", None), ("CO", "fold", None),
                        ("BTN", "fold", None), ("SB", "raise", 3), ("BB", "call", 2)],
    "bb-3bet-btn-call": [("UTG", "fold", None), ("HJ", "fold", None), ("CO", "fold", None),
                         ("BTN", "raise", 2.5), ("SB", "fold", None), ("BB", "raise", 11),
                         ("BTN", "call", 8.5)],
    "btn-3bet-co-call": [("UTG", "fold", None), ("HJ", "fold", None), ("CO", "raise", 2.5),
                         ("BTN", "raise", 7.5), ("SB", "fold", None), ("BB", "fold", None),
                         ("CO", "call", 5)],
}
# Hands that LIVE in a caller's range: AKo defaults mostly 3-bet preflop, so
# giving hero AKo produced an in-spec state whose study answer was "not in
# range at this node" — technically honest, useless to stand in. Suited
# middling connectors flat near-always.
HERO_CARD_PAIRS = [["Th", "9h"], ["9c", "8c"], ["8d", "7d"], ["6s", "5s"],
                   ["Jd", "Td"], ["7s", "6s"]]


def build_spec(r: dict) -> dict:
    line = r.get("line") or "btn-open-bb-call"
    oop, ip = LINE_POS[line]
    facing = r.get("facing")
    street = r["street"].lower()
    pot, stack = float(r["pot"]), float(r["stack"])
    bet = round(pot * facing / 100, 2) if facing else 0.0

    hero_pos = ip if facing else oop
    villain_pos = oop if facing else ip
    dealer = ((-POS_OFF[hero_pos]) % 6) + 1          # so seat 1 == hero_pos
    seat_of = {p: ((dealer - 1 + off) % 6) + 1 for p, off in POS_OFF.items()}
    hero_seat, villain_seat = seat_of[hero_pos], seat_of[villain_pos]

    b = r["board"]
    board = [b[i:i + 2] for i in range(0, len(b), 2)]
    hero_cards = next(p for p in HERO_CARD_PAIRS
                      if p[0] not in board and p[1] not in board)

    seats: dict = {}
    for p, seat in seat_of.items():
        if seat == hero_seat:
            seats[str(seat)] = {"stack": round(stack, 2), "cards": 2, "timer": 24}
        elif seat == villain_seat:
            s = {"stack": round(stack - bet, 2), "cards": 2}
            if bet:
                s["bet"] = bet
                s["badge"] = "BET"
            seats[str(seat)] = s
        else:
            seats[str(seat)] = {"stack": 100, "cards": 0}

    actions = [
        {"seat": seat_of["SB"], "type": "post-sb", "amount": 0.5, "street": "preflop"},
        {"seat": seat_of["BB"], "type": "post-bb", "amount": 1, "street": "preflop"},
    ] + [
        {"seat": seat_of[p], "type": t, "street": "preflop",
         **({"amount": a} if a is not None else {})}
        for p, t, a in PRE_ACTS[line]
    ]
    if bet:
        actions.append({"seat": villain_seat, "type": "bet", "amount": bet, "street": street})

    offer = ({"fold": True, "call": bet,
              "raise": min(round(3 * bet, 1), round(stack, 1)),
              "selectors": ["Pot", "ALL-IN"]}
             if facing else
             {"check": True, "bet": round(pot / 2, 1),
              "selectors": ["1/2 Pot", "Pot", "ALL-IN"]})

    return {
        "title": f"Solve audit {r['id']} — {line}",
        "capacity": 6,
        "potBB": round(pot + bet, 2),
        "board": board,
        "heroSeat": hero_seat,
        "dealerSeat": dealer,
        "heroCards": hero_cards,
        "seats": seats,
        "offer": offer,
        "node": {
            "dealt": [1, 2, 3, 4, 5, 6],
            "toActSeat": hero_seat,
            "committed": {str(villain_seat): bet} if bet else {},
            "maxBet": bet,
            "actions": actions,
        },
    }


# ---- render -----------------------------------------------------------------
ok = sum(1 for r in rows if r.get("ok"))
streets = Counter(r["street"] for r in rows)
facing_n = sum(1 for r in rows if r.get("facing"))
ms = sorted(r.get("ms", 0) for r in rows)
med = ms[len(ms) // 2] if ms else 0

trs, specs = [], {}
for r in rows:
    geo = r.get("line") or GEO_NAME.get((r["pot"], r["stack"]), "?")
    b = r["board"]
    cards = " ".join(b[i:i + 2] for i in range(0, len(b), 2))
    face = f"{r['facing']}% pot" if r.get("facing") else "first to act"
    status = "ok" if r.get("ok") else "FAIL"
    detail = "; ".join(r.get("problems") or []) or r.get("error") or ""
    specs[r["id"]] = build_spec(r)
    trs.append(
        f"<tr data-street='{r['street']}' data-face='{'bet' if r.get('facing') else 'check'}'"
        f" data-id='{r['id']}' class='{'bad' if not r.get('ok') else ''}'>"
        f"<td class='mono'>{r['id']}</td><td>{r['street']}</td>"
        f"<td class='mono'>{cards}</td><td>{geo}</td>"
        f"<td class='mono'>{r['pot']} / {r['stack']}</td><td>{face}</td>"
        f"<td>{r.get('nActions', '')}</td><td>{r.get('ms', '')}ms</td>"
        f"<td>{status}{(' — ' + detail) if detail else ''}</td></tr>")

html = f"""<!doctype html><meta charset="utf-8">
<title>Solve audit — {len(rows)} spots</title>
<style>
 body{{font:13px system-ui;margin:16px;background:#0d141c;color:#cfe0ef}}
 h1{{font-size:18px}} .sum{{display:flex;gap:18px;margin:10px 0 14px;flex-wrap:wrap}}
 .sum b{{font-size:20px;display:block}} .sum div{{background:#141e2a;border:1px solid #24344a;
 border-radius:8px;padding:8px 14px}}
 button{{background:#141e2a;color:#cfe0ef;border:1px solid #24344a;border-radius:6px;
 padding:4px 10px;margin-right:4px;cursor:pointer}} button.on{{background:#2b71c7;color:#fff}}
 table{{border-collapse:collapse;width:100%;margin-top:10px}}
 td,th{{padding:3px 8px;border-bottom:1px solid #1b2836;text-align:left;font-size:12px}}
 .mono{{font-family:Consolas,monospace}} tr.bad{{background:#3a1620}}
 tr[data-id]{{cursor:pointer}} tr[data-id]:hover{{background:#18293c}}
 th{{position:sticky;top:0;background:#0d141c}}
 #toast{{position:fixed;right:14px;bottom:14px;background:#2b71c7;color:#fff;
 padding:8px 14px;border-radius:8px;display:none}}
</style>
<h1>Solve audit — the postflop pipeline, spot by spot</h1>
<div class="sum">
 <div><b>{ok}/{len(rows)}</b>answered clean</div>
 <div><b>{streets.get('FLOP',0)}</b>flops</div>
 <div><b>{streets.get('TURN',0)}</b>turns</div>
 <div><b>{streets.get('RIVER',0)}</b>rivers</div>
 <div><b>{facing_n}</b>facing a bet</div>
 <div><b>{med}ms</b>median solve</div>
</div>
<p><b>Click any row</b> to load that spot onto the fake table and open it in the
State Tester — which builds the state out and fetches its live study answer.</p>
<div>
 street: <button class="f on" data-k="street" data-v="">all</button>
 <button class="f" data-k="street" data-v="FLOP">flop</button>
 <button class="f" data-k="street" data-v="TURN">turn</button>
 <button class="f" data-k="street" data-v="RIVER">river</button>
 &nbsp; node: <button class="g on" data-k="face" data-v="">all</button>
 <button class="g" data-k="face" data-v="bet">facing bet</button>
 <button class="g" data-k="face" data-v="check">first to act</button>
</div>
<table><tr><th>id</th><th>street</th><th>board</th><th>ranges / pot type</th>
<th>pot/stack bb</th><th>node</th><th>#actions</th><th>time</th><th>result</th></tr>
{''.join(trs)}</table>
<div id="toast"></div>
<script id="specs" type="application/json">{json.dumps(specs, separators=(',', ':'))}</script>
<script>
 const sel={{street:"",face:""}};
 document.querySelectorAll("button").forEach(b=>b.onclick=()=>{{
   sel[b.dataset.k]=b.dataset.v;
   document.querySelectorAll("button."+b.className.split(" ")[0]).forEach(x=>x.classList.toggle("on",x===b));
   document.querySelectorAll("tr[data-street]").forEach(tr=>{{
     tr.style.display=(!sel.street||tr.dataset.street===sel.street)&&(!sel.face||tr.dataset.face===sel.face)?"":"none";
   }});
 }});
 const SPECS=JSON.parse(document.getElementById("specs").textContent);
 const toast=(m)=>{{const t=document.getElementById("toast");t.textContent=m;
   t.style.display="block";setTimeout(()=>t.style.display="none",2500);}};
 document.querySelectorAll("tr[data-id]").forEach(tr=>tr.onclick=async()=>{{
   const id=tr.dataset.id, spec=SPECS[id];
   if(!spec) return;
   try{{
     const r=await fetch("/faketable/load",{{method:"POST",
       headers:{{"Content-Type":"application/json"}},body:JSON.stringify(spec)}});
     const j=await r.json();
     if(j.ok){{toast(id+" loaded — opening State Tester");
       window.parent.postMessage({{tab:"setup"}},"*");}}
     else toast("load failed: "+JSON.stringify(j).slice(0,80));
   }}catch(e){{toast("wrapper unreachable: "+e);}}
 }});
</script>"""
OUT.write_text(html, encoding="utf-8")
print(f"{OUT.name}: {len(rows)} rows ({ok} ok), {len(specs)} clickable specs, "
      f"{OUT.stat().st_size // 1024} KB")
