/** End-to-end MES overlay probe: the M1 spot fed through the SAME pipeline the
 *  fake-table panels use — parsePanelFeed -> fastSolve — no server needed. */
import { parsePanelFeed, type PanelRow } from "../feed/parsePanelFeed/parsePanelFeed";
import { fastSolve } from "../services/fastSolve";

const rows = (hero: string, flop: string, extra: PanelRow[] = []): PanelRow[] => [
  { k: "info", t: `New hand — you have ${hero}` },
  { k: "hero", t: "You post the small blind 0.5 BB" },
  { k: "act", t: "Seat 3 (BB) posts the big blind 1 BB" },
  { k: "act", t: "Seat 1 (BTN) folds" },
  { k: "hero", t: "You raise to 3 BB" },
  { k: "act", t: "Seat 3 (BB) calls 2 BB" },
  { k: "street", t: `FLOP  ${flop} — pot 6 BB` },
  ...extra,
  { k: "turn", t: "YOUR TURN — pot 6 BB" },
];

async function probe(label: string, r: PanelRow[], strategy?: "exploit" | "chart") {
  const { hand, warnings } = parsePanelFeed(r);
  if (!hand) { console.log(label, "NO HAND", warnings); return; }
  // same hero-position derivation as routes/fastSolver.ts (blind-post fallback)
  const heroPost = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  const heroPos =
    hand.positions[hand.heroSeatId] ?? (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);
  const res = await fastSolve(hand, heroPos, strategy ? { strategy } : {});
  if (!res.ok) { console.log(label, "FAIL:", res.reason.slice(0, 120)); return; }
  console.log(`\n### ${label}`);
  console.log("  source:", res.source, "| tier:", res.tier, "| mode:", res.strategyMode);
  console.log("  tag:", res.exploitTag);
  console.log("  actions:", res.actions.map((a) => `${a.action} ${a.frequency.toFixed(0)}%${a.ev != null ? ` (${a.ev}bb)` : ""}`).join("  "));
  console.log("  decision:", res.decision?.action, "| exploit:", res.exploitDecision?.action, "| chart:", res.chartDecision?.action);
  if (res.warning) console.log("  warning:", res.warning);
}

// 1. Exact solved board, hero AQo (in the exploit raise range), flop root
await probe("M1 exact board, AQo, first to act", rows("A♥ Q♠", "K♣ 7♦ 2♥"));
// 2. Off-list flop -> nearest texture
await probe("M1 off-list flop Ks8d3h", rows("A♥ Q♠", "K♠ 8♦ 3♥"));
// 3. Check-raise line: hero checked, BB bet 2BB, hero to act
await probe("M1 x/bet line, T7s", rows("T♦ 7♣", "K♣ 7♦ 2♥", [
  { k: "hero", t: "You check" },
  { k: "act", t: "Seat 3 (BB) bets 2 BB" },
]));
// 4. Limped-premium (AKs never raises bvb under the exploit scheme)
await probe("M1 AhKh (limped preflop under exploit)", rows("A♥ K♥", "K♣ 7♦ 2♥"));
process.exit(0);
