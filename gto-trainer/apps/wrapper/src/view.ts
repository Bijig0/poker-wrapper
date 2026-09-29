/**
 * WHAT THE PANEL AND THE POLLER READ — launch.py's state() (GET /state), the DOM dump, the tool shell, the
 * screenshot. `light` skips the DOM eval and the target listing: enough for the 1 Hz study-answer poll.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdp from "./cdp";
import { time } from "./clock";
import { C } from "./config";
import { pyRound } from "./py";
import { CGG, CP, S, isCgg, isCp, seams, site } from "./state";
import * as TABLES from "./tables";
import { EXTRACT_DEEP_JS } from "./ignition/dom";
import { handState } from "./ignition/hand";
import { stateHealthSummary } from "./ignition/checks";
import { TAP_STALL_S } from "./ignition/ws";
import { autoAllowance, currentAnswer, currentChain, currentNote, pickReady } from "./relay";
import { topUpWindow } from "./topup";
import { sessionBrief } from "./session";
import { layoutNote } from "./windows";
import { apiUrl, port } from "../../api/src/services/ports";

function mtime(p: string): number {
  try {
    return Math.trunc(statSync(p).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

export async function state(light = false): Promise<Record<string, any>> {
  const st = S.study;
  const L = S.liveStatus;
  const [wOpen, wTrigger, wWhy] = topUpWindow();
  const out: Record<string, any> = {
    cdp: await cdp.available(C.CDP_PORT), ignition: null, targets: [],
    panelVersion: mtime(join(C.ROOT, "panel.html")), setupVersion: mtime(join(C.ROOT, "setup.html")),
    health: { issues: S.health.issues, checkedAgo: S.health.at ? pyRound(time() - S.health.at, 1) : null },
    fakeTable: S.fakeMode, fakeRig: C.FAKE_RIG, panelPort: C.PANEL_PORT, cdpPort: C.CDP_PORT,
    tableSlot: TABLES.slot(), tables: seams.registry(),
    tap: {
      bound: S.tapBound, heroSeat: L.heroSeatDom ?? null, foreignDropped: S.tapForeign, heldWhileUnbound: S.tapHeld,
      multi: TABLES.slot() !== null,
      stalled: !!(S.tapStall.since && S.tapBound === null && time() - S.tapStall.since > TAP_STALL_S),
      unboundForS: S.tapStall.since && S.tapBound === null ? pyRound(time() - S.tapStall.since, 1) : null,
    },
    // our table's frame in the client: the tag pinned (dom.ts pinFrame; `missing` = it is gone), every table tag open,
    // how many frames carry ours, and whether the browser is still drawing it (reader.ts noteFrame)
    tableFrame: {
      tag: S.frame.tag, missing: S.frame.lost !== null, tags: S.frameHealth.tags, dup: S.frameHealth.dup,
      drawn: S.frameHealth.drawn, why: S.frameHealth.why, idleMs: S.frameHealth.idleMs,
      forS: S.frameHealth.since ? pyRound(time() - S.frameHealth.since, 1) : null,
    },
    net: {
      last: S.net.last, bad: S.net.bad, good: S.net.good,
      sitout: S.net.sitout ? Object.fromEntries(Object.entries(S.net.sitout).filter(([k]) => k !== "html")) : null,
      everyS: C.NET_PROBE_EVERY_S,
    },
    layout: layoutNote(),
    connected: false, hand: null, studyAnswers: st.on,
    sessionId: S.session.id,
    panelTag: C.TAG || null,
    session: await sessionBrief(),
    panelAnswer: currentAnswer(),
    panelNote: currentNote(),
    // the chain line (2026-09-25): a top-level key, so the contract's recorded panelAnswer shape is untouched — and
    // only when there is one (answers on, a push received), so a /state with nothing to say is byte-identical to before
    ...((ch) => (ch ? { panelChain: ch } : {}))(currentChain()),
    practice: !!(S.fakeMode || L.practice),
    studyAuto: !!st.auto,
    studyAutoDelay: st.autoDelay || "instant",
    studyTimeBank: !!st.timeBank,
    studyTopUp: !!st.topUp,
    topUpKpi: { hands: S.topupKpi.hands, short: S.topupKpi.short, worstBb: S.topupKpi.worstBb },
    topUpWindow: { open: wOpen, trigger: wTrigger, why: wWhy },
    topUpPanelOpen: !!S.topupPanel.open,
    shadow: { agree: S.shadow.agree, differ: S.shadow.differ, last: S.shadow.last },
    stateHealth: stateHealthSummary(),
    lineUncertain: st.uncertain ?? null,
    autoHeld: st.autoHeld ? { why: st.autoHeld.why, forS: pyRound(time() - st.autoHeld.at, 1) } : null,
    pendingExec: st.pendingExec ? { pick: st.pendingExec.pick, attempts: st.pendingExec.attempts,
                                    forS: pyRound(time() - st.pendingExec.sentAt, 1) } : null,
    modal: L.modal ?? null,
    lastTopUp: st.lastTopUp ?? null,
    timeBankOffered: !!L.timeBank,
    lastTimeBank: st.lastTimeBank ?? null,
    studyAutoDue: st.autoDue ? { secondsLeft: Math.max(0.0, pyRound(st.autoDue.at - time(), 1)), wait: pyRound(st.autoDue.wait, 1) } : null,
    autoAllowance: autoAllowance(),
    autoDeclared: { on: !!st.autoDeclared, realMoney: !!st.autoDeclaredReal, budget: st.autoDeclaredBudget ?? null },
    pickReady: pickReady(),
    lastExec: st.lastExec,
    snapshot: { status: L.hero, seats: [{ hero: true, sittingOut: L.hero === "sitting-out" || L.hero === "waiting-for-bb" }] },
  };
  out.site = site();
  if (isCp()) {
    const t = CP.table();
    const hs = CP.heroStatus();
    Object.assign(out, {
      connected: !!t, hand: t ? handState() : null, table: t,
      practice: !!(t && t.practice),
      coinpoker: { client: CP.clientState(), error: CP.error, snap: S.cpSnap.last ?? null, attached: CP.pinned },
      snapshot: { status: hs, seats: [{ hero: true, sittingOut: hs === "sitting-out" }] },
    });
    return out;
  }
  if (isCgg()) {
    const t = CGG.table();
    const hs = CGG.heroStatus();
    Object.assign(out, {
      connected: !!(t && t.open), hand: t ? handState() : null, table: t, practice: false,
      clubgg: { client: CGG.clientState(), error: CGG.error, status: CGG.status, attached: CGG.pinned },
      snapshot: { status: hs, seats: [{ hero: true, sittingOut: false }] },
    });
    return out;
  }
  if (!out.cdp) return out;
  if (light) {
    out.connected = !!(await seams.ignitionTarget());
    if (out.connected) out.hand = handState();
    return out;
  }
  out.targets = (await cdp.pageTargets(C.CDP_PORT)).map((t) => ({ title: t.title || "", url: t.url || "" }));
  const t = await seams.ignitionTarget();
  if (t) {
    out.connected = true;
    out.hand = handState();
    let d: Record<string, any> = {};
    try {
      d = (await cdp.evaluate(t.webSocketDebuggerUrl, EXTRACT_DEEP_JS(), 4)) || {};
    } catch {
      d = {};
    }
    out.ignition = { title: t.title || "", url: t.url || "", textNodes: (d.nodes || []).length,
                     canvases: d.canvases ?? 0, iframes: d.iframes ?? 0 };
  }
  return out;
}

/** Visible text nodes from EVERY frame of the table window, plus a readability verdict. */
export async function domDump(): Promise<Record<string, any>> {
  const frames: any[] = [];
  for (const ws of await cdp.allTargetWss(C.CDP_PORT)) {
    let d: any;
    try {
      d = await cdp.evaluate(ws, EXTRACT_DEEP_JS(), 8);
    } catch {
      d = null;
    }
    if (!d || String(d.url || "").includes(`localhost:${C.PANEL_PORT}`)) continue;
    frames.push(d);
  }
  frames.sort((a, b) => (b.nodes || []).length - (a.nodes || []).length);
  const best = frames.length ? frames[0] : null;
  const n = best ? best.nodes.length : 0;
  const c = frames.reduce((s, f) => s + (f.canvases || 0), 0);
  const verdict = !best ? "no frames readable"
    : n >= 40 ? `DOM-READABLE: ${n} visible text nodes — CoinPoker-style DOM feed viable`
    : c ? `likely CANVAS-RENDERED (${n} text nodes, ${c} canvas element(s)) — OCR path needed`
    : `sparse (${n} text nodes) — inspect the sample below`;
  return { verdict, frames };
}

export async function shot(): Promise<Uint8Array | null> {
  const t = await seams.ignitionTarget();
  if (!t) return null;
  try {
    return await cdp.screenshot(t.webSocketDebuggerUrl, { format: "png" }, 5);
  } catch {
    return null;
  }
}

/** One window for the whole Study Tool: the panel plus the API's study surfaces as tabs. */
export function toolShell(): string {
  const dash = apiUrl();
  const tabs: [string, string, string][] = [
    ["study", "Study Answers", `http://127.0.0.1:${C.PANEL_PORT}/panel`],
    ["review", "Review Queue", `${dash}/replay`],
    ["setup", "State Tester", `${dash}/state-tester`],
    ["verify", "Reader Verify", `${dash}/table`],
    ["audit", "Solve Audit", `http://127.0.0.1:${C.PANEL_PORT}/sweep-report`],
  ];
  const buttons = tabs.map(([k, label]) => `<button data-tab='${k}'>${label}</button>`).join("");
  const frames = tabs.map(([k, , url]) => `<iframe data-pane='${k}' data-src='${url}'></iframe>`).join("");
  return `<!doctype html><html><head><meta charset=utf-8>
<title>${C.PANEL_TITLE}</title>
<style>
  html,body { margin:0; height:100%; background:#0d141c; color:#cfe0ef;
    font:13px system-ui,sans-serif; display:flex; flex-direction:column; }
  nav { display:flex; gap:2px; padding:4px 6px 0; background:#0a0f15;
    border-bottom:1px solid #1d2833; flex:0 0 auto; }
  nav button { font:inherit; border:1px solid #1d2833; border-bottom:none;
    background:#101823; color:#8fa1b6; padding:6px 14px; cursor:pointer;
    border-radius:6px 6px 0 0; }
  nav button.on { background:#16212e; color:#fff; border-color:#2a3a4c; }
  nav .hint { margin-left:auto; align-self:center; font-size:11px;
    color:#ffce56; padding-right:8px; display:none; }
  main { flex:1; position:relative; }
  iframe { position:absolute; inset:0; width:100%; height:100%; border:0;
    display:none; background:#0d141c; }
  iframe.on { display:block; }
</style></head><body>
<nav>${buttons}<span class="hint" id="hint">the API on :${port("api")} is not running —
  these tabs need it (the launcher starts it; see study-tool.log)</span></nav>
<main>${frames}</main>
<script>
  const frames = [...document.querySelectorAll("iframe")];
  const btns = [...document.querySelectorAll("nav button")];
  function show(k) {
    btns.forEach(b => b.classList.toggle("on", b.dataset.tab === k));
    frames.forEach(f => {
      const on = f.dataset.pane === k;
      f.classList.toggle("on", on);
      if (on && !f.src) f.src = f.dataset.src;   // lazy, then persistent
      // Tabs stay alive behind each other, so a page cannot know it was
      // re-fronted — tell it. The State Tester re-pulls the fake table's
      // current spec on this, which is how an audit-row click that loaded a
      // NEW spot replaces the stale one it was still showing.
      if (on && f.src) {
        try { f.contentWindow.postMessage({ shown: k }, "*"); } catch (e) {}
      }
    });
  }
  btns.forEach(b => b.onclick = () => show(b.dataset.tab));
  // Iframes can ask the shell to switch tabs (the Solve Audit does after
  // loading a clicked spot onto the fake table).
  window.addEventListener("message", e => {
    if (e.data && typeof e.data.tab === "string") show(e.data.tab);
  });
  show("study");
  // These tabs are dead without :2000 — say so instead of a blank pane.
  fetch("${dash}/", { mode: "no-cors" })
    .catch(() => document.getElementById("hint").style.display = "inline");
</script>
</body></html>`;
}

export { existsSync, readFileSync, tmpdir };
