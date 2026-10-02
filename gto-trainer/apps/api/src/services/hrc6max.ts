import { seatsInHand } from "../utils/dealtSeats/dealtSeats";
import { dealtBySeat } from "../utils/archivedHand/archivedHand";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { type GetNode, type HrcNode } from "./hrc3max";
// Nodes come from the baked SQLite when this machine has it, and from :8777
// otherwise — see services/hrc6maxDb.ts for why that is worth doing. NOTE the
// import is fetchNode6max, NOT hrc3max's fetchNode: resolveChart6max opens the
// ROOT of each candidate, so resolution itself paid a 2-8s tree open on the
// server and reading only the walk through SQLite would have left most of the
// latency exactly where it was.
import { fetchNode6max, hrc6maxDb } from "./hrc6maxDb";
import { patchBase, patchKeys } from "./patchKey";

/**
 * Chart picker for the 6-max NL200 ring set (ledger proposal `sixmax-nl200`).
 *
 * The 3-max corpus is indexed by (depth, short stack, short seat) alone, because one 3-max tree carries every
 * open size at once. The 6-max set is NOT: a tree is solved with every seat opening ONE size, so a chart is
 * chosen by (depth, short seat, OPEN SIZE) and the limp tree is its own chart again. That is the whole reason
 * this module exists and hrc3max.ts could not simply be reused — see services/strategies.ts, which refuses the
 * 6-max strategy until this file is here.
 *
 *   even stacks   ign200_6max_D<depth>_o<size>            e.g. ign200_6max_D100_o2_5, ..._olimp
 *   one short     ign200_6max_D100_s<short>_<seat>_o<size>
 *
 * Selection is a PREFERENCE LIST, not one id: the set is still being solved, so the caller walks the list and
 * takes the first chart the server actually has. Every fallback carries the note that explains it, which rides
 * to the panel and to the miss queue exactly as the 3-max one does.
 *
 * Tokens need nothing new: buildPreflopTokens (buildSolutionUrl.ts) already walks UTG·HJ·CO·BTN·SB·BB, which is
 * this set's seat order, and walk3max is token-based, so both are reused as they are.
 */

export const SITE_6MAX = "ign200";

/** Solved depth rungs (bb) — the six the grid covers. */
export const RUNGS6 = [30, 50, 75, 100, 125, 150];
/** The rungs that HAVE a limp tree. 125 and 150bb were left out by decision (HRC will not build them), so a deeper
 *  limped pot reads the 100bb limp chart — and the picker names only trees that exist (see evenLadder). */
export const LIMP_RUNGS6 = [30, 50, 75, 100];
/** Open sizes with their own tree, biggest share of the pool's opens first. */
export const OPENS6 = [2.5, 3, 2, 3.5];
/** Short-stack rungs of the uneven set, all at a 100bb table (one seat short, the other five at 100). 30/50/70 were
 *  the first grid; 60/80 (short-rungs-6080) and 7-25 (short-rungs-20 + the 2026-09-30 short-stack grid, 204 trees
 *  in the box queue) are the rest. A rung whose tree has not landed falls to its NEAREST neighbour (chartFor6maxGrid's
 *  candidate ladder), never to a fixed default — until 2026-09-30 the list stopped at 30, so an 11bb blind read the
 *  30bb chart while its 20bb tree sat solved and unnamed (hand 4921602992). */
// 7.5, not 7 (2026-10-01): the short-stack grid solved s7_5 (genSixMaxPlan num()s the rung); a 7 here named ids that
// never existed, and the six 7.5bb trees landed baked but "NOT NAMEABLE".
export const SHORTS6 = [7.5, 10, 15, 18, 20, 25, 30, 50, 60, 70, 80];
export const DEEP6 = 100;
/** The open sizes solved with a short seat at the table: 2.5x/3x for every rung, the other four from the 2026-09-30
 *  short-stack grid (7-25bb). A missing (rung, open) tree falls to the same rung's nearest open first. */
export const UNEVEN_OPENS6 = [2, 2.2, 2.5, 3, 3.5, 5];
/** A seat this far below 100bb - the reload line - is "short" rather than noise. */
export const SHORT_GAP = 15;
/** Hero below this has not reloaded yet; the rung then follows his own stack like anyone else's. */
export const HERO_RELOAD_FLOOR = DEEP6 - SHORT_GAP;
/** Past this the 150bb chart is a guess, not a snap. */
export const LADDER_TOP6 = RUNGS6[RUNGS6.length - 1]! + 15;

export const SEATS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
export type Seat6 = (typeof SEATS6)[number];

const num = (n: number | string) => String(n).replace(".", "_");
const nearest = (xs: number[], v: number) => xs.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

export const snapRung6 = (bb: number): number => nearest(RUNGS6, bb);
export const snapOpen6 = (bb: number): number => nearest(OPENS6, bb);
export const snapShort6 = (bb: number): number => nearest(SHORTS6, bb);

export const evenChartId = (depth: number, open: number | "limp"): string =>
  `${SITE_6MAX}_6max_D${num(depth)}_o${open === "limp" ? "limp" : num(open)}`;
export const unevenChartId = (short: number, seat: Seat6, open: number): string =>
  `${SITE_6MAX}_6max_D${num(DEEP6)}_s${num(short)}_${seat}_o${num(open)}`;

/**
 * THE UNEVEN LIMP TREES (2026-10-01, Brady: "30bb, 50bb, 70bb uneven limp charts for ALL positions" — hand 4921863810, a
 * 45bb HJ limper read off the even 100bb limp chart). One short seat at a 100bb table, limp tree, every seat:
 *   _olimp_pool3  the limps and the SB's complete locked to the pool's measured ranges, exactly as POOL_LIMP_CHART
 *                 (solves/sixmax_grid/limp-uneven-pool3, queued on the Hetzner boxes 2026-10-01);
 *   _olimp        the equilibrium tree (solves/sixmax_grid/limp-uneven; s30_UTG, s70_BTN and s70_SB solved 2026-09-23).
 */
export const LIMP_SHORTS6 = [30, 50, 70];
export const unevenLimpChartId = (short: number, seat: Seat6, pool: boolean): string =>
  `${SITE_6MAX}_6max_D${num(DEEP6)}_s${num(short)}_${seat}_olimp${pool ? "_pool3" : ""}`;

/** The two pool-locked limp trees at 100bb (solves/sixmax_grid/limp-pool*, 2026-09-23/24). */
export const POOL_LIMP_CHART = `${SITE_6MAX}_6max_D100_olimp_pool3`;   // limps AND the SB's complete locked to the pool
export const POOL_LIMP_CHART_SB = `${SITE_6MAX}_6max_D100_olimp_pool`; // limps locked, the SB's own decision solved
/** The wide limp tree (2026-09-25): room for a THIRD limper and four callers of an iso, isos to 8bb, pool limp locks
 *  scaled to full weight so the three-limper nodes are actually trained (BB facing three limps: regret 1.06 → 0.009). */
export const POOL_WIDE_CHART = `${SITE_6MAX}_6max_D100_olimp_widex`;

/** Limps before the first raise, counting the four non-blind seats' opening-orbit calls (the SB's call is a complete). */
export function limpsBeforeRaise(tokens: string[]): { limps: number; raised: boolean } {
  const toks = tokens.map((t) => String(t ?? "").trim().toUpperCase());
  const firstRaise = toks.findIndex((t) => t === "RAI" || /^R[\d.]+$/.test(t));
  const pre = toks.slice(0, Math.min(4, firstRaise < 0 ? toks.length : firstRaise));
  return { limps: pre.filter((t) => t === "C").length, raised: firstRaise >= 0 };
}

/** Every first-round line over {F,C} up to three tokens that contains a limp: the limpers' locked nodes. */
const POOL_LIMP_LOCKED = new Set<string>();
/** The SB's complete-decision lines: four tokens over {F,C} with one or two limps in front. */
const POOL_SB_LOCKED = new Set<string>();
for (const n of [1, 2, 3, 4]) {
  for (let m = 0; m < 1 << n; m++) {
    const toks = Array.from({ length: n }, (_, i) => ((m >> i) & 1 ? "C" : "F"));
    const c = toks.filter((t) => t === "C").length;
    if (n <= 3 && c >= 1) POOL_LIMP_LOCKED.add(toks.join("-"));
    if (n === 4 && (c === 1 || c === 2)) POOL_SB_LOCKED.add(toks.join("-"));
  }
}

/**
 * Which pool-locked limp tree answers this node — or none, when the node is one the pool trees LOCK for the seat
 * hero is in. A locked node's mix is the pool's play, not a solution (HRC fixes the locked action and solves the
 * rest of the tree against it), so hero never reads his own decision from one:
 *   - hero is the SB facing limps and no raise → the pilot tree, whose SB was left free and best-responds to the
 *     same pool limpers (reach 1 in 1,200 at two limps, regret 0.019 — trained);
 *   - hero is a non-blind seat facing limps (the over-limp decision, locked in both pool trees) → no pool tree;
 *     the equilibrium limp chart answers as before (its one-limp nodes agree with the exact tree; its two-limp
 *     nodes are refused by the trust guard and the exact tree answers);
 *   - anything else (the BB behind limps and a complete, anyone facing an iso, every later node, and the
 *     flop-arrival ranges of a closed line) → the full pool tree, SB complete locked too.
 */
export function poolLimpChart(tokens: string[], hero: Seat6 | ""): { id: string; note: string } | null {
  const line = tokens.map((t) => String(t ?? "").trim().toUpperCase()).join("-");
  // THREE (OR MORE) LIMPERS → THE WIDE TREE, where its node offers hero every real option: the BB's check-or-iso
  // after three limps, and every response once someone has isolated. NOT the BTN or SB facing three limps: HRC's tree
  // has no over-limp or complete there (a node facing exactly three limps offers fold or raise only), so those two
  // decisions keep the line fit onto a two-limp node that does offer the limp. Four limpers fit onto three.
  const { limps, raised } = limpsBeforeRaise(tokens);
  if (limps >= 3 && (raised || hero === "BB")) {
    return { id: POOL_WIDE_CHART, note: "wide pool-locked limp tree (three limpers, isos to 8bb)" };
  }
  // THE SB FACING ANY NUMBER OF LIMPS, NO RAISE (2026-09-25 fix): three or four limps are fitted down to two, and
  // pool3's SB node at two limps is LOCKED (the pool's complete range) — reading it gave hero the fish's play. Every
  // such decision goes to the pilot, whose SB is solved.
  const opening = line.split("-");
  if (hero === "SB" && opening.length === 4 && opening.every((t) => t === "F" || t === "C") && opening.includes("C")) {
    return { id: POOL_LIMP_CHART_SB, note: "pool-locked limpers; the SB's own decision from the tree that solved it" };
  }
  if (POOL_SB_LOCKED.has(line) && hero === "SB") {
    return { id: POOL_LIMP_CHART_SB, note: "pool-locked limpers; the SB's own decision from the tree that solved it" };
  }
  if (POOL_LIMP_LOCKED.has(line)) return null;
  return { id: POOL_LIMP_CHART, note: "pool-locked limp tree (limps and the SB's complete at the pool's measured ranges)" };
}

/**
 * A chart-selection APPROXIMATION: the picker answered, but from a tree that is
 * not the one this state actually wanted.
 *
 * These already existed as prose in `note` and rode to the panel —
 *   "the uneven set has 2.5x and 3x only — using its 2.5x tree · the BB has 81bb
 *    — answered from the 70bb short chart"
 * — and then evaporated. Each one is a solve we do not own yet, so each carries
 * the chart id that WOULD answer it exactly and the genSixMaxPlan spec that
 * would build it. services/missQueue.ts turns them into queue items.
 *
 * ONLY CHART GAPS BELONG HERE. The picker also notes things like "hero's stack
 * unreadable — taken as 100bb", which is a READER fault: no tree would fix it,
 * and putting it in a solve queue would suggest solving a chart we already have.
 * Those stay prose-only.
 */
export type Approx6Kind =
  | "open-not-in-set"     // the uneven set carries 2.5x/3x only — this open has no short-stack tree
  | "open-snapped"        // the open played is not one of the solved sizes
  | "short-rung-snapped"  // the short seat's stack answered from a different short rung
  | "no-limp-uneven"      // a limped pot with a short seat — the uneven set has no limp tree
  | "beyond-ladder";      // effective stack past the top rung

export interface Approx6 {
  kind: Approx6Kind;
  /** the same sentence that goes to the panel */
  note: string;
  /** what the state wanted, and what answered it */
  want: number | string | null;
  got: number | string | null;
  seat: Seat6 | null;
  /** the chart that would answer this exactly, when one could be solved */
  solve: string | null;
  /** genSixMaxPlan.ts --asym spec that would build `solve` (null when the fix is a new even rung) */
  asym: string | null;
}

export interface Chart6Choice {
  /** charts to try, best first — the set is still solving, so the caller takes the first one that exists */
  candidates: string[];
  /** the chart the state actually wants (candidates[0]) */
  id: string;
  site: string;
  depth: number;
  /** the short seat's rung, or `depth` when the table is even */
  shortDepth: number;
  shortSeat: Seat6 | "EQ";
  /** the open size this chart's tree uses, or "limp" for the limp tree */
  openSize: number | "limp";
  note: string | null;
  beyondLadder: number | null;
  /** the effective stack the rung was chosen for: hero vs the opponent that matters (null when nothing was readable) */
  effective?: number | null;
  /** that opponent: the raiser hero faces, or the deepest live seat when hero is first in */
  relevant?: Seat6 | null;
  /** chart gaps this selection had to paper over — see Approx6 */
  approx?: Approx6[];
  /** set when a solved PATCH chart answers — see chartFor6max. "snapped" = the two-short grid at its nearest rungs */
  patch?: { id: string; variant: "exact" | "capped" | "snapped" };
}

/**
 * Each seat's stack as DEALT: what is behind, plus this round's bet, plus what earlier streets took.
 *
 * THE POT HOLDS THE EARLIER STREETS (2026-09-17). `committed` is this betting round only; by the turn a hero who
 * opened 3x and bet 6 on the flop reads 9bb short, and a 3-bet pot's hero 25bb short - the picker then took him for
 * a "not reloaded" 75bb player and conditioned the postflop solve on the 75bb chart while his preflop had been
 * answered from the 100bb one (36% of the walkthrough hands drifted rungs this way). The earlier rounds are rebuilt
 * from the actions under the feed contract: raise/bet/all-in amounts are the seat's round TOTAL, a call is the top-up.
 */
/** Each seat's stack as dealt — the one implementation lives in utils/archivedHand (hrc3max/hrc2max read it too). */
export { dealtBySeat };

/** dealtBySeat keyed by 6-max position name. */
export function dealtByPos(hand: ParsedHand, heroPos: string | null, dealt?: Record<number, number>): Partial<Record<Seat6, number>> {
  const out: Partial<Record<Seat6, number>> = {};
  const bySeat = dealt ?? dealtBySeat(hand);
  const put = (pos: string, seatId: number) => {
    const p = pos.toUpperCase() as Seat6;
    if (!SEATS6.includes(p) || bySeat[seatId] == null) return;
    out[p] = bySeat[seatId]!;
  };
  for (const [seat, pos] of Object.entries(hand.positions ?? {})) put(String(pos), Number(seat));
  if (heroPos && out[heroPos.toUpperCase() as Seat6] == null) put(heroPos, hand.heroSeatId);
  return out;
}

/**
 * The effective stack AS DEALT for a postflop solve: hero's dealt stack against the deepest opponent still in the
 * hand. This is the `depth` preflopPotStack wants — it subtracts the preflop money itself, so handing it the stack
 * left behind at the flop (or later) subtracted that money twice. null when hero's stack is unreadable.
 */
export function dealtEffective(hand: ParsedHand, dealt?: Record<number, number>): number | null {
  const bySeat = dealt ?? dealtBySeat(hand);
  const hero = bySeat[hand.heroSeatId];
  if (hero == null) return null;
  // the opponents STILL IN (utils/dealtSeats.seatsInHand, round 2): not folded, dealt, and not a seat whose preflop
  // fold the tap lost — the deepest of THOSE sets the depth (a sitting-out label or a lost fold used to)
  const inHand = seatsInHand(hand);
  const opps = Object.entries(bySeat)
    .filter(([k]) => Number(k) !== hand.heroSeatId && inHand.has(Number(k)) && hand.positions?.[Number(k)] != null)
    .map(([, v]) => v);
  return Math.round((opps.length ? Math.min(hero, Math.max(...opps)) : hero) * 100) / 100;
}

/**
 * The open size this spot is playing under: the FIRST raise in the line, snapped to a solved tree size.
 * No raise yet and a limp already in → the limp tree. No raise and no limp → hero is opening, and the tree
 * he should read is the one whose size he is about to use; 2.5x is the pool's open in 53% of hands and the
 * size the study answers suggest, so that is the default.
 */
export function openFromTokens(tokens: string[]): { open: number | "limp"; observed: number | null } {
  let limped = false;
  for (const t of tokens) {
    const tok = String(t ?? "").trim().toUpperCase();
    if (tok === "C" || tok === "CALL") { limped = true; continue; }
    const m = tok.match(/^R([\d.]+)$/);
    if (m) {
      const bb = Number(m[1]);
      if (!Number.isFinite(bb) || bb <= 0) continue;
      // A LIMP IN FRONT WINS (2026-09-16). A pot that was limped and then raised is an ISO-RAISE, and the only
      // tree that holds one is the limp tree - a raise tree's opening node offers fold or raise and nothing else,
      // so the line died on its very first token ('action "C" not offered'). Reading the raise and ignoring the
      // limp in front of it sent 25 of 357 sampled decisions to a tree that could never answer them.
      return limped ? { open: "limp", observed: bb } : { open: snapOpen6(bb), observed: bb };
    }
  }
  return limped ? { open: "limp", observed: null } : { open: 2.5, observed: null };
}

/**
 * Who is still in the hand when hero acts, and who raised last, replayed from the token walk: the opening orbit is
 * one token per seat in UTG..BB order (a padded "F" for a seat never dealt), later orbits run through the seats
 * still live, in seat order. `after` = live seats that have not acted yet in the current orbit - the players hero
 * has to plan for; anyone else live is already in the pot.
 */
export function replayTokens6(tokens: string[]): { folded: Set<Seat6>; aggressor: Seat6 | null; after: Seat6[] } {
  const folded = new Set<Seat6>();
  let aggressor: Seat6 | null = null;
  const act = (seat: Seat6, tok: string) => {
    const t = tok.trim().toUpperCase();
    if (t === "F") folded.add(seat);
    else if (/^R/.test(t)) aggressor = seat;
  };
  const n = tokens.length;
  for (let i = 0; i < Math.min(n, SEATS6.length); i++) act(SEATS6[i]!, String(tokens[i] ?? "F"));
  let p = 0;
  const nextLive = () => { for (let k = 0; k < SEATS6.length; k++) { const s = SEATS6[(p + k) % SEATS6.length]!; if (!folded.has(s)) { p = (p + k + 1) % SEATS6.length; return s; } } return null; };
  for (let i = SEATS6.length; i < n; i++) { const seat = nextLive(); if (!seat) break; act(seat, String(tokens[i] ?? "F")); }
  const after: Seat6[] = [];
  if (n < SEATS6.length) { for (let i = n + 1; i < SEATS6.length; i++) after.push(SEATS6[i]!); }
  else {
    // still to act = the live seats between hero and the last raiser (who acts again only if re-raised)
    const me = nextLive();
    for (let k = 0; k < SEATS6.length; k++) {
      const s = SEATS6[(p + k) % SEATS6.length]!;
      if (s === me || s === aggressor) break;
      if (!folded.has(s)) after.push(s);
    }
  }
  return { folded, aggressor, after };
}

/**
 * Pick the chart for a 6-handed spot. Returns a preference list: the exact chart first, then the same depth at
 * the nearest solved open size, then the even chart when an uneven one is not (yet) solved, and finally the
 * 100bb 2.5x chart, which is the one tree that is always there.
 *
 * THE RUNG IS THE EFFECTIVE STACK, NOT THE TABLE (2026-09-17). Hero always reloads to 100bb; opponents cannot be
 * made to. So:
 *   - below 100bb the question is only ever "which OPPONENT is short", and only opponents still in the hand
 *     count: a folded 30bb stack changes nothing from here. One live short at a ~100bb table = that seat's
 *     uneven chart; with two, the one that matters (the raiser hero faces, else the first still to act behind
 *     him, else the shortest caller) gets the chart and the other is noted as unmodelled; three or more shorts
 *     against a short opponent = the even chart at the effective stack, the closest thing to a short table we own.
 *   - above 100bb the question is hero AND the opponent he is up against: the raiser when facing a raise, the
 *     deepest live seat when first in. A 150bb hero against a 100bb raiser is a 100bb spot. The old median put a
 *     freshly reloaded hero on the 150bb chart at a deep table - 13.5% of corpus decisions a rung too deep.
 *   - hero under 85bb (not reloaded yet) follows his own stack like anyone else's, and says so.
 */
/** `dealt`: the stacks as dealt, read once per hand by the postflop pin (fastSolve.pinPostflop) — see chartForHu. */
export function chartFor6max(hand: ParsedHand, heroPos: string | null, tokens: string[] = [], dealt?: Record<number, number>): Chart6Choice {
  return withPatch(chartFor6maxGrid(hand, heroPos, tokens, dealt), hand, heroPos, tokens, dealt);
}

/**
 * Where solved patch charts are found: the baked DB (hrc6maxDb), which pullChart.sh adds every landed chart to and the
 * reader re-reads each minute — so a patch the box queue solves answers live with nobody wiring it. HRC6MAX_PATCHES=off
 * turns the lookup off (the test preload does: tests must not depend on what this machine happens to have baked).
 */
const defaultPatchSource = (): readonly string[] => (process.env.HRC6MAX_PATCHES === "off" ? [] : hrc6maxDb.patchSources());
let patchSource: () => readonly string[] = defaultPatchSource;
/** Tests: supply the solved patch ids (null restores the baked DB). */
export const setPatchSource = (fn: (() => readonly string[]) | null): void => { patchSource = fn ?? defaultPatchSource; };

/** The two-short grid's short rungs (solves/sixmax_grid/two-short, proposal sixmax-nl200-two-shorts): patch ids, all
 *  other seats at 100. A table with exactly two short seats and no patch of its own reads the nearest-rung tree. */
export const TWO_SHORT_RUNGS6 = [20, 40, 60, 80];
/** the stack gaps a patch chart closes: it IS this table's stacks and this open */
const PATCH_CLOSES = new Set<Approx6Kind>(["short-rung-snapped", "no-limp-uneven", "open-not-in-set", "beyond-ladder"]);
const openOfPatch = (id: string): number | null => {
  const m = /_o(\d+(?:_5)?)$/.exec(patchBase(id));
  return m ? Number(m[1]!.replace("_", ".")) : null;
};

/**
 * PATCH CHARTS ANSWER FIRST (2026-09-27, Brady: "bind all the new patch charts so they're live" — and without anyone
 * wiring each one). A patch chart is a tree solved at one table's own per-seat stacks, queued from a live approximation
 * (services/patchJobs.ts). For every decision the table's patch ids are computed with the SAME rule the queue uses
 * (services/patchKey.ts) from the stacks AS DEALT, and the first one that is solved goes ahead of the grid's choice:
 *   - the open actually played (rounded to 0.5bb) before the grid's snapped tree open — a patch can carry any open;
 *   - the exact key (stacks to 150bb) before the capped one (stacks to 100bb);
 *   - a size patch of that table (a menu level widened) before the plain one: its menu is a superset.
 * The grid's own candidates stay behind it as the fallback. The stack gaps the grid pick recorded are dropped (the
 * patch is exactly that table), so they are not filed again; an open snap stays when the patch's open is not the one
 * played. Limped pots keep the pool-locked limp trees (by design, and limp patches are parked).
 */
function withPatch(base: Chart6Choice, hand: ParsedHand, heroPos: string | null, tokens: string[],
                   dealt?: Record<number, number>): Chart6Choice {
  if (base.openSize === "limp") return base;
  const solved = patchSource();
  if (!solved.length) return base;
  const byPos = dealtByPos(hand, heroPos, dealt);
  const { observed } = openFromTokens(tokens);
  const opens = [...new Set([...(observed != null ? [Math.round(observed * 2) / 2] : []), base.openSize as number])];
  const found: { id: string; variant: "exact" | "capped" | "snapped" }[] = [];
  for (const o of opens) {
    // patchKeys lists capped then exact and drops the exact one when it is the same id — then that id IS exact
    const keys = patchKeys(SITE_6MAX, byPos, o);
    for (const k of keys.slice().reverse()) {                              // exact first, then capped
      const variant = k === keys[keys.length - 1] ? "exact" as const : "capped" as const;
      const variants = solved.filter((id) => patchBase(id) === k.id).sort((a, b) => Number(b !== k.id) - Number(a !== k.id));
      for (const id of variants) if (!found.some((f) => f.id === id)) found.push({ id, variant });
    }
  }
  // THE TWO-SHORT GRID (a grid, not per-table patches): two seats under the reload line and no patch of this exact
  // table → both shorts snapped to TWO_SHORT_RUNGS6, everyone else 100. The stack gaps STAY filed (the snap is an
  // approximation), so the table's own patch is still queued; this only answers better than the one-short grid meanwhile.
  let snapped: string | null = null;
  if (!found.length) {
    const shorts = (Object.entries(byPos) as [Seat6, number][]).filter(([, bb]) => bb < DEEP6 - SHORT_GAP);
    if (shorts.length === 2) {
      const st: Partial<Record<Seat6, number>> = {};
      for (const [p, bb] of shorts) st[p] = nearest(TWO_SHORT_RUNGS6, bb);
      for (const o of opens) {
        const id = patchKeys(SITE_6MAX, st, o)[0]?.id;
        const hit = id ? solved.filter((x) => patchBase(x) === id).sort((a, b) => Number(b !== id) - Number(a !== id))[0] : undefined;
        if (hit) {
          found.push({ id: hit, variant: "snapped" });
          snapped = shorts.map(([p, bb]) => `${p} ${Math.round(bb)}→${st[p]}`).join(", ");
          break;
        }
      }
    }
  }
  if (!found.length) return base;
  const pick = found[0]!;
  if (snapped) {
    return {
      ...base, id: pick.id, candidates: [pick.id, ...base.candidates].filter((x, i, a) => a.indexOf(x) === i),
      note: [`two-short grid chart ${pick.id.replace(`${SITE_6MAX}_6max_`, "")} (${snapped})`, ...(base.approx ?? []).map((a) => a.note)].join(" · "),
      patch: pick,
    };
  }
  const pOpen = openOfPatch(pick.id);
  const approx = (base.approx ?? []).filter((a) => !PATCH_CLOSES.has(a.kind)
    && !(a.kind === "open-snapped" && observed != null && pOpen != null && Math.abs(observed - pOpen) <= 0.2));
  const note = [`patch chart ${pick.id.replace(`${SITE_6MAX}_6max_`, "")} — this table's own stacks (${pick.variant})`,
    ...approx.map((a) => a.note)].join(" · ");
  return {
    ...base, id: pick.id, candidates: [...found.map((f) => f.id), ...base.candidates].filter((x, i, a) => a.indexOf(x) === i),
    note, approx, patch: pick,
  };
}

/** The grid pick (even / one-short / pool-limp charts) — chartFor6max lays a solved patch over it. */
function chartFor6maxGrid(hand: ParsedHand, heroPos: string | null, tokens: string[] = [], dealt?: Record<number, number>): Chart6Choice {
  const byPos = dealtByPos(hand, heroPos, dealt);
  const { open, observed } = openFromTokens(tokens);
  const notes: string[] = [];
  const approx: Approx6[] = [];
  /** Record a chart GAP: the prose the panel already shows, plus the solve that would close it. */
  const gap = (kind: Approx6Kind, note: string, want: number | string | null, got: number | string | null,
               seat: Seat6 | null, solve: string | null, asym: string | null): void => {
    notes.push(note);
    approx.push({ kind, note, want, got, seat, solve, asym });
  };
  if (observed != null && Math.abs(observed - (open as number)) > 0.2) {
    gap("open-snapped", `the open was ${observed}bb — answered from the ${open}x tree`,
        observed, open, null, null, null);
  }
  const me = (heroPos ?? "").toUpperCase() as Seat6;
  const { folded, aggressor, after } = replayTokens6(tokens);

  // hero's own stack: 100bb when unreadable (he reloads), flagged
  let hero = Number(byPos[me] ?? NaN);
  if (!Number.isFinite(hero) || hero <= 0) { hero = DEEP6; notes.push("hero's stack unreadable — taken as 100bb"); }

  // opponents still in the hand with a readable stack
  const opps = (Object.entries(byPos) as [Seat6, number][]).filter(([p]) => p !== me && !folded.has(p));
  const oppStack = (p: Seat6 | null) => (p ? opps.find(([q]) => q === p)?.[1] ?? null : null);
  const readableAgg = aggressor && !folded.has(aggressor) && oppStack(aggressor) != null ? aggressor : null;
  const deepest = opps.length ? opps.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
  const relevant: Seat6 | null = readableAgg ?? deepest?.[0] ?? null;
  const relevantStack = relevant ? oppStack(relevant)! : DEEP6;
  if (!relevant) notes.push("no opponent's stack readable — taken as 100bb");
  else if (aggressor && aggressor !== me && !readableAgg && !folded.has(aggressor)) notes.push(`the ${aggressor}'s stack is unreadable — measured against the ${relevant}`);

  const effective = Math.min(hero, relevantStack);
  const rung = snapRung6(effective);
  const beyondLadder = effective > LADDER_TOP6 ? Math.round(effective) : null;
  if (beyondLadder != null) {
    gap("beyond-ladder", `${beyondLadder}bb effective, past the ${RUNGS6[RUNGS6.length - 1]}bb rung — answered from the ${rung}bb chart`,
        beyondLadder, rung, null, evenChartId(snapRung6(beyondLadder) === rung ? Math.round(beyondLadder / 25) * 25 : rung, open), null);
  }
  const finish = (id: string, cands: string[], depth: number, shortDepth: number, shortSeat: Seat6 | "EQ", o: number | "limp"): Chart6Choice => ({
    candidates: cands.filter((x, i, a) => a.indexOf(x) === i), id, site: SITE_6MAX, depth, shortDepth, shortSeat,
    openSize: o, note: notes.join(" · ") || null, beyondLadder, effective: Math.round(effective), relevant,
    approx: approx.slice(),
  });
  const evenLadder = (depth: number, o: number | "limp"): string[] => {
    // A LIMPED POT ONLY EVER FALLS BACK TO ANOTHER LIMP CHART (2026-09-16): no raise tree contains a limp. AND ONLY
    // LIMP TREES THAT EXIST ARE NAMED (2026-09-27): the 125 and 150bb limp trees are absent by decision (HRC will not
    // build them), and naming them first sent a lookup for a chart nothing holds to the chart server on every deep
    // limped pot. The ladder is the solved limp rungs, nearest first, so a 125bb state reads the 100bb chart directly.
    if (o === "limp") return LIMP_RUNGS6.slice().sort((a, b) => Math.abs(a - depth) - Math.abs(b - depth)).map((d) => evenChartId(d, "limp"));
    const cands = [evenChartId(depth, o)];
    const byDist = RUNGS6.slice().sort((a, b) => Math.abs(a - depth) - Math.abs(b - depth));
    for (const x of [2.5, 3, 2, 3.5]) cands.push(evenChartId(depth, x));
    for (const d of byDist) cands.push(evenChartId(d, o));
    return cands;
  };
  const even = (depth: number) => {
    // THE POOL-LOCKED LIMP CHARTS (2026-09-24, hand 729). A limped pot at the 100bb rung (and the 125/150bb states
    // that ride to it) is answered from the trees whose limpers hold the pool's MEASURED limp range, not the
    // equilibrium 3.6% that starved every two-limp node. Which of the two pool trees depends on whose node hero is
    // reading — see poolLimpChart. Shallower rungs keep their equilibrium limp chart until the D50/D75 pool
    // re-solves exist.
    const pool = open === "limp" && depth >= DEEP6 ? poolLimpChart(tokens, me) : null;
    if (pool) notes.push(pool.note);
    const ladder = evenLadder(depth, open);
    // a limped pot past the deepest limp tree: the 100bb limp chart IS its chart (evenLadder) — said once, as prose
    if (open === "limp" && !LIMP_RUNGS6.includes(depth)) {
      notes.push(`${depth}bb limped pot — no limp tree past ${LIMP_RUNGS6[LIMP_RUNGS6.length - 1]}bb (by decision); the ${nearest(LIMP_RUNGS6, depth)}bb limp chart answers`);
    }
    const cands = pool ? [pool.id, ...ladder] : ladder;
    return finish(pool ? pool.id : ladder[0]!, cands, depth, depth, "EQ", open);
  };

  /**
   * A LIMPED POT WITH A SHORT SEAT READS THE UNEVEN LIMP TREE (2026-10-01). Only at the 100bb rung (the uneven limp set
   * is a 100bb table with one short seat). The seat that gets modelled: the iso-raiser hero faces if he is short, else
   * a short limper (he is in the pot), else the first short still to act behind hero, else the shortest. Which variant
   * follows the even routing: where the even pick is the pool-locked tree (POOL_LIMP_CHART) the pool-locked uneven tree
   * comes first and the equilibrium one behind it; where hero's own node is one the pool trees lock (his over-limp, the
   * SB's complete) only the equilibrium tree is named — except the SB facing limps, which keeps the pilot tree (pool
   * limpers, his own decision solved); three limpers keep the wide tree (no uneven wide tree exists).
   * Candidates run nearest short rung first, only rungs closer to the real stack than the even chart is, then the even
   * limp ladder — so an uneven tree that has not landed yet falls back exactly as before, and the answer says so.
   */
  function unevenLimp(): Chart6Choice | null {
    if (rung !== DEEP6) return null;
    const pool = poolLimpChart(tokens, me);
    // the wide tree (three limpers) and the SB's own complete (the pilot tree: pool limpers, SB solved) stay as they are —
    // no uneven tree holds pool-locked limpers with a free SB, and the pool lock is worth more there than the stacks
    if (pool?.id === POOL_WIDE_CHART || pool?.id === POOL_LIMP_CHART_SB) return null;
    const usePool = pool?.id === POOL_LIMP_CHART;
    const toks = tokens.map((t) => String(t ?? "").trim().toUpperCase());
    const firstRaise = toks.findIndex((t) => t === "RAI" || /^R[\d.]+$/.test(t));
    const limpers = new Set<Seat6>();
    for (let i = 0; i < Math.min(SEATS6.length - 2, firstRaise < 0 ? toks.length : firstRaise); i++) if (toks[i] === "C") limpers.add(SEATS6[i]!);
    const isShort = (p: Seat6 | null) => !!p && shorts.some(([q]) => q === p);
    const seat: Seat6 = isShort(readableAgg) ? readableAgg!
      : shorts.filter(([p]) => limpers.has(p)).sort((a, b) => a[1] - b[1])[0]?.[0]
        ?? after.find((p) => isShort(p)) ?? shorts.slice().sort((a, b) => a[1] - b[1])[0]![0];
    const bb = oppStack(seat)!;
    const evenGap = Math.abs(Math.log(DEEP6 / bb));
    const rungs = LIMP_SHORTS6.filter((r) => Math.abs(Math.log(r / bb)) < evenGap)
      .sort((x, y) => Math.abs(Math.log(x / bb)) - Math.abs(Math.log(y / bb)));
    if (!rungs.length) return null;
    const s = rungs[0]!;
    const ids = rungs.flatMap((r) => (usePool ? [unevenLimpChartId(r, seat, true), unevenLimpChartId(r, seat, false)] : [unevenLimpChartId(r, seat, false)]));
    if (usePool) notes.push(pool!.note);
    if (Math.abs(bb - s) > 8) {
      const want = Math.round(bb / 10) * 10;
      gap("short-rung-snapped", `the ${seat} has ${Math.round(bb)}bb — answered from the ${s}bb short limp chart`,
          want, s, seat, unevenLimpChartId(want, seat, usePool), `deep=${DEEP6};shorts=${want};opens=limp;seats=${seat}`);
    }
    const others = shorts.filter(([p]) => p !== seat);
    if (others.length) notes.push(`${others.map(([p, x]) => `${p} ${Math.round(x)}bb`).join(", ")} also short — not modelled`);
    if (hero > DEEP6 + SHORT_GAP) notes.push(`hero has ${Math.round(hero)}bb — the short chart plays him at 100bb`);
    const evenCands = [...(pool ? [pool.id] : []), ...evenLadder(DEEP6, "limp")];
    return finish(ids[0]!, [...ids, ...evenCands], DEEP6, s, seat, "limp");
  }

  // hero has not reloaded: his own stack sets the rung like anyone else's
  if (hero < HERO_RELOAD_FLOOR) {
    notes.push(`hero has ${Math.round(hero)}bb — answered from the even ${rung}bb chart`);
    return even(rung);
  }

  // the shorts that are still in the hand
  const shorts = opps.filter(([, bb]) => bb < DEEP6 - SHORT_GAP);
  if (!shorts.length || open === "limp") {
    if (shorts.length && open === "limp") {
      const uneven = unevenLimp();
      if (uneven) return uneven;
      const seat = shorts.slice().sort((a, b) => a[1] - b[1])[0]![0];
      gap("no-limp-uneven", `the uneven set has no limp tree — the even ${rung}bb limp chart answers`,
          "limp", `even ${rung}bb`, seat, unevenChartId(snapShort6(oppStack(seat) ?? DEEP6), seat, 2.5),
          `deep=${DEEP6};shorts=${snapShort6(oppStack(seat) ?? DEEP6)};opens=limp;seats=${seat}`);
    }
    return even(rung);
  }

  // which short gets modelled: the raiser hero faces, else the first short still to act behind hero, else the shortest
  const shortSeat = readableAgg && shorts.some(([p]) => p === readableAgg) ? readableAgg
    : (after.find((p) => shorts.some(([q]) => q === p)) ?? shorts.slice().sort((a, b) => a[1] - b[1])[0]![0]);
  const shortBB = oppStack(shortSeat)!;
  const relevantIsShort = relevant === shortSeat || relevantStack < DEEP6 - SHORT_GAP;

  // a deep spot with a short elsewhere at the table: the depth matters more than the bystander
  if (!relevantIsShort && rung > DEEP6) {
    notes.push(`${Math.round(effective)}bb effective vs the ${relevant} — the ${shortSeat}'s ${Math.round(shortBB)}bb is not modelled`);
    return even(rung);
  }
  // a mostly-short table against a short opponent: the even chart at the effective stack is the closest thing we own
  if (shorts.length >= 3 && relevantIsShort) {
    notes.push(`${shorts.length} short stacks and the ${relevant} has ${Math.round(relevantStack)}bb — answered from the even ${rung}bb chart`);
    return even(rung);
  }

  const s = snapShort6(shortBB);
  // THE OPEN AS PLAYED picks the uneven tree (2026-09-30): the uneven set now holds sizes the even grid does not (2.2x,
  // 5x), so the size is snapped from what was observed, not from the even grid's snap of it — and an even-grid
  // "open-snapped" gap filed above is withdrawn when the uneven set holds that open exactly.
  const target = observed ?? (open as number);
  const o = nearest(UNEVEN_OPENS6, target);
  if (Math.abs(o - target) > 0.2) {
    gap("open-not-in-set", `the uneven set has no ${target}x tree — using its ${o}x tree`,
        target, o, shortSeat, unevenChartId(s, shortSeat, target),
        `deep=${DEEP6};shorts=${s};opens=${target};seats=${shortSeat}`);
  } else if (observed != null && Math.abs(observed - (open as number)) > 0.2) {
    const i = approx.findIndex((a) => a.kind === "open-snapped");
    if (i >= 0) { notes.splice(notes.indexOf(approx[i]!.note), 1); approx.splice(i, 1); }
  }
  if (Math.abs(shortBB - s) > 8) {
    const want = Math.round(shortBB / 10) * 10;                 // the rung this state wanted
    gap("short-rung-snapped", `the ${shortSeat} has ${Math.round(shortBB)}bb — answered from the ${s}bb short chart`,
        want, s, shortSeat, unevenChartId(want, shortSeat, o),
        `deep=${DEEP6};shorts=${want};opens=${o};seats=${shortSeat}`);
  }
  const others = shorts.filter(([p]) => p !== shortSeat);
  if (others.length) notes.push(`${others.map(([p, bb]) => `${p} ${Math.round(bb)}bb`).join(", ")} also short — not modelled`);
  if (hero > DEEP6 + SHORT_GAP) notes.push(`hero has ${Math.round(hero)}bb — the short chart plays him at 100bb`);
  const id = unevenChartId(s, shortSeat, o);
  // THE LADDER IS NEAREST-FIRST OVER (RUNG, OPEN) PAIRS (2026-09-30): the set is solved rung by rung and open by
  // open, so a tree that has not landed falls to the nearest solved neighbour in BOTH dimensions at once — distance
  // = |ln(rung/short)| + OPEN_WEIGHT·|ln(open/o)|, the stack counting twice the open size (25bb vs 30bb ≈ 5x vs 3.5x)
  // — and only after every uneven pair to the even 100bb chart. It used to be list order, which sent every unlanded
  // rung to 30bb; a one-dimensional ladder fell off the short charts entirely when a whole open was unlanded.
  return finish(id, [id, ...unevenLadder6(s, o).map(([r, x]) => unevenChartId(r, shortSeat, x)),
    evenChartId(DEEP6, open), evenChartId(DEEP6, 2.5)],
    DEEP6, s, shortSeat, o);
}

/** The open size counts this much of a stack step in the uneven ladder's distance (both in log terms). */
export const OPEN_WEIGHT6 = 0.5;
/** How many uneven (rung, open) neighbours a candidate list carries before the even chart (the record answers a
 *  lookup in ~0.1 ms, so the cost is the list's length in the answer row, not the lookups). */
const LADDER_MAX6 = 24;

/** Every other (rung, open) of the uneven set, nearest to (s, o) first — see chartFor6maxGrid's ladder. */
export function unevenLadder6(s: number, o: number): [number, number][] {
  const dist = (r: number, x: number) => Math.abs(Math.log(r / s)) + OPEN_WEIGHT6 * Math.abs(Math.log(x / o));
  const pairs: [number, number][] = [];
  for (const r of SHORTS6) for (const x of UNEVEN_OPENS6) if (r !== s || x !== o) pairs.push([r, x]);
  return pairs.sort((a, b) => dist(a[0], a[1]) - dist(b[0], b[1])).slice(0, LADDER_MAX6);
}

/**
 * CAN THE PICKER NAME THIS CHART? A solved tree the picker never names answers nothing — the 20bb single-short set sat
 * in the catalog for four days that way (2026-09-26..30). The landing script (poker-zenbook/hrc-api/scripts/pullChart.sh)
 * asks this for every chart it bakes, via src/scripts/chartNameable.ts, and says so in its log when the answer is no.
 * Patch charts are always nameable (their id is computed from the table, services/patchKey.ts); grid charts must sit
 * on the lists above. Returns null when nameable, else why not.
 */
export function unnameable6max(id: string): string | null {
  const m6 = /^ign200_6max_(.+)$/.exec(id);
  if (!m6) return "not an ign200 6-max chart id";
  const rest = m6[1]!;
  if (rest.startsWith("P_")) return null;
  const val = (t: string) => Number(t.replace("_", "."));
  let m: RegExpExecArray | null;
  if ((m = /^D(\d+)_olimp(?:_(?:pool\d*|poolx\d*|widex?))?$/.exec(rest))) {
    const d = Number(m[1]);
    return LIMP_RUNGS6.includes(d) ? null : `limp depth ${d}bb is not a limp rung (${LIMP_RUNGS6.join("/")})`;
  }
  if ((m = /^D(\d+)_o([\d_]+)$/.exec(rest))) {
    const d = Number(m[1]), o = val(m[2]!);
    if (!RUNGS6.includes(d)) return `depth ${d}bb is not a rung (${RUNGS6.join("/")})`;
    if (!OPENS6.includes(o)) return `open ${o}x is not an even-grid open (${OPENS6.join("/")})`;
    return null;
  }
  if ((m = /^D(\d+)_s([\d_]+)_(UTG|HJ|CO|BTN|SB|BB)_o(limp|[\d_]+)(?:_pool3)?$/.exec(rest))) {
    if (rest.endsWith("_pool3") && m[4] !== "limp") return "only limp trees carry the pool lock";
    const d = Number(m[1]), s = val(m[2]!);
    if (d !== DEEP6) return `uneven depth ${d}bb: the uneven set is at ${DEEP6}bb`;
    if (m[4] === "limp") return LIMP_SHORTS6.includes(s) ? null : `short rung ${s}bb is not an uneven limp rung (${LIMP_SHORTS6.join("/")})`;
    if (!SHORTS6.includes(s)) return `short rung ${s}bb is not on SHORTS6 (${SHORTS6.join("/")})`;
    const o = val(m[4]!);
    if (!UNEVEN_OPENS6.includes(o)) return `open ${o}x is not on UNEVEN_OPENS6 (${UNEVEN_OPENS6.join("/")})`;
    return null;
  }
  return "an id shape the picker does not produce";
}

/**
 * The first candidate the chart server actually has. The set is solved tree by tree, so "the chart this state
 * wants" and "a chart that exists" are different questions until the run finishes; this asks the second one
 * and reports which fallback it landed on.
 */
export async function resolveChart6max(
  choice: Chart6Choice,
  get: (source: string, line: string) => Promise<HrcNode | null | "unreachable"> = fetchNode6max,
): Promise<{ id: string; root: HrcNode; fellBack: boolean } | "unreachable" | null> {
  let sawServer = false;
  for (const id of choice.candidates) {
    const root = await get(id, "");
    if (root === "unreachable") continue;
    sawServer = true;
    if (root) return { id, root, fellBack: id !== choice.candidates[0] };
  }
  return sawServer ? null : "unreachable";
}

/** A GetNode bound to one resolved chart, for walk3max. */
export const nodeGetter = (id: string): GetNode => (line) => fetchNode6max(id, line);
