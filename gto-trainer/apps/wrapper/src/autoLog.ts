/**
 * THE HAND'S AUTO-EXECUTE LOG (2026-09-26, Brady: "in the hand details, whether auto execute worked for it or not,
 * and how many tries it needed"). One row per decision the relay touched — the pick, every press sent for it, how the
 * table took it, and what held it — archived on the hand's row as `autoExec` (archive.ts) and shown on the API's hand
 * page. Before this the only record was the session's event list, whose `hand` is the wrapper's per-process number:
 * with four tables four hands share it, so a hand's presses could not be told from its neighbours'.
 *
 * Keyed by the pick key relay.ts already uses (`<handNo>|<decisionKey JSON>`, decisionKey[0] = the street); the hand
 * number is read back off the key, so a verdict that lands after the table moved on still files under its own hand.
 */
export type AutoDecision = {
  street: string | null;
  pick: string | null;
  source: string | null;
  /** presses sent to the table for this decision: the first, auto's retries of a refusal, the verifier's re-sends */
  tries: number;
  /** pending · confirmed · diverged · unknown · abandoned · refused · held · not-fired · no-answer */
  outcome: string;
  why: string | null;
  /** what the table showed hero doing (the verifier's reading), or the no-answer fold's check/fold */
  did: string | null;
  /** the last reason auto-execute held this decision, and for how long it was held before it went */
  held: string | null;
  heldS: number | null;
  at: number;
};

const KEEP_HANDS = 30;
const LOG = new Map<number, Map<string, AutoDecision>>();

function handOf(key: string): number | null {
  const n = Number(key.slice(0, key.indexOf("|")));
  return key.includes("|") && Number.isInteger(n) ? n : null;
}

function streetOf(key: string): string | null {
  try {
    const k = JSON.parse(key.slice(key.indexOf("|") + 1));
    return Array.isArray(k) && typeof k[0] === "string" ? k[0] : null;
  } catch {
    const parts = key.split("|");
    return parts.length >= 3 ? parts[1]! : null;
  }
}

/** The decision's row, created on first mention. null = a key that names no hand (nothing is filed). */
export function autoDecision(key: string | null | undefined): AutoDecision | null {
  if (!key) return null;
  const hand = handOf(key);
  if (hand === null) return null;
  let rows = LOG.get(hand);
  if (!rows) {
    rows = new Map();
    LOG.set(hand, rows);
    for (const old of [...LOG.keys()].slice(0, Math.max(0, LOG.size - KEEP_HANDS))) LOG.delete(old);
  }
  let d = rows.get(key);
  if (!d) {
    d = { street: streetOf(key), pick: null, source: null, tries: 0, outcome: "none", why: null, did: null, held: null, heldS: null, at: Date.now() };
    rows.set(key, d);
  }
  return d;
}

/** A press was sent (or refused before it reached the table). */
export function notePress(key: string | null | undefined, p: { pick?: string | null; source?: string | null; ok: boolean; reason?: string | null }): void {
  const d = autoDecision(key);
  if (!d) return;
  d.tries += 1;
  if (p.pick) d.pick = p.pick;
  if (p.source) d.source = p.source;
  d.outcome = p.ok ? "pending" : "refused";
  d.why = p.ok ? null : p.reason ?? null;
}

/** How the table took the press (relay.verifyDone). */
export function noteOutcome(key: string | null | undefined, outcome: string, why: string | null, did: string | null): void {
  const d = autoDecision(key);
  if (!d) return;
  d.outcome = outcome;
  d.why = why;
  if (did) d.did = did;
}

/** Auto-execute is holding this decision (the line is disputed, the strip is covered, a top-up is buying). */
export function noteHeld(key: string | null | undefined, why: string, pick: string | null): void {
  const d = autoDecision(key);
  if (!d) return;
  d.held = why;
  if (pick) d.pick = pick;
  if (d.outcome === "none") d.outcome = "held";
}

export function noteResumed(key: string | null | undefined, heldS: number): void {
  const d = autoDecision(key);
  if (!d) return;
  d.heldS = Math.round(heldS * 10) / 10;
}

/** An answer auto-execute has had for a while and cannot fire — filed only while nothing was pressed for it. */
export function noteNotFired(key: string | null | undefined, why: string | null, pick: string | null): void {
  const d = autoDecision(key);
  if (!d || d.tries > 0) return;
  if (pick) d.pick = pick;
  if (d.outcome === "none" || d.outcome === "not-fired") {
    d.outcome = "not-fired";
    d.why = why;
  }
}

/** Fold-on-no-answer acted instead: the answer never played (held / refused / none came). */
export function noteNoAnswer(key: string | null | undefined, did: string, ok: boolean, why: string): void {
  const d = autoDecision(key);
  if (!d) return;
  d.outcome = "no-answer";
  d.did = ok ? did : null;
  d.why = ok ? why : `${why} (the ${did} could not be pressed)`;
}

/** The hand's decisions, oldest first — null when the relay touched none (the row then carries no `autoExec`). */
export function autoLogFor(hand: number): AutoDecision[] | null {
  const rows = LOG.get(hand);
  if (!rows || !rows.size) return null;
  return [...rows.values()].filter((d) => d.outcome !== "none" || d.tries > 0).map((d) => ({ ...d }));
}

export function resetAutoLog(): void {
  LOG.clear();
}
