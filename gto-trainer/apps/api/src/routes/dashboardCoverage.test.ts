/**
 * THE COVERAGE ROUTE (2026-09-27, services/chainChecks): /coverage reads the answers' stored paths, counts every check
 * per decision over the window, filters by session, and links the failing hands to their hands.db rows. And the hand
 * page carries the checks' definitions for its Checks tab. Test-root central DB and an in-memory answer log only.
 */
import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as gtowApiMod from "../services/gtowApi";
import { openStore, handsDbPath } from "../services/storePaths";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";
import { answerLog } from "../services/answerLog";
import { classifyPath } from "../services/chainPath";
import type { PathChecks } from "../services/chainChecks";

spyOn(gtowApiMod.gtowApi, "tokenStatus").mockImplementation((() => ({})) as never);
afterAll(() => mock.restore());

const SESSION = "session_coverage_test";
const HAND_FAIL = "4900000771", HAND_OK = "4900000772";
const BASE = { tableSlot: null, bbCents: 200, heroSeatId: 4, heroCards: ["A♦", "K♣"], board: ["2♦", "J♠", "J♥"], street: "flop", actions: [],
  liveSeats: [3, 4], committed: {}, potByStreet: {}, positions: { 3: "BB", 4: "BTN" }, stacks: { 3: 97.5, 4: 97.5 },
  currentNode: { street: "flop", toActSeatId: 4, toActIsHero: true, pot: 5.5, toCall: 0, legalActions: [], complete: false },
  heroFolded: false, ended: true, stakes: "$1.00/$2.00" };

const db = openStore(handsDbPath());
ensureHandsSchema(db);
const rowOf = (cid: string) => Number(db.query(`INSERT INTO hands (hand_id, played_at, stakes, street, hero_cards, action_count, data, client_hand_id, status, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(1, Date.now(), BASE.stakes, "flop", "A♦,K♣", 0, JSON.stringify({ ...BASE, handId: 1, clientHandId: cid, playedAt: Date.now(), sessionId: SESSION }), cid, "done", Date.now()).lastInsertRowid);
const failRow = rowOf(HAND_FAIL);
rowOf(HAND_OK);
db.close();

const log = (cid: string, checks: PathChecks, sessionId = SESSION) => {
  const p = classifyPath({ street: "flop", streets: [], checks });
  answerLog.add({ ts: Date.now(), wrapperHandId: null, clientHandId: cid, street: "flop", board: "2dJsJh", heroCards: "AdKc", decisionKey: null,
    text: "FLOP — Check 100%", pick: "Check", roll: 1, tier: "ai-chain", warning: null, latencyMs: 1000, failReason: null, sessionId,
    pathVerdict: p.verdict, path: JSON.stringify(p) });
};
log(HAND_FAIL, { flop: [{ id: 5, status: "fail", text: "pot entering the flop 6bb, the capture's 5.5bb" }, { id: 15, status: "pass", text: "sums to 100%" }] });
log(HAND_OK, { flop: [{ id: 5, status: "pass", text: "pot 5.5bb" }, { id: 3, status: "flag", text: "BB check 0.2%" }] });
log("4900000773", { flop: [{ id: 5, status: "fail", text: "other session" }] }, "session_other");

const { default: app } = await import("./dashboard");
const get = async (path: string) => (await app.request(path)).json() as Promise<any>;

describe("/coverage", () => {
  it("counts each check per decision in the session, links the failing hands, lists the sessions", async () => {
    const j = await get(`/coverage?days=7&session=${SESSION}`);
    expect(j.ok).toBe(true);
    expect(j.session).toBe(SESSION);
    expect(j.withChecks).toBe(2);
    const five = j.checks.find((c: any) => c.id === 5);
    expect([five.pass, five.fail, five.failHands, five.build]).toEqual([1, 1, 1, "built"]);
    expect(five.spec).toContain("matches the capture's pot");
    expect(five.examples.map((e: any) => e.hand)).toEqual([HAND_FAIL]);
    expect(j.rowids[HAND_FAIL]).toBe(failRow);
    const three = j.checks.find((c: any) => c.id === 3);
    expect([three.flag, three.seen]).toEqual([1, true]);
    expect(j.checks.find((c: any) => c.id === 13).seen).toBe(false);
    expect(j.sessions.map((s: any) => s.id)).toEqual(expect.arrayContaining([SESSION, "session_other"]));
  });
  it("without a session it reads every session in the window", async () => {
    const j = await get("/coverage");
    expect(j.days).toBe(7);
    expect(j.checks.find((c: any) => c.id === 5).fail).toBeGreaterThanOrEqual(2);
  });
});

describe("/hand/:dbId carries the checks' definitions for the Checks tab", () => {
  it("all seventeen, with the rule", async () => {
    const h = await get(`/hand/${failRow}`);
    expect(h.ok).toBe(true);
    expect(h.checkDefs.map((d: any) => d.id)).toHaveLength(17);
    expect(h.chain?.verdict?.verdict).toBe("failed");
  });
});
