import { describe, expect, it } from "bun:test";
import {
  actFromToken, chipsAfter, contestedChips, deadMoney, effectiveStack, foldStreet, moneyEntering, moneyState, streetChips, streetFromTokens,
  type Act,
} from "./tableMoney";

const caps = (o: Record<string, number | null>) => (k: string) => o[k] ?? null;

describe("actFromToken / streetFromTokens", () => {
  it("reads every capture token, the all-in's amount beside it", () => {
    expect(streetFromTokens(["X", "R3", "C", "F", "RAI"], ["SB", "BB", "CO", "BTN", "HJ"], [null, null, null, null, 28])).toEqual([
      { seat: "SB", kind: "check" }, { seat: "BB", kind: "raise", to: 3 }, { seat: "CO", kind: "call" }, { seat: "BTN", kind: "fold" }, { seat: "HJ", kind: "allin", to: 28 },
    ]);
    expect(actFromToken("RAI", "HJ")).toEqual({ seat: "HJ", kind: "allin" });
    expect(() => actFromToken("Q", "HJ")).toThrow();
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

describe("properties (seeded random streets)", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const seats = ["A", "B", "C", "D"];
  for (let n = 0; n < 200; n++) {
    const stacks = Object.fromEntries(seats.map((s) => [s, Math.round(rnd() * 150 * 100) / 100 + 1]));
    const acts: Act<string>[] = [];
    let level = 0;
    for (let i = 0; i < 8; i++) {
      const seat = seats[i % 4]!;
      const r = rnd();
      if (r < 0.2) acts.push({ seat, kind: "fold" });
      else if (r < 0.5) acts.push({ seat, kind: level ? "call" : "check" });
      else if (r < 0.85) { level = Math.round((level + 1 + rnd() * 30) * 100) / 100; acts.push({ seat, kind: "raise", to: level }); }
      else acts.push({ seat, kind: "allin" });
    }
    const st = foldStreet(moneyState(5, Object.entries(stacks)), acts);
    const sc = streetChips(acts, (k) => stacks[k]);
    const putSum = [...sc.put.values()].reduce((s, x) => s + x, 0);
    it(`street ${n}: pot growth = matched chips ≤ chips in; nobody negative; full table ≥ any tree's seats`, () => {
      const paid = seats.reduce((s, k) => s + (stacks[k]! - (st.behind.get(k) ?? 0)), 0);
      expect(Math.abs(st.pot - 5 - paid)).toBeLessThan(0.02);
      expect(st.pot - 5).toBeLessThanOrEqual(putSum + 0.01);
      for (const k of seats) expect(st.behind.get(k)!).toBeGreaterThanOrEqual(0);
      const capOf = (k: string) => stacks[k];
      const full = contestedChips(sc.put, { contesting: seats, folded: sc.folded, capOf }).sum;
      const tree = contestedChips(sc.put, { contesting: ["A", "B"], folded: sc.folded, capOf, hero: "A" }).sum;
      expect(full + 0.01).toBeGreaterThanOrEqual(tree);
    });
  }
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
