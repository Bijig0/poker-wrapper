import { Hono } from "hono";
import { autoRestart, buildStamp, isSupervised, pageToken } from "../services/buildStamp";
import { liveStatus } from "../services/liveStatus";

/**
 * "You are running older code than the disk" — what is done about it, and a way to do it by hand.
 *
 * GET  /api/build          is this process stale, what changed, and what the auto-restart is doing about it
 * GET  /api/build/all      the same for every service of this install (API, charts, wrapper tables) + the supervisors
 * POST /api/build/restart  exit cleanly; the supervisor relaunches within seconds
 *
 * The restart is an EXIT, never a spawn. study-api.ps1 arms EXPLOIT_CHART and
 * POOL_MODEL before every launch, and a bare `bun index.ts` started from here
 * would silently come back with the exploit overlay off — the exact failure the
 * launcher scripts exist to prevent. If the supervisor is not running, this
 * refuses and names the command to run by hand rather than exiting into nothing.
 */
const app = new Hono();

/** This process's line, in the shape every service answers /build with (services/liveStatus.ts ServiceBuild). */
export const selfBuild = (force = false) => ({
  ok: true, service: "api", ...buildStamp.status(force), supervised: isSupervised(), auto: autoRestart.status(), page: pageToken(),
});

app.get("/", (c) => c.json(selfBuild(c.req.query("force") === "1")));

app.get("/all", async (c) => c.json({ ok: true, ...(await liveStatus({ api: selfBuild(true) })) }));

app.post("/restart", async (c) => {
  if (!isSupervised()) {
    return c.json({
      ok: false,
      error: "no supervisor in this process's environment — exiting would leave nothing serving this port.",
      hint: "Start it from the supervisor (scheduled task \"PokerWrapper API - <user>\"), or relaunch by hand with .claude\dev-api.cmd.",
    }, 409);
  }
  const st = buildStamp.status(true);
  console.log(`[build] restart requested — booted ${new Date(st.bootAt).toISOString()}, `
    + `${st.changedCount} loaded file(s) changed on disk since; exiting for the supervisor`);
  // Answer BEFORE dying, or the dashboard sees a dropped connection and cannot
  // tell "restarting" from "crashed". The delay only has to outlive the response
  // being flushed.
  setTimeout(() => process.exit(0), 250);
  return c.json({ ok: true, restarting: true, bootAt: st.bootAt, changedCount: st.changedCount,
    note: "exiting now — the supervisor relaunches within seconds" });
});

export default app;
