import { SolverCommandGenerator } from "./src/services/commandGenerator.ts";
import { calculatePot, calculateCommitted } from "./src/utils/rangeInference.ts";

const gameState = {
  hero: { position: "BB", holding: ["Qh", "Qd"] },
  players: [
    { position: "BB", stack: 100 },
    { position: "BTN", stack: 100 }
  ],
  board: { flop: ["Ac", "8h", "5d"] },
  bigBlind: 1,
  actionHistory: [
    { position: "BTN", actionType: "raise", amount: 2.5, street: "preflop" },
    { position: "BB", actionType: "raise", amount: 6.5, street: "preflop" },
    { position: "BTN", actionType: "call", amount: 6, street: "preflop" }
  ],
  currentStreet: "flop",
  gameType: "holdem",
  solverConfig: {
    accuracy: 0.5,
    maxIterations: 20,
    threadCount: 4,
    useIsomorphism: true
  }
};

// Calculate pot
const pot = calculatePot(gameState.players, gameState.actionHistory, gameState.bigBlind);
console.log("Calculated pot:", pot);

// Calculate effective stack
const remainingStacks = gameState.players.map((player) => {
  const committed = calculateCommitted(player.position, gameState.actionHistory, gameState.bigBlind);
  console.log(`${player.position} committed: ${committed}, remaining: ${player.stack - committed}`);
  return player.stack - committed;
});
const effectiveStack = Math.min(...remainingStacks);
console.log("Effective stack:", effectiveStack);

gameState.pot = pot;
gameState.effectiveStack = effectiveStack;

const commands = SolverCommandGenerator.generateCommands(gameState);
console.log("\n=== Generated Commands ===");
console.log(commands);
