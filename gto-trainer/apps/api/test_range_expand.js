import { expandRange } from "./src/utils/rangeExpander.ts";

// Test various range expansions
console.log("Testing range expansion...\n");

console.log("1. Pocket pairs:");
console.log("22+ =", expandRange("22+"));
console.log("TT+ =", expandRange("TT+"));
console.log("AA =", expandRange("AA"));

console.log("\n2. Suited hands:");
console.log("A2s+ =", expandRange("A2s+"));
console.log("KTs+ =", expandRange("KTs+"));
console.log("AKs =", expandRange("AKs"));

console.log("\n3. Offsuit hands:");
console.log("A2o+ =", expandRange("A2o+"));
console.log("KQo =", expandRange("KQo"));

console.log("\n4. Combined range:");
const testRange = "22+,A2s+,K5s+,Q8s+,A5o+,K9o+,KQo";
console.log("Input:", testRange);
console.log("Output:", expandRange(testRange));

console.log("\n5. Weighted range:");
console.log("AA:0.5,KK:0.75 =", expandRange("AA:0.5,KK:0.75"));
