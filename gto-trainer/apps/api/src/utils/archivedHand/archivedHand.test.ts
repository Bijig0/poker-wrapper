/**
 * An archived hand rebuilt to one of its decisions (utils/archivedHand) — pinned on hand 723 (Ignition 4919957209),
 * where the hand page's AI-preflop rebuild showed SB 102.5 / BB 103.5 against the SB 103.5 / BB 102.5 tree that had
 * answered live, and looked like the two blinds' stacks swapped.
 *
 * Every payload here is real:
 *   ROW_723 / ROW_719  the hands.db rows (rowid 723 / 719, session_20260923_020036) verbatim, feed lines left out
 *   LIVE_723           the /hand hero's preflop check was answered from: `stacks` are the wrapper's DOM seat
 *                      readings at that moment (debug/session_20260923_020036/log.jsonl seq 415: "102.7 BB" /
 *                      "101.7 BB" / "100 BB"), `committed` the WS posts and call (CO_BLIND_INFO 100 + 200 cents,
 *                      CO_SELECT_INFO call 100), exactly how gto-trainer/apps/wrapper ignition/hand.ts builds them
 *   TRUTH              the raw Ignition WS (debug/ws_dump.jsonl, cents at $1/$2): seat 1 20741 = 103.705bb,
 *                      seat 4 20545 = 102.725bb, seat 6 20000 = 100bb
 */
import { describe, expect, it } from "bun:test";
import { normalizeHand } from "../../feed/normalizeHand/normalizeHand";
import { shapeOf, dealtFromTreeId } from "../../services/gtowAiPreflop";
import { dealtBySeat } from "../../services/hrc6max";
import { truncateAt, startStacksOf, moneyAt, roundContributions, withStartStacks } from "./archivedHand";

const ROW_723 = {"handId":8,"tableSlot":null,"panelPort":7700,"clientHandId":"4919957209","bbCents":200,"heroSeatId":4,"heroCards":["T♠","7♠"],"board":["T♣","4♠","9♣","4♥","2♦"],"street":"river","actions":[{"seatId":1,"hero":false,"type":"post-sb","street":"preflop","amount":0.5},{"seatId":4,"hero":true,"type":"post-bb","street":"preflop","amount":1},{"seatId":6,"hero":false,"type":"fold","street":"preflop"},{"seatId":1,"hero":false,"type":"call","street":"preflop","amount":0.5},{"seatId":4,"hero":true,"type":"check","street":"preflop"},{"seatId":1,"hero":false,"type":"check","street":"flop"},{"seatId":4,"hero":true,"type":"check","street":"flop"},{"seatId":1,"hero":false,"type":"check","street":"turn"},{"seatId":4,"hero":true,"type":"check","street":"turn"},{"seatId":1,"hero":false,"type":"check","street":"river"},{"seatId":4,"hero":true,"type":"bet","street":"river","amount":2},{"seatId":1,"hero":false,"type":"fold","street":"river"}],"liveSeats":[1,4,6],"committed":{"4":2},"potByStreet":{},"positions":{"1":"SB","4":"BB","6":"BTN"},"stacks":{"1":102.7,"2":99.5,"4":101.7,"5":100,"6":100},"currentNode":{"street":"river","toActSeatId":4,"toActIsHero":false,"pot":2,"toCall":0,"legalActions":[],"complete":false},"heroFolded":false,"heroWon":true,"ended":true,"buttonsUp":false,"toActSources":{"buttons":false,"ws":false,"actionOn":true,"wsAt":null,"timeBank":null},"heroStatus":"in-hand","notToActWhy":"hand won","lineSource":"ws","lineUncertain":null,"lineNote":null,"playedAt":1790103913624,"stakes":"$1.00/$2.00","sessionId":"session_20260923_020036","dbId":723,"result":{"winnerSeat":4,"winnerLabel":"Player 4","wonCents":380,"text":"★ Player 4 wins ($3.80).","heroWon":true}};

const ROW_719 = {"handId":4,"tableSlot":null,"panelPort":7700,"clientHandId":"4919956946","bbCents":200,"heroSeatId":4,"heroCards":["5♠","5♣"],"board":["2♦","J♠","J♥"],"street":"flop","actions":[{"seatId":1,"hero":false,"type":"post-sb","street":"preflop","amount":0.5},{"seatId":3,"hero":false,"type":"post-bb","street":"preflop","amount":1},{"seatId":4,"hero":true,"type":"raise","street":"preflop","amount":2.5},{"seatId":1,"hero":false,"type":"fold","street":"preflop"},{"seatId":3,"hero":false,"type":"call","street":"preflop","amount":1.5},{"seatId":3,"hero":false,"type":"check","street":"flop"},{"seatId":4,"hero":true,"type":"bet","street":"flop","amount":1.4},{"seatId":3,"hero":false,"type":"fold","street":"flop"}],"liveSeats":[1,3,4],"committed":{"4":1.4},"potByStreet":{},"positions":{"1":"SB","3":"BB","4":"BTN"},"stacks":{"2":99.5,"3":97.5,"4":97.5,"6":100},"currentNode":{"street":"flop","toActSeatId":4,"toActIsHero":false,"pot":5.5,"toCall":0,"legalActions":[],"complete":false},"heroFolded":false,"heroWon":true,"ended":true,"buttonsUp":false,"toActSources":{"buttons":false,"ws":false,"actionOn":true,"wsAt":null,"timeBank":null},"heroStatus":"in-hand","notToActWhy":"hand won","lineSource":"ws","lineUncertain":null,"lineNote":"the derived line broke an invariant this hand (seat skipped while owing) — event line kept","playedAt":1790103771001,"stakes":"$1.00/$2.00","sessionId":"session_20260923_020036","result":{"text":"★ Player 4 wins ($10.45).","winnerSeat":4,"winnerLabel":"Player 4","wonCents":1045,"heroWon":true},"dbId":719};

/** The live /hand at hero's preflop check (actionIndex 4) — see the header for where each number comes from. */
const LIVE_723 = {
  ...ROW_723,
  board: [], street: "preflop", actions: ROW_723.actions.slice(0, 4), ended: false, heroWon: false, result: undefined,
  stacks: { "1": 102.7, "2": 99.5, "4": 101.7, "5": 100, "6": 100 },
  committed: { "1": 1, "4": 1 },
  currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false },
};

/** What each answer logged (answers.sqlite, client_hand_id 4919957209): the preflop tree, and the tree the postflop
 *  chain walked its flop ranges from before the 2026-09-24 stack pin. */
const LOGGED_PREFLOP_TREE = "gtow-ai · 3-handed · BTN:100/SB:103.5/BB:102.5";
const LOGGED_CHAIN_TREE_PRE_PIN = "gtow-ai · 3-handed · BTN:100/SB:102.5/BB:101.5";

/** The id an AI tree is logged under (fastSolve's AI-preflop gametype / walkArrivalRanges' rangeSource). */
const idOf = (s: ReturnType<typeof shapeOf>) =>
  "error" in s ? s.error : `gtow-ai · ${s.n}-handed · ${s.positions.map((p) => `${p}:${s.stacks[p]}`).join("/")}`;

/** routes/dashboard.ts truncateAt as it was until 2026-09-24: the actions and board cut, the END of the hand's money kept. */
const truncateAtOld = (hand: any, upto: number) => {
  const act = hand.actions[upto];
  const street = act?.street ?? hand.street;
  return { ...hand, actions: hand.actions.slice(0, upto), street, board: hand.board.slice(0, 0), ended: false,
    currentNode: { ...hand.currentNode, street, toActIsHero: act?.hero ?? false, complete: false } };
};

describe("hand 723 (4919957209): the archived row rebuilt to hero's preflop check", () => {
  const hand = normalizeHand(ROW_723).hand;

  it("was read with the END of the hand's money — two errors that look like the blinds swapped", () => {
    const old = shapeOf(truncateAtOld(hand, 4), "BB");
    // SB 102.7 behind at the end + nothing committed on the river; BB 101.7 behind + its 2bb river bet, returned uncalled
    expect(idOf(old)).toBe("gtow-ai · 3-handed · BTN:100/SB:102.5/BB:103.5");
    expect(idOf(old)).not.toBe(LOGGED_PREFLOP_TREE);
  });

  it("the dealt stacks come back from the end state (raw WS: 103.705 / 102.725 / 100)", () => {
    const start = startStacksOf(hand);
    expect(start[1]).toBeCloseTo(103.7, 2);   // 102.7 behind + 0.5 posted + 0.5 completed
    expect(start[4]).toBeCloseTo(102.7, 2);   // 101.7 behind + 1 posted + 2 bet on the river − the 2 returned uncalled
    expect(start[6]).toBe(100);
    expect(start[2]).toBe(99.5);              // sitting out: nothing put in, the reading is the stack
    expect(start[5]).toBe(100);
  });

  it("is the table the live answer read: the same stacks and committed, the same tree", () => {
    const t = truncateAt(hand, 4);
    const live = normalizeHand(LIVE_723).hand;
    for (const seat of [1, 2, 4, 5, 6]) expect(t.stacks![seat]).toBeCloseTo(live.stacks![seat]!, 2);
    expect(t.committed).toEqual({ 1: 1, 4: 1 });
    expect(t.currentNode.toCall).toBe(0);
    expect(t.currentNode.pot).toBe(0);         // the wrapper's pot is the closed rounds' chips: none yet preflop
    expect(t.actions).toHaveLength(4);
    expect(t.board).toEqual([]);
    expect(t.ended).toBe(false);
    expect(idOf(shapeOf(live, "BB"))).toBe(LOGGED_PREFLOP_TREE);
    expect(idOf(shapeOf(t, "BB"))).toBe(LOGGED_PREFLOP_TREE);
  });

  it("every later street's pinned read conditions on the same tree the preflop answer came from", () => {
    for (const upto of [6, 8, 10]) {                  // hero's flop, turn and river decisions
      const t = truncateAt(hand, upto);
      const dealt = dealtBySeat(t);
      expect(dealt[1]).toBeCloseTo(103.7, 2);
      expect(dealt[4]).toBeCloseTo(102.7, 2);
      expect(idOf(shapeOf(t, "BB", 0, undefined, dealt))).toBe(LOGGED_PREFLOP_TREE);
      expect(t.committed).toEqual({});                 // nothing in on those streets before hero acts
      expect(t.currentNode.pot).toBe(2);
    }
    // the chain's own tree before the 2026-09-24 pin (shapeOf without `dealt` at the flop: behind + this round only)
    expect(idOf(shapeOf(truncateAt(hand, 6), "BB"))).toBe(LOGGED_CHAIN_TREE_PRE_PIN);
  });

  it("the logged tree id maps back onto the seats it was built from", () => {
    const t = truncateAt(hand, 4);
    const dealt = dealtFromTreeId(t, "BB", LOGGED_PREFLOP_TREE);
    expect(dealt).toEqual({ 6: 100, 1: 103.5, 4: 102.5 });
    expect(idOf(shapeOf(t, "BB", 0, undefined, dealt!))).toBe(LOGGED_PREFLOP_TREE);
    // …even from the old end-of-hand truncation, which is what a stale caller still holds
    expect(idOf(shapeOf(truncateAtOld(hand, 4), "BB", 0, undefined, dealtFromTreeId(truncateAtOld(hand, 4), "BB", LOGGED_PREFLOP_TREE)!))).toBe(LOGGED_PREFLOP_TREE);
  });
});

describe("hand 719 (4919956946): an uncalled flop bet, and a seat that left before the hand was archived", () => {
  const hand = normalizeHand(ROW_719).hand;

  it("the flop bet nobody called is back behind the bettor (raw WS: hero 100, BB 100)", () => {
    const start = startStacksOf(hand);
    expect(start[4]).toBeCloseTo(100, 2);   // 97.5 + 2.5 + 1.4 − 1.4
    expect(start[3]).toBeCloseTo(100, 2);   // 97.5 + 1 + 1.5
    expect(start[1]).toBeUndefined();        // the SB stood up: no reading, so no estimate (read as unreadable, as before)
  });

  it("hero's open is rebuilt to the posts only; the logged tree restores the seat the archive lost", () => {
    const t = truncateAt(hand, 2);
    expect(t.stacks![4]).toBeCloseTo(100, 2);
    expect(t.stacks![3]).toBeCloseTo(99, 2);
    expect(t.committed).toEqual({ 1: 0.5, 3: 1 });
    expect(t.currentNode.toCall).toBe(1);
    // from the archive alone the SB is unreadable (shapeOf's 100 default; the WS says 101.5) …
    expect(idOf(shapeOf(t, "BTN"))).toBe("gtow-ai · 3-handed · BTN:100/SB:100/BB:100");
    // … the answer's own tree has it
    const logged = "gtow-ai · 3-handed · BTN:100/SB:101.5/BB:100";
    expect(idOf(shapeOf(t, "BTN", 0, undefined, dealtFromTreeId(t, "BTN", logged)!))).toBe(logged);
  });
});

describe("hand 399 (4919173964): hero's 3-bet took the pot preflop", () => {
  // hands.db rowid 399 verbatim (feed lines left out); raw WS: BTN 23794 = 118.97bb, SB 20500 = 102.5, hero 20000 = 100
  const ROW_399 = {"handId":4,"clientHandId":"4919173964","bbCents":200,"heroSeatId":6,"heroCards":["Q♠","Q♦"],"board":[],"street":"preflop","actions":[{"seatId":3,"hero":false,"type":"post-sb","street":"preflop","amount":0.5},{"seatId":6,"hero":true,"type":"post-bb","street":"preflop","amount":1},{"seatId":1,"hero":false,"type":"raise","street":"preflop","amount":2.5},{"seatId":3,"hero":false,"type":"fold","street":"preflop"},{"seatId":6,"hero":true,"type":"raise","street":"preflop","amount":8.8},{"seatId":1,"hero":false,"type":"fold","street":"preflop"}],"liveSeats":[1,3,6],"committed":{"1":2.5,"3":0.5,"6":8.8},"potByStreet":{},"positions":{"1":"BTN","3":"SB","6":"BB"},"stacks":{"1":116.5,"2":100,"3":102,"4":128.6,"5":101.2,"6":97.5},"currentNode":{"street":"preflop","toActSeatId":6,"toActIsHero":true,"pot":5.5,"toCall":0,"legalActions":[],"complete":false},"heroFolded":false,"heroWon":true,"ended":true,"buttonsUp":false,"toActSources":{"buttons":false,"ws":false,"actionOn":true,"wsAt":null,"timeBank":null},"heroStatus":"in-hand","notToActWhy":"hand won","lineSource":"ws","lineUncertain":null,"lineNote":null,"playedAt":1789787350773,"stakes":"$1.00/$2.00","sessionId":"session_20260919_100647","dbId":399};
  const hand = normalizeHand(ROW_399).hand;

  it("the part of hero's raise nobody called is already back behind hero when the row is written", () => {
    const start = startStacksOf(hand);
    expect(start[6]).toBeCloseTo(100, 2);    // 97.5 + 8.8 − the 6.3 the BTN never called
    expect(start[1]).toBeCloseTo(119, 2);    // 116.5 + 2.5 (the WS: 118.97 — the table shows a tenth)
    expect(start[3]).toBeCloseTo(102.5, 2);
  });

  it("hero's 3-bet decision rebuilds the tree that answered it", () => {
    // answers.sqlite id 1067: chart "gtow-ai · 3-handed · BTN:119/SB:102.5/BB:100"
    expect(idOf(shapeOf(truncateAt(hand, 4), "BB"))).toBe("gtow-ai · 3-handed · BTN:119/SB:102.5/BB:100");
    // the end-of-hand money read hero's 8.8 still committed on top of a stack that already had 6.3 of it back
    expect(idOf(shapeOf(truncateAtOld(hand, 4), "BB"))).toBe("gtow-ai · 3-handed · BTN:119/SB:102.5/BB:106.5");
  });
});

describe("moneyAt / roundContributions", () => {
  const hand = normalizeHand(ROW_719).hand;

  it("a raise and a post are round totals, a call adds", () => {
    const pre = roundContributions(hand).get("preflop")!;
    expect(pre.get(4)).toBe(2.5);
    expect(pre.get(3)).toBe(2.5);            // posted 1, called 1.5
    expect(pre.get(1)).toBe(0.5);
  });

  it("recorded dealt stacks win over the estimate, seat by seat", () => {
    const withStart = normalizeHand({ ...ROW_719, startStacks: { "1": 101.5, "4": 100 } }).hand;
    expect(withStart.startStacks).toEqual({ 1: 101.5, 4: 100 });
    const start = startStacksOf(withStart);
    expect(start[1]).toBe(101.5);
    expect(start[3]).toBeCloseTo(100, 2);    // not recorded: still the estimate
    const m = moneyAt(withStart, 2);
    expect(m.stacks[1]).toBeCloseTo(101, 2); // 101.5 dealt − the 0.5 posted
    expect(idOf(shapeOf(truncateAt(withStart, 2), "BTN"))).toBe("gtow-ai · 3-handed · BTN:100/SB:101.5/BB:100");
  });
});

describe("dealtFromTreeId", () => {
  const t = truncateAt(normalizeHand(ROW_723).hand, 4);

  it("refuses what is not an AI tree of this hand's shape", () => {
    expect(dealtFromTreeId(t, "BB", "ign200_6max_D100_o2_5")).toBeNull();
    expect(dealtFromTreeId(t, "BB", null)).toBeNull();
    expect(dealtFromTreeId(t, "BB", "gtow-ai · 2-handed · SB:100/BB:100")).toBeNull();
    expect(dealtFromTreeId(t, "BB", "gtow-ai · 3-handed · CO:100/SB:103.5/BB:102.5")).toBeNull();
  });

  it("heads-up, the dealer who posted the small blind is the tree's SB", () => {
    const hu = normalizeHand({
      ...ROW_719, positions: { "1": "BTN", "3": "BB" }, liveSeats: [1, 3], heroSeatId: 3,
      actions: [{ seatId: 1, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 3, hero: true, type: "post-bb", street: "preflop", amount: 1 }],
      stacks: { "1": 80, "3": 120 }, committed: { "1": 0.5, "3": 1 }, board: [], street: "preflop",
    }).hand;
    expect(dealtFromTreeId(hu, "BB", "gtow-ai · 2-handed · SB:80.5/BB:121")).toEqual({ 1: 80.5, 3: 121 });
  });
});

describe("withStartStacks (a live hand carrying the WS stacks as dealt)", () => {
  // hand 723 at hero's preflop check, as the wrapper exports it once it records startStacks (the raw WS: 20741 /
  // 20545 / 20000 cents at $1/$2)
  const START = { "1": 103.71, "4": 102.73, "6": 100 };

  it("reads each covered seat as dealt minus what it has put in — the table the WS saw", () => {
    const live = withStartStacks(normalizeHand({ ...LIVE_723, startStacks: START }).hand);
    expect(live.stacks![1]).toBeCloseTo(102.71, 2);    // 103.71 dealt − 0.5 posted − 0.5 completed
    expect(live.stacks![4]).toBeCloseTo(101.73, 2);    // 102.73 − 1 posted
    expect(live.stacks![6]).toBe(100);                 // folded, nothing in
    expect(live.stacks![2]).toBe(99.5);                // not dealt: the screen's reading stays
    expect(idOf(shapeOf(live, "BB"))).toBe(LOGGED_PREFLOP_TREE);
  });

  it("a blind the screen has not taken off yet is no longer counted twice", () => {
    // the screen still shows the BB's 102.73 while the WS already has its post in `committed`
    const lagged = normalizeHand({ ...LIVE_723, stacks: { ...LIVE_723.stacks, "4": 102.73 }, startStacks: START }).hand;
    expect(idOf(shapeOf(lagged, "BB"))).toBe("gtow-ai · 3-handed · BTN:100/SB:103.5/BB:103.5");   // the reading: 1bb long
    expect(idOf(shapeOf(withStartStacks(lagged), "BB"))).toBe(LOGGED_PREFLOP_TREE);
  });

  it("a hand without startStacks is returned as it came", () => {
    const h = normalizeHand(LIVE_723).hand;
    expect(withStartStacks(h)).toBe(h);
  });
});

describe("the table's own chip counts (round 3) never survive a cut", () => {
  it("truncateAt drops wsStack / wsInFront / wsDead: the export's moment, not the cut decision's", async () => {
    const { lostActionFaults } = await import("../repairPostflopRotation/repairPostflopRotation");
    // ROW_723 as a live export at its END would carry every seat's final chips: the SB's river check-fold left 102.705
    const withWs = normalizeHand({ ...ROW_723, startStacks: { 1: 103.705, 4: 102.725, 6: 100 }, wsStack: { 1: 102.705, 4: 99.725, 6: 100 },
      wsInFront: { 1: 0, 4: 2, 6: 0 } }).hand;
    expect(withWs.wsStack).toBeDefined();
    const cut = truncateAt(withWs, 4);
    expect("wsStack" in cut || "wsInFront" in cut || "wsDead" in cut).toBe(false);
    // …which would otherwise read as hero's river bet "missing" from the preflop line
    expect(lostActionFaults({ ...cut, wsStack: withWs.wsStack, wsInFront: withWs.wsInFront })).not.toEqual([]);
    expect(lostActionFaults(cut)).toEqual([]);
  });
});
