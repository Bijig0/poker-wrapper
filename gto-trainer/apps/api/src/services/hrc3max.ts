import { timed } from "./answerTrace";
import { factoryFile } from "./repoPaths";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { SNAP_MAX, SNAP_TAU } from "../utils/snapToken/snapToken";
import { dealtBySeat } from "../utils/archivedHand/archivedHand";

/**
 * Client for the asymmetric 3-max HRC chart corpus, served by the solve-DB
 * server (analysis/pipeline/solve/exploit_ui/server.py, :8777). The corpus is
 * the full canonical-state grid — 21 depth rungs x short-stack rung x short
 * seat x {ign200, ign500} rake — 1302 solutions, each a rich preflop tree
 * (limps on, odd sizes, jams) with per-class strategies at every node.
 *
 * This module owns three things:
 *   1. chart SELECTION — table stake -> ign200/ign500, observed per-seat
 *      stacks -> the canonical (deep D, short s, short seat) chart id;
 *   2. node FETCH via GET /api/preflop/node?source=<id>&line=<tokens>, with
 *      a small in-process cache (nodes are ~10KB; the server holds the fat
 *      docs in its own LRU and lazily pulls bodies from R2 on first open);
 *   3. the line WALK. HRC trees differ from the GTOW walk's assumptions in
 *      one way that matters: the all-in action's token is R<jam-bb>, never
 *      the literal "RAI", and sizes live in the tokens themselves — so this
 *      walker snaps off-tree sizes by token size (log-space, same τ) instead
 *      of reusing walkPreflopLine's label-based snap.
 */

export const HRC3MAX_BASE = process.env.HRC3MAX_URL ?? "http://127.0.0.1:8777";

/** The solved depth ladder (bb). 20..110 by 5, then the deep 125/150 band. */
export const RUNGS = [
  20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 125, 150,
];
/** The NL25 grid (ledger `grid-nl25` + `-rungs` + `-asym`) was solved at Ignition's
 *  3-handed NL25 rake (5%, cap 4bb) and reaches two rungs FURTHER than the NL200
 *  ladder — 175 and 200bb, which the miss queue kept asking for. */
export const RUNGS_IGN25 = [
  20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 125, 150, 175, 200,
];
export type Site = "ign25" | "ign200" | "ign500";
const rungsFor = (site: Site): number[] => (site === "ign25" ? RUNGS_IGN25 : RUNGS);

export const snapRung = (bb: number, site: Site = "ign200"): number =>
  rungsFor(site).reduce((a, b) => (Math.abs(b - bb) < Math.abs(a - bb) ? b : a));

/**
 * Stake -> chart site, which is really "which RAKE was this solved at".
 * The wrapper reports the table's BB in cents once the blind post has calibrated
 * the scale: $0.25 BB -> ign25 (5%, cap 4bb), $2 -> ign200 (cap 1bb), $5 ->
 * ign500 (cap 0.4bb). Unknown or unusual stakes default to ign200 (Brady,
 * 2026-08-05). ign25 added 2026-09-14 with the `cutover-nl25` step: until then
 * NL25 Zone — the stake we actually play — answered from the NL200 grid, four
 * times off on the cap. NL50 is left on ign200 deliberately: its 3-handed cap is
 * also 4bb, so the ign25 charts would fit it, but that has not been verified
 * against a hand.
 */
export const siteFor = (bbCents?: number | null): Site =>
  bbCents == null ? "ign200" : bbCents >= 350 ? "ign500" : bbCents <= 25 ? "ign25" : "ign200";

export interface ChartChoice {
  id: string;
  site: Site;
  /** Deep depth D (bb) — the two covering stacks. */
  depth: number;
  /** Short-stack rung s (== depth on the even chart). */
  shortDepth: number;
  shortSeat: "BTN" | "SB" | "BB" | "EQ";
  /** Set when selection had to guess (missing stacks) — ride it to the panel. */
  note: string | null;
  /** The observed deep-pair depth (bb) when it lies past the last rung — the
   *  chart answers from that rung, and the miss queue records the state. */
  beyondLadder: number | null;
}

/** Past this depth the deepest chart is a guess, not a snap. */
const ladderTop = (site: Site): number => rungsFor(site)[rungsFor(site).length - 1]! + 10;

/**
 * Canonical chart for the observed table state. With sorted stacks a<=b<=c the
 * only valid reduction is capping c to b (chips behind the second stack can
 * never be bet), so the state is "one short + two equal deep": D = mid rung,
 * s = min rung, short seat = argmin. All-equal (or s==D after snapping)
 * collapses to the _eq chart. Stacks the wrapper couldn't read fall back to
 * the even chart at hero's depth (or 100bb), loudly noted.
 */

/**
 * The re-solved chart generation ("v2ci": real river betting + explicit CFR
 * refinement, vs the original grid's no-river-betting + CI-10 auto-solve).
 *
 * These are EQUAL-STACK charts on the traffic-ranked rungs, because chartFor
 * snaps to the deep rung and Zone stacks cluster there: six rungs cover 88%
 * of corpus hands and ten cover 96.5%, where the most-used exact asymmetric
 * chart is 4.8%. So when a state's deep rung has a v2ci chart, that chart is
 * a better answer than a same-shaped chart from the defective generation —
 * even for an asymmetric state, since the asymmetry it drops is a smaller
 * error than the missing river betting it fixes. States whose rung has no
 * v2ci chart keep the original asymmetric chart untouched.
 *
 * V2CI_RUNGS is the manifest of what has actually been solved; RESOLVED_OFF=1
 * disables the preference entirely (A/B the generations).
 */
function loadV2ciRungs(): Record<string, Set<number>> {
  const fallback = { ign200: new Set([100]), ign500: new Set<number>() };
  try {
    const raw = JSON.parse(require("node:fs").readFileSync(factoryFile("resolved-charts.json"), "utf-8")) as Record<string, number[]>;
    const out: Record<string, Set<number>> = {};
    for (const [site, rungs] of Object.entries(raw)) out[site] = new Set(rungs);
    return Object.keys(out).length ? out : fallback;
  } catch {
    return fallback;   // manifest absent = only the hand-verified D100 chart
  }
}
const V2CI_RUNGS: Record<string, Set<number>> = loadV2ciRungs();

const v2ciId = (site: string, d: number): string | null =>
  !process.env.RESOLVED_OFF && V2CI_RUNGS[site]?.has(d)
    ? `${site}_3maxasym2ci_D${d}_s${d}_eq`
    : null;

/**
 * The ign25 set has ONE generation. `grid-nl25` solved it with the v2ci recipe
 * from the start (real river betting, explicit CFR) at the NL25 rake, so there
 * is no defective generation to prefer the even chart over: when the exact
 * uneven chart was solved it is simply the better answer, and the v2ci
 * even-chart preference above must NOT apply. The uneven grid is traffic-ranked,
 * not a full cross product (150 charts over 9 deep rungs), so the id is checked
 * against the catalog and falls back to the even chart at the deep rung.
 */
let IGN25_IDS: Set<string> | null = null;
function ign25Ids(): Set<string> {
  if (IGN25_IDS) return IGN25_IDS;
  try {
    const { getCatalog } = require("./chartCatalog") as typeof import("./chartCatalog");
    IGN25_IDS = new Set((getCatalog().entries as { id: string }[])
      .map((e) => String(e.id)).filter((id) => id.startsWith("ign25_3maxasym2ci_")));
  } catch {
    IGN25_IDS = new Set();   // catalog unavailable: even charts only
  }
  return IGN25_IDS;
}
/** Test hook: which ign25 uneven charts count as solved (null = read the catalog again). The catalog is the chart
 *  index on this machine — a data download, not in git — so a test names the charts it needs. */
export function setIgn25Ids(ids: Iterable<string> | null): void { IGN25_IDS = ids ? new Set(ids) : null; }

/** The chart id for a canonical state (deep rung d, short rung s, short seat). */
function chartIdFor(site: Site, d: number, s: number, seat: "BTN" | "SB" | "BB" | null): string {
  if (site === "ign25") {
    if (seat && s < d) {
      const id = `ign25_3maxasym2ci_D${d}_s${s}_${seat.toLowerCase()}`;
      if (ign25Ids().has(id)) return id;
    }
    return `ign25_3maxasym2ci_D${d}_s${d}_eq`;
  }
  if (!seat || s >= d) return v2ciId(site, d) ?? `${site}_3maxasym_D${d}_s${d}_eq`;
  return v2ciId(site, d) ?? `${site}_3maxasym_D${d}_s${s}_${seat.toLowerCase()}`;
}

/** One chart per HAND. The stack state that picks a chart is the state the
 *  hand was DEALT at; re-reading live stacks every tick drifted hand
 *  4917810302 (2026-09-12) from the 100bb chart at the open to 95bb at the
 *  4-bet and — with the 5-bettor's stack reading 0 after his jam — to the
 *  75bb chart at the jam, where 76s had no 4-bet range and the answer was
 *  "not in range" at a 48bb decision. Pinned the moment a full reading
 *  exists (hero's first decision), keyed by the site's hand id. */
const PINNED = new Map<string, ChartChoice>();
const PINNED_MAX = 64;
const pinKey = (hand: ParsedHand): string | null =>
  hand.clientHandId ? `c:${hand.clientHandId}` : hand.handId ? `h:${hand.handId}` : null;
/** Test hook: forget every pinned chart. */
export function resetChartPins(): void { PINNED.clear(); }

export function chartFor(hand: ParsedHand, heroPos: string | null): ChartChoice {
  const key = pinKey(hand);
  const pinned = key ? PINNED.get(key) : undefined;
  if (pinned) return pinned;
  const { pinnable, ...choice } = chooseChart(hand, heroPos);
  if (key && pinnable !== false) {
    PINNED.set(key, choice);
    if (PINNED.size > PINNED_MAX) PINNED.delete(PINNED.keys().next().value!);
  }
  return choice;
}

function chooseChart(hand: ParsedHand, heroPos: string | null): ChartChoice & { pinnable?: boolean } {
  const site = siteFor(hand.bbCents);
  const posOf: Record<number, string> = hand.positions;
  const stacks = dealtBySeat(hand);   // behind + this round + EARLIER STREETS (its own copy left those out)

  const byPos: Partial<Record<"BTN" | "SB" | "BB", number>> = {};
  for (const [seat, pos] of Object.entries(posOf)) {
    const p = pos.toUpperCase();
    if (p === "BTN" || p === "SB" || p === "BB") {
      const v = stacks[Number(seat)];
      if (Number.isFinite(v) && v! > 0) byPos[p] = v!;
    }
  }
  // hero's own seat may be unlabeled in positions (row-parsed hands) — patch
  // it in from the override so a readable hero stack still counts.
  if (heroPos) {
    const p = heroPos.toUpperCase();
    if ((p === "BTN" || p === "SB" || p === "BB") && byPos[p] == null) {
      const v = stacks[hand.heroSeatId];
      if (Number.isFinite(v) && v > 0) byPos[p] = v;
    }
  }

  const have = Object.entries(byPos) as ["BTN" | "SB" | "BB", number][];
  if (have.length < 3) {
    const hero = stacks[hand.heroSeatId];
    const d = snapRung(Number.isFinite(hero) && hero! > 0 ? hero! : 100, site);
    // a guess is never pinned: the next tick may read the missing seat
    return {
      id: chartIdFor(site, d, d, null),
      site,
      depth: d,
      shortDepth: d,
      shortSeat: "EQ",
      note: `stacks unreadable for ${3 - have.length} seat(s) — using the even ${d}bb chart`,
      beyondLadder: null,
      pinnable: false,
    };
  }

  const sorted = [...have].sort((x, y) => x[1] - y[1]);
  const s = snapRung(sorted[0]![1], site);
  const d = snapRung(sorted[1]![1], site); // cap the biggest to the middle
  const mid = Math.round(sorted[1]![1]);
  const beyondLadder = mid > ladderTop(site) ? mid : null;
  const topRung = rungsFor(site)[rungsFor(site).length - 1];
  const beyondNote = beyondLadder != null
    ? `deep stacks ${mid}bb are past the ${topRung}bb rung — answered from the ${d}bb chart (miss queued)`
    : null;
  if (s >= d) {
    return {
      id: chartIdFor(site, d, d, null),
      site,
      depth: d,
      shortDepth: d,
      shortSeat: "EQ",
      note: beyondNote,
      beyondLadder,
    };
  }
  const seat = sorted[0]![0];
  const id = chartIdFor(site, d, s, seat);
  // an even id for an uneven state means the asymmetry was dropped: say so.
  // ign200/ign500 drop it on purpose (the re-solved even chart beats a
  // same-shaped chart from the defective generation); ign25 drops it only when
  // that exact uneven state was never solved.
  const approximated = id.endsWith("_eq");
  return {
    id,
    site,
    depth: d,
    shortDepth: s,
    shortSeat: seat,
    note: [approximated
      ? site === "ign25"
        ? `no solved D${d}/s${s}/${seat} chart — using the even ${d}bb chart (asymmetry approximated)`
        : `re-solved ${d}bb even chart (${seat} is short at ${s}bb — asymmetry approximated; this generation has real river betting)`
      : null, beyondNote].filter(Boolean).join(" ") || null,
    beyondLadder,
  };
}

// ---- node fetch ------------------------------------------------------------

export interface HrcNode {
  pos: string | null;
  terminal: boolean;
  /** A terminal the CHART ends while a seat is still to act (2026-09-25, hand 4920396764) — never a real close.
   *  "reach": HRC left the subtree out under its reach threshold; "cut": the solved tree's own caps stop a line
   *  real play reaches. `terminal` stays true on these (a walk that meets one followed only by folds has reached
   *  the flop). Set by analysis/pipeline/solve/preflop_closure.py via the converter and the bake. */
  pruned?: "reach" | "cut";
  actions: { action: string; token: string | null }[];
  cells: { hand: string; actions: Record<string, number> }[];
}

export type GetNode = (line: string) => Promise<HrcNode | null | "unreachable">;

/** line-not-in-solution is a fact about the chart; a dead server is not. */
const nodeCache = new Map<string, HrcNode | null>();
const NODE_CACHE_MAX = 4000;

export const fetchNode: (source: string, line: string) => Promise<HrcNode | null | "unreachable"> =
  async (source, line) => {
    const key = `${source}|${line}`;
    if (nodeCache.has(key)) return nodeCache.get(key)!;
    let body: any;
    // Two attempts: a chart's first open pulls a 15-20MB body from R2 and
    // parses it (~3s warm-disk, much longer cold or under batch load). The
    // corpus audit showed a single timeout here cascades into the 6-max
    // fallback with a misleading "no chart @ 200bb" error — the retry rides
    // out the cold pull the first attempt itself triggered.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await timed(`chart node ${source} [${line || "root"}]${attempt ? " (retry)" : ""}`, () => fetch(
          `${HRC3MAX_BASE}/api/preflop/node?source=${encodeURIComponent(source)}&line=${encodeURIComponent(line)}`,
          { signal: AbortSignal.timeout(30000) }
        ), (r) => `HTTP ${r.status}`);
        body = await res.json();
        break;
      } catch {
        if (attempt === 1) return "unreachable";
      }
    }
    const node: HrcNode | null =
      body?.ok === true
        ? {
            pos: body.pos ?? null,
            terminal: body.terminal === true,
            ...(body.pruned === true ? { pruned: body.prunedKind === "reach" ? "reach" as const : "cut" as const } : {}),
            actions: (body.actions ?? []).map((a: any) => ({
              action: String(a.action ?? ""),
              token: a.token != null ? String(a.token) : null,
            })),
            cells: (body.cells ?? []).map((c: any) => ({
              hand: String(c.hand ?? ""),
              actions: (c.actions ?? {}) as Record<string, number>,
            })),
          }
        : null;
    nodeCache.set(key, node);
    if (nodeCache.size > NODE_CACHE_MAX) {
      const oldest = nodeCache.keys().next().value;
      if (oldest !== undefined) nodeCache.delete(oldest);
    }
    return node;
  };

// ---- the walk --------------------------------------------------------------

export interface Walk3Repair {
  index: number;
  from: string;
  to: string;
  /** |ln(want/chosen)| — 0 for a jam mapped onto the node's largest size */
  logDist: number;
  /** past τ: the snap was made anyway (it beats no answer) but it costs EV,
   *  and the answer must say so. See SNAP_MAX in utils/snapToken. */
  far: boolean;
  /** a CALL the tree has no branch for, read one caller fewer: this is the seat whose earlier call was
   *  folded to reach a node that offers it (`from` "C" -> `to` "F" at `index`). See WalkOpts.borrowCaller. */
  borrowed?: string;
}

export interface WalkOpts {
  /**
   * BORROW AT THE WALK (2026-09-22). The 6-max trees cap how many players may call or limp behind
   * (`ALLOWED_FLATS_PER_RAISE`: two limpers, two cold-callers of an open). A VILLAIN's third call used to
   * end the walk — "action C not offered" — before it ever reached hero, so the spot had no answer at all.
   * With this on, the walk folds the EARLIEST other caller out of the path and reads the call at the node
   * that leaves: the same seat, the same price, one caller fewer — the shortcut reconstructFlopRanges and
   * borrowHeroCall already use. Accepted only when the donor node is the SAME seat and offers the call.
   * Known direction of error: one player and his chips fewer in the pot, so hero's continuing range reads a
   * little tight. Every borrow is recorded in `repaired` so the answer can say so.
   */
  borrowCaller?: boolean;
}

export type Walk3Result =
  | { ok: true; tokens: string[]; repaired: Walk3Repair[]; node: HrcNode }
  | { ok: false; reason: string; missingAt?: string; unreachable?: boolean };

const tokSize = (t: string | null): number | null => {
  const m = t?.match(/^R(\d+(?:\.\d+)?)$/);
  const v = m ? parseFloat(m[1]!) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** The suffix a terminal refusal carries when the chart, not the betting, ended the line — the reason text
 *  before it is unchanged so answerLog's needles keep matching. */
export const prunedNote = (node: HrcNode): string =>
  node.pruned === "reach" ? " (pruned: HRC never exported this branch — the chart plays it ~0%, a seat is still to act)"
  : node.pruned === "cut" ? " (cut: the solved tree stops here although a seat is still to act)"
  : "";

/**
 * Walk an intended token line through one chart. Mirrors walkPreflopLine's
 * semantics (phantom-X drop, off-tree size snap, terminal checks) but snaps
 * on TOKEN sizes: every HRC aggressive action's token carries its bb amount,
 * including the jam — so "RAI" (our all-in encoding) maps to the node's
 * largest aggressive size, and R<bb> snaps log-nearest.
 *
 * A snap within τ is clean and passes silently. A snap PAST τ is still made —
 * a flagged answer beats no answer — and comes back with `far: true` so the
 * caller can warn and the miss queue can file the size as worth solving. Only
 * past SNAP_MAX (~2x off) does the walk refuse.
 */
export async function walk3max(intended: string[], getNode: GetNode, opts: WalkOpts = {}): Promise<Walk3Result> {
  let out: string[] = [];
  const posAt: (string | null)[] = [];   // who took each walked token — the borrow must not fold hero's seat's own call
  const repaired: Walk3Repair[] = [];

  for (let i = 0; i < intended.length; i++) {
    const line = out.join("-");
    const node = await getNode(line);
    if (node === "unreachable") return { ok: false, reason: "chart server unreachable", unreachable: true };
    // A FORCED FOLD HAS NO NODE (2026-09-22). The trees run maxactive=4: a player who would be the fifth to
    // enter the pot is folded by the engine without a decision, and since the re-key those folds sit in the
    // line keys where they belong (`F-R2.5-C-C-R7.5-F`) with no node at `F-R2.5-C-C-R7.5`. So when the node
    // is missing and the line's next action IS a fold, that is the forced fold — step through it. Anything
    // else missing is a genuine gap and still stops the walk.
    // …and forced folds come in CHAINS: once four have entered, every seat still to act is folded (SB and BB
    // both, after `C-C-R5-C`), so step through as many of the line's consecutive folds as it takes to land.
    if (!node && intended[i] === "F" && line) {
      let run = 0;
      while (intended[i + run] === "F") run++;
      let landed = 0;
      for (let k = 1; k <= run; k++) {
        const through = await getNode(`${line}${"-F".repeat(k)}`);
        if (through && through !== "unreachable") { landed = k; break; }
      }
      if (landed) {
        for (let k = 0; k < landed; k++) { out.push("F"); posAt.push(null); }
        i += landed - 1;
        continue;
      }
    }
    if (!node) return { ok: false, reason: "node not in chart", missingAt: line };
    if (node.terminal) return { ok: false, reason: `line continues past a terminal${prunedNote(node)}`, missingAt: line };

    let tok = intended[i]!;
    const offered = node.actions.map((a) => a.token).filter((t): t is string => t != null);
    if (tok === "C" && !offered.includes("C") && opts.borrowCaller) {
      let donor: { path: string[]; j: number } | null = null;
      for (let j = 0; j < out.length && !donor; j++) {
        if (out[j] !== "C" || posAt[j] === node.pos) continue;
        const path = out.slice(); path[j] = "F";
        const alt = await getNode(path.join("-"));
        if (!alt || alt === "unreachable" || alt.terminal || alt.pos !== node.pos) continue;
        if (!alt.actions.some((a) => a.token === "C")) continue;
        donor = { path, j };
      }
      if (donor) {
        repaired.push({ index: donor.j, from: "C", to: "F", logDist: 0, far: false, borrowed: posAt[donor.j] ?? undefined });
        out = donor.path;
        out.push("C"); posAt.push(node.pos ?? null);
        continue;
      }
    }
    if (!offered.includes(tok)) {
      if (tok === "X") continue; // phantom check facing a bet — capture noise
      const sized = offered
        .map((t) => ({ token: t, size: tokSize(t) }))
        .filter((s): s is { token: string; size: number } => s.size != null);
      if (tok === "RAI") {
        // our all-in encoding: the tree's jam is its largest aggressive size
        if (!sized.length) return { ok: false, reason: `all-in not offered (have: ${offered.join(", ")})`, missingAt: line };
        const jam = sized.reduce((a, b) => (b.size > a.size ? b : a));
        repaired.push({ index: i, from: tok, to: jam.token, logDist: 0, far: false });
        tok = jam.token;
      } else {
        const want = tokSize(tok);
        if (want == null || !sized.length) {
          return { ok: false, reason: `action "${tok}" not offered (have: ${offered.join(", ")})`, missingAt: line };
        }
        let best = sized[0]!;
        let bestD = Math.abs(Math.log(want / best.size));
        for (const s of sized.slice(1)) {
          const dd = Math.abs(Math.log(want / s.size));
          if (dd < bestD) { best = s; bestD = dd; }
        }
        // Past τ the snap is no longer clean — but refusing outright means NO
        // answer, which is strictly worse right up to the point where the
        // snapped node stops resembling the real spot. So snap anyway, mark it
        // `far`, and only give up beyond SNAP_MAX (see utils/snapToken).
        if (bestD > SNAP_MAX) {
          return { ok: false, reason: `nearest size ${best.token} is more than 2x away from ${tok} (log-dist ${bestD.toFixed(2)} > ${SNAP_MAX.toFixed(2)})`, missingAt: line };
        }
        if (best.token !== tok) repaired.push({ index: i, from: tok, to: best.token, logDist: bestD, far: bestD > SNAP_TAU });
        tok = best.token;
      }
    }
    out.push(tok); posAt.push(node.pos ?? null);
  }

  let line = out.join("-");
  let node = await getNode(line);
  if (node === "unreachable") return { ok: false, reason: "chart server unreachable", unreachable: true };
  // HERO AS THE FIFTH ENTRANT. The trees run maxactive=4: a player who would be the fifth to put money in
  // gets a forced fold and no decision node at all — so the BB facing an open, two calls and a squeeze has
  // nothing to read. Same borrow as above, one level up: fold the earliest caller so hero is the fourth
  // entrant, and read his node there. The caller (fastSolve) still checks the node is hero's seat.
  if (!node && opts.borrowCaller) {
    for (let j = 0; j < out.length; j++) {
      if (out[j] !== "C") continue;
      const path = out.slice(); path[j] = "F";
      const alt = await getNode(path.join("-"));
      if (!alt || alt === "unreachable" || alt.terminal || !alt.pos) continue;
      repaired.push({ index: j, from: "C", to: "F", logDist: 0, far: false, borrowed: posAt[j] ?? undefined });
      out = path; line = path.join("-"); node = alt;
      break;
    }
  }
  if (!node) return { ok: false, reason: "hero node not in chart", missingAt: line };
  if (node.terminal || !node.pos) {
    return { ok: false, reason: `line ends on a terminal — no pending decision${prunedNote(node)}`, missingAt: line };
  }
  return { ok: true, tokens: out, repaired, node };
}
