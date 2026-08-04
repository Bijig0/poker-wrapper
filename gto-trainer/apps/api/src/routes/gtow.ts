import { Hono } from "hono";
import { gtowCdp, parseCards, SOLUTION_SETS } from "../services/gtowCdp";

/**
 * Controller routes for the GTO Wizard teaching aid. All endpoints talk to the
 * running GTO Wizard app over CDP; if it isn't launched with remote debugging,
 * they return { connected: false } rather than throwing.
 *
 * Card setting is street-gated: a street's cards can only be set once the prior
 * street's action is closed — enforced by reading GTO Wizard's own DOM state.
 */
const app = new Hono();

/**
 * One-click launch: start (or relaunch) the local GTO Wizard app with remote
 * debugging so the controller can attach — the button version of the manual
 * `open -a "GTO Wizard" --args --remote-debugging-port=9222`. Local-only:
 * spawns the desktop app on this Mac; takes no input from the request.
 */
app.post("/launch", async (c) => {
  try {
    const result = await gtowCdp.launchApp();
    return c.json(result, result.ok ? 200 : 504);
  } catch (e) {
    return c.json({ ok: false, connected: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/status", async (c) => {
  if (!(await gtowCdp.isConnected())) {
    return c.json({
      connected: false,
      hint: 'Launch GTO Wizard with: open -a "GTO Wizard" --args --remote-debugging-port=9222',
    });
  }
  try {
    const [status, spots, boardState, solution, blocker] = await Promise.all([
      gtowCdp.status(),
      gtowCdp.readSpots(),
      gtowCdp.boardState(),
      gtowCdp.currentSolution(),
      gtowCdp.studyBlocker(),
    ]);
    return c.json({
      connected: true,
      ...status,
      spots,
      boardState,
      solution,
      solutionSets: SOLUTION_SETS,
      blocker,
    });
  } catch (e) {
    return c.json({ connected: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/solution-set", async (c) => {
  const { id, depth } = await c.req.json().catch(() => ({}));
  if (typeof id !== "string") {
    return c.json({ ok: false, error: "Body needs { id: string, depth?: number }" }, 400);
  }
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  try {
    const result = await gtowCdp.setSolutionSet(id, typeof depth === "number" ? depth : undefined);
    return c.json(result, result.ok ? 200 : 400);
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * One-click spot setup: load a solution set at a stack depth and auto-walk
 * the preflop tree to a heads-up pot between the two seats (~5-15s).
 */
app.post("/setup-spot", async (c) => {
  const { setId, depth, heroSeat, villainSeat, potType } = await c.req.json().catch(() => ({}));
  if (
    typeof setId !== "string" ||
    typeof depth !== "number" ||
    typeof heroSeat !== "string" ||
    typeof villainSeat !== "string" ||
    (potType !== "SRP" && potType !== "3bet")
  ) {
    return c.json(
      { ok: false, error: "Body needs { setId, depth, heroSeat, villainSeat, potType: \"SRP\"|\"3bet\" }" },
      400
    );
  }
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  const blocked = await blockerGuard();
  if (blocked) return c.json(blocked, 503);
  try {
    const result = await gtowCdp.setupSpot({ setId, depth, heroSeat, villainSeat, potType });
    return c.json(result, result.ok ? 200 : 422);
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.post("/board", async (c) => {
  const { cards } = await c.req.json().catch(() => ({ cards: "" }));
  try {
    parseCards(cards ?? ""); // validate format/count before touching the app
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  try {
    const result = await gtowCdp.setCards(cards);
    // street-gating rejection is a 409 (valid request, not allowed in this state)
    return c.json(result, result.ok ? 200 : result.blocked ? 409 : 422);
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/combo", async (c) => {
  const hand = c.req.query("hand") ?? "";
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  try {
    // per-combo postflop, class grid preflop
    return c.json(await gtowCdp.readComboAuto(hand));
  } catch (e) {
    // parse errors are user input problems → 400
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.get("/decide", async (c) => {
  const hand = c.req.query("hand") ?? "";
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  try {
    return c.json(await gtowCdp.decideCombo(hand));
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/**
 * 503 with GTO Wizard's own message when its blocking overlay is up (e.g.
 * the daily browsing limit) — navigation and solving don't work behind it.
 */
async function blockerGuard() {
  const blocker = await gtowCdp.studyBlocker().catch(() => ({ blocked: false as const }));
  if (!blocker.blocked) return null;
  return {
    ok: false as const,
    blocked: true as const,
    err: `GTO Wizard is unavailable: ${("message" in blocker && blocker.message) || "limit reached"}`,
  };
}

/** Tier 2: run a live GTO Wizard AI solve for a flop board (~2-20s). */
app.post("/ai-solve", async (c) => {
  const { board, betSize } = await c.req.json().catch(() => ({ board: "" }));
  const size = betSize == null || betSize === "" ? undefined : Number(betSize);
  if (size !== undefined && (!Number.isFinite(size) || size <= 0)) {
    return c.json({ ok: false, error: "betSize must be a positive number (% of pot) or omitted." }, 400);
  }
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  const blocked = await blockerGuard();
  if (blocked) return c.json(blocked, 503);
  try {
    const result = await gtowCdp.aiSolve(board ?? "", size);
    return c.json(result, result.ok ? 200 : 422);
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/**
 * Combo Trainer: given the size villain bets at the active node, return hero's
 * correct response by the cheapest sound route (library → translated → resolved).
 */
app.get("/respond", async (c) => {
  const hand = c.req.query("hand") ?? "";
  const size = Number(c.req.query("size"));
  if (!Number.isFinite(size) || size <= 0) {
    return c.json({ ok: false, error: "Query needs a positive numeric ?size (pct of pot)." }, 400);
  }
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  const blocked = await blockerGuard();
  if (blocked) return c.json(blocked, 503);
  try {
    return c.json(await gtowCdp.respondToBet(hand, size));
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** Tier 1: translate an off-tree villain bet size and read hero's response. */
app.get("/facing-bet", async (c) => {
  const hand = c.req.query("hand") ?? "";
  const size = Number(c.req.query("size"));
  if (!Number.isFinite(size) || size <= 0) {
    return c.json({ ok: false, error: "Query needs a positive numeric ?size (pct of pot)." }, 400);
  }
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  const blocked = await blockerGuard();
  if (blocked) return c.json(blocked, 503);
  try {
    return c.json(await gtowCdp.facingBet(hand, size));
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.post("/action", async (c) => {
  const { spotIndex, action } = await c.req.json().catch(() => ({}));
  if (typeof spotIndex !== "number" || typeof action !== "string") {
    return c.json({ ok: false, error: "Body needs { spotIndex: number, action: string }" }, 400);
  }
  if (!(await gtowCdp.isConnected())) {
    return c.json({ ok: false, error: "GTO Wizard not connected" }, 503);
  }
  try {
    return c.json(await gtowCdp.setAction(spotIndex, action));
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default app;
