/**
 * THE POSTFLOP MENUS OF 2026-10-08 EVENING (Brady's decisions on the menu study, memory menu-study / menus-f-c-netpot):
 *  - heads-up menu F: bets 25/33/50/75/100/125/150%, raises 60/100% (HU_FIXED_MENU=f | b | off);
 *  - three-way menu C: flop bets 25/75/125%, turn and river 33/75/125%, raises 60% (THREEWAY_MENU=c | b | off=b);
 *  - our BET sizes on the pot after rake (MENU_POT=net | gross), the matcher agreeing by construction (it compares amounts);
 *  - GTO Wizard's 10-entry list cap (capSizeList, `[menu-cap]`);
 *  - the three-way node clock 15 s (THREEWAY_NODE_TIMEOUT_MS), heads-up 12 s.
 * Each switch's old value is the request of fada815 (b / b / gross) — byte for byte; off = e50e3b8's (gtowApi.huFixedMenu.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fx from "./__fixtures__/huMenuControlBodies.e50e3b8.json";
import {
  capSizeList, GtowApi, GTOW_SIZE_LIST_MAX, HU_FIXED_MENU_TAG, HU_MENU_F, HU_MENU_F_TAG, huMenuMode, menuOnNetPot, menuPotMode, MENU_POT_NET_TAG,
  menuTagsOf, netPotFactor, onNetPot, postflopNodeTimeoutMs, THREE_WAY_MENU_C, THREE_WAY_MENU_C_TAG, threeWayMenuMode, threeWayNodeTimeoutMs,
  type CustomTreeInput, type PlayedWager,
} from "./gtowApi";
import { retreeInputs } from "./aiChain";
import { matchActionLoose } from "../utils/aiStudyLine/aiStudyLine";
import { MENU_SWITCHES, type MenuEnv } from "../test/menuEnv";

const api = new GtowApi();
const ones = () => new Array(1326).fill(1);
const key = (x: CustomTreeInput) => (api as any).treeKey(x) as string;
const entry = (b: any, street: string) => b.bet_sizes.street_bet_sizes.find((s: any) => s.street === street).position_bet_sizes;
const lists = (p: any) => [p.bet_sizes, p.raise_sizes, p.second_raise_sizes, p.third_plus_raise_sizes];
const RAKE = { pct_of_pot: 5, cap_in_chips: 2, preflop_rake_type: null };
/** heads-up, pot 10 (net 9.5: factor 0.95), Ignition NL200 six dealt */
const hu = (over: Partial<CustomTreeInput> = {}): CustomTreeInput => ({ board: "Qs4s2c", pot: 10, stack: 95, oopRange: ones(), ipRange: ones(), oopPos: "BB", ipPos: "BTN", rake: RAKE, ...over });
const three = (over: Partial<CustomTreeInput> = {}): CustomTreeInput => ({ ...hu({ pot: 8, stack: 155.5, oopPos: "BB", ipPos: "BTN", board: "Js8cKh" }), mid: { pos: "UTG", range: ones() }, ...over });

const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of MENU_SWITCHES) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of MENU_SWITCHES) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } });
const set = (env: MenuEnv) => { for (const k of MENU_SWITCHES) { const v = env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; } };

const F_NET_10 = ["23.8%", "31.4%", "47.5%", "71.3%", "95%", "118.8%", "142.5%"];   // F x 0.95

describe("the switches", () => {
  it("HU_FIXED_MENU: unset / f / on / anything = f; b; off", () => {
    expect(huMenuMode({})).toBe("f");
    expect(huMenuMode({ HU_FIXED_MENU: "F" })).toBe("f");
    expect(huMenuMode({ HU_FIXED_MENU: "on" })).toBe("f");
    expect(huMenuMode({ HU_FIXED_MENU: " b " })).toBe("b");
    expect(huMenuMode({ HU_FIXED_MENU: "OFF" })).toBe("off");
  });
  it("THREEWAY_MENU: unset / c = c; b and off = b (a 3-player tree cannot be AUTOMATIC)", () => {
    expect(threeWayMenuMode({})).toBe("c");
    expect(threeWayMenuMode({ THREEWAY_MENU: "C" })).toBe("c");
    expect(threeWayMenuMode({ THREEWAY_MENU: "b" })).toBe("b");
    expect(threeWayMenuMode({ THREEWAY_MENU: "off" })).toBe("b");
  });
  it("MENU_POT: unset / net = net; gross", () => {
    expect(menuPotMode({})).toBe("net");
    expect(menuPotMode({ MENU_POT: "GROSS" })).toBe("gross");
    expect(menuPotMode({ MENU_POT: "x" })).toBe("net");
  });
  it("the node clock: three-way 15 s by default (THREEWAY_NODE_TIMEOUT_MS: ms, off = 12 s), heads-up 12 s always", () => {
    expect(threeWayNodeTimeoutMs({})).toBe(15_000);
    expect(threeWayNodeTimeoutMs({ THREEWAY_NODE_TIMEOUT_MS: "off" })).toBe(12_000);
    expect(threeWayNodeTimeoutMs({ THREEWAY_NODE_TIMEOUT_MS: "14000" })).toBe(14_000);
    expect(threeWayNodeTimeoutMs({ THREEWAY_NODE_TIMEOUT_MS: "nonsense" })).toBe(15_000);
    expect(postflopNodeTimeoutMs(3, {})).toBe(15_000);
    expect(postflopNodeTimeoutMs(2, {})).toBe(12_000);
    expect(postflopNodeTimeoutMs(2, { THREEWAY_NODE_TIMEOUT_MS: "20000" })).toBe(12_000);
  });
});

describe("the net pot (MENU_POT=net)", () => {
  it("pot_net / pot_gross: 5% below the cap, the cap above it (40bb at a 2bb cap), none without a rake", () => {
    expect(netPotFactor(10, RAKE)).toBeCloseTo(0.95, 12);
    expect(netPotFactor(40, RAKE)).toBeCloseTo(0.95, 12);
    expect(netPotFactor(60, RAKE)).toBeCloseTo(58 / 60, 12);
    expect(netPotFactor(20, { pct_of_pot: 5, cap_in_chips: 0.9 })).toBeCloseTo(19.1 / 20, 12);
    expect(netPotFactor(10, null)).toBe(1);
    expect(netPotFactor(0, RAKE)).toBe(1);
  });
  it("onNetPot: % x factor to a tenth (half rounds up); amounts untouched", () => {
    expect(onNetPot(HU_MENU_F.bet, 0.95)).toEqual(F_NET_10);
    expect(onNetPot(["150%"], 0.955)).toEqual(["143.3%"]);
    expect(onNetPot(["33%", "9.4bb"], 0.95)).toEqual(["31.4%", "9.4bb"]);
    expect(onNetPot(["33%"], 1)).toEqual(["33%"]);
  });
  it("heads-up F unforced: bets on the net pot on every street of the tree, raises 60 / 100% as listed", () => {
    const b = api.buildCustomTree(hu());
    for (const s of ["FLOP", "TURN", "RIVER"]) {
      for (const p of entry(b, s)) {
        expect(p).toMatchObject({ type: "FIXED", use_fixed_sizes: true });
        expect(lists(p)).toEqual([[...F_NET_10, "95bb"], ["60%", "100%", "95bb"], ["60%", "100%", "95bb"], ["60%", "100%", "95bb"]]);
      }
    }
    expect(JSON.stringify(b)).not.toContain("AUTOMATIC");
  });
  it("past the cap the factor is the pot's own (pot 60: 58 / 60)", () => {
    const [oop] = entry(api.buildCustomTree(hu({ pot: 60 })), "FLOP");
    expect(oop.bet_sizes).toEqual([...onNetPot(HU_MENU_F.bet, 58 / 60), "95bb"]);
    expect(oop.bet_sizes[3]).toBe("72.5%");   // 75% of the net 58 = 43.5 = 72.5% of 60
  });
  it("MENU_POT=gross: F as listed", () => {
    set({ MENU_POT: "gross" });
    const [oop] = entry(api.buildCustomTree(hu()), "FLOP");
    expect(oop.bet_sizes).toEqual([...HU_MENU_F.bet, "95bb"]);
  });
  it("never converted: an explicit huGrid, the street-root pin, the AUTOMATIC rules (HU_FIXED_MENU=off)", () => {
    const g = api.buildCustomTree(hu({ huGrid: { bet: ["33%", "75%"], raise: ["60%"] } }));
    expect(entry(g, "FLOP")[0].bet_sizes).toEqual(["33%", "75%", "95bb"]);
    expect(menuOnNetPot(hu({ huGrid: { bet: ["33%"], raise: ["60%"] } }))).toBe(false);
    const pin = api.buildCustomTree(hu({ fixedBets: { FLOP: 50 } }));
    expect(entry(pin, "FLOP")[0].bet_sizes).toEqual(["50%", "95bb"]);
    expect(entry(pin, "TURN")[0].bet_sizes).toEqual([...F_NET_10, "95bb"]);
    set({ HU_FIXED_MENU: "off" });
    expect(menuOnNetPot(hu())).toBe(false);
    expect(entry(api.buildCustomTree(hu()), "FLOP")[0].type).toBe("AUTOMATIC");
    expect(entry(api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 3 }] } })), "FLOP")[0].bet_sizes).toEqual(["3bb", "95bb"]);
  });
  it("THE MATCHER AGREES: a pool 75%-of-net bet (7.125 into 10) lands on the net menu's 75% and misses the gross one", () => {
    const sols = (amts: number[]) => [{ action: { code: "X", display_name: "CHECK", betsize: null } },
      ...amts.map((a) => ({ action: { code: `R${a}`, display_name: "BET", betsize: a } }))];
    const amountsOf = (list: string[]) => list.map((x) => Math.round((Number(x.slice(0, -1)) / 100) * 10 * 100) / 100);   // GTO Wizard: % of the gross 10
    const poolBet = "Bet(713)";                                   // 75% of the net 9.5 = 7.125, the client's 7.13
    const net = amountsOf(F_NET_10), gross = amountsOf([...HU_MENU_F.bet]);
    const iNet = matchActionLoose(poolBet, sols(net) as any, 0);
    expect(iNet).toBe(1 + F_NET_10.indexOf("71.3%"));
    expect(matchActionLoose(poolBet, sols(gross) as any, 0)).toBe(-1);   // 7.5 vs 7.13: 5.3% > 5% (and > 0.15bb) — the re-tree it caused
    // and the pool's half-pot (4.75) / third-pot (3.09 = 32.5% of net) the same way
    expect(matchActionLoose("Bet(475)", sols(net) as any, 0)).toBe(1 + F_NET_10.indexOf("47.5%"));
    expect(matchActionLoose("Bet(309)", sols(net) as any, 0)).toBe(1 + F_NET_10.indexOf("31.4%"));
  });
  it("the played bet replaces the net size it stands for (7.1 into 10: 71.3% = 7.13 dropped, the 7.1 kept)", () => {
    const [oop, ip] = entry(api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 7.1 }] } })), "FLOP");
    expect(oop.bet_sizes).toEqual(["23.8%", "31.4%", "47.5%", "95%", "118.8%", "142.5%", "7.1bb", "95bb"]);
    expect(ip.bet_sizes).toEqual([...F_NET_10, "95bb"]);
  });
});

describe("heads-up menu F", () => {
  it("played street: each seat keeps F, its own wagers added at their levels; raises 60 / 100% at every level", () => {
    const [oop, ip] = entry(api.buildCustomTree(hu({ played: { FLOP: [{ seat: 0, to: 3.1 }, { seat: 1, to: 11 }] } })), "FLOP");
    expect(lists(oop)).toEqual([["23.8%", "47.5%", "71.3%", "95%", "118.8%", "142.5%", "3.1bb", "95bb"], ["60%", "100%", "95bb"], ["60%", "100%", "95bb"], ["60%", "100%", "95bb"]]);
    expect(lists(ip)).toEqual([[...F_NET_10, "95bb"], ["60%", "100%", "11bb", "95bb"], ["60%", "100%", "95bb"], ["60%", "100%", "95bb"]]);
  });
  it("the first tree of a played street and the re-tree are the same request (the loop too)", () => {
    const base = hu({ board: "Kd7c3s2h", startingStreet: "TURN", pot: 15, stack: 96.7 });
    const labels = ["Check", "Bet(800)", "Raise(3000)"], actors = [0, 1, 0];
    const w: PlayedWager[] = [{ seat: 1, to: 8 }, { seat: 0, to: 30 }];
    for (const n of [1, 2]) {
      const r = retreeInputs({ base, played: w.slice(0, n), labels, actors, stack: 96.7, build: (x) => api.buildCustomTree(x), peekSolution: () => null, peekNode: () => null });
      expect(r.carry?.seats).toEqual(["sent", "sent"]);
      expect(entry(api.buildCustomTree(r.input), "TURN")).toEqual(entry(api.buildCustomTree({ ...base, played: { TURN: w.slice(0, n) } }), "TURN"));
    }
  });
  it("a size past the stack stays listed (GTO Wizard reads it as the all-in: one node, seen in the live cache)", () => {
    const [oop] = entry(api.buildCustomTree(hu({ stacks: [12, 95] })), "FLOP");
    expect(oop.bet_sizes).toEqual([...F_NET_10, "12bb"]);
    expect(oop.bet_sizes.length).toBeLessThanOrEqual(GTOW_SIZE_LIST_MAX);
  });
  it("HU_FIXED_MENU=b: the 33/75 | 60 lists (on the net pot unless MENU_POT=gross)", () => {
    set({ HU_FIXED_MENU: "b" });
    expect(lists(entry(api.buildCustomTree(hu()), "FLOP")[0])).toEqual([["31.4%", "71.3%", "95bb"], ["60%", "95bb"], ["60%", "95bb"], ["60%", "95bb"]]);
    set({ HU_FIXED_MENU: "b", MENU_POT: "gross" });
    expect(entry(api.buildCustomTree(hu()), "FLOP")[0].bet_sizes).toEqual(["33%", "75%", "95bb"]);
  });
});

describe("three-way menu C (a 4+-way flop collapsed to three seats is the same 3-player tree)", () => {
  it("unforced: flop bets 25 / 75 / 125%, turn and river 33 / 75 / 125% (on the net pot), raises 60%, every seat its all-in", () => {
    const b = api.buildCustomTree(three());
    for (const p of entry(b, "FLOP")) expect(lists(p)).toEqual([["23.8%", "71.3%", "118.8%", "155.5bb"], ["60%", "155.5bb"], ["60%", "155.5bb"], ["60%", "155.5bb"]]);
    for (const s of ["TURN", "RIVER"]) {
      for (const p of entry(b, s)) expect(lists(p)).toEqual([["31.4%", "71.3%", "118.8%", "155.5bb"], ["60%", "155.5bb"], ["60%", "155.5bb"], ["60%", "155.5bb"]]);
    }
    expect(THREE_WAY_MENU_C.flopBet).toEqual(["25%", "75%", "125%"]);
  });
  it("a tree that starts on the turn bets 33 / 75 / 125% there (the flop list is the flop's only)", () => {
    const b = api.buildCustomTree(three({ board: "Js8cKh2d", startingStreet: "TURN" }));
    for (const p of entry(b, "TURN")) expect(p.bet_sizes).toEqual(["31.4%", "71.3%", "118.8%", "155.5bb"]);
  });
  it("a re-tree keeps every seat's C and adds the played amount to the actor only", () => {
    const base = three();
    const r = retreeInputs({ base, played: [{ seat: 0, to: 4 }], labels: ["Bet(400)"], actors: [0], stack: 155.5,
      build: (x) => api.buildCustomTree(x), peekSolution: () => null, peekNode: () => null });
    const [bb, utg, btn] = entry(api.buildCustomTree(r.input), "FLOP");
    expect(bb.bet_sizes).toEqual(["23.8%", "71.3%", "118.8%", "4bb", "155.5bb"]);
    expect(utg.bet_sizes).toEqual(["23.8%", "71.3%", "118.8%", "155.5bb"]);
    expect(btn.bet_sizes).toEqual(["23.8%", "71.3%", "118.8%", "155.5bb"]);
  });
  it("THREEWAY_MENU=b (or off): 33 / 75 | 60", () => {
    for (const v of ["b", "off"]) {
      set({ THREEWAY_MENU: v, MENU_POT: "gross" });
      expect(lists(entry(api.buildCustomTree(three()), "FLOP")[1])).toEqual([["33%", "75%", "155.5bb"], ["60%", "155.5bb"], ["60%", "155.5bb"], ["60%", "155.5bb"]]);
    }
  });
});

describe("the tree key: one key per table state, a different key per menu", () => {
  it("identical tables share the key (built apart); F / B / off, C / B, net / gross all differ", () => {
    expect(key(hu())).toBe(key(hu()));
    expect(key(three())).toBe(key(three()));
    const k = (env: MenuEnv, x: () => CustomTreeInput) => { set(env); return key(x()); };
    const huKeys = [k({}, hu), k({ HU_FIXED_MENU: "b" }, hu), k({ HU_FIXED_MENU: "off" }, hu), k({ MENU_POT: "gross" }, hu), k({ HU_FIXED_MENU: "b", MENU_POT: "gross" }, hu)];
    expect(new Set(huKeys).size).toBe(huKeys.length);
    const twKeys = [k({}, three), k({ THREEWAY_MENU: "b" }, three), k({ MENU_POT: "gross" }, three), k({ THREEWAY_MENU: "b", MENU_POT: "gross" }, three)];
    expect(new Set(twKeys).size).toBe(twKeys.length);
  });
  it("the tags: each only where it applies — the old values (b / b / gross) leave fada815's keys", () => {
    expect(menuTagsOf(hu())).toEqual([HU_MENU_F_TAG, MENU_POT_NET_TAG]);
    expect(menuTagsOf(three())).toEqual([THREE_WAY_MENU_C_TAG, MENU_POT_NET_TAG]);
    expect(menuTagsOf(hu({ huGrid: { bet: ["33%"], raise: ["60%"] } }))).toEqual([]);
    set({ HU_FIXED_MENU: "b", THREEWAY_MENU: "b", MENU_POT: "gross" });
    expect(menuTagsOf(hu())).toEqual([HU_FIXED_MENU_TAG]);
    expect(menuTagsOf(three())).toEqual([]);
  });
  it("the old values: every fixture input's body is fada815's (= e50e3b8's for three-way and the grid; heads-up B as fada815 built it)", () => {
    const CASES = (fx as any).cases as Record<string, { input: any; body: any }>;
    const expand = (x: any): CustomTreeInput => ({ ...x, oopRange: ones(), ipRange: ones(), ...(x.mid ? { mid: { ...x.mid, range: ones() } } : {}) });
    const strip = (b: any) => ({ ...b, players: b.players.map((p: any) => ({ ...p, range: `${p.range.length} weights, sum ${p.range.reduce((a: number, v: number) => a + v, 0)}` })) });
    set({ HU_FIXED_MENU: "off", THREEWAY_MENU: "b", MENU_POT: "gross" });
    for (const name of Object.keys(CASES)) expect(`${name} ${JSON.stringify(strip(api.buildCustomTree(expand(CASES[name]!.input))))}`).toBe(`${name} ${JSON.stringify(CASES[name]!.body)}`);
  });
});

describe("GTO Wizard's 10-entry list cap (capSizeList)", () => {
  const bb = (x: string) => { const a = /^(\d+(?:\.\d+)?)bb$/.exec(x); if (a) return Number(a[1]); const m = /^(\d+(?:\.\d+)?)%$/.exec(x); return m ? Number(m[1]) / 10 : null; };   // pot 10
  it("at or under 10 entries nothing moves", () => {
    const l = ["25%", "33%", "50%", "75%", "100%", "125%", "150%", "4.1bb", "6.2bb", "95bb"];
    expect(capSizeList(l, ["4.1bb", "6.2bb"], bb)).toEqual({ list: l, dropped: [] });
  });
  it("11 entries: the menu size nearest a played size goes — never a played size, never the all-in", () => {
    const l = ["25%", "33%", "50%", "75%", "100%", "125%", "150%", "4.1bb", "6.2bb", "13.9bb", "95bb"];
    const r = capSizeList(l, ["4.1bb", "6.2bb", "13.9bb"], bb);
    expect(r.dropped).toEqual(["33%"]);                  // 3.3 is 0.8 from 4.1 — nearer a played size than any other menu size
    expect(r.list.length).toBe(10);
    expect(r.list).toContain("4.1bb"); expect(r.list).toContain("6.2bb"); expect(r.list).toContain("13.9bb");
    expect(r.list[r.list.length - 1]).toBe("95bb");
  });
  it("12 entries: two go, each the nearest at its turn", () => {
    const l = ["25%", "33%", "50%", "75%", "100%", "125%", "150%", "3.25bb", "7.9bb", "9.97bb", "13.6bb", "95bb"];
    const r = capSizeList(l, ["3.25bb", "7.9bb", "9.97bb", "13.6bb"], bb);
    expect(r.dropped).toEqual(["100%", "33%"]);          // 10 is 0.03 from 9.97; then 3.3 is 0.05 from 3.25
    expect(r.list).toEqual(["25%", "50%", "75%", "125%", "150%", "3.25bb", "7.9bb", "9.97bb", "13.6bb", "95bb"]);
  });
  it("no played size in the list: the size nearest the all-in goes", () => {
    const l = ["10%", "20%", "25%", "33%", "50%", "75%", "100%", "125%", "150%", "200%", "95bb"];
    expect(capSizeList(l, [], bb).dropped).toEqual(["200%"]);
  });
  it("only played sizes left to drop: nothing of ours to take — the list stays (and GTO Wizard would refuse it)", () => {
    const l = Array.from({ length: 10 }, (_, k) => `${k + 1}bb`).concat(["95bb"]);
    expect(capSizeList(l, l.slice(0, 10), bb).dropped).toEqual([]);
  });
  it("in a tree: a carried bet list past the cap is cut to 10 with a [menu-cap] line; the played size and the all-in stay", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const sentBet = [...F_NET_10, "2.2bb", "3.9bb", "95bb"];      // a carried list that already holds two other amounts
      const x = hu({ played: { FLOP: [{ seat: 0, to: 5.6 }] }, carry: { street: "FLOP", seats: [{ from: "sent", lists: [sentBet, ["60%", "100%", "95bb"], ["60%", "100%", "95bb"], ["60%", "100%", "95bb"]] }, null] } });
      const [oop] = entry(api.buildCustomTree(x), "FLOP");
      expect(oop.bet_sizes.length).toBe(GTOW_SIZE_LIST_MAX);
      expect(oop.bet_sizes).toContain("5.6bb");
      expect(oop.bet_sizes[oop.bet_sizes.length - 1]).toBe("95bb");
      expect(oop.bet_sizes).not.toContain("47.5%");                // 4.75 is the menu size nearest the played 5.6
      expect(log.mock.calls.some((c) => String(c[0]).startsWith("[menu-cap] Qs4s2c FLOP OOP bet_sizes: 11 sizes > 10"))).toBe(true);
    } finally { log.mockRestore(); }
  });
});
