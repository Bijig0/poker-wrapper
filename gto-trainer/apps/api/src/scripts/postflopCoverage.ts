/**
 * POSTFLOP COVERAGE, OFFLINE (2026-10-05, Brady: "Need 100% coverage please, be thorough"). Every logged postflop
 * decision since --since is put through THIS checkout's fastSolve with POSTFLOP_DRY_RUN=1 — the whole planning (flop
 * ranges, collapse / fold-out / dead-money / re-root / takeover narrowing, pot and stacks) up to the solver input, and
 * no solve. Nothing leaves: fetch is blocked but the local chart server, and the data are a COPY (--work, a replay gate
 * work dir: poker.sqlite + gtow-cache.sqlite). A re-root's narrowing walks are cloud solves: one stopped by the blocked
 * network means the plan EXISTS (the walks are what it would run), so it counts as planned.
 * The flop-entering ranges are the ones the live solve used (the replay gate's seam), so an old preflop tree the cache
 * no longer holds does not stop the postflop question.
 *
 *   bun run src/scripts/postflopCoverage.ts --work C:/Users/Brady/AppData/Local/Temp/rg-deadmoney-candidate [--since 2026-09-27] [--hands id,id] [--out file.json]
 * (the hand facts are the copy's: a hand pinned to a GTO Wizard preflop tree waits ~31 s on the blocked network per decision)
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const WORK = (arg("work") ?? "").replace(/\\/g, "/");
if (!WORK || !existsSync(`${WORK}/poker.sqlite`)) { console.log("--work <a replay gate work dir holding poker.sqlite> is required"); process.exit(2); }
const SINCE = Date.parse(`${arg("since") ?? "2026-09-27"}T00:00:00`);
const OUT = arg("out");
process.env.POKER_DATA_DIR = WORK;
// the hand facts (preflop pins, chain checkpoints) the live worker kept, from the copy — a script defaults to an empty
// in-memory store, and without the pins a flop whose preflop line the chart no longer holds would refuse here only
if (!argv.includes("--no-facts")) process.env.HAND_FACTS_DB_PATH = `${WORK}/poker.sqlite`;
process.env.POSTFLOP_DRY_RUN = "1";
process.env.GTOW_PREFETCH = "0";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost):8777\b/.test(url)) return realFetch(input, init);
  throw new Error("coverage: no network");
}) as typeof fetch;

const db = new Database(`${WORK}/poker.sqlite`, { readonly: true });
const { normalizeHand } = await import("../feed/normalizeHand/normalizeHand");
const { truncateAt, withStartStacks } = await import("../utils/archivedHand/archivedHand");
const FS = await import("../services/fastSolve");
const { canonicalStrategyId } = await import("../services/strategies");
const { COMBOS } = await import("../utils/comboIndex/comboIndex");
const { gtowSessions } = await import("../services/gtowSessions");
const { gtowApi } = await import("../services/gtowApi");
(gtowSessions as any).tokenFor = async () => "coverage-no-token";
(gtowApi as any).accessToken = async () => "coverage-no-token";

type Row = { id: number; ts: number; client_hand_id: string; street: string; decision_key: string; session_id: string | null; pick: string | null };
const all = db.query(`select id, ts, client_hand_id, street, decision_key, session_id, pick from answers
  where street != 'preflop' and ts >= ? and client_hand_id is not null order by ts`).all(SINCE) as Row[];
const byKey = new Map<string, Row>();
for (const r of all) byKey.set(`${r.client_hand_id}|${r.decision_key}`, r);
const ONLY = arg("hands")?.split(",").filter(Boolean) ?? null;
const rows = [...byKey.values()].filter((r) => !ONLY || ONLY.includes(r.client_hand_id)).sort((a, b) => a.ts - b.ts);

// the flop ranges the live solve used (replayGate's arrivalFor): class weights by position from the stored walks
const traceOf = (id: number) => { const r = db.query("select trace from solves where id = ?").get(id) as { trace: Uint8Array } | null;
  try { return r?.trace ? JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(r.trace))).toString("utf-8")) : null; } catch { return null; } };
const flopSeatsOf = new Map<string, string[]>();
const FILL = argv.includes("--fill");
const CLASSES = [...new Set(COMBOS.map((c: any) => c.cls as string))];
const stored = new Map<string, any>();
const arrivalFor = (hand: string) => {
  if (stored.has(hand)) return stored.get(hand);
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
  const seats = flopSeatsOf.get(hand) ?? [];
  // --fill: a flop seat no stored walk holds gets a uniform range — the PLANNING does not read range values, only who
  // is in; it lets a hand whose arrival needs the cloud (a pinned GTO Wizard preflop tree) still be planned offline
  if (FILL) for (const p of seats) if (!Object.keys(ranges).some((k) => k.toUpperCase() === p)) ranges[p] = Object.fromEntries(CLASSES.map((c) => [c, 1]));
  const have = new Set(Object.keys(ranges).map((p) => p.toUpperCase()));
  const ov = Object.keys(ranges).length ? { ranges, complete: seats.length > 0 && seats.every((p) => have.has(p)) } : null;
  stored.set(hand, ov);
  return ov;
};
(FS as any).replaySeams.arrival = (h: any) => arrivalFor(String(h.clientHandId ?? ""));
const strategyFor = (sid: string | null): string | null => {
  if (!sid) return null;
  const s = db.query("select config from sessions where id = ?").get(sid) as { config: string } | null;
  try { return canonicalStrategyId(JSON.parse(s?.config ?? "{}").strategy ?? null); } catch { return null; }
};

const classify = (ok: boolean, text: string): string => {
  if (ok) {
    if (/HEADS-UP: every other villain/.test(text)) return "planned: heads-up after folds";
    if (/DEAD-MONEY COLLAPSE/.test(text)) return "planned: dead-money (flop)";
    if (/RE-ROOTED AT THE/.test(text)) return /dead:/.test(text) ? "planned: re-rooted + dead-money" : "planned: re-rooted";
    if (/folded — the \d seats still in are the tree/.test(text)) return "planned: exact after folds";
    if (/-WAY APPROXIMATION/.test(text)) return "planned: ghost/merge collapse";
    if (/3-way flop/.test(text)) return "planned: 3-way exact";
    return "planned: heads-up / other";
  }
  if (/narrowing walk .*coverage: no network/.test(text)) return "planned: re-root (narrowing walks need the cloud)";
  if (/coverage: no network/.test(text)) return "blocked before planning (needs the cloud: arrival / preflop)";
  return "REFUSED";
};

const out: any[] = [];
const t0 = Date.now();
let lastHand = "", hand: any = null, raw: any = null;
for (const r of rows) {
  if (r.client_hand_id !== lastHand) {
    lastHand = r.client_hand_id;
    const row = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1").get(r.client_hand_id) as { data: string } | null;
    hand = null;
    if (row) {
      try {
        raw = JSON.parse(row.data); hand = normalizeHand(raw).hand;
        const pos = (a: any) => String(hand.positions?.[a.hero ? hand.heroSeatId : a.seatId] ?? "").toUpperCase();
        const pre = hand.actions.filter((a: any) => a.street === "preflop");
        const folded = new Set(pre.filter((a: any) => a.type === "fold").map(pos));
        flopSeatsOf.set(r.client_hand_id, Object.values(hand.positions ?? {}).map((p: any) => String(p).toUpperCase()).filter((p) => !folded.has(p)));
      } catch { hand = null; }
    }
  }
  const base = { answer: r.id, hand: r.client_hand_id, street: r.street, livePick: r.pick };
  if (!hand) { out.push({ ...base, cls: "skipped: hand not archived" }); continue; }
  const n = Number(JSON.parse(r.decision_key)[4]);
  if (!Number.isFinite(n) || n > hand.actions.length) { out.push({ ...base, cls: "skipped: key past the archived line" }); continue; }
  const cut = withStartStacks(truncateAt(hand, n));
  const heroPos = hand.positions?.[hand.heroSeatId] ?? null;
  const strategyId = strategyFor(r.session_id ?? raw?.sessionId ?? null);
  let res: any;
  try {
    res = await FS.fastSolve({ ...cut, currentNode: { ...cut.currentNode, toActIsHero: true } }, heroPos,
      { heroPos, origin: "replay", ...(strategyId ? { strategyId } : {}) });
  } catch (e) { res = { ok: false, reason: `THREW: ${(e as Error)?.message ?? e}` }; }
  const text = String(res?.ok ? res.warning ?? "" : res?.reason ?? "");
  const cls = classify(!!res?.ok, text);
  out.push({ ...base, cls, why: cls.startsWith("planned") ? undefined : text.slice(0, 500),
    seats: res?.dryRun?.flopSeats?.length, trees: res?.dryRun?.trees?.map((t: any) => t.kind) });
}
const counts: Record<string, number> = {};
for (const x of out) counts[x.cls] = (counts[x.cls] ?? 0) + 1;
console.log(`${out.length} postflop decisions since ${arg("since") ?? "2026-09-27"} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
for (const x of out.filter((y) => y.cls === "REFUSED")) console.log(`REFUSED ${x.hand} ${x.street} (#${x.answer}, live ${x.livePick ?? "-"}): ${x.why}`);
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
process.exit(0);
