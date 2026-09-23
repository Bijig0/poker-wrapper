/**
 * The TRIMMED LEDGER a packaged (player-mode) install ships instead of data/ledger.json.
 *
 * The owner's ledger is live fleet state: boxes (IPs), machines, proposals, plans, job recipes with box paths.
 * None of that belongs on a friend's laptop — but the strategies' status checks count "how many of this set's
 * charts have landed" from it (services/ledger.ts chartsLanded → expectedChartIds), and without it every chart
 * strategy reads `unavailable` and the wrapper refuses to start a session. So: keep formats + sources + each
 * config's id/label/format with its expected chart ids BAKED IN (expectedIds — the box-grid ones come from plan
 * files that are not shipped), and drop everything else.
 *
 *   bun setup/build_player_ledger.ts <out.json>
 */
import { writeFileSync } from "node:fs";
import { loadLedger, expectedChartIds } from "../gto-trainer/apps/api/src/services/ledger";

const out = process.argv[2];
if (!out) { console.error("usage: bun setup/build_player_ledger.ts <out.json>"); process.exit(2); }
const L: any = loadLedger();
const configs = (L.configs ?? []).map((c: any) => {
  const fmt = (L.formats ?? []).find((f: any) => f.id === c.format);
  const ids = expectedChartIds(c, fmt);
  return { id: c.id, label: c.label, kind: c.kind, format: c.format, site: c.site, runner: c.runner, recipe: c.recipe,
           ...(c.skipCharts ? { skipCharts: c.skipCharts } : {}), expectedIds: ids };
}).filter((c: any) => c.expectedIds.length > 0);
const trimmed = {
  _note: "Trimmed ledger for a packaged player-mode install (setup/build_player_ledger.ts). Formats, sources and the chart ids each config expects — no fleet state.",
  formats: L.formats ?? [], trees: [], configs, sources: L.sources ?? {},
  plans: [], proposals: [], machines: [], boxes: {},
};
writeFileSync(out, JSON.stringify(trimmed, null, 1));
console.log(`wrote ${out}: ${trimmed.formats.length} formats, ${configs.length} configs (${configs.reduce((s: number, c: any) => s + c.expectedIds.length, 0)} chart ids), ${Object.keys(trimmed.sources).length} sources`);
for (const c of configs) console.log(`  ${c.id}: ${c.expectedIds.length}`);
