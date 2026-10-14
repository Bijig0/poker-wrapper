/**
 * The feed-spot audit is RETIRED (2026-10-14, routes/dashboard.ts): the hand page no longer asks the API itself for
 * /api/feed-spot (until then every finished hand was audited against the dead 3-max library and the result kept in
 * hand_audits), and a hand carries no "discrepancies" any more. The table is history: never written.
 */
import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as gtowApiMod from "../services/gtowApi";
import { handsDbPath, openStore } from "../services/storePaths";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";

spyOn(gtowApiMod.gtowApi, "tokenStatus").mockImplementation((() => ({})) as never);

const HAND = {"heroSeatId":4,"heroCards":["5♠","5♣"],"board":[],"street":"preflop","actions":[{"seatId":1,"hero":false,"type":"post-sb","street":"preflop","amount":0.5},{"seatId":3,"hero":false,"type":"post-bb","street":"preflop","amount":1},{"seatId":4,"hero":true,"type":"raise","street":"preflop","amount":2.5},{"seatId":1,"hero":false,"type":"fold","street":"preflop"},{"seatId":3,"hero":false,"type":"fold","street":"preflop"}],"liveSeats":[1,3,4],"positions":{"1":"SB","3":"BB","4":"BTN"},"stacks":{"1":100,"3":100,"4":100},"heroFolded":false,"heroWon":true,"ended":true,"stakes":"$1.00/$2.00","handId":901,"clientHandId":"4900000901"};

const db = openStore(handsDbPath());
ensureHandsSchema(db);
const rowid = Number(db.query(`INSERT INTO hands (hand_id, played_at, stakes, street, hero_cards, action_count, data, client_hand_id, status, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(901, Date.now(), HAND.stakes, "preflop", "5♠,5♣", HAND.actions.length, JSON.stringify(HAND), HAND.clientHandId, "done", 1000).lastInsertRowid);

// the retired audit was the API asking itself: count any such request
let audits = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input).endsWith("/api/feed-spot")) { audits++; return new Response(JSON.stringify({ ok: true, discrepancies: [] })); }
  return realFetch(input, init);
}) as typeof fetch;
const { default: app, _restartForTests } = await import("./dashboard");

// bun test is one process over one test root: the next file's hand set must not see this row
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
  db.run("DELETE FROM hands WHERE rowid = ?", [rowid]);
  db.close();
  _restartForTests();
});

describe("the feed-spot audit is retired", () => {
  it("the hand page and the hands list ask for no audit and carry no discrepancies; hand_audits is not written", async () => {
    const hand: any = await (await app.request(`/hand/${rowid}`)).json();
    expect(hand.ok).toBe(true);
    expect(hand.discrepancies).toBeUndefined();
    const list: any = await (await app.request("/hands")).json();
    expect(list.auditPending).toBeUndefined();
    expect(list.hands.find((h: any) => h.dbId === rowid)?.discrepancies).toBeUndefined();
    expect(audits).toBe(0);
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hand_audits'").get();
    if (table) expect(db.query("SELECT count(*) AS n FROM hand_audits WHERE hand_rowid = ?").get(rowid)).toEqual({ n: 0 });
  });
});
