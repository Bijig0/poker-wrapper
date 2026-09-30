/**
 * WHERE THE LAST ANSWER'S RANGES ARE (2026-09-30): /panel/answer carries the decision's stored solve and the client's
 * hand id; /state exposes them as `panelAnswerRef` beside the answer — a top-level key, only when there is one, and NOT
 * under the answer's 3 s freshness gate (the side panel keeps a decision's grids until the next hand).
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime } from "../../src/clock";
import { answerRef, currentAnswer } from "../../src/relay";
import { S, resetState } from "../../src/state";
import { state } from "../../src/view";
import { scratchDirs } from "./helpers";

test("panelAnswerRef: the decision key, solve id and client hand id — kept past the answer's freshness", async () => {
  resetState();
  scratchDirs("answer-ref-");
  setFakeTime(1_790_750_000);
  try {
    S.study.on = true;
    S.site.id = "coinpoker";
    let s = await state(true);
    expect("panelAnswerRef" in s).toBe(false);                      // nothing pushed yet: the key is absent, not null
    Object.assign(S.study, { text: "≈ FLOP — CHECK 100%", pick: "CHECK", roll: null, note: null, at: 1_790_750_000,
                             decisionKey: '["flop","Qs8s4d",["Ah","Qh"],0,3]', solveId: 812, clientHandId: "4921602320" });
    s = await state(true);
    expect(s.panelAnswer?.pick).toBe("CHECK");
    expect(s.panelAnswerRef).toEqual({ decisionKey: '["flop","Qs8s4d",["Ah","Qh"],0,3]', solveId: 812, clientHandId: "4921602320", at: 1_790_750_000_000 });
    expect("solveId" in (s.panelAnswer ?? {})).toBe(false);         // the recorded panelAnswer shape is untouched
    setFakeTime(1_790_750_010);                                      // 10 s on: the answer has gone stale, the ref has not
    expect(currentAnswer()).toBeNull();
    expect(answerRef()?.decisionKey).toBe('["flop","Qs8s4d",["Ah","Qh"],0,3]');
    S.study.on = false;
    expect(answerRef()).toBeNull();
  } finally {
    realTime();
    resetState();
  }
});
