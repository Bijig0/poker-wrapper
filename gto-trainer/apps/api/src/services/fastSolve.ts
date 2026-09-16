import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { buildPreflopTokens, buildPreflopTokensHu, buildPreflopTokens3max, buildSpotSolutionTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { chartFor, fetchNode, walk3max } from "./hrc3max";
import { chartFor6max, resolveChart6max, nodeGetter } from "./hrc6max";
import { preflopArrivalFor } from "./strategies";
import { missQueue } from "./missQueue";
import { preflopDb } from "./preflopDb";
import { gtowApi } from "./gtowApi";
import { SOLUTION_SETS } from "./gtowCdp";
import { parseHandClass } from "../utils/parseHandClass/parseHandClass";
import { comboIndex } from "../utils/comboIndex/comboIndex";
import { solveStore } from "./solveStore";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";
import { snapPreflopLine } from "../utils/snapPreflopLine/snapPreflopLine";
import { SNAP_TAU } from "../utils/snapToken/snapToken";
import { reconstructFlopRanges, classWeightsToSpec } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";
import { deriveExploitSpot } from "../utils/deriveExploitSpot/deriveExploitSpot";
import { solveAiChain } from "./aiChain";
import { HU_SEATS, preflopClosed, preflopPotStack } from "../utils/aiStudyLine/aiStudyLine";
import { mesPostflopLookup, mesRiverContext } from "./mesPostflop";
import { mesRiverLookup } from "./mesRiver";

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
      source: "local-preflop" | "hrc-3max-preflop" | "hrc-6max-preflop" | "pool-exploit-preflop" | "gtow-api-postflop" | "mes-postflop";
      /** which cascade layer answered. */
      tier?: "library-exact" | "library-snap" | "far-snap" | "ai-exact" | "ai-chain" | "chart-3max" | "chart-6max" | "exploit-3max" | "exploit-postflop";
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
      /** Preflop only: the equilibrium chart's own mix, kept for the Sources
       *  comparison (MES-vs-GTO is a question about the pieces, not about the
       *  action) — the table surfaces never read it. */
      chartActions?: ActionFreq[];
      decision: WeightedPick | null;
      notInRange?: boolean;
      approx?: boolean;
      warning?: string | null;
    }
  | {
      ok: false; reason: string; street?: string;
      /** For chart misses: which chart, and how far the walk got — logged
       *  with the failure so the miss queue and the answer trail agree. */
      gametype?: string; depth?: number; line?: string;
    };

/** Depth: explicit > min live stack snapped to a library depth. */
export const resolveDepth = (hand: ParsedHand, depths: number[], explicit?: number): number => {
  if (explicit) return explicit;
  const stacks = hand.stacks ?? {};
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
    warning: useExploit
      ? `pool best response (${exAction!.tag}, derived @100bb${chart.depth !== 100 ? `, state ${chart.depth}bb` : ""})`
      : chart.note,
  };
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
  tk: { preflop: string[]; flop: string[]; turn: string[]; river: string[]; board: string }
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
  tk: { preflop: string[]; flop: string[]; turn: string[]; river: string[]; board: string },
  origin?: string,
  sessionId?: string | null,
  /** the 6-max ring strategy: both seats' flop-entering ranges come from OUR 6-max chart, never the library */
  sixMax = false
): Promise<{ res: FastSolveResult | null; why: string | null }> {
  const fail = (why: string) => ({ res: null, why });
  let sixNote: string | null = null;
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
    villainSeat = vol.length ? vol[vol.length - 1]!.seatId : null;
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
  if (is3Handed(hand, heroPos)) {
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
        const exRange = exploitFlopRange(tri3, heroPosName);
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
  if (!recon && sixMax) {
    const six = await recon6max(hand, heroPos, heroPosName);
    if (!six.ok) return fail(six.reason);
    recon = six.recon;
    preTokens = six.tokens;
    seatOrder = undefined;
    rangeSource = six.id;
    sixNote = six.note;
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
  // HU trees seat the dealer as SB; the vision layer may label him BTN.
  const posName = (p: string) => (isHu && p.toUpperCase() === "BTN" ? "SB" : p);
  const oopPos = posName(spot.oopPos);
  const ipPos = posName(spot.ipPos);
  const byPos = (pos: string) => Object.entries(recon.ranges).find(([p]) => p.toUpperCase() === pos.toUpperCase())?.[1];
  const oopW = byPos(oopPos);
  const ipW = byPos(ipPos);
  if (!oopW || !ipW) return fail("reconstructed ranges don't cover both seats");
  const { pot: flopPot, stack: flopStack } = preflopPotStack(preTokens, depth, seatOrder);
  if (flopStack <= 0.5) return fail("preflop line is (near) all-in");

  const heroCards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/i.test(c)).map(SHORT_C);
  const heroComboIdx = heroCards.length === 2 ? comboIndex(heroCards[0]!, heroCards[1]!) : null;
  const streets = cur === "flop" ? [tk.flop] : cur === "turn" ? [tk.flop, tk.turn] : [tk.flop, tk.turn, tk.river];

  const t0 = Date.now();
  const chain = await solveAiChain({
    oopPos,
    ipPos,
    oopRange: buildRangeArray(classWeightsToSpec(oopW)),
    ipRange: buildRangeArray(classWeightsToSpec(ipW)),
    flopPot,
    flopStack,
    board: tk.board,
    streets,
    heroSeat: spot.heroSeat,
    heroComboIdx,
    rangeSource: rangeSource ?? undefined,
  });
  // Every chain walk is kept — inputs, every node, the verdict — so the
  // answer can be inspected later exactly as it was, and diffed against a
  // re-solve (services/solveStore.ts).
  const solveMeta = {
    origin: origin ?? "adhoc",
    sessionId: sessionId ?? hand.sessionId ?? null,
    clientHandId: hand.clientHandId ?? null,
    wrapperHandId: hand.handId ?? null,
    decisionKey: JSON.stringify([hand.street, hand.board, hand.heroCards, hand.currentNode.toCall, hand.actions.length]),
    street: cur, board: tk.board, heroCards: heroCards.join("") || null, heroPos: heroPosName,
    tier: "ai-chain", solveMs: Date.now() - t0,
  };
  if (!chain.ok) {
    if (chain.trace) solveStore.save({ ...solveMeta, line: null, solves: null, ok: false, why: chain.why }, chain.trace);
    return fail(chain.why);
  }
  const solveId = solveStore.save({ ...solveMeta, line: `${preTokens.join("-")} / ${chain.line}`, solves: chain.solves, ok: true, why: null }, chain.trace);

  const j = chain.data;
  let actions: ActionFreq[];
  let notInRange = false;
  if (heroComboIdx != null) {
    actions = (j.action_solutions ?? []).map((a: any) => ({
      action: labelOf(a), frequency: (a.strategy?.[heroComboIdx] ?? 0) * 100, ev: a.evs?.[heroComboIdx], betsize: a.action.betsize,
    }));
    notInRange = actions.every((a) => a.frequency <= 0);
  } else {
    actions = (j.action_solutions ?? []).map((a: any) => ({
      action: labelOf(a), frequency: (a.total_frequency ?? 0) * 100, ev: a.total_ev, betsize: a.action.betsize,
    }));
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
    line: `${preTokens.join("-")} / ${chain.line}`,
    pos: j.action_solutions?.[0]?.action?.position ?? null,
    heroClass: heroClassOf(hand),
    actions,
    decision: notInRange ? null : pickWeightedAction(actions),
    notInRange: notInRange || undefined,
    approx: true,
    warning: sixNote,
  } };
}

/** The 6-max ring strategy's id (services/strategies.ts) - the one strategy whose every layer is our own solve. */
const SIX_MAX_STRATEGY = "ign200-ring-6max-equilibrium";

/**
 * Flop-entering ranges for every seat from the 6-max chart the preflop picker chooses for this hand: the same
 * chart, the same token walk (buildPreflopTokens pads a short table's early seats as folds), so what the postflop
 * solve starts from is exactly what the preflop answers said the seats arrive with.
 */
async function recon6max(hand: ParsedHand, heroPos: string | null, heroPosName: string | null): Promise<
  | { ok: true; recon: Awaited<ReturnType<typeof reconstructFlopRanges>>; id: string; tokens: string[]; note: string | null }
  | { ok: false; reason: string }
> {
  const tokens = buildPreflopTokens(hand, heroPos);
  if (!preflopClosed(tokens)) return { ok: false, reason: "preflop betting didn't close (missed action?)" };
  const choice = chartFor6max(hand, heroPos, tokens);
  const resolved = await resolveChart6max(choice);
  if (resolved === "unreachable") return { ok: false, reason: "6-max chart server (:8777) unreachable" };
  if (!resolved) return { ok: false, reason: `no 6-max chart for this state (${choice.id})` };
  const recon = await reconstructFlopRanges(tokens, async (line) => {
    const n = await fetchNode(resolved.id, line);
    return n === "unreachable" ? null : n;
  }, { heroPos: mergeHeroPos(heroPosName, false) });
  if (!recon.ok) return { ok: false, reason: `6-max chart ${resolved.id}: ${recon.reason}` };
  const note = [
    choice.note,
    resolved.fellBack ? `no ${choice.id} tree in the set — ranges from ${resolved.id}` : null,
  ].filter(Boolean).join(" · ");
  return { ok: true, recon, id: resolved.id, tokens, note: note || null };
}

/**
 * Postflop under the 6-max ring strategy: the per-street AI chain, conditioned on our 6-max chart's ranges, and
 * nothing behind it. A spot the chain cannot solve (multiway flop, unreadable line, dead chart server, AI down)
 * is a miss said out loud - the street-root and library tiers answer from a different game and are not offered.
 */
async function solvePostflop6maxStrategy(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts): Promise<FastSolveResult> {
  const street = hand.currentNode.street;
  const set = resolveSet(hand, heroPos, opts.setId);
  if (!set) return { ok: false, reason: `Unknown solution set: ${opts.setId}`, street };
  // the effective stack as it stands - the AI solve takes any stack, so no snapping to a library rung
  const stacks = Object.values(hand.stacks ?? {}).filter((x) => Number.isFinite(x) && x > 0);
  const heroStack = (hand.stacks ?? {})[hand.heroSeatId];
  const depth = Math.round(opts.depth ?? (heroStack != null && heroStack > 0 ? heroStack : stacks.length ? Math.min(...stacks) : 100));
  const tk = buildSpotSolutionTokens(hand, heroPos, false);
  const chain = await solvePostflopViaChain(hand, heroPos, set, depth, tk, opts.origin, opts.sessionId, true);
  if (chain.res) return chain.res;
  return { ok: false, reason: `6-max strategy postflop: ${chain.why} — no library fallback under this strategy`, street, gametype: "6max-ign200", depth };
}

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
async function solvePreflop6max(
  hand: ParsedHand,
  heroPos: string | null,
  origin?: string,
  strategyId?: string | null,
): Promise<FastSolveResult | null> {
  void origin; void strategyId;
  const tokens = buildPreflopTokens(hand, heroPos);
  const choice = chartFor6max(hand, heroPos, tokens);
  const resolved = await resolveChart6max(choice);
  if (resolved === "unreachable" || resolved === null) return null;

  const walk = await walk3max(tokens, nodeGetter(resolved.id));
  if (!walk.ok) {
    if (walk.unreachable) return null;
    return { ok: false, reason: `6-max chart ${resolved.id}: ${walk.reason}`, street: "preflop",
      gametype: resolved.id, depth: choice.depth, line: walk.missingAt ?? "" };
  }

  const line = walk.tokens.join("-");
  const heroClass = heroClassOf(hand);
  const cell = heroClass ? walk.node.cells.find((c) => c.hand === heroClass) : undefined;
  const actions = cell ? Object.entries(cell.actions).map(([action, frequency]) => ({ action, frequency })) : [];
  const decision = actions.length ? pickWeightedAction(actions) : null;

  const notes = [
    choice.note,
    resolved.fellBack ? `no ${choice.id} tree in the set — answered from ${resolved.id}` : null,
    walk.repaired.length ? `${walk.repaired.length} action(s) snapped to the tree's sizes` : null,
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
    pos: walk.node.pos,
    heroClass,
    decision,
    actions,
    chartActions: actions,
    chartDecision: decision ?? undefined,
    strategyMode: "chart",
    notInRange: (heroClass != null && !cell) || undefined,
    approx: true,
    warning: notes.join(" · "),
  };
}

export async function fastSolve(hand: ParsedHand, heroPos: string | null, opts: FastSolveOpts = {}): Promise<FastSolveResult> {
  // THE 6-MAX RING STRATEGY IS OUR OWN SOLVE END TO END (2026-09-17, Brady). Preflop from the 6-max charts,
  // postflop from the AI chain conditioned on those charts' ranges; a spot neither can answer is a miss, never a
  // GTO Wizard library answer - that library is a different game (NL500, a third of the rake, no limps).
  const sixStrategy = !opts.setId && opts.strategyId === SIX_MAX_STRATEGY;
  if (hand.currentNode.street !== "preflop") {
    if (sixStrategy && is6Handed(hand, heroPos)) return solvePostflop6maxStrategy(hand, heroPos, opts);
    return solvePostflopWithMes(hand, heroPos, opts);
  }
  if (sixStrategy && is6Handed(hand, heroPos)) {
    const six = await solvePreflop6max(hand, heroPos, opts.origin, opts.strategyId);
    if (six) return six;
    return { ok: false, street: "preflop", gametype: "6max-ign200", depth: 0, line: "",
      reason: "6-max charts unreachable (chart server :8777 down or the state's tree missing) — the 6-max strategy never answers from the GTO Wizard library" };
  }
  if (sixStrategy && !is3Handed(hand, heroPos)) {
    return { ok: false, street: "preflop", gametype: "6max-ign200", depth: 0, line: "",
      reason: "table shape outside the 6-max strategy (needs 4-6 seats with BTN, SB and BB; 3-handed plays the Zone charts)" };
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
