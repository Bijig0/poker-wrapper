/**
 * THE GAP GATE'S DIAGNOSTIC (2026-10-02, services/treeGap) — is the rule that sends chart decisions to the exact GTO
 * Wizard tree doing what it was built to do, and at what cost?
 *
 *   bun src/scripts/gapGateReport.ts [--since 2026-10-02] [--list 12]     what the gate did LIVE, from the answer log
 *   bun src/scripts/gapGateReport.ts --replay                              what it WOULD do over every logged decision
 *
 * LIVE (the default) reads answers.path → $.treeGap, which every 6-max preflop answer carries since the gate shipped:
 *   - how many decisions the gate sent to the exact tree, by rule (raise size / the aggressor's stack) and level;
 *   - how those went: answered by the exact tree, or the chart after all (the tree failed, or ran past the time box);
 *   - what it cost in time: latency of the routed answers against the chart's;
 *   - what it changed: the exact tree's answer for hero's hand beside what the chart would have said (same action?
 *     how much of the mix moved?) — the side-by-side every routed answer logs;
 *   - under PREFLOP_GAP_GATE=log, the decisions it WOULD have sent (nothing is routed in that mode).
 * REPLAY re-answers every logged hero preflop decision from the charts with the gate in log mode — the share the rule
 * moves, with no session needed. Reads only; spends no GTO Wizard requests.
 *
 * WHAT TO LOOK FOR: routed share near the replay's; "chart after all" rare (a high rate = the time box or the token);
 * routed latency inside the clock; and the answers actually differing — a gate whose two answers always agree is
 * costing requests and seconds for nothing and its bounds can be loosened.
 */
import { Database } from "bun:sqlite";
import { answersDbPath, handsDbPath } from "../services/storePaths";
import type { TreeGap, GapReason } from "../services/treeGap";

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const REPLAY = argv.includes("--replay");
const LIST = Number(arg("--list")) || 12;
const SINCE = Date.parse(`${arg("--since") ?? "2026-10-02"}T00:00:00+07:00`);
const pct = (k: number, d: number) => (d ? `${((100 * k) / d).toFixed(1)}%` : "—");
const q = (xs: number[], p: number) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const lv = (n: number) => (n <= 1 ? "open" : n === 2 ? "3-bet" : "4-bet+");
const cell = (r: GapReason) => (r.rule === "size" ? `size · ${lv(r.level)}` : `stack · facing ${r.level >= 2 ? "a re-raise" : "an all-in"}`);
const tally = (rows: GapReason[][]) => { const c = new Map<string, number>(); for (const rs of rows) for (const k of new Set(rs.map(cell))) c.set(k, (c.get(k) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]); };

if (REPLAY) {
  // every logged hero preflop decision, answered by the charts with the gate recording its verdict only
  process.env.PREFLOP_GAP_GATE = "log";
  const { normalizeHand } = await import("../feed/normalizeHand/normalizeHand");
  const { truncateAt } = await import("../utils/archivedHand/archivedHand");
  const { repairDeadSmallBlind } = await import("../utils/repairPostflopRotation/repairPostflopRotation");
  const { is6Handed, solvePreflop6max } = await import("../services/fastSolve");
  const { SIX_MAX_STRATEGY_ID } = await import("../services/strategies");
  const adb = new Database(answersDbPath(), { readonly: true }), hdb = new Database(handsDbPath(), { readonly: true });
  const cids = adb.query<{ cid: string }, []>(`SELECT DISTINCT client_hand_id cid FROM answers WHERE source IN ('hrc-6max-preflop','gtow-ai-preflop') AND session_id IS NOT NULL AND client_hand_id IS NOT NULL`).all().map((r) => r.cid);
  const hq = hdb.query<{ data: string }, [string]>(`SELECT data FROM hands WHERE client_hand_id = ? AND status <> 'live' ORDER BY rowid DESC LIMIT 1`);
  let decisions = 0, chart = 0, refused = 0;
  const routed: { key: string; g: TreeGap }[] = [];
  for (const cid of cids) {
    const row = hq.get(cid);
    if (!row) continue;
    let hand: any;
    try { hand = normalizeHand(JSON.parse(row.data)).hand; } catch { continue; }
    if (!hand || hand.postIns?.length || repairDeadSmallBlind(hand).note) continue;
    const heroPos = hand.positions[hand.heroSeatId] ?? null;
    if (!heroPos || hand.heroCards.length !== 2) continue;
    for (let i = 0; i < hand.actions.length; i++) {
      const a = hand.actions[i];
      if (a.street !== "preflop") break;
      if (!a.hero || /^post/.test(a.type)) continue;
      const t = truncateAt(hand, i);
      const cut = { ...t, currentNode: { ...t.currentNode, toActIsHero: true }, clientHandId: undefined, handId: undefined } as any;
      if (!is6Handed(cut, heroPos)) continue;
      decisions++;
      let six: Awaited<ReturnType<typeof solvePreflop6max>> = null;
      try { six = await solvePreflop6max(cut, heroPos, "audit", SIX_MAX_STRATEGY_ID); } catch { /* counted as refused */ }
      if (!six || !six.ok) { refused++; continue; }
      chart++;
      if (six.treeGap?.gate.route) routed.push({ key: `${cid}@${i}`, g: six.treeGap });
    }
  }
  console.log(`REPLAY — ${decisions} six-handed hero preflop decisions in the log: ${chart} the charts answer, ${refused} they already refuse (off-tree line, size past 1.49x, untrained node …)`);
  console.log(`\nTHE GAP GATE WOULD SEND ${routed.length} of the ${chart} chart answers to the exact tree (${pct(routed.length, chart)})`);
  for (const [k, n] of tally(routed.map((r) => r.g.gate.reasons))) console.log(`  ${String(n).padStart(4)}  ${pct(n, chart).padStart(6)}  ${k}`);
  const sizes = routed.flatMap((r) => r.g.gate.reasons.filter((x) => x.rule === "size").map((x) => `${lv(x.level)} ${x.what}`));
  const top = new Map<string, number>(); for (const s of sizes) top.set(s, (top.get(s) ?? 0) + 1);
  console.log(`\n  the sizes it fires on most:  ${[...top].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${k} ×${n}`).join("   ")}`);
  console.log(`\n  examples:`);
  for (const r of routed.slice(0, LIST)) console.log(`    ${r.key}  on ${r.g.chart.replace(/^ign200_6max_/, "")}: ${r.g.gate.reasons.map((x) => `${cell(x)} ${x.what} ${x.ratio}x > ${x.tau}x`).join("; ")}`);
  process.exit(0);
}

// ── live ───────────────────────────────────────────────────────────────────────────────────────────────────────
type Row = { id: number; ts: number; client_hand_id: string | null; source: string | null; text: string | null; pick: string | null;
  latency_ms: number | null; hero_cards: string | null; decision_json: string | null; path: string | null; warning: string | null };
const db = new Database(answersDbPath(), { readonly: true });
const rows = db.query<Row, [number]>(
  `SELECT id, ts, client_hand_id, source, text, pick, latency_ms, hero_cards, decision_json, path, warning FROM answers
    WHERE street = 'preflop' AND ts >= ? AND path LIKE '%"treeGap"%' ORDER BY ts`).all(SINCE);
const withGap = rows.map((r) => { try { return { r, g: JSON.parse(r.path!).treeGap as TreeGap }; } catch { return null; } }).filter((x): x is { r: Row; g: TreeGap } => !!x?.g?.gate);
console.log(`LIVE since ${new Date(SINCE).toISOString().slice(0, 10)}: ${withGap.length} six-handed preflop decisions carry the gate's measurement`);
if (!withGap.length) { console.log("  none yet — the gate logs from the first session after the API restart that loaded it"); process.exit(0); }
const modes = new Map<string, number>(); for (const x of withGap) modes.set(x.g.gate.mode, (modes.get(x.g.gate.mode) ?? 0) + 1);
console.log(`  gate mode on those rows: ${[...modes].map(([k, n]) => `${k} ${n}`).join(" · ")}`);

const sent = withGap.filter((x) => x.g.gate.route && x.g.routed), logOnly = withGap.filter((x) => x.g.gate.route && !x.g.routed);
const inside = withGap.filter((x) => !x.g.gate.route);
console.log(`\nSENT TO THE EXACT TREE: ${sent.length} of ${withGap.length} (${pct(sent.length, withGap.length)})` + (logOnly.length ? `   ·   would have been sent (log mode): ${logOnly.length} (${pct(logOnly.length, withGap.length)})` : ""));
for (const [k, n] of tally([...sent, ...logOnly].map((x) => x.g.gate.reasons))) console.log(`  ${String(n).padStart(4)}  ${k}`);

if (sent.length) {
  const by = (how: string) => sent.filter((x) => x.g.routed!.ai === how);
  const answered = by("answered").filter((x) => x.r.source === "gtow-ai-preflop" && x.r.text), failed = by("failed"), timeout = by("timeout");
  const none = sent.filter((x) => !x.r.text);
  console.log(`\nHOW THEY WENT`);
  console.log(`  answered by the exact tree      ${String(answered.length).padStart(4)}  ${pct(answered.length, sent.length)}`);
  console.log(`  chart after all — tree failed   ${String(failed.length).padStart(4)}  ${pct(failed.length, sent.length)}`);
  console.log(`  chart after all — time box      ${String(timeout.length).padStart(4)}  ${pct(timeout.length, sent.length)}`);
  console.log(`  NO ANSWER AT ALL                ${String(none.length).padStart(4)}  ${pct(none.length, sent.length)}${none.length ? "   ← the gate must never cost an answer: read these first" : ""}`);
  const why = new Map<string, number>(); for (const x of failed) { const k = (x.g.routed!.aiWhy ?? "?").replace(/[\d.]+/g, "#").slice(0, 80); why.set(k, (why.get(k) ?? 0) + 1); }
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`      ${n}× ${k}`);

  const lat = (xs: { r: Row }[]) => xs.map((x) => x.r.latency_ms).filter((v): v is number => v != null);
  const la = lat(answered), lc = lat(inside.filter((x) => x.r.source === "hrc-6max-preflop")), lf = lat([...failed, ...timeout]);
  const line = (name: string, xs: number[]) => console.log(`  ${name.padEnd(30)} n ${String(xs.length).padStart(4)}   p50 ${(q(xs, .5) / 1000).toFixed(1)} s   p90 ${(q(xs, .9) / 1000).toFixed(1)} s   max ${(Math.max(...xs, 0) / 1000).toFixed(1)} s`);
  console.log(`\nWHAT IT COST IN TIME (the clock is 15 s)`);
  if (la.length) line("exact tree answered", la);
  if (lf.length) line("chart after all", lf);
  if (lc.length) line("chart, not routed", lc);

  // the side-by-side: the exact tree's mix for hero's hand against the chart's, by action kind
  const kind = (a: string) => { const l = a.toLowerCase(); return l.startsWith("fold") ? "fold" : /call|check|limp/.test(l) ? "call" : /all-?in/.test(l) ? "jam" : "raise"; };
  const mixOf = (xs: { action: string; frequency: number }[]) => { const m: Record<string, number> = {}; let t = 0; for (const a of xs) { m[kind(a.action)] = (m[kind(a.action)] ?? 0) + a.frequency; t += a.frequency; } for (const k of Object.keys(m)) m[k] = m[k]! / (t || 1); return m; };
  const topOf = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
  const cmp = answered.map((x) => {
    let ai: { action: string; frequency: number }[] = [];
    try { ai = JSON.parse(x.r.decision_json ?? "[]"); } catch { /* no mix logged */ }
    const c = x.g.routed!.chartMix;
    if (!ai.length || !c.length) return null;
    const a = mixOf(ai), b = mixOf(c);
    const tvd = 0.5 * [...new Set([...Object.keys(a), ...Object.keys(b)])].reduce((s, k) => s + Math.abs((a[k] ?? 0) - (b[k] ?? 0)), 0);
    return { x, a, b, tvd, same: topOf(a) === topOf(b) };
  }).filter((v): v is NonNullable<typeof v> => !!v);
  console.log(`\nWHAT IT CHANGED — the exact tree's answer for hero's hand beside the chart's (${cmp.length} routed answers with both)`);
  if (cmp.length) {
    console.log(`  same top action ${pct(cmp.filter((c) => c.same).length, cmp.length)}   ·   mix moved: mean ${pct(cmp.reduce((s, c) => s + c.tvd, 0), cmp.length)}, p90 ${(100 * q(cmp.map((c) => c.tvd), .9)).toFixed(0)}%`);
    const fmt = (m: Record<string, number>) => Object.entries(m).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}`).join("/");
    console.log(`  the biggest differences:`);
    for (const c of cmp.sort((m, n) => n.tvd - m.tvd).slice(0, LIST)) {
      console.log(`    ${(100 * c.tvd).toFixed(0).padStart(3)}%  hand ${c.x.r.client_hand_id} ${c.x.r.hero_cards ?? ""}: exact ${fmt(c.a)}  |  chart ${fmt(c.b)}  — ${c.x.g.gate.reasons.map((r) => `${cell(r)} ${r.what}`).join("; ")}`);
    }
  }
}
console.log(`\nNOT ROUTED: ${inside.length}. Their largest size snaps (inside the bounds): ` +
  [1, 2, 3].map((l) => { const xs = inside.filter((x) => x.g.size?.level === l).map((x) => x.g.size!.ratio); return `${lv(l)} n ${xs.length}${xs.length ? ` max ${Math.max(...xs)}x` : ""}`; }).join(" · "));
