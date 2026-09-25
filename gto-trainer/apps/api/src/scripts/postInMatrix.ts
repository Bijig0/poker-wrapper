/**
 * THE POST-IN MATRIX (2026-09-25, Brady: "create hands that have someone posting a big blind … check, as hero, if
 * given all the possibilities preflop of actions that occur, we have a fallback option set in already").
 *
 * The rule under test (utils/foldPostIns + fastSolve.postInAnswer, Brady's model):
 *   the poster acts AFTER hero      → an ordinary player still to act (his post is ignored)
 *   the poster CHECKED his option   → a LIMP
 *   the poster CALLED / RAISED      → an ordinary caller / raiser
 *   the poster FOLDED               → his post is dead money
 *   hero IS the poster              → hero plays the chart node of an ordinary player there, and never folds a free check
 *
 * How: for every poster seat (UTG/HJ/CO/BTN — a post-in is never in the blinds) the preflop tree is WALKED FROM THE
 * CHARTS THEMSELVES — every node's own menu (fold, call/limp/check, the smallest and largest raise, all-in), plus the
 * poster's option-check wherever he has one. Every node is a decision for the seat on it, so every hero seat is
 * covered by the one walk. Each decision is rendered twice, as the wrapper exports it:
 *   POST-IN   the blinds, then {type:"post"} for the poster, then his option-check / call-the-rest / raise
 *   ORDINARY  the same line at a table with no post — the poster's check is a limp, his call a call
 * and both go through the live pipeline (normalizeHand → withStartStacks → fastSolve). The rule holds when the
 * post-in answer IS the ordinary answer (same piece, chart, line and mix) and says it is an approximation.
 *
 * Then the AUTO-EXECUTE layer, exactly as the table plays it: every band of the answer's mix is rolled through the
 * poller's rollDecision and the wrapper's pickPlan, and the press must be one Ignition's strip offers — facing
 * nothing (hero posted in, or the BB's option) the strip is CHECK / RAISE: a Fold folds a free check, a Call is not
 * on offer (refused until the clock runs down to the no-answer check).
 *
 *   bun src/scripts/postInMatrix.ts [--posters=UTG,HJ,CO,BTN] [--pairs] [--nl5] [--max=200000] [--out=src/scripts/postin/out]
 *
 * Offline (GTOW_BLOCK=1, the baked charts). A line the charts cannot answer at an ordinary table either is counted
 * as "both-cloud" (the AI piece's, live) — never a post-in finding.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessEnv, exportAt, liveHand, type Hand, type Action } from "./mutationHarness";
import { fastSolve, forgetPreflopPin, forgetPostflopPin } from "../services/fastSolve";
import { nodeGetter } from "../services/hrc6max";
import { rollDecision } from "../services/rollDecision";
import { rollBands } from "../services/answerIntegrity";
import { pickPlan } from "../../../wrapper/src/relay";

const STRATEGY = "ign200-ring-6max-equilibrium";
export const POS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
type Pos = (typeof POS6)[number];
const SEAT: Record<Pos, number> = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 };
const STACK = 100;
/** hero hands tried in order until one is in the actor's range at the node (the answer is per class) */
const CARDS: [string, string][] = [["Ah", "Kh"], ["As", "Ad"], ["Ks", "Qs"], ["Jh", "Th"], ["9s", "8s"], ["5c", "5d"], ["As", "5s"],
  ["7h", "6h"], ["Kd", "Tc"], ["2c", "2d"], ["Qc", "9d"], ["Ac", "4d"], ["8c", "5d"], ["7c", "2d"]];

// ---- the abstract line: one table's preflop, in the ORDINARY game -------------------------------------------------
export type Kind = "F" | "C" | "R" | "A";   // fold · call/limp/check · raise to `to` · all-in
export interface Step { pos: Pos; kind: Kind; to?: number }
interface Table { committed: Record<Pos, number>; level: number; folded: Set<Pos>; allin: Set<Pos>; need: Set<Pos>; raises: number; limps: number; lastPos: Pos | null }

const r2 = (x: number) => Math.round(x * 100) / 100;

export function replay(line: Step[], sb = 0.5): Table {
  const t: Table = { committed: { UTG: 0, HJ: 0, CO: 0, BTN: 0, SB: sb, BB: 1 }, level: 1, folded: new Set(), allin: new Set(), need: new Set(POS6), raises: 0, limps: 0, lastPos: null };
  for (const s of line) {
    t.need.delete(s.pos);
    t.lastPos = s.pos;
    if (s.kind === "F") t.folded.add(s.pos);
    else if (s.kind === "C") { if (t.raises === 0 && t.committed[s.pos] < 1 && s.pos !== "SB") t.limps++; t.committed[s.pos] = Math.min(STACK, t.level); if (t.committed[s.pos] >= STACK) t.allin.add(s.pos); }
    else {
      const to = s.kind === "A" ? STACK : s.to!;
      t.committed[s.pos] = to;
      if (to >= STACK) t.allin.add(s.pos);
      if (to > t.level) {
        t.level = to; t.raises++;
        for (const p of POS6) if (p !== s.pos && !t.folded.has(p) && !t.allin.has(p)) t.need.add(p);
      }
    }
  }
  return t;
}
/** the next seat to act, or null when the preflop is over (one player left, or the round has closed) */
export function nextActor(line: Step[], t: Table): Pos | null {
  const live = POS6.filter((p) => !t.folded.has(p));
  if (live.length < 2) return null;
  const start = t.lastPos ? (POS6.indexOf(t.lastPos) + 1) % 6 : 0;
  for (let i = 0; i < 6; i++) {
    const p = POS6[(start + i) % 6]!;
    if (t.need.has(p) && !t.folded.has(p) && !t.allin.has(p)) {
      // everyone else all-in or folded and this seat has matched: nothing left to decide
      const others = live.filter((q) => q !== p && !t.allin.has(q));
      if (!others.length && t.committed[p] >= t.level) return null;
      return p;
    }
  }
  return null;
}

// ---- rendering: the wrapper's /hand export of a line, at a table with or without the post ------------------------
export interface Render { posters: Pos[]; postBb: number; bbCents: number }
export function renderHand(line: Step[], hero: Pos, r: Render): Hand {
  const sb = r.bbCents === 5 ? 0.4 : 0.5;
  const seats = POS6.map((p) => ({ id: SEAT[p], pos: p as string, stack: STACK }));
  const actions: Action[] = [{ street: 0, seat: SEAT.SB, type: "post-sb", amount: sb }, { street: 0, seat: SEAT.BB, type: "post-bb", amount: 1 }];
  const committed: Record<string, number> = { SB: sb, BB: 1 };
  for (const p of r.posters) { actions.push({ street: 0, seat: SEAT[p], type: "post", amount: r.postBb }); committed[p] = r.postBb; }
  let level = 1;
  for (const s of line) {
    const prev = committed[s.pos] ?? 0;
    if (s.kind === "F") { actions.push({ street: 0, seat: SEAT[s.pos], type: "fold" }); continue; }
    if (s.kind === "C") {
      const owe = r2(Math.min(STACK, level) - prev);
      if (owe <= 0.001) actions.push({ street: 0, seat: SEAT[s.pos], type: "check" });
      else if (prev + owe >= STACK) actions.push({ street: 0, seat: SEAT[s.pos], type: "all-in", amount: STACK });
      else actions.push({ street: 0, seat: SEAT[s.pos], type: "call", amount: owe });
      committed[s.pos] = Math.min(STACK, level);
      continue;
    }
    const to = s.kind === "A" ? STACK : s.to!;
    actions.push({ street: 0, seat: SEAT[s.pos], type: to >= STACK ? "all-in" : "raise", amount: to });
    committed[s.pos] = to;
    level = Math.max(level, to);
  }
  return { seats, hero: SEAT[hero], bbCents: r.bbCents, sbPost: sb, heroCards: ["Ah", "Kh"], board: ["2c", "7d", "Th", "Js", "3h"], actions, ops: [] };
}

let keyN = 0;
async function solve(h: Hand): Promise<{ res: any; raw: any }> {
  const key = `postin-${++keyN}`;
  forgetPreflopPin(key); forgetPostflopPin(key);
  const raw = exportAt(h, h.actions.length, key, 0, 0);
  let hand;
  try { hand = liveHand(raw); } catch (e: any) { return { res: { ok: false, kind: "normalize-threw", reason: String(e?.message ?? e) }, raw }; }
  try { return { res: await fastSolve(hand, hand.positions[hand.heroSeatId] ?? null, { strategyId: STRATEGY, origin: "harness" }), raw }; }
  catch (e: any) { return { res: { ok: false, kind: "threw", reason: String(e?.stack ?? e) }, raw }; }
}

const mixOf = (r: any) => (r?.actions ?? []).map((a: any) => `${a.action}:${Number(a.frequency).toFixed(2)}`).join(" ");
const CLOUD = /GTOW_BLOCK|no GTO Wizard|blocked|thinned to|the 6-max charts cover 4-6|dealt with no small blind|GTO Wizard AI preflop|last resort/i;
const refusalClass = (r: any) => r.ok ? "ok" : CLOUD.test(String(r.reason)) ? "cloud" : `refused:${r.kind ?? "?"}`;

// ---- the auto-execute layer ----------------------------------------------------------------------------------------
/** Every pick the poller can roll from this answer, and the press the wrapper would make for it. */
export function autoPresses(res: any): { pick: string; band: string; plan: string }[] {
  const out: { pick: string; band: string; plan: string }[] = [];
  const bands = rollBands(res.actions ?? []);
  const rolls = bands.length ? bands.map((b) => b.hi) : [50];
  for (const roll of rolls) {
    const rolled = rollDecision(res, roll);
    const plan = pickPlan(rolled.pick, res.pot ?? null);
    out.push({ pick: rolled.pick, band: `${rolled.band[0]}-${rolled.band[1]}`, plan: plan ? (plan.kind === "raise-to" ? `raise-to ${plan.amount}` : plan.label) : "UNMAPPED" });
  }
  return out;
}
/** What Ignition's strip offers: FOLD · CHECK or CALL n · RAISE TO / BET (ALL-IN is a sizing preset). A fold is on
 *  the strip facing nothing too, but pressing it there folds a free check. */
export function pressProblem(plan: string, toCall: number): string | null {
  const free = toCall <= 0.001;
  if (plan === "UNMAPPED") return "the pick maps to no table action";
  if (free && plan === "fold") return "FOLDS A FREE CHECK";
  if (free && plan === "call") return "CALL is not on the strip (CHECK is) — refused until the no-answer clock";
  if (!free && plan === "check") return `CHECK is not on the strip facing ${toCall}bb`;
  return null;
}

// ---- the walk ---------------------------------------------------------------------------------------------------------
export interface Row {
  posters: Pos[]; postBb: number; bbCents: number; line: string; hero: Pos; heroIsPoster: boolean; posterState: string;
  toCall: number; cards: string; ordinary: string; postIn: string; verdict: "ok" | "both-cloud" | "no-class" | "finding"; kind?: string; detail?: string;
  chart?: string; chartLine?: string; mix?: string; presses?: string;
}
const lineStr = (line: Step[]) => line.map((s) => `${s.pos}:${s.kind}${s.kind === "R" ? s.to : ""}`).join(" ") || "(first in)";

/** the poster's state as hero sees it at this node */
function posterState(line: Step[], poster: Pos, hero: Pos): string {
  const first = line.find((s) => s.pos === poster);
  if (poster === hero && !first) return "hero-posted";
  if (!first) return "to-act-after";
  const t0 = replay(line.slice(0, line.indexOf(first)));
  if (first.kind === "C") return t0.level <= 1 ? "checked(limp)" : "called";
  if (first.kind === "F") return "folded";
  return first.kind === "A" ? "all-in" : "raised";
}

async function menuAt(line: Step[], actor: Pos, render: Render, maxRaises = 4): Promise<{ steps: Step[]; ord: any; cards: [string, string] | null }> {
  // the ORDINARY table's node for the actor: its chart and line, and a hand class in range there
  let ord: any = null; let cards: [string, string] | null = null;
  for (const c of CARDS) {
    const h = renderHand(line, actor, { posters: [], postBb: 0, bbCents: render.bbCents });
    h.heroCards = c;
    const { res } = await solve(h);
    ord = res; cards = c;
    if (!res.ok || !res.notInRange) break;
  }
  if (!ord?.ok || ord.source !== "hrc-6max-preflop" || !ord.gametype) return { steps: [], ord, cards };
  const node: any = await nodeGetter(ord.gametype)(String(ord.line ?? "").replace(/ ?\(root\)$/, ""));
  if (!node || node === "unreachable" || node.terminal) return { steps: [], ord, cards };
  const t = replay(line);
  const steps: Step[] = [];
  const raises: number[] = [];
  let hasAllIn = false;
  for (const a of node.actions as { action: string; token: string | null }[]) {
    const tok = String(a.token ?? "");
    if (tok === "F") steps.push({ pos: actor, kind: "F" });
    else if (tok === "C") steps.push({ pos: actor, kind: "C" });
    else if (/^R/.test(tok)) { const to = parseFloat(tok.slice(1)); if (to >= STACK || /all/i.test(a.action)) hasAllIn = true; else raises.push(to); }
  }
  raises.sort((a, b) => a - b);
  const pick = [...new Set([raises[0], raises[raises.length - 1]].filter((x): x is number => x != null))];
  if (t.raises < maxRaises) for (const to of pick) steps.push({ pos: actor, kind: "R", to });
  if (hasAllIn && t.raises < maxRaises) steps.push({ pos: actor, kind: "A" });
  return { steps, ord, cards };
}

export async function walk(render: Render, o: { max: number; maxRaises?: number; uptoPosters?: boolean; onRow: (r: Row) => void }): Promise<number> {
  let n = 0;
  const posters = render.posters;
  const rec = async (line: Step[]): Promise<void> => {
    if (n >= o.max) return;
    const t = replay(line, render.bbCents === 5 ? 0.4 : 0.5);
    const actor = nextActor(line, t);
    if (!actor) return;
    // (--upto-posters: only the decisions until every poster has made his first — where the post itself is live)
    if (o.uptoPosters && posters.every((p) => line.some((s) => s.pos === p))) return;
    const { steps, ord, cards } = await menuAt(line, actor, render, o.maxRaises ?? 4);
    // the poster's FIRST action is his own: facing nothing he has the free option (check = a limp, or raise — a
    // poster never folds a free check), facing a raise he folds, calls or raises like anyone
    let menu = steps;
    const isPoster = posters.includes(actor) && !line.some((s) => s.pos === actor);
    if (isPoster && t.level <= 1) {
      // (a 0.4bb post at the 5c stake owes 0.6: his fold is real there)
      if (render.postBb >= 1) menu = steps.filter((s) => s.kind !== "F");
      if (!menu.some((s) => s.kind === "C")) menu.unshift({ pos: actor, kind: "C" });
    }
    // a non-poster may open-limp once per line (the pool does; the limp charts carry it) — beyond that the charts'
    // own menus decide
    if (!isPoster && t.level <= 1 && t.raises === 0 && t.limps === 0 && !menu.some((s) => s.kind === "C") && actor !== "BB") {
      menu.splice(1, 0, { pos: actor, kind: "C" });
    }
    // THE DECISION AT THIS NODE, for the seat on it
    n++;
    const row = await judge(line, actor, render, ord, cards);
    o.onRow(row);
    for (const s of menu) await rec([...line, s]);
  };
  await rec([]);
  return n;
}

async function judge(line: Step[], hero: Pos, render: Render, ord: any, cards: [string, string] | null): Promise<Row> {
  const posters = render.posters;
  const heroIsPoster = posters.includes(hero);
  const pState = posters.map((p) => `${p}:${posterState(line, p, hero)}`).join(",");
  const h = renderHand(line, hero, render);
  if (cards) h.heroCards = cards;
  const { res: pin, raw } = await solve(h);
  const toCall = Number(raw.currentNode?.toCall ?? 0);
  const base: Row = { posters, postBb: render.postBb, bbCents: render.bbCents, line: lineStr(line), hero, heroIsPoster, posterState: pState, toCall,
    cards: (cards ?? []).join(""), ordinary: refusalClass(ord), postIn: refusalClass(pin), verdict: "ok",
    chart: pin.gametype, chartLine: pin.line, mix: mixOf(pin) };
  const find = (kind: string, detail: string): Row => ({ ...base, verdict: "finding", kind, detail });
  // 1. THE FALLBACK EXISTS: the post-in table answers wherever the ordinary table does
  if (!ord?.ok && !pin.ok) {
    if (refusalClass(ord) === refusalClass(pin)) return { ...base, verdict: "both-cloud", detail: String(pin.reason ?? "").slice(0, 200) };
    return find("refusal-differs", `ordinary ${refusalClass(ord)}: ${String(ord?.reason).slice(0, 160)} | post-in ${refusalClass(pin)}: ${String(pin.reason).slice(0, 160)}`);
  }
  if (!pin.ok) return find("post-in-refused", `the ordinary table answers (${ord.gametype} ${ord.line}) and the post-in table does not: ${refusalClass(pin)} — ${String(pin.reason).slice(0, 300)}`);
  if (!ord?.ok) return find("post-in-answers-ordinary-does-not", `${String(ord?.reason).slice(0, 200)}`);
  // 2. THE RULE: the post-in answer is the ordinary table's answer
  const same = (k: string) => String(pin[k] ?? "") === String(ord[k] ?? "");
  if (!same("source") || !same("gametype") || !same("line")) return find("different-node", `ordinary ${ord.source} ${ord.gametype} [${ord.line}] vs post-in ${pin.source} ${pin.gametype} [${pin.line}]`);
  const heroFree = heroIsPoster && !line.some((s) => s.pos === hero);
  if (!mixAgrees(ord, pin, heroFree ? toCall : 1)) return find("different-mix", `ordinary {${mixOf(ord)}} vs post-in {${mixOf(pin)}}`);
  if (!!pin.notInRange !== !!ord.notInRange) return find("range-differs", `notInRange ordinary ${!!ord.notInRange} post-in ${!!pin.notInRange}`);
  // 3. IT SAYS SO
  if (pin.approx !== true || !/POSTED IN \(approximation\)/.test(String(pin.warning ?? ""))) return find("no-approx-note", String(pin.warning ?? "").slice(0, 200));
  // no class of the 14 tried is in the seat's range here (the poller serves no pick for a null decision either)
  if (pin.decision == null) return { ...base, verdict: "no-class", detail: String(pin.warning ?? "").slice(0, 200) };
  // 4. THE PRESS: every pick the poller can roll must be a press the strip offers
  const presses = autoPresses(pin);
  base.presses = presses.map((p) => `${p.band}→${p.pick}→${p.plan}`).join(" | ");
  for (const p of presses) {
    const bad = pressProblem(p.plan, toCall);
    if (bad) return { ...find("auto-press", `roll ${p.band} picks "${p.pick}" → press ${p.plan}: ${bad} (toCall ${toCall}, mix {${mixOf(pin)}})`), presses: base.presses };
  }
  // 5. HERO'S OWN POST, NOT YET ACTED: the one spot where the post changes what hero may press — so EVERY hand class,
  // not only the first one in range (AKs is a pure raise almost everywhere and hid the mixed classes' Fold/Limp bands)
  if (heroFree) {
    const bad: string[] = [];
    let n = 0;
    for (const c of ALL_CLASSES) {
      const ho = renderHand(line, hero, { posters: [], postBb: 0, bbCents: render.bbCents }); ho.heroCards = c;
      const hp = renderHand(line, hero, render); hp.heroCards = c;
      const [{ res: o }, { res: p, raw: rp }] = [await solve(ho), await solve(hp)];
      if (!o.ok || !p.ok || p.decision == null) continue;
      n++;
      const cls = c.join("");
      if (!mixAgrees(o, p, Number(rp.currentNode?.toCall ?? 0))) { bad.push(`${cls}: mix {${mixOf(p)}} vs ordinary {${mixOf(o)}}`); continue; }
      for (const pr of autoPresses(p)) {
        const why = pressProblem(pr.plan, Number(rp.currentNode?.toCall ?? 0));
        if (why) { bad.push(`${cls}: roll ${pr.band} → "${pr.pick}" → ${pr.plan}: ${why} {${mixOf(p)}}`); break; }
      }
    }
    base.detail = `${n} classes checked`;
    if (bad.length) return find("auto-press-classes", `${bad.length} of ${n} classes: ${bad.slice(0, 6).join(" · ")}`);
  }
  return base;
}

/** one combo per hand class (169) */
const ALL_CLASSES: [string, string][] = (() => {
  const R = "AKQJT98765432"; const out: [string, string][] = [];
  for (let i = 0; i < 13; i++) for (let j = i; j < 13; j++) {
    if (i === j) out.push([`${R[i]}s`, `${R[j]}h`]);
    else { out.push([`${R[i]}s`, `${R[j]}s`]); out.push([`${R[i]}s`, `${R[j]}h`]); }
  }
  return out;
})();

/** Hero's free option may show the chart's mix with its Fold and Call/Limp read as Check (nothing more goes in);
 *  anything else must be the ordinary node's mix exactly. */
function mixAgrees(ord: any, pin: any, toCall: number): boolean {
  if (mixOf(pin) === mixOf(ord)) return true;
  if (toCall > 0.001) return false;
  const passive = /^(fold|check|call|limp)\b/i;
  const fold = (xs: any[]) => {
    const m = new Map<string, number>();
    for (const a of xs ?? []) { const k = passive.test(a.action) ? "Check" : a.action; m.set(k, (m.get(k) ?? 0) + Number(a.frequency)); }
    return m;
  };
  // (to 0.02: 8.70 + 0.35 sums to 9.0499… against the answer's rounded 9.05)
  const a = fold(ord.actions), b = fold(pin.actions);
  return a.size === b.size && [...a].every(([k, v]) => b.has(k) && Math.abs(b.get(k)! - v) <= 0.02);
}

// ---- the report ---------------------------------------------------------------------------------------------------------
export function summarize(rows: Row[]): string {
  const L: string[] = [];
  const by = <T,>(xs: T[], f: (x: T) => string) => { const m: Record<string, T[]> = {}; for (const x of xs) (m[f(x)] ??= []).push(x); return m; };
  const f = rows.filter((r) => r.verdict === "finding");
  L.push(`# Post-in matrix — ${rows.length} decisions, ${f.length} findings`, "");
  L.push("| poster(s) | post | decisions | ok | both-cloud | no-class | findings |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const [k, rs] of Object.entries(by(rows, (r) => `${r.posters.join("+")}|${r.postBb}bb @${r.bbCents}c`))) {
    const [p, amt] = k.split("|");
    L.push(`| ${p} | ${amt} | ${rs.length} | ${rs.filter((r) => r.verdict === "ok").length} | ${rs.filter((r) => r.verdict === "both-cloud").length} | ${rs.filter((r) => r.verdict === "no-class").length} | ${rs.filter((r) => r.verdict === "finding").length} |`);
  }
  L.push("", "## By the poster's state at hero's decision", "", "| poster state | decisions | ok | both-cloud | findings |", "|---|---:|---:|---:|---:|");
  const st = (r: Row) => r.posterState.split(",").map((x) => x.split(":")[1]).join("+");
  for (const [k, rs] of Object.entries(by(rows, st)).sort()) L.push(`| ${k} | ${rs.length} | ${rs.filter((r) => r.verdict === "ok").length} | ${rs.filter((r) => r.verdict === "both-cloud").length} | ${rs.filter((r) => r.verdict === "finding").length} |`);
  L.push("", "## Hero seat × poster seat (decisions / findings)", "", `| hero \\ poster | ${["UTG", "HJ", "CO", "BTN"].join(" | ")} |`, "|---|---:|---:|---:|---:|");
  for (const hero of POS6) L.push(`| ${hero} | ${["UTG", "HJ", "CO", "BTN"].map((p) => { const rs = rows.filter((r) => r.hero === hero && r.posters.length === 1 && r.posters[0] === p); return rs.length ? `${rs.length} / ${rs.filter((r) => r.verdict === "finding").length}` : "—"; }).join(" | ")} |`);
  L.push("", "## Findings by class", "");
  for (const [k, rs] of Object.entries(by(f, (r) => `${r.kind} · ${st(r)}`)).sort((a, b) => b[1].length - a[1].length)) {
    L.push(`### ${k} — ${rs.length}`);
    for (const r of rs.slice(0, 5)) L.push(`- hero ${r.hero} ${r.cards} · posters ${r.posters.join("+")} ${r.postBb}bb · ${r.line} · toCall ${r.toCall} — ${r.detail}`);
    L.push("");
  }
  return L.join("\n");
}

if (import.meta.main) {
  const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1]!;
  const flag = (k: string) => process.argv.includes(`--${k}`);
  const posters = arg("posters", "UTG,HJ,CO,BTN").split(",") as Pos[];
  const max = Number(arg("max", "200000"));
  const out = arg("out", join(import.meta.dir, "postin", "out"));
  mkdirSync(out, { recursive: true });
  const restore = harnessEnv();
  const rows: Row[] = [];
  const t0 = Date.now();
  const renders: Render[] = flag("no-single") ? [] : posters.map((p) => ({ posters: [p], postBb: 1, bbCents: 200 }));
  if (flag("pairs")) for (let i = 0; i < posters.length; i++) for (let j = i + 1; j < posters.length; j++) renders.push({ posters: [posters[i]!, posters[j]!], postBb: 1, bbCents: 200 });
  if (flag("nl5")) for (const p of posters) renders.push({ posters: [p], postBb: 0.4, bbCents: 5 });
  try {
    for (const r of renders) {
      const before = rows.length;
      const n = await walk(r, { max, uptoPosters: flag("upto-posters"), onRow: (row) => {
        rows.push(row);
        if (rows.length % 2000 === 0) console.error(`  … ${rows.length} decisions, ${rows.filter((x) => x.verdict === "finding").length} findings (${Math.round((Date.now() - t0) / 1000)} s)`);
      } });
      console.error(`${r.posters.join("+")} ${r.postBb}bb @${r.bbCents}c: ${n} decisions, ${rows.slice(before).filter((x) => x.verdict === "finding").length} findings (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  } finally { restore(); }
  writeFileSync(join(out, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(out, "findings.jsonl"), rows.filter((r) => r.verdict === "finding").map((r) => JSON.stringify(r)).join("\n") + "\n");
  const md = summarize(rows) + `\n\n${Date.now() - t0} ms · posters ${renders.map((r) => `${r.posters.join("+")} ${r.postBb}bb@${r.bbCents}c`).join(", ")}\n`;
  writeFileSync(join(out, "summary.md"), md);
  console.log(md);
}
