/**
 * profiles — the ACCOUNTS hands are played on, and whether their money adds up.
 *
 * A profile is an account, not a person: name, site, and a password the wrapper
 * keeps in Windows Credential Manager and nothing else ever sees
 * (ignition-study-wrapper/auth.py). The wrapper owns both stores; we only read.
 *
 *   data/profiles.json      the accounts       (auth.py)
 *   data/sessions.sqlite    balance snapshots  (balances.py, table `balances`)
 *
 * THE RULE this exists to check (2026-09-16): between two snapshots of the same
 * account, its EQUITY may move by exactly what poker did. Anything else entered or
 * left outside the game — a deposit, a cash-out, a bonus, a fee — or is a hand we
 * never captured. Either way it is a fact to show, never to fold into a win rate.
 *
 * Three things make that check honest rather than a banner that always fires:
 *
 *   EQUITY, not the cashier. The lobby's "available balance" excludes chips in
 *   play; a snapshot from a seat records the table stack too (in_play_cents), and
 *   the comparison is on cashier + in-play.
 *
 *   RAKE. Our per-hand net prices an uncontested win as pot − invested off the
 *   DISPLAYED pot, which is pre-rake; the site takes 5% (capped, no flop no drop)
 *   before it reaches the balance. `rakeEstCents` on each hand is that estimate,
 *   subtracted here and shown as its own line — never baked into computeNets,
 *   whose numbers feed bb/100 everywhere else.
 *
 *   TOLERANCE. Cent rounding on bb×stake, the rake estimate's own error, and any
 *   hand whose net we could not price all leave residue. An interval is
 *   `movement` only when the residue is outside tolerance; inside it is `noise`;
 *   and one containing an unpriced hand is `unverifiable` — the gap may be the
 *   hand, not the account.
 *
 * Money is integer USD cents throughout, as in the wrapper. AUD is a display-time
 * conversion (services/fx.ts) and is never persisted as an amount.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { balanceAcksPath, handsDbPath, profilesJsonPath, sessionsDbPath } from "./storePaths";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";   // readFileSync is already imported above
import { dirname } from "node:path";

const HANDS_DB = handsDbPath();
const SESSIONS_DB = sessionsDbPath();
const PROFILES_JSON = profilesJsonPath();

export interface ProfileRow {
  name: string;
  site: string | null;
  createdAt: number | null;
}

export interface BalanceSnap {
  id: number;
  ts: number;
  profile: string;
  /** the cashier's "available balance" */
  amountCents: number;
  /** hero's stack on the table at that moment; null = not seated (nothing in play) */
  inPlayCents: number | null;
  /** what the account is actually worth: cashier + chips in play */
  equityCents: number;
  currency: string;
  source: string;
  sessionId: string | null;
  phase: string | null;
  how: string | null;
}

/** Every declared account. Never a secret, and deliberately not the e-mail either:
 *  the name identifies the account, and the e-mail is the one field with no use here. */
export function profiles(): ProfileRow[] {
  try {
    const rows = JSON.parse(readFileSync(PROFILES_JSON, "utf-8"));
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r && typeof r.name === "string")
      .map((r) => ({ name: r.name, site: r.site ?? null, createdAt: r.createdAt ?? null }));
  } catch {
    return []; // no profiles.json yet — the wrapper writes it on the first save
  }
}

function open(): Database | null {
  if (!existsSync(SESSIONS_DB)) return null;
  try {
    const d = new Database(SESSIONS_DB, { readonly: true });
    d.exec("PRAGMA busy_timeout = 5000"); // the wrapper writes this file while we read it
    return d;
  } catch {
    return null;
  }
}

const snapOf = (r: any): BalanceSnap => {
  const inPlay = r.in_play_cents == null ? null : Number(r.in_play_cents);
  return {
    id: r.id, ts: r.ts, profile: r.profile, amountCents: r.amount_cents, inPlayCents: inPlay,
    equityCents: r.amount_cents + (inPlay ?? 0), currency: r.currency,
    source: r.source, sessionId: r.session_id ?? null, phase: r.phase ?? null, how: r.how ?? null,
  };
};

/** Balance snapshots, oldest first — the order every reconciliation walks. */
export function snapshots(profile?: string | null, limit = 1000): BalanceSnap[] {
  const db = open();
  if (!db) return [];
  try {
    const rows = profile
      ? db.query<any, [string, number]>("SELECT * FROM balances WHERE profile=? ORDER BY ts, id LIMIT ?").all(profile, limit)
      : db.query<any, [number]>("SELECT * FROM balances ORDER BY ts, id LIMIT ?").all(limit);
    return rows.map(snapOf);
  } catch {
    return []; // the table appears the first time the wrapper records a balance
  }
}

export const latestSnapshot = (profile: string): BalanceSnap | null =>
  snapshots(profile).slice(-1)[0] ?? null;

/** One hand, as reconciliation needs it. */
export interface PricedHand {
  playedAt: number | null;
  /** null when the hand's net could not be established — it widens the caveat, not the total. */
  netCents: number | null;
  /** rake the site took that our net does not know about (uncontested wins that saw a flop) */
  rakeEstCents: number;
  /** the big blind in cents — sets the tolerance an interval is judged against */
  bbCents: number | null;
}

/**
 * Rake on a pot as Ignition takes it — 5%, capped by players dealt, no flop no
 * drop (measured 2026-09-12 at NL200). Only uncontested wins need this: a showdown
 * hand's net comes from the stack delta, which is already after rake; a fold cost
 * exactly what it cost; a preflop steal saw no flop and paid none.
 */
export const RAKE_PCT = 0.05;
export function rakeCapCents(playersDealt: number): number {
  if (playersDealt <= 2) return 100;
  if (playersDealt === 3) return 200;
  if (playersDealt <= 5) return 300;
  return 400;
}
export function rakeEstCents(h: { heroWonUncontested: boolean; sawFlop: boolean; potCents: number; playersDealt: number }): number {
  if (!h.heroWonUncontested || !h.sawFlop || !(h.potCents > 0)) return 0;
  return Math.min(Math.round(h.potCents * RAKE_PCT), rakeCapCents(h.playersDealt));
}

/**
 * Rake hero PAID on one hand, in big blinds — the site's schedule applied to the
 * pots hero won. The convention: rake comes out of the pot, so the player who
 * does not receive it is the winner; a hand hero folded or lost paid none.
 *
 * Two kinds of won hand, and they sit differently in the recorded net:
 *   uncontested after a flop — priced pre-rake by computeNets (displayed pot), so
 *     this rake is NOT in the net; `unseen` is true and net-after-rake subtracts it
 *   at showdown — priced from the stack delta, which is already after rake; the
 *     rake was paid and is reported, but must not be subtracted a second time
 * With no flop there is no rake at all (no flop no drop).
 */
export function rakePaidBb(
  s: { heroWonUncontested: boolean; heroFolded: boolean; sawFlop: boolean; wentToShowdown?: boolean; won?: boolean; potBb: number; tableSeats: number },
  bbUsd: number | null,
  netBb: number | null,
): { bb: number; unseen: boolean } {
  // a showdown win is known from the archive's own heroWon / "★ wins" when the caller
  // has it (`won`); the priced net is the fallback, and it is null on the rows that
  // never got a usable next-hand stack — which is exactly the July era
  const wonShowdown = !s.heroWonUncontested && !s.heroFolded && (s.won === true || (netBb != null && netBb > 0));
  // a showdown implies a flop even when the board was not captured: the July-era
  // rows carry "wins main pot … with (Two pair)" and sawFlop=false, and would
  // otherwise count as unraked steals (checked against the client's awards, 2026-09-16)
  const sawFlop = s.sawFlop || !!s.wentToShowdown;
  if (!sawFlop || !(s.potBb > 0) || !(s.heroWonUncontested || wonShowdown)) return { bb: 0, unseen: false };
  const pct = s.potBb * RAKE_PCT;
  // the cap is in dollars; without a known stake it cannot apply, and 5% uncapped
  // overstates only the rare deep pot
  const capBb = bbUsd != null && bbUsd > 0 ? rakeCapCents(s.tableSeats) / 100 / bbUsd : Infinity;
  return { bb: Math.round(Math.min(pct, capBb) * 100) / 100, unseen: s.heroWonUncontested };
}

export type IntervalTier = "clean" | "noise" | "unverifiable" | "movement" | "accepted";

/**
 * ACKNOWLEDGEMENTS — a reading Brady has marked CORRECT. A scrape can be wrong (a
 * seat whose stack was not read, a lobby figure caught mid-refresh), and then the
 * interval ending at it is flagged as money that never moved. Marking the reading
 * correct keeps the residue on record but takes it out of the verdict: the interval
 * becomes `accepted`, and the next interval starts from that reading as it always
 * did. Kept here (data/balance-acks.json, keyed by reading id), not in the wrapper's
 * store: it is a review judgement about a reading, not a reading.
 */
export interface Ack { profile: string; at: number; note: string | null; unexplainedCents: number; flaggedTier: string }
const ACKS = balanceAcksPath();
export function acks(): Record<string, Ack> {
  try { return JSON.parse(readFileSync(ACKS, "utf8")) as Record<string, Ack>; } catch { return {}; }
}
function writeAcks(a: Record<string, Ack>): void { mkdirSync(dirname(ACKS), { recursive: true }); writeFileSync(ACKS, JSON.stringify(a, null, 2)); }
export function acceptReading(profile: string, snapId: number, note: string | null, unexplainedCents: number, flaggedTier: string): Ack {
  const a = acks();
  const ack: Ack = { profile, at: Date.now(), note, unexplainedCents, flaggedTier };
  a[String(snapId)] = ack; writeAcks(a);
  return ack;
}
export function unacceptReading(snapId: number): boolean {
  const a = acks();
  if (!(String(snapId) in a)) return false;
  delete a[String(snapId)]; writeAcks(a);
  return true;
}

export interface Interval {
  from: BalanceSnap;
  to: BalanceSnap;
  /** What the account's EQUITY actually did between the two snapshots. */
  movedCents: number;
  /** What our hands say poker did in that window, before rake. */
  pokerCents: number;
  /** The rake the site took on those hands that our net does not see. */
  rakeEstCents: number;
  /** movedCents − (pokerCents − rakeEstCents): what nothing we know explains. */
  unexplainedCents: number;
  /** The residue an interval is allowed before it counts as movement. */
  toleranceCents: number;
  tier: IntervalTier;
  /** The tier the math gave before the closing reading was marked correct (null when it was not). */
  flaggedTier: Exclude<IntervalTier, "accepted"> | null;
  accepted: Ack | null;
  hands: number;
  /** Hands in the window whose net we could not price — why a residue may be measurement. */
  unpricedHands: number;
  sessionId: string | null;
}

/** Residue an honest interval can carry: half a dollar, or one big blind at the
 *  window's stake if larger, plus a fifth of the rake estimate (the cap table is
 *  measured at NL200 and may overstate rake at micro stakes). */
export function toleranceCents(bbCents: number | null, rakeEst: number): number {
  return Math.max(50, bbCents ?? 0) + Math.round(rakeEst * 0.2);
}

/**
 * Walk a profile's snapshots in pairs and attribute the money between them.
 *
 * `hands` must already be filtered to this profile. A hand belongs to an interval
 * when it was played inside it; hands played outside every interval (before the
 * first snapshot, or while no session was declared) are simply not attributed —
 * unattributed is fine, and pretending otherwise would corrupt the check.
 */
export function reconcile(snaps: BalanceSnap[], hands: PricedHand[], acked: Record<string, Ack> = {}): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const from = snaps[i - 1]!, to = snaps[i]!;
    const inWindow = hands.filter((h) => h.playedAt != null && h.playedAt >= from.ts && h.playedAt <= to.ts);
    const priced = inWindow.filter((h) => h.netCents != null);
    const pokerCents = priced.reduce((s, h) => s + (h.netCents ?? 0), 0);
    const rake = priced.reduce((s, h) => s + h.rakeEstCents, 0);
    const movedCents = to.equityCents - from.equityCents;
    const unexplainedCents = movedCents - (pokerCents - rake);
    const bb = inWindow.reduce<number | null>((m, h) => (h.bbCents != null && (m == null || h.bbCents > m) ? h.bbCents : m), null);
    const tol = toleranceCents(bb, rake);
    const unpriced = inWindow.length - priced.length;
    const computed: Exclude<IntervalTier, "accepted"> =
      unexplainedCents === 0 ? "clean"
      : Math.abs(unexplainedCents) <= tol ? "noise"
      : unpriced > 0 ? "unverifiable"
      : "movement";
    // a closing reading marked correct: the residue stays on record, the verdict does not
    const ack = acked[String(to.id)] ?? null;
    const tier: IntervalTier = ack ? "accepted" : computed;
    out.push({
      from, to, movedCents, pokerCents, rakeEstCents: rake, unexplainedCents, toleranceCents: tol, tier,
      flaggedTier: ack ? computed : null, accepted: ack,
      hands: inWindow.length, unpricedHands: unpriced,
      // the interval belongs to a session when both ends were taken for it
      sessionId: from.sessionId && from.sessionId === to.sessionId ? from.sessionId : (to.sessionId ?? null),
    });
  }
  return out;
}

/** Money is never a float here; this is the only place it becomes one, for display. */
export const usd = (cents: number | null | undefined): string =>
  cents == null ? "—" : `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
