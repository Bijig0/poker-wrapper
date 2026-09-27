/**
 * chartRotationAudit — does every solved chart's seat rotation agree with poker?
 *
 * WHY (2026-09-22). The 6-max limp trees turned out to hold nodes whose stored position is wrong: after an
 * iso-raise, a CALL or a RAISE jumps straight to the limpers and the un-acted seats between them lose their
 * node (`C-C-R5-F` -> SB, then `C-C-R5-F-C` -> UTG, with no BB node at all). Nothing caught it for six days,
 * because every consumer TRUSTED the stored position: `solvePreflop6max` handed hero the node's strategy and
 * called it his, so a BB decision was answered from UTG's node, graded clean, with no warning.
 *
 * The inline guards added the same day turn that into an honest miss at answer time. This is the other half:
 * find the defective trees BEFORE they answer anything, across the whole corpus, so "which charts can we
 * trust" is a question with a measured answer rather than a hope.
 *
 * HOW. Each chart is a gzipped map of line -> node, and every node stores the position it belongs to. The
 * rotation a line implies is computable independently — `actorsOfLine` (utils/borrowHeroCall) replays the
 * same seat order preflopPotStack does. So for every node in the file: whose turn SHOULD it be, and whose
 * does the file say it is? A disagreement is a defective node, full stop.
 *
 * It reads the solution files straight off disk rather than the :8777 API — no cold opens, no LRU thrash
 * (asking the server for 100k nodes would evict its working set), no cloud cost, and complete coverage
 * instead of a sample.
 *
 *   bun src/scripts/chartRotationAudit.ts                  # every chart in the solutions dir
 *   bun src/scripts/chartRotationAudit.ts --only olimp     # id substring filter
 *   bun src/scripts/chartRotationAudit.ts --examples 5     # mismatches to print per chart
 */
import { CHARTS_DIR } from "../services/repoPaths";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
/* `actorsOfLine` is deliberately NOT used here. It is correct for what production asks of it, but it has no
 * concept of an all-in: a seat that jams keeps getting turns in its rotation. Auditing with it flagged 132
 * nodes in EVERY 3-max chart — all of them lines containing the short stack's jam (`...-R35-C-R105`), where
 * the FILE was right and the audit was wrong. A rotation used to judge a solved tree has to model the one
 * thing that removes a player without folding, so this one does. */

const SOLUTIONS = CHARTS_DIR;   // the chart index + cached bodies (services/repoPaths.ts)
const SEATS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
const SEATS3 = ["BTN", "SB", "BB"] as const;
/** Heads-up preflop: the dealer posts the small blind and acts first. These charts name him SB. */
const SEATS2 = ["SB", "BB"] as const;

const arg = (k: string, d?: string) => { const i = Bun.argv.indexOf(k); return i >= 0 ? Bun.argv[i + 1] : d; };

/** Which rotation this chart's id implies. A 3-max chart starts at the BTN; a 6-max one at UTG. */
function seatsFor(id: string): readonly string[] | null {
  if (/3max/i.test(id)) return SEATS3;
  if (/6max/i.test(id)) return SEATS6;
  // the heads-up corpora: hrc_hu_ign200 / ign500 / cp200a and the SnG grid. 617 of them, skipped entirely
  // by the first version of this audit — a check that silently ignores nine tenths of the corpus is not one.
  if (/(^|_)hu(_|$)|^husng/i.test(id)) return SEATS2;
  return null;
}

interface Bad { line: string; said: string; expected: string }

/** Per-seat starting stacks in bb, read off the chart id: `..._D105_s35_bb_...` = 105bb everywhere except
 *  the BB at 35. An id with no short seat is an even table. Unknown ids get a flat deep stack. */
function stacksFor(id: string, seats: readonly string[]): Record<string, number> {
  const deep = Number(/_d(\d+)/i.exec(id)?.[1] ?? 100);
  const out: Record<string, number> = {};
  for (const s of seats) out[s] = deep;
  const m = /_s(\d+)_(bb|sb|btn|utg|hj|co)(?:_|$)/i.exec(id);
  if (m) {
    const seat = m[2]!.toUpperCase();
    if (seat in out) out[seat] = Number(m[1]);
  }
  return out;
}

/**
 * Whose decision is the node at `tokens`? The same rotation the solver replays, with the one rule
 * `actorsOfLine` omits: a seat that puts its whole stack in is ALL-IN and never acts again. Returns null
 * once fewer than two seats can still act, which is a terminal spot with nobody to be wrong about.
 */
function nextActor(tokens: string[], seats: readonly string[], stacks: Record<string, number>): string | null {
  let active = [...seats];
  const inFor: Record<string, number> = {};
  for (const s of seats) inFor[s] = s === "SB" ? 0.5 : s === "BB" ? 1 : 0;
  let p = 0;
  for (const tok of tokens) {
    if (active.length < 2) return null;
    p = p % active.length;
    const seat = active[p]!;
    if (tok === "F") { active = active.filter((s) => s !== seat); continue; }
    if (tok === "C") {
      const high = Math.max(...Object.values(inFor));
      inFor[seat] = Math.min(high, stacks[seat] ?? 100);
    } else {
      const to = Number(/^R([\d.]+)$/.exec(tok)?.[1] ?? NaN);
      if (Number.isFinite(to)) inFor[seat] = Math.min(to, stacks[seat] ?? 100);
    }
    // all-in: out of the rotation without folding — the rule the audit exists to respect
    if ((inFor[seat] ?? 0) >= (stacks[seat] ?? 100) - 1e-9) active = active.filter((s) => s !== seat);
    else p += 1;
  }
  if (active.length < 2) return null;
  return active[p % active.length]!;
}

function auditChart(id: string, path: string, maxExamples: number): {
  nodes: number; checked: number; bad: Bad[]; skipped: number;
} {
  const doc = JSON.parse(gunzipSync(readFileSync(path)).toString("utf-8")) as {
    nodes: Record<string, { pos?: string | null; terminal?: boolean }>;
  };
  const seats = seatsFor(id);
  const stacks = stacksFor(id, seats!);
  const bad: Bad[] = [];
  let checked = 0, skipped = 0;
  const nodes = doc.nodes ?? {};
  for (const [line, node] of Object.entries(nodes)) {
    // A terminal node has nobody to act, so it has no position to be wrong about.
    if (node?.terminal || !node?.pos) { skipped++; continue; }
    const tokens = line === "" ? [] : line.split("-");
    const next = nextActor(tokens, seats!, stacks);
    if (next == null) { skipped++; continue; }   // fewer than two players can still act — no decision here
    checked++;
    if (String(node.pos).toUpperCase() !== next.toUpperCase()) {
      if (bad.length < maxExamples) bad.push({ line: line || "(root)", said: String(node.pos), expected: next });
      else bad.push({ line: "", said: "", expected: "" });   // counted, not kept
    }
  }
  return { nodes: Object.keys(nodes).length, checked, bad, skipped };
}

function main() {
  const only = arg("--only");
  const maxExamples = Number(arg("--examples", "4"));
  const files = readdirSync(SOLUTIONS)
    .filter((f) => f.endsWith(".json.gz"))
    .filter((f) => !only || f.includes(only))
    .sort();
  if (!files.length) { console.log(`no charts matched${only ? ` --only ${only}` : ""} in ${SOLUTIONS}`); return; }
  console.log(`auditing ${files.length} chart(s) against the rotation their seat set implies\n`);

  let cleanN = 0;
  const dirty: { id: string; checked: number; badN: number; ex: Bad[] }[] = [];
  for (const f of files) {
    const id = f.replace(/\.json\.gz$/, "");
    if (!seatsFor(id)) { console.log(`  ${id.padEnd(40)} SKIPPED — cannot tell its seat set from the id`); continue; }
    let r;
    try { r = auditChart(id, join(SOLUTIONS, f), maxExamples); }
    catch (e) { console.log(`  ${id.padEnd(40)} UNREADABLE — ${e instanceof Error ? e.message : e}`); continue; }
    const badN = r.bad.length;
    if (!badN) { cleanN++; console.log(`  ${id.padEnd(40)} ok      ${String(r.checked).padStart(7)} nodes`); continue; }
    const ex = r.bad.filter((b) => b.line);
    dirty.push({ id, checked: r.checked, badN, ex });
    console.log(`  ${id.padEnd(40)} BAD  ${String(badN).padStart(6)} of ${r.checked} nodes (${(100 * badN / r.checked).toFixed(2)}%)`);
  }

  console.log(`\n${"=".repeat(88)}`);
  console.log(`${cleanN} chart(s) clean · ${dirty.length} with a rotation that disagrees with poker`);
  for (const d of dirty) {
    console.log(`\n${d.id} — ${d.badN} bad nodes`);
    for (const b of d.ex) console.log(`    "${b.line}": file says ${b.said}, the rotation says ${b.expected}`);
  }
  if (!dirty.length) console.log("\nEvery chart's stored positions agree with the rotation its line implies.");
  process.exit(dirty.length ? 1 : 0);
}

main();
