/**
 * THE 13x13 GRID, SHARED (2026-09-30). Every range and strategy grid the dashboard draws — the exact-node view, the
 * AI-chain walkthrough, the range looker, the MES node — goes through classGrid, and since 2026-09-30 so does the
 * wrapper's side panel ("Ranges at this node" on an on-demand CoinPoker session), which loads THIS file from the study
 * API so the two can never drift. Moved out of dashboard.html verbatim (the GTO Wizard palette and cell paint, the
 * class grid with its hover mix and per-combo panel, the hover popover); a classic script, so its top-level names are
 * the page's — dashboard.html's inline script uses them by name, as it always did.
 *
 * What a host page provides: `esc` and `$` (both pages define them). `cardHtml` is provided below when the page
 * has none (the panel). Option added for the panel: classGrid(..., { combosOff: true }) draws no click-for-combos.
 */
if (typeof window.cardHtml !== "function") {
  window.cardHtml = (c) => {
    if (!c || c.length < 2) return String(c ?? "");
    const S = { s: ["♠", "inherit"], h: ["♥", "#ff6b6b"], d: ["♦", "#ff6b6b"], c: ["♣", "inherit"] };
    const [sym, col] = S[c[1]] ?? ["?", "inherit"];
    return `<span class="cardsuit" style="color:${col}">${String(c[0]).replace(/[&<>"']/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[x]))}${sym}</span>`;
  };
}

/* ================= GTO Wizard's range colouring (Brady, 2026-09-19) =================
   Copied from the client itself (its CSS variables and the computed styles of its
   strategy grid, read over the debug port): each cell is a dark base, and every
   action is a solid layer laid left-to-right in GTO Wizard's order — all-in and
   raises from the biggest size (darkest red) to the smallest (lightest), then
   check/call (green), then fold (blue). Layer widths are CUMULATIVE from the left;
   the first layer sits on top, so what shows of each is exactly its share. The
   layers' HEIGHT is the class's weight in range, anchored at the bottom: a hand
   half in range is half filled. A plain range (no actions) is the same fill in
   GTO Wizard's range orange. Out-of-range cells stay dark with a dim label. */
const GWPAL = { base: "rgb(30,30,30)", call: "#5AB966", fold: "#3D7CB8", range: "#FF8F00", allin: "#7D1F1F",
               raise: ["#F03C3C", "#DD3737", "#CA3232", "#B62E2E", "#A32929", "#912424"] };
const actKind = (label) => {
  const l = String(label ?? "").toLowerCase();
  if (/^(fold)/.test(l)) return "fold";
  if (/^(check|call|limp|in range)/.test(l)) return "call";
  if (/all-?in|jam|\brai\b/.test(l)) return "allin";
  return "raise";
};
const actSize = (label) => { const m = String(label ?? "").match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
/** colour per action label, given ALL the node's labels (raise shades rank by size) */
function gtowColors(labels) {
  const raises = labels.map((l, i) => ({ l, i, k: actKind(l), sz: actSize(l) })).filter((x) => x.k === "raise").sort((a, b) => a.sz - b.sz);
  const out = labels.map((l) => { const k = actKind(l); return k === "fold" ? GWPAL.fold : k === "call" ? GWPAL.call : k === "allin" ? GWPAL.allin : GWPAL.raise[0]; });
  const n = raises.length;
  raises.forEach((r, rank) => {
    const t = n <= 1 ? 0 : rank / (n - 1);              // 0 = smallest size (lightest) … 1 = biggest (darkest)
    out[r.i] = GWPAL.raise[Math.round(t * (GWPAL.raise.length - 1))];
  });
  return out;
}
/** GTO Wizard's left-to-right order: all-in, raises biggest→smallest, call/check, fold */
function gtowOrder(labels) {
  const rank = (l) => { const k = actKind(l); return k === "allin" ? 0 : k === "raise" ? 1 : k === "call" ? 2 : 3; };
  return labels.map((l, i) => i).sort((a, b) => rank(labels[a]) - rank(labels[b]) || (actKind(labels[a]) === "raise" ? actSize(labels[b]) - actSize(labels[a]) : 0));
}
/** inline style for one cell: `segs` = [{color, frac}] left→right (fracs of the in-range share), `weight` 0..1 */
function gtowCellStyle(segs, weight) {
  const h = Math.max(0, Math.min(1, weight)) * 100;
  const live = segs.filter((x) => x.frac > 0.004);
  if (!live.length || h <= 0.2) return `background:${GWPAL.base}`;
  let acc = 0;
  const layers = [], sizes = [];
  for (const x of live) { acc = Math.min(1, acc + x.frac); layers.push(`linear-gradient(to right,${x.color},${x.color})`); sizes.push(`${(acc * 100).toFixed(2)}% ${h.toFixed(1)}%`); }
  sizes[sizes.length - 1] = `100% ${h.toFixed(1)}%`;
  return `background-color:${GWPAL.base};background-image:${layers.join(",")};background-size:${sizes.join(",")};background-position:${live.map(() => "0 100%").join(",")};background-repeat:no-repeat`;
}
const gtowColor = (label, labels) => gtowColors(labels ?? [label])[(labels ?? [label]).indexOf(label)] ?? GWPAL.raise[0];

// action colours = GTO Wizard's (see GWPAL above); the raise shades rank by size within the node's labels
const ACT_COLORS = [GWPAL.fold, GWPAL.call, ...GWPAL.raise];
const colorFor = (label, i, labels) => labels ? gtowColor(label, labels) : (actKind(label) === "fold" ? GWPAL.fold : actKind(label) === "call" ? GWPAL.call : actKind(label) === "allin" ? GWPAL.allin : GWPAL.raise[Math.min(Math.max(i - 2, 0), GWPAL.raise.length - 1)]);
const RANKS = "AKQJT98765432";

const COMBOS = (k) => k.length === 2 ? 6 : k.endsWith("s") ? 4 : 12;
const classKey = (r, c) => r === c ? RANKS[r] + RANKS[c] : r < c ? RANKS[r] + RANKS[c] + "s" : RANKS[c] + RANKS[r] + "o";
/** 13×13 grid from {class: {w, acts[]}}, drawn the way GTO Wizard draws its strategy grid (gtowCellStyle). */
/* PER-COMBO PANEL (Brady, 2026-09-19): a class cell opens its combos — every legal combo of KJo with
   its own weight in range and, on a strategy grid, its own action split and EV. Blockers decide many
   postflop spots, and a class average hides exactly that. The data rides on the node payload
   (actorCombos / rangesInCombos); the grid registers it here and its cells call showCombos(). */
const COMBO_DATA = {};
let comboSeq = 0;
const COMBO_DATA_MAX = 60;                       // every grid registers one now; keep the newest
const SUIT_ORDER = ["s", "h", "d", "c"];
/**
 * The legal combos of a class, minus anything the board blocks.
 *
 * PREFLOP HAS NO PER-COMBO SOLUTION AND CANNOT HAVE ONE: with no board, the four combos
 * of KJs are the same hand under suit isomorphism, which is exactly why HRC and the GTOW
 * crawl store 169 classes and not 1,326 combos. So on a preflop chart this enumerates the
 * combos and splits the class weight evenly across them — the panel says so in as many
 * words. Where a real per-combo solve exists (a postflop node: the AI chain, the MES
 * locked solves) the node's own rows are used instead and blockers show up properly.
 */
function comboRows(cls, weights, acts, board) {
  const dead = new Set((board || "").match(/[2-9TJQKA][shdc]/gi)?.map((c) => c[0].toUpperCase() + c[1].toLowerCase()) ?? []);
  const [a, b] = [cls[0], cls[1]];
  const out = [];
  if (cls.length === 2) {
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) out.push(a + SUIT_ORDER[i] + b + SUIT_ORDER[j]);
  } else if (cls.endsWith("s")) {
    for (const su of SUIT_ORDER) out.push(a + su + b + su);
  } else {
    for (const s1 of SUIT_ORDER) for (const s2 of SUIT_ORDER) if (s1 !== s2) out.push(a + s1 + b + s2);
  }
  const legal = out.filter((h) => !dead.has(h.slice(0, 2)) && !dead.has(h.slice(2)));
  if (!legal.length) return [];
  const per = weights / legal.length;                       // the class weight, spread evenly
  const s = acts ? acts.map((x) => x / (weights || 1)) : null;
  return legal.map((hand) => ({ hand, w: per, ...(s ? { s } : {}) }));
}
function classGrid(cls, actions, heroKey, opt = {}) {
  // EVERY grid opens its combos now (2026-09-20, Brady: "be thorough, apply this to all the
  // charts and be uniform"). Grids that carry a real per-combo solve pass `combos`; the rest
  // get them derived from the class — see comboRows for why that is all there is preflop.
  const cid = `cg${++comboSeq}`;
  COMBO_DATA[cid] = { combos: opt.combos ?? null, cls, actions, single: !!opt.single, heroKey,
                      heroCombo: opt.heroCombo ?? null, board: opt.board ?? null };
  for (const k of Object.keys(COMBO_DATA)) {
    if (Object.keys(COMBO_DATA).length <= COMBO_DATA_MAX) break;
    delete COMBO_DATA[k];
  }
  const totals = actions.map((_, ai) => { let n = 0, d = 0; for (const k in cls) { n += cls[k].acts[ai]; d += cls[k].w; } return d ? (100 * n) / d : 0; });
  const colors = opt.single ? [GWPAL.range] : gtowColors(actions);
  const order = opt.single ? [0] : gtowOrder(actions);
  let html = opt.single ? "" : `<div class="legend">` + order.map((ai) => `<span><span class="sw" style="background:${colors[ai]}"></span>${esc(actions[ai])} <b>${totals[ai].toFixed(1)}%</b></span>`).join("") + `</div>`;
  html += `<div class="grid169${opt.small ? " sm" : ""}">`;
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    const key = classKey(r, c), e = cls[key];
    const inRange = !!(e && e.w > 0.0005);
    let style = `background:${GWPAL.base}`;
    if (inRange) {
      const weight = Math.min(1, e.w / COMBOS(key));          // share of the class still in range = fill height
      const segs = opt.single
        ? [{ color: GWPAL.range, frac: 1 }]
        : order.map((ai) => ({ color: colors[ai], frac: e.acts[ai] / e.w }));
      style = gtowCellStyle(segs, weight);
    }
    const tip = opt.tip ? opt.tip(key, inRange, e) : key + ": " + (inRange
      ? (opt.single ? `${(100 * Math.min(1, e.w / COMBOS(key))).toFixed(0)}% of the class in range`
                    : `${(100 * Math.min(1, e.w / COMBOS(key))).toFixed(0)}% in range · ` + order.map((ai) => `${actions[ai]} ${((100 * e.acts[ai]) / (e.w || 1)).toFixed(0)}%`).join(" · "))
      : "not in range");
    const clk = inRange && !opt.combosOff ? ` onclick="showCombos('${cid}','${key}')"` : "";
    const suit = key.length > 2 ? `<i class="sfx ${key[2]}">${key[2]}</i>` : "";
    html += `<div class="${key === heroKey ? "hero" : ""}${inRange ? "" : " off"}${clk ? " clk" : ""}" style="${style}" title="${esc(tip)}${clk ? " · click for the combos" : ""}"${clk}>${key.slice(0, 2)}${suit}</div>`;
  }
  html += `</div><div class="sub" style="margin-top:6px">${opt.foot ?? "hero's class outlined · hover any cell for its mix"}${opt.combosOff ? "" : " · click a class for its combos"}</div>`;
  // Hero's class opens by itself (2026-09-24, Brady): the outline says which class you hold,
  // the panel says which of its combos is yours. A click on the cell still folds it.
  const open = heroKey && opt.openHero !== false && !opt.combosOff && cls[heroKey]?.w > 0.0005 ? heroKey : null;
  if (!opt.combosOff) html += `<div class="combo-panel" id="cp-${cid}"${open ? ` data-cls="${open}"` : ""}>${open ? comboPanelHtml(COMBO_DATA[cid], open) : ""}</div>`;
  return html;
}
const sameCombo = (a, b) => { if (!a || !b) return false; const A = a.match(/.{2}/g) || [], B = b.match(/.{2}/g) || []; return A.length === 2 && B.length === 2 && ((A[0] === B[0] && A[1] === B[1]) || (A[0] === B[1] && A[1] === B[0])); };
function showCombos(cid, cls) {
  const d = COMBO_DATA[cid], host = $(`cp-${cid}`);
  if (!d || !host) return;
  if (host.dataset.cls === cls) { host.innerHTML = ""; host.dataset.cls = ""; return; }   // click again to fold
  host.dataset.cls = cls;
  host.innerHTML = comboPanelHtml(d, cls);
  host.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function comboPanelHtml(d, cls) {
  // A real per-combo solve when the node carried one; otherwise the class spread over its
  // legal combos, which is the whole truth preflop. `derived` decides what the head says.
  const e = d.cls?.[cls];
  const derived = !d.combos;
  const rows = derived ? (e ? comboRows(cls, e.w, d.single ? null : e.acts, d.board) : []) : (d.combos[cls] || []);
  const colors = d.single ? [GWPAL.range] : gtowColors(d.actions), order = d.single ? [0] : gtowOrder(d.actions);
  const inRange = rows.reduce((a, r) => a + r.w, 0), nCls = COMBOS(cls);
  const hand = (h) => (h.match(/.{2}/g) || []).map(cardHtml).join(" ");
  const what = derived
    ? (d.board ? "the class spread over the combos the board leaves" : "no board yet — every combo of this class is the same hand")
    : (d.single ? "weight per combo" : "each combo's own split and EV");
  let html = `<div class="cp-head"><b>${esc(cls)}</b> <span class="sub">${rows.length} legal combo${rows.length === 1 ? "" : "s"} · ${inRange.toFixed(2)} of ${nCls} in range · ${what}</span>` +
    `<span class="sub cp-legend">${order.map((ai) => `<span><span class="sw" style="background:${colors[ai]}"></span>${esc(d.actions[ai])}</span>`).join("")}</span></div>`;
  const collapse = derived && !d.board && rows.length > 1;
  // your exact combo, when it is in this class — preflop it stands in for the collapsed row
  const heroRow = rows.find((r) => sameCombo(r.hand, d.heroCombo)) ?? null;
  if (derived && rows.length > 1) html += `<div class="cp-note sub">${d.board
    ? `This grid carries no per-combo solve, so each combo shows the CLASS average — blockers are not reflected. Only nodes solved per combo (the AI chain, the MES locked solves) split them apart.`
    : `Preflop a solver stores 169 classes, not 1,326 combos: with no board there are no blockers, so all ${rows.length} of these are the same hand and play identically — shown as one row${heroRow ? ", yours" : ""}.`}</div>`;
  if (!rows.length) html += `<div class="sub">no legal combo of ${esc(cls)} is in range here (blocked by the board or folded out)</div>`;
  else if (!heroRow && d.heroKey === cls && d.heroCombo) html += `<div class="sub warn">your ${hand(d.heroCombo)} has no weight in this range</div>`;
  const drawn = collapse ? [heroRow ?? rows[0]] : rows;
  for (const r of drawn) {
    const isHero = r === heroRow;
    const segs = d.single ? [{ color: GWPAL.range, frac: 1 }] : order.map((ai) => ({ color: colors[ai], frac: r.s?.[ai] ?? 0 }));
    const nums = d.single ? "" : order.map((ai) => { const p = (r.s?.[ai] ?? 0) * 100; if (p < 0.5) return ""; const ev = r.ev?.[ai]; return `<span style="color:${colors[ai]}">${esc(d.actions[ai])}</span> ${p.toFixed(1)}%${ev != null ? `<span class="sub"> ev ${Number(ev).toFixed(2)}</span>` : ""}`; }).filter(Boolean).join(" · ");
    const you = isHero ? `<span class="chip good">you</span>` : "";
    html += `<div class="cmb${isHero ? " hero" : ""}"><span class="cards mono">${collapse && !isHero ? esc(cls) : hand(r.hand)}</span><span class="w sub" title="${collapse ? "weight of each combo in the range" : "weight of this combo in the range"}">${(r.w * 100).toFixed(0)}%</span>` +
      `<span class="bar" style="${gtowCellStyle(segs, 1)}"></span><span class="nums">${nums}</span>${
        collapse ? `<span>${you}<span class="chip dim" title="every combo of ${esc(cls)}">×${rows.length}</span></span>` : you}</div>`;
  }
  if (collapse) html += `<div class="cp-combos sub">${rows.map((r) => `<span class="mono${r === heroRow ? " hero" : ""}"${r === heroRow ? ` title="your combo"` : ""}>${hand(r.hand)}</span>`).join("")}</div>`;
  return html;
}

/* ---- hover popover for every 13x13 grid: the cell's action split as bars ----
   Cells carry their mix in `title` ("AQo: Raise 2.5 60% · Fold 40%"); the
   native tooltip is slow and easy to miss, so the title is lifted into
   data-tip on first hover and drawn as a proper popover next to the cell. */
(function gridTip() {
  const tip = document.createElement("div"); tip.id = "gridtip";
  // this file loads from <head> now (2026-09-30): the popover joins the body once there is one
  if (document.body) document.body.appendChild(tip); else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(tip));
  const cellOf = (e) => e.target && e.target.closest ? e.target.closest(".grid169 > div") : null;
  const render = (raw) => {
    const [head, ...rest] = raw.split(/:\s(.*)/s).filter(Boolean);
    const body = (rest[0] ?? "").trim();
    if (!body || /not in range/i.test(body)) return `<div class="h">${esc(head)}</div><div class="note">${esc(body || "not in range")}</div>`;
    // "MES Raise 2 · chart Fold 55%, Raise 2 45%" (playthrough preflop) or "Fold 55% · Raise 2 45% (0.12bb)"
    let pre = "";
    let text = body;
    const mesPick = text.match(/^MES\s+(.+?)\s+·\s+chart\s+/);
    if (mesPick) { pre = `<div class="note">MES pick: <b>${esc(mesPick[1])}</b> · chart mix below</div>`; text = text.slice(mesPick[0].length); }
    const segs = text.split(/\s·\s|,\s(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
    const rows = segs.map((sg) => { const m = sg.match(/^(.*?)\s(\d+(?:\.\d+)?)%(?:\s\((.*?)\))?$/); return m ? { label: m[1], pct: Number(m[2]), ev: m[3] } : { label: sg, pct: null }; });
    const withPct = rows.filter((r) => r.pct != null);
    const total = withPct.reduce((s, r) => s + r.pct, 0) || 100;
    return `<div class="h"><span>${esc(head)}</span><span class="sub">${withPct.length ? `${withPct.length} action${withPct.length === 1 ? "" : "s"}` : ""}</span></div>${pre}` +
      rows.map((r, i) => r.pct == null ? `<div class="note">${esc(r.label)}</div>` :
        `<div class="r"><div><div class="lab"><span>${esc(r.label)}</span>${r.ev ? `<span class="sub">${esc(r.ev)}</span>` : ""}</div><div class="bar"><i style="width:${Math.min(100, 100 * r.pct / total).toFixed(1)}%;background:${colorFor(r.label, i)}"></i></div></div><div class="pct">${r.pct}%</div></div>`).join("");
  };
  const place = (e) => { const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14), y = e.clientY + 16 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16; tip.style.left = `${Math.max(4, x)}px`; tip.style.top = `${Math.max(4, y)}px`; };
  document.addEventListener("mouseover", (e) => {
    const c = cellOf(e); if (!c) return;
    if (c.title) { c.dataset.tip = c.title; c.removeAttribute("title"); }
    const raw = c.dataset.tip; if (!raw) return;
    tip.innerHTML = render(raw); tip.style.display = "block"; place(e);
  });
  document.addEventListener("mousemove", (e) => { if (tip.style.display === "block" && cellOf(e)) place(e); });
  document.addEventListener("mouseout", (e) => { const c = cellOf(e); if (c && !(e.relatedTarget && c.contains(e.relatedTarget))) tip.style.display = "none"; });
})();
