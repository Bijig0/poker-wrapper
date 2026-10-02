import { describe, expect, it } from "bun:test";
import {
  actFromToken, chipsAfter, contestedChips, deadMoney, effectiveStack, foldRound, foldStreet, moneyEntering, moneyState, streetChips, streetFromTokens,
  type Act,
} from "./tableMoney";

const caps = (o: Record<string, number | null>) => (k: string) => o[k] ?? null;

describe("actFromToken / streetFromTokens", () => {
  it("reads every capture token, the all-in's amount beside it", () => {
    expect(streetFromTokens(["X", "R3", "C", "F", "RAI"], ["SB", "BB", "CO", "BTN", "HJ"], [null, null, null, null, 28])).toEqual([
      { seat: "SB", kind: "check" }, { seat: "BB", kind: "raise", to: 3 }, { seat: "CO", kind: "call" }, { seat: "BTN", kind: "fold" }, { seat: "HJ", kind: "allin", to: 28 },
    ]);
    expect(actFromToken("RAI", "HJ")).toEqual({ seat: "HJ", kind: "allin" });
    expect(actFromToken("Q", "HJ")).toBeNull();
  });
  it("review r2 §2: a bet with no amount (a bare \"R\") is not priced — left out and named, never a throw", () => {
    expect(actFromToken("R", "CO")).toBeNull();
    const unpriced: number[] = [];
    expect(streetFromTokens(["X", "R", "C"], ["BB", "CO", "BTN"], null, unpriced)).toEqual([{ seat: "BB", kind: "check" }, { seat: "BTN", kind: "call" }]);
    expect(unpriced).toEqual([1]);
  });
});

describe("chipsAfter: one act, out of the actor's own stack", () => {
  it("a call is capped at what the caller has (all-in for less)", () => {
    expect(chipsAfter({ kind: "call" }, 0, 50, 28)).toBe(28);
    expect(chipsAfter({ kind: "call" }, 0, 50, null)).toBe(50);
  });
  it("an all-in is the table's amount, else the whole stack; a raise past the stack is the stack", () => {
    expect(chipsAfter({ kind: "allin", to: 28 }, 0, 0, 30)).toBe(28);
    expect(chipsAfter({ kind: "allin" }, 0, 0, 30)).toBe(30);
    expect(chipsAfter({ kind: "raise", to: 60 }, 0, 0, 50)).toBe(50);
    expect(chipsAfter({ kind: "check" }, 3, 3, 10)).toBe(3);
  });
});

describe("streetChips: one street", () => {
  it("hand 4922087007's flop: HJ shoves his 28, CO folds — HJ all-in, an aggressor", () => {
    const sc = streetChips(streetFromTokens(["RAI", "F"], ["HJ", "CO"], [28, null]), caps({ HJ: 28, CO: 113.2, BTN: 97.8 }));
    expect([...sc.put]).toEqual([["HJ", 28]]);
    expect(sc.level).toBe(28);
    expect([...sc.allIn]).toEqual(["HJ"]);
    expect([...sc.aggressors]).toEqual(["HJ"]);
    expect([...sc.folded]).toEqual(["CO"]);
  });
  it("an all-in for no more than the price is a call: not an aggressor", () => {
    const sc = streetChips([{ seat: "A", kind: "raise", to: 50 }, { seat: "B", kind: "allin", to: 20 }], caps({ A: 100, B: 20 }));
    expect([...sc.aggressors]).toEqual(["A"]);
    expect([...sc.allIn]).toEqual(["B"]);
  });
});

describe("contestedChips: the matched chips for a set of contesting seats", () => {
  it("the full table: a 150 shove into 50 behind is a 50 bet; 100 goes back", () => {
    const r = contestedChips(new Map([["V", 150]]), { contesting: ["V", "H"], folded: new Set(), capOf: caps({ V: 150, H: 50 }) });
    expect(r.sum).toBe(50);
    expect(r.returned).toEqual([{ seat: "V", bb: 100 }]);
  });
  it("review r2: 4-way, SB shoves 80, BB and CO (200) call, hero 60 — the full table 240, the tree's seats (SB + hero) 180", () => {
    const put = new Map([["SB", 80], ["BB", 80], ["CO", 80]]);
    const capOf = caps({ SB: 80, BB: 200, CO: 200, BTN: 60 });
    expect(contestedChips(put, { contesting: ["SB", "BB", "CO", "BTN"], folded: new Set(), capOf }).sum).toBe(240);
    expect(contestedChips(put, { contesting: ["SB", "BTN"], folded: new Set(), capOf, hero: "BTN" }).sum).toBe(180);
  });
  it("review r1 §2: a ghost plan BB 40 / CO 200 / hero 30, the ghosted SB 200 — CO's 100 bet counts 40 for the tree, 100 for the table", () => {
    const put = new Map([["CO", 100]]);
    const capOf = caps({ SB: 200, BB: 40, CO: 200, BTN: 30 });
    expect(contestedChips(put, { contesting: ["SB", "BB", "CO", "BTN"], folded: new Set(), capOf }).sum).toBe(100);
    expect(contestedChips(put, { contesting: ["BB", "CO", "BTN"], folded: new Set(), capOf, hero: "BTN" }).sum).toBe(40);
  });
  it("review r2 §1: the dead money's cap counts a folded tree villain at the chips he left (every tree villain folded: not 0)", () => {
    // hero SB bets 10, BB calls, CO folds, the left-out BTN raises to 30, BB folds: no tree villain is still in
    const put = new Map([["SB", 10], ["BB", 10], ["BTN", 30]]);
    const r = contestedChips(put, { contesting: ["SB", "BB", "CO"], folded: new Set(["BB", "CO"]), capOf: caps({ SB: 100, BB: 20, CO: 100, BTN: 100 }), hero: "SB" });
    expect(r.bySeat.get("BTN")).toBe(10);   // up to the most another tree seat put in (BB's 10) — it was 0
    expect(r.sum).toBe(30);
  });
  it("an unknown stack never lets an excess be taken off", () => {
    expect(contestedChips(new Map([["V", 150]]), { contesting: ["V", "H"], folded: new Set(), capOf: () => null }).sum).toBe(150);
  });
});

describe("foldStreet / moneyEntering", () => {
  it("a flop bet and two calls, a turn check-through: the pot and each seat's own stack entering the river", () => {
    const st0 = moneyState(6, [["SB", 97], ["BB", 97], ["CO", 40], ["BTN", 97]]);
    const streets: Act<string>[][] = [
      streetFromTokens(["R3", "C", "F", "C"], ["SB", "BB", "CO", "BTN"]),
      streetFromTokens(["X", "X", "X"], ["SB", "BB", "BTN"]),
    ];
    const st = moneyEntering(st0, streets, 2);
    expect(st.pot).toBe(15);
    expect([...st.behind]).toEqual([["SB", 94], ["BB", 94], ["CO", 40], ["BTN", 94]]);
    expect([...st.folded]).toEqual(["CO"]);
    expect([...st.aggressors]).toEqual(["SB"]);
  });
  it("an earlier-street all-in at the table's amount; the deep seats' excess over it is matched between them", () => {
    const st = foldStreet(moneyState(20, [["SB", 30], ["BB", 200], ["CO", 200]]), streetFromTokens(["RAI", "R80", "C"], ["SB", "BB", "CO"], [25]));
    expect(st.pot).toBe(205);   // 20 + 25 + 80 + 80
    expect(st.behind.get("SB")).toBe(5);    // 25 of his 30: the table's amount, not his whole stack
    expect(st.behind.get("BB")).toBe(120);
  });
  it("an uncalled excess goes back to its owner", () => {
    const st = foldStreet(moneyState(10, [["A", 100], ["B", 30]]), streetFromTokens(["R60", "C"], ["A", "B"]));
    expect(st.pot).toBe(70);
    expect(st.behind.get("A")).toBe(70);
    expect([...st.allIn]).toEqual(["B"]);
  });
});

describe("foldRound: a round's chips, not its tokens", () => {
  it("the same state as foldStreet over the same street, with the matched chips and the excess handed back", () => {
    const st0 = moneyState(10, [["A", 100], ["B", 30], ["C", 100]]);
    const acts = streetFromTokens(["R60", "C", "F"], ["A", "B", "C"]);
    const f = foldRound(st0, streetChips(acts, (k: string) => st0.behind.get(k) ?? null));
    expect(f.state).toEqual(foldStreet(st0, acts));
    expect(f.matched.sum).toBe(60);
    expect(f.matched.returned).toEqual([{ seat: "A", bb: 30 }]);
  });
  it("a named contesting set: a seat outside it never caps anyone", () => {
    const st0 = moneyState(0, [["A", 100], ["B", 30], ["Z", 500]]);
    const f = foldRound(st0, { put: new Map([["A", 60], ["B", 30]]), folded: [] }, ["A", "B"]);
    expect(f.matched.returned).toEqual([{ seat: "A", bb: 30 }]);   // Z (never acted) would have let A's 60 stand
  });
});

/**
 * PROPERTIES OVER LEGAL STREETS (review r2 §4, 2026-10-03). The generator plays only legal streets — a folded or
 * all-in seat never acts, a call is never more than the level (an all-in for less when the stack is short), a raise is
 * at least a min-raise and below the stack, an all-in is the seat's whole stack, the action closes — over two or three
 * streets with short and deep stacks. Each street is checked against an INDEPENDENT settlement written here (side pots
 * by the levels of the seats still in; the part of a pot only one seat is eligible for, above what anyone else put into
 * it, goes back): the matched chips per seat, the excess returned, the pot's growth and each seat's stack after — with
 * no clamp to hide a negative.
 */
describe("properties: legal streets against an independent side-pot settlement", () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const c2 = (x: number) => Math.round(x * 100) / 100;
  const SEATS = ["A", "B", "C", "D", "E"];
  /** how often the hard cases came up (asserted at the end: the properties are not vacuous) */
  const seen = { excess: 0, allInForLess: 0, sidePots: 0, folds: 0 };

  /** one legal street over `order`: the acts, each seat's chips in, who folded / went all-in */
  function playStreet(order: string[], behind: Map<string, number>, out: Set<string>) {
    const active = order.filter((s) => !out.has(s) && (behind.get(s) ?? 0) > 0.005);
    const inv = new Map<string, number>(), folded = new Set<string>(), allIn = new Set<string>();
    const acts: Act<string>[] = [];
    let level = 0, minRaise = 1;
    const canAct = (s: string) => !folded.has(s) && !allIn.has(s);
    let toAct = active.slice();
    for (let guard = 0; toAct.length && guard < 60; guard++) {
      const s = toAct.shift()!;
      if (!canAct(s)) continue;
      const others = active.filter((t) => t !== s && canAct(t));
      const inHand = active.filter((t) => t !== s && !folded.has(t));
      if (!inHand.length) break;                                      // everyone else folded: the street is over
      const stack = behind.get(s)!, mine = inv.get(s) ?? 0;
      const facing = level > mine + 0.005;
      const r = rnd();
      let to = mine, act: Act<string>;
      if (facing && r < 0.25) { act = { seat: s, kind: "fold" }; folded.add(s); acts.push(act); continue; }
      if (facing && (r < 0.6 || !others.length)) { to = Math.min(level, stack); act = { seat: s, kind: "call" }; }
      else if (!facing && (r < 0.45 || !others.length)) { act = { seat: s, kind: "check" }; }
      else {
        const minTo = c2(level + minRaise);
        if (minTo < stack - 0.01 && r < 0.88) {
          to = c2(minTo + rnd() * Math.min(40, stack - 0.01 - minTo));
          act = { seat: s, kind: "raise", to };
        } else {
          to = stack;
          act = rnd() < 0.5 ? { seat: s, kind: "allin", to: stack } : { seat: s, kind: "allin" };   // the whole stack
        }
      }
      acts.push(act);
      inv.set(s, to);
      if (to >= stack - 0.005) allIn.add(s);
      if (to > level + 0.005) {
        if (to - level >= minRaise) minRaise = c2(to - level);
        level = to;
        // everyone else still able to act must answer the raise, in turn order after the raiser
        const i = order.indexOf(s);
        toAct = [...order.slice(i + 1), ...order.slice(0, i)].filter((t) => active.includes(t) && canAct(t));
      }
    }
    return { acts, inv, folded, allIn };
  }

  /** the independent settlement: side pots by the levels the seats still in reached */
  function settle(inv: Map<string, number>, folded: Set<string>) {
    const live = [...inv.keys()].filter((s) => !folded.has(s) && inv.get(s)! > 0);
    const levels = [...new Set(live.map((s) => inv.get(s)!))].sort((x, y) => x - y);
    const matched = new Map<string, number>([...inv.keys()].map((s) => [s, 0]));
    const returned = new Map<string, number>();
    let prev = 0;
    for (const L of levels) {
      const part = new Map<string, number>();
      for (const [s, x] of inv) { const p = Math.max(0, Math.min(x, L) - prev); if (p > 0) part.set(s, p); }
      const eligible = live.filter((s) => inv.get(s)! >= L);
      if (eligible.length === 1) {
        // only one seat can win this layer: his chips above what anyone else put into it go back
        const e = eligible[0]!;
        const others = Math.max(0, ...[...part].filter(([s]) => s !== e).map(([, p]) => p));
        const back = (part.get(e) ?? 0) - others;
        if (back > 0.005) { returned.set(e, c2((returned.get(e) ?? 0) + back)); part.set(e, others); }
      }
      for (const [s, p] of part) matched.set(s, matched.get(s)! + p);
      prev = L;
    }
    // folded chips above the top live level would belong to no pot — a legal street never has any
    const top = levels.length ? levels[levels.length - 1]! : 0;
    for (const [s, x] of inv) if (folded.has(s)) expect(x).toBeLessThanOrEqual(top + 0.005);
    return { matched, returned };
  }

  for (let n = 0; n < 300; n++) {
    const k = 2 + Math.floor(rnd() * 4);
    const order = SEATS.slice(0, k);
    const stacks = new Map(order.map((s) => [s, c2(rnd() < 0.3 ? 1 + rnd() * 20 : 20 + rnd() * 180)] as [string, number]));
    it(`hand ${n} (${k} seats): matched chips, the excess, the pot and the stacks agree with the settlement`, () => {
      let st = moneyState(3, [...stacks]);
      const out = new Set<string>();
      for (let street = 0; street < 3; street++) {
        const behind = new Map([...st.behind].map(([s, b]) => [s, b!] as [string, number]));
        const g = playStreet(order, behind, out);
        // the street as streetChips reads it: each seat's chips exactly as played, nobody over his stack
        const sc = streetChips(g.acts, (s) => behind.get(s)!);
        for (const s of order) expect(c2(sc.put.get(s) ?? 0)).toBe(c2(g.inv.get(s) ?? 0));
        for (const [s, x] of sc.put) expect(x).toBeLessThanOrEqual(behind.get(s)! + 0.005);
        const ref = settle(g.inv, new Set([...g.folded]));
        if (ref.returned.size) seen.excess++;
        if ([...g.allIn].some((s) => (g.inv.get(s) ?? 0) < Math.max(...g.inv.values()) - 0.005)) seen.allInForLess++;
        if (new Set([...g.inv].filter(([s]) => !g.folded.has(s)).map(([, x]) => x)).size > 1) seen.sidePots++;
        if (g.folded.size) seen.folds++;
        const f = foldRound(st, sc);
        for (const s of order) expect(Math.abs((f.matched.bySeat.get(s) ?? 0) - (ref.matched.get(s) ?? 0))).toBeLessThan(0.011);
        expect(f.matched.returned.map((x) => [x.seat, x.bb])).toEqual([...ref.returned]);
        const growth = [...ref.matched.values()].reduce((x, y) => x + y, 0);
        expect(Math.abs(f.state.pot - st.pot - growth)).toBeLessThan(0.011);
        for (const s of order) {
          const want = behind.get(s)! - (ref.matched.get(s) ?? 0);
          expect(want).toBeGreaterThan(-0.005);                         // no negative for a clamp to hide
          expect(Math.abs(f.state.behind.get(s)! - want)).toBeLessThan(0.011);
        }
        expect(foldStreet(st, g.acts)).toEqual(f.state);
        st = f.state;
        for (const s of [...g.folded, ...g.allIn]) out.add(s);
        if (order.filter((s) => !out.has(s)).length < 2) break;
      }
    });
  }
  it("the generator reaches the hard cases (an excess handed back, an all-in for less, side pots, folds)", () => {
    expect(seen.excess).toBeGreaterThan(20);
    expect(seen.allInForLess).toBeGreaterThan(20);
    expect(seen.sidePots).toBeGreaterThan(20);
    expect(seen.folds).toBeGreaterThan(50);
    console.log(`  legal-street properties: ${JSON.stringify(seen)}`);
  });
});

describe("deadMoney / effectiveStack", () => {
  it("antes and a dead post, added once", () => {
    expect(deadMoney({ antes: 1.2, deadPosts: 1 })).toBe(2.2);
    expect(deadMoney({})).toBe(0);
  });
  it("hero against the deepest villain; an unknown stack never shrinks it", () => {
    expect(effectiveStack(["HJ", "CO", "BTN"], "BTN", caps({ HJ: 28, CO: 113.2, BTN: 97.8 }))).toBe(97.8);
    expect(effectiveStack(["HJ", "BTN"], "BTN", caps({ HJ: null, BTN: 97.8 }))).toBe(97.8);
    expect(effectiveStack(["HJ", "BTN"], "BTN", () => null)).toBe(Infinity);
  });
});
