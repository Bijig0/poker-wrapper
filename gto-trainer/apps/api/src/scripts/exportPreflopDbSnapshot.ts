import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dump the crawled preflop DB to static JSON under analysis/public/preflop-db/
 * so the deployed analysis dashboard (Cloudflare Pages) can browse the ranges
 * without reaching this machine's API. Run before `npm run build` in analysis/:
 *
 *   bun run src/scripts/exportPreflopDbSnapshot.ts
 *
 * Writes sets.json plus one <gametype>-<depth>.json per tree (nodes with
 * cells inline — the biggest tree is ~700KB raw and compresses well).
 */

const DB_PATH = join(import.meta.dir, "..", "..", "data", "preflop-db.sqlite");
const OUT_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "analysis", "public", "preflop-db");

const db = new Database(DB_PATH, { readonly: true });
mkdirSync(OUT_DIR, { recursive: true });

interface SetRow {
  gametype: string;
  depth: number;
  nodes: number;
  terminals: number;
  lastCrawledAt: number;
}

const sets = db
  .query<SetRow, []>(
    `SELECT gametype, depth, COUNT(*) AS nodes,
            SUM(terminal) AS terminals, MAX(crawled_at) AS lastCrawledAt
     FROM nodes GROUP BY gametype, depth ORDER BY gametype, depth`
  )
  .all();
const frontier = db
  .query<{ gametype: string; depth: number; remaining: number }, []>(
    "SELECT gametype, depth, COUNT(*) AS remaining FROM frontier GROUP BY gametype, depth"
  )
  .all();
const fmap = new Map(frontier.map((f) => [`${f.gametype}|${f.depth}`, f.remaining]));

writeFileSync(
  join(OUT_DIR, "sets.json"),
  JSON.stringify({
    ok: true,
    exportedAt: Date.now(),
    sets: sets.map((s) => ({ ...s, frontier: fmap.get(`${s.gametype}|${s.depth}`) ?? 0 })),
  })
);

interface NodeRow {
  line: string;
  pos: string | null;
  reach: number;
  terminal: number;
  actions: string;
  cells: string;
}

let total = 0;
for (const s of sets) {
  const rows = db
    .query<NodeRow, [string, number]>(
      "SELECT line, pos, reach, terminal, actions, cells FROM nodes WHERE gametype=? AND depth=? ORDER BY line"
    )
    .all(s.gametype, s.depth);
  const out = {
    ok: true,
    nodes: rows.map((r) => ({
      line: r.line,
      pos: r.pos,
      reach: r.reach,
      terminal: r.terminal === 1,
      actions: JSON.parse(r.actions),
      cells: JSON.parse(r.cells),
    })),
  };
  const file = `${s.gametype}-${s.depth}.json`;
  writeFileSync(join(OUT_DIR, file), JSON.stringify(out));
  total += rows.length;
  console.log(`${file}: ${rows.length} nodes`);
}
console.log(`Exported ${total} nodes across ${sets.length} trees to ${OUT_DIR}`);
