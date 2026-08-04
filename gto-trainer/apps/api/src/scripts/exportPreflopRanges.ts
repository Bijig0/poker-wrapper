/**
 * Export the 29 preflop range charts for the solve DB from GTO Wizard.
 *
 * Navigates the desktop app over CDP directly to each node via URL
 * (preflop_actions + history_spot — no clicking, no restored-line races),
 * scrapes the strategy grid, validates the URL matches the intended line,
 * and writes solver-format class-weight range files into
 * analysis/pipeline/solve/ranges/ plus a provenance manifest.
 *
 * Usage (from apps/api, GTO Wizard running with --remote-debugging-port=9222):
 *   bun run src/scripts/exportPreflopRanges.ts            # all 29
 *   bun run src/scripts/exportPreflopRanges.ts rfi_btn    # one chart
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gtowCdp } from "../services/gtowCdp";

const GAMETYPE = "Cash6m500zGeneral25Open"; // NL500 · General · 2.5x opens (user-locked)
const DEPTH = 100;
const OUT_DIR = join(import.meta.dir, "../../../../..", "analysis/pipeline/solve/ranges");

type Kind = "call" | "raise";
interface Chart {
  name: string;
  /** GTOW line string, "-"-joined (F / C / R<size>). "" = preflop root. */
  line: string;
  /** Which decision index the target node is (== number of line actions). */
  spot: number;
  seat: string;
  kind: Kind;
}

// Tree sizes in this set (verified from prior extractions): opens 2.5 (SB 3);
// 3-bet sizes vary by node and are encoded per line below.
const CHARTS: Chart[] = [
  // A. RFI
  { name: "rfi_utg", line: "", spot: 0, seat: "UTG", kind: "raise" },
  { name: "rfi_hj", line: "F", spot: 1, seat: "HJ", kind: "raise" },
  { name: "rfi_co", line: "F-F", spot: 2, seat: "CO", kind: "raise" },
  { name: "rfi_btn", line: "F-F-F", spot: 3, seat: "BTN", kind: "raise" },
  { name: "rfi_sb", line: "F-F-F-F", spot: 4, seat: "SB", kind: "raise" },
  // B. BB defends vs open
  { name: "bb_call_vs_utg", line: "R2.5-F-F-F-F", spot: 5, seat: "BB", kind: "call" },
  { name: "bb_call_vs_hj", line: "F-R2.5-F-F-F", spot: 5, seat: "BB", kind: "call" },
  { name: "bb_call_vs_co", line: "F-F-R2.5-F-F", spot: 5, seat: "BB", kind: "call" },
  { name: "bb_call_vs_btn", line: "F-F-F-R2.5-F", spot: 5, seat: "BB", kind: "call" },
  { name: "bb_call_vs_sb", line: "F-F-F-F-R3", spot: 5, seat: "BB", kind: "call" },
  // C. Cold calls
  { name: "sb_call_vs_btn", line: "F-F-F-R2.5", spot: 4, seat: "SB", kind: "call" },
  { name: "sb_call_vs_co", line: "F-F-R2.5-F", spot: 4, seat: "SB", kind: "call" },
  { name: "sb_call_vs_hj", line: "F-R2.5-F-F", spot: 4, seat: "SB", kind: "call" },
  { name: "btn_call_vs_co", line: "F-F-R2.5", spot: 3, seat: "BTN", kind: "call" },
  { name: "btn_call_vs_hj", line: "F-R2.5-F", spot: 3, seat: "BTN", kind: "call" },
  // D. 3-bets (extract the raise at the responder's node)
  { name: "sb_3bet_vs_btn", line: "F-F-F-R2.5", spot: 4, seat: "SB", kind: "raise" },
  { name: "bb_3bet_vs_sb", line: "F-F-F-F-R3", spot: 5, seat: "BB", kind: "raise" },
  { name: "bb_3bet_vs_btn", line: "F-F-F-R2.5-F", spot: 5, seat: "BB", kind: "raise" },
  { name: "btn_3bet_vs_co", line: "F-F-R2.5", spot: 3, seat: "BTN", kind: "raise" },
  { name: "sb_3bet_vs_co", line: "F-F-R2.5-F", spot: 4, seat: "SB", kind: "raise" },
  { name: "co_3bet_vs_hj", line: "F-R2.5", spot: 2, seat: "CO", kind: "raise" },
  { name: "btn_3bet_vs_hj", line: "F-R2.5-F", spot: 3, seat: "BTN", kind: "raise" },
  // E. Opener calls the 3-bet (3-bet sizes from the D extractions)
  { name: "btn_call_vs_sb_3bet", line: "F-F-F-R2.5-R12-F", spot: 6, seat: "BTN", kind: "call" },
  { name: "sb_call_vs_bb_3bet", line: "F-F-F-F-R3-R10", spot: 6, seat: "SB", kind: "call" },
  { name: "btn_call_vs_bb_3bet", line: "F-F-F-R2.5-F-R13", spot: 6, seat: "BTN", kind: "call" },
  { name: "co_call_vs_btn_3bet", line: "F-F-R2.5-R7.5-F-F", spot: 6, seat: "CO", kind: "call" },
  { name: "co_call_vs_sb_3bet", line: "F-F-R2.5-F-R12-F", spot: 6, seat: "CO", kind: "call" },
  { name: "hj_call_vs_co_3bet", line: "F-R2.5-R7.5-F-F-F", spot: 6, seat: "HJ", kind: "call" },
  { name: "hj_call_vs_btn_3bet", line: "F-R2.5-F-R7.5-F-F", spot: 6, seat: "HJ", kind: "call" },
];

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function pickActionLabel(labels: string[], kind: Kind): string | null {
  const norm = (s: string) => s.toLowerCase();
  if (kind === "call") return labels.find((l) => norm(l).startsWith("call")) ?? null;
  return labels.find((l) => norm(l).startsWith("raise")) ?? null; // first = standard size
}

/** Wait until the grid shows the target seat, with a stable legend, on the right URL. */
async function waitForGrid(chart: Chart, timeoutMs = 25000) {
  const t0 = Date.now();
  let prev = "";
  while (Date.now() - t0 < timeoutMs) {
    const node = await gtowCdp.readNodeStrategy();
    const params = new URLSearchParams(node.url.split("?")[1] ?? "");
    const urlOk =
      (params.get("preflop_actions") ?? "") === chart.line &&
      params.get("history_spot") === String(chart.spot) &&
      params.get("gametype") === GAMETYPE;
    const fp = `${node.position}|${node.actions.map((a) => `${a.action}${a.rangePct}`).join(",")}|${node.cells.length}`;
    if (
      urlOk &&
      node.position?.toUpperCase().startsWith(chart.seat) &&
      node.actions.length > 0 &&
      node.cells.length >= 100 &&
      fp === prev
    ) {
      return node;
    }
    prev = fp;
    await sleep(500);
  }
  return null;
}

async function exportChart(chart: Chart): Promise<Record<string, unknown>> {
  await gtowCdp.navigateToNode(GAMETYPE, DEPTH, chart.line, chart.spot);
  await sleep(1000);

  const blocker = await gtowCdp.studyBlocker();
  if (blocker.blocked) throw new Error(`GTOW blocker: ${blocker.code} ${blocker.message}`);

  const node = await waitForGrid(chart);
  if (!node) {
    const cur = await gtowCdp.status();
    throw new Error(`grid never stabilized on ${chart.seat} (page: ${cur.path?.slice(0, 140)})`);
  }

  const legendLabels = node.actions.map((a) => a.action);
  const targetLabel = pickActionLabel(legendLabels, chart.kind);
  if (!targetLabel) throw new Error(`no ${chart.kind} in legend (have: ${legendLabels.join(" · ")})`);
  const legend = node.actions.find((a) => a.action === targetLabel)!;
  if ((legend.rangePct ?? 0) === 0) {
    throw new Error(`"${targetLabel}" is 0% of range here — wrong node or unused action`);
  }

  const weights: [string, number][] = [];
  for (const cell of node.cells) {
    const pct = cell.actions[targetLabel] ?? 0;
    if (pct > 0) weights.push([cell.hand, Math.min(1, Math.round(pct * 10) / 1000)]);
  }
  if (weights.length < 5) throw new Error(`only ${weights.length} classes take "${targetLabel}"`);
  const fractional = weights.filter(([, w]) => w > 0 && w < 1).length;
  const rangeStr = weights
    .map(([hand, w]) => (w >= 0.9995 ? hand : `${hand}:${w.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`))
    .join(",");

  await Bun.write(join(OUT_DIR, `${chart.name}.txt`), rangeStr + "\n");
  return {
    name: chart.name,
    gametype: GAMETYPE,
    depth: DEPTH,
    line: chart.line,
    spot: chart.spot,
    node_position: node.position,
    action: targetLabel,
    range_pct: legend.rangePct,
    combos: legend.combos,
    classes: weights.length,
    fractional_classes: fractional,
    url: node.url,
    exported_at: new Date().toISOString(),
  };
}

// ---- main ----
const only = Bun.argv[2];
if (!(await gtowCdp.isConnected())) {
  console.error('✗ GTO Wizard not reachable. Launch with:\n  open -a "GTO Wizard" --args --remote-debugging-port=9222');
  process.exit(1);
}
await mkdir(OUT_DIR, { recursive: true });

const charts = only ? CHARTS.filter((ch) => ch.name === only) : CHARTS;
if (!charts.length) {
  console.error(`✗ unknown chart "${only}". Known: ${CHARTS.map((ch) => ch.name).join(", ")}`);
  process.exit(1);
}

const manifest: Record<string, unknown>[] = [];
const failures: { name: string; error: string }[] = [];
for (const [i, chart] of charts.entries()) {
  try {
    const entry = await exportChart(chart);
    manifest.push(entry);
    console.log(
      `[${i + 1}/${charts.length}] ✓ ${chart.name}: ${entry.action} — ${entry.range_pct}% of range, ` +
        `${entry.classes} classes (${entry.fractional_classes} mixed)`
    );
  } catch (e) {
    failures.push({ name: chart.name, error: String(e instanceof Error ? e.message : e) });
    console.error(`[${i + 1}/${charts.length}] ✗ ${chart.name}: ${failures.at(-1)!.error}`);
  }
  await sleep(600);
}

const manifestPath = join(OUT_DIR, "manifest.json");
const existing = await Bun.file(manifestPath)
  .json()
  .catch(() => ({}));
for (const entry of manifest) (existing as Record<string, unknown>)[entry.name as string] = entry;
await Bun.write(manifestPath, JSON.stringify(existing, null, 1));

console.log(`\n${manifest.length}/${charts.length} charts exported -> ${OUT_DIR}`);
if (failures.length) {
  console.error(`FAILED: ${failures.map((f) => f.name).join(", ")}`);
  process.exit(2);
}
process.exit(0);
