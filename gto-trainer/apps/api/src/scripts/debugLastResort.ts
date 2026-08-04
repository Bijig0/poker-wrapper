/** Stage-by-stage debug of the last-resort AI tier for a broken-feed hand.
 *  Run: bun run src/scripts/debugLastResort.ts (needs GTOW client on :9222). */
import { deriveExploitSpot } from "../utils/deriveExploitSpot/deriveExploitSpot";
import { reconstructFlopRanges } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildPreflopTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { preflopDb } from "../services/preflopDb";
import { gtowApi } from "../services/gtowApi";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const hand: ParsedHand = {
  handId: 4,
  heroSeatId: 2,
  heroCards: ["Qd", "Js"],
  board: ["6h", "6s", "8c", "9h", "Ah"],
  street: "river",
  actions: [
    { seatId: 4, hero: false, type: "post-sb", amount: 0.4, street: "preflop" },
    { seatId: 1, hero: false, type: "post-bb", amount: 1.0, street: "preflop" },
    { seatId: 1, hero: false, type: "bet", amount: 2.28, street: "preflop" },
    { seatId: 1, hero: false, type: "check", street: "flop" },
    { seatId: 2, hero: true, type: "check", street: "flop" },
    { seatId: 1, hero: false, type: "check", street: "turn" },
    { seatId: 2, hero: true, type: "check", street: "turn" },
    { seatId: 1, hero: false, type: "bet", amount: 4.72, street: "river" },
  ],
  liveSeats: [1, 2],
  committed: { 1: 4.72 },
  potByStreet: {},
  positions: { 4: "SB", 1: "BB", 2: "CO", 3: "BTN" },
  stacks: undefined,
  currentNode: {
    street: "river",
    toActSeatId: 2,
    toActIsHero: true,
    pot: 10.28,
    toCall: 4.72,
    legalActions: [],
    complete: false,
  },
  ended: false,
};

const heroPos = hand.positions[hand.heroSeatId]!;
const pruned: ParsedHand = { ...hand, positions: { 2: "CO", 1: "BB" } };
const d = deriveExploitSpot(pruned, heroPos);
console.log("deriveExploitSpot:", JSON.stringify(d).slice(0, 300));
if (!d.ok) process.exit(1);

const preTokens = buildPreflopTokens(hand, heroPos);
console.log("preTokens:", preTokens);
const recon = reconstructFlopRanges(preTokens, (line) => preflopDb.rawNode("Cash6m500zGeneral", 100, line));
console.log("recon ok:", recon.ok, recon.ok ? Object.keys((recon as any).ranges) : (recon as any).reason);

const toCall = 4.72;
const potBefore = Math.max(1, Math.round((10.28 - toCall) * 100) / 100);
const res = await gtowApi.customSolve({
  board: "6h6s8c9hAh",
  pot: potBefore,
  stack: 97,
  oopRange: new Array(1326).fill(1),
  ipRange: new Array(1326).fill(1),
  oopPos: d.spot.oopPos,
  ipPos: d.spot.ipPos,
  startingStreet: "RIVER",
  flopActions: "",
  turnActions: "",
  riverActions: `R${toCall}`,
  fixedBets: { RIVER: Math.round((toCall / potBefore) * 1000) / 10 },
});
console.log("customSolve ok:", res.ok, "err:", (res as any).error ?? null, "solutions:", res.ok ? res.data?.action_solutions?.length : null);
process.exit(0);
