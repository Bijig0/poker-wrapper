/**
 * Render the postflop sweeps as the Solve Audit page — clickable. Port of makeSolveAuditReport.py (2026-09-24).
 *
 *   bun src/scripts/makeSolveAuditReport.ts          -> ignition-study-wrapper/debug/postflop_sweep_report.html
 *
 * Every row carries a COMPLETE FakeSpec rebuilt from the solved node: click it and the page loads that spot onto the
 * fake table (same-origin POST) and asks the tool shell to switch to the State Tester tab, which builds itself out
 * from the table's current spec and fetches the study answer. Each line is a spot you can stand in.
 *
 * Spec reconstruction: capacity 6 with hero ALWAYS seat 1 (bottom) — the dealer seat is chosen so seat 1 lands on
 * hero's position, and the four irrelevant seats fold. The preflop story is included (per solved line; part-1 rows
 * use the BTN-open/BB-call shape their stub ranges approximate) so /hand exports a walkable line. Facing rows put
 * villain's bet in front (OOP bets, hero responds in position); first-to-act rows give hero (OOP) the check/bet node.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pyJsonDumps, pyRound, pyStr } from "../../../wrapper/src/py";

const SRC = join(import.meta.dir, "postflop_sweep.jsonl");
const OUT = resolve(import.meta.dir, "../../../../../ignition-study-wrapper/debug/postflop_sweep_report.html");
const lines = (p: string) => readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
const rows: any[] = lines(SRC);
const REAL = join(import.meta.dir, "postflop_sweep_real.jsonl");
if (existsSync(REAL)) rows.push(...lines(REAL));

const GEO_NAME = new Map([["5|97.5", "SRP"], ["6.5|96", "SRP bvb"], ["13|89", "3-bet pot"], ["20|80", "3-bet+ pot"], ["44|60", "4-bet pot"], ["7|40", "short SRP"]]);
const POS_OFF: Record<string, number> = { BTN: 0, SB: 1, BB: 2, UTG: 3, HJ: 4, CO: 5 };
const LINE_POS: Record<string, [string, string]> = {   // oop, ip per solved line; part-1 rows have no line -> BB vs BTN
  "btn-open-bb-call": ["BB", "BTN"], "co-open-bb-call": ["BB", "CO"], "sb-open-bb-call": ["SB", "BB"],
  "bb-3bet-btn-call": ["BB", "BTN"], "btn-3bet-co-call": ["CO", "BTN"],
};
type Pre = [string, string, number | null];
const PRE_ACTS: Record<string, Pre[]> = {   // (pos, type, amount|None) after the blinds; calls are increments
  "btn-open-bb-call": [["UTG", "fold", null], ["HJ", "fold", null], ["CO", "fold", null], ["BTN", "raise", 2.5], ["SB", "fold", null], ["BB", "call", 1.5]],
  "co-open-bb-call": [["UTG", "fold", null], ["HJ", "fold", null], ["CO", "raise", 2.5], ["BTN", "fold", null], ["SB", "fold", null], ["BB", "call", 1.5]],
  "sb-open-bb-call": [["UTG", "fold", null], ["HJ", "fold", null], ["CO", "fold", null], ["BTN", "fold", null], ["SB", "raise", 3], ["BB", "call", 2]],
  "bb-3bet-btn-call": [["UTG", "fold", null], ["HJ", "fold", null], ["CO", "fold", null], ["BTN", "raise", 2.5], ["SB", "fold", null], ["BB", "raise", 11], ["BTN", "call", 8.5]],
  "btn-3bet-co-call": [["UTG", "fold", null], ["HJ", "fold", null], ["CO", "raise", 2.5], ["BTN", "raise", 7.5], ["SB", "fold", null], ["BB", "fold", null], ["CO", "call", 5]],
};
// Default hero hands VERIFIED against the crawled 500z charts (2026-08-15 probe), per line and per role — "surely
// T9s flats" was wrong: this chart family 3-bets T9s at 100% from the BB. Openers and 3-bettors keep T9s; each
// CALLER seat gets hands that call >=90% at that exact node.
const CALLER_POS: Record<string, string> = { "btn-open-bb-call": "BB", "co-open-bb-call": "BB", "sb-open-bb-call": "BB", "bb-3bet-btn-call": "BTN", "btn-3bet-co-call": "CO" };
const OPENER_PAIRS = [["Th", "9h"], ["Tc", "9c"], ["Td", "9d"], ["Ts", "9s"]];
const CALLER_PAIRS: Record<string, string[][]> = {
  "btn-open-bb-call": [["6c", "6d"], ["5c", "5d"], ["4c", "4d"], ["Ad", "2d"], ["Kc", "3c"]],
  "co-open-bb-call": [["Ad", "Td"], ["Ah", "9h"], ["9c", "9d"], ["Td", "8d"]],
  "sb-open-bb-call": [["Ah", "9h"], ["Ad", "8d"], ["Kd", "8d"], ["Qc", "8c"]],
  "bb-3bet-btn-call": [["Th", "9h"], ["Ad", "Jd"], ["Kc", "Qc"], ["Ah", "Th"]],
  "btn-3bet-co-call": [["Ac", "Qc"], ["Ad", "Jd"], ["Kh", "Qh"], ["7c", "7d"]],
};
const mod = (a: number, n: number) => ((a % n) + n) % n;

function buildSpec(r: any): Record<string, unknown> {
  const line: string = r.line || "btn-open-bb-call";
  const [oop, ip] = LINE_POS[line]!;
  const facing = r.facing;
  const street = String(r.street).toLowerCase();
  const pot = Number(r.pot), stack = Number(r.stack);
  const bet = facing ? pyRound((pot * facing) / 100, 2) : 0.0;
  const heroPos = facing ? ip : oop, villainPos = facing ? oop : ip;
  const dealer = mod(-POS_OFF[heroPos]!, 6) + 1;            // so seat 1 == heroPos
  const seatOf = new Map(Object.entries(POS_OFF).map(([p, off]) => [p, mod(dealer - 1 + off, 6) + 1]));
  const heroSeat = seatOf.get(heroPos)!, villainSeat = seatOf.get(villainPos)!;
  const b: string = r.board;
  const board: string[] = [];
  for (let i = 0; i < b.length; i += 2) board.push(b.slice(i, i + 2));
  const rolePairs = heroPos === CALLER_POS[line] ? CALLER_PAIRS[line]! : OPENER_PAIRS;
  // a ten-heavy board can consume every preferred pair: a broad reserve backstops the choice
  const reserve: string[][] = [];
  for (const [r1, r2] of [["9", "8"], ["8", "7"], ["7", "6"], ["6", "5"], ["A", "5"]]) {
    for (const [s1, s2] of [["h", "h"], ["c", "c"], ["d", "d"], ["s", "s"]]) reserve.push([r1! + s1, r2! + s2]);
  }
  const heroCards = [...rolePairs, ...reserve].find((p) => !board.includes(p[0]!) && !board.includes(p[1]!));
  if (!heroCards) throw new Error("StopIteration");

  const seats = new Map<string, Record<string, unknown>>();   // insertion order, as the Python dict kept it
  for (const seat of seatOf.values()) {
    if (seat === heroSeat) seats.set(String(seat), { stack: pyRound(stack, 2), cards: 2, timer: 24 });
    else if (seat === villainSeat) {
      const s: Record<string, unknown> = { stack: pyRound(stack - bet, 2), cards: 2 };
      if (bet) Object.assign(s, { bet, badge: "BET" });
      seats.set(String(seat), s);
    } else seats.set(String(seat), { stack: 100, cards: 0 });
  }
  const actions: Record<string, unknown>[] = [
    { seat: seatOf.get("SB"), type: "post-sb", amount: 0.5, street: "preflop" },
    { seat: seatOf.get("BB"), type: "post-bb", amount: 1, street: "preflop" },
    ...PRE_ACTS[line]!.map(([p, t, a]) => ({ seat: seatOf.get(p), type: t, street: "preflop", ...(a !== null ? { amount: a } : {}) })),
  ];
  if (bet) actions.push({ seat: villainSeat, type: "bet", amount: bet, street });
  const offer = facing
    ? { fold: true, call: bet, raise: Math.min(pyRound(3 * bet, 1), pyRound(stack, 1)), selectors: ["Pot", "ALL-IN"] }
    : { check: true, bet: pyRound(pot / 2, 1), selectors: ["1/2 Pot", "Pot", "ALL-IN"] };
  return {
    title: `Solve audit ${r.id} — ${line}`, capacity: 6, potBB: pyRound(pot + bet, 2), board, heroSeat, dealerSeat: dealer,
    heroCards, seats, offer,
    node: { dealt: [1, 2, 3, 4, 5, 6], toActSeat: heroSeat, committed: bet ? new Map([[String(villainSeat), bet]]) : new Map(), maxBet: bet, actions },
  };
}

const esc = (s: unknown) => pyStr(s);
const ok = rows.filter((r) => r.ok).length;
const streets = new Map<string, number>();
for (const r of rows) streets.set(r.street, (streets.get(r.street) ?? 0) + 1);
const facingN = rows.filter((r) => r.facing).length;
const ms = rows.map((r) => r.ms ?? 0).sort((a, b) => a - b);
const med = ms.length ? ms[ms.length >> 1] : 0;

const trs: string[] = [];
const specs = new Map<string, unknown>();
for (const r of rows) {
  const geo = r.line || GEO_NAME.get(`${r.pot}|${r.stack}`) || "?";
  const b: string = r.board;
  const cards: string[] = [];
  for (let i = 0; i < b.length; i += 2) cards.push(b.slice(i, i + 2));
  const face = r.facing ? `${esc(r.facing)}% pot` : "first to act";
  const status = r.ok ? "ok" : "FAIL";
  const detail = (r.problems || []).join("; ") || r.error || "";
  specs.set(r.id, buildSpec(r));
  trs.push(`<tr data-street='${esc(r.street)}' data-face='${r.facing ? "bet" : "check"}' data-id='${esc(r.id)}' class='${!r.ok ? "bad" : ""}'>`
    + `<td class='mono'>${esc(r.id)}</td><td>${esc(r.street)}</td><td class='mono'>${cards.join(" ")}</td><td>${esc(geo)}</td>`
    + `<td class='mono'>${esc(r.pot)} / ${esc(r.stack)}</td><td>${face}</td><td>${esc(r.nActions ?? "")}</td><td>${esc(r.ms ?? "")}ms</td>`
    + `<td>${status}${detail ? " — " + esc(detail) : ""}</td></tr>`);
}

const html = `<!doctype html><meta charset="utf-8">
<title>Solve audit — ${rows.length} spots</title>
<style>
 body{font:13px system-ui;margin:16px;background:#0d141c;color:#cfe0ef}
 h1{font-size:18px} .sum{display:flex;gap:18px;margin:10px 0 14px;flex-wrap:wrap}
 .sum b{font-size:20px;display:block} .sum div{background:#141e2a;border:1px solid #24344a;
 border-radius:8px;padding:8px 14px}
 button{background:#141e2a;color:#cfe0ef;border:1px solid #24344a;border-radius:6px;
 padding:4px 10px;margin-right:4px;cursor:pointer} button.on{background:#2b71c7;color:#fff}
 table{border-collapse:collapse;width:100%;margin-top:10px}
 td,th{padding:3px 8px;border-bottom:1px solid #1b2836;text-align:left;font-size:12px}
 .mono{font-family:Consolas,monospace} tr.bad{background:#3a1620}
 tr[data-id]{cursor:pointer} tr[data-id]:hover{background:#18293c}
 th{position:sticky;top:0;background:#0d141c}
 #toast{position:fixed;right:14px;bottom:14px;background:#2b71c7;color:#fff;
 padding:8px 14px;border-radius:8px;display:none}
</style>
<h1>Solve audit — the postflop pipeline, spot by spot</h1>
<div class="sum">
 <div><b>${ok}/${rows.length}</b>answered clean</div>
 <div><b>${streets.get("FLOP") ?? 0}</b>flops</div>
 <div><b>${streets.get("TURN") ?? 0}</b>turns</div>
 <div><b>${streets.get("RIVER") ?? 0}</b>rivers</div>
 <div><b>${facingN}</b>facing a bet</div>
 <div><b>${esc(med)}ms</b>median solve</div>
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
${trs.join("")}</table>
<div id="toast"></div>
<script id="specs" type="application/json">${pyJsonDumps(specs, { compact: true })}</script>
<script>
 const sel={street:"",face:""};
 document.querySelectorAll("button").forEach(b=>b.onclick=()=>{
   sel[b.dataset.k]=b.dataset.v;
   document.querySelectorAll("button."+b.className.split(" ")[0]).forEach(x=>x.classList.toggle("on",x===b));
   document.querySelectorAll("tr[data-street]").forEach(tr=>{
     tr.style.display=(!sel.street||tr.dataset.street===sel.street)&&(!sel.face||tr.dataset.face===sel.face)?"":"none";
   });
 });
 const SPECS=JSON.parse(document.getElementById("specs").textContent);
 const toast=(m)=>{const t=document.getElementById("toast");t.textContent=m;
   t.style.display="block";setTimeout(()=>t.style.display="none",2500);};
 document.querySelectorAll("tr[data-id]").forEach(tr=>tr.onclick=async()=>{
   const id=tr.dataset.id, spec=SPECS[id];
   if(!spec) return;
   try{
     const r=await fetch("/faketable/load",{method:"POST",
       headers:{"Content-Type":"application/json"},body:JSON.stringify(spec)});
     const j=await r.json();
     if(j.ok){toast(id+" loaded — opening State Tester");
       window.parent.postMessage({tab:"setup"},"*");}
     else toast("load failed: "+JSON.stringify(j).slice(0,80));
   }catch(e){toast("wrapper unreachable: "+e);}
 });
</script>`;
const out = process.argv[2] ? resolve(process.argv[2]) : OUT;
writeFileSync(out, html, "utf8");
console.log(`${out.split(/[\\/]/).pop()}: ${rows.length} rows (${ok} ok), ${specs.size} clickable specs, ${Math.floor(statSync(out).size / 1024)} KB`);
