import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, startStacksOf, roundContributions } from "../utils/archivedHand/archivedHand";
import { summarizeHand, type HandSummary } from "../utils/handSummary/handSummary";
import { buildSpotSolutionTokens, buildPreflopTokens, buildPreflopTokensHu, buildSolutionUrl } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { preflopDb } from "../services/preflopDb";
import { resolveSet, resolveDepth } from "../services/fastSolve";
import { answerLog, failKindOf, type LoggedAnswer } from "../services/answerLog";
import { sameAction, heroActionAt } from "../services/adherence";
import { checkAnswerIntegrity, isCheckable } from "../services/answerIntegrity";
import { loadTasks, createTask, updateTask, reorderTasks } from "../services/tasks";
import { profiles as accountProfiles, snapshots as balanceSnapshots, reconcile as reconcileBalances, acks as balanceAcks, acceptReading, unacceptReading, rakeEstCents, rakePaidBb, type PricedHand } from "../services/profiles";
import { fxRate, toAudCents } from "../services/fx";
import { strategyIdForAnswer, canonicalStrategyId, STRATEGIES, FULL_EXPLOIT_ID, isTestFormat } from "../services/strategies";
import { getCatalog } from "../services/chartCatalog";
import { chartSetup, type ChartSetup } from "../services/chartSetup";
import { gtowCdp } from "../services/gtowCdp";
import { gtowApi, DEFAULT_TREE_RAKE, type CustomTreeInput } from "../services/gtowApi";
import { gtowSessions, type GtowSessionId } from "../services/gtowSessions";
import { REPO } from "../services/ledger";
import { adoptionReport, dataLayout, describeLayout, handsDbPath, openStore, resolveAllStores, splitStores, wrapperDebugDir } from "../services/storePaths";
import { ensureHandsSchema, FINISHED } from "../../../../packages/data-root/handsSchema";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { readFileSync } from "node:fs";
import { buildPreflopTokens3max } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { mesBoardFor, mesFamilyFor } from "../services/mesPostflop";
import { recordingForHand } from "./replay";
import { sourceForTier } from "../services/answerLog";
import { fetchNode as hrcFetchNode, chartFor, walk3max, HRC3MAX_BASE } from "../services/hrc3max";
import type { HrcNode } from "../services/hrc3max";
import { chartFor6max, resolveChart6max, nodeGetter } from "../services/hrc6max";
import { fetchNode6max } from "../services/hrc6maxDb";
import { nodeGetterHu } from "../services/hrc2max";
import { mesNodeDetail } from "../services/mesPostflop";
import { reconstructFlopRanges, type RawNode, type WalkStep } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { preflopPathView, dealtFromTreeId } from "../services/gtowAiPreflop";
import { solveStore } from "../services/solveStore";
import { handFacts, type HandDoc } from "../services/handFacts";
import { handVerdicts, technicalReport, type PathRow } from "../services/chainPath";

/**
 * THE HAND'S CHAIN FACTS, for the hand page (2026-09-25, services/handFacts): the requests GTO Wizard served for it
 * by origin (live decisions, the street warm-up), the tree its preflop answers were read on, the stacks as dealt, and
 * every street the chain walked — enough to see, without a trace, whether the hand took the happy path.
 */
function chainFactsOf(doc: HandDoc | undefined) {
  if (!doc) return null;
  const pf = doc.preflop;
  return {
    requests: doc.requests ?? {},
    preflop: pf ? { piece: pf.piece, id: pf.piece === "chart6max" ? pf.chartId : pf.id, codes: pf.codes, decisions: pf.picks?.length ?? 0 } : null,
    dealt: doc.dealt ?? null,
    streets: (doc.streets ?? []).map((s) => ({ k: s.k, first: s.first, plan: s.plan, kind: s.kind, tokens: s.tokens, at: s.at })),
  };
}
import { sessionsStore } from "../services/sessionsStore";
import { DEFAULT_LIVE_URL } from "../feed/resolveHand/resolveHand";
import { existsSync as fsExists, statSync as fsStat } from "node:fs";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import { fastSolve } from "../services/fastSolve";
import { studyPoller } from "../services/studyPoller";
import { fmtRoll, rollDecision } from "../services/rollDecision";
import { missQueue } from "../services/missQueue";
import { boxKeeper } from "../services/boxKeeper";
import { jobs as jobStore } from "../services/jobs";
import { buildAnswerText } from "../feed/buildAnswerText/buildAnswerText";

/**
 * Study dashboard backend: reads the wrapper's hand archive (hands.db),
 * decorates every hand with H2N-style facts (utils/handSummary), the
 * feed-spot discrepancy audit, the study answers that were pushed live
 * (services/answerLog), and best-effort net bb; re-solves any archived node
 * through the SAME live chain the table answers use (POST /resolve-chain →
 * services/fastSolve → services/aiChain, trace stored in services/solveStore).
 *
 * The archive is written by ignition-study-wrapper (Python, WAL); we read it
 * readonly. Rows are immutable once written, so summaries and audits are
 * cached by rowid for the life of the process.
 */

export const HANDS_DB = handsDbPath();
const SELF = () => `http://localhost:${process.env.PORT || 2000}`;
/** Gap that splits two hands into different sessions. */
export const SESSION_GAP_MS = 45 * 60_000;

const app = new Hono();

interface HandRow {
  rowid: number;
  hand_id: number | null;
  played_at: number | null;
  stakes: string | null;
  street: string | null;
  result_text: string | null;
  hero_cards: string | null;
  action_count: number | null;
  data: string;
  /** 'live' while the wrapper is still playing the hand, 'done' once archived (packages/data-root/handsSchema.ts) */
  status?: string | null;
  updated_at?: number | null;
}

/** the columns every hands query here reads */
export const HAND_COLS = "rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data, status, updated_at";

let db: Database | null = null;
/** The hands table (the central DB): one connection, schema brought up to date once — the wrapper writes the rows
 *  while we read them (WAL). Shared with services/answerReconciler.ts. */
export const openDb = (): Database | null => {
  if (db) return db;
  try {
    db = openStore(HANDS_DB);
    ensureHandsSchema(db);
  } catch {
    db = null;
  }
  return db;
};

export interface Enriched {
  dbId: number;
  handId: number;
  clientHandId: string | null;
  playedAt: number | null;
  stakes: string | null;
  heroCards: string[];
  summary: HandSummary;
  hand: ParsedHand;
  raw: any;
  discrepancies: { field: string; actual: unknown; shown: unknown; severity: string; note?: string }[] | null;
  /** the wrapper is still playing this hand (its row is live) */
  live: boolean;
  /** the row's last write — a live row (or a finished one the award box patched later) is re-read when it moves */
  updatedAt: number | null;
}

const cache = new Map<number, Enriched>();

/**
 * Parse + summarize a row (cached by rowid). The discrepancy audit is NOT
 * done here: it is a self-request to /api/feed-spot (~70ms each) and doing
 * it inline for every row made the first /hands after a restart fire 300+
 * of them at once with a 10s timeout — the tail timed out, and the null
 * result was cached for the life of the process ("?" in the disc column for
 * the newest third of the table). Audits now go through a sequential
 * background queue (see scheduleAudit) and a failed one is retried later.
 */
export function enrichSync(row: HandRow): Enriched | null {
  const hit = cache.get(row.rowid);
  if (hit && hit.updatedAt === (row.updated_at ?? null) && hit.live === (row.status === "live")) return hit;
  let raw: any;
  try {
    raw = JSON.parse(row.data);
  } catch {
    return null;
  }
  let hand: ParsedHand;
  try {
    hand = normalizeHand(raw).hand;
  } catch {
    return null;
  }
  const summary = summarizeHand(hand, raw.heroFolded, raw.heroWon);
  const e: Enriched = {
    dbId: row.rowid,
    handId: hand.handId,
    clientHandId: (typeof raw.clientHandId === "string" && raw.clientHandId) || null,
    playedAt: row.played_at,
    stakes: row.stakes,
    heroCards: hand.heroCards,
    summary,
    hand,
    raw,
    discrepancies: row.status === "live" ? null : storedAudit(row.rowid, row.updated_at ?? null),
    live: row.status === "live",
    updatedAt: row.updated_at ?? null,
  };
  cache.set(row.rowid, e);
  return e;
}

/** Enrich and make sure an audit is on its way (non-blocking). */
async function enrich(row: HandRow): Promise<Enriched | null> {
  const e = enrichSync(row);
  if (e && !e.live && e.discrepancies == null) scheduleAudit(e);   // a hand still in play is audited once it is finished
  return e;
}

/**
 * Discrepancy audit — local computation (charts only, no cloud). Resolves
 * with the audit stored on the hand; leaves it null (to be retried) only
 * when the audit route could not be reached at all. A reply the route
 * itself rejected is stored as an empty audit — retrying would not change it.
 */
async function audit(e: Enriched): Promise<void> {
  if (e.discrepancies != null) return;
  try {
    const res = await fetch(`${SELF()}/api/feed-spot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hand: e.raw }),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json().catch(() => null);
    if (j == null) return; // no usable reply — retry on a later request
    e.discrepancies = j.ok ? j.discrepancies ?? [] : [];
    storeAudit(e);
  } catch {
    /* audit unavailable — leave null, retried by the next scheduleAudit */
  }
}

/**
 * AUDITS ARE KEPT (2026-09-26): the audit used to live only in this process's `cache`, so every API start re-audited
 * every finished hand on the first /hands — ~1,200 self-requests to /api/feed-spot per restart (four restarts in the
 * 17Z hour: 2,348/h), each one synchronous chart work. Now each result is stored in the central DB's hand_audits,
 * keyed by the hand's row, its last write (updated_at: the award box patches finished rows) and AUDIT_BASIS — what the
 * audit read (the preflop DB and resolved charts, by size and mtime, plus AUDIT_VERSION for a change to the audit's
 * own rules). A hand whose row or basis moved is audited again.
 */
const AUDIT_VERSION = 1;
let auditBasisMemo: string | null = null;
function auditBasis(): string {
  if (auditBasisMemo) return auditBasisMemo;
  const sig = (rel: string) => {
    try {
      const st = fsStat(join(import.meta.dir, "..", "..", "data", rel));
      return `${st.size}:${Math.trunc(st.mtimeMs)}`;
    } catch {
      return "-";
    }
  };
  return (auditBasisMemo = `v${AUDIT_VERSION}|${sig("preflop-db.sqlite")}|${sig("resolved-charts.json")}`);
}

type StoredAudit = { updatedAt: number | null; disc: NonNullable<Enriched["discrepancies"]> };
let storedAudits: Map<number, StoredAudit> | null = null;
function auditsLoaded(): Map<number, StoredAudit> {
  if (storedAudits) return storedAudits;
  storedAudits = new Map();
  const d = openDb();
  if (!d) return storedAudits;
  try {
    d.run(`CREATE TABLE IF NOT EXISTS hand_audits (hand_rowid INTEGER PRIMARY KEY, updated_at INTEGER, basis TEXT NOT NULL,
             discrepancies TEXT NOT NULL, at INTEGER NOT NULL)`);
    // one read of the lot on first use (the first /hands enriches every row): a map lookup per row after that
    for (const r of d.query<{ hand_rowid: number; updated_at: number | null; discrepancies: string }, [string]>(
      "SELECT hand_rowid, updated_at, discrepancies FROM hand_audits WHERE basis = ?").all(auditBasis())) {
      try {
        storedAudits.set(r.hand_rowid, { updatedAt: r.updated_at, disc: JSON.parse(r.discrepancies) });
      } catch { /* a torn row: audited again */ }
    }
  } catch (err) {
    console.log(`[audit] hand_audits unreadable — audits run in memory only: ${err instanceof Error ? err.message : err}`);
  }
  return storedAudits;
}

/** The stored audit for this row as it is now, or null (never audited, or the row / the charts moved since). */
function storedAudit(rowid: number, updatedAt: number | null): Enriched["discrepancies"] {
  const hit = auditsLoaded().get(rowid);
  return hit && hit.updatedAt === updatedAt ? hit.disc : null;
}

function storeAudit(e: Enriched): void {
  if (e.live || e.discrepancies == null) return;
  auditsLoaded().set(e.dbId, { updatedAt: e.updatedAt, disc: e.discrepancies });
  try {
    openDb()?.run(`INSERT INTO hand_audits (hand_rowid, updated_at, basis, discrepancies, at) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(hand_rowid) DO UPDATE SET updated_at = excluded.updated_at, basis = excluded.basis,
                   discrepancies = excluded.discrepancies, at = excluded.at`,
                  [e.dbId, e.updatedAt, auditBasis(), JSON.stringify(e.discrepancies), Date.now()]);
  } catch (err) {
    console.log(`[audit] could not store the audit of row ${e.dbId}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Test hook: what a restart forgets — the enriched rows and the audits read from hand_audits. */
export function _restartForTests(): void {
  cache.clear();
  storedAudits = null;
  auditBasisMemo = null;
}

const auditQueue: Enriched[] = [];
const auditQueued = new Set<number>();
let auditPumping = false;
function scheduleAudit(e: Enriched): void {
  if (e.discrepancies != null || auditQueued.has(e.dbId)) return;
  auditQueued.add(e.dbId);
  // Newest first: it is what the table shows at the top.
  auditQueue.unshift(e);
  if (!auditPumping) void pumpAudits();
}
async function pumpAudits(): Promise<void> {
  auditPumping = true;
  try {
    while (auditQueue.length) {
      const e = auditQueue.shift()!;
      await audit(e);
      auditQueued.delete(e.dbId);
    }
  } finally {
    auditPumping = false;
  }
}
/** Audits still queued/running — the page polls while this is > 0. */
const auditPending = (): number => auditQueued.size;

/** FINISHED hands only — every analytic, net and reconciliation reads these. `liveRows` is the hands in play. */
export const allRows = (): HandRow[] => {
  const d = openDb();
  if (!d) return [];
  const rows = d
    .query<HandRow, []>(`SELECT ${HAND_COLS} FROM hands WHERE ${FINISHED} ORDER BY rowid`)
    .all();
  // Wrapper restarts / table-close flushes archive the same hand more than
  // once — keep only the LAST row per site hand id (most complete capture).
  const bySite = new Map<string, HandRow>();
  const out: HandRow[] = [];
  let lastKey: string | null = null;
  for (const r of rows) {
    const key = bodyKey(r);
    const m = r.data.match(/"clientHandId":\s*"(\d+)"/);
    if (!m) {
      // No site id: either the pre-id era, or a reopen replay — the wrapper
      // (before 2026-09-03) re-archived the previous hand's WS state under a
      // fresh counter every time a table closed and reopened. The replay's
      // content matches the hand kept right before it; that earlier row is
      // the real capture (it has the feed lines), so the replay is dropped.
      if (key != null && key === lastKey) continue;
      out.push(r);
      lastKey = key;
      continue;
    }
    // 9000xxx is the wrapper's synthetic id for a State Tester authored
    // state (launch.py _faketable_load) — a few leaked into the archive when
    // test mode was switched off (fixed 2026-09-03). Not played hands.
    if (/^900\d{4}$/.test(m[1]!)) continue;
    const prev = bySite.get(m[1]!);
    if (prev) out.splice(out.indexOf(prev), 1);
    bySite.set(m[1]!, r);
    out.push(r);
    lastKey = key;
  }
  return out;
};

/** A "live" row the wrapper has not touched for this long was abandoned (the wrapper stopped mid-hand). */
export const LIVE_STALE_MS = 10 * 60_000;

/** Hands the wrapper is playing right now (its live rows), oldest first; `stale` = no write for LIVE_STALE_MS. */
export const liveRows = (now = Date.now()): (HandRow & { stale: boolean })[] => {
  const d = openDb();
  if (!d) return [];
  return d.query<HandRow, []>(`SELECT ${HAND_COLS} FROM hands WHERE status = 'live' ORDER BY rowid`).all()
    .map((r) => ({ ...r, stale: now - (r.updated_at ?? 0) > LIVE_STALE_MS }));
};

/** Content identity of an archived row — stakes, hero cards, action list. */
const bodyKeys = new Map<number, string | null>();
function bodyKey(r: HandRow): string | null {
  if (bodyKeys.has(r.rowid)) return bodyKeys.get(r.rowid)!;
  let key: string | null = null;
  try {
    const d = JSON.parse(r.data);
    const acts = Array.isArray(d.actions)
      ? d.actions.map((a: any) => `${a.seatId}:${a.type}:${a.amount ?? ""}`).join(",")
      : "";
    key = `${r.stakes ?? ""}|${r.hero_cards ?? ""}|${acts}`;
  } catch {
    key = null;
  }
  bodyKeys.set(r.rowid, key);
  return key;
}

/**
 * Best-effort net bb per hand:
 *  - uncontested win → pot minus hero's own contribution
 *  - hero folded → minus hero's contribution
 *  - showdown → hero stack difference to the NEXT hand in the same session
 *    (accepted only when the delta is plausible for the pot), else null.
 */
export function computeNets(hands: Enriched[]): Map<number, number | null> {
  const nets = new Map<number, number | null>();
  for (let i = 0; i < hands.length; i++) {
    const h = hands[i]!;
    const s = h.summary;
    if (s.heroWonUncontested) {
      nets.set(h.dbId, Math.round((s.potBb - s.heroInvestedBb) * 100) / 100);
      continue;
    }
    if (s.heroFolded) {
      nets.set(h.dbId, -s.heroInvestedBb);
      continue;
    }
    // SHOWDOWN, from the client's own award (2026-09-19, hand 4919174586): the
    // wrapper archives the result box — "Player N wins ($X)" — as result.winnerSeat
    // / wonCents. Hero won ⇒ the award minus what hero put in; lost ⇒ minus what
    // hero put in. Exact, rake already off the award, and no stack chaining.
    const res = (h.raw as any)?.result as { winnerSeat?: number | null; wonCents?: number | null; heroWon?: boolean | null } | undefined;
    const bbUsd = bbUsdOf(h.stakes);
    if (res && res.winnerSeat != null && res.wonCents != null && bbUsd) {
      const wonBb = res.wonCents / 100 / bbUsd;
      const heroWon = res.winnerSeat === h.hand.heroSeatId || res.heroWon === true;
      nets.set(h.dbId, Math.round((heroWon ? wonBb - s.heroInvestedBb : -s.heroInvestedBb) * 100) / 100);
      continue;
    }
    // Fallback: chain hero's stacks. The archived stack is hero's stack at the END of
    // the hand, so the hand's result is THIS hand's end stack minus the PREVIOUS
    // hand's end stack — until 2026-09-19 it was chained forward (next − this),
    // which priced every showdown with the following hand's result (hand
    // 4919174586: a 19bb loss read as −0.5). Still blind to a top-up between the
    // two hands, which is why the award above is preferred.
    const prev = hands[i - 1];
    const curStack = h.hand.stacks?.[h.hand.heroSeatId];
    const prevStack = prev?.hand.stacks?.[prev.hand.heroSeatId];
    if (
      prev &&
      curStack != null &&
      prevStack != null &&
      prev.stakes === h.stakes &&
      prev.playedAt != null &&
      h.playedAt != null &&
      h.playedAt - prev.playedAt < SESSION_GAP_MS
    ) {
      const diff = Math.round((curStack - prevStack) * 100) / 100;
      // plausibility: can't win more than the pot or lose more than invested+pot
      if (Math.abs(diff) <= s.potBb + 5) {
        nets.set(h.dbId, diff);
        continue;
      }
    }
    nets.set(h.dbId, null);
  }
  return nets;
}

/** clientHandId -> the whole-hand strategy that was live for it, from the
 *  answer log (a hand that got any MES-postflop answer is the full exploit strategy, else the mode). */
function strategyByHand(): Map<string, { id: string; name: string }> {
  const byName = new Map(STRATEGIES.map((x) => [x.id, x.name]));
  const out = new Map<string, { id: string; name: string }>();
  for (const a of answerLog.rows(365)) {
    const h = (a as { client_hand_id?: string | null }).client_hand_id;
    const sid = strategyIdForAnswer(a as never);
    if (!h || !sid) continue;
    const cur = out.get(h);
    // the full exploit wins over the mode-only tag: a postflop MES answer proves both layers
    if (!cur || (sid === FULL_EXPLOIT_ID && cur.id !== FULL_EXPLOIT_ID)) out.set(h, { id: sid, name: byName.get(sid) ?? sid });
  }
  return out;
}

/** The strategy a finished hand was played under: its session's declared one, else the one its answers name. */
function strategyOfHand(e: Enriched): string | null {
  const sid = typeof e.raw?.sessionId === "string" ? e.raw.sessionId : null;
  if (sid) {
    const sess = sessionsStore.list(500).find((x) => x.id === sid);
    const declared = canonicalStrategyId(typeof sess?.config?.strategy === "string" ? sess.config.strategy : null);
    if (declared) return declared;
  }
  return e.clientHandId ? strategyByHand().get(e.clientHandId)?.id ?? null : null;
}

app.get("/hands", async (c) => {
  const rows = allRows();
  const enriched = (await Promise.all(rows.map(enrich))).filter((x): x is Enriched => x != null);
  const nets = computeNets(enriched);
  const strat = strategyByHand();
  // the session's declared strategy wins over the heuristic: a declared exploit session
  // stays that even on a hand where no MES spot arose (a 5-handed Zone hand, say).
  // Old sessions carry the pre-2026-09-12 ids (apex, …) — canonicalStrategyId maps them.
  const byName = new Map(STRATEGIES.map((x) => [x.id, x.name]));
  const declared = new Map<string, string>();
  // sessions declared at a TEST STAKE (strategies.ts TEST_FORMATS): same strategy, flagged so no
  // surface reads a 5NL reader test as evidence about the NL200 strategy
  const testSessions = new Set<string>();
  for (const sess of sessionsStore.list(500)) {
    const id = canonicalStrategyId(typeof sess.config?.strategy === "string" ? sess.config.strategy : null);
    if (id && byName.has(id)) declared.set(sess.id, id);
    if (isTestFormat(sess.config?.format)) testSessions.add(sess.id);
  }
  const strategyOf = (e: Enriched) => {
    const sid = typeof e.raw?.sessionId === "string" ? e.raw.sessionId : null;
    const d = sid ? declared.get(sid) : undefined;
    if (d) return { id: d, name: byName.get(d) ?? d, declared: true, test: testSessions.has(sid!) };
    const h = e.clientHandId ? strat.get(e.clientHandId) : null;
    return h ? { ...h, declared: false } : null;
  };
  const sess = sessionsIndex(enriched);
  const byCid = answersByHand(answerLog.rows(3650));
  // THE HANDS BEING PLAYED (2026-09-25): the wrapper's live rows, the same rows it finishes when the hand ends
  const live = liveRows().map((r) => ({ r, e: enrichSync(r) })).filter((x): x is { r: ReturnType<typeof liveRows>[number]; e: Enriched } => x.e != null);
  const liveHands = live.map(({ r, e }) => ({
    dbId: e.dbId, handId: e.handId, clientHandId: e.clientHandId, playedAt: e.playedAt, stakes: e.stakes, heroCards: e.heroCards,
    netBb: null, strategy: strategyOf(e), session: typeof e.raw?.sessionId === "string" ? e.raw.sessionId : null,
    table: typeof e.raw?.tableSlot === "number" ? e.raw.tableSlot : null,
    answerStatus: answerStatusOf(e, byCid),
    integrityFaults: integrityTotals(e.clientHandId ? byCid.get(e.clientHandId) ?? [] : []).faults,
    summary: e.summary, discrepancies: null,
    live: r.stale ? "unfinished" : "live", updatedAt: e.updatedAt,
  })).reverse();
  const hands = enriched
    .map((e) => ({
      dbId: e.dbId,
      handId: e.handId,
      clientHandId: e.clientHandId,
      playedAt: e.playedAt,
      stakes: e.stakes,
      heroCards: e.heroCards,
      netBb: nets.get(e.dbId) ?? null,
      strategy: strategyOf(e),
      // the session this hand belongs to — the same id the Sessions tab uses
      session: sess.byHand.get(e.dbId) ?? null,
      // WHICH OF THE SESSION'S TABLES (2026-09-20). The wrapper has stamped
      // `tableSlot` on every archived hand since multi-table landed; it was
      // simply never surfaced. null = a single-table session, which tables.py
      // gives no slot on purpose ("None is not slot 1").
      table: typeof e.raw?.tableSlot === "number" ? e.raw.tableSlot : null,
      answerStatus: answerStatusOf(e, byCid),
      // severe integrity faults among THIS hand's answers — normally 0
      integrityFaults: integrityTotals(e.clientHandId ? byCid.get(e.clientHandId) ?? [] : []).faults,
      summary: e.summary,
      discrepancies: e.discrepancies
        ? {
            major: e.discrepancies.filter((d) => d.severity === "major").length,
            minor: e.discrepancies.filter((d) => d.severity === "minor").length,
            info: e.discrepancies.filter((d) => d.severity === "info").length,
          }
        : null,
    }))
    .reverse(); // newest first
  return c.json({ ok: true, total: hands.length, live: liveHands.filter((h) => h.live === "live").length, auditPending: auditPending(), sessions: sess.list, hands: [...liveHands, ...hands] });
});

/** Session per hand, for the Hands tab filter: the declared session the hand
 *  was stamped with, else the undeclared gap cluster the Sessions tab shows it
 *  in. Ids match GET /sessions (declared id, or `cluster-<startedAt>`). */
function sessionsIndex(all: Enriched[]) {
  type Card = { id: string; declared: boolean; label: string | null; preset: string | null; strategyName: string | null; startedAt: number | null; endedAt: number | null; stakes: string | null; hands: number; profile: string | null;
    /** hands per table of this session, ascending by slot. One entry with slot
     *  null is the ordinary single-table session. More than one entry means the
     *  sitting really was multi-table — and if the DECLARED count disagrees with
     *  what actually played, that is worth seeing (session 130435 declared two
     *  and only ever archived table 2's). */
    tables: { slot: number | null; hands: number }[]; declaredTables: number | null;
    /** declared at a test stake (strategies.ts TEST_FORMATS) */
    test: boolean };

  /** hands per slot, ascending, nulls last. */
  const tablesOf = (hs: Enriched[]): { slot: number | null; hands: number }[] => {
    const by = new Map<number | null, number>();
    for (const e of hs) {
      const t = typeof e.raw?.tableSlot === "number" ? e.raw.tableSlot : null;
      by.set(t, (by.get(t) ?? 0) + 1);
    }
    return [...by.entries()]
      .map(([slot, hands]) => ({ slot, hands }))
      .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  };
  const byHand = new Map<number, string>();
  const list: Card[] = [];
  const declared = new Map(sessionsStore.list(500).map((s) => [s.id, s]));
  const stamped = new Map<string, Enriched[]>();
  for (const e of all) {
    const sid = typeof e.raw?.sessionId === "string" ? e.raw.sessionId : null;
    if (!sid) continue;
    byHand.set(e.dbId, sid);
    const hs = stamped.get(sid);
    if (hs) hs.push(e); else stamped.set(sid, [e]);
  }
  for (const [sid, hs] of stamped) {
    const s = declared.get(sid);
    const cfg: any = s?.config ?? {};
    list.push({
      id: sid, declared: true, label: s?.label ?? null, preset: s?.preset ?? null,
      strategyName: typeof cfg.strategyName === "string" ? cfg.strategyName : null,
      startedAt: s?.startedAt ?? hs[0]!.playedAt ?? null, endedAt: s?.endedAt ?? null, stakes: hs[0]!.stakes ?? null, hands: hs.length,
      profile: typeof cfg.profile === "string" && cfg.profile ? cfg.profile : null,
      tables: tablesOf(hs),
      declaredTables: Number.isFinite(Number(cfg.tables)) ? Number(cfg.tables) : null,
      test: isTestFormat(cfg.format),
    });
  }
  for (const hs of gapClusters(all)) {
    const id = `cluster-${hs[0]!.playedAt}`;
    for (const e of hs) byHand.set(e.dbId, id);
    list.push({ id, declared: false, label: null, preset: null, strategyName: null, startedAt: hs[0]!.playedAt ?? null, endedAt: hs[hs.length - 1]!.playedAt ?? null, stakes: hs[0]!.stakes ?? null, hands: hs.length, profile: null, tables: tablesOf(hs), declaredTables: null, test: false });
  }
  list.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)); // newest first, like the table
  return { byHand, list };
}

/** Per-hand study-answer status, the one definition every review surface reads
 *  (Hands table, session page, Analytics link-through). "no-decision" means the
 *  archive shows no hero action beyond the blinds — often because the capture
 *  stopped before hero's own last action — so read it as "no decision SEEN". */
export type DecisionRef = {
  index: number; street: string | null;
  /** for an UNANSWERED decision: why, from the last failed row at this node
   *  (services/answerLog FAIL_KINDS; null when nothing was ever logged here) */
  kind: string | null; reason: string | null;
};
export type AnswerStatus = {
  status: "answered" | "partial" | "failed" | "missing" | "no-decision" | "unknown";
  /** rows, not decisions: the poller logs one every time the state changes */
  answered: number; failed: number; reason: string | null;
  /** hero's decisions in this hand, and how many of them an answer covered */
  decisions: number; covered: number; uncovered: DecisionRef[];
  /** answers keyed to a node that was never one of hero's decisions */
  stray: number;
};

/** The last element of `decision_key` is hero's action index in the archived
 *  hand — the only thing that joins an answer to the decision it answered. */
export function decisionIndexOf(a: LoggedAnswer): number | null {
  try {
    const k = JSON.parse(a.decision_key ?? "");
    const last = Array.isArray(k) ? k[k.length - 1] : null;
    return typeof last === "number" ? last : null;
  } catch { return null; }
}

/** Hero's own decisions in the archive: every hero action bar the blinds. */
function heroDecisionsOf(e: Enriched): DecisionRef[] {
  const acts = e.hand.actions as { hero?: boolean; type?: string; street?: string }[];
  const out: DecisionRef[] = [];
  acts.forEach((a, index) => {
    if (a.hero && a.type !== "post-sb" && a.type !== "post-bb" && a.type !== "post-ante") out.push({ index, street: a.street ?? null, kind: null, reason: null });
  });
  return out;
}

/**
 * Which of hero's decisions actually got an answer.
 *
 * Counting ROWS says nothing about coverage: the poller logs a row on every
 * state change, so one decision often has several, and a failed capture can be
 * keyed to a node hero never acted on (a stale read — hand #353's river failure
 * is keyed to the turn). Only the join by decision index answers "which nodes
 * were left unanswered", and duplicates collapse on it.
 *
 * The denominator is the archive's hero actions UNION the indices that produced
 * a REAL answer: the archive sometimes stops before hero's last action (see
 * answersFor), and an answered node is proof the decision existed whatever the
 * archive kept. Failed rows never widen it — they are exactly the ones that can
 * point at a node that was never hero's to act on.
 */
export function coverageOf(e: Enriched, rows: LoggedAnswer[]) {
  const byIndex = new Map<number, DecisionRef>(heroDecisionsOf(e).map((d) => [d.index, d]));
  const answeredIdx = new Set<number>(), allIdx = new Set<number>();
  for (const a of rows) {
    const i = decisionIndexOf(a);
    if (i == null) continue;
    allIdx.add(i);
    if (a.text != null) answeredIdx.add(i);
  }
  for (const i of answeredIdx) if (!byIndex.has(i)) byIndex.set(i, { index: i, street: null, kind: null, reason: null });
  const decisions = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const uncovered = decisions.filter((d) => !answeredIdx.has(d.index)).map((d) => {
    // the last thing that went wrong at this node, when anything was logged at all
    const last = rows.filter((a) => a.text == null && decisionIndexOf(a) === d.index).pop();
    return last ? { ...d, kind: last.fail_kind ?? failKindOf(last.fail_reason), reason: last.fail_reason } : d;
  });
  const stray = [...allIdx].filter((i) => !byIndex.has(i)).length;
  return { decisions, covered: decisions.length - uncovered.length, uncovered, stray };
}

/** Session/scope totals of the same join. */
function coverageTotals(hs: Enriched[], byCid: Map<string, LoggedAnswer[]>) {
  let decisions = 0, covered = 0, stray = 0, unansweredNodes = 0, partialHands = 0;
  // why the unanswered ones were unanswered, counted per DECISION
  const kinds: Record<string, number> = {};
  for (const e of hs) {
    const cov = coverageOf(e, e.clientHandId ? byCid.get(e.clientHandId) ?? [] : []);
    decisions += cov.decisions.length; covered += cov.covered; stray += cov.stray;
    unansweredNodes += cov.uncovered.length;
    for (const u of cov.uncovered) { const k = u.kind ?? "unexplained"; kinds[k] = (kinds[k] ?? 0) + 1; }
    if (cov.uncovered.length && cov.covered) partialHands++;
  }
  return { decisions, covered, stray, unansweredNodes, partialHands, kinds, coveredPct: decisions ? Math.round((1000 * covered) / decisions) / 10 : null };
}
/**
 * Does one logged answer agree with its own evidence? (services/answerIntegrity.ts)
 * Computed at READ time from the row's own columns rather than stamped at write
 * time, so rows logged before the check existed are audited too — including the
 * 2026-09-14 fault this was built for. `checkable` is false for answers logged
 * before decision_json existed: those are UNCHECKED, never "clean".
 */
export function integrityOf(a: { pick?: string | null; roll?: number | null; decision_json?: string | null }) {
  let actions: { action: string; frequency: number }[] | null = null;
  try { const p = JSON.parse(a.decision_json ?? "null"); if (Array.isArray(p) && p.length) actions = p; } catch { /* legacy row */ }
  const spec = { pick: a.pick ?? null, roll: a.roll ?? null, actions };
  return { checkable: isCheckable(spec), faults: checkAnswerIntegrity(spec) };
}

/** Severe integrity faults over a set of logged answers, with what could not be checked. */
export function integrityTotals(rows: { pick?: string | null; roll?: number | null; decision_json?: string | null; text?: string | null }[]) {
  let faults = 0, servedOffMix = 0, rollMismatch = 0, checked = 0, unchecked = 0;
  for (const a of rows) {
    if (a.text == null) continue; // a failed answer has nothing to disagree with
    const v = integrityOf(a);
    if (!v.checkable) { unchecked++; continue; }
    checked++;
    for (const f of v.faults) {
      faults++;
      if (f.kind === "served-off-mix") servedOffMix++; else rollMismatch++;
    }
  }
  return { faults, servedOffMix, rollMismatch, checked, unchecked };
}

export function answersByHand(rows: LoggedAnswer[]): Map<string, LoggedAnswer[]> {
  const m = new Map<string, LoggedAnswer[]>();
  for (const a of rows) if (a.client_hand_id) { const xs = m.get(a.client_hand_id); if (xs) xs.push(a); else m.set(a.client_hand_id, [a]); }
  return m;
}
function answerStatusOf(e: Enriched, byCid: Map<string, LoggedAnswer[]>): AnswerStatus {
  const none = { decisions: 0, covered: 0, uncovered: [] as DecisionRef[], stray: 0 };
  if (!e.clientHandId) return { status: "unknown", answered: 0, failed: 0, reason: "the hand has no site id, so answers cannot be joined to it", ...none };
  const rows = byCid.get(e.clientHandId) ?? [];
  const answered = rows.filter((a) => a.text != null).length;
  // A no-probe row is the reconciler's note that nobody ASKED here; it is not a
  // solve that failed, and counting it as one turned "no answer" into "failed ×1".
  const fails = rows.filter((a) => a.text == null && (a.fail_kind ?? failKindOf(a.fail_reason)) !== "no-probe");
  const failed = fails.length;
  const cov = coverageOf(e, rows);
  const base = { answered, failed, decisions: cov.decisions.length, covered: cov.covered, uncovered: cov.uncovered, stray: cov.stray };
  // PARTIAL is the case a hand-level status used to hide: one good answer made the
  // whole hand "answered" however many of its nodes went unanswered (hand #353).
  if (cov.covered && cov.uncovered.length) {
    const where = cov.uncovered.map((d) => d.street ?? `action ${d.index}`).join(", ");
    return { ...base, status: "partial", reason: `${cov.uncovered.length} of ${cov.decisions.length} decisions never answered: ${where}` };
  }
  if (cov.covered) return { ...base, status: "answered", reason: null };
  if (failed) return { ...base, status: "failed", reason: fails[0]?.fail_reason ?? "solve failed" };
  const acted = (e.hand.actions as { hero?: boolean; type?: string }[]).some((a) => a.hero && a.type !== "post-sb" && a.type !== "post-bb");
  return acted
    ? { ...base, status: "missing", reason: "hero acted but no answer was logged" }
    : { ...base, status: "no-decision", reason: "no hero action in the archive beyond the blinds — the capture may have stopped before it" };
}

// ------------------------------------------------------------ analytics (scoped)
//
// The Analytics tab is scope → core → global. A SCOPE is a set of hands (all,
// some sessions, some months, some stakes, a date range); the CORE is the same
// aggregate, per-session breakdown, hand series and answer grading computed for
// that set, and a second scope rides along for comparison. The global block
// (winrate ladder, MES uplift, latency, miss queue) is about the solver and the
// corpus, so it is served by the routes it always was and ignores the scope.

type Scope = { kind: "all" | "sessions" | "months" | "stakes" | "range"; items: string[]; from: number | null; to: number | null };
type SessionsIdx = ReturnType<typeof sessionsIndex>;

/** `all` · `sessions:a,b` · `months:2026-09,2026-08` · `stakes:$0.12/$0.25` · `range:<fromMs>-<toMs>` */
function parseScope(spec: string | undefined | null): Scope {
  const s = (spec ?? "all").trim();
  const m = s.match(/^(sessions|months|stakes|range):(.*)$/);
  if (!m) return { kind: "all", items: [], from: null, to: null };
  const kind = m[1] as Scope["kind"];
  if (kind === "range") {
    const r = m[2]!.match(/^(\d+)-(\d+)$/);
    return { kind, items: [], from: r ? Number(r[1]) : null, to: r ? Number(r[2]) : null };
  }
  return { kind, items: m[2]!.split(",").map((x) => x.trim()).filter(Boolean), from: null, to: null };
}

const monthKey = (ms: number | null) => {
  if (ms == null) return "?";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" }) : key;
};
const shortDay = (ms: number | null) => ms == null ? "?" : new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function scopeHands(scope: Scope, all: Enriched[], idx: SessionsIdx): Enriched[] {
  const want = new Set(scope.items);
  switch (scope.kind) {
    case "all": return all;
    case "sessions": return all.filter((e) => want.has(idx.byHand.get(e.dbId) ?? ""));
    case "months": return all.filter((e) => want.has(monthKey(e.playedAt)));
    case "stakes": return all.filter((e) => want.has(e.stakes ?? "?"));
    case "range": return all.filter((e) => e.playedAt != null && (scope.from == null || e.playedAt >= scope.from) && (scope.to == null || e.playedAt <= scope.to));
  }
}

function scopeLabel(scope: Scope, idx: SessionsIdx): string {
  switch (scope.kind) {
    case "all": return "All hands";
    case "sessions": {
      const cards = scope.items.map((id) => idx.list.find((s) => s.id === id)).filter((x): x is SessionsIdx["list"][number] => !!x);
      if (cards.length === 1) { const s = cards[0]!; return `Session ${shortDay(s.startedAt)} · ${s.declared ? (s.strategyName ?? s.label ?? s.preset ?? "declared") : "undeclared"}`; }
      return `${cards.length} sessions`;
    }
    case "months": return scope.items.length === 1 ? monthLabel(scope.items[0]!) : `${scope.items.length} months`;
    case "stakes": return scope.items.join(", ");
    case "range": return `${shortDay(scope.from)} – ${shortDay(scope.to)}`;
  }
}

// ------------------------------------------------------------ profile + window
//
// A SCOPE picks hands by what they are (sessions, months, stakes, a fixed date
// range). The Home page picks them by WHOSE they are and HOW RECENT they are,
// and wants both at once, so those two ride alongside the scope as their own
// query params and intersect with it. Keeping them out of the scope grammar
// means a bookmark stays honest: `window=7d` is relative and re-reads "the last
// seven days" every time it is opened, where a `range:` spec would freeze the
// day it was made.

/** Rolling windows, in days back from now; `all` is the whole corpus. */
export const WINDOWS: { id: string; label: string; days: number | null }[] = [
  { id: "1d", label: "24h", days: 1 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "14d", label: "2 weeks", days: 14 },
  { id: "30d", label: "1 month", days: 30 },
  { id: "all", label: "All time", days: null },
];
const windowDays = (id: string | undefined | null) => WINDOWS.find((w) => w.id === id)?.days ?? null;

/** The profile a hand was played on, via the session it belongs to: only a
 *  DECLARED session carries one (auth.py writes it at Start), so every hand from
 *  before that flow — and every gap cluster — is unattributed. */
function profileOfHand(e: Enriched, idx: SessionsIdx): string | null {
  const sid = idx.byHand.get(e.dbId);
  if (!sid) return null;
  return idx.list.find((s) => s.id === sid)?.profile ?? null;
}

/** `profile`: absent or `all` = every hand; `none` = the unattributed ones;
 *  otherwise the account's name. `window`: one of WINDOWS, rolling from now. */
function narrowHands(all: Enriched[], idx: SessionsIdx, profile: string | null | undefined, win: string | null | undefined): Enriched[] {
  const days = windowDays(win);
  const cut = days == null ? null : Date.now() - days * 86_400_000;
  const p = profile && profile !== "all" ? profile : null;
  if (p == null && cut == null) return all;
  return all.filter((e) => {
    if (cut != null && (e.playedAt == null || e.playedAt < cut)) return false;
    if (p == null) return true;
    const own = profileOfHand(e, idx);
    return p === "none" ? own == null : own === p;
  });
}

/** The analytics core's aggregate over one set of hands: frequencies, net with
 *  its standard error, and discrepancy counts. */
export function aggregateHands(hs: Enriched[], nets: Map<number, number | null>) {
  const n = hs.length;
  const pct = (k: (s: HandSummary) => boolean, base?: (s: HandSummary) => boolean) => {
    const denom = base ? hs.filter((h) => base(h.summary)).length : n;
    const num = hs.filter((h) => k(h.summary) && (!base || base(h.summary))).length;
    return denom ? Math.round((1000 * num) / denom) / 10 : null;
  };
  const known = hs.map((h) => nets.get(h.dbId)).filter((x): x is number => x != null);
  const netBb = Math.round(known.reduce((s, x) => s + x, 0) * 100) / 100;
  // RAKE PAID — the site's schedule on the pots hero won (services/profiles.ts
  // rakePaidBb). `unseen` is the part computeNets never saw: an uncontested win
  // after a flop is priced off the displayed, pre-rake pot, so net-after-rake
  // takes it off; a showdown win came from the stack delta and already has it.
  let rakeBb = 0, rakeUnseenBb = 0, rakeCents = 0, rakedHands = 0;
  for (const h of hs) {
    const bb = bbUsdOf(h.stakes);
    // the July-era rows lost their board, so sawFlop AND wentToShowdown are both false on
    // hands the client itself settled "with (Two pair…)": the result text is the one
    // showdown signal that survived, and a showdown is a raked pot
    const resultText = String((h.raw as any)?.result?.text ?? "");
    const showdownByText = / with \(/.test(resultText);
    // the archive says who won: the hand's heroWon flag (uncontested), the client's
    // award (result.winnerSeat, 2026-09-19), or a "★ <name> wins" line naming hero.
    // A NAMELESS "★ wins" line is NOT hero's: the wrapper lost the winner's name on
    // every showdown line until 2026-09-19 and this regex then credited hero with
    // every villain showdown win.
    const rr = (h.raw as any)?.result as { winnerSeat?: number | null; heroWon?: boolean | null } | undefined;
    const won = (h.raw as any)?.heroWon === true || rr?.heroWon === true
      || (rr?.winnerSeat != null && rr.winnerSeat === h.hand.heroSeatId)
      || new RegExp(`^★\\s*Player ${h.hand.heroSeatId}\\b`).test(resultText);
    const r = rakePaidBb({ ...h.summary, wentToShowdown: h.summary.wentToShowdown || showdownByText, won }, bb, nets.get(h.dbId) ?? null);
    if (r.bb > 0) { rakedHands++; rakeBb += r.bb; if (r.unseen) rakeUnseenBb += r.bb; if (bb != null) rakeCents += Math.round(r.bb * bb * 100); }
  }
  rakeBb = Math.round(rakeBb * 100) / 100; rakeUnseenBb = Math.round(rakeUnseenBb * 100) / 100;
  const netAfterRakeBb = Math.round((netBb - rakeUnseenBb) * 100) / 100;
  const mean = known.length ? netBb / known.length : 0;
  const sd = known.length > 1 ? Math.sqrt(known.reduce((s, x) => s + (x - mean) ** 2, 0) / (known.length - 1)) : null;
  const disc = { major: 0, minor: 0, info: 0 };
  for (const h of hs) {
    for (const dd of h.discrepancies ?? []) {
      if (dd.severity === "major") disc.major++;
      else if (dd.severity === "minor") disc.minor++;
      else disc.info++;
    }
  }
  return {
    hands: n,
    vpip: pct((s) => s.vpip),
    pfr: pct((s) => s.pfr),
    threeBet: pct((s) => s.threeBet, (s) => s.threeBetOpp),
    wtsd: pct((s) => s.wentToShowdown, (s) => s.sawFlop),
    sawFlop: pct((s) => s.sawFlop),
    limpedPots: pct((s) => s.limpedPot),
    netBb,
    netKnownHands: known.length,
    bb100: known.length ? Math.round((10000 * netBb) / known.length) / 100 : null,
    // rake paid on won pots: total, in money, per 100 hands, and the net once the
    // part the recorded net never saw is taken off
    rakePaidBb: rakeBb,
    rakePaidCents: rakeCents,
    rakedHands,
    rakePer100: n ? Math.round((10000 * rakeBb) / n) / 100 : null,
    rakeUnseenBb,
    netAfterRakeBb,
    bb100AfterRake: known.length ? Math.round((10000 * netAfterRakeBb) / known.length) / 100 : null,
    // 100 × SE of the per-hand mean, over the hands whose net is known
    bb100Se: sd != null && known.length ? Math.round((10000 * sd) / Math.sqrt(known.length)) / 100 : null,
    discrepancies: disc,
    discPer100: n ? Math.round((10000 * (disc.major + disc.minor)) / n) / 100 : null,
  };
}

/** Study-answer grading over one set of hands. The poller logs an answer every
 *  time the state changes, so one decision often has several rows: counts are
 *  per DISTINCT decision (hand + decision key, last answered row wins), and
 *  "hands with an answer" is the coverage figure — the archive often stops
 *  before hero's own last action, so hero's decisions cannot be counted from
 *  it, and only decisions whose action IS archived can be graded told-vs-did. */
function answersFor(hs: Enriched[], rows: LoggedAnswer[]) {
  const byCid = new Map<string, Enriched>();
  for (const e of hs) if (e.clientHandId) byCid.set(e.clientHandId, e);
  // answers that disagreed with their own mix — a bug counter, normally 0, kept
  // apart from the discrepancy audit so it can never be buried in it
  const integrity = integrityTotals(rows.filter((a) => a.client_hand_id && byCid.has(a.client_hand_id)));
  let answers = 0, failed = 0;
  const tiers: Record<string, { n: number; lat: number[] }> = {};
  const last = new Map<string, LoggedAnswer>(); // decision → its last answered row
  for (const a of rows) {
    if (!a.client_hand_id || !byCid.has(a.client_hand_id)) continue;
    // a no-probe row records a decision nobody asked about — counting it as a
    // failed solve would blame the solver for a capture fault
    if (a.text == null) { if ((a.fail_kind ?? failKindOf(a.fail_reason)) !== "no-probe") failed++; continue; }
    answers++;
    const t = (tiers[a.tier ?? "unknown"] ??= { n: 0, lat: [] });
    t.n++;
    if (a.latency_ms != null) t.lat.push(a.latency_ms);
    last.set(`${a.client_hand_id}|${a.decision_key ?? a.id}`, a);
  }
  let withBoth = 0, disagreements = 0, graded = 0, followed = 0, followedMesWhenDisagreed = 0;
  const handsAnswered = new Set<string>();
  for (const a of last.values()) {
    handsAnswered.add(a.client_hand_id!);
    const disagreed = a.exploit_pick && a.chart_pick ? !sameAction(a.exploit_pick, a.chart_pick) : null;
    if (disagreed != null) withBoth++;
    if (disagreed) disagreements++;
    const did = heroActionAt(byCid.get(a.client_hand_id!)!, a);
    if (did) {
      const f = sameAction(a.pick, did.label);
      if (f != null) { graded++; if (f) followed++; }
      if (disagreed && sameAction(a.exploit_pick, did.label)) followedMesWhenDisagreed++;
    }
  }
  const pct = (xs: number[], p: number) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : null;
  // Coverage is per DECISION (services/answerLog decision_key ↔ hero's action index),
  // not per hand: a hand with three answers and an unanswered river is not covered.
  const cov = coverageTotals(hs, answersByHand(rows.filter((a) => a.client_hand_id && byCid.has(a.client_hand_id))));
  return {
    answers, failed, answeredDecisions: last.size,
    decisions: cov.decisions, decisionsCovered: cov.covered, decisionsCoveredPct: cov.coveredPct,
    unansweredNodes: cov.unansweredNodes, partialHands: cov.partialHands, strayCaptures: cov.stray, failKinds: cov.kinds,
    handsAnswered: handsAnswered.size,
    handsAnsweredPct: hs.length ? Math.round((1000 * handsAnswered.size) / hs.length) / 10 : null,
    withBoth, disagreements, graded, followed,
    followedPct: graded ? Math.round((1000 * followed) / graded) / 10 : null,
    disagreementRate: withBoth ? Math.round((1000 * disagreements) / withBoth) / 10 : null,
    followedMesWhenDisagreed: disagreements ? Math.round((1000 * followedMesWhenDisagreed) / disagreements) / 10 : null,
    tiers: Object.fromEntries(Object.entries(tiers).map(([k, x]) => [k, { n: x.n, p50: pct(x.lat, 50), p90: pct(x.lat, 90) }])),
    integrity,
  };
}

/** One scope's core: aggregate, per-position / per-stakes / per-session
 *  breakdowns, the hand series for the winnings graph, and the answer grading. */
function analyticsCore(spec: string, all: Enriched[], idx: SessionsIdx, nets: Map<number, number | null>, rows: LoggedAnswer[]) {
  const scope = parseScope(spec);
  const hs = scopeHands(scope, all, idx);
  const byPos: Record<string, Enriched[]> = {}, byStakes: Record<string, Enriched[]> = {}, byMonth: Record<string, Enriched[]> = {};
  for (const e of hs) {
    (byPos[e.summary.heroPos ?? "?"] ??= []).push(e);
    (byStakes[e.stakes ?? "?"] ??= []).push(e);
    (byMonth[monthKey(e.playedAt)] ??= []).push(e);
  }
  const sessions = idx.list.slice().reverse() // oldest first: the trend graphs read left to right
    .map((s) => {
      const shs = hs.filter((e) => idx.byHand.get(e.dbId) === s.id);
      if (!shs.length) return null;
      return { ...s, ...aggregateHands(shs, nets), answers: answersFor(shs, rows) };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
  return {
    spec, kind: scope.kind, label: scopeLabel(scope, idx),
    hands: aggregateHands(hs, nets),
    byPosition: Object.fromEntries(Object.entries(byPos).map(([k, v]) => [k, aggregateHands(v, nets)])),
    byStakes: Object.fromEntries(Object.entries(byStakes).map(([k, v]) => [k, aggregateHands(v, nets)])),
    byMonth: Object.fromEntries(Object.entries(byMonth).map(([k, v]) => [k, { label: monthLabel(k), ...aggregateHands(v, nets) }])),
    sessions,
    series: hs.map((e) => ({ id: e.dbId, t: e.playedAt, net: nets.get(e.dbId) ?? null, s: idx.byHand.get(e.dbId) ?? null })),
    answers: answersFor(hs, rows),
  };
}

/** GET /analytics?scope=<spec>&vs=<spec>&profile=<name|none|all>&window=<1d|7d|14d|30d|all>
 *  — the scoped Analytics payload, which Home reads too.
 *
 *  `profile` and `window` narrow the hand set BEFORE the scope is applied, so
 *  the two compose (one account, the last week, scoped to one session). Nets are
 *  computed over the WHOLE corpus first: a showdown hand is priced off the stack
 *  carried into the next hand, so narrowing first would silently unprice every
 *  hand at the edge of the window. The options are narrowed the same way, so the
 *  chips never offer a session the current profile never played. */
app.get("/analytics", async (c) => {
  const rows = allRows();
  const all = (await Promise.all(rows.map(enrich))).filter((x): x is Enriched => x != null);
  const nets = computeNets(all);
  const idx = sessionsIndex(all);
  const answers = answerLog.rows(3650);
  const profile = c.req.query("profile") ?? "all";
  const win = c.req.query("window") ?? "all";
  const hs = narrowHands(all, idx, profile, win);
  const months: Record<string, number> = {}, stakes: Record<string, number> = {};
  for (const e of hs) {
    const mk = monthKey(e.playedAt), sk = e.stakes ?? "?";
    months[mk] = (months[mk] ?? 0) + 1;
    stakes[sk] = (stakes[sk] ?? 0) + 1;
  }
  // profile chips count hands inside the window; window chips inside the profile
  const profileCounts = new Map<string, number>();
  for (const e of narrowHands(all, idx, "all", win)) {
    const k = profileOfHand(e, idx) ?? "none";
    profileCounts.set(k, (profileCounts.get(k) ?? 0) + 1);
  }
  const seenIds = new Set(hs.map((e) => idx.byHand.get(e.dbId)));
  const times = hs.map((e) => e.playedAt).filter((x): x is number => x != null);
  const vs = c.req.query("vs");
  return c.json({
    ok: true,
    auditPending: auditPending(),
    profile, window: win,
    options: {
      sessions: idx.list.filter((s) => seenIds.has(s.id)),
      months: Object.entries(months).sort((a, b) => b[0].localeCompare(a[0])).map(([key, n]) => ({ key, label: monthLabel(key), hands: n })),
      stakes: Object.entries(stakes).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, hands: n })),
      range: { from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null },
      profiles: [
        // `balance` is the account's LAST reading — a point in time, not a
        // window total, so it does not move when the window does. Null until the
        // account has been seeded (routes /profiles explains the anchor).
        ...accountProfiles().map((p) => {
          const snaps = balanceSnapshots(p.name);
          const bal = snaps.length ? snaps[snaps.length - 1]! : null;
          return {
            id: p.name, label: p.name, site: p.site, hands: profileCounts.get(p.name) ?? 0,
            balance: bal ? { equityCents: bal.equityCents, amountCents: bal.amountCents, inPlayCents: bal.inPlayCents, currency: bal.currency, ts: bal.ts } : null,
          };
        }),
        { id: "none", label: "Unattributed", site: null, hands: profileCounts.get("none") ?? 0, balance: null },
      ],
      windows: WINDOWS.map((w) => ({ ...w, hands: narrowHands(all, idx, profile, w.id).length })),
    },
    primary: analyticsCore(c.req.query("scope") ?? "all", hs, idx, nets, answers),
    compare: vs ? analyticsCore(vs, hs, idx, nets, answers) : null,
    global: { answers: answerLog.stats(60) },
  });
});

app.get("/hand/:dbId", async (c) => {
  const dbId = Number(c.req.param("dbId"));
  const d = openDb();
  if (!d) return c.json({ ok: false, error: `hands.db not found at ${HANDS_DB}` }, 503);
  const row = d
    .query<HandRow, [number]>(
      `SELECT ${HAND_COLS} FROM hands WHERE rowid = ?`
    )
    .get(dbId);
  if (!row) return c.json({ ok: false, error: `no hand #${dbId}` }, 404);
  const e = enrichSync(row);
  if (!e) return c.json({ ok: false, error: "hand blob unreadable" }, 500);
  // The detail page wants this hand's audit now, not when the queue gets to it.
  if (e.discrepancies == null) await audit(e);
  // Every logged answer, pinned to the action index it was given at: the
  // decision key carries the action count at that moment, which is the
  // index of hero's next action in the archived hand.
  const answers = (e.clientHandId ? (answerLog.forHand(e.clientHandId) as any[]) : []).map((a) => {
    let actionIndex: number | null = null;
    try {
      const k = JSON.parse(a.decision_key ?? "null");
      if (Array.isArray(k) && Number.isFinite(Number(k[4]))) actionIndex = Number(k[4]);
    } catch { /* legacy row */ }
    return { ...a, actionIndex, source: a.source ?? sourceForTier(a.tier), integrity: integrityOf(a) };
  });
  // Session: the gap cluster this hand sits in (same rule as Analytics), and
  // the debug recording that holds it when one exists.
  const all = allRows().map(enrichSync).filter((x): x is Enriched => x != null);
  const recording = e.clientHandId ? recordingForHand(e.clientHandId) : null;
  const declaredId: string | null = typeof e.raw.sessionId === "string" ? e.raw.sessionId : null;
  const declared = declaredId ? sessionsStore.get(declaredId) : null;
  // walk the session hand by hand: neighbours under the SAME partition the Sessions tab and the Hands filter use
  const idx = sessionsIndex(all);
  const sid = idx.byHand.get(dbId) ?? null;
  const mates = sid ? all.filter((h) => idx.byHand.get(h.dbId) === sid) : [];
  const mi = mates.findIndex((h) => h.dbId === dbId);
  const nav = { sessionId: sid, position: mi + 1, hands: mates.length, prev: mi > 0 ? mates[mi - 1]!.dbId : null, next: mi >= 0 && mi < mates.length - 1 ? mates[mi + 1]!.dbId : null };
  // "Session N": the hand's own session (the same partition as prev/next above), numbered oldest first
  const chrono = [...idx.list].reverse();
  const ci = sid ? chrono.findIndex((x) => x.id === sid) : -1;
  const session = mates.length
    ? {
        index: ci + 1,
        start: mates[0]!.playedAt,
        end: mates[mates.length - 1]!.playedAt,
        hands: mates.length,
        position: nav.position,
        stakes: mates[0]!.stakes,
        recorded: !!recording,
        recording,
        // the DECLARED session (sessions.py), when this hand was played inside one
        declared: declared ? { id: declared.id, preset: declared.preset, label: declared.label, config: declared.config, startedAt: declared.startedAt, endedAt: declared.endedAt } : null,
        declaredId,
      }
    : null;
  return c.json({
    ok: true,
    dbId,
    playedAt: e.playedAt,
    stakes: e.stakes,
    resultText: row.result_text,
    clientHandId: e.clientHandId,
    summary: e.summary,
    hand: e.hand,
    feedLines: Array.isArray(e.raw.feedLines) ? e.raw.feedLines : [],
    discrepancies: e.discrepancies ?? [],
    answers,
    session,
    nav,
    // THE CHAIN PATH (2026-09-25): the hand's verdict (its worst decision) and its facts
    chain: e.clientHandId
      ? { verdict: handVerdicts(answers as PathRow[])[0] ?? null, facts: chainFactsOf(handFacts.get(String(e.clientHandId))) }
      : null,
  });
});

/** Ignition hand numbers are 10 digits; CoinPoker's are longer, the State Tester's synthetic ones are 9000xxx. */
export const isIgnitionHandId = (id: string | null | undefined): id is string => !!id && /^d{10}$/.test(id);

/** The archived copy of a hand, by the site's own hand number (the indexed client_hand_id column) — its FINISHED row. */
export function archivedByClientHandId(clientHandId: string): Enriched | null {
  const row = openDb()?.query<HandRow, [string]>(`SELECT ${HAND_COLS} FROM hands WHERE client_hand_id = ? AND ${FINISHED} ORDER BY rowid DESC LIMIT 1`)
    .get(clientHandId);
  return row ? enrichSync(row) : null;
}

/** FINISHED Ignition hands after row `afterRowid`, oldest first. A live row (the hand still in play) is never here:
 *  rowids are handed out when a hand STARTS and hands finish out of order across tables, so callers must not treat
 *  the highest rowid seen as a watermark — the checker keys on "finished and not checked yet" (services/hhCheck.ts). */
export const doneIgnitionHandsAfter = (afterRowid: number): Enriched[] =>
  (openDb()?.query<HandRow, [number]>(`SELECT ${HAND_COLS} FROM hands WHERE rowid > ? AND ${FINISHED} ORDER BY rowid`).all(afterRowid) ?? [])
    .map(enrichSync)
    .filter((e): e is Enriched => !!e && isIgnitionHandId(e.clientHandId));

/** The newest row id (0 for an empty or missing archive) — the checker's one-time "from here on" cutoff. */
export const lastArchivedRowid = (): number =>
  openDb()?.query<{ m: number | null }, []>("SELECT MAX(rowid) AS m FROM hands").get()?.m ?? 0;

/** Truncate an archived hand to the state BEFORE actions[upto] — the actions, the board AND the money: an archived
 *  row's `stacks` / `committed` are the END of the hand's, rebuilt here to the decision (utils/archivedHand, hand 723). */
export { truncateAt };

/** POST /open-gtow { dbId, upto } — navigate the GTO Wizard desktop client to
 *  this node's library /solutions URL (best effort; off-tree lines may snap). */
app.post("/open-gtow", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { dbId?: number; upto?: number };
  const d = openDb();
  if (!d) return c.json({ ok: false, error: "hands.db not found" }, 503);
  const row = d.query<HandRow, [number]>(`SELECT ${HAND_COLS} FROM hands WHERE rowid = ?`).get(Number(b.dbId));
  if (!row) return c.json({ ok: false, error: `no hand #${b.dbId}` }, 404);
  const e = await enrich(row);
  if (!e) return c.json({ ok: false, error: "hand blob unreadable" }, 500);
  const upto = Math.max(0, Math.min(Number(b.upto ?? e.hand.actions.length), e.hand.actions.length));
  const node = truncateAt(e.hand, upto);
  const heroPost = node.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  const heroPos = node.positions[node.heroSeatId] ?? (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);
  const set = resolveSet(node, heroPos, undefined);
  if (!set) return c.json({ ok: false, error: "no solution set" }, 400);
  const depth = resolveDepth(node, set.depths?.length ? set.depths : [100], undefined);
  const { search } = buildSolutionUrl({ gametype: set.gametype, depth, hand: node, heroPos });
  const nav = await gtowCdp.gotoNodeUrl(search);
  return c.json({ ok: nav.ok, error: nav.error ?? null });
});

/** The chart catalog + which charts recently answered live spots. */
app.get("/catalog", (c) => {
  const force = c.req.query("refresh") === "1";
  const cat = getCatalog(force);
  return c.json({ ok: true, ...cat, recent: answerLog.recentCharts(30) });
});

/**
 * GET /chart-node?id=<chart id>&line=<token line> — one node of any chart in the
 * catalog, for the Charts picker to render in place.
 *
 * The picker's whole point is that you describe a spot in words; this is the half that
 * turns the chart it found into what the chart SAYS. Family decides the reader: the
 * 6-max grid comes from the baked SQLite (falling back to :8777), everything else HRC
 * goes to :8777. The GTOW crawl is a different store with a different node shape and is
 * not served here — those rows stay browse-only in the picker.
 */
app.get("/chart-node", async (c) => {
  const id = c.req.query("id") ?? "";
  const line = c.req.query("line") ?? "";
  if (!id) return c.json({ ok: false, error: "id required" }, 400);
  const entry = getCatalog().entries.find((e) => e.id === id);
  if (!entry) return c.json({ ok: false, error: `no chart ${id} in the catalog` }, 404);
  if (entry.source !== "hrc") return c.json({ ok: false, error: "GTO Wizard crawl charts are browse-only here" }, 400);
  const get = entry.family === "6max" ? fetchNode6max : hrcFetchNode;
  const n = await get(id, line);
  if (n === "unreachable") return c.json({ ok: false, error: `${HRC3MAX_BASE} is not reachable — the chart server must be up to read this node` }, 503);
  if (!n) return c.json({ ok: true, id, line, node: null, note: `${line || "(root)"} is not a node of this chart's tree` });
  return c.json({ ok: true, id, line, node: n,
    browse: `${HRC3MAX_BASE}/api/preflop/node?source=${encodeURIComponent(id)}&line=${encodeURIComponent(line)}` });
});

/** Sessions: consecutive hands with < 45 min gaps (shared with routes/sources). */
/**
 * THE UNDECLARED SESSIONS: hands with no declared session, grouped by time gap — the ONE partition the Sessions list,
 * a cluster's own page, the Hands filter and the hand page all use (2026-09-25 audit: the list clustered only
 * unstamped hands while a cluster page and the hand page clustered ALL hands, so 24 real cluster links 404'd or pulled
 * a declared session's hands in). Ids are `cluster-<first hand's playedAt>`.
 */
export function gapClusters(all: Enriched[]): Enriched[][] {
  return sessionsOf(all.filter((e) => typeof e.raw?.sessionId !== "string"));
}

export function sessionsOf(enriched: Enriched[]): Enriched[][] {
  const sessions: Enriched[][] = [];
  for (const e of enriched) {
    const last = sessions[sessions.length - 1];
    if (last && e.playedAt != null && last[last.length - 1]!.playedAt != null &&
        e.playedAt - last[last.length - 1]!.playedAt! < SESSION_GAP_MS) last.push(e);
    else sessions.push([e]);
  }
  return sessions;
}


/**
 * GET /mes-value — the formalized winrate picture, in one place.
 *
 * Three layers, kept visibly separate because they rest on different footing:
 *   ladder   — the graded backtest (chart EV accounting over the replayed corpus,
 *              measured rake): equilibrium vs preflop exploit, NL25 vs NL200.
 *              Postflop is priced at the solver FLOOR here (villain's postflop
 *              mistakes count for zero), so these are conservative.
 *   corpus   — the postflop MES uplift over the whole HH corpus: every hand
 *              where hero arrived at an M1/M2 flop, priced at the nearest solved
 *              board's v3 ev_gain, summed per 100 hands (mes_reach_value.py).
 *   live     — the same arithmetic over hero's OWN hands in hands.db.
 * The postflop numbers are RAW MODEL VALUE: vs the tilted-pool model, with no
 * execution haircut, and the nemesis bound for v3 is reported when it exists.
 */
const LADDER = [
  { strategy: "Equilibrium charts", nl25: -10.1, nl200: -6.6, norake: -1.5,
    note: "maximin floor; every postflop leg priced at equilibrium value" },
  { strategy: "Preflop exploit + GTOW AI postflop", nl25: 5.2, nl200: 8.9, norake: null,
    note: "argmax vs measured pool preflop (shrunk 1.5 SE); postflop still the floor" },
];

/** The ladder as the referee last wrote it (backtest_study_answers.py --json);
 *  the transcribed LADDER literal above is only the fallback when the JSON is
 *  missing, and the response says which one it served. */
function ladderRows(): { rows: typeof LADDER; source: string; generatedAt: string | null; chart: string | null } {
  try {
    const j = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "winrate_ladder.json"), "utf-8"));
    const rows = (j.rows as any[])
      .filter((r) => r.id === "eq_charts" || r.id === "exploit_preflop")
      .map((r) => ({
        strategy: r.strategy,
        nl25: r.cells.nl25?.bb100 ?? null,
        nl200: r.cells.nl200?.bb100 ?? null,
        norake: r.cells.norake?.bb100 ?? null,
        note: r.note,
      }));
    return { rows, source: "data/winrate_ladder.json", generatedAt: j.generatedAt ?? null, chart: j.chart ?? null };
  } catch {
    return { rows: LADDER, source: "transcribed Aug 28 stdout (winrate_ladder.json missing)", generatedAt: null, chart: null };
  }
}

app.get("/mes-value", async (c) => {
  let corpus: any = null;
  try { corpus = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "mes_reach_value.json"), "utf-8")); } catch {}
  const ladder = ladderRows();

  // live: classify hero's own hands the same way the corpus crunch does
  const rows = allRows();
  const enriched = (await Promise.all(rows.map(enrich))).filter((x): x is Enriched => x != null);
  const live: Record<string, { arrivals: number; sumEv: number; boards: Record<string, number> }> = {};
  let liveFlops = 0;
  for (const e of enriched) {
    const h = e.hand;
    if (!e.summary.sawFlop || h.board.length < 3) continue;
    liveFlops++;
    const heroPos = e.summary.heroPos;
    const fam = mesFamilyFor(buildPreflopTokens3max(h, heroPos), heroPos);
    if (!fam) continue;
    const m = mesBoardFor(fam, h.board);
    if (!m) continue;
    const slot = (live[fam] ??= { arrivals: 0, sumEv: 0, boards: {} });
    slot.arrivals++; slot.sumEv += m.evGainBb;
    slot.boards[m.board] = (slot.boards[m.board] ?? 0) + 1;
  }
  const liveHands = enriched.length;
  const liveFam = Object.fromEntries(Object.entries(live).map(([k, v]) => [k, {
    arrivals: v.arrivals,
    arrival_pct_of_hands: liveHands ? Math.round(10000 * v.arrivals / liveHands) / 100 : 0,
    mean_ev_gain_per_arrival: v.arrivals ? Math.round(1000 * v.sumEv / v.arrivals) / 1000 : 0,
    uplift_bb100: liveHands ? Math.round(1000 * 100 * v.sumEv / liveHands) / 1000 : 0,
    boards: v.boards,
  }]));
  const liveTotal = Object.values(liveFam).reduce((s, f) => s + f.uplift_bb100, 0);

  return c.json({
    ok: true,
    ladder: ladder.rows,
    ladderSource: { source: ladder.source, generatedAt: ladder.generatedAt, chart: ladder.chart },
    corpus,
    live: { hands: liveHands, flops: liveFlops, families: liveFam, total_uplift_bb100: Math.round(liveTotal * 1000) / 1000 },
    caveats: [
      "Postflop uplift is raw model value vs the tilted-pool model (v3, control ≈ 0); no execution haircut applied.",
      "ev_gain is per ARRIVAL at the flop root and includes all later streets; hero must play the MES continuation to realize it.",
      "Ladder numbers price postflop at the solver floor, so the true total is ladder + some fraction of the postflop uplift, not their sum.",
    ],
  });
});

/** Grid class of two short cards: "AA", "AKs", "T9o". */
const classOfCards = (cards: string[]): string | null => {
  const cs = cards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c));
  if (cs.length !== 2) return null;
  const R = "AKQJT98765432";
  const i1 = R.indexOf(cs[0]![0]!), i2 = R.indexOf(cs[1]![0]!);
  if (i1 === i2) return cs[0]![0]! + cs[1]![0]!;
  const hi = Math.min(i1, i2), lo = Math.max(i1, i2);
  return R[hi]! + R[lo]! + (cs[0]![1] === cs[1]![1] ? "s" : "o");
};

/**
 * GET /answer-node?dbId=&upto=[&answerId=] — the exact chart node (or MES
 * node) a study answer came from, so it can be inspected and verified.
 *
 * Preference order for "exact": the logged answer's chart + snapped line
 * (answers since the line was persisted), else the chart the resolver picks
 * for this hand and the raw token line rebuilt from the archived actions —
 * with a note when the raw line is not in the tree (it would have been
 * snapped live). Postflop: the MES overlay's hero node when the spot is
 * covered; otherwise the answer came from the GTO Wizard AI chain, whose
 * solve is not stored — the caller re-solves with the same chain.
 */
/**
 * THE RANGE LOOKER (2026-09-24, Brady: "a chronological range looker … per decision"). `&ranges=1` adds every
 * seat's preflop range at the node — walked down the SAME tree path the node was read from, each class the
 * product of that seat's frequencies for the actions it took, a villain's raise counting every raise size at the
 * node (the chain's rule for the ranges it takes to the flop). `heroKey` is the node's own name for the seat to
 * act; seats that have not acted yet hold every hand and are not listed.
 */
async function rangesAlong(line: string | null, get: (ln: string) => unknown, actorPos: string | null) {
  const tokens = (line ?? "").split("-").filter(Boolean);
  if (!tokens.length) return { ranges: {}, heroKey: actorPos, rangesNote: null };
  const r = await reconstructFlopRanges(tokens, async (ln) => {
    const n = await get(ln);
    return n && n !== "unreachable" ? (n as RawNode) : null;
  }, { heroPos: actorPos ?? undefined, partial: true });
  return r.ok
    ? { ranges: r.ranges, heroKey: actorPos, rangesNote: r.notes?.join(" · ") ?? null }
    : { ranges: null, heroKey: actorPos, rangesNote: `the ranges could not be walked: ${r.reason}` };
}

app.get("/answer-node", async (c) => {
  const dbId = Number(c.req.query("dbId"));
  const upto = Number(c.req.query("upto"));
  const answerId = c.req.query("answerId") ? Number(c.req.query("answerId")) : null;
  const withRanges = c.req.query("ranges") === "1";
  const d = openDb();
  if (!d || !Number.isFinite(dbId) || !Number.isFinite(upto)) return c.json({ ok: false, error: "dbId and upto required" }, 400);
  const row = d
    .query<HandRow, [number]>(`SELECT ${HAND_COLS} FROM hands WHERE rowid = ?`)
    .get(dbId);
  const e = row ? enrichSync(row) : null;
  if (!e) return c.json({ ok: false, error: `no hand #${dbId}` }, 404);
  const hand = e.hand;
  const t = truncateAt(hand, upto);
  const heroPos = e.summary.heroPos ?? null;
  const heroClass = classOfCards(hand.heroCards);
  const logged = (e.clientHandId ? (answerLog.forHand(e.clientHandId) as any[]) : [])
    .map((a) => {
      let actionIndex: number | null = null;
      try { const k = JSON.parse(a.decision_key ?? "null"); if (Array.isArray(k)) actionIndex = Number(k[4]); } catch { /* legacy */ }
      return { ...a, actionIndex, source: a.source ?? sourceForTier(a.tier), integrity: integrityOf(a) };
    })
    .filter((a) => (answerId != null ? a.id === answerId : a.actionIndex === upto && a.text))
    .pop() ?? null;
  const base = {
    ok: true as const, dbId, upto, street: t.street, heroPos, heroClass, heroCards: hand.heroCards, board: t.board,
    logged: logged
      ? { id: logged.id, chart: logged.chart, line: logged.line, tier: logged.tier, source: logged.source, exploitTag: logged.exploit_tag,
          strategyMode: logged.strategy_mode, pick: logged.pick, exploitPick: logged.exploit_pick, chartPick: logged.chart_pick,
          mesBoard: logged.mes_board, depth: logged.depth, solveId: logged.solve_id ?? null }
      : null,
  };

  if (t.street === "preflop") {
    // A multiway preflop answered by the GTO Wizard AI chain has no chart behind it:
    // its `chart` is a shape label ("gtow-ai · 3-handed · BTN:102/…"), which looked up
    // in the crawled DB below could only come back "not stored" — the same blank grid.
    // The AI panel below re-solves instead, and shows the stored chain when there is one.
    if (logged?.tier === "ai-preflop" || /^gtow-ai/.test(logged?.chart ?? "")) {
      return c.json({ ...base, kind: "ai-chain",
        note: "This preflop decision was answered by the GTO Wizard AI chain, not a chart — there is no stored chart node to open." });
    }
    const live = new Set(hand.liveSeats);
    const posOf = (s: number) => (hand.positions[s] ?? (s === hand.heroSeatId ? heroPos : null) ?? "").toUpperCase();
    const threeMax = logged?.chart
      ? /3maxasym/.test(logged.chart)
      : live.size === 3 && ["BTN", "SB", "BB"].every((p) => [...live].some((s) => posOf(s) === p));
    if (threeMax) {
      const chart: string = logged?.chart ?? chartFor(t, heroPos).id;
      const rawLine = buildPreflopTokens3max(t, heroPos).join("-");
      const loggedLine = logged?.line && logged.line !== "(root)" ? logged.line : null;
      const tryLines = [...new Set([loggedLine, rawLine].filter((x): x is string => x != null))];
      let node: any = null, usedLine: string | null = null;
      for (const ln of tryLines) {
        const n = await hrcFetchNode(chart, ln);
        if (n === "unreachable") return c.json({ ...base, ok: false, kind: "hrc", chart, error: `${HRC3MAX_BASE} is not reachable — the 3-max chart server must be up to show this node` });
        if (n) { node = n; usedLine = ln; break; }
      }
      if (!node && rawLine === "") { const n = await hrcFetchNode(chart, ""); if (n && n !== "unreachable") { node = n; usedLine = ""; } }
      // No logged line (pre-2026-09-03 answers) and the raw sizes are off-tree:
      // walk the line the way the live answer did — snapping each size to the
      // node's nearest token — so the node shown is the one that answered.
      let snapped: { from: string; to: string }[] = [];
      if (!node && rawLine) {
        const w = await walk3max(rawLine.split("-"), (ln) => hrcFetchNode(chart, ln));
        if (w.ok) { node = w.node; usedLine = w.tokens.join("-"); snapped = w.repaired.map((r) => ({ from: r.from, to: r.to })); }
      }
      let exploit: any = null;
      const exPath = process.env.EXPLOIT_CHART;
      if (exPath && logged?.exploit_tag) {
        try {
          const ex = JSON.parse(readFileSync(exPath, "utf-8"));
          const choices = ex?.choices?.[logged.exploit_tag];
          if (choices) exploit = { tag: logged.exploit_tag, chart: ex.chart ?? null, path: exPath, choices, heroChoice: heroClass ? choices[heroClass] ?? null : null };
        } catch { /* overlay unreadable */ }
      }
      return c.json({
        ...base, kind: "hrc", chart, line: usedLine, rawLine, loggedLine, node, exploit, snapped,
        ...(withRanges && node ? await rangesAlong(usedLine, (ln) => hrcFetchNode(chart, ln), node.pos ?? null) : {}),
        note: node ? (snapped.length ? `sizes snapped to the tree, as the live answer did: ${snapped.map((x) => `${x.from}→${x.to}`).join(", ")}` : loggedLine && usedLine !== loggedLine ? "the logged line was not found; showing the raw line instead" : null)
          : "this line is not in the chart's tree as rebuilt from the archive — live, the sizes were snapped to the nearest tree sizes (answers logged since 2026-09-03 carry the snapped line)",
        browse: `${HRC3MAX_BASE}/api/preflop/node?source=${encodeURIComponent(chart)}&line=${encodeURIComponent(usedLine ?? rawLine)}`,
      });
    }
    // THE COINPOKER HEADS-UP CHARTS ARE NOT IN THE CRAWLED DB EITHER (2026-09-24, found building the range
    // looker): `hrc_hu_cp200a_*` (services/hrc2max.ts) are HRC trees on the same chart server as the 3-max set,
    // and looked up in the crawled GTO Wizard DB below every heads-up answer opened as "not stored".
    const huChart = logged?.chart && /^hrc_hu_/.test(logged.chart) ? logged.chart : null;
    if (huChart) {
      const tokens = buildPreflopTokensHu(t, heroPos);
      const rawLine = tokens.join("-");
      const loggedLine = logged?.line && logged.line !== "(root)" ? logged.line : null;
      const get = nodeGetterHu(huChart);
      let node: HrcNode | null = null, usedLine: string | null = null;
      for (const ln of [...new Set([loggedLine, rawLine].filter((x): x is string => x != null))]) {
        const n = await get(ln);
        if (n === "unreachable") return c.json({ ...base, ok: false, kind: "hrc-hu", chart: huChart, error: `${HRC3MAX_BASE} is not reachable — the chart server must be up to show this node` });
        if (n) { node = n; usedLine = ln; break; }
      }
      let snapped: { from: string; to: string }[] = [];
      if (!node && rawLine) {
        const w = await walk3max(tokens, get);
        if (w.ok) { node = w.node; usedLine = w.tokens.join("-"); snapped = w.repaired.map((r) => ({ from: r.from, to: r.to })); }
      }
      return c.json({
        ...base, kind: "hrc-hu", chart: huChart, depth: logged?.depth ?? null, line: usedLine, rawLine, loggedLine, node, snapped,
        ...(withRanges && node ? await rangesAlong(usedLine, get, node.pos ?? null) : {}),
        note: node
          ? (snapped.length ? `sizes snapped to the tree, as the live answer did: ${snapped.map((x) => `${x.from}→${x.to}`).join(", ")}` : loggedLine && usedLine !== loggedLine ? "the logged line was not found; showing the raw line instead" : null)
          : `this line is not in ${huChart}'s tree as rebuilt from the archive`,
        browse: `${HRC3MAX_BASE}/api/preflop/node?source=${encodeURIComponent(huChart)}&line=${encodeURIComponent(usedLine ?? rawLine)}`,
      });
    }
    // THE 6-MAX RING CHARTS ARE NOT IN THE CRAWLED DB (2026-09-20, Brady: "I clicked
    // 'open the exact node' for the preflop fold but it shows nothing"). Since
    // 2026-09-17 the ring strategy answers preflop from our own HRC grid
    // (`ign200_6max_*`, services/hrc6max.ts), but this route only knew two preflop
    // sources: the 3-max asym server and the crawled GTO Wizard DB. An ign200_6max_*
    // id looked up in the GTOW DB can only ever come back "not stored", so EVERY ring
    // answer's node opened as an empty grid. Same shape as the 3-max branch — the node
    // comes from the baked SQLite when this machine has it, :8777 otherwise.
    const sixMax = logged?.chart
      ? /_6max_/.test(logged.chart)
      : !threeMax && live.size > 3 && bbUsdOf(e.stakes, e.hand.bbCents) === 2;
    if (sixMax) {
      const tokens = buildPreflopTokens(t, heroPos);
      const choice = chartFor6max(t, heroPos, tokens);
      // The logged chart is the one that actually answered; without one, resolve the
      // way the live picker does (its preference list walks the trees the set has).
      let chart: string = logged?.chart ?? choice.id;
      let fellBack: string | null = null;
      if (!logged?.chart) {
        const r = await resolveChart6max(choice);
        if (r === "unreachable") return c.json({ ...base, ok: false, kind: "hrc6max", chart, error: `${HRC3MAX_BASE} is not reachable and this machine has no baked 6-max DB — one of the two must be up to show this node` });
        if (r) { chart = r.id; if (r.fellBack) fellBack = `no ${choice.id} tree in the set — this is ${r.id}`; }
      }
      const rawLine = tokens.join("-");
      const loggedLine = logged?.line && logged.line !== "(root)" ? logged.line : null;
      let node: HrcNode | null = null, usedLine: string | null = null;
      for (const ln of [...new Set([loggedLine, rawLine].filter((x): x is string => x != null))]) {
        const n = await fetchNode6max(chart, ln);
        if (n === "unreachable") return c.json({ ...base, ok: false, kind: "hrc6max", chart, error: `${HRC3MAX_BASE} is not reachable — the chart server must be up to show this node` });
        if (n) { node = n; usedLine = ln; break; }
      }
      // No logged line, and the raw sizes are off-tree: walk it the way the live
      // answer did, snapping each size to the node's nearest token.
      let snapped: { from: string; to: string }[] = [];
      if (!node && rawLine) {
        const w = await walk3max(tokens, nodeGetter(chart));
        if (w.ok) { node = w.node; usedLine = w.tokens.join("-"); snapped = w.repaired.map((r) => ({ from: r.from, to: r.to })); }
      }
      return c.json({
        ...base, kind: "hrc6max", chart, depth: logged?.depth ?? choice.depth, line: usedLine, rawLine, loggedLine, node, snapped,
        ...(withRanges && node ? await rangesAlong(usedLine, nodeGetter(chart), node.pos ?? null) : {}),
        note: [
          fellBack,
          node
            ? (snapped.length ? `sizes snapped to the tree, as the live answer did: ${snapped.map((x) => `${x.from}→${x.to}`).join(", ")}`
              : loggedLine && usedLine !== loggedLine ? "the logged line was not found; showing the raw line instead" : null)
            : `this line is not in ${chart}'s tree as rebuilt from the archive — live, the sizes were snapped to the nearest tree sizes`,
        ].filter(Boolean).join(" · ") || null,
        browse: `${HRC3MAX_BASE}/api/preflop/node?source=${encodeURIComponent(chart)}&line=${encodeURIComponent(usedLine ?? rawLine)}`,
      });
    }
    const set = resolveSet(t, heroPos, undefined);
    const gametype: string | null = logged?.chart ?? set?.gametype ?? null;
    const depth: number = logged?.depth ?? resolveDepth(t, set?.depths?.length ? set.depths : [100]);
    const isHu = set?.seats.length === 2;
    const rawLine = (isHu ? buildPreflopTokensHu(t, heroPos) : buildPreflopTokens(t, heroPos)).join("-");
    const loggedLine = logged?.line ?? null;
    let node: any = null, usedLine: string | null = null;
    for (const ln of [...new Set([loggedLine, rawLine].filter((x): x is string => x != null))]) {
      const n = gametype ? preflopDb.rawNode(gametype, depth, ln) : null;
      if (n) { node = n; usedLine = ln; break; }
    }
    return c.json({
      ...base, kind: "gtow", chart: gametype, depth, line: usedLine, rawLine, loggedLine, node,
      ...(withRanges && node && gametype ? await rangesAlong(usedLine, (ln) => preflopDb.rawNode(gametype, depth, ln), node.pos ?? null) : {}),
      note: node ? null : "this line is not stored in the crawled preflop DB",
    });
  }

  // postflop: the MES overlay's node when covered, else the AI chain (not stored)
  try {
    const tk = buildSpotSolutionTokens(t, heroPos);
    const heroPosName = (hand.positions[hand.heroSeatId] ?? heroPos ?? "").toUpperCase() || null;
    const mes = mesNodeDetail({
      positions: [...Object.values(hand.positions), ...(heroPosName ? [heroPosName] : [])],
      heroPos: heroPosName,
      pf3Tokens: buildPreflopTokens3max(t, heroPos),
      flopTokens: tk.flop,
      board: t.board,
      heroCards: hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c)),
    });
    if (mes) return c.json({ ...base, kind: "mes", mes, flopTokens: tk.flop });
  } catch { /* fall through */ }
  return c.json({
    ...base, kind: "ai-chain",
    note: "This decision was answered by the GTO Wizard AI per-street chain. Its solve is not stored, so the node is reproduced by re-running the same chain from the archived hand.",
  });
});


/**
 * Which preflop chart a hand's decisions came from, and how to walk it: answer-node's per-kind rules (the logged
 * chart first, else the resolver's pick), for the whole line instead of one node. `heroKey` is the chart's name for
 * hero's seat (a heads-up tree seats the dealer as SB) — the walk exempts it from the villain raise merge.
 */
async function preflopChartSource(
  e: Enriched, t: ParsedHand, heroPos: string | null,
  logged: { chart?: string | null; depth?: number | null; tier?: string | null } | null,
): Promise<
  | { kind: "ai-preflop"; chart: string | null }
  | { kind: "hrc" | "hrc-hu" | "hrc6max" | "gtow"; chart: string; tokens: string[]; get: (ln: string) => unknown; heroKey: string | null; hu: boolean }
  | { error: string }
> {
  const hand = e.hand;
  const chart = logged?.chart ?? null;
  if (logged?.tier === "ai-preflop" || /^gtow-ai/.test(chart ?? "")) return { kind: "ai-preflop", chart };
  const heroName = (hand.positions[hand.heroSeatId] ?? heroPos ?? "").toUpperCase() || null;
  const huName = heroName === "BTN" ? "SB" : heroName;
  if (chart && /^hrc_hu_/.test(chart)) {
    return { kind: "hrc-hu", chart, tokens: buildPreflopTokensHu(t, heroPos), get: nodeGetterHu(chart), heroKey: huName, hu: true };
  }
  const live = new Set(hand.liveSeats);
  const posOf = (s: number) => (hand.positions[s] ?? (s === hand.heroSeatId ? heroPos : null) ?? "").toUpperCase();
  const threeMax = chart ? /3maxasym/.test(chart) : live.size === 3 && ["BTN", "SB", "BB"].every((p) => [...live].some((s) => posOf(s) === p));
  if (threeMax) {
    const id = chart ?? chartFor(t, heroPos).id;
    return { kind: "hrc", chart: id, tokens: buildPreflopTokens3max(t, heroPos), get: (ln: string) => hrcFetchNode(id, ln), heroKey: heroName, hu: false };
  }
  const sixMax = chart ? /_6max_/.test(chart) : live.size > 3 && bbUsdOf(e.stakes, e.hand.bbCents) === 2;
  if (sixMax) {
    const tokens = buildPreflopTokens(t, heroPos);
    let id = chart;
    if (!id) {
      const choice = chartFor6max(t, heroPos, tokens);
      const r = await resolveChart6max(choice);
      if (r === "unreachable") return { error: `${HRC3MAX_BASE} is not reachable and this machine has no baked 6-max DB` };
      id = r ? r.id : choice.id;
    }
    return { kind: "hrc6max", chart: id, tokens, get: nodeGetter(id), heroKey: heroName, hu: false };
  }
  const set = resolveSet(t, heroPos, undefined);
  const gametype = chart ?? set?.gametype ?? null;
  if (!gametype) return { error: "no preflop chart resolves for this hand" };
  const depth: number = logged?.depth ?? resolveDepth(t, set?.depths?.length ? set.depths : [100]);
  const hu = set?.seats.length === 2;
  return {
    kind: "gtow", chart: gametype, tokens: hu ? buildPreflopTokensHu(t, heroPos) : buildPreflopTokens(t, heroPos),
    get: (ln: string) => preflopDb.rawNode(gametype, depth, ln), heroKey: hu ? huName : heroName, hu,
  };
}

/** Each step of a preflop path → the archived action it stands for: the seat's next preflop decision, in turn.
 *  A seat the chart folds that was never dealt has none (null). */
function mapPathSteps<T extends { pos: string }>(hand: ParsedHand, heroPos: string | null, steps: T[], hu: boolean): (T & { actionIndex: number | null })[] {
  const name = (p: string | null | undefined) => { const u = (p ?? "").toUpperCase(); return hu && u === "BTN" ? "SB" : u; };
  const queue = new Map<string, number[]>();
  hand.actions.forEach((a, i) => {
    if (a.street !== "preflop" || /^post/.test(a.type)) return;
    const seat = a.hero ? hand.heroSeatId : a.seatId;
    const p = name(hand.positions[seat] ?? (seat === hand.heroSeatId ? heroPos : null));
    if (!p) return;
    if (!queue.has(p)) queue.set(p, []);
    queue.get(p)!.push(i);
  });
  return steps.map((s) => ({ ...s, actionIndex: queue.get(name(s.pos))?.shift() ?? null }));
}

/**
 * GET /preflop-path?dbId=[&ai=1] — THE RANGE LOOKER'S PREFLOP, EVERY SEAT (2026-09-24, Brady: "we don't get the
 * range of what a BB raise 10 looks like … make the villains' ranges + actions a mainstay part of the chronology").
 * The whole preflop line walked down the chart that answered the hand: at every decision, the seat to act, its
 * strategy for every class, the action the line took and the range that action leaves, each mapped to the archived
 * action it stands for. A villain's raise conditions on every raise size at its node (`merged`) — the rule the
 * flop-entry ranges use — so a step's range is exactly what the next decision sees. A hand the GTO Wizard AI
 * answered preflop has no chart: the reply says so, and `&ai=1` rebuilds that tree instead (GTO Wizard quota; the
 * page only asks on a click).
 */
app.get("/preflop-path", async (c) => {
  const dbId = Number(c.req.query("dbId"));
  const d = openDb();
  if (!d || !Number.isFinite(dbId)) return c.json({ ok: false, error: "dbId required" }, 400);
  const row = d
    .query<HandRow, [number]>(`SELECT ${HAND_COLS} FROM hands WHERE rowid = ?`)
    .get(dbId);
  const e = row ? enrichSync(row) : null;
  if (!e) return c.json({ ok: false, error: `no hand #${dbId}` }, 404);
  const hand = e.hand;
  const heroPos = e.summary.heroPos ?? null;
  // the whole preflop, still ON the preflop street: every preflop action in, the money as the live table had it after
  // the last of them (chips behind + this round's = the stacks as dealt, what the live /hand means). Cut at the first
  // flop action instead, the preflop chips would already be in the pot and every picker would read the seats short.
  const firstPost = hand.actions.findIndex((a) => a.street !== "preflop");
  const upto = firstPost >= 0 ? firstPost : hand.actions.length;
  const cut = truncateAt(hand, upto);
  const t: ParsedHand = { ...cut, street: "preflop", board: [], committed: Object.fromEntries(roundContributions(hand, upto).get("preflop") ?? []),
    currentNode: { ...cut.currentNode, street: "preflop", pot: 0 } };
  // the chart that answered: the hand's last preflop answer (a chart is pinned for the whole hand)
  const logged = (e.clientHandId ? (answerLog.forHand(e.clientHandId) as any[]) : [])
    .filter((a) => a.street === "preflop" && a.text && a.chart).pop() ?? null;
  const src = await preflopChartSource(e, t, heroPos, logged);
  if ("error" in src) return c.json({ ok: false, error: src.error });
  if (src.kind === "ai-preflop") {
    if (c.req.query("ai") !== "1") return c.json({ ok: true, kind: "ai-preflop", chart: src.chart, steps: [] });
    // built with the stacks of the tree that answered (its logged id), else the archive's own dealt stacks
    const v = await preflopPathView(t, heroPos, dealtFromTreeId(t, heroPos, logged?.chart) ?? startStacksOf(hand));
    if (!v.ok) return c.json({ ok: false, kind: "ai-preflop", error: `GTO Wizard AI preflop: ${v.reason}` });
    return c.json({ ok: true, kind: "ai", chart: v.id, line: v.line, note: v.note, steps: mapPathSteps(hand, heroPos, v.steps, false) });
  }
  if ((await src.get("")) === "unreachable") return c.json({ ok: false, kind: src.kind, chart: src.chart, error: `${HRC3MAX_BASE} is not reachable — the chart server must be up to walk this line` });
  const walked: WalkStep[] = [];
  const walk = await reconstructFlopRanges(src.tokens, async (ln) => {
    const n = await src.get(ln);
    return n && n !== "unreachable" ? (n as RawNode) : null;
  }, { heroPos: src.heroKey ?? undefined, partial: true, borrowCaller: true, onStep: (s) => walked.push(s) });
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const combos = (k: string) => (k.length === 2 ? 6 : k.endsWith("s") ? 4 : 12);
  const steps = walked.map((s) => {
    const actions = s.node.actions.map((a) => a.action);
    const strategy: Record<string, { w: number; acts: number[] }> = {};
    for (const cell of s.node.cells) {
      const w = combos(cell.hand) * (s.rangeIn ? s.rangeIn[cell.hand] ?? 0 : 1);
      if (w <= 0) continue;
      strategy[cell.hand] = { w: r3(w), acts: actions.map((l) => r3((w * (cell.actions[l] ?? 0)) / 100)) };
    }
    const rangeOut = s.rangeOut
      ? Object.fromEntries(Object.entries(s.rangeOut).filter(([, f]) => f > 0).map(([k, f]) => [k, { w: r3(f * combos(k)) }]))
      : null;
    return { pos: s.pos, line: s.line, actions, strategy, taken: s.label, merged: s.labels.length > 1, rangeOut,
      ...(s.rawToken !== s.token ? { snapped: `${s.rawToken}→${s.token}` } : {}) };
  });
  return c.json({
    ok: true, kind: src.kind, chart: src.chart, line: walked.map((s) => s.token).join("-"),
    note: (walk.ok ? walk.notes ?? [] : [`the walk stopped: ${walk.reason}`]).join(" · ") || null,
    steps: mapPathSteps(hand, heroPos, steps, src.hu),
  });
});

// ------------------------------------------------------------ stored AI-chain solves

/** 1326 weights → {class: {w, combos}} */
/** CARD REMOVAL (2026-09-19, Brady's "where is the missing 9.7%"): a range walked from preflop still carries
 *  every combo that holds a board card. The solver never plays those (their strategy is 0), so a class
 *  total that counts them under-states every action — hand 404's flop showed CHECK 90.3% for a node whose
 *  own total is 99.97%. Every grid and combo count here drops the combos the board blocks, as GTO Wizard's do. */
const boardCards = (board?: string | null): Set<string> => new Set((board ?? "").match(/[2-9TJQKA][shdc]/gi)?.map((c) => c[0]!.toUpperCase() + c[1]!.toLowerCase()) ?? []);
const blockedBy = (i: number, board: Set<string>): boolean => board.size > 0 && (board.has(COMBOS[i]!.cards[0]) || board.has(COMBOS[i]!.cards[1]));
function classAgg(w: number[], board?: string | null): Record<string, { w: number; combos: number }> {
  const out: Record<string, { w: number; combos: number }> = {};
  const bc = boardCards(board);
  for (let i = 0; i < COMBOS.length; i++) {
    const x = w[i] ?? 0;
    if (x <= 0 || blockedBy(i, bc)) continue;
    const k = COMBOS[i]!.cls;
    (out[k] ??= { w: 0, combos: 0 }).w += x;
    out[k]!.combos++;
  }
  for (const k in out) out[k]!.w = Math.round(out[k]!.w * 1000) / 1000;
  return out;
}
/** actor range + per-action strategies → {class: {w, acts[]}} (acts = weight taking each action) */
function classStrategy(range: number[], strategies: number[][], board?: string | null): Record<string, { w: number; acts: number[] }> {
  const out: Record<string, { w: number; acts: number[] }> = {};
  const bc = boardCards(board);
  for (let i = 0; i < COMBOS.length; i++) {
    const w = range[i] ?? 0;
    if (w <= 0 || blockedBy(i, bc)) continue;
    const k = COMBOS[i]!.cls;
    const e = (out[k] ??= { w: 0, acts: new Array(strategies.length).fill(0) });
    e.w += w;
    for (let ai = 0; ai < strategies.length; ai++) e.acts[ai] += w * (strategies[ai]?.[i] ?? 0);
  }
  for (const k in out) { out[k]!.w = Math.round(out[k]!.w * 1000) / 1000; out[k]!.acts = out[k]!.acts.map((x) => Math.round(x * 1000) / 1000); }
  return out;
}
/** PER-COMBO VIEW (2026-09-19, Brady: "expand a class into its combos — blockers make or break postflop
 *  decisions"). For each hand class, every legal combo (card removal applied) with its weight in range and,
 *  for the actor, its per-action frequency and EV. The grids open a class into this panel. */
type ComboRow = { hand: string; w: number; s?: number[]; ev?: (number | null)[] };
function classCombos(range: number[], board: string | null | undefined, strategies?: number[][], evs?: (number[] | undefined)[]): Record<string, ComboRow[]> {
  const out: Record<string, ComboRow[]> = {};
  const bc = boardCards(board);
  for (let i = 0; i < COMBOS.length; i++) {
    const w = range[i] ?? 0;
    if (w <= 0 || blockedBy(i, bc)) continue;
    const c = COMBOS[i]!;
    const row: ComboRow = { hand: c.hand, w: Math.round(w * 1000) / 1000 };
    if (strategies) {
      row.s = strategies.map((st) => Math.round((st?.[i] ?? 0) * 10000) / 10000);
      if (evs) row.ev = evs.map((e) => (e?.[i] == null ? null : Math.round(e![i]! * 1000) / 1000));
    }
    (out[c.cls] ??= []).push(row);
  }
  for (const k in out) out[k]!.sort((a, b) => b.w - a.w || a.hand.localeCompare(b.hand));
  return out;
}
const tv = (a: number[], b: number[]): number => {
  const sa = a.reduce((s, x) => s + x, 0) || 1, sb = b.reduce((s, x) => s + x, 0) || 1;
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d += Math.abs((a[i] ?? 0) / sa - (b[i] ?? 0) / sb);
  return Math.round((d / 2) * 1000) / 1000;
};

/** A street's seats in acting order and their entering ranges. Traces since 2026-09-19 carry them (`players` /
 *  `rangesIn`, two or three seats); older ones have oopIn/ipIn only. */
const traceSeats = (spec: any, st: any): { players: string[]; ranges: number[][] } => ({
  players: st?.players ?? [spec.oopPos, spec.ipPos],
  ranges: (st?.rangesIn ?? [st?.oopIn ?? [], st?.ipIn ?? []]).map((r: number[]) => r.slice()),
});
const seatLabel = (i: number, n: number): "oop" | "mid" | "ip" => (i === 0 ? "oop" : i === n - 1 ? "ip" : "mid");
/** Ranges keyed the way the viewer reads them: oop / ip, plus mid on a three-way street. */
const keyedRanges = (players: string[], ranges: number[][], board?: string | null) => ({
  oop: classAgg(ranges[0] ?? [], board),
  ip: classAgg(ranges[ranges.length - 1] ?? [], board),
  ...(players.length === 3 ? { mid: classAgg(ranges[1] ?? [], board) } : {}),
});

/**
 * WHAT A STORED CHAIN SENT GTO WIZARD on one street (2026-09-24, Brady: "what the inputs sent in was … e.g. what the
 * rake cap you set was"). Traces since 2026-09-24 record the tree request as sent (aiChain: `sent`, `account`); an
 * older trace is rebuilt from what it stores — board, pot, stack, seats and their entering ranges, the pinned sizes,
 * the spec's rake — with the builder the chain itself calls (gtowApi.treeRequestSummary), so a trace that carried no
 * rake shows the default the builder filled in, not "none". `sentFrom` says which.
 */
function sentOf(spec: any, st: any): { sent: unknown; sentFrom: "recorded" | "rebuilt" | null; account: string | null } {
  if (st?.sent) return { sent: st.sent, sentFrom: "recorded", account: st.account ?? null };
  try {
    const { players, ranges } = traceSeats(spec, st);
    const n = players.length;
    const street = String(st.street ?? "FLOP").toUpperCase() as "FLOP" | "TURN" | "RIVER";
    const input: CustomTreeInput = {
      board: st.board, pot: st.potIn, stack: st.stackIn,
      oopRange: ranges[0] ?? [], ipRange: ranges[n - 1] ?? [], oopPos: players[0], ipPos: players[n - 1],
      ...(n === 3 ? { mid: { pos: players[1]!, range: ranges[1] ?? [] } } : {}),
      ...(n === 2 && spec.huGrid ? { huGrid: spec.huGrid } : {}),
      startingStreet: street,
      ...(spec.rake ? { rake: spec.rake } : {}),
      ...(Array.isArray(st.fixedLevels) && st.fixedLevels.length ? { fixedLevels: { [street]: st.fixedLevels } } : {}),
    };
    return { sent: gtowApi.treeRequestSummary(input), sentFrom: "rebuilt", account: st.account ?? null };
  } catch {
    return { sent: null, sentFrom: null, account: st?.account ?? null };
  }
}

/** Walk a stored trace and produce the per-node view the dashboard renders. */
function expandTrace(trace: any) {
  const spec = trace.spec ?? {};
  const heroIdx: number | null = spec.heroComboIdx ?? null;
  const heroCombo = heroIdx != null ? COMBOS[heroIdx]?.hand ?? null : null;
  const heroPos: string | null = spec.heroSeat === "oop" ? spec.oopPos : spec.heroSeat === "mid" ? spec.midPos : spec.ipPos;
  const sum = (xs: number[] | undefined) => (xs ?? []).reduce((s: number, x: number) => s + x, 0);
  const streets = (trace.streets ?? []).map((st: any) => {
    const { players, ranges } = traceSeats(spec, st);
    return {
      si: st.si, street: st.street, board: st.board, potIn: st.potIn, stackIn: st.stackIn, labels: st.labels,
      fixedLevels: st.fixedLevels, solId: st.solId, created: st.created,
      // the tree request this street sent GTO Wizard (recorded since 2026-09-24, rebuilt before) and whose account
      ...sentOf(spec, st),
      // per-street timing (recorded since 2026-09-12): the cloud solve itself and the node walk
      solveMs: st.solveMs ?? null, walkMs: st.walkMs ?? null,
      players,
      oopIn: classAgg(ranges[0] ?? [], st.board), ipIn: classAgg(ranges[ranges.length - 1] ?? [], st.board),
      oopCombos: sum(ranges[0]), ipCombos: sum(ranges[ranges.length - 1]),
      ...(players.length === 3 ? { midIn: classAgg(ranges[1] ?? [], st.board), midCombos: sum(ranges[1]) } : {}),
    };
  });
  // replay the conditioning within each street from the stored entering ranges
  const cur: Record<number, { players: string[]; ranges: number[][] }> = {};
  const nodes = (trace.nodes ?? []).map((n: any, i: number) => {
    const st = (trace.streets ?? []).find((x: any) => x.si === n.si);
    if (!cur[n.si]) cur[n.si] = traceSeats(spec, st);
    const r = cur[n.si]!;
    const nSeats = r.players.length;
    const actorRange: number[] = r.ranges[n.actor] ?? [];
    const heroAt = heroPos ? r.players.findIndex((p) => String(p).toUpperCase() === String(heroPos).toUpperCase()) : -1;
    const strategies: number[][] = (n.actions ?? []).map((a: any) => a.strategy ?? []);
    const evsByAction: (number[] | undefined)[] = (n.actions ?? []).map((a: any) => a.evs ?? undefined);
    const actorStrategy = classStrategy(actorRange, strategies, n.board);
    const actorCombos = classCombos(actorRange, n.board, strategies, evsByAction);
    const rangesIn = keyedRanges(r.players, r.ranges, n.board);
    const rangesInCombos = {
      oop: classCombos(r.ranges[0] ?? [], n.board), ip: classCombos(r.ranges[nSeats - 1] ?? [], n.board),
      ...(nSeats === 3 ? { mid: classCombos(r.ranges[1] ?? [], n.board) } : {}),
    };
    const isHero = n.actor === heroAt;
    const heroInActor = isHero && heroIdx != null;
    const heroRow = heroInActor
      ? (n.actions ?? []).map((a: any) => ({ name: a.name, betsize: a.betsize, p: Math.round((a.strategy?.[heroIdx!] ?? 0) * 1000) / 10, ev: a.evs?.[heroIdx!] ?? null }))
      : null;
    const heroWeightIn = heroIdx != null && heroAt >= 0 ? (r.ranges[heroAt]?.[heroIdx] ?? 0) : null;
    let rangesOut: ReturnType<typeof keyedRanges> | null = null;
    if (n.taken != null) {
      const strat = strategies[n.taken] ?? [];
      r.ranges[n.actor] = actorRange.map((w, ci) => w * (strat[ci] ?? 0));
      rangesOut = keyedRanges(r.players, r.ranges, n.board);
    }
    return {
      i, si: n.si, ti: n.ti, street: n.street, board: n.board, codes: n.codes,
      actor: seatLabel(n.actor, nSeats), actorPos: r.players[n.actor] ?? (n.actor === 0 ? "OOP" : "IP"),
      isHero, heroSeatLabel: heroAt >= 0 ? seatLabel(heroAt, nSeats) : null, players: r.players,
      potNode: n.potNode, invested: n.invested, heroNode: !!n.heroNode,
      actions: (n.actions ?? []).map((a: any) => ({ name: a.name, code: a.code, betsize: a.betsize, totalFrequency: a.totalFrequency, totalEv: a.totalEv })),
      taken: n.taken, takenName: n.taken != null ? n.actions?.[n.taken]?.name ?? null : null,
      takenOverallPct: n.taken != null && n.actions?.[n.taken]?.totalFrequency != null ? Math.round(n.actions[n.taken].totalFrequency * 1000) / 10 : null,
      rangesIn, rangesOut, actorStrategy, actorCombos, rangesInCombos, heroRow, heroWeightIn: heroWeightIn == null ? null : Math.round(heroWeightIn * 1000) / 1000,
    };
  });
  return {
    spec: { oopPos: spec.oopPos, ipPos: spec.ipPos, midPos: spec.midPos ?? null, heroPos, flopPot: spec.flopPot, flopStack: spec.flopStack,
            board: spec.board, streets: spec.streets,
            heroSeat: spec.heroSeat, heroCombo, heroComboIdx: heroIdx, rake: spec.rake ?? null, rangeSource: spec.rangeSource ?? null,
            // the rake the trees were actually sent: a spec without one got the builder's default (GTO Wizard's NL500)
            rakeSent: spec.rake ?? DEFAULT_TREE_RAKE, rakeDefaulted: !spec.rake,
            oopRange: classAgg(spec.oopRange ?? []), ipRange: classAgg(spec.ipRange ?? []),
            ...(spec.midRange ? { midRange: classAgg(spec.midRange) } : {}) },
    streets, nodes, result: trace.result ?? null,
  };
}

/** GET /solve/:id — a stored AI-chain solve, expanded for the walkthrough. */
app.get("/solve/:id", (c) => {
  const id = Number(c.req.param("id"));
  // ?hand=&key= (the answer's client hand id + decision key): never show another hand's chain under this one (hand 973)
  const got = solveStore.forAnswer(Number.isFinite(id) ? id : null, c.req.query("hand") || null, c.req.query("key") || null);
  if (!got.ok) return c.json({ ok: false, error: got.error }, 404);
  return c.json({ ok: true, row: got.row, via: got.via, ...expandTrace(got.trace) });
});

/** GET /storage — where every record lives (the one data root), what was adopted from the legacy files, any split. */
app.get("/storage", (c) => {
  const stores = resolveAllStores();
  return c.json({ ok: true, layout: dataLayout(), line: describeLayout(), stores, split: splitStores(stores), adoption: adoptionReport() });
});

/**
 * GET /chart-setup?dbId=&id=&id= — WHAT EACH PREFLOP CHART OF A HAND WAS SOLVED WITH (2026-09-24, Brady: "not the actual
 * rake cap and config"; "for the uneven stacks … it doesn't show what specifically the uneven stacks look like"). Every
 * chart the hand's logged answers name, plus each `id` (the chart the preflop path walked), through
 * services/chartSetup.ts — seats and their stacks, blinds, ante, rake and cap, the size menu. Beside it, the TABLE,
 * only as far as the row RECORDED it (an end-of-hand stack cannot give a winner's stack back, so nothing is guessed):
 *   - each seat's stack as dealt: hand.startStacks (seat → bb, exported since 2026-09-24), or a CoinPoker row's own
 *     name → table-money map read through its seat names and big blind (rows archived before that);
 *   - the table's rake as the site reported it (a CoinPoker row's `rake`: percent, heads-up percent, cap in table
 *     money, isPotRakePf = preflop pots raked too) — Ignition rows carry none;
 *   - the ante and the big blind.
 */
app.get("/chart-setup", (c) => {
  const dbId = Number(c.req.query("dbId"));
  const extra = (c.req.queries("id") ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  const setups: Record<string, ChartSetup | null> = {};
  let table: {
    seats: { pos: string; hero: boolean; dealtBb: number | null }[]; anteBb: number | null; bbCents: number | null; exact: boolean;
    dealtFrom: string | null;
    rake: { pct: number; capBb: number | null; capMoney: number | null; preflopRaked: boolean | null; from: string } | null;
  } | null = null;
  const d = openDb();
  const row = d && Number.isFinite(dbId)
    ? d.query<HandRow, [number]>(`SELECT ${HAND_COLS} FROM hands WHERE rowid = ?`).get(dbId)
    : null;
  const e = row ? enrichSync(row) : null;
  if (e) {
    const h = e.hand;
    const logged = (e.clientHandId ? answerLog.forHand(e.clientHandId) : []) as { chart?: string | null; depth?: number | null; warning?: string | null }[];
    for (const a of logged) {
      if (a.chart && !(a.chart in setups)) setups[a.chart] = chartSetup(a.chart, { depth: a.depth ?? null, note: a.warning ?? null });
    }
    const raw = (e.raw ?? {}) as { names?: Record<string, string>; startStacks?: Record<string, number>; bb?: number; rake?: Record<string, unknown> };
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const dealt: Record<number, number> = { ...((h as { startStacks?: Record<number, number> }).startStacks ?? {}) };
    let dealtFrom: string | null = Object.keys(dealt).length ? "the table's stacks as dealt, recorded with the hand" : null;
    const bbMoney = Number(raw.bb);
    if (!dealtFrom && raw.startStacks && raw.names && bbMoney > 0) {
      for (const [sid, name] of Object.entries(raw.names)) {
        const money = Number(raw.startStacks[name]);
        if (raw.startStacks[name] != null && Number.isFinite(money)) dealt[Number(sid)] = r2(money / bbMoney);
      }
      if (Object.keys(dealt).length) dealtFrom = "the table's stacks before the blinds, recorded per player name with the hand";
    }
    const pos: Record<number, string> = { ...(h.positions ?? {}) };
    if (pos[h.heroSeatId] == null && e.summary.heroPos) pos[h.heroSeatId] = e.summary.heroPos;
    const rr = raw.rake;
    const heads = Object.keys(pos).length === 2;
    const pct = Number(heads && rr?.rakeHeadsUp != null ? rr.rakeHeadsUp : rr?.rake);
    const capMoney = Number(rr?.rakeCap);
    table = {
      seats: Object.entries(pos).map(([sid, p]) => ({ pos: String(p), hero: Number(sid) === h.heroSeatId, dealtBb: dealt[Number(sid)] ?? null })),
      anteBb: h.anteBb ?? null, bbCents: h.bbCents ?? null, exact: Object.keys(dealt).length > 0, dealtFrom,
      rake: rr && Number.isFinite(pct) ? {
        pct,
        capMoney: Number.isFinite(capMoney) && capMoney > 0 ? capMoney : null,
        capBb: Number.isFinite(capMoney) && capMoney > 0 && bbMoney > 0 ? r2(capMoney / bbMoney) : null,
        preflopRaked: typeof rr.isPotRakePf === "boolean" ? rr.isPotRakePf : null,
        from: "the table's own rake settings, recorded with the hand",
      } : null,
    };
  }
  for (const id of extra) if (!(id in setups)) setups[id] = chartSetup(id);
  return c.json({ ok: true, setups, table });
});


/**
 * POST /resolve-chain { dbId, upto } — re-run the live path on the archived
 * hand truncated before actions[upto], with the trace stored as "replay",
 * so it can be diffed against what answered at the table. Costs GTO Wizard
 * quota when the trees are not cached; manual only.
 */
app.post("/resolve-chain", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { dbId?: number; upto?: number };
  const d = openDb();
  if (!d || b.dbId == null || b.upto == null) return c.json({ ok: false, error: "dbId and upto required" }, 400);
  const row = d
    .query<HandRow, [number]>(`SELECT ${HAND_COLS} FROM hands WHERE rowid = ?`)
    .get(Number(b.dbId));
  const e = row ? enrichSync(row) : null;
  if (!e) return c.json({ ok: false, error: `no hand #${b.dbId}` }, 404);
  const t = truncateAt(e.hand, Number(b.upto));
  const heroPos = e.summary.heroPos ?? null;
  // THE STRATEGY THAT ANSWERED AT THE TABLE (2026-09-25 audit): without it fastSolve takes the old non-6-max path
  // (library preflop, GTO Wizard's default rake cap, the street-root fallbacks), so "re-run the live path" compared two
  // different pipelines. Only a hand with no known strategy falls back to chart mode (no MES short-circuit).
  const strategyId = strategyOfHand(e);
  const sol = await fastSolve({ ...t, currentNode: { ...t.currentNode, toActIsHero: true } }, heroPos,
    strategyId ? { heroPos, strategyId, origin: "replay" } : { heroPos, strategy: "chart", origin: "replay" });
  if (!sol.ok) return c.json({ ok: false, error: sol.reason });
  return c.json({ ok: true, solveId: sol.solveId ?? null, tier: sol.tier ?? null, source: sol.source, line: sol.line, actions: sol.actions, decision: sol.decision, warning: sol.warning ?? null });
});

/** GET /solve/compare?a=&b= — two stored solves side by side, node by node. */
app.get("/solve-compare", (c) => {
  const A = solveStore.get(Number(c.req.query("a")));
  const B = solveStore.get(Number(c.req.query("b")));
  if (!A || !B) return c.json({ ok: false, error: "both solves must exist" }, 404);
  const ea = expandTrace(A.trace), eb = expandTrace(B.trace);
  const key = (n: any) => `${n.street}|${n.codes.join("-")}`;
  const byKey = new Map<string, any>(eb.nodes.map((n: any) => [key(n), n] as [string, any]));
  // raw 1326 arrays for TV distance: re-walk both traces' entering ranges
  const rawRanges = (trace: any) => {
    const out: Record<string, Record<string, number[]>> = {};
    const cur: Record<number, { players: string[]; ranges: number[][] }> = {};
    for (const n of trace.nodes ?? []) {
      const st = (trace.streets ?? []).find((x: any) => x.si === n.si);
      if (!cur[n.si]) cur[n.si] = traceSeats(trace.spec ?? {}, st);
      const r = cur[n.si]!;
      out[`${n.street}|${n.codes.join("-")}`] = Object.fromEntries(r.ranges.map((x, i) => [seatLabel(i, r.players.length), x.slice()]));
      if (n.taken != null) {
        const strat = n.actions?.[n.taken]?.strategy ?? [];
        r.ranges[n.actor] = (r.ranges[n.actor] ?? []).map((w: number, ci: number) => w * (strat[ci] ?? 0));
      }
    }
    return out;
  };
  const ra = rawRanges(A.trace), rb = rawRanges(B.trace);
  const nodes = ea.nodes.map((na: any) => {
    const nb = byKey.get(key(na));
    if (!nb) return { key: key(na), street: na.street, codes: na.codes, missingInB: true };
    const actions = na.actions.map((x: any, ai: number) => {
      const yb = nb.actions.find((y: any) => y.name === x.name && (y.betsize ?? null) === (x.betsize ?? null)) ?? nb.actions[ai];
      const pa = x.totalFrequency != null ? x.totalFrequency * 100 : null, pb = yb?.totalFrequency != null ? yb.totalFrequency * 100 : null;
      const ha = na.heroRow?.[ai]?.p ?? null, hb = nb.heroRow?.find((h: any) => h.name === x.name)?.p ?? null;
      return { name: x.name, betsize: x.betsize, overallA: pa == null ? null : Math.round(pa * 10) / 10, overallB: pb == null ? null : Math.round(pb * 10) / 10,
               heroA: ha, heroB: hb, heroDiff: ha != null && hb != null ? Math.round((hb - ha) * 10) / 10 : null };
    });
    const k = key(na);
    return {
      key: k, street: na.street, codes: na.codes, actor: na.actor, actorPos: na.actorPos, heroNode: na.heroNode, takenName: na.takenName,
      rangeTv: {
        oop: tv(ra[k]?.oop ?? [], rb[k]?.oop ?? []), ip: tv(ra[k]?.ip ?? [], rb[k]?.ip ?? []),
        ...(ra[k]?.mid || rb[k]?.mid ? { mid: tv(ra[k]?.mid ?? [], rb[k]?.mid ?? []) } : {}),
      },
      actions,
      maxHeroDiff: Math.max(0, ...actions.map((x: any) => Math.abs(x.heroDiff ?? 0))),
    };
  });
  const hero = nodes.find((n: any) => n.heroNode && !n.missingInB);
  return c.json({
    ok: true, a: A.row, b: B.row, nodes,
    summary: {
      heroMaxDiffPts: hero?.maxHeroDiff ?? null,
      flag: hero ? (hero.maxHeroDiff >= 5 ? "discrepancy" : hero.maxHeroDiff >= 1 ? "minor drift" : "same") : "no matching hero node",
      solIdsSame: (A.trace.streets ?? []).every((sa: any, i: number) => sa.solId && sa.solId === (B.trace.streets ?? [])[i]?.solId),
      rangesSame: nodes.every((n: any) => !n.missingInB && n.rangeTv.oop < 0.001 && n.rangeTv.ip < 0.001),
    },
  });
});


// ------------------------------------------------------------ declared sessions

const DEBUG_DIR_FOR_SESSIONS = wrapperDebugDir();

/** Hands stamped with a declared session id → their enriched rows. */
function handsOfSession(all: Enriched[], id: string): Enriched[] {
  return all.filter((e) => e.raw?.sessionId === id);
}

function sessionCard(s: ReturnType<typeof sessionsStore.list>[number], all: Enriched[], nets: Map<number, number | null>) {
  const hands = handsOfSession(all, s.id);
  const known = hands.map((h) => nets.get(h.dbId)).filter((x): x is number => x != null);
  const netBb = Math.round(known.reduce((a, b) => a + b, 0) * 100) / 100;
  const answers = answerLog.forSession(s.id);
  const answered = answers.filter((a) => a.text != null);
  // hands are the unit of the table, decisions the unit of the answer accounting
  const cov = coverageTotals(hands, answersByHand(answers));
  const tiers: Record<string, number> = {};
  for (const a of answered) tiers[a.tier ?? "unknown"] = (tiers[a.tier ?? "unknown"] ?? 0) + 1;
  const disagreements = answered.filter((a) => a.exploit_pick && a.chart_pick && a.exploit_pick !== a.chart_pick).length;
  const cfg = s.config ?? {};
  // WHICH TABLES ACTUALLY PLAYED, beside the count the session DECLARED. They can
  // differ, and the difference is worth seeing: session 130435 declared two tables
  // and only table 2's hands are stamped with it, because the leader swept the
  // session as a leftover and slot 2 was never told (fixed 2026-09-20, but the
  // historical rows stay as they were).
  const byTable = new Map<number | null, number>();
  for (const h of hands) {
    const t = typeof h.raw?.tableSlot === "number" ? h.raw.tableSlot : null;
    byTable.set(t, (byTable.get(t) ?? 0) + 1);
  }
  const tables = [...byTable.entries()]
    .map(([slot, n]) => ({ slot, hands: n }))
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  return {
    id: s.id, declared: true, startedAt: s.startedAt, endedAt: s.endedAt, preset: s.preset, label: s.label, note: s.note,
    tables, declaredTables: Number.isFinite(Number(cfg.tables)) ? Number(cfg.tables) : null,
    answersOn: !!cfg.answers, recordingOn: !!cfg.recording, budget: cfg.budget ?? null,
    // the whole-hand strategy the session was declared with (services/strategies.ts id), when the mode was one
    strategy: cfg.strategy ?? null, strategyName: cfg.strategyName ?? null,
    // declared at a TEST STAKE: the strategy's answers on a cheaper table (strategies.ts TEST_FORMATS)
    format: cfg.format ?? null, test: isTestFormat(cfg.format),
    // the ACCOUNT it was played on (ignition-study-wrapper/auth.py) — null for
    // sessions declared before profiles existed, and for every gap cluster
    profile: (cfg.profile as string) ?? null,
    hands: hands.length, knownHands: known.length, netBb, bb100: known.length ? Math.round((10000 * netBb) / known.length) / 100 : null,
    stakes: hands[0]?.stakes ?? null,
    // no-probe rows are decisions nobody asked about, not solves that failed
    answers: answered.length, failed: answers.filter((a) => a.text == null && (a.fail_kind ?? failKindOf(a.fail_reason)) !== "no-probe").length, tiers, disagreements,
    decisions: cov.decisions, decisionsCovered: cov.covered, decisionsCoveredPct: cov.coveredPct,
    unansweredNodes: cov.unansweredNodes, partialHands: cov.partialHands, strayCaptures: cov.stray, failKinds: cov.kinds,
    solves: solveStore.forSession(s.id).length,
    recorded: fsExists(join(DEBUG_DIR_FOR_SESSIONS, s.id)),
    preflightOk: s.preflight?.ok ?? null, events: (s.events ?? []).length,
    durationMin: s.summary?.durationMin ?? (s.endedAt ? Math.round((s.endedAt - s.startedAt) / 6000) / 10 : Math.round((Date.now() - s.startedAt) / 6000) / 10),
  };
}

/**
 * GET /profiles — the accounts hands are played on, and whether their money adds up.
 *
 * A hand belongs to an account through the session it was stamped with: the wrapper
 * declares the profile at Start (auth.py), so hands from before that flow, and every
 * undeclared gap cluster, are simply UNATTRIBUTED. That is deliberate — guessing an
 * owner would corrupt the one check this page exists for.
 *
 * The check: between two balance snapshots the money may move by exactly what poker
 * did (services/profiles.ts). Whatever is left over entered or left the account for
 * a non-poker reason, and is reported as such rather than absorbed.
 */
function pricedHandsByProfile() {
  const all = allRows().map(enrichSync).filter((x): x is Enriched => x != null);
  const nets = computeNets(all);
  const declared = sessionsStore.list(500);
  const profileOfSession = new Map<string, string | null>();
  for (const s of declared) profileOfSession.set(s.id, (s.config?.profile as string) ?? null);

  const handsOf = new Map<string, PricedHand[]>();
  const statsOf = new Map<string, { hands: number; priced: number; netCents: number; firstAt: number | null; lastAt: number | null }>();
  let unattributedHands = 0;
  for (const e of all) {
    const sid = typeof e.raw?.sessionId === "string" ? e.raw.sessionId : null;
    const prof = sid ? profileOfSession.get(sid) ?? null : null;
    if (!prof) { unattributedHands++; continue; }
    const bb = bbUsdOf(e.stakes, e.hand.bbCents);
    const net = nets.get(e.dbId) ?? null;
    // a hand is priced only when we know BOTH its net in bb and what a bb is worth
    const netCents = bb != null && net != null ? Math.round(net * bb * 100) : null;
    const bbCents = bb != null ? Math.round(bb * 100) : null;
    // the rake our net does not see: an uncontested win that saw a flop is priced
    // off the displayed (pre-rake) pot — services/profiles.ts explains and subtracts it
    const rake = bbCents != null
      ? rakeEstCents({ heroWonUncontested: !!e.summary.heroWonUncontested, sawFlop: !!e.summary.sawFlop,
                       potCents: Math.round((e.summary.potBb ?? 0) * bbCents), playersDealt: e.summary.tableSeats ?? 3 })
      : 0;
    (handsOf.get(prof) ?? handsOf.set(prof, []).get(prof)!).push({ playedAt: e.playedAt, netCents, rakeEstCents: rake, bbCents });
    const st = statsOf.get(prof) ?? statsOf.set(prof, { hands: 0, priced: 0, netCents: 0, firstAt: null, lastAt: null }).get(prof)!;
    st.hands++;
    if (netCents != null) { st.priced++; st.netCents += netCents; }
    if (e.playedAt != null) {
      st.firstAt = st.firstAt == null ? e.playedAt : Math.min(st.firstAt, e.playedAt);
      st.lastAt = st.lastAt == null ? e.playedAt : Math.max(st.lastAt, e.playedAt);
    }
  }
  return { all, declared, handsOf, statsOf, unattributedHands };
}

app.get("/profiles", (c) => {
  const { all, declared, handsOf, statsOf, unattributedHands } = pricedHandsByProfile();
  const acked = balanceAcks();
  const rows = accountProfiles().map((p) => {
    const hs = handsOf.get(p.name) ?? [];
    const st = statsOf.get(p.name) ?? { hands: 0, priced: 0, netCents: 0, firstAt: null, lastAt: null };
    const snaps = balanceSnapshots(p.name);
    const intervals = reconcileBalances(snaps, hs, acked);
    // only MOVEMENT counts toward the headline: noise is residue, and an
    // unverifiable interval is a caveat, not an accusation
    const moved = intervals.filter((i) => i.tier === "movement");
    const unexplainedCents = moved.reduce((sum, i) => sum + i.unexplainedCents, 0);
    const bal = snaps.length ? snaps[snaps.length - 1]! : null;
    const sessions = declared.filter((s) => (s.config?.profile as string) === p.name)
      .map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, label: s.label,
                     strategyName: s.config?.strategyName ?? null, stakes: null as string | null }));
    return {
      ...p,
      balance: bal,
      // the first reading is the SEED — the anchor every later check hangs off.
      // Until it exists the account is nil: nothing can be checked and no figure
      // is shown as if it could.
      seeded: snaps.length > 0,
      seed: snaps[0] ?? null,
      // AUD is a display-time conversion at the house rate below, never a stored amount
      balanceAudCents: bal ? toAudCents(bal.equityCents) : null,
      netAudCents: toAudCents(st.netCents),
      // NET = what the account actually did since its anchor (equity now − seed). Poker,
      // rake and any residue are how that figure is accounted for, not rivals to it.
      netSinceSeedCents: bal && snaps[0] ? bal.equityCents - snaps[0]!.equityCents : null,
      netSinceSeedAudCents: bal && snaps[0] ? toAudCents(bal.equityCents - snaps[0]!.equityCents) : null,
      // every reading after the seed carries its own check: what the math said
      // equity should be (previous reading + poker after rake) against what was
      // scraped, and the verdict of that comparison
      snapshots: snaps.slice(-50).reverse().map((sn) => {
        const iv = intervals.find((i) => i.to.id === sn.id);
        return {
          ...sn,
          check: iv ? { mathCents: iv.from.equityCents + iv.pokerCents - iv.rakeEstCents, deltaCents: iv.unexplainedCents,
                        toleranceCents: iv.toleranceCents, tier: iv.tier, flaggedTier: iv.flaggedTier, accepted: iv.accepted,
                        matched: iv.tier === "clean" || iv.tier === "noise" || iv.tier === "accepted" }
                    : sn.id === snaps[0]?.id ? { seed: true } : null,
        };
      }),
      intervals: intervals.slice(-50).reverse(),
      unexplainedCents,
      movementIntervals: moved.length,
      unverifiableIntervals: intervals.filter((i) => i.tier === "unverifiable").length,
      acceptedIntervals: intervals.filter((i) => i.tier === "accepted").length,
      sessions: sessions.length,
      sessionList: sessions.reverse().slice(0, 50),
      ...st,
    };
  });
  const fx = fxRate();
  return c.json({ ok: true, profiles: rows, unattributedHands, totalHands: all.length,
    fx: fx.rate ? { rate: fx.rate.rate, at: fx.rate.at, asOf: fx.rate.asOf, source: fx.rate.source, stale: fx.stale } : null });
});

/* ---------------------------------------------------------------- live balance
 *
 * What an account is worth is a READING, never a running total. The stored
 * snapshots are readings too, but they are taken at session open and close, so
 * between sessions the newest one can be hours old — and if a reading was itself
 * wrong (a stack scraped in the wrong unit, a seat the scrape did not see), every
 * figure built on it inherits the error. So the balance shown is scraped from the
 * client NOW, and the stored reading is only the fallback for when the client is
 * shut.
 *
 * The check is the same one /profiles runs between two stored readings, with the
 * live read standing in as the closing one: equity may move by exactly what poker
 * did, after rake, within tolerance. Outside that, the account is flagged for
 * review rather than quietly believed — services/profiles.ts has the reasoning.
 *
 * Only the signed-in account can be read: the probe reads whatever client is
 * open, and the client knows one account at a time. `signedInAs` says which, so
 * the UI never shows one account's money under another's name.
 */
const LIVE_TTL_MS = 10_000;
let liveCache: { at: number; res: any } = { at: 0, res: null };

/** The account the open client belongs to: the wrapper's current session, or the
 *  last declared one when no session is open. */
async function signedInProfile(): Promise<string | null> {
  try {
    const r = await fetch(`${DEFAULT_LIVE_URL}/session`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as any;
    const p = j?.current?.config?.profile;
    if (typeof p === "string" && p) return p;
  } catch { /* wrapper not running — fall through to the archive */ }
  const last = sessionsStore.list(50).find((x) => typeof (x.config as any)?.profile === "string" && (x.config as any).profile);
  return last ? ((last.config as any).profile as string) : null;
}

/** GET /balance-live — scrape the open client and check it against the hands. */
app.get("/balance-live", async (c) => {
  if (c.req.query("fresh") !== "1" && Date.now() - liveCache.at < LIVE_TTL_MS && liveCache.res) return c.json(liveCache.res);
  const at = Date.now();
  let probe: any = null, reason: string | null = null;
  try {
    const r = await fetch(`${DEFAULT_LIVE_URL}/balance/probe`, { method: "POST", signal: AbortSignal.timeout(12_000) });
    probe = await r.json().catch(() => null);
    if (!probe?.ok) reason = probe?.reason ?? `the wrapper refused the read: HTTP ${r.status}`;
  } catch {
    reason = `the wrapper is not answering at ${DEFAULT_LIVE_URL} — it is the only thing that can read the client`;
  }
  const signedInAs = await signedInProfile();
  let check: any = null;
  if (probe?.ok && signedInAs) {
    // the same verdict machinery /profiles uses, with the live read as the
    // closing snapshot — so a live flag and a stored flag mean the same thing
    const { handsOf } = pricedHandsByProfile();
    const snaps = balanceSnapshots(signedInAs);
    if (snaps.length) {
      const live = {
        id: -1, ts: at, profile: signedInAs, amountCents: probe.amountCents,
        inPlayCents: probe.inPlayCents ?? null, equityCents: probe.equityCents,
        currency: probe.currency ?? "USD", source: "live-probe", sessionId: null, phase: "live",
        how: `${probe.how ?? ""}${probe.seated ? ` + table ${probe.inPlayHow ?? ""}` : ""}`.trim(),
      };
      const ivs = reconcileBalances([snaps[snaps.length - 1]!, live as any], handsOf.get(signedInAs) ?? [], {});
      const iv = ivs[0];
      if (iv) check = {
        sinceTs: snaps[snaps.length - 1]!.ts, sinceCents: snaps[snaps.length - 1]!.equityCents,
        expectedCents: iv.from.equityCents + iv.pokerCents - iv.rakeEstCents,
        liveCents: probe.equityCents, movedCents: iv.movedCents, pokerCents: iv.pokerCents,
        rakeEstCents: iv.rakeEstCents, unexplainedCents: iv.unexplainedCents,
        toleranceCents: iv.toleranceCents, tier: iv.tier, hands: iv.hands, unpricedHands: iv.unpricedHands,
        agrees: iv.tier === "clean" || iv.tier === "noise",
      };
    }
  }
  const res = {
    ok: true, at, signedInAs, reason,
    live: probe?.ok ? {
      amountCents: probe.amountCents, inPlayCents: probe.inPlayCents ?? null, equityCents: probe.equityCents,
      currency: probe.currency ?? "USD", seated: !!probe.seated, how: probe.how ?? null, inPlayHow: probe.inPlayHow ?? null,
    } : null,
    check,
  };
  liveCache = { at, res };
  return c.json(res);
});

/**
 * GET /profiles/alerts — how many money facts are waiting to be reviewed, for
 * the badge on the Profiles tab. An alert is one interval whose equity moved by
 * more than the hands, the rake and the tolerance explain and that has not been
 * marked correct — plus the live read, when it disagrees the same way.
 */
app.get("/profiles/alerts", async (c) => {
  const { handsOf } = pricedHandsByProfile();
  const acked = balanceAcks();
  const items: { profile: string; kind: string; cents: number; at: number | null; detail: string }[] = [];
  for (const p of accountProfiles()) {
    const snaps = balanceSnapshots(p.name);
    if (!snaps.length) continue;
    for (const iv of reconcileBalances(snaps, handsOf.get(p.name) ?? [], acked)) {
      if (iv.tier !== "movement") continue;
      items.push({ profile: p.name, kind: "movement", cents: iv.unexplainedCents, at: iv.to.ts,
        detail: `equity moved ${usdCents(iv.movedCents)} where the hands say ${usdCents(iv.pokerCents - iv.rakeEstCents)} after rake` });
    }
  }
  let live: any = null;
  try { live = await (await fetch(`${SELF()}/api/dashboard/balance-live`, { signal: AbortSignal.timeout(15_000) })).json(); } catch { /* no live read */ }
  if (live?.check && live.check.tier === "movement") {
    items.push({ profile: live.signedInAs, kind: "live", cents: live.check.unexplainedCents, at: live.at,
      detail: `the client reads ${usdCents(live.check.liveCents)} where the last reading plus the hands say ${usdCents(live.check.expectedCents)}` });
  }
  return c.json({ ok: true, count: items.length, live: live?.check ? { tier: live.check.tier, agrees: live.check.agrees } : null, items: items.slice(-50).reverse() });
});

const usdCents = (cents: number | null | undefined) => cents == null ? "—" : `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * POST /profiles/:name/seed — take an account's FIRST equity reading, from the
 * client. Proxied to the wrapper because it is the only writer of the balance
 * record and the only thing that can see the client; nothing here is typed in.
 */
app.post("/profiles/:name/seed", async (c) => {
  const name = c.req.param("name");
  let r: Response;
  try {
    r = await fetch(`${DEFAULT_LIVE_URL}/balance/seed`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: name }), signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return c.json({ ok: false, error: `the wrapper is not answering at ${DEFAULT_LIVE_URL} — it is the only thing that can read the client` }, 503);
  }
  const j = (await r.json().catch(() => null)) as any;
  if (!j?.ok) return c.json({ ok: false, error: j?.error ?? j?.reason ?? `the wrapper refused: HTTP ${r.status}`, candidates: j?.candidates ?? null }, r.status === 409 ? 409 : 502);
  return c.json({ ok: true, seed: j });
});

/**
 * POST /profiles/:name/accept { ids?: number[], all?: boolean, note?: string } — mark
 * readings CORRECT. A wrong scrape flags the interval that ends at it as money moved;
 * this keeps the residue on record but takes it out of the verdict, and the math
 * carries on from the reading (it always did). `all` marks every reading whose
 * interval is flagged right now (movement or unverifiable). Undo one with
 * POST /profiles/:name/unaccept { id }.
 */
app.post("/profiles/:name/accept", async (c) => {
  const name = c.req.param("name");
  const body = (await c.req.json().catch(() => ({}))) as { ids?: number[]; all?: boolean; note?: string };
  const snaps = balanceSnapshots(name);
  if (!snaps.length) return c.json({ ok: false, error: "no readings for this profile" }, 404);
  const { handsOf } = pricedHandsByProfile();
  const intervals = reconcileBalances(snaps, handsOf.get(name) ?? [], balanceAcks());
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  const wanted = body.all
    ? intervals.filter((i) => i.tier === "movement" || i.tier === "unverifiable")
    : intervals.filter((i) => ids.includes(i.to.id) && i.tier !== "accepted");
  if (!wanted.length) return c.json({ ok: false, error: body.all ? "nothing is flagged" : "no open flag ends at that reading" }, 404);
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  const accepted = wanted.map((i) => ({ id: i.to.id, ack: acceptReading(name, i.to.id, note, i.unexplainedCents, i.tier) }));
  return c.json({ ok: true, accepted });
});
/**
 * POST /profiles/:name/reset { note? } — "the actual reading now is correct": take a
 * FRESH reading from the client (wrapper /balance/reread) so the baseline is what the
 * client shows now rather than a stored reading that may itself be the wrong one,
 * then accept every interval that is flagged — including the one that ends at the
 * fresh reading. When the client is not open, no reading is taken and only the stored
 * flags are accepted; the reply says which happened.
 */
app.post("/profiles/:name/reset", async (c) => {
  const name = c.req.param("name");
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  if (!balanceSnapshots(name).length) return c.json({ ok: false, error: "no readings for this profile" }, 404);
  let fresh: any = null, freshError: string | null = null;
  try {
    const r = await fetch(`${DEFAULT_LIVE_URL}/balance/reread`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: name }), signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => null)) as any;
    if (j?.ok) fresh = j; else freshError = j?.error ?? j?.reason ?? `the wrapper refused: HTTP ${r.status}`;
  } catch {
    freshError = `the wrapper is not answering at ${DEFAULT_LIVE_URL}`;
  }
  const snaps = balanceSnapshots(name);
  const { handsOf } = pricedHandsByProfile();
  const intervals = reconcileBalances(snaps, handsOf.get(name) ?? [], balanceAcks());
  const flagged = intervals.filter((i) => i.tier === "movement" || i.tier === "unverifiable");
  const custom = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  const note = custom ?? (fresh ? "reset: marked correct against a fresh reading" : `reset: marked correct against the stored reading (no fresh reading — ${freshError})`);
  const accepted = flagged.map((i) => ({ id: i.to.id, ack: acceptReading(name, i.to.id, note, i.unexplainedCents, i.tier) }));
  return c.json({ ok: true, fresh, freshError, accepted: accepted.length, baseline: snaps[snaps.length - 1] ?? null });
});
app.post("/profiles/:name/unaccept", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: number };
  if (typeof body.id !== "number") return c.json({ ok: false, error: "id required" }, 400);
  return c.json({ ok: unacceptReading(body.id) });
});

/**
 * The hand-off board (services/tasks.ts): GET /tasks; POST /tasks {title,...} creates;
 * POST /tasks/reorder {ids}; POST /tasks/:id {status?, brief?, next?, doneWhen?, needsYou?,
 * goal?, title?, links?, note?} updates (a note appends a dated log line).
 */
app.get("/tasks", (c) => c.json({ ok: true, tasks: loadTasks() }));
app.post("/tasks", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  if (!body?.title) return c.json({ ok: false, error: "title required" }, 400);
  return c.json({ ok: true, task: createTask(body) });
});
app.post("/tasks/reorder", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
  if (!Array.isArray(body.ids)) return c.json({ ok: false, error: "ids required" }, 400);
  return c.json({ ok: true, tasks: reorderTasks(body.ids) });
});
app.post("/tasks/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const t = updateTask(c.req.param("id"), body);
  return t ? c.json({ ok: true, task: t }) : c.json({ ok: false, error: "no such task" }, 404);
});

/** GET /sessions — declared sessions (newest first) plus the undeclared gap clusters of older hands. */
app.get("/sessions", (c) => {
  const all = allRows().map(enrichSync).filter((x): x is Enriched => x != null);
  const nets = computeNets(all);
  const declared = sessionsStore.list(200).map((s) => sessionCard(s, all, nets));
  const clusters = gapClusters(all).map((hs) => {
    const known = hs.map((h) => nets.get(h.dbId)).filter((x): x is number => x != null);
    const netBb = Math.round(known.reduce((a, b) => a + b, 0) * 100) / 100;
    return {
      id: `cluster-${hs[0]!.playedAt}`, declared: false, startedAt: hs[0]!.playedAt, endedAt: hs[hs.length - 1]!.playedAt,
      preset: null, label: null, note: null, answersOn: null, mode: null, recordingOn: null, budget: null,
      hands: hs.length, knownHands: known.length, netBb, bb100: known.length ? Math.round((10000 * netBb) / known.length) / 100 : null,
      stakes: hs[0]!.stakes, answers: null, failed: null, tiers: {}, disagreements: null, solves: null,
      recorded: hs.some((h) => h.clientHandId && recordingForHand(h.clientHandId)), preflightOk: null, events: 0,
      durationMin: Math.round(((hs[hs.length - 1]!.playedAt ?? 0) - (hs[0]!.playedAt ?? 0)) / 6000) / 10,
    };
  }).reverse();
  return c.json({ ok: true, store: sessionsStore.path, declared, clusters });
});

/** POST /sessions/:id/end { note? } — end a session that was left open, from
 *  the dashboard instead of the panel's End button. A session is open purely
 *  because nothing ever wrote its `ended_at` (sessions.py): closing the table
 *  tab, quitting the wrapper or rebooting all leave the row standing.
 *
 *  The wrapper OWNS the record, so this proxies to its /session/end rather
 *  than writing sessions.sqlite here: when the session being ended is the LIVE
 *  one, only the wrapper can also stop the study answers, the recording and
 *  the router that belong to it. If it is not running there is nothing to end
 *  it with, and we say so instead of writing behind its back. */
app.post("/sessions/:id/end", async (c) => {
  const id = c.req.param("id");
  const s = sessionsStore.get(id);
  if (!s) return c.json({ ok: false, error: `no declared session ${id}` }, 404);
  if (s.endedAt) return c.json({ ok: false, error: "that session is already ended" }, 409);
  const b = (await c.req.json().catch(() => ({}))) as { note?: string };
  const note = (b.note ?? "").trim() || "ended from the dashboard";
  let r: Response;
  try {
    r = await fetch(`${DEFAULT_LIVE_URL}/session/end`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, note }), signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return c.json({ ok: false, error: `the wrapper is not answering at ${DEFAULT_LIVE_URL}, and it is the only writer of the session record — start it and end the session again` }, 503);
  }
  const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!j?.ok) return c.json({ ok: false, error: j?.error ?? `the wrapper refused: HTTP ${r.status}` }, 502);
  // re-read: the row the wrapper just wrote, summary and all
  return c.json({ ok: true, session: sessionsStore.get(id) });
});

/**
 * POST /reconcile-answers { days? , all? } — settle WHY the unanswered
 * decisions were unanswered, over history rather than live.
 *
 * Runs on a timer over the last day (services/answerReconciler.ts); this is the
 * one-shot for older sessions. It only ever ADDS a reason to a decision that
 * has none, so running it twice changes nothing the second time.
 */
app.post("/reconcile-answers", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { days?: number; all?: boolean };
  const since = b.all ? 0 : Date.now() - Math.max(1, Number(b.days ?? 1)) * 86_400_000;
  const { reconcileAnswers } = await import("../services/answerReconciler");
  return c.json({ ok: true, ...reconcileAnswers(since) });
});

/** Big blind in dollars, read off a stakes label like "$1.00/$2.00" (the last
 *  number is the big blind). Null when the label is missing or unparseable —
 *  the session page then shows the bb figures and omits the money ones. */
/** The big blind in dollars: the row's own bbCents when the caller has it, else the stakes string's LAST number
 *  before any " ante …" — CoinPoker's string ends in its ante, which this used to read as the big blind. */
function bbUsdOf(stakes: string | null | undefined, bbCents?: number | null): number | null {
  if (bbCents != null && Number.isFinite(bbCents) && bbCents > 0) return bbCents / 100;
  const ns = String(stakes ?? "").replace(/\s+ante\b.*$/i, "").match(/[\d.]+/g);
  const bb = ns?.length ? Number(ns[ns.length - 1]) : NaN;
  return Number.isFinite(bb) && bb > 0 ? bb : null;
}

/** GET /sessions/:id — one declared session (or an undeclared cluster) in full. */
/**
 * A SESSION'S TECHNICAL VIEW (2026-09-25, Brady: "a technical tab … for debugging, not for a normal end user"): the
 * clean rate first — the share of hands that reached a postflop decision along the chain's happy path — then every
 * reason a hand was not clean, grouped, with the hands it hit; how the flop ranges and the streets were produced;
 * and what GTO Wizard requests cost per hand (live decisions and the street warm-up, from the hand facts).
 */
app.get("/sessions/:id/technical", (c) => {
  const id = c.req.param("id");
  const rows = answerLog.pathRows(id);
  const report = technicalReport(rows);
  const keys = [...new Set(rows.map((r) => r.client_hand_id).filter((x): x is string => !!x))];
  const facts = handFacts.many(keys);
  const byOrigin: Record<string, { hands: number; tree: number; solution: number; poll: number; total: number }> = {};
  for (const doc of Object.values(facts)) {
    for (const [origin, cnt] of Object.entries(doc.requests ?? {})) {
      const o = (byOrigin[origin] ??= { hands: 0, tree: 0, solution: 0, poll: 0, total: 0 });
      o.hands++; o.tree += cnt.tree; o.solution += cnt.solution; o.poll += cnt.poll;
      o.total += cnt.tree + cnt.solution + cnt.poll + cnt.library + cnt.other;
    }
  }
  // the hand page is addressed by hands.db rowid: map each chain hand's site id to it where the hand is archived
  const rowids: Record<string, number> = {};
  try {
    const want = new Set(keys);
    for (const r of allRows()) {
      const m = r.data.match(/"clientHandId":\s*"(\d+)"/);
      if (m && want.has(m[1]!)) rowids[m[1]!] = r.rowid;
    }
  } catch { /* the links are a convenience */ }
  return c.json({ ok: true, id, ...report, requestsByOrigin: byOrigin, rowids });
});

app.get("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const all = allRows().map(enrichSync).filter((x): x is Enriched => x != null);
  const nets = computeNets(all);
  const byCid = answersByHand(answerLog.rows(3650));
  // oldest first, for the cumulative graph — the same shape analyticsCore serves
  const seriesRow = (e: Enriched) => ({ id: e.dbId, t: e.playedAt, net: nets.get(e.dbId) ?? null });
  const handRow = (e: Enriched) => {
    const st = answerStatusOf(e, byCid);
    return {
      dbId: e.dbId, clientHandId: e.clientHandId, playedAt: e.playedAt, stakes: e.stakes, heroCards: e.heroCards,
      heroPos: e.summary.heroPos, finalStreet: e.summary.finalStreet, potBb: e.summary.potBb, netBb: nets.get(e.dbId) ?? null,
      sawFlop: e.summary.sawFlop, wentToShowdown: e.summary.wentToShowdown ?? null, answers: st.answered, status: st,
      // the frame recording holding this hand, when one exists (gap clusters are not keyed by session id)
      recording: e.clientHandId ? (recordingForHand(e.clientHandId)?.session ?? null) : null,
    };
  };
  if (id.startsWith("cluster-")) {
    const start = Number(id.slice(8));
    const hs = gapClusters(all).find((h) => h[0]!.playedAt === start);
    if (!hs) return c.json({ ok: false, error: "no such cluster" }, 404);
    return c.json({
      ok: true,
      session: { id, declared: false, startedAt: hs[0]!.playedAt, endedAt: hs[hs.length - 1]!.playedAt, stakes: hs[0]!.stakes, bbUsd: bbUsdOf(hs[0]!.stakes) },
      stats: aggregateHands(hs, nets), series: hs.map(seriesRow),
      hands: hs.map(handRow).reverse(), answers: [], solves: [], recording: null,
    });
  }
  const s = sessionsStore.get(id);
  if (!s) return c.json({ ok: false, error: `no declared session ${id}` }, 404);
  const hands = handsOfSession(all, id);
  const answers = answerLog.forSession(id);
  const recDir = join(DEBUG_DIR_FOR_SESSIONS, id);
  return c.json({
    ok: true,
    session: { ...sessionCard(s, all, nets), bbUsd: bbUsdOf(hands[0]?.stakes ?? null), config: s.config, preflight: s.preflight, versions: s.versions, eventsList: s.events, summary: s.summary },
    // the same aggregate and hand series the Analytics tab is built from, so the
    // session's own Outcome card and `/analytics?scope=sessions:<id>` cannot drift
    stats: aggregateHands(hands, nets),
    series: hands.map(seriesRow),
    hands: hands.map(handRow).reverse(),
    answers: answers.map((a) => ({ id: a.id, ts: a.ts, clientHandId: a.client_hand_id, street: a.street, board: a.board, heroCards: a.hero_cards, tier: a.tier, source: a.source ?? sourceForTier(a.tier), text: a.text, pick: a.pick, exploitPick: a.exploit_pick, chartPick: a.chart_pick, strategyMode: a.strategy_mode, latencyMs: a.latency_ms, failReason: a.fail_reason, solveId: a.solve_id, integrity: integrityOf(a) })).reverse(),
    integrity: integrityTotals(answers),
    solves: solveStore.forSession(id),
    recording: fsExists(recDir) ? { dir: recDir, name: id } : null,
  });
});

export default app;

/**
 * POST /study-answer — the Study Answer for a PLAYTHROUGH state.
 *
 * Same mechanism as the table, deliberately: the playthrough state is turned
 * into the ParsedHand the wrapper would have produced, fastSolve answers it
 * (exploit overlay / 3-max chart preflop, MES overlay postflop), rollDecision
 * rolls the mix ONCE and buildAnswerText writes the panel line.
 * The reply is shaped like a row of answers.sqlite so the dashboard renders
 * it with the very same answer card as a hand's logged answers. Nothing is
 * logged: a playthrough is study, not a session.
 *
 * body: { hero: "SB", line: ["F","R3","C"], combo: "AhQs", strategy?: "exploit"|"chart",
 *         board?: "Qs8s4d" | "Qs8s4dTh" | ..., flop?: ["Check","Bet(300)"], turn?: [...], river?: [...],
 *         depth?: 100, bbCents?: 200 }
 */
app.post("/study-answer", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as {
    hero?: string; line?: string[]; combo?: string; strategy?: "exploit" | "chart"; board?: string;
    flop?: string[]; turn?: string[]; river?: string[]; depth?: number; bbCents?: number;
  };
  const t0 = Date.now();
  const hero = String(b.hero ?? "").toUpperCase();
  const seatOf: Record<string, number> = { BTN: 1, SB: 2, BB: 3 };
  if (!seatOf[hero]) return c.json({ ok: false, error: "hero must be BTN, SB or BB" }, 400);
  const combo = String(b.combo ?? "").trim();
  if (!/^[2-9TJQKA][shdc][2-9TJQKA][shdc]$/.test(combo)) return c.json({ ok: false, error: "combo must look like AhQs" }, 400);
  const heroCards = [combo.slice(0, 2), combo.slice(2, 4)];
  const depth = Number(b.depth) > 0 ? Number(b.depth) : 100;
  const boardStr = String(b.board ?? "");
  const board: string[] = boardStr.match(/[2-9TJQKA][shdc]/g) ?? [];
  const street = board.length >= 5 ? "river" : board.length === 4 ? "turn" : board.length === 3 ? "flop" : "preflop";
  const heroSeat = seatOf[hero]!;
  // the wrapper labels the seats the FEED named, never hero's own — the MES
  // lookup folds heroPos back in, so listing it here would count hero twice
  const positions: Record<number, string> = { 1: "BTN", 2: "SB", 3: "BB" };
  delete positions[heroSeat];
  const stacks: Record<number, number> = { 1: depth, 2: depth, 3: depth };
  const committed: Record<number, number> = { 1: 0, 2: 0.5, 3: 1 };
  type A = { seatId: number; hero: boolean; type: any; amount?: number; street: any };
  const actions: A[] = [
    { seatId: 2, hero: heroSeat === 2, type: "post-sb", amount: 0.5, street: "preflop" },
    { seatId: 3, hero: heroSeat === 3, type: "post-bb", amount: 1, street: "preflop" },
  ];
  // preflop tokens are positional BTN, SB, BB; a fold closes the seat
  const order = [1, 2, 3];
  const alive: Record<number, boolean> = { 1: true, 2: true, 3: true };
  let k = 0, bet = 1;
  for (const tok of b.line ?? []) {
    while (!alive[order[k % 3]!]) k++;
    const seat = order[k % 3]!; k++;
    if (tok === "F") { alive[seat] = false; actions.push({ seatId: seat, hero: seat === heroSeat, type: "fold", street: "preflop" }); }
    else if (tok === "C") { committed[seat] = bet; actions.push({ seatId: seat, hero: seat === heroSeat, type: "call", amount: bet, street: "preflop" }); }
    else if (tok === "X") actions.push({ seatId: seat, hero: seat === heroSeat, type: "check", street: "preflop" });
    else if (/^R[\d.]+$/.test(tok)) { bet = parseFloat(tok.slice(1)); committed[seat] = bet; actions.push({ seatId: seat, hero: seat === heroSeat, type: "raise", amount: bet, street: "preflop" }); }
    else if (tok === "RAI") { bet = depth; committed[seat] = bet; actions.push({ seatId: seat, hero: seat === heroSeat, type: "all-in", amount: bet, street: "preflop" }); }
  }
  const potPre = committed[1]! + committed[2]! + committed[3]!;
  const potByStreet: Record<string, number> = { preflop: potPre };
  // postflop: heads-up after one fold, SB/BB/BTN order, strictly alternating
  const live = [2, 3, 1].filter((s) => alive[s]);
  const labels = (a: string) => a.replace(/\s+/g, "");
  let pot = potPre;
  for (const [st, arr] of [["flop", b.flop], ["turn", b.turn], ["river", b.river]] as const) {
    if (!arr?.length) continue;
    let i = 0; let streetPot = 0; let toCall = 0; const inStreet: Record<number, number> = {};
    for (const raw of arr) {
      const seat = live[i % live.length]!; i++;
      const lab = labels(raw);
      const amt = lab.match(/\((\d+(?:\.\d+)?)\)/) ? parseFloat(lab.match(/\((\d+(?:\.\d+)?)\)/)![1]!) / 100 : null;
      const isHero = seat === heroSeat;
      if (/^Check/i.test(lab)) actions.push({ seatId: seat, hero: isHero, type: "check", street: st });
      else if (/^Fold/i.test(lab)) { alive[seat] = false; actions.push({ seatId: seat, hero: isHero, type: "fold", street: st }); }
      else if (/^Call/i.test(lab)) { const add = toCall - (inStreet[seat] ?? 0); inStreet[seat] = toCall; streetPot += add; actions.push({ seatId: seat, hero: isHero, type: "call", amount: toCall, street: st }); }
      else if (/^Bet/i.test(lab) && amt != null) { inStreet[seat] = amt; toCall = amt; streetPot += amt; actions.push({ seatId: seat, hero: isHero, type: "bet", amount: amt, street: st }); }
      else if (/^Raise/i.test(lab) && amt != null) { streetPot += amt - (inStreet[seat] ?? 0); inStreet[seat] = amt; toCall = amt; actions.push({ seatId: seat, hero: isHero, type: "raise", amount: amt, street: st }); }
      else if (/^All/i.test(lab)) { const amt2 = depth - potPre / 2; streetPot += amt2 - (inStreet[seat] ?? 0); inStreet[seat] = amt2; toCall = amt2; actions.push({ seatId: seat, hero: isHero, type: "all-in", amount: amt2, street: st }); }
    }
    pot += streetPot; potByStreet[st] = pot;
  }
  const hand = {
    handId: 0, clientHandId: null, bbCents: Number(b.bbCents) > 0 ? Number(b.bbCents) : 200, heroSeatId: heroSeat, heroCards, board, street,
    actions, liveSeats: [1, 2, 3], committed, potByStreet, positions, stacks,
    currentNode: { street, toActSeatId: heroSeat, toActIsHero: true, pot, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
  const strategy = b.strategy === "chart" ? "chart" : "exploit";
  if (heroCards.some((c) => board.includes(c))) {
    return c.json({ ok: true, answer: { ts: Date.now(), street, board: board.join("") || null, hero_cards: heroCards.join(""), actionIndex: null, latency_ms: 0, text: null, pick: null, roll: null, tier: null, warning: null, fail_reason: `your hand ${combo} shares a card with the board ${board.join("")} — pick a hand that is not on the board` }, hand });
  }
  const sol = await fastSolve(hand, hero, { heroPos: hero, strategy, origin: "playthrough" });
  const base = {
    ts: Date.now(), street, board: board.join("") || null, hero_cards: heroCards.join(""), actionIndex: null as number | null,
    latency_ms: Date.now() - t0, chart: sol.ok ? (sol.rangeSource ?? sol.gametype) : (sol.gametype ?? null),
    strategy_mode: sol.ok ? sol.strategyMode ?? strategy : strategy, source: sol.ok ? sol.source : null,
    band_lo: sol.ok ? sol.decision?.band?.[0] ?? null : null, band_hi: sol.ok ? sol.decision?.band?.[1] ?? null : null,
    exploit_pick: sol.ok ? sol.exploitDecision?.action ?? null : null, chart_pick: sol.ok ? sol.chartDecision?.action ?? null : null,
    exploit_tag: sol.ok ? sol.exploitTag ?? null : null, mes_board: sol.ok ? sol.mesBoard ?? null : null,
    mes_ev_gain_bb: sol.ok ? sol.mesEvGainBb ?? null : null, mes_exact: sol.ok ? (sol.mesExact == null ? null : sol.mesExact ? 1 : 0) : null,
    hero_pos: hero, depth: sol.ok ? sol.depth : depth, set_id: sol.ok ? sol.setId : null,
    decision_json: sol.ok && sol.actions ? JSON.stringify(sol.actions) : null, line: sol.ok ? sol.line : (sol.line ?? null), solve_id: sol.ok ? sol.solveId ?? null : null,
  };
  if (!(sol.ok && sol.decision)) {
    const reason = sol.ok ? (sol.notInRange ? "hero's hand isn't in the chart range at this node" : "no decision in response") : sol.reason;
    return c.json({ ok: true, answer: { ...base, text: null, pick: null, roll: null, tier: sol.ok ? sol.tier ?? null : null, warning: null, fail_reason: reason }, hand });
  }
  // the table's own roller (services/rollDecision.ts): one roll decides pick, headline, band and both pieces' picks
  const rolled = rollDecision({ ...sol, decision: sol.decision });
  const text = (sol.approx ? "≈ " : "") + buildAnswerText({ street, decision: { action: rolled.pick, frequency: rolled.frequency ?? undefined }, actions: sol.actions }) + (rolled.roll != null ? ` · roll ${fmtRoll(rolled.roll)} → ${rolled.pick.toUpperCase()}` : "");
  return c.json({ ok: true, answer: { ...base, band_lo: rolled.band[0], band_hi: rolled.band[1], exploit_pick: rolled.exploitPick, chart_pick: rolled.chartPick,
    text, pick: rolled.pick, roll: rolled.roll, tier: sol.tier ?? (street === "preflop" ? "local-preflop" : null), warning: sol.warning ?? null, fail_reason: null }, hand });
});

/**
 * GTO Wizard AI client — the postflop fallback for everything the MES overlay
 * does not cover, so its state must be loud. GET /gtow-status is cheap (one
 * CDP probe, no sniff); POST /gtow-connect launches the desktop client with
 * the debug port (services/gtowCdp.launchApp, the twin of
 * scripts/start_gtow_ai.ps1) and waits for a token, up to ~60 s.
 */
async function gtowStatus() {
  const t0 = Date.now();
  const sessions = (await gtowSessions.statusProbed()) as Array<
    Awaited<ReturnType<typeof gtowSessions.statusProbed>>[number] & { clientUp?: boolean; browser?: string | null }
  >;
  const up = sessions.filter((s) => s.state === "up");
  // The ACTIVE session is the one the router would reach for first — it is what
  // the single-session fields below describe, so a caller that predates the
  // pool still gets a coherent answer out of them.
  const active = up[0] ?? sessions.find((s) => s.enabled) ?? sessions[0]!;
  const anyClientUp = sessions.some((s) => s.clientUp);
  const multiwayUsable = up.some((s) => s.multiway);
  const usable = up.length > 0;
  const state = usable ? "up" : anyClientUp ? "no-token" : "down";
  const enabled = sessions.filter((s) => s.enabled).length;
  const mins = (ms: number | null | undefined) => Math.max(0, Math.round((ms ?? 0) / 60000));
  const text = usable
    ? `${up.length} of ${enabled} sessions live — ${up.map((s) => `${s.id} ${mins(s.expiresInMs)} min`).join(", ")}${multiwayUsable ? "" : " · NO multiway session: 3+ player spots cannot be solved"}`
    : anyClientUp
      ? "a client is reachable but no session has a token — is GTO Wizard signed in?"
      : "no GTO Wizard session is running with its debug port";
  return {
    ok: true as const,
    // ── rolled up, for every caller that predates the pool ──────────────────
    clientUp: anyClientUp,
    cdpHost: active.cdpHost,
    browser: active.browser ?? null,
    probeMs: Date.now() - t0,
    tokenLive: usable,
    expiresInMs: active.expiresInMs,
    keeperRunning: gtowApi.tokenStatus().keeperRunning,
    lastAttemptMs: active.lastAttemptMs,
    usable,
    state,
    text,
    // ── the pool ────────────────────────────────────────────────────────────
    /** can a 3+ player AI tree be solved right now (Ultra only) */
    multiwayUsable,
    /** which session the router reaches for first on heads-up work */
    activeId: active.id,
    sessions,
    /** requests sent to api.gtowizard.com in the trailing 24 h / since 00:00 UTC, per account and kind, against
     *  the cap the 429 body states (services/gtowRequestLog.ts — every process writes the same ledger) */
    requests: gtowApi.requestStats(),
  };
}
app.get("/gtow-status", async (c) => c.json(await gtowStatus()));
/**
 * POST /gtow-connect — bring a session back.
 *
 * `{ source: "primary" | "secondary" }` targets one session; omitted, it
 * connects whichever sessions are not already up. The two are launched
 * differently (the primary is a Chrome profile or an Electron build driven by
 * services/gtowCdp; the secondary is the Elite desktop build on its own port),
 * so each has its own launcher.
 *
 * A client parked on its ACTIVATION or SIGN-IN screen is NOT relaunched —
 * that would throw away whatever the user is typing. The launcher reports it
 * (exit 3) and the hint says who has to do what.
 */
app.post("/gtow-connect", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}) as any);
  const want: GtowSessionId[] =
    body?.source === "primary" || body?.source === "secondary"
      ? [body.source as GtowSessionId]
      : (["secondary", "primary"] as GtowSessionId[]).filter((id) => {
          const s = gtowSessions.status().find((x) => x.id === id);
          return s?.enabled && s.state !== "up";
        });

  const launches: Record<string, unknown> = {};
  for (const id of want) {
    if (id === "primary") {
      launches[id] = await gtowCdp.launchApp();
    } else {
      const proc = Bun.spawn(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(REPO, "scripts", "start_gtow_secondary.ps1")],
        { stdout: "pipe", stderr: "pipe" }
      );
      const code = await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim();
      const err = (await new Response(proc.stderr).text()).trim();
      launches[id] = { ok: code === 0, code, needsHuman: code === 3, out: out.slice(-400), error: err.slice(-400) || undefined };
    }
  }

  // wait for the debug ports, then for tokens (the sniff needs an app page up)
  let live = false;
  for (let i = 0; i < 30 && !live; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const probe = await gtowStatus();
    if (!probe.clientUp) continue;
    live = await gtowApi.forceRefresh(want.length === 1 ? want[0] : undefined);
  }
  const st = await gtowStatus();
  const needsHuman = Object.values(launches).some((l: any) => l?.needsHuman);
  return c.json({
    ...st, launch: launches, targeted: want, waitedMs: Date.now() - t0, connected: live,
    hint: live ? null
      : needsHuman ? "a client is waiting for a human — enter the activation code (or sign in) in its window, then press Connect again"
      : st.clientUp ? "a client is up but no token came back — sign in to GTO Wizard in its window (it was started minimized) and try again"
      : "no client came up — start one by hand: scripts/start_gtow_chrome.ps1 (primary) or scripts/start_gtow_secondary.ps1",
  });
});

/** POST /gtow-reset — forget what we learned about a session (a quota wall, a
 *  plan refusal) so the router offers it work again immediately. */
app.post("/gtow-reset", async (c) => {
  const body = await c.req.json().catch(() => ({}) as any);
  const id: GtowSessionId | null = body?.source === "primary" || body?.source === "secondary" ? body.source : null;
  if (!id) return c.json({ ok: false, error: "source must be 'primary' or 'secondary'" }, 400);
  gtowSessions.reset(id);
  await gtowApi.forceRefresh(id);
  return c.json({ ...(await gtowStatus()), reset: id });
});

/**
 * GET /health — the Home page's system strip: is the machinery that answers a
 * spot actually up right now, and is anything queued behind it.
 *
 * Each row is one thing that can be broken independently, in the order it bites
 * at the table: the poller that watches the table, the GTO Wizard client the
 * whole of postflop falls back on, the answer latency those two produce, the
 * preflop misses that have no live solver and pile up instead, and the solve
 * boxes working them off. Every probe is already cheap and in-process except
 * the GTO Wizard one (a single CDP call), so this is safe to poll.
 */
app.get("/health", async (c) => {
  const gtow = await gtowStatus();
  const poller: any = (() => { try { return studyPoller.getStatus(); } catch { return null; } })();
  const mq = (() => { try { return missQueue.stats(); } catch { return null; } })();
  const keeper = (() => {
    try {
      const st: any = boxKeeper.status();
      const boxes = Object.entries(st.boxes ?? {}) as [string, any][];
      return {
        running: !!st.running,
        total: boxes.length,
        up: boxes.filter(([, b]) => b?.ok).length,
        working: boxes.filter(([, b]) => b?.job === "Running").length,
        boxes: boxes.map(([name, b]) => ({ name, ok: !!b?.ok, hrc: !!b?.hrc, job: b?.job ?? null, phase: b?.currentPhase ?? null, lastErr: b?.lastErr || null })),
      };
    } catch { return null; }
  })();
  const runningJobs = (() => { try { return jobStore.list(30).filter((j) => j.status === "running").map((j) => ({ id: j.id, config: j.config, recipe: j.recipe, lane: j.lane, startedAt: j.started })); } catch { return []; } })();
  const answers = answerLog.stats(7) as { answered?: number; failed?: number; tiers?: Record<string, { n: number; p50: number; p90: number; max: number }> };
  return c.json({
    ok: true, at: Date.now(),
    gtow: { state: gtow.state, usable: gtow.usable, text: gtow.text, expiresInMs: gtow.expiresInMs, cdpHost: gtow.cdpHost },
    poller: poller ? {
      running: !!poller.running, lastTickAt: poller.lastTickAt ?? null, lastPushAt: poller.lastPushAt ?? null,
      lastError: poller.lastError ?? null, tokenReady: !!poller.tokenReady, integrityFaults: poller.integrityFaults ?? 0,
      tables: Array.isArray(poller.pollers) ? poller.pollers.length : 0,
    } : null,
    answers: { answered: answers.answered ?? 0, failed: answers.failed ?? 0, tiers: answers.tiers ?? {} },
    missQueue: mq ? { total: mq.total, open: (mq.byStatus?.open ?? 0) + (mq.byStatus?.queued ?? 0), byKind: mq.byKind } : null,
    keeper, jobs: runningJobs,
  });
});
