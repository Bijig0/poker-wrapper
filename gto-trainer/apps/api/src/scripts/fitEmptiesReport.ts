/**
 * THE LINE FIT THAT EMPTIES A GROUP (2026-10-04, utils/fitLine.emptiedGroups) — how often did a chart answer fold the
 * ONLY limper, or the only caller of a raise, out of hero's line?
 *
 *   bun src/scripts/fitEmptiesReport.ts [--since 2026-09-27] [--list 40] [--data C:/Users/Brady/poker-data]
 *
 * Reads the answer log only (read-only; no chart server, no GTO Wizard). For every served 6-max chart answer whose note
 * names a fold (LINE FITTED TO THE TREE, CALLER CAP, LINE KEPT AS THE HAND WAS READ) the hand is cut before the
 * decision exactly as the replay gate cuts it, the line rebuilt, and the folds named in the note checked against the
 * line's caller groups (level 0 = limpers, level k = callers of the k-th raise): a group the table had a player in
 * and the note folded everyone out of is counted, by chart and by kind.
 *
 * Since the rule shipped the chart REFUSES these (reason "LINE NOT HELD: …") and the GTO Wizard AI preflop tree
 * answers; the second table counts those refusals from the same log (answers.path → preflop.code
 * preflop:fit-empties), with their latency — the cost of the rule.
 *
 *   bun src/scripts/fitEmptiesReport.ts --probe 11192,12618 [--env C:/Users/Brady/poker-wrapper/config/local.env]
 *
 * PROBE: asks the EXACT GTO Wizard AI preflop tree for those logged decisions (answer ids) and prints its mix for
 * hero's hand beside what the chart served, with each villain action on the line against the tree's own play (check
 * #3). THIS SENDS GTO WIZARD REQUESTS (a tree, a solution, a few nodes per decision) — never while a session is live
 * (refused). Nothing of the hand is written: no pin, no answer row; the requests are in the request ledger.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { buildPreflopTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";
import { repairDeadSmallBlind, repairPreflopFoldOrder } from "../utils/repairPostflopRotation/repairPostflopRotation";
import { callerGroups, emptiedGroups, groupText } from "../utils/fitLine/fitLine";

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const SINCE = Date.parse(`${arg("since") ?? "2026-09-27"}T00:00:00+07:00`);
const LIST = Number(arg("list") ?? 40);
const DATA = (arg("data") ?? process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/");
const db = new Database(join(DATA, "poker.sqlite"), { readonly: true });

if (arg("probe")) {
  const live = db.query("select id from sessions where ended_at is null limit 1").get() as { id: string } | null;
  if (live) { console.error(`a poker session is LIVE (${live.id}) — not probing GTO Wizard; run again when it has ended`); process.exit(2); }
  const { existsSync, readFileSync } = await import("node:fs");
  const envFile = arg("env") ?? "C:/Users/Brady/poker-wrapper/config/local.env";
  if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
  }
  Object.assign(process.env, { POKER_DATA_DIR: DATA, HAND_FACTS_DB_PATH: ":memory:", ANSWERS_DB_PATH: ":memory:", GTOW_REQUEST_ORIGIN: "fit-empties-probe" });
  const { solvePreflopGtowAi } = await import("../services/gtowAiPreflop");
  const pct = (x: number) => `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%`;
  for (const id of arg("probe")!.split(",").map(Number).filter(Number.isFinite)) {
    const r = db.query("select id, client_hand_id, decision_key, text, chart, line, hero_pos, hero_cards from answers where id = ?").get(id) as any;
    const row = r && (db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1").get(r.client_hand_id) as { data: string } | null);
    if (!r || !row) { console.log(`\n${id}: no such answer / hand`); continue; }
    let hand = normalizeHand(JSON.parse(row.data)).hand as any;
    hand = withStartStacks(truncateAt(hand, Number(JSON.parse(r.decision_key)[4])));
    const dead = repairDeadSmallBlind(hand); if (dead.note) hand = dead.hand;
    const heroPos = hand.positions[hand.heroSeatId] ?? r.hero_pos;
    const tokens = buildPreflopTokens({ ...hand, currentNode: { ...hand.currentNode, toActIsHero: true } }, heroPos);
    const t = { ...hand, clientHandId: `probe-${r.client_hand_id}`, handId: undefined, currentNode: { ...hand.currentNode, toActIsHero: true } };
    console.log(`\n== answer ${id} · hand ${r.client_hand_id} · ${heroPos} ${r.hero_cards} · line "${tokens.join("-")}"`);
    console.log(`   the chart served (${r.chart}, read at "${r.line || "root"}"):  ${(r.text ?? "").replace(/^[≈ ]*PREFLOP — /, "")}`);
    const t0 = Date.now();
    const ai = await solvePreflopGtowAi(t, heroPos, "fit-empties probe", { skipPin: () => true, villainLines: true });
    if (!ai.ok) { console.log(`   the exact tree: NO ANSWER after ${((Date.now() - t0) / 1000).toFixed(1)} s — ${ai.reason}`); continue; }
    console.log(`   the exact tree (${ai.shape.positions.map((p) => `${p} ${ai.shape.stacks[p]}`).join(" / ")}; read at "${ai.usedLine || "root"}", ${((Date.now() - t0) / 1000).toFixed(1)} s${ai.stored ? ", from the solve cache" : ""}):  ` +
      ai.actions.map((x) => `${x.action} ${x.frequency.toFixed(0)}%`).join(" · "));
    for (const l of ai.villainLines ?? []) console.log(`   check #3: ${l.seat} ${l.code} at "${l.line || "root"}" — ${pct(l.nodeFreq)} of his range in this tree, no hand above ${pct(l.maxHand)}${l.offTree ? "  ← OFF THE TREE'S PATH" : ""}`);
    if (!(ai.villainLines ?? []).length) console.log("   check #3: no villain line read (the prefix nodes did not come back in time)");
    if (ai.fits?.length) console.log(`   (the tree could not hold the line either: read on ${ai.fits.length} fit(s) — ${ai.fits.map((f) => `${f.folds.join("+")} folded`).join(", ")})`);
  }
  process.exit(0);
}

type Row = { id: number; ts: number; client_hand_id: string; decision_key: string; text: string | null; pick: string | null; warning: string | null;
  chart: string | null; depth: number | null; line: string | null; hero_cards: string | null; hero_pos: string | null; source: string | null;
  latency_ms: number | null; path: string | null };
const rows = db.query(`select id, ts, client_hand_id, decision_key, text, pick, warning, chart, depth, line, hero_cards, hero_pos, source, latency_ms, path
  from answers where ts >= ? and street = 'preflop' and client_hand_id is not null and text is not null order by ts`).all(SINCE) as Row[];
// one row per decision (the poller re-asks every second): the last answered one
const byDecision = new Map<string, Row>();
for (const r of rows) byDecision.set(`${r.client_hand_id}|${r.decision_key}`, r);
const decisions = [...byDecision.values()];
const chartRows = decisions.filter((r) => r.source === "hrc-6max-preflop");

/** the seats a chart answer's note says were folded out of hero's line */
function foldedOf(warning: string): string[] {
  const out: string[] = [];
  const names = (s: string) => [...s.matchAll(/\b(UTG|HJ|CO|BTN|SB|BB)\b/g)].map((m) => m[1]!);
  for (const part of warning.split(" · ")) {
    if (/^LINE FITTED TO THE TREE: the chart/.test(part)) {
      const m = /, so (.*?) (?:is|are) folded out of the line/.exec(part);
      if (m) out.push(...names(m[1]!));
    } else if (/CALLER CAP:/.test(part)) {
      const m = /with (\w+)'s call folded/.exec(part);
      if (m) out.push(m[1]!);
    } else if (/LINE KEPT AS THE HAND WAS READ:/.test(part)) {
      const m = /LINE KEPT AS THE HAND WAS READ: (.*?)'s call (?:was|were) folded out at hero's earlier decision/.exec(part);
      if (m) out.push(...names(m[1]!));
    }
  }
  return [...new Set(out)];
}

const handQ = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1");
type Hit = { r: Row; tokens: string[]; folded: string[]; emptied: ReturnType<typeof emptiedGroups>; groups: ReturnType<typeof callerGroups>; wanted: string | null };
const hits: Hit[] = [];
let fitted = 0, unreadable = 0;
for (const r of chartRows) {
  const folded = foldedOf(r.warning ?? "");
  if (!folded.length) continue;
  fitted++;
  const row = handQ.get(r.client_hand_id) as { data: string } | null;
  let tokens: string[] | null = null, heroSeat: string | null = null;
  try {
    const n = Number(JSON.parse(r.decision_key)[4]);
    let hand = normalizeHand(JSON.parse(row!.data)).hand as any;
    if (!(n <= hand.actions.length)) throw new Error("decision past the archived line");
    hand = withStartStacks(truncateAt(hand, n));
    const dead = repairDeadSmallBlind(hand); if (dead.note) hand = dead.hand;
    const folds = repairPreflopFoldOrder(hand); if (folds.note) hand = folds.hand;
    heroSeat = hand.positions[hand.heroSeatId] ?? r.hero_pos;
    tokens = buildPreflopTokens(hand, heroSeat);
  } catch { unreadable++; continue; }
  const opts = { heroSeat, stack: r.depth ?? 100 };
  const emptied = emptiedGroups(tokens!, folded, opts);
  const wanted = /no (\S+) tree in the set/.exec(r.warning ?? "")?.[1] ?? null;
  if (emptied.length) hits.push({ r, tokens: tokens!, folded, emptied, groups: callerGroups(tokens!, opts), wanted });
}

const pct = (k: number, d: number) => (d ? `${((100 * k) / d).toFixed(2)}%` : "—");
console.log(`Served preflop decisions since ${arg("since") ?? "2026-09-27"}: ${decisions.length} — ${chartRows.length} answered by the 6-max charts, ${fitted} of those with a caller folded out (fit / caller cap / kept)` +
  (unreadable ? `, ${unreadable} whose hand could not be rebuilt` : ""));
console.log(`\nTHE FOLD EMPTIED A GROUP (the only limper, or the only caller of a raise, deleted): ${hits.length} chart answers (${pct(hits.length, chartRows.length)} of chart answers, ${pct(hits.length, fitted)} of fitted ones)`);
const kindOf = (h: Hit) => [...new Set(h.emptied.map((g) => (g.level === 0 ? "limper(s) of the unraised pot" : `caller(s) of raise ${g.level}`)))].join(" + ");
const tally = <T,>(xs: T[], key: (x: T) => string) => { const c = new Map<string, number>(); for (const x of xs) c.set(key(x), (c.get(key(x)) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]); };
console.log(`\n  by kind:`);
for (const [k, n] of tally(hits, kindOf)) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`\n  by chart (what the group was · the tree the picker wanted, when it fell back):`);
for (const [k, n] of tally(hits, (h) => h.r.chart ?? "?")) {
  const of = hits.filter((h) => (h.r.chart ?? "?") === k);
  const what = tally(of, (h) => h.emptied.map(groupText).join(" + ")).map(([t, m]) => `${t} ×${m}`).join(", ");
  const wanted = tally(of.filter((h) => h.wanted), (h) => h.wanted!).map(([t, m]) => `${t} ×${m}`).join(", ");
  console.log(`  ${String(n).padStart(4)}  ${k}  —  ${what}${wanted ? `  ·  wanted: ${wanted}` : ""}`);
}
console.log(`\n  the missing trees the picker asked for (factory side):`);
for (const [k, n] of tally(hits.filter((h) => h.wanted), (h) => h.wanted!)) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`\n  the decisions (answer · hand · hero · line as played → as read · folded · served):`);
for (const h of hits.slice(0, LIST)) {
  console.log(`  ${h.r.id}  ${h.r.client_hand_id}  ${h.r.hero_pos ?? "?"} ${h.r.hero_cards ?? ""}  ${h.tokens.join("-") || "(root)"} → ${h.r.line || "(root)"}  [${h.r.chart}]  ` +
    `${h.emptied.map(groupText).join(" + ")} folded  ·  ${(h.r.text ?? "").replace(/^[≈ ]*PREFLOP — /, "").slice(0, 90)}`);
}
if (hits.length > LIST) console.log(`  … ${hits.length - LIST} more (--list N)`);

// ---- since the rule: the chart's refusals and what they cost ---------------------------------------------------------
const routed = decisions.filter((r) => { try { return JSON.parse(r.path ?? "{}")?.preflop?.code === "preflop:fit-empties"; } catch { return false; } });
if (routed.length) {
  const ms = routed.map((r) => r.latency_ms ?? NaN).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]! : NaN;
  console.log(`\nSINCE THE RULE: ${routed.length} decisions the chart refused for it (the exact tree answered) — latency p50 ${(q(0.5) / 1000).toFixed(1)} s, p90 ${(q(0.9) / 1000).toFixed(1)} s, max ${(q(1) / 1000).toFixed(1)} s; ` +
    `${routed.filter((r) => r.source !== "gtow-ai-preflop").length} not answered by the AI preflop tree`);
} else console.log(`\nSINCE THE RULE: no decision carries preflop:fit-empties yet.`);
