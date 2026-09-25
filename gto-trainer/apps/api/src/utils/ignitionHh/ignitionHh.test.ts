import { describe, expect, test } from "bun:test";
import { compareHand, compareThroughHero, parseIgnitionHh } from "./ignitionHh";
import { archived4920544353 as archived, faithful4920544353, record4920544353 as body } from "./fixtures";

describe("parseIgnitionHh", () => {
  const h = parseIgnitionHh(body);
  test("reads the record into our seats, streets and bb amounts", () => {
    expect(h.bbCents).toBe(5);
    expect(h.board).toEqual(["6s", "8h", "Ks", "Qh"]);
    expect(h.heroCards).toEqual(["Kd", "Jh"]);
    expect(h.seats.map((s) => [s.seat, s.startBb])).toEqual([[1, 52.4], [2, 34], [3, 104.4], [4, 226.6], [5, 100], [6, 34.2]]);
    expect(h.seats.find((s) => s.hero)?.seat).toBe(5);
    expect(h.actions).toHaveLength(18);
    expect(h.actions[4]).toMatchObject({ seat: 5, type: "raise", amountBb: 2.6, street: "preflop" });
    expect(h.actions[16]).toMatchObject({ seat: 6, type: "all-in", amountBb: 21.6, street: "turn" });
    expect(h.other.map((o) => o.label)).toContain("Return uncalled portion of bet");
  });
  test("the log keeps Ignition's order, each betting line pointing at its action", () => {
    expect(h.log.length).toBe(h.actions.length + h.other.length);
    expect(h.log.filter((l) => l.action != null).map((l) => l.action)).toEqual(h.actions.map((_, i) => i));
    expect(h.log.find((l) => l.label === "Return uncalled portion of bet")).toMatchObject({ seat: 6, street: "turn", action: null });
  });
});

describe("Ignition's labels", () => {
  const act = (position: string, action: string, ...data: string[]) => ({ position, action, data });
  const hh = parseIgnitionHh({
    blinds: "$0.02 / $0.05",
    communityCards: ["2c", "7d", "9h", "", ""],
    players: [
      { seat: "1", position: "Small Blind", cards: [], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: false },
      { seat: "2", position: "Big Blind  [ME]", cards: ["As", "Ks"], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: true },
      { seat: "3", position: "UTG", cards: [], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: false },
      { seat: "4", position: "Dealer", cards: [], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: false },
    ],
    action: [
      act("Small Blind", "Small Blind", "$0.02"), act("Big Blind  [ME]", "Big blind", "$0.05"), act("UTG", "Posts chip", "$0.05"),
      act("Dealer", "Folds (timeout)"), act("Small Blind", "Folds (disconnect)"), act("UTG", "Checks"), act("Big Blind  [ME]", "Checks (timeout)"),
      act("", "FLOP", "2c", "7d", "9h"), act("Big Blind  [ME]", "Bets", "$0.10"), act("UTG", "All-in(raise)", "$4.95"), act("Big Blind  [ME]", "Folds (auth)"),
    ],
  });
  test("timeout / disconnect / auth variants are the plain action, All-in(raise) is an all-in to its total", () => {
    expect(hh.actions.map((a) => `${a.seat}:${a.type}${a.amountBb != null ? ` ${a.amountBb}` : ""}`)).toEqual([
      "1:post-sb 0.4", "2:post-bb 1", "3:call 1", "4:fold", "1:fold", "2:check", "2:bet 2", "3:all-in 99", "2:fold",
    ]);
  });
  test("a post-in is the poster's limp: its free-option check is not a second action", () => {
    expect(hh.other.map((o) => `${o.position} ${o.label}`)).toEqual(["UTG Checks"]);
  });
  test("a post-in pairs with the poster's call or check wherever the reader filed it", () => {
    const ours = (posterType: "call" | "check") => ({
      ...archived, heroSeatId: 2, heroCards: ["As", "Ks"], board: ["2c", "7d", "9h"], liveSeats: [1, 2, 3, 4], startStacks: undefined, stacks: undefined,
      actions: [
        { seatId: 1, hero: false, type: "post-sb" as const, amount: 0.4, street: "preflop" as const },
        { seatId: 2, hero: true, type: "post-bb" as const, amount: 1, street: "preflop" as const },
        { seatId: 4, hero: false, type: "fold" as const, street: "preflop" as const },
        { seatId: 1, hero: false, type: "fold" as const, street: "preflop" as const },
        { seatId: 3, hero: false, type: posterType, ...(posterType === "call" ? { amount: 1 } : {}), street: "preflop" as const },
        { seatId: 2, hero: true, type: "check" as const, street: "preflop" as const },
        { seatId: 2, hero: true, type: "bet" as const, amount: 2, street: "flop" as const },
        { seatId: 3, hero: false, type: "all-in" as const, amount: 99, street: "flop" as const },
        { seatId: 2, hero: true, type: "fold" as const, street: "flop" as const },
      ],
    });
    expect(compareHand(ours("call"), hh)).toEqual([]);
    expect(compareHand(ours("check"), hh)).toEqual([]);
  });
});

describe("compareHand", () => {
  test("a shove the reader filed as a raise matches Ignition's all-in", () => {
    const ign = parseIgnitionHh(body);
    const asRaise = { ...faithful4920544353, actions: faithful4920544353.actions
      .map((a) => (a.type === "all-in" ? { ...a, type: "raise" as const, amount: 21.6 } : a)) };
    expect(compareHand(asRaise, ign)).toEqual([]);
  });

  test("through hero's last action: what happened after the fold is not held against the capture", () => {
    expect(compareThroughHero(archived, parseIgnitionHh(body))).toEqual([]);
    const missed = { ...archived, actions: archived.actions.filter((_, i) => i !== 3) };
    expect(compareThroughHero(missed, parseIgnitionHh(body)).map((d) => d.kind)).toEqual(["action-missing"]);
  });

  test("a recording that stopped before hero acted keeps what it has: only the actions it never got are missing", () => {
    const blindsOnly = { ...archived, board: [], actions: archived.actions.slice(0, 2) };
    const d = compareThroughHero(blindsOnly, parseIgnitionHh(body));
    expect(d[0]!.kind).toBe("board");
    expect(d.slice(1).every((x) => x.kind === "action-missing")).toBe(true);
    expect(d.slice(1).map((x) => x.ignitionAt)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  test("flags exactly the rabbit-hunt card and the phantom fold", () => {
    const d = compareHand(archived, parseIgnitionHh(body));
    expect(d.map((x) => x.kind)).toEqual(["board-extra", "action-extra"]);
    expect(d[1]).toMatchObject({ field: "action 19 only in ours", oursAt: 18 });
    expect(d[0]!.note).toContain("never dealt");
  });

  test("a faithful capture has no differences", () => {
    expect(compareHand(faithful4920544353, parseIgnitionHh(body))).toEqual([]);
  });

  test("a missed action is one row, not a cascade", () => {
    const missed = { ...faithful4920544353, actions: faithful4920544353.actions.filter((_, i) => i !== 3) };
    expect(compareHand(missed, parseIgnitionHh(body))).toEqual([
      { kind: "action-missing", field: "Ignition action 4 missing from ours", ours: "—", ignition: "preflop seat 4 fold", ignitionAt: 3 },
    ]);
  });

  test("a wrong size and a wrong start stack are called out", () => {
    const off = { ...faithful4920544353, actions: faithful4920544353.actions.map((a, i) => (i === 11 ? { ...a, amount: 12 } : a)),
      startStacks: { ...archived.startStacks, 6: 51.6 }, stacks: { ...archived.stacks, 2: 31 } };
    expect(compareHand(off, parseIgnitionHh(body)).map((x) => x.field)).toEqual(["seat 6 start stack", "seat 2 end stack", "action 12 amount"]);
  });
});
