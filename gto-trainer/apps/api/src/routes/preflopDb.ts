import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Read-only window into the crawled preflop DB (data/preflop-db.sqlite,
 * written by scripts/crawlPreflopTree.ts) for the analysis dashboard's
 * range-browser tab. The crawler writes WAL, so these queries always see
 * the latest committed nodes while a crawl is still running.
 */
const app = new Hono();

const DB_PATH = join(import.meta.dir, "..", "..", "data", "preflop-db.sqlite");

let db: Database | null = null;
const open = (): Database | null => {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  db = new Database(DB_PATH, { readonly: true });
  return db;
};

interface SetRow {
  gametype: string;
  depth: number;
  nodes: number;
  terminals: number;
  lastCrawledAt: number;
}

app.get("/sets", (c) => {
  const d = open();
  if (!d) return c.json({ ok: false, error: "preflop-db.sqlite not found" }, 503);
  const sets = d
    .query<SetRow, []>(
      `SELECT gametype, depth, COUNT(*) AS nodes,
              SUM(terminal) AS terminals, MAX(crawled_at) AS lastCrawledAt
       FROM nodes GROUP BY gametype, depth ORDER BY gametype, depth`
    )
    .all();
  const frontier = d
    .query<{ gametype: string; depth: number; remaining: number }, []>(
      "SELECT gametype, depth, COUNT(*) AS remaining FROM frontier GROUP BY gametype, depth"
    )
    .all();
  const fmap = new Map(frontier.map((f) => [`${f.gametype}|${f.depth}`, f.remaining]));
  return c.json({
    ok: true,
    sets: sets.map((s) => ({ ...s, frontier: fmap.get(`${s.gametype}|${s.depth}`) ?? 0 })),
  });
});

interface NodeRow {
  line: string;
  pos: string | null;
  reach: number;
  terminal: number;
  actions: string;
}

app.get("/tree", (c) => {
  const d = open();
  if (!d) return c.json({ ok: false, error: "preflop-db.sqlite not found" }, 503);
  const gametype = c.req.query("gametype");
  const depth = Number(c.req.query("depth"));
  if (!gametype || !Number.isFinite(depth)) {
    return c.json({ ok: false, error: "gametype and depth are required" }, 400);
  }
  const rows = d
    .query<NodeRow, [string, number]>(
      "SELECT line, pos, reach, terminal, actions FROM nodes WHERE gametype=? AND depth=? ORDER BY line"
    )
    .all(gametype, depth);
  return c.json({
    ok: true,
    nodes: rows.map((r) => ({
      line: r.line,
      pos: r.pos,
      reach: r.reach,
      terminal: r.terminal === 1,
      actions: JSON.parse(r.actions),
    })),
  });
});

app.get("/node", (c) => {
  const d = open();
  if (!d) return c.json({ ok: false, error: "preflop-db.sqlite not found" }, 503);
  const gametype = c.req.query("gametype");
  const depth = Number(c.req.query("depth"));
  const line = c.req.query("line");
  if (!gametype || !Number.isFinite(depth) || line == null) {
    return c.json({ ok: false, error: "gametype, depth and line are required" }, 400);
  }
  const row = d
    .query<NodeRow & { cells: string }, [string, number, string]>(
      "SELECT line, pos, reach, terminal, actions, cells FROM nodes WHERE gametype=? AND depth=? AND line=?"
    )
    .get(gametype, depth, line);
  if (!row) return c.json({ ok: false, error: "node not found" }, 404);
  return c.json({
    ok: true,
    node: {
      line: row.line,
      pos: row.pos,
      reach: row.reach,
      terminal: row.terminal === 1,
      actions: JSON.parse(row.actions),
      cells: JSON.parse(row.cells),
    },
  });
});

export default app;
