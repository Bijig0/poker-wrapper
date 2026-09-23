/**
 * The 6-max run's full chart list, as one page: every tree being solved, what it is, and where it is now. Port of
 * sixmaxInventory.py (2026-09-24).
 *
 *   bun src/scripts/sixmaxInventory.ts --out inventory.html
 *
 * The proposal page says how the work is going; this says WHAT the work is — all 132 solves as a grid of open size x
 * depth, plus the uneven-stack states seat by seat, each cell coloured by state (done, solving on a box now, waiting)
 * with the chart id and the box underneath.
 */
import { writeFileSync } from "node:fs";

const API = "http://localhost:2000";
const TIMEOUT_S = 240;
const PASSES: [string, string, string[]][] = [
  ["First pass", "the equilibrium at our rake — wizard auto-solve then a fixed-sample refinement (60 min at 100bb+)", ["grid-6max-nl200", "grid-6max-nl200-asym"]],
  ["Second pass", "every tree re-solved with FOUR times the samples; replaces the first pass under the same ids", ["grid-6max-nl200-r2", "grid-6max-nl200-asym-r2"]],
];
const DEPTHS = [30, 50, 75, 100, 125, 150];
const OPENS: [string, string][] = [["2", "2x open"], ["2_5", "2.5x open"], ["3", "3x open"], ["3_5", "3.5x open"], ["limp", "limp tree"]];
const SHORTS = [30, 50, 70];
const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const STATE_CLASS: Record<string, string> = { done: "done", solved: "pull", solving: "live", queued: "wait" };

/** html.escape (quote=True) */
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function api(path: string): Promise<any> {
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(TIMEOUT_S * 1000) });
  if (!r.ok) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
  return r.json();
}
async function states(cfgId: string, ids: string[]): Promise<Map<string, [string, string]>> {
  const q = encodeURIComponent(JSON.stringify({ kind: "charts", config: cfgId, ids }));
  const d = await api(`/api/ledger/work-data?d=${q}`);
  return new Map(d.sections[0].table.rows.map((r: any[]) => [r[0], [r[1], r[2]]]));
}
function cell(cid: string, st: Map<string, [string, string]>, title: string): string {
  const [raw, where] = st.get(cid) ?? ["queued", ""];
  const key = raw.split(" ")[0]!;
  const cls = STATE_CLASS[key] ?? "wait";
  const word = ({ done: "solved", solved: "pulling", solving: "solving now", queued: "waiting" } as Record<string, string>)[key] ?? key;
  const sub = ["done", "solved", "solving"].includes(key) ? where : "";
  return `<div class="c ${cls}" title="${esc(cid)} — ${esc(raw)} ${esc(where)}"><b>${esc(title)}</b><span>${esc(word)}</span><em>${esc(sub.slice(0, 26))}</em></div>`;
}

async function main(): Promise<number> {
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? process.argv[i + 1]! : "inventory.html";
  const site = "ign200";
  const blocks: string[] = [], totals: [string, number, number][] = [];
  for (const [passName, passNote, cfgs] of PASSES) {
    const evenIds = OPENS.flatMap(([o]) => DEPTHS.map((d) => `${site}_6max_D${d}_o${o}`));
    const unevIds = SHORTS.flatMap((s) => ["2_5", "3"].flatMap((o) => SEATS.map((seat) => `${site}_6max_D100_s${s}_${seat}_o${o}`)));
    let stEven: Map<string, [string, string]>, stUnev: Map<string, [string, string]>;
    try {
      stEven = await states(cfgs[0]!, evenIds);
      stUnev = await states(cfgs[1]!, unevIds);
    } catch (e: any) {
      console.error(`could not read ${passName}: ${e?.message ?? e}`);
      continue;
    }
    const allst = new Map([...stEven, ...stUnev]);
    const nDone = [...allst.values()].filter((v) => v[0].startsWith("done")).length;
    totals.push([passName, nDone, allst.size]);
    const rows = ['<table class="grid"><tr><th></th>' + DEPTHS.map((d) => `<th>${d}bb</th>`).join("") + "</tr>"];
    for (const [o, olabel] of OPENS) {
      rows.push(`<tr><th>${esc(olabel)}</th>` + DEPTHS.map((d) => `<td>${cell(`${site}_6max_D${d}_o${o}`, stEven, `${d}bb`)}</td>`).join("") + "</tr>");
    }
    rows.push("</table>");
    const un: string[] = [];
    for (const s of SHORTS) {
      for (const [o, olabel] of [["2_5", "2.5x"], ["3", "3x"]]) {
        un.push(`<div class="unev"><h4>a ${s}bb seat at a 100bb table · ${olabel} open</h4><div class="seats">`
                + SEATS.map((seat) => cell(`${site}_6max_D100_s${s}_${seat}_o${o}`, stUnev, seat)).join("") + "</div></div>");
      }
    }
    blocks.push(`<section><h2>${esc(passName)} <span class="n">${nDone} of ${allst.size} solved</span></h2>`
      + `<p class="note">${esc(passNote)}</p>`
      + `<h3>Even stacks — 5 trees x 6 depths = 30</h3>${rows.join("")}`
      + `<h3>One short seat — 3 short depths x 2 opens x 6 seats = 36</h3><div class="unevs">${un.join("")}</div>`
      + `</section>`);
  }
  const head = totals.map(([n, d, t]) => `${n}: ${d} of ${t}`).join(" · ");
  const doc = `<!doctype html><meta charset="utf-8"><title>6-max run — what we are solving</title><style>
:root{--bg:#0f1216;--card:#161b21;--line:#242c35;--ink:#e7ecf2;--mut:#8b97a5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;padding:26px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:20px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px 20px;margin-bottom:20px}
h2{font-size:16px;margin:0 0 2px}h2 .n{color:var(--mut);font-weight:400;font-size:13px}
h3{font-size:13px;margin:18px 0 8px;color:var(--mut);font-weight:600}
h4{font-size:12px;margin:0 0 6px;color:var(--mut);font-weight:600}
p.note{color:var(--mut);margin:0 0 6px;font-size:12.5px}
table.grid{border-collapse:separate;border-spacing:6px}
table.grid th{font-size:12px;color:var(--mut);font-weight:600;text-align:left}
.c{border-radius:6px;padding:6px 8px;min-width:104px;border:1px solid transparent;display:block}
.c b{display:block;font-size:12px}.c span{display:block;font-size:11px;opacity:.9}
.c em{display:block;font-size:10px;font-style:normal;opacity:.62;white-space:nowrap;overflow:hidden}
.done{background:#16301f;border-color:#245b36;color:#b9f0cd}
.live{background:#33240c;border-color:#7a5714;color:#ffd591}
.pull{background:#13283a;border-color:#255a80;color:#aad6f5}
.wait{background:#1b2128;border-color:#2a333d;color:#7d8895}
.unevs{display:flex;flex-wrap:wrap;gap:16px}
.seats{display:flex;gap:6px;flex-wrap:wrap}.seats .c{min-width:96px}
.legend{display:flex;gap:16px;color:var(--mut);font-size:12px;margin-top:6px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
</style>
<h1>Ignition 6-max NL200 — every chart in the run</h1>
<div class="sub">${esc(head)}. Each tree is the whole preflop game below its open size: cold-calls, 3-bets at four
sizes, squeezes, 4-bets, jams, and the limp tree's iso-raises. Hover a cell for the chart id and which box solved it.</div>
<div class="legend"><span><i style="background:#245b36"></i>solved</span><span><i style="background:#7a5714"></i>solving now</span>
<span><i style="background:#255a80"></i>pulling</span><span><i style="background:#2a333d"></i>waiting</span></div>
<div style="height:14px"></div>
${blocks.join("")}`;
  writeFileSync(out, doc, "utf8");
  console.log(`wrote ${out} (${Math.floor([...doc].length / 1024)} KB) — ${head}`);
  return 0;
}

process.exit(await main());
