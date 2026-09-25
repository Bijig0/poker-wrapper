/**
 * Reading the Ignition client's DOM — the parts of launch.py that turn one `_TABLE_JS` capture into facts:
 * the board, hero's cards, the action strip, each seat, a client notice. Pure over the capture, except
 * heroStatus, which weighs the capture against what the WebSocket said.
 *
 * `d` is exactly what the in-page reader returned (launch.TABLE_JS_TMPL.js): {seated, practice, frame, nodes,
 * buttons, cards, allCards, heroMini, seatQa, ...}. Seats are Maps keyed by the DISPLAYED seat number, in the
 * order the capture lists them (the Python dicts' insertion order).
 */
import { js } from "../js";
import { fmtFixed, KeyError, maxBy, minBy, pyFloat, pyInt, pyRound, splitWs } from "../py";
import { S } from "../state";
import * as TABLES from "../tables";

export type Node = { text: string; x: number; y: number; w: number; h: number; [k: string]: any };
export type Seat = Record<string, any>;

/** Python's len() of a str (code points, not UTF-16 units). */
export const plen = (s: string) => [...s].length;

// ---- the page snippets, aimed at one table --------------------------------------------------------------
export const FRAME_JS = () => js("launch.FRAME_JS");
export const EXTRACT_DEEP_JS = () => js("launch.EXTRACT_DEEP_JS");
export const TABLE_JS_TMPL = () => js("launch.TABLE_JS_TMPL");
export const WATCH_JS_TMPL = () => js("launch.WATCH_JS_TMPL");
export const SITOUT_READ_JS_TMPL = () => js("launch.SITOUT_READ_JS_TMPL");
export const FIND_INPUT_JS_TMPL = () => js("launch.FIND_INPUT_JS_TMPL");
export const TOPUP_READ_JS_TMPL = () => js("launch.TOPUP_READ_JS_TMPL");
export const TOPUP_FILL_JS_TMPL = () => js("launch.TOPUP_FILL_JS_TMPL");

/** A table-reading snippet aimed at one slot: `__frame(__SLOT__)` resolves to that table's iframe, or to the
 *  single-table one when slot is null. */
export function slotted(code: string, slot: number | null): string {
  return code.split("__FRAME__").join(FRAME_JS()).split("__SLOT__").join(slot === null || slot === undefined ? "null" : String(Math.trunc(slot)));
}

export const tableJs = (slot: number | null = null) => slotted(TABLE_JS_TMPL(), slot);
export const watchJs = (slot: number | null = null) => slotted(WATCH_JS_TMPL(), slot);
export const findInputJs = (slot: number | null = null) => slotted(FIND_INPUT_JS_TMPL(), slot);
export const topupReadJs = (slot: number | null = null) => slotted(TOPUP_READ_JS_TMPL(), slot);
export const topupFillJs = (slot: number | null = null) => slotted(TOPUP_FILL_JS_TMPL(), slot);
export const sitoutReadJs = (slot: number | null = null) => slotted(SITOUT_READ_JS_TMPL(), slot);

/** The elementFromPoint probe _point_is_my_table sends ("%f" = six decimals). */
export function pointProbeJs(x: number, y: number): string {
  return ("(() => { const e = document.elementFromPoint(" + fmtFixed(x, 6) + ", " + fmtFixed(y, 6) + ");"
          + " if (!e) return 'nothing is at that point — it is off the page';"
          + " const f = e.closest ? e.closest('iframe[data-multitableslot]') : null;"
          + " const own = (e.getAttribute && e.getAttribute('data-multitableslot'))"
          + "   || (f && f.getAttribute('data-multitableslot'));"
          + " return own === null || own === undefined ? 'unknown' : String(own); })()");
}

// ---- cards ----------------------------------------------------------------------------------------------
// data-qa="card<N>": N = suit*13 + rank, suits alphabetical ♣♦♥♠, ranks A,2,…,10,J,Q,K.
const SUITS = "♣♦♥♠";
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function cardName(qa: unknown): string | null {
  const m = /^card(\d{1,2})$/.exec(typeof qa === "string" ? qa : qa ? String(qa) : "");
  if (!m) return null;
  const i = Number(m[1]);
  if (!(i >= 0 && i <= 51)) return null;
  return RANKS[i % 13]! + SUITS[Math.floor(i / 13)]!;
}

/** f"card{c}" for a WS card code (ints on the wire). */
export const wireCard = (c: unknown) => cardName(`card${c}`);

/** Identified community cards, left to right (STRUCTURAL when the capture has seat ownership, else the
 *  geometric band — kept only for captures without the structural fields). */
export function boardCards(d: Record<string, any>): string[] {
  const ac: any[] = d.allCards || [];
  if (ac.some((c) => c && typeof c === "object" && "seat" in c)) {
    const seen = new Map<string, any>();
    for (const c of ac) {
      if (c.tbl && (c.seat === null || c.seat === undefined) && cardName(c.qa)) {
        if (!seen.has(c.qa)) seen.set(c.qa, c);
      }
    }
    const row = [...seen.values()].sort((a, b) => a.x - b.x);
    return row.map((c) => cardName(c.qa)!);
  }
  const cs = (d.cards ?? []).filter((c: any) => cardName(c.qa));
  if (!cs.length) return [];
  // Counter(round(y / 12)).most_common(1): the most frequent row, the first seen on a tie
  const counts = new Map<number, number>();
  for (const c of cs) {
    const k = pyRound(c.y / 12);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let ymode = 0;
  let best = -1;
  for (const [k, n] of counts) if (n > best) { best = n; ymode = k; }
  const row = cs.filter((c: any) => Math.abs(c.y / 12 - ymode) < 1.01).sort((a: any, b: any) => a.x - b.x);
  const out: any[] = [];
  for (const c of row) {
    if (out.length && c.x - out[out.length - 1].x < 20) continue;
    out.push(c);
  }
  // A real board is only ever 3/4/5 cards
  return out.length >= 3 ? out.map((c) => cardName(c.qa)!) : [];
}

/** int() of a DOM value, or throws (ValueError / TypeError) the way Python's int() does. */
function toInt(v: unknown): number {
  return pyInt(v);
}

/** Hero's seat NUMBER at our own table, as the client tags it (myPlayerTag) — the displayed `num`, never the
 *  0-based container index. null = not seen yet (never "seat 1"). */
export function domHeroSeat(d: Record<string, any>): number | null {
  const me = (d.seatQa || []).find((sq: any) => sq && sq.me);
  try {
    return me && me.num !== null && me.num !== undefined ? toInt(me.num) : null;
  } catch {
    return null;
  }
}

/** Hero's hole cards: the cards owned by the playerContainer carrying myPlayerTag; the tab-strip minis only
 *  on a single table (they are read outside every table frame, so with slots they may be another table's). */
export function heroCards(d: Record<string, any>): string[] {
  const ac: any[] = d.allCards || [];
  const meQa = (d.seatQa || []).find((s: any) => s && s.me);
  const me = meQa ? meQa.seat ?? null : null;
  if (me !== null && me !== undefined && ac.some((c) => c && typeof c === "object" && "seat" in c)) {
    const seen = new Map<string, any>();
    for (const c of ac) {
      if (c.seat === me && cardName(c.qa)) {
        if (!seen.has(c.qa)) seen.set(c.qa, c);
      }
    }
    const row = [...seen.values()].sort((a, b) => a.x - b.x);
    if (row.length) return row.map((c) => cardName(c.qa)!).slice(0, 2);
  }
  if (TABLES.slot() !== null) return [];
  const minis = [...(d.heroMini ?? [])].sort((a: any, b: any) => a.x - b.x);
  const out: any[] = [];
  for (const c of minis) {
    if (out.length && c.x - out[out.length - 1].x < 8) continue;
    out.push(c);
  }
  return out.map((c) => cardName(c.qa)).filter((n): n is string => !!n).slice(0, 2);
}

// ---- the action strip -----------------------------------------------------------------------------------
export const ACTION_RE = /^(fold|check|call|raise|bet|all[ -]?in)\b/i;
const ACTION_QA = /^(fold|check|call|bet|raise|allIn)Button$/i;
const PRESET_QA = /Selector$/;

/** Split the bottom strip's buttons into (turn actions, sizing presets) — by the client's own data-qa when the
 *  buttons carry it, else by the row geometry. */
export function splitStrip(d: Record<string, any>): [any[], any[]] {
  const tagged = (d.buttons ?? []).filter((b: any) => b.qa);
  if (tagged.length) {
    const actions: any[] = [];
    const presets: any[] = [];
    for (const b of tagged) {
      if (ACTION_QA.test(b.qa)) actions.push(b);
      else if (PRESET_QA.test(b.qa)) presets.push(b);
    }
    const seen = new Map<string, any>();
    for (const a of actions) {
      const k = String(a.text).toLowerCase();
      if (!seen.has(k)) seen.set(k, a);
    }
    return [[...seen.values()], presets];
  }
  if (!("frame" in d)) throw new KeyError("'frame'");
  const fr = d.frame;
  const bottom = fr.y + fr.h * 0.72;
  const strip = (d.buttons ?? []).filter((b: any) => b.y + b.h / 2 >= bottom);
  const marker = strip.filter((b: any) => /^(x[\d.,]+|[\d.,]+x|pot|min|max)$/i.test(b.text));
  const presetY = marker.length ? Math.min(...marker.map((b: any) => b.y)) : null;
  const inPresetRow = (b: any) => presetY !== null && Math.abs(b.y - presetY) <= 8;
  const presets = strip.filter((b: any) => inPresetRow(b) && (marker.includes(b) || ACTION_RE.test(b.text)));
  const actions = strip.filter((b: any) => ACTION_RE.test(b.text) && !inPresetRow(b)
                                           && !b.text.includes("%") && !b.text.includes("·"));
  const seen = new Map<string, any>();
  for (const a of actions) {
    const k = String(a.text).toLowerCase();
    if (!seen.has(k)) seen.set(k, a);
  }
  return [[...seen.values()], presets];
}

/** Hero is on the clock: turn buttons, at least one carrying an amount. */
export function toAct(d: Record<string, any>): boolean {
  const [actions] = splitStrip(d);
  return actions.length > 0 && actions.some((a) => /\d/.test(a.text));
}

// ---- seats ----------------------------------------------------------------------------------------------
export const MONEY_RE = /^[\d,]+(?:\.\d+)?(?:\s*BB)?$/;
export const BADGE_RE = /^(FOLD|CHECK|CALL|BET|RAISE|ALL[ -]?IN)$/i;
export const RANK_RE = /high card|(?<!two )pair|two pair|three of a kind|straight flush|straight|flush|full house|four of a kind|royal/i;

/** A DOM money label as a number ("1,234.5 BB" -> 1234.5), or null. */
export function potVal(pot: unknown): number | null {
  if (typeof pot !== "string") return null;
  const parts = splitWs(pot.replace(/,/g, ""));
  if (!parts.length) return null;
  try {
    return pyFloat(parts[0]);
  } catch {
    return null;
  }
}

export function verb(badge: string, bet: string | null): string {
  if (bet !== null && bet !== undefined && potVal(bet) === 0) bet = null;
  const b = badge.toUpperCase();
  if (b === "FOLD") return "folds";
  if (b === "CHECK") return "checks";
  if (b === "CALL") return bet ? `calls ${bet}` : "calls";
  if (b === "RAISE" || b === "BET") return bet ? `${b === "RAISE" ? "raises to" : "bets"} ${bet}` : b.toLowerCase() + "s";
  return bet ? `is ALL-IN (${bet})` : "is ALL-IN";
}

/** Per-seat facts from the client's containment (seatQa), or null if the capture predates it. */
export function seatsStructural(d: Record<string, any>): Map<any, Seat> | null {
  const sq = d.seatQa;
  if (!sq || (Array.isArray(sq) && !sq.length)) return null;
  const out = new Map<any, Seat>();
  for (const s of sq) {
    if (s.empty) continue;
    const num = s.num;
    const stack = s.stack;
    if (num === null || num === undefined || stack === null || stack === undefined) continue;
    let bet = s.bet ?? null;
    if (bet !== null && potVal(bet) === 0) bet = null;
    out.set(num, {
      stack,
      bet,
      badge: s.badge ? String(s.badge).replaceAll(" ", "-") : null,
      cards: s.nHole || 0,
      dealer: !!s.dealer,
      hero: !!s.me,
    });
  }
  return out;
}

/** Per-seat facts: structural when the capture carries seatQa, else the geometric fallback. */
export function parseSeats(d: Record<string, any>): Map<any, Seat> {
  const structural = seatsStructural(d);
  if (structural && structural.size) return structural;
  const fr = d.frame;
  if (!fr || (typeof fr === "object" && !Object.keys(fr).length)) return new Map();
  const stripY = fr.y + fr.h * 0.72;
  const cx = fr.x + fr.w / 2, cy = fr.y + fr.h / 2;
  const nodes: Node[] = (d.nodes ?? []).filter((n: Node) => n.y < stripY);
  const anchors = new Map<number, Node>();
  for (const n of nodes) {
    if (/^[1-9]$/.test(n.text) && n.w <= 16 && n.h <= 20) anchors.set(Number(n.text), n);
  }
  const seats = new Map<number, Seat>();
  for (const num of anchors.keys()) seats.set(num, { stack: null, bet: null, badge: null });
  const money = nodes.filter((n) => MONEY_RE.test(n.text));
  const claimed = new Set<Node>();
  for (const [num, a] of anchors) {
    for (const n of money) {
      if (claimed.has(n)) continue;
      if (Math.abs(n.y - a.y) <= 14 && n.x - a.x > 0 && n.x - a.x <= 110) {
        seats.get(num)!.stack = n.text;
        claimed.add(n);
        break;
      }
    }
  }
  for (const n of money) {
    if (claimed.has(n)) continue;
    let num: number | null = null;
    let dist = 1e9;
    for (const [s, a] of anchors) {
      const dd = Math.pow((n.x - a.x) ** 2 + (n.y - a.y) ** 2, 0.5);
      if (dd < dist) { num = s; dist = dd; }
    }
    if (num === null || dist > 90 || seats.get(num)!.bet !== null) continue;
    const a = anchors.get(num)!;
    const towardCentre = Math.abs(n.x - cx) + Math.abs(n.y - cy) < Math.abs(a.x - cx) + Math.abs(a.y - cy);
    if (towardCentre) seats.get(num)!.bet = n.text;
  }
  for (const [num, a] of anchors) {
    for (const n of nodes) {
      if (BADGE_RE.test(n.text) && Math.abs(n.x - a.x) <= 120 && a.y - n.y >= -60 && a.y - n.y <= 60) {
        seats.get(num)!.badge = n.text.toUpperCase().replaceAll(" ", "-");
      }
    }
  }
  for (const [num, a] of anchors) {
    const ax = a.x - fr.x, ay = a.y - fr.y;
    let n = 0;
    for (const c of d.allCards ?? []) if (Math.abs(c.x - ax) < 90 && Math.abs(c.y - ay) < 90) n++;
    seats.get(num)!.cards = n;
  }
  const out = new Map<any, Seat>();
  for (const [num, s] of seats) if (s.stack !== null) out.set(num, s);
  return out;
}

export const boardCount = (d: Record<string, any>) => boardCards(d).length;

/** "Total pot" -> the nearest node to its right on the same row. */
export function potOf(nodes: Node[]): string | null {
  for (const n of nodes) {
    if (/^total pot/i.test(n.text)) {
      const right = nodes.filter((m) => Math.abs(m.y - n.y) < 10 && m.x > n.x);
      return right.length ? minBy(right, (m) => m.x)!.text : null;
    }
  }
  return null;
}

/** Hero's strength label in the bottom strip ("Two Pair, Kings and Fives"); rank text higher up is history. */
export function heroHandOf(d: Record<string, any>): string | null {
  const fr = d.frame;
  const n = (d.nodes ?? []).find((n: Node) => RANK_RE.test(n.text) && plen(n.text) < 30 && n.y >= fr.y + fr.h * 0.68);
  return n ? n.text : null;
}

// ---- the client's notices -------------------------------------------------------------------------------
const HARMLESS_MODALS: [RegExp, string][] = [
  [/more than the maximum buy.?in amount/i, "buy-in above the table maximum"],
  [/maximum buy.?in/i, "buy-in maximum notice"],
];

/** The client's modal, if one is up: its OK/close button (data-qa modal.action.*) and the notice text. */
export function modalOf(d: Record<string, any>): Record<string, any> | null {
  const btns = (d.buttons ?? []).filter((b: any) => String(b.qa || "").startsWith("modal.action."));
  if (!btns.length) return null;
  const ok = btns.find((b: any) => b.qa.endsWith(".ok") || ["ok", "close", "got it"].includes(String(b.text).trim().toLowerCase())) ?? btns[0];
  const near = (d.nodes ?? []).filter((n: Node) => n.y < ok.y && ok.y - n.y < 260
                                                   && Math.abs((n.x + n.w / 2) - (ok.x + ok.w / 2)) < 320 && plen(n.text) > 12);
  const text = near.length ? maxBy(near, (n: Node) => plen(n.text))!.text : "";
  const hit = HARMLESS_MODALS.find(([pat]) => pat.test(text));
  return { text, button: ok, harmless: hit ? hit[1] : null, buttons: btns.map((b: any) => b.text) };
}

// ---- hero's status --------------------------------------------------------------------------------------
const WAIT_BB = /wait(ing)?\s+(for\s+)?(the\s+)?big blind|waiting for bb/;

/** Why hero isn't acting: sitting out, waiting for the big blind, folded, not in the hand — LEVELS BEFORE
 *  WORDS: the WS deal and hero's own hole cards settle it before any table word does. */
export function heroStatus(d: Record<string, any>, nodes: Node[]): string {
  const txt = nodes.map((n) => n.text).join(" ").toLowerCase();
  const ws = S.ws;
  const hero = ws.heroSeat ?? null;
  const dealt: number[] = ws.dealt || [];
  const heroDealt = hero !== null && dealt.includes(hero);
  const me = (d.seatQa || []).find((s: any) => s && s.me) ?? null;
  const myWords = String((me || {}).status || "").toLowerCase();
  const myCards = pyInt((me || {}).nHole || 0);
  if (!heroDealt && myCards === 0) {
    if (myWords.includes("sitting out") || txt.includes("i am back") || (txt.includes("sitting out") && me === null)) return "sitting-out";
    if (WAIT_BB.test(myWords) || (WAIT_BB.test(txt) && me === null)) return "waiting-for-bb";
    if (me === null && txt.includes("sitting out")) return "sitting-out";
  }
  if (ws.heroFolded) return "folded";
  if (hero !== null && dealt.length && !dealt.includes(hero)) return "not-in-hand";
  if (ws.heroDealt === false && myCards === 0) return "not-in-hand";
  return "in-hand";
}

/** Seconds left on hero's action clock, or null when it is not showing / not readable. The client draws the
 *  countdown as a bare number inside hero's seat box, UNDER the seat label (recording session_20260925_044840:
 *  seat label "3" at y 1378, clock "15" at y 1400 → "0" at y 1416, box y 1287-1427). The seat label is the same
 *  kind of node, so when the two could be confused (only one number in the box and it equals the seat label)
 *  the answer is null rather than a guess. */
export function heroClockOf(d: Record<string, any>, nodes: Node[]): number | null {
  const me = (d.seatQa || []).find((s: any) => s && s.me) ?? null;
  const box = me && me.box;
  if (!box) return null;
  const PAD = 12;
  const inBox = nodes.filter((n) => /^\d{1,2}$/.test(String(n.text).trim())
    && n.x + n.w / 2 >= box.x - PAD && n.x + n.w / 2 <= box.x + box.w + PAD
    && n.y + n.h / 2 >= box.y - PAD && n.y + n.h / 2 <= box.y + box.h + PAD);
  const label = me.num !== null && me.num !== undefined ? String(me.num) : null;
  const byY = [...inBox].sort((a, b) => a.y - b.y);
  const labelAt = label === null ? -1 : byY.findIndex((n) => String(n.text).trim() === label);
  if (labelAt >= 0) byY.splice(labelAt, 1);
  else if (label !== null) return null;   // no seat label found: cannot tell which number is the clock
  if (byY.length !== 1) return null;
  return pyInt(String(byY[0]!.text).trim());
}

/** Hero's time bank over ONE turn: the "+Ns" offer while it is up, and whether the client has STARTED it. */
export type BankSeen = { secs: number; at: number; started: boolean };

/** One tick of the time bank's story (relay.heroTimeLeft). The client starts the bank ITSELF when hero's clock reaches
 *  0 with "+Ns" on offer: the button goes, and a frame later the clock jumps 0 → N (session_20260925_135420 frames
 *  697/698; villains' banks start the same way). So: an offer seen → remembered; the clock jumping back UP → started
 *  (from then on the clock IS the bank); hero off the clock → forgotten. */
export function bankStep(prev: BankSeen | null, onClock: boolean, offerText: string | null, prevClock: number | null,
                         clock: number | null, now: number): BankSeen | null {
  if (!onClock) return null;
  const m = offerText ? /(\d+)/.exec(offerText) : null;
  if (m) return { secs: Number(m[1]), at: now, started: false };
  if (prev && !prev.started && clock !== null && prevClock !== null && clock > prevClock + 1) return { ...prev, started: true };
  return prev;
}

// ---- the award row under "Result for hand N" ------------------------------------------------------------
/** The winner's label on the award row ('Player N' preferred, else the nearest left neighbour). */
export function awardName(win: Node, row: Node[]): string {
  const sameRow = row.filter((x) => x !== win && Math.abs(x.y - win.y) <= 8 && x.x <= win.x + 4);
  const tagged = sameRow.filter((x) => /^Player \d+$/.test(x.text.trim()));
  if (tagged.length) return minBy(tagged, (x) => Math.abs(x.x - win.x))!.text.trim();
  const near = sameRow.filter((x) => { const g = win.x - (x.x + x.w); return g >= -4 && g < 60; });
  return near.length ? minBy(near, (x) => win.x - (x.x + x.w))!.text.trim() : "";
}

// ---- which socket is ours: what a WS frame says about its table -------------------------------------------
/** {seat number: card names} for every seat this frame shows FACE UP (only hero's cards are face up to hero). */
export function faceUpSeats(d: Record<string, any>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [k, v] of Object.entries(d)) {
    const m = /^seat(\d+)$/.exec(String(k));
    if (!m || !Array.isArray(v)) continue;
    const names = v.map(wireCard).filter((n): n is string => !!n);
    if (names.length) out.set(Number(m[1]), names);
  }
  return out;
}

/** The seat a HERO-ONLY frame names (PLAY_BUYIN_INFO type 1, CO_SIT_PLAY), or null. */
export function heroClaim(d: Record<string, any>): number | null {
  const pid = d.pid;
  if ((pid === "PLAY_BUYIN_INFO" && d.type === 1) || pid === "CO_SIT_PLAY") {
    const s = d.seat;
    return typeof s === "number" && Number.isInteger(s) && s > 0 ? s : null;
  }
  return null;
}

/** The panel window's title is the PAGE title ("Poker Wrapper", "Poker Wrapper · Session setup", ...). */
export function isPanelTitle(title: string, base: string): boolean {
  return title === base || title.startsWith(base + " · ") || title.startsWith(base + " - ");
}

/** The panel port another instance was launched on, from its own argv (7700 when absent or unreadable). */
export function portOf(cmdline: string[]): number {
  for (let i = 0; i < cmdline.length; i++) {
    const a = cmdline[i]!;
    if (a === "--panel-port" && i + 1 < cmdline.length) {
      try { return pyInt(cmdline[i + 1]); } catch { return 7700; }
    }
    if (a.startsWith("--panel-port=")) {
      try { return pyInt(a.split("=").slice(1).join("=")); } catch { return 7700; }
    }
  }
  return 7700;
}
