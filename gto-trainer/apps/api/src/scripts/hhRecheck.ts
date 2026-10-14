/**
 * RE-CHECK THE STORED VERDICTS (2026-10-14). The checker (services/hhCheck) compares each hand with Ignition's record
 * ONCE and keeps the verdict in hh_checks; after a change to the comparison (utils/ignitionHh) every stored verdict is
 * stale. This re-runs the comparison over the already-checked hands from the wrapper's SAVED copies of Ignition's
 * records (<wrapper data>/hand_history/<id>.json — nothing is fetched, so it runs with no wrapper up) and rewrites each
 * verdict in place, no try spent. Pending and unavailable rows are left alone: they need the wrapper's /hh.
 *
 *   bun src/scripts/hhRecheck.ts [--days 14 | --since 2026-09-30] [--hand <id>] [--dry-run] [--force]
 *
 * Prints the counts before and after (status, through_ok, the kinds of difference through hero) and every hand still
 * wrong THROUGH HERO with its kinds — what the answers were built on. Refuses while a poker session is live (asks the
 * API's /api/load; an API that is down is no objection) unless --force. Run it from apps/api with the live data root
 * in POKER_DATA_DIR (config\local.env's), the way the services see it.
 */
import { archivedByClientHandId } from "../routes/dashboard";
import { hhCheckStore, recheck, type HhCheck } from "../services/hhCheck";
import { storedIgnitionRecord } from "../services/ignitionRecord";
import { apiUrl } from "../services/ports";
import { ignitionHhDir } from "../services/storePaths";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
const days = Number(arg("days") ?? 14);
const since = arg("since") ? Date.parse(arg("since")!) : Date.now() - days * 86_400_000;
const only = arg("hand");
const dryRun = has("dry-run");

if (!has("force")) {
  try {
    const load: any = await (await fetch(`${apiUrl()}/api/load`, { signal: AbortSignal.timeout(3_000) })).json();
    if (load?.sessionLive) { console.error("a poker session is live — the re-check is DB work beside the answering process; run it later (or --force)"); process.exit(2); }
  } catch { /* no API up: nothing to disturb */ }
}

const store = hhCheckStore();
const rows = only ? [store.get(only)].filter((c): c is HhCheck => !!c) : store.comparedSince(since);
console.log(`${rows.length} compared hand(s) since ${new Date(since).toISOString().slice(0, 10)} · records from ${ignitionHhDir()}${dryRun ? " · DRY RUN" : ""}`);

type Tally = { status: Record<string, number>; throughBad: number; kindsThrough: Record<string, number>; kindsWhole: Record<string, number> };
const tally = (cs: HhCheck[]): Tally => {
  const t: Tally = { status: {}, throughBad: 0, kindsThrough: {}, kindsWhole: {} };
  for (const c of cs) {
    t.status[c.status] = (t.status[c.status] ?? 0) + 1;
    if (c.throughOk === false) t.throughBad++;
    for (const k of new Set(c.through.map((d) => d.kind))) t.kindsThrough[k] = (t.kindsThrough[k] ?? 0) + 1;
    for (const k of new Set(c.diffs.map((d) => d.kind))) t.kindsWhole[k] = (t.kindsWhole[k] ?? 0) + 1;
  }
  return t;
};
const fmt = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "—";

const before = tally(rows);
const after: HhCheck[] = [];
const changed: HhCheck[] = [];
let noRecord = 0, noArchive = 0;
const sessionOf = new Map<string, string | null>();
const now = Date.now();
for (const prev of rows) {
  const rec = storedIgnitionRecord(prev.clientHandId);
  if (!rec) { noRecord++; after.push(prev); continue; }
  const archived = archivedByClientHandId(prev.clientHandId);
  if (!archived) { noArchive++; after.push(prev); continue; }
  sessionOf.set(prev.clientHandId, typeof archived.raw?.sessionId === "string" ? archived.raw.sessionId : null);
  const next = recheck(prev, rec.body, archived, now);
  after.push(next);
  if (next.status !== prev.status || next.throughOk !== prev.throughOk || JSON.stringify(next.through) !== JSON.stringify(prev.through)
    || JSON.stringify(next.diffs) !== JSON.stringify(prev.diffs)) changed.push(next);
}
if (!dryRun) for (let i = 0; i < changed.length; i += 500) store.saveMany(changed.slice(i, i + 500));

const a = tally(after);
console.log(`
re-checked ${rows.length - noRecord - noArchive} · ${changed.length} verdict(s) ${dryRun ? "would change" : "rewritten"} · ${noRecord} without a saved record · ${noArchive} no longer in the archive
                    before                          after
  status            ${fmt(before.status).padEnd(32)}${fmt(a.status)}
  through_ok = 0    ${String(before.throughBad).padEnd(32)}${a.throughBad}
  kinds through     ${fmt(before.kindsThrough)}
                    ${fmt(a.kindsThrough)}
  kinds whole hand  ${fmt(before.kindsWhole)}
                    ${fmt(a.kindsWhole)}`);

const bad = after.filter((c) => c.throughOk === false).sort((x, y) => (x.playedAt ?? 0) - (y.playedAt ?? 0));
console.log(`\nstill wrong THROUGH HERO (${bad.length}):`);
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?");
for (const c of bad) {
  const kinds = [...new Set(c.through.map((d) => d.kind))].join(",");
  const first = c.through[0]!;
  console.log(`  ${day(c.playedAt)}Z  ${c.clientHandId}  #${c.dbId}  ${(sessionOf.get(c.clientHandId) ?? "-").padEnd(24)}  ${kinds.padEnd(28)} ${first.field}: ours ${first.ours} · Ignition ${first.ignition}`);
}
process.exit(0);
