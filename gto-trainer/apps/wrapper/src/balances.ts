/**
 * balances — the money in a profile's account, as timestamped OBSERVATIONS. Port of balances.py.
 *
 * THE RULE (2026-09-16). Between two snapshots of the same profile the balance may move by exactly what poker
 * did; anything else is money that entered or left outside the game, a fact to FLAG, never to absorb into a win
 * rate (gto-trainer reconciles it). EQUITY, NOT THE CASHIER: every snapshot records both the cashier figure and
 * what is on the table (in_play_cents), and everything is reconciled on their sum. Integer USD cents throughout.
 *
 * Storage: data/sessions.sqlite, table `balances` (the wrapper writes, the API reads it read-only).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nowMs, time } from "./clock";
import { paths } from "./env";
import { openStore } from "../../../packages/data-root/centralDb";
import * as F from "./formats";
import { js } from "./js";
import { fmtFixed, fmtFixedComma, pyFloat, pyRepr, pyRound } from "./py";

const dbPath = () => paths().sessionsDb;

const DDL = `CREATE TABLE IF NOT EXISTS balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  profile TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL,
  session_id TEXT,
  phase TEXT,
  how TEXT,
  raw TEXT,
  in_play_cents INTEGER
)`;

function open(): Database {
  const c = openStore(dbPath());
  c.run(DDL);
  try {
    c.run("ALTER TABLE balances ADD COLUMN in_play_cents INTEGER");
  } catch {}
  c.run("CREATE INDEX IF NOT EXISTS balances_profile_ts ON balances (profile, ts)");
  return c;
}

function withDb<T>(f: (c: Database) => T): T {
  const c = open();
  try {
    return f(c);
  } finally {
    c.close();
  }
}

/** Write one observation. `inPlayCents` null = hero was not seated (not 0 — the two mean different things). */
export function record(profile: string, amountCents: number, source: string, sessionId: string | null = null,
                       phase: string | null = null, how: string | null = null, raw: string | null = null,
                       currency = "USD", inPlayCents: number | null = null) {
  if (!profile) throw new Error("a balance belongs to a profile");
  const ts = nowMs();
  const rid = withDb((c) => {
    const r = c.query("INSERT INTO balances (ts, profile, amount_cents, currency, source, session_id, phase, how, raw, in_play_cents)"
      + " VALUES (?,?,?,?,?,?,?,?,?,?)").run(ts, profile, Math.trunc(amountCents), currency, source, sessionId, phase, how,
      (raw || "").slice(0, 200), inPlayCents === null ? null : Math.trunc(inPlayCents));
    return Number(r.lastInsertRowid);
  });
  return {
    id: rid, ts, profile, amountCents: Math.trunc(amountCents), inPlayCents,
    equityCents: Math.trunc(amountCents) + Math.trunc(inPlayCents || 0),
    currency, source, sessionId, phase, how,
  };
}

function row(r: any) {
  const inPlay = r.in_play_cents ?? null;
  return {
    id: r.id, ts: r.ts, profile: r.profile, amountCents: r.amount_cents, currency: r.currency, source: r.source,
    sessionId: r.session_id, phase: r.phase, how: r.how, raw: r.raw, inPlayCents: inPlay, equityCents: r.amount_cents + (inPlay || 0),
  };
}

const COLS = "id, ts, profile, amount_cents, currency, source, session_id, phase, how, raw, in_play_cents";

export function latest(profile: string) {
  const r = withDb((c) => c.query(`SELECT ${COLS} FROM balances WHERE profile=? ORDER BY ts DESC, id DESC LIMIT 1`).get(profile));
  return r ? row(r) : null;
}

export function history(profile: string | null = null, limit = 500) {
  return withDb((c) => (profile
    ? c.query(`SELECT ${COLS} FROM balances WHERE profile=? ORDER BY ts DESC, id DESC LIMIT ?`).all(profile, limit)
    : c.query(`SELECT ${COLS} FROM balances ORDER BY ts DESC, id DESC LIMIT ?`).all(limit)).map(row));
}

export function forSession(sessionId: string) {
  return withDb((c) => c.query(`SELECT ${COLS} FROM balances WHERE session_id=? ORDER BY ts, id`).all(sessionId).map(row));
}

// ----------------------------------------------------------------- scraping
export const SCRAPE_JS = () => js("balances.SCRAPE_JS");
export const IN_PLAY_JS = () => js("balances.IN_PLAY_JS");

/** What hero has on the table right now: {seated, inPlayCents?, how, raw}. */
export async function inPlay(port: number): Promise<Record<string, any>> {
  let res: any;
  try {
    const t = await F.target(port);
    if (!t) return { seated: false, reason: `no Ignition client on CDP port ${port}` };
    res = await F.ev(t.webSocketDebuggerUrl!, IN_PLAY_JS());
  } catch (e: any) {
    return { seated: false, reason: `could not read the table: ${e?.message || e}` };
  }
  if (!res || typeof res !== "object" || Array.isArray(res)) return { seated: false, reason: `unexpected reply: ${pyRepr(res)}` };
  if (res.seated && res.amount !== null && res.amount !== undefined) res.inPlayCents = Math.trunc(pyRound(pyFloat(res.amount) * 100));
  return res;
}

/** Read the balance from the open client: {ok, amountCents, how, raw} or {ok: false, reason, candidates}. */
export async function scrape(port: number): Promise<Record<string, any>> {
  let res: any;
  try {
    const t = await F.target(port);
    if (!t) return { ok: false, reason: `no Ignition client on CDP port ${port}` };
    res = await F.ev(t.webSocketDebuggerUrl!, F.LOBBY() + SCRAPE_JS());
  } catch (e: any) {
    return { ok: false, reason: `could not read the client: ${e?.message || e}` };
  }
  if (!res || typeof res !== "object" || Array.isArray(res)) return { ok: false, reason: `unexpected reply from the client: ${pyRepr(res)}` };
  if (!res.ok) return res;
  let cents: number;
  try {
    cents = Math.trunc(pyRound(pyFloat(res.amount) * 100));
  } catch {
    return { ok: false, reason: `could not read an amount from ${pyRepr(res.raw ?? null)}` };
  }
  if (cents < 0 || cents > 100_000_000) {
    return { ok: false, reason: `implausible balance ${fmtFixed(cents / 100, 2)} read from ${pyRepr(res.raw ?? null)} (${res.how ?? "None"})` };
  }
  const out: Record<string, any> = { ok: true, amountCents: cents, currency: "USD", how: res.how ?? null, raw: res.raw ?? null };
  const ip = await inPlay(port);
  out.seated = !!ip.seated;
  out.inPlayCents = ip.seated ? (ip.inPlayCents ?? null) : null;
  out.inPlayHow = ip.how || ip.reason || null;
  out.equityCents = cents + (out.inPlayCents || 0);
  return out;
}

const cache: { at: number; port: number | null; res: Record<string, any> | null } = { at: 0.0, port: null, res: null };

/** scrape(), memoised for a few seconds (the setup page polls preflight every second). */
export async function scrapeCached(port: number, ttl = 15.0): Promise<Record<string, any>> {
  const now = time();
  if (cache.res !== null && cache.port === port && now - cache.at < ttl) return cache.res;
  const res = await scrape(port);
  Object.assign(cache, { at: now, port, res });
  return res;
}

/** Scrape and record in one step — what session start and session end call. */
export async function snapshot(profile: string, port: number, sessionId: string | null = null, phase: string | null = null) {
  const got = await scrape(port);
  if (!got.ok) return got;
  const r = record(profile, got.amountCents, "scraped", sessionId, phase,
    got.seated ? `${got.how ?? "None"} + table ${got.inPlayHow ?? "None"}` : got.how, got.raw, "USD", got.inPlayCents ?? null);
  return { ok: true, ...r };
}

export function fmt(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${fmtFixedComma(Math.abs(cents) / 100, 2)}`;
}
