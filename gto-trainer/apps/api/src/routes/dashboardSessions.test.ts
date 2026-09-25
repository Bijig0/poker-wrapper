/**
 * The dashboard's session partition and live rows, through the real routes over the (test-root) central DB:
 *   - an undeclared gap cluster never pulls in a declared session's hand, and its link from /sessions resolves
 *     (the list and the cluster page used to cluster different hand sets — 24 real links broke, 2026-09-25 audit);
 *   - a hand the wrapper is still playing (status 'live') is on the Hands tab and in no session or analytic.
 * The rows are real hands.db rows (utils/archivedHand/archivedHand.test.ts: 719, 723), re-timed and re-stamped.
 */
import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as gtowApiMod from "../services/gtowApi";
import { openStore } from "../services/storePaths";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";
import { handsDbPath } from "../services/storePaths";

// nothing here may reach GTO Wizard
spyOn(gtowApiMod.gtowApi, "tokenStatus").mockImplementation((() => ({})) as never);
afterAll(() => mock.restore());

const BASE = {"tableSlot":null,"panelPort":7700,"bbCents":200,"heroSeatId":4,"heroCards":["5♠","5♣"],"board":["2♦","J♠","J♥"],"street":"flop","actions":[{"seatId":1,"hero":false,"type":"post-sb","street":"preflop","amount":0.5},{"seatId":3,"hero":false,"type":"post-bb","street":"preflop","amount":1},{"seatId":4,"hero":true,"type":"raise","street":"preflop","amount":2.5},{"seatId":1,"hero":false,"type":"fold","street":"preflop"},{"seatId":3,"hero":false,"type":"call","street":"preflop","amount":1.5},{"seatId":3,"hero":false,"type":"check","street":"flop"},{"seatId":4,"hero":true,"type":"bet","street":"flop","amount":1.4},{"seatId":3,"hero":false,"type":"fold","street":"flop"}],"liveSeats":[1,3,4],"committed":{"4":1.4},"potByStreet":{},"positions":{"1":"SB","3":"BB","4":"BTN"},"stacks":{"2":99.5,"3":97.5,"4":97.5,"6":100},"currentNode":{"street":"flop","toActSeatId":4,"toActIsHero":false,"pot":5.5,"toCall":0,"legalActions":[],"complete":false},"heroFolded":false,"heroWon":true,"ended":true,"stakes":"$1.00/$2.00","result":{"text":"★ Player 4 wins ($10.45).","winnerSeat":4,"winnerLabel":"Player 4","wonCents":1045,"heroWon":true}};

const T0 = 1_790_000_000_000;
const MIN = 60_000;

function seed(): { a: number; b: number; c: number; live: number } {
  const db = openStore(handsDbPath());
  ensureHandsSchema(db);
  const ins = (cid: string, at: number, sessionId: string | null, status: "done" | "live") => {
    const data = JSON.stringify({ ...BASE, handId: Number(cid.slice(-3)), clientHandId: cid, playedAt: at, ...(sessionId ? { sessionId } : {}) });
    return Number(db.query(`INSERT INTO hands (hand_id, played_at, stakes, street, hero_cards, action_count, data, client_hand_id, status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(1, at, BASE.stakes, BASE.street, "5♠,5♣", BASE.actions.length, data, cid, status, Date.now()).lastInsertRowid);
  };
  const a = ins("4900000001", T0, null, "done");                      // undeclared
  const b = ins("4900000002", T0 + 10 * MIN, "session_declared", "done"); // a declared session's hand, between them
  const c = ins("4900000003", T0 + 20 * MIN, null, "done");           // undeclared, same gap cluster as a
  const live = ins("4900000004", Date.now(), null, "live");           // being played right now
  db.close();
  return { a, b, c, live };
}

const ids = seed();
const { default: app } = await import("./dashboard");
const get = async (path: string) => (await app.request(path)).json() as Promise<any>;

describe("one session partition everywhere", () => {
  it("the gap cluster the Sessions list names resolves, and never contains the declared session's hand", async () => {
    const list = await get("/sessions");
    expect(list.clusters.map((s: any) => s.id)).toEqual([`cluster-${T0}`]);
    expect(list.clusters[0].hands).toBe(2);
    const page = await get(`/sessions/cluster-${T0}`);
    expect(page.ok).toBe(true);
    const dbIds = page.hands.map((h: any) => h.dbId).sort();
    expect(dbIds).toEqual([ids.a, ids.c].sort());
  });

  it("the hand page's session is the same one its prev/next walk", async () => {
    const h = await get(`/hand/${ids.a}`);
    expect(h.session?.hands).toBe(2);
    expect(h.nav?.sessionId).toBe(`cluster-${T0}`);
    expect(h.nav?.next).toBe(ids.c);          // the declared hand between them is not a neighbour
  });
});

describe("live rows", () => {
  it("the hand being played is on the Hands tab, flagged, and in no session", async () => {
    const hands = await get("/hands");
    const live = hands.hands.find((h: any) => h.dbId === ids.live);
    expect(live?.live).toBe("live");
    expect(hands.live).toBe(1);
    const page = await get(`/sessions/cluster-${T0}`);
    expect(page.hands.some((h: any) => h.dbId === ids.live)).toBe(false);
  });
});
