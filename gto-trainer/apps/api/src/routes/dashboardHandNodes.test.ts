/**
 * The hand page's stored nodes (2026-10-12, services/handNodeStore.ts): /answer-node and /preflop-path answer from the
 * stored row, keep what they compute for a FINISHED hand only, never keep an error, queue a row from another commit for
 * a rebuild (never the AI preflop path, which can cost quota); GET /hand-bundle hands the page all of it at once.
 */
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Hono } from "hono";
import * as gtowApiMod from "../services/gtowApi";
import { handsDbPath, openStore } from "../services/storePaths";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";
import { handNodeStore, loadedCommit } from "../services/handNodeStore";

spyOn(gtowApiMod.gtowApi, "tokenStatus").mockImplementation((() => ({})) as never);

const HAND = {"heroSeatId":4,"heroCards":["5♠","5♣"],"board":[],"street":"preflop","actions":[{"seatId":1,"hero":false,"type":"post-sb","street":"preflop","amount":0.5},{"seatId":3,"hero":false,"type":"post-bb","street":"preflop","amount":1},{"seatId":4,"hero":true,"type":"raise","street":"preflop","amount":2.5},{"seatId":1,"hero":false,"type":"fold","street":"preflop"},{"seatId":3,"hero":false,"type":"fold","street":"preflop"}],"liveSeats":[1,3,4],"positions":{"1":"SB","3":"BB","4":"BTN"},"stacks":{"1":100,"3":100,"4":100},"heroFolded":false,"heroWon":true,"ended":true,"stakes":"$1.00/$2.00","handId":902,"clientHandId":"4900000902"};

const db = openStore(handsDbPath());
ensureHandsSchema(db);
const insert = (status: string, id: string) => Number(db.query(`INSERT INTO hands (hand_id, played_at, stakes, street, hero_cards, action_count, data, client_hand_id, status, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(902, Date.now(), HAND.stakes, "preflop", "5♠,5♣", HAND.actions.length, JSON.stringify({ ...HAND, clientHandId: id }), id, status, 1000).lastInsertRowid);
const done = insert("done", "4900000902");
const playing = insert("live", "4900000903");

const { default: app, storedNodes, sixMaxWithoutAnswer, _restartForTests } = await import("./dashboard");
afterAll(() => {
  mock.restore();
  db.run("DELETE FROM hands WHERE rowid IN (?, ?)", [done, playing]);
  db.close();
  _restartForTests();
});

// the real middleware in front of a counting route
let calls = 0;
let body: any;
const mini = new Hono();
mini.use("/answer-node", storedNodes("answer-node"));
mini.get("/answer-node", (c) => { calls++; return c.json(body); });
mini.use("/preflop-path", storedNodes("preflop-path"));
mini.get("/preflop-path", (c) => { calls++; return c.json(body); });
const ask = async (u: string) => (await mini.request(u)).json() as Promise<any>;
const store = handNodeStore();

beforeEach(() => { calls = 0; body = { ok: true, kind: "hrc", node: { pos: "BTN" } }; store.refresh.clear(); delete process.env.HAND_NODES; });

describe("stored nodes", () => {
  it("a finished hand's node is computed once, then read back", async () => {
    const a = await ask(`/answer-node?dbId=${done}&upto=2&ranges=1`);
    const b = await ask(`/answer-node?dbId=${done}&upto=2&ranges=1`);
    expect(calls).toBe(1);
    expect(a.node.pos).toBe("BTN");
    expect(b.node.pos).toBe("BTN");
    expect(b.stored.commit).toBe(loadedCommit());
    expect(store.refresh.size).toBe(0);
  });
  it("the ranges flag and the decision are part of the key", async () => {
    await ask(`/answer-node?dbId=${done}&upto=7&ranges=1`);
    await ask(`/answer-node?dbId=${done}&upto=7`);
    await ask(`/answer-node?dbId=${done}&upto=8&ranges=1`);
    expect(calls).toBe(3);
  });
  it("a hand still in play is never kept", async () => {
    await ask(`/answer-node?dbId=${playing}&upto=2&ranges=1`);
    await ask(`/answer-node?dbId=${playing}&upto=2&ranges=1`);
    expect(calls).toBe(2);
  });
  it("an error is never kept", async () => {
    body = { ok: false, error: "http://127.0.0.1:8777 is not reachable" };
    await ask(`/preflop-path?dbId=${done}&ai=0`);
    await ask(`/preflop-path?dbId=${done}&ai=0`);
    expect(calls).toBe(2);
  });
  it("fresh=1 computes again and replaces the row", async () => {
    store.put(done, "answer-node:3:ranges", { ok: true, kind: "hrc", node: { pos: "SB" } });
    const j = await ask(`/answer-node?dbId=${done}&upto=3&ranges=1&fresh=1`);
    expect(calls).toBe(1);
    expect(j.node.pos).toBe("BTN");
    expect(store.get(done, "answer-node:3:ranges")!.body.node.pos).toBe("BTN");
  });
  it("a row from another commit is served at once and queued for a rebuild — never the AI preflop path", async () => {
    store.put(done, "answer-node:5:ranges", { ok: true, kind: "hrc", node: { pos: "CO" } }, "old-commit");
    store.put(playing, "preflop-path:ai", { ok: true, kind: "ai", steps: [{}] }, "old-commit");
    expect((await ask(`/answer-node?dbId=${done}&upto=5&ranges=1`)).node.pos).toBe("CO");
    await ask(`/preflop-path?dbId=${playing}&ai=1`);
    expect(calls).toBe(0);
    expect([...store.refresh.values()].map((r) => r.url)).toEqual([`/answer-node?dbId=${done}&upto=5&ranges=1&fresh=1`]);
  });
  it("HAND_NODES=off passes every request through", async () => {
    process.env.HAND_NODES = "off";
    await ask(`/answer-node?dbId=${done}&upto=2&ranges=1`);
    await ask(`/answer-node?dbId=${done}&upto=2&ranges=1`);
    expect(calls).toBe(2);
  });
});

describe("GET /hand-bundle", () => {
  it("every node the page draws, keyed the way it asks; the AI path only once it was built", async () => {
    store.put(done, "preflop-path", { ok: true, kind: "hrc", steps: [{ pos: "BTN" }] });
    store.put(done, "answer-node:2:ranges", { ok: true, kind: "hrc", node: { pos: "BTN" } });
    const j = await (await app.request(`/hand-bundle?dbId=${done}`)).json() as any;
    expect(j.ok).toBe(true);
    expect(Object.keys(j.entries).sort()).toEqual(["answer-node:2", "preflop-path"]);
    expect(j.entries["answer-node:2"].node.pos).toBe("BTN");
    expect(j.entries["preflop-path"].steps[0].pos).toBe("BTN");
    store.put(done, "preflop-path:ai", { ok: true, kind: "ai", steps: [{ pos: "SB" }] });
    const k = await (await app.request(`/hand-bundle?dbId=${done}`)).json() as any;
    expect(k.entries["preflop-path:ai"].steps[0].pos).toBe("SB");
  });
  it("a hand that is not there says so", async () => {
    const r = await app.request(`/hand-bundle?dbId=99999999`);
    expect(r.status).toBe(404);
  });
});

describe("an unanswered preflop decision reads the 6-max charts by its strategy, not only a $2 bb", () => {
  const none = () => null, six = () => "ign200-ring-6max-equilibrium";
  it("NL200 and NL5 (the test stake that plays NL200's answers), 4+ seats", () => {
    expect(sixMaxWithoutAnswer(false, 6, 2, none)).toBe(true);
    expect(sixMaxWithoutAnswer(false, 4, 0.05, none)).toBe(true);
  });
  it("another stake when the hand's strategy is the 6-max ring", () => {
    expect(sixMaxWithoutAnswer(false, 5, 0.25, six)).toBe(true);
    expect(sixMaxWithoutAnswer(false, 5, 0.25, none)).toBe(false);
  });
  it("never a 3-max hand or 3 seats or fewer", () => {
    expect(sixMaxWithoutAnswer(true, 6, 2, six)).toBe(false);
    expect(sixMaxWithoutAnswer(false, 3, 2, six)).toBe(false);
  });
});
