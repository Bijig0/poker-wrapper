/**
 * DEPARTURES REPORT (2026-10-05) — what every entry of the register (services/approximations.ts) did LIVE, read from
 * the answer log. The one-command diagnostic for an overlay or experiment that has none of its own (the 3-bet cold-call
 * lock and floor first), and a whole-register view for the rest.
 *
 *   bun src/scripts/departuresReport.ts [--since 2026-10-05] [--id pool-coldcall-lock] [--kind pool-overlay] [--list 10]
 *
 * Per entry: decisions whose chain path carried one of its codes (the reasons, the arrival's code, or on a later street
 * the arrival's first computation), answers whose warning carried its phrases, distinct hands, the last time, and the
 * newest hands (client hand id · street · action index) to open on the hand page. Read-only; no requests. Refuses to
 * run while a session is live (it scans the answer log).
 */
import { Database } from "bun:sqlite";
import { answersDbPath } from "../services/storePaths";
import { APPROXIMATIONS, type Approximation } from "../services/approximations";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const SINCE = Date.parse(`${arg("--since") ?? new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)}T00:00:00+07:00`);
const ID = arg("--id");
const KIND = arg("--kind");
const LIST = Number(arg("--list") ?? 10);

const db = new Database(answersDbPath(), { readonly: true });
try {
  const live = db.query("SELECT id FROM sessions WHERE ended_at IS NULL").all();
  if (live.length && !argv.includes("--force")) { console.error(`a session is live (${(live as any[]).map((s) => s.id).join(", ")}) — not scanning the answer log now (--force to override)`); process.exit(2); }
} catch { /* no sessions table in this file: a copy, go on */ }

const entries: Approximation[] = APPROXIMATIONS.filter((a) => (!ID || a.id === ID) && (!KIND || a.kind === KIND));
if (!entries.length) { console.error(`no register entry matches${ID ? ` --id ${ID}` : ""}${KIND ? ` --kind ${KIND}` : ""}`); process.exit(1); }

type Row = { id: number; ts: number; client_hand_id: string | null; street: string | null; decision_key: string | null; warning: string | null; path: string | null };
const rows = db.query<Row, [number]>(
  "SELECT id, ts, client_hand_id, street, decision_key, warning, path FROM answers WHERE ts >= ? AND text IS NOT NULL ORDER BY ts",
).all(SINCE);
type Refusal = { id: number; ts: number; client_hand_id: string | null; street: string | null; decision_key: string | null; fail_reason: string | null };
const refusals = db.query<Refusal, [number]>(
  "SELECT id, ts, client_hand_id, street, decision_key, fail_reason FROM answers WHERE ts >= ? AND text IS NULL AND fail_reason IS NOT NULL ORDER BY ts",
).all(SINCE);

const codesOf = (r: Row): Set<string> => {
  const out = new Set<string>();
  try {
    const p = r.path ? JSON.parse(r.path) : null;
    for (const x of p?.reasons ?? []) if (x?.code) out.add(x.code);
    if (p?.arrival?.code) out.add(p.arrival.code);
    if (p?.arrival?.first?.code) out.add(p.arrival.first.code);
  } catch { /* an unreadable path counts nothing */ }
  return out;
};
const actionIndex = (r: Pick<Row, "decision_key">) => { try { const k = JSON.parse(r.decision_key ?? "null"); return Array.isArray(k) ? k[4] : "?"; } catch { return "?"; } };

console.log(`DEPARTURES REPORT · answers since ${new Date(SINCE).toISOString().slice(0, 10)} · ${rows.length} answered decisions · ${answersDbPath()}`);
const today = new Date().toISOString().slice(0, 10);
for (const a of entries) {
  const needles = [a.warn, ...(a.warnAlso ?? [])].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const byCode: Row[] = [], byWarn: Row[] = [];
  for (const r of rows) {
    const cs = codesOf(r);
    if ((a.pathCodes ?? []).some((c) => cs.has(c))) byCode.push(r);
    const w = (r.warning ?? "").toLowerCase();
    if (needles.some((n) => w.includes(n))) byWarn.push(r);
  }
  const all = [...new Map([...byCode, ...byWarn].map((r) => [r.id, r])).values()].sort((x, y) => y.ts - x.ts);
  const hands = new Set(all.map((r) => r.client_hand_id));
  const sw = a.offSwitch ? `${a.offSwitch.env}${/^[A-Z][A-Z0-9_]+$/.test(a.offSwitch.env) ? ` = ${process.env[a.offSwitch.env] ?? "unset (default)"} in this shell` : ""}` : "no switch";
  const due = a.reviewBy ? ` · review by ${a.reviewBy}${a.lifecycle === "experiment" && a.reviewBy < today ? " — OVERDUE" : ""}` : "";
  if (!ID && !all.length && entries.length > 1) continue;
  console.log(`\n${a.badge}  [${a.id} · ${a.kind} · ${a.lifecycle}]${due}`);
  console.log(`  ${a.title}`);
  console.log(`  switch: ${sw}`);
  console.log(`  decisions: ${all.length} (path code ${byCode.length}${a.pathCodes?.length ? ` — ${a.pathCodes.join(", ")}` : ", no code"} · warning ${byWarn.length}${needles.length ? "" : ", no phrase"}) · hands ${hands.size}` +
    (all.length ? ` · last ${new Date(all[0]!.ts).toISOString().replace("T", " ").slice(0, 16)}Z` : ""));
  // an entry with several codes (hero-self-lock: the lock, and the off-answer flag to REVIEW): how often each fired
  if ((a.pathCodes?.length ?? 0) > 1) {
    console.log(`  by code: ${a.pathCodes!.map((c) => `${c} ${byCode.filter((r) => codesOf(r).has(c)).length}`).join(" · ")}`);
  }
  for (const r of all.slice(0, LIST)) {
    const cs = codesOf(r);
    const tags = (a.pathCodes ?? []).length > 1 ? (a.pathCodes ?? []).filter((c) => cs.has(c)).map((c) => c.replace(/^\w+:/, "")).join(", ") : "";
    console.log(`    ${r.client_hand_id ?? "?"} · ${r.street ?? "?"} · action ${actionIndex(r)} · answer #${r.id}${tags ? ` · ${tags}` : ""}`);
  }
  // decisions it REFUSED (no answer): the refusal reason carries one of its phrases ("HERO OFF HIS OWN TREE:", "… LOCK FAILED")
  const refused = refusals.filter((r) => needles.some((n) => (r.fail_reason ?? "").toLowerCase().includes(n)));
  if (refused.length) {
    console.log(`  refused (no answer): ${refused.length}`);
    for (const r of refused.slice(-LIST).reverse()) console.log(`    ${r.client_hand_id ?? "?"} · ${r.street ?? "?"} · action ${actionIndex(r)} · row #${r.id} · ${(r.fail_reason ?? "").slice(0, 140)}`);
  }
  if (a.diagnostic && !a.diagnostic.includes("departuresReport")) console.log(`  its own diagnostic: ${a.diagnostic}`);
}
if (!ID && entries.length > 1) console.log(`\n(entries that never fired in the window are not listed; --id <entry> shows one regardless)`);
