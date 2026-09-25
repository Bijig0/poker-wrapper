/**
 * archivedHand — an archived hand (ignition-study-wrapper/data/hands.db) as it stood at one of its decisions.
 *
 * AN ARCHIVED ROW CARRIES END-OF-HAND MONEY (2026-09-24, hand 723 / 4919957209). The wrapper archives its /hand
 * export when the hand is over (wrapper archive.ts: the next hand's PLAY_STAGE_INFO or the ended-hand grace), so
 * `stacks` are the chips BEHIND at the end of the hand — every street's money already out, an uncalled bet already
 * back — and `committed` is the LAST betting round's chips, never cleared when that bet is returned. Live, at a
 * decision, the same two fields mean the chips behind NOW and this round's chips NOW, and every consumer reads them
 * that way: `stacks + committed (+ earlier rounds)` is the stack as dealt (gtowAiPreflop.shapeOf, hrc6max.dealtBySeat,
 * hrc3max/hrc2max.dealtStacks, deriveExploitSpot). truncateAt used to cut the actions and the board and keep the end
 * of the hand's money, so every replay of an archived decision (the hand page's AI-preflop rebuild, POST
 * /resolve-chain, the session and hardening backtests, the miss-queue archive sweep) read stacks from a different
 * moment than the one it replayed. Hand 723 (BB hero checks a limped 3-handed pot at actionIndex 4): the answer's
 * tree was SB 103.5 / BB 102.5 — right, the raw WS says 103.705 / 102.725 — and the rebuild's was SB 102.5 / BB 103.5:
 * the SB 1bb short (its preflop chips were already gone from the end-of-hand stack) and the BB 2bb long (hero's river
 * bet, returned uncalled, still sat in `committed`). Two independent errors that happened to look like a seat swap.
 *
 * So the money is rebuilt here: each seat's stack AS DEALT (`startStacksOf`), then what it had put in before the
 * decision (`moneyAt`). A row that carries the dealt stacks themselves (`startStacks`) is exact: the wrapper exports
 * them since 2026-09-24 (Ignition: the table's own account on each seat's first frame, ignition/ws.ts noteAccount —
 * 636 of 636 seat-hands agree with the table over the recorded sessions; CoinPoker: the server's chips before the
 * blinds). Every row archived before that is reconstructed from its end state — see startStacksOf for the rule and
 * how often it is right.
 */
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

const ROUNDS = ["preflop", "flop", "turn", "river"] as const;

const r2 = (x: number) => Math.round(x * 100) / 100;
const seatOf = (hand: ParsedHand, a: ParsedHand["actions"][number]) => (a.hero ? hand.heroSeatId : a.seatId);

/**
 * The chips each seat put in, per betting round, from actions[0 .. upto) — the feed contract hrc6max.dealtBySeat
 * reads the same way: a post / raise / bet / all-in amount is the seat's round TOTAL, a call adds its amount.
 */
export function roundContributions(hand: ParsedHand, upto = hand.actions.length): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const a of hand.actions.slice(0, Math.max(0, upto))) {
    if (!(ROUNDS as readonly string[]).includes(a.street)) continue;
    const m = out.get(a.street) ?? new Map<number, number>();
    out.set(a.street, m);
    const amt = Number(a.amount ?? 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const seat = seatOf(hand, a);
    if (a.type === "call") m.set(seat, (m.get(seat) ?? 0) + amt);
    else if (a.type === "post-sb" || a.type === "post-bb" || a.type === "raise" || a.type === "bet" || a.type === "all-in") {
      m.set(seat, Math.max(m.get(seat) ?? 0, amt));
    }
  }
  return out;
}

/**
 * Each seat's stack AS DEALT (bb), for a hand whose `stacks` are end-of-hand readings.
 *
 * `hand.startStacks` where the row carries them (exact). Every other seat is rebuilt from the end state:
 *   dealt = behind at the end + every chip the actions say the seat put in
 *           − a bet nobody called (the final round's top contributor above the next one: Ignition hands the excess
 *             back before the pot is pushed) — when the end-of-hand reading already holds it, which is when the final
 *             round is POSTFLOP, or when HERO made it and everyone folded (the hand ends for the wrapper on that fold,
 *             so the reading is taken after the return; a villain's preflop raise that took the blinds is usually
 *             read before it, hero having ended the hand for the wrapper by folding earlier).
 * Measured against the raw Ignition WS (account + chips put in, cents) over the 1,720 seat-hands with a reading in
 * the ring sessions since 2026-09-18: exact (±0.05bb) for 83.3% of seats, where the end-of-hand money the replays
 * read before this was exact for 72.6% (46.6% of the seats of hands that saw a flop). What is left is almost all the
 * hand's WINNER, whose end-of-hand reading may already hold the pot, and seats that topped up in between — the end
 * state cannot tell those apart; only the dealt stacks themselves can (the wrapper knows them: the WS `account` on
 * each seat's first CO_BLIND_INFO / CO_SELECT_INFO of the hand).
 * Seats without either are left out, exactly as they were (readers take them as unreadable).
 */
export function startStacksOf(hand: ParsedHand): Record<number, number> {
  const per = roundContributions(hand);
  const last = hand.actions.length ? hand.actions[hand.actions.length - 1]!.street : "preflop";
  let uncalled: { seat: number; excess: number } | null = null;
  if (per.has(last)) {
    const round = [...per.get(last)!.entries()].sort((x, y) => y[1] - x[1]);
    const top = round[0];
    const excess = top ? top[1] - (round[1]?.[1] ?? 0) : 0;
    const folded = new Set(hand.actions.filter((a) => a.type === "fold").map((a) => seatOf(hand, a)));
    const dealt = hand.liveSeats?.length ? hand.liveSeats : Object.keys(hand.positions ?? {}).map(Number);
    const heroAlone = top?.[0] === hand.heroSeatId && dealt.every((s) => s === hand.heroSeatId || folded.has(s));
    if (top && excess > 0 && (last !== "preflop" || heroAlone)) uncalled = { seat: top[0], excess };
  }
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(hand.stacks ?? {})) {
    const seat = Number(k);
    const behind = Number(v);
    if (!Number.isFinite(behind) || behind < 0) continue;
    let putIn = 0;
    for (const m of per.values()) putIn += m.get(seat) ?? 0;
    out[seat] = r2(behind + putIn - (uncalled?.seat === seat ? uncalled.excess : 0));
  }
  for (const [k, v] of Object.entries(hand.startStacks ?? {})) out[Number(k)] = v;
  return out;
}

/**
 * The money of the hand BEFORE actions[upto], from the seats' dealt stacks: `stacks` = what each seat had behind,
 * `committed` = its chips in the round being played, `toCall` = what hero owed, `pot` = the chips of the rounds
 * already closed (the wrapper's own `currentNode.pot`: Ignition reports the pot when a round closes, so 0 preflop).
 */
export function moneyAt(hand: ParsedHand, upto: number, start: Record<number, number> = startStacksOf(hand)): {
  stacks: Record<number, number>; committed: Record<number, number>; toCall: number; pot: number;
} {
  const act = hand.actions[upto];
  const street = String(act?.street ?? hand.street);
  const per = roundContributions(hand, upto);
  const stacks: Record<number, number> = {};
  const committed: Record<number, number> = {};
  let pot = 0;
  for (const [st, m] of per) if (st !== street) for (const v of m.values()) pot += v;
  const cur = per.get(street) ?? new Map<number, number>();
  for (const [seat, v] of cur) if (v > 0) committed[seat] = r2(v);
  for (const [k, dealt] of Object.entries(start)) {
    const seat = Number(k);
    let spent = 0;
    for (const m of per.values()) spent += m.get(seat) ?? 0;
    stacks[seat] = r2(Math.max(0, dealt - spent));
  }
  const top = Math.max(0, ...cur.values());
  return { stacks, committed, toCall: r2(Math.max(0, top - (cur.get(hand.heroSeatId) ?? 0))), pot: r2(pot) };
}

/**
 * Truncate an archived hand to the state BEFORE actions[upto]: the actions, the board, the street — and the money
 * (see the header: the row's own `stacks` / `committed` are the END of the hand's).
 */
export function truncateAt(hand: ParsedHand, upto: number): ParsedHand {
  const act = hand.actions[upto];
  const street = (act?.street ?? hand.street) as ParsedHand["street"];
  const boardLen = street === "flop" ? 3 : street === "turn" ? 4 : street === "river" ? 5 : 0;
  const money = moneyAt(hand, upto);
  // THE TABLE'S CHIP COUNTS ARE THE EXPORT'S MOMENT, NOT THIS ONE (round 3): a row carrying wsStack / wsInFront (the
  // wrapper never archives them; a live hand re-cut for a replay might) holds them for its LAST moment, and against
  // the shorter line every seat would read as having lost an action. Dropped: the cut decision is read as archived.
  const { wsStack: _ws, wsInFront: _wf, wsDead: _wd, ...rest } = hand;
  return {
    ...rest,
    actions: hand.actions.slice(0, upto),
    street,
    board: hand.board.slice(0, boardLen),
    ended: false,
    ...(hand.stacks || hand.startStacks ? { stacks: money.stacks } : {}),
    committed: money.committed,
    currentNode: { ...hand.currentNode, street, toActIsHero: act?.hero ?? false, complete: false, toCall: money.toCall, pot: money.pot },
  };
}

/**
 * A LIVE hand's `stacks` from the stacks it was dealt (2026-09-24). The wrapper's `stacks` are its on-screen seat
 * readings, which can lag the table's money: a blind the screen had not taken off yet, counted a second time on top
 * of the WS `committed` (hands 693 / 702), or a top-up still landing (hand 406: 83 on screen, 99.5 at the table).
 * When the export carries `startStacks` — the table's own account for each seat that has acted this hand, off the
 * WebSocket — every seat it covers is read as dealt minus what the actions say it has put in, the same money
 * `committed` is built from, so `stacks + committed + earlier rounds` is exactly the stack as dealt for every
 * consumer (shapeOf, hrc6max.dealtBySeat, the pickers' depth). Seats it does not cover (not acted yet this hand)
 * keep the reading.
 */
export function withStartStacks(hand: ParsedHand): ParsedHand {
  if (!hand.startStacks || !Object.keys(hand.startStacks).length) return hand;
  const per = roundContributions(hand);
  const stacks: Record<number, number> = { ...(hand.stacks ?? {}) };
  for (const [k, dealt] of Object.entries(hand.startStacks)) {
    const seat = Number(k);
    let spent = 0;
    for (const m of per.values()) spent += m.get(seat) ?? 0;
    stacks[seat] = r2(Math.max(0, dealt - spent));
  }
  return { ...hand, stacks };
}
