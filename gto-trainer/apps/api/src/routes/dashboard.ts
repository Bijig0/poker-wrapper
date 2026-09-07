import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { summarizeHand, type HandSummary } from "../utils/handSummary/handSummary";
import { buildSpotSolutionTokens, buildPreflopTokens, buildPreflopTokensHu, buildSolutionUrl } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { snapPreflopLine } from "../utils/snapPreflopLine/snapPreflopLine";
import { preflopDb } from "../services/preflopDb";
import { resolveSet, resolveDepth } from "../services/fastSolve";
import { answerLog } from "../services/answerLog";
import { strategyIdForAnswer, STRATEGIES } from "../services/strategies";
import { getCatalog } from "../services/chartCatalog";
import { gtowCdp } from "../services/gtowCdp";
import { gtowApi } from "../services/gtowApi";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { readFileSync } from "node:fs";
import { buildPreflopTokens3max } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { mesBoardFor, mesFamilyFor } from "../services/mesPostflop";
import { recordingForHand } from "./replay";
import { sourceForTier } from "../services/answerLog";
import { fetchNode as hrcFetchNode, chartFor, walk3max, HRC3MAX_BASE } from "../services/hrc3max";
import { mesNodeDetail } from "../services/mesPostflop";
import { solveStore } from "../services/solveStore";
import { sessionsStore } from "../services/sessionsStore";
import { existsSync as fsExists } from "node:fs";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import { fastSolve } from "../services/fastSolve";
import { rollAction } from "../services/studyPoller";
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

export const HANDS_DB =
  process.env.HANDS_DB_PATH ??
  join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper", "data", "hands.db");
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
}

let db: Database | null = null;
const openDb = (): Database | null => {
  if (db) return db;
  if (!existsSync(HANDS_DB)) return null;
  db = new Database(HANDS_DB, { readonly: true });
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
  if (hit) return hit;
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
    discrepancies: null,
  };
  cache.set(row.rowid, e);
  return e;
}

/** Enrich and make sure an audit is on its way (non-blocking). */
async function enrich(row: HandRow): Promise<Enriched | null> {
  const e = enrichSync(row);
  if (e && e.discrepancies == null) scheduleAudit(e);
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
  } catch {
    /* audit unavailable — leave null, retried by the next scheduleAudit */
  }
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

export const allRows = (): HandRow[] => {
  const d = openDb();
  if (!d) return [];
  const rows = d
    .query<HandRow, []>(
      "SELECT rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data FROM hands ORDER BY rowid"
    )
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
    // showdown: chain hero stacks to the next hand of the same session/stakes
    const next = hands[i + 1];
    const curStack = h.hand.stacks?.[h.hand.heroSeatId];
    const nextStack = next?.hand.stacks?.[next.hand.heroSeatId];
    if (
      next &&
      curStack != null &&
      nextStack != null &&
      next.stakes === h.stakes &&
      next.playedAt != null &&
      h.playedAt != null &&
      next.playedAt - h.playedAt < SESSION_GAP_MS
    ) {
      const diff = Math.round((nextStack - curStack) * 100) / 100;
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
 *  answer log (a hand that got any MES-postflop answer is Apex, else the mode). */
function strategyByHand(): Map<string, { id: string; name: string }> {
  const byName = new Map(STRATEGIES.map((x) => [x.id, x.name]));
  const out = new Map<string, { id: string; name: string }>();
  for (const a of answerLog.rows(365)) {
    const h = (a as { client_hand_id?: string | null }).client_hand_id;
    const sid = strategyIdForAnswer(a as never);
    if (!h || !sid) continue;
    const cur = out.get(h);
    // apex wins over the mode-only tag: a postflop MES answer proves both layers
    if (!cur || (sid === "apex" && cur.id !== "apex")) out.set(h, { id: sid, name: byName.get(sid) ?? sid });
  }
  return out;
}

app.get("/hands", async (c) => {
  const rows = allRows();
  const enriched = (await Promise.all(rows.map(enrich))).filter((x): x is Enriched => x != null);
  const nets = computeNets(enriched);
  const strat = strategyByHand();
  // the session's declared strategy wins over the heuristic: Apex is Apex even
  // on a hand where no MES spot arose (a 5-handed Zone hand, say)
  const byName = new Map(STRATEGIES.map((x) => [x.id, x.name]));
  const declared = new Map<string, string>();
  for (const sess of sessionsStore.list(500)) { const id = sess.config?.strategy; if (typeof id === "string" && byName.has(id)) declared.set(sess.id, id); }
  const strategyOf = (e: Enriched) => {
    const sid = typeof e.raw?.sessionId === "string" ? e.raw.sessionId : null;
    const d = sid ? declared.get(sid) : undefined;
    if (d) return { id: d, name: byName.get(d) ?? d, declared: true };
    const h = e.clientHandId ? strat.get(e.clientHandId) : null;
    return h ? { ...h, declared: false } : null;
  };
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
  return c.json({ ok: true, total: hands.length, auditPending: auditPending(), hands });
});

app.get("/hand/:dbId", async (c) => {
  const dbId = Number(c.req.param("dbId"));
  const d = openDb();
  if (!d) return c.json({ ok: false, error: `hands.db not found at ${HANDS_DB}` }, 503);
  const row = d
    .query<HandRow, [number]>(
      "SELECT rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data FROM hands WHERE rowid = ?"
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
    return { ...a, actionIndex, source: a.source ?? sourceForTier(a.tier) };
  });
  // Session: the gap cluster this hand sits in (same rule as Analytics), and
  // the debug recording that holds it when one exists.
  const all = allRows().map(enrichSync).filter((x): x is Enriched => x != null);
  const clusters = sessionsOf(all);
  const ci = clusters.findIndex((hs) => hs.some((h) => h.dbId === dbId));
  const cluster = ci >= 0 ? clusters[ci]! : null;
  const recording = e.clientHandId ? recordingForHand(e.clientHandId) : null;
  const declaredId: string | null = typeof e.raw.sessionId === "string" ? e.raw.sessionId : null;
  const declared = declaredId ? sessionsStore.get(declaredId) : null;
  const session = cluster
    ? {
        index: ci + 1,
        start: cluster[0]!.playedAt,
        end: cluster[cluster.length - 1]!.playedAt,
        hands: cluster.length,
        position: cluster.findIndex((h) => h.dbId === dbId) + 1,
        stakes: cluster[0]!.stakes,
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
  });
});

/** Truncate an archived hand to the state BEFORE actions[upto]. */
export function truncateAt(hand: ParsedHand, upto: number): ParsedHand {
  const act = hand.actions[upto];
  const street = (act?.street ?? hand.street) as ParsedHand["street"];
  const boardLen = street === "flop" ? 3 : street === "turn" ? 4 : street === "river" ? 5 : 0;
  return {
    ...hand,
    actions: hand.actions.slice(0, upto),
    street,
    board: hand.board.slice(0, boardLen),
    ended: false,
    currentNode: { ...hand.currentNode, street, toActIsHero: act?.hero ?? false, complete: false },
  };
}

/** POST /open-gtow { dbId, upto } — navigate the GTO Wizard desktop client to
 *  this node's library /solutions URL (best effort; off-tree lines may snap). */
app.post("/open-gtow", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { dbId?: number; upto?: number };
  const d = openDb();
  if (!d) return c.json({ ok: false, error: "hands.db not found" }, 503);
  const row = d.query<HandRow, [number]>("SELECT rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data FROM hands WHERE rowid = ?").get(Number(b.dbId));
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

/** Sessions: consecutive hands with < 45 min gaps (shared with routes/sources). */
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

app.get("/stats", async (c) => {
  const rows = allRows();
  const enriched = (await Promise.all(rows.map(enrich))).filter((x): x is Enriched => x != null);
  const nets = computeNets(enriched);

  const sessions = sessionsOf(enriched);

  const agg = (hs: Enriched[]) => {
    const n = hs.length;
    const pct = (k: (s: HandSummary) => boolean, base?: (s: HandSummary) => boolean) => {
      const denom = base ? hs.filter((h) => base(h.summary)).length : n;
      const num = hs.filter((h) => k(h.summary) && (!base || base(h.summary))).length;
      return denom ? Math.round((1000 * num) / denom) / 10 : null;
    };
    const known = hs.map((h) => nets.get(h.dbId)).filter((x): x is number => x != null);
    const netBb = Math.round(known.reduce((s, x) => s + x, 0) * 100) / 100;
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
      limpedPots: pct((s) => s.limpedPot),
      netBb,
      netKnownHands: known.length,
      bb100: known.length ? Math.round((10000 * netBb) / known.length) / 100 : null,
      discrepancies: disc,
    };
  };

  const byStakes: Record<string, Enriched[]> = {};
  const byPos: Record<string, Enriched[]> = {};
  for (const e of enriched) {
    (byStakes[e.stakes ?? "?"] ??= []).push(e);
    (byPos[e.summary.heroPos ?? "?"] ??= []).push(e);
  }

  return c.json({
    auditPending: auditPending(),
    ok: true,
    overall: agg(enriched),
    byStakes: Object.fromEntries(Object.entries(byStakes).map(([k, v]) => [k, agg(v)])),
    byPosition: Object.fromEntries(Object.entries(byPos).map(([k, v]) => [k, agg(v)])),
    sessions: sessions
      .map((hs) => ({
        start: hs[0]!.playedAt,
        end: hs[hs.length - 1]!.playedAt,
        stakes: hs[0]!.stakes,
        ...agg(hs),
      }))
      .reverse(),
    answers: answerLog.stats(60),
  });
});

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
app.get("/answer-node", async (c) => {
  const dbId = Number(c.req.query("dbId"));
  const upto = Number(c.req.query("upto"));
  const answerId = c.req.query("answerId") ? Number(c.req.query("answerId")) : null;
  const d = openDb();
  if (!d || !Number.isFinite(dbId) || !Number.isFinite(upto)) return c.json({ ok: false, error: "dbId and upto required" }, 400);
  const row = d
    .query<HandRow, [number]>("SELECT rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data FROM hands WHERE rowid = ?")
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
      return { ...a, actionIndex, source: a.source ?? sourceForTier(a.tier) };
    })
    .filter((a) => (answerId != null ? a.id === answerId : a.actionIndex === upto && a.text))
    .pop() ?? null;
  const base = {
    ok: true as const, dbId, upto, street: t.street, heroPos, heroClass, heroCards: hand.heroCards, board: t.board,
    logged: logged
      ? { id: logged.id, chart: logged.chart, line: logged.line, tier: logged.tier, source: logged.source, exploitTag: logged.exploit_tag,
          strategyMode: logged.strategy_mode, pick: logged.pick, exploitPick: logged.exploit_pick, chartPick: logged.chart_pick,
          mesBoard: logged.mes_board, depth: logged.depth }
      : null,
  };

  if (t.street === "preflop") {
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
        note: node ? (snapped.length ? `sizes snapped to the tree, as the live answer did: ${snapped.map((x) => `${x.from}→${x.to}`).join(", ")}` : loggedLine && usedLine !== loggedLine ? "the logged line was not found; showing the raw line instead" : null)
          : "this line is not in the chart's tree as rebuilt from the archive — live, the sizes were snapped to the nearest tree sizes (answers logged since 2026-09-03 carry the snapped line)",
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


// ------------------------------------------------------------ stored AI-chain solves

/** 1326 weights → {class: {w, combos}} */
function classAgg(w: number[]): Record<string, { w: number; combos: number }> {
  const out: Record<string, { w: number; combos: number }> = {};
  for (let i = 0; i < COMBOS.length; i++) {
    const x = w[i] ?? 0;
    if (x <= 0) continue;
    const k = COMBOS[i]!.cls;
    (out[k] ??= { w: 0, combos: 0 }).w += x;
    out[k]!.combos++;
  }
  for (const k in out) out[k]!.w = Math.round(out[k]!.w * 1000) / 1000;
  return out;
}
/** actor range + per-action strategies → {class: {w, acts[]}} (acts = weight taking each action) */
function classStrategy(range: number[], strategies: number[][]): Record<string, { w: number; acts: number[] }> {
  const out: Record<string, { w: number; acts: number[] }> = {};
  for (let i = 0; i < COMBOS.length; i++) {
    const w = range[i] ?? 0;
    if (w <= 0) continue;
    const k = COMBOS[i]!.cls;
    const e = (out[k] ??= { w: 0, acts: new Array(strategies.length).fill(0) });
    e.w += w;
    for (let ai = 0; ai < strategies.length; ai++) e.acts[ai] += w * (strategies[ai]?.[i] ?? 0);
  }
  for (const k in out) { out[k]!.w = Math.round(out[k]!.w * 1000) / 1000; out[k]!.acts = out[k]!.acts.map((x) => Math.round(x * 1000) / 1000); }
  return out;
}
const tv = (a: number[], b: number[]): number => {
  const sa = a.reduce((s, x) => s + x, 0) || 1, sb = b.reduce((s, x) => s + x, 0) || 1;
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d += Math.abs((a[i] ?? 0) / sa - (b[i] ?? 0) / sb);
  return Math.round((d / 2) * 1000) / 1000;
};

/** Walk a stored trace and produce the per-node view the dashboard renders. */
function expandTrace(trace: any) {
  const spec = trace.spec ?? {};
  const heroIdx: number | null = spec.heroComboIdx ?? null;
  const heroCombo = heroIdx != null ? COMBOS[heroIdx]?.hand ?? null : null;
  const heroActor = spec.heroSeat === "oop" ? 0 : 1;
  const posOf = (actor: number) => (actor === 0 ? spec.oopPos : spec.ipPos) ?? (actor === 0 ? "OOP" : "IP");
  const streets = (trace.streets ?? []).map((st: any) => ({
    si: st.si, street: st.street, board: st.board, potIn: st.potIn, stackIn: st.stackIn, labels: st.labels,
    fixedLevels: st.fixedLevels, solId: st.solId, created: st.created,
    oopIn: classAgg(st.oopIn ?? []), ipIn: classAgg(st.ipIn ?? []),
    oopCombos: (st.oopIn ?? []).reduce((s: number, x: number) => s + x, 0), ipCombos: (st.ipIn ?? []).reduce((s: number, x: number) => s + x, 0),
  }));
  // replay the conditioning within each street from the stored entering ranges
  const cur: Record<number, { oop: number[]; ip: number[] }> = {};
  const nodes = (trace.nodes ?? []).map((n: any, i: number) => {
    const st = (trace.streets ?? []).find((x: any) => x.si === n.si);
    if (!cur[n.si]) cur[n.si] = { oop: (st?.oopIn ?? []).slice(), ip: (st?.ipIn ?? []).slice() };
    const r = cur[n.si]!;
    const actorRange = n.actor === 0 ? r.oop : r.ip;
    const strategies: number[][] = (n.actions ?? []).map((a: any) => a.strategy ?? []);
    const actorStrategy = classStrategy(actorRange, strategies);
    const rangesIn = { oop: classAgg(r.oop), ip: classAgg(r.ip) };
    const heroInActor = n.actor === heroActor && heroIdx != null;
    const heroRow = heroInActor
      ? (n.actions ?? []).map((a: any) => ({ name: a.name, betsize: a.betsize, p: Math.round((a.strategy?.[heroIdx!] ?? 0) * 1000) / 10, ev: a.evs?.[heroIdx!] ?? null }))
      : null;
    const heroWeightIn = heroIdx != null ? (n.actor === heroActor ? actorRange[heroIdx] ?? 0 : (heroActor === 0 ? r.oop : r.ip)[heroIdx] ?? 0) : null;
    let rangesOut: { oop: any; ip: any } | null = null;
    if (n.taken != null) {
      const strat = strategies[n.taken] ?? [];
      const next = actorRange.map((w, ci) => w * (strat[ci] ?? 0));
      if (n.actor === 0) r.oop = next; else r.ip = next;
      rangesOut = { oop: classAgg(r.oop), ip: classAgg(r.ip) };
    }
    return {
      i, si: n.si, ti: n.ti, street: n.street, board: n.board, codes: n.codes, actor: n.actor === 0 ? "oop" : "ip", actorPos: posOf(n.actor),
      potNode: n.potNode, invested: n.invested, heroNode: !!n.heroNode,
      actions: (n.actions ?? []).map((a: any) => ({ name: a.name, code: a.code, betsize: a.betsize, totalFrequency: a.totalFrequency, totalEv: a.totalEv })),
      taken: n.taken, takenName: n.taken != null ? n.actions?.[n.taken]?.name ?? null : null,
      takenOverallPct: n.taken != null && n.actions?.[n.taken]?.totalFrequency != null ? Math.round(n.actions[n.taken].totalFrequency * 1000) / 10 : null,
      rangesIn, rangesOut, actorStrategy, heroRow, heroWeightIn: heroWeightIn == null ? null : Math.round(heroWeightIn * 1000) / 1000,
    };
  });
  return {
    spec: { oopPos: spec.oopPos, ipPos: spec.ipPos, flopPot: spec.flopPot, flopStack: spec.flopStack, board: spec.board, streets: spec.streets,
            heroSeat: spec.heroSeat, heroCombo, heroComboIdx: heroIdx, rake: spec.rake ?? null, rangeSource: spec.rangeSource ?? null,
            oopRange: classAgg(spec.oopRange ?? []), ipRange: classAgg(spec.ipRange ?? []) },
    streets, nodes, result: trace.result ?? null,
  };
}

/** GET /solve/:id — a stored AI-chain solve, expanded for the walkthrough. */
app.get("/solve/:id", (c) => {
  const id = Number(c.req.param("id"));
  const got = solveStore.get(id);
  if (!got) return c.json({ ok: false, error: `no stored solve #${id}` }, 404);
  return c.json({ ok: true, row: got.row, ...expandTrace(got.trace) });
});

/** GET /solves?hand=<clientHandId> — stored solves for a hand (no blobs); no hand → the most recent. */
app.get("/solves", (c) => {
  const cid = c.req.query("hand");
  return c.json({ ok: true, stats: solveStore.stats(), solves: cid ? solveStore.forHand(cid) : solveStore.recent(50) });
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
    .query<HandRow, [number]>("SELECT rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data FROM hands WHERE rowid = ?")
    .get(Number(b.dbId));
  const e = row ? enrichSync(row) : null;
  if (!e) return c.json({ ok: false, error: `no hand #${b.dbId}` }, 404);
  const t = truncateAt(e.hand, Number(b.upto));
  const heroPos = e.summary.heroPos ?? null;
  // chart mode so the MES overlay does not short-circuit: the point is the chain
  const sol = await fastSolve({ ...t, currentNode: { ...t.currentNode, toActIsHero: true } }, heroPos, { heroPos, strategy: "chart", origin: "replay" });
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
    const out: Record<string, { oop: number[]; ip: number[] }> = {};
    const cur: Record<number, { oop: number[]; ip: number[] }> = {};
    for (const n of trace.nodes ?? []) {
      const st = (trace.streets ?? []).find((x: any) => x.si === n.si);
      if (!cur[n.si]) cur[n.si] = { oop: (st?.oopIn ?? []).slice(), ip: (st?.ipIn ?? []).slice() };
      const r = cur[n.si]!;
      out[`${n.street}|${n.codes.join("-")}`] = { oop: r.oop.slice(), ip: r.ip.slice() };
      if (n.taken != null) {
        const strat = n.actions?.[n.taken]?.strategy ?? [];
        const arr = n.actor === 0 ? r.oop : r.ip;
        const next = arr.map((w: number, ci: number) => w * (strat[ci] ?? 0));
        if (n.actor === 0) r.oop = next; else r.ip = next;
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
      rangeTv: { oop: tv(ra[k]?.oop ?? [], rb[k]?.oop ?? []), ip: tv(ra[k]?.ip ?? [], rb[k]?.ip ?? []) },
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

const DEBUG_DIR_FOR_SESSIONS = process.env.IGNITION_DEBUG_DIR ?? join(HANDS_DB, "..", "..", "debug");

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
  const tiers: Record<string, number> = {};
  for (const a of answered) tiers[a.tier ?? "unknown"] = (tiers[a.tier ?? "unknown"] ?? 0) + 1;
  const disagreements = answered.filter((a) => a.exploit_pick && a.chart_pick && a.exploit_pick !== a.chart_pick).length;
  const cfg = s.config ?? {};
  return {
    id: s.id, declared: true, startedAt: s.startedAt, endedAt: s.endedAt, preset: s.preset, label: s.label, note: s.note,
    answersOn: !!cfg.answers, mode: cfg.mode ?? null, recordingOn: !!cfg.recording, budget: cfg.budget ?? null,
    // the whole-hand strategy the session was declared with (services/strategies.ts id), when the mode was one
    strategy: cfg.strategy ?? null, strategyName: cfg.strategyName ?? null,
    hands: hands.length, knownHands: known.length, netBb, bb100: known.length ? Math.round((10000 * netBb) / known.length) / 100 : null,
    stakes: hands[0]?.stakes ?? null,
    answers: answered.length, failed: answers.length - answered.length, tiers, disagreements,
    solves: solveStore.forSession(s.id).length,
    recorded: fsExists(join(DEBUG_DIR_FOR_SESSIONS, s.id)),
    preflightOk: s.preflight?.ok ?? null, events: (s.events ?? []).length,
    durationMin: s.summary?.durationMin ?? (s.endedAt ? Math.round((s.endedAt - s.startedAt) / 6000) / 10 : Math.round((Date.now() - s.startedAt) / 6000) / 10),
  };
}

/** GET /sessions — declared sessions (newest first) plus the undeclared gap clusters of older hands. */
app.get("/sessions", (c) => {
  const all = allRows().map(enrichSync).filter((x): x is Enriched => x != null);
  const nets = computeNets(all);
  const declared = sessionsStore.list(200).map((s) => sessionCard(s, all, nets));
  const stamped = new Set(all.filter((e) => typeof e.raw?.sessionId === "string").map((e) => e.dbId));
  const clusters = sessionsOf(all.filter((e) => !stamped.has(e.dbId))).map((hs) => {
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

/** GET /sessions/:id — one declared session (or an undeclared cluster) in full. */
app.get("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const all = allRows().map(enrichSync).filter((x): x is Enriched => x != null);
  const nets = computeNets(all);
  const handRow = (e: Enriched) => ({
    dbId: e.dbId, clientHandId: e.clientHandId, playedAt: e.playedAt, stakes: e.stakes, heroCards: e.heroCards,
    heroPos: e.summary.heroPos, finalStreet: e.summary.finalStreet, potBb: e.summary.potBb, netBb: nets.get(e.dbId) ?? null,
    sawFlop: e.summary.sawFlop, answers: e.clientHandId ? (answerLog.forHand(e.clientHandId) as any[]).filter((a) => a.text).length : 0,
  });
  if (id.startsWith("cluster-")) {
    const start = Number(id.slice(8));
    const hs = sessionsOf(all).find((h) => h[0]!.playedAt === start);
    if (!hs) return c.json({ ok: false, error: "no such cluster" }, 404);
    return c.json({ ok: true, session: { id, declared: false, startedAt: hs[0]!.playedAt, endedAt: hs[hs.length - 1]!.playedAt, stakes: hs[0]!.stakes }, hands: hs.map(handRow).reverse(), answers: [], solves: [], recording: null });
  }
  const s = sessionsStore.get(id);
  if (!s) return c.json({ ok: false, error: `no declared session ${id}` }, 404);
  const hands = handsOfSession(all, id);
  const answers = answerLog.forSession(id);
  const recDir = join(DEBUG_DIR_FOR_SESSIONS, id);
  return c.json({
    ok: true,
    session: { ...sessionCard(s, all, nets), config: s.config, preflight: s.preflight, versions: s.versions, eventsList: s.events, summary: s.summary },
    hands: hands.map(handRow).reverse(),
    answers: answers.map((a) => ({ id: a.id, ts: a.ts, clientHandId: a.client_hand_id, street: a.street, board: a.board, heroCards: a.hero_cards, tier: a.tier, source: a.source ?? sourceForTier(a.tier), text: a.text, pick: a.pick, exploitPick: a.exploit_pick, chartPick: a.chart_pick, strategyMode: a.strategy_mode, latencyMs: a.latency_ms, failReason: a.fail_reason, solveId: a.solve_id })).reverse(),
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
 * (exploit overlay / 3-max chart preflop, MES overlay postflop), the poller's
 * rollAction rolls the mix ONCE and buildAnswerText writes the panel line.
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
  const rolled = (sol.decision.frequency ?? 0) >= 99 ? { pick: sol.decision.action, roll: null } : rollAction(sol.actions, sol.decision.action);
  const text = (sol.approx ? "≈ " : "") + buildAnswerText({ street, decision: sol.decision, actions: sol.actions }) + (rolled.roll != null ? ` · roll ${rolled.roll} → ${rolled.pick.toUpperCase()}` : "");
  return c.json({ ok: true, answer: { ...base, text, pick: rolled.pick, roll: rolled.roll, tier: sol.tier ?? (street === "preflop" ? "local-preflop" : null), warning: sol.warning ?? null, fail_reason: null }, hand });
});

/**
 * GTO Wizard AI client — the postflop fallback for everything the MES overlay
 * does not cover, so its state must be loud. GET /gtow-status is cheap (one
 * CDP probe, no sniff); POST /gtow-connect launches the desktop client with
 * the debug port (services/gtowCdp.launchApp, the twin of
 * scripts/start_gtow_ai.ps1) and waits for a token, up to ~60 s.
 */
async function gtowStatus() {
  const cdpHost = process.env.GTOW_CDP_HOST ?? "127.0.0.1:9222";
  const t0 = Date.now();
  let clientUp = false, browser: string | null = null;
  try {
    const r = await fetch(`http://${cdpHost}/json/version`, { signal: AbortSignal.timeout(1500) });
    clientUp = r.ok;
    try { browser = ((await r.json()) as any)?.Browser ?? null; } catch { /* not json */ }
  } catch { clientUp = false; }
  const t = gtowApi.tokenStatus();
  return {
    ok: true as const, clientUp, cdpHost, browser, probeMs: Date.now() - t0,
    tokenLive: t.live, expiresInMs: t.expiresInMs, keeperRunning: t.keeperRunning, lastAttemptMs: t.lastAttemptMs,
    usable: t.live,
    state: t.live ? "up" : clientUp ? "no-token" : "down",
    text: t.live ? `token live, ${Math.max(0, Math.round((t.expiresInMs ?? 0) / 60000))} min left` : clientUp ? "client reachable but no token — is GTO Wizard logged in and unlocked?" : "GTO Wizard client is not running with its debug port",
  };
}
app.get("/gtow-status", async (c) => c.json(await gtowStatus()));
app.post("/gtow-connect", async (c) => {
  const t0 = Date.now();
  const launch = await gtowCdp.launchApp();
  // wait for the debug port, then for a token (the sniff needs the client's page up)
  let live = false;
  for (let i = 0; i < 30 && !live; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await gtowStatus();
    if (!st.clientUp) continue;
    live = await gtowApi.forceRefresh();
  }
  const st = await gtowStatus();
  return c.json({ ...st, launch, waitedMs: Date.now() - t0, connected: live,
    hint: live ? null : st.clientUp ? "the client is up but no token came back — log in to GTO Wizard in the client window (it was started minimized) and try again" : "the client did not come up — start it by hand: scripts/start_gtow_ai.ps1" });
});
