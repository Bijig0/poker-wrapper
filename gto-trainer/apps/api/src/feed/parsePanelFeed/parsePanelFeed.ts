/**
 * parsePanelFeed
 * --------------
 * Inverse of assistive-play's `panelFeed(hand)`: recover the structured hand
 * from the display rows the panel live feed emits (or from the same lines
 * pasted as plain text). Pure and stateless — the feed's contract is that
 * every poll carries the ENTIRE list rebuilt from the current Hand, so the
 * whole list is re-parsed every time and in-place corrections come for free.
 *
 * `renderPanelRows` is a faithful re-implementation of `panelFeed` used to
 * prove the round trip (parse → render → identical rows). The test suite pins
 * it against the real `panelFeed` from poker/assistive-play when that repo is
 * reachable, so format drift breaks tests instead of silently breaking
 * ingestion.
 */

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";
export type ActionType =
  | "post-sb"
  | "post-bb"
  /** a live blind POSTED IN out of turn by a new/returning player (Ignition btn 8). Accepted on input only:
   *  normalizeHand folds it into the poster's own action (utils/foldPostIns) — a ParsedHand never carries one. */
  | "post"
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise"
  | "all-in";

export interface PanelRow {
  k: "street" | "act" | "hero" | "result" | "info" | "status" | "turn";
  t: string;
}

export interface ParsedAction {
  seatId: number; // 0-based; -1 = hero (rows say "You", never a seat number)
  hero: boolean;
  type: ActionType;
  amount?: number; // BB
  street: Street;
}

/** A live blind posted in out of turn, and how the line reads the poster (utils/foldPostIns). */
export interface PostIn {
  seatId: number;
  hero: boolean;
  amount: number;       // BB, live
  readAs: "limp" | "call" | "raise" | "fold" | "pending";
}

export interface ParsedNode {
  street: Street;
  toActSeatId: number | null;
  toActIsHero: boolean;
  pot: number;
  toCall: number;
  legalActions: string[];
  complete: boolean;
}

/** Structurally compatible with assistive-play's Hand (panelFeed-relevant fields). */
export interface ParsedHand {
  /** The wrapper's declared session this hand was played in (archived hands since 2026-09-04). */
  sessionId?: string | null;
  /** Which of the session's 1-4 tables this hand was played on (wrapper
   *  `tableSlot`; null on a single-table session, where tables.py deliberately
   *  has no slot). Carried so an answer can be attributed to a table — until
   *  2026-09-20 normalizeHand dropped it, so answers.sqlite.table_slot was null
   *  in all 2,129 rows despite both ends of the chain being wired for it. */
  tableSlot?: number | null;
  handId: number;
  /** The site's own globally-unique hand id (Ignition stage id), when the
   *  source provides one — the stable join key between live answers and the
   *  archived hand history (wrapper handIds reset every restart). */
  clientHandId?: string;
  /** Table big blind in cents (200 = $1/$2, 500 = $2.50/$5), when the feed
   *  has calibrated the scale — selects the rake-matched chart set. */
  bbCents?: number;
  /** Per-player ante in BB, when the source reports one (CoinPoker's log does: pre_hand_start_info
   *  anteAmount). Absent = unknown, NOT zero. Carried so a chart solved with antes can check the table
   *  matches it and the postflop solve can put the dead money in the pot. */
  anteBb?: number;
  heroSeatId: number;
  heroCards: string[]; // short form, e.g. "As"
  board: string[]; // short form
  street: Street;
  actions: ParsedAction[];
  /** Players who POSTED IN this hand; their posts are already folded into `actions` (utils/foldPostIns). */
  postIns?: PostIn[];
  liveSeats: number[];
  committed: Record<number, number>;
  potByStreet: Partial<Record<Street, number>>;
  positions: Record<number, string>;
  /** Last-read stack per seat (BB): the chips BEHIND at the moment of the export — live, at the decision; in an
   *  archived hands.db row, at the END of the hand (utils/archivedHand rebuilds a decision's from it). */
  stacks?: Record<number, number>;
  /** Each seat's stack AS DEALT (BB), when the source records it — the exact answer an archived row's end-of-hand
   *  `stacks` can only estimate (utils/archivedHand.startStacksOf). Exported by the wrapper since 2026-09-24 for every
   *  seat that has acted in the hand; live, the API reads those seats' money from it (utils/archivedHand.withStartStacks). */
  startStacks?: Record<number, number>;
  /** EVERY SEAT'S CHIPS AS THE TABLE'S OWN FEED REPORTS THEM (Ignition WebSocket, round 3 2026-09-25; live exports only,
   *  never archived rows): chips behind NOW, chips in front THIS STREET, and a dead blind posted (bb). With startStacks
   *  they let the capture gate check each seat's captured line against its money to the cent
   *  (utils/repairPostflopRotation.lostActionFaults, exact per-seat chips). Absent = unknown, never zero. */
  wsStack?: Record<number, number>;
  wsInFront?: Record<number, number>;
  wsDead?: Record<number, number>;
  /** Whose betting line `actions` is (wrapper CONTRACT §1c): the WebSocket's own ("ws", amounts exact to the cent) or the
   *  level reconciler's off the chips on screen ("reconciled", amounts to the 0.1bb the screen shows). */
  lineSource?: "ws" | "reconciled";
  /** THE TABLE'S OWN RAKE TERMS, when the site sends them (CoinPoker: roomProperties rake / rakeHeadsUp / rakeCap /
   *  isPotRakePf on every table, 2026-09-30). `capBb` is the cap in big blinds (the server's cap is table currency);
   *  `preflopPots` = the site rakes a pot that ends preflop (CoinPoker does; Ignition is no flop no drop). Absent =
   *  the strategy's own rake model applies. Read by gtowAiPreflop.siteRakeOf and the postflop chain's rake. */
  siteRake?: { pct: number; pctHeadsUp: number | null; capBb: number | null; preflopPots: boolean };
  /** THE HAND'S SEAT ROSTER (Ignition wrapper since 2026-10-04, ignition/roster.ts): every seat of the table and why it
   *  was or was not dealt, the button seat (`dealer`, which may be a seat not dealt — a dead button) and whether the
   *  button / the small blind was dead. Absent on older rows and other sites. */
  roster?: SeatRoster;
  /** THE SEATS WERE RENAMED FROM THE SEATS DEALT by normalizeHand (utils/dealtSeats.relabelUndealt, 2026-10-04): a
   *  labelled seat was not dealt (Ignition's dead button, labelled BTN by wrappers before the fix) and the dealt seats
   *  took their names among the dealt. `from` = the labels as the source sent them; `note` says what changed. */
  seatRelabel?: { from: Record<number, string>; note: string };
  result?: { text: string };
  currentNode: ParsedNode;
  ended: boolean;
}

export type SeatRosterStatus = "dealt" | "sitting-out" | "busted" | "waiting" | "reserved" | "empty" | "not-dealt";
export interface SeatRoster {
  dealer: number | null;
  deadButton: boolean;
  deadSb: boolean;
  dealt: number[];
  /** seat id → its status this hand; `posted` (sb / bb / in) on a dealt seat, `word` = the socket word an undealt one rests on */
  seats: Record<number, { status: SeatRosterStatus; hero?: boolean; posted?: string; word?: string; reserved?: boolean }>;
}

export interface ParseResult {
  /** null when the feed is between hands ("Waiting for the next hand…"). */
  hand: ParsedHand | null;
  warnings: string[];
}

const SUIT_SYM: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const SYM_SUIT: Record<string, string> = { "♠": "s", "♥": "h", "♦": "d", "♣": "c" };
const WORD_RANK: Record<string, string> = {
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
  nine: "9", ten: "T", jack: "J", queen: "Q", king: "K", ace: "A",
};
const WORD_SUIT: Record<string, string> = { spades: "s", hearts: "h", diamonds: "d", clubs: "c" };

/** "ace of spades" | "A♠" | "As" → "As" (falls back to the input if unreadable). */
export const toShortCard = (label: string): string => {
  const long = label.trim().toLowerCase().match(/^(\w+) of (\w+)$/);
  if (long) {
    const r = WORD_RANK[long[1]!];
    const s = WORD_SUIT[long[2]!];
    return r && s ? r + s : label;
  }
  const m = label.trim().match(/^([2-9TJQKAtjqka])([shdc♠♥♦♣])$/);
  if (!m) return label;
  const suit = SYM_SUIT[m[2]!] ?? m[2]!;
  return m[1]!.toUpperCase() + suit;
};

/** "As" | "ace of spades" → "A♠" (mirror of panelFeed's symbolCard). */
export const symbolCard = (label: string): string => {
  const short = toShortCard(label);
  const m = short.match(/^([2-9TJQKA])([shdc])$/);
  return m ? m[1]! + SUIT_SYM[m[2]!]! : label;
};

const STREETS: readonly Street[] = ["preflop", "flop", "turn", "river"];

const num = (s: string | undefined): number | undefined =>
  s == null ? undefined : Number(s);

/** Parse one action line body ("posts the big blind 1 BB") → type + amount. */
const parseVerb = (
  body: string
): { type: ActionType; amount?: number } | null => {
  let m = body.match(/^posts? the small blind(?: ([\d.]+) BB)?$/);
  if (m) return { type: "post-sb", amount: num(m[1]) };
  m = body.match(/^posts? the big blind(?: ([\d.]+) BB)?$/);
  if (m) return { type: "post-bb", amount: num(m[1]) };
  if (/^folds?$/.test(body)) return { type: "fold" };
  if (/^checks?$/.test(body)) return { type: "check" };
  m = body.match(/^calls?(?: ([\d.]+) BB)?$/);
  if (m) return { type: "call", amount: num(m[1]) };
  m = body.match(/^bets?(?: ([\d.]+) BB)?$/);
  if (m) return { type: "bet", amount: num(m[1]) };
  m = body.match(/^raises?(?: to ([\d.]+) BB)?$/);
  if (m) return { type: "raise", amount: num(m[1]) };
  if (/^(?:is|are) all-in$/.test(body)) return { type: "all-in" };
  return null;
};

const STREET_WORD = /^(PREFLOP|FLOP|TURN|RIVER|SHOWDOWN)/;

/**
 * Classify plain pasted lines into rows — for manual hand-history entry where
 * the user has the text but not the {k, t} JSON. Kinds are only styling
 * upstream, so recovering them from content is lossless.
 */
export const rowsFromText = (text: string): PanelRow[] => {
  const rows: PanelRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim().replace(/\s+—\s+/g, " — ");
    if (!t) continue;
    if (/^Waiting for the next hand/.test(t) || /^New hand/.test(t)) {
      rows.push({ k: "info", t });
    } else if (/^YOUR TURN/.test(t)) {
      rows.push({ k: "turn", t });
    } else if (STREET_WORD.test(t) && / — pot /.test(t) && !/^(FLOP|TURN|RIVER)\s{2}/.test(t)) {
      rows.push({ k: "status", t });
    } else if (/^(FLOP|TURN|RIVER)\s+/.test(t)) {
      // street marker: normalize to the canonical two-space form
      rows.push({ k: "street", t: t.replace(/^(FLOP|TURN|RIVER)\s+/, "$1  ") });
    } else if (/^You /.test(t)) {
      rows.push({ k: "hero", t });
    } else if (/^Seat \d/.test(t)) {
      rows.push({ k: "act", t });
    } else if (/ wins?\b/i.test(t)) {
      rows.push({ k: "result", t });
    } else {
      rows.push({ k: "info", t });
    }
  }
  return rows;
};

export const parsePanelFeed = (rows: PanelRow[]): ParseResult => {
  const warnings: string[] = [];
  if (!rows.length) return { hand: null, warnings: ["Empty feed."] };
  if (rows.every((r) => r.k === "info" && /^Waiting/.test(r.t))) {
    return { hand: null, warnings };
  }

  const hand: ParsedHand = {
    handId: 0,
    heroSeatId: -1,
    heroCards: [],
    board: [],
    street: "preflop",
    actions: [],
    liveSeats: [],
    committed: {},
    potByStreet: {},
    positions: {},
    currentNode: {
      street: "preflop",
      toActSeatId: null,
      toActIsHero: false,
      pot: 0,
      toCall: 0,
      legalActions: [],
      complete: false,
    },
    ended: true, // flips to false when a live status/turn row appears
  };

  let cursor: Street = "preflop";
  let sawLiveLine = false;

  for (const row of rows) {
    const t = row.t.trim();
    switch (row.k) {
      case "info": {
        const m = t.match(/^New hand(?: — you have (.+))?$/);
        if (m?.[1]) {
          hand.heroCards = m[1].split(/\s+/).map(toShortCard);
        } else if (!m) {
          warnings.push(`Unrecognized info row: "${t}"`);
        }
        break;
      }
      case "street": {
        const m = t.match(/^(FLOP|TURN|RIVER)\s+(.*?)(?:\s+—\s+pot\s+([\d.]+)\s+BB)?$/);
        if (!m) {
          warnings.push(`Unrecognized street row: "${t}"`);
          break;
        }
        cursor = m[1]!.toLowerCase() as Street;
        const cards = (m[2] ?? "").split(/\s+/).filter(Boolean).map(toShortCard);
        // markers carry the whole board up to their street — keep the longest
        if (cards.length > hand.board.length) hand.board = cards;
        if (m[3] != null) hand.potByStreet[cursor] = Number(m[3]);
        hand.street = cursor;
        break;
      }
      case "hero":
      case "act": {
        let seatId = -1;
        let hero = row.k === "hero";
        let body = t;
        if (t.startsWith("You ")) {
          hero = true;
          body = t.slice(4);
        } else {
          const m = t.match(/^Seat (\d+)(?: \(([^)]+)\))? (.+)$/);
          if (!m) {
            warnings.push(`Unrecognized action row: "${t}"`);
            break;
          }
          seatId = Number(m[1]) - 1; // rows are 1-based, model is 0-based
          hero = false;
          if (m[2]) hand.positions[seatId] = m[2];
          body = m[3]!;
        }
        const verb = parseVerb(body);
        if (!verb) {
          warnings.push(`Unrecognized action verb: "${body}"`);
          break;
        }
        hand.actions.push({ seatId, hero, street: cursor, ...verb });
        break;
      }
      case "status": {
        const m = t.match(
          /^([A-Z]+) — pot ([\d.]+) BB(?: — Seat (\d+)(?: \(([^)]+)\))? to act)?$/
        );
        if (!m) {
          warnings.push(`Unrecognized status row: "${t}"`);
          break;
        }
        const street = m[1]!.toLowerCase() as Street;
        if ((STREETS as readonly string[]).includes(street) || street === "showdown") {
          hand.street = street;
        }
        const toActSeatId = m[3] != null ? Number(m[3]) - 1 : null;
        if (toActSeatId != null && m[4]) hand.positions[toActSeatId] = m[4];
        hand.currentNode = {
          street: hand.street,
          toActSeatId,
          toActIsHero: false,
          pot: Number(m[2]),
          toCall: 0,
          legalActions: [],
          complete: false,
        };
        sawLiveLine = true;
        break;
      }
      case "turn": {
        const m = t.match(/^YOUR TURN — pot ([\d.]+) BB(?: — ([\d.]+) BB to call)?$/);
        if (!m) {
          warnings.push(`Unrecognized turn row: "${t}"`);
          break;
        }
        hand.currentNode = {
          street: cursor,
          toActSeatId: hand.heroSeatId,
          toActIsHero: true,
          pot: Number(m[1]),
          toCall: m[2] != null ? Number(m[2]) : 0,
          legalActions: [],
          complete: false,
        };
        sawLiveLine = true;
        break;
      }
      case "result": {
        hand.result = { text: t };
        break;
      }
    }
  }

  hand.ended = !sawLiveLine;
  if (hand.ended) {
    hand.currentNode = {
      street: hand.street,
      toActSeatId: null,
      toActIsHero: false,
      pot: hand.potByStreet[hand.street] ?? hand.currentNode.pot,
      toCall: 0,
      legalActions: [],
      complete: true,
    };
  }
  return { hand, warnings };
};

// ---------------------------------------------------------------------------
// renderPanelRows — faithful port of assistive-play's panelFeed(hand), used to
// prove the parse round-trips and to preview ingested hands in the dashboard.
// ---------------------------------------------------------------------------

const seatName = (hand: ParsedHand, seatId: number): string => {
  if (seatId === hand.heroSeatId) return "You";
  const pos = hand.positions[seatId];
  return `Seat ${seatId + 1}${pos ? ` (${pos})` : ""}`;
};

const verbText = (a: ParsedAction): string => {
  const amt = a.amount != null ? ` ${a.amount} BB` : "";
  const to = a.amount != null ? ` to ${a.amount} BB` : "";
  switch (a.type) {
    case "post-sb": return a.hero ? `post the small blind${amt}` : `posts the small blind${amt}`;
    case "post-bb": return a.hero ? `post the big blind${amt}` : `posts the big blind${amt}`;
    case "post": return a.hero ? `post in${amt}` : `posts in${amt}`;
    case "fold": return a.hero ? "fold" : "folds";
    case "check": return a.hero ? "check" : "checks";
    case "call": return a.hero ? `call${amt}` : `calls${amt}`;
    case "bet": return a.hero ? `bet${amt}` : `bets${amt}`;
    case "raise": return a.hero ? `raise${to}` : `raises${to}`;
    case "all-in": return a.hero ? "are all-in" : "is all-in";
  }
};

const boardAt = (hand: ParsedHand, street: Street): string[] => {
  const b = hand.board.map(symbolCard);
  if (street === "flop") return b.slice(0, 3);
  if (street === "turn") return b.slice(0, 4);
  if (street === "river") return b.slice(0, 5);
  return [];
};

export const renderPanelRows = (hand: ParsedHand | null): PanelRow[] => {
  if (!hand) return [{ k: "info", t: "Waiting for the next hand…" }];
  const rows: PanelRow[] = [];

  const heroCards = (hand.heroCards ?? []).map(symbolCard).join(" ");
  rows.push({ k: "info", t: `New hand${heroCards ? ` — you have ${heroCards}` : ""}` });

  const reachedIdx =
    hand.street === "showdown" ? STREETS.length - 1 : STREETS.indexOf(hand.street);
  for (const [idx, street] of STREETS.entries()) {
    const acts = hand.actions.filter((a) => a.street === street);
    const pot = hand.potByStreet[street];
    if (street !== "preflop" && idx > reachedIdx && !acts.length && pot == null) continue;
    if (street !== "preflop") {
      const board = boardAt(hand, street);
      const potStr = pot != null ? ` — pot ${pot} BB` : "";
      rows.push({ k: "street", t: `${street.toUpperCase()}  ${board.join(" ")}${potStr}` });
    }
    for (const a of acts) {
      rows.push({ k: a.hero ? "hero" : "act", t: `${seatName(hand, a.seatId)} ${verbText(a)}` });
    }
  }

  if (hand.result?.text) rows.push({ k: "result", t: hand.result.text });

  if (!hand.ended) {
    const node = hand.currentNode;
    if (node.toActIsHero) {
      const call = node.toCall > 0 ? ` — ${node.toCall} BB to call` : "";
      rows.push({ k: "turn", t: `YOUR TURN — pot ${node.pot} BB${call}` });
    } else {
      const who =
        node.toActSeatId != null ? ` — ${seatName(hand, node.toActSeatId)} to act` : "";
      rows.push({ k: "status", t: `${hand.street.toUpperCase()} — pot ${node.pot} BB${who}` });
    }
  }
  return rows;
};
