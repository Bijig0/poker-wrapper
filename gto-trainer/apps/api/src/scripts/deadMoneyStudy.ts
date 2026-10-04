/**
 * THE DEAD-MONEY COLLAPSE ON THE DECISIONS THE HEADS-UP LAST RESORT ANSWERED (2026-10-05, after hand 4922578344).
 * Every postflop decision whose live answer was the POSTFLOP LAST RESORT (since --since) is solved again through THIS
 * checkout's fastSolve — the dead-money collapse where no ghost or merge fits — with the flop ranges the live solve used
 * (the replay gate's seam: the stored traces' class weights), and printed beside what the last resort served.
 * There is no truth for a 4+ way spot; this shows what changes, how often an answer comes back, and what it costs.
 *
 *   . config/env.ps1; bun run src/scripts/deadMoneyStudy.ts [--since 2026-09-27] [--hands id,id] [--out file.json] [--budget 1500]
 *
 * SOLVES ON THE LIVE GTO Wizard accounts (new trees: the dead-money trees and, on the turn/river, the re-root's
 * narrowing walks), stored as origin "replay" like /api/dashboard/resolve-chain. NOT while a session is live.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";
import { fastSolve, replaySeams } from "../services/fastSolve";
import { canonicalStrategyId } from "../services/strategies";
import { COMBOS } from "../utils/comboIndex/comboIndex";

const argv = process.argv.slice(2);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const SINCE = Date.parse(`${arg("since") ?? "2026-09-27"}T00:00:00`);
const ONLY = arg("hands")?.split(",").filter(Boolean) ?? null;
const OUT = arg("out");
const BUDGET = Number(arg("budget") ?? 1500);
const DATA = (process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/");
const db = new Database(`${DATA}/poker.sqlite`, { readonly: true });
const live = () => (db.query("select id from sessions where ended_at is null").all() as any[]).length > 0;
const lastHour = () => (db.query("select count(*) n from gtow_requests where ts > ?").get(Date.now() - 3600_000) as { n: number }).n;
if (live()) { console.log("a session is LIVE — not running"); process.exit(2); }

type Row = { id: number; ts: number; client_hand_id: string; street: string; pick: string | null; decision_json: string | null; decision_key: string; session_id: string | null; hero_cards: string | null };
// --answers id,id: those decisions whatever answered them (the fold-out port's changed collapse spots, 2026-10-05)
const ANSWERS = arg("answers")?.split(",").filter(Boolean).map(Number) ?? null;
let rows = (ANSWERS
  ? db.query(`select id, ts, client_hand_id, street, pick, decision_json, decision_key, session_id, hero_cards from answers
      where id in (${ANSWERS.map(() => "?").join(",")}) order by ts`).all(...ANSWERS)
  : db.query(`select id, ts, client_hand_id, street, pick, decision_json, decision_key, session_id, hero_cards from answers
      where street != 'preflop' and warning like '%POSTFLOP LAST RESORT%' and ts >= ? order by ts`).all(SINCE)) as Row[];
if (ONLY) rows = rows.filter((r) => ONLY.includes(r.client_hand_id));
// one row per decision (the last answer for a key)
const byKey = new Map<string, Row>();
for (const r of rows) byKey.set(`${r.client_hand_id}|${r.decision_key}`, r);
rows = [...byKey.values()].sort((a, b) => a.ts - b.ts);

// the flop ranges the live solve used (scripts/replayGate.ts arrivalFor, condensed): every seat's range at the flop
// as a stored walk from the flop had it (not a re-root's or a narrowing's, not a merged seat), as class weights
const traceOf = (id: number) => { const r = db.query("select trace from solves where id = ?").get(id) as { trace: Uint8Array } | null;
  try { return r?.trace ? JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(r.trace))).toString("utf-8")) : null; } catch { return null; } };
const stored = new Map<string, { ranges: Record<string, Record<string, number>>; complete: boolean } | null>();
const arrivalFor = (hand: string) => {
  if (stored.has(hand)) return stored.get(hand)!;
  const ranges: Record<string, Record<string, number>> = {};
  for (const s of db.query("select id from solves where client_hand_id = ? and ok = 1 order by id").all(hand) as { id: number }[]) {
    const sp = traceOf(s.id)?.spec;
    if (!sp || (sp.firstStreet && !/^last-resort/.test(sp.planTag ?? "")) || /narrowing/.test(sp.rangeSource ?? "")) continue;
    const merged = new Set([...(sp.planTag ?? "").matchAll(/merge:(UTG\+[12]|MP\+1|[A-Z]+)\+(UTG\+[12]|MP\+1|[A-Z]+)/g)].flatMap((m: RegExpMatchArray) => [m[1], m[2]]));
    for (const [pos, r] of [[sp.oopPos, sp.oopRange], [sp.midPos, sp.midRange], [sp.ipPos, sp.ipRange]] as [string, number[]][]) {
      if (!pos || ranges[pos] || merged.has(pos) || !Array.isArray(r) || r.length !== 1326) continue;
      const w: Record<string, number> = {};
      r.forEach((x, i) => { const c = COMBOS[i]!.cls; if (x > (w[c] ?? 0)) w[c] = x; });
      ranges[pos] = w;
    }
  }
  const ov = Object.keys(ranges).length ? { ranges, complete: false } : null;
  stored.set(hand, ov);
  return ov;
};
replaySeams.arrival = (h: any) => arrivalFor(String(h.clientHandId ?? ""));

const strategyFor = (sid: string | null): string | null => {
  if (!sid) return null;
  const s = db.query("select config from sessions where id = ?").get(sid) as { config: string } | null;
  try { return canonicalStrategyId(JSON.parse(s?.config ?? "{}").strategy ?? null); } catch { return null; }
};
const mix = (acts: { action: string; frequency: number; ev?: number }[] | null | undefined) =>
  (acts ?? []).filter((a) => a.frequency >= 0.5).map((a) => `${a.action} ${a.frequency.toFixed(1)}${a.ev != null ? ` (${a.ev.toFixed(2)})` : ""}`).join(" · ");
const kindOf = (w: string) => /DEAD-MONEY COLLAPSE/.test(w) ? "dead-money (flop)" : /RE-ROOTED AT THE/.test(w) ? (/dead:/.test(w) ? "re-rooted + dead-money" : "re-rooted") : /-WAY APPROXIMATION/.test(w) ? "ghost/merge" : "other";

const out: any[] = [];
const t0 = Date.now();
for (const r of rows) {
  if (live()) { console.log("a session went LIVE — stopping"); break; }
  if (lastHour() > BUDGET) { console.log(`GTO Wizard requests in the last hour past ${BUDGET} — stopping`); break; }
  const row = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1").get(r.client_hand_id) as { data: string } | null;
  const base = { answer: r.id, hand: r.client_hand_id, street: r.street, cards: r.hero_cards, live: { pick: r.pick, mix: mix(JSON.parse(r.decision_json ?? "[]")) } };
  if (!row) { out.push({ ...base, skipped: "hand not archived" }); continue; }
  const raw = JSON.parse(row.data);
  const hand = normalizeHand(raw).hand;
  const heroPos = hand.positions?.[hand.heroSeatId] ?? null;
  const n = Number(JSON.parse(r.decision_key)[4]);
  if (!Number.isFinite(n) || n > hand.actions.length) { out.push({ ...base, skipped: `key ${r.decision_key} past the archived line` }); continue; }
  const cut = withStartStacks(truncateAt(hand, n));
  const strategyId = strategyFor(r.session_id ?? raw.sessionId ?? null);
  const tA = Date.now();
  let res: any;
  try {
    res = await fastSolve({ ...cut, currentNode: { ...cut.currentNode, toActIsHero: true } }, heroPos,
      { heroPos, origin: "replay", ...(strategyId ? { strategyId } : {}) });
  } catch (e) { res = { ok: false, reason: `threw: ${(e as Error)?.message ?? e}` }; }
  const ms = Date.now() - tA;
  const w = String(res?.warning ?? "");
  const rec = { ...base, ms, ok: !!res?.ok, kind: res?.ok ? kindOf(w) : null,
    warning: w.slice(0, 1500),
    plans: (w.match(/DEAD-MONEY COLLAPSE[^:]*: (.*?)\.\s/)?.[1] ?? w.match(/(?:collapsed to three|alone is collapsed): (.*?)\.\s/)?.[1] ?? null),
    now: res?.ok ? { pick: res.decision?.action ?? null, mix: mix(res.actions) } : { refused: String(res?.reason ?? res?.why ?? "?").slice(0, 400) } };
  out.push(rec);
  console.log(`${r.client_hand_id} ${r.street.padEnd(5)} ${r.hero_cards ?? "????"}  ${(ms / 1000).toFixed(1)}s\n   live : ${base.live.mix}\n   now  : ${rec.ok ? `${rec.now.mix}   [${rec.kind}: ${rec.plans ?? "?"}]` : `REFUSED ${rec.now.refused}`}`);
}
const answered = out.filter((x) => x.ok);
console.log(`\n${out.length} decisions · answered ${answered.length} · refused ${out.filter((x) => x.ok === false).length} · skipped ${out.filter((x) => x.skipped).length}` +
  ` · median ${answered.length ? (answered.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(answered.length / 2)] / 1000).toFixed(1) : "-"} s · total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
process.exit(0);
