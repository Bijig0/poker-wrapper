import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { answerLog, sourceForTier, type LoggedAnswer } from "../services/answerLog";
import { getCatalog } from "../services/chartCatalog";
import { mesPostflopInfo, mesSpots, mesFlopNode, mesTurnLines, mesTurnNode } from "../services/mesPostflop";
import { extractLine } from "../services/mesRiver";
import { fetchNode } from "../services/hrc3max";
import { gtowApi } from "../services/gtowApi";
import { HRC3MAX_BASE } from "../services/hrc3max";
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
 */

const DATA_DIR = join(import.meta.dir, "..", "..", "data");
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
}

const SOURCE_KEYS: Record<string, string[]> = {
  "exploit-preflop": ["pool-exploit-preflop"],
  "hrc-3max": ["hrc-3max-preflop"],
  "gtow-charts": ["local-preflop"],
  "mes-postflop": ["mes-postflop"],
  "gtow-ai": ["gtow-api-postflop"],
  "gtow-library": ["gtow-api-postflop"],
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
    probe(`${DEFAULT_LIVE_URL}/state`, 1500),
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
  const pollerStatus = studyPoller.getStatus();
  const mode = studyPoller.studyMode;

  const fmtAge = (ms: number | null) => ms == null ? "unknown" : new Date(ms).toISOString();

  const cards: SourceCard[] = [];

  // 1. pool-exploit preflop overlay
  {
    const t = tally("pool-exploit-preflop");
    const armed = !!exploitPath && exploitFile.exists;
    const choices = exploit?.choices ? Object.keys(exploit.choices) : [];
    const ranges = exploit?.ranges ? Object.keys(exploit.ranges) : [];
    cards.push({
      id: "exploit-preflop", label: "Pool-exploit preflop overlay", mode: "mes",
      state: armed ? "good" : "off",
      stateText: armed ? "Armed" : exploitPath ? "Env set, file missing" : "Not armed",
      tiers: ["exploit-3max", "hero flop ranges → ai-chain"],
      routes: `3-handed preflop, first decision at ${choices.length || 5} nodes: ${choices.join(", ") || "btn_root, sb_vs_open, bb_vs_open, sb_bvb, bb_vs_sb"}`,
      facts: [
        ["file", exploitPath ?? "EXPLOIT_CHART not set"],
        ["fit to", exploit?.chart ? `chart ${exploit.chart}` : "—"],
        ["ranges", ranges.length ? `${ranges.length} derived range sets` : "—"],
        ["freshness", exploitFile.mtimeMs ? fmtAge(exploitFile.mtimeMs) : "—"],
        ["armed by", "dev-api.cmd / start_gtow_ai.ps1 (process env)"],
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

  return c.json({
    ok: true,
    at: Date.now(),
    armed: {
      strategyMode: mode,
      exploitPreflop: !!exploitPath && exploitFile.exists,
      mesPostflop: mes.exists && mes.families.length > 0,
      mesBoards: mes.families.reduce((s, f) => s + f.boards.length, 0),
      hrc: { up: hrc.ok, ms: hrc.ms },
      gtow: { tokenLive: token.live, expiresInMs: token.expiresInMs, clientUp: cdp.ok },
      wrapper: { up: wrapper.ok, url: DEFAULT_LIVE_URL, studyAnswersOn: wrapper.body?.studyAnswersOn ?? null, studyMode: wrapper.body?.studyMode ?? null },
      poller: { running: pollerStatus.running, lastTickAt: pollerStatus.lastTickAt },
    },
    tiers: log.tiers,
    cards,
    mes,
  });
});

// -------------------------------------------------------------- playthrough
// The Playthrough tab: OUR solver browser. Config first (only what is solved is
// offered), then a 3-max table you walk preflop -> flop -> turn -> river with a
// strategy chosen per seat: hero MES (exploit) or GTO chart; villains pool or GTO.
const LIMP = join(DATA_DIR, "..", "..", "..", "..", "analysis", "pipeline", "limp_study");
app.get("/play/config", (c) => {
  const pool = readJson(join(LIMP, "pool_model_v4.json"));
  const exploit = process.env.EXPLOIT_CHART ? readJson(process.env.EXPLOIT_CHART) : null;
  const chart = pool?.chart ?? "ign200_3maxasym2ci_D100_s100_eq";
  return c.json({
    ok: true,
    configs: [
      { id: "ign25-3max-100", label: "Ignition NL25 · 3-max · 100bb", rake: "5% / cap 4bb", available: true, chart,
        note: "preflop: HRC asym charts (:8777) · postflop: M1/M2 locked solves" },
      { id: "ign200-3max-100", label: "Ignition NL200 · 3-max · 100bb", rake: "5% / cap 1bb", available: false,
        note: "preflop charts exist; postflop locks not solved at this rake yet" },
    ],
    strategies: {
      hero: [{ id: "mes", label: "MES preflop (pool exploit)", available: !!exploit }, { id: "gto", label: "GTO chart (HRC equilibrium)", available: true }],
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

type Verb = "fold" | "call" | "check" | "bet" | "raise" | "other";
const verbOf = (label: string | null | undefined): Verb | null => {
  if (!label) return null;
  const s = label.toLowerCase();
  if (s.startsWith("fold")) return "fold";
  if (s.startsWith("check")) return "check";
  if (s.startsWith("call") || s.startsWith("limp")) return "call";
  if (s.startsWith("bet")) return "bet";
  if (s.startsWith("raise") || s.startsWith("all") || s.startsWith("jam") || s.startsWith("rai") || /^r\d/.test(s)) return "raise";
  return "other";
};
const sizeOf = (label: string | null | undefined): number | null => {
  if (!label) return null;
  if (/%/.test(label)) return null; // pot-fraction sizes are not comparable to bb
  const m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]!) : null;
};
/** Same action? Verbs must match; when both carry a bb size they must be within 25%. */
const sameAction = (a: string | null | undefined, b: string | null | undefined): boolean | null => {
  const va = verbOf(a), vb = verbOf(b);
  if (va == null || vb == null) return null;
  if (va !== vb) return false;
  const sa = sizeOf(a), sb = sizeOf(b);
  if (sa != null && sb != null && sa > 0 && sb > 0) return Math.abs(sa - sb) / Math.max(sa, sb) <= 0.25;
  return true;
};

/** Hero's actual action at the logged decision, from the archived hand. */
function heroActionAt(e: Enriched, a: LoggedAnswer): { label: string; verb: Verb } | null {
  let nActs = 0, street: string | null = a.street;
  try {
    const k = JSON.parse(a.decision_key ?? "null");
    if (Array.isArray(k)) { street = k[0] ?? street; nActs = Number(k[4] ?? 0) || 0; }
  } catch { /* fall through */ }
  const acts = e.hand.actions;
  for (let i = nActs; i < acts.length; i++) {
    const x = acts[i] as { hero?: boolean; type?: string; amount?: number; street?: string };
    if (!x.hero) continue;
    if (street && x.street && x.street !== street) return null; // hero never acted again on this street
    if (x.type === "post-sb" || x.type === "post-bb") continue;
    const label = x.amount != null && (x.type === "bet" || x.type === "raise") ? `${x.type} ${x.amount}` : String(x.type ?? "");
    return { label, verb: verbOf(label) ?? "other" };
  }
  return null;
}

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
 *  the trail on a source's detail page (/sources/registry/:id). */
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
