/**
 * SPLIT THE MERGED RECORDS (2026-10-14, the answer-path audit). Three archived hands carry their actions twice: the
 * wrapper's socket closed mid-hand, the next DOM tick re-bound the closed socket and replayed its hand into the record
 * still open for it (4923409614 and 4923409734 in session_20261009_010205, 4923345879 in session_20261008_175953). The
 * reconciler then wrote no-probe / socket-stall rows for hero's replayed actions (answers 13721-13724). The wrapper no
 * longer does this (ignition/ws.ts tapSocketClosed); every reader of an archived line already stops at the record's own
 * line (utils/archivedHand/ownLine). This puts the stored rows right as well:
 *   - the hand's `actions` become its own line (ownActionCount), the tail kept under `mergedTailRemoved` for the audit
 *     trail, and the record is stamped `endedUnseen` the way the wrapper now stamps a hand whose end never came;
 *   - the answer rows the reconciler invented for the tail — failed rows (no text) keyed past the record's own line —
 *     are deleted.
 *
 *   bun src/scripts/splitMergedRecords.ts [--since 2026-09-30] [--hand <id>] [--apply] [--backup-dir <dir>] [--force]
 *
 * DRY RUN by default: prints every merged record, where it is cut, and the answer rows that would go. --apply writes
 * a JSONL backup of every row it changes or deletes (beside the hands DB unless --backup-dir) and then writes. Refuses
 * while a poker session is live (the API's /api/load; an API that is down is no objection) unless --force. Run it from
 * apps/api with the live data root in POKER_DATA_DIR (config\local.env's), the way the services see it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiUrl } from "../services/ports";
import { answersDbPath, handsDbPath, openStore } from "../services/storePaths";
import { ownActionCount } from "../utils/archivedHand/ownLine";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
const since = Date.parse(arg("since") ?? "2026-09-30");
const only = arg("hand");
const apply = has("apply");

if (!has("force")) {
  try {
    const load: any = await (await fetch(`${apiUrl()}/api/load`, { signal: AbortSignal.timeout(3_000) })).json();
    if (load?.sessionLive) { console.error("a poker session is live — this is DB work beside the answering process; run it later (or --force)"); process.exit(2); }
  } catch { /* no API up: nothing to disturb */ }
}

interface HandRow { rowid: number; client_hand_id: string | null; played_at: number | null; street: string | null; action_count: number | null; data: string }
interface AnswerRow { id: number; client_hand_id: string | null; street: string | null; decision_key: string | null; fail_kind: string | null; text: string | null }

const hands = openStore(handsDbPath());
const answers = openStore(answersDbPath());
const indexOf = (a: AnswerRow): number | null => {
  try { const k = JSON.parse(a.decision_key ?? ""); const last = Array.isArray(k) ? k[k.length - 1] : null; return typeof last === "number" ? last : null; } catch { return null; }
};

const rows = hands.query<HandRow, [number]>("SELECT rowid, client_hand_id, played_at, street, action_count, data FROM hands WHERE status = 'done' AND COALESCE(played_at, 0) >= ? ORDER BY played_at").all(since)
  .filter((r) => !only || r.client_hand_id === only);
console.log(`${rows.length} finished hand(s) since ${new Date(since).toISOString().slice(0, 10)}${apply ? " · APPLY" : " · DRY RUN"}`);

type Plan = { row: HandRow; h: any; keep: number; phantom: AnswerRow[] };
const plans: Plan[] = [];
for (const row of rows) {
  let h: any;
  try { h = JSON.parse(row.data); } catch { continue; }
  const acts: any[] = Array.isArray(h.actions) ? h.actions : [];
  const keep = ownActionCount(acts);
  if (keep >= acts.length) continue;
  // the API reads the line with post-ins folded into the poster's action (utils/foldPostIns), so a decision index is
  // one less per post before it; the rows past the record's own line are the ones at or after its folded length
  const posts = acts.slice(0, keep).filter((a) => a.type === "post").length;
  const phantom = row.client_hand_id
    ? answers.query<AnswerRow, [string]>("SELECT id, client_hand_id, street, decision_key, fail_kind, text FROM answers WHERE client_hand_id = ? AND text IS NULL ORDER BY id").all(row.client_hand_id)
        .filter((a) => { const i = indexOf(a); return i != null && i >= keep - posts; })
    : [];
  plans.push({ row, h, keep, phantom });
  const first = acts[keep];
  console.log(`\n${row.client_hand_id ?? `rowid ${row.rowid}`} · ${h.sessionId ?? "no session"} table ${h.tableSlot ?? "?"} · ${new Date(row.played_at ?? 0).toISOString()}`);
  console.log(`  ${acts.length} actions stored → ${keep} kept; the tail begins with ${first?.street} seat ${first?.seatId} ${first?.type}${first?.amount != null ? ` ${first.amount}` : ""} (${acts.length - keep} removed)`);
  for (const a of phantom) console.log(`  answer ${a.id}: ${a.fail_kind ?? "?"} at ${a.street} index ${indexOf(a)} — invented for the tail; ${apply ? "deleted" : "would be deleted"}`);
}
console.log(`\n${plans.length} merged record(s)`);

if (apply && plans.length) {
  const dir = arg("backup-dir") ?? dirname(handsDbPath());
  mkdirSync(dir, { recursive: true });
  const backup = join(dir, `merged-records-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  for (const p of plans) {
    appendFileSync(backup, JSON.stringify({ table: "hands", rowid: p.row.rowid, client_hand_id: p.row.client_hand_id, action_count: p.row.action_count, street: p.row.street, data: p.row.data }) + "\n");
    for (const a of p.phantom) appendFileSync(backup, JSON.stringify({ table: "answers", ...answers.query("SELECT * FROM answers WHERE id = ?").get(a.id) }) + "\n");
  }
  const now = Date.now();
  const writeHands = hands.transaction((ps: Plan[]) => {
    for (const p of ps) {
      const acts: any[] = p.h.actions;
      const next = { ...p.h, actions: acts.slice(0, p.keep), mergedTailRemoved: acts.slice(p.keep),
        endedUnseen: { why: `split from a merged record (${new Date(now).toISOString().slice(0, 10)}, scripts/splitMergedRecords.ts): the hand was read twice after its socket closed, and its end-of-hand frame never arrived`,
                       street: p.h.street ?? "?", actions: p.keep } };
      hands.query("UPDATE hands SET data = ?, action_count = ?, updated_at = ? WHERE rowid = ?").run(JSON.stringify(next), p.keep, now, p.row.rowid);
    }
  });
  writeHands(plans);
  const ids = plans.flatMap((p) => p.phantom.map((a) => a.id));
  if (ids.length) answers.query(`DELETE FROM answers WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  console.log(`\nwrote ${plans.length} hand row(s), deleted ${ids.length} answer row(s); backup ${backup}`);
}
hands.close();
answers.close();
