/**
 * A hand's feed-spot audit is kept (hand_audits in the central DB): an API restart no longer re-audits every finished
 * hand (2026-09-26: ~1,200 self-requests to /api/feed-spot per start). A row the wrapper rewrote since is audited again.
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

// the audit is the API asking itself: count those requests and answer them
let audits = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input).endsWith("/api/feed-spot")) {
    audits++;
    return new Response(JSON.stringify({ ok: true, discrepancies: [{ field: "open", actual: 2.5, shown: 2.3, severity: "minor" }] }));
  }
  return realFetch(input, init);
}) as typeof fetch;
const { default: app, _restartForTests } = await import("./dashboard");

// bun test is one process over one test root: the next file's hand set must not see this row
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
  db.run("DELETE FROM hands WHERE rowid = ?", [rowid]);
  db.run("DELETE FROM hand_audits WHERE hand_rowid = ?", [rowid]);
  db.close();
  _restartForTests();
});
const hand = async () => (await app.request(`/hand/${rowid}`)).json() as Promise<any>;

describe("hand audits survive a restart", () => {
  it("audited once, kept across a restart, audited again only when the row moves", async () => {
    const first = await hand();
    expect(audits).toBe(1);
    expect(first.discrepancies).toEqual([{ field: "open", actual: 2.5, shown: 2.3, severity: "minor" }]);
    expect(db.query("SELECT hand_rowid, updated_at FROM hand_audits WHERE hand_rowid = ?").get(rowid)).toEqual({ hand_rowid: rowid, updated_at: 1000 });

    _restartForTests();
    const again = await hand();
    expect(audits).toBe(1);                                  // read back, not re-asked
    expect(again.discrepancies).toEqual(first.discrepancies);

    db.run("UPDATE hands SET updated_at = 2000 WHERE rowid = ?", [rowid]);   // the award box patched the row
    _restartForTests();
    await hand();
    expect(audits).toBe(2);
    expect(db.query("SELECT updated_at FROM hand_audits WHERE hand_rowid = ?").get(rowid)).toEqual({ updated_at: 2000 });
  });
});
