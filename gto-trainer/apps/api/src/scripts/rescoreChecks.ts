/**
 * RE-SCORE THE STORED ANSWER CHECKS (2026-10-03, audit finding 5 — Brady approved the check fixes that day).
 *
 * Three checks were redefined (services/chainChecks):
 *   #4  "Seats right"     the heads-up rule (big blind first) applies on a table DEALT two only; a blind-vs-blind pot at
 *                         a table dealt 3-6 is the small blind first. Every stored "SB → BB … by position it is BB → SB"
 *                         fail at a ring table was the check, not the tree.
 *   #12 "Solve time"      the street-over-its-rolling-median half is a FLAG (never a verdict); the action clock stays a fail.
 *   #14 "Hero's node"     preflop, the node may name hero's seat as a tree for that many DEALT players names it (a dead
 *                         button: the CO of a table dealt three is the tree's BTN); an all-in for no more than the
 *                         amount to call is the call for less, not a raise.
 * This script brings the answers already logged (poker.sqlite answers.path / answers.path_verdict) to the same truth:
 *   - it recomputes ONLY those three, and only where the stored text is the old wording of a result the change
 *     redefines; every other check, and every row whose result does not change, is left byte-for-byte alone;
 *   - #4 is recomputed with the live function (checkSeats) from the stored seats, the players DEALT in the hand
 *     (the hand's own capture via utils/dealtSeats.dealtCount — the live code's count — else answers.table_seats;
 *     with neither, the dealt count is unknown and a blind-vs-blind pot is "not checked", as live), and the warm-up's
 *     seating from the hand's tree ledger (hand_facts); the node-agreement count was never stored on a failed order,
 *     and the re-scored text says so;
 *   - #12: a stored fail made only of median parts becomes a flag (each part keeps its numbers, plus the live flag's
 *     wording); a fail with an action-clock part stays a fail, untouched;
 *   - #14: re-run with the live function (checkButtons) on what the row stores — the actions (decision_json), the
 *     amount to call (decision_key) and, for the seat half, the hand's dealt seats; for the all-in half the stack
 *     behind as the fail text recorded it. The seat re-run has no stack behind (not stored): its raise half is skipped;
 *   - the verdict and reasons are recomputed with chainPath.classifyPath — the function the live code classifies with —
 *     from the path's own fields. A stored path that classifyPath does not reproduce as stored (before any change) is
 *     re-scored by keeping its non-check reasons as stored and replacing the check reasons with checkReasons (the same
 *     function), the verdict = worst(); the dry run counts those.
 *
 *   bun src/scripts/rescoreChecks.ts                      DRY RUN (default): before/after counts, 10 examples; writes nothing
 *   bun src/scripts/rescoreChecks.ts --apply              refuses while a poker session is live; backs up every changed
 *                                                         row's original path + path_verdict to
 *                                                         C:/Users/Brady/poker-data/audits/checks-noise-fix-2026-10/answers-path-backup-<ts>.jsonl,
 *                                                         then updates them in ONE transaction. Idempotent: a second run
 *                                                         changes nothing (the new texts are not the old wording).
 *   bun src/scripts/rescoreChecks.ts --restore <file>     puts the backed-up path + path_verdict back (one transaction)
 *   --backup-dir <dir>    where --apply writes its backup (default the audit folder above)
 *   --db <poker.sqlite>   the database (default: the central data root's, POKER_DATA_DIR — the live one is
 *                         C:/Users/Brady/poker-data/poker.sqlite; a shell without env.ps1 resolves <repo>/data)   --examples N
 *
 * OTHER STORED COPIES OF THE VERDICT: answers.path_verdict (updated here, with the path). Everything else is derived on
 * read: the panel's banner and session clean count (studyPoller.chainBanner → chainPath.cleanRate over answers), the
 * session's Technical tab (technicalReport over answers), the hand page (handVerdicts over answers), the Coverage page
 * (coverageReport over answers.path). The sessions table's summary holds no verdict. The solve traces (solves.trace →
 * streets[].checks) keep each walk's own street checks as they were computed — a record of the walk, read by nothing
 * that sets or shows a verdict — and are left as history.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  checkButtons, checkReasons, checkSeats, CHECK_STREETS, mergeChecks, SOLVE_FLAG_NOTE,
  type CheckResult, type CheckStreet, type PathChecks,
} from "../services/chainChecks";
import { classifyPath, worst, type DecisionPath } from "../services/chainPath";

export const BACKUP_DIR = "C:/Users/Brady/poker-data/audits/checks-noise-fix-2026-10";

/** What the re-score needs to know about a row's hand beyond the row itself. */
export interface HandCtx {
  /** players dealt, from the hand's capture (utils/dealtSeats.dealtCount) — null when the hand is not stored */
  dealtFromHand: number | null;
  /** the dealt seats' labels, hero's included (for #14's seat half) */
  dealtLabels: string[] | null;
  /** the hand's tree ledger (hand_facts.doc.trees): the warm-up's seating per street and plan */
  trees: { k: number; plan: string | null; origin: string | null; seats?: string[] | null }[];
}
export interface AnswerRow {
  id: number; client_hand_id: string | null; table_seats: number | null; decision_key: string | null; decision_json: string | null;
  path_verdict: string | null; path: string | null;
}
export interface Rescored {
  changed: boolean;
  path: string | null; verdict: string | null;
  /** ids changed, per street, old → new status */
  edits: { street: CheckStreet; id: number; from: string; to: string; text: string }[];
  /** the stored path was not reproduced by classifyPath before the change (re-scored by the fallback) */
  irreproducible: boolean;
  /** #4 dealt count used, and where it came from */
  dealtSrc?: "hand" | "table_seats" | "unknown";
  dealtDisagree?: { hand: number; table_seats: number };
}

const STREET_K: Record<string, number> = { flop: 0, turn: 1, river: 2 };

// the old wordings this change redefines — only these are touched
const OLD_SEATS = /^(?:(.+?): )?the tree seats (.+) in acting order; by position it is (.+) \(out of position first\)$/;
const MEDIAN = /over \d+(?:\.\d+)?× its rolling median of /;
const CLOCK = /past the \d+(?:\.\d+)? s action clock/;
const OLD_NODE = /^the answer is (\S+)'s node, not hero's \((\S+)\)$/;
const OLD_ALLIN = /^the answer offers a raise although calling (\d+(?:\.\d+)?)bb puts hero all in \((\d+(?:\.\d+)?)bb behind\)$/;

const actionsOf = (json: string | null): { action: string; frequency: number }[] => {
  try { const j = JSON.parse(json ?? "[]"); return Array.isArray(j) ? j.map((x: any) => ({ action: String(x.action ?? ""), frequency: Number(x.frequency) || 0 })) : []; } catch { return []; }
};
const toCallOf = (key: string | null): number | null => {
  try { const k = JSON.parse(key ?? "null"); return Array.isArray(k) && Number.isFinite(Number(k[3])) ? Number(k[3]) : null; } catch { return null; }
};

/** #4: a stored old-wording order fail, recomputed with the dealt count. null = not this change's to touch. */
function rescoreSeats(c: CheckResult, street: CheckStreet, dealt: number | null, ctx: HandCtx): CheckResult | null {
  if (c.status !== "fail" || c.covered) return null;
  const parts = c.text.split(" · ");
  const out: CheckResult[] = [];
  for (const part of parts) {
    const m = part.match(OLD_SEATS);
    if (!m) return null;                                   // a part this change does not redefine: leave the whole result
    const plan = m[1] ?? null;
    const players = m[2]!.split(" → ");
    const k = STREET_K[street];
    const warm = ctx.trees.find((t) => t.k === k && (t.plan ?? null) === plan && t.origin === "warm" && Array.isArray(t.seats));
    const r = checkSeats({ players, agreed: null, unnamed: null, warmSeats: warm?.seats ?? null, origin: "live", dealt });
    out.push(plan ? { ...r, text: `${plan}: ${r.text}` } : r);
  }
  // the parts fold as the live addChecks folds a street's plans (mergeChecks: one per id, the worst status, its texts)
  return mergeChecks(out)[0]!;
}

/** #12: a stored fail made only of rolling-median parts becomes the flag the live check now gives. */
function rescoreSolveTime(c: CheckResult): CheckResult | null {
  if (c.status !== "fail") return null;
  const parts = c.text.split(" · ");
  if (!parts.every((p) => MEDIAN.test(p) && !CLOCK.test(p))) return null;   // a clock part (or anything else): still a fail
  return { id: 12, status: "flag", text: parts.map((p) => (p.endsWith(SOLVE_FLAG_NOTE) ? p : `${p}${SOLVE_FLAG_NOTE}`)).join(" · ") };
}

/** #14: the two fails step 3 traced to the check, re-run with the live function. */
function rescoreButtons(c: CheckResult, row: AnswerRow, ctx: HandCtx): CheckResult | null {
  if (c.status !== "fail" || c.covered) return null;
  const actions = actionsOf(row.decision_json);
  const node = c.text.match(OLD_NODE);
  if (node) {
    if (!ctx.dealtLabels?.length) return null;            // the hand's dealt seats are needed to judge it
    return checkButtons({
      actions, toCall: toCallOf(row.decision_key), heroBehind: null, legal: [],
      nodePos: node[1]!, heroPos: node[2]!, hu: ctx.dealtLabels.length === 2, dealtLabels: ctx.dealtLabels,
    });
  }
  const allin = c.text.match(OLD_ALLIN);
  if (allin) return checkButtons({ actions, toCall: Number(allin[1]), heroBehind: Number(allin[2]), legal: [] });
  return null;
}

const reclassify = (p: DecisionPath, checks: PathChecks): DecisionPath => {
  const { v: _v, verdict: _vd, reasons, ...rest } = p;
  return classifyPath({ ...rest, checks, fault: reasons.find((r) => r.v === "fault") ?? null });
};

const sortKeys = (x: unknown): unknown => Array.isArray(x) ? x.map(sortKeys)
  : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys((x as Record<string, unknown>)[k])])) : x;
const sameContent = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

/** One row, re-scored. Pure: no database. */
export function rescoreRow(row: AnswerRow, ctx: HandCtx): Rescored {
  const same: Rescored = { changed: false, path: row.path, verdict: row.path_verdict, edits: [], irreproducible: false };
  if (!row.path) return same;
  let p: DecisionPath;
  try { p = JSON.parse(row.path) as DecisionPath; } catch { return same; }
  if (!p?.checks) return same;
  const dealt: number | null = ctx.dealtFromHand ?? row.table_seats ?? null;
  const dealtSrc: Rescored["dealtSrc"] = ctx.dealtFromHand != null ? "hand" : row.table_seats != null ? "table_seats" : "unknown";
  const dealtDisagree = ctx.dealtFromHand != null && row.table_seats != null && ctx.dealtFromHand !== row.table_seats
    ? { hand: ctx.dealtFromHand, table_seats: row.table_seats } : undefined;
  const checks: PathChecks = {};
  const edits: Rescored["edits"] = [];
  let touched4 = false;
  for (const st of CHECK_STREETS) {
    const xs = p.checks[st];
    if (!xs) continue;
    checks[st] = xs.map((c) => {
      const next = c.id === 4 && st !== "preflop" ? rescoreSeats(c, st, dealt, ctx)
        : c.id === 12 ? rescoreSolveTime(c)
          : c.id === 14 && st === "preflop" ? rescoreButtons(c, row, ctx)
            : null;
      if (!next || (next.status === c.status && next.text === c.text && next.covered === c.covered)) return c;
      if (c.id === 4) touched4 = true;
      edits.push({ street: st, id: c.id, from: c.status, to: next.status, text: next.text });
      return next;
    });
  }
  if (!edits.length) return same;
  // the verdict and reasons, with the live functions. The stored path keeps its own key order (the live code adds
  // `requests` / `origin` after classifying), so "reproduces" compares the content, and the new values are written
  // into the stored object's own keys
  const reproduces = sameContent(reclassify(p, p.checks), p);
  let reasons: DecisionPath["reasons"], verdict: DecisionPath["verdict"];
  if (reproduces) ({ reasons, verdict } = reclassify(p, checks));
  else {
    const keep = p.reasons.filter((r) => !r.code.startsWith("check:") && r.v !== "fault");
    const faults = p.reasons.filter((r) => r.v === "fault");
    reasons = [...keep, ...checkReasons(checks), ...faults];
    verdict = worst(reasons.map((r) => r.v));
  }
  const out: DecisionPath = { ...p, checks, reasons, verdict };
  return {
    changed: true, path: JSON.stringify(out), verdict: out.verdict, edits, irreproducible: !reproduces,
    ...(touched4 ? { dealtSrc, ...(dealtDisagree ? { dealtDisagree } : {}) } : {}),
  };
}

// ── the database side ───────────────────────────────────────────────────────────────────────────────────────────
export function liveSessions(db: Database): string[] {
  try { return (db.query("SELECT id FROM sessions WHERE ended_at IS NULL").all() as { id: string }[]).map((r) => r.id); }
  catch { return []; }   // no sessions table (a scratch copy): nothing live
}

/** Each hand's context, read once (hands.data → dealt seats; hand_facts.doc → trees). */
export async function handCtxReader(db: Database): Promise<(cid: string | null) => HandCtx> {
  const { normalizeHand } = await import("../feed/normalizeHand/normalizeHand");
  const { dealtCount, dealtSeats } = await import("../utils/dealtSeats/dealtSeats");
  const has = (t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
  const hq = has("hands") ? db.query<{ data: string }, [string]>("SELECT data FROM hands WHERE client_hand_id = ? ORDER BY rowid DESC LIMIT 1") : null;
  const fq = has("hand_facts") ? db.query<{ doc: string }, [string]>("SELECT doc FROM hand_facts WHERE hand_key = ?") : null;
  const memo = new Map<string, HandCtx>();
  return (cid) => {
    const none: HandCtx = { dealtFromHand: null, dealtLabels: null, trees: [] };
    if (!cid) return none;
    const hit = memo.get(cid);
    if (hit) return hit;
    const ctx: HandCtx = { ...none };
    const h = hq?.get(cid);
    if (h) {
      try {
        const hand = normalizeHand(JSON.parse(h.data)).hand;
        if (hand) {
          const heroPos = hand.positions?.[hand.heroSeatId] ?? null;
          ctx.dealtFromHand = dealtCount(hand, heroPos);
          ctx.dealtLabels = [...dealtSeats(hand, heroPos).values()];
        }
      } catch { /* an unreadable hand: unknown */ }
    }
    const f = fq?.get(cid);
    if (f) { try { const d = JSON.parse(f.doc); if (Array.isArray(d?.trees)) ctx.trees = d.trees; } catch { /* none */ } }
    memo.set(cid, ctx);
    return ctx;
  };
}

interface Tally { verdicts: Record<string, number>; fails: Record<number, number>; flags: Record<number, number>; rows: number }
function tally(paths: (string | null)[], verdicts: (string | null)[]): Tally {
  const t: Tally = { verdicts: {}, fails: {}, flags: {}, rows: 0 };
  paths.forEach((path, i) => {
    let p: DecisionPath | null = null;
    try { p = path ? JSON.parse(path) : null; } catch { p = null; }
    if (!p?.checks) return;
    t.rows++;
    const v = verdicts[i] ?? "(none)";
    t.verdicts[v] = (t.verdicts[v] ?? 0) + 1;
    const failing = new Set<number>(), flagged = new Set<number>();
    for (const st of CHECK_STREETS) for (const c of p.checks[st] ?? []) {
      if (c.status === "fail") failing.add(c.id);
      if (c.status === "flag") flagged.add(c.id);
    }
    for (const id of failing) t.fails[id] = (t.fails[id] ?? 0) + 1;
    for (const id of flagged) t.flags[id] = (t.flags[id] ?? 0) + 1;
  });
  return t;
}

export interface RunOpts {
  db: Database; dbPath: string;
  apply?: boolean; restore?: string | null;
  /** where --apply writes its backup (default BACKUP_DIR) */
  backupDir?: string;
  examples?: number;
  log?: (line: string) => void;
}
export interface RunResult { refused?: string; rows: number; changed: number; applied?: number; backup?: string; restored?: number }

/** The dry run, --apply or --restore on an open database (the CLI below; tests drive it on a scratch database). */
export async function runRescore(o: RunOpts): Promise<RunResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const db = o.db;
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='answers'").get()) {
    return { refused: `no answers table in ${o.dbPath} — the live root is POKER_DATA_DIR (env.ps1); pass --db C:/Users/Brady/poker-data/poker.sqlite`, rows: 0, changed: 0 };
  }
  if (o.apply || o.restore) {
    const live = liveSessions(db);
    if (live.length) return { refused: `REFUSED: a poker session is live (${live.join(", ")}) — run again when it has ended.`, rows: 0, changed: 0 };
  }

  if (o.restore) {
    const lines = readFileSync(o.restore, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { id: number; path: string | null; path_verdict: string | null });
    const up = db.query("UPDATE answers SET path = ?, path_verdict = ? WHERE id = ?");
    let n = 0;
    db.transaction(() => { for (const l of lines) n += up.run(l.path, l.path_verdict, l.id).changes; })();
    log(`restored ${n} of ${lines.length} rows from ${o.restore}`);
    return { rows: lines.length, changed: 0, restored: n };
  }

  const EXAMPLES = o.examples ?? 10;
  const rows = db.query("SELECT id, client_hand_id, table_seats, decision_key, decision_json, path_verdict, path FROM answers WHERE path IS NOT NULL AND path LIKE '%\"checks\"%' ORDER BY id").all() as AnswerRow[];
  const ctxOf = await handCtxReader(db);
  const results = rows.map((r) => ({ row: r, res: rescoreRow(r, ctxOf(r.client_hand_id)) }));
  const changed = results.filter((x) => x.res.changed);

  const before = tally(rows.map((r) => r.path), rows.map((r) => r.path_verdict));
  const after = tally(results.map((x) => x.res.path), results.map((x) => x.res.verdict));
  const ids = [...new Set([...Object.keys(before.fails), ...Object.keys(after.fails), ...Object.keys(before.flags), ...Object.keys(after.flags)].map(Number))].sort((a, b) => a - b);
  const vs = [...new Set([...Object.keys(before.verdicts), ...Object.keys(after.verdicts)])];
  log(`\nrows with checks: ${rows.length} · rows changed: ${changed.length}`);
  log("\nverdict              before   after");
  for (const v of vs) log(`  ${v.padEnd(18)} ${String(before.verdicts[v] ?? 0).padStart(6)} ${String(after.verdicts[v] ?? 0).padStart(7)}`);
  log("\nrows with a FAIL / FLAG on check   before (fail/flag)   after (fail/flag)");
  for (const id of ids) log(`  #${String(id).padEnd(4)} ${`${before.fails[id] ?? 0} / ${before.flags[id] ?? 0}`.padStart(16)} ${`${after.fails[id] ?? 0} / ${after.flags[id] ?? 0}`.padStart(19)}`);
  const byEdit = new Map<string, number>();
  for (const x of changed) for (const e of x.res.edits) { const k = `#${e.id} ${e.street}: ${e.from} → ${e.to}`; byEdit.set(k, (byEdit.get(k) ?? 0) + 1); }
  log("\nresults changed (per street):");
  for (const [k, n] of [...byEdit].sort()) log(`  ${String(n).padStart(5)} × ${k}`);
  const vMove = new Map<string, number>();
  for (const x of changed) { const k = `${x.row.path_verdict} → ${x.res.verdict}`; vMove.set(k, (vMove.get(k) ?? 0) + 1); }
  log("\nverdict moves on the changed rows:");
  for (const [k, n] of [...vMove].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(5)} × ${k}`);
  const src = new Map<string, number>();
  for (const x of changed) if (x.res.dealtSrc) src.set(x.res.dealtSrc, (src.get(x.res.dealtSrc) ?? 0) + 1);
  const disagree = changed.filter((x) => x.res.dealtDisagree);
  log(`\n#4 dealt count from: ${[...src].map(([k, n]) => `${k} ${n}`).join(", ") || "—"} · hand vs table_seats disagree on ${disagree.length} row(s)${disagree.length ? `: ${disagree.slice(0, 5).map((x) => `${x.row.id} hand ${x.res.dealtDisagree!.hand} / table_seats ${x.res.dealtDisagree!.table_seats}`).join("; ")}` : ""}`);
  log(`changed rows whose stored path classifyPath did not reproduce (re-scored by the fallback): ${changed.filter((x) => x.res.irreproducible).length}`);
  // what is still failing after the change — the answers a person should look at
  const left = results.filter((x) => x.res.verdict === "failed");
  const leftBy = new Map<string, number>();
  for (const x of left) {
    let p: DecisionPath | null = null;
    try { p = JSON.parse(x.res.path!); } catch { /* none */ }
    const k = [...new Set(CHECK_STREETS.flatMap((st) => (p?.checks?.[st] ?? []).filter((c) => c.status === "fail" && !c.covered).map((c) => c.id)))].sort((a, b) => a - b).join("+") || "(another reason)";
    leftBy.set(k, (leftBy.get(k) ?? 0) + 1);
  }
  log(`\nstill "failed" after the re-score: ${left.length} — by the failing checks: ${[...leftBy].sort((a, b) => b[1] - a[1]).map(([k, n]) => `#${k} ${n}`).join(" · ") || "none"}`);
  log(`\nexamples (${Math.min(EXAMPLES, changed.length)} of ${changed.length}):`);
  const pick: typeof changed = [];
  for (const id of [4, 12, 14]) pick.push(...changed.filter((x) => x.res.edits.some((e) => e.id === id) && !pick.includes(x)).slice(0, Math.ceil(EXAMPLES / 3)));
  for (const x of pick.slice(0, EXAMPLES)) {
    log(`  answer ${x.row.id} · hand ${x.row.client_hand_id} · ${x.row.path_verdict} → ${x.res.verdict}`);
    for (const e of x.res.edits) log(`      #${e.id} ${e.street} ${e.from} → ${e.to}: ${e.text.slice(0, 220)}`);
  }

  if (!o.apply) { log("\nDRY RUN — nothing written. --apply writes (with a backup first)."); return { rows: rows.length, changed: changed.length }; }
  if (!changed.length) { log("\nnothing to change."); return { rows: rows.length, changed: 0, applied: 0 }; }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${o.backupDir ?? BACKUP_DIR}/answers-path-backup-${ts}.jsonl`;
  if (!existsSync(dirname(backup))) mkdirSync(dirname(backup), { recursive: true });
  writeFileSync(backup, changed.map((x) => JSON.stringify({ id: x.row.id, path: x.row.path, path_verdict: x.row.path_verdict })).join("\n") + "\n");
  // a row is written only if its path is still the one read (nothing else changed it in between)
  const up = db.query("UPDATE answers SET path = ?, path_verdict = ? WHERE id = ? AND path = ?");
  let n = 0;
  db.transaction(() => { for (const x of changed) n += up.run(x.res.path, x.res.verdict, x.row.id, x.row.path).changes; })();
  log(`\nAPPLIED: ${n} of ${changed.length} rows updated in one transaction · backup ${backup} · undo: --restore ${backup}`);
  return { rows: rows.length, changed: changed.length, applied: n, backup };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const apply = argv.includes("--apply");
  const restore = arg("--restore") ?? null;
  const dbPath = arg("--db") ?? (await import("../services/storePaths")).answersDbPath();
  const writes = apply || !!restore;
  const db = new Database(dbPath, writes ? {} : { readonly: true });
  console.log(`database: ${dbPath} (${writes ? "read-write" : "read-only, dry run"})`);
  const r = await runRescore({ db, dbPath, apply, restore, backupDir: arg("--backup-dir"), examples: Number(arg("--examples")) || 10 });
  db.close();
  if (r.refused) { console.error(r.refused); process.exit(2); }
}

if (import.meta.main) await main();
