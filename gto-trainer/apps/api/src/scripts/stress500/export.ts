/**
 * Export the stress-500 results for the replayer artifact: an index (one row per hand, the grades and flags, the run's
 * totals) and the hands in batches, every 169-value range / strategy packed as 2 base64 characters per value (0..4095).
 *
 *   bun src/scripts/stress500/export.ts [--data C:/Users/Brady/poker-data-stress500] --out <artifact dir>
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAMILIES } from "./scenarios";
import { gradeDecision } from "./grade";
import { CLASSES, postflopViewsByDecision } from "./views";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const DATA = arg("data") ?? "C:/Users/Brady/poker-data-stress500";
const OUT = arg("out");
if (!OUT) { console.error("--out <artifact dir> is required"); process.exit(64); }
const BATCH = Number(arg("batch") ?? 12);
mkdirSync(join(OUT, "data"), { recursive: true });

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const enc = (xs: number[] | null | undefined): string | null => {
  if (!xs) return null;
  let s = "";
  for (const x of xs) { const q = Math.max(0, Math.min(4095, Math.round(Number(x ?? 0) * 4095))); s += B64[q >> 6]! + B64[q & 63]!; }
  return s;
};
/** combos per class in the grid's order (pairs 6, suited 4, offsuit 12) */
const CLASS_SIZES: number[] = CLASSES.map((c) => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12));
const ABOUT: Record<string, string> = Object.fromEntries(FAMILIES.map((f) => [f.family, f.about]));
ABOUT.real = "real hands from the archive the hand-4587 session and this session named (multiway fixes, phantom asks, capture faults, short limpers, post-ins)";

const scen = JSON.parse(readFileSync(join(DATA, "scenarios.json"), "utf8")).scenarios as any[];
const order = new Map(scen.map((s, i) => [s.id, i]));
const clientIdOf = new Map(scen.map((s) => [s.id, String(s.raw?.clientHandId ?? `stress-s5-${s.id}`)]));
// the postflop views are rebuilt from the run's own stored chain traces (its private data root), so a fix to views.ts
// reaches the hands already run
const ROOT_DB = join(DATA, "root", "poker.sqlite");
const rootDb = existsSync(ROOT_DB) ? new Database(ROOT_DB, { readonly: true }) : null;
const tracesOf = (clientHandId: string): { id: number; decisionIndex: number | null; trace: any }[] => {
  if (!rootDb) return [];
  const rows = rootDb.query("select id, decision_key, trace from solves where client_hand_id = ? order by ts").all(clientHandId) as { id: number; decision_key: string | null; trace: Uint8Array }[];
  const decisionIndexOf = (key: string | null): number | null => { try { const k = JSON.parse(key ?? "null"); const i = Array.isArray(k) ? Number(k[k.length - 1]) : NaN; return Number.isFinite(i) ? i : null; } catch { return null; } };
  return rows.flatMap((r) => { try { return [{ id: r.id, decisionIndex: decisionIndexOf(r.decision_key), trace: JSON.parse(Buffer.from(Bun.gunzipSync(r.trace)).toString("utf-8")) }]; } catch { return []; } });
};
const encView = (v: any): any => ({
  a: v.actor, ln: v.line, acts: v.actions, st: (v.strat ?? null)?.map((col: number[]) => enc(col)) ?? null, tot: v.totals, tk: v.taken,
  r: Object.fromEntries(Object.entries(v.ranges ?? {}).map(([p, xs]) => [p, enc(xs as number[] | null)])), src: v.src, pot: v.pot ?? null, hm: v.heroMix ?? null,
});
const files = existsSync(join(DATA, "hands")) ? readdirSync(join(DATA, "hands")).filter((f) => f.endsWith(".json")) : [];
const hands = files.map((f) => JSON.parse(readFileSync(join(DATA, "hands", f), "utf8"))).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

const index: any[] = [];
let batch: any[] = [], bn = 0;
const flush = (): void => {
  if (!batch.length) return;
  const name = `b${String(bn).padStart(3, "0")}.json`;
  writeFileSync(join(OUT, "data", name), JSON.stringify(batch));
  bn++; batch = [];
};
const totals = { hands: 0, decisions: 0, ok: 0, approx: 0, refused: 0, bad: 0, reqs: 0, ms: 0, flags: {} as Record<string, number>, kinds: {} as Record<string, number> };
for (const h of hands) {
  const dec = (h.decisions ?? []).map((d: any) => ({
    i: d.index, st: d.street, pick: d.pick, mix: (d.actions ?? []).map((a: any) => [a.action, Math.round(Number(a.frequency) * 100) / 100]),
    src: d.source, tier: d.tier, chart: d.gametype, line: d.line, pv: d.path?.verdict ?? null,
    pcodes: (d.path?.reasons ?? []).map((r: any) => r.code).filter(Boolean),
    req: d.path?.requests ?? null, g: d.grade, fl: d.flags ?? [], k: d.kinds ?? [], w: d.warning, why: d.reason, ms: d.ms, n: d.reqs, mp: d.misPress,
    cf: Object.entries(d.path?.checks ?? {}).flatMap(([st, cs]: [string, any]) => (cs ?? []).filter((c: any) => c.status === "fail" || c.status === "flag").map((c: any) => ({ st, id: c.id, s: c.status, t: String(c.text ?? "").slice(0, 400) }))),
    ok: !!d.ok, toCall: d.toCall, pos: d.pos, kind: d.kind, tk: d.took ? [d.took.type, d.took.amount ?? null] : null,
  })).map((x: any) => { const gr = gradeDecision({ ...x, reason: x.why, kinds: x.k, hero: h.hero }); return { ...x, g: gr.g, fl: gr.fl }; });
  const views: Record<string, any> = {};
  const traces = tracesOf(clientIdOf.get(h.id) ?? `stress-s5-${h.id}`);
  const allViews: Record<string, any> = { ...(h.views ?? {}) };
  let allAlts: Record<string, any[]> = {};
  if (traces.length) {
    for (const [i] of Object.entries(allViews)) if (h.hand.actions[Number(i)]?.street !== "preflop") delete allViews[i];
    const by = postflopViewsByDecision(h.hand.actions, h.hand.positions, traces);
    Object.assign(allViews, by.views);
    allAlts = by.alts;
  }
  // THIN RANGES: a seat of hero's tree(s) holding under 1.5 combos at hero's node (a scripted action the solver almost
  // never takes collapses the range of whoever took it — the tree then answers on almost nothing)
  const combosOf = (xs: number[] | null | undefined): number | null => xs ? xs.reduce((t, x, k) => t + x * (CLASS_SIZES[k] ?? 0), 0) : null;
  for (const d of dec) {
    const vs = [allViews[String(d.i)], ...(allAlts[String(d.i)] ?? [])].filter(Boolean);
    if (!vs.length || !d.ok) continue;
    const least = new Map<string, number>();
    for (const v of vs) for (const [p, xs] of Object.entries(v.ranges ?? {})) {
      const n = combosOf(xs as number[] | null);
      if (n != null) least.set(p, Math.min(least.get(p) ?? Infinity, n));
    }
    const thin = [...least].filter(([, n]) => n < 1.5).map(([p, n]) => `${p} ${Math.round(n * 100) / 100}`);
    if (thin.length) {
      d.thin = thin;
      const heroThin = thin.some((t) => t.split(" ")[0]!.toUpperCase() === String(h.hero).toUpperCase());
      d.fl = [...d.fl, ...(heroThin ? ["thin-hero"] : []), ...(thin.length > (heroThin ? 1 : 0) ? ["thin-villain"] : [])];
      if (d.g === "ok") d.g = "approx";
    }
  }
  for (const [i, v] of Object.entries(allViews) as [string, any][]) views[i] = encView(v);
  const alt: Record<string, any[]> = {};
  for (const [i, vs] of Object.entries(allAlts) as [string, any[]][]) alt[i] = vs.map(encView);
  const out = {
    id: h.id, fam: h.family, title: h.title, tags: h.tags, hero: h.hero, src: h.source, hh: h.hh,
    hand: { pos: h.hand.positions, ss: h.hand.startStacks, hs: h.hand.heroSeatId, hc: h.hand.heroCards, b: h.hand.board,
            ac: h.hand.actions.map((a: any) => [a.seatId, a.type, a.amount ?? null, a.street[0], a.hero ? 1 : 0]) },
    dec, views, alt, pn: h.preflopNote, plans: (h.plans ?? []).map((p: any) => [p.solveId, p.street, p.planTag, p.ok ? 1 : 0]), ms: h.ms, at: h.ranAt, commit: h.commit,
  };
  const grades = { ok: 0, approx: 0, refused: 0, bad: 0 } as Record<string, number>;
  const fl = new Set<string>(), kd = new Set<string>();
  for (const d of dec) {
    grades[d.g] = (grades[d.g] ?? 0) + 1;
    (totals as any)[d.g]++;
    for (const f of d.fl ?? []) { fl.add(f); totals.flags[f] = (totals.flags[f] ?? 0) + 1; }
    for (const k of d.k ?? []) { kd.add(k); totals.kinds[k] = (totals.kinds[k] ?? 0) + 1; }
    totals.reqs += d.n ?? 0;
  }
  totals.hands++; totals.decisions += (h.decisions ?? []).length; totals.ms += h.ms ?? 0;
  index.push({
    id: h.id, fam: h.family, title: h.title, tags: h.tags, hero: h.hero, hc: h.hand.heroCards, b: h.hand.board,
    g: dec.map((d: any) => d.g[0]).join(""), grades, fl: [...fl], k: [...kd], ms: h.ms, n: (h.decisions ?? []).reduce((t: number, d: any) => t + (d.reqs ?? 0), 0),
    f: `b${String(bn).padStart(3, "0")}.json`, real: h.source?.clientHandId ?? null,
  });
  batch.push(out);
  if (batch.length >= BATCH) flush();
}
flush();
const planned = scen.length;
writeFileSync(join(OUT, "data", "index.json"), JSON.stringify({ builtAt: new Date().toISOString(), planned, commit: hands[0]?.commit ?? null, totals, about: ABOUT, hands: index }));
console.log(`exported ${hands.length}/${planned} hands in ${bn} batches → ${join(OUT, "data")}`);
console.log(JSON.stringify({ ...totals, flags: undefined, kinds: undefined }));
