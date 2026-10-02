import { describe, expect, it } from "bun:test";
import { bbAmount, describeTreeChange, GtowApi, seatAllIns, treeFingerprint, treeStacksOf, TREE_SETTINGS, type CustomTreeInput } from "./gtowApi";

/**
 * THE TREE REQUEST IS THE TABLE'S STATE (2026-10-03, hand 4922087007: HJ shoved 28 on the flop, the tree had every seat
 * at 97.8 and solved the shove as a 97.8bb one). Each seat its own stack, the wagers played as amounts, the settings
 * explicit and off, every FIXED list carrying the seat's own all-in, heads-up seats that have not wagered AUTOMATIC.
 * The shapes below are the ones probed on GTO Wizard on 2026-10-03 (audits/postflop-allin-fix-2026-10/probe*.out).
 */
const api = new GtowApi();
const r = () => new Array(1326).fill(1);
const flop = (sizes: any) => sizes.bet_sizes.street_bet_sizes.find((s: any) => s.street === "FLOP").position_bet_sizes;
const hu = (over: Partial<CustomTreeInput> = {}): CustomTreeInput => ({ board: "Qs4s2c", pot: 27, stack: 85.8, oopRange: r(), ipRange: r(), oopPos: "SB", ipPos: "BTN", ...over });

describe("the settings, explicit and off", () => {
  it("allin_threshold 100, allin_if_less_than 0, merge_sizes_threshold 0 — on every postflop tree", () => {
    const b = api.buildCustomTree(hu());
    expect(b.bet_sizes.allin_threshold).toBe(100);
    expect(b.bet_sizes.allin_if_less_than).toBe(0);
    expect(b.bet_sizes.merge_sizes_threshold).toBe(0);
    expect(TREE_SETTINGS).toEqual({ allin_threshold: 100, allin_if_less_than: 0, merge_sizes_threshold: 0 });
  });
});

describe("each seat its own stack (item 1)", () => {
  it("hand 4922087007's flop: HJ 28 / CO 113.2 / BTN 97.8 as the table had them, not 97.8 each", () => {
    const b = api.buildCustomTree({ board: "7sJd5s", pot: 36.3, stack: 97.8, stacks: [28, 113.2, 97.8], oopRange: r(), ipRange: r(), oopPos: "HJ", ipPos: "BTN", mid: { pos: "CO", range: r() } });
    expect(b.players.map((p) => [p.display_position, p.stack])).toEqual([["HJ", 28], ["CO", 113.2], ["BTN", 97.8]]);
  });
  it("a caller without per-seat stacks gets the one stack for every seat, as before", () => {
    expect(treeStacksOf({ stack: 50 })).toEqual([50, 50]);
    expect(treeStacksOf({ stack: 50, stacks: [20, NaN as any] })).toEqual([20, 50]);
  });
  it("each seat's all-in is its stack, capped at the deepest other seat", () => {
    expect(seatAllIns([28, 113.2, 97.8])).toEqual([28, 97.8, 97.8]);
    expect(seatAllIns([150, 50])).toEqual([50, 50]);
  });
});

describe("heads-up: state in, everything else automatic (items 3, 6, 8)", () => {
  it("no wager on the street: both seats AUTOMATIC", () => {
    expect(flop(api.buildCustomTree(hu())).map((p: any) => p.type)).toEqual(["AUTOMATIC", "AUTOMATIC"]);
  });
  it("the bettor FIXED at the amount he bet (+ his all-in), his raise levels null (GTO Wizard: the min-raise + the all-in there); the other seat AUTOMATIC", () => {
    const [oop, ip] = flop(api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 8.6 }] } })));
    expect(oop).toMatchObject({ type: "FIXED", bet_sizes: ["8.6bb", "85.8bb"], raise_sizes: null, second_raise_sizes: null, third_plus_raise_sizes: null });
    expect(ip.type).toBe("AUTOMATIC");
  });
  it("bet + raise: the raiser FIXED at his raise; his bet list is the street's bet (a FIXED seat without one is refused) and his next level the base list, never a copy of his raise", () => {
    const [oop, ip] = flop(api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 8.6 }, { seat: 1, to: 25 }] } })));
    expect(oop).toMatchObject({ bet_sizes: ["8.6bb", "85.8bb"], raise_sizes: null, second_raise_sizes: null, third_plus_raise_sizes: null });
    expect(ip).toMatchObject({ type: "FIXED", bet_sizes: ["8.6bb", "85.8bb"], raise_sizes: ["25bb", "85.8bb"], second_raise_sizes: ["60%", "85.8bb"], third_plus_raise_sizes: ["60%", "85.8bb"] });
  });
  it("bet + raise + re-raise: each seat its own played levels", () => {
    const [oop, ip] = flop(api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 8.6 }, { seat: 1, to: 25 }, { seat: 0, to: 60 }] } })));
    expect(oop).toMatchObject({ bet_sizes: ["8.6bb", "85.8bb"], raise_sizes: null, second_raise_sizes: ["60bb", "85.8bb"], third_plus_raise_sizes: ["60%", "85.8bb"] });
    expect(ip.raise_sizes).toEqual(["25bb", "85.8bb"]);
  });
  it("2026-09-30 river (hand 4921655625): BB bets 18.8 with 26.2 behind — pinned as 18.8, the all-in beside it, never replaced by it", () => {
    const [bb, sb] = flop(api.buildCustomTree(hu({ board: "4sJh9d", pot: 19.6, stack: 26.2, stacks: [26.2, 152], played: { FLOP: [{ seat: 0, to: 18.8 }] } })));
    expect(bb.bet_sizes).toEqual(["18.8bb", "26.2bb"]);
    expect(sb.type).toBe("AUTOMATIC");
  });
  it("a wager that IS the seat's all-in is listed once", () => {
    const [oop] = flop(api.buildCustomTree(hu({ stacks: [28, 100], played: { FLOP: [{ seat: 0, to: 28 }] } })));
    expect(oop.bet_sizes).toEqual(["28bb"]);
  });
  it("amounts go out to the cent ('<bb>bb'), never as a bare number or a % of the pot", () => {
    expect(bbAmount(8.75)).toBe("8.75bb");
    expect(bbAmount(18.8)).toBe("18.8bb");
    expect(bbAmount(28)).toBe("28bb");
  });
});

describe("three seats: FIXED, the base lists where nothing is played (item 7)", () => {
  const three = (over: Partial<CustomTreeInput> = {}): CustomTreeInput => ({ board: "7sJd5s", pot: 36.3, stack: 97.8, stacks: [28, 113.2, 97.8],
    oopRange: r(), ipRange: r(), oopPos: "HJ", ipPos: "BTN", mid: { pos: "CO", range: r() }, ...over });
  it("wager-free: 33% / 75% bets, 60% raises, and each seat's own all-in in every list", () => {
    const seats = flop(api.buildCustomTree(three()));
    expect(seats[0]).toMatchObject({ type: "FIXED", bet_sizes: ["33%", "75%", "28bb"], raise_sizes: ["60%", "28bb"] });
    expect(seats[1]).toMatchObject({ bet_sizes: ["33%", "75%", "97.8bb"], third_plus_raise_sizes: ["60%", "97.8bb"] });
  });
  it("hand 4922087007: HJ's 28 shove is HJ's own all-in — the other seats bet by the base list (a short stack's shove is no size for them; review 2026-10-03)", () => {
    const seats = flop(api.buildCustomTree(three({ played: { FLOP: [{ seat: 0, to: 28 }] } })));
    expect(seats.map((p: any) => p.bet_sizes)).toEqual([["28bb"], ["33%", "75%", "97.8bb"], ["33%", "75%", "97.8bb"]]);
    expect(seats.map((p: any) => p.raise_sizes)).toEqual([["60%", "28bb"], ["60%", "97.8bb"], ["60%", "97.8bb"]]);
  });
});

describe("the cache key and the fingerprint carry what is now sent (item 11)", () => {
  const key = (x: CustomTreeInput) => (api as any).treeKey(x);
  it("per-seat stacks, the amounts played and the settings are in the key", () => {
    expect(key(hu())).not.toBe(key(hu({ stacks: [85.8, 120] })));
    expect(key(hu({ played: { FLOP: [{ seat: 0, to: 8.6 }] } }))).not.toBe(key(hu({ played: { FLOP: [{ seat: 0, to: 8.7 }] } })));
    expect(key(hu())).toContain("allin-listed:100/0/0");
  });
  it("a tree re-created because a seat's stack moved says so", () => {
    const why = describeTreeChange(treeFingerprint(hu({ stacks: [85.8, 85.8] })), treeFingerprint(hu({ stacks: [85.8, 120] })));
    expect(why).toContain("seat stacks 85.8/85.8→85.8/120");
    expect(treeFingerprint(hu({ played: { FLOP: [{ seat: 0, to: 8.6 }] } })).fixedLevels).toEqual(["8.6bb by OOP"]);
  });
});
