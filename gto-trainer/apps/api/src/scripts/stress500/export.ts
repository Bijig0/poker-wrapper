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
import { LINT_FLAGS, lintHand } from "./lint";
import { APPROXIMATIONS, departuresOf } from "../../services/approximations";

/**
 * THE DEPARTURES FROM BASE GTO (2026-10-05, services/approximations): per decision, the register entries its path codes
 * and warning resolve to (id, kind, badge); per hand, the seats a pool overlay replaced — a preflop lock from the locked
 * seat's own action on, a flop floor from the flop on — with the unlocked tree's share of his action where the answer's
 * note names it. The replayer labels those seats "POOL RANGE — <badge>" and every other seat "GTO range".
 */
const codesOfPath = (p: any): string[] => [...(p?.reasons ?? []).map((r: any) => r?.code), p?.arrival?.code, p?.arrival?.first?.code].filter(Boolean);
const badgeOf = (id: string) => APPROXIMATIONS.find((a) => a.id === id)?.badge ?? id;
function poolSeatsOf(h: any): { p: string; id: string; b: string; how: "lock" | "floor"; at: number; gto: number | null }[] {
  const out: { p: string; id: string; b: string; how: "lock" | "floor"; at: number; gto: number | null }[] = [];
  const acts: any[] = h.hand?.actions ?? [];
  const posOf = (a: any) => String(h.hand?.positions?.[a.seatId] ?? "").toUpperCase();
  const firstPost = acts.findIndex((a) => a.street !== "preflop");
  for (const d of h.decisions ?? []) {
    const codes = new Set(codesOfPath(d.path));
    const w = String(d.warning ?? "");
    const lock = codes.has("preflop:pool-coldcall-lock") ? "pool-coldcall-lock" : codes.has("preflop:pool-limp-lock") ? "pool-limp-lock" : null;
    if (lock) {
      const m = /POOL-LOCKED (?:LIMPER|COLD-CALL): the (UTG|HJ|CO|BTN|SB|BB) \(/.exec(w);
      const g = /which the exact tree gives ([\d.]+)% of his range/.exec(w);
      if (m && !out.some((x) => x.p === m[1] && x.how === "lock")) {
        const at = acts.findIndex((a) => a.street === "preflop" && a.type === "call" && posOf(a) === m[1]);
        out.push({ p: m[1]!, id: lock, b: badgeOf(lock), how: "lock", at: at >= 0 ? at : (d.index ?? 0), gto: g ? Number(g[1]) : null });
      }
    }
    for (const [code, id] of [["arrival:pool-limp-floor", "pool-limp-floor"], ["arrival:pool-coldcall-floor", "pool-coldcall-floor"]] as const) {
      if (!codes.has(code)) continue;
      const text = [d.path?.arrival?.why, d.path?.arrival?.first?.why, w].filter(Boolean).join(" ");
      for (const m of text.matchAll(/POOL (?:LIMP|COLD-CALL) RANGE: the (UTG|HJ|CO|BTN|SB|BB) \(|; the (UTG|HJ|CO|BTN|SB|BB) \(\d+bb\) (?:limped|cold-called)/g)) {
        const p = (m[1] ?? m[2])!;
        if (!out.some((x) => x.p === p)) out.push({ p, id, b: badgeOf(id), how: "floor", at: firstPost >= 0 ? firstPost : (d.index ?? 0), gto: null });
      }
    }
  }
  return out;
}

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

/**
 * THE FIXES, AS THE HAND-4587 SESSION DEFINES "FIXED" (its review, 2026-10-05): each fix, the spots meant to exercise
 * it (families / real hands / titles), and — where the answer leaves a mark — the decisions it fired in. `must: never`
 * = a fault whenever it fires.
 */
interface FixDef { id: string; name: string; commit?: string; means: string; families?: string[]; hands?: string[]; titles?: RegExp; sig?: (d: any) => boolean; must?: "never" }
const MULTI = ["po_3way", "po_4way", "po_56way", "brief_A", "brief_B", "brief_C", "brief_D", "brief_E", "brief_F", "brief_G", "brief_H", "brief_I"];
const FIXES: FixDef[] = [
  { id: "no-hu-last-resort", name: "No heads-up last resort postflop", commit: "e1ce914", must: "never", families: MULTI,
    means: "a 4+ way street no collapse reduces to three seats gets NO answer — never the old heads-up last resort (hand 4587's 88 jam); any last-resort answer is a fault",
    sig: (d) => d.fl.includes("last-resort") },
  { id: "dead-money", name: "Dead-money collapse", families: ["brief_A", "po_4way", "po_56way"],
    hands: ["real-4922578344", "real-4922304060", "real-4922372980", "real-4922084873", "real-4922305100"],
    means: "two or more villains with chips in on the flop: the dropped seats' chips stay in the pot as dead money, every kept seat has exactly its own chips on the street",
    sig: (d) => /DEAD-MONEY COLLAPSE/i.test(d.w ?? "") || d.tags.some((t: string) => /dead:/.test(t)) },
  { id: "takeover", name: "Takeover", families: ["brief_B", "brief_A"],
    means: "a kept caller of a dropped wager bets it in the tree, so hero's price is exact (SB bets 4, BB folds, HJ calls, CO raises 14, SB folds → hero faces 10)" },
  { id: "street-cut", name: "Mid-street cut", families: ["brief_C"], titles: /turn cut|river cut|double reopen|reopened/,
    means: "a reopened round the tree cannot hold is cut (plan kind \"(street cut)\") — on the flop, and on the turn and river (brief_I)",
    sig: (d) => d.tags.some((t: string) => /street cut/.test(t)) },
  { id: "hu-after-folds", name: "Heads-up after folds", families: ["brief_B", "po_4way", "po_56way"],
    means: "every other villain has folded: the tree is hero against the one left, the folded seats' chips on the street in the pot",
    sig: (d) => (d.k ?? []).includes("HU after folds") || d.tags.some((t: string) => /^heads-up/.test(t)) },
  { id: "fold-first", name: "Fold-first", families: ["po_4way", "po_56way"],
    hands: ["real-4922296909", "real-4922313196", "real-4922314653", "real-4922369309", "real-4922298483"],
    means: "a seat that folds is never merged and never a live opponent (plan kind fold:X)",
    sig: (d) => d.tags.some((t: string) => /fold:/.test(t)) },
  { id: "merge-fold", name: "Merged member folds later", families: ["brief_F", "brief_H"], hands: ["real-4922575177"],
    means: "a merged seat whose member folds on a later street (with fold-first most of these now plan fold:X instead)",
    sig: (d) => d.tags.some((t: string) => /merge/.test(t)) },
  { id: "reroot", name: "Re-root, three seats or fewer left", families: ["po_4way", "po_56way", "brief_B"],
    means: "a turn or river with three or fewer seats left after flop commitments is re-rooted exactly (two seats included)",
    sig: (d) => (d.k ?? []).includes("re-rooted") },
  { id: "takeover-narrowing", name: "Takeover narrowing / partial cover", families: ["brief_E"], hands: ["real-4921735317", "real-4922305100"],
    means: "a turn whose flop had more aggressors than one three-seat walk holds is narrowed by takeover groups; a seat none holds enters with its arrival range (\"NOT NARROWED\" — never seen in 600k fuzz spots)",
    sig: (d) => /NOT NARROWED/.test(d.w ?? "") },
  { id: "rai-call", name: "All-in call for less (RAI) after a cut", titles: /written as RAI/,
    means: "a short all-in call written as RAI is read as a call" },
  { id: "reroot-legacy-walk", name: "Re-root walk the tree cannot play", commit: "fe31bf2", titles: /SB X, BB bets 1\.75/,
    means: "a narrowing walk the tree cannot play (flop jammers sitting out) goes to the takeover narrowing — brief_D-001's turn and river had no answer on b1d53b1" },
];

const scen = JSON.parse(readFileSync(join(DATA, "scenarios.json"), "utf8")).scenarios as any[];
const order = new Map(scen.map((s, i) => [s.id, i]));
const clientIdOf = new Map(scen.map((s) => [s.id, String(s.raw?.clientHandId ?? `stress-s5-${s.id}`)]));
// the postflop views are rebuilt from the run's own stored chain traces (its private data root), so a fix to views.ts
// reaches the hands already run
const ROOT_DB = join(DATA, "root", "poker.sqlite");
const rootDb = existsSync(ROOT_DB) ? new Database(ROOT_DB, { readonly: true }) : null;
const tracesOf = (clientHandId: string, since = 0): { id: number; decisionIndex: number | null; trace: any }[] => {
  if (!rootDb) return [];
  // `since` = the hand's own attempt (startedAt): a hand played again leaves the earlier attempts' rows in the store
  const rows = rootDb.query("select id, decision_key, trace from solves where client_hand_id = ? and ts >= ? order by ts").all(clientHandId, since) as { id: number; decision_key: string | null; trace: Uint8Array }[];
  const decisionIndexOf = (key: string | null): number | null => { try { const k = JSON.parse(key ?? "null"); const i = Array.isArray(k) ? Number(k[k.length - 1]) : NaN; return Number.isFinite(i) ? i : null; } catch { return null; } };
  return rows.flatMap((r) => { try { return [{ id: r.id, decisionIndex: decisionIndexOf(r.decision_key), trace: JSON.parse(Buffer.from(Bun.gunzipSync(r.trace as Uint8Array<ArrayBuffer>)).toString("utf-8")) }]; } catch { return []; } });
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
const totals = { hands: 0, decisions: 0, ok: 0, approx: 0, refused: 0, bad: 0, reqs: 0, ms: 0, flags: {} as Record<string, number>, kinds: {} as Record<string, number>,
  // the poker-sense checks (lint.ts): decisions and hands per flag, every flag listed (0 = checked, none found)
  lint: Object.fromEntries(LINT_FLAGS.map((f) => [f, { n: 0, hands: 0 }])) as Record<string, { n: number; hands: number }> };
const zero = (): Record<string, number> => ({ ok: 0, approx: 0, refused: 0, bad: 0, pre: 0 });
/** a refusal before any postflop fix could act: no flop ranges (the preflop side), a capture fault, a phantom ask */
const refusedBefore = (d: any): boolean => !d.ok && (d.fl ?? []).some((f: string) => /^(arrival|hero-off-chart|limped-pot|capture-fault|not-hero-turn)$/.test(f));
const fixGrade = (d: any): string => (refusedBefore(d) ? "pre" : d.g);
const fixAcc = FIXES.map((f) => ({ f, target: new Set<string>(), tg: zero(), fired: new Set<string>(), fg: zero(), firedN: 0 }));
for (const h of hands) {
  const dec = (h.decisions ?? []).map((d: any) => ({
    i: d.index, st: d.street, pick: d.pick, roll: d.roll ?? null, band: d.band ?? null, mix: (d.actions ?? []).map((a: any) => [a.action, Math.round(Number(a.frequency) * 100) / 100]),
    src: d.source, tier: d.tier, chart: d.gametype, line: d.line, pv: d.path?.verdict ?? null,
    pcodes: (d.path?.reasons ?? []).map((r: any) => r.code).filter(Boolean),
    dep: departuresOf(codesOfPath(d.path), d.warning ?? null).map((a) => [a.id, a.kind, a.badge]),
    req: d.path?.requests ?? null, g: d.grade, fl: d.flags ?? [], k: d.kinds ?? [], w: d.warning, why: d.reason, ms: d.ms, n: d.reqs, mp: d.misPress,
    cf: Object.entries(d.path?.checks ?? {}).flatMap(([st, cs]: [string, any]) => (cs ?? []).filter((c: any) => c.status === "fail" || c.status === "flag").map((c: any) => ({ st, id: c.id, s: c.status, t: String(c.text ?? "").slice(0, 400) }))),
    ok: !!d.ok, toCall: d.toCall, pos: d.pos, kind: d.kind, tk: d.took ? [d.took.type, d.took.amount ?? null] : null,
  })).map((x: any) => { const gr = gradeDecision({ ...x, reason: x.why, kinds: x.k, hero: h.hero }); return { ...x, g: gr.g, fl: gr.fl }; });
  const views: Record<string, any> = {};
  const traces = tracesOf(clientIdOf.get(h.id) ?? `stress-s5-${h.id}`, h.startedAt ? Date.parse(h.startedAt) : 0);
  // every decision's plan kinds (the trees its answer solved: ghost:/dead:/fold:/merge:/heads-up/(street cut))
  for (const d of dec) d.tags = [...new Set(traces.filter((t) => t.decisionIndex === d.i).map((t) => String(t.trace?.spec?.planTag ?? "")).filter(Boolean))];
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
  // POKER-SENSE CHECKS (lint.ts): flags only — the grade stays what the answer path earned
  const lint = lintHand(h.hand, h.decisions ?? [], allViews, allAlts);
  for (const d of dec) {
    const lf = lint.flags.get(d.i);
    if (lf?.length) { d.fl = [...d.fl, ...lf]; d.lint = lint.notes.get(d.i); }
    const pl = lint.plans.get(d.i);
    if (pl) d.pl = pl.map((x) => [x.src, x.mix.map(([a, p]) => [a, Math.round(p * 10) / 10]), x.kind]);
  }
  for (const f of LINT_FLAGS) {
    const n = dec.filter((d: any) => d.fl.includes(f)).length;
    if (n) { totals.lint[f]!.n += n; totals.lint[f]!.hands++; }
  }
  for (const [i, v] of Object.entries(allViews) as [string, any][]) views[i] = encView(v);
  const alt: Record<string, any[]> = {};
  for (const [i, vs] of Object.entries(allAlts) as [string, any[]][]) alt[i] = vs.map(encView);
  // REVIEW-ONLY REPLIES (replies.ts): GTO Wizard's nodes for the villains after hero's LAST action on a street, read for
  // the harness only — the live path never reads them (hero has no further decision). Kept apart from `views` (no grade,
  // no lint, no thin-range count reads them); the replayer draws them under a REVIEW ONLY banner.
  const rep: Record<string, any> = {};
  for (const [i, v] of Object.entries(h.replies ?? {}) as [string, any][]) {
    rep[i] = { ...encView(v), rv: 1, sn: v.snapped ?? null, rq: v.requests ?? null, nt: v.note ?? null, bn: v.banner ?? null };
  }
  const out = {
    id: h.id, fam: h.family, title: h.title, tags: h.tags, hero: h.hero, src: h.source, hh: h.hh,
    hand: { pos: h.hand.positions, ss: h.hand.startStacks, hs: h.hand.heroSeatId, hc: h.hand.heroCards, b: h.hand.board,
            ac: h.hand.actions.map((a: any) => [a.seatId, a.type, a.amount ?? null, a.street[0], a.hero ? 1 : 0]) },
    dec, views, alt, rep, pn: h.preflopNote, pool: poolSeatsOf(h), plans: (h.plans ?? []).map((p: any) => [p.solveId, p.street, p.planTag, p.ok ? 1 : 0]), ms: h.ms, at: h.ranAt, commit: h.commit,
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
  // the fixes: the spots meant to exercise each (their postflop decisions) and the decisions its mark shows in
  for (const a of fixAcc) {
    const f = a.f;
    if ((f.families ?? []).includes(h.family) || (f.hands ?? []).includes(h.id) || (f.titles ? f.titles.test(String(h.title ?? "")) : false)) {
      a.target.add(h.id);
      for (const d of dec) if (d.st !== "preflop") a.tg[fixGrade(d)] = (a.tg[fixGrade(d)] ?? 0) + 1;
    }
    if (f.sig) for (const d of dec) if (f.sig(d)) { a.firedN++; a.fired.add(h.id); a.fg[fixGrade(d)] = (a.fg[fixGrade(d)] ?? 0) + 1; }
  }
  index.push({
    id: h.id, fam: h.family, title: h.title, tags: h.tags, hero: h.hero, hc: h.hand.heroCards, b: h.hand.board,
    g: dec.map((d: any) => d.g[0]).join(""), grades, fl: [...fl], k: [...kd], ms: h.ms, n: (h.decisions ?? []).reduce((t: number, d: any) => t + (d.reqs ?? 0), 0),
    f: `b${String(bn).padStart(3, "0")}.json`, real: h.source?.clientHandId ?? null, c: h.commit ?? null,
  });
  batch.push(out);
  if (batch.length >= BATCH) flush();
}
flush();
// the replayer page beside its data (publish <out>/stress500.html)
writeFileSync(join(OUT, "stress500.html"), readFileSync(join(import.meta.dir, "replayer.html")));
const planned = scen.length;
const fixes = fixAcc.map((a) => ({
  id: a.f.id, name: a.f.name, commit: a.f.commit ?? null, means: a.f.means, must: a.f.must ?? null,
  target: { hands: [...a.target], ...a.tg }, fired: a.f.sig ? { n: a.firedN, hands: [...a.fired], ...a.fg } : null,
}));
const byRun = hands.slice().sort((a, b) => String(a.ranAt ?? "").localeCompare(String(b.ranAt ?? "")));
const commits = [...new Set(byRun.map((h) => h.commit).filter(Boolean))].map((c) => ({ c, n: hands.filter((h) => h.commit === c).length }));
writeFileSync(join(OUT, "data", "index.json"), JSON.stringify({ builtAt: new Date().toISOString(), planned, commit: byRun[byRun.length - 1]?.commit ?? null, commits, totals, about: ABOUT, fixes, hands: index }));
console.log(`exported ${hands.length}/${planned} hands in ${bn} batches → ${join(OUT, "data")}`);
console.log(JSON.stringify({ ...totals, flags: undefined, kinds: undefined, lint: undefined }));
console.log("poker-sense checks:", LINT_FLAGS.map((f) => `${f} ${totals.lint[f]!.n} (${totals.lint[f]!.hands} hands)`).join(" · "));
