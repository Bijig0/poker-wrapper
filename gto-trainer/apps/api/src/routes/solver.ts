import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PokerGameStateSchema, GTODecisionSchema } from "../schemas/poker";
import { WasmSolverService } from "../services/wasmSolverService";
import {
  calculatePot,
  calculateEffectiveStack,
  calculateCommitted,
} from "../utils/rangeInference";

const app = new Hono();
// postflop-solver (Rust→WASM, in-process) — solves novel sizes live, caches repeats
const solverService = new WasmSolverService();

/**
 * POST /solve
 * Analyze a poker game state and return GTO decision
 */
app.post("/solve", zValidator("json", PokerGameStateSchema), async (c) => {
  try {
    const gameState = c.req.valid("json");

    // Auto-calculate pot if not provided
    if (!gameState.pot) {
      gameState.pot = calculatePot(
        gameState.players,
        gameState.actionHistory,
        gameState.bigBlind
      );
    }

    // Auto-calculate effective stack if not provided
    // Use the minimum stack between all players after subtracting committed amounts
    if (!gameState.effectiveStack) {
      const remainingStacks = gameState.players.map((player) => {
        const committed = calculateCommitted(
          player.position,
          gameState.actionHistory,
          gameState.bigBlind
        );
        return player.stack - committed;
      });
      gameState.effectiveStack = Math.min(...remainingStacks);
    }

    // Solve the game state (live solve on first request, cached thereafter).
    // Recognized-but-unsupported spots come back as a "defer" decision — the
    // caller should hand control to a human rather than treat it as a failure.
    const outcome = solverService.solve(gameState);

    if (outcome.status === "deferred") {
      return c.json({
        success: true,
        data: outcome.decision,
        meta: { deferred: true, coverage: solverService.coverageStats() },
      });
    }

    return c.json({
      success: true,
      data: outcome.decision,
      meta: { ...outcome.meta, deferred: false },
    });
  } catch (error) {
    console.error("Solver error:", error);

    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /stats
 * Completeness tracker: solved vs deferred requests, broken down by reason.
 */
app.get("/stats", (c) => {
  return c.json({
    success: true,
    data: solverService.coverageStats(),
  });
});

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

export default app;
