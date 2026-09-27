/**
 * The chart server, TypeScript (2026-09-27): what the Poker Wrapper runs on :8777 (the chart factory — the poker repo —
 * keeps its Python solve-DB server for its own tools). Only the endpoints the study API and the wrapper read — see chartStore.ts for why and for the
 * cache rules it shares with analysis/pipeline/solve/exploit_ui/server.py.
 *
 *   bun src/charts/chartServer.ts          (.claude/chart-server.ps1 runs it; .claude/dev-charts.cmd by hand)
 *
 *   GET /                    liveness (the wrapper's health check)
 *   GET /api/progress        liveness, 2 bytes (the API's sources probe)
 *   GET /api/solutions       the chart index: the GTOW crawl + every sidecar
 *   GET /api/preflop/node    ?source=<chart id>&line=<tokens>   (source=gtow: &gametype=&depth= from the crawl SQLite)
 *
 * Env: HRC_UI_PORT (8777), CHART_SOLUTIONS_DIR (default data/charts: services/repoPaths.ts, the folder the API's
 * chart catalog reads too), HRC_UI_REMOTE, HRC_UI_DOC_CACHE_MAX, HRC_UI_SMALL_BODY_BYTES, HRC_UI_SMALL_DOC_MAX,
 * HRC_UI_DISK_CACHE_GB, HRC_UI_PINNED_PREFIXES — the same names and defaults as server.py — and HRC_UI_INDEX_SYNC_MIN
 * (30: how often the index is refreshed from R2; 0 = never).
 */
import { join } from "node:path";
import { CHARTS_DIR, DATA_DIR } from "../services/repoPaths";
import { ChartStore, optsFromEnv } from "./chartStore";

const DIR = CHARTS_DIR;
const PREFLOP_DB = join(DATA_DIR, "preflop-db.sqlite");
const PORT = Number(process.env.HRC_UI_PORT ?? 8777);

const HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Content-Type": "application/json" } });

export function chartServerFetch(store: ChartStore) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    if (req.method !== "GET") return json({ error: "not found" }, 404);
    try {
      switch (url.pathname) {
        case "/": case "/index.html": return new Response("chart server (TypeScript)\n", { headers: HEADERS });
        case "/api/progress": return json({});
        case "/api/solutions": return json(store.solutions());
        case "/api/preflop/node": return json(await store.node(url.searchParams));
        default: return json({ error: "not found" }, 404);
      }
    } catch (e: any) {
      console.error(`chart server: ${url.pathname}${url.search}: ${e?.stack ?? e}`);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  };
}

if (import.meta.main) {
  const opts = optsFromEnv(DIR, PREFLOP_DB);
  const store = new ChartStore(opts);
  store.refreshIndex();
  Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: chartServerFetch(store), idleTimeout: 255 });
  const n = store.solutions().length - 1;
  console.log(`chart server (TypeScript) -> http://127.0.0.1:${PORT}  ${n} charts indexed in ${DIR} ` +
              `(loaded lazily, ${opts.bigMax} big + ${opts.smallMax} small cached; bodies from ${opts.remote || "nowhere"})`);
  // the index follows R2: charts the factory lands after this build are listed without a release (chartStore.syncIndex).
  // HRC_UI_INDEX_SYNC_MIN=0 turns it off; the first pass waits a little so a cold start answers first.
  const syncMin = Number(process.env.HRC_UI_INDEX_SYNC_MIN ?? 30);
  if (syncMin > 0 && opts.remote) {
    const tick = () => { void store.syncIndex().catch((e) => console.error(`[index sync] ${e?.message ?? e}`)); };
    setTimeout(tick, 15_000);
    setInterval(tick, syncMin * 60_000);
  }
}
