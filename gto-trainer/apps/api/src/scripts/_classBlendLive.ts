/**
 * THE CLASS-ALIGNED BLEND ON LIVE ANSWERS, OFFLINE (2026-10-07, claude/short-allin-sized). The replay gate cannot
 * re-solve answers from before the 2026-10-03 tree rewrite (their tree bodies are not in the cache, the network is
 * blocked), so this re-blends what was SOLVED live: every collapse walk of a decision is in the solve store with the
 * same client hand id + decision key; hero's node in each trace carries the menu and the 1326 strategy. For each live
 * answer whose note says a collapse "offered a different action menu and was left out of the blend", it prints the
 * mix served live, the old rule re-computed (exact codes — must equal the live mix) and the new one (codesOnRef).
 *   bun src/scripts/_classBlendLive.ts [--db C:/Users/Brady/poker-data/poker.sqlite]
 * Read-only.
 */
import { Database } from "bun:sqlite";
import { codesOnRef } from "../services/deadMoneyCollapse";
import { alignStrategy, blendStrategies } from "../services/multiwayCollapse";

const argv = process.argv.slice(2);
const DB = argv.includes("--db") ? argv[argv.indexOf("--db") + 1]! : "C:/Users/Brady/poker-data/poker.sqlite";
const db = new Database(DB, { readonly: true });
type Ans = { id: number; client_hand_id: string; decision_key: string; street: string; solve_id: number | null; decision_json: string | null; pick: string | null; hero_cards: string | null };
const rows = db.query<Ans, []>(`SELECT id, client_hand_id, decision_key, street, solve_id, decision_json, pick, hero_cards FROM answers
  WHERE warning LIKE '%offered a different action menu%' ORDER BY ts`).all();
const label = (a: any) => (a.betsize > 0 && !/\d/.test(a.name) ? `${a.name} ${Math.round(a.betsize * 100) / 100}` : a.name);
const pct = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}`;
for (const r of rows) {
  const solves = db.query<{ id: number; trace: Uint8Array; why: string | null }, [string, string]>(
    "SELECT id, trace, why FROM solves WHERE client_hand_id = ? AND decision_key = ? AND ok = 1 ORDER BY id").all(r.client_hand_id, r.decision_key);
  const walks = solves.map((s) => {
    const t = JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(s.trace))).toString("utf-8"));
    const n = [...(t.nodes ?? [])].reverse().find((x: any) => x.heroNode);
    return { id: s.id, plan: t.spec?.planTag ?? null, combo: t.spec?.heroComboIdx as number, node: n };
  }).filter((w) => w.node);
  // the live call kept the LAST walk per plan (a seatbelt re-solve writes another set); the reference is the answer's solve
  const byPlan = new Map<string, (typeof walks)[number]>();
  for (const w of walks) byPlan.set(String(w.plan), w);
  const ref = walks.find((w) => w.id === r.solve_id) ?? walks[0];
  if (!ref) { console.log(`answer ${r.id}: no stored walks`); continue; }
  const set = [ref, ...[...byPlan.values()].filter((w) => w.plan !== ref.plan)];
  const sols = (w: (typeof set)[number]) => (w.node.actions as any[]).map((a) => ({ code: String(a.code), name: String(a.name), strategy: a.strategy as number[] }));
  const codes = sols(ref).map((x) => x.code);
  const i = ref.combo;
  const blendOf = (byClass: boolean) => {
    const al: number[][][] = [], left: string[] = [];
    for (const w of set) {
      const mine = sols(w);
      const c = w === ref || !byClass ? { codes: mine.map((x) => x.code) } : codesOnRef(sols(ref), mine);
      const a = alignStrategy(codes, mine.map((x, k) => ({ code: c.codes[k] ?? `${x.code}?`, strategy: x.strategy })));
      if (a) al.push(a); else left.push(String(w.plan));
    }
    const b = al.length > 1 ? blendStrategies(codes, al) : al[0]!;
    return { mix: (ref.node.actions as any[]).map((a, k) => `${label(a)} ${pct(b[k]![i] ?? 0)}`).join(" · "), kept: al.length, left };
  };
  const live = (JSON.parse(r.decision_json ?? "[]") as any[]).map((a) => `${a.action} ${(Math.round(a.frequency * 10) / 10).toFixed(1)}`).join(" · ");
  const per = set.map((w) => `${w.plan}: ${(w.node.actions as any[]).map((a: any) => `${label(a)} ${pct(a.strategy?.[i] ?? 0)}`).join(" / ")}`);
  const o = blendOf(false), nw = blendOf(true);
  console.log(`answer ${r.id} · hand ${r.client_hand_id} ${r.street} ${r.hero_cards ?? ""} · picked ${r.pick}`);
  console.log(`   live      ${live}`);
  console.log(`   old rule  ${o.mix}   (${o.kept} blended; left out: ${o.left.join(", ") || "none"})`);
  console.log(`   new rule  ${nw.mix}   (${nw.kept} blended; left out: ${nw.left.join(", ") || "none"})`);
  for (const p of per) console.log(`      ${p}`);
}
