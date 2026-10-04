/**
 * Send played Ignition hands to GTO Wizard's analyzer (the Analyze tab of a pool account) in one go.
 *
 *   bun src/scripts/gtowAnalyze.ts --session session_20261004_021501      every Ignition hand of one session
 *   bun src/scripts/gtowAnalyze.ts --since 2026-10-03 [--until 2026-10-04] by local play day
 *   bun src/scripts/gtowAnalyze.ts --last 50                               the newest N archived hands
 *   bun src/scripts/gtowAnalyze.ts --hands 4922381703,4922381674           these hand numbers (archived or not)
 *     [--account primary]   pool slot whose Analyze tab gets the hands (default primary = Ultra)
 *     [--dry-run]           write the text file(s) to data/gtow_analyze/ and upload nothing
 *     [--no-wait]           return once uploaded instead of waiting for GTO Wizard's verdict
 *   bun src/scripts/gtowAnalyze.ts --status [--account primary]           the account's latest analyzer files
 *
 * Each hand is Ignition's own record (the wrapper's saved copy in <data>/wrapper/hand_history, else fetched through a
 * running wrapper — that needs the Ignition client signed in), converted to Ignition's text format
 * (utils/ignitionHh/ignitionText.ts) and uploaded as .txt files of up to 500 hands (services/gtowAnalyzer.ts). GTO
 * Wizard skips hands it already has (counted as duplicates), so re-sending a session costs nothing but the upload.
 * Run with config/env.ps1 loaded (POKER_DATA_DIR) so the archive and the GTO Wizard accounts are the live ones.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allRows, enrichSync, isIgnitionHandId, type Enriched } from "../routes/dashboard";
import { analyzerFiles, uploadToAnalyzer, waitForAnalyzer, type AnalyzerFile } from "../services/gtowAnalyzer";
import { fetchIgnitionRecord } from "../services/ignitionRecord";
import { apiDataDir, dataLayout } from "../services/storePaths";
import { ignitionRecordToText, type IgnitionRecordBody } from "../utils/ignitionHh/ignitionText";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name: string) => argv.includes(`--${name}`);
const account = arg("account") ?? "primary";
const FILE_HANDS = 500;

const show = (f: AnalyzerFile) =>
  `${f.original_name}: ${f.status}${f.error_status !== "OK" ? ` (${f.error_status})` : ""} — ${f.total_hands} hands, ` +
  `${f.solved_hands} solved, ${f.duplicate_hands} duplicate, ${f.parsing_error_hands + f.parser_unsupported_hands} unreadable, ${f.over_limit_hands} over the limit`;

if (flag("status")) {
  for (const f of await analyzerFiles(account, 10)) console.log(show(f));
  process.exit(0);
}

// ── which hands ────────────────────────────────────────────────────────────────────────────────────────────────
const localDay = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("sv-SE") : "");
let ids: string[];
if (arg("hands")) {
  ids = arg("hands")!.split(",").map((s) => s.trim()).filter(isIgnitionHandId);
} else {
  const session = arg("session"), since = arg("since"), until = arg("until"), last = Number(arg("last") ?? 0);
  if (!session && !since && !until && !last) {
    console.error("say which hands: --session <id> | --since <day> [--until <day>] | --last <n> | --hands <id,id>   (or --status)");
    process.exit(2);
  }
  let rows: Enriched[] = allRows().map(enrichSync).filter((e): e is Enriched => !!e)
    .filter((e) => isIgnitionHandId(e.clientHandId))
    .filter((e) => !session || e.raw.sessionId === session)
    .filter((e) => (!since || localDay(e.playedAt) >= since) && (!until || localDay(e.playedAt) <= until));
  if (last > 0) rows = rows.slice(-last);
  ids = [...new Set(rows.map((e) => e.clientHandId!))];
}
if (!ids.length) { console.error("no Ignition hands match"); process.exit(1); }

// ── Ignition's record of each, as text ──────────────────────────────────────────────────────────────────────────
const cacheDir = join(dataLayout().wrapper, "hand_history");
const texts: string[] = [];
const missing: string[] = [];
for (const id of ids) {
  const cached = join(cacheDir, `${id}.json`);
  let rec: { handId?: string; format?: "cash" | "zone"; body?: unknown } | null = null;
  if (existsSync(cached)) {
    try { const j = JSON.parse(readFileSync(cached, "utf8")); if (j?.ok && j.body) rec = j; } catch { /* re-fetch */ }
  }
  if (!rec) {
    const r = await fetchIgnitionRecord(id);
    if (r.ok) {
      // the wrapper saved it too; its copy names the format, the reply does not
      try { rec = JSON.parse(readFileSync(cached, "utf8")); } catch { rec = { handId: id, format: "cash", body: r.body }; }
    } else { missing.push(`${id} (${r.reason}: ${r.error})`); continue; }
  }
  try {
    texts.push(ignitionRecordToText(id, rec!.format === "zone" ? "zone" : "cash", rec!.body as IgnitionRecordBody));
  } catch (e) { missing.push(`${id} (conversion: ${(e as Error).message})`); }
}
console.log(`${texts.length} of ${ids.length} hands ready${missing.length ? `; skipped ${missing.length}:\n  ${missing.slice(0, 10).join("\n  ")}` : ""}`);
if (!texts.length) process.exit(1);

// ── upload ──────────────────────────────────────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const label = arg("session") ?? (arg("since") ? `${arg("since")}_${arg("until") ?? ""}` : arg("last") ? `last${arg("last")}` : "hands");
const outDir = join(apiDataDir(), "gtow_analyze");
mkdirSync(outDir, { recursive: true });
const uploaded: string[] = [];
for (let i = 0, part = 1; i < texts.length; i += FILE_HANDS, part++) {
  const name = `ignition_${label}_${stamp}${texts.length > FILE_HANDS ? `_part${part}` : ""}.txt`;
  const body = texts.slice(i, i + FILE_HANDS).join("\n\n\n");
  writeFileSync(join(outDir, name), body);
  if (flag("dry-run")) { console.log(`wrote ${join(outDir, name)} (not uploaded)`); continue; }
  const fileId = await uploadToAnalyzer(body, name, account);
  uploaded.push(fileId);
  console.log(`uploaded ${name} (${Math.min(FILE_HANDS, texts.length - i)} hands) to "${account}" → file ${fileId}`);
}
if (!uploaded.length || flag("no-wait")) process.exit(0);

for (const id of uploaded) {
  let lastLine = "";
  const f = await waitForAnalyzer(id, account, { onTick: (x) => { const l = show(x); if (l !== lastLine) console.log("  " + (lastLine = l)); } });
  if (f?.error_start_lines?.length) console.log(`  unreadable hands start at lines: ${JSON.stringify(f.error_start_lines).slice(0, 300)}`);
}
console.log("open GTO Wizard → Analyze → Hands to see them");
process.exit(0);
