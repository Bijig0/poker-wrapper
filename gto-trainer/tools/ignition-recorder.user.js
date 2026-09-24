// ==UserScript==
// @name         Ignition table recorder
// @namespace    poker-gto
// @version      1.0
// @description  Read-only capture of Ignition table state. Survives reloads.
// @match        https://www.ignitioncasino.uno/static/poker-game*
// @match        https://www.ignitioncasino.eu/static/poker-game*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Records distinct table states so the DOM reader can be completed and
 * verified. It is READ-ONLY: it never clicks, types, or sends anything, and it
 * touches no element of the client.
 *
 * Why a userscript rather than a console paste: a page global dies on reload
 * and takes the session with it. This persists to localStorage after every
 * capture and re-attaches itself automatically, so a refresh costs nothing.
 *
 * Pull the data with:  copy(localStorage.ignRec)
 */
(function () {
  "use strict";

  const KEY = "ignRec";
  const CAP = 600;
  const TICK = 300;

  const SUITS = ["c", "d", "h", "s"];
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
  const dec = (i) => (i < 0 || i > 51 ? null : RANKS[i % 13] + SUITS[(i / 13) | 0]);

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? null;
    } catch {
      return null;
    }
  };
  const store = load() ?? { snaps: [], bars: {}, sigs: [], ticks: 0, dropped: 0 };
  const seen = new Set(store.sigs);

  let dirty = false;
  const save = () => {
    if (!dirty) return;
    dirty = false;
    store.sigs = [...seen].slice(-CAP);
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      // Quota hit — drop the oldest half rather than lose the run.
      store.snaps = store.snaps.slice(-Math.floor(CAP / 2));
      try {
        localStorage.setItem(KEY, JSON.stringify(store));
      } catch {}
    }
  };

  const fiber = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith("__reactInternalInstance$"));
    return k ? el[k] : null;
  };
  const prop = (el, key) => {
    let f = fiber(el), d = 0;
    while (f && d < 10) {
      const p = f.memoizedProps;
      if (p && typeof p === "object" && key in p) return p[key];
      f = f.return; d++;
    }
    return null;
  };
  const zoomOf = (el) => {
    let e = el;
    while (e) {
      const z = parseFloat(getComputedStyle(e).zoom);
      if (z && z !== 1) return z;
      e = e.parentElement;
    }
    return 1;
  };

  /** Table lives in a same-origin child frame; find it fresh each tick. */
  const tableDoc = () => {
    if (document.querySelector("[data-qa^='playerContainer-']")) return document;
    for (let i = 0; i < window.frames.length; i++) {
      try {
        const d = window.frames[i].document;
        if (d.querySelector("[data-qa^='playerContainer-']")) return d;
      } catch {}
    }
    return null;
  };

  /** Leaf text nodes and where they sit — this is how action/bet/timer get located. */
  const leaves = (root, ox, oy, Z) => {
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 24 || /[{}]/.test(t)) continue;
      const b = el.getBoundingClientRect();
      if (!b.width) continue;
      const cs = getComputedStyle(el);
      out.push({
        t,
        x: Math.round((b.x - ox) / Z),
        y: Math.round((b.y - oy) / Z),
        fs: cs.fontSize,
        c: cs.color,
        cls: String(el.className).slice(0, 24),
      });
    }
    return out;
  };

  const cardsIn = (root) => {
    const ids = [];
    for (const c of root.querySelectorAll("[data-qa^='card']")) {
      const m = c.getAttribute("data-qa").match(/^card(-?\d+)$/);
      if (!m) continue;
      const i = +m[1];
      if (i >= 0 && i <= 51 && !ids.includes(i)) ids.push(i);
    }
    return ids.map(dec);
  };

  setInterval(() => {
    const td = tableDoc();
    if (!td) return;
    store.ticks++;
    try {
      const seatEls = [...td.querySelectorAll("[data-qa^='playerContainer-']")];
      if (!seatEls.length) return;
      const Z = zoomOf(seatEls[0]);

      const seats = seatEls.map((el) => {
        const b = el.getBoundingClientRect();
        return {
          seat: +el.getAttribute("data-qa").split("-")[1],
          acting: prop(el, "isTheActivePlayer"),
          cards: cardsIn(el),
          parts: leaves(el, b.x, b.y, Z),
        };
      });

      const inSeat = new Set(seats.flatMap((s) => s.cards));
      const board = cardsIn(td).filter((c) => !inSeat.has(c));

      const sig =
        board.join("") +
        JSON.stringify(
          seats.map((s) => [s.seat, s.acting, s.cards.join(""), s.parts.map((p) => p.t).join("|")]),
        );

      if (!seen.has(sig)) {
        if (store.snaps.length < CAP) {
          seen.add(sig);
          store.snaps.push({ t: Date.now(), board, seats });
          dirty = true;
        } else store.dropped++;
      }

      const bs = [...td.querySelectorAll("[data-qa$='Button'],[data-qa$='Selector']")].filter(
        (b) => (b.textContent || "").trim(),
      );
      if (bs.length) {
        const key = bs.map((b) => b.getAttribute("data-qa")).join("|");
        if (!store.bars[key]) {
          store.bars[key] = bs.map((b) => {
            const r = b.getBoundingClientRect();
            const cs = getComputedStyle(b);
            return {
              qa: b.getAttribute("data-qa"),
              label: (b.textContent || "").trim().slice(0, 24),
              box: [+(r.width / Z).toFixed(1), +(r.height / Z).toFixed(1)],
              bg: cs.backgroundColor,
              fs: cs.fontSize,
            };
          });
          dirty = true;
        }
      }
    } catch (e) {
      store.err = String(e).slice(0, 120);
    }
  }, TICK);

  // Persist on a slow cadence and on the way out, so a reload costs nothing.
  setInterval(save, 3000);
  addEventListener("beforeunload", save);
  addEventListener("visibilitychange", save);

  console.log(
    `%c[ignition-recorder] running — ${store.snaps.length} states carried over. copy(localStorage.ignRec) to pull.`,
    "color:#0c9",
  );
})();
