/**
 * DID AUTO-EXECUTE PLAY THIS HAND? (2026-09-26, Brady: "in the hand details, whether auto execute worked for it or
 * not, and a count of how many times it needed, e.g. 1 try"). One row per decision the wrapper's relay touched, and a
 * one-line verdict for the hand page.
 *
 * Read from the row's `autoExec` (the wrapper's per-decision log, apps/wrapper/src/autoLog.ts, archived from
 * 2026-09-26). Older rows have only the hand's feed lines, which carry the same story in words ("Study pick executed —
 * CHECK (auto)", "Auto-execute held — …", "No answer — FOLD …"); those are read back as a fallback (`from: "feed"`).
 * The feed never says "confirmed" — a press counts as landed unless a MIS-EXECUTED / UNCONFIRMED / unverified line
 * follows it.
 */
export type AutoExecDecision = {
  street: string | null;
  pick: string | null;
  source: string | null;
  tries: number;
  /** confirmed · pending · diverged · unknown · abandoned · refused · held · not-fired · no-answer */
  outcome: string;
  why: string | null;
  did: string | null;
  held: string | null;
  heldS: number | null;
};

export type AutoExecSummary = {
  /** worked = every decision it touched landed as told; failed = none did; partly = some did */
  verdict: "worked" | "partly" | "failed";
  /** "worked · 1 try", "failed on the flop — held: line uncertain — pot disagrees with the ledger" */
  label: string;
  tries: number;
  decisions: AutoExecDecision[];
  from: "wrapper" | "feed";
};

const LANDED = new Set(["confirmed", "pending"]);

const str = (x: unknown) => (typeof x === "string" && x ? x : null);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function fromWrapper(rows: unknown[]): AutoExecDecision[] {
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map((r) => ({
    street: str(r.street), pick: str(r.pick), source: str(r.source), tries: num(r.tries) ?? 0,
    outcome: str(r.outcome) ?? "unknown", why: str(r.why), did: str(r.did), held: str(r.held), heldS: num(r.heldS),
  }));
}

const STREET_LINE = /^— (FLOP|TURN|RIVER) —/;
const EXECUTED = /^Study pick executed — (.+?) \(([a-z]+)[,)]/;
const NOT_EXECUTED = /^Study pick NOT executed — (.+?): (.*)$/;
const RETRIED = /^Study pick (.+?) did not register — retried/;
const MISEXEC = /^Study pick MIS-EXECUTED — told (.+?), the table took (.*)$/;
const UNCONFIRMED = /^Study pick UNCONFIRMED — (.+?) was sent, the table never showed it \((.*)\)$/;
const UNVERIFIED = /^Study pick unverified — (.+?): (.*)$/;
const HELD = /^Auto-execute held — (.*)$/;
const RESUMED = /^Auto-execute resumed — .* cleared after ([\d.]+) s/;
const NOT_FIRED = /^Auto-execute has an answer \((.+?)\) it cannot fire — (.*)$/;
const NO_ANSWER = /^No answer — (CHECK|FOLD) \(fold on no-answer\): (.*)$/;
const NO_ANSWER_FAILED = /^No answer — fold on no-answer could not act \((.*)\): (.*)$/;

/** The same story out of the feed lines, for rows archived before the wrapper kept `autoExec`. */
export function fromFeedLines(lines: string[]): AutoExecDecision[] {
  const out: AutoExecDecision[] = [];
  let street = "preflop";
  let cur: AutoExecDecision | null = null;
  let touched = false;
  const open = () => {
    cur = { street, pick: null, source: null, tries: 0, outcome: "none", why: null, did: null, held: null, heldS: null };
    touched = false;
  };
  const close = () => {
    if (cur && touched) out.push(cur);
    cur = null;
  };
  const here = (): AutoExecDecision => {
    if (!cur) open();
    touched = true;
    return cur!;
  };
  for (const raw of lines) {
    const l = String(raw);
    let m: RegExpExecArray | null;
    if (/^─+ new hand/.test(l)) { close(); street = "preflop"; continue; }
    if ((m = STREET_LINE.exec(l))) { close(); street = m[1]!.toLowerCase(); continue; }
    if (l.startsWith("YOUR TURN:")) { close(); open(); continue; }
    if ((m = EXECUTED.exec(l))) {
      const d = here();
      d.tries += 1; d.pick = m[1]!; d.source = m[2]!; d.outcome = "confirmed"; d.why = null;
    } else if ((m = NOT_EXECUTED.exec(l))) {
      const d = here();
      d.tries += 1; d.pick = m[1]!; d.outcome = "refused"; d.why = m[2]!;
    } else if ((m = RETRIED.exec(l))) {
      here().tries += 1;
    } else if ((m = MISEXEC.exec(l))) {
      const d = here();
      d.outcome = "diverged"; d.why = m[2]!; d.did = m[2]!;
    } else if ((m = UNCONFIRMED.exec(l))) {
      const d = here();
      d.outcome = "unknown"; d.why = m[2]!;
    } else if ((m = UNVERIFIED.exec(l))) {
      const d = here();
      d.outcome = "abandoned"; d.why = m[2]!;
    } else if ((m = HELD.exec(l))) {
      const d = here();
      d.held = m[1]!;
      if (d.outcome === "none") d.outcome = "held";
    } else if ((m = RESUMED.exec(l))) {
      here().heldS = Number(m[1]);
    } else if ((m = NOT_FIRED.exec(l))) {
      if (/^already executed/.test(m[2]!)) continue;
      const d = here();
      if (d.tries === 0) { d.pick ??= m[1]!; if (d.outcome === "none" || d.outcome === "not-fired") { d.outcome = "not-fired"; d.why = m[2]!; } }
    } else if ((m = NO_ANSWER.exec(l))) {
      const d = here();
      d.outcome = "no-answer"; d.did = m[1]!.toLowerCase(); d.why = m[2]!;
    } else if ((m = NO_ANSWER_FAILED.exec(l))) {
      const d = here();
      d.outcome = "no-answer"; d.why = `${m[2]!} (could not act: ${m[1]!})`;
    }
  }
  close();
  // a line that only said "not fired" for a decision that had not started yet (the previous street's answer)
  return out.filter((d) => d.outcome !== "none");
}

const tries = (n: number) => `${n} ${n === 1 ? "try" : "tries"}`;

function failure(d: AutoExecDecision): string {
  const on = d.street ? ` on the ${d.street}` : "";
  const why = d.outcome === "held" ? `held: ${d.held ?? "?"}`
    : d.outcome === "no-answer" ? `the answer never played${d.held ? ` (held: ${d.held})` : ""} — fold-on-no-answer ${d.did ?? "acted"}`
    : d.outcome === "not-fired" ? `could not fire: ${d.why ?? "?"}`
    : d.outcome === "refused" ? `press refused: ${d.why ?? "?"}`
    : d.outcome === "diverged" ? `mis-executed: the table took ${d.did ?? d.why ?? "?"}`
    : d.outcome === "abandoned" ? `unverified: ${d.why ?? "?"}`
    : `unconfirmed: ${d.why ?? "?"}`;
  return `${on} — ${why}`;
}

/** The hand's auto-execute verdict, or null when the relay never touched it (auto off, or every decision by hand). */
export function autoExecOf(raw: Record<string, unknown> | null | undefined): AutoExecSummary | null {
  if (!raw) return null;
  const structured = Array.isArray(raw.autoExec);
  const decisions = structured ? fromWrapper(raw.autoExec as unknown[])
    : fromFeedLines(Array.isArray(raw.feedLines) ? (raw.feedLines as string[]) : []);
  if (!decisions.length) return null;
  const total = decisions.reduce((s, d) => s + d.tries, 0);
  const landed = decisions.filter((d) => LANDED.has(d.outcome));
  const bad = decisions.filter((d) => !LANDED.has(d.outcome));
  const verdict = !bad.length ? "worked" : landed.length ? "partly" : "failed";
  const perDecision = decisions.length === 1 ? tries(total) : `${decisions.length} decisions, ${tries(total)}`;
  const label = verdict === "worked" ? `worked · ${perDecision}`
    : `${verdict === "failed" ? "failed" : `worked ${landed.length} of ${decisions.length}, failed`}${failure(bad[0]!)}`;
  return { verdict, label, tries: total, decisions, from: structured ? "wrapper" : "feed" };
}
