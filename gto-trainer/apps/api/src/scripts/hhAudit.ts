/**
 * THE READER vs IGNITION: every archived Ignition hand checked against Ignition's own hand history (the client's
 * hand-number lookup, fetched through a running wrapper's GET /hh/:id — saved copies are reused, new fetches are
 * paced). Tallies each kind of difference across the set, with examples, so a capture bug shows up as a count.
 *
 *   bun src/scripts/hhAudit.ts [--since 2026-09-24] [--until 2026-09-25] [--session <id>] [--limit 200]
 *                              [--delay 800] [--wrapper http://127.0.0.1:7700] [--examples 5] [--no-missing]
 *
 * Needs the Poker Wrapper running with the Ignition client signed in (for hands not fetched before).
 * Writes data/hh_audit/<stamp>.jsonl (one line per hand) and <stamp>.summary.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allRows, enrichSync, isIgnitionHandId, SESSION_GAP_MS, type Enriched } from "../routes/dashboard";
import { compareRecord } from "../services/hhCheck";
import { fetchIgnitionRecord } from "../services/ignitionRecord";
import type { DiffKind, HhDiff } from "../utils/ignitionHh/ignitionHh";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const since = arg("since"), until = arg("until"), session = arg("session");
const limit = Number(arg("limit") ?? 0), delayMs = Number(arg("delay") ?? 800), nExamples = Number(arg("examples") ?? 5);
const wrapper = (arg("wrapper") ?? "http://127.0.0.1:7700").replace(/\/+$/, "");

/** Ignition's lines that are not betting actions — expected, so they are not reported as unknown. */
const INFO_LABELS = new Set(["Set dealer", "Card dealt to a spot", "Return uncalled portion of bet", "Does not show", "Hand result",
  "Hand result-Side pot", "Table deposit", "Showdown", "Mucks", "Table enter user", "Table leave user", "Seat sit out", "Seat sit in", "Seat stand",
  "Seat sit down", "Seat re-join", "Posts dead chip",
  "Checks", "Checks (timeout)"]); // a post-in's free-option check, folded into its limp by the parser

const localDay = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("sv-SE") : "");

let hands: Enriched[] = allRows().map(enrichSync).filter((e): e is Enriched => !!e)
  .filter((e) => isIgnitionHandId(e.clientHandId))
  .filter((e) => (!since || localDay(e.playedAt) >= since) && (!until || localDay(e.playedAt) <= until))
  .filter((e) => !session || e.raw.sessionId === session);
if (limit > 0) hands = hands.slice(-limit);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(import.meta.dir, "..", "..", "data", "hh_audit");
mkdirSync(dir, { recursive: true });
const lines: string[] = [];
type Tally = Map<DiffKind, { hands: Set<number>; diffs: number; examples: { dbId: number; clientHandId: string; diff: HhDiff }[] }>;
/** THROUGH HERO = up to hero's last action, the part every answer was built on; FULL = the whole hand. */
const byKind: Tally = new Map(), byKindThrough: Tally = new Map();
const tally = (t: Tally, e: Enriched, diffs: HhDiff[]) => {
  for (const d of diffs) {
    const k = t.get(d.kind) ?? { hands: new Set(), diffs: 0, examples: [] };
    k.diffs++;
    if (!k.hands.has(e.dbId) && k.examples.length < nExamples) k.examples.push({ dbId: e.dbId, clientHandId: e.clientHandId!, diff: d });
    k.hands.add(e.dbId);
    t.set(d.kind, k);
  }
};
const unknownLabels = new Map<string, number>();
const unseated = new Map<string, number>();
let clean = 0, cleanThrough = 0, audited = 0, fetchFailed = 0;
const failures: { dbId: number; clientHandId: string; error: string }[] = [];

console.log(`auditing ${hands.length} archived Ignition hands against Ignition's hand history (wrapper ${wrapper})`);
for (const [n, e] of hands.entries()) {
  const rec = await fetchIgnitionRecord(e.clientHandId!, { wrappers: [wrapper] });
  if (!rec.ok && rec.reason === "unreachable") {
    console.error(`stopped at ${n}/${hands.length}: ${rec.error} — open the Ignition client in the wrapper and re-run (fetched hands are saved)`);
    process.exit(1);
  }
  if (!rec.ok) {
    fetchFailed++;
    failures.push({ dbId: e.dbId, clientHandId: e.clientHandId!, error: rec.error });
    lines.push(JSON.stringify({ dbId: e.dbId, clientHandId: e.clientHandId, error: rec.error }));
  } else {
    audited++;
    const { ignition: ign, diffs, through } = compareRecord(rec.body, e);
    if (!diffs.length) clean++;
    if (!through.length) cleanThrough++;
    tally(byKind, e, diffs);
    tally(byKindThrough, e, through);
    for (const o of ign.other) if (!INFO_LABELS.has(o.label)) unknownLabels.set(o.label, (unknownLabels.get(o.label) ?? 0) + 1);
    for (const a of ign.actions) if (a.seat == null) unseated.set(a.position, (unseated.get(a.position) ?? 0) + 1);
    lines.push(JSON.stringify({ dbId: e.dbId, clientHandId: e.clientHandId, playedAt: e.playedAt, stakes: e.stakes, table: ign.table, through, diffs }));
  }
  if ((n + 1) % 50 === 0) console.log(`  ${n + 1}/${hands.length} · ${clean} clean so far`);
  if (!(rec.ok && rec.cached)) await Bun.sleep(delayMs);
}

// HANDS NEVER ARCHIVED: Ignition's list of the day's hands, inside the windows we were playing (our hands with gaps
// under SESSION_GAP_MS, a couple of minutes either side), minus every hand number in the archive.
const notArchived: { handId: string; startTime: string; gameName: string }[] = [];
if (!argv.includes("--no-missing") && hands.length) {
  const archivedIds = new Set(allRows().map(enrichSync).map((e) => e?.clientHandId).filter(Boolean));
  const times = hands.map((e) => e.playedAt).filter((t): t is number => !!t).sort((a, b) => a - b);
  const windows: [number, number][] = [];
  for (const t of times) {
    const w = windows.at(-1);
    if (w && t - w[1] <= SESSION_GAP_MS) w[1] = t;
    else windows.push([t, t]);
  }
  const days = new Set(windows.flatMap(([a, b]) => [new Date(a - 120_000).toISOString().slice(0, 10), new Date(b + 120_000).toISOString().slice(0, 10)]));
  for (const date of [...days].sort()) {
    const r: any = await (await fetch(`${wrapper}/hh/list?date=${date}`, { signal: AbortSignal.timeout(60_000) })).json().catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { console.log(`hand list for ${date} not fetched: ${r.error}`); continue; }
    for (const h of r.hands) {
      const t = Date.parse(h.startTime);
      if (!archivedIds.has(h.handId) && windows.some(([a, b]) => t >= a - 120_000 && t <= b + 120_000)) notArchived.push(h);
    }
    await Bun.sleep(delayMs);
  }
}

const sorted = (t: Tally) => [...t.entries()].sort((a, b) => b[1].hands.size - a[1].hands.size);
const asJson = (t: Tally) => Object.fromEntries(sorted(t).map(([k, v]) => [k, { hands: v.hands.size, diffs: v.diffs, examples: v.examples }]));
const pct = (x: number) => (audited ? Math.round((x / audited) * 1000) / 10 : null);
const summary = {
  at: new Date().toISOString(), filter: { since, until, session, limit }, hands: hands.length, audited, fetchFailed,
  cleanThrough, cleanThroughPct: pct(cleanThrough), clean, cleanPct: pct(clean),
  byKindThroughHero: asJson(byKindThrough), byKind: asJson(byKind),
  unknownLabels: Object.fromEntries(unknownLabels), unseatedPositions: Object.fromEntries(unseated), failures: failures.slice(0, 20),
  notArchived,
};
writeFileSync(join(dir, `${stamp}.jsonl`), lines.join("\n") + "\n");
writeFileSync(join(dir, `${stamp}.summary.json`), JSON.stringify(summary, null, 1));

console.log(`\n${audited} audited · ${fetchFailed} not fetched
  match Ignition up to hero's last action: ${cleanThrough} (${summary.cleanThroughPct}%)
  match Ignition for the whole hand:        ${clean} (${summary.cleanPct}%)`);
const show = (title: string, t: Tally) => {
  console.log(`\n=== ${title}`);
  for (const [k, v] of sorted(t)) {
    console.log(`\n${k}: ${v.hands.size} hands (${v.diffs} differences)`);
    for (const x of v.examples) console.log(`   #${x.dbId} ${x.clientHandId}  ${x.diff.field}: ours ${x.diff.ours} · Ignition ${x.diff.ignition}${x.diff.note ? ` (${x.diff.note})` : ""}`);
  }
};
show("UP TO HERO'S LAST ACTION (what the answers were built on)", byKindThrough);
show("WHOLE HAND", byKind);
if (unknownLabels.size) console.log(`\nIgnition lines the parser does not know: ${JSON.stringify(summary.unknownLabels)}`);
if (unseated.size) console.log(`actions whose position matched no seat: ${JSON.stringify(summary.unseatedPositions)}`);
if (notArchived.length) {
  console.log(`\nhands Ignition dealt while we were playing that were NEVER archived: ${notArchived.length}`);
  for (const h of notArchived.slice(0, nExamples)) console.log(`   ${h.handId}  ${h.startTime}  ${h.gameName}`);
}
if (failures.length) console.log(`\nnot fetched (first ${Math.min(5, failures.length)}): ${failures.slice(0, 5).map((f) => `#${f.dbId} ${f.clientHandId} ${f.error}`).join(" | ")}`);
console.log(`\nper-hand results: ${join(dir, `${stamp}.jsonl`)}`);
process.exit(0);
