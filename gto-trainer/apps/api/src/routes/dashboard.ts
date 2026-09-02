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
import { preflopPotStack } from "../utils/aiStudyLine/aiStudyLine";
import { wagerLabelForWalk } from "../utils/aiChainTokens/aiChainTokens";
import { answerLog } from "../services/answerLog";
import { getCatalog } from "../services/chartCatalog";
import { gtowCdp } from "../services/gtowCdp";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { readFileSync } from "node:fs";
import { buildPreflopTokens3max } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { mesBoardFor, mesFamilyFor } from "../services/mesPostflop";

/**
 * Study dashboard backend: reads the wrapper's hand archive (hands.db),
 * decorates every hand with H2N-style facts (utils/handSummary), the
 * feed-spot discrepancy audit, the study answers that were pushed live
 * (services/answerLog), and best-effort net bb; serves per-node solution
 * requests by translating an archived hand prefix into an /api/ai-study body
 * (per-street AI chain semantics — same solver the live answers use).
 *
 * The archive is written by ignition-study-wrapper (Python, WAL); we read it
 * readonly. Rows are immutable once written, so summaries and audits are
 * cached by rowid for the life of the process.
 */

const HANDS_DB =
  process.env.HANDS_DB_PATH ??
  join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper", "data", "hands.db");
const SELF = () => `http://localhost:${process.env.PORT || 2000}`;
/** Gap that splits two hands into different sessions. */
const SESSION_GAP_MS = 45 * 60_000;

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

interface Enriched {
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

async function enrich(row: HandRow): Promise<Enriched | null> {
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
  // Discrepancy audit — local computation (charts only, no cloud); null when
  // the audit route itself can't make sense of the hand.
  let discrepancies: Enriched["discrepancies"] = null;
  try {
    const res = await fetch(`${SELF()}/api/feed-spot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hand: raw }),
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await res.json().catch(() => null);
    if (j?.ok) discrepancies = j.discrepancies ?? [];
  } catch {
    /* audit unavailable — leave null */
  }
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
    discrepancies,
  };
  cache.set(row.rowid, e);
  return e;
}

const allRows = (): HandRow[] => {
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
  for (const r of rows) {
    const m = r.data.match(/"clientHandId":\s*"(\d+)"/);
    if (!m) { out.push(r); continue; }
    const prev = bySite.get(m[1]!);
    if (prev) out.splice(out.indexOf(prev), 1);
    bySite.set(m[1]!, r);
    out.push(r);
  }
  return out;
};

/**
 * Best-effort net bb per hand:
 *  - uncontested win → pot minus hero's own contribution
 *  - hero folded → minus hero's contribution
 *  - showdown → hero stack difference to the NEXT hand in the same session
 *    (accepted only when the delta is plausible for the pot), else null.
 */
function computeNets(hands: Enriched[]): Map<number, number | null> {
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

app.get("/hands", async (c) => {
  const rows = allRows();
  const enriched = (await Promise.all(rows.map(enrich))).filter((x): x is Enriched => x != null);
  const nets = computeNets(enriched);
  const hands = enriched
    .map((e) => ({
      dbId: e.dbId,
      handId: e.handId,
      clientHandId: e.clientHandId,
      playedAt: e.playedAt,
      stakes: e.stakes,
      heroCards: e.heroCards,
      netBb: nets.get(e.dbId) ?? null,
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
  return c.json({ ok: true, total: hands.length, hands });
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
  const e = await enrich(row);
  if (!e) return c.json({ ok: false, error: "hand blob unreadable" }, 500);
  const answers = e.clientHandId ? answerLog.forHand(e.clientHandId) : [];
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
  });
});

/** Truncate an archived hand to the state BEFORE actions[upto]. */
function truncateAt(hand: ParsedHand, upto: number): ParsedHand {
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

/**
 * POST /node-solution { dbId, upto } — the archived hand truncated before
 * actions[upto], translated into an /api/ai-study body (snapped preflop line,
 * engine-label postflop tokens with dealt cards inline) and solved with the
 * chain's conditioned ranges. Returns ai-study's response verbatim plus the
 * node descriptor, so the UI can render the 169-grid.
 */
app.post("/node-solution", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { dbId?: number; upto?: number };
  const d = openDb();
  if (!d) return c.json({ ok: false, error: "hands.db not found" }, 503);
  const row = d.query<HandRow, [number]>("SELECT rowid, hand_id, played_at, stakes, street, result_text, hero_cards, action_count, data FROM hands WHERE rowid = ?").get(Number(b.dbId));
  if (!row) return c.json({ ok: false, error: `no hand #${b.dbId}` }, 404);
  const e = await enrich(row);
  if (!e) return c.json({ ok: false, error: "hand blob unreadable" }, 500);
  const upto = Math.max(0, Math.min(Number(b.upto ?? e.hand.actions.length), e.hand.actions.length));
  const node = truncateAt(e.hand, upto);
  if (node.street === "preflop") return c.json({ ok: false, error: "preflop nodes use the chart viewer, not the AI chain" }, 400);

  const heroPost = node.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  const heroPos = node.positions[node.heroSeatId] ?? (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);
  const set = resolveSet(node, heroPos, undefined);
  if (!set) return c.json({ ok: false, error: "no solution set for this hand" }, 400);
  const isHu = set.seats.length === 2;
  const depth = resolveDepth(node, set.depths?.length ? set.depths : [100], undefined);
  if (!preflopDb.available(set.gametype, depth)) {
    return c.json({ ok: false, error: `no charts for ${set.gametype}@${depth} — can't reconstruct ranges` }, 422);
  }
  let pre = isHu ? buildPreflopTokensHu(node, heroPos) : buildPreflopTokens(node, heroPos);
  const snapped = snapPreflopLine(pre, (line) => preflopDb.rawNode(set.gametype, depth, line));
  if (!snapped.ok) return c.json({ ok: false, error: `preflop line unwalkable: ${snapped.reason}` }, 422);
  pre = snapped.tokens;

  const tk = buildSpotSolutionTokens(node, heroPos, isHu);
  const boardCards = tk.board.match(/.{2}/g) ?? [];
  const { stack: flopStack } = preflopPotStack(pre, depth);
  // engine tokens with dealt cards inline, streets up to the node's street
  const perStreet = [tk.flop, tk.turn, tk.river];
  const nStreets = node.street === "flop" ? 1 : node.street === "turn" ? 2 : 3;
  const tokens: string[] = [];
  try {
    for (let si = 0; si < nStreets; si++) {
      if (si > 0) tokens.push(boardCards[2 + si]!);
      tokens.push(...wagerLabelForWalk(perStreet[si]!, flopStack));
    }
  } catch (err) {
    return c.json({ ok: false, error: `tokens: ${err instanceof Error ? err.message : err}` }, 422);
  }

  // The EXACT body handed to the AI solver — surfaced in the UI so the inputs
  // behind every verdict are inspectable, not implied.
  const aiRequest = {
    preflop: pre.join("-"),
    board: boardCards.slice(0, 2 + nStreets),
    tokens,
    gametype: set.gametype,
    depth,
  };
  const res = await fetch(`${SELF()}/api/ai-study`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(aiRequest),
    signal: AbortSignal.timeout(120_000),
  });
  const j: any = await res.json().catch(() => null);
  if (!j) return c.json({ ok: false, error: `ai-study returned non-JSON (HTTP ${res.status})` }, 502);
  return c.json({
    ...j,
    request: aiRequest,
    node: { street: node.street, board: boardCards.slice(0, 2 + nStreets), upto, heroCards: node.heroCards, heroPos },
  });
});

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

app.get("/stats", async (c) => {
  const rows = allRows();
  const enriched = (await Promise.all(rows.map(enrich))).filter((x): x is Enriched => x != null);
  const nets = computeNets(enriched);

  // sessions: consecutive hands with < 45min gaps
  const sessions: Enriched[][] = [];
  for (const e of enriched) {
    const last = sessions[sessions.length - 1];
    if (last && e.playedAt != null && last[last.length - 1]!.playedAt != null &&
        e.playedAt - last[last.length - 1]!.playedAt! < SESSION_GAP_MS) last.push(e);
    else sessions.push([e]);
  }

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

app.get("/mes-value", async (c) => {
  let corpus: any = null;
  try { corpus = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "mes_reach_value.json"), "utf-8")); } catch {}

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
    ladder: LADDER,
    corpus,
    live: { hands: liveHands, flops: liveFlops, families: liveFam, total_uplift_bb100: Math.round(liveTotal * 1000) / 1000 },
    caveats: [
      "Postflop uplift is raw model value vs the tilted-pool model (v3, control ≈ 0); no execution haircut applied.",
      "ev_gain is per ARRIVAL at the flop root and includes all later streets; hero must play the MES continuation to realize it.",
      "Ladder numbers price postflop at the solver floor, so the true total is ladder + some fraction of the postflop uplift, not their sum.",
    ],
  });
});

export default app;
