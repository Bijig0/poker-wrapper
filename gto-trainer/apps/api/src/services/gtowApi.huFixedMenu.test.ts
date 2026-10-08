/**
 * THE HEADS-UP FIXED MENU (2026-10-08, Brady "fix 3"; HU_FIXED_MENU, register postflop-size-menu). Heads-up trees had
 * every seat that had not wagered on a street AUTOMATIC, and the re-tree carry kept whatever menu `auto` returned first
 * (core-bvb-007 turn: CHECK / BET 20.5). Now no heads-up answer-path tree has an AUTOMATIC seat: an unbet street is FIXED
 * at 33% / 75% | 60% + each seat's all-in (the 3-way list), a played street keeps that menu with each seat's own wagers
 * added — the lists the re-tree carries from a FIXED tree, so the first tree of a played street and the re-tree agree.
 * Switch off = the request of e50e3b8 byte for byte (fixture __fixtures__/huMenuControlBodies.e50e3b8.json: the bodies
 * e50e3b8's buildCustomTree built for the same inputs). Three-way untouched either way.
 */
import { afterEach, describe, expect, it } from "bun:test";
import fx from "./__fixtures__/huMenuControlBodies.e50e3b8.json";
import { GtowApi, HU_FIXED_MENU_TAG, huFixedMenuOn, type CustomTreeInput, type PlayedWager } from "./gtowApi";
import { retreeInputs } from "./aiChain";
import { OLD_MENUS, useMenus } from "../test/menuEnv";

// THIS FILE IS MENU B (HU_FIXED_MENU=b since 2026-10-08 evening; "on" here = b), three-way B, the gross pot — the
// request of fada815. Menus F / C / net, the list cap and the node clock: gtowApi.menus.test.ts
useMenus(OLD_MENUS);

const api = new GtowApi();
const ones = () => new Array(1326).fill(1);
const expand = (x: any): CustomTreeInput => {
  const o = { ...x, oopRange: ones(), ipRange: ones() };
  if (x.mid) o.mid = { ...x.mid, range: ones() };
  return o;
};
const strip = (b: any) => ({ ...b, players: b.players.map((p: any) => ({ ...p, range: `${p.range.length} weights, sum ${p.range.reduce((a: number, v: number) => a + v, 0)}` })) });
const CASES = (fx as any).cases as Record<string, { input: any; body: any }>;
const built = (k: string) => JSON.stringify(strip(api.buildCustomTree(expand(CASES[k]!.input))));
const control = (k: string) => JSON.stringify(CASES[k]!.body);
const entry = (b: any, street: string) => b.bet_sizes.street_bet_sizes.find((s: any) => s.street === street).position_bet_sizes;
const hu = (over: Partial<CustomTreeInput> = {}): CustomTreeInput => ({ board: "Qs4s2c", pot: 27, stack: 85.8, oopRange: ones(), ipRange: ones(), oopPos: "SB", ipPos: "BTN", ...over });
const lists = (p: any) => [p.bet_sizes, p.raise_sizes, p.second_raise_sizes, p.third_plus_raise_sizes];

const before = process.env.HU_FIXED_MENU;
afterEach(() => { if (before == null) delete process.env.HU_FIXED_MENU; else process.env.HU_FIXED_MENU = before; });
const on = () => { process.env.HU_FIXED_MENU = "b"; };
const off = () => { process.env.HU_FIXED_MENU = "off"; };

describe("the switch", () => {
  it("unset = on (menu F since 2026-10-08 evening); 'off' (any case, spaces) = off; anything else on", () => {
    expect(huFixedMenuOn({})).toBe(true);
    expect(huFixedMenuOn({ HU_FIXED_MENU: "on" })).toBe(true);
    expect(huFixedMenuOn({ HU_FIXED_MENU: " OFF " })).toBe(false);
    expect(huFixedMenuOn({ HU_FIXED_MENU: "off" })).toBe(false);
    expect(huFixedMenuOn({ HU_FIXED_MENU: "1" })).toBe(true);
  });
  it("off: every tree of the fixture is e50e3b8's request byte for byte (heads-up and three-way)", () => {
    off();
    for (const k of Object.keys(CASES)) expect(`${k} ${built(k)}`).toBe(`${k} ${control(k)}`);
  });
  it("on: three-way trees and the explicit heads-up grid are untouched", () => {
    on();
    for (const k of ["three_unforced", "three_played", "three_played_bet", "three_carry", "hu_grid", "hu_grid_played"]) expect(`${k} ${built(k)}`).toBe(`${k} ${control(k)}`);
  });
  it("the tree key: heads-up on ≠ off (a cached AUTOMATIC solve is never taken for a fixed tree); three-way and the grid the same", () => {
    const key = (x: CustomTreeInput) => (api as any).treeKey(x);
    for (const k of Object.keys(CASES)) {
      const x = expand(CASES[k]!.input);
      on(); const a = key(x);
      off(); const b = key(x);
      if (x.mid || x.huGrid) expect(a).toBe(b);
      else { expect(a).not.toBe(b); expect(a).toContain(HU_FIXED_MENU_TAG); expect(b).not.toContain(HU_FIXED_MENU_TAG); }
    }
  });
});

describe("on: an unforced heads-up street — FIXED 33% / 75% | 60% + the seat's all-in, every seat, every street", () => {
  it("no wager anywhere: both seats, flop / turn / river", () => {
    on();
    const b = api.buildCustomTree(hu());
    for (const s of ["FLOP", "TURN", "RIVER"]) {
      for (const p of entry(b, s)) {
        expect(p).toMatchObject({ type: "FIXED", use_fixed_sizes: true, allow_limp: false });
        expect(lists(p)).toEqual([["33%", "75%", "85.8bb"], ["60%", "85.8bb"], ["60%", "85.8bb"], ["60%", "85.8bb"]]);
      }
    }
    expect(JSON.stringify(b)).not.toContain("AUTOMATIC");
    expect(b.bet_sizes).toMatchObject({ allin_threshold: 100, allin_if_less_than: 0, merge_sizes_threshold: 0 });
  });
  it("each seat its own all-in (capped at the deepest other seat)", () => {
    on();
    const [oop, ip] = entry(api.buildCustomTree(hu({ stacks: [28, 100] })), "FLOP");
    expect(oop.bet_sizes).toEqual(["33%", "75%", "28bb"]);
    expect(ip.bet_sizes).toEqual(["33%", "75%", "28bb"]);
  });
  it("the street-root pin (fixedBets) keeps its pinned street; its other streets are the fixed menu, not AUTOMATIC", () => {
    on();
    const b = api.buildCustomTree(hu({ fixedBets: { FLOP: 50 } }));
    expect(entry(b, "FLOP")[0].bet_sizes).toEqual(["50%", "85.8bb"]);
    expect(entry(b, "TURN")[0].bet_sizes).toEqual(["33%", "75%", "85.8bb"]);
    expect(JSON.stringify(b)).not.toContain("AUTOMATIC");
  });
});

describe("on: a played heads-up street — the played sizes pinned, the fixed menu kept beside them", () => {
  it("a bet: the bettor's bet list 75% + his 8.6 (33% of 27 = 8.91 is within tolerance: his size replaces it); the other seat the base menu; raise levels 60% everywhere (no null min-raise level)", () => {
    on();
    const b = api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 8.6 }] } }));
    const [oop, ip] = entry(b, "FLOP");
    expect(lists(oop)).toEqual([["75%", "8.6bb", "85.8bb"], ["60%", "85.8bb"], ["60%", "85.8bb"], ["60%", "85.8bb"]]);
    expect(lists(ip)).toEqual([["33%", "75%", "85.8bb"], ["60%", "85.8bb"], ["60%", "85.8bb"], ["60%", "85.8bb"]]);
    expect(entry(b, "TURN")[1].bet_sizes).toEqual(["33%", "75%", "85.8bb"]);
    expect(JSON.stringify(b)).not.toContain("AUTOMATIC");
  });
  it("bet + raise + re-raise: each seat's own wager at its own level, added to the 60%", () => {
    on();
    const [oop, ip] = entry(api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 8.6 }, { seat: 1, to: 25 }, { seat: 0, to: 60 }] } })), "FLOP");
    expect(lists(oop)).toEqual([["75%", "8.6bb", "85.8bb"], ["60%", "85.8bb"], ["60%", "60bb", "85.8bb"], ["60%", "85.8bb"]]);
    expect(lists(ip)).toEqual([["33%", "75%", "85.8bb"], ["60%", "25bb", "85.8bb"], ["60%", "85.8bb"], ["60%", "85.8bb"]]);
  });
  it("a played bet within the walk's tolerance of a base size replaces it (9 into 27: 33% = 8.91) — one size, the one played", () => {
    on();
    const [oop, ip] = entry(api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 9 }] } })), "FLOP");
    expect(oop.bet_sizes).toEqual(["75%", "9bb", "85.8bb"]);
    expect(ip.bet_sizes).toEqual(["33%", "75%", "85.8bb"]);
  });
  it("a shove is the shover's own all-in, listed once; never a size for the other seat", () => {
    on();
    const [oop, ip] = entry(api.buildCustomTree(hu({ stacks: [28, 100], played: { FLOP: [{ seat: 0, to: 28 }] } })), "FLOP");
    expect(oop.bet_sizes).toEqual(["33%", "75%", "28bb"]);
    expect(ip.bet_sizes).toEqual(["33%", "75%", "28bb"]);
  });
  it("a short bettor (18.8 with 26.2 behind): pinned as 18.8, the all-in beside it", () => {
    on();
    const [bb, sb] = entry(api.buildCustomTree(hu({ board: "4sJh9d", pot: 19.6, stack: 26.2, stacks: [26.2, 152], played: { FLOP: [{ seat: 0, to: 18.8 }] } })), "FLOP");
    expect(bb.bet_sizes).toEqual(["33%", "75%", "18.8bb", "26.2bb"]);
    expect(sb.type).toBe("FIXED");
    expect(sb.raise_sizes).toEqual(["60%", "26.2bb"]);
  });
});

describe("on: the first tree of a played street and the re-tree are the same request", () => {
  const base = hu({ board: "Kd7c3s2h", startingStreet: "TURN", pot: 15, stack: 96.7 });
  const labels = ["Check", "Bet(750)", "Raise(3000)"];
  const actors = [0, 1, 0];
  const w1: PlayedWager = { seat: 1, to: 7.5 }, w2: PlayedWager = { seat: 0, to: 30 };
  const retree = (played: PlayedWager[]) => retreeInputs({ base, played, labels, actors, stack: 96.7,
    build: (x) => api.buildCustomTree(x), peekSolution: () => null, peekNode: () => null });
  it("the BB's 7.5 off the fixed turn tree: carried as SENT (both seats FIXED), the 7.5 added — = the played tree with no carry", () => {
    on();
    const b = retree([w1]);
    expect(b.carry?.seats).toEqual(["sent", "sent"]);
    const viaCarry = entry(api.buildCustomTree(b.input), "TURN");
    const plain = entry(api.buildCustomTree({ ...base, played: { TURN: [w1] } }), "TURN");
    expect(viaCarry).toEqual(plain);
    expect(lists(viaCarry[1])).toEqual([["33%", "75%", "7.5bb", "96.7bb"], ["60%", "96.7bb"], ["60%", "96.7bb"], ["60%", "96.7bb"]]);
    expect(lists(viaCarry[0])).toEqual([["33%", "75%", "96.7bb"], ["60%", "96.7bb"], ["60%", "96.7bb"], ["60%", "96.7bb"]]);
  });
  it("the loop: hero's raise to 30 off that tree = the played tree with both wagers", () => {
    on();
    const c = retree([w1, w2]);
    const viaCarry = entry(api.buildCustomTree(c.input), "TURN");
    const plain = entry(api.buildCustomTree({ ...base, played: { TURN: [w1, w2] } }), "TURN");
    expect(viaCarry).toEqual(plain);
    expect(viaCarry[0].raise_sizes).toEqual(["60%", "30bb", "96.7bb"]);
  });
  it("a near-base played bet: the carry drops the base size as the first tree does", () => {
    on();
    const b = retreeInputs({ base, played: [{ seat: 1, to: 5 }], labels: ["Check", "Bet(500)"], actors: [0, 1], stack: 96.7,
      build: (x) => api.buildCustomTree(x), peekSolution: () => null, peekNode: () => null });
    const viaCarry = entry(api.buildCustomTree(b.input), "TURN");
    expect(viaCarry).toEqual(entry(api.buildCustomTree({ ...base, played: { TURN: [{ seat: 1, to: 5 }] } }), "TURN"));
    expect(viaCarry[1].bet_sizes).toEqual(["75%", "5bb", "96.7bb"]);   // 33% of 15 = 4.95
  });
});
