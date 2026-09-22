import { Hono } from "hono";
import { buildStamp, isSupervised } from "../services/buildStamp";

/**
 * "You are running older code than the disk" — and a way to fix it.
 *
 * GET  /api/build          is this process stale, and what changed
 * POST /api/build/restart  exit cleanly; the StudyAPI supervisor relaunches in ~10s
 *
 * The restart is an EXIT, never a spawn. study-api.ps1 arms EXPLOIT_CHART and
 * POOL_MODEL before every launch, and a bare `bun index.ts` started from here
 * would silently come back with the exploit overlay off — the exact failure the
 * launcher scripts exist to prevent. If the supervisor is not running, this
 * refuses and names the command to run by hand rather than exiting into nothing.
 */
const app = new Hono();

app.get("/", (c) => c.json({ ok: true, ...buildStamp.status(c.req.query("force") === "1") }));

app.post("/restart", async (c) => {
  if (!isSupervised()) {
    return c.json({
      ok: false,
      error: "no StudyAPI supervisor in this process's environment — exiting would leave nothing serving :2000.",
      hint: "Start it from the supervisor (scheduled task \"StudyAPI\"), or relaunch by hand with .claude\\dev-api.cmd.",
    }, 409);
  }
  const st = buildStamp.status(true);
  console.log(`[build] restart requested — booted ${new Date(st.bootAt).toISOString()}, `
    + `${st.changedCount} source file(s) newer than this process; exiting for the supervisor`);
  // Answer BEFORE dying, or the dashboard sees a dropped connection and cannot
  // tell "restarting" from "crashed". The delay only has to outlive the response
  // being flushed.
  setTimeout(() => process.exit(0), 250);
  return c.json({ ok: true, restarting: true, bootAt: st.bootAt, changedCount: st.changedCount,
    note: "exiting now — the supervisor relaunches within ~10s" });
});

export default app;
