/**
 * WasmSolverService
 * -----------------
 * Solves heads-up POSTFLOP spots with postflop-solver (Rust→WASM, in-process)
 * and returns hero's GTO decision. Wraps a content-addressed cache so repeated
 * spots are served instantly.
 *
 * Supported: heads-up, postflop (flop/turn/river), hero acting first on the
 * current street (OOP at root, or IP after villain checks).
 * Recognized-but-unsupported situations (preflop, 3+ players, hero facing a
 * bet mid-street, hero's hand outside the inferred range) return a structured
 * "defer" outcome — hand off to a human — rather than an error. Coverage of
 * solved vs deferred spots is tracked per reason.
 */

import { createRequire } from "module";
import { join } from "path";
import type {
  PokerGameState,
  GTODecision,
  GTOAction,
  Position,
  ActionType,
  DeferDecision,
  DeferReason,
} from "../schemas/poker";
import { inferRange } from "../utils/rangeInference";
import { SolveCache, cacheKey } from "./solveCache";

const require = createRequire(import.meta.url);
const { solve_spot } = require(
  join(import.meta.dir, "..", "..", "solver-wasm", "pkg", "solver_wasm.js")
);

interface SpotResult {
  exploitability: number;
  node_player: number;
  actions: string[];
  hands: string[];
  strategy: number[][];
  weights: number[];
  ev: number[];
  equity: number[];
}

export interface SolveMeta {
  engine: "postflop-solver-wasm";
  cached: boolean;
  solveMs: number;
  exploitability: number; // chips
  cacheStats: ReturnType<SolveCache<unknown>["stats"]>;
}

export type SolveOutcome =
  | { status: "solved"; decision: GTODecision; meta: SolveMeta }
  | { status: "deferred"; decision: DeferDecision };

export interface CoverageStats {
  solved: number;
  deferred: number;
  total: number;
  /** Fraction of requests the engine could solve (1 when no requests yet). */
  coverage: number;
  deferredByReason: Record<DeferReason, number>;
}

/** Heads-up postflop seat for a position. (postflop-solver is HU only.) */
function seatOf(pos: Position): "oop" | "ip" {
  return pos === "OOP" || pos === "BB" ? "oop" : "ip";
}

/** Parse "Bet(30)" / "AllIn(100)" / "Check" → API action + chip amount. */
function parseAction(s: string): { action: ActionType; amount?: number } {
  if (s === "Check") return { action: "check" };
  if (s === "Call") return { action: "call" };
  if (s === "Fold") return { action: "fold" };
  const m = s.match(/^(Bet|Raise|AllIn)\((\d+)\)$/);
  if (m) {
    const amount = parseInt(m[2], 10);
    if (m[1] === "AllIn") return { action: "allin", amount };
    return { action: m[1] === "Bet" ? "bet" : "raise", amount };
  }
  return { action: "check" };
}

function boardString(gs: PokerGameState): string {
  const cards = [
    ...(gs.board.flop ?? []),
    ...(gs.board.turn ? [gs.board.turn] : []),
    ...(gs.board.river ? [gs.board.river] : []),
  ];
  return cards.join("");
}

export class WasmSolverService {
  // cache stores the full range-vs-range solve; hero's hand is extracted after.
  private cache = new SolveCache<SpotResult>(500);

  // completeness tracking: solved vs deferred-to-human, per reason
  private solvedCount = 0;
  private deferredByReason: Record<DeferReason, number> = {
    preflop: 0,
    multiway: 0,
    "facing-bet": 0,
    "hand-not-in-range": 0,
  };

  // Default action abstraction. Raises are all-in-only ("a") so the tree stays
  // BOUNDED at any stack depth — percentage re-raises explode the tree at high
  // SPR (deep flops). A single half-pot bet keeps flop solves tractable; the
  // cache makes repeats instant. (Configurable via setAbstraction.)
  private betSizes = "50%";
  private raiseSizes = "a";

  /** Override the bet/raise action abstraction (postflop-solver size strings). */
  setAbstraction(betSizes: string, raiseSizes: string) {
    this.betSizes = betSizes;
    this.raiseSizes = raiseSizes;
  }

  solve(gs: PokerGameState): SolveOutcome {
    if (gs.currentStreet === "preflop") {
      return this.defer(
        "preflop",
        "WASM engine solves postflop only (preflop needs a precomputed blueprint)."
      );
    }
    if (gs.players.length > 2) {
      return this.defer(
        "multiway",
        `${gs.players.length} players in hand — engine is heads-up only.`
      );
    }

    const board = boardString(gs);
    const expected = gs.currentStreet === "flop" ? 6 : gs.currentStreet === "turn" ? 8 : 10;
    if (board.length !== expected) {
      // malformed input, not a recognized-but-unsupported situation
      throw new Error(
        `Board has ${board.length / 2} cards but currentStreet is '${gs.currentStreet}'.`
      );
    }

    // mid-street: if villain has already bet/raised on the current street, hero
    // is facing a bet — not yet supported (root-of-street navigation only).
    const facingBet = gs.actionHistory.some(
      (a) =>
        a.street === gs.currentStreet &&
        a.position !== gs.hero.position &&
        (a.actionType === "bet" || a.actionType === "raise" || a.actionType === "allin")
    );
    if (facingBet) {
      return this.defer(
        "facing-bet",
        "Hero is facing a bet on this street — mid-street navigation is not yet supported."
      );
    }

    // ranges for both seats
    const hero = gs.hero.position;
    const villain = gs.players.find((p) => p.position !== hero)?.position ?? hero;
    const heroSeat = seatOf(hero);
    const heroRange = inferRange(hero, gs.actionHistory);
    const villainRange = inferRange(villain, gs.actionHistory);
    const oopRange = heroSeat === "oop" ? heroRange : villainRange;
    const ipRange = heroSeat === "oop" ? villainRange : heroRange;

    const pot = Math.round(gs.pot!);
    const stack = Math.round(gs.effectiveStack!);
    const targetPct = (gs.solverConfig?.accuracy ?? 0.3) / 100;
    const maxIter = gs.solverConfig?.maxIterations ?? 200;

    const key = cacheKey({
      street: gs.currentStreet,
      board,
      oopRange,
      ipRange,
      pot,
      stack,
      betSizes: this.betSizes,
      raiseSizes: this.raiseSizes,
      heroSeat,
    });

    let result = this.cache.get(key);
    let cached = true;
    let solveMs = 0;
    if (!result) {
      cached = false;
      const t0 = performance.now();
      result = JSON.parse(
        solve_spot(
          gs.currentStreet,
          board,
          oopRange,
          ipRange,
          pot,
          stack,
          this.betSizes,
          this.raiseSizes,
          heroSeat,
          maxIter,
          targetPct
        )
      ) as SpotResult;
      solveMs = performance.now() - t0;
      this.cache.set(key, result);
    }

    const decision = this.extractHero(result, gs.hero.holding);
    if (!decision) {
      const [c1, c2] = gs.hero.holding;
      return this.defer(
        "hand-not-in-range",
        `Hero hand ${c1}${c2} is not in the inferred range for this seat — cannot extract a strategy.`
      );
    }

    this.solvedCount++;
    return {
      status: "solved",
      decision,
      meta: {
        engine: "postflop-solver-wasm",
        cached,
        solveMs: Math.round(solveMs * 100) / 100,
        exploitability: result.exploitability,
        cacheStats: this.cache.stats(),
      },
    };
  }

  /** Coverage: how often the engine solved vs deferred, per defer reason. */
  coverageStats(): CoverageStats {
    const deferred = Object.values(this.deferredByReason).reduce((s, n) => s + n, 0);
    const total = this.solvedCount + deferred;
    return {
      solved: this.solvedCount,
      deferred,
      total,
      coverage: total ? this.solvedCount / total : 1,
      deferredByReason: { ...this.deferredByReason },
    };
  }

  private defer(reason: DeferReason, detail: string): SolveOutcome {
    this.deferredByReason[reason]++;
    return { status: "deferred", decision: { action: "defer", reason, detail } };
  }

  /** Pull hero's specific holding out of the range-vs-range solve. */
  private extractHero(result: SpotResult, holding: string[]): GTODecision | null {
    const [c1, c2] = holding;
    const idx = result.hands.findIndex((h) => h === c1 + c2 || h === c2 + c1);
    if (idx < 0) return null;

    const freqs = result.strategy[idx];
    const recommendedActions: GTOAction[] = [];
    const strategy: Record<string, number> = {};
    for (let a = 0; a < result.actions.length; a++) {
      const f = freqs[a];
      if (f > 0.001) {
        const { action, amount } = parseAction(result.actions[a]);
        recommendedActions.push({ action, amount, frequency: f });
        strategy[action] = (strategy[action] ?? 0) + f;
      }
    }
    recommendedActions.sort((x, y) => y.frequency - x.frequency);

    return {
      recommendedActions,
      equity: result.equity[idx],
      exploitability: result.exploitability,
      strategy,
    };
  }
}
