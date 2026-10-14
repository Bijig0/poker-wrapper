import { bbAmount, coldTreeMs, gtowApi, huMenuMode, hungHedgeOn, menuPotMode, postflopNodeTimeoutMs, threeWayMenuMode, type CarriedMenus, type CarriedSeat, type CustomTreeInput, type NodeSource, type PlayedWager } from "./gtowApi";
import { solveStore } from "./solveStore";
import { isDurableKey } from "./handFacts";
import { servedActionIndex, servedHeroStrategy, type ServedMix } from "./servedStrategy";
import { tmark, tspan } from "./answerTrace";
import { tstep, tstepDetail, USUAL } from "./liveSteps";
import {
  actionKindOf,
  matchActionIndex,
  matchActionLoose,
  wagerLabelForWalk,
} from "../utils/aiChainTokens/aiChainTokens";
import { labelBetBb } from "../utils/aiStudyLine/aiStudyLine";
import { wagerBb } from "../utils/streetFixedPcts/streetFixedPcts";
import { chipsAfter, contestedChips, effectiveStack } from "../utils/tableMoney/tableMoney";
import { handFacts, type StreetRecord } from "./handFacts";
import type { RangeCheck, StreetPath } from "./chainPath";
import {
  OFF_TREE_DUST, blendOffTreeRange, isOffTreePostflop, offTreeBlendW, offTreeLock, offTreeLockFallbackOn, offTreeLockOn, offTreeMaxHand, offTreeRangeMode, offTreeSoftT, offTreeStats, softOffTreeRange,
  type OffTreeLine, type OffTreeSoft,
} from "./offTree";

/** a solve POSTed for the hedge (gtowApi.hedgeSolution's reply) */
type HedgeMade = Awaited<ReturnType<typeof gtowApi.hedgeSolution>>;
/** one node read of the walk (readNode's reply), and one of the hedge's two reads (which solve it was on) */
type WalkRead = { r: Awaited<ReturnType<typeof gtowApi.customNode>>; src: NodeSource | "failed"; ms: number };
type HedgeRead = WalkRead & { made: HedgeMade | null };
/** the parent's node clock when a locked child is late: its node is usually in hand already (the street's prefetch) */
const LOCK_FALLBACK_MS = 4_000;

/**
 * The first of two node reads to answer OK wins; when both fail, the first one's failure (the hung solve's) is returned.
 * Neither read is cancelled — each ends on its own clock (a few polls at most on the loser).
 */
export function firstOk<T extends { r: { ok: boolean } }>(a: Promise<T>, b: Promise<T>): Promise<T> {
  return new Promise<T>((res) => {
    const fails: (T | undefined)[] = [undefined, undefined];
    let failed = 0;
    const on = (p: Promise<T>, i: 0 | 1) => p.then((v) => {
      if (v.r.ok) { res(v); return; }
      fails[i] = v;
      if (++failed === 2) res(fails[0] ?? fails[1]!);
    }, (e) => {
      fails[i] = { r: { ok: false, status: 0, error: `${e instanceof Error ? e.message : e}` } } as unknown as T;
      if (++failed === 2) res(fails[0] ?? fails[1]!);
    });
    on(a, 0); on(b, 1);
  });
}
import { currentRequestScope } from "./requestScope";
import {
  checkHeroCombo, checkHeroNode, checkLine, checkMistakeLines, checkNodeReads, checkRangesSane, checkSeats, checkSolveTime, cumulativeOf, type CumulativeLine,
  solvePopulation, checkTrees, checkWarmTree, guardCheck, guardChecks, solveTimes, type CheckResult,
} from "./chainChecks";

/**
 * Per-street AI chain — the live-play version of routes/aiStudy.ts's walk:
 * one custom solution per street, each rooted with EVERY seat's range
 * conditioned on every action already taken (range × the equilibrium
 * frequency of the observed action, combo by combo), pot/stack rolled forward
 * street by street. Off-tree wager sizes never miss: any street containing
 * wagers is solved as a FIXED tree with the observed sizes pinned per raise
 * level, so the tree contains the EXACT line played.
 *
 * This replaces the "root at the current street with flop-entry ranges"
 * shortcut, whose river answers came from ranges that had never seen the
 * flop/turn action (the K9o 40%-pot river donk of 2026-07-30).
 *
 * THREE SEATS (2026-09-19). GTO Wizard AI on Ultra solves 3-player postflop
 * trees, so a three-way flop is walked the same way: the seats act in
 * postflop order (OOP, then "OOP+1", then IP), a fold drops a seat for the
 * rest of the hand, and the street after a fold re-roots a heads-up tree for
 * the two left. The node itself names the seat to act (game.players[].is_hero)
 * and the walk refuses to continue when its own rotation disagrees.
 *
 * Trees and nodes are cached inside gtowApi by content key, so the flop tree
 * solved for hero's flop decision is reused verbatim when the turn and river
 * decisions re-walk the chain — each new decision costs ~one fresh cloud
 * solve.
 */

const STREET = ["FLOP", "TURN", "RIVER"] as const;
const QKEY = ["flopActions", "turnActions", "riverActions"] as const;

/** A seat's role on the flop: "mid" is the OOP+1 seat of a three-way flop. */
export type SeatLabel = "oop" | "mid" | "ip";

export interface AiChainSpec {
  oopPos: string;
  ipPos: string;
  /** 1326-combo weight arrays ENTERING THE FLOP (chart-reconstructed). */
  oopRange: number[];
  ipRange: number[];
  /** THE THIRD SEAT of a three-way flop (2026-09-19): GTO Wizard's "OOP+1", acting between OOP and IP. Present ⇒
   *  every street is a 3-player FIXED tree until someone folds, after which the two left re-root a heads-up tree
   *  as usual. Absent ⇒ the heads-up chain exactly as before. */
  midPos?: string;
  midRange?: number[];
  flopPot: number;
  flopStack: number;
  /** EACH SEAT'S OWN STACK BEHIND entering the walk's first street, by the seat's position as named in this spec
   *  (2026-09-25, hand 4920544353). A tree has ONE stack — `flopStack`, the effective stack of the seats it holds —
   *  and the walk used to roll that one number forward street by street. When a fold shrinks the field, the stack of
   *  the players left can be far smaller: a four-way flop at 49.8 (the SB's depth) that ends with hero against a
   *  21.6bb button was solved on the turn at 39.8 behind, so the button's jam was a bet with chips behind and hero
   *  was offered a raise that does not exist. With these, every street after a close is solved at the effective stack
   *  of the seats still in (hero against the deepest villain left). Seats missing here, or the whole map absent, keep
   *  the old rolled number. */
  seatStacks?: Record<string, number>;
  /** HOW MANY PLAYERS WERE DEALT in the hand, hero included (utils/dealtSeats.dealtCount) — 2026-10-03. Only check #4
   *  reads it: the heads-up postflop order (big blind first) holds on a table dealt two, never on a blind-vs-blind pot
   *  at a table dealt three or more. Absent = unknown (an SB-vs-BB pot is then not ordered by the check). */
  dealt?: number;
  /** Concatenated short cards for the full observed board ("7cKdAh8c3s"). */
  board: string;
  /** GTOW tokens per street (X/C/F/R<bb>/RAI), up to and including the
   *  CURRENT street; the last street's tokens end at hero's pending node. */
  streets: string[][];
  /** THE TABLE'S ALL-IN AMOUNTS, parallel to `streets` (2026-10-03, hand 4922087007): for a "RAI" token, the seat's
   *  raise-to on the street as the table showed it; null elsewhere (an R token carries its own). The walk caps it at the
   *  actor's stack behind. Absent or null: the actor's own stack behind — never the tree's one stack. */
  streetAmounts?: (number | null)[][];
  /** WHO took each token, as a postflop position name, parallel to `streets`
   *  (2026-09-19). The walk is positional — tokens carry no seat — so a line
   *  whose actions are right but ORDERED wrong lands hero's pending decision
   *  on another seat's node and fails as "line ends on villain's turn", with
   *  nothing to say which capture went wrong. Given these, the walk checks its
   *  rotation against the capture at every node and names the disagreement.
   *  Entries may be null (position unknown); those are skipped. */
  streetSeats?: (string | null)[][];
  /** Hero's postflop seat and combo index (null = unknown cards). */
  heroSeat: SeatLabel;
  heroComboIdx: number | null;
  rake?: { pct_of_pot: number; cap_in_chips: number; preflop_rake_type: string | null };
  /** Force a HEADS-UP tree onto an explicit FIXED size grid instead of AUTOMATIC (2026-09-20). Opt-in and
   *  unused in production: the collapse-calibration harness (scripts/collapseCalibration.ts) needs a two-seat
   *  tree whose action menu is identical to the three-seat tree it is being compared against, and AUTOMATIC
   *  picks its own single size per node. Ignored when the spec has three seats (a 3-player tree is FIXED on
   *  every street already). */
  huGrid?: { bet: readonly string[]; raise: readonly string[] };
  /** Which collapse plan this walk is (multiwayCollapse.ts's `kind`, e.g. "SB+BB merged", "3-way", "last-resort:hero
   *  vs CO") — 2026-09-24. Several plans for one 4+ way decision run concurrently against the SAME board/street with
   *  DIFFERENT composite ranges by design (a merged seat can reuse another seat's position label), so the tree-miss
   *  diagnostic (gtowApi.describeTreeChange) needs this to tell "a different plan's first-ever tree" apart from "the
   *  same tree re-created because something drifted" — purely diagnostic, never part of the cloud solve's cache key. */
  planTag?: string | null;
  /** Which preflop layer the flop-entering ranges came from — e.g.
   *  "ign200_3maxasym2ci_D100_s100_eq + exploit hero range (btn_open)". Not
   *  used by the solve; kept so a stored trace says what it assumed. */
  rangeSource?: string;
  /** RE-ROOT (2026-09-22): the first entry of `streets` is this street, not the flop — 1 = turn, 2 = river. The
   *  pot/stack/ranges passed in are then the ones ENTERING that street. Used when a 4+ way spot cannot be
   *  collapsed from the flop (every villain has chips in on an earlier street): the earlier streets' chips become
   *  plain pot and the current street is collapsed on its own. Default 0. */
  firstStreet?: 0 | 1 | 2;
  /** Walk every street to its end and return the ranges leaving the last one (`rangesOut`) instead of stopping at
   *  hero's node — how a re-root conditions the ranges it starts from. The last street must close. */
  walkThrough?: boolean;
  /** THE HAND THIS WALK BELONGS TO (2026-09-24). With it, every street the walk closes is checkpointed — the seats'
   *  ranges leaving it, the pot and stack, the trace of the walk — and the hand's next decision starts from the
   *  deepest checkpoint whose tokens still match the capture. A previous street's ranges are then never computed
   *  twice for one hand, whatever happens to the tree cache. Without it the walk starts at the flop as before. */
  handKey?: string;
  /** with handKey: checkpoint in this process's memory ONLY — nothing written to the hand's facts (services/handFacts,
   *  persisted). The last resort's narrowing walks (2026-10-04, review 3): their trees are not the hand's answer
   *  trees, and the hand page must show only those. */
  checkpointOnly?: boolean;
}

/**
 * The whole walk, recorded as it happens (services/solveStore.ts keeps it):
 * the spec, each street's tree, and every node visited with its full
 * action_solutions and the action taken. Enough to replay the conditioning
 * step by step, and to diff a later re-solve against what answered live.
 */
export interface ChainTraceNode {
  si: number;
  ti: number;
  street: "FLOP" | "TURN" | "RIVER";
  board: string;
  /** action codes walked on this street before this node */
  codes: string[];
  /** index into the street's `players` (0 = first to act) */
  actor: number;
  potNode: number;
  /** committed this street, one entry per seat of the street's `players` */
  invested: number[];
  actions: {
    name: string; code: string; betsize: number | null; position: string | null;
    totalFrequency: number | null; totalEv: number | null;
    strategy: number[]; evs: number[];
  }[];
  /** index into `actions` of the observed action, null at hero's pending node */
  taken: number | null;
  heroNode: boolean;
  /** where the node's JSON came from (2026-09-24): the process cache, a poll another request already had in
   *  flight, or this walk's own poll — and the wall-clock it took */
  src?: NodeSource | "failed" | "checkpoint";
  ms?: number;
  /** this node was not read by this call: its record travels with the hand's checkpoint (2026-09-24) */
  fromCheckpoint?: boolean;
  /** villain took an action the solver almost never takes here (services/offTree, 2026-09-27): flagged, and since
   *  2026-10-06 his range after it is the soft range (offTree.soft says what was carried) */
  offTree?: OffTreeLine;
  /** HERO'S ACTION HERE WAS NARROWED BY THE STRATEGY HE WAS ANSWERED WITH (retree-consistency, 2026-10-08): this node is
   *  on a tree other than the one his decision here was read on; `strategy` (4 dp) is the answered one for the action he
   *  took — what his range was multiplied by instead of this node's — and `combo` his own hand's share on each */
  heroAnswered?: HeroAnswered;
}
export interface HeroAnswered {
  /** "served": no node of this plan answered his action — the mix he was SERVED for it (servedStrategy) narrowed it */
  solId: string; src: "memory" | "store" | "served"; solveRow?: number; action: string;
  strategy: number[] | null;
  combo: { answered: number; tree: number } | null;
  /** the answered node did not offer his action (it is then narrowed by this tree's strategy, as before) */
  miss?: string;
  /** src "served": the plans the served mix was read on (blended or one), where it was kept, the plan walked here */
  served?: { plans: (string | null)[]; blended: boolean; first: number; kept: "memory" | "store" | "rebuilt"; plan: string | null; byClass?: boolean };
}
export interface ChainTrace {
  spec: AiChainSpec;
  /** THE RULES THE WALK RAN UNDER (2026-10-14, walkPolicy): every switch that changes what the chain sends or carries,
   *  as read at this call. The replay check (services/replayCheck) runs its walk under them, so a rule that changed
   *  since the hand — the off-tree blend of 10-13, the relative hero floor of 10-14, a menu — is not reported as our
   *  code being non-deterministic. Absent on traces before 2026-10-14: the replay derives what it can from the trace. */
  policy?: Record<string, string>;
  streets: {
    si: number; street: "FLOP" | "TURN" | "RIVER"; board: string; potIn: number; stackIn: number;
    labels: string[]; fixedLevels: string[] | null; solId: string | null; created: boolean;
    /** the street's wagers as the tree was pinned with them (2026-10-03): seat index + amount; `fixedLevels` says the
     *  same in words ("9.4bb by HJ") — before 2026-10-03 it held % of pot */
    played?: PlayedWager[] | null;
    /** each seat's own stack behind entering the street, by position, as the tree was sent it (2026-10-03) */
    stacksIn?: Record<string, number>;
    /** wall-clock ms: the cloud solve (ensureCustomSolution) and the node walk on it (since 2026-09-12) */
    solveMs?: number; walkMs?: number;
    /** why the street's tree was CREATED instead of found in the cache (gtowApi.describeTreeChange); null when
     *  it was cached (2026-09-24). A turn that re-creates its FLOP tree is a leak, and this names it. */
    treeWhy?: string | null;
    /** the street had wagers but was walked on its cached size-free (AUTOMATIC / grid) tree because the observed
     *  sizes were on it — or why that was tried and not possible (2026-09-24). null when never applicable. */
    reuse?: string | null;
    /** this street was NOT walked by this call: its records come from the hand's checkpoint (2026-09-24) */
    fromCheckpoint?: boolean;
    /** this street was walked from hero's LAST node on, not from its root: the tokens before it came from the
     *  hand's mid-street checkpoint (2026-09-24); the number is how many nodes were not read again */
    resumedAt?: number;
    /** why the mid-street checkpoint could not be resumed although one existed */
    resumeMiss?: string;
    /** the walk's node reads by source, and the wall-clock of the ones that waited on the network */
    nodeSrc?: { cache: number; joined: number; fetched: number; fetchMs: number;
      /** of the `cache` reads, how many came from the PERSISTENT solve cache (services/gtowSolveCache, 2026-09-28) —
       *  answered by an earlier solve, maybe an earlier process, with no request; absent when none did */
      store?: number };
    /** WHAT GTO WIZARD WAS ASKED TO SOLVE on this street (2026-09-24): the tree request as sent — rake and cap, pot,
     *  stack, the size grid, the tree's own rules — with the ranges summarised (gtowApi.treeRequestSummary). A cached
     *  tree was created from this same body (the cache key covers every field of it). */
    sent?: unknown;
    /** the GTO Wizard session whose solve this is (gtowSessions: primary = Ultra, secondary = Elite) — or "cache":
     *  the tree came from the persistent solve cache (services/gtowSolveCache) and no account was asked for it */
    account?: string | null;
    /** the `[gtow-route]` reason the account took this street's tree (least-loaded routing, 2026-10-08) — a tree created
     *  on this call only (a cached tree was routed when it was made) */
    route?: string;
    /** HOW THIS STREET'S RANGES WERE PRODUCED on this call (2026-09-25, the chain ledger — services/chainPath):
     *  hit = the hand's closed-street memo, resumed = from hero's last node, first = walked for the first time in
     *  this hand, by-design / rebuilt = walked again (the code and why say which rule or which miss) */
    prov?: { how: StreetPath["how"]; code?: string; why?: string | null };
    /** extra requests on this street that are not about the ranges: a tree created again, a node fetched twice */
    leak?: { code: string; why: string } | null;
    /** The street's seats in acting order and their entering ranges, parallel arrays (since 2026-09-19): a
     *  three-way flop lists three, the street after a fold lists the two left. oopIn/ipIn are the first and
     *  last of them, kept for readers of older traces. */
    players?: string[];
    rangesIn?: number[][];
    oopIn: number[]; ipIn: number[];
    /** did the street start from the previous street's solved output (chainPath.RangeCheck, 2026-09-26) */
    rangeCheck?: RangeCheck;
    /** THE CHAIN'S INVARIANTS the walk itself can see, as of the end of this street's walk (services/chainChecks,
     *  2026-09-27): ranges sane, villain mistake lines, seats, the line as walked, trees, node reads, the warm-up's
     *  tree, the street's time, and on the decision street hero's node and combo. They travel with the street's
     *  checkpoint, so a memo hit on a later decision still shows how the street was walked. */
    checks?: CheckResult[];
    /** THE RE-TREE (2026-10-08, retree-consistency): this street's pinned tree carries the menus of the tree before the
     *  disagreement (retreeInputs) — which tree, each seat's source, the wager added */
    retree?: RetreeCarry;
    /** WHAT HERO'S CLASS FLOOR DID at this street's entry (HERO_CLASS_FLOOR, 2026-10-14): the mode, the lift, his live
     *  mass / class mass / own combo before and after. On a resumed street the range was floored when first entered, so
     *  before = after there. Absent when hero's cards are unknown. */
    heroFloor?: HeroFloorRecord;
  }[];
  nodes: ChainTraceNode[];
  /** where this walk started (2026-09-24): from the hand's checkpoint after `from`, or from the flop with the
   *  reason no checkpoint fit; absent when the spec carried no handKey */
  checkpoint?: { from: string | null; streetsReused: number; note: string };
  /** THE LAST RESORT'S NARROWING RACE (fastSolve, 2026-10-03): which tree was served — the narrowed one when the
   *  narrowing walk landed inside its budget, else the unnarrowed one solved beside it — and the timings (ms from the
   *  decision's start; null = not finished when the answer was served) */
  lastResortNarrowing?: {
    served: "narrowed" | "unnarrowed"; budgetMs: number; why: string | null;
    /** the narrowed path on this decision's clock ("raced"), started for the hand's memo only ("detached": no room
     *  left on the clock, a later decision can use it), or not started ("skipped") */
    narrowedPath: "raced" | "detached" | "skipped";
    /** ms from the decision's start: the narrowing walk done, the unnarrowed tree's answer, the narrowed tree's answer
     *  (null = not finished when the answer was served), and when the answer was served */
    narrowingMs: number | null; unnarrowedMs: number | null; narrowedMs: number | null; servedMs: number;
  };
  /** THE MIX SERVED AT THIS DECISION (fastSolve, on the reference walk's trace only — servedStrategy, 2026-10-08) */
  served?: ServedMix;
  result: { ok: boolean; why?: string; potNode?: number; stackStreet?: number; line?: string; solves?: number };
}

// ── per-hand street checkpoints ────────────────────────────────────────────────────────────────────────────────
/**
 * THE RANGES LEAVING A STREET ARE COMPUTED ONCE PER HAND (2026-09-24, Brady: "just store these ranges in memory —
 * NEVER a re-compute of a previous street's range"). A checkpoint is written when a street closes: the surviving
 * seats with their conditioned ranges, the pot and stack entering the next street, the line so far, and the trace
 * records of everything walked. The next decision of the same hand starts from the deepest checkpoint that still
 * fits the capture.
 *
 * CONTENT-ADDRESSED (2026-09-25, the chain ledger). A checkpoint used to be found by `hand|street|seat labels|plan`
 * and then checked token by token; nothing in that key said which RANGES, pot or stack the street had been walked
 * from, so a flop walked from one set of arrival ranges could be reused under another. Now every street has a key
 * made of what determines it — a Merkle chain:
 *
 *   root      = H(hand, first street, every seat's position + label + entering range, pot, stack, each seat's own
 *                 stack, board so far, rake, hero's combo (his range floor), the heads-up grid)
 *   exit(k)   = H(entry(k), the street's tokens, the board through street k)      entry(0) = root, entry(k+1) = exit(k)
 *
 * A lookup computes the keys the capture implies and takes the deepest one in the memo; a capture that re-reads a
 * street, or ranges that arrive differently, simply produce other keys and the walk starts from the deepest ancestor
 * that still matches. The memo is DERIVED state — dropping it costs time, never an answer. What happened is written
 * to the hand's facts (services/handFacts, StreetRecord), which is how a re-walk is told apart from a first walk and
 * named: the capture changed, the inputs changed, the memo was lost (a restart), a new collapse plan.
 */
interface StreetCheckpoint {
  /** the street this checkpoint leaves (0 flop, 1 turn) */
  k: number;
  /** the chain's root key — checkpoints of one walk group under it */
  root: string;
  seats: { pos: string; label: SeatLabel; range: number[] }[];
  pot: number;
  stack: number;
  /** each surviving seat's own stack behind entering the next street (null when the spec carried no seatStacks) */
  behind: Record<string, number> | null;
  /** the stack re-derivations made while walking up to here (the answer repeats them) */
  stackNotes: string[];
  walked: string[];
  /** fingerprint of `seats` — the ranges this street hands on (chainPath.RangeCheck) */
  out?: string;
  streets: ChainTrace["streets"];
  nodes: ChainTraceNode[];
  at: number;
}
const CHECKPOINTS_MAX = 900;
const checkpoints = new Map<string, StreetCheckpoint>();
/** hand → every memo key it wrote (closed and partial), for checkpointsFor / forgetCheckpoints */
const handIndex = new Map<string, Set<string>>();
const HAND_INDEX_MAX = 400;
/** hand → nodes it FETCHED (solution|street|codes): a second fetch of one is a request the cache should have saved */
const fetchedByHand = new Map<string, Set<string>>();

const hashOf = (x: unknown): string => Bun.hash(JSON.stringify(x)).toString(36);

/** The chain's root key: everything the first street's walk depends on (see above). */
function rootKeyOf(spec: AiChainSpec, seats: { pos: string; label: SeatLabel; range: number[] }[], first: number, cards: string[]): string {
  // each seat's own stack (spec.seatStacks, 2026-09-25) decides the stack every later street is solved at
  return hashOf([spec.handKey, first, seats.map((s) => [s.pos, s.label, hashOf(s.range)]), spec.flopPot, spec.flopStack,
    spec.seatStacks ?? null, cards.slice(0, 3 + first).join(""), spec.rake ?? null, spec.heroComboIdx, spec.huGrid ?? null]);
}
/** a street's exit key: its entry, its tokens, the table's all-in amounts beside them (2026-10-03), the board */
const exitKeyOf = (entry: string, toks: string[], board: string, amounts?: (number | null)[] | null): string =>
  hashOf(amounts?.some((x) => x != null) ? [entry, toks, board, amounts] : [entry, toks, board]);
/** The fingerprint of a set of ranges: every seat, with its exact range (chainPath.RangeCheck). */
export const rangesFp = (seats: { pos: string; range: number[] }[]): string => hashOf(seats.map((s) => [s.pos, hashOf(s.range)]));
const fpShort = (fp: string | null): string => (fp ? `#${fp.slice(0, 6)}` : "—");

/**
 * Did the street start from the previous street's solved output? The expected fingerprint is the hand's LEDGER record
 * of the previous street (written when it closed, possibly by an earlier decision), else what this call saw it hand
 * on. A hand whose previous street was solved more than once with different results says so.
 */
function rangeCheckOf(a: {
  k: number; first: number; si: number; plan: string | null; started: string | null; prevOut: string | null;
  prevKey: string | null; records: StreetRecord[];
}): RangeCheck {
  if (a.si === 0) {
    return { from: null, ok: null, inFp: a.started, expected: null,
      why: a.k === 0 ? "the flop starts from the preflop ranges (see the flop ranges column)" : `the chain starts on the ${STREET[a.k]!.toLowerCase()} (re-rooted): its ranges come from the capture` };
  }
  const from = STREET[a.k - 1]!.toLowerCase() as "flop" | "turn";
  const closed = a.records.filter((r) => r.kind === "closed" && r.k === a.k - 1 && r.first === a.first && (r.plan ?? null) === a.plan && r.out);
  const rec = a.prevKey ? closed.find((r) => r.key === a.prevKey) : undefined;
  const expected = rec?.out ?? a.prevOut;
  const outs = new Set(closed.map((r) => r.out));
  const twice = outs.size > 1 ? ` — note: the ${from} was solved ${outs.size} times in this hand with different results; this street used the latest` : "";
  if (!a.started) return { from, ok: null, inFp: null, expected, why: `resumed from a checkpoint saved before this check existed — not verified${twice}` };
  if (!expected) return { from, ok: null, inFp: a.started, expected: null, why: `no recorded output of the ${from} solve to check against${twice}` };
  if (a.started === expected) return { from, ok: true, inFp: a.started, expected, why: `verified: uses the ${from} solve's output ranges (${fpShort(expected)})${twice}` };
  return { from, ok: false, inFp: a.started, expected,
    why: `did NOT start from the ${from} solve's output ranges: started from ${fpShort(a.started)}, the ${from} solve handed on ${fpShort(expected)}${twice}` };
}

function bounded<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const first = m.keys().next().value;
    if (first === undefined) break;
    m.delete(first);
  }
}
function indexKey(handKey: string, key: string): void {
  const set = handIndex.get(handKey) ?? new Set<string>();
  set.add(key);
  handIndex.delete(handKey);
  handIndex.set(handKey, set);
  bounded(handIndex, HAND_INDEX_MAX);
}
function saveCheckpoint(handKey: string, key: string, cp: StreetCheckpoint): void {
  checkpoints.delete(key);           // re-insert: the map's order is its age order
  checkpoints.set(key, cp);
  bounded(checkpoints, CHECKPOINTS_MAX);
  indexKey(handKey, key);
}

/** The streets checkpointed for a hand, grouped by the walk (root) they belong to — tests and status pages. */
export function checkpointsFor(handKey: string): { key: string; streets: number[] }[] {
  const byRoot = new Map<string, number[]>();
  for (const key of handIndex.get(handKey) ?? []) {
    const cp = checkpoints.get(key);
    if (!cp) continue;
    byRoot.set(cp.root, [...(byRoot.get(cp.root) ?? []), cp.k].sort());
  }
  return [...byRoot.entries()].map(([key, streets]) => ({ key, streets }));
}

/**
 * THE MID-STREET CHECKPOINT (2026-09-24). A closed-street checkpoint cannot exist for the street hero is deciding
 * on — it has not closed. So the FIRST decision past a street used to walk that street again from its root (from
 * cached nodes, but a walk all the same), because hero's own action was not known when his node was answered.
 * Now hero's node IS the checkpoint: everything conditioned up to it, the betting state, the tree it was read on,
 * and the node's own JSON. The next decision of the hand — the same street re-asked, or the next street — resumes
 * from that node: hero's realised action is conditioned from the stored node, and only what happened AFTER it is
 * read. One per street ENTRY key (the latest), so it is only ever resumed from the very ranges, pot and stack it
 * was walked from.
 */
interface PartialCheckpoint {
  k: number;
  /** tokens per street 0..k; the k-th entry is the PREFIX up to hero's node */
  tokens: string[][];
  /** the seats as they ENTERED the street (post-floor) — what the tree is keyed on */
  entering: { pos: string; label: SeatLabel; range: number[] }[];
  /** the seats conditioned up to hero's node */
  seats: { pos: string; label: SeatLabel; range: number[] }[];
  pot: number;
  stack: number;
  st: StreetSnapshot;
  codes: string[];
  solId: string;
  /** this street's node records before hero's node */
  nodes: ChainTraceNode[];
  /** hero's node JSON — the next decision conditions his realised action from it without a read */
  heroData: any;
  /** fingerprint of the ranges the street started from, before hero's floor (chainPath.RangeCheck) */
  inFp?: string | null;
  at: number;
}
const partials = new Map<string, PartialCheckpoint>();

function savePartial(handKey: string, key: string, pc: PartialCheckpoint): void {
  partials.delete(key);
  partials.set(key, pc);
  bounded(partials, CHECKPOINTS_MAX);
  indexKey(handKey, `p:${key}`);
}

/** Forget a hand's checkpoints, closed and mid-street, and its street ledger (tests; a replay that wants a cold walk). */
export function forgetCheckpoints(handKey: string): void {
  for (const key of handIndex.get(handKey) ?? []) {
    if (key.startsWith("p:")) partials.delete(key.slice(2)); else checkpoints.delete(key);
  }
  handIndex.delete(handKey);
  fetchedByHand.delete(handKey);
  handFacts.forgetStreets(handKey);
}

/** Drop ONE hand's derived memo (its closed and mid-street checkpoints) and keep its facts — the seatbelt's re-solve
 *  (fastSolve, 2026-10-03): every street is walked again from the table's state, and the ledger still says what was. */
export function forgetChainMemo(handKey: string): void {
  for (const key of handIndex.get(handKey) ?? []) {
    if (key.startsWith("p:")) partials.delete(key.slice(2)); else checkpoints.delete(key);
  }
  handIndex.delete(handKey);
}

/** Drop the derived memo ONLY — every hand's checkpoints — and keep the facts (tests: a restart must read as one). */
export function dropChainMemo(): void {
  checkpoints.clear();
  partials.clear();
  handIndex.clear();
  fetchedByHand.clear();
}

const sameToks = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * How a street WALKED on this call relates to what the hand's ledger says was walked before — its provenance
 * (services/chainPath). Pure over the hand's StreetRecords.
 */
export function streetProvenance(a: {
  records: StreetRecord[]; k: number; first: number; plan: string | null; entry: string; toks: string[];
  isLast: boolean; resumed: boolean; resumeMiss?: string | null; partialRejected?: string | null;
}): { how: StreetPath["how"]; code?: string; why?: string | null } {
  if (a.resumed) return { how: "resumed" };
  const name = STREET[a.k]!.toLowerCase();
  const mine = a.records.filter((r) => r.k === a.k && r.first === a.first);
  const samePlan = mine.filter((r) => (r.plan ?? null) === a.plan);
  const sameEntry = samePlan.filter((r) => r.entry === a.entry);
  const newPlan = { how: "by-design" as const, code: "street:new-plan", why: `a collapse plan new to this hand (${a.plan ?? "no collapse"}) walks the ${name} for the first time` };
  if (!a.isLast) {
    // an EARLIER street walked on this call: it was either never walked before (first) or its memo missed
    if (sameEntry.some((r) => r.kind === "closed" && sameToks(r.tokens, a.toks))) {
      return { how: "rebuilt", code: "street:memo-lost", why: `the ${name} was walked before under the same inputs and its checkpoint is gone (API restart or memo eviction)` };
    }
    const partialSame = sameEntry.find((r) => r.kind === "partial" && a.toks.length >= r.tokens.length && r.tokens.every((t, i) => a.toks[i] === t));
    if (partialSame) {
      if (a.resumeMiss) return { how: "by-design", code: "street:tree-changed", why: a.resumeMiss };
      return { how: "rebuilt", code: "street:memo-lost", why: `hero's ${name} node was answered and its resume point is gone (API restart or memo eviction)` };
    }
    const other = sameEntry.find((r) => r.kind === "closed") ?? sameEntry.find((r) => r.kind === "partial");
    if (other) return { how: "rebuilt", code: "street:capture-changed", why: `the capture re-read the ${name}: [${other.tokens.join(",")}] when walked, [${a.toks.join(",")}] now` };
    if (samePlan.length) return { how: "rebuilt", code: "street:inputs-changed", why: `the ranges, pot or stack entering the ${name} changed since it was walked` };
    if (mine.length) return newPlan;
    return { how: "first" };
  }
  // the DECISION street, walked from its root: normal on its first ask; on a re-ask its resume point should have held
  if (sameEntry.some((r) => r.kind === "partial")) {
    if (a.resumeMiss) return { how: "by-design", code: "street:tree-changed", why: a.resumeMiss };
    if (a.partialRejected) return { how: "rebuilt", code: "street:capture-changed", why: a.partialRejected };
    return { how: "rebuilt", code: "street:memo-lost", why: `hero's earlier ${name} node was answered and its resume point is gone (API restart or memo eviction)` };
  }
  if (samePlan.some((r) => r.kind === "partial")) {
    return { how: "rebuilt", code: "street:inputs-changed", why: `the ranges, pot or stack entering the ${name} changed since hero's last ${name} decision` };
  }
  if (mine.some((r) => r.kind === "partial")) return newPlan;
  return { how: "first" };
}

const r4 = (xs: number[] | undefined): number[] => (xs ?? []).map((x) => Math.round((x ?? 0) * 10000) / 10000);
const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * THE EFFECTIVE STACK OF THE SEATS IN A TREE (2026-09-25): hero's stack behind against the DEEPEST villain's, the
 * rule the dealt depth already follows (hrc6max.dealtEffective) applied to the seats this tree actually holds. A
 * seat whose stack is unknown counts as unbounded, so a missing reading can never shrink a tree — the caller caps
 * the result with the stack it would have used anyway. Infinity when nothing is known.
 */
export function effectiveBehind(seats: string[], heroPos: string, behind: Record<string, number> | null | undefined): number {
  return behind ? effectiveStack(seats, heroPos, (p) => behind[p]) : Infinity;
}

export type AiChainResult =
  | {
      ok: true;
      /** GTOW node JSON at hero's pending decision (action_solutions et al). */
      data: any;
      /** Pot in bb at hero's node (street-entering pot + every seat's commit). */
      potNode: number;
      /** Stack behind (bb) entering the current street. */
      stackStreet: number;
      /** Human-readable line actually walked (post-pinning sizes). */
      line: string;
      /** Cloud solves that ran fresh for this call (0 = fully cached). */
      solves: number;
      /** walkThrough only: each surviving seat's range leaving the last street, by position */
      rangesOut?: Record<string, number[]>;
      /** Wagers the walk matched only loosely — a size nudged onto the tree's, or a big raise taken as its all-in. */
      snaps?: string[];
      /** Streets solved at a smaller stack than the field rolled forward, because seats left (spec.seatStacks). */
      stackNotes?: string[];
      /** "RE-TREE: …" lines (retree-consistency, 2026-10-08): a street re-solved with its menus carried, hero's earlier
       *  action on it narrowed by his answered strategy */
      retreeNotes?: string[];
      /** hero's combo weight in his conditioned range at his node (null = cards unknown) — under the absent bound
       *  (HERO_ABSENT_WEIGHT × heroMaxLive, services/heroAbsent) he is absent there */
      heroWeight?: number | null;
      /** the heaviest live combo weight in that same range (board removed): the unit the bound is measured in (2026-10-14) */
      heroMaxLive?: number | null;
      /** hero's node: the street (0 flop .. 2 river) and his action number on it — the served mix's key (servedStrategy) */
      heroAt?: { k: number; n: number };
      trace: ChainTrace;
    }
  | { ok: false; why: string; trace?: ChainTrace };

/**
 * DOES A NODE'S SEAT ORDER CONTRADICT OURS (2026-10-05, stress-500 pf_postin-003)? `listed` = the node's players, in
 * rotation from the one to act (GTO Wizard's order, hero first); `ours` = our tree seats in rotation from our actor.
 * The names are the SOLUTION's — a tree shared from a walk with other seats (the cache keys on ranges, stacks, pot and
 * sizes, not on names) keeps that walk's names — so only a name this walk has can disagree, slot by slot. Lists that
 * do not line up (another length, hero not first) fall back to the actor's name alone.
 */
export function rotationDisagrees(listed: { position?: unknown; is_hero?: unknown }[], ours: string[], norm: (p: string) => string = (p) => p.toUpperCase()): boolean {
  const o = ours.map(norm);
  const said = listed.find((p) => p?.is_hero)?.position;
  if (said == null) return false;
  // BY TREE SLOT (review 5): a solution's seats are its walk's, but every tree seats them in POSTFLOP ORDER — OOP,
  // OOP+1, IP — so the actor's SLOT is comparable whatever the names: the node's actor's place among the node's names
  // in postflop order against ours among ours. A shared solution with other names can then neither misfire nor slip a
  // real disagreement through. Three or more seats with known names only (heads-up the dealer's name is ambiguous).
  const ORDER = ["SB", "BB", "UTG", "UTG+1", "UTG+2", "LJ", "MP", "MP+1", "HJ", "CO", "BTN"];
  const rank = (p: string) => ORDER.indexOf(String(p).toUpperCase());
  const theirs = listed.map((p) => String(p?.position ?? ""));
  if (theirs.length === ours.length && ours.length >= 3 && [...theirs, ...ours].every((p) => rank(p) >= 0)) {
    const slot = (names: string[], who: string) => [...names].sort((x, y) => rank(x) - rank(y)).findIndex((p) => p.toUpperCase() === who.toUpperCase());
    return slot(theirs, String(said)) !== slot(ours, ours[0]!);
  }
  // review 4: names that are not exactly OUR seats' are another walk's — a shared solution — and say nothing (neither
  // agreement nor disagreement); only our own names, in a list that lines up, are compared slot by slot
  const names = listed.map((p) => norm(String(p?.position ?? "")));
  // a list that does not line up with ours (another length — a node that lists fewer players): the actor's name alone,
  // when it is one of ours; a foreign actor name is another walk's and says nothing
  if (names.length !== o.length) return o.includes(norm(String(said))) && norm(String(said)) !== o[0];
  const same = names.every((n) => o.includes(n)) && o.every((n) => names.includes(n));
  if (!same) return false;
  if (!listed[0]?.is_hero) return norm(String(said)) !== o[0];
  return names.some((nm, j) => nm !== o[j]);
}

// ---- 1326-combo arithmetic (GTO Wizard's ordering, see utils/comboIndex): card = rank*4 + suit, combo(a<b) = b(b-1)/2 + a
const RANKS_ = "23456789TJQKA", SUITS_ = "cdhs";
const cardIdx = (card: string): number => RANKS_.indexOf(card[0]!.toUpperCase()) * 4 + SUITS_.indexOf(card[1]!.toLowerCase());
const comboCards = (idx: number): [number, number] => {
  let b = 1;
  while ((b + 1) * b / 2 <= idx) b++;
  return [idx - (b * (b - 1)) / 2, b];
};
/** Every combo of the same 169-class as `idx` (same two ranks, same suitedness), including `idx` itself. */
const classCombos = (idx: number): number[] => {
  const [a, b] = comboCards(idx);
  const ra = Math.floor(a / 4), rb = Math.floor(b / 4), suited = a % 4 === b % 4;
  const out: number[] = [];
  for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
    if (ra === rb && s2 <= s1) continue;              // a pair: each unordered suit pair once
    if (ra !== rb && (s1 === s2) !== suited) continue;
    const x = ra * 4 + s1, y = rb * 4 + s2;
    if (x === y) continue;
    const [lo, hi] = x < y ? [x, y] : [y, x];
    out.push((hi * (hi - 1)) / 2 + lo);
  }
  return out;
};

// ---- hero's class floor (HERO_CLASS_FLOOR, 2026-10-14 A/B — docs/2026-10-14-hero-floor-ab.md) ---------------------
/**
 * HOW HERO'S OWN HAND CLASS IS KEPT ALIVE in his entering range at every street (the floor block in the walk):
 *   abs   — today, the default: every unblocked combo of his class is lifted to >= 0.05, an ABSOLUTE weight. On a thin
 *           range (a rare line, or his own earlier actions narrowing him under ~20 combos) 0.05 is the heaviest weight he
 *           holds and his class becomes 15-100 % of what villain believes he has: villain is solved against a hero who
 *           all but shows his hand (answer-path audit 2026-10-14, finding 2).
 *   rel5  — the lift is RELATIVE: >= 0.05 x the heaviest live combo weight in his range (board cards removed). On a
 *           full-weight range (max 1) it is abs exactly; on a thin range it keeps his class the share the floor meant.
 *   rel1  — the same at 0.01 x.
 *   none  — no lift but an epsilon (1e-6 x max, at least 1e-6: GTO Wizard keeps weights down to ~1e-7, probed
 *           2026-10-05) so his combo exists and a strategy can be read at his node: the natural reference.
 * Every mode lifts the WHOLE class (suit isomorphism — GTO Wizard rejects beliefs that break it on the street's board,
 * 2026-09-17), card removal stays absolute (a combo sharing a card with the board is never lifted), and a weight already
 * above the floor is left alone. Idempotent: applying a mode twice to a range is applying it once (a resumed street
 * re-applies it to a range that was floored when the street was entered).
 */
export type HeroClassFloorMode = "abs" | "rel5" | "rel1" | "none";
/** the absolute floor that ran 2026-09-17 .. 2026-10-14 (HERO_CLASS_FLOOR=abs restores it) */
export const HERO_CLASS_FLOOR_ABS = 0.05;
export const HERO_CLASS_FLOOR_EPS = 1e-6;
/** THE DEFAULT IS rel5 SINCE 2026-10-14 (Brady, on the A/B: "go ahead, flip to rel5"): on the 47 decisions where the floor
 *  bites (hero under 5 combos, 1.9 % of postflop decisions) abs's mix lost 0.134 bb a decision against the natural
 *  villain (max 2.68: a folded AdQc / KhKs), rel5 0.000 and the natural reference's picks on 47 of 47; above 5 combos
 *  the modes are identical. Register: services/approximations.ts `hero-class-floor`. An unknown value reads as rel5. */
export const heroClassFloorMode = (env: Record<string, string | undefined> = process.env): HeroClassFloorMode => {
  const v = String(env.HERO_CLASS_FLOOR ?? "rel5").trim().toLowerCase();
  return v === "abs" || v === "rel1" || v === "none" ? v : "rel5";
};
/** The heaviest live combo weight in a range (board cards removed) — the unit the relative floor and check #17's
 *  absent bound are measured in. */
export function heaviestLive(range: ArrayLike<number>, boardIdx: ReadonlySet<number>): number {
  let max = 0;
  for (let i = 0; i < 1326; i++) {
    const w = range[i] ?? 0;
    if (!(w > max)) continue;
    const [a, b] = comboCards(i);
    if (boardIdx.has(a) || boardIdx.has(b)) continue;
    max = w;
  }
  return max;
}
/** The weight a mode lifts hero's class to, given the heaviest live combo weight in his range. */
export function heroClassFloorOf(mode: HeroClassFloorMode, maxLive: number): number {
  const m = Math.max(0, maxLive);
  switch (mode) {
    case "abs": return HERO_CLASS_FLOOR_ABS;
    case "rel5": return 0.05 * m;
    case "rel1": return 0.01 * m;
    case "none": return Math.max(HERO_CLASS_FLOOR_EPS * m, HERO_CLASS_FLOOR_EPS);
  }
}
/** What the floor did at a street entry (the trace's `heroFloor`): the lift, and hero's range before and after it —
 *  live mass (board removed), his class's mass, his own combo's weight, and how many class combos were lifted. */
export interface HeroFloorRecord {
  mode: HeroClassFloorMode; floor: number; maxLive: number;
  liveBefore: number; liveAfter: number; classBefore: number; classAfter: number; comboBefore: number; comboAfter: number;
  lifted: number;
}
/**
 * Apply the mode's floor to hero's class in `range` (in place), card removal by `boardIdx` (card indexes on the board).
 * Returns what it did. `maxLive` is read from the range as given (before the lift), over every unblocked combo.
 */
export function applyHeroClassFloor(range: number[], heroComboIdx: number, boardIdx: ReadonlySet<number>, mode: HeroClassFloorMode): HeroFloorRecord {
  const blocked = (idx: number): boolean => { const [a, b] = comboCards(idx); return boardIdx.has(a) || boardIdx.has(b); };
  let maxLive = 0, liveBefore = 0;
  for (let i = 0; i < 1326; i++) {
    const w = range[i] ?? 0;
    if (!(w > 0) || blocked(i)) continue;
    liveBefore += w;
    if (w > maxLive) maxLive = w;
  }
  const cls = classCombos(heroComboIdx).filter((idx) => !blocked(idx));
  const classBefore = cls.reduce((s, idx) => s + Math.max(0, range[idx] ?? 0), 0);
  const comboBefore = blocked(heroComboIdx) ? 0 : Math.max(0, range[heroComboIdx] ?? 0);
  const floor = heroClassFloorOf(mode, maxLive);
  let lifted = 0;
  for (const idx of cls) {
    const w = range[idx] ?? 0;
    if (w < floor) { range[idx] = floor; lifted++; }
    else if (!(w > 0)) range[idx] = 0;
  }
  const classAfter = cls.reduce((s, idx) => s + (range[idx] ?? 0), 0);
  return {
    mode, floor, maxLive, liveBefore, liveAfter: liveBefore + (classAfter - classBefore), classBefore, classAfter,
    comboBefore, comboAfter: blocked(heroComboIdx) ? 0 : (range[heroComboIdx] ?? 0), lifted,
  };
}

export type ActionKind = "Fold" | "Check" | "Call" | "Bet" | "Raise" | "AllIn";

/**
 * The betting state of one postflop street for N seats in acting order: who acts next, what each has put in,
 * who is still in, and whether the betting has closed. Heads-up this is strict alternation; three-way it is a
 * rotation that a fold shortens, and "outstanding" is the most any seat has put in rather than "the other's".
 * A street is closed once no seat still in owes an action since the last wager (everyone checked, or everyone
 * matched the last bet or left) — or when one seat is left.
 */
export interface StreetSnapshot { live: number[]; inv: number[]; p: number; owed: number[]; caps?: (number | null)[] }

/**
 * EACH SEAT'S STACK IS ITS CAP (2026-10-03). Every seat brings its own stack behind into the street (`caps`, null =
 * unbounded): a call puts in no more than the seat has (an all-in call for less), and a seat that has put in all it
 * has is ALL-IN — it never acts again on the street (the rotation skips it, a raise does not re-open it), exactly as
 * GTO Wizard's tree has it. Before, every seat carried the tree's one stack, so a short stack could not be all-in for
 * less and a 28bb shove was a 97.8bb one.
 */
export class StreetState {
  /** seat indices still in the hand, acting order */
  live: number[];
  /** committed this street, per seat index */
  inv: number[];
  /** each seat's stack behind entering the street — the most it can put in (null = unbounded) */
  readonly caps: (number | null)[];
  private p = 0;
  private owed: Set<number>;

  constructor(n: number, caps?: readonly (number | null | undefined)[]) {
    this.live = Array.from({ length: n }, (_, i) => i);
    this.inv = new Array(n).fill(0);
    this.caps = Array.from({ length: n }, (_, i) => { const c = caps?.[i]; return c != null && Number.isFinite(c) ? c : null; });
    this.owed = new Set(this.live.filter((s) => !this.allIn(s)));
    this.skipAllIn();
  }
  /** the seat has put in everything it has */
  allIn(s: number): boolean { const c = this.caps[s]; return c != null && (this.inv[s] ?? 0) >= c - 0.005; }
  get actor(): number { return this.live[this.p % this.live.length]!; }
  get outstanding(): number { return Math.max(...this.inv); }
  get potIn(): number { return this.inv.reduce((s, x) => s + x, 0); }
  get closed(): boolean { return this.live.length < 2 || !this.live.some((s) => this.owed.has(s)); }
  /**
   * What seat `s` has in the pot that can be MATCHED: a bet past the most any other seat can put in (a live seat's
   * stack, a folded seat's chips) is uncalled and goes back to its owner. The pot hero can win — the tree's, and the
   * table's once the excess is returned (heads-up: a 150bb shove into a 50bb stack is a 50bb bet).
   */
  matched(s: number): number { return this.matchedBySeat().get(s) ?? 0; }
  get matchedPotIn(): number { return [...this.matchedBySeat().values()].reduce((sum, x) => sum + x, 0); }
  /** the tree's seats are the contesting set; a folded seat's chips are what it left (utils/tableMoney.contestedChips) */
  private matchedBySeat(): Map<number, number> {
    const seats = this.inv.map((_, i) => i);
    return contestedChips(new Map(seats.map((i) => [i, this.inv[i] ?? 0])), {
      contesting: seats, folded: new Set(seats.filter((i) => !this.live.includes(i))), capOf: (i) => this.caps[i],
    }).bySeat;
  }

  /** The state as plain data — a mid-street checkpoint stores it and a later decision resumes from it (2026-09-24). */
  snapshot(): StreetSnapshot {
    return { live: this.live.slice(), inv: this.inv.slice(), p: this.p, owed: [...this.owed], caps: this.caps.slice() };
  }
  static fromSnapshot(n: number, snap: StreetSnapshot): StreetState {
    const st = new StreetState(n, snap.caps);
    st.live = snap.live.slice(); st.inv = snap.inv.slice(); st.p = snap.p; st.owed = new Set(snap.owed);
    return st;
  }

  /** the pointer moves past seats that are all-in (they have no decision left on this street) */
  private skipAllIn(): void {
    for (let k = 0; k < this.live.length && this.allIn(this.actor); k++) this.p = (this.p + 1) % this.live.length;
  }

  /** Apply the acting seat's action; wagers give the raise-to size in bb. */
  apply(kind: ActionKind, raiseTo?: number): void {
    const a = this.actor;
    if (kind === "Fold") {
      this.live = this.live.filter((s) => s !== a);
      this.owed.delete(a);
      // the pointer now indexes the next seat (it wraps when the folder was last)
      this.p = this.live.length ? this.p % this.live.length : 0;
      if (this.live.length) this.skipAllIn();
      return;
    }
    if (kind === "Check") this.owed.delete(a);
    else if (kind === "Call") { this.inv[a] = chipsAfter({ kind: "call" }, this.inv[a] ?? 0, this.outstanding, this.caps[a]); this.owed.delete(a); }
    else {
      // what the act puts the actor at (utils/tableMoney.chipsAfter): a raise / an all-in, never past his stack
      const to = chipsAfter({ kind: kind === "AllIn" ? "allin" : "raise", to: raiseTo ?? (kind === "AllIn" ? undefined : NaN) }, this.inv[a] ?? 0, this.outstanding, this.caps[a]);
      if (kind === "AllIn" && to <= this.outstanding + 0.005) {
        // an all-in for no more than the price is a call for less: nobody is re-opened
        this.inv[a] = to; this.owed.delete(a);
      } else {
        if (!(to > this.outstanding)) throw new Error(`${kind} to ${raiseTo}bb is not over the ${this.outstanding}bb outstanding`);
        this.inv[a] = to;
        // a wager re-opens everyone else who still has chips to act with
        this.owed = new Set(this.live.filter((s) => s !== a && !this.allIn(s)));
      }
    }
    this.p = (this.p + 1) % this.live.length;
    this.skipAllIn();
  }
}

const kindOfLabel = (label: string): ActionKind =>
  label === "Fold" || label === "Check" || label === "Call" ? label
    : label.startsWith("AllIn") ? "AllIn" : label.startsWith("Raise") ? "Raise" : "Bet";

/** Who acts on each engine label of a street, for N seats in acting order (each seat's stack behind its cap). */
export function actorsOf(labels: string[], n: number, caps?: readonly (number | null | undefined)[]): number[] {
  const st = new StreetState(n, caps);
  const out: number[] = [];
  for (const l of labels) {
    out.push(st.actor);
    st.apply(kindOfLabel(l), wagerBb(l) ?? undefined);
  }
  return out;
}

/**
 * Who acts on each capture TOKEN of a street (X / C / F / R<to> / RAI), with each seat's stack behind as its cap and
 * the table's all-in amounts beside the tokens — what the RAI labels need before there are labels (an all-in is the
 * ACTOR's all-in, so the actor must be known first).
 */
export function actorsOfTokens(toks: string[], n: number, caps: readonly (number | null | undefined)[], amounts?: readonly (number | null | undefined)[]): number[] {
  const st = new StreetState(n, caps);
  const out: number[] = [];
  toks.forEach((t, i) => {
    const a = st.actor;
    out.push(a);
    if (t === "X") st.apply("Check");
    else if (t === "C") st.apply("Call");
    else if (t === "F") st.apply("Fold");
    else if (t === "RAI") st.apply("AllIn", Math.min(amounts?.[i] ?? Infinity, st.caps[a] ?? Infinity));
    else if (/^R[\d.]+$/.test(t)) st.apply("Raise", parseFloat(t.slice(1)));
    else throw new Error(`unknown token "${t}"`);
  });
  return out;
}

/**
 * A WAGER THAT COVERS EVERY OTHER SEAT STILL IN IS THE ACTOR'S ALL-IN (2026-10-03). Heads-up, a 60bb bet from a 150bb
 * stack into a player with 50 behind can only ever be called for 50: GTO Wizard's tree holds no such bet, only the
 * all-in (probed: a listed size past what anyone can call is the all-in, named by the actor's own stack). This is not
 * the old "60% of the stack" rule — the wager here commits at least everything any opponent can match. Returns the
 * labels with such wagers as AllIn(the actor's stack), and a word for each.
 */
export function coveringAllIns(labels: string[], n: number, caps: readonly number[], known?: readonly boolean[]): { labels: string[]; notes: string[] } {
  const st = new StreetState(n, caps);
  const out: string[] = [], notes: string[] = [];
  for (const l of labels) {
    const a = st.actor;
    const x = wagerBb(l);
    let lab = l;
    if (x != null && !l.startsWith("AllIn")) {
      const most = Math.max(0, ...st.live.filter((t) => t !== a).map((t) => caps[t] ?? Infinity));
      const own = caps[a];
      // (a seat whose stack is not known is never read as all-in by its own stack: its cap is only a floor)
      if (own != null && Number.isFinite(own) && known?.[a] !== false && (x >= own - 0.005 || x >= most - 0.005)) {
        lab = `AllIn(${Math.round(own * 100)})`;
        // the actor's whole stack typed as a bet is simply his all-in; a bet that covers the others is worth a word
        if (x < own - 0.005) notes.push(`a ${Math.round(x * 100) / 100}bb wager covers every other stack still in (${Math.round(most * 100) / 100}bb at most) — the tree's all-in`);
      }
    }
    out.push(lab);
    st.apply(kindOfLabel(lab), wagerBb(lab) ?? undefined);
  }
  return { labels: out, notes };
}

/** The wagers of a street's labels as the tree takes them: each with its seat and its raise-to amount (gtowApi.played). */
export function playedOf(labels: string[], actors: number[]): PlayedWager[] {
  const out: PlayedWager[] = [];
  labels.forEach((l, i) => { const x = wagerBb(l); if (x != null) out.push({ seat: actors[i]!, to: Math.round(x * 100) / 100 }); });
  return out;
}
/** A street's played wagers in a line a person reads (the trace's `fixedLevels`, the tree ledger, check #11). */
export const playedText = (ws: PlayedWager[], seats: string[]): string[] => ws.map((w) => `${Math.round(w.to * 100) / 100}bb by ${seats[w.seat] ?? `seat ${w.seat}`}`);

/**
 * The node's action for one of the walk's labels: the exact one, a wager within the walk's tolerance (5% or 0.15bb,
 * aiStudyLine.matchActionLoose) — and an ALL-IN is the tree's all-in (2026-10-03). A label is AllIn only when the
 * actor went all-in at the table (RAI) or his wager covers every other stack (coveringAllIns), so taking the node's
 * all-in for it is the same action, whatever stack the tree has him at; check #6 compares the sizes.
 */
export function matchWalkAction(label: string, sols: any[], stack: number): number {
  if (!label.startsWith("AllIn(")) return matchActionLoose(label, sols, stack);
  // AN ALL-IN MATCHES ONLY AN ALL-IN (2026-10-03, review): within 5% a shove could be read as a bet the tree offers
  // with chips behind it, and hero would be answered against a bet he could raise
  const allIns = sols.map((a, i) => (actionKindOf(a) === "AllIn" ? i : -1)).filter((i) => i >= 0);
  const ai = matchActionLoose(label, allIns.map((i) => sols[i]), stack);
  if (ai >= 0) return allIns[ai]!;
  return allIns.length === 1 ? allIns[0]! : -1;
}

/**
 * Would this street's observed line walk on the tree `solId` (the size-free one already solved for it)? Every
 * label up to the LAST wager is checked against the tree's own actions with the walk's matcher; a wager that is
 * offered within tolerance is rewritten to the tree's exact size (so the walk then matches it exactly and rolls
 * the pot forward with the tree's number). Nodes are read from the cache; at most ONE is fetched — the node
 * where a wager is checked is a node the walk needs anyway if the fit holds. Pure over its two node getters.
 */
export async function fitsCachedTree(
  solId: string,
  labels: string[],
  stack: number,
  peek: (codes: string) => any | null,
  fetchOne: (codes: string) => Promise<any | null>,
): Promise<{ ok: true; labels: string[]; note: string } | { ok: false; why: string }> {
  const isWager = (l: string) => /\(/.test(l);
  let last = -1;
  labels.forEach((l, i) => { if (isWager(l)) last = i; });
  const out = labels.slice();
  const codes: string[] = [];
  const snaps: string[] = [];
  let fetched = false;
  for (let ti = 0; ti <= last; ti++) {
    const label = labels[ti]!;
    if (!isWager(label)) {
      codes.push(label === "Check" ? "X" : label === "Call" ? "C" : "F");
      continue;
    }
    let node = peek(codes.join("-"));
    if (!node) {
      if (fetched) return { ok: false, why: `node [${codes.join("-") || "root"}] not cached and one fetch already spent` };
      fetched = true;
      node = await fetchOne(codes.join("-"));
      if (!node) return { ok: false, why: `node [${codes.join("-") || "root"}] could not be read` };
    }
    const sols: any[] = node.action_solutions ?? [];
    const ai = matchWalkAction(label, sols, stack);
    if (ai < 0) {
      const offered = sols.filter((a) => a.action?.betsize != null && a.action.betsize !== "").map((a) => `${a.action.display_name} ${a.action.betsize}`).join(", ");
      return { ok: false, why: `${label} is not on it (offers ${offered || "no wager"})` };
    }
    const a = sols[ai]!;
    const kind = actionKindOf(a);
    const size = Number(a.action?.betsize);
    const chips = Math.round(size * 100);
    const rewritten = `${kind}(${chips})`;
    if (rewritten !== label) snaps.push(`${label} taken as the tree's ${rewritten}`);
    out[ti] = rewritten;
    codes.push(String(a.action?.code ?? ""));
  }
  return { ok: true, labels: out, note: snaps.length ? snaps.join(", ") : `every wager is on it (${labels.filter(isWager).join(", ")})` };
}

/**
 * HERO'S OWN SIZE SNAPS TO THE TREE HE WAS ASKED ON (round 3, 2026-09-25; chainReuseStress hand 4920429872). Hero
 * check-raised the flop to 4.8 — the client's rounding of the tree's own 4.7 (32.3% of the pot where the tree's raise was
 * its pinned 31.6%) — and at the turn the chain re-created the whole flop tree with both sizes pinned ("fixed sizes
 * [31.6%]→[31.6%,32.3%]") and walked it from the root: one more cloud solve, and a flop re-walk, for a rounding
 * difference in hero's OWN executed pick. A size hero chose off the tree he was shown is that tree's size, played.
 *
 * So when the street's LAST wager is hero's, and it is within the walk's tolerance (matchActionLoose: 5% or 0.15bb, the
 * all-in fallback excluded) of a size the tree he was asked on offers at his node, the street stays on THAT tree — the
 * one keyed on the levels pinned before his wager, already in the cache — and hero's action is read as the tree's size
 * (the pot rolls forward with it, as the size-free reuse does). Only when that tree is cached: it was created when hero
 * was asked, so a miss means another process or an evicted cache, and the size is pinned as played. VILLAIN sizes keep
 * their behaviour (a villain's off-tree size is the table's fact and pins a new tree), and a hero wager followed by a
 * villain's is not touched (the new level needs a tree of its own anyway). A heads-up street whose first wager is hero's
 * was asked on the size-free tree, which the reuse above already covers. Pure over its getters.
 */
export async function fitsHeroAskedTree(
  labels: string[],
  actors: number[],
  heroIdx: number,
  _pot: number,
  stack: number,
  peekSolution: (played: PlayedWager[]) => string | null,
  peek: (solId: string, codes: string) => any | null,
  fetchOne: (solId: string, codes: string) => Promise<any | null>,
): Promise<{ ok: true; labels: string[]; played: PlayedWager[]; want: number; got: number; note: string } | { ok: false; why: string | null }> {
  const isWager = (l: string) => /\(/.test(l);
  let last = -1;
  labels.forEach((l, i) => { if (isWager(l)) last = i; });
  if (last < 0 || actors[last] !== heroIdx) return { ok: false, why: null };        // no wager, or a villain's: as before
  const prefix = labels.slice(0, last);
  if (!prefix.some(isWager)) return { ok: false, why: null };                        // asked on the size-free tree
  const want = wagerBb(labels[last]!)!;
  // the tree hero was asked on: the street pinned with the wagers before his (amounts — gtowApi.played)
  const played = playedOf(prefix, actors.slice(0, last));
  const levels = played.map((w) => `${w.to}bb`);
  const solId = peekSolution(played);
  if (!solId) return { ok: false, why: `the tree hero was asked on (pinned [${levels.join(",")}]) is not cached — his ${want} is pinned as played` };
  const fit = await fitsCachedTree(solId, labels, stack, (c) => peek(solId, c), (c) => fetchOne(solId, c));
  if (!fit.ok) return { ok: false, why: `hero's ${want} is not on the tree he was asked on (${fit.why}) — pinned as played` };
  const got = wagerBb(fit.labels[last]!)!;
  // (the loose match takes nothing past its 5% / 0.15bb tolerance; kept as a guard on what is read as hero's size)
  if (!(Math.abs(got - want) <= Math.max(0.05 * want, 0.15))) {
    return { ok: false, why: `hero's ${want} is ${got} on the tree he was asked on — too far to be his size played — pinned as played` };
  }
  const r = (x: number) => String(Math.round(x * 100) / 100);
  return { ok: true, labels: fit.labels, played, want, got,
    note: `hero's ${r(want)} read as the tree's ${r(got)} — the tree he was asked on (pinned [${levels.join(",")}]) is kept, not re-created` };
}

// ── retree consistency (2026-10-08) ─────────────────────────────────────────────────────────────────────────────
/**
 * ONE TREE PER STREET, AND A RE-TREE THAT IS THE SAME TREE PLUS ONE SIZE (2026-10-08, Brady: "one tree; if we need to
 * re-tree, from the original tree up to the point of disagreement capture EVERYTHING including menu bet sizes, recreate
 * the new tree with the same details, add the bet size we didn't have, and loop"). Register: services/approximations.ts
 * `retree-consistency`. Switch HERO_STREET_AS_ANSWERED=on (unset) | off (the rule before), read at every decision.
 *
 * THE DEFECT (stress core-bvb-007, solves 7733 / 7734): heads-up turn, hero SB Qc8c first. Tree A (the street's
 * size-free tree, AUTOMATIC) offered him CHECK / BET 20.5 and he checked Qc8c 100%. The BB bet 7.5, not on A's menu, so
 * the street was re-solved as tree B with ONLY the BB's 7.5 pinned; hero's own seat went AUTOMATIC again and GTO Wizard
 * gave him CHECK / BET 3.8 there — under which he BETS Qc8c 99.6%. The walk read his check on B: Qc8c kept 0.004 of its
 * weight, hero's weight at his facing node was 0.000 and the mix served was for a hand the model does not hold. Live
 * since 09-21: 5 of ~2,500 postflop walks had hero under 1e-3 at his node (one, answer 13033, an ALLIN executed).
 *
 * TWO PARTS, both under the switch:
 *  1. THE MENUS ARE CARRIED (retreeInputs): a street pinned with the wagers played is built from the tree before the
 *     disagreement — the size-free tree for the first wager off it, the previous re-tree for the next (the loop) — seat by
 *     seat: a FIXED seat's lists as sent, an AUTOMATIC seat's sizes as GTO Wizard resolved them at that tree's nodes up to
 *     the point of disagreement (read from the cache, never a request), and the played size ADDED to its actor's level.
 *     Heads-up and three-way (Brady 2026-10-08: "do the 3-way too"): a three-seat tree's seats are FIXED, so each keeps
 *     its 33% / 75% | 60% (+ its all-in) as sent and only the actor gains the amount — never the played amount alone.
 *  2. HERO'S EARLIER ACTIONS ON THE STREET ARE NARROWED BY THE STRATEGY HE WAS ANSWERED WITH (answeredHeroNode): at a node
 *     where hero acted earlier on this street, on a tree that is not the one his decision there was read on, his range is
 *     multiplied by that answer's strategy for the action he took, not the new tree's. Villains keep the new tree's.
 *     The order (2026-10-08, served-strategy narrowing): (1) the node he was answered on in THIS walk's plan; (2) else the
 *     mix he was SERVED for that action (servedStrategy — the blend over the plans it was read on, or its one tree's
 *     node; live 11381: answered on merge:CO+BTN, walked on ghost:BTN); (3) else, nothing of that answer kept, this tree's.
 */
export const heroStreetAsAnsweredOn = (env: Record<string, string | undefined> = process.env): boolean =>
  String(env.HERO_STREET_AS_ANSWERED ?? "on").trim().toLowerCase() !== "off";

/** One hero node as it was ANSWERED: the tree it was read on and its actions with their full strategies. */
export interface AnsweredHeroNode {
  solId: string;
  actions: { action: { code: string; betsize: number | string | null; display_name: string; type?: string; allin?: boolean }; strategy: ArrayLike<number> }[];
  /** where it came from: this process's walk, or a stored answer's trace (solves table row, strategies to 4 dp) */
  src: "memory" | "store";
  solveRow?: number;
  at: number;
}
/** the decision a hero node belongs to: hand, plan, first street, the street, every earlier street's tokens, and the
 *  tokens on this street before hero's node */
export interface AnsweredAt { handKey: string; plan: string | null; first: number; k: number; earlier: string[][]; prefix: string[] }
const ANSWERED_MAX = 300;
const answeredNodes = new Map<string, AnsweredHeroNode>();
export const answeredKeyOf = (a: AnsweredAt): string => JSON.stringify([a.handKey, a.plan, a.first, a.k, a.earlier, a.prefix]);

function rememberAnswered(key: string, node: AnsweredHeroNode): void {
  answeredMisses.delete(key);
  answeredNodes.delete(key);
  answeredNodes.set(key, node);
  while (answeredNodes.size > ANSWERED_MAX) {
    const first = answeredNodes.keys().next().value;
    if (first === undefined) break;
    answeredNodes.delete(first);
  }
}
/** tests: forget every answered hero node (a restart) */
export function dropAnsweredNodes(): void { answeredNodes.clear(); answeredMisses.clear(); }

/** A stored answer's trace, read back as the hero node it answered (the solves table — after a restart). */
function answeredFromStore(a: AnsweredAt): AnsweredHeroNode | null {
  if (!isDurableKey(a.handKey)) return null;
  const want = STREET[a.k]!.toLowerCase();
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((t, i) => t === y[i]);
  // newest first, the live answers before anything else (a dashboard replay of the hand writes rows of its own)
  const rows = solveStore.forHand(a.handKey).filter((r) => r.ok && r.street === want).reverse()
    .sort((x, y) => Number(x.origin !== "live") - Number(y.origin !== "live"));
  for (const r of rows) {
    const got = solveStore.get(r.id);
    const sp = got?.trace?.spec as AiChainSpec | undefined;
    if (!sp || (sp.planTag ?? null) !== a.plan || (sp.firstStreet ?? 0) !== a.first) continue;
    const st = sp.streets ?? [];
    if (st.length !== a.earlier.length + 1 || !a.earlier.every((t, i) => same(t, st[i] ?? [])) || !same(st[st.length - 1] ?? [], a.prefix)) continue;
    const nodes: ChainTraceNode[] = got!.trace.nodes ?? [];
    const hero = [...nodes].reverse().find((x) => x.heroNode);
    const street = (got!.trace.streets ?? []).find((x: { si: number }) => x.si === hero?.si);
    if (!hero || !street?.solId) continue;
    return {
      solId: String(street.solId), src: "store", solveRow: r.id, at: r.ts,
      actions: hero.actions.map((x) => ({ action: { code: x.code, betsize: x.betsize, display_name: x.name }, strategy: x.strategy })),
    };
  }
  return null;
}

/** The hero node his decision at this point of the street was answered on: this process's record, else the stored
 *  answer's trace (solves table). Null when neither has it. */
export function answeredHeroNode(a: AnsweredAt): AnsweredHeroNode | null {
  const key = answeredKeyOf(a);
  const hit = answeredNodes.get(key);
  if (hit) return hit;
  // the store is read once per point of a hand in a process: a miss there is remembered (this process records every
  // later answer in memory, which is looked at first)
  if (answeredMisses.has(key)) return null;
  try {
    const st = answeredFromStore(a);
    if (st) rememberAnswered(key, st);
    else {
      answeredMisses.add(key);
      if (answeredMisses.size > ANSWERED_MAX * 2) answeredMisses.delete(answeredMisses.values().next().value as string);
    }
    return st;
  } catch {
    return null;   // the store is a fallback: a read that fails costs the correction, never the answer
  }
}
const answeredMisses = new Set<string>();

/** Record the node hero is being answered on (the walk, at his node). */
export function recordAnsweredHeroNode(a: AnsweredAt, solId: string, data: any): void {
  const sols: any[] = data?.action_solutions ?? [];
  if (!sols.length) return;
  rememberAnswered(answeredKeyOf(a), {
    solId, src: "memory", at: Date.now(),
    actions: sols.map((x) => ({
      action: { code: String(x.action?.code ?? ""), betsize: x.action?.betsize ?? null, display_name: String(x.action?.display_name ?? "?"), type: x.action?.type, allin: x.action?.allin },
      strategy: Float32Array.from(x.strategy ?? []),
    })),
  });
}

/** tests and offline walks: forget the answered hero nodes recorded under one hand key (a replay's seeds, when it ends) */
export function forgetAnsweredHeroNodes(handKey: string): void {
  for (const key of [...answeredNodes.keys()]) if ((JSON.parse(key) as unknown[])[0] === handKey) answeredNodes.delete(key);
  for (const key of [...answeredMisses]) if ((JSON.parse(key) as unknown[])[0] === handKey) answeredMisses.delete(key);
}

/**
 * SEED AN OFFLINE WALK'S HERO NARROWING FROM A STORED TRACE (2026-10-14; the hero-floor A/B harness first, the replay
 * check since the audit's finding 6). A live walk narrows hero's earlier action by the strategy he was ANSWERED with on
 * another tree, or SERVED on another plan (heroAnswered above) — state of the hand's key that a walk under a fresh key
 * cannot produce: with nothing recorded it narrows by the walking tree's own node, and hero's range entering the next
 * street is not the live one (replay_checks 2026-10-14: all 16 range-weight fails were hero's seat — 8441 /
 * 4923565359 turn SB 210.08 live vs 105.15 replayed). Every trace node that carries a `heroAnswered.strategy` (4 dp)
 * is recorded under `handKey` as the node his action there was answered on (one action: the one he took), unless the
 * key already answered that point; the walk then narrows by it, as live. `checkpoint`: seed the nodes the live walk
 * took from the hand's checkpoint too (a replay walks every street from the root under its own key; the A/B harness
 * walks the hand decision by decision and has answered them itself). Returns how many were seeded.
 */
export function seedAnsweredHeroNodes(trace: Pick<ChainTrace, "spec" | "nodes">, handKey: string, opts: { checkpoint?: boolean } = {}): number {
  const sp = trace.spec;
  const first = sp.firstStreet ?? 0;
  let seeded = 0;
  for (const n of trace.nodes ?? []) {
    const ha = n.heroAnswered;
    if (!ha?.strategy || n.taken == null || (n.fromCheckpoint && !opts.checkpoint)) continue;
    const at: AnsweredAt = { handKey, plan: sp.planTag ?? null, first, k: n.si + first, earlier: sp.streets.slice(0, n.si), prefix: (sp.streets[n.si] ?? []).slice(0, n.ti) };
    if (answeredHeroNode(at)) continue;
    const taken = n.actions[n.taken];
    if (!taken) continue;
    recordAnsweredHeroNode(at, `seed:${ha.src}:${ha.solId}`, { action_solutions: [{ action: { code: taken.code, display_name: taken.name, betsize: taken.betsize ?? "" }, strategy: ha.strategy }] });
    seeded++;
  }
  return seeded;
}

/** A wager as GTO Wizard's % of the pot (its betsize_by_pot) — the % a FIXED raise list takes. */
const pctOfPot = (x: unknown): string | null => {
  const v = Number(x);
  return Number.isFinite(v) && v > 0 ? `${Math.round(v * 1000) / 10}%` : null;
};

/**
 * THE MENUS GTO WIZARD RESOLVED on a solved tree, seat by seat and level by level, along the street's line up to and
 * including node `upTo` (the point of disagreement: the node where the size that is not on the tree was played). Read
 * from the cache only (`peek`), stopping at the first node it does not hold. A level's sizes: the bet as its amount, a
 * raise as GTO Wizard's % of the pot; the all-in is left out (a FIXED list always carries its seat's own).
 */
export function resolvedMenus(labels: string[], actors: number[], upTo: number, stack: number, peek: (codes: string) => any | null): Map<number, (string[] | null)[]> {
  const out = new Map<number, (string[] | null)[]>();
  const codes: string[] = [];
  let level = 0;
  for (let t = 0; t <= upTo && t < labels.length; t++) {
    const node = peek(codes.join("-"));
    const sols: any[] = node?.action_solutions ?? [];
    if (!sols.length) break;
    const actor = actors[t]!;
    const lv = Math.min(level, 3);
    const wagers = sols.filter((x) => { const kd = actionKindOf(x); return (kd === "Bet" || kd === "Raise") && !x.action?.allin; });
    const sizes = wagers.map((x) => (lv === 0 ? bbAmount(Number(x.action?.betsize)) : pctOfPot(x.action?.betsize_by_pot))).filter((x): x is string => !!x);
    const lists = out.get(actor) ?? [null, null, null, null];
    if (lists[lv] == null) lists[lv] = [...new Set(sizes)];
    out.set(actor, lists);
    if (t === upTo) break;
    const ai = matchWalkAction(labels[t]!, sols, stack);
    if (ai < 0) break;
    codes.push(String(sols[ai]!.action?.code ?? ""));
    if (/\(/.test(labels[t]!)) level++;
  }
  return out;
}

/** What a re-tree carried, for the answer's note: the tree carried from, each seat's source, the sizes added. */
export interface RetreeCarry { from: string | null; seats: ("sent" | "resolved" | "auto")[]; added: PlayedWager }

/**
 * THE TREE FOR A STREET PINNED WITH `played` (the street's first `played.length` wagers, in label order), built by the
 * loop: tree 0 is `base` (the size-free tree); tree j carries tree j−1's menus (as sent / as GTO Wizard resolved them at
 * its nodes up to wager j) with wager j added to its actor's level. Heads-up and three-way (`base.huGrid` → today's
 * pinned input). Pure over its getters.
 */
export function retreeInputs(a: {
  base: CustomTreeInput; played: PlayedWager[]; labels: string[]; actors: number[]; stack: number;
  build: (input: CustomTreeInput) => any;
  peekSolution: (input: CustomTreeInput) => string | null;
  peekNode: (solId: string, codes: string) => any | null;
}): { input: CustomTreeInput; carry: RetreeCarry | null } {
  const street = (a.base.startingStreet ?? "FLOP") as "FLOP" | "TURN" | "RIVER";
  const plain = { ...a.base, played: { [street]: a.played } } as CustomTreeInput;
  if (!a.played.length || a.base.huGrid) return { input: plain, carry: null };
  const wagerAt: number[] = [];
  a.labels.forEach((l, i) => { if (/\(/.test(l)) wagerAt.push(i); });
  let prev: CustomTreeInput = a.base;
  let last: RetreeCarry | null = null;
  /** the trees of the loop that are solved (in the cache), newest first: an AUTOMATIC seat's sizes are read on the
   *  newest one whose nodes reach the point of disagreement — a tree of the loop that was never solved (its wager was on
   *  the tree before it) leaves its seats to the tree before */
  const solved: string[] = [];
  for (let j = 1; j <= a.played.length; j++) {
    const body = a.build(prev);
    const entry: any[] = body?.bet_sizes?.street_bet_sizes?.find((x: any) => x.street === street)?.position_bet_sizes ?? [];
    const sol = a.peekSolution(prev);
    if (sol) solved.unshift(sol);
    const upTo = wagerAt[j - 1] ?? -1;
    const resolved = new Map<number, (string[] | null)[]>();
    if (upTo >= 0) {
      for (const s of solved) {
        for (const [seat, lists] of resolvedMenus(a.labels, a.actors, upTo, a.stack, (c) => a.peekNode(s, c))) {
          const have = resolved.get(seat) ?? [null, null, null, null];
          resolved.set(seat, have.map((x, lv) => x ?? lists[lv] ?? null));
        }
      }
    }
    const seats: (CarriedSeat | null)[] = entry.map((p, i) => {
      if (p?.type === "FIXED") {
        return { from: "sent" as const, lists: [p.bet_sizes, p.raise_sizes, p.second_raise_sizes, p.third_plus_raise_sizes].map((x: unknown) => (Array.isArray(x) ? x.map(String) : null)) };
      }
      const r = resolved.get(i);
      return r && r.some((x) => x != null) ? { from: "resolved" as const, lists: r } : null;
    });
    const carry: CarriedMenus | null = seats.some((x) => x) ? { street, seats } : null;
    prev = { ...a.base, played: { [street]: a.played.slice(0, j) }, ...(carry ? { carry } : {}) };
    last = carry ? { from: solved[0] ?? null, seats: seats.map((x) => (x ? x.from : "auto")), added: a.played[j - 1]! } : null;
  }
  return { input: prev, carry: last };
}

/** The tag every re-tree line of an answer opens with (approximations: retree-consistency). */
export const RETREE_NOTE_TAG = "RE-TREE:";

/**
 * The answer's "RE-TREE:" lines, one per street walked on this call that was re-solved with its menus carried or on
 * which hero's earlier action was narrowed by his answered strategy: "RE-TREE: turn re-solved with BB's 7.5bb added;
 * menus carried from tree #febb2f11; hero's CHECK narrowed by his answered strategy (his hand 1 there, 0.004 here)".
 */
export function retreeNotesOf(trace: Pick<ChainTrace, "streets" | "nodes"> & Partial<Pick<ChainTrace, "spec">>, _narrowed?: readonly HeroAnswered[]): string[] {
  const out: string[] = [];
  for (const s of trace.streets) {
    if (s.fromCheckpoint) continue;
    const name = s.street.toLowerCase();
    const narrowed = trace.nodes.filter((x) => x.si === s.si && !x.fromCheckpoint && x.heroAnswered?.strategy);
    // A MISS IS SAID TOO (2026-10-10, the failed-lock review): his action was not on the node he was answered on, so this
    // tree's own strategy narrowed it — before, the note read as if every earlier action had been narrowed as answered
    const missed = trace.nodes.filter((x) => x.si === s.si && !x.fromCheckpoint && !x.heroAnswered?.strategy && x.heroAnswered?.miss);
    if (!s.retree && !narrowed.length && !missed.length) continue;
    const parts: string[] = [];
    const w = s.retree?.added ?? (s.played?.length ? s.played[s.played.length - 1] : null);
    const seat = w ? s.players?.[w.seat] ?? `seat ${w.seat}` : null;
    if (s.retree) {
      parts.push(`${name} re-solved with ${seat}'s ${bbAmount(w!.to)} added`);
      parts.push(s.retree.from ? `menus carried from tree #${s.retree.from.replace(/^gc:/, "").slice(0, 8)}` : "menus carried as sent (no earlier tree's nodes in the cache)");
    } else if (w) {
      parts.push(`${name} re-solved with ${seat}'s ${bbAmount(w.to)} pinned${(s.players?.length ?? 2) > 2 ? " (three seats: the menus are FIXED already)" : ""}`);
    } else {
      parts.push(`${name} walked on a tree other than the one hero was answered on`);
    }
    for (const x of narrowed) {
      const h = x.heroAnswered!;
      if (h.src === "served" && h.served) {
        // no node of this plan answered it: the mix he was served (servedStrategy) — say which plans it came from
        const sv = h.served;
        const here = trace.spec?.firstStreet ?? 0;
        // where each tree starts is said only when it differs (a re-root on one side)
        const rooted = (first: number) => (sv.first !== here ? ` (rooted at the ${STREET[first]!.toLowerCase()})` : "");
        const from = `${sv.blended ? `the blend of ${sv.plans.map((p) => p ?? "one tree").join(" + ")}` : sv.plans[0] ?? "one tree"}${rooted(sv.first)}`;
        const to = `${sv.plan ?? "one tree"}${rooted(here)}`;
        // the same plan whose answered node this walk does not reach (the line before it read otherwise): said as such
        const how = from === to ? `answered on ${from}, a node this walk does not reach` : `plan changed: ${from} → ${to}`;
        parts.push(`hero's ${h.action.toUpperCase()} narrowed by the mix he was served (${how}` +
          (h.combo ? `; his hand ${h.combo.answered} in that mix, ${h.combo.tree} on this tree` : "") + ")");
        continue;
      }
      parts.push(`hero's ${h.action.toUpperCase()} narrowed by his answered strategy` +
        (h.combo ? ` (his hand ${h.combo.answered} on the tree he was answered on, ${h.combo.tree} on this one)` : ""));
    }
    for (const x of missed) parts.push(`hero's ${String(x.heroAnswered!.action).toUpperCase()} NOT narrowed as answered: ${x.heroAnswered!.miss}`);
    out.push(`${RETREE_NOTE_TAG} ${parts.join("; ")}`);
  }
  return out;
}

/** The switches that change what the chain sends or carries, with the value in effect — each spelt as its own env
 *  variable takes it, so a replay that sets process.env from this record walks under the same rules. Recorded on every
 *  trace (ChainTrace.policy). A new switch that changes ranges or trees belongs here. */
export const WALK_POLICY_KEYS = ["HERO_CLASS_FLOOR", "HERO_STREET_AS_ANSWERED", "OFFTREE_RANGE", "OFFTREE_BLEND_W", "OFFTREE_RANGE_T", "OFFTREE_MAX_HAND",
  "OFFTREE_LOCK", "OFFTREE_LOCK_FALLBACK", "HU_FIXED_MENU", "THREEWAY_MENU", "MENU_POT"] as const;
export function walkPolicy(): Record<string, string> {
  const maxHand = offTreeMaxHand();
  return {
    HERO_CLASS_FLOOR: heroClassFloorMode(), HERO_STREET_AS_ANSWERED: heroStreetAsAnsweredOn() ? "on" : "off",
    OFFTREE_RANGE: offTreeRangeMode(), OFFTREE_BLEND_W: String(offTreeBlendW()), OFFTREE_RANGE_T: String(offTreeSoftT()),
    OFFTREE_MAX_HAND: Number.isFinite(maxHand) ? String(maxHand) : "", OFFTREE_LOCK: offTreeLockOn() ? "on" : "off", OFFTREE_LOCK_FALLBACK: offTreeLockFallbackOn() ? "on" : "off",
    HU_FIXED_MENU: huMenuMode(), THREEWAY_MENU: threeWayMenuMode(), MENU_POT: menuPotMode(),
  };
}

export async function solveAiChain(spec: AiChainSpec): Promise<AiChainResult> {
  const trace: ChainTrace = { spec, policy: walkPolicy(), streets: [], nodes: [], result: { ok: false } };
  const sizeSnaps: string[] = [];
  /** hero's earlier actions on a street narrowed by his answered strategy on this call (retree-consistency) */
  const heroNarrowed: HeroAnswered[] = [];
  const fail = (why: string): AiChainResult => { trace.result = { ok: false, why }; return { ok: false, why, trace }; };
  const cards = spec.board.match(/.{2}/g) ?? [];
  if (cards.length < 3) return fail(`board too short ("${spec.board}")`);
  const first = spec.firstStreet ?? 0;
  if (spec.streets.length < 1 || spec.streets.length + first > 3) {
    return fail(`need 1-3 streets, got ${spec.streets.length}`);
  }
  if (cards.length < 2 + first + spec.streets.length) {
    return fail("board has fewer cards than streets walked");
  }
  const threeWay = spec.midPos != null && spec.midRange != null;
  if (spec.heroSeat === "mid" && !threeWay) return fail("hero is the middle seat but the spec has no middle seat");

  // Seats in acting order. Folds remove a seat for the rest of the hand.
  type Seat = { pos: string; label: SeatLabel; range: number[] };
  let seats: Seat[] = [
    { pos: spec.oopPos, label: "oop", range: spec.oopRange.slice() },
    ...(threeWay ? [{ pos: spec.midPos!, label: "mid" as const, range: spec.midRange!.slice() }] : []),
    { pos: spec.ipPos, label: "ip", range: spec.ipRange.slice() },
  ];
  const heroPos = seats.find((s) => s.label === spec.heroSeat)!.pos;
  let pot = spec.flopPot;
  let stack = spec.flopStack;
  // each seat's own stack behind (spec.seatStacks), rolled with its own chips — see the street close below
  let behind: Record<string, number> | null = spec.seatStacks
    ? Object.fromEntries(seats.filter((s) => spec.seatStacks![s.pos] != null).map((s) => [s.pos, spec.seatStacks![s.pos]!]))
    : null;
  /** where a street's stack was re-derived from the seats still in (the answer says so) */
  const stackNotes: string[] = [];
  let solves = 0;
  const walked: string[] = [];
  /** fingerprint of the ranges the last closed street handed on, as this call saw it (a checkpoint's, or a close here) */
  let prevOut: string | null = null;

  // START FROM THE HAND'S CHECKPOINT when one fits: the deepest closed street before the decision street whose
  // content key — the chain's root plus every street's tokens up to it (see rootKeyOf / exitKeyOf) — is in the memo.
  let startSi = 0;
  const handKey = spec.handKey || null;
  const plan = spec.planTag ?? null;
  const rootKey = handKey ? rootKeyOf(spec, seats, first, cards) : null;
  /** exitKeys[si] = the key of what leaves street si as the capture reads it now (streets before the decision street) */
  const exitKeys: string[] = [];
  if (rootKey) {
    let prev = rootKey;
    for (let si = 0; si < spec.streets.length - 1; si++) {
      prev = exitKeyOf(prev, spec.streets[si]!, cards.slice(0, 3 + si + first).join(""), spec.streetAmounts?.[si]);
      exitKeys.push(prev);
    }
  }
  const entryKeyAt = (si: number): string => (si === 0 ? rootKey! : exitKeys[si - 1]!);
  /** what this hand's ledger says was walked before (services/handFacts) — how a re-walk is told from a first walk */
  /** the hand whose facts this walk reads and writes (none for a checkpoint-only walk) */
  const factsKey = spec.checkpointOnly ? null : handKey;
  const records = factsKey ? handFacts.streets(factsKey) : [];
  if (rootKey) {
    for (let si = exitKeys.length - 1; si >= 0; si--) {
      const cp = checkpoints.get(exitKeys[si]!);
      if (!cp) continue;
      seats = cp.seats.map((s) => ({ ...s, range: s.range.slice() }));
      pot = cp.pot;
      stack = cp.stack;
      behind = cp.behind ? { ...cp.behind } : null;
      prevOut = cp.out ?? null;
      stackNotes.push(...(cp.stackNotes ?? []));
      walked.push(...cp.walked);
      // the streets' records say how they were walked when they closed (history); on THIS call they are memo hits
      trace.streets.push(...cp.streets.map((s) => ({ ...s, fromCheckpoint: true, prov: { how: "hit" as const }, leak: null })));
      trace.nodes.push(...cp.nodes.map((x) => ({ ...x, fromCheckpoint: true })));
      startSi = si + 1;
      const note = `ranges leaving the ${STREET[cp.k]!.toLowerCase()} taken from this hand's checkpoint (walked ${((Date.now() - cp.at) / 1000).toFixed(0)} s ago) — ${si + 1} earlier street${si ? "s" : ""} not re-computed`;
      trace.checkpoint = { from: STREET[cp.k]!, streetsReused: si + 1, note };
      tmark("chain checkpoint", note);
      break;
    }
    if (!startSi && spec.streets.length > 1) {
      // say WHY nothing fit, from the ledger: the capture re-read an earlier street, or the ranges arrived differently
      const mismatches: string[] = [];
      for (let si = 0; si < exitKeys.length && !mismatches.length; si++) {
        const k = si + first;
        const mine = records.filter((r) => r.kind === "closed" && r.k === k && r.first === first && (r.plan ?? null) === plan);
        const sameEntry = mine.filter((r) => r.entry === entryKeyAt(si));
        const differs = sameEntry.find((r) => !sameToks(r.tokens, spec.streets[si]!));
        if (differs) mismatches.push(`the ${STREET[k]!.toLowerCase()} was [${differs.tokens.join(",")}] when walked, the capture now says [${spec.streets[si]!.join(",")}]`);
        else if (sameEntry.length) mismatches.push(`the ${STREET[k]!.toLowerCase()} was walked under these very inputs and its checkpoint is gone (API restart or memo eviction)`);
        else if (mine.length) mismatches.push(`the ranges, pot or stack entering the ${STREET[k]!.toLowerCase()} changed since it was walked`);
      }
      const note = mismatches.length
        ? `checkpoint NOT reusable — ${mismatches.join("; ")} — the earlier streets are walked again`
        : "no checkpoint for this hand yet (first walk past its opening street in this process)";
      trace.checkpoint = { from: null, streetsReused: 0, note };
      tmark("chain checkpoint", note);
    }
  }
  // …and the street after the last closed one may resume from hero's LAST node on it (PartialCheckpoint), keyed by
  // that street's ENTRY key, when the capture still begins with the tokens walked then.
  let resume: PartialCheckpoint | null = null;
  /** a resume point existed for this street's entry but the capture no longer starts with its prefix */
  let partialRejected: string | null = null;
  if (rootKey && startSi < spec.streets.length) {
    const pc = partials.get(entryKeyAt(startSi));
    if (pc && pc.k - first === startSi) {
      const prefix = pc.tokens[startSi] ?? [];
      const now = spec.streets[startSi] ?? [];
      if (prefix.length <= now.length && prefix.every((t, i) => t === now[i])) resume = pc;
      else {
        partialRejected = `the capture's ${STREET[pc.k]!.toLowerCase()} no longer starts with [${prefix.join(",")}] (now [${now.join(",")}])`;
        tmark("chain checkpoint", `mid-${STREET[pc.k]!.toLowerCase()} checkpoint not reusable: ${partialRejected}`);
      }
    }
  }
  const fetched = handKey ? (fetchedByHand.get(handKey) ?? new Set<string>()) : null;
  if (handKey && fetched) { fetchedByHand.delete(handKey); fetchedByHand.set(handKey, fetched); bounded(fetchedByHand, HAND_INDEX_MAX); }

  for (let si = startSi; si < spec.streets.length; si++) {
    const k = si + first;   // the street's real index (re-rooted chains start past the flop)
    const streetBoard = cards.slice(0, 3 + k).join("");
    const toks = spec.streets[si]!;
    const isLast = si === spec.streets.length - 1;
    const resuming = resume && si === startSi ? resume : null;
    // A SEAT WITH NOTHING BEHIND IS NOT A TREE SEAT (2026-10-03): it is all-in, it has no decision, its chips are in the
    // pot. The street close drops it; a seat that ENTERS the walk with nothing behind is dropped here the same way
    // (a zero-stack seat is never sent to GTO Wizard).
    if (!resuming && behind) {
      const broke = seats.filter((s) => behind![s.pos] != null && behind![s.pos]! <= 0.005);
      if (broke.some((s) => s.pos === heroPos)) return fail("hero is all-in — no decision left to solve");
      if (broke.length && seats.length - broke.length < 2) return fail("every other player still in is all-in — no decision left to solve");
      if (broke.length) {
        seats = seats.filter((s) => !broke.includes(s));
        stackNotes.push(`${STREET[k]!.toLowerCase()}: ${broke.map((s) => s.pos).join(", ")} all-in before the street — left out of the tree, chips in the pot`);
      }
    }
    // what this street starts from, fingerprinted BEFORE hero's floor (the previous street handed on exactly this); a
    // resumed street started on an earlier decision, and its checkpoint carries the fingerprint taken then
    const startedFp: string | null = resuming ? (resuming.inFp ?? null) : rangesFp(seats);
    if (resuming) seats = resuming.entering.map((s) => ({ ...s, range: s.range.slice() }));
    // THE SEAT COUNT IS THE SEATS THE STREET IS WALKED WITH (2026-10-04, hand 4922269408: HTTP 500 on hero's turn). It
    // was taken before the resume put the checkpoint's seats back: a seat dropped as all-in when the street was first
    // walked (the CO, all-in preflop for 13.4 by a "raise") is not dropped again on a resume (the filter above is for a
    // fresh walk), so n said 3 for the 2 seats the street resumed with — `seats[n - 1]` was undefined and every re-ask of
    // that decision threw.
    const n = seats.length;
    const heroIdx = seats.findIndex((s) => s.pos === heroPos);
    if (heroIdx < 0) return fail("hero is no longer in the hand — nothing to solve");
    if (n < 2) return fail("only one player left in the hand — no decision to solve");

    // Keep hero's actual combo alive in his own entering range: conditioning
    // multiplies weights by equilibrium frequencies, and a hero who took a
    // low-frequency line earlier would otherwise vanish from his own range —
    // leaving no strategy to read at his node.
    // THE FLOOR COVERS HERO'S WHOLE HAND CLASS, NOT ONE COMBO (2026-09-17). GTO Wizard rejects beliefs that
    // break suit isomorphism on the street's board ("Provided beliefs don't respect suit isomorphism"): lifting
    // 8c7c alone while 8h7h stays at the chart's weight is exactly that when clubs and hearts are interchangeable
    // on Ad9s6d. It surfaced with the 6-max charts, whose 2-4% mixes put hero's class under the floor often
    // (3 of the first 30 postflop spots). Lifting every unblocked combo of the class is suit-symmetric by
    // construction and changes villain's picture of hero by a rounding error.
    /** hero's combo weight BEFORE the floor (#2 says when the floor lifted it); unknown on a resumed street */
    const heroBefore = !resuming && spec.heroComboIdx != null ? (seats[heroIdx]!.range[spec.heroComboIdx] ?? 0) : null;
    // THE LIFT IS THE MODE'S (HERO_CLASS_FLOOR, 2026-10-14 — applyHeroClassFloor above): abs = 0.05, today's, the default;
    // rel5 / rel1 = a share of his heaviest live combo; none = an epsilon. Recorded on the street (`heroFloor`).
    let heroFloor: HeroFloorRecord | null = null;
    if (spec.heroComboIdx != null) {
      const boardIdx = new Set(cards.slice(0, 3 + k).map(cardIdx));
      heroFloor = applyHeroClassFloor(seats[heroIdx]!.range, spec.heroComboIdx, boardIdx, heroClassFloorMode());
    }

    /** the seats as they enter the street, post-floor — what the tree is keyed on and what a mid-street checkpoint restores */
    const entering = seats.map((s) => ({ ...s, range: s.range.slice() }));
    // #2 RANGES SANE (services/chainChecks), on exactly what the tree is asked to solve
    const saneCheck = guardCheck(2, () => checkRangesSane({ seats: entering, heroIdx, heroCombo: spec.heroComboIdx, heroBefore, board: cards.slice(0, 3 + k) }));

    // EACH SEAT'S OWN STACK BEHIND entering the street (2026-10-03): what the tree is sent for that seat, the most it can
    // put in on the street, and what its all-in is. A seat whose stack is not known keeps the tree's one stack.
    // A SEAT WHOSE STACK IS NOT KNOWN is never capped below what the street shows it can put in (2026-10-03, review): it
    // gets the tree's one stack, lifted to the street's largest wager — an unknown stack must not make a legal raise
    // illegal (StreetState would refuse it, and the old code served the spot).
    const seenTo = Math.max(0, ...toks.map((t, i) => (/^R[\d.]+$/.test(t) ? parseFloat(t.slice(1)) : t === "RAI" ? (spec.streetAmounts?.[si]?.[i] ?? 0) : 0)));
    const caps = seats.map((s) => r2(behind?.[s.pos] ?? Math.max(stack, seenTo)));
    // Engine labels for this street's tokens (Bet vs Raise by outstanding wager), and who acts on each. An all-in (RAI)
    // is the ACTOR's all-in: the table's amount beside the token (spec.streetAmounts), never more than the actor has.
    let labels: string[];
    let actors: number[];
    const amounts = spec.streetAmounts?.[si] ?? [];
    try {
      let tokActors = actorsOfTokens(toks, n, caps, amounts);
      // THE TABLE'S ALL-IN IS THE SEAT'S STACK: a seat that went all-in on this street for A had exactly A behind
      // entering it (a raise-to is the street's total). Where our reading of its stack says otherwise, the table wins —
      // the tree is sent the stack the shove proves, and the answer says so.
      let fixedCap = false;
      toks.forEach((t, i) => {
        const a = amounts[i];
        if (t !== "RAI" || a == null || !(a > 0)) return;
        const seat = tokActors[i]!;
        if (Math.abs((caps[seat] ?? a) - a) > 0.02) {
          stackNotes.push(`${STREET[k]!.toLowerCase()}: ${seats[seat]!.pos} went all-in for ${r2(a)}bb — the tree has that stack, not the ${caps[seat]}bb read`);
          caps[seat] = r2(a);
          if (behind) behind[seats[seat]!.pos] = r2(a);
          fixedCap = true;
        }
      });
      if (fixedCap) tokActors = actorsOfTokens(toks, n, caps, amounts);
      labels = wagerLabelForWalk(toks, stack, (i) => Math.min(amounts[i] ?? Infinity, caps[tokActors[i]!] ?? Infinity));
      const cov = coveringAllIns(labels, n, caps, seats.map((s) => behind?.[s.pos] != null));
      labels = cov.labels;
      for (const x of cov.notes) sizeSnaps.push(`${STREET[k]!.toLowerCase()}: ${x}`);
      actors = actorsOf(labels, n, caps);
    } catch (e) {
      return fail(`tokens: ${e instanceof Error ? e.message : e}`);
    }
    /** the street's actions AS CAPTURED — `labels` may be rewritten onto a cached tree's sizes below (#6 compares) */
    const captured = labels.slice();
    /** #4: nodes whose GTO Wizard seat-to-act was compared with the rotation (a disagreement stops the walk) */
    let seatAgreed = 0, seatUnnamed = 0;
    let heroNodeSaid: string | null = null;
    const origin = currentRequestScope()?.origin ?? null;

    const nodeSrc: { cache: number; joined: number; fetched: number; fetchMs: number; store?: number } = { cache: 0, joined: 0, fetched: 0, fetchMs: 0 };
    const nodeLeaks: string[] = [];
    // every node read is accounted for: the cache it came from, or how long its poll took
    const readNode = async (solId: string, codesStr: string, clockMs?: number): Promise<WalkRead> => {
      const t = Date.now();
      // the node clock: 12 s heads-up, 15 s on a 3-player tree (menu C, 2026-10-08 — gtowApi.postflopNodeTimeoutMs)
      // a hung poll with a cold tree's cost still on the clock comes back `hung` (gtowApi, the hung-poll bound): the walk
      // hedges (or re-posts) the tree on another account below. `clockMs`: a read on a clock of its own (the late lock's
      // fallback, the hedge's two reads) — such a read never comes back `hung`, it polls its solve to the clock.
      const r = await gtowApi.customNode(solId, { [QKEY[k]!]: codesStr, board: streetBoard }, clockMs ?? postflopNodeTimeoutMs(n), "walk", clockMs == null ? { repostMs: coldTreeMs(n) } : {});
      const ms = Date.now() - t;
      const src: NodeSource | "failed" = r.ok ? (r.src ?? (r.cached ? "cache" : "fetched")) : "failed";
      if (src === "fetched" && fetched) {
        const id = `${solId}|${k}|${codesStr}`;
        if (fetched.has(id)) nodeLeaks.push(`node [${codesStr || "root"}] fetched again from GTO Wizard — this hand had already read it`);
        fetched.add(id);
      }
      if (src === "cache") { nodeSrc.cache++; if (r.ok && r.store) nodeSrc.store = (nodeSrc.store ?? 0) + 1; }
      else if (src === "joined") { nodeSrc.joined++; nodeSrc.fetchMs += ms; }
      else if (src === "fetched") { nodeSrc.fetched++; nodeSrc.fetchMs += ms; }
      if (src !== "cache") {
        tspan(`chain ${STREET[k]} node [${codesStr || "root"}] ${src}`, t, r.ok ? `solution ${solId.slice(0, 8)}` : r.error.slice(0, 120));
      }
      return { r, src, ms };
    };

    // The size-free tree for this street: the fixed menu heads-up (HU_FIXED_MENU: F 25/33/50/75/100/125/150 | 60/100 since
    // 2026-10-08 evening, b = 33/75 | 60, AUTOMATIC when off) and three-way (THREEWAY_MENU: C flop 25/75/125, turn / river 33/75/125 | 60; b = 33/75 | 60),
    // bets on the pot after rake (MENU_POT) — gtowApi supplies it.
    const baseInput = {
      board: streetBoard,
      pot,
      stack,
      stacks: caps,
      oopRange: seats[0]!.range,
      ipRange: seats[n - 1]!.range,
      oopPos: seats[0]!.pos,
      ipPos: seats[n - 1]!.pos,
      ...(n === 3 ? { mid: { pos: seats[1]!.pos, range: seats[1]!.range } } : {}),
      ...(n === 2 && spec.huGrid ? { huGrid: spec.huGrid } : {}),
      startingStreet: STREET[k]!,
      ...(spec.rake ? { rake: spec.rake } : {}),
      ...(spec.planTag ? { planTag: spec.planTag } : {}),
    };

    // Any wager street is solved FIXED with the observed sizes pinned — live
    // capture sizes are essentially never on the AUTOMATIC grid, and a tree
    // that lacks the size played cannot be walked. (A 3-player tree is FIXED
    // on every street regardless — gtowApi supplies the grid.)
    //
    // UNLESS THE SIZES ARE ON THE TREE ALREADY SOLVED (2026-09-24). The street was solved size-free when it
    // opened (the warm-up, or hero's own decision at its root); when the wagers played since are within the
    // walk's own tolerance (matchActionLoose: 5% or 0.15bb) of what that tree offers, that tree is walked
    // instead and no FIXED tree is created. Before this, hero betting exactly the size the tree recommended
    // still re-solved the street on the next card (the key carries the pinned size) — one fresh cloud solve and
    // a 3-node re-walk, 2.5-4 s, on every turn and river after a hero bet. The check reads cached nodes and
    // fetches at most one; a miss costs that one fetch and is named in the trace.
    //
    // THE PINS ARE THE AMOUNTS PLAYED (2026-10-03): `played` — each wager with its seat and raise-to, sent as "<bb>bb"
    // (the node is named by it exactly: "18.8bb" → R18.8). It was a % of the pot to a tenth (streetFixedPcts), a lossy
    // round trip, and the level's one percentage on every seat — hero's raise facing a bet was the VILLAIN's bet %.
    let played: PlayedWager[] | null = null;
    let reuse: string | null = null;
    // A RE-TREE CARRIES THE MENUS OF THE TREE BEFORE IT (retree-consistency, 2026-10-08 — retreeInputs): the tree pinned
    // with a set of wagers is the same tree for the walk's own pin and for the "tree hero was asked on" lookup below
    const retreeOn = heroStreetAsAnsweredOn() && !(n === 2 && spec.huGrid);
    const pinnedMemo = new Map<string, { input: CustomTreeInput; carry: RetreeCarry | null }>();
    const pinnedInput = (pl: PlayedWager[]): { input: CustomTreeInput; carry: RetreeCarry | null } => {
      if (!retreeOn) return { input: { ...baseInput, played: { [STREET[k]!]: pl } }, carry: null };
      const key = JSON.stringify([pl, labels]);
      let hit = pinnedMemo.get(key);
      if (!hit) {
        hit = retreeInputs({
          base: baseInput, played: pl, labels, actors, stack,
          build: (x) => gtowApi.buildCustomTree(x),
          peekSolution: (x) => gtowApi.peekSolution(x),
          peekNode: (sol, c) => gtowApi.peekNode(sol, { [QKEY[k]!]: c, board: streetBoard }),
        });
        pinnedMemo.set(key, hit);
      }
      return hit;
    };
    if (labels.some((l) => /\(/.test(l))) {
      const autoSol = gtowApi.peekSolution(baseInput);
      if (autoSol) {
        const tTry = Date.now();
        const fit = await fitsCachedTree(autoSol, labels, stack, (codesStr) => gtowApi.peekNode(autoSol, { [QKEY[k]!]: codesStr, board: streetBoard }),
          async (codesStr) => { const x = await readNode(autoSol, codesStr); return x.r.ok ? x.r.data : null; });
        if (fit.ok) {
          labels = fit.labels;
          reuse = `size-free tree reused: ${fit.note}`;
        } else {
          reuse = `size-free tree not reusable (${fit.why}) — solved FIXED`;
        }
        tspan(`chain ${STREET[k]} size-free tree ${fit.ok ? "reused" : "not reusable"}`, tTry, fit.ok ? fit.note : fit.why);
      }
      if (!reuse?.startsWith("size-free tree reused")) {
        // hero's own last wager within tolerance of the tree he was asked on: that tree, not a new one (fitsHeroAskedTree)
        const heroIdxHere = seats.findIndex((s) => s.pos === heroPos);
        const tHero = Date.now();
        const hs = await fitsHeroAskedTree(labels, actors, heroIdxHere, pot, stack,
          (pl) => gtowApi.peekSolution(pinnedInput(pl).input),
          (solId, codesStr) => gtowApi.peekNode(solId, { [QKEY[k]!]: codesStr, board: streetBoard }),
          async (solId, codesStr) => { const x = await readNode(solId, codesStr); return x.r.ok ? x.r.data : null; });
        if (hs.ok) {
          labels = hs.labels;
          played = hs.played;
          reuse = `${reuse ? `${reuse}; ` : ""}${hs.note}`;
          // a real size change is worth a word in the answer (rounding is not — the walk's own threshold)
          if (Math.abs(hs.got - hs.want) > Math.max(0.02 * hs.want, 0.1)) {
            sizeSnaps.push(`${STREET[k]!.toLowerCase()}: ${heroPos} ${hs.want}bb taken as the tree's ${hs.got}bb (hero's own size, on the tree he was asked on)`);
          }
          tspan(`chain ${STREET[k]} hero's size on the asked tree`, tHero, hs.note);
        } else {
          if (hs.why) {
            reuse = `${reuse ? `${reuse}; ` : ""}${hs.why}`;
            tspan(`chain ${STREET[k]} hero's size not on the asked tree`, tHero, hs.why);
          }
          played = playedOf(labels, actors);
        }
      }
    }
    const fixedLevels = played ? playedText(played, seats.map((s) => s.pos)) : null;
    const streetRec = {
      si, street: STREET[k]!, board: streetBoard, potIn: pot, stackIn: stack, labels, fixedLevels, played,
      stacksIn: Object.fromEntries(seats.map((s, i) => [s.pos, caps[i]!])) as Record<string, number>,
      solId: null as string | null, created: false, solveMs: 0, walkMs: 0,
      treeWhy: null as string | null, reuse, nodeSrc,
      resumedAt: undefined as number | undefined, resumeMiss: undefined as string | undefined,
      prov: undefined as ChainTrace["streets"][number]["prov"], leak: null as ChainTrace["streets"][number]["leak"],
      players: seats.map((s) => s.pos), rangesIn: seats.map((s) => r4(s.range)),
      oopIn: r4(seats[0]!.range), ipIn: r4(seats[n - 1]!.range),
      sent: null as unknown, account: null as string | null, route: undefined as string | undefined,
      rangeCheck: undefined as RangeCheck | undefined,
      checks: undefined as CheckResult[] | undefined,
      retree: undefined as RetreeCarry | undefined,
      ...(heroFloor ? { heroFloor } : {}),
    };
    trace.streets.push(streetRec);
    streetRec.rangeCheck = rangeCheckOf({
      k, first, si, plan, started: startedFp, prevOut,
      prevKey: si > 0 && rootKey ? entryKeyAt(si) : null, records: factsKey ? handFacts.streets(factsKey) : [],
    });

    const tSolve = Date.now();
    const pinned = played ? pinnedInput(played) : null;
    const treeInput: CustomTreeInput = pinned ? pinned.input : baseInput;
    if (pinned?.carry) streetRec.retree = pinned.carry;
    tstep(/size-free tree reused|is kept, not re-created/.test(reuse ?? "") ? `Reusing the ${STREET[k]!.toLowerCase()} tree`
      : pinned ? `Re-building the ${STREET[k]!.toLowerCase()} tree (bet size off the menu)`
      : `Sending the ${STREET[k]!.toLowerCase()} tree to GTO Wizard`);
    let ens = await gtowApi.ensureCustomSolution(treeInput);
    if (!ens.ok) return fail(`solve: ${ens.error}`);
    let rerouted = false;
    if (ens.created) solves++;
    streetRec.solId = String(ens.solId);
    streetRec.created = !!ens.created;
    streetRec.account = ens.session;
    if (ens.route) streetRec.route = ens.route;
    streetRec.sent = gtowApi.treeRequestSummary(treeInput);
    streetRec.solveMs = Date.now() - tSolve;
    // THE TREE SAYS WHETHER IT WAS REUSED, AND IF NOT, WHY (2026-09-24). The chain's whole economy is that an
    // earlier street's tree comes back from the cache on every later decision; a street that reads CREATED here
    // on a turn or river is the leak, and the reason (a stack that drifted, a size pinned, ranges from another
    // chart) is recorded in the trace and the answer's timeline rather than left for someone to reconstruct.
    streetRec.treeWhy = ens.created ? ens.why ?? "created (no reason recorded)" : null;
    tspan(`chain ${STREET[k]} tree ${ens.created ? "CREATED" : "cached"}`, tSolve,
      ens.created ? streetRec.treeWhy ?? undefined : `solution ${String(ens.solId).slice(0, 8)}`);
    // THE HAND'S TREE LEDGER (services/handFacts TreeRecord, 2026-09-27): every tree asked for, by street, plan and
    // origin — the warm-up's included, whether or not its walk reached hero — for checks #4, #7, #9 and #11
    const recordTree = (reroute: boolean) => {
      if (!factsKey) return;
      handFacts.recordTree(factsKey, {
        k, first, plan, origin, solId: String(ens.ok ? ens.solId : ""), sizeFree: !fixedLevels, fixed: fixedLevels,
        seats: seats.map((s) => s.pos), rake: ((streetRec.sent as { rake?: { pct_of_pot: number; cap_in_chips: number } } | null)?.rake) ?? null,
        created: !!(ens.ok && ens.created), ...(reroute ? { reroute: true } : {}), at: Date.now(),
      });
    };
    recordTree(false);
    const tWalk = Date.now();

    let st = new StreetState(n, caps);
    let codes: string[] = [];
    let closed = false;
    /** an off-tree villain action on this street was node-locked (OFFTREE_LOCK=on): the rest of the street reads the
     *  locked child, so hero's node is not kept as a mid-street checkpoint (a resume would read the unlocked tree) */
    let lockedOnStreet = false;
    /** the unlocked solve the lock forked from, and the villain node's record that holds the lock — the late lock's
     *  fallback reads hero's node on it (offTreeLockFallbackOn) */
    let lockParent: string | null = null;
    let lockSoft: OffTreeSoft | null = null;
    let ti0 = 0;
    let heroDataAtTi0: any = null;
    if (resuming) {
      const sameTree = String(ens.solId) === resuming.solId;
      // ONTO A NEW TREE TOO (2026-09-24): a wager after hero's node that the size-free tree does not offer pins a
      // FIXED tree for the street. The prefix's conditioning (every seat's range up to hero's node) was computed
      // on the size-free tree and is kept — the same spot, an equilibrium with a slightly different size menu —
      // and only the node where the wager is offered, and what follows, is read on the new tree. Hero's stored
      // node JSON is from the old tree, so that one node is read again; nothing before it is. Only when the
      // prefix itself holds a wager (its code could differ between trees) is the street walked from the root.
      const prefixSizeFree = resuming.codes.every((c) => c === "X" || c === "C" || c === "F");
      if (sameTree || prefixSizeFree) {
        seats = resuming.seats.map((s) => ({ ...s, range: s.range.slice() }));
        // with TODAY's caps, not the snapshot's (2026-10-03, review): a shove since hero's node may have proved a stack
        // other than the one read then — the stale cap made a 40 shove a 25 call and closed the street under hero
        st = StreetState.fromSnapshot(n, { ...resuming.st, caps });
        codes = resuming.codes.slice();
        ti0 = codes.length;
        heroDataAtTi0 = sameTree ? resuming.heroData : null;
        trace.nodes.push(...resuming.nodes.map((x) => ({ ...x, fromCheckpoint: true })));
        streetRec.resumedAt = ti0;
        const note = sameTree
          ? `${STREET[k]!.toLowerCase()} resumed at hero's node (after ${codes.join("-") || "the root"}) from this hand's mid-street checkpoint — ${ti0 + 1} node${ti0 ? "s" : ""} not read again`
          : `${STREET[k]!.toLowerCase()} resumed at hero's node (after ${codes.join("-") || "the root"}) onto a NEW tree (${streetRec.treeWhy ?? "sizes pinned since hero's node"}): ` +
            `the ${ti0} node${ti0 === 1 ? "" : "s"} before it keep the size-free tree's conditioning, hero's node is read on the new tree`;
        if (!sameTree) streetRec.resumeMiss = undefined;
        tmark("chain checkpoint", note);
      } else {
        streetRec.resumeMiss = `the ${STREET[k]!.toLowerCase()} now needs a different tree (${streetRec.treeWhy ?? "sizes pinned since hero's node"}) and a wager before hero's node could be coded differently on it — walked from the root`;
        tmark("chain checkpoint", `mid-${STREET[k]!.toLowerCase()} checkpoint not resumable: ${streetRec.resumeMiss}`);
      }
    }
    const streetNodesStart = trace.nodes.length - (streetRec.resumedAt != null ? resuming!.nodes.length : 0);
    /**
     * THE STREET'S CHECKS (services/chainChecks, 2026-09-27), once its walk is done — at the close, or at hero's node.
     * Everything here is already in hand: the entering ranges (#2, computed above), the street's node records (#3, #6),
     * the seat agreement counted at every node read (#4), the tree and its leak (#9, #10), the hand's tree ledger (#9,
     * #11, the warm-up's seating for #4), the street's wall-clock against its rolling median (#12), and at hero's node
     * the seat GTO Wizard named (#14) and hero's combo weight in his conditioned range (#17).
     */
    const street = STREET[k]!.toLowerCase();
    const finishChecks = (atHero: boolean): void => guardChecks(0, () => finishChecksOf(atHero), undefined);
    const finishChecksOf = (atHero: boolean): void => {
      const nodes = trace.nodes.filter((x) => x.si === si);
      const walkedActs = captured.map((_, ti) => {
        const nd = nodes.find((x) => x.ti === ti && x.taken != null);
        const a = nd ? nd.actions[nd.taken!] : undefined;
        return a ? { name: a.name, betsize: a.betsize } : null;
      });
      const villainActs = nodes.filter((x) => x.taken != null && x.actor !== heroIdx).length;
      const offs = nodes.filter((x) => x.offTree).map((x) => x.offTree!);
      // #3 CUMULATIVE (2026-10-09): each villain's range now against his flop-entering range (the spec's), on the combos
      // the board leaves = the product of his action shares since the flop; a flag when his line is under 1% though no
      // single step was (chainChecks.cumulativeOf). A walk that starts past the flop (a re-root) has no flop range here
      const cumulative = (): CumulativeLine[] => {
        if (first !== 0) return [];
        const flopOf: Record<string, number[] | undefined> = { [spec.oopPos]: spec.oopRange, [spec.ipPos]: spec.ipRange, ...(spec.midPos ? { [spec.midPos]: spec.midRange } : {}) };
        const blocked = new Set(cards.slice(0, 3 + k).map(cardIdx));
        const out: CumulativeLine[] = [];
        seats.forEach((sv, idx) => {
          if (idx === heroIdx) return;
          const f = flopOf[sv.pos];
          if (!f) return;
          let fl = 0, nw = 0;
          for (let i = 0; i < 1326; i++) {
            const [x, y] = comboCards(i);
            if (blocked.has(x) || blocked.has(y)) continue;
            fl += Math.max(0, f[i] ?? 0); nw += Math.max(0, sv.range[i] ?? 0);
          }
          // his codes since the flop, from the capture's seats (streetSeats): earlier streets whole, this one as walked
          const mine: string[] = [];
          for (let s2 = 0; s2 <= si; s2++) {
            const tk = spec.streets[s2] ?? [], who = spec.streetSeats?.[s2] ?? [];
            const upto = s2 === si ? codes.length : tk.length;
            for (let j = 0; j < upto; j++) if ((who[j] ?? "").toUpperCase() === sv.pos.toUpperCase()) mine.push(tk[j]!);
          }
          const anyStepUnder1 = trace.nodes.some((x) => x.offTree?.seat === sv.pos);
          const line = cumulativeOf({ seat: sv.pos, flopCombos: fl, nowCombos: nw, codes: mine, anyStepUnder1 });
          if (line) out.push(line);
        });
        return out;
      };
      const trees = factsKey ? handFacts.trees(factsKey).filter((t) => t.k === k && t.first === first && (t.plan ?? null) === plan) : [];
      const warm = trees.filter((t) => t.origin === "warm");
      const ms = streetRec.solveMs + streetRec.walkMs;
      // #12's populations (2026-10-03): a full cache hit and a cached tree whose nodes were fetched are kept apart
      const population = solvePopulation(streetRec.created, streetRec.nodeSrc);
      const timeKey = `${STREET[k]}:${population}`;
      const base = solveTimes.median(timeKey);
      const out: CheckResult[] = [
        saneCheck,
        guardCheck(3, () => checkMistakeLines(offs, villainActs, cumulative())),
        guardCheck(4, () => checkSeats({ players: streetRec.players, agreed: seatAgreed, unnamed: seatUnnamed, warmSeats: warm[0]?.seats ?? null, origin, dealt: spec.dealt ?? null })),
        guardCheck(6, () => checkLine({ captured, walked: walkedActs })),
        guardCheck(9, () => checkTrees({ street, tree: streetRec.created ? "created" : "cached", leak: streetRec.leak, trees })),
        guardCheck(10, () => checkNodeReads({ leak: streetRec.leak, reads: streetRec.nodeSrc })),
        guardCheck(11, () => checkWarmTree({ street, origin, solId: streetRec.solId, fixed: fixedLevels, warm: [...new Set(warm.map((t) => t.solId))],
          reroutes: [...new Set(trees.filter((t) => t.reroute).map((t) => t.solId))] })),
        guardCheck(12, () => checkSolveTime({ street, ms, median: base.median, samples: base.samples, created: streetRec.created, population })),
      ];
      solveTimes.record(timeKey, ms);
      if (atHero) {
        out.push(guardCheck(14, () => checkHeroNode({ heroPos, nodeSaid: heroNodeSaid })));
        out.push(guardCheck(17, () => checkHeroCombo({ heroCombo: spec.heroComboIdx, weight: spec.heroComboIdx != null ? seats[heroIdx]!.range[spec.heroComboIdx] : null,
          maxLive: spec.heroComboIdx != null ? heaviestLive(seats[heroIdx]!.range, new Set(cards.slice(0, 3 + k).map(cardIdx))) : null })));
      }
      streetRec.checks = out;
    };
    // THIS STREET'S PROVENANCE (2026-09-25, services/chainPath): resumed, walked for the first time, or walked again —
    // and then which rule (by design) or which miss (rebuilt) made it so, from the hand's own ledger
    if (rootKey) {
      streetRec.prov = streetProvenance({
        records, k, first, plan, entry: entryKeyAt(si), toks, isLast,
        resumed: streetRec.resumedAt != null, resumeMiss: streetRec.resumeMiss ?? null,
        partialRejected: si === startSi ? partialRejected : null,
      });
      // a tree created again for a street whose ranges were NOT rebuilt is a request the cache should have saved;
      // a size pinned into a new tree is the design, a first walk needs its tree, a rebuild's tree is part of it
      const treeWhy = streetRec.treeWhy ?? "";
      if (ens.created && streetRec.prov.how === "resumed" && !/fixed sizes/.test(treeWhy)) {
        streetRec.leak = { code: "tree:recreated", why: `the ${STREET[k]!.toLowerCase()} tree was created again (${treeWhy || "no reason recorded"})` };
      }
    } else {
      streetRec.prov = { how: streetRec.resumedAt != null ? "resumed" : "first" };
    }

    // SPECULATIVE PREFETCH OF THE REST OF THE LINE (2026-09-24 latency pass). Every villain action on this street
    // is known before hero acts, and a node's address is just the codes walked to it: X / C / F, or R<size> with
    // the size as the tree stores it (a pinned bet to one decimal, an all-in to two — codes seen: R19.9, R97.35).
    // The walk reads nodes one after another, 1-1.5 s each; asking for all of them now lets the cloud solve them
    // side by side, and the walk's own read of each one JOINS the request already in flight (gtowApi.nodePending).
    // A mispredicted address costs a short poll and nothing else: the walk still reads the real node itself.
    if (process.env.GTOW_PREFETCH !== "0" && process.env.NODE_ENV !== "test" && labels.length > ti0) {
      // A wager's node is named by its AMOUNT since 2026-10-03: a pinned size exactly as sent ("9.4bb" → R9.4), a size
      // on a reused size-free tree as that tree has it (the labels were rewritten to it), and the all-in by the actor's
      // own stack (GTO Wizard names an all-in R<stack>: probed 2026-10-03). One address per wager — the pot-% guesswork
      // (a raise % to a whole percent, a second "maybe the all-in" address at 60% of the stack) is gone with the pins.
      const actors = actorsOf(labels, seats.length, caps);
      let path: string[] = codes.slice();
      const addrs: string[] = [];
      for (let j = ti0; j < labels.length && addrs.length < 8; j++) {
        const l = labels[j]!;
        const x = wagerBb(l);
        const c = l === "Check" ? "X" : l === "Call" ? "C" : l === "Fold" ? "F"
          : x != null ? `R${r2(l.startsWith("AllIn") ? (caps[actors[j]!] ?? x) : x)}` : null;
        if (!c) break;
        path = [...path, c];
        addrs.push(path.join("-"));
      }
      for (const cs of [...new Set(addrs)].slice(0, 8)) {
        void gtowApi.customNode(ens.solId, { [QKEY[k]!]: cs, board: streetBoard }, 6_000, "prefetch").catch(() => { /* speculative */ });
      }
      if (addrs.length) tmark(`chain ${STREET[k]} prefetch`, `${addrs.length} node(s) asked for ahead of the walk: ${addrs.join(" | ")}`);
    }

    tstep(`GTO Wizard solving the ${STREET[k]!.toLowerCase()} tree…`, {
      ...(ens.created ? (k === 0 ? USUAL.postflopNewTree : USUAL.postflopNewTreeLater) : USUAL.postflopCached), limitMs: postflopNodeTimeoutMs(n) });
    for (let ti = ti0; ti <= labels.length; ti++) {
      // hero's node from the mid-street checkpoint needs no read: its JSON travelled with it
      let { r: nq, src: nodeSrc, ms: nodeMs } = ti === ti0 && heroDataAtTi0
        ? { r: { ok: true as const, data: heroDataAtTi0, solveSecs: 0, cached: true, src: "cache" as const }, src: "checkpoint" as const, ms: 0 }
        : await readNode(ens.solId, codes.join("-"));
      // THE OWNING ACCOUNT HIT ITS DAILY WALL MID-WALK (a 429 on the poll). A solve lives on the account that
      // made it, so it cannot be polled anywhere else — re-create the same tree once; routing now skips the
      // walled account, and the node addresses are identical on the new solve.
      // A HUNG POLL (2026-10-08, the hung-poll bound): the owning account's poll got no reply within POLL_HANG_MS and a
      // cold tree's cost is still on the read's clock — the same tree is re-posted with that account LEFT OUT (no block:
      // its other solves go on), once; too little time left and gtowApi polls on to the clock, as before.
      const hung = !nq.ok && !!nq.hung;
      if (hung && !rerouted && hungHedgeOn()) {
        // THE HEDGE (2026-10-14, hand 4924409679 — gtowApi header "WHAT A HUNG POLL IS"): the hung solve is still
        // RUNNING on GTO Wizard (a read of an unfinished solve is held, not refused), so it is not thrown away: this
        // read goes on polling it on a fresh node clock while the same tree is posted on another account (routing puts
        // it on an idle one), and the first node to answer wins. The winner becomes the street's solve for the rest of
        // the hand (adoptSolution); the loser's read ends on its own clock. GTOW_HUNG_HEDGE=off: the 2026-10-08 re-post.
        rerouted = true;
        const from: string | null = gtowApi.ownerOf(ens.solId) ?? ens.session;
        const oldSol: string = String(ens.solId);
        tstep("GTO Wizard slow on this account → a second solve on another account, first to answer wins", { limitMs: postflopNodeTimeoutMs(n) });
        const tHedge = Date.now();
        const clock = postflopNodeTimeoutMs(n);
        const keep: Promise<HedgeRead> = readNode(oldSol, codes.join("-"), clock).then((x) => ({ ...x, made: null }));
        // a hedge already running alongside this solve (the poller's earlier attempt posted it): race it again, no third solve
        const sibling = gtowApi.hedgeSibling(oldSol);
        const hedge: Promise<HedgeRead> = (async (): Promise<HedgeRead> => {
          const made: HedgeMade = sibling
            ? { ok: true, solId: sibling, created: false, session: gtowApi.ownerOf(sibling) ?? "?", why: "hedge: the second solve posted by an earlier attempt, still running" }
            : await gtowApi.hedgeSolution(treeInput, { ...(from ? { avoid: [from] } : {}), of: oldSol });
          if (!made.ok) return { r: made, src: "failed", ms: Date.now() - tHedge, made: null };
          return { ...(await readNode(made.solId, codes.join("-"), clock)), made };
        })();
        const won: HedgeRead = await firstOk(keep, hedge);
        const made = won.made;
        const hedgeWon = !!made?.ok && won.r.ok;
        const acct = made?.ok ? made.session : "?";
        if (made && made.ok && won.r.ok) {
          gtowApi.adoptSolution(treeInput, made.solId);
          ens = made;
          if (made.created) solves++;
          streetRec.solId = String(made.solId);
          streetRec.account = made.session;
          if (made.route) streetRec.route = made.route;
          streetRec.treeWhy = `${streetRec.treeWhy ? `${streetRec.treeWhy}; then ` : ""}a second solve on ${acct} answered first (hedge after a hung poll on ${from}; the first solve kept running${sibling ? "; the hedge was posted by an earlier attempt" : ""})`;
          streetRec.leak = { code: "tree:hung-hedge", why: `the ${STREET[k]!.toLowerCase()} tree was solved a second time on ${acct} after a poll on ${from} hung — the second solve answered first` };
          recordTree(true);
        } else {
          streetRec.treeWhy = `${streetRec.treeWhy ? `${streetRec.treeWhy}; then ` : ""}kept after a hung poll on ${from} (a hedge solve was posted${made?.ok ? ` on ${acct}` : ""}; ${won.r.ok ? "the first solve answered first" : "neither answered in time"})`;
          streetRec.leak = { code: "tree:hung-hedge", why: `a poll on ${from} hung: the ${STREET[k]!.toLowerCase()} tree was solved a second time on another account as a hedge — ${won.r.ok ? "the first solve answered first" : "neither solve answered in time"}` };
        }
        tspan(`chain ${STREET[k]} hedge after a hung poll`, tHedge, hedgeWon ? `the hedge on ${acct} won` : won.r.ok ? `the first solve (${from}) won` : "no answer from either");
        ({ r: nq, src: nodeSrc, ms: nodeMs } = won);
      } else if (!nq.ok && (nq.status === 429 || hung) && !rerouted) {
        tstep("GTO Wizard account busy → trying another account", { limitMs: postflopNodeTimeoutMs(n) });
        rerouted = true;
        const from = gtowApi.ownerOf(ens.solId) ?? ens.session;
        gtowApi.forgetSolution(ens.solId);
        const again = await gtowApi.ensureCustomSolution(treeInput, hung && from ? { avoid: [from] } : {});
        if (again.ok) {
          ens = again;
          if (again.created) solves++;
          streetRec.solId = String(again.solId);
          streetRec.account = again.session;
          if (again.route) streetRec.route = again.route;
          const why = hung ? `a hung poll on ${from}` : "a 429 mid-walk";
          streetRec.treeWhy = `${streetRec.treeWhy ? `${streetRec.treeWhy}; then ` : ""}re-created on another account after ${why}`;
          streetRec.leak = hung
            ? { code: "tree:hung-reroute", why: `the ${STREET[k]!.toLowerCase()} tree was re-posted on another GTO Wizard account after a poll on ${from} hung` }
            : { code: "tree:429-reroute", why: `the ${STREET[k]!.toLowerCase()} tree was re-created on another GTO Wizard account after a 429 mid-walk` };
          recordTree(true);
          ({ r: nq, src: nodeSrc, ms: nodeMs } = await readNode(ens.solId, codes.join("-")));
        }
      }
      // THE LATE LOCK'S FALLBACK (2026-10-14, offTree.offTreeLockFallbackOn): a read on the node-locked child that failed
      // — its solve still running at the clock, a hang, any error but a wall — is answered from the unlocked PARENT, the
      // tree the hand had before the lock; its node is usually in hand already (the street's prefetch read it). The
      // trace says so (offTree.soft.lock.late, leak lock:late-parent); the answer is the pre-2026-10-13 one, not none.
      if (!nq.ok && lockedOnStreet && lockParent && lockSoft && nq.status !== 429 && offTreeLockFallbackOn()) {
        const childWhy = nq.error.slice(0, 160);
        tstep("the locked solve is late → answering from the unlocked tree", { limitMs: LOCK_FALLBACK_MS });
        const fb = await readNode(lockParent, codes.join("-"), LOCK_FALLBACK_MS);
        tmark(`chain ${STREET[k]} node [${codes.join("-") || "root"}] from the unlocked parent (the locked child was late)`,
          fb.r.ok ? `parent ${lockParent.slice(0, 8)}; child: ${childWhy}` : `parent failed too: ${fb.r.error.slice(0, 120)}`);
        if (fb.r.ok) {
          lockSoft.lock = { ...(lockSoft.lock ?? { ok: true }), late: { why: childWhy, parent: lockParent } };
          streetRec.leak = { code: "lock:late-parent", why: `the node-locked child of the ${STREET[k]!.toLowerCase()} solve did not answer [${codes.join("-") || "root"}] in time (${childWhy}) — hero's node came from the unlocked parent` };
          ({ r: nq, src: nodeSrc, ms: nodeMs } = fb);
        }
      }
      if (!nq.ok) return fail(`node: ${nq.error}`);
      const sols: any[] = nq.data?.action_solutions ?? [];
      if (!sols.length) return fail("empty node mid-walk");
      const actor = st.actor;
      // THE CAPTURE NAMES WHO ACTED; the walk works it out from the rotation. They must agree (2026-09-19,
      // hand 4919211085): the reconciler had stamped hero's preflop check onto the flop, so the flop read
      // "hero checks, SB checks" instead of "SB checks, hero checks" — the same two actions, and every probe
      // for 11 s died on the bare "line ends on villain's turn" below with nothing pointing at the capture.
      // Checking each token against the seat the capture named turns a silent shift into a named one.
      // Only when the capture names a seat this street actually HAS: a name the tree doesn't share
      // (position vocabularies drift — LJ/UTG1, BTN/SB heads-up) is the caller's mismatch, not evidence
      // about the line, and must never turn an answerable spot into a miss.
      const said0 = ti < labels.length ? spec.streetSeats?.[si]?.[ti] ?? null : null;
      const saidSeat = said0 && seats.some((s) => s.pos.toUpperCase() === said0.toUpperCase()) ? said0 : null;
      if (saidSeat && saidSeat.toUpperCase() !== seats[actor]!.pos.toUpperCase()) {
        return fail(
          `the capture's line disagrees with the rotation at ${STREET[k]}#${ti}: it has ${saidSeat} acting, ` +
            `but ${seats[actor]!.pos} is to act after ${codes.join("-") || "the deal"} ` +
            `(seats ${seats.map((s) => s.pos).join("/")}) — the capture's actions are out of order`
        );
      }
      // EVERY node names the seat to act, not just a three-way one, and this is the only check that can catch
      // OUR rotation being wrong rather than the capture's — the one above compares us against the capture,
      // which is no help when both agree and the TREE disagrees. It was gated to three-way because heads-up
      // the vocabularies genuinely differ (the dealer is our BTN and GTO Wizard's SB), so a bare comparison
      // failed every heads-up node; alias that one pair and the check holds everywhere. Un-gated in the
      // 2026-09-22 audit, after the 6-max limp charts were found answering hero from another seat's node —
      // the same class of fault, one piece over.
      {
        const said = nq.data?.game?.players?.find?.((p: any) => p?.is_hero)?.position;
        // heads-up only: BTN and SB are the same seat under two names. Never alias them 3+ handed, where
        // they are different players and a mismatch is exactly what we want to catch.
        const norm = (p: string) => {
          const u = p.toUpperCase();
          return seats.length === 2 && (u === "BTN" || u === "SB") ? "BTN~SB" : u;
        };
        // THE NAMES ARE THE SOLUTION'S, NOT THIS WALK'S (2026-10-05, stress-500 pf_postin-003): the tree cache keys
        // on ranges, stacks, pot and sizes — not on the seats' display names — so two walks whose trees differ only in
        // who sits there (SB/BB/HJ and SB/BB/BTN with the same ranges) share one solution, and its nodes name the
        // seats as the FIRST walk did ("we have BTN to act, the node says HJ" on a right rotation). The node lists
        // the players in rotation from the one to act: compared slot by slot with ours from the actor, only a name
        // this walk has can disagree; a name only the other walk had says nothing either way.
        const listed: any[] = Array.isArray(nq.data?.game?.players) ? nq.data.game.players : [];
        const ours = seats.map((_, j) => seats[(actor + j) % seats.length]!.pos);
        if (said && rotationDisagrees(listed, ours, norm)) {
          return fail(`seat rotation disagrees with GTO Wizard at ${STREET[k]}#${ti}: we have ${seats[actor]!.pos} to act, the node says ${said}`);
        }
        // #4 / #14: the agreement is a passed check, counted (services/chainChecks)
        if (said) seatAgreed++; else seatUnnamed++;
        if (ti === labels.length) heroNodeSaid = said ? String(said) : null;
      }
      const nodeRec: ChainTraceNode = {
        si, ti, street: STREET[k]!, board: streetBoard, codes: codes.slice(), actor,
        potNode: r2(pot + st.matchedPotIn), invested: st.inv.slice(),
        actions: sols.map((a) => ({
          name: String(a.action?.display_name ?? "?"), code: String(a.action?.code ?? ""),
          betsize: a.action?.betsize != null && a.action.betsize !== "" ? Number(a.action.betsize) : null,
          position: a.action?.position ?? null,
          totalFrequency: a.total_frequency ?? null, totalEv: a.total_ev ?? null,
          strategy: r4(a.strategy), evs: r4(a.evs),
        })),
        taken: null, heroNode: false, src: nodeSrc, ms: nodeMs,
      };
      trace.nodes.push(nodeRec);

      if (ti === labels.length) {
        if (!isLast) break; // street walked through; next street's tree re-roots
        // Hero's pending decision — sanity: it must actually be hero's turn.
        if (actor !== heroIdx) {
          return fail(
            `walked line ends on villain's turn — ${seats[actor]!.pos} is to act after ` +
              `${codes.join("-") || "the deal"}, not hero (${heroPos}); the capture missed an action ` +
              `or ordered them wrong (seats ${seats.map((s) => s.pos).join("/")})`
          );
        }
        nodeRec.heroNode = true;
        // THE NODE HERO IS ANSWERED ON, kept for the street's later decisions (retree-consistency: a re-tree narrows his
        // action here by this strategy, not by the new tree's)
        if (handKey && !spec.checkpointOnly && !spec.walkThrough) {
          recordAnsweredHeroNode({ handKey, plan, first, k, earlier: spec.streets.slice(0, si), prefix: toks.slice() }, String(ens.solId), nq.data);
        }
        // HERO'S NODE IS THE HAND'S MID-STREET CHECKPOINT: the next decision resumes from here (see PartialCheckpoint)
        if (rootKey && handKey && !lockedOnStreet) {
          const entry = entryKeyAt(si);
          if (factsKey) handFacts.recordStreet(factsKey, { k, first, plan, root: rootKey, entry, key: entry, tokens: toks.slice(), kind: "partial", solId: String(ens.solId), ...(startedFp ? { inFp: startedFp } : {}), at: Date.now() });
          savePartial(handKey, entry, {
            k, tokens: spec.streets.slice(0, si + 1).map((t) => t.slice()),
            entering, seats: seats.map((s) => ({ ...s, range: s.range.slice() })), pot, stack,
            st: st.snapshot(), codes: codes.slice(), solId: String(ens.solId),
            nodes: trace.nodes.slice(streetNodesStart).filter((x) => !x.heroNode).map((x) => ({ ...x, fromCheckpoint: undefined })),
            heroData: nq.data, inFp: startedFp, at: Date.now(),
          });
        }
        // The decision street returns from INSIDE the walk, so the loop's own walkMs assignment below never runs
        // for it: every recorded trace had the answering street's walk at 0 ms and its real cost (~2.5 s p50 on
        // the river) showing up as unexplained time. Record it here. (2026-09-22)
        streetRec.walkMs = Date.now() - tWalk;
        if (!streetRec.leak && nodeLeaks.length) streetRec.leak = { code: "node:read-twice", why: nodeLeaks[0]! };
        finishChecks(true);
        const line = [...walked, `(${STREET[k]!.toLowerCase()} node after ${codes.join("-") || "root"})`].join(" / ");
        const potNode = r2(pot + st.matchedPotIn);
        trace.result = { ok: true, potNode, stackStreet: stack, line, solves };
        const retreeNotes = retreeNotesOf(trace, heroNarrowed);
        return { ok: true, data: nq.data, potNode, stackStreet: stack, line, solves, trace, ...(sizeSnaps.length ? { snaps: sizeSnaps } : {}),
          ...(stackNotes.length ? { stackNotes } : {}), ...(retreeNotes.length ? { retreeNotes } : {}),
          heroWeight: spec.heroComboIdx != null ? seats[heroIdx]!.range[spec.heroComboIdx] ?? 0 : null,
          heroMaxLive: spec.heroComboIdx != null ? heaviestLive(seats[heroIdx]!.range, new Set(cards.slice(0, 3 + k).map(cardIdx))) : null,
          heroAt: { k, n: actorsOf(labels, seats.length, caps).filter((x) => x === heroIdx).length } };
      }

      const label = labels[ti]!;
      const ai = matchWalkAction(label, sols, stack);
      if (ai < 0) {
        const offered = sols.map((a) => a.action?.display_name ?? "?").join(", ");
        return fail(`"${label}" not walkable at ${STREET[k]}#${ti} (offered: ${offered})`);
      }
      const a = sols[ai]!;
      nodeRec.taken = ai;
      // SAY WHEN A WAGER WAS ONLY MATCHED LOOSELY (2026-09-24): a size nudged onto the tree's, or a big raise taken as
      // the all-in because the tree offers no raise size there. The answer carries it as an approximation.
      const want = labelBetBb(label);
      const to = Number(a.action?.betsize);
      const moved = want != null && Number.isFinite(to) && Math.abs(to - want) > Math.max(0.02 * want, 0.1);
      const toAllIn = actionKindOf(a) === "AllIn" && !/^AllIn/.test(label);
      // rounding (8.09 read as the tree's 8.1) is not worth a word; a real size change or a raise taken as all-in is
      if (matchActionIndex(label, sols, stack) !== ai && (moved || toAllIn)) {
        const taken = `${actionKindOf(a) === "AllIn" ? "ALL-IN" : actionKindOf(a).toUpperCase()}${Number.isFinite(to) ? ` ${Math.round(to * 100) / 100}bb` : ""}`;
        sizeSnaps.push(`${STREET[k]!.toLowerCase()}: ${seats[actor]!.pos} ${want != null ? `${want}bb` : label} taken as the tree's ${taken}`);
      }
      const kind = actionKindOf(a);
      if (kind === "Fold" && actor === heroIdx) return fail("hero folds inside the line before his node (capture corruption?)");
      // A VILLAIN MISTAKE LINE (services/offTree): the equilibrium takes this action almost never, from every hand. GTO
      // Wizard's custom solves are QRE (since 2025-04-16), so these small frequencies are not noise: they are the
      // solver's modelled mistake distribution, and the range narrowed below is "the hands QRE says would make this
      // mistake". Flagged and logged (a flag, never a verdict — chainChecks #3); the walk goes on exactly as before.
      if (actor !== heroIdx) {
        const ot = offTreeStats(seats[actor]!.range, sols, ai, { dust: OFF_TREE_DUST });
        if (isOffTreePostflop(ot)) {
          nodeRec.offTree = {
            ...ot, street: STREET[k]!.toLowerCase() as OffTreeLine["street"], seat: seats[actor]!.pos, inPosition: actor === seats.length - 1,
            action: String(a.action?.display_name ?? kind).toUpperCase(), code: String(a.action?.code ?? ""),
            betsize: Number.isFinite(to) && to > 0 ? to : null, codes: codes.slice(), potNode: nodeRec.potNode,
          };
        }
      }

      // Condition the actor's range on the observed action — the step that
      // makes the NEXT street's tree see post-action ranges.
      let strat: ArrayLike<number> = a.strategy ?? [];
      // HERO'S OWN EARLIER ACTION ON THIS STREET IS NARROWED BY THE STRATEGY HE WAS ANSWERED WITH (retree-consistency,
      // 2026-10-08): on a tree that is not the one his decision here was read on (a re-tree since), his range is what that
      // answer played — not what this tree would have him play (core-bvb-007: CHECK 100% answered, 0.4% on the re-tree)
      if (actor === heroIdx && heroStreetAsAnsweredOn() && handKey && !spec.checkpointOnly && !spec.walkThrough) {
        const ans = answeredHeroNode({ handKey, plan, first, k, earlier: spec.streets.slice(0, si), prefix: toks.slice(0, ti) });
        if (ans && ans.solId !== String(ens.solId)) {
          const j = matchWalkAction(label, ans.actions as any[], stack);
          const c = spec.heroComboIdx;
          if (j >= 0) {
            strat = ans.actions[j]!.strategy;
            nodeRec.heroAnswered = {
              solId: ans.solId, src: ans.src, ...(ans.solveRow != null ? { solveRow: ans.solveRow } : {}),
              action: String(ans.actions[j]!.action.display_name), strategy: r4(Array.from(strat)),
              combo: c != null ? { answered: r4([strat[c] ?? 0])[0]!, tree: r4([a.strategy?.[c] ?? 0])[0]! } : null,
            };
            heroNarrowed.push(nodeRec.heroAnswered);
          } else {
            nodeRec.heroAnswered = { solId: ans.solId, src: ans.src, action: label, strategy: null, combo: null,
              miss: `his ${label} is not on the node he was answered on — narrowed by this tree's strategy` };
          }
        } else if (!ans) {
          // NO NODE OF THIS PLAN ANSWERED IT (served-strategy narrowing, 2026-10-08 — live 11381: answered on merge:CO+BTN,
          // this decision only on ghost:BTN): the mix he was SERVED for that action — the blend over the plans it was
          // read on, or its one tree's node — not this tree's strategy. Keyed by his action number on the street.
          const nHero = actorsOf(labels, seats.length, caps).slice(0, ti).filter((x) => x === heroIdx).length;
          const sv = servedHeroStrategy(handKey, k, nHero);
          if (sv && !(sv.solId === String(ens.solId) && !sv.blended)) {
            const m = servedActionIndex(label, sv.menu, (l, s) => matchWalkAction(l, s, stack));
            const c = spec.heroComboIdx;
            const servedInfo = { plans: sv.plans, blended: sv.blended, first: sv.first, kept: sv.src, plan, ...(m.byClass ? { byClass: true } : {}) };
            if (m.j >= 0) {
              strat = sv.strategy[m.j]!;
              nodeRec.heroAnswered = {
                solId: sv.solId ?? "?", src: "served", ...(sv.solveRow != null ? { solveRow: sv.solveRow } : {}),
                action: String(sv.menu[m.j]!.name), strategy: r4(Array.from(strat)),
                combo: c != null ? { answered: r4([strat[c] ?? 0])[0]!, tree: r4([a.strategy?.[c] ?? 0])[0]! } : null,
                served: servedInfo,
              };
              heroNarrowed.push(nodeRec.heroAnswered);
            } else {
              nodeRec.heroAnswered = { solId: sv.solId ?? "?", src: "served", action: label, strategy: null, combo: null, served: servedInfo,
                miss: `his ${label} is not on the menu he was served (${sv.menu.map((x) => x.name).join(", ")}) — narrowed by this tree's strategy` };
            }
          }
        }
      }
      let after = seats[actor]!.range.map((w, i) => w * (strat[i] ?? 0));
      // THE SOFT RANGE after an OFF-TREE villain action (services/offTree, OPTION 3, 2026-10-06): range x exp(-dEV/(t x pot))
      // instead of the QRE sliver, which holds only "the hands QRE says would make this mistake" (measured worse than
      // ignoring the action on real hands). OFFTREE_RANGE=log computes and records it and keeps the sliver; off = neither.
      let pendingLock: { factor: number[] } | null = null;
      if (nodeRec.offTree) {
        const mode = offTreeRangeMode();
        if (mode !== "off") {
          const t = offTreeSoftT();
          const potAt = nodeRec.potNode;
          const qreCombos = after.reduce((x, y) => x + y, 0);
          // THE BLEND (default since 2026-10-13; log computes it too): half his QRE narrowing, half the soft range —
          // OFFTREE_RANGE=soft keeps the soft range alone (services/offTree header)
          const w = mode === "soft" ? undefined : offTreeBlendW();
          const sr = w == null ? softOffTreeRange(seats[actor]!.range, sols, ai, potAt, t) : blendOffTreeRange(seats[actor]!.range, sols, ai, potAt, t, w);
          const soft: OffTreeSoft = "why" in sr
            ? { mode, t, pot: potAt, qreCombos, softCombos: null, applied: false, why: sr.why, ...(w != null ? { w } : {}) }
            : { mode, t, pot: potAt, qreCombos, softCombos: sr.combos, applied: mode === "soft" || mode === "blend", ...(w != null ? { w } : {}) };
          if (soft.applied && !("why" in sr)) {
            after = sr.range;
            if (offTreeLockOn()) pendingLock = { factor: sr.factor };
          }
          nodeRec.offTree.soft = soft;
        }
      }
      seats[actor]!.range = after;

      try {
        const to = Number(a.action?.betsize);
        st.apply(kind, Number.isFinite(to) && to > 0 ? to : undefined);
      } catch (e) {
        return fail(`${STREET[k]}#${ti}: ${e instanceof Error ? e.message : e}`);
      }
      const codesBefore = codes.slice();
      codes.push(String(a.action?.code ?? ""));
      // THE REST OF THE STREET AGAINST THE SOFT RANGE (OFFTREE_LOCK=on): the street's later nodes — hero's included — come
      // from the tree solved with villain playing QRE at this node. A node lock makes his action here = the soft range and
      // re-solves what follows (one POST on the solve's own account; scripts/_probePostflopNodeLock.ts). A failed lock
      // keeps the unlocked tree and says so; a street this action closes needs none (the next tree gets the range).
      if (pendingLock && !st.closed && nodeRec.offTree?.soft) {
        const lock = offTreeLock(sols, ai, pendingLock.factor, k + 1, codesBefore);
        const tLock = Date.now();
        tstep(`Villain's ${kind === "Check" ? "check" : kind === "Call" ? "call" : kind === "Raise" ? "raise" : kind === "AllIn" ? "all-in" : "bet"} is off the solver's tree → locking his range`);
        const lk = await gtowApi.lockedCustomSolution(String(ens.solId), lock);
        if (lk.ok) {
          lockParent = String(ens.solId);
          lockSoft = nodeRec.offTree.soft;
          ens = { ...ens, solId: lk.solId };
          lockedOnStreet = true;
          nodeRec.offTree.soft.lock = { ok: true, solId: String(lk.solId) };
        } else {
          nodeRec.offTree.soft.lock = { ok: false, why: lk.error.slice(0, 160) };
          tstepDetail("lock failed — using the unlocked tree");
        }
        tspan(`chain ${STREET[k]} off-tree node lock`, tLock, lk.ok ? `child ${String(lk.solId).slice(0, 8)}` : lk.error.slice(0, 120));
      }

      if (st.closed) {
        if (ti !== labels.length - 1) {
          return fail("street closed but more actions follow (capture corruption?)");
        }
        // what each seat has in the pot that was matched — an uncalled excess goes back to its owner (StreetState.matched)
        const paidBy = st.inv.map((_, i) => st.matched(i));
        const paid = Math.max(0, ...st.live.map((i) => paidBy[i] ?? 0));
        pot += paidBy.reduce((s0, x) => s0 + x, 0);
        stack -= paid;
        const before = seats.map((s) => s.pos);
        // each seat pays its own chips out of its own stack; a folded seat's stack leaves with it
        if (behind) {
          const next: Record<string, number> = {};
          for (const i of st.live) {
            const p = seats[i]!.pos;
            if (behind[p] != null) next[p] = r2(Math.max(0, behind[p]! - (paidBy[i] ?? 0)));
          }
          behind = next;
        }
        seats = st.live.map((i) => seats[i]!);   // folded seats leave the hand
        // AN ALL-IN SEAT LEAVES THE LATER STREETS' TREES (2026-10-03): it has no decision left, its chips are in the pot.
        // (The pot is the table's whole pot; hero's showdown against the all-in seat's range is not modelled — said.)
        const gone = behind ? seats.filter((s) => s.pos !== heroPos && behind![s.pos] != null && behind![s.pos]! <= 0.005) : [];
        if (gone.length) {
          seats = seats.filter((s) => !gone.includes(s));
          stackNotes.push(`${STREET[k + 1]?.toLowerCase() ?? "next street"}: ${gone.map((s) => s.pos).join(", ")} all-in — left out of the tree, ` +
            `${gone.length === 1 ? "his" : "their"} chips in the pot (the showdown against ${gone.length === 1 ? "that range" : "those ranges"} is not modelled)`);
        }
        // THE STACK OF THE PLAYERS STILL IN (2026-09-25, hand 4920544353). The tree's stack was the effective stack
        // of the field it started with; once a seat folds, the next street's tree is solved at the effective stack of
        // the seats left — hero against the deepest villain still in — never more than the rolled number.
        const eff = r2(effectiveBehind(seats.map((s) => s.pos), heroPos, behind));
        if (eff < stack - 0.005) {
          stackNotes.push(`${STREET[k + 1]?.toLowerCase() ?? "next street"}: ${seats.map((s) => `${s.pos} ${behind?.[s.pos] ?? "?"}`).join(" / ")} behind ` +
            `after ${before.filter((p) => !seats.some((s) => s.pos === p)).join(", ") || "the street"} left — solved at ${eff}bb, not the ${r2(stack)}bb the ${before.length}-seat field rolled forward`);
          stack = eff;
        }
        walked.push(`${STREET[k]!.toLowerCase()} ${codes.join("-")}`);
        // the ranges this street hands on, fingerprinted: the next street must start from exactly these
        const outFp = rangesFp(seats);
        prevOut = outFp;
        // the street is closed: everything the next street needs is checkpointed for this hand's later decisions
        if (rootKey && handKey) {
          const key = exitKeys[si] ?? exitKeyOf(entryKeyAt(si), toks, streetBoard, spec.streetAmounts?.[si]);
          if (factsKey) handFacts.recordStreet(factsKey, { k, first, plan, root: rootKey, entry: entryKeyAt(si), key, tokens: toks.slice(), kind: "closed", solId: String(ens.solId),
            ...(startedFp ? { inFp: startedFp } : {}), out: outFp, at: Date.now() });
          saveCheckpoint(handKey, key, {
            k, root: rootKey, out: outFp,
            seats: seats.map((s) => ({ ...s, range: s.range.slice() })), pot, stack, behind: behind ? { ...behind } : null, stackNotes: stackNotes.slice(), walked: walked.slice(),
            streets: trace.streets.slice(), nodes: trace.nodes.slice(), at: Date.now(),
          });
        }
        if (seats.length < 2) return fail(gone.length ? "every other player still in is all-in — no decision left to solve" : "everyone else folded — no decision left to solve");
        if (stack <= 0.005) return fail("line is all-in — no pending decision to solve");
        closed = true;
        break;
      }
    }
    streetRec.walkMs = Date.now() - tWalk;
    if (!streetRec.leak && nodeLeaks.length) streetRec.leak = { code: "node:read-twice", why: nodeLeaks[0]! };
    // the street's checks (the checkpoint saved at the close holds this very record, so it carries them too)
    if (closed) finishChecks(false);
    if (spec.walkThrough && isLast && closed) {
      const rangesOut: Record<string, number[]> = {};
      for (const x of seats) rangesOut[x.pos] = x.range;
      const line = walked.join(" / ");
      trace.result = { ok: true, potNode: r2(pot), stackStreet: stack, line, solves };
      return { ok: true, data: null, potNode: r2(pot), stackStreet: stack, line, solves, trace, rangesOut, ...(stackNotes.length ? { stackNotes } : {}) };
    }
    if (!closed && !isLast) {
      return fail(`street ${STREET[k]} didn't close before the next card (missed action?)`);
    }
  }
  return fail("walk exhausted without reaching hero's node");
}
