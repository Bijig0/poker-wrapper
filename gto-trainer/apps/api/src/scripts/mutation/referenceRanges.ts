/**
 * THE REFERENCE WALKER (2026-09-25, round 2 of the input-mutation harness). An independent, deliberately simple
 * reconstruction of every seat's class → weight range from ONE baked 6-max chart and the line as it was DEALT (the
 * generator's own actions, never the capture), used as the oracle the pipeline's ranges are compared against.
 *
 * It shares no code with the pipeline's walks (utils/reconstructFlopRanges, utils/fitLine, services/preflopPin) on
 * purpose: no fitting, no caller borrowing, no pin, no snapping rule beyond "the nearest offered size". Where the
 * pipeline has to approximate (a line past the tree's caps, a borrowed caller, a kept chart) this walker simply
 * STOPS and says why; the harness then expects the pipeline's answer to name that approximation.
 *
 * The rules, each the documented meaning of a chart walk:
 *   - the tree names who acts; a tree seat nobody was dealt folds (5- and 4-handed tables are the 6-max tree with
 *     the empty seats folded); a tree seat that is not the next actor at the table is a rotation error → stop;
 *   - fold / check / call take the node's own action; a call the node does not offer → stop (the tree's caller cap);
 *   - an all-in that does not raise the price (a call for less, or exactly the price) is a CALL;
 *   - an all-in that raises takes the node's all-in action (label "All-in"/"Allin …"); a node with none → stop;
 *   - any other raise takes the offered aggressive size nearest in log distance (the all-in included, at its token's
 *     size);
 *   - a seat's range is the product of its class's frequencies at each of its decisions (a class the node lists no
 *     cell for has weight 0). A villain's non-all-in raise is conditioned on ALL the node's non-all-in raise sizes
 *     (the pipeline's documented villain-size merge, reconstructFlopRanges.ReconstructOpts.heroPos: a human uses one
 *     size, so his raise range is the union of the chart's raise branches); hero's on the exact size he took;
 *   - a terminal node before the line ends is fine only if nothing but folds follow (the players at the flop are
 *     known), otherwise → stop; a missing node before a fold is the engine's forced fold → the fold is stepped over.
 */
import type { RawNode } from "../../utils/reconstructFlopRanges/reconstructFlopRanges";

export interface RefAction {
  pos: string;
  /** F fold, X check, C call, R raise/bet, A all-in */
  kind: "F" | "X" | "C" | "R" | "A";
  /** R and A: the total this seat has in on the street after the action (bb) */
  to?: number;
}
export interface RefStep { line: string; pos: string; kind: RefAction["kind"]; to?: number; token: string; label: string; labels: string[] }
export type RefResult =
  | { ok: true; ranges: Record<string, Record<string, number>>; path: string[]; steps: RefStep[]; atFlop: string[]; pendingNode: RawNode | null }
  | { ok: false; why: string; path: string[]; steps: RefStep[] };

const jam = (label: string) => /all-?in/i.test(label);
const sizeOf = (token: string | null): number | null => { const m = /^R([\d.]+)$/.exec(token ?? ""); return m ? Number(m[1]) : null; };

/**
 * Walk `actions` (preflop, in table order, no posts) on `get`. `dealt` = the positions dealt this hand; `heroPos`
 * = hero's seat (his raises are not merged). With `pending`, the walk stops at the node after the last action and
 * returns it (hero's pending decision) instead of requiring the line to reach the flop.
 */
export async function referenceRanges(
  actions: RefAction[],
  get: (line: string) => Promise<RawNode | null>,
  o: { dealt: string[]; heroPos: string; pending?: boolean },
): Promise<RefResult> {
  const dealt = new Set(o.dealt.map((p) => p.toUpperCase()));
  const hero = o.heroPos.toUpperCase();
  const path: string[] = [];
  const steps: RefStep[] = [];
  const ranges = new Map<string, Map<string, number>>();
  const last = new Map<string, string>();
  let level = 1; // the price preflop: the big blind
  let i = 0;
  const stop = (why: string): RefResult => ({ ok: false, why, path: [...path], steps });
  while (i < actions.length) {
    const a = actions[i]!;
    const pos = a.pos.toUpperCase();
    const node = await get(path.join("-"));
    if (!node) {
      // the engine's forced fold: no node, the next action is a fold → step over it
      if (a.kind === "F" && path.length) { path.push("F"); last.set(pos, "F"); i++; continue; }
      return stop(`no node at "${path.join("-") || "root"}"`);
    }
    if (node.terminal) {
      if (actions.slice(i).every((x) => x.kind === "F")) { for (const x of actions.slice(i)) last.set(x.pos.toUpperCase(), "F"); break; }
      return stop(`terminal at "${path.join("-") || "root"}" with ${actions.length - i} action(s) left`);
    }
    const np = String(node.pos ?? "").toUpperCase();
    if (np && !dealt.has(np)) {
      if (!node.actions.some((x) => x.token === "F")) return stop(`the undealt ${np} cannot fold at "${path.join("-")}"`);
      path.push("F"); continue;
    }
    if (np !== pos) return stop(`rotation: the tree has ${np || "nobody"} to act at "${path.join("-") || "root"}", the table ${pos}`);
    const kind = a.kind === "A" && !((a.to ?? 0) > level + 0.01) ? "C" : a.kind;
    let pickTok: string | null = null, label = "";
    if (kind === "F" || kind === "X" || kind === "C") {
      const x = node.actions.find((y) => y.token === kind);
      if (!x) return stop(`${pos}'s ${kind} is not offered at "${path.join("-") || "root"}"`);
      pickTok = kind; label = x.action;
    } else if (kind === "A") {
      const x = node.actions.find((y) => jam(y.action));
      if (!x) return stop(`${pos}'s all-in has no all-in action at "${path.join("-") || "root"}"`);
      pickTok = x.token; label = x.action;
    } else {
      const want = a.to ?? NaN;
      let best: { token: string; action: string } | null = null, bd = Infinity;
      for (const y of node.actions) {
        const s = sizeOf(y.token);
        if (s == null || !(want > 0)) continue;
        const d = Math.abs(Math.log(want / s));
        if (d < bd) { bd = d; best = { token: y.token!, action: y.action }; }
      }
      if (!best) return stop(`${pos}'s raise to ${want} has no sized action at "${path.join("-") || "root"}"`);
      pickTok = best.token; label = best.action;
    }
    // the range: hero on his exact label; a villain's non-jam raise on every non-jam raise size at the node
    const merged = pos !== hero && sizeOf(pickTok) != null && !jam(label);
    const labels = merged ? node.actions.filter((y) => sizeOf(y.token) != null && !jam(y.action)).map((y) => y.action) : [label];
    steps.push({ line: path.join("-"), pos, kind: a.kind, to: a.to, token: pickTok!, label, labels });
    if (pickTok !== "F") {
      const prev = ranges.get(pos) ?? null;
      const next = new Map<string, number>();
      for (const cell of node.cells) {
        const pct = labels.reduce((s, l) => s + (cell.actions[l] ?? 0), 0);
        if (!(pct > 0)) continue;
        const prior = prev ? prev.get(cell.hand) ?? 0 : 1;
        if (!(prior > 0)) continue;
        next.set(cell.hand, prior * Math.min(1, pct / 100));
      }
      ranges.set(pos, next);
    }
    if (kind === "R" || kind === "A") level = Math.max(level, a.to ?? level);
    last.set(pos, pickTok!);
    path.push(pickTok!);
    i++;
  }
  let pendingNode: RawNode | null = null;
  if (o.pending) {
    // skip the undealt seats' folds up to the node that is someone's decision
    for (let guard = 0; guard < 8; guard++) {
      const n = await get(path.join("-"));
      if (!n || n.terminal) break;
      const np = String(n.pos ?? "").toUpperCase();
      if (np && !dealt.has(np) && n.actions.some((x) => x.token === "F")) { path.push("F"); continue; }
      pendingNode = n; break;
    }
  }
  const atFlop = [...last.entries()].filter(([, t]) => t !== "F").map(([p]) => p);
  const out: Record<string, Record<string, number>> = {};
  for (const p of atFlop) out[p] = Object.fromEntries(ranges.get(p) ?? new Map());
  return { ok: true, ranges: out, path, steps, atFlop, pendingNode };
}

/** The largest per-class difference between two class → weight ranges (a class missing on one side counts as 0). */
export function rangeDiff(a: Record<string, number>, b: Record<string, number>): { max: number; cls: string | null; a: number; b: number } {
  let max = 0, cls: string | null = null, va = 0, vb = 0;
  for (const c of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[c] ?? 0, y = b[c] ?? 0, d = Math.abs(x - y);
    if (d > max) { max = d; cls = c; va = x; vb = y; }
  }
  return { max, cls, a: va, b: vb };
}
