/**
 * A RECORD THAT ENDED UNSEEN IS CHECKED AS FAR AS IT GOES (2026-10-14; hhCheck.ts compareRecord, ignitionHh.ts
 * cutIgnitionToSeen). Hand 4920544353's faithful archive, cut after hero's flop call and stamped `endedUnseen` the
 * way the wrapper stamps a record its socket closed on: Ignition's history has the turn, the river, hero's later
 * actions and the end stacks; ours does not — a missing end, not a misread.
 */
import { describe, expect, test } from "bun:test";
import type { Enriched } from "../routes/dashboard";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { faithful4920544353, record4920544353 } from "../utils/ignitionHh/fixtures";
import { compareRecord } from "./hhCheck";

const T0 = 1_790_000_000_000;
const CUT = 11;   // actions 0-10: the blinds, the preflop, hero's flop call
const unseen = { why: "the table's socket closed with the hand in play — its end never reached the wrapper", street: "flop", actions: CUT };
const seen: ParsedHand = { ...faithful4920544353, actions: faithful4920544353.actions.slice(0, CUT), board: faithful4920544353.board.slice(0, 3), street: "flop" };
const enriched = (hand: ParsedHand, raw: Record<string, unknown> = {}): Enriched =>
  ({ dbId: 7, clientHandId: hand.clientHandId!, playedAt: T0, hand, raw } as Partial<Enriched> as Enriched);

describe("compareRecord on a record that ended unseen", () => {
  test("the same cut record is a mismatch without the stamp — Ignition's later actions read as missing from ours", () => {
    const c = compareRecord(record4920544353, enriched(seen));
    expect(c.unseen).toBeUndefined();
    expect(c.diffs.some((d) => d.kind === "action-missing")).toBe(true);
    expect(c.diffs.some((d) => d.kind === "board")).toBe(true);
    expect(c.through.length).toBeGreaterThan(0);   // hero's later action is in the "through hero" window
  });
  test("with the stamp it matches as far as it goes: Ignition's record cut to the actions and board ours saw, end stacks not compared", () => {
    const c = compareRecord(record4920544353, enriched(seen, { endedUnseen: unseen }));
    expect(c.unseen).toEqual(unseen);
    expect(c.diffs).toEqual([]);
    expect(c.through).toEqual([]);
    expect(c.ignition.actions.length).toBeGreaterThan(CUT);   // the record handed back is still Ignition's whole hand (the page's log)
  });
  test("what WAS seen is held to the same standard: a wrong amount inside it is still a mismatch", () => {
    const wrong = { ...seen, actions: seen.actions.map((a, i) => (i === 4 ? { ...a, amount: 3.6 } : a)) };
    const c = compareRecord(record4920544353, enriched(wrong, { endedUnseen: unseen }));
    expect(c.diffs.map((d) => d.kind)).toEqual(["action-amount"]);
  });
  test("a stamped record with no actions keeps nothing of Ignition's line", () => {
    const empty: ParsedHand = { ...seen, actions: [], board: [], street: "preflop" };
    const c = compareRecord(record4920544353, enriched(empty, { endedUnseen: { ...unseen, street: "preflop", actions: 0 } }));
    expect(c.diffs.filter((d) => d.kind.startsWith("action")).length).toBe(0);
  });
});
