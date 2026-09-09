import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import solverRoutes from "./src/routes/solver";
import gtowRoutes from "./src/routes/gtow";
import ingestRoutes from "./src/routes/ingest";
import analysisRoutes from "./src/routes/analysis";
import studyPollerRoutes from "./src/routes/studyPoller";
import preflopDbRoutes from "./src/routes/preflopDb";
import gtowApiRoutes from "./src/routes/gtowApi";
import feedSpotRoutes from "./src/routes/feedSpot";
import fastSolverRoutes from "./src/routes/fastSolver";
import aiSolveRoutes from "./src/routes/aiSolve";
import aiStudyRoutes from "./src/routes/aiStudy";
import dashboardRoutes from "./src/routes/dashboard";
import sourcesRoutes from "./src/routes/sources";
import missQueueRoutes from "./src/routes/missQueue";
import ledgerRoutes from "./src/routes/ledger";
import { jobs } from "./src/services/jobs";
import replayRoutes from "./src/routes/replay";
import studyUiRoutes from "./src/routes/studyUi";
import { studyPoller } from "./src/services/studyPoller";
import { gtowApi } from "./src/services/gtowApi";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Routes
app.route("/api", solverRoutes);
app.route("/api/gtow", gtowRoutes);
app.route("/api/ingest", ingestRoutes);
app.route("/api/analysis", analysisRoutes);
app.route("/api/study-poller", studyPollerRoutes);
app.route("/api/preflop-db", preflopDbRoutes);
app.route("/api/gtow-api", gtowApiRoutes);
app.route("/api/feed-spot", feedSpotRoutes);
app.route("/api/fast-solver", fastSolverRoutes);
app.route("/api/ai-solve", aiSolveRoutes);
app.route("/api/ai-study", aiStudyRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/dashboard/sources", sourcesRoutes);
app.route("/api/dashboard/miss-queue", missQueueRoutes);
app.route("/api/ledger", ledgerRoutes);
app.route("/api/replay", replayRoutes);

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
  new Response(Bun.file(`${import.meta.dir}/dashboard.html`), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
for (const p of ["/", "/hands", "/hands/*", "/analytics", "/sources", "/sources/*", "/sessions", "/sessions/*", "/review", "/playthrough", "/playthrough/*", "/ledger", "/ledger/*", "/runbook", "/runbook/*", "/proposals", "/proposals/*"]) {
  app.get(p, dashboardPage);
}
// Old bookmarks and links still land on the dashboard.
app.get("/dashboard", (c) => c.redirect("/", 301));

// API index — what the JSON endpoints are and where they live.
app.get("/api", (c) => {
  return c.json({
    name: "Poker GTO Bot API",
    version: "1.0.0",
    description:
      "Heads-up postflop GTO solver — postflop-solver (Rust→WASM, in-process). " +
      "Solves novel bet sizes live; caches repeated spots. Preflop/multiway not supported.",
    endpoints: {
      health: "GET /api/health",
      solve: "POST /api/solve",
      gtowStatus: "GET /api/gtow/status",
      gtowSolutionSet: "POST /api/gtow/solution-set",
      gtowFacingBet: "GET /api/gtow/facing-bet?hand=AhKs&size=55",
      gtowRespond: "GET /api/gtow/respond?hand=AhKs&size=55",
      gtowAiSolve: "POST /api/gtow/ai-solve",
      gtowCombo: "GET /api/gtow/combo?hand=AhKs",
      gtowDecide: "GET /api/gtow/decide?hand=AhKs",
      gtowBoard: "POST /api/gtow/board",
      gtowAction: "POST /api/gtow/action",
      ingest: "POST /api/ingest — { rows | text | live } from the panel live feed",
      fastSolver: "POST /api/fast-solver — { hand | live | rows | text } → local preflop charts + GTOW spot-solution API (no live nav)",
      aiSolve: "POST /api/ai-solve — { board, pot, stack, oopRange, ipRange, heroSeat, heroCards? } → exploit solve vs CUSTOM ranges (GTOW cloud, ~2s)",
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

// Always running, self-gating on assistive-play's own "Study Answers" toggle
// (see services/studyPoller.ts) — that toggle is the single control; no
// separate start step needed for normal use.
// DASHBOARD_ONLY=1 (the cloud deployment): no poker client, no GTO Wizard, no study wrapper on the
// box — the poller and the token keeper would only log connection errors every few seconds.
const dashboardOnly = process.env.DASHBOARD_ONLY === "1";
if (dashboardOnly) console.log("DASHBOARD_ONLY=1: study poller and GTOW token keeper are off");
if (!dashboardOnly) studyPoller.start();

// Keep a live GTOW access token on hand at all times: the CDP sniff costs
// 4-8s, and paying it inline made whichever solve hit the ~15-min expiry miss
// the decision window entirely.
if (!dashboardOnly) gtowApi.startTokenKeeper();

// The ledger's job runner: one job per lane at a time, logs under data/jobs/.
jobs.start();

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
