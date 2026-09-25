/**
 * Export the ante solve fleet's range files by reading each config's
 * FLOP-ENTERING ranges directly from GTO Wizard's API — no reconstruction.
 *
 * Supersedes exportAnteRanges.ts, which wrote per-hand action frequencies from
 * the crawled strategy grids. Those are correct at a player's FIRST decision
 * but conditional-on-reach at the second, so the seven *_call_vs_*_3bet files
 * were the opener's continue frequency, not its arrival weight — in the ante
 * tree, where the SB mixes open/limp thinly, that made the SB's 3-bet-defend
 * range ~10x too wide. Rather than multiply frequencies along the path
 * ourselves (chain rule — correct, but our arithmetic), this asks GTO Wizard
 * for the answer: the spot-solution API at a FLOP node returns each player's
 * arrival range as a 1326-combo weight array, computed by GTOW itself.
 *
 * Ordering safety: flop-node `players_info[].range` is 1326-length in the
 * comboIndex order, which was previously verified against this same API by
 * card-removal. This script re-verifies on every query (a nonzero weight on a
 * board-blocked combo aborts the run).
 *
 * Card removal: a flop node zeroes combos that intersect the board, so one
 * board can't show the whole range. Three PAIRWISE-DISJOINT boards are
 * queried; any 2-card combo intersects at most two of them, so every combo is
 * unblocked on at least one. Where a combo is unblocked on two boards the two
 * values must agree — that redundancy is checked, not assumed.
 *
 * Usage (from apps/api, GTO Wizard running with --remote-debugging-port=9222):
 *   bun run src/scripts/exportAnteFlopRanges.ts            # all charts
 *   bun run src/scripts/exportAnteFlopRanges.ts --dry-run  # fetch + verify only
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gtowApi } from "../services/gtowApi";
import { COMBOS, toClassWeights } from "../utils/comboIndex/comboIndex";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");

const GT = "Cash6mSimple_6mCPante0166BCCNL200R25";
const DEPTH = 100.166;
const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const OUT_DIR = join(REPO, "analysis", "pipeline", "solve", "ranges", "ante");
const MANIFEST = join(REPO, "analysis", "pipeline", "solve", "ranges", "manifest_ante.json");

/** Pairwise-disjoint: a 2-card combo can intersect at most two, so every combo
 *  is unblocked on at least one. */
const BOARDS = ["2c2d2h", "7s8s9s", "JdQdKd"];

// Preflop action order at 6-max. Lines are built in this order.
const ORDER = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
type Pos = (typeof ORDER)[number];

// The ante tree's own sizes (read off the crawl, mirrored in configs_ante.json).
const OPEN_TOK = "R2.5"; // every seat opens 2.5 in this tree, SB included
const THREEBET_TOK: Record<string, string> = {
  "BTN>SB": "R12", "SB>BB": "R7.5", "BTN>BB": "R13", "CO>BTN": "R9",
  "CO>SB": "R12", "HJ>CO": "R9", "HJ>BTN": "R9",
};

/** Single raised pot: opener raises, caller calls, everyone else folds. */
function srpLine(opener: Pos, caller: Pos): string {
  return ORDER.map((p) => (p === opener ? OPEN_TOK : p === caller ? "C" : "F")).join("-");
}
/** 3-bet pot: opener raises, threebettor 3-bets, others fold, opener calls. */
function tbpLine(opener: Pos, threebettor: Pos): string {
  const tb = THREEBET_TOK[`${opener}>${threebettor}`];
  if (!tb) throw new Error(`no 3-bet size for ${opener}>${threebettor}`);
  const toks: string[] = [];
  for (const p of ORDER) toks.push(p === opener ? OPEN_TOK : p === threebettor ? tb : "F");
  // remaining action returns to the opener, who calls; players after the
  // threebettor already folded inside the loop above.
  toks.push("C");
  return toks.join("-");
}

/** chart name -> { line, pos } : whose arrival range at which flop node. */
const CHARTS: Record<string, { line: string; pos: Pos }> = {};
for (const o of ["UTG", "HJ", "CO", "BTN", "SB"] as Pos[]) {
  CHARTS[`rfi_${o.toLowerCase()}`] = { line: srpLine(o, "BB"), pos: o };
  CHARTS[`bb_call_vs_${o.toLowerCase()}`] = { line: srpLine(o, "BB"), pos: "BB" };
}
for (const o of ["CO", "HJ"] as Pos[]) {
  CHARTS[`btn_call_vs_${o.toLowerCase()}`] = { line: srpLine(o, "BTN"), pos: "BTN" };
}
for (const [k, ] of Object.entries(THREEBET_TOK)) {
  const [o, t] = k.split(">") as [Pos, Pos];
  CHARTS[`${t.toLowerCase()}_3bet_vs_${o.toLowerCase()}`] = { line: tbpLine(o, t), pos: t };
  CHARTS[`${o.toLowerCase()}_call_vs_${t.toLowerCase()}_3bet`] = { line: tbpLine(o, t), pos: o };
}

const blockedBy = (board: string): Set<string> => {
  const cards = board.match(/../g)!;
  return new Set(cards);
};

/** Fetch one flop node; return per-position 1326 weight arrays. */
async function fetchNode(line: string, board: string): Promise<Record<string, number[]>> {
  const r: any = await gtowApi.spotSolution({
    gametype: GT, depth: DEPTH, preflop_actions: line, board, flop_actions: "",
  });
  if (!r.ok) throw new Error(`API ${r.status} at "${line}" board ${board}: ${String(r.error).slice(0, 160)}`);
  const out: Record<string, number[]> = {};
  const blocked = blockedBy(board);
  for (const p of r.data.players_info ?? []) {
    const rng: number[] = p.range;
    const pos: string = p.player?.position;
    if (!pos || !Array.isArray(rng)) continue;
    if (rng.length !== 1326) throw new Error(`range len ${rng.length} != 1326 at "${line}" (${pos})`);
    // ordering re-verification: blocked combos must be zero
    for (let i = 0; i < 1326; i++) {
      const c = COMBOS[i]!;
      if (rng[i]! > 1e-9 && (blocked.has(c.cards[0]) || blocked.has(c.cards[1]))) {
        throw new Error(`ORDERING VIOLATION: nonzero weight on board-blocked ${c.hand} at "${line}" board ${board}`);
      }
    }
    out[pos] = rng;
  }
  return out;
}

/** Merge disjoint-board views into the full unblocked range; verify overlaps agree. */
function merge(views: number[][], boards: string[]): { range: number[]; maxDisagree: number } {
  const blocked = boards.map(blockedBy);
  const out = new Array<number>(1326).fill(0);
  let maxDisagree = 0;
  for (let i = 0; i < 1326; i++) {
    const c = COMBOS[i]!;
    const vals: number[] = [];
    for (let b = 0; b < views.length; b++) {
      if (blocked[b]!.has(c.cards[0]) || blocked[b]!.has(c.cards[1])) continue;
      vals.push(views[b]![i]!);
    }
    if (!vals.length) throw new Error(`combo ${c.hand} blocked on every board — boards not disjoint?`);
    const v = vals[0]!;
    for (const w of vals) maxDisagree = Math.max(maxDisagree, Math.abs(w - v));
    out[i] = v;
  }
  return { range: out, maxDisagree };
}

/** Solver format: full-weight classes bare, fractional as class:weight. */
function toRangeText(range: number[]): { text: string; classes: number; frac: number; totalCombos: number } {
  const cls = toClassWeights(range);
  const parts: string[] = [];
  let frac = 0, totalCombos = 0;
  for (const [name, { weight, combos }] of Object.entries(cls)) {
    const denom = name.length === 2 ? 6 : name.endsWith("s") ? 4 : 12;
    const w = weight / denom; // average weight across the class's combos
    totalCombos += weight;
    if (w < 0.0005) continue;
    if (w >= 0.9995) parts.push(name);
    else { parts.push(`${name}:${w.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`); frac++; }
    void combos;
  }
  return { text: parts.join(","), classes: parts.length, frac, totalCombos };
}

async function main() {
  console.log(`source: ${GT} @ ${DEPTH} — flop-arrival ranges via spot-solution API`);
  console.log(`boards: ${BOARDS.join(", ")}  (pairwise disjoint)\n`);

  // one fetch per unique line+board, then serve every chart on that line
  const lines = [...new Set(Object.values(CHARTS).map((c) => c.line))];
  const byLine = new Map<string, Record<string, number[]>[]>();
  for (const line of lines) {
    const views: Record<string, number[]>[] = [];
    for (const b of BOARDS) views.push(await fetchNode(line, b));
    byLine.set(line, views);
    process.stdout.write(`  fetched ${line}\n`);
  }

  const manifest: Record<string, unknown> = {};
  const rows: string[] = [];
  let worstDisagree = 0;
  for (const [name, { line, pos }] of Object.entries(CHARTS)) {
    const views = byLine.get(line)!.map((v) => {
      if (!v[pos]) throw new Error(`no range for ${pos} at "${line}" — folded player not in players_info?`);
      return v[pos]!;
    });
    const { range, maxDisagree } = merge(views, BOARDS);
    worstDisagree = Math.max(worstDisagree, maxDisagree);
    const { text, classes, frac, totalCombos } = toRangeText(range);
    if (!DRY) {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(join(OUT_DIR, `${name}.txt`), text + "\n");
    }
    manifest[name] = {
      name, gametype: GT, depth: DEPTH, method: "flop-arrival",
      line, node_position: pos, combos: +totalCombos.toFixed(1),
      pct_of_1326: +(100 * totalCombos / 1326).toFixed(2),
      classes, fractional_classes: frac,
      board_disagreement_max: +maxDisagree.toFixed(6),
      exported_at: new Date().toISOString(),
    };
    rows.push(`  ${name.padEnd(24)} ${(100 * totalCombos / 1326).toFixed(1).padStart(5)}%  (${totalCombos.toFixed(0)} combos, ${classes} classes)`);
  }

  if (!DRY) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\n${"chart".padEnd(26)} arrival`);
  console.log(rows.join("\n"));
  console.log(`\ncross-board max disagreement: ${worstDisagree.toExponential(2)} (0 = boards agree perfectly)`);
  console.log(DRY ? "\n(dry run — nothing written)" : `\nwrote ${Object.keys(CHARTS).length} files -> ${OUT_DIR}\nmanifest -> ${MANIFEST}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
