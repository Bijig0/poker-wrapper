import {
  toShortCard,
  type ParsedAction,
  type ParsedHand,
  type Street,
} from "../parsePanelFeed/parsePanelFeed";

/**
 * Rebuild a ParsedHand from ONE RECORDED DEBUG TICK, so a state in the replay
 * review queue can be put through the same study answer the panel would have
 * given at the table.
 *
 * Why not replay the wrapper's own parser: it builds hands from the WebSocket
 * tap (`_ws_state`), and debug sessions record the DOM and the rendered feed
 * only — there is no WS dump to replay. The feed, however, is a complete
 * narrative of the hand (blind posts, every action with its amount, street
 * markers carrying board and pot), and the tick carries the seats, stacks,
 * hero's cards and whose turn it is. That is everything a hand needs.
 *
 * THE BUTTON IS DERIVED, NOT READ. The reader does not extract the dealer
 * button at all (it is an image with no text node), so position cannot come
 * from where the client draws the D. It comes from the SMALL BLIND POST
 * instead: the button is the seat before the SB in ring order. That is not a
 * guess — it is the same relation the client uses to place the button, run
 * backwards. It is worth stating because it is checkable: on hand 6 of
 * session_20260807_115240 the SB is seat 3, this puts the button on seat 2,
 * and the recorded frame draws the D on seat 2.
 *
 * Naming follows the wrapper's own _positions_all so a replayed answer and a
 * live answer describe the same seat the same way.
 */

export interface TickSeat {
  stack?: string | null;
  bet?: string | null;
  badge?: string | null;
  cards?: number;
  hero?: boolean;
  /** The dealer button, read from the client's own marker. Absent on captures
   *  made before the reader carried it — absent means unknown, not "not BTN". */
  dealer?: boolean;
}

export interface Tick {
  seq?: number;
  hand?: number;
  pot?: string | null;
  board?: string[];
  heroCards?: string[];
  toAct?: boolean;
  seats?: Record<string, TickSeat>;
  actions?: string[];
  feedTail?: string[];
}

export interface BuildResult {
  hand: ParsedHand | null;
  /** Why a field is missing or assumed — shown beside the answer, never hidden. */
  notes: string[];
  /** How position was established, for display. */
  buttonSeat: number | null;
}

/** "194.2 BB" | "1 BB" -> 194.2 | 1 ; null when there is no number. */
const bb = (text: string | null | undefined): number | null => {
  if (text == null) return null;
  const m = String(text).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

/** Positions for the dealt ring, given the button. Mirrors _positions_all. */
export function positionsFor(dealt: number[], btn: number): Record<number, string> {
  const seats = [...new Set([...dealt, btn])].sort((a, b) => a - b);
  const i = seats.indexOf(btn);
  const order = [...seats.slice(i + 1), ...seats.slice(0, i + 1)]; // SB … BTN
  const n = order.length;
  if (n === 2) {
    const other = order.find((s) => s !== btn)!;
    return { [btn]: "SB", [other]: "BB" };
  }
  let names: string[];
  if (n === 3) names = ["SB", "BB", "BTN"];
  else {
    const pool = n > 6 ? ["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO"] : ["UTG", "HJ", "CO"];
    names = ["SB", "BB", ...pool.slice(-(n - 3)), "BTN"];
  }
  return Object.fromEntries(order.map((s, k) => [s, names[k]]));
}

const STREET_OF_BOARD = (n: number): Street =>
  n >= 5 ? "river" : n === 4 ? "turn" : n === 3 ? "flop" : "preflop";

/** One feed line -> an action, or null for narration (hand id, your hand, …). */
function readLine(line: string): { seat: number; type: string; amount?: number } | null {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^Seat (\d+) posts small blind \(([\d.]+)/i)))
    return { seat: +m[1], type: "post-sb", amount: +m[2] };
  if ((m = line.match(/^Seat (\d+) posts big blind \(([\d.]+)/i)))
    return { seat: +m[1], type: "post-bb", amount: +m[2] };
  if ((m = line.match(/^Seat (\d+) folds/i))) return { seat: +m[1], type: "fold" };
  if ((m = line.match(/^Seat (\d+) checks/i))) return { seat: +m[1], type: "check" };
  if ((m = line.match(/^Seat (\d+) calls ([\d.]+)/i)))
    return { seat: +m[1], type: "call", amount: +m[2] };
  if ((m = line.match(/^Seat (\d+) raises to ([\d.]+)/i)))
    return { seat: +m[1], type: "raise", amount: +m[2] };
  if ((m = line.match(/^Seat (\d+) bets ([\d.]+)/i)))
    return { seat: +m[1], type: "bet", amount: +m[2] };
  if ((m = line.match(/^Seat (\d+) is ALL-IN \(([\d.]+)/i)))
    return { seat: +m[1], type: "all-in", amount: +m[2] };
  return null;
}

export function tickToHand(tick: Tick, handId = 0): BuildResult {
  const notes: string[] = [];
  const seatMap = tick.seats ?? {};
  const dealt = Object.keys(seatMap).map(Number).sort((a, b) => a - b);
  const feed = tick.feedTail ?? [];

  if (!dealt.length) return { hand: null, notes: ["the tick records no seats"], buttonSeat: null };

  const heroSeats = dealt.filter((s) => seatMap[String(s)]?.hero);
  if (heroSeats.length !== 1)
    return {
      hand: null,
      notes: [
        heroSeats.length
          ? "more than one seat is tagged hero"
          : "this capture predates the reader recording hero's seat, so the hand cannot be built without guessing who hero is",
      ],
      buttonSeat: null,
    };
  const heroSeatId = heroSeats[0];

  // ---- walk the feed ------------------------------------------------------
  const actions: ParsedAction[] = [];
  // Commitment for the CURRENT street: what toCall is measured against.
  let committed: Record<number, number> = {};
  let street: Street = "preflop";
  let sbSeat: number | null = null;
  let seenNewHand = false;
  let potFromFeed: number | null = null;

  for (const line of feed) {
    if (/new hand/i.test(line)) {
      // The wrapper's feed is one rolling list across hands, so a tail — and
      // certainly a stitched one — opens with the tail of the hand BEFORE this
      // one. Everything preceding the marker belongs to that hand and must go,
      // not just on a second marker: leaving it in prepended a dead hand's
      // actions to this one's line ("SB raise 0.32 · UTG fold" ahead of the
      // blinds), which moves the small blind and so moves every position.
      actions.length = 0;
      committed = {};
      street = "preflop";
      sbSeat = null;
      seenNewHand = true;
      continue;
    }
    const st = line.match(/^—\s*(FLOP|TURN|RIVER)\s*—(.*?)(?:—\s*pot\s*([\d.]+))?\s*$/i);
    if (st) {
      street = st[1].toLowerCase() as Street;
      committed = {}; // bets are pushed to the pot between streets
      if (st[3]) potFromFeed = parseFloat(st[3]);
      continue;
    }
    const a = readLine(line);
    if (!a) continue;
    if (a.type === "post-sb") sbSeat = a.seat;

    const rec: ParsedAction = {
      seatId: a.seat,
      hero: a.seat === heroSeatId,
      type: a.type as ParsedAction["type"],
      street,
    };
    if (a.amount != null) rec.amount = a.amount;
    actions.push(rec);

    // Calls are recorded as the INCREMENT they add; raises, bets, all-ins and
    // blind posts as the seat's TOTAL for the street. (Verified against the
    // wrapper: seat 1 posts 1 BB then "calls 1.2 BB" to meet a raise to 2.2.)
    if (a.amount != null) {
      if (a.type === "call") committed[a.seat] = (committed[a.seat] ?? 0) + a.amount;
      else committed[a.seat] = a.amount;
    }
  }

  if (!seenNewHand)
    notes.push("the recorded feed does not reach this hand's start, so early action may be missing");

  // ---- position -----------------------------------------------------------
  // The read dealer wins over the SB derivation: the button is the client's
  // own marker, while the derivation depends on the feed reaching the blind
  // posts. When BOTH are present they cross-check each other — a disagreement
  // means the reader misread one of them, and saying so beats picking quietly.
  let buttonSeat: number | null = null;
  let positions: Record<number, string> = {};
  const marked = dealt.filter((s) => seatMap[String(s)]?.dealer);
  const readBtn = marked.length === 1 ? marked[0]! : null;
  let derivedBtn: number | null = null;
  if (sbSeat != null) {
    const i = dealt.indexOf(sbSeat);
    derivedBtn = i >= 0 ? dealt[(i - 1 + dealt.length) % dealt.length]! : null;
  }
  buttonSeat = readBtn ?? derivedBtn;
  if (readBtn != null && derivedBtn != null && readBtn !== derivedBtn)
    notes.push(
      `the client's dealer marker (seat ${readBtn}) disagrees with the button derived from the small-blind post (seat ${derivedBtn}) — the reader misread one of them; using the marker`
    );
  if (buttonSeat != null) positions = positionsFor(dealt, buttonSeat);
  if (!Object.keys(positions).length)
    notes.push("no dealer marker and no small-blind post in the feed, so positions could not be established");

  // ---- the node -----------------------------------------------------------
  const board = (tick.board ?? []).map(toShortCard).filter(Boolean) as string[];
  const boardStreet = STREET_OF_BOARD(board.length);
  if (boardStreet !== street && board.length)
    // The board is the authority on the street; the feed marker may not have
    // been written yet when the tick was captured.
    street = boardStreet;

  const maxCommitted = Math.max(0, ...Object.values(committed));
  const heroCommitted = committed[heroSeatId] ?? 0;
  const foldedSeats = new Set(actions.filter((a) => a.type === "fold").map((a) => a.seatId));

  const stacks: Record<number, number> = {};
  for (const s of dealt) {
    const v = bb(seatMap[String(s)]?.stack);
    if (v != null) stacks[s] = v;
  }

  const hand: ParsedHand = {
    handId: handId || tick.hand || 0,
    heroSeatId,
    heroCards: (tick.heroCards ?? []).map(toShortCard).filter(Boolean) as string[],
    board,
    street,
    actions,
    liveSeats: dealt.filter((s) => !foldedSeats.has(s)),
    committed,
    potByStreet: {},
    positions,
    stacks: Object.keys(stacks).length ? stacks : undefined,
    currentNode: {
      street,
      toActSeatId: tick.toAct ? heroSeatId : null,
      toActIsHero: !!tick.toAct,
      pot: bb(tick.pot) ?? potFromFeed ?? 0,
      toCall: Math.max(0, maxCommitted - heroCommitted),
      legalActions: [],
      complete: false,
    },
    ended: foldedSeats.has(heroSeatId),
  };

  if (!hand.heroCards.length) notes.push("hero's cards were not captured in this tick");
  if (!tick.toAct) notes.push("hero is not to act here — this is the state as read, not a decision point");

  return { hand, notes, buttonSeat };
}
