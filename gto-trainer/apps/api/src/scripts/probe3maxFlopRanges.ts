/**
 * Does a 3-handed flop reconstruct its ranges from the 3-MAX charts?
 *
 * The solve itself needs GTO Wizard running; this proves the step before it —
 * that the preflop ranges seeding the solve come from the asymmetric corpus
 * rather than the 6-max charts, and that they differ enough to matter.
 *
 * Run with the test rig up (fake table on :7701) and the chart server on :8777:
 *   bun run src/scripts/probe3maxFlopRanges.ts <fixture-name>
 */
import { chartFor, fetchNode } from "../services/hrc3max";
import { preflopDb } from "../services/preflopDb";
import { buildPreflopTokens, buildPreflopTokens3max } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { reconstructFlopRanges } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const WRAPPER = process.env.WRAPPER_URL ?? "http://127.0.0.1:7701";
const name = process.argv[2] ?? "threemax-flop-btn-pfr-vs-bb";

const fixture = await Bun.file(
  `${import.meta.dir}/../../../../../ignition-study-wrapper/tests/fixtures/${name}.json`
).json();

await fetch(`${WRAPPER}/faketable/load`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(fixture.spec),
});
const hand = (await (await fetch(`${WRAPPER}/hand`)).json()).hand as ParsedHand;
const heroPos = hand.positions[hand.heroSeatId] ?? null;

console.log(`${name}: ${hand.street} ${hand.board.join(" ")} | hero ${heroPos} | positions`,
            hand.positions);

const size = (r: Record<string, number>) =>
  Object.values(r).reduce((a, b) => a + b, 0).toFixed(1);
const top = (r: Record<string, number>) =>
  Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([h, w]) => `${h}:${w.toFixed(2)}`).join(" ");

// ---- the 3-max corpus ------------------------------------------------------
const chart = chartFor(hand, heroPos);
const tokens3 = buildPreflopTokens3max(hand, heroPos);
console.log(`\n3-MAX  chart=${chart.id}  line=${tokens3.join("-") || "(root)"}`);
const tri = await reconstructFlopRanges(tokens3, async (line) => {
  const n = await fetchNode(chart.id, line);
  return n === "unreachable" ? null : n;
});
if (tri.ok) {
  for (const [pos, r] of Object.entries(tri.ranges))
    console.log(`   ${pos.padEnd(4)} combos-weighted ${size(r).padStart(6)}  top: ${top(r)}`);
} else {
  console.log("   FAILED:", tri.reason);
}

// ---- what it used to use ---------------------------------------------------
const tokens6 = buildPreflopTokens(hand, heroPos);
console.log(`\n6-MAX  Cash6m500zGeneral@100  line=${tokens6.join("-") || "(root)"}`);
const six = await reconstructFlopRanges(tokens6, (line) =>
  preflopDb.rawNode("Cash6m500zGeneral", 100, line));
if (six.ok) {
  for (const [pos, r] of Object.entries(six.ranges))
    console.log(`   ${pos.padEnd(4)} combos-weighted ${size(r).padStart(6)}  top: ${top(r)}`);
} else {
  console.log("   FAILED:", six.reason);
}
