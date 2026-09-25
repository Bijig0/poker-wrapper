/**
 * Fake Ignition table: render a game-state spec as a faithful local table. Port of faketable.py.
 *
 * STRUCTURE — it emits the client's own DOM contract (the data-qa hooks and containment the table reader keys on);
 * APPEARANCE — the geometry and art are the replica's, measured off the live client. Keeping both in one document
 * is the point: what the reader parses and what a human eyeballs are the same table.
 *
 * Byte-for-byte the Python's output (the golden corpus renders every fixture through both): numbers are printed
 * the way Python prints them — `pf()` for a value Python holds as a float ("57.0", not "57"), `fmtFixed`/`fmtG`
 * for the f-string formats.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { paths } from "./env";
import { fmtFixed, fmtG, htmlEscape, pyFloat, pyFloatStr, pyInt } from "./py";

const RANKS = "A23456789TJQK";
const SUITS = "cdhs";
const GLYPH: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const GLYPH_TO_SUIT: Record<string, string> = Object.fromEntries(Object.entries(GLYPH).map(([k, v]) => [v, k]));

/** str() of a value Python holds as a FLOAT. */
const pf = (v: number) => pyFloatStr(v);

// ---- geometry, measured off the live client (types.ts) ----
/** THE CLIENT RELABELS ITS CONFIRM once the size in the bet field is hero's whole stack: "RAISE TO 2 BB" → "ALL-IN 89.2
 *  BB" (the ALL-IN preset puts it there: session 20260925_135420 frames 2038 → 2039, hand 4920545590; a BET reads the
 *  same). The relay's shove presses the confirm only once it reads ALL-IN, so the fake table does this too. (The
 *  client also shows a typed size — "RAISE TO 2.6 BB" — which the relay does not depend on, so it is not modelled:
 *  the contract transcript's sized-raise replies stay as recorded.) One block, appended to the table's script — the
 *  pure golden and the contract transcript (recorded before it) compare the page with exactly this block taken out. */
export const CONFIRM_RELABEL_JS = `
  const conf = document.querySelector("button[data-qa='raiseButton'], button[data-qa='betButton']");
  if (bi && conf) {
    const shown = conf.innerText;
    const relabel = () => {
      const v = parseFloat(bi.value), hi = parseFloat(bi.dataset.max);
      conf.innerText = !isNaN(v) && !isNaN(hi) && v >= hi ? 'ALL-IN ' + (Math.round(hi * 100) / 100) + ' BB' : shown;
    };
    bi.addEventListener('input', relabel);
    const allIn = document.querySelector("button[data-qa='allInSelector']");
    if (allIn) allIn.addEventListener('click', () => { bi.value = bi.dataset.max; relabel(); });
  }`;

export const DESIGN = [800, 400] as const;
export const FELT = [955, 512] as const;
export const SEAT_INSET = [77.5, 16.7] as const;
export const OVAL = [162, 107, 476, 186] as const;
export const POT_PILL = [340, 124, 120, 21] as const;
export const BOARD_BOX = [251, 176] as const;
export const SEAT_BOX = [114, 100] as const;
export const HEADER_H = 26;
export const CARD_ASPECT = 100 / 150;

/** A coordinate as Python wrote it in the source: ints print as ints, float literals as floats. */
type Num = { v: number; float: boolean };
const I = (v: number): Num => ({ v, float: false });
const Fl = (v: number): Num => ({ v, float: true });
const ns = (n: Num) => (n.float ? pf(n.v) : String(n.v));

export const SEAT_MAPS: Record<number, [number, number][]> = {
  3: [[343, 290], [63, 236], [623, 236]],
  6: [[343, 290], [63, 236], [63, 66], [343, 14], [623, 66], [623, 236]],
  9: [[343, 290], [183, 279], [45, 210], [51, 66], [234, 8], [452, 8], [636, 66], [641, 210], [502, 279]],
};
const CHIPS: Record<number, [Num, Num][]> = {
  6: [[Fl(34.7), I(-10)], [I(96), I(25)], [I(118), I(93)], [I(-66), I(100)], [Fl(-48.6), I(93)], [Fl(-26.6), I(25)]],
  9: [[Fl(34.7), I(-10)], [Fl(34.7), I(5)], [I(96), I(25)], [I(118), I(93)], [Fl(34.7), I(109)],
      [Fl(34.7), I(109)], [Fl(-48.6), I(93)], [Fl(-26.6), I(25)], [Fl(34.7), I(5)]],
};
CHIPS[3] = [CHIPS[6]![0]!, CHIPS[6]![1]!, CHIPS[6]![5]!];
const PILL = { x: 0, y: 58, w: 114, h: 28, radius: 50 };
const BADGE = { d: 24, x: 3 };
const STRIP = { y: 72, h: 29, visible: 15 };
const HOLE = { w: I(36), pitch: 39, x: I(18), y: Fl(7.3) };
const VILLAIN = { w: I(30), pitch: 32, x: I(25), y: Fl(24.3) };
const BOARD_CARD = { w: 51, pitch: 61 };
const ACTION_BAR = { h: 76, btn_w: 132, btn_h: 40, raise_h: 48, gap: 10 };

const FELTS: Record<string, string> = {
  red: "radial-gradient(rgb(204,0,0) 0%, rgb(109,0,0) 80%, rgb(70,2,2) 100%)",
  orange: "radial-gradient(rgb(227,96,3) 0%, rgb(180,74,0) 50%, rgb(106,33,0) 100%)",
  purple: "radial-gradient(rgb(112,55,84) 0%, rgb(93,49,78) 30%, rgb(26,26,51) 90%)",
  teal: "radial-gradient(rgb(30,65,64) 0%, rgb(24,51,52) 62%, rgb(17,38,38) 100%)",
};
const MAIN_POT_PILL = [342.3, 149.4, 111.3, 17.8] as const;

const FELT_NOISE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 52 52'%3E%3Cpath fill='%23000000' fill-opacity='0.04' d='M0 17.83V0h17.83a3 3 0 0 1-5.66 2H5.9A5 5 0 0 1 2 5.9v6.27a3 3 0 0 1-2 5.66zm0 18.34a3 3 0 0 1 2 5.66v6.27A5 5 0 0 1 5.9 52h6.27a3 3 0 0 1 5.66 0H0V36.17zM36.17 52a3 3 0 0 1 5.66 0h6.27a5 5 0 0 1 3.9-3.9v-6.27a3 3 0 0 1 0-5.66V52H36.17zM0 31.93v-9.78a5 5 0 0 1 3.8.72l4.43-4.43a3 3 0 1 1 1.42 1.41L5.2 24.28a5 5 0 0 1 0 5.52l4.44 4.43a3 3 0 1 1-1.42 1.42L3.8 31.2a5 5 0 0 1-3.8.72zm52-14.1a3 3 0 0 1 0-5.66V5.9A5 5 0 0 1 48.1 2h-6.27a3 3 0 0 1-5.66-2H52v17.83zm0 14.1a4.97 4.97 0 0 1-1.72-.72l-4.43 4.44a3 3 0 1 1-1.41-1.42l4.43-4.43a5 5 0 0 1 0-5.52l-4.43-4.43a3 3 0 1 1 1.41-1.41l4.43 4.43c.53-.35 1.12-.6 1.72-.72v9.78zM22.15 0h9.78a5 5 0 0 1-.72 3.8l4.44 4.43a3 3 0 1 1-1.42 1.42L29.8 5.2a5 5 0 0 1-5.52 0l-4.43 4.44a3 3 0 1 1-1.41-1.42l4.43-4.43a5 5 0 0 1-.72-3.8zm0 52c.13-.6.37-1.19.72-1.72l-4.43-4.43a3 3 0 1 1 1.41-1.41l4.43 4.43a5 5 0 0 1 5.52 0l4.43-4.43a3 3 0 1 1 1.42 1.41l-4.44 4.43c.36.53.6 1.12.72 1.72h-9.78zm9.75-24a5 5 0 0 1-3.9 3.9v6.27a3 3 0 1 1-2 0V31.9a5 5 0 0 1-3.9-3.9h-6.27a3 3 0 1 1 0-2h6.27a5 5 0 0 1 3.9-3.9v-6.27a3 3 0 1 1 2 0v6.27a5 5 0 0 1 3.9 3.9h6.27a3 3 0 1 1 0 2H31.9z'%3E%3C/path%3E%3C/svg%3E";

const C = {
  oval: "rgba(255,255,255,0.2)", pill: "#ffffff", pill_folded: "rgba(196,214,217,0.45)", badge: "#00c9b7",
  pot_bg: "rgba(0,0,0,0.25)", chip_bg: "rgba(0,0,0,0.3)", strip: "#00c9b7", strip_fold: "rgba(0,0,0,0.45)", text: "#0b1516",
};

const MIME: Record<string, string> = {
  ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".html": "text/html",
};

/** One file from the replica's asset library, path-checked (only files that really sit under assets/). */
export function asset(rel: string): [Uint8Array, string] | null {
  try {
    const base = realpathSync(paths().assets);
    const p = resolve(base, rel);
    if (!p.startsWith(base) || !existsSync(p) || !statSync(p).isFile()) return null;
    return [new Uint8Array(readFileSync(p)), MIME[extname(p).toLowerCase()] || "application/octet-stream"];
  } catch {
    return null;
  }
}

/** "Tc" -> "10♣" — the wrapper's internal display form. */
export function displayCard(code: string): string {
  const c = code.trim();
  const r = c[0]!.toUpperCase() === "T" || c.startsWith("10") ? "10" : c[0]!.toUpperCase();
  const last = c[c.length - 1]!;
  const s = GLYPH[last.toLowerCase()] ?? last;
  return r + s;
}

/** "Ah" -> 26, the client's own id (suit*13 + rank, ace low). Throws where Python raises ValueError. */
export function encodeCard(code: string): number {
  const c = code.trim().split("10").join("T");
  const r = RANKS.indexOf(c[0]!.toUpperCase());
  if (r < 0) throw new Error("substring not found");
  const last = c[c.length - 1]!;
  const suit = GLYPH_TO_SUIT[last] ?? last.toLowerCase();
  const si = SUITS.indexOf(suit);
  if (si < 0 || suit === "") throw new Error("substring not found");
  return si * 13 + r;
}

function art(code: string, kind: string): string {
  const c = code.trim().split("10").join("T");
  const last = c[c.length - 1]!;
  const suit = GLYPH_TO_SUIT[last] ?? last.toLowerCase();
  return `/faketable/assets/cards/${kind}/${c[0]!.toUpperCase()}${suit}.png`;
}

function card(code: string, w: number, kind: string): string {
  const h = w / CARD_ASPECT;
  const n = encodeCard(code);
  return `<svg data-qa='card${n}' width='${fmtFixed(w, 1)}' height='${fmtFixed(h, 1)}' `
    + `viewBox='0 0 100 150' style='display:block;border-radius:${fmtFixed(w * 0.09, 1)}px;`
    + `box-shadow:0 1px 3px rgba(0,0,0,.55);background:#fff'>`
    + `<image href='${art(code, kind)}' width='100' height='150' `
    + `preserveAspectRatio='none'/></svg>`;
}

function back(w: number): string {
  const h = w / CARD_ASPECT;
  return `<svg data-qa='card-1' width='${fmtFixed(w, 1)}' height='${fmtFixed(h, 1)}' `
    + `viewBox='0 0 100 150' style='display:block;border-radius:${fmtFixed(w * 0.09, 1)}px;`
    + `box-shadow:0 1px 3px rgba(0,0,0,.55)'>`
    + `<image href='/faketable/assets/ign/card-back.svg' width='100' height='150' `
    + `preserveAspectRatio='none'/></svg>`;
}

export function bbText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return `${fmtG(pyFloat(v as any))} BB`;
}

const truthy = (v: unknown) => !(v === null || v === undefined || v === false || v === 0 || v === "" ||
  (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length));

/** One playerContainer-N, laid out exactly as the replica lays out a seat. */
function seat(num: number, slot: number, s: Record<string, any>, isHero: boolean, cap: number, heroCards: string[],
              dealer: boolean, acting: boolean): string {
  const [ox, oy] = SEAT_MAPS[cap]![slot]!;
  const idx = num - 1;
  const box = `position:absolute;left:${ox}px;top:${oy}px;width:${SEAT_BOX[0]}px;height:${SEAT_BOX[1]}px`;

  if (s.empty) {
    return `<div data-qa='playerContainer-${idx}' style='${box};display:flex;`
      + `flex-direction:column;align-items:center;justify-content:center;gap:5px;`
      + `color:rgba(255,255,255,.55)'>`
      + `<div data-qa='player-empty-seat-panel' style='display:flex;flex-direction:column;`
      + `align-items:center;gap:5px'>`
      + `<div style='width:32px;height:32px;border-radius:50%;`
      + `border:1.5px solid rgba(255,255,255,.5);display:flex;align-items:center;`
      + `justify-content:center'>`
      + `<svg width='17' height='17' viewBox='0 0 24 24'>`
      + `<circle cx='12' cy='8.2' r='3.6' fill='currentColor'/>`
      + `<path d='M4.6 20c0-4 3.3-6.2 7.4-6.2S19.4 16 19.4 20Z' fill='currentColor'/>`
      + `</svg></div>`
      + `<div data-qa='player-empty-seat-label' style='font-size:9px;text-align:center;`
      + `line-height:1.2'>Vacant<br>seat</div></div></div>`;
  }

  const folded = !truthy(s.cards);
  const cw = isHero ? HOLE : VILLAIN;
  let cardsHtml = "";
  if (isHero && heroCards.length && !folded) {
    const wantN = pyInt(truthy(s.cards) ? s.cards : heroCards.length);
    for (let i = 0; i < wantN; i++) {
      cardsHtml += `<div data-qa='holeCards' style='position:absolute;left:${i * cw.pitch}px;top:0'>`
        + (i < heroCards.length ? card(heroCards[i]!, cw.w.v, "hole") : back(cw.w.v)) + "</div>";
    }
  } else if (!folded) {
    const n = pyInt(truthy(s.cards) ? s.cards : 2);
    for (let i = 0; i < n; i++) {
      cardsHtml += `<div data-qa='holeCards' style='position:absolute;left:${i * cw.pitch}px;top:0'>${back(cw.w.v)}</div>`;
    }
  }
  const cardsBlock = cardsHtml
    ? `<div style='position:absolute;left:${ns(cw.x)}px;top:${ns(cw.y)}px;opacity:${folded ? "0.4" : "1"}'>${cardsHtml}</div>`
    : "";

  let badge: any = s.badge;
  if (truthy(badge)) badge = String(badge).replace(/^POST-(SB|BB)$/, "POST $1");
  let strip = "";
  if (truthy(badge)) {
    strip = `<div style='position:absolute;left:${PILL.x}px;top:${STRIP.y}px;`
      + `width:${PILL.w}px;height:${STRIP.h}px;`
      + `background:${folded ? C.strip_fold : C.strip};`
      + `border-radius:4px 4px 6px 6px;color:#fff;font-size:12px;font-weight:700;`
      + `letter-spacing:.3px;display:flex;align-items:center;justify-content:center;`
      + `padding-top:${STRIP.h - STRIP.visible}px'>${htmlEscape(String(badge))}</div>`;
  }
  const statusWord = truthy(s.sittingOut) ? "SITTING OUT" : truthy(s.waitingForBB) ? "Waiting for big blind" : null;
  if (statusWord) {
    strip += `<div style='position:absolute;left:${PILL.x}px;top:${PILL.y + PILL.h + 2}px;`
      + `width:${PILL.w}px;text-align:center;color:#fff;font-size:11px;font-weight:700;`
      + `letter-spacing:.3px;z-index:3'>${htmlEscape(statusWord)}</div>`;
  }

  const bet = s.bet;
  const live = bet !== null && bet !== undefined && bet !== 0;
  const ink = live ? "" : "background:transparent;color:transparent;";
  const imgInk = live ? "" : "visibility:hidden;";
  const [bx, by] = CHIPS[cap]![slot]!;
  const chips = `<div style='position:absolute;left:${ns(bx)}px;top:${ns(by)}px;height:15px;`
    + `display:flex;align-items:center;gap:3px'>`
    + `<span style='background:${C.chip_bg};border-radius:9999px;padding:0 6px;`
    + `color:#fff;font-size:12px;line-height:15px;white-space:nowrap;${ink}'>`
    + `${bbText(bet !== null && bet !== undefined ? bet : 0)}</span>`
    + `<img src='/faketable/assets/ign/chip-icon.svg' style='width:14px;height:15px;`
    + `display:block;${imgInk}'></div>`;

  let halo = "";
  if (acting) {
    halo = `<div style='position:absolute;left:${pf(SEAT_BOX[0] / 2)}px;`
      + `top:${pf(PILL.y + PILL.h / 2)}px;width:160px;height:160px;`
      + `transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;`
      + `background:radial-gradient(circle,rgba(255,255,255,.13) 38%,`
      + `rgba(255,255,255,.05) 58%,transparent 68%)'></div>`;
  }

  const timer = s.timer;
  let timerHtml = "";
  if (acting && timer !== null && timer !== undefined) {
    const tTop = truthy(badge) ? STRIP.y + STRIP.h : PILL.y + PILL.h;
    const frac = Math.max(0.0, Math.min(1.0, pyFloat(timer) / 30));
    timerHtml = `<div style='position:absolute;left:${PILL.x}px;top:${tTop}px;`
      + `width:${PILL.w}px;height:11px;background:rgba(0,0,0,.55);`
      + `border-radius:0 0 6px 6px;display:flex;align-items:center;gap:4px;`
      + `padding:0 5px;box-sizing:border-box'>`
      + `<span style='color:#fff;font-size:8px;font-weight:700'>${Math.trunc(pyFloat(timer))}</span>`
      + `<span style='flex:1;height:4px;border-radius:2px;`
      + `background:rgba(255,255,255,.25);overflow:hidden'>`
      + `<span style='display:block;height:100%;width:${fmtFixed(frac * 100, 0)}%;`
      + `background:#efc144'></span></span></div>`;
  }

  let dealerBtn = "";
  if (dealer) {
    const dx = ox > 400 ? -8 : SEAT_BOX[0] - 8;
    dealerBtn = `<div style='position:absolute;left:${dx}px;top:${PILL.y - 6}px;width:17px;`
      + `height:17px;border-radius:50%;background:#e6e6e6;`
      + `border:.5px solid rgba(0,0,0,.3);display:flex;align-items:center;`
      + `justify-content:center;z-index:3'>`
      + `<img src='/faketable/assets/ign/dealer-d.svg' style='width:10px;height:10px;`
      + `display:block'></div>`;
  }

  const tagOpen = isHero ? "<div data-qa='myPlayerTag' style='display:contents'>" : "<div style='display:contents'>";
  const pill = `${tagOpen}`
    + `<div style='position:absolute;left:${PILL.x}px;top:${PILL.y}px;`
    + `width:${PILL.w}px;height:${PILL.h}px;border-radius:${PILL.radius}px;`
    + `background:${folded ? C.pill_folded : C.pill};`
    + `box-shadow:0 1px 10px 4px rgba(0,0,0,.5);display:flex;align-items:center;`
    + `z-index:2'>`
    + `<span style='width:${BADGE.d}px;height:${BADGE.d}px;margin-left:${BADGE.x}px;`
    + `flex:0 0 auto;border-radius:50%;`
    + `background:${folded ? "rgba(0,201,183,.5)" : C.badge};color:#fff;`
    + `font-size:12px;font-weight:700;display:flex;align-items:center;`
    + `justify-content:center'>${num}</span>`
    + `<span data-qa='playerBalance' style='flex:1;text-align:center;padding-right:6px;`
    + `font-size:16px;font-weight:700;color:${C.text};`
    + `opacity:${folded ? "0.7" : "1"}'>${bbText(s.stack)}</span>`
    + `</div></div>`;

  return `<div data-qa='playerContainer-${idx}' style='${box}'>`
    + `${halo}${chips}${cardsBlock}${strip}${timerHtml}${pill}${dealerBtn}</div>`;
}

function button(qa: string, label: string, kind = "action"): string {
  const h = qa === "raiseButton" ? ACTION_BAR.raise_h : ACTION_BAR.btn_h;
  const bg = qa === "raiseButton" ? "rgba(0,0,0,0.3)" : kind === "preset" ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.55)";
  const fs = kind === "preset" ? 10 : 14;
  const w = kind === "preset" ? pf(97.8) : String(ACTION_BAR.btn_w);
  return `<button data-qa='${qa}' style='width:${w}px;height:${h}px;border:0;`
    + `border-radius:8px;background:${bg};color:#fff;font:inherit;font-size:${fs}px;`
    + `font-weight:600;cursor:pointer;white-space:pre-line'>`
    + `${htmlEscape(label)}</button>`;
}

const get = (o: any, k: string) => (o && typeof o === "object" ? o[k] : undefined);

export function renderInner(spec: Record<string, any>): string {
  const rawCap = pyInt(spec.capacity ?? 6);
  const cap = rawCap <= 3 ? 3 : rawCap > 6 ? 9 : 6;
  const hero = pyInt(truthy(spec.heroSeat) ? spec.heroSeat : 1);
  const dealer = spec.dealerSeat ?? null;
  const seatsIn = spec.seats || {};
  const toAct = (spec.node || {}).toActSeat ?? null;
  const heroCards: string[] = [...(spec.heroCards || [])];

  const order: number[] = [];
  for (let i = 0; i < cap; i++) order.push((((hero - 1 + i) % cap) + cap) % cap + 1);
  const seatHtml = order.map((num, slot) => {
    const s = (truthy(get(seatsIn, String(num))) ? get(seatsIn, String(num)) : null) || { empty: true };
    return seat(num, slot, s, num === hero, cap, heroCards, num === dealer, num === toAct);
  }).join("");

  const board: string[] = spec.board || [];
  const [bx, by] = BOARD_BOX;
  const phH = BOARD_CARD.w * 199 / 134;
  let boardHtml = board.map((c, i) => `<div style='position:absolute;left:${i * BOARD_CARD.pitch}px;top:0'>`
    + `${card(c, BOARD_CARD.w, "board")}</div>`).join("");
  for (let i = board.length; i < 5; i++) {
    boardHtml += `<div style='position:absolute;left:${i * BOARD_CARD.pitch}px;top:0'>`
      + `<svg data-qa='card-placeholder' width='${BOARD_CARD.w}' height='${fmtFixed(phH, 1)}' `
      + `viewBox='0 0 134 199' style='display:block'>`
      + `<rect x='2' y='2' width='130' height='195' rx='8' fill='none' `
      + `stroke='rgba(255,255,255,0.12)' stroke-width='2'/></svg></div>`;
  }

  const offer = spec.offer || {};
  const has = (k: string) => offer[k] !== null && offer[k] !== undefined;
  const strip: string[] = [];
  if (truthy(offer.fold)) strip.push(button("foldButton", "FOLD"));
  if (truthy(offer.check)) strip.push(button("checkButton", "CHECK"));
  if (has("call")) strip.push(button("callButton", `CALL ${bbText(offer.call)}`));
  if (has("bet")) strip.push(button("betButton", `BET ${bbText(offer.bet)}`));
  if (has("raise")) strip.push(button("raiseButton", `RAISE TO ${bbText(offer.raise)}`));
  if (has("raise") && ("allInChip" in offer ? truthy(offer.allInChip) : true)) {
    strip[strip.length - 1] = `<div style='display:flex;flex-direction:column;align-items:center;gap:4px'>`
      + `${strip[strip.length - 1]}`
      + `<div style='width:97.8px;height:24px;border-radius:8px;`
      + `background:rgba(255,255,255,.25);color:#fff;font-size:10px;font-weight:700;`
      + `display:flex;align-items:center;justify-content:center'>ALL-IN</div></div>`;
  }
  const wager = has("raise") ? offer.raise : offer.bet;
  if (wager !== null && wager !== undefined) {
    const lo = pyFloat(wager);
    const hi = pyFloat(truthy(offer.max) ? offer.max : 10_000);
    strip.push(`<input data-qa='betInput' type='text' value='${fmtG(lo)}' `
      + `data-min='${fmtG(lo)}' data-max='${fmtG(hi)}' `
      + `style='width:${ACTION_BAR.btn_w}px;height:${ACTION_BAR.btn_h}px;border:0;`
      + `border-radius:8px;background:rgba(0,0,0,0.55);color:#fff;font:inherit;`
      + `font-size:14px;font-weight:600;text-align:center'>`);
  }
  const selQa: Record<string, string> = {
    "X2.5": "x2.5Selector", X3: "x3Selector", X4: "x4Selector", Pot: "potSelector",
    "1/3 Pot": "third_potSelector", "3/4 Pot": "threeQuarter_potSelector", "ALL-IN": "allInSelector",
  };
  const presets = ((offer.selectors || []) as string[]).map((s) => button(selQa[s] ?? `${s}Selector`, s, "preset"));

  const title = htmlEscape(spec.title || "$1/$2 No Limit Hold'em");
  const pot = bbText(spec.potBB);
  const r = offer.betFieldResets;
  const resetTo = r === null || r === undefined ? "null" : fmtG(pyFloat(r));
  const [fw, fh] = FELT;
  const actionRowH = has("raise") ? ACTION_BAR.raise_h + 28 : ACTION_BAR.btn_h + 8;
  const barH = strip.length || presets.length ? actionRowH + (presets.length ? 44 : 0) + 16 : 0;
  const totalH = fh + HEADER_H + barH;
  const [ix, iy] = SEAT_INSET;
  const [ox_, oy_, ow, oh] = OVAL;
  const [px, py, pw, ph] = POT_PILL;
  const feltBg = FELTS[spec.theme || "red"] ?? FELTS.red!;

  const potHtml = pot
    ? `<div style='position:absolute;left:${px}px;top:${py}px;width:${pw}px;`
      + `height:${ph}px;border-radius:9999px;background:${C.pot_bg};color:#fff;`
      + `font-size:13px;display:flex;align-items:center;justify-content:center'>`
      + `Total pot:&nbsp;<b>${pot}</b></div>`
    : "";
  const [mx, my, mw, mh] = MAIN_POT_PILL;
  const mainPot = bbText(spec.mainPotBB);
  const mainPotHtml = mainPot
    ? `<div style='position:absolute;left:${pf(mx)}px;top:${pf(my)}px;width:${pf(mw)}px;`
      + `height:${pf(mh)}px;border-radius:9999px;background:${C.pot_bg};`
      + `color:rgba(255,255,255,.85);font-size:12px;display:flex;align-items:center;`
      + `justify-content:center'>Main pot:&nbsp;<b>${mainPot}</b></div>`
    : "";
  const strength = spec.handStrength;
  const strengthHtml = truthy(strength)
    ? `<div style='position:absolute;left:24px;top:${fh + HEADER_H + 22}px;`
      + `color:#e8eded;font-size:14px;z-index:4'>${htmlEscape(String(strength))}</div>`
    : "";

  const modal = spec.modal || {};
  const modalHtml = truthy(modal.text)
    ? `<div data-qa='modal' style='position:absolute;left:${pf(ix + DESIGN[0] / 2 - 210)}px;`
      + `top:${pf(HEADER_H + iy + DESIGN[1] / 2 - 40)}px;width:420px;padding:22px 24px 18px;`
      + `background:#120607;border-radius:6px;color:#fff;font-size:15px;text-align:center;`
      + `z-index:50;box-shadow:0 4px 30px rgba(0,0,0,.6)'>`
      + `<div style='margin-bottom:18px'>${htmlEscape(String(modal.text || ""))}</div>`
      + `<button data-qa='modal.action.ok' style='width:100%;height:40px;border:0;border-radius:4px;`
      + `background:#fff;color:#111;font:inherit;font-weight:700;cursor:pointer'>`
      + `${htmlEscape(String(modal.ok || "OK"))}</button></div>`
    : "";

  return `<!doctype html><html><head><meta charset=utf-8>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  html,body { margin:0; background:#0b1416; overflow:hidden; }
  #felt { position:relative; width:${fw}px; height:${totalH}px;
           background:${feltBg}; font-family:Roboto,system-ui,sans-serif;
           user-select:none; }
  /* The client's own noise tile (.fs9k49k) — the data URI holds single
     quotes, hence a stylesheet rule rather than an inline style attr. */
  #noise { position:absolute; inset:0; pointer-events:none;
            background-image:url("${FELT_NOISE}"); }
</style></head><body>
<div id='felt'>
  <div id='noise'></div>
  <div style='position:absolute;left:${pf(ix)}px;top:${pf(HEADER_H + iy)}px;width:${DESIGN[0]}px;
       height:${DESIGN[1]}px;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:6px;opacity:.12;pointer-events:none'>
    <img src='/faketable/assets/ign/watermark-flame.svg' style='width:38px'>
    <img src='/faketable/assets/ign/watermark-text.svg' style='width:90px'>
  </div>
  <div style='position:absolute;left:0;right:0;top:0;height:${HEADER_H}px;
       background:rgba(0,0,0,.45);display:flex;align-items:center;padding:0 10px;gap:8px;
       color:rgba(255,255,255,.9);font-size:12px'>
    <span style='opacity:.6'>&#9432;</span><span>${title}</span>
    <span style='margin-left:auto;opacity:.6'>&#10005;</span>
  </div>
  <div data-qa='table' style='position:absolute;left:${pf(ix)}px;top:${pf(HEADER_H + iy)}px;
       width:${DESIGN[0]}px;height:${DESIGN[1]}px'>
    <div style='position:absolute;left:${ox_}px;top:${oy_}px;width:${ow}px;height:${oh}px;
         border-radius:9999px;border:2px solid ${C.oval};box-sizing:border-box'></div>
    ${potHtml}
    ${mainPotHtml}
    <div style='position:absolute;left:${bx}px;top:${by}px'>${boardHtml}</div>
    ${seatHtml}
  </div>
  ${strengthHtml}
  ${modalHtml}
  <div style='position:absolute;left:0;right:0;top:${fh + HEADER_H}px;
       height:${barH}px;background:rgba(0,0,0,.35);display:flex;
       flex-direction:column;align-items:center;justify-content:center;gap:6px'>
    <div style='display:flex;gap:6px'>${presets.join("")}</div>
    <div style='display:flex;align-items:flex-start;gap:${ACTION_BAR.gap}px'>
      ${strip.join("")}
    </div>
  </div>
</div>
<script>
  // Scale to the window the way the client does — CSS zoom, so descendants
  // keep laying out in design units and the reader's geometry stays readable.
  const fit = () => { document.getElementById('felt').style.zoom =
      Math.min(1, window.innerWidth / ${fw}); };
  fit(); window.addEventListener('resize', fit);
  // Echo every button click so the relay test can assert what actually fired.
  // Recorded on BOTH windows: the buttons live in this frame, but the CDP
  // page target the reader drives is the top document.
  // THE CLIENT TAKING THE TYPED SIZE BACK AS THE CLICK LANDS (offer.betFieldResets).
  // Ignition re-renders the action strip on its own state ticks; on 2026-09-19 hand
  // 4919212912 that landed between raise_to's readback (10.5, correct) and the RAISE
  // click, so the confirmed size was the 4 bb minimum. Modelled on mousedown because
  // that is deterministic — the real race is not, and a test of a race is a flake.
  const RESET_TO = ${resetTo};
  if (RESET_TO !== null) {
    document.querySelectorAll("button[data-qa$='Button']").forEach(b =>
      b.addEventListener('mousedown', () => {
        const bi2 = document.querySelector("input[data-qa='betInput']");
        if (bi2) bi2.value = String(RESET_TO);
      }, true));
  }
  document.querySelectorAll('button[data-qa]').forEach(b => b.addEventListener('click', () => {
    const inp = document.querySelector("input[data-qa='betInput']");
    const hit = { qa: b.getAttribute('data-qa'), text: b.innerText, t: Date.now(),
                  // what the bet field held when the button was pressed — the
                  // relay test asserts the typed size reached the client
                  betValue: inp ? inp.value : null };
    window.__lastClick = hit;
    try { window.parent.__lastClick = hit; } catch (e) {}
  }));
  // The client's clamp: a typed amount outside [min, max] is pulled back to
  // the bound. insertText fires 'input'; clamp there so a readback sees it.
  const bi = document.querySelector("input[data-qa='betInput']");
  if (bi) bi.addEventListener('input', () => {
    const v = parseFloat(bi.value), lo = parseFloat(bi.dataset.min), hi = parseFloat(bi.dataset.max);
    if (!isNaN(v) && v < lo) bi.value = String(lo);
    else if (!isNaN(v) && v > hi) bi.value = String(hi);
  });${CONFIRM_RELABEL_JS}
</script>
</body></html>`;
}

/** The top page: one iframe per table, each carrying `playMode` and `data-multitableslot` — the real client's shape. */
export function renderOuter(frameUrl: string, tables = 1): string {
  const n = [1, 2, 4].includes(tables) ? tables : 1;
  if (n === 1) {
    return `<!doctype html><html><head><meta charset=utf-8>
<title>Fake Ignition Table (test)</title>
<style>html,body{margin:0;height:100%;background:#0b1416}
iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body>
<iframe src="${htmlEscape(frameUrl)}"></iframe>
</body></html>`;
  }
  const cols = 2, rows = n === 2 ? 1 : 2;
  let cells = "";
  for (let i = 0; i < n; i++) {
    cells += `<iframe title="Table slot" data-multitableslot="${i}" `
      + `src="${htmlEscape(frameUrl)}${frameUrl.includes("?") ? "&" : "?"}slot=${i}"></iframe>`;
  }
  return `<!doctype html><html><head><meta charset=utf-8>
<title>Fake Ignition Table (test)</title>
<style>html,body{margin:0;height:100%;background:#0b1416}
.wrap{display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);
       width:100%;height:100vh;gap:2px}
iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body>
<div class="wrap">${cells}</div>
</body></html>`;
}

export const EXAMPLE_SPEC: Record<string, any> = {
  title: "$1/$2 No Limit Hold'em",
  capacity: 6,
  potBB: 24.8,
  board: ["Tc", "5s", "5h"],
  heroSeat: 4,
  dealerSeat: 1,
  heroCards: ["Th", "Td"],
  seats: {
    "1": { stack: 98.6, bet: 24.8, badge: "BET", cards: 2 },
    "2": { stack: 140.4, cards: 0 },
    "3": { stack: 54.6, cards: 0 },
    "4": { stack: 97.2, cards: 2 },
    "5": { stack: 100, cards: 0 },
    "6": { stack: 84.2, cards: 0 },
  },
  offer: { fold: true, call: 24.8, raise: 60, selectors: ["Pot", "ALL-IN"] },
  node: { toActSeat: 4 },
};

