/**
 * STRESS-500 RUN (2026-10-05): every hero decision of every scenario, in hand order, through THIS checkout's fastSolve
 * with live GTO Wizard — then every node's ranges (views.ts) and a grade per decision — one JSON per hand.
 *
 *   powershell: . C:\Users\Brady\poker-wrapper\config\env.ps1; bun src/scripts/stress500/run.ts [--data DIR] [--only id,id]
 *               [--families a,b] [--limit N] [--hour-cap 1150] [--force]
 *
 * SAFE BY CONSTRUCTION (the hand-4587 session's notes; memory gtow-quota-unit-unknown, no-api-work-during-live-session):
 *   - PRIVATE DATA: poker.sqlite copied once (VACUUM INTO, read-only source) to <data>/root; a fresh solve cache there;
 *     hand facts in memory; nothing of the live archive is written. The charts and trust scores are the live API's
 *     (config/local.env → FACTORY_DATA_DIR), read in place.
 *   - SHARED LEDGER: every GTO Wizard request is logged to the LIVE ledger (GTOW_REQUESTS_PATH, origin "stress500"), so
 *     the live API's meters and wall detection see it — and so does this run's own gate.
 *   - THE GATE before every decision: a live poker session → exit 2 (resume later); a 429 since this run started → exit 3;
 *     either account's trailing hour at or past --hour-cap (default 1,150 of GTO Wizard's 2,250) → wait.
 * Resumable: a hand with a result file is skipped (--force re-runs).
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k: string): boolean => argv.includes(`--${k}`);
const DATA = (arg("data") ?? "C:/Users/Brady/poker-data-stress500").replace(/\\/g, "/");
const LIVE_DIR = "C:/Users/Brady/poker-data";
const WORK = join(DATA, "root");
const OUT = join(DATA, "hands");
const HOUR_CAP = Number(arg("hour-cap") ?? 500);
/** THE DAY CAP (2026-10-05): primary walled at 01:32Z with the DAILY throttle ("1275 / 86400 s", Retry-After 8.5 h)
 *  at 6,589 requests in its trailing 24 h (952 in the last hour: the hourly cap never fired). Every origin counts —
 *  live play included — so the run waits while the account's 24 h total is at or past this. */
const DAY_CAP = Number(arg("day-cap") ?? 3000);
/** --gap S: at least S seconds between the starts of two decisions (Brady 2026-10-05: "pace at like 1 per minute") */
const GAP_MS = Number(arg("gap") ?? 0) * 1000;
let lastDecisionAt = 0;
const ONLY = arg("only")?.split(",").filter(Boolean) ?? null;
const FAMS = arg("families")?.split(",").filter(Boolean) ?? null;
const LIMIT = Number(arg("limit") ?? 1e9);
const STRATEGY = "ign200-ring-6max-equilibrium";
const startedAt = Date.now();
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

// ── the guards ───────────────────────────────────────────────────────────────────────────────────────────────────
const liveDb = new Database(join(LIVE_DIR, "poker.sqlite"), { readonly: true });
const isLive = (): boolean => ((liveDb.query("select count(*) n from sessions where ended_at is null").get() as { n: number }).n ?? 0) > 0;
const trailingHour = (): Record<string, number> => {
  const rows = liveDb.query("select s, count(*) n from gtow_requests where ts > ? group by s").all(Date.now() - 3_600_000) as { s: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.s ?? "?", r.n]));
};
const trailingDay = (): Record<string, number> => {
  const rows = liveDb.query("select s, count(*) n from gtow_requests where ts > ? group by s").all(Date.now() - 86_400_000) as { s: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.s ?? "?", r.n]));
};
/** this run's own requests since `t` (its ledger origin) */
const ownSince = (t: number): number => (liveDb.query("select count(*) n from gtow_requests where ts >= ? and o = 'stress500'").get(t) as { n: number }).n ?? 0;
const wallsSinceStart = (): number =>
  (liveDb.query("select count(*) n from gtow_requests where ts > ? and st = 429").get(startedAt) as { n: number }).n ?? 0;
const log = (s: string): void => { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; console.log(line); try { require("node:fs").appendFileSync(join(DATA, "run.log"), line + "\n"); } catch { /* best effort */ } };
if (isLive()) { log("a poker session is LIVE — not starting (exit 2)"); process.exit(2); }

/** A GTO Wizard account without an access token (2026-10-05 00:30-01:16Z: primary had none for 45 minutes and the run
 *  recorded ~450 hands of instant refusals as results). The gate waits for one; a hand whose answers still say so is
 *  thrown away and played again. */
const NO_TOKEN = /no access token|: no token\b/i;
let tokenWaits = 0;
async function tokenOk(): Promise<boolean> {
  const { gtowSessions } = await import("../../services/gtowSessions");
  try { return !!((await gtowSessions.tokenFor("primary" as any)) ?? (await gtowSessions.tokenFor("primary" as any, true))); } catch { return false; }
}
async function gate(): Promise<void> {
  for (;;) {
    if (isLive()) { log("a poker session went LIVE — stopping (exit 2); resume with the same command when it ends"); process.exit(2); }
    const w = wallsSinceStart();
    if (w > 0) { log(`GTO Wizard answered 429 ${w}× since this run started — STOPPING to protect the accounts (exit 3)`); process.exit(3); }
    const h = trailingHour();
    const worst = Math.max(0, ...Object.values(h));
    if (worst >= HOUR_CAP) {
      log(`trailing hour ${JSON.stringify(h)} — at the cap (${HOUR_CAP}); waiting 60 s`);
      await Bun.sleep(60_000);
      continue;
    }
    const d = trailingDay();
    if (Math.max(0, ...Object.values(d)) >= DAY_CAP) {
      log(`trailing 24 h ${JSON.stringify(d)} — at the day cap (${DAY_CAP}, every origin counts); waiting 10 min`);
      await Bun.sleep(600_000);
      continue;
    }
    if (!(await tokenOk())) {
      if (++tokenWaits > 45) { log("GTO Wizard primary has had no access token for 45 minutes — exit 4 (the supervisor restarts later)"); process.exit(4); }
      log("GTO Wizard primary has no access token — waiting 60 s (no decision is answered without one)");
      await Bun.sleep(60_000);
      continue;
    }
    tokenWaits = 0;
    return;
  }
}

// ── the private data root ────────────────────────────────────────────────────────────────────────────────────────
if (!existsSync(join(WORK, "poker.sqlite"))) {
  const to = join(WORK, "poker.sqlite"), tmp = `${to}.copying`;
  rmSync(tmp, { force: true });
  const src = new Database(join(LIVE_DIR, "poker.sqlite"), { readonly: true });
  try { src.run(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { src.close(); }
  renameSync(tmp, to);
  log(`private copy of poker.sqlite made at ${to}`);
}
for (const f of ["gtow-accounts.json", "wrapper/profiles.json", "api/fx.json", "api/river_mes_config.json"]) {
  const from = join(LIVE_DIR, f);
  if (!existsSync(from)) continue;
  mkdirSync(dirname(join(WORK, f)), { recursive: true });
  copyFileSync(from, join(WORK, f));
}
const ENV_FILE = "C:/Users/Brady/poker-wrapper/config/local.env";
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
  }
}
Object.assign(process.env, {
  POKER_DATA_DIR: WORK, GTOW_CACHE_DB_PATH: join(WORK, "gtow-cache.sqlite"), HAND_FACTS_DB_PATH: ":memory:",
  ANSWERS_DB_PATH: ":memory:", GTOW_REQUEST_ORIGIN: "stress500", GTOW_REQUESTS_PATH: join(LIVE_DIR, "poker.sqlite"), RIVER_MES: "off",
  // THE TIME BOXES WIDENED (the batch has no warm-up: live, the gap-gate tree and the pool lock are pre-built when the
  // raise or the limp lands, here every tree starts cold at hero's turn and a 12 s box would grade the fallback instead
  // of the path). Latency is still measured per decision and flagged past the 15 s clock.
  GAP_GATE_AI_MS: process.env.STRESS_BOX_MS ?? "45000", POOL_LOCK_MS: process.env.STRESS_BOX_MS ?? "45000",
});
delete process.env.GTOW_BLOCK;
delete process.env.GTOW_CACHE;
delete process.env.POSTFLOP_DRY_RUN;
if (process.env.HRC6MAX_DB) { log(`HRC6MAX_DB is set (${process.env.HRC6MAX_DB}) — must read the live bake; unset it`); process.exit(64); }
if (!process.env.FACTORY_DATA_DIR) { log(`FACTORY_DATA_DIR is not set — load ${ENV_FILE} (charts would read a stale copy)`); process.exit(64); }

// the modules bind their stores on load: imported only now
const { fastSolve, forgetPreflopPin, forgetPostflopPin } = await import("../../services/fastSolve");
const { forgetCheckpoints } = await import("../../services/aiChain");
const { normalizeHand } = await import("../../feed/normalizeHand/normalizeHand");
const { truncateAt, withStartStacks, roundContributions } = await import("../../utils/archivedHand/archivedHand");
const { preflopPinFor, preflopPinKey } = await import("../../services/preflopPin");
const { buildPreflopTokens } = await import("../../feed/buildSolutionUrl/buildSolutionUrl");
const { reconstructFlopRanges } = await import("../../utils/reconstructFlopRanges/reconstructFlopRanges");
const { nodeGetter } = await import("../../services/hrc6max");
const { lineOf, walkArrivalRanges, fetchNode } = await import("../../services/gtowAiPreflop");
const { solveStore } = await import("../../services/solveStore");
const { handHistoryText } = await import("./hhText");
const V = await import("./views");
const { factoryFile } = await import("../../services/repoPaths");
const commit = (() => { try { return require("node:child_process").execSync("git rev-parse --short HEAD", { cwd: import.meta.dir }).toString().trim(); } catch { return "?"; } })();
log(`stress-500 on ${commit} · charts ${factoryFile("hrc6max-preflop.sqlite")} · data ${WORK} · caps ${HOUR_CAP}/h and ${DAY_CAP}/24 h per account (every origin)`);

// ── the scenarios ────────────────────────────────────────────────────────────────────────────────────────────────
const set = JSON.parse(readFileSync(join(DATA, "scenarios.json"), "utf8")) as { scenarios: any[] };
let todo = set.scenarios.filter((s) => (!ONLY || ONLY.includes(s.id)) && (!FAMS || FAMS.includes(s.family)));
// round-robin over the families, so a partial run already covers every family
{
  const byFam = new Map<string, any[]>();
  for (const s of todo) { const l = byFam.get(s.family) ?? []; l.push(s); byFam.set(s.family, l); }
  const lists = [...byFam.values()];
  const rr: any[] = [];
  for (let k = 0; rr.length < todo.length; k++) for (const l of lists) if (l[k]) rr.push(l[k]);
  todo = rr;
}
todo = todo.slice(0, LIMIT);

// ── grading one decision (the hand-4587 brief §2 + the stress sweep's legality) ─────────────────────────────────────
const KNOWN_WARNINGS: [RegExp, string][] = [
  [/POOL-LOCKED LIMPER/i, "pool-locked limper"], [/POOL LIMP LOCK FAILED/i, "pool lock failed"], [/POOL LIMP RANGE/i, "pool limp floor"],
  [/3-way flop|3-player tree/i, "3-way tree"], [/N-WAY, DEAD-MONEY COLLAPSE|DEAD-MONEY COLLAPSE/i, "dead-money collapse"],
  [/collapsed to three|N-WAY APPROXIMATION|-WAY APPROXIMATION/i, "collapse"], [/RE-ROOTED/i, "re-rooted"], [/HEADS-UP: every other villain has folded/i, "HU after folds"],
  [/NOT NARROWED/i, "not narrowed"], [/ALL-IN LEFT OUT/i, "all-in left out"], [/ALL-IN PREFLOP/i, "preflop all-in left out"],
  [/GAP GATE/i, "gap gate"], [/LINE NOT HELD|LINE FITTED/i, "line fitted"], [/GTO Wizard AI preflop/i, "AI preflop"],
  [/UNTRAINED CHART NODE/i, "untrained chart node"], [/OFF THE CHART/i, "off the chart"], [/LAST RESORT/i, "LAST RESORT"],
  [/snapped/i, "size snapped"],
];
function grade(r: any, cut: any, heroPos: string): { verdict: "ok" | "approx" | "refused" | "bad"; flags: string[]; kinds: string[] } {
  const flags: string[] = [];
  const kinds = KNOWN_WARNINGS.filter(([re]) => re.test(String(r.warning ?? ""))).map(([, k]) => k);
  if (!r.ok) {
    const why = String(r.reason ?? "");
    if (/capture|internally inconsistent/i.test(why) || r.kind === "capture-fault") flags.push("capture-fault");
    else if (/preflop node .* terminal|size past|PREFLOP PIN|no preflop|arrival/i.test(why)) flags.push("arrival-refusal");
    else if (/timed out|timeout|no answer inside/i.test(why)) flags.push("timeout");
    else if (/walked line ends on villain/i.test(why)) flags.push("not-hero-turn");
    else flags.push("refused");
    return { verdict: "refused", flags, kinds };
  }
  if (r.pos && heroPos && String(r.pos).toUpperCase() !== heroPos.toUpperCase() && !/^(OOP|IP|OOP\+1)$/i.test(String(r.pos))) flags.push(`wrong-seat:${r.pos}`);
  const acts: { action: string; frequency: number }[] = r.actions ?? [];
  if (!acts.length) flags.push("empty-mix");
  else if (acts.every((a) => !(a.frequency > 0))) flags.push("all-zero-mix");
  const sum = acts.reduce((t, a) => t + (a.frequency > 0 ? a.frequency : 0), 0);
  if (acts.length && Math.abs(sum - 100) > 1.5 && Math.abs(sum - 1) > 0.02) flags.push(`sum-${Math.round(sum * 10) / 10}`);
  if (!r.decision && acts.length) flags.push("no-pick");
  const toCall = Number(cut.currentNode?.toCall ?? 0);
  const names = acts.map((a) => String(a.action).toUpperCase());
  if (toCall > 0.01) { if (names.some((n) => /^CHECK/.test(n))) flags.push("check-facing-bet"); }
  // (no "no-fold-facing-bet": a chart cell lists only the actions the hand takes, so JJ facing an open has no Fold row
  // because it folds 0% — that is not a fault; the export's grade.ts never had the rule)
  else if (names.some((n) => /^FOLD/.test(n) && (acts.find((a) => String(a.action).toUpperCase() === n)?.frequency ?? 0) > 0.5)) flags.push("fold-when-free");
  if (/last-resort/i.test(JSON.stringify(r.path ?? {})) || kinds.includes("LAST RESORT")) flags.push("last-resort");
  const v = r.path?.verdict;
  if (v === "failed" || v === "fault") flags.push(`path-${v}`);
  const failed = Object.values(r.path?.checks ?? {}).flat().filter((c: any) => c?.status === "fail").map((c: any) => `check#${c.id}`);
  for (const f of new Set(failed)) flags.push(f);
  if (r.notInRange) flags.push("not-in-range");
  const bad = flags.some((f) => /^(wrong-seat|empty-mix|all-zero-mix|sum-|check-facing-bet|last-resort|path-fault)/.test(f));
  return { verdict: bad ? "bad" : (r.approx || kinds.some((k) => !["size snapped", "AI preflop"].includes(k)) || failed.length) ? "approx" : "ok", flags, kinds };
}

/** the mis-press check (the hand-4587 session): a tree all-in below hero's chips behind while a deeper villain is not in
 *  the tree. Since 2026-10-07 (services/allInPress) the answer itself carries a `press` for such an all-in and the wrapper
 *  presses it as a raise to the tree's amount — this detector stays as the CROSS-CHECK of that field (oldVsPress below).
 *  The tree's all-in is read in TABLE terms: a dead-money tree preloads hero's earlier chips on the street into its pot,
 *  so its ALLIN label counts from there (brief_I-004 decision 13: "ALLIN 82.5" + hero's 15 = his whole 97.5 — the
 *  detector used to flag it). */
function misPress(r: any, cut: any, trace: any): string | null {
  const all = (r.actions ?? []).find((a: any) => /^ALL-?IN/i.test(String(a.action)));
  if (!all || !trace) return null;
  const m = /([\d.]+)/.exec(String(all.action));
  const label = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(label)) return null;
  const heroSeat = cut.heroSeatId;
  const heroNode = [...(trace.nodes ?? [])].reverse().find((n: any) => n.heroNode);
  const inTreeChips = Number(heroNode?.invested?.[heroNode?.actor] ?? 0) || 0;
  const treeAllIn = Math.round((label - inTreeChips + Number(cut.committed?.[heroSeat] ?? 0)) * 100) / 100;
  const heroBehind = Number(cut.stacks?.[heroSeat] ?? NaN) + Number(cut.committed?.[heroSeat] ?? 0);
  const inTree = new Set<string>([trace.spec?.oopPos, trace.spec?.midPos, trace.spec?.ipPos].filter(Boolean).map((x: string) => x.toUpperCase()));
  const outside = Object.entries(cut.positions ?? {}).filter(([seat, pos]) => !inTree.has(String(pos).toUpperCase()) && Number(seat) !== heroSeat
    && (cut.liveSeats ?? []).includes(Number(seat)) && !cut.actions.some((a: any) => a.seatId === Number(seat) && a.type === "fold"));
  const deeper = outside.some(([seat]) => Number(cut.stacks?.[Number(seat)] ?? 0) + Number(cut.committed?.[Number(seat)] ?? 0) > treeAllIn + 0.5);
  return Number.isFinite(heroBehind) && treeAllIn < heroBehind - 0.5 && deeper ? `tree ALL-IN ${treeAllIn} < hero's ${Math.round(heroBehind * 100) / 100} behind, a deeper villain outside the tree` : null;
}

// ── one hand ─────────────────────────────────────────────────────────────────────────────────────────────────────
let done = 0, decisionsDone = 0;
const tally = { ok: 0, approx: 0, refused: 0, bad: 0 };
for (const sc of todo) {
  const file = join(OUT, `${sc.id}.json`);
  if (existsSync(file) && !flag("force")) continue;
  const hand = normalizeHand(sc.raw).hand;
  const heroPos = String(hand.positions[hand.heroSeatId] ?? "");
  const key = preflopPinKey(hand) ?? hand.clientHandId ?? sc.id;
  let decisions: any[] = [];
  let t0h = Date.now();
  let outage = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    decisions = []; t0h = Date.now(); outage = false;
    for (let i = 0; i < hand.actions.length; i++) {
      const a = hand.actions[i]!;
      if (!a.hero || /^post/.test(a.type)) continue;
      if (GAP_MS > 0) { const wait = lastDecisionAt + GAP_MS - Date.now(); if (wait > 0) await Bun.sleep(wait); }
      await gate();
      lastDecisionAt = Date.now();
      const cut = withStartStacks(truncateAt(hand, i));
      // UNKNOWN DEALT STACKS (brief_I): the cut keeps the stacks behind at this point, the answer is not told the dealt ones
      if ((sc.raw as any)?.dropStartStacks) delete (cut as any).startStacks;
      const h = { ...cut, currentNode: { ...cut.currentNode, toActIsHero: true } };
      const t0 = Date.now();
      let r: any;
      try { r = await fastSolve(h, heroPos, { heroPos, strategyId: STRATEGY, origin: "stress" } as any); }
      catch (e) { r = { ok: false, reason: `threw: ${e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : e}` }; }
      // an answer GTO Wizard could not be asked for is not a result: the hand is played again (NO_TOKEN)
      if (NO_TOKEN.test(`${r?.reason ?? ""} ${r?.warning ?? ""} ${JSON.stringify(r?.path?.reasons ?? [])}`)) { outage = true; break; }
      const ms = Date.now() - t0;
      const reqs = ownSince(t0);
      const g = grade(r, h, heroPos);
      let trace: any = null;
      if (r.solveId) { try { trace = solveStore.get(Number(r.solveId))?.trace ?? null; } catch { trace = null; } }
      // THE SHORT ALL-IN (services/allInPress, 2026-10-07): an all-in the answer sized to its tree is no longer a latent
      // mis-press — `misPress` keeps only the ones with no press; the old detector must agree with the press field
      const oldMp = r.ok && a.street !== "preflop" ? misPress(r, h, trace) : null;
      const press = r.ok && Array.isArray(r.press) && r.press.length ? r.press : null;
      const mp = oldMp && !press ? oldMp : null;
      // agree = both fire or neither; a press the old detector misses, or a flag with no press, is a disagreement
      // (the press may legitimately be absent when the table's smallest raise is hero's whole stack — said in the text)
      const pressCheck = !!oldMp === !!press ? null : press ? `press without the old flag (${press[0].action} → ${press[0].verb} to ${press[0].amount})` : `old flag without a press: ${oldMp}`;
      if (pressCheck) log(`${sc.id} #${i}: SHORT ALL-IN CROSS-CHECK DISAGREES — ${pressCheck}`);
      if (mp) g.flags.push("mis-press");
      if (press) g.flags.push("allin-sized");
      if (pressCheck) g.flags.push("press-disagree");
      if (ms > 15_000) g.flags.push(`slow-${Math.round(ms / 1000)}s`);
      decisions.push({
        index: i, street: a.street, took: { type: a.type, amount: a.amount ?? null }, toCall: h.currentNode.toCall, ms, reqs,
        ok: !!r.ok, source: r.source ?? null, tier: r.tier ?? null, gametype: r.gametype ?? null, line: r.line ?? null, pos: r.pos ?? null,
        heroClass: r.heroClass ?? null, actions: r.actions ?? [], pick: r.decision?.action ?? null,
        // the answer's own draw (pickWeightedAction): the 0-100 roll and the picked action's band — the SCRIPT never rolls
        roll: r.decision?.roll ?? null, band: r.decision?.band ?? null, warning: r.warning ?? null,
        reason: r.ok ? null : String(r.reason ?? ""), kind: r.kind ?? null, approx: !!r.approx,
        path: r.path ? { verdict: r.path.verdict ?? null, reasons: r.path.reasons ?? [], requests: r.path.requests ?? null, checks: r.path.checks ?? null } : null,
        solveId: r.solveId ?? null, grade: g.verdict, flags: g.flags, kinds: g.kinds, misPress: mp,
        press, misPressOld: oldMp, pressCheck,
      });
    }
    if (!outage) break;
    log(`${sc.id}: an answer had no GTO Wizard access token — the hand is thrown away and played again in 60 s`);
    try { forgetPreflopPin(key); forgetPostflopPin(key); forgetCheckpoints(key); } catch { /* best effort */ }
    await Bun.sleep(60_000);
  }
  if (outage) { log(`${sc.id}: still no GTO Wizard access token after 6 tries — exit 4 (the supervisor restarts later)`); process.exit(4); }
  for (const d of decisions) { tally[d.grade as keyof typeof tally]++; decisionsDone++; }

  // ── the views: preflop from the pin, postflop from the traces ──
  const views: Record<number, any> = {};
  let preflopNote: string | null = null;
  try {
    const firstPost = hand.actions.findIndex((x) => x.street !== "preflop");
    const upto = firstPost >= 0 ? firstPost : hand.actions.length;
    const cut = truncateAt(hand, upto);
    const t: any = { ...cut, street: "preflop", board: [], committed: Object.fromEntries((roundContributions as any)(hand, upto).get("preflop") ?? []), currentNode: { ...cut.currentNode, street: "preflop", pot: 0 } };
    const pin: any = preflopPinFor(t);
    const seats = Object.values(hand.positions).map(String);
    let pviews: any[] = [];
    if (!pin) preflopNote = "no preflop pin: no preflop answer was given for this hand";
    else if (pin.piece === "chart6max") {
      const tokens = buildPreflopTokens(t, heroPos);
      const steps: any[] = [];
      const get = nodeGetter(pin.chartId);
      const w = await reconstructFlopRanges(tokens, async (ln: string) => { const n = await get(ln); return n && n !== "unreachable" ? (n as any) : null; },
        { heroPos, partial: true, borrowCaller: true, onStep: (s: any) => steps.push(s) } as any);
      pviews = V.chartStepsToViews(steps, seats, pin.chartId);
      preflopNote = `chart ${pin.chartId}${(w as any).ok ? "" : ` — the walk stopped: ${(w as any).reason}`}`;
    } else {
      const { tokens } = lineOf(t, pin.shape);
      const steps: any[] = [];
      const apiToTable: Record<string, string> = {};
      for (const [tablePos, api] of Object.entries(pin.shape.apiOf ?? {})) apiToTable[String(api)] = tablePos;
      const w = await walkArrivalRanges(pin.shape, tokens, (ln: string) => fetchNode(pin.solId, ln), 6 as any, (s: any) => steps.push(s));
      pviews = V.aiStepsToViews(steps, apiToTable, pin.shape.positions, pin.id + (pin.poolLocks?.length ? ` · pool-locked ${pin.poolLocks.map((p: any) => `${p.pos}:${p.key}`).join(", ")}` : ""));
      preflopNote = `GTO Wizard AI tree ${pin.id}${pin.poolLocks?.length ? ` (limp locked: ${pin.poolLocks.map((p: any) => `${p.pos} at ${p.key}`).join(", ")})` : ""}${(w as any).ok ? "" : ` — the walk stopped: ${(w as any).reason}`}`;
    }
    // preflop table actions (posts left out) ↔ the walk's steps, in order, by seat
    let k = 0;
    for (let i = 0; i < hand.actions.length && i < upto; i++) {
      const a = hand.actions[i]!;
      if (/^post/.test(a.type)) continue;
      const pos = String(hand.positions[a.seatId] ?? "");
      let j = k;
      while (j < pviews.length && pviews[j].actor !== pos) j++;
      if (j < pviews.length) { views[i] = pviews[j]; k = j + 1; }
    }
  } catch (e) { preflopNote = `preflop views failed: ${e instanceof Error ? e.message : e}`; }

  // postflop: per street, the trace whose walk covers the most nodes of that street (the latest on a tie)
  const plans: any[] = [];
  try {
    // this attempt's solves only (a hand played again keeps the earlier attempts' rows in the store)
    const rows = solveStore.forHand(hand.clientHandId!).filter((row: any) => Number(row.ts) >= t0h);
    const traces = rows.map((row: any) => ({ row, trace: solveStore.get(row.id)?.trace })).filter((x: any) => x.trace);
    for (const x of traces) plans.push({ solveId: x.row.id, decisionKey: x.row.decision_key, street: x.row.street, planTag: x.trace.spec?.planTag ?? null, ok: !!x.row.ok, why: x.row.why ?? null });
    Object.assign(views, V.postflopViews(hand.actions as any, hand.positions as any, traces.map((x: any) => ({ id: x.row.id, trace: x.trace }))));
  } catch (e) { plans.push({ error: `postflop views failed: ${e instanceof Error ? e.message : e}` }); }

  const result = {
    id: sc.id, family: sc.family, title: sc.title, tags: sc.tags, hero: heroPos, source: sc.source ?? null, commit,
    startedAt: new Date(t0h).toISOString(), ranAt: new Date().toISOString(), ms: Date.now() - t0h,
    hh: handHistoryText(hand, sc), hand: { positions: hand.positions, startStacks: (hand as any).startStacks ?? null, heroSeatId: hand.heroSeatId, heroCards: hand.heroCards, board: hand.board, actions: hand.actions, postIns: (hand as any).postIns ?? null },
    decisions, views, preflopNote, plans,
  };
  writeFileSync(file + ".tmp", JSON.stringify(result));
  renameSync(file + ".tmp", file);
  done++;
  const g = decisions.map((d) => d.grade[0]).join("");
  log(`${String(done).padStart(3)}/${todo.length} ${sc.id.padEnd(24)} ${decisions.length} dec [${g}] ${Math.round((Date.now() - t0h) / 1000)}s · ${decisions.reduce((t, d) => t + d.reqs, 0)} req · hour ${JSON.stringify(trailingHour())}`);
  try { forgetPreflopPin(key); forgetPostflopPin(key); forgetCheckpoints(key); } catch { /* best effort */ }
}
log(`done: ${done} hands, ${decisionsDone} decisions · ${JSON.stringify(tally)}`);
process.exit(0);
