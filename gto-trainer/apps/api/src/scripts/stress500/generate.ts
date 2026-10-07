/**
 * Build the stress-500 scenario set: the synthetic catalogue (scenarios.ts) plus the real hands the hand-4587 session
 * named (read from the live archive, read-only), checked through the system's own cut (normalizeHand →
 * withStartStacks(truncateAt)) and capture gate, written to <out>/scenarios.json.
 *
 *   bun src/scripts/stress500/generate.ts [--out C:/Users/Brady/poker-data-stress500]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHand } from "../../feed/normalizeHand/normalizeHand";
import { truncateAt, withStartStacks } from "../../utils/archivedHand/archivedHand";
import { buildCatalogue, type Scenario } from "./scenarios";
import type { Pos } from "./engine";

const argv = process.argv.slice(2);
const OUT = argv.includes("--out") ? argv[argv.indexOf("--out") + 1]! : "C:/Users/Brady/poker-data-stress500";
mkdirSync(OUT, { recursive: true });

/** the real hands (the hand-4587 brief §4 + this session's short-limp hands + dead-SB / dead-button / post-in tables) */
const REAL: { id: string; why: string }[] = [
  { id: "4922578344", why: "hand 4587: 5-way flop bet + short raise + call — the heads-up last resort's mis-press" },
  { id: "4922305100", why: "turn re-root, the old 210.6 shove (now FOLD)" },
  { id: "4922575177", why: "a merge whose member folds later — now fold:UTG + fold:BTN" },
  { id: "4921735317", why: "two flop aggressors into the turn" },
  { id: "4922304060", why: "multiway flop, merged (brief)" },
  { id: "4922372980", why: "short limper beside a deep one (brief)" },
  { id: "4922084873", why: "brief §4 real hand" },
  { id: "4922296909", why: "fold-first change: 83o OESD now check-raise" },
  { id: "4922313196", why: "fold-first change: 66 BTN" },
  { id: "4922314653", why: "fold-first change: AA river FOLD 99.7 → CALL 89" },
  { id: "4922369309", why: "fold-first change" },
  { id: "4922298483", why: "fold-first change" },
  { id: "4922299158", why: "phantom ask after hero acted (turn)" },
  { id: "4922345527", why: "phantom ask after hero acted (flop)" },
  { id: "4921602795", why: "capture fault (refused by the capture gate)" },
  { id: "4921655739", why: "capture fault (refused by the capture gate)" },
  { id: "4922555015", why: "76o vs a 39bb HJ limp — the empty-range river (the pool lock now)" },
  { id: "4922265890", why: "AA BTN behind a 30.6bb CO limp, 3-way flop" },
  { id: "4922257975", why: "BB vs a short BTN limp (v1 pool3 tree)" },
  { id: "4922085978", why: "BB vs a short SB complete" },
  { id: "4921628232", why: "post-in read as a limp; untrained limp node" },
  { id: "4921841315", why: "post-in CO with an SB complete" },
  { id: "4922293965", why: "two short limpers, multiway turn" },
  { id: "4922306545", why: "16bb BTN limp (under 20bb: never covered)" },
  { id: "4922378776", why: "7.2bb HJ limp" },
];

const live = new Database("C:/Users/Brady/poker-data/poker.sqlite", { readonly: true });
const realScenarios: Scenario[] = [];
for (const r of REAL) {
  const row = live.query("select rowid as dbId, data from hands where client_hand_id = ? order by rowid desc limit 1").get(r.id) as { dbId: number; data: string } | null;
  if (!row) { console.log(`real ${r.id}: not in the archive — skipped`); continue; }
  const raw = JSON.parse(row.data);
  const hand = normalizeHand(raw).hand;
  const heroPos = (hand.positions[hand.heroSeatId] ?? "BB") as Pos;
  const heroDecisions = hand.actions.filter((a) => a.hero && !/^post/.test(a.type)).length;
  realScenarios.push({
    id: `real-${r.id}`, family: "real", title: r.why, tags: ["real"], hero: heroPos, heroDecisions,
    raw: { ...raw, clientHandId: `stress-s5-real-${r.id}`, family: "real", title: r.why, tags: ["real"] },
    source: { clientHandId: r.id, dbId: row.dbId },
  });
}
// the synthetic catalogue
const synth = buildCatalogue();
const all = [...realScenarios, ...synth];

// every hero decision must cut cleanly through the system's own code
let decisions = 0, cutErrors = 0;
for (const sc of all) {
  const hand = normalizeHand(sc.raw as any).hand;
  for (let i = 0; i < hand.actions.length; i++) {
    const a = hand.actions[i]!;
    if (!a.hero || /^post/.test(a.type)) continue;
    try {
      const cut = withStartStacks(truncateAt(hand, i));
      if (!cut.heroCards?.length) throw new Error("no hero cards after the cut");
      decisions++;
    } catch (e) { cutErrors++; console.log(`${sc.id} cut ${i}: ${e instanceof Error ? e.message : e}`); }
  }
}
const byFamily = new Map<string, { hands: number; decisions: number }>();
for (const s of all) { const b = byFamily.get(s.family) ?? { hands: 0, decisions: 0 }; b.hands++; b.decisions += s.heroDecisions; byFamily.set(s.family, b); }
writeFileSync(join(OUT, "scenarios.json"), JSON.stringify({ builtAt: new Date().toISOString(), count: all.length, scenarios: all }));
console.log(`\n${all.length} hands (${realScenarios.length} real + ${synth.length} synthetic) · ${decisions} hero decisions · ${cutErrors} cut errors → ${join(OUT, "scenarios.json")}`);
for (const [f, b] of byFamily) console.log(`  ${f.padEnd(13)} ${String(b.hands).padStart(3)} hands · ${String(b.decisions).padStart(4)} hero decisions`);
