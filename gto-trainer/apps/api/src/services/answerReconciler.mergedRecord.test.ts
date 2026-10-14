/**
 * THE RECONCILER INVENTS NO DECISION PAST THE RECORD'S OWN LINE (2026-10-14, the answer-path audit's merged records).
 * Hand 4923409614 (session_20261009_010205): the river answer BET 1.2 was served, the table's socket stalled and closed,
 * and the wrapper replayed the hand's frames into the still-open record — archived with 25 actions: the hand's 15, then
 * its blinds on the "river" (post-sb at index 15), its flop and turn again. The reconciler read hero's replayed call,
 * flop check, turn check and turn call as decisions nobody asked about: answers 13721 (socket-stall) and 13722-13724
 * (no-probe), for nodes the hand never had. The hand's REAL decisions (indices 4, 6, 9, 12, 14 of the folded line)
 * were all answered.
 *
 * The record below is that row as stored (its actions; stacks and seat words trimmed). Test-root central DB
 * (src/test/isolateLiveState.ts), an in-memory answer log, the wrapper's own sessions DDL.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { openStore, handsDbPath, sessionsDbPath } from "./storePaths";
import { ensureHandsSchema } from "../../../../packages/data-root/handsSchema";
import { answerLog } from "./answerLog";
import { reconcileAnswers } from "./answerReconciler";
import { ownActionCount, mergedTail } from "../utils/archivedHand/ownLine";

const SESSION = "session_20261009_010205_test";
const MERGED = "4923409614", CLEAN = "4923409615";

const A = (seatId: number, type: string, street: string, amount?: number) => ({ seatId, hero: seatId === 6, type, street, ...(amount !== undefined ? { amount } : {}) });
/** the hand as the table sent it (15 actions) */
const SEEN = [
  A(6, "post-sb", "preflop", 0.4), A(1, "post-bb", "preflop", 1), A(3, "post", "preflop", 1),
  A(3, "check", "preflop"), A(4, "fold", "preflop"), A(6, "call", "preflop", 0.6), A(1, "check", "preflop"),
  A(6, "check", "flop"), A(1, "check", "flop"), A(3, "check", "flop"),
  A(6, "check", "turn"), A(1, "check", "turn"), A(3, "bet", "turn", 1), A(6, "call", "turn", 1), A(1, "fold", "turn"),
];
/** what the closed socket's replay appended (the stored row's indices 15-24) */
const TAIL = [
  A(6, "post-sb", "river", 0.4), A(1, "post-bb", "river", 1), A(3, "post", "river", 1), A(3, "check", "river"), A(6, "call", "river", 0.6),
  A(6, "check", "flop"), A(3, "check", "flop"), A(6, "check", "turn"), A(3, "bet", "turn", 1), A(6, "call", "turn", 1),
];

const BASE = {
  tableSlot: 1, bbCents: 5, heroSeatId: 6, heroCards: ["2♣", "J♣"], board: ["K♦", "5♣", "J♥", "8♥", "5♠"], street: "river",
  liveSeats: [1, 3, 4, 6], committed: {}, potByStreet: {}, positions: { 6: "SB", 1: "BB", 3: "CO", 4: "BTN" },
  stacks: { 1: 121, 3: 32.8, 4: 100, 6: 131.4 }, startStacks: { 1: 121, 3: 32.8, 4: 100, 6: 131.4 },
  currentNode: { street: "river", toActSeatId: 6, toActIsHero: true, pot: 5.4, toCall: 0, legalActions: [], complete: false },
  heroFolded: false, heroWon: false, ended: false, stakes: "$0.02/$0.05", sessionId: SESSION,
  connStalls: [{ from: 1791490309.73, to: 1791490343.741, silentS: 34, street: "river", rid: "48560.8024", pageAlive: true }],
};
const PLAYED_AT = 1791490344423;

/** one finished row, as the wrapper's archive writes it (the test-root hands table) */
function insert(cid: string, handId: number, actions: unknown[]): void {
  const db = openStore(handsDbPath());
  try {
    ensureHandsSchema(db);
    db.query(`INSERT INTO hands (hand_id, played_at, stakes, street, hero_cards, action_count, data, client_hand_id, status, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(handId, PLAYED_AT, BASE.stakes, "river", "2♣,J♣", actions.length, JSON.stringify({ ...BASE, handId, clientHandId: cid, playedAt: PLAYED_AT, actions }), cid, "done", PLAYED_AT);
  } finally {
    db.close();
  }
}
insert(MERGED, 179, [...SEEN, ...TAIL]);
insert(CLEAN, 180, SEEN);

// the declared session, with study answers ON (the only hands where a missing answer is a fault) — the wrapper's DDL
const sdb = new Database(sessionsDbPath());
sdb.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, preset TEXT, label TEXT, note TEXT,
  config TEXT, preflight TEXT, versions TEXT, events TEXT, summary TEXT)`);
sdb.query("INSERT OR REPLACE INTO sessions (id, started_at, ended_at, preset, config, events) VALUES (?,?,?,?,?,?)")
  .run(SESSION, PLAYED_AT - 7_800_000, PLAYED_AT + 1_000, "strategy:test", JSON.stringify({ answers: true }), "[]");
sdb.close();

/** an answer at hero's decision `index` of the FOLDED line (the post-in folded into seat 3's check — utils/foldPostIns) */
const answered = (cid: string, street: string, index: number, text: string) =>
  answerLog.add({ ts: PLAYED_AT - 60_000 + index * 1000, wrapperHandId: 179, clientHandId: cid, street, board: null, heroCards: "2cJc",
    decisionKey: JSON.stringify([street, [], ["2c", "Jc"], 0, index]), text, pick: text, roll: null, tier: null, warning: null, latencyMs: 1000,
    failReason: null, sessionId: SESSION });
for (const cid of [MERGED, CLEAN]) {
  answered(cid, "preflop", 4, "Call");
  answered(cid, "flop", 6, "CHECK");
  answered(cid, "turn", 9, "CHECK");
  answered(cid, "turn", 12, "CALL 1");
  answered(cid, "river", 14, "BET 1.2");
}

afterAll(() => { try { answerLog.close?.(); } catch { /* in memory */ } });

describe("the record's own line", () => {
  it("ends where the replayed tail begins: a post-sb on the river after the turn's fold", () => {
    expect(ownActionCount([...SEEN, ...TAIL])).toBe(15);
    expect(mergedTail([...SEEN, ...TAIL])).toEqual(TAIL);
    expect(ownActionCount(SEEN)).toBe(SEEN.length);
    // a street going backwards is a tail too, blinds or not
    expect(ownActionCount([...SEEN, A(6, "check", "flop")])).toBe(15);
    // a post-in after the blinds, before any play, is the hand's own
    expect(ownActionCount([A(6, "post-sb", "preflop", 0.4), A(1, "post-bb", "preflop", 1), A(3, "post", "preflop", 1), A(3, "check", "preflop")])).toBe(4);
  });
});

describe("reconcileAnswers on a merged record", () => {
  it("files nothing for hero's replayed actions — every real decision was answered", () => {
    const before = answerLog.forHand(MERGED).length;
    const out = reconcileAnswers(0);
    expect(out.hands).toBeGreaterThanOrEqual(2);
    expect([out.noProbe, out.socketStall, out.attached]).toEqual([0, 0, 0]);
    expect(answerLog.forHand(MERGED).length).toBe(before);
    expect(answerLog.forHand(CLEAN).length).toBe(5);
  });
  it("still files a real gap inside the record's own line (the cut is not a blanket skip)", () => {
    // a third copy of the hand, hero's turn CHECK (index 9) never asked about
    insert("4923409616", 181, [...SEEN, ...TAIL]);
    for (const [street, index, text] of [["preflop", 4, "Call"], ["flop", 6, "CHECK"], ["turn", 12, "CALL 1"], ["river", 14, "BET 1.2"]] as const) answered("4923409616", street, index, text);
    const out = reconcileAnswers(0);
    expect([out.noProbe, out.socketStall]).toEqual([1, 0]);
    const rows = answerLog.forHand("4923409616") as any[];
    const gap = rows.find((r) => r.text == null);
    expect([gap?.fail_kind, gap?.street, JSON.parse(gap?.decision_key ?? "[]").at(-1)]).toEqual(["no-probe", "turn", 9]);
    // and never twice
    expect(reconcileAnswers(0).noProbe).toBe(0);
  });
});
