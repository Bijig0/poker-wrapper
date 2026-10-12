import { describe, expect, test } from "bun:test";
import { drewNode, HandNodeStore, nodeKeyOf } from "./handNodeStore";
import { HandNodeBuilder, heroDecisions, type BuilderDeps } from "./handNodeBuilder";

describe("nodeKeyOf", () => {
  test("answer-node keys on the decision, the answer and the ranges flag", () => {
    expect(nodeKeyOf("answer-node", { dbId: "5", upto: "7", ranges: "1" })).toBe("answer-node:7:ranges");
    expect(nodeKeyOf("answer-node", { dbId: "5", upto: "7" })).toBe("answer-node:7");
    expect(nodeKeyOf("answer-node", { dbId: "5", upto: "7", answerId: "42" })).toBe("answer-node:7:a42");
    expect(nodeKeyOf("answer-node", { dbId: "5" })).toBeNull();
  });
  test("preflop-path keys on the AI flag", () => {
    expect(nodeKeyOf("preflop-path", { dbId: "5" })).toBe("preflop-path");
    expect(nodeKeyOf("preflop-path", { dbId: "5", ai: "1" })).toBe("preflop-path:ai");
  });
});

describe("HandNodeStore", () => {
  test("keeps ok responses and reads them back", () => {
    const s = new HandNodeStore(":memory:");
    expect(s.put(1, "answer-node:3:ranges", { ok: true, kind: "hrc", node: { pos: "BTN" } }, "abc")).toBe(true);
    const got = s.get(1, "answer-node:3:ranges")!;
    expect(got.body.node.pos).toBe("BTN");
    expect(got.commit).toBe("abc");
    expect(s.get(1, "answer-node:4:ranges")).toBeNull();
  });
  test("never keeps an error", () => {
    const s = new HandNodeStore(":memory:");
    expect(s.put(1, "preflop-path", { ok: false, error: "x is not reachable" })).toBe(false);
    expect(s.get(1, "preflop-path")).toBeNull();
  });
  test("a rebuild that draws no node never replaces one that did", () => {
    const s = new HandNodeStore(":memory:");
    s.put(1, "answer-node:3:ranges", { ok: true, kind: "ai-preflop", view: { hero: { pos: "CO" } } }, "old");
    expect(s.put(1, "answer-node:3:ranges", { ok: true, kind: "ai-chain", note: "pruned" }, "new")).toBe(false);
    expect(s.get(1, "answer-node:3:ranges")!.commit).toBe("old");
    expect(s.put(1, "answer-node:3:ranges", { ok: true, kind: "ai-preflop", view: { hero: { pos: "CO" } } }, "new")).toBe(true);
    expect(s.get(1, "answer-node:3:ranges")!.commit).toBe("new");
  });
  test("built hands are remembered", () => {
    const s = new HandNodeStore(":memory:");
    s.markBuilt(9, 3, 0, 120);
    expect(s.builtIds().has(9)).toBe(true);
    expect(s.stats().hands).toBe(1);
  });
  test("drewNode", () => {
    expect(drewNode({ ok: true, steps: [{}] })).toBe(true);
    expect(drewNode({ ok: true, steps: [] })).toBe(false);
    expect(drewNode({ ok: true, logged: { solveId: 4 } })).toBe(true);
    expect(drewNode({ ok: true, mes: {} })).toBe(true);
    expect(drewNode({ ok: false, node: {} })).toBe(false);
  });
});

describe("HandNodeBuilder", () => {
  const rowsOf = (...ids: number[]) => ids.map((rowid) => ({ rowid }) as any);
  const depsWith = (over: Partial<BuilderDeps> = {}): BuilderDeps & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      store: new HandNodeStore(":memory:"),
      live: () => false,
      rows: () => rowsOf(1, 2, 3),
      request: async (u) => { asked.push(u); return { ok: true }; },
      heroIdx: () => [4, 9],
      sleep: async () => {},
      now: () => 0,
      ...over,
    };
  };

  test("heroDecisions skips posts and villains", () => {
    expect(heroDecisions([{ hero: true, type: "post-sb" }, { type: "raise" }, { hero: true, type: "call" }])).toEqual([2]);
  });
  test("builds every unbuilt hand, newest first, the path and each hero decision", async () => {
    const d = depsWith();
    d.store.markBuilt(2, 1, 0, 0);
    await new HandNodeBuilder(d).tick();
    expect(d.asked).toEqual([
      "/preflop-path?dbId=3&fresh=1", "/answer-node?dbId=3&upto=4&ranges=1&fresh=1", "/answer-node?dbId=3&upto=9&ranges=1&fresh=1",
      "/preflop-path?dbId=1&fresh=1", "/answer-node?dbId=1&upto=4&ranges=1&fresh=1", "/answer-node?dbId=1&upto=9&ranges=1&fresh=1",
    ]);
    expect([...d.store.builtIds()].sort()).toEqual([1, 2, 3]);
  });
  test("does nothing while a session is live", async () => {
    const d = depsWith({ live: () => true });
    await new HandNodeBuilder(d).tick();
    expect(d.asked).toEqual([]);
  });
  test("a session starting mid-hand leaves that hand unbuilt", async () => {
    let n = 0;
    const d = depsWith({ live: () => ++n > 3, rows: () => rowsOf(1) });
    await new HandNodeBuilder(d).tick();
    expect(d.store.builtIds().has(1)).toBe(false);
  });
  test("an unreachable chart server leaves the hand unbuilt and pauses", async () => {
    const d = depsWith({ request: async (u) => { d.asked.push(u); return { ok: false, error: "http://127.0.0.1:8777 is not reachable" }; } });
    const b = new HandNodeBuilder(d);
    await b.tick();
    expect(d.asked.length).toBe(1);
    expect(d.store.builtIds().size).toBe(0);
    await b.tick();
    expect(d.asked.length).toBe(1);   // backing off
  });
  test("rebuilds the rows served stale first", async () => {
    const d = depsWith({ rows: () => [] });
    d.store.refresh.set("1|answer-node:4:ranges", { dbId: 1, key: "answer-node:4:ranges", url: "/answer-node?dbId=1&upto=4&ranges=1&fresh=1" });
    await new HandNodeBuilder(d).tick();
    expect(d.asked).toEqual(["/answer-node?dbId=1&upto=4&ranges=1&fresh=1"]);
    expect(d.store.refresh.size).toBe(0);
  });
});
