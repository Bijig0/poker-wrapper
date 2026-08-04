import { Hono } from "hono";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Analysis Solve: read-only window into the solve-farm pipeline at
 * analysis/pipeline/solve — job list, telemetry (the pipeline's per-solve
 * "messages"), and the solved flop trees it writes under results/.
 * The pipeline has no push channel; the dashboard polls these endpoints,
 * which read the pipeline's own artifacts off disk.
 */
const app = new Hono();

// gto-trainer sits next to analysis/ inside the poker repo; overridable for
// worktrees and remote mounts.
const SOLVE_DIR =
  process.env.ANALYSIS_SOLVE_DIR ??
  join(import.meta.dir, "..", "..", "..", "..", "..", "analysis", "pipeline", "solve");

const RESULTS_DIR = join(SOLVE_DIR, "results");

const SAFE = /^[A-Za-z0-9_.-]+$/;

interface TelemetryRow {
  job: string;
  secs: number;
  solve_secs?: number;
  expl_pct?: number;
  nodes?: number;
  bytes_gz?: number;
  profile?: string;
}

const readTelemetry = (): { rows: TelemetryRow[]; mtimeMs: number | null } => {
  let rows: TelemetryRow[] = [];
  let mtimeMs: number | null = null;
  if (!existsSync(RESULTS_DIR)) return { rows, mtimeMs };
  for (const f of readdirSync(RESULTS_DIR)) {
    const dir = join(RESULTS_DIR, f);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!/^telemetry.*\.jsonl$/.test(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      mtimeMs = Math.max(mtimeMs ?? 0, st.mtimeMs);
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          rows.push(JSON.parse(t) as TelemetryRow);
        } catch {
          // partial line mid-write — the pipeline appends live; skip it
        }
      }
    }
  }
  return { rows, mtimeMs };
};

app.get("/status", (c) => {
  if (!existsSync(SOLVE_DIR)) {
    return c.json({
      ok: false,
      available: false,
      solveDir: SOLVE_DIR,
      error: "analysis/pipeline/solve not found — set ANALYSIS_SOLVE_DIR.",
    });
  }

  // total planned jobs
  let jobsTotal = 0;
  const jobsPath = join(SOLVE_DIR, "jobs.jsonl");
  if (existsSync(jobsPath)) {
    jobsTotal = readFileSync(jobsPath, "utf8").split("\n").filter((l) => l.trim()).length;
  }

  // configs + tree profiles
  let configs: unknown[] = [];
  let treeProfiles: unknown = null;
  const configsPath = join(SOLVE_DIR, "configs.json");
  if (existsSync(configsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configsPath, "utf8"));
      configs = parsed.configs ?? [];
      treeProfiles = parsed.tree_profiles ?? null;
    } catch {
      // malformed configs.json — report the rest of the status anyway
    }
  }

  // local results inventory: results/<profile>/<config>/<flop>.json.gz
  const results: { profile: string; config: string; flops: string[] }[] = [];
  let lastResultMs: number | null = null;
  if (existsSync(RESULTS_DIR)) {
    for (const profile of readdirSync(RESULTS_DIR)) {
      const profileDir = join(RESULTS_DIR, profile);
      if (!statSync(profileDir).isDirectory()) continue;
      for (const config of readdirSync(profileDir)) {
        const configDir = join(profileDir, config);
        if (!statSync(configDir).isDirectory()) continue;
        const flops: string[] = [];
        for (const f of readdirSync(configDir)) {
          if (!f.endsWith(".json.gz")) continue;
          flops.push(f.replace(/\.json\.gz$/, ""));
          lastResultMs = Math.max(lastResultMs ?? 0, statSync(join(configDir, f)).mtimeMs);
        }
        if (flops.length) results.push({ profile, config, flops: flops.sort() });
      }
    }
  }

  const { rows: telemetry, mtimeMs: telemetryMs } = readTelemetry();
  const lastActivityMs = Math.max(lastResultMs ?? 0, telemetryMs ?? 0) || null;

  return c.json({
    ok: true,
    available: true,
    solveDir: SOLVE_DIR,
    jobsTotal,
    configs,
    treeProfiles,
    results,
    solvedLocally: results.reduce((s, r) => s + r.flops.length, 0),
    telemetryCount: telemetry.length,
    lastActivityMs,
    // "active" = the pipeline wrote something in the last 10 minutes
    active: lastActivityMs != null && Date.now() - lastActivityMs < 10 * 60 * 1000,
  });
});

/** The pipeline's per-solve messages, newest first. */
app.get("/telemetry", (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 50, 500);
  const { rows, mtimeMs } = readTelemetry();
  return c.json({ ok: true, mtimeMs, total: rows.length, rows: rows.slice(-limit).reverse() });
});

/** One solved flop tree: meta + per-node aggregate strategies. */
app.get("/result", (c) => {
  const profile = c.req.query("profile") ?? "lean";
  const config = c.req.query("config") ?? "";
  const flop = c.req.query("flop") ?? "";
  if (![profile, config, flop].every((s) => SAFE.test(s))) {
    return c.json({ ok: false, error: "profile/config/flop must be simple names." }, 400);
  }
  const path = join(RESULTS_DIR, profile, config, `${flop}.json.gz`);
  if (!existsSync(path)) {
    return c.json({ ok: false, error: `No local result for ${config}/${flop} (${profile}).` }, 404);
  }
  try {
    const raw = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
    // strategy/ev are per-hole arrays (one row per action, one entry per combo
    // in the acting player's range) — aggregate combo-weighted for display.
    const weightsFor = (player: number): number[] =>
      (player === 0 ? raw.oop_weights : raw.ip_weights) ?? [];
    const aggregate = (rows: number[][] | undefined, weights: number[]): number[] => {
      if (!rows?.length) return [];
      const wsum = weights.reduce((s, w) => s + w, 0);
      return rows.map((row) => {
        let acc = 0;
        for (let h = 0; h < row.length; h++) acc += row[h] * (weights[h] ?? 0);
        return wsum ? acc / wsum : 0;
      });
    };
    // history is a path of action INDICES from the root — resolve each step
    // to its parent node's action label ("Bet(323)") for display.
    interface RawNode {
      history?: (number | string)[];
      player?: number;
      actions?: string[];
      strategy?: number[][];
      ev?: number[][];
    }
    const rawNodes: RawNode[] = raw.flop_nodes ?? [];
    const byPath = new Map(rawNodes.map((n) => [(n.history ?? []).map(Number).join(","), n]));
    const labelHistory = (h: (number | string)[]): string[] =>
      h.map((step, i) => {
        const parent = byPath.get(h.slice(0, i).map(Number).join(","));
        return parent?.actions?.[Number(step)] ?? String(step);
      });

    return c.json({
      ok: true,
      config,
      flop,
      profile,
      meta: raw.meta ?? {},
      counts: {
        nodes: rawNodes.length,
        oopHoles: raw.oop_holes?.length ?? 0,
        ipHoles: raw.ip_holes?.length ?? 0,
      },
      nodes: rawNodes.map((n) => {
        const player = n.player ?? 0;
        const weights = weightsFor(player);
        return {
          history: labelHistory(n.history ?? []),
          player,
          actions: n.actions ?? [],
          strategy: aggregate(n.strategy, weights),
          ev: aggregate(n.ev, weights),
        };
      }),
    });
  } catch (e) {
    return c.json(
      { ok: false, error: `Couldn't read result: ${e instanceof Error ? e.message : String(e)}` },
      500
    );
  }
});

export default app;
