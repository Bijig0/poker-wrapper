/**
 * THE GATE'S VERDICT AGAINST A BASELINE (scripts/replayGate --baseline / --control, 2026-10-13). A decision whose verdict
 * or replayed answer differs between the control's run and this one is a "code diff". The EXIT counts only the ones
 * that BECAME a DIFF, a refusal change or a crash (isCodeFail — unchanged since 2026-10-04): a NEW BODY is what an
 * intended change builds, and the replay cannot price it without GTO Wizard.
 *
 * But the verdict line said a bare PASS over everything else: on 2026-10-13 two gates ran at once on the same dirs and
 * one printed "294 decision(s) differ" — SAME in the control, CACHE-MISS / SKIPPED / NEW BODY in the candidate — then
 * "VERDICT: PASS" (alone: 0 differ). A change that leaves the answer path alone shows 0 here, so the verdict now names
 * every decision that moved, by transition, and says loudly when the PASS has some to check (verdictLines). The exit
 * stays as it was.
 */

export type CodeDiff = { answer: number; hand: string; street: string; was: string; is: string; baseline: string; now: string };

/** the exit rule: a decision that became a DIFF / REFUSAL-CHANGE / CRASH — one the baseline crashed on is the fix */
export const isCodeFail = (d: Pick<CodeDiff, "was" | "is">) => ["DIFF", "REFUSAL-CHANGE", "CRASH"].includes(d.is) && d.was !== "CRASH";

/** the verdicts a run did not compare (the hand stopped, or the request was not in the cache) */
const NOT_COMPARED = new Set(["CACHE-MISS", "SKIPPED", "NEW BODY", "NEW NODE"]);

/** the diffs by transition, the most first: "SAME → CACHE-MISS" 290, "SAME (another replay)" 2 */
export function transitions(diffs: readonly Pick<CodeDiff, "was" | "is">[]): [string, number][] {
  const m = new Map<string, number>();
  for (const d of diffs) { const k = d.was === d.is ? `${d.was} (another replay)` : `${d.was} → ${d.is}`; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
export const fmtTransitions = (diffs: readonly Pick<CodeDiff, "was" | "is">[]) => transitions(diffs).map(([k, n]) => `${k} ${n}`).join(" · ");

/**
 * The --control verdict: `status` is the candidate run's exit (0 / 1 / 2 / anything else), `diffs` its
 * .vs-baseline.json (null when it wrote none). PASS is bare only when nothing differs from the control.
 */
export function verdictLines(commit: string, status: number | null, diffs: readonly CodeDiff[] | null): string[] {
  const head = `VERDICT against ${commit}:`;
  if (status === 2) return [`${head} STOPPED (a session went live)`];
  if (status !== 0 && status !== 1) return [`${head} FAIL (the candidate run exited ${status ?? "on a signal"})`];
  if (!diffs) return [`${head} ${status === 0 ? "PASS" : "FAIL"} (no comparison with the control was written)`];
  const fails = diffs.filter(isCodeFail), rest = diffs.filter((d) => !isCodeFail(d));
  if (status === 1) {
    return [`${head} FAIL (${fails.length ? `${fails.length} decision(s) became DIFF / REFUSAL-CHANGE / CRASH against the control` : "a CRASH in this run"})`,
      ...(fails.length ? [`  ${fmtTransitions(fails)}`] : []),
      ...(rest.length ? [`  and ${rest.length} more changed without failing: ${fmtTransitions(rest)}`] : [])];
  }
  if (!diffs.length) return [`${head} PASS (0 decisions differ from the control)`];
  const uncompared = rest.filter((d) => NOT_COMPARED.has(d.is) && !NOT_COMPARED.has(d.was)).length;
  return [
    `${head} PASS — BUT ${diffs.length} decision(s) changed against the control — CHECK THEM`,
    `  ${fmtTransitions(rest)}`,
    "  (the exit counts only DIFF / REFUSAL-CHANGE / CRASH; a change that leaves the answer path alone shows 0 here)",
    ...(uncompared ? [`  ${uncompared} of them the control compared and this run did not. A CACHE-MISS (and the SKIPPED after it) is the data, not the`,
      "  code — the solve cache copied at another moment than the control's: re-run before trusting this PASS. A NEW BODY / NEW NODE (and the SKIPPED",
      "  after it) is a tree this change builds."] : []),
  ];
}
