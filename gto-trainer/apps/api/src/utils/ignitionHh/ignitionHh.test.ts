import { describe, expect, test } from "bun:test";
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";
import { compareHand, compareThroughHero, parseIgnitionHh } from "./ignitionHh";
type ParsedHandActions = ParsedHand["actions"];
import {
  archived4920544353 as archived, faithful4920544353, record4920544353 as body,
  archived4922279384, archived4923627084, archived4923636936, record4922279384, record4923627084, record4923636936,
} from "./fixtures";

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
  // hand 4920636325 (2026-09-26): UTG posted in and RAISED — the post lives inside the raise-to level (normalizeHand's
  // foldPostIns lists it in postIns), so Ignition's "Posts chip" has no row of ours to pair with. It was flagged
  // "action missing" on four hands whose archived rows carried every post.
  test("a post-in folded into the poster's raise is not a missing action", () => {
    const raised = parseIgnitionHh({
      blinds: "$0.02 / $0.05",
      communityCards: ["", "", "", "", ""],
      players: [
        { seat: "1", position: "Small Blind", cards: [], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: false },
        { seat: "2", position: "Big Blind  [ME]", cards: ["As", "Ks"], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: true },
        { seat: "3", position: "UTG", cards: [], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: false },
      ],
      action: [
        act("Small Blind", "Small Blind", "$0.02"), act("Big Blind  [ME]", "Big blind", "$0.05"), act("UTG", "Posts chip", "$0.05"),
        act("UTG", "Raises", "$0.10"), act("Small Blind", "Folds"), act("Big Blind  [ME]", "Folds"),
      ],
    });
    const ours = {
      ...archived, heroSeatId: 2, heroCards: ["As", "Ks"], board: [], liveSeats: [1, 2, 3], startStacks: undefined, stacks: undefined,
      postIns: [{ seatId: 3, hero: false, amount: 1, readAs: "raise" as const }],
      actions: [
        { seatId: 1, hero: false, type: "post-sb" as const, amount: 0.4, street: "preflop" as const },
        { seatId: 2, hero: true, type: "post-bb" as const, amount: 1, street: "preflop" as const },
        { seatId: 3, hero: false, type: "raise" as const, amount: 2, street: "preflop" as const },
        { seatId: 1, hero: false, type: "fold" as const, street: "preflop" as const },
        { seatId: 2, hero: true, type: "fold" as const, street: "preflop" as const },
      ],
    };
    expect(compareHand(ours, raised).filter((d) => d.kind.startsWith("action"))).toEqual([]);
    // without the post-in on record it IS a missing action
    expect(compareHand({ ...ours, postIns: [] }, raised).filter((d) => d.kind.startsWith("action")).map((d) => d.kind)).toEqual(["action-missing"]);
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

// THE THREE FALSE-MISMATCH CLASSES OF THE 2026-10-14 ANSWER-PATH AUDIT (finding 5), each on the hand that showed it.
describe("a fold the site made for hero (4923636936)", () => {
  const ign = parseIgnitionHh(record4923636936);
  test("Ignition's record: hero's last action is a 'Folds (timeout)'", () => {
    expect(ign.actions.at(-1)).toMatchObject({ seat: 2, type: "fold", label: "Folds (timeout)", street: "preflop" });
  });
  test("through hero's last action nothing disagrees: the actions before his fold are all there (was: 'actions 3-7 missing')", () => {
    expect(compareThroughHero(archived4923636936, ign)).toEqual([]);
  });
  test("the whole hand names the site's fold as its own kind, once, not as a missing action", () => {
    expect(compareHand(archived4923636936, ign)).toEqual([
      expect.objectContaining({ kind: "hero-site-fold", ignitionAt: 7, ignition: "preflop seat 2 fold (Folds (timeout))" }),
    ]);
  });
  test("a PLAIN fold of hero's that our record lacks is a missed action of his — one row, before and through hero, never a cascade", () => {
    const plain = parseIgnitionHh({ ...(record4923636936 as any), action: (record4923636936 as any).action.map((a: any) => (a.action === "Folds (timeout)" ? { ...a, action: "Folds" } : a)) });
    expect(compareHand(archived4923636936, plain).map((d) => [d.kind, d.ignitionAt])).toEqual([["action-missing", 7]]);
    expect(compareThroughHero(archived4923636936, plain).map((d) => [d.kind, d.ignitionAt])).toEqual([["action-missing", 7]]);
  });
  test("a recording that lost hero's last DECISION (not a fold) is still wrong through hero", () => {
    // seat 6 (hero for this test) called the river shove on Ignition's side; our record stops before it
    const ign79 = parseIgnitionHh(record4922279384);
    const heroIsBtn = { ...ign79, seats: ign79.seats.map((s) => ({ ...s, hero: s.seat === 6 })) };
    const stopped = { ...archived4922279384, heroSeatId: 6, actions: archived4922279384.actions.slice(0, 15).map((a) => ({ ...a, hero: a.seatId === 6 })) };
    expect(compareThroughHero(stopped, heroIsBtn).map((d) => [d.kind, d.ignitionAt])).toEqual([["action-missing", 15]]);
  });
});

describe("a post-in carried by the poster's call (4923627084)", () => {
  const ign = parseIgnitionHh(record4923627084);
  test("the post pairs with nothing of ours and is added to his call: the hand matches whole (was: 'action 6 missing: seat 3 call 3bb')", () => {
    expect(compareHand(archived4923627084, ign)).toEqual([]);
    expect(compareThroughHero(archived4923627084, ign)).toEqual([]);
  });
  test("with no post-in record of ours, the post never eats a later full-size call", () => {
    const noRecord = { ...archived4923627084, postIns: [], actions: archived4923627084.actions.map((a, i) => (i === 4 ? { ...a, amount: 3 } : a)) };
    // the post itself is what our record lacks; his 3bb call pairs with Ignition's 3bb call
    expect(compareHand(noRecord, ign)).toEqual([
      { kind: "action-missing", field: "Ignition action 3 missing from ours", ours: "—", ignition: "preflop seat 3 call 1bb", ignitionAt: 2 },
    ]);
  });
  test("a post the reader read as a LIMP pairs with his call of the post's size", () => {
    // seat 3 posts and checks his option behind a limped pot: ours files a call of 1bb at his turn
    const rec = record4923627084 as any;
    const limped = parseIgnitionHh({ ...rec, communityCards: ["", "", "", "", ""], action: [
      ...rec.action.slice(0, 10),   // dealer, blinds, the post, the deals
      { position: "UTG", action: "Calls", data: ["$0.05"] }, { position: "UTG+1", action: "Folds", data: [] }, { position: "UTG+2", action: "Checks", data: [] },
      { position: "Dealer", action: "Folds", data: [] }, { position: "Small Blind  [ME]", action: "Folds", data: [] }, { position: "Big Blind", action: "Checks", data: [] },
    ] });
    const ours = { ...archived4923627084, board: [], street: "preflop" as const, postIns: [{ seatId: 3, hero: false, amount: 1, readAs: "limp" as const }], actions: [
      { seatId: 5, hero: true, type: "post-sb" as const, amount: 0.4, street: "preflop" as const },
      { seatId: 6, hero: false, type: "post-bb" as const, amount: 1, street: "preflop" as const },
      { seatId: 1, hero: false, type: "call" as const, amount: 1, street: "preflop" as const },
      { seatId: 2, hero: false, type: "fold" as const, street: "preflop" as const },
      { seatId: 3, hero: false, type: "call" as const, amount: 1, street: "preflop" as const },
      { seatId: 4, hero: false, type: "fold" as const, street: "preflop" as const },
      { seatId: 5, hero: true, type: "fold" as const, street: "preflop" as const },
      { seatId: 6, hero: false, type: "check" as const, street: "preflop" as const },
    ] };
    expect(compareHand(ours, limped)).toEqual([]);
  });
});

describe("a dead-chip post with the big blind inside it", () => {
  // 12 hands in the 14 days to 2026-10-14 (4923625668 checks, 4922345444 raises, 4923561406 calls): a returning
  // player's "Posts dead chip $0.07" is his dead SB and his live BB in one line
  const act = (position: string, action: string, ...data: string[]) => ({ position, action, data });
  const players = [
    { seat: "1", position: "Small Blind", cards: [], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: false },
    { seat: "2", position: "Big Blind  [ME]", cards: ["As", "Ks"], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: true },
    { seat: "3", position: "UTG", cards: [], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: false },
    { seat: "4", position: "Dealer", cards: [], startEndAmount: "$5/$5", totalBet: "$0", winLoseAmount: "$0", isMe: false },
  ];
  const blinds = [act("Small Blind", "Small Blind", "$0.02"), act("Big Blind  [ME]", "Big blind", "$0.05"), act("UTG", "Posts dead chip", "$0.07")];
  const record = (...rest: ReturnType<typeof act>[]) => parseIgnitionHh({ blinds: "$0.02 / $0.05", communityCards: ["", "", "", "", ""], players, action: [...blinds, ...rest] });
  const ours = (actions: ParsedHandActions, readAs: "limp" | "call") => ({
    ...archived, heroSeatId: 2, heroCards: ["As", "Ks"], board: [], liveSeats: [1, 2, 3, 4], startStacks: undefined, stacks: undefined,
    postIns: [{ seatId: 3, hero: false, amount: 1, readAs }], actions,
  });
  test("the live big blind inside it is a post-in: his option check is the limp the reader filed", () => {
    const hh = record(act("Dealer", "Folds"), act("Small Blind", "Folds"), act("UTG", "Checks"), act("Big Blind  [ME]", "Checks"));
    expect(hh.actions.map((a) => `${a.seat}:${a.type}${a.amountBb != null ? ` ${a.amountBb}` : ""}`)).toEqual(["1:post-sb 0.4", "2:post-bb 1", "3:call 1", "4:fold", "1:fold", "2:check"]);
    expect(compareHand(ours([
      { seatId: 1, hero: false, type: "post-sb", amount: 0.4, street: "preflop" }, { seatId: 2, hero: true, type: "post-bb", amount: 1, street: "preflop" },
      { seatId: 4, hero: false, type: "fold", street: "preflop" }, { seatId: 1, hero: false, type: "fold", street: "preflop" },
      { seatId: 3, hero: false, type: "call", amount: 1, street: "preflop" }, { seatId: 2, hero: true, type: "check", street: "preflop" },
    ], "limp"), hh)).toEqual([]);
  });
  test("his call of a raise carries the live blind, as the reader's does", () => {
    const hh = record(act("Dealer", "Raises", "$0.15"), act("Small Blind", "Folds"), act("Big Blind  [ME]", "Folds"), act("UTG", "Calls", "$0.10"));
    expect(compareHand(ours([
      { seatId: 1, hero: false, type: "post-sb", amount: 0.4, street: "preflop" }, { seatId: 2, hero: true, type: "post-bb", amount: 1, street: "preflop" },
      { seatId: 4, hero: false, type: "raise", amount: 3, street: "preflop" }, { seatId: 1, hero: false, type: "fold", street: "preflop" },
      { seatId: 2, hero: true, type: "fold", street: "preflop" }, { seatId: 3, hero: false, type: "call", amount: 3, street: "preflop" },
    ], "call"), hh)).toEqual([]);
  });
  test("a dead chip under a big blind is money in the pot, not an action", () => {
    const hh = parseIgnitionHh({ blinds: "$0.02 / $0.05", communityCards: ["", "", "", "", ""], players, action: [
      ...blinds.slice(0, 2), act("UTG", "Posts dead chip", "$0.02"), act("UTG", "Calls", "$0.05"), act("Dealer", "Folds"), act("Small Blind", "Folds"), act("Big Blind  [ME]", "Checks"),
    ] });
    expect(hh.actions.map((a) => `${a.seat}:${a.type}${a.amountBb != null ? ` ${a.amountBb}` : ""}`)).toEqual(["1:post-sb 0.4", "2:post-bb 1", "3:call 1", "4:fold", "1:fold", "2:check"]);
    expect(hh.other.map((o) => o.label)).toEqual(["Posts dead chip"]);
  });
});

describe("all-ins compare as street totals (4922279384)", () => {
  const ign = parseIgnitionHh(record4922279384);
  test("a plain 'All-in' after money on the street carries the total, and keeps the chips added", () => {
    expect(ign.actions[15]).toMatchObject({ seat: 6, type: "all-in", street: "river", amountBb: 99.6, addedBb: 59.2 });
    // 'All-in(raise)' is already the raise-to total; a shove with nothing on the street yet is its own total
    expect(ign.actions[14]).toMatchObject({ seat: 2, type: "all-in", amountBb: 99.8 });
    expect(ign.actions[14]!.addedBb).toBeUndefined();
    expect(parseIgnitionHh(body).actions[16]).toMatchObject({ type: "all-in", amountBb: 21.6 });
  });
  test("the hand matches whole (was: 'ours river seat 6 all-in 99.6bb / Ignition 59.2bb')", () => {
    expect(compareHand(archived4922279384, ign)).toEqual([]);
  });
  test("a shove whose total really differs is still called out", () => {
    const off = { ...archived4922279384, actions: archived4922279384.actions.map((a, i) => (i === 15 ? { ...a, amount: 89.6 } : a)) };
    expect(compareHand(off, ign)).toEqual([expect.objectContaining({ kind: "action-amount", oursAt: 15, ignitionAt: 15, ignition: "river seat 6 all-in 99.6bb" })]);
  });
  test("the blinds count toward a preflop shove's total", () => {
    const rec = record4922279384 as any;
    const pre = parseIgnitionHh({ ...rec, communityCards: ["", "", "", "", ""], action: [
      ...rec.action.slice(0, 10), { position: "UTG  [ME]", action: "Raises", data: ["$0.13"] }, { position: "UTG+1", action: "Folds", data: [] },
      { position: "Dealer", action: "Folds", data: [] }, { position: "Small Blind", action: "Folds", data: [] }, { position: "Big Blind", action: "All-in", data: ["$1.30"] },
    ] });
    expect(pre.actions.at(-1)).toMatchObject({ seat: 3, type: "all-in", amountBb: 27, addedBb: 26 });   // 1bb blind + $1.30
  });
});
