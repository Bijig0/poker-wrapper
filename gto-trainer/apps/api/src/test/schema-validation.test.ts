import { PokerGameStateSchema } from "../schemas/poker";

console.log("🧪 Testing Poker Game State Schema Validation\n");

// Test 1: Valid game state
console.log("Test 1: Valid game state");
const validGameState = {
  hero: {
    position: "BTN" as const,
    holding: ["As", "Kh"],
  },
  players: [
    {
      position: "BB" as const,
      stack: 100,
      range: "AA,KK,QQ,JJ,AKs",
      committed: 1,
    },
    {
      position: "BTN" as const,
      stack: 100,
      range: "AA,KK,QQ,JJ,AKs",
      committed: 0,
    },
  ],
  board: {
    flop: ["Qs", "Jh", "2h"],
  },
  pot: 10,
  effectiveStack: 95,
  actionHistory: [
    {
      position: "BB" as const,
      actionType: "bet" as const,
      amount: 5,
      street: "flop" as const,
    },
  ],
  currentStreet: "flop" as const,
  gameType: "holdem" as const,
};

try {
  const result = PokerGameStateSchema.parse(validGameState);
  console.log("✅ Valid game state passed validation");
  console.log(`   Hero: ${result.hero.position} with ${result.hero.holding.join("")}`);
  console.log(`   Board: ${result.board.flop?.join(", ")}`);
  console.log(`   Pot: ${result.pot}, Stack: ${result.effectiveStack}\n`);
} catch (error) {
  console.log("❌ Unexpected validation error:", error);
}

// Test 2: Invalid card format
console.log("Test 2: Invalid card format (should fail)");
try {
  PokerGameStateSchema.parse({
    ...validGameState,
    hero: {
      position: "BTN",
      holding: ["XX", "YY"], // Invalid cards
    },
  });
  console.log("❌ Should have failed validation\n");
} catch (error: any) {
  console.log("✅ Correctly rejected invalid card format");
  console.log(`   Error: ${error.errors?.[0]?.message || error.message}\n`);
}

// Test 3: Invalid position
console.log("Test 3: Invalid position (should fail)");
try {
  PokerGameStateSchema.parse({
    ...validGameState,
    hero: {
      position: "INVALID_POSITION",
      holding: ["As", "Kh"],
    },
  });
  console.log("❌ Should have failed validation\n");
} catch (error: any) {
  console.log("✅ Correctly rejected invalid position");
  console.log(`   Error: ${error.errors?.[0]?.message || error.message}\n`);
}

// Test 4: Wrong number of hole cards
console.log("Test 4: Wrong number of hole cards (should fail)");
try {
  PokerGameStateSchema.parse({
    ...validGameState,
    hero: {
      position: "BTN",
      holding: ["As"], // Should be 2 cards
    },
  });
  console.log("❌ Should have failed validation\n");
} catch (error: any) {
  console.log("✅ Correctly rejected wrong number of cards");
  console.log(`   Error: ${error.errors?.[0]?.message || error.message}\n`);
}

// Test 5: Invalid street in action history
console.log("Test 5: Invalid street in action history (should fail)");
try {
  PokerGameStateSchema.parse({
    ...validGameState,
    actionHistory: [
      {
        position: "BB",
        actionType: "bet",
        amount: 5,
        street: "invalid_street", // Invalid
      },
    ],
  });
  console.log("❌ Should have failed validation\n");
} catch (error: any) {
  console.log("✅ Correctly rejected invalid street");
  console.log(`   Error: ${error.errors?.[0]?.message || error.message}\n`);
}

// Test 6: Valid with turn and river
console.log("Test 6: Valid game state with turn and river");
const fullBoardState = {
  ...validGameState,
  board: {
    flop: ["Qs", "Jh", "2h"],
    turn: "9d",
    river: "3c",
  },
  currentStreet: "river" as const,
};

try {
  const result = PokerGameStateSchema.parse(fullBoardState);
  console.log("✅ Full board state passed validation");
  console.log(`   Board: ${result.board.flop?.join(", ")}, ${result.board.turn}, ${result.board.river}`);
  console.log(`   Street: ${result.currentStreet}\n`);
} catch (error) {
  console.log("❌ Unexpected validation error:", error);
}

console.log("🎉 All schema validation tests completed!");
