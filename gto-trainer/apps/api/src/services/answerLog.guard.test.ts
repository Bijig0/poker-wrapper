import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import { AnswerLog, answerLog } from "./answerLog";

// removed in afterAll (src/test/tempDir.ts); the log is closed first so Windows lets the sqlite + WAL go
let tmpLog: AnswerLog | null = null;
const dir = testTempDir("answers-test-", { release: () => tmpLog?.close() });

// Every full `bun test` used to write the studyPoller fixtures into the live data/answers.sqlite (213 rows of
// "FLOP — Check 76% · Bet 1.8 (33%) 7%" alone by 2026-09-24): the singleton was built before the one file that
// set ANSWERS_DB_PATH ran. These pin the preload and the refusal that replaced that convention.
describe("answerLog under bun test", () => {
  it("the process-wide log is off the live file (bunfig preload)", () => {
    expect(answerLog.dbPath).not.toMatch(/[\\/]data[\\/]answers\.sqlite$/);
  });

  it("refuses this checkout's live answers.sqlite", () => {
    expect(() => new AnswerLog(join(import.meta.dir, "..", "..", "data", "answers.sqlite"))).toThrow(/refusing to open/);
  });

  it("refuses another checkout's live file too", () => {
    expect(() => new AnswerLog("C:/Users/Brady/poker/gto-trainer/apps/api/data/answers.sqlite")).toThrow(/refusing to open/);
  });

  it("accepts memory and temp files", () => {
    expect(() => new AnswerLog(":memory:")).not.toThrow();
    const log = new AnswerLog(join(dir, "answers.sqlite"));
    tmpLog = log;
    log.add({
      ts: Date.now(), wrapperHandId: null, clientHandId: null, street: "flop", board: null, heroCards: null,
      decisionKey: null, text: "FLOP — Check 100%", pick: "Check", roll: 1, tier: null, warning: null,
      latencyMs: 0, failReason: null,
    });
    expect(log.rows(1)).toHaveLength(1);
  });
});
