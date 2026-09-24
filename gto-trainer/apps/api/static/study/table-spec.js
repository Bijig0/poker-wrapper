/**
 * Ignition table geometry — ported verbatim from the dashboard app's
 * components/table/types.ts when the study pages moved onto the API server.
 *
 * Geometry is not invented: every number here was read out of the live
 * Ignition web client's DOM (a React app at ignitioncasino.uno/static/
 * poker-game, rendered in plain DOM/CSS — no canvas). The client authors its
 * table in a fixed 800x400 "design unit" (du) space and scales it to the
 * window with CSS `zoom`. We mirror that exactly, so a coordinate written here
 * means the same thing it means there.
 *
 * The TypeScript types are gone; the measurements are unchanged. Do not
 * "tidy" these numbers — each one cost a session at the live client.
 */

/** The client sets every label in Roboto. Sizes are in du (zoom leaves
 *  computed font-size alone, same as left/top). */
export const FONT = "Roboto, system-ui, -apple-system, sans-serif";
export const TYPE = {
  stack: { size: 16, weight: 700 },
  badge: { size: 12, weight: 700 },
  strip: { size: 12, weight: 700 },
  chip: { size: 12, weight: 400 },
  totalPot: { size: 13, weight: 400 },
  mainPot: { size: 12, weight: 400 },
};

/**
 * The seat coordinate system. NOT the size of the felt — it is the 800x400
 * container the client positions seats inside; the painted felt is larger and
 * the container sits inset within it. Drawing the felt at 800x400 pins every
 * element to the edge and makes the table read as cramped even though each
 * individual distance is right.
 */
export const DESIGN = { w: 800, h: 400 };

/**
 * The painted felt, and where the seat container sits inside it. Measured two
 * ways that agree: the felt renders 1363x731px at zoom 1.4275 (= 955x512du),
 * and its box sits at (-77.5, -16.7) relative to the seat container.
 */
export const FELT = { w: 955, h: 512 };
export const SEAT_INSET = { x: 77.5, y: 16.7 };

/** Table oval, centred on (400, 200). */
export const OVAL = { x: 162, y: 107, w: 476, h: 186 };

/** Pot readouts and the community card strip. */
export const POT_PILL = { x: 340, y: 124, w: 120, h: 21 };
export const MAIN_POT_PILL = { x: 342.3, y: 149.4, w: 111.3, h: 17.8 };
export const BOARD_BOX = { x: 251, y: 176, w: 295, h: 76 };

/** Every seat box is this size regardless of table capacity. */
export const SEAT_BOX = { w: 114, h: 100 };

/**
 * Seat origins by table capacity, read from the live client. Hero is always
 * pinned to (343, 290) — the client rotates the ring so you sit bottom-centre
 * — which is why these are lookup tables, not a trigonometric layout. Index is
 * the screen slot, NOT the seat number.
 */
export const SEAT_MAPS = {
  6: [
    { x: 343, y: 290 }, // hero, bottom centre
    { x: 63, y: 236 },
    { x: 63, y: 66 },
    { x: 343, y: 14 },
    { x: 623, y: 66 },
    { x: 623, y: 236 },
  ],
  9: [
    { x: 343, y: 290 }, // hero, bottom centre
    { x: 183, y: 279 },
    { x: 45, y: 210 },
    { x: 51, y: 66 },
    { x: 234, y: 8 },
    { x: 452, y: 8 },
    { x: 636, y: 66 },
    { x: 641, y: 210 },
    { x: 502, y: 279 },
  ],
};

/**
 * Every real card — face and back alike — is drawn from an SVG with
 * viewBox="0 0 100 150", i.e. a clean 2:3. (Empty board slots use a different
 * 134:199 placeholder graphic; don't measure card size off those.)
 */
export const CARD_ASPECT = 100 / 150;

/** Card face art lives in static/cards/<kind>/<code>.png (52 each). */
export const cardArt = (code, kind) =>
  `/cards/${kind}/${code[0].toUpperCase()}${code.slice(-1).toLowerCase()}.png`;

/** Component sizes, in du, measured off the live client. */
export const PARTS = {
  /*
   * NOTE ON UNITS: computed left/top are already in design units — CSS `zoom`
   * does not scale them, only rendered box sizes. Divide only
   * getBoundingClientRect() results by the zoom, never computed offsets.
   * Getting this wrong pulled the pill 17du too high and clipped the cards.
   */
  pill: { x: 0, y: 58, w: 114, h: 28, radius: 50 },
  badge: { d: 24, x: 2 },
  /**
   * Status strip (POST SB / FOLD / RAISE). Starts at y 72 — i.e. *behind* the
   * pill, which spans 58..86 — and is 29 tall, so only the lower ~15du emerges
   * below the pill. It must paint under the pill for this to read correctly.
   */
  strip: { y: 72, h: 29, visible: 15, radius: "4px 4px 6px 6px" },
  chipsH: 15,
  /**
   * Cards are width + `pitch` (distance between adjacent card left edges);
   * height derives via CARD_ASPECT so faces stay undistorted. Width-first, not
   * height-first: the client's card SVGs sit in slots taller than the art and
   * scale to fit by width, so slot height includes padding and is NOT the card
   * height. Deriving the other way oversizes every card by ~40%.
   *
   * Both sets tuck *behind* the stack pill (which starts at y 58): hero
   * overlaps it by 3.3du, villains by 11.3. Cards must paint under the pill.
   */
  holeCard: { w: 36, pitch: 39, x: 18, y: 7.3 },
  villainCard: { w: 30, pitch: 32, x: 25, y: 24.3 },
  boardCard: { w: 51, pitch: 61 },
};

/*
 * Per-seat bet-chip anchors, in seat-box coordinates. Not a uniform offset —
 * the client places each seat's pill on the side facing the table centre;
 * applying hero's offset everywhere is what made bets look slanted. Every seat
 * is plain LEFT-anchored; an earlier right-edge-anchoring theory came from
 * chip-fly animation frames in the recording and was wrong. The pill renders
 * AMOUNT FIRST, then the coin icon, on every seat.
 */
const CHIP_ANCHORS_6MAX = [
  { x: 34.7, y: -10 }, // hero bottom-centre — above the seat
  { x: 96, y: 25 }, // lower-left
  { x: 118, y: 93 }, // upper-left
  { x: 34.7, y: 109 }, // top-centre (borrowed from 9-max top seats)
  { x: -48.6, y: 93 }, // upper-right
  { x: -26.6, y: 25 }, // lower-right
];

const CHIP_ANCHORS_9MAX = [
  { x: 34.7, y: -10 }, // (343,290) hero
  { x: 34.7, y: 5 }, // (183,279)
  { x: 96, y: 25 }, // (45,210)
  { x: 118, y: 93 }, // (51,66)
  { x: 34.7, y: 109 }, // (234,8)
  { x: 34.7, y: 109 }, // (452,8)
  { x: -48.6, y: 93 }, // (636,66)
  { x: -26.6, y: 25 }, // (641,210)
  { x: 34.7, y: 5 }, // (502,279)
];

export function chipAnchor(capacity, slot) {
  const map = capacity === 9 ? CHIP_ANCHORS_9MAX : CHIP_ANCHORS_6MAX;
  return map[slot] ?? map[0];
}

/**
 * Felt gradients, lifted verbatim from the client's own stylesheet rules
 * (.f1k8wgos base, .fufhpgb, .f1nx5g43). The previous red was #a82216 ->
 * #7c160d, noticeably duller and browner than the real thing.
 */
export const FELTS = {
  red: "radial-gradient(rgb(204,0,0) 0%, rgb(109,0,0) 80%, rgb(70,2,2) 100%)",
  orange: "radial-gradient(rgb(227,96,3) 0%, rgb(180,74,0) 50%, rgb(106,33,0) 100%)",
  purple: "radial-gradient(rgb(112,55,84) 0%, rgb(93,49,78) 30%, rgb(26,26,51) 90%)",
  /** Approximated from the Zone Poker capture; not found in this stylesheet. */
  teal: "radial-gradient(rgb(30,65,64) 0%, rgb(24,51,52) 62%, rgb(17,38,38) 100%)",
};

export const C = {
  ovalBorder: "rgba(255,255,255,0.2)",
  pill: "#ffffff",
  pillFolded: "rgba(196,214,217,0.45)",
  badge: "#00c9b7",
  potBg: "rgba(0,0,0,0.25)",
  chipBg: "rgba(0,0,0,0.3)",
  strip: "#00c9b7",
  stripFold: "rgba(0,0,0,0.45)",
  timer: "#efc144",
  text: "#0b1516",
  cardBack: "#363636",
  cardBackMark: "#ed732e",
  red: "#e2483f",
  black: "#1b2426",
};

/**
 * Bottom action bar, measured off the live client while facing a decision:
 * FOLD and CALL are 132x40 on rgba(0,0,0,.55); RAISE TO is 132x48 on
 * rgba(0,0,0,.3); the ALL-IN chip is 97.8x24 on rgba(255,255,255,.25).
 */
export const ACTION_BAR = {
  h: 76,
  btn: { w: 132, h: 40 },
  raise: { w: 132, h: 48 },
  allIn: { w: 97.8, h: 24 },
  gap: 10,
};

/** Table header strip above the felt, carrying the stakes and game type. */
export const HEADER_H = 26;

/** The client's felt noise tile (.fs9k49k), a 20x20 SVG at 4% black. */
export const FELT_NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 52 52'%3E%3Cpath fill='%23000000' fill-opacity='0.04' d='M0 17.83V0h17.83a3 3 0 0 1-5.66 2H5.9A5 5 0 0 1 2 5.9v6.27a3 3 0 0 1-2 5.66zm0 18.34a3 3 0 0 1 2 5.66v6.27A5 5 0 0 1 5.9 52h6.27a3 3 0 0 1 5.66 0H0V36.17zM36.17 52a3 3 0 0 1 5.66 0h6.27a5 5 0 0 1 3.9-3.9v-6.27a3 3 0 0 1 0-5.66V52H36.17zM0 31.93v-9.78a5 5 0 0 1 3.8.72l4.43-4.43a3 3 0 1 1 1.42 1.41L5.2 24.28a5 5 0 0 1 0 5.52l4.44 4.43a3 3 0 1 1-1.42 1.42L3.8 31.2a5 5 0 0 1-3.8.72zm52-14.1a3 3 0 0 1 0-5.66V5.9A5 5 0 0 1 48.1 2h-6.27a3 3 0 0 1-5.66-2H52v17.83zm0 14.1a4.97 4.97 0 0 1-1.72-.72l-4.43 4.44a3 3 0 1 1-1.41-1.42l4.43-4.43a5 5 0 0 1 0-5.52l-4.43-4.43a3 3 0 1 1 1.41-1.41l4.43 4.43c.53-.35 1.12-.6 1.72-.72v9.78zM22.15 0h9.78a5 5 0 0 1-.72 3.8l4.44 4.43a3 3 0 1 1-1.42 1.42L29.8 5.2a5 5 0 0 1-5.52 0l-4.43 4.44a3 3 0 1 1-1.41-1.42l4.43-4.43a5 5 0 0 1-.72-3.8zm0 52c.13-.6.37-1.19.72-1.72l-4.43-4.43a3 3 0 1 1 1.41-1.41l4.43 4.43a5 5 0 0 1 5.52 0l4.43-4.43a3 3 0 1 1 1.42 1.41l-4.44 4.43c.36.53.6 1.12.72 1.72h-9.78zm9.75-24a5 5 0 0 1-3.9 3.9v6.27a3 3 0 1 1-2 0V31.9a5 5 0 0 1-3.9-3.9h-6.27a3 3 0 1 1 0-2h6.27a5 5 0 0 1 3.9-3.9v-6.27a3 3 0 1 1 2 0v6.27a5 5 0 0 1 3.9 3.9h6.27a3 3 0 1 1 0 2H31.9z'%3E%3C/path%3E%3C/svg%3E")`;

export const bb = (n) => `${Number(n.toFixed(2))} BB`;
