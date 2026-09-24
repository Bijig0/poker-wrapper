/**
 * Fold on no-answer (session setup `autoFoldNoAnswer`): with auto-execute armed, a decision with no answer is
 * checked if free, else folded — on the poller's refusal note, at the time-bank mark when the bank is left, or
 * at the deadline. TEMPORARILY acts on real-money tables too (practice-only guard removed for dev); never over
 * an answer.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime, time } from "../../src/clock";
import { S, resetState, seams } from "../../src/state";
import { NO_ANSWER_DEADLINE_S, maybeFoldNoAnswer, setAuto } from "../../src/relay";
import { pyJsonDumps } from "../../src/py";
import { checker, J, scratchDirs } from "./helpers";

const T0 = 1_790_000_000;
const KEY = pyJsonDumps(["preflop", [], ["As", "Kd"], 0, 3]);

/** Hero (seat 1) to act preflop after SB/BB posts and an SB complete — the pick-relay test's table. */
function seed(o: { practice?: boolean; answer?: boolean; note?: string | null; fold?: boolean } = {}) {
  const { practice = true, answer = false, note = null, fold = true } = o;
  S.fakeMode = false;
  S.handNo = 7;
  S.handIds.set(7, "4917000001");
  S.feedPrev = { seated: true, seats: new Map([[1, { stack: "100 BB" }], [2, { stack: "100 BB" }], [3, { stack: "100 BB" }]]) };
  Object.assign(S.liveStatus, { toAct: true, practice, board: [], modal: null, buyPanel: null, timeBank: null });
  Object.assign(S.ws, {
    bb: 200, bbSeen: true, dealt: [1, 2, 3], heroSeat: 1, dealer: 1, board: [], heroCards: ["A♠", "K♦"], potCents: 300, maxBet: 200,
    committed: new Map([[2, 100], [3, 200]]),
    actions: [{ seat: 2, type: "post-sb", cents: 100, street: "preflop" }, { seat: 3, type: "post-bb", cents: 200, street: "preflop" },
              { seat: 2, type: "call", cents: 100, street: "preflop" }],
    actionOn: 1, heroFolded: false, foldedSeats: new Set(), domGraceUntil: 0,
  });
  Object.assign(S.study, {
    on: true, text: answer ? "PREFLOP — Raise 2.5 100%" : null, pick: answer ? "Raise 2.5" : null, roll: null, note,
    at: time(), decisionKey: answer ? KEY : null, handId: answer ? 7 : null, executed: null,
    auto: true, foldNoAnswer: fold, timeBank: true, noAnswerTurn: null, lastNoAnswerFold: null,
  });
  if (!fold) S.study.foldNoAnswer = false;
}

test("fold on no-answer: when it acts, what it presses, where it never acts", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  const log0 = console.log;
  console.log = () => {};
  const act0 = seams.act;
  let offer = ["check", "raise"];
  const calls: string[] = [];
  seams.act = async (label: string) => {
    calls.push(label);
    return offer.includes(label) ? { ok: true, clicked: label.toUpperCase() } : { ok: false, reason: `'${label}' not on offer (action)` };
  };
  // one tick at `t` seconds into hero's turn (the turn starts on the first tick that sees it)
  const tickAt = async (t: number) => {
    setFakeTime(T0 + t);
    S.study.at = time(); // the poller keeps pushing (the answer / note stays fresh)
    await maybeFoldNoAnswer();
  };
  try {
    setFakeTime(T0);
    seed({ fold: false });
    await tickAt(0); await tickAt(NO_ANSWER_DEADLINE_S + 1);
    check("setting off → never acts", calls.length === 0, J(calls));

    seed({ answer: true });
    await tickAt(0); await tickAt(NO_ANSWER_DEADLINE_S + 1);
    check("an answer for this decision is auto-execute's → never acts", calls.length === 0, J(calls));

    seed();
    await tickAt(0); await tickAt(NO_ANSWER_DEADLINE_S - 1);
    check("no answer yet, inside the deadline → waits", calls.length === 0, J(calls));
    await tickAt(NO_ANSWER_DEADLINE_S + 0.5);
    check("deadline passed, check free → CHECK", J(calls) === J(["check"]), J(calls));
    check("recorded with its reason", S.study.lastNoAnswerFold?.did === "check" && String(S.study.lastNoAnswerFold?.why).includes("no answer after"),
          J(S.study.lastNoAnswerFold));

    calls.length = 0;
    offer = ["fold", "call", "raise"];
    seed();
    await tickAt(0); await tickAt(NO_ANSWER_DEADLINE_S + 0.5);
    check("facing a bet → check refused, FOLD", J(calls) === J(["check", "fold"]), J(calls));
    await tickAt(NO_ANSWER_DEADLINE_S + 1);
    check("not pressed again within the retry gap", calls.length === 2, J(calls));
    await tickAt(NO_ANSWER_DEADLINE_S + 4);
    check("still on the clock after the gap → one retry", calls.length === 4, J(calls));
    await tickAt(NO_ANSWER_DEADLINE_S + 10);
    check("no third try", calls.length === 4, J(calls));

    calls.length = 0;
    seed({ note: "no answer for this spot after 3 tries — capture fault" });
    await tickAt(0);
    check("a refusal note in the turn's first tick is not trusted yet", calls.length === 0, J(calls));
    await tickAt(2);
    check("refusal note → folds without waiting for the deadline", J(calls) === J(["check", "fold"]), J(calls));
    check("the note is the reason", String(S.study.lastNoAnswerFold?.why).includes("capture fault"), J(S.study.lastNoAnswerFold));

    calls.length = 0;
    seed();
    S.study.timeBank = false;
    await tickAt(0);
    S.liveStatus.timeBank = { text: "+45s" };
    await tickAt(6);
    check("time bank on offer and set to leave it → acts at the mark", J(calls) === J(["check", "fold"]), J(calls));

    calls.length = 0;
    offer = ["fold", "call", "raise"];
    seed({ practice: false });
    const armed = setAuto(true, { allowReal: true, minutes: 60, hands: 100, reason: "test" });
    S.study.foldNoAnswer = true;
    await tickAt(0);
    S.study.note = "no answer for this spot after 3 tries — x";
    await tickAt(2);
    check("real-money table, guard removed → acts same as practice", armed.ok && J(calls) === J(["check", "fold"]), J({ armed, calls }));

    calls.length = 0;
    seed();
    S.liveStatus.modal = { text: "notice" };
    await tickAt(0); await tickAt(NO_ANSWER_DEADLINE_S + 1);
    check("a client notice over the strip → holds", calls.length === 0, J(calls));
  } finally {
    seams.act = act0;
    console.log = log0;
    realTime();
  }
  expect(fails).toEqual([]);
});
