import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { answerLog, sourceForTier, type LoggedAnswer } from "../services/answerLog";
import { sameAction, heroActionAt } from "../services/adherence";
import { getCatalog } from "../services/chartCatalog";
import { mesPostflopInfo, mesSpots, mesFlopNode, mesTurnLines, mesTurnNode } from "../services/mesPostflop";
import { extractLine } from "../services/mesRiver";
import { fetchNode } from "../services/hrc3max";
import { hrc6maxDb } from "../services/hrc6maxDb";
import { evaluate as evaluateStrategies, strategyIdForAnswer, canonicalStrategyId, PIECES, STRATEGIES, FULL_EXPLOIT_ID } from "../services/strategies";
import { sessionsStore } from "../services/sessionsStore";
import { gtowApi } from "../services/gtowApi";
import { gtowSessions } from "../services/gtowSessions";
import { HRC3MAX_BASE } from "../services/hrc3max";
import { missQueue } from "../services/missQueue";
import { APPROXIMATIONS, type Approximation } from "../services/approximations";
import { STRATEGY_COVERAGE } from "../services/strategyCoverage";
import { workQueue } from "../services/strategyQueue";
import { patchJobs } from "../services/patchJobs";
import { formatsForSource, chartsLanded } from "../services/ledger";
import { studyPoller } from "../services/studyPoller";
import { DEFAULT_LIVE_URL } from "./ingest";
import {
  HANDS_DB, allRows, enrichSync, computeNets, sessionsOf, type Enriched,
} from "./dashboard";

/**
 * Sources — the study dashboard's mission control.
 *
 *   /registry   every data source a Study Answer can come from: armed or
 *               not (env + live probes), freshness, generation, what it
 *               routes for, and the answers it produced recently.
 *   /matrix     the strategy matrix: whole-hand strategy combinations priced
 *               under each rake model, from the analysis artifacts
 *               (data/strategy_matrix.json, built by
 *               analysis/pipeline/limp_study/strategy_matrix.py) plus the
 *               realized bb/100 of hero's own sessions split by the strategy
 *               mode that was active.
 *   /grading    live grading: every logged answer joined to the archived
 *               hand — MES pick vs GTO pick, whether they disagreed, bb at
 *               stake, and what hero actually did.
 *   /roadmap    what is built, what is not, and what each item would reach.
 *   /approximations
 *               every place the strategy is knowingly not exact, in ONE list,
 *               each joined to how often it actually fires (miss-queue rows
 *               and live hits, answer-warning counts) so they can be ranked.
 *               The register itself is services/approximations.ts.
 */

const DATA_DIR = join(import.meta.dir, "..", "..", "data");
const LIMP_DIR = join(DATA_DIR, "..", "..", "..", "..", "analysis", "pipeline", "limp_study");
const app = new Hono();

// ------------------------------------------------------------------ helpers

const readJson = (path: string): any | null => {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
};
const fileInfo = (path: string) => {
  try { const st = statSync(path); return { exists: true, mtimeMs: st.mtimeMs, sizeBytes: st.size }; }
  catch { return { exists: false, mtimeMs: null as number | null, sizeBytes: null as number | null }; }
};

async function probe(url: string, timeoutMs: number): Promise<{ ok: boolean; ms: number; status: number | null; body: any }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body: any = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { ok: res.ok, ms: Date.now() - t0, status: res.status, body };
  } catch {
    return { ok: false, ms: Date.now() - t0, status: null, body: null };
  }
}

/** The pool model in force: POOL_MODEL when a launcher names it (the NL25 cutover
 *  points it at pool_model_nl25.json), else the v4 default — the same rule
 *  services/ledger.ts and services/strategies.ts follow. */
const poolModelPath = (): string => process.env.POOL_MODEL ?? join(LIMP_DIR, "pool_model_v4.json");

const sqliteCount = (path: string, sql: string): number | null => {
  try {
    const db = new Database(path, { readonly: true });
    try { return (db.query<{ n: number }, []>(sql).get()?.n) ?? null; } finally { db.close(); }
  } catch { return null; }
};

// ----------------------------------------------------------------- registry

export interface SourceCard {
  id: string;
  label: string;
  mode: "mes" | "gto" | null;
  /** good = armed and reachable, warn = armed with a caveat, crit = expected but down, off = standby/unarmed */
  state: "good" | "warn" | "crit" | "off";
  stateText: string;
  tiers: string[];
  routes: string;
  facts: [string, string][];
  caveats: string[];
  answers30d: number;
  p50Ms: number | null;
  lastTs: number | null;
  byDay: number[];
  drilldown: "charts" | "boards" | "log" | "exploit" | null;
  /** answers.sqlite `source` value(s) this card owns — the detail view's answer trail filter. */
  sourceKeys?: string[];
  /** which piece of a whole-hand strategy this source serves (services/strategies.ts PIECES) */
  piece?: "preflop" | "postflop" | "opponent" | "ground-truth";
  /** every role it plays (a source can serve two pieces) — the Type chips */
  pieces?: string[];
  /** the formats it is valid for — ONE entry per full combination (site · seats · stake · depth);
   *  a source valid at two stakes lists two formats. `note` = a caveat on that format only. */
  formats?: { site: string; seats: string; stake: string; depth: string; note?: string; ledgerId?: string }[];
  /** what it covers, with the gap named */
  coverage?: { text: string; gap: string | null };
  /** its edge in bb/100 from the strategy matrix, attributed to this piece */
  edge?: { nl25: number | null; nl200: number | null; norake: number | null; kind: "floor" | "gain" | "increment" | "construction" | "none"; note: string } | null;
  /** primary = first in tier order for its piece; fallback = only reached when the primary can't answer */
  role?: "primary" | "fallback" | null;
}

/**
 * The five things every card answers — Type, Edge, Formats, Coverage, Usage
 * (Brady, 2026-09-07). Edge is READ from the strategy matrix, not typed in;
 * coverage gaps come from the miss queue and the reach file, so they move
 * with the data. "Where it lives" (paths, sizes, env) stays in `facts` for
 * the detail page only.
 */
function attributeCards(cards: SourceCard[], ctx: { mes: ReturnType<typeof mesPostflopInfo>; exploit: any }): void {
  // formats are the LEDGER's (data/ledger.json → sources map); a per-format note is the card's own
  const fmts = (cardId: string, notes: Record<string, string>) => formatsForSource(cardId).map((f) => ({
    site: f.site, seats: f.seats === 2 ? "heads-up" : `${f.seats}-handed`, stake: f.stake,
    depth: f.depths.length > 1 ? `${Math.min(...f.depths)}–${Math.max(...f.depths)}bb` : f.depths.length === 1 ? `${f.depths[0]}bb` : "any",
    note: [f.rake ? `rake ${Math.round(f.rake.pct * 100)}%, cap ${f.rake.capBb}bb` : null, notes[f.id] ?? null].filter(Boolean).join(" · ") || undefined,
    ledgerId: f.id,
  }));
  const st60 = answerLog.stats(60) as { answered: number; failed: number };
  const matrix = readJson(join(DATA_DIR, "strategy_matrix.json"));
  const rows: Record<string, any> = {};
  for (const g of matrix?.groups ?? []) for (const r of g.rows ?? []) rows[r.id] = r;
  const cell = (id: string, k: string): number | null => { const v = rows[id]?.cells?.[k]?.v; return typeof v === "number" ? v : null; };
  const eq = { nl25: cell("eq_eq", "nl25"), nl200: cell("eq_eq", "nl200"), norake: cell("eq_eq", "norake") };
  const ex = { nl25: cell("ex_eq", "nl25"), nl200: cell("ex_eq", "nl200"), norake: cell("ex_eq", "norake") };
  const mesRow = rows["combined_refit"] ? "combined_refit" : "combined_served";
  const mx = { nl25: cell(mesRow, "nl25"), nl200: cell(mesRow, "nl200"), norake: cell(mesRow, "norake") };
  const f1 = (x: number | null) => x == null ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(1)}`;
  const reach = readJson(join(DATA_DIR, "mes_reach_value.json"));
  const fams = ctx.mes.families;
  const arrival = Object.values((reach?.families ?? {}) as Record<string, any>).reduce((s, f: any) => s + (Number(f?.arrival_pct_of_hands) || 0), 0);
  const mq = missQueue.stats();
  const openMiss = (mq.byStatus?.open ?? 0) + (mq.byStatus?.queued ?? 0);
  const beyond = mq.byKind?.["beyond-ladder"] ?? 0;
  const sizeGaps = (mq.byKind?.["size-snapped"] ?? 0) + (mq.byKind?.["size-off-tree"] ?? 0);
  const catalog = getCatalog();
  const asym = catalog.entries.filter((e: any) => e.family === "3max-asym").length;
  const manifest = readJson(join(DATA_DIR, "resolved-charts.json")) ?? {};
  const resolvedRungs = Object.values(manifest as Record<string, number[]>).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
  const choices = ctx.exploit?.choices ? Object.keys(ctx.exploit.choices).length : 0;
  const poolN = (() => { try { const pm = readJson(poolModelPath()); const n = pm?.n ?? {}; return Object.values(n as Record<string, number>).reduce((s, x) => s + (Number(x) || 0), 0); } catch { return 0; } })();
  const A: Record<string, Partial<SourceCard>> = {
    "exploit-preflop": {
      pieces: ["preflop"],
      // the note names the chart the armed export was actually fit to — since the
      // NL25 cutover (2026-09-14) that is the ign25 grid at the real 4bb cap
      formats: fmts("exploit-preflop", { "ign-zone-3max-nl25": String(ctx.exploit?.chart ?? "").startsWith("ign25")
        ? "fitted at the NL25 rake (ign25 grid, 5% / cap 4bb); reused as an approximation at other depths"
        : "fitted at NL200 rake (kept, see Strategies); reused as an approximation at other depths" }),
      coverage: { text: `${choices || 5} first-decision nodes at 100bb: BTN open, SB vs open, SB bvb open, BB vs open, BB vs SB`, gap: "nothing past hero's first decision — facing a 4-bet, limp lines and every other depth fall to the equilibrium chart; locked-root charts are the planned fix" },
      edge: { ...ex, kind: "gain", note: `whole-hand vs the equilibrium floor (${f1(eq.nl25)} at NL25 rake) with postflop priced at the floor` },
    },
    "hrc-3max": {
      pieces: ["preflop", "opponent"],
      formats: fmts("hrc-3max", { "ign-3max-nl200": "asymmetric stacks", "ign-3max-nl500": "asymmetric stacks" }),
      coverage: { text: `${asym} charts · 21 depth rungs · ${resolvedRungs} rungs re-solved with river betting`, gap: openMiss ? `${openMiss} open items in the miss queue: ${beyond} past the 150bb rung, ${sizeGaps} size gaps (SB 3.9x open)` : "no open misses" },
      edge: { ...eq, kind: "floor", note: "equilibrium everywhere — the maximin floor every exploit is measured from" },
    },
    "hrc-6max": {
      pieces: ["preflop", "opponent"],
      formats: fmts("hrc-6max", { "ign-6max-nl200": "solving — our own rake (2bb cap with six dealt), not the NL500 library's 0.6bb" }),
      coverage: (() => { const cl = chartsLanded(["grid-6max-nl200", "grid-6max-nl200-asym"]);
        return { text: `${cl.have} of ${cl.want} charts solved · 30 even-stack trees + 36 uneven ones at 30–150bb`,
          gap: cl.complete ? "no pool model at six seats — the exploit layer is 3-handed only, so ring spots get the equilibrium mix"
            : `${cl.want - cl.have} charts still on the boxes — those spots fall down the picker's preference list until they land` }; })(),
      edge: { nl25: null, nl200: null, norake: null, kind: "none", note: "no row yet — the 6-max equilibrium has not been backtested against a corpus (matrix row eq_eq_6max is unbuilt)" },
    },
    "hrc-hu": {
      pieces: ["preflop", "opponent"],
      formats: fmts("hrc-hu", { "cp-hu-nl200": "CoinPoker's heads-up structure: ante 0.2bb, 5% / cap 0.9bb" }),
      coverage: (() => { const cl = chartsLanded(["grid-cp200hu"]);
        return { text: `${cl.have} of ${cl.want} charts · 18 depths 20–150bb × 7-8 open/3-bet trees`,
          gap: "4-bet and later sizes, and depths between rungs, are snapped; nothing past 150bb" }; })(),
      edge: { nl25: null, nl200: null, norake: null, kind: "none", note: "no row yet — the heads-up equilibrium has not been backtested (matrix row eq_eq_hu_cp200 is unbuilt)" },
    },
    "gtow-charts": {
      pieces: ["preflop"],
      formats: fmts("gtow-charts", { "gtow-6max-nl500": "no 200bb", "gtow-hu-nl500": "no 200bb" }),
      coverage: { text: "27 gametype × depth pairs, crawled", gap: "3-handed spots only when :8777 is down (wrong rake, no limps) — flagged approximate" },
      edge: { nl25: null, nl200: null, norake: null, kind: "none", note: "fallback only — no row of its own" },
    },
    "mes-postflop": {
      pieces: ["postflop"],
      formats: fmts("mes-postflop", { "ign-zone-3max-nl25": "single-raised pots, heads-up on the flop" }),
      coverage: { text: `${fams.length} families × ${fams[0]?.boards.length ?? 14} boards · ${arrival.toFixed(1)}% of hands arrive (corpus)`, gap: "flop + turn stored, rivers from the trees on demand; every other postflop line goes to the AI chain" },
      edge: { ...mx, kind: "increment", note: `exploit preflop + MES flops, refit; ${f1(mx.nl25 != null && ex.nl25 != null ? mx.nl25 - ex.nl25 : null)} over exploit-preflop-only at NL25 — raw model value, no execution haircut` },
    },
    "gtow-ai": {
      pieces: ["postflop"],
      formats: fmts("gtow-ai", { "any-hu-postflop": "GTO Wizard cloud solve per spot; rake as solved" }),
      coverage: { text: "every postflop spot the MES does not cover — per-street re-solve from the flop-entering ranges", gap: "client must be up with a token; 3-way flops are not solved" },
      edge: { nl25: 0, nl200: 0, norake: 0, kind: "construction", note: "priced at the floor by construction — unexploitable, villain's postflop mistakes count for zero" },
    },
    "gtow-library": {
      pieces: ["postflop"],
      formats: fmts("gtow-library", {}),
      coverage: { text: "standby — last resort when both AI paths fail", gap: null },
      edge: { nl25: null, nl200: null, norake: null, kind: "none", note: "fallback only" },
    },
    "pool-model": {
      pieces: ["opponent"],
      formats: fmts("pool-model", { "ign-zone-3max-nl25": "measured on $0.10–$2 blinds, 68% at 25NL" }),
      coverage: { text: `${poolN.toLocaleString()} measured decisions across 7 preflop spots + 10 calling contexts`, gap: "fold-vs-3-bet reads are thin (n≈266 / 170) and shrunk 1.5 SE before use" },
      edge: { nl25: null, nl200: null, norake: null, kind: "none", note: `no edge of its own — the exploit preflop (${f1(ex.nl25)}) and MES (${f1(mx.nl25)}) rows both rest on it` },
    },
    log: {
      pieces: ["ground-truth"],
      formats: [],
      coverage: { text: `${st60.answered} answered · ${st60.failed} failed in 60 days`, gap: null },
      edge: null,
    },
  };
  for (const c of cards) Object.assign(c, A[c.id] ?? {});
}

const PIECE_OF: Record<string, { piece: SourceCard["piece"]; role: SourceCard["role"] }> = {
  "exploit-preflop": { piece: "preflop", role: "primary" },
  "hrc-3max": { piece: "preflop", role: "primary" },
  "hrc-6max": { piece: "preflop", role: "primary" },
  "hrc-hu": { piece: "preflop", role: "primary" },
  "gtow-ai-preflop": { piece: "preflop", role: "fallback" },
  "gtow-charts": { piece: "preflop", role: "fallback" },
  "mes-postflop": { piece: "postflop", role: "primary" },
  "gtow-ai": { piece: "postflop", role: "primary" },
  "gtow-library": { piece: "postflop", role: "fallback" },
  "pool-model": { piece: "opponent", role: "primary" },
  log: { piece: "ground-truth", role: null },
};

const SOURCE_KEYS: Record<string, string[]> = {
  "exploit-preflop": ["pool-exploit-preflop"],
  "hrc-3max": ["hrc-3max-preflop"],
  "hrc-6max": ["hrc-6max-preflop"],
  "hrc-hu": ["hrc-hu-preflop"],
  "gtow-ai-preflop": ["gtow-ai-preflop"],
  "gtow-charts": ["local-preflop"],
  "mes-postflop": ["mes-postflop"],
  "gtow-ai": ["gtow-api-postflop"],
  "gtow-library": ["gtow-api-postflop"],
  "pool-model": [],
  log: [],
};

app.get("/registry", async (c) => {
  const log = answerLog.bySource(30);
  const tally = (src: string) => log.sources[src] ?? { n: 0, p50: null, lastTs: null, byDay: new Array(30).fill(0) };

  // --- live probes, in parallel, short timeouts ---
  const cdpHost = process.env.GTOW_CDP_HOST ?? "127.0.0.1:9222";
  const [hrc, cdp, wrapper] = await Promise.all([
    // /api/progress is a 2-byte reply; /api/solutions lists 1,300 charts and
    // stalls behind a running batch on the single-threaded server.
    probe(`${HRC3MAX_BASE}/api/progress`, 2500),
    probe(`http://${cdpHost}/json/version`, 1200),
    // 4 s, not 1.5: the wrapper's /state calls cdp.available on the table
    // window's debug port, and a port with NOTHING listening costs the full
    // 2 s urlopen timeout on Windows (a dropped SYN, not a refusal). So
    // between sessions — exactly when you open mission control to check
    // whether the rig is ready — a live wrapper reported "not reachable"
    // (2026-09-13). Once a session is up, CDP answers and /state is ~30 ms.
    probe(`${DEFAULT_LIVE_URL}/state?light=1`, 4000),
  ]);

  // --- files ---
  const exploitPath = process.env.EXPLOIT_CHART ?? null;
  const exploitFile = exploitPath ? fileInfo(exploitPath) : { exists: false, mtimeMs: null, sizeBytes: null };
  const exploit = exploitPath && exploitFile.exists ? readJson(exploitPath) : null;
  const mes = mesPostflopInfo();
  const preflopDbPath = join(DATA_DIR, "preflop-db.sqlite");
  const preflopDb = fileInfo(preflopDbPath);
  const manifest = readJson(join(DATA_DIR, "resolved-charts.json"));
  const catalog = getCatalog();
  const hrcCount = catalog.entries.filter((e) => e.source === "hrc" && e.family === "3max-asym").length;
  const gtowPairs = catalog.entries.filter((e) => e.source === "gtow").length;
  const hands = fileInfo(HANDS_DB);
  const handRows = hands.exists ? sqliteCount(HANDS_DB, "SELECT COUNT(*) n FROM hands") : null;
  const answersFile = fileInfo(answerLog.dbPath);
  const token = gtowApi.tokenStatus();
  // PROBE each session rather than trusting the cached view: without a CDP
  // probe a token-less session cannot be told from a session whose client is
  // not running, and the wrapper's preflight would tell Brady "nothing
  // listening" about a client that is up and merely signed out.
  const tokenSessions = await gtowSessions.statusProbed();
  const pollerStatus = studyPoller.getStatus();
  const liveStrategyId = studyPoller.strategyId;

  const fmtAge = (ms: number | null) => ms == null ? "unknown" : new Date(ms).toISOString();

  const cards: SourceCard[] = [];

  // 1. pool-exploit preflop overlay
  {
    const t = tally("pool-exploit-preflop");
    const armed = !!exploitPath && exploitFile.exists;
    const choices = exploit?.choices ? Object.keys(exploit.choices) : [];
    const ranges = exploit?.ranges ? Object.keys(exploit.ranges) : [];
    cards.push({
      id: "exploit-preflop", label: "3-handed Zone 25NL preflop exploit charts", mode: "mes",
      state: armed ? "good" : "off",
      stateText: armed ? "Armed" : exploitPath ? "Env set, file missing" : "Not armed",
      tiers: ["exploit-3max", "hero flop ranges → ai-chain"],
      routes: `3-handed preflop, first decision at ${choices.length || 5} nodes: ${choices.join(", ") || "btn_root, sb_vs_open, bb_vs_open, sb_bvb, bb_vs_sb"}`,
      facts: [
        ["file", exploitPath ?? "EXPLOIT_CHART not set"],
        ["fit to", exploit?.chart ? `chart ${exploit.chart}` : "—"],
        ["ranges", ranges.length ? `${ranges.length} derived range sets` : "—"],
        ["freshness", exploitFile.mtimeMs ? fmtAge(exploitFile.mtimeMs) : "—"],
        ["armed by", "EXPLOIT_CHART in .claude/study-api.ps1 (the StudyAPI supervisor), .claude/dev-api.cmd and scripts/start_gtow_ai.ps1 — all three name the same file"],
        ["feeds MES", mes.families.filter((f) => f.inputs).map((f) => `${f.id.split("_")[0]} ← ${f.inputs!.hero_range.key}`).join(" · ") || "—"],
      ],
      caveats: [
        "one 100bb ign200 state, reused at every stake",
        "loaded once per process — a re-derived file needs an API restart",
        "the MES flop solves are conditioned on these ranges — refit here, then re-run the MES batch (the MES card checks the two agree)",
      ],
      answers30d: t.n, p50Ms: t.p50, lastTs: t.lastTs, byDay: t.byDay, drilldown: "exploit",
    });
  }

  // 2. HRC 3-max asymmetric grid via :8777
  {
    const t = tally("hrc-3max-preflop");
    const resolved = manifest ? Object.entries(manifest as Record<string, number[]>).map(([site, rungs]) => `${site}: ${rungs.length}`).join(" · ") : "—";
    cards.push({
      id: "hrc-3max", label: "HRC 3-max asymmetric grid", mode: "gto",
      state: hrc.ok ? "good" : "crit",
      stateText: hrc.ok ? `Up · ${hrc.ms} ms` : `:8777 unreachable (${hrc.ms} ms)`,
      tiers: ["chart-3max", "villain ranges → ai-chain"],
      routes: "3-handed preflop when BTN/SB/BB are present · rung by canonical stacks · stake → ign200 below 350¢ BB, ign500 above",
      facts: [
        ["served by", `${HRC3MAX_BASE} · bodies r2://poker-solve-db/hrc-ui`],
        ["charts", `${hrcCount} asym charts in the catalog · ${catalog.summary.routed} live-routed`],
        ["re-solved rungs", `${resolved} (resolved-charts.json${process.env.RESOLVED_OFF ? ", RESOLVED_OFF set" : ""})`],
        ["sidecars", catalog.summary.solutionsDir ?? "solutions dir not found"],
      ],
      caveats: [
        "grid solved at the NL200 1bb cap; NL25 play sees a 4bb cap",
        "un-resolved rungs have no HU river betting (CI-10 auto-solve)",
      ],
      answers30d: t.n, p50Ms: t.p50, lastTs: t.lastTs, byDay: t.byDay, drilldown: "charts",
    });
  }

  // 2b. HRC 6-max NL200 ring grid — SOLVING (ledger proposal sixmax-nl200,
  // approved 2026-09-13). The card exists before the charts do: it is the
  // preflop piece of the Ignition 200NL Ring 6-max Equilibrium strategy, which
  // stays unavailable until every expected chart is in the catalog.
  {
    const t = tally("hrc-6max-preflop");
    const cl = chartsLanded(["grid-6max-nl200", "grid-6max-nl200-asym"]);
    const routed = existsSync(join(import.meta.dir, "..", "services", "hrc6max.ts"));
    cards.push({
      id: "hrc-6max", label: "HRC 6-max NL200 ring grid", mode: "gto",
      state: cl.complete ? (routed ? "good" : "warn") : "off",
      stateText: cl.complete ? (routed ? `Up · ${cl.want} charts` : `${cl.want} charts solved — no 6-seat picker yet`)
        : `Solving · ${cl.have} of ${cl.want} charts`,
      tiers: [routed ? "chart-6max" : "chart-6max (not routed yet)"],
      routes: routed ? "6-handed preflop at NL200 ring · rung by table depth and the short seat"
        : "nothing yet — 6-handed preflop still answers from the GTO Wizard NL500 library (0.6bb cap) until a 6-seat chart picker lands",
      facts: [
        // NOT :8777. The whole family is baked into SQLite and read in ~0.1ms per node
        // (services/hrc6maxDb.ts); the server is only the fallback for a chart the bake
        // does not cover, which for the picker's id space is none of them.
        ["served by", hrc6maxDb.size > 0
          ? `data/hrc6max-preflop.sqlite · ${hrc6maxDb.size} trees baked · :8777 only for what it misses`
          : `no local bake on this machine — every node goes to ${HRC3MAX_BASE} (build_6max_preflop_db.py)`],
        ["progress", cl.perConfig.map((p) => `${p.id}: ${p.have}/${p.want}`).join(" · ") || "no configs"],
        ["rake", "5% of the pot, cap $4 = 2bb with six dealt (Ignition's table, checked 2026-09-13)"],
        ["trees", "5 opens (2x / 2.5x / 3x / 3.5x / limp) × 6 depths, plus one short seat (30 / 50 / 70bb) at a 100bb table in every position"],
        ["running on", "the 3 Vultr Windows HRC boxes + the 4 Hetzner Linux boxes (not the Zenbook)"],
        ["proposal", "sixmax-nl200 — approved 2026-09-13 (/proposals)"],
        ["6-seat picker", routed ? "services/hrc6max.ts" : "not written — hrc3max.ts builds 3-seat canonical states only"],
      ],
      caveats: [
        ...(cl.complete ? [] : ["still solving — the strategy that plays it is held unavailable until every chart is in the catalog"]),
        ...(routed ? [] : ["no 6-seat chart picker: even a complete set cannot answer at the table yet (ledger step postflop-6max-nl200)"]),
        "no pool model at 6-handed yet — pool-model-6max-nl200 is blocked (the builder walks a 3-seat tree)",
      ],
      answers30d: t.n, p50Ms: t.p50, lastTs: t.lastTs, byDay: t.byDay, drilldown: "charts",
    });
    // GTO Wizard AI preflop (Ultra) — the 6-max strategy's PREFLOP FALLBACK PIECE (2026-09-19).
    {
      const ai = tally("gtow-ai-preflop");
      cards.push({
        id: "gtow-ai-preflop", label: "GTO Wizard AI preflop (Ultra)", mode: "gto",
        state: "good", stateText: ai.n ? `Live · ${ai.n} answers in 30 days` : "Live · fallback, none needed yet",
        tiers: ["ai-preflop"],
        routes: "the 6-max ring strategy's fallback: every preflop spot the HRC 6-max charts cannot answer — a table thinned to 2-5 seats, a size off the tree, a stack past the 150bb ladder, a limped pot, a straddle — solved in GTO Wizard's cloud from the ACTUAL table (live stacks, blinds as posted, Ignition's rake for the players dealt, our size menu plus every size seen in the line). Never the GTO Wizard library.",
        facts: [
          ["what answers", "hero's exact combo read from the solved node (1,326-combo strategy), rolled like a chart mix"],
          ["speed", "2-4 s for a new table shape (tree + solve), 1-2 s per node after; shapes are cached, and a 2-5 seat table is pre-built from the poller's tick"],
          ["rake in the tree", "5% of pot, cap by players dealt ($1 / $2 / $3 / $4 at 2 / 3 / 4-5 / 6+), no flop no drop"],
          ["sizes", "opens 2x 2.2x 2.5x 3x 3.5x · 3-bets 3.2x 3.8x 4.5x · 4-bets 2.2x 2.6x · 5-bet+ 2.2x — plus the line's own sizes"],
          ["limps", "one non-SB limper plus the SB complete (the API's ceiling)"],
          ["source id", "answers.sqlite source gtow-ai-preflop · tier ai-preflop — that is what the hand page shows"],
          ["code", "services/gtowAiPreflop.ts; the hand-off in fastSolve.ts (6-max strategy branch)"],
        ],
        caveats: [
          "two-limper pots are not in the tree (the API stops at one limper)",
          "a dead small blind cannot be expressed: the missing SB is modelled as a ghost seat all-in for a penny (flagged approx); a capture that labelled the BB poster as SB is relabelled from the post first",
          "solved fresh in the cloud — an answer can differ slightly between two identical spots (solver noise), unlike a stored chart",
          "needs the GTO Wizard session on CDP 9222 (dedicated-profile Chrome) for the token",
        ],
        answers30d: ai.n, p50Ms: ai.p50, lastTs: ai.lastTs, byDay: ai.byDay,
        drilldown: "log", sourceKeys: ["gtow-ai-preflop"],
      });
    }
  }

  // 2c. HRC CoinPoker HU NL200 (ledger config grid-cp200hu) — the preflop piece of the CoinPoker 200NL
  // Heads-Up Equilibrium strategy (2026-09-22). Bodies live in R2 and come through :8777 on demand.
  {
    const t = tally("hrc-hu-preflop");
    const cl = chartsLanded(["grid-cp200hu"]);
    const routed = existsSync(join(import.meta.dir, "..", "services", "hrc2max.ts"));
    cards.push({
      id: "hrc-hu", label: "HRC CoinPoker NL200 heads-up grid", mode: "gto",
      state: cl.have > 0 ? (routed ? "good" : "warn") : "off",
      stateText: cl.have > 0 ? (routed ? `Up · ${cl.have} charts` : `${cl.have} charts solved — no heads-up picker`)
        : `Solving · ${cl.have} of ${cl.want} charts`,
      tiers: ["chart-hu", "villain range → ai-chain"],
      routes: "heads-up preflop under the CoinPoker 200NL Heads-Up strategy · chart by effective stack, the SB's open and the BB's 3-bet",
      facts: [
        ["served by", `${HRC3MAX_BASE} · bodies r2://poker-solve-db/hrc-ui (pulled on first use)`],
        ["charts", `${cl.have} of ${cl.want} · hrc_hu_cp200a_d<depth>_o<open>_3b<3-bet>`],
        ["structure", "blinds 0.5 / 1, ante 0.2bb per player, SB limp in every tree"],
        ["rake", "5% of the pot, cap 0.9bb, no flop no drop — the postflop AI solve uses the same"],
        ["grid", "20-150bb (20, 30, 40, 50, 60, 70, 75, 80-125 by 5, 150) · opens 2x / 2.5x everywhere, 3x from 50bb · 2-3 3-bet sizes per open"],
        ["quality", "ev_gap_sweep: mean reach-weighted gap 0.0023 bb (3-max baseline 0.018); 3 deep nodes > 2.5bb at reach < 1%"],
        ["picker", routed ? "services/hrc2max.ts" : "not written"],
      ],
      caveats: [
        "heads-up only — a third player at the table gets no answer",
        "the table's ante is read per hand; a table not at 0.2bb/player is answered and flagged approximate",
        "no pool model heads-up — equilibrium only",
      ],
      answers30d: t.n, p50Ms: t.p50, lastTs: t.lastTs, byDay: t.byDay, drilldown: "charts",
    });
  }

  // 3. GTO Wizard crawled charts
  {
    const t = tally("local-preflop");
    cards.push({
      id: "gtow-charts", label: "GTO Wizard crawled charts", mode: "gto",
      state: preflopDb.exists ? "good" : "crit",
      stateText: preflopDb.exists ? "Loaded" : "preflop-db.sqlite missing",
      tiers: ["local-preflop"],
      routes: "6-max and heads-up preflop · 3-max fallback when :8777 is down (flagged approximate)",
      facts: [
        ["file", preflopDbPath],
        ["sets", `${gtowPairs} gametype × depth pairs`],
        ["depths", "20 · 40 · 50 · 75 · 100 · 150 — no 200"],
        ["freshness", fmtAge(preflopDb.mtimeMs)],
      ],
      caveats: ["deep stacks snap to 200bb and find nothing", "limp lines are not in the 6-max tree"],
      answers30d: t.n, p50Ms: t.p50, lastTs: t.lastTs, byDay: t.byDay, drilldown: "charts",
    });
  }

  // 4. MES locked flop solves
  {
    const t = tally("mes-postflop");
    const fams = mes.families;
    const gens: Record<string, number> = {};
    for (const f of fams) for (const [g, n] of Object.entries(f.generations)) gens[g] = (gens[g] ?? 0) + n;
    const genText = Object.entries(gens).map(([g, n]) => `${g} ×${n}`).join(" · ") || "—";
    // Every MES solve is conditioned on a hero range (exploit_ranges.json) and a
    // villain range (pool_model). The build stamps both; here they are checked
    // against the files in force NOW, class by class — a preflop refit that is
    // promoted without re-running the MES batch shows up here, never silently.
    const diffClasses = (a: Record<string, number>, b: Record<string, number>) => {
      let n = 0;
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (Math.abs(Number(a[k] ?? 0) - Number(b[k] ?? 0)) > 1e-3) n++;
      return n;
    };
    const rangeFacts: string[] = [];
    const driftCaveats: string[] = [];
    let unstamped = 0;
    for (const f of fams) {
      const inp = f.inputs;
      if (!inp) { unstamped++; continue; }
      const fam = f.id.split("_")[0];
      const liveHero = (exploit?.ranges as Record<string, Record<string, number>> | undefined)?.[inp.hero_range.key];
      const pm = inp.pool_model.exists ? readJson(inp.pool_model.path) : null;
      const liveVillain = (pm?.ranges as Record<string, Record<string, number>> | undefined)?.[inp.villain_range.key];
      const heroDiff = liveHero ? diffClasses(inp.hero_range.weights, liveHero) : null;
      const villainDiff = liveVillain ? diffClasses(inp.villain_range.weights, liveVillain) : null;
      const mark = (d: number | null) => d == null ? "live file unreadable" : d === 0 ? "in sync" : `${d} classes differ`;
      rangeFacts.push(`${fam}: hero ${inp.hero_range.key} (${inp.hero_range.classes} cls) ${mark(heroDiff)} · villain ${inp.villain_range.key} (${inp.villain_range.classes} cls) ${mark(villainDiff)}`);
      if (heroDiff) driftCaveats.push(`${fam} was solved against a hero range that differs from the live exploit file in ${heroDiff} classes — the preflop layer moved on; re-run the MES batch (run_batch_win.py → build_mes_study.py)`);
      if (villainDiff) driftCaveats.push(`${fam} was solved against a villain range that differs from the live pool model in ${villainDiff} classes — re-run the MES batch`);
      if (heroDiff == null) driftCaveats.push(`${fam}: cannot check hero-range drift — exploit overlay not armed or key ${inp.hero_range.key} missing`);
    }
    const stamp = fams.find((f) => f.inputs)?.inputs;
    const stampText = stamp
      ? `exploit_ranges ${stamp.exploit_ranges.sha256 ?? "?"} @ ${stamp.exploit_ranges.mtime ?? "?"} · pool_model ${stamp.pool_model.sha256 ?? "?"} @ ${stamp.pool_model.mtime ?? "?"}`
      : "not stamped (rebuild with build_mes_study.py)";
    cards.push({
      id: "mes-postflop", label: "MES locked flop solves", mode: "mes",
      state: mes.exists && fams.length ? (gens["unknown"] || driftCaveats.length || unstamped ? "warn" : "good") : "off",
      stateText: mes.exists && fams.length ? (driftCaveats.length ? "Loaded — preflop inputs drifted" : "Loaded") : "mes_postflop.json missing",
      tiers: ["exploit-postflop"],
      routes: "flop, 3-handed, hero in range, family shape matches · answers without a cloud call in MES mode",
      facts: [
        ["file", `${mes.path}${mes.sizeBytes ? ` · ${(mes.sizeBytes / 1e6).toFixed(1)} MB` : ""}`],
        ["families", fams.map((f) => `${f.id.split("_")[0]} ${f.heroPos} · ${f.boards.length} boards`).join(" · ") || "—"],
        ["generation", genText],
        ["built", mes.meta?.built_at ? String(mes.meta.built_at) : fmtAge(mes.mtimeMs)],
        ["solved against", stampText],
        ...rangeFacts.map((r, i) => [i === 0 ? "preflop ranges" : "", r] as [string, string]),
      ],
      caveats: [
        "flop street only — turn/river continuation waits on the .locked.bin extracts",
        "off-list flops answer from the nearest texture, flagged approximate",
        "conditioned on the preflop layer: a hero-range refit (exploit_ranges.json) or a new pool model changes the inputs, and the batch must be re-run behind it — the check above says when",
        ...driftCaveats,
        ...(unstamped ? [`${unstamped} famil${unstamped === 1 ? "y is" : "ies are"} not stamped with their preflop inputs — rebuild with build_mes_study.py`] : []),
        ...(gens["unknown"] ? ["generation not stamped on this build — rebuild with build_mes_study.py to tag v2/v3/refit"] : []),
      ],
      answers30d: t.n, p50Ms: t.p50, lastTs: t.lastTs, byDay: t.byDay, drilldown: "boards",
    });
  }

  // 5. GTO Wizard AI chain
  {
    const t = tally("gtow-api-postflop");
    const tokenMin = token.expiresInMs != null ? Math.round(token.expiresInMs / 60000) : null;
    const state: SourceCard["state"] = token.live ? (tokenMin != null && tokenMin < 4 ? "warn" : "good") : cdp.ok ? "warn" : "crit";
    cards.push({
      id: "gtow-ai", label: "GTO Wizard AI, per-street chain", mode: "gto",
      state,
      stateText: token.live ? `Token ${tokenMin} min` : cdp.ok ? "Client up, no token yet" : "Client unreachable",
      tiers: ["ai-chain", "ai-exact"],
      routes: "every postflop spot as primary in GTO mode, and every spot the MES overlay does not cover · equilibrium floor",
      facts: [
        ["service", `api.gtowizard.com · token sniffed over CDP ${cdpHost}`],
        ["client", cdp.ok ? `reachable · ${cdp.ms} ms${cdp.body?.Browser ? ` · ${cdp.body.Browser}` : ""}` : "not reachable"],
        ["keeper", token.keeperRunning ? `running · refreshes 3 min before expiry` : "not running"],
        ["poller", pollerStatus.gtoWizardConnected ? "connected" : "not connected"],
      ],
      caveats: ["desktop locked = no answers (CDP evals return null)", "solve quota per decision · 12 s ceiling"],
      answers30d: t.n, p50Ms: t.p50, lastTs: t.lastTs, byDay: t.byDay, drilldown: null,
    });
  }

  // 6. GTO Wizard spot library (standby)
  {
    const lib = ["library-exact", "library-snap", "far-snap"].reduce((s, k) => s + (log.tiers[k] ?? 0), 0);
    cards.push({
      id: "gtow-library", label: "GTO Wizard spot library", mode: "gto",
      state: "off", stateText: "Standby",
      tiers: ["library-exact", "library-snap", "far-snap"],
      routes: "last resort when both AI paths fail · off-tree sizes snapped within τ",
      facts: [["service", "gtowApi.spotSolution"]],
      caveats: [],
      answers30d: lib, p50Ms: null, lastTs: null, byDay: new Array(30).fill(0), drilldown: null,
    });
  }

  // 6b. the opponent model: the piece every MES best-response is computed against
  {
    const pmPath = poolModelPath();
    const vfPath = join(LIMP, "villain_freqs.json");
    const pmFile = fileInfo(pmPath), vfFile = fileInfo(vfPath);
    const pm = pmFile.exists ? readJson(pmPath) : null;
    const vf = vfFile.exists ? readJson(vfPath) : null;
    const vfMeta = (vf?._meta ?? {}) as Record<string, unknown>;
    const stamp = mes.families.find((f) => f.inputs)?.inputs;
    const stampedMtime = stamp?.pool_model?.mtime ? Date.parse(String(stamp.pool_model.mtime)) : null;
    const newer = stampedMtime != null && pmFile.mtimeMs != null && pmFile.mtimeMs > stampedMtime + 1000;
    const caveats: string[] = [];
    if (!pmFile.exists) caveats.push(`${pmPath.replace(/^.*[\/]/, "")} missing: the MES pieces have no opponent to best-respond to`);
    if (!vfFile.exists) caveats.push("villain_freqs.json missing: the postflop locks have no action frequencies");
    if (newer) caveats.push("the pool model changed after the served MES build was locked against it, so the MES pieces answer against a villain that no longer exists; re-run the batch");
    cards.push({
      id: "pool-model", label: "Measured pool model", mode: "mes",
      state: !pmFile.exists || !vfFile.exists ? "crit" : newer ? "warn" : "good",
      stateText: !pmFile.exists ? "Missing" : newer ? "Newer than the MES lock" : "In force",
      tiers: ["pool_model_v4", "villain_freqs"],
      routes: "never answers directly. It is the villain every MES piece was solved against, and the ranges the exploit preflop overlay best-responds to",
      facts: [
        ["pool_model", pmFile.exists ? `${pmPath} · ${((pmFile.sizeBytes ?? 0) / 1e3).toFixed(0)} KB · ${fmtAge(pmFile.mtimeMs)}` : "missing"],
        ["decisions measured", pm?.n && typeof pm.n === "object"
          ? `${Object.values(pm.n as Record<string, number>).reduce((a, b) => a + b, 0)} across ${Object.keys(pm.n).length} spots: ${Object.entries(pm.n as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(", ")}`
          : pm?.n != null ? String(pm.n) : "?"],
        ["chart basis", pm?.chart ? String(pm.chart) : "?"],
        ["calling ranges", pm?.ranges ? `${Object.keys(pm.ranges).length} contexts: ${Object.keys(pm.ranges).join(", ")}` : "none"],
        ["villain_freqs", vfFile.exists ? `${vfPath} · ${fmtAge(vfFile.mtimeMs)}` : "missing"],
        ["freq contexts", vf?.freqs ? `${Object.keys(vf.freqs).length} action contexts · ${Object.keys(vf.class_freqs ?? {}).length} per-class` : "none"],
        ["freq thresholds", vfMeta.min_n != null || vfMeta.min_class_n != null ? `min-n ${vfMeta.min_n ?? "?"} per context · ${vfMeta.min_class_n ?? "?"} per class` : Object.keys(vfMeta).length ? JSON.stringify(vfMeta).slice(0, 120) : "none"],
        ["stamped into MES", stamp?.pool_model ? `${stamp.pool_model.sha256 ?? "?"} @ ${stamp.pool_model.mtime ?? "?"}` : "not stamped"],
      ],
      caveats,
      answers30d: 0, p50Ms: null, lastTs: null, byDay: new Array(30).fill(0), drilldown: null,
    });
  }

  // 7. answer log & ground truth
  {
    const stats60 = answerLog.stats(60) as { answered: number; failed: number };
    cards.push({
      id: "log", label: "Answer log & ground truth", mode: null,
      state: log.provenanceRows > 0 ? "good" : "warn",
      stateText: log.provenanceRows > 0 ? `${log.provenanceRows} answers with full provenance` : "No provenance rows yet",
      tiers: ["answers.sqlite", "hands.db"],
      routes: "the join that makes live grading possible: answers by client hand id ↔ archived hands",
      facts: [
        ["60 days", `${stats60.answered} answered · ${stats60.failed} failed`],
        ["records", "tier, latency, chart, pick, roll + since 2026-09-03: strategy mode, source, MES/GTO picks, EV at stake, band, stake, seats, position, depth, action mix"],
        ["hands", `${handRows ?? "?"} archived · ${HANDS_DB}`],
        ["wrapper", wrapper.ok ? `live at ${DEFAULT_LIVE_URL} · ${wrapper.ms} ms` : `not reachable at ${DEFAULT_LIVE_URL}`],
        ["answers.sqlite", answersFile.exists ? `${((answersFile.sizeBytes ?? 0) / 1e3).toFixed(0)} KB` : "missing"],
      ],
      caveats: log.provenanceRows > 0 ? [] : ["nothing can be graded MES-vs-GTO until answers with provenance accumulate"],
      answers30d: Object.values(log.sources).reduce((s, x) => s + x.n, 0), p50Ms: null, lastTs: null,
      byDay: new Array(30).fill(0), drilldown: "log",
    });
  }

  for (const card of cards) card.sourceKeys = SOURCE_KEYS[card.id] ?? [];

  for (const card of cards) Object.assign(card, PIECE_OF[card.id] ?? { piece: undefined, role: null });
  attributeCards(cards, { mes, exploit });

  return c.json({
    ok: true,
    pieces: PIECES,
    at: Date.now(),
    armed: {
      // what the live session DECLARED — the strategy is the whole answer to
      // "which pieces are answering right now" (services/strategies.ts)
      strategyId: liveStrategyId,
      strategyName: STRATEGIES.find((x) => x.id === canonicalStrategyId(liveStrategyId))?.name ?? null,
      exploitPreflop: !!exploitPath && exploitFile.exists,
      mesPostflop: mes.exists && mes.families.length > 0,
      mesBoards: mes.families.reduce((s, f) => s + f.boards.length, 0),
      hrc: { up: hrc.ok, ms: hrc.ms },
      // The 6-max ring charts do NOT come from :8777 on this machine: they are baked
      // into data/hrc6max-preflop.sqlite and read by services/hrc6maxDb.ts, chart
      // RESOLUTION included. So a 6-max session needs the bake, not the server, and the
      // wrapper's preflight (sessions.py) checks this instead of `hrc` for that strategy.
      // `trees` is the bake's own coverage count; 0 = no bake here, and the 6-max path
      // falls back to :8777 for every node.
      hrc6max: { db: hrc6maxDb.size > 0, trees: hrc6maxDb.size },
      // The GTO Wizard POOL, not one client: the Elite session takes heads-up
      // solves so the Ultra session's daily allowance is spent only on the
      // multiway trees that need it (services/gtowSessions.ts). `tokenLive`
      // stays "can we answer anything at all" for callers that predate the
      // pool; `multiwayLive` is the one that decides whether 3+ player spots
      // have an answer, and the wrapper's preflight checks it separately.
      gtow: {
        tokenLive: token.live,
        expiresInMs: token.expiresInMs,
        clientUp: cdp.ok,
        multiwayLive: token.multiwayLive,
        sessions: tokenSessions.map((x) => ({
          id: x.id, label: x.label, state: x.state, text: x.text,
          tokenLive: x.tokenLive, expiresInMs: x.expiresInMs, multiway: x.multiway,
          cdpHost: x.cdpHost, enabled: x.enabled, launchHint: x.launchHint,
          blockedKind: x.blockedKind, blockedReason: x.blockedReason, trees: x.trees,
          account: x.account, accountId: x.accountId,
        })),
      },
      wrapper: { up: wrapper.ok, url: DEFAULT_LIVE_URL, studyAnswersOn: wrapper.body?.studyAnswersOn ?? null },
      poller: { running: pollerStatus.running, lastTickAt: pollerStatus.lastTickAt },
    },
    tiers: log.tiers,
    cards,
    mes,
  });
});

// ------------------------------------------------------------- strategies
/** The whole-hand strategy catalogue: what we can play, whether each is
 *  coherent (safeguards in services/strategies.ts), its winrate row from the
 *  matrix, and hero's realized bb/100 while it was the active mode. */
app.get("/strategies", (c) => {
  const views = evaluateStrategies();
  const matrix = readJson(join(DATA_DIR, "strategy_matrix.json"));
  const rowById: Record<string, any> = {};
  for (const g of matrix?.groups ?? []) for (const row of g.rows ?? []) rowById[row.id] = { ...row, group: g.title };
  // realized: answers tagged with the mode that was live, joined to hand nets
  const rows = answerLog.rows(365);
  const seen = new Map<string, string>();      // clientHandId -> strategy id
  for (const a of rows) {
    const sid = strategyIdForAnswer(a as any);
    const h = (a as any).client_hand_id;
    if (sid && h && !seen.has(h)) seen.set(h, sid);
    else if (sid && h && seen.get(h) !== FULL_EXPLOIT_ID && sid === FULL_EXPLOIT_ID) seen.set(h, sid);
  }
  const realized: Record<string, { hands: number; netBb: number }> = {};
  // reuse the dashboard's own enrichment + net accounting (same numbers the
  // Analytics tab shows) rather than a second, divergent query
  const enriched = allRows().map(enrichSync).filter((x): x is Enriched => x != null);
  const nets = computeNets(enriched);
  const declared = new Map<string, string>();
  for (const sess of sessionsStore.list(500)) { const id = canonicalStrategyId(typeof sess.config?.strategy === "string" ? sess.config.strategy : null); if (id) declared.set(sess.id, id); }
  for (const e of enriched) {
    const sessId = typeof e.raw?.sessionId === "string" ? e.raw.sessionId : null;
    const sid = (sessId && declared.get(sessId)) || (e.clientHandId ? seen.get(e.clientHandId) : null);
    if (!sid) continue;
    const r = (realized[sid] ??= { hands: 0, netBb: 0 });
    r.hands++;
    r.netBb += nets.get(e.dbId) ?? 0;
  }
  // how each strategy answers every spot (services/strategyCoverage.ts), with the register's live counts joined:
  // per row, the fires of the approximations it leans on; per strategy, its HOLES = the register filtered to its sources
  const approx = Object.keys(STRATEGY_COVERAGE).length ? approximationRows(30) : [];
  const brief = (r: (typeof approx)[number]) => ({ id: r.id, title: r.title, what: r.what, fix: r.fix, status: r.status,
    cost: r.cost ?? null, fires: r.fires, measured: r.measured, openRows: r.miss?.rows ?? 0 });
  const coverageOf = (id: string) => {
    const cov = STRATEGY_COVERAGE[id];
    if (!cov) return null;
    const byId = new Map(approx.map((r) => [r.id, r]));
    return {
      ...cov,
      sections: cov.sections.map((sec) => ({ ...sec, rows: sec.rows.map((row) => ({
        ...row, approxLive: (row.approx ?? []).map((a) => byId.get(a)).filter(Boolean).map((r) => brief(r!)),
      })) })),
      holes: approx.filter((r) => cov.holeSources.includes(r.source)).map(brief),
      queue: workQueue(cov),
      days: 30,
    };
  };
  return c.json({
    ok: true,
    strategies: views.map((v) => ({
      ...v,
      matrix: rowById[v.matrixRow] ?? null,
      realized: realized[v.id] ?? { hands: 0, netBb: 0 },
      coverage: coverageOf(v.id),
    })),
    haircut: matrix?.haircut ?? null,
    evidenceChain: matrix?.evidenceChain ?? null,
    matrixBuilt: matrix?.generatedAt ?? null,
  });
});

// -------------------------------------------------------------- playthrough
// The Playthrough tab: OUR solver browser. Config first (only what is solved is
// offered), then a 3-max table you walk preflop -> flop -> turn -> river with a
// strategy chosen per seat: hero MES (exploit) or GTO chart; villains pool or GTO.
const LIMP = join(DATA_DIR, "..", "..", "..", "..", "analysis", "pipeline", "limp_study");
app.get("/play/config", (c) => {
  const pool = readJson(poolModelPath());
  const exploit = process.env.EXPLOIT_CHART ? readJson(process.env.EXPLOIT_CHART) : null;
  const chart = pool?.chart ?? "ign200_3maxasym2ci_D100_s100_eq";
  return c.json({
    ok: true,
    configs: [
      { id: "ign25-3max-100", label: "Ignition NL25 · 3-max · 100bb", rake: "5% / cap 4bb", available: true, chart,
        note: "preflop: HRC asym charts (:8777) · postflop: M1/M2 locked solves" },
      { id: "ign200-3max-100", label: "Ignition NL200 · 3-max · 100bb", rake: "5% / cap 1bb", available: false,
        note: "preflop charts exist; postflop locks not solved at this rake yet" },
      // The 6-max ring set ANSWERS already — services/hrc6max.ts routes a 6-handed spot to it and the
      // "Ignition 200NL Ring 6-max Equilibrium" strategy is selectable. What is missing is only this page's
      // table: it lays out three seats (BTN/SB/BB) and walks that rotation, so there is nothing here to seat
      // six players in yet. Until that view exists the charts are readable at
      // /api/ledger/charts.html?prefix=ign200_6max_D100 — every seat's range and the blind defences, per tree.
      { id: "ign200-6max-100", label: "Ignition NL200 · 6-max ring · 100bb", rake: "5% / cap 2bb", available: false,
        note: "charts are solved and the study answers use them; this browser still seats three — read them at /api/ledger/charts.html?prefix=ign200_6max_D100" },
    ],
    strategies: {
      // whole-hand strategies (services/strategies.ts) — the picker only enables
      // the coherent ones; the rest carry the reason they are refused
      hero: evaluateStrategies(),
      villain: [{ id: "pool", label: "Pool (measured frequencies + calling ranges)", available: !!pool }, { id: "gto", label: "GTO chart", available: true }],
    },
    exploit: exploit ? { choices: exploit.choices, ranges: exploit.ranges } : null,
    pool: pool ? { freq: pool.freq, ranges: pool.ranges, n: pool.n, tokens: pool.tokens } : null,
    postflop: { spots: mesSpots(), turnDir: "data/mes_turn", note: "14 boards per family; any other flop maps to the nearest solved texture" },
  });
});
app.get("/play/preflop", async (c) => {
  const chart = c.req.query("chart") ?? "";
  const line = c.req.query("line") ?? "";
  const n = await fetchNode(chart, line);
  if (n === "unreachable") return c.json({ ok: false, error: "chart server :8777 unreachable" }, 503);
  if (!n) return c.json({ ok: false, error: `no node in ${chart} at line "${line}"` }, 404);
  return c.json({ ok: true, node: n });
});

// ------------------------------------------------------------ MES walkthrough
// The registry's mes-postflop page: every solved spot is a page you can walk
// node by node — flop from mes_postflop.json, turn from the per-board turn
// file, river extracted on demand from the locked tree.
const ints = (s: string | undefined) => (s ?? "").split(",").filter(Boolean).map(Number);
app.get("/mes/spots", (c) => c.json({ ok: true, spots: mesSpots() }));
app.get("/mes/node", (c) => {
  const n = mesFlopNode(c.req.query("family") ?? "", c.req.query("board") ?? "", ints(c.req.query("hist")));
  return n ? c.json({ ok: true, node: n }) : c.json({ ok: false, error: "no such node" }, 404);
});
app.get("/mes/turn-lines", (c) => {
  const l = mesTurnLines(c.req.query("family") ?? "", c.req.query("board") ?? "");
  return l ? c.json({ ok: true, lines: l }) : c.json({ ok: false, error: "no turn file for this board yet" }, 404);
});
app.get("/mes/turn", (c) => {
  const n = mesTurnNode(c.req.query("family") ?? "", c.req.query("board") ?? "", ints(c.req.query("flop")), c.req.query("card") ?? "", ints(c.req.query("hist")));
  return n ? c.json({ ok: true, node: n }) : c.json({ ok: false, error: "no such turn node" }, 404);
});
app.get("/mes/river", async (c) => {
  // line = full solver labels from the flop root incl. turn card, turn actions, river card
  const family = c.req.query("family") ?? "", board = c.req.query("board") ?? "";
  const line = (c.req.query("line") ?? "").split("|").filter(Boolean);
  const hist = ints(c.req.query("hist"));
  const st = await extractLine(family, board, line);
  if (!st) return c.json({ ok: false, error: "no locked tree on this machine for that board (river needs mes_handoff/trees_refit)" }, 404);
  const byH = new Map(st.nodes.map((n) => [n.history.join(","), n]));
  const n = byH.get(hist.join(","));
  if (!n) return c.json({ ok: false, error: "no such river node" }, 404);
  const children = n.actions.map((_, a) => byH.has([...hist, a].join(",")));
  const path: string[] = [];
  let h: number[] = [];
  for (const a of hist) { const pn = byH.get(h.join(",")); if (pn) path.push(pn.actions[a]!); h = [...h, a]; }
  const spot = mesSpots().find((s) => s.family === family && s.board === board);
  const heroPlayer = spot ? (spot.heroPos === "SB" ? 0 : 1) : 1;
  return c.json({ ok: true, node: { family, board, line, pot: st.pot, board5: st.board, path, hist, player: n.player, acts: n.actions,
    children, isHero: n.player === heroPlayer, heroPlayer, w: heroPlayer === 0 ? st.oop_weights : st.ip_weights,
    mes: n.strategy, mesEv: n.ev } });
});

// ------------------------------------------------------------------- matrix

/** Sessions of hero's hands with the strategy mode that was active, from
 *  the answers logged inside each session's time window. */
function sessionModes(days: number) {
  const rows = allRows();
  const enriched = rows.map(enrichSync).filter((x): x is Enriched => x != null);
  const nets = computeNets(enriched);
  const answers = answerLog.rows(days).filter((a) => a.text != null);
  const sessions = sessionsOf(enriched).map((hs) => {
    const start = (hs[0]!.playedAt ?? 0) - 5 * 60_000;
    const end = (hs[hs.length - 1]!.playedAt ?? 0) + 5 * 60_000;
    const inWin = answers.filter((a) => a.ts >= start && a.ts <= end);
    const modes: Record<string, number> = {};
    for (const a of inWin) modes[a.strategy_mode ?? "unknown"] = (modes[a.strategy_mode ?? "unknown"] ?? 0) + 1;
    const mode = Object.entries(modes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    const known = hs.map((h) => nets.get(h.dbId)).filter((x): x is number => x != null);
    const netBb = Math.round(known.reduce((s, x) => s + x, 0) * 100) / 100;
    return {
      start: hs[0]!.playedAt, end: hs[hs.length - 1]!.playedAt, stakes: hs[0]!.stakes,
      hands: hs.length, answered: inWin.length, mode, modes,
      netBb, knownHands: known.length, bb100: known.length ? Math.round((10000 * netBb) / known.length) / 100 : null,
      handIds: hs.map((h) => h.dbId),
    };
  });
  const byMode: Record<string, { sessions: number; hands: number; knownHands: number; netBb: number; bb100: number | null }> = {};
  for (const s of sessions) {
    const m = (byMode[s.mode] ??= { sessions: 0, hands: 0, knownHands: 0, netBb: 0, bb100: null });
    m.sessions++; m.hands += s.hands; m.knownHands += s.knownHands; m.netBb = Math.round((m.netBb + s.netBb) * 100) / 100;
  }
  for (const m of Object.values(byMode)) m.bb100 = m.knownHands ? Math.round((10000 * m.netBb) / m.knownHands) / 100 : null;
  return { sessions: sessions.reverse(), byMode, enriched, nets, answers };
}

app.get("/matrix", (c) => {
  const matrix = readJson(join(DATA_DIR, "strategy_matrix.json"));
  const ladder = readJson(join(DATA_DIR, "winrate_ladder.json"));
  const reach = readJson(join(DATA_DIR, "mes_reach_value.json"));
  const combined = readJson(join(DATA_DIR, "backtest_combined.json"));
  const sm = sessionModes(365);
  // realized bb/100 by preflop strategy mode: exploit sessions vs chart sessions
  const realized = {
    exploit: sm.byMode["exploit"] ?? null,
    chart: sm.byMode["chart"] ?? null,
    unknown: sm.byMode["unknown"] ?? null,
  };
  return c.json({
    ok: true,
    matrix,
    ladder,
    reach,
    combined,
    realized,
    missing: [
      ...(matrix ? [] : ["data/strategy_matrix.json — run analysis/pipeline/limp_study/strategy_matrix.py"]),
      ...(ladder ? [] : ["data/winrate_ladder.json — run backtest_study_answers.py --json"]),
      ...(combined ? [] : ["data/backtest_combined.json — run backtest_combined.py"]),
    ],
  });
});

// ------------------------------------------------------------------ grading
// told-vs-did helpers live in services/adherence.ts (shared with the dashboard's analytics)

app.get("/grading", (c) => {
  const days = Number(c.req.query("days") ?? 60) || 60;
  const sm = sessionModes(days);
  const byCid = new Map<string, Enriched>();
  for (const e of sm.enriched) if (e.clientHandId) byCid.set(e.clientHandId, e);

  interface Graded {
    id: number; ts: number; clientHandId: string | null; dbId: number | null;
    street: string | null; board: string | null; heroCards: string | null; heroPos: string | null;
    stakes: string | null; tier: string | null; source: string | null; strategyMode: string | null;
    family: string; node: string;
    mesPick: string | null; gtoPick: string | null; pick: string | null;
    disagreed: boolean | null; atStakeBb: number | null; mesExact: boolean | null;
    band: [number, number] | null;
    heroDid: string | null; followed: "mes" | "gto" | "both" | "neither" | null;
    warning: string | null;
  }
  const graded: Graded[] = [];
  for (const a of sm.answers) {
    const e = a.client_hand_id ? byCid.get(a.client_hand_id) ?? null : null;
    const did = e ? heroActionAt(e, a) : null;
    const mesPick = a.exploit_pick, gtoPick = a.chart_pick;
    const disagreed = mesPick && gtoPick ? !sameAction(mesPick, gtoPick) : null;
    let followed: Graded["followed"] = null;
    if (did) {
      const m = mesPick ? sameAction(mesPick, did.label) : null;
      const g = gtoPick ? sameAction(gtoPick, did.label) : null;
      if (m == null && g == null) followed = a.pick ? (sameAction(a.pick, did.label) ? "both" : "neither") : null;
      else if (m && g) followed = "both";
      else if (m) followed = "mes";
      else if (g) followed = "gto";
      else followed = "neither";
    }
    const family = a.mes_family
      ? a.mes_family
      : a.street === "preflop" && a.exploit_tag ? `preflop · ${a.exploit_tag}`
      : a.street === "preflop" ? "preflop · chart only"
      : "postflop · AI chain only";
    graded.push({
      id: a.id, ts: a.ts, clientHandId: a.client_hand_id, dbId: e?.dbId ?? null,
      street: a.street, board: a.board, heroCards: a.hero_cards, heroPos: a.hero_pos ?? e?.summary.heroPos ?? null,
      stakes: e?.stakes ?? (a.bb_cents ? `${a.bb_cents}¢` : null),
      tier: a.tier, source: a.source ?? sourceForTier(a.tier), strategyMode: a.strategy_mode,
      family, node: `${a.street ?? "?"}${a.board ? ` ${a.board}` : ""}${a.exploit_tag ? ` · ${a.exploit_tag}` : ""}`,
      mesPick, gtoPick, pick: a.pick,
      disagreed, atStakeBb: a.mes_ev_gain_bb, mesExact: a.mes_exact == null ? null : a.mes_exact === 1,
      band: a.band_lo != null && a.band_hi != null ? [a.band_lo, a.band_hi] : null,
      heroDid: did?.label ?? null, followed, warning: a.warning,
    });
  }

  // aggregates
  const byFamily: Record<string, { answers: number; agree: number; mesOnly: number; gtoOnly: number; unknown: number; atStakeBb: number; atStakeN: number; followedMes: number; followedGto: number; graded: number }> = {};
  let disagreements = 0, withBoth = 0, followedMesN = 0, gradedN = 0, atStakeSum = 0, atStakeN = 0;
  for (const g of graded) {
    const f = (byFamily[g.family] ??= { answers: 0, agree: 0, mesOnly: 0, gtoOnly: 0, unknown: 0, atStakeBb: 0, atStakeN: 0, followedMes: 0, followedGto: 0, graded: 0 });
    f.answers++;
    if (g.disagreed == null) f.unknown++;
    else if (!g.disagreed) f.agree++;
    else if (g.strategyMode === "exploit") f.mesOnly++;
    else f.gtoOnly++;
    if (g.disagreed != null) withBoth++;
    if (g.disagreed) { disagreements++; if (g.atStakeBb != null) { atStakeSum += g.atStakeBb; atStakeN++; f.atStakeBb += g.atStakeBb; f.atStakeN++; } }
    if (g.followed) { f.graded++; gradedN++; }
    if (g.followed === "mes" || g.followed === "both") { f.followedMes++; if (g.disagreed) followedMesN++; }
    if (g.followed === "gto" || g.followed === "both") f.followedGto++;
  }

  return c.json({
    ok: true,
    days,
    provenanceRows: graded.filter((g) => g.strategyMode != null).length,
    summary: {
      answers: graded.length,
      graded: gradedN,
      withBothPicks: withBoth,
      disagreements,
      disagreementRate: withBoth ? Math.round((1000 * disagreements) / withBoth) / 10 : null,
      meanAtStakeBb: atStakeN ? Math.round((100 * atStakeSum) / atStakeN) / 100 : null,
      followedMesWhenDisagreed: disagreements ? Math.round((1000 * followedMesN) / disagreements) / 10 : null,
      realizedByMode: sm.byMode,
    },
    byFamily,
    sessions: sm.sessions.map(({ handIds: _h, ...s }) => s),
    trail: graded.slice().reverse().slice(0, 200),
  });
});

// ------------------------------------------------------------------ answers

/** Recent logged answers, optionally filtered to one card's sources or tiers —
 *  the trail on a source's detail page (/sources/pieces/:id). */
app.get("/answers", (c) => {
  const days = Number(c.req.query("days") ?? 60) || 60;
  const limit = Math.min(500, Number(c.req.query("limit") ?? 80) || 80);
  const sources = (c.req.query("source") ?? "").split(",").filter(Boolean);
  const tiers = (c.req.query("tier") ?? "").split(",").filter(Boolean);
  const failed = c.req.query("failed") === "1";
  let rows = answerLog.rows(days);
  if (!failed) rows = rows.filter((r) => r.text != null);
  if (sources.length) rows = rows.filter((r) => sources.includes(r.source ?? sourceForTier(r.tier)));
  if (tiers.length) rows = rows.filter((r) => tiers.includes(r.tier ?? ""));
  const byCid = new Map<string, number>();
  for (const e of allRows().map(enrichSync)) if (e?.clientHandId) byCid.set(e.clientHandId, e.dbId);
  const out = rows.slice().reverse().slice(0, limit).map((r) => ({
    id: r.id, ts: r.ts, clientHandId: r.client_hand_id,
    dbId: r.client_hand_id ? byCid.get(r.client_hand_id) ?? null : null,
    street: r.street, board: r.board, heroCards: r.hero_cards, heroPos: r.hero_pos,
    tier: r.tier, source: r.source ?? sourceForTier(r.tier), chart: r.chart, strategyMode: r.strategy_mode,
    text: r.text, pick: r.pick, roll: r.roll, latencyMs: r.latency_ms, failReason: r.fail_reason, warning: r.warning,
    exploitPick: r.exploit_pick, chartPick: r.chart_pick, mesBoard: r.mes_board, mesEvGainBb: r.mes_ev_gain_bb,
  }));
  return c.json({ ok: true, total: rows.length, answers: out });
});

// ------------------------------------------------------------------ roadmap

/**
 * GET /approximations — the known-imperfections register, ranked by how often
 * each one actually fires.
 *
 * The register (services/approximations.ts) is hand-authored: it says what we
 * do instead of the exact thing and why. Everything else here is JOINED, so
 * the page moves with the data:
 *
 *   - `miss`  the miss-queue kinds this entry owns, rolled up — how many
 *             distinct states are open and how many LIVE hands hit them.
 *   - `warn`  how many logged answers in the window actually carried this
 *             approximation's phrase.
 *   - `measured`  whether either key produced anything. An entry with no
 *             telemetry at all is the interesting case, not a blank row: we
 *             know we approximate, we cannot say how often. Those sort last
 *             and are labelled, because the instrumentation gap IS the finding.
 *
 * `claimedCaveats` closes the loop the other way: the caveat phrases this
 * register accounts for. The page holds the registry cards already, so it
 * subtracts the two and shows any caveat no entry claims — which is how this
 * list is kept from quietly going stale as the cards change.
 */
/** The register with its live telemetry joined — shared by /approximations and the strategies' coverage maps. */
function approximationRows(days: number) {
  const vol = missQueue.volumeByKind();
  const needles = [...new Set(APPROXIMATIONS.map((a) => a.warn).filter(Boolean) as string[])];
  const warns = answerLog.countWarnings(needles, days);

  const rows = APPROXIMATIONS.map((a: Approximation) => {
    const kinds = (a.missKinds ?? []).map((k) => ({ kind: k, ...(vol[k] ?? { rows: 0, live: 0, corpus: 0, lastSeen: null }) }));
    const miss = kinds.length
      ? {
          kinds,
          rows: kinds.reduce((s, k) => s + k.rows, 0),
          live: kinds.reduce((s, k) => s + k.live, 0),
          corpus: kinds.reduce((s, k) => s + k.corpus, 0),
          lastSeen: kinds.reduce<number | null>((m, k) => (k.lastSeen != null && (m == null || k.lastSeen > m) ? k.lastSeen : m), null),
        }
      : null;
    const warn = a.warn ? { needle: a.warn, ...warns[a.warn]! } : null;
    const measured = miss != null || warn != null;
    // What to sort on. Live hits are the truth — a hand that actually took the
    // approximation — and an answer that printed the warning is the same
    // event seen from the other side. Open rows are a backlog, not a rate, so
    // they only break ties.
    const fires = (miss?.live ?? 0) + (warn?.n ?? 0);
    return { ...a, miss, warn, measured, fires };
  });

  rows.sort((x, y) =>
    Number(y.measured) - Number(x.measured) ||
    y.fires - x.fires ||
    (y.miss?.rows ?? 0) - (x.miss?.rows ?? 0) ||
    x.title.localeCompare(y.title));
  return rows;
}

/** Patch charts the strategy's LIVE approximations call for (services/patchJobs.ts). The box queue dispatcher
 *  (poker-zenbook/hrc-api/scripts/boxQueue.ts) polls this every minute and queues the unsolved ones at tier 1. */
app.get("/patch-jobs", (c) => {
  const prefix = c.req.query("prefix") ?? "ign200_6max_";
  const jobs = patchJobs(prefix);
  return c.json({ ok: true, prefix, jobs: jobs.filter((j) => !j.solved), solved: jobs.filter((j) => j.solved).length });
});

app.get("/approximations", (c) => {
  const days = Math.max(1, Math.min(365, Number(c.req.query("days") ?? 30) || 30));
  const rows = approximationRows(days);

  // Drift check, half of it: the caveat phrases this register claims. The
  // registry's cards are built inside that endpoint (live probes and all), and
  // the page already holds them — so the comparison happens client-side rather
  // than rebuilding every card here just to read its caveats.
  const claimedCaveats = [...new Set(APPROXIMATIONS.flatMap((a) =>
    a.coversCaveat == null ? [] : Array.isArray(a.coversCaveat) ? a.coversCaveat : [a.coversCaveat]))];

  return c.json({
    ok: true, days, rows, claimedCaveats,
    totals: {
      all: rows.length,
      measured: rows.filter((r) => r.measured).length,
      unmeasured: rows.filter((r) => !r.measured).length,
      byStatus: rows.reduce<Record<string, number>>((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}),
      liveHits: rows.reduce((s, r) => s + (r.miss?.live ?? 0) + (r.warn?.n ?? 0), 0),
    },
  });
});

app.get("/roadmap", (c) => {
  const road = readJson(join(DATA_DIR, "roadmap.json")) ?? { families: [], preflop: [] };
  const mes = mesPostflopInfo();
  const reach = readJson(join(DATA_DIR, "mes_reach_value.json"));
  const famById = new Map(mes.families.map((f) => [f.id, f]));
  const families = (road.families as any[]).map((f) => {
    const built = famById.get(f.id);
    const r = reach?.families?.[f.id] ?? null;
    return {
      ...f,
      built: !!built,
      boards: built?.boards.length ?? 0,
      generations: built?.generations ?? {},
      meanEvGainPerArrival: r?.mean_ev_gain_per_arrival ?? (built ? Math.round((100 * built.boards.reduce((s, b) => s + b.evGainBb, 0)) / Math.max(1, built.boards.length)) / 100 : null),
      arrivalPctOfHands: r?.arrival_pct_of_hands ?? null,
      upliftBb100: r?.uplift_bb100 ?? null,
    };
  });
  return c.json({ ok: true, families, preflop: road.preflop, generatedAt: road.generatedAt ?? null });
});

/**
 * GET /exploit-preflop/detail — the overlay's actual content, node by node:
 * the five choice nodes (169 classes → one pure action, sizes included), the
 * line shapes each node answers (villain's open SIZE is not distinguished —
 * any single raise reads as "open"), and the nine derived range sets the AI
 * chain uses to reconstruct hero's flop range.
 */
app.get("/exploit-preflop/detail", (c) => {
  const path = process.env.EXPLOIT_CHART;
  if (!path || !existsSync(path)) return c.json({ ok: false, error: "EXPLOIT_CHART is not armed or the file is missing", path: path ?? null }, 404);
  let doc: any;
  try { doc = JSON.parse(readFileSync(path, "utf-8")); } catch (e) { return c.json({ ok: false, error: `unreadable: ${String(e)}` }, 500); }
  const combos = (k: string) => (k.length === 2 ? 6 : k.endsWith("s") ? 4 : 12);
  const NODE_META: Record<string, { label: string; heroPos: string; lines: string[]; note: string }> = {
    btn_root: { label: "BTN first in", heroPos: "BTN", lines: ["(root)"], note: "hero's own open; the size in the answer is hero's" },
    sb_vs_open: { label: "SB facing a BTN open", heroPos: "SB", lines: ["R2", "R2.2", "R2.5", "R2.8", "R3", "R3.5"], note: "one node for every BTN open size — the pool's 2x, 2.5x and 3x opens are treated as one range" },
    bb_vs_open: { label: "BB facing a BTN open, SB folded", heroPos: "BB", lines: ["R2-F", "R2.2-F", "R2.5-F", "R2.8-F", "R3-F", "R3.5-F"], note: "one node for every BTN open size" },
    sb_bvb: { label: "SB first in, BTN folded", heroPos: "SB", lines: ["F"], note: "hero's own blind-vs-blind open" },
    bb_vs_sb: { label: "BB facing an SB open", heroPos: "BB", lines: ["F-R2", "F-R2.2", "F-R2.5", "F-R2.8", "F-R3", "F-R3.5"], note: "one node for every SB open size — the pool's 3x and 3.9x opens are treated as one range" },
  };
  const RANGE_META: Record<string, { label: string; usedFor: string }> = {
    btn_open: { label: "BTN open range", usedFor: "hero BTN on the flop after R-F-C or R-C-F" },
    btn_limp: { label: "BTN limp range", usedFor: "not used by the chain (limped pots take the chart)" },
    sb_3bet_vs_btn: { label: "SB 3-bet range vs BTN", usedFor: "hero SB on the flop after R-R-F-C" },
    sb_flat_vs_btn: { label: "SB flat range vs BTN", usedFor: "hero SB on the flop after R-C-F" },
    sb_open_bvb: { label: "SB open range, blind vs blind", usedFor: "hero SB on the flop after F-R-C" },
    bb_3bet_vs_btn: { label: "BB 3-bet range vs BTN", usedFor: "hero BB on the flop after R-F-R-C" },
    bb_flat_vs_btn: { label: "BB flat range vs BTN", usedFor: "hero BB on the flop after R-F-C" },
    bb_3bet_vs_sb: { label: "BB 3-bet range vs SB", usedFor: "hero BB on the flop after F-R-R-C" },
    bb_flat_vs_sb: { label: "BB flat range vs SB", usedFor: "hero BB on the flop after F-R-C" },
  };
  const nodes = Object.entries(doc.choices ?? {}).map(([tag, cells]: [string, any]) => {
    const byAction: Record<string, { classes: number; combos: number }> = {};
    let total = 0;
    for (const [cls, act] of Object.entries(cells as Record<string, string>)) {
      const b = (byAction[act] ??= { classes: 0, combos: 0 });
      b.classes++; b.combos += combos(cls); total += combos(cls);
    }
    const order = (a: string) => /^fold/i.test(a) ? 0 : /^limp|^call|^check/i.test(a) ? 1 : 2 + (parseFloat(a.replace(/[^\d.]/g, "")) || 0);
    const actions = Object.keys(byAction).sort((a, b) => order(a) - order(b));
    return {
      tag, ...(NODE_META[tag] ?? { label: tag, heroPos: "?", lines: [], note: "" }),
      actions, cells,
      mix: actions.map((a) => ({ action: a, classes: byAction[a]!.classes, pct: Math.round((1000 * byAction[a]!.combos) / total) / 10 })),
    };
  });
  const ranges = Object.entries(doc.ranges ?? {}).map(([key, w]: [string, any]) => {
    let n = 0;
    for (const [cls, wt] of Object.entries(w as Record<string, number>)) n += combos(cls) * Number(wt);
    return { key, ...(RANGE_META[key] ?? { label: key, usedFor: "" }), weights: w, combos: Math.round(n), pct: Math.round((1000 * n) / 1326) / 10, classes: Object.keys(w).length };
  });
  // The follow-on: LOCKED-ROOT charts. One HRC rich-tree solve per villain
  // seat x open size x rung with villain's root frozen to the pool-width
  // range; every node below it is solved, so hero's 3-bet/flat and villain's
  // 4-bet/5-bet/jam lines all get a best-response answer — the overlay above
  // stops at hero's first decision. Listed here as charts (planned or solved)
  // so this page shows the whole preflop-exploit source, not just the overlay.
  const catalogIds = new Set(getCatalog().entries.map((e: any) => e.id));
  const poolShare: Record<string, number> = { "btn_2": 15.8, "btn_2.5": 28.2, "btn_3": 50.0, "sb_3": 44.5, "sb_4": 26.8 };
  const rung = 100;
  const lockedRoot = {
    rung,
    tree: "rich 3-max tree as the grid (limps on, flats 1/2/1/1, opens 2–3.5 + 4bb, 3-bets 9–14, 4-bets 22–33 + jam) — every node below the lock is solved",
    lock: "villain's root at ONE size, range = chart union across sizes scaled to the pool's measured open frequency (composition per pool_model); hero and the third seat free",
    jobs: (["ign200", "ign500"] as const).flatMap((site) => [
      ...[2, 2.5, 3].map((size) => ({ site, villain: "BTN", size, line: `R${size}`, servesHero: ["SB", "BB"], poolShare: poolShare[`btn_${size}`] ?? null, id: `${site}_3maxlock_D${rung}_s${rung}_eq_btn_o${String(size).replace(".", "_")}`, lockRange: "btn_open @ pool width" })),
      ...[3, 4].map((size) => ({ site, villain: "SB", size, line: `F-R${size}`, servesHero: ["BB"], poolShare: poolShare[`sb_${size}`] ?? null, id: `${site}_3maxlock_D${rung}_s${rung}_eq_sb_o${String(size).replace(".", "_")}`, lockRange: "sb_open_bvb @ pool width" })),
    ]).map((j) => ({ ...j, solved: catalogIds.has(j.id), status: catalogIds.has(j.id) ? "solved" : "planned" })),
    covers: ["hero SB / BB facing the open: 3-bet (all sizes), flat, fold", "villain's response to the 3-bet: fold / call / 4-bet at every 4-bet size", "hero facing the 4-bet: fold / call / 5-bet / jam", "the third seat's squeeze and cold-call lines (free seat, Nash)"],
    notCovered: ["hero BTN first in (the overlay's btn_root answers it; villain 3-bet responses stay equilibrium until second-level locks have the sample)", "depth rungs other than 100bb until the set is extended"],
  };
  return c.json({ ok: true, path, chart: doc.chart ?? null, nodes, ranges, lockedRoot });
});

export default app;
