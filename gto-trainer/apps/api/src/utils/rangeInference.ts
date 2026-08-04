import type { Position, ActionHistory } from "../schemas/poker";
import { expandRange } from "./rangeExpander";

/**
 * Default ranges for different positions in heads-up play
 * These are standard GTO ranges that can be refined based on actions
 */
const DEFAULT_RANGES: Record<string, string> = {
  // Button/IP ranges (wider)
  BTN: "22+,A2s+,K2s+,Q2s+,J5s+,T7s+,97s+,86s+,75s+,64s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o",
  IP: "22+,A2s+,K2s+,Q2s+,J5s+,T7s+,97s+,86s+,75s+,64s+,53s+,43s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o",

  // Big Blind/OOP ranges (tighter)
  BB: "22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,87s,76s,65s,54s,A2o+,K9o+,Q9o+,J9o+,T9o",
  OOP: "22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,87s,76s,65s,54s,A2o+,K9o+,Q9o+,J9o+,T9o",

  // Small Blind (similar to BB)
  SB: "22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,87s,76s,A5o+,K9o+,Q9o+,JTo",
};

/**
 * Tighter ranges for 3-bet/4-bet scenarios
 */
const THREEB_RANGES: Record<string, string> = {
  BTN_vs_3bet: "88+,ATs+,KQs,AJo+,KQo",
  BB_3bet: "88+,ATs+,KTs+,QTs+,JTs,AJo+,KQo",
  BTN_4bet: "JJ+,AQs+,AKo",
  BB_5bet: "QQ+,AKs,AKo",
};

/**
 * Infer range based on position and action history
 */
export function inferRange(
  position: Position,
  actionHistory: ActionHistory
): string {
  // Find actions by this position
  const playerActions = actionHistory.filter(a => a.position === position);

  let shorthandRange: string;

  if (playerActions.length === 0) {
    // No actions yet, use default range for position
    shorthandRange = DEFAULT_RANGES[position] || DEFAULT_RANGES.OOP;
  } else {
    // Check for aggressive actions (3-bet, 4-bet)
    const hasRaise = playerActions.some(a => a.actionType === "raise");
    const raiseCount = playerActions.filter(a => a.actionType === "raise").length;

    if (raiseCount >= 2) {
      // This is a 3-bet or 4-bet range (tighter)
      if (position === "BTN" || position === "IP") {
        shorthandRange = THREEB_RANGES.BTN_vs_3bet;
      } else {
        shorthandRange = THREEB_RANGES.BB_3bet;
      }
    } else if (hasRaise) {
      // This is an opening range or calling 3-bet
      // Still relatively wide
      shorthandRange = DEFAULT_RANGES[position] || DEFAULT_RANGES.OOP;
    } else {
      // Calling range (slightly tighter)
      if (position === "BTN" || position === "IP") {
        shorthandRange = "22+,A2s+,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,75s+,A2o+,K8o+,Q9o+,J9o+";
      } else {
        shorthandRange = "22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,A5o+,K9o+,Q9o+,JTo";
      }
    }
  }

  // Expand shorthand notation to explicit hand list for TexasSolver
  return expandRange(shorthandRange);
}

/**
 * Calculate how much a player has committed to the pot based on action history
 */
export function calculateCommitted(
  position: Position,
  actionHistory: ActionHistory,
  bigBlind: number = 1
): number {
  let committed = 0;

  // Add blinds first
  if (position === "BB") {
    committed += bigBlind;
  } else if (position === "SB") {
    committed += bigBlind / 2;
  }

  // Add all bets, calls, and raises from this position
  for (const action of actionHistory) {
    if (action.position === position) {
      if (action.actionType === "bet" || action.actionType === "raise") {
        committed += action.amount || 0;
      } else if (action.actionType === "call") {
        committed += action.amount || 0;
      } else if (action.actionType === "allin") {
        // All-in amount should be specified
        committed += action.amount || 0;
      }
    }
  }

  return committed;
}

/**
 * Calculate pot size from action history and committed amounts
 */
export function calculatePot(
  players: Array<{ position: Position }>,
  actionHistory: ActionHistory,
  bigBlind: number = 1
): number {
  const totalCommitted = players.reduce(
    (sum, player) => sum + calculateCommitted(player.position, actionHistory, bigBlind),
    0
  );

  return totalCommitted;
}

/**
 * Calculate effective stack after actions
 */
export function calculateEffectiveStack(
  initialStack: number,
  position: Position,
  actionHistory: ActionHistory,
  bigBlind: number = 1
): number {
  const committed = calculateCommitted(position, actionHistory, bigBlind);
  return initialStack - committed;
}
