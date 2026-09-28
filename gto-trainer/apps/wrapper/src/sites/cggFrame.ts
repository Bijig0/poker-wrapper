/**
 * One ClubGG table frame -> a Snapshot: what the screen says right now, nothing remembered (cggFeed folds snapshots
 * into hands). Pure given the frame and its OCR lines, so a recording replays exactly.
 *
 * WHAT THE TABLE DRAWS (measured on recording 20260928_194914, 7-max, 200% DPI; REFERENCE px = a 1698x1260 client):
 *   - a seat PLATE: the player's name with the stack under it (~40 px lower, same centre); the VPIP% badge is a small
 *     number up-left of the name. Seats are FOUND from the OCR (name over money), never from a per-size layout.
 *   - bets: a number beside a chip stack between the plate and the middle; "Total Pot N" counts the street's bets too;
 *     swept pots sit under the board (x~849, y~775).
 *   - an ACTION LABEL over the top of the plate for ~1-2 s: Check / Call (yellow), Bet / Raise (blue), Fold (red),
 *     and "WIN" with "+amount" above it at the end.
 *   - the seat to act: a timer bar under the plate (~400 saturated px; none elsewhere) + a blinking white glow.
 *   - cards above the plate: backs = light grey pattern (38-57% of the box), folding = dark grey (fading out),
 *     face up = white (showdown, or hero's own); no cards = the avatar (2-3%).
 *   - the dealer button: a gold disc (~470 gold px in a 50x50 window).
 */
import { MIN_SCORE, REF_W, readBoard, readPills, rgb, share, type RGB } from "./cggCards";
import type { Bgra, OcrLine } from "./cggOcr";

export type CardState = "backs" | "faces" | "dark" | "none";

export type SeatSnap = {
  cx: number; cy: number;                 // the name line's centre (reference px)
  name: string;
  stack: number | null;
  bet: number | null;
  label: string | null;                   // check / call / bet / raise / fold / all-in / win / … (lower case)
  win: number | null;                     // "+31.54" over the plate
  cards: CardState;
  active: boolean;                        // the timer bar is under this plate
  badge: number | null;                   // the VPIP% badge
};

export type Snapshot = {
  t: number;
  width: number; height: number;
  seats: SeatSnap[];
  board: (string | null)[];               // one per PRESENT board card, in slot order (null = present, unreadable)
  boardRaised: boolean;                   // the showdown lifted the winning cards
  totalPot: number | null;
  centerPot: number | null;
  dealer: { x: number; y: number } | null;
  bombPot: boolean;                       // "BOMB POT" drawn across the felt
  texts: string[];                        // lines nothing claimed (for the log)
};

const MONEY = /^\+?[\d,]*\d(\.\d{1,2})?$/;
const LABELS: Record<string, string> = {
  check: "check", call: "call", bet: "bet", raise: "raise", fold: "fold", allin: "all-in", "all-in": "all-in", "all in": "all-in",
  win: "win", straddle: "straddle", post: "post", muck: "muck", show: "show",
};
const IGNORED = /^(join waiting|waiting player|sitting out|sit out|sit in|bad|beat|run it|vpip|total pot)/i;

/** "1,234.50" / "+31.54" -> 1234.5 (null when it is not money). */
export function money(t: string): number | null {
  const s = t.replace(/\s+/g, "").replace(/[Oo]/g, "0");
  if (!MONEY.test(s)) return null;
  const v = Number(s.replace(/[+,]/g, ""));
  return Number.isFinite(v) ? v : null;
}

/** An OCR'd action label ("Call", "@WIN", "All-In") in the reader's vocabulary, or null. */
export function labelOf(t: string): string | null {
  const k = t.toLowerCase().replace(/[^a-z\- ]/g, "").trim();
  return LABELS[k] ?? LABELS[k.replace(/[\s-]/g, "")] ?? null;
}

type Item = { text: string; x: number; y: number; w: number; h: number; cx: number; cy: number; used: boolean };

const isGold = (c: RGB) => c[0] > 200 && c[1] > 140 && c[1] < 215 && c[2] < 90 && c[0] - c[1] > 25;
const isBackGrey = (c: RGB) => Math.min(...c) > 150 && Math.max(...c) - Math.min(...c) < 30;
const isDarkGrey = (c: RGB) => Math.max(...c) < 130 && Math.min(...c) > 60 && Math.max(...c) - Math.min(...c) < 25;
const isFaceWhite = (c: RGB) => Math.min(...c) > 215;
const isTimer = (c: RGB) => Math.max(c[0], c[1]) > 150 && c[2] < 110 && Math.max(c[0], c[1]) - c[2] > 90;

/** The card box above a plate, classified. */
function cardsAt(f: Bgra, s: number, cx: number, nameTop: number): CardState {
  const box = [(cx - 85) * s, (nameTop - 120) * s, (cx + 85) * s, (nameTop - 15) * s] as const;
  const step = Math.max(1, Math.round(2 * s));
  const white = share(f, ...box, isFaceWhite, step);
  const grey = share(f, ...box, isBackGrey, step);
  const dark = share(f, ...box, isDarkGrey, step);
  if (white > 0.35) return "faces";
  if (grey > 0.2) return "backs";
  if (dark > 0.3) return "dark";
  return "none";
}

/** Saturated timer-bar pixels in the strip under a plate (name top + 70..100). */
function timerAt(f: Bgra, s: number, cx: number, nameTop: number): number {
  let n = 0;
  const step = Math.max(1, Math.round(s));
  for (let y = (nameTop + 70) * s; y < (nameTop + 100) * s; y += step) {
    for (let x = (cx - 95) * s; x < (cx + 95) * s; x += step) if (isTimer(rgb(f, x, y))) n++;
  }
  return n * step * step / (s * s);
}

/** The dealer button's centre (reference px): the densest 50x50 gold window over the felt, if it is disc-sized. */
function dealerAt(f: Bgra, s: number): { x: number; y: number } | null {
  const step = 5;
  const W = Math.ceil(1600 / step), H = Math.ceil(1120 / step);
  const g = new Uint8Array(W * H);
  for (let j = Math.ceil(260 / step); j < H; j++) {
    for (let i = Math.ceil(100 / step); i < W; i++) if (isGold(rgb(f, i * step * s, j * step * s))) g[j * W + i] = 1;
  }
  const k = 10;                                    // 50 px window
  let best = 0, bx = 0, by = 0;
  for (let j = 0; j + k <= H; j += 2) {
    for (let i = 0; i + k <= W; i += 2) {
      let n = 0;
      for (let jj = j; jj < j + k; jj++) for (let ii = i; ii < i + k; ii++) n += g[jj * W + ii]!;
      if (n > best) { best = n; bx = i; by = j; }
    }
  }
  // ~470 gold px at full resolution = ~19 of the 100 sampled cells; the BOMB POT letters light up far more
  if (best < 8 || best > 45) return null;
  return { x: (bx + k / 2) * step, y: (by + k / 2) * step };
}

/** Parse one frame. `lines` are the OCR lines in FRAME pixels. */
export function parseFrame(f: Bgra, lines: OcrLine[], t: number): Snapshot {
  const s = f.width / REF_W;
  const items: Item[] = lines.map((l) => {
    const x = l.x / s, y = l.y / s, w = l.w / s, h = l.h / s;
    return { text: l.text.trim(), x, y, w, h, cx: x + w / 2, cy: y + h / 2, used: false };
  }).filter((it) => it.text && it.y + it.h > 225);      // the header (title, jackpot, table rules) is above y 225
  const snap: Snapshot = { t, width: f.width, height: f.height, seats: [], board: [], boardRaised: false, totalPot: null, centerPot: null,
                           dealer: null, bombPot: false, texts: [] };
  for (const it of items) {
    const m = /^total\s*pot\s*([\d,.]+)/i.exec(it.text);
    if (m) {
      snap.totalPot = money(m[1]!);
      it.used = true;
    } else if (/bomb\s*pot/i.test(it.text)) {
      snap.bombPot = true;
      it.used = true;
    } else if (IGNORED.test(it.text)) it.used = true;
  }
  // PLATES: a name line with a money line right under it
  const nums = items.filter((it) => !it.used && money(it.text) !== null);
  for (const nm of items) {
    if (nm.used || money(nm.text) !== null || labelOf(nm.text) || nm.text.length < 2) continue;
    const st = nums.find((n) => !n.used && Math.abs(n.cx - nm.cx) < 50 && n.y - nm.y > 28 && n.y - nm.y < 62 && !n.text.startsWith("+"));
    if (!st) continue;
    nm.used = st.used = true;
    const top = nm.y;
    snap.seats.push({
      cx: nm.cx, cy: nm.cy, name: nm.text, stack: money(st.text), bet: null, label: null, win: null,
      cards: cardsAt(f, s, nm.cx, top), active: timerAt(f, s, nm.cx, top) > 150, badge: null,
    });
  }
  // what sits around each plate: its badge, its label, its win amount
  for (const seat of snap.seats) {
    for (const it of items) {
      if (it.used) continue;
      const dx = it.cx - seat.cx, dy = it.cy - seat.cy;
      const n = money(it.text), lab = labelOf(it.text);
      if (n !== null && !it.text.startsWith("+") && dx > -140 && dx < -40 && dy > -70 && dy < -25) {
        seat.badge = n;
        it.used = true;
      } else if (lab && Math.abs(dx) < 110 && dy > -75 && dy < -15) {
        seat.label = lab;
        it.used = true;
      } else if (n !== null && it.text.startsWith("+") && Math.abs(dx) < 130 && dy > -230 && dy < -110) {
        seat.win = n;
        it.used = true;
      }
    }
  }
  // BETS AND THE SWEPT POT: numbers in dark pills on the felt, read by digit templates (cggCards.readPills) — Windows'
  // OCR misses short numbers there on many frames and now and then reads the chip graphic above a pill as a digit.
  // An OCR number inside a pill only fills in a pill the templates could not read; one outside every pill is not a bet.
  for (const p of readPills(f)) {
    const inPill = items.filter((it) => !it.used && it.cx >= p.x - 4 && it.cx <= p.x + p.w + 4 && it.cy >= p.y - 4 && it.cy <= p.y + p.h + 4);
    let v = p.value;
    if (v === null) {
      const n = inPill.map((it) => money(it.text)).find((x) => x !== null && x !== undefined);
      v = n ?? null;
    }
    for (const it of inPill) it.used = true;
    if (v === null) continue;
    if (Math.abs(p.cx - 849) < 80 && p.cy > 735 && p.cy < 815) {
      snap.centerPot = v;
      continue;
    }
    if (Math.abs(p.cx - 849) < 110 && p.cy < 520) continue;        // the Total Pot pill
    let best: SeatSnap | null = null, bd = 1e9;
    for (const seat of snap.seats) {
      const d = Math.hypot(p.cx - seat.cx, p.cy - seat.cy);
      if (d < bd) { bd = d; best = seat; }
    }
    if (best && bd < 330 && best.bet === null) best.bet = v;
  }
  snap.texts = items.filter((it) => !it.used).map((it) => it.text);
  const board = readBoard(f);
  for (const b of board) if (b.present) snap.board.push(b.card && b.score >= MIN_SCORE ? b.card : null);
  snap.boardRaised = board.some((b) => b.raised);
  snap.dealer = dealerAt(f, s);
  return snap;
}

/** Stakes off the window title: "NLH 80-200 BP  - 1/2" -> sb 1, bb 2; "… - 1/2(0.40)" carries an ante. */
export function stakesOf(title: string): { game: string | null; sb: number | null; bb: number | null; ante: number | null } {
  const m = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:\((\d+(?:\.\d+)?)\))?\s*$/.exec(title);
  const g = /\b(NLH|PLO\d?|PLO|OFC|SD)\b/i.exec(title);
  return { game: g ? g[1]!.toUpperCase() : null, sb: m ? Number(m[1]) : null, bb: m ? Number(m[2]) : null, ante: m && m[3] ? Number(m[3]) : null };
}
