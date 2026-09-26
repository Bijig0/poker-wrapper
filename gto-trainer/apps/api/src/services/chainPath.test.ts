import { describe, expect, it } from "bun:test";
import { classifyPath, cleanRate, faultPath, headline, isClean, technicalReport, type PathRow } from "./chainPath";
import { streetProvenance } from "./aiChain";
import type { StreetRecord } from "./handFacts";

describe("chainPath — the verdict is the worst thing on the path", () => {
  it("a memo hit, a resume and a first walk are clean", () => {
    const p = classifyPath({ street: "river", arrival: { how: "hit", producer: "pin-chart6max" }, streets: [
      { street: "flop", plan: null, how: "hit", tree: "none" },
      { street: "turn", plan: null, how: "resumed", tree: "cached" },
      { street: "river", plan: null, how: "first", tree: "created" },
    ] });
    expect(p.verdict).toBe("clean");
    expect(p.reasons).toEqual([]);
    expect(headline(p)).toBeNull();
  });

  it("by design counts as clean; a rebuild outranks it; an extra request outranks a rebuild", () => {
    const byDesign = classifyPath({ street: "turn", arrival: { how: "by-design", producer: "ai-arrival", code: "arrival:hero-left-pick", why: "hero left the pick" }, streets: [] });
    expect(byDesign.verdict).toBe("by-design");
    expect(isClean(byDesign.verdict)).toBe(true);
    const rebuilt = classifyPath({ street: "turn", arrival: { how: "by-design", producer: "ai-arrival" }, streets: [
      { street: "flop", plan: null, how: "rebuilt", code: "street:memo-lost", why: "memo lost", tree: "cached" },
    ] });
    expect(rebuilt.verdict).toBe("rebuilt");
    expect(headline(rebuilt)).toContain("memo lost");
    const leaked = classifyPath({ street: "turn", streets: [
      { street: "flop", plan: null, how: "rebuilt", tree: "cached" },
      { street: "turn", plan: null, how: "resumed", tree: "created", leak: { code: "tree:recreated", why: "stack changed" } },
    ] });
    expect(leaked.verdict).toBe("leaked");
    expect(leaked.reasons.map((r) => r.code)).toEqual(["street:rebuilt", "tree:recreated"]);
  });

  it("no answer is a fault, grouped by its fail kind", () => {
    const f = faultPath("flop", "capture-fault", "the capture of this hand is internally inconsistent");
    expect(f.verdict).toBe("fault");
    expect(f.reasons[0]!.code).toBe("fault:capture-fault");
  });
});

describe("the clean rate — over hands that reached a postflop decision", () => {
  const row = (hand: string, street: string, v: string | null, path?: object): PathRow =>
    ({ ts: Number(hand.slice(-2)) * 10 + street.length, client_hand_id: hand, street, text: v === "fault" ? null : "x", path_verdict: v, path: path ? JSON.stringify(path) : null });
  const rows: PathRow[] = [
    row("h01", "preflop", "clean"), row("h01", "flop", "clean"), row("h01", "turn", "by-design"),     // clean (by design)
    row("h02", "preflop", "clean"), row("h02", "flop", "rebuilt", classifyPath({ street: "flop", arrival: { how: "rebuilt", producer: "recon6max", code: "arrival:no-pin", why: "no pin" }, streets: [] })),
    row("h03", "preflop", "clean"),                                                                  // preflop only: not a chain hand
    row("h04", "preflop", "rebuilt"), row("h04", "flop", "clean"),                                   // chart server down preflop
    row("h05", "flop", null),                                                                        // logged before the ledger: left out
  ];
  it("counts each chain hand once, at its worst decision", () => {
    const c = cleanRate(rows);
    expect(c.hands).toBe(3);
    expect(c.clean).toBe(1);
    expect(c.byVerdict).toEqual({ clean: 0, "by-design": 1, rebuilt: 2, leaked: 0, failed: 0, fault: 0 });
    expect(c.rate).toBeCloseTo(1 / 3, 5);
  });
  it("the technical report groups the reasons by code, with the hands they hit", () => {
    const t = technicalReport(rows);
    expect(t.reasons.map((r) => [r.code, r.n, r.hands])).toEqual([["arrival:no-pin", 1, ["h02"]]]);
    expect(t.decisions.total).toBe(8);
    expect(t.decisions.byVerdict.rebuilt).toBe(2);
  });
  it("an empty session has no rate, not a zero one", () => {
    expect(cleanRate([]).rate).toBeNull();
  });
});

describe("streetProvenance — a re-walk is named from the hand's own ledger", () => {
  const rec = (x: Partial<StreetRecord>): StreetRecord =>
    ({ k: 0, first: 0, plan: null, root: "R", entry: "R", key: "E0", tokens: ["X", "R3", "C"], kind: "closed", at: 1, ...x });
  const base = { k: 0, first: 0, plan: null, entry: "R", toks: ["X", "R3", "C"], isLast: false, resumed: false };
  it("no record: the first walk", () => {
    expect(streetProvenance({ ...base, records: [] }).how).toBe("first");
  });
  it("resumed at hero's node: happy", () => {
    expect(streetProvenance({ ...base, records: [rec({ kind: "partial", key: "R", tokens: ["X"] })], resumed: true }).how).toBe("resumed");
  });
  it("the same street, same inputs, walked again: the memo was lost", () => {
    const p = streetProvenance({ ...base, records: [rec({})] });
    expect([p.how, p.code]).toEqual(["rebuilt", "street:memo-lost"]);
  });
  it("the capture re-read the street", () => {
    const p = streetProvenance({ ...base, toks: ["X", "X"], records: [rec({})] });
    expect([p.how, p.code]).toEqual(["rebuilt", "street:capture-changed"]);
    expect(p.why).toContain("[X,R3,C] when walked, [X,X] now");
  });
  it("the ranges entering it changed", () => {
    const p = streetProvenance({ ...base, entry: "R2", records: [rec({})] });
    expect([p.how, p.code]).toEqual(["rebuilt", "street:inputs-changed"]);
  });
  it("another collapse plan's first walk is by design", () => {
    const p = streetProvenance({ ...base, plan: "SB+BB merged", records: [rec({ plan: "3-way" })] });
    expect([p.how, p.code]).toEqual(["by-design", "street:new-plan"]);
  });
  it("the decision street: first ask walks its root; a re-ask whose resume point is gone is a rebuild", () => {
    const last = { ...base, toks: ["X"], isLast: true };
    expect(streetProvenance({ ...last, records: [] }).how).toBe("first");
    const p = streetProvenance({ ...last, records: [rec({ kind: "partial", key: "R", tokens: ["X"] })] });
    expect([p.how, p.code]).toEqual(["rebuilt", "street:memo-lost"]);
    const moved = streetProvenance({ ...last, records: [rec({ kind: "partial", key: "R", tokens: ["X"] })], resumeMiss: "a wager before hero's node, new tree" });
    expect([moved.how, moved.code]).toEqual(["by-design", "street:tree-changed"]);
  });
});
