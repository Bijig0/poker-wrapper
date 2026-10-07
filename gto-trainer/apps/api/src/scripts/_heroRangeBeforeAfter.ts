/**
 * HERO'S FLOP RANGE BEFORE / AFTER hero-range-as-answered (2026-10-07), OFFLINE, 0 GTO Wizard requests.
 *
 *   bun src/scripts/_heroRangeBeforeAfter.ts [--since 2026-09-27] [--work <dir>] [--reuse-copy] [--out <file.md>]
 *
 * Every LIVE hand (a session's) whose postflop answers entered the flop through the GTO Wizard AI tree's per-seat line
 * fit ("GTO Wizard AI preflop tree. LINE FITTED FOR THE RANGES") since --since: the hand cut at its first postflop
 * decision, gtowAiPreflop.arrivalRangesGtowAi run with HERO_RANGE_AS_ANSWERED=off (the rule before) and on, hero's range
 * compared — combos, the summed per-combo change, the biggest movers by combos — and the "before" checked against the
 * hero range the live flop solve actually used (the stored solve's trace). Nothing live is touched: poker.sqlite and
 * the solve cache are copied (VACUUM INTO) to --work and every fetch but the local chart server is refused, so a node
 * the cache does not hold is counted, never asked for (the hand is then reported as "not in the cache").
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const SINCE = arg("since") ?? "2026-09-27";
const LIVE_DIR = (arg("data") ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/");
const WORK = (arg("work") ?? join(tmpdir(), "hero-range-before-after")).replace(/\\/g, "/");
const OUT = arg("out");

{
  const d = new Database(join(LIVE_DIR, "poker.sqlite"), { readonly: true });
  const s = (d.query("select id from sessions where ended_at is null limit 1").get() as { id: string } | null)?.id;
  d.close();
  if (s) { console.error(`a poker session is LIVE (${s}) — not running`); process.exit(2); }
}
mkdirSync(WORK, { recursive: true });
for (const name of ["poker.sqlite", "gtow-cache.sqlite"]) {
  const to = join(WORK, name);
  if (argv.includes("--reuse-copy") && existsSync(to)) continue;
  const tmp = `${to}.copying`;
  for (const p of [to, tmp]) rmSync(p, { force: true });
  const src = new Database(join(LIVE_DIR, name), { readonly: true });
  try { src.run(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { src.close(); }
  renameSync(tmp, to);
}
const ENV_FILE = "C:/Users/Brady/poker-wrapper/config/local.env";
if (existsSync(ENV_FILE)) for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
}
Object.assign(process.env, {
  POKER_DATA_DIR: WORK, GTOW_CACHE_DB_PATH: join(WORK, "gtow-cache.sqlite"), HAND_FACTS_DB_PATH: join(WORK, "poker.sqlite"),
  GTOW_REQUEST_ORIGIN: "hero-range-before-after", GTOW_PREFETCH: "0",
});
delete process.env.GTOW_BLOCK;
let blocked = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (/^https?:\/\/(localhost|127\.0\.0\.1):8777\//.test(url)) return realFetch(input, init);
  blocked++;
  return new Response(JSON.stringify({ detail: "offline: no network" }), { status: 503 });
}) as typeof fetch;

const P = await import("../services/gtowAiPreflop");
const { normalizeHand } = await import("../feed/normalizeHand/normalizeHand");
const { truncateAt, withStartStacks, dealtBySeat } = await import("../utils/archivedHand/archivedHand");
const { handFacts } = await import("../services/handFacts");
const { gtowSessions } = await import("../services/gtowSessions");
const { gtowApi } = await import("../services/gtowApi");
const { COMBOS } = await import("../utils/comboIndex/comboIndex");
(gtowSessions as any).tokenFor = async () => "offline-no-token";
(gtowApi as any).accessToken = async () => "offline-no-token";

const db = new Database(join(WORK, "poker.sqlite"), { readonly: true });
type Row = { id: number; client_hand_id: string; street: string; decision_key: string; solve_id: number | null; session_id: string; hero_cards: string | null; hero_pos: string | null; pick: string | null };
const rows = db.query(`select id, client_hand_id, street, decision_key, solve_id, session_id, hero_cards, hero_pos, pick from answers
  where session_id is not null and street in ('flop','turn','river') and ts >= ? and warning like '%GTO Wizard AI preflop tree. LINE FITTED FOR THE RANGES%' order by ts`).all(Date.parse(SINCE)) as Row[];
const byHand = new Map<string, Row[]>();
for (const r of rows) (byHand.get(r.client_hand_id) ?? byHand.set(r.client_hand_id, []).get(r.client_hand_id)!).push(r);
const nOf = (r: Row) => { try { return Number(JSON.parse(r.decision_key)[4]); } catch { return NaN; } };
const traceOf = (id: number) => {
  const r = db.query("select trace from solves where id = ?").get(id) as { trace: Uint8Array } | null;
  try { return r?.trace ? JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(r.trace))).toString("utf-8")) : null; } catch { return null; }
};
const N = (c: string) => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const combos = (r: Record<string, number>) => Object.entries(r).reduce((s, [c, w]) => s + w * N(c), 0);
const diffOf = (a: Record<string, number>, b: Record<string, number>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const movers = [...keys].map((c) => ({ c, from: a[c] ?? 0, to: b[c] ?? 0, d: ((b[c] ?? 0) - (a[c] ?? 0)) * N(c) })).filter((m) => Math.abs(m.d) > 1e-6);
  return { moved: movers.reduce((s, m) => s + Math.abs(m.d), 0), movers: movers.sort((x, y) => Math.abs(y.d) - Math.abs(x.d)) };
};
/** the hero range the live flop solve used: the stored trace's range for hero's seat, as class weights */
const liveHeroRange = (rs: Row[], heroPos: string): Record<string, number> | null => {
  for (const r of rs) {
    if (!r.solve_id) continue;
    const sp = traceOf(r.solve_id)?.spec;
    if (!sp || sp.firstStreet) continue;
    for (const [pos, arr] of [[sp.oopPos, sp.oopRange], [sp.midPos, sp.midRange], [sp.ipPos, sp.ipRange]] as [string, number[]][]) {
      if (String(pos ?? "").toUpperCase() !== heroPos.toUpperCase() || !Array.isArray(arr) || arr.length !== 1326) continue;
      const w: Record<string, number> = {};
      arr.forEach((x, i) => { const c = COMBOS[i]!.cls; if (x > (w[c] ?? 0)) w[c] = x; });
      for (const k of Object.keys(w)) if (!(w[k]! > 0)) delete w[k];
      return w;
    }
  }
  return null;
};

type Res = { hand: string; session: string; cards: string; heroPos: string; decisions: number; streets: string;
  status: string; before?: number; after?: number; moved?: number; movers?: string; note?: string; liveVsBefore?: number | null; blocked?: number };
const out: Res[] = [];
for (const [h, rs] of byHand) {
  const row = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1").get(h) as { data: string } | null;
  const first = rs.slice().sort((a, b) => nOf(a) - nOf(b))[0]!;
  const base: Res = { hand: h, session: first.session_id, cards: first.hero_cards ?? "?", heroPos: first.hero_pos ?? "?", decisions: rs.length,
    streets: [...new Set(rs.map((r) => r.street))].join("/"), status: "" };
  if (!row) { out.push({ ...base, status: "hand not archived" }); continue; }
  const raw = JSON.parse(row.data);
  const hand = normalizeHand(raw).hand as any;
  const heroPos = hand.positions?.[hand.heroSeatId] ?? null;
  const cut = withStartStacks(truncateAt(hand, nOf(first)));
  // the stacks the live flop pinned (handFacts, as fastSolve.pinPostflop kept them), else as dealt
  const dealt = handFacts.dealt(String(cut.clientHandId ?? cut.handId ?? h))?.dealt ?? dealtBySeat(cut);
  const run = async (sw: "on" | "off") => {
    process.env.HERO_RANGE_AS_ANSWERED = sw;
    blocked = 0;
    const r = await P.arrivalRangesGtowAi(cut, heroPos, 6, dealt);
    return { r, blocked };
  };
  const off = await run("off");
  const on = await run("on");
  if (!off.r.ok || !on.r.ok) { out.push({ ...base, status: `arrival refused: ${!off.r.ok ? off.r.reason : (on.r as any).reason}`.slice(0, 200), blocked: off.blocked + on.blocked }); continue; }
  const key = Object.keys(off.r.ranges).find((p) => p.toUpperCase() === String(heroPos ?? "").toUpperCase());
  if (!key) { out.push({ ...base, status: "hero not among the flop seats" }); continue; }
  const a = off.r.ranges[key]!, b = on.r.ranges[key]!;
  const d = diffOf(a, b);
  const live = liveHeroRange(rs, key);
  const liveVsBefore = live ? diffOf(live, a).moved : null;
  const note = (on.r.note ?? "").match(/HERO'S OWN RANGE IS THE ANSWER'S: .*?combos\)\.|Hero's own range is read on one fit like the others: .*?\.(?= |$)/)?.[0] ?? "";
  out.push({ ...base, status: off.r.fitted ? (d.moved > 1e-6 ? "changed" : "same") : "not a fitted read now", before: combos(a), after: combos(b), moved: d.moved,
    movers: d.movers.slice(0, 6).map((m) => `${m.c} ${m.from.toFixed(2)}→${m.to.toFixed(2)}`).join(", "), note, liveVsBefore, blocked: on.blocked });
}

const changed = out.filter((r) => r.status === "changed");
const lines: string[] = [];
lines.push(`# Hero's flop range before / after hero-range-as-answered (offline, 0 GTO Wizard requests)`, "");
lines.push(`Generated ${new Date().toISOString()} by gto-trainer/apps/api/src/scripts/_heroRangeBeforeAfter.ts (branch claude/hero-range-as-answered). Live postflop answers since ${SINCE} that entered the flop through the GTO Wizard AI tree's per-seat line fit: ${rows.length} answers in ${byHand.size} hands. Each hand cut at its first postflop decision; arrivalRangesGtowAi run with HERO_RANGE_AS_ANSWERED=off and on, on copies of poker.sqlite and the solve cache, every fetch refused.`, "");
const by = (s: string) => out.filter((r) => r.status === s).length;
const blendEra = (r: Res) => r.session.replace("session_", "") >= "20261004_170000";
lines.push(`- hero's range changed: **${changed.length}** hands (${changed.reduce((s, r) => s + r.decisions, 0)} postflop answers); of them answered live with the blended preflop (since 2026-10-04 17:00): ${changed.filter(blendEra).length} hand(s), ${changed.filter(blendEra).reduce((s, r) => s + r.decisions, 0)} answer(s) — of ${out.filter(blendEra).length} hand(s) in that era`);
lines.push(`- unchanged: ${by("same")} · arrival refused offline (a node the cache lacks, or a line no longer read by fit): ${out.filter((r) => /refused|not a fitted/.test(r.status)).length} · other: ${out.filter((r) => !["changed", "same"].includes(r.status) && !/refused|not a fitted/.test(r.status)).length}`);
if (changed.length) {
  const mv = changed.map((r) => r.moved!).sort((x, y) => x - y);
  lines.push(`- combos moved (sum of |Δ| over classes, in combos) among the changed: median ${mv[Math.floor(mv.length / 2)]!.toFixed(1)}, max ${mv.at(-1)!.toFixed(1)}, total ${mv.reduce((s, x) => s + x, 0).toFixed(1)}`);
  lines.push(`- hero's range size among the changed: ${changed.reduce((s, r) => s + r.before!, 0).toFixed(1)} → ${changed.reduce((s, r) => s + r.after!, 0).toFixed(1)} combos summed`);
}
const chk = out.filter((r) => r.liveVsBefore != null);
lines.push(`- sanity: the "before" against the hero range the live flop solve used (stored trace): ${chk.filter((r) => r.liveVsBefore! < 0.5).length} of ${chk.length} within 0.5 combos (the rest: the live preflop/arrival code differed then — e.g. before 2026-10-04 17:00 — or the live range was floored/overlaid)`);
lines.push(`- fetches refused during the 'on' reads: ${out.reduce((s, r) => s + (r.blocked ?? 0), 0)}`, "");
lines.push(`"live preflop": the answer hero was given live — "blend" from 2026-10-04 17:00 (main 01e97bb), "dead-money" before it (the old fit: the folded caller's chips as dead money in the pot); both columns of ranges here are TODAY's code on the same line.`, "");
lines.push(`| hand | session | live preflop | hero | answers | status | combos before → after | moved | biggest movers | before vs live |`, `|---|---|---|---|---|---|---|---|---|---|`);
const era = (sess: string) => (sess.replace("session_", "") >= "20261004_170000" ? "blend" : "dead-money");
for (const r of out) lines.push(`| ${r.hand} | ${r.session.replace("session_", "")} | ${era(r.session)} | ${r.heroPos} ${r.cards} | ${r.decisions} (${r.streets}) | ${r.status} | ${r.before != null ? `${r.before.toFixed(1)} → ${r.after!.toFixed(1)}` : "—"} | ${r.moved != null ? r.moved.toFixed(1) : "—"} | ${r.movers ?? ""} | ${r.liveVsBefore != null ? r.liveVsBefore.toFixed(1) : "—"} |`);
lines.push("", "Notes per changed hand:", "");
for (const r of changed) lines.push(`- ${r.hand}: ${r.note}`);
for (const r of out.filter((x) => /one fit like the others/.test(x.note ?? ""))) lines.push(`- ${r.hand} (kept): ${r.note}`);
const text = lines.join("\n");
console.log(text);
if (OUT) writeFileSync(OUT, text + "\n");
writeFileSync(join(WORK, "hero-range-before-after.json"), JSON.stringify(out, null, 1));
process.exit(0);
