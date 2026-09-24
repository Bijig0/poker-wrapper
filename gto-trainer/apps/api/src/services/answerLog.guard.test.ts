import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerLog, answerLog } from "./answerLog";

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
    const tmp = join(mkdtempSync(join(tmpdir(), "answers-test-")), "answers.sqlite");
    const log = new AnswerLog(tmp);
    log.add({
      ts: Date.now(), wrapperHandId: null, clientHandId: null, street: "flop", board: null, heroCards: null,
      decisionKey: null, text: "FLOP — Check 100%", pick: "Check", roll: 1, tier: null, warning: null,
      latencyMs: 0, failReason: null,
    });
    expect(log.rows(1)).toHaveLength(1);
  });
});
