import { Hono } from "hono";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, loadLedger, DATA_DIR, REPO } from "../services/ledger";
import { jobs, PY } from "../services/jobs";
import { runbookFor, planRunbook } from "../services/runbook";
import { proposals, approve, runAll } from "../services/proposals";
import { proposalProgress } from "../services/progress";
import { boxKeeper } from "../services/boxKeeper";
import { workData } from "../services/workData";

/**
 * /api/ledger — the source of truth for formats + solve configs, evaluated
 * against the artifacts on disk, and the job queue that runs them.
 *
 *   GET  /                      formats, trees, configs (with status/stale/estimate), plans, artifacts
 *   POST /configs/:id/status    { status: "done" | "planned" } — mark by hand (fleet/manual runners)
 *   GET  /proposals             the run proposals (RUN · WHY · FORMAT · TREE · INPUT · METHOD · SOLVES · OUTPUT · CHECK)
 *   POST /proposals/:id/approve { approved: true|false }
 *   POST /proposals/:id/run     queue every step as a chain (each waits for its inputs)
 *   GET  /proposals/:id/progress what the run is doing now, per solve: fleet boxes (ssh), HRC Runner queue, job steps
 *   GET  /runbook/:plan         the plan spelled out: order, preflight, every step's exact work
 *   GET  /configs/:id/runbook   one config's runbook
 *   GET  /jobs                  the queue, newest first
 *   POST /jobs                  { config } — enqueue the config's recipe
 *   POST /jobs/:id/cancel
 *   GET  /jobs/:id/log?lines=   log tail
 */
const app = new Hono();

app.get("/", (c) => c.json({ ok: true, ...evaluate(), proposals: proposals(), jobs: jobs.list(20) }));

app.post("/configs/:id/status", async (c) => {
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as { status?: string; note?: string };
  if (!["done", "planned", "blocked"].includes(b.status ?? "")) return c.json({ ok: false, error: "status must be done, planned or blocked" }, 400);
  const p = join(DATA_DIR, "ledger.json");
  const L = JSON.parse(readFileSync(p, "utf-8"));
  const cfg = (L.configs as any[]).find((x) => x.id === id);
  if (!cfg) return c.json({ ok: false, error: `no config ${id}` }, 404);
  cfg.status = b.status;
  if (b.note) cfg.note = b.note;
  cfg.statusChangedAt = new Date().toISOString();
  writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
  loadLedger();
  return c.json({ ok: true, config: evaluate().configs.find((x) => x.id === id) });
});

app.get("/work-data", async (c) => { let d: any = null; try { d = JSON.parse(c.req.query("d") ?? "null"); } catch { /* bad */ } if (!d) return c.json({ ok: false, error: "d (json) required" }, 400); try { return c.json({ ok: true, ...(await workData(d)) }); } catch (e) { return c.json({ ok: false, error: String(e) }, 500); } });
app.get("/proposals", (c) => c.json({ ok: true, proposals: proposals() }));

/**
 * GET /charts.html — the solved preflop charts as ONE self-contained page: 13x13 hand grids per node, the
 * actions coloured and sized by frequency, nothing fetched at view time. A solve is in the :8777 catalog the
 * moment it lands, but nothing SHOWS it until the study tool is cut over to the new set, so this is how you
 * look at (or send someone) a chart that is still in flight.
 *   /api/ledger/charts.html?ids=ign200_6max_D100_o2_5,ign200_6max_D50_o3
 *   /api/ledger/charts.html?prefix=ign200_6max_D100&max=6
 */
app.get("/charts.html", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const prefix = c.req.query("prefix") ?? "ign200_6max_";
  const max = String(Math.min(24, Math.max(1, Number(c.req.query("max") ?? 4) || 4)));
  const out = join(DATA_DIR, `charts_export_${Date.now()}.html`);
  const script = join(REPO, "analysis", "pipeline", "solve", "export_chart_html.py");
  const proc = Bun.spawn([PY, script, ...ids, "--prefix", prefix, "--max", max, "--out", out], { stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) return c.text(`chart export failed (exit ${code})

${o}
${e}`, 500);
  try {
    const body = readFileSync(out, "utf-8");
    try { require("node:fs").unlinkSync(out); } catch { /* keep going */ }
    return c.html(body);
  } catch (err) {
    return c.text(`chart export produced nothing: ${String(err)}
${o}
${e}`, 500);
  }
});
app.post("/proposals/:id/approve", async (c) => { const b = (await c.req.json().catch(() => ({}))) as { approved?: boolean }; return c.json(approve(c.req.param("id"), b.approved !== false)); });
app.post("/proposals/:id/run", (c) => { const r = runAll(c.req.param("id")); return c.json(r, r.ok ? 200 : 409); });
app.get("/proposals/:id/progress", (c) => { const r = proposalProgress(c.req.param("id")); return r ? c.json({ ok: true, ...r }) : c.json({ ok: false, error: "no such proposal" }, 404); });
app.get("/runbook/:plan", (c) => { const r = planRunbook(c.req.param("plan")); return r ? c.json({ ok: true, ...r }) : c.json({ ok: false, error: "no such plan" }, 404); });
app.get("/configs/:id/runbook", (c) => { const r = runbookFor(c.req.param("id")); return r ? c.json({ ok: true, runbook: r }) : c.json({ ok: false, error: "no such config" }, 404); });

app.get("/keeper", (c) => c.json({ ok: true, ...boxKeeper.status() }));
app.get("/jobs", (c) => c.json({ ok: true, jobs: jobs.list(Number(c.req.query("limit") ?? 50)) }));
app.post("/jobs", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { config?: string; boxes?: string[]; argsByBox?: Record<string, string[]> };
  if (!b.config) return c.json({ ok: false, error: "config required" }, 400);
  const r = jobs.enqueue(b.config, { boxes: b.boxes, argsByBox: b.argsByBox });
  return c.json(r, r.ok ? 200 : 409);
});
app.post("/jobs/:id/cancel", (c) => c.json({ ok: jobs.cancel(Number(c.req.param("id"))) }));
app.get("/jobs/:id/log", (c) => c.json({ ok: true, job: jobs.get(Number(c.req.param("id"))), log: jobs.logTail(Number(c.req.param("id")), Number(c.req.query("lines") ?? 200)) }));

export default app;
