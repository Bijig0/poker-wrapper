import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import { AnswerLog, CAPTURE_MAX_ACTIONS, CAPTURE_MAX_CHARS, captureJson } from "./answerLog";

// WHAT THE API SAW (2026-10-14, hand 4924546540): every answer row carries the live hand it was asked on (capture_json).
const logs: AnswerLog[] = [];
const dir = testTempDir("answers-test-", { release: () => logs.forEach((l) => l.close()) });
const openLog = (file: string, opts?: { view?: boolean }) => { const l = new AnswerLog(file, opts); logs.push(l); return l; };

const hand = {
  street: "preflop",
  lineSource: "ws", lineUncertain: null, lineNote: "folds filed late",
  actions: [
    { seatId: 5, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 6, hero: false, type: "post-bb", amount: 1, street: "preflop" },
    { seatId: 3, hero: false, type: "fold", street: "preflop" },
    { seatId: 4, hero: true, type: "raise", amount: 2.2, street: "preflop" },
  ],
  positions: { 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
  liveSeats: [3, 4, 5, 6],
  startStacks: { 3: 55.6, 4: 100, 5: 12.25, 6: 100 },
  node: { toCall: 1.2 },
};

const row = (cid: string, captureJson: string | null) => ({
  ts: Date.now(), wrapperHandId: 1, clientHandId: cid, street: "preflop", board: null, heroCards: "AhKd",
  decisionKey: `${cid}:preflop:4`, text: null, pick: null, roll: null, tier: null, warning: null,
  latencyMs: 900, failReason: "no solution for this spot", captureJson,
});

describe("captureJson", () => {
  it("records the line's provenance, every action as seatId:type[:amount], seats, stacks and toCall", () => {
    const c = JSON.parse(captureJson(hand)!);
    expect(c).toEqual({
      lineSource: "ws", lineUncertain: null, lineNote: "folds filed late", street: "preflop",
      actions: ["5:post-sb:0.4", "6:post-bb:1", "3:fold", "4:raise:2.2"],
      positions: { 3: "CO", 4: "BTN", 5: "SB", 6: "BB" }, liveSeats: [3, 4, 5, 6],
      startStacks: { 3: 55.6, 4: 100, 5: 12.25, 6: 100 }, toCall: 1.2, actionCount: 4,
    });
  });

  it("no hand → null; a hand without the optional fields still captures", () => {
    expect(captureJson(null)).toBeNull();
    expect(captureJson(undefined)).toBeNull();
    const c = JSON.parse(captureJson({ street: "flop" })!);
    expect(c).toEqual({ lineSource: null, lineUncertain: null, lineNote: null, street: "flop", actions: [], positions: {}, liveSeats: [], toCall: null, actionCount: 0 });
  });

  it("is bounded: at most CAPTURE_MAX_ACTIONS actions and CAPTURE_MAX_CHARS characters, with a marker", () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ seatId: (i % 6) + 1, type: "call", amount: i + 0.5 }));
    const c = JSON.parse(captureJson({ ...hand, actions: many })!);
    expect(c.actions).toHaveLength(CAPTURE_MAX_ACTIONS);
    expect(c.actionCount).toBe(90);
    expect(c.truncated).toContain(`first ${CAPTURE_MAX_ACTIONS} of 90`);

    const huge = captureJson({ ...hand, actions: many, lineNote: "x".repeat(10_000), lineUncertain: "y".repeat(10_000) })!;
    expect(huge.length).toBeLessThanOrEqual(CAPTURE_MAX_CHARS);
    const h = JSON.parse(huge);
    expect(h.lineSource).toBe("ws");
    expect(h.actionCount).toBe(90);
    expect(String(h.truncated)).toStartWith("size:");
  });
});

describe("answers.capture_json", () => {
  it("the migration adds the column to a DB written before it, and a row with a capture reads back", () => {
    const file = join(dir, "capture-migrate.sqlite");
    const first = openLog(file);
    first.add(row("4924546539", null));
    first.close();
    // the table as it stood before 2026-10-14: no capture_json column
    const raw = new Database(file);
    raw.run("ALTER TABLE answers DROP COLUMN capture_json");
    const colsBefore = raw.query<{ name: string }, []>("PRAGMA table_info(answers)").all().map((c) => c.name);
    raw.close();
    expect(colsBefore).not.toContain("capture_json");

    const log = openLog(file);
    log.add(row("4924546540", captureJson(hand)));
    const cols = new Database(file);
    expect(cols.query<{ name: string }, []>("PRAGMA table_info(answers)").all().map((c) => c.name)).toContain("capture_json");
    cols.close();
    const [got] = log.forHand("4924546540") as { capture_json: string | null; fail_reason: string | null }[];
    expect(got!.fail_reason).toBe("no solution for this spot");
    expect(JSON.parse(got!.capture_json!).actions).toEqual(["5:post-sb:0.4", "6:post-bb:1", "3:fold", "4:raise:2.2"]);
    // the row written before the column existed reads null
    expect((log.forHand("4924546539") as { capture_json: string | null }[])[0]!.capture_json).toBeNull();
  });

  it("the in-memory view leaves it out (read per hand); forHand / forSession still carry it", async () => {
    const file = join(dir, "capture-view.sqlite");
    const log = openLog(file, { view: true });
    log.viewSeedMode = "loop";
    log.add({ ...row("4924546541", captureJson(hand)), sessionId: "session_20261014_131738" });
    expect(await log.viewReady()).toBe(true);
    const viewRow = log.rows(1).find((r) => r.client_hand_id === "4924546541")!;
    expect(viewRow).toBeDefined();
    expect(viewRow.capture_json).toBeUndefined();
    expect(JSON.parse(log.forSession("session_20261014_131738")[0]!.capture_json!).lineSource).toBe("ws");
  });
});
