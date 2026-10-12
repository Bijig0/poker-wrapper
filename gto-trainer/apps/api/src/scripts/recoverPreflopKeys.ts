/**
 * RECOVER THE TREE KEY OF OLD AI PREFLOP RECORDS (2026-10-12). An AI preflop answer leaves a record of the tree its node
 * was read on (services/preflopPin.ts, in hand_facts); since 2026-10-04 the record carries the tree's key in the GTO
 * Wizard solve cache. An older record is keyed again from what it holds (gtowAiPreflop.preflopCacheKeyOf) — by TODAY's
 * tree builder, and the menus have changed since (fixed menus, iso sizes, 3-way menus), so the key it rebuilds is not the
 * one that answer POSTed and the hand page says "node 'root' is not in the GTO Wizard solve cache" (288 decisions,
 * 2026-09-19 → 10-04) while the tree itself may still be in the cache or its cold archive.
 *
 * Here each such record is matched to the stored tree it was read on: a preflop tree whose players are the record's
 * seats with the record's stacks, created before the answer (within MAX_AGE_MS), that holds the root and hero's node.
 * Several match (the same table shape solved again): the newest before the answer. Prints what it would do; `--write`
 * sets the record's `cacheKey` (and `cacheKeyRecovered: true`) in hand_facts. Rebuild the stored hand nodes after
 * (scripts/buildHandNodes.ts --rebuild-undrawn).
 *
 * RUN 2026-10-12: 215 recovered (201 one match, 14 newest of several); checked against each answer's logged mix (hero's
 * class at the recovered node vs answers.decision_json, total-variation distance): 209 identical (max 0.096), 6 off by
 * 0.17-0.99 — the wrong tree of several — set back and marked `cacheKeyRejected` (skipped by later runs). 71 had no
 * stored tree (evicted before the archive existed), 3 no tree holding hero's node. Backup beside poker.sqlite.
 *
 *   bun --env-file=..\..\..\config\local.env src/scripts/recoverPreflopKeys.ts [--write]
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { preflopCacheKeyOf } from "../services/gtowAiPreflop";
import { nodeAddr } from "../services/gtowSolveCache";
import { archiveDirFor } from "../services/gtowCacheArchive";
import { centralDbPath, gtowCachePath } from "../services/storePaths";

const WRITE = process.argv.includes("--write");
const MAX_AGE_MS = 12 * 3_600_000;

const hotPath = gtowCachePath();
if (!hotPath) { console.error("the GTO Wizard cache is off (GTOW_CACHE_DB_PATH=off)"); process.exit(1); }
const archDir = archiveDirFor(hotPath);
const cacheFiles = [hotPath, ...(archDir && existsSync(archDir) ? readdirSync(archDir).filter((f) => /\.sqlite$/.test(f)).map((f) => join(archDir, f)) : [])];
const caches = cacheFiles.map((f) => new Database(f, { readonly: true }));
console.log(`caches: ${cacheFiles.join(", ")}`);

/** players → "POS:stack|…" in the tree's own order */
const sigOf = (players: { position: string; stack: number }[]): string =>
  players.map((p) => `${p.position}:${Math.round(Number(p.stack) * 100) / 100}`).join("|");

interface Tree { key: string; created: number }
const bySig = new Map<string, Tree[]>();
for (const db of caches) {
  for (const t of db.query<{ key: string; created_ms: number; body: Uint8Array<ArrayBuffer> }, []>("SELECT key, created_ms, body FROM gtow_cache_trees WHERE kind = 'pre'").all()) {
    try {
      const b = JSON.parse(Buffer.from(Bun.gunzipSync(t.body)).toString("utf-8"));
      const sig = sigOf(b.tree?.players ?? []);
      (bySig.get(sig) ?? bySig.set(sig, []).get(sig)!).push({ key: t.key, created: t.created_ms });
    } catch { /* unreadable body */ }
  }
}
const hasNode = (key: string, line: string): boolean =>
  caches.some((db) => !!db.query("SELECT 1 FROM gtow_cache_nodes WHERE key = ? AND addr = ?").get(key, nodeAddr({ preflop: line })));

const central = WRITE ? new Database(centralDbPath()) : new Database(centralDbPath(), { readonly: true });
if (WRITE) central.run("PRAGMA busy_timeout = 10000");  // the live API writes this file too
const tally: Record<string, number> = {};
const changed: { handKey: string; doc: any }[] = [];
for (const row of central.query<{ hand_key: string; doc: string }, []>("SELECT hand_key, doc FROM hand_facts").all()) {
  const doc = JSON.parse(row.doc);
  let touched = false;
  for (const rec of [...(doc.preflopNodes ?? []), ...(doc.preflop ? [doc.preflop] : [])]) {
    if ((rec.piece && rec.piece !== "gtow-ai-preflop") || rec.cacheKey || rec.cacheKeyRejected || rec.lastResort || !rec.shape?.positions) continue;
    const line = (rec.codes ?? []).join("-");
    const k0 = preflopCacheKeyOf(rec);
    if (k0 && hasNode(k0, "") && hasNode(k0, line)) { tally["already readable"] = (tally["already readable"] ?? 0) + 1; continue; }
    const sh = rec.shape;
    const sig = sigOf(sh.positions.map((p: string) => ({ position: sh.apiOf?.[p] ?? p, stack: sh.stacks[p] })));
    const at = Number(rec.at ?? doc.at ?? 0);
    const cands = (bySig.get(sig) ?? [])
      .filter((t) => t.created <= at + 60_000 && at - t.created <= MAX_AGE_MS)
      .filter((t) => hasNode(t.key, "") && hasNode(t.key, line))
      .sort((a, b) => b.created - a.created);
    const day = new Date(at).toISOString().slice(0, 10);
    const k = !(bySig.get(sig)?.length) ? "no stored tree with these seats + stacks (evicted before the archive, 2026-10-09)"
      : !cands.length ? "a tree with these stacks, but none holding hero's node near the answer's time"
      : cands.length === 1 ? "recovered (one match)" : "recovered (newest of several)";
    tally[k] = (tally[k] ?? 0) + 1;
    tally[`  ${k.slice(0, 9)} ${day}`] = (tally[`  ${k.slice(0, 9)} ${day}`] ?? 0) + 1;
    if (cands.length) { rec.cacheKey = cands[0]!.key; rec.cacheKeyRecovered = true; touched = true; }
  }
  if (touched) changed.push({ handKey: row.hand_key, doc });
}
console.log(Object.fromEntries(Object.entries(tally).sort()));
if (WRITE && changed.length) {
  // the rows as they were, beside the database, before anything is written (undo: put each doc back)
  const keys = new Set(changed.map((c) => c.handKey));
  const before = central.query<{ hand_key: string; doc: string }, []>("SELECT hand_key, doc FROM hand_facts").all().filter((r) => keys.has(r.hand_key));
  const backup = join(dirname(centralDbPath()), `hand_facts-before-key-recovery-${Date.now()}.json`);
  await Bun.write(backup, JSON.stringify(before));
  console.log(`backup: ${backup}`);
  const up = central.prepare("UPDATE hand_facts SET doc = ? WHERE hand_key = ?");
  central.transaction(() => { for (const c of changed) up.run(JSON.stringify(c.doc), c.handKey); })();
  console.log(`wrote ${changed.length} hands' records`);
} else console.log(`${changed.length} hands would change${WRITE ? "" : " (dry run — --write to apply)"}`);
console.log(`hand keys: ${changed.map((c) => c.handKey).join(",")}`);
process.exit(0);
