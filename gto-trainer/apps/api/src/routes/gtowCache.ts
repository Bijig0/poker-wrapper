/**
 * /api/gtow/cache — the persistent GTO Wizard solve cache (services/gtowSolveCache.ts, 2026-09-28).
 *
 *   GET /            what it holds (trees, nodes, stored verdicts, the file's size), what it saved — since this process
 *                    started and all-time, today's hits and requests saved — and the most recently hit nodes
 *                    (?recent=N, default 12)
 *
 * Read-only and cheap: a few indexed counts on its own file (flushing any pending writes first). The GTO Wizard tab
 * shows the one-line summary the accounts payload carries (GET /api/gtow/accounts → `cache`).
 */
import { Hono } from "hono";
import { gtowSolveCache } from "../services/gtowSolveCache";

const app = new Hono();

app.get("/", (c) => {
  const n = Number(c.req.query("recent") ?? 12);
  const recent = Number.isFinite(n) ? Math.max(0, Math.min(200, Math.round(n))) : 12;
  return c.json({ ok: true, ...gtowSolveCache.stats(recent) });
});

export default app;
