/**
 * THE GATE'S VERDICT AGAINST A BASELINE (scripts/replayGate --baseline / --control, 2026-10-13). A decision whose verdict
 * or replayed answer differs between the control's run and this one is a "code diff". The EXIT counts only the ones
 * that BECAME a DIFF, a refusal change or a crash (isCodeFail — unchanged since 2026-10-04): a NEW BODY is what an
 * intended change builds, and the replay cannot price it without GTO Wizard.
 *
 * But the verdict line said a bare PASS over everything else: on 2026-10-13 two gates ran at once on the same dirs and
 * one printed "294 decision(s) differ" — SAME in the control, CACHE-MISS / SKIPPED / NEW BODY in the candidate — then
 * "VERDICT: PASS" (alone: 0 differ). A change that leaves the answer path alone shows 0 here, so the verdict now names
 * every decision that moved, by transition, and says loudly when the PASS has some to check (gateVerdict) — and the
 * decisions only one side replayed, which the comparison skips. The exit stays as it was, but for a 0 whose comparison
 * could not be read (a FAIL: there is no verdict without it).
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
 * The --control verdict and the exit: `status` is the candidate run's exit (0 / 1 / 2 / anything else), `diffs` its
 * .vs-baseline.json (null when none could be read), `oneSided` the decisions only one of the two runs replayed (the
 * comparison skips them). PASS is bare only when nothing differs. The exit is the candidate's, except a 0 whose
 * comparison could not be read: that is no PASS (exit 1 — the candidate writes it before it exits 0).
 */
export function gateVerdict(commit: string, status: number | null, diffs: readonly CodeDiff[] | null, oneSided = 0): { lines: string[]; exit: number } {
  const head = `VERDICT against ${commit}:`;
  if (status === 2) return { lines: [`${head} STOPPED (a session went live)`], exit: 2 };
  if (status !== 0 && status !== 1) return { lines: [`${head} FAIL (the candidate run exited ${status ?? "on a signal"})`], exit: status ?? 1 };
  if (!diffs) return { lines: [`${head} FAIL (${status === 0 ? "the candidate exited 0, but " : ""}its comparison with the control could not be read)`], exit: 1 };
  const fails = diffs.filter(isCodeFail), rest = diffs.filter((d) => !isCodeFail(d));
  const sided = oneSided ? [`  ${oneSided} decision(s) were replayed by one of the two runs only — the comparison skips them`] : [];
  if (status === 1) {
    return { exit: 1, lines: [`${head} FAIL (${fails.length ? `${fails.length} decision(s) became DIFF / REFUSAL-CHANGE / CRASH against the control` : "a CRASH in this run"})`,
      ...(fails.length ? [`  ${fmtTransitions(fails)}`] : []),
      ...(rest.length ? [`  and ${rest.length} more changed without failing: ${fmtTransitions(rest)}`] : []), ...sided] };
  }
  if (!diffs.length && !oneSided) return { lines: [`${head} PASS (0 decisions differ from the control)`], exit: 0 };
  const uncompared = rest.filter((d) => NOT_COMPARED.has(d.is) && !NOT_COMPARED.has(d.was)).length;
  const what = [...(diffs.length ? [`${diffs.length} decision(s) changed against the control`] : []), ...(oneSided ? [`${oneSided} replayed on one side only`] : [])];
  return { exit: 0, lines: [
    `${head} PASS — BUT ${what.join(" and ")} — CHECK THEM`,
    ...(rest.length ? [`  ${fmtTransitions(rest)}`] : []), ...sided,
    "  (the exit counts only DIFF / REFUSAL-CHANGE / CRASH; a change that leaves the answer path alone shows 0 here)",
    ...(uncompared ? [`  ${uncompared} of them the control compared and this run did not. A CACHE-MISS (and the SKIPPED after it) is the data, not the`,
      "  code — the solve cache copied at another moment than the control's: re-run before trusting this PASS. A NEW BODY / NEW NODE (and the SKIPPED",
      "  after it) is a tree this change builds."] : []),
  ] };
}
