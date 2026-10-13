/**
 * AN UNSAFE ANSWER (2026-10-13, Brady: "these sorts of errors where bad solutions are presented are especially dangerous").
 *
 * Hand 4923635257: the SB cold-called a 3-bet, the pool cold-call lock timed out, and hero's QQ was answered on the plain
 * GTO Wizard tree — where that cold-call is 0.10% of the SB's range, a range of traps. QQ was told Fold 77%; every check
 * passed, the verdict was "by design", the only sign was the yellow note, and auto-execute pressed the fold 0.4 s later.
 *
 * The answer's verdict (clean / by-design / rebuilt / leaked / failed) mixes two different things: was it SLOW or COSTLY
 * (a solve over its median, a tree created twice — most red banners), and is it WRONG FOR THE SPOT. This module is the
 * second question alone, read from the answer's own path: a correctness step that failed, a villain range the model has
 * as residue on hero's line, or an input / output check that failed. An unsafe answer is shown red with its reasons and
 * — while UNSAFE_HOLD is on (unset = on) — auto-execute holds it for the player (the wrapper presses the solved pick
 * only near the end of the base clock, never spending the time bank on the wait).
 *
 * Never a re-solve and never a different pick: the answer is what it is; the player is told, and given the time to act.
 */
import type { DecisionPath, PathReason } from "./chainPath";
import { CHECK_NAME, type CheckResult } from "./chainChecks";

/** path reason codes that make an answer unsafe, with the sentence the player reads */
export const UNSAFE_CODES: Record<string, string> = {
  "preflop:pool-limp-lock-failed": "the pool limp lock failed — answered against the solver's residue limp range",
  "preflop:pool-coldcall-lock-failed": "the pool cold-call lock failed — answered against the solver's residue cold-call range",
  "postflop:hero-absent": "hero's hand is absent from his own range at his node — the mix is noise",
  // THE RESIDUE GATE (services/residueGate, 2026-10-13): its exact tree did not answer, so the chart answered behind a
  // villain size the chart's own player barely uses — and the flop ranges walked off that node are his sliver
  "preflop:residue-gate-ai-failed": "the residue gate's exact tree did not answer — the chart answered behind a size its own player barely uses (his range there is a sliver)",
  "arrival:residue-gate-ai-failed": "the flop ranges were walked off a chart node behind a size its player barely uses (the exact tree was not built) — a villain enters with a sliver of his range",
};

/** input / output checks whose FAIL means the model is not the spot at the table (process checks #9-#13 never do) */
export const UNSAFE_FAIL_CHECKS: readonly number[] = [2, 4, 5, 6, 7, 8, 14, 15, 16, 17];

/** a #2 / #3 FLAG that is a residue range on hero's path (chainChecks marks the text) */
export const RESIDUE_MARK = "RESIDUE:";

export interface UnsafeAnswer {
  reasons: string[];
}

const short = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Why this answer is unsafe — [] when it is not. Pure over the path (the answer row's `path` JSON reads the same). */
export function unsafeReasons(path: (Pick<DecisionPath, "reasons" | "checks" | "arrival"> & { street?: string | null }) | null | undefined): string[] {
  if (!path) return [];
  const out: string[] = [];
  for (const r of (path.reasons ?? []) as PathReason[]) {
    const say = UNSAFE_CODES[r.code];
    if (say) out.push(say);
  }
  // a pool lock hero's preflop answer was read with, lost at the flop — unless a floor gave the seat a pool range after all
  const a = path.arrival;
  // an arrival code that is unsafe stays so on later streets (a memo hit carries it as `first`, not as a reason)
  for (const x of [a, a?.first].filter(Boolean) as NonNullable<typeof a>[]) {
    const say = x.code ? UNSAFE_CODES[x.code] : undefined;
    if (say && x.code!.startsWith("arrival:")) out.push(say);
  }
  for (const x of [a, a?.first].filter(Boolean) as NonNullable<typeof a>[]) {
    const covered = new Set((x.poolSeats ?? []).map((s) => s.pos.toUpperCase()));
    for (const l of x.lockLost ?? []) {
      if (!covered.has(l.pos.toUpperCase())) out.push(`the ${l.pos}'s pool lock (${l.key}) was lost at the flop — he enters with the plain tree's range`);
    }
  }
  for (const [street, list] of Object.entries(path.checks ?? {})) {
    for (const c of (list ?? []) as CheckResult[]) {
      if (c.status === "fail" && UNSAFE_FAIL_CHECKS.includes(c.id)) out.push(`${street}: ${CHECK_NAME[c.id] ?? `check ${c.id}`} failed — ${short(c.text)}`);
      else if (c.status === "flag" && (c.id === 2 || c.id === 3) && c.text.startsWith(RESIDUE_MARK)) out.push(`${street}: ${short(c.text)}`);
      // A VILLAIN MISTAKE LINE ON THE DECISION STREET (the postflop audit 2026-10-13, finding 1): hero's node on this street
      // is read from the same solve, where the villain's range after that action is the solver's sliver — the soft range
      // only reaches LATER streets (151 answers, e.g. 14206: AA told Fold 99% to a 0.06% check-raise). Earlier streets'
      // flags are carried as the soft range — by design, not unsafe.
      else if (c.status === "flag" && c.id === 3 && street !== "preflop" && path.street && street === path.street) {
        out.push(`${street}: a villain action before hero's node on this street is one the solver all but never takes — hero's answer is read against his sliver of a range: ${short(c.text)}`);
      }
    }
  }
  return [...new Set(out)];
}

/** UNSAFE_HOLD, read at every answer: on (unset) = auto-execute holds an unsafe answer · off = shown red, pressed as before */
export const unsafeHoldOn = (): boolean => (process.env.UNSAFE_HOLD ?? "on").trim().toLowerCase() !== "off";
