import { z } from "zod";

// Card representation
export const SuitSchema = z.enum(["h", "d", "c", "s"]);
export const RankSchema = z.enum([
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
]);

export const CardSchema = z.object({
  rank: RankSchema,
  suit: SuitSchema,
});

// Card string format like "As", "Kh", "Tc"
export const CardStringSchema = z
  .string()
  .regex(/^[2-9TJQKA][hdcs]$/, "Invalid card format. Use format like 'As', 'Kh', 'Tc'");

// Position enum
export const PositionSchema = z.enum([
  "UTG",
  "UTG1",
  "UTG2",
  "LJ",
  "HJ",
  "CO",
  "BTN",
  "SB",
  "BB",
  "OOP", // Out of position (generic)
  "IP",  // In position (generic)
]);

// Street representation
export const StreetSchema = z.enum(["preflop", "flop", "turn", "river"]);

// Action types
export const ActionTypeSchema = z.enum([
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "allin",
]);

// Single action in history
export const ActionSchema = z.object({
  position: PositionSchema,
  actionType: ActionTypeSchema,
  amount: z.number().nonnegative().optional(), // Amount for bet/raise/call
  street: StreetSchema,
  timestamp: z.string().datetime().optional(),
});

// Action history - array of actions
export const ActionHistorySchema = z.array(ActionSchema);

// Range representation (like "AA,KK,QQ,AKs,AKo:0.5")
export const RangeStringSchema = z
  .string()
  .describe("Range in TexasSolver format (e.g., 'AA,KK,QQ,AKs,AKo:0.5')");

// Player information
export const PlayerSchema = z.object({
  position: PositionSchema,
  stack: z.number().positive(),
  // Range is inferred from position and action history
  // Committed amount is calculated from action history
});

// Board state
export const BoardSchema = z.object({
  flop: z.array(CardStringSchema).length(3).optional(),
  turn: CardStringSchema.optional(),
  river: CardStringSchema.optional(),
});

// Bet sizing configuration
export const BetSizeSchema = z.object({
  position: z.enum(["oop", "ip"]),
  street: z.enum(["flop", "turn", "river"]),
  actionType: z.enum(["bet", "raise", "donk", "allin"]),
  size: z.number().positive().optional(), // Percentage of pot (e.g., 100 for pot-sized)
});

// Solver configuration
export const SolverConfigSchema = z.object({
  accuracy: z.number().positive().default(0.3),
  maxIterations: z.number().int().positive().default(200),
  threadCount: z.number().int().positive().default(4),
  useIsomorphism: z.boolean().default(true),
  printInterval: z.number().int().positive().default(10),
  allinThreshold: z.number().min(0).max(1).default(0.67),
});

// Poker game state - main input schema
export const PokerGameStateSchema = z.object({
  // Current player (hero) information
  hero: z.object({
    position: PositionSchema,
    holding: z
      .array(CardStringSchema)
      .length(2)
      .describe("Hero's two hole cards"),
  }),

  // Other players in the hand
  players: z
    .array(PlayerSchema)
    .min(1)
    .describe("All players including hero"),

  // Board cards
  board: BoardSchema,

  // Pot information (auto-calculated from action history if not provided)
  bigBlind: z.number().positive().default(1).describe("Big blind amount"),
  pot: z.number().positive().optional().describe("Current pot size (auto-calculated if omitted)"),
  effectiveStack: z.number().positive().optional().describe("Effective stack (auto-calculated if omitted)"),

  // Action history
  actionHistory: ActionHistorySchema,

  // Street information
  currentStreet: StreetSchema,

  // Betting configuration
  betSizes: z.array(BetSizeSchema).optional(),

  // Solver configuration
  solverConfig: SolverConfigSchema.optional(),

  // Game variant
  gameType: z.enum(["holdem", "shortdeck"]).default("holdem"),
});

// GTO Decision output
export const GTOActionSchema = z.object({
  action: ActionTypeSchema,
  amount: z.number().nonnegative().optional(),
  frequency: z.number().min(0).max(1), // How often to take this action (0-1)
  ev: z.number().optional(), // Expected value
});

export const GTODecisionSchema = z.object({
  recommendedActions: z.array(GTOActionSchema),
  equity: z.number().min(0).max(1).optional(),
  exploitability: z.number().optional(),
  strategy: z.record(z.string(), z.number()).optional(), // Full mixed strategy
});

// Situations the engine recognizes but cannot solve — hand off to a human.
export const DeferReasonSchema = z.enum([
  "preflop", // no preflop blueprint yet
  "multiway", // 3+ players; engine is heads-up only
  "facing-bet", // villain bet/raised on the current street (mid-street navigation pending)
  "hand-not-in-range", // hero's holding is outside the inferred range for his seat
]);

export const DeferDecisionSchema = z.object({
  action: z.literal("defer"),
  reason: DeferReasonSchema,
  detail: z.string(),
});

// Type exports
export type Suit = z.infer<typeof SuitSchema>;
export type Rank = z.infer<typeof RankSchema>;
export type Card = z.infer<typeof CardSchema>;
export type CardString = z.infer<typeof CardStringSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type Street = z.infer<typeof StreetSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type ActionHistory = z.infer<typeof ActionHistorySchema>;
export type Player = z.infer<typeof PlayerSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type BetSize = z.infer<typeof BetSizeSchema>;
export type SolverConfig = z.infer<typeof SolverConfigSchema>;
export type PokerGameState = z.infer<typeof PokerGameStateSchema>;
export type GTOAction = z.infer<typeof GTOActionSchema>;
export type GTODecision = z.infer<typeof GTODecisionSchema>;
export type DeferReason = z.infer<typeof DeferReasonSchema>;
export type DeferDecision = z.infer<typeof DeferDecisionSchema>;
