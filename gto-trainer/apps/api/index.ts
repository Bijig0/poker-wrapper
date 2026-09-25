import nodeFs from "node:fs";
import nodePath from "node:path";
import { Hono } from "hono";
import { adoptAtStartup, startAdoptionCatchUp } from "../../packages/data-root/centralDb";
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
import sourcesRoutes from "./src/routes/sources";
import missQueueRoutes from "./src/routes/missQueue";
import ledgerRoutes from "./src/routes/ledger";
import { jobs } from "./src/services/jobs";
import { boxKeeper } from "./src/services/boxKeeper";
import { answerReconciler } from "./src/services/answerReconciler";
import replayRoutes from "./src/routes/replay";
import studyUiRoutes from "./src/routes/studyUi";
import { studyPoller } from "./src/services/studyPoller";
import { gtowApi } from "./src/services/gtowApi";
import { startStallMonitor } from "./src/services/answerTrace";
import { startBackgroundLock, onBackgroundOwnership } from "./src/services/backgroundLock";
import ignitionHhRoutes from "./src/routes/ignitionHh";
import { hhChecker } from "./src/services/hhCheck";

const app = new Hono();

// PLAYER MODE (2026-09-22): the packaged install on someone else's laptop. They get the study answers (poller,
// fastSolve, GTO Wizard token keeper) and the dashboard pages for their own sessions and hands. Everything that
// runs the owner's solve fleet is off: no job dispatcher, no box keeper, no ledger / proposals / runbook pages,
// no task board, no miss-queue sweeps or HRC plans. Set by the setup script in config\local.env.
const playerMode = process.env.PLAYER_MODE === "1";
if (playerMode) console.log("PLAYER_MODE=1: solve fleet off (no job dispatcher, box keeper, ledger/proposals/runbook/tasks)");
app.get("/api/dashboard/config", (c) => c.json({ playerMode }));
if (playerMode) {
  // owner-only writes and pages answer 404 rather than half-working without the fleet behind them
  const gone = (c: any) => c.json({ ok: false, error: "not part of this install (player mode)" }, 404);
  app.use("/api/dashboard/miss-queue/*", async (c, next) => (c.req.method === "GET" ? next() : gone(c)));
  app.use("/api/dashboard/tasks", gone);
  app.use("/api/dashboard/tasks/*", gone);
}

// Middleware
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
app.route("/api/dashboard/sources", sourcesRoutes);
app.route("/api/dashboard/miss-queue", missQueueRoutes);
if (!playerMode) app.route("/api/ledger", ledgerRoutes);
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
const PLAYER_HEAD = `<script>window.PLAYER_MODE = true;</script>
<style>#tab-ledger, #tab-tasks, .fleet-only { display: none !important; }</style>`;
const dashboardPage = async () => {
  if (!playerMode) {
    return new Response(Bun.file(`${import.meta.dir}/dashboard.html`), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  // player mode: the same page, told so before any of its script runs (no second copy of the page to drift)
  const html = (await Bun.file(`${import.meta.dir}/dashboard.html`).text()).replace("</head>", `${PLAYER_HEAD}\n</head>`);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
};
// The dashboard's stylesheet lives beside the page (dashboard.css) so it can be
// read and edited as one file; served uncached, like the page, so an edit is live.
app.get("/dashboard.css", () =>
  new Response(Bun.file(`${import.meta.dir}/dashboard.css`), {
    headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
  }));
const OWNER_PAGES = ["/ledger", "/ledger/*", "/runbook", "/runbook/*", "/proposals", "/proposals/*", "/tasks", "/tasks/*"];
for (const p of ["/", "/home", "/hands", "/hands/*", "/analytics", "/sources", "/sources/*", "/sessions", "/sessions/*", "/profiles", "/profiles/*", "/review", "/playthrough", "/playthrough/*", ...OWNER_PAGES]) {
  if (playerMode && OWNER_PAGES.includes(p)) app.get(p, (c) => c.redirect("/", 302));
  else app.get(p, dashboardPage);
}
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
const port = process.env.PORT || 2000;

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
// central poker.sqlite before anything writes, and refuse to run as the LIVE API with its records split — an env
// override that points one store outside the root is exactly how hand 973's chains and answers came apart.
{
  const stores = resolveAllStores();
  console.log(describeLayout());
  for (const s of stores.filter((x) => x.override)) console.log(`[data-root]   ${s.store} → ${s.path} (${s.override})`);
  const liveApi = String(port) === "2000" && !dashboardOnly;
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
  if (liveApi) {
    try {
      const line = adoptAtStartup((l) => console.log(l));
      if (line) say(line);
      // an old-code wrapper still writing a legacy file: fold its new rows in every minute until it lets go
      startAdoptionCatchUp((l) => console.log(l));
    } catch (e) {
      console.error(`[data-root] adoption failed: ${e instanceof Error ? e.message : e}`);
    }
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
onBackgroundOwnership(() => {
  // Always running, self-gating on assistive-play's own "Study Answers" toggle
  // (see services/studyPoller.ts) — that toggle is the single control; no
  // separate start step needed for normal use.
  if (!dashboardOnly) studyPoller.start();

  // Keep a live GTOW access token on hand at all times: the CDP sniff costs
  // 4-8s, and paying it inline made whichever solve hit the ~15-min expiry miss
  // the decision window entirely.
  if (!dashboardOnly) gtowApi.startTokenKeeper();

  // The box keeper: keeps the HRC boxes solving on their own (relaunch HRC, restart a hung one, re-queue a failed shard).
  if (!dashboardOnly && !playerMode) boxKeeper.start();

  // Settles WHY a decision got no answer once its hand is archived: attaches the
  // failures the poller could not pin to a hand, and writes a no-probe row for a
  // decision nobody ever asked about (services/answerReconciler.ts).
  if (!dashboardOnly) answerReconciler.start();

  // Checks every hand archived from here on against Ignition's own hand history (services/hhCheck.ts).
  if (!dashboardOnly) hhChecker.start();
});

// The ledger's job runner: one job per lane at a time, logs under data/jobs/. The timer always runs
// (the routes read job rows through it); its dispatch tick is what the lock gates.
if (!playerMode) jobs.start();

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
