import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, updateLedger, DATA_DIR, REPO, type LedgerConfig } from "../services/ledger";
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

// ONE evaluate() per request (2026-09-26): proposals() and every runbook in it re-evaluated the whole ledger — ~37
// evaluations, each hashing the artifacts: 3-13 s of blocked event loop per 7 s poll of this page (2026-09-25 19:05-19:46Z)
app.get("/", (c) => { const ev = evaluate(); return c.json({ ok: true, ...ev, proposals: proposals(ev), jobs: jobs.list(20) }); });

app.post("/configs/:id/status", async (c) => {
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as { status?: string; note?: string };
  if (!["done", "planned", "blocked"].includes(b.status ?? "")) return c.json({ ok: false, error: "status must be done, planned or blocked" }, 400);
  const found = updateLedger((L) => {
    const cfg = L.configs.find((x) => x.id === id) as (LedgerConfig & { statusChangedAt?: string }) | undefined;
    if (!cfg) return false;
    cfg.status = b.status as LedgerConfig["status"];
    if (b.note) cfg.note = b.note;
    cfg.statusChangedAt = new Date().toISOString();
    return true;
  });
  if (!found) return c.json({ ok: false, error: `no config ${id}` }, 404);
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
