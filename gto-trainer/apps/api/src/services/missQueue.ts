import { Database } from "bun:sqlite";
import { missQueueDbPath, openStore } from "./storePaths";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import type { ChartChoice, Walk3Result } from "./hrc3max";
import { RUNGS, type Site } from "./hrc3max";
import { SEATS6, type Chart6Choice } from "./hrc6max";
import { SNAP_TAU } from "../utils/snapToken/snapToken";
import { isTestStakeOf } from "./strategies";

/**
 * The preflop MISS QUEUE — every spot the 3-max chart corpus could not answer
 * exactly, written down with enough state to solve it offline.
 *
 * Postflop is complete because the GTO Wizard AI chain solves any board on
 * demand. Preflop has no live equivalent (an HRC 3-handed state is ~12-90 min),
 * so preflop is completed the other way round: a chart miss is recorded here
 * with its exact state (stacks, line, the size or action the tree lacked), the
 * HRC runner solves the suggested job between sessions, the result lands in
 * the corpus, and the same state answers from a chart next time.
 *
 * A miss is one of:
 *   size-off-tree      the played size was further than τ from every tree size
 *   size-snapped       the walk answered, but from a size ≥ SNAP_NOTE away
 *                      (e.g. the pool's 3.9x SB open served from the 3.5x node)
 *   action-not-in-tree a limp/call/check the tree shape does not contain
 *   jam-not-offered    an all-in where the node has no aggressive action
 *   node-missing       the walked line is not in the solution at all
 *   past-terminal      the line runs on past a terminal node
 *   beyond-ladder      the deep stack is past the 150bb rung (answered from 150)
 *
 * Items are keyed by (chart, line, want, kind) and counted per origin: live
 * (the study poller at the table), archive (sweep of hands.db), corpus (sweep
 * of the 4k-hand Zone corpus), replay (dashboard re-solves). Real hands only —
 * see missOriginOf / isRealMissRef below.
 */

export type MissKind =
  | "size-off-tree" | "size-snapped" | "action-not-in-tree" | "jam-not-offered"
  | "node-missing" | "past-terminal" | "beyond-ladder" | "other"
  // 6-max CHART-SELECTION gaps (2026-09-20). The three above are about the walk
  // through a chart; these are about the chart the picker had to settle for,
  // because the 6-max set is indexed by (depth, short seat, OPEN SIZE) and is
  // not complete. See hrc6max.ts Approx6.
  | "open-not-in-set" | "short-rung-snapped" | "no-limp-uneven"
  // HERO'S OWN CALL IS NOT IN THE TREE (2026-09-21). The charts cap callers, so hero arriving as the third
  // player in the pot lands on a node offering only FOLD and RAISE. The walk SUCCEEDS, so this was invisible
  // here until now; the answer is borrowed from the node with one caller folded (utils/borrowHeroCall), and
  // the real fix is wider trees. 1.12% of hero's preflop decisions.
  | "caller-cap";
export type MissStatus = "open" | "queued" | "solved" | "dismissed";
export type MissOrigin = "live" | "archive" | "corpus" | "replay";

// ---- REAL HANDS ONLY (2026-09-26) ----------------------------------------------------------------------------------
// This queue is the todo list of HRC solves (the chart factory's patch jobs → the box queue, its strategy work queue), so a
// hand we made up must never reach it. Since the central data root every process writes the one poker.sqlite, and
// fastSolve filed every caller but "replay" as "live": the input-mutation harness (scripts/mutationHarness.ts,
// mutation/liveVerify.ts — hands mh-…) and the post-in matrix (scripts/postInMatrix.ts — postin-…) left ~4,100 rows,
// 1,299 of them turned into 606 queued HRC solves (~44 box-days) before they were dismissed by hand.
//
// Two tests, both here:
//   missOriginOf       WHO ASKED — a whitelist of fastSolve origins that answer a real hand. Everything else (harness,
//                      golden, stress, bench, playthrough, probe, adhoc, a caller that names none) files nothing, so a
//                      new script cannot leak in by inventing a new hand id.
//   isSyntheticHandId  WHICH HAND — the ids our own scripts mint: for rows filed before the whitelist, and for a caller
//                      that claims a real origin for a made-up hand. A script that builds its own hands must not claim
//                      "live" or "replay".

/** fastSolve origin → miss-queue origin, for the callers answering a REAL hand: the study poller at the table ("live"),
 *  its street warm-up of the same hand ("warm"), a re-solve of an archived hand ("replay"). */
const REAL_SOLVE_ORIGINS = new Map<string, MissOrigin>([["live", "live"], ["warm", "live"], ["replay", "replay"]]);
const REF_ORIGINS = new Set<string>(["live", "archive", "corpus", "replay"]);

/** The miss-queue origin a fastSolve caller files under, or null: that caller is not answering a real hand and files nothing. */
export function missOriginOf(solveOrigin: string | null | undefined): MissOrigin | null {
  return (solveOrigin && REAL_SOLVE_ORIGINS.get(solveOrigin)) || null;
}

/** Client hand ids our own scripts and tests mint: stress-… (stressSixMax / stressPostflopSweep), mh-… (the mutation
 *  harness and liveVerify), postin-… (postInMatrix), depth-smoke-… / smoke (the smoke scripts), test… / fake…, and the
 *  one-off probes that filed before the whitelist (proof, gaps, refusal, pfgap, pfx). */
const SYNTHETIC_HAND_ID = /^(stress-|mh-|postin-|depth-smoke-|smoke|test|fake|proof|gaps|refusal|pfgap|pfx)/i;

export function isSyntheticHandId(id: unknown): boolean {
  return id != null && SYNTHETIC_HAND_ID.test(String(id));
}

/** THE "is this a real hand" test for one miss ref: a real origin and an id none of our scripts made up. */
export function isRealMissRef(ref: Pick<MissRef, "origin" | "clientHandId"> | null | undefined): boolean {
  return !!ref && REF_ORIGINS.has(ref.origin) && !isSyntheticHandId(ref.clientHandId);
}

/** A row that only synthetic hands ever hit. A row with no refs left (a sweep's reset emptied them) is not one. */
export function isSyntheticMiss(m: Pick<MissItem, "refs">): boolean {
  return m.refs.length > 0 && !m.refs.some(isRealMissRef);
}

/** A snap this far (log-space) or further is worth writing down. 3.9x→3.5x is 0.108. */
export const SNAP_NOTE = 0.1;

/**
 * What a `size-snapped` row says. A snap PAST τ is the loud case (2026-09-21):
 * before that change the walk refused these outright and the spot had no answer
 * at all, so these rows are now the todo list of sizes that are costing EV
 * every time they come up — not a note about a size we handled cleanly.
 */
const snapNote = (from: string, to: string, d: number): string =>
  d > SNAP_TAU
    ? `${from} answered from ${to} — PAST τ (log-dist ${d.toFixed(2)} > ${SNAP_TAU}): answered anyway, at an EV cost. A tree with ${from} would close it.`
    : `${from} answered from ${to} (log-dist ${d.toFixed(2)}, τ ${SNAP_TAU})`;

export interface MissRef {
  dbId?: number | null;
  clientHandId?: string | null;
  handId?: number | string | null;
  actionIndex?: number | null;
  ts?: number | null;
  origin: MissOrigin;
}

export interface MissState {
  // `Site`, not a hand-written pair: the NL25 grid (ign25_3maxasym2ci) has been
  // in this store since the cutover, so the narrower type was already a lie.
  site: Site;
  bbCents: number | null;
  /** observed per-seat stacks (bb), as read at the table. Six seats since
   *  2026-09-20 — the 3-max corpus only ever fills BTN/SB/BB, which is a
   *  subset, so nothing about the 3-max rows changes. */
  stacksBB: Partial<Record<"UTG" | "HJ" | "CO" | "BTN" | "SB" | "BB", number>>;
  heroPos: string | null;
  /** the intended token line (what was played), before any snapping */
  tokens: string[];
}

export interface MissItem {
  id: number;
  key: string;
  kind: MissKind;
  status: MissStatus;
  chart: string;
  site: string;
  depth: number;
  shortDepth: number;
  shortSeat: string;
  state: MissState;
  line: string;
  want: string | null;
  got: string | null;
  offered: string[];
  reason: string;
  n: number;
  nLive: number;
  nArchive: number;
  nCorpus: number;
  firstSeen: number;
  lastSeen: number;
  refs: MissRef[];
  job: SuggestedJob | SuggestedJob6 | null;
  note: string | null;
  updatedAt: number;
}

/**
 * A 6-max chart gap's job. Unlike SuggestedJob (which mirrors what
 * genThreeMaxAsymPlan.ts emits), this is simply the genSixMaxPlan.ts `--asym`
 * cell that would build the missing tree — one short rung, one open, one seat —
 * because that generator already derives the 3-bet/4-bet menus and the rake from
 * (open, depth). Solving the smallest cell that closes the gap keeps the grid
 * from exploding: an 81bb BB facing a 2x open wants BOTH a new rung and a new
 * open, and those are two cells, not one combined tree we would never reuse.
 */
export interface SuggestedJob6 {
  id: string;                 // the chart id that would answer the state exactly
  site: string;
  /** genSixMaxPlan.ts --asym spec, e.g. "deep=100;shorts=70;opens=2;seats=BB" */
  asym: string;
  /** ready to paste: the generator invocation that builds this cell */
  cmd: string;
  stacksBB: number[];
  sizes: (number | string)[];
  change: string;
}

/** The generator lives in the zenbook worktree beside the other HRC plan scripts. */
export const SIXMAX_PLAN_SCRIPT = "hrc-api/scripts/genSixMaxPlan.ts";

export function suggestJob6(a: { kind: string; solve: string | null; asym: string | null; note: string },
                            site: string, deep: number, short: number, open: number | string): SuggestedJob6 | null {
  if (!a.solve || !a.asym) return null;
  const name = a.solve.replace(/^ign\d+_6max_/, "6max-");
  return {
    id: a.solve, site, asym: a.asym,
    cmd: `bun run ${SIXMAX_PLAN_SCRIPT} --sites ${site} --grid off --asym "${a.asym}" `
       + `--out solves/sixmax_grid/${name} --name ${name}`,
    stacksBB: [deep, short],
    sizes: [open],
    change: a.note,
  };
}

/** The HRC job spec in the shape genThreeMaxAsymPlan.ts emits / threeMaxGrid.ts runs. */
export interface SuggestedJob {
  id: string;
  site: string;
  tag: string;
  depth: number;
  focus: string;
  open: number;
  threebet: number;
  stacksBB: number[];
  sizes: (number | string)[];
  flats: number[];
  sbComplete: boolean;
  solveCapS: number;
  rakePct: number;
  rakeCapBB: number;
  rakeLabel: string;
  label: string;
  format: string;
  /** what this job adds over the chart that missed */
  change: string;
}

const DDL = `CREATE TABLE IF NOT EXISTS misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  chart TEXT NOT NULL,
  site TEXT, depth INTEGER, short_depth INTEGER, short_seat TEXT,
  state_json TEXT,
  line TEXT, want TEXT, got TEXT, offered_json TEXT, reason TEXT,
  n INTEGER NOT NULL DEFAULT 0,
  n_live INTEGER NOT NULL DEFAULT 0,
  n_archive INTEGER NOT NULL DEFAULT 0,
  n_corpus INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER, last_seen INTEGER,
  refs_json TEXT, job_json TEXT, note TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_misses_status ON misses(status);
CREATE INDEX IF NOT EXISTS idx_misses_chart ON misses(chart)`;

const REFS_MAX = 40;
const refsOf = (json: string | null): MissRef[] => { try { const v = JSON.parse(json ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

// ---- the size menus, ported from hrc-api/scripts/genThreeMaxAsymPlan.ts ------
const SITES: Record<string, { rakeCapBB: number; stakeLabel: string }> = {
  ign200: { rakeCapBB: 1.0, stakeLabel: "Ignition NL200 3-max (5%, $2 cap = 1.0bb)" },
  ign500: { rakeCapBB: 0.4, stakeLabel: "Ignition NL500 3-max (5%, $2 cap = 0.4bb)" },
};
const openZone = (d: number): number[] =>
  d >= 60 ? [2, 2.2, 2.5, 2.8, 3, 3.5] : d >= 35 ? [2, 2.2, 2.5, 2.8, 3] : d >= 21 ? [2, 2.2, 2.5] : [2, 2.5];
const tbZone = (d: number): (number | "all-in")[] =>
  d >= 100 ? [9, 10.5, 12, 14] : d >= 60 ? [8, 9, 10.5, 12] : d >= 35 ? [7.5, 9, 10.5, "all-in"]
  : d >= 21 ? [6.5, 8, "all-in"] : [5, 6, "all-in"];
const fourBetZone = (d: number): (number | "all-in")[] =>
  d >= 100 ? [22, 27, 33, "all-in"] : d >= 60 ? [21, 26, "all-in"] : d >= 35 ? [18, "all-in"] : ["all-in"];
const menu = (xs: (number | "all-in")[]): string => {
  const nums = [...new Set(xs.filter((x): x is number => typeof x === "number"))].sort((a, b) => a - b);
  return [...nums.map((n) => `${n}bb`), ...(xs.includes("all-in") ? ["all-in"] : [])].join(", ");
};
const num = (n: number | string) => String(n).replace(".", "_");

const tokSize = (t: string | null | undefined): number | null => {
  const m = t?.match(/^R(\d+(?:\.\d+)?)$/);
  const v = m ? parseFloat(m[1]!) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** Bet level of the token at `index` in a line: 0 = open, 1 = 3-bet, 2 = 4-bet, 3+ = 5-bet+. */
const levelAt = (tokens: string[], index: number): number =>
  tokens.slice(0, index).filter((t) => /^R/.test(t) || t === "RAI").length;

/**
 * Suggest the HRC job that would make this miss answerable: the same
 * canonical state with the missing size added to its bet level, the flats
 * bumped for a missing limp/call, or the next rung up for a beyond-ladder
 * state. Ids extend the chart id so a solved job is recognisable next to it.
 */
export function suggestJob(kind: MissKind, chart: ChartChoice, state: MissState, tokens: string[], index: number, want: string | null): SuggestedJob | null {
  const siteInfo = SITES[chart.site];
  if (!siteInfo) return null;
  let D = chart.depth, s = chart.shortDepth, seat = chart.shortSeat.toLowerCase();
  const level = levelAt(tokens, index);
  const lvls: (number | "all-in")[][] = [
    [...new Set([...openZone(D), ...openZone(s)])],
    [...new Set([...tbZone(D), ...tbZone(s)])],
    [...fourBetZone(D)],
    ["all-in"],
  ];
  const flats = [1, 2, 1, 1];
  let suffix = "", change = "";

  if (kind === "beyond-ladder") {
    // the deep pair is past the ladder: solve the state at the next 25bb rung
    const deep = Math.max(...Object.values(state.stacksBB).filter((v): v is number => v != null));
    const sorted = Object.values(state.stacksBB).filter((v): v is number => v != null).sort((a, b) => a - b);
    const mid = sorted.length >= 2 ? sorted[1]! : deep;
    D = Math.ceil(mid / 25) * 25;
    s = Math.min(s, D);
    if (s >= D) seat = "eq";
    lvls[0] = openZone(D); lvls[1] = tbZone(D); lvls[2] = fourBetZone(D);
    change = `new depth rung ${D}bb (ladder ends at ${RUNGS[RUNGS.length - 1]}bb)`;
  } else if (kind === "size-off-tree" || kind === "size-snapped") {
    const raw = tokSize(want);
    if (raw == null) return null;
    // the tree gets a sane size, not the client's rounding: 3.92 -> 4, 7.96 -> 8
    const size = Math.max(2, Math.round(raw * 2) / 2);
    const li = Math.min(level, 2);
    if (size >= 0.5 * Math.min(D, s)) {
      // a raise to half the effective stack or more is a jam, not a size
      if (!lvls[li]!.includes("all-in")) lvls[li] = [...lvls[li]!, "all-in"];
      suffix = `_${["o", "t", "f"][li]}jam`;
      change = `all-in added at the ${["open", "3-bet", "4-bet"][li]} level (played R${size} ≈ jam)`;
    } else {
      if (!lvls[li]!.includes(size)) lvls[li] = [...lvls[li]!, size];
      suffix = `_${["o", "t", "f"][li]}${num(size)}`;
      change = `${["open", "3-bet", "4-bet"][li]} size ${size}bb added to the tree`;
    }
  } else if (kind === "action-not-in-tree" || kind === "node-missing" || kind === "past-terminal" || kind === "jam-not-offered") {
    const li = Math.min(level, 3);
    flats[li] = (flats[li] ?? 1) + 1;
    suffix = "_flats";
    change = `one more flat allowed at bet level ${li} (${["open", "3-bet", "4-bet", "5-bet"][li]})${want ? ` so "${want}" exists` : ""}`;
  } else {
    return null;
  }

  const stacksBB = [D, D, D];
  if (seat !== "eq") stacksBB["btn sb bb".split(" ").indexOf(seat)] = s;
  // keep the generation of the chart that missed (3maxasym / 3maxasym2ci) so
  // the solved job sits next to it in the catalog
  const gen = chart.id.includes("_D") ? chart.id.slice(0, chart.id.indexOf("_D")) : `${chart.site}_3maxasym`;
  const id = `${gen}_D${num(D)}_s${num(s)}_${seat}${suffix}`;
  const label = seat === "eq"
    ? `3-max ${D}bb even · rich tree (${chart.site})${change ? ` · ${change}` : ""}`
    : `3-max ${D}/${D} + ${seat.toUpperCase()} ${s}bb · rich tree (${chart.site}) · ${change}`;
  return {
    id, site: chart.site, tag: "3maxasym", depth: Math.min(...stacksBB), focus: seat, open: 0, threebet: 0,
    stacksBB, sizes: [menu(lvls[0]!), menu(lvls[1]!), menu(lvls[2]!), "all-in"], flats, sbComplete: true,
    solveCapS: 5400, rakePct: 0.05, rakeCapBB: siteInfo.rakeCapBB, rakeLabel: siteInfo.stakeLabel, label,
    format: `3-max asym · BTN/SB/BB ${stacksBB.join("/")}bb · ${siteInfo.stakeLabel} · rich sizes · limps on · HRC · miss-queue`,
    change,
  };
}

// ---- classification -----------------------------------------------------------

const parseOffered = (reason: string): string[] => {
  const m = reason.match(/have: ([^)]*)\)/);
  return m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
};

function classify(reason: string, missingAt: string | undefined, tokens: string[]): { kind: MissKind; want: string | null; got: string | null; line: string; index: number } {
  const line = missingAt ?? "";
  const index = line ? line.split("-").length : 0;
  const want = tokens[index] ?? null;
  let m: RegExpMatchArray | null;
  if ((m = reason.match(/nearest size (\S+) is too far from (\S+)/))) return { kind: "size-off-tree", want: m[2]!, got: m[1]!, line, index };
  if (/all-in not offered/.test(reason)) return { kind: "jam-not-offered", want: "RAI", got: null, line, index };
  if ((m = reason.match(/action "([^"]+)" not offered/))) return { kind: "action-not-in-tree", want: m[1]!, got: null, line, index };
  if (/node not in chart/.test(reason)) return { kind: "node-missing", want, got: null, line, index };
  if (/terminal/.test(reason)) return { kind: "past-terminal", want, got: null, line, index };
  return { kind: "other", want, got: null, line, index };
}

/** All record() reads off a chart choice — 3-max and 6-max alike. */
type ChartLike = { id: string; site: string; depth: number; shortDepth: number; shortSeat: string };

export interface Observe6Args {
  choice: Chart6Choice;
  hand: ParsedHand;
  heroPos: string | null;
  tokens: string[];
  /** omit when the chart could not be resolved at all — the gaps still count */
  walk?: Walk3Result | null;
  /** set when hero's own CALL was missing from the tree and had to be borrowed (services/fastSolve.ts) —
   *  the walk succeeds in that case, so nothing else here would notice it */
  callerCap?: { pos: string; callers: number; donor: string; dropped: string; offered: string[] } | null;
  ref: MissRef;
}

export interface ObserveArgs {
  chart: ChartChoice;
  hand: ParsedHand;
  heroPos: string | null;
  tokens: string[];
  walk: Walk3Result;
  ref: MissRef;
}

// ---- the store -------------------------------------------------------------------

/** Exported at the foot of the file, so tests can build an isolated store — the
 *  singleton writes to the live queue, which holds real rows and must never be
 *  a test fixture. */
class MissQueue {
  private db: Database | null = null;
  readonly path: string;

  constructor(path?: string) {
    this.path = path ?? missQueueDbPath();
  }

  private open(): Database {
    if (this.db) return this.db;
    this.db = openStore(this.path); // the central DB (WAL, busy timeout — a held lock must wait, not throw)
    this.db.exec(DDL);
    return this.db;
  }

  /** The per-seat stacks the chart chooser saw, from the hand's own seat map. */
  static stateOf(hand: ParsedHand, heroPos: string | null, chart: ChartChoice, tokens: string[]): MissState {
    const stacksBB: MissState["stacksBB"] = {};
    for (const [seat, pos] of Object.entries(hand.positions)) {
      const p = pos.toUpperCase();
      const v = hand.stacks?.[Number(seat)];
      if ((p === "BTN" || p === "SB" || p === "BB") && Number.isFinite(v) && v! > 0) stacksBB[p] = Math.round(v! * 10) / 10;
    }
    if (heroPos) {
      const p = heroPos.toUpperCase();
      const v = hand.stacks?.[hand.heroSeatId];
      if ((p === "BTN" || p === "SB" || p === "BB") && stacksBB[p] == null && Number.isFinite(v) && v! > 0) stacksBB[p] = Math.round(v! * 10) / 10;
    }
    return { site: chart.site, bbCents: hand.bbCents ?? null, stacksBB, heroPos, tokens };
  }

  /**
   * Look at one chart walk and record whatever it could not do exactly:
   * a failed walk is one miss; a successful walk with a far snap is a
   * size-snapped miss per far repair; a beyond-ladder chart choice is a miss
   * on its own. Returns the kinds recorded (empty = the walk was exact).
   */
  observe(a: ObserveArgs): MissKind[] {
    const out: MissKind[] = [];
    if (!isRealMissRef(a.ref)) return out;
    try {
      const state = MissQueue.stateOf(a.hand, a.heroPos, a.chart, a.tokens);
      if (a.chart.beyondLadder != null) {
        this.record("beyond-ladder", a.chart, state, a.tokens, a.tokens.length, null, null, [],
          `deep stack ${a.chart.beyondLadder}bb is past the ${RUNGS[RUNGS.length - 1]}bb rung — answered from the ${a.chart.depth}bb chart`,
          a.tokens.join("-"), a.ref, suggestJob("beyond-ladder", a.chart, state, a.tokens, a.tokens.length, null));
        out.push("beyond-ladder");
      }
      if (!a.walk.ok) {
        if (a.walk.unreachable) return out;
        const c = classify(a.walk.reason, a.walk.missingAt, a.tokens);
        this.record(c.kind, a.chart, state, a.tokens, c.index, c.want, c.got, parseOffered(a.walk.reason), a.walk.reason, c.line, a.ref,
          suggestJob(c.kind, a.chart, state, a.tokens, c.index, c.want));
        out.push(c.kind);
        return out;
      }
      for (const r of a.walk.repaired) {
        const from = tokSize(r.from), to = tokSize(r.to);
        if (from == null || to == null) continue; // RAI→jam is exact by construction
        const d = Math.abs(Math.log(from / to));
        if (d < SNAP_NOTE) continue;
        const line = a.walk.tokens.slice(0, r.index).join("-");
        this.record("size-snapped", a.chart, state, a.tokens, r.index, r.from, r.to, [],
          snapNote(r.from, r.to, d), line, a.ref,
          suggestJob("size-snapped", a.chart, state, a.tokens, r.index, r.from));
        out.push("size-snapped");
      }
    } catch {
      /* the queue never breaks an answer */
    }
    return out;
  }

  /**
   * The 6-max ring path. Two different things can go wrong and both belong here:
   *
   *   1. the CHART the picker had to settle for (hrc6max.ts Approx6) — "the
   *      uneven set has 2.5x and 3x only, using its 2.5x tree", "the BB has
   *      81bb, answered from the 70bb short chart". Each is its own solve.
   *   2. the WALK through whichever chart answered — identical to 3-max.
   *
   * A state can raise several at once, and they are deliberately separate rows:
   * an 81bb BB facing a 2x open wants a new open AND a new rung, and solving one
   * combined tree would build a cell nothing else reuses.
   */
  observe6max(a: Observe6Args): MissKind[] {
    const out: MissKind[] = [];
    // A TEST-STAKE table (NL5 ring, 2026-09-23) plays the NL200 answers but not NL200 sizes — every bet
    // rounds to the cent, so a 2.5x open arrives as 2.4x/2.6x. Its "misses" would queue solves nobody needs.
    if (isTestStakeOf("ign-ring-NL200-6", a.hand.bbCents)) return out;
    if (!isRealMissRef(a.ref)) return out;
    try {
      const chart: ChartLike = {
        id: a.choice.id, site: a.choice.site, depth: a.choice.depth,
        shortDepth: a.choice.shortDepth, shortSeat: String(a.choice.shortSeat),
      };
      const state = MissQueue.state6Of(a.hand, a.heroPos, a.choice, a.tokens);
      const line = a.tokens.join("-");

      for (const ap of a.choice.approx ?? []) {
        if (!ap.solve) continue;                       // a gap no tree would close
        const kind: MissKind =
          ap.kind === "open-not-in-set" ? "open-not-in-set"
          : ap.kind === "short-rung-snapped" ? "short-rung-snapped"
          : ap.kind === "no-limp-uneven" ? "no-limp-uneven"
          : ap.kind === "beyond-ladder" ? "beyond-ladder"
          : "size-snapped";                            // open-snapped: answered from another size
        const job = suggestJob6(ap, a.choice.site, a.choice.depth, a.choice.shortDepth,
          a.choice.openSize);
        this.record(kind, chart, state, a.tokens, a.tokens.length,
          ap.want == null ? null : String(ap.want), ap.got == null ? null : String(ap.got),
          [], ap.note, line, a.ref, job);
        out.push(kind);
      }

      // The caller cap does not fail the walk — it silently removes hero's call — so the preflop solver reports
      // it explicitly rather than the walk's own reason carrying it.
      if (a.callerCap) {
        this.record("caller-cap", chart, state, a.tokens, a.tokens.length, "C", null, a.callerCap.offered,
          `${a.callerCap.pos} has no call at "${line}" after ${a.callerCap.callers} callers — answered from ` +
          `"${a.callerCap.donor}" with ${a.callerCap.dropped}'s call folded`, line, a.ref, null);
        out.push("caller-cap");
      }

      if (!a.walk) return out;
      if (!a.walk.ok) {
        if (a.walk.unreachable) return out;
        const c = classify(a.walk.reason, a.walk.missingAt, a.tokens);
        this.record(c.kind, chart, state, a.tokens, c.index, c.want, c.got,
          parseOffered(a.walk.reason), a.walk.reason, c.line, a.ref, null);
        out.push(c.kind);
        return out;
      }
      for (const r of a.walk.repaired) {
        const from = tokSize(r.from), to = tokSize(r.to);
        if (from == null || to == null) continue;
        const d = Math.abs(Math.log(from / to));
        if (d < SNAP_NOTE) continue;
        this.record("size-snapped", chart, state, a.tokens, r.index, r.from, r.to, [],
          snapNote(r.from, r.to, d),
          a.walk.tokens.slice(0, r.index).join("-"), a.ref, null);
        out.push("size-snapped");
      }
    } catch {
      /* the queue never breaks an answer */
    }
    return out;
  }

  /** Like stateOf, but fills all six seats. */
  static state6Of(hand: ParsedHand, heroPos: string | null, choice: Chart6Choice, tokens: string[]): MissState {
    const stacksBB: MissState["stacksBB"] = {};
    const put = (pos: string | null | undefined, seatId: number) => {
      const p = String(pos ?? "").toUpperCase() as keyof MissState["stacksBB"];
      const v = hand.stacks?.[seatId];
      if (SEATS6.includes(p as never) && stacksBB[p] == null && Number.isFinite(v) && v! > 0) {
        stacksBB[p] = Math.round(v! * 10) / 10;
      }
    };
    for (const [seat, pos] of Object.entries(hand.positions ?? {})) put(pos, Number(seat));
    if (heroPos) put(heroPos, hand.heroSeatId);
    return { site: choice.site as MissState["site"], bbCents: hand.bbCents ?? null, stacksBB, heroPos, tokens };
  }

  private record(kind: MissKind, chart: ChartLike, state: MissState, tokens: string[], index: number, want: string | null, got: string | null, offered: string[], reason: string, line: string, ref: MissRef, job: SuggestedJob | SuggestedJob6 | null): void {
    const db = this.open();
    // a beyond-ladder state at 175bb and one at 225bb are different jobs
    const key = `${chart.id}|${line}|${want ?? ""}|${kind}${kind === "beyond-ladder" && job ? `|${job.id}` : ""}`;
    const now = ref.ts ?? Date.now();
    const col = ref.origin === "corpus" ? "n_corpus" : ref.origin === "archive" ? "n_archive" : "n_live";
    const cur = db.query<{ id: number; refs_json: string | null; status: string }, [string]>("SELECT id, refs_json, status FROM misses WHERE key = ?").get(key);
    if (cur) {
      let refs: MissRef[] = [];
      try { refs = JSON.parse(cur.refs_json ?? "[]"); } catch { refs = []; }
      const dup = refs.some((r) => r.origin === ref.origin && r.dbId === ref.dbId && r.handId === ref.handId && r.actionIndex === ref.actionIndex);
      if (!dup) {
        refs.push(ref);
        if (refs.length > REFS_MAX) refs = refs.slice(-REFS_MAX);
      }
      // a solved item that misses again was not actually solved
      const status = cur.status === "solved" ? "open" : cur.status;
      db.query(`UPDATE misses SET n = n + ?, ${col} = ${col} + ?, last_seen = MAX(COALESCE(last_seen,0), ?), first_seen = MIN(COALESCE(first_seen, ?), ?), refs_json = ?, status = ?, updated_at = ? WHERE id = ?`)
        .run(dup ? 0 : 1, dup ? 0 : 1, now, now, now, JSON.stringify(refs), status, Date.now(), cur.id);
      return;
    }
    db.query(
      `INSERT INTO misses (key, kind, status, chart, site, depth, short_depth, short_seat, state_json, line, want, got, offered_json, reason,
         n, n_live, n_archive, n_corpus, first_seen, last_seen, refs_json, job_json, note, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,NULL,?)`
    ).run(
      key, kind, "open", chart.id, chart.site, chart.depth, chart.shortDepth, chart.shortSeat, JSON.stringify(state), line, want, got,
      JSON.stringify(offered), reason, col === "n_live" ? 1 : 0, col === "n_archive" ? 1 : 0, col === "n_corpus" ? 1 : 0,
      now, now, JSON.stringify([ref]), job ? JSON.stringify(job) : null, Date.now()
    );
  }

  private rowOf(r: any): MissItem {
    const j = (s: string | null, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
    return {
      id: r.id, key: r.key, kind: r.kind, status: r.status, chart: r.chart, site: r.site, depth: r.depth, shortDepth: r.short_depth, shortSeat: r.short_seat,
      state: j(r.state_json, { site: r.site, bbCents: null, stacksBB: {}, heroPos: null, tokens: [] }),
      line: r.line ?? "", want: r.want, got: r.got, offered: j(r.offered_json, []), reason: r.reason ?? "",
      n: r.n, nLive: r.n_live, nArchive: r.n_archive, nCorpus: r.n_corpus, firstSeen: r.first_seen, lastSeen: r.last_seen,
      refs: j(r.refs_json, []), job: j(r.job_json, null), note: r.note, updatedAt: r.updated_at,
    };
  }

  /** Rows only synthetic hands ever hit (isSyntheticMiss) are left out unless `synthetic` — so the dashboard, the patch
   *  jobs and the plan writer only ever see work real hands asked for. */
  list(status?: MissStatus | "all", opts: { synthetic?: boolean } = {}): MissItem[] {
    try {
      const db = this.open();
      const rows = status && status !== "all"
        ? db.query<any, [string]>("SELECT * FROM misses WHERE status = ? ORDER BY n DESC, last_seen DESC").all(status)
        : db.query<any, []>("SELECT * FROM misses ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'queued' THEN 1 WHEN 'solved' THEN 2 ELSE 3 END, n DESC, last_seen DESC").all();
      const items = rows.map((r) => this.rowOf(r));
      return opts.synthetic ? items : items.filter((m) => !isSyntheticMiss(m));
    } catch {
      return [];
    }
  }

  get(id: number): MissItem | null {
    try {
      const r = this.open().query<any, [number]>("SELECT * FROM misses WHERE id = ?").get(id);
      return r ? this.rowOf(r) : null;
    } catch {
      return null;
    }
  }

  setStatus(id: number, status: MissStatus, note?: string | null): boolean {
    try {
      const r = this.open().query("UPDATE misses SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?").run(status, note ?? null, Date.now(), id);
      return r.changes > 0;
    } catch {
      return false;
    }
  }

  /** Drop the sweep-derived counts so a re-sweep does not double count; live/replay counts stay. */
  resetOrigin(origin: "archive" | "corpus"): void {
    try {
      const col = origin === "archive" ? "n_archive" : "n_corpus";
      const db = this.open();
      const rows = db.query<{ id: number; refs_json: string | null; n_live: number; n_archive: number; n_corpus: number }, []>("SELECT id, refs_json, n_live, n_archive, n_corpus FROM misses").all();
      for (const r of rows) {
        let refs: MissRef[] = [];
        try { refs = JSON.parse(r.refs_json ?? "[]"); } catch { refs = []; }
        refs = refs.filter((x) => x.origin !== origin);
        const n = r.n_live + (origin === "archive" ? 0 : r.n_archive) + (origin === "corpus" ? 0 : r.n_corpus);
        db.query(`UPDATE misses SET ${col} = 0, n = ?, refs_json = ? WHERE id = ?`).run(n, JSON.stringify(refs), r.id);
      }
      db.query("DELETE FROM misses WHERE n = 0 AND status IN ('open')").run();
    } catch {
      /* ignore */
    }
  }

  /** Real rows only (see list); `synthetic` counts the rows left out. In JS, not SQL, because the test reads the refs. */
  stats(): { total: number; byStatus: Record<string, number>; byKind: Record<string, number>; hands: { live: number; archive: number; corpus: number }; synthetic: number } {
    const out = { total: 0, byStatus: {} as Record<string, number>, byKind: {} as Record<string, number>, hands: { live: 0, archive: 0, corpus: 0 }, synthetic: 0 };
    try {
      const rows = this.open().query<{ status: string; kind: string; n_live: number; n_archive: number; n_corpus: number; refs_json: string | null }, []>(
        "SELECT status, kind, n_live, n_archive, n_corpus, refs_json FROM misses").all();
      for (const r of rows) {
        if (isSyntheticMiss({ refs: refsOf(r.refs_json) })) { out.synthetic++; continue; }
        out.byStatus[r.status] = (out.byStatus[r.status] ?? 0) + 1;
        out.total++;
        if (r.status !== "open" && r.status !== "queued") continue;
        out.byKind[r.kind] = (out.byKind[r.kind] ?? 0) + 1;
        out.hands.live += r.n_live; out.hands.archive += r.n_archive; out.hands.corpus += r.n_corpus;
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * Per-kind volume for the approximations register: how many distinct states
   * are open, and how many times each was hit in LIVE play (`n_live`) as
   * opposed to a replay sweep.
   *
   * Rows and hits say different things and the register shows both: 863
   * beyond-ladder rows with 4 live hits is a big backlog that rarely bites,
   * while 17 no-limp-uneven rows with 33 live hits is a small one that bites
   * constantly — and it is the second kind that is worth solving first.
   *
   * Real hands only: a row only synthetic hands hit is left out, and a row both hit loses our hits from its live count
   * (each ref added one to n_live when it was filed; a ref past REFS_MAX is gone, so that side can over-count a little).
   */
  volumeByKind(): Record<string, { rows: number; live: number; corpus: number; lastSeen: number | null }> {
    const out: Record<string, { rows: number; live: number; corpus: number; lastSeen: number | null }> = {};
    try {
      const rows = this.open().query<{ kind: string; n_live: number; n_corpus: number; last_seen: number | null; refs_json: string | null }, []>(
        "SELECT kind, n_live, n_corpus, last_seen, refs_json FROM misses WHERE status IN ('open','queued')"
      ).all();
      for (const r of rows) {
        const refs = refsOf(r.refs_json);
        if (isSyntheticMiss({ refs })) continue;
        const ours = refs.filter((x) => (x.origin === "live" || x.origin === "replay") && !isRealMissRef(x)).length;
        const v = (out[r.kind] ??= { rows: 0, live: 0, corpus: 0, lastSeen: null });
        v.rows++;
        v.live += Math.max(0, r.n_live - ours);
        v.corpus += r.n_corpus;
        if (r.last_seen != null && (v.lastSeen == null || r.last_seen > v.lastSeen)) v.lastSeen = r.last_seen;
      }
    } catch {
      /* the register degrades to "unmeasured", it never throws */
    }
    return out;
  }
}

export const missQueue = new MissQueue();
export { MissQueue };
