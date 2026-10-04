import { afterEach, describe, expect, it } from "bun:test";
import { lastResortSeams, solvePreflopLastResort, type AiPreflopOutcome } from "./gtowAiPreflop";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

/**
 * THE PREFLOP LAST RESORT HAS NO DEAD MONEY (2026-10-04 — gtowAiPreflop.solvePreflopLastResort's header): the
 * heads-up tree of hero and the last aggressor is asked for with `pot` 0, the note names the chips left out, and with
 * nobody having raised only a hero in the blinds is answered. The solve itself is stubbed (lastResortSeams.headsUp);
 * the measurements are scripts/lastResortStudy.ts.
 */

const POS = { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as const;
const SEAT = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 } as const;
type P = keyof typeof SEAT;
const hand = (heroPos: P, cards: [string, string], acts: [P, string, number?][]): ParsedHand => {
  const hero = SEAT[heroPos];
  const a = (pos: P, type: string, amount?: number) => ({ seatId: SEAT[pos], hero: SEAT[pos] === hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  return {
    handId: 1, clientHandId: "lr-test", bbCents: 200, heroSeatId: hero, heroCards: cards, board: [], street: "preflop",
    actions: [a("SB", "post-sb", 0.5), a("BB", "post-bb", 1), ...acts.map(([p, t, x]) => a(p, t, x))],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { ...POS },
    stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 },
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};

const seams0 = { ...lastResortSeams };
afterEach(() => { Object.assign(lastResortSeams, seams0); });
function rig() {
  const asked: { hand: ParsedHand; pos: string | null; opts: any }[] = [];
  lastResortSeams.headsUp = async (h, pos, _why, opts) => {
    asked.push({ hand: h, pos, opts });
    return { ok: true, actions: [{ action: "Fold", frequency: 100 }], decision: null, line: "R2.6-R8.2", pos, heroClass: "K5o", treeKey: "k", solId: "sol-hu",
      usedLine: "R2.6-R8.2", solveSecs: 1, cached: false, shape: { n: 2, positions: ["SB", "BB"], stacks: { SB: 100, BB: 100 }, deadBb: 0 } as any, note: "the heads-up tree's own note." } as AiPreflopOutcome;
  };
  return asked;
}

describe("the preflop last resort: heads-up, no dead money", () => {
  it("hand 4920545432: the 3-bettor's two cold-callers and the blinds are folded out and NONE of their 17.9bb is in the tree", async () => {
    const asked = rig();
    const h = hand("UTG", ["Kh", "5c"], [["UTG", "raise", 2.6], ["HJ", "raise", 8.2], ["CO", "call", 8.2], ["BTN", "call", 8.2], ["SB", "fold"], ["BB", "fold"]]);
    const r = await solvePreflopLastResort(h, "UTG", "the charts could not");
    if (!r.ok) throw new Error(r.reason);
    expect(asked.length).toBe(1);
    expect(asked[0]!.opts.deadBb).toBe(0);                     // was 17.9: in `pot` before the first action — an ante
    expect(asked[0]!.opts.rakeSeats).toBe(6);                  // the rake cap still follows the table
    expect(asked[0]!.opts.reduced).toEqual({ droppedPos: ["CO", "BTN", "SB", "BB"] });
    expect(asked[0]!.pos).toBe("SB");                          // hero acts first of the two: the heads-up tree's SB
    expect(r.pos).toBe("UTG");                                 // …and the answer speaks in the table's seats
    expect(r.note).toContain("LAST RESORT — no tree holds this line, so it is played as hero (UTG) against the last aggressor (HJ) alone on a heads-up tree");
    expect(r.note).toContain("CO, BTN, SB, BB folded out and NONE of the 17.9bb they put in is in the tree's pot");
    expect(r.note).toContain("both seats play a heads-up blind's range");
    expect(r.note).toContain("the heads-up tree's own note.");
    expect(r.lastResort!.how).toBe("hero (UTG) vs HJ heads-up, CO/BTN/SB/BB folded out, no dead money");
  });

  it("nobody has raised: no answer from a seat outside the blinds — the heads-up tree would open a small blind's range there (74s under the gun, hand 4920544810)", async () => {
    const asked = rig();
    const first = await solvePreflopLastResort(hand("UTG", ["7d", "4d"], []), "UTG", "why");
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toContain("nobody has raised and hero (UTG) is not in the blinds");
    const overLimp = await solvePreflopLastResort(hand("BTN", ["7d", "4d"], [["UTG", "call", 1], ["HJ", "fold"], ["CO", "call", 1]]), "BTN", "why");
    expect(overLimp.ok).toBe(false);
    expect(asked.length).toBe(0);                              // nothing was solved for a spot that is refused
  });

  it("nobody has raised and hero is in the blinds: the heads-up tree still answers (the big blind behind limpers, the small blind completing)", async () => {
    const asked = rig();
    const bb = await solvePreflopLastResort(hand("BB", ["7d", "4d"], [["UTG", "call", 1], ["HJ", "fold"], ["CO", "call", 1], ["BTN", "call", 1], ["SB", "fold"]]), "BB", "why");
    expect(bb.ok).toBe(true);
    const sb = await solvePreflopLastResort(hand("SB", ["7d", "4d"], [["UTG", "call", 1], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"]]), "SB", "why");
    expect(sb.ok).toBe(true);
    expect(asked.map((x) => x.opts.deadBb)).toEqual([0, 0]);
  });

  it("an all-in over the top is a raise: hero outside the blinds is answered", async () => {
    const asked = rig();
    const r = await solvePreflopLastResort(hand("BTN", ["Ah", "Qh"], [["UTG", "call", 1], ["HJ", "fold"], ["CO", "all-in", 28]]), "BTN", "why");
    expect(r.ok).toBe(true);
    expect(asked.length).toBe(1);
  });

  it("the heads-up tree's own refusal is passed on with its kind", async () => {
    lastResortSeams.headsUp = async () => ({ ok: false, kind: "capture-fault", reason: "not a legal line" });
    const r = await solvePreflopLastResort(hand("BB", ["Ah", "Qh"], [["UTG", "raise", 3], ["HJ", "fold"], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]]), "BB", "why");
    expect(r).toMatchObject({ ok: false, kind: "capture-fault" });
    if (!r.ok) expect(r.reason).toContain("last resort (hero vs UTG, HJ/CO/BTN/SB folded out): not a legal line");
  });
});
