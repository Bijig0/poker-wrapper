import { Hono } from "hono";
import { gtowApi, type SpotSolutionParams } from "../services/gtowApi";
import { toClassWeights, toRangeString } from "../utils/comboIndex/comboIndex";

/**
 * Thin HTTP wrapper over GTO Wizard's private spot-solution API (see
 * services/gtowApi.ts). Postflop library answers as JSON — both players' ranges
 * and per-action strategy — resolved via the always-running desktop client's
 * bearer token. HU postflop only (that's all GTOW's library holds).
 */
const app = new Hono();

app.get("/spot-solution", async (c) => {
  const p: SpotSolutionParams = {
    gametype: c.req.query("gametype") ?? "",
    depth: Number(c.req.query("depth") ?? "100"),
    preflop_actions: c.req.query("preflop_actions") ?? "",
    flop_actions: c.req.query("flop_actions") ?? undefined,
    turn_actions: c.req.query("turn_actions") ?? undefined,
    river_actions: c.req.query("river_actions") ?? undefined,
    board: c.req.query("board") ?? "",
  };
  if (!p.gametype || !p.preflop_actions || !p.board) {
    return c.json({ ok: false, error: "gametype, preflop_actions and board are required" }, 400);
  }

  const raw = c.req.query("raw") === "1";
  const result = await gtowApi.spotSolution(p);
  if (!result.ok) return c.json(result, result.status === 0 ? 503 : 502);
  if (raw) return c.json(result.data);

  // Parsed view: strategy per action (as 169-class weights) + both ranges.
  const j = result.data;
  const actions = (j.action_solutions ?? []).map((a: any) => ({
    action: a.action.display_name,
    code: a.action.code,
    frequency: a.total_frequency,
    ev: a.total_ev,
    combos: a.total_combos,
    classStrategy: toClassWeights(a.strategy),
  }));
  const ranges = (j.players_info ?? []).map((pi: any) => ({
    position: pi.player.position,
    seat: pi.player.relative_postflop_position, // "OOP" | "IP"
    stack: pi.player.current_stack,
    rangeString: toRangeString(pi.range),
    classRange: toClassWeights(pi.range),
  }));

  return c.json({ ok: true, spot: p, actions, ranges, warning: j.warning ?? null });
});

export default app;
