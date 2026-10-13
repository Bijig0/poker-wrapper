/**
 * THE SOFT-RANGE EXPERIMENT'S DIAGNOSTIC (2026-10-06; services/offTree softOffTreeRange, register entries offtree-soft-range
 * and offtree-node-lock, switches OFFTREE_RANGE=blend|soft|log|off, OFFTREE_BLEND_W, OFFTREE_RANGE_T, OFFTREE_LOCK=on|off;
 * since 2026-10-13 the default carries the BLEND and locks the rest of the street to it — soft_mode "blend"; the
 * "soft" columns hold whichever range the rule carried). Reads the central
 * database only — no requests, no solves:
 *   - every off-tree villain line logged since --since (off_tree_lines): what the detector flagged, and the range carried
 *     after it — QRE's combos against the soft range's — by spot family;
 *   - the answers that leaned on it (the note "OFF-TREE RANGE: …" / path code postflop:offtree-soft): how many, and how
 *     the hands' postflop decisions went (answered / refused, and why);
 *   - villain's cards where Ignition's history filled them (hhCheck): the class he held beside the range we carried.
 *
 *   bun src/scripts/offTreeSoftReport.ts [--since 2026-10-06] [--list 20]
 *
 * Good: lines carry soft ranges of a few to tens of combos (not ~0.01), the decisions after them answer as often as any
 * other postflop decision, nothing refuses for an empty range. Bad: refusals or timeouts clustering after soft lines (a
 * wider range makes a different tree), "not-computable" lines (no EVs at the node), or answers that look absurd — read a
 * few hand pages.
 */
import { Database } from "bun:sqlite";
import { answersDbPath } from "../services/storePaths";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const SINCE_DAY = arg("--since") ?? "2026-10-06";
const SINCE = Date.parse(`${SINCE_DAY}T00:00:00+07:00`);
const LIST = Number(arg("--list")) || 20;
const pct = (k: number, d: number) => (d ? `${((100 * k) / d).toFixed(1)}%` : "—");
const med = (xs: number[]) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : NaN; };
const c3 = (x: number | null) => (x == null || !Number.isFinite(x) ? "—" : x >= 10 ? x.toFixed(0) : x >= 0.1 ? x.toFixed(2) : x.toFixed(4));

const db = new Database(answersDbPath(), { readonly: true });
const live = db.query("SELECT id FROM sessions WHERE ended_at IS NULL").all();
if (live.length) { console.error("a poker session is live — run this after it ends"); process.exit(2); }

type Line = { ts: number; cid: string | null; origin: string; street: string; board: string; villain_pos: string; action: string; betsize: number | null;
  pot: number; node_freq: number; family: string; villain_cards: string | null; soft_mode: string | null; soft_t: number | null; qre_combos: number | null; soft_combos: number | null };
const cols = new Set((db.query("PRAGMA table_info(off_tree_lines)").all() as { name: string }[]).map((c) => c.name));
if (!cols.has("soft_combos")) { console.log("off_tree_lines has no soft columns yet — no line has been logged by the 2026-10-06 code"); process.exit(0); }
const lines = db.query<Line, [number]>(`SELECT ts, client_hand_id cid, origin, street, board, villain_pos, action, betsize, pot, node_freq, family,
  villain_cards, soft_mode, soft_t, qre_combos, soft_combos FROM off_tree_lines WHERE ts >= ? ORDER BY ts`).all(SINCE);
console.log(`OFF-TREE SOFT RANGE · lines since ${SINCE_DAY}: ${lines.length} (${lines.filter((l) => l.origin === "live").length} live, ${lines.filter((l) => l.origin === "warm").length} warm)`);
const byMode = new Map<string, number>();
for (const l of lines) byMode.set(l.soft_mode ?? "(none: OFFTREE_RANGE=off or old code)", (byMode.get(l.soft_mode ?? "(none: OFFTREE_RANGE=off or old code)") ?? 0) + 1);
console.log(`  by mode: ${[...byMode].map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}`);
const soft = lines.filter((l) => l.soft_combos != null);
console.log(`  range after the action (median): QRE ${c3(med(soft.map((l) => l.qre_combos ?? NaN)))} combos → carried ${c3(med(soft.map((l) => l.soft_combos ?? NaN)))}`);
const fams = new Map<string, Line[]>();
for (const l of lines) fams.set(l.family, [...(fams.get(l.family) ?? []), l]);
console.log("\n  by family:");
for (const [f, ls] of [...fams].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`    ${String(ls.length).padStart(3)}  ${f}  · QRE ${c3(med(ls.map((l) => l.qre_combos ?? NaN)))} → soft ${c3(med(ls.map((l) => l.soft_combos ?? NaN)))} combos`);
}
console.log(`\n  last ${Math.min(LIST, lines.length)} lines:`);
for (const l of lines.slice(-LIST)) {
  console.log(`    ${new Date(l.ts).toISOString().slice(0, 16)} ${l.cid ?? "?"} ${l.street} ${l.board} ${l.villain_pos} ${l.action}${l.betsize != null ? ` ${l.betsize}` : ""} ` +
    `(${(100 * l.node_freq).toFixed(3)}%, pot ${l.pot}) · ${l.soft_mode ?? "—"} · QRE ${c3(l.qre_combos)} → soft ${c3(l.soft_combos)}${l.villain_cards ? ` · held ${l.villain_cards}` : ""}`);
}

// ── the answers that leaned on it ──
type Ans = { cid: string; street: string; warning: string | null; fail: string | null; path: string | null };
const ans = db.query<Ans, [number]>("SELECT client_hand_id cid, street, warning, fail_reason fail, path FROM answers WHERE ts >= ? AND street != 'preflop' ORDER BY ts").all(SINCE);
const leaned = ans.filter((a) => /OFF-TREE RANGE:/.test(a.warning ?? "") || /postflop:offtree-soft/.test(a.path ?? ""));
const locked = ans.filter((a) => /postflop:offtree-lock/.test(a.path ?? ""));
const hands = new Set(leaned.map((a) => a.cid));
const inHands = ans.filter((a) => hands.has(a.cid));
const refused = inHands.filter((a) => a.fail);
console.log(`\n  postflop answers since ${SINCE_DAY}: ${ans.length} · leaning on a soft range: ${leaned.length} (${hands.size} hands) · node-locked: ${locked.length}`);
console.log(`  postflop decisions in those hands: ${inHands.length}, refused ${refused.length} (${pct(refused.length, inHands.length)}); all postflop refused ${pct(ans.filter((a) => a.fail).length, ans.length)}`);
for (const r of refused.slice(-LIST)) console.log(`    refused ${r.cid} ${r.street}: ${(r.fail ?? "").slice(0, 160)}`);
