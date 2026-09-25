import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandFacts, isDurableKey } from "./handFacts";
import { emptyCounts } from "./requestScope";
import type { ChartPreflopPin } from "./preflopPin";

const dir = mkdtempSync(join(tmpdir(), "hand-facts-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows may hold the WAL */ } });

const pin = (key: string): ChartPreflopPin => ({
  piece: "chart6max", handKey: key, chartId: "ign200_6max_D100_s100_eq", depth: 100, rawTokens: ["F", "F", "R2.5"], codes: ["F", "F", "R2.5"],
  heroPos: "CO", actionIndex: 4, at: 1,
});

describe("handFacts — the hand's facts, write-through (2026-09-25)", () => {
  it("a site hand id is durable, the wrapper's small counter is not", () => {
    expect(isDurableKey("4920544353")).toBe(true);
    expect(isDurableKey("140706500001")).toBe(true);
    expect(isDurableKey("37")).toBe(false);
    expect(isDurableKey("")).toBe(false);
  });

  it("every fact survives a restart: a second store on the same file reads it back", () => {
    const path = join(dir, "restart.sqlite");
    const a = new HandFacts(path);
    a.setPreflop("4920000001", pin("4920000001"), "AdKc");
    a.dealtOnce("4920000001", () => ({ dealt: { 1: 100, 5: 98.5 }, depth: 98.5, street: "flop", at: 1 }));
    a.recordStreet("4920000001", { k: 0, first: 0, plan: null, root: "r", entry: "r", key: "x0", tokens: ["X", "R3", "C"], kind: "closed", at: 1 });
    a.addRequests("4920000001", "live", { ...emptyCounts(), tree: 1, solution: 1, poll: 5 });
    a.addRequests("4920000001", "live", { ...emptyCounts(), poll: 2 });
    const b = new HandFacts(path);        // the API restarted
    const doc = b.get("4920000001")!;
    expect((doc.preflop as ChartPreflopPin).chartId).toBe("ign200_6max_D100_s100_eq");
    expect(doc.heroCards).toBe("AdKc");
    expect(doc.dealt?.dealt[5]).toBe(98.5);
    expect(doc.streets?.[0]?.tokens).toEqual(["X", "R3", "C"]);
    expect(doc.requests?.live?.poll).toBe(7);
  });

  it("the stacks as dealt are read ONCE: the first read wins, a later one is ignored", () => {
    const f = new HandFacts(":memory:");
    const first = f.dealtOnce("4920000002", () => ({ dealt: { 1: 100 }, depth: 100, street: "flop", at: 1 }));
    let called = false;
    const second = f.dealtOnce("4920000002", () => { called = true; return { dealt: { 1: 97 }, depth: 97, street: "turn", at: 2 }; });
    expect(called).toBe(false);
    expect(second.depth).toBe(first.depth);
  });

  it("a non-durable key stays in memory and is never written to disk", () => {
    const path = join(dir, "counter.sqlite");
    const a = new HandFacts(path);
    a.setPreflop("37", pin("37"));
    expect(a.preflop("37")).toBeDefined();
    const b = new HandFacts(path);
    expect(b.preflop("37")).toBeUndefined();
  });

  it("an AI pin's background pre-fetch (a Promise) is not written as a fact", () => {
    const path = join(dir, "warm.sqlite");
    const a = new HandFacts(path);
    a.setPreflop("4920000003", { ...pin("4920000003"), piece: "gtow-ai-preflop", solId: "s1", id: "gtow-ai", shape: {} as any, reduced: null, warm: Promise.resolve() } as any);
    const doc = new HandFacts(path).get("4920000003")!;
    expect("warm" in (doc.preflop as object)).toBe(false);
  });

  it("the warm-up's request counts persist (origin \"warm\" is a fact, not the pin's Promise)", () => {
    const path = join(dir, "warm-origin.sqlite");
    const a = new HandFacts(path);
    a.setPreflop("4920000006", { ...pin("4920000006"), piece: "gtow-ai-preflop", solId: "s1", id: "gtow-ai", shape: {} as any, reduced: null, warm: Promise.resolve() } as any);
    a.addRequests("4920000006", "live", { ...emptyCounts(), tree: 1, poll: 9 });
    a.addRequests("4920000006", "warm", { ...emptyCounts(), tree: 1, poll: 4 });
    const doc = new HandFacts(path).get("4920000006")!;
    expect(doc.requests?.warm?.poll).toBe(4);
    expect(doc.requests?.live?.poll).toBe(9);
  });

  it("forget removes a hand from memory and disk; dropMemory keeps the disk", () => {
    const path = join(dir, "forget.sqlite");
    const a = new HandFacts(path);
    a.setPreflop("4920000004", pin("4920000004"));
    a.dropMemory();
    expect(a.preflop("4920000004")).toBeDefined();   // read back from disk
    a.forget("4920000004");
    expect(new HandFacts(path).preflop("4920000004")).toBeUndefined();
  });

  it("a street record replaces the one with the same key and kind (a re-ask moves hero's resume point on)", () => {
    const f = new HandFacts(":memory:");
    const rec = { k: 0, first: 0, plan: null, root: "r", entry: "r", key: "r", kind: "partial" as const, at: 1 };
    f.recordStreet("4920000005", { ...rec, tokens: ["X"] });
    f.recordStreet("4920000005", { ...rec, tokens: ["X", "R3", "R9"] });
    expect(f.streets("4920000005").map((s) => s.tokens)).toEqual([["X", "R3", "R9"]]);
  });
});
