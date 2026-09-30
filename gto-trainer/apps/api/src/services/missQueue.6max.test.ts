import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissQueue } from "./missQueue";
import { chartFor6max } from "./hrc6max";

/** An isolated store per test — never the live data/miss-queue.sqlite.
 *  Left behind in tmp on purpose: Windows will not unlink a file SQLite still
 *  holds open, and MissQueue has no close(). The OS reclaims it. */
const fresh = () => new MissQueue(join(mkdtempSync(join(tmpdir(), "mq6-")), "mq.sqlite"));

const hand = (bb: number) => ({
  heroSeatId: 1, positions: { 1: "BTN", 2: "SB", 3: "BB", 4: "UTG" },
  stacks: { 1: 100, 2: 100, 3: bb, 4: 100 },
  committed: {}, actions: [], currentNode: { street: "preflop" }, bbCents: 200,
}) as never;

const ref = { origin: "live" as const, clientHandId: "t1", handId: 1, actionIndex: 1, ts: 1 };

describe("missQueue.observe6max", () => {
  it("turns the picker's prose into one solvable job per gap", () => {
    const q = fresh();
    // 2026-09-30: the 2x open and the 80bb rung are solved sets now; a 4x open at a 40bb-short table is the pair of
    // gaps that remains (40 sits between the 30 and 50 rungs, 4x between 3.5x and 5x)
    const tokens = ["R4"];
    const choice = chartFor6max(hand(40), "BTN", tokens);
    const kinds = q.observe6max({ choice, hand: hand(40), heroPos: "BTN", tokens, walk: null, ref });

    expect(kinds.sort()).toEqual(["open-not-in-set", "short-rung-snapped"]);
    const items = q.list("all");
    expect(items).toHaveLength(2);

    const open = items.find((i) => i.kind === "open-not-in-set")!;
    expect(open.want).toBe("4");
    expect(open.got).toBe("3.5");
    const j = open.job as { id: string; asym: string; cmd: string };
    expect(j.id).toBe("ign200_6max_D100_s30_BB_o4");
    expect(j.asym).toBe("deep=100;shorts=30;opens=4;seats=BB");
    expect(j.cmd).toContain("genSixMaxPlan.ts");
    expect(j.cmd).toContain('--asym "deep=100;shorts=30;opens=4;seats=BB"');

    // all six seats are recorded, not just BTN/SB/BB
    expect(open.state.stacksBB).toMatchObject({ UTG: 100, BTN: 100, SB: 100, BB: 40 });
  });

  it("writes nothing when the state lands on a tree we own", () => {
    const q = fresh();
    const tokens = ["R2.5"];
    const choice = chartFor6max(hand(70), "BTN", tokens);
    expect(q.observe6max({ choice, hand: hand(70), heroPos: "BTN", tokens, walk: null, ref })).toEqual([]);
    expect(q.list("all")).toHaveLength(0);
  });

  it("counts the same gap once per distinct decision, not once per tick", () => {
    const q = fresh();
    const tokens = ["R4"];
    const choice = chartFor6max(hand(40), "BTN", tokens);
    for (let i = 0; i < 4; i++) q.observe6max({ choice, hand: hand(40), heroPos: "BTN", tokens, walk: null, ref });
    expect(q.list("all")).toHaveLength(2);
    expect(q.list("all").every((i) => i.n === 1)).toBe(true);
  });
});
