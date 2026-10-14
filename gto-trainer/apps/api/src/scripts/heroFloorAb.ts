/**
 * HERO'S CLASS FLOOR — THE A/B HARNESS (2026-10-14, Brady: "do some strong A/B testing first to figure out the best
 * approach and whether or not this floor is a good move or not"). Report: docs/2026-10-14-hero-floor-ab.md.
 *
 * Re-walks REAL decisions' postflop chains offline (services/aiChain.solveAiChain on each decision's stored spec, the
 * solves table's trace) under each HERO_CLASS_FLOOR mode — abs (the floor until 2026-10-14), rel5 (the default since),
 * rel1, none (aiChain.applyHeroClassFloor) —
 * and records, at hero's decision node, his combo's mix and per-action EVs, his live mass and class share entering each
 * street, and what each walk cost. GTO Wizard IS asked (through the account pool, every request in the live ledger under
 * origin `heroFloorAb`): a tree whose ranges the floor did not change is a cache hit (the copied solve cache, below) and
 * costs nothing; only the ranges a mode changes are solved again.
 *
 * A HAND IS WALKED DECISION BY DECISION, in order, under ONE hand key per (mode, hand): the turn and river resume from
 * the mode's own earlier streets (the floor compounds per street — that is part of what is measured), and hero's own
 * earlier actions are narrowed by the node the MODE answered them on (recordAnsweredHeroNode, as live). THE BLIND SPOT
 * of a fresh hand key — a live walk narrowed hero's earlier action by a strategy SERVED on another plan (heroAnswered
 * src "served"), which no walk of this one plan can produce — is covered by seeding: every trace node that carries a
 * `heroAnswered.strategy` (4 dp) is recorded under the walk's key BEFORE the decision is walked, unless the mode's own
 * earlier walk already answered that point. Under `abs` the walk must then REPRODUCE the live decision-street hero
 * range (mass and class share within rounding) and pick — the report says whether it did (`--report` compares).
 *
 *   . config/env.ps1  (POKER_DATA_DIR = the live records: the account registry and the request ledger)
 *   GTOW_CACHE_DB_PATH=<a COPY of gtow-cache.sqlite> GTOW_PREFETCH=0 bun src/scripts/heroFloorAb.ts \
 *       --sample <sample.json> --out <dir> [--modes abs,none,rel5] [--tiers t1,t2,t3] [--hands id,id] [--budget 1200]
 *       [--max-hands N] [--dry]
 *   bun src/scripts/heroFloorAb.ts --report <dir>            (the per-decision table, the aggregates, the request count)
 *
 * The sample (scratchpad hero/sample.py): { plan: [{ hand, tier, tagged: [answer ids], decisions: [{ answer, solve, street,
 * ts, hero, heroPos, live, share, pick, served, traceHeroStrategy, … }] }] } — a hand's decisions in order.
 *
 * GUARDS: refuses to start without GTOW_CACHE_DB_PATH, or with it on the live cache; a session going LIVE (the live
 * sessions table) stops it before the next hand; a 429 on any request stops it; the run's own requests past --budget
 * stop it; an account past 1,500 requests in its last hour (every origin) stops it. Progress is appended per decision
 * (<out>/walks.jsonl); a re-run skips (mode, hand) pairs already complete.
 */
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---- arguments -----------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const flag = (k: string) => argv.includes(`--${k}`);
const REPORT = arg("report");
const LIVE_DIR = resolve(process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/");
const MODES = (arg("modes") ?? "abs,none,rel5").split(",").map((s) => s.trim()).filter(Boolean) as ("abs" | "rel5" | "rel1" | "none")[];
const TIERS = new Set((arg("tiers") ?? "t1,t2,t3").split(",").map((s) => s.trim()).filter(Boolean));
const ONLY = arg("hands")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const BUDGET = Number(arg("budget") ?? 1200);
const MAX_HANDS = Number(arg("max-hands") ?? Infinity);
const HOUR_CAP = Number(arg("hour-cap") ?? 1500);
const ORIGIN = "heroFloorAb";

type Mode = "abs" | "rel5" | "rel1" | "none";
interface SampleDecision { answer: number; solve: number; ts: number; street: string; hero: string; heroPos: string; live: number; share: number | null; pick: string; served: [string, number][] | null; traceHeroStrategy: [string, number | null][] | null; first: number; plan: string | null }
interface SamplePlan { hand: string; tier: string; tagged: number[]; decisions: SampleDecision[] }

/** One walked decision under one mode — a line of walks.jsonl. */
interface WalkRow {
  v: 1; runId: string; at: number; mode: Mode; hand: string; tier: string; tagged: boolean;
  answer: number; solve: number; street: string; hero: string; heroPos: string; livePick: string; liveServed: [string, number][] | null;
  ok: boolean; why: string | null; line: string | null;
  /** hero's node: the menu with his combo's mix and EV per action */
  node: { name: string; code: string; betsize: number | null; mix: number; ev: number | null; totalFrequency: number | null }[] | null;
  heroWeight: number | null;
  /** per street walked (k = 0 flop … 2 river): the floor's record, the tree, where the street came from, and whether
   *  the tree request was the LIVE one (its menus, pot, stacks, rake; the ranges by summed weight within 1 %) */
  streets: { k: number; street: string; heroFloor: any | null; created: boolean; solId: string | null; account: string | null; resumedAt: number | null; fromCheckpoint: boolean; nodeSrc: any; liveHeroIn: number | null; classHeroIn: number | null; sentSame: boolean | null; sentDiff: string | null }[];
  /** when the decision was played live */
  liveTs: number;
  /** the live trace's decision-street hero range (board removed), for the reproduction check */
  liveTrace: { liveMass: number; classMass: number; share: number; heroWeight: number; k: number; heroStrategy: [string, number][]; nodeEvs: [string, number][] } | null;
  seeded: number; requests: { tree: number; solution: number; poll: number; library: number; other: number; failed: number; total: number }; ms: number;
}

// ---- 1326-combo arithmetic (as aiChain) -----------------------------------------------------------------------------
const RANKS = "23456789TJQKA", SUITS = "cdhs";
const cardIdx = (card: string): number => RANKS.indexOf(card[0]!.toUpperCase()) * 4 + SUITS.indexOf(card[1]!.toLowerCase());
const comboCards = (idx: number): [number, number] => { let b = 1; while ((b + 1) * b / 2 <= idx) b++; return [idx - (b * (b - 1)) / 2, b]; };
const classCombos = (idx: number): number[] => {
  const [a, b] = comboCards(idx);
  const ra = Math.floor(a / 4), rb = Math.floor(b / 4), suited = a % 4 === b % 4;
  const out: number[] = [];
  for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
    if (ra === rb && s2 <= s1) continue;
    if (ra !== rb && (s1 === s2) !== suited) continue;
    const x = ra * 4 + s1, y = rb * 4 + s2;
    if (x === y) continue;
    const [lo, hi] = x < y ? [x, y] : [y, x];
    out.push((hi * (hi - 1)) / 2 + lo);
  }
  return out;
};
function massOf(range: number[], board: string, heroCombo: number): { live: number; cls: number; combo: number; max: number } {
  const blocked = new Set((board.match(/.{2}/g) ?? []).map(cardIdx));
  const cls = new Set(classCombos(heroCombo));
  let live = 0, c = 0, max = 0;
  for (let i = 0; i < 1326; i++) {
    const w = range[i] ?? 0;
    if (!(w > 0)) continue;
    const [a, b] = comboCards(i);
    if (blocked.has(a) || blocked.has(b)) continue;
    live += w; if (w > max) max = w;
    if (cls.has(i)) c += w;
  }
  const [ha, hb] = comboCards(heroCombo);
  return { live, cls: c, combo: blocked.has(ha) || blocked.has(hb) ? 0 : (range[heroCombo] ?? 0), max };
}
const heroPosOf = (sp: any): string => ({ oop: sp.oopPos, mid: sp.midPos, ip: sp.ipPos } as Record<string, string>)[sp.heroSeat] ?? sp.oopPos;
/** The first difference between two tree requests as the trace summarises them (gtowApi.treeRequestSummary): numbers to
 *  1e-6, a range summary's weight within 1 % (its combo count is not compared — 4-dp strategies drop dust combos). */
function sentDiffOf(live: unknown, walk: unknown, path = "", inRange = false): string | null {
  if (inRange && path.endsWith(".combos")) return null;
  if (typeof live === "number" && typeof walk === "number") {
    const tol = inRange ? Math.max(0.05, 0.01 * Math.abs(live)) : 1e-6;
    return Math.abs(live - walk) > tol ? `${path}: live ${live} / walk ${walk}` : null;
  }
  if (live && walk && typeof live === "object" && typeof walk === "object") {
    if (Array.isArray(live) !== Array.isArray(walk)) return `${path}: shape`;
    for (const k of new Set([...Object.keys(live as object), ...Object.keys(walk as object)])) {
      const d = sentDiffOf((live as any)[k], (walk as any)[k], `${path}.${k}`, inRange || k === "range");
      if (d) return d;
    }
    return null;
  }
  return JSON.stringify(live) !== JSON.stringify(walk) ? `${path}: live ${JSON.stringify(live)?.slice(0, 60)} / walk ${JSON.stringify(walk)?.slice(0, 60)}` : null;
}

// ====================================================================================================================
// --report: the per-decision table, the aggregates, the request count (no GTO Wizard, no live data)
// ====================================================================================================================
if (REPORT) {
  const rows = readFileSync(join(REPORT, "walks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as WalkRow);
  // the latest row per (mode, answer)
  const latest = new Map<string, WalkRow>();
  for (const r of rows) latest.set(`${r.mode}|${r.answer}`, r);
  const byAnswer = new Map<number, Map<Mode, WalkRow>>();
  for (const r of latest.values()) { const m = byAnswer.get(r.answer) ?? new Map(); m.set(r.mode, r); byAnswer.set(r.answer, m); }
  const modes = [...new Set([...latest.values()].map((r) => r.mode))].sort((a, b) => ["abs", "rel5", "rel1", "none"].indexOf(a) - ["abs", "rel5", "rel1", "none"].indexOf(b)) as Mode[];
  const pickOf = (r: WalkRow | undefined): string | null => r?.node?.length ? r.node.reduce((b, a) => (a.mix > b.mix ? a : b)).name : null;
  const evMap = (r: WalkRow): Map<string, number> => new Map((r.node ?? []).filter((a) => a.ev != null && Number.isFinite(a.ev)).map((a) => [a.code, a.ev!]));
  /** best-response loss of r's mix evaluated with ref's EVs (bb); null when the menus do not align */
  const loss = (r: WalkRow | undefined, ref: WalkRow | undefined): number | null => {
    if (!r?.node?.length || !ref?.node?.length) return null;
    const ev = evMap(ref);
    if (!ev.size) return null;
    let best = -Infinity, got = 0, mass = 0;
    for (const a of r.node) { const e = ev.get(a.code); if (e == null) { if (a.mix > 1e-6) return null; continue; } best = Math.max(best, e); got += a.mix * e; mass += a.mix; }
    for (const e of ev.values()) best = Math.max(best, e);
    if (mass < 0.5) return null;
    return best - got / mass;
  };
  const decisionStreet = (r: WalkRow | undefined) => r?.streets.length ? r.streets[r.streets.length - 1]! : null;
  const share = (r: WalkRow | undefined): number | null => { const s = decisionStreet(r); return s?.heroFloor ? (s.heroFloor.liveAfter > 0 ? s.heroFloor.classAfter / s.heroFloor.liveAfter : null) : null; };
  const mass = (r: WalkRow | undefined): number | null => decisionStreet(r)?.heroFloor?.liveAfter ?? null;
  const f = (x: number | null | undefined, d = 3) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
  const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${(100 * x).toFixed(0)}%`);
  interface Line { answer: number; hand: string; tier: string; tagged: boolean; street: string; hero: string; heroPos: string; regime: "a" | "b" | "?"; natural: number | null; ratio: number | null; rows: Map<Mode, WalkRow>; picks: Record<string, string | null>; shares: Record<string, number | null>; masses: Record<string, number | null>; lossNone: Record<string, number | null>; lossRel5: Record<string, number | null>; lossAbsRef: Record<string, number | null>; excessNone: Record<string, number | null>; excessRel5: Record<string, number | null>; changed: Record<string, boolean | null>; repro: string; liveTree: boolean | null }
  const lines: Line[] = [];
  for (const [answer, m] of [...byAnswer.entries()].sort((a, b) => a[0] - b[0])) {
    const abs = m.get("abs"), none = m.get("none"), rel5 = m.get("rel5");
    const any = abs ?? none ?? rel5 ?? [...m.values()][0]!;
    const nd = decisionStreet(none)?.heroFloor;
    const natural = nd ? nd.comboBefore : null;
    const regime: Line["regime"] = nd ? (nd.comboBefore > 1e-4 * Math.max(nd.maxLive, 1e-12) ? "a" : "b") : "?";
    const ratio = nd && nd.maxLive > 0 ? nd.comboBefore / nd.maxLive : null;
    const picks: Record<string, string | null> = {}, shares: Record<string, number | null> = {}, masses: Record<string, number | null> = {};
    const lossNone: Record<string, number | null> = {}, lossRel5: Record<string, number | null> = {}, lossAbsRef: Record<string, number | null> = {}, changed: Record<string, boolean | null> = {};
    const excessNone: Record<string, number | null> = {}, excessRel5: Record<string, number | null> = {};
    for (const mode of modes) {
      const r = m.get(mode);
      picks[mode] = pickOf(r); shares[mode] = share(r); masses[mode] = mass(r);
      lossNone[mode] = loss(r, none); lossRel5[mode] = loss(r, rel5); lossAbsRef[mode] = loss(r, abs);
      changed[mode] = r && abs ? pickOf(r) !== pickOf(abs) : null;
    }
    // the EXCESS over the reference's own regret (a QRE mix is never a pure best response: loss(ref | ref) > 0)
    const selfNone = loss(none, none), selfRel5 = loss(rel5, rel5);
    for (const mode of modes) {
      excessNone[mode] = lossNone[mode] != null && selfNone != null ? lossNone[mode]! - selfNone : null;
      excessRel5[mode] = lossRel5[mode] != null && selfRel5 != null ? lossRel5[mode]! - selfRel5 : null;
    }
    // the reproduction check: abs vs the live trace (mass, class share, pick)
    let repro = "—";
    const liveTree: boolean | null = abs ? (abs.streets.every((s) => s.sentSame === true) ? true : abs.streets.some((s) => s.sentSame === false) ? false : null) : null;
    if (abs?.liveTrace && abs.ok) {
      const lt = abs.liveTrace, s = decisionStreet(abs)?.heroFloor;
      const dm = s ? Math.abs(s.liveAfter - lt.liveMass) : NaN, dc = s ? Math.abs(s.classAfter - lt.classMass) : NaN;
      // the mix itself: max |Δ| over the menu, aligned by INDEX (the same tree's menu; names repeat — several BETs)
      const mine = abs.node ?? [];
      const dmix = mine.length === lt.heroStrategy.length
        ? Math.max(0, ...lt.heroStrategy.map(([, p], i) => Math.abs((mine[i]?.mix ?? 0) - p)))
        : Math.max(0, ...lt.heroStrategy.map(([n, p]) => Math.abs((mine.find((a) => a.name === n)?.mix ?? 0) - p)));
      const liveIdx = lt.heroStrategy.length ? lt.heroStrategy.reduce((b, a, i) => (a[1] > lt.heroStrategy[b]![1] ? i : b), 0) : -1;
      const livePick = liveIdx >= 0 ? `${lt.heroStrategy[liveIdx]![0]}${mine.length === lt.heroStrategy.length && mine[liveIdx]?.betsize ? ` ${mine[liveIdx]!.betsize}` : ""}` : null;
      const walkIdx = mine.length ? mine.reduce((b, a, i) => (a.mix > mine[b]!.mix ? i : b), 0) : -1;
      const okMass = dm <= Math.max(0.02, 0.01 * lt.liveMass) && dc <= Math.max(0.005, 0.01 * lt.classMass);
      const okPick = mine.length === lt.heroStrategy.length ? liveIdx === walkIdx : livePick === pickOf(abs);

      const how = liveTree === true ? "live tree" : liveTree === false ? `re-solved (${(abs.streets.find((s) => s.sentSame === false)?.sentDiff ?? "tree differs").replace(/^\./, "").slice(0, 50)})` : "tree not compared";
      repro = `${okMass && okPick ? "ok" : "DIFF"} · ${how} · mass Δ${f(dm, 3)} class Δ${f(dc, 4)} mix Δ${f(dmix, 3)}${okPick ? "" : ` pick live ${livePick} / walk ${pickOf(abs)}`}`;
    } else if (abs && !abs.ok) repro = `abs FAILED: ${abs.why}`;
    lines.push({ answer, hand: any.hand, tier: any.tier, tagged: any.tagged, street: any.street, hero: any.hero, heroPos: any.heroPos, regime, natural, ratio, rows: m, picks, shares, masses, lossNone, lossRel5, lossAbsRef, excessNone, excessRel5, changed, repro, liveTree });
  }
  const out: string[] = [];
  const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!; };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const agg = (title: string, sel: Line[]) => {
    out.push(`\n#### ${title} (${sel.length} decisions)`);
    out.push(`| mode | n | EXCESS loss vs none: mean / median / p95 / max (bb) | loss vs none: mean / median | excess vs rel5: mean / median | loss under abs's EVs: mean | pick ≠ abs | class share: median | mass: median |`);
    out.push(`|---|---|---|---|---|---|---|---|---|`);
    for (const mode of modes) {
      const ln = sel.map((l) => l.lossNone[mode]).filter((x): x is number => x != null);
      const en = sel.map((l) => l.excessNone[mode]).filter((x): x is number => x != null);
      const er = sel.map((l) => l.excessRel5[mode]).filter((x): x is number => x != null);
      const lr = sel.map((l) => l.lossRel5[mode]).filter((x): x is number => x != null);
      const la = sel.map((l) => l.lossAbsRef[mode]).filter((x): x is number => x != null);
      const ch = sel.filter((l) => l.changed[mode] === true).length, chN = sel.filter((l) => l.changed[mode] != null).length;
      const sh = sel.map((l) => l.shares[mode]).filter((x): x is number => x != null);
      const ms = sel.map((l) => l.masses[mode]).filter((x): x is number => x != null);
      out.push(`| ${mode} | ${sel.filter((l) => l.rows.get(mode)?.ok).length} | ${f(mean(en))} / ${f(q(en, 0.5))} / ${f(q(en, 0.95))} / ${f(en.length ? Math.max(...en) : null)} (n=${en.length}) | ${f(mean(ln))} / ${f(q(ln, 0.5))} | ${f(mean(er))} / ${f(q(er, 0.5))} (n=${er.length}) | ${f(mean(la))} (n=${la.length}) | ${ch} / ${chN} | ${pct(q(sh, 0.5))} | ${f(q(ms, 0.5), 2)} |`);
    }
  };
  const tagged = lines.filter((l) => l.tagged);
  out.push(`## Aggregates (tagged decisions = the sampled ones; a hand's other decisions were walked for the chain and are in the table)`);
  for (const tier of ["t1", "t2", "t3"]) {
    const sel = tagged.filter((l) => l.tier === tier);
    if (!sel.length) continue;
    agg(`tier ${tier}, all`, sel);
    if (tier !== "t3") {
      agg(`tier ${tier}, regime a (hero's natural weight > 1e-4 × max)`, sel.filter((l) => l.regime === "a"));
      agg(`tier ${tier}, regime b (hero deviated: natural weight ≈ 0)`, sel.filter((l) => l.regime === "b"));
      for (const st of ["flop", "turn", "river"]) { const s2 = sel.filter((l) => l.street === st); if (s2.length) agg(`tier ${tier}, ${st}`, s2); }
      // by how far hero's natural weight sits under his heaviest combo (none's decision street): the floor's overstatement
      const buckets: [string, (r: number) => boolean][] = [["natural / max < 1 %", (r) => r < 0.01], ["1-10 %", (r) => r >= 0.01 && r < 0.1], ["10-50 %", (r) => r >= 0.1 && r < 0.5], ["≥ 50 %", (r) => r >= 0.5]];
      for (const [name, ok] of buckets) { const s2 = sel.filter((l) => l.ratio != null && ok(l.ratio)); if (s2.length) agg(`tier ${tier}, hero's natural weight ${name} of his heaviest combo`, s2); }
    }
  }
  // the reproduction check, summarised: abs on the LIVE tree vs the live trace
  out.push(`\n## Reproduction (abs vs the live trace)`);
  const onLive = lines.filter((l) => l.liveTree === true && l.rows.get("abs")?.ok && l.rows.get("abs")?.liveTrace);
  const reSolved = lines.filter((l) => l.liveTree === false);
  const okN = onLive.filter((l) => l.repro.startsWith("ok")).length;
  out.push(`- decisions whose abs walk used the live tree on every street: ${onLive.length} — reproduced (mass and class within rounding, same pick): ${okN}; differing: ${onLive.length - okN}${onLive.length - okN ? ` (${onLive.filter((l) => !l.repro.startsWith("ok")).map((l) => l.answer).join(", ")})` : ""}`);
  out.push(`- decisions re-solved under today's menus (no live tree in the cache / the menus changed since): ${reSolved.length}; not comparable: ${lines.length - onLive.length - reSolved.length}`);
  // readability under none: hero's mix sums to ~1 and EVs are finite
  out.push(`\n## Readability of a near-zero-weight hero combo (mode none)`);
  for (const mode of modes) {
    const rs = [...latest.values()].filter((r) => r.mode === mode && r.ok && r.node);
    const sums = rs.map((r) => r.node!.reduce((s, a) => s + a.mix, 0));
    const noEv = rs.filter((r) => !r.node!.some((a) => a.ev != null && Number.isFinite(a.ev) && a.ev !== 0)).length;
    const degenerate = sums.filter((s) => s < 0.99 || s > 1.01).length;
    const tiny = rs.filter((r) => (r.heroWeight ?? 0) < 1e-3).length;
    out.push(`- ${mode}: ${rs.length} nodes read; mix sums outside [0.99, 1.01]: ${degenerate}; nodes with no non-zero finite EV: ${noEv}; hero weight at the node < 1e-3 (check #17's absent bound): ${tiny}`);
  }
  // requests
  out.push(`\n## Requests`);
  const reqBy = new Map<string, number>();
  for (const r of latest.values()) reqBy.set(r.mode, (reqBy.get(r.mode) ?? 0) + r.requests.total);
  const allRows = rows.reduce((s, r) => s + r.requests.total, 0);
  out.push(`- by mode (latest walk per decision): ${[...reqBy.entries()].map(([m, n]) => `${m} ${n}`).join(", ")}; every row ever written (re-runs included): ${allRows}`);
  const created = new Map<string, number>();
  for (const r of latest.values()) for (const s of r.streets) if (s.created) created.set(r.mode, (created.get(r.mode) ?? 0) + 1);
  out.push(`- trees CREATED by mode: ${[...created.entries()].map(([m, n]) => `${m} ${n}`).join(", ") || "none"}`);
  // the per-decision table
  out.push(`\n## Per-decision table`);
  out.push(`regime a = hero's natural weight (mode none, before its epsilon) > 1e-4 × his heaviest live combo; b = he deviated. excess(ref) = best-response loss of the mode's mix under ref's EVs MINUS ref's own regret under its EVs (a QRE mix is never a pure best response), bb. "repro" = the abs walk against the live trace (decision-street hero mass, class mass, mix, pick).`);
  const hdr = ["answer", "hand", "tier", "st", "hero", "pos", "reg", "natural w", "nat/max", ...modes.map((m) => `mass ${m}`), ...modes.map((m) => `share ${m}`), ...modes.map((m) => `pick ${m}`), ...modes.map((m) => `excess(none) ${m}`), ...modes.map((m) => `excess(rel5) ${m}`), "none under abs EVs", "repro"];
  out.push(`| ${hdr.join(" | ")} |`);
  out.push(`|${hdr.map(() => "---").join("|")}|`);
  for (const l of lines) {
    const row = [`${l.answer}${l.tagged ? "" : " (chain)"}`, l.hand, l.tier, l.street, l.hero, l.heroPos, l.regime, f(l.natural, 4), pct(l.ratio),
      ...modes.map((m) => f(l.masses[m], 2)), ...modes.map((m) => pct(l.shares[m])), ...modes.map((m) => `${l.picks[m] ?? (l.rows.get(m) ? `FAIL: ${(l.rows.get(m)!.why ?? "").slice(0, 40)}` : "—")}${l.changed[m] ? " *" : ""}`),
      ...modes.map((m) => f(l.excessNone[m])), ...modes.map((m) => f(l.excessRel5[m])), f(l.lossAbsRef["none"]), l.repro];
    out.push(`| ${row.join(" | ")} |`);
  }
  // the decisions where the choice matters most: largest loss(abs vs none) among tagged, regime a
  out.push(`\n## Where the choice matters most (tagged, by abs's excess loss under the natural reference)`);
  const top = tagged.filter((l) => l.excessNone["abs"] != null).sort((a, b) => (b.excessNone["abs"] ?? 0) - (a.excessNone["abs"] ?? 0)).slice(0, 5);
  for (const l of top) {
    const r = (m: Mode) => l.rows.get(m);
    const menu = (m: Mode) => (r(m)?.node ?? []).map((a) => `${a.name} ${(100 * a.mix).toFixed(1)}%${a.ev != null ? ` (EV ${a.ev.toFixed(2)})` : ""}`).join(", ");
    out.push(`- **${l.answer}** hand ${l.hand} ${l.street} ${l.heroPos} ${l.hero}, regime ${l.regime}, natural weight ${f(l.natural, 4)}; excess(abs | none) ${f(l.excessNone["abs"])} bb (raw ${f(l.lossNone["abs"])}), excess(rel5 | none) ${f(l.excessNone["rel5"])} bb, loss(none | abs) ${f(l.lossAbsRef["none"])} bb vs abs's own ${f(l.lossAbsRef["abs"])}`);
    for (const m of modes) if (r(m)?.node) out.push(`  - ${m}: mass ${f(l.masses[m], 2)}, class share ${pct(l.shares[m])} — ${menu(m)}`);
  }
  const text = out.join("\n");
  writeFileSync(join(REPORT, "report.md"), text);
  console.log(text);
  process.exit(0);
}

// ====================================================================================================================
// the walks
// ====================================================================================================================
const SAMPLE = arg("sample");
const OUT = arg("out");
if (!SAMPLE || !OUT) { console.error("usage: --sample <sample.json> --out <dir> [--modes abs,none,rel5] [--tiers t1,t2,t3] [--hands …] [--budget N] [--dry]  |  --report <dir>"); process.exit(64); }
const cachePath = (process.env.GTOW_CACHE_DB_PATH ?? "").replace(/\\/g, "/");
if (!cachePath || /^off$/i.test(cachePath)) { console.error("GTOW_CACHE_DB_PATH must point at a COPY of the solve cache (never the live file, never off)"); process.exit(64); }
if (resolve(cachePath).toLowerCase() === resolve(join(LIVE_DIR, "gtow-cache.sqlite")).toLowerCase()) { console.error(`GTOW_CACHE_DB_PATH is the LIVE cache (${cachePath}) — refused`); process.exit(64); }
if (process.env.GTOW_PREFETCH !== "0") { console.error("GTOW_PREFETCH=0 is required (no speculative node requests: every request must be the walk's own)"); process.exit(64); }
mkdirSync(OUT, { recursive: true });
const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as { plan: SamplePlan[] };
const runId = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${process.pid}`;
const WALKS = join(OUT, "walks.jsonl");
const done = new Set<string>();   // (mode|hand) pairs complete in an earlier run
if (existsSync(WALKS)) {
  const seen = new Map<string, Set<number>>();
  for (const l of readFileSync(WALKS, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as WalkRow; const k = `${r.mode}|${r.hand}`; (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(r.answer); }
  for (const p of sample.plan) for (const m of MODES) { const s = seen.get(`${m}|${p.hand}`); if (s && p.decisions.every((d) => s.has(d.answer))) done.add(`${m}|${p.hand}`); }
}

const { solveAiChain, seedAnsweredHeroNodes } = await import("../services/aiChain");
const { withRequestScope, totalRequests } = await import("../services/requestScope");
const { gtowSolveCache } = await import("../services/gtowSolveCache");
const { gtowRequests } = await import("../services/gtowRequestLog");
console.log(`[heroFloorAb] run ${runId}: live records ${LIVE_DIR}; solve cache ${cachePath} (${gtowSolveCache.enabled ? "on" : "OFF"}); modes ${MODES.join(",")}; tiers ${[...TIERS].join(",")}; budget ${BUDGET}`);

const liveDb = new Database(join(LIVE_DIR, "poker.sqlite"), { readonly: true });
const traceOf = (solve: number): any => { const r = liveDb.query("select trace from solves where id = ?").get(solve) as { trace: Uint8Array } | null; return r ? JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(r.trace))).toString("utf8")) : null; };
const sessionLive = (): string | null => (liveDb.query("select id from sessions where ended_at is null limit 1").get() as { id: string } | null)?.id ?? null;
const ledger = () => gtowRequests.handle();
const runStart = Date.now();
let spent = 0;
async function guard(where: string): Promise<void> {
  const live = sessionLive();
  if (live) { console.error(`\n[heroFloorAb] a poker session is LIVE (${live}) — stopping before ${where}; run again when it has ended`); process.exit(2); }
  const x429 = (ledger().query("select count(*) n from gtow_requests where ts >= ? and st = 429").get(runStart) as { n: number }).n;
  if (x429) { console.error(`\n[heroFloorAb] a 429 appeared in the ledger since this run started — a WALL: stopping before ${where}`); process.exit(3); }
  if (spent >= BUDGET) { console.error(`\n[heroFloorAb] budget spent (${spent} ≥ ${BUDGET}) — stopping before ${where}`); process.exit(5); }
  // an account past the hour cap (every origin): wait for its hour to roll, a minute at a time — never a stop
  for (;;) {
    const busy = ledger().query("select s, count(*) n from gtow_requests where ts >= ? group by s").all(Date.now() - 3_600_000) as { s: string; n: number }[];
    const over = busy.filter((b) => b.n >= HOUR_CAP);
    if (!over.length) return;
    console.log(`[heroFloorAb] account(s) at ${over.map((b) => `${b.s} ${b.n}`).join(", ")} requests in the last hour (cap ${HOUR_CAP}) — waiting 60 s before ${where}`);
    await new Promise((res) => setTimeout(res, 60_000));
    if (sessionLive()) { console.error(`\n[heroFloorAb] a poker session went LIVE while waiting — stopping`); process.exit(2); }
  }
}

const plans = sample.plan.filter((p) => TIERS.has(p.tier) && (!ONLY || ONLY.includes(p.hand))).slice(0, MAX_HANDS);
// --recent-first: within a tier the newest hands first (their live trees are still in the solve cache: abs is free there)
if (flag("recent-first")) plans.sort((a, b) => a.tier.localeCompare(b.tier) || b.decisions[0]!.ts - a.decisions[0]!.ts);
console.log(`[heroFloorAb] ${plans.length} hands, ${plans.reduce((s, p) => s + p.decisions.length, 0)} decisions; ${done.size} (mode, hand) pairs already done`);
if (flag("dry")) { for (const p of plans) console.log(`  ${p.tier} ${p.hand}: ${p.decisions.map((d) => `${d.answer} ${d.street}`).join(", ")}`); process.exit(0); }

for (const p of plans) {
  for (const mode of MODES) {
    if (done.has(`${mode}|${p.hand}`)) continue;
    await guard(`${mode} ${p.hand}`);
    process.env.HERO_CLASS_FLOOR = mode;
    const handKey = `hf-${runId}:${mode}:${p.hand}`;
    console.log(`\n== ${p.tier} ${p.hand} ${mode} (${p.decisions.length} decisions)`);
    for (const d of p.decisions) {
      const tr = traceOf(d.solve);
      if (!tr?.spec) { console.log(`  ${d.answer} ${d.street}: no trace for solve ${d.solve}`); continue; }
      const sp = tr.spec;
      const first = sp.firstStreet ?? 0;
      // SEED the live walk's hero narrowing (heroAnswered) where this mode's own walk has not answered the point yet
      // (aiChain.seedAnsweredHeroNodes — shared with the replay check since 2026-10-14; the checkpoint's nodes are this
      // mode's own earlier walk, not seeded)
      const seeded = seedAnsweredHeroNodes(tr, handKey);
      const spec = { ...sp, handKey };
      delete (spec as any).checkpointOnly; delete (spec as any).walkThrough;
      const t0 = Date.now();
      const { value: r, scope } = await withRequestScope({ handKey, origin: ORIGIN, street: d.street }, () => solveAiChain(spec));
      const ms = Date.now() - t0;
      const total = totalRequests(scope.counts);
      spent += total;
      const heroCombo: number | null = sp.heroComboIdx ?? null;
      const heroNode = r.trace?.nodes?.slice().reverse().find((x: any) => x.heroNode) ?? null;
      const node = heroNode && heroCombo != null ? heroNode.actions.map((a: any) => ({ name: a.name, code: a.code, betsize: a.betsize ?? null, mix: a.strategy?.[heroCombo] ?? 0, ev: a.evs?.[heroCombo] ?? null, totalFrequency: a.totalFrequency ?? null })) : null;
      const heroPos = heroPosOf(sp);
      const streets = (r.trace?.streets ?? []).map((s: any) => {
        const hi = (s.players ?? [sp.oopPos, sp.ipPos]).findIndex((x: string) => x.toUpperCase() === heroPos.toUpperCase());
        const m = hi >= 0 && s.rangesIn?.[hi] && heroCombo != null ? massOf(s.rangesIn[hi], s.board, heroCombo) : null;
        const ls = (tr.streets ?? []).find((x: any) => x.street === s.street);
        const sentDiff = ls?.sent && s.sent ? sentDiffOf(ls.sent, s.sent) : null;
        return { k: s.si + first, street: s.street, heroFloor: s.heroFloor ?? null, created: !!s.created, solId: s.solId ?? null, account: s.account ?? null, resumedAt: s.resumedAt ?? null, fromCheckpoint: !!s.fromCheckpoint, nodeSrc: s.nodeSrc ?? null, liveHeroIn: m?.live ?? null, classHeroIn: m?.cls ?? null,
          sentSame: ls?.sent && s.sent ? sentDiff == null : null, sentDiff };
      });
      // the live trace's decision street, for the reproduction check
      let liveTrace: WalkRow["liveTrace"] = null;
      {
        const ls = tr.streets?.[tr.streets.length - 1];
        const lh = (tr.nodes ?? []).slice().reverse().find((x: any) => x.heroNode);
        const hi = ls ? (ls.players ?? [sp.oopPos, sp.ipPos]).findIndex((x: string) => x.toUpperCase() === heroPos.toUpperCase()) : -1;
        if (ls && hi >= 0 && ls.rangesIn?.[hi] && heroCombo != null && lh) {
          const m = massOf(ls.rangesIn[hi], ls.board, heroCombo);
          liveTrace = { liveMass: m.live, classMass: m.cls, share: m.live > 0 ? m.cls / m.live : 0, heroWeight: m.combo, k: ls.si + first,
            heroStrategy: lh.actions.map((a: any) => [a.name, a.strategy?.[heroCombo] ?? 0]), nodeEvs: lh.actions.map((a: any) => [a.code, a.evs?.[heroCombo] ?? null]) };
        }
      }
      const row: WalkRow = {
        v: 1, runId, at: Date.now(), mode, hand: p.hand, tier: p.tier, tagged: p.tagged.includes(d.answer),
        answer: d.answer, solve: d.solve, street: d.street, hero: d.hero, heroPos, livePick: d.pick, liveServed: d.served,
        ok: r.ok, why: r.ok ? null : (r as any).why ?? null, line: r.ok ? (r as any).line ?? null : null,
        node, heroWeight: r.ok ? ((r as any).heroWeight ?? null) : null, streets, liveTrace, seeded, liveTs: d.ts,
        requests: { ...scope.counts, total }, ms,
      };
      appendFileSync(WALKS, `${JSON.stringify(row)}\n`);
      const ds = streets[streets.length - 1];
      const pick = node?.length ? node.reduce((b: any, a: any) => (a.mix > b.mix ? a : b)) : null;
      console.log(`  ${d.answer} ${d.street} ${d.hero} ${heroPos}: ${r.ok ? `${pick?.name ?? "?"} ${pick ? (100 * pick.mix).toFixed(1) : ""}% (live ${d.pick})` : `FAIL ${(r as any).why}`}` +
        ` · mass ${ds?.heroFloor ? ds.heroFloor.liveAfter.toFixed(2) : "?"} class ${ds?.heroFloor ? (100 * ds.heroFloor.classAfter / Math.max(ds.heroFloor.liveAfter, 1e-12)).toFixed(0) : "?"}%` +
        ` · trees ${streets.filter((s) => s.created).length} new · ${total} req (${spent} run) · ${(ms / 1000).toFixed(1)} s${seeded ? ` · seeded ${seeded}` : ""}`);
      if (scope.counts.failed && (ledger().query("select count(*) n from gtow_requests where ts >= ? and st = 429").get(t0) as { n: number }).n) {
        console.error(`[heroFloorAb] 429 during ${d.answer} — a WALL: stopping`); process.exit(3);
      }
    }
  }
}
console.log(`\n[heroFloorAb] done: ${spent} requests this run (origin ${ORIGIN} in the live ledger); rows in ${WALKS}`);
