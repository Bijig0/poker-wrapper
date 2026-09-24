/**
 * THE CHIP LEDGER IN THE CAPTURE GATE + THE POSTFLOP FOLD REPAIR (2026-09-25, input-mutation harness). Fixtures are
 * the harness's own failing exports (src/scripts/mutationHarness.ts, `dropped-call` / `late-fold`), cut to the
 * fields the gate reads. Pure: no charts, no GTO Wizard.
 */
import { describe, expect, it } from "bun:test";
import { captureFaults, lostActionFaults, repairPostflopCapture } from "./repairPostflopRotation";
import type { ParsedHand, ParsedAction } from "../../feed/parsePanelFeed/parsePanelFeed";

const act = (seatId: number, type: string, street: string, amount?: number, hero = false): ParsedAction =>
  ({ seatId, hero, type, street, ...(amount != null ? { amount } : {}) }) as ParsedAction;
const SIX = { 1: "SB", 2: "BB", 3: "UTG", 4: "HJ", 5: "CO", 6: "BTN" };

const hand = (o: { actions: ParsedAction[]; hero: number; street?: string; board?: string[]; committed?: Record<number, number>; pot?: number; toCall?: number; anteBb?: number; positions?: Record<number, string> }): ParsedHand => ({
  handId: 1, clientHandId: "t", heroSeatId: o.hero, heroCards: ["Ah", "Kd"], board: o.board ?? [], street: o.street ?? "preflop",
  actions: o.actions, liveSeats: Object.keys(o.positions ?? SIX).map(Number), committed: o.committed ?? {}, potByStreet: {},
  positions: o.positions ?? SIX, ...(o.anteBb != null ? { anteBb: o.anteBb } : {}),
  currentNode: { street: o.street ?? "preflop", toActSeatId: o.hero, toActIsHero: true, pot: o.pot ?? 0, toCall: o.toCall ?? 0, legalActions: [], complete: false },
  ended: false,
}) as ParsedHand;

const blinds = [act(1, "post-sb", "preflop", 0.5), act(2, "post-bb", "preflop", 1)];

describe("lostActionFaults — 1. this round's chips against this round's actions", () => {
  // harness seed 26 [dropped-call]: HJ opens 3, CO calls (lost), hero BTN to act
  const line = [...blinds, act(3, "fold", "preflop"), act(4, "raise", "preflop", 3)];
  const committed = { 1: 0.5, 2: 1, 4: 3, 5: 3 };

  it("a villain with chips in front of him and no captured action is a lost action, named", () => {
    const f = lostActionFaults(hand({ actions: line, hero: 6, committed, pot: 7.5, toCall: 3 }));
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("CO has 3bb in front of them on the preflop but the captured preflop actions put in 0bb");
    expect(f[0]).toContain("folded");
    // and it reaches the shared gate every piece reads
    expect(captureFaults(hand({ actions: line, hero: 6, committed, pot: 7.5, toCall: 3 })).some((x) => /CO has 3bb in front of them/.test(x))).toBe(true);
  });

  it("is silent once the call is in the line", () => {
    expect(lostActionFaults(hand({ actions: [...line, act(5, "call", "preflop", 3)], hero: 6, committed, pot: 7.5, toCall: 3 }))).toEqual([]);
  });

  it("a small blind that completed with the call lost reads as short, not folded", () => {
    const f = lostActionFaults(hand({ actions: [...blinds, act(3, "fold", "preflop"), act(4, "fold", "preflop"), act(5, "fold", "preflop"), act(6, "fold", "preflop")], hero: 2, committed: { 1: 1, 2: 1 }, pot: 2 }));
    expect(f).toEqual([expect.stringContaining("SB has 1bb in front of them on the preflop but the captured preflop actions put in 0.5bb")]);
    expect(f[0]).toContain("short");
  });

  it("a call lost before a fold is flagged too: the line would read 'open, fold' where the table saw 'open, call, fold'", () => {
    // harness seed 152 [dropped-call]: CO calls the open (lost), SB 3-bets, CO folds to the 4-bet — the 3-bettor's
    // node read from the capture has no caller in it
    const f = lostActionFaults(hand({ actions: [...line, act(5, "fold", "preflop")], hero: 6, committed, pot: 7.5, toCall: 3 }));
    expect(f).toEqual([expect.stringContaining("CO has 3bb in front of them on the preflop but the captured preflop actions put in 0bb")]);
    expect(f[0]).toContain("folding without ever putting chips in");
  });

  it("a new player's posted blind (1bb, no action — the reader does not record Ignition's btn-8 post) is refused too", () => {
    const f = lostActionFaults(hand({ actions: blinds, hero: 4, committed: { 1: 0.5, 2: 1, 3: 1 }, pot: 2.5, toCall: 1 }));
    expect(f).toEqual([expect.stringContaining("UTG has 1bb in front of them on the preflop")]);
    expect(f[0]).toContain("posted blind");
  });

  it("an export with no committed map is unknown, not a fault", () => {
    expect(lostActionFaults(hand({ actions: line, hero: 6, pot: 0, toCall: 3 }))).toEqual([]);
  });
});

describe("lostActionFaults — 2. a seat that plays on after a round it never matched", () => {
  // archive rows 451 / 489 / 538: the BB's call of a raise is missing, and the BB then acts on the flop
  const pre = [...blinds, act(3, "raise", "preflop", 3, true), act(4, "fold", "preflop"), act(5, "fold", "preflop"), act(6, "fold", "preflop"), act(1, "fold", "preflop")];

  it("the BB bets the flop with 1bb in a preflop round that went to 3bb: his call was lost", () => {
    const f = lostActionFaults(hand({ actions: [...pre, act(2, "bet", "flop", 2)], hero: 3, street: "flop", board: ["2c", "7d", "Ts"], committed: { 2: 2 }, toCall: 2 }));
    expect(f).toEqual([expect.stringContaining("BB acts on the flop but put 1bb into a preflop round that went to 3bb")]);
  });

  it("is silent when the call is captured", () => {
    expect(lostActionFaults(hand({ actions: [...pre, act(2, "call", "preflop", 2), act(2, "bet", "flop", 2)], hero: 3, street: "flop", board: ["2c", "7d", "Ts"], committed: { 2: 2 }, toCall: 2 }))).toEqual([]);
  });

  it("a short seat that has not acted since may have folded uncaptured — the tap misses folds — so it is not flagged", () => {
    expect(lostActionFaults(hand({ actions: pre, hero: 3, street: "flop", board: ["2c", "7d", "Ts"] }))).toEqual([]);
  });

  it("an all-in for less is not a lost call", () => {
    const short = [...blinds, act(3, "raise", "preflop", 10, true), act(4, "all-in", "preflop", 6), act(5, "fold", "preflop"), act(6, "fold", "preflop"), act(1, "fold", "preflop"), act(2, "fold", "preflop")];
    expect(lostActionFaults(hand({ actions: short, hero: 3, street: "flop", board: ["2c", "7d", "Ts"] }))).toEqual([]);
  });
});

describe("lostActionFaults — 3. the table's pot against the captured chips", () => {
  // harness seed 26 [dropped-call] at the flop: HJ 3, CO calls 3 (lost), hero BTN 3-bets 13.5, HJ calls, CO folds.
  // The pot holds CO's 3bb; the capture's preflop adds to 28.5.
  const pre = [...blinds, act(3, "fold", "preflop"), act(4, "raise", "preflop", 3), act(6, "raise", "preflop", 13.5, true),
    act(1, "fold", "preflop"), act(2, "fold", "preflop"), act(4, "call", "preflop", 10.5), act(5, "fold", "preflop")];
  const flop = (pot: number, extra: ParsedAction[] = [], committed: Record<number, number> = {}) =>
    hand({ actions: [...pre, ...extra], hero: 6, street: "flop", board: ["Qd", "Qh", "5c"], pot, committed });

  it("3bb in the pot with no action behind it is a lost call", () => {
    const f = lostActionFaults(flop(31.5));
    expect(f).toEqual([expect.stringContaining("the table's pot is 31.5bb but the captured actions account for 28.5bb — 3bb went in")]);
  });

  it("a pot that matches (Ignition: the closed rounds; the harness: closed + this round) is silent", () => {
    expect(lostActionFaults(flop(28.5))).toEqual([]);
    expect(lostActionFaults(flop(38.5, [act(4, "bet", "flop", 10)], { 4: 10 }))).toEqual([]);
  });

  it("a pot SMALLER than the capture (an uncalled excess returned, the rake, a pot not updated yet) is never a fault", () => {
    expect(lostActionFaults(flop(20))).toEqual([]);
  });

  it("0.6bb of slack: a returning player's dead small blind is not a lost action", () => {
    expect(lostActionFaults(flop(29))).toEqual([]);
  });

  it("CoinPoker antes are in the pot, not in the actions — counted per dealt seat", () => {
    const hu = { 1: "SB", 2: "BB" };
    const line = [act(1, "post-sb", "preflop", 0.4, true), act(2, "post-bb", "preflop", 1), act(1, "raise", "preflop", 2.48, true), act(2, "call", "preflop", 1.48)];
    expect(lostActionFaults(hand({ actions: line, hero: 1, street: "flop", board: ["2c", "7d", "Ts"], pot: 5.36, anteBb: 0.2, positions: hu }))).toEqual([]);
    // the same pot without the ante accounted is 0.4bb over — still inside the slack; a lost 3bb bet is not
    expect(lostActionFaults(hand({ actions: line, hero: 1, street: "flop", board: ["2c", "7d", "Ts"], pot: 8.36, anteBb: 0.2, positions: hu }))).toHaveLength(1);
  });
});

describe("a fold the capture never got (harness `missed-fold`)", () => {
  // seed 3: CO (hero) opens, BTN calls, SB 3-bets, BB 4-bets, CO calls, BTN folds (LOST), SB folds; flop CO vs BB
  const four = { 1: "BTN", 2: "SB", 4: "BB", 6: "CO" };
  const line = [act(2, "post-sb", "preflop", 0.5), act(4, "post-bb", "preflop", 1), act(6, "raise", "preflop", 2.5, true),
    act(1, "call", "preflop", 2.5), act(2, "raise", "preflop", 10), act(4, "raise", "preflop", 25), act(6, "call", "preflop", 22.5, true),
    act(2, "fold", "preflop"), act(4, "bet", "flop", 46.88)];
  const h = hand({ actions: line, hero: 6, street: "flop", board: ["2d", "Qc", "Ad"], positions: four, committed: { 4: 46.88 }, pot: 99.38, toCall: 46.88 });

  it("in a later orbit the fold is written into its slot, so the next seat's fold is not handed to him", () => {
    const r = repairPostflopCapture(h);
    expect(r.faults).toEqual([]);
    expect(r.notes.join(" ")).toContain("FOLDS NOT CAPTURED: BTN");
    const pre = r.hand.actions.filter((a) => a.street === "preflop" && !a.type.startsWith("post"));
    expect(pre.map((a) => `${four[a.seatId as 1]}:${a.type}`)).toEqual(["CO:raise", "BTN:call", "SB:raise", "BB:raise", "CO:call", "BTN:fold", "SB:fold"]);
  });

  it("in the opening orbit it is left to the token builders' padding — and a seat that never plays on is no fault", () => {
    // seed 12-style: UTG's fold lost before anyone else acted; the flop is HJ vs BB
    const six = hand({ actions: [...blinds, act(4, "raise", "preflop", 2.5), act(5, "fold", "preflop"), act(6, "fold", "preflop"), act(1, "fold", "preflop"),
      act(2, "call", "preflop", 1.5, true), act(2, "check", "flop", undefined, true)], hero: 2, street: "flop", board: ["2c", "7d", "Ts"], pot: 5.5 });
    const r = repairPostflopCapture(six);
    expect(r.faults).toEqual([]);
    expect(r.notes).toEqual([]);
    // the seat that acts on the flop with no preflop action is still refused (hand 4919432609)
    const ghost = hand({ ...six, actions: [...six.actions, act(3, "bet", "flop", 2)], hero: 2, street: "flop", board: ["2c", "7d", "Ts"], pot: 5.5, committed: { 3: 2 } } as any);
    expect(captureFaults(ghost).some((f) => /UTG reached the flop with no preflop action captured/.test(f))).toBe(true);
  });
});

describe("repairPostflopCapture — a preflop fold filed late is repaired at the flop too", () => {
  // harness seed 2 [late-fold]: UTG's fold was filed after HJ's; every preflop decision was answered (the preflop
  // gate moves it), and the flop refused the same line as "UTG acted before CO, SB, BB were to act"
  const line = [...blinds, act(4, "fold", "preflop"), act(3, "fold", "preflop"), act(5, "raise", "preflop", 2.5, true),
    act(6, "fold", "preflop"), act(1, "call", "preflop", 2), act(2, "call", "preflop", 1.5),
    act(1, "bet", "flop", 2.48), act(2, "call", "flop", 2.48)];
  const h = hand({ actions: line, hero: 5, street: "flop", board: ["7d", "5d", "Kh"], pot: 12.46, committed: { 1: 2.48, 2: 2.48 }, toCall: 2.48 });

  it("the raw capture is refused by the rotation rule (what the flop used to answer with)", () => {
    expect(captureFaults(h).some((f) => /UTG acted before .* (was|were) to act/.test(f))).toBe(true);
  });

  it("the gate moves the fold, finds no fault, and says so", () => {
    const r = repairPostflopCapture(h);
    expect(r.faults).toEqual([]);
    expect(r.notes.join(" ")).toContain("FOLDS FILED LATE: UTG's fold");
    expect(r.hand.actions.filter((a) => a.street === "preflop").map((a) => a.seatId)).toEqual([1, 2, 3, 4, 5, 6, 1, 2]);
    // postflop actions stay as captured
    expect(r.hand.actions.slice(-2)).toEqual(line.slice(-2));
  });

  it("a clean capture passes through untouched", () => {
    const clean = hand({ actions: [...blinds, ...line.slice(3, 4), ...line.slice(2, 3), ...line.slice(4)], hero: 5, street: "flop", board: ["7d", "5d", "Kh"], pot: 12.46, committed: { 1: 2.48, 2: 2.48 }, toCall: 2.48 });
    const r = repairPostflopCapture(clean);
    expect(r).toEqual({ hand: clean, notes: [], faults: [] });
  });
});

/**
 * POSTED-IN PLAYERS IN THE CHIP LEDGER (2026-09-25, round 2 of the input-mutation harness, `post-in` operator:
 * 178 preflop and 36 postflop capture faults in 300 seeds). normalizeHand takes the post out of the line and carries
 * it on the poster's own next action (utils/foldPostIns) — so a poster who has NOT acted yet has 1bb in front of him
 * and no action, and a poster who FOLDED left 1bb in the pot with no action carrying it. The gate read both as a lost
 * action and refused a real table's state (seed 1: CO posts in, hero HJ opens — "CO has 1bb in front of them …").
 */
/**
 * A LOST CALL BY A SEAT THAT FOLDS ON A LATER STREET (round 2, harness triples: seeds 27947 [post-in + dropped-call] and
 * 30764 [dropped-call + post-in + nl5]). The SB's complete never reached the capture; he bet the flop and checked the
 * turn — refused as "SB acts on the flop but put 0.5bb into a preflop round that went to 1bb" — then folded the turn,
 * and from the river on the hand was ANSWERED: rule 2 skipped every seat that ever folded, and 0.5bb sits inside the pot
 * ledger's 0.6bb slack. A seat that played a later street had matched every round before it, fold or no fold.
 */
describe("lostActionFaults — 2. a lost call by a seat that folds later", () => {
  // UTG, HJ, CO fold, the BTN limps, the SB completes (LOST), hero BB checks
  const line = [...blinds, act(3, "fold", "preflop"), act(4, "fold", "preflop"), act(5, "fold", "preflop"), act(6, "call", "preflop", 1),
    act(2, "check", "preflop"), act(1, "bet", "flop", 1), act(2, "call", "flop", 1, true), act(6, "call", "flop", 1),
    act(1, "check", "turn"), act(2, "bet", "turn", 2, true), act(6, "call", "turn", 2), act(1, "fold", "turn")];
  it("is still a lost call after he folds", () => {
    const f = lostActionFaults(hand({ actions: line, hero: 2, street: "river", board: ["2c", "7d", "9s", "Kh", "3c"], pot: 9.5 }));
    expect(f.some((x) => x.includes("SB acts on the turn but put 0.5bb into a preflop round that went to 1bb"))).toBe(true);
  });
});

describe("lostActionFaults — posted-in players", () => {
  const P = (seatId: number, type: string, amount?: number, street = "preflop", hero = false) =>
    ({ seatId, hero, type, street, ...(amount != null ? { amount } : {}) });
  it("a poster yet to act: his post is in front of him, not a lost action", async () => {
    const { normalizeHand } = await import("../../feed/normalizeHand/normalizeHand");
    const raw = { handId: 1, clientHandId: "t", heroSeatId: 4, heroCards: ["Kd", "Qh"], board: [], street: "preflop",
      actions: [P(1, "post-sb", 0.5), P(2, "post-bb", 1), P(5, "post", 1), P(3, "fold")],
      liveSeats: [1, 2, 3, 4, 5, 6], committed: { 1: 0.5, 2: 1, 5: 1 }, potByStreet: {}, positions: SIX,
      currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 1, legalActions: [], complete: false } };
    expect(lostActionFaults(normalizeHand(raw).hand!)).toEqual([]);
  });
  // round 2 (harness unlabelled-seat + post-in, seed 199): the poster's label is missing and he has not acted yet —
  // his post was folded out of the line, so the UNLABELLED ACTOR rule never saw him and the hand was answered with a
  // live player's chips on no seat
  it("a poster with no position label is an unlabelled actor, refused like any other", async () => {
    const { normalizeHand } = await import("../../feed/normalizeHand/normalizeHand");
    const { 5: _co, ...noCo } = SIX;
    const raw = { handId: 1, clientHandId: "t", heroSeatId: 4, heroCards: ["Kd", "Qh"], board: [], street: "preflop",
      actions: [P(1, "post-sb", 0.5), P(2, "post-bb", 1), P(5, "post", 1), P(3, "fold")],
      liveSeats: [1, 2, 3, 4, 5, 6], committed: { 1: 0.5, 2: 1, 5: 1 }, potByStreet: {}, positions: noCo,
      currentNode: { street: "preflop", toActSeatId: 4, toActIsHero: true, pot: 0, toCall: 1, legalActions: [], complete: false } };
    expect(captureFaults(normalizeHand(raw).hand!)).toContain("seat 5 posted in on the preflop but has no position label");
  });
  it("a poster who folded: his post is dead money in the pot, not a lost call", async () => {
    const { normalizeHand } = await import("../../feed/normalizeHand/normalizeHand");
    const raw = { handId: 1, clientHandId: "t", heroSeatId: 6, heroCards: ["Kd", "Qh"], board: ["2c", "7d", "9s"], street: "flop",
      actions: [P(1, "post-sb", 0.5), P(2, "post-bb", 1), P(5, "post", 1), P(3, "fold"), P(4, "fold"), P(5, "fold"),
        P(6, "raise", 2.5, "preflop", true), P(1, "fold"), P(2, "call", 1.5), P(2, "check", undefined, "flop")],
      liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: SIX,
      currentNode: { street: "flop", toActSeatId: 6, toActIsHero: true, pot: 6.5, toCall: 0, legalActions: [], complete: false } };
    expect(lostActionFaults(normalizeHand(raw).hand!)).toEqual([]);
  });
});
