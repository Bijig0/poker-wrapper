import nodeFs from "node:fs";
import nodePath from "node:path";
import { Hono } from "hono";
import { adoptAtStartupAsync, startAdoptionCatchUp } from "../../packages/data-root/centralDb";
import { describeLayout, exitLogPath, resolveAllStores, splitStores } from "./src/services/storePaths";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import ingestRoutes from "./src/routes/ingest";
import studyPollerRoutes from "./src/routes/studyPoller";
import buildRoutes from "./src/routes/build";
import preflopDbRoutes from "./src/routes/preflopDb";
import gtowApiRoutes from "./src/routes/gtowApi";
import feedSpotRoutes from "./src/routes/feedSpot";
import fastSolverRoutes from "./src/routes/fastSolver";
import aiStudyRoutes from "./src/routes/aiStudy";
import dashboardRoutes from "./src/routes/dashboard";
import gtowAccountsRoutes from "./src/routes/gtowAccounts";
import gtowCacheRoutes from "./src/routes/gtowCache";
import sourcesRoutes from "./src/routes/sources";
import missQueueRoutes from "./src/routes/missQueue";
import { answerReconciler } from "./src/services/answerReconciler";
import replayRoutes from "./src/routes/replay";
import studyUiRoutes from "./src/routes/studyUi";
import { studyPoller } from "./src/services/studyPoller";
import { gtowApi } from "./src/services/gtowApi";
import { startStallMonitor, trackActivity } from "./src/services/answerTrace";
import { startBackgroundLock, onBackgroundOwnership } from "./src/services/backgroundLock";
import ignitionHhRoutes from "./src/routes/ignitionHh";
import { hhChecker } from "./src/services/hhCheck";
import { replayScheduler } from "./src/services/replayScheduler";
import { livePort, port as apiPort, rewritePorts } from "./src/services/ports";
import { trustAuditLine } from "./src/services/hrc6maxDb";
import { autoRestart, buildStamp, isSupervised } from "./src/services/buildStamp";
import { gitAnswers } from "./src/services/loadedCode";

const app = new Hono();

// THE PLAYER'S API (2026-09-27, the poker-wrapper repo): study answers (poller, fastSolve, GTO Wizard token keeper) and
// the dashboard for the player's own sessions and hands. The chart factory — the HRC solve fleet, its ledger,
// proposals, runbook and task board — is the poker repo's, not this one's (README.md, "The chart factory").
// playerMode stays in the config reply: setup\doctor.ps1 and older launchers read it.
app.get("/api/dashboard/config", (c) => c.json({ playerMode: true }));

// Middleware
// every request is registered while it runs, so an event-loop stall line can name what was open (services/answerTrace)
app.use("*", async (c, next) => {
  const done = trackActivity(`${c.req.method} ${c.req.path}`);
  try { await next(); } finally { done(); }
});
app.use("*", logger());
app.use("*", cors());

// Routes
// the launchers' "is an API up?" probe (.claude/dev-api.cmd)
app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));
app.route("/api/ingest", ingestRoutes);
app.route("/api/study-poller", studyPollerRoutes);
app.route("/api/build", buildRoutes);
app.route("/api/preflop-db", preflopDbRoutes);
app.route("/api/gtow-api", gtowApiRoutes);
app.route("/api/feed-spot", feedSpotRoutes);
app.route("/api/fast-solver", fastSolverRoutes);
app.route("/api/ai-study", aiStudyRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/gtow/accounts", gtowAccountsRoutes);
// the persistent GTO Wizard solve cache: what it holds and what it saved (services/gtowSolveCache)
app.route("/api/gtow/cache", gtowCacheRoutes);
app.route("/api/dashboard/sources", sourcesRoutes);
app.route("/api/dashboard/miss-queue", missQueueRoutes);
app.route("/api/replay", replayRoutes);
app.route("/api/ignition-hh", ignitionHhRoutes);

// The study tool UI — Reader Verify, Replay Review, State Tester, plus the
// replica's card art. Mounted at the root so the page paths match the ones
// they had on the dashboard app.
app.route("/", studyUiRoutes);

// The study dashboard UI — hands table, per-node solution replayer, analytics.
// It is the entry point: :2000/ is the dashboard, the JSON API lives under /api.
// The dashboard is one page routing on the path: /hands, /hands/:id,
// /analytics, /sources/:pane, /sources/registry/:source, /review. Every
// one of those serves the same HTML and the page picks the view — so a URL
// can be bookmarked, reloaded, or pasted. (/replay stays the Replay Review
// page itself, which the /review tab embeds.)
const dashboardPage = () =>
  // read as text: its ":2000"-style addresses become this install's ports (services/ports.ts rewritePorts; a no-op by default)
  new Response(rewritePorts(nodeFs.readFileSync(`${import.meta.dir}/dashboard.html`, "utf-8")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
// The dashboard's stylesheet lives beside the page (dashboard.css) so it can be
// read and edited as one file; served uncached, like the page, so an edit is live.
app.get("/dashboard.css", () =>
  new Response(Bun.file(`${import.meta.dir}/dashboard.css`), {
    headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
  }));
for (const p of ["/", "/home", "/hands", "/hands/*", "/analytics", "/coverage", "/sources", "/sources/*", "/sessions", "/sessions/*", "/profiles", "/profiles/*", "/gtow", "/review", "/playthrough", "/playthrough/*"]) {
  app.get(p, dashboardPage);
}
// the chart factory's pages (ledger, runbook, proposals, tasks) are the poker repo's: an old bookmark lands home
for (const p of ["/ledger", "/ledger/*", "/runbook", "/runbook/*", "/proposals", "/proposals/*", "/tasks", "/tasks/*"]) app.get(p, (c) => c.redirect("/", 302));
// Old bookmarks and links still land on the dashboard.
app.get("/dashboard", (c) => c.redirect("/", 301));

// API index — what the JSON endpoints are and where they live.
app.get("/api", (c) => {
  return c.json({
    name: "Poker GTO Bot API",
    version: "1.0.0",
    description:
      "The study API: the dashboard (/), the study poller that answers the Poker Wrapper's live decisions, and the " +
      "answer path behind it (6-max/3-max/heads-up preflop charts, GTO Wizard AI preflop and postflop chains, MES).",
    endpoints: {
      health: "GET /api/health",
      ingest: "POST /api/ingest — { rows | text | live } from the panel live feed",
      fastSolver: "POST /api/fast-solver — { hand | live | rows | text } → local preflop charts + GTOW spot-solution API (no live nav)",

      aiStudy: "POST /api/ai-study — SolverStudy (analysis app) ONLY: { preflop, board, tokens } → HU node solution via GTOW cloud, 6-max crawl ranges. NOT the live answer path and not used by the dashboard — live answers and dashboard re-solves go through services/aiChain.ts (POST /api/dashboard/resolve-chain)",
      studyPollerStart: "POST /api/study-poller/start — push live GTO answers into assistive-play's panel (study/practice only)",
      studyPollerStop: "POST /api/study-poller/stop",
      studyPollerStatus: "GET /api/study-poller/status",
    },
  });
});

// Start server
const port = apiPort("api");   // PORT, else 2000 + PORT_OFFSET (services/ports.ts)

console.log(`🃏 Poker GTO Bot API starting on port ${port}...`);

// DASHBOARD_ONLY=1 (the cloud deployment): no poker client, no GTO Wizard, no study wrapper on the
// box — the poller and the token keeper would only log connection errors every few seconds.
// Bun exits the process on an unhandled promise rejection, and a background tick that rejects (a box going
// unreachable mid-await, an scp/rclone spawn failing) would take the whole API down with exit 1 and no log line —
// 91 silent worker deaths on 2026-09-13/14, each one killing every box relay. Log it and keep serving instead.
// WHY DID IT DIE (2026-09-14). The handlers below print to api.log, but a run of silent exit-1 deaths every
// 5-18 min left nothing there at all: stdout through cmd.exe's `>>` is buffered, so anything console.error
// writes in the last moments is lost with the process. This log is appendFileSync - it reaches disk before the
// next statement runs - and it records the one fact that splits the two possible stories: if `exit` fires we
// died from inside (with the stack of whoever called it), and if the log simply stops at a heartbeat then
// something outside killed the process, which is a different hunt entirely.
const deathLog = exitLogPath();
try { nodeFs.mkdirSync(nodePath.dirname(deathLog), { recursive: true }); } catch { /* the recorder never blocks boot */ }
const say = (m: string) => {
  try {
    // a heartbeat every 20 s is 15 KB an hour: keep the last few days, never let a diagnostic fill the disk
    try { if (nodeFs.statSync(deathLog).size > 4_000_000) nodeFs.writeFileSync(deathLog, ""); } catch { /* no file yet */ }
    nodeFs.appendFileSync(deathLog, `[${new Date().toISOString()}] pid ${process.pid} ${m}\n`);
  } catch { /* never let the recorder be the crash */ }
};
say("boot");
process.on("unhandledRejection", (reason) => {
  const m = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  say(`unhandledRejection ${m.slice(0, 800)}`);
  console.error(`[unhandledRejection] ${m}`);
});
process.on("uncaughtException", (err) => {
  say(`uncaughtException ${(err?.stack ?? String(err)).slice(0, 800)}`);
  console.error(`[uncaughtException] ${err?.stack ?? String(err)}`);
});
process.on("exit", (code) => say(`exit ${code} - from ${(new Error("exit").stack ?? "").split(String.fromCharCode(10)).slice(1, 6).join(" | ")}`));
process.on("beforeExit", (code) => say(`beforeExit ${code} (event loop empty)`));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) {
  try { process.on(sig as any, () => { say(`signal ${sig}`); process.exit(0); }); } catch { /* not on this platform */ }
}
// A heartbeat, so a log that stops without an `exit` line dates the kill to within 20 s and carries the memory
// trace next to it - an OOM climbs, an external kill does not.
setInterval(() => {
  const mb = (n: number) => Math.round(n / 1048576);
  const m = process.memoryUsage();
  say(`alive rss ${mb(m.rss)}MB heap ${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext ${mb(m.external)}MB`);
}, 20_000);

const dashboardOnly = process.env.DASHBOARD_ONLY === "1";
if (dashboardOnly) console.log("DASHBOARD_ONLY=1: study poller and GTOW token keeper are off");

// ONE DATA ROOT (gto-trainer/DATA-ROOT-PLAN.md): say where every record goes, fold the legacy per-store files into the
// central poker.sqlite before the background work writes, and refuse to run as the LIVE API with its records split — an env
// override that points one store outside the root is exactly how hand 973's chains and answers came apart.
let adoption: Promise<void> = Promise.resolve();
{
  const stores = resolveAllStores();
  console.log(describeLayout());
  for (const s of stores.filter((x) => x.override)) console.log(`[data-root]   ${s.store} → ${s.path} (${s.override})`);
  const liveApi = port === livePort("api") && !dashboardOnly;   // the install's API port; a verify API (:2001) is not it
  const split = splitStores(stores);
  if (liveApi && split.length) {
    const why = `[data-root] REFUSING TO START the live API: ${split.map((s) => `${s.store} → ${s.path} (${s.override})`).join("; ")} ` +
      `lands outside the data root — unset the override(s) or set POKER_DATA_DIR so every store moves together`;
    console.error(why);
    say(why);
    process.exit(1);
  }
  // ONLY THE LIVE API adopts (and retires) the legacy files: a verify server (:2001), a dashboard-only box or a
  // POKER_DATA_DIR sandbox must never move the live system's data — it reads what the live processes adopted
  // AFTER THE PORT IS OPEN, a committed chunk at a time (2026-09-26: run synchronously before `export default` let the
  // server listen, a 123 MB first adoption kept the supervisor's health probe unanswered and it killed the worker
  // twice, rolling the copy back each time). The background work below starts when it is done.
  if (liveApi) {
    adoption = new Promise<void>((done) => setTimeout(done, 0)).then(async () => {
      try {
        const line = await adoptAtStartupAsync((l) => console.log(l));
        if (line) say(line);
        // an old-code wrapper still writing a legacy file: fold its new rows in every minute until it lets go
        startAdoptionCatchUp((l) => console.log(l));
      } catch (e) {
        console.error(`[data-root] adoption failed: ${e instanceof Error ? e.message : e}`);
      }
    });
  }
}

// One owner for the background work. A second API process is allowed to serve HTTP (that is what
// `dev-api.cmd --watch` is for) but must not run a second poller / dispatcher / keeper: see
// services/backgroundLock.ts for what two of each actually broke on 2026-09-13.
// The services also self-guard, so a route that starts the poller on a demoted instance is refused.
// Every API process watches its own event loop (services/answerTrace.ts): a stall lands in the timeline of
// every answer it froze, and in the log as [stall] — ownership has nothing to do with it.
startStallMonitor();
startBackgroundLock();
// A MERGE TO MAIN IS THE DEPLOY (services/autoRestart.ts): a committed change to code this process loaded restarts it
// by a clean exit — when no session is live, and only under a supervisor. Everything else it only reports (/api/build).
autoRestart.start();
// WHAT THIS WORKER STARTED WITH, in both logs: the commit, how many files it stamped, whether a supervisor will bring it
// back, and whether git answers here — git is what tells a committed change from somebody's uncommitted edit, and a
// scheduled task's PATH has surprised this service before (config\env.ps1 puts Git on it).
void gitAnswers(buildStamp.repo).then((git) => {
  const line = `[build] running ${buildStamp.commit?.slice(0, 7) ?? "no commit"} · ${buildStamp.loaded().length} files stamped · ` +
    `${isSupervised() ? "supervised: restarts itself on a commit to loaded code when no session is live" : "not supervised: never restarts itself"} · ` +
    `git ${git ? "answers" : "DOES NOT ANSWER — a committed change is told from an edit by the commit having moved"}`;
  console.log(line);
  say(line);
});
// THE CHART TRUST AUDIT (2026-10-03): how many baked 6-max charts carry no trust scores — each one answers from the old
// limp_node_trust.json, unguarded where it has no score (services/nodeTrust). Said once at start; the registry shows it live.
setTimeout(() => {
  try { const line = trustAuditLine(); console.log(line); say(line); } catch (e) { console.warn(`[hrc6maxDb] trust audit failed: ${e instanceof Error ? e.message : e}`); }
}, 0);
// the poller, dispatcher and keepers write the central DB: they start once the legacy rows are in (at once when there
// is nothing to adopt, or this is not the live API). Registered after, since an owner runs the callback immediately.
void adoption.then(() => onBackgroundOwnership(() => {
  // Always running, self-gating on assistive-play's own "Study Answers" toggle
  // (see services/studyPoller.ts) — that toggle is the single control; no
  // separate start step needed for normal use.
  if (!dashboardOnly) studyPoller.start();

  // Keep a live GTOW access token on hand at all times: the CDP sniff costs
  // 4-8s, and paying it inline made whichever solve hit the ~15-min expiry miss
  // the decision window entirely.
  if (!dashboardOnly) gtowApi.startTokenKeeper();

  // Settles WHY a decision got no answer once its hand is archived: attaches the
  // failures the poller could not pin to a hand, and writes a no-probe row for a
  // decision nobody ever asked about (services/answerReconciler.ts).
  if (!dashboardOnly) answerReconciler.start();

  // Checks every hand archived from here on against Ignition's own hand history (services/hhCheck.ts).
  if (!dashboardOnly) hhChecker.start();

  // Check #13: once a day, when the table is quiet, replay the live decisions against their recordings (services/replayScheduler.ts).
  if (!dashboardOnly) replayScheduler.start();
}));

export default {
  port,
  hostname: process.env.HOST ?? "0.0.0.0", // the cloud box binds 127.0.0.1 and lets Caddy front it
  fetch: app.fetch,
  // Tier-2 AI re-solves hold the request open for up to a few minutes
  // (solve + line replay + on-demand street solves); Bun's default is 10s.
  idleTimeout: 255,
  // Windows: children spawned by a previous worker (box runners, and HRC launched through them) inherit the listening
  // socket handle and keep the port "in use" after the worker restarts under bun --watch; reusePort lets the new worker
  // bind anyway and take the connections (seen 2026-09-09: every request hung until HRC exited).
  reusePort: true,
};
