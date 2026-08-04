import type { HandCell, RangeComparison } from "../compareActionRanges/compareActionRanges";

/** One action's node-level summary + GTO Wizard's own composition buckets. */
export interface ActionSummary {
  label: string; // full legend label, e.g. "Bet 75% (18.75)"
  rangePct: number | null; // share of the whole range taking this action
  combos: number | null;
  buckets: { section: string; name: string; pct: number }[]; // HANDS / DRAWS rows
}

export interface CompareReportInput {
  meta: {
    board: string | null; // "Ts5h3d"
    position: string | null; // "SB"
    potLabel: string | null; // "25"
    url: string;
    generatedAt: string;
  };
  a: ActionSummary;
  b: ActionSummary;
  cells: HandCell[];
  cmp: RangeComparison;
}

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];

// Dark-surface sequential ramps (near-surface → vivid), one hue per action.
const RED_RAMP = ["#33191a", "#4d2122", "#682a2a", "#8a3534", "#ad4241", "#d15654", "#f07b79"];
const BLUE_RAMP = ["#182636", "#1f334a", "#274263", "#2f547f", "#3969a0", "#4b84c8", "#79aef0"];
const SEQ_BINS = [5, 15, 30, 50, 70, 85]; // % thresholds → ramp step

// Diverging arms for the skew grid (leans A = red, leans B = blue), grey midpoint.
const DIV_RED = ["#5c2727", "#7d3231", "#a94241", "#e66767"];
const DIV_BLUE = ["#26405e", "#2f5480", "#3a6aa5", "#4b8ada"];
const DIV_BINS = [5, 20, 40, 70]; // |Δpp| thresholds: ≤5 neutral, then arm steps

const SERIES_A = "#e66767"; // validated pair on the dark surface
const SERIES_B = "#3987e5";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** "Bet 75% (18.75)" → "Bet 75%" (short display name). */
export const shortActionLabel = (label: string) => label.replace(/\s*\([^)]*\)\s*$/, "").trim();

const rampIndex = (f: number, bins: number[]) => {
  let i = 0;
  while (i < bins.length && f > bins[i]) i++;
  return i;
};

const SUITS: Record<string, { sym: string; color: string }> = {
  s: { sym: "♠", color: "#c3c2b7" },
  h: { sym: "♥", color: "#e66767" },
  d: { sym: "♦", color: "#3987e5" },
  c: { sym: "♣", color: "#0ca30c" },
};

const boardHtml = (board: string | null) => {
  if (!board) return "";
  const cards = board.match(/[2-9TJQKA][shdc]/gi) ?? [];
  return cards
    .map((c) => {
      const suit = SUITS[c[1].toLowerCase()];
      return `<span class="bcard" style="color:${suit.color}">${c[0].toUpperCase()}${suit.sym}</span>`;
    })
    .join("");
};

const handAt = (r: number, c: number) =>
  r === c ? RANKS[r] + RANKS[c] : c > r ? RANKS[r] + RANKS[c] + "s" : RANKS[c] + RANKS[r] + "o";

/** Build the self-contained dark-theme comparison report. */
export const buildRangeCompareHtml = (input: CompareReportInput): string => {
  const { meta, a, b, cells, cmp } = input;
  const byHand = new Map(cells.map((c) => [c.hand, c]));
  const shortA = shortActionLabel(a.label);
  const shortB = shortActionLabel(b.label);

  const cellTt = (hand: string, cell: HandCell | undefined) => {
    if (!cell || !cell.inRange) return `${hand} — not in range here`;
    const fa = cell.actions[a.label] ?? 0;
    const fb = cell.actions[b.label] ?? 0;
    const d = fa - fb;
    return `${hand} — ${esc(shortA)}: ${f1(fa)}% · ${esc(shortB)}: ${f1(fb)}% · Δ ${d > 0 ? "+" : ""}${f1(d)}pp`;
  };

  const grid = (mode: "a" | "b" | "diff") => {
    let html = `<div class="grid">`;
    for (let r = 0; r < 13; r++) {
      for (let c = 0; c < 13; c++) {
        const hand = handAt(r, c);
        const cell = byHand.get(hand);
        let bg = "transparent";
        let cls = "cell";
        let ink = "#6f6e69";
        if (!cell || !cell.inRange) {
          cls += " folded";
        } else {
          const fa = cell.actions[a.label] ?? 0;
          const fb = cell.actions[b.label] ?? 0;
          if (mode === "diff") {
            if (fa === 0 && fb === 0) {
              bg = "#232322";
            } else {
              const d = fa - fb;
              if (Math.abs(d) <= DIV_BINS[0]) {
                bg = "#3a3a37";
                ink = "#c3c2b7";
              } else {
                const arm = d > 0 ? DIV_RED : DIV_BLUE;
                const idx = Math.min(rampIndex(Math.abs(d), DIV_BINS) - 1, arm.length - 1);
                bg = arm[idx];
                ink = idx >= 3 ? "#141413" : "#e9e8e2";
              }
            }
          } else {
            const f = mode === "a" ? fa : fb;
            if (f === 0) {
              bg = "#232322";
            } else {
              const ramp = mode === "a" ? RED_RAMP : BLUE_RAMP;
              const idx = rampIndex(f, SEQ_BINS);
              bg = ramp[idx];
              ink = idx >= 5 ? "#141413" : "#e9e8e2";
            }
          }
        }
        html += `<div class="${cls}" style="background:${bg};color:${ink}" data-tt="${esc(cellTt(hand, cell))}">${hand}</div>`;
      }
    }
    return html + `</div>`;
  };

  const rampLegend = (ramp: string[]) =>
    `<div class="ramp"><span>0%</span>${ramp
      .map((c) => `<i style="background:${c}"></i>`)
      .join("")}<span>100%</span></div>`;

  const divLegend = () =>
    `<div class="ramp"><span>${esc(shortB)}</span>${[...DIV_BLUE]
      .reverse()
      .map((c) => `<i style="background:${c}"></i>`)
      .join("")}<i style="background:#3a3a37"></i>${DIV_RED.map(
      (c) => `<i style="background:${c}"></i>`
    ).join("")}<span>${esc(shortA)}</span></div>`;

  const skewList = (rows: typeof cmp.skewToA, toward: "a" | "b") => {
    const top = rows.filter((r) => (toward === "a" ? r.diff > 3 : r.diff < -3)).slice(0, 15);
    if (!top.length) return `<p class="muted">No hands lean this way.</p>`;
    return top
      .map(
        (r) => `<div class="skrow" data-tt="${esc(cellTt(r.hand, byHand.get(r.hand)))}">
        <b>${r.hand}</b>
        <div class="skbars">
          <div class="skbar"><i style="width:${Math.max(r.a, 0.5)}%;background:${SERIES_A}"></i><span>${f1(r.a)}</span></div>
          <div class="skbar"><i style="width:${Math.max(r.b, 0.5)}%;background:${SERIES_B}"></i><span>${f1(r.b)}</span></div>
        </div>
        <span class="delta">${r.diff > 0 ? "+" : ""}${f1(r.diff)}</span>
      </div>`
      )
      .join("");
  };

  const buckets = () => {
    const sections: string[] = [];
    for (const row of [...a.buckets, ...b.buckets]) {
      if (!sections.includes(row.section)) sections.push(row.section);
    }
    if (!sections.length) return "";
    const bySection = sections
      .map((section) => {
        const names: string[] = [];
        for (const row of [...a.buckets, ...b.buckets]) {
          if (row.section === section && !names.includes(row.name)) names.push(row.name);
        }
        const max = Math.max(
          1,
          ...[...a.buckets, ...b.buckets].filter((r) => r.section === section).map((r) => r.pct)
        );
        const rows = names
          .map((name) => {
            const pa = a.buckets.find((r) => r.section === section && r.name === name)?.pct ?? 0;
            const pb = b.buckets.find((r) => r.section === section && r.name === name)?.pct ?? 0;
            const d = pa - pb;
            const lean = Math.abs(d) < 0.05 ? "" : d > 0 ? SERIES_A : SERIES_B;
            return `<div class="brow">
              <span class="bname">${esc(name)}</span>
              <div class="bbars">
                <div class="bbar"><i style="width:${(pa / max) * 100}%;background:${SERIES_A}"></i><span>${f1(pa)}%</span></div>
                <div class="bbar"><i style="width:${(pb / max) * 100}%;background:${SERIES_B}"></i><span>${f1(pb)}%</span></div>
              </div>
              <span class="delta">${lean ? `<i class="dot" style="background:${lean}"></i>` : ""}${d > 0 ? "+" : ""}${f1(d)}pp</span>
            </div>`;
          })
          .join("");
        return `<h3>${esc(section)}</h3>${rows}`;
      })
      .join("");
    return `<section class="card">
      <h2>Range composition — what each size is made of</h2>
      <p class="muted">GTO Wizard's own buckets: % of each action's range in the category.</p>
      ${bySection}
    </section>`;
  };

  const tableRows = [...cmp.rows]
    .sort((x, y) => y.diff - x.diff)
    .map(
      (r) =>
        `<tr><td>${r.hand}</td><td>${f1(r.a)}</td><td>${f1(r.b)}</td><td>${r.diff > 0 ? "+" : ""}${f1(r.diff)}</td><td>${
          r.diff > 3 ? esc(shortA) : r.diff < -3 ? esc(shortB) : "mixed"
        }</td></tr>`
    )
    .join("");

  const statTile = (s: ActionSummary, color: string) => `
    <div class="tile">
      <i class="dot" style="background:${color}"></i>
      <div>
        <div class="tname">${esc(shortActionLabel(s.label))}</div>
        <div class="tsub">${s.rangePct != null ? `${f1(s.rangePct)}% of range` : ""}${
          s.combos != null ? ` · ${f1(s.combos)} combos` : ""
        }</div>
      </div>
    </div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(shortA)} vs ${esc(shortB)} — ${esc(meta.position ?? "")} ${esc(meta.board ?? "")}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background:#0d0d0d; color:#fff; font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
  .wrap { max-width:1180px; margin:0 auto; display:flex; flex-direction:column; gap:16px; }
  header .sub { color:#c3c2b7; margin-top:4px; }
  header .meta { color:#898781; font-size:12px; margin-top:6px; }
  header a { color:#898781; }
  .bcard { font-weight:600; margin-right:4px; }
  .tiles { display:flex; gap:12px; margin-top:12px; flex-wrap:wrap; }
  .tile { display:flex; gap:10px; align-items:center; background:#1a1a19; border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:10px 14px; }
  .tile .tname { font-weight:600; }
  .tile .tsub { color:#c3c2b7; font-size:12px; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:3px; flex:none; }
  .card { background:#1a1a19; border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:18px; }
  .card h2 { font-size:15px; margin-bottom:2px; }
  .card > .muted { margin-bottom:12px; }
  .muted { color:#898781; font-size:12px; }
  .duo { display:flex; gap:16px; flex-wrap:wrap; }
  .duo > div { flex:1 1 420px; min-width:0; }
  .gtitle { display:flex; align-items:center; gap:8px; font-weight:600; margin-bottom:8px; }
  .grid { display:grid; grid-template-columns:repeat(13,1fr); gap:2px; }
  .cell { aspect-ratio:1.25; border-radius:3px; font-size:9.5px; display:flex; align-items:center; justify-content:center; overflow:hidden; cursor:default; }
  .cell.folded { border:1px solid rgba(255,255,255,.06); color:#4a4947; }
  .ramp { display:flex; align-items:center; gap:2px; margin-top:8px; color:#898781; font-size:11px; }
  .ramp i { width:22px; height:8px; border-radius:2px; }
  .ramp span { margin:0 6px; }
  .skcols { display:flex; gap:16px; flex-wrap:wrap; margin-top:12px; }
  .skcols > div { flex:1 1 320px; }
  .skcols h3, .card h3 { font-size:12px; color:#c3c2b7; text-transform:uppercase; letter-spacing:.04em; margin:14px 0 8px; }
  .skrow { display:flex; align-items:center; gap:10px; padding:3px 0; border-bottom:1px solid #2c2c2a; }
  .skrow b { width:36px; font-size:12px; }
  .skbars { flex:1; display:flex; flex-direction:column; gap:2px; }
  .skbar { display:flex; align-items:center; gap:6px; }
  .skbar i { display:block; height:6px; border-radius:3px; min-width:2px; }
  .skbar span { color:#898781; font-size:10px; font-variant-numeric:tabular-nums; }
  .delta { width:52px; text-align:right; color:#c3c2b7; font-size:11px; font-variant-numeric:tabular-nums; display:inline-flex; justify-content:flex-end; align-items:center; gap:5px; }
  .brow { display:flex; align-items:center; gap:12px; padding:4px 0; }
  .bname { width:110px; text-align:right; color:#c3c2b7; font-size:12px; flex:none; }
  .bbars { flex:1; display:flex; flex-direction:column; gap:2px; }
  .bbar { display:flex; align-items:center; gap:6px; }
  .bbar i { display:block; height:9px; border-radius:4px; min-width:2px; }
  .bbar span { color:#898781; font-size:10.5px; font-variant-numeric:tabular-nums; }
  details { margin-top:4px; }
  summary { cursor:pointer; color:#c3c2b7; }
  table { border-collapse:collapse; margin-top:10px; width:100%; max-width:520px; font-variant-numeric:tabular-nums; }
  th { text-align:left; color:#898781; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  th, td { padding:3px 10px 3px 0; border-bottom:1px solid #2c2c2a; font-size:12.5px; }
  #tt { position:fixed; pointer-events:none; background:#262624; border:1px solid rgba(255,255,255,.14); color:#fff;
        padding:5px 9px; border-radius:6px; font-size:12px; display:none; z-index:9; box-shadow:0 4px 14px rgba(0,0,0,.5); }
</style></head><body><div class="wrap">
<header>
  <h1>${esc(shortA)} <span style="color:#898781">vs</span> ${esc(shortB)}</h1>
  <div class="sub">${esc(meta.position ?? "?")} strategy · ${boardHtml(meta.board)}${
    meta.potLabel ? ` · pot ${esc(meta.potLabel)}` : ""
  }</div>
  <div class="meta">${cmp.both} hands mix both sizes · ${cmp.onlyA} use only ${esc(shortA)} · ${cmp.onlyB} use only ${esc(
    shortB
  )} · generated ${esc(meta.generatedAt)} · <a href="${esc(meta.url)}">open node in GTO Wizard</a></div>
  <div class="tiles">${statTile(a, SERIES_A)}${statTile(b, SERIES_B)}</div>
</header>

<section class="card">
  <h2>Ranges side by side</h2>
  <p class="muted">Cell shade = how often that hand takes the action (hover any cell for exact numbers).</p>
  <div class="duo">
    <div><div class="gtitle"><i class="dot" style="background:${SERIES_A}"></i>${esc(shortA)}</div>${grid("a")}${rampLegend(RED_RAMP)}</div>
    <div><div class="gtitle"><i class="dot" style="background:${SERIES_B}"></i>${esc(shortB)}</div>${grid("b")}${rampLegend(BLUE_RAMP)}</div>
  </div>
</section>

<section class="card">
  <h2>Size skew — which hands prefer which size</h2>
  <p class="muted">Red leans ${esc(shortA)}, blue leans ${esc(shortB)}, grey is balanced; dark cells use neither size.</p>
  <div class="duo">
    <div>${grid("diff")}${divLegend()}</div>
    <div class="skcols">
      <div><h3>Biggest ${esc(shortA)} leans</h3>${skewList(cmp.skewToA, "a")}</div>
      <div><h3>Biggest ${esc(shortB)} leans</h3>${skewList(cmp.skewToB, "b")}</div>
    </div>
  </div>
</section>

${buckets()}

<section class="card">
  <details><summary>Full per-hand table (${cmp.rows.length} hands)</summary>
    <table><thead><tr><th>Hand</th><th>${esc(shortA)} %</th><th>${esc(shortB)} %</th><th>Δpp</th><th>Leans</th></tr></thead>
    <tbody>${tableRows}</tbody></table>
  </details>
</section>
</div>
<div id="tt"></div>
<script>
  const tt = document.getElementById("tt");
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tt]");
    if (!el) { tt.style.display = "none"; return; }
    tt.textContent = el.getAttribute("data-tt");
    tt.style.display = "block";
  });
  document.addEventListener("mousemove", (e) => {
    if (tt.style.display === "none") return;
    const x = Math.min(e.clientX + 14, innerWidth - tt.offsetWidth - 8);
    const y = Math.min(e.clientY + 16, innerHeight - tt.offsetHeight - 8);
    tt.style.left = x + "px"; tt.style.top = y + "px";
  });
</script>
</body></html>`;
};
