import { describe, it, expect } from "bun:test";
import { WasmSolverService } from "../services/wasmSolverService";
import type { PokerGameState } from "../schemas/poker";

/** Minimal valid heads-up river spot with hero (BB/OOP) first to act. */
function riverSpot(overrides: Partial<PokerGameState> = {}): PokerGameState {
  return {
    hero: { position: "BB", holding: ["As", "Ah"] },
    players: [
      { position: "BB", stack: 100 },
      { position: "BTN", stack: 100 },
    ],
    board: { flop: ["Qs", "Jh", "2h"], turn: "8c", river: "3d" },
    bigBlind: 1,
    pot: 20,
    effectiveStack: 90,
    actionHistory: [],
    currentStreet: "river",
    gameType: "holdem",
    solverConfig: {
      accuracy: 5,
      maxIterations: 20,
      threadCount: 1,
      useIsomorphism: true,
      printInterval: 10,
      allinThreshold: 0.67,
    },
    ...overrides,
  };
}

describe("WasmSolverService defer handling", () => {
  it("defers preflop spots", () => {
    const svc = new WasmSolverService();
    const outcome = svc.solve(riverSpot({ currentStreet: "preflop" }));
    expect(outcome.status).toBe("deferred");
    if (outcome.status === "deferred") {
      expect(outcome.decision.action).toBe("defer");
      expect(outcome.decision.reason).toBe("preflop");
    }
  });

  it("defers multiway spots", () => {
    const svc = new WasmSolverService();
    const outcome = svc.solve(
      riverSpot({
        players: [
          { position: "BB", stack: 100 },
          { position: "BTN", stack: 100 },
          { position: "CO", stack: 100 },
        ],
      })
    );
    expect(outcome.status).toBe("deferred");
    if (outcome.status === "deferred") {
      expect(outcome.decision.reason).toBe("multiway");
      expect(outcome.decision.detail).toContain("3 players");
    }
  });

  it("defers when hero is facing a bet on the current street", () => {
    const svc = new WasmSolverService();
    const outcome = svc.solve(
      riverSpot({
        actionHistory: [
          { position: "BTN", actionType: "bet", amount: 10, street: "river" },
        ],
      })
    );
    expect(outcome.status).toBe("deferred");
    if (outcome.status === "deferred") {
      expect(outcome.decision.reason).toBe("facing-bet");
    }
  });

  it("still throws on malformed input (board/street mismatch)", () => {
    const svc = new WasmSolverService();
    expect(() =>
      svc.solve(riverSpot({ board: { flop: ["Qs", "Jh", "2h"] } }))
    ).toThrow(/Board has/);
  });

  it("solves a supported spot and defers a hand outside the inferred range", () => {
    const svc = new WasmSolverService();

    const solved = svc.solve(riverSpot());
    expect(solved.status).toBe("solved");
    if (solved.status === "solved") {
      expect(solved.decision.recommendedActions.length).toBeGreaterThan(0);
    }

    // 72o is not in the BB's inferred defending range (same spot → cache hit)
    const deferred = svc.solve(riverSpot({ hero: { position: "BB", holding: ["7h", "2d"] } }));
    expect(deferred.status).toBe("deferred");
    if (deferred.status === "deferred") {
      expect(deferred.decision.reason).toBe("hand-not-in-range");
    }
  }, 60000);

  it("tracks coverage across solved and deferred requests", () => {
    const svc = new WasmSolverService();
    expect(svc.coverageStats().coverage).toBe(1); // no requests yet

    svc.solve(riverSpot({ currentStreet: "preflop" }));
    svc.solve(riverSpot({ currentStreet: "preflop" }));
    svc.solve(
      riverSpot({
        players: [
          { position: "BB", stack: 100 },
          { position: "BTN", stack: 100 },
          { position: "CO", stack: 100 },
        ],
      })
    );

    const stats = svc.coverageStats();
    expect(stats.solved).toBe(0);
    expect(stats.deferred).toBe(3);
    expect(stats.total).toBe(3);
    expect(stats.coverage).toBe(0);
    expect(stats.deferredByReason.preflop).toBe(2);
    expect(stats.deferredByReason.multiway).toBe(1);
    expect(stats.deferredByReason["facing-bet"]).toBe(0);
  });
});
