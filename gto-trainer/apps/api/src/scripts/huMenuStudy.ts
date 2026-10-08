/**
 * THE HEADS-UP MENU STUDY (2026-10-08, Brady "fix 3": HU_FIXED_MENU). Is the fixed 33% / 75% | 60% heads-up menu at
 * least as good as GTO Wizard's AUTOMATIC sizing on the core spots where the re-tree carry moved hero's mix most?
 *
 * For each spot (a heads-up decision of the core stress store, poker-data-stress500-core: the hands where the re-run
 * moved mixes most) ONE YARDSTICK tree is solved with a RICH menu on the decision street: bets 33% / 75% / 125%, raises
 * 60%, each seat's all-in, the sizes played on the street (pinned as amounts) and — so that no served mix has to be
 * mapped onto a size it never had — the wager sizes hero was SERVED at that node by the old run and the new run, added
 * to his own level when no yardstick size is within the walk's tolerance of them. The entering ranges, board, pot,
 * stacks and rake are the NEW run's (that street of its stored trace, root\poker.sqlite solves, read-only). The FIXED
 * tree (the live path after HU_FIXED_MENU: buildCustomTree as this branch sends it, the same entering ranges) is solved
 * too. Scored inside the yardstick at hero's node, for hero's combo: the per-action EVs of the yardstick, and
 *   (a) OLD  the mix served before the re-tree carry (hands_pre_retree/, auto menus)
 *   (b) NEW  the mix served after it (hands/, the carried auto menu)
 *   (c) FIXED the fixed 33/75 tree's mix for the combo
 * each mapped onto the yardstick's actions by class (a size on the yardstick when present, else its nearest size —
 * flagged lossy past 5% / 0.15bb). EV loss = the yardstick mix's EV for the combo − the mapped mix's (bb, % of the pot
 * at the node). The yardstick's own regret at the node (hero's range: best action's EV − the mix's, range-weighted) is
 * the solver's noise floor.
 *
 *   powershell: . C:\Users\Brady\poker-wrapper\config\env.ps1; $env:GTOW_REQUEST_ORIGIN = "huMenuStudy"
 *     bun src/scripts/huMenuStudy.ts --phase plan          # offline: the spots, the trees, the mixes — 0 requests
 *     bun src/scripts/huMenuStudy.ts --phase run [--cap 60] [--only core-bvb-007:14,...]
 *
 * GUARDS: every request through one gate on the PRIMARY account (ledger origin huMenuStudy): refused past --cap
 * (60) of this run's own, before each tree when http://127.0.0.1:2000/api/load says sessionLive (or does not answer and
 * poker.sqlite has an open session), and after any 429. Results: <out>.json beside the report.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GtowApi, huFixedMenuOn, type CustomTreeInput, type PlayedWager } from "../services/gtowApi";
import { gtowSessions } from "../services/gtowSessions";
import { gtowRequests } from "../services/gtowRequestLog";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const PHASE = (arg("phase") ?? "plan") as "plan" | "run" | "reread";
const CAP = Number(arg("cap") ?? 60);
const CORE = "C:/Users/Brady/poker-data-stress500-core";
const OUT = arg("out") ?? "C:/Users/Brady/poker-data/audits/hu-menu-study-2026-10-08";
const API = "https://api.gtowizard.com";
const SESSION = "primary";

/** the spots, in the order they are run (the budget may stop the tail) */
const SPOTS: { id: string; idx: number }[] = [
  { id: "core-bvb-007", idx: 14 },             // turn, facing X-R7.5: CALL 92 → FOLD 98
  { id: "core-real-4922267364", idx: 10 },     // flop, facing X-R2.6: CALL 60 / RAISE 40 → CALL 87 / FOLD 13
  { id: "core-real-4921631870", idx: 10 },     // turn root: CHECK 99.9 → CHECK 63 / BET 37
  { id: "core-real-4922313312", idx: 9 },      // turn root: CHECK 62 / BET 38 → BET 90
  { id: "core-real-4921729477", idx: 12 },     // river root: CHECK 86 / BET 14 → BET 93
  { id: "core-real-4921623996", idx: 12 },     // turn root: CHECK 33 / BET 35 / ALLIN 31 → CHECK 77
  { id: "core-limp-hu-007", idx: 13 },         // river root: CHECK 27 / BET 73 → BET 90
  { id: "core-real-4921623996", idx: 10 },     // flop, facing X-R3.2: CALL 39 / RAISE 61 → CALL 66 / RAISE 34
];
const ONLY = arg("only")?.split(",").map((x) => { const [id, i] = x.split(":"); return { id: id!, idx: Number(i) }; }) ?? null;

if (PHASE !== "plan" && process.env.GTOW_REQUEST_ORIGIN !== "huMenuStudy") { console.error("set GTOW_REQUEST_ORIGIN=huMenuStudy (the ledger origin)"); process.exit(2); }
if (!huFixedMenuOn()) { console.error("HU_FIXED_MENU is off in this environment — the fixed tree would be the AUTOMATIC one"); process.exit(2); }

// ── the guards ──────────────────────────────────────────────────────────────────────────────────────────────────
let spent = 0;
let stopped: string | null = null;
const startedAt = Date.now();
const log = (s: string): void => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`); };
async function sessionLive(): Promise<boolean> {
  try {
    const r = await fetch("http://127.0.0.1:2000/api/load", { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    return j?.sessionLive !== false;
  } catch {
    const db = new Database("C:/Users/Brady/poker-data/poker.sqlite", { readonly: true });
    try { return ((db.query("select count(*) n from sessions where ended_at is null").get() as { n: number }).n ?? 0) > 0; } finally { db.close(); }
  }
}
async function guardBatch(what: string): Promise<void> {
  if (stopped) throw new Error(`STOPPED: ${stopped}`);
  if (await sessionLive()) { stopped = "a poker session is live (or :2000 is unreadable and poker.sqlite has an open session)"; throw new Error(`STOPPED: ${stopped}`); }
  log(`batch: ${what} (spent ${spent}/${CAP})`);
}
async function gated(kind: "tree" | "solution" | "poll", url: string, init: RequestInit): Promise<Response> {
  if (stopped) throw new Error(`STOPPED: ${stopped}`);
  if (spent >= CAP) { stopped = `the cap (${CAP} requests) is reached`; throw new Error(`STOPPED: ${stopped}`); }
  spent++;
  const r = await gtowRequests.fetch(SESSION, kind, url, init, { cl: "study" });
  if (r.status === 429) { stopped = `GTO Wizard answered 429 (${kind})`; log(`STOP: 429 on ${kind}`); }
  return r;
}
let token: string | null = null;
async function tok(force = false): Promise<string> {
  if (!token || force) token = await gtowSessions.tokenFor(SESSION, force);
  if (!token) throw new Error("no primary token (is the Ultra client up with its debug port?)");
  return token;
}
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

async function solveTree(body: any, board: string): Promise<string> {
  let t = await tok();
  let tr = await gated("tree", `${API}/v4/custom-solutions/custom-trees/`, { method: "POST", headers: H(t), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (tr.status === 401 || (tr.status === 400 && /api key|token/i.test(await tr.clone().text()))) {
    t = await tok(true);
    tr = await gated("tree", `${API}/v4/custom-solutions/custom-trees/`, { method: "POST", headers: H(t), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  }
  if (!tr.ok) throw new Error(`custom-trees ${tr.status}: ${(await tr.text()).slice(0, 300)}`);
  const tj: any = await tr.json();
  const so = await gated("solution", `${API}/v4/custom-solutions/`, { method: "POST", headers: H(t), body: JSON.stringify({ custom_tree_id: tj.id, actions: "", board }), signal: AbortSignal.timeout(30_000) });
  if (!so.ok) throw new Error(`custom-solutions ${so.status}: ${(await so.text()).slice(0, 300)}`);
  const sj: any = await so.json();
  return String(sj.id ?? sj.custom_solution_id);
}
/** poll one node until it answers: the first poll starts the solve, the second waits the street's usual solve time */
async function readNode(solId: string, board: string, street: string, codes: string, settleMs: number): Promise<any> {
  const q = new URLSearchParams({ custom_solution_id: solId, preflop_actions: "", flop_actions: street === "FLOP" ? codes : "",
    turn_actions: street === "TURN" ? codes : "", river_actions: street === "RIVER" ? codes : "", board });
  for (let k = 0; k < 7; k++) {
    const r = await gated("poll", `${API}/v4/solutions/spot-solution/?${q}`, { headers: { Authorization: `Bearer ${await tok()}` }, signal: AbortSignal.timeout(20_000) });
    if (r.ok && r.status !== 204) {
      const j: any = await r.json().catch(() => null);
      if (j?.action_solutions?.length) return j;
    } else if (!r.ok && r.status !== 204) throw new Error(`spot-solution [${codes || "root"}] ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await Bun.sleep(k === 0 ? settleMs : 2500);
  }
  throw new Error(`node [${codes || "root"}] not ready after 7 polls`);
}

// ── the spots ───────────────────────────────────────────────────────────────────────────────────────────────────
interface Served { cls: string; bb: number | null; f: number; name: string }
const parseServed = (actions: { action: string; frequency: number }[]): Served[] => actions.map((a) => {
  const m = /^(FOLD|CHECK|CALL|BET|RAISE|ALLIN)\s*([\d.]+)?/i.exec(a.action.trim());
  const c = (m?.[1] ?? "?").toUpperCase();
  return { cls: c === "BET" || c === "RAISE" ? "WAGER" : c, bb: m?.[2] ? Number(m[2]) : null, f: a.frequency / 100, name: a.action };
});
const db = new Database(`${CORE}/root/poker.sqlite`, { readonly: true });
function traceOf(id: number): any {
  const row = db.query("select trace, hero_pos from solves where id = ?").get(id) as any;
  if (!row) throw new Error(`solve ${id} not in the core store`);
  return { trace: JSON.parse(Buffer.from(Bun.gunzipSync(row.trace)).toString("utf-8")), heroPos: row.hero_pos };
}
const decisionOf = (dir: string, id: string, idx: number) => {
  const h = JSON.parse(readFileSync(`${CORE}/${dir}/${id}.json`, "utf-8"));
  const d = (h.decisions as any[]).find((x) => x.index === idx);
  if (!d) throw new Error(`${dir}/${id}: no decision ${idx}`);
  return { h, d };
};
const labelCode = (l: string): string => {
  if (l === "Check") return "X";
  if (l === "Call") return "C";
  if (l === "Fold") return "F";
  const m = /^(?:Bet|Raise|AllIn)\((\d+(?:\.\d+)?)\)$/.exec(l);
  if (!m) throw new Error(`label ${l}`);
  return `R${Math.round(Number(m[1])) / 100}`;
};
const TOL = (x: number) => Math.max(0.05 * x, 0.15);

interface Spot {
  key: string; id: string; idx: number; street: "FLOP" | "TURN" | "RIVER"; board: string; heroPos: string; hero: number; combo: number;
  potNode: number; level: number; codes: string; input: CustomTreeInput; old: Served[]; neu: Served[]; heroCards: string; line: string;
}
function spotOf(id: string, idx: number): Spot {
  const pre = decisionOf("hands_pre_retree", id, idx);
  const now = decisionOf("hands", id, idx);
  const { trace, heroPos } = traceOf(now.d.solveId);
  const street = String(now.d.street).toUpperCase() as Spot["street"];
  const st = (trace.streets as any[]).find((s) => s.street === street);
  if (!st) throw new Error(`${id}: no ${street} in solve ${now.d.solveId}`);
  const players: string[] = st.players;
  if (players.length !== 2) throw new Error(`${id}: ${players.length} seats`);
  const hero = players.indexOf(heroPos);
  const labels: string[] = st.labels ?? [];
  const actors: number[] = [];
  // HU: OOP first, alternate unless a wager re-opens — heads-up the actor simply alternates
  labels.forEach((_, i) => actors.push(i % 2));
  const played: PlayedWager[] = st.played ?? [];
  const invested = [0, 0];
  let level = 0;
  labels.forEach((l, i) => {
    const m = /\((\d+(?:\.\d+)?)\)/.exec(l);
    if (m) { invested[actors[i]!] = Number(m[1]) / 100; level++; }
    else if (l === "Call") invested[actors[i]!] = Math.max(...invested);
  });
  const stacks = players.map((p) => Number(st.stacksIn?.[p] ?? st.stackIn));
  const input: CustomTreeInput = {
    board: st.board, pot: st.potIn, stack: st.stackIn, stacks, oopRange: st.oopIn ?? st.rangesIn[0], ipRange: st.ipIn ?? st.rangesIn[1],
    oopPos: players[0], ipPos: players[1], startingStreet: street, rake: trace.spec.rake,
    ...(played.length ? { played: { [street]: played } } : {}),
  };
  return { key: `${id}:${idx}`, id, idx, street, board: st.board, heroPos, hero, combo: trace.spec.heroComboIdx, potNode: st.potIn + invested[0]! + invested[1]!,
    level, codes: labels.map(labelCode).join("-"), input, old: parseServed(pre.d.actions ?? []), neu: parseServed(now.d.actions ?? []),
    heroCards: (now.h.hand.heroCards ?? []).join(""), line: now.d.line };
}

const api = new GtowApi();
const entryOf = (body: any, street: string) => body.bet_sizes.street_bet_sizes.find((s: any) => s.street === street).position_bet_sizes as any[];
const LV = ["bet_sizes", "raise_sizes", "second_raise_sizes", "third_plus_raise_sizes"] as const;
const amt = (x: string, pot: number): number | null => {
  const b = /^(\d+(?:\.\d+)?)bb$/.exec(x);
  if (b) return Number(b[1]);
  const p = /^(\d+(?:\.\d+)?)%$/.exec(x);
  return p ? Math.round(Number(p[1]) * pot) / 100 : null;
};
/** THE YARDSTICK: the fixed tree's body with 125% added to every seat's bet list on the decision street, and hero's
 *  served wager sizes (old + new) added at his level where no yardstick size is within tolerance (bets: % of the street
 *  pot; raises: amounts only — `raiseAmts` = the fixed tree's 60% raise-to at hero's node when known) */
function yardstickOf(s: Spot, fixedBody: any, raiseAmts: number[]): { body: any; added: string[] } {
  const body = JSON.parse(JSON.stringify(fixedBody));
  const e = entryOf(body, s.street);
  const added: string[] = [];
  for (const p of e) {
    const ai = p.bet_sizes[p.bet_sizes.length - 1];
    const own = p.bet_sizes.filter((x: string) => /bb$/.test(x) && x !== ai).map((x: string) => amt(x, s.input.pot)!);
    const a125 = 1.25 * s.input.pot;
    if (!own.some((a: number) => Math.abs(a - a125) <= TOL(a)) && a125 < Number(ai.replace("bb", "")) - 0.005) p.bet_sizes.splice(p.bet_sizes.length - 1, 0, "125%");
  }
  const hp = e[s.hero];
  const k = LV[Math.min(s.level, 3)]!;
  const list: string[] = hp[k];
  const ai = Number(String(list[list.length - 1]).replace("bb", ""));
  const have = (): number[] => [...list.map((x) => (s.level === 0 ? amt(x, s.input.pot) : /bb$/.test(x) ? amt(x, s.input.pot) : null)).filter((x): x is number => x != null), ...(s.level ? raiseAmts : [])];
  for (const w of [...s.old, ...s.neu]) {
    if (w.cls !== "WAGER" || w.bb == null || w.bb >= ai - 0.005) continue;
    if (have().some((a) => Math.abs(a - w.bb!) <= TOL(w.bb!))) continue;
    list.splice(list.length - 1, 0, `${w.bb}bb`);
    added.push(`${w.bb}bb`);
  }
  return { body, added };
}

// ── scoring ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface YAct { cls: string; bb: number | null; s: number; ev: number; name: string }
const clsOf = (a: any): string => {
  const t = String(a.action?.type ?? "").toUpperCase();
  if (a.action?.allin) return "ALLIN";
  if (t === "FOLD" || t === "CHECK" || t === "CALL") return t;
  const d = String(a.action?.display_name ?? "").toUpperCase();
  if (d.startsWith("FOLD")) return "FOLD";
  if (d.startsWith("CHECK")) return "CHECK";
  if (d.startsWith("CALL")) return "CALL";
  if (d.startsWith("ALL")) return "ALLIN";
  return "WAGER";
};
const yActs = (node: any, c: number): YAct[] => (node.action_solutions as any[]).map((a) => ({
  cls: clsOf(a), bb: a.action?.betsize != null && a.action.betsize !== "" ? Number(a.action.betsize) : null,
  s: Number(a.strategy?.[c] ?? 0), ev: Number(a.evs?.[c] ?? 0),
  name: `${String(a.action?.display_name ?? a.action?.code)}${a.action?.betsize != null && Number(a.action.betsize) > 0 && !/^CALL/i.test(String(a.action?.display_name)) ? ` ${Number(a.action.betsize)}` : ""}`,
}));
/** a served mix onto the yardstick's actions: by class, a wager to the same size or its nearest (lossy past tolerance) */
function mapMix(mix: Served[], ys: YAct[]): { m: number[]; lossy: string[]; unmapped: number } {
  const m = ys.map(() => 0);
  const lossy: string[] = [];
  let unmapped = 0;
  for (const w of mix) {
    if (w.f <= 0) continue;
    let j = -1;
    if (w.cls === "WAGER") {
      let best = Infinity;
      ys.forEach((y, i) => { if (y.cls === "WAGER" && y.bb != null && Math.abs(y.bb - w.bb!) < best) { best = Math.abs(y.bb - w.bb!); j = i; } });
      if (j < 0) j = ys.findIndex((y) => y.cls === "ALLIN");
      if (j >= 0 && (ys[j]!.bb == null || Math.abs(ys[j]!.bb! - w.bb!) > TOL(w.bb!)) && w.f >= 0.005) lossy.push(`${w.name} → ${ys[j]!.name} (${(100 * w.f).toFixed(1)}%)`);
    } else j = ys.findIndex((y) => y.cls === w.cls);
    if (j < 0) { unmapped += w.f; continue; }
    m[j]! += w.f;
  }
  const tot = m.reduce((a, x) => a + x, 0);
  return { m: tot > 0 ? m.map((x) => x / tot) : m, lossy, unmapped };
}
/** the yardstick's own regret at the node: the actor's range at the node, range-weighted best EV − the mix's EV */
function nodeRegret(node: any): number {
  const actor = node.action_solutions[0]?.action?.position;
  const pi = (node.players_info as any[] | undefined)?.find((p) => p.player?.position === actor);
  const w: number[] = pi?.range ?? [];
  let num = 0, den = 0;
  for (let c = 0; c < w.length; c++) {
    const wc = Number(w[c] ?? 0);
    if (wc <= 0) continue;
    let reach = 0, ev = 0, best = -Infinity;
    for (const a of node.action_solutions as any[]) { const s = Number(a.strategy?.[c] ?? 0), e = Number(a.evs?.[c] ?? 0); reach += s; ev += s * e; if (e > best) best = e; }
    if (reach <= 1e-9) continue;
    num += wc * (best - ev / reach); den += wc;
  }
  return den ? num / den : NaN;
}
const fmtMix = (ys: YAct[], m: number[]): string => ys.map((y, i) => (m[i]! >= 0.0005 ? `${y.name} ${(100 * m[i]!).toFixed(1)}` : null)).filter(Boolean).join(" / ");

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────
const spots = (ONLY ?? SPOTS).map((x) => spotOf(x.id, x.idx));

/**
 * REREAD (one poll per spot): the first run named the yardstick's wagers without their sizes. Its solves are found in
 * the request ledger (origin huMenuStudy: per spot the first poll is the fixed tree's node, the second the yardstick's)
 * and the yardstick's hero node is read once more — every action with its size, strategy and EV kept in the results.
 * The fixed tree's mix is the one stored (its wagers sized from the fixed menu, ascending as GTO Wizard lists them).
 */
if (PHASE === ("reread" as string)) {
  const prev: any = JSON.parse(readFileSync(`${OUT}.json`, "utf-8"));
  const ledger = new Database("C:/Users/Brady/poker-data/poker.sqlite", { readonly: true });
  const polls = (ledger.query("select q from gtow_requests where o = 'huMenuStudy' and k = 'poll' and st = 200 order by ts").all() as { q: string }[]).map((r) => String(r.q));
  for (const s of spots) {
    const rec = prev.results.find((r: any) => r.key === s.key && r.ok);
    if (!rec) continue;
    const field = s.street === "FLOP" ? "flop_actions" : s.street === "TURN" ? "turn_actions" : "river_actions";
    const mine = polls.filter((q) => new URLSearchParams(q.split("?")[1]).get("board") === s.board && new URLSearchParams(q.split("?")[1]).get(field) === s.codes);
    if (mine.length < 2) { log(`${s.key}: ${mine.length} polls in the ledger — skipped`); continue; }
    const ySol = new URLSearchParams(mine[1]!.split("?")[1]).get("custom_solution_id")!;
    await guardBatch(`${s.key} yardstick reread (${ySol.slice(0, 8)})`);
    const yNode = await readNode(ySol, s.board, s.street, s.codes, 2000);
    const ys = yActs(yNode, s.combo);
    const yTot = ys.reduce((a, y) => a + y.s, 0);
    const yMix = ys.map((y) => y.s / yTot);
    const evOf = (m: number[]) => m.reduce((a, x, i) => a + x * ys[i]!.ev, 0);
    const evY = evOf(yMix);
    // the fixed mix as stored, its wagers sized: bets 33% / 75% of the street pot, the raise = the yardstick's 60% one
    const fixedRaw = String(rec.fixedServed).split(" / ").map((x) => { const m = /^(\S+)\s+([\d.]+)$/.exec(x)!; return { cls: m[1]!, f: Number(m[2]) / 100 }; });
    const added = new Set((rec.yard.added as string[]).map((x) => Number(x.replace("bb", ""))));
    const fixedSizes = s.level === 0 ? [0.33 * s.input.pot, 0.75 * s.input.pot]
      : ys.filter((y) => y.cls === "WAGER" && y.bb != null && ![...added].some((a) => Math.abs(a - y.bb!) < 0.005)).map((y) => y.bb!);
    let wi = 0;
    const fixedMix: Served[] = fixedRaw.map((x) => {
      const cls = x.cls === "BET" || x.cls === "RAISE" ? "WAGER" : x.cls;
      const bb = cls === "WAGER" ? fixedSizes[wi++] ?? null : null;
      return { cls, bb, f: x.f, name: `${x.cls}${bb != null ? ` ${Math.round(bb * 100) / 100}` : ""}` };
    });
    const score = (name: string, mix: Served[]) => {
      const mm = mapMix(mix, ys);
      const ev = evOf(mm.m);
      return { name, mix: fmtMix(ys, mm.m), ev, loss: evY - ev, lossPct: (100 * (evY - ev)) / s.potNode, lossy: mm.lossy, unmapped: mm.unmapped };
    };
    rec.yard.mix = fmtMix(ys, yMix);
    rec.yard.actions = ys.map((y, i) => ({ name: y.name, cls: y.cls, bb: y.bb, s: yMix[i], ev: y.ev }));
    rec.yard.ev = evY;
    rec.yard.best = Math.max(...ys.map((y) => y.ev));
    rec.yard.regretCombo = rec.yard.best - evY;
    rec.yard.regretRange = nodeRegret(yNode);
    rec.yard.solId = ySol;
    const was = { old: rec.old.loss, neu: rec.neu.loss, fixed: rec.fixed.loss };
    rec.old = score("old", s.old); rec.neu = score("new", s.neu); rec.fixed = score("fixed", fixedMix);
    rec.fixedSized = fixedMix.map((w) => `${w.name} ${(100 * w.f).toFixed(1)}`).join(" / ");
    rec.reread = { requests: 1, lossBefore: was };
    log(`${s.key}: yard ${rec.yard.mix} · old ${rec.old.loss.toFixed(4)} (was ${was.old.toFixed(4)}) new ${rec.neu.loss.toFixed(4)} (was ${was.neu.toFixed(4)}) fixed ${rec.fixed.loss.toFixed(4)} (was ${was.fixed.toFixed(4)})`);
  }
  prev.spentTotal = (prev.spentTotal ?? prev.spent) + spent;
  prev.reread = spent;
  writeFileSync(`${OUT}.json`, JSON.stringify(prev, null, 1));
  log(`reread done: ${spent} requests (all runs ${prev.spentTotal})`);
  process.exit(0);
}
const prior: any = existsSync(`${OUT}.json`) && PHASE === "run" && argv.includes("--resume") ? JSON.parse(readFileSync(`${OUT}.json`, "utf-8")) : null;
const results: any[] = prior?.results ?? [];
/** requests of the earlier runs this one resumes (the report's total) */
const priorSpent: number = prior?.spentTotal ?? prior?.spent ?? 0;
const settle = (st: string) => (st === "FLOP" ? 7000 : st === "TURN" ? 5000 : 3000);
for (const s of spots) {
  const fixedBody = api.buildCustomTree(s.input);
  const fe = entryOf(fixedBody, s.street);
  log(`${s.key} ${s.street} ${s.board} hero ${s.heroPos} ${s.heroCards} (combo ${s.combo}) pot ${s.input.pot} → node ${s.potNode} [${s.codes || "root"}] level ${s.level}`);
  log(`   fixed: ${fe.map((p: any, i: number) => `${i === s.hero ? "HERO " : ""}${s.input[i ? "ipPos" : "oopPos"]} bet [${p.bet_sizes}] raise [${p.raise_sizes}]`).join(" · ")}`);
  log(`   old: ${s.old.map((w) => `${w.name} ${(100 * w.f).toFixed(1)}`).join(" / ")}`);
  log(`   new: ${s.neu.map((w) => `${w.name} ${(100 * w.f).toFixed(1)}`).join(" / ")}`);
  if (PHASE === "plan") { const y = yardstickOf(s, fixedBody, []); log(`   yardstick: ${entryOf(y.body, s.street).map((p: any) => `bet [${p.bet_sizes}] raise [${p.raise_sizes}]`).join(" · ")}${y.added.length ? ` (hero's served sizes added: ${y.added.join(", ")})` : ""}`); continue; }
  if (results.some((r) => r.key === s.key && r.ok)) { log("   done before (--resume)"); continue; }
  const r0 = spent;
  try {
    await guardBatch(`${s.key} fixed tree`);
    const fSol = await solveTree(fixedBody, s.board);
    const fNode = await readNode(fSol, s.board, s.street, s.codes, settle(s.street));
    const fActs = yActs(fNode, s.combo);
    const fixedMix: Served[] = fActs.map((a) => ({ cls: a.cls, bb: a.bb, f: a.s, name: a.name }));
    const raiseAmts = s.level ? fActs.filter((a) => a.cls === "WAGER" && a.bb != null).map((a) => a.bb!) : [];
    const fReq = spent - r0;
    await guardBatch(`${s.key} yardstick`);
    const y = yardstickOf(s, fixedBody, raiseAmts);
    log(`   yardstick: ${entryOf(y.body, s.street).map((p: any) => `bet [${p.bet_sizes}] raise [${p.raise_sizes}]`).join(" · ")}${y.added.length ? ` (hero's served sizes added: ${y.added.join(", ")})` : ""}`);
    const ySol = await solveTree(y.body, s.board);
    const yNode = await readNode(ySol, s.board, s.street, s.codes, settle(s.street));
    const ys = yActs(yNode, s.combo);
    const yMix = ys.map((a) => a.s);
    const yTot = yMix.reduce((a, x) => a + x, 0);
    if (yTot <= 1e-9) throw new Error("hero's combo has no strategy at the yardstick's node (blocked / absent)");
    const evOf = (m: number[]) => m.reduce((a, x, i) => a + x * ys[i]!.ev, 0);
    const evY = evOf(yMix.map((x) => x / yTot));
    const evBest = Math.max(...ys.map((a) => a.ev));
    const score = (name: string, mix: Served[]) => {
      const mm = mapMix(mix, ys);
      const ev = evOf(mm.m);
      return { name, mix: fmtMix(ys, mm.m), ev, loss: evY - ev, lossPct: (100 * (evY - ev)) / s.potNode, lossy: mm.lossy, unmapped: mm.unmapped };
    };
    const rec = {
      key: s.key, ok: true, street: s.street, board: s.board, hero: `${s.heroPos} ${s.heroCards}`, node: s.codes || "root", potNode: s.potNode,
      yard: { menu: entryOf(y.body, s.street).map((p: any) => ({ bet: p.bet_sizes, raise: p.raise_sizes })), added: y.added, mix: fmtMix(ys, yMix.map((x) => x / yTot)),
        evs: ys.map((a) => `${a.name} ${a.ev.toFixed(3)}`), ev: evY, best: evBest, regretCombo: evBest - evY, regretRange: nodeRegret(yNode) },
      old: score("old", s.old), neu: score("new", s.neu), fixed: score("fixed", fixedMix),
      fixedServed: fActs.map((a) => `${a.name} ${(100 * a.s).toFixed(1)}`).join(" / "),
      requests: { fixed: fReq, yardstick: spent - r0 - fReq },
    };
    results.push(rec);
    log(`   yard ${rec.yard.mix} · EV ${evY.toFixed(3)} · regret combo ${(evBest - evY).toFixed(4)} range ${rec.yard.regretRange.toFixed(4)}`);
    for (const x of [rec.old, rec.neu, rec.fixed]) log(`   ${x.name.padEnd(5)} ${x.mix} · loss ${x.loss.toFixed(4)}bb (${x.lossPct.toFixed(2)}% pot)${x.lossy.length ? ` · LOSSY ${x.lossy.join("; ")}` : ""}`);
    log(`   requests: fixed ${fReq}, yardstick ${spent - r0 - fReq} (run ${spent})`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    results.push({ key: s.key, ok: false, why, requests: spent - r0 });
    log(`   FAILED: ${why}`);
    if (stopped) break;
  }
  writeFileSync(`${OUT}.json`, JSON.stringify({ startedAt, spent, spentTotal: priorSpent + spent, stopped, results }, null, 1));
}
if (PHASE === "run") log(`done: ${spent} requests (all runs ${priorSpent + spent})${stopped ? `, stopped: ${stopped}` : ""}`);
process.exit(0);
