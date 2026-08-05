/**
 * SUPERSEDED by exportAnteFlopRanges.ts — keep for the crawl-DB tooling, but
 * do NOT use its output for the solve fleet: at a player's second decision it
 * writes P(action | reached), not the arrival weight, which made the SB's
 * 3-bet-defend range ~10x too wide. The replacement reads each config's
 * flop-entering ranges directly from GTO Wizard's API.
 *
 * Export solver-format preflop ranges for the CoinPoker ANTE tree, from the
 * crawled preflop DB into analysis/pipeline/solve/ranges/ante/.
 *
 * Why this exists: the postflop solve fleet reads solve/ranges/*.txt, and those
 * were scraped from Cash6m500zGeneral25Open — a NON-ante tree. CoinPoker posts
 * 0.166bb/player, so every range feeding the fleet is for a different game.
 * This writes the same 29 charts from the ante tree instead.
 *
 * Why not just re-run exportPreflopRanges.ts against the ante gametype: that
 * script scrapes GTO Wizard over CDP, one navigation per chart. The crawler has
 * already captured these nodes, so this reads them out of SQLite — no client,
 * no navigation, instant, and it can't drift from what was crawled.
 *
 * Line resolution is NOT literal. The ante tree's bet sizes differ from the
 * non-ante tree's (it 3-bets to 11 where the other goes to 12, and so on), so
 * "F-F-F-R2.5-F-R13" simply doesn't exist there. Each chart's line is walked
 * token by token and re-expressed in the ante tree's OWN sizes, matching on
 * action type (fold / call / raise) and, among several raises, on the closest
 * size. A chart whose line can't be walked is reported and skipped rather than
 * silently emitted wrong.
 *
 * Usage (from apps/api):
 *   bun run src/scripts/exportAnteRanges.ts                 # depth 100.166
 *   bun run src/scripts/exportAnteRanges.ts --depth 60.166
 *   bun run src/scripts/exportAnteRanges.ts --dry-run
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) {
    const n = process.argv[i + 1];
    args.set(a.slice(2), n == null || n.startsWith("--") ? "1" : process.argv[++i]!);
  }
}
const DEPTH = parseFloat(args.get("depth") ?? "100.166");
const GAMETYPE = args.get("gametype") ?? "Cash6mSimple_6mCPante0166BCCNL200R25";
const DRY = args.has("dry-run");

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const RANGES = join(REPO, "analysis", "pipeline", "solve", "ranges");
const OUT_DIR = join(RANGES, "ante");
const DB_PATH = join(import.meta.dir, "..", "..", "data", "preflop-db.sqlite");

interface StoredAction { action: string; rangePct: number | null; combos: number | null; token: string | null }
interface StoredCell { hand: string; actions: Record<string, number> }

// NOT readonly, despite this script only ever issuing SELECTs. The DB is in
// WAL mode, and once the crawler exits and checkpoints, the -wal/-shm sidecars
// are gone; a readonly open then fails with "unable to open database file"
// because SQLite cannot create the shared-memory file it needs. Opening
// read-write lets it recreate them. Nothing here writes.
const db = new Database(DB_PATH);
const qNode = db.query<{ pos: string | null; actions: string; cells: string }, [string, number, string]>(
  "SELECT pos, actions, cells FROM nodes WHERE gametype=? AND depth=? AND line=?"
);
const getNode = (line: string) => {
  const r = qNode.get(GAMETYPE, DEPTH, line);
  if (!r) return null;
  return { pos: r.pos, actions: JSON.parse(r.actions) as StoredAction[], cells: JSON.parse(r.cells) as StoredCell[] };
};

/** "R2.5" -> 2.5 ; "RAI" -> Infinity ; non-sized -> null */
const sizeOf = (token: string): number | null =>
  token === "RAI" ? Infinity : token.startsWith("R") ? parseFloat(token.slice(1)) : null;

/**
 * Re-express a non-ante line in the ante tree's own tokens. Walks from the
 * root; at each step picks the action of the same KIND, and among raises the
 * one closest in size to what the source line intended.
 */
function resolveLine(srcLine: string): { ok: true; line: string } | { ok: false; at: string; reason: string } {
  const want = srcLine === "" ? [] : srcLine.split("-");
  const out: string[] = [];
  for (const tok of want) {
    const node = getNode(out.join("-"));
    if (!node) return { ok: false, at: out.join("-") || "(root)", reason: "node not crawled" };
    const offered = node.actions.map((a) => a.token).filter((t): t is string => t != null);
    if (offered.includes(tok)) { out.push(tok); continue; }
    const wantSize = sizeOf(tok);
    if (wantSize == null) return { ok: false, at: out.join("-") || "(root)", reason: `"${tok}" not offered (have ${offered.join(",")})` };
    // closest raise by size
    const raises = offered.map((t) => [t, sizeOf(t)] as const).filter((x): x is readonly [string, number] => x[1] != null);
    if (!raises.length) return { ok: false, at: out.join("-") || "(root)", reason: `no raise offered (have ${offered.join(",")})` };
    let best = raises[0]!;
    for (const r of raises) if (Math.abs(r[1] - wantSize) < Math.abs(best[1] - wantSize)) best = r;
    out.push(best[0]);
  }
  return { ok: true, line: out.join("-") };
}

/** Pick the action on a node matching the chart's intent ("Call" / "Raise 2.5"). */
function pickAction(actions: StoredAction[], want: string): StoredAction | null {
  const kind = want.split(/\s+/)[0]!.toLowerCase();
  const cands = actions.filter((a) => a.action.toLowerCase().startsWith(kind));
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0]!;
  const wantSize = parseFloat(want.split(/\s+/)[1] ?? "");
  if (!Number.isFinite(wantSize)) return cands[0]!;
  return cands.reduce((b, a) => {
    const sa = parseFloat(a.action.split(/\s+/)[1] ?? "NaN");
    const sb = parseFloat(b.action.split(/\s+/)[1] ?? "NaN");
    if (!Number.isFinite(sa)) return b;
    if (!Number.isFinite(sb)) return a;
    return Math.abs(sa - wantSize) < Math.abs(sb - wantSize) ? a : b;
  });
}

/** Solver format: "AA,AKs,J3s:0.315" — weight suffix only when fractional. */
function toRangeText(cells: StoredCell[], label: string): { text: string; classes: number; frac: number } {
  const parts: string[] = [];
  let frac = 0;
  for (const c of cells) {
    const pct = c.actions[label] ?? 0;
    if (pct <= 0) continue;
    const w = pct / 100;
    if (w >= 0.9995) parts.push(c.hand);
    else { parts.push(`${c.hand}:${w.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`); frac++; }
  }
  return { text: parts.join(","), classes: parts.length, frac };
}

// ---- run ----
const srcManifest = JSON.parse(readFileSync(join(RANGES, "manifest.json"), "utf8")) as Record<
  string, { line: string; node_position: string; action: string; range_pct: number }
>;

const nodeCount = db
  .query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM nodes WHERE gametype=? AND depth=?")
  .get(GAMETYPE, DEPTH)!.n;
console.log(`source: ${GAMETYPE} @ ${DEPTH}bb  (${nodeCount} nodes crawled)\n`);
if (!nodeCount) { console.error("nothing crawled at this depth — pick another with --depth"); process.exit(1); }

const outManifest: Record<string, unknown> = {};
const rows: string[] = [];
let wrote = 0, skipped = 0;

for (const [name, src] of Object.entries(srcManifest)) {
  const res = resolveLine(src.line);
  if (!res.ok) { console.log(`  SKIP ${name.padEnd(22)} — ${res.reason} at "${res.at}"`); skipped++; continue; }
  const node = getNode(res.line);
  if (!node) { console.log(`  SKIP ${name.padEnd(22)} — resolved line "${res.line}" not crawled`); skipped++; continue; }
  const act = pickAction(node.actions, src.action);
  if (!act) { console.log(`  SKIP ${name.padEnd(22)} — no "${src.action}" at "${res.line}" (have ${node.actions.map((a) => a.action).join(", ")})`); skipped++; continue; }
  const { text, classes, frac } = toRangeText(node.cells, act.action);
  if (!text) { console.log(`  SKIP ${name.padEnd(22)} — empty range for "${act.action}"`); skipped++; continue; }

  if (!DRY) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${name}.txt`), text + "\n");
  }
  outManifest[name] = {
    name, gametype: GAMETYPE, depth: DEPTH,
    source_line: src.line, resolved_line: res.line,
    node_position: node.pos, action: act.action,
    range_pct: act.rangePct, combos: act.combos,
    classes, fractional_classes: frac,
    non_ante_range_pct: src.range_pct,
    delta_pp: act.rangePct == null ? null : +(act.rangePct - src.range_pct).toFixed(1),
    exported_at: new Date().toISOString(),
  };
  const d = act.rangePct == null ? null : act.rangePct - src.range_pct;
  rows.push(
    `  ${name.padEnd(22)} ${String(act.rangePct ?? "?").padStart(6)}%  vs ${String(src.range_pct).padStart(5)}%  ` +
    `${d == null ? "" : (d >= 0 ? "+" : "") + d.toFixed(1) + "pp"}${src.line !== res.line ? `   [line ${src.line || "(root)"} -> ${res.line || "(root)"}]` : ""}`
  );
  wrote++;
}

if (!DRY && wrote) {
  writeFileSync(join(RANGES, "manifest_ante.json"), JSON.stringify(outManifest, null, 2) + "\n");
}

console.log(`\n${"chart".padEnd(24)}  ANTE   vs non-ante   delta`);
console.log(rows.join("\n"));
console.log(`\n${wrote} written, ${skipped} skipped${DRY ? "  (dry run — nothing saved)" : ""}`);
if (!DRY && wrote) {
  console.log(`\nranges   -> analysis/pipeline/solve/ranges/ante/*.txt`);
  console.log(`manifest -> analysis/pipeline/solve/ranges/manifest_ante.json`);
}
