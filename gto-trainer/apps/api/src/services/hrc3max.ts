import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { SNAP_TAU } from "../utils/snapToken/snapToken";

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

export const snapRung = (bb: number): number =>
  RUNGS.reduce((a, b) => (Math.abs(b - bb) < Math.abs(a - bb) ? b : a));

/**
 * Stake -> chart site. The wrapper reports the table's BB in cents once the
 * blind post has calibrated the scale: $2 BB -> ign200, $5 BB -> ign500.
 * Unknown or unusual stakes default to ign200 (per Brady, 2026-08-05).
 */
export const siteFor = (bbCents?: number | null): "ign200" | "ign500" =>
  bbCents != null && bbCents >= 350 ? "ign500" : "ign200";

export interface ChartChoice {
  id: string;
  site: "ign200" | "ign500";
  /** Deep depth D (bb) — the two covering stacks. */
  depth: number;
  /** Short-stack rung s (== depth on the even chart). */
  shortDepth: number;
  shortSeat: "BTN" | "SB" | "BB" | "EQ";
  /** Set when selection had to guess (missing stacks) — ride it to the panel. */
  note: string | null;
}

/**
 * Canonical chart for the observed table state. With sorted stacks a<=b<=c the
 * only valid reduction is capping c to b (chips behind the second stack can
 * never be bet), so the state is "one short + two equal deep": D = mid rung,
 * s = min rung, short seat = argmin. All-equal (or s==D after snapping)
 * collapses to the _eq chart. Stacks the wrapper couldn't read fall back to
 * the even chart at hero's depth (or 100bb), loudly noted.
 */
export function chartFor(hand: ParsedHand, heroPos: string | null): ChartChoice {
  const site = siteFor(hand.bbCents);
  const posOf: Record<number, string> = hand.positions;
  const stacks = hand.stacks ?? {};

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
    const d = snapRung(Number.isFinite(hero) && hero! > 0 ? hero! : 100);
    return {
      id: `${site}_3maxasym_D${d}_s${d}_eq`,
      site,
      depth: d,
      shortDepth: d,
      shortSeat: "EQ",
      note: `stacks unreadable for ${3 - have.length} seat(s) — using the even ${d}bb chart`,
    };
  }

  const sorted = [...have].sort((x, y) => x[1] - y[1]);
  const s = snapRung(sorted[0]![1]);
  const d = snapRung(sorted[1]![1]); // cap the biggest to the middle
  if (s >= d) {
    return {
      id: `${site}_3maxasym_D${d}_s${d}_eq`,
      site,
      depth: d,
      shortDepth: d,
      shortSeat: "EQ",
      note: null,
    };
  }
  const seat = sorted[0]![0];
  return {
    id: `${site}_3maxasym_D${d}_s${s}_${seat.toLowerCase()}`,
    site,
    depth: d,
    shortDepth: s,
    shortSeat: seat,
    note: null,
  };
}

// ---- node fetch ------------------------------------------------------------

export interface HrcNode {
  pos: string | null;
  terminal: boolean;
  actions: { action: string; token: string | null }[];
  cells: { hand: string; actions: Record<string, number> }[];
}

export type GetNode = (line: string) => Promise<HrcNode | null | "unreachable">;

/** line-not-in-solution is a fact about the chart; a dead server is not. */
const nodeCache = new Map<string, HrcNode | null>();
const NODE_CACHE_MAX = 4000;

export function clearNodeCache(): void {
  nodeCache.clear();
}

export const fetchNode: (source: string, line: string) => Promise<HrcNode | null | "unreachable"> =
  async (source, line) => {
    const key = `${source}|${line}`;
    if (nodeCache.has(key)) return nodeCache.get(key)!;
    let body: any;
    try {
      // Generous: the server's first open of a chart pulls a 15-20MB body
      // from R2 and parses it (~3s warm-disk, longer cold). The poller
      // retries the same spot next tick, so a timeout only delays an answer.
      const res = await fetch(
        `${HRC3MAX_BASE}/api/preflop/node?source=${encodeURIComponent(source)}&line=${encodeURIComponent(line)}`,
        { signal: AbortSignal.timeout(30000) }
      );
      body = await res.json();
    } catch {
      return "unreachable";
    }
    const node: HrcNode | null =
      body?.ok === true
        ? {
            pos: body.pos ?? null,
            terminal: body.terminal === true,
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
}

export type Walk3Result =
  | { ok: true; tokens: string[]; repaired: Walk3Repair[]; node: HrcNode }
  | { ok: false; reason: string; missingAt?: string; unreachable?: boolean };

const tokSize = (t: string | null): number | null => {
  const m = t?.match(/^R(\d+(?:\.\d+)?)$/);
  const v = m ? parseFloat(m[1]!) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
};

/**
 * Walk an intended token line through one chart. Mirrors walkPreflopLine's
 * semantics (phantom-X drop, off-tree size snap, terminal checks) but snaps
 * on TOKEN sizes: every HRC aggressive action's token carries its bb amount,
 * including the jam — so "RAI" (our all-in encoding) maps to the node's
 * largest aggressive size, and R<bb> snaps log-nearest under the same τ.
 */
export async function walk3max(intended: string[], getNode: GetNode): Promise<Walk3Result> {
  const out: string[] = [];
  const repaired: Walk3Repair[] = [];

  for (let i = 0; i < intended.length; i++) {
    const line = out.join("-");
    const node = await getNode(line);
    if (node === "unreachable") return { ok: false, reason: "chart server unreachable", unreachable: true };
    if (!node) return { ok: false, reason: "node not in chart", missingAt: line };
    if (node.terminal) return { ok: false, reason: "line continues past a terminal", missingAt: line };

    let tok = intended[i]!;
    const offered = node.actions.map((a) => a.token).filter((t): t is string => t != null);
    if (!offered.includes(tok)) {
      if (tok === "X") continue; // phantom check facing a bet — capture noise
      const sized = offered
        .map((t) => ({ token: t, size: tokSize(t) }))
        .filter((s): s is { token: string; size: number } => s.size != null);
      if (tok === "RAI") {
        // our all-in encoding: the tree's jam is its largest aggressive size
        if (!sized.length) return { ok: false, reason: `all-in not offered (have: ${offered.join(", ")})`, missingAt: line };
        const jam = sized.reduce((a, b) => (b.size > a.size ? b : a));
        repaired.push({ index: i, from: tok, to: jam.token });
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
        if (bestD > SNAP_TAU) {
          return { ok: false, reason: `nearest size ${best.token} is too far from ${tok} (log-dist ${bestD.toFixed(2)} > τ ${SNAP_TAU})`, missingAt: line };
        }
        if (best.token !== tok) repaired.push({ index: i, from: tok, to: best.token });
        tok = best.token;
      }
    }
    out.push(tok);
  }

  const line = out.join("-");
  const node = await getNode(line);
  if (node === "unreachable") return { ok: false, reason: "chart server unreachable", unreachable: true };
  if (!node) return { ok: false, reason: "hero node not in chart", missingAt: line };
  if (node.terminal || !node.pos) {
    return { ok: false, reason: "line ends on a terminal — no pending decision", missingAt: line };
  }
  return { ok: true, tokens: out, repaired, node };
}
