/**
 * The TRANSLATED view of one recorded tick: recording -> hand -> answer, with
 * every seam exposed. Ported from the dashboard app's replay-translated.tsx,
 * strategy-tabs.tsx, lib/strategyMode.ts and chart-node-grid.tsx.
 *
 * The replay scrubber shows what was RECORDED; this panel shows what the
 * pipeline MAKES of it — explicitly, because the translation is where review
 * questions live:
 *
 *   TRANSLATION STATUS — did this tick build into a hand at all, and if not
 *   the exact reason (the /answer endpoint's own notes, not a summary).
 *
 *   NODE STEPPER — a second scrubber over the translated hand's ACTION TREE.
 *   The main slider moves through TIME; this one moves through the HAND.
 *
 *   TWO ANSWERS — what the panel actually said at the table (recorded into the
 *   tick, newer sessions only) and what the pipeline says NOW for the same
 *   state. Divergence means the pipeline changed or the live read differed.
 *
 *   PROVENANCE — where every input came from, including a direct link to the
 *   raw chart node on :8777 so the cell can be eyeballed without trusting any
 *   of this.
 *
 * Porting note: the old build had two panels over the SAME endpoint —
 * ReplayTranslated (scrubber) and StudyAnswer (queue), the latter a subset
 * emphasising provenance. They are one panel here; the queue gains the node
 * stepper it never had, and nothing is lost.
 */

const CHARTS = "http://127.0.0.1:8777";

/* ------------------------------------------------------- strategy mode --- */

/**
 * The MES/GTO choice: which preflop answer is PRIMARY everywhere study answers
 * render — "exploit" (pool best-response) or "chart" (equilibrium). Persisted
 * in localStorage and broadcast on change, so every surface flips together and
 * the choice survives reloads. The API returns BOTH answers regardless; this
 * only chooses the primary (and is passed as `strategy` so the server's
 * decision/provenance agree with the UI).
 */
const KEY = "strategy-mode";
const EVENT = "strategy-mode-change";

export function getStrategyMode() {
  try {
    return localStorage.getItem(KEY) === "chart" ? "chart" : "exploit";
  } catch {
    return "exploit";
  }
}

export function setStrategyMode(mode) {
  try { localStorage.setItem(KEY, mode); }
  catch { /* private windows etc. — the event still fans out */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

/** The MES / GTO segmented control — drop it next to any study-answer header. */
export function strategyTabs() {
  const wrap = document.createElement("div");
  wrap.className = "strat";
  wrap.title = "Which strategy is primary: MES = pool best-response (exploit), " +
    "GTO = equilibrium chart. Both are always computed.";
  const mk = (mode, label) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.mode = mode;
    b.onclick = () => setStrategyMode(mode);
    wrap.appendChild(b);
    return b;
  };
  mk("exploit", "MES");
  mk("chart", "GTO");
  const paint = () => {
    const m = getStrategyMode();
    wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  };
  paint();
  window.addEventListener(EVENT, paint);
  return wrap;
}

/* ---------------------------------------------------------- chart grid --- */

const RANKS_HI = "AKQJT98765432";
const isJam = (l) => /all-?in/i.test(l);

function wagerSize(label) {
  const m = label.match(/^(?:Bet|Raise|All-?in)\s+(\d+(?:\.\d+)?)$/i);
  if (m) return Number(m[1]);
  return isJam(label) ? Infinity : null;
}

/**
 * Colours copied from analysis/src/gtowui so the grid reads exactly like the
 * GTO Wizard UI replica the eye is trained on: fold cool blue, passive green,
 * wagers on a warm ramp ordered by size within the node.
 */
function actionColor(label, all) {
  if (label === "Fold") return "#5b7fa6";
  if (label === "Check" || label === "Call" || label === "Limp") return "#41a368";
  const ramp = ["#d9a13d", "#d97f3d", "#cf5b36", "#b83a3a", "#8f2f4a"];
  if (isJam(label)) return ramp[ramp.length - 1];
  const size = wagerSize(label);
  if (size === null) return "#d97f3d";
  const sizes = all.filter((l) => !isJam(l)).map(wagerSize)
    .filter((s) => s !== null).sort((a, b) => a - b);
  const idx = sizes.indexOf(size);
  return ramp[Math.min(idx < 0 ? 0 : idx, ramp.length - 2)];
}

/**
 * The raw chart cell, SEEN: a 13x13 strategy matrix of the exact node an
 * answer came from, fetched straight off the chart server (:8777, R2-backed).
 * Hero's class is ringed; clicking any cell prints its exact mix and EVs.
 */
export function chartNodeGrid(host, { source, line, heroClass }) {
  host.textContent = "";
  const note = document.createElement("p");
  note.className = "sub";
  note.textContent = "loading chart node…";
  host.appendChild(note);

  const l = line === "(root)" ? "" : line;
  fetch(`${CHARTS}/api/preflop/node?source=${encodeURIComponent(source)}&line=${encodeURIComponent(l)}`)
    .then((r) => r.json())
    .then((j) => {
      if (!j.ok) throw new Error("node not in chart");
      render(j);
    })
    .catch((e) => {
      // :8777 is a separate process and is often the thing that is down.
      note.className = "bad";
      note.textContent = `${e.message} — is the chart server on :8777 running?`;
    });

  function render(node) {
    host.textContent = "";
    const labels = (node.actions ?? []).map((a) => a.action);
    const byHand = new Map((node.cells ?? []).map((c) => [c.hand, c]));

    // size control: the 13x13 fills its column by default, which on a wide
    // screen means scrolling to see grid + legend together. Persisted.
    const sizes = { S: 300, M: 420, L: null };
    let size = "M";
    try { size = localStorage.getItem("chart-grid-size") || "M"; } catch {}
    const sizer = document.createElement("div");
    sizer.className = "grid-size";
    sizer.innerHTML = `<span class="sub">range size</span>` + Object.keys(sizes).map((k) =>
      `<button class="${k === size ? "on" : ""}" data-k="${k}">${k}</button>`).join("");
    host.appendChild(sizer);
    const legend = document.createElement("div");
    legend.className = "legend";
    labels.forEach((lab) => {
      const s = document.createElement("span");
      s.innerHTML = `<i style="background:${actionColor(lab, labels)}"></i>${lab}`;
      legend.appendChild(s);
    });
    host.appendChild(legend);

    const grid = document.createElement("div");
    grid.className = "grid169";
    let sel = heroClass ?? null;
    const detail = document.createElement("div");
    detail.className = "cell-detail";

    const paintDetail = () => {
      const c = sel ? byHand.get(sel) : null;
      if (!c) { detail.style.display = "none"; return; }
      detail.style.display = "";
      const parts = labels.map((lab) => {
        const f = c.actions[lab] ?? 0;
        const ev = c.evs?.[lab];
        return f > 0 ? `${lab} ${f.toFixed(1)}%${ev != null ? ` (ev ${ev.toFixed(2)})` : ""}` : null;
      }).filter(Boolean);
      detail.innerHTML = `<b>${c.hand}</b>${c.hand === heroClass ? " (hero)" : ""}: ${parts.join(" · ")}`;
    };

    for (let n = 0; n < 169; n++) {
      const i = Math.floor(n / 13), k = n % 13;
      const hi = RANKS_HI[Math.min(i, k)], lo = RANKS_HI[Math.max(i, k)];
      const key = i === k ? hi + lo : hi + lo + (k > i ? "s" : "o");
      const cell = byHand.get(key);
      const b = document.createElement("button");
      b.className = "c169";
      b.textContent = key;
      if (!cell) {
        b.classList.add("empty");
        grid.appendChild(b);
        continue;
      }
      let acc = 0;
      const stops = [];
      for (const lab of labels) {
        const f = (cell.actions[lab] ?? 0) / 100;
        if (f < 0.005) continue;
        stops.push(`${actionColor(lab, labels)} ${acc * 100}% ${(acc + f) * 100}%`);
        acc += f;
      }
      b.style.background = stops.length ? `linear-gradient(135deg, ${stops.join(",")})` : "#333";
      if (key === heroClass) b.classList.add("hero");
      b.title = `${key} — ` + labels
        .map((lab) => `${lab} ${(cell.actions[lab] ?? 0).toFixed(0)}%`)
        .filter((s) => !s.endsWith(" 0%")).join(", ");
      b.onclick = () => {
        sel = sel === key ? null : key;
        grid.querySelectorAll(".c169.sel").forEach((x) => x.classList.remove("sel"));
        if (sel) b.classList.add("sel");
        paintDetail();
      };
      grid.appendChild(b);
    }
    host.appendChild(grid);
    const applySize = () => {
      const px = sizes[size];
      grid.style.maxWidth = px ? px + "px" : "";
      legend.style.maxWidth = px ? px + "px" : "";
      sizer.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === size));
    };
    sizer.querySelectorAll("button").forEach((b) => b.onclick = () => {
      size = b.dataset.k; try { localStorage.setItem("chart-grid-size", size); } catch {}
      applySize();
    });
    applySize();
    host.appendChild(detail);
    paintDetail();
  }
}

/* ------------------------------------------------------- answer panel --- */

const SOURCE_LABEL = {
  "local-preflop": "local crawled 6-max preflop DB",
  "hrc-3max-preflop": "HRC 3-max asymmetric charts (R2 via :8777)",
  "pool-exploit-preflop": "pool best-response (exploit_ranges.json) over the HRC charts",
  "gtow-api-postflop": "GTO Wizard AI custom solve",
  "mes-postflop": "pool MES — our locked-villain flop solve (mes_postflop.json)",
};

/**
 * Answers already computed this visit — a solve costs seconds, a Map lookup
 * does not, and stepping back to a node you just read should be instant.
 */
const answerCache = new Map();

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/**
 * Mount the translate-and-answer panel into `host`.
 *
 * Fetches only ON DEMAND unless `auto`: a hero-to-act tick costs a live solve,
 * and a scrubber that solved on every slider move would hammer GTO Wizard.
 * `auto` is debounced and cached, so stepping through decisions does not
 * re-solve what was already solved.
 */
export function mountAnswerPanel(host, { session, seq, tick, auto }) {
  host.textContent = "";
  host.className = "answer-panel";

  let data = null;
  let busy = false;
  let step = -1; // -1 = show all
  let debounce = null;

  const bar = document.createElement("div");
  bar.className = "row";
  const askBtn = document.createElement("button");
  askBtn.className = "mini";
  bar.appendChild(askBtn);
  bar.appendChild(strategyTabs());

  const live = tick?.liveAnswer;
  if (live) {
    const b = document.createElement("span");
    b.className = "live-said";
    b.title = "recorded from the panel at the table";
    b.textContent = `live said: ${live.pick ?? live.text}`;
    bar.appendChild(b);
  }
  host.appendChild(bar);

  const body = document.createElement("div");
  body.className = "answer-body";
  host.appendChild(body);

  const key = () => `${session}:${seq}:${getStrategyMode()}`;

  async function ask() {
    const k = key();
    if (answerCache.has(k)) { data = answerCache.get(k); paint(); return; }
    busy = true; paint();
    try {
      const r = await fetch(`/api/replay/${session}/answer/${seq}?strategy=${getStrategyMode()}`);
      const j = await r.json();
      answerCache.set(k, j);
      data = j;
    } catch (e) {
      data = { ok: false, error: String(e) };
    } finally {
      busy = false; paint();
    }
  }

  function scheduleAuto() {
    if (!auto || answerCache.has(key())) { data = answerCache.get(key()) ?? data; paint(); return; }
    clearTimeout(debounce);
    debounce = setTimeout(() => void ask(), 500);
  }

  // Flipping MES/GTO is a different answer for the same tick — refetch.
  const onMode = () => { step = -1; data = answerCache.get(key()) ?? null; paint(); scheduleAuto(); };
  window.addEventListener(EVENT, onMode);

  function paint() {
    askBtn.disabled = busy;
    askBtn.textContent = busy ? "translating…" : data ? "re-check" : "Translate & answer this tick";
    body.textContent = "";

    if (!data && !busy && !auto) {
      body.innerHTML = `<p class="sub" style="font-style:italic">on demand — a hero-to-act tick costs a live solve</p>`;
      return;
    }
    if (!data) return;
    if (!data.ok) {
      body.innerHTML = `<p class="box bad-box">${esc(data.error)}</p>`;
      return;
    }

    const h = data.hand;
    const s = data.solution;

    /* ------------------------------------------ translation status */
    const st = document.createElement("div");
    st.className = "box " + (h ? "ok-box" : "warn-box");
    st.innerHTML =
      `<div class="box-h">${h ? "translated to a hand" : "NOT translatable"}</div>` +
      (h ? `<p class="mono">hero seat ${esc(h.heroSeat)} (${esc(h.heroPos ?? "pos unknown")}) · ${esc(h.street)}` +
        (h.board?.length ? ` · ${esc(h.board.join(" "))}` : "") +
        ` · pot ${esc(h.node?.pot)} · to call ${esc(h.node?.toCall)} · button seat ${esc(data.buttonSeat ?? "?")}</p>` : "") +
      (data.notes?.length
        ? `<ul class="notes">${data.notes.map((n) => `<li>· ${esc(n)}</li>`).join("")}</ul>` : "");
    body.appendChild(st);

    /* -------------------------------------------- the node stepper */
    if (data.feed?.length) {
      const box = document.createElement("div");
      box.className = "box";
      const head = document.createElement("div");
      head.className = "row";
      head.innerHTML = `<span class="fld-l">step the translated hand</span>`;
      const rng = document.createElement("input");
      rng.type = "range"; rng.min = 0; rng.max = data.feed.length - 1;
      rng.value = step < 0 ? data.feed.length - 1 : step;
      rng.style.flex = "1";
      const all = document.createElement("button");
      all.className = "mini"; all.textContent = "all";
      const list = document.createElement("ol");
      list.className = "feed-list";

      const paintFeed = () => {
        list.textContent = "";
        data.feed.forEach((l, k) => {
          const li = document.createElement("li");
          li.textContent = `${k}. ${l}`;
          if (step >= 0 && k > step) li.className = "dim";
          else if (step === k) li.className = "now";
          list.appendChild(li);
        });
      };
      rng.oninput = () => { step = Number(rng.value); paintFeed(); };
      all.onclick = () => { step = -1; rng.value = data.feed.length - 1; paintFeed(); };

      head.appendChild(rng); head.appendChild(all);
      box.appendChild(head); box.appendChild(list);
      paintFeed();
      if (h?.line) {
        const p = document.createElement("p");
        p.className = "sub mono";
        p.textContent = `solver line: ${h.line}`;
        box.appendChild(p);
      }
      body.appendChild(box);
    }

    /* ------------------------------------- answers, live vs now */
    const ans = document.createElement("div");
    ans.className = "box";
    ans.innerHTML = `<div class="box-h">study answer — recomputed NOW vs recorded LIVE</div>`;

    // NOW's chart is the setId/gametype the answer came from; LIVE recorded
    // the same provenance (chart/source/strategy/roll) when the poller pushed it.
    // the exact chart id (ign200_3maxasym2ci_D100_s100_eq) beats the set label (3max-asym)
    const nowChart = s?.gametype ?? s?.setId ?? null;
    const fmtRoll = (roll, band) => {
      if (roll == null) return "no roll (pure pick)";
      if (band && band[0] <= 0.05 && band[1] >= 99.95) return "pure pick — 100% of the mix, no roll needed";
      return `rolled ${Number(roll).toFixed(1)}` + (band ? ` in [${band[0].toFixed(1)}–${band[1].toFixed(1)})` : "");
    };
    const modeTag = (m) => m === "exploit" ? `<span class="tag mes">MES</span>` : m === "chart" ? `<span class="tag gto">GTO</span>` : "";

    if (s?.ok && !s.heroClass) {
      ans.innerHTML += `<p class="box warn-box">The node answered (${esc(s.gametype)} @ ${esc(s.line)}) but hero's cards were not captured in THIS tick — usually the deal animation. Step one tick forward: the cards render a moment after the buttons.</p>`;
    } else if (s?.ok) {
      const rows = (s.actions ?? []).map((a) =>
        `<div class="freq"><span class="mono nm">${esc(a.action)}</span>` +
        `<span class="track"><i style="width:${a.frequency}%"></i></span>` +
        `<span class="mono pc">${Number(a.frequency).toFixed(1)}%</span></div>`).join("");

      // ---- the two explicit verdict rows ---------------------------------
      const isEx = s.strategyMode === "exploit";
      const nowPick = s.decision?.action ?? "—";
      const otherPick = isEx ? s.chartDecision?.action : s.exploitDecision?.action;
      const agree = otherPick != null && otherPick === nowPick;
      let verdict = `<table class="verdict"><tbody>`;
      if (live) {
        verdict += `<tr><th>LIVE game picked</th><td><b class="mono big">${esc(live.pick ?? live.text)}</b></td>` +
          `<td class="sub">${modeTag(live.strategy)} ${esc(fmtRoll(live.roll, live.band))}` +
          (live.chart ? ` · chart <span class="mono">${esc(live.chart)}</span>` : "") +
          (live.tier ? ` · ${esc(live.tier)}` : "") + `</td></tr>`;
      } else {
        verdict += `<tr><th>LIVE game picked</th><td colspan="2" class="sub">no live answer recorded at this tick</td></tr>`;
      }
      verdict += `<tr><th>NOW picks</th><td><b class="mono big">${esc(nowPick)}</b></td>` +
        `<td class="sub">${modeTag(s.strategyMode)} ${esc(fmtRoll(s.decision?.roll, s.decision?.band))}` +
        (nowChart ? ` · chart <span class="mono">${esc(nowChart)}</span>` : "") +
        (s.tier ? ` · ${esc(s.tier)}` : "") + `</td></tr>`;
      verdict += `</tbody></table>`;
      if (live?.pick && s.decision?.action && live.pick !== s.decision.action) {
        const sameChart = live.chart && nowChart && live.chart === nowChart;
        const sameMode = live.strategy && s.strategyMode && live.strategy === s.strategyMode;
        const why = sameChart && sameMode ? "same chart, same strategy — a different mixed-strategy roll"
          : !sameMode && live.strategy ? `strategy differs (live ${live.strategy}, now ${s.strategyMode})`
          : "different chart or the pipeline changed";
        verdict += `<p class="differs">live ≠ now: ${esc(why)}</p>`;
      }

      // ---- clickable MES/GTO swap ----------------------------------------
      let extra = "";
      if (s.exploitDecision || s.chartDecision) {
        const swapTo = isEx ? "chart" : "exploit";
        extra += `<div class="dual">` +
          `<span class="tag ${isEx ? "mes" : "gto"}">${isEx ? "MES" : "GTO"} · ${esc(nowPick)}</span>` +
          `<button class="swap" data-mode="${swapTo}" title="switch the primary strategy and show its range + roll">` +
          `${isEx ? "GTO" : "MES"} would: <b class="mono">${esc(otherPick ?? "(not covered)")}</b> ↗</button>` +
          (otherPick == null ? "" : agree
            ? `<span class="same">✓ same action in both — the ranges differ only in mix, not in this pick</span>`
            : `<span class="sub">click to open the ${isEx ? "GTO" : "MES"} range and its roll</span>`) +
          `</div>`;
      }
      ans.innerHTML += verdict + rows + extra +
        (s.warning ? `<p class="warn" style="font-size:10px">${esc(s.warning)}</p>` : "");
      const swapBtn = ans.querySelector("button.swap");
      if (swapBtn) swapBtn.onclick = () => setStrategyMode(swapBtn.dataset.mode);
    } else {
      ans.innerHTML += `<p class="sub">${esc(data.deferred ?? s?.reason ?? "no decision at this tick")}` +
        (live ? ` · but live said <b class="mono">${esc(live.pick ?? live.text)}</b>` : "") + `</p>`;
    }
    body.appendChild(ans);

    /* -------------------------------------------------- provenance */
    const prov = document.createElement("div");
    prov.className = "box";
    const pad = String(seq).padStart(5, "0");
    let items =
      `<li>recording: ignition-study-wrapper/debug/${esc(session)}/log.jsonl (tick seq ${esc(seq)})</li>` +
      `<li>raw DOM: …/${esc(session)}/dom.jsonl · frame: …/f${pad}.jpg</li>`;
    if (s?.ok) {
      items += `<li>answer source: ${esc(SOURCE_LABEL[s.source] ?? s.source)} · ${esc(s.gametype)} @ ${esc(s.depth)}bb · line ${esc(s.line)}</li>`;
    }
    if (s?.ok && s.source === "gtow-api-postflop") {
      items += `<li>ranges reconstructed from the preflop charts along the line above; solve via GTO Wizard AI (token over CDP :9222)</li>`;
    }
    prov.innerHTML = `<div class="box-h">where this data came from</div><ul class="prov-list">${items}</ul>`;

    // The exploit answers over the SAME chart node (it re-picks per hand
    // class; the cells are the equilibrium mix), so the grid is shown in
    // both modes — in MES mode it is the GTO node the exploit overrides.
    if (s?.ok && (s.source === "hrc-3max-preflop" || s.source === "pool-exploit-preflop")) {
      const gridBox = document.createElement("div");
      gridBox.className = "box";
      const isEx = s.source === "pool-exploit-preflop";
      gridBox.innerHTML = `<div class="box-h">${isEx
        ? "the GTO chart node the MES pick overrides — hero's class ringed (its equilibrium mix), click any cell"
        : "the chart node itself — hero's class ringed, click any cell"}</div>`;
      const gh = document.createElement("div");
      gridBox.appendChild(gh);
      prov.appendChild(gridBox);
      chartNodeGrid(gh, { source: s.gametype, line: s.line, heroClass: s.heroClass });

      const raw = document.createElement("p");
      raw.className = "sub mono";
      const l = s.line === "(root)" ? "" : s.line;
      const href = `${CHARTS}/api/preflop/node?source=${encodeURIComponent(s.gametype)}&line=${encodeURIComponent(l)}`;
      raw.innerHTML = `raw chart cell: <a href="${href}" target="_blank" rel="noreferrer">:8777/api/preflop/node?source=${esc(s.gametype)}&amp;line=${esc(l)}</a> — the exact node, hand class ${esc(s.heroClass)}`;
      prov.appendChild(raw);
    }
    body.appendChild(prov);
  }

  askBtn.onclick = () => void ask();

  data = answerCache.get(key()) ?? null;
  paint();
  scheduleAuto();

  return { destroy: () => { window.removeEventListener(EVENT, onMode); clearTimeout(debounce); } };
}
