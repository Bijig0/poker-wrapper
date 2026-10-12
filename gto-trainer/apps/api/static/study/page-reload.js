/**
 * PAGES THAT RELOAD THEMSELVES (2026-10-13). Every page is read from disk per request, but an open tab keeps running the
 * JavaScript it was served: after a merge the dashboard (or the leader page, or a study tool) went on with old code
 * until somebody pressed reload — and the dashboard's "Reload page" button was the only sign of it. This script, loaded
 * by each page, learns the page's token (the page file + every script / stylesheet it loads from the API, size + mtime
 * — services/pageToken.ts) and reloads the tab when that token changes, without ever taking away what the person is
 * doing:
 *
 *   - hidden tab → reload now (unless a live session is on: then it waits until the tab is looked at again);
 *   - the tab was just brought back (nothing pressed since) → reload now;
 *   - visible → only after 60 s with no pointer / key / scroll and no text selected;
 *   - NEVER while there is typed text the person entered (a focused field they edited, or edited text left in any
 *     field), a dialog is open, or the page says it holds work (PageReload.hold) — in a same-origin iframe too;
 *     then the button stays (the page's own, or a small note bottom-right) and the reload waits for those to clear.
 *
 * Scroll (the window's and any scrolled element with an id) is put back after the reload; the route (path, query,
 * hash) is the URL and survives by itself. The rule is `decide` below, a pure function (src/services/pageReload.test.ts).
 *
 *   <script src="/study/page-reload.js" data-page="dashboard.html"></script>
 *     data-page    the page's id in services/pageToken.ts PAGES (GET /api/build/page?page=<id>)
 *     data-feed    "1": the page already polls a token (dashboard.html: /api/build/all, every 20 s while visible) and
 *                  hands it in with PageReload.seen(token); this script then asks only while that poll is quiet
 *     data-banner  "off": the page draws its own button (PageReload.status() says what is waiting and why)
 * A page served elsewhere (the wrapper's admin / bridge on :7700) loads this from the API by full URL and `async` (a
 * stalled API must not hold the page up): the token is asked of the origin the script came from, and holds it wants
 * before this has run go in window.PageReloadHolds (an array of the same functions PageReload.hold takes).
 *
 * Cost: one GET a minute at most per tab (none while a fed poll is running), plus a 30 s floor between any two asks;
 * a few DOM checks every 5 s only while a newer version is waiting.
 *
 * Events: `pagereload` is dispatched on window just before an automatic or button reload — a page that guards its
 * unload (admin.html's "Leave site?") lets it through.
 */
(function () {
  "use strict";
  var IDLE_MS = 60000;      // visible: no pointer / key / scroll for this long = idle
  var POLL_MS = 60000;      // our own ask, when nothing feeds us
  var MIN_GAP_MS = 30000;   // never two asks closer than this
  var FED_MS = 45000;       // a token handed in this recently = the page's poll is running: skip ours
  var LOOP_MS = 30000;      // an automatic reload this recently: wait (a file being rewritten must not loop the tab)
  var SHOWN_MS = 3000;      // "just brought back": within this of becoming visible, nothing pressed since

  /**
   * THE RULE. s = { changed, hidden, idleMs, editing, dialog, held, selection, quiet, sinceReloadMs, justShown }
   * → { act: "none" | "reload" | "later" | "button", why }
   *   reload  now;
   *   later   by itself, once the tab is idle / hidden / brought back (the note says when; its button does it now);
   *   button  only by hand while the reason lasts (edits, a dialog, held work) — re-checked every few seconds.
   */
  function decide(s) {
    if (!s || !s.changed) return { act: "none", why: "" };
    if (s.editing) return { act: "button", why: "you have typed text on this page — reload when you are done with it" };
    if (s.dialog) return { act: "button", why: "a dialog is open — it reloads once it is closed and the page is idle" };
    if (s.held) return { act: "button", why: typeof s.held === "string" ? s.held : "this page is busy" };
    if (s.sinceReloadMs < LOOP_MS) return { act: "later", why: "it reloaded moments ago — again shortly" };
    if (s.hidden) return s.quiet ? { act: "later", why: "a session is live — it reloads when you come back to this tab" } : { act: "reload", why: "tab hidden" };
    if (s.selection) return { act: "later", why: "text is selected — it reloads once nothing is selected and the page is idle" };
    if (s.justShown) return { act: "reload", why: "tab brought back" };
    if (!(s.idleMs >= IDLE_MS)) return { act: "later", why: "it reloads by itself after a minute idle, or when you switch away" };
    return { act: "reload", why: "idle" };
  }

  // the unit test reads this file with a `module` in scope and takes the rule; a browser has none
  if (typeof module === "object" && module && module.exports) {
    module.exports = { decide: decide, IDLE_MS: IDLE_MS, POLL_MS: POLL_MS, MIN_GAP_MS: MIN_GAP_MS, LOOP_MS: LOOP_MS };
    return;
  }
  if (typeof window === "undefined" || window.PageReload) return;

  var me = document.currentScript;
  var pageId = me ? me.getAttribute("data-page") || "" : "";
  var fed = !!me && me.getAttribute("data-feed") === "1";
  var banner = !(me && me.getAttribute("data-banner") === "off");
  var base = "";
  try { base = me && me.src ? new URL(me.src, location.href).origin : ""; } catch (e) { base = ""; }
  if (base === location.origin) base = "";

  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked: no scroll memory */ } },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
  };
  var AT_KEY = "pageReload:at", SCROLL_KEY = "pageReload:scroll";

  var baseline = null, latest = null, quiet = false;
  var lastAskAt = 0, lastFedAt = 0, asking = false;
  var lastActivity = Date.now(), lastPress = 0, shownAt = 0;
  var lastReloadAt = Number(store.get(AT_KEY)) || 0;
  // a page that loads this async pushes its holds onto window.PageReloadHolds, before or after this runs: one array
  var holds = Array.isArray(window.PageReloadHolds) ? window.PageReloadHolds : [];
  window.PageReloadHolds = holds;
  var touched = new WeakSet(), current = { act: "none", why: "" }, recheck = null, reloading = false;

  /* ---------------------------------------------------------------- what the person is doing */
  var opts = { capture: true, passive: true };
  var moved = function () { lastActivity = Date.now(); };
  var pressed = function () { lastActivity = lastPress = Date.now(); };
  // not "scroll": a page scrolling itself (a feed kept at its bottom) fires it too, and would never be idle — the person's
  // own scrolling arrives as wheel, touch, a key or a press on the scrollbar
  ["pointermove", "wheel", "touchmove"].forEach(function (t) { window.addEventListener(t, moved, opts); });
  ["pointerdown", "keydown", "touchstart"].forEach(function (t) { window.addEventListener(t, pressed, opts); });
  // a field the PERSON typed into or changed (a page setting .value itself fires no input event)
  window.addEventListener("input", function (e) { if (e.isTrusted && e.target) touched.add(e.target); pressed(); }, true);
  window.addEventListener("change", function (e) { if (e.isTrusted && e.target) touched.add(e.target); }, true);

  function textual(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i.test(el.type || "text");
  }
  /** a focused field the person changed, or text they typed and left in any field */
  function editing() {
    var a = document.activeElement;
    if (a && touched.has(a) && (textual(a) || a.tagName === "SELECT")) return true;
    var els = document.querySelectorAll("input, textarea, [contenteditable]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!touched.has(el) || !textual(el)) continue;
      if (el.isContentEditable || el.value !== el.defaultValue) return true;
    }
    return false;
  }
  function shown(el) { return !!(el && el.getClientRects && el.getClientRects().length); }
  /** an open dialog: <dialog open>, an ARIA dialog, or anything the page marked data-reload-hold, while it is drawn */
  function dialogOpen() {
    var els = document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true], [data-reload-hold]");
    for (var i = 0; i < els.length; i++) if (shown(els[i])) return true;
    return false;
  }
  function heldBy() {
    for (var i = 0; i < holds.length; i++) {
      var r = "";
      try { r = holds[i](); } catch (e) { r = ""; }
      if (r) return r === true ? "this page is busy" : String(r);
    }
    // a same-origin page inside this one (the dashboard's /review replayer) with work of its own goes with this reload
    var fs = document.getElementsByTagName("iframe");
    for (var k = 0; k < fs.length; k++) {
      try {
        var child = fs[k].contentWindow && fs[k].contentWindow.PageReload;
        var b = child && child.blocking ? child.blocking() : "";
        if (b) return "the page embedded here: " + b;
      } catch (e) { /* another origin: nothing to ask */ }
    }
    return "";
  }
  function selected() {
    try { var s = window.getSelection && window.getSelection(); return !!(s && !s.isCollapsed && String(s).trim()); } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- deciding */
  function snapshot() {
    var now = Date.now();
    var changed = baseline !== null && latest !== null && latest !== baseline;
    if (!changed) return { changed: false };
    return {
      changed: true, hidden: !!document.hidden, idleMs: now - lastActivity,
      editing: editing(), dialog: dialogOpen(), held: heldBy(), selection: selected(), quiet: quiet,
      sinceReloadMs: now - lastReloadAt,
      justShown: !document.hidden && shownAt > 0 && now - shownAt < SHOWN_MS && lastPress < shownAt,
    };
  }
  function evaluate() {
    clearTimeout(recheck); recheck = null;
    if (reloading) return;
    current = decide(snapshot());
    if (current.act === "reload") { reloadNow(false); return; }
    note();
    if (current.act !== "none") recheck = setTimeout(evaluate, 5000);
  }
  function take(token) {
    if (!token) return;
    if (baseline === null) baseline = token;
    var was = latest;
    latest = token;
    if (latest !== was || latest !== baseline) evaluate();
  }
  function ask(force) {
    if (!pageId || asking || reloading) return;
    var now = Date.now();
    if (!force && now - lastAskAt < MIN_GAP_MS) return;
    asking = true; lastAskAt = now;
    fetch(base + "/api/build/page?page=" + encodeURIComponent(pageId), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      // an API from before this route answers 404: nothing to learn, the page simply never reloads by itself
      .then(function (j) { if (j && j.ok && j.token) { quiet = !!j.quiet; take(j.token); } })
      .catch(function () { /* the API is restarting: next time */ })
      .then(function () { asking = false; });
  }

  /* ---------------------------------------------------------------- reloading, keeping the place */
  function saveScroll() {
    var els = [];
    var all = document.querySelectorAll("[id]");
    for (var i = 0; i < all.length && els.length < 20; i++) {
      var e = all[i];
      if (e.scrollTop > 0 || e.scrollLeft > 0) els.push([e.id, e.scrollTop, e.scrollLeft]);
    }
    store.set(SCROLL_KEY, JSON.stringify({ url: location.href, at: Date.now(), x: window.scrollX, y: window.scrollY, els: els }));
  }
  function reloadNow(byHand) {
    if (reloading) return;
    reloading = true;
    try { saveScroll(); } catch (e) { /* the place is a nicety; the reload is the point */ }
    if (!byHand) store.set(AT_KEY, String(Date.now()));
    try { window.dispatchEvent(new Event("pagereload")); } catch (e) { /* old browser */ }
    location.reload();
  }
  // the page is re-rendered from fetches after load, so the old place may not exist yet — and content drawn above it
  // later moves it again: re-apply until it has held for a second (up to 15 s), and stop the moment the person
  // scrolls, clicks or types
  function restoreScroll() {
    var s = null;
    try { s = JSON.parse(store.get(SCROLL_KEY) || "null"); } catch (e) { s = null; }
    store.del(SCROLL_KEY);
    if (!s || s.url !== location.href || !(Date.now() - s.at < 120000)) return;
    var t0 = Date.now(), stop = false, held = 0;
    var quit = function () { stop = true; };
    ["wheel", "pointerdown", "keydown", "touchstart"].forEach(function (t) { window.addEventListener(t, quit, { capture: true, passive: true, once: true }); });
    var step = function () {
      if (stop) return;
      var done = true;
      if (s.x || s.y) {
        window.scrollTo(s.x || 0, s.y || 0);
        if (Math.abs(window.scrollY - (s.y || 0)) > 2 || Math.abs(window.scrollX - (s.x || 0)) > 2) done = false;
      }
      (s.els || []).forEach(function (r) {
        var el = document.getElementById(r[0]);
        if (!el) { done = false; return; }
        el.scrollTop = r[1]; el.scrollLeft = r[2];
        if (Math.abs(el.scrollTop - r[1]) > 2 || Math.abs(el.scrollLeft - r[2]) > 2) done = false;
      });
      held = done ? held + 1 : 0;
      if (held < 4 && Date.now() - t0 < 15000) setTimeout(step, 250);
    };
    step();
  }

  /* ---------------------------------------------------------------- the note (pages without their own button) */
  function note() {
    if (!banner) return;
    var el = document.getElementById("page-reload-note");
    if (current.act !== "later" && current.act !== "button") { if (el) el.remove(); return; }
    if (!document.body) return;
    if (!el) {
      el = document.createElement("div");
      el.id = "page-reload-note";
      el.setAttribute("role", "status");
      el.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483000;max-width:min(520px,calc(100vw - 24px));"
        + "display:flex;gap:10px;align-items:center;padding:8px 10px 8px 12px;border-radius:10px;border:1px solid #3a4a5a;"
        + "background:#1f2a35;color:#e8edf2;font:13px/1.35 system-ui,'Segoe UI',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)";
      var t = document.createElement("span");
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "Reload";
      b.style.cssText = "flex:none;font:inherit;padding:4px 10px;border-radius:7px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer";
      b.onclick = function () { reloadNow(true); };
      el.appendChild(t); el.appendChild(b);
      document.body.appendChild(el);
    }
    el.firstChild.textContent = "⟳ This page has a newer version — " + current.why + ".";
  }

  /* ---------------------------------------------------------------- wiring */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) shownAt = Date.now();
    var pending = baseline !== null && latest !== null && latest !== baseline;
    // brought back, or hidden with a fresh `quiet`: decide now. Hidden with an old one (a fed page asks rarely): ask
    // first — its answer decides. Nothing waiting: learn now (the 30 s floor still holds).
    if (pending && (!document.hidden || Date.now() - lastAskAt < MIN_GAP_MS)) evaluate();
    else ask(pending);
  });
  // back from the back/forward cache: the page is as old as it was when left
  window.addEventListener("pageshow", function (e) { if (e.persisted) { shownAt = Date.now(); ask(true); } });
  setInterval(function () {
    if (fed && !document.hidden && Date.now() - lastFedAt < FED_MS) return;   // the page's own poll is running
    ask(false);
  }, POLL_MS);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restoreScroll, { once: true });
  else restoreScroll();
  if (!fed) ask(true);
  // a fed page that never feeds (its poll broke) still learns its baseline from us
  else setTimeout(function () { if (baseline === null) ask(true); }, 5000);

  window.PageReload = {
    /** a token from the page's own poll (data-feed) */
    seen: function (token) { lastFedAt = Date.now(); take(token); },
    /** fn() → "" when free, or why the page must not reload by itself now (a string, or true) */
    hold: function (fn) { if (typeof fn === "function") holds.push(fn); },
    /** what blocks a reload outright (edits, a dialog, held work) — a parent page asks before reloading this one */
    blocking: function () {
      if (editing()) return "typed text";
      if (dialogOpen()) return "an open dialog";
      return heldBy();
    },
    changed: function () { return baseline !== null && latest !== null && latest !== baseline; },
    status: function () { return { act: current.act, why: current.why, page: pageId, baseline: baseline, latest: latest }; },
    reload: function () { reloadNow(true); },
    decide: decide,
  };
})();
