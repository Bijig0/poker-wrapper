import type { HrcNode } from "./hrc3max";

/**
 * NEVER ROLL INTO A BRANCH THE SOLVER NEVER WROTE (2026-09-25, Brady). HRC leaves out every subtree its strategy
 * reaches at ~0% (a 0.4% jam, a 3-bet size it prunes), and the bake now marks those children `pruned`. The roll
 * can legitimately pick such an action for hero's class — and then no tree of ours can continue the hand: the flop
 * has no range for "hands that jam here" and the answer is a miss (audit 2026-09-25: 2 of 1,858 flops). So before
 * the roll, every action whose child is pruned is dropped and the mix is re-spread over the actions that have a
 * subtree, said in the answer's note. Cost: one baked node read per offered action (~0.13 ms each, cached).
 *
 * A fold's child is a genuine terminal, never pruned; a child the getter cannot find is left alone (a missing
 * node is the chart server's business, not a pruned branch). If every action were pruned — impossible while
 * fold exists — the original mix is kept.
 */
export interface PrunedPick { action: string; token: string; frequency: number; kind: "reach" | "cut" }

export async function dropPrunedPicks(
  actions: { action: string; frequency: number }[],
  node: HrcNode,
  line: string,
  get: (line: string) => Promise<HrcNode | null | "unreachable">,
): Promise<{ actions: { action: string; frequency: number }[]; dropped: PrunedPick[] }> {
  const dropped: PrunedPick[] = [];
  const keep: { action: string; frequency: number }[] = [];
  for (const a of actions) {
    const tok = node.actions.find((x) => x.action === a.action)?.token ?? null;
    if (!tok || a.frequency <= 0) { keep.push(a); continue; }
    let child: HrcNode | null | "unreachable" = null;
    try { child = await get(line ? `${line}-${tok}` : tok); } catch { child = null; }
    if (child && child !== "unreachable" && child.pruned) dropped.push({ action: a.action, token: tok, frequency: a.frequency, kind: child.pruned });
    else keep.push(a);
  }
  if (!dropped.length) return { actions, dropped };
  const total = keep.reduce((s, a) => s + a.frequency, 0);
  if (total <= 0) return { actions, dropped: [] };
  // re-spread over the kept actions so the mix keeps its original sum (the chart's cells are percent)
  const sum = actions.reduce((s, a) => s + a.frequency, 0);
  const scale = sum / total;
  return {
    actions: keep.map((a) => ({ action: a.action, frequency: Math.round(a.frequency * scale * 100) / 100 })),
    dropped,
  };
}

/** The note the answer carries when a pick was dropped. */
export const prunedPicksNote = (dropped: PrunedPick[]): string | null =>
  dropped.length
    ? `PICK KEPT ON SOLVED BRANCHES: ${dropped.map((d) => `${d.action} (${d.frequency}%)`).join(", ")} ${dropped.length === 1 ? "leads" : "lead"} into a branch HRC never ` +
      `wrote out (${[...new Set(dropped.map((d) => d.kind))].join("/")}), so the flop could not be answered after it — the mix was re-spread over the actions that have a subtree`
    : null;
