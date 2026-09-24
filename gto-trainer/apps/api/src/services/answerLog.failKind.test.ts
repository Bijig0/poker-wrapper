import { describe, expect, it } from "bun:test";

// the singleton opens its SQLite file on construction — keep the test off the production answers.sqlite
process.env.ANSWERS_DB_PATH = ":memory:";
const { failKindOf } = await import("./answerLog");

describe("failKindOf", () => {
  it("a chart node met as terminal while the line goes on is a tree gap, even with the multiway tail the 6-max refusal appends", () => {
    expect(failKindOf(`6-max strategy postflop: 6-max chart ign200_6max_D100_s30_SB_o2_5: preflop node "F-F-F-R2.5-C" is terminal before the line ends; BTN's range on the fitted line: 1 players reach the flop — need 2 to 6`)).toBe("tree-gap");
  });
  it("too many players at the flop stays multiway-unsupported", () => {
    expect(failKindOf("AI chain: 4 players reach the flop — need 2 to 3")).toBe("multiway-unsupported");
  });
  it("a pinned range without hero's hand is not-in-range", () => {
    expect(failKindOf(`PREFLOP PIN (gtow-ai-preflop gtow-ai · 4-handed): hero's KQo is not in range after the line "R2.5-C-C-R15-C-F-F"`)).toBe("not-in-range");
  });
});
