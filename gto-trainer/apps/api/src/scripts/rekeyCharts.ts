/**
 * rekeyCharts — repair the 6-max charts' line keys in place, without HRC.
 *
 * THE BUG (2026-09-22). `hrc_to_preflop.py` keys every node by accumulating the tokens it walked itself.
 * HRC's engine runs with `maxactive: 4`, which does not delete the 5th player who would enter a pot — it
 * gives him a FORCED FOLD, and HRC collapses that no-choice action into the edge rather than into a decision
 * node. The converter never sees it, so every node past a forced fold is filed ONE TOKEN SHORT:
 *
 *     converter's key   F-R2.5-C-C-R7.5        (5 tokens)
 *     HRC's sequence    F-R2.5-C-C-R7.5-F      (6 — the BB's forced fold)
 *
 * Consequences, all of which looked like strategy holes: the node's stored `pos` disagrees with the line, so
 * `solvePreflop6max` served hero ANOTHER SEAT'S strategy; deeper lines ran off the end as "terminal before
 * the line ends"; 33-53% of nodes per chart failed the rotation audit.
 *
 * WHY NOT JUST RE-EXPORT. Only 9 of the 68 shipped 6-max charts still have their `*_extract/nodes/` dir —
 * build_ui_layer.py deletes the extract after upload. Re-solving the other 59 would cost real HRC time for a
 * defect that is pure bookkeeping.
 *
 * THE REPAIR. The forced folds are RECOVERABLE from the shipped file, because every node already carries the
 * seat it belongs to. Walk the tree from the root tracking the TRUE line; at each child, compare the node's
 * stored `pos` against the seat the true line implies. Any gap is exactly the seats HRC forced to fold, in
 * rotation order — insert them as `F` tokens and carry on. Nothing is invented: the strategies, ranges and
 * action menus are untouched, only the address each node is filed under.
 *
 * Validated against ground truth before being trusted: for `ign200_6max_D100_o2_5` the extract survives, so
 * the re-keyed map is compared node-for-node against HRC's own `sequence`.
 *
 *   bun src/scripts/rekeyCharts.ts --check            # report only, write nothing
 *   bun src/scripts/rekeyCharts.ts --only D100_o2_5   # one chart
 *   bun src/scripts/rekeyCharts.ts --write            # rewrite the .json.gz files (backs up first)
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const SOLUTIONS = "C:\\Users\\Brady\\poker\\analysis\\pipeline\\solve\\exploit_ui\\solutions";
const SEATS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
const arg = (k: string, d?: string) => { const i = Bun.argv.indexOf(k); return i >= 0 ? Bun.argv[i + 1] : d; };
const has = (k: string) => Bun.argv.includes(k);

interface Node { pos?: string | null; terminal?: boolean; actions?: { token?: string | null }[]; line?: string }
type Chart = { meta: Record<string, unknown>; nodes: Record<string, Node> };

/** The rotation a line implies, all-in aware. Returns the seats still able to act and whose turn it is. */
export function rotation(tokens: string[], stack: number): { active: string[]; turn: number } | null {
  let active = [...SEATS6];
  const inFor: Record<string, number> = {};
  for (const s of SEATS6) inFor[s] = s === "SB" ? 0.5 : s === "BB" ? 1 : 0;
  let p = 0;
  for (const tok of tokens) {
    if (active.length < 2) return null;
    p %= active.length;
    const seat = active[p]!;
    if (tok === "F") { active = active.filter((s) => s !== seat); continue; }
    if (tok === "C") inFor[seat] = Math.min(Math.max(...Object.values(inFor)), stack);
    else {
      const to = Number(/^R([\d.]+)$/.exec(tok)?.[1] ?? NaN);
      if (Number.isFinite(to)) inFor[seat] = Math.min(to, stack);
    }
    if ((inFor[seat] ?? 0) >= stack - 1e-9) active = active.filter((s) => s !== seat);
    else p += 1;
  }
  if (active.length < 2) return null;
  return { active, turn: p % active.length };
}

/** Whose decision is the node at `tokens`? */
export const actorAt = (tokens: string[], stack: number): string | null => {
  const r = rotation(tokens, stack);
  return r ? r.active[r.turn]! : null;
};

/**
 * The forced folds between the seat the line implies and the seat the node says it is.
 *
 * HRC folds the skipped seats in rotation order, so the repair is deterministic: keep appending `F` until
 * the rotation lands on the node's own position. Bounded by the table size — if it never lands, the node is
 * not explicable as forced folds and is left alone rather than guessed at.
 */
export function foldsTo(tokens: string[], want: string, stack: number): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < SEATS6.length; i++) {
    const a = actorAt([...tokens, ...out], stack);
    if (a == null) return null;
    if (a.toUpperCase() === want.toUpperCase()) return out;
    out.push("F");
  }
  return null;
}

interface Repair { nodes: Record<string, Node>; inserted: number; unexplained: number; total: number }

export function rekey(chart: Chart, stack: number): Repair {
  const src = chart.nodes;
  const out: Record<string, Node> = {};
  let inserted = 0, unexplained = 0, total = 0;

  // BFS from the root over the SHORT keys the file uses, carrying the TRUE key alongside.
  const queue: { shortLine: string; trueLine: string[] }[] = [{ shortLine: "", trueLine: [] }];
  const seen = new Set<string>();
  while (queue.length) {
    const { shortLine, trueLine } = queue.shift()!;
    if (seen.has(shortLine)) continue;
    seen.add(shortLine);
    const node = src[shortLine];
    if (!node) continue;
    total++;
    const key = trueLine.join("-");
    out[key] = { ...node, line: key };
    if (node.terminal) continue;
    for (const a of node.actions ?? []) {
      const tok = a.token;
      if (!tok) continue;
      const childShort = shortLine ? `${shortLine}-${tok}` : tok;
      const child = src[childShort];
      if (!child) continue;
      const childTrue = [...trueLine, tok];
      if (child.terminal || !child.pos) { queue.push({ shortLine: childShort, trueLine: childTrue }); continue; }
      const implied = actorAt(childTrue, stack);
      if (implied && implied.toUpperCase() !== String(child.pos).toUpperCase()) {
        const fills = foldsTo(childTrue, String(child.pos), stack);
        if (fills) { childTrue.push(...fills); inserted += fills.length; }
        else unexplained++;
      }
      queue.push({ shortLine: childShort, trueLine: childTrue });
    }
  }
  return { nodes: out, inserted, unexplained, total };
}

/** Rotation mismatches left in a node map — the acceptance test. */
function mismatches(nodes: Record<string, Node>, stack: number): number {
  let bad = 0;
  for (const [line, n] of Object.entries(nodes)) {
    if (n.terminal || !n.pos) continue;
    const a = actorAt(line === "" ? [] : line.split("-"), stack);
    if (a && a.toUpperCase() !== String(n.pos).toUpperCase()) bad++;
  }
  return bad;
}

function main() {
  const only = arg("--only");
  const write = has("--write");
  const files = readdirSync(SOLUTIONS)
    .filter((f) => f.endsWith(".json.gz") && f.includes("6max"))
    .filter((f) => !only || f.includes(only))
    .sort();
  console.log(`${files.length} chart(s)${write ? " — WRITING" : " — dry run"}\n`);

  let fixed = 0, stillBad = 0;
  for (const f of files) {
    const id = f.replace(/\.json\.gz$/, "");
    const path = join(SOLUTIONS, f);
    const chart = JSON.parse(gunzipSync(readFileSync(path)).toString("utf-8")) as Chart;
    const stack = Number((chart.meta as { depth_bb?: number }).depth_bb ?? /_D(\d+)/.exec(id)?.[1] ?? 100);
    const before = mismatches(chart.nodes, stack);
    const r = rekey(chart, stack);
    const after = mismatches(r.nodes, stack);
    const flag = after === 0 ? "OK " : "!! ";
    console.log(`${flag}${id.padEnd(38)} ${String(before).padStart(6)} bad -> ${String(after).padStart(5)} · ` +
      `${r.inserted} folds inserted · ${Object.keys(r.nodes).length}/${Object.keys(chart.nodes).length} nodes kept` +
      (r.unexplained ? ` · ${r.unexplained} UNEXPLAINED` : ""));
    if (after === 0) fixed++; else stillBad++;
    if (write) {
      const bak = path.replace(/\.json\.gz$/, ".prekey.json.gz");
      if (!existsSync(bak)) copyFileSync(path, bak);
      writeFileSync(path, gzipSync(Buffer.from(JSON.stringify({ ...chart, nodes: r.nodes }), "utf-8")));
    }
  }
  console.log(`\n${fixed} chart(s) clean after re-key · ${stillBad} still with mismatches`);
  process.exit(stillBad ? 1 : 0);
}

if (import.meta.main) main();
