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
import fastSolverRoutes from "./src/routes/fastSolver";
import aiSolveRoutes from "./src/routes/aiSolve";
import aiStudyRoutes from "./src/routes/aiStudy";
import { studyPoller } from "./src/services/studyPoller";

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
app.route("/api/fast-solver", fastSolverRoutes);
app.route("/api/ai-solve", aiSolveRoutes);
app.route("/api/ai-study", aiStudyRoutes);

// Root endpoint
app.get("/", (c) => {
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
      aiStudy: "POST /api/ai-study — { preflop, board, tokens } → study-UI node solution for ANY HU line via GTOW cloud (chart-reconstructed ranges)",
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
studyPoller.start();

export default {
  port,
  fetch: app.fetch,
  // Tier-2 AI re-solves hold the request open for up to a few minutes
  // (solve + line replay + on-demand street solves); Bun's default is 10s.
  idleTimeout: 255,
};
