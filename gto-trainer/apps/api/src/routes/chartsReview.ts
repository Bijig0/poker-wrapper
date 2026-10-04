import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { factoryFile } from "../services/repoPaths";
import { hrc6maxDb } from "../services/hrc6maxDb";
import { solveRegister } from "../services/solveRegister";
import { chartReviews } from "../services/chartReviews";

/**
 * THE CHART REVIEW PAGE's data (2026-10-04): /sources/charts-review. Brady goes through all live 6-max charts by hand
 * before any better solve is promoted. LIGHT ON THE EVENT LOOP: the per-chart summaries (RFI per seat, facing opens and
 * 3-bets, sanity flags, live-vs-proposed) are PRECOMPUTED off-process by the factory's chart_review.py into
 * <factory data>/chart-review/; this serves those files (cached per file mtime) and reads per-hand grids from the bake one
 * node at a time through hrc6maxDb's prepared statement. Nothing here scans the catalogue.
 */
const dir = (): string => process.env.CHART_REVIEW_DIR ?? factoryFile("chart-review");
const cache = new Map<string, { m: number; doc: any }>();
function readJson(p: string): any | null {
  try {
    const m = statSync(p).mtimeMs;
    const hit = cache.get(p);
    if (hit && hit.m === m) return hit.doc;
    const doc = JSON.parse(readFileSync(p, "utf8"));
    cache.set(p, { m, doc });
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
    return doc;
  } catch { return null; }
}
const ID = /^[A-Za-z0-9_]+$/;
const liveRaw = (id: string) => hrc6maxDb.provenance(id)?.raw ?? null;

export const chartsReviewRoutes = new Hono()
  .get("/index", (c) => {
    const idx = readJson(join(dir(), "index.json"));
    if (!idx) return c.json({ ok: false, error: `no precomputed review index at ${dir()} - run the factory's chart_review.py` }, 404);
    const ids: string[] = idx.charts.map((r: any) => r.id);
    const live: Record<string, string | null> = {};
    for (const r of idx.charts) live[r.id] = liveRaw(r.id) ?? r.raw;
    const reviews = chartReviews.latest(live);
    const reg = solveRegister.audit(ids, liveRaw);
    const charts = idx.charts.map((r: any) => {
      const rr = solveRegister.chart(r.id);
      return { ...r, liveRaw: live[r.id], review: reviews[r.id] ?? null,
        register: rr ? { candidates: rr.candidates, liveScore: rr.liveScore, runnerUpScore: rr.runnerUpScore, verdict: rr.verdict, betterPct: rr.betterPct } : null,
        staleSummary: !!(live[r.id] && r.raw && live[r.id] !== r.raw) };
    });
    const reviewed = charts.filter((r: any) => r.review).length;
    return c.json({ ok: true, meta: idx.meta, register: reg, progress: { reviewed, of: charts.length,
      flagged: charts.filter((r: any) => r.review?.verdict === "flag").length }, charts });
  })
  .get("/chart/:id", (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json({ ok: false, error: "bad id" }, 400);
    const doc = readJson(join(dir(), `${id}.json`));
    if (!doc) return c.json({ ok: false, error: `no summary for ${id}` }, 404);
    const lr = liveRaw(id) ?? doc.raw;
    return c.json({ ok: true, chart: doc, liveRaw: lr, register: solveRegister.chart(id), history: chartReviews.history(id),
      staleSummary: !!(lr && doc.raw && lr !== doc.raw) });
  })
  /** one node's per-hand grid, from the bake (prepared statement) - the page asks for the node it shows */
  .get("/node/:id", (c) => {
    const id = c.req.param("id");
    const line = c.req.query("line") ?? "";
    if (!ID.test(id) || !/^[A-Za-z0-9.\-]*$/.test(line)) return c.json({ ok: false, error: "bad id or line" }, 400);
    const n = hrc6maxDb.node(id, line);
    if (n === undefined) return c.json({ ok: false, error: `${id} is not baked here` }, 404);
    if (n === null) return c.json({ ok: false, error: `no node ${line || "(root)"} in ${id}` }, 404);
    return c.json({ ok: true, line, node: n, trust: hrc6maxDb.trust(id, line) ?? null });
  })
  .post("/review", async (c) => {
    let b: any;
    try { b = await c.req.json(); } catch { return c.json({ ok: false, error: "json body" }, 400); }
    const id = String(b.chartId ?? "");
    if (!ID.test(id)) return c.json({ ok: false, error: "bad chart id" }, 400);
    const lr = liveRaw(id) ?? readJson(join(dir(), `${id}.json`))?.raw;
    if (!lr) return c.json({ ok: false, error: `no live raw known for ${id}` }, 404);
    if (b.raw && b.raw !== lr) return c.json({ ok: false, error: "the chart's live solve changed since the page loaded - reload and look again" }, 409);
    try {
      const r = chartReviews.record(id, lr, b.verdict, String(b.note ?? ""));
      return c.json({ ok: true, review: r });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
