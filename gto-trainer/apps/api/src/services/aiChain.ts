import { gtowApi, type NodeSource, type PlayedWager } from "./gtowApi";
import { tmark, tspan } from "./answerTrace";
import {
  actionKindOf,
  matchActionIndex,
  matchActionLoose,
  wagerLabelForWalk,
} from "../utils/aiChainTokens/aiChainTokens";
import { labelBetBb } from "../utils/aiStudyLine/aiStudyLine";
import { wagerBb } from "../utils/streetFixedPcts/streetFixedPcts";
import { handFacts, type StreetRecord } from "./handFacts";
import type { RangeCheck, StreetPath } from "./chainPath";
import { isOffTree, offTreeStats, type OffTreeLine } from "./offTree";
import { currentRequestScope } from "./requestScope";
import {
  checkHeroCombo, checkHeroNode, checkLine, checkMistakeLines, checkNodeReads, checkRangesSane, checkSeats, checkSolveTime,
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
  /** villain took an action the solver almost never takes here (services/offTree, 2026-09-27) — flagged, not acted on */
  offTree?: OffTreeLine;
}
export interface ChainTrace {
  spec: AiChainSpec;
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
  }[];
  nodes: ChainTraceNode[];
  /** where this walk started (2026-09-24): from the hand's checkpoint after `from`, or from the flop with the
   *  reason no checkpoint fit; absent when the spec carried no handKey */
  checkpoint?: { from: string | null; streetsReused: number; note: string };
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
  if (!behind) return Infinity;
  const of = (p: string) => { const v = behind[p]; return v != null && Number.isFinite(v) ? v : Infinity; };
  const villains = seats.filter((p) => p !== heroPos);
  const deepest = villains.length ? Math.max(...villains.map(of)) : Infinity;
  return Math.min(of(heroPos), deepest);
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
      trace: ChainTrace;
    }
  | { ok: false; why: string; trace?: ChainTrace };

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
  matched(s: number): number {
    let most = 0;
    for (let t = 0; t < this.inv.length; t++) {
      if (t === s) continue;
      most = Math.max(most, this.live.includes(t) ? (this.caps[t] ?? Infinity) : (this.inv[t] ?? 0));
    }
    return Math.min(this.inv[s] ?? 0, most);
  }
  get matchedPotIn(): number { return this.inv.reduce((sum, _, s) => sum + this.matched(s), 0); }

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
    const cap = this.caps[a] ?? Infinity;
    if (kind === "Fold") {
      this.live = this.live.filter((s) => s !== a);
      this.owed.delete(a);
      // the pointer now indexes the next seat (it wraps when the folder was last)
      this.p = this.live.length ? this.p % this.live.length : 0;
      if (this.live.length) this.skipAllIn();
      return;
    }
    if (kind === "Check") this.owed.delete(a);
    else if (kind === "Call") { this.inv[a] = Math.min(this.outstanding, cap); this.owed.delete(a); }
    else {
      const to = Math.min(raiseTo ?? NaN, cap);
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

export async function solveAiChain(spec: AiChainSpec): Promise<AiChainResult> {
  const trace: ChainTrace = { spec, streets: [], nodes: [], result: { ok: false } };
  const sizeSnaps: string[] = [];
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
  const records = handKey ? handFacts.streets(handKey) : [];
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
    const n = seats.length;
    // what this street starts from, fingerprinted BEFORE hero's floor (the previous street handed on exactly this); a
    // resumed street started on an earlier decision, and its checkpoint carries the fingerprint taken then
    const startedFp: string | null = resuming ? (resuming.inFp ?? null) : rangesFp(seats);
    if (resuming) seats = resuming.entering.map((s) => ({ ...s, range: s.range.slice() }));
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
    if (spec.heroComboIdx != null) {
      const heroArr = seats[heroIdx]!.range;
      const boardIdx = new Set(cards.slice(0, 3 + k).map(cardIdx));
      for (const idx of classCombos(spec.heroComboIdx)) {
        const [a, b] = comboCards(idx);
        if (boardIdx.has(a) || boardIdx.has(b)) continue;   // card removal stays absolute
        heroArr[idx] = Math.max(heroArr[idx] ?? 0, 0.05);
      }
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
    const readNode = async (solId: string, codesStr: string) => {
      const t = Date.now();
      const r = await gtowApi.customNode(solId, { [QKEY[k]!]: codesStr, board: streetBoard }, undefined, "walk");
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

    // The size-free tree for this street: AUTOMATIC heads-up, the fixed grid three-way (gtowApi supplies it).
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
          (pl) => gtowApi.peekSolution({ ...baseInput, played: { [STREET[k]!]: pl } }),
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
      sent: null as unknown, account: null as string | null,
      rangeCheck: undefined as RangeCheck | undefined,
      checks: undefined as CheckResult[] | undefined,
    };
    trace.streets.push(streetRec);
    streetRec.rangeCheck = rangeCheckOf({
      k, first, si, plan, started: startedFp, prevOut,
      prevKey: si > 0 && rootKey ? entryKeyAt(si) : null, records: handKey ? handFacts.streets(handKey) : [],
    });

    const tSolve = Date.now();
    const treeInput = {
      ...baseInput,
      ...(played ? { played: { [STREET[k]!]: played } } : {}),
    };
    let ens = await gtowApi.ensureCustomSolution(treeInput);
    if (!ens.ok) return fail(`solve: ${ens.error}`);
    let rerouted = false;
    if (ens.created) solves++;
    streetRec.solId = String(ens.solId);
    streetRec.created = !!ens.created;
    streetRec.account = ens.session;
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
      if (!handKey) return;
      handFacts.recordTree(handKey, {
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
      const trees = handKey ? handFacts.trees(handKey).filter((t) => t.k === k && t.first === first && (t.plan ?? null) === plan) : [];
      const warm = trees.filter((t) => t.origin === "warm");
      const ms = streetRec.solveMs + streetRec.walkMs;
      // #12's populations (2026-10-03): a full cache hit and a cached tree whose nodes were fetched are kept apart
      const population = solvePopulation(streetRec.created, streetRec.nodeSrc);
      const timeKey = `${STREET[k]}:${population}`;
      const base = solveTimes.median(timeKey);
      const out: CheckResult[] = [
        saneCheck,
        guardCheck(3, () => checkMistakeLines(offs, villainActs)),
        guardCheck(4, () => checkSeats({ players: streetRec.players, agreed: seatAgreed, unnamed: seatUnnamed, warmSeats: warm[0]?.seats ?? null, origin, dealt: spec.dealt ?? null })),
        guardCheck(6, () => checkLine({ captured, walked: walkedActs })),
        guardCheck(9, () => checkTrees({ street, tree: streetRec.created ? "created" : "cached", leak: streetRec.leak, trees })),
        guardCheck(10, () => checkNodeReads({ leak: streetRec.leak, reads: streetRec.nodeSrc })),
        guardCheck(11, () => checkWarmTree({ street, origin, solId: streetRec.solId, fixed: fixedLevels, warm: [...new Set(warm.map((t) => t.solId))] })),
        guardCheck(12, () => checkSolveTime({ street, ms, median: base.median, samples: base.samples, created: streetRec.created, population })),
      ];
      solveTimes.record(timeKey, ms);
      if (atHero) {
        out.push(guardCheck(14, () => checkHeroNode({ heroPos, nodeSaid: heroNodeSaid })));
        out.push(guardCheck(17, () => checkHeroCombo({ heroCombo: spec.heroComboIdx, weight: spec.heroComboIdx != null ? seats[heroIdx]!.range[spec.heroComboIdx] : null })));
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

    for (let ti = ti0; ti <= labels.length; ti++) {
      // hero's node from the mid-street checkpoint needs no read: its JSON travelled with it
      let { r: nq, src: nodeSrc, ms: nodeMs } = ti === ti0 && heroDataAtTi0
        ? { r: { ok: true as const, data: heroDataAtTi0, solveSecs: 0, cached: true, src: "cache" as const }, src: "checkpoint" as const, ms: 0 }
        : await readNode(ens.solId, codes.join("-"));
      // THE OWNING ACCOUNT HIT ITS DAILY WALL MID-WALK (a 429 on the poll). A solve lives on the account that
      // made it, so it cannot be polled anywhere else — re-create the same tree once; routing now skips the
      // walled account, and the node addresses are identical on the new solve.
      if (!nq.ok && nq.status === 429 && !rerouted) {
        rerouted = true;
        gtowApi.forgetSolution(ens.solId);
        const again = await gtowApi.ensureCustomSolution(treeInput);
        if (again.ok) {
          ens = again;
          if (again.created) solves++;
          streetRec.solId = String(again.solId);
          streetRec.account = again.session;
          streetRec.treeWhy = `${streetRec.treeWhy ? `${streetRec.treeWhy}; then ` : ""}re-created on another account after a 429 mid-walk`;
          streetRec.leak = { code: "tree:429-reroute", why: `the ${STREET[k]!.toLowerCase()} tree was re-created on another GTO Wizard account after a 429 mid-walk` };
          recordTree(true);
          ({ r: nq, src: nodeSrc, ms: nodeMs } = await readNode(ens.solId, codes.join("-")));
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
        if (said && norm(String(said)) !== norm(seats[actor]!.pos)) {
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
        // HERO'S NODE IS THE HAND'S MID-STREET CHECKPOINT: the next decision resumes from here (see PartialCheckpoint)
        if (rootKey && handKey) {
          const entry = entryKeyAt(si);
          handFacts.recordStreet(handKey, { k, first, plan, root: rootKey, entry, key: entry, tokens: toks.slice(), kind: "partial", solId: String(ens.solId), ...(startedFp ? { inFp: startedFp } : {}), at: Date.now() });
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
        return { ok: true, data: nq.data, potNode, stackStreet: stack, line, solves, trace, ...(sizeSnaps.length ? { snaps: sizeSnaps } : {}),
          ...(stackNotes.length ? { stackNotes } : {}) };
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
        const ot = offTreeStats(seats[actor]!.range, sols, ai);
        if (isOffTree(ot)) {
          nodeRec.offTree = {
            ...ot, street: STREET[k]!.toLowerCase() as OffTreeLine["street"], seat: seats[actor]!.pos, inPosition: actor === seats.length - 1,
            action: String(a.action?.display_name ?? kind).toUpperCase(), code: String(a.action?.code ?? ""),
            betsize: Number.isFinite(to) && to > 0 ? to : null, codes: codes.slice(), potNode: nodeRec.potNode,
          };
        }
      }

      // Condition the actor's range on the observed action — the step that
      // makes the NEXT street's tree see post-action ranges.
      const strat: number[] = a.strategy ?? [];
      seats[actor]!.range = seats[actor]!.range.map((w, i) => w * (strat[i] ?? 0));

      try {
        const to = Number(a.action?.betsize);
        st.apply(kind, Number.isFinite(to) && to > 0 ? to : undefined);
      } catch (e) {
        return fail(`${STREET[k]}#${ti}: ${e instanceof Error ? e.message : e}`);
      }
      codes.push(String(a.action?.code ?? ""));

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
          handFacts.recordStreet(handKey, { k, first, plan, root: rootKey, entry: entryKeyAt(si), key, tokens: toks.slice(), kind: "closed", solId: String(ens.solId),
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
