import { expect, test } from "bun:test";
import { StepRun, runWithSteps, sourceName, stepsLive, tstep, tstepDetail, tstepEnd, withLane } from "./liveSteps";

const sent: any[] = [];
const run = () => new StepRun("http://127.0.0.1:1", '["preflop",[],["As","Kd"],0,3]', 7, (_url, body) => sent.push(JSON.parse(JSON.stringify(body))));

test("outside a live solve every call is a no-op", () => {
  expect(stepsLive()).toBe(false);
  tstep("Reading the HRC chart");
  tstepEnd("done");
  tstepDetail("x");
});

test("sequential stages close each other; lanes do not; finish closes all and sends at once", async () => {
  sent.length = 0;
  const r = run();
  await runWithSteps(r, async () => {
    tstep("Reading the HRC chart");
    tstepEnd("failed", "HRC chart doesn't cover this spot — line not held");
    tstep("Chart doesn't cover this spot → asking GTO Wizard AI (preflop)");
    await withLane("pool lock", async () => {
      tstep("Locking the limper to the pool's range", { limitMs: 40000 });
      tstepDetail("Ultra 2");
    });
    tstep("GTO Wizard solving the preflop tree…", { usualMs: 4700, slowMs: 8100 });
    tstepDetail("new tree");
    tstepDetail("new tree");
  });
  const s = r.steps;
  expect(s.map((x) => [x.text, x.status, x.lane ?? null])).toEqual([
    ["HRC chart doesn't cover this spot — line not held", "failed", null],
    ["Chart doesn't cover this spot → asking GTO Wizard AI (preflop)", "done", null],
    ["Locking the limper to the pool's range", "active", "pool lock"],
    ["GTO Wizard solving the preflop tree…", "active", null],
  ]);
  expect(s[2]!.detail).toEqual(["Ultra 2"]);
  expect(s[3]!.detail).toEqual(["new tree"]);
  r.finish({ ok: true, text: "Answered: GTO Wizard AI (preflop) · 6.1 s" });
  expect(r.steps.every((x) => x.status !== "active")).toBe(true);
  const last = sent[sent.length - 1];
  expect(last.handId).toBe(7);
  expect(last.steps[last.steps.length - 1].text).toBe("Answered: GTO Wizard AI (preflop) · 6.1 s");
  r.finish({ ok: false, text: "ignored" });   // a finished run stays finished
  expect(r.steps[r.steps.length - 1]!.text).toBe("Answered: GTO Wizard AI (preflop) · 6.1 s");
});

test("pushes are debounced while the solve runs", async () => {
  sent.length = 0;
  const r = run();
  await runWithSteps(r, async () => {
    tstep("a"); tstep("b"); tstep("c");
  });
  expect(sent.length).toBe(0);
  await new Promise((res) => setTimeout(res, 250));
  expect(sent.length).toBe(1);
  expect(sent[0].steps.map((x: any) => x.text)).toEqual(["a", "b", "c"]);
});

test("source names", () => {
  expect(sourceName("hrc-6max-preflop")).toBe("HRC chart");
  expect(sourceName("gtow-ai-preflop", "preflop:pool-limp-lock")).toBe("GTO Wizard AI (preflop), limper locked to the pool");
  expect(sourceName("gtow-ai-preflop", "preflop:pool-coldcall-lock")).toBe("GTO Wizard AI (preflop), cold-caller locked to the pool");
  expect(sourceName(null)).toBe("the solver");
});
