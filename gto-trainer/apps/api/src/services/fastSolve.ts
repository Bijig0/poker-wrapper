import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { buildPreflopTokens, buildPreflopTokensHu, buildPreflopTokens3max, buildSpotSolutionTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { chartFor, fetchNode, walk3max } from "./hrc3max";
import { chartFor6max, resolveChart6max, nodeGetter, dealtBySeat, dealtEffective } from "./hrc6max";
import { chartForHu, resolveChartHu, nodeGetterHu, isHeadsUp, defaultChartHu, neighbourRungsHu, HU_ANTE_BB, HU_RAKE } from "./hrc2max";
import { preflopArrivalFor } from "./strategies";
import { alignStrategy, blendStrategies, collapseRefusal, pickCollapses, planCollapses, type SeatTok } from "./multiwayCollapse";
import { rerootCollapse, moneyThrough } from "./multiwayReroot";
import { borrowHeroCall } from "../utils/borrowHeroCall/borrowHeroCall";
import { captureFaults, repairPostflopCapture, repairDeadSmallBlind, repairPreflopFoldOrder } from "../utils/repairPostflopRotation/repairPostflopRotation";
import { missQueue } from "./missQueue";
import { preflopDb } from "./preflopDb";
import { gtowApi } from "./gtowApi";
import { SOLUTION_SETS } from "./gtowCdp";
import { parseHandClass } from "../utils/parseHandClass/parseHandClass";
import { comboIndex } from "../utils/comboIndex/comboIndex";
import { solveStore } from "./solveStore";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";
import { snapPreflopLine } from "../utils/snapPreflopLine/snapPreflopLine";
import { SNAP_TAU, SNAP_MAX } from "../utils/snapToken/snapToken";
import type { Walk3Repair } from "./hrc3max";
import { walkFitted, foldSeatsOut, actorsWithAllins } from "../utils/fitLine/fitLine";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { deriveExploitSpot } from "../utils/deriveExploitSpot/deriveExploitSpot";
import { solveAiChain, type AiChainResult } from "./aiChain";
import { tmark } from "./answerTrace";
import { applyRiverMes, type RiverMesInput } from "./riverMes";
import { HU_SEATS, preflopClosed, preflopPotStack } from "../utils/aiStudyLine/aiStudyLine";
import { mesPostflopLookup, mesRiverContext } from "./mesPostflop";
import { mesRiverLookup } from "./mesRiver";
import { rakeCapCents } from "./profiles";
import { POSTFLOP_ORDER } from "../utils/aiStudyLine/aiStudyLine";
import { THREE_WAY_SIZES } from "./gtowApi";
import type { AiChainSpec } from "./aiChain";
import { nodeTrust } from "./nodeTrust";
import { solvePreflopGtowAi, solvePreflopLastResort, warmPreflopGtowAi, arrivalRangesGtowAi, GTOW_AI_PREFLOP_SOURCE, GTOW_AI_PREFLOP_TIER, type AiPreflopOutcome } from "./gtowAiPreflop";
import { answerLog } from "./answerLog";
import { postInNote } from "../utils/foldPostIns/foldPostIns";
import { setPreflopPin, getPreflopPin, preflopPinKey, resumeChartPreflopRanges, fittedRangesBySeat, heroDeviation, forgetPreflopPin as forgetPreflopPinInner, type ResumeOutcome } from "./preflopPin";
import { resumeAiPreflopRanges } from "./gtowAiPreflop";
import { dropPrunedPicks, prunedPicksNote } from "./prunedPicks";

/**
 * Fast-solver: answer a hand node the clean way — the local crawled preflop
 * charts for preflop, and a GTO Wizard AI custom solve for postflop (observed
 * pot/stack/board, chart-reconstructed ranges) — with no live GTO Wizard DOM
 * navigation. The pre-solved spot-solution library is kept only as a postflop
 * backup for when the cloud solve itself fails. See [[gtow-preflop-local-db]]
 * and services/gtowApi.ts.
 */

export interface FastSolveOpts {
  setId?: string;
  depth?: number;
  heroPos?: string | null;
  /** The DECLARED strategy (services/strategies.ts id). It alone decides which
   *  preflop piece answers — see preflopArrivalFor. Pass this from any caller that
   *  has a session; `strategy` below is the low-level override for callers that
   *  have no strategy to declare (the playthrough tester, offline sweeps). */
  strategyId?: string | null;
  /** Low-level override of the preflop piece, for callers with no declared
   *  strategy. Ignored when `strategyId` is given. */
  strategy?: "exploit" | "chart";
  /** Who is asking — recorded on every stored AI-chain solve ("live" from the
   *  study poller, "replay" from the dashboard's re-solve, else "adhoc"). */
  origin?: string;
  /** The wrapper's declared session, stamped on the stored trace. */
  sessionId?: string | null;
}

interface ActionFreq {
  action: string;
  frequency: number;
  ev?: number;
  betsize?: string;
}

export type FastSolveResult =
  | {
      ok: true;
      source: "local-preflop" | "hrc-3max-preflop" | "hrc-6max-preflop" | "hrc-hu-preflop" | "pool-exploit-preflop" | "gtow-api-postflop" | "mes-postflop" | "gtow-ai-preflop";
      /** which cascade layer answered. */
      tier?: "library-exact" | "library-snap" | "far-snap" | "ai-exact" | "ai-chain" | "chart-3max" | "chart-6max" | "chart-hu" | "exploit-3max" | "exploit-postflop" | "ai-preflop";
      /** Both preflop strategies when the exploit overlay covers the spot:
       *  the pool best-response and the equilibrium chart's pick. `decision`
       *  equals one of them per `strategyMode`. */
      exploitDecision?: WeightedPick;
      chartDecision?: WeightedPick;
      exploitTag?: string;
      strategyMode?: "exploit" | "chart";
      /** Postflop MES overlay provenance: the solved board that answered, the
       *  measured per-arrival ev_gain of that spot (bb), and whether the
       *  actual flop was that board or a nearest-texture mapping. */
      mesBoard?: string;
      mesEvGainBb?: number;
      mesExact?: boolean;
      /** id in data/solves.sqlite of the stored AI-chain trace (inputs + every node). */
      solveId?: number | null;
      /** Postflop: where the flop-entering ranges came from (the 3-max chart +
       *  the exploit hero range, the MES spec, or the 6-max fallback). This is
       *  what the answer log shows as "chart" for a postflop answer — `gametype`
       *  is only the GTO Wizard library set the tree is referenced against. */
      rangeSource?: string;
      street: string;
      setId: string;
      gametype: string;
      depth: number;
      line: string;
      pos: string | null;
      heroClass: string | null;
      /** The mix of the piece that ANSWERED — what the panel rolls and the hand
       *  card draws. Never another piece's distribution. */
      actions: ActionFreq[];
      /** The equilibrium chart's own mix when another piece answered (preflop
       *  exploit, postflop MES), kept for the Sources comparison (MES-vs-GTO is a
       *  question about the pieces, not about the action) and so the poller walks
       *  the chart's would-have-picked on the SAME roll (rollDecision.ts). */
      chartActions?: ActionFreq[];
      /** The MES exploit mix when the chart answered (postflop chart mode) — the
       *  same, for the other piece. */
      exploitActions?: ActionFreq[];
      decision: WeightedPick | null;
      notInRange?: boolean;
      approx?: boolean;
      warning?: string | null;
      /** POSTFLOP_DRY_RUN only (the input-mutation harness): the solver input's numbers, for the harness's oracle */
      dryRun?: {
        flopPot: number; flopStack: number; walkables: number; heroWeight: number | null; flopSeats: string[];
        /** round 2 (the range-level oracle): the solver input itself — every seat's class → weight range as walked
         *  (all-in seats included), the preflop tokens the pot was rolled from, the postflop street tokens and who
         *  took them, where the ranges came from, and each tree's seats with the 1326-combo arrays sent */
        ranges?: Record<string, Record<string, number>>;
        preTokens?: string[];
        streets?: string[][];
        streetSeats?: (string | null)[][];
        trees?: { kind: string | null; heroSeat: string; seats: { pos: string; range: number[] }[]; streets: string[][] }[];
      };
    }
  | {
      ok: false; reason: string; street?: string;
      /** For chart misses: which chart, and how far the walk got — logged
       *  with the failure so the miss queue and the answer trail agree. */
      gametype?: string; depth?: number; line?: string;
      /** WHY there is no answer, as a class the answer log can count (studyPoller writes it as fail_kind,
       *  2026-09-23). Set on the refusals that are TERMINAL — a capture no piece may try to answer:
       *  "capture-fault" (the hand contradicts itself, PF-01), "no-hero-cards" (EH-9), "board-incomplete"
       *  (EIP-01). Absent on an ordinary miss, which the next piece in the cascade is welcome to attempt. */
      kind?: string;
    };

/** The terminal refusal classes fastSolve itself emits — see FastSolveResult.kind. */
export type RefusalKind = "capture-fault" | "no-hero-cards" | "board-incomplete";

/** Depth: explicit > hero's stack AS DEALT (else the shortest dealt stack) snapped to a library depth.
 *  AS DEALT (2026-09-22): the stack behind now plus everything put in this hand. The depth picks the chart rung
 *  and is what preflopPotStack subtracts the preflop money from — the stack behind at the flop took that money
 *  off twice, and by the turn of a 3-bet pot it snapped a 100bb player onto the 75bb rung. */
export const resolveDepth = (hand: ParsedHand, depths: number[], explicit?: number): number => {
  if (explicit) return explicit;
  const stacks = dealtBySeat(hand);
  const heroStack = stacks[hand.heroSeatId];
  const candidates =
    heroStack != null && heroStack > 0
      ? [heroStack]
      : Object.values(stacks).filter((s) => Number.isFinite(s) && s > 0);
  const eff = candidates.length ? Math.min(...candidates) : 100;
  return depths.reduce((a, b) => (Math.abs(b - eff) < Math.abs(a - eff) ? b : a));
};

/** Action label with its size folded in: the API's display_name is bare
 *  ("BET") with the bb amount in a separate betsize field — a panel verdict
 *  saying "BET" without an amount is unusable at the table. Names that
 *  already carry a number (chart labels like "Raise 2.5") pass through. */
const labelOf = (a: any): string => {
  const name = String(a?.action?.display_name ?? "");
  const size = parseFloat(a?.action?.betsize);
  return size > 0 && !/\d/.test(name) ? `${name} ${Math.round(size * 100) / 100}` : name;
};

const heroClassOf = (hand: ParsedHand): string | null => {
  const cards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c));
  if (cards.length !== 2) return null;
  try {
    return parseHandClass(cards.join(""));
  } catch {
    return null;
  }
};

/** Pick hero's set: explicit > 2-handed→HU (dealer BTN→SB) > 6-max. */
export const resolveSet = (hand: ParsedHand, heroPos: string | null, setId?: string) => {
  const present = new Set([...Object.values(hand.positions), ...(heroPos ? [heroPos] : [])]);
  const id = setId ?? (present.size <= 2 ? "hu" : "6max");
  return SOLUTION_SETS.find((s) => s.id === id) ?? null;
};

/** Preflop acting order 3-handed: the button is first in, the blinds behind. */
const THREE_MAX_SEATS: readonly string[] = ["BTN", "SB", "BB"];

/** A 3-handed table: exactly BTN/SB/BB present. The asym HRC charts cover
 *  this shape with the real 3-max rake and per-seat stack asymmetry — the
 *  6-max phantom-fold walk is the wrong tree on every axis (rake model, no
 *  limps, symmetric 100bb only). */
const is3Handed = (hand: ParsedHand, heroPos: string | null): boolean => {
  const present = new Set(
    [...Object.values(hand.positions), ...(heroPos ? [heroPos] : [])].map((p) => p.toUpperCase())
  );
  return present.size === 3 && ["BTN", "SB", "BB"].every((p) => present.has(p));
};

/** A 5- or 6-handed ring table. Five-handed is the 6-dealt tree with UTG folded — which is how the set was
 *  solved and how the plan counts it (the rake cap differs by half a blind, second order) — so both shapes
 *  route to the same charts. */
const is6Handed = (hand: ParsedHand, heroPos: string | null): boolean => {
  const six = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
  const present = new Set(
    [...Object.values(hand.positions), ...(heroPos ? [heroPos] : [])].map((p) => p.toUpperCase())
  );
  // FOUR-HANDED IS THE SAME GAME (2026-09-17, Brady): a short table is the six-seat tree with its early seats
  // folded - the token walk already pads UTG/HJ as folds - so 4-6 seats all route to the 6-max charts; only the
  // rake cap differs, which he accepts. Three-handed stays the Zone 3-max set.
  return present.size >= 4 && present.size <= 6
    && [...present].every((p) => six.includes(p))
    && ["BTN", "SB", "BB"].every((p) => present.has(p));
};

/**
 * Preflop from the asymmetric 3-max chart corpus (services/hrc3max.ts).
 * Chart = stake-matched site x canonical stack state; tokens walk the
 * BTN/SB/BB rotation. Returns null ONLY when the chart server is
 * unreachable — a missing line/node is a real answer about the hand and is
 * reported as such, not silently retried against the wrong 6-max tree.
 */
/**
 * Pool-exploit overlay: the constrained preflop best-response vs the measured
 * pool (analysis/pipeline/limp_study/exploit_ranges.json — derived at 100bb
 * with 1.5-SE-shrunk thin-sample frequencies). Enabled by setting
 * EXPLOIT_CHART to that file's path; covers the five modeled first-decision
 * shapes and lets everything deeper fall through to the equilibrium chart.
 */
let exploitChoices: Record<string, Record<string, string>> | null | undefined;
function exploitLookup(line: string, heroPos: string, heroClass: string | null):
    { action: string; tag: string } | null {
  if (!process.env.EXPLOIT_CHART || !heroClass) return null;
  if (exploitChoices === undefined) {
    try {
      exploitChoices = JSON.parse(
        require("node:fs").readFileSync(process.env.EXPLOIT_CHART, "utf-8")).choices;
    } catch { exploitChoices = null; }
  }
  if (!exploitChoices) return null;
  // line SHAPE -> modeled node (sizes snap: any single raise reads as "open")
  const toks = line ? line.split("-") : [];
  const isR = (t: string) => /^R[\d.]+$/.test(t);
  let tag: string | null = null;
  if (toks.length === 0 && heroPos === "BTN") tag = "btn_root";
  else if (toks.length === 1 && isR(toks[0]!) && heroPos === "SB") tag = "sb_vs_open";
  else if (toks.length === 2 && isR(toks[0]!) && toks[1] === "F" && heroPos === "BB") tag = "bb_vs_open";
  else if (toks.length === 1 && toks[0] === "F" && heroPos === "SB") tag = "sb_bvb";
  else if (toks.length === 2 && toks[0] === "F" && isR(toks[1]!) && heroPos === "BB") tag = "bb_vs_sb";
  if (!tag) return null;
  const action = exploitChoices[tag]?.[heroClass];
  return action ? { action, tag } : null;
}


/**
 * Which exploit range hero's preflop line actually puts him on.
 *
 * When the exploit overlay is armed hero opens ~50% and 3-bets 43-60%, but
 * the flop solve reconstructs his range from the equilibrium chart (~33%
 * opens) — so GTOW would solve a spot where hero's range is far stronger
 * than the one he really has, biasing every line toward over-aggression.
 * This maps the canonical flop-reaching shapes onto exploit_ranges.json.
 *
 * Only shapes where hero acted ONCE are mapped: if he opened and then called
 * a 3-bet, that second decision is not modeled by the exploit and the chart
 * reconstruction is the honest source for his (narrower) range.
 */
const EXPLOIT_LINE_RANGE: Record<string, Record<string, string>> = {
  // BTN opens, SB folds, BB calls
  "R-F-C": { BTN: "btn_open", BB: "bb_flat_vs_btn" },
  // BTN opens, SB calls, BB folds
  "R-C-F": { BTN: "btn_open", SB: "sb_flat_vs_btn" },
  // BTN folds, SB opens, BB calls
  "F-R-C": { SB: "sb_open_bvb", BB: "bb_flat_vs_sb" },
  // BTN opens, SB folds, BB 3-bets, BTN calls (BTN's call is unmodeled)
  "R-F-R-C": { BB: "bb_3bet_vs_btn" },
  // BTN opens, SB 3-bets, BB folds, BTN calls
  "R-R-F-C": { SB: "sb_3bet_vs_btn" },
  // BTN folds, SB opens, BB 3-bets, SB calls
  "F-R-R-C": { BB: "bb_3bet_vs_sb" },
  // BTN limps (the exploit's limp-trap: AA/AK/…), SB folds, BB checks — hero
  // BTN's flop range is the exploit LIMP range, not the chart's limp mix
  "C-F-C": { BTN: "btn_limp" },
};

let exploitRanges: Record<string, Record<string, number>> | null | undefined;
function exploitFlopRange(tokens: string[], heroPos: string):
    { weights: Record<string, number>; key: string } | null {
  if (!process.env.EXPLOIT_CHART) return null;
  if (exploitRanges === undefined) {
    try {
      exploitRanges = JSON.parse(
        require("node:fs").readFileSync(process.env.EXPLOIT_CHART, "utf-8")).ranges;
    } catch { exploitRanges = null; }
  }
  if (!exploitRanges) return null;
  const shape = tokens
    .map((t) => (/^R[\d.]+$/.test(t) ? "R" : t === "X" ? "C" : t))
    .join("-");
  const key = EXPLOIT_LINE_RANGE[shape]?.[heroPos.toUpperCase()];
  const weights = key ? exploitRanges[key] : undefined;
  return weights && Object.keys(weights).length ? { weights, key } : null;
}

async function solvePreflop3max(
  hand: ParsedHand,
  heroPos: string | null,
  strategy?: "exploit" | "chart",
  origin?: string,
  strategyId?: string | null,
): Promise<FastSolveResult | null> {
  const chart = chartFor(hand, heroPos);
  const tokens = buildPreflopTokens3max(hand, heroPos);
  const walk = await walk3max(tokens, (line) => fetchNode(chart.id, line));
  // The miss queue (services/missQueue.ts) writes down every inexact walk —
  // a miss, a far snap, a beyond-ladder state — with the state to solve it.
  missQueue.observe({
    chart, hand, heroPos, tokens, walk,
    ref: { origin: origin === "replay" ? "replay" : "live", clientHandId: hand.clientHandId ?? null, handId: hand.handId ?? null, actionIndex: hand.actions.length, ts: Date.now() },
  });
  if (!walk.ok) {
    if (walk.unreachable) return null; // solve-DB server down — 6-max net below
    return { ok: false, reason: `3-max chart ${chart.id}: ${walk.reason}`, street: "preflop", gametype: chart.id, depth: chart.depth, line: walk.missingAt ?? "" };
  }

  const line = walk.tokens.join("-");

  // THE NODE MUST BE HERO'S — the same guard the 6-max path carries, here as INSURANCE rather than a
  // known bug. The 3-max asym corpus was probed on 2026-09-22 and its rotation is correct (a call and a
  // fold each advance exactly one seat, limped lines included), unlike the 6-max limp trees. But this path
  // is where a wrong seat would do the most damage: `walk.node.pos` is handed straight to exploitLookup
  // below, so a mis-rotated node would pick the pool best-response for the wrong seat as well as the
  // equilibrium mix. A chart generation that ever regresses should fail loudly here, not answer.
  const heroSeat3 = (hand.positions[hand.heroSeatId] ?? heroPos ?? "").toUpperCase();
  const nodePos3 = String(walk.node.pos ?? "").toUpperCase();
  if (heroSeat3 && nodePos3 && heroSeat3 !== nodePos3) {
    return { ok: false, street: "preflop", gametype: chart.id, depth: chart.depth, line: line || "(root)",
      reason: `the chart's node at "${line || "root"}" belongs to ${nodePos3}, but hero is ${heroSeat3} — ` +
        `this tree's rotation disagrees with the table, so its strategy is not hero's to read` };
  }

  const heroClass = heroClassOf(hand);
  const cell = heroClass ? walk.node.cells.find((c) => c.hand === heroClass) : undefined;
  const actions = cell
    ? Object.entries(cell.actions).map(([action, frequency]) => ({ action, frequency }))
    : [];

  // exploit overlay: BOTH answers always ride in the result — `strategy`
  // (or the armed default) only decides which one is `decision`, so every
  // UI can offer an MES/GTO tab without a second solve.
  const ex = exploitLookup(line, walk.node.pos ?? heroPos ?? "", heroClass ?? null);
  const exAction = ex && walk.node.actions.some((a) => a.action === ex.action)
    ? ex : null;
  const chartDecision = actions.length ? pickWeightedAction(actions) : null;
  // a pure pick: no roll happened, and its band is the whole 0-100 range
  const exploitDecision: WeightedPick | null = exAction
    ? { action: exAction.action, frequency: 100, roll: 100, band: [0, 100] }
    : null;
  // WHICH PIECE ANSWERS is a property of the declared strategy and nothing else.
  // It used to default to `process.env.EXPLOIT_CHART ? "exploit" : "chart"`, so an
  // API started without that variable silently answered every preflop spot off the
  // equilibrium chart while the session still called itself an Exploit strategy.
  // `strategy` remains only for callers with no strategy to declare (the playthrough
  // tester, the offline sweeps), which is why the env fallback survives there.
  const mode = preflopArrivalFor(strategyId)
    ?? strategy
    ?? (process.env.EXPLOIT_CHART ? "exploit" : "chart");
  const useExploit = mode === "exploit" && exploitDecision != null;

  return {
    ok: true,
    source: useExploit ? "pool-exploit-preflop" : "hrc-3max-preflop",
    tier: useExploit ? "exploit-3max" : "chart-3max",
    street: "preflop",
    setId: "3max-asym",
    gametype: chart.id,
    depth: chart.depth,
    line: line || "(root)",
    pos: walk.node.pos,
    heroClass,
    decision: useExploit ? exploitDecision : chartDecision,
    // The mix that ships is the ANSWERING piece's own. It used to be the chart's
    // either way, which is why the panel once rolled the chart's action over an
    // exploit answer (see studyPoller.rollAction) and why the hand card drew a
    // "Fold 100%" bar under a "Raise 2.5" headline. The equilibrium mix is still
    // carried, as chartActions, for the Sources comparison.
    actions: useExploit ? [{ action: exploitDecision!.action, frequency: 100 }] : actions,
    chartActions: actions,
    exploitDecision: exploitDecision ?? undefined,
    chartDecision: chartDecision ?? undefined,
    exploitTag: exAction?.tag,
    strategyMode: mode,
    notInRange: (heroClass != null && !cell) || undefined,
    approx: walk.repaired.length > 0 || undefined,
    warning: [
      useExploit
        ? `pool best response (${exAction!.tag}, derived @100bb${chart.depth !== 100 ? `, state ${chart.depth}bb` : ""})`
        : chart.note,
      farSnapNote(walk.repaired),
    ].filter(Boolean).join(" · ") || undefined,
  };
}

/** The snaps this walk made that are past τ — approximations, not exact reads. */
const farSnaps = (repaired: Walk3Repair[]): Walk3Repair[] => repaired.filter((r) => r.far);

/**
 * What the panel and the hand page say when a size had to be snapped past τ.
 *
 * The answer is real and usable — that is the whole point of snapping rather
 * than refusing — but it is read at a size the tree HAS, not the one villain
 * used, so it must never be presented as exact. The miss queue files the same
 * fact as a `size-snapped` row with the state to solve.
 */
function farSnapNote(repaired: Walk3Repair[]): string | null {
  const far = farSnaps(repaired);
  if (!far.length) return null;
  return `OFF-TREE SIZE: ${far.map((r) => `${r.from} answered from ${r.to} (${r.logDist.toFixed(2)} log-dist, past τ ${SNAP_TAU})`).join(", ")}`
    + " — this tree has no node at that size, so the answer is read at the nearest one and costs real EV; it is filed for a re-solve";
}

/** Preflop answer from the local crawled DB. */
function solvePreflop(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts): FastSolveResult {
  const set = resolveSet(hand, heroPos, opts.setId);
  if (!set) return { ok: false, reason: `Unknown solution set: ${opts.setId}`, street: "preflop" };
  const isHu = set.seats.length === 2;
  const depth = resolveDepth(hand, set.depths?.length ? set.depths : [100], opts.depth);
  if (!preflopDb.available(set.gametype, depth)) {
    return { ok: false, reason: `No local preflop chart for ${set.gametype} @ ${depth}bb.`, street: "preflop" };
  }
  const tokens = isHu ? buildPreflopTokensHu(hand, heroPos) : buildPreflopTokens(hand, heroPos);
  const heroClass = heroClassOf(hand);
  const ans = preflopDb.answer(set.gametype, depth, tokens, heroClass);
  if (!ans.ok) return { ok: false, reason: ans.reason, street: "preflop" };

  return {
    ok: true,
    source: "local-preflop",
    street: "preflop",
    setId: set.id,
    gametype: set.gametype,
    depth,
    line: ans.line,
    pos: ans.pos,
    heroClass,
    actions: ans.actions,
    decision: ans.decision,
    notInRange: ans.notInRange || undefined,
    approx: ans.repaired.length > 0 || undefined,
  };
}

/** Nearest on-tree size (log-space) among the offered bb amounts + its distance. */
const nearestSize = (intendedBb: number, offered: number[]): { size: number; logDist: number } | null => {
  if (!offered.length || !(intendedBb > 0)) return null;
  let best = offered[0]!;
  let bestD = Infinity;
  for (const s of offered) {
    const d = Math.abs(Math.log(intendedBb) - Math.log(s));
    if (d < bestD) { bestD = d; best = s; }
  }
  return { size: best, logDist: bestD };
};

/** Bet/raise bb sizes the acting player is offered at a node (from the API). */
const offeredBetSizes = (data: any): number[] =>
  (data?.action_solutions ?? [])
    .filter((a: any) => /^(BET|RAISE|ALLIN)/i.test(a.action?.display_name ?? ""))
    .map((a: any) => parseFloat(a.action?.betsize))
    .filter((x: number) => Number.isFinite(x) && x > 0);

/**
 * Snap off-tree POSTFLOP bet sizes to the tree's real ones. The spot-solution
 * API is a LOOKUP of pre-solved trees — it only knows the bet sizes baked into
 * the tree (e.g. 1.65 / 3.35 / 5 on a given flop), so a live "bet 2" has no
 * stored solution. We walk the postflop line and, before each numeric bet,
 * query the node just before it, read its offered sizes, and snap. One extra
 * API call per off-tree bet (only invoked on a miss). Returns null if a query
 * fails or a size can't be snapped.
 */
async function snapPostflopStreets(
  gametype: string,
  depth: number,
  board: string,
  preflopActions: string,
  streets: { flop: string[]; turn: string[]; river: string[] }
): Promise<{ flop: string[]; turn: string[]; river: string[]; maxLogDist: number; far: boolean } | null> {
  const acc = { flop: [] as string[], turn: [] as string[], river: [] as string[] };
  let changed = false;
  let maxLogDist = 0;
  // Probe boards are truncated to the PROBED street: the API answers a
  // flop-node query with an empty node when the board runs past the flop
  // (found 2026-07-30 — full-board probes made turn/river snapping a no-op).
  const boardTo = { flop: 6, turn: 8, river: 10 } as const;
  for (const st of ["flop", "turn", "river"] as const) {
    for (const tok of streets[st]) {
      if (/^R[\d.]+$/.test(tok)) {
        const probe = await gtowApi.spotSolution({
          gametype,
          depth,
          preflop_actions: preflopActions,
          flop_actions: acc.flop.join("-"),
          turn_actions: acc.turn.join("-"),
          river_actions: acc.river.join("-"),
          board: board.slice(0, boardTo[st]),
        });
        if (!probe.ok || !probe.data?.action_solutions?.length) return null;
        const offered = offeredBetSizes(probe.data);
        const snapped = nearestSize(parseFloat(tok.slice(1)), offered);
        if (snapped == null) return null;
        maxLogDist = Math.max(maxLogDist, snapped.logDist);
        const snappedTok = `R${Math.round(snapped.size * 100) / 100}`;
        if (snappedTok !== tok) changed = true;
        acc[st].push(snappedTok);
      } else {
        acc[st].push(tok);
      }
    }
  }
  if (!changed) return null; // nothing off-tree — no point retrying
  return { ...acc, maxLogDist, far: maxLogDist > SNAP_TAU };
}

const SHORT_C = (c: string): string => {
  const m = c.trim().match(/^([2-9TJQKAtjqka])([shdcSHDC])$/);
  return m ? m[1]!.toUpperCase() + m[2]!.toLowerCase() : c;
};

/**
 * The PRIMARY postflop solver: an AI custom solve rooted at the CURRENT
 * street, with pot/stack taken from the OBSERVED table rather than replaying
 * the line. A postflop spot is fully determined by ranges + pot + stack +
 * board, so this answers regardless of whether the action history walks the
 * library trees (limps, missed WS frames, off-tree sizes all stop mattering).
 * Ranges are chart-reconstructed when the preflop walks, else GENERIC full
 * ranges (loudly flagged).
 */
/** Hero's name in the CHART's namespace, for the villain-size-merge exemption:
 *  HU trees seat the dealer as SB while the vision layer may say BTN. */
const mergeHeroPos = (heroPosName: string | null, isHu: boolean): string | undefined =>
  heroPosName == null ? undefined : isHu && heroPosName.toUpperCase() === "BTN" ? "SB" : heroPosName;

async function solvePostflopAi(
  hand: ParsedHand,
  heroPos: string | null,
  set: (typeof SOLUTION_SETS)[number],
  depth: number,
  tk: ReturnType<typeof buildSpotSolutionTokens>
): Promise<{ res: FastSolveResult | null; why: string | null }> {
  const fail = (why: string) => ({ res: null, why });
  const cur = hand.currentNode.street as "flop" | "turn" | "river";
  // The broken-feed case leaves folded seats "live" in positions (their fold
  // was never observed), tripping the heads-up check. The villain we can
  // actually KNOW: a non-hero postflop actor, else the last non-hero
  // voluntary actor observed anywhere in the hand.
  const folded = new Set(hand.actions.filter((a) => a.type === "fold").map((a) => a.seatId));
  const postActors = hand.actions.filter((a) => a.street !== "preflop" && !a.hero && !folded.has(a.seatId));
  let villainSeat: number | null = postActors.length ? postActors[postActors.length - 1]!.seatId : null;
  if (villainSeat == null) {
    const vol = hand.actions.filter(
      (a) => !a.hero && a.type !== "post-sb" && a.type !== "post-bb" && !folded.has(a.seatId)
    );
    villainSeat = vol.length ? vol[vol.length - 1]!.seatId : null;
  }
  if (villainSeat == null || !hand.positions[villainSeat]) {
    // No observed villain action at all (phantom-fold captures) — any live,
    // unfolded, position-labeled seat is a better answer than none.
    const live = hand.liveSeats.filter(
      (s) => s !== hand.heroSeatId && !folded.has(s) && hand.positions[s]
    );
    villainSeat = live.length ? live[live.length - 1]! : null;
  }
  if (villainSeat == null || !hand.positions[villainSeat]) return fail("no identifiable villain (no observed non-hero actions or live labeled seats)");
  const heroPosName = hand.positions[hand.heroSeatId] ?? heroPos;
  if (!heroPosName) return fail("hero position unknown");
  const pruned: ParsedHand = {
    ...hand,
    positions: { [hand.heroSeatId]: heroPosName, [villainSeat]: hand.positions[villainSeat]! },
  };
  const d = deriveExploitSpot(pruned, heroPos);
  if (!d.ok) return fail(`exploit-spot: ${d.error}`); // e.g. genuinely multiway
  const spot = d.spot;

  const isHu = set.seats.length === 2;
  // Snap the observed sizes to the tree's before reconstructing ranges: the
  // charts store canonical sizes (R2.5, not the live R2.52), and walking the
  // raw tokens made chart-reconstruction fail on hands that were one rounding
  // artifact away — silently downgrading them to generic ranges.
  let preTokens = isHu ? buildPreflopTokensHu(hand, heroPos) : buildPreflopTokens(hand, heroPos);
  if (preflopDb.available(set.gametype, depth)) {
    const snapped = snapPreflopLine(preTokens, (line) => preflopDb.rawNode(set.gametype, depth, line));
    if (snapped.ok) preTokens = snapped.tokens;
  }
  // A 3-handed flop was dealt by a 3-handed preflop, so the ranges that REACH
  // it belong to the asymmetric 3-max corpus, not the 6-max charts: a 3-max
  // button opens a materially wider range than a 6-max one, and blind-vs-blind
  // differs more still. The solve is a custom solve at the observed
  // pot/stack/board either way — this decides only what ranges it starts from,
  // which is the difference between the right answer and a plausible one.
  //
  // The 6-max reconstruction stays as the fallback rather than dropping to
  // generic full ranges: a dead chart server should cost accuracy, not the
  // answer.
  let recon: Awaited<ReturnType<typeof reconstructFlopRanges>> | null = null;
  let rangeSource: string | null = null;
  if (is3Handed(hand, heroPos)) {
    const chart = chartFor(hand, heroPos);
    const tri = await reconstructFlopRanges(buildPreflopTokens3max(hand, heroPos), async (line) => {
      const n = await fetchNode(chart.id, line);
      return n === "unreachable" ? null : n;
    }, { heroPos: mergeHeroPos(hand.positions[hand.heroSeatId] ?? heroPos, false) });
    if (tri.ok) {
      recon = tri;
      rangeSource = chart.id;
      // hero's OWN range comes from the strategy he is actually playing
      const heroName = (hand.positions[hand.heroSeatId] ?? heroPos ?? "").toUpperCase();
      const exRange = exploitFlopRange(buildPreflopTokens3max(hand, heroPos), heroName);
      if (exRange) {
        for (const p of Object.keys(recon.ranges)) {
          if (p.toUpperCase() === heroName) {
            (recon.ranges as Record<string, unknown>)[p] = exRange.weights;
            rangeSource = `${chart.id} + exploit hero range (${exRange.key})`;
          }
        }
      }
    } else {
      rangeSource = `6max (3-max chart ${chart.id}: ${tri.reason})`;
    }
  }
  if (!recon) {
    recon = await reconstructFlopRanges(preTokens, (line) => preflopDb.rawNode(set.gametype, depth, line),
      { heroPos: mergeHeroPos(hand.positions[hand.heroSeatId] ?? heroPos, isHu) });
  }
  let oopArr: number[] | null = null;
  let ipArr: number[] | null = null;
  if (recon.ok) {
    // HU trees seat the dealer as SB; the vision layer may label him BTN.
    const posName = (p: string) => (isHu && p.toUpperCase() === "BTN" ? "SB" : p);
    const byPos = (pos: string) =>
      Object.entries(recon.ranges).find(([p]) => p.toUpperCase() === posName(pos).toUpperCase())?.[1];
    const oopW = byPos(spot.oopPos);
    const ipW = byPos(spot.ipPos);
    if (oopW && ipW) {
      oopArr = buildRangeArray(classWeightsToSpec(oopW));
      ipArr = buildRangeArray(classWeightsToSpec(ipW));
    }
  }
  const genericRanges = !oopArr || !ipArr;
  if (!oopArr) oopArr = new Array(1326).fill(1);
  if (!ipArr) ipArr = new Array(1326).fill(1);

  // Observed geometry: the pot is authoritative (the client reports it); the
  // stack falls back to depth minus a half-pot contribution when unreadable.
  const toCall = Math.max(0, hand.currentNode.toCall || 0);
  const potNow = hand.currentNode.pot > 0 ? hand.currentNode.pot : 4;
  const potBefore = Math.max(1, Math.round((potNow - toCall) * 100) / 100);
  const stacks = hand.stacks ?? {};
  const heroStack = stacks[hand.heroSeatId];
  const liveStacks = Object.values(stacks).filter((s) => Number.isFinite(s) && s > 0);
  const stack = Math.max(
    2,
    Math.round((heroStack ?? (liveStacks.length ? Math.min(...liveStacks) : depth - potBefore / 2)) * 10) / 10
  );

  const heroCards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/i.test(c)).map(SHORT_C);
  const heroArr = spot.heroSeat === "oop" ? oopArr : ipArr;
  if (heroCards.length === 2) {
    const idx = comboIndex(heroCards[0]!, heroCards[1]!);
    if ((heroArr[idx] ?? 0) < 1) heroArr[idx] = 1;
  }

  const curKey = cur.toUpperCase() as "FLOP" | "TURN" | "RIVER";
  const pct = toCall > 0 ? Math.round((toCall / potBefore) * 1000) / 10 : null;
  const tree = {
    board: tk.board,
    pot: potBefore,
    stack,
    oopRange: oopArr,
    ipRange: ipArr,
    oopPos: spot.oopPos,
    ipPos: spot.ipPos,
    startingStreet: curKey,
    ...(pct != null ? { fixedBets: { [curKey]: pct } } : {}),
  };
  const streetActs = (k: string) => ({
    flopActions: cur === "flop" ? k : "",
    turnActions: cur === "turn" ? k : "",
    riverActions: cur === "river" ? k : "",
  });

  // Walk to hero's node using the TREE'S OWN action codes: a fixed-% tree
  // rounds its bet sizes internally, so guessing bb tokens ("R4.72") lands
  // on NODE_DOES_NOT_EXIST. The tree is cached after the first call, so the
  // extra node queries are cheap.
  const observed = spot.actions ? spot.actions.split("-").filter(Boolean) : [];
  const prefix: string[] = [];
  let res = await gtowApi.customSolve({ ...tree, ...streetActs("") });
  for (const t of observed) {
    if (!res.ok || !res.data?.action_solutions?.length) break;
    if (/^R/.test(t)) {
      const agg = res.data.action_solutions.find((a: any) =>
        /^(BET|RAISE|ALLIN)/i.test(a.action?.display_name ?? "")
      );
      if (!agg?.action?.code) return fail("custom tree offered no aggressive action to walk");
      prefix.push(String(agg.action.code));
    } else {
      prefix.push(t === "C" ? "C" : "X");
    }
    res = await gtowApi.customSolve({ ...tree, ...streetActs(prefix.join("-")) });
  }
  if (!res.ok || !res.data?.action_solutions?.length) {
    // The observed street tokens couldn't even walk the custom tree (corrupt
    // capture can pollute the current street too). Approximate from the
    // street root: hero's node directly, or one tree bet when facing one —
    // the warning already flags this tier as approximate.
    res = await gtowApi.customSolve({ ...tree, ...streetActs("") });
    if (toCall > 0 && res.ok && res.data?.action_solutions?.length) {
      const agg = res.data.action_solutions.find((a: any) =>
        /^(BET|RAISE|ALLIN)/i.test(a.action?.display_name ?? "")
      );
      if (agg?.action?.code) {
        res = await gtowApi.customSolve({ ...tree, ...streetActs(String(agg.action.code)) });
      }
    }
    if (!res.ok || !res.data?.action_solutions?.length) {
      return fail(`custom solve: ${res.ok === false ? res.error : "empty node"}`);
    }
  }

  const j = res.data;
  let actions: ActionFreq[];
  let notInRange = false;
  if (heroCards.length === 2) {
    const idx = comboIndex(heroCards[0]!, heroCards[1]!);
    actions = j.action_solutions.map((a: any) => ({ action: labelOf(a), frequency: (a.strategy?.[idx] ?? 0) * 100, ev: a.evs?.[idx], betsize: a.action.betsize }));
    notInRange = actions.every((a) => a.frequency <= 0);
  } else {
    actions = j.action_solutions.map((a: any) => ({ action: labelOf(a), frequency: (a.total_frequency ?? 0) * 100, ev: a.total_ev, betsize: a.action.betsize }));
  }
  return { why: null, res: {
    ok: true,
    source: "gtow-api-postflop",
    tier: "ai-exact",
    rangeSource: rangeSource ?? undefined,
    street: cur,
    setId: set.id,
    gametype: set.gametype,
    depth,
    line: `${cur} root · AI (pot ${potBefore}bb, stack ${stack}bb${toCall > 0 ? `, facing ${toCall}bb` : ""})`,
    pos: j.action_solutions?.[0]?.action?.position ?? null,
    heroClass: heroClassOf(hand),
    actions,
    decision: notInRange ? null : pickWeightedAction(actions),
    notInRange: notInRange || undefined,
    approx: true,
    warning: genericRanges
      ? "AI solve with GENERIC full ranges — the preflop line couldn't be walked in the charts (limps/missed actions?); treat as board-texture guidance."
      // Which preflop ranges seeded the solve is not cosmetic: the same board,
      // pot and stacks solved from 6-max ranges is a different answer, so a
      // 3-handed spot that quietly fell back says so.
      : rangeSource && rangeSource.startsWith("6max")
        ? `3-handed spot solved from 6-MAX preflop ranges — ${rangeSource}; treat as approximate.`
        : null,
  } };
}


/**
 * Postflop via the PER-STREET AI CHAIN (services/aiChain.ts) — the primary
 * path. Flop tree from chart-reconstructed preflop ranges; each observed
 * action multiplies the actor's range by its equilibrium frequency; each
 * later street re-roots with the conditioned ranges and rolled-forward
 * pot/stack, observed wager sizes pinned exactly (FIXED trees). The answer at
 * hero's node therefore reflects everything that happened on earlier streets
 * — unlike the street-root shortcut below, whose flop-entry ranges produced
 * the K9o river-donk misfire this replaced.
 */
async function solvePostflopViaChain(
  hand: ParsedHand,
  heroPos: string | null,
  set: (typeof SOLUTION_SETS)[number],
  depth: number,
  tk: ReturnType<typeof buildSpotSolutionTokens>,
  origin?: string,
  sessionId?: string | null,
  /** the 6-max ring strategy: both seats' flop-entering ranges come from OUR 6-max chart, never the library */
  sixMax = false,
  /** notes from repairs the caller already applied to the capture (utils/repairPostflopRotation) */
  captureNotes: string[] = [],
  /** the CoinPoker HU strategy: ranges from OUR cp200a heads-up chart, the pot with its antes, CoinPoker's rake */
  huCp = false,
  /** the stacks as dealt, read ONCE per hand by the caller (pinPostflop) — every chart pick below uses these,
   *  never a fresh reading, so the ranges and the tree key hold still from the flop to the river */
  pinnedDealt?: Record<number, number>
): Promise<{ res: FastSolveResult | null; why: string | null; mesInput?: RiverMesInput }> {
  const tEntry = Date.now();
  const fail = (why: string) => ({ res: null, why });
  let sixNote: string | null = captureNotes.length ? captureNotes.join(" · ") : null;
  const cur = hand.currentNode.street as "flop" | "turn" | "river";


  // Villain identification + heads-up pruning — same policy as the street-root
  // net: the last observed non-hero actor, else any live labeled seat.
  const folded = new Set(hand.actions.filter((a) => a.type === "fold").map((a) => a.seatId));
  const postActors = hand.actions.filter((a) => a.street !== "preflop" && !a.hero && !folded.has(a.seatId));
  let villainSeat: number | null = postActors.length ? postActors[postActors.length - 1]!.seatId : null;
  if (villainSeat == null) {
    const vol = hand.actions.filter(
      (a) => !a.hero && a.type !== "post-sb" && a.type !== "post-bb" && !folded.has(a.seatId)
    );
    // a seat all-in preflop never acts again: the villain is a player who can (see ALL-IN PREFLOP below)
    const allInPre = new Set(hand.actions.filter((a) => a.street === "preflop" && a.type === "all-in").map((a) => a.seatId));
    const canAct = vol.filter((a) => !allInPre.has(a.seatId));
    const from = canAct.length ? canAct : vol;
    villainSeat = from.length ? from[from.length - 1]!.seatId : null;
  }
  if (villainSeat == null || !hand.positions[villainSeat]) {
    const live = hand.liveSeats.filter((s) => s !== hand.heroSeatId && !folded.has(s) && hand.positions[s]);
    villainSeat = live.length ? live[live.length - 1]! : null;
  }
  if (villainSeat == null || !hand.positions[villainSeat]) return fail("no identifiable villain");
  const heroPosName = hand.positions[hand.heroSeatId] ?? heroPos;
  if (!heroPosName) return fail("hero position unknown");
  const pruned: ParsedHand = {
    ...hand,
    positions: { [hand.heroSeatId]: heroPosName, [villainSeat]: hand.positions[villainSeat]! },
  };
  const d = deriveExploitSpot(pruned, heroPos);
  if (!d.ok) return fail(`exploit-spot: ${d.error}`);
  const spot = d.spot;

  // Flop-entering ranges need a WALKABLE, CLOSED preflop line — the chain's
  // whole point is conditioning, and conditioning on fiction is worse than
  // the flagged street-root fallback.
  const isHu = set.seats.length === 2;

  // A 3-handed flop is entered from a 3-handed preflop, so its ranges come from
  // the asymmetric 3-max corpus. Tried FIRST and fallen back from rather than
  // replacing the 6-max walk: if the chart server is down, conditioned 6-max
  // ranges still beat losing the chain (and the street-root solve flags it).
  let recon: Awaited<ReturnType<typeof reconstructFlopRanges>> | null = null;
  let preTokens: string[] = [];
  let rangeSource: string | null = null;
  // The rotation must match whichever token set won: preflopPotStack replays
  // the line below to size the flop pot, and walking 3-max tokens through the
  // 6-max rotation misassigns every action and double-counts the blinds.
  let seatOrder: readonly string[] | undefined;
  // Under the 6-max strategy the piece that ANSWERED preflop supplies the ranges (answer log; the shape
  // when no answer was logged). The 3-max corpus is cut from that strategy (see the preflop dispatch), so
  // this branch is for the OTHER strategies only — a 3-handed hand under the 6-max strategy conditions on
  // the AI preflop tree that answered it, in the sixMax block below.
  const piece = sixMax ? preflopPieceFor(hand) : null;
  if (is3Handed(hand, heroPos) && !sixMax) {
    const chart = chartFor(hand, heroPos);
    const tri3 = buildPreflopTokens3max(hand, heroPos);
    // reconstructFlopRanges snaps tokens against the nodes it is given, so the
    // 3-max line needs no separate pre-snap pass.
    if (preflopClosed(tri3, THREE_MAX_SEATS)) {
      const tri = await reconstructFlopRanges(tri3, async (line) => {
        const n = await fetchNode(chart.id, line);
        return n === "unreachable" ? null : n;
      }, { heroPos: mergeHeroPos(heroPosName, false) });
      if (tri.ok) {
        recon = tri;
        preTokens = tri3;
        seatOrder = THREE_MAX_SEATS;
        rangeSource = chart.id;
        // hero's OWN flop-entering range is the strategy he actually plays:
        // when the exploit overlay covers his preflop line, the chain must
        // start from that (wider) range, not the equilibrium chart's — the
        // same swap the single-solve path makes. Villain keeps the chart.
        // the pool-exploit overlay is a piece of the NL25 exploit strategy, armed process-wide by
        // EXPLOIT_CHART; under the 6-max EQUILIBRIUM strategy hero arrives with the chart's range
        const exRange = sixMax ? null : exploitFlopRange(tri3, heroPosName);
        if (exRange) {
          for (const p of Object.keys(recon.ranges)) {
            if (p.toUpperCase() === heroPosName.toUpperCase()) {
              (recon.ranges as Record<string, unknown>)[p] = exRange.weights;
              rangeSource = `${chart.id} + exploit hero range (${exRange.key})`;
            }
          }
        }
      } else {
        rangeSource = `6max (3-max chart ${chart.id}: ${tri.reason})`;
      }
    }
  }

  // THE 6-MAX STRATEGY CONDITIONS ON ITS OWN CHARTS (2026-09-17). The flop is entered from the preflop the
  // charts prescribe, so both seats' arrival ranges are walked from the very 6-max chart the preflop picker
  // chooses for this hand (effective stack, live shorts, open size). There is no library behind this branch:
  // conditioning a NL200 6-max solve on NL500 library ranges is the wrong answer dressed as one.
  // THE COINPOKER HU STRATEGY CONDITIONS ON ITS OWN CHART (2026-09-22). Both seats' flop-entering ranges are
  // walked from the very cp200a tree the preflop picker chooses (effective stack, open, 3-bet) — never the GTO
  // Wizard library, which is NL500 with no ante and a third of the rake.
  if (!recon && huCp) {
    const huTok = buildPreflopTokensHu(hand, heroPos);
    if (!preflopClosed(huTok, HU_SEATS)) return fail("preflop betting didn't close (missed action?)");
    const choice = chartForHu(hand, huTok, pinnedDealt);
    const resolved = await resolveChartHu(choice);
    if (resolved === "unreachable") return fail("chart server :8777 unreachable — the CoinPoker HU charts cannot be read");
    if (resolved === null) return fail(`no CoinPoker HU chart on the server (wanted ${choice.id})`);
    const get = nodeGetterHu(resolved.id);
    const r = await reconstructFlopRanges(huTok, async (line) => {
      const n = await get(line);
      return n === "unreachable" ? null : n;
    }, { heroPos: mergeHeroPos(heroPosName, true) });
    if (!r.ok) return fail(`CoinPoker HU chart ${resolved.id}: ${r.reason}`);
    recon = r; preTokens = huTok; seatOrder = HU_SEATS; rangeSource = resolved.id;
    sixNote = [sixNote, choice.note, resolved.fellBack ? `no ${choice.id} tree — ranges from ${resolved.id}` : null].filter(Boolean).join(" · ") || null;
  }

  if (!recon && sixMax) {
    // ONE SHAPE, TWO PIECES (2026-09-19, Brady): the flop-entering ranges come from the preflop piece that
    // ANSWERED this hand — the 6-max charts (recon6max) or the GTO Wizard AI preflop tree (arrivalRangesGtowAi),
    // both producing position → class → weight. The answer log says which piece answered; when it cannot (the
    // probe never ran), the shape decides the way the preflop dispatch does: 4-6 seats → charts, else the AI —
    // and a chart walk that fails on an unknown-piece hand is retried on the AI tree rather than lost.
    // 4-6 seats condition on the 6-max charts; anything thinner on the AI tree that answered preflop.
    // A hand whose log says the 3-max charts answered it is an ARCHIVED one from before the cut — it
    // replays on the strategy as it stands now, which is the AI tree.
    // THE PIN FIRST (services/preflopPin, 2026-09-25, Brady): the piece that answered hero's LAST preflop decision
    // supplies the flop-entering ranges, from the very tree it read — not chosen again from the shape, not rebuilt
    // from a fresh reading of the line. A pin the capture has outgrown (the line no longer starts with it) falls
    // through to the walk below and says so in the trace. Hero's own class at zero weight in the pinned range is a
    // refusal said out loud: the pieces disagree about hero's hand, which is a bug to see, not a reason to swap sources.
    const pin = getPreflopPin(preflopPinKey(hand));
    if (pin) {
      const tPin = Date.now();
      const resumed: ResumeOutcome = pin.piece === "chart6max"
        ? await resumeChartPreflopRanges(pin, hand, heroPos)
        : await resumeAiPreflopRanges(pin, hand, heroPos, 6);
      const cls = heroClassOf(hand);
      const mine = resumed.ok ? Object.entries(resumed.ranges).find(([p]) => p.toUpperCase() === (heroPosName ?? "").toUpperCase())?.[1] : undefined;
      const w = cls && mine ? mine[cls] ?? 0 : null;
      const zeroHero = resumed.ok && !!cls && !!mine && !(w! > 0);
      // HERO LEFT THE PICK (2026-09-25, Brady's rule 3 — veto-able): hero took an action his own pick gave 0%
      // (preflopPin.heroDeviation, from what each answer told him), and the pinned chart either cannot continue the
      // hand (it has no such action — a completed small blind in a raise-only tree, seed 1865) or holds his class at
      // zero weight after it. That is not a bug in the pieces — the chart has no range for "hands that did this" —
      // so the flop-entering ranges come from the GTO Wizard AI preflop tree built from the table, as for a pruned
      // branch (OFF THE CHART, below). A zero weight after following every pick stays the loud refusal.
      const dev = pin.piece === "chart6max" && (!resumed.ok || zeroHero) ? heroDeviation(pin.picks, buildPreflopTokens(hand, heroPos)) : null;
      if (dev) {
        const devNote = `OFF THE CHART (hero's own line): at "${dev.codes.join("-") || "root"}" hero took ${dev.action ?? dev.took}, which the pick gave ${dev.heroClass ?? cls ?? "his hand"} 0%, ` +
          `so the chart has no flop range for his hand — the flop-entering ranges come from the GTO Wizard AI preflop tree`;
        tmark("preflop pin: hero deviated", devNote);
        const ai = await arrivalRangesGtowAi(hand, heroPos, 6, pinnedDealt);
        if (!ai.ok) return fail(`${devNote}; then ${ai.reason}`);
        recon = { ok: true, ranges: ai.ranges }; preTokens = ai.tokens; seatOrder = ai.seatOrder; rangeSource = ai.id;
        sixNote = [sixNote, devNote, ai.note].filter(Boolean).join(" · ");
      } else if (resumed.ok) {
        tmark("preflop ranges resumed", `${pin.piece} ${resumed.id} · ${resumed.reads} node read(s) · ${Date.now() - tPin} ms · hero ${cls ?? "?"} weight ${w == null ? "n/a" : w.toFixed(3)}`);
        if (zeroHero) {
          return fail(`PREFLOP PIN (${pin.piece} ${resumed.id}): hero's ${cls} is not in range after the line "${resumed.codes.join("-")}" — ` +
            `the piece that answered preflop never plays this line with this hand (a chart/AI mismatch to investigate, not a fallback)`);
        }
        recon = { ok: true, ranges: resumed.ranges }; preTokens = resumed.tokens; seatOrder = resumed.seatOrder; rangeSource = resumed.id;
        sixNote = [sixNote, resumed.note].filter(Boolean).join(" · ") || null;
      } else if (pin.piece === "chart6max" && !resumed.ok && resumed.prunedBranch) {
        // HERO WENT DOWN A BRANCH THE CHART NEVER SOLVED (fix 2, 2026-09-25, Brady): the pinned chart has no
        // subtree under an action that was really taken and real action followed it — a manual deviation into a
        // ~0% line (the roll itself no longer picks one, see services/prunedPicks). The chart cannot continue the
        // hand, so the flop-entering ranges come from a GTO Wizard AI preflop tree built from the table: one cloud
        // solve, and the answer says the pick and the ranges came from different pieces.
        tmark("preflop pin: pruned branch", `${resumed.why} — ranges from the AI preflop tree`);
        const ai = await arrivalRangesGtowAi(hand, heroPos, 6, pinnedDealt);
        if (!ai.ok) return fail(`${resumed.why}; then ${ai.reason}`);
        recon = { ok: true, ranges: ai.ranges }; preTokens = ai.tokens; seatOrder = ai.seatOrder; rangeSource = ai.id;
        sixNote = [sixNote,
          `OFF THE CHART: hero's line runs into a branch the 6-max chart never solved (${resumed.why.replace(/^pinned chart [^:]+: /, "")}) — ` +
          `the preflop pick came from the chart, the flop-entering ranges from the GTO Wizard AI preflop tree`, ai.note].filter(Boolean).join(" · ");
      } else {
        tmark("preflop pin unusable", `${pin.piece}: ${resumed.why}`);
        console.log(`[preflop-pin] hand ${preflopPinKey(hand)} ${pin.piece} not resumed — ${resumed.why}`);
      }
    }
    const wantAi = piece === "gtow-ai-preflop" || piece === "chart3max" || !is6Handed(hand, heroPos);
    let six: Awaited<ReturnType<typeof recon6max>> | null = null;
    if (!recon && !wantAi) {
      six = await recon6max(hand, heroPos, heroPosName, pinnedDealt);
      if (six.ok) {
        recon = six.recon; preTokens = six.tokens; seatOrder = undefined; rangeSource = six.id; sixNote = six.note;
      } else if (piece === "chart6max") {
        return fail(six.reason);
      }
    }
    if (!recon) {
      // SIX, NOT THREE — the same cap the chart path carries (recon6max), and for the same reason: the
      // postflop step COLLAPSES the field to three itself (services/multiwayCollapse.ts) and needs every
      // live seat's arrival range to decide what to ghost or merge. Capping HERE truncated the field before
      // the collapse ever saw it, so every 4+ way flop whose preflop the AI piece answered — a thinned
      // table, an off-menu size, a limped pot, anything the charts could not take — died with "4 players
      // reach the flop — need 2 to 3" while the machinery to answer it sat one line downstream. The walk
      // itself is count-agnostic (see SeatCap in gtowAiPreflop), so this was only ever the caller
      // under-declaring what it could consume. Found by the 2026-09-21 stress run; the chart half of the
      // same asymmetry had been fixed earlier the same day and this half was missed.
      const ai = await arrivalRangesGtowAi(hand, heroPos, 6, pinnedDealt);
      if (!ai.ok) return fail(six && !six.ok ? `${six.reason}; then ${ai.reason}` : ai.reason);
      recon = { ok: true, ranges: ai.ranges };
      preTokens = ai.tokens;
      seatOrder = ai.seatOrder;
      rangeSource = ai.id;
      sixNote = [six && !six.ok ? `6-max chart could not walk this line (${six.reason})` : null, ai.note].filter(Boolean).join(" · ");
    }
  }
  if (!recon) {
    if (!rangeSource) rangeSource = `6max ${set.gametype}@${depth}`;
    if (!preflopDb.available(set.gametype, depth)) return fail(`no charts for ${set.gametype}@${depth}`);
    preTokens = isHu ? buildPreflopTokensHu(hand, heroPos) : buildPreflopTokens(hand, heroPos);
    const snapped = snapPreflopLine(preTokens, (line) => preflopDb.rawNode(set.gametype, depth, line));
    if (!snapped.ok) return fail(`preflop line: ${snapped.reason}`);
    preTokens = snapped.tokens;
    // HU lines walk the [SB, BB] rotation — the 6-max default misassigns every
    // action (the line never "closes") and double-counts the blinds as dead.
    seatOrder = isHu ? HU_SEATS : undefined;
    if (!preflopClosed(preTokens, seatOrder)) return fail("preflop betting didn't close (missed action?)");
    recon = await reconstructFlopRanges(preTokens, (line) => preflopDb.rawNode(set.gametype, depth, line),
      { heroPos: mergeHeroPos(heroPosName, isHu) });
  }
  if (!recon.ok) return fail(`range reconstruction: ${recon.reason}`);
  const rangesOk = recon.ranges;
  const findPos = (pos: string) => Object.entries(rangesOk).find(([p]) => p.toUpperCase() === pos.toUpperCase())?.[1];
  // heads-up the dealer is the tree's SB and the table's BTN: either name finds the seat
  const byPos = (pos: string) =>
    findPos(pos) ?? (isHu ? findPos(pos.toUpperCase() === "SB" ? "BTN" : pos.toUpperCase() === "BTN" ? "SB" : pos) : undefined);
  // each preflop all-in's own size (a short stack's jam is not an all-in for the whole depth — aiStudyLine.preflopPotStack)
  const allInTo = hand.actions.filter((a) => a.street === "preflop" && a.type === "all-in").map((a) => Number(a.amount));
  const pps = preflopPotStack(preTokens, depth, seatOrder,
    allInTo.length === preTokens.filter((t) => t === "RAI").length && allInTo.every((x) => Number.isFinite(x) && x > 0) ? allInTo : undefined);
  // THE ANTES ARE IN THE POT (2026-09-22). preflopPotStack counts blinds and bets only; a CoinPoker HU hand also
  // put 2 x ante of dead money in. Left out, the flop solve plays a 5.4bb pot as 5bb. The STACK needs nothing:
  // the depth handed in (solvePostflopHuStrategy) is already the stack after the ante.
  const anteHu = huCp ? (hand.anteBb ?? HU_ANTE_BB) : 0;
  const flopPot = Math.round((pps.pot + 2 * anteHu) * 100) / 100;
  const flopStack = Math.round(pps.stack * 100) / 100;
  if (flopStack <= 0.5) return fail("preflop line is (near) all-in");

  const heroCards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/i.test(c)).map(SHORT_C);
  const heroComboIdx = heroCards.length === 2 ? comboIndex(heroCards[0]!, heroCards[1]!) : null;
  const streets = cur === "flop" ? [tk.flop] : cur === "turn" ? [tk.flop, tk.turn] : [tk.flop, tk.turn, tk.river];
  // Who took each of those tokens, in the chain's own position names (HU seats the dealer as SB, below),
  // so the walk can check its rotation against the capture rather than trusting the token order blind.
  const chainPos = (seatId: number): string | null => {
    const p = hand.positions?.[seatId];
    if (!p) return null;
    return isHu && p.toUpperCase() === "BTN" ? "SB" : p;
  };
  const seatsOf = (ss: number[]) => ss.map(chainPos);
  const streetSeats =
    cur === "flop" ? [seatsOf(tk.seats.flop)]
    : cur === "turn" ? [seatsOf(tk.seats.flop), seatsOf(tk.seats.turn)]
    : [seatsOf(tk.seats.flop), seatsOf(tk.seats.turn), seatsOf(tk.seats.river)];

  // The chain's seats. Heads-up: OOP/IP as the exploit spot derived them. THREE-WAY (2026-09-19, Ultra): the
  // seats in postflop order, the middle one GTO Wizard's "OOP+1". FOUR AND FIVE WAY (2026-09-21): no tree
  // anywhere holds four seats, so the field is COLLAPSED to three — a villain who has committed nothing this
  // street is dropped (his chips stay in the pot), or two adjacent villains are merged into one seat carrying
  // both ranges — and where more than one collapse is legal they are solved separately and blended. See
  // services/multiwayCollapse.ts for the rules and the measured cost of each. Every seat is modelled at the
  // chart-derived effective stack, as heads-up already is: the table's per-seat stacks are "last read" and may
  // already reflect this street's bet, so rolling them forward would double-count.
  type SeatSpec = Pick<AiChainSpec, "oopPos" | "ipPos" | "oopRange" | "ipRange" | "midPos" | "midRange" | "heroSeat">;
  /** One tree to walk: the seats, and the line as those seats played it. */
  interface Walkable { seatSpec: SeatSpec; streets: string[][]; streetSeats: (string | null)[][]; kind: string | null }
  // ALL-IN PREFLOP IS NOT A FLOP SEAT (2026-09-25, harness seed 1333 [jam]): an 18bb small blind jams, two 100bb
  // players call — the flop is theirs, with a side pot; the jammer never acts again. The tree was built three-way
  // with the jammer "modelled at the effective stack" (82bb he does not have), betting and folding on every street.
  // A seat that went all-in PREFLOP (its own all-in action) leaves the tree while two or more players can still
  // act; its chips stay in the pot. What that loses is the main pot's showdown against his range — said in the note.
  const preAllIn = new Set(hand.actions.filter((a) => a.street === "preflop" && a.type === "all-in")
    .map((a) => String(hand.positions?.[a.seatId] ?? "").toUpperCase()).filter(Boolean));
  const liveAtFlop = Object.keys(recon.ranges).filter((p) => !preAllIn.has(p.toUpperCase()));
  const droppedAllIn = liveAtFlop.length >= 2 ? Object.keys(recon.ranges).filter((p) => preAllIn.has(p.toUpperCase())) : [];
  if (droppedAllIn.length) {
    const note = `ALL-IN PREFLOP: ${droppedAllIn.join(", ")} ${droppedAllIn.length === 1 ? "is" : "are"} all-in and never act again, so the tree holds ` +
      `${liveAtFlop.join("/")} with ${droppedAllIn.length === 1 ? "his" : "their"} chips in the pot (the main pot's showdown against ${droppedAllIn.length === 1 ? "that range" : "those ranges"} is not modelled)`;
    sixNote = sixNote ? `${sixNote} · ${note}` : note;
  }
  const flopSeats = droppedAllIn.length ? liveAtFlop : Object.keys(recon.ranges);
  const arr = (p: string) => buildRangeArray(classWeightsToSpec(recon.ranges[p]!));
  const ordered = [...flopSeats].sort(
    (a, b) => POSTFLOP_ORDER.indexOf(a.toUpperCase()) - POSTFLOP_ORDER.indexOf(b.toUpperCase())
  );
  // seats with nothing behind: all-in. The re-root and the last resort leave the ones all-in since an EARLIER street
  // out of the tree (they never act again; their chips stay in the pot).
  const allInSeats = new Set(Object.entries(hand.positions ?? {})
    .filter(([id]) => Number(hand.stacks?.[Number(id)] ?? 1) <= 0.01)
    .map(([, pos]) => String(pos).toUpperCase()));
  const specOf = (three: { pos: string; range: number[] }[], heroIdx: number): SeatSpec => ({
    oopPos: three[0]!.pos, midPos: three[1]!.pos, ipPos: three[2]!.pos,
    oopRange: three[0]!.range, midRange: three[1]!.range, ipRange: three[2]!.range,
    heroSeat: heroIdx === 0 ? "oop" : heroIdx === 1 ? "mid" : "ip",
  });

  // THE SOLVE RAKES LIKE THE GAME (2026-09-17). Without a rake spec the AI custom solve defaults to GTO Wizard's
  // 5% / 0.6bb cap (their NL500). Ignition NL200 ring is 5% with a cap by players DEALT ($1/$2/$3/$4 at 2/3/4-5/6+,
  // profiles.rakeCapCents) - 2bb six-handed, more than three times the default. Chart preflop, AI postflop: both
  // now at the table's own rake under the 6-max strategy.
  const dealt = Object.keys(hand.positions ?? {}).length + (hand.positions?.[hand.heroSeatId] ? 0 : 1);
  const rake6 = sixMax ? { pct_of_pot: 5, cap_in_chips: rakeCapCents(Math.max(2, dealt)) / 200, preflop_rake_type: null }
    // CoinPoker HU NL200: 5%, cap 0.9bb — the rake the cp200a charts were solved at (bb units, like the 6-max cap)
    : huCp ? { pct_of_pot: HU_RAKE.pct_of_pot, cap_in_chips: HU_RAKE.cap_bb, preflop_rake_type: null }
    : null;
  let walkables: Walkable[] = [];
  let blendWhy: string | null = null;
  /** RE-ROOT: the chain starts at the current street with this pot/stack (see rerootCollapse below) */
  let reroot: { first: 1 | 2; pot: number; stack: number } | null = null;
  if (flopSeats.length >= 3) {
    const heroAt = ordered.findIndex((p) => p.toUpperCase() === heroPosName.toUpperCase());
    if (heroAt < 0) return fail(`hero (${heroPosName}) is not among the ${ordered.length} seats reaching the flop (${ordered.join("/")})`);
    if (flopSeats.length === 3) {
      walkables = [{ seatSpec: specOf(ordered.map((p) => ({ pos: p, range: arr(p) })), heroAt), streets, streetSeats, kind: null }];
      const note =
        `3-way flop — GTO Wizard AI 3-player tree (Ultra): wager-free streets use fixed bets of ` +
        `${THREE_WAY_SIZES.bet.join("/")} pot and ${THREE_WAY_SIZES.raise.join("/")} raises; ` +
        `every seat modelled at the effective stack (${flopStack}bb)`;
      sixNote = sixNote ? `${sixNote} · ${note}` : note;
    } else {
      // A collapse has to know WHO played each token; an unattributed one could belong to the seat being
      // dropped, and dropping a seat whose chips are in the pot silently shrinks it.
      if (streetSeats.some((st) => st.some((x) => x == null))) {
        return fail(`${flopSeats.length} players reached the flop and the capture does not say who played every ` +
          `postflop action — a four-way spot cannot be collapsed without that`);
      }
      const toks: SeatTok[][] = streets.map((st, i) => st.map((tok, j) => ({ tok, seat: streetSeats[i]![j]! })));
      const cSeats = ordered.map((p) => ({ pos: p, range: arr(p) }));
      const plans = planCollapses(cSeats, ordered[heroAt]!, toks);
      let picked = pickCollapses(plans);
      let rerootWhy: string | null = null;
      if (!picked && cur !== "flop") {
        // NO COLLAPSE FROM THE FLOP (every villain put chips in on an earlier street, none adjacent) — RE-ROOT at
        // the current street: earlier streets' chips become plain pot, so a villain who only checked (or has not
        // acted) THIS street can be dropped again. The ranges entering it are narrowed through the earlier streets
        // by 3-seat walks that each keep hero, every earlier aggressor and some of the callers (the callers left
        // out of a walk are the approximation). Brady 2026-09-22: "let's try solve for it".
        const rr = await rerootCollapse({
          ordered, heroPos: ordered[heroAt]!, arr, streets, streetSeats: streetSeats as string[][], flopPot, flopStack,
          board: tk.board, heroComboIdx, rake: rake6, specOf, allIn: new Set(ordered.filter((p) => allInSeats.has(p.toUpperCase()))),
        });
        if (!rr.ok) {
          // the re-root could not collapse the current street either — fall through to the postflop last resort
          rerootWhy = rr.why;
        } else {
        const rp = rr.picked;
        picked = rp;
        reroot = { first: rr.first, pot: rr.pot, stack: rr.stack };
        walkables = rp.plans.map((pl) => ({
          seatSpec: specOf(pl.seats, pl.heroIdx),
          streets: pl.streets.map((st) => st.map((t) => t.tok)),
          streetSeats: pl.streets.map((st) => st.map((t) => t.seat)),
          kind: pl.kind,
        }));
        blendWhy = rp.why;
        const note =
          `${flopSeats.length}-WAY, RE-ROOTED AT THE ${cur.toUpperCase()}: no collapse fits from the flop (every villain ` +
          `put chips in earlier), so the earlier streets are pot (${rr.pot}bb, ${rr.stack}bb behind) and the ` +
          `${cur} alone is collapsed: ${rp.plans.map((pl) => pl.kind).join(" | ")}. Entering ranges narrowed through ` +
          `the earlier streets by ${rr.walks} three-seat walk(s) (${rr.left} left out of some) — approximate. ${rp.why}.` +
          (rr.allIn.length ? ` ALL-IN LEFT OUT: ${rr.allIn.join(", ")} went all-in on an earlier street and cannot act again — ` +
            `their chips are in the pot, but hero's showdown equity against their range (the main pot they contest) is not modelled.` : "");
        sixNote = sixNote ? `${sixNote} · ${note}` : note;
        }
      }
      if (!picked) {
        // THE POSTFLOP LAST RESORT (2026-09-23, Brady: "100% coverage on all spots"). Every villain has chips in on
        // this street and no pair is mergeable, so nothing reduces the field to three. What every such spot still
        // has is HERO and the LAST AGGRESSOR: the street is re-rooted heads-up between them, the other villains'
        // chips (and hero's own earlier chips this street) stay in the pot as dead money, and hero faces the
        // aggressor's bet at the real price. Unmodelled, said in the answer: the other villains' ranges and hands,
        // and the narrowing of the two entering ranges by the earlier streets. It beats a blank.
        const lr = heroVsAggressor({ ordered, heroPos: ordered[heroAt]!, arr, streets, streetSeats: streetSeats as string[][], flopPot, flopStack, allIn: allInSeats });
        if (!lr) return fail(`${collapseRefusal(cSeats, toks)}${rerootWhy ? ` — re-rooting at the ${cur} failed: ${rerootWhy}` : ""} — and no last resort fits (nobody to face, or everyone all-in)`);
        walkables = [lr.walkable];
        reroot = { first: lr.first as 1 | 2, pot: lr.pot, stack: lr.stack };
        blendWhy = null;
        const note =
          `POSTFLOP LAST RESORT — ${collapseRefusal(cSeats, toks)}${rerootWhy ? ` (re-rooting at the ${cur}: ${rerootWhy})` : ""}; played as hero (${ordered[heroAt]}) against the last ` +
          `aggressor (${lr.villain}) alone at the ${cur}: ${lr.others.length ? `${lr.others.join(", ")}'s ${lr.dead}bb left in the pot as dead money` : "no other chips"}, ` +
          `${lr.pot}bb in the middle ${lr.bet > 0 ? `before the ${lr.bet}bb ${lr.villainBet ? "bet" : "raise"} hero faces` : "with the action checked to hero"}, ${lr.stack}bb behind; ` +
          `the other villains' ranges and hands are not modelled and the two entering ranges are not narrowed by the earlier streets.`;
        sixNote = sixNote ? `${sixNote} · ${note}` : note;
      }
      if (!reroot) walkables = picked!.plans.map((pl) => ({
        seatSpec: specOf(pl.seats, pl.heroIdx),
        streets: pl.streets.map((st) => st.map((t) => t.tok)),
        streetSeats: pl.streets.map((st) => st.map((t) => t.seat)),
        kind: pl.kind,
      }));
      if (!reroot) {
      blendWhy = picked!.why;
      const note =
        `${flopSeats.length}-WAY APPROXIMATION — no solver models more than three postflop seats, so ` +
        `${ordered.join("/")} is collapsed to three: ${picked!.plans.map((pl) => pl.kind).join(" | ")}. ` +
        `${picked!.why}. Dropped seats keep their chips in the pot; a merged seat holds both ranges.`;
      sixNote = sixNote ? `${sixNote} · ${note}` : note;
      }
    }
  } else {
    // HU trees seat the dealer as SB; the vision layer may label him BTN.
    const posName = (p: string) => (isHu && p.toUpperCase() === "BTN" ? "SB" : p);
    const oopPos = posName(spot.oopPos);
    const ipPos = posName(spot.ipPos);
    const oopW = byPos(oopPos);
    const ipW = byPos(ipPos);
    if (!oopW || !ipW) return fail("reconstructed ranges don't cover both seats");
    walkables = [{
      seatSpec: {
        oopPos, ipPos,
        oopRange: buildRangeArray(classWeightsToSpec(oopW)),
        ipRange: buildRangeArray(classWeightsToSpec(ipW)),
        heroSeat: spot.heroSeat,
      },
      streets, streetSeats, kind: null,
    }];
  }

  const t0 = Date.now();
  const solveMetaBase = {
    origin: origin ?? "adhoc",
    sessionId: sessionId ?? hand.sessionId ?? null,
    clientHandId: hand.clientHandId ?? null,
    wrapperHandId: hand.handId ?? null,
    decisionKey: JSON.stringify([hand.street, hand.board, hand.heroCards, hand.currentNode.toCall, hand.actions.length]),
    street: cur, board: tk.board, heroCards: heroCards.join("") || null, heroPos: heroPosName,
    tier: "ai-chain",
  };

  // ONE WALK PER COLLAPSE — exactly one when the field already fits a tree. Every walk is kept (inputs, every
  // node, the verdict) so the answer can be inspected later exactly as it was, and diffed against a re-solve.
  const walks: { kind: string | null; data: any; line: string; solveId: number | null; trace?: any }[] = [];
  const walkFails: string[] = [];
  // THE COLLAPSES RUN AT ONCE (2026-09-23, hand 729). Each collapse is its own cloud tree and walk, 5-10 s
  // of mostly waiting on GTO Wizard; three of them in a row put a four-way flop at 15-19 s before the answer.
  // They share nothing but the token, so they are launched together and read back in order (the first walk
  // still defines the action menu). CHAIN_SERIAL_COLLAPSES=1 restores the one-at-a-time loop.
  const solveOne = (w: (typeof walkables)[number]) => solveAiChain({
    ...(rake6 ? { rake: rake6 } : {}),
    ...w.seatSpec,
    flopPot: reroot ? reroot.pot : flopPot,
    flopStack: reroot ? reroot.stack : flopStack,
    ...(reroot ? { firstStreet: reroot.first } : {}),
    board: tk.board,
    streets: w.streets,
    streetSeats: w.streetSeats,
    heroComboIdx,
    rangeSource: rangeSource ?? undefined,
    handKey: String(hand.clientHandId ?? hand.handId ?? "") || undefined,
    planTag: w.kind,
  });
  // THE DRY RUN (2026-09-25, the input-mutation harness): everything up to here is the SOLVER INPUT — ranges for
  // every flop seat, the collapse plan, pot and stacks, the street tokens. The harness asks "does a solver input
  // exist for this capture?" over thousands of mutated hands, offline; the cloud call itself is not the question.
  // POSTFLOP_DRY_RUN=1 stops here and reports the input instead of solving. Never set in production.
  if (process.env.POSTFLOP_DRY_RUN === "1") {
    const heroCls = heroClassOf(hand);
    const heroW = (() => { const r = rangeSource && recon.ok ? byPos(heroPosName) : undefined; return r && heroCls ? r[heroCls] ?? 0 : null; })();
    return {
      res: {
        ok: true, source: "gtow-api-postflop", tier: "ai-chain", street: cur, setId: set.id ?? "6max-ign200", gametype: `dry-run · ${walkables.length} walkable(s)`,
        depth, line: `${preTokens.join("-")} / ${streets.map((s) => s.join("-")).join(" | ")}`, pos: heroPosName, heroClass: heroCls,
        actions: [], decision: null, rangeSource: rangeSource ?? undefined,
        warning: [sixNote, `DRY RUN: solver input built — ${walkables.length} walkable(s), hero ${heroCls ?? "?"} weight ${heroW == null ? "n/a" : heroW.toFixed(3)}, pot ${reroot ? reroot.pot : flopPot}bb, stack ${reroot ? reroot.stack : flopStack}bb`].filter(Boolean).join(" · "),
        notInRange: heroW != null && !(heroW > 0) ? true : undefined,
        dryRun: {
          flopPot, flopStack, walkables: walkables.length, heroWeight: heroW, flopSeats: [...flopSeats],
          ranges: recon.ok ? recon.ranges : undefined, preTokens: [...preTokens], streets, streetSeats,
          trees: walkables.map((w) => {
            const s = w.seatSpec;
            const seats = [{ pos: s.oopPos, range: s.oopRange }, ...(s.midPos && s.midRange ? [{ pos: s.midPos, range: s.midRange }] : []), { pos: s.ipPos, range: s.ipRange }];
            return { kind: w.kind, heroSeat: s.heroSeat, seats, streets: w.streets };
          }),
        },
      } as FastSolveResult,
      why: null,
    };
  }
  const chains = process.env.CHAIN_SERIAL_COLLAPSES === "1"
    ? await (async () => { const out = []; for (const w of walkables) out.push(await solveOne(w)); return out; })()
    : await Promise.all(walkables.map(solveOne));
  for (let wi = 0; wi < walkables.length; wi++) {
    const w = walkables[wi]!;
    const chain = chains[wi]!;
    const meta = { ...solveMetaBase, solveMs: Date.now() - t0 };
    if (!chain.ok) {
      if (chain.trace && origin !== "warm") solveStore.save({ ...meta, line: null, solves: null, ok: false, why: chain.why }, chain.trace);
      walkFails.push(w.kind ? `${w.kind}: ${chain.why}` : chain.why);
      continue;
    }
    walks.push({
      kind: w.kind, data: chain.data, line: `${preTokens.join("-")} / ${chain.line}`, trace: chain.trace,
      solveId: solveStore.save({ ...meta, line: `${preTokens.join("-")} / ${chain.line}`, solves: chain.solves, ok: true, why: null }, chain.trace),
    });
  }
  logChain(hand, cur, origin, chains, tEntry, t0);
  // A collapse that will not walk is survivable while another one did. ALL of them failing used to be the miss;
  // since 2026-09-24 (postflop sweep: a merged SB+BB check-raise nobody could walk) a 3+ way field that faces a bet
  // falls back to the POSTFLOP LAST RESORT here too — hero against the last aggressor, heads-up at this street, the
  // other villains' chips as dead money — exactly as when no collapse is legal at all. A blank is never the answer.
  if (!walks.length && flopSeats.length >= 3 && !walkables.some((w) => /^last-resort/.test(w.kind ?? ""))) {
    const heroAtLr = ordered.findIndex((p) => p.toUpperCase() === heroPosName.toUpperCase());
    const lr = heroAtLr >= 0
      ? heroVsAggressor({ ordered, heroPos: ordered[heroAtLr]!, arr, streets, streetSeats: streetSeats as string[][], flopPot, flopStack, allIn: allInSeats })
      : null;
    if (lr) {
      reroot = { first: lr.first as 1 | 2, pot: lr.pot, stack: lr.stack };
      blendWhy = null;
      const c = await solveOne(lr.walkable as any);
      const meta = { ...solveMetaBase, solveMs: Date.now() - t0 };
      if (c.ok) {
        walks.push({
          kind: lr.walkable.kind, data: c.data, line: `${preTokens.join("-")} / ${c.line}`, trace: c.trace,
          solveId: solveStore.save({ ...meta, line: `${preTokens.join("-")} / ${c.line}`, solves: c.solves, ok: true, why: null }, c.trace),
        });
        const note =
          `POSTFLOP LAST RESORT — no collapse of the ${ordered.length}-way field could be walked (${walkFails.join("; ")}); ` +
          `played as hero (${ordered[heroAtLr]}) against the last aggressor (${lr.villain}) alone at the ${cur}: ` +
          `${lr.others.length ? `${lr.others.join(", ")}'s ${lr.dead}bb left in the pot as dead money` : "no other chips"}, ` +
          `${lr.pot}bb in the middle ${lr.bet > 0 ? `before the ${lr.bet}bb bet hero faces` : "with the action checked to hero"}, ${lr.stack}bb behind; ` +
          `the other villains' ranges and hands are not modelled and the two entering ranges are not narrowed by the earlier streets.`;
        sixNote = sixNote ? `${sixNote} · ${note}` : note;
        walkFails.length = 0;
      } else {
        walkFails.push(`last resort: ${c.why}`);
      }
    }
  }
  if (!walks.length) return fail(walkFails.join(" · ") || "no walkable tree");
  const sizeSnaps = [...new Set(chains.flatMap((c) => (c.ok ? c.snaps ?? [] : [])))];
  if (sizeSnaps.length) {
    sixNote = [sixNote, `WAGER SIZE SNAPPED onto the tree: ${sizeSnaps.join("; ")} — the tree offers no closer size there` +
      (sizeSnaps.some((x) => /ALL-IN/.test(x)) ? " (GTO Wizard turns a raise that leaves little behind into its all-in)" : "")]
      .filter(Boolean).join(" · ");
  }
  if (walkFails.length) {
    sixNote = [sixNote, `${walkFails.length} of ${walkables.length} collapses could not be walked (${walkFails.join("; ")})`]
      .filter(Boolean).join(" · ");
  }

  // The first walk defines the action menu; the others are re-expressed on it and blended. A collapse whose
  // menu differs is dropped rather than mixed in — different menus mean they disagree about the tree itself.
  const ref = walks[0]!;
  const refSols: any[] = ref.data?.action_solutions ?? [];
  const codes: string[] = refSols.map((a) => String(a.action?.code ?? a.action?.display_name ?? "?"));
  let blended: number[][] | null = null;
  let blendedCount = 1;
  if (walks.length > 1) {
    const aligned: number[][][] = [];
    const dropped: string[] = [];
    for (const w of walks) {
      const a = alignStrategy(codes, (w.data?.action_solutions ?? []).map((x: any) => ({
        code: String(x.action?.code ?? x.action?.display_name ?? "?"), strategy: x.strategy ?? [],
      })));
      if (a) aligned.push(a); else dropped.push(w.kind ?? "?");
    }
    if (aligned.length > 1) {
      blended = blendStrategies(codes, aligned);
      blendedCount = aligned.length;
    }
    if (dropped.length) {
      sixNote = [sixNote, `${dropped.join(", ")} offered a different action menu and was left out of the blend`]
        .filter(Boolean).join(" · ");
    }
  }
  if (blendWhy && blendedCount > 1) {
    sixNote = [sixNote, `blended ${blendedCount} collapses: fold at the most folding one's frequency, bet at the ` +
      `least betting one's — a single collapse over-bets by 8-13pp of aggression`].filter(Boolean).join(" · ");
  }

  const j = ref.data;
  const solveId = ref.solveId;
  const chainLine = ref.line;
  let actions: ActionFreq[];
  if (heroComboIdx != null) {
    actions = refSols.map((a: any, i: number) => ({
      action: labelOf(a),
      frequency: (blended ? blended[i]![heroComboIdx] ?? 0 : a.strategy?.[heroComboIdx] ?? 0) * 100,
      ev: a.evs?.[heroComboIdx], betsize: a.action.betsize,
    }));
    // AN ALL-ZERO MIX IS A FAILURE, NOT AN ANSWER (2026-09-24, stress multi-07: FOLD 0 / CALL 0 / RAISE 0 / ALLIN 0,
    // served ok:true with no decision — "notInRange" — after hero's Th was dealt on a board holding Th). The chain
    // floors hero's class in his entering range on every street, so zero everywhere means the combo cannot exist at
    // the node or the node is not hero's; either way the panel would roll nothing and the hand card would draw a
    // blank. Refuse with the cause named (zeroMixReason) so the answer log counts it and the trace gets read.
    if (actions.length && actions.every((a) => a.frequency <= 0)) {
      const heroClass = heroClassOf(hand);
      const heroW = byPos(heroPosName);
      const arrivalWeight = heroW && heroClass ? Number(heroW[heroClass] ?? 0) : null;
      return fail(zeroMixReason({
        heroCards, board: hand.board ?? [], heroPos: heroPosName, nodePos: j.action_solutions?.[0]?.action?.position ?? null,
        heroClass, arrivalWeight, plan: ref.kind, actions: actions.map((a) => a.action), hu: isHu,
      }));
    }
  } else {
    // no hero cards: aggregate frequency is all the node offers, so average it across the collapses
    actions = refSols.map((a: any, i: number) => {
      const fs = walks.map((w) => Number(w.data?.action_solutions?.[i]?.total_frequency ?? NaN)).filter((x) => Number.isFinite(x));
      return {
        action: labelOf(a), frequency: (fs.length ? fs.reduce((x, y) => x + y, 0) / fs.length : 0) * 100,
        ev: a.total_ev, betsize: a.action.betsize,
      };
    });
  }
  return { why: null, res: {
    ok: true,
    source: "gtow-api-postflop",
    tier: "ai-chain",
    solveId,
    rangeSource: rangeSource ?? undefined,
    street: cur,
    setId: sixMax ? "6max-ign200" : set.id,
    gametype: sixMax && rangeSource ? rangeSource : set.gametype,
    depth,
    line: chainLine,
    pos: j.action_solutions?.[0]?.action?.position ?? null,
    heroClass: heroClassOf(hand),
    actions,
    decision: pickWeightedAction(actions),
    approx: true,
    warning: sixNote,
  },
  // THE RIVER MES INPUT (2026-09-22): a heads-up river walked as ONE tree carries every seat's exact river-entry
  // range in its trace — all services/riverMes.ts needs to solve the river locally against the pool. Blended
  // collapses are left out: their answer is a mix of trees, not one tree a local solve could reproduce.
  mesInput: cur === "river" && walks.length === 1 && heroComboIdx != null && ref.trace
    ? { trace: ref.trace, preTokens, heroCards } : undefined };
}

/**
 * Hero versus the last aggressor at the current street (the postflop LAST RESORT). Reads the chips each seat put in on
 * the street from its tokens (R<total> sets a seat's total, C matches the level), picks the last villain who bet or
 * raised (else the villain with the most in), and returns a heads-up walkable re-rooted at that street:
 *   pot before the bet = pot entering the street + the other villains' chips + hero's own chips this street
 *                        + the aggressor's chips that hero has already matched;
 *   the bet hero faces  = the aggressor's total this street − hero's total this street.
 * Both entering ranges are the flop-arrival ranges (not narrowed by earlier streets — the approximation named in the note).
 */
function heroVsAggressor(a: {
  ordered: string[]; heroPos: string; arr: (p: string) => number[]; streets: string[][]; streetSeats: string[][];
  flopPot: number; flopStack: number; allIn?: Set<string>;
}): { walkable: { seatSpec: any; streets: string[][]; streetSeats: string[][]; kind: string }; first: number; pot: number; stack: number;
      villain: string; others: string[]; dead: number; bet: number; villainBet: boolean } | null {
  const first = a.streets.length - 1;
  const m = first >= 1 ? moneyThrough(a.streets, a.streetSeats, a.flopPot, a.flopStack, first) : { pot: a.flopPot, stack: a.flopStack, folded: new Set<string>(), aggressors: new Set<string>() };
  if (m.stack <= 0.5) return null;
  const toks = a.streets[first]!, seats = a.streetSeats[first]!;
  const put: Record<string, number> = {};
  let level = 0, lastAgg: string | null = null;
  toks.forEach((tok, j) => {
    const seat = seats[j]!;
    if (tok === "C") put[seat] = Math.min(level, m.stack);
    else if (tok === "RAI") { put[seat] = m.stack; level = m.stack; if (seat !== a.heroPos) lastAgg = seat; }
    else if (/^R[\d.]+$/.test(tok)) { const to = Math.min(parseFloat(tok.slice(1)), m.stack); put[seat] = to; level = to; if (seat !== a.heroPos) lastAgg = seat; }
    else if (tok === "F") put[seat] = put[seat] ?? 0;
  });
  const live = a.ordered.filter((p) => !m.folded.has(p) && !toks.some((t, j) => t === "F" && seats[j] === p));
  // a seat all-in since an earlier street never acts again: never the villain hero plays against
  const acting = live.filter((p) => !(a.allIn?.has(p.toUpperCase()) && !seats.includes(p)));
  const wagered = toks.some((t) => t === "RAI" || /^R[\d.]+$/.test(t));
  if (!wagered) {
    // CHECKED TO HERO (2026-09-24, sweep sp-4w-river-allin-checked): nobody bet this street, so there is no aggressor
    // to face. Play hero against the villain who bet most recently on an EARLIER street (else the last one to act),
    // heads-up at this street, with the whole pot in the middle: hero's check-or-bet decision, never a blank.
    let prev: string | null = null;
    for (let i = first - 1; i >= 0 && !prev; i--) {
      const ts = a.streets[i]!, ss = a.streetSeats[i]!;
      for (let j = ts.length - 1; j >= 0; j--) {
        const who = ss[j]!;
        if ((ts[j] === "RAI" || /^R[\d.]+$/.test(ts[j]!)) && who !== a.heroPos && acting.includes(who)) { prev = who; break; }
      }
    }
    const vil = prev ?? acting.filter((p) => p !== a.heroPos).slice(-1)[0];
    if (!vil) return null;
    const heroOop = POSTFLOP_ORDER.indexOf(a.heroPos.toUpperCase()) < POSTFLOP_ORDER.indexOf(vil.toUpperCase());
    const oop = heroOop ? a.heroPos : vil, ip = heroOop ? vil : a.heroPos;
    return {
      walkable: {
        seatSpec: { oopPos: oop, ipPos: ip, oopRange: a.arr(oop), ipRange: a.arr(ip), heroSeat: heroOop ? "oop" : "ip" },
        streets: [heroOop ? [] : ["X"]], streetSeats: [heroOop ? [] : [vil]], kind: `last-resort:hero vs ${vil}`,
      },
      first, pot: m.pot, stack: m.stack, villain: vil, others: acting.filter((p) => p !== a.heroPos && p !== vil), dead: 0, bet: 0, villainBet: false,
    };
  }
  const villain = (lastAgg && acting.includes(lastAgg) ? lastAgg : null) ?? lastAgg ?? acting.filter((p) => p !== a.heroPos).sort((x, y) => (put[y] ?? 0) - (put[x] ?? 0))[0];
  if (!villain || villain === a.heroPos) return null;
  const h = put[a.heroPos] ?? 0, v = put[villain] ?? 0;
  const bet = Math.round((v - h) * 100) / 100;
  if (bet <= 0) return null;
  const others = live.filter((p) => p !== a.heroPos && p !== villain);
  const dead = Math.round(others.reduce((s, p) => s + (put[p] ?? 0), 0) * 100) / 100;
  const pot = Math.round((m.pot + dead + 2 * h) * 100) / 100;
  const stack = Math.round((m.stack - h) * 100) / 100;
  if (stack <= 0.5) return null;
  const heroOop = POSTFLOP_ORDER.indexOf(a.heroPos.toUpperCase()) < POSTFLOP_ORDER.indexOf(villain.toUpperCase());
  const oop = heroOop ? a.heroPos : villain, ip = heroOop ? villain : a.heroPos;
  const street = heroOop ? ["X", `R${bet}`] : [`R${bet}`];
  const streetSeats = heroOop ? [a.heroPos, villain] : [villain];
  return {
    walkable: {
      seatSpec: { oopPos: oop, ipPos: ip, oopRange: a.arr(oop), ipRange: a.arr(ip), heroSeat: heroOop ? "oop" : "ip" },
      streets: [street], streetSeats: [streetSeats], kind: `last-resort:hero vs ${villain}`,
    },
    first, pot, stack, villain, others, dead, bet, villainBet: true,
  };
}

/**
 * ONE LINE PER POSTFLOP DECISION IN THE API LOG (2026-09-24): every street's tree (cached, or CREATED and why),
 * every node read (cache / joined / fetched, with the network time), the pre-chain cost (chart walks, range
 * reconstruction), the fresh cloud solves, and the verdict. `[chain]` is greppable; the same text goes into the
 * answer's timeline (X-Answer-Trace → data/jobs/poller-events.jsonl). This is the line to read when a turn or
 * river is slow: a turn whose FLOP tree reads CREATED is re-solving a street it already had, and the reason after
 * the dash says what moved the key.
 */
function logChain(hand: ParsedHand, cur: string, origin: string | undefined, chains: AiChainResult[], tEntry: number, tChain: number): void {
  const now = Date.now();
  const parts: string[] = [];
  let fresh = 0;
  for (const ch of chains) {
    if (ch.ok) fresh += ch.solves;
    for (const s of ch.trace?.streets ?? []) {
      const ns = s.nodeSrc;
      const nodes = ns
        ? `${ns.cache + ns.joined + ns.fetched} nodes (${ns.cache} cache${ns.joined ? `, ${ns.joined} joined` : ""}, ${ns.fetched} fetched${ns.fetchMs ? ` in ${ns.fetchMs} ms` : ""})`
        : "no nodes";
      if (s.fromCheckpoint) { parts.push(`${s.street} from checkpoint (not re-computed)`); continue; }
      const resumed = s.resumedAt != null ? ` · resumed at hero's node (${s.resumedAt + 1} node${s.resumedAt ? "s" : ""} from the mid-street checkpoint)` : s.resumeMiss ? ` · not resumed: ${s.resumeMiss}` : "";
      parts.push(`${s.street} tree ${s.created ? `CREATED in ${s.solveMs} ms — ${s.treeWhy ?? "no reason recorded"}` : "cached"}${s.reuse ? ` (${s.reuse})` : ""}${resumed} · ${nodes} · walk ${s.walkMs} ms`);
    }
    if (ch.trace?.checkpoint && !ch.trace.checkpoint.from && ch.trace.streets.length > 1) parts.push(`(${ch.trace.checkpoint.note})`);
    if (!ch.ok) parts.push(`FAILED: ${ch.why}`);
  }
  const key = hand.clientHandId ?? hand.handId ?? "?";
  const line = `[chain] hand ${key} ${cur} (${origin ?? "adhoc"}): ${now - tEntry} ms = pre-chain ${tChain - tEntry} ms + chain ${now - tChain} ms · ` +
    `${chains.length} walk${chains.length === 1 ? "" : "s"}, ${fresh} fresh cloud solve${fresh === 1 ? "" : "s"} · ${parts.join(" | ")}`;
  console.log(line);
  tmark("chain summary", line.slice("[chain] ".length), 1200);
}

/** The 6-max ring strategy's id (services/strategies.ts) - the one strategy whose every layer is our own solve. */
const SIX_MAX_STRATEGY = "ign200-ring-6max-equilibrium";
/** CoinPoker 200NL heads-up (services/strategies.ts): cp200a charts preflop, GTO Wizard AI postflop from their ranges */
export const CP_HU_STRATEGY = "cp200-hu-equilibrium";

/**
 * Preflop from the CoinPoker HU NL200 charts (services/hrc2max.ts). Heads-up only; a line the tree cannot walk
 * is a miss with its reason, never a GTO Wizard library answer (a different game: NL500, no ante, no rake here).
 */
async function solvePreflopHu(hand: ParsedHand, heroPos: string | null): Promise<FastSolveResult> {
  heroPos = heroPos ?? hand.positions[hand.heroSeatId] ?? null;
  const miss = (reason: string, extra: Partial<FastSolveResult> = {}): FastSolveResult =>
    ({ ok: false, street: "preflop", gametype: "hu-cp200a", depth: 0, reason, ...extra } as FastSolveResult);
  if (!isHeadsUp(hand)) {
    return miss(`the CoinPoker 200NL heads-up strategy plays heads-up only — ${Object.keys(hand.positions ?? {}).length} seats are dealt here`);
  }
  const preFaults = captureFaults(hand);
  if (preFaults.length) return miss(`the capture of this hand is internally inconsistent, so there is no spot to solve — ${preFaults.join("; ")}`, { kind: "capture-fault" });
  const tokens = buildPreflopTokensHu(hand, heroPos);
  const choice = chartForHu(hand, tokens);
  const resolved = await resolveChartHu(choice);
  if (resolved === "unreachable") return miss("chart server :8777 unreachable — the CoinPoker HU charts cannot be read");
  if (resolved === null) return miss(`no CoinPoker HU chart on the server (wanted ${choice.id})`);
  const walk = await walk3max(tokens, nodeGetterHu(resolved.id));
  if (!walk.ok) {
    return miss(`CoinPoker HU chart ${resolved.id}: ${walk.reason}`, { gametype: resolved.id, depth: choice.depth, line: walk.missingAt ?? "" });
  }
  const line = walk.tokens.join("-");
  // THE NODE MUST BE HERO'S (see solvePreflop6max): heads-up the table's BTN is the tree's SB
  const norm = (p: string) => (p.toUpperCase() === "BTN" ? "SB" : p.toUpperCase());
  const heroSeatPos = norm(hand.positions[hand.heroSeatId] ?? heroPos ?? "");
  const nodePos = norm(String(walk.node.pos ?? ""));
  if (heroSeatPos && nodePos && heroSeatPos !== nodePos) {
    return miss(`the chart's node at "${line || "root"}" belongs to ${nodePos}, but hero is ${heroSeatPos}`,
      { gametype: resolved.id, depth: choice.depth, line: line || "(root)" });
  }
  const heroClass = heroClassOf(hand);
  const cell = heroClass ? walk.node.cells.find((c) => c.hand === heroClass) : undefined;
  const actions = cell ? Object.entries(cell.actions).map(([action, frequency]) => ({ action, frequency })) : [];
  const decision = actions.length ? pickWeightedAction(actions) : null;
  // the charts are solved at 0.2bb/player: a table playing another ante is a different game, said out loud
  const anteNote = hand.anteBb != null && Math.abs(hand.anteBb - HU_ANTE_BB) > 0.02
    ? `this table's ante is ${hand.anteBb}bb/player — the charts are solved at ${HU_ANTE_BB}bb, so the ranges are approximate` : null;
  const snapped = walk.repaired.length ? `${walk.repaired.length} action(s) snapped to the tree's sizes` : null;
  const notes = [choice.note, resolved.fellBack ? `no ${choice.id} tree — answered from ${resolved.id}` : null, snapped, anteNote]
    .filter(Boolean) as string[];
  return {
    ok: true,
    source: "hrc-hu-preflop",
    tier: "chart-hu",
    street: "preflop",
    setId: "hu-cp200a",
    gametype: resolved.id,
    depth: choice.depth,
    line: line || "(root)",
    pos: walk.node.pos,
    heroClass,
    decision,
    actions,
    chartActions: actions,
    chartDecision: decision ?? undefined,
    strategyMode: "chart",
    notInRange: (heroClass != null && !cell) || undefined,
    approx: notes.length ? true : undefined,
    warning: notes.join(" · ") || undefined,
  } as FastSolveResult;
}

/**
 * ONE POSTFLOP PATH FOR EVERY SITE (2026-09-24, Brady: "they should have the same functionality for GTO Wizard
 * postflop AI, they should even be code sharing"). CoinPoker heads-up and Ignition 6-max differ only in what a
 * PostflopSite says: which seats it plays, where the flop-entering ranges come from (its own charts), how the
 * depth as dealt is read, and whether the river MES shadow runs. Everything else — the once-per-hand stack pin,
 * the rotation repair, the capture-fault gate, the tokens, the chain with its per-hand checkpoints and the
 * [chain] log line — is this function.
 */
interface PostflopSite {
  /** the gametype label on misses and faults */
  gametype: string;
  /** the strategy's name in the miss text */
  name: string;
  /** a reason this site cannot take the hand, or null */
  gate: (hand: ParsedHand) => string | null;
  /** heads-up token order and the CoinPoker HU chart ranges/antes/rake (solvePostflopViaChain huCp) */
  huCp: boolean;
  /** the 6-max ring charts supply the flop-entering ranges (solvePostflopViaChain sixMax) */
  sixMax: boolean;
  /** the depth as dealt, from the hand's pinned dealt stacks */
  depthOf: (hand: ParsedHand, heroPos: string | null, dealt: Record<number, number>) => number;
  /** run the on-the-fly river MES shadow/serve on a heads-up river */
  riverMes: boolean;
}

// THE DEPTH IS THE STACK AS DEALT (2026-09-22) for both sites. preflopPotStack takes the stack each seat STARTED
// the hand with and subtracts the preflop money itself; handing it the stack left at the flop subtracted the
// preflop money twice (a 100bb single-raised pot went to the solve as 94.3bb deep instead of 97.3). The ante is
// excepted — the wrapper records it as dead money rather than an action — so the helper's subtraction lands
// exactly on the flop stack. src/scripts/sixMaxDepthSmoke.ts checks the 6-max half.
const HU_CP_SITE: PostflopSite = {
  gametype: "hu-cp200a", name: "CoinPoker HU strategy", huCp: true, sixMax: false, riverMes: false,
  gate: (hand) => (isHeadsUp(hand) ? null : "the CoinPoker 200NL heads-up strategy plays heads-up only"),
  depthOf: (hand, heroPos, dealt) => chartForHu(hand, buildPreflopTokensHu(hand, heroPos), dealt).effective ?? 100,
};
const SIX_MAX_SITE: PostflopSite = {
  gametype: "6max-ign200", name: "6-max strategy", huCp: false, sixMax: true, riverMes: true,
  gate: () => null,
  depthOf: (hand, _heroPos, dealt) => {
    const vals = Object.values(dealt).filter((x) => Number.isFinite(x) && x > 0);
    return dealtEffective(hand, dealt) ?? (vals.length ? Math.min(...vals) : 100);
  },
};

async function solvePostflopSite(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts, site: PostflopSite): Promise<FastSolveResult> {
  heroPos = heroPos ?? hand.positions[hand.heroSeatId] ?? null;
  const street = hand.currentNode.street;
  const gated = site.gate(hand);
  if (gated) return { ok: false, street, reason: gated } as FastSolveResult;
  const set = resolveSet(hand, heroPos, opts.setId);
  if (!set) return { ok: false, reason: `Unknown solution set: ${opts.setId}`, street };
  // ONE READ OF THE STACKS PER HAND (2026-09-23, hand 729; widened to the chart pick and to CoinPoker 2026-09-24,
  // hand 140706500001). The dealt-stack reconstruction drifts a few blinds between probes as the wrapper's stack
  // and committed readings move (101.1 / 100.4 / 106.1 across one hand's streets; 69.28 → 67.88 on the CoinPoker
  // hand), and the depth and the chart pick's ranges are part of GTO Wizard's tree key — so every street
  // re-created and re-walked the flop tree instead of reusing it. The first postflop read of a hand fixes the
  // dealt stacks (pinPostflop); the depth and every chart pick come from those.
  const pin = pinPostflop(hand, (d) => site.depthOf(hand, heroPos, d));
  const depth = opts.depth ?? pin?.depth ?? site.depthOf(hand, heroPos, dealtBySeat(hand));
  // A STREET CAPTURED OUT OF ROTATION POISONS EVERYTHING BELOW (2026-09-21). The tokens are built here, and
  // deriveExploitSpot reads OOP/IP off whoever acted first — so a scrambled street silently reverses the
  // seats and the chain walks a tree with the wrong player out of position. Repair what is provably safe to
  // repair — misplaced CHECKS, which commit nothing — BEFORE the tokens are built. Anything involving chips
  // is left alone for aiChain's rotation cross-check to refuse. See utils/repairPostflopRotation.
  // Late-filed PREFLOP folds are moved back into rotation here too, as the preflop gate does (2026-09-25: the flop
  // used to refuse a line every preflop decision of the hand had answered) — utils/repairPostflopRotation
  // .repairPostflopCapture. A CAPTURE THAT CONTRADICTS ITSELF HAS NO RIGHT ANSWER (2026-09-21). Say so plainly
  // instead of letting it surface as "preflop betting didn't close (missed action?)", which sends you looking for
  // a missing action that was never the problem.
  const fixed = repairPostflopCapture(hand);
  if (fixed.faults.length) {
    return { ok: false, kind: "capture-fault", street, gametype: site.gametype, depth,
      reason: `the capture of this hand is internally inconsistent, so there is no spot to solve — ${fixed.faults.join("; ")}` };
  }
  const tk = buildSpotSolutionTokens(fixed.hand, heroPos, site.huCp);
  const chain = await solvePostflopViaChain(fixed.hand, heroPos, set, depth, tk, opts.origin, opts.sessionId, site.sixMax,
    fixed.notes, site.huCp, pin?.dealt);
  if (chain.res && chain.mesInput && site.riverMes) {
    // On-the-fly river MES (services/riverMes.ts). shadow (default): logged only, the answer untouched.
    // serve: MES becomes the pick when its gate passes. Never throws; any failure returns the chain's answer.
    return applyRiverMes(chain.res, chain.mesInput, {
      clientHandId: hand.clientHandId ?? null, sessionId: opts.sessionId ?? hand.sessionId ?? null,
      origin: opts.origin ?? null, board: hand.board.join(""),
    });
  }
  if (chain.res) return chain.res;
  return { ok: false, reason: `${site.name} postflop: ${chain.why} — no library fallback under this strategy`, street, gametype: site.gametype, depth };
}

/** Postflop under the CoinPoker HU strategy: the shared AI path with the cp200a chart's ranges. */
const solvePostflopHuStrategy = (hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts) => solvePostflopSite(hand, heroPos, opts, HU_CP_SITE);

/** Which of the 6-max strategy's preflop pieces answered this hand, from the answer log (null when no
 *  preflop answer was logged — the poller's probe can miss a decision). */
function preflopPieceFor(hand: ParsedHand): "chart6max" | "chart3max" | "gtow-ai-preflop" | null {
  const cid = hand.clientHandId;
  if (!cid) return null;
  const rows = answerLog.forHand(cid) as { street?: string | null; source?: string | null; text?: string | null }[];
  const pre = rows.filter((r) => r.street === "preflop" && r.text).pop();
  if (!pre?.source) return null;
  return pre.source === GTOW_AI_PREFLOP_SOURCE ? "gtow-ai-preflop"
    : pre.source === "hrc-3max-preflop" || pre.source === "pool-exploit-preflop" ? "chart3max"
    : "chart6max";
}

/**
 * Flop-entering ranges for every seat from the 6-max chart the preflop picker chooses for this hand: the same
 * chart, the same token walk (buildPreflopTokens pads a short table's early seats as folds), so what the postflop
 * solve starts from is exactly what the preflop answers said the seats arrive with.
 */
async function recon6max(hand: ParsedHand, heroPos: string | null, heroPosName: string | null, dealt?: Record<number, number>): Promise<
  | { ok: true; recon: Awaited<ReturnType<typeof reconstructFlopRanges>>; id: string; tokens: string[]; note: string | null }
  | { ok: false; reason: string }
> {
  const tokens = buildPreflopTokens(hand, heroPos);
  if (!preflopClosed(tokens)) return { ok: false, reason: "preflop betting didn't close (missed action?)" };
  // `dealt` = the hand's pinned stacks (pinPostflop): the chart this picks decides the flop-entering ranges, and
  // the ranges are in GTO Wizard's tree key — a pick that moved a rung between streets re-created every tree
  const choice = chartFor6max(hand, heroPos, tokens, dealt);
  const tRes = Date.now();
  const resolved = await resolveChart6max(choice);
  if (Date.now() - tRes > 1000) console.log(`[ranges] chart resolve took ${Date.now() - tRes} ms (${choice.candidates.slice(0, 3).join(" → ")}${resolved && resolved !== "unreachable" ? ` → ${resolved.id}` : ""})`);
  if (resolved === "unreachable") return { ok: false, reason: "6-max chart server (:8777) unreachable" };
  if (!resolved) return { ok: false, reason: `no 6-max chart for this state (${choice.id})` };
  // THE RANGES COME FROM THE BAKE, NOT THE CHART SERVER (2026-09-23, hand 729). This walk read every node over
  // HTTP from :8777 while hero's own decision (solvePreflop6max) read the same tree from data/hrc6max-preflop.sqlite
  // in milliseconds. On a tree the server had not opened yet that meant a 15-20 s cold open in the middle of
  // hero's flop decision — the 4-way limped flop of hand 4919957671 spent 27 s here before its first cloud
  // solve started (42.7 s to the answer; the server log shows the root request timing out and retrying). The
  // baked getter falls back to :8777 on its own when a tree is missing from the bake.
  const get = nodeGetter(resolved.id);
  const tRecon = Date.now();
  let recon: Awaited<ReturnType<typeof reconstructFlopRanges>> = await reconstructFlopRanges(tokens, async (line) => {
    const n = await get(line);
    return n === "unreachable" ? null : n;
  // UP TO SIX SEATS SINCE 2026-09-21. Not because a four-way tree exists — none does anywhere — but because
  // the postflop step COLLAPSES the field to three (services/multiwayCollapse.ts) and needs every seat's
  // arrival range to choose what to drop or merge. The charts stop at the same caller cap GTO Wizard does,
  // so the extra seats arrive through the borrowed-caller shortcut, which is what borrowCaller is for.
  }, { heroPos: mergeHeroPos(heroPosName, false), borrowCaller: true, maxPlayers: 6 });
  if (Date.now() - tRecon > 1000) console.log(`[ranges] reconstructFlopRanges took ${Date.now() - tRecon} ms on ${resolved.id} (${recon.ok ? "ok" : recon.reason.slice(0, 80)})`);
  let fitNote: string | null = null;
  if (!recon.ok) {
    // THE LINE DOES NOT FIT THE TREE (2026-09-22): more limpers, callers or entrants than the capped tree holds
    // (utils/fitLine). For hero's DECISION the fix is to fold the earliest caller; for the flop's RANGES it is
    // not, because the players a fit folds really are at the flop and the postflop solve needs every one of
    // them. So each live seat's range is read from a fitted line that KEEPS that seat (protect) and folds
    // others instead — the same shortcut, pointed at a different player each time. The pot and stacks stay
    // those of the REAL line (the caller's `tokens`), since every one of those chips is really in the middle.
    const firstFail = recon.reason;
    const tFit = Date.now();
    const per = await fittedRangesBySeat(tokens, async (line) => {
      const n = await get(line);
      return n === "unreachable" ? null : n;
    }, { heroPos: mergeHeroPos(heroPosName, false) ?? null, depth: choice.depth });
    if (Date.now() - tFit > 1000) console.log(`[ranges] fitted per-seat walk took ${Date.now() - tFit} ms (${per.ok ? "ok" : per.reason.slice(0, 80)})`);
    if (!per.ok) return { ok: false, reason: `6-max chart ${resolved.id}: ${firstFail}; ${per.reason}` };
    recon = { ok: true, ranges: per.ranges };
    fitNote = `LINE FITTED FOR THE RANGES: the tree holds two limpers, two callers and four entrants, so ` +
      `${per.borrowed.join(", ")} ${per.borrowed.length === 1 ? "was" : "were"} read from a line with fewer players in — pot and stacks are the real ones`;
  }
  const note = [
    choice.note,
    resolved.fellBack ? `no ${choice.id} tree in the set — ranges from ${resolved.id}` : null,
    fitNote,
    ...(recon.ok ? (recon.notes ?? []) : []).map((n) => `RANGE SHORTCUT: ${n}`),
  ].filter(Boolean).join(" · ");
  return { ok: true, recon, id: resolved.id, tokens, note: note || null };
}

/**
 * Postflop under the 6-max ring strategy: the per-street AI chain, conditioned on our 6-max chart's ranges, and
 * nothing behind it. A spot the chain cannot solve (a four-way flop, unreadable line, dead chart server, AI down)
 * is a miss said out loud - the street-root and library tiers answer from a different game and are not offered.
 * Three-way flops solve since 2026-09-19 (GTO Wizard AI Ultra's 3-player trees, see services/aiChain.ts).
 */
/**
 * THE STACKS AS DEALT, READ ONCE PER HAND (2026-09-24). Both postflop strategies reconstruct each seat's dealt
 * stack from the wrapper's live readings (behind + committed + earlier streets, hrc6max.dealtBySeat) on every
 * probe, and every probe reads a little differently. The chain's tree key carries that stack and the ranges the
 * chart pick yields from it, so a reading that moves between streets makes the turn re-create the flop tree and
 * the river re-create both — three cloud solves and three uncached walks where one of each was needed, which is
 * the whole of "turn and river are slower and more fragile". The first postflop read of a hand is kept here and
 * every later probe of that hand uses it (the warm-up, fired when the flop lands, is usually that first read).
 * Keyed by client hand id and bounded. A replay passing an explicit depth still pins — harmless: an archived
 * hand's stacks are all a replay has, and they do not move.
 */
interface PostflopPin { dealt: Record<number, number>; depth: number; street: string; at: number }
const pinnedPostflop = new Map<string, PostflopPin>();
function pinPostflop(hand: ParsedHand, depthOf: (dealt: Record<number, number>) => number): PostflopPin | null {
  const key = String(hand.clientHandId ?? hand.handId ?? "");
  if (!key) return null;
  const hit = pinnedPostflop.get(key);
  if (hit) return hit;
  const dealt = dealtBySeat(hand);
  const pin: PostflopPin = { dealt, depth: depthOf(dealt), street: hand.currentNode.street, at: Date.now() };
  pinnedPostflop.set(key, pin);
  if (pinnedPostflop.size > 60) { const first = pinnedPostflop.keys().next().value; if (first !== undefined) pinnedPostflop.delete(first); }
  tmark("postflop stacks pinned", `hand ${key} at the ${pin.street}: depth ${pin.depth}bb, dealt ${Object.entries(dealt).map(([s, v]) => `${s}:${v}`).join(" ")}`);
  return pin;
}
/** Forget a hand's pin (tests, and a replay that wants a fresh read). */
export function forgetPostflopPin(handKey: string): void {
  pinnedPostflop.delete(handKey);
}
/** Forget a hand's preflop pin (services/preflopPin) — a replay that wants the flop to walk from scratch. */
export function forgetPreflopPin(handKey: string): void {
  forgetPreflopPinInner(handKey);
}

/** Postflop under the 6-max ring strategy: the shared AI path with the 6-max charts' ranges (+ the river MES shadow). */
const solvePostflop6maxStrategy = (hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts) => solvePostflopSite(hand, heroPos, opts, SIX_MAX_SITE);

/**
 * Postflop: the per-street AI chain first (conditioned ranges — see
 * solvePostflopViaChain); the street-root AI shortcut as the net for broken
 * captures; the spot-solution library last, for when the cloud itself fails
 * (unreachable client, daily quota, timeout).
 */
async function solvePostflop(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts): Promise<FastSolveResult> {
  const street = hand.currentNode.street;
  const set = resolveSet(hand, heroPos, opts.setId);
  if (!set) return { ok: false, reason: `Unknown solution set: ${opts.setId}`, street };
  const isHu = set.seats.length === 2;
  const depth = resolveDepth(hand, set.depths?.length ? set.depths : [100], opts.depth);

  const tk = buildSpotSolutionTokens(hand, heroPos, isHu);

  // The per-street chain answers with ranges conditioned on the actual line —
  // the correct equilibrium at hero's node. It requires a clean, walkable
  // capture; anything broken falls through to the street-root net.
  const chain = await solvePostflopViaChain(hand, heroPos, set, depth, tk, opts.origin, opts.sessionId);
  if (chain.res) return chain.res;

  // Street-root net: solves the current street with FLOP-ENTRY ranges and
  // observed pot/stack. Always constructible (no walkable line needed), but
  // earlier-street action never conditions the ranges — hence the warning.
  const ai = await solvePostflopAi(hand, heroPos, set, depth, tk);
  if (ai.res) {
    if (ai.res.ok && ai.res.warning == null) {
      ai.res.warning = `Ranges NOT conditioned on earlier streets (chain: ${chain.why}) — treat as approximate.`;
    }
    return ai.res;
  }

  // Snap the preflop line to the tree's real sizes (live 2.5 → 2.3 in 6-max
  // General); the API rejects off-tree preflop lines. Needs the local charts.
  let preflopActions = tk.preflop.join("-");
  if (preflopDb.available(set.gametype, depth)) {
    const snapped = snapPreflopLine(tk.preflop, (line) => preflopDb.rawNode(set.gametype, depth, line));
    if (snapped.ok) preflopActions = snapped.tokens.join("-");
  }

  let flopActions = tk.flop;
  let turnActions = tk.turn;
  let riverActions = tk.river;
  const query = () =>
    gtowApi.spotSolution({
      gametype: set.gametype,
      depth,
      preflop_actions: preflopActions,
      flop_actions: flopActions.join("-"),
      turn_actions: turnActions.join("-"),
      river_actions: riverActions.join("-"),
      board: tk.board,
    });

  let res = await query();
  // Tier: which layer of the cascade answered this spot.
  //   library-exact — on-tree, no snap
  //   library-snap  — off-tree bet size snapped to a NEARBY tree size (safe, τ-ok)
  //   far-snap      — nearest tree size is > τ away; snapping costs real EV, so
  //                   this spot should be re-solved at the exact size (AI solver).
  let tier: "library-exact" | "library-snap" | "far-snap" = "library-exact";
  let snapLogDist = 0;
  const hasNumericBet = [...tk.flop, ...tk.turn, ...tk.river].some((t) => /^R[\d.]+$/.test(t));
  if (res.ok && !res.data?.action_solutions?.length && hasNumericBet) {
    const snapped = await snapPostflopStreets(set.gametype, depth, tk.board, preflopActions, {
      flop: tk.flop,
      turn: tk.turn,
      river: tk.river,
    });
    if (snapped) {
      flopActions = snapped.flop;
      turnActions = snapped.turn;
      riverActions = snapped.river;
      snapLogDist = snapped.maxLogDist;
      tier = snapped.far ? "far-snap" : "library-snap";
      res = await query();
    }
  }

  if (!res.ok) {
    return { ok: false, reason: `AI chain: ${chain.why}; street-root AI: ${ai.why}; library spot-solution ${res.status}: ${res.error}`, street };
  }
  if (!res.data?.action_solutions?.length) {
    return { ok: false, reason: `AI chain: ${chain.why}; street-root AI: ${ai.why}; no library solution for this line either`, street };
  }

  const j = res.data;
  const heroClass = heroClassOf(hand);
  const heroCards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c));
  const sizeSnapped =
    flopActions.join("-") !== tk.flop.join("-") ||
    turnActions.join("-") !== tk.turn.join("-") ||
    riverActions.join("-") !== tk.river.join("-");
  const line = [preflopActions, flopActions.join("-"), turnActions.join("-"), riverActions.join("-")]
    .filter(Boolean)
    .join(" / ");
  const activePos: string | null = j.action_solutions?.[0]?.action?.position ?? null;

  // Extract hero's specific combo strategy from each action's 1326 array.
  let actions: ActionFreq[];
  let notInRange = false;
  if (heroCards.length === 2) {
    const idx = comboIndex(heroCards[0]!, heroCards[1]!);
    actions = (j.action_solutions ?? []).map((a: any) => ({
      action: labelOf(a),
      frequency: (a.strategy?.[idx] ?? 0) * 100,
      ev: a.evs?.[idx],
      betsize: a.action.betsize,
    }));
    notInRange = actions.every((a) => a.frequency <= 0);
  } else {
    // No hero cards — return the node's aggregate action frequencies instead.
    actions = (j.action_solutions ?? []).map((a: any) => ({
      action: labelOf(a),
      frequency: (a.total_frequency ?? 0) * 100,
      ev: a.total_ev,
      betsize: a.action.betsize,
    }));
  }

  const farWarn =
    tier === "far-snap"
      ? `Villain's bet is far from the nearest tree size (log-dist ${snapLogDist.toFixed(2)} > τ ${SNAP_TAU}); snapping costs real EV — an exact-size AI solve is recommended.`
      : null;

  return {
    ok: true,
    source: "gtow-api-postflop",
    tier,
    street,
    setId: set.id,
    gametype: set.gametype,
    depth,
    line,
    pos: activePos,
    heroClass,
    actions,
    decision: notInRange ? null : pickWeightedAction(actions),
    notInRange: notInRange || undefined,
    approx: sizeSnapped || undefined,
    warning: farWarn ?? j.warning ?? null,
  };
}

/**
 * Postflop with the MES overlay: our own locked-villain exploit solves answer
 * the modeled flop spots (mesPostflop.ts), mirroring the preflop overlay's
 * contract — BOTH answers ride in the result (`exploitDecision` = pool MES,
 * `chartDecision` = equilibrium), `strategyMode` picks the primary, and the
 * GTOW cascade stays the answer everywhere the overlay doesn't cover.
 */
async function solvePostflopWithMes(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts): Promise<FastSolveResult> {
  let mes = null;
  if (hand.currentNode.street === "river") {
    // extracted on demand from the locked tree (cold ~1 min, then cached)
    try {
      const tk = buildSpotSolutionTokens(hand, heroPos);
      const heroPosName = (hand.positions[hand.heroSeatId] ?? heroPos ?? "").toUpperCase() || null;
      const ctx = hand.board.length >= 5 ? mesRiverContext({
        positions: [...Object.values(hand.positions), ...(heroPosName ? [heroPosName] : [])],
        heroPos: heroPosName, pf3Tokens: buildPreflopTokens3max(hand, heroPos),
        flopTokens: tk.flop, turnTokens: tk.turn, board: hand.board,
        heroCards: hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c)), riverCard: hand.board[4]!,
        potBb: hand.potByStreet.flop ?? null,
      }) : null;
      if (ctx) {
        const hit = await mesRiverLookup({ family: ctx.family, board: ctx.board, heroPlayer: ctx.heroPlayer,
          holesHint: ctx.holes, line: ctx.line, riverTokens: tk.river, heroCardsMapped: ctx.heroCardsMapped });
        if (hit) {
          hit.evGainBb = ctx.evGainBb; hit.exact = ctx.exact;
          hit.tag = `${ctx.family} @ ${ctx.board}${ctx.exact ? "" : "~"} river (+${ctx.evGainBb}bb pool MES)`;
          if (!ctx.exact) hit.warning = `Flop ${hand.board.slice(0, 3).join("")} answered from nearest solved texture ${ctx.board} (dist ${ctx.bd.toFixed(1)}) — approximate. ` + (hit.warning ?? "");
          mes = hit;
        }
      }
    } catch { mes = null; }
  } else if (hand.currentNode.street === "flop" || hand.currentNode.street === "turn") {
    try {
      const tk = buildSpotSolutionTokens(hand, heroPos);
      // hand.positions only labels seats the FEED named — hero's own position
      // usually arrives via the caller (derived from his blind post), so fold
      // it back in before the 3-max shape check
      const heroPosName = (hand.positions[hand.heroSeatId] ?? heroPos ?? "").toUpperCase() || null;
      mes = mesPostflopLookup({
        positions: [...Object.values(hand.positions), ...(heroPosName ? [heroPosName] : [])],
        heroPos: heroPosName,
        pf3Tokens: buildPreflopTokens3max(hand, heroPos),
        flopTokens: tk.flop,
        turnTokens: hand.currentNode.street === "turn" ? tk.turn : undefined,
        board: hand.board,
        heroCards: hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c)),
        potBb: hand.potByStreet.flop ?? null,
      });
    } catch { mes = null; /* overlay must never break the GTO path */ }
  }

  const mode: "exploit" | "chart" = opts.strategy ?? "exploit";

  // The overlay alone can answer a covered spot even when the GTOW cascade is
  // down — but a covered spot also shouldn't WAIT on a cloud solve when MES is
  // the primary anyway. Chart mode still consults GTOW (its equilibrium is the
  // established reference); exploit mode answers instantly from our solve.
  if (mes && !mes.notInRange && mode === "exploit") {
    const set = resolveSet(hand, heroPos, opts.setId);
    return {
      ok: true,
      source: "mes-postflop",
      tier: "exploit-postflop",
      street: hand.currentNode.street,
      setId: set?.id ?? "mes",
      gametype: set?.gametype ?? "3max",
      depth: resolveDepth(hand, set?.depths?.length ? set.depths : [100], opts.depth),
      line: mes.tag,
      pos: hand.positions[hand.heroSeatId] ?? heroPos,
      heroClass: heroClassOf(hand),
      actions: mes.actions,
      decision: mes.exploitDecision,
      exploitDecision: mes.exploitDecision ?? undefined,
      chartDecision: mes.chartDecision ?? undefined,
      chartActions: mes.gtoActions?.length ? mes.gtoActions : undefined,
      exploitTag: mes.tag,
      strategyMode: "exploit",
      rangeSource: `MES ${mes.family} @ ${mes.board} (hero: exploit range, villain: pool calling range, villain locked to pool frequencies)`,
      mesBoard: mes.board, mesEvGainBb: mes.evGainBb, mesExact: mes.exact,
      approx: !mes.exact || undefined,
      warning: mes.warning,
    };
  }

  const res = await solvePostflop(hand, heroPos, opts);
  if (mes && res.ok) {
    // chart mode (or hero off the exploit range): GTOW answer stays primary,
    // the MES answer rides along so the tabs can flip without a re-solve
    res.exploitDecision = mes.exploitDecision ?? undefined;
    res.exploitActions = mes.actions?.length ? mes.actions : undefined;
    res.chartDecision = res.decision ?? mes.chartDecision ?? undefined;
    res.exploitTag = mes.tag;
    res.strategyMode = mode;
    res.mesBoard = mes.board; res.mesEvGainBb = mes.evGainBb; res.mesExact = mes.exact;
    if (mes.notInRange && mode === "exploit") {
      res.warning = [res.warning, "Hero's combo is outside the exploit flop range — equilibrium answer shown."]
        .filter(Boolean).join(" ");
    }
  }
  return res;
}

/**
 * Solve a hand node: preflop from the local charts, postflop from the
 * spot-solution API. Assumes hero is to act (the caller checks `toActIsHero`).
 */
/**
 * Preflop from OUR 6-max NL200 ring charts (services/hrc6max.ts) instead of the GTO Wizard NL500 library that
 * answers 6-handed spots by default at a fraction of our rake (cap 0.6bb there, 2bb here).
 *
 * Opt-in per strategy: the set is still being solved, so only a session that declares the 6-max strategy reaches
 * it, and a state whose tree has not landed yet falls back down the chart picker's preference list, then out to
 * the library — every step of that said out loud in `warning`, never silently.
 *
 * Equilibrium only: there is no 6-handed pool model yet, so unlike the 3-max path there is no exploit overlay.
 */
/** How many calls stand in the line — the number the caller cap refused to let hero join. */
function countCallsBefore(tokens: string[]): number {
  return tokens.filter((t) => t === "C").length;
}

async function solvePreflop6max(
  hand: ParsedHand,
  heroPos: string | null,
  origin?: string,
  strategyId?: string | null,
  /** a second read after hero's class had no cell: `keepChart` — on the chart hero's earlier decision was read from
   *  instead of the picker's; `keepCallers` — never folding a caller that earlier decision was read with */
  retry: { keepChart?: string; keepCallers?: boolean } = {},
): Promise<FastSolveResult | null> {
  void origin; void strategyId;
  // A CAPTURE THAT CONTRADICTS ITSELF HAS NO RIGHT ANSWER (2026-09-21), preflop as much as postflop. Without
  // this the corruption surfaces as the line "F-F-F-F-F" — every seat padded to a fold because the capture
  // recorded no action for them — and then as "line continues past a terminal", which reads like a chart gap
  // rather than what it is. Concentrated in the first minutes of a session (30 such failures in 11 minutes
  // on 2026-09-20), so it is worth naming loudly. See utils/repairPostflopRotation.captureFaults.
  // Kept as a belt for callers that reach this piece directly; the live path is gated once, for every table
  // shape, in fastSolveInner (PF-01, 2026-09-23) — the refusal there is terminal, this one used to be a why-prefix.
  const preFaults = preflopCaptureFaults(hand);
  if (preFaults.length) {
    return { ok: false, kind: "capture-fault", street: "preflop", gametype: "6max-ign200", depth: 0,
      reason: `the capture of this hand is internally inconsistent, so there is no spot to solve — ${preFaults.join("; ")}` };
  }
  const tokens = buildPreflopTokens(hand, heroPos);
  const choice = chartFor6max(hand, heroPos, tokens);
  const mqRef = { origin: origin === "replay" ? "replay" as const : "live" as const,
    clientHandId: hand.clientHandId ?? null, handId: hand.handId ?? null,
    actionIndex: hand.actions.length, ts: Date.now() };
  const resolved = await resolveChart6max(retry.keepChart ? { ...choice, candidates: [retry.keepChart] } : choice);
  if (resolved === "unreachable" || resolved === null) {
    // No chart at all is still worth writing down — the picker's gaps say which
    // tree would have answered. Only a reachable server can tell them apart.
    if (resolved === null && !retry.keepChart) missQueue.observe6max({ choice, hand, heroPos, tokens, walk: null, ref: mqRef });
    return null;
  }

  const get = nodeGetter(resolved.id);
  // FIT THE LINE TO THE TREE (2026-09-22, utils/fitLine): fold the earliest plain caller/limper — never hero,
  // never a later raiser — until the capped tree (two limpers, two callers, four entrants) accepts the line.
  // Replaces the node-by-node borrowCaller, which the esoteric stress family broke three ways.
  const heroSeatName = (hand.positions[hand.heroSeatId] ?? heroPos ?? null);
  // THE SAME PLAYERS STAY FOLDED OUT (2026-09-25, harness seed 589 [limps]): a caller an earlier decision of this
  // hand was read without (a fit, the caller-cap borrow) is folded out of this one too (utils/fitLine.foldSeatsOut)
  // — hero's earlier action was chosen on that line, and on the real one the chart may never take it with his hand
  const pinKey = preflopPinKey(hand);
  const prevPin = pinKey ? getPreflopPin(pinKey) : undefined;
  const sticky = prevPin?.piece === "chart6max" && prevPin.foldedSeats?.length && prevPin.rawTokens.every((t, i) => tokens[i] === t)
    ? prevPin.foldedSeats.filter((s) => s.toUpperCase() !== (heroSeatName ?? "").toUpperCase()) : [];
  const walkTokens = sticky.length ? foldSeatsOut(tokens, sticky, choice.depth) : tokens;
  // …and, on a second read, the callers it was read WITH stay in (harness seed 2593 [thin-table]: SB AKs flatted an
  // iso over HJ's limp as picked; facing the squeeze the fit folded HJ's limp — the earliest caller — and read hero's
  // flat at the no-limper node, where the chart never flats AKs: no cell, no decision). Folding one moves the node
  // hero's own earlier action was chosen at; the retry makes the fit and the caller-cap borrow fold someone else, or
  // leaves the line to the AI piece when nobody else can go.
  const earlierCallers = prevPin?.piece === "chart6max" && prevPin.rawTokens.every((t, i) => tokens[i] === t)
    ? actorsWithAllins(prevPin.rawTokens, choice.depth)
        .filter((s, i): s is string => !!s && prevPin.rawTokens[i] === "C" && s.toUpperCase() !== (heroSeatName ?? "").toUpperCase()
          && !(prevPin.foldedSeats ?? []).some((f) => f.toUpperCase() === s.toUpperCase()))
    : [];
  const keepSeats = retry.keepCallers ? earlierCallers : [];
  const walk = await walkFitted(walkTokens, get, { heroSeat: heroSeatName, stack: choice.depth, protect: keepSeats });
  // The 6-max path fed the miss queue nothing until 2026-09-20, so the ring
  // strategy — the one actually played — produced no todo list at all while the
  // 3-max corpus filled 1,105 rows. Chart-selection gaps AND walk misses.
  // THE THIRD CALLER (2026-09-21). The charts cap callers, so hero arriving third finds a node whose tree has
  // no CALL branch at all — and the walk SUCCEEDS, so this used to answer silently from a fold/3-bet-only
  // equilibrium (BTN vs an open and two calls: 77 folds 99%, 22 folds 100%) and the miss queue never saw it.
  // Read his decision one caller fewer instead, say so in the answer, and file it. See utils/borrowHeroCall.
  const borrowed = walk.ok
    ? await borrowHeroCall(walk.tokens, walk.node, get, { heroPos: hand.positions[hand.heroSeatId] ?? heroPos, keep: keepSeats })
    : null;
  missQueue.observe6max({
    choice, hand, heroPos, tokens, walk, ref: mqRef,
    callerCap: borrowed && walk.ok
      ? { pos: String(walk.node.pos), callers: countCallsBefore(walk.tokens), donor: borrowed.line,
          dropped: borrowed.dropped, offered: walk.node.actions.map((x) => x.token ?? "?") }
      : null,
  });
  if (!walk.ok) {
    if (walk.unreachable) return null;
    return { ok: false, reason: `6-max chart ${resolved.id}: ${walk.reason}`, street: "preflop",
      gametype: resolved.id, depth: choice.depth, line: walk.missingAt ?? "" };
  }

  const heroNode = borrowed?.node ?? walk.node;

  const line = walk.tokens.join("-");
  // THE NODE MUST BE HERO'S (2026-09-22). A chart node carries the position it belongs to, and until now
  // nothing checked it against the seat we are actually answering for — so a tree whose rotation disagrees
  // with the table handed hero ANOTHER SEAT'S STRATEGY, with no warning and no approximation flag. It is
  // not hypothetical: the limp charts' post-iso rotation advances two seats on a CALL instead of one
  // (measured — `C-C-R5-F` -> SB, then `C-C-R5-F-C` -> UTG, with the BB's node simply gone), so hero in the
  // BB facing an iso the SB called was answered from UTG's node and graded clean. A wrong answer that looks
  // right is strictly worse than no answer, so this refuses instead. The AI preflop piece has carried the
  // same guard since it was written ("the walked line puts SB on the clock, not hero"); this is the chart
  // half of it, and a refusal here falls through to that piece exactly like any other chart miss.
  const heroSeatPos = (hand.positions[hand.heroSeatId] ?? heroPos ?? "").toUpperCase();
  const nodePos = String(heroNode.pos ?? "").toUpperCase();
  if (heroSeatPos && nodePos && heroSeatPos !== nodePos) {
    return { ok: false, street: "preflop", gametype: resolved.id, depth: choice.depth, line: line || "(root)",
      reason: `the chart's node at "${line || "root"}" belongs to ${nodePos}, but hero is ${heroSeatPos} — ` +
        `this tree's rotation disagrees with the table, so its strategy is not hero's to read` };
  }

  // THE NODE MUST BE TRUSTED (2026-09-23, services/nodeTrust). Two refusals, both handed to the exact GTO Wizard tree:
  //   1. a size snapped PAST τ — the chart has no node at the size hero faces; reading the neighbour costs real EV
  //      (facing 7.5bb over two limps: chart-at-5bb fold 72%, exact tree call 66%);
  //   2. a node the solver never trained — reach or regret past the calibrated bounds (the SB behind two limps
  //      limped AA 84% from a node reached once in 10,000 hands).
  // Both used to answer anyway, flagged. A flagged wrong answer is still a wrong answer; the AI piece is the fix.
  // AN ALL-IN IS ITS OWN SIZE (2026-09-25, harness seed 2053 [jam]). The walk maps our "RAI" token onto the node's
  // LARGEST aggressive size and calls that distance 0 — a CO first-in jam of 25bb landed on the s30 chart's 2.5bb
  // open (the node has no jam), and hero's BTN decision was answered as facing a min-open. The capture knows every
  // all-in's size: one mapped onto a size more than 2x away from it (SNAP_MAX; a jam past the chart's depth counts as
  // the depth) has no node in this chart, so it is refused like any size past τ and the exact tree answers.
  {
    const allIns = hand.actions.filter((a) => a.street === "preflop" && a.type === "all-in").map((a) => Number(a.amount));
    const fitted = walk.fittedLine ?? walkTokens;
    for (const r of walk.repaired) {
      if (r.from !== "RAI" || r.borrowed) continue;
      const nth = fitted.slice(0, r.index).filter((t) => t === "RAI").length;
      const amount = allIns[nth], size = Number(/^R([\d.]+)$/.exec(r.to)?.[1] ?? NaN);
      if (!(amount > 0) || !(size > 0)) continue;
      const d = Math.abs(Math.log(Math.min(amount, choice.depth) / size));
      if (d > SNAP_MAX) {
        // the node's own ALL-IN is the jam whatever its size: a 12bb stack's jam on the 30bb short chart's "All-in"
        // is the picker's stack approximation (said in its note), not a different action
        const at = await get(fitted.slice(0, r.index).join("-"));
        const label = at && at !== "unreachable" ? at.actions.find((x) => x.token === r.to)?.action ?? "" : "";
        if (/all-?in/i.test(label)) continue;
        return { ok: false, street: "preflop", gametype: resolved.id, depth: choice.depth, line: line || "(root)",
          reason: `all-in not in the chart: the ${Math.round(amount * 10) / 10}bb all-in at "${fitted.slice(0, r.index).join("-") || "root"}" has no jam there — ` +
            `the node's largest action is ${r.to} (${d.toFixed(2)} log-distance) — so the exact tree answers` };
      }
    }
  }
  const farSnap = walk.repaired.find((r) => r.far && !r.borrowed);
  if (farSnap) {
    return { ok: false, street: "preflop", gametype: resolved.id, depth: choice.depth, line: line || "(root)",
      reason: `size past τ: ${farSnap.from} is ${farSnap.logDist.toFixed(2)} log-distance from the chart's nearest ${farSnap.to} — no node at that size, so the exact tree answers` };
  }
  const trust = nodeTrust(resolved.id, walk.tokens.join("-"));
  if (trust.starved) {
    return { ok: false, street: "preflop", gametype: resolved.id, depth: choice.depth, line: line || "(root)", reason: trust.why! };
  }

  const heroClass = heroClassOf(hand);
  const cell = heroClass ? heroNode.cells.find((c) => c.hand === heroClass) : undefined;
  // HERO'S CLASS HAS NO STRATEGY AT THIS NODE (2026-09-25, mutation harness `hero-deviates`). The chart holds no cell
  // for a class its equilibrium never brings here, so the answer used to come back ok with NO decision — nothing to
  // play. When that is hero's own doing — an earlier action his pick gave 0% (services/preflopPin.heroDeviation), or
  // an earlier decision the GTO Wizard AI tree answered on a line the chart does not play with this hand — the
  // AI preflop tree, built from the table, answers instead (Brady's rule for a manual deviation, the pruned-branch
  // precedent). A hand played BY the pick that lands here is left as it was: a loud notInRange, a bug to see.
  if (heroClass && !cell) {
    const prev = prevPin;
    const dev = prev?.piece === "chart6max" ? heroDeviation(prev.picks, tokens) : null;
    if (dev || prev?.piece === "gtow-ai-preflop") {
      return { ok: false, street: "preflop", gametype: resolved.id, depth: choice.depth, line: line || "(root)",
        reason: `OFF THE CHART: hero's ${heroClass} has no strategy at "${line || "root"}" in ${resolved.id} — ` +
          (dev ? `hero left the pick at "${dev.codes.join("-") || "root"}" (took ${dev.action ?? dev.took}, which the pick gave ${dev.heroClass ?? "his hand"} 0%)`
            : `hero's last decision was answered by the GTO Wizard AI preflop tree, on a line the chart never plays with this hand`) +
          `, so the AI preflop tree answers from here` };
    }
    // THE CHART CHANGED UNDER HERO (2026-09-25, harness seed 1231 [odd-open]). A limped pot reads a non-blind hero's
    // over-limp/iso decision from the EQUILIBRIUM limp chart (that node is locked to the pool in both pool trees) and
    // his LATER decisions from the full pool tree, where his own earlier node was locked to the POOL's play — so a
    // BTN who iso-raised QJo exactly as the pick said (67%) faced the limp-reraise in a tree whose BTN never isos QJo:
    // no cell, no decision. The pool tree stays the answer whenever hero's hand is in its range there; when it is
    // not, the decision is read on the chart hero's earlier decision came from, and the answer says so.
    // (the fit or the borrow folded a caller hero's earlier decision was read WITH — see earlierCallers above)
    const moved = dev || retry.keepCallers ? [] : earlierCallers.filter((s) =>
      walk.folds.some((f) => f.seat.toUpperCase() === s.toUpperCase()) || borrowed?.dropped?.toUpperCase() === s.toUpperCase());
    if (moved.length) {
      const again = await solvePreflop6max(hand, heroPos, origin, strategyId, { ...retry, keepCallers: true });
      const kept = `LINE KEPT AS THE HAND WAS READ: fitting this line to the tree folded ${moved.join("/")}, whose call hero's earlier ` +
        `decision was read with — hero's ${heroClass} has no strategy at the node that leaves`;
      if (again?.ok && !again.notInRange && again.decision) {
        return { ...again, approx: true, warning: [`${kept}; read with it kept`, again.warning].filter(Boolean).join(" · ") };
      }
      if (again && !again.ok) {
        return { ...again, reason: `${kept}, and the tree cannot hold the line with it kept (${again.reason}) — the AI preflop tree answers` };
      }
    }
    if (!dev && !retry.keepChart && prev?.piece === "chart6max" && prev.chartId !== resolved.id) {
      const again = await solvePreflop6max(hand, heroPos, origin, strategyId, { ...retry, keepChart: prev.chartId });
      if (again?.ok && !again.notInRange && again.decision) {
        const why = `CHART KEPT: hero's ${heroClass} is not in ${resolved.id}'s range at "${line || "root"}" (that tree plays hero's earlier ` +
          `decision at the pool's locked range), so this decision is read on ${prev.chartId}, where his earlier decision was read`;
        return { ...again, approx: true, warning: [why, again.warning].filter(Boolean).join(" · ") };
      }
    }
  }
  const rawActions = cell ? Object.entries(cell.actions).map(([action, frequency]) => ({ action, frequency })) : [];
  // NEVER ROLL INTO A BRANCH HRC NEVER WROTE (services/prunedPicks, 2026-09-25): an action whose child node is
  // pruned is dropped before the roll and the mix re-spread, so hero's own pick can always be continued at the flop
  const prunedPick = await dropPrunedPicks(rawActions, heroNode, borrowed?.line ?? line, get);
  const actions = prunedPick.actions;
  const decision = actions.length ? pickWeightedAction(actions) : null;

  // THE PIN (services/preflopPin, 2026-09-25): this chart and this line are what the flop resumes from — the
  // last preflop answer of the hand names the ranges the postflop chain starts with.
  if (pinKey) {
    // what hero was told here rides along with the pin (preflopPin.heroDeviation reads it at later decisions)
    // every action the NODE offers, at the frequency hero's class was given (0 for one the cell leaves out): hero's
    // actual size snaps against the node's menu, as the walks do — against the cell's actions alone a 7.7bb 3-bet
    // snapped to the 0.7% "Raise 10" instead of the node's "Raise 7" at 0% (seed 144 [hero-deviates])
    // THE CODES ARE THE NODE THE DECISION WAS READ AT: the caller-cap donor when there was one (seed 589: the pin
    // named the real two-limp node while the pick came from the one-limp donor, and the flop read hero's A4s iso at
    // a node the chart folds it at — zero weight after following the pick). The seats folded out ride along.
    const heroCodes = borrowed ? borrowed.line.split("-").filter(Boolean) : walk.tokens;
    const foldedSeats = [...new Set([...sticky, ...walk.folds.map((f) => f.seat), ...(borrowed ? [borrowed.dropped] : [])])];
    const picks = cell ? [{ rawTokens: tokens, codes: heroCodes, heroClass,
      mix: heroNode.actions.map((x) => ({ action: x.action, token: x.token, frequency: actions.find((a) => a.action === x.action)?.frequency ?? 0 })) }] : [];
    setPreflopPin({ piece: "chart6max", handKey: pinKey, chartId: resolved.id, codes: heroCodes, rawTokens: tokens,
      heroPos: heroSeatPos || nodePos, depth: choice.depth, actionIndex: hand.actions.length, at: Date.now(), picks,
      ...(foldedSeats.length ? { foldedSeats } : {}) });
  }

  const notes = [
    // a kept chart is not the picker's pick: its note about the tree it chose (the pool-locked one) does not apply
    retry.keepChart ? (choice.note ?? "").split(" · ").filter((n) => n && !/pool-locked/.test(n)).join(" · ") || null : choice.note,
    prunedPicksNote(prunedPick.dropped),
    resolved.fellBack ? `no ${choice.id} tree in the set — answered from ${resolved.id}` : null,
    sticky.length
      ? `LINE KEPT AS THE HAND WAS READ: ${sticky.join(", ")}'s call ${sticky.length === 1 ? "was" : "were"} folded out at hero's earlier decision, so ${sticky.length === 1 ? "it is" : "they are"} folded out here too`
      : null,
    // A snap past τ is an APPROXIMATION we chose to make rather than leave the
    // spot unanswered (2026-09-21) — it must never read like an exact answer.
    farSnapNote(walk.repaired.filter((r) => !r.borrowed))
      ?? (walk.repaired.some((r) => !r.borrowed) ? `${walk.repaired.filter((r) => !r.borrowed).length} action(s) snapped to the tree's sizes` : null),
    walk.folds.length
      ? `LINE FITTED TO THE TREE: the chart holds at most two limpers, two callers and four players in the pot, so ` +
        walk.folds.map((f) => `${f.seat}'s ${f.dropped.length ? "call (and later actions)" : "call"}`).join(", ") +
        ` ${walk.folds.length === 1 ? "is" : "are"} folded out of the line — ${walk.folds.length} player${walk.folds.length === 1 ? "" : "s"} fewer and a smaller pot, so hero reads a little tight`
      : null,
    borrowed
      ? `CALLER CAP: this tree has no call for ${heroNode.pos} after ${countCallsBefore(walk.tokens)} callers, ` +
        `so the decision is read at "${borrowed.line}" with ${borrowed.dropped}'s call folded — one caller ` +
        `fewer and a smaller pot, so it calls slightly too tight`
      : null,
  ].filter(Boolean) as string[];

  return {
    ok: true,
    source: "hrc-6max-preflop",
    tier: "chart-6max",
    street: "preflop",
    setId: "6max-ign200",
    gametype: resolved.id,
    depth: choice.depth,
    line: line || "(root)",
    pos: heroNode.pos,
    heroClass,
    decision,
    actions,
    chartActions: actions,
    chartDecision: decision ?? undefined,
    strategyMode: "chart",
    notInRange: (heroClass != null && !cell) || undefined,
    // "≈" ONLY WHEN SOMETHING WAS APPROXIMATED (PF-09, 2026-09-23). This was `approx: true` unconditionally, so
    // all 315 chart answers in answers.sqlite carried the marker — 192 of them with nothing to say about it — and
    // a snapped/fitted/borrowed answer was indistinguishable from an exact node read. Every approximation this
    // piece makes writes a note or leaves a trace on the walk; flag exactly those.
    approx: notes.length > 0 || walk.repaired.length > 0 || walk.folds.length > 0 || !!borrowed || resolved.fellBack || undefined,
    warning: notes.join(" · "),
  };
}

/**
 * Pre-touch the 6-max tree a hand will need, as soon as its stacks are known (the poller's
 * ingest tick fires every second from the deal), so hero's turn never pays the chart
 * server's cold open. Measured 2026-09-19: a tree's first open on :8777 is 4-10 s, warm
 * it is 2-120 ms; 8 of 22 chart answers that night took 2.4-7.6 s for exactly this
 * reason. One touch per hand; the server keeps the last few trees resident.
 */
const warmedHands = new Map<string, number>();
/**
 * THE STREET IS SOLVED WHEN ITS CARD LANDS, NOT WHEN HERO IS ASKED (2026-09-19). Every postflop street is a
 * fresh cloud tree (services/aiChain.ts): 1.7 s p50 to create, 3-7 s with the observed size pinned, 9-24 s on
 * a slow evening (session 220727 hand 4, the "answer only came after the time bank" report). Kicked from the
 * poller's tick the moment a street opens with no action on it yet, so by hero's turn the street's tree and its
 * root are cached: hero first to act or facing a check = a node read; facing a bet leaves only the pinned-size
 * tree to solve. A warm that ends on villain's turn is expected (hero in position) and leaves no trace row;
 * a warm that reaches hero's node is a real solve, shared with the poller's through gtowApi's pending maps.
 */
const warmedStreets = new Map<string, number>();
export function warmPostflop6max(hand: ParsedHand, heroPos: string | null, strategyId?: string | null): void {
  const hu = strategyId === CP_HU_STRATEGY;
  if (strategyId !== SIX_MAX_STRATEGY && !hu) return;
  const street = hand.currentNode.street;
  if (street !== "flop" && street !== "turn" && street !== "river") return;
  if (hand.ended || hand.actions.some((a) => a.hero && a.type === "fold")) return;
  if (hand.actions.some((a) => a.street === street)) return;   // the street is under way: the real solve owns it
  // THE COINPOKER HU STRATEGY WARMS TOO (2026-09-24), but only when hero acts FIRST on the street — heads-up that
  // is the big blind, on every street. Then the warm IS hero's answer: his root node is read the moment the card
  // lands and the poller's solve joins it (gtowApi's pending maps). In position the warm would open an AUTOMATIC
  // tree that villain's bet throws away (the observed size has to be pinned into a new tree), spending a cloud
  // solve and the account's daily requests on nothing.
  if (hu && String(hand.positions[hand.heroSeatId] ?? heroPos ?? "").toUpperCase() !== "BB") return;
  // every table size warms (2026-09-19): 2-3 handed flops condition on the AI preflop tree's ranges
  const id = hand.clientHandId ?? hand.handId;
  if (id == null) return;
  const key = `${id}:${street}`;
  if (warmedStreets.has(key)) return;
  warmedStreets.set(key, Date.now());
  if (warmedStreets.size > 60) { const first = warmedStreets.keys().next().value; if (first !== undefined) warmedStreets.delete(first); }
  const t0 = Date.now();
  const solve = hu ? solvePostflopHuStrategy : solvePostflop6maxStrategy;
  const tag = hu ? "[warmhu]" : "[warm6max]";
  void solve(hand, heroPos, { origin: "warm", strategyId }).then((r) => {
    console.log(`${tag} ${key}: ${r.ok ? "hero's root node answered" : "street tree opened"} in ${Date.now() - t0} ms${r.ok ? "" : ` (${r.reason.slice(0, 100)})`}`);
  }).catch(() => { /* a warm-up never fails anything */ });
}

export function warmPreflop6max(hand: ParsedHand, heroPos: string | null, strategyId?: string | null): void {
  if (hand.currentNode.street !== "preflop") return;
  if (strategyId === CP_HU_STRATEGY) { warmPreflopHu(hand, heroPos ?? hand.positions[hand.heroSeatId] ?? null); return; }
  if (strategyId !== SIX_MAX_STRATEGY) return;
  // a dead small blind wearing live-blind labels (see fastSolve): warm the tree the answer will actually use
  const deadSb = repairDeadSmallBlind(hand);
  if (deadSb.note) { hand = deadSb.hand; heroPos = hand.positions[hand.heroSeatId] ?? heroPos; }
  if (!is6Handed(hand, heroPos)) { warmPreflopGtowAi(hand, heroPos); return; }   // 2-5 seats: the AI piece will answer
  const key = String(hand.clientHandId ?? hand.handId ?? "");
  if (!key || warmedHands.has(key)) return;
  warmedHands.set(key, Date.now());
  if (warmedHands.size > 50) { const first = warmedHands.keys().next().value; if (first !== undefined) warmedHands.delete(first); }
  const t0 = Date.now();
  try {
    const choice = chartFor6max(hand, heroPos, buildPreflopTokens(hand, heroPos));
    void resolveChart6max(choice).then((r) => {
      const ms = Date.now() - t0;
      if (ms > 400) console.log(`[warm6max] hand ${key}: ${r && r !== "unreachable" ? r.id : "no tree"} opened in ${ms} ms`);
    }).catch(() => { /* a warm-up never fails anything */ });
  } catch { /* ditto */ }
}

/**
 * THE HEADS-UP CHART IS OPENED WHEN THE HAND IS DEALT (2026-09-24). In CoinPoker session 20260924_135250, 7 of 33
 * preflop answers took 1.7-5.7 s and the other 26 took 17-65 ms. All 7 were the FIRST hand at a new depth rung
 * (the 66 facing a raise waited 5.65 s for hrc_hu_cp200a_d110). Heads-up the effective stack drifts a rung every
 * few hands, and the chart server pulled each rung's body from R2 at hero's turn (exploit_ui/server.py
 * SMALL_BODY_BYTES explains why those bodies kept leaving its disk). So every tick now opens this hand's chart
 * plus the default chart of the rungs on either side, and the next drift lands on a warm tree. In the SB hero acts
 * first, so this hand's own chart gets no head start. The neighbouring rungs are what cover that case.
 */
const warmedHuCharts = new Map<string, number>();
const HU_WARM_TTL_MS = 5 * 60_000;
function warmPreflopHu(hand: ParsedHand, heroPos: string | null): void {
  if (!isHeadsUp(hand)) return;
  const choice = chartForHu(hand, buildPreflopTokensHu(hand, heroPos));
  const now = Date.now();
  for (const id of [choice.id, ...neighbourRungsHu(choice.depth).map(defaultChartHu)]) {
    if (now - (warmedHuCharts.get(id) ?? 0) < HU_WARM_TTL_MS) continue;
    warmedHuCharts.delete(id);
    warmedHuCharts.set(id, now);
    if (warmedHuCharts.size > 100) { const first = warmedHuCharts.keys().next().value; if (first !== undefined) warmedHuCharts.delete(first); }
    const t0 = Date.now();
    void fetchNode(id, "").then((r) => {
      const ms = Date.now() - t0;
      if (ms > 400) console.log(`[warmhu] ${id}: ${r === "unreachable" ? "chart server unreachable" : r ? "opened" : "no such chart"} in ${ms} ms`);
    }).catch(() => { /* a warm-up never fails anything */ });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// CAPTURES NO PIECE MAY ANSWER (2026-09-23). Three classes of hand reached the pieces and were answered anyway:
//
//   EH-9   hero's cards unknown. The wrapper exported hands for a villain sitting in hero's old seat (multi-table
//          socket mixing, answers.sqlite client_hand_ids 4919049163/289/350/438 with hero_cards NULL) and the API
//          probed every one — there is no hand class to read, so nothing was ever solvable.
//   EIP-01 a board that is not a street. A missed CO_BCARD3_INFO frame followed by a turn/river card left the
//          wrapper's board with one card, which it exported as street "preflop" — and 7 live decisions (answers
//          2323/2324/2358/2359/2366/2367/3384, hand 4919648596 on the RIVER) were served from a PREFLOP chart
//          node. CONTRACT §1a promises 0/3/4/5 entries; hold the line here for every strategy.
//   PF-01  the capture contradicts itself. captureFaults ran only inside the 6-max chart piece and the HU piece,
//          and its refusal was not terminal: fastSolveInner folded the reason into `why` and handed the SAME hand
//          to solvePreflopGtowAi and then solvePreflopLastResort, neither of which checks. The last resort's
//          heads-up reduction turns a phantom-check line into a clean-looking HU tree (hand 4919432731: "BTN
//          checked preflop" -> "hero CO vs HJ, dead 2.4bb"), so the session-start corruption class got a confident
//          answer and burned ~40-56 GTO Wizard requests per corrupt hand (hands.db 557, 583). PF-02: 2-5 seat
//          tables never ran the check at all.
// ---------------------------------------------------------------------------------------------------------------

/** How many board cards each decision street has. Showdown is not a decision and has no entry. */
const BOARD_CARDS: Partial<Record<string, number>> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/**
 * captureFaults for a PREFLOP decision at a table the 6-max strategy plays. One exemption: a table thinned to two
 * seats keeps its dealer labelled BTN, and heads-up the dealer POSTS THE SMALL BLIND — the AI piece already knows
 * the alias (gtowAiPreflop.shapeOf "heads-up: the dealer is the small blind"), so "BTN posted the small blind" is
 * the table's normal shape there, not a corrupt capture. Every other fault stands.
 */
export function preflopCaptureFaults(hand: ParsedHand): string[] {
  const faults = captureFaults(hand);
  if (!faults.length) return faults;
  const labels = new Set(Object.values(hand.positions ?? {}).map((p) => p.toUpperCase()));
  const huDealer = labels.size === 2 && labels.has("BTN") && labels.has("BB");
  return huDealer ? faults.filter((f) => f !== "BTN posted the small blind") : faults;
}

/**
 * The gates every strategy shares, checked before any piece sees the hand: a decision with no hero cards or a
 * board that is not a street is never solvable, so it is refused with a named `kind` instead of being probed.
 * Returns the refusal, or null when the hand may go on to a piece.
 */
export function unsolvableCapture(hand: ParsedHand): FastSolveResult | null {
  const street = hand.currentNode.street;
  // EH-9 — hero's cards
  const known = (hand.heroCards ?? []).filter((c) => /^[2-9TJQKA][shdc]$/i.test(c));
  if (known.length < 2) {
    return { ok: false, kind: "no-hero-cards", street, reason: "hero's cards are not known — nothing to solve" };
  }
  // EIP-01 — the board must be a street, and the street the decision is on
  const board = hand.board ?? [];
  const shown = board.length ? board.join(" ") : "(empty)";
  const n = board.length;
  if (!(n in { 0: 1, 3: 1, 4: 1, 5: 1 })) {
    return { ok: false, kind: "board-incomplete", street,
      reason: `the board ${shown} has ${n} card${n === 1 ? "" : "s"} on the ${street} — no street deals ${n}, so a street frame was missed and this decision has no node to solve` };
  }
  for (const [label, s] of [["the decision's street", street], ["the hand's street", hand.street]] as const) {
    const want = BOARD_CARDS[s];
    if (want != null && want !== n) {
      return { ok: false, kind: "board-incomplete", street,
        reason: `the board ${shown} has ${n} card${n === 1 ? "" : "s"} but ${label} is ${s} (${want} expected) — a street frame was missed, so this decision has no node to solve` };
    }
  }
  // A CARD DEALT TWICE (2026-09-24, stress multi-07). Hero's Th with Th on the board reached the AI chain and came
  // back as a mix of ALL ZEROS — the solver's card removal puts every board-blocked combo at weight 0, so hero's
  // node had no strategy to read, and the answer was ok:true with no decision. The same read error in a live
  // capture (a card frame misread, a stale board) would look the same. Two of one card is not a spot: refuse it
  // as the capture fault it is, before any piece spends a solve on it.
  const heroShort = known.map(SHORT_C), boardShort = board.map(SHORT_C);
  const dup = duplicateCard([...heroShort, ...boardShort]);
  if (dup) {
    const where = heroShort.includes(dup) && boardShort.includes(dup)
      ? `hero holds ${dup} and ${dup} is on the board ${shown}`
      : heroShort.includes(dup) ? `hero holds ${dup} twice` : `${dup} appears twice on the board ${shown}`;
    return { ok: false, kind: "capture-fault", street,
      reason: `the capture of this hand is internally inconsistent, so there is no spot to solve — ${where}; a card was misread, and no node holds a hand that shares a card with the board` };
  }
  return null;
}

/** The first card that appears twice in the list (cards already in Rs form), else null. */
function duplicateCard(cards: string[]): string | null {
  const seen = new Set<string>();
  for (const c of cards) {
    if (seen.has(c)) return c;
    seen.add(c);
  }
  return null;
}

/**
 * WHY A POSTFLOP MIX CAME BACK ALL ZEROS (2026-09-24). The AI chain floors hero's own hand class in his entering
 * range on every street it walks (aiChain: "keep hero's actual combo alive"), so a zero strategy at hero's node is
 * never "the equilibrium never gets here" — it is a hand that cannot exist at the node, or a node that is not
 * hero's. Name the one that fits, most specific first:
 *   - a hero card on the board (card removal zeroes the combo; the capture gate refuses this upstream, kept here
 *     so a hand that reaches the chain another way still says why)
 *   - the node GTO Wizard returned belongs to another seat (the strategy read is someone else's)
 *   - hero's class has no weight in the arrival range the walk started from (the floor covers only the street's
 *     entering range, so a class the collapse or the earlier streets drove to zero says so here)
 *   - nothing recognisable: report the raw facts so the walk's trace can be read
 * Exported for its tests; pure.
 */
export function zeroMixReason(a: {
  heroCards: string[]; board: string[]; heroPos: string; nodePos: string | null;
  heroClass: string | null; arrivalWeight: number | null; plan: string | null; actions: string[];
  /** heads-up: the dealer is the table's BTN and the tree's SB — one seat under two names, not a mismatch */
  hu?: boolean;
}): string {
  const cards = a.heroCards.map(SHORT_C), board = a.board.map(SHORT_C);
  const onBoard = cards.filter((c) => board.includes(c));
  const head = `hero's ${cards.join("")} has every action at 0%${a.actions.length ? ` over ${a.actions.join("/")}` : ""}${a.plan ? ` (${a.plan})` : ""}`;
  if (onBoard.length) {
    return `${head}: ${onBoard.join(" and ")} is on the board ${board.join(" ")}, so card removal gives the combo no ` +
      `weight — a card was misread; the capture is internally inconsistent`;
  }
  const seat = (p: string) => { const u = p.toUpperCase(); return a.hu && (u === "BTN" || u === "SB") ? "BTN~SB" : u; };
  if (a.nodePos && seat(a.nodePos) !== seat(a.heroPos)) {
    return `${head}: the node read is ${a.nodePos}'s, not hero's (${a.heroPos}) — the strategy belongs to another seat`;
  }
  if (a.arrivalWeight != null && a.arrivalWeight <= 0) {
    return `${head}: ${a.heroClass ?? "the class"} carries no weight in ${a.heroPos}'s arrival range, so the solve never ` +
      `dealt it — not in range at this node`;
  }
  return `${head} although the class is floored in ${a.heroPos}'s entering range` +
    `${a.arrivalWeight != null ? ` (arrival weight ${a.arrivalWeight})` : ""} — the node's strategy for the combo is ` +
    `empty; read the walk's trace before trusting this tree`;
}

export async function fastSolve(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts = {}): Promise<FastSolveResult> {
  // POSTED-IN PLAYERS (2026-09-25, Brady: "treat them as a normal player"). normalizeHand already folded each post
  // into the poster's own action (utils/foldPostIns — an option-check reads as a limp), so every piece below sees an
  // ordinary hand; the answer only has to SAY it is an approximation, and hero must never fold a free check.
  if (hand.postIns?.length) {
    const r = await fastSolveOuter(hand, heroPos, opts);
    return r.ok ? postInAnswer(hand, r) : r;
  }
  return fastSolveOuter(hand, heroPos, opts);
}

/** The approximation note on a post-in hand's answer, and HERO'S OWN post: facing nothing but his own blind, the
 *  chart's node (a normal player facing 1bb) may say fold — a free check never folds. */
function postInAnswer(hand: ParsedHand, r: Extract<FastSolveResult, { ok: true }>): FastSolveResult {
  const note = postInNote(hand.postIns, hand.positions);
  const heroPosted = hand.postIns!.some((p) => p.seatId === hand.heroSeatId && p.readAs === "pending");
  const free = hand.currentNode.street === "preflop" && hand.currentNode.toActIsHero && !(hand.currentNode.toCall > 0);
  let out: FastSolveResult = { ...r, approx: true, warning: `${note}${r.warning ? ` ${r.warning}` : ""}` };
  const pick = (r as any).decision?.action as string | undefined;
  if (heroPosted && free && pick && /^fold$/i.test(pick)) {
    out = { ...out, decision: { ...(r as any).decision, action: "Check" },
      warning: `${out.warning} · you posted in and nobody raised: the chart's Fold is a free CHECK here` } as FastSolveResult;
  }
  return out;
}

async function fastSolveOuter(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts = {}): Promise<FastSolveResult> {
  // A DEAD SMALL BLIND CAPTURED WITH LIVE-BLIND LABELS (2026-09-23, hand 732). The wrapper used to name seats
  // from the button alone, so when the SB seat emptied between hands the BB poster was labelled SB and both
  // preflop pieces refused ("SB posted the big blind" / "the walked line puts SB on the clock"). The names shift
  // by one seat and nothing else is wrong, so relabel from the post (utils/repairPostflopRotation) before any
  // piece reads the hand — recorded hands replay, and a stale wrapper still gets an answer. The answer says so.
  const deadSb = repairDeadSmallBlind(hand);
  if (deadSb.note) {
    const fixedHeroPos = deadSb.hand.positions[hand.heroSeatId] ?? heroPos;
    const r = await fastSolveInner(deadSb.hand, fixedHeroPos, opts);
    if (r.ok) return { ...r, approx: true, warning: `${deadSb.note}${r.warning ? ` ${r.warning}` : ""}` };
    return { ...r, reason: `${r.reason} (after the relabel: ${deadSb.note})` };
  }
  return fastSolveInner(hand, heroPos, opts);
}

async function fastSolveInner(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts = {}): Promise<FastSolveResult> {
  // THE 6-MAX RING STRATEGY IS OUR OWN SOLVE END TO END (2026-09-17, Brady). Preflop from the 6-max charts,
  // postflop from the AI chain conditioned on those charts' ranges; a spot neither can answer is a miss, never a
  // GTO Wizard library answer - that library is a different game (NL500, a third of the rake, no limps).
  const sixStrategy = !opts.setId && opts.strategyId === SIX_MAX_STRATEGY;
  // THE COINPOKER HU STRATEGY IS OUR OWN SOLVE END TO END TOO (2026-09-22): cp200a charts preflop, the AI chain
  // postflop conditioned on them at CoinPoker's rake and antes. No GTO Wizard library behind it.
  const huStrategy = !opts.setId && opts.strategyId === CP_HU_STRATEGY;
  // NOTHING BELOW MAY SEE AN UNSOLVABLE CAPTURE (EH-9, EIP-01 — see the block above). Every strategy: no hero
  // cards and a board that is not a street are never a spot, whichever piece would have answered.
  const unsolvable = unsolvableCapture(hand);
  if (unsolvable) return unsolvable;
  // A CAPTURE THAT CONTRADICTS ITSELF IS REFUSED HERE, ONCE, FOR EVERY TABLE SHAPE, AND THAT IS FINAL (PF-01 /
  // PF-02, 2026-09-23). Preflop only: postflop the 6-max piece repairs the rotation first (misplaced checks) and
  // runs captureFaults on the repaired hand, and that refusal is already terminal. Preflop the hand was repaired
  // for a dead small blind before it got here (fastSolve), so what is left is real corruption — hands.db 557 and
  // 583 each cost ~40-56 GTO Wizard requests answering it. The CoinPoker HU piece keeps its own gate below.
  if (sixStrategy && hand.currentNode.street === "preflop") {
    // FOLDS FILED LATE ARE MOVED, NOT FAULTED (2026-09-23, hand 4919958787 / dbId 734): the DOM backfill records a
    // missed fold after the seats that acted next, which every token builder turns into a phantom action. A fold
    // commits nothing, so it goes back into its slot before the faults are read; the answer says so.
    const folds = repairPreflopFoldOrder(hand);
    if (folds.note) {
      // the repaired line is already in rotation, so the recursion finds nothing more to move and falls through
      const r = await fastSolveInner(folds.hand, heroPos, opts);
      if (r.ok) return { ...r, approx: true, warning: `${folds.note}${r.warning ? ` ${r.warning}` : ""}` };
      return r;
    }
    const faults = preflopCaptureFaults(hand);
    if (faults.length) {
      return { ok: false, kind: "capture-fault", street: "preflop", gametype: "6max-ign200", depth: 0,
        reason: `the capture of this hand is internally inconsistent — ${faults.join("; ")}` };
    }
  }
  if (huStrategy) {
    return hand.currentNode.street === "preflop" ? solvePreflopHu(hand, heroPos) : solvePostflopHuStrategy(hand, heroPos, opts);
  }
  if (hand.currentNode.street !== "preflop") {
    // EVERY table size (2026-09-19): the 6-max strategy's postflop is the AI chain conditioned on the ranges
    // of whichever of ITS OWN preflop pieces answered (the 6-max charts, or the GTO Wizard AI preflop tree for
    // the shapes the charts do not cover) — never the 3-max corpus or the library behind a different game.
    if (sixStrategy) return solvePostflop6maxStrategy(hand, heroPos, opts);
    return solvePostflopWithMes(hand, heroPos, opts);
  }
  if (sixStrategy) {
    // THE FALLBACK PIECE (2026-09-19, Brady): the charts answer first; whatever they cannot — a table thinned to
    // 2-5 seats, an off-tree size, a stack past the ladder, a limped pot, a straddle — goes to GTO Wizard AI
    // preflop (Ultra), built from the actual table (services/gtowAiPreflop.ts). Never the GTO Wizard LIBRARY:
    // that is a different game (NL500, a third of the rake, no limps).
    let why: string;
    if (is6Handed(hand, heroPos)) {
      const six = await solvePreflop6max(hand, heroPos, opts.origin, opts.strategyId);
      if (six && six.ok) return six;
      why = six && !six.ok ? six.reason : "6-max charts unreachable (chart server :8777 down or the state's tree missing)";
    } else {
      // THE 3-MAX CORPUS IS CUT FROM THIS STRATEGY (Brady, 2026-09-19). It was wired in earlier the same day
      // and is wired out again after the convergence audit: the re-solved deep rungs are sound (the 100bb
      // v2ci chart measures 0.018 bb/hand exploitability) but the eleven rungs at 70bb and below are still
      // the ORIGINAL generation, which measures 0.13-0.37 bb/hand — ten to thirty times any 6-max chart, and
      // the same generation that failed the pool backtest. Rather than serve a corpus whose quality depends
      // on which rung a hand snaps to, a thinned table now gets a tree built from the table itself.
      // REVERSIBLE: restore this branch and the matching one in solvePostflopViaChain.
      // Other strategies (the Zone 3-handed ones) still use the 3-max charts — only this branch changed.
      const seats = Object.keys(hand.positions).length + (hand.positions[hand.heroSeatId] ? 0 : 1);
      const labels = new Set(Object.values(hand.positions).map((p) => p.toUpperCase()));
      why = !labels.has("SB") && labels.has("BB") && seats >= 3
        // a dead small blind (2026-09-23): the seat count may be chart-sized, but no chart has a hand without an SB
        ? `dealt with no small blind (the SB seat emptied between hands) — every 6-max chart has a live SB, so the tree is built from the table`
        : `table thinned to ${seats} seats — the 6-max charts cover 4-6, and the 3-max corpus is cut from this strategy pending a re-solve of its shallow rungs`;
    }
    const ai = await solvePreflopGtowAi(hand, heroPos, why);
    const asResult = (r: Extract<AiPreflopOutcome, { ok: true }>, approx: boolean): FastSolveResult => ({
      ok: true, source: GTOW_AI_PREFLOP_SOURCE, tier: GTOW_AI_PREFLOP_TIER, street: "preflop",
      setId: "gtow-ai-preflop", gametype: `gtow-ai · ${r.shape.n}-handed · ${r.shape.positions.map((p) => `${p}:${r.shape.stacks[p]}`).join("/")}`,
      depth: Math.round(Math.min(...r.shape.positions.map((p) => r.shape.stacks[p] ?? 100))),
      line: r.line, pos: r.pos, heroClass: r.heroClass, actions: r.actions, decision: r.decision,
      warning: r.note, approx: approx || undefined,
    });
    if (ai.ok) return asResult(ai, ai.shape.deadSb);
    // THE AI PIECE CAN ALSO NAME A CAPTURE FAULT (2026-09-23): a 400 VALIDATION_ERROR from GTO Wizard on the built
    // shape means the table as captured is not a table, and the last resort would only rebuild the same
    // impossible hand heads-up. Terminal, like the gate at the entry.
    if ((ai as { kind?: string }).kind === "capture-fault") {
      return { ok: false, kind: "capture-fault", street: "preflop", gametype: "6max-ign200", depth: 0, line: ai.line ?? "",
        reason: `${why}; ${ai.reason}` };
    }
    // THE LAST RESORT (2026-09-23): neither piece can walk the line — play it as hero versus the last aggressor
    // with everyone else's chips as dead money (services/gtowAiPreflop.solvePreflopLastResort). Always an answer
    // while GTO Wizard is up; always flagged.
    const last = await solvePreflopLastResort(hand, heroPos, `${why}; ${ai.reason}`);
    if (last.ok) return asResult(last, true);
    return { ok: false, street: "preflop", gametype: "6max-ign200", depth: 0, line: ai.line ?? "",
      reason: `${why}; ${ai.reason}; ${last.reason}` };
  }

  // 3-handed preflop answers from the asym HRC charts (unless the caller
  // pinned a set explicitly). A dead chart server falls back to the 6-max
  // walk — wrong tree, but an approximate answer beats none — flagged loudly.
  if (!opts.setId && is3Handed(hand, heroPos)) {
    const tri = await solvePreflop3max(hand, heroPos, opts.strategy, opts.origin, opts.strategyId);
    if (tri) return tri;
    const net = solvePreflop(hand, heroPos, opts);
    if (net.ok) {
      net.approx = true;
      net.warning =
        "3-max chart server (:8777) unreachable — answered from the 6-MAX tree (wrong rake, no limps); treat as approximate.";
    } else {
      // don't let the fallback's own miss (e.g. "no 6-max chart @ 200bb")
      // masquerade as the root cause — the audit chased that ghost once
      net.reason = `3-max chart server (:8777) unreachable; 6-max fallback also failed: ${net.reason}`;
    }
    return net;
  }

  return solvePreflop(hand, heroPos, opts);
}
