import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { preflopVoluntary, SeatStats, seatStats, seatStatsJson } from "./seatStats";
import { AnswerLog } from "./answerLog";
import { NOT_DEPARTURES } from "./approximations";
import { testTempDir } from "../test/tempDir";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * PER-SEAT SESSION VPIP / PFR (services/seatStats, 2026-10-09): counted in memory from the hands the API sees live,
 * logged on every answer row (answers.seat_stats), never read to answer.
 */
const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as Record<number, string>;
const pre = (seatId: number, type: string, amount?: number) => ({ seatId, hero: seatId === 6, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const BLINDS = [pre(5, "post-sb", 0.5), pre(6, "post-bb", 1)];
let id = 0;
const hand = (actions: any[], o: { start?: Record<number, number>; end?: Record<number, number>; ended?: boolean; street?: string; key?: string } = {}): ParsedHand => ({
  handId: ++id, clientHandId: o.key ?? `h${id}`, tableSlot: 1, heroSeatId: 6, heroCards: ["Ah", "Kd"], board: [], street: o.street ?? "preflop",
  actions, liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: POS,
  startStacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, ...(o.start ?? {}) },
  stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, ...(o.end ?? {}) },
  ended: o.ended ?? true, currentNode: {} as any,
} as unknown as ParsedHand);
afterEach(() => seatStats.reset());

describe("preflopVoluntary", () => {
  test("a call and a raise are VPIP, only the raise PFR; posts and the BB's check of a limped pot are not", () => {
    const v = preflopVoluntary(hand([...BLINDS, pre(1, "call", 1), pre(2, "fold"), pre(3, "raise", 4), pre(4, "fold"), pre(5, "fold"), pre(6, "call", 4), pre(1, "call", 4)]));
    expect([...v.vpip].sort()).toEqual([1, 3, 6]);
    expect([...v.pfr]).toEqual([3]);
    const limped = preflopVoluntary(hand([...BLINDS, pre(1, "call", 1), pre(2, "fold"), pre(3, "fold"), pre(4, "fold"), pre(5, "call", 0.5), pre(6, "call", 1)]));
    expect([...limped.vpip].sort()).toEqual([1, 5]);
  });
});

describe("SeatStats", () => {
  test("three completed hands at a table: the current hand's villains carry the tally of the hands BEFORE it", () => {
    const s = new SeatStats();
    // hand 1: CO calls UTG's open; hand 2: CO raises; hand 3: CO folds — each probed twice (mid-hand, then ended)
    const h1 = [...BLINDS, pre(1, "raise", 2.5), pre(2, "fold"), pre(3, "call", 2.5), pre(4, "fold"), pre(5, "fold"), pre(6, "fold")];
    s.observe("S", { ...hand(h1.slice(0, 3), { key: "a", ended: false }) });
    s.observe("S", hand(h1, { key: "a" }));
    s.observe("S", hand([...BLINDS, pre(1, "fold"), pre(2, "fold"), pre(3, "raise", 2.5), pre(4, "fold"), pre(5, "fold"), pre(6, "fold")], { key: "b" }));
    s.observe("S", hand([...BLINDS, pre(1, "fold"), pre(2, "fold"), pre(3, "fold"), pre(4, "raise", 2.5), pre(5, "fold"), pre(6, "fold")], { key: "c" }));
    s.observe("S", hand(BLINDS, { key: "d", ended: false }));
    const rows = s.snapshot({ sessionId: "S", tableSlot: 1, clientHandId: "d" });
    expect(rows.map((r) => r.seatId)).toEqual([1, 2, 3, 4, 5]);           // hero (6) never listed
    const co = rows.find((r) => r.seatId === 3)!;
    expect([co.pos, co.hands, co.vpip, co.pfr, co.vpipPct, co.pfrPct, co.continuity]).toEqual(["CO", 3, 2, 1, 66.7, 33.3, "stack"]);
    const utg = rows.find((r) => r.seatId === 1)!;
    expect([utg.hands, utg.vpip, utg.pfr]).toEqual([3, 1, 1]);
  });

  test("THE OCCUPANT: a stack below the previous hand's end by more than a blind starts the tally again (breaks +1); a larger one keeps it, marked grew", () => {
    const s = new SeatStats();
    const call = [...BLINDS, pre(1, "raise", 2.5), pre(2, "call", 2.5), pre(3, "fold"), pre(4, "fold"), pre(5, "fold"), pre(6, "fold")];
    s.observe("S", hand(call, { key: "a", end: { 2: 97.5, 4: 100 } }));
    s.observe("S", hand(call, { key: "b", start: { 2: 97.5, 4: 140 }, end: { 2: 95, 4: 140 } }));   // HJ same player; BTN grew
    s.observe("S", hand(BLINDS, { key: "c", start: { 2: 40, 4: 140 }, ended: false }));             // HJ: 95 → 40, a new player
    const rows = s.snapshot({ sessionId: "S", tableSlot: 1, clientHandId: "c" });
    const hj = rows.find((r) => r.seatId === 2)!, btn = rows.find((r) => r.seatId === 4)!;
    expect([hj.hands, hj.vpip, hj.continuity, hj.breaks]).toEqual([0, 0, "new", 1]);
    expect([btn.hands, btn.continuity]).toEqual([2, "stack"]);
    // once hand c is counted, the BTN's tally went on through b's grown stack
  });

  test("a seat not dealt in the previous hand starts again; a hand whose last snapshot stopped inside the preflop is partial, not counted", () => {
    const s = new SeatStats();
    s.observe("S", hand([...BLINDS, pre(1, "call", 1)], { key: "a", ended: false }));              // never seen past preflop
    s.observe("S", hand([...BLINDS, pre(1, "call", 1), pre(2, "fold"), pre(3, "fold"), pre(4, "fold"), pre(5, "fold"), pre(6, "check")], { key: "b", street: "flop", ended: false }));
    s.observe("S", { ...hand(BLINDS, { key: "c", ended: false }), liveSeats: [2, 3, 4, 5, 6], positions: { 2: "UTG", 3: "HJ", 4: "CO", 5: "SB", 6: "BB" } } as ParsedHand);
    s.observe("S", hand(BLINDS, { key: "d", ended: false }));
    const utg = s.snapshot({ sessionId: "S", tableSlot: 1, clientHandId: "d" }).find((r) => r.seatId === 1)!;
    expect([utg.hands, utg.continuity]).toEqual([0, "new"]);                 // seat 1 sat out hand c: tally restarted
    const s2 = new SeatStats();
    s2.observe("S", hand([...BLINDS, pre(1, "call", 1)], { key: "a", ended: false }));
    s2.observe("S", hand(BLINDS, { key: "b", ended: false }));
    const u = s2.snapshot({ sessionId: "S", tableSlot: 1, clientHandId: "b" }).find((r) => r.seatId === 1)!;
    expect([u.hands, u.partial, u.vpipPct]).toEqual([0, 1, null]);
  });

  test("tables and sessions are kept apart; an unknown table is []", () => {
    const s = new SeatStats();
    s.observe("S", hand(BLINDS, { key: "a" }));
    expect(s.snapshot({ sessionId: "T", tableSlot: 1 })).toEqual([]);
    expect(s.snapshot({ sessionId: "S", tableSlot: 2 })).toEqual([]);
  });
});

describe("the answer row carries it (answers.seat_stats); registered as NOT a departure", () => {
  const logs: AnswerLog[] = [];
  const dir = testTempDir("answers-test-", { release: () => logs.forEach((l) => l.close()) });
  test("seatStatsJson → the column", () => {
    seatStats.observe("S1", hand([...BLINDS, pre(1, "raise", 2.5), pre(2, "fold"), pre(3, "fold"), pre(4, "fold"), pre(5, "fold"), pre(6, "fold")], { key: "x1" }));
    seatStats.observe("S1", hand(BLINDS, { key: "x2", ended: false }));
    const json = seatStatsJson("S1", { clientHandId: "x2", tableSlot: 1 });
    expect(JSON.parse(json!).find((r: any) => r.seatId === 1)).toMatchObject({ hands: 1, vpip: 1, pfr: 1, pos: "UTG" });
    expect(seatStatsJson("nope", { clientHandId: "x2", tableSlot: 1 })).toBeNull();
    const file = join(dir, "a.sqlite");
    const log = new AnswerLog(file);
    logs.push(log);
    log.add({ ts: Date.now(), wrapperHandId: 1, clientHandId: "x2", street: "preflop", board: null, heroCards: "AhKd", decisionKey: "k", text: "Fold 100%",
      pick: "Fold", roll: null, tier: "chart", warning: null, latencyMs: 1, failReason: null, seatStats: json });
    log.close();
    const db = new Database(file, { readonly: true });
    expect(db.query<{ s: string }, []>("SELECT seat_stats s FROM answers").get()!.s).toBe(json!);
    db.close();
    expect(NOT_DEPARTURES.logging["answers.seat_stats"]).toContain("not read");
  });
});
