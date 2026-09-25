/**
 * GOLDEN RANGES (2026-09-25, round 2 of the input-mutation harness, oracle layer 3). Every real postflop solve is
 * stored with its inputs (data/solves.sqlite: the flop-entering 1326-combo ranges GTO Wizard was sent, the pot, the
 * stack, the chart they came from). For archived Ignition 6-max hands whose stored solve has a trace, this rebuilds
 * the solver input TODAY — hero's preflop decisions replayed in order (so the preflop pin is set as it was live),
 * then the postflop decision as a dry run — and compares it seat by seat to what was sent then.
 *
 * Read-only on both databases (the main checkout's solves.sqlite and the wrapper's hands.db). Offline: GTOW_BLOCK,
 * POSTFLOP_DRY_RUN, the baked charts (harnessEnv).
 *
 *   HRC6MAX_DB=… ANSWERS_DB_PATH=:memory: bun src/scripts/mutation/goldenRanges.ts [--limit=400] [--origins=live,replay,stress] [--out=file.jsonl]
 *
 * Each hand prints one line: then vs now — the chart, the pot/stack, and the largest per-combo range difference per
 * seat (with its class). A difference is a CLASS to judge: a regression (fix it) or the old solve was wrong.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
process.env.ANSWERS_DB_PATH ??= ":memory:";
import { harnessEnv } from "../mutationHarness";
import { fastSolve, forgetPreflopPin, forgetPostflopPin } from "../../services/fastSolve";
import { forgetCheckpoints } from "../../services/aiChain";
import { normalizeHand } from "../../feed/normalizeHand/normalizeHand";
import { truncateAt } from "../../utils/archivedHand/archivedHand";
import { COMBOS } from "../../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const limit = Number(arg("limit", "400"));
const origins = arg("origins", "live,replay,stress,adhoc,backtest").split(",");
const outFile = arg("out", "");
const STRATEGY = "ign200-ring-6max-equilibrium";

const solves = new Database("C:/Users/Brady/poker/gto-trainer/apps/api/data/solves.sqlite", { readonly: true });
const hands = new Database("C:/Users/Brady/poker/ignition-study-wrapper/data/hands.db", { readonly: true });
const unzip = (b: Uint8Array) => JSON.parse(Buffer.from(Bun.gunzipSync(b as Uint8Array<ArrayBuffer>)).toString());

interface Row { id: number; ts: number; origin: string; client_hand_id: string; decision_key: string | null; street: string; line: string | null; trace: Uint8Array }
const rows = solves.query<Row, []>(
  `SELECT id, ts, origin, client_hand_id, decision_key, street, line, trace FROM solves
   WHERE ok = 1 AND client_hand_id IS NOT NULL AND tier = 'ai-chain' ORDER BY id`).all()
  .filter((r) => origins.includes(r.origin));

// one golden per hand: its FIRST stored 6-max chart solve on a plain tree (no collapse, no re-root); every later solve
// of the same hand is checked to have been sent the same flop ranges (a chain that re-derived them is a leak)
const byHand = new Map<string, { row: Row; spec: any }[]>();
for (const r of rows) {
  let t: any; try { t = unzip(r.trace); } catch { continue; }
  const spec = t?.spec;
  if (!spec || !/ign200_6max/.test(String(spec.rangeSource ?? "")) || spec.firstStreet || spec.planTag) continue;
  (byHand.get(r.client_hand_id) ?? byHand.set(r.client_hand_id, []).get(r.client_hand_id)!).push({ row: r, spec });
}

const maxDiff = (a: number[], b: number[]) => {
  let m = 0, at = -1;
  for (let i = 0; i < 1326; i++) { const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0)); if (d > m) { m = d; at = i; } }
  return { m, cls: at >= 0 ? COMBOS[at]!.cls : null, a: at >= 0 ? a[at] ?? 0 : 0, b: at >= 0 ? b[at] ?? 0 : 0 };
};
const seatsOf = (spec: any): Record<string, number[]> => ({
  [String(spec.oopPos).toUpperCase()]: spec.oopRange, [String(spec.ipPos).toUpperCase()]: spec.ipRange,
  ...(spec.midPos ? { [String(spec.midPos).toUpperCase()]: spec.midRange } : {}),
});

const restore = harnessEnv();
const quiet = { log: console.log, warn: console.warn, error: console.error };
const mute = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const unmute = () => Object.assign(console, quiet);
const results: any[] = [];
let n = 0;
for (const [hid, list] of byHand) {
  if (n >= limit) break;
  // within the hand: every stored solve sent the same flop ranges
  const first = list[0]!;
  const drift = list.slice(1).map((x) => {
    const A = seatsOf(first.spec), B = seatsOf(x.spec);
    const worst = Object.keys(A).map((p) => (B[p] ? maxDiff(A[p]!, B[p]!).m : 1)).reduce((s, v) => Math.max(s, v), 0);
    return { id: x.row.id, street: x.row.street, worst };
  }).filter((x) => x.worst > 1e-6);
  const raw = hands.query<{ data: string }, [string]>("SELECT data FROM hands WHERE json_extract(data, '$.clientHandId') = ? ORDER BY rowid DESC LIMIT 1").get(hid);
  if (!raw) continue;
  const rawJ = JSON.parse(raw.data);
  if (String(rawJ.site ?? "ignition") !== "ignition") continue;
  let hand: ParsedHand;
  try { hand = normalizeHand(rawJ).hand!; } catch { continue; }
  n++;
  const heroPos = hand.positions[hand.heroSeatId] ?? null;
  // the decision the golden solve answered: its decision key's action count, else hero's first action on that street
  let upto = -1;
  try { const dk = JSON.parse(first.row.decision_key ?? "null"); if (Array.isArray(dk) && Number.isFinite(dk[4])) upto = Number(dk[4]); } catch { /* */ }
  const heroAt = (i: number) => hand.actions[i]?.hero && hand.actions[i]?.street === first.row.street;
  if (!(upto >= 0 && upto <= hand.actions.length && (heroAt(upto) || upto === hand.actions.length))) {
    upto = hand.actions.findIndex((a) => a.hero && a.street === first.row.street);
  }
  if (upto < 0) { results.push({ hand: hid, solveId: first.row.id, skip: "decision not found in the archive" }); continue; }
  forgetPreflopPin(hid); forgetPostflopPin(hid); forgetCheckpoints(hid);
  mute();
  try {
    for (let i = 0; i < upto; i++) {
      const a = hand.actions[i]!;
      if (a.hero && a.street === "preflop" && a.type !== "post-sb" && a.type !== "post-bb") await fastSolve(truncateAt(hand, i), heroPos, { strategyId: STRATEGY, origin: "golden" });
    }
    var res: any = await fastSolve(truncateAt(hand, upto), heroPos, { strategyId: STRATEGY, origin: "golden" });
  } catch (e: any) { res = { ok: false, reason: `THREW ${e?.message ?? e}` }; }
  unmute();
  const then = { src: first.spec.rangeSource, pot: first.spec.flopPot, stack: first.spec.flopStack, seats: seatsOf(first.spec) };
  const out: any = { hand: hid, solveId: first.row.id, origin: first.row.origin, at: new Date(first.row.ts).toISOString().slice(0, 16), street: first.row.street,
    then: { src: then.src, pot: then.pot, stack: then.stack }, drift };
  if (!res.ok || !res.dryRun?.trees?.length) { out.now = { refused: String(res.reason ?? res.warning ?? "?").slice(0, 300) }; results.push(out); continue; }
  const tree = res.dryRun.trees[0];
  const nowSeats: Record<string, number[]> = Object.fromEntries(tree.seats.map((s: any) => [String(s.pos).toUpperCase(), s.range]));
  out.now = { src: res.rangeSource, pot: res.dryRun.flopPot, stack: tree.stack ?? res.dryRun.flopStack, kind: tree.kind, trees: res.dryRun.trees.length, note: String(res.warning ?? "").slice(0, 400) };
  // the LATEST stored solve of the hand too: a difference from the first one that today shares with the latest is an
  // old solve the pipeline has since corrected; a difference from the latest is the candidate regression
  const last = list[list.length - 1]!;
  const L = seatsOf(last.spec);
  out.latest = { id: last.row.id, origin: last.row.origin, at: new Date(last.row.ts).toISOString().slice(0, 16), src: last.spec.rangeSource,
    worst: Math.max(0, ...Object.keys(nowSeats).map((p) => (L[p] ? maxDiff(L[p]!, nowSeats[p]!).m : 1))) };
  out.dealt = hand.startStacks ?? null;
  out.seats = Object.fromEntries([...new Set([...Object.keys(then.seats), ...Object.keys(nowSeats)])].map((p) => {
    const A = then.seats[p], B = nowSeats[p];
    if (!A || !B) return [p, { only: A ? "then" : "now" }];
    const d = maxDiff(A, B);
    return [p, { max: Math.round(d.m * 1e4) / 1e4, cls: d.cls, then: Math.round(d.a * 1e4) / 1e4, now: Math.round(d.b * 1e4) / 1e4 }];
  }));
  results.push(out);
}
restore();

const same = (r: any) => r.seats && Object.values(r.seats).every((s: any) => s.max != null && s.max <= 0.0011);
let identical = 0;
for (const r of results) {
  if (same(r) && Math.abs(r.now.pot - r.then.pot) < 0.26 && r.now.src === r.then.src) { identical++; continue; }
  const seats = r.seats ? Object.entries(r.seats).map(([p, s]: any) => (s.only ? `${p}: ${s.only} only` : `${p} ${s.max}${s.max > 0.0011 ? ` (${s.cls} ${s.then}→${s.now})` : ""}`)).join(", ") : "";
  console.log(`${r.hand} #${r.solveId} ${r.origin} ${r.at} ${r.street}: ` +
    (r.skip ? `SKIP ${r.skip}` : r.now.refused ? `NOW REFUSED — ${r.now.refused}` :
      `${r.then.src === r.now.src ? r.now.src : `${r.then.src} → ${r.now.src}`} · pot ${r.then.pot}→${r.now.pot} stack ${r.then.stack}→${r.now.stack} · ${seats}`) +
    (r.latest && r.latest.id !== r.solveId ? ` · LATEST #${r.latest.id} ${r.latest.origin} ${r.latest.at} ${r.latest.src === r.now?.src ? "" : r.latest.src + " "}vs now ${r.latest.worst.toFixed(3)}` : "") +
    (r.drift?.length ? ` · ${r.drift.length} later solve(s) of the hand sent other ranges (worst ${Math.max(...r.drift.map((d: any) => d.worst)).toFixed(3)})` : ""));
}
console.log(`\n${results.length} golden hands · ${identical} identical today (ranges within 0.001, same chart, same pot) · ${results.length - identical} differ or refuse`);
if (outFile) writeFileSync(outFile, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
process.exit(0);
