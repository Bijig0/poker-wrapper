/**
 * Grade one stress-500 decision from what the run stored (re-gradable at export, so the rules can change without
 * re-running the batch).
 *   refused — no answer: capture-fault / arrival (the flop had no ranges) / timeout / not-hero-turn / other
 *   bad     — an answer that cannot be right: wrong seat, no action or all-zero mix, a mix that does not sum, a check
 *             offered facing a bet, a fold when checking is free, the removed last resort, an empty-mix check failure,
 *             a mis-press (hero's pick is a tree all-in short of hero's stack with a deeper villain outside the tree;
 *             the same tree with another pick is a latent "short-all-in", graded approx)
 *   approx  — answered through a named approximation (collapse, dead money, re-root, pool floor/lock, line fit, untrained
 *             chart node, gap gate, off the chart) or with a failed check / rebuilt path
 *   ok      — answered clean
 * The mix lists only the actions HERO's hand takes (zero-frequency actions are dropped by the answer), so a missing
 * fold is not a fault: AA never folds.
 */
export type Grade = "ok" | "approx" | "refused" | "bad";
const APPROX_KINDS = new Set(["pool-locked limper", "pool lock failed", "pool limp floor", "dead-money collapse", "collapse", "re-rooted", "HU after folds",
  "not narrowed", "all-in left out", "preflop all-in left out", "gap gate", "line fitted", "untrained chart node", "off the chart", "LAST RESORT"]);

export function gradeDecision(d: any): { g: Grade; fl: string[] } {
  const fl: string[] = [];
  const kinds: string[] = d.kinds ?? [];
  if (!d.ok) {
    const why = String(d.reason ?? "");
    if (d.kind === "capture-fault" || /capture gate|internally inconsistent|refused by the capture/i.test(why)) fl.push("capture-fault");
    else if (/walked line ends on villain|not hero'?s turn|after hero acted/i.test(why)) fl.push("not-hero-turn");
    else if (/timed out|timeout|no answer inside/i.test(why)) fl.push("timeout");
    else if (/no collapse to three seats is legal/i.test(why)) fl.push("no-collapse");
    else if (/preflop ranges|PREFLOP PIN|reduced tree|not an action at|preflop node .* terminal|size past|arrival|range reconstruction/i.test(why)) fl.push("arrival");
    else if (/no decision node/i.test(why)) fl.push("no-node");
    else fl.push("other");
    // what the arrival could not do (one refusal can carry both)
    if (/OFF THE CHART \(hero's own line\)/i.test(why)) fl.push("hero-off-chart");
    if (/limped pot has no last raise/i.test(why)) fl.push("limped-pot");
    return { g: "refused", fl };
  }
  const acts: [string, number][] = d.mix ?? [];
  const pos = String(d.pos ?? ""), hero = String(d.hero ?? "");
  if (pos && hero && pos.toUpperCase() !== hero.toUpperCase() && !/^(OOP|IP|OOP\+1|MID)$/i.test(pos)) fl.push("wrong-seat");
  if (!acts.length) fl.push("empty-mix");
  else if (acts.every(([, f]) => !(f > 0))) fl.push("all-zero-mix");
  const sum = acts.reduce((t, [, f]) => t + (f > 0 ? f : 0), 0);
  if (acts.length && Math.abs(sum - 100) > 1.5) fl.push("sum-off");
  const toCall = Number(d.toCall ?? 0);
  const name = (a: string) => a.toUpperCase();
  if (toCall > 0.01 && acts.some(([a, f]) => /^CHECK/.test(name(a)) && f > 0)) fl.push("check-facing-bet");
  if (toCall <= 0.01 && acts.some(([a, f]) => /^FOLD/.test(name(a)) && f > 0.5)) fl.push("fold-when-free");
  if ((d.pcodes ?? []).some((c: string) => /last-resort/i.test(c)) || kinds.includes("LAST RESORT")) fl.push("last-resort");
  // the tree's all-in is short of hero's chips with a deeper villain outside the tree: a MIS-PRESS when hero's pick is
  // that all-in (the button would push more than the tree priced), a latent SHORT ALL-IN otherwise
  if (d.mp) fl.push(/^ALL-?IN/i.test(String(d.pick ?? "")) ? "mis-press" : "short-all-in");
  const failed = (d.cf ?? []).filter((c: any) => c.s === "fail").map((c: any) => `check#${c.id}`);
  for (const c of new Set<string>(failed)) fl.push(c);
  if (d.pv === "failed" || d.pv === "fault") fl.push(`path-${d.pv}`);
  if (Number(d.ms) > 15_000) fl.push("over-15s");
  const bad = fl.some((f) => /^(wrong-seat|empty-mix|all-zero-mix|sum-off|check-facing-bet|fold-when-free|last-resort|mis-press)$/.test(f) || f === "check#15");
  if (bad) return { g: "bad", fl };
  const approx = kinds.some((k) => APPROX_KINDS.has(k)) || failed.length > 0 || d.pv === "rebuilt" || fl.includes("short-all-in");
  return { g: approx ? "approx" : "ok", fl };
}
