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
 *     next set up and the SB seat as a GHOST: blind 0.01, stack 0.01, all-in for a penny. Measured
 *     2026-09-23 on hand 732 (HJ first in, 5 dealt): the earlier ghost holding its full 0.5bb blind put
 *     0.5bb of phantom dead money in the pot and made hero limp 1.75% of his range; the penny ghost
 *     removes both (limp 0.01%, raise 20.6% vs 16.1%). Rake cap counts the seats actually dealt.
 *   - one tree per table shape (positions + stacks + blinds + sizes); ~2-4 s to solve the root, 1-2 s
 *     per node after that; solutions are cached per shape for the process's life
 *
 * POSTFLOP (2026-09-19): when this piece answered preflop, the postflop chain conditions on THIS tree's
 * ranges — arrivalRangesGtowAi walks the same solved tree and exposes the chart piece's shape (position →
 * class → weight), so fastSolve.solvePostflop6maxStrategy reads one shape whichever piece answered.
 */
import { allInCalls } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { dealtSeats, dealtCount } from "../utils/dealtSeats/dealtSeats";
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
import { gtowSessions, type GtowNeed, type GtowSessionId } from "./gtowSessions";
import { gtowRequests } from "./gtowRequestLog";
import { comboIndex, toClassWeights, COMBOS } from "../utils/comboIndex/comboIndex";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";
import { rakeCapCents } from "./profiles";
import { isTestStakeOf } from "./strategies";
import { actorsWithAllins, foldEarliestCaller } from "../utils/fitLine/fitLine";
import { setPreflopPin, pinRest, preflopPinKey, type AiPreflopPin, type ResumeOutcome } from "./preflopPin";

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
/** The dead-SB ghost's blind and stack: all-in for a penny, so it neither adds dead money nor competes for the pot. */
const DEAD_SB_GHOST = 0.01;
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
  shape: AiPreflopShape;
  note: string;
}
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
export type AiPreflopOutcome = AiPreflopResult | { ok: false; reason: string; line?: string; kind?: string };

const round5 = (x: number) => Math.round(x * 2) / 2;
const num = (n: number) => String(Math.round(n * 100) / 100);

/** What an action put in the pot, in the tree's own blinds: the NL5 test stake's 0.4bb small-blind post is the
 *  NL200 game's 0.5 (PF-06 — the same pin shapeOf applies to the blind itself), everything else as recorded. */
const putBb = (hand: ParsedHand, a: ParsedAction): number =>
  a.type === "post-sb" && isTestStakeOf("ign-ring-NL200-6", hand.bbCents) ? 0.5 : (a.amount ?? 0);

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
  // model the missing SB as a ghost all-in for a penny (see the header: measured against the 0.5bb ghost)
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
  for (const p of ordered) {
    const seat = byPos.get(p)!;
    seatOf[apiOf[p]!] = seat;
    // `dealt` already carries the stack AS DEALT (behind + committed + earlier streets, hrc6max.dealtBySeat) —
    // `committed` must not be added again on top of it, or a pinned postflop read double-counts this street's chips.
    const cur = dealt ? dealt[seat] : hand.stacks?.[seat];
    const committed = dealt ? 0 : (hand.committed?.[seat] ?? 0);
    stacks[apiOf[p]!] = Math.min(999, Math.max(1, round5((cur != null ? cur + committed : 100))));
  }
  if (deadSb) stacks.SB = DEAD_SB_GHOST;
  // the cap is by players DEALT — the ghost was not dealt in
  // the LAST RESORT reduces the field to two seats but the table still dealt six: the cap follows the table
  const dealtN = rakeSeats ?? (n - (deadSb ? 1 : 0));
  const rakeCapBb = Math.round((rakeCapCents(dealtN) / bbCents) * 100) / 100;
  // the ANTE and the SITE'S RAKE ride on the shape only when the table has them (CoinPoker ring, 2026-09-30)
  const anteBb = hand.anteBb != null && hand.anteBb > 0 ? Math.round(hand.anteBb * 1000) / 1000 : 0;
  const siteRake = siteRakeOf(hand, dealtN);
  return { n, apiOf, seatOf, positions: set, stacks, sb, bb, straddle: null, rakeCapBb, deadSb, deadBb: Math.max(0, Math.round(deadBb * 100) / 100), heroApiPos: hp ? (apiOf[hp] ?? null) : null,
    ...(anteBb ? { anteBb } : {}), ...(siteRake ? { siteRake } : {}) };
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
  for (let round = 0; round < 4 && cursor < acted.length; round++) {
    for (const api of order) {
      if (cursor >= acted.length) break;
      const a = acted[cursor]!;
      const aApi = posOf(a) ? shape.apiOf[posOf(a)!] ?? null : null;
      if (aApi === api || aApi == null) {
        if (a.type === "fold") tokens.push("F");
        else if (a.type === "check") tokens.push("X");
        else if (a.type === "call" || calls.has(a)) tokens.push("C");   // an all-in for no more than the price is a call
        else if (a.type === "raise" || a.type === "bet" || a.type === "all-in") { const t = a.amount ?? 0; levels.push(t); tokens.push(`R${num(t)}`); }
        else tokens.push("C");
        cursor++;
      } else if (round === 0 && api !== heroApi && !tokens.length && api === "SB") {
        // nothing to pad before the first action in the blinds
      } else if (round === 0 && !levels.length && api !== "SB" && api !== "BB" && !(pendingHero && api === heroApi)) {
        tokens.push("F");   // an early seat with no recorded action before a later seat acted: it folded
      }
    }
  }
  return { tokens, levels };
}

/** Size menus. The tree's size is (sizes per level)^levels × seats, and the API refuses a tree past its ceiling
 *  ("TREE_IS_TOO_BIG" — a 3-handed tree with 5 opens × 3 three-bets tripped it). So HERO's seat carries the menu
 *  (his decision is what we read), every other seat carries the size it actually used (or one default), and the
 *  line's own sizes are always present so the walk lands on the exact node. Heads-up trees are small enough for
 *  the full menu on both seats. */
export function menus(levels: number[], n: number) {
  // THREE DECIMALS, not one (2026-09-19). A rounded ratio puts the tree's node a few
  // hundredths of a blind from the size actually played; repairLine now walks onto it
  // either way, but a menu that lands exactly keeps that walk a rare path rather than
  // the normal one — and keeps the strategy read on the size that was really faced.
  const add = (base: string[], v: number | null) => (v && v > 1 ? [...new Set([...base, `${Math.round(v * 1000) / 1000}x`])] : base);
  const l0 = levels[0] ?? null, l1 = levels[1] && levels[0] ? levels[1] / levels[0] : null;
  const l2 = levels[2] && levels[1] ? levels[2] / levels[1] : null, l3 = levels[3] && levels[2] ? levels[3] / levels[2] : null;
  const hero = n <= 2
    ? { opens: add(OPENS, l0), three: add(THREE_BETS, l1), four: add(FOUR_BETS, l2), five: add(FIVE_PLUS, l3) }
    : { opens: add(["2.2x", "2.5x", "3x"], l0), three: add(["3.5x"], l1), four: add(["2.3x"], l2), five: add(FIVE_PLUS, l3) };
  const villain = n <= 2 ? hero
    : { opens: add(["2.5x"], l0), three: add(["3.5x"], l1), four: add(["2.3x"], l2), five: add(FIVE_PLUS, l3) };
  return { hero, villain };
}

function treeBody(shape: AiPreflopShape, m: ReturnType<typeof menus>) {
  const sizes = (position: string) => {
    const s = position === shape.heroApiPos ? m.hero : m.villain;
    // calls of opens and cold-calls of 3-bets+ must be switched on explicitly in FIXED mode (the web app's own
    // defaults: ccVs2b on, ccVs3bPlus off — we want both, a fish's line is anything)
    return { position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true,
      bet_sizes: s.opens, raise_sizes: s.three, second_raise_sizes: s.four, third_plus_raise_sizes: s.five };
  };
  return {
    starting_street: "PREFLOP", pot: shape.deadBb, ante: shape.anteBb || null, ante_distribution_method: "PER_PLAYER",
    max_allowed_limps: shape.n >= 3 ? 2 : null,
    bet_sizes: { allin_threshold: 60, allin_if_less_than: 500, merge_sizes_threshold: 10, max_num_raises: 5,
      street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: shape.positions.map(sizes) }] },
    players: shape.positions.map((p) => ({
      position: p, display_position: p,
      blind: p === "SB" ? shape.sb : p === "BB" ? shape.bb : (shape.straddle?.pos === p ? shape.straddle.bb : null),
      range: null, stack: shape.stacks[p] ?? 100, tournament_instant_bounty: null, tournament_total_bounty: null,
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
async function ensureSolution(key: string, body: any, need: GtowNeed = {}): Promise<{ solId: string } | { error: string }> {
  const hit = solutions.get(key);
  if (hit) return hit;
  const p = (async () => {
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
      const so = await gtowRequests.fetch(id, "solution", `${API_BASE}/v4/custom-solutions/`, { method: "POST", headers: H, body: JSON.stringify({ custom_tree_id: tree.id, actions: "", board: "" }), signal: AbortSignal.timeout(20_000) });
      if (!so.ok) {
        const b = (await so.text().catch(() => "")).slice(0, 200);
        gtowSessions.noteFailure(id, so.status, b, need);
        last = `custom-solutions ${so.status}: ${b}`;
        continue;
      }
      const sol = await so.json();
      const solId = String(sol.id);
      owners.set(solId, id);
      if (owners.size > 400) owners.delete(owners.keys().next().value as string);
      gtowSessions.noteSuccess(id, { tree: true });
      return { solId };
    }
    return { error: last };
  })();
  solutions.set(key, p);
  p.then((r) => { if ("error" in r) solutions.delete(key); }).catch(() => solutions.delete(key));
  if (solutions.size > 200) solutions.delete(solutions.keys().next().value as string);
  return p;
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

export async function fetchNode(solId: string, line: string): Promise<{ data: any; cached: boolean } | { error: string }> {
  const k = `${solId}|${line}`;
  const hit = nodes.get(k);
  if (hit) return { data: hit, cached: true };
  const terminalError = `line ends the hand at '${line || "root"}' — no decision node`;
  if (terminals.has(k)) return { error: terminalError };
  const t0 = Date.now();
  let last = "the cloud did not return the node in time";
  let emptyPolls = 0;
  let refreshed = false;
  const owner = owners.get(solId) ?? null;
  while (Date.now() - t0 < NODE_TIMEOUT_MS) {
    const token = owner ? await gtowSessions.tokenFor(owner) : (await gtowSessions.bestToken({ preflop: true }))?.token ?? null;
    if (!token) return { error: `no GTO Wizard token for the session that owns this solve${owner ? ` (${owner})` : ""}` };
    const params = new URLSearchParams({ custom_solution_id: solId, preflop_actions: line, flop_actions: "", turn_actions: "", river_actions: "", board: "" });
    let r: Response;
    try { r = await gtowRequests.fetch(owner, "poll", `${API_BASE}/v4/solutions/spot-solution/?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }); }
    catch (e) { last = `poll failed: ${e instanceof Error ? e.message : e}`; await new Promise((res) => setTimeout(res, POLL_MS)); continue; }
    // THE SAME THREE RULES AS gtowApi's node poll (2026-09-25 audit): this copy re-polled an expired token for the whole
    // NODE_TIMEOUT_MS (a lost preflop answer), never told the pool about a wall it hit, and sat out a 429 quota wall
    if (r.status === 401 && !refreshed) {
      refreshed = true;
      if (owner) await gtowSessions.tokenFor(owner, true); else await gtowSessions.forceRefresh();
      continue;
    }
    if (r.ok && r.status !== 204) {
      const j = await r.json().catch(() => null);
      if (j?.action_solutions?.length) { nodes.set(k, j); if (nodes.size > 2000) nodes.delete(nodes.keys().next().value as string); return { data: j, cached: false }; }
      // a 200 with an object body and no action to offer: the spot is solved and nobody is on the clock
      if (j != null && typeof j === "object" && ++emptyPolls >= TERMINAL_POLLS) {
        terminals.add(k);
        if (terminals.size > 2000) terminals.delete(terminals.values().next().value as string);
        return { error: terminalError };
      }
    } else if (!r.ok && r.status !== 404) {
      const t = await r.text().catch(() => "");
      if (r.status === 400 || r.status === 422) return { error: `${r.status}: ${t.slice(0, 160)}` };
      last = `spot-solution ${r.status}: ${t.slice(0, 120)}`;
      if (owner) gtowSessions.noteFailure(owner, r.status, t.slice(0, 200), { preflop: true });   // the NEXT tree goes elsewhere
      if (r.status === 429 || (r.status === 403 && /limit|quota|exceed/i.test(t))) return { error: last };   // a quota wall will not lift while we wait
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  return { error: last };
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
 */
async function repairLine(solId: string, tokens: string[]): Promise<{ line: string; changed: string[] } | { error: string }> {
  const out: string[] = [];
  const changed: string[] = [];
  for (const tok of tokens) {
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
 */
async function fitAiLine(solId: string, tokens: string[], shape: AiPreflopShape, keep: string[] = [], maxFolds = 4):
    Promise<{ line: string; changed: string[]; folds: string[]; tokens: string[] } | null> {
  const keepSet = new Set([shape.heroApiPos, ...keep].filter(Boolean).map((x) => x!.toUpperCase()));
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

/**
 * Solve hero's preflop decision with GTO Wizard AI, from the table as it stands.
 * `why` is the reason the charts could not answer — it rides along in the note so the
 * answer trail says both what answered and why the primary piece did not.
 */
export async function solvePreflopGtowAi(hand: ParsedHand, heroPos: string | null, why: string,
    opts: { deadBb?: number; rakeSeats?: number; /** a last-resort call: the seats folded out of the reduced hand */ reduced?: { droppedPos: string[] } | null } = {}): Promise<AiPreflopOutcome> {
  const t0 = Date.now();
  const shape = shapeOf(hand, heroPos, opts.deadBb ?? 0, opts.rakeSeats);
  if ("error" in shape) return { ok: false, reason: `GTO Wizard AI preflop: ${shape.error}` };
  const { tokens, levels } = lineOf(hand, shape);
  const line = tokens.join("-");
  const m = menus(levels, shape.n);
  const key = treeKeyOf(shape, m);
  const sol = await ensureSolution(key, treeBody(shape, m), { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: `GTO Wizard AI preflop: ${sol.error}`, line };
  // the solution and the line hero's node was finally read on (a fit re-builds the tree with dead money and
  // walks a repaired line) — what the preflop pin records for the flop to resume from
  let usedSol = sol.solId;
  let usedLine = line;
  let node = await fetchNode(sol.solId, line);
  let snapped: string[] = [];
  let fittedFolds: string[] = [];
  let deadNote = "";
  // THE LINE ITSELF IS ILLEGAL (PF-26). NODE_DOES_NOT_EXIST means "a legal line, not under these sizes" and is
  // walked below; 400 VALIDATION_ERROR "Incorrect actions" means the sequence cannot happen in any tree — a
  // capture padded past a terminal or otherwise corrupt. Say so, as a capture fault, and let the caller stop:
  // walking it would fail the same way and the last resort would only re-solve the same corrupt line heads-up.
  if ("error" in node && /VALIDATION_ERROR|Incorrect actions/i.test(node.error)) {
    return { ok: false, kind: CAPTURE_FAULT, line,
      reason: `GTO Wizard AI preflop: the captured line '${line || "root"}' is not a legal betting sequence (VALIDATION_ERROR)` };
  }
  if ("error" in node && /NODE_DOES_NOT_EXIST/i.test(node.error)) {
    // the tree has this line, just not under the sizes we named — walk it and find out
    let fixed: { line: string; changed: string[] } | { error: string } = await repairLine(sol.solId, tokens);
    if ("error" in fixed && /is not offered/.test(fixed.error)) {
      const fit = await fitAiLine(sol.solId, tokens, shape);
      if (fit) { fixed = fit; fittedFolds = fit.folds; }
    }
    if ("error" in fixed) {
      return { ok: false, reason: `GTO Wizard AI preflop: node '${line || "root"}' does not exist and the line could not be walked — ${fixed.error}`, line };
    }
    snapped = fixed.changed;
    // THE FOLDED-OUT PLAYERS' CHIPS STAY IN THE POT (2026-09-23). The fit folds a limper or caller the API's tree
    // cannot hold; until now his chips left with him, so hero faced the real raise at the wrong price. The API
    // accepts dead money (`pot`; probed: 1bb dead moves an SB complete from 29% to 65% with A5s), so the tree is
    // rebuilt with what the folded seats had put in, and the fitted line is read on that tree instead.
    let solId = sol.solId;
    if (fittedFolds.length) {
      const handPosOf: Record<string, string> = {};
      for (const [hp, ap] of Object.entries(shape.apiOf)) handPosOf[ap] = hp;
      let dead = 0;
      for (const api of fittedFolds) {
        const hp = handPosOf[api];
        const seat = Object.entries(hand.positions).find(([, p]) => p.toUpperCase() === hp)?.[0];
        if (seat == null) continue;
        const put = hand.actions.filter((x) => x.street === "preflop" && (x.hero ? hand.heroSeatId : x.seatId) === Number(seat));
        const lastRaise = [...put].reverse().find((x) => x.type === "raise" || x.type === "bet" || x.type === "all-in");
        dead += lastRaise ? (lastRaise.amount ?? 0) : put.filter((x) => x.type === "call" || x.type === "post-sb" || x.type === "post-bb").reduce((acc, x) => acc + putBb(hand, x), 0);
      }
      if (dead > 0) {
        const shape2 = shapeOf(hand, heroPos, (opts.deadBb ?? 0) + dead, opts.rakeSeats);
        if (!("error" in shape2)) {
          const sol2 = await ensureSolution(treeKeyOf(shape2, m), treeBody(shape2, m), { multiway: shape2.n > 2, preflop: true });
          if (!("error" in sol2)) { solId = sol2.solId; deadNote = `${Math.round(dead * 100) / 100}bb of the folded players' chips kept in the pot as dead money`; }
        }
      }
    }
    usedSol = solId;
    usedLine = fixed.line;
    node = await fetchNode(solId, fixed.line);
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
  const idx = hand.heroCards.length === 2 ? comboIndex(hand.heroCards[0]!, hand.heroCards[1]!) : null;
  if (idx == null) return { ok: false, reason: "GTO Wizard AI preflop: hero's cards are not known", line };
  // the node's per-combo strategy is a 0-1 fraction; our chart mixes are PERCENT (Q8o: {Fold: 99.97}), and
  // the panel text / hand card format them as such — so the fallback speaks percent too
  let actions = (j.action_solutions as any[]).map((a) => ({ action: labelOf(a.action), frequency: Number(a.strategy?.[idx] ?? 0) }));
  const sum = actions.reduce((s, a) => s + a.frequency, 0);
  if (sum <= 1.5) actions = actions.map((a) => ({ ...a, frequency: a.frequency * 100 }));
  actions = actions.filter((a) => a.frequency > 0.05).map((a) => ({ ...a, frequency: Math.round(a.frequency * 100) / 100 }));
  const decision = actions.length ? pickWeightedAction(actions) : null;
  const secs = (Date.now() - t0) / 1000;
  // THE PIN (services/preflopPin): this tree, this line, hero to act — the flop resumes here. Every prefix node is
  // pre-fetched in the background so the resume finds them cached; the answer never waits for it.
  const codes = usedLine ? usedLine.split("-") : [];
  const handKey = preflopPinKey(hand);
  if (handKey) {
    const warm = (async () => { for (let k = 0; k < codes.length; k++) await fetchNode(usedSol, codes.slice(0, k).join("-")); })().catch(() => undefined);
    setPreflopPin({
      piece: "gtow-ai-preflop", handKey, solId: usedSol, shape, codes, rawTokens: tokens, warm,
      id: `gtow-ai · ${shape.n}-handed · ${shape.positions.map((p) => `${p}:${shape.stacks[p]}`).join("/")}`,
      heroPos: heroPosOf(hand, heroPos) ?? "", reduced: opts.reduced ?? null, actionIndex: hand.actions.length, at: Date.now(),
    } satisfies AiPreflopPin, hand.heroCards.join(""));
  }
  const shapeText = `${shape.n}-handed · ${shape.positions.map((p) => `${p} ${shape.stacks[p]}bb`).join(", ")} · rake 5% cap ${shape.rakeCapBb}bb${shape.deadSb ? " · dead SB approximated" : ""}${shape.deadBb ? ` · ${shape.deadBb}bb dead money in the pot` : ""}`;
  return {
    ok: true, actions, decision, line, pos: shape.heroApiPos, heroClass: heroClass(hand.heroCards), treeKey: key,
    solId: usedSol, usedLine, solveSecs: secs, cached: node.cached, shape,
    note: `GTO Wizard AI preflop (Ultra) answered because the 6-max charts could not: ${why}. Tree built from the table — ${shapeText}; solved in ${secs.toFixed(1)} s${node.cached ? " (cached)" : ""}.`
      + (snapped.length ? ` Sizes snapped to the tree's own: ${snapped.join(", ")}.` : "")
      + (fittedFolds.length ? ` LINE FITTED TO THE TREE: GTO Wizard's tree holds one limper, so ${fittedFolds.join(" and ")}'s limp/call was read as a FOLD (the earliest one who does not raise later) — hero faces one player fewer than at the table${deadNote ? `, with ${deadNote}` : ""}.` : ""),
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
// still has: HERO and the LAST AGGRESSOR. Everyone else is folded out and every chip they put in stays in the
// pot as dead money, so hero faces the real raise at the real price, from the real stacks, against the player
// who actually made it. What it loses: the folded players' ranges and anyone still to act behind hero. That is
// an approximation, said out loud in the answer, and it beats a blank.
// ---------------------------------------------------------------------------
const ORBIT = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

export interface HeadsUpReduction { hand: ParsedHand; deadBb: number; aggressorPos: string; keptPos: [string, string]; droppedPos: string[]; heroPos: string }

/** Hero versus the last aggressor, the rest folded, their chips as dead money. null when hero's seat is unknown. */
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

/** The last resort answer: the heads-up reduction solved as a GTO Wizard AI tree with the dead money in the pot. */
export async function solvePreflopLastResort(hand: ParsedHand, heroPos: string | null, why: string): Promise<AiPreflopOutcome> {
  const red = reduceToHeadsUp(hand, heroPos);
  if (!red) return { ok: false, reason: "last resort: hero's seat or the opponent's could not be read" };
  const dealt = dealtCount(hand, heroPos);   // the players DEALT (a sitting-out label is not one — utils/dealtSeats)
  const r = await solvePreflopGtowAi(red.hand, red.hand.positions[red.hand.heroSeatId] ?? null, why, { deadBb: red.deadBb, rakeSeats: dealt, reduced: { droppedPos: red.droppedPos } });
  if (!r.ok) return { ok: false, kind: r.kind, reason: `last resort (hero vs ${red.aggressorPos}, ${red.droppedPos.join("/") || "nobody"} folded out): ${r.reason}` };
  const note = `LAST RESORT — no tree holds this line, so it is played as hero (${red.heroPos}) against the last aggressor (${red.aggressorPos}) alone: ` +
    `${red.droppedPos.length ? `${red.droppedPos.join(", ")} folded out with their ${red.deadBb}bb left in the pot as dead money` : "nobody else in the pot"}; ` +
    `the folded players' ranges and anyone still to act behind hero are not modelled. ` + r.note;
  return { ...r, pos: red.heroPos, note };
}

/** The exact request a hand would produce (for tests and the state tester — nothing is sent). */
export function debugTree(hand: ParsedHand, heroPos: string | null): { shape: AiPreflopShape; line: string; body: any } | { error: string } {
  const shape = shapeOf(hand, heroPos);
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
  const repaired = await repairLine(sol.solId, tokens);
  const codes = "error" in repaired ? tokens : repaired.line.split("-").filter(Boolean);
  const first = await walkArrivalRanges(shape, codes, get, maxPlayers);
  if (first.ok || !/is not an action/.test(first.reason)) return first;
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
    if (!fit) return first;
    fit.folds.forEach((f) => folded.add(f));
    const r = await walkArrivalRanges(shape, fit.tokens, get, 6);
    if (!r.ok) return first;
    const key = handPosOf[p] ?? p;
    const rec = r.ranges[key];
    if (!rec) return first;
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
      (shape.deadSb ? " · dead SB approximated" : ""),
  };
}

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
  get: (line: string) => Promise<{ data: any; cached?: boolean } | { error: string }> = (line) => fetchNode(pin.solId, line),
): Promise<ResumeOutcome> {
  let walked = hand;
  if (pin.reduced) {
    const foldedPos = new Set(hand.actions.filter((a) => a.type === "fold").map((a) => hand.positions[a.seatId]?.toUpperCase()).filter(Boolean));
    const stillIn = pin.reduced.droppedPos.filter((p) => !foldedPos.has(p));
    if (stillIn.length) return { ok: false, why: `the pinned last-resort tree holds hero and the aggressor only, but ${stillIn.join("/")} reached the flop` };
    const red = reduceToHeadsUp(hand, heroPos);
    if (!red) return { ok: false, why: "the pinned last-resort reduction could not be rebuilt from the hand" };
    walked = red.hand;
    heroPos = red.hand.positions[red.hand.heroSeatId] ?? null;
  }
  const { tokens: tokensNow } = lineOf(walked, pin.shape);
  const fit = pinRest(pin, tokensNow);
  if (!fit.ok) return fit;
  await pin.warm;   // the prefix pre-fetch, normally long done
  let reads = 0;
  const counted = async (line: string) => { const n = await get(line); if (!("error" in n) && !n.cached) reads++; return n; };
  const repaired = await repairLineWith(tokensNow, counted);
  if ("error" in repaired) return { ok: false, why: `pinned AI tree ${pin.id}: ${repaired.error}` };
  const codes = repaired.line ? repaired.line.split("-") : [];
  const r = await walkArrivalRanges(pin.shape, codes, counted, maxPlayers);
  if (!r.ok) return { ok: false, why: `pinned AI tree ${pin.id}: ${r.reason}` };
  return {
    ok: true, ranges: r.ranges, tokens: tokensNow, codes, seatOrder: pin.shape.positions, id: pin.id, reads,
    note: `PREFLOP RANGES FROM THE PIN: the GTO Wizard AI preflop tree that answered hero's last preflop decision ` +
      `(${pin.shape.n}-handed, ${pin.shape.positions.map((p) => `${p} ${pin.shape.stacks[p]}bb`).join(", ")}; hero's node at "${pin.codes.join("-") || "root"}") — ` +
      `hero's action and ${fit.rest.length - 1} later action(s) read on the same solution, no tree rebuilt` +
      (repaired.changed.length ? ` · sizes snapped to the tree's own: ${repaired.changed.join(", ")}` : "") +
      (pin.reduced ? ` · LAST RESORT tree: ${pin.reduced.droppedPos.join(", ")} folded out with their chips as dead money` : ""),
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
