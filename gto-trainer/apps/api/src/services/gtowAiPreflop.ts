/**
 * gtowAiPreflop — GTO Wizard AI (Ultra) as the PREFLOP FALLBACK PIECE of the 6-max ring strategy.
 *
 * WHAT IT IS (2026-09-19, Brady: "add the AI fallback for our Ignition 200NL strategy, and name it
 * as one of our pieces"). The Ignition 200NL Ring 6-max Equilibrium strategy answers preflop from
 * our own HRC 6-max charts first — instant, and solved for exactly our rake. Those charts cover
 * 4-6 seats, the size ladder they were solved with, and 30-150bb. Everything outside that used to
 * be a MISS (the miss queue, "table shape outside the 6-max strategy", "line ends on a terminal",
 * off-tree sizes, past the ladder). This piece takes those spots to GTO Wizard's cloud preflop
 * solver, built from the ACTUAL table — the live stacks, the blinds and straddle as posted,
 * Ignition's rake for the number of players dealt, our size menu plus every size actually seen in
 * the line — and reads hero's combo out of the solved node. The answer is logged with
 * source "gtow-ai-preflop" / tier "ai-preflop", so the hand page, the Sources tab and Analytics
 * show exactly which piece answered.
 *
 * WHAT THE API DOES AND DOES NOT DO (probed 2026-09-19, see memory gtow-ai-preflop):
 *   - multiway preflop needs FIXED size menus (AUTOMATIC sizing is refused for 3+ players)
 *   - positions come in fixed sets by player count (2 SB/BB · 3 BTN/SB/BB · 4 CO/BTN/SB/BB ·
 *     5 HJ/CO/BTN/SB/BB · 6 UTG..BB); our earlier seats are relabelled onto that set in order
 *   - limps: max_allowed_limps 2 = ONE non-SB limper + the SB complete; a second limper is not in the tree
 *   - a straddle is just a blind on that player; antes are per player
 *   - a dead small blind cannot be expressed (SB blind 0 is refused at solve time: "Invalid Total Pot = 0",
 *     and a 5-player set without an SB position is refused outright) — the hand is approximated with the
 *     next set up and the SB seat as a GHOST posting a penny. Measured 2026-09-23 on hand 732 (HJ first in,
 *     5 dealt): the earlier ghost holding its full 0.5bb blind put 0.5bb of phantom dead money in the pot and
 *     made hero limp 1.75% of his range; the penny removes both (limp 0.01%, raise 20.6% vs 16.1%). Rake cap
 *     counts the seats actually dealt.
 *     THE GHOST FOLDS, IT IS NOT ALL-IN (2026-10-01, hand 4921843568): the first penny ghost had stack = blind,
 *     so it was all-in from the deal and always "reached the flop" — one of the THREE flop seats the AI allows.
 *     With the raiser second and the BB (closing) third, the engine offered no other seat a call: over the solve
 *     cache, a non-blind seat facing one open had a call in 49 of 49 live-SB trees and 0 of 6 ghost trees. Hero
 *     opened the CO, the BTN cold-called, and the flop had no ranges ("token C is not an action at 'F-F-R2.6'").
 *     Now the ghost has a stack behind and NOTHING IT MAY DO BUT FOLD (no limp, no calls, no sizes): probed on
 *     that table (scripts/_probeDeadSbGhost.ts) its node reads F 100% everywhere and the BTN's reads
 *     F 81.9 / C 8.2 / R 9.9. The tree puts the ghost on the clock, so the line carries its fold (lineOf).
 *   - one tree per table shape (positions + stacks + blinds + sizes); ~2-4 s to solve the root, 1-2 s
 *     per node after that; solutions are cached per shape for the process's life
 *
 * POSTFLOP (2026-09-19): when this piece answered preflop, the postflop chain conditions on THIS tree's
 * ranges — arrivalRangesGtowAi walks the same solved tree and exposes the chart piece's shape (position →
 * class → weight), so fastSolve.solvePostflop6maxStrategy reads one shape whichever piece answered.
 */
import { allInCalls } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { bbAmount, TREE_SETTINGS, TREE_SETTINGS_TAG } from "./gtowApi";
import { dealtSeats, dealtCount } from "../utils/dealtSeats/dealtSeats";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
import { gtowSessions, type GtowNeed, type GtowSessionId } from "./gtowSessions";
import { gtowRequests } from "./gtowRequestLog";
import { comboIndex, toClassWeights, COMBOS } from "../utils/comboIndex/comboIndex";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";
import { rakeCapCents } from "./profiles";
import { isTestStakeOf } from "./strategies";
import { actorsWithAllins, foldEarliestCaller, foldableCallers, foldSeatsOut } from "../utils/fitLine/fitLine";
import { blendFitMixes, type MixAction } from "../utils/fitBlend/fitBlend";
import { isOffTree, offTreeStats, pctOf } from "./offTree";
import { setPreflopPin, pinRest, preflopPinKey, type AiPreflopPin, type ResumeOutcome } from "./preflopPin";
// THE REDUCED TREE (2026-10-01, utils/reducedArrival): flop-entering ranges for a line no tree holds
import {
  cameInLimping, classesToCombos, combosToClasses, normalised, normalisedCombos, planReducedArrival, type ReducedCaller,
} from "../utils/reducedArrival/reducedArrival";
import { dealtBySeat } from "../utils/archivedHand/archivedHand";
// THE LOCKED HEADS-UP TREE (2026-10-04, utils/lockedHeadsUp): the last resort with the raiser's range imposed by a node lock
import { planLockedHeadsUp, type LockedPlan, type TreeSeat } from "../utils/lockedHeadsUp/lockedHeadsUp";
import { nodeGetter, POOL_LIMP_CHART } from "./hrc6max";
import type { HrcNode } from "./hrc3max";
import { answerLog } from "./answerLog";
// THE PERSISTENT SOLVE CACHE (2026-09-28, services/gtowSolveCache.ts): the preflop half, at ensureSolution / fetchNode.
import {
  NODE_OK, NO_NODE, cacheKeyOf, gtowSolveCache, isStoredSolId, keyOfStoredSolId, nodeAddr, storedSolId, type GtowSolveCache,
} from "./gtowSolveCache";

export const GTOW_AI_PREFLOP_SOURCE = "gtow-ai-preflop" as const;
export const GTOW_AI_PREFLOP_TIER = "ai-preflop" as const;

const API_BASE = "https://api.gtowizard.com";
const ORDER = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const API_SETS: Record<number, string[]> = {
  2: ["SB", "BB"], 3: ["BTN", "SB", "BB"], 4: ["CO", "BTN", "SB", "BB"], 5: ["HJ", "CO", "BTN", "SB", "BB"], 6: ORDER,
};
/** Our size menu — the HRC grid's opens, three 3-bets per open, two 4-bets, one 5-bet+; every size the
 *  line actually contains is added on top so the walk lands on the exact node. */
const OPENS = ["2x", "2.2x", "2.5x", "3x", "3.5x"];
const THREE_BETS = ["3.2x", "3.8x", "4.5x"];
const FOUR_BETS = ["2.2x", "2.6x"];
const FIVE_PLUS = ["2.2x"];
const NODE_TIMEOUT_MS = 30_000;
/** How long one node is polled for (GTOW_NODE_TIMEOUT_MS, read at every read — the tests shorten it). */
const nodeTimeoutMs = (): number => { const v = Number(process.env.GTOW_NODE_TIMEOUT_MS); return v > 0 ? v : NODE_TIMEOUT_MS; };
/** The dead-SB ghost's blind — a penny, so it adds no dead money to speak of — and the label its seat carries in the
 *  shape's stacks (and so in a tree's id, `SB:0.01`: how a dead-SB tree is told apart everywhere). */
const DEAD_SB_GHOST = 0.01;
/** What the ghost has behind in the TREE: enough that it is not all-in for its blind (an all-in seat takes one of the
 *  three flop seats — see the header). It never plays a chip of it: its only action is the fold. */
const DEAD_SB_GHOST_STACK = 100;
const POLL_MS = 1200;

export interface AiPreflopShape {
  n: number;
  /** our position -> API position, in API order */
  apiOf: Record<string, string>;
  /** API position -> the table seat it was built from (the dead-SB ghost has none) */
  seatOf: Record<string, number>;
  positions: string[];            // API order
  stacks: Record<string, number>; // by API position, starting stack in bb
  sb: number; bb: number;
  straddle: { pos: string; bb: number } | null;
  rakeCapBb: number;
  deadSb: boolean;
  /** dead money in the pot before the first action (bb) — chips of players the LAST RESORT folded out */
  deadBb: number;
  heroApiPos: string | null;
  /** THE ANTE, per player in bb (2026-09-30, CoinPoker ring): present only on a table that posts one. The stacks above
   *  are the stacks AS DEALT, before the ante — GTO Wizard takes the ante out of them itself (ante_distribution_method
   *  PER_PLAYER). Absent on Ignition, so its trees and their keys are exactly what they were. */
  anteBb?: number;
  /** THE TABLE'S OWN RAKE (siteRakeOf), when the site sends its terms; absent = Ignition's 5% / rakeCapBb, no flop no drop */
  siteRake?: SiteRake;
  /** THE 250BB CAP (2026-10-03, PREFLOP_STACK_CAP_BB): present only when two seats were deeper than GTO Wizard's preflop
   *  limit and every stack was clamped to it. `real`: the stacks the clamped seats really had (API position → bb). */
  stackCap?: { cap: number; real: Record<string, number> };
}

/**
 * GTO WIZARD'S PREFLOP LIMIT (2026-10-03, session_20261003_153908). GTO Wizard AI refuses a preflop tree whose
 * EFFECTIVE stack is over 250bb: the tree and the solution are created (201), then every node, the root included,
 * answers 422 VALIDATION_ERROR "Preflop: Only effective stacks up to 250bb are supported". Effective = the second-
 * deepest seat: hand 4922315369 answered at BTN 213 / SB 126 / BB 367 (one deep seat), hands 4922315540 (BTN 369 /
 * SB 255.5 / BB 77) and 4922316453 (CO 256 / BB 254) did not, and hero got no pick on either. Brady, 2026-10-03: cap the
 * preflop tree at 250bb while hands are still dealt that deep — accurate enough for the orbit until the wrapper
 * re-seats. Postflop has no such limit (260bb and 400bb heads-up, 260bb 3-way: all answered) and keeps the table's
 * stacks. One deep seat alone is left exactly as it was: its trees and stored solves keep their keys.
 */
export const PREFLOP_STACK_CAP_BB = 250;

/** The answer's note for a capped tree: "stacks over 250bb capped … BTN 369→250, SB 255.5→250" ("" when not capped). */
export function stackCapNote(shape: Pick<AiPreflopShape, "stackCap">): string {
  const c = shape.stackCap;
  if (!c) return "";
  const list = Object.entries(c.real).map(([p, v]) => `${p} ${v}→${c.cap}`).join(", ");
  return `stacks over ${c.cap}bb capped at ${c.cap}bb for the preflop tree (GTO Wizard's limit): ${list}`;
}

/** A tree's rake when the site states its own terms: percent, cap in bb, and whether a pot that ends preflop pays. */
export interface SiteRake { pct: number; capBb: number; preflopType: "full" | "no_flop_no_drop"; capKnown: boolean }

/**
 * The rake a tree for this hand is solved at when the hand carries its SITE's terms (ParsedHand.siteRake — CoinPoker
 * sends them with every table), else null and the caller keeps Ignition's model. `dealtN`: the players dealt in —
 * CoinPoker states a separate heads-up percentage. A cap the site did not state is modelled as none (1000bb), and
 * `capKnown` says so for the answer's note.
 */
export function siteRakeOf(hand: Pick<ParsedHand, "siteRake">, dealtN: number): SiteRake | null {
  const r = hand.siteRake;
  if (!r) return null;
  const pct = dealtN === 2 && r.pctHeadsUp != null ? r.pctHeadsUp : r.pct;
  return { pct, capBb: r.capBb ?? 1000, preflopType: r.preflopPots ? "full" : "no_flop_no_drop", capKnown: r.capBb != null };
}

export interface AiPreflopResult {
  ok: true;
  actions: { action: string; frequency: number }[];
  decision: WeightedPick | null;
  line: string;
  pos: string | null;
  heroClass: string | null;
  treeKey: string;
  /** the solution hero's node was read on, and the line it was read at (after any size snap / fit) — what an
   *  audit needs to read the same node's EVs back (scripts/stackSnapAudit) */
  solId: string;
  usedLine: string;
  solveSecs: number;
  cached: boolean;
  /** hero's node came from the persistent solve cache (services/gtowSolveCache) — no request was sent for it */
  stored?: boolean;
  shape: AiPreflopShape;
  note: string;
  /** a FITTED answer only: every fit hero's node was read on (the seats folded out, the line, hero's mix there in
   *  percent) — more than one means `actions` is their blend (utils/fitBlend) */
  fits?: AiFitRead[];
  /** each villain action on the line(s) hero's node was read at, with its share of that seat's range at its node in
   *  this tree — check #3's material (an action the tree all but never takes leaves hero's node off its path). On a
   *  FITTED answer always; on an exact line when the caller asked (opts.villainLines: the chart's fit rule) */
  villainLines?: PreflopVillainLine[];
  /** a LAST RESORT answer: the one line fastSolve's path carries about how it was played */
  lastResort?: { how: string };
}
/** One fit of a line the tree cannot hold, as hero's node was read on it. */
export interface AiFitRead { folds: string[]; line: string; actions: MixAction[]; offPath: boolean }
/** One villain action on a line hero's preflop node was read at: how much of his range takes it at that node. */
export interface PreflopVillainLine { seat: string; code: string; line: string; nodeFreq: number; maxHand: number; offTree: boolean }
/**
 * A refusal's `kind` names the CLASS of failure when the caller should treat it differently from "the cloud
 * could not answer". CAPTURE_FAULT (PF-26, 2026-09-23): GTO Wizard rejected the line itself with 400
 * VALIDATION_ERROR "Incorrect actions" — the capture is not a legal betting sequence ("F-F-F-F-F" padded past a
 * terminal, "F-F-C-F-F-F-R4.5-F"; 15 answers.sqlite rows), so no tree will ever hold it and the last resort would
 * only re-solve the same corrupt line as heads-up. fastSolve reads this kind and stops before the last resort.
 */
export const CAPTURE_FAULT = "capture-fault" as const;
/** The refusal kind for a line that ends on ANOTHER seat's node (2026-09-30, hand 4921602992): the table's line, walked
 *  in a tree built from the table, put the BB on the clock, not hero. That is a fact about the LINE — whose turn the
 *  capture says it is — not about the tree, so the last resort (the same line, heads-up) ends on the same seat's node
 *  again after a tree build, a solution and a string of polls: 36 s and ~25 requests on a probe for a spot that was
 *  never hero's, holding the poller's slot while hero's real decision timed out. fastSolve reads this kind and stops. */
export const LINE_NOT_HERO = "line-not-hero" as const;
/** The refusal kind for a VALIDATION_ERROR that is about the TREE, not the line (2026-10-03): GTO Wizard's own detail
 *  is the reason. Not a capture fault — fastSolve goes on to the last resort. */
export const TREE_REFUSED = "tree-refused" as const;
/** GTO Wizard's own words from a refusal read back as "422: {…"detail": "…"…}" (else the text as it came). */
const refusalDetail = (error: string): string =>
  /"detail"\s*:\s*"([^"]+)"/.exec(error)?.[1] ?? error.replace(/^\d{3}:\s*/, "").slice(0, 160);
export type AiPreflopOutcome = AiPreflopResult | { ok: false; reason: string; line?: string; kind?: string };

const round5 = (x: number) => Math.round(x * 2) / 2;
const num = (n: number) => String(Math.round(n * 100) / 100);

/**
 * THE ONE WAY A PREFLOP TREE WRITES "RAISE TO <total>" AS AN AMOUNT (2026-10-04, scripts/_probeNodeLockStageA.ts
 * `units` `straddle` `levels` `cap`). GTO Wizard reads "<N>bb" in ANY size list of a preflop tree — the open, every
 * raise level, an all-in — as N times the tree's LARGEST POST, not N chips:
 *   posts 0.5/1 (control):          "6bb" → R6
 *   posts 0.5/3:                    "6bb" → R18                (and "4.23x" → R12.69: a multiple of the bet faced)
 *   posts 2.6/1 (the larger the SB): "13bb" → R33.8            ("5x" → R13)
 *   a straddle, 0.5/1/2 (CO 2):     open "6bb" → R12, "2.5x" → R5; a raise list "15bb" → R30, "3x" → R15;
 *                                   "100bb" → R100, the all-in (a size past the stack IS the all-in)
 * "<N>x" is always N times the bet being faced. Stacks, posts, `pot` and the rake cap are read in our units. A LARGEST
 * POST UNDER 1 CANNOT BE EXPRESSED: GTO Wizard rescales the posts so it is 1 and leaves the stacks as sent (0.01/0.5
 * played as 0.02/1; 0.25/0.25 as 1/1) — such a tree is refused (shapeOf; the locked tree's plan keeps hero's post ≥ 1).
 * With the largest post 1 — every tree the builder makes today: a 1bb big blind, `straddle` null, the dead-SB ghost a
 * penny — this writes exactly what was written before (`${num(total)}bb`), so no stored tree changes its key.
 */
export function sizeTo(total: number, largestPost: number): string {
  return largestPost === 1 ? `${num(total)}bb` : `${Math.round((total / largestPost) * 1000) / 1000}bb`;
}
/** A size list written in chips ("<total>bb", "<N>x") as the tree must send it (sizeTo); identity when the largest post is 1. */
export function sizesFor(list: string[], largestPost: number): string[] {
  if (largestPost === 1) return list;
  return list.map((x) => { const m = /^(\d+(?:\.\d+)?)bb$/.exec(x); return m ? sizeTo(Number(m[1]), largestPost) : x; });
}
/** The largest post of a shape: what a "<N>bb" size counts in. */
export const largestPostOf = (shape: Pick<AiPreflopShape, "sb" | "bb" | "straddle">): number => Math.max(shape.sb, shape.bb, shape.straddle?.bb ?? 0);

/** What an action put in the pot, in the tree's own blinds: the NL5 test stake's 0.4bb small-blind post is the
 *  NL200 game's 0.5 (PF-06 — the same pin shapeOf applies to the blind itself), everything else as recorded. */
const putBb = (hand: ParsedHand, a: ParsedAction): number =>
  a.type === "post-sb" && isTestStakeOf("ign-ring-NL200-6", hand.bbCents) ? 0.5 : (a.amount ?? 0);

/** Each seat's chips in the pot preflop: a post / raise / bet / all-in amount is the seat's total, a call adds its
 *  amount (the same reading as utils/archivedHand.roundContributions). */
function preflopPutIn(hand: ParsedHand): Map<number, number> {
  const m = new Map<number, number>();
  for (const a of hand.actions) {
    if (a.street !== "preflop") continue;
    const amt = Number(a.amount ?? 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const seat = a.hero ? hand.heroSeatId : a.seatId;
    if (a.type === "call") m.set(seat, (m.get(seat) ?? 0) + amt);
    else if (a.type === "post-sb" || a.type === "post-bb" || a.type === "raise" || a.type === "bet" || a.type === "all-in") m.set(seat, Math.max(m.get(seat) ?? 0, amt));
  }
  return m;
}

/** Hero's position: an override, his blind post, or the positions map. */
export function heroPosOf(hand: ParsedHand, heroPos: string | null): string | null {
  const post = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  return (heroPos ?? hand.positions[hand.heroSeatId] ?? (post ? (post.type === "post-sb" ? "SB" : "BB") : null))?.toUpperCase() ?? null;
}

/** The table as the API must see it. `dealt`: the hand's pinned dealt stacks (fastSolve.pinPostflop), read once
 *  per hand — without it this function reads `hand.stacks` fresh, which drifts between probes of the same hand
 *  (see the header note in fastSolve.ts) and was the one postflop-range source the 2026-09-24 stack pin missed:
 *  any Ignition hand that isn't exactly 6-handed, and any hand thin enough to need the AI preflop tree instead
 *  of a chart, reads its flop-entering ranges through here on every street. */
export function shapeOf(hand: ParsedHand, heroPos: string | null, deadBb = 0, rakeSeats?: number, dealt?: Record<number, number>): AiPreflopShape | { error: string } {
  const hp = heroPosOf(hand, heroPos);
  // A SEAT THAT WAS NOT DEALT IS NOT AT THE TABLE (2026-09-25, hand 4920414446). The wrapper labels every occupied
  // seat, sitting-out ones included (hand 937's BTN, seat 3: no start stack, never acted), and this built the tree
  // 6-handed with a phantom 100bb BTN. Drop a labelled seat only when BOTH say it was not dealt: it is missing from
  // `liveSeats` (the wrapper's dealt list; other sources send only the unfolded seats) AND it has no action.
  // (the rule lives in utils/dealtSeats since round 2, shared with the routing and the rake cap)
  const seats: { seat: number; pos: string }[] = [...dealtSeats(hand).entries()]
    .filter(([s]) => hand.positions[s] != null)
    .map(([seat, pos]) => ({ seat, pos }));
  if (hp && !seats.some((x) => x.seat === hand.heroSeatId)) seats.push({ seat: hand.heroSeatId, pos: hp });
  const byPos = new Map(seats.map((x) => [x.pos, x.seat]));
  let present = [...new Set(seats.map((x) => x.pos))].filter((p) => ORDER.includes(p));
  if (present.length !== seats.length) return { error: `seat labels outside the 6-max set: ${seats.map((x) => x.pos).join(", ")}` };
  // heads-up: the dealer is the small blind
  if (present.length === 2 && present.includes("BTN") && !present.includes("SB")) {
    byPos.set("SB", byPos.get("BTN")!); byPos.delete("BTN"); present = present.map((p) => (p === "BTN" ? "SB" : p));
  }
  // a hand with no small blind (the seat emptied between hands): the API cannot express it —
  // model the missing SB as a ghost posting a penny that can only fold (see the header: measured against the 0.5bb ghost)
  const deadSb = !present.includes("SB") && present.includes("BB") && present.length >= 2;
  const ordered = present.slice().sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const n = ordered.length + (deadSb ? 1 : 0);
  if (n < 2 || n > 6) return { error: `${n} seats: the AI preflop piece covers 2-6` };
  const set = API_SETS[n]!;
  const apiOf: Record<string, string> = {};
  const nonBlinds = ordered.filter((p) => p !== "SB" && p !== "BB");
  const apiNonBlinds = set.filter((p) => p !== "SB" && p !== "BB");
  nonBlinds.forEach((p, i) => { apiOf[p] = apiNonBlinds[i]!; });
  if (ordered.includes("SB")) apiOf.SB = "SB";
  if (ordered.includes("BB")) apiOf.BB = "BB";
  const sbPost = hand.actions.find((a) => a.type === "post-sb");
  const bbPost = hand.actions.find((a) => a.type === "post-bb");
  // a TEST-STAKE table (NL5 ring) plays the NL200 answers: price its rake at NL200 too, or the $4 cap
  // becomes 80bb at $0.05 and the fallback answers a different game from the charts it stands in for
  const testStake = isTestStakeOf("ign-ring-NL200-6", hand.bbCents);
  const bbCents = hand.bbCents == null || testStake ? 200 : hand.bbCents;
  // ... AND ITS SMALL BLIND (PF-06, 2026-09-23): at $0.02/$0.05 the SB posts 0.4bb (166 of 171 NL5 hands in
  // hands.db), so the rake pin alone still built a 0.4/1 tree — a different equilibrium, keyed apart from the
  // NL200 one and solved again in the cloud. The test stake is the NL200 game: its blinds are 0.5/1 here whatever
  // the table posted. The starting stacks need no pin — `cur + committed` is the stack before the post either way.
  const sb = deadSb ? DEAD_SB_GHOST : (testStake ? 0.5 : (sbPost?.amount ?? 0.5)), bb = bbPost?.amount ?? 1;
  const stacks: Record<string, number> = {};
  const seatOf: Record<string, number> = {};
  const putIn = preflopPutIn(hand);
  for (const p of ordered) {
    const seat = byPos.get(p)!;
    seatOf[apiOf[p]!] = seat;
    // `dealt` already carries the stack AS DEALT (behind + committed + earlier streets, hrc6max.dealtBySeat) —
    // `committed` must not be added again on top of it, or a pinned postflop read double-counts this street's chips.
    const cur = dealt ? dealt[seat] : hand.stacks?.[seat];
    const committed = dealt ? 0 : (hand.committed?.[seat] ?? 0);
    const exact = cur != null ? cur + committed : 100;
    // A SEAT ALL IN HAS EXACTLY ITS STACK (2026-09-30, hand 4921657513). Stacks round to the half-blind so tables a
    // few chips apart share one tree — but the CO's 12.2bb shove became a 12bb tree stack, whose only raise is the
    // all-in R12, while the line built from the table says R12.2: more than his tree stack. GTO Wizard's validator
    // refuses that as "Incorrect actions" (400 VALIDATION_ERROR, not NODE_DOES_NOT_EXIST), so the walk never got to
    // snap it, the refusal read as a capture fault, and hero timed out on KJo facing the shove. A seat whose chips in
    // are its whole stack keeps the exact figure, so the tree's all-in sits at the size the table showed.
    const allIn = (putIn.get(seat) ?? 0) >= exact - 0.05;
    stacks[apiOf[p]!] = Math.min(999, Math.max(1, allIn ? Math.round(exact * 100) / 100 : round5(exact)));
  }
  if (deadSb) stacks.SB = DEAD_SB_GHOST;
  // THE 250BB CAP (PREFLOP_STACK_CAP_BB): only when the SECOND-deepest real seat is past it — that is GTO Wizard's
  // effective stack. Every stack over the cap is clamped to it; the real figures ride on the shape for the note and for
  // lineOf (a raise at or past a clamped stack is that seat's all-in). The dead-SB ghost is not a seat here.
  let stackCap: AiPreflopShape["stackCap"];
  const realStacks = ordered.map((p) => apiOf[p]!).filter((p) => !(deadSb && p === "SB")).map((p) => stacks[p]!).sort((a, b) => b - a);
  if (realStacks.length >= 2 && realStacks[1]! > PREFLOP_STACK_CAP_BB) {
    const real: Record<string, number> = {};
    for (const p of set) {
      if (deadSb && p === "SB") continue;
      const v = stacks[p];
      if (v != null && v > PREFLOP_STACK_CAP_BB) { real[p] = v; stacks[p] = PREFLOP_STACK_CAP_BB; }
    }
    stackCap = { cap: PREFLOP_STACK_CAP_BB, real };
  }
  // the cap is by players DEALT — the ghost was not dealt in
  // the LAST RESORT reduces the field to two seats but the table still dealt six: the cap follows the table
  const dealtN = rakeSeats ?? (n - (deadSb ? 1 : 0));
  const rakeCapBb = Math.round((rakeCapCents(dealtN) / bbCents) * 100) / 100;
  // the ANTE and the SITE'S RAKE ride on the shape only when the table has them (CoinPoker ring, 2026-09-30)
  const anteBb = hand.anteBb != null && hand.anteBb > 0 ? Math.round(hand.anteBb * 1000) / 1000 : 0;
  const siteRake = siteRakeOf(hand, dealtN);
  // a largest post under 1 cannot be expressed: GTO Wizard rescales the posts to it and not the stacks (sizeTo)
  if (Math.max(sb, bb) < 1) return { error: `the largest post is ${Math.max(sb, bb)}bb — GTO Wizard rescales a largest post under 1bb and not the stacks, so the tree cannot be written` };
  return { n, apiOf, seatOf, positions: set, stacks, sb, bb, straddle: null, rakeCapBb, deadSb, deadBb: Math.max(0, Math.round(deadBb * 100) / 100), heroApiPos: hp ? (apiOf[hp] ?? null) : null,
    ...(anteBb ? { anteBb } : {}), ...(siteRake ? { siteRake } : {}), ...(stackCap ? { stackCap } : {}) };
}

/**
 * THE STACKS A LOGGED AI TREE WAS BUILT WITH, back on this hand's seats (2026-09-24, hand 723). An AI-preflop answer
 * logs its tree as `gtow-ai · 3-handed · BTN:100/SB:103.5/BB:102.5` (its `chart`; the postflop chain's rangeSource is
 * the same string), and those are the stacks the live table read at the decision — the only record of them: the
 * archived row keeps end-of-hand readings, and even rebuilt to the decision (utils/archivedHand) they are an
 * estimate, where the live read could itself have been off (a blind not yet taken off the stack on screen, a top-up
 * still landing). A page that rebuilds the tree an answer came from passes this to shapeOf as `dealt`, so the rebuild
 * is built with that tree's stacks (and, walking the same line, lands on the same tree key). null when `id` is not an
 * AI tree id or does not fit this hand's shape.
 */
export function dealtFromTreeId(hand: ParsedHand, heroPos: string | null, id: string | null | undefined): Record<number, number> | null {
  const m = /^gtow-ai · (\d)-handed · (\S+)/.exec(String(id ?? "").trim());
  if (!m) return null;
  const logged: Record<string, number> = {};
  for (const part of m[2]!.split("/")) {
    const [p, v] = part.split(":");
    const x = Number(v);
    if (!p || v == null || !Number.isFinite(x)) return null;
    logged[p] = x;
  }
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape || shape.n !== Number(m[1]) || shape.positions.some((p) => logged[p] == null)) return null;
  const out: Record<number, number> = {};
  for (const [api, seat] of Object.entries(shape.seatOf)) out[seat] = logged[api]!;
  return out;
}

/** The line so far as the API walks it: seat order, F / C / X / R<total bb>; also the raise totals by level. */
export function lineOf(hand: ParsedHand, shape: AiPreflopShape): { tokens: string[]; levels: number[] } {
  const tokens: string[] = []; const levels: number[] = [];
  const posOf = (a: ParsedAction) => (a.hero ? heroPosOf(hand, null) : hand.positions[a.seatId]?.toUpperCase()) ?? null;
  // the API's tree acts in its own seat order; a seat that never acted before the line reaches
  // a later seat is a fold it did not show — pad it, exactly as the chart walk does
  const order = shape.positions.slice();                // API order
  const acted = hand.actions.filter((a) => a.street === "preflop" && a.type !== "post-sb" && a.type !== "post-bb");
  let cursor = 0;
  const calls = allInCalls(hand.actions);
  const pendingHero = !hand.ended && hand.currentNode.street === "preflop" && hand.currentNode.toActIsHero;
  const heroApi = shape.heroApiPos;
  // THE DEAD-SB GHOST FOLDS ON ITS TURN (2026-10-01): the tree puts it on the clock after the button, with the fold
  // its only action, and no seat at the table makes that fold for it. It is due once every seat ahead of it has a
  // token (acted, or padded as a fold) — whether the line goes on to the BB or stops there with the BB to act.
  const ghostAt = shape.deadSb ? order.indexOf("SB") : -1;
  let ghostFolded = false;
  const ghostDue = () => ghostAt >= 0 && !ghostFolded && tokens.length === ghostAt;
  let stoppedAt: string | null = null;
  // A RAISE PAST A CAPPED TREE STACK IS THAT SEAT'S ALL-IN (2026-10-03, PREFLOP_STACK_CAP_BB): the SB's real 255.5bb
  // shove in a tree where he holds 250 would ask GTO Wizard for more than his stack ("Incorrect actions", the
  // 2026-09-30 class). Only in a capped tree — or one rebuilt from a capped tree's logged stacks (dealtFromTreeId:
  // a seat at exactly the cap) — so every other line is exactly what it was.
  const capped = (api: string, t: number): number => {
    const top = shape.stacks[api];
    return top != null && (shape.stackCap || top === PREFLOP_STACK_CAP_BB) && t >= top ? top : t;
  };
  for (let round = 0; round < 4 && cursor < acted.length; round++) {
    for (const api of order) {
      if (cursor >= acted.length) { if (round === 0) stoppedAt = api; break; }
      if (round === 0 && api === "SB" && ghostDue()) { tokens.push("F"); ghostFolded = true; continue; }
      const a = acted[cursor]!;
      const aApi = posOf(a) ? shape.apiOf[posOf(a)!] ?? null : null;
      if (aApi === api || aApi == null) {
        if (a.type === "fold") tokens.push("F");
        else if (a.type === "check") tokens.push("X");
        else if (a.type === "call" || calls.has(a)) tokens.push("C");   // an all-in for no more than the price is a call
        else if (a.type === "raise" || a.type === "bet" || a.type === "all-in") { const t = capped(api, a.amount ?? 0); levels.push(t); tokens.push(`R${num(t)}`); }
        else tokens.push("C");
        cursor++;
      } else if (round === 0 && api !== heroApi && !tokens.length && api === "SB") {
        // nothing to pad before the first action in the blinds
      } else if (round === 0 && !levels.length && api !== "SB" && api !== "BB" && !(pendingHero && api === heroApi)) {
        tokens.push("F");   // an early seat with no recorded action before a later seat acted: it folded
      }
    }
  }
  // the line stopped with the ghost next (the button's was the last action): the BB is on the clock behind its fold
  if (stoppedAt === "SB" && ghostDue()) tokens.push("F");
  return { tokens, levels };
}

/** Size menus. The tree's size is (sizes per level)^levels × seats, and the API refuses a tree past its ceiling
 *  ("TREE_IS_TOO_BIG" — a 3-handed tree with 5 opens × 3 three-bets tripped it). So with three or more seats every
 *  seat carries ONE size per level: the size played where the level has been played, else one default (open 2.5x,
 *  3-bet 3.5x, 4-bet 2.3x). Heads-up trees are small enough for the full menu, on both seats, at the levels still
 *  to be played. */
export function menus(levels: number[], n: number) {
  // THE SIZE PLAYED GOES OUT AS ITS EXACT AMOUNT, "13bb" — not a multiple of the raise below it (2026-10-02, Brady:
  // "why aren't we sending the exact numbers"). GTO Wizard takes an amount in any size list and names the node by
  // it, to the cent of a blind ("8.75bb" → R8.75); a multiple it works out and names at ONE decimal ("3.5x" over 2.5
  // → R8.8), so the address the line spells — the amounts as played, the same two decimals as lineOf's tokens — could
  // miss its own node by a few hundredths. Probed on 30 archived decisions (2-6 seats, dead small blind, dead money,
  // limped pots, jams past 100bb, the heads-up last resort): the same answers as the multiples wherever those landed.
  // repairLine stays the backstop. The defaults of a level still to be played stay multiples.
  const amt = (total: number | undefined, below: number) => (total != null && total > below ? `${num(total)}bb` : null);
  const one = (base: string[], total: number | undefined, below: number) => { const a = amt(total, below); return a ? [a] : base; };
  const add = (base: string[], total: number | undefined, below: number) => { const a = amt(total, below); return a ? [...base, a] : base; };
  // A LEVEL ALREADY PLAYED HOLDS THE SIZE PLAYED AND NOTHING ELSE (2026-10-02, hand 4922086187, Brady: "for levels
  // already played just have a single size"). The open, the 3-bet, the 4-bet that happened are facts: the menu beside
  // them bought nothing and cost three things — GTO Wizard merged the played size into a neighbour (2.6 into 2.5, so
  // hero's node had no address), an unmerged neighbour split the raiser's range (a villain's 3.5x open read as the 1%
  // of hands the solver opens 3.5x rather than 2.5x), and every extra size is tree to solve (facing a 3-bet
  // three-handed: 22 s with the menus, against a 15 s clock). A menu stays where a decision is still to be made.
  // (The fifth-raise list also serves every raise after it, so it keeps its default beside the size played.)
  // a level is played when its raise is in the line and tops the one below it (the open: the 1bb blind)
  const [r0, r1, r2, r3] = levels;
  const lv = (base4: [string[], string[], string[], string[]]) => ({
    opens: one(base4[0], r0, 1), three: one(base4[1], r1, r0 ?? Infinity), four: one(base4[2], r2, r1 ?? Infinity),
    five: add(base4[3], r3, r2 ?? Infinity),
  });
  const hero = n <= 2
    ? lv([OPENS, THREE_BETS, FOUR_BETS, FIVE_PLUS])
    // HERO OPENS ONE SIZE, 2.5x (Brady, 2026-10-02: "set our open always at a single size of 2.5x") — the size every
    // 6-max chart opens. The 2.2x/2.5x/3x menu this replaces split his opening range over the sizes, and his next
    // decision is read on a tree where the open played is the only one: the two trees disagreed about his range.
    : lv([["2.5x"], ["3.5x"], ["2.3x"], FIVE_PLUS]);
  // three or more seats: every seat one size per level, hero's included (the heads-up menus are shared above)
  const villain = hero;
  return { hero, villain };
}

/**
 * EACH SEAT'S ALL-IN, LISTED (2026-10-03). The tree is sent with the settings explicit and off (gtowApi.TREE_SETTINGS):
 * no all-in threshold turning a big raise into the all-in, no all-in added by GTO Wizard's own rule
 * (`allin_if_less_than`). So the all-in is in the tree only where it is listed — and it is listed in every size list
 * of every seat: "<its stack>bb", capped at the deepest other seat (a raise past what anyone can call is the all-in;
 * GTO Wizard names it by the seat's own stack, R<stack>). Probed 2026-10-03 on two trees from the solve cache, 6-handed
 * with a 28.5bb seat and 3-handed at 21/30bb: every node that offered an all-in before still does, the open-jam now
 * exists at 20-30bb (the old rule left it out: an all-in past 5x the pot), and a 3-bet the old threshold had replaced
 * by the all-in (17.5 of a 28.5 stack) is a size of its own again beside it. The dead-SB ghost is not a seat here.
 */
export function seatAllInsPreflop(shape: Pick<AiPreflopShape, "positions" | "stacks" | "deadSb">): Record<string, number> {
  const real = shape.positions.filter((p) => !(shape.deadSb && p === "SB"));
  const st = (p: string) => shape.stacks[p] ?? 100;
  return Object.fromEntries(real.map((p) => {
    const others = real.filter((q) => q !== p).map(st);
    return [p, Math.round(Math.min(st(p), others.length ? Math.max(...others) : st(p)) * 100) / 100];
  }));
}

function treeBody(shape: AiPreflopShape, m: ReturnType<typeof menus>) {
  const allIns = seatAllInsPreflop(shape);
  /** a list with the seat's all-in at its end (an amount at or past it IS the all-in) */
  const withAllIn = (position: string, list: string[]) => {
    const ai = allIns[position];
    if (ai == null) return list;
    const out = list.filter((x) => { const mm = /^(\d+(?:\.\d+)?)bb$/.exec(x); return !(mm && Number(mm[1]) >= ai - 0.005); });
    return [...out, bbAmount(ai)];
  };
  const sizes = (position: string) => {
    // the dead-SB ghost may only fold: no limp, no call, no size to raise to (see the header — an all-in ghost took a
    // flop seat and cost every other seat its cold-call)
    if (shape.deadSb && position === "SB") {
      return { position, type: "FIXED", use_fixed_sizes: true, allow_limp: false, allow_call_opens: false, allow_3betplus_cold_calls: false,
        bet_sizes: [], raise_sizes: [], second_raise_sizes: [], third_plus_raise_sizes: [] };
    }
    const s = position === shape.heroApiPos ? m.hero : m.villain;
    // every amount in chips, written as GTO Wizard reads it (sizeTo: N × the largest post — identity at a 1bb blind)
    const unit = largestPostOf(shape);
    // calls of opens and cold-calls of 3-bets+ must be switched on explicitly in FIXED mode (the web app's own
    // defaults: ccVs2b on, ccVs3bPlus off — we want both, a fish's line is anything)
    return { position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true,
      bet_sizes: sizesFor(withAllIn(position, s.opens), unit), raise_sizes: sizesFor(withAllIn(position, s.three), unit),
      second_raise_sizes: sizesFor(withAllIn(position, s.four), unit), third_plus_raise_sizes: sizesFor(withAllIn(position, s.five), unit) };
  };
  return {
    starting_street: "PREFLOP", pot: shape.deadBb, ante: shape.anteBb || null, ante_distribution_method: "PER_PLAYER",
    max_allowed_limps: shape.n >= 3 ? 2 : null,
    // NO SIZE MERGING (2026-10-02, hand 4922086187, Brady: "it should obviously always be exact"). At 10 — a value copied
    // from the postflop tree, never chosen — GTO Wizard drops a declared size that sits near another: beside 2.5x it
    // dropped 2.2, 2.3 and 2.6 (kept 2.1, 3, 3.5). The line's own size then has no node, and a missing SIZE is answered
    // 204 for ever, not NODE_DOES_NOT_EXIST: hero's node 'R2.6-R13-F' ran out its 30 s and the hand fell to the last
    // resort. At 0 every declared size is a node (probed: the same node in 0.9 s). The store keys on this body.
    // …and since 2026-10-03 the two all-in settings are off as well (gtowApi.TREE_SETTINGS — the all-in is LISTED, above)
    bet_sizes: { ...TREE_SETTINGS, max_num_raises: 5,
      street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: shape.positions.map(sizes) }] },
    players: shape.positions.map((p) => ({
      position: p, display_position: p,
      blind: p === "SB" ? shape.sb : p === "BB" ? shape.bb : (shape.straddle?.pos === p ? shape.straddle.bb : null),
      range: null, stack: shape.deadSb && p === "SB" ? DEAD_SB_GHOST_STACK : (shape.stacks[p] ?? 100),
      tournament_instant_bounty: null, tournament_total_bounty: null,
    })),
    tree_operations: [], resolving_policy: null,
    rake: shape.siteRake
      ? { pct_of_pot: shape.siteRake.pct, cap_in_chips: shape.siteRake.capBb, preflop_rake_type: shape.siteRake.preflopType }
      : { pct_of_pot: 5, cap_in_chips: shape.rakeCapBb, preflop_rake_type: "no_flop_no_drop" },
    tournament_data: null,
  };
}

export const treeKeyOf = (shape: AiPreflopShape, m: ReturnType<typeof menus>) =>
  JSON.stringify([shape.positions, shape.positions.map((p) => shape.stacks[p]), shape.sb, shape.bb, shape.straddle, shape.rakeCapBb, shape.heroApiPos, m, shape.deadBb || 0,
    // the settings off, each seat's all-in listed (2026-10-03): never the same tree as one built under the old settings
    TREE_SETTINGS_TAG,
    // a table with an ante or its own rake is a different tree; one with neither keys exactly as before
    ...(shape.anteBb || shape.siteRake ? [shape.anteBb ?? 0, shape.siteRake ?? null] : [])]);

const solutions = new Map<string, Promise<{ solId: string } | { error: string }>>();
const nodes = new Map<string, any>();

/**
 * Which ACCOUNT minted each preflop solution. Same rule as the postflop chain
 * (services/gtowApi.ts): a cloud solve lives on the account that created it, so
 * every poll of it must carry that account's token. Keeping the owner here lets
 * `fetchNode(solId, line)` stay a two-argument call at all seven of its sites.
 */
const owners = new Map<string, GtowSessionId>();

/**
 * Every tree here is PREFLOP, which Brady routes to the Ultra account whatever
 * the table size (2026-09-21) — the Elite account is for heads-up POSTFLOP.
 * A tree with more than two seats is additionally MULTIWAY, which Elite's AI
 * refuses outright (`PREFLOP_MULTIWAY_NOT_ALLOWED`), so that one is a hard
 * filter rather than a preference. The pool is told both.
 */
/**
 * SOLVE THIS HAND'S TREE WITH EVERY SEAT'S SIZE MENU REPLACED, and read the node the hand's line ends on
 * (scripts/stackGapStudy, 2026-10-02). The live menus give hero a choice of sizes and every other seat a default plus
 * the size it used; a study of what ONE size costs needs the tree an HRC chart at that size is: a single open, a single
 * 3-bet, a single 4-bet for everyone. `posPatch` is laid over every position's size entry (bet_sizes / raise_sizes /
 * second_raise_sizes / third_plus_raise_sizes). The line is walked onto the tree's own sizes when they differ by a
 * rounding. Returns the solution id so the caller can read other nodes of the same tree.
 */
export async function solvePreflopWithMenus(hand: ParsedHand, heroPos: string | null, posPatch: Record<string, unknown>): Promise<
  { ok: true; solId: string; line: string; node: any; treeKey: string } | { ok: false; reason: string }
> {
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape) return { ok: false, reason: shape.error };
  const { tokens, levels } = lineOf(hand, shape);
  const m = menus(levels, shape.n);
  const body: any = treeBody(shape, m);
  for (const st of body.bet_sizes?.street_bet_sizes ?? []) st.position_bet_sizes = st.position_bet_sizes.map((x: any) => ({ ...x, ...posPatch }));
  const treeKey = `${treeKeyOf(shape, m)}|p${JSON.stringify(posPatch)}`;
  const sol = await ensureSolution(treeKey, body, { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: sol.error };
  let line = tokens.join("-");
  let node = await fetchNode(sol.solId, line);
  if ("error" in node && /NODE_DOES_NOT_EXIST/i.test(node.error)) {
    const fixed = await repairLine(sol.solId, tokens, { end: true });
    if ("error" in fixed) return { ok: false, reason: `line '${line}' is not in the tree — ${fixed.error}` };
    line = fixed.line;
    node = await fetchNode(sol.solId, line);
  }
  if ("error" in node) return { ok: false, reason: `node '${line || "root"}' — ${node.error}` };
  return { ok: true, solId: sol.solId, line, node: node.data, treeKey };
}

async function ensureSolution(key: string, body: any, need: GtowNeed = {}): Promise<{ solId: string } | { error: string }> {
  const hit = solutions.get(key);
  if (hit) return hit;
  // A TREE THE STORE HOLDS IS NOT CREATED AGAIN (services/gtowSolveCache): it is handed out as `gc:<key>` without a
  // request and its nodes are served from the store; a node the store lacks mints the solve once (materialisePre).
  const ck = solveCache.enabled ? cacheKeyOf("pre", body, { actions: "", board: "" }) : null;
  if (ck && solveCache.hasTree(ck.key)) {
    const p = Promise.resolve({ solId: storedSolId(ck.key) });
    solutions.set(key, p);
    if (solutions.size > 200) solutions.delete(solutions.keys().next().value as string);
    return p;
  }
  const p = (async () => {
    const made = await postPreflopSolution(body, need, { actions: "", board: "" });
    // a fresh solve: every node reply it gives is stored under the tree's key (the row goes in with the first)
    if ("solId" in made && ck) {
      solveCache.noteTree(ck.key, "pre", ck.body);
      notePreKey(made.solId, ck.key);
    }
    return made;
  })();
  solutions.set(key, p);
  p.then((r) => { if ("error" in r) solutions.delete(key); }).catch(() => solutions.delete(key));
  if (solutions.size > 200) solutions.delete(solutions.keys().next().value as string);
  return p;
}

/** POST a preflop tree and its solution on the first account routing allows (the network half of ensureSolution, and
 *  what materialising a stored tree sends — the body exactly as stored). Records the owner. */
async function postPreflopSolution(body: any, need: GtowNeed, solution: { actions: string; board: string }, locks: readonly any[] = []): Promise<{ solId: string } | { error: string }> {
  // A recorded wall is a guess; when it leaves nothing routable, try the
  // walled sessions anyway rather than refusing the spot (see gtowApi).
  const ids = gtowSessions.route(need);
  const candidates = ids.length ? ids : gtowSessions.routeIgnoringBlocks(need);
  if (!candidates.length) {
    return { error: need.multiway
      ? "no GTO Wizard session can solve a multiway preflop tree (the Ultra account is down or out of allowance)"
      : "no GTO Wizard token (no session attached)" };
  }
  let last = "no GTO Wizard token";
  for (const id of candidates) {
    const token = await gtowSessions.tokenFor(id);
    if (!token) { last = `${id}: no token`; continue; }
    const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const tr = await gtowRequests.fetch(id, "tree", `${API_BASE}/v4/custom-solutions/custom-trees/`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!tr.ok) {
      const b = (await tr.text().catch(() => "")).slice(0, 200);
      gtowSessions.noteFailure(id, tr.status, b, need);
      last = `custom-trees ${tr.status}: ${b}`;
      continue; // a refusal here is this ACCOUNT's, not the tree's — try the next
    }
    const tree = await tr.json();
    const so = await gtowRequests.fetch(id, "solution", `${API_BASE}/v4/custom-solutions/`, { method: "POST", headers: H, body: JSON.stringify({ custom_tree_id: tree.id, actions: solution.actions, board: solution.board }), signal: AbortSignal.timeout(20_000) });
    if (!so.ok) {
      const b = (await so.text().catch(() => "")).slice(0, 200);
      gtowSessions.noteFailure(id, so.status, b, need);
      last = `custom-solutions ${so.status}: ${b}`;
      continue;
    }
    const sol = await so.json();
    let solId = String(sol.id);
    // A LOCKED SOLVE IS A CHAIN (services/gtowSolveCache PostedTree.locks): each lock forks the solution before it, on
    // the same account. A lock refused is a fact about the lock, not the account: no other account is tried.
    for (const lock of locks) {
      const lk = await postLock(id, token, solId, lock);
      if ("error" in lk) return lk;
      solId = lk.solId;
    }
    owners.set(solId, id);
    if (owners.size > 400) owners.delete(owners.keys().next().value as string);
    gtowSessions.noteSuccess(id, { tree: true });
    return { solId };
  }
  return { error: last };
}

/** One NODE LOCK as GTO Wizard's own nodelock dialog sends it (scripts/_probePreflopNodeLock.ts): the locked node's line,
 *  each action's per-combo frequency, which combos are held, and which earlier nodes on the street are frozen with it
 *  (street_all: every one — probed 2026-10-04, scripts/_probeNodeLockStageA.ts `prev`; last_node: none, they re-solve;
 *  street_current_player: the locked player's own). */
export interface NodeLock {
  action_history: string[];
  strategy: { action: string; strategy: number[] }[];
  hands_locked: boolean[];
  previous_nodes_lock_type: "street_all" | "last_node" | "street_current_player";
}

/** One lock on the parent's account: POST /v4/custom-solutions/ {parent_solution_id, last_node_lock} → the child. */
async function postLock(session: GtowSessionId, token: string, parent: string, lock: unknown): Promise<{ solId: string } | { error: string }> {
  const r = await gtowRequests.fetch(session, "solution", `${API_BASE}/v4/custom-solutions/`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ parent_solution_id: parent, last_node_lock: lock }), signal: AbortSignal.timeout(20_000),
  });
  const t = await r.text().catch(() => "");
  if (!r.ok) {
    gtowSessions.noteFailure(session, r.status, t.slice(0, 200), { preflop: true });
    return { error: `node lock ${r.status}: ${t.slice(0, 200)}` };
  }
  try { const j = JSON.parse(t); if (j?.id) return { solId: String(j.id) }; } catch { /* below */ }
  return { error: `node lock: no solution id in the reply (${t.slice(0, 120)})` };
}

const lockedSolutions = new Map<string, Promise<{ solId: string } | { error: string }>>();
/**
 * A NODE-LOCKED SOLUTION of `body`, already solved as `parentSolId`: every lock applied in turn, each forked from the one
 * before. The solve cache keys it on the tree + every lock body (gtowSolveCache PostedTree.locks): a chain it holds is
 * handed out as `gc:<key>` without a request, and a node it lacks re-POSTs tree, solution and locks (materialisePre).
 * Otherwise the locks are POSTed on the parent's own account (a stored parent is materialised first).
 */
export async function lockedSolution(parentSolId: string, body: unknown, locks: readonly NodeLock[]): Promise<{ solId: string } | { error: string }> {
  const ck = cacheKeyOf("pre", body, { actions: "", board: "" }, locks);
  const memo = lockedSolutions.get(ck.key);
  if (memo) return memo;
  if (solveCache.enabled && solveCache.hasTree(ck.key)) return { solId: storedSolId(ck.key) };
  const p = (async (): Promise<{ solId: string } | { error: string }> => {
    let parent = parentSolId;
    if (isStoredSolId(parent)) {
      const m = await materialisePre(parent);
      if ("error" in m) return m;
      parent = m.solId;
    }
    const owner = owners.get(parent);
    if (!owner) return { error: "node lock: the account that owns the parent solution is not known" };
    const token = await gtowSessions.tokenFor(owner);
    if (!token) return { error: `node lock: no GTO Wizard token for ${owner}` };
    let solId = parent;
    for (const lock of locks) {
      const lk = await postLock(owner, token, solId, lock);
      if ("error" in lk) return lk;
      solId = lk.solId;
    }
    owners.set(solId, owner);
    if (solveCache.enabled) { solveCache.noteTree(ck.key, "pre", ck.body); notePreKey(solId, ck.key); }
    return { solId };
  })();
  lockedSolutions.set(ck.key, p);
  p.then((r) => { if ("error" in r) lockedSolutions.delete(ck.key); }).catch(() => lockedSolutions.delete(ck.key));
  if (lockedSolutions.size > 200) lockedSolutions.delete(lockedSolutions.keys().next().value as string);
  return p;
}

// ── the persistent solve cache's preflop half (services/gtowSolveCache) ───────────────────────────────────────────
/** the cache this piece reads and writes — the process's own; tests hand it theirs (setPreflopSolveCache) */
let solveCache: GtowSolveCache = gtowSolveCache;
/** real solution id → its cache key: every reply polled from it is stored under that key */
const preKeys = new Map<string, string>();
/** stored trees minted in this process: synthetic id → the real solve every read of it polls */
const preRealOf = new Map<string, string>();
/** the one in-flight materialisation per synthetic id (concurrent misses join it) */
const preMat = new Map<string, Promise<{ solId: string } | { error: string }>>();

function notePreKey(solId: string, key: string): void {
  preKeys.set(solId, key);
  if (preKeys.size > 400) preKeys.delete(preKeys.keys().next().value as string);
}
/** The cache key a solution id answers for: a synthetic id carries it, a real one this process created maps to it. */
const preKeyOfSol = (solId: string): string | null => (isStoredSolId(solId) ? keyOfStoredSolId(solId) : preKeys.get(solId) ?? null);

/**
 * MATERIALISE A STORED PREFLOP TREE: a node the store does not hold needs a real solve, so the tree and its solution are
 * POSTed from the stored body — exactly what was POSTed the first time — through the normal preflop routing (Ultra
 * first; more than two seats is multiway), once however many reads miss together. The account that mints it owns it.
 */
function materialisePre(gcId: string): Promise<{ solId: string } | { error: string }> {
  const have = preRealOf.get(gcId);
  if (have) return Promise.resolve({ solId: have });
  const pending = preMat.get(gcId);
  if (pending) return pending;
  const key = keyOfStoredSolId(gcId);
  const p = (async (): Promise<{ solId: string } | { error: string }> => {
    const stored = solveCache.treeBody(key);
    if (!stored || stored.kind !== "pre") return { error: `the solve cache no longer holds preflop tree ${key.slice(0, 8)} — ask again to solve it afresh` };
    const seats = Array.isArray(stored.tree?.players) ? stored.tree.players.length : 2;
    const made = await postPreflopSolution(stored.tree, { multiway: seats > 2, preflop: true }, stored.solution, stored.locks ?? []);
    if ("error" in made) return made;
    preRealOf.set(gcId, made.solId);
    if (preRealOf.size > 400) preRealOf.delete(preRealOf.keys().next().value as string);
    notePreKey(made.solId, key);
    const owner = owners.get(made.solId);
    if (owner) owners.set(gcId, owner);
    solveCache.noteMaterialised(key);
    return made;
  })().finally(() => preMat.delete(gcId));
  preMat.set(gcId, p);
  return p;
}

/** Tests: point this piece at their own solve cache (null = the process's). */
export function setPreflopSolveCache(c: GtowSolveCache | null): void {
  solveCache = c ?? gtowSolveCache;
}
/** Tests: forget every in-process solution, node and verdict — what an API restart does. */
export function resetAiPreflopMemory(): void {
  solutions.clear(); nodes.clear(); owners.clear(); terminals.clear(); lockedSolutions.clear();
  preKeys.clear(); preRealOf.clear(); preMat.clear();
}

/**
 * Lines the cloud answered with NO DECISION NODE (PF-15). A still-solving spot comes back 204 (or 404 before the
 * solution exists); a solved spot with nobody left to act — a line padded past a terminal, everyone folded to
 * the blinds' end, hero folded — comes back 200 with a body that has no action_solutions. That body used to be
 * read as "not ready" and polled for the whole NODE_TIMEOUT_MS: hand 4919910775 (dbId 716, HJ first in at a
 * 5-seat table, line 'F-F-F-F-X') burned 33.6 / 31.3 / 31.4 s on three ticks, 2026-09-22 19:56, and the poller's
 * REPEAT_FAIL_LIMIT of 3 made that ~95 s of silence. Two such polls now settle it, and the verdict is kept here so
 * the re-asks the poller makes before it rests the spot cost nothing.
 */
const terminals = new Set<string>();
const TERMINAL_POLLS = 2;

const rememberTerminal = (k: string) => {
  terminals.add(k);
  if (terminals.size > 2000) terminals.delete(terminals.values().next().value as string);
};

type NodeRead = { data: any; cached: boolean; stored?: boolean } | { error: string };
export interface FetchNodeOpts {
  /** ONE LOOK, NO WAITING (the prefix prefetch, 2026-10-01): a single request; a node the cloud has not solved yet, a
   *  404, a network error come back as an error at once and record NOTHING (no terminal, no store) \— the walk that
   *  follows reads for real. A stored tree this process has not materialised is left alone (a speculative read never
   *  mints a solve). A refusal of the LINE (400/422) is a fact about the tree and is kept, as always. */
  once?: boolean;
  /** The caller no longer wants this read (the walk showed the tree names the line differently): the poll loop ends at
   *  its next turn instead of asking for a node that is not there until NODE_TIMEOUT_MS runs out. */
  stop?: () => boolean;
}
/** the one in-flight read per node, however many ask \— the prefetch and the walk share it (2026-10-01) */
const pendingNodes = new Map<string, { p: Promise<NodeRead>; once: boolean }>();

export async function fetchNode(solId: string, line: string, opts: FetchNodeOpts = {}): Promise<NodeRead> {
  const k = `${solId}|${line}`;
  const hit = nodes.get(k);
  if (hit) return { data: hit, cached: true };
  const terminalError = `line ends the hand at '${line || "root"}' — no decision node`;
  if (terminals.has(k)) return { error: terminalError };
  // THE PERSISTENT STORE, before any request (services/gtowSolveCache): the node as GTO Wizard sent it, or its verdict
  // on the line \— no decision node (a terminal), or its refusal (NODE_DOES_NOT_EXIST / VALIDATION_ERROR), which the
  // callers read exactly as they read a live one
  const ck = solveCache.enabled ? preKeyOfSol(solId) : null;
  const addr = nodeAddr({ preflop: line });
  if (ck) {
    const s = solveCache.getNode(ck, addr);
    if (s?.status === NODE_OK) {
      nodes.set(k, s.data);
      if (nodes.size > 2000) nodes.delete(nodes.keys().next().value as string);
      return { data: s.data, cached: true, stored: true };
    }
    if (s?.status === NO_NODE) { rememberTerminal(k); return { error: terminalError }; }
    if (s) return { error: `${-s.status}: ${(s.text ?? "").slice(0, 160)}` };
  }
  // ONE REQUEST PER NODE, HOWEVER MANY ASK (2026-10-01, hand 145539300369: the flop's arrival walk read seven prefix
  // nodes one after another, 0.6-1.6 s each \— 9.5 s before the flop tree was even asked for). The prefixes are now
  // asked for together (prefetchPrefixes) and the walk that follows JOINS each read instead of sending its own; a
  // speculative look that found nothing hands over to the real read.
  const once = !!opts.once;
  const pending = pendingNodes.get(k);
  if (pending) {
    const r = await pending.p;
    if (!("error" in r) || once || !pending.once) return r;
  }
  const p = readNode(solId, k, line, addr, ck, terminalError, once, opts.stop);
  pendingNodes.set(k, { p, once });
  try { return await p; } finally { if (pendingNodes.get(k)?.p === p) pendingNodes.delete(k); }
}

/**
 * THE PREFIX PREFETCH (2026-10-01): every node a line walk will read \— root, the first token's node, the first two's,
 * \u2026 \— asked for at once, from the RAW tokens (a size the tree snaps lands the later addresses on nodes that do not
 * exist; those single looks come back empty and the walk reads the snapped address itself). Fire and forget: the walk
 * joins each in-flight read (fetchNode). Off with GTOW_PREFETCH=0, as the chain's prefetch is.
 */
export function prefetchPrefixes(solId: string, tokens: string[], max = 12): void {
  if (process.env.GTOW_PREFETCH === "0") return;
  const n = Math.min(tokens.length, max);
  for (let k = 0; k < n; k++) void fetchNode(solId, tokens.slice(0, k).join("-"), { once: true }).catch(() => undefined);
}

/** The network half of fetchNode: poll one node until it is solved (or `once`: look once). */
async function readNode(solId: string, k: string, line: string, addr: string, ck: string | null, terminalError: string, once: boolean,
    stop?: () => boolean): Promise<NodeRead> {
  // a stored tree with a node the store lacks: its solve is created now (once, however many ask), then polled
  let real = solId;
  if (isStoredSolId(solId)) {
    if (once && !preRealOf.has(solId)) return { error: "stored tree not materialised \— a speculative read does not mint a solve" };
    const m = await materialisePre(solId);
    if ("error" in m) return m;
    real = m.solId;
  }
  const t0 = Date.now();
  // WHAT EVERY POLL SAID, FOR THE REASON WHEN THE NODE NEVER COMES (2026-10-02, hand 4922086187). The reason used to be
  // the last FAILURE alone: one request timed out, eleven more answered "not solved yet", and the answer said "poll
  // failed: The operation timed out" — a network fault that was not one (the node was not in the tree).
  let notSolved = 0, failed = 0, lastFail = "";
  let emptyPolls = 0;
  let refreshed = false;
  const owner = owners.get(real) ?? null;
  const limit = nodeTimeoutMs();
  while (Date.now() - t0 < limit) {
    if (stop?.()) return { error: "read abandoned — the tree names this line differently" };
    const token = owner ? await gtowSessions.tokenFor(owner) : (await gtowSessions.bestToken({ preflop: true }))?.token ?? null;
    if (!token) return { error: `no GTO Wizard token for the session that owns this solve${owner ? ` (${owner})` : ""}` };
    const params = new URLSearchParams({ custom_solution_id: real, preflop_actions: line, flop_actions: "", turn_actions: "", river_actions: "", board: "" });
    let r: Response;
    try { r = await gtowRequests.fetch(owner, "poll", `${API_BASE}/v4/solutions/spot-solution/?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }); }
    catch (e) { failed++; lastFail = `poll failed: ${e instanceof Error ? e.message : e}`; if (once) return { error: lastFail }; await new Promise((res) => setTimeout(res, POLL_MS)); continue; }
    // THE SAME THREE RULES AS gtowApi's node poll (2026-09-25 audit): this copy re-polled an expired token for the whole
    // NODE_TIMEOUT_MS (a lost preflop answer), never told the pool about a wall it hit, and sat out a 429 quota wall
    if (r.status === 401 && !refreshed) {
      refreshed = true;
      if (owner) await gtowSessions.tokenFor(owner, true); else await gtowSessions.forceRefresh();
      continue;
    }
    if (r.ok && r.status !== 204) {
      // read as text, then parsed: the store keeps the reply exactly as GTO Wizard sent it
      const text = await r.text().catch(() => "");
      let j: any = null;
      try { j = text ? JSON.parse(text) : null; } catch { j = null; }
      if (j?.action_solutions?.length) {
        nodes.set(k, j);
        if (nodes.size > 2000) nodes.delete(nodes.keys().next().value as string);
        if (ck) solveCache.putNode(ck, addr, NODE_OK, text);
        return { data: j, cached: false };
      }
      // a 200 with an object body and no action to offer: the spot is solved and nobody is on the clock
      if (once) return { error: "not solved yet (one look)" };
      if (j != null && typeof j === "object" && ++emptyPolls >= TERMINAL_POLLS) {
        rememberTerminal(k);
        if (ck) solveCache.putNode(ck, addr, NO_NODE, null);
        return { error: terminalError };
      }
    } else if (!r.ok && r.status !== 404) {
      const t = await r.text().catch(() => "");
      if (r.status === 400 || r.status === 422) {
        // GTO Wizard's refusal of the LINE is a fact about this tree: kept (putNode keeps only the verdict bodies)
        if (ck) solveCache.putNode(ck, addr, -r.status, t);
        return { error: `${r.status}: ${t.slice(0, 160)}` };
      }
      failed++; lastFail = `spot-solution ${r.status}: ${t.slice(0, 120)}`;
      if (owner) gtowSessions.noteFailure(owner, r.status, t.slice(0, 200), { preflop: true });   // the NEXT tree goes elsewhere
      if (r.status === 429 || (r.status === 403 && /limit|quota|exceed/i.test(t))) return { error: lastFail };   // a quota wall will not lift while we wait
    } else if (r.status === 204 || r.status === 404) notSolved++;
    if (once) return { error: r.status === 404 ? "no such node (one look)" : lastFail || "the cloud did not return the node in time" };
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  // ("did not return the node in time" is what answerLog's failKind reads)
  return { error: `the cloud did not return the node in time — ${Math.round((Date.now() - t0) / 1000)} s, ` +
    `${notSolved} poll(s) answered "not solved yet"` + (failed ? `, ${failed} failed (last: ${lastFail})` : "") +
    (notSolved > failed ? ` (a node the tree does not hold is answered "not solved yet" too)` : "") };
}

const heroClass = (cards: string[]): string | null => {
  if (cards.length !== 2) return null;
  const R = "23456789TJQKA";
  const [a, b] = cards.map((c) => c[0]!.toUpperCase());
  const [sa, sb] = cards.map((c) => c[1]!.toLowerCase());
  const hi = R.indexOf(a!) >= R.indexOf(b!) ? a : b, lo = hi === a ? b : a;
  return a === b ? `${a}${b}` : `${hi}${lo}${sa === sb ? "s" : "o"}`;
};

/** An API action into our action label ("Fold", "Call", "Check", "Raise 2.5", "All-in"). The API's action
 *  carries `type` (FOLD / CALL / CHECK / RAISE), `betsize` (the seat's total in bb, a string), `allin`, and
 *  `code` (F / C / X / R<bb> — the same token the walk uses). */
/**
 * Which offered action a line token means, at one node.
 *
 * Tokens are OUR reading of the table ("R14.4"); the tree's actions are ITS OWN grid.
 * A raise matches by nearest size, because the two only ever agree by luck — see
 * repairLine.
 */
export function matchToken(tok: string, sols: any[]): { code: string; betsize: number | null } | null {
  const of = (a: any) => ({
    code: String(a?.action?.code ?? ""),
    type: String(a?.action?.type ?? a?.action?.display_name ?? "").toUpperCase(),
    bb: Number(a?.action?.betsize),
  });
  const all = sols.map(of).filter((a) => a.code);
  const exact = all.find((a) => a.code === tok);
  if (exact) return { code: exact.code, betsize: Number.isFinite(exact.bb) ? exact.bb : null };
  const want = /^R([\d.]+)$/.exec(tok);
  if (want) {
    const target = parseFloat(want[1]!);
    const raises = all.filter((a) => (a.type.startsWith("RAISE") || a.type.startsWith("BET")) && Number.isFinite(a.bb));
    if (!raises.length) return null;
    const best = raises.reduce((b, a) => (Math.abs(a.bb - target) < Math.abs(b.bb - target) ? a : b));
    return { code: best.code, betsize: best.bb };
  }
  const kind = tok === "F" ? "FOLD" : tok === "C" ? "CALL" : tok === "X" ? "CHECK" : null;
  const hit = kind ? all.find((a) => a.type.startsWith(kind)) : null;
  return hit ? { code: hit.code, betsize: null } : null;
}

/**
 * The exact node path for a line the tree would otherwise reject.
 *
 * THE MENU CANNOT GUARANTEE THE NODE (2026-09-19, hand 4919236052). menus() adds every
 * size the line contains, but as a ROUNDED multiplier of the level below it — and the
 * villain's own click is under no obligation to be a round multiple of anything. A 4-bet
 * to 14.4 over a 9.2 three-bet is 1.5652x, which the menu stores as a rounded ratio, so
 * the tree holds a node a few hundredths of a blind away and the walk asks for one that
 * does not exist. GTO Wizard answers NODE_DOES_NOT_EXIST, the 6-max charts had already
 * declined (that is why we are here at all), and the hand gets no answer on any street —
 * twenty-one of them in that hand, because the postflop chain reads its arrival ranges
 * from this same node.
 *
 * So the line is WALKED instead of assumed: each token is matched against the actions
 * the tree actually offers at that point and replaced by the one it means, nearest size
 * for a raise. This is what the postflop chain already does (snapPostflopStreets,
 * matchActionLoose); preflop was the half that trusted its own arithmetic.
 *
 * Every prefix visited is cached by fetchNode, so the probe that pays for the walk is
 * the one that failed — the next tick's re-ask lands on cached nodes and answers at once.
 *
 * THE WALK READS EACH RUN TOGETHER (2026-10-01). It read one node, matched one token, read the next: 5-7 reads of
 * 0.6-1.7 s each, 4-7 s of a 9-15 s answer (hand 4921861748: 12.8 s, 5.1 s of it this walk), while the same nodes
 * asked for together come back in under a second. Only a raise can be renamed by the tree (nearest size) — a fold,
 * a call, a check keeps its code — so from any point every address up to the next raise is already known, and
 * prefetchRun asks for those at once; the walk joins each read (fetchNode). The same nodes, the same matches, the same
 * line: a walk with two raises is three rounds of reads instead of seven. `end` also reads the node the whole line
 * ends on (hero's), when no raise stands before it — for the caller that reads it on this same tree next.
 */
const isRaiseToken = (tok: string) => /^R/i.test(tok);

function prefetchRun(solId: string, done: string[], rest: string[], end: boolean): void {
  if (process.env.GTOW_PREFETCH === "0") return;
  const raise = rest.findIndex(isRaiseToken);
  // node k is where rest[k] is matched (k = rest.length: where the line ends); node 0 is the walk's own next read
  const last = raise >= 0 ? raise : end ? rest.length : rest.length - 1;
  for (let k = 1; k <= last; k++) void fetchNode(solId, [...done, ...rest.slice(0, k)].join("-"), { once: true }).catch(() => undefined);
}

async function repairLine(solId: string, tokens: string[], opts: { end?: boolean } = {}): Promise<{ line: string; changed: string[] } | { error: string }> {
  const out: string[] = [];
  const changed: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // a new run starts at the root and after every token the tree was free to rename: a raise, or one it did rename
    if (i === 0 || isRaiseToken(tokens[i - 1]!) || out[i - 1] !== tokens[i - 1]) prefetchRun(solId, out, tokens.slice(i), !!opts.end);
    const at = out.join("-");
    const node = await fetchNode(solId, at);
    if ("error" in node) return { error: `walking '${at || "root"}': ${node.error}` };
    const sols = (node.data?.action_solutions as any[]) ?? [];
    const pick = matchToken(tok, sols);
    if (!pick) {
      const offered = sols.map((a) => String(a?.action?.code ?? "?")).join(", ");
      return { error: `'${tok}' is not offered at '${at || "root"}' (offered: ${offered})` };
    }
    if (pick.code !== tok) changed.push(`${tok}→${pick.code}`);
    out.push(pick.code);
  }
  return { line: out.join("-"), changed };
}

/**
 * THE LINE FIT, ON THIS TREE TOO (2026-09-22, Brady). GTO Wizard's engine holds ONE limper (plus the SB completing),
 * so a second limp is "not offered" and the whole spot went unanswered — including a named 4-bet in a limped pot that
 * no chart of ours holds either (the esoteric stress run's eso-14). Same rule as the charts (utils/fitLine): fold the
 * earliest plain limper or caller who is not hero and does not raise later, drop his later actions, walk again.
 * Returns the walked line and who was folded, or null when no fold makes it walkable.
 * Since 2026-10-04 this ONE fit serves the per-seat range walks and the line view only; hero's own decision reads
 * every fit (fitAiLines) and blends them.
 */
async function fitAiLine(solId: string, tokens: string[], shape: AiPreflopShape, keep: string[] = [], maxFolds = 4, keepHero = true):
    Promise<{ line: string; changed: string[]; folds: string[]; tokens: string[] } | null> {
  const keepSet = new Set([keepHero ? shape.heroApiPos : null, ...keep].filter(Boolean).map((x) => x!.toUpperCase()));
  let cur = tokens.slice();
  const folds: string[] = [];
  for (let k = 0; k < maxFolds; k++) {
    const step = foldEarliestCaller(cur, { keep: keepSet, stack: shape.stacks, seats: shape.positions });
    if (!step) return null;
    cur = step.tokens;
    folds.push(step.fold.seat);
    const r = await repairLine(solId, cur);
    if (!("error" in r)) return { ...r, folds, tokens: cur };
    if (!/is not offered/.test(r.error)) return null;   // a real failure, not a cap — folding more will not help
  }
  return null;
}

/** A fit of a line: the tree's own codes for it, the sizes it renamed, the seats folded out, the tokens walked. */
type AiFit = { line: string; changed: string[]; folds: string[]; tokens: string[] };
/** at most this many fits are walked per fold count (each is node reads on the solved tree) */
const MAX_FITS = 6;

/**
 * EVERY FIT, NOT THE FIRST (2026-10-04, hand 4922379136). fitAiLine folds the EARLIEST caller and stops — usually the
 * cold-caller, the tightest range at the table and the one hero's answer depends on most (utils/fitBlend has the
 * numbers). Here each foldable caller is folded in turn (never hero, never a seat that raises later), and every line
 * the tree then holds comes back; only when no single fold fits are two folded, and so on. The fewest folds win: a
 * fit with two players removed is not read beside one with one removed. All on the SAME solved tree — the walks share
 * their prefix nodes, a fit costs the few nodes past its fold.
 */
async function fitAiLines(solId: string, tokens: string[], shape: AiPreflopShape, maxFolds = 4): Promise<AiFit[]> {
  const keep = new Set([shape.heroApiPos].filter(Boolean).map((x) => x!.toUpperCase()));
  const cands = foldableCallers(tokens, { keep, stack: shape.stacks, seats: shape.positions });
  const subsets = (k: number, from = 0): string[][] =>
    k === 0 ? [[]] : cands.slice(from).flatMap((c, i) => subsets(k - 1, from + i + 1).map((rest) => [c, ...rest]));
  for (let k = 1; k <= Math.min(maxFolds, cands.length); k++) {
    const tries = subsets(k).slice(0, MAX_FITS).map((folds) => ({ folds, cur: foldSeatsOut(tokens, folds, shape.stacks, shape.positions) }));
    const walked = await Promise.all(tries.map((t) => repairLine(solId, t.cur, { end: true })));
    const fits = walked.flatMap((r, i) => ("error" in r ? [] : [{ ...r, folds: tries[i]!.folds, tokens: tries[i]!.cur }]));
    if (fits.length) return fits;
    // a real failure (a node that cannot be read), not the tree's cap: folding more will not help
    if (!walked.some((r) => "error" in r && /is not offered/.test(r.error))) return [];
  }
  return [];
}

/**
 * EACH VILLAIN ACTION ON A FITTED LINE, AGAINST THE TREE'S OWN PLAY (2026-10-04, check #3 for preflop). The dead-money
 * tree answered hero at a node its own strategies never reach: the opener's raise was 0.06% of his range there. The
 * walk already read every prefix node; this reads them back (cached) and scores each villain action the way the
 * postflop chain does (services/offTree: under 1% of his range at the node and no hand above 2%). Preflop every seat
 * acts on its whole range the first time, and on what its earlier actions left after that.
 */
async function villainLinesOf(solId: string, codes: string[], shape: AiPreflopShape): Promise<PreflopVillainLine[]> {
  const out: PreflopVillainLine[] = [];
  const weights = new Map<string, number[]>();
  for (let k = 0; k < codes.length; k++) {
    const at = codes.slice(0, k).join("-");
    const node = await fetchNode(solId, at, { once: true });
    if ("error" in node) break;
    const sols: any[] = node.data?.action_solutions ?? [];
    const actor: string | null = node.data?.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
    const taken = sols.findIndex((a) => String(a?.action?.code ?? "") === codes[k]);
    if (!actor || taken < 0) break;
    const range = weights.get(actor) ?? new Array<number>(1326).fill(1);
    const f: number[] = sols[taken]?.strategy ?? [];
    if (actor !== shape.heroApiPos && codes[k] !== "F") {
      const st = offTreeStats(range, sols, taken);
      out.push({ seat: actor, code: codes[k]!, line: at, nodeFreq: st.nodeFreq, maxHand: st.maxHand, offTree: isOffTree(st) });
    }
    weights.set(actor, range.map((w, i) => w * (f[i] ?? 0)));
  }
  return out;
}

function labelOf(action: any): string {
  const type = String(action?.type ?? action?.display_name ?? "").toUpperCase();
  const bb = Number(action?.betsize);
  if (action?.allin === true) return "All-in";
  if (type.startsWith("FOLD")) return "Fold";
  if (type.startsWith("CHECK")) return "Check";
  if (type.startsWith("CALL")) return "Call";
  if (type.startsWith("RAISE") || type.startsWith("BET")) return Number.isFinite(bb) && bb > 0 ? `Raise ${Math.round(bb * 100) / 100}` : "Raise";
  return String(action?.code ?? type ?? "?");
}

/** a mix as PERCENT, rounded, the actions hero never takes left out (what the answer and its trail show) */
const pctMix = (mix: MixAction[]): MixAction[] => {
  const sum = mix.reduce((t, a) => t + (a.frequency > 0 ? a.frequency : 0), 0) || 1;
  return mix.map((a) => ({ action: a.action, frequency: Math.round((a.frequency / sum) * 10000) / 100 })).filter((a) => a.frequency > 0.05);
};
const mixText = (mix: MixAction[]): string => pctMix(mix).map((a) => `${a.action} ${a.frequency.toFixed(0)}%`).join(" / ") || "no action";

/** The answer's note for a fitted line. It keeps the registered opening (services/approximations `warn`). */
export function fitNote(fits: AiFitRead[], villainLines: PreflopVillainLine[]): string {
  const who = (f: AiFitRead) => f.folds.join(" and ");
  const off = villainLines.filter((l) => l.offTree);
  return `LINE FITTED TO THE TREE: GTO Wizard's tree takes three players to a flop at most, so it cannot hold every limper or caller of this line. ` +
    (fits.length > 1
      ? `Hero's node was read on ${fits.length} fits of it, each with one of them folded out (${fits.map((f) => `${who(f)} folded: ${mixText(f.actions)}`).join(" · ")}), ` +
        `and the mixes blended to the TIGHTEST: fold as often as the most folding fit, raise as often as the least raising one.`
      : `Hero's node was read with ${who(fits[0]!)}'s limp/call folded out (${mixText(fits[0]!.actions)}) — the only fit the tree holds.`) +
    ` Same tree, no dead money: every fit has one player fewer than the table and none of his chips, and still leans loose` +
    ` (measured 2026-10-04 one player down: 7% of hands continue that the true spot folds).` +
    (off.length ? ` OFF THE TREE'S PATH: ${off.map((l) => `${l.seat}'s ${l.code} at "${l.line || "root"}" is ${pctOf(l.nodeFreq)} of his range in this tree`).join("; ")} — the ranges behind it are the solver's model of a mistake.` : "");
}

/** how long an answer waits for check #3's node reads on an exact line (they are the walk's own, normally cached) */
const VILLAIN_LINES_MS = 1000;
/** The answer's note for the villain actions on an EXACT line (no fit): how often this tree's own villain takes each. */
export function exactLineNote(villainLines: PreflopVillainLine[]): string {
  const say = (l: PreflopVillainLine) => `${l.seat}'s ${l.code} at "${l.line || "root"}" is ${pctOf(l.nodeFreq)} of his range`;
  const off = villainLines.filter((l) => l.offTree);
  return off.length
    ? `OFF THE TREE'S PATH: ${off.map(say).join("; ")} in this tree — it all but never takes that action, so the ranges behind hero's node are the solver's model of a mistake, not the pool's.`
    : `In this tree ${villainLines.map(say).join("; ")}.`;
}

/**
 * Solve hero's preflop decision with GTO Wizard AI, from the table as it stands.
 * `why` is the reason the charts could not answer — it rides along in the note so the
 * answer trail says both what answered and why the primary piece did not.
 */
export async function solvePreflopGtowAi(hand: ParsedHand, heroPos: string | null, why: string,
    opts: { deadBb?: number; rakeSeats?: number; /** a last-resort call: the seats folded out of the reduced hand */ reduced?: { droppedPos: string[] } | null;
      /** true when the caller stopped waiting and another piece answered (the gap gate's time box): this answer must
       *  not become the hand's preflop pin — the flop resumes from the piece hero was actually told by */
      skipPin?: () => boolean;
      /** read each villain action on hero's EXACT line against the tree's own play (check #3) — asked for when the
       *  chart refused because it has no branch for a villain's limp or call (fastSolve, the fit rule) */
      villainLines?: boolean } = {}): Promise<AiPreflopOutcome> {
  const t0 = Date.now();
  const shape = shapeOf(hand, heroPos, opts.deadBb ?? 0, opts.rakeSeats);
  if ("error" in shape) return { ok: false, reason: `GTO Wizard AI preflop: ${shape.error}` };
  const { tokens, levels } = lineOf(hand, shape);
  const line = tokens.join("-");
  const m = menus(levels, shape.n);
  const key = treeKeyOf(shape, m);
  const sol = await ensureSolution(key, treeBody(shape, m), { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: `GTO Wizard AI preflop: ${sol.error}`, line };
  // the solution and the line hero's node was finally read on (sizes snapped to the tree's own; a fitted line is the
  // leading fit's, on this same solution) — what the preflop pin records for the flop to resume from
  const usedSol = sol.solId;
  let usedLine = line;
  // THE TREE IS ASKED WHAT IT CALLS THE LINE WHILE HERO'S NODE IS ASKED FOR BY THE NAME WE GAVE IT (2026-10-02, hand
  // 4922086187). The walk below used to start only when GTO Wizard REFUSED the address (NODE_DOES_NOT_EXIST) — and a
  // three-handed tree does not refuse a size it does not hold: it answers "not solved yet" until NODE_TIMEOUT_MS runs
  // out (30 s of hero's clock, then the last resort). So the line is walked from the root beside the direct read, and
  // the walk is the judge: a raise the tree names differently, or an action it does not offer, means the address is
  // not a node — the direct read is dropped and the walk's line is read at once. An address the walk confirms costs
  // nothing: the direct read is the answer, and the prefix nodes the walk read are the ones the pin warms anyway.
  let node: NodeRead;
  {
    let abandon = false;
    const direct = fetchNode(sol.solId, line, { stop: () => abandon });
    // a fold is always on offer: only a line with a call, a check or a raise can miss the tree
    const walk = tokens.some((t) => t !== "F")
      ? repairLine(sol.solId, tokens, { end: true }).catch((e): { error: string } => ({ error: `walk threw: ${e instanceof Error ? e.message : e}` }))
      : null;
    const first = walk
      ? await Promise.race([direct.then((n) => ({ n, w: null })), walk.then((w) => ({ n: null, w }))])
      : { n: await direct, w: null };
    if (first.n) node = first.n;
    else {
      const w = first.w!;
      const renamed = !("error" in w) && w.changed.length > 0;
      const notOffered = "error" in w && /is not offered/.test(w.error);
      // an action the tree does not offer may be a line that cannot happen at all, and the cloud's own refusal says
      // which ("Incorrect actions" is a capture fault, final): it gets one poll's grace before the walk's word is taken
      const late = notOffered ? await Promise.race([direct, new Promise<null>((res) => setTimeout(() => res(null), POLL_MS))]) : null;
      if (late) node = late;
      else if (renamed || notOffered) {
        abandon = true;
        node = { error: `NODE_DOES_NOT_EXIST (read off the tree, not waited for: ${renamed ? (w as { changed: string[] }).changed.join(", ") : (w as { error: string }).error})` };
      } else node = await direct;
    }
  }
  let snapped: string[] = [];
  /** a fitted answer: every fit read (hero's mix on each), and the villain actions on their lines */
  let fitReads: (AiFitRead & { data: any })[] = [];
  let villainLines: PreflopVillainLine[] = [];
  const heroIdx = hand.heroCards.length === 2 ? comboIndex(hand.heroCards[0]!, hand.heroCards[1]!) : null;
  /** hero's own mix at a node, as fractions (labels as the answer uses them) */
  const mixAt = (data: any): MixAction[] => heroIdx == null ? []
    : ((data?.action_solutions as any[]) ?? []).map((a) => ({ action: labelOf(a.action), frequency: Number(a.strategy?.[heroIdx] ?? 0) }));
  // THE LINE ITSELF IS ILLEGAL (PF-26). NODE_DOES_NOT_EXIST means "a legal line, not under these sizes" and is
  // walked below; 400 VALIDATION_ERROR "Incorrect actions" means the sequence cannot happen in any tree — a
  // capture padded past a terminal or otherwise corrupt. Say so, as a capture fault, and let the caller stop:
  // walking it would fail the same way and the last resort would only re-solve the same corrupt line heads-up.
  // ONLY "Incorrect actions" IS ABOUT THE LINE (2026-10-03). GTO Wizard sends VALIDATION_ERROR for refusals of the TREE
  // too — "Preflop: Only effective stacks up to 250bb are supported" (session_20261003_153908), "Engine validation
  // failed" (a rake cap with too many decimals) — and reading those as a capture fault stopped fastSolve before the
  // last resort with a reason that blamed the reader. Any other VALIDATION_ERROR says what GTO Wizard itself said.
  if ("error" in node && /Incorrect actions/i.test(node.error)) {
    return { ok: false, kind: CAPTURE_FAULT, line,
      reason: `GTO Wizard AI preflop: the captured line '${line || "root"}' is not a legal betting sequence (VALIDATION_ERROR)` };
  }
  if ("error" in node && /VALIDATION_ERROR/i.test(node.error)) {
    return { ok: false, kind: TREE_REFUSED, line,
      reason: `GTO Wizard AI preflop: GTO Wizard refused the tree: ${refusalDetail(node.error)} (line '${line || "root"}')` };
  }
  if ("error" in node && /NODE_DOES_NOT_EXIST/i.test(node.error)) {
    // the tree has this line, just not under the sizes we named — walk it and find out
    let fixed: { line: string; changed: string[] } | { error: string } = await repairLine(sol.solId, tokens, { end: true });
    // THE LINE FIT: EVERY FIT, ON THIS TREE, NO DEAD MONEY (2026-10-04, hand 4922379136). The tree holds three players
    // to the flop: a second cold-caller or limper is "not offered". From 2026-09-23 the earliest such caller was folded
    // and the tree REBUILT with his chips as `pot` — and chips in the pot before the first action are an ante: every
    // seat plays another game from the root (UTG folds 61 / limps 39 / raises to 2bb 0.06% there, against 16.1% on this
    // tree), hero's node sat off that tree's path and his K7o read "Call 100%" facing an open and two callers. A
    // removed player loosens hero even WITHOUT his chips (utils/fitBlend: measured 7.0% of hands), so the chips are not
    // given back at all. Each foldable caller is folded in turn on the tree already solved, hero's node is read on
    // every line it holds, and the mixes are blended to the tightest (fold at the most folding fit's frequency, raise
    // at the least raising one's). A fit whose villains' actions the tree all but never takes is left out when another
    // is on its path. No second tree, no second solve.
    if ("error" in fixed && /is not offered/.test(fixed.error)) {
      const fits = await fitAiLines(sol.solId, tokens, shape);
      const reads = (await Promise.all(fits.map(async (fit) => {
        const n = await fetchNode(sol.solId, fit.line);
        if ("error" in n) return null;
        const toAct = n.data?.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
        if (shape.heroApiPos && toAct && toAct !== shape.heroApiPos) return null;
        const lines = await villainLinesOf(sol.solId, fit.line ? fit.line.split("-") : [], shape);
        return { fit, n, lines, offPath: lines.some((l) => l.offTree) };
      }))).filter((x): x is NonNullable<typeof x> => !!x);
      if (reads.length) {
        // an on-path fit is never blended with an off-path one; all off-path = all read, and check #3 says so
        const use = reads.some((r) => !r.offPath) ? reads.filter((r) => !r.offPath) : reads;
        // the fit hero's mix leans on most leads (the pin and the hand page show its node): the most folding one,
        // then the one that folds the LATER caller — it keeps the cold-caller, whose range constrains hero most
        const foldAt = (r: (typeof use)[number]) => mixAt(r.n.data).find((a) => /^fold/i.test(a.action))?.frequency ?? 0;
        const lastFold = (r: (typeof use)[number]) => Math.max(...r.fit.folds.map((f) => shape.positions.indexOf(f)));
        use.sort((a, b) => foldAt(b) - foldAt(a) || lastFold(b) - lastFold(a));
        fixed = use[0]!.fit;
        fitReads = use.map((r) => ({ folds: r.fit.folds, line: r.fit.line, actions: mixAt(r.n.data), offPath: r.offPath, data: r.n.data }));
        villainLines = use.flatMap((r) => r.lines);
      }
    }
    if ("error" in fixed) {
      return { ok: false, reason: `GTO Wizard AI preflop: node '${line || "root"}' does not exist and the line could not be walked — ${fixed.error}`, line };
    }
    snapped = fixed.changed;
    usedLine = fixed.line;
    // A TREE WHOSE LARGEST POST IS NOT 1 lists its played sizes through sizeTo; a node named otherwise is not the size
    // intended (the unit rule did not hold) — the tree is unusable, not answered from (none is built today)
    if (largestPostOf(shape) !== 1 && snapped.length) {
      return { ok: false, kind: TREE_REFUSED, line, reason: `GTO Wizard AI preflop: the tree named the line's sizes otherwise (${snapped.join(", ")}) — its largest post is ${largestPostOf(shape)}bb, so the sizes were not read as intended` };
    }
    node = await fetchNode(sol.solId, fixed.line);
    if ("error" in node) {
      return { ok: false, reason: `GTO Wizard AI preflop: node '${fixed.line || "root"}' (walked from '${line}') — ${node.error}`, line };
    }
  }
  if ("error" in node) return { ok: false, reason: `GTO Wizard AI preflop: node '${line || "root"}' — ${node.error}`, line };
  const j = node.data;
  const toAct = j.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
  if (shape.heroApiPos && toAct && toAct !== shape.heroApiPos) {
    return { ok: false, kind: LINE_NOT_HERO, reason: `GTO Wizard AI preflop: the walked line puts ${toAct} on the clock, not hero (${shape.heroApiPos}) — line '${line}' does not match the table`, line };
  }
  const idx = heroIdx;
  if (idx == null) return { ok: false, reason: "GTO Wizard AI preflop: hero's cards are not known", line };
  // CHECK #3 ON AN EXACT LINE (2026-10-04, the fit rule): the chart had no branch for a villain's limp or call and this
  // tree holds it — but it is an equilibrium solve too, and how often ITS villain takes that action says how much of
  // a model the ranges behind hero's node are (a 30bb UTG limp is rare here as well). Best effort: the prefix nodes
  // are the walk's own (cached, or in flight and joined), and the answer never waits more than VILLAIN_LINES_MS.
  if (opts.villainLines && !fitReads.length && usedLine) {
    villainLines = await Promise.race([
      villainLinesOf(usedSol, usedLine.split("-"), shape).catch((): PreflopVillainLine[] => []),
      new Promise<PreflopVillainLine[]>((res) => setTimeout(() => res([]), VILLAIN_LINES_MS)),
    ]);
  }
  // the node's per-combo strategy is a 0-1 fraction; our chart mixes are PERCENT (Q8o: {Fold: 99.97}), and
  // the panel text / hand card format them as such — so the fallback speaks percent too
  let actions = (j.action_solutions as any[]).map((a) => ({ action: labelOf(a.action), frequency: Number(a.strategy?.[idx] ?? 0) }));
  const sum = actions.reduce((s, a) => s + a.frequency, 0);
  if (sum <= 1.5) actions = actions.map((a) => ({ ...a, frequency: a.frequency * 100 }));
  // several fits: hero's mix is their blend to the tightest (utils/fitBlend), not the leading fit's own
  if (fitReads.length > 1) actions = blendFitMixes(fitReads.map((f) => f.actions));
  actions = actions.filter((a) => a.frequency > 0.05).map((a) => ({ ...a, frequency: Math.round(a.frequency * 100) / 100 }));
  const decision = actions.length ? pickWeightedAction(actions) : null;
  const secs = (Date.now() - t0) / 1000;
  // THE PIN (services/preflopPin): this tree, this line, hero to act — the flop resumes here. Every prefix node is
  // pre-fetched in the background so the resume finds them cached; the answer never waits for it.
  const codes = usedLine ? usedLine.split("-") : [];
  const handKey = preflopPinKey(hand);
  if (handKey && !opts.skipPin?.()) {
    const warm = Promise.allSettled(codes.map((_, k) => fetchNode(usedSol, codes.slice(0, k).join("-")))).then(() => undefined);
    setPreflopPin({
      piece: "gtow-ai-preflop", handKey, solId: usedSol, shape, codes, rawTokens: tokens, warm,
      id: `gtow-ai · ${shape.n}-handed · ${shape.positions.map((p) => `${p}:${shape.stacks[p]}`).join("/")}`,
      heroPos: heroPosOf(hand, heroPos) ?? "", reduced: opts.reduced ?? null, actionIndex: hand.actions.length, at: Date.now(),
    } satisfies AiPreflopPin, hand.heroCards.join(""));
  }
  const shapeText = `${shape.n}-handed · ${shape.positions.map((p) => `${p} ${shape.stacks[p]}bb`).join(", ")} · rake 5% cap ${shape.rakeCapBb}bb${shape.deadSb ? " · dead SB approximated" : ""}${shape.deadBb ? ` · ${shape.deadBb}bb dead money in the pot` : ""}`;
  // a node from the persistent solve cache says so: the hand page must tell a stored answer from a fresh solve
  const stored = !!node.stored;
  return {
    ok: true, actions, decision, line, pos: shape.heroApiPos, heroClass: heroClass(hand.heroCards), treeKey: key,
    solId: usedSol, usedLine, solveSecs: secs, cached: node.cached, ...(stored ? { stored: true } : {}), shape,
    ...(fitReads.length ? { fits: fitReads.map(({ data: _data, ...f }) => ({ ...f, actions: pctMix(f.actions) })), villainLines }
      : villainLines.length ? { villainLines } : {}),
    note: `GTO Wizard AI preflop (Ultra) answered because the 6-max charts could not: ${why}. Tree built from the table — ${shapeText}; solved in ${secs.toFixed(1)} s${stored ? " (from the GTO Wizard solve cache — no request)" : node.cached ? " (cached)" : ""}.`
      + (snapped.length ? ` Sizes snapped to the tree's own: ${snapped.join(", ")}.` : "")
      + (fitReads.length ? ` ${fitNote(fitReads, villainLines)}` : villainLines.length ? ` ${exactLineNote(villainLines)}` : "")
      + (shape.stackCap ? ` ${stackCapNote(shape)}.` : ""),
  };
}

/** Pre-build the tree + solution for a hand's shape (no node fetched) — called from the poller's tick so
 *  hero's turn only pays the node fetch. Silent on failure. */
export function warmPreflopGtowAi(hand: ParsedHand, heroPos: string | null): void {
  try {
    // ONLY WHILE HERO CAN STILL BE ASKED (PF-16, 2026-09-23). The postflop warm stops when hero folded or the hand
    // ended; this one did not, so on a thinned table every villain 3-bet/4-bet AFTER hero's fold changed the size
    // menu, the tree key and minted another Ultra solve — api.log showed ~5 trees built per AI-preflop answer
    // against a daily cap of 1,275 requests. A hand hero is out of has no decision left to warm for.
    if (hand.ended || (hand as { heroFolded?: boolean }).heroFolded) return;
    if (hand.actions.some((a) => a.hero && a.type === "fold")) return;
    const shape = shapeOf(hand, heroPos);
    if ("error" in shape) return;
    const { levels } = lineOf(hand, shape);
    const m = menus(levels, shape.n);
    const key = treeKeyOf(shape, m);
    if (solutions.has(key)) return;   // ensureSolution keeps the PENDING promise in this map too, so a 1 Hz tick during a build joins it
    const t0 = Date.now();
    void ensureSolution(key, treeBody(shape, m), { multiway: shape.n > 2, preflop: true }).then((r) => {
      if ("solId" in r) console.log(`[gtow-ai-preflop] warmed ${shape.n}-handed tree in ${Date.now() - t0} ms`);
    });
  } catch { /* a warm-up never fails anything */ }
}

// ---------------------------------------------------------------------------
// THE LAST RESORT (2026-09-23, Brady: "we need 100% coverage — anything reasonable"). A preflop line neither
// the charts nor the exact AI tree can walk — three limpers who all raise later, a 4-bet size the limp tree
// cannot snap, three cold-callers who then re-raise each other — is reduced to the one thing every such spot
// still has: HERO and the LAST AGGRESSOR, on a heads-up tree at the real sizes and stacks. What it loses: the
// folded players' ranges, anyone still to act behind hero, and both seats' own ranges (they play a heads-up
// blind's). That is an approximation, said out loud in the answer, and it beats a blank.
//
// NO DEAD MONEY (2026-10-04). Until then every chip the folded-out players had put in went into the tree's `pot`.
// GTO Wizard books `pot` as chips in the pot BEFORE the first action — an ante — so every seat plays another game
// from the root. Measured on the solve cache (116 preflop trees with `pot` > 0): a villain's first-in raise into
// dead money was under 1% of his range in 33 of 33 trees (median 0.10%; 16% on the same tree without it — he limps
// 45-61% instead), so hero's node sat off that tree's own path; and the chips were often a LIVE caller's (K5o jammed
// 97bb into a 3-bet and two cold-callers, hand 4920545432). scripts/lastResortStudy.ts reads both trees beside exact
// answers. The folded players' chips are now left out and the note names them: hero is priced tighter than the table.
//
// THE FORCED-BET TREE WAS TRIED AND IS NOT THE ANSWER (2026-10-04, scripts/_probeForcedDecision.ts): the last raise
// posted as a blind with the raiser's own range GIVEN to the tree. GTO Wizard ignores a seat's `range` on a preflop
// tree — three trees given premiums, nothing, and 72o alone came back identical to the cent — so hero would be read
// against any two cards; against exact answers it did worse than either heads-up tree.
//
// THE LOCKED TREE IS (2026-10-04, solveLockedLastResort below; utils/lockedHeadsUp): GTO Wizard's NODE LOCK — a new
// solution forked from a solved one with a seat's strategy at one node fixed — does impose a range on a preflop tree
// (scripts/_probePreflopNodeLock.ts: the next node reports exactly the locked range). So the last raise is an ACTION the
// raiser takes, locked to his range on the exact tree, and hero is read behind it, priced as at the table (the folded
// players' chips and a blind still to act are dead money there: with the raise locked they move nothing before hero's
// node — measured beside a no-dead-money copy). It is asked first; the plain heads-up tree below answers when it does
// not, within lockedDeadlineMs. Measured against exact answers in scripts/lastResortStudy.ts (its header).
//
// NOBODY HAS RAISED: the heads-up tree answers only for a hero in the blinds. From any other seat it hands him a
// small blind's opening range (74s opened under the gun, hand 4920544810): no answer there.
// ---------------------------------------------------------------------------
const ORBIT = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

export interface HeadsUpReduction { hand: ParsedHand; deadBb: number; aggressorPos: string; keptPos: [string, string]; droppedPos: string[]; heroPos: string }

/** Hero versus the last aggressor, the rest folded. `deadBb` is what the folded-out players had in: since 2026-10-04
 *  it is left OUT of the tree and only named in the note (the header). null when hero's seat is unknown. */
export function reduceToHeadsUp(hand: ParsedHand, heroPos: string | null): HeadsUpReduction | null {
  const hp = heroPosOf(hand, heroPos);
  if (!hp) return null;
  const posOf = (seat: number) => (seat === hand.heroSeatId ? hp : hand.positions[seat]?.toUpperCase()) ?? null;
  const pre = hand.actions.filter((a) => a.street === "preflop");
  const voluntary = (a: ParsedAction) => a.type !== "post-sb" && a.type !== "post-bb" && a.type !== "fold" && a.type !== "check";
  const seatOf = (a: ParsedAction) => (a.hero ? hand.heroSeatId : a.seatId);
  // the last aggressor: the last raise / bet / all-in by someone other than hero; else the last voluntary chip in
  const agg = [...pre].reverse().find((a) => seatOf(a) !== hand.heroSeatId && (a.type === "raise" || a.type === "bet" || a.type === "all-in"))
    ?? [...pre].reverse().find((a) => seatOf(a) !== hand.heroSeatId && voluntary(a));
  let aggSeat: number | null = agg ? seatOf(agg) : null;
  if (aggSeat == null) {
    // nobody put a chip in voluntarily: the big blind is the opponent (or the small blind when hero is the BB)
    const bbSeat = Object.entries(hand.positions).find(([, p]) => p.toUpperCase() === (hp === "BB" ? "SB" : "BB"))?.[0];
    if (bbSeat == null) return null;
    aggSeat = Number(bbSeat);
  }
  const aggPos = posOf(aggSeat);
  if (!aggPos || aggSeat === hand.heroSeatId) return null;
  // the two kept seats become the heads-up tree's SB (acts first) and BB, in orbit order
  const first = ORBIT.indexOf(hp) < ORBIT.indexOf(aggPos) ? hand.heroSeatId : aggSeat;
  const second = first === hand.heroSeatId ? aggSeat : hand.heroSeatId;
  const newPos: Record<number, string> = { [first]: "SB", [second]: "BB" };
  const kept = new Set([hand.heroSeatId, aggSeat]);
  // every chip anyone put in, from the posts and the actions (raise-to totals; calls add)
  const put: Record<number, number> = {};
  for (const a of pre) {
    const s = seatOf(a); const amt = putBb(hand, a);   // the NL5 test stake's 0.4bb SB post is the NL200 tree's 0.5 (PF-06)
    if (a.type === "post-sb" || a.type === "post-bb" || a.type === "raise" || a.type === "bet" || a.type === "all-in") put[s] = Math.max(put[s] ?? 0, amt);
    else if (a.type === "call") put[s] = (put[s] ?? 0) + amt;
  }
  const total = Object.values(put).reduce((x, y) => x + y, 0);
  // what the heads-up tree itself books for the kept two: a raise-to total, a limp (1bb), or just the tree's blind
  const treeContrib = (seat: number) => {
    const mine = pre.filter((a) => seatOf(a) === seat && voluntary(a));
    const lastRaise = [...mine].reverse().find((a) => a.type === "raise" || a.type === "bet" || a.type === "all-in");
    if (lastRaise) return lastRaise.amount ?? 0;
    if (mine.length) return 1;
    return newPos[seat] === "SB" ? 0.5 : 1;
  };
  const deadBb = Math.max(0, total - treeContrib(hand.heroSeatId) - treeContrib(aggSeat));
  const keptActs = pre.filter((a) => kept.has(seatOf(a)) && voluntary(a)).map((a) => ({ ...a, seatId: seatOf(a) }));
  // the tree's BB behind an unraised pot CHECKS — a limp recorded as a call at the table has no "C" node there
  // (eso-04: "C-C-R18" did not exist; the heads-up tree wants "C-X-R18")
  let raisedYet = false;
  for (const a of keptActs) {
    if (a.type === "raise" || a.type === "bet" || a.type === "all-in") raisedYet = true;
    else if (a.type === "call" && !raisedYet && a.seatId === second) { a.type = "check"; delete (a as any).amount; }
  }
  // A ROUND THAT CLOSED BEFORE THE FINAL RAISE (eso-04): "SB limps, BB checks" ends heads-up preflop, so the
  // aggressor's re-raise — legal at the table only because a folded-out player had raised — has no node. Collapse
  // everything before the aggressor's final raise into the blinds and the dead money: the line becomes one raise
  // to his real total, hero to act. His earlier chips are inside that total; hero's limp is the big blind.
  let closed = false, raised = false, broken = false;
  for (const a of keptActs) {
    if (closed) { broken = true; break; }
    if (a.type === "raise" || a.type === "bet" || a.type === "all-in") raised = true;
    else if (a.type === "check" && a.seatId === second && !raised) closed = true;
  }
  let lineActs = keptActs;
  if (broken) {
    const lastRaise = [...keptActs].reverse().find((a) => a.seatId === aggSeat && (a.type === "raise" || a.type === "bet" || a.type === "all-in"));
    lineActs = lastRaise ? [lastRaise] : keptActs;
  }
  const actions: ParsedAction[] = [
    { seatId: first, hero: first === hand.heroSeatId, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: second, hero: second === hand.heroSeatId, type: "post-bb", amount: 1, street: "preflop" },
    ...lineActs,
  ];
  const stacks: Record<number, number> = {};
  for (const s of kept) { const v = hand.stacks?.[s]; if (v != null) stacks[s] = v; }
  const committed: Record<number, number> = {};
  for (const s of kept) committed[s] = put[s] ?? 0;
  const reduced: ParsedHand = { ...hand, positions: newPos, actions, liveSeats: [first, second], stacks, committed };
  const dropped = Object.entries(hand.positions).filter(([s]) => !kept.has(Number(s))).map(([, p]) => p.toUpperCase());
  return { hand: reduced, deadBb, aggressorPos: aggPos, keptPos: [posOf(first)!, posOf(second)!], droppedPos: dropped, heroPos: hp };
}

/** What the last resort asks of the outside (a test replaces it). */
export const lastResortSeams = {
  headsUp: (hand: ParsedHand, heroPos: string | null, why: string, opts: NonNullable<Parameters<typeof solvePreflopGtowAi>[3]>): Promise<AiPreflopOutcome> =>
    solvePreflopGtowAi(hand, heroPos, why, opts),
  locked: (hand: ParsedHand, heroPos: string | null, why: string): Promise<AiPreflopOutcome> => solveLockedLastResort(hand, heroPos, why),
};

/** How long the LOCKED tree may take before the plain one answers (LAST_RESORT_LOCKED_MS; the tests shorten it). The
 *  whole last resort must fit hero's clock: a locked answer is a tree, a solution, one or two node reads, one or two
 *  locks and hero's node — 3-6 s measured; the plain tree is solved beside it from the start. */
const lockedDeadlineMs = (): number => { const v = Number(process.env.LAST_RESORT_LOCKED_MS); return v > 0 ? v : 10_000; };
/** THE LOCKED TREE IS ON (the owner's word, 2026-10-04, the evening it was merged: "let's turn on the node locked last
 *  resort"). It shipped off for some hours because a locked solve keeps its lock bodies in the GTO Wizard account's
 *  solution history and whether that shows on Fair Play could not be learned from public sources — a risk he took
 *  knowingly. THE OFF SWITCH: LAST_RESORT_LOCKED=off in config/local.env (read at every call) — the last resort is
 *  then the plain tree alone. */
export const lockedLastResortOn = (): boolean => !/^(off|0|false|no)$/i.test(process.env.LAST_RESORT_LOCKED?.trim() ?? "");

/**
 * The last resort answer. FIRST the LOCKED tree (2026-10-04, solveLockedLastResort): hero against the last raise, the
 * raiser's raise locked to his range on the exact tree — scripts/lastResortStudy.ts measured it against exact answers
 * (the header of that script). Within lockedDeadlineMs, else, or when it refuses, the PLAIN heads-up reduction — no dead
 * money (the header above) — which is started beside it from the first moment. With nobody having raised only a hero
 * in the blinds is answered, and only by the plain tree (there is no raise to lock). LAST_RESORT_LOCKED=off
 * (lockedLastResortOn) turns the locked tree off: plain only.
 *
 * THE PREFLOP PIN: a locked answer sets none (the flop reads its ranges the ordinary way — arrivalRangesGtowAi — not
 * from a tree where hero's range was every hand). The plain tree pins only when it is the answer: while the locked
 * tree is still out its pin is held back, and when it then becomes the answer it is read once more (from memory, no
 * request) to pin.
 */
export async function solvePreflopLastResort(hand: ParsedHand, heroPos: string | null, why: string): Promise<AiPreflopOutcome> {
  const red = reduceToHeadsUp(hand, heroPos);
  if (!red) return { ok: false, reason: "last resort: hero's seat or the opponent's could not be read" };
  // nobody has raised: only a hero in the blinds is answered heads-up (the header)
  const calls = allInCalls(hand.actions);
  const raised = hand.actions.some((a) => a.street === "preflop" && (a.type === "raise" || a.type === "bet" || (a.type === "all-in" && !calls.has(a))));
  if (!raised && red.heroPos !== "SB" && red.heroPos !== "BB") {
    return { ok: false, reason: `last resort: nobody has raised and hero (${red.heroPos}) is not in the blinds — the heads-up tree would give him a small blind's opening range from his seat, so there is no answer` };
  }
  const dealt = dealtCount(hand, heroPos);   // the players DEALT (a sitting-out label is not one — utils/dealtSeats)
  const tryLocked = raised && lockedLastResortOn();
  let lockedOut = tryLocked;                 // the locked tree is still being asked: the plain tree holds its pin back
  let plainPinSkipped = false;
  const plainOpts = (pinNow: boolean) => ({ deadBb: 0, rakeSeats: dealt, reduced: { droppedPos: red.droppedPos },
    ...(pinNow ? {} : { skipPin: () => { const skip = lockedOut; if (skip) plainPinSkipped = true; return skip; } }) });
  const plain = lastResortSeams.headsUp(red.hand, red.hand.positions[red.hand.heroSeatId] ?? null, why, plainOpts(false));
  plain.catch(() => undefined);
  let lockedWhy: string | null = null;
  if (tryLocked) {
    const ms = lockedDeadlineMs();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<AiPreflopOutcome>((res) => { timer = setTimeout(() => res({ ok: false, reason: `locked tree: no answer within ${ms / 1000} s` }), ms); });
    const locked = await Promise.race([
      lastResortSeams.locked(hand, heroPos, why).catch((e): AiPreflopOutcome => ({ ok: false, reason: `locked tree threw: ${e instanceof Error ? e.message : e}` })),
      late,
    ]);
    if (timer) clearTimeout(timer);
    if (locked.ok) return locked;
    lockedWhy = locked.reason;
    lockedOut = false;
  }
  let r = await plain;
  // the plain tree answered while the locked one was still out, so it did not pin: it is the answer now — pin it
  if (r.ok && plainPinSkipped) r = await lastResortSeams.headsUp(red.hand, red.hand.positions[red.hand.heroSeatId] ?? null, why, plainOpts(true));
  if (!r.ok) {
    return { ok: false, kind: r.kind, reason: `last resort (hero vs ${red.aggressorPos}, ${red.droppedPos.join("/") || "nobody"} folded out): ${r.reason}` +
      (lockedWhy ? `; before it, ${lockedWhy}` : "") };
  }
  const left = Math.round(red.deadBb * 100) / 100;
  const note = `LAST RESORT — no tree holds this line, so it is played as hero (${red.heroPos}) against the last aggressor (${red.aggressorPos}) alone on a heads-up tree: ` +
    `${red.droppedPos.length ? `${red.droppedPos.join(", ")} folded out` + (left > 0 ? ` and NONE of the ${left}bb they put in is in the tree's pot (chips there before the first action are an ante and move every range — hero is priced tighter than the table)` : "") : "nobody else in the pot"}; ` +
    `both seats play a heads-up blind's range, and the folded players' ranges and anyone still to act behind hero are not modelled.` +
    (lockedWhy ? ` The locked tree (the raiser's range imposed) did not answer: ${lockedWhy.replace(/^locked tree:\s*/, "")}.` : "") + ` ` + r.note;
  return { ...r, pos: red.heroPos, note, lastResort: { how: `hero (${red.heroPos}) vs ${red.aggressorPos} heads-up, ${red.droppedPos.join("/") || "nobody"} folded out, no dead money` +
    (lockedWhy ? " (plain tree: the locked one did not answer)" : "") } };
}

// ---------------------------------------------------------------------------
// THE LOCKED LAST RESORT (2026-10-04) — hero against the last raise on a heads-up tree where the raise is an ACTION
// the raiser takes, NODE-LOCKED to his range as the exact tree plays it up to that raise. The plan (seating, posts,
// the pot, units) is utils/lockedHeadsUp; the lock request is scripts/_probePreflopNodeLock.ts. Why: GTO Wizard
// ignores `players[].range` on a preflop tree, so every heads-up reduction before this read the raiser as a heads-up
// blind (the plain tree) or as any two cards (a forced bet) — a lock is the one input that holds.
// ---------------------------------------------------------------------------

/** the size menu of raise level `lv` of the table's line (1 = the open) */
const defaultsAt = (lv: number): string[] => (lv <= 1 ? OPENS : lv === 2 ? THREE_BETS : lv === 3 ? FOUR_BETS : FIVE_PLUS);

/** The locked heads-up tree's body: the plan's posts, stacks and pot; the raiser's first raise is the table's raise,
 *  listed alone (beside his all-in); hero's re-raise and everything after it use the menus of the table's next levels. */
export function lockedTreeBody(plan: LockedPlan, rake: Pick<AiPreflopShape, "rakeCapBb" | "siteRake">) {
  // every amount through sizeTo (N × the largest post: hero's, never under 1 — utils/lockedHeadsUp); an all-in is the
  // deeper stack (a size past a seat's stack IS its all-in)
  const allIn = sizeTo(Math.max(plan.stacks.SB, plan.stacks.BB), plan.unit);
  const raiseList = lockedRaiseIsAllIn(plan) ? [allIn] : [sizeTo(plan.raiseToTree, plan.unit), allIn];
  const entry = (t: TreeSeat) => {
    const raiser = t === plan.raiserTree;
    const later = [...defaultsAt(plan.raiseLevel + (raiser ? 2 : 1)), allIn];
    return { position: t, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true,
      bet_sizes: raiser ? raiseList : [], raise_sizes: raiser ? raiseList : later, second_raise_sizes: later, third_plus_raise_sizes: later };
  };
  return {
    starting_street: "PREFLOP", pot: plan.pot, ante: null, ante_distribution_method: "PER_PLAYER", max_allowed_limps: null,
    bet_sizes: { ...TREE_SETTINGS, max_num_raises: 5, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: (["SB", "BB"] as TreeSeat[]).map(entry) }] },
    players: (["SB", "BB"] as TreeSeat[]).map((t) => ({
      position: t, display_position: t, blind: plan.posts[t], range: null, stack: plan.stacks[t], tournament_instant_bounty: null, tournament_total_bounty: null,
    })),
    tree_operations: [], resolving_policy: null,
    rake: rake.siteRake
      ? { pct_of_pot: rake.siteRake.pct, cap_in_chips: rake.siteRake.capBb, preflop_rake_type: rake.siteRake.preflopType }
      : { pct_of_pot: 5, cap_in_chips: rake.rakeCapBb, preflop_rake_type: "no_flop_no_drop" },
    tournament_data: null,
  };
}

/** the raiser's raise is his all-in, or covers hero: the tree names it as the all-in */
const lockedRaiseIsAllIn = (plan: LockedPlan) => plan.raiserAllIn || plan.raiseToTree >= Math.min(plan.stacks.SB, plan.stacks.BB) - 0.01;

/** The raiser's action at his node: the all-in when his raise is one, else the raise AT his size — GTO Wizard names a
 *  listed amount to the cent; a node named otherwise means the size was not read as intended, and the tree is not used. */
export function raiseCodeAt(sols: any[], plan: LockedPlan): string | null {
  if (lockedRaiseIsAllIn(plan)) {
    // the all-in GTO Wizard flags, else (with a pot it never flags one — utils/lockedHeadsUp) the largest raise
    const flagged = sols.find((a) => a?.action?.allin === true);
    if (flagged) return String(flagged.action.code);
    const raises = sols.filter((a) => /^R/i.test(String(a?.action?.code ?? "")));
    return raises.length ? String(raises.reduce((x, y) => (codeNum(y.action.code) > codeNum(x.action.code) ? y : x)).action.code) : null;
  }
  let best: any = null;
  for (const a of sols) {
    if (!isRaiseCode(a)) continue;
    if (!best || Math.abs(codeNum(a.action.code) - plan.raiseToTree) < Math.abs(codeNum(best.action.code) - plan.raiseToTree)) best = a;
  }
  return best && Math.abs(codeNum(best.action.code) - plan.raiseToTree) <= 0.015 ? String(best.action.code) : null;
}

const lockOf = (line: string, sols: any[], w: (code: string) => number[] | number): NodeLock => ({
  action_history: [line],
  strategy: sols.map((a) => {
    const code = String(a?.action?.code ?? "");
    const v = w(code);
    return { action: code, strategy: typeof v === "number" ? new Array<number>(1326).fill(v) : v };
  }),
  hands_locked: new Array<boolean>(1326).fill(true),
  previous_nodes_lock_type: "street_all",
});

/** What the locked last resort asks of the outside (a test replaces it). */
export const lockedSeams = {
  /** read the raiser on a line FITTED for him even where the exact tree holds it (lastRaiseReads' fitOnly) — what a
   *  real last resort meets; scripts/lastResortStudy.ts sets it to score that case */
  fitOnly: false,
  node: (solId: string, line: string): Promise<NodeRead> => fetchNode(solId, line),
  solve: (key: string, body: any): Promise<{ solId: string } | { error: string }> => ensureSolution(key, body, { preflop: true }),
  lock: (parent: string, body: any, locks: NodeLock[]): Promise<{ solId: string } | { error: string }> => lockedSolution(parent, body, locks),
  /** the raiser's 1,326 weights as the exact tree plays him up to and including his raise (null: cannot be read) */
  raiserRange: async (hand: ParsedHand, heroPos: string | null, plan: LockedPlan): Promise<{ w: number[]; how: string } | null> => {
    const shape = shapeOf(hand, heroPos);
    if ("error" in shape) return null;
    const { tokens, levels } = lineOf(hand, shape);
    const m = menus(levels, shape.n);
    const sol = await ensureSolution(treeKeyOf(shape, m), treeBody(shape, m), { multiway: shape.n > 2, preflop: true });
    if ("error" in sol) return null;
    const reads = lastRaiseReads(sol.solId, shape, tokens, { fitOnly: lockedSeams.fitOnly });
    const rs = await startRangeOf(hand, plan.raiserSeat, plan.raiserPos, plan.raiseIndex, reads.before);
    const f = await reads.raiseFilter(plan.raiserPos).catch(() => null);
    if (!f) return null;
    const clamp = (x: unknown) => Math.max(0, Math.min(1, Number(x ?? 0) || 0));
    const w = normalisedCombos((rs.combos ?? new Array<number>(1326).fill(1)).map((x, i) => x * clamp(f[i])));
    return w ? { w, how: `${rs.how}, then the share of it that makes the raise there` } : null;
  },
  rake: (hand: ParsedHand, heroPos: string | null): Pick<AiPreflopShape, "rakeCapBb" | "siteRake" | "anteBb"> | null => {
    const shape = shapeOf(hand, heroPos);
    return "error" in shape ? null : { rakeCapBb: shape.rakeCapBb, siteRake: shape.siteRake, anteBb: shape.anteBb };
  },
};

/**
 * THE LAST RESORT ON A LOCKED TREE: hero against the last raise, the raiser's raise locked to his range on the exact
 * tree (lockedSeams.raiserRange — startRangeOf × the exact tree's share of it that raises, as the reduced arrival tree
 * reads its raiser). `dead: false` leaves every chip but the two players' own out of the pot (the study's comparison).
 * No preflop pin: the flop reads its ranges the ordinary way (arrivalRangesGtowAi), not from this tree.
 */
export async function solveLockedLastResort(hand: ParsedHand, heroPos: string | null, why: string, opts: { dead?: boolean } = {}): Promise<AiPreflopOutcome> {
  const t0 = Date.now();
  const no = (reason: string): AiPreflopOutcome => ({ ok: false, reason: reason.startsWith("locked tree") ? reason : `locked tree: ${reason}` });
  const plan = planLockedHeadsUp(hand, heroPos, { dead: opts.dead });
  if (!plan.ok) return plan;
  const heroIdx = hand.heroCards?.length === 2 ? comboIndex(hand.heroCards[0]!, hand.heroCards[1]!) : null;
  if (heroIdx == null) return no("hero's cards are not known");
  const rake = lockedSeams.rake(hand, heroPos);
  if (!rake) return no("the table's shape could not be read");
  if (rake.anteBb) return no("a table with an ante is not modelled");
  const range = await lockedSeams.raiserRange(hand, heroPos, plan);
  if (!range) return no(`${plan.raiserPos}'s raise to ${plan.raiseTo}bb cannot be read on the exact tree, so there is no range to lock`);
  const w = range.w;
  const body = lockedTreeBody(plan, rake);
  const parent = await lockedSeams.solve(`locked|${Bun.hash(JSON.stringify(body)).toString(36)}`, body);
  if ("error" in parent) return no(parent.error);
  const read = async (solId: string, line: string, actor: TreeSeat): Promise<{ error: string } | { sols: any[]; cached: boolean; stored: boolean; data: any }> => {
    const n = await lockedSeams.node(solId, line);
    if ("error" in n) return { error: `node '${line || "root"}': ${n.error}` };
    const who = n.data?.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
    if (who !== actor) return { error: `node '${line || "root"}' puts ${who} on the clock, not ${actor}` };
    return { sols: (n.data?.action_solutions ?? []) as any[], cached: !!n.cached, stored: !!n.stored, data: n.data };
  };
  const passiveOf = (sols: any[]) =>
    String(sols.find((a) => /^F/i.test(String(a?.action?.code)))?.action?.code ?? sols.find((a) => /^X/i.test(String(a?.action?.code)))?.action?.code ?? "");
  const codes = (sols: any[]) => sols.map((a) => a.action.code).join("/");
  const locks: NodeLock[] = [];
  let heroLine: string;
  if (!plan.heroFirst) {
    const root = await read(parent.solId, "", plan.raiserTree);
    if ("error" in root) return no(root.error);
    const rc = raiseCodeAt(root.sols, plan), pass = passiveOf(root.sols);
    if (!rc || !pass) return no(`the raiser's root offers no ${rc ? "fold or check" : `raise to ${plan.raiseToTree}`} (${codes(root.sols)})`);
    locks.push(lockOf("", root.sols, (code) => (code === rc ? w : code === pass ? w.map((x) => 1 - x) : 0)));
    heroLine = rc;
  } else {
    const root = await read(parent.solId, "", plan.heroTree);
    if ("error" in root) return no(root.error);
    // hero's passive action costs him nothing: a check, or — with posts equal, where GTO Wizard still offers the small
    // blind fold/call — the call of nothing
    const even = Math.abs(plan.posts[plan.heroTree] - plan.posts[plan.raiserTree]) < 0.005;
    const x = String(root.sols.find((a) => /^X/i.test(String(a?.action?.code)))?.action?.code
      ?? (even ? root.sols.find((a) => /^C$/i.test(String(a?.action?.code)))?.action?.code : null) ?? "");
    if (!x) return no(`hero's root offers no check (${codes(root.sols)})`);
    locks.push(lockOf("", root.sols, (code) => (code === x ? 1 : 0)));
    const at = await read(parent.solId, x, plan.raiserTree);
    if ("error" in at) return no(at.error);
    const rc = raiseCodeAt(at.sols, plan), pass = passiveOf(at.sols);
    if (!rc || !pass) return no(`the raiser's node offers no ${rc ? "fold or check" : `raise to ${plan.raiseToTree}`} (${codes(at.sols)})`);
    locks.push(lockOf(x, at.sols, (code) => (code === rc ? w : code === pass ? w.map((v) => 1 - v) : 0)));
    heroLine = `${x}-${rc}`;
  }
  const locked = await lockedSeams.lock(parent.solId, body, locks);
  if ("error" in locked) return no(locked.error);
  const hn = await read(locked.solId, heroLine, plan.heroTree);
  if ("error" in hn) return no(hn.error);
  // HERO IS PRICED AS AT THE TABLE, or there is no answer: the chips on the table at his node are his post and the raise
  // (as a pair — GTO Wizard shows a small blind that posted more under the big blind's name; an all-in that covers hero
  // is named by the raiser's own stack, so anything from hero's stack up is the shove)
  const chips = (["SB", "BB"] as TreeSeat[]).map((t) => Number(hn.data?.game?.players?.find((p: any) => p.position === t)?.chips_on_table ?? NaN)).sort((x, y) => x - y);
  const want = [plan.posts[plan.heroTree], lockedRaiseIsAllIn(plan) ? Math.min(plan.stacks.SB, plan.stacks.BB) : plan.raiseToTree].sort((x, y) => x - y);
  // (a seat that has only posted is shown in units of the big blind's post — even posts of 2.6 show hero at 1 — so his
  // post may read either way; a raise is shown in chips)
  const near = (x: number, y: number) => Math.abs(x - y) <= Math.max(0.02, y * 0.005);
  const heroShown = [plan.posts[plan.heroTree], plan.posts[plan.heroTree] / Math.max(plan.posts.SB, plan.posts.BB)];
  const raiseShown = (x: number) => (lockedRaiseIsAllIn(plan) ? x >= want[1]! - 0.02 : near(x, want[1]!));
  const priced = chips.some((c, k) => heroShown.some((h) => near(c, h)) && raiseShown(chips[1 - k]!));
  if (!priced) return no(`hero's node is not priced as the table (chips on it ${chips.join(" / ")}, expected ${want.map((x) => Math.round(x * 100) / 100).join(" / ")})`);
  // hero's mix in percent; a raise named at the table's size (the shift taken back out)
  const label = (a: any) => {
    const l = labelOf(a);
    const m = /^Raise (\d+(?:\.\d+)?)$/.exec(l);
    return m && plan.shift ? `Raise ${Math.round((Number(m[1]) - plan.shift) * 100) / 100}` : l;
  };
  let actions = hn.sols.map((a) => ({ action: label(a.action), frequency: Number(a.strategy?.[heroIdx] ?? 0) }));
  const sum = actions.reduce((t, a) => t + a.frequency, 0);
  if (sum <= 1.5) actions = actions.map((a) => ({ ...a, frequency: a.frequency * 100 }));
  actions = actions.filter((a) => a.frequency > 0.05).map((a) => ({ ...a, frequency: Math.round(a.frequency * 100) / 100 }));
  const raiserCombos = Math.round(w.reduce((t, x) => t + x, 0));
  const shape: AiPreflopShape = {
    n: 2, apiOf: { [plan.heroPos]: plan.heroTree, [plan.raiserPos]: plan.raiserTree }, seatOf: { [plan.heroTree]: plan.heroSeat, [plan.raiserTree]: plan.raiserSeat },
    positions: ["SB", "BB"], stacks: { ...plan.stacks }, sb: plan.posts.SB, bb: plan.posts.BB, straddle: null, rakeCapBb: rake.rakeCapBb,
    deadSb: false, deadBb: plan.pot, heroApiPos: plan.heroTree, ...(rake.siteRake ? { siteRake: rake.siteRake } : {}),
  };
  const ip = plan.heroTree === "SB" ? plan.heroPos : plan.raiserPos;
  const r2n = (x: number) => Math.round(x * 100) / 100;
  const dead = opts.dead === false ? 0 : plan.deadBb;
  const from = [plan.foldedPos.length ? `${plan.foldedPos.join(", ")} (folded)` : "", plan.blindsBehindPos.length ? `${plan.blindsBehindPos.join(", ")} (a blind still to act)` : ""].filter(Boolean).join(" and ");
  const left = [
    plan.livePos.length ? `${plan.livePos.join(", ")} still in the hand (left out, with their chips)` : "",
    plan.toActPos.length ? `${plan.toActPos.join(", ")} still to act behind hero` : "",
    "the folded players' ranges",
  ].filter(Boolean);
  const how = `hero (${plan.heroPos}) vs ${plan.raiserPos}'s raise to ${plan.raiseTo}bb heads-up, the raise locked to his range (${raiserCombos} combos)` +
    (dead > 0 ? `, ${r2n(dead)}bb dead` : ", no dead money");
  const secs = (Date.now() - t0) / 1000;
  const note = `LAST RESORT, LOCKED TREE — no tree holds this line, so hero (${plan.heroPos}) is played against the last raise alone: ` +
    `${plan.raiserPos} raised to ${plan.raiseTo}bb, and on a heads-up tree (${ip} in position) that raise is an action LOCKED to his range — ` +
    `${range.how} (${raiserCombos} combos) — so hero's node is solved against exactly that range. Hero's own range there is every hand (his earlier actions are not applied). ` +
    `Priced as at the table: hero has ${plan.heroIn}bb in and ${r2n(plan.raiseTo - plan.heroIn)}bb to call; ` +
    (dead > 0 ? `${r2n(dead)}bb dead in the pot from ${from}` : "no dead money in the pot") +
    (plan.potOver > 0 ? ` (the tree's pot is ${plan.potOver}bb bigger than that: both posts shifted under GTO Wizard's 250bb unit rule)` : "") +
    `. Not modelled: ${left.join("; ")}. Solved in ${secs.toFixed(1)} s${hn.stored ? " (from the GTO Wizard solve cache)" : ""}. Why: ${why}.`;
  return {
    ok: true, actions, decision: actions.length ? pickWeightedAction(actions) : null, line: heroLine, pos: plan.heroPos, heroClass: heroClass(hand.heroCards),
    treeKey: `locked|${plan.heroPos}-${plan.raiserPos}`, solId: locked.solId, usedLine: heroLine, solveSecs: secs, cached: hn.cached,
    ...(hn.stored ? { stored: true } : {}), shape, note, lastResort: { how },
  };
}

/** The exact request a hand would produce (for tests and the state tester — nothing is sent). */
export function debugTree(hand: ParsedHand, heroPos: string | null, dealt?: Record<number, number>): { shape: AiPreflopShape; line: string; body: any } | { error: string } {
  const shape = shapeOf(hand, heroPos, 0, undefined, dealt);
  if ("error" in shape) return shape;
  const { tokens, levels } = lineOf(hand, shape);
  const m = menus(levels, shape.n);
  return { shape, line: tokens.join("-"), body: treeBody(shape, m) };
}

// ---------------------------------------------------------------------------
// ARRIVAL RANGES FROM THE AI PREFLOP TREE (2026-09-19, Brady: "make the AI
// preflop fallback and the 6-max charts expose the same shape for the AI
// postflop to read"). The postflop chain consumes ReconstructResult — position
// → hand class → weight in [0,1] — however the preflop was answered. The chart
// piece produces it by walking the crawled chart nodes (reconstructFlopRanges);
// this produces the identical shape by walking the SAME custom tree that
// answered preflop: every seat starts at the full 1326, each node multiplies
// the actor's range by its per-combo strategy for the action taken, a fold
// removes the seat. Villain raises condition on the union of the node's raise
// sizes, exactly as the chart walk does (a single-sizer's range is not the
// equilibrium slice that mixes into one size).
// ---------------------------------------------------------------------------

/** POST a tree and return what the API stores for it — every field it accepts, with its own defaults filled
 *  in. The custom-tree schema is not published anywhere, and unknown keys are silently DROPPED rather than
 *  rejected, so guessing field names proves nothing; this is the only way to see the real vocabulary
 *  (scripts/_probeTreeSchema.ts, 2026-09-20). */
export async function debugCreateTree(hand: ParsedHand, heroPos: string | null, patch?: Record<string, unknown>, posPatch?: Record<string, unknown>): Promise<any> {
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape) return { error: shape.error };
  const { levels } = lineOf(hand, shape);
  const body: any = { ...treeBody(shape, menus(levels, shape.n)), ...(patch ?? {}) };
  if (posPatch) {
    for (const st of body.bet_sizes?.street_bet_sizes ?? []) {
      st.position_bet_sizes = st.position_bet_sizes.map((x: any) => ({ ...x, ...posPatch }));
    }
  }
  const token = (await gtowSessions.bestToken({ multiway: shape.n > 2, preflop: true }))?.token ?? null;
  if (!token) return { error: "no GTO Wizard token" };
  const r = await gtowRequests.fetch(null, "tree", `${API_BASE}/v4/custom-solutions/custom-trees/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  return { status: r.status, sent: body, got: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

/** Solve this hand's tree and read ONE node's offered actions./** Solve this hand's tree and read ONE node's offered actions. Exists to probe WHICH MULTIWAY LINES the AI
 *  preflop tree actually contains — "allow_call_opens" turns cold-calling on, but the tree still caps how many
 *  callers a node will offer, and a line past that cap fails mid-walk with nothing saying which node ran out
 *  (scripts/_probe5wayArrival.ts, 2026-09-20). */
export async function debugPreflopNode(hand: ParsedHand, heroPos: string | null, line: string, patch?: Record<string, unknown>, posPatch?: Record<string, unknown>): Promise<
  { ok: true; actor: string | null; actions: { code: string; freq: number | null }[] } | { ok: false; reason: string }
> {
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape) return { ok: false, reason: shape.error };
  const { levels } = lineOf(hand, shape);
  const body: any = { ...treeBody(shape, menus(levels, shape.n)), ...(patch ?? {}) };
  if (posPatch) {
    for (const st of body.bet_sizes?.street_bet_sizes ?? []) {
      st.position_bet_sizes = st.position_bet_sizes.map((x: any) => ({ ...x, ...posPatch }));
    }
  }
  const key = treeKeyOf(shape, menus(levels, shape.n)) +
    (patch ? `|${JSON.stringify(patch)}` : "") + (posPatch ? `|p${JSON.stringify(posPatch)}` : "");
  const sol = await ensureSolution(key, body, { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: sol.error };
  const n = await fetchNode(sol.solId, line);
  if ("error" in n) return { ok: false, reason: n.error };
  return {
    ok: true,
    actor: n.data?.game?.players?.find((p: any) => p.is_hero)?.position ?? null,
    actions: (n.data?.action_solutions ?? []).map((a: any) => ({ code: String(a.action?.code ?? "?"), freq: a.total_frequency ?? null })),
  };
}

export interface ArrivalRanges {
  ok: true;
  /** which preflop piece produced the ranges */
  piece: "chart6max" | "gtow-ai-preflop";
  /** chart id or the AI tree's description — the answer's rangeSource */
  id: string;
  ranges: Record<string, Record<string, number>>;
  tokens: string[];
  /** the seat order the tokens walk (the API's set for this table size) — for rolling the pot forward */
  seatOrder: readonly string[];
  note: string | null;
  /** the ranges came from the REDUCED tree (reducedArrivalRanges): the exact tree could not hold the line, and why;
   *  `fitted` = the villain callers read on the exact tree through their own node (the rest are kept whole) */
  reduced?: { why: string; live: string[]; fitted: number };
}
export type ArrivalOutcome = ArrivalRanges | { ok: false; reason: string };

/**
 * How many players the CALLER can use at the flop.
 *
 * The walk itself is count-agnostic — it conditions every seat's range the same way whatever the table size,
 * and `shapeOf` builds 2-to-6-handed trees — so this is purely the caller saying what its postflop step can
 * consume. GTO Wizard's postflop trees hold three seats, so anything above 3 is a spot whose postflop must be
 * COLLAPSED to three (see aiChain / fastSolve), and the arrival ranges are what the collapse chooses from
 * (2026-09-20).
 *
 * IT HAS NO DEFAULT, deliberately (2026-09-21). It used to default to 3, and that default is exactly how the
 * 4+ way hole survived: `fastSolve` called this without an argument, silently truncated the field to three
 * BEFORE the collapse that exists to handle four and five, and every such flop died with "4 players reach the
 * flop — need 2 to 3". The chart path had been raised to 6 the same day; this one was missed because nothing
 * at the call site named the number. Make every caller say it out loud.
 */
export type SeatCap = 2 | 3 | 4 | 5 | 6;

/** combos per hand class (6 pairs, 4 suited, 12 offsuit) — the denominator of a class weight */
const CLASS_COMBOS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const c of COMBOS) out[c.cls] = (out[c.cls] ?? 0) + 1;
  return out;
})();

const isRaiseCode = (a: any) => /^R/i.test(String(a?.action?.code ?? "")) && a?.action?.allin !== true;
const codeNum = (c: string) => Number(String(c).replace(/^[A-Z]+/i, ""));

export async function arrivalRangesGtowAi(hand: ParsedHand, heroPos: string | null, maxPlayers: SeatCap, dealt?: Record<number, number>): Promise<ArrivalOutcome> {
  const shape = shapeOf(hand, heroPos, 0, undefined, dealt);
  if ("error" in shape) return { ok: false, reason: `GTO Wizard AI preflop ranges: ${shape.error}` };
  const { tokens, levels } = lineOf(hand, shape);
  const m = menus(levels, shape.n);
  const key = treeKeyOf(shape, m);
  const sol = await ensureSolution(key, treeBody(shape, m), { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: `GTO Wizard AI preflop ranges: ${sol.error}` };
  const get = (line: string) => fetchNode(sol.solId, line);
  // THE LINE IS WALKED ONTO THE TREE'S OWN SIZES FIRST (2026-09-25, hand 4920397538): the tokens are our reading of
  // the table (hero's 2.5x pick executes as 2.6bb at a 5c big blind), the tree holds its grid (2.5). The answer
  // path and the range looker both repair the line before reading it; this walk trusted the raw tokens and refused
  // hero's own open as "not an action at root" on every postflop street. A line the repair cannot walk keeps the
  // raw tokens so the per-seat fit below still sees the real refusal.
  prefetchPrefixes(sol.solId, tokens);   // every prefix node asked for together; repairLine joins the reads (2026-10-01)
  const repaired = await repairLine(sol.solId, tokens);
  const codes = "error" in repaired ? tokens : repaired.line.split("-").filter(Boolean);
  const first = await walkArrivalRanges(shape, codes, get, maxPlayers);
  if (first.ok) return first;
  // THE REDUCED TREE, WHEN THE EXACT ONE CANNOT HOLD THE LINE (2026-10-01, hand 4921846667): a refusal of the LINE —
  // an action the tree does not offer, a node it does not have — that the per-seat fit below cannot mend either used
  // to be the end ("no library fallback under this strategy": no answer, a timeout, a sit-out). The players who
  // reach the flop are read around the last raise they met (reducedArrivalRanges), every read on THIS exact tree, on
  // the line cut where it is needed and fitted for that seat (lastRaiseReads).
  const viaReduced = async (why: string): Promise<ArrivalOutcome> => {
    const red = await reducedArrivalRanges(hand, heroPos, maxPlayers, dealt, { why, tokens, seatOrder: shape.positions, ...lastRaiseReads(sol.solId, shape, tokens) });
    return red.ok ? red : { ok: false, reason: `${why}; then the reduced tree: ${red.reason}` };
  };
  if (!/is not an action/.test(first.reason)) return LINE_NOT_IN_TREE.test(first.reason) ? viaReduced(first.reason) : first;
  // THE LINE FIT, PER SEAT (as recon6max does on the charts): each live seat's range is read from a fitted line
  // that keeps THAT seat's own actions, so nobody's range is conditioned on a fold he never made
  const who = actorsWithAllins(tokens, shape.stacks, shape.positions);
  const live = shape.positions.filter((p) => !tokens.some((t, i) => t === "F" && who[i] === p));
  if (live.length > maxPlayers) return first;
  const handPosOf: Record<string, string> = {};
  for (const [handPos, apiPos] of Object.entries(shape.apiOf)) handPosOf[apiPos] = handPos;
  const ranges: Record<string, Record<string, number>> = {};
  const folded = new Set<string>();
  for (const p of live) {
    const fit = await fitAiLine(sol.solId, tokens, shape, [p]);
    if (!fit) return viaReduced(first.reason);
    fit.folds.forEach((f) => folded.add(f));
    const r = await walkArrivalRanges(shape, fit.tokens, get, 6);
    if (!r.ok) return viaReduced(first.reason);
    const key = handPosOf[p] ?? p;
    const rec = r.ranges[key];
    if (!rec) return viaReduced(first.reason);
    ranges[key] = rec;
  }
  const id = `gtow-ai · ${shape.n}-handed · ${shape.positions.map((p) => `${p}:${shape.stacks[p]}`).join("/")}`;
  return {
    ok: true, piece: "gtow-ai-preflop", id, ranges, tokens, seatOrder: shape.positions,
    note: `flop-entering ranges walked from the GTO Wizard AI preflop tree. LINE FITTED FOR THE RANGES: the tree holds ` +
      `one limper, so each seat's range was read from a line that keeps its own actions and folds the earliest other ` +
      `limper or caller (${[...folded].join(", ")} folded in some of them).`,
  };
}

/** What the reduced tree reads from the exact tree (ctx of reducedArrivalRanges). */
export interface LastRaiseReads {
  /** a seat's range on the exact tree up to the last raise (table position) */
  before: (handPos: string) => Promise<number[] | null>;
  /** per combo, the share of the raiser's range that makes the last raise */
  raiseFilter: (handPos: string) => Promise<number[] | null>;
  /** per combo, the share of hero's range that calls it */
  callFilter: (handPos: string) => Promise<number[] | null>;
  /** a villain caller's range through his answer to the last raise: walked on the line fitted for him, his answer read
   *  as "did not fold"; `folded` = the seats the fit folded out (table positions; none = the tree holds his line) */
  stayRange: (handPos: string) => Promise<{ range: number[]; folded: string[] } | null>;
}

/**
 * THE EXACT TREE'S READS AROUND THE LAST RAISE, for the reduced tree (2026-10-01; the caller's read 2026-10-04). Every
 * read is on the tree already solved for this hand, on the line cut where it is needed, as the tree walks it — as it
 * stands, else fitted keeping that seat's own actions (fitAiLine: the earliest other limper or caller folded). Exported
 * so scripts/callerReadStudy.ts scores exactly this code; `opts.fitOnly` (the study's only use) skips the direct walk,
 * which is what the reduced tree meets: a line the exact tree cannot hold.
 */
export function lastRaiseReads(solId: string, shape: AiPreflopShape, tokens: string[], opts: { fitOnly?: boolean } = {}): LastRaiseReads {
  const get = (line: string) => fetchNode(solId, line);
  const lastRaise = tokens.reduce((k, t, i) => (/^R/.test(t) ? i : k), -1);
  const apiOfPos = (handPos: string) => shape.apiOf[handPos.toUpperCase()] ?? handPos.toUpperCase();
  const handPosOf: Record<string, string> = {};
  for (const [handPos, apiPos] of Object.entries(shape.apiOf)) handPosOf[apiPos] = handPos;
  /** a cut of the line as this tree walks it for ONE seat: as it stands, else fitted keeping that seat's own actions
   *  (hero's limp is folded like anyone's when the seat is not hero); with the seats the fit folded out */
  const fitFor = async (cut: string[], api: string): Promise<{ codes: string[]; folds: string[] } | null> => {
    if (!opts.fitOnly) {
      const direct = await repairLine(solId, cut);
      if (!("error" in direct)) return { codes: direct.line.split("-").filter(Boolean), folds: [] };
    }
    const fit = await fitAiLine(solId, cut, shape, [api], 4, api === shape.heroApiPos);
    return fit ? { codes: fit.line.split("-").filter(Boolean), folds: fit.folds } : null;
  };
  const fitted = async (cut: string[], api: string): Promise<string[] | null> => (await fitFor(cut, api))?.codes ?? null;
  /** the index in `tokens` of this seat's call of the last raise (-1: none) */
  const callAt = (api: string): number => {
    const who = actorsWithAllins(tokens, shape.stacks, shape.positions);
    let at = -1;
    tokens.forEach((t, i) => { if (i > lastRaise && t === "C" && who[i] === api) at = i; });
    return at;
  };
  const before = async (handPos: string): Promise<number[] | null> => {
    const api = apiOfPos(handPos);
    if (lastRaise <= 0 || !shape.positions.includes(api)) return null;
    const line = await fitted(tokens.slice(0, lastRaise), api);
    if (!line) return null;
    let got: number[] | null = null;
    await walkArrivalRanges(shape, line, get, 6, (s) => { if (s.actor === api && s.token !== "F") got = s.after; });
    return got;
  };
  /** per combo, the share of a seat's range that takes `kind` of action at the node the line cut ends on — as THIS
   *  tree plays it, on the line fitted for that seat: a raise is the union of the node's raise sizes (the menu carries
   *  the line's own size beside its grid's, and one player's raise is not the slice that mixes into one of them) */
  const shareAt = async (api: string, cut: string[], kind: "raise" | "call"): Promise<number[] | null> => {
    const line = await fitted(cut, api);
    if (!line || !line.length) return null;
    const node = await get(line.slice(0, -1).join("-"));
    if ("error" in node) return null;
    if ((node.data?.game?.players?.find((p: any) => p.is_hero)?.position ?? null) !== api) return null;
    const sols: any[] = node.data?.action_solutions ?? [];
    const pick = sols.filter((x) => (kind === "raise" ? /^R/i.test(String(x?.action?.code ?? "")) : /^C/i.test(String(x?.action?.code ?? ""))));
    if (!pick.length) return null;
    const f = new Array<number>(1326);
    for (let i = 0; i < 1326; i++) { let v = 0; for (const x of pick) v += Number(x.strategy?.[i] ?? 0); f[i] = Math.min(1, Math.max(0, v)); }
    return f;
  };
  // HOW THIS TREE PLAYS THE LAST RAISE, for the seat that made it (the union of the node's raise sizes).
  const raiseFilter = async (handPos: string): Promise<number[] | null> => {
    const api = apiOfPos(handPos);
    if (lastRaise < 0 || !shape.positions.includes(api)) return null;
    return shareAt(api, tokens.slice(0, lastRaise + 1), "raise");
  };
  // … and how it plays a seat's CALL of that raise (hero's own call, when this tree can hold his line)
  const callFilter = async (handPos: string): Promise<number[] | null> => {
    const api = apiOfPos(handPos);
    if (lastRaise < 0 || !shape.positions.includes(api)) return null;
    const at = callAt(api);
    return at < 0 ? null : shareAt(api, tokens.slice(0, at + 1), "call");
  };
  // A VILLAIN'S ANSWER TO THE LAST RAISE (2026-10-04, scripts/callerReadStudy.ts): his range WALKED on the line fitted
  // for him, through his own node, less the hands that fold there — "did not fold", not "called" (utils/reducedArrival).
  // His starting range is the walk's own: every action of his on the fitted line, read on this tree.
  const stayRange = async (handPos: string): Promise<{ range: number[]; folded: string[] } | null> => {
    const api = apiOfPos(handPos);
    if (lastRaise < 0 || !shape.positions.includes(api)) return null;
    const at = callAt(api);
    if (at < 0) return null;
    const fit = await fitFor(tokens.slice(0, at + 1), api);
    if (!fit || !fit.codes.length) return null;
    const nodeLine = fit.codes.slice(0, -1).join("-");
    let got: number[] | null = null;
    await walkArrivalRanges(shape, fit.codes, get, 6, (s) => {
      if (s.line !== nodeLine || s.actor !== api) return;
      const folds = (s.node?.action_solutions ?? []).filter((a: any) => /^F/i.test(String(a?.action?.code ?? "")));
      got = s.before.map((w, i) => {
        let f = 0;
        for (const a of folds) f += Number(a.strategy?.[i] ?? 0);
        return w * Math.max(0, 1 - Math.min(1, f));
      });
    });
    return got ? { range: got, folded: fit.folds.map((x) => handPosOf[x] ?? x) } : null;
  };
  return { before, raiseFilter, callFilter, stayRange };
}

/** One decision of the AI walk: the node, its actor (API position), the action(s) the range was conditioned on and
 *  the exact one taken, and the actor's per-combo weights before and after. */
export interface AiWalkStep { line: string; token: string; actor: string; node: any; chosen: any[]; taken: any; before: number[]; after: number[] }

/** The walk itself, pure over a node getter (tests feed synthetic nodes; live feeds the solved tree). */
export async function walkArrivalRanges(
  shape: AiPreflopShape,
  tokens: string[],
  getNode: (line: string) => Promise<{ data: any; cached?: boolean } | { error: string }>,
  maxPlayers: SeatCap,
  /** every decision read, with the actor's 1,326 weights either side of it (the range looker's preflop path) */
  onStep?: (step: AiWalkStep) => void
): Promise<ArrivalOutcome> {
  const weights = new Map<string, number[]>(shape.positions.map((p) => [p, new Array(1326).fill(1)]));
  const folded = new Set<string>();
  const heroApi = shape.heroApiPos;
  // the path is the tree's OWN codes for the tokens read so far — a snapped size (hero's 2.6 read as the node's
  // 2.5) must advance onto the node the tree has, not the one the raw token names
  const path: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const line = path.join("-");
    const node = await getNode(line);
    if ("error" in node) return { ok: false, reason: `GTO Wizard AI preflop ranges: node '${line || "root"}' — ${node.error}` };
    const j = node.data;
    const actor: string | null = j.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
    if (!actor) return { ok: false, reason: `GTO Wizard AI preflop ranges: node '${line || "root"}' names no player to act` };
    const tok = tokens[k]!;
    const sols: any[] = j.action_solutions ?? [];
    let chosen: any[];
    let taken: any = null;
    if (tok === "F") chosen = sols.filter((a) => /^F/i.test(String(a.action?.code ?? "")));
    else if (tok === "C") chosen = sols.filter((a) => /^C/i.test(String(a.action?.code ?? "")));
    else if (tok === "X") chosen = sols.filter((a) => /^X/i.test(String(a.action?.code ?? "")));
    else {
      const want = codeNum(tok);
      const exact = sols.filter((a) => isRaiseCode(a) && Math.abs(codeNum(a.action.code) - want) <= 0.06);
      // a villain's raise: the union of the node's raise sizes (the chart walk's rule); hero's: the exact size
      // HERO'S OWN SIZE SNAPS LIKE EVERY OTHER (2026-09-25): a 0.06bb window is narrower than the client's rounding
      // (2.5x at a 5c big blind lands on 2.6). The nearest raise the node offers is the action hero took, and the
      // node the walk advances onto — for a villain too, whose range is the union of sizes but whose path is one.
      const near = matchToken(tok, sols);
      const nearest = near ? sols.filter((a) => String(a.action?.code ?? "") === near.code) : [];
      chosen = actor !== heroApi ? sols.filter(isRaiseCode) : (exact.length ? exact : nearest);
      if (!chosen.length) chosen = sols.filter((a) => a.action?.allin === true);
      taken = exact[0] ?? nearest[0] ?? null;
    }
    if (!chosen.length) return { ok: false, reason: `GTO Wizard AI preflop ranges: token ${tok} is not an action at '${line || "root"}'` };
    const w = weights.get(actor);
    if (!w) return { ok: false, reason: `GTO Wizard AI preflop ranges: node actor ${actor} is not a seat of the tree` };
    const before = onStep ? w.slice() : null;
    for (let i = 0; i < 1326; i++) {
      let f = 0;
      for (const a of chosen) f += Number(a.strategy?.[i] ?? 0);
      w[i] = w[i]! * Math.min(1, f);
    }
    if (tok === "F") folded.add(actor);
    onStep?.({ line, token: tok, actor, node: j, chosen, taken: taken ?? chosen[0], before: before!, after: w.slice() });
    path.push(String((taken ?? chosen[0])?.action?.code ?? tok));
  }
  const live = shape.positions.filter((p) => !folded.has(p));
  if (live.length < 2 || live.length > maxPlayers) {
    return { ok: false, reason: `${live.length} players reach the flop — need 2 to ${maxPlayers}` };
  }
  // back to the table's own position names (the API relabels seats onto its fixed sets; heads-up the dealer
  // is the API's SB while the table may call him BTN — the chain's lookup knows that alias, so ONE key per
  // seat here: a second key would read as a third player and send the spot to the 3-way tree)
  const handPosOf: Record<string, string> = {};
  for (const [handPos, apiPos] of Object.entries(shape.apiOf)) handPosOf[apiPos] = handPos;
  const ranges: Record<string, Record<string, number>> = {};
  for (const p of live) {
    // class weight = the fraction of the WHOLE class continuing (a combo at 0 still counts in the
    // denominator — toClassWeights only tallies the nonzero ones), the chart walk's convention
    const cw = toClassWeights(weights.get(p)!);
    const rec: Record<string, number> = {};
    for (const [cls, v] of Object.entries(cw)) if (v.weight > 0) rec[cls] = Math.min(1, v.weight / (CLASS_COMBOS[cls] ?? v.combos));
    if (!Object.keys(rec).length) return { ok: false, reason: `GTO Wizard AI preflop ranges: ${p}'s range is empty after the line` };
    ranges[handPosOf[p] ?? p] = rec;
  }
  const id = `gtow-ai · ${shape.n}-handed · ${shape.positions.map((p) => `${p}:${shape.stacks[p]}`).join("/")}`;
  return {
    ok: true, piece: "gtow-ai-preflop", id, ranges, tokens, seatOrder: shape.positions,
    note: `flop-entering ranges walked from the GTO Wizard AI preflop tree that answered preflop (${shape.n}-handed, ` +
      `${shape.positions.map((p) => `${p} ${shape.stacks[p]}bb`).join(", ")}, rake 5% cap ${shape.rakeCapBb}bb; line ${tokens.join("-") || "root"})` +
      (shape.deadSb ? " · dead SB approximated" : "") + (shape.stackCap ? ` · ${stackCapNote(shape)}` : ""),
  };
}

// ---------------------------------------------------------------------------
// THE REDUCED TREE (2026-10-01) — see utils/reducedArrival for the why and the plan. This half does the work: each
// player's range before the last raise, the raiser narrowed on the exact tree, one forced-raise tree per caller, and
// the answer's note.
// ---------------------------------------------------------------------------

/** A refusal of the LINE by the exact tree (not of the account, the network or the solve). */
const LINE_NOT_IN_TREE = /is not an action|is not offered|NODE_DOES_NOT_EXIST|node in the actions doesn't exist/i;
/** Hero's own hand is never left out of his range: a class the reduced solve gave nothing is kept at this weight. */
const HERO_FLOOR = 0.05;
/** How long a villain caller's read on the exact tree may take before he is kept whole — the forced-bet tree it
 *  replaced had the same 12 s (REDUCED_READ_MS, read at every read: the tests shorten it). */
const reducedReadMs = (): number => { const v = Number(process.env.REDUCED_READ_MS); return v > 0 ? v : 12_000; };
/** The pool chart's SB node behind one limper — its "C" is the pool's complete, as locked (hrc6max POOL_LIMP_CHART). */
const POOL_SB_COMPLETE_LINE = "F-F-F-C";

type ChartNodeRead = HrcNode | null | "unreachable";
/** What the reduced tree asks of the outside (a test replaces these). */
export const reducedSeams = {
  chartNode: (chartId: string, line: string): Promise<ChartNodeRead> => nodeGetter(chartId)(line),
  answersFor: (clientHandId: string): any[] => answerLog.forHand(clientHandId) as any[],
};

/** SOLVE A HAND-BUILT PREFLOP BODY and read its nodes — the forced-bet probes' only way in (scripts/_probeForcedDecision.ts,
 *  the record of why the forced-bet tree was retired 2026-10-04). Nothing on the answer path calls it. */
export async function debugSolveBody(key: string, body: any, n: number): Promise<{ solId: string; get: (line: string) => Promise<NodeRead> } | { error: string }> {
  const sol = await ensureSolution(key, body, { multiway: n > 2, preflop: true });
  if ("error" in sol) return sol;
  return { solId: sol.solId, get: (line: string) => fetchNode(sol.solId, line) };
}

/** class → fraction of the class taking the action with this token at a chart node (the charts store percent). */
function chartActionRange(node: ChartNodeRead, pick: (a: { action: string; token: string | null }) => boolean): Record<string, number> | null {
  if (!node || node === "unreachable") return null;
  const name = node.actions.find(pick)?.action;
  if (!name) return null;
  const out: Record<string, number> = {};
  for (const c of node.cells) {
    const w = Number(c.actions?.[name] ?? 0) / 100;
    if (w > 0) out[c.hand] = Math.min(1, w);
  }
  return Object.keys(out).length ? out : null;
}

/** `limped`: he came in with a limp (utils/reducedArrival cameInLimping) — a caller who did is kept whole */
interface StartRange { cls: Record<string, number> | null; combos: number[] | null; how: string; limped: boolean }

/**
 * A kept seat's range BEFORE the last raise — what the reduced tree starts it from.
 *   - no earlier voluntary action (a blind who only met the raise, an aggressor whose raise is his first chip): the
 *     full range;
 *   - HERO: what he was actually told — his earlier decisions that a 6-max chart answered, from the first on: the
 *     class weights of the action he took at that chart's node, multiplied;
 *   - a seat that came in with a LIMP (its first chip a call with no raise before it): the pool's limp range, as the
 *     pool-locked limp chart holds it (the SB: its complete) — whatever it called afterwards on the way to the last
 *     raise is not applied (no tree trains those nodes: the note says so);
 *   - anyone else: his range on the exact tree up to the raise (`before`), the full range when that cannot be read.
 */
async function startRangeOf(hand: ParsedHand, seat: number, pos: string, raiseIndex: number,
    before: ((handPos: string) => Promise<number[] | null>) | undefined): Promise<StartRange> {
  const seatOf = (a: ParsedAction) => (a.hero ? hand.heroSeatId : a.seatId);
  const isHero = seat === hand.heroSeatId;
  const earlier = hand.actions.slice(0, raiseIndex).map((a, i) => ({ a, i }))
    .filter(({ a }) => a.street === "preflop" && seatOf(a) === seat && ["call", "raise", "bet", "all-in"].includes(a.type));
  if (!earlier.length) return { cls: null, combos: null, how: "the full range (no action before the raise)", limped: false };
  const limped = cameInLimping(hand, seat, raiseIndex);
  const later = earlier.length > 1 ? ` — his ${earlier.length - 1} later action${earlier.length > 2 ? "s" : ""} before the raise not applied` : "";

  if (isHero) {
    // the chart answers of this hand, one per decision (the poller probes a decision every second), oldest first
    const rows = (() => {
      try {
        const all = reducedSeams.answersFor(String(hand.clientHandId ?? "")).filter((r: any) => r && r.street === "preflop" && r.source === "hrc-6max-preflop" && r.chart && r.pick);
        const byKey = new Map<string, any>();
        for (const r of all) byKey.set(String(r.decision_key ?? r.line ?? r.id), r);
        return [...byKey.values()].sort((x, y) => Number(x.ts) - Number(y.ts));
      } catch { return []; }
    })();
    if (rows.length) {
      let cls: Record<string, number> | null = null;
      const used: string[] = [];
      // decision by decision from his first: a later one the charts did not answer (the exact tree did) is left out
      for (const r of rows.slice(0, earlier.length)) {
        const node = await reducedSeams.chartNode(String(r.chart), String(r.line ?? ""));
        const pick = String(r.pick).trim().toLowerCase();
        const range = chartActionRange(node, (a) => a.action.trim().toLowerCase() === pick);
        if (!range) { cls = null; break; }
        const prev: Record<string, number> | null = cls;
        cls = prev ? Object.fromEntries(Object.entries(range).filter(([k]) => (prev[k] ?? 0) > 0).map(([k, w]) => [k, w * prev[k]!])) : range;
        used.push(`${r.pick} at "${r.line || "root"}" of ${r.chart}`);
      }
      if (cls && Object.keys(cls).length) {
        const n = normalised(cls);
        const rest = earlier.length - used.length;
        return { cls: n, combos: classesToCombos(n), how: `his own range as the chart played it (${used.join(", then ")})` +
          (rest > 0 ? ` — his ${rest} later action${rest > 1 ? "s" : ""} before the raise not applied` : ""), limped };
      }
    }
  }
  if (limped) {
    const sb = pos === "SB";
    const node = await reducedSeams.chartNode(POOL_LIMP_CHART, sb ? POOL_SB_COMPLETE_LINE : "");
    const range = chartActionRange(node, (a) => a.token === "C");
    if (range) {
      const n = normalised(range);
      return { cls: n, combos: classesToCombos(n), how: (sb ? "the pool's small-blind complete range (the pool-locked limp chart)" : "the pool's limp range (shown limps, as the pool-locked limp chart holds it)") + later, limped };
    }
  }
  const w = before ? await before(pos).catch(() => null) : null;
  if (w && w.some((x) => x > 0)) {
    const max = Math.max(...w);
    const combos = w.map((x) => Math.round((x / max) * 1e4) / 1e4);
    return { cls: null, combos, how: "his range on the exact tree up to the raise", limped };
  }
  return { cls: null, combos: null, how: `the full range (his earlier ${earlier.length === 1 ? "action is" : "actions are"} not modelled)`, limped };
}

/**
 * FLOP-ENTERING RANGES FROM THE REDUCED TREE (utils/reducedArrival). Called by arrivalRangesGtowAi when the exact tree
 * refuses the line and no per-seat fit mends it. `ctx.tokens` / `ctx.seatOrder` are the table's own line (the pot is
 * rolled forward from them, exactly as for every other arrival); the reads (`before`, `raiseFilter`, `callFilter`,
 * `stayRange` — lastRaiseReads) are all on the exact tree already solved for this hand: no tree is solved here.
 */
export async function reducedArrivalRanges(
  hand: ParsedHand, heroPos: string | null, maxPlayers: SeatCap, dealt: Record<number, number> | undefined,
  ctx: { why: string; tokens: string[]; seatOrder: readonly string[] } & Partial<LastRaiseReads>,
): Promise<ArrivalOutcome> {
  const no = (reason: string): ArrivalOutcome => ({ ok: false, reason });
  const hp = heroPosOf(hand, heroPos);
  const plan = planReducedArrival(hand, hp);
  if (!plan.ok) return no(plan.reason);
  if (plan.live.length > maxPlayers) return no(`${plan.live.length} players reach the flop — need 2 to ${maxPlayers}`);
  if (!hp || !plan.live.includes(hp.toUpperCase())) return no("hero is not among the players who reach the flop");
  const stacks = dealt ?? dealtBySeat(hand);
  const ones = () => new Array<number>(1326).fill(1);
  const clamp = (x: unknown) => Math.max(0, Math.min(1, Number(x ?? 0) || 0));

  const start = new Map<string, StartRange>();
  for (const s of [plan.raiser, ...plan.callers]) start.set(s.pos, await startRangeOf(hand, s.seat, s.pos, plan.raiseIndex, ctx.before));

  // THE RAISER: his range before the raise × the share of it that makes the raise, as the exact tree plays it. With
  // neither there is nothing to say who raises here — and a raiser read as "anyone" (or as every hand he limps) is the
  // confident wrong answer this whole piece exists to avoid: refused, said why.
  const rs = start.get(plan.raiser.pos)!;
  const f = ctx.raiseFilter ? await ctx.raiseFilter(plan.raiser.pos).catch(() => null) : null;
  const raiserCombos = f ? normalisedCombos((rs.combos ?? ones()).map((w, i) => w * clamp(f[i]))) : null;
  if (!raiserCombos) {
    return no(`reduced tree: ${plan.raiser.pos}'s raise to ${plan.raiseTo}bb cannot be read on the exact tree ` +
      `(${f ? "none of his starting range makes it there" : "the line up to it does not fit, even for his own actions"}), so there is no range to put behind it`);
  }

  // EACH CALLER (2026-10-04, scripts/callerReadStudy.ts — the forced-bet tree this replaces read him against ANY TWO
  // CARDS posting the raise, because GTO Wizard ignores a seat's range on a preflop tree):
  //   hero      his call as the exact tree plays it, on his starting range; else his starting range whole
  //   all in for less than the raise: his starting range whole (he put the rest of a short stack in)
  //   a LIMPER  his starting range — the pool's limp range — whole: narrowing it did not help in two studies
  //   any other his range on the exact tree, walked on the line fitted for him through his own node, less the hands
  //             that fold there; when that cannot be read, his starting range whole
  type Read = { c: ReducedCaller; combos: number[]; how: string; kind: "exact" | "fit" | "whole"; folded?: string[] };
  const reads: Read[] = await Promise.all(plan.callers.map(async (c): Promise<Read> => {
    const cs = start.get(c.pos)!;
    const whole = (why: string): Read => ({ c, combos: (cs.combos ?? ones()).slice(), kind: "whole", how: `${cs.how}, kept whole — ${why}` });
    if (c.seat === hand.heroSeatId) {
      const cf = ctx.callFilter ? await ctx.callFilter(c.pos).catch(() => null) : null;
      const own = cf ? normalisedCombos((cs.combos ?? ones()).map((w, i) => w * clamp(cf[i]))) : null;
      if (own) return { c, combos: own, kind: "exact", how: `${cs.how}, then his call as the exact tree plays it` };
      return whole("the exact tree cannot read his call");
    }
    if (c.putIn < plan.raiseTo - 0.05) return whole(`taken as not folding (all in for ${c.toCall}bb more)`);
    if (cs.limped) return whole("a limper's call of the raise is not narrowed");
    // A LIMIT ON THE WAIT (reducedReadMs): the read is node reads on the tree already solved — the prefix is cached,
    // his own node on the fitted line may not be — and an unsolved node is otherwise waited on for the ordinary 30 s,
    // per caller, on hero's clock. Past the limit he is kept whole, said so.
    let late = false;
    const limitMs = reducedReadMs();
    const st = ctx.stayRange
      ? await Promise.race([
          ctx.stayRange(c.pos).catch(() => null),
          new Promise<null>((res) => setTimeout(() => { late = true; res(null); }, limitMs)),
        ])
      : null;
    if (!st) {
      return whole(late ? `the exact tree did not return his node within ${limitMs / 1000} s`
        : "the exact tree could not read his answer to the raise, even on a line fitted for him");
    }
    const combos = normalisedCombos(st.range);
    if (!combos) return whole("on the exact tree every hand he holds there folds to the raise, and he did not fold");
    return {
      c, combos, kind: "fit", folded: st.folded,
      how: st.folded.length
        ? `his range on the exact tree, walked on the line fitted for him (${st.folded.join(", ")} folded out), less the hands that fold to the raise at his node there`
        : "his range on the exact tree through his own node, less the hands that fold to the raise there",
    };
  }));

  const ranges: Record<string, Record<string, number>> = { [plan.raiser.pos]: combosToClasses(raiserCombos) };
  for (const x of reads) {
    const rec = combosToClasses(x.combos);
    if (!Object.keys(rec).length) return no(`reduced tree: ${x.c.pos} has no range after the line`);
    ranges[x.c.pos] = rec;
  }
  // hero holds his hand: a class the reads left out of his range is put back, said in the note
  let floored: string | null = null;
  const cards = (hand.heroCards ?? []).map((c) => String(c)).filter((c) => /^[2-9TJQKA][shdc]$/i.test(c));
  if (cards.length === 2) {
    const cls = COMBOS[comboIndex(cards[0]![0]!.toUpperCase() + cards[0]![1]!.toLowerCase(), cards[1]![0]!.toUpperCase() + cards[1]![1]!.toLowerCase())]?.cls;
    const mine = ranges[hp.toUpperCase()];
    if (cls && mine && !(mine[cls]! > 0)) { mine[cls] = HERO_FLOOR; floored = cls; }
  }

  const me = (p: string) => (p === hp.toUpperCase() ? `${p} (hero)` : p);
  const stackOf = (seat: number) => Math.round((stacks[seat] ?? 0) * 2) / 2;
  const fits = reads.filter((x) => x.kind === "fit");
  const fitted = fits.filter((x) => x.folded?.length);
  const note =
    `REDUCED TREE — approximate: the exact preflop tree cannot hold this line (${ctx.why.replace(/^GTO Wizard AI preflop ranges: /, "").slice(0, 160)}), ` +
    `so the flop-entering ranges are read around the last raise, every read on the exact tree. ${me(plan.raiser.pos)} raised to ${plan.raiseTo}bb: ${rs.how}, narrowed by that raise as the exact tree plays it. ` +
    reads.map((x) => `${me(x.c.pos)} met it for ${x.c.toCall}bb more into a pot of ${x.c.potBefore}bb: ${x.how}`).join(". ") + "." +
    (fitted.length
      ? ` A caller read on a fitted line is still read WIDE: measured on ${FIT_WIDE.n} such calls on lines the exact tree holds (one other caller folded out each time, ` +
        `scripts/callerReadStudy.ts) the read keeps ${FIT_WIDE.kept}% of his range where his own node keeps ${FIT_WIDE.truth}%.`
      : "") +
    (reads.some((x) => x.kind === "whole" && start.get(x.c.pos)!.limped)
      ? ` A limper's range is the pool's whole limp range, wide by design: on lines the exact tree holds his node keeps ${FIT_WIDE.limpTruth}% of it (${FIT_WIDE.limpN} calls), ` +
        `and a small blind who completed behind a limper keeps only ${FIT_WIDE.sbCompleteTruth}.`
      : "") +
    ` Not modelled: the folded players' cards; the calls between a player's entry and the last raise where the pool's or the full range stands in; ` +
    `and of the hands that continue, which ones re-raise instead of calling (the player called).` +
    (floored ? ` Hero's ${floored} was not in the range read for his line and is kept at ${Math.round(HERO_FLOOR * 100)}%.` : "");
  return {
    ok: true, piece: "gtow-ai-preflop",
    id: `gtow-ai · reduced · ${plan.raiser.pos}:${stackOf(plan.raiser.seat)} raises ${plan.raiseTo} / ${reads.map((x) => `${x.c.pos}:${stackOf(x.c.seat)}`).join("/")}`,
    ranges, tokens: ctx.tokens, seatOrder: ctx.seatOrder, note,
    reduced: { why: ctx.why, live: plan.live, fitted: fits.length },
  };
}

/** How wide the fitted caller read still is (scripts/callerReadStudy.ts, 2026-10-04 — measured, see its header): the
 *  share of his range he keeps against the exact tree's. Said in the note so nobody reads the flop range as exact. */
const FIT_WIDE = { n: 22, truth: 18, kept: 31, limpN: 25, limpTruth: 56, sbCompleteTruth: "1-24%" } as const;

/** One decision on the preflop path, in the shape the range looker draws (the chart path's shape too). */
export interface PreflopPathStep {
  /** the seat to act, in the table's position names */
  pos: string;
  /** the tree path before this decision */
  line: string;
  /** the node's actions, in its order */
  actions: string[];
  /** the seat's whole range at the node by class: w = combos in range, acts[i] = combos taking actions[i] */
  strategy: Record<string, { w: number; acts: number[] }>;
  /** the action the line took here */
  taken: string;
  /** the seat's range after it (w = combos); null after a fold */
  rangeOut: Record<string, { w: number }> | null;
  /** the table's action is not in the tree: the line fit read it as a fold */
  fitted?: boolean;
}
export interface PreflopPathView { ok: true; id: string; line: string; steps: PreflopPathStep[]; note: string }

/**
 * THE RANGE LOOKER'S AI PREFLOP (2026-09-24, Brady: "we don't get the range of what a BB raise 10 looks like").
 * An AI preflop answer stores no node, so the hand page rebuilds a tree from the archived hand — the same
 * shapeOf / lineOf / menus the answer uses, over the WHOLE preflop line, so one tree holds every decision's node,
 * the villains' included — and reads each node on the path: the actor's strategy by class and its range either
 * side. The solution is cached per shape for the process's life, else created again (GTO Wizard quota: the page
 * asks only on a click). It is not always the answer's own tree: that one was built from the line up to its
 * decision, with the sizes known then; the note says what was rebuilt. The dead money the live answer keeps in the
 * pot for a fitted-out limper is not repeated here.
 *
 * `dealt` (seat → stack as dealt, bb) is what the tree is built with: the caller passes the logged tree's own stacks
 * (dealtFromTreeId) so the rebuild is the tree that answered — an archived row's money is the END of the hand's
 * (utils/archivedHand, hand 723: without it the SB and BB came out 1bb short and 2bb long).
 */
export async function preflopPathView(hand: ParsedHand, heroPos: string | null, dealt?: Record<number, number>): Promise<PreflopPathView | { ok: false; reason: string }> {
  const shape = shapeOf(hand, heroPos, 0, undefined, dealt);
  if ("error" in shape) return { ok: false, reason: shape.error };
  const { tokens, levels } = lineOf(hand, shape);
  const m = menus(levels, shape.n);
  const sol = await ensureSolution(treeKeyOf(shape, m), treeBody(shape, m), { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: sol.error };
  // the line as the tree holds it: sizes snapped to its own, one limper fitted out when it holds fewer
  const notes: string[] = [];
  let fixed: { line: string; changed: string[]; folds?: string[] } | { error: string } = await repairLine(sol.solId, tokens);
  if ("error" in fixed && /is not offered/.test(fixed.error)) fixed = (await fitAiLine(sol.solId, tokens, shape)) ?? fixed;
  if ("error" in fixed) return { ok: false, reason: `the line '${tokens.join("-") || "root"}' could not be walked — ${fixed.error}` };
  if (fixed.changed.length) notes.push(`sizes snapped to the tree's own: ${fixed.changed.join(", ")}`);
  const fitted = new Set(fixed.folds ?? []);
  if (fitted.size) notes.push(`the tree holds one limper, so ${[...fitted].join(" and ")} was read as a fold`);
  const handPosOf: Record<string, string> = {};
  for (const [hp, ap] of Object.entries(shape.apiOf)) handPosOf[ap] = hp;
  const codes = fixed.line ? fixed.line.split("-") : [];
  const steps: PreflopPathStep[] = [];
  const walked = await walkArrivalRanges(shape, codes, (ln) => fetchNode(sol.solId, ln), 6, (s) => {
    const sols = (s.node.action_solutions as any[]) ?? [];
    steps.push({
      pos: handPosOf[s.actor] ?? s.actor, line: s.line, actions: sols.map((a) => labelOf(a.action)),
      strategy: classStrategyOf(s.before, sols), taken: labelOf(s.taken?.action),
      rangeOut: s.token === "F" ? null : classRangeOf(s.after),
      ...(s.token === "F" && fitted.has(s.actor) ? { fitted: true } : {}),
    });
  });
  // everyone folding to one player still walks the whole line; only a node that could not be read is a failure
  if (!walked.ok && steps.length < codes.length) return { ok: false, reason: walked.reason };
  return {
    ok: true, id: `gtow-ai · ${shape.n}-handed · ${shape.positions.map((p) => `${p}:${shape.stacks[p]}`).join("/")}`,
    line: codes.join("-"), steps,
    note: [`rebuilt from the archived hand over the whole preflop line: ${shape.n}-handed, ${shape.positions.map((p) => `${p} ${shape.stacks[p]}bb`).join(", ")}`, ...notes].join(" · "),
  };
}

/** 1,326 weights + a node's per-combo strategies → classGrid's shape (w and acts in combos). */
function classStrategyOf(w: number[], sols: any[]): Record<string, { w: number; acts: number[] }> {
  const out: Record<string, { w: number; acts: number[] }> = {};
  for (let i = 0; i < COMBOS.length; i++) {
    const x = w[i] ?? 0;
    if (x <= 0) continue;
    const e = (out[COMBOS[i]!.cls] ??= { w: 0, acts: new Array(sols.length).fill(0) });
    e.w += x;
    sols.forEach((a, ai) => { e.acts[ai] += x * Number(a.strategy?.[i] ?? 0); });
  }
  for (const e of Object.values(out)) { e.w = Math.round(e.w * 1000) / 1000; e.acts = e.acts.map((x) => Math.round(x * 1000) / 1000); }
  return out;
}
/** 1,326 weights → a class range in combos. */
function classRangeOf(w: number[]): Record<string, { w: number }> {
  const out: Record<string, { w: number }> = {};
  for (let i = 0; i < COMBOS.length; i++) { const x = w[i] ?? 0; if (x > 0) (out[COMBOS[i]!.cls] ??= { w: 0 }).w += x; }
  for (const e of Object.values(out)) e.w = Math.round(e.w * 1000) / 1000;
  return out;
}

/**
 * One seat at a live decision node: its range arriving there, by class (w = combos), for the side panel's grids — and,
 * for a seat that acted on this street before hero, its ACTION CHART at its last decision there (Brady, 2026-10-01:
 * "if we are facing our opponents' action … we want to see our opponent's action chart"): the actions it had, its
 * whole range at that node split by them, and the one it took.
 */
export interface LiveNodeSeat {
  pos: string; stack: number | null; range: Record<string, { w: number }>;
  action?: LiveNodeAction;
}
export interface LiveNodeAction {
  actions: string[];
  strategy: Record<string, { w: number; acts: number[] }>;
  taken: string | null;
  takenIndex: number | null;
  /** the share of the seat's range at that node taking the action it took (0..100), or null */
  takenPct: number | null;
}
/** The share of a strategy's combos on action `i`, in percent. */
export function actionPct(strategy: Record<string, { w: number; acts: number[] }>, i: number | null): number | null {
  if (i === null || i < 0) return null;
  let n = 0, d = 0;
  for (const e of Object.values(strategy)) { n += e.acts[i] ?? 0; d += e.w; }
  return d > 0 ? Math.round((1000 * n) / d) / 10 : null;
}
/** THE RANGES AT THE DECISION IN FRONT OF HERO (routes/dashboard.ts /live-node, 2026-09-30): one shape for both streets. */
export interface LiveNodeView {
  ok: true;
  source: "gtow-ai-preflop" | "ai-chain";
  street: string;
  board: string[];
  line: string;
  heroCards: string[];
  hero: { pos: string; stack: number | null; actions: string[]; strategy: Record<string, { w: number; acts: number[] }> | null;
          range: Record<string, { w: number }> } | null;
  opponents: LiveNodeSeat[];
  note: string | null;
}

/**
 * THE LIVE PREFLOP NODE, FROM ITS PIN (2026-09-30, Brady: the on-demand answer plus "the equilibrium ranges for both
 * opponents, in the same way it is shown" on the hand page). An AI preflop answer stores no solve; what it leaves is
 * the pin (services/preflopPin): the solution and the tree's own codes up to hero's node. The walk over those codes
 * conditions every seat's 1,326 weights on what it did to get here (a seat yet to act keeps its whole range — its
 * "arrival" range IS its range at the node), hero's node is read for its strategy, and a seat that folded is gone.
 * `get` is the node getter (tests feed synthetic nodes; live reads the solved tree).
 */
export async function livePreflopNodeView(
  pin: import("./preflopPin").AiPreflopPin,
  heroCards: string[] = [],
  get: (line: string) => Promise<{ data: any; cached?: boolean } | { error: string }> = (ln) => fetchNode(pin.solId, ln),
): Promise<LiveNodeView | { ok: false; reason: string }> {
  const shape = pin.shape;
  const codes = pin.codes;
  const weights = new Map<string, number[]>(shape.positions.map((p) => [p, new Array(1326).fill(1)]));
  const folded = new Set<string>();
  const lastAction = new Map<string, LiveNodeAction>();
  if (codes.length) {
    const walked = await walkArrivalRanges(shape, codes, get, 6, (s) => {
      // the seat's action chart at this decision — its range BEFORE it, split by the node's actions; the last one wins
      const sols: any[] = s.node.action_solutions ?? [];
      const strategy = classStrategyOf(s.before, sols);
      const takenIndex = s.taken ? sols.indexOf(s.taken) : -1;
      lastAction.set(s.actor, { actions: sols.map((a) => labelOf(a.action)), strategy, taken: s.taken ? labelOf(s.taken.action) : null,
                                takenIndex: takenIndex >= 0 ? takenIndex : null, takenPct: actionPct(strategy, takenIndex >= 0 ? takenIndex : null) });
      weights.set(s.actor, s.after);
      if (s.token === "F") folded.add(s.actor);
    });
    // the walk's own verdict on the seats left is the flop's (2..6); a node it could not read is the only failure here
    if (!walked.ok && !/players reach the flop/.test(walked.reason)) return { ok: false, reason: walked.reason };
  }
  const line = codes.join("-");
  const node = await get(line);
  if ("error" in node) return { ok: false, reason: `hero's node '${line || "root"}' — ${node.error}` };
  const j = node.data;
  const actor: string | null = j.game?.players?.find((p: any) => p.is_hero)?.position ?? shape.heroApiPos ?? null;
  if (!actor) return { ok: false, reason: `node '${line || "root"}' names no player to act` };
  const sols: any[] = j.action_solutions ?? [];
  const handPosOf: Record<string, string> = {};
  for (const [hp, ap] of Object.entries(shape.apiOf)) handPosOf[ap] = hp;
  const heroW = weights.get(actor) ?? new Array(1326).fill(1);
  const seat = (p: string): LiveNodeSeat => ({ pos: handPosOf[p] ?? p, stack: shape.stacks[p] ?? null, range: classRangeOf(weights.get(p) ?? []) });
  return {
    ok: true, source: "gtow-ai-preflop", street: "preflop", board: [], line, heroCards,
    hero: { ...seat(actor), actions: sols.map((a) => labelOf(a.action)), strategy: classStrategyOf(heroW, sols) },
    // preflop is one street: every opponent who acted before hero shows his action chart; one yet to act, his range
    opponents: shape.positions.filter((p) => p !== actor && !folded.has(p)).map((p) => {
      const a = lastAction.get(p);
      return a ? { ...seat(p), action: a } : seat(p);
    }),
    note: pin.reduced?.droppedPos.length ? `a last-resort tree: ${pin.reduced.droppedPos.join(", ")} folded out${pin.shape.deadBb ? " as dead money" : ", none of their chips in it"}` : null,
  };
}

/**
 * RESUME AN AI-PREFLOP PIN AT THE FLOP (services/preflopPin, 2026-09-25). The pinned solution is the one that
 * answered hero's last preflop decision; its line is walked onto the tree's sizes (hero's own included) and every
 * seat's arrival range is read on it. Nothing is built: the prefix nodes were pre-fetched when the pin was written,
 * hero's node is the answer's, and only what happened after hero's decision is read fresh. A last-resort pin holds
 * hero and the last aggressor only, so it resumes only when every other seat has folded — otherwise the caller
 * falls through to the full walk. `get` is injectable for tests.
 */
export async function resumeAiPreflopRanges(
  pin: AiPreflopPin,
  hand: ParsedHand,
  heroPos: string | null,
  maxPlayers: SeatCap,
  get?: (line: string) => Promise<{ data: any; cached?: boolean } | { error: string }>,
): Promise<ResumeOutcome> {
  const network = !get;
  const read = get ?? ((line: string) => fetchNode(pin.solId, line));
  let walked = hand;
  /** a last-resort pin: the reduced tree's two seat names → the seats those players hold at the table */
  let tableSeat: Record<string, string> | null = null;
  const tableHeroPos = heroPos;
  if (pin.reduced) {
    const foldedPos = new Set(hand.actions.filter((a) => a.type === "fold").map((a) => hand.positions[a.seatId]?.toUpperCase()).filter(Boolean));
    const stillIn = pin.reduced.droppedPos.filter((p) => !foldedPos.has(p));
    if (stillIn.length) return { ok: false, why: `the pinned last-resort tree holds hero and the aggressor only, but ${stillIn.join("/")} reached the flop` };
    const red = reduceToHeadsUp(hand, heroPos);
    if (!red) return { ok: false, why: "the pinned last-resort reduction could not be rebuilt from the hand" };
    walked = red.hand;
    heroPos = red.hand.positions[red.hand.heroSeatId] ?? null;
    tableSeat = { SB: red.keptPos[0], BB: red.keptPos[1] };
  }
  const { tokens: tokensNow } = lineOf(walked, pin.shape);
  const fit = pinRest(pin, tokensNow);
  if (!fit.ok) return fit;
  await pin.warm;   // the prefix pre-fetch, normally long done
  // the nodes after hero's pinned decision, asked for together from the pinned codes + the raw rest (2026-10-01)
  if (network) prefetchPrefixes(pin.solId, [...pin.codes, ...fit.rest]);
  let reads = 0;
  const counted = async (line: string) => { const n = await read(line); if (!("error" in n) && !n.cached) reads++; return n; };
  const repaired = await repairLineWith(tokensNow, counted);
  if ("error" in repaired) return { ok: false, why: `pinned AI tree ${pin.id}: ${repaired.error}` };
  const codes = repaired.line ? repaired.line.split("-") : [];
  const r = await walkArrivalRanges(pin.shape, codes, counted, maxPlayers);
  if (!r.ok) return { ok: false, why: `pinned AI tree ${pin.id}: ${r.reason}` };
  // A LAST-RESORT PIN ANSWERS IN THE TABLE'S TERMS (2026-10-02, hand 4922086187). The reduced tree is heads-up, so
  // its two seats are called SB and BB whoever they are at the table (hero on the BTN against the small blind: hero
  // is its "SB", the small blind its "BB"). The ranges went out under those names: the flop looked for BTN, found
  // none ("reconstructed ranges don't cover both seats"), and under "SB" held HERO's range for the villain's seat.
  // So each range goes back to the seat its player holds — and the pot is rolled from the hand's own line in the
  // table's seat order, which counts the folded players' chips the reduced line leaves out (they are its dead money).
  let ranges = r.ranges, tokens = tokensNow, seatOrder: readonly string[] | undefined = pin.shape.positions;
  if (tableSeat) {
    ranges = Object.fromEntries(Object.entries(r.ranges).map(([p, w]) => [tableSeat![p.toUpperCase()] ?? p, w]));
    const table = shapeOf(hand, tableHeroPos);
    if (!("error" in table)) { tokens = lineOf(hand, table).tokens; seatOrder = table.positions; }
  }
  return {
    ok: true, ranges, tokens, codes, seatOrder, id: pin.id, reads,
    note: `PREFLOP RANGES FROM THE PIN: the GTO Wizard AI preflop tree that answered hero's last preflop decision ` +
      `(${pin.shape.n}-handed, ${pin.shape.positions.map((p) => `${p} ${pin.shape.stacks[p]}bb`).join(", ")}; hero's node at "${pin.codes.join("-") || "root"}") — ` +
      `hero's action and ${fit.rest.length - 1} later action(s) read on the same solution, no tree rebuilt` +
      (repaired.changed.length ? ` · sizes snapped to the tree's own: ${repaired.changed.join(", ")}` : "") +
      (pin.reduced ? ` · LAST RESORT tree: ${pin.reduced.droppedPos.join(", ")} folded out${pin.shape.deadBb ? " with their chips as dead money" : ", none of their chips in the tree"}` : ""),
  };
}

/** repairLine over an injected node getter (the pin's resume counts its reads and tests feed synthetic nodes). */
async function repairLineWith(tokens: string[], get: (line: string) => Promise<{ data: any } | { error: string }>): Promise<{ line: string; changed: string[] } | { error: string }> {
  const out: string[] = [];
  const changed: string[] = [];
  for (const tok of tokens) {
    const at = out.join("-");
    const node = await get(at);
    if ("error" in node) return { error: `walking '${at || "root"}': ${node.error}` };
    const sols = (node.data?.action_solutions as any[]) ?? [];
    const pick = matchToken(tok, sols);
    if (!pick) {
      const offered = sols.map((a) => String(a?.action?.code ?? "?")).join(", ");
      return { error: `'${tok}' is not offered at '${at || "root"}' (offered: ${offered})` };
    }
    if (pick.code !== tok) changed.push(`${tok}→${pick.code}`);
    out.push(pick.code);
  }
  return { line: out.join("-"), changed };
}
