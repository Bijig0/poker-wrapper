import { describe, expect, it } from "bun:test";
import { autoExecOf, fromFeedLines } from "./autoExec";

// hand 4920637334 (9♥K♠ CO vs BB, 7♣9♦7♥ J♠ A♥; NL5 session_20260926_030543 table 1) — its feed as archived: the open
// went through auto-execute, every postflop pick was held on the reconciler's pot fault and played by hand
const K9 = [
  "───── new hand ─────", "(hand id 4920637334)", "Seat 3 posts small blind (0.4 BB)", "Seat 5 posts big blind (1 BB)",
  "Your hand: High card, king", "Seat 6 folds", "YOUR TURN: FOLD / CALL 1 BB / RAISE TO 2 BB",
  "Study pick executed — Raise 2.5 (auto)", "Seat 1 raises to 2.6 BB", "Seat 3 folds", "Seat 5 calls 1.6 BB",
  "— FLOP — 7♣ 9♦ 7♥ — pot 5.6 BB", "Seat 5 checks", "YOUR TURN: CHECK / BET 1 BB",
  "Auto-execute held — line uncertain — pot disagrees with the ledger",
  "Time bank +22s pressed (the client starts it when the clock reaches 0)", "Seat 1 checks",
  "— TURN — 7♣ 9♦ 7♥ J♠ — pot 5.6 BB", "Seat 5 bets 2 BB", "YOUR TURN: FOLD / CALL 2 BB / RAISE TO 4 BB",
  "Auto-execute held — line uncertain — pot disagrees with the ledger",
  "Time bank +19s pressed (the client starts it when the clock reaches 0)", "Seat 1 calls 2 BB",
  "— RIVER — 7♣ 9♦ 7♥ J♠ A♥ — pot 9.6 BB", "Seat 5 checks", "YOUR TURN: CHECK / BET 1 BB",
  "Auto-execute held — line uncertain — pot disagrees with the ledger", "Seat 1 checks",
  "Seat 5 shows 10♣ Q♥", "Your cards: 9♥ K♠", "★ Player 1 wins main pot ($0.46) with (Two pair, nines and sevens).",
];

describe("autoExecOf", () => {
  it("reads hand 4920637334's feed: the open landed, the three postflop picks were held (worked 1 of 4)", () => {
    const s = autoExecOf({ feedLines: K9 })!;
    expect(s.from).toBe("feed");
    expect(s.decisions.map((d) => [d.street, d.pick, d.tries, d.outcome])).toEqual([
      ["preflop", "Raise 2.5", 1, "confirmed"],
      ["flop", null, 0, "held"], ["turn", null, 0, "held"], ["river", null, 0, "held"],
    ]);
    expect(s.verdict).toBe("partly");
    expect(s.label).toBe("worked 1 of 4, failed on the flop — held: line uncertain — pot disagrees with the ledger");
  });

  it("a hand auto-execute played throughout: worked · 1 try", () => {
    const s = autoExecOf({ feedLines: ["YOUR TURN: FOLD / CALL 1 BB / RAISE TO 2 BB", "Study pick executed — Fold (auto)", "Seat 1 folds"] })!;
    expect(s.verdict).toBe("worked");
    expect(s.label).toBe("worked · 1 try");
  });

  it("counts a refused press and its retry as two tries", () => {
    const s = autoExecOf({ feedLines: [
      "YOUR TURN: FOLD / CALL 1 BB / RAISE TO 2 BB",
      "Study pick NOT executed — FOLD: the Buy-chips panel is over the action strip (seen on the press's own read)",
      "Auto-execute: FOLD again (retry 1 of 2) — the last press was refused",
      "Study pick executed — FOLD (auto)",
    ] })!;
    expect(s.decisions).toHaveLength(1);
    expect(s.decisions[0]).toMatchObject({ tries: 2, outcome: "confirmed" });
    expect(s.label).toBe("worked · 2 tries");
  });

  it("an unverified press is not a success", () => {
    const s = autoExecOf({ feedLines: ["YOUR TURN: FOLD / CALL 1 BB / RAISE TO 2 BB", "Study pick executed — Raise 2.5 (auto)",
                                        "Study pick unverified — Raise 2.5: hero is no longer on the clock"] })!;
    expect(s.verdict).toBe("failed");
    expect(s.label).toBe("failed on the preflop — unverified: hero is no longer on the clock");
  });

  it("prefers the wrapper's own log", () => {
    const s = autoExecOf({
      feedLines: K9,
      autoExec: [{ street: "preflop", pick: "Raise 2.5", source: "auto", tries: 1, outcome: "confirmed", why: null, did: "raise 2.6", held: null, heldS: null },
                 { street: "flop", pick: "CHECK", source: "auto", tries: 1, outcome: "confirmed", why: null, did: "check", held: null, heldS: null }],
    })!;
    expect(s.from).toBe("wrapper");
    expect(s.label).toBe("worked · 2 decisions, 2 tries");
  });

  it("no auto-execute in the hand: null", () => {
    expect(autoExecOf({ feedLines: ["YOUR TURN: CHECK / BET 1 BB", "Seat 1 checks"] })).toBeNull();
    expect(autoExecOf({})).toBeNull();
    // an already-pressed decision's "cannot fire" is not a decision of its own
    expect(fromFeedLines(["YOUR TURN: FOLD / CALL 1 BB", "Study pick executed — Call (auto)",
                          "Auto-execute has an answer (Call) it cannot fire — already executed for this decision"])).toHaveLength(1);
  });
});
