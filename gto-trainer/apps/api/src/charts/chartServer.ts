/**
 * The chart server, TypeScript (2026-09-27): what the packaged Poker Wrapper runs on :8777 instead of the Python
 * solve-DB server. Only the endpoints the study API and the wrapper read — see chartStore.ts for why and for the
 * cache rules it shares with analysis/pipeline/solve/exploit_ui/server.py.
 *
 *   bun src/charts/chartServer.ts          (.claude/chart-server.ps1 runs it when CHART_SERVER=ts)
 *
 *   GET /                    liveness (the wrapper's health check)
 *   GET /api/progress        liveness, 2 bytes (the API's sources probe)
 *   GET /api/solutions       the chart index: the GTOW crawl + every sidecar
 *   GET /api/preflop/node    ?source=<chart id>&line=<tokens>   (source=gtow: &gametype=&depth= from the crawl SQLite)
 *
 * Env: HRC_UI_PORT (8777), CHART_SOLUTIONS_DIR (default data/charts: services/repoPaths.ts, the folder the API's
 * chart catalog reads too), HRC_UI_REMOTE, HRC_UI_DOC_CACHE_MAX, HRC_UI_SMALL_BODY_BYTES, HRC_UI_SMALL_DOC_MAX,
 * HRC_UI_DISK_CACHE_GB, HRC_UI_PINNED_PREFIXES — the same names and defaults as server.py.
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
}
