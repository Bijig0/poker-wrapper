import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { PreflopPin } from "./preflopPin";
import { emptyCounts, type RequestCounts } from "./requestScope";
import { handFactsDbPath, openStore } from "./storePaths";

/**
 * THE HAND'S FACTS (2026-09-25, Brady: "the happy path should be: in a normal spot, we just cache and reuse the
 * ranges"). The answer chain keeps two kinds of state and used to keep them the same way — handKey-keyed Maps,
 * first- or last-write-wins, gone on a restart:
 *
 *   FACTS    what HAPPENED in the hand, which nothing can re-derive: the stacks as dealt (read once), which tree
 *            each preflop answer was read on and the mix hero was given (the preflop pin), which streets the chain
 *            walked and under which inputs, and how many GTO Wizard requests the hand cost. Small, append-mostly,
 *            persisted here.
 *   DERIVED  what can always be computed again from the facts and the capture: the ranges entering each street,
 *            the mid-street resume point, trees, nodes. A cache (aiChain's street memo, fastSolve's arrival memo,
 *            gtowApi's tree/node caches) — dropping it costs time, never changes an answer.
 *
 * WRITE-THROUGH, READ FROM MEMORY. Every fact goes to the in-memory map and to SQLite in the same call; the hot path
 * reads memory and touches the disk only on a miss (an API restart, a second API process on the port). Measured on
 * the Zenbook, bun:sqlite WAL, 200k rows: ~25 µs a write, ~15 µs to read one hand back with its JSON parsed.
 *
 * ONE ROW PER HAND (`doc` = the whole hand's facts as JSON, a few KB) keyed by the hand key. Only a REAL site hand id
 * is written to disk: when the capture has no clientHandId the key falls back to the wrapper's per-process hand
 * counter, which collides across tables and restarts — those stay in memory. Rows older than RETAIN_DAYS are pruned
 * when the store opens.
 *
 * WHERE: HAND_FACTS_DB_PATH, else data/hand_facts.sqlite for the API worker itself (bun index.ts) and an in-memory
 * database for everything else — a replay script or a harness re-plays the same hand ids hundreds of times and must
 * never read, or leave behind, the live worker's facts. Under bun test only :memory: or a temp file is accepted
 * (src/test/isolateLiveState.ts sets it before any test file loads).
 */

export interface DealtFact {
  /** seat → stack as dealt (bb) */
  dealt: Record<number, number>;
  /** the depth the postflop site derived from it */
  depth: number;
  /** the street it was first read on */
  street: string;
  at: number;
}

/** One street the AI chain walked for this hand — the ledger aiChain reads to tell a first walk from a re-walk. */
export interface StreetRecord {
  /** the street's index (0 flop, 1 turn, 2 river) and the chain's first street (re-rooted chains start later) */
  k: number;
  first: number;
  /** the collapse plan (multiwayCollapse kind), null for a plain heads-up / three-way walk */
  plan: string | null;
  /** the content key of the chain's root (the ranges, pot and stack it started from) */
  root: string;
  /** the content key of what ENTERED the street (the root for the chain's first street, else the exit of the one before) */
  entry: string;
  /** the record's own key: closed = the street's exit key, partial = its entry key (where hero's node was read) */
  key: string;
  /** the street's tokens as walked (a partial's: the prefix up to hero's node) */
  tokens: string[];
  kind: "closed" | "partial";
  /** the tree it was walked on */
  solId?: string;
  at: number;
}

export interface HandDoc {
  key: string;
  heroCards?: string | null;
  preflop?: PreflopPin;
  dealt?: DealtFact;
  streets?: StreetRecord[];
  /** GTO Wizard requests spent on this hand, by the origin of the call that made them ("live", "warm", …) */
  requests?: Record<string, RequestCounts>;
  at: number;
}

const RETAIN_DAYS = 30;
const MEMORY_MAX = 600;
const STREETS_MAX = 60;

/** A key worth persisting: a real site hand id, not the wrapper's small per-process counter (see above). */
export const isDurableKey = (key: string): boolean => !!key && !/^\d{1,6}$/.test(key);

function assertTestSafePath(path: string): void {
  if (process.env.NODE_ENV !== "test") return;
  if (path === ":memory:" || path.startsWith("file::memory:")) return;
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(realpathSync(tmpdir())), norm(path));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return;
  throw new Error(`handFacts: refusing to open ${path} under bun test — tests must use HAND_FACTS_DB_PATH=:memory: or a temp file`);
}

function defaultPath(): string {
  const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
  return handFactsDbPath(/(^|\/)index\.ts$/.test(argv1));
}

/** the hand as stored: an AI pin's background pre-fetch (`preflop.warm`) is a Promise, which is not a fact — only that
 *  one field is dropped (a replacer on the key name also dropped the "warm" ORIGIN's request counts) */
const serialize = (doc: HandDoc): string => {
  if (!doc.preflop || !("warm" in doc.preflop)) return JSON.stringify(doc);
  const { warm: _w, ...pin } = doc.preflop as PreflopPin & { warm?: unknown };
  return JSON.stringify({ ...doc, preflop: pin });
};

class HandFacts {
  private db: Database | null = null;
  private dbFailed = false;
  private readonly path: string;
  private readonly mem = new Map<string, HandDoc>();
  private stmts: { get: ReturnType<Database["prepare"]>; put: ReturnType<Database["prepare"]>; del: ReturnType<Database["prepare"]> } | null = null;

  constructor(path?: string) {
    this.path = path ?? defaultPath();
    assertTestSafePath(this.path);
  }

  get dbPath(): string { return this.path; }

  private open(): Database | null {
    if (this.db || this.dbFailed) return this.db;
    try {
      const db = openStore(this.path);
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("CREATE TABLE IF NOT EXISTS hand_facts (hand_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, doc TEXT NOT NULL) WITHOUT ROWID");
      db.exec("CREATE INDEX IF NOT EXISTS idx_hand_facts_ts ON hand_facts(ts)");
      db.query("DELETE FROM hand_facts WHERE ts < ?").run(Date.now() - RETAIN_DAYS * 86_400_000);
      this.stmts = {
        get: db.prepare("SELECT doc FROM hand_facts WHERE hand_key = ?"),
        put: db.prepare("INSERT INTO hand_facts (hand_key, ts, doc) VALUES (?, ?, ?) ON CONFLICT(hand_key) DO UPDATE SET ts = excluded.ts, doc = excluded.doc"),
        del: db.prepare("DELETE FROM hand_facts WHERE hand_key = ?"),
      };
      this.db = db;
    } catch (e) {
      // the facts are worth keeping but never worth an answer: a store that cannot open leaves memory only
      this.dbFailed = true;
      console.error(`[hand-facts] cannot open ${this.path} — facts stay in memory only: ${e instanceof Error ? e.message : e}`);
    }
    return this.db;
  }

  /** The hand's facts: memory first, the disk on a miss (and remembered). */
  get(key: string): HandDoc | undefined {
    if (!key) return undefined;
    const hit = this.mem.get(key);
    if (hit) return hit;
    if (!isDurableKey(key)) return undefined;
    try {
      this.open();
      const row = this.stmts?.get.get(key) as { doc: string } | null | undefined;
      if (!row) return undefined;
      const doc = JSON.parse(row.doc) as HandDoc;
      this.remember(doc);
      return doc;
    } catch {
      return undefined;
    }
  }

  private remember(doc: HandDoc): void {
    this.mem.delete(doc.key);
    this.mem.set(doc.key, doc);
    while (this.mem.size > MEMORY_MAX) {
      const first = this.mem.keys().next().value;
      if (first === undefined) break;
      this.mem.delete(first);
    }
  }

  /** Apply a change to a hand's facts and write it through. */
  private update(key: string, change: (doc: HandDoc) => void): HandDoc | undefined {
    if (!key) return undefined;
    const doc: HandDoc = this.get(key) ?? { key, at: Date.now() };
    change(doc);
    doc.at = Date.now();
    this.remember(doc);
    if (isDurableKey(key)) {
      try {
        this.open();
        this.stmts?.put.run(key, doc.at, serialize(doc));
      } catch { /* memory still has it */ }
    }
    return doc;
  }

  // ── the preflop pin: the tree the hand's last preflop answer was read on ────────────────────────────────────
  preflop(key: string): PreflopPin | undefined { return this.get(key)?.preflop; }
  setPreflop(key: string, pin: PreflopPin, heroCards?: string | null): void {
    this.update(key, (d) => { d.preflop = pin; if (heroCards) d.heroCards = heroCards; });
  }
  forgetPreflop(key: string): void {
    if (this.get(key)?.preflop) this.update(key, (d) => { delete d.preflop; });
  }

  // ── the stacks as dealt: read ONCE per hand, the first read wins ────────────────────────────────────────────
  dealt(key: string): DealtFact | undefined { return this.get(key)?.dealt; }
  /** The hand's dealt stacks — `make()` runs only when none are recorded yet. */
  dealtOnce(key: string, make: () => DealtFact): DealtFact {
    const have = this.dealt(key);
    if (have) return have;
    const fact = make();
    this.update(key, (d) => { d.dealt ??= fact; });
    return this.dealt(key) ?? fact;
  }
  forgetDealt(key: string): void {
    if (this.get(key)?.dealt) this.update(key, (d) => { delete d.dealt; });
  }

  // ── the streets the chain walked ────────────────────────────────────────────────────────────────────────────
  streets(key: string): StreetRecord[] { return this.get(key)?.streets ?? []; }
  recordStreet(key: string, rec: StreetRecord): void {
    this.update(key, (d) => {
      const list = (d.streets ?? []).filter((x) => !(x.key === rec.key && x.kind === rec.kind));
      list.push(rec);
      d.streets = list.slice(-STREETS_MAX);
    });
  }
  forgetStreets(key: string): void {
    if (this.get(key)?.streets) this.update(key, (d) => { delete d.streets; });
  }

  // ── the requests the hand cost ──────────────────────────────────────────────────────────────────────────────
  addRequests(key: string, origin: string, c: RequestCounts): void {
    if (!(c.tree + c.solution + c.poll + c.library + c.other)) return;
    this.update(key, (d) => {
      const r = (d.requests ??= {});
      const acc = (r[origin] ??= emptyCounts());
      for (const k of Object.keys(acc) as (keyof RequestCounts)[]) acc[k] += c[k] ?? 0;
    });
  }

  /** Forget a hand entirely — memory and disk (tests, and a replay that wants a cold hand). */
  forget(key: string): void {
    this.mem.delete(key);
    if (!isDurableKey(key)) return;
    try { this.open(); this.stmts?.del.run(key); } catch { /* nothing to forget */ }
  }

  /** Several hands' facts at once, for the dashboard (memory first, disk for the rest). */
  many(keys: string[]): Record<string, HandDoc> {
    const out: Record<string, HandDoc> = {};
    for (const k of keys) { const d = this.get(k); if (d) out[k] = d; }
    return out;
  }

  /** Drop the in-memory copy only (tests: proves a restart reads the disk back). */
  dropMemory(): void { this.mem.clear(); }
}

export const handFacts = new HandFacts();
export { HandFacts };
