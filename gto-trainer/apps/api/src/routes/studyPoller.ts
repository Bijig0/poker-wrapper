import { Hono } from "hono";
import { studyPoller, type StudyPollerConfig } from "../services/studyPoller";

/**
 * Controls the backend study poller (see services/studyPoller.ts) — start it
 * once and it keeps pushing GTO answers to assistive-play's panel unattended,
 * no browser tab required.
 */
const app = new Hono();

app.post("/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as StudyPollerConfig;
  return c.json({ ok: true, ...studyPoller.start(body) });
});

app.post("/stop", async (c) => {
  return c.json({ ok: true, ...(await studyPoller.stop()) });
});

app.get("/status", (c) => {
  return c.json({ ok: true, ...studyPoller.getStatus() });
});

export default app;
