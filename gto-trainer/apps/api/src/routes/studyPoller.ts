import { Hono } from "hono";
import { studyPoller, studyPollers, type StudyPollerConfig } from "../services/studyPoller";
import { gtowSessions } from "../services/gtowSessions";

/**
 * Controls the backend study pollers (see services/studyPoller.ts) — start one
 * and it keeps pushing GTO answers to assistive-play's panel unattended, no
 * browser tab required.
 *
 * MULTI-TABLE (2026-09-19): there is one poller per wrapper, because Ignition
 * allows four tables and four tables are four wrapper processes. `/start` is
 * keyed by `assistiveUrl`, so each wrapper starting itself up registers its own
 * — the wrappers need no knowledge of each other. `/stop` with no body stops
 * every one of them (what "Study Answers off" has always meant); `/stop` with
 * an `assistiveUrl` stops just that table.
 */
const app = new Hono();

app.post("/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StudyPollerConfig & { gtowAccounts?: unknown };
  // The session's GTO Wizard allowlist (Brady, 2026-09-27: per session, default everything). The wrapper sends it with
  // every start (its keeper re-posts every 20 s), so the pool's restriction always mirrors the running session.
  gtowSessions.setAllow(Array.isArray(body.gtowAccounts) && body.gtowAccounts.length ? body.gtowAccounts.map(String) : null);
  return c.json({ ok: true, ...studyPollers.start(body), gtowAllow: gtowSessions.allowList() });
});

app.post("/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { assistiveUrl?: string };
  if (!body?.assistiveUrl) gtowSessions.setAllow(null);   // every table stopped: no session, no restriction
  return c.json({ ok: true, ...(await studyPollers.stop(body?.assistiveUrl)) });
});

app.get("/status", (c) => {
  // The flat shape the panel and the Sources registry have always read, with
  // every table's poller under `pollers`.
  return c.json({ ok: true, ...studyPoller.getStatus() });
});

/** Just the per-table list, for the multi-table overview strip. */
app.get("/tables", (c) => {
  return c.json({ ok: true, pollers: studyPollers.list() });
});

export default app;
